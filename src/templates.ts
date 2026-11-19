/** 行业场景工程模板（内置，支持版本演进；旧版本工程打开时提示同步） */

import { TemplateDef } from './types';

/** 内置模板库：同一 id 只保留最新版本；历史版本留档用于比对提示 */
export const BUILTIN_TEMPLATES: TemplateDef[] = [
  {
    id: 'tpl-retail-window',
    name: '商场橱窗主视觉',
    industry: '零售',
    version: 2, // v2：主视觉位加大，新增价格条
    canvasW: 1024,
    canvasH: 1024,
    slots: [
      { name: '主视觉', x: 212, y: 172, w: 600, h: 600 },
      { name: '品牌角标', x: 402, y: 62, w: 220, h: 90 },
      { name: '价格/活动条', x: 262, y: 802, w: 500, h: 110 },
    ],
  },
  {
    id: 'tpl-expo-booth',
    name: '展会展台环幕',
    industry: '展会',
    version: 1,
    canvasW: 1024,
    canvasH: 1024,
    slots: [
      { name: '环形主画面', x: 112, y: 112, w: 800, h: 800 },
      { name: '中央 LOGO', x: 412, y: 412, w: 200, h: 200 },
    ],
  },
  {
    id: 'tpl-store-sign',
    name: '门店招牌字幕',
    industry: '餐饮零售',
    version: 1,
    canvasW: 1024,
    canvasH: 1024,
    slots: [
      { name: '招牌画面', x: 162, y: 312, w: 700, h: 400 },
      { name: '滚动字幕位', x: 162, y: 742, w: 700, h: 90 },
    ],
  },
  {
    id: 'tpl-stage-bg',
    name: '舞台背景动效',
    industry: '演艺',
    version: 1,
    canvasW: 1024,
    canvasH: 1024,
    slots: [{ name: '全幅背景', x: 52, y: 52, w: 920, h: 920 }],
  },
];

/** 历史版本留档（用于"模板有更新"提示的说明） */
export const TEMPLATE_HISTORY: Record<string, { version: number; note: string }[]> = {
  'tpl-retail-window': [
    { version: 1, note: '初版：主视觉 + 品牌角标' },
    { version: 2, note: '主视觉位加大至 600px，新增价格/活动条占位' },
  ],
};

export function latestTemplate(id: string): TemplateDef | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.id === id);
}
