// 素材库页：视频入库、五星/时长筛选、片段入出点逐帧微调、LUT 多调色方案、源时间码重链
import { button, clear, h, modal, selectField, slider, stars, textField, toast } from '../dom';
import { store } from '../../core/store';
import { idb } from '../../core/db';
import { uid } from '../../core/id';
import { formatBytes, formatClock, fromTimecode, toTimecode } from '../../core/mathutil';
import { makeThumbnail, probeVideo, seekTo, getVideoElement } from '../../media/video';
import { parseCubeLut } from '../../media/lut';
import { serializeCubeLut } from '../../media/lut';
import { downloadBlob } from '../../core/mathutil';
import type { Asset, Clip, GradePreset } from '../../core/types';

interface Filters { rating: number; minDur: number; maxDur: number; keyword: string }
const filters: Filters = { rating: 0, minDur: 0, maxDur: 600, keyword: '' };

export function renderLibraryPage(root: HTMLElement): void {
  clear(root);
  const assets = filteredAssets();

  root.append(
    h('div', { class: 'page-head' },
      h('h2', {}, '素材库'),
      h('span', { class: 'sub' }, `共 ${store.state.assets.length} 个素材 · ${store.state.clips.length} 个片段`),
      h('div', { class: 'spacer' }),
      uploadButton(),
      button('导入 .cube LUT', () => void importLut()),
    ),
    filterBar(),
    h('div', { class: 'grid grid-4' }, ...assets.map(assetCard)),
    h('div', { class: 'card' }, h('h3', {}, `片段库（${store.state.clips.length}）`), clipTable()),
  );
}

function filteredAssets(): Asset[] {
  return store.state.assets
    .filter((a) => a.rating >= filters.rating)
    .filter((a) => a.duration >= filters.minDur && (filters.maxDur <= 0 || a.duration <= filters.maxDur))
    .filter((a) => !filters.keyword || a.name.toLowerCase().includes(filters.keyword.toLowerCase()));
}

function uploadButton(): HTMLElement {
  const input = h('input', {
    type: 'file', accept: 'video/*', multiple: true, style: 'display:none',
    onchange: () => void handleUpload(input as HTMLInputElement),
  });
  const wrap = h('span', {}, button('＋ 导入视频素材', () => (input as HTMLInputElement).click(), 'primary'), input);
  return wrap;
}

async function handleUpload(input: HTMLInputElement): Promise<void> {
  const files = [...(input.files ?? [])];
  if (!files.length) return;
  for (const file of files) {
    try {
      const probe = await probeVideo(file);
      const asset: Asset = {
        id: uid('asset'),
        name: file.name,
        blob: file,
        size: file.size,
        duration: probe.duration,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        rating: 0,
        tags: [],
        relinkAnchorSec: 0,
        fingerprint: `${file.name}:${file.size}:${probe.duration.toFixed(3)}`,
        createdAt: Date.now(),
      };
      await idb.put('assets', asset);
      store.update({ assets: [...store.state.assets, asset] });
      toast(`已入库：${file.name}`, 'ok');
    } catch (e) {
      toast(`入库失败 ${file.name}：${(e as Error).message}`, 'error');
    }
  }
  input.value = '';
}

async function importLut(): Promise<void> {
  const input = h('input', {
    type: 'file', accept: '.cube,text/plain',
    onchange: async () => {
      const file = (input as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const lut = parseCubeLut(text, file.name);
        await idb.put('luts', lut);
        store.update({ luts: [...store.state.luts, lut] });
        toast(`LUT 已导入：${lut.title}（${lut.gridSize}³）`, 'ok');
      } catch (e) {
        toast(`LUT 解析失败：${(e as Error).message}`, 'error');
      }
    },
  });
  input.click();
}

