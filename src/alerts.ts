// 일정 시작 3시간 전 알림: 홈 브리핑의 '곧 시작' 줄, 빨간 점(새 알림), 앱 아이콘 배지, 휴대폰 알림.
// 앱이 열려 있으면 이 기기에서 바로 알리고, 연결 유지 서버(크론)가 있으면 앱이 닫혀 있어도 서버가 웹 푸시로 알린다.
import * as gcal from "./gcal";
import type { CalEvent } from "./gcal";
import type { Item } from "./store";

export const LEAD = 3 * 3600000;
export type Alert = { key: string; title: string; at: number; label: string; event_id?: string; item_id?: string };

const startOf = (date: string, time: string) => (date && /^\d{1,2}:\d{2}$/.test(time) ? new Date(`${date}T${time.padStart(5, "0")}`).getTime() : NaN);
export const timeLabel = (at: number) => new Date(at).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });

// 시간이 정해진 일정(종일 제외)과, 캘린더에 없는 시간 있는 할 일. 끝낸 할 일과 이어진 일정은 뺀다.
export function allAlerts(items: Item[], events: CalEvent[], now = Date.now()): Alert[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const evIds = new Set(events.map((e) => e.id));
  const out: Alert[] = [];
  for (const e of events) {
    const at = startOf(e.date, e.time);
    if (!(at > now)) continue;
    const it = (e.itemId && byId.get(e.itemId)) || items.find((i) => i.calendarEventId === e.id);
    if (it?.done) continue;
    out.push({ key: `${e.id}@${at}`, title: e.title || "일정", at, label: timeLabel(at), event_id: e.id, item_id: it?.id });
  }
  for (const i of items) {
    if (i.done || (i.calendarEventId && evIds.has(i.calendarEventId))) continue;
    const at = startOf(i.due, i.time ?? "");
    if (at > now) out.push({ key: `${i.id}@${at}`, title: i.title || "할 일", at, label: timeLabel(at), item_id: i.id });
  }
  return out.sort((a, b) => a.at - b.at);
}

// 지금 알림이 떠 있어야 하는 것 (시작 3시간 전부터 시작할 때까지)
export const activeAlerts = (items: Item[], events: CalEvent[], now = Date.now()) => allAlerts(items, events, now).filter((a) => a.at - LEAD <= now);

// 오늘이면 "오후 3:00", 아니면 "내일 오전 9:00"
export function whenLabel(a: Alert, now = Date.now()) {
  const d = new Date(a.at);
  const t = new Date(now);
  return d.toDateString() === t.toDateString() ? a.label : `내일 ${a.label}`;
}

// ---- 본 알림 / 이미 휴대폰에 띄운 알림 (이 기기) ----
function readSet(name: string): Record<string, number> {
  try {
    const all = JSON.parse(localStorage.getItem(name) ?? "{}") as Record<string, number>;
    // 지난 지 하루 넘은 일정은 정리
    return Object.fromEntries(Object.entries(all).filter(([k]) => Number(k.split("@").pop()) > Date.now() - 86400000));
  } catch {
    return {};
  }
}
function addTo(name: string, keys: string[]) {
  if (!keys.length) return;
  const s = readSet(name);
  for (const k of keys) s[k] = Date.now();
  try {
    localStorage.setItem(name, JSON.stringify(s));
  } catch {
    /* 무시 */
  }
}
export const seenKeys = () => readSet("alertSeen");
export function markSeen(keys: string[]) {
  const s = seenKeys();
  const fresh = keys.filter((k) => !s[k]);
  if (!fresh.length) return;
  addTo("alertSeen", fresh);
  window.dispatchEvent(new Event("alerts-seen"));
}

// 앱 아이콘의 빨간 숫자 (홈 화면에 추가한 아이폰 앱, 맥·윈도우 설치 앱)
export function setBadge(n: number) {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  try {
    if (n > 0) nav.setAppBadge?.(n)?.catch(() => {});
    else nav.clearAppBadge?.()?.catch(() => {});
  } catch {
    /* 지원 안 함 */
  }
}

// ---- 휴대폰 알림 ----
export const notifySupported = () => "Notification" in window && "serviceWorker" in navigator;
export const permission = () => (notifySupported() ? Notification.permission : "denied");
export const pushOn = () => localStorage.getItem("push_on") === "1";

