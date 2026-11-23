// 画布编排页：片段上时间轴、拖拽排程、画面几何变换、工程持久化
import { button, clear, h, modal, selectField, slider, textField, toast } from '../dom';
import { store } from '../../core/store';
import { idb } from '../../core/db';
import { uid } from '../../core/id';
import { formatClock } from '../../core/mathutil';
import type { CanvasItem, Project } from '../../core/types';

export function renderCanvasPage(root: HTMLElement): void {
  clear(root);
  ensureProject();
  const project = currentProject();

  root.append(
    h('div', { class: 'page-head' },
      h('h2', {}, '画布编排'),
      h('span', { class: 'sub' }, `工程：${project.name} · 时长 ${formatClock(project.duration)}`),
      h('div', { class: 'spacer' }),
      button('新建工程', () => void createProject(), 'primary'),
      button('重命名', () => renameProject(project)),
    ),
    h('div', { class: 'grid grid-2' },
      h('div', { class: 'card' },
        h('h3', {}, '片段（拖到时间轴或点击添加）'),
        clipBin(project),
      ),
      transformPanel(project),
    ),
    timelineCard(project),
  );
}

function ensureProject(): void {
  if (store.state.projects.length === 0) {
    const project: Project = {
      id: uid('proj'),
      name: '默认工程',
      items: [],
      duration: 30,
      bgColor: '#050508',
      updatedAt: Date.now(),
    };
    // 同步进入内存状态保证首帧可渲染，持久化异步落盘
    store.update({ projects: [project], currentProjectId: project.id });
    void idb.put('projects', project);
  } else if (!store.state.currentProjectId) {
    store.update({ currentProjectId: store.state.projects[0].id });
  }
}

function currentProject(): Project {
  return store.state.projects.find((p) => p.id === store.state.currentProjectId) ?? store.state.projects[0];
}

async function createProject(): Promise<void> {
  const project: Project = {
    id: uid('proj'), name: `工程 ${store.state.projects.length + 1}`,
    items: [], duration: 30, bgColor: '#050508', updatedAt: Date.now(),
  };
  await idb.put('projects', project);
  store.update({ projects: [...store.state.projects, project], currentProjectId: project.id });
  toast('新工程已创建', 'ok');
}

function renameProject(project: Project): void {
  const body = h('div', {}, textField('工程名称', project.name, (v) => { project.name = v; }));
  const m = modal('重命名工程', body, h('div', { class: 'row' },
    button('取消', () => m.close()),
    button('保存', () => { void saveProject({ ...project }); m.close(); }, 'primary')));
}

function clipBin(project: Project): HTMLElement {
  const clips = store.state.clips;
  if (!clips.length) return h('p', { class: 'muted' }, '还没有片段，先去素材库裁剪。');
  return h('div', { class: 'grid' }, ...clips.map((clip) => {
    const used = project.items.some((it) => it.clipId === clip.id);
    return h('div', {
      class: 'row',
      style: 'padding:8px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px;cursor:grab',
      draggable: true,
      ondragstart: (e: Event) => (e as DragEvent).dataTransfer?.setData('text/clip-id', clip.id),
    },
      h('div', { style: 'flex:1' },
        h('div', {}, clip.name),
        h('div', { class: 'muted mono' }, `${formatClock(clip.outPoint - clip.inPoint)} · ${clip.sourceInTc}`),
      ),
      used ? h('span', { class: 'tag' }, '已上轨') : null,
      button('加到时间轴', () => void addItem(project, clip.id), 'primary'),
    );
  }));
}

async function addItem(project: Project, clipId: string): Promise<void> {
  const clip = store.state.clips.find((c) => c.id === clipId);
  if (!clip) return;
  const lastEnd = Math.max(0, ...project.items.map((i) => i.start + i.duration));
  const item: CanvasItem = {
    id: uid('item'),
    clipId,
    start: Math.min(lastEnd, project.duration),
    duration: Math.min(clip.outPoint - clip.inPoint, project.duration),
    x: 0.5, y: 0.5, scale: 1, rotationDeg: 0, opacity: 1,
  };
  await saveProject({ ...project, items: [...project.items, item] });
  toast('已加入时间轴', 'ok');
}

function transformPanel(project: Project): HTMLElement {
  const card = h('div', { class: 'card' }, h('h3', {}, '画面变换（选中时间轴片段后编辑）'));
  const selectedId = selection.get(project.id) ?? project.items[0]?.id;
  const item = project.items.find((i) => i.id === selectedId);
  if (!item) {
    card.append(h('p', { class: 'muted' }, '时间轴为空。'));
    return card;
  }
  const clip = store.state.clips.find((c) => c.id === item.clipId);
  const update = async (patch: Partial<CanvasItem>) => {
    const next = { ...item, ...patch };
    await saveProject({ ...project, items: project.items.map((i) => (i.id === item.id ? next : i)) });
  };
  card.append(
    h('div', { class: 'muted', style: 'margin-bottom:8px' }, `当前选中：${clip?.name ?? item.clipId}`),
    slider({ min: 0, max: project.duration, step: 0.05, value: item.start, label: '时间轴起点', format: formatClock, onInput: (v) => void update({ start: v }) }),
    slider({ min: 0.1, max: Math.min(30, project.duration), step: 0.05, value: item.duration, label: '播放时长', format: formatClock, onInput: (v) => void update({ duration: v }) }),
    slider({ min: 0, max: 1, step: 0.01, value: item.x, label: '中心 X', onInput: (v) => void update({ x: v }) }),
    slider({ min: 0, max: 1, step: 0.01, value: item.y, label: '中心 Y', onInput: (v) => void update({ y: v }) }),
    slider({ min: 0.1, max: 1.5, step: 0.01, value: item.scale, label: '缩放', onInput: (v) => void update({ scale: v }) }),
    slider({ min: -180, max: 180, step: 1, value: item.rotationDeg, label: '旋转°', onInput: (v) => void update({ rotationDeg: v }) }),
    slider({ min: 0, max: 1, step: 0.01, value: item.opacity, label: '不透明度', onInput: (v) => void update({ opacity: v }) }),
    button('移出时间轴', () => void removeItem(project, item.id), 'danger'),
  );
  return card;
}