function filterBar(): HTMLElement {
  const card = h('div', { class: 'card' }, h('h3', {}, '组合筛选'));
  const row = h('div', { class: 'row' });
  row.append(
    h('span', { class: 'muted' }, '最低评分'),
    stars(filters.rating, (v) => { filters.rating = v; renderLibraryPage(document.querySelector('.page')!); }),
    textField('最短时长(秒)', String(filters.minDur), (v) => { filters.minDur = parseFloat(v) || 0; }),
    textField('最长时长(秒,0=不限)', String(filters.maxDur), (v) => { filters.maxDur = parseFloat(v) || 0; }),
    textField('名称关键字', filters.keyword, (v) => { filters.keyword = v; }),
    button('应用筛选', () => renderLibraryPage(document.querySelector('.page')!), 'primary'),
  );
  card.append(row);
  return card;
}

function assetCard(asset: Asset): HTMLElement {
  const card = h('div', { class: 'asset-card' });
  const thumb = h('img', { class: 'thumb', alt: asset.name }) as HTMLImageElement;
  void makeThumbnail(asset).then((url) => { thumb.src = url; }).catch(() => { thumb.remove(); });
  const relinkBadge = store.state.clips.some((c) => c.assetId === asset.id && c.relinkPending)
    ? h('span', { class: 'tag warn' }, '待重链') : null;
  card.append(
    thumb,
    h('div', { class: 'meta' },
      h('div', { class: 'name', title: asset.name }, asset.name),
      h('div', { class: 'sub' }, `${asset.width}×${asset.height} · ${asset.fps}fps · ${formatClock(asset.duration)} · ${formatBytes(asset.size)}`),
      h('div', { class: 'row' },
        stars(asset.rating, (v) => void rateAsset(asset, v)),
        relinkBadge,
      ),
      h('div', { class: 'row' },
        button('裁片段', () => openClipEditor(asset), 'primary'),
        button('替换原片', () => void replaceAsset(asset)),
        button('删除', () => void deleteAsset(asset), 'danger'),
      ),
    ),
  );
  return card;
}

async function rateAsset(asset: Asset, rating: number): Promise<void> {
  const next = { ...asset, rating: rating as Asset['rating'] };
  await idb.put('assets', next);
  store.update({ assets: store.state.assets.map((a) => (a.id === asset.id ? next : a)) });
}

async function deleteAsset(asset: Asset): Promise<void> {
  if (!confirm(`删除素材 ${asset.name}？关联片段将标记为待重链。`)) return;
  await idb.delete('assets', asset.id);
  const clips = store.state.clips.map((c) => c.assetId === asset.id ? { ...c, relinkPending: true } : c);
  await Promise.all(clips.filter((c) => c.relinkPending).map((c) => idb.put('clips', c)));
  store.update({ assets: store.state.assets.filter((a) => a.id !== asset.id), clips });
  toast('素材已删除', 'ok');
}

/** 原片替换：按源时间码自动重链所有引用片段 */
async function replaceAsset(old: Asset): Promise<void> {
  const input = h('input', {
    type: 'file', accept: 'video/*',
    onchange: async () => {
      const file = (input as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const probe = await probeVideo(file);
        const next: Asset = {
          ...old,
          name: file.name,
          blob: file,
          size: file.size,
          duration: probe.duration,
          width: probe.width,
          height: probe.height,
          fps: probe.fps,
          fingerprint: `${file.name}:${file.size}:${probe.duration.toFixed(3)}`,
        };
        await idb.put('assets', next);
        // 自动重链：片段保留源时间码，钳制到新文件时长内
        const clips = store.state.clips.map((c) => {
          if (c.assetId !== old.id) return c;
          const maxT = Math.max(0, probe.duration - 1 / probe.fps);
          return {
            ...c,
            relinkPending: false,
            inPoint: Math.min(c.inPoint, maxT),
            outPoint: Math.min(c.outPoint, probe.duration),
            fps: probe.fps,
            sourceInTc: toTimecode(Math.min(c.inPoint, maxT), probe.fps),
            sourceOutTc: toTimecode(Math.min(c.outPoint, probe.duration), probe.fps),
          };
        });
        await Promise.all(clips.map((c) => idb.put('clips', c)));
        store.update({
          assets: store.state.assets.map((a) => (a.id === old.id ? next : a)),
          clips,
        });
        toast(`原片已替换，${clips.filter((c) => c.assetId === old.id).length} 个片段已按源时间码自动重链`, 'ok');
      } catch (e) {
        toast(`替换失败：${(e as Error).message}`, 'error');
      }
    },
  });
  input.click();
}

