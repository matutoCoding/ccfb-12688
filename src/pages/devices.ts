/**
 * 设备设置（功能点 4、5、6）：
 * - 设备登记：序列号、扇叶直径、灯珠数、安装场地、分组管理
 * - 姿态角（倒挂/侧装）自动旋转补偿，补偿角度写入设备档案
 * - 照度→亮度映射曲线多锚点拖拽编辑；断连回退手动亮度；断连记入设备日志
 * - 逐台 RGB 增益 + 总亮度白平衡，系数绑定序列号，导出下发时自动套用
 * - 档案导出/导入：换电脑载入档案文件恢复整套现场配置
 */

import { createCurveEditor } from '../components/curveEditor';
import { del, getAll, put } from '../db';
import { store } from '../store';
import { DeviceProfile, uid } from '../types';
import { downloadText, el, modal, pickFile } from '../util';

export class DevicesPage {
  el = el('div', { class: 'layout-2r' });
  private devices: DeviceProfile[] = [];
  private selected: DeviceProfile | null = null;
  private groupFilter = '全部';
  private leftPanel = el('div', { class: 'stack' });
  private rightPanel = el('div', { class: 'stack' });

  constructor() {
    this.el.append(this.leftPanel, this.rightPanel);
    void this.reload();
  }

  private async reload(): Promise<void> {
    this.devices = await getAll<DeviceProfile>('devices');
    if (!this.selected && this.devices.length) this.selected = this.devices[0];
    if (this.selected) this.selected = this.devices.find((d) => d.id === this.selected!.id) ?? null;
    this.renderLeft();
    this.renderRight();
  }

  private newDevice(): DeviceProfile {
    return {
      id: uid(), serial: `HF-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 9000) + 1000)}`,
      name: '新设备', group: '默认组', diameter: 650, ledCount: 224, sectorsPerRev: 256,
      site: '', attitudeAngle: 0,
      whiteBalance: { r: 1, g: 1, b: 1, master: 1 },
      ambientCurve: [
        { lux: 10, brightness: 0.15 }, { lux: 300, brightness: 0.45 },
        { lux: 3000, brightness: 0.75 }, { lux: 50000, brightness: 1 },
      ],
      manualBrightness: 0.7,
      sensorConnected: true,
      log: [{ ts: Date.now(), type: 'system', message: '设备建档' }],
      createdAt: Date.now(),
    };
  }

  // ---------------- 左：设备列表 + 分组 ----------------
  private renderLeft(): void {
    this.leftPanel.replaceChildren();
    const bar = el('div', { class: 'panel row' });
    const add = el('button', { class: 'primary' }, '登记设备');
    add.onclick = async () => {
      const d = this.newDevice();
      await put('devices', d);
      this.selected = d;
      await this.reload();
    };
    const expAll = el('button', {}, '导出档案文件');
    expAll.onclick = () => this.exportProfiles();
    const impAll = el('button', {}, '载入档案文件');
    impAll.onclick = () => void this.importProfiles();
    const groups = ['全部', ...new Set(this.devices.map((d) => d.group))];
    const gsel = el('select') as HTMLSelectElement;
    for (const g of groups) {
      const o = el('option', {}, g);
      if (g === this.groupFilter) o.selected = true;
      gsel.append(o);
    }
    gsel.onchange = () => { this.groupFilter = gsel.value; this.renderLeft(); };
    bar.append(add, expAll, impAll, el('span', { class: 'dim' }, '分组:'), gsel);
    this.leftPanel.append(bar);

    const list = el('div', { class: 'panel stack', style: 'gap:6px' });
    list.append(el('h3', {}, `设备（${this.devices.length}）`));
    for (const d of this.devices.filter((x) => this.groupFilter === '全部' || x.group === this.groupFilter)) {
      const row = el('div', { class: 'row' });
      const name = el('span', { class: 'grow' }, `${d.name} `);
      if (this.selected?.id === d.id) name.classList.add('ok');
      row.append(name, el('span', { class: 'tag' }, d.group), el('span', { class: 'mono dim', style: 'font-size:12px' }, d.serial));
      if (!d.sensorConnected) row.append(el('span', { class: 'tag', style: 'border-color:var(--danger);color:var(--danger)' }, '传感器断连'));
      row.style.cursor = 'pointer';
      row.onclick = () => { this.selected = d; this.renderLeft(); this.renderRight(); };
      list.append(row);
    }
    this.leftPanel.append(list);
  }

