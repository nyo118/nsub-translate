// Downloads the SenseVoice int8 ASR model, the Silero VAD model and the Hy-MT2-1.8B
// translation model (GGUF Q6_K) into packages/server/models.
// Idempotent: existing files are kept. Requires curl and tar (macOS / Linux).
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = process.env.MODELS_DIR ? path.resolve(process.env.MODELS_DIR) : path.join(root, 'packages/server/models');
const BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';
const SENSEVOICE = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n${cmd} ${args.join(' ')} failed`);
    process.exit(r.status ?? 1);
  }
}

mkdirSync(modelsDir, { recursive: true });

const vad = path.join(modelsDir, 'silero_vad.onnx');
if (existsSync(vad)) console.log(`✓ ${vad}`);
else {
  console.log('Downloading Silero VAD (~0.6 MB)…');
  run('curl', ['-L', '--fail', '-o', vad, `${BASE}/silero_vad.onnx`]);
}

const modelFile = path.join(modelsDir, SENSEVOICE, 'model.int8.onnx');
if (existsSync(modelFile)) console.log(`✓ ${modelFile}`);
else {
  const archive = path.join(modelsDir, `${SENSEVOICE}.tar.bz2`);
  console.log('Downloading SenseVoice int8 (~160 MB)…');
  run('curl', ['-L', '--fail', '-o', archive, `${BASE}/${SENSEVOICE}.tar.bz2`]);
  run('tar', ['xjf', archive, '-C', modelsDir]);
  rmSync(archive);
}
const mt = path.join(modelsDir, "Hy-MT2-1.8B-Q6_K.gguf");
if (existsSync(mt)) console.log(`✓ ${mt}`);
else {
  console.log('Downloading Hy-MT2-1.8B Q6_K (~1.5 GB)…');
  run('curl', ['-L', '--fail', '-o', mt, 'https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/main/Hy-MT2-1.8B-Q6_K.gguf']);
}
console.log(`\nModels ready in ${modelsDir}`);
