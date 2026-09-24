import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Llama, LlamaChatSession, LlamaContext, LlamaModel } from 'node-llama-cpp';
import type { TranslationAdapter, TranslationAdapterFactory, TranslationRequest } from './types.js';
import { TARGET_NAMES, cleanOutput } from './text-utils.js';

export { cleanOutput } from './text-utils.js';

/**
 * Local translation with Tencent Hy-MT2-1.8B (GGUF) through node-llama-cpp.
 * Inference runs on llama.cpp's own threads (the JS API is async), so no
 * worker thread is needed. One model + one context are shared; requests
 * are serialised by the TranslationPipeline (one in flight per session)
 * and by a lock here (across sessions).
 */
/**
 * Official Tencent GGUF (Q6_K: near-lossless quality, ~30% slower than Q4_K_M). Smaller community quants (mradermacher IQ3_XS / Q3_K_S)
 * were tested and rejected: their EOS configuration is broken, so generation
 * runs on past the translation until maxTokens (10× slower, garbage tail).
 * The official 2-bit/1.25-bit files need an unmerged llama.cpp kernel.
 */
export const HYMT2_MODEL_FILE = 'Hy-MT2-1.8B-Q6_K.gguf';

export interface HyMt2Config {
  modelsDir: string;
  /** GGUF file name inside modelsDir (default HYMT2_MODEL_FILE). */
  modelFile?: string;
  /** Engine name reported to clients (default "hy-mt2"). */
  provider?: string;
  /** llama.cpp threads for the translation model. */
  threads: number;
  log: { info: (o: Record<string, unknown>, m: string) => void; warn: (o: Record<string, unknown>, m: string) => void };
}

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

class HyMt2Runtime {
  private llama: Llama | null = null;
  private model: LlamaModel | null = null;
  private context: LlamaContext | null = null;
  private session: LlamaChatSession | null = null;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: HyMt2Config) {}

  modelPath(): string {
    return path.join(this.config.modelsDir, this.config.modelFile ?? HYMT2_MODEL_FILE);
  }

  async load(): Promise<void> {
    if (this.session !== null) return;
    const { getLlama, LlamaChatSession } = await import('node-llama-cpp');
    const t0 = Date.now();
    this.llama = await getLlama({ gpu: false, logLevel: 'error' as never });
    this.model = await this.llama.loadModel({ modelPath: this.modelPath() });
    this.context = await this.model.createContext({ contextSize: 2048, threads: this.config.threads, sequences: 1 });
    this.session = new LlamaChatSession({ contextSequence: this.context.getSequence() });
    this.config.log.info({ ms: Date.now() - t0, model: this.config.modelFile ?? HYMT2_MODEL_FILE, threads: this.config.threads }, 'Hy-MT2 model loaded');
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
        // Subtitle sentences are short; a hard cap keeps a runaway generation from stalling the queue.
        maxTokens: 128,
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
  /** Context sentences make the prompt (and the slow prefill) ~2× longer; the 1.8B model gains little from them. */
  readonly preferredContextSize = 0;
  constructor(
    private readonly runtime: HyMt2Runtime,
    readonly provider: string,
  ) {}
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
  const provider = config.provider ?? 'hy-mt2';
  return {
    provider,
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
    create: () => new HyMt2Adapter(runtime, provider),
    dispose: () => runtime.dispose(),
  };
}
