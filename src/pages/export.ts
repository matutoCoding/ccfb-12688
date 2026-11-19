/**
 * 导出中心（功能点 7、8）：
 * - 生成控制板固件二进制数据包：逐帧极坐标采样（分区×灯珠×RGB），
 *   自动套用设备白平衡与 PWM 校正，整包附 CRC32
 * - 打包前扫描每帧像素是否越过扇叶安全半径，越界帧号列出
 * - 解析设备 U 盘日志：按素材统计上播次数/累计时长，分布图，
 *   工程外素材编号标为异常记录，汇总生成上播验收报告（HTML 交付客户）
 */

import { Compositor } from '../compositor';
import { getAll, getById } from '../db';
import { store } from '../store';
import { Clip, DeviceProfile, PlayRecord, Project } from '../types';
import { crc32, downloadBlob, downloadText, el, fmtDuration, pickFile } from '../util';

interface ScanResult { frame: number; maxRadius: number; }

export class ExportPage {
  el = el('div', { class: 'stack' });
  private devices: DeviceProfile[] = [];
  private projects: Project[] = [];
  private clips: Clip[] = [];
  private records: PlayRecord[] = [];
  private exportPanel = el('div');
  private logPanel = el('div');
  private progressEl = el('div', { class: 'mono dim' });

  constructor() {
    this.el.append(this.exportPanel, this.logPanel);
    void this.reload();
  }

  private async reload(): Promise<void> {
    this.devices = await getAll<DeviceProfile>('devices');
    this.projects = await getAll<Project>('projects');
    this.clips = await getAll<Clip>('clips');
    this.renderExport();
    this.renderLog();
  }

  // ================= 功能点 7：固件数据包 =================
  private renderExport(): void {
    this.exportPanel.replaceChildren();
    const panel = el('div', { class: 'panel stack', style: 'gap:10px' });
    panel.append(el('h3', {}, '固件数据包导出'));

    const row = el('div', { class: 'row' });
    const projSel = el('select') as HTMLSelectElement;
    for (const p of this.projects) projSel.append(el('option', { value: p.id }, p.name));
    if (store.currentProjectId) projSel.value = store.currentProjectId;
    const devSel = el('select') as HTMLSelectElement;
    for (const d of this.devices) devSel.append(el('option', { value: d.id }, `${d.name}（${d.serial}）`));
    if (store.currentDeviceId) devSel.value = store.currentDeviceId;
    const fpsInput = el('input', { type: 'number', value: '30', min: '5', max: '60', style: 'width:64px' }) as HTMLInputElement;
    const durInput = el('input', { type: 'number', value: '10', min: '1', max: '120', style: 'width:64px' }) as HTMLInputElement;
    const safeInput = el('input', { type: 'number', value: '0.92', min: '0.5', max: '1', step: '0.01', style: 'width:64px' }) as HTMLInputElement;
    const go = el('button', { class: 'primary' }, '扫描并打包');
    row.append(
      el('span', { class: 'dim' }, '工程:'), projSel,
      el('span', { class: 'dim' }, '设备:'), devSel,
      el('span', { class: 'dim' }, '帧率:'), fpsInput,
      el('span', { class: 'dim' }, '时长(s):'), durInput,
      el('span', { class: 'dim' }, '安全半径:'), safeInput,
      go,
    );
    panel.append(row, this.progressEl);
    this.exportPanel.append(panel);

    go.onclick = async () => {
      const project = this.projects.find((p) => p.id === projSel.value);
      const device = this.devices.find((d) => d.id === devSel.value);
      if (!project || !device) {
        this.progressEl.textContent = '请先选择工程与设备。';
        return;
      }
      go.disabled = true;
      try {
        await this.buildPacket(project, device, Number(fpsInput.value), Number(durInput.value), Number(safeInput.value));
      } finally {
        go.disabled = false;
      }
    };
  }

