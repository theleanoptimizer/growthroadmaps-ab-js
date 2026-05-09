import { defineConfig } from '@playwright/test';

const PORT = parseInt(process.env.SDK_E2E_PORT || '4173', 10);

export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 20_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,

  use: {
    headless: true,
    launchOptions: {
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  },

  webServer: {
    command: `node test/e2e/serve.mjs`,
    url: `http://127.0.0.1:${PORT}/growth.min.js`,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
    env: { SDK_E2E_PORT: String(PORT) },
  },

  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
