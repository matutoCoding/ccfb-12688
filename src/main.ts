import './ui/styles.css';
import { boot } from './ui/app';

boot().catch((err) => {
  const el = document.getElementById('app');
  if (el) el.innerHTML = `<pre style="color:#f87171;padding:24px;white-space:pre-wrap">启动失败：${(err as Error).stack || err}</pre>`;
});
