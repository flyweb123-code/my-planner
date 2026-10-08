// 구글 캘린더 연동: 구글 클라우드 설정 없이, 사용자가 자기 구글 계정에 붙여 넣은
// Apps Script(아래 SCRIPT)를 통해 캘린더를 읽고 일정을 넣는다.
export type CalEvent = { id: string; title: string; start: string; end: string };
export type CalConfig = { url: string; key: string };

export const SCRIPT = (key: string) => `// 내 비서 앱용 캘린더 연결 스크립트
const KEY = '${key}';

function doGet(e) {
  const p = e.parameter;
  if (p.key !== KEY) return json({ error: 'wrong key' });
  const cal = CalendarApp.getDefaultCalendar();
  if (p.action === 'add') {
    const ev = p.start
      ? cal.createEvent(p.title, new Date(p.start), new Date(p.end))
      : cal.createAllDayEvent(p.title, new Date(p.date + 'T00:00:00'));
    return json({ id: ev.getId() });
  }
  const now = new Date();
  const until = new Date(now.getTime() + Number(p.days || 7) * 86400000);
  const events = cal.getEvents(now, until).map(function (ev) {
    return {
      id: ev.getId(),
      title: ev.getTitle(),
      start: ev.getStartTime().toISOString(),
      end: ev.getEndTime().toISOString(),
      allDay: ev.isAllDayEvent(),
    };
  });
  return json({ events: events });
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
`;

export const newKey = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

async function call(cfg: CalConfig, params: Record<string, string>) {
  if (!cfg.url) throw new Error("설정에서 캘린더 연결 주소를 먼저 넣어 주세요.");
  const q = new URLSearchParams({ ...params, key: cfg.key });
  const res = await fetch(`${cfg.url}?${q}`);
  if (!res.ok) throw new Error(`캘린더 요청 실패 (${res.status})`);
  const data = await res.json();
  if (data.error) throw new Error(data.error === "wrong key" ? "스크립트의 키가 앱과 달라요. 설정에서 스크립트를 다시 복사해 붙여 주세요." : data.error);
  return data;
}

const fmt = (iso: string, allDay: boolean) =>
  allDay
    ? new Date(iso).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric", weekday: "short" }) + " (종일)"
    : new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });

export async function upcoming(cfg: CalConfig, days = 7): Promise<CalEvent[]> {
  const data = await call(cfg, { days: String(days) });
  return (data.events ?? []).map((e: { id: string; title: string; start: string; end: string; allDay: boolean }) => ({
    id: e.id,
    title: e.title || "(제목 없음)",
    start: fmt(e.start, e.allDay),
    end: e.allDay ? "" : fmt(e.end, false),
  }));
}

// date: 종일 일정(YYYY-MM-DD). start/end: 시간 있는 일정(ISO 문자열).
export async function addEvent(cfg: CalConfig, ev: { title: string; date?: string; start?: string; end?: string }): Promise<string> {
  const params: Record<string, string> = { action: "add", title: ev.title };
  if (ev.start) {
    params.start = ev.start;
    params.end = ev.end || new Date(new Date(ev.start).getTime() + 3600000).toISOString();
  } else if (ev.date) params.date = ev.date;
  else throw new Error("날짜가 없어요.");
  const data = await call(cfg, params);
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
