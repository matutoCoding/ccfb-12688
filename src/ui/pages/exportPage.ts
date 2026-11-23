// 导出中心：安全扫描 -> 控制板二进制包(CRC32) -> U盘日志解析 -> 上播验收报告
import { button, clear, h, selectField, textField, toast, modal, type Child } from '../dom';
import { store } from '../../core/store';
import { downloadBlob, formatClock, formatBytes } from '../../core/mathutil';
import { buildPacket, parsePacket, type PacketFrame } from '../../export/packet';
import { scanSafeRadius, markedFrameToDataURL, type SafetyScanResult } from '../../export/safety';
import { parsePlayLogFile, classifyEntries, aggregateByMaterial, buildDemoLog } from '../../export/playlog';
import { buildAcceptanceReport } from '../../export/report';
import { extractProjectFrames, framesToPacketFrames, type ExtractedFrame } from '../../sim/frameExtract';
import { ensureEngine, refreshEngineContext } from '../../sim/engineContext';
import type { PlayLogEntry } from '../../core/types';

export function renderExportPage(root: HTMLElement): void {
  clear(root);
  const project = store.state.projects.find((p) => p.id === store.state.currentProjectId) ?? null;
  root.append(
    h('div', { class: 'page-head' }, h('h2', {}, '导出中心'),
      h('span', { class: 'sub' }, '固件二进制包 · CRC32 校验 · 安全半径扫描 · 上播验收报告')),
    materialBindingCard(),
    scanCard(project),
    logCard(),
  );
}

// ---------------- 素材编号绑定（日志对照用） ----------------

function materialBindingCard(): HTMLElement {
  const card = h('div', { class: 'card' }, h('h3', {}, '素材编号绑定（控制板侧 material code ↔ 工程片段）'));
  const rows = h('div', { class: 'grid' });
  const refresh = () => {
    rows.replaceChildren(...store.state.clips.map((clip) => {
      const bound = store.state.materialBindings.find((b) => b.clipId === clip.id);
      const code = bound?.materialCode ?? `MAT-${clip.id.slice(-6).toUpperCase()}`;
      return h('div', { class: 'row' },
        h('span', { style: 'flex:1' }, clip.name),
        textField('素材编号', code, (v) => upsertBinding(clip.id, v)),
      );
    }));
  };
  refresh();
  card.append(rows, h('div', { class: 'muted' }, '日志中出现未绑定的编号会被标为异常记录。'));
  return card;
}

function upsertBinding(clipId: string, materialCode: string): void {
  const others = store.state.materialBindings.filter((b) => b.clipId !== clipId);
  store.update({ materialBindings: [...others, { clipId, materialCode }] });
  refreshEngineContext();
}

// ---------------- 安全扫描 + 二进制打包 ----------------

