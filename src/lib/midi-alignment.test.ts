import test from 'node:test';
import assert from 'node:assert/strict';
import { alignMidiToScore } from './midi-alignment.ts';
import { audioPositionAtTime, audioTimeAtPosition } from './audio-alignment.ts';
import { audioCursorAtTime, buildCursorTimeline } from './audio-cursor.ts';
import type { MidiPerformance } from './midi.ts';
import type { ScoreReference } from './score-following/types.ts';

function score(chords: number[][], pages = 1): ScoreReference {
  return { events: chords.map((midi, index) => ({ midi, beat: index, durationBeats: 1,
    position: pages * (index + 0.1) / chords.length })) };
}
function recording(chords: number[][], times: number[], track = 0): MidiPerformance {
  const notes = chords.flatMap((chord, i) => chord.map(midi => ({ midi, time: times[i], duration: 0.25, velocity: 0.7, track })));
  return { notes, duration: Math.max(...notes.map(note => note.time + note.duration)) + 0.5 };
}
function merge(...performances: MidiPerformance[]): MidiPerformance {
  return { notes: performances.flatMap(performance => performance.notes), duration: Math.max(...performances.map(performance => performance.duration)) };
}

test('MIDI preserves original onsets through variable tempo, lead-in, rests and trailing silence', async () => {
  const chords = [[60], [64], [67], [62], [65], [69]];
  const times = [0.8, 1.13, 2.2, 5.7, 6.4, 6.62];
  const performance = recording(chords, times);
  const reference = score(chords, 2);
  const alignment = await alignMidiToScore(performance, reference, 2);
  assert.equal(alignment.method, 'midi-notes');
  assert.equal(alignment.confidence, 1);
  assert.equal(alignment.coverage, 1);
  assert.deepEqual(alignment.pageConfidence, [1, 1]);
  assert.deepEqual(alignment.points.slice(1, -2), reference.events.map((event, i) => ({ time: times[i], position: event.position })));
  assert.equal(alignment.activeStart, 0.8);
  assert.equal(alignment.activeEnd, 6.87);
  assert.equal(alignment.duration, performance.duration);
  assert.equal(audioPositionAtTime(alignment, 0.7, performance.duration, 2), 0);
  assert.equal(audioTimeAtPosition(alignment, 1, performance.duration, 2), 5.7);
  assert.ok(audioPositionAtTime(alignment, 5.699, performance.duration, 2) < 1);
  assert.ok(audioPositionAtTime(alignment, 5.7, performance.duration, 2) >= 1);
  assert.equal(audioPositionAtTime(alignment, alignment.activeEnd, performance.duration, 2), 2);
});

test('chords group slightly staggered original attacks and retain absolute octave pitches', async () => {
  const chords = [[48, 60, 64, 67], [50, 62, 65, 69], [52, 64, 67, 71]];
  const performance = recording(chords, [0.5, 1.2, 2.1]);
  performance.notes.forEach((note, index) => { note.time += index % 4 * 0.009; });
  const alignment = await alignMidiToScore(performance, score(chords), 1);
  assert.deepEqual(alignment.points.slice(1, -2).map(point => point.time), [0.5, 1.2, 2.1]);
  assert.ok(Math.abs(alignment.activeEnd - 2.377) < 1e-12);
  const wrongOctave = structuredClone(performance);
  wrongOctave.notes.forEach(note => { note.midi += 12; });
  await assert.rejects(alignMidiToScore(wrongOctave, score(chords), 1), /音高|起音/);
});

test('a complete matching melody track is usable alongside unrelated accompaniment', async () => {
  const chords = [[60], [64], [67], [62]];
  const melody = recording(chords, [0.4, 0.9, 1.8, 2.2], 4);
  const bass = recording([[36], [38], [41]], [0, 0.6, 2.7], 0);
  const performance = merge(bass, melody);
  const alignment = await alignMidiToScore(performance, score(chords), 1);
  assert.deepEqual(alignment.points.slice(1, -2).map(point => point.time), [0.4, 0.9, 1.8, 2.2]);
  assert.equal(alignment.duration, performance.duration);
  assert.equal(alignment.activeEnd, 2.45);
});

