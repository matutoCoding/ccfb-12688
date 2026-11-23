// 设备设置页：序列号/扇叶/灯珠档案、分组、姿态补偿裁切、照度曲线拖拽、白平衡、PWM 校准
import { button, clear, h, modal, selectField, slider, textField, toast } from '../dom';
import { store } from '../../core/store';
import { idb } from '../../core/db';
import { uid } from '../../core/id';
import { parsePwmCsv, defaultLinearCalib } from '../../media/calibration';
import { AmbientSensor, DEFAULT_LIGHT_CURVE } from '../../sim/AmbientSensor';
import { getEngine, refreshEngineContext } from '../../sim/engineContext';
import type { Device, LightCurvePoint, MountAttitude, PwmCalib } from '../../core/types';

const ATTITUDES: { value: MountAttitude; text: string; angle: number }[] = [
  { value: 'upright', text: '正立安装', angle: 0 },
  { value: 'inverted', text: '倒挂（180°）', angle: 180 },
  { value: 'side-left', text: '左侧装（90°）', angle: 90 },
  { value: 'side-right', text: '右侧装（-90°）', angle: -90 },
  { value: 'custom', text: '自定义角度', angle: 0 },
];

export function renderDevicePage(root: HTMLElement): void {
  clear(root);
  root.append(
    h('div', { class: 'page-head' },
      h('h2', {}, '设备设置'),
      h('span', { class: 'sub' }, `已登记 ${store.state.devices.length} 台设备 · ${new Set(store.state.devices.map((d) => d.group)).size} 个分组`),
      h('div', { class: 'spacer' }),
      button('登记新设备', () => openDeviceEditor(null), 'primary'),
      button('导入 PWM 校准表', () => void importCalib()),
    ),
    deviceTable(),
    h('div', { class: 'grid grid-2' }, lightCurveCard(), pwmCalibCard()),
    wallCard(),
  );
}

