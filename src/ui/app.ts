import { h, mount } from './dom';
import { store } from '../core/store';
import { renderLibraryPage } from './pages/libraryPage';
import { renderCanvasPage } from './pages/canvasPage';
import { renderPreviewPage } from './pages/previewPage';
import { renderExportPage } from './pages/exportPage';
import { renderDevicePage } from './pages/devicePage';

export type Route = 'library' | 'canvas' | 'preview' | 'export' | 'device';

const NAV: { route: Route; label: string }[] = [
  { route: 'library', label: '素材库' },
  { route: 'canvas', label: '画布编排' },
  { route: 'preview', label: '预览台' },
  { route: 'export', label: '导出中心' },
  { route: 'device', label: '设备设置' },
];

let current: Route = (location.hash.replace('#/', '') as Route) || 'library';

function navigate(route: Route): void {
  current = route;
  location.hash = `#/${route}`;
  render();
}

function render(): void {
  const top = h('div', { class: 'topbar' },
    h('div', { class: 'brand' }, 'HoloFan ', h('i', {}, 'Studio'), ' 全息风扇编排预览'),
    h('nav', { class: 'nav' },
      ...NAV.map((n) => h('button', {
        class: n.route === current ? 'active' : '',
        onclick: () => navigate(n.route),
      }, n.label))),
    h('span', { class: 'env-hint' }, '纯本地处理 · WebGL2 · IndexedDB · 素材不上传'),
  );
  const page = h('div', { class: 'page' });
  const root = h('div', { id: 'app-inner' }, top, page);
  mount(document.getElementById('app')!, root);

  const renderers: Record<Route, () => void> = {
    library: () => renderLibraryPage(page),
    canvas: () => renderCanvasPage(page),
    preview: () => renderPreviewPage(page),
    export: () => renderExportPage(page),
    device: () => renderDevicePage(page),
  };
  renderers[current]();
}

window.addEventListener('hashchange', () => {
  const r = location.hash.replace('#/', '') as Route;
  if (r && r !== current) {
    current = r;
    render();
  }
});

export function go(route: Route): void {
  navigate(route);
}

export async function boot(): Promise<void> {
  await store.load();
  if (!location.hash) location.hash = '#/library';
  render();
  // 任意状态变更后重渲染当前页（页面内部可自行做局部更新避免抖动）
  store.subscribe(() => {
    // 预览页由 rAF 自驱动，不随 store 重渲染，避免打断动画
    if (current !== 'preview') render();
  });
}
