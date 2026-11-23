// 预览台：真实旋转周期刷新、300~1800rpm 滑杆、顺/逆时针、视觉暂留成像
// 页面外壳只构建一次，数值由 rAF 回调局部更新，避免重渲染打断动画（防抖动）
import { button, clear, h, selectField, slider, toast } from '../dom';
import { store } from '../../core/store';
import { ensureEngine, refreshEngineContext } from '../../sim/engineContext';
import { formatClock } from '../../core/mathutil';
import type { PreviewEngine } from '../../sim/PreviewEngine';
import type { RotationDirection } from '../../core/types';

export function renderPreviewPage(root: HTMLElement): void {
  clear(root);
  const project = store.state.projects.find((p) => p.id === store.state.currentProjectId) ?? null;

  const canvas = h('canvas', { style: 'width:min(68vh,100%);aspect-ratio:1' }) as HTMLCanvasElement;
  const stage = h('div', { class: 'preview-stage' }, canvas);

  const measured = h('b', { class: 'mono' }, '—');
  const phase = h('b', { class: 'mono' }, '—');
  const lux = h('b', { class: 'mono' }, '—');
  const bright = h('b', { class: 'mono' }, '—');
  const contentT = h('b', { class: 'mono' }, '00:00.000');
  const alertBox = h('div', { style: 'min-height:38px' });

  const side = h('div', { class: 'card', style: 'width:340px;flex:none' });
  const layout = h('div', { class: 'row', style: 'align-items:stretch' }, h('div', { style: 'flex:1;min-width:0' }, stage), side);

  root.append(
    h('div', { class: 'page-head' },
      h('h2', {}, '预览台'),
      h('span', { class: 'sub' }, '按真实旋转周期与视觉暂留成像，拖动转速不抖不闪'),
    ),
    alertBox,
    layout,
  );

  const p = store.state.preview;
  let engine: PreviewEngine | null = null;

  const rpmSlider = slider({
    min: 300, max: 1800, step: 1, value: p.rpm,
    label: '目标转速 rpm',
    format: (v) => `${v} rpm`,
    onInput: (v) => {
      store.patchPreview({ rpm: v });
      engine?.setRpm(v); // 只改角速度，不重置相位/时间线
    },
  });
  const tauSlider = slider({
    min: 4, max: 80, step: 1, value: p.persistenceMs,
    label: '视觉暂留 τ(ms)',
    format: (v) => `${v} ms`,
    onInput: (v) => {
      store.patchPreview({ persistenceMs: v });
      engine?.setPersistenceMs(v);
    },
  });

  const dirBtn = button(p.direction === 1 ? '当前：顺时针 ↻' : '当前：逆时针 ↺', () => {
    const d = (store.state.preview.direction === 1 ? -1 : 1) as RotationDirection;
    store.patchPreview({ direction: d });
    engine?.setDirection(d);
    dirBtn.textContent = d === 1 ? '当前：顺时针 ↻' : '当前：逆时针 ↺';
  }, 'primary');

  const toggle = (label: string, key: 'calibEnabled' | 'splitCompare' | 'ambientAuto' | 'showSafety', fn: (v: boolean) => void) => {
    const input = h('input', { type: 'checkbox', checked: store.state.preview[key] ? true : false,
      onchange: () => { const v = (input as HTMLInputElement).checked; store.patchPreview({ [key]: v } as never); fn(v); } });
    return h('label', { class: 'row' }, h('span', { class: 'switch' }, input, h('i', {})), label);
  };

  const deviceSel = selectField(
    '预览设备',
    store.state.devices.length ? store.state.devices.map((d) => ({ value: d.id, text: `${d.serial} · ${d.name}` })) : [{ value: '', text: '未登记设备（通用模拟）' }],
    store.state.devices[0]?.id ?? '',
    () => { refreshEngineContext(); rebindSensor(); },
  );
  const wallSel = selectField(
    '风扇墙',
    [{ value: '', text: '单机预览' }, ...store.state.wallLayouts.map((w) => ({ value: w.id, text: w.name }))],
    store.state.preview.wallId ?? '',
    (v) => { store.patchPreview({ wallId: v || null }); refreshEngineContext(); },
  );

  side.append(
    h('h3', {}, '旋转控制'),
    rpmSlider,
    h('div', { class: 'row' }, dirBtn),
    tauSlider,
    h('hr', { style: 'border-color:var(--line)' }),
    h('h3', {}, '设备 / 墙'),
    deviceSel, wallSel,
    h('hr', { style: 'border-color:var(--line)' }),
    h('h3', {}, '校正与安全'),
    toggle('PWM 非线性校正', 'calibEnabled', (v) => engine?.setCalibEnabled(v)),
    toggle('校正前后分屏对比（左校正/右原始）', 'splitCompare', (v) => engine?.setSplitCompare(v)),
    toggle('环境光自动亮度', 'ambientAuto', (v) => engine?.setAmbientAuto(v)),
    toggle('安全半径越界红标', 'showSafety', (v) => engine?.setShowSafety(v)),
    h('hr', { style: 'border-color:var(--line)' }),
    h('h3', {}, '传感器模拟'),
    h('div', { class: 'row' },
      button('断开传感器', () => { engine?.sensor.disconnect(); }, 'danger'),
      button('恢复连接', () => engine?.sensor.connect()),
      button('Web Serial 接入', () => void serialConnect()),
    ),
    h('div', { class: 'row' },
      button('模拟夜间 50lux', () => engine?.sensor.feedLux(50)),
      button('模拟晴天 2000lux', () => engine?.sensor.feedLux(2000)),
    ),
    h('hr', { style: 'border-color:var(--line)' }),
    h('div', { class: 'grid grid-2' },
      kpi('实测转速', measured, 'rpm'),
      kpi('机械相位', phase, '°'),
      kpi('环境照度', lux, 'lux'),
      kpi('输出亮度', bright, ''),
      kpi('内容时间', contentT, ''),
    ),
    h('div', { class: 'row', style: 'margin-top:10px' },
      button('暂停/播放', () => pauseToggle()),
      button('复位相位', () => engine?.fanRenderer.reset()),
    ),
  );

  let paused = false;
  function pauseToggle(): void {
    paused = !paused;
    engine?.setPlaying(!paused);
  }

  async function serialConnect(): Promise<void> {
    const ok = await engine?.sensor.openSerial();
    if (!ok) toast('浏览器不支持 Web Serial 或连接被取消，继续使用内置模拟器', 'error');
    else toast('已接入真机环境光传感器', 'ok');
  }

  function rebindSensor(): void {
    if (!engine) return;
    engine.sensor.onChange = () => updateAlert();
    updateAlert();
  }

  function updateAlert(): void {
    if (!engine) return;
    alertBox.replaceChildren();
    const s = engine.sensor.state;
    if (!s.connected) {
      const outage = engine.sensor.outageMs();
      alertBox.append(h('div', { class: 'alert alert-danger' },
        '⚠ 环境光传感器断连：已回退到设备手动亮度，断连时段记入设备日志',
        h('span', { class: 'mono' }, `(${(outage / 1000).toFixed(1)}s)`)));
    } else if (!store.state.preview.ambientAuto) {
      alertBox.append(h('div', { class: 'alert alert-warn' }, '自动亮度已关闭，当前使用手动设定亮度'));
    } else {
      alertBox.append(h('div', { class: 'alert alert-ok' }, '传感器在线，亮度按照度锚点曲线自动调节'));
    }
  }

  void ensureEngine(canvas).then(async (e) => {
    engine = e;
    const assetMap = new Map(store.state.assets.map((a) => [a.id, { blob: a.blob, duration: a.duration, fps: a.fps }]));
    e.setProject(project, store.state.clips, assetMap);
    e.setMaterialBindings(store.state.materialBindings);
    refreshEngineContext();
    e.setRpm(store.state.preview.rpm);
    e.setDirection(store.state.preview.direction);
    e.setPersistenceMs(store.state.preview.persistenceMs);
    e.start();
    rebindSensor();

    e.setMeasuredHook((rpm, phaseDeg, brightness, luxVal) => {
      measured.textContent = rpm.toFixed(1);
      phase.textContent = phaseDeg.toFixed(1);
      lux.textContent = String(luxVal);
      bright.textContent = brightness.toFixed(3);
      contentT.textContent = formatClock(e.currentContentTime);
      updateAlertLite();
    });
  });

  let lastAlertState = true;
  function updateAlertLite(): void {
    const connected = engine?.sensor.state.connected ?? true;
    if (connected !== lastAlertState) {
      lastAlertState = connected;
      updateAlert();
    }
  }
}

function kpi(label: string, valueEl: HTMLElement, unit: string): HTMLElement {
  return h('div', { class: 'kpi' }, valueEl, h('span', {}, unit ? `${label} (${unit})` : label));
}
