import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioFeatureExtractor, chromaSimilarity, midiToChroma } from './chroma.ts';
import { createScoreFollower } from './follower.ts';
import type { ScoreReference } from './types.ts';
import { createDemoScore } from '../demo-score.ts';

function reference(pitches = [48, 55, 60, 64], positions?: number[]): ScoreReference {
  return { initialTempo: 72, events: pitches.map((pitch, i) => ({ midi: [pitch], beat: i * 0.5, durationBeats: 0.5, position: positions?.[i] ?? i / 4 })) };
}

const frame = (pitch: number, timestampMs: number, onset = false) => ({ chroma: midiToChroma([pitch]), timestampMs, onset, rms: 0.1 });

test('silence and unrelated pitches never advance or accumulate evidence', () => {
  const follower = createScoreFollower(reference());
  for (let time = 0; time < 5000; time += 50) follower.process({ ...frame(48, time, true), rms: 0 });
  assert.equal(follower.getResult().position, 0);
  assert.equal(follower.getResult().state, 'silent');
  for (let time = 5000; time < 10000; time += 50) follower.process(frame(61, time, true));
  assert.equal(follower.getResult().eventIndex, 0);
  assert.equal(follower.getResult().position, 0);
  assert.equal(follower.getResult().state, 'uncertain');
});

test('following adapts to uneven note timing and freezes after confirmed position', () => {
  const follower = createScoreFollower(reference());
  let time = 0;
  for (const [pitch, frames] of [[48, 12], [55, 6], [60, 18], [64, 8]]) {
    for (let i = 0; i < frames; i++, time += 50) follower.process(frame(pitch, time, i === 0));
  }
  assert.equal(follower.getResult().eventIndex, 3);
  assert.equal(follower.getResult().state, 'complete');
  const previous = follower.getResult().position;
  follower.process({ ...frame(64, time + 60000), rms: 0 });
  assert.equal(follower.getResult().position, previous);
});

test('sustained repeated pitch cannot consume later identical notes without new onsets', () => {
  const follower = createScoreFollower(reference([60, 60, 60]));
  for (let time = 0; time < 3000; time += 50) follower.process(frame(60, time, time === 0));
  assert.equal(follower.getResult().eventIndex, 0);
  for (let time = 3000; time < 3400; time += 50) follower.process(frame(60, time, time === 3000));
  assert.equal(follower.getResult().eventIndex, 1);
  for (let time = 3400; time < 8000; time += 50) follower.process(frame(60, time));
  assert.equal(follower.getResult().eventIndex, 1);
});

test('one-frame transients, missing notes, stale timestamps and invalid frames cannot flip a page', () => {
  const follower = createScoreFollower(reference([60, 62, 64], [0.95, 1.02, 1.2]));
  for (let time = 0; time < 300; time += 50) follower.process(frame(60, time, time === 0));
  assert.equal(follower.getResult().position, 0.95);
  follower.process(frame(62, 300, true));
  follower.process(frame(61, 350));
  for (let time = 400; time < 1000; time += 50) follower.process(frame(64, time, true));
  assert.equal(follower.getResult().position, 0.95, 'cannot skip the unobserved D');
  follower.process(frame(62, 100, true));
  follower.process({ ...frame(62, 1100, true), chroma: [NaN] });
  assert.equal(follower.getResult().position, 0.95);
  follower.reset(1.02);
  assert.equal(follower.getResult().eventIndex, 1);
  for (let time = 0; time < 300; time += 50) follower.process(frame(62, time, time === 0));
  assert.equal(follower.getResult().state, 'tracking');
});

function guitarFrame(pitches: number[], sampleRate: number, offsetSeconds: number, gain = 0.12): Float32Array {
  return Float32Array.from({ length: 8192 }, (_, sample) => {
    const time = offsetSeconds + sample / sampleRate;
    return gain * pitches.reduce((sum, pitch) => {
      const frequency = 440 * 2 ** ((pitch - 69) / 12);
      return sum + [1, 0.52, 0.29, 0.17, 0.09].reduce((harmonics, amplitude, i) => harmonics + amplitude * Math.sin(2 * Math.PI * frequency * (i + 1) * time + i * 0.17), 0);
    }, 0) / Math.max(1, pitches.length);
  });
}

