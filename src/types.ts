/**
 * 全局领域模型定义。
 * 所有持久化对象均带 id / createdAt / updatedAt，由 db.ts 统一维护。
 */

/** 旋转方向 */
export type RotationDirection = 'cw' | 'ccw';

/** 安装姿态（用于画面自动旋转补偿） */
export type MountAttitude = 'normal' | 'inverted' | 'side-left' | 'side-right' | 'custom';

/** LUT 格式（当前支持 Adobe/Resolve 通用 .cube） */
export interface LutData {
  id: string;
  name: string;
  size: number; // 3D LUT 每边格点数，常见 17/33/65
  /** RGB 查找表，长度 size^3，索引方式 r*size^2 + g*size + b，分量 0..1 */
  table: Float32Array;
  importedAt: number;
}

/** 调色方案：一个片段可挂多套，随时切换对比 */
export interface ColorGrade {
  id: string;
  name: string;
  lutId: string | null;
  /** 额外的强度（0=原图，1=全量 LUT），默认 1 */
  strength: number;
  /** 简单参数微调（在 LUT 之外叠加） */
  exposure: number; // EV，-2..2
  saturation: number; // 0..2，1 为原始
}

/** 视频源素材（原始入库文件，Blob 存 IDB） */
export interface VideoSource {
  id: string;
  name: string;
  /** 文件指纹（大小+名称+头部采样哈希），用于替换重链 */
  fingerprint: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  mimeType: string;
  sizeBytes: number;
  blob: Blob;
  /** 数据 URL 形式的首帧缩略图 */
  thumbnailDataUrl: string;
  rating: 0 | 1 | 2 | 3 | 4 | 5;
  createdAt: number;
  updatedAt: number;
}

/** 裁剪片段：记住对应原片源时间码 */
export interface Clip {
  id: string;
  name: string;
  sourceId: string;
  /** 入点 / 出点（相对原片的秒时间码，帧精度） */
  inPointSec: number;
  outPointSec: number;
  sourceFps: number;
  grades: ColorGrade[];
  activeGradeId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 画布上的素材占位 / 片段框 */
export interface CanvasItem {
  id: string;
  clipId: string | null;
  /** 占位框名称（模板同步时按名称匹配绑定） */
  name: string;
  /** 极坐标占位框参数：半径起点/终点（0..1 归一化）、起始角/扇形张角（弧度） */
  r0: number;
  r1: number;
  angle0: number;
  angleSpan: number;
  /** 时间轴上的起始秒与时长秒 */
  trackStartSec: number;
  durationSec: number;
  label: string;
}

/** 行业工程模板 */
export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  version: number;
  /** 建议画布扇叶参数 */
  canvas: {
    ledCount: number;
    framesPerRevolution: number;
    diameterMm: number;
  };
  /** 占位框定义 */
  placeholders: Omit<CanvasItem, 'id' | 'clipId' | 'trackStartSec'>[];
  builtin: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 设备档案 */
export interface DeviceProfile {
  id: string;
  serialNumber: string;
  groupName: string;
  diameterMm: number;
  ledCount: number;
  bladeCount: number;
  installSite: string;
  attitude: MountAttitude;
  /** 自定义姿态补偿角（弧度，顺时针为正） */
  tiltCompensationRad: number;
  /** 白平衡：RGB 三通道增益与整体亮度（绑定序列号） */
  whiteBalance: { rGain: number; gGain: number; bGain: number; master: number };
  /** PWM 占空比 -> 感知亮度 非线性校正表（每通道 256 点，0..1），可导入实测校准表 */
  pwmCalibration: { r: number[]; g: number[]; b: number[] };
  /** 环境光 -> 输出亮度 锚点曲线（lux, 0..1 亮度） */
  ambientCurve: { lux: number; brightness: number }[];
  /** 传感器断连后的回退手动亮度 0..1 */
  fallbackBrightness: number;
  sensorConnected: boolean;
  /** 当前实测转速（rpm），由编码器回传/模拟 */
  measuredRpm: number;
  /** 每圈周期历史（秒），用于漂移演示 */
  lastRevolutionPeriodsSec: number[];
  /** 断连/事件日志（设备端运行事件） */
  eventLog: DeviceEvent[];
  createdAt: number;
  updatedAt: number;
}

export interface DeviceEvent {
  at: number; // 时间戳
  type: 'sensor-disconnect' | 'sensor-reconnect' | 'power-up' | 'note';
  message: string;
}

/** 编排工程 */
export interface Project {
  id: string;
  name: string;
  templateId: string | null;
  /** 创建时模板版本，用于打开时提示同步 */
  templateVersionAtCreation: number | null;
  targetDeviceId: string | null;
  ledCount: number;
  framesPerRevolution: number;
  diameterMm: number;
  items: CanvasItem[];
  totalDurationSec: number;
  createdAt: number;
  updatedAt: number;
}

/** 导出的固件二进制数据包元信息 */
export interface ExportPacketInfo {
  fileName: string;
  sizeBytes: number;
  crc32: number;
  frameCount: number;
  ledCount: number;
  safetyViolations: SafetyViolation[];
  exportedAt: number;
}

/** 安全半径越界记录 */
export interface SafetyViolation {
  frameIndex: number;
  /** 越界的最远归一化半径 */
  maxRadius: number;
  safeRadius: number;
  /** 越界像素数量 */
  pixelCount: number;
}

/** U 盘回读的设备播放日志条目 */
export interface PlaybackLogEntry {
  materialCode: string;
  startEpochSec: number;
  endEpochSec: number;
  measuredRpmAvg: number;
  deviceSerial: string;
}

/** 日志解析结果 */
export interface PlaybackStats {
  byMaterial: {
    materialCode: string;
    playCount: number;
    totalDurationSec: number;
    /** 工程中找不到对应素材编号 -> 异常 */
    anomalous: boolean;
  }[];
  anomalies: PlaybackLogEntry[];
  totalEntries: number;
}

/** 预览台运行时状态（非持久化） */
export interface PreviewRuntimeState {
  rpm: number;
  direction: RotationDirection;
  running: boolean;
  driftEnabled: boolean;
  splitCalibration: boolean;
  sensorConnected: boolean;
  ambientLux: number;
  outputBrightness: number;
}