function deviceTable(): HTMLElement {
  if (!store.state.devices.length) {
    return h('div', { class: 'card' }, h('p', { class: 'muted' }, '还没有设备档案，点击「登记新设备」开始。'));
  }
  const groups = [...new Set(store.state.devices.map((d) => d.group))];
  return h('div', { class: 'card' },
    h('h3', {}, `分组：${groups.join('、') || '—'}`),
    h('table', {},
      h('thead', {}, h('tr', {},
        ...['序列号', '名称', '扇叶直径', '灯珠数', '场地/分组', '姿态补偿', '安全半径', '目标转速', '漂移幅度', '白平衡', '操作'].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...store.state.devices.map(deviceRow)),
    ),
  );
}

function deviceRow(d: Device): HTMLElement {
  return h('tr', {},
    h('td', { class: 'mono' }, d.serial),
    h('td', {}, d.name),
    h('td', { class: 'mono' }, `${d.bladeDiameterMm}mm`),
    h('td', { class: 'mono' }, String(d.ledCount)),
    h('td', {}, `${d.site} / ${d.group}`),
    h('td', { class: 'mono' }, `${d.attitudeAngleDeg}°`),
    h('td', { class: 'mono' }, `${(d.safeRadiusRatio * 100).toFixed(0)}%`),
    h('td', { class: 'mono' }, `${d.targetRpm} rpm`),
    h('td', { class: 'mono' }, `±${d.driftAmplitude} rpm`),
    h('td', { class: 'mono' }, `R${d.whiteBalance.r.toFixed(2)} G${d.whiteBalance.g.toFixed(2)} B${d.whiteBalance.b.toFixed(2)}`),
    h('td', {},
      button('编辑', () => openDeviceEditor(d), 'primary'),
      button('删除', () => void removeDevice(d), 'danger'),
    ),
  );
}

function openDeviceEditor(existing: Device | null): void {
  const d: Device = existing ?? {
    id: uid('dev'),
    serial: `HF-${String(store.state.devices.length + 1).padStart(4, '0')}`,
    name: '新风扇',
    bladeDiameterMm: 420,
    ledCount: 224,
    site: '展厅 A 区',
    group: '默认分组',
    attitude: 'upright',
    attitudeAngleDeg: 0,
    safeRadiusRatio: 0.92,
    whiteBalance: { r: 1, g: 1, b: 1, brightness: 1 },
    pwmCalibId: null,
    targetRpm: 900,
    driftAmplitude: 12,
    manualBrightness: 0.8,
    createdAt: Date.now(),
  };

  const body = h('div', { class: 'grid grid-2' },
    h('div', { class: 'grid' },
      textField('序列号（校正系数绑定）', d.serial, (v) => { d.serial = v; }),
      textField('设备名称', d.name, (v) => { d.name = v; }),
      textField('扇叶直径 mm', String(d.bladeDiameterMm), (v) => { d.bladeDiameterMm = parseFloat(v) || 420; }),
      textField('灯珠数', String(d.ledCount), (v) => { d.ledCount = parseInt(v) || 224; }),
      textField('安装场地', d.site, (v) => { d.site = v; }),
      textField('分组', d.group, (v) => { d.group = v; }),
    ),
    h('div', { class: 'grid' },
      selectField('安装姿态', ATTITUDES.map((a) => ({ value: a.value, text: a.text })), d.attitude, (v) => {
        d.attitude = v as MountAttitude;
        const preset = ATTITUDES.find((a) => a.value === v);
        if (preset && v !== 'custom') d.attitudeAngleDeg = preset.angle;
      }),
      slider({ min: -180, max: 180, step: 1, value: d.attitudeAngleDeg, label: '姿态补偿角°', format: (v) => `${v}°`, onInput: (v) => { d.attitudeAngleDeg = v; d.attitude = 'custom'; } }),
      slider({ min: 0.5, max: 1, step: 0.01, value: d.safeRadiusRatio, label: '安全半径比例', format: (v) => `${(v * 100).toFixed(0)}%`, onInput: (v) => { d.safeRadiusRatio = v; } }),
      slider({ min: 300, max: 1800, step: 10, value: d.targetRpm, label: '目标转速', format: (v) => `${v} rpm`, onInput: (v) => { d.targetRpm = v; } }),
      slider({ min: 0, max: 120, step: 1, value: d.driftAmplitude, label: '电压漂移峰峰值', format: (v) => `±${v} rpm`, onInput: (v) => { d.driftAmplitude = v; } }),
      slider({ min: 0.1, max: 1, step: 0.01, value: d.manualBrightness, label: '手动亮度（断连回退）', onInput: (v) => { d.manualBrightness = v; } }),
    ),
    h('div', { class: 'card', style: 'grid-column:1/-1' },
      h('h3', {}, '白平衡（按批次灯珠色温逐台校准，系数绑定序列号）'),
      slider({ min: 0.5, max: 1.8, step: 0.005, value: d.whiteBalance.r, label: 'R 增益', onInput: (v) => { d.whiteBalance.r = v; } }),
      slider({ min: 0.5, max: 1.8, step: 0.005, value: d.whiteBalance.g, label: 'G 增益', onInput: (v) => { d.whiteBalance.g = v; } }),
      slider({ min: 0.5, max: 1.8, step: 0.005, value: d.whiteBalance.b, label: 'B 增益', onInput: (v) => { d.whiteBalance.b = v; } }),
      slider({ min: 0.3, max: 1.5, step: 0.01, value: d.whiteBalance.brightness, label: '整体亮度', onInput: (v) => { d.whiteBalance.brightness = v; } }),
      h('div', { class: 'muted' }, '姿态变化后，扇叶外圈有效成像区按补偿角在预览中自动旋转裁切；导出包同样写入该角度。'),
    ),
  );

  const m = modal(existing ? '编辑设备' : '登记设备', body, h('div', { class: 'row' },
    button('取消', () => m.close()),
    button('保存档案', () => { void saveDevice(d, existing); m.close(); }, 'primary')));
}

async function saveDevice(d: Device, existing: Device | null): Promise<void> {
  await idb.put('devices', d);
  const devices = existing ? store.state.devices.map((x) => (x.id === d.id ? d : x)) : [...store.state.devices, d];
  store.update({ devices });
  refreshEngineContext();
  toast(`设备 ${d.serial} 档案已保存`, 'ok');
}

async function removeDevice(d: Device): Promise<void> {
  if (!confirm(`删除设备 ${d.serial}？`)) return;
  await idb.delete('devices', d.id);
  store.update({ devices: store.state.devices.filter((x) => x.id !== d.id) });
}

// ---------------- 照度 -> 亮度 锚点曲线（拖拽编辑） ----------------

function lightCurveCard(): HTMLElement {
  const sensor = getEngine()?.sensor ?? new AmbientSensor();
  const points: LightCurvePoint[] = sensor.state.curve.length ? sensor.state.curve.map((p) => ({ ...p })) : DEFAULT_LIGHT_CURVE.map((p) => ({ ...p }));
  const card = h('div', { class: 'card' }, h('h3', {}, '环境照度 → 输出亮度映射（拖动锚点，双击空白加点）'));
  const canvas = h('canvas', { class: 'curve-editor', width: 640, height: 280 }) as HTMLCanvasElement;
  card.append(canvas);
  const readout = h('div', { class: 'muted mono' }, '');
  card.append(readout,
    h('div', { class: 'row' },
      button('添加锚点', () => { points.push({ lux: 500, brightness: 0.7 }); sortAndDraw(); }),
      button('恢复默认曲线', () => { points.splice(0, points.length, ...DEFAULT_LIGHT_CURVE.map((p) => ({ ...p }))); sortAndDraw(); }),
      button('保存到传感器', () => {
        sensor.setCurve(points);
        getEngine()?.sensor.setCurve(points);
        toast('照度映射曲线已保存，断连时自动回退手动亮度', 'ok');
      }, 'primary'),
    ));

  let dragIdx = -1;
  const toXY = (p: LightCurvePoint) => ({
    x: 60 + (Math.log10(p.lux + 1) / Math.log10(100001)) * 540,
    y: 240 - p.brightness * 200,
  });
  const toLux = (x: number) => Math.round(Math.pow(10, ((x - 60) / 540) * Math.log10(100001)) - 1);
  const toBright = (y: number) => Math.max(0, Math.min(1, (240 - y) / 200));

  function sortAndDraw(): void {
    points.sort((a, b) => a.lux - b.lux);
    draw();
  }

  function draw(): void {
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, 640, 280);
    ctx.strokeStyle = '#1f3049';
    ctx.beginPath();
    for (let i = 0; i <= 4; i++) { const x = 60 + i * 135; ctx.moveTo(x, 30); ctx.lineTo(x, 240); }
    for (let i = 0; i <= 4; i++) { const y = 40 + i * 50; ctx.moveTo(60, y); ctx.lineTo(600, y); }
    ctx.stroke();
    ctx.fillStyle = '#64788f';
    ctx.font = '11px Consolas';
    ['1', '10', '100', '1k', '10k', '100k'].forEach((t, i) => ctx.fillText(t, 52 + i * 135, 256));
    ctx.fillText('lux →', 300, 272);
    ctx.save();
    ctx.translate(20, 140);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('亮度', 0, 0);
    ctx.restore();

    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((p, i) => { const { x, y } = toXY(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    points.forEach((p, i) => {
      const { x, y } = toXY(p);
      ctx.fillStyle = dragIdx === i ? '#fbbf24' : '#22d3ee';
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
    });
    readout.textContent = points.map((p) => `${p.lux}lux→${p.brightness.toFixed(2)}`).join('   ');
  }

  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 640;
    const y = ((e.clientY - rect.top) / rect.height) * 280;
    dragIdx = points.findIndex((p) => { const q = toXY(p); return Math.hypot(q.x - x, q.y - y) < 12; });
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragIdx < 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 640;
    const y = ((e.clientY - rect.top) / rect.height) * 280;
    points[dragIdx] = { lux: Math.max(0, toLux(x)), brightness: toBright(y) };
    sortAndDraw();
  });
  const endDrag = () => { dragIdx = -1; draw(); };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('dblclick', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 640;
    const y = ((e.clientY - rect.top) / rect.height) * 280;
    points.push({ lux: Math.max(0, toLux(x)), brightness: toBright(y) });
    sortAndDraw();
  });
  sortAndDraw();
  return card;
}

