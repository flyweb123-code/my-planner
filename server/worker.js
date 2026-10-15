// 구글 캘린더 연결을 계속 유지해 주는 작은 서버 (Cloudflare Workers)
//
// 구글은 서버 없는 웹앱에 1시간짜리 권한만 준다. 이 서버는 처음 연결할 때 받은
// "새로 고침 열쇠"(refresh token)를 암호화해서 앱에 돌려주고, 앱이 그걸 보내면
// 새 1시간짜리 권한을 대신 받아 준다. 서버에는 아무것도 저장하지 않는다.
//
// Cloudflare 대시보드의 Worker 설정에서 넣어야 하는 값
//   GOOGLE_CLIENT_SECRET (비밀): 구글 클라우드 콘솔의 OAuth 클라이언트 보안 비밀번호
//   ENC_KEY (비밀): 아무 긴 임의 문자열 (열쇠를 암호화하는 데 씀)
//   PINS (KV 연결, 선택): 잠금 화면 위젯에 띄울 '고정한 할 일'을 보관하는 저장소.
//                         일정 3시간 전 휴대폰 알림(웹 푸시)도 같은 저장소를 쓴다.
//   크론 트리거 (선택): Worker 설정 → 트리거 → 크론에서 5분마다(*/5 * * * *) 돌게 하면 앱이 닫혀 있어도 알림이 온다.

const GOOGLE_CLIENT_ID = "544290783646-1p87mf5v6gba2ebemh363tmn9j6p9v2k.apps.googleusercontent.com";
const ALLOWED_ORIGINS = ["https://flyweb123-code.github.io", "http://localhost:5173", "http://localhost:4173"];

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path === "/") return json({ ok: true, ready: !!(env.GOOGLE_CLIENT_SECRET && env.ENC_KEY), pins: !!env.PINS, push: !!env.PINS });

    // 잠금 화면 위젯용 고정 목록. 주소 끝의 긴 임의 문자열이 곧 열쇠다.
    const pin = path.match(/^\/pins\/([A-Za-z0-9_-]{20,64})$/);
    if (pin) {
      if (!env.PINS) return json({ error: "no_kv" }, 501);
      if (req.method === "GET") {
        const v = await env.PINS.get(pin[1]);
        return new Response(v || '{"items":[]}', { headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
      }
      if (req.method === "PUT") {
        if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "origin_not_allowed" }, 403);
        const text = await req.text();
        if (text.length > 20000) return json({ error: "too_large" }, 413);
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          return json({ error: "bad_request" }, 400);
        }
        const items = (Array.isArray(data.items) ? data.items : []).slice(0, 30).map((i) => ({ t: String(i.t || "").slice(0, 120), d: String(i.d || "").slice(0, 20) }));
        await env.PINS.put(pin[1], JSON.stringify({ items, at: Date.now() }));
        return json({ ok: true });
      }
      return json({ error: "not_found" }, 404);
    }

    // 일정 알림(웹 푸시): 서버 공개 열쇠, 기기별 구독 + 다가오는 일정 목록
    if (req.method === "GET" && path === "/push/key") {
      if (!env.PINS) return json({ error: "no_kv" }, 501);
      return json({ key: (await vapid(env)).pub });
    }
    const push = path.match(/^\/push\/([A-Za-z0-9_-]{20,64})$/);
    if (push) {
      if (!env.PINS) return json({ error: "no_kv" }, 501);
      if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "origin_not_allowed" }, 403);
      const id = "push:" + push[1];
      if (req.method === "DELETE") {
        await env.PINS.delete(id);
        return json({ ok: true });
      }
      if (req.method !== "PUT") return json({ error: "not_found" }, 404);
      const text = await req.text();
      if (text.length > 30000) return json({ error: "too_large" }, 413);
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return json({ error: "bad_request" }, 400);
      }
      const sub = data.sub;
      if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return json({ error: "bad_subscription" }, 400);
      const alerts = (Array.isArray(data.alerts) ? data.alerts : []).slice(0, 100).map((a) => ({ k: String(a.k || "").slice(0, 200), t: String(a.t || "").slice(0, 120), l: String(a.l || "").slice(0, 40), at: Number(a.at) || 0 }));
      const old = JSON.parse((await env.PINS.get(id)) || "null");
      const now = Date.now();
      // 이미 보낸 알림은 다시 보내지 않는다 (지난 일정은 정리)
      const sent = (old?.sent || []).filter((k) => alerts.some((a) => a.k === k && a.at > now - 3600000));
      await env.PINS.put(id, JSON.stringify({ sub: { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } }, alerts, sent, at: now }));
      return json({ ok: true });
    }
    if (req.method === "POST" && path === "/push/test") {
      if (!env.PINS) return json({ error: "no_kv" }, 501);
      if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "origin_not_allowed" }, 403);
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: "bad_request" }, 400);
      }
      const rec = JSON.parse((await env.PINS.get("push:" + String(body.id || ""))) || "null");
      if (!rec) return json({ error: "no_subscription" }, 404);
      const r = await sendPush(env, rec.sub, { title: "클론 알림 시험", body: "이렇게 일정 3시간 전에 알려 드려요.", tag: "test" });
      return json({ ok: r.ok, status: r.status }, r.ok ? 200 : 502);
    }

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

  // 크론 트리거: 5분마다 기기별 일정 목록을 보고, 시작 3시간 안으로 들어온 일정을 휴대폰에 알린다.
  async scheduled(_event, env, ctx) {
    if (env.PINS) ctx.waitUntil(sendDueAlerts(env));
  },
};