// ---------------- 片段裁剪（逐帧微调） ----------------

function openClipEditor(asset: Asset): void {
  const video = getVideoElement(asset);
  const state = { inPoint: 0, outPoint: Math.min(5, asset.duration), name: `${asset.name.replace(/\.[^.]+$/, '')}-片段` };
  const preview = h('video', { muted: true, playsinline: true, src: video.src }) as HTMLVideoElement;
  preview.controls = true;
  const tcIn = h('span', { class: 'mono' });
  const tcOut = h('span', { class: 'mono' });
  const refreshTc = () => {
    tcIn.textContent = `入点 ${toTimecode(state.inPoint, asset.fps)}（${formatClock(state.inPoint)}）`;
    tcOut.textContent = `出点 ${toTimecode(state.outPoint, asset.fps)}（${formatClock(state.outPoint)}）`;
  };
  const seek = async (t: number) => {
    await seekTo(preview, t);
  };
  const frameStep = async (which: 'in' | 'out', dir: -1 | 1) => {
    const delta = dir / asset.fps;
    if (which === 'in') state.inPoint = Math.max(0, Math.min(state.inPoint + delta, state.outPoint - 1 / asset.fps));
    else state.outPoint = Math.min(asset.duration, Math.max(state.outPoint + delta, state.inPoint + 1 / asset.fps));
    refreshTc();
    await seek(which === 'in' ? state.inPoint : state.outPoint);
  };

  const body = h('div', {},
    preview,
    h('div', { class: 'card' },
      textField('片段名称', state.name, (v) => { state.name = v; }),
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('strong', {}, '入点 '), tcIn,
        button('◀ 帧', () => void frameStep('in', -1)),
        button('帧 ▶', () => void frameStep('in', 1)),
        button('设为当前画面', () => { state.inPoint = preview.currentTime; refreshTc(); }),
      ),
      h('div', { class: 'row' },
        h('strong', {}, '出点 '), tcOut,
        button('◀ 帧', () => void frameStep('out', -1)),
        button('帧 ▶', () => void frameStep('out', 1)),
        button('设为当前画面', () => { state.outPoint = preview.currentTime; refreshTc(); }),
      ),
      h('div', { class: 'muted', style: 'margin-top:8px' },
        `源时间码随切点记账，替换原片后按同时间码自动重链；帧步进精度 1/${asset.fps}s`),
    ),
  );
  refreshTc();
  const m = modal('裁剪片段 · 逐帧微调', body, h('div', { class: 'row' },
    button('取消', () => m.close()),
    button('创建片段并调色', () => { void createClip(asset, state); m.close(); }, 'primary'),
  ));
  void seek(0);
}

async function createClip(asset: Asset, state: { inPoint: number; outPoint: number; name: string }): Promise<void> {
  const clip: Clip = {
    id: uid('clip'),
    assetId: asset.id,
    name: state.name,
    inPoint: state.inPoint,
    outPoint: state.outPoint,
    sourceInTc: toTimecode(state.inPoint, asset.fps),
    sourceOutTc: toTimecode(state.outPoint, asset.fps),
    fps: asset.fps,
    grades: [],
    activeGradeId: null,
    relinkPending: false,
    createdAt: Date.now(),
  };
  await idb.put('clips', clip);
  store.update({ clips: [...store.state.clips, clip] });
  toast('片段已创建', 'ok');
  openGradeEditor(clip);
}

