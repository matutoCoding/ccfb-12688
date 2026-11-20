import { h, clear, toast } from '../lib/dom';
import { store } from '../lib/store';
import type { DeviceProfile, MountAttitude } from '../types';
import { makeDevice } from '../lib/seed';
import { pageHeader, emptyState } from './shell';
import { curveEditor } from './curve-editor';
import { calibrationToCsv, parseCalibrationCsv, defaultPwmCurve, linearCurve } from '../lib/pwm';
import { exportDeviceProfile, importDeviceProfile } from '../lib/export';
import { downloadBlob } from '../lib/dom';

const ATTITUDES: { value: MountAttitude; label: string; tilt: number }[] = [
  { value: 'normal', label: '正装（默认）', tilt: 0 },
  { value: 'inverted', label: '倒挂（180°）', tilt: Math.PI },
  { value: 'side-left', label: '左侧装（90°）', tilt: Math.PI / 2 },
  { value: 'side-right', label: '右侧装（-90°）', tilt: -Math.PI / 2 },
  { value: 'custom', label: '自定义角度', tilt: 0 },
];

export function devicesPage(): HTMLElement {
  const root = h('div', {});
  const draw = () => {
    clear(root);
    const importInput = h('input', {
      type: 'file', accept: '.json', style: 'display:none',
      onchange: async () => {
        const f = importInput.files?.[0];
        if (!f) return;
        try {
          const dev = await importDeviceProfile(f);
          const clash = store.devices.some((d) => d.serialNumber === dev.serialNumber);
          if (clash && !confirm(`序列号 ${dev.serialNumber} 已存在，是否覆盖？`)) return;
          await store.save('devices', dev);
          toast('设备档案已载入，现场配置已恢复');
        } catch (e) {
          toast((e as Error).message, 'error');
        }
        importInput.value = '';
      },
    }) as HTMLInputElement;

    root.appendChild(pageHeader('设备设置', '设备档案分组、安装姿态补偿、白平衡与 PWM 校准、环境光曲线；档案文件可换电脑恢复',
      h('button', { onclick: () => importInput.click() }, '载入档案文件'),
      h('button', { class: 'primary', onclick: () => createDevice() }, '登记新设备'),
      importInput,
    ));

    if (!store.devices.length) {
      root.appendChild(emptyState('登记第一台真机：录入序列号、扇叶直径、灯珠数与安装场地。'));
      return;
    }

    const groups = [...new Set(store.devices.map((d) => d.groupName))];
    root.appendChild(h('div', { class: 'pill-group', style: 'margin-bottom:16px' },
      h('span', { class: 'muted', style: 'align-self:center' }, '分组：'),
      ...groups.map((g) => h('button', {
        class: store.currentDeviceId === null ? '' : store.currentDevice?.groupName === g ? 'on' : '',
        onclick: () => {
          const first = store.devices.find((d) => d.groupName === g);
          if (first) { store.currentDeviceId = first.id; store.emit(); }
        },
      }, g)),
    ));

    const list = h('div', { style: 'display:flex;flex-direction:column;gap:12px' });
    for (const d of store.devices) list.appendChild(deviceCard(d, draw));
    root.appendChild(list);
  };

  const createDevice = () => {
    const serial = prompt('设备序列号：', `SN-${String(store.devices.length + 1).padStart(4, '0')}`);
    if (!serial) return;
    if (store.devices.some((d) => d.serialNumber === serial)) return toast('序列号已存在', 'error');
    const dev = makeDevice({ serialNumber: serial });
    store.save('devices', dev).then(() => {
      store.currentDeviceId = dev.id;
      toast('设备已登记');
    });
  };

  store.subscribe(draw);
  draw();
  return root;
}