// ---------------- PWM 校准表管理 ----------------

function pwmCalibCard(): HTMLElement {
  const card = h('div', { class: 'card' }, h('h3', {}, 'PWM 占空比 → 感知亮度 校准表（逐通道）'));
  if (!store.state.pwmCalibs.length) {
    card.append(h('p', { class: 'muted' }, '尚未导入实测校准表，预览使用线性默认曲线。'));
  } else {
    card.append(h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '名称'), h('th', {}, '通道点数'), h('th', {}, '操作'))),
      h('tbody', {}, ...store.state.pwmCalibs.map((c) => h('tr', {},
        h('td', {}, c.name),
        h('td', { class: 'mono' }, `R${c.pointsR.length}/G${c.pointsG.length}/B${c.pointsB.length}`),
        h('td', {}, button('预览曲线', () => showCalibCurve(c), 'primary'), button('删除', () => void deleteCalib(c), 'danger')),
      )))));
  }
  card.append(h('div', { class: 'row' },
    button('生成线性默认表', () => void saveCalib(defaultLinearCalib())),
    h('span', { class: 'muted' }, 'CSV 表头：duty,r,g,b（支持 0..1 或 0..255）'),
  ));
  return card;
}

function showCalibCurve(c: PwmCalib): void {
  const canvas = h('canvas', { width: 600, height: 260 }) as HTMLCanvasElement;
  const body = h('div', {}, canvas);
  modal(`校准曲线 · ${c.name}`, body);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, 600, 260);
  const drawCh = (pts: { duty: number; luminance: number }[], color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => { const x = 40 + p.duty * 520; const y = 220 - p.luminance * 180; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  };
  drawCh(c.pointsR, '#f87171');
  drawCh(c.pointsG, '#34d399');
  drawCh(c.pointsB, '#60a5fa');
  ctx.fillStyle = '#9fb4cc';
  ctx.fillText('红=R  绿=G  蓝=B（横轴 PWM 占空比，纵轴感知亮度）', 40, 250);
}

