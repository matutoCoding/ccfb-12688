/** 第三方 .cube LUT 解析 → 3D 纹理数据；附带 CPU 侧采样（用于缩略图对比） */

export interface LutData {
  size: number;            // 边长 n
  data: Float32Array;      // n*n*n*3，R 变化最快（.cube 标准顺序）
  title: string;
}

export function parseCube(text: string): LutData {
  let size = 0;
  let title = '';
  const values: number[] = [];
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith('TITLE')) {
      title = line.slice(5).trim().replace(/^"|"$/g, '');
    } else if (upper.startsWith('LUT_3D_SIZE')) {
      size = parseInt(line.split(/\s+/)[1], 10);
    } else if (upper.startsWith('LUT_1D_SIZE')) {
      throw new Error('暂不支持 1D LUT，请使用 3D LUT (.cube LUT_3D_SIZE)');
    } else if (upper.startsWith('DOMAIN_MIN')) {
      domainMin = line.split(/\s+/).slice(1).map(Number);
    } else if (upper.startsWith('DOMAIN_MAX')) {
      domainMax = line.split(/\s+/).slice(1).map(Number);
    } else if (/^[+-]?[\d.]/.test(line)) {
      const parts = line.split(/\s+/).map(Number);
      if (parts.length >= 3 && parts.slice(0, 3).every((v) => isFinite(v))) {
        values.push(parts[0], parts[1], parts[2]);
      }
    }
  }

  if (!size) throw new Error('未找到 LUT_3D_SIZE 声明');
  const expected = size * size * size * 3;
  if (values.length < expected) {
    throw new Error(`LUT 数据不完整：期望 ${expected} 个数值，实际 ${values.length}`);
  }
  const data = new Float32Array(expected);
  const scale = domainMax.map((v, i) => 1 / (v - domainMin[i] || 1));
  for (let i = 0; i < expected; i++) {
    const c = i % 3;
    data[i] = (values[i] - domainMin[c]) * scale[c];
  }
  return { size, data, title: title || '未命名 LUT' };
}

/** CPU 三线性采样，用于素材库缩略图实时预览 */
export function sampleLut(lut: LutData, r: number, g: number, b: number, out: [number, number, number]): void {
  const n = lut.size;
  const d = lut.data;
  const coords = [r, g, b].map((v) => Math.min(Math.max(v, 0), 1) * (n - 1));
  // .cube 内存顺序：R 最快，然后 G，然后 B → index = b*n*n + g*n + r
  const [ri, gi, bi] = coords.map((v) => Math.floor(v));
  const [rf, gf, bf] = coords.map((v, i) => v - Math.floor(v));
  const r1 = Math.min(ri + 1, n - 1), g1 = Math.min(gi + 1, n - 1), b1 = Math.min(bi + 1, n - 1);
  const at = (rr: number, gg: number, bb: number, c: number) => d[(bb * n * n + gg * n + rr) * 3 + c];
  for (let c = 0; c < 3; c++) {
    const c00 = at(ri, gi, bi, c) + (at(r1, gi, bi, c) - at(ri, gi, bi, c)) * rf;
    const c10 = at(ri, g1, bi, c) + (at(r1, g1, bi, c) - at(ri, g1, bi, c)) * rf;
    const c01 = at(ri, gi, b1, c) + (at(r1, gi, b1, c) - at(ri, gi, b1, c)) * rf;
    const c11 = at(ri, g1, b1, c) + (at(r1, g1, b1, c) - at(ri, g1, b1, c)) * rf;
    const c0 = c00 + (c10 - c00) * gf;
    const c1 = c01 + (c11 - c01) * gf;
    out[c] = c0 + (c1 - c0) * bf;
  }
}

/** float32 → float16（WebGL2 半浮点 3D 纹理，线性过滤为核心特性） */
export function floatToHalf(v: number): number {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = v;
  const x = u32[0];
  const sign = (x >> 16) & 0x8000;
  let exp = ((x >> 23) & 0xff) - 112;
  let mant = x & 0x7fffff;
  if (exp <= 0) return sign;            // 下溢 → 0（LUT 值域 0..1，足够）
  if (exp >= 31) return sign | 0x7bff;  // 上溢 → 截到最大 half
  return sign | (exp << 10) | (mant >> 13);
}

export function lutToHalfData(lut: LutData): Uint16Array {
  const n = lut.size;
  const out = new Uint16Array(n * n * n * 4);
  for (let i = 0; i < n * n * n; i++) {
    out[i * 4] = floatToHalf(lut.data[i * 3]);
    out[i * 4 + 1] = floatToHalf(lut.data[i * 3 + 1]);
    out[i * 4 + 2] = floatToHalf(lut.data[i * 3 + 2]);
    out[i * 4 + 3] = floatToHalf(1);
  }
  return out;
}
