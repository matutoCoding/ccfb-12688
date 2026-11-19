/**
 * 素材库（功能点 1）：
 * - 视频/图片本地入库（Blob 存 IndexedDB，不上传）
 * - 时间轴标记入点/出点裁片段，切点逐帧微调，片段记录源时间码
 * - 原片替换后片段按源时间码自动重链
 * - 片段导入第三方 .cube LUT，可挂多套调色方案切换对比（CPU 实时预览缩略图）
 * - 五星评分 + 时长区间组合筛选
 */

import { del, getAll, getById, put } from '../db';
import { parseCube, sampleLut } from '../lut';
import { Clip, Grade, MediaItem, uid } from '../types';
import { clamp, downloadText, el, fmtTime, modal, pickFile } from '../util';

export class LibraryPage {
  el = el('div', { class: 'stack' });
  private media: MediaItem[] = [];
  private clips: Clip[] = [];
  private selectedMediaId: string | null = null;
  private filterRating = 0;
  private filterDurMin = 0;
  private filterDurMax = 9999;
  private objectUrls: string[] = [];
  // 裁剪状态
  private video: HTMLVideoElement | null = null;
  private inPoint = 0;
  private outPoint = 0;
  private trimPanel = el('div');
  private listPanel = el('div');
  private clipPanel = el('div');

  constructor() {
    this.el.append(this.buildToolbar(), this.listPanel, this.trimPanel, this.clipPanel);
    void this.reload();
  }

  private buildToolbar(): HTMLElement {
    const bar = el('div', { class: 'panel row' });
    const importBtn = el('button', { class: 'primary' }, '导入素材（本地处理）');
    importBtn.onclick = () => this.importMedia();
    const ratingSel = el('select');
    ratingSel.innerHTML = `<option value="0">全部评分</option><option value="1">≥1 星</option><option value="2">≥2 星</option>
      <option value="3">≥3 星</option><option value="4">≥4 星</option><option value="5">仅 5 星</option>`;
    ratingSel.onchange = () => { this.filterRating = Number(ratingSel.value); this.renderList(); };
    const durMin = el('input', { type: 'number', placeholder: '时长≥(s)', style: 'width:90px' });
    const durMax = el('input', { type: 'number', placeholder: '时长≤(s)', style: 'width:90px' });
    durMin.onchange = () => { this.filterDurMin = Number(durMin.value) || 0; this.renderList(); };
    durMax.onchange = () => { this.filterDurMax = Number(durMax.value) || 9999; this.renderList(); };
    bar.append(importBtn, el('span', { class: 'dim' }, '筛选:'), ratingSel, durMin, durMax);
    return bar;
  }

  private async reload(): Promise<void> {
    this.media = await getAll<MediaItem>('media');
    this.clips = await getAll<Clip>('clips');
    this.renderList();
    this.renderClips();
  }

  private async importMedia(): Promise<void> {
    const files = await pickFile('video/*,image/*', true);
    for (const f of files) {
      const kind = f.type.startsWith('video') ? 'video' : 'image';
      const item: MediaItem = {
        id: uid(), name: f.name, kind, blob: f, duration: 0, width: 0, height: 0,
        fps: 30, rating: 0, createdAt: Date.now(),
      };
      if (kind === 'video') {
        const meta = await probeVideo(f);
        Object.assign(item, meta);
      } else {
        const meta = await probeImage(f);
        Object.assign(item, meta);
      }
      await put('media', item);
    }
    await this.reload();
  }

  private makeUrl(blob: Blob): string {
    const u = URL.createObjectURL(blob);
    this.objectUrls.push(u);
    return u;
  }

  // ---------- 素材列表 ----------
  private renderList(): void {
    this.listPanel.replaceChildren();
    const panel = el('div', { class: 'panel' });
    panel.append(el('h3', {}, `素材（${this.media.length}）`));
    const table = el('table', { class: 'data' });
    table.innerHTML = `<thead><tr><th>名称</th><th>类型</th><th>时长</th><th>分辨率</th><th>评分</th><th>操作</th></tr></thead>`;
    const tbody = el('tbody');
    const filtered = this.media.filter((m) =>
      m.rating >= this.filterRating && m.duration >= this.filterDurMin &&
      (m.kind === 'image' || m.duration <= this.filterDurMax));
    for (const m of filtered) {
      const tr = el('tr');
      const stars = el('span', { class: 'stars' });
      const drawStars = () => {
        stars.replaceChildren(...[1, 2, 3, 4, 5].map((i) => {
          const s = el('span', { class: i <= m.rating ? 'on' : 'off' }, '★');
          s.onclick = async () => { m.rating = i === m.rating ? 0 : i; await put('media', m); drawStars(); };
          return s;
        }));
      };
      drawStars();
      const ops = el('td');
      const trimBtn = el('button', {}, m.kind === 'video' ? '裁剪/调色' : '查看');
      trimBtn.onclick = () => this.openTrim(m);
      const replaceBtn = el('button', {}, '替换原片');
      replaceBtn.onclick = () => this.replaceMedia(m);
      const delBtn = el('button', { class: 'danger' }, '删除');
      delBtn.onclick = async () => {
        await del('media', m.id);
        for (const c of this.clips.filter((c) => c.mediaId === m.id)) await del('clips', c.id);
        await this.reload();
      };
      ops.append(trimBtn, ' ', replaceBtn, ' ', delBtn);
      tr.append(
        el('td', {}, m.name),
        el('td', {}, m.kind === 'video' ? '视频' : '图片'),
        el('td', { class: 'mono' }, m.kind === 'video' ? fmtTime(m.duration) : '—'),
        el('td', { class: 'mono' }, m.width ? `${m.width}×${m.height}` : '—'),
        (() => { const td = el('td'); td.append(stars); return td; })(),
        ops,
      );
      tbody.append(tr);
    }
    table.append(tbody);
    panel.append(table);
    this.listPanel.append(panel);
  }

