import test from 'node:test';
import assert from 'node:assert/strict';
import { SPRING_OMEGA, constrainOffset, settlePage, springSettled, stepSpring } from './motion.ts';
import type { SpringState } from './motion.ts';

const run = (state: SpringState, target: number, seconds: number, frame = 1 / 60) => {
  const values: number[] = [];
  let current = state;
  for (let time = 0; time < seconds; time += frame) {
    current = stepSpring(current, target, frame);
    values.push(current.value);
  }
  return { current, values };
};

test('a page turn from rest eases in, never overshoots and settles', () => {
  const { current, values } = run({ value: 0, velocity: 0 }, 1, 1.5);
  assert.ok(values[0] < 0.02, 'starts gently instead of jumping toward the target');
  for (let index = 1; index < values.length; index++) {
    assert.ok(values[index] >= values[index - 1], 'moves one way only');
    assert.ok(values[index] <= 1, 'never passes the next page origin');
  }
  assert.ok(values[Math.round(0.3 * 60) - 1] < 0.75, 'the first half-second leaves time to track the page');
  assert.ok(1 - values[Math.round(0.6 * 60) - 1] < 0.05, 'covers most of the turn in 0.6 s');
  assert.ok(1 - values[Math.round(1.15 * 60) - 1] < 1 / 700, 'within a pixel of a 700 px page by 1.15 s');
  assert.ok(springSettled(current, 1), 'animation loop can stop');
});

test('frame timing does not change the path, and a long stall stays bounded', () => {
  const fine = run({ value: 0, velocity: 0 }, 1, 0.3, 1 / 240).current.value;
  const coarse = run({ value: 0, velocity: 0 }, 1, 0.3, 1 / 30).current.value;
  assert.ok(Math.abs(fine - coarse) < 0.002);
  const stalled = stepSpring({ value: 0, velocity: 0 }, 1, 2);
  assert.ok(stalled.value > 0.99 && stalled.value <= 1);
});

test('retargeting mid-flight keeps velocity continuous', () => {
  const moving = run({ value: 0, velocity: 0 }, 1, 0.12).current;
  const redirected = stepSpring(moving, 2, 1 / 1000);
  assert.ok(Math.abs(redirected.velocity - moving.velocity) < moving.velocity * 0.05);
  assert.ok(redirected.velocity > 0);
  assert.ok(SPRING_OMEGA > 0);
});

test('carried gesture velocity remains bounded without crossing its destination', () => {
  for (const [start, target] of [[0.2, 1], [0.8, 0]]) {
    const velocity = SPRING_OMEGA * (target - start);
    const { current, values } = run({ value: start, velocity }, target, 1.5);
    for (const value of values) {
      assert.ok(value >= Math.min(start, target) && value <= Math.max(start, target));
    }
    assert.ok(springSettled(current, target));
  }
});

test('gestures turn one page on intent and keep the reading position on a short nudge', () => {
  const stride = 600;
  assert.equal(settlePage(0, 60, 0, stride, 3), null, 'a 10% drag springs back');
  assert.equal(settlePage(0, 130, 0, stride, 3), 1, 'a deliberate drag turns forward');
  assert.equal(settlePage(0, 40, 2400, stride, 3), 1, 'a quick flick turns even when short');
  assert.equal(settlePage(600, 480, 0, stride, 3), 0, 'and back');
  assert.equal(settlePage(0, -140, 0, stride, 3), null, 'nothing before the first page');
  assert.equal(settlePage(1200, 1340, 0, stride, 3), null, 'nothing after the last page');
  assert.equal(settlePage(354, 470, 0, stride, 3), 1, 'from the buffer, forward completes the turn');
  assert.equal(settlePage(354, 250, 0, stride, 3), 0, 'and backward returns to the page being read');
  assert.equal(settlePage(0, 1300, 0, stride, 3), 2, 'a long drag may cross more than one page');
  assert.equal(settlePage(0, 300, 0, stride, 1), null, 'single pages never move');
  assert.equal(settlePage(529.35, 583.35, 790, 529.5, 3), 2, 'a flick during the last pixels of a settle still turns');
  assert.equal(settlePage(529.65, 470, -790, 529.5, 3), 0, 'in either direction');
});

test('overscroll resists and stays within a bounded distance', () => {
  assert.equal(constrainOffset(300, 1200, 150), 300);
  const pulled = [-50, -200, -2000].map(value => constrainOffset(value, 1200, 150));
  assert.ok(pulled[0] < 0 && pulled[0] > -50, 'follows, but less than the finger');
  assert.ok(pulled[2] < pulled[1] && pulled[2] > -150, 'never more than the resistance dimension');
  assert.ok(constrainOffset(1300, 1200, 150) - 1200 < 100);
});
