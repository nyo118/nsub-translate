import { buildScriptEvents } from '../mock-script.js';
import type { AsrAdapter, AsrAdapterEvents, AsrAdapterFactory, AsrStartOptions } from './types.js';

/**
 * Replays the deterministic Phase 0 script on a timer, ignoring audio.
 * Used by tests and by `ASR_PROVIDER=mock` (no model download needed).
 */
export class MockAsrAdapter implements AsrAdapter {
  readonly provider = 'mock';
  private readonly handlers: { [K in keyof AsrAdapterEvents]: AsrAdapterEvents[K][] } = { transcript: [], metrics: [], error: [] };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cursor = 0;
  private loopCount = 0;
  private readonly events = buildScriptEvents();
  private running = false;

  constructor(private readonly tickMs: number) {}

  on<K extends keyof AsrAdapterEvents>(event: K, listener: AsrAdapterEvents[K]): void {
    this.handlers[event].push(listener);
  }

  async start(options: AsrStartOptions): Promise<{ language: string }> {
    this.running = true;
    this.schedule();
    return { language: options.sourceLanguage };
  }

  pushAudio(): void {
    /* audio is ignored by the mock */
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.timer = setTimeout(() => this.tick(), this.tickMs);
  }

  private tick(): void {
    this.timer = null;
    if (!this.running) return;
    const event = this.events[this.cursor];
    if (event === undefined) {
      this.cursor = 0;
      this.loopCount += 1;
      this.schedule();
      return;
    }
    this.cursor += 1;
    const segmentId = this.loopCount === 0 ? event.segmentId : `${event.segmentId}-r${this.loopCount}`;
    const { type: _type, sourceText, translatedText: _translated, ...rest } = event;
    for (const h of this.handlers.transcript) h({ ...rest, segmentId, text: sourceText });
    for (const h of this.handlers.metrics) h({ decodeMs: 1, latencyMs: this.tickMs, status: event.status });
    if (this.running) this.schedule();
  }
}

export function createMockFactory(tickMs: number): AsrAdapterFactory {
  return { provider: 'mock', prepare: async () => {}, create: () => new MockAsrAdapter(tickMs) };
}
