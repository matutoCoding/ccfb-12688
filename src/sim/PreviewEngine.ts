// 预览引擎：rAF 主循环，编排 时间线 -> 视频解码 -> 内容合成 -> POV 风扇渲染
// 内容时间与机械相位独立积分；转速滑杆改动只影响角速度，循环不重启，因此不抖不闪。
import { ContentComposer, type LayerRect, type LayerSource, clipLocalToSourceTime } from '../gl/ContentComposer';
import { FanRenderer } from '../gl/FanRenderer';
import { VideoTextureSource } from '../gl/VideoTextureSource';
import { createGl, createRampTexture1D } from '../gl/glutil';
import { RpmDriftModel } from './RpmDriftModel';
import { AmbientSensor } from './AmbientSensor';
import { getVideoElement, seekTo } from '../media/video';
import { clamp, samplePiecewise } from '../core/mathutil';
import type {
  Clip,
  Device,
  PwmCalib,
  Project,
  RotationDirection,
  WallCell,
  WallLayout,
} from '../core/types';

export interface EngineHooks {
  onMeasured?: (rpm: number, phaseDeg: number, brightness: number, lux: number) => void;
  onPlayLog?: (entry: { materialCode: string; startUnix: number; endUnix: number; measuredRpm: number }) => void;
}

interface CalibBundle {
  r: WebGLTexture;
  g: WebGLTexture;
  b: WebGLTexture;
}

const CALIB_SAMPLES = 256;

export class PreviewEngine {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private composer: ContentComposer;
  private fan: FanRenderer;
  private drift: RpmDriftModel;
  readonly sensor: AmbientSensor;
  private videoTex = new Map<string, VideoTextureSource>();
  private contentTex: WebGLTexture;
  private contentFbo: WebGLFramebuffer;
  private calibCache = new Map<string, CalibBundle>();
  private hooks: EngineHooks;

  /** 外部 UI 可在引擎创建后挂接实测数据回调 */
  setMeasuredHook(fn: NonNullable<EngineHooks['onMeasured']>): void {
    this.hooks.onMeasured = fn;
  }

  private project: Project | null = null;
  private clips = new Map<string, Clip>();
  private device: Device | null = null;
  private calib: PwmCalib | null = null;
  private wall: WallLayout | null = null;
  /** 空工程时的内置测试图纹理（彩色扇区 + 极坐标条纹），保证无素材也能验证 POV 成像 */
  private testPatternTex: WebGLTexture | null = null;
  private testPatternFbo: WebGLFramebuffer | null = null;

  private running = false;
  private rafId = 0;
  private lastTs: number | null = null;
  /** 工程内容时间（秒），独立于机械相位积分 */
  private contentTime = 0;
  private contentFps = 30;
  private frameAccum = 0;
  private lastContentFrame = -1;
  private playing = true;
  private rpmOverride: number | null = null;
  private direction: RotationDirection = 1;
  private calibEnabled = false;
  private splitCompare = false;
  private ambientAuto = true;
  private showSafety = true;
  private persistenceMs = 24;
  private measuredRpm = 900;
  private materialCodeForClip = new Map<string, string>();
  private playSession: { code: string; startUnix: number; rpmSum: number; rpmN: number } | null = null;

