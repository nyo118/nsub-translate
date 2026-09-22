import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Single root Vitest config. Files that need a DOM declare
// `// @vitest-environment happy-dom` at the top.
export default defineConfig({
  resolve: {
    alias: {
      '@lst/protocol': fileURLToPath(new URL('./packages/protocol/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/**/src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
});
