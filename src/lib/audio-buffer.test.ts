import test from 'node:test';
import assert from 'node:assert/strict';
import type { AudioAlignment } from '../types.ts';
import { audioPositionAtTime } from './audio-alignment.ts';
import { audioBufferStartTime, audioBufferState } from './audio-buffer.ts';
import { readerGeometry } from './transition.ts';

function alignmentFor(boundaries: number[], activeStart = 2, activeEnd = 40, duration = 45): AudioAlignment {
  return {
    points: [
      { time: activeStart, position: 0 },
      ...boundaries.flatMap((time, index) => [
        // Unevenly spaced musical notes ensure page timing does not use score fractions.
        { time: time - Math.min(0.05, (time - (boundaries[index - 1] ?? activeStart)) * 0.1), position: index + 0.94 },
        { time, position: index + 1 },
      ]),
      { time: activeEnd, position: boundaries.length + 0.95 },
    ],
    confidence: 0.8, pageConfidence: new Array(boundaries.length + 1).fill(0.8), coverage: 1,
    method: 'chroma-dtw', activeStart, activeEnd, duration,
  };
}

const alignment = alignmentFor([12, 32]);
const offsetAt = (value: AudioAlignment, time: number, pageCount: number) =>
  audioBufferState(value, time, value.duration, pageCount)?.offsetPages
  ?? Math.min(pageCount - 1, Math.floor(audioPositionAtTime(value, time, value.duration, pageCount)));

test('audio buffers use actual irregular page anchors with a seconds-based preview', () => {
  assert.equal(audioBufferStartTime(alignment, 1, 45, 3), 8);
  assert.equal(audioBufferStartTime(alignment, 2, 45, 3), 28);
  assert.equal(audioBufferStartTime(alignment, 1, 45, 3, 2), 10);
  assert.equal(audioBufferState(alignment, 7.99, 45, 3), null);
  const start = audioBufferState(alignment, 8, 45, 3)!;
  assert.equal(start.phase, 'approach');
  assert.equal(start.offsetPages, 0);
  assert.equal(start.boundaryTime, 12);
  assert.equal(start.endTime, 15.1);
  const preview = audioBufferState(alignment, 9.1, 45, 3)!;
  assert.equal(preview.phase, 'hold');
  assert.equal(preview.offsetPages, 0.5);
  assert.equal(preview.fromPage, 0);
  assert.equal(preview.toPage, 1);
});

test('the previous tail stays visible across the matched boundary before departure', () => {
  for (const time of [11.99, 12, 13, 14]) {
    const state = audioBufferState(alignment, time, 45, 3)!;
    assert.equal(state.phase, 'hold');
    assert.equal(state.offsetPages, 0.5);
    assert.equal(state.boundaryPage, 1);
  }
  const depart = audioBufferState(alignment, 14.55, 45, 3)!;
  assert.equal(depart.phase, 'depart');
  assert.ok(Math.abs(depart.offsetPages - 0.75) < 1e-10);
  assert.equal(audioBufferState(alignment, 15.1, 45, 3)!.offsetPages, 1);
  assert.equal(audioBufferState(alignment, 15.101, 45, 3), null);
});

test('audio track is continuous and monotone through approach, page boundary and departure', () => {
  let previous = 0;
  for (let tick = 0; tick <= 45000; tick++) {
    const current = offsetAt(alignment, tick / 1000, 3);
    assert.ok(current >= previous - 1e-12, `no backward motion at ${tick / 1000}`);
    assert.ok(current - previous < 0.002, `no jump at ${tick / 1000}`);
    assert.ok(current >= 0 && current <= 2);
    previous = current;
  }
  for (const boundary of [8, 9.1, 12, 14, 15.1, 28, 29.1, 32, 34, 35.1]) {
    assert.ok(Math.abs(offsetAt(alignment, boundary + 1e-7, 3) - offsetAt(alignment, boundary - 1e-7, 3)) < 1e-6);
  }
});

test('buffer movement starts and ends with near-zero velocity and acceleration', () => {
  const step = 0.001;
  for (const time of [8, 9.1, 14, 15.1]) {
    const before = offsetAt(alignment, time - step, 3);
    const current = offsetAt(alignment, time, 3);
    const after = offsetAt(alignment, time + step, 3);
    assert.ok(Math.abs(after - before) / (2 * step) < 0.00001, `gentle velocity at ${time}`);
    assert.ok(Math.abs(after - 2 * current + before) / (step * step) < 0.005, `gentle acceleration at ${time}`);
  }
  const middle = audioBufferState(alignment, 8.55, 45, 3)!;
  assert.equal(middle.phase, 'approach');
  assert.ok(Math.abs(middle.offsetPages - 0.25) < 1e-10, 'spends 1.1 s revealing the next half-page');
});