function scanCard(project: import('../../core/types').Project | null): HTMLElement {
  const card = h('div', { class: 'card' }, h('h3', {}, '固件数据包导出'));
  if (!project) {
    card.append(h('p', { class: 'muted' }, '请先在画布编排中创建工程。'));
    return card;
  }
  const device = store.state.devices[0];
  const fpsInput = h('input', { type: 'number', value: 30, min: 1, max: 60, step: 1 }) as HTMLInputElement;
  const sizeInput = h('input', { type: 'number', value: 256, min: 64, max: 1024, step: 64 }) as HTMLInputElement;
  const progress = h('div', { class: 'muted mono' }, '待扫描');
  const resultHost = h('div', {});

  let extracted: ExtractedFrame[] = [];
  let scanResult: SafetyScanResult | null = null;

  const runScan = async () => {
    if (!device) return toast('请先在设备设置登记设备', 'error');
    const canvas = document.createElement('canvas');
    const requestedSize = parseInt(sizeInput.value) || 256;
    canvas.width = requestedSize;
    canvas.height = requestedSize;
    const engine = await ensureEngine(canvas);
    const assetMap = new Map(store.state.assets.map((a) => [a.id, { blob: a.blob, duration: a.duration, fps: a.fps }]));
    engine.setProject(project, store.state.clips, assetMap);
    refreshEngineContext();
    const fps = parseInt(fpsInput.value) || 30;
    // 引擎为单例，内部 FBO 分辨率固定；readContentPixels 负责缩放到请求边长
    const size = requestedSize;
    progress.textContent = '逐帧抽取与合成中…';
    extracted = await extractProjectFrames(engine, project.duration, fps, size, (r) => {
      progress.textContent = `抽取进度 ${(r * 100).toFixed(0)}%`;
    });
    const bad = extracted.find((f) => f.rgba.length !== size * size * 4);
    if (bad) {
      progress.textContent = '帧尺寸异常，请重试或降低导出边长';
      toast(`第 ${bad.index} 帧尺寸与请求边长 ${size} 不一致`, 'error');
      extracted = [];
      return;
    }
    progress.textContent = `已抽取 ${extracted.length} 帧（${size}×${size}），开始安全半径扫描…`;
    scanResult = scanSafeRadius(
      extracted.map((f) => ({ index: f.index, timeSec: f.timeSec, pixels: f.rgba })),
      size,
      device.safeRadiusRatio,
    );
    progress.textContent = `扫描完成：${scanResult.violations.length} 帧越界（共 ${scanResult.scannedFrames} 帧）`;
    renderScanResult();
  };

  const renderScanResult = () => {
    resultHost.replaceChildren();
    if (!scanResult) return;
    if (!scanResult.violations.length) {
      resultHost.append(h('div', { class: 'alert alert-ok' }, '全部帧均在扇叶安全半径内，无越界像素。'));
      return;
    }
    const top = scanResult.violations.slice(0, 6);
    resultHost.append(
      h('div', { class: 'alert alert-danger' }, `发现 ${scanResult.violations.length} 个越界帧，红色区域见下，导出前请调整画面。`),
      h('div', { class: 'grid grid-3' }, ...top.map((v) => {
        const marked = scanResult!.markedFrames.get(v.frameIndex);
        const img = marked ? h('img', { src: markedFrameToDataURL(marked, parseInt(sizeInput.value) || 256), style: 'width:100%;border-radius:8px' }) : null;
        return h('div', { class: 'card' },
          h('strong', { class: 'danger' }, `帧号 #${v.frameIndex}`),
          h('div', { class: 'muted mono' }, `t=${formatClock(v.timeSec)} · 越界 ${(v.ratio * 100).toFixed(2)}%`),
          img);
      })),
    );
  };

  const exportPacket = async () => {
    if (!extracted.length) return toast('请先执行安全扫描', 'error');
    if (!device) return toast('缺少设备档案', 'error');
    const size = parseInt(sizeInput.value) || 256;
    const packetFrames: PacketFrame[] = framesToPacketFrames(extracted);
    const built = buildPacket({
      device,
      frames: packetFrames,
      size,
      fps: parseInt(fpsInput.value) || 30,
      includeWhiteBalance: true,
      includePwmCalib: !!device.pwmCalibId,
      wallBundle: !!store.state.preview.wallId,
    });
    const blob = new Blob([built.bytes], { type: 'application/octet-stream' });
    downloadBlob(blob, `${device.serial}_${project.name.replace(/\s+/g, '_')}.hol1`);
    // 同步给一份人类可读的包头校验单
    const info = parsePacket(built.bytes);
    toast(`数据包已生成 ${formatBytes(blob.size)}，CRC32 ${built.crc.toString(16).padStart(8, '0')} 校验${info.crcOk ? '通过' : '失败'}`, info.crcOk ? 'ok' : 'error');
    showPacketInfo(built.bytes);
  };

  card.append(
    h('div', { class: 'row' },
      h('label', { class: 'field' }, h('span', {}, '帧率 fps'), fpsInput),
      h('label', { class: 'field' }, h('span', {}, '帧边长 px'), sizeInput),
      h('span', { class: 'muted' }, `目标设备：${device ? `${device.serial}（安全半径 ${(device.safeRadiusRatio * 100).toFixed(0)}%）` : '未登记'}`),
    ),
    h('div', { class: 'row', style: 'margin-top:10px' },
      button('① 逐帧安全扫描', () => void runScan(), 'primary'),
      button('② 导出 .hol1 固件包（含 CRC32）', () => void exportPacket(), 'primary'),
    ),
    progress,
    resultHost,
  );
  return card;
}

function showPacketInfo(bytes: Uint8Array): void {
  const info = parsePacket(bytes);
  const body = h('div', {},
    h('table', {}, h('tbody', {},
      ...Object.entries({
        '版本': info.version,
        '标志位': info.flags.toString(2).padStart(3, '0'),
        '设备序列号': info.serial,
        '扇叶直径': `${info.bladeDiameterMm} mm`,
        '灯珠数': info.ledCount,
        '帧数': info.frameCount,
        '帧边长': info.size,
        '帧率': `${(info.fpsMilli / 1000).toFixed(2)} fps`,
        '目标转速': `${info.targetRpm} rpm`,
        '姿态补偿': `${info.attitudeMilliDeg / 1000}°`,
        '安全半径': `${(info.safeRadius * 100).toFixed(1)}%`,
        '数据段长度': formatBytes(info.payloadLen),
        'CRC32': info.storedCrc.toString(16).padStart(8, '0'),
        '校验结果': info.crcOk ? '通过 ✅' : '失败 ❌',
      }).map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', { class: 'mono' }, String(v)))),
    )),
  );
  modal('固件包头解析（验收自检）', body);
}

