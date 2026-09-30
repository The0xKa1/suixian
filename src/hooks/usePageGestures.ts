import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { constrainOffset, settlePage } from '../lib/motion';
import type { TrackSpring } from './useTrackSpring';

interface PageGestureOptions {
  spring: TrackSpring;
  stride: number;
  pageCount: number;
  enabled: boolean;
  /** A drag has taken hold of the score. */
  onGrab: () => void;
  /** The gesture ended; `page` is the page to settle on, or null to stay put. */
  onSettle: (page: number | null) => void;
}

const DRAG_SLOP = 6;
const WHEEL_COMMIT = 46;
const WHEEL_IDLE = 170;

/** Direct manipulation for the page track: drag or swipe, trackpad and wheel. */
export function usePageGestures(viewport: RefObject<HTMLElement | null>, options: PageGestureOptions) {
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; });

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const resistance = () => Math.min(latest.current.stride * 0.3, 150);
    const maxOffset = () => Math.max(0, latest.current.pageCount - 1) * latest.current.stride;

    let pointer: { id: number; x: number; y: number; start: number; dragging: boolean; samples: { time: number; value: number }[] } | null = null;

    const velocityOf = (samples: { time: number; value: number }[]) => {
      const last = samples[samples.length - 1];
      const first = samples.find(sample => last.time - sample.time <= 90) ?? last;
      const seconds = (last.time - first.time) / 1000;
      return seconds > 0.008 ? (last.value - first.value) / seconds : 0;
    };

    const finishPointer = (commit: boolean) => {
      const state = pointer;
      pointer = null;
      element.removeAttribute('data-dragging');
      if (!state?.dragging) return;
      const { spring, stride, pageCount, onSettle } = latest.current;
      const end = spring.current();
      const velocity = commit ? velocityOf(state.samples) : 0;
      const page = commit ? settlePage(state.start, end, velocity, stride, pageCount) : null;
      onSettle(page);
      spring.release(velocity, page === null ? undefined : page * stride);
    };

    const pointerDown = (event: PointerEvent) => {
      if (!latest.current.enabled || event.button !== 0 || pointer) return;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, start: latest.current.spring.current(), dragging: false, samples: [] };
    };

    const pointerMove = (event: PointerEvent) => {
      if (!pointer || event.pointerId !== pointer.id) return;
      if (event.pointerType === 'mouse' && (event.buttons & 1) === 0) { finishPointer(false); return; }
      const dx = event.clientX - pointer.x;
      const dy = event.clientY - pointer.y;
      if (!pointer.dragging) {
        if (Math.abs(dx) > DRAG_SLOP * 1.5 && Math.abs(dx) > Math.abs(dy)) { pointer = null; return; }
        if (Math.abs(dy) < DRAG_SLOP) return;
        pointer.dragging = true;
        // Start from the slop edge, so the page does not jump when it is picked up.
        pointer.y += Math.sign(dy) * DRAG_SLOP;
        pointer.start = latest.current.spring.current();
        element.setPointerCapture(event.pointerId);
        element.setAttribute('data-dragging', '');
        latest.current.onGrab();
      }
      event.preventDefault();
      const value = constrainOffset(pointer.start - (event.clientY - pointer.y), maxOffset(), resistance());
      latest.current.spring.hold(value);
      pointer.samples.push({ time: event.timeStamp, value });
      if (pointer.samples.length > 12) pointer.samples.shift();
    };

    const pointerUp = (event: PointerEvent) => { if (pointer?.id === event.pointerId) finishPointer(true); };
    const pointerCancel = (event: PointerEvent) => { if (pointer?.id === event.pointerId) finishPointer(false); };
    // Touch starts with implicit capture on the leaf; moving it here makes that leaf's loss bubble up.
    const captureLost = (event: PointerEvent) => { if (event.target === element) pointerCancel(event); };

    // Wheel: a small nudge follows the fingers, a clear intent turns one page,
    // and the inertial tail of that same swipe is ignored.
    let wheel: { start: number; sum: number; direction: number; last: number; samples: { time: number; value: number }[] } | null = null;
    let lock: { since: number; last: number; magnitude: number; direction: number } | null = null;
    let idle = 0;

    const releaseWheel = () => {
      window.clearTimeout(idle);
      if (!wheel) return;
      wheel = null;
      latest.current.onSettle(null);
      latest.current.spring.release();
    };

    const onWheel = (event: WheelEvent) => {
      const { enabled, spring, stride, pageCount, onSettle } = latest.current;
      if (!enabled || event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stride : 1;
      const delta = event.deltaY * scale;
      const direction = Math.sign(delta);
      const magnitude = Math.abs(delta);
      const now = event.timeStamp;

      if (lock) {
        const freshSwipe = now - lock.since > 320 && magnitude > Math.max(10, lock.magnitude * 1.7);
        if (now - lock.last > WHEEL_IDLE || direction !== lock.direction || freshSwipe) lock = null;
        else { lock.last = now; lock.magnitude = magnitude; return; }
      }

      if (!wheel || now - wheel.last > WHEEL_IDLE) {
        wheel = { start: spring.current(), sum: 0, direction, last: now, samples: [] };
      } else if (direction !== wheel.direction) {
        // Reversing mid-nudge measures from where the page rested, not where it was nudged to.
        wheel = { start: wheel.start, sum: 0, direction, last: now, samples: [] };
      }
      wheel.sum += delta;
      wheel.last = now;
      const nudge = constrainOffset(wheel.start + wheel.sum * 0.45, maxOffset(), resistance());
      wheel.samples.push({ time: now, value: nudge });
      if (wheel.samples.length > 8) wheel.samples.shift();

      if (Math.abs(wheel.sum) >= WHEEL_COMMIT) {
        const from = wheel.start;
        const page = settlePage(from, from + direction * stride * 0.5, 0, stride, pageCount);
        if (page !== null) {
          const velocity = velocityOf(wheel.samples);
          spring.hold(nudge);
          window.clearTimeout(idle);
          wheel = null;
          lock = { since: now, last: now, magnitude, direction };
          onSettle(page);
          spring.release(velocity, page * stride);
          return;
        }
      }
      spring.hold(nudge);
      window.clearTimeout(idle);
      idle = window.setTimeout(releaseWheel, WHEEL_IDLE);
    };

    element.addEventListener('pointerdown', pointerDown);
    element.addEventListener('pointermove', pointerMove);
    element.addEventListener('pointerup', pointerUp);
    element.addEventListener('pointercancel', pointerCancel);
    element.addEventListener('lostpointercapture', captureLost);
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.clearTimeout(idle);
      element.removeEventListener('pointerdown', pointerDown);
      element.removeEventListener('pointermove', pointerMove);
      element.removeEventListener('pointerup', pointerUp);
      element.removeEventListener('pointercancel', pointerCancel);
      element.removeEventListener('lostpointercapture', captureLost);
      element.removeEventListener('wheel', onWheel);
    };
  }, [viewport]);
}
