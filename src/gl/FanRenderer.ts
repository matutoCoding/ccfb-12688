// 视觉暂留（POV）风扇成像渲染器 —— 全系统最核心模块
//
// 物理模型与真机对齐：
//   灯珠随扇叶旋转，每经过一个角度就点亮对应内容像素；人眼/荧光粉按时间常数 τ 指数余晖。
//   稳态显示 I(θ) = Σ_k content_k(θ) · exp(-age_k / τ)
//
// 三通道流水线（每 rAF 节拍）：
//   1) 脉冲通道 pulseFbo：仅在本节拍新帧扫过的扇形角区间内写内容色，其余位置为 0；
//      帧->扇区由编码器脉冲模型按瞬时转速积分 dθ=ω·dt，历史帧扇区永不回改，
//      因此转速突变时画面不拉伸、不压缩。
//   2) 暂留通道 persist(A/B 乒乓 HDR FBO)：
//      persist = persist·exp(-dt/τ) + pulse·kExposure
//      衰减系数按真实墙钟 dt 计算，与帧率解耦；曝光系数按每秒圈数归一化，
//      平均亮度与 rpm 解耦 —— 拖转速不抖不频闪的根本保证。
//   3) 显示通道：白平衡 / PWM 校正 / 姿态补偿 / 安全半径红标 / 灯珠离散化。
//
// 防抖动：机械相位 this.phase 只做连续积分，滑杆改 rpm 只改 ω，绝不重置相位或时间线。
import { createFloatFbo, createQuadProgram, createQuadVao, uniformLocations, type FloatFbo } from './glutil';
import { degToRad, normAngleDeg } from '../core/mathutil';
import type { RotationDirection } from '../core/types';

export const RING_CAPACITY = 40;

const PULSE_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler2DArray;
in vec2 v_uv;
out vec4 outColor;

uniform sampler2DArray u_ring;     // 最近 N 帧内容
uniform sampler2D u_meta;          // Nx1 RG32F：thetaStart(rad), thetaEnd(rad)
uniform int u_ringCount;
uniform int u_ringHead;
uniform float u_attitudeRad;
uniform vec3 u_bg;

vec2 polar(vec2 uv) {
  vec2 p = uv - 0.5;
  return vec2(length(p) * 2.0, atan(p.y, p.x));
}

void main() {
  vec2 pol = polar(v_uv);
  float r = pol.x;
  float theta = pol.y + u_attitudeRad;
  if (r > 1.0) { outColor = vec4(u_bg, 1.0); return; }

  // 脉冲通道只重建"最新一帧"扫过的扇区；历史帧的余晖由暂留通道指数保留
  int slot = (u_ringHead - 1 + ${RING_CAPACITY}) % ${RING_CAPACITY};
  vec2 meta = texelFetch(u_meta, ivec2(slot, 0), 0).rg;
  float a0 = meta.x;
  float a1 = meta.y;
  float mid = (a0 + a1) * 0.5;
  float halfSpan = abs(a1 - a0) * 0.5;
  float d = abs(atan(sin(theta - mid), cos(theta - mid)));
  if (halfSpan > 0.00001 && d <= halfSpan) {
    float cu = clamp(0.5 + r * 0.5 * cos(theta), 0.0, 1.0);
    float cv = clamp(0.5 + r * 0.5 * sin(theta), 0.0, 1.0);
    vec3 rgb = texture(u_ring, vec3(cu, cv, float(slot))).rgb;
    outColor = vec4(rgb, 1.0);
  } else {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
  }
}`;

const PERSIST_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_prev;
uniform sampler2D u_pulse;
uniform float u_retain;    // exp(-dt / tau)
uniform float u_exposure;  // 与每秒脉冲数成反比，稳态亮度不随转速漂移
void main() {
  vec3 prev = texture(u_prev, v_uv).rgb * u_retain;
  vec3 pulse = texture(u_pulse, v_uv).rgb;
  outColor = vec4(prev + pulse * u_exposure, 1.0);
}`;

const DISPLAY_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_persist;
uniform int u_ledCount;
uniform float u_safeRadius;
uniform int u_showSafety;
uniform vec3 u_wbGain;
uniform float u_globalBrightness;
uniform int u_calibEnabled;
uniform int u_splitCompare;
uniform sampler2D u_calibR;
uniform sampler2D u_calibG;
uniform sampler2D u_calibB;
uniform float u_centerHub;
uniform vec3 u_background;
uniform float u_tonemap;

