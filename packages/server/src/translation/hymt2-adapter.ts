import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Llama, LlamaChatSession, LlamaContext, LlamaModel } from 'node-llama-cpp';
import type { TranslationAdapter, TranslationAdapterFactory, TranslationRequest } from './types.js';

/**
 * Local translation with Tencent Hy-MT2-1.8B (GGUF) through node-llama-cpp.
 * Inference runs on llama.cpp's own threads (the JS API is async), so no
 * worker thread is needed. One model + one context are shared; requests
 * are serialised by the TranslationPipeline (one in flight per session)
 * and by a lock here (across sessions).
 */
export const HYMT2_MODEL_FILE = 'Hy-MT2-1.8B-Q4_K_M.gguf';

export interface HyMt2Config {
  modelsDir: string;
  /** llama.cpp threads for the translation model. */
  threads: number;
  log: { info: (o: Record<string, unknown>, m: string) => void; warn: (o: Record<string, unknown>, m: string) => void };
}

/** Popup / recognizer codes → the language names the Hy-MT2 prompt expects. */
const TARGET_NAMES: Record<string, string> = {
  'zh-CN': '简体中文',
  zh: '简体中文',
  'zh-TW': '繁體中文',
  yue: '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
  ru: 'Русский',
  ar: 'العربية',
  hi: 'हिन्दी',
  id: 'Bahasa Indonesia',
  ms: 'Bahasa Melayu',
  th: 'ไทย',
  vi: 'Tiếng Việt',
};

export function hyMt2TargetName(code: string): string | null {
  return TARGET_NAMES[code] ?? null;
}

/** Official default prompt (Chinese variant), plus optional context for consistency. */
export function buildPrompt(request: Pick<TranslationRequest, 'text' | 'targetLanguage' | 'context'>): string {
  const target = hyMt2TargetName(request.targetLanguage) ?? request.targetLanguage;
  const context =
    request.context.length === 0
      ? ''
      : `参考上文（保持术语与称呼一致，不要重复翻译上文）：\n${request.context.map((c) => `- ${c.source} → ${c.translated}`).join('\n')}\n\n`;
  return `${context}将以下文本翻译为 \`${target}\`，注意**只需要输出翻译后的结果，不要额外解释**：\n\n\`${request.text}\``;
}

/** The model sometimes wraps output in backticks or quotes; strip them. */
export function cleanOutput(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
  s = s.replace(/^`+|`+$/g, '').trim();
  const pairs: Array<[string, string]> = [['"', '"'], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ["'", "'"]];
  for (const [open, close] of pairs) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close) && !s.slice(1, -1).includes(close)) {
      s = s.slice(1, -1).trim();
      break;
    }
  }
  return s;
}

class HyMt2Runtime {
  private llama: Llama | null = null;
  private model: LlamaModel | null = null;
  private context: LlamaContext | null = null;
  private session: LlamaChatSession | null = null;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: HyMt2Config) {}

  modelPath(): string {
    return path.join(this.config.modelsDir, HYMT2_MODEL_FILE);
  }

  async load(): Promise<void> {
    if (this.session !== null) return;
    const { getLlama, LlamaChatSession } = await import('node-llama-cpp');
    const t0 = Date.now();
    this.llama = await getLlama({ gpu: false, logLevel: 'error' as never });
    this.model = await this.llama.loadModel({ modelPath: this.modelPath() });
    this.context = await this.model.createContext({ contextSize: 2048, threads: this.config.threads, sequences: 1 });
    this.session = new LlamaChatSession({ contextSequence: this.context.getSequence() });
    this.config.log.info({ ms: Date.now() - t0, model: HYMT2_MODEL_FILE, threads: this.config.threads }, 'Hy-MT2 model loaded');
  }

  /** Serialised across callers: llama.cpp contexts are not re-entrant. */
  translate(prompt: string, signal: AbortSignal | undefined): Promise<string> {
    const run = async () => {
      if (this.session === null) await this.load();
      const session = this.session!;
      session.resetChatHistory();
      const out = await session.prompt(prompt, {
        temperature: 0.7,
        topP: 0.6,
        topK: 20,
        repeatPenalty: { penalty: 1.05 },
        maxTokens: 256,
        ...(signal === undefined ? {} : { signal }),
      });
      return out;
    };
    const next = this.lock.then(run, run);
    this.lock = next.catch(() => undefined);
    return next;
  }

  async dispose(): Promise<void> {
    this.session?.dispose();
    await this.context?.dispose();
    await this.model?.dispose();
    await this.llama?.dispose();
    this.session = null;
    this.context = null;
    this.model = null;
    this.llama = null;
  }
}

class HyMt2Adapter implements TranslationAdapter {
  readonly provider = 'hy-mt2';
  constructor(private readonly runtime: HyMt2Runtime) {}
  supportsTarget(targetLanguage: string): boolean {
    return hyMt2TargetName(targetLanguage) !== null;
  }
  async translate(request: TranslationRequest): Promise<string> {
    const raw = await this.runtime.translate(buildPrompt(request), request.signal);
    return cleanOutput(raw);
  }
  async dispose(): Promise<void> {
    /* the runtime is shared across sessions and lives with the server */
  }
}

export function createHyMt2Factory(config: HyMt2Config): TranslationAdapterFactory & { dispose(): Promise<void> } {
  const runtime = new HyMt2Runtime(config);
  return {
    provider: 'hy-mt2',
    async prepare() {
      if (!existsSync(runtime.modelPath())) {
        throw new Error(`Missing translation model:\n  ${runtime.modelPath()}\nRun: npm run models:download`);
      }
      await runtime.load();
      // Warm up once so the first real sentence does not pay the cold-start cost.
      const t0 = Date.now();
      const warm = await runtime.translate(buildPrompt({ text: 'Hello, welcome.', targetLanguage: 'zh-CN', context: [] }), undefined);
      config.log.info({ ms: Date.now() - t0, sample: cleanOutput(warm) }, 'Hy-MT2 warm-up done');
    },
    create: () => new HyMt2Adapter(runtime),
    dispose: () => runtime.dispose(),
  };
}
