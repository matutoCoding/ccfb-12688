/** 极简 DOM 构造辅助，避免引入框架 */
export type ElAttrs = Record<string, string | number | boolean | undefined | EventListener>;
export type HChild = Node | string | null | undefined | false | HChild[];

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: ElAttrs = {},
  ...children: HChild[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      el.className = String(v);
    } else if (k === 'dataset') {
      Object.assign(el.dataset, v);
    } else {
      el.setAttribute(k, String(v));
    }
  }
  const append = (c: HChild): void => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) {
      c.forEach(append);
      return;
    }
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(append);
  return el;
}

export function clear(el: HTMLElement): HTMLElement {
  el.replaceChildren();
  return el;
}

export function mount(host: HTMLElement, node: Node): void {
  host.replaceChildren(node);
}

/** 文件下载（所有产出物均以本地 Blob 生成，不上传） */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function readFileAsText(file: File): Promise<string> {
  return file.text();
}

export function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer();
}

export function uid(prefix = 'id'): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function toast(msg: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
  const box = document.getElementById('toast-root') ?? makeToastRoot();
  const item = h('div', { class: `toast toast-${kind}` }, msg);
  box.appendChild(item);
  setTimeout(() => {
    item.classList.add('toast-fade');
    setTimeout(() => item.remove(), 350);
  }, 3200);
}

function makeToastRoot(): HTMLElement {
  const box = h('div', { id: 'toast-root', class: 'toast-root' });
  document.body.appendChild(box);
  return box;
}
