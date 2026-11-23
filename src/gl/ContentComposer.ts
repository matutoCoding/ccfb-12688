// 内容合成器：把时间轴上多个 Clip 合成为方形内容纹理（风扇极坐标成像的输入）
// 调色（3D LUT + 增益/亮度/对比度/饱和度）在同一 GL 管线内完成
//
// 实现约束：GLSL ES 3.00 中 sampler 数组只能用常量索引，无法用循环变量动态取层，
// 因此采用"逐层单纹理 + 乒乓混合"，每层两个 pass：
//   pass A 调色（含 3D LUT）到 workFbo；pass B 按矩形/旋转/透明度 over 混合进 accumFbo。
import { createLutTexture3D, createQuadProgram, createQuadVao, uniformLocations, type FloatFbo } from './glutil';
import { createFloatFbo } from './glutil';
import type { Clip, GradePreset, LUTFile, Project } from '../core/types';

const GRADE_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler3D;
in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_src;
uniform sampler3D u_lut;
uniform int u_hasLut;
uniform float u_lutScale;
uniform float u_lutOffset;
uniform vec3 u_gain;
uniform float u_saturation;
uniform float u_brightness;
uniform float u_contrast;
uniform float u_opacity;

vec3 applyLut(vec3 c) {
  vec3 coord = clamp(c, 0.0, 1.0) * u_lutScale + u_lutOffset;
  return texture(u_lut, coord).rgb;
}

void main() {
  vec4 src = texture(u_src, v_uv);
  vec3 c = src.rgb;
  c = (c - 0.5) * u_contrast + 0.5;
  c += u_brightness;
  c *= u_gain;
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, u_saturation);
  if (u_hasLut == 1) c = applyLut(c);
  outColor = vec4(clamp(c, 0.0, 1.0), src.a * u_opacity);
}`;

const OVER_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_accum;
uniform sampler2D u_layer;
uniform vec4 u_rect;       // xy = 中心 uv, zw = 半宽高
uniform float u_rot;        // 弧度
uniform float u_opacity;

vec2 rotate2(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c) * p;
}

void main() {
  vec4 base = texture(u_accum, v_uv);
  vec2 local = rotate2(v_uv - u_rect.xy, -u_rot);
  vec2 luv = local / u_rect.zw * 0.5 + 0.5;
  if (luv.x >= 0.0 && luv.x <= 1.0 && luv.y >= 0.0 && luv.y <= 1.0) {
    vec4 src = texture(u_layer, luv);
    float a = clamp(src.a * u_opacity, 0.0, 1.0);
    outColor = vec4(mix(base.rgb, src.rgb, a), 1.0);
  } else {
    outColor = base;
  }
}`;

const BG_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform vec3 u_bg;
void main() { outColor = vec4(u_bg, 1.0); }`;

const COPY_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_s;
void main() { outColor = texture(u_s, v_uv); }`;

export interface LayerSource {
  texture: WebGLTexture;
  grade: GradePreset | null;
  lut: LUTFile | null;
}

export interface LayerRect {
  x: number;
  y: number;
  scale: number;
  rotationDeg: number;
  opacity: number;
}

const MAX_LAYERS = 8;

export class ContentComposer {
  private gl: WebGL2RenderingContext;
  private gradeProg: WebGLProgram;
  private overProg: WebGLProgram;
  private bgProg: WebGLProgram;
  private copyProg: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private gradeU: Record<string, WebGLUniformLocation | null>;
  private overU: Record<string, WebGLUniformLocation | null>;
  private bgU: Record<string, WebGLUniformLocation | null>;
  private copyU: Record<string, WebGLUniformLocation | null>;
  private accumA: FloatFbo;
  private accumB: FloatFbo;
  private workFbo: WebGLFramebuffer;
  private lutTexCache = new Map<string, WebGLTexture>();
  private dummyLut: WebGLTexture;
  readonly size: number;

