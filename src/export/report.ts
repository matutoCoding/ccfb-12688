// 上播验收报告：自包含 HTML（内嵌数据与分布图，无外部依赖），可直接交付客户
import type { MaterialStat } from './playlog';
import type { PlayLogEntry } from '../core/types';

export interface ReportData {
  title: string;
  generatedAt: string;
  deviceSerials: string[];
  stats: MaterialStat[];
  abnormal: PlayLogEntry[];
  totalPlays: number;
  totalDurationSec: number;
  logSourceName: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function fmtDur(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h${String(m).padStart(2, '0')}m`;
}

function barChartSvg(stats: MaterialStat[]): string {
  const w = 720;
  const rowH = 34;
  const h = stats.length * rowH + 40;
  const max = Math.max(1, ...stats.map((s) => s.playCount));
  const rows = stats
    .map((s, i) => {
      const y = i * rowH + 26;
      const bw = (s.playCount / max) * (w - 260);
      return `
      <g>
        <text x="8" y="${y - 8}" font-size="12" fill="#c9d4e5">${esc(s.materialCode)}</text>
        <rect x="150" y="${y - 16}" width="${bw.toFixed(1)}" height="18" rx="4" fill="url(#g)"/>
        <text x="${(158 + bw).toFixed(1)}" y="${y - 3}" font-size="12" fill="#9fb4cc">${s.playCount} 次 · ${fmtDur(s.totalDurationSec)} · ${Math.round(s.avgRpm)} rpm</text>
      </g>`;
    })
    .join('');
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" x2="1">
      <stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#22d3ee"/>
    </linearGradient></defs>${rows}</svg>`;
}

export function buildAcceptanceReport(data: ReportData): string {
  const abnormalRows = data.abnormal
    .map(
      (e) => `<tr>
      <td>${esc(e.deviceSerial)}</td><td class="warn">${esc(e.materialCode)}</td>
      <td>${new Date(e.startUnix * 1000).toLocaleString()}</td>
      <td>${new Date(e.endUnix * 1000).toLocaleString()}</td>
      <td>${Math.round(e.measuredRpm)}</td></tr>`,
    )
    .join('');
  const statRows = data.stats
    .map(
      (s) => `<tr>
      <td>${esc(s.materialCode)}</td><td>${s.playCount}</td>
      <td>${fmtDur(s.totalDurationSec)}</td><td>${Math.round(s.avgRpm)}</td>
      <td>${s.devices.map(esc).join(', ')}</td></tr>`,
    )
    .join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(data.title)}</title>
<style>
  body{font-family:"Microsoft YaHei",system-ui,sans-serif;background:#0b1220;color:#e6edf7;margin:0;padding:32px;}
  .card{background:#111c2e;border:1px solid #1f3049;border-radius:12px;padding:24px;margin-bottom:20px;}
  h1{margin:0 0 6px;font-size:24px} h2{font-size:17px;margin:0 0 14px;color:#9fb4cc}
  table{border-collapse:collapse;width:100%;font-size:13px} th,td{padding:8px 10px;border-bottom:1px solid #1f3049;text-align:left}
  th{color:#7e93ad;font-weight:600} .warn{color:#f87171;font-weight:700}
  .kpi{display:inline-block;margin-right:32px} .kpi b{font-size:26px;color:#38bdf8;display:block}
  .muted{color:#7e93ad;font-size:12px}
</style></head><body>
<h1>${esc(data.title)}</h1>
<p class="muted">生成时间 ${esc(data.generatedAt)} · 日志来源 ${esc(data.logSourceName)} · 设备 ${data.deviceSerials.map(esc).join('、') || '—'}</p>
<div class="card">
  <span class="kpi"><b>${data.totalPlays}</b>上播总次数</span>
  <span class="kpi"><b>${fmtDur(data.totalDurationSec)}</b>累计上播时长</span>
  <span class="kpi"><b>${data.stats.length}</b>素材种类</span>
  <span class="kpi"><b class="warn" style="color:#f87171">${data.abnormal.length}</b>异常记录</span>
</div>
<div class="card"><h2>上播次数 / 累计时长分布</h2>${barChartSvg(data.stats)}</div>
<div class="card"><h2>素材统计明细</h2>
<table><thead><tr><th>素材编号</th><th>上播次数</th><th>累计时长</th><th>平均转速</th><th>设备</th></tr></thead>
<tbody>${statRows || '<tr><td colspan="5" class="muted">无数据</td></tr>'}</tbody></table></div>
<div class="card"><h2>异常记录（工程中不存在的素材编号）</h2>
<table><thead><tr><th>设备</th><th>素材编号</th><th>开始</th><th>结束</th><th>实测转速</th></tr></thead>
<tbody>${abnormalRows || '<tr><td colspan="5" class="muted">无异常</td></tr>'}</tbody></table></div>
<p class="muted">本报告由 HoloFan Studio 在浏览器本地生成，数据未离开本机。</p>
</body></html>`;
}
