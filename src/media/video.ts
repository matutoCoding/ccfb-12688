// 视频素材探针与帧抓取：全程 <video> + Canvas 本地解码，Blob 不外传
import type { Asset, ID } from '../core/types';

export interface VideoProbe {
  duration: number;
  width: number;
  height: number;
  fps: number;
}

const videoPool = new Map<ID, HTMLVideoElement>();
const urlPool = new Map<ID, string>();

export function getObjectUrl(asset: Asset): string {
  let url = urlPool.get(asset.id);
  if (!url) {
    url = URL.createObjectURL(asset.blob);
    urlPool.set(asset.id, url);
  }
  return url;
}

export function getVideoElement(asset: Asset): HTMLVideoElement {
  let v = videoPool.get(asset.id);
  if (!v) {
    v = document.createElement('video');
    v.src = getObjectUrl(asset);
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    videoPool.set(asset.id, v);
  }
  return v;
}

/** 估算帧率：优先读 webkit/mozilla 元数据，取不到用 30fps 兜底（逐帧微调仍按帧步进） */
async function detectFps(video: HTMLVideoElement): Promise<number> {
  const anyV = video as HTMLVideoElement & {
    getVideoPlaybackQuality?: () => { totalVideoFrames?: number };
    mozParsedFrames?: number;
  };
  // requestVideoFrameCallback 路径下实测一次帧率
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    const fps = await new Promise<number | null>((resolve) => {
      const times: number[] = [];
      let count = 0;
      const onFrame = (_now: number, metadata: { mediaTime: number }) => {
        times.push(metadata.mediaTime);
        count += 1;
        if (count >= 8) {
          const deltas: number[] = [];
          for (let i = 1; i < times.length; i++) {
            const d = times[i] - times[i - 1];
            if (d > 0) deltas.push(d);
          }
          if (deltas.length >= 4) {
            const avg = deltas.sort((a, b) => a - b)[Math.floor(deltas.length / 2)];
            resolve(Math.round(1 / avg));
          } else resolve(null);
        } else {
          (video as HTMLVideoElement & { requestVideoFrameCallback(cb: typeof onFrame): void }).requestVideoFrameCallback(onFrame);
        }
      };
      video.currentTime = Math.min(0.1, (video.duration || 1) / 2);
      (video as HTMLVideoElement & { requestVideoFrameCallback(cb: typeof onFrame): void }).requestVideoFrameCallback(onFrame);
      setTimeout(() => resolve(null), 2500);
    });
    if (fps && fps > 5 && fps < 240) return fps;
    void anyV;
  }
  return 30;
}

export async function probeVideo(file: File): Promise<VideoProbe> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('视频解码失败，格式可能不受浏览器支持'));
    });
    const fps = await detectFps(video);
    return {
      duration: isFinite(video.duration) ? video.duration : 0,
      width: video.videoWidth,
      height: video.videoHeight,
      fps,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** seek 到指定时间并保证画面就绪（部分浏览器需要 seeked 事件） */
export function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  const target = Math.max(0, Math.min(time, (video.duration || Infinity) - 0.0001));
  if (Math.abs(video.currentTime - target) < 0.0005 && video.readyState >= 2) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = target;
  });
}

export async function captureFrame(asset: Asset, time: number): Promise<HTMLVideoElement> {
  const video = getVideoElement(asset);
  if (video.readyState < 2) {
    await new Promise<void>((resolve) => {
      video.onloadeddata = () => resolve();
      setTimeout(resolve, 3000);
    });
  }
  await seekTo(video, time);
  return video;
}

/** 生成缩略图 dataURL */
export async function makeThumbnail(asset: Asset, atSec?: number): Promise<string> {
  const video = await captureFrame(asset, atSec ?? Math.min(1, asset.duration / 4));
  const canvas = document.createElement('canvas');
  const w = 160;
  const h = Math.round((video.videoHeight / video.videoWidth) * w) || 90;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(video, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.7);
}

export function releaseVideo(id: ID): void {
  const url = urlPool.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    urlPool.delete(id);
  }
  const v = videoPool.get(id);
  if (v) {
    v.src = '';
    videoPool.delete(id);
  }
}
