// 구글 캘린더 연동: "구글로 로그인"으로 받은 접근 권한으로 캘린더 API를 부른다.
// 권한은 1시간짜리다. 연결 유지 서버(server/worker.js)를 설정하면 그 서버가 대신
// 새 권한을 받아 와서 계속 연결된 채로 있고, 없으면 만료될 때 버튼 한 번으로 다시 받는다.
import { GOOGLE_CLIENT_ID } from "./config";
import { itemEnd, type Msg, type Subtask } from "./store";

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

// 일정 읽기·쓰기 + 캘린더 목록(개인·업무 같은 그룹) 읽기
const SCOPE = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const TOKEN_KEY = "gcal_token";
const LINKED_KEY = "gcal_linked";
const SESSION_KEY = "gcal_session"; // 연결 유지 서버가 준 암호화된 새로 고침 열쇠
const SERVER_KEY = "gcal_server"; // 연결 유지 서버 주소
const CACHE_KEY = "gcal_cache"; // 마지막으로 받아 온 일정 (기간별)

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
const saveToken = (token: string, expiresIn?: number) => {
  store(TOKEN_KEY, JSON.stringify({ token, exp: Date.now() + ((expiresIn ?? 3600) - 120) * 1000 }));
  calsAt = 0; // 새 권한을 받으면 캘린더 목록도 다시 받는다 (다시 연결해 그룹 권한이 생긴 경우 등)
};

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
  store(CACHE_KEY, null);
  store(CALS_KEY, null);
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
  colorId?: string; // 구글 캘린더 일정 색 번호("1"~"11"). 없으면 캘린더 기본 색
  calendarId?: string; // 이 일정이 들어 있는 구글 캘린더(그룹). 없으면 기본 캘린더
  chat?: Msg[]; // 이 일정에 대해 클론과 나눈 대화 (앱에만 저장)
  subtasks?: Subtask[]; // 이 일정 대화에서 나온 세부 업무 (앱에만 저장)
};

// 구글 캘린더 일정 색(colorId)과 구글 앱에서 보이는 이름·색
export const EVENT_COLORS: { id: string; name: string; hex: string }[] = [
  { id: "11", name: "토마토", hex: "#d50000" },
  { id: "4", name: "플라밍고", hex: "#e67c73" },
  { id: "6", name: "귤", hex: "#f4511e" },
  { id: "5", name: "바나나", hex: "#f6bf26" },
  { id: "2", name: "세이지", hex: "#33b679" },
  { id: "10", name: "바질", hex: "#0b8043" },
  { id: "7", name: "공작", hex: "#039be5" },
  { id: "9", name: "블루베리", hex: "#3f51b5" },
  { id: "1", name: "라벤더", hex: "#7986cb" },
  { id: "3", name: "포도", hex: "#8e24aa" },
  { id: "8", name: "흑연", hex: "#616161" },
];
export const colorHex = (id?: string) => EVENT_COLORS.find((c) => c.id === id)?.hex;

export async function upcoming(token: string, days = 30): Promise<CalEvent[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return range(token, today, new Date(today.getTime() + days * 86400000));
}

// 캘린더를 열 때마다 구글에서 받아 오는 동안 화면이 비어 보이지 않도록,
// 받아 온 일정을 기간별로 이 기기에 저장해 두고 먼저 보여 준다. (최근 기간 몇 개만 보관)
type CacheEntry = { from: string; to: string; at: number; events: CalEvent[] };
const CACHE_MAX = 12;
const rangeKey = (from: Date, to: Date) => `${from.toISOString()}~${to.toISOString()}`;

function readCache(): Record<string, CacheEntry> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function writeCache(from: Date, to: Date, events: CalEvent[]) {
  const all = readCache();
  all[rangeKey(from, to)] = { from: from.toISOString(), to: to.toISOString(), at: Date.now(), events };
  const keep = Object.entries(all)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, CACHE_MAX);
  store(CACHE_KEY, JSON.stringify(Object.fromEntries(keep)));
}

