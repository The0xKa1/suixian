import test from 'node:test';
import assert from 'node:assert/strict';
import { audioCursorAtTime, buildCursorTimeline, cursorVisibleOffset } from './audio-cursor.ts';
import type { ScoreReference } from './score-following/types.ts';
import type { AudioAlignment } from '../types.ts';

const reference: ScoreReference = { events: [
  { midi: [60], beat: 0, durationBeats: 1, position: 0.01, cursor: { x: .1, y: .2, height: .1, system: 0 } },
  { midi: [62], beat: 1, durationBeats: 1, position: 0.2, cursor: { x: .8, y: .2, height: .1, system: 0 } },
  { midi: [64], beat: 2, durationBeats: 1, position: 0.6, cursor: { x: .2, y: .6, height: .1, system: 1 } },
  { midi: [65], beat: 3, durationBeats: 1, position: 1.01, cursor: { x: .15, y: .2, height: .1, system: 0 } },
] };
const alignment: AudioAlignment = { points: [
  { time: 0, position: 0 }, { time: 2, position: .01 }, { time: 5, position: .2 },
  { time: 6, position: .6 }, { time: 9, position: 1.01 }, { time: 11, position: 2 },
], activeStart: 2, activeEnd: 11, duration: 13, confidence: .9, coverage: 1, pageConfidence: [.9, .9], method: 'chroma-dtw' };

test('cursor follows irregular matched times, pauses and seeks deterministically', () => {
  const timeline = buildCursorTimeline(reference, alignment, 2);
  assert.equal(audioCursorAtTime(timeline, 1.99), null);
  assert.equal(audioCursorAtTime(timeline, 2)!.x, .1);
  assert.ok(Math.abs(audioCursorAtTime(timeline, 3.5)!.x - .45) < 1e-12);
  assert.deepEqual(audioCursorAtTime(timeline, 3.5), audioCursorAtTime(timeline, 3.5));
  for (const t of [9, 6, 5, 3.5, 2]) assert.ok(audioCursorAtTime(timeline, t));
  assert.equal(audioCursorAtTime(timeline, 11), null);
});
test('cursor waits for confirmed row/page onset and holds through written rests', () => {
  const timeline = buildCursorTimeline(reference, alignment, 2);
  assert.equal(audioCursorAtTime(timeline, 5.999)!.system, 0);
  assert.equal(audioCursorAtTime(timeline, 5.999)!.x, .8);
  assert.equal(audioCursorAtTime(timeline, 6)!.system, 1);
  assert.equal(audioCursorAtTime(timeline, 8.999)!.page, 0);
  assert.equal(audioCursorAtTime(timeline, 9)!.page, 1);
  const rested = structuredClone(reference); rested.events[0].durationBeats = .5;
  assert.equal(audioCursorAtTime(buildCursorTimeline(rested, alignment, 2), 4)!.x, .1);
});
test('missing or invalid geometry never fabricates a position or bridges across unknown notes', () => {
  const partial = structuredClone(reference); delete partial.events[1].cursor;
  const timeline = buildCursorTimeline(partial, alignment, 2);
  assert.equal(audioCursorAtTime(timeline, 4)!.x, .1);
  assert.equal(audioCursorAtTime(timeline, 5.5), null);
  partial.events[0].cursor!.height = Infinity;
  assert.equal(audioCursorAtTime(buildCursorTimeline(partial, alignment, 2), 3), null);
  assert.equal(buildCursorTimeline(undefined, alignment, 2).points.length, 0);
  assert.equal(buildCursorTimeline(reference, { ...alignment, points: alignment.points.filter(p => p.position !== .2) }, 2).points.length, 0);
});
test('preview offset keeps a current staff visible on mobile and desktop', () => {
  for (const height of [200, 600]) {
    const top = height * .2, bottom = height * .35;
    const offset = cursorVisibleOffset(height / 2, top, bottom, height);
    assert.ok(top - offset >= 16 && bottom - offset < height);
    const nextTop = height * 1.25, nextBottom = height * 1.4;
    const nextOffset = cursorVisibleOffset(height / 2, nextTop, nextBottom, height);
    assert.ok(nextTop - nextOffset > 0 && nextBottom - nextOffset <= height - 16);
  }
});

