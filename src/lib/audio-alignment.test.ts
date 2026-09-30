import test from 'node:test';
import assert from 'node:assert/strict';
import { alignPcmToScore, audioPositionAtTime, audioTimeAtPosition } from './audio-alignment.ts';
import type { ScoreReference } from './score-following/types.ts';

const pitches = [48, 52, 55, 60, 57, 53, 50, 55, 59, 62, 65, 60, 55, 52, 50, 48];
const reference: ScoreReference = {
  initialTempo: 100,
  events: pitches.map((pitch, index) => ({ midi: [pitch], beat: index, durationBeats: 1, position: (index + 0.2) / 8 })),
};

function recording(notes: number[][], durations: number[], sampleRate = 22050, leading = 0.65, trailing = 0.8) {
  let time = leading;
  const starts = durations.map((duration) => { const start = time; time += duration; return start; });
  const pcm = new Float32Array(Math.ceil((time + trailing) * sampleRate));
  notes.forEach((chord, index) => {
    const first = Math.round(starts[index] * sampleRate);
    const length = Math.round(durations[index] * sampleRate);
    for (let sample = 0; sample < length; sample++) {
      const t = sample / sampleRate;
      const fade = Math.min(1, t / 0.007) * Math.min(1, (length - sample) / (sampleRate * 0.015));
      const envelope = fade * Math.exp(-t / Math.max(0.25, durations[index]));
      pcm[first + sample] = chord.reduce((sum, pitch) => {
        const frequency = 440 * 2 ** ((pitch - 69) / 12);
        return sum + [1, 0.5, 0.25, 0.12].reduce((overtones, gain, harmonic) => overtones + gain * Math.sin(2 * Math.PI * frequency * (harmonic + 1) * t), 0);
      }, 0) * 0.16 * envelope / chord.length;
    }
  });
  return { pcm, sampleRate, starts, end: time };
}

const durations = pitches.map((_, i) => [0.42, 0.7, 0.36, 0.85, 0.48][i % 5]);

test('real harmonic PCM creates monotone anchors at variable note durations, including page start and audio end', async () => {
  const audio = recording(pitches.map((pitch) => [pitch]), durations);
  const alignment = await alignPcmToScore(audio.pcm, audio.sampleRate, reference, 2);
  assert.ok(alignment.confidence > 0.85);
  assert.equal(alignment.coverage, 1);
  assert.equal(alignment.pageConfidence.length, 2);
  reference.events.forEach((event, index) => {
    const point = alignment.points.find((item) => item.position === event.position)!;
    assert.ok(Math.abs(point.time - audio.starts[index]) < 0.13, `event ${index}: matched ${point.time}, true ${audio.starts[index]}`);
  });
  alignment.points.forEach((point, index) => {
    if (index) { assert.ok(point.time >= alignment.points[index - 1].time); assert.ok(point.position >= alignment.points[index - 1].position); }
  });
  assert.equal(audioPositionAtTime(alignment, 0, alignment.duration, 2), 0);
  assert.ok(audioPositionAtTime(alignment, 0.2, alignment.duration, 2) < 0.02);
  const pageTime = audioTimeAtPosition(alignment, 1, alignment.duration, 2);
  assert.ok(Math.abs(pageTime - audio.starts[8]) < 0.13);
  assert.ok(audioPositionAtTime(alignment, pageTime - 0.001, alignment.duration, 2) < 1, 'does not turn before confirmed next-page note');
  assert.ok(audioPositionAtTime(alignment, pageTime, alignment.duration, 2) >= 1);
  assert.equal(audioPositionAtTime(alignment, alignment.duration, alignment.duration, 2), 2);
  assert.ok(Math.abs(audioTimeAtPosition(alignment, 2, alignment.duration, 2) - audio.end) < 0.15);
});

test('44.1 kHz polyphonic PCM and different overall tempo align from acoustics', async () => {
  const chords = pitches.map((pitch) => [pitch, pitch + 4, pitch + 7]);
  const score = { ...reference, events: reference.events.map((event, i) => ({ ...event, midi: chords[i] })) };
  const audio = recording(chords, durations.map((duration) => duration * 1.4), 44100, 1.4);
  const alignment = await alignPcmToScore(audio.pcm, audio.sampleRate, score, 2);
  assert.ok(alignment.confidence > 0.85);
  assert.ok(Math.abs(audioTimeAtPosition(alignment, 1, alignment.duration, 2) - audio.starts[8]) < 0.15);
});