function deviceCard(d: DeviceProfile, refresh: () => void): HTMLElement {
  const selected = store.currentDeviceId === d.id;
  const save = async (patch: Partial<DeviceProfile>) => {
    Object.assign(d, patch, { updatedAt: Date.now() });
    await store.save('devices', d);
  };

  const serial = h('input', { value: d.serialNumber, onchange: () => save({ serialNumber: serial.value }) }) as HTMLInputElement;
  const group = h('input', { value: d.groupName, onchange: () => save({ groupName: group.value }) }) as HTMLInputElement;
  const site = h('input', { value: d.installSite, placeholder: '如：三号厅东门上方', onchange: () => save({ installSite: site.value }) }) as HTMLInputElement;
  const diameter = h('input', { type: 'number', value: String(d.diameterMm), onchange: () => save({ diameterMm: Number(diameter.value) }) }) as HTMLInputElement;
  const ledCount = h('input', { type: 'number', value: String(d.ledCount), onchange: () => save({ ledCount: Number(ledCount.value) }) }) as HTMLInputElement;
  const bladeCount = h('select', { onchange: () => save({ bladeCount: Number(bladeCount.value) }) },
    [2, 3, 4].map((n) => h('option', { value: String(n), selected: d.bladeCount === n ? true : undefined }, `${n} 叶`)),
  );

  const attitudeSel = h('select', {
    onchange: () => {
      const a = ATTITUDES.find((x) => x.value === attitudeSel.value)!;
      save({ attitude: a.value as MountAttitude, tiltCompensationRad: a.tilt });
      refresh();
    },
  }, ...ATTITUDES.map((a) => h('option', { value: a.value, selected: d.attitude === a.value ? true : undefined }, a.label))) as HTMLSelectElement;

  const tilt = h('input', {
    type: 'range', min: '-3.1416', max: '3.1416', step: '0.0175',
    value: String(d.tiltCompensationRad),
    oninput: () => save({ attitude: 'custom', tiltCompensationRad: Number(tilt.value), }),
  }) as HTMLInputElement;

  // 白平衡（绑定序列号的校正系数）
  const wbR = h('input', { type: 'range', min: '0.5', max: '1.5', step: '0.005', value: String(d.whiteBalance.rGain), oninput: () => save({ whiteBalance: { ...d.whiteBalance, rGain: Number(wbR.value) } }) }) as HTMLInputElement;
  const wbG = h('input', { type: 'range', min: '0.5', max: '1.5', step: '0.005', value: String(d.whiteBalance.gGain), oninput: () => save({ whiteBalance: { ...d.whiteBalance, gGain: Number(wbG.value) } }) }) as HTMLInputElement;
  const wbB = h('input', { type: 'range', min: '0.5', max: '1.5', step: '0.005', value: String(d.whiteBalance.bGain), oninput: () => save({ whiteBalance: { ...d.whiteBalance, bGain: Number(wbB.value) } }) }) as HTMLInputElement;
  const master = h('input', { type: 'range', min: '0.2', max: '1.5', step: '0.01', value: String(d.whiteBalance.master), oninput: () => save({ whiteBalance: { ...d.whiteBalance, master: Number(master.value) } }) }) as HTMLInputElement;
  const fallback = h('input', { type: 'range', min: '0.05', max: '1', step: '0.01', value: String(d.fallbackBrightness), oninput: () => save({ fallbackBrightness: Number(fallback.value) }) }) as HTMLInputElement;

  const calibInput = h('input', {
    type: 'file', accept: '.csv,.txt', style: 'display:none',
    onchange: async () => {
      const f = calibInput.files?.[0];
      if (!f) return;
      try {
        const curves = parseCalibrationCsv(await f.text());
        await save({ pwmCalibration: curves });
        toast('实测 PWM 校准表已逐通道套用');
        refresh();
      } catch (e) {
        toast((e as Error).message, 'error');
      }
      calibInput.value = '';
    },
  }) as HTMLInputElement;

  const card = h('div', { class: 'card', style: selected ? 'border-color:var(--accent)' : '' },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px' },
      h('h3', { style: 'margin:0' }, `设备 ${d.serialNumber}`, h('span', { class: 'badge accent', style: 'margin-left:8px' }, d.groupName),
        h('span', { class: `badge ${d.sensorConnected ? 'ok' : 'danger'}`, style: 'margin-left:6px' }, d.sensorConnected ? '传感器在线' : '传感器断连')),
      h('div', { class: 'pill-group' },
        h('button', { onclick: () => { store.currentDeviceId = selected ? null : d.id; store.emit(); } }, selected ? '取消选中' : '选为预览设备'),
        h('button', { onclick: () => exportDeviceProfile(d) }, '导出档案'),
        h('button', { class: 'danger', onclick: async () => { if (confirm(`删除设备 ${d.serialNumber}？`)) await store.remove('devices', d.id); } }, '删除'),
      ),
    ),
    h('div', { class: 'form-grid', style: 'margin-top:14px' },
      h('div', {}, h('label', {}, '序列号（校正系数绑定）'), serial),
      h('div', {}, h('label', {}, '分组'), group),
      h('div', { class: 'span-2' }, h('label', {}, '安装场地'), site),
      h('div', {}, h('label', {}, '扇叶直径(mm)'), diameter),
      h('div', {}, h('label', {}, '灯珠数'), ledCount),
      h('div', {}, h('label', {}, '叶片数'), bladeCount),
      h('div', {}, h('label', {}, '安装姿态（自动旋转补偿）'), attitudeSel),
      h('div', { class: 'span-2' }, h('label', {}, `姿态补偿角 ${(d.tiltCompensationRad * 180 / Math.PI).toFixed(1)}°`), tilt),
    ),

    h('div', { class: 'grid cols-2', style: 'margin-top:16px' },
      h('div', { class: 'card' },
        h('h3', {}, '白平衡（逐台，绑定序列号下发）'),
        h('label', {}, `R 增益 ${d.whiteBalance.rGain.toFixed(3)}`), wbR,
        h('label', {}, `G 增益 ${d.whiteBalance.gGain.toFixed(3)}`), wbG,
        h('label', {}, `B 增益 ${d.whiteBalance.bGain.toFixed(3)}`), wbB,
        h('label', {}, `整体亮度 ${d.whiteBalance.master.toFixed(2)}`), master,
        h('div', { class: 'pill-group', style: 'margin-top:10px' },
          h('button', { onclick: () => save({ whiteBalance: { rGain: 1, gGain: 1, bGain: 1, master: 1 } }) }, '复位 1.000'),
        ),
      ),
      h('div', { class: 'card' },
        h('h3', {}, 'PWM 占空比→感知亮度 校正'),
        h('p', { class: 'sub muted' }, '导入实测校准表 CSV（duty,r,g,b），预览台可分屏对比校正前后'),
        h('div', { class: 'pill-group' },
          h('button', { onclick: () => calibInput.click() }, '导入实测校准表'),
          h('button', { onclick: () => { const c = defaultPwmCurve(); save({ pwmCalibration: { r: c, g: [...c], b: [...c] } }); refresh(); } }, '恢复 γ2.2 默认'),
          h('button', { onclick: () => { const c = linearCurve(); save({ pwmCalibration: { r: c, g: [...c], b: [...c] } }); refresh(); } }, '线性'),
          h('button', { onclick: () => downloadBlob(new Blob([calibrationToCsv(d.pwmCalibration)], { type: 'text/csv' }), `pwm_${d.serialNumber}.csv`) }, '导出当前表'),
          calibInput,
        ),
      ),
      h('div', { class: 'card' },
        h('h3', {}, '环境光→亮度 映射曲线'),
        curveEditor(d.ambientCurve, (next) => save({ ambientCurve: next })),
        h('label', { style: 'margin-top:10px' }, `断连回退手动亮度 ${(d.fallbackBrightness * 100).toFixed(0)}%`), fallback,
      ),
      h('div', { class: 'card' },
        h('h3', {}, '设备事件日志（含断连时段）'),
        h('div', { class: 'log-view' },
          ...[...d.eventLog].reverse().slice(0, 30).map((e) =>
            h('div', { class: 'row' }, h('span', { class: 'muted mono' }, new Date(e.at).toLocaleString()), ' ', h('span', { class: e.type.includes('disconnect') ? 'badge danger' : 'badge' }, e.type), ' ', e.message),
          ),
        ),
      ),
    ),
  );
  return card;
}
