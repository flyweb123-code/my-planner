// 구글 캘린더 연동: "구글로 로그인"으로 받은 접근 권한으로 캘린더 API를 부른다.
// 권한은 1시간짜리다. 연결 유지 서버(server/worker.js)를 설정하면 그 서버가 대신
// 새 권한을 받아 와서 계속 연결된 채로 있고, 없으면 만료될 때 버튼 한 번으로 다시 받는다.
import { GOOGLE_CLIENT_ID } from "./config";
import { itemEnd } from "./store";

type TokenResponse = { access_token?: string; expires_in?: number; error?: string };
type TokenClient = { requestAccessToken: (o?: { prompt?: string }) => void };
type CodeClient = { requestCode: () => void };
declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (cfg: { client_id: string; scope: string; callback: (r: TokenResponse) => void; error_callback?: (e: { type: string }) => void }) => TokenClient;
          initCodeClient: (cfg: {
            client_id: string;
            scope: string;
            ux_mode: "popup";
            callback: (r: { code?: string; error?: string }) => void;
            error_callback?: (e: { type: string }) => void;
          }) => CodeClient;
          revoke: (token: string, done: () => void) => void;
        };
      };
    };
  }
}

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const TOKEN_KEY = "gcal_token";
const LINKED_KEY = "gcal_linked";
const SESSION_KEY = "gcal_session"; // 연결 유지 서버가 준 암호화된 새로 고침 열쇠
const SERVER_KEY = "gcal_server"; // 연결 유지 서버 주소

export function serverUrl(): string {
  try {
    return (localStorage.getItem(SERVER_KEY) ?? "").trim().replace(/\/+$/, "");
  } catch {
    return "";
  }
}
export function setServerUrl(url: string) {
  store(SERVER_KEY, url.trim() ? url.trim().replace(/\/+$/, "") : null);
}
export function hasSession(): boolean {
  try {
    return !!localStorage.getItem(SESSION_KEY) && !!serverUrl();
  } catch {
    return false;
  }
}
const saveToken = (token: string, expiresIn?: number) =>
  store(TOKEN_KEY, JSON.stringify({ token, exp: Date.now() + ((expiresIn ?? 3600) - 120) * 1000 }));

async function post(path: string, body: unknown) {
  const res = await fetch(serverUrl() + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// 서버에 맡겨 둔 열쇠로 새 1시간짜리 권한을 받는다. 동시에 여러 번 불려도 한 번만 요청한다.
let renewing: Promise<string | null> | null = null;
export function renew(): Promise<string | null> {
  const t = savedToken();
  if (t) return Promise.resolve(t);
  if (!hasSession()) return Promise.resolve(null);
  renewing ??= (async () => {
    try {
      const r = await post("/refresh", { session: localStorage.getItem(SESSION_KEY) });
      if (r.ok && r.data.access_token) {
        saveToken(r.data.access_token, r.data.expires_in);
        return r.data.access_token as string;
      }
      // 구글에서 연결을 끊었거나 열쇠가 더는 안 맞을 때: 다시 연결해야 한다
      if (r.status === 401) store(SESSION_KEY, null);
      return null;
    } catch {
      return null; // 인터넷이 잠깐 끊긴 경우 등: 다음에 다시 시도
    } finally {
      renewing = null;
    }
  })();
  return renewing;
}

// 서버를 쓸 때의 연결: 구글이 준 일회용 코드를 서버에 보내 열쇠와 권한을 받는다
async function signInWithServer(): Promise<string> {
  return new Promise((resolve, reject) => {
    const cc = window.google!.accounts.oauth2.initCodeClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      ux_mode: "popup",
      callback: async (r) => {
        if (!r.code) return reject(new Error("구글 연결이 취소됐어요."));
        try {
          const x = await post("/exchange", { code: r.code });
          if (!x.ok || !x.data.session) {
            const why =
              x.data.error === "no_refresh_token"
                ? "구글이 연결 유지 열쇠를 주지 않았어요. 구글 계정 > 보안 > 타사 연결에서 이 앱을 지운 뒤 다시 연결해 주세요."
                : x.data.error === "server_not_configured"
                  ? "연결 유지 서버에 비밀 값이 아직 안 들어가 있어요."
                  : `연결 유지 서버에서 오류가 났어요 (${x.data.error ?? x.status}).`;
            return reject(new Error(why));
          }
          store(SESSION_KEY, x.data.session);
          saveToken(x.data.access_token, x.data.expires_in);
          store(LINKED_KEY, "1");
          resolve(x.data.access_token);
        } catch {
          reject(new Error("연결 유지 서버에 접속하지 못했어요. 설정의 서버 주소를 확인해 주세요."));
        }
      },
      error_callback: (e) => reject(new Error(e.type === "popup_closed" ? "구글 로그인 창이 닫혔어요." : "구글 로그인 창을 열지 못했어요. 팝업 차단을 확인해 주세요.")),
    });
    cc.requestCode();
  });
}

