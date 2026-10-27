import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, /api/claude is forwarded to the local key-holding proxy
// (server/proxy.mjs). The browser never sees your API key.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: true } },
  },
});
