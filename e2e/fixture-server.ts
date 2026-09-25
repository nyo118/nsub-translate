import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Serves the YouTube-lookalike fixture page and a silent WAV. Playwright maps
 * www.youtube.com to 127.0.0.1 with --host-resolver-rules, so the extension's
 * content script (matches *://*.youtube.com/*) is injected into the fixture.
 * youtube.com is HSTS-preloaded, so the server must speak HTTPS: a throwaway
 * self-signed certificate is generated with openssl and Chromium is told to
 * ignore certificate errors.
 */

async function selfSignedCert(): Promise<{ key: Buffer; cert: Buffer }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lst-fixture-cert-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=www.youtube.com', '-addext', 'subjectAltName=DNS:www.youtube.com'], { stdio: 'ignore' });
  return { key: await readFile(key), cert: await readFile(cert) };
}
export interface FixtureServer {
  port: number;
  close(): Promise<void>;
}

/** 8 kHz, 8-bit, mono, silent: `seconds` long (60 s ≈ 480 KB). */
export function silentWav(seconds: number): Buffer {
  const rate = 8000;
  const dataLen = rate * seconds;
  const buf = Buffer.alloc(44 + dataLen, 0x80); // 0x80 = silence for unsigned 8-bit
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28); // byte rate
  buf.writeUInt16LE(1, 32); // block align
  buf.writeUInt16LE(8, 34); // bits
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const html = await readFile(fileURLToPath(new URL('./fixtures/youtube-watch.html', import.meta.url)));
  const wav = silentWav(600);
  const server = https.createServer(await selfSignedCert(), (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/silence.wav') {
      // Range support so the media element can seek.
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : wav.length - 1;
        res.writeHead(206, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${wav.length}`, 'content-length': end - start + 1 });
        res.end(wav.subarray(start, end + 1));
      } else {
        res.writeHead(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': wav.length });
        res.end(wav);
      }
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
