import { chromaSimilarity, midiToChroma } from './chroma.ts';
import type { AudioScoreFrame, FollowerOptions, FollowingResult, ScoreReference } from './types.ts';

/** Conservative online, left-to-right HMM filter. No clock-driven interpolation. */
export function createScoreFollower(reference: ScoreReference, options: FollowerOptions = {}) {
  const events = reference.events;
  if (!events.length || events.some((event, index) =>
    !event.midi.length || event.midi.some((pitch) => !Number.isFinite(pitch) || pitch < 0 || pitch > 127) ||
    !Number.isFinite(event.position) || event.position < 0 || !Number.isFinite(event.beat) ||
    !Number.isFinite(event.durationBeats) || event.durationBeats <= 0 ||
    (index > 0 && (event.beat < events[index - 1].beat || event.position < events[index - 1].position)))) {
    throw new Error('乐谱缺少有效的音符位置');
  }
  const templates = events.map((event) => midiToChroma(event.midi));
  const silenceRms = options.silenceRms ?? 0.006;
  const minSimilarity = options.minSimilarity ?? 0.78;
  const confirmationFrames = Math.max(2, options.confirmationFrames ?? 3);
  const minEventMs = options.minEventMs ?? 100;
  let index = 0;
  let position = 0;
  let locked = false;
  let lastTimestamp = -Infinity;
  let lastCommitted = -Infinity;
  let armedUntil = -Infinity;
  let pendingFrames = 0;
  let pendingIndex = -1;
  let nextProbability = 0;
  let result: FollowingResult = { position: 0, eventIndex: 0, confidence: 0, state: 'waiting' };

  function reset(atPosition = 0): FollowingResult {
    const target = Number.isFinite(atPosition) ? Math.max(0, atPosition) : 0;
    index = events.reduce((best, event, candidate) => Math.abs(event.position - target) < Math.abs(events[best].position - target) ? candidate : best, 0);
    position = Math.min(target, events[events.length - 1].position);
    locked = false;
    lastTimestamp = -Infinity;
    lastCommitted = -Infinity;
    armedUntil = -Infinity;
    pendingFrames = 0;
    pendingIndex = -1;
    nextProbability = 0;
    result = { position, eventIndex: index, confidence: 0, state: 'waiting' };
    return result;
  }

  function hold(state: 'silent' | 'uncertain', confidence = 0) {
    pendingFrames = 0;
    pendingIndex = -1;
    nextProbability = 0;
    result = { position, eventIndex: index, confidence, state };
    return result;
  }

  return {
    reset,
    seek: reset,
    getResult: () => result,
    process(frame: AudioScoreFrame): FollowingResult {
      if (!Number.isFinite(frame.timestampMs) || frame.timestampMs <= lastTimestamp) return result;
      lastTimestamp = frame.timestampMs;
      if (!Number.isFinite(frame.rms) || frame.rms < silenceRms) {
        armedUntil = -Infinity;
        return hold('silent');
      }
      if (frame.chroma.length !== 12 || frame.chroma.some((value) => !Number.isFinite(value) || value < 0)) return hold('uncertain');
      // A real attack initially straddles old/new notes in the FFT window. Keep its short
      // transition opportunity even when that mixed frame is not yet a confident match.
      if (frame.onset && frame.timestampMs - lastCommitted >= minEventMs) armedUntil = frame.timestampMs + 240;
      const currentSimilarity = chromaSimilarity(frame.chroma, templates[index]);
      const hasNext = locked && index + 1 < events.length;
      const nextSimilarity = hasNext ? chromaSimilarity(frame.chroma, templates[index + 1]) : 0;
      if (Math.max(currentSimilarity, nextSimilarity) < minSimilarity) {
        return hold('uncertain', Math.max(currentSimilarity, nextSimilarity));
      }
      const mayAdvance = hasNext && frame.timestampMs <= armedUntil && frame.timestampMs - lastCommitted >= minEventMs;
      let candidate = index;
      let confidence = currentSimilarity;
      if (mayAdvance) {
        // alpha_t(i) = b_i(x_t) * sum_j a_ji * alpha_(t-1)(j), normalized.
        // Onset evidence opens stay/advance edges; the successor cannot advance again before confirmation.
        const transition = frame.onset ? 0.82 : 0.12;
        const priorNext = nextProbability + (1 - nextProbability) * transition;
        const currentWeight = (1 - priorNext) * Math.exp(9 * (currentSimilarity - 1));
        const nextWeight = priorNext * Math.exp(9 * (nextSimilarity - 1));
        nextProbability = nextWeight / Math.max(1e-12, currentWeight + nextWeight);
        const repeated = chromaSimilarity(templates[index], templates[index + 1]) > 0.97;
        if (nextProbability >= 0.72 && nextSimilarity >= minSimilarity &&
          (repeated || nextSimilarity >= currentSimilarity + 0.08)) {
          candidate = index + 1;
          confidence = nextSimilarity * nextProbability;
        }
      } else nextProbability = 0;
      if (candidate === index && currentSimilarity < minSimilarity) return hold('uncertain', currentSimilarity);
      if (candidate === pendingIndex) pendingFrames++;
      else { pendingIndex = candidate; pendingFrames = 1; }
      if (pendingFrames >= confirmationFrames && confidence >= minSimilarity * 0.9) {
        if (!locked || candidate !== index) {
          index = candidate;
          position = Math.max(position, events[index].position);
          locked = true;
          lastCommitted = frame.timestampMs;
          armedUntil = -Infinity;
          nextProbability = 0;
          pendingFrames = 0;
        }
        result = { position, eventIndex: index, confidence, state: index === events.length - 1 ? 'complete' : 'tracking' };
      } else {
        result = { position, eventIndex: index, confidence, state: locked && candidate === index ? 'tracking' : 'waiting' };
      }
      return result;
    },
  };
}
