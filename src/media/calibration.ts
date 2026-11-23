// 实测 PWM 校准表导入：CSV，表头 duty,r,g,b（0..1 或 0..255 自动识别）
import type { CalibPoint, PwmCalib } from '../core/types';
import { clamp } from '../core/mathutil';
import { uid } from '../core/id';

export function parsePwmCsv(text: string, name: string): PwmCalib {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (lines.length < 2) throw new Error('校准表至少需要表头 + 一行数据');
  const header = lines[0].toLowerCase().split(/[,\t;]/).map((s) => s.trim());
  const idx = {
    duty: header.findIndex((h) => h.includes('duty') || h.includes('pwm')),
    r: header.findIndex((h) => h === 'r' || h.includes('red')),
    g: header.findIndex((h) => h === 'g' || h.includes('green')),
    b: header.findIndex((h) => h === 'b' || h.includes('blue')),
  };
  if (idx.duty < 0 || idx.r < 0 || idx.g < 0 || idx.b < 0) {
    throw new Error('表头需包含 duty,r,g,b 四列');
  }
  const rows = lines.slice(1).map((line) => line.split(/[,\t;]/).map((s) => parseFloat(s.trim())));
  const scaled = rows.some((r) => r.some((v) => v > 1.0001));
  const scale = scaled ? 255 : 1;
  const ptsR: CalibPoint[] = [];
  const ptsG: CalibPoint[] = [];
  const ptsB: CalibPoint[] = [];
  for (const row of rows) {
    if (row.some(isNaN)) continue;
    const duty = clamp(row[idx.duty] / scale, 0, 1);
    ptsR.push({ duty, luminance: clamp(row[idx.r] / scale, 0, 1) });
    ptsG.push({ duty, luminance: clamp(row[idx.g] / scale, 0, 1) });
    ptsB.push({ duty, luminance: clamp(row[idx.b] / scale, 0, 1) });
  }
  const sortByDuty = (a: CalibPoint, b: CalibPoint) => a.duty - b.duty;
  ptsR.sort(sortByDuty);
  ptsG.sort(sortByDuty);
  ptsB.sort(sortByDuty);
  if (ptsR.length < 2) throw new Error('有效数据行不足 2 行');
  return { id: uid('calib'), name, pointsR: ptsR, pointsG: ptsG, pointsB: ptsB, createdAt: Date.now() };
}

export function defaultLinearCalib(): PwmCalib {
  const lin: CalibPoint[] = [
    { duty: 0, luminance: 0 },
    { duty: 1, luminance: 1 },
  ];
  return {
    id: uid('calib'),
    name: '线性默认（未校准）',
    pointsR: lin.map((p) => ({ ...p })),
    pointsG: lin.map((p) => ({ ...p })),
    pointsB: lin.map((p) => ({ ...p })),
    createdAt: Date.now(),
  };
}
