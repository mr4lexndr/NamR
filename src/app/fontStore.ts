/**
 * Keeps an uploaded font in the browser so it survives a reload.
 *
 * IndexedDB rather than localStorage because a TTF is hundreds of kilobytes
 * of binary and localStorage holds strings in a ~5MB budget. Nothing is
 * transmitted; this is the same machine, the same browser profile.
 */
const DB = 'namr';
const STORE = 'font';
const KEY = 'current';

interface StoredFont {
  name: string;
  data: ArrayBuffer;
}

const open = (): Promise<IDBDatabase | null> =>
  new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB, 1);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    // Private windows and blocked storage both land here; the app just runs
    // without a remembered font.
    req.onerror = () => resolve(null);
  });

export const saveFont = async (name: string, data: ArrayBuffer): Promise<void> => {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ name, data } satisfies StoredFont, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
};

export const loadStoredFont = async (): Promise<StoredFont | null> => {
  const db = await open();
  if (!db) return null;
  const out = await new Promise<StoredFont | null>((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve((req.result as StoredFont | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
  db.close();
  return out;
};

export const clearStoredFont = async (): Promise<void> => {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
};
