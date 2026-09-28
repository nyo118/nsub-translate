import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { OVERLAP_PLACEHOLDER } from '@lst/protocol';
import { describe, expect, it } from 'vitest';
import { defaultModelsDir } from '../config.js';
import { DENOISER_MODEL_FILE, DENOISER_MODEL_FILES, EMBEDDING_MODEL_FILE, SEGMENTATION_MODEL_FILE, SENSEVOICE_MODEL_DIR, SherpaWorkerHost, createSherpaFactory } from './sherpa-adapter.js';
import type { AsrStartOptions, AsrTranscript } from './types.js';

/**
 * Real models (SenseVoice + GTCRN + pyannote + 3D-Speaker). Skipped unless
 * every model is present (npm run models:download). Builds two clips from the
 * bundled test wavs: English then Chinese (two people in turn) and the two
 * mixed together (two people at once).
 */
const modelsDir = defaultModelsDir();
const optional = [DENOISER_MODEL_FILE, DENOISER_MODEL_FILES.dpdfnet2, SEGMENTATION_MODEL_FILE, EMBEDDING_MODEL_FILE].map((f) => path.join(modelsDir, f));
const available = SherpaWorkerHost.checkModels(modelsDir) === null && optional.every((f) => existsSync(f));
const log = { info: () => {}, warn: () => {} };

function wav(name: string): Float32Array {
  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node');
  return (sherpa.readWave(path.join(modelsDir, SENSEVOICE_MODEL_DIR, 'test_wavs', name)) as { samples: Float32Array }).samples;
}

async function recognise(samples: Float32Array, options: Omit<AsrStartOptions, 'sessionId' | 'sourceLanguage'>): Promise<AsrTranscript[]> {
  const factory = createSherpaFactory({ modelsDir, numThreads: 2, log });
  await factory.prepare();
  const adapter = factory.create();
  const out: AsrTranscript[] = [];
  const errors: string[] = [];
  adapter.on('transcript', (t) => out.push(t));
  adapter.on('error', (code, message) => errors.push(`${code}: ${message}`));
  await adapter.start({ sessionId: `voices-${Math.random()}`, sourceLanguage: 'auto', ...options });
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round((samples[i] ?? 0) * 32767)));
  for (let i = 0; i < pcm.length; i += 1600) adapter.pushAudio(pcm.subarray(i, i + 1600));
  adapter.pushAudio(new Int16Array(16000));
  await adapter.stop();
  expect(errors).toEqual([]);
  return out.filter((t) => t.status === 'final');
}

describe.skipIf(!available)('multi-voice front-ends (real models)', () => {
  it('labels two people speaking in turn with different speakers', async () => {
    const en = wav('en.wav');
    const zh = wav('zh.wav');
    const gap = new Float32Array(8000); // 0.5 s pause between the two speakers
    const seq = new Float32Array(en.length + gap.length + zh.length);
    seq.set(en);
    seq.set(gap, en.length);
    seq.set(zh, en.length + gap.length);
    const finals = await recognise(seq, { diarize: true, overlap: 'mark' });
    const speakers = finals.filter((t) => !t.overlap).map((t) => t.speaker);
    expect(finals.length, JSON.stringify(finals)).toBeGreaterThanOrEqual(2);
    expect(new Set(speakers).size, JSON.stringify(finals)).toBe(2);
    const en_ = finals.find((t) => t.language === 'en');
    const zh_ = finals.find((t) => t.language === 'zh');
    expect(en_?.speaker, JSON.stringify(finals)).toBeDefined();
    expect(zh_?.speaker, JSON.stringify(finals)).toBeDefined();
    expect(en_?.speaker).not.toBe(zh_?.speaker);
  }, 120_000);

  it('marks two people speaking at once instead of emitting mixed text', async () => {
    const en = wav('en.wav');
    const zh = wav('zh.wav');
    const n = Math.min(en.length, zh.length);
    const mix = new Float32Array(n);
    for (let i = 0; i < n; i++) mix[i] = 0.5 * (en[i] ?? 0) + 0.5 * (zh[i] ?? 0);
    const finals = await recognise(mix, { diarize: true, overlap: 'mark' });
    expect(finals.some((t) => t.overlap && t.text === OVERLAP_PLACEHOLDER), JSON.stringify(finals)).toBe(true);
    // In "skip" mode the overlap produces nothing at all.
    const skipped = await recognise(mix, { diarize: true, overlap: 'skip' });
    expect(skipped.filter((t) => t.overlap)).toEqual([]);
  }, 120_000);

  it('A → B → A+C: A keeps its label across the overlap and C gets a new one', async () => {
    const en = wav('en.wav');
    const zh = wav('zh.wav');
    const ja = wav('ja.wav');
    const gap = new Float32Array(8000);
    const half = Math.floor(en.length / 2);
    const enA = en.subarray(0, half);
    const enB = en.subarray(half);
    // A (first half of en) → B (zh) → A+C (second half of en mixed with ja, then C alone briefly).
    const n = Math.min(enB.length, ja.length);
    const mix = new Float32Array(n);
    for (let i = 0; i < n; i++) mix[i] = 0.5 * (enB[i] ?? 0) + 0.5 * (ja[i] ?? 0);
    const cTail = ja.subarray(n);
    const seq = new Float32Array(enA.length + gap.length + zh.length + gap.length + mix.length + cTail.length + gap.length + enB.length);
    let off = 0;
    for (const part of [enA, gap, zh, gap, mix, cTail, gap, enB]) {
      seq.set(part, off);
      off += part.length;
    }
    const finals = await recognise(seq, { diarize: true, overlap: 'mark' });
    const en_ = finals.filter((t) => t.language === 'en' && !t.overlap);
    const zh_ = finals.filter((t) => t.language === 'zh' && !t.overlap);
    expect(en_.length, JSON.stringify(finals)).toBeGreaterThanOrEqual(2);
    // Every English final (before and after the overlap) carries the same letter, and it is not B's.
    const enLabels = new Set(en_.map((t) => t.speaker));
    expect(enLabels.size, JSON.stringify(finals)).toBe(1);
    expect(zh_[0]?.speaker, JSON.stringify(finals)).toBeDefined();
    expect(enLabels.has(zh_[0]?.speaker)).toBe(false);
  }, 180_000);

  it('still recognises clean English with the denoiser in front', async () => {
    const finals = await recognise(wav('en.wav'), { denoise: true });
    const text = finals.map((t) => t.text).join(' ').toLowerCase();
    expect(text, JSON.stringify(finals)).toMatch(/tribal|chieftain|boy/);
  }, 120_000);

  it('the stronger DPDFNet denoiser can be selected per session and is reported back', async () => {
    const factory = createSherpaFactory({ modelsDir, numThreads: 2, log });
    await factory.prepare();
    const adapter = factory.create();
    const started = await adapter.start({ sessionId: 'voices-dpdf', sourceLanguage: 'auto', denoise: true, denoiser: 'dpdfnet2' });
    expect(started).toMatchObject({ denoise: true, denoiser: 'dpdfnet2' });
    await adapter.stop();
  }, 120_000);
});
