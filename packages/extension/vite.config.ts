import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * Builds the ES-module entries of the extension:
 *   - background.js   (service worker, "type": "module" in manifest)
 *   - popup.html      (React popup)
 *   - offscreen.html  (audio capture + backend WebSocket)
 *   - pcm-worklet.js  (AudioWorklet: 16 kHz PCM16 for the ASR backend; must stay import-free)
 * The content script is built separately (see vite.content.config.ts)
 * because MV3 content scripts cannot be ES modules.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@lst/protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    target: 'chrome116',
    rollupOptions: {
      input: {
        background: fileURLToPath(new URL('./src/background/service-worker.ts', import.meta.url)),
        popup: fileURLToPath(new URL('./popup.html', import.meta.url)),
        offscreen: fileURLToPath(new URL('./offscreen.html', import.meta.url)),
        'pcm-worklet': fileURLToPath(new URL('./src/offscreen/pcm-worklet.ts', import.meta.url)),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