// 저장해 둔 일정 중 이 기간에 해당하는 것. 같은 기간이 없으면 다른 기간들에서 겹치는 날만 모아 온다.
// 이 기간 전체를 덮는 저장본이 하나도 없으면 null (빈 화면이 "일정 없음"으로 보이지 않게).
export function cached(from: Date, to: Date): CalEvent[] | null {
  const all = readCache();
  const exact = all[rangeKey(from, to)];
  if (exact) return exact.events;
  const f = localDate(from);
  const t = localDate(new Date(to.getTime() - 1));
  const entries = Object.values(all).sort((a, b) => a.at - b.at); // 최근 것이 덮어쓰게
  const covers = entries.some((e) => e.from <= from.toISOString() && e.to >= to.toISOString());
  const byId = new Map<string, CalEvent>();
  for (const e of entries) {
    const ef = localDate(new Date(e.from));
    const et = localDate(new Date(new Date(e.to).getTime() - 1));
    for (const ev of e.events) if (ev.date >= f && ev.date <= t && ev.date >= ef && ev.date <= et) byId.set(ev.id, ev);
  }
  if (!covers && byId.size === 0) return null;
  return [...byId.values()].sort((a, b) => (a.date + (a.time || "00:00")).localeCompare(b.date + (b.time || "00:00")));
}

// 이 기간을 받아 온 지 ms 안쪽이면 true
export function isFresh(from: Date, to: Date, ms: number): boolean {
  const e = readCache()[rangeKey(from, to)];
  return !!e && Date.now() - e.at < ms;
}

export function cachedUpcoming(days = 30): CalEvent[] | null {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return cached(today, new Date(today.getTime() + days * 86400000));
}

/* ---------- 캘린더 목록 (구글 캘린더의 개인·업무 같은 그룹) ---------- */
export type GCalendar = { id: string; name: string; color: string; primary: boolean; writable: boolean; shown: boolean };
const CALS_KEY = "gcal_calendars";
const evPath = (calId?: string) => `/calendars/${encodeURIComponent(calId || "primary")}/events`;

export function cachedCalendars(): GCalendar[] {
  try {
    return (JSON.parse(localStorage.getItem(CALS_KEY) ?? "null")?.list as GCalendar[]) ?? [];
  } catch {
    return [];
  }
}
// 다시 연결해야 캘린더 목록을 읽을 수 있는 상태(예전 권한으로 연결됨)
export const needsCalendarScope = () => localStorage.getItem(CALS_KEY + "_noscope") === "1";

let calsLoading: Promise<GCalendar[]> | null = null;
let calsAt = 0;
// 캘린더 목록. 10분에 한 번만 새로 받는다. 권한이 없으면 기본 캘린더만 쓴다.
export function calendars(token: string, force = false): Promise<GCalendar[]> {
  if (!force && Date.now() - calsAt < 10 * 60000) return Promise.resolve(cachedCalendars());
  calsLoading ??= (async () => {
    try {
      const data = await api(token, "/users/me/calendarList?minAccessRole=reader&maxResults=250");
      type Raw = { id: string; summary?: string; summaryOverride?: string; backgroundColor?: string; primary?: boolean; accessRole?: string; selected?: boolean; hidden?: boolean };
      const list: GCalendar[] = (data.items ?? [])
        .filter((c: Raw) => !c.hidden)
        .map((c: Raw) => ({
          id: c.id,
          name: c.primary ? "기본 캘린더" : (c.summaryOverride || c.summary || "캘린더"),
          color: c.backgroundColor ?? "#4285f4",
          primary: !!c.primary,
          writable: c.accessRole === "owner" || c.accessRole === "writer",
          // 처음엔 구글 캘린더에서 체크해 둔(보이게 한) 캘린더만 보여 준다. 앱에서 바꾼 값이 있으면 그걸 따른다.
          shown: shownPref()[c.id] ?? c.selected !== false,
        }))
        .sort((a: GCalendar, b: GCalendar) => Number(b.primary) - Number(a.primary));
      store(CALS_KEY, JSON.stringify({ list }));
      store(CALS_KEY + "_noscope", null);
      calsAt = Date.now();
      return list;
    } catch (e) {
      if (String((e as Error).message).includes("403")) {
        store(CALS_KEY + "_noscope", "1");
        calsAt = Date.now();
      }
      return cachedCalendars();
    } finally {
      calsLoading = null;
    }
  })();
  return calsLoading;
}

