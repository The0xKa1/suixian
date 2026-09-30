import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { SPRING_OMEGA, springSettled, stepSpring } from '../lib/motion';
import type { SpringState } from '../lib/motion';

export interface TrackSpring {
  /** Pin the track under a finger or wheel; the spring resumes from this value on release. */
  hold: (value: number) => void;
  /** Hand the track back to the spring, optionally carrying the gesture's velocity (px/s). */
  release: (velocity?: number, toward?: number) => void;
  current: () => number;
}

/**
 * Drives the page track toward `target` with a critically damped spring.
 * Painting goes straight to the DOM, so a page turn does not re-render the reader.
 * `stride` changes rescale the resting position instead of animating a resize.
 */
export function useTrackSpring(target: number, stride: number, reducedMotion: boolean, resetKey: unknown, paint: (value: number, moving: boolean) => void): TrackSpring {
  const spring = useRef<SpringState>({ value: target, velocity: 0 });
  const destination = useRef(target);
  const held = useRef(false);
  const frame = useRef(0);
  const lastTime = useRef(0);
  const lastStride = useRef(stride);
  const paintRef = useRef(paint);
  const reducedRef = useRef(reducedMotion);
  const loop = useRef<(time: number) => void>(() => {});

  useLayoutEffect(() => {
    paintRef.current = paint;
    reducedRef.current = reducedMotion;
  });

  const stop = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
  }, []);

  const kick = useCallback(() => {
    if (frame.current || held.current) return;
    lastTime.current = 0;
    frame.current = requestAnimationFrame(loop.current);
  }, []);

  useLayoutEffect(() => {
    loop.current = (time: number) => {
      // A stalled tab resumes from the same place instead of teleporting.
      const seconds = lastTime.current ? Math.min(time - lastTime.current, 64) / 1000 : 1 / 60;
      lastTime.current = time;
      const next = stepSpring(spring.current, destination.current, seconds);
      const settled = reducedRef.current || springSettled(next, destination.current, 0.04);
      spring.current = settled ? { value: destination.current, velocity: 0 } : next;
      paintRef.current(spring.current.value, !settled);
      frame.current = settled ? 0 : requestAnimationFrame(loop.current);
    };
    paintRef.current(spring.current.value, false);
    return stop;
  }, [stop]);

  useLayoutEffect(() => {
    stop();
    held.current = false;
    spring.current = { value: 0, velocity: 0 };
    destination.current = 0;
    paintRef.current(0, false);
  }, [resetKey, stop]);

  useLayoutEffect(() => {
    const ratio = lastStride.current > 0 ? stride / lastStride.current : 1;
    lastStride.current = stride;
    if (ratio === 1) return;
    spring.current = { value: spring.current.value * ratio, velocity: spring.current.velocity * ratio };
    paintRef.current(spring.current.value, frame.current !== 0);
  }, [stride]);

  useLayoutEffect(() => {
    destination.current = target;
    if (held.current) return;
    if (reducedRef.current) {
      stop();
      spring.current = { value: target, velocity: 0 };
      paintRef.current(target, false);
    } else kick();
  }, [target, reducedMotion, kick, stop]);

  useEffect(() => stop, [stop]);

  return useMemo<TrackSpring>(() => ({
    hold(value) {
      stop();
      held.current = true;
      spring.current = { value, velocity: 0 };
      paintRef.current(value, true);
    },
    release(velocity = 0, toward = destination.current) {
      held.current = false;
      // Carry the gesture forward, but never so fast that the spring sails past the page.
      const remaining = toward - spring.current.value;
      const limit = SPRING_OMEGA * Math.abs(remaining);
      const carried = Math.sign(velocity) === Math.sign(remaining) ? Math.sign(velocity) * Math.min(Math.abs(velocity), limit) : 0;
      spring.current = { value: spring.current.value, velocity: reducedRef.current ? 0 : carried };
      kick();
    },
    current: () => spring.current.value,
  }), [kick, stop]);
}
