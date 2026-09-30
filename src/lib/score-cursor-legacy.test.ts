import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoScore } from './demo-score.ts';
import { hydrateRenderedCursors } from './score-cursor-legacy.ts';
import type { ScoreDocument, ScorePage } from '../types.ts';

function musicXmlPage(xs: number[][]): ScorePage {
  const systems = xs.map((onsets, row) => {
    const y = 138 + row * 112;
    const lines = Array.from({ length: 6 }, (_, string) => `<path d="M80 ${y + string * 10}H868"/>`).join('');
    const ticks = onsets.map(x => `<path d="M${x} ${y + 64}v10"/>`).join('');
    const notes = onsets.map(x => `<rect x="${x - 9}" y="${y - 8}" width="18" height="16" fill="#f9f7f3"/><text x="${x}" y="${y + 5}" text-anchor="middle" font-family="monospace" font-size="15">0</text>`).join('');
    return `<text x="58" y="${y - 16}" font-size="11" fill="#777">${row + 1}</text><text x="60" y="${y + 13}" font-size="12">T<tspan x="60" dy="15">A</tspan><tspan x="60" dy="15">B</tspan></text><g stroke="#8b8a81" stroke-width=".65" fill="none">${lines}<path d="M80 ${y}v50M868 ${y}v50"/>${ticks}</g>${notes}`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="920" height="620" viewBox="0 0 920 620"><rect width="920" height="620" fill="#f9f7f3"/><g fill="#282b28" font-family="serif"><text x="460" y="52" text-anchor="middle" font-size="26">Test</text><text x="58" y="88" font-size="11">GUITAR / TAB</text>${systems}<text x="862" y="591" text-anchor="end" font-size="12">1 / 1</text></g></svg>`;
  return { id: 'musicxml-1', width: 920, height: 620, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
}

test('demo cursor geometry matches actual rendered onsets on every page and staff', () => {
  const document = createDemoScore();
  for (const event of document.reference!.events) {
    const cursor = event.cursor!;
    const svg = decodeURIComponent(document.pages[Math.floor(event.position)].src.split(',')[1]);
    const x = cursor.x * 920;
    const staffTop = cursor.y * 620 + 10;
    const lines = [...svg.matchAll(/<line x1="([^"]+)" x2="([^"]+)" y1="([^"]+)" y2="([^"]+)"\/>/g)];
    assert.ok(lines.some(([, x1, x2, y1, y2]) =>
      Math.abs(Number(x1) - x) < 1e-7 && Math.abs(Number(x2) - x) < 1e-7
      && Math.abs(Number(y1) - staffTop - 62) < 1e-7 && Math.abs(Number(y2) - staffTop - 72) < 1e-7));
    assert.ok(Math.abs(cursor.height * 620 - 70) < 1e-7);
    assert.ok(cursor.system >= 0 && cursor.system < 4);
  }
});

test('saved demo migration preserves IDs, audio identity and event timing', () => {
  const source = createDemoScore();
  const document = { ...source, id: 'kept', audio: { marker: true }, reference: { ...source.reference!, events: source.reference!.events.map(({ cursor: _, ...event }) => event) } };
  const migrated = hydrateRenderedCursors(document as typeof document & ScoreDocument);
  assert.notEqual(migrated, document);
  assert.equal(migrated.id, 'kept');
  assert.equal(migrated.audio, document.audio);
  assert.deepEqual(migrated.reference!.events, source.reference!.events);
  assert.equal(document.reference.events[0].cursor, undefined);
  assert.equal(hydrateRenderedCursors(source), source);
});

test('legacy MusicXML matches drawn note ticks rather than biased reading fractions', () => {
  const document: ScoreDocument = {
    name: 'Test', kind: 'musicxml', pages: [musicXmlPage([[112, 202, 472], [112, 652]])],
    reference: { events: [
      { midi: [64], beat: 0, durationBeats: .5, position: .01 / 4 / 4 },
      { midi: [64], beat: 2, durationBeats: .5, position: 2.01 / 4 / 4 },
      { midi: [64], beat: 7, durationBeats: 1, position: (1 + 3.01 / 4) / 4 },
    ] },
  };
  const migrated = hydrateRenderedCursors(document);
  assert.deepEqual(migrated.reference!.events.map(event => event.cursor), [
    { x: 112 / 920, y: 128 / 620, height: 70 / 620, system: 0 },
    { x: 472 / 920, y: 128 / 620, height: 70 / 620, system: 0 },
    { x: 652 / 920, y: 240 / 620, height: 70 / 620, system: 1 },
  ]);
  assert.equal(migrated.pages, document.pages);
  assert.equal(migrated.reference!.events[1].position, document.reference!.events[1].position);
});

test('migration refuses images, modified geometry and unmatched demo references', () => {
  const source = createDemoScore();
  const missing = { ...source, reference: { ...source.reference!, events: source.reference!.events.map(({ cursor: _, ...event }) => event) } };
  const wrongKind = { ...missing, kind: 'image' as const };
  assert.equal(hydrateRenderedCursors(wrongKind), wrongKind);
  const wrongSize = { ...missing, pages: source.pages.map(page => ({ ...page, width: 1000 })) };
  assert.equal(hydrateRenderedCursors(wrongSize), wrongSize);
  const wrongEvent = { ...missing, reference: { events: [{ ...missing.reference.events[0], beat: 99 }] } };
  assert.equal(hydrateRenderedCursors(wrongEvent), wrongEvent);
  const changedPage = musicXmlPage([[112]]);
  changedPage.src = changedPage.src.replace(encodeURIComponent('<g fill="#282b28"'), encodeURIComponent('<g transform="translate(0 10)" fill="#282b28"'));
  const changed: ScoreDocument = { name: 'Altered', kind: 'musicxml', pages: [changedPage], reference: { events: [{ midi: [64], beat: 0, durationBeats: 1, position: .01 / 4 / 4 }] } };
  assert.equal(hydrateRenderedCursors(changed), changed);
});

test('legacy dense onsets and unknown SVG layout are left without guessed cursors', () => {
  const document: ScoreDocument = { name: 'Dense', kind: 'musicxml', pages: [musicXmlPage([[112, 113]])], reference: { events: [{ midi: [64], beat: 0, durationBeats: 1, position: .01 / 4 / 4 }] } };
  assert.equal(hydrateRenderedCursors(document), document);
  const unknown = { ...document, pages: [{ ...document.pages[0], src: 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E' }] };
  assert.equal(hydrateRenderedCursors(unknown), unknown);
});
