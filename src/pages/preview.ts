/**
 * 预览台（功能点 2、3、5）：
 * - 按真实旋转周期刷新：相位累加 + 角速度指数平滑，300–1800 RPM，顺/逆时针
 * - 模拟编码器实测周期回传：电压波动下每圈周期漂移，画面按扇形角区间动态映射，
 *   转速突变不拉伸不压缩（内容锁定角度而非帧序号）
 * - PWM 占空比→感知亮度非线性校正曲线，可导入实测校准表（CSV），校正前后分屏对比
 * - 环境光传感器：照度→亮度映射（设备档案曲线），断连回退手动亮度 + 告警 + 写设备日志
 */

import { Compositor } from '../compositor';
import { createCurveEditor } from '../components/curveEditor';
import { getAll, getById, put } from '../db';
import { PovRenderer } from '../gl/renderer';
import { store } from '../store';
import { Clip, DeviceProfile, Project } from '../types';
import { clamp, el, interpCurve, pickFile } from '../util';

const TAU = Math.PI * 2;

export class PreviewPage {
  el = el('div', { class: 'layout-2' });
  private canvas = el('canvas', { style: 'width:100%;aspect-ratio:1/1;display:block;border-radius:10px;background:#000' }) as HTMLCanvasElement;
  private renderer: PovRenderer;
  private compositor = new Compositor(1024);
  private raf = 0;
  private lastTs = 0;
  private destroyed = false;

  // 旋转状态（功能点 3）
  private phase = 0;
  private omega = (900 / 60) * TAU; // 当前角速度（平滑后）
  private targetRpm = 900;
  private direction: 1 | -1 = 1;    // 1=逆时针 -1=顺时针
  private persistence = 0.1;
  private fluctuation = false;
  private simTime = 0;
  private measuredRpm = 900;

  // 设备与环境（功能点 2、5、6）
  private devices: DeviceProfile[] = [];
  private device: DeviceProfile | null = null;
  private project: Project | null = null;
  private sensorConnected = true;
  private sensorLux = 800;
  private disconnectSince: number | null = null;

  // PWM（功能点 2）
  private pwmChannel: 0 | 1 | 2 = 0;
  private splitCompare = false;

  // 安全半径（功能点 7 预览侧）
  private showUnsafe = false;
  private safeRadius = 0.92;

  private rightCol = el('div', { class: 'stack' });
  private alertSlot = el('div');
  private rpmReadout = el('span', { class: 'mono' });
  private brightnessReadout = el('span', { class: 'mono' });
  private unsubs: (() => void)[] = [];

  constructor() {
    this.renderer = new PovRenderer(this.canvas);
    const leftPanel = el('div', { class: 'panel stack' });
    leftPanel.append(this.alertSlot, this.canvas);
    this.el.append(leftPanel, this.rightCol);
    void this.init();
  }

