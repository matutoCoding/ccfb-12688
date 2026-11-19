/**
 * 全息风扇 POV（视觉暂留）成像仿真渲染器 —— 本系统对真机还原度的核心。
 *
 * 稳定性设计（拖动转速不抖、不频闪）：
 *  1. 相位用 performance.now() 差值做浮点累加，角速度对目标值做指数平滑，
 *     拖滑杆时转速连续过渡，相位绝不跳变；
 *  2. 画面亮度是 (像素, 相位, 角速度) 的解析函数：每个像素独立计算
 *     "灯带上次扫过本角度距今多久"，按余辉衰减加权 —— 不依赖历史帧累积，
 *     因此没有帧间抖动和频闪；
 *  3. 角向按编码器分区、径向按灯珠数做量化采样，边界处做平滑混合，
 *     既保留真实设备的离散扫描质感，又避免量化边界爬行闪烁。
 */

import { LutData, lutToHalfData } from '../lut';

export interface PovFrameState {
  phase: number;          // 灯带当前角度 rad（外部累加传入）
  omega: number;          // 当前角速度 rad/s（带符号，正=逆时针）
  persistence: number;    // 视觉暂留时长 s
  ledCount: number;
  sectorsPerRev: number;
  attitude: number;       // 姿态补偿角 rad
  brightness: number;     // 环境光/手动亮度 0..1
  whiteBalance: [number, number, number]; // RGB 增益（已乘总亮度）
  pwmEnabled: boolean;
  splitCompare: boolean;  // 校正前后分屏
  showUnsafe: boolean;
  safeRadius: number;     // 0..1
  exposure: number;
}

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;

uniform sampler2D uContent;
uniform sampler2D uPwm;      // 256x3，每行一个通道的 占空比->感知亮度 曲线
uniform sampler3D uLut;
uniform float uLutSize;
uniform bool uUseLut;
uniform vec2 uRes;
uniform float uPhase;
uniform float uOmega;
uniform float uPersistence;
uniform float uLeds;
uniform float uSectors;
uniform float uAttitude;
uniform float uBrightness;
uniform vec3 uWB;
uniform bool uPwmOn;
uniform bool uSplit;
uniform bool uShowUnsafe;
uniform float uSafeRadius;
uniform float uExposure;

out vec4 outColor;

const float TAU = 6.28318530718;

vec3 applyLut(vec3 c){
  if(!uUseLut) return c;
  float n = uLutSize;
  vec3 uv = clamp(c, 0.0, 1.0) * ((n - 1.0) / n) + 0.5 / n;
  return texture(uLut, uv).rgb;
}

vec3 applyPwm(vec3 c){
  return vec3(
    texture(uPwm, vec2(clamp(c.r,0.0,1.0), 0.5/3.0)).r,
    texture(uPwm, vec2(clamp(c.g,0.0,1.0), 1.5/3.0)).r,
    texture(uPwm, vec2(clamp(c.b,0.0,1.0), 2.5/3.0)).r);
}

// 余辉权重：灯带上次扫过角度 a 距今 t 秒，指数衰减。
// 角位移沿旋转方向展开：mod((phase - a) * 方向, 2π)，顺/逆时针均正确。
float glowAt(float a, float omegaAbs){
  float d = mod((uPhase - a) * sign(uOmega), TAU);
  float t = d / omegaAbs;
  float x = t / uPersistence;
  return x >= 1.0 ? 0.0 : exp(-3.0 * x);
}

// 内容采样：极坐标 -> 内容 UV（内容即整幅圆盘画面，姿态角做旋转补偿）
vec3 sampleAt(float a, float rr){
  float ca = cos(a + uAttitude);
  float sa = sin(a + uAttitude);
  vec2 cuv = vec2(0.5) + 0.5 * rr * vec2(ca, sa);
  return texture(uContent, cuv).rgb;
}

