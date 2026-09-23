import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultModelsDir } from '../config.js';
import { SENSEVOICE_MODEL_DIR, SherpaWorkerHost, createSherpaFactory } from './sherpa-adapter.js';
import type { AsrTranscript } from './types.js';

/**
 * Real SenseVoice via the worker thread. Skipped when the models have not
 * been downloaded (npm run models:download). Runs the bundled English test
 * clip through the adapter as 100 ms PCM16 frames.
 */
const modelsDir = defaultModelsDir();
const available = SherpaWorkerHost.checkModels(modelsDir) === null;
const log = { info: () => {}, warn: () => {} };

describe.skipIf(!available)('SenseVoice adapter (real model)', () => {
  it('recognises the bundled English clip with partials before the final', async () => {
    const factory = createSherpaFactory({ modelsDir, numThreads: 2, log });
    await factory.prepare();
    const adapter = factory.create();
    const out: AsrTranscript[] = [];
    const errors: string[] = [];
    adapter.on('transcript', (t) => out.push(t));
    adapter.on('error', (code, message) => errors.push(`${code}: ${message}`));
    const t0 = Date.now();
    const info = await adapter.start({ sessionId: 'it-1', sourceLanguage: 'auto' });
    expect(info.language).toBe('auto');

    const sherpa = (await import('node:module')).createRequire(import.meta.url)('sherpa-onnx-node');
    const wave = sherpa.readWave(path.join(modelsDir, SENSEVOICE_MODEL_DIR, 'test_wavs', 'en.wav')) as { samples: Float32Array; sampleRate: number };
    expect(wave.sampleRate).toBe(16000);
    const pcm = new Int16Array(wave.samples.length);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round((wave.samples[i] ?? 0) * 32767)));
    for (let i = 0; i < pcm.length; i += 1600) {
      adapter.pushAudio(pcm.subarray(i, i + 1600));
      await new Promise((r) => setTimeout(r, 5));
    }
    // Trailing silence so the VAD closes the segment, then flush.
    adapter.pushAudio(new Int16Array(16000));
    await adapter.stop();

    const finals = out.filter((t) => t.status === 'final');
    expect(errors, JSON.stringify(out)).toEqual([]);
    expect(finals.length, JSON.stringify(out)).toBeGreaterThanOrEqual(1);
    expect(finals.map((t) => t.text).join(' ').toLowerCase()).toContain('tribal chieftain');
    expect(finals[0]!.language).toBe('en');
    expect(out.filter((t) => t.status === 'partial').length).toBeGreaterThanOrEqual(1);
    expect(out[0]!.segmentId).toBe(finals[0]!.segmentId);
    // Frames were pushed much faster than real time: the backlog guard must have kicked in
    // and the whole run (including stop) must finish well under the 10 s stop timeout.
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 60_000);
});

describe('SherpaWorkerHost.checkModels', () => {
  it('lists missing files with a download hint', () => {
    const msg = SherpaWorkerHost.checkModels(path.join(modelsDir, 'does-not-exist'));
    expect(msg).toMatch(/Missing ASR model files/);
    expect(msg).toMatch(/npm run models:download/);
    expect(existsSync(path.join(modelsDir, 'does-not-exist'))).toBe(false);
  });
});
