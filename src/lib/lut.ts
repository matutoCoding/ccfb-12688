/**
 * 第三方 LUT（.cube / Adobe Cube LUT）解析与 CPU 套用。
 * 预览链路在 2D 合成阶段逐像素查表，保证库内预览与上机画面走同一套调色。
 */
import type { LutData } from '../types';
import { uid } from './dom';

export function parseCubeLut(text: string, name: string): LutData {
  const lines = text.split(/\r?\n/);
  let size = 0;
  const domainMin = [0, 0, 0];
  const domainMax = [1, 1, 1];
  const data: number[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith('LUT_3D_SIZE')) {
      size = parseInt(line.split(/\s+/)[1], 10);
    } else if (upper.startsWith('LUT_3D_INPUT_MIN')) {
      const p = line.split(/\s+/).slice(1).map(Number);
      p.forEach((v, i) => (domainMin[i] = v));
    } else if (upper.startsWith('LUT_3D_INPUT_MAX')) {
      const p = line.split(/\s+/).slice(1).map(Number);
      p.forEach((v, i) => (domainMax[i] = v));
    } else if (upper.startsWith('LUT_1D_SIZE') || upper.startsWith('TITLE') || upper.startsWith('DOMAIN_')) {
      // 1D LUT 与元数据暂不支持/忽略
      continue;
    } else {
      const parts = line.split(/\s+/).map(Number);
      if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
        data.push(...parts);
      }
    }
  }

  if (!size || data.length !== size * size * size * 3) {
    throw new Error(`LUT 解析失败：期望 ${size ? size ** 3 * 3 : 0} 个分量，实际 ${data.length}`);
  }

  // .cube 存储顺序为 r 最慢、b 最快，转换为 r*s^2 + g*s + b
  const table = new Float32Array(size ** 3 * 3);
  let src = 0;
  for (let r = 0; r < size; r++) {
    for (let g = 0; g < size; g++) {
      for (let b = 0; b < size; b++) {
        const dst = (r * size * size + g * size + b) * 3;
        table[dst] = domainMin[0] + data[src] * (domainMax[0] - domainMin[0]);
        table[dst + 1] = domainMin[1] + data[src + 1] * (domainMax[1] - domainMin[1]);
        table[dst + 2] = domainMin[2] + data[src + 2] * (domainMax[2] - domainMin[2]);
        src += 3;
      }
    }
  }

  return { id: uid('lut'), name, size, table, importedAt: Date.now() };
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 三线性插值查 3D LUT，输入输出均为 0..255 的 RGBA ImageData */
export function applyLut(
  image: ImageData,
  lut: LutData,
  strength = 1,
  exposure = 0,
  saturation = 1,
): ImageData {
  const { data, width, height } = image;
  const n = lut.size;
  const max = n - 1;
  const ev = 2 ** exposure;
  const out = new Uint8ClampedArray(data.length);

  for (let i = 0; i < data.length; i += 4) {
    let r = (data[i] / 255) * ev;
    let g = (data[i + 1] / 255) * ev;
    let b = (data[i + 2] / 255) * ev;

    if (saturation !== 1) {
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = luma + (r - luma) * saturation;
      g = luma + (g - luma) * saturation;
      b = luma + (b - luma) * saturation;
    }

    const rf = Math.max(0, Math.min(max, r * max));
    const gf = Math.max(0, Math.min(max, g * max));
    const bf = Math.max(0, Math.min(max, b * max));
    const r0 = Math.floor(rf), g0 = Math.floor(gf), b0 = Math.floor(bf);
    const r1 = Math.min(max, r0 + 1), g1 = Math.min(max, g0 + 1), b1 = Math.min(max, b0 + 1);
    const tr = smoothstep(rf - r0), tg = smoothstep(gf - g0), tb = smoothstep(bf - b0);

    const idx = (x: number, y: number, z: number) => (x * n * n + y * n + z) * 3;
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

    // 沿 b 插值
    const c00 = lerp(lut.table[idx(r0, g0, b0)], lut.table[idx(r0, g0, b1)], tb);
    const c01 = lerp(lut.table[idx(r0, g1, b0)], lut.table[idx(r0, g1, b1)], tb);
    const c10 = lerp(lut.table[idx(r1, g0, b0)], lut.table[idx(r1, g0, b1)], tb);
    const c11 = lerp(lut.table[idx(r1, g1, b0)], lut.table[idx(r1, g1, b1)], tb);
    const c0 = lerp(c00, c01, tg);
    const c1 = lerp(c10, c11, tg);
    const lr = lerp(c0, c1, tr);
    // 三通道分别处理（上面只算 R 索引偏移，G/B 同位置 +1/+2）
    const sample = (off: number): number => {
      const v00 = lerp(lut.table[idx(r0, g0, b0) + off], lut.table[idx(r0, g0, b1) + off], tb);
      const v01 = lerp(lut.table[idx(r0, g1, b0) + off], lut.table[idx(r0, g1, b1) + off], tb);
      const v10 = lerp(lut.table[idx(r1, g0, b0) + off], lut.table[idx(r1, g0, b1) + off], tb);
      const v11 = lerp(lut.table[idx(r1, g1, b0) + off], lut.table[idx(r1, g1, b1) + off], tb);
      return lerp(lerp(v00, v01, tg), lerp(v10, v11, tg), tr);
    };
    const lg = sample(1);
    const lb = sample(2);

    out[i] = (lerp(r, lr, strength) * 255) | 0;
    out[i + 1] = (lerp(g, lg, strength) * 255) | 0;
    out[i + 2] = (lerp(b, lb, strength) * 255) | 0;
    out[i + 3] = data[i + 3];
  }
  return new ImageData(out, width, height);
}

/** 生成一个简易示例 .cube（线性恒等，用于导出测试） */
export function identityCubeText(size = 17): string {
  const lines = [`LUT_3D_SIZE ${size}`, '# POV Fan Studio identity LUT'];
  for (let r = 0; r < size; r++) {
    for (let g = 0; g < size; g++) {
      for (let b = 0; b < size; b++) {
        lines.push(`${(r / (size - 1)).toFixed(6)} ${(g / (size - 1)).toFixed(6)} ${(b / (size - 1)).toFixed(6)}`);
      }
    }
  }
  return lines.join('\n');
}
