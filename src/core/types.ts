// 全局数据模型 —— 所有持久化对象都经 IndexedDB 本地存储，素材 Blob 不出本机
export type ID = string;

export interface Asset {
  id: ID;
  name: string;
  blob: Blob;
  size: number;
  duration: number;
  width: number;
  height: number;
  fps: number;
  rating: 0 | 1 | 2 | 3 | 4 | 5;
  tags: string[];
  /** 入库时锚定的源时间码基准（秒，相对文件零点），替换文件后按此重链 */
  relinkAnchorSec: number;
  /** 内容指纹：文件名+大小+时长，用于检测"原片被替换" */
  fingerprint: string;
  createdAt: number;
}

export interface GradePreset {
  id: ID;
  name: string;
  lutId: ID | null;
  gain: [number, number, number];
  saturation: number; // 0..2，1 为原始
  brightness: number; // -1..1
  contrast: number;   // 0..2，1 为原始
}

export interface Clip {
  id: ID;
  assetId: ID;
  name: string;
  /** 入点 / 出点，单位秒，始终以"源文件时间码"记账 */
  inPoint: number;
  outPoint: number;
  /** 标记入点时记录的 SMPTE 源时间码文本，重链后可人工核对 */
  sourceInTc: string;
  sourceOutTc: string;
  fps: number;
  grades: GradePreset[];
  activeGradeId: ID | null;
  /** 重链标记：原片指纹变化后置 true，直到确认或自动重链完成 */
  relinkPending: boolean;
  createdAt: number;
}

export interface CanvasItem {
  id: ID;
  clipId: ID;
  /** 时间轴起点（秒，相对工程时间线） */
  start: number;
  duration: number;
  /** 画布中心，归一化 0..1（风扇内容方图坐标） */
  x: number;
  y: number;
  scale: number;
  rotationDeg: number;
  opacity: number;
}

export interface Project {
  id: ID;
  name: string;
  items: CanvasItem[];
  duration: number;
  bgColor: string;
  updatedAt: number;
}

export interface LUTFile {
  id: ID;
  name: string;
  title: string;
  gridSize: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  /** 长度 gridSize^3 * 3，0..1 RGB，顺序与 .cube 一致（R 最快） */
  data: Float32Array;
  createdAt: number;
}

export interface CalibPoint {
  /** PWM 占空比 0..1 */
  duty: number;
  /** 实测感知亮度 0..1 */
  luminance: number;
}

export interface PwmCalib {
  id: ID;
  name: string;
  pointsR: CalibPoint[];
  pointsG: CalibPoint[];
  pointsB: CalibPoint[];
  createdAt: number;
}

export type MountAttitude = 'upright' | 'inverted' | 'side-left' | 'side-right' | 'custom';

export interface WhiteBalance {
  r: number;
  g: number;
  b: number;
  brightness: number;
}

export interface Device {
  id: ID;
  serial: string;
  name: string;
  bladeDiameterMm: number;
  ledCount: number;
  site: string;
  group: string;
  attitude: MountAttitude;
  /** 姿态补偿角（度），写入设备档案；成像区按此角旋转裁切 */
  attitudeAngleDeg: number;
  /** 安全半径占扇叶半径比例 0..1，导出前逐帧扫描以此为界 */
  safeRadiusRatio: number;
  whiteBalance: WhiteBalance;
  pwmCalibId: ID | null;
  targetRpm: number;
  /** 模拟器：电压漂移幅度（rpm 峰峰），0 表示理想稳压 */
  driftAmplitude: number;
  manualBrightness: number;
  createdAt: number;
}

export interface LightCurvePoint {
  lux: number;
  brightness: number;
}

export interface SensorLogEntry {
  time: number;
  type: 'connect' | 'disconnect' | 'sample';
  lux: number;
  brightness: number;
}

export interface SensorState {
  connected: boolean;
  lux: number;
  curve: LightCurvePoint[];
  log: SensorLogEntry[];
  lastDisconnectAt: number | null;
  lastReconnectAt: number | null;
}

/** U 盘回传的设备播放日志记录 */
export interface PlayLogEntry {
  deviceSerial: string;
  /** 素材编号（控制板侧编号，与工程素材通过 materialCode 关联） */
  materialCode: string;
  /** 上播起止，Unix 秒 */
  startUnix: number;
  endUnix: number;
  measuredRpm: number;
}

export interface WallCell {
  deviceId: ID;
  col: number;
  row: number;
  /** 相位差（度），用于拼缝灯珠轨迹对齐 */
  phaseOffsetDeg: number;
  /** 该台实测转速漂移覆盖（rpm），不填用设备自身漂移模型 */
  driftOverride: number | null;
}

export interface WallLayout {
  id: ID;
  name: string;
  cols: number;
  rows: number;
  gapMm: number;
  fanDiameterMm: number;
  cells: WallCell[];
  updatedAt: number;
}

export type RotationDirection = 1 | -1;

export interface PreviewSettings {
  rpm: number;
  direction: RotationDirection;
  /** 视觉暂留时间常数 τ（毫秒） */
  persistenceMs: number;
  /** PWM 非线性校正总开关 */
  calibEnabled: boolean;
  /** 校正前后分屏对比 */
  splitCompare: boolean;
  /** 环境光自动亮度 */
  ambientAuto: boolean;
  wallId: ID | null;
  /** 安全半径越界红色标记 */
  showSafety: boolean;
  /** 预览分辨率（内容方图边长） */
  resolution: number;
}

export interface MaterialCodeBinding {
  materialCode: string;
  clipId: ID;
}

export interface AppState {
  assets: Asset[];
  clips: Clip[];
  luts: LUTFile[];
  projects: Project[];
  currentProjectId: ID | null;
  devices: Device[];
  pwmCalibs: PwmCalib[];
  wallLayouts: WallLayout[];
  materialBindings: MaterialCodeBinding[];
  preview: PreviewSettings;
}

export const DEFAULT_PREVIEW: PreviewSettings = {
  rpm: 900,
  direction: 1,
  persistenceMs: 24,
  calibEnabled: false,
  splitCompare: false,
  ambientAuto: true,
  wallId: null,
  showSafety: true,
  resolution: 1024,
};
