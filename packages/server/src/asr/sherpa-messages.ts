import type { DenoiserName, OverlapMode } from '@lst/protocol';
import type { SenseVoiceLanguage } from './languages.js';
import type { AsrMetricsSample, AsrTranscript } from './types.js';

export type WorkerInbound =
  | { t: 'preload' }
  | { t: 'start'; sessionId: string; language: SenseVoiceLanguage; denoise: boolean; denoiser: DenoiserName; diarize: boolean; overlap: OverlapMode }
  | { t: 'audio'; sessionId: string; pcm: ArrayBuffer; sentAt: number }
  | { t: 'stop'; sessionId: string };

export type WorkerOutbound =
  | { t: 'loaded' }
  | { t: 'started'; sessionId: string; language: string; denoise: boolean; diarize: boolean; denoiser?: DenoiserName; speakerModel?: string }
  | { t: 'transcript'; sessionId: string; transcript: AsrTranscript }
  | { t: 'metrics'; sessionId: string; sample: AsrMetricsSample }
  | { t: 'stopped'; sessionId: string }
  | { t: 'error'; sessionId?: string | undefined; code: 'asr_unavailable' | 'asr_failed'; message: string };
