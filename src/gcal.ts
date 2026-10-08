// 구글 캘린더 연동: 서버 없이 브라우저에서 Google 로그인 토큰을 받아 캘린더 API를 부른다.
export type CalEvent = { id: string; title: string; start: string; end: string };

type TokenResponse = { access_token?: string; expires_in?: number; error?: string };
type TokenClient = { requestAccessToken: (o?: { prompt?: string }) => void };
declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (cfg: {
            client_id: string;
            scope: string;
            callback: (r: TokenResponse) => void;
          }) => TokenClient;
        };
      };
    };
  }
}

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const TOKEN_KEY = "gcal_token";

function loadScript(): Promise<void> {
  if (window.google?.accounts) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("구글 로그인 스크립트를 불러오지 못했어요."));
    document.head.appendChild(s);
  });
}

export function savedToken(): string | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const { token, exp } = JSON.parse(raw);
    return Date.now() < exp ? token : null;
  } catch {
    return null;
  }
}

export async function connect(clientId: string): Promise<string> {
  if (!clientId) throw new Error("설정에서 구글 클라이언트 ID를 먼저 넣어 주세요.");
  await loadScript();
  return new Promise((resolve, reject) => {
    const tc = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (r) => {
        if (!r.access_token) return reject(new Error(r.error || "구글 연결이 취소됐어요."));
        try {
          sessionStorage.setItem(
            TOKEN_KEY,
            JSON.stringify({ token: r.access_token, exp: Date.now() + ((r.expires_in ?? 3600) - 60) * 1000 }),
          );
        } catch {
          /* 무시 */
        }
        resolve(r.access_token);
      },
    });
    tc.requestAccessToken();
  });
}

async function api(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (res.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
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
  const max = new Date(now.getTime() + days * 86400000);
  const q = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: max.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "30",
  });
  const data = await api(token, `/calendars/primary/events?${q}`);
  return (data.items ?? []).map((e: { id: string; summary?: string; start: object; end: object }) => ({
    id: e.id,
    title: e.summary ?? "(제목 없음)",
    start: fmt(e.start),
    end: fmt(e.end),
  }));
}

// 할 일의 마감일을 종일 일정으로 캘린더에 넣거나 갱신한다.
export async function upsertDueEvent(token: string, title: string, due: string, eventId?: string): Promise<string> {
  const end = new Date(due + "T00:00:00");
  end.setDate(end.getDate() + 1);
  const body = JSON.stringify({
    summary: `⏰ ${title}`,
    start: { date: due },
    end: { date: end.toLocaleDateString("sv-SE") },
  });
  const path = eventId ? `/calendars/primary/events/${eventId}` : "/calendars/primary/events";
  const data = await api(token, path, { method: eventId ? "PATCH" : "POST", body });
  return data.id;
}
