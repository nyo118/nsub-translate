#!/usr/bin/env node
// Pins the exact model files by SHA-256. `--write` records the current files; default verifies.
//   node scripts/models-lock.mjs           # verify packages/server/models against models.lock.json
//   node scripts/models-lock.mjs --write   # (maintainer) regenerate the lock from the files on disk
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = process.env.MODELS_DIR ? path.resolve(process.env.MODELS_DIR) : path.join(root, 'packages/server/models');
const lockFile = path.join(root, 'models.lock.json');
const FILES = [
  'silero_vad.onnx',
  'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/model.int8.onnx',
  'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/tokens.txt',
  'Hy-MT2-1.8B-Q4_K_M.gguf',
];

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

const write = process.argv.includes('--write');
const entries = {};
let failed = 0;
for (const rel of FILES) {
  const file = path.join(modelsDir, rel);
  if (!existsSync(file)) {
    console.error(`✗ missing: ${rel}`);
    failed++;
    continue;
  }
  const hash = await sha256(file);
  entries[rel] = { sha256: hash };
  if (!write) {
    const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
    const expected = lock.files?.[rel]?.sha256;
    if (expected === hash) console.log(`✓ ${rel}`);
    else {
      console.error(`✗ checksum mismatch: ${rel}\n    expected ${expected}\n    actual   ${hash}`);
      failed++;
    }
  } else console.log(`${hash}  ${rel}`);
}
if (write) {
  writeFileSync(lockFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), files: entries }, null, 2)}\n`);
  console.log(`\nwrote ${lockFile}`);
}
if (failed) {
  console.error(`\n${failed} problem(s). Re-download with: npm run models:download`);
  process.exit(1);
}
