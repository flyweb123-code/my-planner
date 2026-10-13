// 할 일 자동 백업. 할 일 목록이 바뀔 때마다 이 기기 IndexedDB에 사본을 남겨 두고,
// 목록이 갑자기 줄거나 사라져도 설정 → 데이터 백업에서 빠진 할 일을 되살릴 수 있게 한다.
import type { Item } from "./store";

export type Snapshot = { at: number; items: Item[] };

const DB = "planner-backup";
const STORE = "snapshots";
const KEEP = 60;
const EVERY = 10 * 60 * 1000; // 목록이 줄지 않았으면 10분에 한 번만 남긴다

let dbp: Promise<IDBDatabase> | null = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "at" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbp = null;
      reject(req.error);
    };
  });
  return dbp;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = t.onabort = () => reject(t.error);
      }),
  );
}

export async function list(): Promise<Snapshot[]> {
  const all = (await run<Snapshot[]>("readonly", (s) => s.getAll())) ?? [];
  return all.sort((a, b) => b.at - a.at);
}

let last: { at: number; ids: string; json: string } | null = null;

// 목록이 바뀌면 부른다. 할 일이 하나라도 빠지면 바로, 아니면 10분에 한 번 사본을 남긴다.
export async function save(items: Item[], force = false) {
  try {
    const json = JSON.stringify(items);
    if (last?.json === json) return;
    if (!last) {
      const prev = (await list())[0];
      if (prev) last = { at: prev.at, ids: prev.items.map((i) => i.id).join(","), json: JSON.stringify(prev.items) };
      if (last?.json === json) return;
    }
    const ids = new Set(items.map((i) => i.id));
    const lost = !!last && last.ids.split(",").some((id) => id && !ids.has(id));
    if (!force && !lost && last && Date.now() - last.at < EVERY) return;
    if (items.length === 0 && !last) return;
    const snap: Snapshot = { at: Date.now(), items };
    await run("readwrite", (s) => s.put(snap));
    last = { at: snap.at, ids: items.map((i) => i.id).join(","), json };
    const all = await list();
    if (all.length > KEEP) await run("readwrite", (s) => void all.slice(KEEP).forEach((x) => s.delete(x.at)));
  } catch {
    /* 백업을 못 남겨도 앱은 그대로 쓴다 */
  }
}

// 지금 목록에 없는 할 일 중, 사본들에 남아 있는 것 (각 할 일의 가장 최근 모습)
export async function missing(current: Item[]): Promise<(Item & { seenAt: number })[]> {
  const have = new Set(current.map((i) => i.id));
  const found = new Map<string, Item & { seenAt: number }>();
  for (const s of await list()) for (const it of s.items) if (!have.has(it.id) && !found.has(it.id)) found.set(it.id, { ...it, seenAt: s.at });
  return [...found.values()].sort((a, b) => b.seenAt - a.seenAt);
}