// ---------------- U 盘日志解析与验收报告 ----------------

function logCard(): HTMLElement {
  const card = h('div', { class: 'card' }, h('h3', {}, 'U 盘播放日志解析与上播验收报告'));
  const host = h('div', {});
  const fileInput = h('input', {
    type: 'file', accept: '.csv,.txt,log', style: 'display:none',
    onchange: () => void handleLog(fileInput as HTMLInputElement, host),
  });
  card.append(
    h('div', { class: 'row' },
      button('导入 U 盘日志', () => (fileInput as HTMLInputElement).click(), 'primary'),
      button('下载示例日志', () => {
        const serial = store.state.devices[0]?.serial ?? 'HF-0001';
        const codes = store.state.materialBindings.map((b) => b.materialCode);
        downloadBlob(new Blob([buildDemoLog(serial, codes)], { type: 'text/csv' }), 'playlog-demo.csv');
      }),
    ),
    fileInput,
    host,
  );
  return card;
}

async function handleLog(input: HTMLInputElement, host: HTMLElement): Promise<void> {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const parsed = await parsePlayLogFile(file);
    const known = new Set(store.state.materialBindings.map((b) => b.materialCode));
    const { normal, abnormal } = classifyEntries(parsed, known);
    const stats = aggregateByMaterial(normal);
    const totalDur = normal.reduce((s, e) => s + (e.endUnix - e.startUnix), 0);
    renderLogResult(host, file.name, stats, abnormal, normal.length + abnormal.length, totalDur);
    // 异常与全量条目落 IndexedDB，留档设备日志
    for (const e of [...normal, ...abnormal]) await store.persistPlayLog(e);
    toast(`日志解析完成：${normal.length} 条正常，${abnormal.length} 条异常`, abnormal.length ? 'error' : 'ok');
  } catch (e) {
    toast(`日志解析失败：${(e as Error).message}`, 'error');
  }
  input.value = '';
}

function renderLogResult(
  host: HTMLElement,
  sourceName: string,
  stats: ReturnType<typeof aggregateByMaterial>,
  abnormal: PlayLogEntry[],
  totalPlays: number,
  totalDur: number,
): void {
  const report = buildAcceptanceReport({
    title: '全息风扇上播验收报告',
    generatedAt: new Date().toLocaleString(),
    deviceSerials: [...new Set(stats.flatMap((s) => s.devices))],
    stats,
    abnormal,
    totalPlays,
    totalDurationSec: totalDur,
    logSourceName: sourceName,
  });
  const abnormalBlock: Child = abnormal.length
    ? h('div', { class: 'alert alert-danger', style: 'margin:10px 0' },
      h('div', {}, '异常素材编号（工程中不存在）：'),
      ...abnormal.map((e) => h('div', { class: 'mono' }, `${e.deviceSerial} · ${e.materialCode} · ${new Date(e.startUnix * 1000).toLocaleString()}`)))
    : null;
  host.replaceChildren(h('div', {},
    h('div', { class: 'grid grid-3', style: 'margin:10px 0' },
      kpi('总上播次数', String(totalPlays)),
      kpi('累计时长', formatClock(totalDur)),
      kpi('异常记录', String(abnormal.length), abnormal.length > 0),
    ),
    h('table', {}, h('thead', {}, h('tr', {}, ...['素材编号', '次数', '累计时长', '平均转速', '设备'].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...stats.map((s) => h('tr', {},
        h('td', { class: 'mono' }, s.materialCode),
        h('td', { class: 'mono' }, String(s.playCount)),
        h('td', { class: 'mono' }, formatClock(s.totalDurationSec)),
        h('td', { class: 'mono' }, `${Math.round(s.avgRpm)} rpm`),
        h('td', {}, s.devices.join(', ')))))),
    abnormalBlock,
    h('div', { class: 'row', style: 'margin-top:12px' },
      button('导出上播验收报告 HTML（交付客户）', () => {
        downloadBlob(new Blob([report], { type: 'text/html' }), `上播验收报告_${new Date().toISOString().slice(0, 10)}.html`);
        toast('报告已导出', 'ok');
      }, 'primary'),
    ),
  ));
}

function kpi(label: string, value: string, danger = false): HTMLElement {
  return h('div', { class: 'kpi' }, h('b', { style: danger ? 'color:var(--danger)' : '' }, value), h('span', {}, label));
}
