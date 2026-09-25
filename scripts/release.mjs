#!/usr/bin/env node
// Reproducible release: checks → clean build → zips + SHA256SUMS in release/ → optional git tag.
//   node scripts/release.mjs            # build artifacts for the current version
//   node scripts/release.mjs --tag      # also create an annotated git tag v<version>
//   node scripts/release.mjs --skip-checks
import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(root, 'packages/extension/public/manifest.json'), 'utf8'));
const version = pkg.version;
if (manifest.version !== version) {
  console.error(`version mismatch: package.json ${version} vs manifest.json ${manifest.version} — run: node scripts/set-version.mjs ${version}`);
  process.exit(1);
}
const args = new Set(process.argv.slice(2));
function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const dirty = execSync('git status --porcelain', { cwd: root }).toString().trim();
if (dirty && !args.has('--allow-dirty')) {
  console.error('working tree is not clean; commit first (or pass --allow-dirty)');
  process.exit(1);
}
if (!args.has('--skip-checks')) {
  run('npm', ['run', 'lint']);
  run('npm', ['run', 'typecheck']);
  run('npm', ['test']);
}
// Clean build from the lockfile-pinned dependency tree.
rmSync(path.join(root, 'packages/extension/dist'), { recursive: true, force: true });
rmSync(path.join(root, 'packages/server/dist'), { recursive: true, force: true });
rmSync(path.join(root, 'packages/protocol/dist'), { recursive: true, force: true });
run('npm', ['run', 'build']);

const out = path.join(root, 'release', `v${version}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
const built = new Date().toISOString();
writeFileSync(path.join(root, 'packages/extension/dist/BUILD.txt'), `nsub-translate extension v${version}\ncommit ${commit}\nbuilt ${built}\n`);

// Extension: the unpacked directory Chrome loads.
const extZip = `nsub-translate-extension-v${version}.zip`;
run('zip', ['-qr', '-X', path.join(out, extZip), '.'], { cwd: path.join(root, 'packages/extension/dist') });

// Server: dist + what it needs to run from a plain `node dist/index.js` after `npm ci --omit=dev`.
const serverStage = path.join(out, 'server-stage');
mkdirSync(path.join(serverStage, 'packages/server'), { recursive: true });
mkdirSync(path.join(serverStage, 'packages/protocol'), { recursive: true });
mkdirSync(path.join(serverStage, 'scripts'), { recursive: true });
execSync(`cp -R "${path.join(root, 'packages/server/dist')}" "${path.join(serverStage, 'packages/server/dist')}"`);
execSync(`cp -R "${path.join(root, 'packages/protocol/dist')}" "${path.join(serverStage, 'packages/protocol/dist')}"`);
for (const f of ['packages/server/package.json', 'packages/server/.env.example', 'packages/protocol/package.json', 'package.json', 'package-lock.json', 'models.lock.json', '.nvmrc', 'scripts/check-node.mjs', 'scripts/download-models.mjs', 'scripts/models-lock.mjs', 'scripts/service.mjs']) {
  execSync(`cp "${path.join(root, f)}" "${path.join(serverStage, f)}"`);
}
writeFileSync(path.join(serverStage, 'BUILD.txt'), `nsub-translate server v${version}\ncommit ${commit}\nbuilt ${built}\nrun: nvm use && npm ci --omit=dev && npm run models:download && node packages/server/dist/index.js\n`);
const srvZip = `nsub-translate-server-v${version}.zip`;
run('zip', ['-qr', '-X', path.join(out, srvZip), '.'], { cwd: serverStage });
rmSync(serverStage, { recursive: true, force: true });

// Checksums.
const sums = readdirSync(out)
  .filter((f) => f.endsWith('.zip'))
  .map((f) => `${createHash('sha256').update(readFileSync(path.join(out, f))).digest('hex')}  ${f}`)
  .join('\n');
writeFileSync(path.join(out, 'SHA256SUMS.txt'), `${sums}\n`);
console.log(`\nrelease artifacts in ${out}:`);
for (const f of readdirSync(out)) console.log(`  ${f}  (${Math.round(statSync(path.join(out, f)).size / 1024)} KB)`);
console.log(`\n${sums}`);

if (args.has('--tag')) {
  run('git', ['tag', '-a', `v${version}`, '-m', `nsub-translate v${version}`]);
  console.log(`\ntagged v${version}. Push with: git push origin v${version}`);
}
