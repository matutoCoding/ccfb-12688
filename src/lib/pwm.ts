/**
 * 灯珠 PWM 占空比 -> 感知亮度 非线性校正。
 * 默认曲线模拟常见 LED 的 gamma≈2.2 响应；支持导入/导出实测校准表（CSV：duty,r,g,b）。
 */

export type CalibrationCurve = number[]; // 256 点，0..1

export function defaultPwmCurve(gamma = 2.2): CalibrationCurve {
  const c: number[] = new Array(256);
  for (let i = 0; i < 256; i++) c[i] = (i / 255) ** gamma;
  return c;
}

export function linearCurve(): CalibrationCurve {
  const c: number[] = new Array(256);
  for (let i = 0; i < 256; i++) c[i] = i / 255;
  return c;
}

/** 解析 CSV 校准表，表头可选：duty,r,g,b（duty 支持 0..1 或 0..255） */
export function parseCalibrationCsv(text: string): { r: CalibrationCurve; g: CalibrationCurve; b: CalibrationCurve } {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/[,\s]+/).map(Number));
  const numeric = rows.filter((r) => r.length >= 4 && r.every(Number.isFinite));
  if (numeric.length < 2) throw new Error('校准表至少需要 2 行数据（duty,r,g,b）');

  const dutyScale = Math.max(...numeric.map((r) => r[0])) > 1 ? 255 : 1;
  const build = (col: number): CalibrationCurve => {
    const xs = numeric.map((r) => r[0] / dutyScale);
    const ys = numeric.map((r) => Math.max(0, Math.min(1, r[col])));
    const out = new Array<number>(256);
    for (let i = 0; i < 256; i++) {
      const x = i / 255;
      out[i] = interp1d(xs, ys, x);
    }
    return out;
  };
  return { r: build(1), g: build(2), b: build(3) };
}

export function calibrationToCsv(curves: { r: CalibrationCurve; g: CalibrationCurve; b: CalibrationCurve }): string {
  const lines = ['# PWM calibration table, duty(0-255),r,g,b(0-1)'];
  for (let i = 0; i < 256; i++) {
    lines.push(`${i},${curves.r[i].toFixed(5)},${curves.g[i].toFixed(5)},${curves.b[i].toFixed(5)}`);
  }
  return lines.join('\n');
}

/** 单调锚点线性插值，越界取端点 */
export function interp1d(xs: number[], ys: number[], x: number): number {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  for (let i = 0; i < xs.length - 1; i++) {
    if (x >= xs[i] && x <= xs[i + 1]) {
      const t = (x - xs[i]) / (xs[i + 1] - xs[i] || 1);
      return ys[i] + (ys[i + 1] - ys[i]) * t;
    }
  }
  return ys[ys.length - 1];
}
