import {
  parseJsonObject,
  validateClientMessage,
  type ServerMessage,
  type SessionErrorCode,
} from '@lst/protocol';
import { randomUUID } from 'node:crypto';
import { MockSession } from './session.js';

export interface ConnectionLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export interface ConnectionHandlerOptions {
  send: (message: ServerMessage) => void;
  tickMs: number;
  log: ConnectionLogger;
  newSessionId?: () => string;
}

/**
 * One instance per WebSocket connection. Owns at most one MockSession.
 * All incoming frames are validated before use; invalid frames produce a
 * `session.error` reply and never throw.
 */
export class ConnectionHandler {
  private session: MockSession | null = null;
  private readonly send: (message: ServerMessage) => void;
  private readonly tickMs: number;
  private readonly log: ConnectionLogger;
  private readonly newSessionId: () => string;

  constructor(options: ConnectionHandlerOptions) {
    this.send = options.send;
    this.tickMs = options.tickMs;
    this.log = options.log;
    this.newSessionId = options.newSessionId ?? (() => randomUUID());
  }

  get activeSessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  handleFrame(raw: unknown): void {
    try {
      this.handleFrameUnsafe(raw);
    } catch (err) {
      // A bug must never take the whole server down; report it to the client.
      this.error('internal_error', err instanceof Error ? err.message : String(err));
    }
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
        : 'invalid_message';
      this.error(code, validated.error);
      return;
    }
    const message = validated.message;
    switch (message.type) {
      case 'session.start': {
        if (this.session !== null) {
          this.error('session_already_started', `session ${this.session.sessionId} is already active on this connection`);
          return;
        }
        const sessionId = this.newSessionId();
        this.session = new MockSession({
          sessionId,
          sourceLanguage: message.sourceLanguage,
          targetLanguage: message.targetLanguage,
          tickMs: this.tickMs,
          emit: (transcript) => this.send(transcript),
        });
        this.log.info({ sessionId, sourceLanguage: message.sourceLanguage, targetLanguage: message.targetLanguage }, 'session started');
        this.send({ type: 'session.ready', sessionId });
        this.session.start();
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
        this.stopSession('client requested stop');
        this.send({ type: 'session.stopped', sessionId: message.sessionId });
        return;
      }
    }
  }

  /** Called when the socket closes for any reason. Idempotent. */
  dispose(reason: string): void {
    this.stopSession(reason);
  }

  private stopSession(reason: string): void {
    if (this.session === null) return;
    const sessionId = this.session.sessionId;
    this.session.stop();
    this.session = null;
    this.log.info({ sessionId, reason }, 'session stopped');
  }

  private error(code: SessionErrorCode, message: string): void {
    this.log.warn({ code, message }, 'protocol error');
    this.send({ type: 'session.error', code, message });
  }
}
