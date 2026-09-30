import type { AudioAlignment } from '../types.ts';
import type { ScoreEvent, ScoreReference } from './score-following/types.ts';

type Anchor = NonNullable<AudioAlignment['anchors']>[number];
type EventEntry = { event: ScoreEvent; id: string };

const invalidAlignment = () => new Error('音频锚点与谱面音符不完整或不一致，无法重新排版同步。');
const nearlyEqual = (a: number, b: number) => Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(a), Math.abs(b));

function referenceEntries(reference: ScoreReference, pageCount?: number): EventEntry[] | null {
  if (!reference.events.length || (pageCount !== undefined && (!Number.isInteger(pageCount) || pageCount < 1))) return null;
  const ids = new Set<string>();
  const entries: EventEntry[] = [];
  for (const [index, event] of reference.events.entries()) {
    const id = event.id ?? `event-${index}`;
    const previous = entries.at(-1)?.event;
    if (typeof id !== 'string' || !id || ids.has(id) || !Number.isFinite(event.beat) || event.beat < 0
      || !Number.isFinite(event.durationBeats) || event.durationBeats <= 0
      || !Number.isFinite(event.position) || event.position < 0
      || (pageCount !== undefined && event.position >= pageCount)
      || !event.midi.length || event.midi.some((pitch) => !Number.isFinite(pitch))
      || (previous && (event.beat <= previous.beat || event.position <= previous.position))) return null;
    ids.add(id);
    entries.push({ event, id });
  }
  return entries;
}

function sameMusic(a: ScoreEvent, b: ScoreEvent): boolean {
  if (!nearlyEqual(a.beat, b.beat) || !nearlyEqual(a.durationBeats, b.durationBeats) || a.midi.length !== b.midi.length) return false;
  const pitches = [...b.midi].sort((x, y) => x - y);
  return [...a.midi].sort((x, y) => x - y).every((pitch, index) => pitch === pitches[index]);
}

/** Missing IDs are a legacy case: require the same unique musical event, never a page ratio. */
function correspondingEntries(from: EventEntry[], to: EventEntry[]): EventEntry[] | null {
  if (from.length !== to.length) return null;
  const byId = new Map(to.map((entry) => [entry.id, entry]));
  const used = new Set<EventEntry>();
  const matched: EventEntry[] = [];
  for (const source of from) {
    let target = byId.get(source.id);
    if (!target || !sameMusic(source.event, target.event)) {
      const candidates = to.filter((candidate) => (!source.event.id || !candidate.event.id)
        && sameMusic(source.event, candidate.event));
      if (candidates.length !== 1) return null;
      target = candidates[0];
    }
    if (!sameMusic(source.event, target.event) || used.has(target)
      || (matched.length && target.event.position <= matched.at(-1)!.event.position)) return null;
    used.add(target);
    matched.push(target);
  }
  return matched;
}

function validTiming(alignment: AudioAlignment): boolean {
  return [alignment.duration, alignment.activeStart, alignment.activeEnd].every(Number.isFinite)
    && alignment.duration > 0 && alignment.activeStart >= 0
    && alignment.activeEnd > alignment.activeStart && alignment.activeEnd <= alignment.duration;
}

function validAnchors(anchors: Anchor[], entries: EventEntry[], alignment: AudioAlignment): Anchor[] | null {
  if (anchors.length !== entries.length) return null;
  const byId = new Map<string, Anchor>();
  for (const anchor of anchors) {
    if (typeof anchor.eventId !== 'string' || !anchor.eventId || byId.has(anchor.eventId) || !Number.isFinite(anchor.beat)
      || !Number.isFinite(anchor.time) || anchor.time < alignment.activeStart || anchor.time >= alignment.activeEnd) return null;
    byId.set(anchor.eventId, anchor);
  }
  const ordered: Anchor[] = [];
  for (const entry of entries) {
    const anchor = byId.get(entry.id);
    if (!anchor || !nearlyEqual(anchor.beat, entry.event.beat)
      || (ordered.length && anchor.time <= ordered.at(-1)!.time)) return null;
    ordered.push({ ...anchor });
  }
  return ordered;
}

