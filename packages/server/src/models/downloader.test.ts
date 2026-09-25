import http from 'node:http';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureModels, missingFiles } from './downloader.js';
import { ModelManager } from './model-manager.js';
import type { ModelLock } from './model-lock.js';

/** A tiny "model CDN": one direct file and one tar.bz2 archive with two files. */
let server: http.Server;
let base = '';
let lock: ModelLock;
let srcDir: string;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const log = { info: () => {}, warn: () => {} };

beforeAll(async () => {
  srcDir = await mkdtemp(path.join(os.tmpdir(), 'lst-models-src-'));
  const direct = Buffer.from('silero-vad-bytes');
  await mkdir(path.join(srcDir, 'sv'), { recursive: true });
  await writeFile(path.join(srcDir, 'sv', 'model.int8.onnx'), 'model-bytes-123');
  await writeFile(path.join(srcDir, 'sv', 'tokens.txt'), 'a\nb\n');
  execSync('tar cjf sv.tar.bz2 sv', { cwd: srcDir });
  const archive = await readFile(path.join(srcDir, 'sv.tar.bz2'));
  server = http.createServer((req, res) => {
    if (req.url === '/silero.onnx') return res.writeHead(200, { 'content-length': direct.length }).end(direct);
    if (req.url === '/sv.tar.bz2') return res.writeHead(200, { 'content-length': archive.length }).end(archive);
    if (req.url === '/missing.bin') return res.writeHead(404).end();
    res.writeHead(500).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  lock = {
    version: 1,
    archives: { sensevoice: { url: `${base}/sv.tar.bz2`, format: 'tar.bz2' } },
    files: {
      'silero.onnx': { sha256: sha(direct), url: `${base}/silero.onnx`, group: 'asr' },
      'sv/model.int8.onnx': { sha256: sha('model-bytes-123'), archive: 'sensevoice', group: 'asr' },
      'sv/tokens.txt': { sha256: sha('a\nb\n'), archive: 'sensevoice', group: 'asr' },
      'big.gguf': { sha256: sha('nope'), url: `${base}/missing.bin`, group: 'translation' },
    },
  };
});
afterAll(async () => {
  server.close();
  await rm(srcDir, { recursive: true, force: true });
});

describe('ensureModels', () => {
  it('downloads direct files and archives, verifies checksums, and is idempotent', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lst-models-'));
    const asr = ['silero.onnx', 'sv/model.int8.onnx', 'sv/tokens.txt'];
    expect(await missingFiles(dir, lock, asr)).toEqual(asr);
    const progress: string[] = [];
    const r = await ensureModels({ modelsDir: dir, lock, files: asr, log, onProgress: (p) => progress.push(p.item) });
    expect(r.downloaded.sort()).toEqual([...asr].sort());
    expect(await missingFiles(dir, lock, asr)).toEqual([]);
    expect(new Set(progress)).toEqual(new Set(['silero.onnx', 'sensevoice.tar.bz2']));
    // Corrupt one file → detected as missing → re-fetched from the archive.
    await writeFile(path.join(dir, 'sv/tokens.txt'), 'tampered');
    expect(await missingFiles(dir, lock, asr)).toEqual(['sv/tokens.txt']);
    await ensureModels({ modelsDir: dir, lock, files: asr, log });
    expect(await missingFiles(dir, lock, asr)).toEqual([]);
    expect((await ensureModels({ modelsDir: dir, lock, files: asr, log })).downloaded).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it('fails clearly on HTTP errors and leaves no partial file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lst-models-'));
    await expect(ensureModels({ modelsDir: dir, lock, files: ['big.gguf'], log })).rejects.toThrow(/HTTP 404/);
    expect(await missingFiles(dir, lock, ['big.gguf'])).toEqual(['big.gguf']);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('ModelManager', () => {
  it('reports downloading → ready per group and shares concurrent ensures', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lst-models-'));
    const m = new ModelManager({ modelsDir: dir, lock, autoDownload: true, log });
    expect(m.snapshot().asr.status).toBe('unknown');
    const p1 = m.ensure('asr');
    const p2 = m.ensure('asr');
    expect(p1).toBe(p2);
    await p1;
    expect(m.isReady('asr')).toBe(true);
    await expect(m.ensure('translation')).rejects.toThrow(/HTTP 404/);
    expect(m.snapshot().translation.status).toBe('error');
    expect(m.notReadyMessage('translation')).toMatch(/翻译模型准备失败/);
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses to download when auto-download is off', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lst-models-'));
    const m = new ModelManager({ modelsDir: dir, lock, autoDownload: false, log });
    await expect(m.ensure('asr')).rejects.toThrow(/AUTO_DOWNLOAD_MODELS=0/);
    expect(m.snapshot().asr.status).toBe('missing');
    await rm(dir, { recursive: true, force: true });
  });
});