test('short-long-short onsets share one staff-group height without crossing systems or pages', () => {
  const grouped: ScoreReference = { events: [
    { midi: [60], beat: 0, durationBeats: 1, position: .01, cursor: { x: .1, y: .125, height: .125, system: 0 } },
    { midi: [62, 50], beat: 1, durationBeats: 1, position: .2, cursor: { x: .4, y: .125, height: .5, system: 0 } },
    { midi: [52], beat: 2, durationBeats: 1, position: .4, cursor: { x: .7, y: .5, height: .125, system: 0 } },
    { midi: [64], beat: 3, durationBeats: 1, position: .6, cursor: { x: .2, y: .75, height: .125, system: 1 } },
    { midi: [65], beat: 4, durationBeats: 1, position: 1.01, cursor: { x: .15, y: .25, height: .25, system: 0 } },
  ] };
  const times = [2, 5, 6, 9, 11];
  const synced: AudioAlignment = { ...alignment, activeEnd: 13, duration: 14, points: [
    { time: 0, position: 0 }, ...times.map((time, index) => ({ time, position: grouped.events[index].position })),
    { time: 13, position: 2 }, { time: 14, position: 2 },
  ] };
  const originalReference = structuredClone(grouped);
  const originalAlignment = structuredClone(synced);
  const timeline = buildCursorTimeline(grouped, synced, 2);
  assert.deepEqual(timeline.points.map(point => point.time), times);
  assert.deepEqual(timeline.points.map(point => point.cursor!.eventIndex), [0, 1, 2, 3, 4]);
  assert.deepEqual(timeline.points.map(point => point.cursor!.x), [.1, .4, .7, .2, .15]);
  assert.deepEqual(timeline.points.map(point => [point.cursor!.page, point.cursor!.system, point.cursor!.y, point.cursor!.height]), [
    [0, 0, .125, .5], [0, 0, .125, .5], [0, 0, .125, .5],
    [0, 1, .75, .125], [1, 0, .25, .25],
  ]);
  const sampleTimes = [2, 3.5, 5, 5.5, 6, 8.999, 9, 10.999, 11, 12.5];
  const forward = sampleTimes.map(time => audioCursorAtTime(timeline, time));
  const backward = [...sampleTimes].reverse().map(time => audioCursorAtTime(timeline, time)).reverse();
  assert.deepEqual(backward, forward);
  for (const time of sampleTimes.filter(time => time < 9)) {
    assert.equal(audioCursorAtTime(timeline, time)!.y, .125);
    assert.equal(audioCursorAtTime(timeline, time)!.height, .5);
  }
  assert.ok(Math.abs(audioCursorAtTime(timeline, 3.5)!.x - .25) < 1e-12);
  assert.equal(audioCursorAtTime(timeline, 8.999)!.x, .7, 'row changes still wait for the next onset');
  assert.deepEqual(grouped, originalReference);
  assert.deepEqual(synced, originalAlignment);
});

test('staff-group normalization excludes invalid geometry and keeps missing cursors missing', () => {
  const partial: ScoreReference = { events: [
    { midi: [60], beat: 0, durationBeats: 1, position: .05, cursor: { x: .1, y: .125, height: .125, system: 0 } },
    { midi: [62], beat: 1, durationBeats: 1, position: .2 },
    { midi: [64], beat: 2, durationBeats: 1, position: .4, cursor: { x: .4, y: .9, height: .2, system: 0 } },
    { midi: [65], beat: 3, durationBeats: 1, position: .6, cursor: { x: .6, y: 0, height: Infinity, system: 0 } },
    { midi: [67], beat: 4, durationBeats: 1, position: .8, cursor: { x: .8, y: .5, height: .125, system: 0 } },
  ] };
  const synced: AudioAlignment = { ...alignment, activeStart: 1, activeEnd: 6, duration: 7, pageConfidence: [.9], points: [
    { time: 0, position: 0 }, ...partial.events.map((event, index) => ({ time: index + 1, position: event.position })),
    { time: 6, position: 1 }, { time: 7, position: 1 },
  ] };
  const original = structuredClone(partial);
  const timeline = buildCursorTimeline(partial, synced, 1);
  assert.equal(timeline.points[0].cursor!.y, .125);
  assert.equal(timeline.points[0].cursor!.height, .5);
  assert.equal(timeline.points[4].cursor!.y, .125);
  assert.equal(timeline.points[4].cursor!.height, .5);
  for (const index of [1, 2, 3]) {
    assert.equal(timeline.points[index].cursor, null);
    assert.equal(audioCursorAtTime(timeline, index + 1.5), null);
  }
  assert.equal(audioCursorAtTime(timeline, 1.5)!.x, .1, 'missing geometry still prevents interpolation');
  assert.deepEqual(partial, original);
});
