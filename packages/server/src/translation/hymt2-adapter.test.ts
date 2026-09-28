import { describe, expect, it } from 'vitest';
import { buildPrompt, cleanOutput, createHyMt2Factory, hyMt2TargetName } from './hymt2-adapter.js';

describe('Hy-MT2 prompt building', () => {
  it('uses the official template with the target language name and the source text', () => {
    const p = buildPrompt({ text: 'Hello world.', targetLanguage: 'zh-CN', context: [] });
    expect(p).toBe('将以下文本翻译为 `简体中文`，注意**只需要输出翻译后的结果，不要额外解释**：\n\n`Hello world.`');
  });
  it('prepends previous finals as context', () => {
    const p = buildPrompt({ text: 'He agreed.', targetLanguage: 'zh-TW', context: [{ source: 'Tom said yes.', translated: '湯姆說好。' }] });
    expect(p.startsWith('参考上文')).toBe(true);
    expect(p).toContain('- Tom said yes. → 湯姆說好。');
    expect(p).toContain('`繁體中文`');
  });
  it('maps target codes and rejects unknown ones', () => {
    expect(hyMt2TargetName('ja')).toBe('日本語');
    expect(hyMt2TargetName('yue')).toBe('繁體中文');
    expect(hyMt2TargetName('xx')).toBeNull();
  });
});

describe('cleanOutput', () => {
  it('strips code fences, backticks and wrapping quotes', () => {
    expect(cleanOutput('```\n你好\n```')).toBe('你好');
    expect(cleanOutput('`你好`')).toBe('你好');
    expect(cleanOutput('"你好"')).toBe('你好');
    expect(cleanOutput('  你好，世界。 ')).toBe('你好，世界。');
    expect(cleanOutput('他说"好"。')).toBe('他说"好"。');
    expect(cleanOutput('“因为不久前还在努力，所以会有点遗憾吧。”')).toBe('因为不久前还在努力，所以会有点遗憾吧。');
    expect(cleanOutput('“他说”，然后走了。“真的”')).toBe('“他说”，然后走了。“真的”'); // inner quotes → not a wrapper
  });
});

describe('Hy-MT2 factory without node-llama-cpp (optional dependency)', () => {
  it('fails prepare() with an actionable message and never downloads the model', async () => {
    let ensured = 0;
    const factory = createHyMt2Factory({
      modelsDir: '/nonexistent',
      threads: 1,
      log: { info: () => {}, warn: () => {} },
      ensureModel: async () => void ensured++,
      loadLlama: async () => {
        throw new Error('Local translation model engine unavailable: 本机翻译未安装（node-llama-cpp）');
      },
    });
    await expect(factory.prepare()).rejects.toThrow(/node-llama-cpp/);
    expect(ensured).toBe(0);
  });
  it('importLlama wraps a missing package in the hint (protocol handler maps "translation model" to translation_unavailable)', async () => {
    const { importLlama, isLlamaInstalled, resetLlamaInstalledCache, LLAMA_MISSING_HINT } = await import('./llama-available.js');
    // node-llama-cpp *is* installed in this repo (exercising the real failure needs the LM Studio setup path).
    resetLlamaInstalledCache();
    expect(isLlamaInstalled()).toBe(true);
    expect(LLAMA_MISSING_HINT).toContain('LM Studio');
    expect(LLAMA_MISSING_HINT).toContain('setup:local-translation');
    expect(typeof importLlama).toBe('function');
  });
});
