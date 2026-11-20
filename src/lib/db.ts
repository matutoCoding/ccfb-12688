/**
 * IndexedDB 极简 Promise 封装。
 * 全部素材/工程/设备/模板/日志均本地存储，文件 Blob 直接入库，不上传任何服务器。
 */

const DB_NAME = 'pov-fan-studio';
const DB_VERSION = 1;

export const STORES = {
  videos: 'videos',
  clips: 'clips',
  luts: 'luts',
  projects: 'projects',
  devices: 'devices',
  templates: 'templates',
  packets: 'packets',
  kv: 'kv',
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, name === STORES.kv ? { keyPath: 'key' } : { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export interface Entity {
  id: string;
}

export async function idbPut<T extends Entity>(store: string, value: T): Promise<T> {
  await tx(store, 'readwrite', (s) => s.put(value));
  return value;
}

export async function idbGet<T>(store: string, id: string): Promise<T | undefined> {
  return tx<T | undefined>(store, 'readonly', (s) => s.get(id) as IDBRequest<T | undefined>);
}

export async function idbGetAll<T>(store: string): Promise<T[]> {
  return tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}

export async function idbDelete(store: string, id: string): Promise<void> {
  await tx(store, 'readwrite', (s) => s.delete(id));
}

export async function idbClear(store: string): Promise<void> {
  await tx(store, 'readwrite', (s) => s.clear());
}

/** kv 存取（应用设置等） */
export async function kvSet<T>(key: string, value: T): Promise<void> {
  await tx(STORES.kv, 'readwrite', (s) => s.put({ key, value }));
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const row = await tx<{ key: string; value: T } | undefined>(STORES.kv, 'readonly', (s) =>
    s.get(key) as IDBRequest<{ key: string; value: T } | undefined>,
  );
  return row?.value;
}

export async function idbEstimate(): Promise<{ usageMB: number; quotaMB: number }> {
  if (navigator.storage?.estimate) {
    const est = await navigator.storage.estimate();
    return {
      usageMB: (est.usage ?? 0) / 1048576,
      quotaMB: (est.quota ?? 0) / 1048576,
    };
  }
  return { usageMB: 0, quotaMB: 0 };
}
