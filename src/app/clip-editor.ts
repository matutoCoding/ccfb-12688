import { h, toast, uid } from '../lib/dom';
import { store } from '../lib/store';
import type { Clip, ColorGrade, VideoSource } from '../types';
import { nudgeFrame, secToTimecode, snapToFrame } from '../lib/timecode';
import { seek, extractFrame } from '../lib/video';
import { applyLut } from '../lib/lut';
import { makeClip } from './library-page';

/**
 * 片段裁剪/调色编辑器。
 * - 入出点可拖、可逐帧 ±1 微调，始终对齐帧边界
 * - 显示源时间码；片段与原片的时间码关系持久化，替换源后自动重链
 * - 多套调色方案（LUT+曝光+饱和度），点击即切换并实时预览对比
 */
export function openClipEditor(source: VideoSource, onClose: () => void, existingClipId?: string): void {
  const existing = existingClipId ? store.clipById(existingClipId) : undefined;
  const clip: Clip = existing
    ? structuredClone(existing)
    : makeClip(source, Math.min(1, source.durationSec * 0.2), Math.min(source.durationSec * 0.5, source.durationSec));

  const previewCanvas = h('canvas', { style: 'width:100%;border-radius:8px;background:#000' }) as HTMLCanvasElement;
  const pctx = previewCanvas.getContext('2d')!;
  const video = document.createElement('video');
  video.src = URL.createObjectURL(source.blob);
  video.muted = true;
  let previewMode: 'in' | 'out' | 'play' = 'in';

  const inTc = h('span', { class: 'mono' });
  const outTc = h('span', { class: 'mono' });
  const gradeList = h('div', { class: 'pill-group' });

  async function renderPreview(): Promise<void> {
    inTc.textContent = secToTimecode(clip.inPointSec, clip.sourceFps);
    outTc.textContent = secToTimecode(clip.outPointSec, clip.sourceFps);
    const t = previewMode === 'out' ? clip.outPointSec : clip.inPointSec;
    await seek(video, t);
    const frame = await extractFrame(source, t, 640);
    const grade = clip.grades.find((g) => g.id === clip.activeGradeId);
    let image = frame.image;
    if (grade) {
      const lut = grade.lutId ? store.luts.find((l) => l.id === grade.lutId) : null;
      image = lut
        ? applyLut(frame.image, lut, grade.strength, grade.exposure, grade.saturation)
        : applyParam(frame.image, grade.exposure, grade.saturation);
    }
    previewCanvas.width = image.width;
    previewCanvas.height = image.height;
    pctx.putImageData(image, 0, 0);
    URL.revokeObjectURL(frame.url);
  }

  function renderGrades(): void {
    gradeList.replaceChildren();
    for (const g of clip.grades) {
      gradeList.appendChild(h('button', {
        class: g.id === clip.activeGradeId ? 'on' : '',
        onclick: () => { clip.activeGradeId = g.id; renderGrades(); renderPreview(); },
      }, g.name));
    }
    gradeList.appendChild(h('button', {
      onclick: () => {
        const ng: ColorGrade = { id: uid('grade'), name: `调色方案 ${clip.grades.length + 1}`, lutId: null, strength: 1, exposure: 0, saturation: 1 };
        clip.grades.push(ng);
        clip.activeGradeId = ng.id;
        renderGrades();
        renderPreview();
      },
    }, '＋ 新增方案'));
  }

  // 调色编辑区
  const lutSel = h('select', {},
    h('option', { value: '' }, '不使用 LUT（原图）'),
    ...store.luts.map((l) => h('option', { value: l.id, selected: currentGrade()?.lutId === l.id ? true : undefined }, `${l.name} (${l.size}³)`)),
  ) as HTMLSelectElement;
  const strength = h('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(currentGrade()?.strength ?? 1) }) as HTMLInputElement;
  const exposure = h('input', { type: 'range', min: '-2', max: '2', step: '0.05', value: String(currentGrade()?.exposure ?? 0) }) as HTMLInputElement;
  const saturation = h('input', { type: 'range', min: '0', max: '2', step: '0.02', value: String(currentGrade()?.saturation ?? 1) }) as HTMLInputElement;

  function currentGrade(): ColorGrade | undefined {
    return clip.grades.find((g) => g.id === clip.activeGradeId);
  }
  function syncGradeControls(): void {
    const g = currentGrade();
    lutSel.value = g?.lutId ?? '';
    strength.value = String(g?.strength ?? 1);
    exposure.value = String(g?.exposure ?? 0);
    saturation.value = String(g?.saturation ?? 1);
  }
  function applyControlsToGrade(): void {
    const g = currentGrade();
    if (!g) return;
    g.lutId = lutSel.value || null;
    g.strength = Number(strength.value);
    g.exposure = Number(exposure.value);
    g.saturation = Number(saturation.value);
    renderPreview();
  }
  lutSel.addEventListener('change', applyControlsToGrade);
  strength.addEventListener('input', applyControlsToGrade);
  exposure.addEventListener('input', applyControlsToGrade);
  saturation.addEventListener('input', applyControlsToGrade);

  // 时间轴拖柄
  const track = h('div', { class: 'trim-track' });
  const region = h('div', { class: 'trim-region' });
  const inHandle = h('div', { class: 'trim-handle', style: 'left:0' });
  const outHandle = h('div', { class: 'trim-handle' });
  track.append(region, inHandle, outHandle);
  const paintTrack = () => {
    const left = (clip.inPointSec / source.durationSec) * 100;
    const right = (clip.outPointSec / source.durationSec) * 100;
    inHandle.style.left = `${left}%`;
    outHandle.style.left = `calc(${right}% - 10px)`;
    region.style.left = `${left}%`;
    region.style.width = `${right - left}%`;
  };
  const drag = (which: 'in' | 'out') => (ev: PointerEvent) => {
    ev.preventDefault();
    const move = (e: PointerEvent) => {
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const t = snapToFrame(ratio * source.durationSec, source.fps);
      if (which === 'in') clip.inPointSec = Math.min(t, clip.outPointSec - 1 / source.fps);
      else clip.outPointSec = Math.max(t, clip.inPointSec + 1 / source.fps);
      previewMode = which;
      paintTrack();
      renderPreview();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  inHandle.addEventListener('pointerdown', drag('in'));
  outHandle.addEventListener('pointerdown', drag('out'));

  const nudge = (which: 'in' | 'out', delta: number) => {
    previewMode = which;
    if (which === 'in') {
      clip.inPointSec = nudgeFrame(clip.inPointSec, source.fps, delta, source.durationSec);
      clip.inPointSec = Math.min(clip.inPointSec, clip.outPointSec - 1 / source.fps);
    } else {
      clip.outPointSec = nudgeFrame(clip.outPointSec, source.fps, delta, source.durationSec);
      clip.outPointSec = Math.max(clip.outPointSec, clip.inPointSec + 1 / source.fps);
    }
    paintTrack();
    renderPreview();
  };

  const nameInput = h('input', { value: clip.name }) as HTMLInputElement;

  const close = () => {
    URL.revokeObjectURL(video.src);
    mask.remove();
    onClose();
  };

  const mask = h('div', { class: 'modal-mask', onclick: (e: Event) => { if (e.target === mask) close(); } },
    h('div', { class: 'modal', style: 'width:min(860px,100%)' },
      h('h2', {}, `裁剪片段 · ${source.name}`),
      previewCanvas,
      h('div', { class: 'card', style: 'margin:14px 0' },
        h('label', {}, '时间轴（拖动手柄，或用按钮逐帧微调）'),
        track,
        h('div', { class: 'grid cols-2', style: 'margin-top:12px' },
          h('div', {},
            h('div', { class: 'inline', style: 'display:flex;justify-content:space-between' }, h('strong', {}, '入点'), inTc),
            h('div', { class: 'pill-group' },
              h('button', { onclick: () => nudge('in', -1) }, '◀ 一帧'),
              h('button', { onclick: () => nudge('in', 1) }, '一帧 ▶'),
            ),
          ),
          h('div', {},
            h('div', { style: 'display:flex;justify-content:space-between' }, h('strong', {}, '出点'), outTc),
            h('div', { class: 'pill-group' },
              h('button', { onclick: () => nudge('out', -1) }, '◀ 一帧'),
              h('button', { onclick: () => nudge('out', 1) }, '一帧 ▶'),
            ),
          ),
        ),
        h('p', { class: 'sub muted', style: 'margin-top:10px' },
          `源帧率 ${source.fps.toFixed(2)} fps · 单帧 ${(1 / source.fps * 1000).toFixed(1)} ms · 片段时长 ${secToTimecode(clip.outPointSec - clip.inPointSec, source.fps)} · 时间码相对原片保存，源文件替换后自动重链`,
        ),
      ),
      h('div', { class: 'card' },
        h('h3', {}, '调色方案（同片段多套，点击切换实时对比）'),
        gradeList,
        h('div', { class: 'form-grid', style: 'margin-top:12px' },
          h('div', { class: 'span-2' }, h('label', {}, 'LUT 预设'), lutSel),
          h('div', {}, h('label', {}, `LUT 强度 ${strength.value}`), strength),
          h('div', {}, h('label', {}, `曝光 ${exposure.value} EV`), exposure),
          h('div', { class: 'span-2' }, h('label', {}, `饱和度 ${saturation.value}`), saturation),
        ),
      ),
      h('div', { style: 'margin-top:14px' }, h('label', {}, '片段名称'), nameInput),
      h('div', { class: 'actions' },
        h('button', { onclick: close }, '取消'),
        h('button', {
          class: 'primary',
          onclick: async () => {
            clip.name = nameInput.value || clip.name;
            clip.updatedAt = Date.now();
            clip.sourceFps = source.fps;
            await store.save('clips', clip);
            toast('片段已保存（源时间码已记录）');
            close();
          },
        }, '保存片段'),
      ),
    ),
  );
  document.body.appendChild(mask);
  paintTrack();
  renderGrades();
  syncGradeControls();
  renderPreview();
}

function applyParam(image: ImageData, exposure: number, saturation: number): ImageData {
  const ev = 2 ** exposure;
  const out = new Uint8ClampedArray(image.data);
  for (let i = 0; i < out.length; i += 4) {
    let r = out[i] * ev, g = out[i + 1] * ev, b = out[i + 2] * ev;
    if (saturation !== 1) {
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = luma + (r - luma) * saturation;
      g = luma + (g - luma) * saturation;
      b = luma + (b - luma) * saturation;
    }
    out[i] = r; out[i + 1] = g; out[i + 2] = b;
  }
  return new ImageData(out, image.width, image.height);
}