test('silence, unrelated pitches, same-note-set wrong order, and incomplete music reject instead of generating a timeline', async () => {
  await assert.rejects(alignPcmToScore(new Float32Array(22050 * 5), 22050, reference, 2), /静音|过短/);
  for (const notes of [pitches.map((pitch) => [pitch + 1]), [...pitches].reverse().map((pitch) => [pitch]), pitches.slice(0, 8).map((pitch) => [pitch])]) {
    const audio = recording(notes, durations.slice(0, notes.length));
    await assert.rejects(alignPcmToScore(audio.pcm, audio.sampleRate, reference, 2), /匹配|覆盖|定位/);
  }
});

test('broadband noise and an unplayed page cannot pass per-page confidence gates', async () => {
  let seed = 71;
  const noise = Float32Array.from({ length: 22050 * 8 }, () => { seed = (1664525 * seed + 1013904223) >>> 0; return (seed / 2 ** 32 - 0.5) * 0.1; });
  await assert.rejects(alignPcmToScore(noise, 22050, reference, 2), /匹配|定位/);
  const audio = recording(pitches.map((pitch, i) => [i < 8 ? pitch : 61]), durations);
  await assert.rejects(alignPcmToScore(audio.pcm, audio.sampleRate, reference, 2), /匹配|定位/);
});

test('repeated score pitches require separate acoustic attacks', async () => {
  const repeated = [48, 52, 52, 52, 55, 60, 57, 53];
  const score = { events: repeated.map((pitch, i) => ({ midi: [pitch], beat: i, durationBeats: 1, position: (i + 0.2) / 8 })) };
  const audio = recording(repeated.map((pitch) => [pitch]), repeated.map(() => 0.45));
  const aligned = await alignPcmToScore(audio.pcm, audio.sampleRate, score, 1);
  assert.ok(aligned.confidence > 0.85);
  const sustained = recording([[48], [52], [55], [60], [57], [53]], [0.45, 1.35, 0.45, 0.45, 0.45, 0.45]);
  await assert.rejects(alignPcmToScore(sustained.pcm, sustained.sampleRate, score, 1), /匹配|定位/);
});

test('malformed, empty-page, insufficient, and excessive-duration inputs are rejected', async () => {
  const pcm = new Float32Array(22050 * 2);
  await assert.rejects(alignPcmToScore(pcm, NaN, reference, 2), /采样率/);
  await assert.rejects(alignPcmToScore(pcm, 22050, { events: [] }, 2), /参考不足/);
  await assert.rejects(alignPcmToScore(pcm, 22050, reference, 3), /第 3 页/);
  await assert.rejects(alignPcmToScore(new Float32Array(8000 * 481), 8000, reference, 2), /8 分钟/);
  const invalid = { events: reference.events.map((event) => ({ ...event, position: NaN })) };
  await assert.rejects(alignPcmToScore(pcm, 22050, invalid, 2), /顺序无效/);
});

test('a long silent rest at a page boundary does not advance to the next page', async () => {
  const audio = recording(pitches.map((pitch) => [pitch]), durations);
  const pauseAt = Math.round(audio.starts[8] * audio.sampleRate);
  const pauseSamples = Math.round(1.6 * audio.sampleRate);
  const pcm = new Float32Array(audio.pcm.length + pauseSamples);
  pcm.set(audio.pcm.subarray(0, pauseAt));
  pcm.set(audio.pcm.subarray(pauseAt), pauseAt + pauseSamples);
  const alignment = await alignPcmToScore(pcm, audio.sampleRate, reference, 2);
  const secondPage = audioTimeAtPosition(alignment, 1, alignment.duration, 2);
  assert.ok(Math.abs(secondPage - (audio.starts[8] + 1.6)) < 0.13);
  assert.ok(audioPositionAtTime(alignment, audio.starts[8] + 1.4, alignment.duration, 2) < 1);
});

test('alignment responds to abort before work and during a scheduled analysis slice', async () => {
  const audio = recording(pitches.map((pitch) => [pitch]), durations);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(alignPcmToScore(audio.pcm, audio.sampleRate, reference, 2, undefined, controller.signal), { name: 'AbortError' });
  const during = new AbortController();
  setTimeout(() => during.abort(), 0);
  await assert.rejects(alignPcmToScore(audio.pcm, audio.sampleRate, reference, 2, undefined, during.signal), { name: 'AbortError' });
});