// ---------------- 多调色方案（LUT + 参数） ----------------

function clipTable(): HTMLElement {
  const table = h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, '片段'), h('th', {}, '源素材'), h('th', {}, '源时间码 入→出'),
      h('th', {}, '时长'), h('th', {}, '调色方案'), h('th', {}, '状态'), h('th', {}, '操作'))),
    h('tbody', {}, ...store.state.clips.map(clipRow)),
  );
  return table;
}

function clipRow(clip: Clip): HTMLElement {
  const asset = store.state.assets.find((a) => a.id === clip.assetId);
  return h('tr', {},
    h('td', {}, clip.name),
    h('td', {}, asset?.name ?? '（原片缺失）'),
    h('td', { class: 'mono' }, `${clip.sourceInTc} → ${clip.sourceOutTc}`),
    h('td', { class: 'mono' }, formatClock(clip.outPoint - clip.inPoint)),
    h('td', {}, ...clip.grades.map((g) => h('span', {
      class: 'tag' + (g.id === clip.activeGradeId ? ' ok' : ''),
      style: 'margin-right:4px;cursor:pointer',
      title: '点击切换对比',
      onclick: () => void switchGrade(clip, g.id),
    }, g.name))),
    h('td', {}, clip.relinkPending ? h('span', { class: 'tag danger' }, '待重链') : h('span', { class: 'tag ok' }, '正常')),
    h('td', {},
      button('调色', () => openGradeEditor(clip), 'primary'),
      button('导出LUT', () => exportClipLut(clip)),
      button('删除', () => void deleteClip(clip), 'danger'),
    ),
  );
}

async function switchGrade(clip: Clip, gradeId: string | null): Promise<void> {
  const next = { ...clip, activeGradeId: clip.activeGradeId === gradeId ? null : gradeId };
  await idb.put('clips', next);
  store.update({ clips: store.state.clips.map((c) => (c.id === clip.id ? next : c)) });
}

async function deleteClip(clip: Clip): Promise<void> {
  if (!confirm(`删除片段 ${clip.name}？`)) return;
  await idb.delete('clips', clip.id);
  store.update({ clips: store.state.clips.filter((c) => c.id !== clip.id) });
}

function exportClipLut(clip: Clip): void {
  const g = clip.grades.find((x) => x.id === clip.activeGradeId);
  if (!g?.lutId) return toast('该片段没有启用 LUT 调色方案', 'error');
  const lut = store.state.luts.find((l) => l.id === g.lutId);
  if (!lut) return;
  downloadBlob(new Blob([serializeCubeLut(lut)], { type: 'text/plain' }), `${lut.title}.cube`);
}

