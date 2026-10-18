import { defineConfig } from "@playwright/test";

// Browser specs mount the engine in harness/index.html, served by Vite from the
// TypeScript sources. CHROMIUM_PATH points Playwright at a preinstalled Chromium.
export default defineConfig({
  testDir: "./tests/browser",
  reporter: "list",
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : undefined,
  },
  projects: [
    // The multi-chart census and its endurance profile take most of the run; CI
    // gives them their own job.
    { name: "default", testIgnore: ["**/chart-multi-market-census.spec.ts"] },
    { name: "census", testMatch: ["**/chart-multi-market-census.spec.ts"] },
  ],
  webServer: {
    command: "node ./node_modules/vite/bin/vite.js --configLoader native",
    url: "http://127.0.0.1:4173/harness/",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
