// 极简响应式仓库：状态变更后持久化到 IndexedDB，UI 通过 subscribe 重渲染
import { idb } from './db';
import {
  DEFAULT_PREVIEW,
  type AppState,
  type Asset,
  type Clip,
  type Device,
  type ID,
  type LUTFile,
  type PlayLogEntry,
  type PreviewSettings,
  type Project,
  type PwmCalib,
  type WallLayout,
} from './types';
import { uid } from './id';

const STATE_KEY = 'app-state-v1';

const EMPTY_STATE: AppState = {
  assets: [],
  clips: [],
  luts: [],
  projects: [],
  currentProjectId: null,
  devices: [],
  pwmCalibs: [],
  wallLayouts: [],
  materialBindings: [],
  preview: { ...DEFAULT_PREVIEW },
};

class Store {
  state: AppState = structuredClone(EMPTY_STATE);
  private listeners = new Set<() => void>();
  private saveTimer: number | null = null;
  private loaded = false;

  /** 启动时从 IndexedDB 装载（素材 Blob / LUT 浮点数组等大对象留在各自 store） */
  async load(): Promise<void> {
    if (this.loaded) return;
    const [assets, clips, luts, projects, devices, pwmCalibs, wallLayouts, playLogs, saved] = await Promise.all([
      idb.getAll<Asset>('assets'),
      idb.getAll<Clip>('clips'),
      idb.getAll<LUTFile>('luts'),
      idb.getAll<Project>('projects'),
      idb.getAll<Device>('devices'),
      idb.getAll<PwmCalib>('pwmCalibs'),
      idb.getAll<WallLayout>('wallLayouts'),
      idb.getAll<PlayLogEntry & { id: ID }>('playLogs'),
      idb.getMeta<Omit<AppState, 'assets' | 'clips' | 'luts' | 'projects' | 'devices' | 'pwmCalibs' | 'wallLayouts'>>(STATE_KEY),
    ]);
    this.state = {
      ...structuredClone(EMPTY_STATE),
      ...saved,
      assets,
      clips,
      luts,
      projects,
      devices,
      pwmCalibs,
      wallLayouts,
      preview: { ...DEFAULT_PREVIEW, ...(saved?.preview ?? {}) },
    };
    (this.state as AppState & { playLogs?: unknown }).playLogs = playLogs;
    this.loaded = true;
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 合并补丁并调度持久化（防抖，避免滑杆拖动时狂写 IDB） */
  update(patch: Partial<AppState>): void {
    Object.assign(this.state, patch);
    this.emit();
    this.scheduleSave();
  }

  patchPreview(patch: Partial<PreviewSettings>): void {
    this.state.preview = { ...this.state.preview, ...patch };
    this.emit();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.persist(), 400);
  }

  /** 轻量元数据进 meta；大对象各自有独立 store，由调用方显式 idb.put */
  private async persist(): Promise<void> {
    const { assets: _a, clips: _c, luts: _l, projects: _p, devices: _d, pwmCalibs: _w, wallLayouts: _wl, ...meta } = this.state;
    await idb.putMeta(STATE_KEY, meta);
  }

  async persistEntity(kind: keyof Pick<AppState, 'assets' | 'clips' | 'luts' | 'projects' | 'devices' | 'pwmCalibs' | 'wallLayouts'>, entity: { id: ID }): Promise<void> {
    await idb.put(kind, entity as never);
  }

  async persistPlayLog(entry: PlayLogEntry): Promise<void> {
    const row = { id: uid('plog'), ...entry };
    await idb.put('playLogs', row);
  }

  async getAllPlayLogs(): Promise<(PlayLogEntry & { id: ID })[]> {
    return idb.getAll<PlayLogEntry & { id: ID }>('playLogs');
  }

  async clearPlayLogs(): Promise<void> {
    await idb.clear('playLogs');
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export const store = new Store();
