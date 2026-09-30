import test from 'node:test';
import assert from 'node:assert/strict';
import type { AudioAlignment } from '../types.ts';
import type { ScoreReference } from './score-following/types.ts';
import { audioPositionAtTime, audioTimeAtPosition } from './audio-alignment.ts';
import { audioBufferStartTime, audioBufferState } from './audio-buffer.ts';
import { buildCursorTimeline, audioCursorAtTime } from './audio-cursor.ts';
import { bindAlignmentAnchors, mapReadingPosition, remapAlignment } from './notation-alignment.ts';

function reference(positions: number[], legacy = false): ScoreReference {
  return { events: positions.map((position, index) => ({
    ...(legacy ? {} : { id: `note-${index}` }),
    midi: [60 + index * 2], beat: index, durationBeats: 1, position,
    cursor: { x: 0.1 + (position % 1) * 0.7, y: 0.2, height: 0.15, system: 0 },
  })) };
}

const original = reference([0.1, 0.6, 1.2, 1.7]);
const rendered = reference([0.1, 1.1, 1.5, 2.2]);
const times = [2, 3.5, 8, 10];
const alignment: AudioAlignment = {
  points: [{ time: 0, position: 0 }, ...times.map((time, index) => ({ time, position: original.events[index].position })),
    { time: 12, position: 2 }, { time: 15, position: 2 }],
  confidence: 0.88, pageConfidence: [0.91, 0.78], coverage: 1,
  method: 'chroma-dtw', duration: 15, activeStart: 2, activeEnd: 12,
};

test('binds exact acoustic onsets and preserves the input and real time values', () => {
  const snapshot = structuredClone(alignment);
  const result = bindAlignmentAnchors(alignment, original);
  assert.deepEqual(result.anchors, times.map((time, index) => ({ eventId: `note-${index}`, beat: index, time })));
  assert.deepEqual(alignment, snapshot);
  assert.notEqual(result, alignment);
});

test('legacy events receive deterministic identities and can acquire explicit IDs during reflow', () => {
  const legacy = reference(original.events.map((event) => event.position), true);
  const result = bindAlignmentAnchors(alignment, legacy);
  assert.deepEqual(result.anchors?.map((anchor) => anchor.eventId), ['event-0', 'event-1', 'event-2', 'event-3']);
  const mapped = remapAlignment(result, legacy, rendered, 3);
  assert.deepEqual(mapped.anchors?.map((anchor) => anchor.eventId), ['note-0', 'note-1', 'note-2', 'note-3']);
  assert.deepEqual(mapped.anchors?.map((anchor) => anchor.time), times);
});

test('a nearby/interpolated position and an intro/end marker cannot manufacture a note onset', () => {
  const nearby = { ...alignment, points: alignment.points.map((point) => point.position === 0.6 ? { ...point, position: 0.600001 } : point) };
  assert.throws(() => bindAlignmentAnchors(nearby, original), /音频锚点/);
  const noFirst = { ...alignment, points: alignment.points.filter((point) => point.time !== 2) };
  assert.throws(() => bindAlignmentAnchors(noFirst, reference([0, 0.6, 1.2, 1.7])), /音频锚点/);
  const lastAtEnd = { ...alignment, points: alignment.points.map((point) => point.time === 10 ? { ...point, time: 12 } : point) };
  assert.throws(() => bindAlignmentAnchors(lastAtEnd, original), /音频锚点/);
});

test('ambiguous positions, duplicate IDs and nonmonotonic onsets are rejected', () => {
  const ambiguous = structuredClone(alignment);
  ambiguous.points.splice(3, 0, { time: 3.6, position: 0.6 });
  assert.throws(() => bindAlignmentAnchors(ambiguous, original), /音频锚点/);
  const duplicate = structuredClone(original);
  duplicate.events[1].id = duplicate.events[0].id;
  assert.throws(() => bindAlignmentAnchors(alignment, duplicate), /音频锚点/);
  const simultaneous = { ...alignment, points: alignment.points.map((point) => point.time === 3.5 ? { ...point, time: 2 } : point) };
  assert.throws(() => bindAlignmentAnchors(simultaneous, original), /音频锚点/);
});