  constructor(canvas: HTMLCanvasElement, resolution: number, hooks: EngineHooks = {}) {
    this.canvas = canvas;
    this.hooks = hooks;
    this.gl = createGl(canvas);
    canvas.width = resolution;
    canvas.height = resolution;
    this.composer = new ContentComposer(this.gl, resolution);
    this.fan = new FanRenderer(this.gl, resolution);
    this.drift = new RpmDriftModel(900, 0);
    this.sensor = new AmbientSensor();

    this.contentTex = this.gl.createTexture()!;
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.contentTex);
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA8, resolution, resolution, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, null);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
    this.contentFbo = this.gl.createFramebuffer()!;
  }

  setProject(project: Project | null, clips: Clip[], assets: Map<string, { blob: Blob; duration: number; fps: number }>): void {
    this.project = project;
    this.clips = new Map(clips.map((c) => [c.id, c]));
    this.contentTime = 0;
    this.frameAccum = 0;
    this.lastContentFrame = -1;
    this.fan.reset();
    void this.primeVideos(assets);
  }

  private async primeVideos(assets: Map<string, { blob: Blob; duration: number; fps: number }>): Promise<void> {
    // 预热涉及到的视频元素，避免首帧 seek 卡顿造成主循环抖动
    for (const clip of this.clips.values()) {
      const asset = assets.get(clip.assetId);
      if (!asset) continue;
      const v = getVideoElement(asset as unknown as import('../core/types').Asset);
      if (v.readyState < 2) {
        await new Promise<void>((r) => {
          v.onloadeddata = () => r();
          setTimeout(r, 2000);
        });
      }
    }
  }

  setDevice(device: Device | null, calib: PwmCalib | null): void {
    this.device = device;
    this.calib = calib;
    if (device) {
      this.drift.setTarget(this.rpmOverride ?? device.targetRpm);
      this.drift.setAmplitude(device.driftAmplitude);
    }
  }

  setWall(wall: WallLayout | null): void {
    this.wall = wall;
  }

  setRpm(rpm: number): void {
    this.rpmOverride = rpm;
    this.drift.setTarget(rpm);
    // 注意：不重置 contentTime / phase —— 这是拖转速无抖动的关键
  }

  setDirection(d: RotationDirection): void {
    this.direction = d;
  }
  setCalibEnabled(v: boolean): void { this.calibEnabled = v; }
  setSplitCompare(v: boolean): void { this.splitCompare = v; }
  setAmbientAuto(v: boolean): void { this.ambientAuto = v; }
  setShowSafety(v: boolean): void { this.showSafety = v; }
  setPersistenceMs(v: number): void { this.persistenceMs = v; }
  setPlaying(v: boolean): void { this.playing = v; }
  seekContent(t: number): void {
    this.contentTime = clamp(t, 0, this.project?.duration || 8);
    this.frameAccum = 0;
  }
  get currentContentTime(): number { return this.contentTime; }
  get currentMeasuredRpm(): number { return this.measuredRpm; }

  setMaterialBindings(bindings: { materialCode: string; clipId: string }[]): void {
    this.materialCodeForClip = new Map(bindings.map((b) => [b.clipId, b.materialCode]));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTs = null;
    const loop = (ts: number) => {
      if (!this.running) return;
      this.tick(ts);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.flushPlaySession(this.measuredRpm);
  }

  private tick(ts: number): void {
    if (this.lastTs === null) this.lastTs = ts;
    const dt = Math.min((ts - this.lastTs) / 1000, 0.05);
    this.lastTs = ts;

    // 1) 转速漂移采样（编码器脉冲实测语义）
    const targetRpm = this.rpmOverride ?? this.device?.targetRpm ?? 900;
    this.drift.setTarget(targetRpm);
    this.measuredRpm = this.drift.sample(dt);

    // 2) 环境光
    this.sensor.tick(dt);
    const autoBrightness = this.sensor.brightnessForLux(this.sensor.state.lux);
    const brightness = this.ambientAuto && this.sensor.state.connected
      ? autoBrightness
      : (this.device?.manualBrightness ?? 0.8);

    // 3) 内容时间线推进（与机械相位解耦）
    let newContentTex: WebGLTexture | null = null;
    let contentTimeForFrame = this.contentTime;
    const effectiveDuration = this.project && this.project.duration > 0 ? this.project.duration : 8;
    if (this.playing) {
      this.contentTime += dt;
      if (this.contentTime >= effectiveDuration) {
        this.contentTime = this.contentTime % effectiveDuration;
      }
      this.frameAccum += dt * this.contentFps;
      const frameIdx = Math.floor(this.frameAccum);
      if (frameIdx !== this.lastContentFrame) {
        this.lastContentFrame = frameIdx;
        newContentTex = this.project && this.project.items.length
          ? this.composeContent(this.contentTime)
          : this.ensureTestPattern(this.contentTime);
        contentTimeForFrame = this.contentTime;
        this.trackPlaySession();
      }
    } else if (this.project) {
      newContentTex = this.composeContent(this.contentTime);
    }

    // 4) POV 渲染（墙模式下逐台带相位差渲染）
    const params = this.buildParams(brightness);
    if (this.wall && this.wall.cells.length > 0) {
      this.renderWall(params, dt, newContentTex, contentTimeForFrame);
    } else {
      this.fan.renderFrame(dt, params, newContentTex ? { tex: newContentTex, rpm: this.measuredRpm, contentTime: contentTimeForFrame } : null);
    }

    this.hooks.onMeasured?.(this.measuredRpm, this.fan.phaseDeg, brightness, this.sensor.state.lux);
  }

  private renderWall(
    baseParams: ReturnType<PreviewEngine['buildParams']>,
    dt: number,
    newContentTex: WebGLTexture | null,
    contentTime: number,
  ): void {
    const gl = this.gl;
    const wall = this.wall!;
    const cells = wall.cells;
    const n = cells.length;
    // 视口网格：按墙行列均分画布
    const cols = wall.cols;
    const rows = wall.rows;
    const vw = Math.floor(this.canvas.width / cols);
    const vh = Math.floor(this.canvas.height / rows);
    gl.clearColor(0.02, 0.02, 0.03, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    cells.forEach((cell, i) => {
      const x = (cell.col % cols) * vw;
      const y = this.canvas.height - (Math.floor(i / cols) + 1) * vh;
      gl.viewport(x, y, vw, vh);
      const cellDrift = cell.driftOverride ?? this.device?.driftAmplitude ?? 0;
      // 单台漂移只改它自己那块的瞬时转速（独立漂移实例在 WallEngine 中维护；
      // 这里用相位偏移 + 振幅扰动近似，满足"只重算它那一块"的语义）
      const localRpm = this.measuredRpm + Math.sin(performance.now() / 477 + i) * cellDrift * 0.5;
      const p = { ...baseParams, attitudeAngleDeg: baseParams.attitudeAngleDeg + cell.phaseOffsetDeg };
      this.fan.renderFrame(
        dt / n,
        p,
        newContentTex ? { tex: newContentTex, rpm: localRpm, contentTime } : null,
      );
    });
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  private buildParams(brightness: number) {
    const d = this.device;
    return {
      rpm: this.measuredRpm,
      direction: this.direction,
      persistenceMs: this.persistenceMs,
      ledCount: d?.ledCount ?? 224,
      bladeCount: 2,
      safeRadiusRatio: d?.safeRadiusRatio ?? 0.92,
      showSafety: this.showSafety,
      attitudeAngleDeg: d?.attitudeAngleDeg ?? 0,
      wbGain: [d?.whiteBalance.r ?? 1, d?.whiteBalance.g ?? 1, d?.whiteBalance.b ?? 1] as [number, number, number],
      globalBrightness: brightness * (d?.whiteBalance.brightness ?? 1),
      calibEnabled: this.calibEnabled,
      splitCompare: this.splitCompare,
      calibTextures: this.calibEnabled && this.calib ? this.calibBundle(this.calib) : null,
      centerHubRatio: 0.08,
      background: [0.015, 0.015, 0.02] as [number, number, number],
    };
  }

  private calibBundle(calib: PwmCalib): CalibBundle {
    let bundle = this.calibCache.get(calib.id);
    if (bundle) return bundle;
    const gl = this.gl;
    const build = (pts: { duty: number; luminance: number }[]) => {
      const vals = new Array(CALIB_SAMPLES);
      const ppp = pts.map((p) => ({ x: p.duty, y: p.luminance }));
      for (let i = 0; i < CALIB_SAMPLES; i++) vals[i] = samplePiecewise(ppp, i / (CALIB_SAMPLES - 1));
      return createRampTexture1D(gl, CALIB_SAMPLES, vals);
    };
    bundle = { r: build(calib.pointsR), g: build(calib.pointsG), b: build(calib.pointsB) };
    this.calibCache.set(calib.id, bundle);
    return bundle;
  }

  /** 合成当前工程时间点的内容方图 */
  private composeContent(time: number): WebGLTexture {
    const gl = this.gl;
    const project = this.project;
    const sources: LayerSource[] = [];
    const rects: LayerRect[] = [];
    if (project) {
      for (const item of project.items) {
        if (time < item.start || time >= item.start + item.duration) continue;
        const clip = this.clips.get(item.clipId);
        if (!clip || clip.relinkPending) continue;
        const tex = this.sampleClipTexture(clip, time - item.start);
        if (!tex) continue;
        const grade = clip.grades.find((g) => g.id === clip.activeGradeId) ?? null;
        const lut = grade?.lutId ? (this.lutLookup(grade.lutId)) : null;
        sources.push({ texture: tex, grade, lut });
        rects.push({ x: item.x, y: item.y, scale: item.scale, rotationDeg: item.rotationDeg, opacity: item.opacity });
      }
    }
    const bg = parseBg(project?.bgColor ?? '#050508');
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.contentFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.contentTex, 0);
    this.composer.render(this.contentTex, sources, rects, bg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.contentTex;
  }

  private lutLookup(_id: string): import('../core/types').LUTFile | null {
    return this.lutResolver?.(_id) ?? null;
  }
  lutResolver: ((id: string) => import('../core/types').LUTFile | null) | null = null;

  private sampleClipTexture(clip: Clip, localTime: number): WebGLTexture | null {
    const asset = this.assetResolver?.(clip.assetId);
    if (!asset) return null;
    const source = getVideoElement(asset);
    const srcTime = clipLocalToSourceTime(clip, localTime);
    // seek 是异步的；主循环不能 await，采用"发起 seek + 复用当前帧"策略，
    // seek 完成后下一节拍自然刷新，视频时长缓存后相邻帧 seek 代价极低
    if (Math.abs(source.currentTime - srcTime) > 1 / Math.max(clip.fps, 1)) {
      void seekTo(source, srcTime);
    }
    let tex = this.videoTex.get(clip.assetId);
    if (!tex) {
      tex = new VideoTextureSource(this.gl);
      this.videoTex.set(clip.assetId, tex);
    }
    if (source.videoWidth > 0) tex.upload(source);
    return tex.tex;
  }

  assetResolver: ((assetId: string) => import('../core/types').Asset | null) | null = null;

  private trackPlaySession(): void {
    // 以当前时间线第一个命中的 clip 作为上播素材，写设备播放日志语义
    if (!this.project) return;
    const hit = this.project.items.find((it) => this.contentTime >= it.start && this.contentTime < it.start + it.duration);
    if (!hit) return this.flushPlaySession(this.measuredRpm);
    const code = this.materialCodeForClip.get(hit.clipId) ?? `MAT-${hit.clipId.slice(-6).toUpperCase()}`;
    if (!this.playSession || this.playSession.code !== code) {
      this.flushPlaySession(this.measuredRpm);
      this.playSession = { code, startUnix: Math.floor(Date.now() / 1000), rpmSum: 0, rpmN: 0 };
    }
    this.playSession.rpmSum += this.measuredRpm;
    this.playSession.rpmN += 1;
  }

  private flushPlaySession(finalRpm: number): void {
    if (!this.playSession) return;
    const avg = this.playSession.rpmN ? this.playSession.rpmSum / this.playSession.rpmN : finalRpm;
    this.hooks.onPlayLog?.({
      materialCode: this.playSession.code,
      startUnix: this.playSession.startUnix,
      endUnix: Math.floor(Date.now() / 1000),
      measuredRpm: Math.round(avg),
    });
    this.playSession = null;
  }

  /** 内置测试图：极坐标彩色扇区 + 同心环 + 旋转扫描条，用来在无素材时验证 POV 与转速成像 */
  private ensureTestPattern(time: number): WebGLTexture {
    const gl = this.gl;
    const size = this.composer.size;
    if (!this.testPatternTex) {
      this.testPatternTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.testPatternTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.testPatternFbo = gl.createFramebuffer()!;
    }
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#050508';
    ctx.fillRect(0, 0, size, size);
    const cx = size / 2;
    const cy = size / 2;
    const R = size / 2;
    const colors = ['#ef4444', '#f59e0b', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7', '#ec4899', '#eab308'];
    const sectors = 8;
    for (let i = 0; i < sectors; i++) {
      const a0 = (i / sectors) * Math.PI * 2 + time * 0.6;
      const a1 = ((i + 1) / sectors) * Math.PI * 2 + time * 0.6;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, a0, a1);
      ctx.closePath();
      ctx.fillStyle = colors[i];
      ctx.globalAlpha = 0.85;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // 同心环与径向刻度，检验径向分辨率（灯珠数）表现
    for (let ring = 1; ring <= 5; ring++) {
      ctx.beginPath();
      ctx.arc(cx, cy, (R * ring) / 6, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,.55)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    // 旋转高亮扫描条
    const sa = time * 2.2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, sa, sa + 0.12);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    // 中心文字
    ctx.fillStyle = '#0b1220';
    ctx.font = `bold ${Math.round(size * 0.08)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('HOLO', cx, cy);

    gl.bindTexture(gl.TEXTURE_2D, this.testPatternTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    return this.testPatternTex;
  }

  /** 供导出中心安全扫描读取当前内容像素，支持缩放到任意方形边长 */
  readContentPixels(size: number): Uint8Array {
    const gl = this.gl;
    // 源：内容 FBO（引擎分辨率）
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.contentFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.contentTex, 0);
    const px = new Uint8Array(size * size * 4);
    if (size === this.composer.size) {
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
    } else {
      // 经缩放下放纹理再读回，保证导出边长与包包头声明一致
      const tmpTex = this.acquireExportTexture(size);
      const tmpFbo = this.acquireExportFbo();
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.contentFbo);
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.contentTex, 0);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, tmpFbo);
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tmpTex, 0);
      gl.blitFramebuffer(
        0, 0, this.composer.size, this.composer.size,
        0, 0, size, size,
        gl.COLOR_BUFFER_BIT, gl.LINEAR,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, tmpFbo);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return px;
  }

  private exportTex: WebGLTexture | null = null;
  private exportTexSize = 0;
  private exportFbo: WebGLFramebuffer | null = null;
  private acquireExportTexture(size: number): WebGLTexture {
    const gl = this.gl;
    if (this.exportTex && this.exportTexSize === size) return this.exportTex;
    if (this.exportTex) gl.deleteTexture(this.exportTex);
    this.exportTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.exportTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.exportTexSize = size;
    return this.exportTex;
  }
  private acquireExportFbo(): WebGLFramebuffer {
    if (!this.exportFbo) this.exportFbo = this.gl.createFramebuffer()!;
    return this.exportFbo;
  }

  /** 导出路径：在指定工程时间点合成一次内容方图（不影响 rAF 预览循环） */
  renderOnceForExport(time: number): void {
    const gl = this.gl;
    const tex = this.composeContent(time);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.contentFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  get contentTexture(): WebGLTexture { return this.contentTex; }
  get glContext(): WebGL2RenderingContext { return this.gl; }
  get fanRenderer(): FanRenderer { return this.fan; }

  dispose(): void {
    this.stop();
    this.composer.dispose();
    this.fan.dispose();
    for (const t of this.videoTex.values()) t.dispose();
    for (const b of this.calibCache.values()) {
      this.gl.deleteTexture(b.r);
      this.gl.deleteTexture(b.g);
      this.gl.deleteTexture(b.b);
    }
    this.gl.deleteTexture(this.contentTex);
    this.gl.deleteFramebuffer(this.contentFbo);
    if (this.testPatternTex) this.gl.deleteTexture(this.testPatternTex);
    if (this.testPatternFbo) this.gl.deleteFramebuffer(this.testPatternFbo);
    void this.sensor.closeSerial();
  }
}

function parseBg(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.02, 0.02, 0.03];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
