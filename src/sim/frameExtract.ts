// 工程帧抽取：沿时间线逐帧合成内容方图并读回 RGBA 像素，供安全扫描与二进制打包
import type { PreviewEngine } from './PreviewEngine';
import { rgbaToRgb, type PacketFrame } from '../export/packet';

export interface ExtractedFrame {
  index: number;
  timeSec: number;
  rgba: Uint8Array;
}

/**
 * 逐帧抽取。利用预览引擎已装配好的 ContentComposer：
 * 逐时间点 seek 视频 -> 合成 contentFbo -> readPixels。
 * 为控制耗时与内存，默认上限 600 帧，分辨率沿用预览分辨率。
 */
export async function extractProjectFrames(
  engine: PreviewEngine,
  durationSec: number,
  fps: number,
  size: number,
  onProgress?: (ratio: number) => void,
  maxFrames = 600,
): Promise<ExtractedFrame[]> {
  const total = Math.min(maxFrames, Math.max(1, Math.round(durationSec * fps)));
  const out: ExtractedFrame[] = [];
  const gl = engine.glContext;
  // 确保 contentFbo 视口与目标 size 一致（引擎内部 FBO 即该尺寸）
  void gl;
  for (let i = 0; i < total; i++) {
    const t = (i / fps);
    engine.seekContent(t);
    // 给视频 seek 与 GL 命令一个完成窗口
    await new Promise((r) => setTimeout(r, 0));
    engine.renderOnceForExport(t);
    const raw = engine.readContentPixels(size);
    // WebGL readPixels 原点在左下角，逐行翻转回上原点，与内容方图约定一致
    const rgba = flipY(raw, size);
    out.push({ index: i, timeSec: t, rgba });
    onProgress?.((i + 1) / total);
  }
  return out;
}

function flipY(src: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(src.length);
  const rowBytes = size * 4;
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * rowBytes;
    out.set(src.subarray(srcRow, srcRow + rowBytes), y * rowBytes);
  }
  return out;
}

export function framesToPacketFrames(frames: ExtractedFrame[]): PacketFrame[] {
  return frames.map((f) => ({ index: f.index, rgb: rgbaToRgb(f.rgba) }));
}