function openGradeEditor(clip: Clip): void {
  const asset = store.state.assets.find((a) => a.id === clip.assetId);
  if (!asset) return toast('原片缺失，请先替换重链', 'error');
  const video = getVideoElement(asset);
  const preview = h('video', { muted: true, playsinline: true, src: video.src, autoplay: true }) as HTMLVideoElement;
  void seekTo(preview, clip.inPoint);

  const gradeList = h('div', {});
  const renderGrades = () => {
    gradeList.replaceChildren(...clip.grades.map((g) => h('div', { class: 'row', style: 'padding:6px 0;border-bottom:1px solid var(--line)' },
      h('span', { class: 'tag' + (g.id === clip.activeGradeId ? ' ok' : '') }, g.name),
      h('span', { class: 'muted' }, g.lutId ? store.state.luts.find((l) => l.id === g.lutId)?.title ?? 'LUT缺失' : '无LUT'),
      button(g.id === clip.activeGradeId ? '取消启用' : '启用对比', () => void switchGrade(clip, g.id)),
      button('删除方案', () => void removeGrade(clip, g.id), 'danger'),
    )));
  };
  renderGrades();

  const draft = { name: `方案${clip.grades.length + 1}`, lutId: '' as string, gain: [1, 1, 1] as [number, number, number], saturation: 1, brightness: 0, contrast: 1 };
  const lutOptions = [{ value: '', text: '不使用 LUT' }, ...store.state.luts.map((l) => ({ value: l.id, text: l.title }))];

  const body = h('div', { class: 'grid grid-2' },
    h('div', {}, preview, h('div', { class: 'muted' }, '预览实时套用当前启用的调色方案，多方案可反复切换对比')),
    h('div', { class: 'card' },
      h('h3', {}, '新增调色方案'),
      textField('方案名称', draft.name, (v) => { draft.name = v; }),
      selectField('第三方 LUT', lutOptions, '', (v) => { draft.lutId = v; }),
      slider({ min: 0.2, max: 2, step: 0.01, value: 1, label: 'R 增益', onInput: (v) => { draft.gain[0] = v; } }),
      slider({ min: 0.2, max: 2, step: 0.01, value: 1, label: 'G 增益', onInput: (v) => { draft.gain[1] = v; } }),
      slider({ min: 0.2, max: 2, step: 0.01, value: 1, label: 'B 增益', onInput: (v) => { draft.gain[2] = v; } }),
      slider({ min: 0, max: 2, step: 0.01, value: 1, label: '饱和度', onInput: (v) => { draft.saturation = v; } }),
      slider({ min: -0.5, max: 0.5, step: 0.01, value: 0, label: '亮度', onInput: (v) => { draft.brightness = v; } }),
      slider({ min: 0.5, max: 2, step: 0.01, value: 1, label: '对比度', onInput: (v) => { draft.contrast = v; } }),
      button('保存为新方案', () => void addGrade(clip, draft, renderGrades), 'primary'),
      h('hr', { style: 'border-color:var(--line);margin:14px 0' }),
      h('h3', {}, '已有方案'),
      gradeList,
    ),
  );
  modal(`调色方案 · ${clip.name}`, body);
}

async function addGrade(clip: Clip, draft: {
  name: string; lutId: string; gain: [number, number, number];
  saturation: number; brightness: number; contrast: number;
}, refresh: () => void): Promise<void> {
  const grade: GradePreset = {
    id: uid('grade'),
    name: draft.name || `方案${clip.grades.length + 1}`,
    lutId: draft.lutId || null,
    gain: [...draft.gain] as [number, number, number],
    saturation: draft.saturation,
    brightness: draft.brightness,
    contrast: draft.contrast,
  };
  const next = { ...clip, grades: [...clip.grades, grade], activeGradeId: grade.id };
  await idb.put('clips', next);
  store.update({ clips: store.state.clips.map((c) => (c.id === clip.id ? next : c)) });
  toast('调色方案已保存并启用', 'ok');
  refresh();
}

async function removeGrade(clip: Clip, gradeId: string): Promise<void> {
  const grades = clip.grades.filter((g) => g.id !== gradeId);
  const next = { ...clip, grades, activeGradeId: clip.activeGradeId === gradeId ? null : clip.activeGradeId };
  await idb.put('clips', next);
  store.update({ clips: store.state.clips.map((c) => (c.id === clip.id ? next : c)) });
}

// 供时间码手动校正使用
export function applyManualTc(clip: Clip, inTc: string, outTc: string): void {
  const inPoint = fromTimecode(inTc, clip.fps);
  const outPoint = fromTimecode(outTc, clip.fps);
  if (isNaN(inPoint) || isNaN(outPoint) || outPoint <= inPoint) {
    toast('时间码格式错误，应为 HH:MM:SS:FF', 'error');
    return;
  }
  void (async () => {
    const next = { ...clip, inPoint, outPoint, sourceInTc: inTc, sourceOutTc: outTc };
    await idb.put('clips', next);
    store.update({ clips: store.state.clips.map((c) => (c.id === clip.id ? next : c)) });
  })();
}
