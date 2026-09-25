import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';

const EXTENSION_DIST = fileURLToPath(new URL('../packages/extension/dist', import.meta.url));

export interface ExtensionFixtures {
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  fixture: FixtureServer;
  /** URL of the fixture "YouTube" page as seen by the browser. */
  youtubeUrl: string;
}

/**
 * Launches a persistent Chromium context with the built extension loaded and
 * waits for its MV3 service worker. Extensions require `channel: 'chromium'`
 * to work in headless mode. `www.youtube.com` is resolved to the local
 * fixture server so the content script runs against a controllable page.
 */
export const test = base.extend<ExtensionFixtures>({
  // eslint-disable-next-line no-empty-pattern
  fixture: async ({}, use) => {
    const server = await startFixtureServer();
    await use(server);
    await server.close();
  },
  youtubeUrl: async ({ fixture }, use) => {
    await use(`https://www.youtube.com:${fixture.port}/watch?v=fixture`);
  },
  context: async ({ fixture: _fixture }, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      ignoreHTTPSErrors: true,
      args: [
        `--disable-extensions-except=${EXTENSION_DIST}`,
        `--load-extension=${EXTENSION_DIST}`,
        `--host-resolver-rules=MAP www.youtube.com 127.0.0.1`,
        '--ignore-certificate-errors',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    await use(context);
    await context.close();
  },
  serviceWorker: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await use(worker);
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
});

export const expect = test.expect;
