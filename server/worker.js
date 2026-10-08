// 구글 캘린더 연결을 계속 유지해 주는 작은 서버 (Cloudflare Workers)
//
// 구글은 서버 없는 웹앱에 1시간짜리 권한만 준다. 이 서버는 처음 연결할 때 받은
// "새로 고침 열쇠"(refresh token)를 암호화해서 앱에 돌려주고, 앱이 그걸 보내면
// 새 1시간짜리 권한을 대신 받아 준다. 서버에는 아무것도 저장하지 않는다.
//
// Cloudflare 대시보드의 Worker 설정에서 넣어야 하는 값
//   GOOGLE_CLIENT_SECRET (비밀): 구글 클라우드 콘솔의 OAuth 클라이언트 보안 비밀번호
//   ENC_KEY (비밀): 아무 긴 임의 문자열 (열쇠를 암호화하는 데 씀)

const GOOGLE_CLIENT_ID = "544290783646-1p87mf5v6gba2ebemh363tmn9j6p9v2k.apps.googleusercontent.com";
const ALLOWED_ORIGINS = ["https://flyweb123-code.github.io", "http://localhost:5173", "http://localhost:4173"];

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path === "/") return json({ ok: true, ready: !!(env.GOOGLE_CLIENT_SECRET && env.ENC_KEY) });
    if (req.method !== "POST") return json({ error: "not_found" }, 404);
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "origin_not_allowed" }, 403);
    if (!env.GOOGLE_CLIENT_SECRET || !env.ENC_KEY) return json({ error: "server_not_configured" }, 500);

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "bad_request" }, 400);
    }

    if (path === "/exchange") {
      // 앱이 받은 일회용 코드를 권한 + 새로 고침 열쇠로 바꾼다
      const r = await google({ code: body.code, grant_type: "authorization_code", redirect_uri: "postmessage" }, env);
      if (!r.access_token) return json({ error: r.error || "exchange_failed", detail: r.error_description }, 400);
      if (!r.refresh_token) return json({ error: "no_refresh_token" }, 400);
      return json({ access_token: r.access_token, expires_in: r.expires_in, session: await seal(r.refresh_token, env.ENC_KEY) });
    }

    if (path === "/refresh") {
      let refresh;
      try {
        refresh = await open(body.session, env.ENC_KEY);
      } catch {
        return json({ error: "bad_session" }, 401);
      }
      const r = await google({ refresh_token: refresh, grant_type: "refresh_token" }, env);
      if (!r.access_token) return json({ error: r.error || "refresh_failed" }, r.error === "invalid_grant" ? 401 : 400);
      return json({ access_token: r.access_token, expires_in: r.expires_in });
    }

    return json({ error: "not_found" }, 404);
  },
};

async function google(params, env) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params }),
  });
  return res.json();
}

// ---- 새로 고침 열쇠 암호화 (AES-GCM) ----
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function key(secret) {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(text, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(secret), new TextEncoder().encode(text));
  return b64(iv) + "." + b64(ct);
}
async function open(sealed, secret) {
  const [iv, ct] = String(sealed).split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key(secret), unb64(ct));
  return new TextDecoder().decode(pt);
}
