/** IndexedDB 轻量封装：media / clips / devices / projects / kv 五个仓库 */

const DB_NAME = 'holofan-studio';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of ['media', 'clips', 'devices', 'projects', 'kv']) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: name === 'kv' ? 'key' : 'id' });
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll<T>(store: string): Promise<T[]> {
  const db = await openDB();
  return reqToPromise(db.transaction(store, 'readonly').objectStore(store).getAll() as IDBRequest<T[]>);
}

export async function getById<T>(store: string, id: string): Promise<T | undefined> {
  const db = await openDB();
  return reqToPromise(db.transaction(store, 'readonly').objectStore(store).get(id) as IDBRequest<T>);
}

export async function put<T>(store: string, value: T): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value as any);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function del(store: string, id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const row = await getById<{ key: string; value: T }>('kv', key);
  return row?.value;
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  await put('kv', { key, value });
}
