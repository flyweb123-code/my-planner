import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 버전: main에 올라간 변경(커밋)마다 하나씩 자동으로 올라간다. v1.1 = 버전 표시를 넣은 첫 패치.
const VERSION_BASE = 62; // 버전 표시를 넣기 직전까지의 커밋 수
function appVersion() {
  try {
    const n = Number(execSync("git rev-list --count HEAD").toString().trim());
    return `1.${n - VERSION_BASE}`;
  } catch {
    return "1.?";
  }
}

// 상대 경로로 빌드해서 어느 주소에 올려도 동작하게 한다.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { chunkSizeWarningLimit: 800 },
  define: { __APP_VERSION__: JSON.stringify(appVersion()), __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
});
