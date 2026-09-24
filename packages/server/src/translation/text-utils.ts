/** Models sometimes wrap output in code fences, backticks or quotes; strip them (only when they wrap the whole text). */
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

/** Human-readable target names for prompts. */
export const TARGET_NAMES: Record<string, string> = {
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
