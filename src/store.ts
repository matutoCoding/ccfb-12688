/** 应用级共享状态：当前工程、当前设备、全局 PWM 曲线、事件总线 */

import { kvGet, kvSet } from './db';
import { PwmCurves } from './types';

type Handler = () => void;

class Store {
  currentProjectId: string | null = null;
  currentDeviceId: string | null = null;
  pwm: PwmCurves = {
    r: linearCurve(), g: linearCurve(), b: linearCurve(), enabled: false,
  };
  /** 模拟环境光传感器（预览台实时驱动） */
  sensorLux = 800;
  private listeners = new Map<string, Set<Handler>>();

  async load(): Promise<void> {
    this.currentProjectId = (await kvGet<string>('currentProjectId')) ?? null;
    this.currentDeviceId = (await kvGet<string>('currentDeviceId')) ?? null;
    const pwm = await kvGet<{ r: number[]; g: number[]; b: number[]; enabled: boolean }>('pwmCurves');
    if (pwm) {
      this.pwm = {
        r: Float32Array.from(pwm.r), g: Float32Array.from(pwm.g), b: Float32Array.from(pwm.b),
        enabled: pwm.enabled,
      };
    }
  }

  async setCurrentProject(id: string | null): Promise<void> {
    this.currentProjectId = id;
    await kvSet('currentProjectId', id);
    this.emit('project');
  }

  async setCurrentDevice(id: string | null): Promise<void> {
    this.currentDeviceId = id;
    await kvSet('currentDeviceId', id);
    this.emit('device');
  }

  async setPwm(pwm: PwmCurves): Promise<void> {
    this.pwm = pwm;
    await kvSet('pwmCurves', {
      r: Array.from(pwm.r), g: Array.from(pwm.g), b: Array.from(pwm.b), enabled: pwm.enabled,
    });
    this.emit('pwm');
  }

  on(event: string, fn: Handler): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return () => this.listeners.get(event)?.delete(fn);
  }

  emit(event: string): void {
    this.listeners.get(event)?.forEach((fn) => fn());
  }
}

function linearCurve(): Float32Array {
  const c = new Float32Array(256);
  for (let i = 0; i < 256; i++) c[i] = i / 255;
  return c;
}

export const store = new Store();
