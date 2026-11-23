// 全局预览引擎单例：预览台、导出安全扫描、风扇墙共用同一 GL 上下文
import { PreviewEngine } from './PreviewEngine';
import { store } from '../core/store';
import type { Asset, Clip, LUTFile } from '../core/types';

let engine: PreviewEngine | null = null;
const listeners = new Set<(e: PreviewEngine) => void>();

export function getEngine(): PreviewEngine | null {
  return engine;
}

export async function ensureEngine(canvas: HTMLCanvasElement): Promise<PreviewEngine> {
  if (engine) return engine;
  engine = new PreviewEngine(canvas, store.state.preview.resolution, {
    onPlayLog: (entry) => {
      void store.persistPlayLog({
        deviceSerial: currentSerial(),
        ...entry,
      });
    },
  });
  engine.assetResolver = (assetId: string) => store.state.assets.find((a) => a.id === assetId) ?? null;
  engine.lutResolver = (id: string) => store.state.luts.find((l) => l.id === id) ?? null;
  engine.setMaterialBindings(store.state.materialBindings);
  wireEngine(engine);
  listeners.forEach((fn) => fn(engine!));
  return engine;
}

function currentSerial(): string {
  return store.state.devices[0]?.serial ?? 'SIM-0001';
}

function wireEngine(e: PreviewEngine): void {
  const p = store.state.preview;
  e.setRpm(p.rpm);
  e.setDirection(p.direction);
  e.setPersistenceMs(p.persistenceMs);
  e.setCalibEnabled(p.calibEnabled);
  e.setSplitCompare(p.splitCompare);
  e.setAmbientAuto(p.ambientAuto);
  e.setShowSafety(p.showSafety);
  const dev = store.state.devices[0] ?? null;
  const calib = dev?.pwmCalibId ? store.state.pwmCalibs.find((c) => c.id === dev.pwmCalibId) ?? null : null;
  e.setDevice(dev, calib);
  const wall = p.wallId ? store.state.wallLayouts.find((w) => w.id === p.wallId) ?? null : null;
  e.setWall(wall);
}

export function refreshEngineContext(): void {
  if (engine) wireEngine(engine);
}

export function onEngineReady(fn: (e: PreviewEngine) => void): void {
  listeners.add(fn);
  if (engine) fn(engine);
}

export function destroyEngine(): void {
  engine?.dispose();
  engine = null;
}

export function activeClips(): Clip[] {
  return store.state.clips;
}

export function activeLut(id: string | null): LUTFile | null {
  return id ? store.state.luts.find((l) => l.id === id) ?? null : null;
}

export function findAsset(id: string): Asset | undefined {
  return store.state.assets.find((a) => a.id === id);
}
