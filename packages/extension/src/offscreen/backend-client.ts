import {
  AUDIO_FORMAT,
  PROTOCOL_VERSION,
  parseJsonObject,
  validateServerMessage,
  type AsrInfo,
  type ClientMessage,
  type ServerMessage,
  type SessionOptions,
  type TranslationInfo,
} from '@lst/protocol';

/** Minimal WebSocket shape so the client can be unit-tested with a fake. */
export interface SocketLike {
  readonly readyState: number;
  binaryType?: string;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface BackendClientEvents {
  onMessage: (message: ServerMessage) => void;
  /** Fired once, when the socket closes for any reason after having been opened and reconnection is not attempted or has failed. */
  onClose: (reason: string) => void;
  onInvalid?: (error: string) => void;
  /** Reconnection lifecycle (only when `reconnect` is configured). */
  onReconnecting?: (attempt: number) => void;
  onReconnected?: (sessionId: string, asr: AsrInfo, translation: TranslationInfo) => void;
}

export interface ConnectParams {
  sourceLanguage: string;
  targetLanguage: string;
  options?: SessionOptions;
}

export interface ReconnectPolicy {
  maxAttempts: number;
  /** Delays per attempt in ms; the last value repeats. */
  delaysMs: number[];
}

export const DEFAULT_RECONNECT: ReconnectPolicy = { maxAttempts: 5, delaysMs: [500, 1000, 2000, 4000] };

const OPEN = 1;
const CONNECT_TIMEOUT_MS = 5000;
/** Heartbeat: ping every 15 s; no pong (or any message) for 30 s → treat the socket as dead. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 30_000;

/**
 * One backend connection == one protocol session. `connect()` resolves once
 * the server sends `session.ready`; `disconnect()` sends `session.stop`,
 * waits briefly for `session.stopped`, then closes the socket.
 */
export class BackendClient {
  private socket: SocketLike | null = null;
  private _sessionId: string | null = null;
  private _asr: AsrInfo | null = null;
  private _translation: TranslationInfo | null = null;
  private closedByUs = false;
  private readonly factory: SocketFactory;
  private readonly events: BackendClientEvents;
  private readonly reconnect: ReconnectPolicy | null;
  private stoppedResolver: (() => void) | null = null;
  private lastConnect: { url: string; languages: ConnectParams } | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnecting = false;
  private audioFramesSent = 0;
  private audioFramesDropped = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastInboundAt = 0;
  private _heartbeatTimeouts = 0;

  constructor(
    events: BackendClientEvents,
    factory: SocketFactory = (url) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      return ws as unknown as SocketLike;
    },
    reconnect: ReconnectPolicy | null = null,
  ) {
    this.events = events;
    this.factory = factory;
    this.reconnect = reconnect;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get asr(): AsrInfo | null {
    return this._asr;
  }

  get translation(): TranslationInfo | null {
    return this._translation;
  }

  get isReconnecting(): boolean {
    return this.reconnecting;
  }

  get stats(): { audioFramesSent: number; audioFramesDropped: number; heartbeatTimeouts: number } {
    return { audioFramesSent: this.audioFramesSent, audioFramesDropped: this.audioFramesDropped, heartbeatTimeouts: this._heartbeatTimeouts };
  }

  private startHeartbeat(socket: SocketLike): void {
    this.stopHeartbeat();
    this.lastInboundAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket) return this.stopHeartbeat();
      if (Date.now() - this.lastInboundAt > HEARTBEAT_TIMEOUT_MS) {
        this._heartbeatTimeouts += 1;
        // Force the close path; onclose then decides whether to reconnect.
        try {
          socket.close(4000, 'heartbeat timeout');
        } catch {
          /* ignore */
        }
        socket.onclose?.({ code: 4000, reason: 'heartbeat timeout' });
        return;
      }
      if (this._sessionId !== null) this.send({ type: 'session.ping', sessionId: this._sessionId });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  get state(): string {
    if (this.socket === null) return 'none';
    return ['connecting', 'open', 'closing', 'closed'][this.socket.readyState] ?? String(this.socket.readyState);
  }

  connect(url: string, languages: ConnectParams, timeoutMs: number): Promise<string> {
    if (this.socket !== null) return Promise.reject(new Error('already connected'));
    this.lastConnect = { url, languages };
    this.closedByUs = false;
    return this.open(url, languages, timeoutMs);
  }

  private open(url: string, languages: ConnectParams, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const socket = this.factory(url);
      this.socket = socket;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.teardown();
        reject(new Error(`Backend did not answer session.start within ${timeoutMs} ms (${url}).`));
      }, timeoutMs);

