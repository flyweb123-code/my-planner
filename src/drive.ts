// 클론과 나눈 대화를 구글 드라이브의 "클론 대화 기록" 문서 하나에 통째로 저장한다.
// 앱이 만든 파일만 건드리는 drive.file 권한을 쓴다. 클로드가 드라이브 연결로 이 문서를 읽는다.
import type { HomeThread, Item, Msg } from "./store";

const FILE_KEY = "drive_chat_file";
const HASH_KEY = "drive_chat_hash";
const AT_KEY = "drive_chat_at";
const NOSCOPE_KEY = "drive_noscope";
const DOC_NAME = "클론 대화 기록";
const MAX = 800_000;

function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* 저장소가 꽉 찼으면 다음에 다시 */
  }
}

export const fileId = () => localStorage.getItem(FILE_KEY);
export const docUrl = () => (fileId() ? `https://docs.google.com/document/d/${fileId()}/edit` : "");
export const lastSaved = () => Number(localStorage.getItem(AT_KEY) ?? 0) || 0;
// 예전 권한으로 연결돼 있어서 드라이브에 쓸 수 없는 상태
export const needsDriveScope = () => localStorage.getItem(NOSCOPE_KEY) === "1";
// 구글 클라우드 프로젝트에서 드라이브 API가 꺼져 있어서 저장이 막힌 상태
export const driveApiOff = () => localStorage.getItem(NOSCOPE_KEY) === "api";
export const enableUrl = (clientId: string) =>
  `https://console.cloud.google.com/apis/library/drive.googleapis.com?project=${clientId.split("-")[0]}`;

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function lines(msgs: Msg[]): string[] {
  return msgs.map((m) => {
    const who = m.role === "user" ? "나" : "클론";
    const pics = m.images?.length ? ` [사진 ${m.images.length}장]` : "";
    const acts = m.actions?.length ? `\n    (한 일: ${m.actions.map((a) => a.text + (a.undone ? " - 되돌림" : "")).join(" / ")})` : "";
    return `[${stamp(m.ts)}] ${who}: ${m.text.trim()}${pics}${acts}`;
  });
}

// 문서에 들어갈 글. 최근 대화가 위로 온다.
export function buildText(threads: HomeThread[], items: Item[], eventChats: Record<string, Item>): string {
  type Block = { at: number; text: string };
  const blocks: Block[] = [];
  const last = (msgs: Msg[]) => msgs[msgs.length - 1]?.ts ?? 0;
  for (const t of threads) {
    if (!t.msgs.length) continue;
    blocks.push({ at: last(t.msgs), text: `## 홈 채팅: ${t.title || "대화"}\n${lines(t.msgs).join("\n")}` });
  }
  const itemBlocks = (it: Item, kind: string) => {
    if (it.chat.length) blocks.push({ at: last(it.chat), text: `## ${kind}: ${it.title}\n${lines(it.chat).join("\n")}` });
    for (const s of it.subtasks)
      if (s.chat?.length) blocks.push({ at: last(s.chat), text: `## ${kind} 세부 업무: ${it.title} > ${s.title}\n${lines(s.chat).join("\n")}` });
  };
  for (const it of items) itemBlocks(it, "할 일");
  for (const it of Object.values(eventChats)) itemBlocks(it, "일정");
  blocks.sort((a, b) => b.at - a.at);
  const head = `클론 대화 기록\n클론 앱이 자동으로 저장하는 문서예요. 직접 고치면 다음 저장 때 덮어써져요.\n대화 ${blocks.length}개\n\n`;
  let body = "";
  for (const b of blocks) {
    if (head.length + body.length + b.text.length > MAX) break;
    body += b.text + "\n\n";
  }
  return head + body;
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

async function create(token: string, text: string): Promise<string> {
  const boundary = "clone" + Date.now();
  const meta = { name: DOC_NAME, mimeType: "application/vnd.google-apps.document" };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`;
  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw await fail(res);
  return (await res.json()).id as string;
}

async function update(token: string, id: string, text: string) {
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain; charset=UTF-8" },
    body: text,
  });
  if (!res.ok) throw await fail(res);
}

// 403이 권한 부족인지, 드라이브 API가 꺼진 건지 구분한다
async function fail(res: Response) {
  const body = await res.text().catch(() => "");
  const off = /accessNotConfigured|SERVICE_DISABLED|has not been used in project|is disabled/i.test(body);
  return Object.assign(new Error("drive " + res.status), { status: res.status, off });
}

let saving = false;
// 바뀐 게 있을 때만 올린다. 성공하면 true.
export async function save(token: string, text: string, force = false): Promise<boolean> {
  const h = hash(text.replace(/^대화 \d+개$/m, ""));
  if (saving || (!force && h === localStorage.getItem(HASH_KEY) && fileId())) return false;
  saving = true;
  try {
    const id = fileId();
    try {
      if (id) await update(token, id, text);
      else store(FILE_KEY, await create(token, text));
    } catch (e) {
      // 문서를 휴지통에 버렸거나 지웠으면 새로 만든다
      if (id && (e as { status?: number }).status === 404) store(FILE_KEY, await create(token, text));
      else throw e;
    }
    store(HASH_KEY, h);
    store(AT_KEY, String(Date.now()));
    store(NOSCOPE_KEY, null);
    window.dispatchEvent(new Event("drive-saved"));
    return true;
  } catch (e) {
    const s = (e as { status?: number }).status;
    if (s === 403) {
      store(NOSCOPE_KEY, (e as { off?: boolean }).off ? "api" : "1");
      window.dispatchEvent(new Event("drive-saved"));
    }
    return false;
  } finally {
    saving = false;
  }
}
