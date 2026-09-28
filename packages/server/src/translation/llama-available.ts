import { createRequire } from 'node:module';

/**
 * node-llama-cpp is an *optional* dependency: a machine that translates
 * through LM Studio / Gemini never needs it (and may not be able to build
 * it). Everything that touches it goes through here so the rest of the
 * server compiles and runs without the package.
 */

export const LLAMA_PACKAGE = 'node-llama-cpp';

/** What the user should do on a machine without the package. */
export const LLAMA_MISSING_HINT = '本机翻译未安装（node-llama-cpp）；用 LM Studio 请在 popup 选「自定义 LLM」，要用本机翻译请执行 npm run setup:local-translation';

let cached: boolean | null = null;

/** True when node-llama-cpp is resolvable from this package (cheap, cached). */
export function isLlamaInstalled(): boolean {
  if (cached !== null) return cached;
  try {
    createRequire(import.meta.url).resolve(`${LLAMA_PACKAGE}/package.json`);
    cached = true;
  } catch {
    cached = false;
  }
  return cached;
}

/** Test hook. */
export function resetLlamaInstalledCache(): void {
  cached = null;
}

/**
 * Import node-llama-cpp without letting TypeScript resolve the module (a
 * variable specifier), so `tsc` succeeds when the package is absent.
 * Throws an actionable error when the package or its native binding cannot load.
 */
export async function importLlama<T = unknown>(): Promise<T> {
  const spec = LLAMA_PACKAGE;
  try {
    return (await import(spec)) as T;
  } catch (err) {
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new Error(`Local translation model engine unavailable: ${LLAMA_MISSING_HINT}（${reason}）`);
  }
}
