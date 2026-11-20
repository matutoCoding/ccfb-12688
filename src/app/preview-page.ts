import { h, clear, toast } from '../lib/dom';
import { store } from '../lib/store';
import { pageHeader, emptyState } from './shell';
import { PreviewEngine } from '../render/preview-engine';
import { RPM_MIN, RPM_MAX } from '../lib/telemetry';
import { navigate } from './router';
import { buildPacket } from '../lib/export';
import type { Project } from '../types';

let engine: PreviewEngine | null = null;

export function previewPage(): HTMLElement {
  const root = h('div', {});
  const project = store.currentProject;
  const device = store.currentDevice;

  if (!project || !device) {
    clear(root);
    root.appendChild(pageHeader('预览台', '按真实旋转周期刷新，视觉暂留还原真机成像'));
    root.appendChild(emptyState('请先在「画布编排」打开工程，并在「设备设置」选择一台设备。'));
    root.appendChild(h('div', { class: 'pill-group', style: 'margin-top:14px' },
      h('button', { class: 'primary', onclick: () => navigate('/canvas') }, '去画布编排'),
      h('button', { onclick: () => navigate('/devices') }, '去设备设置'),
    ));
    return root;
  }

  root.appendChild(pageHeader('预览台', '固定时间步仿真 + 实测周期扇形映射：拖动转速无抖动、无频闪，成像与真机一致'));

  const canvas = h('canvas', { width: '720', height: '720' }) as HTMLCanvasElement;
  const alertBox = h('div', { class: 'preview-alert' }, h('span', {}, '⛔'), h('span', {}, '环境光传感器断连：已回退手动亮度，断连时段记入设备日志'));
  const stage = h('div', { class: 'preview-stage' }, alertBox, canvas);

  // 状态读数
  const rpmRead = h('span', { class: 'stat-big' });
  const periodRead = h('span', { class: 'mono' });
  const brightRead = h('span', { class: 'mono' });
  const sensorDot = h('span', { class: 'led-dot on' });

  engine = new PreviewEngine(canvas);
  engine.attach(project, device);
  engine.onSensorEvent = (m) => toast(m, 'warn');
  engine.onStats = (s) => {
    rpmRead.textContent = s.measuredRpm.toFixed(1);
    periodRead.textContent = `${s.periodMs.toFixed(2)} ms/圈`;
    const connected = engine?.state.sensorConnected ?? true;
    alertBox.classList.toggle('show', !connected);
    sensorDot.className = `led-dot ${connected ? 'on' : 'off'}`;
    brightRead.textContent = `${((engine?.state.outputBrightness ?? 0) * 100).toFixed(0)}%`;
  };

  // 控件
  const rpmSlider = h('input', {
    type: 'range', min: String(RPM_MIN), max: String(RPM_MAX), step: '1', value: String(engine.state.rpm),
    oninput: () => { rpmVal.textContent = `${rpmSlider.value} rpm`; engine?.setRpm(Number(rpmSlider.value)); },
  }) as HTMLInputElement;
  const rpmVal = h('span', {}, `${engine.state.rpm} rpm`);

  const dirBtns = h('div', { class: 'pill-group' },
    h('button', { class: 'on', onclick: () => { engine?.setDirection('cw'); mark(dirBtns, 0); } }, '顺时针 CW'),
    h('button', { onclick: () => { engine?.setDirection('ccw'); mark(dirBtns, 1); } }, '逆时针 CCW'),
  );

  const playBtn = h('button', {
    onclick: () => { if (!engine) return; engine.state.running = !engine.state.running; playBtn.textContent = engine.state.running ? '⏸ 暂停' : '▶ 播放'; },
  }, '⏸ 暂停');

  const driftBtn = h('button', {
    class: 'on',
    onclick: () => { if (!engine) return; const on = !engine.state.driftEnabled; engine.setDrift(on); driftBtn.classList.toggle('on', on); driftBtn.textContent = on ? '电压漂移：开' : '电压漂移：关'; },
  }, '电压漂移：开');

  const jumpBtn = h('button', {
    onclick: () => {
      if (!engine) return;
      const target = engine.state.rpm > 1000 ? RPM_MIN + 120 : RPM_MAX - 200;
      engine.injectVoltageJump(target);
      toast(`注入电压突变 → 瞬时 ${target} rpm，扇形映射保证画面不拉伸`, 'warn');
    },
  }, '⚡ 注入转速突变');

  const splitBtn = h('button', {
    onclick: () => { if (!engine) return; engine.state.splitCalibration = !engine.state.splitCalibration; splitBtn.classList.toggle('on', engine.state.splitCalibration); },
  }, '校正前后分屏对比');

  const calibBtn = h('button', {
    class: 'on',
    onclick: () => { if (!engine) return; engine.calibrated = !engine.calibrated; calibBtn.classList.toggle('on', engine.calibrated); },
  }, 'PWM 校正：开');

  const luxSlider = h('input', { type: 'range', min: '0', max: '2000', step: '5', value: String(engine.state.ambientLux), oninput: () => { luxVal.textContent = `${luxSlider.value} lux`; engine?.setAmbientLux(Number(luxSlider.value)); } }) as HTMLInputElement;
  const luxVal = h('span', {}, `${engine.state.ambientLux} lux`);

  const sensorBtn = h('button', {
    onclick: () => engine?.setSensorConnected(!engine.state.sensorConnected),
  }, '模拟传感器断连');

  // 安全扫描（导出前在预览里红标越界）
  const scanBtn = h('button', {
    onclick: async () => {
      if (!engine) return;
      const mask = await scanSafety(project);
      engine.setSafetyMask(mask);
      if (mask) toast('检测到越界灯珠，已在预览中红色标注（详见导出中心帧号）', 'warn');
      else toast('安全半径扫描通过，无越界像素', 'info');
    },
  }, '扫描扇叶安全半径');
  const clearMaskBtn = h('button', { onclick: () => engine?.setSafetyMask(null) }, '清除红标');

  const panel = h('div', { class: 'card' },
    h('h3', {}, '运行控制'),
    statRow('实测转速', rpmRead),
    statRow('每圈周期', periodRead),
    statRow('输出亮度', brightRead),
    statRow('传感器', sensorDot),
    h('div', { class: 'ctrl-row' }, h('div', { class: 'inline' }, h('span', {}, '转速滑杆'), rpmVal), rpmSlider),
    h('div', { class: 'ctrl-row' }, h('label', {}, '旋转方向'), dirBtns),
    h('div', { class: 'pill-group', style: 'margin-bottom:14px' }, playBtn, driftBtn),
    h('div', { class: 'ctrl-row' }, jumpBtn),
    h('div', { class: 'ctrl-row' }, h('label', {}, '灯珠校正'), h('div', { class: 'pill-group' }, calibBtn, splitBtn)),
    h('div', { class: 'ctrl-row' }, h('div', { class: 'inline' }, h('span', {}, '现场照度'), luxVal), luxSlider),
    h('div', { class: 'ctrl-row' }, sensorBtn),
    h('div', { class: 'ctrl-row' }, h('label', {}, '安全检查'), h('div', { class: 'pill-group' }, scanBtn, clearMaskBtn)),
    h('p', { class: 'sub muted' }, '余晖时间常数 50ms、仿真 240Hz 固定子步；rAF 仅负责呈现，因此转速拖动与显示器刷新不会产生拍频频闪。'),
  );

  root.appendChild(h('div', { class: 'preview-layout' }, stage, panel));
  engine.start();
  return root;
}