  private async buildPacket(project: Project, device: DeviceProfile, fps: number, duration: number, safeRadius: number): Promise<void> {
    const frameCount = Math.min(Math.round(fps * duration), 3600);
    const { ledCount, sectorsPerRev } = device;
    const comp = new Compositor(512);
    await comp.setProject(project);
    const scratch = document.createElement('canvas');
    scratch.width = scratch.height = 256;
    const sctx = scratch.getContext('2d', { willReadFrequently: true })!;

    const payload = new Uint8Array(frameCount * sectorsPerRev * ledCount * 3);
    const violations: ScanResult[] = [];
    const wb = device.whiteBalance;
    const pwm = store.pwm;
    const attitude = (device.attitudeAngle * Math.PI) / 180;

    this.progressEl.textContent = '正在逐帧采样…';
    for (let f = 0; f < frameCount; f++) {
      comp.draw(f / fps);
      sctx.drawImage(comp.canvas, 0, 0, 256, 256);
      const img = sctx.getImageData(0, 0, 256, 256);
      const px = img.data;

      // 安全半径扫描：内容像素越过 safeRadius 即记录
      let maxR = 0;
      for (let y = 0; y < 256; y += 2) {
        for (let x = 0; x < 256; x += 2) {
          const nx = (x / 255) * 2 - 1;
          const ny = (y / 255) * 2 - 1;
          const r = Math.hypot(nx, ny);
          if (r > safeRadius && r <= 1) {
            const o = (y * 256 + x) * 4;
            const lum = 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
            if (lum > 10 && r > maxR) maxR = r;
          }
        }
      }
      if (maxR > 0) violations.push({ frame: f, maxRadius: maxR });

      // 极坐标采样：每分区 × 每灯珠 → RGB，套用白平衡 + PWM 校正
      let off = f * sectorsPerRev * ledCount * 3;
      for (let s = 0; s < sectorsPerRev; s++) {
        const a = (s / sectorsPerRev) * Math.PI * 2 + attitude;
        const ca = Math.cos(a), sa = Math.sin(a);
        for (let i = 0; i < ledCount; i++) {
          const r = (i + 0.5) / ledCount;
          const x = Math.round(((0.5 + 0.5 * r * ca) * 255));
          const y = Math.round(((0.5 + 0.5 * r * sa) * 255));
          const o = (y * 256 + x) * 4;
          let rr = (px[o] / 255) * wb.r * wb.master;
          let gg = (px[o + 1] / 255) * wb.g * wb.master;
          let bb = (px[o + 2] / 255) * wb.b * wb.master;
          if (pwm.enabled) {
            const idx = (v: number) => Math.min(255, Math.max(0, Math.round(v * 255)));
            rr = pwm.r[idx(rr)]; gg = pwm.g[idx(gg)]; bb = pwm.b[idx(bb)];
          }
          payload[off++] = Math.round(Math.min(1, Math.max(0, rr)) * 255);
          payload[off++] = Math.round(Math.min(1, Math.max(0, gg)) * 255);
          payload[off++] = Math.round(Math.min(1, Math.max(0, bb)) * 255);
        }
      }
      if (f % 20 === 0) {
        this.progressEl.textContent = `采样帧 ${f}/${frameCount}…`;
        await new Promise((r) => setTimeout(r, 0)); // 让出主线程刷新进度
      }
    }
    comp.destroy();

    // 组包：64 字节头 + 负载 + CRC32
    const header = new ArrayBuffer(64);
    const dv = new DataView(header);
    dv.setUint8(0, 0x48); dv.setUint8(1, 0x46); dv.setUint8(2, 0x41); dv.setUint8(3, 0x4e); // 'HFAN'
    dv.setUint16(4, 1, true);            // 协议版本
    dv.setUint16(6, 64, true);           // 头长
    dv.setUint16(8, ledCount, true);
    dv.setUint16(10, sectorsPerRev, true);
    dv.setUint16(12, frameCount, true);
    dv.setUint16(14, fps, true);
    dv.setUint32(16, (pwm.enabled ? 2 : 0) | 1, true); // flags: bit0 白平衡已套用 bit1 PWM 已套用
    dv.setUint32(20, payload.length, true);
    const crc = crc32(payload);
    dv.setUint32(24, crc, true);
    const serialBytes = new TextEncoder().encode(device.serial.slice(0, 16));
    new Uint8Array(header, 28, 16).set(serialBytes);
    dv.setInt32(44, Math.round(device.attitudeAngle * 100), true);
    dv.setUint32(48, Math.floor(Date.now() / 1000), true);

    const packet = new Blob([header, payload], { type: 'application/octet-stream' });
    const fname = `HFAN_${device.serial}_${frameCount}f_${(payload.length / 1024).toFixed(0)}KB.bin`;

    // 结果展示
    const result = el('div', { class: 'stack', style: 'gap:8px' });
    result.append(el('div', { class: 'mono' },
      `打包完成：${frameCount} 帧 × ${sectorsPerRev} 分区 × ${ledCount} 灯珠 × 3B = ${(payload.length / 1024).toFixed(1)} KB · CRC32 = 0x${crc.toString(16).toUpperCase().padStart(8, '0')}`));
    if (violations.length) {
      const v = el('div', { class: 'banner danger' });
      v.textContent = `⚠ 检测到 ${violations.length} 帧越过安全半径（${(safeRadius * 100).toFixed(0)}%）：帧号 ` +
        violations.slice(0, 30).map((x) => `#${x.frame}(r=${x.maxRadius.toFixed(2)})`).join('、') +
        (violations.length > 30 ? ` …共 ${violations.length} 帧` : '') +
        '。可在预览台开启「标出越界」查看红色区域。';
      result.append(v);
    } else {
      result.append(el('div', { class: 'ok' }, '✓ 全部帧均在扇叶安全半径内。'));
    }
    const dl = el('button', { class: 'primary' }, `下载数据包 ${fname}`);
    dl.onclick = () => downloadBlob(packet, fname);
    result.append(dl);
    this.progressEl.replaceChildren(result);
  }

