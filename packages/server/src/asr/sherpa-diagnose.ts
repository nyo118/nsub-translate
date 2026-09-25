import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

/**
 * sherpa-onnx-node swallows every load error and reports a generic
 * "Could not find sherpa-onnx-node". This turns the situation into an
 * actionable message: which platform package is expected, whether it is
 * installed, and what to do on each OS.
 */
export interface SherpaDiagnosis {
  ok: boolean;
  platformPackage: string;
  message: string;
}

export function diagnoseSherpa(fromUrl: string): SherpaDiagnosis {
  const require = createRequire(fromUrl);
  const platform = os.platform() === 'win32' ? 'win' : os.platform();
  const platformPackage = `sherpa-onnx-${platform}-${os.arch()}`;
  const supported = ['sherpa-onnx-darwin-arm64', 'sherpa-onnx-darwin-x64', 'sherpa-onnx-linux-x64', 'sherpa-onnx-linux-arm64', 'sherpa-onnx-win-x64', 'sherpa-onnx-win-ia32'];
  let pkgDir: string | null = null;
  try {
    pkgDir = path.dirname(require.resolve(`${platformPackage}/package.json`));
  } catch {
    pkgDir = null;
  }
  const lines: string[] = [];
  if (!supported.includes(platformPackage)) {
    lines.push(`This platform (${os.platform()} ${os.arch()}) has no prebuilt sherpa-onnx binary; supported: ${supported.join(', ')}.`);
    return { ok: false, platformPackage, message: lines.join('\n') };
  }
  if (pkgDir === null) {
    lines.push(`The native package "${platformPackage}" is not installed.`);
    lines.push('Fix: run `npm ci` in the repository root (not inside packages/server), with Node 22 (`nvm use`).');
    lines.push('If you installed with `--omit=optional` / `--no-optional`, reinstall without it: the platform binaries are optional dependencies.');
    return { ok: false, platformPackage, message: lines.join('\n') };
  }
  const addon = path.join(pkgDir, 'sherpa-onnx.node');
  if (!existsSync(addon)) {
    lines.push(`"${platformPackage}" is installed at ${pkgDir} but sherpa-onnx.node is missing — the install is corrupt. Fix: rm -rf node_modules && npm ci`);
    return { ok: false, platformPackage, message: lines.join('\n') };
  }
  // The package is there; try to load it for real to catch dynamic-library problems.
  try {
    require('sherpa-onnx-node');
    return { ok: true, platformPackage, message: `sherpa-onnx loaded from ${pkgDir}` };
  } catch (err) {
    const raw = err instanceof Error ? err.message.split('\n')[0] : String(err);
    lines.push(`"${platformPackage}" is installed at ${pkgDir} but its native library failed to load (${raw}).`);
    if (os.platform() === 'darwin') {
      lines.push('macOS fixes, in order:');
      lines.push(`  1. Apple Silicon refuses unsigned arm64 libraries — ad-hoc sign them:  codesign --force --sign - "${pkgDir}"/*.dylib "${pkgDir}"/*.node`);
      lines.push(`  2. Remove the quarantine flag Gatekeeper puts on downloaded binaries:  xattr -dr com.apple.quarantine "${pkgDir}"`);
      lines.push(`  3. Make sure Node's architecture matches the machine (\`node -p process.arch\`: Intel Mac → x64, Apple Silicon → arm64; a Rosetta x64 Node needs sherpa-onnx-darwin-x64).`);
      lines.push(`  4. Last resort: export DYLD_LIBRARY_PATH="${pkgDir}:$DYLD_LIBRARY_PATH" before starting the backend.`);
    } else if (os.platform() === 'linux') {
      lines.push(`Linux fix: export LD_LIBRARY_PATH="${pkgDir}:$LD_LIBRARY_PATH" (glibc ≥ 2.17 required).`);
    } else {
      lines.push('Windows fix: make sure the Visual C++ runtime is installed and Node is 64-bit.');
    }
    return { ok: false, platformPackage, message: lines.join('\n') };
  }
}
