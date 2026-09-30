import type { ScoreDocument, ScorePage } from '../types';
import type { ScoreCursor } from './score-following/types';
import { createDemoScore } from './demo-score.ts';

const SVG_PREFIX = 'data:image/svg+xml;charset=utf-8,';
const NUMBER = '-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?';

/** Read only the exact SVG grammar emitted by the original MusicXML TAB renderer. */
function legacyMusicXmlRows(page: ScorePage, index: number, count: number): number[][] | null {
  if (page.width !== 920 || page.height !== 620 || !page.src.startsWith(SVG_PREFIX)) return null;
  let svg: string;
  try { svg = decodeURIComponent(page.src.slice(SVG_PREFIX.length)); } catch { return null; }
  const prefix = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="920" height="620" viewBox="0 0 920 620"><rect width="920" height="620" fill="#f9f7f3"\/><g fill="#282b28" font-family="serif"><text x="460" y="52" text-anchor="middle" font-size="26">[^<]*<\/text><text x="58" y="88" font-size="11">GUITAR \/ TAB<\/text>/;
  const head = svg.match(prefix)?.[0];
  const tail = `<text x="862" y="591" text-anchor="end" font-size="12">${index + 1} / ${count}</text></g></svg>`;
  if (!head || !svg.endsWith(tail)) return null;
  let body = svg.slice(head.length, -tail.length);
  const rows: number[][] = [];
  while (body && rows.length < 4) {
    const row = rows.length, y = 138 + row * 112;
    const label = new RegExp(`^<text x="58" y="${y - 16}" font-size="11" fill="#777">[^<]*</text>`).exec(body)?.[0];
    if (!label) return null;
    body = body.slice(label.length);
    const staff = `<text x="60" y="${y + 13}" font-size="12">T<tspan x="60" dy="15">A</tspan><tspan x="60" dy="15">B</tspan></text><g stroke="#8b8a81" stroke-width=".65" fill="none">`
      + Array.from({ length: 6 }, (_, string) => `<path d="M80 ${y + string * 10}H868"/>`).join('')
      + `<path d="M80 ${y}v50M868 ${y}v50"/>`;
    if (!body.startsWith(staff)) return null;
    body = body.slice(staff.length);
    const xs: number[] = [];
    const tick = new RegExp(`^<path d="M(${NUMBER}) ${y + 64}v10"/>`);
    for (let match; (match = tick.exec(body)); body = body.slice(match[0].length)) {
      const x = Number(match[1]);
      if (!Number.isFinite(x) || x < 112 || x > 832 || xs.includes(x)) return null;
      xs.push(x);
    }
    if (!body.startsWith('</g>')) return null;
    body = body.slice(4);
    const renderedXs = new Set<number>();
    const note = new RegExp(`^<rect x="(${NUMBER})" y="(${NUMBER})" width="18" height="16" fill="#f9f7f3"/><text x="(${NUMBER})" y="(${NUMBER})" text-anchor="middle" font-family="monospace" font-size="15">\\d+</text>`);
    for (let match; (match = note.exec(body)); body = body.slice(match[0].length)) {
      const [, rx, ry, tx, ty] = match.map(Number);
      const string = (ty - 5 - y) / 10;
      if (Math.abs(rx + 9 - tx) > 1e-7 || ry + 13 !== ty || !Number.isInteger(string) || string < 0 || string > 5 || !xs.includes(tx)) return null;
      renderedXs.add(tx);
    }
    if (xs.some(x => !renderedXs.has(x))) return null;
    rows.push(xs);
  }
  return body || !rows.length ? null : rows;
}

/** Restore geometry for saved, verifiably generated TAB pages without changing their timeline. */
export function hydrateRenderedCursors<T extends ScoreDocument>(document: T): T {
  const reference = document.reference;
  if (!reference?.events.length || reference.events.every(event => event.cursor)) return document;
  let cursors: ScoreCursor[];
  if (document.kind === 'demo') {
    const original = createDemoScore();
    if (document.pages.length !== original.pages.length || document.pages.some((page, index) =>
      page.width !== original.pages[index].width || page.height !== original.pages[index].height || page.src !== original.pages[index].src)) return document;
    const expected = original.reference!.events;
    if (reference.events.length !== expected.length || reference.events.some((event, index) => {
      const other = expected[index];
      return event.position !== other.position || event.beat !== other.beat || event.durationBeats !== other.durationBeats || event.midi.join(',') !== other.midi.join(',');
    })) return document;
    cursors = expected.map(event => event.cursor!);
  } else if (document.kind === 'musicxml') {
    const pages = document.pages.map((page, index) => legacyMusicXmlRows(page, index, document.pages.length));
    if (pages.some(page => !page)) return document;
    cursors = [];
    for (const event of reference.events) {
      const page = Math.floor(event.position), withinPage = (event.position - page) * 4;
      const row = Math.floor(withinPage), fraction = withinPage - row;
      const xs = pages[page]?.[row];
      if (!xs) return document;
      // The old reading position adds <= .01 beats, divided by max(duration, 1).
      // Recover an actual drawn onset, and refuse dense/ambiguous candidates.
      const biasedX = 112 + 720 * fraction;
      const matches = xs.filter(x => x <= biasedX + 1e-7 && x >= biasedX - 7.2 - 1e-7);
      if (matches.length !== 1) return document;
      cursors.push({ x: matches[0] / 920, y: (128 + row * 112) / 620, height: 70 / 620, system: row });
    }
  } else return document;
  return { ...document, reference: { ...reference, events: reference.events.map((event, index) => ({ ...event, cursor: event.cursor ?? cursors[index] })) } };
}
