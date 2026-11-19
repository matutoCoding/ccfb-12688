/**
 * 画布编排（功能点 9 + 槽位布局）：
 * - 行业模板新建工程，带出画布尺寸与素材占位框
 * - 占位框可拖拽/缩放，从素材库分配片段，替换后自动适配扇叶参数（收进安全圆）
 * - 模板支持版本更新，旧模板工程打开时提示是否同步模板改动
 */

import { del, getAll, getById, put } from '../db';
import { store } from '../store';
import { BUILTIN_TEMPLATES, latestTemplate, TEMPLATE_HISTORY } from '../templates';
import { Clip, Project, Slot, uid } from '../types';
import { clamp, el, modal } from '../util';

const SAFE_RADIUS = 0.92; // 默认扇叶安全半径（相对圆盘）

export class CanvasPage {
  el = el('div', { class: 'layout-2r' });
  private projects: Project[] = [];
  private clips: Clip[] = [];
  private project: Project | null = null;
  /** 已弹过模板同步提示的工程，避免同次驻留内重复弹窗 */
  private syncPrompted = new Set<string>();
  private checkedCurrentId: string | null = null;
  private selectedSlotId: string | null = null;
  private leftPanel = el('div', { class: 'stack' });
  private stageWrap = el('div', { class: 'panel' });
  private stage = el('div', { style: 'position:relative;margin:0 auto;background:#0a0d12;border-radius:8px;overflow:hidden' });

  constructor() {
    this.el.append(this.leftPanel, this.stageWrap);
    void this.reload();
  }

  private async reload(): Promise<void> {
    this.projects = await getAll<Project>('projects');
    this.clips = await getAll<Clip>('clips');
    const currentId = store.currentProjectId;
    // 当前工程变化（含刷新后首次载入）时重新解析并检查模板版本
    if (currentId !== this.checkedCurrentId) {
      this.checkedCurrentId = currentId;
      this.project = currentId
        ? (this.projects.find((p) => p.id === currentId) ?? this.projects[0] ?? null)
        : (this.projects[0] ?? null);
      if (this.project) {
        if (this.project.id !== currentId) void store.setCurrentProject(this.project.id);
        this.checkTemplateSync(this.project);
      }
    } else {
      const fresh = this.project ? this.projects.find((p) => p.id === this.project!.id) : undefined;
      if (fresh) this.project = fresh;
      if (!this.project && this.projects.length) {
        this.project = this.projects[0];
        void store.setCurrentProject(this.project.id);
        this.checkTemplateSync(this.project);
      }
    }
    this.renderLeft();
    this.renderStage();
  }

  // ---------- 左侧：模板 + 工程列表 ----------
  private renderLeft(): void {
    this.leftPanel.replaceChildren();

    const tplPanel = el('div', { class: 'panel stack', style: 'gap:8px' });
    tplPanel.append(el('h3', {}, '从模板新建工程'));
    for (const t of BUILTIN_TEMPLATES) {
      const row = el('div', { class: 'row' });
      row.append(
        el('span', { class: 'grow' }, `${t.name} `, ),
        el('span', { class: 'tag' }, `${t.industry} · v${t.version}`),
      );
      const btn = el('button', {}, '新建');
      btn.onclick = () => this.createFromTemplate(t.id);
      row.append(btn);
      tplPanel.append(row);
    }
    this.leftPanel.append(tplPanel);

    const projPanel = el('div', { class: 'panel stack', style: 'gap:8px' });
    projPanel.append(el('h3', {}, '工程列表'));
    for (const p of this.projects) {
      const row = el('div', { class: 'row' });
      const name = el('span', { class: 'grow' }, p.name);
      if (this.project?.id === p.id) name.classList.add('ok');
      row.append(name);
      const tpl = p.templateId ? latestTemplate(p.templateId) : null;
      if (tpl && tpl.version > p.templateVersion) {
        row.append(el('span', { class: 'tag', style: 'border-color:var(--warn);color:var(--warn)' }, `模板可更新 v${tpl.version}`));
      }
      const open = el('button', {}, '打开');
      open.onclick = () => {
        this.project = p;
        void store.setCurrentProject(p.id);
        this.checkTemplateSync(p);
        this.renderLeft();
        this.renderStage();
      };
      const delBtn = el('button', { class: 'danger' }, '删');
      delBtn.onclick = async () => {
        await del('projects', p.id);
        if (this.project?.id === p.id) { this.project = null; void store.setCurrentProject(null); }
        await this.reload();
      };
      row.append(open, delBtn);
      projPanel.append(row);
    }
    if (!this.projects.length) projPanel.append(el('div', { class: 'dim' }, '还没有工程，从上方模板新建。'));
    this.leftPanel.append(projPanel);

    // 片段分配
    if (this.project && this.selectedSlotId) {
      const slot = this.project.slots.find((s) => s.id === this.selectedSlotId)!;
      const assignPanel = el('div', { class: 'panel stack', style: 'gap:8px' });
      assignPanel.append(el('h3', {}, `为「${slot.name}」分配片段`));
      if (!this.clips.length) assignPanel.append(el('div', { class: 'dim' }, '素材库还没有片段，请先去裁剪。'));
      for (const c of this.clips) {
        const row = el('div', { class: 'row' });
        row.append(el('span', { class: 'grow' }, c.name));
        const btn = el('button', {}, slot.clipId === c.id ? '已分配 ✓' : '分配');
        btn.onclick = async () => {
          slot.clipId = c.id;
          this.fitSlotToSafeDisc(slot); // 替换占位素材后自动适配扇叶参数
          await this.saveProject();
        };
        row.append(btn);
        assignPanel.append(row);
      }
      const clear = el('button', {}, '清空该槽位');
      clear.onclick = async () => { slot.clipId = null; await this.saveProject(); };
      assignPanel.append(clear);
      this.leftPanel.append(assignPanel);
    }
  }

