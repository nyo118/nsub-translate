import type { AsrInfo, SessionMetricsMessage, TranscriptMessage, TranslationInfo } from '@lst/protocol';
import type { AsrAdapter } from './asr/types.js';
import type { TranslationAdapter } from './translation/types.js';
import { TranslationPipeline } from './translation/pipeline.js';
import { SampleSeries } from './metrics/stats.js';
import type { SessionSummary } from './metrics/session-log.js';

export interface SessionOptions {
  sessionId: string;
  sourceLanguage: string;
  targetLanguage: string;
  adapter: AsrAdapter;
  translation: TranslationAdapter;
  translatePartials?: boolean;
  send: (message: TranscriptMessage | SessionMetricsMessage) => void;
  onError: (code: 'asr_unavailable' | 'asr_failed' | 'translation_failed', message: string) => void;
  log?: { warn: (o: Record<string, unknown>, m: string) => void; info?: (o: Record<string, unknown>, m: string) => void };
  /** Privacy: subtitle text is never logged unless explicitly enabled (LOG_TRANSCRIPTS=1). */
  logTranscripts?: boolean;
  /** Interval for session.metrics messages; 0 disables. */
  metricsIntervalMs?: number;
  now?: () => number;
}

export type SessionState = 'idle' | 'starting' | 'running' | 'stopped';

/**
 * One translation session: owns one ASR adapter and one translation
 * adapter. ASR transcripts flow through the TranslationPipeline, which
 * forwards source text at once and appends translations as later revisions.
 */
export class Session {
  readonly sessionId: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  private readonly adapter: AsrAdapter;
  private readonly translation: TranslationAdapter;
  private readonly pipeline: TranslationPipeline;
  private readonly translateSeries = new SampleSeries();
  private readonly decodeSeries = new SampleSeries();
  private readonly latencySeries = new SampleSeries();
  private readonly errorCodes: string[] = [];
  private translationFailures = 0;
  private startedAtMs = 0;
  private endedAtMs = 0;
  private readonly translatePartials: boolean;
  private readonly send: SessionOptions['send'];
  private readonly onError: SessionOptions['onError'];
  private readonly metricsIntervalMs: number;
  private readonly now: () => number;
  private metricsTimer: ReturnType<typeof setInterval> | null = null;
  private _state: SessionState = 'idle';
  private audioSamples = 0;
  private partials = 0;
  private finals = 0;

  constructor(options: SessionOptions) {
    this.sessionId = options.sessionId;
    this.sourceLanguage = options.sourceLanguage;
    this.targetLanguage = options.targetLanguage;
    this.adapter = options.adapter;
    this.translation = options.translation;
    this.send = options.send;
    this.pipeline = new TranslationPipeline({
      sessionId: options.sessionId,
      targetLanguage: options.targetLanguage,
      adapter: options.translation,
      emit: (m) => {
        if (options.logTranscripts && m.status === 'final') options.log?.info?.({ sessionId: m.sessionId, segmentId: m.segmentId, text: m.sourceText, translated: m.translatedText }, 'final');
        this.send(m);
      },
      onError: (code, message) => this.onError(code, message),
      onMetrics: (s) => this.translateSeries.push(s.translateMs),
      translatePartials: options.translatePartials ?? false,
      contextSize: options.translation.preferredContextSize ?? 2,
      onFailure: (info) => {
        this.translationFailures += 1;
        options.log?.warn({ sessionId: options.sessionId, provider: options.translation.provider, ...info }, 'translation attempt failed');
      },
    });
    this.translatePartials = options.translatePartials ?? false;
    this.onError = options.onError;
    this.metricsIntervalMs = options.metricsIntervalMs ?? 5000;
    this.now = options.now ?? (() => Date.now());
  }

  get state(): SessionState {
    return this._state;
  }

  get asrInfo(): AsrInfo {
    return { provider: this.adapter.provider, language: this.asrLanguage };
  }
  private asrLanguage = 'auto';

  get translationInfo(): TranslationInfo {
    return { provider: this.translation.provider, targetLanguage: this.targetLanguage };
  }

