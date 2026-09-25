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
    // Mock providers on a dedicated port so the tests never collide with the
    // developer's backend on 8787 (whose tsx watcher may be restarting).
    command: 'node packages/server/dist/index.js',
    env: { ASR_PROVIDER: 'mock', TRANSLATION_PROVIDER: 'mock', PORT: '8797', LOGS_DIR: 'off' },
    url: 'http://127.0.0.1:8797/healthz',
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