test('audio importer validates metadata before decoding and closes resources on success, decode failure, and cancellation', async () => {
  const { importAudio } = await import('./import-audio.ts');
  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, 'Audio');
  const originalContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const originalRevoke = URL.revokeObjectURL;
  const fixture = recording(pitches.map((pitch) => [pitch]), durations);
  let metadataDuration = fixture.pcm.length / fixture.sampleRate;
  let closed = 0;
  let revoked = 0;
  let decoded = 0;
  let failDecode = false;
  let decodeCallback: (() => void) | undefined;
  class MockAudio {
    duration = metadataDuration;
    preload = '';
    onloadedmetadata: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onloadedmetadata?.()); }
    removeAttribute() {}
    load() {}
  }
  class MockContext {
    state = 'suspended';
    async decodeAudioData() {
      decoded++;
      decodeCallback?.();
      if (failDecode) throw new Error('bad codec');
      return { duration: fixture.pcm.length / fixture.sampleRate, sampleRate: fixture.sampleRate, length: fixture.pcm.length, numberOfChannels: 1, getChannelData: () => fixture.pcm };
    }
    async close() { closed++; this.state = 'closed'; }
  }
  Object.defineProperty(globalThis, 'Audio', { configurable: true, value: MockAudio });
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: MockContext });
  URL.revokeObjectURL = (url) => { revoked++; originalRevoke.call(URL, url); };
  const file = new File([new Uint8Array([1, 2, 3])], 'piece.wav', { type: 'audio/wav' });
  try {
    const result = await importAudio(file, reference, 2);
    assert.equal(result.blob, file);
    assert.ok(result.alignment.confidence > 0.85);
    assert.equal(closed, 1);
    assert.equal(revoked, 1);
    failDecode = true;
    await assert.rejects(importAudio(file, reference, 2), /无法解码/);
    assert.equal(closed, 2);
    failDecode = false;
    metadataDuration = 481;
    await assert.rejects(importAudio(file, reference, 2), /8 分钟/);
    assert.equal(decoded, 2, 'oversized decoded duration never reaches decoder');
    assert.equal(closed, 2);
    metadataDuration = fixture.pcm.length / fixture.sampleRate;
    const canceled = new AbortController();
    decodeCallback = () => canceled.abort();
    await assert.rejects(importAudio(file, reference, 2, undefined, canceled.signal), { name: 'AbortError' });
    assert.equal(closed, 3);
    assert.equal(revoked, 4);
  } finally {
    if (originalAudio) Object.defineProperty(globalThis, 'Audio', originalAudio); else Reflect.deleteProperty(globalThis, 'Audio');
    if (originalContext) Object.defineProperty(globalThis, 'AudioContext', originalContext); else Reflect.deleteProperty(globalThis, 'AudioContext');
    URL.revokeObjectURL = originalRevoke;
  }
});

test('one held C attack cannot supply two C score notes, including a page boundary', async () => {
  const sampleRate = 22050;
  const pcm = new Float32Array(9 * sampleRate);
  const actual = [60, 64, 67, 62, 65, 69];
  let time = 0.5;
  actual.forEach((pitch, index) => {
    const length = (index === 0 ? 2 : 1) * sampleRate;
    const start = Math.round(time * sampleRate);
    const frequency = 440 * 2 ** ((pitch - 69) / 12);
    for (let sample = 0; sample < length; sample++) {
      const t = sample / sampleRate;
      pcm[start + sample] = 0.2 * Math.min(1, t / 0.01) * Math.min(1, (length - sample) / (sampleRate * 0.01)) * Math.exp(-t / 3) * Math.sin(2 * Math.PI * frequency * t);
    }
    time += length / sampleRate;
  });
  const notes = [60, 60, 64, 67, 62, 65, 69];
  for (const pageCount of [1, 2]) {
    const score = { events: notes.map((pitch, i) => ({ midi: [pitch], beat: i, durationBeats: 1, position: pageCount === 1 ? i / 7 : i === 0 ? 0.9 : 1 + (i - 1) / 7 })) };
    await assert.rejects(alignPcmToScore(pcm, sampleRate, score, pageCount), /匹配|定位|起音/);
  }
});

test('distinct same-pitch plucks 100 ms apart retain their own alignment anchors', async () => {
  const pitches = [48, 52, 52, 52, 55, 60, 57, 53];
  const durations = [0.45, 0.1, 0.1, 0.45, 0.45, 0.45, 0.45, 0.45];
  const score = { events: pitches.map((pitch, i) => ({ midi: [pitch], beat: i, durationBeats: 1, position: (i + 0.2) / pitches.length })) };
  const audio = recording(pitches.map((pitch) => [pitch]), durations, 22050, 0.5);
  const alignment = await alignPcmToScore(audio.pcm, audio.sampleRate, score, 1);
  for (let i = 1; i <= 3; i++) {
    const point = alignment.points.find((item) => item.position === score.events[i].position)!;
    assert.ok(Math.abs(point.time - audio.starts[i]) < 0.09, `repeat ${i}: matched ${point.time}, true ${audio.starts[i]}`);
  }
});
