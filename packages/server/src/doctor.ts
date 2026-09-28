import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { diagnoseSherpa } from './asr/sherpa-diagnose.js';
import { DENOISER_MODEL_FILE, EMBEDDING_MODEL_FILE, SEGMENTATION_MODEL_FILE, SherpaWorkerHost } from './asr/sherpa-adapter.js';
import { importLlama, isLlamaInstalled } from './translation/llama-available.js';
import { HYMT2_MODEL_FILE } from './translation/hymt2-adapter.js';

/**
 * `npm run doctor` — prints everything needed to debug an install: Node,
 * platform, native ASR module, model files, .env presence. No secrets.
 */
// Same .env lookup as index.ts so the engine summary reflects what the backend would see.
for (const candidate of [new URL('../.env', import.meta.url), new URL('../../../.env', import.meta.url)]) {
  try {
    process.loadEnvFile(candidate);
    break;
  } catch {
    /* no .env here */
  }
}
const config = loadConfig();
const lines: string[] = [];
const ok = (b: boolean) => (b ? '✓' : '✗');
lines.push(`node ${process.version} (${process.arch}) on ${os.platform()} ${os.release()} ${os.arch()}, cpus ${os.cpus().length}, mem ${Math.round(os.totalmem() / 1e9)} GB`);
const nodeOk = Number(process.versions.node.split('.')[0]) >= 22;
lines.push(`${ok(nodeOk)} Node >= 22 ${nodeOk ? '' : '— run: nvm use'}`);
const native = diagnoseSherpa(import.meta.url);
lines.push(`${ok(native.ok)} sherpa-onnx native module (${native.platformPackage})`);
if (!native.ok) lines.push(native.message.split('\n').map((l) => `    ${l}`).join('\n'));
const modelsMissing = SherpaWorkerHost.checkModels(config.modelsDir);
lines.push(`${ok(modelsMissing === null)} ASR models in ${config.modelsDir}${modelsMissing === null ? '' : ' — will be downloaded automatically at backend start (or: npm run models:download)'}`);
for (const [label, file, hint] of [
  ['denoiser model (popup: 降噪)', DENOISER_MODEL_FILE, 'downloaded on first use'],
  ['speaker segmentation model (popup: 区分说话人)', SEGMENTATION_MODEL_FILE, 'downloaded on first use'],
  ['speaker embedding model (popup: 区分说话人)', EMBEDDING_MODEL_FILE, 'downloaded on first use'],
] as const) {
  const present = existsSync(path.join(config.modelsDir, file));
  lines.push(`${present ? '✓' : '○'} ${label} ${file}${present ? '' : ` — ${hint}`}`);
}
const mt = path.join(config.modelsDir, HYMT2_MODEL_FILE);
lines.push(`${existsSync(mt) ? '✓' : '○'} local translation model ${HYMT2_MODEL_FILE}${existsSync(mt) ? '' : ' — downloaded on first use of the hy-mt2 engine'}`);
let llama = false;
if (isLlamaInstalled()) {
  try {
    await importLlama();
    llama = true;
  } catch {
    llama = false;
  }
}
// Optional: only a problem when this machine is supposed to translate locally.
if (llama) lines.push(`✓ node-llama-cpp native module (local translation)`);
else if (config.translationProvider === 'hy-mt2') lines.push(`✗ node-llama-cpp not installed but TRANSLATION_PROVIDER=hy-mt2 — run: npm run setup:local-translation (or set TRANSLATION_PROVIDER=llm for LM Studio)`);
else lines.push(`○ node-llama-cpp not installed (optional; not needed with TRANSLATION_PROVIDER=${config.translationProvider}, e.g. LM Studio / Gemini)`);
const envFile = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '.env');
lines.push(`${ok(existsSync(envFile))} packages/server/.env ${existsSync(envFile) ? '(present)' : '(absent — copy .env.example if you use cloud engines)'}`);
lines.push(`   engines: default=${config.translationProvider}, gemini key ${ok(!!config.geminiApiKey)}, llm ${ok(!!(config.llmBaseUrl && config.llmModel))}, google key ${ok(!!config.googleTranslateApiKey)}`);
console.log(lines.join('\n'));
process.exit(native.ok && nodeOk ? 0 : 1);
