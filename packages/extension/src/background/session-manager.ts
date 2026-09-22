import type { TranscriptMessage } from '@lst/protocol';
import type { Platform } from '../shared/platform.js';
import type { ReleasedResources, SessionSnapshot, SessionStatus } from '../shared/messages.js';

/**
 * Persisted part of the session. Lives in chrome.storage.session so that it
 * survives service-worker restarts (the offscreen document keeps running
 * independently of the worker).
 */
export interface PersistedSession {
  status: SessionStatus;
  sessionId?: string;
  tabId?: number;
  platform?: Platform;
  startedAt?: number;
  lastError?: string;
}

/**
 * Side effects the session manager needs, injected so the state machine
 * can be unit-tested without Chrome. The service worker provides the real
 * implementations.
 */
export interface SessionPorts {
  loadState(): Promise<PersistedSession | undefined>;
  saveState(state: PersistedSession): Promise<void>;
  clearState(): Promise<void>;
  /** Resolve the tab the user wants to translate; throws if none. */
  getActiveTab(): Promise<{ tabId: number; url?: string }>;
  detectPlayer(tabId: number): Promise<{ platform: Platform | null; playerFound: boolean }>;
  getStreamId(tabId: number): Promise<string>;
  ensureOffscreen(): Promise<void>;
  hasOffscreen(): Promise<boolean>;
  closeOffscreen(): Promise<void>;
  startOffscreen(req: { streamId: string; backendUrl: string; sourceLanguage: string; targetLanguage: string }): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>;
  stopOffscreen(): Promise<ReleasedResources | undefined>;
  notifyContent(tabId: number, message: { type: 'content.sessionStarted'; sessionId: string } | { type: 'content.transcript'; transcript: TranscriptMessage } | { type: 'content.sessionStopped' }): Promise<void>;
  log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void;
}

export interface SessionManagerOptions {
  ports: SessionPorts;
  backendUrl: string;
  sourceLanguage: string;
  targetLanguage: string;
}

const IDLE: PersistedSession = { status: 'idle' };

/**
 * Coordinates one translation session at a time.
 *
 * Guarantees:
 *  - start() while a session is starting/active is rejected (no duplicates).
 *  - stop() always releases offscreen resources, even if a step fails.
 *  - state is persisted so a restarted worker can still route transcripts.
 */
export class SessionManager {
  private readonly ports: SessionPorts;
  private readonly backendUrl: string;
  private readonly sourceLanguage: string;
  private readonly targetLanguage: string;
  private state: PersistedSession | null = null;
  private inflight: Promise<unknown> | null = null;
  private audioLevel: number | undefined;
  private transcriptCount = 0;

  constructor(options: SessionManagerOptions) {
    this.ports = options.ports;
    this.backendUrl = options.backendUrl;
    this.sourceLanguage = options.sourceLanguage;
    this.targetLanguage = options.targetLanguage;
  }

  private async getState(): Promise<PersistedSession> {
    if (this.state === null) {
      this.state = (await this.ports.loadState()) ?? { ...IDLE };
    }
    return this.state;
  }

  private async setState(state: PersistedSession): Promise<void> {
    this.state = state;
    if (state.status === 'idle') {
      await this.ports.clearState();
    } else {
      await this.ports.saveState(state);
    }
  }

  async snapshot(): Promise<SessionSnapshot> {
    const state = await this.getState();
    const snap: SessionSnapshot = {
      status: state.status,
      backendUrl: this.backendUrl,
      transcriptCount: this.transcriptCount,
    };
    if (state.sessionId !== undefined) snap.sessionId = state.sessionId;
    if (state.tabId !== undefined) snap.tabId = state.tabId;
    if (state.platform !== undefined) snap.platform = state.platform;
    if (state.startedAt !== undefined) snap.startedAt = state.startedAt;
    if (state.lastError !== undefined) snap.lastError = state.lastError;
    if (state.status === 'active' && this.audioLevel !== undefined) snap.audioLevel = this.audioLevel;
    return snap;
  }

