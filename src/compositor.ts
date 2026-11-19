/**
 * 合成器：把工程画布（若干槽位 + 片段/图片）逐帧绘制到一个正方形 2D canvas，
 * 作为 POV 渲染器的内容纹理。视频片段按源时间码区间循环播放。
 */

import { getById } from './db';
import { Clip, MediaItem, Project, Slot } from './types';

interface SlotSource {
  slot: Slot;
  clip: Clip | null;
  media: MediaItem | null;
  el: HTMLVideoElement | HTMLImageElement | null;
  url: string | null;
}

export class Compositor {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private sources: SlotSource[] = [];
  private project: Project | null = null;
  playing = true;

  constructor(public size = 1024) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = size;
    this.canvas.height = size;
    this.ctx = this.canvas.getContext('2d')!;
  }

  async setProject(project: Project | null): Promise<void> {
    this.disposeSources();
    this.project = project;
    if (!project) return;
    for (const slot of project.slots) {
      const src: SlotSource = { slot, clip: null, media: null, el: null, url: null };
      if (slot.clipId) {
        const clip = await getById<Clip>('clips', slot.clipId);
        if (clip) {
          const media = await getById<MediaItem>('media', clip.mediaId);
          if (media) {
            src.clip = clip;
            src.media = media;
            src.url = URL.createObjectURL(media.blob);
            if (media.kind === 'video') {
              const v = document.createElement('video');
              v.src = src.url;
              v.muted = true;
              v.playsInline = true;
              v.preload = 'auto';
              src.el = v;
            } else {
              const img = new Image();
              img.src = src.url;
              src.el = img;
            }
          }
        }
      }
      this.sources.push(src);
    }
  }

  /** 每帧调用：t 为工程时间轴秒数 */
  draw(t: number): void {
    const { ctx, size } = this;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    if (!this.project) {
      this.drawTestPattern(t);
      return;
    }
    const sx = size / this.project.canvasW;
    const sy = size / this.project.canvasH;
    for (const src of this.sources) {
      const { slot } = src;
      const dx = slot.x * sx, dy = slot.y * sy, dw = slot.w * sx, dh = slot.h * sy;
      if (!src.el) {
        // 占位框
        ctx.strokeStyle = 'rgba(53,196,255,.5)';
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(dx + 1, dy + 1, dw - 2, dh - 2);
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(53,196,255,.6)';
        ctx.font = `${Math.max(12, dh * 0.12)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(slot.name, dx + dw / 2, dy + dh / 2);
        continue;
      }
      if (src.el instanceof HTMLVideoElement && src.clip) {
        const dur = src.clip.outPoint - src.clip.inPoint;
        if (this.playing && src.el.paused) src.el.play().catch(() => {});
        if (!this.playing && !src.el.paused) src.el.pause();
        // 片段区间循环：偏差大时重新对表
        const want = src.clip.inPoint + (dur > 0 ? (t % dur) : 0);
        if (Math.abs(src.el.currentTime - want) > 0.25) {
          try { src.el.currentTime = want; } catch { /* 元数据未就绪 */ }
        }
        if (src.el.currentTime >= src.clip.outPoint) {
          try { src.el.currentTime = src.clip.inPoint; } catch { /* noop */ }
        }
      }
      const el = src.el;
      const ready = el instanceof HTMLVideoElement ? el.readyState >= 2 : el.complete;
      if (!ready) continue;
      // cover 适配
      const ew = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
      const eh = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
      if (!ew || !eh) continue;
      const scale = Math.max(dw / ew, dh / eh);
      const sw = dw / scale, sh = dh / scale;
      ctx.drawImage(el, (ew - sw) / 2, (eh - sh) / 2, sw, sh, dx, dy, dw, dh);
    }
  }

  /** 无工程时的默认测试画面：色轮 + 刻度环 + 安全半径参考 */
  private drawTestPattern(t: number): void {
    const { ctx, size } = this;
    const c = size / 2;
    for (let i = 0; i < 360; i += 2) {
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.arc(c, c, c * 0.92, (i * Math.PI) / 180, ((i + 2) * Math.PI) / 180);
      ctx.fillStyle = `hsl(${i}, 90%, 55%)`;
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath();
    ctx.arc(c, c, c * 0.92, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(c, c, c * 0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${size * 0.06}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('HOLO FAN', c, c - size * 0.35);
    ctx.font = `${size * 0.035}px sans-serif`;
    ctx.fillText(`${Math.round(t % 60)}s`, c, c + size * 0.35);
  }

  private disposeSources(): void {
    for (const s of this.sources) {
      if (s.el instanceof HTMLVideoElement) { s.el.pause(); s.el.src = ''; }
      if (s.url) URL.revokeObjectURL(s.url);
    }
    this.sources = [];
  }

  destroy(): void {
    this.disposeSources();
  }
}
