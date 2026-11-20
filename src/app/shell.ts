import { h } from '../lib/dom';
import { currentPath, navigate } from './router';

const NAV = [
  { path: '/library', label: '素材库', icon: '▦' },
  { path: '/canvas', label: '画布编排', icon: '◴' },
  { path: '/preview', label: '预览台', icon: '◉' },
  { path: '/export', label: '导出中心', icon: '⇩' },
  { path: '/devices', label: '设备设置', icon: '⚙' },
];

export function renderShell(content: HTMLElement): void {
  const app = document.getElementById('app')!;
  const path = currentPath();
  const nav = h(
    'nav',
    { class: 'side-nav' },
    h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, '◈'), h('div', { class: 'brand-text' }, 'POV Fan Studio', h('small', {}, '全息风扇编排预览'))),
    ...NAV.map((n) =>
      h(
        'button',
        {
          class: `nav-item ${path.startsWith(n.path) ? 'active' : ''}`,
          onclick: () => navigate(n.path),
        },
        h('span', { class: 'nav-icon' }, n.icon),
        n.label,
      ),
    ),
    h('div', { class: 'nav-foot' }, '本地处理 · 数据不出厂'),
  );
  app.replaceChildren(nav, h('main', { class: 'page-host' }, content));
}

export function pageHeader(title: string, desc: string, ...actions: HTMLElement[]): HTMLElement {
  return h('header', { class: 'page-header' }, h('div', {}, h('h1', {}, title), h('p', {}, desc)), h('div', { class: 'header-actions' }, ...actions));
}

export function emptyState(text: string): HTMLElement {
  return h('div', { class: 'empty-state' }, text);
}
