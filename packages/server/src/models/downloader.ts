import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { ModelLock } from './model-lock.js';

export interface DownloadProgress {
  /** File or archive being fetched (relative name). */
  item: string;
  receivedBytes: number;
  totalBytes: number | null;
}

export interface EnsureOptions {
  modelsDir: string;
  lock: ModelLock;
  /** Only these files (relative names); default: all. */
  files?: string[];
  onProgress?: (p: DownloadProgress) => void;
  log?: { info: (o: Record<string, unknown>, m: string) => void; warn: (o: Record<string, unknown>, m: string) => void };
  fetchImpl?: typeof fetch;
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Missing or checksum-mismatching files among `files`. */
export async function missingFiles(modelsDir: string, lock: ModelLock, files: string[] = Object.keys(lock.files)): Promise<string[]> {
  const out: string[] = [];
  for (const rel of files) {
    const spec = lock.files[rel];
    if (spec === undefined) throw new Error(`unknown model file ${rel}`);
    const file = path.join(modelsDir, rel);
    if (!existsSync(file)) {
      out.push(rel);
      continue;
    }
    if ((await sha256File(file)) !== spec.sha256) out.push(rel);
  }
  return out;
}

async function downloadTo(url: string, dest: string, item: string, options: EnsureOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok || res.body === null) throw new Error(`download failed: HTTP ${res.status} for ${item}`);
  const total = Number(res.headers.get('content-length')) || null;
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  let received = 0;
  const counter = new TransformStreamCounter((n) => {
    received += n;
    options.onProgress?.({ item, receivedBytes: received, totalBytes: total });
  });
  await pipeline(Readable.fromWeb(res.body as never), counter, createWriteStream(tmp));
  await rename(tmp, dest);
}

/** Tiny pass-through Transform that reports bytes seen. */
import { Transform } from 'node:stream';
class TransformStreamCounter extends Transform {
  constructor(private readonly onBytes: (n: number) => void) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
    this.onBytes(chunk.length);
    cb(null, chunk);
  }
}

function extractTarBz2(archive: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('tar', ['xjf', archive, '-C', dir], { stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`))));
  });
}

/**
 * Download whatever is missing (or corrupt) among `files`, verify every
 * downloaded file's SHA-256, and throw with an actionable message on failure.
 * Archives are fetched once even if several files come from them.
 */
export async function ensureModels(options: EnsureOptions): Promise<{ downloaded: string[] }> {
  const { modelsDir, lock } = options;
  const wanted = options.files ?? Object.keys(lock.files);
  const missing = await missingFiles(modelsDir, lock, wanted);
  if (missing.length === 0) return { downloaded: [] };
  await mkdir(modelsDir, { recursive: true });
  const archivesNeeded = new Set<string>();
  for (const rel of missing) {
    const spec = lock.files[rel]!;
    if (spec.archive !== undefined) {
      archivesNeeded.add(spec.archive);
      continue;
    }
    if (spec.url === undefined) throw new Error(`models.lock.json: ${rel} has neither url nor archive`);
    options.log?.info({ file: rel, url: spec.url, sizeBytes: spec.sizeBytes }, 'downloading model file');
    await downloadTo(spec.url, path.join(modelsDir, rel), rel, options);
  }
  for (const name of archivesNeeded) {
    const arch = lock.archives[name];
    if (arch === undefined) throw new Error(`models.lock.json: unknown archive ${name}`);
    const archiveFile = path.join(modelsDir, `${name}.${arch.format}`);
    options.log?.info({ archive: name, url: arch.url, sizeBytes: arch.sizeBytes }, 'downloading model archive');
    await downloadTo(arch.url, archiveFile, `${name}.${arch.format}`, options);
    await extractTarBz2(archiveFile, modelsDir);
    await rm(archiveFile, { force: true });
  }
  // Verify everything we were asked for.
  const still = await missingFiles(modelsDir, lock, wanted);
  if (still.length > 0) {
    for (const rel of still) await rm(path.join(modelsDir, rel), { force: true }).catch(() => undefined);
    throw new Error(`model download verification failed for: ${still.join(', ')} (checksum mismatch or missing after extraction). Files were removed; retry or check your network.`);
  }
  for (const rel of missing) {
    const size = (await stat(path.join(modelsDir, rel))).size;
    options.log?.info({ file: rel, sizeBytes: size }, 'model file ready');
  }
  return { downloaded: missing };
}
