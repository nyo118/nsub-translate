import {
  PROTOCOL_VERSION,
  parseJsonObject,
  validateServerMessage,
  type ClientMessage,
  type ServerMessage,
} from '@lst/protocol';

/** Minimal WebSocket shape so the client can be unit-tested with a fake. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface BackendClientEvents {
  onMessage: (message: ServerMessage) => void;
  /** Fired once, when the socket closes for any reason after having been opened. */
  onClose: (reason: string) => void;
  onInvalid?: (error: string) => void;
}

const OPEN = 1;

/**
 * One backend connection == one protocol session. `connect()` resolves once
 * the server sends `session.ready`; `disconnect()` sends `session.stop`,
 * waits briefly for `session.stopped`, then closes the socket.
 */
export class BackendClient {
  private socket: SocketLike | null = null;
  private _sessionId: string | null = null;
  private closedByUs = false;
  private readonly factory: SocketFactory;
  private readonly events: BackendClientEvents;
  private stoppedResolver: (() => void) | null = null;

  constructor(events: BackendClientEvents, factory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike) {
    this.events = events;
    this.factory = factory;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get state(): string {
    if (this.socket === null) return 'none';
    return ['connecting', 'open', 'closing', 'closed'][this.socket.readyState] ?? String(this.socket.readyState);
  }

  connect(url: string, languages: { sourceLanguage: string; targetLanguage: string }, timeoutMs: number): Promise<string> {
    if (this.socket !== null) return Promise.reject(new Error('already connected'));
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
        this.send({ type: 'session.start', protocolVersion: PROTOCOL_VERSION, ...languages });
      };
      socket.onerror = () => {
        // The close event that follows carries the useful information.
      };
      socket.onmessage = (ev) => {
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
        const wasSettled = settled;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.socket = null;
          reject(new Error(`Could not connect to the local backend at ${url}. Is it running? (close code ${ev.code})`));
        }
        this.socket = null;
        this._sessionId = null;
        if (wasSettled && !this.closedByUs) this.events.onClose(ev.reason || `code ${ev.code}`);
      };
    });
  }

  send(message: ClientMessage): boolean {
    if (this.socket === null || this.socket.readyState !== OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  /** Graceful stop; never throws; resolves when the socket is closed or the timeout elapses. */
  async disconnect(timeoutMs: number): Promise<void> {
    const socket = this.socket;
    if (socket === null) return;
    this.closedByUs = true;
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
    const socket = this.socket;
    this.socket = null;
    this._sessionId = null;
    if (socket !== null) {
      try {
        socket.close(1000, 'client stop');
      } catch {
        /* ignore */
      }
    }
  }
}