test('PCM spectral features distinguish low guitar notes, harmonics, chords and sample rates', () => {
  for (const sampleRate of [44100, 48000]) {
    for (const pitches of [[40], [45], [48], [55], [60], [64], [67], [72], [48, 52, 55]]) {
      const extractor = createAudioFeatureExtractor(sampleRate);
      const feature = extractor.process(guitarFrame(pitches, sampleRate, 0), 0);
      assert.ok(feature.rms > 0.03);
      assert.ok(chromaSimilarity(feature.chroma, midiToChroma(pitches)) > 0.89, `${sampleRate} Hz / ${pitches}`);
      if (pitches.length === 1) assert.ok(chromaSimilarity(feature.chroma, midiToChroma([pitches[0] + 1])) < 0.3);
    }
  }
});

test('all 192 original TAB events follow real harmonic PCM across both page boundaries', () => {
  const score = createDemoScore();
  assert.ok(score.reference);
  assert.equal(score.reference.events.length, 192);
  const follower = createScoreFollower(score.reference);
  const extractor = createAudioFeatureExtractor(48000);
  let time = 0;
  for (let eventIndex = 0; eventIndex < score.reference.events.length; eventIndex++) {
    const event = score.reference.events[eventIndex];
    const steps = 7 + eventIndex % 5;
    for (let step = 0; step < steps; step++, time += 50) {
      // Acoustic decay and variable duration; no hand-supplied chroma or onset flags.
      const pcm = guitarFrame(event.midi, 48000, time / 1000, 0.14 * Math.exp(-step / 8));
      follower.process(extractor.process(pcm, time));
    }
    assert.equal(follower.getResult().eventIndex, eventIndex, `stalled at score event ${eventIndex}: ${event.midi}`);
    if (eventIndex === 63 || eventIndex === 127) {
      const beforePause = follower.getResult().position;
      for (let step = 0; step < 15; step++, time += 50) follower.process(extractor.process(new Float32Array(8192), time));
      assert.equal(follower.getResult().position, beforePause, 'page boundary cannot cross during silence');
    }
  }
  assert.equal(follower.getResult().state, 'complete');
  assert.ok(follower.getResult().position > 2.9);
});

test('broadband noise PCM does not accumulate a false match', () => {
  const follower = createScoreFollower(reference());
  const extractor = createAudioFeatureExtractor(48000);
  let seed = 42;
  for (let step = 0; step < 80; step++) {
    const noise = Float32Array.from({ length: 8192 }, () => { seed = (1664525 * seed + 1013904223) >>> 0; return (seed / 2 ** 32 - 0.5) * 0.1; });
    follower.process(extractor.process(noise, step * 50));
  }
  assert.equal(follower.getResult().position, 0);
  assert.equal(follower.getResult().eventIndex, 0);
});

test('continuous overlapping guitar plucks follow through FFT windows that straddle note changes', () => {
  const sampleRate = 48000;
  const score = createDemoScore().reference!;
  const shortScore = score;
  const starts = shortScore.events.map((_, index) => 0.25 + index * 0.48);
  const pcm = new Float32Array(Math.ceil((starts.at(-1)! + 0.65) * sampleRate));
  for (let index = 0; index < shortScore.events.length; index++) {
    const frequency = 440 * 2 ** ((shortScore.events[index].midi[0] - 69) / 12);
    const startSample = Math.round(starts[index] * sampleRate);
    // Pluck attack, decay and a quiet tail of the previous string continue into the next note.
    for (let sample = 0; sample < sampleRate * 0.8 && startSample + sample < pcm.length; sample++) {
      const time = sample / sampleRate;
      const envelope = (1 - Math.exp(-time / 0.003)) * Math.exp(-time / 0.22);
      pcm[startSample + sample] += 0.14 * envelope * [1, 0.52, 0.29, 0.17, 0.09].reduce((sum, gain, harmonic) => sum + gain * Math.sin(2 * Math.PI * frequency * (harmonic + 1) * time), 0);
    }
  }
  const follower = createScoreFollower(shortScore);
  const extractor = createAudioFeatureExtractor(sampleRate);
  const observed = new Set<number>();
  for (let endSample = 8192; endSample < pcm.length; endSample += 2400) {
    const feature = extractor.process(pcm.slice(endSample - 8192, endSample), endSample / sampleRate * 1000);
    const result = follower.process(feature);
    const currentEvent = Math.max(0, Math.min(shortScore.events.length - 1, Math.floor((endSample / sampleRate - 0.25) / 0.48)));
    assert.ok(result.eventIndex <= currentEvent, `advanced to ${result.eventIndex} before its onset at ${feature.timestampMs}`);
    if (result.state === 'tracking' || result.state === 'complete') observed.add(result.eventIndex);
  }
  assert.equal(observed.size, shortScore.events.length, `observed ${[...observed]}; result ${JSON.stringify(follower.getResult())}`);
  assert.equal(follower.getResult().eventIndex, shortScore.events.length - 1);
});