  private async init(): Promise<void> {
    this.devices = await getAll<DeviceProfile>('devices');
    this.device = this.devices.find((d) => d.id === store.currentDeviceId) ?? this.devices[0] ?? null;
    if (this.device) {
      this.sensorConnected = this.device.sensorConnected;
      void store.setCurrentDevice(this.device.id);
    }
    await this.loadProject();
    this.buildControls();
    this.unsubs.push(store.on('project', () => void this.loadProject()));
    this.unsubs.push(store.on('device', () => void this.reloadDevice()));
    this.lastTs = performance.now();
    const loop = (ts: number) => {
      if (this.destroyed) return;
      this.tick(ts);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private async loadProject(): Promise<void> {
    this.project = store.currentProjectId
      ? (await getById<Project>('projects', store.currentProjectId)) ?? null
      : null;
    await this.compositor.setProject(this.project);
    await this.applyActiveLut();
  }

  private async reloadDevice(): Promise<void> {
    this.devices = await getAll<DeviceProfile>('devices');
    this.device = this.devices.find((d) => d.id === store.currentDeviceId) ?? this.device;
    this.buildControls();
  }

  /** 工程内第一个启用了调色方案的片段 → 预览台实时套用 LUT */
  private async applyActiveLut(): Promise<void> {
    if (!this.project) { this.renderer.setLut(null); return; }
    for (const slot of this.project.slots) {
      if (!slot.clipId) continue;
      const clip = await getById<Clip>('clips', slot.clipId);
      const grade = clip?.grades.find((g) => g.id === clip.activeGradeId);
      if (grade?.lutData && grade.lutSize) {
        this.renderer.setLut({ size: grade.lutSize, data: grade.lutData, title: grade.name });
        return;
      }
    }
    this.renderer.setLut(null);
  }

  // ---------------- 主循环：稳定性的关键 ----------------
  private tick(ts: number): void {
    const dt = clamp((ts - this.lastTs) / 1000, 0, 0.1);
    this.lastTs = ts;
    this.simTime += dt;

    // 目标角速度；电压波动模拟：多频正弦扰动（±5%）
    let rpm = this.targetRpm;
    if (this.fluctuation) {
      rpm *= 1 + 0.035 * Math.sin(TAU * 0.4 * this.simTime) + 0.015 * Math.sin(TAU * 1.7 * this.simTime + 1.3);
    }
    const targetOmega = (rpm / 60) * TAU * this.direction;
    // 指数平滑：拖滑杆/转速突变时角速度连续过渡，相位不跳变 → 不抖不频闪
    this.omega += (targetOmega - this.omega) * (1 - Math.exp(-dt / 0.25));
    this.phase = (this.phase + this.omega * dt) % TAU;

    // 模拟编码器回传：按实测周期显示（带量化噪声）
    const instantRpm = (Math.abs(this.omega) / TAU) * 60;
    this.measuredRpm += (instantRpm - this.measuredRpm) * 0.2;
    const jitter = this.fluctuation ? (Math.random() - 0.5) * 1.2 : 0;
    this.rpmReadout.textContent = `实测 ${(this.measuredRpm + jitter).toFixed(1)} RPM · 周期 ${(60000 / Math.max(this.measuredRpm, 1)).toFixed(1)} ms`;

    // 内容帧
    this.compositor.draw(this.simTime);
    this.renderer.setContent(this.compositor.canvas);

    // 亮度：环境光曲线 or 手动回退（功能点 5）
    const d = this.device;
    let brightness = 1;
    if (d) {
      brightness = this.sensorConnected
        ? interpCurve(d.ambientCurve.map((p) => ({ x: p.lux, y: p.brightness })), this.sensorLux)
        : d.manualBrightness;
    }
    this.brightnessReadout.textContent = `输出亮度 ${(brightness * 100).toFixed(0)}%（${this.sensorConnected ? `照度 ${Math.round(this.sensorLux)} lux` : '手动回退'}）`;

    const wb = d?.whiteBalance ?? { r: 1, g: 1, b: 1, master: 1 };
    this.renderer.render({
      phase: this.phase,
      omega: this.omega,
      omegaDir: this.direction,
      persistence: this.persistence,
      ledCount: d?.ledCount ?? 224,
      sectorsPerRev: d?.sectorsPerRev ?? 256,
      attitude: ((d?.attitudeAngle ?? 0) * Math.PI) / 180,
      brightness,
      whiteBalance: [wb.r * wb.master, wb.g * wb.master, wb.b * wb.master],
      pwmEnabled: store.pwm.enabled,
      splitCompare: this.splitCompare,
      showUnsafe: this.showUnsafe,
      safeRadius: this.safeRadius,
      exposure: 1.4,
    });
  }

  // ---------------- 控制面板 ----------------
  private buildControls(): void {
    this.rightCol.replaceChildren();
    this.renderAlert();

    // 设备选择
    const devPanel = el('div', { class: 'panel stack', style: 'gap:8px' });
    devPanel.append(el('h3', {}, '目标设备'));
    const sel = el('select') as HTMLSelectElement;
    for (const d of this.devices) {
      const opt = el('option', { value: d.id }, `${d.name}（${d.serial}）`);
      if (d.id === this.device?.id) opt.selected = true;
      sel.append(opt);
    }
    if (!this.devices.length) sel.append(el('option', {}, '（未登记设备，使用默认参数）'));
    sel.onchange = async () => {
      this.device = this.devices.find((d) => d.id === sel.value) ?? null;
      if (this.device) {
        this.sensorConnected = this.device.sensorConnected;
        await store.setCurrentDevice(this.device.id);
      }
      this.buildControls();
    };
    devPanel.append(sel);
    if (this.device) {
      const d = this.device;
      devPanel.append(el('div', { class: 'dim', style: 'font-size:12px' },
        `直径 ${d.diameter}mm · ${d.ledCount} 灯珠 · ${d.sectorsPerRev} 分区/圈 · 姿态角 ${d.attitudeAngle}°（已自动补偿）` +
        ` · 白平衡 R${d.whiteBalance.r.toFixed(2)} G${d.whiteBalance.g.toFixed(2)} B${d.whiteBalance.b.toFixed(2)}`));
    }
    this.rightCol.append(devPanel);

    // 转速（功能点 3）
    const rpmPanel = el('div', { class: 'panel stack', style: 'gap:8px' });
    rpmPanel.append(el('h3', {}, '旋转'));
    const rpmSlider = el('input', { type: 'range', min: '300', max: '1800', step: '1', value: String(this.targetRpm), style: 'width:100%' }) as HTMLInputElement;
    const rpmLabel = el('div', { class: 'row' });
    const rpmVal = el('span', { class: 'mono' }, `${this.targetRpm} RPM`);
    rpmSlider.oninput = () => {
      this.targetRpm = Number(rpmSlider.value);
      rpmVal.textContent = `${this.targetRpm} RPM`;
    };
    rpmLabel.append(rpmVal, this.rpmReadout);
    rpmPanel.append(rpmSlider, rpmLabel);
    const dirRow = el('div', { class: 'row' });
    const ccw = el('button', { class: this.direction === 1 ? 'primary' : '' }, '逆时针');
    const cw = el('button', { class: this.direction === -1 ? 'primary' : '' }, '顺时针');
    ccw.onclick = () => { this.direction = 1; this.buildControls(); };
    cw.onclick = () => { this.direction = -1; this.buildControls(); };
    const flucLabel = el('label', { class: 'row', style: 'gap:4px' });
    const fluc = el('input', { type: 'checkbox' }) as HTMLInputElement;
    fluc.checked = this.fluctuation;
    fluc.onchange = () => { this.fluctuation = fluc.checked; };
    flucLabel.append(fluc, '模拟电压波动');
    const surge = el('button', {}, '转速突变测试');
    surge.title = '目标转速阶跃变化，验证成像不拉伸不压缩';
    surge.onclick = () => {
      this.targetRpm = this.targetRpm < 1000 ? 1500 : 600;
      rpmSlider.value = String(this.targetRpm);
      rpmVal.textContent = `${this.targetRpm} RPM`;
    };
    dirRow.append(ccw, cw, flucLabel, surge);
    rpmPanel.append(dirRow);
    const persRow = el('div', { class: 'row' });
    const pers = el('input', { type: 'range', min: '0.03', max: '0.25', step: '0.005', value: String(this.persistence), style: 'width:160px' }) as HTMLInputElement;
    const persVal = el('span', { class: 'mono dim' }, `余辉 ${(this.persistence * 1000).toFixed(0)}ms`);
    pers.oninput = () => { this.persistence = Number(pers.value); persVal.textContent = `余辉 ${(this.persistence * 1000).toFixed(0)}ms`; };
    persRow.append(el('span', { class: 'dim' }, '视觉暂留:'), pers, persVal);
    rpmPanel.append(persRow);
    this.rightCol.append(rpmPanel);

    // 环境光（功能点 5）
    const ambPanel = el('div', { class: 'panel stack', style: 'gap:8px' });
    ambPanel.append(el('h3', {}, '环境光传感器'));
    const luxSlider = el('input', { type: 'range', min: '1', max: '100000', step: '1', value: String(this.sensorLux), style: 'width:100%' }) as HTMLInputElement;
    const luxLabel = el('div', { class: 'row mono dim' });
    const updateLuxLabel = () => {
      luxLabel.replaceChildren(el('span', {}, `现场照度 ${Math.round(this.sensorLux)} lux`), this.brightnessReadout);
    };
    luxSlider.oninput = () => { this.sensorLux = Number(luxSlider.value); updateLuxLabel(); };
    updateLuxLabel();
    const connRow = el('div', { class: 'row' });
    const connBtn = el('button', {}, this.sensorConnected ? '断开传感器（模拟）' : '重连传感器');
    connBtn.onclick = () => void this.toggleSensor();
    connRow.append(connBtn);
    ambPanel.append(luxSlider, luxLabel, connRow);
    this.rightCol.append(ambPanel);

    // PWM 校正（功能点 2）
    const pwmPanel = el('div', { class: 'panel stack', style: 'gap:8px' });
    const pwmHead = el('div', { class: 'row' });
    pwmHead.append(el('h3', { class: 'grow' }, 'PWM 占空比 → 感知亮度校正'));
    const pwmToggle = el('input', { type: 'checkbox' }) as HTMLInputElement;
    pwmToggle.checked = store.pwm.enabled;
    pwmToggle.onchange = () => void store.setPwm({ ...store.pwm, enabled: pwmToggle.checked });
    pwmHead.append(el('span', { class: 'dim' }, '启用'), pwmToggle);
    pwmPanel.append(pwmHead);
    const chRow = el('div', { class: 'row' });
    (['R', 'G', 'B'] as const).forEach((name, i) => {
      const b = el('button', { class: this.pwmChannel === i ? 'primary' : '' }, name);
      b.onclick = () => { this.pwmChannel = i as 0 | 1 | 2; this.buildControls(); };
      chRow.append(b);
    });
    const importCal = el('button', {}, '导入实测校准表');
    importCal.title = 'CSV：占空比(0-1),亮度(0-1) 两列，自动插值到 256 级';
    importCal.onclick = () => void this.importPwmTable();
    const splitBtn = el('button', { class: this.splitCompare ? 'primary' : '' }, '分屏对比');
    splitBtn.onclick = () => { this.splitCompare = !this.splitCompare; this.buildControls(); };
    chRow.append(importCal, splitBtn);
    pwmPanel.append(chRow);
    const curveKey = (['r', 'g', 'b'] as const)[this.pwmChannel];
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < 256; i += 15) pts.push({ x: i / 255, y: store.pwm[curveKey][i] });
    pts.push({ x: 1, y: store.pwm[curveKey][255] });
    const editor = createCurveEditor({
      xMin: 0, xMax: 1, xLabel: '占空比', yLabel: '感知亮度', points: pts,
      onChange: (newPts) => {
        const curve = new Float32Array(256);
        for (let i = 0; i < 256; i++) curve[i] = interpCurve(newPts, i / 255);
        const pwm = { ...store.pwm, [curveKey]: curve };
        void store.setPwm(pwm);
        this.renderer.setPwmCurves([pwm.r, pwm.g, pwm.b]);
      },
    });
    pwmPanel.append(editor.el);
    pwmPanel.append(el('div', { class: 'dim', style: 'font-size:12px' }, '点击空白添加锚点，拖拽调整，右键删除。分屏对比：左=校正后，右=校正前。'));
    this.rightCol.append(pwmPanel);

    // 安全半径（功能点 7 预览侧）
    const safePanel = el('div', { class: 'panel stack', style: 'gap:8px' });
    safePanel.append(el('h3', {}, '扇叶安全半径'));
    const safeRow = el('div', { class: 'row' });
    const safeSlider = el('input', { type: 'range', min: '0.5', max: '1', step: '0.01', value: String(this.safeRadius) }) as HTMLInputElement;
    const safeVal = el('span', { class: 'mono dim' }, `${(this.safeRadius * 100).toFixed(0)}%`);
    safeSlider.oninput = () => { this.safeRadius = Number(safeSlider.value); safeVal.textContent = `${(this.safeRadius * 100).toFixed(0)}%`; };
    const showBtn = el('button', { class: this.showUnsafe ? 'primary' : '' }, '标出越界');
    showBtn.onclick = () => { this.showUnsafe = !this.showUnsafe; this.buildControls(); };
    safeRow.append(safeSlider, safeVal, showBtn);
    safePanel.append(safeRow);
    this.rightCol.append(safePanel);

    // 初始 PWM 曲线上传
    this.renderer.setPwmCurves([store.pwm.r, store.pwm.g, store.pwm.b]);
  }

  private renderAlert(): void {
    this.alertSlot.replaceChildren();
    if (!this.sensorConnected) {
      this.alertSlot.append(el('div', { class: 'banner danger' },
        `⚠ 环境光传感器断连${this.disconnectSince ? `（${new Date(this.disconnectSince).toLocaleTimeString()} 起）` : ''}，已回退到手动亮度 ${((this.device?.manualBrightness ?? 1) * 100).toFixed(0)}%，断连时段已记入设备日志。`));
    }
  }

  private async toggleSensor(): Promise<void> {
    this.sensorConnected = !this.sensorConnected;
    if (this.device) {
      this.device.sensorConnected = this.sensorConnected;
      if (!this.sensorConnected) {
        this.disconnectSince = Date.now();
        this.device.log.push({ ts: this.disconnectSince, type: 'sensor', message: '环境光传感器断连，回退手动亮度' });
      } else {
        const dur = this.disconnectSince ? `，断连时长 ${((Date.now() - this.disconnectSince) / 1000).toFixed(0)}s` : '';
        this.device.log.push({ ts: Date.now(), type: 'sensor', message: `传感器恢复连接${dur}` });
        this.disconnectSince = null;
      }
      await put('devices', this.device);
    }
    this.renderAlert();
    this.buildControls();
  }

  /** 导入实测校准表 CSV：两列 占空比,亮度 */
  private async importPwmTable(): Promise<void> {
    const files = await pickFile('.csv,text/csv');
    if (!files.length) return;
    const text = await files[0].text();
    const pts: { x: number; y: number }[] = [];
    for (const line of text.split(/\r?\n/)) {
      const parts = line.split(/[,\t]/).map((s) => parseFloat(s.trim()));
      if (parts.length >= 2 && isFinite(parts[0]) && isFinite(parts[1])) {
        pts.push({ x: clamp(parts[0] > 1 ? parts[0] / 255 : parts[0], 0, 1), y: clamp(parts[1] > 1 ? parts[1] / 255 : parts[1], 0, 1) });
      }
    }
    if (pts.length < 2) return;
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) curve[i] = interpCurve(pts, i / 255);
    const key = (['r', 'g', 'b'] as const)[this.pwmChannel];
    const pwm = { ...store.pwm, [key]: curve };
    await store.setPwm(pwm);
    this.renderer.setPwmCurves([pwm.r, pwm.g, pwm.b]);
    this.buildControls();
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.unsubs.forEach((u) => u());
    this.compositor.destroy();
    this.renderer.destroy();
  }
}
