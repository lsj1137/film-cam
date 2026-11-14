// 앱 안 앨범: 찍은 사진을 폰 안(IndexedDB)에 보관한다. 서버로는 보내지 않는다.
// 기록 하나: { id, date, meta, film(강도 100% 필름 사진), original, strength, thumb }

const DB_NAME = 'filmcam';
const STORE = 'shots';
const LIMIT = 60; // 이보다 많아지면 오래된 것부터 지운다

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function addShot(record) {
  await run('readwrite', (s) => s.put(record));
  const keys = await run('readonly', (s) => s.getAllKeys());
  const old = keys.sort((a, b) => a - b).slice(0, Math.max(0, keys.length - LIMIT));
  if (old.length) await run('readwrite', (s) => old.forEach((k) => s.delete(k)));
}

export async function updateShot(id, patch) {
  const rec = await getShot(id);
  if (rec) await run('readwrite', (s) => s.put({ ...rec, ...patch }));
}

export const getShot = (id) => run('readonly', (s) => s.get(id));
export const deleteShot = (id) => run('readwrite', (s) => s.delete(id));

// 최신순
export async function listShots() {
  const all = await run('readonly', (s) => s.getAll());
  return all.sort((a, b) => b.id - a.id);
}
