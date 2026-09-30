// WeekSync's public landing bundle uses a 1600ms easeInOutQuad anchor motion.
export function setupAnchorMotion() {
  let frame = 0;
  const cancel = () => { cancelAnimationFrame(frame); };
  const click = (event: MouseEvent) => {
    if(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="#"]') : null;
    if (!anchor) return;
    const target = document.querySelector(anchor.getAttribute('href')!);
    if (!target) return;
    event.preventDefault(); cancel();
    const start = window.scrollY;
    const end = anchor.getAttribute('href') === '#top' ? 0 : Math.min(document.documentElement.scrollHeight - innerHeight, Math.max(0, target.getBoundingClientRect().top + start - 38));
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { window.scrollTo({top:end,behavior:'instant'}); return; }
    const started = performance.now();
    const step = (time:number) => {
      const t = Math.min(1,(time-started)/1600);
      const ease = t < .5 ? 2*t*t : 1 - (-2*t+2)**2/2;
      window.scrollTo({top:start+(end-start)*ease,behavior:'instant'});
      if(t<1) frame=requestAnimationFrame(step);
    };
    frame=requestAnimationFrame(step);
  };
  document.addEventListener('click', click);
  window.addEventListener('wheel', cancel, {passive:true});
  window.addEventListener('touchstart', cancel, {passive:true});
  window.addEventListener('keydown', cancel);
  return () => { cancel(); document.removeEventListener('click',click); window.removeEventListener('wheel',cancel); window.removeEventListener('touchstart',cancel); window.removeEventListener('keydown',cancel); };
}

export interface SpringState { value: number; velocity: number; }

/** About 0.6 s to cover 95% of a turn, leaving time to follow the score as it moves. */
export const SPRING_OMEGA = 8;

/**
 * Critically damped spring, solved in closed form rather than integrated,
 * so a dropped frame cannot overshoot and a retarget keeps the current velocity.
 */
export function stepSpring(state: SpringState, target: number, seconds: number, omega = SPRING_OMEGA): SpringState {
  const displacement = state.value - target;
  const drift = state.velocity + omega * displacement;
  const decay = Math.exp(-omega * Math.max(0, seconds));
  return {
    value: target + (displacement + drift * seconds) * decay,
    velocity: (state.velocity - omega * drift * seconds) * decay,
  };
}

export function springSettled(state: SpringState, target: number, epsilon = 0.0004): boolean {
  return Math.abs(state.value - target) < epsilon && Math.abs(state.velocity) < epsilon * 10;
}

const COMMIT = 0.16;
const PROJECTION_SECONDS = 0.16;

/** iOS-style resistance: the further past an end, the less the page follows. */
export function rubberBand(overflow: number, dimension: number): number {
  const distance = Math.abs(overflow);
  return Math.sign(overflow) * (1 - 1 / (distance * 0.55 / dimension + 1)) * dimension;
}

export function constrainOffset(raw: number, maxOffset: number, dimension: number): number {
  if (raw < 0) return rubberBand(raw, dimension);
  if (raw > maxOffset) return maxOffset + rubberBand(raw - maxOffset, dimension);
  return raw;
}

/**
 * Where a gesture that began at `start` px should come to rest, in pages.
 * Short or slow gestures return null so a reading position inside a page survives.
 */
export function settlePage(start: number, end: number, velocity: number, stride: number, pageCount: number): number | null {
  if (stride <= 0 || pageCount < 2) return null;
  // A spring still settling onto a page counts as resting on it.
  const raw = start / stride;
  const startPage = Math.abs(raw - Math.round(raw)) < 0.02 ? Math.round(raw) : raw;
  const projected = (end + velocity * PROJECTION_SECONDS) / stride;
  const delta = projected - startPage;
  if (Math.abs(delta) < COMMIT) return null;
  const page = delta > 0
    ? Math.max(Math.floor(startPage) + 1, Math.round(projected))
    : Math.min(Math.ceil(startPage) - 1, Math.round(projected));
  const bounded = Math.max(0, Math.min(pageCount - 1, page));
  if (delta > 0 ? bounded <= startPage : bounded >= startPage) return null;
  return bounded;
}
