import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * One line per finished session, appended to logs/sessions.jsonl. Contains
 * counts and latency statistics only — never subtitle text. Used to track
 * quality convergence across the beta.
 */
export interface SessionSummary {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  reason: string;
  sourceLanguage: string;
  targetLanguage: string;
  asrProvider: string;
  asrLanguage: string;
  translationProvider: string;
  translatePartials: boolean;
  audioSeconds: number;
  partials: number;
  finals: number;
  translated: number;
  translationCoverage: number;
  asrDecodeP50Ms: number;
  asrLatencyP50Ms: number;
  asrLatencyP95Ms: number;
  translateP50Ms: number;
  translateP95Ms: number;
  translationFailures: number;
  errors: string[];
}

export class SessionLog {
  private readonly recent: SessionSummary[] = [];
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string | null,
    private readonly keepRecent = 10,
    private readonly log: { warn: (o: Record<string, unknown>, m: string) => void } = { warn: () => {} },
  ) {}

  get recentSessions(): SessionSummary[] {
    return [...this.recent];
  }

  record(summary: SessionSummary): void {
    this.recent.push(summary);
    if (this.recent.length > this.keepRecent) this.recent.shift();
    if (this.dir === null) return;
    const dir = this.dir;
    const file = path.join(dir, 'sessions.jsonl');
    this.writing = this.writing
      .then(async () => {
        await mkdir(dir, { recursive: true });
        await appendFile(file, `${JSON.stringify(summary)}\n`, 'utf8');
      })
      .catch((err: unknown) => this.log.warn({ err: err instanceof Error ? err.message : String(err), file }, 'could not write session summary'));
  }

  /** Resolves when pending writes are flushed (tests / shutdown). */
  flush(): Promise<void> {
    return this.writing;
  }
}
