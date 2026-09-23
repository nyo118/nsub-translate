import { ChunkAssembler, Downsampler } from '../shared/audio/downsample.js';

/**
 * AudioWorkletProcessor: mixes the captured tab audio to mono, downsamples
 * to 16 kHz PCM16 and posts 100 ms chunks to the offscreen document.
 * Runs on the audio rendering thread; keep it allocation-light.
 */
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, ctor: unknown): void;

const TARGET_RATE = 16000;
const CHUNK_MS = 100;

class PcmWorklet extends AudioWorkletProcessor {
  private readonly downsampler = new Downsampler(sampleRate, TARGET_RATE);
  private readonly chunks = new ChunkAssembler((TARGET_RATE * CHUNK_MS) / 1000);
  private stopped = false;

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent) => {
      if (ev.data === 'stop') {
        this.stopped = true;
        this.chunks.flush((c) => this.emit(c));
      }
    };
  }

  private emit(chunk: Int16Array): void {
    const copy = new Int16Array(chunk); // detach a private buffer for transfer
    this.port.postMessage(copy.buffer, [copy.buffer]);
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const mono = Downsampler.mixToMono(channels);
    const pcm = this.downsampler.process(mono);
    if (pcm.length > 0) this.chunks.push(pcm, (c) => this.emit(c));
    return true;
  }
}

registerProcessor('lst-pcm', PcmWorklet);
