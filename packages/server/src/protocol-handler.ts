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
import type { TranslationAdapterFactory } from './translation/types.js';

export interface ConnectionLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export interface ConnectionHandlerOptions {
  send: (message: ServerMessage) => void;
  asr: AsrAdapterFactory;
  translation: TranslationAdapterFactory;
  log: ConnectionLogger;
  newSessionId?: () => string;
  metricsIntervalMs?: number;
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
  private readonly translation: TranslationAdapterFactory;
  private readonly log: ConnectionLogger;
  private readonly newSessionId: () => string;
  private readonly metricsIntervalMs: number;
  private droppedAudioFrames = 0;

  constructor(options: ConnectionHandlerOptions) {
    this.send = options.send;
    this.asr = options.asr;
    this.translation = options.translation;
    this.log = options.log;
    this.newSessionId = options.newSessionId ?? (() => randomUUID());
    this.metricsIntervalMs = options.metricsIntervalMs ?? 5000;
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
        const translation = this.translation.create();
        if (!translation.supportsTarget(message.targetLanguage)) {
          this.error('unsupported_language', `target language "${message.targetLanguage}" is not supported by the ${translation.provider} translator`);
          return;
        }
        const sessionId = this.newSessionId();
        const session = new Session({
          sessionId,
          sourceLanguage: message.sourceLanguage,
          targetLanguage: message.targetLanguage,
          adapter: this.asr.create(),
          translation,
          translatePartials: message.options?.translatePartials ?? false,
          send: (m) => this.send(m),
          onError: (code, msg) => {
            this.error(code, msg);
            // Translation failures degrade to source-only subtitles; ASR failures end the session.
            if (code !== 'translation_failed') void this.stopSession(`asr error: ${code}`);
          },
          metricsIntervalMs: this.metricsIntervalMs,
        });
        this.starting = true;
        void session
          .start()
          .then((asr) => {
            this.session = session;
            const translationInfo = session.translationInfo;
            this.log.info({ sessionId, sourceLanguage: message.sourceLanguage, targetLanguage: message.targetLanguage, asr, translation: translationInfo, translatePartials: message.options?.translatePartials ?? false }, 'session started');
            this.send({ type: 'session.ready', sessionId, asr, translation: translationInfo });
          })
          .catch((err: unknown) => {
            this.error('asr_unavailable', err instanceof Error ? err.message : String(err));
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
    await session.stop();
    this.log.info({ sessionId: session.sessionId, reason, metrics: session.metrics() }, 'session stopped');
  }

  private error(code: SessionErrorCode, message: string): void {
    this.log.warn({ code, message }, 'protocol error');
    this.send({ type: 'session.error', code, message });
  }
}
