import type { TranscriptMessage } from '@lst/protocol';
import { buildScriptEvents, type ScriptEvent } from './mock-script.js';

export interface MockSessionOptions {
  sessionId: string;
  sourceLanguage: string;
  targetLanguage: string;
  /** Delay between events, in ms. */
  tickMs: number;
  /** Called for every simulated transcript event. */
  emit: (message: TranscriptMessage) => void;
  /** Optional script override (tests). */
  events?: ScriptEvent[];
  /** Whether to loop the script once it finishes. Defaults to true. */
  loop?: boolean;
}

export type MockSessionState = 'idle' | 'running' | 'stopped';

/**
 * A mock ASR/translation session. It replays a deterministic script on a
 * timer. It owns exactly one timer and guarantees it is cleared on stop so
 * that a stopped session can never emit again.
 */
export class MockSession {
  readonly sessionId: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  private readonly tickMs: number;
  private readonly emit: (message: TranscriptMessage) => void;
  private readonly events: ScriptEvent[];
  private readonly loop: boolean;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cursor = 0;
  private loopCount = 0;
  private _state: MockSessionState = 'idle';

  constructor(options: MockSessionOptions) {
    this.sessionId = options.sessionId;
    this.sourceLanguage = options.sourceLanguage;
    this.targetLanguage = options.targetLanguage;
    this.tickMs = options.tickMs;
    this.emit = options.emit;
    this.events = options.events ?? buildScriptEvents();
    this.loop = options.loop ?? true;
  }

  get state(): MockSessionState {
    return this._state;
  }

  start(): void {
    if (this._state !== 'idle') return;
    this._state = 'running';
    this.schedule();
  }

  stop(): void {
    if (this._state === 'stopped') return;
    this._state = 'stopped';
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    this.timer = setTimeout(() => this.tick(), this.tickMs);
  }

  private tick(): void {
    this.timer = null;
    if (this._state !== 'running') return;
    const event = this.events[this.cursor];
    if (event === undefined) {
      if (!this.loop) {
        this.stop();
        return;
      }
      this.cursor = 0;
      this.loopCount += 1;
      this.schedule();
      return;
    }
    this.cursor += 1;
    // Make looped replays distinguishable: segment ids get a loop suffix so
    // the receiver treats them as new segments rather than stale revisions.
    const segmentId = this.loopCount === 0 ? event.segmentId : `${event.segmentId}-r${this.loopCount}`;
    this.emit({ ...event, segmentId, sessionId: this.sessionId });
    if (this._state === 'running') this.schedule();
  }
}
