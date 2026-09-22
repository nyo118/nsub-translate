/**
 * Tab-audio capture path inside the offscreen document.
 *
 *   getUserMedia(streamId) → MediaStream
 *        └─ MediaStreamAudioSourceNode ─┬─ AudioContext.destination (audible playback)
 *                                       └─ AnalyserNode (level meter only, nothing is recorded)
 *
 * Chrome silences a tab's own output while it is being captured, so the
 * playback connection is what keeps the video audible to the user.
 */
export interface AudioCaptureHandle {
  readonly stream: MediaStream;
  readonly context: AudioContext;
  /** RMS level in 0..1 of the most recent analysis window. */
  level(): number;
  /** Stop tracks, disconnect nodes, close the context. Idempotent. */
  release(): Promise<{ tracksStopped: number; audioContextState: string }>;
}

export async function startTabAudioCapture(streamId: string, onEnded: (reason: string) => void): Promise<AudioCaptureHandle> {
  // Chrome-specific constraints; not in the standard TS lib typings.
  const constraints = {
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  } as unknown as MediaStreamConstraints;

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  source.connect(context.destination); // keep the tab audible
  if (context.state === 'suspended') await context.resume();

  const buffer = new Uint8Array(analyser.fftSize);
  let released = false;

  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      if (!released) onEnded('audio track ended');
    });
  }

  return {
    stream,
    context,
    level() {
      if (released) return 0;
      analyser.getByteTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) {
        const v = ((buffer[i] ?? 128) - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / buffer.length);
    },
    async release() {
      if (released) return { tracksStopped: 0, audioContextState: context.state };
      released = true;
      const tracks = stream.getTracks();
      for (const track of tracks) track.stop();
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        /* already disconnected */
      }
      if (context.state !== 'closed') await context.close();
      return { tracksStopped: tracks.length, audioContextState: context.state };
    },
  };
}
