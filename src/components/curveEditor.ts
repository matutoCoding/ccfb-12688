/** 可拖拽锚点曲线编辑器：PWM 校正曲线、照度→亮度映射共用 */

import { clamp } from '../util';

export interface CurvePoint { x: number; y: number; }

export interface CurveEditorOptions {
  width?: number;
  height?: number;
  xMin: number;
  xMax: number;
  xLog?: boolean;          // 照度用对数轴
  xLabel?: string;
  yLabel?: string;
  points: CurvePoint[];
  onChange: (points: CurvePoint[]) => void;
}

export interface CurveEditorHandle {
  el: HTMLElement;
  getPoints: () => CurvePoint[];
  setPoints: (p: CurvePoint[]) => void;
  destroy: () => void;
}

export function createCurveEditor(opts: CurveEditorOptions): CurveEditorHandle {
  const W = opts.width ?? 320;
  const H = opts.height ?? 180;
  const PAD = 28;
  let points = [...opts.points].sort((a, b) => a.x - b.x);

  const wrap = document.createElement('div');
  wrap.className = 'curve-editor';
  const canvas = document.createElement('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  wrap.append(canvas);
  const ctx = canvas.getContext('2d')!;

  const toX = (v: number) => {
    const t = opts.xLog
      ? (Math.log10(Math.max(v, 0.01)) - Math.log10(Math.max(opts.xMin, 0.01))) /
        (Math.log10(opts.xMax) - Math.log10(Math.max(opts.xMin, 0.01)))
      : (v - opts.xMin) / (opts.xMax - opts.xMin);
    return PAD + clamp(t, 0, 1) * (W - PAD * 2);
  };
  const fromX = (px: number) => {
    const t = clamp((px - PAD) / (W - PAD * 2), 0, 1);
    return opts.xLog
      ? Math.pow(10, Math.log10(Math.max(opts.xMin, 0.01)) + t * (Math.log10(opts.xMax) - Math.log10(Math.max(opts.xMin, 0.01))))
      : opts.xMin + t * (opts.xMax - opts.xMin);
  };
  const toY = (v: number) => H - PAD - clamp(v, 0, 1) * (H - PAD * 2);
  const fromY = (py: number) => clamp((H - PAD - py) / (H - PAD * 2), 0, 1);

  let dragIdx = -1;

  function draw(): void {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // 网格
    ctx.strokeStyle = 'rgba(255,255,255,.07)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = PAD + ((H - PAD * 2) * i) / 4;
      ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
    }
    // 轴标签
    ctx.fillStyle = '#8b96a6';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(opts.yLabel ?? '输出', 2, PAD - 8);
    ctx.textAlign = 'right';
    ctx.fillText(opts.xLabel ?? '输入', W - 4, H - 8);
    // 曲线
    ctx.strokeStyle = '#35c4ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const sorted = [...points].sort((a, b) => a.x - b.x);
    sorted.forEach((p, i) => {
      const x = toX(p.x), y = toY(p.y);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    // 锚点
    for (const p of sorted) {
      ctx.beginPath();
      ctx.arc(toX(p.x), toY(p.y), 5, 0, Math.PI * 2);
      ctx.fillStyle = '#0e1116';
      ctx.fill();
      ctx.strokeStyle = '#35c4ff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  function hit(px: number, py: number): number {
    let best = -1, bestD = 12;
    points.forEach((p, i) => {
      const d = Math.hypot(toX(p.x) - px, toY(p.y) - py);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  function posOf(e: MouseEvent): [number, number] {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  canvas.addEventListener('mousedown', (e) => {
    const [px, py] = posOf(e);
    dragIdx = hit(px, py);
    if (dragIdx < 0) {
      // 空白处按下 = 添加锚点
      points.push({ x: fromX(px), y: fromY(py) });
      points.sort((a, b) => a.x - b.x);
      dragIdx = points.findIndex((p) => p.x === fromX(px));
      opts.onChange([...points]);
      draw();
    }
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (dragIdx < 0) return;
    const [px, py] = posOf(e);
    const dragged = points[dragIdx];
    dragged.x = fromX(px);
    dragged.y = fromY(py);
    points.sort((a, b) => a.x - b.x);
    dragIdx = points.indexOf(dragged); // 排序后按引用找回
    opts.onChange([...points]);
    draw();
  });
  window.addEventListener('mouseup', () => { dragIdx = -1; });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const [px, py] = posOf(e);
    const i = hit(px, py);
    if (i >= 0 && points.length > 2) {
      points.splice(i, 1);
      opts.onChange([...points]);
      draw();
    }
  });

  draw();
  return {
    el: wrap,
    getPoints: () => [...points],
    setPoints: (p) => { points = [...p].sort((a, b) => a.x - b.x); draw(); },
    destroy: () => { wrap.remove(); },
  };
}