async function importCalib(): Promise<void> {
  const input = h('input', {
    type: 'file', accept: '.csv,text/plain',
    onchange: async () => {
      const file = (input as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const calib = parsePwmCsv(await file.text(), file.name);
        await saveCalib(calib);
        toast(`校准表已导入：${calib.name}`, 'ok');
      } catch (e) {
        toast(`校准表解析失败：${(e as Error).message}`, 'error');
      }
    },
  });
  input.click();
}

async function saveCalib(calib: PwmCalib): Promise<void> {
  await idb.put('pwmCalibs', calib);
  store.update({ pwmCalibs: [...store.state.pwmCalibs.filter((c) => c.id !== calib.id), calib] });
  refreshEngineContext();
}

async function deleteCalib(c: PwmCalib): Promise<void> {
  await idb.delete('pwmCalibs', c.id);
  store.update({ pwmCalibs: store.state.pwmCalibs.filter((x) => x.id !== c.id) });
}

// ---------------- 风扇墙 ----------------

function wallCard(): HTMLElement {
  const card = h('div', { class: 'card' },
    h('div', { class: 'row' }, h('h3', { style: 'margin:0' }, '风扇墙编组（画面切块 / 相位差 / 单台漂移隔离）'),
      h('div', { class: 'spacer' }),
      button('新建风扇墙', () => openWallEditor(null), 'primary')),
  );
  if (!store.state.wallLayouts.length) {
    card.append(h('p', { class: 'muted' }, '还没有风扇墙布局。'));
    return card;
  }
  const headerRow = h('tr', {}, ...['名称', '行列', '间距', '台数', '操作'].map((t) => h('th', {}, t)));
  const bodyRows = store.state.wallLayouts.map((w) =>
    h('tr', {},
      h('td', {}, w.name),
      h('td', { class: 'mono' }, `${w.cols}×${w.rows}`),
      h('td', { class: 'mono' }, `${w.gapMm}mm`),
      h('td', { class: 'mono' }, String(w.cells.length)),
      h('td', {}, button('编辑', () => openWallEditor(w), 'primary'), button('删除', () => void removeWall(w), 'danger')),
    ),
  );
  card.append(h('table', {}, h('thead', {}, headerRow), h('tbody', {}, ...bodyRows)));
  return card;
}

