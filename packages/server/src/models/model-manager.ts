import { ensureModels, missingFiles, type DownloadProgress } from './downloader.js';
import { filesInGroup, type ModelFileSpec, type ModelLock } from './model-lock.js';

export type ModelGroup = ModelFileSpec['group'];

export interface ModelGroupState {
  status: 'unknown' | 'missing' | 'downloading' | 'ready' | 'error';
  /** Bytes for the item currently downloading. */
  item?: string;
  receivedBytes?: number;
  totalBytes?: number | null;
  /** 0..1 when known. */
  progress?: number;
  error?: string;
}

/**
 * Tracks and (when enabled) fetches the model files per group, exposing a
 * state snapshot for /healthz so the popup can show download progress.
 */
export class ModelManager {
  private readonly state: Record<ModelGroup, ModelGroupState> = { asr: { status: 'unknown' }, translation: { status: 'unknown' } };
  private readonly inflight = new Map<ModelGroup, Promise<void>>();

  constructor(
    private readonly options: {
      modelsDir: string;
      lock: ModelLock;
      autoDownload: boolean;
      log: { info: (o: Record<string, unknown>, m: string) => void; warn: (o: Record<string, unknown>, m: string) => void };
      fetchImpl?: typeof fetch;
    },
  ) {}

  snapshot(): Record<ModelGroup, ModelGroupState> {
    return { asr: { ...this.state.asr }, translation: { ...this.state.translation } };
  }

  isReady(group: ModelGroup): boolean {
    return this.state[group].status === 'ready';
  }

  /** Human-readable reason a group is not ready (for session.error). */
  notReadyMessage(group: ModelGroup): string {
    const s = this.state[group];
    const what = group === 'asr' ? '语音识别模型' : '翻译模型';
    switch (s.status) {
      case 'downloading': {
        const pct = s.progress === undefined ? '' : ` ${Math.round(s.progress * 100)}%`;
        return `${what}正在下载${pct}（${s.item ?? ''}），请稍候再开始。`;
      }
      case 'error':
        return `${what}准备失败：${s.error ?? 'unknown'}。可执行 npm run models:download 后重启后端。`;
      case 'missing':
        return `${what}缺失且自动下载已关闭（AUTO_DOWNLOAD_MODELS=0）。请执行 npm run models:download。`;
      default:
        return `${what}尚未就绪，请稍候。`;
    }
  }

  /** Ensure a group's files exist (downloading if allowed). Concurrent calls share one download. */
  ensure(group: ModelGroup): Promise<void> {
    const existing = this.inflight.get(group);
    if (existing) return existing;
    const run = (async () => {
      const files = filesInGroup(this.options.lock, group);
      const missing = await missingFiles(this.options.modelsDir, this.options.lock, files);
      if (missing.length === 0) {
        this.state[group] = { status: 'ready' };
        return;
      }
      if (!this.options.autoDownload) {
        this.state[group] = { status: 'missing', error: `missing: ${missing.join(', ')}` };
        throw new Error(this.notReadyMessage(group));
      }
      this.state[group] = { status: 'downloading', progress: 0 };
      this.options.log.info({ group, missing }, 'downloading models');
      try {
        await ensureModels({
          modelsDir: this.options.modelsDir,
          lock: this.options.lock,
          files,
          log: this.options.log,
          ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
          onProgress: (p: DownloadProgress) => {
            const st = this.state[group];
            st.item = p.item;
            st.receivedBytes = p.receivedBytes;
            st.totalBytes = p.totalBytes;
            if (p.totalBytes) st.progress = Math.min(1, p.receivedBytes / p.totalBytes);
            else delete st.progress;
          },
        });
        this.state[group] = { status: 'ready' };
        this.options.log.info({ group }, 'models ready');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.state[group] = { status: 'error', error: message };
        this.options.log.warn({ group, error: message }, 'model download failed');
        throw err;
      }
    })().finally(() => this.inflight.delete(group));
    this.inflight.set(group, run);
    return run;
  }
}
