import test from 'node:test';
import assert from 'node:assert/strict';
import { followingTrackOffset, pageOpacity, pageTravel, readerGeometry, readingState, trackOffset } from './transition.ts';

test('page fades keep buffer halves clear and never blank the viewport', () => {
  for (const offset of [0.5, 0.59, 1.5, 1.59]) {
    assert.equal(pageOpacity(Math.floor(offset), offset), 1, 'previous tail stays legible');
    assert.equal(pageOpacity(Math.ceil(offset), offset), 1, 'incoming head stays legible');
  }
  let previousIncoming = 0;
  let previousOutgoing = 1;
  for (let tick = 0; tick <= 1000; tick++) {
    const offset = tick / 1000;
    const incoming = pageOpacity(1, offset);
    const outgoing = pageOpacity(0, offset);
    assert.equal(Math.max(incoming, outgoing), 1, 'at least one page remains fully opaque');
    assert.ok(incoming >= previousIncoming && outgoing <= previousOutgoing);
    assert.ok(incoming - previousIncoming < 0.006 && previousOutgoing - outgoing < 0.006, 'no opacity steps');
    assert.ok(Math.abs(incoming - pageOpacity(0, 1 - offset)) < 1e-12, 'reverse navigation is symmetric');
    previousIncoming = incoming;
    previousOutgoing = outgoing;
  }
  assert.equal(pageOpacity(0, 0), 1);
  assert.equal(pageOpacity(1, 0), 0);
  assert.equal(pageOpacity(2, 2), 1, 'last page stays visible');
});

test('buffer movement pauses with both pages visible, then completes without a position jump', () => {
  assert.equal(pageTravel(0.6), 0);
  assert.equal(pageTravel(0.79), pageTravel(0.89));
  assert.ok(pageTravel(0.79) > 0 && pageTravel(0.79) < 1);
  for (let boundary = 1; boundary < 5; boundary++) {
    const before = trackOffset(boundary - 0.000001, 5, 436);
    const after = trackOffset(boundary + 0.000001, 5, 436);
    assert.ok(Math.abs(after - before) < 0.000001);
  }
});

test('travel never reverses or overshoots across all page transitions', () => {
  let previous = 0;
  for (let tick = 0; tick <= 5000; tick++) {
    const offset = trackOffset(tick / 1000, 5, 436);
    assert.ok(offset >= previous - 0.00000001);
    assert.ok(offset >= 0 && offset <= 4 * 436);
    previous = offset;
  }
});

test('last and single pages remain readable at completion', () => {
  assert.equal(trackOffset(5, 5, 436), 4 * 436);
  assert.equal(readingState(5, 5).phase, 'complete');
  assert.equal(readingState(4.8, 5).phase, 'reading');
  assert.equal(trackOffset(0.9, 1, 436), 0);
  assert.equal(readingState(0.9, 1).hasNext, false);
  assert.equal(trackOffset(-1, 5, 436), 0);
});

test('listening keeps the final score row visible until the next page is confirmed', () => {
  for (const [width, cap] of [[300, 320], [1000, 640]]) {
    const { topInset, scale, stride, viewportHeight } = readerGeometry(width, cap, 920, 620);
    const buffer = followingTrackOffset(0.8, 3, stride);
    for (const progress of [0.89, 0.97, 0.992, 0.9999]) {
      const offset = followingTrackOffset(progress, 3, stride);
      assert.equal(offset, buffer, 'no clock-based departure while the final row is played');
      const finalRowTop = topInset + 480 * scale - offset;
      const finalRowBottom = topInset + 555 * scale - offset;
      assert.ok(finalRowTop > 0 && finalRowBottom < viewportHeight);
      assert.ok(topInset + stride - offset < viewportHeight, 'next page preview remains visible');
    }
    assert.equal(followingTrackOffset(1.008, 3, stride), stride);
    assert.equal(followingTrackOffset(2.99, 3, stride), 2 * stride);
  }
});

test('mobile and desktop geometry hide neighboring pages until the buffer arrives', () => {
  for (const [width, cap] of [[300, 320], [366, 320], [640, 360], [1000, 440]]) {
    for (const [pageWidth, pageHeight] of [[920, 620], [595, 842]]) {
      const geometry = readerGeometry(width, cap, pageWidth, pageHeight);
      const { topInset, leafHeight, stride, viewportHeight, scale } = geometry;
      assert.ok(viewportHeight <= cap + 0.000001);
      assert.ok(pageWidth * scale <= width - 52 + 0.000001);
      assert.ok(topInset >= 0 && topInset + leafHeight <= viewportHeight);
      assert.ok(topInset + stride > viewportHeight, 'next page is below the resting viewport');
      assert.ok(topInset - stride + leafHeight < 0, 'previous page is above the resting viewport');
      const bufferOffset = trackOffset(0.84, 3, stride);
      assert.ok(topInset + leafHeight - bufferOffset > 0, 'old page tail remains visible');
      assert.ok(topInset + stride - bufferOffset < viewportHeight, 'next page head is visible');
    }
  }
  assert.ok(readerGeometry(300, 320, 920, 620).viewportHeight < 210, 'landscape viewport shrinks at mobile width');
});
