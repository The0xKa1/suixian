export type ReadingPhase = 'reading' | 'buffer' | 'complete';

export const PAGE_SECONDS = 16;
export const BUFFER_START = 0.62;
export const PAGE_GAP = 24;
const BUFFER_ARRIVAL = 0.79;
const BUFFER_DEPARTURE = 0.89;
const BUFFER_OFFSET = 0.59;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Fit the viewport to the paper, so a narrow landscape page cannot leak its successor. */
export function readerGeometry(width: number, maxViewportHeight: number, maxPageWidth: number, maxPageHeight: number) {
  const topInset = 16;
  const scale = Math.min(Math.max(1, width - 52) / Math.max(1, maxPageWidth), Math.max(1, maxViewportHeight - topInset * 2) / Math.max(1, maxPageHeight));
  const leafHeight = maxPageHeight * scale;
  return { scale, leafHeight, topInset, viewportHeight: leafHeight + topInset * 2, stride: leafHeight + PAGE_GAP };
}

/** Zero velocity at each end keeps the two moves and the dwell connected. */
export function smootherStep(value: number): number {
  const t = clamp01(value);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Fade only the entering/leaving edges; both pages stay fully legible in the buffer. */
export function pageOpacity(pageIndex: number, offsetPages: number): number {
  const distance = Math.abs(pageIndex - offsetPages);
  return 1 - smootherStep((distance - 0.62) / 0.38);
}

export function pageTravel(progress: number): number {
  if (progress <= BUFFER_START) return 0;
  if (progress < BUFFER_ARRIVAL) {
    return BUFFER_OFFSET * smootherStep((progress - BUFFER_START) / (BUFFER_ARRIVAL - BUFFER_START));
  }
  if (progress <= BUFFER_DEPARTURE) return BUFFER_OFFSET;
  return BUFFER_OFFSET + (1 - BUFFER_OFFSET) * smootherStep((progress - BUFFER_DEPARTURE) / (1 - BUFFER_DEPARTURE));
}

export function readingState(position: number, pageCount: number) {
  const count = Math.max(1, pageCount);
  const bounded = Math.max(0, Math.min(count, position));
  const pageIndex = Math.min(Math.floor(bounded), count - 1);
  const progress = bounded >= count ? 1 : bounded - pageIndex;
  const hasNext = pageIndex < count - 1;
  const phase: ReadingPhase = bounded >= count ? 'complete' : hasNext && progress >= BUFFER_START ? 'buffer' : 'reading';
  return { pageIndex, progress, hasNext, phase };
}

/** One continuous coordinate system: the boundary equals the next page origin. */
export function trackOffset(position: number, pageCount: number, stride: number): number {
  const { pageIndex, progress, hasNext } = readingState(position, pageCount);
  return (pageIndex + (hasNext ? pageTravel(progress) : 0)) * stride;
}

/** Keep the played page's tail until an observed note belongs to its successor. */
export function followingTrackOffset(position: number, pageCount: number, stride: number): number {
  const { pageIndex, progress, hasNext } = readingState(position, pageCount);
  const travel = hasNext ? BUFFER_OFFSET * smootherStep((progress - BUFFER_START) / (BUFFER_ARRIVAL - BUFFER_START)) : 0;
  return (pageIndex + travel) * stride;
}