  // ================= 功能点 8：上播日志统计 =================
  private renderLog(): void {
    this.logPanel.replaceChildren();
    const panel = el('div', { class: 'panel stack', style: 'gap:10px' });
    panel.append(el('h3', {}, '设备上播日志分析'));
    const row = el('div', { class: 'row' });
    const importBtn = el('button', { class: 'primary' }, '导入 U 盘日志文件');
    importBtn.onclick = () => void this.importLog();
    const demoBtn = el('button', {}, '生成演示日志');
    demoBtn.title = '按当前工程片段生成一份模拟日志，含一条异常记录，便于验证流程';
    demoBtn.onclick = () => this.makeDemoLog();
    row.append(importBtn, demoBtn,
      el('span', { class: 'dim' }, '日志格式：CSV，每行 素材编号,开始时刻,结束时刻,实测RPM'));
    panel.append(row);
    this.logPanel.append(panel);
  }

  private async importLog(): Promise<void> {
    const files = await pickFile('.csv,.log,.txt,.json');
    if (!files.length) return;
    const text = await files[0].text();
    this.records = parseLogText(text);
    this.renderStats(files[0].name);
  }

  private makeDemoLog(): void {
    const ids = this.clips.map((c) => c.id);
    const now = Date.now();
    const recs: PlayRecord[] = [];
    let t = now - 6 * 3600_000;
    for (let i = 0; i < 14; i++) {
      const id = i === 9 ? 'GHOST-MAT-0000' : (ids[i % Math.max(ids.length, 1)] ?? `MAT-${i}`);
      const dur = 30 + Math.floor(Math.random() * 240);
      recs.push({
        materialId: id,
        start: new Date(t).toISOString(),
        end: new Date(t + dur * 1000).toISOString(),
        rpm: 850 + Math.round(Math.random() * 300),
      });
      t += (dur + 20) * 1000;
    }
    this.records = recs;
    this.renderStats('演示日志');
  }

