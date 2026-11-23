// Adobe .cube 3D LUT 解析（第三方调色预设导入）
import type { LUTFile } from '../core/types';
import { uid } from '../core/id';

export function parseCubeLut(text: string, name: string): LUTFile {
  const lines = text.split(/\r?\n/);
  let gridSize = 0;
  const domainMin: [number, number, number] = [0, 0, 0];
  const domainMax: [number, number, number] = [1, 1, 1];
  const title = name.replace(/\.cube$/i, '');
  const values: number[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/);
    const keyword = tokens[0].toUpperCase();
    if (keyword === 'TITLE') continue;
    if (keyword === 'LUT_3D_SIZE') {
      gridSize = parseInt(tokens[1], 10);
      continue;
    }
    if (keyword === 'LUT_1D_SIZE') {
      throw new Error('暂不支持 1D LUT，请提供 3D .cube 文件');
    }
    if (keyword === 'DOMAIN_MIN') {
      domainMin[0] = parseFloat(tokens[1]);
      domainMin[1] = parseFloat(tokens[2]);
      domainMin[2] = parseFloat(tokens[3]);
      continue;
    }
    if (keyword === 'DOMAIN_MAX') {
      domainMax[0] = parseFloat(tokens[1]);
      domainMax[1] = parseFloat(tokens[2]);
      domainMax[2] = parseFloat(tokens[3]);
      continue;
    }
    if (tokens.length >= 3 && tokens.every((t) => !isNaN(parseFloat(t)))) {
      values.push(parseFloat(tokens[0]), parseFloat(tokens[1]), parseFloat(tokens[2]));
    }
  }

  if (!gridSize || gridSize < 2 || gridSize > 64) {
    throw new Error('LUT_3D_SIZE 缺失或超出 2..64 范围');
  }
  const expected = gridSize ** 3 * 3;
  if (values.length !== expected) {
    throw new Error(`LUT 数据点数不匹配：期望 ${expected / 3} 个，实际 ${values.length / 3} 个`);
  }
  return {
    id: uid('lut'),
    name,
    title,
    gridSize,
    domainMin,
    domainMax,
    data: new Float32Array(values),
    createdAt: Date.now(),
  };
}

/** 序列化成 .cube 文本（导出/备份用） */
export function serializeCubeLut(lut: LUTFile): string {
  const lines: string[] = [
    `TITLE "${lut.title}"`,
    `LUT_3D_SIZE ${lut.gridSize}`,
    `DOMAIN_MIN ${lut.domainMin.join(' ')}`,
    `DOMAIN_MAX ${lut.domainMax.join(' ')}`,
    '',
  ];
  const n = lut.gridSize ** 3;
  for (let i = 0; i < n; i++) {
    lines.push(`${lut.data[i * 3].toFixed(6)} ${lut.data[i * 3 + 1].toFixed(6)} ${lut.data[i * 3 + 2].toFixed(6)}`);
  }
  return lines.join('\n');
}
