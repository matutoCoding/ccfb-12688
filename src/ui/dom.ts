// 极简 DOM 构建辅助，保持零框架依赖、全部本地运行
export type Child = Node | string | false | null | undefined;
type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
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
  const flat = children.flat();
  for (const child of flat) {
    if (child === false || child === null || child === undefined) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el: HTMLElement): void {
  el.replaceChildren();
}

export function mount(el: HTMLElement, node: Node): void {
  el.replaceChildren(node);
}

export function slider(opts: {
  min: number;
  max: number;
  step?: number;
  value: number;
  onInput: (v: number) => void;
  label?: string;
  format?: (v: number) => string;
}): HTMLElement {
  const wrap = h('div', { class: 'slider-row' });
  const out = h('span', { class: 'slider-val' }, opts.format ? opts.format(opts.value) : String(opts.value));
  const input = h('input', {
    type: 'range',
    min: opts.min,
    max: opts.max,
    step: opts.step ?? 1,
    value: opts.value,
    oninput: () => {
      const v = parseFloat((input as HTMLInputElement).value);
      opts.onInput(v);
      out.textContent = opts.format ? opts.format(v) : String(v);
    },
  }) as HTMLInputElement;
  if (opts.label) wrap.append(h('label', { class: 'slider-label' }, opts.label));
  wrap.append(input, out);
  return wrap;
}

export function numberField(label: string, value: number, onInput: (v: number) => void, step = 1): HTMLElement {
  const wrap = h('label', { class: 'field' }, h('span', {}, label),
    h('input', {
      type: 'number',
      value,
      step,
      oninput: (e: Event) => onInput(parseFloat((e.target as HTMLInputElement).value) || 0),
    }));
  return wrap;
}

export function textField(label: string, value: string, onInput: (v: string) => void, placeholder = ''): HTMLElement {
  return h('label', { class: 'field' }, h('span', {}, label),
    h('input', { type: 'text', value, placeholder, oninput: (e: Event) => onInput((e.target as HTMLInputElement).value) }));
}

export function selectField(label: string, options: { value: string; text: string }[], value: string, onChange: (v: string) => void): HTMLElement {
  const sel = h('select', { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
    ...options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.text)));
  return h('label', { class: 'field' }, h('span', {}, label), sel);
}

export function button(text: string, onClick: () => void, kind: 'primary' | 'ghost' | 'danger' = 'ghost'): HTMLButtonElement {
  return h('button', { class: `btn btn-${kind}`, onclick: onClick }, text);
}

export function toast(msg: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
  const el = h('div', { class: `toast toast-${kind}` }, msg);
  document.getElementById('toast-layer')?.append(el);
  setTimeout(() => {
    el.classList.add('fade');
    setTimeout(() => el.remove(), 400);
  }, 2600);
}

export function modal(title: string, content: Node, footer?: Node): { close: () => void; root: HTMLElement } {
  const root = h('div', { class: 'modal-mask' });
  const box = h('div', { class: 'modal-box' },
    h('div', { class: 'modal-head' }, h('strong', {}, title), h('button', { class: 'btn btn-ghost', onclick: () => root.remove() }, '×')),
    h('div', { class: 'modal-body' }, content),
  );
  if (footer) box.append(h('div', { class: 'modal-foot' }, footer));
  root.append(box);
  root.addEventListener('click', (e) => {
    if (e.target === root) root.remove();
  });
  document.getElementById('modal-layer')?.append(root);
  return { close: () => root.remove(), root };
}

export function stars(value: number, onPick?: (v: number) => void): HTMLElement {
  const wrap = h('span', { class: 'stars' });
  for (let i = 1; i <= 5; i++) {
    const s = h('span', { class: i <= value ? 'star on' : 'star' }, '★');
    if (onPick) s.addEventListener('click', () => onPick(i === value ? 0 : i));
    wrap.append(s);
  }
  return wrap;
}
