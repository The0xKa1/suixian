import { createAudioFeatureExtractor } from './chroma.ts';
import type { AudioScoreFrame } from './types.ts';

interface MicrophoneDependencies {
  createContext: () => AudioContext;
  getUserMedia: () => Promise<MediaStream>;
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (handle: number) => void;
}

/** Owns permission races, tracks, graph and animation callbacks as one cancellable session. */
export function createMicrophoneSession(dependencies?: MicrophoneDependencies) {
  const deps = dependencies ?? {
    createContext: () => new AudioContext(),
    getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false }),
    requestFrame: (callback: FrameRequestCallback) => requestAnimationFrame(callback),
    cancelFrame: (handle: number) => cancelAnimationFrame(handle),
  };
  let generation = 0;
  let context: AudioContext | undefined;
  let stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let analyser: AnalyserNode | undefined;
  let frameHandle: number | undefined;

  function stop() {
    generation++;
    if (frameHandle !== undefined) deps.cancelFrame(frameHandle);
    frameHandle = undefined;
    if (stream) for (const track of stream.getTracks()) { track.onended = null; track.stop(); }
    stream = undefined;
    source?.disconnect();
    source = undefined;
    analyser?.disconnect();
    analyser = undefined;
    const retiring = context;
    context = undefined;
    if (retiring && retiring.state !== 'closed') void retiring.close().catch(() => undefined);
  }

  return {
    stop,
    async start(onFrame: (frame: AudioScoreFrame) => void, onEnded: () => void): Promise<boolean> {
      stop();
      const token = generation;
      let localStream: MediaStream | undefined;
      try {
        // Create/resume directly from the click call stack; never connect microphone to output.
        const localContext = deps.createContext();
        context = localContext;
        const resume = localContext.resume();
        // Handle resume rejection immediately even while a permission prompt remains pending.
        const resumed = resume.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
        localStream = await deps.getUserMedia();
        if (generation !== token) {
          localStream.getTracks().forEach((track) => track.stop());
          return false;
        }
        stream = localStream;
        const resumeResult = await resumed;
        if (generation !== token) return false;
        if (!resumeResult.ok) throw resumeResult.error;
        analyser = localContext.createAnalyser();
        analyser.fftSize = 8192;
        analyser.smoothingTimeConstant = 0;
        source = localContext.createMediaStreamSource(localStream);
        source.connect(analyser);
        const localAnalyser = analyser;
        const samples = new Float32Array(localAnalyser.fftSize);
        const extractor = createAudioFeatureExtractor(localContext.sampleRate, localAnalyser.fftSize);
        for (const track of localStream.getTracks()) track.onended = () => {
          if (generation !== token) return;
          stop();
          onEnded();
        };
        let lastFrame = -Infinity;
        const tick = (timestamp: number) => {
          if (generation !== token) return;
          if (timestamp - lastFrame >= 45) {
            lastFrame = timestamp;
            localAnalyser.getFloatTimeDomainData(samples);
            onFrame(extractor.process(samples, timestamp));
          }
          if (generation === token) frameHandle = deps.requestFrame(tick);
        };
        frameHandle = deps.requestFrame(tick);
        return true;
      } catch (error) {
        if (generation === token) { stop(); throw error; }
        localStream?.getTracks().forEach((track) => track.stop());
        return false;
      }
    },
  };
}