  /** 槽位收进扇叶安全圆（自动适配扇叶参数） */
  private fitSlotToSafeDisc(slot: Slot): void {
    if (!this.project) return;
    const cx = this.project.canvasW / 2;
    const cy = this.project.canvasH / 2;
    const safeR = Math.min(cx, cy) * SAFE_RADIUS;
    const scx = slot.x + slot.w / 2;
    const scy = slot.y + slot.h / 2;
    const dist = Math.hypot(scx - cx, scy - cy);
    const halfDiag = Math.hypot(slot.w, slot.h) / 2;
    if (dist + halfDiag > safeR) {
      const scale = Math.max(0.2, (safeR - Math.min(dist, safeR * 0.7)) / halfDiag);
      slot.w *= Math.min(1, scale);
      slot.h *= Math.min(1, scale);
      // 同时向圆心方向收回
      const maxDist = Math.max(0, safeR - Math.hypot(slot.w, slot.h) / 2);
      if (dist > maxDist && dist > 0) {
        const k = maxDist / dist;
        slot.x = cx + (scx - cx) * k - slot.w / 2;
        slot.y = cy + (scy - cy) * k - slot.h / 2;
      }
    }
  }

  private async createFromTemplate(templateId: string): Promise<void> {
    const t = latestTemplate(templateId);
    if (!t) return;
    const project: Project = {
      id: uid(),
      name: `${t.name} · ${new Date().toLocaleDateString()}`,
      templateId: t.id,
      templateVersion: t.version,
      canvasW: t.canvasW,
      canvasH: t.canvasH,
      slots: t.slots.map((s) => ({ ...s, id: uid(), clipId: null })),
      createdAt: Date.now(),
    };
    await put('projects', project);
    this.project = project;
    await store.setCurrentProject(project.id);
    await this.reload();
  }

  /** 模板版本同步检查（功能点 9） */
  private checkTemplateSync(p: Project): void {
    if (!p.templateId || this.syncPrompted.has(p.id)) return;
    const tpl = latestTemplate(p.templateId);
    if (!tpl || tpl.version <= p.templateVersion) return;
    this.syncPrompted.add(p.id);
    const history = (TEMPLATE_HISTORY[p.templateId] ?? [])
      .filter((h) => h.version > p.templateVersion)
      .map((h) => `v${h.version}：${h.note}`);
    const box = el('div', { class: 'stack' });
    box.append(
      el('h3', {}, `模板「${tpl.name}」有更新（v${p.templateVersion} → v${tpl.version}）`),
      el('p', { class: 'dim' }, history.join('；') || '布局与占位框有调整。'),
      el('p', {}, '是否同步模板改动？已分配的片段会保留，按槽位名称匹配迁移。'),
    );
    const row = el('div', { class: 'row' });
    const yes = el('button', { class: 'primary' }, '同步模板');
    const no = el('button', {}, '保持现状');
    row.append(yes, no);
    box.append(row);
    const { close } = modal(box);
    yes.onclick = async () => {
      const byName = new Map(p.slots.map((s) => [s.name, s.clipId]));
      p.canvasW = tpl.canvasW;
      p.canvasH = tpl.canvasH;
      p.slots = tpl.slots.map((s) => ({ ...s, id: uid(), clipId: byName.get(s.name) ?? null }));
      p.templateVersion = tpl.version;
      await put('projects', p);
      close();
      await this.reload();
    };
    no.onclick = () => close();
  }

