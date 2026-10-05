import { defineConfig } from "vite";

// The FastAPI app serves the built bundle from backend/app/static at /static/,
// and falls back to index.html for every non-API route.
export default defineConfig({
  base: "/static/",
  build: {
    outDir: "../backend/app/static",
    emptyOutDir: true,
    target: "es2022",
  },
  worker: {
    format: "es",
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
});
