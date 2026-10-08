import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 상대 경로로 빌드해서 어느 주소에 올려도 동작하게 한다.
export default defineConfig({ base: "./", plugins: [react()], build: { chunkSizeWarningLimit: 800 } });
