import { defineConfig } from '@playwright/test';

/**
 * E2E smoke tests. They load the *built* extension into Chromium, so run
 * `npm run build` first (the `test:e2e` script does this). The local backend
 * is started from its build output on the default port.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  webServer: {
    // Mock ASR so the smoke tests need no model download; a backend the user
    // already has running (any provider) is reused instead.
    command: 'node packages/server/dist/index.js',
    env: { ASR_PROVIDER: 'mock' },
    url: 'http://127.0.0.1:8787/healthz',
    reuseExistingServer: true,
    timeout: 20_000,
  },
});
