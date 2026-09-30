import type { AudioAlignment } from '../types.ts';
import { audioTimeAtPosition } from './audio-alignment.ts';

export interface AudioBufferState {
  /** Zero-based index of the incoming page; also the identity used by skipBoundary. */
  boundaryPage: number;
  fromPage: number;
  toPage: number;
  phase: 'approach' | 'hold' | 'depart';
  /** Absolute track displacement in page strides, independent of musical row positions. */
  offsetPages: number;
  startTime: number;
  boundaryTime: number;
  endTime: number;
}

interface BufferWindow {
  startTime: number;
  approachEnd: number;
  boundaryTime: number;
  departStart: number;
  endTime: number;
}

// Zero velocity and acceleration at either end keep the stationary hold calm.
const smootherstep = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * t * (t * (6 * t - 15) + 10);
};

function bufferWindow(
  alignment: AudioAlignment, boundaryPage: number, duration: number, pageCount: number, leadSeconds: number,
): BufferWindow | null {
  if (!Number.isInteger(pageCount) || !Number.isInteger(boundaryPage) || boundaryPage < 1 || boundaryPage >= pageCount
    || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(leadSeconds) || leadSeconds <= 0
    || !Number.isFinite(alignment.activeStart) || !Number.isFinite(alignment.activeEnd) || !alignment.points.length) return null;

  const activeStart = Math.max(0, alignment.activeStart);
  const activeEnd = Math.min(duration, alignment.activeEnd);
  const boundaryTime = audioTimeAtPosition(alignment, boundaryPage, duration, pageCount);
  const previousTime = boundaryPage === 1 ? activeStart : audioTimeAtPosition(alignment, boundaryPage - 1, duration, pageCount);
  const nextTime = boundaryPage === pageCount - 1 ? activeEnd : audioTimeAtPosition(alignment, boundaryPage + 1, duration, pageCount);
  if (![previousTime, boundaryTime, nextTime].every(Number.isFinite)
    || previousTime < activeStart || nextTime > activeEnd || previousTime >= boundaryTime || boundaryTime >= nextTime) return null;

  // In each page span the previous buffer uses at most its first 40%, while
  // the following buffer starts no earlier than 60%: short pages never overlap.
  const lead = Math.min(leadSeconds, (boundaryTime - previousTime) * 0.4);
  const nextSpan = nextTime - boundaryTime;
  const startTime = boundaryTime - lead;
  const departStart = boundaryTime + Math.min(2, nextSpan * 0.25);
  return {
    startTime,
    approachEnd: startTime + Math.min(1.1, lead * 0.5),
    boundaryTime,
    departStart,
    endTime: departStart + Math.min(1.1, nextSpan * 0.15),
  };
}

/** The first instant an acoustically matched page boundary starts its preview. */
export function audioBufferStartTime(
  alignment: AudioAlignment, boundaryPage: number, duration: number, pageCount: number, leadSeconds = 4,
): number | null {
  return bufferWindow(alignment, boundaryPage, duration, pageCount, leadSeconds)?.startTime ?? null;
}

/**
 * Preview the next page early, then retain both page halves past its matched
 * first note. This changes only the viewport, never the audio/score alignment.
 * Outside a buffer, callers show the matched page at a whole-page stride.
 */
export function audioBufferState(
  alignment: AudioAlignment, time: number, duration: number, pageCount: number, leadSeconds = 4, skipBoundary?: number,
): AudioBufferState | null {
  if (!Number.isFinite(time) || !Number.isInteger(pageCount) || pageCount < 2
    || !Number.isFinite(leadSeconds) || leadSeconds <= 0) return null;
  for (let boundaryPage = 1; boundaryPage < pageCount; boundaryPage++) {
    if (boundaryPage === skipBoundary) continue;
    const window = bufferWindow(alignment, boundaryPage, duration, pageCount, leadSeconds);
    if (!window || time < window.startTime || time > window.endTime) continue;
    let phase: AudioBufferState['phase'] = 'hold';
    let travel = 0.5;
    if (time < window.approachEnd) {
      phase = 'approach';
      travel = 0.5 * smootherstep((time - window.startTime) / (window.approachEnd - window.startTime));
    } else if (time > window.departStart) {
      phase = 'depart';
      travel += 0.5 * smootherstep((time - window.departStart) / (window.endTime - window.departStart));
    }
    return {
      boundaryPage,
      fromPage: boundaryPage - 1,
      toPage: boundaryPage,
      phase,
      offsetPages: boundaryPage - 1 + travel,
      startTime: window.startTime,
      boundaryTime: window.boundaryTime,
      endTime: window.endTime,
    };
  }
  return null;
}
