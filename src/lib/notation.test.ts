import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { createNotation, notationRenderDocument } from './notation.ts';
import { mapNotationReference } from './notation-layout.ts';
import type { NotationEventLocation } from './notation-layout.ts';
import type { ScoreReference } from './score-following/types.ts';

Object.assign(globalThis, { DOMParser, XMLSerializer });
const note = (step: string, extra = '', duration = 1) => `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>${duration}</duration>${extra}</note>`;
const xml = (measures: string) => `<score-partwise version="4.0"><work><work-title>Title stays in source</work-title></work><part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list><part id="P1">${measures}</part></score-partwise>`;
const source = (content: string) => ({ id: 'source-1', xml: content, originalPage: 0, startBeat: 0, durationBeats: 8 });

test('canonical score preserves complete XML, rests, notation and stable note / measure anchors', () => {
  const content = xml(`<measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><direction><direction-type><words>dolce</words></direction-type></direction>${note('C', '<notations><technical><string>2</string><fret>1</fret></technical><slur type="start"/></notations><lyric><text>la</text></lyric>')}<note><rest/><duration>3</duration></note></measure>`);
  const parsed = createNotation([source(content)]);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.notes.length, 2);
  assert.equal(parsed.notes[0].midi, 60);
  assert.equal(parsed.notes[0].fret, 1);
  assert.equal(parsed.notes[1].rest, true);
  assert.equal(parsed.notes[1].durationBeats, 3);
  assert.match(parsed.sources[0].xml, /dolce/);
  assert.match(parsed.sources[0].xml, /<slur type="start"/);
  assert.match(parsed.sources[0].xml, /<lyric>/);
  assert.match(parsed.sources[0].xml, /Title stays in source/);
  const again = createNotation(parsed.sources);
  assert.deepEqual(again.measures, parsed.measures);
  assert.deepEqual(again.notes, parsed.notes);
  assert.deepEqual(parsed.measures[0].noteIds, parsed.notes.map(item => item.id));
});

test('backup, chords and pickup lengths use musical time without losing voice or tie semantics', () => {
  const content = xml(`<measure number="0" implicit="yes"><attributes><divisions>1</divisions></attributes>${note('C', '<voice>1</voice><tie type="start"/>')}${note('E', '<chord/><voice>1</voice>')}<backup><duration>1</duration></backup>${note('G', '<voice>2</voice><staff>2</staff>')}</measure><measure number="1">${note('C', '<voice>1</voice><tie type="stop"/>', 4)}</measure>`);
  const parsed = createNotation([source(content)]);
  assert.deepEqual(parsed.notes.map(item => item.beat), [0, 0, 0, 1]);
  assert.deepEqual(parsed.measures.map(item => item.durationBeats), [1, 4]);
  assert.equal(parsed.notes[0].tieStart, true);
  assert.equal(parsed.notes[3].tieStop, true);
  assert.equal(parsed.notes[2].voice, '2');
  assert.equal(parsed.notes[2].staff, '2');
});

test('source namespaces and beat offsets distinguish repeated page XML', () => {
  const content = xml(`<measure number="1">${note('C', '', 4)}</measure>`);
  const parsed = createNotation([source(content), { ...source(content), id: 'source-2', originalPage: 1, startBeat: 8 }]);
  assert.equal(parsed.notes[1].beat, 8);
  assert.notEqual(parsed.notes[0].id, parsed.notes[1].id);
  assert.notEqual(parsed.measures[0].id, parsed.measures[1].id);
});

test('sound-only legacy direction gets an equivalent display tempo without changing the saved source', () => {
  const content = xml(`<measure number="1"><direction><sound tempo="72"/></direction>${note('C', '', 4)}</measure>`);
  const parsed = createNotation([source(content)]);
  const saved = parsed.sources[0].xml;
  const display = notationRenderDocument(saved);
  assert.equal(display.getElementsByTagName('per-minute')[0].textContent, '72');
  assert.equal(display.getElementsByTagName('beat-unit')[0].textContent, 'quarter');
  assert.equal(parsed.sources[0].xml, saved);
  assert.doesNotMatch(saved, /metronome/);
});

