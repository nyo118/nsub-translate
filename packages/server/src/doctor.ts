import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { diagnoseSherpa } from './asr/sherpa-diagnose.js';
import { SherpaWorkerHost } from './asr/sherpa-adapter.js';
import { HYMT2_MODEL_FILE } from './translation/hymt2-adapter.js';

/**
 * `npm run doctor` — prints everything needed to debug an install: Node,
 * platform, native ASR module, model files, .env presence. No secrets.
 */
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
const mt = path.join(config.modelsDir, HYMT2_MODEL_FILE);
lines.push(`${ok(existsSync(mt))} local translation model ${HYMT2_MODEL_FILE}${existsSync(mt) ? '' : ' — downloaded on first use of the hy-mt2 engine'}`);
let llama = false;
try {
  await import('node-llama-cpp');
  llama = true;
} catch {
  llama = false;
}
lines.push(`${ok(llama)} node-llama-cpp native module${llama ? '' : ' — run: npm ci (root)'}`);
const envFile = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '.env');
lines.push(`${ok(existsSync(envFile))} packages/server/.env ${existsSync(envFile) ? '(present)' : '(absent — copy .env.example if you use cloud engines)'}`);
lines.push(`   engines: default=${config.translationProvider}, gemini key ${ok(!!config.geminiApiKey)}, llm ${ok(!!(config.llmBaseUrl && config.llmModel))}, google key ${ok(!!config.googleTranslateApiKey)}`);
console.log(lines.join('\n'));
process.exit(native.ok && nodeOk ? 0 : 1);