function openWallEditor(existing: import('../../core/types').WallLayout | null): void {
  const wall: import('../../core/types').WallLayout = existing ?? {
    id: uid('wall'),
    name: `风扇墙 ${store.state.wallLayouts.length + 1}`,
    cols: 2, rows: 2, gapMm: 20, fanDiameterMm: store.state.devices[0]?.bladeDiameterMm ?? 420,
    cells: [], updatedAt: Date.now(),
  };
  const body = h('div', {},
    h('div', { class: 'grid grid-3' },
      textField('名称', wall.name, (v) => { wall.name = v; }),
      textField('列数', String(wall.cols), (v) => { wall.cols = Math.max(1, parseInt(v) || 1); }),
      textField('行数', String(wall.rows), (v) => { wall.rows = Math.max(1, parseInt(v) || 1); }),
      textField('台间距 mm', String(wall.gapMm), (v) => { wall.gapMm = parseFloat(v) || 0; }),
      textField('扇叶直径 mm', String(wall.fanDiameterMm), (v) => { wall.fanDiameterMm = parseFloat(v) || 420; }),
    ),
    button('按行列自动分配设备并生成相位差', () => autoCells(wall), 'primary'),
    h('div', { id: 'wall-cells', class: 'grid', style: 'margin-top:12px' }),
  );
  const m = modal('风扇墙布局', body, h('div', { class: 'row' },
    button('取消', () => m.close()),
    button('保存', () => { void saveWall(wall); m.close(); }, 'primary')));
  renderWallCells(wall);
}

function autoCells(wall: import('../../core/types').WallLayout): void {
  wall.cells = [];
  const devs = store.state.devices;
  let n = 0;
  for (let r = 0; r < wall.rows; r++) {
    for (let c = 0; c < wall.cols; c++) {
      const deviceId = devs[n % Math.max(1, devs.length)]?.id ?? uid('virtual-dev');
      // 相邻台相位差按几何位置补偿，保证拼缝灯珠轨迹衔接不重叠不留缝
      const phaseOffsetDeg = (c * 90 + r * 45) % 360;
      wall.cells.push({ deviceId, col: c, row: r, phaseOffsetDeg, driftOverride: null });
      n++;
    }
  }
  renderWallCells(wall);
  toast(`已生成 ${wall.cells.length} 个分块，单台漂移仅重算对应块`, 'ok');
}

function renderWallCells(wall: import('../../core/types').WallLayout): void {
  const host = document.getElementById('wall-cells');
  if (!host) return;
  host.replaceChildren(...wall.cells.map((cell, i) => h('div', { class: 'row', style: 'padding:6px;border:1px solid var(--line);border-radius:8px' },
    h('span', { class: 'tag' }, `块${i + 1} (${cell.col},${cell.row})`),
    selectField('设备', store.state.devices.map((d) => ({ value: d.id, text: d.serial })), cell.deviceId, (v) => { cell.deviceId = v; }),
    slider({ min: 0, max: 359, step: 1, value: cell.phaseOffsetDeg, label: '相位差°', format: (v) => `${v}°`, onInput: (v) => { cell.phaseOffsetDeg = v; } }),
    slider({ min: 0, max: 60, step: 1, value: cell.driftOverride ?? 0, label: '该台漂移', format: (v) => v ? `±${v}` : '默认', onInput: (v) => { cell.driftOverride = v || null; } }),
  )));
}

async function saveWall(wall: import('../../core/types').WallLayout): Promise<void> {
  wall.updatedAt = Date.now();
  await idb.put('wallLayouts', wall);
  store.update({ wallLayouts: [...store.state.wallLayouts.filter((w) => w.id !== wall.id), wall] });
  refreshEngineContext();
  toast('风扇墙布局已保存', 'ok');
}

async function removeWall(w: import('../../core/types').WallLayout): Promise<void> {
  if (!confirm(`删除风扇墙 ${w.name}？`)) return;
  await idb.delete('wallLayouts', w.id);
  store.update({ wallLayouts: store.state.wallLayouts.filter((x) => x.id !== w.id) });
}
