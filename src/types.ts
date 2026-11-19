/** 全局数据模型 —— 全部存 IndexedDB，素材 Blob 不出浏览器 */

export interface MediaItem {
  id: string;
  name: string;
  kind: 'video' | 'image';
  blob: Blob;
  duration: number;      // 秒，图片为 0
  width: number;
  height: number;
  fps: number;           // 视频帧率（探测失败默认 30）
  rating: number;        // 0-5 星
  createdAt: number;
  replacedAt?: number;   // 原片被替换的时间，片段按源时间码自动重链
}

/** 调色方案：可挂多套在片段上随时切换 */
export interface Grade {
  id: string;
  name: string;
  lutName?: string;
  lutSize?: number;        // 3D LUT 边长
  lutData?: Float32Array;  // n*n*n*3，结构化克隆直接入库
}

export interface Clip {
  id: string;
  mediaId: string;       // 引用原片；原片替换后按 inPoint/outPoint 源时间码重链
  name: string;
  inPoint: number;       // 源时间码（秒）
  outPoint: number;
  grades: Grade[];
  activeGradeId: string | null;
  createdAt: number;
}

export interface WhiteBalance { r: number; g: number; b: number; master: number; }

export interface AmbientPoint { lux: number; brightness: number; } // 0..1

export interface DeviceLogEntry {
  ts: number;
  type: 'sensor' | 'config' | 'playback' | 'system';
  message: string;
}

export interface DeviceProfile {
  id: string;
  serial: string;        // 序列号，白平衡系数绑定它
  name: string;
  group: string;         // 分组
  diameter: number;      // 扇叶直径 mm
  ledCount: number;      // 灯珠数
  sectorsPerRev: number; // 每圈角向分区数（编码器）
  site: string;          // 安装场地
  attitudeAngle: number; // 姿态角（度），倒挂=180，侧装=±90，画面自动旋转补偿
  whiteBalance: WhiteBalance;
  ambientCurve: AmbientPoint[];   // 照度→亮度映射锚点
  manualBrightness: number;       // 传感器断连回退值 0..1
  sensorConnected: boolean;
  log: DeviceLogEntry[];
  createdAt: number;
}

export interface Slot {
  id: string;
  name: string;
  x: number; y: number; w: number; h: number; // 画布坐标（像素）
  clipId: string | null;
}

export interface Project {
  id: string;
  name: string;
  templateId: string | null;
  templateVersion: number;
  canvasW: number;
  canvasH: number;
  slots: Slot[];
  createdAt: number;
}

export interface TemplateSlotDef { name: string; x: number; y: number; w: number; h: number; }

export interface TemplateDef {
  id: string;
  name: string;
  industry: string;
  version: number;
  canvasW: number;
  canvasH: number;
  slots: TemplateSlotDef[];
}

/** 设备 U 盘日志解析出的一条上播记录 */
export interface PlayRecord {
  materialId: string;
  start: string;   // ISO
  end: string;
  rpm: number;     // 实测转速
}

export interface PwmCurves {
  // 256 级占空比 → 感知亮度校正，逐通道
  r: Float32Array; g: Float32Array; b: Float32Array;
  enabled: boolean;
}

export const uid = (): string =>
  (crypto as any).randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
