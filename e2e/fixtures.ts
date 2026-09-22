import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const EXTENSION_DIST = fileURLToPath(new URL('../packages/extension/dist', import.meta.url));

export interface ExtensionFixtures {
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
}

/**
 * Launches a persistent Chromium context with the built extension loaded and
 * waits for its MV3 service worker. Extensions require `channel: 'chromium'`
 * to work in headless mode.
 */
export const test = base.extend<ExtensionFixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION_DIST}`, `--load-extension=${EXTENSION_DIST}`],
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
