/**
 * WebGL2 POV（视觉暂留）风扇渲染器。
 *
 * 成像链路：
 *   内容极坐标条带(contentTex: FPR×LED)
 *     -> 逆扇形 LUT(sectorTex) 把机械角映射回内容帧
 *     -> LED 扫掠片元着色（逐扇叶、白平衡、PWM 校正、环境亮度）
 *     -> 余晖缓冲(ping-pong RGBA16F) 按真实时间指数衰减（视觉暂留）
 *     -> 上屏，可选安全越界红掩膜 / 校正前后分屏
 *
 * 防频闪/防抖动设计：
 *   1. 仿真以固定 SIM_HZ 子步推进，rAF 仅呈现，与显示器刷新率解耦；
 *   2. 余晖衰减只按真实 dt 计算，与转速无关，不存在转速-刷新拍频；
 *   3. 内容帧角度由 SectorMapper 的实测周期映射给出，拖动 RPM 时位置连续；
 *   4. 片元级解析扫掠四边形，任意转速无径向缝隙/频闪条带。
 */
import type { DeviceProfile, RotationDirection } from '../types';
import { mod2pi } from '../lib/sector-mapper';
import { directionSign } from '../lib/telemetry';

const SIM_HZ = 240; // 固定仿真频率
const SIM_DT = 1 / SIM_HZ;
const PERSISTENCE_SEC = 0.05; // 视觉暂留余晖时间常数

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main(){
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/** 余晖衰减 + 可选分屏标记 */
const DECAY_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPrev;
uniform float uDecay;
uniform float uSplit;          // >0.5 时启用分屏
out vec4 outColor;
void main(){
  vec4 c = texture(uPrev, vUv);
  c.rgb *= uDecay;
  if (uSplit > 0.5 && vUv.x > 0.5) {
    // 分屏右半：未校正对照区，加轻微压暗提示
    c.rgb *= 0.92;
  }
  outColor = c;
}`;

/** LED 扫掠 pass：把一个仿真子步内扇叶扫过的四边形写入余晖 */
const LED_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uContent;   // LED x FPR 极坐标条带（宽=灯珠，高=帧）
uniform sampler2D uSector;    // FPR x 1，机械角(0..1) -> 内容帧位(0..1) 的逆映射
uniform sampler2D uCalibR;    // 256x1 校正曲线 R/G/B
uniform sampler2D uCalibG;
uniform sampler2D uCalibB;
uniform float uAngle0;        // 子步起始机械角（圈数归一化 0..1）
uniform float uAngle1;        // 子步结束机械角
uniform float uBlades;
uniform float uTilt;          // 姿态补偿（圈数归一化）
uniform vec3 uWb;             // 白平衡增益
uniform float uMaster;        // 整体亮度
uniform float uAmbient;       // 环境光输出亮度
uniform float uCalibrated;    // 1=套用PWM校正 0=原始对照
uniform float uSplit;         // 分屏模式
uniform float uDirection;     // 1=cw, -1=ccw
uniform sampler2D uMask;      // 安全越界掩膜（宽 LED × 高 FPR）
uniform float uHasMask;
out vec4 outColor;

void main(){
  vec2 pc = vUv * 2.0 - 1.0;
  float radius = length(pc);
  if (radius > 1.0) { outColor = vec4(0.0); return; }
  float theta = atan(pc.y, pc.x) / 6.2831853 + 0.5 - uTilt; // 0..1
  theta = fract(theta);

  // 分屏：右半画面强制未校正对照
  float calibrated = uCalibrated;
  if (uSplit > 0.5 && vUv.x > 0.5) calibrated = 0.0;

  vec3 accum = vec3(0.0);
  float hit = 0.0;
  for (float b = 0.0; b < 8.0; b++) {
    if (b >= uBlades) break;
    float bladeBase = uDirection > 0.0 ? uAngle0 : (1.0 - uAngle1);
    float bladeAngle = fract(bladeBase + b / uBlades);
    float d = abs(theta - bladeAngle);
    d = min(d, 1.0 - d);
    float halfSpan = abs(uAngle1 - uAngle0) * 0.5;
    if (d <= halfSpan) {
      // 逆扇形映射：CPU 预算的 机械角->内容帧 查找表，直接采样
      float invFrame = texture(uSector, vec2(fract(theta), 0.5)).r;
      float ledV = clamp(radius, 0.0, 1.0);
      vec3 raw = texture(uContent, vec2(ledV, fract(invFrame))).rgb;
      // 安全半径越界：掩膜与内容同构（x=灯珠径向，y=帧角），命中转红
      if (uHasMask > 0.5 && texture(uMask, vec2(ledV, fract(invFrame))).r > 0.5) {
        raw = vec3(1.0, 0.04, 0.04);
      }
      vec3 rgb = raw * uWb * uMaster * uAmbient;
      if (calibrated > 0.5) {
        rgb = vec3(
          texture(uCalibR, vec2(clamp(rgb.r,0.0,1.0), 0.5)).r,
          texture(uCalibG, vec2(clamp(rgb.g,0.0,1.0), 0.5)).r,
          texture(uCalibB, vec2(clamp(rgb.b,0.0,1.0), 0.5)).r
        );
      }
      accum += rgb;
      hit = 1.0;
    }
  }
  if (hit < 0.5) { outColor = vec4(0.0); return; }
  outColor = vec4(accum, 1.0);
}`;

const PRESENT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uSplit;
out vec4 outColor;
void main(){
  vec3 c = texture(uTex, vUv).rgb;
  // 柔和色调映射，避免高亮灯珠硬裁切
  c = c / (1.0 + c);
  c = pow(c, vec3(1.0 / 2.2));
  if (uSplit > 0.5 && abs(vUv.x - 0.5) < 0.002) c = vec3(1.0);
  outColor = vec4(c, 1.0);
}`;

interface GlProgram {
  prog: WebGLProgram;
  locs: Record<string, WebGLUniformLocation | null>;
}

export interface RenderParams {
  rpm: number;
  direction: RotationDirection;
  device: DeviceProfile;
  splitCalibration: boolean;
  calibrated: boolean;
  ambientBrightness: number;
  safetyMask: Uint8Array | null; // FPR*LED 行主序，1=越界
  framesPerRevolution: number;
  ledCount: number;
}

export class POVRenderer {
  private gl: WebGL2RenderingContext;
  private decayProg: GlProgram;
  private ledProg: GlProgram;
  private presentProg: GlProgram;
  private vao: WebGLVertexArrayObject;
  private texA: WebGLTexture;
  private texB: WebGLTexture;
  private fboA: WebGLFramebuffer;
  private fboB: WebGLFramebuffer;
  private contentTex: WebGLTexture;
  private sectorTex: WebGLTexture;
  private maskTex: WebGLTexture;
  private calibTexes: WebGLTexture[] = [];
  private size = 720;
  private simTime = 0;
  private accumulator = 0;
  private angle = 0; // 当前机械角（圈数归一化）
  private floatSupported: boolean;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.floatSupported = !!gl.getExtension('EXT_color_buffer_float');

    this.decayProg = this.buildProgram(VERT, DECAY_FRAG);
    this.ledProg = this.buildProgram(VERT, LED_FRAG);
    this.presentProg = this.buildProgram(VERT, PRESENT_FRAG);

    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.texA = this.createPersistentTexture();
    this.texB = this.createPersistentTexture();
    this.fboA = this.createFbo(this.texA);
    this.fboB = this.createFbo(this.texB);
    this.contentTex = this.createFloatTexture(1, 1);
    this.sectorTex = this.createFloatTexture(1, 1);
    this.maskTex = this.createByteTexture(1, 1);
    this.calibTexes = [0, 1, 2].map(() => this.createFloatTexture(256, 1));
    gl.clearColor(0.02, 0.02, 0.03, 1);
  }

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('着色器编译失败: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  private buildProgram(vs: string, fs: string): GlProgram {
    const gl = this.gl;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, this.compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, this.compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('程序链接失败: ' + gl.getProgramInfoLog(prog));
    }
    const locs: Record<string, WebGLUniformLocation | null> = {};
    const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(prog, i)!;
      locs[info.name] = gl.getUniformLocation(prog, info.name);
    }
    return { prog, locs };
  }

  private createPersistentTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const internal = this.floatSupported ? gl.RGBA16F : gl.RGBA8;
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, this.size, this.size, 0, gl.RGBA, this.floatSupported ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private createFbo(tex: WebGLTexture): WebGLFramebuffer {
    const gl = this.gl;
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return fbo;
  }

  private createFloatTexture(w: number, h: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private createByteTexture(w: number, h: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return tex;
  }

  /** 上传内容条带（FPR 帧 × LED 颗，RGB 行主序） */
  uploadContent(rgb: Uint8ClampedArray, framesPerRevolution: number, ledCount: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.contentTex);
    // 内容作为 RGB 字节上传到 RGBA 纹理（A 忽略）
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, ledCount, framesPerRevolution, 0, gl.RGBA, gl.UNSIGNED_BYTE, expandToRGBA(rgb, ledCount, framesPerRevolution));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  }

  /** 上传帧->机械角 LUT（归一化 0..1，长度 FPR） */
  uploadSectorLut(lut: Float32Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.sectorTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, lut.length, 1, 0, gl.RED, gl.FLOAT, lut);
  }

  uploadCalibration(curves: [number[], number[], number[]]): void {
    const gl = this.gl;
    curves.forEach((curve, i) => {
      gl.bindTexture(gl.TEXTURE_2D, this.calibTexes[i]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 256, 1, 0, gl.RED, gl.FLOAT, new Float32Array(curve));
    });
  }

  uploadSafetyMask(mask: Uint8Array | null, framesPerRevolution: number, ledCount: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    if (!mask) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
      return;
    }
    // 掩膜布局与内容纹理一致：宽 LED、高 FPR，行主序
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, ledCount, framesPerRevolution, 0, gl.RED, gl.UNSIGNED_BYTE, mask);
  }

  reset(): void {
    this.simTime = 0;
    this.accumulator = 0;
    this.angle = 0;
    const gl = this.gl;
    for (const fbo of [this.fboA, this.fboB]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  /**
   * 推进仿真并呈现。
   * @param dtSec 距上一帧的真实时间；mapper 已由外部喂入实测周期
   * @param inverseSector 机械角 -> 内容帧位 的逆映射 LUT（归一化 0..1，长度 FPR）
   */
  renderFrame(dtSec: number, params: RenderParams, inverseSector: Float32Array): void {
    const gl = this.gl;
    this.uploadSectorLut(inverseSector);
    this.uploadCalibration([
      params.device.pwmCalibration.r,
      params.device.pwmCalibration.g,
      params.device.pwmCalibration.b,
    ]);
    this.uploadSafetyMask(params.safetyMask, params.framesPerRevolution, params.ledCount);

    // 固定步长子步进，杜绝与刷新率耦合的频闪
    this.accumulator += Math.min(dtSec, 0.1);
    const sign = directionSign(params.direction);
    const revsPerSec = params.rpm / 60;

    let steps = 0;
    while (this.accumulator >= SIM_DT && steps < 32) {
      const a0 = mod2pi(this.angle * 2 * Math.PI) / (2 * Math.PI);
      this.angle += sign * revsPerSec * SIM_DT;
      const a1 = mod2pi(this.angle * 2 * Math.PI) / (2 * Math.PI);
      this.simTime += SIM_DT;
      this.ledPass(a0, a1, params);
      this.accumulator -= SIM_DT;
      steps++;
    }

    // 余晖衰减（真实时间常数，与转速/刷新率无关）
    this.decayPass(Math.exp(-dtSec / PERSISTENCE_SEC), params);
    this.presentPass(params);
  }

  private ledPass(a0: number, a1: number, p: RenderParams): void {
    const gl = this.gl;
    // 先把当前余晖 A 原样复制到 B，再在 B 上 additive 叠加本步 LED
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboA);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fboB);
    gl.blitFramebuffer(0, 0, this.size, this.size, 0, 0, this.size, this.size, gl.COLOR_BUFFER_BIT, gl.NEAREST);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboB);
    gl.viewport(0, 0, this.size, this.size);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.ledProg.prog);
    const L = this.ledProg.locs;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.contentTex);
    gl.uniform1i(L.uContent, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.sectorTex);
    gl.uniform1i(L.uSector, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.calibTexes[0]);
    gl.uniform1i(L.uCalibR, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.calibTexes[1]);
    gl.uniform1i(L.uCalibG, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.calibTexes[2]);
    gl.uniform1i(L.uCalibB, 4);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.uniform1i(L.uMask, 5);
    gl.uniform1f(L.uHasMask, p.safetyMask ? 1 : 0);
    gl.uniform1f(L.uAngle0, a0);
    gl.uniform1f(L.uAngle1, a1);
    gl.uniform1f(L.uBlades, p.device.bladeCount);
    gl.uniform1f(L.uTilt, p.device.tiltCompensationRad / (2 * Math.PI));
    gl.uniform3f(L.uWb, p.device.whiteBalance.rGain, p.device.whiteBalance.gGain, p.device.whiteBalance.bGain);
    gl.uniform1f(L.uMaster, p.device.whiteBalance.master);
    gl.uniform1f(L.uAmbient, p.ambientBrightness);
    gl.uniform1f(L.uCalibrated, p.calibrated ? 1 : 0);
    gl.uniform1f(L.uSplit, p.splitCalibration ? 1 : 0);
    gl.uniform1f(L.uDirection, p.direction === 'cw' ? 1 : -1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.BLEND);
    this.swap();
  }

  private decayPass(decay: number, p: RenderParams): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboB);
    gl.viewport(0, 0, this.size, this.size);
    gl.useProgram(this.decayProg.prog);
    const L = this.decayProg.locs;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texA);
    gl.uniform1i(L.uPrev, 0);
    gl.uniform1f(L.uDecay, decay);
    gl.uniform1f(L.uSplit, p.splitCalibration ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.swap();
  }

  private presentPass(p: RenderParams): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.useProgram(this.presentProg.prog);
    const L = this.presentProg.locs;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texA);
    gl.uniform1i(L.uTex, 0);
    gl.uniform1f(L.uSplit, p.splitCalibration ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private swap(): void {
    const t = this.texA;
    this.texA = this.texB;
    this.texB = t;
    const f = this.fboA;
    this.fboA = this.fboB;
    this.fboB = f;
  }

  get usesFloatBuffer(): boolean {
    return this.floatSupported;
  }

  dispose(): void {
    const gl = this.gl;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

function expandToRGBA(rgb: Uint8ClampedArray, ledCount: number, frames: number): Uint8Array {
  const out = new Uint8Array(ledCount * frames * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    out[j] = rgb[i];
    out[j + 1] = rgb[i + 1];
    out[j + 2] = rgb[i + 2];
    out[j + 3] = 255;
  }
  return out;
}
