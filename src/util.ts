/** 通用小工具：CRC32、文件下载、格式化、DOM 构造 */

export function crc32(data: Uint8Array): number {
  let table = (crc32 as any)._table as Uint32Array | undefined;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    (crc32 as any)._table = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function downloadText(text: string, filename: string, mime = 'text/plain'): void {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}

export function pickFile(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    // 用户取消时也能 resolve，避免悬挂
    window.addEventListener('focus', () => setTimeout(() => { if (!input.files?.length) resolve([]); }, 400), { once: true });
    input.click();
  });
}

export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

export function fmtDuration(sec: number): string {
  if (sec >= 3600) return `${(sec / 3600).toFixed(1)} h`;
  if (sec >= 60) return `${(sec / 60).toFixed(1)} min`;
  return `${sec.toFixed(1)} s`;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 单调折线插值（用于 PWM / 照度曲线） */
export function interpCurve(points: { x: number; y: number }[], x: number): number {
  if (!points.length) return x;
  const pts = [...points].sort((a, b) => a.x - b.x);
  if (x <= pts[0].x) return pts[0].y;
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  for (let i = 0; i < pts.length - 1; i++) {
    if (x >= pts[i].x && x <= pts[i + 1].x) {
      const t = (x - pts[i].x) / (pts[i + 1].x - pts[i].x || 1);
      return lerp(pts[i].y, pts[i + 1].y, t);
    }
  }
  return pts[pts.length - 1].y;
}

export function modal(content: HTMLElement, onClose?: () => void): { close: () => void } {
  const mask = el('div', { class: 'modal-mask' });
  const box = el('div', { class: 'modal' });
  box.append(content);
  mask.append(box);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  const close = () => { mask.remove(); onClose?.(); };
  document.body.append(mask);
  return { close };
}
