// 일정별 첨부 파일. 이 기기 브라우저의 IndexedDB에만 저장된다(기기 간 동기화 없음).
export type Attachment = { id: string; owner: string; name: string; type: string; size: number; added: number; blob: Blob };

const DB = "planner-files";
const STORE = "files";

let dbp: Promise<IDBDatabase> | null = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, { keyPath: "id" });
      s.createIndex("owner", "owner");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbp = null;
      reject(new Error("이 브라우저에서는 파일을 저장할 수 없어요."));
    };
  });
  return dbp;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = () => reject(t.error ?? new Error("파일 저장소 오류"));
        t.onabort = () => reject(t.error ?? new Error("저장 공간이 부족할 수 있어요."));
      }),
  );
}

export async function list(owner: string): Promise<Attachment[]> {
  const all = await tx<Attachment[]>("readonly", (s) => s.index("owner").getAll(owner));
  return (all ?? []).sort((a, b) => a.added - b.added);
}

export async function add(owner: string, file: File): Promise<void> {
  const a: Attachment = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    owner,
    name: file.name,
    type: file.type,
    size: file.size,
    added: Date.now(),
    // File 그대로 넣으면 일부 사파리에서 다시 읽지 못하는 경우가 있어 Blob으로 바꿔 둔다
    blob: new Blob([await file.arrayBuffer()], { type: file.type }),
  };
  await tx("readwrite", (s) => s.put(a));
}

export async function remove(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
}

export async function removeOwner(owner: string): Promise<void> {
  const all = await list(owner);
  await Promise.all(all.map((a) => remove(a.id)));
}

export function sizeLabel(n: number) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
