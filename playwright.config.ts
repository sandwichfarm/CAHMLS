import { defineConfig, devices } from "@playwright/test";

const previewPort = process.env.PLAYWRIGHT_PORT ?? "4173";
const previewUrl = `http://127.0.0.1:${previewPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: previewUrl,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chromium",
      testMatch: /mobile-optimized-experience\.spec\.ts/,
      use: {
        ...devices["Pixel 5"],
        browserName: "chromium",
        isMobile: true,
        hasTouch: true,
      },
    },
    // WebKit runs this MLS/relay path roughly an order of magnitude slower
    // than Chromium, so its parity run is opt-in via MOBILE_WEBKIT=1 rather
    // than part of the default gate. The journeys themselves pass on WebKit.
    ...(process.env.MOBILE_WEBKIT
      ? [{
          name: "mobile-webkit",
          testMatch: /mobile-optimized-experience\.spec\.ts/,
          use: {
            ...devices["iPhone 13"],
            browserName: "webkit" as const,
            isMobile: true,
            hasTouch: true,
          },
        }]
      : []),
  ],
  webServer: {
    command: `VITE_E2E=1 pnpm build && vite preview --host 127.0.0.1 --port ${previewPort}`,
    url: previewUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
