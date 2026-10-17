import { defineConfig } from "vite";

// Serves the browser test harness (harness/index.html) straight from the engine's
// TypeScript sources. Specs import engine modules as /src/<path>.ts.
export default defineConfig({
  server: { host: "127.0.0.1", port: 4173, strictPort: true },
  cacheDir: "node_modules/.vite-harness",
});