export const available = () => !!GOOGLE_CLIENT_ID;

function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* 저장이 막힌 브라우저 */
  }
}

export function wasLinked(): boolean {
  try {
    return localStorage.getItem(LINKED_KEY) === "1";
  } catch {
    return false;
  }
}

export function savedToken(): string | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const { token, exp } = JSON.parse(raw);
    return Date.now() < exp ? token : null;
  } catch {
    return null;
  }
}

let scriptPromise: Promise<void> | null = null;
export function preload(): Promise<void> {
  if (window.google?.accounts) return Promise.resolve();
  scriptPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = () => resolve();
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error("구글 로그인을 불러오지 못했어요. 인터넷 연결을 확인해 주세요."));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

// 버튼을 누른 순간에 불러야 팝업이 막히지 않는다. 미리 preload()를 해 두면 좋다.
export async function signIn(): Promise<string> {
  if (!GOOGLE_CLIENT_ID) throw new Error("아직 구글 로그인 준비가 안 됐어요.");
  await preload();
  if (serverUrl()) return signInWithServer();
  return new Promise((resolve, reject) => {
    const tc = window.google!.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: (r) => {
        if (!r.access_token) return reject(new Error("구글 연결이 취소됐어요."));
        saveToken(r.access_token, r.expires_in);
        store(LINKED_KEY, "1");
        resolve(r.access_token);
      },
      error_callback: (e) => reject(new Error(e.type === "popup_closed" ? "구글 로그인 창이 닫혔어요." : "구글 로그인 창을 열지 못했어요. 팝업 차단을 확인해 주세요.")),
    });
    tc.requestAccessToken({ prompt: wasLinked() ? "" : "consent" });
  });
}

export function signOut() {
  const t = savedToken();
  if (t && window.google) window.google.accounts.oauth2.revoke(t, () => {});
  store(TOKEN_KEY, null);
  store(LINKED_KEY, null);
  store(SESSION_KEY, null);
}

async function api(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (res.status === 401) {
    store(TOKEN_KEY, null);
    throw new Error("구글 연결이 만료됐어요. 다시 연결해 주세요.");
  }
  if (!res.ok) throw new Error(`캘린더 요청 실패 (${res.status})`);
  return res.status === 204 ? null : res.json();
}

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const localDate = (d: Date) => d.toLocaleDateString("sv-SE");

export type CalEvent = {
  id: string;
  title: string;
  date: string; // 시작 날짜 YYYY-MM-DD (이 기기 시간 기준)
  time: string; // "15:00" 또는 종일이면 ""
  endTime: string;
  endDate: string; // 끝나는 날 (종일 일정도 마지막 날 기준)
  location: string;
  description: string;
  itemId?: string; // 이 앱의 할 일에서 만든 일정이면 그 할 일 id
};

export async function upcoming(token: string, days = 30): Promise<CalEvent[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return range(token, today, new Date(today.getTime() + days * 86400000));
}

