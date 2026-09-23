import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultModelsDir } from '../config.js';
import { HYMT2_MODEL_FILE, createHyMt2Factory } from './hymt2-adapter.js';

/** Real local model; skipped when the GGUF is not downloaded (npm run models:download). */
const modelsDir = defaultModelsDir();
const available = existsSync(path.join(modelsDir, HYMT2_MODEL_FILE));
const log = { info: () => {}, warn: () => {} };

describe.skipIf(!available)('Hy-MT2 adapter (real model)', () => {
  it('translates English into Simplified Chinese and honours abort', async () => {
    const factory = createHyMt2Factory({ modelsDir, threads: 3, log });
    await factory.prepare();
    const adapter = factory.create();
    const out = await adapter.translate({ text: 'The tribal chieftain called for the boy and presented him with fifty pieces of gold.', sourceLanguage: 'en', targetLanguage: 'zh-CN', context: [] });
    expect(out).toMatch(/[部落首领酋长]/);
    expect(out).toMatch(/金/);
    expect(out.includes('`')).toBe(false);

    const ac = new AbortController();
    const p = adapter.translate({ text: 'Another long sentence to translate that we will cancel immediately.', sourceLanguage: 'en', targetLanguage: 'ja', context: [], signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow();
    await factory.dispose();
  }, 120_000);
});
