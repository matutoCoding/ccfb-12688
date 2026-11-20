import { h, clear, toast, downloadBlob } from '../lib/dom';
import { store } from '../lib/store';
import { pageHeader, emptyState } from './shell';
import { buildPacket, exportPacketFile, verifyPacket, exportProject } from '../lib/export';
import { buildStrip } from '../render/strip-builder';
import { extractFrame } from '../lib/video';
import { parsePlaybackLog, buildStats, buildAcceptanceReport, exportReport, sampleLogText } from '../lib/playback-log';
import { makeDevice } from '../lib/seed';
import type { DeviceProfile, PlaybackStats } from '../types';

export function exportPage(): HTMLElement {
  const root = h('div', {});
  const draw = () => {
    clear(root);
    root.appendChild(pageHeader('导出中心', '固件二进制包（CRC32 校验 + 安全半径扫描）、U 盘日志解析与上播验收报告'));
    const project = store.currentProject;
    const device = store.currentDevice;
    if (!project) {
      root.appendChild(emptyState('请先在画布编排打开工程。'));
      return;
    }

    // ---------- 数据包 ----------
    const safeRadiusInput = h('input', { type: 'range', min: '0.5', max: '1', step: '0.01', value: '0.92' }) as HTMLInputElement;
    const safeVal = h('span', {}, '92% 半径');
    safeRadiusInput.addEventListener('input', () => safeVal.textContent = `${(Number(safeRadiusInput.value) * 100).toFixed(0)}% 半径`);

    const resultBox = h('div', {});
    const buildBtn = h('button', { class: 'primary' }, '构建二进制数据包（逐帧扫描）');
    buildBtn.addEventListener('click', async () => {
      buildBtn.disabled = true;
      buildBtn.textContent = '构建中…';
      try {
        const frames = await renderAllFrames(project);
        const result = buildPacket(frames, project.ledCount, project.framesPerRevolution, Number(safeRadiusInput.value), project.name);
        resultBox.replaceChildren(renderResult(result.info));
        // 暂存 bytes 供下载
        (buildBtn as unknown as { _bytes?: Uint8Array })._bytes = result.bytes;
        (buildBtn as unknown as { _name?: string })._name = result.info.fileName;
        toast(result.info.safetyViolations.length ? `构建完成，${result.info.safetyViolations.length} 帧存在越界（已红标）` : '构建完成，安全扫描通过', result.info.safetyViolations.length ? 'warn' : 'info');
      } catch (e) {
        toast((e as Error).message, 'error');
      } finally {
        buildBtn.disabled = false;
        buildBtn.textContent = '构建二进制数据包（逐帧扫描）';
      }
    });

    const dlBtn = h('button', { onclick: () => {
      const bytes = (buildBtn as unknown as { _bytes?: Uint8Array })._bytes;
      const name = (buildBtn as unknown as { _name?: string })._name ?? 'packet.povf';
      if (!bytes) return toast('请先构建数据包', 'warn');
      downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), name);
    } }, '下载 .povf 数据包');

    const verifyInput = h('input', { type: 'file', accept: '.povf', style: 'display:none', onchange: async () => {
      const f = verifyInput.files?.[0];
      if (!f) return;
      const bytes = new Uint8Array(await f.arrayBuffer());
      const r = verifyPacket(bytes);
      toast(r.ok ? `CRC32 校验通过：${r.crc}` : `校验失败：${r.reason}`, r.ok ? 'info' : 'error');
      verifyInput.value = '';
    } }) as HTMLInputElement;

    const packetCard = h('div', { class: 'card' },
      h('h3', {}, '固件数据包'),
      h('p', { class: 'sub muted' }, `格式 POVF v1 · ${project.framesPerRevolution} 帧 × ${project.ledCount} 灯珠 RGB · 整包 CRC32 · 工程「${project.name}」`),
      h('label', {}, `扇叶安全半径：${safeVal.textContent}`), safeRadiusInput,
      h('div', { class: 'pill-group', style: 'margin:12px 0' }, buildBtn, dlBtn,
        h('button', { onclick: () => verifyInput.click() }, '回读校验 .povf'), verifyInput,
        h('button', { onclick: () => exportProject(project) }, '导出工程 JSON'),
      ),
      resultBox,
    );

    // ---------- 日志解析 ----------
    const statsBox = h('div', {});
    const logInput = h('input', { type: 'file', accept: '.csv,.log,.txt', style: 'display:none', onchange: async () => {
      const f = logInput.files?.[0];
      if (!f) return;
      try {
        const entries = parsePlaybackLog(await f.text());
        if (!entries.length) throw new Error('未解析到有效日志行');
        const known = new Set(store.clips.map((c) => c.id));
        const stats = buildStats(entries, project, known);
        statsBox.replaceChildren(renderStats(stats, project.name, [...new Set(entries.map((e) => e.deviceSerial))]));
        toast(`解析 ${entries.length} 条播放记录，异常 ${stats.anomalies.length} 条`);
      } catch (e) {
        toast((e as Error).message, 'error');
      }
      logInput.value = '';
    } }) as HTMLInputElement;

    const demoBtn = h('button', { onclick: () => {
      const text = sampleLogText(store.clips.map((c) => c.id), device?.serialNumber ?? 'SN-DEMO');
      const entries = parsePlaybackLog(text);
      const known = new Set(store.clips.map((c) => c.id));
      const stats = buildStats(entries, project, known);
      statsBox.replaceChildren(renderStats(stats, project.name, [...new Set(entries.map((e) => e.deviceSerial))]));
    } }, '载入演示日志');

    const logCard = h('div', { class: 'card', style: 'margin-top:18px' },
      h('h3', {}, 'U 盘播放日志解析'),
      h('p', { class: 'sub muted' }, '设备端 CSV 日志：deviceSerial,materialCode,startEpoch,endEpoch,rpmAvg；未知素材编号自动标异常'),
      h('div', { class: 'pill-group' },
        h('button', { class: 'primary', onclick: () => logInput.click() }, '选择日志文件'), logInput,
        demoBtn,
      ),
      statsBox,
    );

    root.appendChild(h('div', {}, packetCard, logCard));
  };
  store.subscribe(draw);
  draw();
  return root;
}