test('all parts share the longest measure duration', () => {
  const content = xml(`<measure number="1" implicit="yes">${note('C')}</measure><measure number="2">${note('D')}</measure>`)
    .replace('</score-partwise>', `<part id="P2"><measure number="1" implicit="yes">${note('E', '', 2)}</measure><measure number="2">${note('F')}</measure></part></score-partwise>`);
  const parsed = createNotation([source(content)]);
  assert.equal(parsed.measures[1].startBeat, 2);
  assert.equal(parsed.measures[3].startBeat, 2);
});

test('invalid identifiers, entity expansion and broken musical time are rejected', () => {
  const content = xml(`<measure number="1">${note('C')}</measure>`);
  assert.throws(() => createNotation([source(content), source(content)]), /无效/);
  assert.throws(() => createNotation([source('<!ENTITY x "bad">' + content)]), /无效/);
  assert.throws(() => createNotation([source(xml('<measure><attributes><divisions>0</divisions></attributes>' + note('C') + '</measure>'))]), /节拍/);
  assert.throws(() => createNotation([source(xml('<measure><backup><duration>2</duration></backup>' + note('C') + '</measure>'))]), /声部时间/);
  assert.throws(() => createNotation([source(xml('<measure id="same">' + note('C', ' id="x"') + '</measure><measure id="same">' + note('D') + '</measure>'))]), /重复/);
});

const location = (beat: number, page: number, midi = [60]): NotationEventLocation => ({ beat, page, midi, system: 0, x: 0.3, y: 0.1, height: 0.2 });
const reference: ScoreReference = { initialTempo: 72, events: [
  { midi: [60], beat: 0, durationBeats: 1, position: 0.1, id: 'keep-me', cursor: { x: 0.8, y: 0.5, height: 0.2, system: 2 } },
  { midi: [62], beat: 1, durationBeats: 1, position: 0.2 },
  { midi: [64], beat: 2, durationBeats: 1, position: 0.3 },
] };

test('reflow preserves event identity and musical values, rewrites page locations and leaves source untouched', () => {
  const mapped = mapNotationReference(reference, [location(0, 0), location(1, 0, [62]), location(2, 1, [64])], []);
  assert.deepEqual(mapped.events.map(item => item.id), ['keep-me', 'event-1', 'event-2']);
  assert.deepEqual(mapped.events.map(item => Math.floor(item.position)), [0, 0, 1]);
  assert.equal(mapped.events[0].cursor?.x, 0.3);
  assert.equal(reference.events[0].cursor?.x, 0.8);
  assert.deepEqual(mapped.events.map(({ midi, beat, durationBeats }) => ({ midi, beat, durationBeats })), reference.events.map(({ midi, beat, durationBeats }) => ({ midi, beat, durationBeats })));
  assert.equal(mapped.initialTempo, 72);
  assert.ok(mapped.events.every((item, index) => index === 0 || item.position > mapped.events[index - 1].position));
});

test('mismatching pitch loses the old cursor, but proven measure geometry still chooses the correct page', () => {
  const mapped = mapNotationReference({ events: [reference.events[0]] }, [location(0, 1, [61])], [{ startBeat: 0, durationBeats: 4, page: 1 }]);
  assert.equal(Math.floor(mapped.events[0].position), 1);
  assert.equal(mapped.events[0].cursor, undefined);
});

test('polyphonic onset requires all pitches and spans the corresponding staves', () => {
  const second = { ...location(0, 0, [64]), y: 0.4, height: 0.2 };
  const mapped = mapNotationReference({ events: [{ ...reference.events[0], midi: [60, 64] }] }, [location(0, 0), second], []);
  assert.equal(mapped.events[0].cursor?.y, 0.1);
  assert.ok(Math.abs(mapped.events[0].cursor!.height - 0.5) < 0.00001);
});

test('no matching measure or backward page order fails instead of inventing locations', () => {
  assert.throws(() => mapNotationReference(reference, [], []), /无法对应/);
  assert.throws(() => mapNotationReference(reference, [location(0, 1), location(1, 0, [62]), location(2, 1, [64])], []), /顺序/);
});