  private renderStats(sourceName: string): void {
    // 按素材聚合
    const known = new Set(this.clips.map((c) => c.id));
    const knownMedia = new Set<string>();
    for (const c of this.clips) knownMedia.add(c.mediaId);
    const stats = new Map<string, { count: number; seconds: number; rpms: number[] }>();
    const anomalies: PlayRecord[] = [];
    for (const r of this.records) {
      if (!known.has(r.materialId) && !knownMedia.has(r.materialId)) {
        anomalies.push(r);
        continue;
      }
      const s = stats.get(r.materialId) ?? { count: 0, seconds: 0, rpms: [] };
      s.count++;
      s.seconds += Math.max(0, (new Date(r.end).getTime() - new Date(r.start).getTime()) / 1000);
      s.rpms.push(r.rpm);
      stats.set(r.materialId, s);
    }

    const panel = el('div', { class: 'panel stack', style: 'gap:10px' });
    panel.append(el('h3', {}, `统计结果（来源：${sourceName}，共 ${this.records.length} 条）`));

    // 分布图
    const chart = el('canvas', { width: '720', height: '220', style: 'width:100%;background:var(--bg-input);border-radius:8px' }) as HTMLCanvasElement;
    panel.append(chart);
    this.drawChart(chart, stats);

    // 明细表
    const table = el('table', { class: 'data' });
    table.innerHTML = `<thead><tr><th>素材编号</th><th>名称</th><th>上播次数</th><th>累计时长</th><th>平均实测转速</th></tr></thead>`;
    const tbody = el('tbody');
    for (const [id, s] of [...stats.entries()].sort((a, b) => b[1].seconds - a[1].seconds)) {
      const clip = this.clips.find((c) => c.id === id);
      const avgRpm = s.rpms.length ? (s.rpms.reduce((a, b) => a + b, 0) / s.rpms.length).toFixed(0) : '—';
      const tr = el('tr');
      tr.append(
        el('td', { class: 'mono', style: 'font-size:11px' }, id.slice(0, 13) + '…'),
        el('td', {}, clip?.name ?? '（原片级记录）'),
        el('td', {}, String(s.count)),
        el('td', {}, fmtDuration(s.seconds)),
        el('td', {}, `${avgRpm} RPM`),
      );
      tbody.append(tr);
    }
    table.append(tbody);
    panel.append(table);

    // 异常记录
    if (anomalies.length) {
      const ab = el('div', { class: 'banner danger' });
      ab.textContent = `⚠ ${anomalies.length} 条记录引用了工程中不存在的素材编号，已列为异常：`;
      panel.append(ab);
      const at = el('table', { class: 'data' });
      at.innerHTML = `<thead><tr><th>素材编号</th><th>开始</th><th>结束</th><th>RPM</th></tr></thead>`;
      const atb = el('tbody');
      for (const r of anomalies) {
        const tr = el('tr');
        tr.append(
          el('td', { class: 'mono danger-text' }, r.materialId),
          el('td', { class: 'mono' }, r.start),
          el('td', { class: 'mono' }, r.end),
          el('td', {}, String(r.rpm)),
        );
        atb.append(tr);
      }
      at.append(atb);
      panel.append(at);
    }

    const reportBtn = el('button', { class: 'primary' }, '导出上播验收报告（HTML）');
    reportBtn.onclick = () => this.exportReport(sourceName, stats, anomalies);
    panel.append(reportBtn);
    this.logPanel.append(panel);
  }

  private drawChart(canvas: HTMLCanvasElement, stats: Map<string, { count: number; seconds: number }>): void {
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const entries = [...stats.entries()];
    if (!entries.length) {
      ctx.fillStyle = '#8b96a6';
      ctx.font = '14px sans-serif';
      ctx.fillText('暂无数据', 20, 30);
      return;
    }
    const maxSec = Math.max(...entries.map(([, s]) => s.seconds), 1);
    const barW = Math.min(80, (W - 60) / entries.length - 12);
    entries.forEach(([id, s], i) => {
      const x = 40 + i * (barW + 12);
      const h = (s.seconds / maxSec) * (H - 60);
      const grad = ctx.createLinearGradient(0, H - 30 - h, 0, H - 30);
      grad.addColorStop(0, '#35c4ff');
      grad.addColorStop(1, '#7c5cff');
      ctx.fillStyle = grad;
      ctx.fillRect(x, H - 30 - h, barW, h);
      ctx.fillStyle = '#d7dee8';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${s.count}次`, x + barW / 2, H - 36 - h);
      ctx.fillStyle = '#8b96a6';
      ctx.fillText(`#${i + 1}`, x + barW / 2, H - 14);
    });
    ctx.fillStyle = '#8b96a6';
    ctx.textAlign = 'left';
    ctx.fillText('柱高=累计上播时长，标注=上播次数', 8, 16);
  }

