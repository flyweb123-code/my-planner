// 앱 화면을 캐시해서 오프라인에서도 열리게 한다. API 호출은 캐시하지 않는다.
const CACHE = "planner-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("./")))
  );
});

// 일정 알림 (연결 유지 서버가 보내는 웹 푸시). 받으면 알림을 띄우고 앱 아이콘에 빨간 숫자를 단다.
self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { title: "클론", body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    Promise.all([
      self.registration.showNotification(d.title || "클론", { body: d.body || "", tag: d.tag, icon: "./icon-180.png", badge: "./icon-180.png", data: { url: "./" } }),
      d.badge && self.navigator.setAppBadge ? self.navigator.setAppBadge(d.badge).catch(() => {}) : null,
    ]),
  );
});

// 알림을 누르면 열려 있는 앱 창으로 가거나 새로 연다
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const win = list.find((c) => "focus" in c);
      return win ? win.focus() : self.clients.openWindow(e.notification.data?.url || "./");
    }),
  );
});
