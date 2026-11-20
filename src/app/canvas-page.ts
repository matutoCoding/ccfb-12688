import { h, clear, toast, uid } from '../lib/dom';
import { store } from '../lib/store';
import type { CanvasItem, Project, ProjectTemplate } from '../types';
import { emptyState, pageHeader } from './shell';
import { navigate } from './router';

export function canvasPage(): HTMLElement {
  const root = h('div', {});

  const draw = () => {
    const project = store.currentProject;
    clear(root);
    root.appendChild(pageHeader('画布编排', '工程模板、占位框与片段绑定、扇叶参数适配；模板升级后可一键同步改动'));
    if (!project) {
      root.appendChild(projectList());
      return;
    }

    // 模板版本同步提示
    const tpl = store.templates.find((t) => t.id === project.templateId);
    if (tpl && project.templateVersionAtCreation !== null && tpl.version > project.templateVersionAtCreation) {
      root.appendChild(h('div', { class: 'card', style: 'border-color:#78350f;margin-bottom:16px' },
        h('div', { style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap' },
          h('div', {}, h('strong', { style: 'color:var(--warn)' }, `模板「${tpl.name}」已发布 v${tpl.version}（本工程基于 v${project.templateVersionAtCreation}）`),
            h('div', { class: 'sub muted' }, '同步会更新扇叶参数并补齐新版占位框，已绑定的片段与自定义项保留')),
          h('button', { class: 'primary', onclick: () => syncTemplate(project, tpl, draw) }, '同步模板改动'),
          h('button', { onclick: draw }, '暂不同步'),
        ),
      ));
    }

    const layout = h('div', { class: 'preview-layout' },
      polarEditor(project, draw),
      itemPanel(project, draw),
    );
    root.appendChild(layout);
  };

  store.subscribe(draw);
  draw();
  return root;
}

function projectList(): HTMLElement {
  const wrap = h('div', {});
  const newProject = (tpl: ProjectTemplate | null) => {
    const now = Date.now();
    const items: CanvasItem[] = (tpl?.placeholders ?? []).map((p) => ({
      ...p,
      id: uid('item'),
      clipId: null,
      trackStartSec: 0,
    }));    const project: Project = {
      id: uid('proj'),
      name: tpl ? `${tpl.name} 方案` : `自定义方案 ${store.projects.length + 1}`,
      templateId: tpl?.id ?? null,
      templateVersionAtCreation: tpl?.version ?? null,
      targetDeviceId: store.currentDeviceId,
      ledCount: tpl?.canvas.ledCount ?? 224,
      framesPerRevolution: tpl?.canvas.framesPerRevolution ?? 720,
      diameterMm: tpl?.canvas.diameterMm ?? 650,
      items,
      totalDurationSec: 10,
      createdAt: now,
      updatedAt: now,
    };
    store.save('projects', project).then(() => {
      store.currentProjectId = project.id;
      store.emit();
    });
  };

  wrap.appendChild(h('div', { class: 'grid cols-3', style: 'margin-bottom:22px' },
    ...store.templates.map((tpl) =>
      h('div', { class: 'card' },
        h('h3', {}, tpl.name, h('span', { class: 'badge accent', style: 'margin-left:8px' }, `v${tpl.version}`)),
        h('p', { class: 'sub muted' }, tpl.description),
        h('p', { class: 'sub' }, `LED ${tpl.canvas.ledCount} 颗 · 每圈 ${tpl.canvas.framesPerRevolution} 帧 · ⌀${tpl.canvas.diameterMm}mm · ${tpl.placeholders.length} 个占位框`),
        h('button', { class: 'primary', onclick: () => newProject(tpl) }, '用此模板新建'),
      ),
    ),
    h('div', { class: 'card', style: 'border-style:dashed' },
      h('h3', {}, '空白工程'),
      h('p', { class: 'sub muted' }, '不带占位框，手动添加扇形区域'),
      h('button', { onclick: () => newProject(null) }, '新建空白工程'),
    ),
  ));

  if (store.projects.length) {
    wrap.appendChild(h('h2', { style: 'font-size:15px;margin:0 0 10px' }, '已有工程'));
    wrap.appendChild(h('div', { class: 'card scroll-x' }, h('table', {},
      h('thead', {}, h('tr', {}, ['工程名', '模板', 'LED/帧', '时长', '更新时间', '操作'].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...store.projects.map((p) => {
        const tpl = store.templates.find((t) => t.id === p.templateId);
        return h('tr', {},
          h('td', {}, p.name),
          h('td', {}, tpl ? `${tpl.name} v${p.templateVersionAtCreation}` : h('span', { class: 'muted' }, '自定义')),
          h('td', {}, `${p.ledCount} / ${p.framesPerRevolution}`),
          h('td', {}, `${p.totalDurationSec}s`),
          h('td', { class: 'muted' }, new Date(p.updatedAt).toLocaleString()),
          h('td', {}, h('div', { class: 'pill-group' },
            h('button', { onclick: () => { store.currentProjectId = p.id; store.emit(); } }, '打开'),
            h('button', { class: 'danger', onclick: async () => { if (confirm(`删除工程 ${p.name}？`)) { await store.remove('projects', p.id); } } }, '删除'),
          )),
        );
      })),
    )));
  } else {
    wrap.appendChild(emptyState('选择一个行业模板开始，新建后替换占位素材即自动适配扇叶参数。'));
  }
  return wrap;
}

/** 极坐标占位编辑画布（俯视圆盘，占位框为扇环） */
function polarEditor(project: Project, refresh: () => void): HTMLElement {
  const size = 520;
  const canvas = h('canvas', { width: String(size), height: String(size), style: 'width:100%;max-width:560px;background:#05070a;border-radius:50%;border:1px solid var(--line)' }) as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  let selectedId = project.items[0]?.id ?? null;

  const paint = () => {
    const cx = size / 2, cy = size / 2, R = size * 0.46;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#070b10';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    // 网格
    ctx.strokeStyle = '#1b2531';
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath(); ctx.arc(cx, cy, (R * i) / 4, 0, Math.PI * 2); ctx.stroke();
    }
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2 - Math.PI / 2;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R); ctx.stroke();
    }
    for (const item of project.items) {
      const r0 = item.r0 * R, r1 = item.r1 * R;
      const a0 = item.angle0 - Math.PI / 2;
      const a1 = a0 + item.angleSpan;
      ctx.beginPath();
      ctx.arc(cx, cy, r1, a0, a1);
      ctx.arc(cx, cy, r0, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = selectedId === item.id ? 'rgba(56,189,248,0.30)' : 'rgba(56,189,248,0.14)';
      ctx.fill();
      ctx.strokeStyle = selectedId === item.id ? '#38bdf8' : '#2b6a88';
      ctx.lineWidth = selectedId === item.id ? 2.5 : 1.2;
      ctx.stroke();
      const midA = (a0 + a1) / 2, midR = (r0 + r1) / 2;
      ctx.fillStyle = '#bfe6fb';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(item.label, cx + Math.cos(midA) * midR, cy + Math.sin(midA) * midR);
    }
  };

  canvas.addEventListener('pointerdown', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * size - size / 2;
    const y = ((ev.clientY - rect.top) / rect.height) * size - size / 2;
    const radius = Math.hypot(x, y) / (size * 0.46);
    const angle = (Math.atan2(y, x) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
    const hit = [...project.items].reverse().find((it) => {
      const inR = radius >= it.r0 && radius <= it.r1;
      const end = (it.angle0 + it.angleSpan) % (Math.PI * 2);
      const inA = it.angleSpan >= Math.PI * 2 - 0.01 || (angle >= it.angle0 && angle <= end);
      return inR && inA;
    });
    if (hit) {
      selectedId = hit.id;
      paint();
      refresh();
    }
  });

  const host = h('div', { class: 'card' }, h('h3', {}, '极坐标画布（俯视，点击扇环选择占位框）'), canvas);
  queueMicrotask(paint);
  (host as unknown as { _paint: () => void })._paint = paint;
  return host;
}