test('reflow uses one staff-group extent for short-long-short onsets and isolates page/system pairs', () => {
  const input: ScoreReference = { initialTempo: 96, events: [
    { id: 'upper', midi: [60], beat: 0, durationBeats: 1, position: .01 },
    { id: 'both', midi: [62, 50], beat: 1, durationBeats: 1, position: .2 },
    { id: 'lower', midi: [52], beat: 2, durationBeats: 1, position: .4 },
    { id: 'next-system', midi: [64], beat: 3, durationBeats: 1, position: .6 },
    { id: 'next-page', midi: [65], beat: 4, durationBeats: 1, position: 1.01 },
  ] };
  const locations: NotationEventLocation[] = [
    { ...location(0, 0), x: .1, y: .125, height: .125 },
    { ...location(1, 0, [62]), x: .4, y: .125, height: .125 },
    { ...location(1, 0, [50]), x: .42, y: .5, height: .125 },
    { ...location(2, 0, [52]), x: .7, y: .5, height: .125 },
    { ...location(3, 0, [64]), x: .2, y: .75, height: .125, system: 1 },
    { ...location(4, 1, [65]), x: .15, y: .25, height: .25 },
  ];
  const originalInput = structuredClone(input);
  const originalLocations = structuredClone(locations);
  const mapped = mapNotationReference(input, locations, []);
  assert.deepEqual(mapped.events.map(event => [Math.floor(event.position), event.cursor!.system, event.cursor!.y, event.cursor!.height]), [
    [0, 0, .125, .5], [0, 0, .125, .5], [0, 0, .125, .5],
    [0, 1, .75, .125], [1, 0, .25, .25],
  ]);
  assert.deepEqual(mapped.events.map(event => event.cursor!.x), [.1, .4, .7, .2, .15]);
  assert.deepEqual(mapped.events.map(({ id, midi, beat, durationBeats }) => ({ id, midi, beat, durationBeats })),
    input.events.map(({ id, midi, beat, durationBeats }) => ({ id, midi, beat, durationBeats })));
  assert.equal(mapped.initialTempo, input.initialTempo);
  assert.deepEqual(input, originalInput);
  assert.deepEqual(locations, originalLocations);
});

test('staff extent includes trustworthy engraving locations outside the selected reference onsets', () => {
  const mapped = mapNotationReference({ events: [reference.events[0]] }, [
    { ...location(0, 0), y: .125, height: .125 },
    { ...location(.5, 0, [72]), y: .5, height: .125 },
  ], []);
  assert.equal(mapped.events[0].cursor!.x, .3);
  assert.equal(mapped.events[0].cursor!.y, .125);
  assert.equal(mapped.events[0].cursor!.height, .5);
});

test('invalid engraving geometry cannot pollute the group or borrow a valid sibling cursor', () => {
  const measures = [{ startBeat: 0, durationBeats: 4, page: 0 }];
  for (const invalid of [
    { x: -0.1 }, { x: 1.1 }, { y: -.1 }, { y: .9, height: .2 }, { height: 0 }, { height: Infinity },
    { page: -.5 }, { page: .5 }, { system: -1 }, { system: .5 },
  ]) {
    const locations: NotationEventLocation[] = [
      { ...location(0, 0), y: .125, height: .125 },
      { ...location(1, 0, [62]), ...invalid },
      { ...location(2, 0, [64]), y: .5, height: .125 },
    ];
    const mapped = mapNotationReference(reference, locations, measures);
    assert.equal(mapped.events[1].cursor, undefined, `invalid event stays unmapped: ${JSON.stringify(invalid)}`);
    for (const index of [0, 2]) {
      assert.equal(mapped.events[index].cursor!.y, .125);
      assert.equal(mapped.events[index].cursor!.height, .5);
    }
  }
});

test('a missing onset or missing chord pitch stays unmapped despite a known staff-group extent', () => {
  const input: ScoreReference = { events: [
    { ...reference.events[0], midi: [60, 64] },
    { ...reference.events[1], midi: [64] },
    { ...reference.events[2], cursor: { x: .8, y: .2, height: .1, system: 0 } },
  ] };
  const mapped = mapNotationReference(input, [
    { ...location(0, 0), y: .125, height: .125 },
    { ...location(1, 0, [64]), y: .5, height: .125 },
  ], [{ startBeat: 0, durationBeats: 4, page: 0 }]);
  assert.equal(mapped.events[0].cursor, undefined, 'a pitch at another beat cannot complete the chord');
  assert.equal(mapped.events[2].cursor, undefined, 'an old cursor is not retained for a missing onset');
  assert.equal(mapped.events[1].cursor!.y, .125);
  assert.equal(mapped.events[1].cursor!.height, .5);
});