test('stable anchors survive layout changes without relying on former display points', () => {
  const bound = bindAlignmentAnchors(alignment, original);
  const withoutGeometry = { ...bound, points: [] };
  assert.deepEqual(bindAlignmentAnchors(withoutGeometry, original).anchors, bound.anchors);
  const corrupted = { ...bound, anchors: bound.anchors!.map((anchor, index) => index === 1 ? { ...anchor, beat: 99 } : anchor) };
  assert.throws(() => remapAlignment(corrupted, original, rendered, 3), /音频锚点/);
});

test('new page counts use matched first onsets for seeking and buffer timing, with conservative confidence', () => {
  const result = remapAlignment(alignment, original, rendered, 3);
  assert.deepEqual(result.pageConfidence, [0.91, 0.78, 0.78]);
  assert.equal(result.activeStart, alignment.activeStart);
  assert.equal(result.activeEnd, alignment.activeEnd);
  assert.equal(result.duration, alignment.duration);
  assert.equal(result.confidence, alignment.confidence);
  for (const [index, time] of times.entries()) {
    assert.equal(audioPositionAtTime(result, time, 15, 3), rendered.events[index].position);
    assert.equal(audioTimeAtPosition(result, rendered.events[index].position, 15, 3), time);
  }
  assert.equal(audioTimeAtPosition(result, 1, 15, 3), 3.5);
  assert.equal(audioTimeAtPosition(result, 2, 15, 3), 10);
  assert.ok(audioPositionAtTime(result, 3.5 - 1e-4, 15, 3) < 1);
  assert.equal(audioBufferStartTime(result, 1, 15, 3), 2.9);
  assert.equal(audioBufferState(result, 3.5, 15, 3)?.boundaryTime, 3.5);
  assert.equal(audioBufferState(result, 10, 15, 3)?.boundaryTime, 10);
});

test('intro and trailing silence retain their original bounds after page count changes', () => {
  const result = remapAlignment(alignment, original, rendered, 3);
  assert.deepEqual(result.points.at(-2), { time: 12, position: 3 });
  assert.deepEqual(result.points.at(-1), { time: 15, position: 3 });
  assert.equal(audioPositionAtTime(result, 1.99, 15, 3), 0);
  assert.equal(audioPositionAtTime(result, 12, 15, 3), 3);
  assert.equal(audioPositionAtTime(result, 14, 15, 3), 3);
  assert.equal(audioTimeAtPosition(result, 3, 15, 3), 12);
  const cursor = buildCursorTimeline(rendered, result, 3);
  assert.equal(cursor.points.length, rendered.events.length);
  assert.equal(audioCursorAtTime(cursor, 1.99), null);
  assert.equal(audioCursorAtTime(cursor, 3.5)?.page, 1);
  assert.equal(audioCursorAtTime(cursor, 12), null);
  assert.equal(audioBufferState(result, 14, 15, 3), null);
});

test('shrinking and re-expanding a layout preserves event identities and exact audio times', () => {
  const expanded = remapAlignment(alignment, original, rendered, 3);
  const compact = reference([0.05, 0.25, 0.55, 0.8]);
  const shrunk = remapAlignment(expanded, rendered, compact, 1);
  assert.deepEqual(shrunk.pageConfidence, [0.78]);
  const back = remapAlignment(shrunk, compact, original, 2);
  assert.deepEqual(back.points, alignment.points);
  assert.deepEqual(back.anchors, expanded.anchors);
  assert.deepEqual(back.pageConfidence, [0.78, 0.78], 'an aggregate cannot recover evidence that was discarded');
});

