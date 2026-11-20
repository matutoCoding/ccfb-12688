/** 源时间码工具：帧精度与 HH:MM:SS:FF 显示互转 */

export function secToTimecode(sec: number, fps: number): string {
  const totalFrames = Math.round(sec * fps);
  const f = ((totalFrames % Math.round(fps)) + Math.round(fps)) % Math.round(fps);
  const totalSec = Math.floor(totalFrames / Math.round(fps));
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':') + ':' + String(f).padStart(2, '0');
}

export function timecodeToSec(tc: string, fps: number): number {
  const parts = tc.trim().split(':').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some(Number.isNaN)) return NaN;
  const [h, m, s, f] = parts;
  return h * 3600 + m * 60 + s + f / fps;
}

/** 对齐到帧边界（逐帧微调的基础） */
export function snapToFrame(sec: number, fps: number): number {
  return Math.round(sec * fps) / fps;
}

/** 步进一帧，clamp 在 [0, duration] */
export function nudgeFrame(sec: number, fps: number, deltaFrames: number, durationSec: number): number {
  const frame = Math.round(sec * fps) + deltaFrames;
  const maxFrame = Math.round(durationSec * fps);
  return Math.max(0, Math.min(maxFrame, frame)) / fps;
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, sec);
  const mm = Math.floor(s / 60);
  const ss = (s % 60).toFixed(1).padStart(4, '0');
  return `${String(mm).padStart(2, '0')}:${ss}`;
}