  // ---------- 右侧：画布舞台 ----------
  private renderStage(): void {
    this.stageWrap.replaceChildren();
    if (!this.project) {
      this.stageWrap.append(el('p', { class: 'dim' }, '请选择或新建一个工程。'));
      return;
    }
    const p = this.project;
    const head = el('div', { class: 'row' });
    head.append(
      el('h3', { class: 'grow' }, `${p.name}（${p.canvasW}×${p.canvasH}）`),
      el('span', { class: 'dim' }, '拖拽移动 · 右下角缩放 · 点击选中后左侧分配片段'),
    );
    this.stageWrap.append(head);

    const scale = Math.min(1, 720 / p.canvasW);
    this.stage.style.width = `${p.canvasW * scale}px`;
    this.stage.style.height = `${p.canvasH * scale}px`;
    this.stage.replaceChildren();

    // 扇叶安全圆参考线
    const ring = el('div', {
      style: `position:absolute;left:50%;top:50%;width:${Math.min(p.canvasW, p.canvasH) * SAFE_RADIUS * scale}px;` +
        `height:${Math.min(p.canvasW, p.canvasH) * SAFE_RADIUS * scale}px;transform:translate(-50%,-50%);` +
        `border:1px dashed rgba(63,214,140,.5);border-radius:50%;pointer-events:none`,
    });
    this.stage.append(ring);

    for (const slot of p.slots) {
      const box = el('div', { class: `slot-box${this.selectedSlotId === slot.id ? ' selected' : ''}` });
      box.style.left = `${slot.x * scale}px`;
      box.style.top = `${slot.y * scale}px`;
      box.style.width = `${slot.w * scale}px`;
      box.style.height = `${slot.h * scale}px`;
      const clipName = slot.clipId ? this.clips.find((c) => c.id === slot.clipId)?.name : null;
      box.append(
        el('span', { class: 'slot-label' }, `${slot.name}${clipName ? ` · ${clipName}` : '（空）'}`),
        el('span', { class: 'resize-handle' }),
      );
      box.onclick = () => {
        this.selectedSlotId = slot.id;
        this.renderLeft();
        this.renderStage();
      };
      this.enableDrag(box, slot, scale);
      this.stage.append(box);
    }
    this.stageWrap.append(this.stage);
  }

  private enableDrag(box: HTMLElement, slot: Slot, scale: number): void {
    box.addEventListener('mousedown', (e) => {
      const isResize = (e.target as HTMLElement).classList.contains('resize-handle');
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      const orig = { ...slot };
      const move = (ev: MouseEvent) => {
        const dx = (ev.clientX - startX) / scale;
        const dy = (ev.clientY - startY) / scale;
        if (isResize) {
          slot.w = clamp(orig.w + dx, 40, this.project!.canvasW);
          slot.h = clamp(orig.h + dy, 40, this.project!.canvasH);
        } else {
          slot.x = clamp(orig.x + dx, 0, this.project!.canvasW - slot.w);
          slot.y = clamp(orig.y + dy, 0, this.project!.canvasH - slot.h);
        }
        box.style.left = `${slot.x * scale}px`;
        box.style.top = `${slot.y * scale}px`;
        box.style.width = `${slot.w * scale}px`;
        box.style.height = `${slot.h * scale}px`;
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        void this.saveProject(false);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  private async saveProject(rerender = true): Promise<void> {
    if (!this.project) return;
    await put('projects', this.project);
    if (rerender) { this.renderLeft(); this.renderStage(); }
  }

  destroy(): void {}
}
