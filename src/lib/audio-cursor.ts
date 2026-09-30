import type { AudioAlignment } from '../types.ts';
import type { ScoreCursor, ScoreReference } from './score-following/types.ts';

export interface AudioCursor extends ScoreCursor { page: number; eventIndex: number; }
export interface CursorTimeline {
  points: Array<{ time: number; cursor: AudioCursor | null; connect: boolean }>;
  start: number;
  end: number;
}

export function validScoreCursor(cursor: ScoreCursor | undefined): cursor is ScoreCursor {
  return !!cursor && [cursor.x, cursor.y, cursor.height, cursor.system].every(Number.isFinite)
    && cursor.x >= 0 && cursor.x <= 1 && cursor.y >= 0 && cursor.height > 0
    && cursor.y + cursor.height <= 1.000001 && Number.isInteger(cursor.system) && cursor.system >= 0;
}

/** Join visual coordinates to actual matched onsets once, before the playback loop. */
export function buildCursorTimeline(reference: ScoreReference | undefined, alignment: AudioAlignment, pageCount: number): CursorTimeline {
  const empty = { points: [], start: alignment.activeStart, end: alignment.activeEnd };
  if (!reference?.events.length || !Number.isFinite(alignment.activeStart) || !Number.isFinite(alignment.activeEnd)
    || alignment.activeEnd <= alignment.activeStart) return empty;
  const anchors = new Map<number, number>();
  for (const point of alignment.points) {
    if (!Number.isFinite(point.position) || !Number.isFinite(point.time)) return empty;
    // The initial (0, 0) marker is not necessarily the first played note.
    if (point.time >= alignment.activeStart && point.time < alignment.activeEnd) anchors.set(point.position, point.time);
  }
  const points: CursorTimeline['points'] = [];
  for (const [eventIndex, event] of reference.events.entries()) {
    const time = anchors.get(event.position);
    const page = Math.floor(event.position);
    if (time === undefined || page < 0 || page >= pageCount || (points.length && time <= points.at(-1)!.time)) return empty;
    const cursor = validScoreCursor(event.cursor) ? { ...event.cursor, page, eventIndex } : null;
    const previous = points.at(-1);
    const previousEvent = reference.events[eventIndex - 1];
    if (previous?.cursor && cursor) {
      previous.connect = previous.cursor.page === page && previous.cursor.system === cursor.system
        && cursor.x >= previous.cursor.x
        // A written rest has no confirmed path between its two sounding anchors.
        && event.beat - previousEvent.beat <= previousEvent.durationBeats + 0.0001;
    }
    points.push({ time, cursor, connect: false });
  }
  // Saved documents may contain per-onset staff bounds. Normalize only proven
  // cursors within the same page/system; absent coordinates must stay absent.
  const systems = new Map<string, { top: number; bottom: number }>();
  for (const { cursor } of points) {
    if (!cursor) continue;
    const key = `${cursor.page}:${cursor.system}`;
    const bounds = systems.get(key);
    systems.set(key, { top: Math.min(bounds?.top ?? cursor.y, cursor.y),
      bottom: Math.max(bounds?.bottom ?? 0, cursor.y + cursor.height) });
  }
  for (const point of points) {
    const cursor = point.cursor;
    if (!cursor) continue;
    const bounds = systems.get(`${cursor.page}:${cursor.system}`)!;
    if (cursor.y !== bounds.top || cursor.y + cursor.height !== bounds.bottom) {
      point.cursor = { ...cursor, y: bounds.top, height: bounds.bottom - bounds.top };
    }
  }
  return { points, start: alignment.activeStart, end: alignment.activeEnd };
}

/** Media-time lookup; row/page changes wait for the next onset instead of sweeping diagonally. */
export function audioCursorAtTime(timeline: CursorTimeline, time: number): AudioCursor | null {
  const { points } = timeline;
  if (!Number.isFinite(time) || time < timeline.start || time >= timeline.end || !points.length || time < points[0].time) return null;
  let low = 0, high = points.length;
  while (low < high) { const mid = (low + high) >>> 1; if (points[mid].time <= time) low = mid + 1; else high = mid; }
  const current = points[low - 1];
  const next = points[low];
  if (!current.cursor) return null;
  if (!current.connect || !next?.cursor) return current.cursor;
  const fraction = (time - current.time) / (next.time - current.time);
  return { ...current.cursor, x: current.cursor.x + fraction * (next.cursor.x - current.cursor.x) };
}

/** Keep the current staff visible even if the early-preview window starts above it. */
export function cursorVisibleOffset(target: number, top: number, bottom: number, viewportHeight: number): number {
  const margin = Math.min(28, viewportHeight * 0.08);
  const min = bottom - viewportHeight + margin;
  const max = top - margin;
  return min <= max ? Math.max(0, Math.min(max, Math.max(min, target))) : target;
}
