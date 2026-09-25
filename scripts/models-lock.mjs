#!/usr/bin/env node
// Verifies packages/server/models against models.lock.json (SHA-256). `--write` refreshes the
// checksums from the files on disk (maintainer use; URLs/archives in the lock are kept).
//   node scripts/models-lock.mjs           # verify
//   node scripts/models-lock.mjs --write   # regenerate sha256 fields
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = process.env.MODELS_DIR ? path.resolve(process.env.MODELS_DIR) : path.join(root, 'packages/server/models');
const lockFile = path.join(root, 'models.lock.json');
const lock = JSON.parse(readFileSync(lockFile, 'utf8'));

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

const write = process.argv.includes('--write');
let failed = 0;
for (const [rel, spec] of Object.entries(lock.files)) {
  const file = path.join(modelsDir, rel);
  if (!existsSync(file)) {
    console.error(`✗ missing: ${rel}`);
    failed++;
    continue;
  }
  const hash = await sha256(file);
  if (write) {
    spec.sha256 = hash;
    console.log(`${hash}  ${rel}`);
  } else if (spec.sha256 === hash) console.log(`✓ ${rel}`);
  else {
    console.error(`✗ checksum mismatch: ${rel}\n    expected ${spec.sha256}\n    actual   ${hash}`);
    failed++;
  }
}
if (write) {
  lock.generatedAt = new Date().toISOString();
  writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`\nwrote ${lockFile}`);
}
if (failed) {
  console.error(`\n${failed} problem(s). Re-download with: npm run models:download`);
  process.exit(1);
}