test('simultaneous chords split between tracks match via the complete merged candidate', async () => {
  const lower = recording([[48], [50], [52], [53]], [0, 1.2, 1.5, 3], 0);
  const upper = recording([[60, 64], [62, 65], [64, 67], [65, 69]], [0, 1.2, 1.5, 3], 1);
  const reference = score([[48, 60, 64], [50, 62, 65], [52, 64, 67], [53, 65, 69]], 2);
  const alignment = await alignMidiToScore(merge(lower, upper), reference, 2);
  assert.equal(alignment.activeStart, 0);
  assert.equal(alignment.activeEnd, 3.25);
  assert.deepEqual(alignment.points.slice(1, -2).map(point => point.time), [0, 1.2, 1.5, 3]);
});

test('identical doubled tracks agree; different complete timelines reject rather than choose a track', async () => {
  const chords = [[60], [64], [67], [62]];
  const reference = score(chords, 2);
  const first = recording(chords, [0.5, 1, 2, 3], 0);
  const duplicate = recording(chords, [0.5, 1, 2, 3], 1);
  const accepted = await alignMidiToScore(merge(first, duplicate), reference, 2);
  assert.equal(accepted.activeStart, 0.5);
  for (const shift of [0.02, 2]) {
    const shifted = recording(chords, [0.5, 1, 2, 3].map(time => time + shift), 1);
    await assert.rejects(alignMidiToScore(merge(first, shifted), reference, 2), /多个 MIDI 声部.*时间不同/);
  }
  const longRelease = structuredClone(duplicate);
  longRelease.notes.at(-1)!.duration += 0.1;
  await assert.rejects(alignMidiToScore(merge(first, longRelease), reference, 2), /时间不同/);
});

test('two repeated pitches need two independent note-ons, including across a page boundary', async () => {
  const chords = [[60], [60], [64], [67]];
  const reference = score(chords, 2);
  reference.events[0].position = 0.7;
  reference.events[1].position = 1;
  reference.events[2].position = 1.3;
  reference.events[3].position = 1.6;
  const separate = recording(chords, [0.5, 0.52, 1.5, 2]);
  const aligned = await alignMidiToScore(separate, reference, 2);
  assert.equal(audioTimeAtPosition(aligned, 1, aligned.duration, 2), 0.52);
  const held = recording([[60], [64], [67]], [0.5, 1.5, 2]);
  held.notes[0].duration = 1;
  await assert.rejects(alignMidiToScore(held, reference, 2), /音高|起音/);
  const simultaneous = structuredClone(separate);
  simultaneous.notes[1].time = simultaneous.notes[0].time;
  await assert.rejects(alignMidiToScore(simultaneous, reference, 2), /音高|起音/);
});

test('fixed chord windows do not chain nearby notes or swallow an additional repeated attack', async () => {
  const chained = recording([[60], [64], [67], [62]], [0.5, 0.52, 0.54, 1]);
  await assert.rejects(alignMidiToScore(chained, score([[60, 64, 67], [62]]), 1), /音高|起音/);
  const repeated = recording([[60], [60], [64], [67]], [0.5, 0.51, 1, 2]);
  await assert.rejects(alignMidiToScore(repeated, score([[60], [64], [67]]), 1), /音高|起音/);
});

test('wrong order, extra leading/trailing notes, missing notes and whole missing pages all reject', async () => {
  const expected = [[60], [64], [67], [62]];
  const reference = score(expected, 2);
  const cases = [
    [[64], [60], [67], [62]],
    [[59], ...expected],
    [...expected, [65]],
    [[60], [64], [62]],
    [[60], [64]],
    [[60, 61], [64], [67], [62]],
  ];
  for (const chords of cases) {
    await assert.rejects(alignMidiToScore(recording(chords, chords.map((_, i) => i + 0.5)), reference, 2), /完整声部/);
  }
  await assert.rejects(alignMidiToScore(recording(expected, [0, 1, 2, 3]), score(expected), 2), /第 2 页/);
});

