/**
 * 预览引擎：把 POV 渲染器、遥测仿真、扇形映射、环境光传感与视频帧源串成一条链路。
 * 单例由预览台持有；rAF 循环只在预览台页面运行。
 */
import type { DeviceProfile, PreviewRuntimeState, RotationDirection } from '../types';
import { POVRenderer } from './pov-renderer';
import { SectorMapper, buildSectorLut, buildInverseSectorLut } from '../lib/sector-mapper';
import { TelemetrySimulator, RPM_MIN, RPM_MAX, directionSign } from '../lib/telemetry';
import { brightnessAtLux } from '../lib/ambient';
import { buildStrip, type ContentStrip } from './strip-builder';
import { extractFrame } from '../lib/video';
import type { Clip, Project } from '../types';
import { store } from '../lib/store';

export class PreviewEngine {
  renderer: POVRenderer;
  mapper = new SectorMapper();
  telemetry = new TelemetrySimulator(900, 14);
  state: PreviewRuntimeState = {
    rpm: 900,
    direction: 'cw',
    running: true,
    driftEnabled: true,
    splitCalibration: false,
    sensorConnected: true,
    ambientLux: 400,
    outputBrightness: 0.7,
  };
  calibrated = true;
  private rafId = 0;
  private lastTs = 0;
  private strip: ContentStrip | null = null;
  private stripClock = 0;
  private lastStripAt = -1;
  private constantClock = 0;
  private constantRevs = 1;
  private frameCache = new Map<string, { at: number; image: ImageData; url: string; video: HTMLVideoElement }>();
  private project: Project | null = null;
  private device: DeviceProfile | null = null;
  private safetyMask: Uint8Array | null = null;
  onSensorEvent?: (message: string) => void;
  onStats?: (s: { measuredRpm: number; periodMs: number }) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new POVRenderer(canvas);
  }

  attach(project: Project, device: DeviceProfile): void {
    this.project = project;
    this.device = device;
    this.state.sensorConnected = device.sensorConnected;
    this.state.rpm = device.measuredRpm || 900;
    this.telemetry = new TelemetrySimulator(this.state.rpm, this.state.driftEnabled ? 14 : 0);
    this.mapper.reset();
    this.renderer.reset();
    this.constantClock = 0;
    this.constantRevs = 1;
    this.stripClock = 0;
    this.lastStripAt = -1;
    this.frameCache.forEach((e) => URL.revokeObjectURL(e.url));
    this.frameCache.clear();
    this.strip = null;
  }

  setSafetyMask(mask: Uint8Array | null): void {
    this.safetyMask = mask;
  }

  setRpm(rpm: number): void {
    this.state.rpm = Math.max(RPM_MIN, Math.min(RPM_MAX, rpm));
    this.telemetry.targetRpm = this.state.rpm;
  }

  setDirection(dir: RotationDirection): void {
    this.state.direction = dir;
  }

  setDrift(on: boolean): void {
    this.state.driftEnabled = on;
    this.telemetry.driftAmplitude = on ? 14 : 0;
  }

  /** 模拟电压突变（50ms 后生效，验证不拉伸不压缩） */
  injectVoltageJump(jumpRpm: number): void {
    this.telemetry.addVoltageJump(this.telemetry.clock + 0.05, jumpRpm);
  }

  setSensorConnected(connected: boolean): void {
    if (connected === this.state.sensorConnected) return;
    this.state.sensorConnected = connected;
    if (this.device) {
      this.device.sensorConnected = connected;
      this.device.eventLog.push({
        at: Date.now(),
        type: connected ? 'sensor-reconnect' : 'sensor-disconnect',
        message: connected ? '环境光传感器恢复连接' : '环境光传感器断连，回退手动亮度',
      });
      store.save('devices', this.device);
    }
    this.onSensorEvent?.(connected ? '传感器已重连' : '传感器断连：已回退手动亮度');
  }

  setAmbientLux(lux: number): void {
    this.state.ambientLux = Math.max(0, lux);
  }

  start(): void {
    if (this.rafId) return;
    this.lastTs = performance.now();
    const loop = (ts: number) => {
      const dt = Math.min(0.05, (ts - this.lastTs) / 1000);
      this.lastTs = ts;
      this.step(dt);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private async step(dt: number): Promise<void> {
    if (!this.project || !this.device) return;

    // 1) 环境光 -> 亮度；断连回退手动
    if (this.state.sensorConnected) {
      this.state.outputBrightness = brightnessAtLux(this.device.ambientCurve, this.state.ambientLux);
    } else {
      this.state.outputBrightness = this.device.fallbackBrightness;
    }

    // 2) 遥测推进，实测每圈周期喂入扇形映射
    if (this.state.running) {
      let revs: { tEnd: number; periodSec: number }[];
      if (this.state.driftEnabled) {
        revs = this.telemetry.advance(dt);
      } else {
        // 恒速模式：直接按标称转速产生周期，保持同一套映射链路
        this.constantClock += dt;
        const period = 60 / this.state.rpm;
        revs = [];
        while (this.constantClock >= this.constantRevs * period) {
          revs.push({ tEnd: this.constantRevs * period, periodSec: period });
          this.constantRevs += 1;
        }
      }
      for (const r of revs) this.mapper.pushRevolution(r.tEnd, r.periodSec);
      this.stripClock += dt;
    }

    // 3) 内容条带：按内容时间刷新（视频片段），节流到 ~12Hz 避免 seek 过密
    if (!this.strip || this.stripClock - this.lastStripAt > 0.08) {
      this.lastStripAt = this.stripClock;
      const contentTime = this.stripClock % Math.max(1, this.project.totalDurationSec);
      this.strip = await buildStrip(this.project, this.device, contentTime, (clip, localSec) =>
        this.frameSource(clip, localSec),
      );
      this.renderer.uploadContent(this.strip.rgb, this.strip.framesPerRevolution, this.strip.ledCount);
    }

    // 4) 正向 帧->机械角 LUT（漂移补偿），再在 CPU 求逆映射供着色器直接采样
    const sign = directionSign(this.state.direction);
    const forward = buildSectorLut(this.mapper, this.project.framesPerRevolution, 0, sign);
    const inverse = buildInverseSectorLut(forward);

    this.renderer.renderFrame(
      this.state.running ? dt : 0,
      {
        rpm: this.state.driftEnabled ? this.mapper.measuredRpm || this.state.rpm : this.state.rpm,
        direction: this.state.direction,
        device: this.device,
        splitCalibration: this.state.splitCalibration,
        calibrated: this.calibrated,
        ambientBrightness: this.state.outputBrightness,
        safetyMask: this.safetyMask,
        framesPerRevolution: this.project.framesPerRevolution,
        ledCount: this.project.ledCount,
      },
      inverse,
    );

    this.onStats?.({
      measuredRpm: this.mapper.measuredRpm || this.state.rpm,
      periodMs: this.mapper.currentPeriodSec * 1000,
    });
  }

  /** 视频帧源：同一片段+帧号缓存复用，避免重复 seek */
  private async frameSource(clip: Clip, sourceTimeSec: number): Promise<ImageData | null> {
    const source = store.videoById(clip.sourceId);
    if (!source) return null;
    const frameNo = Math.round(sourceTimeSec * clip.sourceFps);
    const key = `${clip.id}:${frameNo}`;
    const cached = this.frameCache.get(key);
    if (cached) return cached.image;
    try {
      const t = Math.max(0, Math.min(sourceTimeSec, source.durationSec - 0.05));
      const res = await extractFrame(source, t, 320);
      if (this.frameCache.size > 24) {
        const firstKey = this.frameCache.keys().next().value;
        if (firstKey) {
          const old = this.frameCache.get(firstKey)!;
          URL.revokeObjectURL(old.url);
          this.frameCache.delete(firstKey);
        }
      }
      this.frameCache.set(key, { at: t, image: res.image, url: res.url, video: res.video });
      return res.image;
    } catch {
      return null;
    }
  }

  dispose(): void {
    this.stop();
    this.frameCache.forEach((e) => URL.revokeObjectURL(e.url));
    this.renderer.dispose();
  }
}
