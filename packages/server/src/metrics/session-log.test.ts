import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionLog, type SessionSummary } from './session-log.js';

const summary = (id: string): SessionSummary => ({
  sessionId: id, startedAt: '2026-09-25T00:00:00.000Z', endedAt: '2026-09-25T00:10:00.000Z', durationSec: 600, reason: 'user', sourceLanguage: 'auto', targetLanguage: 'zh-CN',
  asrProvider: 'sensevoice', asrLanguage: 'auto', translationProvider: 'hy-mt2', translatePartials: false, audioSeconds: 590, partials: 40, finals: 20, translated: 18, translationCoverage: 0.9,
  asrDecodeP50Ms: 300, asrLatencyP50Ms: 400, asrLatencyP95Ms: 900, translateP50Ms: 2000, translateP95Ms: 4000, translationFailures: 1, errors: [],
});

describe('SessionLog', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'lst-sessions-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends one JSON line per session and keeps the recent ring', async () => {
    const log = new SessionLog(path.join(dir, 'logs'), 2);
    log.record(summary('a'));
    log.record(summary('b'));
    log.record(summary('c'));
    await log.flush();
    const lines = (await readFile(path.join(dir, 'logs', 'sessions.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]!).sessionId).toBe('c');
    expect(log.recentSessions.map((s) => s.sessionId)).toEqual(['b', 'c']);
    expect(lines.join('')).not.toMatch(/sourceText|translatedText/);
  });

  it('works in memory only when no directory is given', async () => {
    const log = new SessionLog(null);
    log.record(summary('x'));
    await log.flush();
    expect(log.recentSessions).toHaveLength(1);
  });
});
