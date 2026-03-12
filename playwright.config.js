const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: "https://localhost:3000",
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run dev",
    url: "https://localhost:3000",
    timeout: 120_000,
    reuseExistingServer: true,
    ignoreHTTPSErrors: true,
  },
});