/** Attach identities only to exact matched onsets; interpolation is not onset evidence. Throws on incomplete evidence. */
export function bindAlignmentAnchors(alignment: AudioAlignment, reference: ScoreReference): AudioAlignment {
  const entries = referenceEntries(reference);
  if (!entries || !validTiming(alignment)) throw invalidAlignment();
  if (alignment.anchors !== undefined) {
    const anchors = validAnchors(alignment.anchors, entries, alignment);
    if (!anchors) throw invalidAlignment();
    return { ...alignment, anchors };
  }

  const timesByPosition = new Map<number, Set<number>>();
  for (const [index, point] of alignment.points.entries()) {
    const previous = alignment.points[index - 1];
    if (!Number.isFinite(point.time) || !Number.isFinite(point.position) || point.time < 0
      || point.time > alignment.duration || point.position < 0
      || (previous && (point.time < previous.time || point.position < previous.position))) throw invalidAlignment();
    // Excludes the initial marker in pre-roll and the end marker in trailing silence.
    if (point.time < alignment.activeStart || point.time >= alignment.activeEnd) continue;
    const times = timesByPosition.get(point.position) ?? new Set<number>();
    times.add(point.time);
    timesByPosition.set(point.position, times);
  }
  const anchors: Anchor[] = entries.map(({ id, event }) => {
    const times = timesByPosition.get(event.position);
    if (times?.size !== 1) throw invalidAlignment();
    return { eventId: id, beat: event.beat, time: [...times][0] };
  });
  if (!validAnchors(anchors, entries, alignment)) throw invalidAlignment();
  return { ...alignment, anchors };
}

/** Rebuild display coordinates while preserving every acoustic onset and the active audio bounds. */
export function remapAlignment(
  alignment: AudioAlignment, originalReference: ScoreReference, renderedReference: ScoreReference, pageCount: number,
): AudioAlignment {
  const original = referenceEntries(originalReference);
  const rendered = referenceEntries(renderedReference, pageCount);
  const matched = original && rendered && correspondingEntries(original, rendered);
  if (!original || !rendered || !matched) throw invalidAlignment();
  const bound = bindAlignmentAnchors(alignment, originalReference);
  const anchors = bound.anchors!.map((anchor, index) => ({ ...anchor, eventId: matched[index].id }));
  const points = [{ time: 0, position: 0 }, ...anchors.map((anchor, index) => ({
    time: anchor.time, position: matched[index].event.position,
  })), { time: alignment.activeEnd, position: pageCount }];
  if (alignment.activeEnd < alignment.duration) points.push({ time: alignment.duration, position: pageCount });

  const pageConfidence = new Array<number>(pageCount).fill(Infinity);
  for (const [index, target] of matched.entries()) {
    const sourcePage = Math.floor(original[index].event.position);
    const targetPage = Math.floor(target.event.position);
    const confidence = alignment.pageConfidence[sourcePage];
    // The old page aggregate cannot justify a higher confidence on any derived page.
    pageConfidence[targetPage] = Math.min(pageConfidence[targetPage],
      Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0);
  }
  // There is no confirmed first onset for an empty page, hence no safe seek/buffer boundary.
  if (pageConfidence.some((confidence) => confidence === Infinity)) throw invalidAlignment();
  return { ...alignment, anchors, points, pageConfidence };
}

/** Preserve a manual reading location across layouts. Null means the music cannot be identified safely. */
export function mapReadingPosition(
  position: number, fromReference: ScoreReference, toReference: ScoreReference, fromPageCount: number, toPageCount: number,
): number | null {
  if (!Number.isFinite(position)) return null;
  const from = referenceEntries(fromReference, fromPageCount);
  const to = referenceEntries(toReference, toPageCount);
  const matched = from && to && correspondingEntries(from, to);
  if (!from || !to || !matched) return null;
  if (position >= fromPageCount) return toPageCount;
  if (position < 0) return 0;
  const exactIndex = from.findIndex(({ event }) => event.position === position);
  if (exactIndex >= 0) return matched[exactIndex].event.position;
  if (position === 0) return 0;

  const nextIndex = from.findIndex(({ event }) => event.position > position);
  // These are document edges around known music, not evenly allocated page timings.
  const before = nextIndex === 0 ? { from: 0, to: 0 }
    : { from: from[nextIndex < 0 ? from.length - 1 : nextIndex - 1].event.position,
      to: matched[nextIndex < 0 ? matched.length - 1 : nextIndex - 1].event.position };
  const after = nextIndex < 0 ? { from: fromPageCount, to: toPageCount }
    : { from: from[nextIndex].event.position, to: matched[nextIndex].event.position };
  const fraction = (position - before.from) / (after.from - before.from);
  const mapped = before.to + fraction * (after.to - before.to);
  // A manual page seek makes a round trip through source coordinates. Floating
  // point noise just below an integer must not send Math.floor back one page.
  const boundary = Math.round(mapped);
  return Math.abs(mapped - boundary) < 1e-10 ? boundary : mapped;
}