  // ---------- 替换原片：片段按源时间码自动重链 ----------
  private async replaceMedia(m: MediaItem): Promise<void> {
    const files = await pickFile(m.kind === 'video' ? 'video/*' : 'image/*');
    if (!files.length) return;
    const f = files[0];
    const affected = this.clips.filter((c) => c.mediaId === m.id);
    m.blob = f;
    m.replacedAt = Date.now();
    if (m.kind === 'video') Object.assign(m, await probeVideo(f));
    else Object.assign(m, await probeImage(f));
    await put('media', m);
    // 重链：片段只存源时间码，mediaId 不变即自动指向新文件同时间码。
    // 越界的片段（新片更短）钳位并提示。
    const clamped: string[] = [];
    for (const c of affected) {
      if (c.outPoint > m.duration && m.duration > 0) {
        c.outPoint = m.duration;
        c.inPoint = Math.min(c.inPoint, Math.max(0, m.duration - 0.1));
        await put('clips', c);
        clamped.push(c.name);
      }
    }
    await this.reload();
    const box = el('div');
    box.append(
      el('p', {}, `已替换「${m.name}」，${affected.length} 个引用片段已按源时间码自动重链到新文件。`),
      clamped.length
        ? el('p', { class: 'warn' }, `新片时长较短，以下片段出点已钳位：${clamped.join('、')}`)
        : el('p', { class: 'ok' }, '所有片段时间码均在新片有效范围内。'),
    );
    modal(box);
  }

