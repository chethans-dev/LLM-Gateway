import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin in development, matching how nginx serves it in the
    // container. No CORS configuration exists anywhere as a result — one fewer
    // thing to get wrong, and the browser never talks to the gateway directly.
    proxy: {
      "/v1": { target: "http://localhost:4000", changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