  /** Serialise start/stop so they can never interleave. */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    while (this.inflight !== null) {
      try {
        await this.inflight;
      } catch {
        /* the previous operation reports its own error */
      }
    }
    const p = fn();
    this.inflight = p;
    try {
      return await p;
    } finally {
      this.inflight = null;
    }
  }

  start(capture?: { tabId: number; streamId: string }): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
    return this.exclusive(async () => {
      const current = await this.getState();
      if (current.status !== 'idle') {
        return { ok: false, error: `A session is already ${current.status}. Stop it first.` };
      }
      // Belt and braces: a stray offscreen document from a crashed worker would
      // otherwise hold a duplicate audio track.
      if (await this.ports.hasOffscreen()) {
        this.ports.log('warn', 'stale offscreen document found before start; closing it');
        await this.ports.closeOffscreen().catch(() => undefined);
      }

      let tabId: number | undefined;
      try {
        tabId = capture?.tabId ?? (await this.ports.getActiveTab()).tabId;
        const detection = await this.ports.detectPlayer(tabId);
        if (detection.platform === null) {
          throw new Error('The current tab is not a YouTube or Twitch page.');
        }
        if (!detection.playerFound) {
          throw new Error(`No ${detection.platform} video player found on this page. Open a video first.`);
        }
        await this.setState({ status: 'starting', tabId, platform: detection.platform });

        // Prefer the stream id the popup obtained in the user's click context.
        const streamId = capture?.streamId ?? (await this.ports.getStreamId(tabId));
        await this.ports.ensureOffscreen();
        const result = await this.ports.startOffscreen({
          streamId,
          backendUrl: this.backendUrl,
          sourceLanguage: this.sourceLanguage,
          targetLanguage: this.targetLanguage,
        });
        if (!result.ok) throw new Error(result.error);

        this.transcriptCount = 0;
        this.audioLevel = undefined;
        await this.setState({
          status: 'active',
          sessionId: result.sessionId,
          tabId,
          platform: detection.platform,
          startedAt: Date.now(),
        });
        await this.ports.notifyContent(tabId, { type: 'content.sessionStarted', sessionId: result.sessionId }).catch((err: unknown) => {
          this.ports.log('warn', 'content script did not acknowledge sessionStarted', String(err));
        });
        this.ports.log('info', 'session active', { sessionId: result.sessionId, tabId });
        return { ok: true, sessionId: result.sessionId };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.ports.log('error', 'start failed; releasing resources', message);
        await this.releaseAll(tabId);
        await this.setState({ status: 'idle', lastError: message });
        return { ok: false, error: message };
      }
    });
  }

  stop(reason = 'user'): Promise<{ ok: true; released?: ReleasedResources } | { ok: false; error: string }> {
    return this.exclusive(async () => {
      const current = await this.getState();
      if (current.status === 'idle') {
        // Still make sure nothing is left behind (e.g. after a worker restart).
        if (await this.ports.hasOffscreen()) {
          await this.releaseAll(undefined);
        }
        return { ok: true };
      }
      await this.setState({ ...current, status: 'stopping' });
      const released = await this.releaseAll(current.tabId);
      await this.setState({ status: 'idle' });
      this.ports.log('info', 'session stopped', { reason, released });
      return released ? { ok: true, released } : { ok: true };
    });
  }

  /** Called by the worker when the offscreen document reports a lost backend connection. */
  async onOffscreenDisconnected(reason: string): Promise<void> {
    const current = await this.getState();
    if (current.status === 'idle') return;
    this.ports.log('warn', 'offscreen disconnected', reason);
    await this.stop(`offscreen disconnected: ${reason}`);
    const after = await this.getState();
    await this.setState({ ...after, status: 'idle', lastError: `Backend connection lost: ${reason}` });
  }

  /** Called by the worker when a tab is closed. */
  async onTabRemoved(tabId: number): Promise<void> {
    const current = await this.getState();
    if (current.status === 'idle' || current.tabId !== tabId) return;
    await this.stop('tab closed');
  }

  /** Route a transcript from the offscreen document to the session's tab. */
  async onTranscript(transcript: TranscriptMessage): Promise<void> {
    const current = await this.getState();
    if (current.status !== 'active' || current.tabId === undefined) return;
    if (current.sessionId !== undefined && transcript.sessionId !== current.sessionId) {
      this.ports.log('warn', 'dropping transcript for unknown session', transcript.sessionId);
      return;
    }
    this.transcriptCount += 1;
    await this.ports.notifyContent(current.tabId, { type: 'content.transcript', transcript }).catch((err: unknown) => {
      // The content script may be reloading (navigation). Not fatal.
      this.ports.log('warn', 'could not deliver transcript to tab', String(err));
    });
  }

  onAudioLevel(level: number): void {
    this.audioLevel = level;
  }

  /** Does this tab have the active session? Used when a content script (re)loads. */
  async sessionForTab(tabId: number): Promise<{ active: boolean; sessionId?: string }> {
    const current = await this.getState();
    if (current.status === 'active' && current.tabId === tabId && current.sessionId !== undefined) {
      return { active: true, sessionId: current.sessionId };
    }
    return { active: false };
  }

  /**
   * Release everything, tolerating failures in each step so that one broken
   * step can never leave the others dangling.
   */
  private async releaseAll(tabId: number | undefined): Promise<ReleasedResources | undefined> {
    let released: ReleasedResources | undefined;
    this.audioLevel = undefined;
    if (await this.ports.hasOffscreen().catch(() => false)) {
      try {
        released = await this.ports.stopOffscreen();
      } catch (err) {
        this.ports.log('warn', 'stopOffscreen failed', String(err));
      }
      try {
        await this.ports.closeOffscreen();
      } catch (err) {
        this.ports.log('warn', 'closeOffscreen failed', String(err));
      }
    }
    if (tabId !== undefined) {
      await this.ports.notifyContent(tabId, { type: 'content.sessionStopped' }).catch(() => undefined);
    }
    return released;
  }
}
