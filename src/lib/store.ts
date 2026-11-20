/**
 * 全局响应式仓库：订阅/发布 + 实体集合缓存。
 * 页面通过 useStore 订阅，数据变更后统一落 IndexedDB。
 */
import { idbGetAll, idbPut, idbDelete, STORES } from './db';
import type {
  Clip,
  DeviceProfile,
  Project,
  ProjectTemplate,
  VideoSource,
  LutData,
} from '../types';

type Listener = () => void;

class Store {
  videos: VideoSource[] = [];
  clips: Clip[] = [];
  luts: LutData[] = [];
  projects: Project[] = [];
  devices: DeviceProfile[] = [];
  templates: ProjectTemplate[] = [];
  currentProjectId: string | null = null;
  currentDeviceId: string | null = null;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  async loadAll(): Promise<void> {
    [this.videos, this.clips, this.luts, this.projects, this.devices, this.templates] =
      await Promise.all([
        idbGetAll<VideoSource>(STORES.videos),
        idbGetAll<Clip>(STORES.clips),
        idbGetAll<LutData>(STORES.luts),
        idbGetAll<Project>(STORES.projects),
        idbGetAll<DeviceProfile>(STORES.devices),
        idbGetAll<ProjectTemplate>(STORES.templates),
      ]);
    this.videos.sort((a, b) => b.createdAt - a.createdAt);
    this.clips.sort((a, b) => b.createdAt - a.createdAt);
    this.emit();
  }

  // ---- 通用持久化 ----
  async save(key: 'videos' | 'clips' | 'luts' | 'projects' | 'devices' | 'templates', entity: object): Promise<void> {
    const withId = entity as { id: string };
    const mapping: Record<string, string> = {
      videos: STORES.videos,
      clips: STORES.clips,
      luts: STORES.luts,
      projects: STORES.projects,
      devices: STORES.devices,
      templates: STORES.templates,
    };
    await idbPut(mapping[key], withId);
    await this.loadAll();
  }

  async remove(key: 'videos' | 'clips' | 'projects' | 'devices' | 'templates' | 'luts', id: string): Promise<void> {
    const mapping = {
      videos: STORES.videos,
      clips: STORES.clips,
      projects: STORES.projects,
      devices: STORES.devices,
      templates: STORES.templates,
      luts: STORES.luts,
    } as const;
    await idbDelete(mapping[key], id);
    await this.loadAll();
  }

  get currentProject(): Project | null {
    return this.projects.find((p) => p.id === this.currentProjectId) ?? null;
  }

  get currentDevice(): DeviceProfile | null {
    return this.devices.find((d) => d.id === this.currentDeviceId) ?? null;
  }

  videoById(id: string): VideoSource | undefined {
    return this.videos.find((v) => v.id === id);
  }

  clipById(id: string): Clip | undefined {
    return this.clips.find((c) => c.id === id);
  }
}

export const store = new Store();