  constructor(gl: WebGL2RenderingContext, size: number) {
    this.gl = gl;
    this.size = size;
    this.gradeProg = createQuadProgram(gl, GRADE_FS);
    this.overProg = createQuadProgram(gl, OVER_FS);
    this.bgProg = createQuadProgram(gl, BG_FS);
    this.copyProg = createQuadProgram(gl, COPY_FS);
    this.vao = createQuadVao(gl);
    this.gradeU = uniformLocations(gl, this.gradeProg, [
      'u_src', 'u_lut', 'u_hasLut', 'u_lutScale', 'u_lutOffset', 'u_gain',
      'u_saturation', 'u_brightness', 'u_contrast', 'u_opacity',
    ]);
    this.overU = uniformLocations(gl, this.overProg, ['u_accum', 'u_layer', 'u_rect', 'u_rot', 'u_opacity']);
    this.bgU = uniformLocations(gl, this.bgProg, ['u_bg']);
    this.copyU = uniformLocations(gl, this.copyProg, ['u_s']);

    this.accumA = createFloatFbo(gl, size);
    this.accumB = createFloatFbo(gl, size);
    this.workFbo = gl.createFramebuffer()!;
    this.dummyLut = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this.dummyLut);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, 1, 1, 1, 0, gl.RGB, gl.FLOAT, new Float32Array([1, 1, 1]));
  }

  private lutTexture(lut: LUTFile): WebGLTexture {
    let tex = this.lutTexCache.get(lut.id);
    if (!tex) {
      tex = createLutTexture3D(this.gl, lut.gridSize, lut.data);
      this.lutTexCache.set(lut.id, tex);
    }
    return tex;
  }

  private bindFboTarget(tex: WebGLTexture): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, this.size, this.size);
  }

  /** 合成一帧内容；targetTex 为 null 时渲染到屏幕 */
  render(targetTex: WebGLTexture | null, sources: LayerSource[], rects: LayerRect[], bgColor: [number, number, number]): void {
    const gl = this.gl;
    const count = Math.min(sources.length, MAX_LAYERS);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    // 1) 背景写入 accumA
    this.bindFboTarget(this.accumA.tex);
    gl.useProgram(this.bgProg);
    gl.uniform3f(this.bgU.u_bg, bgColor[0], bgColor[1], bgColor[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    let src = this.accumA;
    let dst = this.accumB;

    for (let i = 0; i < count; i++) {
      const layer = sources[i];
      const rect = rects[i];

      // pass A：调色到 work（用 accumB/accumA 之外的临时纹理——这里用 dst 当 work 安全，因为下一步会覆盖）
      this.bindFboTarget(dst.tex);
      gl.useProgram(this.gradeProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, layer.texture);
      gl.uniform1i(this.gradeU.u_src, 0);
      const g = layer.grade;
      const hasLut = g && layer.lut ? 1 : 0;
      if (hasLut && layer.lut) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_3D, this.lutTexture(layer.lut));
        const n = layer.lut.gridSize;
        gl.uniform1f(this.gradeU.u_lutScale, (n - 1) / n);
        gl.uniform1f(this.gradeU.u_lutOffset, 0.5 / n);
      } else {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_3D, this.dummyLut);
        gl.uniform1f(this.gradeU.u_lutScale, 1);
        gl.uniform1f(this.gradeU.u_lutOffset, 0);
      }
      gl.uniform1i(this.gradeU.u_lut, 1);
      gl.uniform1i(this.gradeU.u_hasLut, hasLut);
      gl.uniform3f(this.gradeU.u_gain, g?.gain[0] ?? 1, g?.gain[1] ?? 1, g?.gain[2] ?? 1);
      gl.uniform1f(this.gradeU.u_saturation, g?.saturation ?? 1);
      gl.uniform1f(this.gradeU.u_brightness, g?.brightness ?? 0);
      gl.uniform1f(this.gradeU.u_contrast, g?.contrast ?? 1);
      gl.uniform1f(this.gradeU.u_opacity, rect.opacity);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // pass B：over 混合 dst = over(src 累积, dst 调色层)
      // 需要第三个缓冲：用 workFbo 重新挂载到 src 之外——改为就地两缓冲技巧：
      // 先把 over 结果画回 src 会采样冲突，因此引入 accumA/B 交替 + work 纹理。
      this.overBlit(src, dst, rect);
      const tmp = src;
      src = dst;
      dst = tmp;
    }

    // 2) 输出到目标
    if (targetTex) {
      this.bindFboTarget(targetTex);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    }
    gl.useProgram(this.copyProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(this.copyU.u_s, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * over 混合：out = accum over layer。
   * 因 GL 采样与渲染不能挂同一纹理，使用第三个 work 纹理做中转。
   */
  private overWork: FloatFbo | null = null;
  private overBlit(accum: FloatFbo, graded: FloatFbo, rect: LayerRect): void {
    const gl = this.gl;
    if (!this.overWork) this.overWork = createFloatFbo(gl, this.size);
    this.bindFboTarget(this.overWork.tex);
    gl.useProgram(this.overProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, accum.tex);
    gl.uniform1i(this.overU.u_accum, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, graded.tex);
    gl.uniform1i(this.overU.u_layer, 1);
    gl.uniform4f(this.overU.u_rect, rect.x, 1 - rect.y, rect.scale * 0.5, rect.scale * 0.5);
    gl.uniform1f(this.overU.u_rot, (-rect.rotationDeg * Math.PI) / 180);
    gl.uniform1f(this.overU.u_opacity, rect.opacity);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // 拷贝回 graded（即当前 dst），维持双缓冲交替约定
    this.bindFboTarget(graded.tex);
    gl.useProgram(this.copyProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.overWork.tex);
    gl.uniform1i(this.copyU.u_s, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    const gl = this.gl;
    [this.gradeProg, this.overProg, this.bgProg, this.copyProg].forEach((p) => gl.deleteProgram(p));
    [this.accumA, this.accumB].forEach((f) => {
      gl.deleteFramebuffer(f.fb);
      gl.deleteTexture(f.tex);
    });
    if (this.overWork) {
      gl.deleteFramebuffer(this.overWork.fb);
      gl.deleteTexture(this.overWork.tex);
    }
    gl.deleteFramebuffer(this.workFbo);
    for (const t of this.lutTexCache.values()) gl.deleteTexture(t);
    gl.deleteTexture(this.dummyLut);
  }
}

export function activeClipsAt(project: Project, timeSec: number): { itemIndex: number; localTime: number }[] {
  const out: { itemIndex: number; localTime: number }[] = [];
  project.items.forEach((item, i) => {
    if (timeSec >= item.start && timeSec < item.start + item.duration) {
      out.push({ itemIndex: i, localTime: timeSec - item.start });
    }
  });
  return out;
}

export function clipLocalToSourceTime(clip: Clip, localTime: number): number {
  return clip.inPoint + Math.min(localTime, clip.outPoint - clip.inPoint);
}
