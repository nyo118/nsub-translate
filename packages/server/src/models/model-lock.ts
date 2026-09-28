import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** models.lock.json — the single description of every model file the backend needs. */
export interface ModelArchiveSpec {
  url: string;
  format: 'tar.bz2';
  sizeBytes?: number;
}
export interface ModelFileSpec {
  sha256: string;
  /** Direct download URL (mutually exclusive with `archive`). */
  url?: string;
  /** Name of an entry in `archives` that contains this file. */
  archive?: string;
  sizeBytes?: number;
  group: ModelGroupName;
}

/**
 * asr: VAD + SenseVoice (required). translation: local Hy-MT2 (on demand).
 * enhance: GTCRN speech denoiser (on demand, `options.denoise`).
 * diarization: pyannote segmentation + 3D-Speaker embedding (on demand, `options.diarize`).
 */
export const MODEL_GROUPS = ['asr', 'translation', 'enhance', 'diarization'] as const;
export type ModelGroupName = (typeof MODEL_GROUPS)[number];
export interface ModelLock {
  version: number;
  archives: Record<string, ModelArchiveSpec>;
  files: Record<string, ModelFileSpec>;
}

export function defaultLockPath(): string {
  // packages/server/src/models → repo root
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'models.lock.json');
}

export function loadModelLock(file = defaultLockPath()): ModelLock {
  const lock = JSON.parse(readFileSync(file, 'utf8')) as ModelLock;
  if (lock.version !== 1 || typeof lock.files !== 'object') throw new Error(`unsupported models.lock.json at ${file}`);
  return lock;
}

export function filesInGroup(lock: ModelLock, group: ModelFileSpec['group']): string[] {
  return Object.entries(lock.files)
    .filter(([, spec]) => spec.group === group)
    .map(([rel]) => rel);
}