export async function range(token: string, from: Date, to: Date): Promise<CalEvent[]> {
  const q = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });
  const data = await api(token, `/calendars/primary/events?${q}`);
  type Raw = { id: string; summary?: string; location?: string; description?: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string }; extendedProperties?: { private?: { plannerItemId?: string } } };
  const hm = (iso: string) => new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  return (data.items ?? []).map((e: Raw) => ({
    id: e.id,
    title: e.summary ?? "(제목 없음)",
    date: e.start.dateTime ? localDate(new Date(e.start.dateTime)) : e.start.date!,
    time: e.start.dateTime ? hm(e.start.dateTime) : "",
    endTime: e.end.dateTime ? hm(e.end.dateTime) : "",
    endDate: e.end.dateTime ? localDate(new Date(e.end.dateTime)) : prevDay(e.end.date!),
    location: e.location ?? "",
    description: e.description ?? "",
    itemId: e.extendedProperties?.private?.plannerItemId,
  }));
}

// 종일 일정의 end.date는 "다음 날"이라 하루를 빼서 마지막 날로 바꾼다.
function prevDay(d: string) {
  const x = new Date(d + "T00:00:00");
  x.setDate(x.getDate() - 1);
  return localDate(x);
}

export type EventEdit = { title: string; due: string; time?: string; endDate?: string; endTime?: string; location: string; description: string };

// 캘린더 탭에서 구글 일정을 직접 고친다 (구글 캘린더 편집 화면과 같은 항목).
export async function updateEvent(token: string, eventId: string, e: EventEdit) {
  const b = body({ id: "", ...e });
  const start = "date" in b.start ? { date: b.start.date, dateTime: null } : { ...b.start, date: null };
  const end = "date" in b.end ? { date: b.end.date, dateTime: null } : { ...b.end, date: null };
  await api(token, `/calendars/primary/events/${eventId}`, {
    method: "PATCH",
    body: JSON.stringify({ summary: e.title || "(제목 없음)", location: e.location, description: e.description, start, end }),
  });
}

type ItemLike = { id: string; title: string; due: string; time?: string; endDate?: string; endTime?: string };

// 할 일 하나를 캘린더 일정 모양으로. 시간이 있으면 시작~종료, 없으면 종일 일정.
function body(it: ItemLike) {
  const base = { summary: it.title, description: "클론 앱에서 추가한 할 일", extendedProperties: { private: { plannerItemId: it.id } } };
  const e = itemEnd(it);
  if (it.time) {
    const start = new Date(`${it.due}T${it.time}:00`);
    const end = new Date(`${e.date}T${e.time}:00`);
    return { ...base, start: { dateTime: start.toISOString(), timeZone: tz() }, end: { dateTime: end.toISOString(), timeZone: tz() } };
  }
  const next = new Date(e.date + "T00:00:00");
  next.setDate(next.getDate() + 1);
  return { ...base, start: { date: it.due }, end: { date: localDate(next) } };
}

export async function createForItem(token: string, it: ItemLike): Promise<string> {
  const data = await api(token, "/calendars/primary/events", { method: "POST", body: JSON.stringify(body(it)) });
  return data.id;
}

export async function updateForItem(token: string, eventId: string, it: ItemLike) {
  // 종일↔시간 일정이 바뀔 수 있어 start/end를 통째로 바꾸는 PUT 대신 PATCH에 둘 다 넣는다.
  const b = body(it);
  const start = "date" in b.start ? { date: b.start.date, dateTime: null } : { ...b.start, date: null };
  const end = "date" in b.end ? { date: b.end.date, dateTime: null } : { ...b.end, date: null };
  await api(token, `/calendars/primary/events/${eventId}`, { method: "PATCH", body: JSON.stringify({ ...b, start, end }) });
}

export async function deleteEvent(token: string, eventId: string) {
  try {
    await api(token, `/calendars/primary/events/${eventId}`, { method: "DELETE" });
  } catch (e) {
    // 이미 캘린더에서 지운 일정이면 그냥 넘어간다.
    if (!String((e as Error).message).includes("410") && !String((e as Error).message).includes("404")) throw e;
  }
}

// 연결 없이도 쓸 수 있는 방법: 구글 캘린더의 "일정 추가" 화면을 내용이 채워진 채로 연다.
export function addLink(title: string, date: string): string {
  const d = date.replaceAll("-", "");
  const next = new Date(date + "T00:00:00");
  next.setDate(next.getDate() + 1);
  const e = next.toLocaleDateString("sv-SE").replaceAll("-", "");
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${d}/${e}`;
}
