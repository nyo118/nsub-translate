#!/usr/bin/env node
// One-shot local setup for a fresh clone: dependencies → models (+ checksum) → .env → build.
import { copyFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
run('node', ['scripts/check-node.mjs']);
run('npm', ['ci']);
run('node', ['scripts/download-models.mjs']);
run('node', ['scripts/models-lock.mjs']);
const env = path.join(root, 'packages/server/.env');
if (!existsSync(env)) {
  copyFileSync(path.join(root, 'packages/server/.env.example'), env);
  console.log(`\ncreated ${env} from .env.example — add API keys there if you use cloud engines`);
}
run('npm', ['run', 'build']);
console.log('\nSetup complete. Start the backend with `npm run start:server`, then load packages/extension/dist in chrome://extensions.');