const LEAD = 3 * 3600000; // 일정 시작 3시간 전

async function sendDueAlerts(env) {
  const now = Date.now();
  let cursor;
  do {
    const page = await env.PINS.list({ prefix: "push:", cursor });
    for (const { name } of page.keys) {
      const rec = JSON.parse((await env.PINS.get(name)) || "null");
      if (!rec?.sub) continue;
      const live = rec.alerts.filter((a) => a.at > now && a.at - LEAD <= now);
      const due = live.filter((a) => !rec.sent.includes(a.k));
      if (!due.length) continue;
      let gone = false;
      for (const a of due) {
        const r = await sendPush(env, rec.sub, { title: a.t, body: `${a.l} 시작 · ${left(a.at - now)} 남았어요`, tag: a.k, badge: live.length });
        // 404/410: 사용자가 알림을 껐거나 앱을 지움 → 구독을 지운다
        if (r.status === 404 || r.status === 410) {
          gone = true;
          break;
        }
        if (r.ok) rec.sent.push(a.k);
      }
      if (gone) await env.PINS.delete(name);
      else await env.PINS.put(name, JSON.stringify(rec));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

function left(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h}시간${m % 60 ? ` ${m % 60}분` : ""}` : `${m}분`;
}

// ---- 웹 푸시 (VAPID + aes128gcm 암호화, RFC 8291/8292) ----
// 서버 열쇠는 처음 쓸 때 만들어 저장소에 둔다. 따로 넣을 비밀 값이 없다.
async function vapid(env) {
  const saved = await env.PINS.get("vapid");
  if (saved) return JSON.parse(saved);
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const v = { pub: b64(await crypto.subtle.exportKey("raw", kp.publicKey)), jwk: await crypto.subtle.exportKey("jwk", kp.privateKey) };
  await env.PINS.put("vapid", JSON.stringify(v));
  return v;
}

async function sendPush(env, sub, payload) {
  const v = await vapid(env);
  const aud = new URL(sub.endpoint).origin;
  const enc = (o) => b64(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ typ: "JWT", alg: "ES256" }) + "." + enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "https://flyweb123-code.github.io/my-planner/" });
  const priv = await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, new TextEncoder().encode(unsigned));
  const body = await encryptPush(sub.keys, new TextEncoder().encode(JSON.stringify(payload)));
  return fetch(sub.endpoint, {
    method: "POST",
    headers: { Authorization: `vapid t=${unsigned}.${b64(sig)}, k=${v.pub}`, "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "10800", Urgency: "high" },
    body,
  });
}

async function encryptPush(keys, plain) {
  const uaPub = unb64(keys.p256dh);
  const auth = unb64(keys.auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const peer = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, local.privateKey, 256));
  const ikm = await hkdf(auth, secret, cat(new TextEncoder().encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, cat(plain, new Uint8Array([2]))));
  const head = new Uint8Array(21);
  head.set(salt);
  new DataView(head.buffer).setUint32(16, 4096);
  head[20] = asPub.length;
  return cat(head, asPub, ct);
}

async function hkdf(salt, ikm, info, len) {
  const hmac = async (k, d) => new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), d));
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, cat(info, new Uint8Array([1])))).slice(0, len);
}

function cat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

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