// 앱이 열려 있을 때 이 기기에서 바로 띄운다. 서버 알림을 쓰는 중이면 서버가 보내므로 건너뛴다.
export async function notifyLocal(list: Alert[], now = Date.now()) {
  if (permission() !== "granted" || (pushOn() && gcal.serverUrl() && serverPushOk !== false)) return;
  const done = readSet("alertNotified");
  const todo = list.filter((a) => !done[a.key]);
  if (!todo.length) return;
  addTo("alertNotified", todo.map((a) => a.key));
  try {
    const reg = await navigator.serviceWorker.ready;
    for (const a of todo) await reg.showNotification(a.title, { body: `${whenLabel(a, now)} 시작 · 3시간 안에 시작해요`, tag: a.key, icon: "./icon-180.png", badge: "./icon-180.png", data: { url: "./" } });
  } catch {
    /* 무시 */
  }
}

// ---- 서버 알림 (웹 푸시) ----
function pushId() {
  let k = localStorage.getItem("push_key");
  if (!k) {
    const b = crypto.getRandomValues(new Uint8Array(18));
    k = btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    localStorage.setItem("push_key", k);
  }
  return k;
}
const fromB64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

// 서버에 목록을 올렸는지: 아직 모름(null) / 됨 / 안 됨. 안 될 때만 이 기기에서 직접 띄운다.
let serverPushOk: boolean | null = null;
let last = "";
let timer = 0;

// 알림 켜기: 허락 받기 → 서버 열쇠로 구독 → 서버에 일정 목록과 함께 올리기.
// 서버가 없거나 예전 버전이면 앱이 열려 있을 때만 알린다 ("local").
export async function enable(items: Item[], events: CalEvent[]): Promise<"push" | "local" | "denied"> {
  if (!notifySupported()) return "denied";
  const p = await Notification.requestPermission();
  if (p !== "granted") return "denied";
  localStorage.setItem("push_on", "1");
  const server = gcal.serverUrl();
  if (!server || !("PushManager" in window)) return "local";
  try {
    const r = await fetch(server + "/push/key");
    if (!r.ok) return "local";
    const { key } = (await r.json()) as { key: string };
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    // 서버 열쇠가 바뀌었으면 다시 구독한다
    const cur = sub?.options.applicationServerKey;
    if (sub && cur && btoa(String.fromCharCode(...new Uint8Array(cur))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== key) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64(key) });
    last = "";
    serverPushOk = await upload(sub, items, events);
    return serverPushOk ? "push" : "local";
  } catch {
    return "local";
  }
}

export async function disable() {
  localStorage.removeItem("push_on");
  serverPushOk = false;
  const server = gcal.serverUrl();
  try {
    const reg = await navigator.serviceWorker.ready;
    await (await reg.pushManager.getSubscription())?.unsubscribe();
    if (server) await fetch(`${server}/push/${pushId()}`, { method: "DELETE" });
  } catch {
    /* 무시 */
  }
}

export async function test() {
  const server = gcal.serverUrl();
  if (!server) return false;
  const r = await fetch(server + "/push/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: pushId() }) }).catch(() => null);
  return !!r?.ok;
}

async function upload(sub: PushSubscription, items: Item[], events: CalEvent[]) {
  const server = gcal.serverUrl();
  if (!server) return false;
  // 앞으로 14일 동안의 일정만 올린다 (제목과 시작 시각만)
  const alerts = allAlerts(items, events)
    .filter((a) => a.at < Date.now() + 14 * 86400000)
    .slice(0, 100)
    .map((a) => ({ k: a.key, t: a.title, l: a.label, at: a.at }));
  const body = JSON.stringify({ sub: sub.toJSON(), alerts });
  if (body === last) return true;
  try {
    const r = await fetch(`${server}/push/${pushId()}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body });
    if (r.ok) last = body;
    return r.ok;
  } catch {
    return false;
  }
}

// 일정이나 할 일이 바뀌면 잠깐 기다렸다가 서버 목록을 새로 올린다
export function sync(items: Item[], events: CalEvent[]) {
  if (!pushOn() || permission() !== "granted") return;
  if (!gcal.serverUrl() || !("PushManager" in window)) return void (serverPushOk = false);
  clearTimeout(timer);
  timer = window.setTimeout(async () => {
    try {
      const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      serverPushOk = !!sub && (await upload(sub, items, events));
    } catch {
      serverPushOk = false;
    }
  }, 1500);
}
