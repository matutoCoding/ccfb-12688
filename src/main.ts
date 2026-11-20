import './styles.css';
import { startRouter, registerRoute, registerNotFound } from './app/router';
import { renderShell } from './app/shell';
import { store } from './lib/store';
import { builtinTemplates } from './lib/seed';
import { libraryPage } from './app/library-page';
import { canvasPage } from './app/canvas-page';
import { previewPage } from './app/preview-page';
import { exportPage } from './app/export-page';
import { devicesPage } from './app/devices-page';
import { toast } from './lib/dom';

async function bootstrap(): Promise<void> {
  await store.loadAll();

  // 首次启动写入内置行业模板（已存在则不动，用户可在模板基础上升级版本）
  if (store.templates.length === 0) {
    for (const tpl of builtinTemplates()) {
      await store.save('templates', tpl);
    }
  }

  const mountPage = (node: HTMLElement) => renderShell(node);

  registerRoute('/library', () => mountPage(libraryPage()));
  registerRoute('/canvas', () => mountPage(canvasPage()));
  registerRoute('/preview', () => mountPage(previewPage()));
  registerRoute('/export', () => mountPage(exportPage()));
  registerRoute('/devices', () => mountPage(devicesPage()));
  registerNotFound(() => mountPage(libraryPage()));

  startRouter();

  if (!window.WebGL2RenderingContext) {
    toast('当前浏览器不支持 WebGL2，预览台无法运行，请使用最新版 Chrome/Edge', 'error');
  }
}

bootstrap().catch((e) => {
  console.error(e);
  toast(`启动失败：${(e as Error).message}`, 'error');
});
