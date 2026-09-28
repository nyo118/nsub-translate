#!/usr/bin/env node
// Standard benchmark: streams a fixed multilingual clip (the SenseVoice test WAVs, back to back)
// through a running backend in real time and reports latency percentiles, translation coverage and
// the backend process's CPU/RSS. Usage:
//   node scripts/bench.mjs [--port 8787] [--minutes 3] [--engine hy-mt2] [--partials]
//                          [--clip clean|bgm|duet|mixed|conv] [--denoise] [--denoiser gtcrn|dpdfnet2|dpdfnet4|dpdfnet8] [--diarize] [--overlap mark|skip|recognize] [--show-text]
// Clips (0.2.0 multi-voice benchmark), all built from the bundled test WAVs:
//   clean  en, ja, zh, ko in turn with 0.6 s pauses (the original benchmark)
//   bgm    clean + synthetic "music" (chords + noise, −12 dB) — what game streams sound like
//   duet   en and zh alternating with 0.5 s pauses — two people taking turns
//   mixed  en and zh summed — two people talking at once
//   conv   an 8-speaker conversation from the calibration clips (packages/server/models/calib, see scripts/speaker-calib.mjs):
//          turns of 2–6 s with 0.4 s pauses, including A→B→A and A+C overlaps; --show-text prints the true speaker next to the label
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : [])).filter((x) => x.length));
const port = Number(args.port ?? 8787);
const minutes = Number(args.minutes ?? 3);
const engine = String(args.engine ?? 'hy-mt2');
const partials = args.partials === true;
const clipName = String(args.clip ?? 'clean');
const denoise = args.denoise === true || args.denoiser !== undefined;
const denoiser = args.denoiser === undefined ? undefined : String(args.denoiser);
const diarize = args.diarize === true;
const overlap = String(args.overlap ?? 'mark');
const showText = args['show-text'] === true;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sherpa = createRequire(import.meta.url)(path.join(root, 'node_modules/sherpa-onnx-node'));
const wavDir = path.join(root, 'packages/server/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/test_wavs');
const parts = ['en.wav', 'ja.wav', 'zh.wav', 'ko.wav'].map((f) => {
  const w = sherpa.readWave(path.join(wavDir, f)).samples;
  let a = 0, b = w.length;
  while (a < b && Math.abs(w[a]) < 0.01) a++;
  while (b > a && Math.abs(w[b - 1]) < 0.01) b--;
  return w.subarray(a, b);
});
const [en, , zh] = parts;
function concat(pieces, gapSec) {
  const gap = new Float32Array(Math.round(16000 * gapSec));
  const out = new Float32Array(pieces.reduce((n, p) => n + p.length + gap.length, 0));
  let off = 0;
  for (const p of pieces) { out.set(p, off); off += p.length + gap.length; }
  return out;
}
/** Deterministic "music": three detuned chords cycling every 2 s plus pink-ish noise, mixed at `db` below the speech. */
function withMusic(speech, db) {
  const out = new Float32Array(speech.length);
  const gain = Math.pow(10, db / 20);
  const chords = [[220, 277, 330], [196, 247, 294], [174, 220, 262]];
  let n1 = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / 16000;
    const chord = chords[Math.floor(t / 2) % chords.length];
    let m = 0;
    for (const f of chord) m += Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * 2 * f * t);
    n1 = 0.98 * n1 + 0.02 * (Math.random() * 2 - 1); // low-passed noise
    out[i] = speech[i] + gain * (m / 4 + n1 * 2);
  }
  return out;
}
function mixed(a, b) {
  const n = Math.min(a.length, b.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.5 * a[i] + 0.5 * b[i];
  return out;
}
function conversation() {
  const dir = path.join(root, 'packages/server/models/calib');
  if (!fs.existsSync(dir)) { console.error('conv clip needs the calibration clips: node scripts/speaker-calib.mjs'); process.exit(2); }
  const bySpeaker = {};
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.wav'))) {
    const w = sherpa.readWave(path.join(dir, f));
    if (w.sampleRate !== 16000) continue;
    (bySpeaker[f.split('-')[0]] ??= []).push(w.samples);
  }
  const speakers = Object.keys(bySpeaker).slice(0, 8);
  let s = 42;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const take = (spk, sec) => { const w = bySpeaker[spk][Math.floor(rnd() * bySpeaker[spk].length)]; const n = Math.min(w.length, Math.round(sec * 16000)); const off = Math.floor(rnd() * Math.max(1, w.length - n)); return w.subarray(off, off + n); };
  const pieces = []; const truth = [];
  let t = 0;
  // Script: A B A C B A+C D A B ... (24 turns), overlaps every 6th turn.
  const order = [0, 1, 0, 2, 1, -1, 3, 0, 1, 2, 4, -1, 0, 5, 1, 3, 6, -1, 2, 0, 7, 4, 1, 0];
  for (const idx of order) {
    let piece;
    if (idx === -1) { const a = take(speakers[0], 3), c = take(speakers[2], 3); piece = new Float32Array(Math.min(a.length, c.length)); for (let i = 0; i < piece.length; i++) piece[i] = 0.5 * a[i] + 0.5 * c[i]; truth.push({ t, who: `${speakers[0]}+${speakers[2]}` }); }
    else { piece = take(speakers[idx], 2 + rnd() * 4); truth.push({ t, who: speakers[idx] }); }
    pieces.push(piece); t += piece.length / 16000 + 0.4;
  }
  const out = concat(pieces, 0.4);
  out.truth = truth;
  return out;
}
const clips = {
  clean: () => concat(parts, 0.6),
  bgm: () => withMusic(concat(parts, 0.6), -12),
  duet: () => concat([en, zh, en, zh], 0.5),
  mixed: () => concat([mixed(en, zh)], 0.8),
  conv: conversation,
};
if (!clips[clipName]) { console.error(`unknown --clip ${clipName}`); process.exit(2); }
const f32 = clips[clipName]();
const truth = f32.truth ?? null;
const clipSeconds = f32.length / 16000;
const whoAt = (ms) => { if (!truth) return ''; const t = (ms / 1000) % clipSeconds; let who = ''; for (const x of truth) if (x.t <= t + 0.05) who = x.who; return who; };
const clip = new Int16Array(f32.length);
for (let i = 0; i < f32.length; i++) clip[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));