vec3 calib(vec3 c, sampler2D rT, sampler2D gT, sampler2D bT) {
  return vec3(
    texture(rT, vec2(clamp(c.r, 0.0, 1.0), 0.5)).r,
    texture(gT, vec2(clamp(c.g, 0.0, 1.0), 0.5)).r,
    texture(bT, vec2(clamp(c.b, 0.0, 1.0), 0.5)).r
  );
}

void main() {
  vec2 p = v_uv - 0.5;
  float r = length(p) * 2.0;
  if (r < u_centerHub || r > 1.0) {
    outColor = vec4(u_background, 1.0);
    return;
  }
  vec3 rgb = texture(u_persist, v_uv).rgb;
  // 灯珠径向离散化：模拟一排 LED 的物理采样点（柔化过渡，不引入时域闪烁）
  float ledPhase = fract(r * float(u_ledCount));
  float ledMask = smoothstep(0.0, 0.18, ledPhase) * (1.0 - smoothstep(0.82, 1.0, ledPhase));
  rgb *= mix(0.78, 1.0, ledMask);

  rgb *= u_wbGain * u_globalBrightness;
  // 简易 Reinhard 色调映射，压制 HDR 累积高光
  rgb = rgb / (1.0 + rgb * u_tonemap);

  vec3 before = rgb;
  vec3 after = calib(rgb, u_calibR, u_calibG, u_calibB);
  if (u_calibEnabled == 1) {
    rgb = (u_splitCompare == 1) ? (v_uv.x < 0.5 ? after : before) : after;
  }

  if (u_showSafety == 1 && r > u_safeRadius) {
    rgb = mix(rgb, vec3(1.0, 0.06, 0.06), 0.4);
  }
  outColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

export interface RingFrameMeta {
  thetaStart: number;
  thetaEnd: number;
  contentTime: number;
}

export interface FanRenderParams {
  rpm: number;
  direction: RotationDirection;
  persistenceMs: number;
  ledCount: number;
  bladeCount: number;
  safeRadiusRatio: number;
  showSafety: boolean;
  attitudeAngleDeg: number;
  wbGain: [number, number, number];
  globalBrightness: number;
  calibEnabled: boolean;
  splitCompare: boolean;
  calibTextures: { r: WebGLTexture; g: WebGLTexture; b: WebGLTexture } | null;
  centerHubRatio: number;
  background: [number, number, number];
}

export class FanRenderer {
  private gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private pulseProg: WebGLProgram;
  private persistProg: WebGLProgram;
  private displayProg: WebGLProgram;
  private pU: Record<string, WebGLUniformLocation | null>;
  private sU: Record<string, WebGLUniformLocation | null>;
  private dU: Record<string, WebGLUniformLocation | null>;

  private persistA: FloatFbo;
  private persistB: FloatFbo;
  private pulseFbo: FloatFbo;
  private ringTex: WebGLTexture;
  private metaTex: WebGLTexture;
  private layerFbo: WebGLFramebuffer;
  private ringMeta: RingFrameMeta[];
  private ringHead = 0;
  private ringCount = 0;

  /** 机械相位（弧度），仅连续积分，永不重置 —— 防抖动关键状态 */
  private phase = 0;
  readonly size: number;
  /** 最近一次实际用于渲染的瞬时转速（含漂移），供 UI/日志读取 */
  measuredRpm = 0;

  constructor(gl: WebGL2RenderingContext, size: number) {
    this.gl = gl;
    this.size = size;
    this.ringMeta = Array.from({ length: RING_CAPACITY }, () => ({ thetaStart: 0, thetaEnd: 0, contentTime: -1 }));
    this.vao = createQuadVao(gl);
    this.pulseProg = createQuadProgram(gl, PULSE_FS);
    this.persistProg = createQuadProgram(gl, PERSIST_FS);
    this.displayProg = createQuadProgram(gl, DISPLAY_FS);
    this.pU = uniformLocations(gl, this.pulseProg, [
      'u_ring', 'u_meta', 'u_ringCount', 'u_ringHead', 'u_attitudeRad', 'u_bg',
    ]);
    this.sU = uniformLocations(gl, this.persistProg, ['u_prev', 'u_pulse', 'u_retain', 'u_exposure']);
    this.dU = uniformLocations(gl, this.displayProg, [
      'u_persist', 'u_ledCount', 'u_safeRadius', 'u_showSafety', 'u_wbGain', 'u_globalBrightness',
      'u_calibEnabled', 'u_splitCompare', 'u_calibR', 'u_calibG', 'u_calibB',
      'u_centerHub', 'u_background', 'u_tonemap',
    ]);

    this.persistA = createFloatFbo(gl, size);
    this.persistB = createFloatFbo(gl, size);
    this.pulseFbo = createFloatFbo(gl, size);

    this.ringTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.ringTex);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, size, size, RING_CAPACITY, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.metaTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.metaTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, RING_CAPACITY, 1, 0, gl.RG, gl.FLOAT, new Float32Array(RING_CAPACITY * 2));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.layerFbo = gl.createFramebuffer()!;
  }

  /**
   * 推入一帧内容并按编码器脉冲模型记账扇区。
   * @param instantaneousRpm 控制板回传脉冲折算的瞬时转速（漂移由调用方模拟/实测）
   * @param direction        顺时针 +1 / 逆时针 -1
   * @param dtSec            该帧对应的真实时间间隔
   */
  pushContentFrame(contentTex: WebGLTexture, instantaneousRpm: number, direction: RotationDirection, dtSec: number, contentTime: number): void {
    const gl = this.gl;
    const omega = (2 * Math.PI * Math.max(0, instantaneousRpm)) / 60;
    const dTheta = omega * dtSec * direction;
    const thetaStart = this.phase;
    const thetaEnd = this.phase + dTheta;
    this.phase = thetaEnd;
    this.measuredRpm = instantaneousRpm;

    const slot = this.ringHead;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerFbo);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.ringTex, 0, slot);
    gl.viewport(0, 0, this.size, this.size);
    // 内容纹理经全屏四边形拷贝入数组层（独立的 copy 程序避免采样器类型冲突）
    gl.disable(gl.BLEND);
    this.copyQuad(contentTex);

    this.ringMeta[slot] = { thetaStart, thetaEnd, contentTime };
    this.ringHead = (this.ringHead + 1) % RING_CAPACITY;
    this.ringCount = Math.min(this.ringCount + 1, RING_CAPACITY);
    this.uploadMeta();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private copyProg: WebGLProgram | null = null;
  private copyU: Record<string, WebGLUniformLocation | null> = {};
  private copyQuad(src: WebGLTexture): void {
    const gl = this.gl;
    if (!this.copyProg) {
      this.copyProg = createQuadProgram(
        gl,
        `#version 300 es
        precision highp float;
        precision highp sampler2D;
        in vec2 v_uv; out vec4 o;
        uniform sampler2D u_s;
        void main(){ o = texture(u_s, v_uv); }`,
      );
      this.copyU = uniformLocations(gl, this.copyProg, ['u_s']);
    }
    gl.useProgram(this.copyProg);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(this.copyU.u_s, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private uploadMeta(): void {
    const gl = this.gl;
    const data = new Float32Array(RING_CAPACITY * 2);
    for (let i = 0; i < RING_CAPACITY; i++) {
      data[i * 2] = this.ringMeta[i].thetaStart;
      data[i * 2 + 1] = this.ringMeta[i].thetaEnd;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.metaTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, RING_CAPACITY, 1, gl.RG, gl.FLOAT, data);
  }

  /**
   * 每个 rAF 节拍执行完整三通道。
   * @param newContent 本节拍新内容帧（无则为 null，暂留仍按 dt 衰减）
   */
  renderFrame(
    dtSec: number,
    params: FanRenderParams,
    newContent: { tex: WebGLTexture; rpm: number; contentTime: number } | null,
  ): void {
    const gl = this.gl;
    const dt = Math.min(Math.max(dtSec, 1 / 240), 0.05);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    if (newContent) {
      this.pushContentFrame(newContent.tex, newContent.rpm, params.direction, dt, newContent.contentTime);
    }

    // 通道 1：脉冲扇区
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pulseFbo.fb);
    gl.viewport(0, 0, this.size, this.size);
    gl.useProgram(this.pulseProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.ringTex);
    gl.uniform1i(this.pU.u_ring, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.metaTex);
    gl.uniform1i(this.pU.u_meta, 1);
    gl.uniform1i(this.pU.u_ringCount, this.ringCount);
    gl.uniform1i(this.pU.u_ringHead, this.ringHead);
    gl.uniform1f(this.pU.u_attitudeRad, degToRad(params.attitudeAngleDeg));
    gl.uniform3f(this.pU.u_bg, params.background[0], params.background[1], params.background[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 通道 2：暂留累积（指数衰减 + 转速归一化曝光）
    // 物理稳态：persist* = pulse·k / (1-retain)，其中 1-retain ≈ dt/τ。
    // 每个角度单位时间被扫过的频次 = ω/2π（rev/s），要让稳态亮度与转速解耦，
    // 单脉冲曝光 k 必须正比于 (2π/ω)·(dt/τ)，即扇区越窄（高转速）单次贡献越小、频次越高，
    // 二者抵消后 persist* 仅取决于内容色与 τ，与 rpm 无关 —— 拖转速不频闪的核心。
    const tauSec = Math.max(params.persistenceMs / 1000, 1e-4);
    const retain = Math.exp(-dt / tauSec);
    const omega = (2 * Math.PI * Math.max(params.rpm, 1)) / 60;
    const sectorSpan = Math.min(2 * Math.PI, omega * dt);
    const gain = 1 - retain; // ≈ dt/τ
    const exposure = Math.min(2.0, (gain * (2 * Math.PI) / Math.max(sectorSpan, 1e-4)) * 0.12);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.persistB.fb);
    gl.useProgram(this.persistProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.persistA.tex);
    gl.uniform1i(this.sU.u_prev, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.pulseFbo.tex);
    gl.uniform1i(this.sU.u_pulse, 1);
    gl.uniform1f(this.sU.u_retain, retain);
    gl.uniform1f(this.sU.u_exposure, exposure);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const tmp = this.persistA;
    this.persistA = this.persistB;
    this.persistB = tmp;

    // 通道 3：显示
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.useProgram(this.displayProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.persistA.tex);
    gl.uniform1i(this.dU.u_persist, 0);
    gl.uniform1i(this.dU.u_ledCount, params.ledCount);
    gl.uniform1f(this.dU.u_safeRadius, params.safeRadiusRatio);
    gl.uniform1i(this.dU.u_showSafety, params.showSafety ? 1 : 0);
    gl.uniform3f(this.dU.u_wbGain, params.wbGain[0], params.wbGain[1], params.wbGain[2]);
    gl.uniform1f(this.dU.u_globalBrightness, params.globalBrightness);
    gl.uniform1i(this.dU.u_calibEnabled, params.calibEnabled ? 1 : 0);
    gl.uniform1i(this.dU.u_splitCompare, params.splitCompare ? 1 : 0);
    const cal = params.calibTextures;
    const dummy = this.dummyTex();
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, cal?.r ?? dummy);
    gl.uniform1i(this.dU.u_calibR, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, cal?.g ?? dummy);
    gl.uniform1i(this.dU.u_calibG, 4);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, cal?.b ?? dummy);
    gl.uniform1i(this.dU.u_calibB, 5);
    gl.uniform1f(this.dU.u_centerHub, params.centerHubRatio);
    gl.uniform3f(this.dU.u_background, params.background[0], params.background[1], params.background[2]);
    gl.uniform1f(this.dU.u_tonemap, 0.18);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private _dummy: WebGLTexture | null = null;
  private dummyTex(): WebGLTexture {
    if (!this._dummy) {
      const gl = this.gl;
      this._dummy = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this._dummy);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    return this._dummy;
  }

  get phaseDeg(): number {
    return normAngleDeg((this.phase * 180) / Math.PI);
  }

  reset(): void {
    const gl = this.gl;
    for (const fbo of [this.persistA, this.persistB, this.pulseFbo]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fb);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.phase = 0;
    this.ringHead = 0;
    this.ringCount = 0;
    this.measuredRpm = 0;
    this.ringMeta = Array.from({ length: RING_CAPACITY }, () => ({ thetaStart: 0, thetaEnd: 0, contentTime: -1 }));
    this.uploadMeta();
  }

  dispose(): void {
    const gl = this.gl;
    [this.pulseProg, this.persistProg, this.displayProg, this.copyProg].filter(Boolean).forEach((p) => gl.deleteProgram(p!));
    [this.persistA, this.persistB, this.pulseFbo].forEach((f) => {
      gl.deleteFramebuffer(f.fb);
      gl.deleteTexture(f.tex);
    });
    gl.deleteTexture(this.ringTex);
    gl.deleteTexture(this.metaTex);
    gl.deleteFramebuffer(this.layerFbo);
    if (this._dummy) gl.deleteTexture(this._dummy);
  }
}
