import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The production shell is served same-origin by the host. In dev, Vite proxies only to the local dev host
// (pnpm dev sets AGENTOS_PORT, default 4318).
const target = `http://127.0.0.1:${process.env.AGENTOS_PORT ?? "4318"}`;
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: { host: "127.0.0.1", port: 5173, proxy: { "/api": target, "/health": target } },
});
