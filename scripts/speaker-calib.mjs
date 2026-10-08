#!/usr/bin/env node
// Speaker-embedding calibration on public samples (no private data):
//   sr-data (csukuangfj/sr-data: fangjun / leijun / liudehua, 14 clips) + SenseVoice test_wavs (en / ja / ko / zh / yue = 5 more
//   speakers). For each candidate model it reports same-speaker vs different-speaker cosine distributions, EER (overall and per clip
//   length), ms per audio second, and suggested SpeakerRegistry thresholds. `--sim` additionally runs the conversation simulation
//   (random multi-speaker dialogues incl. A→B→A+C overlaps) through the SpeakerRegistry from packages/server/dist.
//   node scripts/speaker-calib.mjs [--models a.onnx,b.onnx] [--sim] [--json out.json]
//   Default: only the shipped CAM++ zh/en model. The other three candidates compared for 0.3.0 (wespeaker_en_voxceleb_resnet34_LM,
//   3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k, nemo_en_titanet_large) are no longer kept locally; to rerun the comparison,
//   download them from the sherpa-onnx "speaker-recongition-models" release into packages/server/models and pass them via --models.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sherpa = createRequire(import.meta.url)(path.join(root, 'node_modules/sherpa-onnx-node'));
const modelsDir = process.env.MODELS_DIR ? path.resolve(process.env.MODELS_DIR) : path.join(root, 'packages/server/models');
const calibDir = path.join(modelsDir, 'calib');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : [])).filter((x) => x.length));
const models = String(args.models ?? '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx').split(',');
const RATE = 16000;