test('cursor timeline uses exact MIDI anchors and waits across rests, rows and pages', async () => {
  const chords = [[60], [64], [67], [62]];
  const reference = score(chords, 2);
  reference.events.forEach((event, i) => {
    event.position = [0, 0.4, 0.7, 1.1][i];
    event.beat = [0, 1, 4, 5][i];
    event.cursor = { x: [0.1, 0.8, 0.2, 0.3][i], y: i === 2 ? 0.6 : 0.2, height: 0.1, system: i === 2 ? 1 : 0 };
  });
  const performance = recording(chords, [1, 1.4, 5.7, 6]);
  const alignment = await alignMidiToScore(performance, reference, 2);
  const timeline = buildCursorTimeline(reference, alignment, 2);
  assert.equal(timeline.points.length, 4);
  assert.equal(audioCursorAtTime(timeline, 0.99), null);
  assert.equal(audioCursorAtTime(timeline, 1)!.eventIndex, 0);
  assert.ok(Math.abs(audioCursorAtTime(timeline, 1.2)!.x - 0.45) < 1e-12);
  assert.equal(audioCursorAtTime(timeline, 5.699)!.x, 0.8);
  assert.equal(audioCursorAtTime(timeline, 5.7)!.system, 1);
  assert.equal(audioCursorAtTime(timeline, 5.999)!.page, 0);
  assert.equal(audioCursorAtTime(timeline, 6)!.page, 1);
  assert.equal(audioCursorAtTime(timeline, alignment.activeEnd), null);
});

test('MIDI validation bounds work and rejects malformed references and performances', async () => {
  const reference = score([[60], [64], [67], [62]]);
  const performance = recording([[60], [64], [67], [62]], [0, 1, 2, 3]);
  const invalidNotes = [
    { midi: 60.5 }, { midi: 128 }, { time: -1 }, { time: NaN }, { duration: 0 }, { duration: Infinity },
    { duration: 99 }, { velocity: 0 }, { velocity: 2 }, { track: -1 }, { track: 0.5 },
  ];
  for (const patch of invalidNotes) {
    const malformed = structuredClone(performance);
    Object.assign(malformed.notes[0], patch);
    await assert.rejects(alignMidiToScore(malformed, reference, 1), /无效/);
  }
  for (const duration of [NaN, 0, 481]) {
    await assert.rejects(alignMidiToScore({ ...performance, duration }, reference, 1), /时长/);
  }
  await assert.rejects(alignMidiToScore({ ...performance, notes: [] }, reference, 1), /音符/);
  await assert.rejects(alignMidiToScore({ ...performance, notes: Array(10_001).fill(performance.notes[0]) }, reference, 1), /10000/);
  const tooManyTracks = { ...performance, notes: Array.from({ length: 129 }, (_, track) => ({ ...performance.notes[0], track })) };
  await assert.rejects(alignMidiToScore(tooManyTracks, reference, 1), /128/);
  await assert.rejects(alignMidiToScore(performance, { events: [] }, 1), /参考/);
  await assert.rejects(alignMidiToScore(performance, { events: Array(2401).fill(reference.events[0]) }, 1), /参考/);
  for (const pageCount of [0, 1.5, 21]) {
    await assert.rejects(alignMidiToScore(performance, reference, pageCount), /参考/);
  }
  for (const patch of [{ beat: NaN }, { beat: -1 }, { durationBeats: 0 }, { position: Infinity }, { midi: [60.5] }, { position: 0 }]) {
    const malformed = structuredClone(reference);
    Object.assign(malformed.events[1], patch);
    await assert.rejects(alignMidiToScore(performance, malformed, 1), /参考/);
  }
});

test('MIDI alignment is cancellable before work and between cooperative processing slices', async () => {
  const reference = score([[60], [64], [67], [62]]);
  const performance = recording([[60], [64], [67], [62]], [0, 1, 2, 3]);
  const before = new AbortController(); before.abort();
  await assert.rejects(alignMidiToScore(performance, reference, 1, before.signal), { name: 'AbortError' });
  const during = new AbortController();
  setTimeout(() => during.abort(), 0);
  await assert.rejects(alignMidiToScore(performance, reference, 1, during.signal), { name: 'AbortError' });
});
