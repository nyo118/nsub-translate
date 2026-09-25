#!/usr/bin/env node
// Sets the same version in the root, every workspace package and the extension manifest.
//   node scripts/set-version.mjs 0.1.0
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error('usage: node scripts/set-version.mjs <semver>');
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['package.json', 'packages/protocol/package.json', 'packages/server/package.json', 'packages/extension/package.json', 'packages/extension/public/manifest.json'];
for (const rel of files) {
  const file = path.join(root, rel);
  const json = JSON.parse(readFileSync(file, 'utf8'));
  json.version = version;
  // Workspace dependency pins must follow the version.
  for (const key of ['dependencies', 'devDependencies']) {
    for (const dep of Object.keys(json[key] ?? {})) if (dep.startsWith('@lst/')) json[key][dep] = version;
  }
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${rel} → ${version}`);
}