/** 逐帧渲染整圈内容：沿工程时间轴对每个 FPR 帧取条带（与预览同一合成链路） */
async function renderAllFrames(project: NonNullable<ReturnType<typeof store.projects.find>>): Promise<Uint8ClampedArray[]> {
  const fpr = project.framesPerRevolution;
  const frames: Uint8ClampedArray[] = [];
  // 条带是 FPR×LED，逐行（每帧）拆出 LED RGB
  const strip = await buildStrip(
    project,
    store.currentDevice ?? makeExportFallbackDevice(),
    0,
    async (clip, localSec) => {
      const source = store.videoById(clip.sourceId);
      if (!source) return null;
      try {
        const r = await extractFrame(source, Math.min(localSec, source.durationSec - 0.05), 320);
        return r.image;
      } catch {
        return null;
      }
    },
  );
  for (let f = 0; f < fpr; f++) {
    const row = new Uint8ClampedArray(project.ledCount * 4);
    for (let led = 0; led < project.ledCount; led++) {
      const src = (f * project.ledCount + led) * 3;
      row[led * 4] = strip.rgb[src];
      row[led * 4 + 1] = strip.rgb[src + 1];
      row[led * 4 + 2] = strip.rgb[src + 2];
      row[led * 4 + 3] = 255;
    }
    frames.push(row);
  }
  return frames;
}

/** 未绑定设备时导出用的最小设备参数（仅姿态补偿参与条带合成） */
function makeExportFallbackDevice(): DeviceProfile {
  return makeDevice({ serialNumber: 'EXPORT-FALLBACK' });
}

function renderResult(info: ReturnType<typeof buildPacket>['info']): HTMLElement {
  return h('div', { class: 'card', style: 'background:var(--bg)' },
    h('div', { class: 'grid cols-3' },
      stat('文件名', info.fileName),
      stat('大小', `${(info.sizeBytes / 1024).toFixed(1)} KB`),
      stat('CRC32', info.crc32.toString(16).toUpperCase().padStart(8, '0')),
      stat('帧数', String(info.frameCount)),
      stat('灯珠/帧', String(info.ledCount)),
      stat('越界帧', String(info.safetyViolations.length), info.safetyViolations.length ? 'danger' : 'ok'),
    ),
    info.safetyViolations.length
      ? h('details', { style: 'margin-top:10px' },
          h('summary', { style: 'color:var(--warn);cursor:pointer' }, `越界明细（前 20 帧，预览中红色标注）`),
          h('div', { class: 'log-view mono' }, ...info.safetyViolations.slice(0, 20).map((v) =>
            h('div', { class: 'row' }, `帧 #${v.frameIndex} · 最远半径 ${(v.maxRadius * 100).toFixed(1)}% · 越界灯珠 ${v.pixelCount} 颗`),
          )),
        )
      : h('p', { class: 'badge ok', style: 'margin-top:8px' }, '✓ 全部帧在安全半径内'),
  );
}

function stat(k: string, v: string, badge?: 'ok' | 'danger'): HTMLElement {
  return h('div', {}, h('div', { class: 'muted', style: 'font-size:11px' }, k), h('strong', { class: badge === 'danger' ? 'badge danger' : badge === 'ok' ? 'badge ok' : '' }, v));
}

function renderStats(stats: PlaybackStats, projectName: string, serials: string[]): HTMLElement {
  const maxCount = Math.max(1, ...stats.byMaterial.map((m) => m.playCount));
  return h('div', { style: 'margin-top:14px' },
    h('div', { class: 'grid cols-3', style: 'margin-bottom:14px' },
      stat('日志条目', String(stats.totalEntries)),
      stat('素材种类', String(stats.byMaterial.length)),
      stat('异常记录', String(stats.anomalies.length), stats.anomalies.length ? 'danger' : 'ok'),
    ),
    h('h3', { style: 'font-size:13px' }, '上播次数分布'),
    h('div', { class: 'bar-chart' },
      ...stats.byMaterial.map((m) =>
        h('div', { class: 'bar-row' },
          h('span', { class: 'mono', title: m.materialCode }, m.materialCode.slice(0, 12)),
          h('div', { class: 'bar-track' }, h('div', { class: `bar-fill ${m.anomalous ? 'anom' : ''}`, style: `width:${(m.playCount / maxCount) * 100}%` })),
          h('span', {}, `${m.playCount} 次`),
        ),
      ),
    ),
    stats.anomalies.length ? h('p', { class: 'badge danger', style: 'margin-top:10px' }, `⚠ ${stats.anomalies.length} 条异常：素材编号在当前工程中不存在，已单独列出`) : h('p', { class: 'badge ok', style: 'margin-top:10px' }, '✓ 无异常素材编号'),
    h('div', { class: 'pill-group', style: 'margin-top:12px' },
      h('button', { class: 'primary', onclick: () => {
        const md = buildAcceptanceReport(stats, projectName, serials);
        exportReport(md, projectName);
      } }, '导出上播验收报告 (Markdown)'),
      h('button', { onclick: () => {
        const md = buildAcceptanceReport(stats, projectName, serials);
        downloadBlob(new Blob([JSON.stringify(stats, null, 2)], { type: 'application/json' }), `${projectName}_播放统计.json`);
      } }, '导出统计 JSON'),
    ),
  );
}