  async start(): Promise<AsrInfo> {
    if (this._state !== 'idle') throw new Error(`cannot start session in state ${this._state}`);
    this._state = 'starting';
    this.adapter.on('transcript', (t) => {
      if (this._state !== 'running') return;
      if (t.status === 'partial') this.partials += 1;
      else this.finals += 1;
      this.pipeline.onTranscript(t);
    });
    this.adapter.on('metrics', (m) => {
      this.decodeSeries.push(m.decodeMs);
      this.latencySeries.push(m.latencyMs);
    });
    this.adapter.on('error', (code, message) => {
      if (this._state === 'stopped') return;
      this.errorCodes.push(code);
      this.onError(code, message);
    });
    this.startedAtMs = Date.now();
    try {
      const { language } = await this.adapter.start({ sessionId: this.sessionId, sourceLanguage: this.sourceLanguage });
      this.asrLanguage = language;
    } catch (err) {
      this._state = 'stopped';
      throw err;
    }
    this._state = 'running';
    if (this.metricsIntervalMs > 0) {
      this.metricsTimer = setInterval(() => this.send(this.metrics()), this.metricsIntervalMs);
    }
    return this.asrInfo;
  }

  pushAudio(pcm: Int16Array): void {
    if (this._state !== 'running') return;
    this.audioSamples += pcm.length;
    this.adapter.pushAudio(pcm);
  }

  metrics(): SessionMetricsMessage {
    const WINDOW = 50;
    return {
      type: 'session.metrics',
      sessionId: this.sessionId,
      audioSeconds: Math.round((this.audioSamples / 16000) * 10) / 10,
      partials: this.partials,
      finals: this.finals,
      avgDecodeMs: this.decodeSeries.recentMean(WINDOW),
      avgLatencyMs: this.latencySeries.recentMean(WINDOW),
      translated: this.pipeline.translated,
      avgTranslateMs: this.translateSeries.recentMean(20),
      translationBacklog: this.pipeline.backlog,
      asrLatencyP95Ms: this.latencySeries.recentP(95, 200),
      translateP95Ms: this.translateSeries.recentP(95, 100),
      translationCoverage: this.finals === 0 ? 0 : Math.min(1, Math.round((this.pipeline.translated / this.finals) * 100) / 100),
    };
  }

  /** Text-free summary for the session log. */
  summary(reason: string): SessionSummary {
    const m = this.metrics();
    const ended = this.endedAtMs || Date.now();
    return {
      sessionId: this.sessionId,
      startedAt: new Date(this.startedAtMs).toISOString(),
      endedAt: new Date(ended).toISOString(),
      durationSec: Math.round((ended - this.startedAtMs) / 1000),
      reason,
      sourceLanguage: this.sourceLanguage,
      targetLanguage: this.targetLanguage,
      asrProvider: this.adapter.provider,
      asrLanguage: this.asrLanguage,
      translationProvider: this.translation.provider,
      translatePartials: this.translatePartials,
      audioSeconds: m.audioSeconds,
      partials: m.partials,
      finals: m.finals,
      translated: m.translated,
      translationCoverage: m.translationCoverage,
      asrDecodeP50Ms: this.decodeSeries.p(50),
      asrLatencyP50Ms: this.latencySeries.p(50),
      asrLatencyP95Ms: this.latencySeries.p(95),
      translateP50Ms: this.translateSeries.p(50),
      translateP95Ms: this.translateSeries.p(95),
      translationFailures: this.translationFailures,
      errors: [...this.errorCodes],
    };
  }

  /** Idempotent. Flushes the adapter (remaining finals are still forwarded) and releases it. */
  async stop(): Promise<void> {
    if (this._state === 'stopped') return;
    if (this.metricsTimer !== null) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
    const wasRunning = this._state === 'running';
    // Keep forwarding transcripts produced by the flush, then seal the session.
    try {
      if (wasRunning) await this.adapter.stop();
    } finally {
      this._state = 'stopped';
      this.endedAtMs = Date.now();
      this.pipeline.stop();
      await this.translation.dispose().catch(() => undefined);
    }
  }
}