  // ---------- 裁剪面板 ----------
  private openTrim(m: MediaItem): void {
    this.selectedMediaId = m.id;
    this.inPoint = 0;
    this.outPoint = m.duration || 1;
    this.trimPanel.replaceChildren();
    if (m.kind === 'image') {
      const panel = el('div', { class: 'panel' });
      panel.append(el('h3', {}, m.name));
      const img = el('img', { src: this.makeUrl(m.blob), style: 'max-width:480px;border-radius:8px' });
      panel.append(img);
      this.trimPanel.append(panel);
      return;
    }
    const url = this.makeUrl(m.blob);
    this.video = el('video', { src: url, controls: 'controls', style: 'width:100%;max-height:320px;background:#000;border-radius:8px' }) as HTMLVideoElement;
    this.video.muted = true;

    const panel = el('div', { class: 'panel stack' });
    panel.append(el('h3', {}, `裁剪：${m.name}（帧率 ${m.fps} fps）`));
    panel.append(this.video);

    const tl = el('div', { class: 'timeline' });
    const sel = el('div', { class: 'sel' });
    const inH = el('div', { class: 'handle' });
    const outH = el('div', { class: 'handle' });
    const playhead = el('div', { class: 'playhead' });
    tl.append(sel, inH, outH, playhead);
    panel.append(tl);

    const tc = el('div', { class: 'row mono' });
    panel.append(tc);

    const frame = 1 / (m.fps || 30);
    const nudge = (which: 'in' | 'out', dir: number) => {
      if (which === 'in') this.inPoint = clamp(this.inPoint + dir * frame, 0, this.outPoint - frame);
      else this.outPoint = clamp(this.outPoint + dir * frame, this.inPoint + frame, m.duration);
      this.video!.currentTime = which === 'in' ? this.inPoint : this.outPoint;
      draw();
    };
    const btns = el('div', { class: 'row' });
    const mkBtn = (label: string, fn: () => void) => { const b = el('button', {}, label); b.onclick = fn; return b; };
    btns.append(
      el('span', { class: 'dim' }, '入点:'),
      mkBtn('◀ 1帧', () => nudge('in', -1)), mkBtn('1帧 ▶', () => nudge('in', 1)),
      mkBtn('设为当前帧', () => { this.inPoint = clamp(this.video!.currentTime, 0, this.outPoint - frame); draw(); }),
      el('span', { class: 'dim' }, '　出点:'),
      mkBtn('◀ 1帧', () => nudge('out', -1)), mkBtn('1帧 ▶', () => nudge('out', 1)),
      mkBtn('设为当前帧', () => { this.outPoint = clamp(this.video!.currentTime, this.inPoint + frame, m.duration); draw(); }),
    );
    const cutBtn = el('button', { class: 'primary' }, '裁出片段');
    cutBtn.onclick = async () => {
      const clip: Clip = {
        id: uid(), mediaId: m.id,
        name: `${m.name.replace(/\.\w+$/, '')} [${fmtTime(this.inPoint)}–${fmtTime(this.outPoint)}]`,
        inPoint: this.inPoint, outPoint: this.outPoint,
        grades: [], activeGradeId: null, createdAt: Date.now(),
      };
      await put('clips', clip);
      await this.reload();
    };
    btns.append(el('span', { class: 'grow' }), cutBtn);
    panel.append(btns);

    const draw = () => {
      const d = m.duration || 1;
      sel.style.left = `${(this.inPoint / d) * 100}%`;
      sel.style.width = `${((this.outPoint - this.inPoint) / d) * 100}%`;
      inH.style.left = `${(this.inPoint / d) * 100}%`;
      outH.style.left = `${(this.outPoint / d) * 100}%`;
      tc.replaceChildren(
        el('span', {}, `入点 ${fmtTime(this.inPoint)}`),
        el('span', {}, `出点 ${fmtTime(this.outPoint)}`),
        el('span', { class: 'dim' }, `片段长 ${(this.outPoint - this.inPoint).toFixed(3)}s`),
      );
    };
    draw();

    // 拖动入点/出点手柄
    const dragHandle = (handle: HTMLElement, which: 'in' | 'out') => {
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const rect = tl.getBoundingClientRect();
        const move = (ev: MouseEvent) => {
          const t = clamp(((ev.clientX - rect.left) / rect.width) * m.duration, 0, m.duration);
          if (which === 'in') this.inPoint = Math.min(t, this.outPoint - frame);
          else this.outPoint = Math.max(t, this.inPoint + frame);
          draw();
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          this.video!.currentTime = which === 'in' ? this.inPoint : this.outPoint;
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
    };
    dragHandle(inH, 'in');
    dragHandle(outH, 'out');
    tl.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('handle')) return;
      const rect = tl.getBoundingClientRect();
      this.video!.currentTime = clamp(((e.clientX - rect.left) / rect.width) * m.duration, 0, m.duration);
    });
    this.video.addEventListener('timeupdate', () => {
      const d = m.duration || 1;
      playhead.style.left = `${(this.video!.currentTime / d) * 100}%`;
    });

    this.trimPanel.append(panel);
  }

  // ---------- 片段列表 + 调色 ----------
  private renderClips(): void {
    this.clipPanel.replaceChildren();
    const panel = el('div', { class: 'panel' });
    panel.append(el('h3', {}, `片段（${this.clips.length}）`));
    const table = el('table', { class: 'data' });
    table.innerHTML = `<thead><tr><th>片段</th><th>原片</th><th>源时间码 入/出</th><th>时长</th><th>调色方案</th><th>操作</th></tr></thead>`;
    const tbody = el('tbody');
    for (const c of this.clips) {
      const m = this.media.find((x) => x.id === c.mediaId);
      const tr = el('tr');
      const gradeTd = el('td');
      const chipRow = el('div', { class: 'row' });
      for (const g of c.grades) {
        const chip = el('span', { class: `chip${c.activeGradeId === g.id ? ' active' : ''}` }, g.name);
        chip.title = '点击切换到此方案';
        chip.onclick = async () => {
          c.activeGradeId = c.activeGradeId === g.id ? null : g.id;
          await put('clips', c);
          this.renderClips();
        };
        const x = el('span', { class: 'x' }, '✕');
        x.onclick = async (e) => {
          e.stopPropagation();
          c.grades = c.grades.filter((gg) => gg.id !== g.id);
          if (c.activeGradeId === g.id) c.activeGradeId = null;
          await put('clips', c);
          this.renderClips();
        };
        chip.append(x);
        chipRow.append(chip);
      }
      const addLut = el('button', {}, '+ LUT');
      addLut.onclick = () => this.importLut(c);
      const compare = el('button', {}, '对比');
      compare.onclick = () => this.compareGrades(c);
      chipRow.append(addLut, compare);
      gradeTd.append(chipRow);

      const ops = el('td');
      const delBtn = el('button', { class: 'danger' }, '删除');
      delBtn.onclick = async () => { await del('clips', c.id); await this.reload(); };
      ops.append(delBtn);

      const mediaTd = el('td');
      if (m) mediaTd.textContent = m.name;
      else mediaTd.append(el('span', { class: 'danger-text' }, '原片缺失'));
      tr.append(
        el('td', {}, c.name),
        mediaTd,
        el('td', { class: 'mono' }, `${fmtTime(c.inPoint)} / ${fmtTime(c.outPoint)}`),
        el('td', { class: 'mono' }, `${(c.outPoint - c.inPoint).toFixed(2)}s`),
        gradeTd,
        ops,
      );
      tbody.append(tr);
    }
    table.append(tbody);
    panel.append(table);
    this.clipPanel.append(panel);
  }

  private async importLut(c: Clip): Promise<void> {
    const files = await pickFile('.cube');
    if (!files.length) return;
    try {
      const lut = parseCube(await files[0].text());
      const grade: Grade = {
        id: uid(), name: lut.title || files[0].name, lutName: files[0].name,
        lutSize: lut.size, lutData: lut.data,
      };
      c.grades.push(grade);
      c.activeGradeId = grade.id;
      await put('clips', c);
      this.renderClips();
    } catch (err) {
      modal(el('div', {}, el('p', { class: 'danger-text' }, `LUT 解析失败：${(err as Error).message}`)));
    }
  }

  /** 多套调色方案并排实时对比（CPU 三线性采样当前帧） */
  private async compareGrades(c: Clip): Promise<void> {
    const m = this.media.find((x) => x.id === c.mediaId);
    if (!m || m.kind !== 'video') {
      modal(el('div', {}, el('p', {}, '图片素材或无原片，暂不支持逐帧对比。')));
      return;
    }
    const box = el('div', { class: 'stack' });
    box.append(el('h3', {}, `调色对比：${c.name}`));
    const rowEl = el('div', { class: 'row', style: 'align-items:flex-start' });
    box.append(rowEl);
    const { close } = modal(box);

    const url = this.makeUrl(m.blob);
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.controls = true;
    video.style.width = '100%';
    video.currentTime = c.inPoint;
    box.insertBefore(el('div', {}, video), rowEl);

    const variants: (Grade | null)[] = [null, ...c.grades];
    const canvases: { g: Grade | null; cv: HTMLCanvasElement }[] = [];
    for (const g of variants) {
      const wrap = el('div', { class: 'stack', style: 'gap:4px;align-items:center' });
      const cv = el('canvas', { width: '200', height: '120', style: 'border-radius:6px;background:#000' }) as HTMLCanvasElement;
      wrap.append(cv, el('span', { class: 'dim' }, g ? g.name : '原始'));
      rowEl.append(wrap);
      canvases.push({ g, cv });
    }
    const render = () => {
      if (video.readyState < 2) return;
      for (const { g, cv } of canvases) {
        const ctx = cv.getContext('2d')!;
        ctx.drawImage(video, 0, 0, cv.width, cv.height);
        if (g?.lutData && g.lutSize) {
          const img = ctx.getImageData(0, 0, cv.width, cv.height);
          const lut = { size: g.lutSize, data: g.lutData, title: '' };
          const out: [number, number, number] = [0, 0, 0];
          const d = img.data;
          for (let i = 0; i < d.length; i += 4) {
            sampleLut(lut, d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, out);
            d[i] = out[0] * 255; d[i + 1] = out[1] * 255; d[i + 2] = out[2] * 255;
          }
          ctx.putImageData(img, 0, 0);
        }
      }
    };
    video.addEventListener('seeked', render);
    video.addEventListener('play', () => {
      const tick = () => { if (!video.paused && !video.ended) { render(); requestAnimationFrame(tick); } };
      tick();
    });
    video.addEventListener('loadeddata', render);
    // 关闭弹窗时停掉视频
    const obs = new MutationObserver(() => {
      if (!document.body.contains(box)) { video.pause(); obs.disconnect(); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    void close;
  }

  destroy(): void {
    this.video?.pause();
    this.objectUrls.forEach((u) => URL.revokeObjectURL(u));
  }
}

// ---------- 媒体元数据探测 ----------
function probeVideo(blob: Blob): Promise<{ duration: number; width: number; height: number; fps: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = url;
    v.onloadedmetadata = () => {
      const meta = { duration: v.duration || 0, width: v.videoWidth, height: v.videoHeight, fps: 30 };
      URL.revokeObjectURL(url);
      resolve(meta);
    };
    v.onerror = () => { URL.revokeObjectURL(url); resolve({ duration: 0, width: 0, height: 0, fps: 30 }); };
  });
}

function probeImage(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve({ width: 0, height: 0 }); };
    img.src = url;
  });
}
