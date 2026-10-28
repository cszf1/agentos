import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The production shell is served same-origin by the host. In dev, Vite proxies only to the local host.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: { host: "127.0.0.1", port: 5173, proxy: { "/api": "http://127.0.0.1:4317", "/health": "http://127.0.0.1:4317" } },
});
