// IndexedDB 封装：全部素材 Blob、工程、设备档案均落本地，无任何网络上传
import type { ID } from './types';

const DB_NAME = 'holofan-studio';
const DB_VERSION = 1;

export const STORES = [
  'assets',
  'clips',
  'luts',
  'projects',
  'devices',
  'pwmCalibs',
  'wallLayouts',
  'playLogs',
  'meta',
] as const;

export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: 'id' });
          if (name === 'assets') {
            store.createIndex('rating', 'rating', { unique: false });
            store.createIndex('createdAt', 'createdAt', { unique: false });
          }
          if (name === 'devices') store.createIndex('group', 'group', { unique: false });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const idb = {
  async put<T extends { id: ID }>(store: StoreName, value: T): Promise<T> {
    await tx(store, 'readwrite', (s) => s.put(value));
    return value;
  },

  async bulkPut<T extends { id: ID }>(store: StoreName, values: T[]): Promise<void> {
    if (values.length === 0) return;
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(store, 'readwrite');
      const s = t.objectStore(store);
      for (const v of values) s.put(v);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },

  get<T>(store: StoreName, id: ID): Promise<T | undefined> {
    return tx(store, 'readonly', (s) => s.get(id) as IDBRequest<T | undefined>);
  },

  getAll<T>(store: StoreName): Promise<T[]> {
    return tx(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  },

  async delete(store: StoreName, id: ID): Promise<void> {
    await tx(store, 'readwrite', (s) => s.delete(id));
  },

  async clear(store: StoreName): Promise<void> {
    await tx(store, 'readwrite', (s) => s.clear());
  },

  async putMeta<T>(key: string, value: T): Promise<void> {
    await tx('meta', 'readwrite', (s) => s.put({ id: key, value }));
  },

  async getMeta<T>(key: string): Promise<T | undefined> {
    const row = await tx('meta', 'readonly', (s) => s.get(key) as IDBRequest<{ value: T } | undefined>);
    return row?.value;
  },
};
