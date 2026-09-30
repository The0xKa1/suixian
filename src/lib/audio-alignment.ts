import type { AudioAlignment } from '../types.ts';
import type { AudioScoreFrame, ScoreReference } from './score-following/types.ts';
import { createAudioFeatureExtractor, midiToChroma } from './score-following/chroma.ts';

export const MAX_AUDIO_SECONDS = 8 * 60;
const HOP_SECONDS = 0.04;
const MAX_CELLS = 24_000_000;
const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, value, index) => sum + value * b[index], 0);

/** Full-sequence, monotone chroma DTW. No wall-clock / equal-page timing fallback. */
export async function alignPcmToScore(
  pcm: Float32Array, sampleRate: number, reference: ScoreReference, pageCount: number,
  onProgress?: (message: string) => void, signal?: AbortSignal,
): Promise<AudioAlignment> {
  signal?.throwIfAborted();
  const duration = pcm.length / sampleRate;
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 96000 || !Number.isFinite(duration) || duration < 1 || duration > MAX_AUDIO_SECONDS) {
    throw new Error('音频需为 1 秒至 8 分钟，采样率不超过 96 kHz。');
  }
  const events = reference.events;
  if (!Number.isInteger(pageCount) || pageCount < 1 || events.length < 4 || events.length > 2400 || events.some((event, i) =>
    !event.midi.length || event.midi.some((pitch) => !Number.isFinite(pitch) || pitch < 24 || pitch > 108) ||
    !Number.isFinite(event.beat) || !Number.isFinite(event.durationBeats) || event.durationBeats <= 0 ||
    !Number.isFinite(event.position) || event.position < 0 || event.position >= pageCount ||
    (i > 0 && (event.beat <= events[i - 1].beat || event.position <= events[i - 1].position)))) {
    throw new Error('谱面音符参考不足或顺序无效，无法建立音频时间轴。');
  }
  if (new Set(events.flatMap((event) => event.midi.map((pitch) => pitch % 12))).size < 3) {
    throw new Error('谱面可区分的音高太少，无法可靠自动对齐。');
  }
  for (let page = 0; page < pageCount; page++) {
    if (!events.some((event) => Math.floor(event.position) === page)) throw new Error(`第 ${page + 1} 页没有可对齐的音符。`);
  }

  onProgress?.('分析音频…');
  const fftSize = 2 ** Math.ceil(Math.log2(sampleRate * 0.17));
  const extractor = createAudioFeatureExtractor(sampleRate, Math.max(2048, fftSize));
  const hop = Math.round(sampleRate * HOP_SECONDS);
  const window = new Float32Array(Math.max(2048, fftSize));
  const frames: AudioScoreFrame[] = [];
  let peakRms = 0;
  // One onset stream for repeated notes. Pitch FFT onsets lead the physical attack
  // by up to half a window, so OR-ing them with energy onsets double-counts plucks.
  // Measure attacks at 10 ms resolution before mapping them onto the 40 ms DTW grid.
  const attacks = new Set<number>();
  const energyHop = Math.max(1, Math.round(sampleRate * 0.01));
  let previousShortRms = 0;
  let previousPreviousShortRms = 0;
  let lastAttack = -Infinity;
  let sliceStarted = performance.now();
  for (let center = 0; center < pcm.length; center += energyHop) {
    const from = Math.max(0, center - energyHop);
    const to = Math.min(pcm.length, center + energyHop);
    let energy = 0;
    for (let sample = from; sample < to; sample++) energy += pcm[sample] ** 2;
    const rms = Math.sqrt(energy / Math.max(1, to - from));
    const time = center / sampleRate;
    if (rms > Math.max(0.004, Math.min(previousShortRms, previousPreviousShortRms) * 1.6) && time - lastAttack >= 0.085) {
      attacks.add(Math.round(center / hop));
      lastAttack = time;
    }
    previousPreviousShortRms = previousShortRms;
    previousShortRms = rms;
    if (performance.now() - sliceStarted > 14) { await yieldToBrowser(); signal?.throwIfAborted(); sliceStarted = performance.now(); }
  }
  for (let center = 0; center < pcm.length; center += hop) {
    window.fill(0);
    const start = center - Math.floor(window.length / 2);
    const from = Math.max(0, start);
    const to = Math.min(pcm.length, start + window.length);
    window.set(pcm.subarray(from, to), from - start);
    const frame = extractor.process(window, center / sampleRate * 1000);
    if (!Number.isFinite(frame.rms)) throw new Error('音频包含无效采样数据。');
    frame.onset = attacks.has(Math.round(center / hop));
    frames.push(frame);
    peakRms = Math.max(peakRms, frame.rms);
    if (performance.now() - sliceStarted > 14) { await yieldToBrowser(); signal?.throwIfAborted(); sliceStarted = performance.now(); }
  }
  const silence = Math.max(0.0015, peakRms * 0.035);
  const first = frames.findIndex((frame) => frame.rms > silence);
  let last = frames.length - 1;
  while (last >= 0 && frames[last].rms <= silence) last--;
  if (peakRms < 0.004 || first < 0 || last - first < events.length * 2) {
    throw new Error('音频静音或有效演奏过短，无法覆盖整份谱子。');
  }
  const active = frames.slice(first, last + 1);
  const frameCount = active.length;
  // Two states per event guarantee at least 80 ms of evidence; no skipped score events.
  const states = events.length * 2;
  if (frameCount * states > MAX_CELLS) throw new Error('音频与音符数量超出本地对齐上限，请拆分谱子和音频。');
  const templates = events.map((event) => midiToChroma(event.midi));
  const repeated = templates.map((template, i) => i > 0 && dot(template, templates[i - 1]) > 0.98);
  const trace = new Uint8Array(frameCount * states);
  let previous = new Float32Array(states).fill(Infinity);
  let current = new Float32Array(states);
  let previousAttacked = new Uint8Array(states);
  let currentAttacked = new Uint8Array(states);
  onProgress?.('匹配谱面与音频…');
  sliceStarted = performance.now();
  for (let f = 0; f < frameCount; f++) {
    current.fill(Infinity);
    currentAttacked.fill(0);
    const frame = active[f];
    const audible = frame.rms > silence;
    for (let event = 0; event < events.length; event++) {
      const similarity = audible ? dot(frame.chroma, templates[event]) : 0;
      const cost = audible ? 1 - similarity : 0.12;
      const start = event * 2;
      const mature = start + 1;
      // Repeated pitches need an acoustic onset; a sustained note cannot consume repeats.
      const canAdvance = audible && similarity >= 0.5 && (!repeated[event] || (frame.onset && previousAttacked[start - 1] === 1));
      if (event === 0 && f === 0) current[start] = cost;
      else if (event > 0 && canAdvance) current[start] = previous[start - 1] + cost;
      // The first note of a repeated run must consume an attack too. Otherwise a
      // delayed first attack could advance from an already-active first note.
      if (Number.isFinite(current[start])) currentAttacked[start] = frame.onset || (!repeated[event] && f > 0 && active[f - 1].onset) ? 1 : 0;
      const stay = previous[mature];
      const advance = previous[start];
      const entered = advance < stay || (advance === stay && previousAttacked[start] > previousAttacked[mature]);
      current[mature] = (entered ? advance : stay) + cost;
      currentAttacked[mature] = previousAttacked[entered ? start : mature] || (audible && similarity >= 0.5 && frame.onset ? 1 : 0);
      // 1 means the previous frame was the event's first state, 0 means sustain.
      if (entered) trace[f * states + mature] = 1;
    }
    [previous, current] = [current, previous];
    [previousAttacked, currentAttacked] = [currentAttacked, previousAttacked];
    if (performance.now() - sliceStarted > 14) { await yieldToBrowser(); signal?.throwIfAborted(); sliceStarted = performance.now(); }
  }
  if (!Number.isFinite(previous[states - 1])) throw new Error('音频无法按谱面顺序匹配，请检查是否为同一首完整演奏。');
  const assignment = new Int32Array(frameCount);
  let state = states - 1;
  for (let f = frameCount - 1; f >= 0; f--) {
    assignment[f] = Math.floor(state / 2);
    if (state % 2 === 0 || trace[f * states + state] === 1) state--;
  }
  const starts = new Int32Array(events.length).fill(-1);
  const counts = new Uint32Array(events.length);
  const matches = new Uint32Array(events.length);
  const similaritySum = new Float64Array(events.length);
  const pageSum = new Float64Array(pageCount);
  const pageFrames = new Uint32Array(pageCount);
  let audibleCount = 0;
  let goodCount = 0;
  for (let f = 0; f < frameCount; f++) {
    const event = assignment[f];
    if (starts[event] < 0) starts[event] = f;
    if (active[f].rms <= silence) continue;
    const similarity = dot(active[f].chroma, templates[event]);
    const page = Math.floor(events[event].position);
    counts[event]++;
    similaritySum[event] += similarity;
    matches[event] += similarity >= 0.7 ? 1 : 0;
    pageSum[page] += similarity;
    pageFrames[page]++;
    audibleCount++;
    if (similarity >= 0.7) goodCount++;
  }
  const pageConfidence = Array.from(pageSum, (sum, page) => pageFrames[page] ? sum / pageFrames[page] : 0);
  const confidence = pageSum.reduce((sum, value) => sum + value, 0) / Math.max(1, audibleCount);
  const coveredEvents = events.map((_, event) => counts[event] >= 2 && matches[event] >= 2 && similaritySum[event] / counts[event] >= 0.67);
  const coverage = coveredEvents.filter(Boolean).length / events.length;
  const weakPage = pageConfidence.findIndex((value) => value < 0.73);
  if (confidence < 0.77 || goodCount / audibleCount < 0.72 || coverage < 0.94 || weakPage >= 0 || !coveredEvents[0] || !coveredEvents.at(-1)) {
    throw new Error(weakPage >= 0 ? `第 ${weakPage + 1} 页与音频匹配不足，未启用自动翻页。` : '谱面与音频匹配不足，未启用自动翻页；请使用同一首完整演奏。');
  }
  // Every page's first note must have evidence before permitting a page transition.
  for (let page = 0; page < pageCount; page++) {
    const pageEvents = events.map((event, i) => ({ event, i })).filter(({ event }) => Math.floor(event.position) === page);
    if (!coveredEvents[pageEvents[0].i] || pageEvents.filter(({ i }) => coveredEvents[i]).length / pageEvents.length < 0.9) {
      throw new Error(`第 ${page + 1} 页缺少可靠的音符定位，未启用自动翻页。`);
    }
  }
  const activeStart = Math.max(0, active[0].timestampMs / 1000);
  const activeEnd = Math.min(duration, active.at(-1)!.timestampMs / 1000 + HOP_SECONDS / 2);
  const points = [{ time: 0, position: 0 }];
  for (let event = 0; event < events.length; event++) {
    const time = active[starts[event]].timestampMs / 1000;
    points.push({ time, position: events[event].position });
  }
  points.push({ time: activeEnd, position: pageCount });
  if (activeEnd < duration) points.push({ time: duration, position: pageCount });
  onProgress?.('对齐完成');
  return { points, confidence, pageConfidence, coverage, method: 'chroma-dtw', duration, activeStart, activeEnd };
}