      socket.onopen = () => {
        const start: ClientMessage = {
          type: 'session.start',
          protocolVersion: PROTOCOL_VERSION,
          sourceLanguage: languages.sourceLanguage,
          targetLanguage: languages.targetLanguage,
          audio: AUDIO_FORMAT,
        };
        if (languages.options !== undefined) start.options = languages.options;
        this.send(start);
      };
      socket.onerror = () => {
        // The close event that follows carries the useful information.
      };
      socket.onmessage = (ev) => {
        this.lastInboundAt = Date.now();
        const parsed = parseJsonObject(ev.data);
        if (!parsed.ok) return this.events.onInvalid?.(parsed.error);
        const validated = validateServerMessage(parsed.message);
        if (!validated.ok) return this.events.onInvalid?.(validated.error);
        const message = validated.message;
        if (!settled) {
          if (message.type === 'session.ready') {
            settled = true;
            clearTimeout(timer);
            this._sessionId = message.sessionId;
            this._asr = message.asr;
            this._translation = message.translation;
            this.startHeartbeat(socket);
            resolve(message.sessionId);
          } else if (message.type === 'session.error') {
            settled = true;
            clearTimeout(timer);
            this.teardown();
            reject(new Error(`Backend rejected session.start: ${message.code} (${message.message})`));
          }
          return;
        }
        if (message.type === 'session.stopped') this.stoppedResolver?.();
        this.events.onMessage(message);
      };
      socket.onclose = (ev) => {
        if (this.socket === socket || this.socket === null) this.stopHeartbeat();
        socket.onclose = null; // guard against the synthetic close firing twice
        const wasSettled = settled;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.socket = null;
          reject(new Error(`Could not connect to the local backend at ${url}. Is it running? (close code ${ev.code})`));
        }
        this.socket = null;
        this._sessionId = null;
        if (wasSettled && !this.closedByUs) this.handleUnexpectedClose(ev.reason || `code ${ev.code}`);
      };
    });
  }

  /** Backend dropped mid-session: retry with backoff (if configured), starting a fresh session. */
  private handleUnexpectedClose(reason: string): void {
    if (this.reconnect === null || this.lastConnect === null) {
      this.events.onClose(reason);
      return;
    }
    const { url, languages } = this.lastConnect;
    const policy = this.reconnect;
    let attempt = 0;
    this.reconnecting = true;
    const tryAgain = () => {
      if (this.closedByUs) {
        this.reconnecting = false;
        return;
      }
      attempt += 1;
      if (attempt > policy.maxAttempts) {
        this.reconnecting = false;
        this.events.onClose(`${reason}; reconnect failed after ${policy.maxAttempts} attempts`);
        return;
      }
      this.events.onReconnecting?.(attempt);
      this.open(url, languages, CONNECT_TIMEOUT_MS).then(
        (sessionId) => {
          this.reconnecting = false;
          this.events.onReconnected?.(
            sessionId,
            this._asr ?? { provider: 'unknown', language: languages.sourceLanguage },
            this._translation ?? { provider: 'unknown', targetLanguage: languages.targetLanguage },
          );
        },
        () => {
          const delay = policy.delaysMs[Math.min(attempt - 1, policy.delaysMs.length - 1)] ?? 1000;
          this.reconnectTimer = setTimeout(tryAgain, delay);
        },
      );
    };
    tryAgain();
  }

  send(message: ClientMessage): boolean {
    if (this.socket === null || this.socket.readyState !== OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  /** Send one PCM16 audio frame as a binary WebSocket message. Dropped (counted) while not connected. */
  sendAudio(pcm: ArrayBuffer): boolean {
    if (this.socket === null || this.socket.readyState !== OPEN || this._sessionId === null) {
      this.audioFramesDropped += 1;
      return false;
    }
    this.socket.send(pcm);
    this.audioFramesSent += 1;
    return true;
  }

  /** Graceful stop; never throws; resolves when the socket is closed or the timeout elapses. */
  async disconnect(timeoutMs: number): Promise<void> {
    this.closedByUs = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting = false;
    const socket = this.socket;
    if (socket === null) return;
    const sessionId = this._sessionId;
    if (sessionId !== null && socket.readyState === OPEN) {
      const stopped = new Promise<void>((resolve) => {
        this.stoppedResolver = resolve;
      });
      this.send({ type: 'session.stop', sessionId });
      await Promise.race([stopped, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
      this.stoppedResolver = null;
    }
    this.teardown();
  }

  private teardown(): void {
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    this._sessionId = null;
    this._asr = null;
    this._translation = null;
    if (socket !== null) {
      try {
        socket.close(1000, 'client stop');
      } catch {
        /* ignore */
      }
    }
  }
}