/** 路由切走预览台时释放 WebGL 资源与 rAF */
export function disposePreview(): void {
  engine?.dispose();
  engine = null;
}

function mark(group: HTMLElement, activeIndex: number): void {
  [...group.children].forEach((c, i) => c.classList.toggle('on', i === activeIndex));
}

function statRow(label: string, valueEl: HTMLElement): HTMLElement {
  return h('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)' },
    h('span', { class: 'muted' }, label), h('strong', {}, valueEl));
}

/** 预览态安全扫描：用当前工程生成一帧合成条带后走 buildPacket 的同一套判定 */
async function scanSafety(project: Project): Promise<Uint8Array | null> {
  // 简化：以黑底+占位区域生成一帧（真实导出在导出中心逐帧扫描，逻辑共用 buildPacket）
  const fpr = project.framesPerRevolution;
  const led = project.ledCount;
  const frame = new Uint8ClampedArray(led * 4);
  for (const item of project.items) {
    const x0 = Math.round(item.r0 * led), x1 = Math.round(item.r1 * led);
    for (let x = x0; x < x1; x++) frame[x * 4] = frame[x * 4 + 1] = frame[x * 4 + 2] = 200;
  }
  const safeRadius = 0.92;
  const result = buildPacket(
    Array.from({ length: fpr }, () => frame),
    led,
    fpr,
    safeRadius,
    project.name,
  );
  return result.info.safetyViolations.length ? result.violationMask : null;
}
