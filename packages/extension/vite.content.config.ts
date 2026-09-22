import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/** Content script: single self-contained IIFE file, no module imports at runtime. */
export default defineConfig({
  resolve: {
    alias: {
      '@lst/protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
    },
  },
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    minify: false,
    target: 'chrome116',
    lib: {
      entry: fileURLToPath(new URL('./src/content/content.ts', import.meta.url)),
      formats: ['iife'],
      name: 'lstContent',
      fileName: () => 'content.js',
    },
  },
});
