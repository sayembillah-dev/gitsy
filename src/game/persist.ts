// Command-log persistence (section 1 invariant: persist the command log,
// never repo bytes). One IndexedDB record per level: string[] of typed
// commands, plus `patch-answer:` entries so Phase 6 undo can replay
// interactive sessions deterministically.

const DB_NAME = 'gitsy';
const STORE = 'logs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadLog(levelId: string): Promise<string[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(levelId);
      req.onsuccess = () => resolve((req.result as string[] | undefined) ?? []);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

export async function appendLog(levelId: string, entry: string): Promise<void> {
  try {
    const entries = await loadLog(levelId);
    entries.push(entry);
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(entries, levelId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // persistence is best-effort; the in-memory log is authoritative mid-session
  }
}

export async function clearLog(levelId: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(levelId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // best-effort
  }
}
