// 扇叶安全半径逐帧扫描：在内容方图上按极坐标检查越界像素，输出越界帧号与红色标记图
import { clamp } from '../core/mathutil';

export interface SafetyViolation {
  frameIndex: number;
  timeSec: number;
  /** 越界像素数（占有效像素比例） */
  overPixels: number;
  ratio: number;
}

export interface SafetyScanResult {
  violations: SafetyViolation[];
  /** 每帧一份 RGBA 标记图（仅越界帧），key = frameIndex */
  markedFrames: Map<number, Uint8ClampedArray>;
  scannedFrames: number;
  safeRadiusRatio: number;
}

/**
 * @param frames      每帧 RGBA 像素（方形边长 size）
 * @param size        方图边长
 * @param safeRadius  安全半径比例 0..1（相对扇叶半径，中心轮毂外）
 * @param hubRatio    中心轮毂比例
 */
export function scanSafeRadius(
  frames: { index: number; timeSec: number; pixels: Uint8ClampedArray | Uint8Array }[],
  size: number,
  safeRadius: number,
  hubRatio = 0.08,
): SafetyScanResult {
  const violations: SafetyViolation[] = [];
  const markedFrames = new Map<number, Uint8ClampedArray>();
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const maxR = size / 2;
  const safeR = safeRadius * maxR;
  const hubR = hubRatio * maxR;
  const totalDisc = Math.PI * (maxR * maxR - hubR * hubR);

  for (const frame of frames) {
    const px = frame.pixels;
    let over = 0;
    let marked: Uint8ClampedArray | null = null;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r < hubR || r > maxR) continue;
        const idx = (y * size + x) * 4;
        // 非黑像素视为有效成像内容
        const lit = px[idx] + px[idx + 1] + px[idx + 2] > 24;
        if (lit && r > safeR) {
          over += 1;
          if (!marked) marked = new Uint8ClampedArray(px);
          marked[idx] = 255;
          marked[idx + 1] = 26;
          marked[idx + 2] = 26;
          marked[idx + 3] = 255;
        }
      }
    }
    if (over > 0) {
      violations.push({
        frameIndex: frame.index,
        timeSec: frame.timeSec,
        overPixels: over,
        ratio: clamp(over / totalDisc, 0, 1),
      });
      if (marked) markedFrames.set(frame.index, marked);
    }
  }
  return { violations, markedFrames, scannedFrames: frames.length, safeRadiusRatio: safeRadius };
}

/** 把标记帧编码成 dataURL 供预览红色叠加展示 */
export function markedFrameToDataURL(pixels: Uint8ClampedArray, size: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = new ImageData(pixels, size, size);
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}
