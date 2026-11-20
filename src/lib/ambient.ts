/**
 * 环境光照度(lux) -> 输出亮度(0..1) 锚点曲线。
 * 支持多锚点、单调约束、拖拽编辑、插值求值与序列化。
 */
import { interp1d } from './pwm';

export interface AmbientAnchor {
  lux: number;
  brightness: number;
}

export const DEFAULT_AMBIENT_CURVE: AmbientAnchor[] = [
  { lux: 0, brightness: 0.25 },
  { lux: 100, brightness: 0.45 },
  { lux: 500, brightness: 0.75 },
  { lux: 2000, brightness: 1.0 },
];

export function brightnessAtLux(curve: AmbientAnchor[], lux: number): number {
  const xs = curve.map((a) => a.lux);
  const ys = curve.map((a) => a.brightness);
  return interp1d(xs, ys, Math.max(0, lux));
}

/** 保持 lux 升序；返回新数组 */
export function upsertAnchor(curve: AmbientAnchor[], anchor: AmbientAnchor): AmbientAnchor[] {
  const next = curve.filter((a) => Math.abs(a.lux - anchor.lux) > 1e-6);
  next.push({ lux: Math.max(0, anchor.lux), brightness: Math.max(0.02, Math.min(1, anchor.brightness)) });
  next.sort((a, b) => a.lux - b.lux);
  return next;
}

export function removeAnchor(curve: AmbientAnchor[], lux: number): AmbientAnchor[] {
  if (curve.length <= 2) return curve; // 至少保留两个锚点
  return curve.filter((a) => Math.abs(a.lux - lux) > 1e-6);
}
