import type { AudioAlignment } from '../types.ts';
import type { MidiPerformance } from './midi.ts';
import type { ScoreReference } from './score-following/types.ts';

const MAX_NOTES = 10_000;
const MAX_EVENTS = 2400;
const MAX_SECONDS = 8 * 60;
const MAX_TRACKS = 128;
const CHORD_WINDOW = 0.03;
const TIME_EPSILON = 1e-6;
const yieldToBrowser = () => new Promise<void>(resolve => setTimeout(resolve, 0));
type MidiNote = MidiPerformance['notes'][number];
interface Onset { time: number; pitches: number[]; }
interface Match { times: number[]; start: number; end: number; }

/** Fixed first-onset windows cannot chain a run of notes into one long chord. */
async function groupOnsets(notes: MidiNote[], signal?: AbortSignal): Promise<Onset[]> {
  const sorted = [...notes].sort((a, b) => a.time - b.time || a.midi - b.midi || a.track - b.track);
  const groups: Onset[] = [];
  let current: Onset | undefined;
  let voices = new Set<string>();
  for (let i = 0; i < sorted.length; i++) {
    if (i % 1024 === 0) { await yieldToBrowser(); signal?.throwIfAborted(); }
    const note = sorted[i];
    const voice = `${note.track}:${note.midi}`;
    // A second note-on of the same pitch in one track is always a new attack,
    // even inside the chord window. Simultaneous unisons in other tracks may merge.
    if (!current || note.time - current.time > CHORD_WINDOW + TIME_EPSILON || voices.has(voice)) {
      current = { time: note.time, pitches: [] };
      groups.push(current);
      voices = new Set();
    }
    voices.add(voice);
    if (!current.pitches.includes(note.midi)) current.pitches.push(note.midi);
  }
  for (const group of groups) group.pitches.sort((a, b) => a - b);
  return groups;
}

async function matchCandidate(notes: MidiNote[], expected: number[][], signal?: AbortSignal): Promise<Match | null> {
  const groups = await groupOnsets(notes, signal);
  // No subsequence search: extra notes, missing notes, and wrong order all fail.
  if (groups.length !== expected.length) return null;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if ((i > 0 && group.time <= groups[i - 1].time)
      || group.pitches.length !== expected[i].length
      || group.pitches.some((pitch, index) => pitch !== expected[i][index])) return null;
  }
  return { times: groups.map(group => group.time), start: groups[0].time,
    end: notes.reduce((end, note) => Math.max(end, note.time + note.duration), 0) };
}

/** Match original MIDI note-ons, without synthesizing/recognizing PCM or guessing page times. */
export async function alignMidiToScore(
  performance: MidiPerformance, reference: ScoreReference, pageCount: number, signal?: AbortSignal,
): Promise<AudioAlignment> {
  signal?.throwIfAborted();
  if (!Number.isFinite(performance.duration) || performance.duration <= 0 || performance.duration > MAX_SECONDS) {
    throw new Error('MIDI 时长须大于 0 且不超过 8 分钟。');
  }
  if (!Array.isArray(performance.notes) || !performance.notes.length || performance.notes.length > MAX_NOTES) {
    throw new Error('MIDI 须包含 1–10000 个音符，请分段导出。');
  }
  const events = reference.events;
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 20 || !Array.isArray(events)
    || !events.length || events.length > MAX_EVENTS || events.some((event, i) =>
      !Array.isArray(event.midi) || !event.midi.length || event.midi.length > 128
      || event.midi.some(pitch => !Number.isInteger(pitch) || pitch < 0 || pitch > 127)
      || !Number.isFinite(event.beat) || event.beat < 0
      || !Number.isFinite(event.durationBeats) || event.durationBeats <= 0
      || !Number.isFinite(event.position) || event.position < 0 || event.position >= pageCount
      || (i > 0 && (event.beat <= events[i - 1].beat || event.position <= events[i - 1].position)))) {
    throw new Error('谱面音符参考不足或顺序无效，无法对齐 MIDI。');
  }
  const pages = new Set(events.map(event => Math.floor(event.position)));
  for (let page = 0; page < pageCount; page++) {
    if (!pages.has(page)) throw new Error(`第 ${page + 1} 页没有可对齐的音符。`);
  }
  const tracks = new Map<number, MidiNote[]>();
  for (let i = 0; i < performance.notes.length; i++) {
    if (i % 1024 === 0) { await yieldToBrowser(); signal?.throwIfAborted(); }
    const note = performance.notes[i];
    if (!Number.isInteger(note.midi) || note.midi < 0 || note.midi > 127
      || !Number.isFinite(note.time) || note.time < 0
      || !Number.isFinite(note.duration) || note.duration <= 0
      || note.time + note.duration > performance.duration + TIME_EPSILON
      || !Number.isFinite(note.velocity) || note.velocity <= 0 || note.velocity > 1
      || !Number.isInteger(note.track) || note.track < 0) {
      throw new Error('MIDI 包含无效音高、起音或时值。');
    }
    const track = tracks.get(note.track) ?? [];
    track.push(note);
    tracks.set(note.track, track);
    if (tracks.size > MAX_TRACKS) throw new Error('MIDI 最多支持 128 个音轨，请导出对应声部。');
  }
  const expected = events.map(event => [...new Set(event.midi)].sort((a, b) => a - b));
  const candidates = [...tracks.values()];
  if (tracks.size > 1) candidates.push(performance.notes);
  let matched: Match | undefined;
  for (const notes of candidates) {
    signal?.throwIfAborted();
    const result = await matchCandidate(notes, expected, signal);
    if (!result) continue;
    if (matched && (Math.abs(result.end - matched.end) > TIME_EPSILON
      || result.times.some((time, index) => Math.abs(time - matched!.times[index]) > TIME_EPSILON))) {
      throw new Error('多个 MIDI 声部与谱面匹配，但时间不同；请单独导出对应声部。');
    }
    matched ??= result;
  }
  signal?.throwIfAborted();
  if (!matched) {
    throw new Error('MIDI 与整份谱面的音高或起音顺序不一致，未启用自动翻页；请导出对应的完整声部。');
  }
  const activeEnd = Math.min(performance.duration, matched.end);
  const points = [{ time: 0, position: 0 }, ...events.map((event, index) => ({ time: matched.times[index], position: event.position }))];
  points.push({ time: activeEnd, position: pageCount });
  if (activeEnd < performance.duration) points.push({ time: performance.duration, position: pageCount });
  // These are exact sequence-coverage values, not an acoustic/model probability.
  return { points, confidence: 1, pageConfidence: Array(pageCount).fill(1), coverage: 1,
    method: 'midi-notes', duration: performance.duration, activeStart: matched.start, activeEnd };
}
