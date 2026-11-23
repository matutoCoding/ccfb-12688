// 控制板固件二进制数据包
// 包格式（小端，固件侧按同一结构解析）：
//   偏移  长度  字段
//   0     4    Magic "HOL1"
//   4     1    版本 (1)
//   5     1    标志位（bit0 含白平衡, bit1 含PWM校正, bit2 墙组包）
//   6     2    头部长度 headerLen
//   8     32   设备序列号（UTF-8，0 填充）
//   40    4    扇叶直径 mm (u32)
//   44    2    灯珠数 (u16)
//   46    2    帧数 (u16)
//   48    2    帧边长 size (u16，方形)
//   50    4    帧率 fps 定点（u16 整数 + u16 小数，milli-fps）
//   54    4    目标转速 rpm (u32)
//   58    4    姿态补偿角 毫度 (i32)
//   62    4    安全半径比例 (u32，除以 1e6)
//   66    12   白平衡 R/G/B/亮度（各 u24 定标 1e6，共 4x3）
//   78    4    数据段长度 payloadLen (u32)
//   82    2    保留对齐
//   ----- headerLen 对齐到 64 字节 -----
//   数据段：每帧 R8G8B8 行优先（size*size*3 字节）
//   末尾  4    CRC32（覆盖头部+数据段，IEEE 802.3，与 zlib 一致）
import { crc32 } from '../core/mathutil';
import type { Device, WhiteBalance } from '../core/types';

export const PACKET_MAGIC = 0x314c4f48; // 'H','O','L','1' 小端
export const PACKET_VERSION = 1;
export const HEADER_LEN = 96;

export interface PacketFrame {
  index: number;
  /** RGB（无 alpha），长度 size*size*3 */
  rgb: Uint8Array;
}

export interface BuildPacketOptions {
  device: Device;
  frames: PacketFrame[];
  size: number;
  fps: number;
  includeWhiteBalance: boolean;
  includePwmCalib: boolean;
  wallBundle: boolean;
}

export interface BuiltPacket {
  bytes: Uint8Array;
  crc: number;
  headerLen: number;
  payloadLen: number;
}

function writeFixedString(dv: DataView, offset: number, max: number, s: string): void {
  const bytes = new TextEncoder().encode(s);
  for (let i = 0; i < max; i++) dv.setUint8(offset + i, i < bytes.length ? bytes[i] : 0);
}

export function buildPacket(opts: BuildPacketOptions): BuiltPacket {
  const { device, frames, size, fps } = opts;
  const wb: WhiteBalance = device.whiteBalance;
  const payloadLen = frames.length * size * size * 3;
  const total = HEADER_LEN + payloadLen + 4;
  const buffer = new ArrayBuffer(total);
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  let flags = 0;
  if (opts.includeWhiteBalance) flags |= 1 << 0;
  if (opts.includePwmCalib) flags |= 1 << 1;
  if (opts.wallBundle) flags |= 1 << 2;

  dv.setUint32(0, PACKET_MAGIC, true);
  dv.setUint8(4, PACKET_VERSION);
  dv.setUint8(5, flags);
  dv.setUint16(6, HEADER_LEN, true);
  writeFixedString(dv, 8, 32, device.serial);
  dv.setUint32(40, Math.round(device.bladeDiameterMm), true);
  dv.setUint16(44, device.ledCount, true);
  dv.setUint16(46, Math.min(frames.length, 65535), true);
  dv.setUint16(48, size, true);
  dv.setUint32(50, Math.round(fps * 1000), true);
  dv.setUint32(54, Math.round(device.targetRpm), true);
  dv.setInt32(58, Math.round(device.attitudeAngleDeg * 1000), true);
  dv.setUint32(62, Math.round(device.safeRadiusRatio * 1e6), true);
  const wbScale = 1e6;
  dv.setUint32(66, Math.round(clamp255(wb.r) * wbScale), true);
  dv.setUint32(70, Math.round(clamp255(wb.g) * wbScale), true);
  dv.setUint32(74, Math.round(clamp255(wb.b) * wbScale), true);
  dv.setUint32(78, Math.round(clamp255(wb.brightness) * wbScale), true);
  dv.setUint32(82, payloadLen, true);
  // 86..95 保留 0

  let off = HEADER_LEN;
  for (const frame of frames) {
    if (frame.rgb.length !== size * size * 3) {
      throw new Error(`第 ${frame.index} 帧数据长度不匹配，期望 ${size * size * 3}`);
    }
    u8.set(frame.rgb, off);
    off += frame.rgb.length;
  }

  const crc = crc32(u8.subarray(0, HEADER_LEN + payloadLen));
  dv.setUint32(HEADER_LEN + payloadLen, crc, true);
  return { bytes: u8, crc, headerLen: HEADER_LEN, payloadLen };
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 2 ? 2 : v;
}

export interface PacketHeaderInfo {
  version: number;
  flags: number;
  serial: string;
  bladeDiameterMm: number;
  ledCount: number;
  frameCount: number;
  size: number;
  fpsMilli: number;
  targetRpm: number;
  attitudeMilliDeg: number;
  safeRadius: number;
  wb: WhiteBalance;
  payloadLen: number;
  crcOk: boolean;
  storedCrc: number;
}

/** 固件侧/交付验收时回读校验 */
export function parsePacket(bytes: Uint8Array): PacketHeaderInfo {
  if (bytes.length < HEADER_LEN + 4) throw new Error('数据包过短');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== PACKET_MAGIC) throw new Error('Magic 不匹配，不是 HOL1 数据包');
  const version = dv.getUint8(4);
  const flags = dv.getUint8(5);
  const headerLen = dv.getUint16(6, true);
  const serial = new TextDecoder().decode(bytes.subarray(8, 40)).replace(/\0+$/, '');
  const payloadLen = dv.getUint32(82, true);
  const storedCrc = dv.getUint32(headerLen + payloadLen, true);
  const crcOk = crc32(bytes.subarray(0, headerLen + payloadLen)) === storedCrc;
  return {
    version,
    flags,
    serial,
    bladeDiameterMm: dv.getUint32(40, true),
    ledCount: dv.getUint16(44, true),
    frameCount: dv.getUint16(46, true),
    size: dv.getUint16(48, true),
    fpsMilli: dv.getUint32(50, true),
    targetRpm: dv.getUint32(54, true),
    attitudeMilliDeg: dv.getInt32(58, true),
    safeRadius: dv.getUint32(62, true) / 1e6,
    wb: {
      r: dv.getUint32(66, true) / 1e6,
      g: dv.getUint32(70, true) / 1e6,
      b: dv.getUint32(74, true) / 1e6,
      brightness: dv.getUint32(78, true) / 1e6,
    },
    payloadLen,
    crcOk,
    storedCrc,
  };
}

export function rgbaToRgb(rgba: Uint8Array | Uint8ClampedArray): Uint8Array {
  const frames = rgba.length / 4;
  const out = new Uint8Array(frames * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    out[j] = rgba[i];
    out[j + 1] = rgba[i + 1];
    out[j + 2] = rgba[i + 2];
  }
  return out;
}