test('buffer framing retains previous tail and incoming head at fixed scale on every layout', () => {
  for (const [width, cap] of [[300, 320], [390, 320], [640, 360], [1400, 640]]) {
    for (const [pageWidth, pageHeight] of [[920, 620], [595, 842]]) {
      const { topInset, leafHeight, stride, viewportHeight } = readerGeometry(width, cap, pageWidth, pageHeight);
      for (const boundaryTime of [12, 32]) {
        for (const time of [boundaryTime - 2, boundaryTime, boundaryTime + 1.9]) {
          const state = audioBufferState(alignment, time, 45, 3)!;
          const offset = state.offsetPages * stride;
          const outgoingBottom = topInset + state.fromPage * stride + leafHeight - offset;
          const incomingTop = topInset + state.toPage * stride - offset;
          assert.ok(outgoingBottom > 0 && outgoingBottom < viewportHeight, 'outgoing tail remains in viewport');
          assert.ok(incomingTop > 0 && incomingTop < viewportHeight, 'incoming head appears early');
          assert.ok(outgoingBottom >= leafHeight * 0.3, 'substantial previous-page area stays readable');
          assert.ok(viewportHeight - incomingTop >= leafHeight * 0.3, 'substantial next-page area stays readable');
        }
      }
    }
  }
});

test('short pages cap both windows independently without overlap or reverse movement', () => {
  const short = alignmentFor([2.2, 2.5, 3], 2, 3.1, 5);
  const pageCount = 4;
  for (let page = 1; page < pageCount; page++) {
    const boundaryTime = short.points.find((point) => point.position === page)!.time;
    const state = audioBufferState(short, boundaryTime, 5, pageCount)!;
    assert.equal(state.boundaryPage, page);
    assert.ok(state.startTime > short.activeStart);
    assert.ok(state.endTime < short.activeEnd);
    if (page < pageCount - 1) assert.ok(state.endTime < audioBufferStartTime(short, page + 1, 5, pageCount)!);
  }
  let previous = 0;
  for (let tick = 19000; tick < 32000; tick++) {
    const current = offsetAt(short, tick / 10000, pageCount);
    assert.ok(current >= previous - 1e-12);
    assert.ok(current - previous < 0.02);
    previous = current;
  }
});

test('seeking backwards reproduces exactly the same buffer from media time alone', () => {
  const times = [8.2, 9, 12, 14.3, 20, 28.5, 32, 34.4, 40];
  const forward = times.map((time) => audioBufferState(alignment, time, 45, 3));
  const backwards = [...times].reverse().map((time) => audioBufferState(alignment, time, 45, 3)).reverse();
  assert.deepEqual(backwards, forward);
});

test('explicit page navigation suppresses its buffer while later boundaries remain available', () => {
  assert.equal(audioBufferState(alignment, 12, 45, 3, 4, 1), null);
  assert.equal(audioBufferState(alignment, 13, 45, 3, 4, 1), null);
  assert.equal(audioBufferState(alignment, 32, 45, 3, 4, 1)!.boundaryPage, 2);
  assert.equal(audioBufferState(alignment, 12, 45, 3, 4, 2)!.boundaryPage, 1);
});

test('intro, final silence, single pages and invalid bounds cannot create phantom buffers', () => {
  assert.equal(audioBufferState(alignment, 1, 45, 3), null);
  assert.equal(audioBufferState(alignment, 39, 45, 3), null);
  assert.equal(audioBufferState(alignment, 44, 45, 3), null);
  assert.equal(offsetAt(alignment, 44, 3), 2);
  assert.equal(audioBufferState(alignmentFor([]), 20, 45, 1), null);
  assert.equal(audioBufferStartTime(alignment, 0, 45, 3), null);
  assert.equal(audioBufferStartTime(alignment, 3, 45, 3), null);
  assert.equal(audioBufferState({ ...alignment, points: [] }, 12, 45, 3), null);
  assert.equal(audioBufferState(alignment, NaN, 45, 3), null);
  assert.equal(audioBufferState(alignment, 12, 45, Infinity), null);
  assert.equal(audioBufferState(alignment, 12, 45, 3, 0), null);
  assert.equal(audioBufferState(alignment, 12, 45, 3, NaN), null);
  assert.equal(audioBufferState({ ...alignment, activeEnd: 12 }, 12, 45, 3), null);
});
