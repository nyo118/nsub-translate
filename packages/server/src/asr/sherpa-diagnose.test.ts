import { describe, expect, it } from 'vitest';
import { diagnoseSherpa } from './sherpa-diagnose.js';

describe('diagnoseSherpa', () => {
  it('reports the expected platform package and a definite verdict', () => {
    const d = diagnoseSherpa(import.meta.url);
    expect(d.platformPackage).toMatch(/^sherpa-onnx-(darwin|linux|win)-(x64|arm64|ia32)$/);
    expect(typeof d.ok).toBe('boolean');
    expect(d.message.length).toBeGreaterThan(10);
    if (!d.ok) expect(d.message).toMatch(/npm ci|DYLD_LIBRARY_PATH|LD_LIBRARY_PATH|quarantine|no prebuilt/);
  });
});
