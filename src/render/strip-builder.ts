/**
 * 内容极坐标条带合成器。
 * 输出 FPR（每圈帧数）× LED 颗灯珠的 RGB 缓冲，作为 POV 渲染器的内容纹理。
 * 画布编排中的每个占位框对应条带上的一个矩形区域，片段帧按区域绘制，
 * LUT 调色在本阶段逐像素套用（库内预览与上机走同一套色）。
 */
import type { CanvasItem, Clip, DeviceProfile, Project } from '../types';
import { applyLut } from '../lib/lut';
import { store } from '../lib/store';

export interface ContentStrip {
  rgb: Uint8ClampedArray;
  framesPerRevolution: number;
  ledCount: number;
}

/**
 * @param frameSource 按 clip + 局部时间取帧的回调（由 PreviewEngine 提供，含视频 seek 缓存）
 */
export async function buildStrip(
  project: Project,
  device: DeviceProfile,
  contentTimeSec: number,
  frameSource: (clip: Clip, localSec: number) => Promise<ImageData | null>,
): Promise<ContentStrip> {
  const fpr = project.framesPerRevolution;
  const led = project.ledCount;
  const canvas = document.createElement('canvas');
  canvas.width = led;
  canvas.height = fpr;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, led, fpr);

  for (const item of project.items) {
    if (!item.clipId) continue;
    const clip = store.clipById(item.clipId);
    if (!clip) continue;
    const local = contentTimeSec - item.trackStartSec;
    if (local < 0 || local > item.durationSec) continue;
    const frame = await frameSource(clip, local + clip.inPointSec);
    if (!frame) continue;

    const x0 = Math.round(item.r0 * led);
    const x1 = Math.round(item.r1 * led);
    // 角度：条带纵轴即帧序号（=角度位），姿态补偿在此旋转
    const tiltFrames = Math.round((device.tiltCompensationRad / (2 * Math.PI)) * fpr);
    const y0 = mod(Math.round(item.angle0 / (2 * Math.PI) * fpr) + tiltFrames, fpr);
    const h = Math.max(1, Math.round((item.angleSpan / (2 * Math.PI)) * fpr));

    const graded = applyGrade(frame, clip);
    const tmp = document.createElement('canvas');
    tmp.width = graded.width;
    tmp.height = graded.height;
    tmp.getContext('2d')!.putImageData(graded, 0, 0);

    drawWrapped(ctx, tmp, x0, y0, Math.max(1, x1 - x0), h, fpr);
  }

  const imageData = ctx.getImageData(0, 0, led, fpr);
  // 去掉 alpha 转紧凑 RGB
  const rgb = new Uint8ClampedArray(fpr * led * 3);
  for (let i = 0, j = 0; i < imageData.data.length; i += 4, j += 3) {
    rgb[j] = imageData.data[i];
    rgb[j + 1] = imageData.data[i + 1];
    rgb[j + 2] = imageData.data[i + 2];
  }
  return { rgb, framesPerRevolution: fpr, ledCount: led };
}

function applyGrade(frame: ImageData, clip: Clip): ImageData {
  const grade = clip.grades.find((g) => g.id === clip.activeGradeId);
  if (!grade) return frame;
  const lut = grade.lutId ? store.luts.find((l) => l.id === grade.lutId) : null;
  if (!lut) {
    if (grade.exposure === 0 && grade.saturation === 1) return frame;
    return applyParamOnly(frame, grade.exposure, grade.saturation);
  }
  return applyLut(frame, lut, grade.strength, grade.exposure, grade.saturation);
}

function applyParamOnly(image: ImageData, exposure: number, saturation: number): ImageData {
  const ev = 2 ** exposure;
  const out = new Uint8ClampedArray(image.data);
  for (let i = 0; i < out.length; i += 4) {
    let r = out[i] * ev, g = out[i + 1] * ev, b = out[i + 2] * ev;
    if (saturation !== 1) {
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = luma + (r - luma) * saturation;
      g = luma + (g - luma) * saturation;
      b = luma + (b - luma) * saturation;
    }
    out[i] = r; out[i + 1] = g; out[i + 2] = b;
  }
  return new ImageData(out, image.width, image.height);
}

/** 跨纵轴边界（0/360°）环绕绘制 */
function drawWrapped(
  ctx: CanvasRenderingContext2D,
  img: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
  fpr: number,
): void {
  const draws = [y];
  if (y + h > fpr) draws.push(y - fpr);
  for (const yy of draws) {
    ctx.drawImage(img, 0, 0, img.width, img.height, x, yy, w, h);
  }
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}
