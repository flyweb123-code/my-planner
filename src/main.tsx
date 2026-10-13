import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

// 아이폰 사파리는 화면 확대 금지 설정을 무시하므로, 두 손가락 확대 동작 자체를 막는다.
const stopZoom = (e: Event) => e.preventDefault();
for (const t of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(t, stopZoom, { passive: false });
document.addEventListener("touchmove", (e) => e.touches.length > 1 && e.preventDefault(), { passive: false });