// ---------------------------------------------------------------- data
const SR_DATA = ['enroll/fangjun-sr-1', 'enroll/fangjun-sr-2', 'enroll/fangjun-sr-3', 'enroll/leijun-sr-1', 'enroll/leijun-sr-2', 'enroll/liudehua-sr-1', 'enroll/liudehua-sr-2', 'test/fangjun-test-sr-1', 'test/fangjun-test-sr-2', 'test/leijun-test-sr-1', 'test/leijun-test-sr-2', 'test/leijun-test-sr-3', 'test/liudehua-test-sr-1', 'test/liudehua-test-sr-2'];
async function ensureData() {
  mkdirSync(calibDir, { recursive: true });
  for (const rel of SR_DATA) {
    const file = path.join(calibDir, `${path.basename(rel)}.wav`);
    if (existsSync(file)) continue;
    const res = await fetch(`https://raw.githubusercontent.com/csukuangfj/sr-data/main/${rel}.wav`);
    if (!res.ok) throw new Error(`download failed: ${rel}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
}
function resampleTo16k(samples, rate) {
  if (rate === RATE) return samples;
  const out = new Float32Array(Math.round((samples.length * RATE) / rate));
  for (let i = 0; i < out.length; i++) {
    const x = (i * rate) / RATE;
    const a = Math.floor(x);
    const b = Math.min(samples.length - 1, a + 1);
    out[i] = samples[a] * (1 - (x - a)) + samples[b] * (x - a);
  }
  return out;
}
function trim(w) {
  let a = 0, b = w.length;
  while (a < b && Math.abs(w[a]) < 0.005) a++;
  while (b > a && Math.abs(w[b - 1]) < 0.005) b--;
  return w.subarray(a, b);
}
/** {speaker, file, samples} for every source clip. */
function loadClips() {
  const clips = [];
  for (const f of readdirSync(calibDir).filter((f) => f.endsWith('.wav'))) {
    const w = sherpa.readWave(path.join(calibDir, f));
    clips.push({ speaker: f.split('-')[0], file: f, samples: trim(resampleTo16k(w.samples, w.sampleRate)) });
  }
  const tw = path.join(modelsDir, 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/test_wavs');
  for (const f of ['en', 'ja', 'ko', 'zh', 'yue']) {
    const w = sherpa.readWave(path.join(tw, `${f}.wav`));
    clips.push({ speaker: `tw-${f}`, file: `${f}.wav`, samples: trim(resampleTo16k(w.samples, w.sampleRate)) });
  }
  return clips;
}
// Degradations: synthetic music bed (as in bench.mjs), ±10 % speed.
function withMusic(speech, db, seed = 1) {
  const out = new Float32Array(speech.length);
  const gain = Math.pow(10, db / 20);
  const chords = [[220, 277, 330], [196, 247, 294], [174, 220, 262]];
  let n1 = 0, s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const chord = chords[Math.floor(t / 2) % chords.length];
    let m = 0;
    for (const f of chord) m += Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * 2 * f * t);
    n1 = 0.98 * n1 + 0.02 * rnd();
    out[i] = speech[i] + gain * (m / 4 + n1 * 2);
  }
  return out;
}
function speed(samples, factor) {
  return resampleTo16k(samples, Math.round(RATE * factor));
}
/** Split into items of the requested length (seconds); 'full' = whole clip. */
function chunks(samples, sec) {
  if (sec === 'full') return [samples];
  const n = Math.round(sec * RATE);
  const out = [];
  for (let i = 0; i + n <= samples.length; i += n) out.push(samples.subarray(i, i + n));
  return out;
}

// ---------------------------------------------------------------- embeddings
export function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / Math.sqrt(na * nb);
}
const pct = (arr, p) => { if (!arr.length) return NaN; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]; };
function eer(same, diff) {
  // Sweep thresholds; EER where false-reject rate (same below t) == false-accept rate (diff above t).
  let best = { eer: 1, t: 0 };
  for (let t = -0.2; t <= 1; t += 0.005) {
    const frr = same.filter((x) => x < t).length / same.length;
    const far = diff.filter((x) => x >= t).length / diff.length;
    const e = Math.max(frr, far);
    if (Math.abs(frr - far) < 0.02 && e < best.eer) best = { eer: (frr + far) / 2, t: +t.toFixed(3) };
  }
  return best;
}

async function calibrate(modelFile, clips) {
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: path.join(modelsDir, modelFile), numThreads: 2, provider: 'cpu', debug: 0 });
  let audioSec = 0, embedMs = 0;
  const embed = (samples) => {
    const t = Date.now();
    const st = extractor.createStream();
    st.acceptWaveform({ samples, sampleRate: RATE });
    const v = extractor.compute(st);
    embedMs += Date.now() - t;
    audioSec += samples.length / RATE;
    return v;
  };
  // items: {speaker, file, variant, dur, v}
  const items = [];
  for (const c of clips) {
    const variants = [['clean', c.samples], ['bgm', withMusic(c.samples, -12)], ['fast', speed(c.samples, 1.1)], ['slow', speed(c.samples, 0.9)]];
    for (const [variant, s] of variants) {
      for (const dur of [1, 2, 4, 'full']) {
        if (variant !== 'clean' && dur !== 'full' && dur !== 2) continue; // keep the matrix small
        for (const ch of chunks(s, dur)) items.push({ speaker: c.speaker, file: c.file, variant, dur, v: embed(ch) });
      }
    }
  }
  // Pairs: cross-file same speaker (honest), same-file same speaker (easy), different speaker.
  const same = [], sameFile = [], diff = [];
  const byDur = {};
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const s = cosine(a.v, b.v);
      const key = `${a.dur}/${b.dur}`;
      if (a.speaker === b.speaker) {
        if (a.file === b.file) sameFile.push(s);
        else {
          same.push(s);
          if (a.dur === b.dur) (byDur[a.dur] ??= { same: [], diff: [] }).same.push(s);
        }
      } else {
        diff.push(s);
        if (a.dur === b.dur) (byDur[a.dur] ??= { same: [], diff: [] }).diff.push(s);
      }
      void key;
    }
  }
  const overall = eer(same, diff);
  const perDur = Object.fromEntries(Object.entries(byDur).map(([d, x]) => [d, { ...eer(x.same, x.diff), n: x.same.length }]));
  const result = {
    model: modelFile,
    dim: items[0].v.length,
    items: items.length,
    msPerAudioSec: +(embedMs / audioSec).toFixed(1),
    same: { p5: +pct(same, 5).toFixed(3), p50: +pct(same, 50).toFixed(3), n: same.length },
    sameFile: { p5: +pct(sameFile, 5).toFixed(3), p50: +pct(sameFile, 50).toFixed(3) },
    diff: { p50: +pct(diff, 50).toFixed(3), p95: +pct(diff, 95).toFixed(3), p99: +pct(diff, 99).toFixed(3), n: diff.length },
    eer: overall,
    eerByDuration: perDur,
    suggested: { match: overall.t, create: +Math.max(overall.t - 0.05, pct(diff, 99)).toFixed(3), weak: +pct(diff, 95).toFixed(3) },
  };
  return { result, items };
}

await ensureData();
const clips = loadClips();
console.error(`clips: ${clips.length} from ${new Set(clips.map((c) => c.speaker)).size} speakers`);
const results = [];
const embeddingsByModel = {};
for (const m of models) {
  if (!existsSync(path.join(modelsDir, m))) { console.error(`skip ${m} (not downloaded)`); continue; }
  console.error(`calibrating ${m} …`);
  const { result, items } = await calibrate(m, clips);
  results.push(result);
  embeddingsByModel[m] = items;
  console.log(JSON.stringify(result, null, 1));
}

// ---------------------------------------------------------------- conversation simulation
if (args.sim) {
  const { SpeakerRegistry } = await import(path.join(root, 'packages/server/dist/asr/speaker-split.js'));
  const sims = [];
  for (const m of Object.keys(embeddingsByModel)) {
    // Use 2 s clean chunks + full clips as "turns"; a turn = (speaker, embedding, seconds).
    const pool = embeddingsByModel[m].filter((it) => it.variant === 'clean' && (it.dur === 2 || it.dur === 4 || it.dur === 'full'));
    const speakers = [...new Set(pool.map((it) => it.speaker))];
    let s = 7;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    let purityNum = 0, purityDen = 0, fragSum = 0, fragN = 0, abacPass = 0, abacTotal = 0;
    for (let round = 0; round < 30; round++) {
      const cast = [...speakers].sort(() => rnd() - 0.5).slice(0, 4 + Math.floor(rnd() * 3));
      const reg = new SpeakerRegistry();
      const labelsOf = {}; // true speaker → {label: count}
      const turns = [];
      for (let t = 0; t < 40; t++) turns.push(pick(cast));
      // Force the user's scenario at a few points: A, B, then A again (its label must survive).
      const trace = [];
      for (const sp of turns) {
        const it = pick(pool.filter((p) => p.speaker === sp));
        const dur = it.dur === 'full' ? 5 : it.dur;
        const label = reg.label(it.v, { seconds: dur });
        trace.push([sp, label]);
        if (label !== undefined) (labelsOf[sp] ??= {})[label] = ((labelsOf[sp] ??= {})[label] ?? 0) + 1;
      }
      for (const sp of Object.keys(labelsOf)) {
        const counts = Object.values(labelsOf[sp]);
        const total = counts.reduce((a, b) => a + b, 0);
        purityNum += Math.max(...counts); purityDen += total;
        fragSum += counts.filter((c) => c >= 2).length || 1; fragN += 1;
      }
      // A→B→A: for every i where trace[i].sp === trace[i+2].sp !== trace[i+1].sp, labels must match.
      for (let i = 0; i + 2 < trace.length; i++) {
        if (trace[i][0] === trace[i + 2][0] && trace[i][0] !== trace[i + 1][0]) { abacTotal++; if (trace[i][1] === trace[i + 2][1]) abacPass++; }
      }
    }
    const sim = { model: m, purity: +(purityNum / purityDen).toFixed(3), labelsPerSpeaker: +(fragSum / fragN).toFixed(2), abaKeepsLabel: +(abacPass / abacTotal).toFixed(3) };
    sims.push(sim);
    console.log('sim', JSON.stringify(sim));
  }
  if (args.json) writeFileSync(String(args.json), JSON.stringify({ results, sims }, null, 2));
} else if (args.json) writeFileSync(String(args.json), JSON.stringify({ results }, null, 2));