test('missing or changed events and unsupported empty pages cannot silently reuse an alignment', () => {
  const missing = { events: rendered.events.filter((_, index) => index !== 1) };
  assert.throws(() => remapAlignment(alignment, original, missing, 3), /音频锚点/);
  const changed = structuredClone(rendered);
  changed.events[1].midi = [90];
  assert.throws(() => remapAlignment(alignment, original, changed, 3), /音频锚点/);
  const renamed = structuredClone(rendered);
  renamed.events[1].id = 'different-event';
  assert.throws(() => remapAlignment(alignment, original, renamed, 3), /音频锚点/);
  const missingAnchor = { ...alignment, points: alignment.points.filter((point) => point.time !== 8) };
  assert.throws(() => remapAlignment(missingAnchor, original, rendered, 3), /音频锚点/);
  assert.throws(() => remapAlignment(alignment, original, rendered, 4), /音频锚点/);
  const missingConfidence = remapAlignment({ ...alignment, pageConfidence: [0.91] }, original, rendered, 3);
  assert.deepEqual(missingConfidence.pageConfidence, [0.91, 0, 0]);
});

test('manual reading maps by events and their intervening musical span, including the document end', () => {
  assert.equal(mapReadingPosition(0.6, original, rendered, 2, 3), 1.1);
  assert.equal(mapReadingPosition(2, original, rendered, 2, 3), 3);
  assert.equal(mapReadingPosition(10, original, rendered, 2, 3), 3);
  assert.equal(mapReadingPosition(-1, original, rendered, 2, 3), 0);
  for (const position of [0, 0.05, 0.1, 0.35, 0.6, 0.9, 1, 1.2, 1.4, 1.7, 1.9, 2]) {
    const mapped = mapReadingPosition(position, original, rendered, 2, 3)!;
    const restored = mapReadingPosition(mapped, rendered, original, 3, 2)!;
    assert.ok(Math.abs(restored - position) < 1e-9, `round trip at ${position}`);
  }
});

test('manual reading refuses missing, ambiguous or edited music instead of resetting to page zero', () => {
  assert.equal(mapReadingPosition(1, original, { events: rendered.events.slice(1) }, 2, 3), null);
  assert.equal(mapReadingPosition(1, { events: [] }, rendered, 2, 3), null);
  assert.equal(mapReadingPosition(NaN, original, rendered, 2, 3), null);
  assert.equal(mapReadingPosition(1, original, rendered, 2, 0), null);
  const changed = structuredClone(rendered);
  changed.events[2].beat = 2.5;
  assert.equal(mapReadingPosition(1.2, original, changed, 2, 3), null);
  const legacy = reference(original.events.map((event) => event.position), true);
  assert.equal(mapReadingPosition(1.2, legacy, rendered, 2, 3), 1.5);
});

test('a page navigation round trip cannot land one floating-point step before its page boundary', () => {
  const source = reference([0.1, 0.504, 1.8]);
  const display = reference([0.05, 1.15, 2.7]);
  const sourcePosition = mapReadingPosition(1, display, source, 3, 2)!;
  const displayPosition = mapReadingPosition(sourcePosition, source, display, 2, 3)!;
  assert.equal(sourcePosition, 0.4489090909090909);
  assert.equal(displayPosition, 1);
  assert.equal(Math.floor(displayPosition), 1);
  assert.ok(mapReadingPosition(sourcePosition - 1e-6, source, display, 2, 3)! < 1,
    'real reading positions before the boundary are not snapped to the next page');
});

test('a zero-time first onset and no trailing silence require no invented timing boundaries', () => {
  const source = reference([0, 0.3, 0.6, 0.8]);
  const onsets = [0, 1, 2, 3];
  const zeroStart: AudioAlignment = {
    ...alignment, activeStart: 0, activeEnd: 4, duration: 4, pageConfidence: [0.9],
    points: [{ time: 0, position: 0 }, ...onsets.map((time, index) => ({ time, position: source.events[index].position })),
      { time: 4, position: 1 }],
  };
  const result = remapAlignment(zeroStart, source, rendered, 3);
  assert.deepEqual(result.anchors?.map((anchor) => anchor.time), onsets);
  assert.equal(result.points.filter((point) => point.time === 4).length, 1);
  assert.equal(audioPositionAtTime(result, 4, 4, 3), 3);
});
