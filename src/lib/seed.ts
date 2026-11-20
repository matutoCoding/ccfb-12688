/** 内置行业工程模板与默认设备工厂 */
import type { DeviceProfile, ProjectTemplate } from '../types';
import { defaultPwmCurve } from './pwm';
import { DEFAULT_AMBIENT_CURVE } from './ambient';
import { uid } from './dom';

export function builtinTemplates(): ProjectTemplate[] {
  const now = Date.now();
  const make = (t: Omit<ProjectTemplate, 'id' | 'builtin' | 'createdAt' | 'updatedAt'>): ProjectTemplate => ({
    ...t,
    id: uid('tpl'),
    builtin: true,
    createdAt: now,
    updatedAt: now,
  });
  return [
    make({
      name: '门店迎宾 · 标准',
      description: '零售门店入口，主视觉+Logo 双区，适配 65cm 双叶风扇',
      version: 2,
      canvas: { ledCount: 224, framesPerRevolution: 720, diameterMm: 650 },
      placeholders: [
        { name: '主视觉', r0: 0.15, r1: 0.95, angle0: 0, angleSpan: Math.PI * 2, durationSec: 8, label: '主视觉' },
        { name: 'Logo', r0: 0.08, r1: 0.3, angle0: 0, angleSpan: Math.PI * 2, durationSec: 8, label: 'Logo' },
      ],
    }),
    make({
      name: '商超促销 · 价格牌',
      description: '环形文案+中心价格，强调高亮白光，适配 42cm 风扇',
      version: 1,
      canvas: { ledCount: 160, framesPerRevolution: 540, diameterMm: 420 },
      placeholders: [
        { name: '环形文案', r0: 0.55, r1: 0.98, angle0: 0, angleSpan: Math.PI * 2, durationSec: 10, label: '环形文案' },
        { name: '价格', r0: 0.1, r1: 0.5, angle0: 0, angleSpan: Math.PI * 2, durationSec: 10, label: '价格' },
      ],
    }),
    make({
      name: '展会舞台 · 宽幅',
      description: '大直径 100cm 四叶，全幅视频背景与底部条幅',
      version: 1,
      canvas: { ledCount: 320, framesPerRevolution: 900, diameterMm: 1000 },
      placeholders: [
        { name: '全幅背景', r0: 0.12, r1: 0.97, angle0: 0, angleSpan: Math.PI * 2, durationSec: 15, label: '全幅背景' },
        { name: '底部条幅', r0: 0.78, r1: 0.97, angle0: Math.PI * 1.25, angleSpan: Math.PI * 0.5, durationSec: 15, label: '条幅' },
      ],
    }),
  ];
}

export function makeDevice(partial: Partial<DeviceProfile> & { serialNumber: string }): DeviceProfile {
  const now = Date.now();
  const curve = defaultPwmCurve();
  return {
    id: uid('dev'),
    groupName: '默认分组',
    diameterMm: 650,
    ledCount: 224,
    bladeCount: 2,
    installSite: '',
    attitude: 'normal',
    tiltCompensationRad: 0,
    whiteBalance: { rGain: 1, gGain: 1, bGain: 1, master: 1 },
    pwmCalibration: { r: [...curve], g: [...curve], b: [...curve] },
    ambientCurve: DEFAULT_AMBIENT_CURVE.map((a) => ({ ...a })),
    fallbackBrightness: 0.6,
    sensorConnected: true,
    measuredRpm: 900,
    lastRevolutionPeriodsSec: [],
    eventLog: [{ at: now, type: 'power-up', message: '设备建档' }],
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}