  // ---------------- 右：档案编辑 ----------------
  private renderRight(): void {
    this.rightPanel.replaceChildren();
    const d = this.selected;
    if (!d) {
      this.rightPanel.append(el('div', { class: 'panel' }, el('p', { class: 'dim' }, '请选择或登记一台设备。')));
      return;
    }
    const save = async () => { await put('devices', d); store.emit('device'); };

    // 基本信息
    const info = el('div', { class: 'panel stack', style: 'gap:10px' });
    info.append(el('h3', {}, `设备档案 — ${d.serial}`));
    const grid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px' });
    const field = (label: string, value: string, set: (v: string) => void, type = 'text') => {
      const input = el('input', { type, value }) as HTMLInputElement;
      input.onchange = async () => { set(input.value); await save(); this.renderLeft(); };
      const f = el('label', { class: 'field' }, label);
      f.append(input);
      return f;
    };
    grid.append(
      field('名称', d.name, (v) => (d.name = v)),
      field('序列号', d.serial, (v) => (d.serial = v)),
      field('分组', d.group, (v) => (d.group = v)),
      field('安装场地', d.site, (v) => (d.site = v)),
      field('扇叶直径 (mm)', String(d.diameter), (v) => (d.diameter = Number(v) || d.diameter), 'number'),
      field('灯珠数', String(d.ledCount), (v) => (d.ledCount = Number(v) || d.ledCount), 'number'),
      field('每圈分区数（编码器）', String(d.sectorsPerRev), (v) => (d.sectorsPerRev = Number(v) || d.sectorsPerRev), 'number'),
    );
    info.append(grid);

    // 姿态角（功能点 4）
    const attRow = el('div', { class: 'row' });
    attRow.append(el('span', { class: 'dim' }, '安装姿态（自动旋转补偿）:'));
    const attitudes: [string, number][] = [['正装 0°', 0], ['侧装 90°', 90], ['倒挂 180°', 180], ['侧装 270°', 270]];
    for (const [label, deg] of attitudes) {
      const b = el('button', { class: d.attitudeAngle === deg ? 'primary' : '' }, label);
      b.onclick = async () => {
        d.attitudeAngle = deg;
        d.log.push({ ts: Date.now(), type: 'config', message: `姿态补偿角设为 ${deg}°` });
        await save();
        this.renderRight();
      };
      attRow.append(b);
    }
    info.append(attRow, el('div', { class: 'dim', style: 'font-size:12px' }, '补偿角写入设备档案，预览与导出数据均按此角自动旋转。'));
    this.rightPanel.append(info);

    // 白平衡（功能点 6）
    const wb = el('div', { class: 'panel stack', style: 'gap:8px' });
    wb.append(el('h3', {}, `白平衡校正（绑定序列号 ${d.serial}，下发时自动套用）`));
    const wbSlider = (label: string, key: 'r' | 'g' | 'b' | 'master') => {
      const row = el('div', { class: 'row' });
      const s = el('input', { type: 'range', min: '0.5', max: '1.5', step: '0.01', value: String(d.whiteBalance[key]), style: 'width:200px' }) as HTMLInputElement;
      const val = el('span', { class: 'mono', style: 'width:48px' }, d.whiteBalance[key].toFixed(2));
      s.oninput = () => { d.whiteBalance[key] = Number(s.value); val.textContent = Number(s.value).toFixed(2); };
      s.onchange = () => void save();
      row.append(el('span', { class: 'dim', style: 'width:80px' }, label), s, val);
      return row;
    };
    wb.append(
      wbSlider('R 增益', 'r'), wbSlider('G 增益', 'g'), wbSlider('B 增益', 'b'), wbSlider('整体亮度', 'master'),
      el('div', { class: 'dim', style: 'font-size:12px' }, '不同批次灯珠色温不一致时逐台调节；系数随设备档案保存，导出数据包时自动应用。'),
    );
    this.rightPanel.append(wb);

    // 环境光（功能点 5）
    const amb = el('div', { class: 'panel stack', style: 'gap:8px' });
    amb.append(el('h3', {}, '环境光自适应（照度 → 输出亮度）'));
    const editor = createCurveEditor({
      xMin: 1, xMax: 100000, xLog: true, xLabel: '照度 lux（对数轴）', yLabel: '亮度',
      points: d.ambientCurve.map((p) => ({ x: p.lux, y: p.brightness })),
      onChange: (pts) => {
        d.ambientCurve = pts.map((p) => ({ lux: Math.round(p.x), brightness: p.y }));
        void save();
      },
    });
    amb.append(editor.el);
    amb.append(el('div', { class: 'dim', style: 'font-size:12px' }, '点击空白添加锚点，拖拽调整，右键删除（至少保留 2 个）。白天提亮、夜间压暗。'));
    const manualRow = el('div', { class: 'row' });
    const ms = el('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(d.manualBrightness), style: 'width:200px' }) as HTMLInputElement;
    const mv = el('span', { class: 'mono' }, `${(d.manualBrightness * 100).toFixed(0)}%`);
    ms.oninput = () => { d.manualBrightness = Number(ms.value); mv.textContent = `${(d.manualBrightness * 100).toFixed(0)}%`; };
    ms.onchange = () => void save();
    manualRow.append(el('span', { class: 'dim' }, '传感器断连回退亮度:'), ms, mv);
    const connRow = el('div', { class: 'row' });
    const connBtn = el('button', {}, d.sensorConnected ? '断开传感器（模拟）' : '恢复连接');
    connBtn.onclick = async () => {
      d.sensorConnected = !d.sensorConnected;
      d.log.push({
        ts: Date.now(), type: 'sensor',
        message: d.sensorConnected ? '传感器恢复连接' : '环境光传感器断连，回退手动亮度',
      });
      await save();
      this.renderLeft();
      this.renderRight();
    };
    connRow.append(connBtn, el('span', { class: d.sensorConnected ? 'ok' : 'danger-text' }, d.sensorConnected ? '● 传感器在线' : '● 传感器断连'));
    amb.append(manualRow, connRow);
    this.rightPanel.append(amb);

    // 设备日志
    const logPanel = el('div', { class: 'panel stack', style: 'gap:6px' });
    logPanel.append(el('h3', {}, `设备日志（${d.log.length}）`));
    const logBox = el('div', { class: 'mono', style: 'font-size:12px;max-height:180px;overflow:auto' });
    for (const entry of [...d.log].reverse().slice(0, 100)) {
      logBox.append(el('div', {}, `${new Date(entry.ts).toLocaleString()} [${entry.type}] ${entry.message}`));
    }
    logPanel.append(logBox);
    this.rightPanel.append(logPanel);

    // 删除
    const dangerRow = el('div', { class: 'row' });
    const delBtn = el('button', { class: 'danger' }, '删除该设备');
    delBtn.onclick = async () => {
      await del('devices', d.id);
      this.selected = null;
      await this.reload();
    };
    dangerRow.append(delBtn);
    this.rightPanel.append(dangerRow);
  }

  // ---------------- 档案文件导入导出（功能点 4） ----------------
  private exportProfiles(): void {
    const payload = {
      app: 'holo-fan-studio',
      kind: 'device-profiles',
      version: 1,
      exportedAt: new Date().toISOString(),
      devices: this.devices,
    };
    downloadText(JSON.stringify(payload, null, 2), `holo-fan-devices-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
  }

  private async importProfiles(): Promise<void> {
    const files = await pickFile('.json,application/json');
    if (!files.length) return;
    try {
      const payload = JSON.parse(await files[0].text());
      if (payload.app !== 'holo-fan-studio' || !Array.isArray(payload.devices)) {
        throw new Error('不是有效的设备档案文件');
      }
      let count = 0;
      for (const d of payload.devices as DeviceProfile[]) {
        if (d.id && d.serial) { await put('devices', d); count++; }
      }
      await this.reload();
      modal(el('div', {}, el('p', { class: 'ok' }, `已恢复 ${count} 台设备的整套现场配置（含姿态补偿、白平衡、照度曲线、日志）。`)));
    } catch (err) {
      modal(el('div', {}, el('p', { class: 'danger-text' }, `档案载入失败：${(err as Error).message}`)));
    }
  }

  destroy(): void {}
}
