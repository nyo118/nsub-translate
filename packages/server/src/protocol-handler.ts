import { randomUUID } from 'node:crypto';
import {
  parseJsonObject,
  validateAudioFrame,
  validateClientMessage,
  type ServerMessage,
  type SessionErrorCode,
} from '@lst/protocol';
import { Session } from './session.js';
import type { AsrAdapterFactory } from './asr/types.js';
import type { TranslationRegistry } from './translation/registry.js';
import type { SessionSummary } from './metrics/session-log.js';

export interface ConnectionLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export interface ConnectionHandlerOptions {
  send: (message: ServerMessage) => void;
  asr: AsrAdapterFactory;
  translation: TranslationRegistry;
  log: ConnectionLogger;
  newSessionId?: () => string;
  metricsIntervalMs?: number;
  /** +1 when a session becomes running, -1 when it stops (for /healthz). */
  onSessionCount?: (delta: 1 | -1) => void;
  onSessionSummary?: (summary: SessionSummary) => void;
  logTranscripts?: boolean;
  /** Backend-wide readiness (models still downloading, etc.). Returns a message when not ready. */
  notReady?: () => string | null;
}

/**
 * One instance per WebSocket connection. Owns at most one Session.
 * Text frames are validated protocol messages; binary frames are PCM audio.
 * Nothing here throws: bugs become `session.error` replies.
 */
export class ConnectionHandler {
  private session: Session | null = null;
  private starting = false;
  private readonly send: (message: ServerMessage) => void;
  private readonly asr: AsrAdapterFactory;
  private readonly translation: TranslationRegistry;
  private readonly log: ConnectionLogger;
  private readonly newSessionId: () => string;
  private readonly metricsIntervalMs: number;
  private readonly onSessionCount: (delta: 1 | -1) => void;
  private readonly onSessionSummary: (summary: SessionSummary) => void;
  private readonly logTranscripts: boolean;
  private readonly notReady: () => string | null;
  private droppedAudioFrames = 0;

  constructor(options: ConnectionHandlerOptions) {
    this.send = options.send;
    this.asr = options.asr;
    this.translation = options.translation;
    this.log = options.log;
    this.newSessionId = options.newSessionId ?? (() => randomUUID());
    this.metricsIntervalMs = options.metricsIntervalMs ?? 5000;
    this.onSessionCount = options.onSessionCount ?? (() => {});
    this.onSessionSummary = options.onSessionSummary ?? (() => {});
    this.logTranscripts = options.logTranscripts ?? false;
    this.notReady = options.notReady ?? (() => null);
  }

  get activeSessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  handleFrame(raw: unknown): void {
    try {
      this.handleFrameUnsafe(raw);
    } catch (err) {
      this.error('internal_error', err instanceof Error ? err.message : String(err));
    }
  }

  /** Binary frame = PCM16 audio for the active session. */
  handleAudio(data: unknown): void {
    const frame = validateAudioFrame(data);
    if (!frame.ok) {
      this.error('invalid_audio', frame.error);
      return;
    }
    if (this.session === null || this.session.state !== 'running') {
      // Audio before session.ready (or after stop) is expected during handshakes; drop quietly but count.
      this.droppedAudioFrames += 1;
      if (this.droppedAudioFrames === 1) this.log.warn({}, 'dropping audio: no running session');
      return;
    }
    this.session.pushAudio(frame.message);
  }

  private handleFrameUnsafe(raw: unknown): void {
    const parsed = parseJsonObject(raw);
    if (!parsed.ok) {
      this.error('invalid_message', parsed.error);
      return;
    }
    const validated = validateClientMessage(parsed.message);
    if (!validated.ok) {
      const code: SessionErrorCode = /protocolVersion/.test(validated.error)
        ? 'unsupported_protocol_version'
        : /^audio\./.test(validated.error) || /audio format/.test(validated.error)
          ? 'unsupported_audio_format'
          : 'invalid_message';
      this.error(code, validated.error);
      return;
    }
    const message = validated.message;
    switch (message.type) {
      case 'session.start': {
        if (this.session !== null || this.starting) {
          this.error('session_already_started', `a session is already active on this connection`);
          return;
        }
        const notReady = this.notReady();
        if (notReady !== null) {
          this.error('asr_unavailable', notReady);
          return;
        }
        this.starting = true;
        const providerName = message.options?.translationProvider ?? this.translation.defaultProvider;
        void this.translation
          .get(providerName)
          .then((factory) => {
            const translation = factory.create();
            if (!translation.supportsTarget(message.targetLanguage)) {
              throw Object.assign(new Error(`target language "${message.targetLanguage}" is not supported by the ${translation.provider} translator`), { code: 'unsupported_language' });
            }
            const sessionId = this.newSessionId();
            const session = new Session({
              sessionId,
              sourceLanguage: message.sourceLanguage,
              targetLanguage: message.targetLanguage,
              adapter: this.asr.create(),
              translation,
              translatePartials: message.options?.translatePartials ?? false,
              log: this.log,
              logTranscripts: this.logTranscripts,
              send: (m) => this.send(m),
              onError: (code, msg) => {
                this.error(code, msg);
                // Translation failures degrade to source-only subtitles; ASR failures end the session.
                if (code !== 'translation_failed') void this.stopSession(`asr error: ${code}`);
              },
              metricsIntervalMs: this.metricsIntervalMs,
            });
            return session.start().then((asr) => {
              this.session = session;
              this.onSessionCount(1);
              const translationInfo = session.translationInfo;
              this.log.info({ sessionId, sourceLanguage: message.sourceLanguage, targetLanguage: message.targetLanguage, asr, translation: translationInfo, translatePartials: message.options?.translatePartials ?? false }, 'session started');
              this.send({ type: 'session.ready', sessionId, asr, translation: translationInfo });
            });
          })
          .catch((err: unknown) => {
            const code = (err as { code?: SessionErrorCode }).code;
            const msg = err instanceof Error ? err.message : String(err);
            if (code === 'unsupported_language') this.error(code, msg);
            else if (/translation provider|API_KEY|translation model/i.test(msg)) this.error('translation_unavailable', msg);
            else this.error('asr_unavailable', msg);
          })
          .finally(() => {
            this.starting = false;
          });
        return;
      }
      case 'session.ping': {
        if (!this.session || this.session.sessionId !== message.sessionId) {
          this.error('session_not_found', 'no active session with that sessionId');
          return;
        }
        this.send({ type: 'session.pong', sessionId: message.sessionId });
        return;
      }
      case 'session.stop': {
        if (!this.session || this.session.sessionId !== message.sessionId) {
          this.error('session_not_found', 'no active session with that sessionId');
          return;
        }
        void this.stopSession('client requested stop').then(() => {
          this.send({ type: 'session.stopped', sessionId: message.sessionId });
        });
        return;
      }
    }
  }

  /** Called when the socket closes for any reason. Idempotent. */
  async dispose(reason: string): Promise<void> {
    await this.stopSession(reason);
  }

  private async stopSession(reason: string): Promise<void> {
    const session = this.session;
    if (session === null) return;
    this.session = null;
    this.onSessionCount(-1);
    await session.stop();
    const summary = session.summary(reason);
    this.onSessionSummary(summary);
    this.log.info({ sessionId: session.sessionId, reason, summary }, 'session stopped');
  }

  private error(code: SessionErrorCode, message: string): void {
    this.log.warn({ code, message }, 'protocol error');
    this.send({ type: 'session.error', code, message });
  }
}