// 앱에서 캘린더별로 보이기/숨기기
const SHOWN_KEY = "gcal_calendars_shown";
function shownPref(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(SHOWN_KEY) ?? "{}");
  } catch {
    return {};
  }
}
export function setShown(calId: string, shown: boolean) {
  store(SHOWN_KEY, JSON.stringify({ ...shownPref(), [calId]: shown }));
  const list = cachedCalendars().map((c) => (c.id === calId ? { ...c, shown } : c));
  store(CALS_KEY, JSON.stringify({ list }));
  store(CACHE_KEY, null); // 보이는 캘린더가 바뀌었으니 저장해 둔 일정은 다시 받는다
}
export const calendarOf = (calId?: string) => {
  const list = cachedCalendars();
  return list.find((c) => c.id === calId) ?? (!calId || calId === "primary" ? list.find((c) => c.primary) : undefined);
};
// 일정을 다른 캘린더(그룹)로 옮긴다
export async function moveEvent(token: string, eventId: string, fromCal: string | undefined, toCal: string) {
  await api(token, `${evPath(fromCal)}/${eventId}/move?destination=${encodeURIComponent(toCal)}`, { method: "POST" });
}

export async function range(token: string, from: Date, to: Date): Promise<CalEvent[]> {
  const events = await fetchRange(token, from, to);
  writeCache(from, to, events);
  return events;
}

async function fetchRange(token: string, from: Date, to: Date): Promise<CalEvent[]> {
  const cals = (await calendars(token)).filter((c) => c.shown);
  const lists = await Promise.all(
    (cals.length ? cals : [{ id: "primary" } as GCalendar]).map((c) =>
      fetchCalendarRange(token, c.id, from, to).catch((e) => {
        if (c.id === "primary" || c.primary) throw e; // 기본 캘린더를 못 받으면 오류로 알린다
        return [] as CalEvent[]; // 다른 캘린더 하나가 안 되면 그 캘린더만 뺀다
      }),
    ),
  );
  // 같은 일정이 여러 캘린더에 보이면(초대받은 일정 등) 한 번만
  const seen = new Set<string>();
  return lists
    .flat()
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .sort((a, b) => (a.date + (a.time || "00:00")).localeCompare(b.date + (b.time || "00:00")));
}

async function fetchCalendarRange(token: string, calId: string, from: Date, to: Date): Promise<CalEvent[]> {
  const q = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });
  const data = await api(token, `${evPath(calId)}?${q}`);
  type Raw = { id: string; summary?: string; location?: string; description?: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string }; extendedProperties?: { private?: { plannerItemId?: string } }; colorId?: string };
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
    colorId: e.colorId,
    calendarId: calId,
  }));
}

// 종일 일정의 end.date는 "다음 날"이라 하루를 빼서 마지막 날로 바꾼다.
function prevDay(d: string) {
  const x = new Date(d + "T00:00:00");
  x.setDate(x.getDate() - 1);
  return localDate(x);
}

export type EventEdit = { title: string; due: string; time?: string; endDate?: string; endTime?: string; location: string; description: string; colorId?: string; calendarId?: string };

// 캘린더 탭에서 구글 일정을 직접 고친다 (구글 캘린더 편집 화면과 같은 항목).
export async function updateEvent(token: string, eventId: string, e: EventEdit, calId?: string) {
  const b = body({ id: "", ...e });
  const start = "date" in b.start ? { date: b.start.date, dateTime: null } : { ...b.start, date: null };
  const end = "date" in b.end ? { date: b.end.date, dateTime: null } : { ...b.end, date: null };
  await api(token, `${evPath(calId)}/${eventId}`, {
    method: "PATCH",
    // colorId를 null로 보내면 캘린더 기본 색으로 돌아간다
    body: JSON.stringify({ summary: e.title || "(제목 없음)", location: e.location, description: e.description, colorId: e.colorId ?? null, start, end }),
  });
}

