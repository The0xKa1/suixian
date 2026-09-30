import test from 'node:test';
import assert from 'node:assert/strict';
import { createMicrophoneSession } from './microphone.ts';

function harness() {
  const pending: Array<{ resolve: (stream: MediaStream) => void; reject: (error: Error) => void }> = [];
  const callbacks = new Map<number, FrameRequestCallback>();
  const contexts: Array<{ closed: number; sourceDisconnected: number; analyserDisconnected: number; connectedToOutput: boolean }> = [];
  let handle = 0;
  const session = createMicrophoneSession({
    createContext: () => {
      const state = { closed: 0, sourceDisconnected: 0, analyserDisconnected: 0, connectedToOutput: false };
      contexts.push(state);
      const analyser = { fftSize: 8192, smoothingTimeConstant: 0, disconnect: () => state.analyserDisconnected++, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0) };
      return {
        state: 'running', sampleRate: 48000, destination: {}, resume: () => Promise.resolve(),
        close: () => { state.closed++; return Promise.resolve(); },
        createAnalyser: () => analyser,
        createMediaStreamSource: () => ({ connect: (target: unknown) => { if (target !== analyser) state.connectedToOutput = true; }, disconnect: () => state.sourceDisconnected++ }),
      } as unknown as AudioContext;
    },
    getUserMedia: () => new Promise<MediaStream>((resolve, reject) => pending.push({ resolve, reject })),
    requestFrame: (callback) => { callbacks.set(++handle, callback); return handle; },
    cancelFrame: (id) => { callbacks.delete(id); },
  });
  const stream = () => {
    const track = { stopped: 0, onended: null as (() => void) | null, stop() { this.stopped++; } };
    return { track, media: { getTracks: () => [track] } as unknown as MediaStream };
  };
  return { session, pending, callbacks, contexts, stream };
}

test('stop during permission prompt disposes the context and any stream that arrives later', async () => {
  const h = harness();
  const opening = h.session.start(() => assert.fail('must not produce audio'), () => undefined);
  h.session.stop();
  const stream = h.stream();
  h.pending[0].resolve(stream.media);
  assert.equal(await opening, false);
  assert.equal(stream.track.stopped, 1);
  assert.equal(h.contexts[0].closed, 1);
  assert.equal(h.callbacks.size, 0);
});

test('new capture survives a superseded permission request and stop releases all resources', async () => {
  const h = harness();
  let frames = 0;
  const stale = h.session.start(() => assert.fail('stale session'), () => undefined);
  const current = h.session.start(() => frames++, () => undefined);
  const currentStream = h.stream();
  h.pending[1].resolve(currentStream.media);
  assert.equal(await current, true);
  const staleStream = h.stream();
  h.pending[0].resolve(staleStream.media);
  assert.equal(await stale, false);
  assert.equal(staleStream.track.stopped, 1);
  assert.equal(currentStream.track.stopped, 0);
  const [id, tick] = [...h.callbacks][0];
  h.callbacks.delete(id);
  tick(100);
  assert.equal(frames, 1);
  h.session.stop();
  assert.equal(currentStream.track.stopped, 1);
  assert.equal(h.contexts[1].closed, 1);
  assert.equal(h.contexts[1].sourceDisconnected, 1);
  assert.equal(h.contexts[1].analyserDisconnected, 1);
  assert.equal(h.callbacks.size, 0);
  assert.ok(h.contexts.every((context) => !context.connectedToOutput));
});

test('permission rejection, device removal and repeated cleanup are safe', async () => {
  const h = harness();
  const denied = h.session.start(() => undefined, () => undefined);
  h.pending[0].reject(new Error('permission denied'));
  await assert.rejects(denied, /permission denied/);
  assert.equal(h.contexts[0].closed, 1);
  let ended = 0;
  const opened = h.session.start(() => undefined, () => ended++);
  const stream = h.stream();
  h.pending[1].resolve(stream.media);
  await opened;
  stream.track.onended?.();
  assert.equal(ended, 1);
  assert.equal(stream.track.stopped, 1);
  assert.equal(h.callbacks.size, 0);
  h.session.stop();
  assert.equal(h.contexts[1].closed, 1);
});