void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = uv * 2.0 - 1.0;
  p.x *= uRes.x / uRes.y;

  float r = length(p);
  vec3 bg = vec3(0.055) + 0.015 * vec3(smoothstep(0.0, 1.4, r));
  if(r > 1.0){
    // 扇叶圆盘之外：看到背景（风扇是透明显示）
    outColor = vec4(bg, 1.0);
    return;
  }

  float theta = atan(p.y, p.x);            // -PI..PI
  if(theta < 0.0) theta += TAU;

  // ---- 角向量化（编码器分区），边界平滑混合防爬行 ----
  float sectorF = theta / TAU * uSectors;
  float s0 = floor(sectorF);
  float frac = sectorF - s0;
  float blendEdge = smoothstep(0.92, 1.0, frac);   // 每区末端 8% 过渡
  float thetaQ0 = (s0 + 0.5) / uSectors * TAU;
  float thetaQ1 = (s0 + 1.5) / uSectors * TAU;

  // ---- 径向量化（灯珠），同样平滑 ----
  float ledF = r * uLeds;
  float l0 = floor(ledF);
  float ledBlend = smoothstep(0.9, 1.0, ledF - l0);
  float rQ0 = clamp((l0 + 0.5) / uLeds, 0.0, 1.0);
  float rQ1 = clamp((l0 + 1.5) / uLeds, 0.0, 1.0);

  float omegaAbs = max(abs(uOmega), 1e-4);

  float w0 = glowAt(thetaQ0, omegaAbs);
  float w1 = glowAt(thetaQ1, omegaAbs);
  float w = mix(w0, w1, blendEdge);
  float rq = mix(rQ0, rQ1, ledBlend);
  float aq = mix(thetaQ0, thetaQ1, blendEdge);

  vec3 col = sampleAt(aq, rq) * w;

  // 暗背景叠加（灯珠熄灭处隐约可见扇叶）
  col += bg * 0.25;

  // 白平衡（逐台设备 RGB 增益 x 总亮度）
  col *= uWB;

  // 环境光/手动整体亮度 + 曝光
  col *= uBrightness * uExposure;

  // 调色 LUT（在 PWM 校正前作用于内容侧）
  col = applyLut(clamp(col, 0.0, 1.0));

  // PWM 占空比->感知亮度 非线性校正，支持左右分屏对比
  bool corrected = true;
  if(uSplit){
    corrected = uv.x < 0.5;
  }
  if(uPwmOn && corrected){
    col = applyPwm(clamp(col, 0.0, 1.0));
  }
  if(uSplit){
    float line = smoothstep(0.002, 0.0, abs(uv.x - 0.5));
    col = mix(col, vec3(1.0, 0.85, 0.2), line * 0.9);
  }

  // 安全半径越界红色警示
  if(uShowUnsafe && r > uSafeRadius){
    vec3 src = sampleAt(theta, r);
    float lum = dot(src, vec3(0.299, 0.587, 0.114));
    if(lum > 0.04){
      col = mix(col, vec3(1.0, 0.1, 0.15), 0.75);
    }
  }
  // 安全半径参考线
  float ring = smoothstep(0.004, 0.0, abs(r - uSafeRadius));
  col = mix(col, vec3(0.2, 0.6, 0.4), ring * 0.35);

  // 简单 tonemap，避免过曝死白
  col = col / (col + vec3(0.35));

  outColor = vec4(col, 1.0);
}`;

export class PovRenderer {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private contentTex: WebGLTexture;
  private pwmTex: WebGLTexture;
  private lutTex: WebGLTexture | null = null;
  private lutSize = 0;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private contentDirty = true;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.prog = this.buildProgram(VERT, FRAG);

    // 全屏三角形
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.contentTex = this.makeTexture(0);
    this.pwmTex = this.makeTexture(1);
    this.setPwmCurves(null); // 默认线性

    for (const name of [
      'uContent', 'uPwm', 'uLut', 'uLutSize', 'uUseLut', 'uRes', 'uPhase', 'uOmega',
      'uPersistence', 'uLeds', 'uSectors', 'uAttitude', 'uBrightness', 'uWB',
      'uPwmOn', 'uSplit', 'uShowUnsafe', 'uSafeRadius', 'uExposure',
    ]) {
      this.u[name] = gl.getUniformLocation(this.prog, name);
    }
    gl.useProgram(this.prog);
    gl.uniform1i(this.u.uContent, 0);
    gl.uniform1i(this.u.uPwm, 1);
    gl.uniform1i(this.u.uLut, 2);
  }

  private makeTexture(unit: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private buildProgram(vsSrc: string, fsSrc: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('Shader 编译失败: ' + gl.getShaderInfoLog(sh));
      }
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Program 链接失败: ' + gl.getProgramInfoLog(prog));
    }
    return prog;
  }

  /** 上传内容帧（合成画布的 2D canvas，正方形） */
  setContent(source: TexImageSource): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.contentTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.contentDirty = false;
  }

  /** PWM 校正曲线：null 表示线性。curves 为 [r,g,b] 各 256 级 */
  setPwmCurves(curves: [Float32Array, Float32Array, Float32Array] | null): void {
    const gl = this.gl;
    const data = new Uint8Array(256 * 3 * 4);
    for (let ch = 0; ch < 3; ch++) {
      for (let i = 0; i < 256; i++) {
        const v = curves ? curves[ch][i] : i / 255;
        const o = (ch * 256 + i) * 4;
        data[o] = Math.round(Math.min(Math.max(v, 0), 1) * 255);
        data[o + 1] = data[o];
        data[o + 2] = data[o];
        data[o + 3] = 255;
      }
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.pwmTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 3, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  setLut(lut: LutData | null): void {
    const gl = this.gl;
    if (this.lutTex) { gl.deleteTexture(this.lutTex); this.lutTex = null; }
    this.lutSize = 0;
    if (lut) {
      const tex = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_3D, tex);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      const n = lut.size;
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, n, n, n, 0, gl.RGBA, gl.HALF_FLOAT, lutToHalfData(lut));
      this.lutTex = tex;
      this.lutSize = n;
    }
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  render(s: PovFrameState): void {
    const gl = this.gl;
    this.resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.prog);
    gl.uniform2f(this.u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.u.uPhase, s.phase);
    gl.uniform1f(this.u.uOmega, s.omega);
    gl.uniform1f(this.u.uPersistence, s.persistence);
    gl.uniform1f(this.u.uLeds, s.ledCount);
    gl.uniform1f(this.u.uSectors, s.sectorsPerRev);
    gl.uniform1f(this.u.uAttitude, s.attitude);
    gl.uniform1f(this.u.uBrightness, s.brightness);
    gl.uniform3f(this.u.uWB, s.whiteBalance[0], s.whiteBalance[1], s.whiteBalance[2]);
    gl.uniform1i(this.u.uPwmOn, s.pwmEnabled ? 1 : 0);
    gl.uniform1i(this.u.uSplit, s.splitCompare ? 1 : 0);
    gl.uniform1i(this.u.uShowUnsafe, s.showUnsafe ? 1 : 0);
    gl.uniform1f(this.u.uSafeRadius, s.safeRadius);
    gl.uniform1f(this.u.uExposure, s.exposure);
    gl.uniform1i(this.u.uUseLut, this.lutTex ? 1 : 0);
    gl.uniform1f(this.u.uLutSize, this.lutSize || 2);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  destroy(): void {
    const ext = this.gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
  }
}
