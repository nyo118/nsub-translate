/** Turn Chrome's terse tabCapture error into an actionable message with diagnostics. */
export function describeCaptureError(err: unknown, tabId: number, where: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  const hint = /not been invoked|activeTab/i.test(raw)
    ? ' Hint: open the popup by clicking the extension icon while the video tab is the active tab, then press Start. Reloading or navigating the page resets this permission, so reopen the popup afterwards.'
    : '';
  return `Tab capture failed in ${where} for tab ${tabId}: ${raw}${hint}`;
}
