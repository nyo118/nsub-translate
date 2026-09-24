/**
 * Turn raw error strings (backend codes, Chrome messages) into short,
 * actionable Chinese for the popup. The raw text stays available in the
 * diagnostics section.
 */
export function friendlyError(raw: string): string {
  const r = raw;
  if (/Could not connect to the local backend|ECONNREFUSED|close code 1006\)/.test(r)) return '本地后端未运行。请在终端执行 npm run dev:server，等待模型加载完成后再开始。';
  if (/reconnect failed|Backend connection lost/.test(r)) return '与本地后端的连接已断开且重连失败。请确认后端仍在运行（终端无报错），然后重新开始。';
  if (/translation_unavailable|failed its warm-up|requires .*API_KEY|Missing translation model/.test(r)) return `所选翻译引擎不可用：${r.replace(/^.*?:\s*/, '')}`;
  if (/asr_unavailable|Missing ASR model|ASR worker/.test(r)) return `语音识别不可用：${r}`;
  if (/not been invoked|activeTab/.test(r)) return '需要先在视频标签页点击扩展图标打开 popup，再按开始（刷新页面后要重新打开 popup）。';
  if (/Content script is not loaded/.test(r)) return '页面需要刷新一次，扩展才能在这个标签页工作。';
  if (/not a YouTube or Twitch page/.test(r)) return '请在 YouTube 或 Twitch 的影片页使用。';
  if (/No .* video player found/.test(r)) return '这个页面上没有找到播放器，请先打开一个影片。';
  if (/session limit|时长上限/.test(r)) return r;
  if (/getUserMedia|NotAllowedError|Permission denied/.test(r)) return `无法捕获标签页音频：${r}`;
  return r;
}
