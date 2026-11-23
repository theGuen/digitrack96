/** Autosave of the current project (.smp blob) in IndexedDB. */
const DB = 'samplitude-retro'; // old name kept so existing browser autosaves survive the rename
const STORE = 'autosave';
const KEY = 'current';

export interface Autosave {
  name: string;
  savedAt: number;
  blob: Blob;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const putAutosave = (a: Autosave) => run('readwrite', (s) => s.put(a, KEY));
export const getAutosave = () => run<Autosave | undefined>('readonly', (s) => s.get(KEY));

/** Ask the browser not to evict our storage. Returns whether it is (now) persistent. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    return (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch {
    return false;
  }
}
