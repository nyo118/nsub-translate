#!/usr/bin/env node
// Standard benchmark: streams a fixed multilingual clip (the SenseVoice test WAVs, back to back)
// through a running backend in real time and reports latency percentiles, translation coverage and
// the backend process's CPU/RSS. Usage:
//   node scripts/bench.mjs [--port 8787] [--minutes 3] [--engine hy-mt2] [--partials]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : [])).filter((x) => x.length));
const port = Number(args.port ?? 8787);
const minutes = Number(args.minutes ?? 3);
const engine = String(args.engine ?? 'hy-mt2');
const partials = args.partials === true;
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
// Natural pauses between sentences (0.6 s) so segmentation resembles speech, not a wall of sound.
const gap = new Float32Array(16000 * 0.6);
const total = parts.reduce((n, p) => n + p.length + gap.length, 0);
const clip = new Int16Array(total);
let off = 0;
for (const p of parts) { for (let i = 0; i < p.length; i++) clip[off + i] = Math.round(p[i] * 32767); off += p.length + gap.length; }

const t0 = Date.now();
const finalsAt = new Map(); // segmentId → wall time of first final
const stats = { finals: 0, translated: 0, partials: 0, errors: 0, metrics: [], translateDelays: [] };
const samples = [];
function pid() { try { return execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`).toString().trim().split('\n')[0]; } catch { return null; } }
const serverPid = pid();
function sample() { if (!serverPid) return; try { const [rss, cpu] = execSync(`ps -o rss=,pcpu= -p ${serverPid}`).toString().trim().split(/\s+/); samples.push({ t: Math.round((Date.now() - t0) / 1000), rssMB: Math.round(Number(rss) / 1024), cpu: Number(cpu) }); } catch { /* process gone */ } }
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
ws.binaryType = 'arraybuffer';
ws.onopen = () => ws.send(JSON.stringify({ type: 'session.start', protocolVersion: 5, sourceLanguage: 'auto', targetLanguage: 'zh-CN', audio: { encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 }, options: { translatePartials: partials, translationProvider: engine } }));
let sid = null, pos = 0;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === 'session.ready') { sid = m.sessionId; console.error(`ready: asr=${m.asr.provider} translation=${m.translation.provider}; streaming ${minutes} min…`); sample(); pump(); }
  else if (m.type === 'transcript') {
    if (m.status === 'partial') stats.partials++;
    else if (m.translatedText) { stats.translated++; const t = finalsAt.get(m.segmentId); if (t) stats.translateDelays.push(Date.now() - t); }
    else if (!finalsAt.has(m.segmentId)) { stats.finals++; finalsAt.set(m.segmentId, Date.now()); }
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
    engine, partials, minutes: +((Date.now() - t0) / 60000).toFixed(1),
    audioSeconds: last.audioSeconds, finals: stats.finals, translated: stats.translated, coverage: stats.finals ? +(stats.translated / stats.finals).toFixed(2) : 0,
    asrLatencyMs: { avg: last.avgLatencyMs, p95: last.asrLatencyP95Ms }, asrDecodeMsAvg: last.avgDecodeMs,
    translateMs: { avg: last.avgTranslateMs, p95: last.translateP95Ms }, finalToTranslationMs: { p50: pct(stats.translateDelays, 50), p95: pct(stats.translateDelays, 95) },
    errors: stats.errors,
    backend: { pid: serverPid, rssMB: { first: samples[0]?.rssMB, max: Math.max(...samples.map((s) => s.rssMB)), last: samples.at(-1)?.rssMB }, cpuAvg: +(samples.slice(1).reduce((a, s) => a + s.cpu, 0) / Math.max(1, samples.length - 1)).toFixed(0) },
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}