const t0 = Date.now();
const finalsAt = new Map(); // segmentId → wall time of first final
const stats = { finals: 0, translated: 0, partials: 0, errors: 0, metrics: [], translateDelays: [], speakers: {}, overlaps: 0, texts: [] };
const samples = [];
function pid() { try { return execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`).toString().trim().split('\n')[0]; } catch { return null; } }
const serverPid = pid();
function sample() { if (!serverPid) return; try { const [rss, cpu] = execSync(`ps -o rss=,pcpu= -p ${serverPid}`).toString().trim().split(/\s+/); samples.push({ t: Math.round((Date.now() - t0) / 1000), rssMB: Math.round(Number(rss) / 1024), cpu: Number(cpu) }); } catch { /* process gone */ } }
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
ws.binaryType = 'arraybuffer';
ws.onopen = () => ws.send(JSON.stringify({ type: 'session.start', protocolVersion: 7, sourceLanguage: 'auto', targetLanguage: 'zh-CN', audio: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 }, options: { translatePartials: partials, translationProvider: engine, denoise, ...(denoiser === undefined ? {} : { denoiser }), diarize, overlap } }));
let sid = null, pos = 0;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === 'session.ready') { sid = m.sessionId; console.error(`ready: asr=${m.asr.provider} denoise=${m.asr.denoise ?? false} diarize=${m.asr.diarize ?? false} translation=${m.translation.provider}; clip=${clipName} (${(clip.length / 16000).toFixed(1)} s); streaming ${minutes} min…`); sample(); pump(); }
  else if (m.type === 'transcript') {
    if (m.status === 'partial') stats.partials++;
    else if (m.translatedText) { stats.translated++; const t = finalsAt.get(m.segmentId); if (t) stats.translateDelays.push(Date.now() - t); }
    else if (!finalsAt.has(m.segmentId)) {
      stats.finals++; finalsAt.set(m.segmentId, Date.now());
      if (m.speaker) stats.speakers[m.speaker] = (stats.speakers[m.speaker] ?? 0) + 1;
      if (m.overlap) stats.overlaps++;
      if (truth) { const who = whoAt(m.startMs); if (who) (stats.labelByTruth ??= {})[who] = { ...(stats.labelByTruth?.[who] ?? {}), [m.speaker ?? '-']: ((stats.labelByTruth?.[who] ?? {})[m.speaker ?? '-'] ?? 0) + 1 }; }
      if (showText) { stats.texts.push(`${m.speaker ? m.speaker + ': ' : ''}${m.sourceText}`); console.error(`  ${(m.startMs / 1000).toFixed(1)}s ${m.speaker ? `[${m.speaker}] ` : ''}${truth ? `(${whoAt(m.startMs)}) ` : ''}${m.overlap ? '(overlap) ' : ''}${m.language ?? '?'} ${m.sourceText}`); }
    }
  } else if (m.type === 'session.metrics') stats.metrics.push(m);
  else if (m.type === 'session.error') { stats.errors++; console.error('ERROR', JSON.stringify(m)); }
  else if (m.type === 'session.stopped') finish();
};
ws.onclose = () => finish();
function pump() {
  const iv = setInterval(() => {
    if (Date.now() - t0 >= minutes * 60_000) { clearInterval(iv); ws.send(JSON.stringify({ type: 'session.stop', sessionId: sid })); return; }
    ws.send(clip.slice(pos, pos + 1600).buffer); pos += 1600; if (pos >= clip.length) pos = 0;
  }, 100);
  setInterval(sample, 15_000);
}
let done = false;
function finish() {
  if (done) return; done = true; sample();
  const last = stats.metrics.at(-1) ?? {};
  const out = {
    engine, partials, clip: clipName, denoise, diarize, overlap: diarize ? overlap : undefined, minutes: +((Date.now() - t0) / 60000).toFixed(1),
    speakers: stats.speakers, overlapSegments: stats.overlaps, ...(stats.labelByTruth ? { labelByTruth: stats.labelByTruth } : {}),
    audioSeconds: last.audioSeconds, finals: stats.finals, translated: stats.translated, coverage: stats.finals ? +(stats.translated / stats.finals).toFixed(2) : 0,
    asrLatencyMs: { avg: last.avgLatencyMs, p95: last.asrLatencyP95Ms }, asrDecodeMsAvg: last.avgDecodeMs,
    translateMs: { avg: last.avgTranslateMs, p95: last.translateP95Ms }, finalToTranslationMs: { p50: pct(stats.translateDelays, 50), p95: pct(stats.translateDelays, 95) },
    errors: stats.errors,
    backend: { pid: serverPid, rssMB: { first: samples[0]?.rssMB, max: Math.max(...samples.map((s) => s.rssMB)), last: samples.at(-1)?.rssMB }, cpuAvg: +(samples.slice(1).reduce((a, s) => a + s.cpu, 0) / Math.max(1, samples.length - 1)).toFixed(0) },
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}