  private exportReport(
    sourceName: string,
    stats: Map<string, { count: number; seconds: number; rpms: number[] }>,
    anomalies: PlayRecord[],
  ): void {
    const device = this.devices.find((d) => d.id === store.currentDeviceId) ?? this.devices[0];
    const rows = [...stats.entries()].sort((a, b) => b[1].seconds - a[1].seconds).map(([id, s], i) => {
      const clip = this.clips.find((c) => c.id === id);
      const avgRpm = s.rpms.length ? (s.rpms.reduce((a, b) => a + b, 0) / s.rpms.length).toFixed(0) : '—';
      return `<tr><td>${i + 1}</td><td style="font-family:monospace">${id}</td><td>${clip?.name ?? '（原片级记录）'}</td>` +
        `<td>${s.count}</td><td>${fmtDuration(s.seconds)}</td><td>${avgRpm}</td></tr>`;
    }).join('');
    const anomalyRows = anomalies.map((r) =>
      `<tr style="color:#c0392b"><td style="font-family:monospace">${r.materialId}</td><td>${r.start}</td><td>${r.end}</td><td>${r.rpm}</td></tr>`).join('');
    const totalSec = [...stats.values()].reduce((a, s) => a + s.seconds, 0);
    const maxSec = Math.max(...[...stats.values()].map((s) => s.seconds), 1);
    const bars = [...stats.entries()].map(([id, s], i) => {
      const h = Math.round((s.seconds / maxSec) * 160);
      return `<div style="display:inline-block;vertical-align:bottom;margin:0 6px;text-align:center">` +
        `<div style="width:46px;height:${h}px;background:linear-gradient(#35c4ff,#7c5cff);border-radius:4px 4px 0 0"></div>` +
        `<div style="font-size:11px;color:#666">#${i + 1} ${s.count}次</div></div>`;
    }).join('');

    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>上播验收报告</title>
<style>body{font-family:"Microsoft YaHei",sans-serif;max-width:900px;margin:32px auto;color:#222}
table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #ccc;padding:6px 10px;font-size:13px}
th{background:#f2f5f8}h1{font-size:22px}h2{font-size:17px;margin-top:28px}.meta{color:#666;font-size:13px}</style></head><body>
<h1>全息风扇上播验收报告</h1>
<p class="meta">生成时间：${new Date().toLocaleString()} ｜ 日志来源：${sourceName} ｜ 设备：${device ? `${device.name}（${device.serial}，${device.site || '未登记场地'}）` : '未指定'}</p>
<h2>一、汇总</h2>
<p>有效上播记录 ${[...stats.values()].reduce((a, s) => a + s.count, 0)} 次，累计上播时长 ${fmtDuration(totalSec)}，异常记录 ${anomalies.length} 条。</p>
<h2>二、上播分布</h2>
<div style="height:200px">${bars}</div>
<h2>三、素材明细</h2>
<table><thead><tr><th>#</th><th>素材编号</th><th>名称</th><th>上播次数</th><th>累计时长</th><th>平均实测转速(RPM)</th></tr></thead><tbody>${rows}</tbody></table>
${anomalies.length ? `<h2>四、异常记录（工程中不存在的素材编号）</h2>
<table><thead><tr><th>素材编号</th><th>开始</th><th>结束</th><th>RPM</th></tr></thead><tbody>${anomalyRows}</tbody></table>` : ''}
<p class="meta">本报告由全息风扇内容编排与预览系统生成。</p></body></html>`;
    downloadText(html, `上播验收报告-${new Date().toISOString().slice(0, 10)}.html`, 'text/html');
  }

  destroy(): void {}
}

/** 解析设备日志：CSV（素材编号,开始,结束,RPM）或 JSON 数组 */
export function parseLogText(text: string): PlayRecord[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    return arr.map((r: any) => ({
      materialId: String(r.materialId ?? r.material ?? ''),
      start: String(r.start ?? ''), end: String(r.end ?? ''), rpm: Number(r.rpm ?? 0),
    })).filter((r: PlayRecord) => r.materialId);
  }
  const out: PlayRecord[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const parts = line.split(/[,\t]/).map((s) => s.trim());
    if (parts.length < 4 || !parts[0] || /material|素材/i.test(parts[0])) continue;
    out.push({ materialId: parts[0], start: parts[1], end: parts[2], rpm: Number(parts[3]) || 0 });
  }
  return out;
}
