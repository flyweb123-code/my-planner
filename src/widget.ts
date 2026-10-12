// 아이폰 잠금 화면 위젯(Scriptable)용 고정 목록 동기화.
// 고정한 할 일을 연결 유지 서버(Cloudflare Worker)의 저장소에 올려 두면, 위젯이 그걸 읽어 간다.
import * as gcal from "./gcal";
import { dueLabel, type Item } from "./store";

const KEY = "widget_key";
const APP_URL = "https://flyweb123-code.github.io/my-planner/";

// 위젯이 내 목록을 찾는 비밀 주소. 처음 한 번 만들어 이 기기에 둔다.
export function widgetKey() {
  let k = localStorage.getItem(KEY);
  if (!k) {
    const b = crypto.getRandomValues(new Uint8Array(18));
    k = btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    localStorage.setItem(KEY, k);
  }
  return k;
}

export const pinsUrl = () => `${gcal.serverUrl()}/pins/${widgetKey()}`;

export function pinnedPayload(items: Item[]) {
  return items.filter((i) => i.pinned && !i.done).map((i) => ({ t: i.title, d: i.due ? dueLabel(i.due) : "" }));
}

export type SyncState = { state: "off" | "ok" | "fail"; at?: number };
let last = "";
let timer = 0;
let status: SyncState = { state: "off" };
export const syncStatus = () => status;

// 목록이 바뀌면 잠깐 기다렸다가 서버에 올린다. 같은 내용이면 다시 올리지 않는다.
export function syncPins(items: Item[]) {
  if (!gcal.serverUrl()) return void (status = { state: "off" });
  const body = JSON.stringify({ items: pinnedPayload(items) });
  if (body === last) return;
  clearTimeout(timer);
  timer = window.setTimeout(async () => {
    try {
      const r = await fetch(pinsUrl(), { method: "PUT", headers: { "Content-Type": "application/json" }, body });
      if (!r.ok) throw new Error(String(r.status));
      last = body;
      status = { state: "ok", at: Date.now() };
    } catch {
      status = { state: "fail", at: Date.now() };
    }
    window.dispatchEvent(new Event("pins-synced"));
  }, 800);
}

// Scriptable 앱에 붙여 넣을 위젯 스크립트
export function scriptableCode() {
  return `// 클론 · 고정한 할 일 (잠금 화면 위젯)
const SRC = ${JSON.stringify(pinsUrl())};
const APP = ${JSON.stringify(APP_URL)};
const fm = FileManager.local();
const cache = fm.joinPath(fm.documentsDirectory(), "klon-pins.json");
let data = null;
try {
  const r = new Request(SRC);
  r.timeoutInterval = 10;
  data = await r.loadJSON();
  if (data && data.items) fm.writeString(cache, JSON.stringify(data));
} catch (e) {}
if (!data || !data.items) {
  try { data = JSON.parse(fm.readString(cache)); } catch (e) { data = { items: [] }; }
}
const items = data.items || [];
const fam = config.widgetFamily || "accessoryRectangular";
const w = new ListWidget();
w.url = APP;
w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);

if (fam === "accessoryInline") {
  w.addText(items.length ? "📌 " + items[0].t + (items.length > 1 ? " 외 " + (items.length - 1) + "개" : "") : "고정한 할 일 없음");
} else if (fam === "accessoryCircular") {
  w.addAccessoryWidgetBackground = true;
  const n = w.addText(String(items.length));
  n.font = Font.boldSystemFont(22);
  n.centerAlignText();
  const l = w.addText("할 일");
  l.font = Font.systemFont(10);
  l.centerAlignText();
} else if (fam.startsWith("accessory")) {
  if (!items.length) w.addText("고정한 할 일 없음").font = Font.systemFont(13);
  const max = items.length > 3 ? 2 : 3;
  for (const it of items.slice(0, max)) {
    const t = w.addText("• " + it.t + (it.d ? "  " + it.d : ""));
    t.font = Font.semiboldSystemFont(13);
    t.lineLimit = 1;
  }
  if (items.length > 3) w.addText("외 " + (items.length - 2) + "개 더").font = Font.systemFont(12);
} else {
  w.backgroundColor = Color.dynamic(new Color("#ffffff"), new Color("#1c1c1e"));
  const h = w.addText("고정한 할 일");
  h.font = Font.boldSystemFont(13);
  h.textColor = new Color("#3b6cf6");
  w.addSpacer(6);
  if (!items.length) w.addText("없음").font = Font.systemFont(13);
  const max = fam === "large" ? 10 : 5;
  for (const it of items.slice(0, max)) {
    const t = w.addText("• " + it.t + (it.d ? "  " + it.d : ""));
    t.font = Font.systemFont(13);
    t.lineLimit = 1;
  }
  w.addSpacer();
}
if (config.runsInWidget) Script.setWidget(w);
else if (w.presentAccessoryRectangular) await w.presentAccessoryRectangular();
else await w.presentMedium();
Script.complete();
`;
}
