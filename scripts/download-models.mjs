#!/usr/bin/env node
// Downloads every model file listed in models.lock.json into packages/server/models and verifies
// SHA-256. Idempotent: present + matching files are skipped. The backend does the same
// automatically at startup (AUTO_DOWNLOAD_MODELS=1, default); this script is for pre-fetching.
//   node scripts/download-models.mjs [--group asr|translation]
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = process.env.MODELS_DIR ? path.resolve(process.env.MODELS_DIR) : path.join(root, 'packages/server/models');
const lock = JSON.parse(readFileSync(path.join(root, 'models.lock.json'), 'utf8'));
const groupArg = process.argv.indexOf('--group');
const group = groupArg >= 0 ? process.argv[groupArg + 1] : null;
mkdirSync(modelsDir, { recursive: true });

const sha256 = (file) => new Promise((resolve, reject) => { const h = createHash('sha256'); createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject); });
const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${Math.round(n / 1e3)} KB`);

async function download(url, dest, label) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${label}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0, lastPct = -1;
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const counter = new TransformStream({ transform(chunk, ctrl) { received += chunk.length; if (total) { const pct = Math.floor((received / total) * 100); if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; process.stdout.write(`\r  ${label}: ${pct}% of ${fmt(total)}`); } } ctrl.enqueue(chunk); } });
  await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), createWriteStream(tmp));
  renameSync(tmp, dest);
  process.stdout.write(`\r  ${label}: done (${fmt(received)})          \n`);
}

const wanted = Object.entries(lock.files).filter(([, s]) => !group || s.group === group);
const missing = [];
for (const [rel, spec] of wanted) {
  const file = path.join(modelsDir, rel);
  if (existsSync(file) && (await sha256(file)) === spec.sha256) console.log(`✓ ${rel}`);
  else missing.push([rel, spec]);
}
const archives = new Set();
for (const [rel, spec] of missing) {
  if (spec.archive) { archives.add(spec.archive); continue; }
  console.log(`Downloading ${rel} (${spec.sizeBytes ? fmt(spec.sizeBytes) : '?'})…`);
  await download(spec.url, path.join(modelsDir, rel), rel);
}
for (const name of archives) {
  const arch = lock.archives[name];
  const file = path.join(modelsDir, `${name}.${arch.format}`);
  console.log(`Downloading archive ${name} (${arch.sizeBytes ? fmt(arch.sizeBytes) : '?'})…`);
  await download(arch.url, file, `${name}.${arch.format}`);
  const r = spawnSync('tar', ['xjf', file, '-C', modelsDir], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  rmSync(file, { force: true });
}
// Verify everything requested.
let failed = 0;
for (const [rel, spec] of wanted) {
  const file = path.join(modelsDir, rel);
  if (!existsSync(file) || (await sha256(file)) !== spec.sha256) { console.error(`✗ verification failed: ${rel}`); failed++; }
}
if (failed) process.exit(1);
console.log(`\nModels ready in ${modelsDir}`);
