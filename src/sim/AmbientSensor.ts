// 环境光传感器：模拟器 + 可选 Web Serial 真机接入
// 照度(lux) -> 输出亮度 的映射由设备页锚点曲线决定；断连回退手动亮度并记日志
import { clamp, samplePiecewise } from '../core/mathutil';
import type { LightCurvePoint, SensorLogEntry, SensorState } from '../core/types';

export const DEFAULT_LIGHT_CURVE: LightCurvePoint[] = [
  { lux: 0, brightness: 0.35 },
  { lux: 100, brightness: 0.5 },
  { lux: 500, brightness: 0.75 },
  { lux: 2000, brightness: 1.0 },
];

export class AmbientSensor {
  state: SensorState = {
    connected: true,
    lux: 300,
    curve: DEFAULT_LIGHT_CURVE.map((p) => ({ ...p })),
    log: [],
    lastDisconnectAt: null,
    lastReconnectAt: null,
  };
  private simT = 0;
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  onChange: (() => void) | null = null;

  setCurve(curve: LightCurvePoint[]): void {
    this.state.curve = curve.map((p) => ({ ...p })).sort((a, b) => a.lux - b.lux);
  }

  brightnessForLux(lux: number): number {
    const pts = this.state.curve.map((p) => ({ x: p.lux, y: p.brightness }));
    return clamp(samplePiecewise(pts, lux), 0, 1);
  }

  /** 模拟器每节拍调用：生成缓慢昼夜波动的照度 */
  tick(dtSec: number): void {
    if (!this.state.connected) return;
    this.simT += dtSec;
    const base = 320 + Math.sin(this.simT / 9) * 260 + Math.sin(this.simT / 2.3) * 40;
    this.state.lux = Math.round(clamp(base + (Math.random() - 0.5) * 12, 0, 3000));
  }

  connect(): void {
    if (this.state.connected) return;
    this.state.connected = true;
    this.state.lastReconnectAt = Date.now();
    this.pushLog('connect', this.state.lux, this.brightnessForLux(this.state.lux));
    this.onChange?.();
  }

  disconnect(): void {
    if (!this.state.connected) return;
    this.state.connected = false;
    this.state.lastDisconnectAt = Date.now();
    this.pushLog('disconnect', this.state.lux, this.brightnessForLux(this.state.lux));
    this.onChange?.();
  }

  /** 外部（UI 模拟或真机协议）直接喂照度 */
  feedLux(lux: number): void {
    this.state.lux = Math.round(clamp(lux, 0, 100000));
    if (this.state.connected) {
      this.pushLog('sample', this.state.lux, this.brightnessForLux(this.state.lux));
    }
  }

  private pushLog(type: SensorLogEntry['type'], lux: number, brightness: number): void {
    this.state.log.push({ time: Date.now(), type, lux, brightness });
    if (this.state.log.length > 2000) this.state.log.splice(0, this.state.log.length - 2000);
  }

  /** 断连时段（毫秒），供设备日志/UI 统计 */
  outageMs(): number {
    if (this.state.connected || this.state.lastDisconnectAt === null) return 0;
    const end = this.state.lastReconnectAt ?? Date.now();
    return end - this.state.lastDisconnectAt;
  }

  /**
   * 真机 Web Serial 接入（协议：ASCII 行 "LUX:<n>\\n"，断开即触发断连告警）。
   * 不支持 Web Serial 的浏览器返回 false，调用方继续使用模拟器。
   */
  async openSerial(): Promise<boolean> {
    if (!('serial' in navigator) || !navigator.serial) return false;
    try {
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: 115200 });
      this.connect();
      const decoder = new TextDecoder();
      let buf = '';
      this.reader = this.port.readable!.getReader();
      const loop = async (): Promise<void> => {
        while (this.port && this.reader) {
          try {
            const { value, done } = await this.reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              const m = line.match(/LUX[:=]\s*(\d+(?:\.\d+)?)/i);
              if (m) this.feedLux(parseFloat(m[1]));
            }
          } catch {
            break;
          }
        }
        this.disconnect();
      };
      void loop();
      return true;
    } catch {
      this.port = null;
      return false;
    }
  }

  async closeSerial(): Promise<void> {
    try {
      await this.reader?.cancel();
      this.reader = null;
      await this.port?.close();
    } catch {
      /* ignore */
    }
    this.port = null;
  }
}
