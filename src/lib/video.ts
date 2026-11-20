/**
 * 视频素材引擎：本地入库、元数据探测、首帧缩略图、逐帧取帧、替换重链。
 * 全程使用 Blob/ObjectURL，文件不离开本机。
 */
import type { Clip, VideoSource } from '../types';
import { snapToFrame } from './timecode';
import { uid } from './dom';
import { store } from './store';

/** FNV-1a 哈希（文件指纹用，采样前 256KB + 文件名/大小，避免大文件全量读取） */
async function fingerprint(file: File): Promise<string> {
  const head = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
  let h = 0x811c9dc5;
  for (let i = 0; i < head.length; i++) {
    h ^= head[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a:${h.toString(16)}:${file.size}:${file.name}`;
}

function probeVideo(blob: Blob): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.src = url;
    video.onloadedmetadata = () => resolve(video);
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('视频元数据读取失败，格式可能不受浏览器支持'));
    };
  });
}

async function grabThumbnail(video: HTMLVideoElement, atSec: number): Promise<string> {
  await seek(video, atSec);
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = Math.max(1, Math.round((320 * video.videoHeight) / video.videoWidth));
  c.getContext('2d')!.drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72);
}

export function seek(video: HTMLVideoElement, timeSec: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - timeSec) < 0.001) return resolve();
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = Math.max(0, timeSec);
  });
}

export async function importVideoFile(file: File): Promise<VideoSource> {
  const fp = await fingerprint(file);
  const existing = store.videos.find((v) => v.fingerprint === fp);
  if (existing) throw new Error(`素材已入库：${existing.name}`);

  const video = await probeVideo(file);
  const durationSec = video.duration;
  const fps = await detectFps(video) ?? 30;
  const thumbnailDataUrl = await grabThumbnail(video, Math.min(0.1, durationSec / 2));
  URL.revokeObjectURL(video.src);

  const now = Date.now();
  const entity: VideoSource = {
    id: uid('vid'),
    name: file.name,
    fingerprint: fp,
    durationSec,
    width: video.videoWidth,
    height: video.videoHeight,
    fps,
    mimeType: file.type || 'video/*',
    sizeBytes: file.size,
    blob: file,
    thumbnailDataUrl,
    rating: 0,
    createdAt: now,
    updatedAt: now,
  };
  await store.save('videos', entity);
  return entity;
}

/** requestVideoFrameCallback 探测真实帧率，失败回退 undefined */
function detectFps(video: HTMLVideoElement): Promise<number | undefined> {
  return new Promise((resolve) => {
    const anyV = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (!anyV.requestVideoFrameCallback) return resolve(undefined);
    let count = 0;
    let first = 0;
    const tick = (_: unknown, md: { mediaTime: number }) => {
      if (count === 0) first = md.mediaTime;
      count++;
      if (count >= 8) {
        const span = md.mediaTime - first;
        resolve(span > 0 ? (count - 1) / span : undefined);
      } else {
        anyV.requestVideoFrameCallback!(tick);
      }
    };
    video.play().then(() => anyV.requestVideoFrameCallback!(tick)).catch(() => resolve(undefined));
    setTimeout(() => resolve(undefined), 1500);
  });
}

/**
 * 替换源文件：沿用原 VideoSource 的 id，更新 Blob/元数据。
 * 片段以源时间码引用，id 不变即自动重链；入出点时间码在新片中保持原位。
 */
export async function replaceSource(sourceId: string, file: File): Promise<VideoSource> {
  const old = store.videoById(sourceId);
  if (!old) throw new Error('待替换素材不存在');
  const video = await probeVideo(file);
  const fps = (await detectFps(video)) ?? old.fps;
  const thumbnailDataUrl = await grabThumbnail(video, Math.min(0.1, video.duration / 2));
  URL.revokeObjectURL(video.src);

  const next: VideoSource = {
    ...old,
    name: file.name,
    fingerprint: await fingerprint(file),
    durationSec: video.duration,
    width: video.videoWidth,
    height: video.videoHeight,
    fps,
    mimeType: file.type || old.mimeType,
    sizeBytes: file.size,
    blob: file,
    thumbnailDataUrl,
    updatedAt: Date.now(),
  };
  await store.save('videos', next);
  return next;
}

export async function relinkClip(clip: Clip, newSourceId: string): Promise<void> {
  const src = store.videoById(newSourceId);
  if (!src) throw new Error('目标素材不存在');
  const next: Clip = {
    ...clip,
    sourceId: newSourceId,
    sourceFps: src.fps,
    inPointSec: snapToFrame(Math.min(clip.inPointSec, src.durationSec), src.fps),
    outPointSec: snapToFrame(Math.min(clip.outPointSec, src.durationSec), src.fps),
    updatedAt: Date.now(),
  };
  await store.save('clips', next);
}

/** 取指定时刻的帧 ImageData（库内逐帧微调与调色预览用） */
export async function extractFrame(
  source: VideoSource,
  timeSec: number,
  maxWidth = 640,
): Promise<{ image: ImageData; canvas: HTMLCanvasElement; video: HTMLVideoElement; url: string }> {
  const video = await probeVideo(source.blob);
  await seek(video, Math.max(0, Math.min(timeSec, source.durationSec - 0.05)));
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { image, canvas, video, url: video.src };
}
