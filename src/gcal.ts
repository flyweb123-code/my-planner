// 구글 캘린더 연동: "구글로 로그인"으로 받은 접근 권한으로 캘린더 API를 부른다.
// 서버가 없는 앱이라 권한은 1시간마다 만료되고, 그때 버튼 한 번으로 다시 받는다.
import { GOOGLE_CLIENT_ID } from "./config";

export type CalEvent = { id: string; title: string; start: string; end: string };

type TokenResponse = { access_token?: string; expires_in?: number; error?: string };
type TokenClient = { requestAccessToken: (o?: { prompt?: string }) => void };
declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (cfg: { client_id: string; scope: string; callback: (r: TokenResponse) => void; error_callback?: (e: { type: string }) => void }) => TokenClient;
          revoke: (token: string, done: () => void) => void;
        };
      };
    };
  }
}

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const TOKEN_KEY = "gcal_token";
const LINKED_KEY = "gcal_linked";

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
  return new Promise((resolve, reject) => {
    const tc = window.google!.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: (r) => {
        if (!r.access_token) return reject(new Error("구글 연결이 취소됐어요."));
        store(TOKEN_KEY, JSON.stringify({ token: r.access_token, exp: Date.now() + ((r.expires_in ?? 3600) - 60) * 1000 }));
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

const fmt = (v: { dateTime?: string; date?: string }) =>
  v.dateTime
    ? new Date(v.dateTime).toLocaleString("ko-KR", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" })
    : `${v.date} (종일)`;

export async function upcoming(token: string, days = 7): Promise<CalEvent[]> {
  const now = new Date();
  const q = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + days * 86400000).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
  });
  const data = await api(token, `/calendars/primary/events?${q}`);
  return (data.items ?? []).map((e: { id: string; summary?: string; start: object; end: object }) => ({
    id: e.id,
    title: e.summary ?? "(제목 없음)",
    start: fmt(e.start),
    end: fmt(e.end),
  }));
}

// date: 종일 일정(YYYY-MM-DD). start/end: 시간 있는 일정(ISO 문자열).
export async function addEvent(token: string, ev: { title: string; date?: string; start?: string; end?: string }): Promise<string> {
  let body;
  if (ev.start) {
    const end = ev.end || new Date(new Date(ev.start).getTime() + 3600000).toISOString();
    body = { summary: ev.title, start: { dateTime: ev.start }, end: { dateTime: end } };
  } else if (ev.date) {
    const next = new Date(ev.date + "T00:00:00");
    next.setDate(next.getDate() + 1);
    body = { summary: ev.title, start: { date: ev.date }, end: { date: next.toLocaleDateString("sv-SE") } };
  } else throw new Error("날짜가 없어요.");
  const data = await api(token, "/calendars/primary/events", { method: "POST", body: JSON.stringify(body) });
  return data.id;
}

// 연결 없이도 쓸 수 있는 방법: 구글 캘린더의 "일정 추가" 화면을 내용이 채워진 채로 연다.
export function addLink(title: string, date: string): string {
  const d = date.replaceAll("-", "");
  const next = new Date(date + "T00:00:00");
  next.setDate(next.getDate() + 1);
  const e = next.toLocaleDateString("sv-SE").replaceAll("-", "");
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${d}/${e}`;
}
