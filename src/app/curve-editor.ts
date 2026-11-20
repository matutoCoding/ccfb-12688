import { h, toast } from '../lib/dom';
import type { AmbientAnchor } from '../lib/ambient';
import { brightnessAtLux, removeAnchor, upsertAnchor } from '../lib/ambient';

/**
 * 照度->亮度锚点曲线编辑器（canvas 拖拽）。
 * 点击空白加锚点，拖动圆点改值，双击删点（保留至少两个）。
 */
export function curveEditor(curve: AmbientAnchor[], onChange: (next: AmbientAnchor[]) => void): HTMLElement {
  const W = 460, H = 220, PAD = 34;
  const canvas = h('canvas', { width: String(W), height: String(H), class: 'curve-editor' }) as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  let local = curve.map((a) => ({ ...a }));
  let dragIdx = -1;

  const maxLux = () => Math.max(2000, ...local.map((a) => a.lux)) * 1.05;

  const toX = (lux: number) => PAD + (lux / maxLux()) * (W - PAD * 2);
  const toY = (b: number) => H - PAD - b * (H - PAD * 2);
  const toLux = (x: number) => Math.max(0, ((x - PAD) / (W - PAD * 2)) * maxLux());
  const toB = (y: number) => Math.max(0.02, Math.min(1, 1 - (y - PAD) / (H - PAD * 2)));

  function paint(): void {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0e1116';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#232c39';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const x = PAD + (i / 4) * (W - PAD * 2);
      const y = PAD + (i / 4) * (H - PAD * 2);
      ctx.beginPath(); ctx.moveTo(x, PAD); ctx.lineTo(x, H - PAD); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
    }
    ctx.fillStyle = '#8a97a8';
    ctx.font = '10px sans-serif';
    ctx.fillText('lux', W - 24, H - PAD + 16);
    ctx.fillText('亮度', 6, PAD - 6);

    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    local.forEach((a, i) => {
      const x = toX(a.lux), y = toY(a.brightness);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    for (const a of local) {
      const x = toX(a.lux), y = toY(a.brightness);
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#22d3ee';
      ctx.fill();
      ctx.strokeStyle = '#0c2a3a';
      ctx.stroke();
      ctx.fillStyle = '#8a97a8';
      ctx.fillText(`${a.lux.toFixed(0)}`, x - 12, H - PAD + 14);
    }
  }

  function hit(ev: PointerEvent): number {
    const rect = canvas.getBoundingClientRect();
    const mx = ((ev.clientX - rect.left) / rect.width) * W;
    const my = ((ev.clientY - rect.top) / rect.height) * H;
    return local.findIndex((a) => Math.hypot(mx - toX(a.lux), my - toY(a.brightness)) < 10);
  }

  canvas.addEventListener('pointerdown', (ev) => {
    const idx = hit(ev);
    if (idx >= 0) {
      dragIdx = idx;
      canvas.setPointerCapture(ev.pointerId);
    } else {
      const rect = canvas.getBoundingClientRect();
      const mx = ((ev.clientX - rect.left) / rect.width) * W;
      const my = ((ev.clientY - rect.top) / rect.height) * H;
      local = upsertAnchor(local, { lux: toLux(mx), brightness: toB(my) });
      onChange(local);
      paint();
    }
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (dragIdx < 0) return;
    const rect = canvas.getBoundingClientRect();
    const mx = ((ev.clientX - rect.left) / rect.width) * W;
    const my = ((ev.clientY - rect.top) / rect.height) * H;
    local[dragIdx] = { lux: toLux(mx), brightness: toB(my) };
    local.sort((a, b) => a.lux - b.lux);
    dragIdx = local.findIndex((a) => a === local[dragIdx]);
    paint();
  });
  canvas.addEventListener('pointerup', () => {
    if (dragIdx >= 0) {
      onChange(local);
      dragIdx = -1;
    }
  });
  canvas.addEventListener('dblclick', (ev: MouseEvent) => {
    const idx = hit(ev as unknown as PointerEvent);
    if (idx >= 0) {
      const target = local[idx];
      local = removeAnchor(local, target.lux);
      onChange(local);
      paint();
    }
  });

  const wrap = h('div', {},
    canvas,
    h('div', { class: 'sub muted', style: 'margin-top:6px' }, '点击空白添加锚点 · 拖动编辑 · 双击删除（至少保留 2 个）'),
    h('div', { class: 'pill-group', style: 'margin-top:8px' },
      h('button', {
        onclick: () => {
          const lux = Number(prompt('查询照度(lux)：', '500'));
          if (Number.isFinite(lux)) toast(`照度 ${lux} lux → 输出亮度 ${(brightnessAtLux(local, lux) * 100).toFixed(1)}%`);
        },
      }, '查询映射值'),
    ),
  );
  queueMicrotask(paint);
  return wrap;
}
