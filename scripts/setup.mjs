#!/usr/bin/env node
// One-shot local setup for a fresh clone: dependencies → models (+ checksum) → .env → build.
//   node scripts/setup.mjs                # this machine translates locally (Hy-MT2 via node-llama-cpp)
//   node scripts/setup.mjs --lm-studio    # this machine translates through LM Studio / a cloud engine:
//                                         #   skips the node-llama-cpp binary download/build, fetches only
//                                         #   the ASR models and seeds .env with TRANSLATION_PROVIDER=llm
import { appendFileSync, copyFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lmStudio = process.argv.includes('--lm-studio') || process.argv.includes('--no-local-translation');
function run(cmd, args, env = {}) {
  console.log(`\n$ ${Object.entries(env).map(([k, v]) => `${k}=${v} `).join('')}${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
run('node', ['scripts/check-node.mjs']);
// node-llama-cpp is an optional dependency; on an LM Studio machine skip its binary download / source build entirely.
run('npm', ['ci'], lmStudio ? { NODE_LLAMA_CPP_SKIP_DOWNLOAD: 'true' } : {});
run('node', ['scripts/download-models.mjs', '--group', 'asr']);
if (!lmStudio) run('node', ['scripts/download-models.mjs', '--group', 'translation']);
run('node', ['scripts/models-lock.mjs']);
const env = path.join(root, 'packages/server/.env');
if (!existsSync(env)) {
  copyFileSync(path.join(root, 'packages/server/.env.example'), env);
  if (lmStudio) {
    appendFileSync(
      env,
      [
        '',
        '# --- written by `npm run setup -- --lm-studio` ---',
        'TRANSLATION_PROVIDER=llm',
        'LLM_BASE_URL=http://127.0.0.1:1234   # LM Studio server on this machine; bare host → /v1 appended',
        'LLM_API_KEY=                          # LM Studio API token (Developer → Server settings)',
        'LLM_MODEL=                            # model id exactly as LM Studio lists it',
        '# HOST=0.0.0.0                        # uncomment when the extension runs on another machine (trusted network only; no auth)',
        '',
      ].join('\n'),
    );
    console.log(`\ncreated ${env} — fill in LLM_API_KEY and LLM_MODEL (and HOST=0.0.0.0 if the extension runs elsewhere)`);
  } else {
    console.log(`\ncreated ${env} from .env.example — add API keys there if you use cloud engines`);
  }
}
run('npm', ['run', 'build']);
console.log(
  lmStudio
    ? '\nSetup complete (LM Studio mode: no local translation engine). Start with `npm run start:server`; in the popup pick 翻译引擎 → 自定义 LLM.'
    : '\nSetup complete. Start the backend with `npm run start:server`, then load packages/extension/dist in chrome://extensions.',
);