type ItemLike = { id: string; title: string; due: string; time?: string; endDate?: string; endTime?: string; colorId?: string; calendarId?: string };

// 할 일 하나를 캘린더 일정 모양으로. 시간이 있으면 시작~종료, 없으면 종일 일정.
function body(it: ItemLike) {
  const base = {
    summary: it.title,
    description: "클론 앱에서 추가한 할 일",
    extendedProperties: { private: { plannerItemId: it.id } },
    // 색을 고른 적이 있을 때만 보낸다. ""(기본 색)는 null로 보내야 구글에서 색이 지워진다.
    ...(it.colorId === undefined ? {} : { colorId: it.colorId || null }),
  };
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

// 비서가 캘린더에만 넣는 일정 (할 일과 이어지지 않음)
export async function createEvent(token: string, e: EventEdit): Promise<string> {
  const calId = e.calendarId;
  const b: Partial<ReturnType<typeof body>> = { ...body({ id: "", ...e }), description: e.description };
  delete b.extendedProperties;
  delete (b as { calendarId?: string }).calendarId;
  const data = await api(token, evPath(calId), { method: "POST", body: JSON.stringify({ ...b, location: e.location }) });
  return data.id;
}

export async function createForItem(token: string, it: ItemLike): Promise<string> {
  const calId = it.calendarId;
  const data = await api(token, evPath(calId), { method: "POST", body: JSON.stringify(body(it)) });
  return data.id;
}

export async function updateForItem(token: string, eventId: string, it: ItemLike) {
  const calId = it.calendarId;
  // 종일↔시간 일정이 바뀔 수 있어 start/end를 통째로 바꾸는 PUT 대신 PATCH에 둘 다 넣는다.
  const b = body(it);
  const start = "date" in b.start ? { date: b.start.date, dateTime: null } : { ...b.start, date: null };
  const end = "date" in b.end ? { date: b.end.date, dateTime: null } : { ...b.end, date: null };
  // 설명은 처음 만들 때만 넣는다. 캘린더에서 가져온 일정이면 원래 설명(메모)을 지우지 않도록.
  const patch: Partial<typeof b> = { ...b };
  delete patch.description;
  await api(token, `${evPath(calId)}/${eventId}`, { method: "PATCH", body: JSON.stringify({ ...patch, start, end }) });
}

// 할 일에서만 뺄 때: 일정은 그대로 두고 할 일 표시만 뗀다.
export async function unlinkEvent(token: string, eventId: string, calId?: string) {
  await api(token, `${evPath(calId)}/${eventId}`, {
    method: "PATCH",
    body: JSON.stringify({ extendedProperties: { private: { plannerItemId: null } } }),
  });
}

// 캘린더에 원래 있던 일정을 할 일로 가져올 때: 새 일정을 만들지 않고 그 일정에 할 일 표시만 붙인다.
export async function linkEvent(token: string, eventId: string, itemId: string, calId?: string) {
  await api(token, `${evPath(calId)}/${eventId}`, {
    method: "PATCH",
    body: JSON.stringify({ extendedProperties: { private: { plannerItemId: itemId } } }),
  });
}

// 클론과 이야기하다 남긴 메모를 일정 설명 끝에 덧붙인다. 다른 기기에서 고친 설명을 지우지 않도록 최신 설명을 먼저 읽는다.
export async function appendDescription(token: string, eventId: string, text: string, calId?: string): Promise<string> {
  const cur = await api(token, `${evPath(calId)}/${eventId}`);
  const prev = ((cur?.description as string | undefined) ?? "").trimEnd();
  const description = prev ? `${prev}\n${text}` : text;
  await api(token, `${evPath(calId)}/${eventId}`, { method: "PATCH", body: JSON.stringify({ description }) });
  return description;
}

export async function deleteEvent(token: string, eventId: string, calId?: string) {
  try {
    await api(token, `${evPath(calId)}/${eventId}`, { method: "DELETE" });
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