function itemPanel(project: Project, refresh: () => void): HTMLElement {
  const panel = h('div', { class: 'card' }, h('h3', {}, '工程与占位框'));
  const nameInput = h('input', { value: project.name, onchange: async () => { project.name = nameInput.value; await persist(); } }) as HTMLInputElement;
  const ledInput = h('input', { type: 'number', value: String(project.ledCount), min: '32', max: '1024', onchange: async () => { project.ledCount = Number(ledInput.value); await persist(); } }) as HTMLInputElement;
  const fprInput = h('input', { type: 'number', value: String(project.framesPerRevolution), min: '120', max: '2000', step: '20', onchange: async () => { project.framesPerRevolution = Number(fprInput.value); await persist(); } }) as HTMLInputElement;
  const durInput = h('input', { type: 'number', value: String(project.totalDurationSec), min: '1', step: '1', onchange: async () => { project.totalDurationSec = Number(durInput.value); await persist(); } }) as HTMLInputElement;

  const persist = async () => { project.updatedAt = Date.now(); await store.save('projects', project); };

  panel.appendChild(h('div', { class: 'form-grid' },
    h('div', { class: 'span-2' }, h('label', {}, '工程名称'), nameInput),
    h('div', {}, h('label', {}, '灯珠数（自动适配目标设备）'), ledInput),
    h('div', {}, h('label', {}, '每圈帧数'), fprInput),
    h('div', { class: 'span-2' }, h('label', {}, '工程总时长(s)'), durInput),
  ));

  const deviceSel = h('select', {
    onchange: async () => {
      project.targetDeviceId = deviceSel.value || null;
      const dev = store.currentDevice;
      if (dev) {
        project.ledCount = dev.ledCount;
        project.diameterMm = dev.diameterMm;
        toast('已按设备灯珠数/直径自动适配画布参数');
      }
      await persist();
      refresh();
    },
  },
    h('option', { value: '' }, '不绑定设备'),
    ...store.devices.map((d) => h('option', { value: d.id, selected: d.id === project.targetDeviceId ? true : undefined }, `${d.serialNumber}（${d.groupName}）`)),
  );
  panel.appendChild(h('div', { style: 'margin:12px 0' }, h('label', {}, '目标设备（替换占位素材/切换设备时自动适配扇叶参数）'), deviceSel));

  const itemsBox = h('div', { style: 'display:flex;flex-direction:column;gap:10px;margin-top:8px' });
  const renderItems = () => {
    itemsBox.replaceChildren();
    for (const item of project.items) {
      const clipSel = h('select', {
        onchange: async () => {
          item.clipId = clipSel.value || null;
          const clip = store.clipById(item.clipId!);
          if (clip) {
            item.durationSec = clip.outPointSec - clip.inPointSec;
            item.label = clip.name;
          }
          await persist();
          refresh();
        },
      },
        h('option', { value: '' }, '空占位（未绑定片段）'),
        ...store.clips.map((c) => h('option', { value: c.id, selected: c.id === item.clipId ? true : undefined }, c.name)),
      );
      const r0 = h('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(item.r0), oninput: () => { item.r0 = Math.min(Number(r0.value), item.r1 - 0.02); persist(); repaint(); } }) as HTMLInputElement;
      const r1 = h('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(item.r1), oninput: () => { item.r1 = Math.max(Number(r1.value), item.r0 + 0.02); persist(); repaint(); } }) as HTMLInputElement;
      const span = h('input', { type: 'range', min: '0.1', max: String(Math.PI * 2), step: '0.05', value: String(item.angleSpan), oninput: () => { item.angleSpan = Number(span.value); persist(); repaint(); } }) as HTMLInputElement;
      const start = h('input', { type: 'number', min: '0', step: '0.5', value: String(item.trackStartSec), onchange: async () => { item.trackStartSec = Number(start.value); await persist(); } }) as HTMLInputElement;
      itemsBox.appendChild(h('div', { class: 'card', style: 'padding:12px' },
        h('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, h('strong', { style: 'font-size:13px' }, item.label),
          h('button', { class: 'danger ghost', onclick: async () => { project.items = project.items.filter((i) => i.id !== item.id); await persist(); refresh(); } }, '删除')),
        h('div', { style: 'margin:8px 0' }, h('label', {}, '绑定片段（替换占位素材）'), clipSel, h('div', { class: 'sub muted' }, `轨道起点 ${start.value}s · 时长 ${item.durationSec.toFixed(2)}s`), start),
        h('label', {}, `径向起点 r0=${item.r0.toFixed(2)}`), r0,
        h('label', {}, `径向终点 r1=${item.r1.toFixed(2)}`), r1,
        h('label', {}, `扇形张角 ${(item.angleSpan / Math.PI).toFixed(2)}π`), span,
      ));
    }
  };
  const repaint = () => {
    const card = panel.previousElementSibling as HTMLElement & { _paint?: () => void };
    card?._paint?.();
  };
  renderItems();
  panel.appendChild(itemsBox);
  panel.appendChild(h('div', { class: 'pill-group', style: 'margin-top:14px' },
    h('button', {
      onclick: async () => {
        project.items.push({ id: uid('item'), clipId: null, name: `占位框 ${project.items.length + 1}`, r0: 0.2, r1: 0.9, angle0: 0, angleSpan: Math.PI, trackStartSec: 0, durationSec: 5, label: `占位框 ${project.items.length + 1}` });
        await persist();
        refresh();
      },
    }, '＋ 添加占位框'),
    h('button', { onclick: () => navigate('/preview') }, '前往预览台 →'),
  ));
  return panel;
}

async function syncTemplate(project: Project, tpl: ProjectTemplate, refresh: () => void): Promise<void> {
  project.ledCount = tpl.canvas.ledCount;
  project.framesPerRevolution = tpl.canvas.framesPerRevolution;
  project.diameterMm = tpl.canvas.diameterMm;
  // 新版占位：按 name 匹配保留绑定，新增的补齐
  for (const ph of tpl.placeholders) {
    const exist = project.items.find((i) => i.name === ph.name);
    if (exist) {
      Object.assign(exist, { r0: ph.r0, r1: ph.r1, angle0: ph.angle0, angleSpan: ph.angleSpan, durationSec: ph.durationSec });
    } else {
      project.items.push({ ...ph, id: uid('item'), clipId: null, trackStartSec: 0 });
    }
  }
  project.templateVersionAtCreation = tpl.version;
  project.updatedAt = Date.now();
  await store.save('projects', project);
  toast('模板改动已同步，已有片段绑定保留');
  refresh();
}
