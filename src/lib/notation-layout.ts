import type { ScoreReference } from './score-following/types.ts';

/** Locations come from the engraver, never from the amount of music left on a page. */
export interface NotationEventLocation {
  beat: number;
  midi: number[];
  page: number;
  system: number;
  x: number;
  y: number;
  height: number;
}

export interface NotationMeasureLocation {
  startBeat: number;
  durationBeats: number;
  page: number;
}

function validLocation(location: NotationEventLocation): boolean {
  return Number.isInteger(location.page) && location.page >= 0
    && Number.isInteger(location.system) && location.system >= 0
    && [location.x, location.y, location.height].every(Number.isFinite)
    && location.x >= 0 && location.x <= 1 && location.y >= 0 && location.height > 0
    && location.y + location.height <= 1;
}

/** Preserve musical order and identity while replacing only presentation coordinates. */
export function mapNotationReference(reference: ScoreReference, locations: readonly NotationEventLocation[], measures: readonly NotationMeasureLocation[]): ScoreReference {
  const systems = new Map<string, { top: number; bottom: number }>();
  for (const location of locations) {
    if (!validLocation(location)) continue;
    const key = `${location.page}:${location.system}`;
    const bounds = systems.get(key);
    systems.set(key, { top: Math.min(bounds?.top ?? location.y, location.y),
      bottom: Math.max(bounds?.bottom ?? 0, location.y + location.height) });
  }
  const mapped = reference.events.map((event, index) => {
    const matches = locations.filter(location => Math.abs(location.beat - event.beat) < 0.00001);
    const pitches = new Set(matches.flatMap(match => match.midi));
    const exact = matches.length > 0 && event.midi.every(pitch => pitches.has(pitch))
      && matches.every(match => match.page === matches[0].page && match.system === matches[0].system);
    const anchor = exact && matches.every(validLocation) ? matches[0] : undefined;
    const measure = measures.find(item => event.beat >= item.startBeat - 0.00001 && event.beat < item.startBeat + item.durationBeats - 0.00001);
    const page = anchor?.page ?? measure?.page;
    if (page === undefined) throw new Error('重排后的乐谱无法对应原音符，请使用原件。');
    const { cursor: _oldCursor, ...musicalEvent } = event;
    const mappedEvent = { ...musicalEvent, id: event.id ?? `event-${index}`, position: page };
    if (!anchor) return { page, event: mappedEvent };
    const { top, bottom } = systems.get(`${page}:${anchor.system}`)!;
    const x = Math.min(...matches.map(match => match.x));
    const cursor = { x, y: top, height: bottom - top, system: anchor.system };
    const valid = [x, top, bottom].every(Number.isFinite) && x >= 0 && x <= 1 && top >= 0 && bottom <= 1 && bottom > top;
    return { page, event: valid ? { ...mappedEvent, cursor } : mappedEvent };
  });
  if (mapped.some((item, index) => index > 0 && item.page < mapped[index - 1].page)) {
    throw new Error('重排后的谱行顺序不一致，请使用原件。');
  }
  const counts = new Map<number, number>();
  const seen = new Map<number, number>();
  for (const { page } of mapped) counts.set(page, (counts.get(page) ?? 0) + 1);
  return { ...reference, events: mapped.map(({ page, event }) => {
    const index = seen.get(page) ?? 0;
    seen.set(page, index + 1);
    // This is an ordered audio key, not a guessed graphic coordinate. Actual x/y is separate.
    return { ...event, position: page + (index + 0.01) / counts.get(page)! };
  }) };
}