/** Interpolate only between acoustically matched anchors, never evenly across pages. */
export function audioPositionAtTime(alignment: AudioAlignment, time: number, _duration: number, pageCount: number): number {
  const points = alignment.points;
  if (!points.length || !Number.isFinite(time)) return 0;
  if (time <= 0 || time < alignment.activeStart) return 0;
  let low = 0;
  let high = points.length;
  while (low < high) { const mid = (low + high) >>> 1; if (points[mid].time <= time) low = mid + 1; else high = mid; }
  if (low === points.length) return clamp(points.at(-1)!.position, 0, pageCount);
  if (low === 0) return 0;
  const before = points[low - 1];
  const after = points[low];
  const fraction = clamp((time - before.time) / Math.max(1e-9, after.time - before.time), 0, 1);
  let position = before.position + fraction * (after.position - before.position);
  if (Math.floor(after.position) > Math.floor(before.position)) position = Math.min(position, Math.floor(after.position) - 1e-6);
  return clamp(position, 0, pageCount);
}

export function audioTimeAtPosition(alignment: AudioAlignment, position: number, duration: number, pageCount: number): number {
  const points = alignment.points;
  if (!points.length || !Number.isFinite(position) || position <= 0) return 0;
  if (position >= pageCount) return Math.min(duration, alignment.activeEnd);
  // Page navigation seeks the first confirmed note of that page, not an extrapolated time.
  if (Number.isInteger(position)) return points.find((point) => Math.floor(point.position) >= position)?.time ?? duration;
  const next = points.findIndex((point) => point.position >= position);
  if (next <= 0) return next === 0 ? points[0].time : duration;
  const before = points[next - 1];
  const after = points[next];
  return clamp(before.time + (position - before.position) / Math.max(1e-9, after.position - before.position) * (after.time - before.time), 0, duration);
}
