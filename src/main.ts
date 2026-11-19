/** 应用入口：hash 路由 + 页面生命周期管理 */

import './style.css';
import { CanvasPage } from './pages/canvas';
import { DevicesPage } from './pages/devices';
import { ExportPage } from './pages/export';
import { LibraryPage } from './pages/library';
import { PreviewPage } from './pages/preview';
import { store } from './store';

interface Page { el: HTMLElement; destroy(): void; }

const routes: Record<string, () => Page> = {
  library: () => new LibraryPage(),
  canvas: () => new CanvasPage(),
  preview: () => new PreviewPage(),
  export: () => new ExportPage(),
  devices: () => new DevicesPage(),
};

let current: Page | null = null;

function route(): void {
  const hash = location.hash.replace(/^#\//, '') || 'library';
  const name = routes[hash] ? hash : 'library';
  current?.destroy();
  current = routes[name]();
  const page = document.getElementById('page')!;
  page.replaceChildren(current.el);
  document.querySelectorAll('#nav a').forEach((a) => {
    a.classList.toggle('active', (a as HTMLElement).dataset.route === name);
  });
}

async function updateIndicator(): Promise<void> {
  const el = document.getElementById('project-indicator')!;
  const { getById } = await import('./db');
  const p = store.currentProjectId ? await getById<{ name: string }>('projects', store.currentProjectId) : null;
  el.textContent = p ? `当前工程：${p.name}` : '未选择工程';
}

async function main(): Promise<void> {
  await store.load();
  window.addEventListener('hashchange', route);
  store.on('project', () => void updateIndicator());
  await updateIndicator();
  route();
}

void main();
