/**
 * 导出中心：
 *  - 控制板固件可识别的二进制数据包（自定义帧格式 + 整包 CRC32）
 *  - 打包前逐帧扫描扇叶安全半径，越界像素红色标注并输出帧号
 *  - 设备档案 JSON 导入/导出（换电脑恢复整套现场配置）
 */
import type { DeviceProfile, ExportPacketInfo, Project, SafetyViolation } from '../types';
import { crc32, crc32Hex } from './crc32';
import { downloadBlob } from './dom';

/**
 * 数据包布局（小端）：
 *  magic       4B   "POVF"
 *  version     1B   0x01
 *  ledCount    2B   U16
 *  frameCount  2B   U16
 *  fps         2B   U16（每圈帧数 framesPerRevolution）
 *  flags       1B   bit0=安全越界存在
 *  payload     frameCount * ledCount * 3 B（RGB 顺序）
 *  crc32       4B   U32，覆盖以上全部字节
 */
export const PACKET_MAGIC = 0x46564f50; // "POVF" little-endian

export interface PacketBuildResult {
  bytes: Uint8Array;
  info: ExportPacketInfo;
  /** 越界帧的可视化位图（与帧同尺寸），供预览红色标注 */
  violationMask: Uint8Array;
}

export function buildPacket(
  frames: Uint8ClampedArray[],
  ledCount: number,
  framesPerRevolution: number,
  safeRadius: number,
  projectName: string,
): PacketBuildResult {
  const frameCount = frames.length;
  const headerSize = 12;
  const payloadSize = frameCount * ledCount * 3;
  const bytes = new Uint8Array(headerSize + payloadSize + 4);
  const dv = new DataView(bytes.buffer);

  dv.setUint32(0, PACKET_MAGIC, true);
  dv.setUint8(4, 1);
  dv.setUint16(5, ledCount, true);
  dv.setUint16(7, frameCount, true);
  dv.setUint16(9, framesPerRevolution, true);

  const violations: SafetyViolation[] = [];
  const violationMask = new Uint8Array(frameCount * ledCount);
  let anyViolation = false;

  for (let f = 0; f < frameCount; f++) {
    const frame = frames[f];
    const base = headerSize + f * ledCount * 3;
    let frameMax = 0;
    let frameBadPixels = 0;
    for (let led = 0; led < ledCount; led++) {
      const src = led * 4;
      const dst = base + led * 3;
      bytes[dst] = frame[src];
      bytes[dst + 1] = frame[src + 1];
      bytes[dst + 2] = frame[src + 2];
      // 半径：第 led 颗灯珠的归一化径向位置（线性，含中心死区 8%）
      const radius = 0.08 + 0.92 * (led / Math.max(1, ledCount - 1));
      const lit = frame[src] + frame[src + 1] + frame[src + 2] > 12;
      if (radius > safeRadius && lit) {
        anyViolation = true;
        frameMax = Math.max(frameMax, radius);
        frameBadPixels++;
        violationMask[f * ledCount + led] = 1;
      }
    }
    if (frameBadPixels > 0) {
      violations.push({
        frameIndex: f,
        maxRadius: frameMax,
        safeRadius,
        pixelCount: frameBadPixels,
      });
    }
  }

  dv.setUint8(11, anyViolation ? 1 : 0);
  const crc = crc32(bytes.subarray(0, headerSize + payloadSize));
  dv.setUint32(headerSize + payloadSize, crc, true);

  const info: ExportPacketInfo = {
    fileName: `${projectName.replace(/[^\w一-龥-]+/g, '_')}.povf`,
    sizeBytes: bytes.length,
    crc32: crc,
    frameCount,
    ledCount,
    safetyViolations: violations,
    exportedAt: Date.now(),
  };
  return { bytes, info, violationMask };
}

export function exportPacketFile(result: PacketBuildResult): void {
  downloadBlob(new Blob([result.bytes], { type: 'application/octet-stream' }), result.info.fileName);
}

/** 校验收到的 .povf 包（U 盘回读/交付前自检） */
export function verifyPacket(bytes: Uint8Array): { ok: boolean; crc: string; reason?: string } {
  if (bytes.length < 16) return { ok: false, crc: '', reason: '文件长度不足' };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== PACKET_MAGIC) return { ok: false, crc: '', reason: '魔数不匹配' };
  const stored = dv.getUint32(bytes.length - 4, true);
  const calc = crc32(bytes.subarray(0, bytes.length - 4));
  return {
    ok: stored === calc,
    crc: crc32Hex(bytes.subarray(0, bytes.length - 4)),
    reason: stored === calc ? undefined : `CRC 不符：包内 ${stored.toString(16)} / 计算 ${calc.toString(16)}`,
  };
}

/** 设备档案导出（含校准曲线/白平衡/姿态/环境曲线，换电脑载入即恢复） */
export function exportDeviceProfile(device: DeviceProfile): void {
  const payload = { kind: 'pov-fan-device-profile', schemaVersion: 1, exportedAt: Date.now(), device };
  downloadBlob(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    `device_${device.serialNumber}.json`,
  );
}

export async function importDeviceProfile(file: File): Promise<DeviceProfile> {
  const parsed = JSON.parse(await file.text());
  if (parsed?.kind !== 'pov-fan-device-profile' || !parsed.device?.serialNumber) {
    throw new Error('不是有效的设备档案文件');
  }
  return parsed.device as DeviceProfile;
}

/** 工程导出（含画布编排，素材 Blob 不打包，仅保留 sourceId/时间码，便于交付重链） */
export function exportProject(project: Project): void {
  const payload = { kind: 'pov-fan-project', schemaVersion: 1, exportedAt: Date.now(), project };
  downloadBlob(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    `${project.name}.povproj.json`,
  );
}