const selection = new Map<string, string>();

async function removeItem(project: Project, itemId: string): Promise<void> {
  await saveProject({ ...project, items: project.items.filter((i) => i.id !== itemId) });
}

async function saveProject(project: Project): Promise<void> {
  project.updatedAt = Date.now();
  await idb.put('projects', project);
  store.update({
    projects: store.state.projects.map((p) => (p.id === project.id ? project : p)),
    currentProjectId: project.id,
  });
}

function timelineCard(project: Project): HTMLElement {
  const card = h('div', { class: 'card' },
    h('div', { class: 'row' },
      h('h3', { style: 'margin:0' }, '时间轴'),
      h('div', { class: 'spacer' }),
      textField('工程时长(秒)', String(project.duration), (v) => void saveProject({ ...project, duration: Math.max(1, parseFloat(v) || 30) })),
      h('label', { class: 'field' }, h('span', {}, '背景色'), h('input', {
        type: 'color', value: project.bgColor,
        oninput: (e: Event) => void saveProject({ ...project, bgColor: (e.target as HTMLInputElement).value }),
      })),
    ),
  );
  const tl = h('div', { class: 'timeline' });
  const ruler = h('div', { class: 'ruler' });
  for (let t = 0; t <= project.duration; t += Math.max(1, Math.round(project.duration / 10))) {
    ruler.append(h('span', { class: 'tick', style: `left:${(t / project.duration) * 100}%` }, `${t}s`));
  }
  const track = h('div', { class: 'track' },
    ...project.items.map((item) => {
      const clip = store.state.clips.find((c) => c.id === item.clipId);
      const block = h('div', {
        class: 'clip-block',
        style: `left:${(item.start / project.duration) * 100}%;width:${(item.duration / project.duration) * 100}%`,
        onclick: () => { selection.set(project.id, item.id); renderCanvasPage(document.querySelector('.page')!); },
      }, h('div', {}, clip?.name ?? '?'), h('div', { class: 'muted mono' }, `${formatClock(item.start)} → ${formatClock(item.start + item.duration)}`));
      // 拖拽改变时间轴起点
      block.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/item-id', item.id);
      });
      block.draggable = true;
      return block;
    }),
  );
  track.addEventListener('dragover', (e) => e.preventDefault());
  track.addEventListener('drop', (e) => {
    e.preventDefault();
    const clipId = e.dataTransfer?.getData('text/clip-id');
    if (clipId) void addItem(project, clipId);
    const itemId = e.dataTransfer?.getData('text/item-id');
    if (itemId) {
      const rect = track.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      const item = project.items.find((i) => i.id === itemId);
      if (item) void saveProject({ ...project, items: project.items.map((i) => i.id === itemId ? { ...i, start: Math.max(0, ratio * project.duration) } : i) });
    }
  });
  const playhead = h('div', { class: 'playhead', style: 'left:0%' });
  tl.append(ruler, track, playhead);
  card.append(tl);

  // 预览工程的小窗（2D 缩略合成，真机成像在预览台查看）
  card.append(previewMini(project));
  return card;
}

function previewMini(project: Project): HTMLElement {
  const wrap = h('div', { class: 'row', style: 'margin-top:12px;align-items:flex-start' },
    h('canvas', { width: 240, height: 240, style: 'border-radius:50%;border:1px solid var(--line);background:#000' }),
    h('p', { class: 'muted', style: 'max-width:380px' },
      '圆形区域示意风扇成像范围。完整视觉暂留成像、转速漂移与校正效果请前往「预览台」。'),
  );
  setTimeout(() => drawMini(wrap.querySelector('canvas')!, project), 0);
  return wrap;
}

function drawMini(canvas: HTMLCanvasElement, project: Project): void {
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = project.bgColor;
  ctx.fillRect(0, 0, 240, 240);
  // 简单示意：按 transform 画色块占位（真实帧在预览台由 WebGL 合成）
  project.items.forEach((item, i) => {
    ctx.save();
    ctx.translate(item.x * 240, item.y * 240);
    ctx.rotate((item.rotationDeg * Math.PI) / 180);
    const w = 120 * item.scale;
    ctx.fillStyle = ['rgba(56,189,248,.55)', 'rgba(34,211,238,.45)', 'rgba(167,139,250,.45)'][i % 3];
    ctx.fillRect(-w / 2, -w / 2, w, w * 0.6);
    ctx.restore();
  });
}

export function projectOptions(): { value: string; text: string }[] {
  return store.state.projects.map((p) => ({ value: p.id, text: p.name }));
}

export { selectField };
