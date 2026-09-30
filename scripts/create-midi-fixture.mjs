import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import midiPackage from '@tonejs/midi';

const { Midi } = midiPackage;
const fixture = name => new URL(`../tests/fixtures/${name}`, import.meta.url);
const xml = await readFile(fixture('guitar-study.musicxml'), 'utf8');
const title = xml.match(/<work-title>(.*?)<\/work-title>/s)?.[1];
assert.equal(title, '溪边练习');

// This fixture intentionally accepts only the existing simple, linear XML.
// Pitches come from written pitch elements, independently of the app importer.
assert.doesNotMatch(xml, /<(?:rest|chord|backup|forward|grace|tie|repeat)\b/);
const pitchClasses = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const notes = [];
let divisions = 1;
let page = 0;
for (const [measureIndex, match] of [...xml.matchAll(/<measure\b[^>]*>(.*?)<\/measure>/gs)].entries()) {
  const measure = match[1];
  if (/<print\b[^>]*new-page/.test(measure)) page += 1;
  divisions = Number(measure.match(/<divisions>(.*?)<\/divisions>/)?.[1] ?? divisions);
  assert.ok(Number.isFinite(divisions) && divisions > 0);
  for (const [, source] of measure.matchAll(/<note\b[^>]*>(.*?)<\/note>/gs)) {
    const pitch = source.match(/<pitch>(.*?)<\/pitch>/s)?.[1];
    assert.ok(pitch, 'Every note must have a written pitch.');
    const step = pitch.match(/<step>(.*?)<\/step>/)?.[1];
    const octave = Number(pitch.match(/<octave>(.*?)<\/octave>/)?.[1]);
    const alter = Number(pitch.match(/<alter>(.*?)<\/alter>/)?.[1] ?? 0);
    const midi = (octave + 1) * 12 + pitchClasses[step] + alter;
    const beats = Number(source.match(/<duration>(.*?)<\/duration>/)?.[1]) / divisions;
    assert.ok(Number.isInteger(midi) && midi >= 0 && midi <= 126);
    assert.ok(beats > 0 && Number.isFinite(beats));
    notes.push({ midi, beats, page, measure: measureIndex });
  }
}
assert.equal(notes.length, 96);
assert.equal(page + 1, 3);
assert.deepEqual([0, 1, 2].map(index => notes.filter(note => note.page === index).length), [32, 32, 32]);

// midi-file writes one byte per character. Store proper UTF-8 meta-event bytes
// through its latin1 interface instead of truncating Chinese UTF-16 code units.
const midiText = text => Buffer.from(text, 'utf8').toString('latin1');
const decodedText = text => Buffer.from(text, 'latin1').toString('utf8');
const midi = new Midi();
midi.name = midiText(title);
const ppq = midi.header.ppq;
assert.equal(ppq, 480);
const track = midi.addTrack();
track.name = midiText('溪边练习 · 原声吉他');
track.channel = 0;
track.instrument.number = 24; // GM acoustic guitar (nylon), zero-based.
midi.header.timeSignatures = [{ ticks: 0, timeSignature: [4, 4] }];
midi.header.tempos = [{ ticks: 0, bpm: 72 }];

let ticks = ppq; // One quarter-note lead-in of actual silence.
const expected = [];
for (const [index, note] of notes.entries()) {
  // Performance pauses preserve all written attacks and their order. The XML
  // is never changed; these gaps exercise alignment across silent passages.
  if (index === 32) ticks += 2 * ppq;
  if (index === 64) ticks += 1.5 * ppq;
  if (index === 32 || index === 64) {
    midi.header.tempos.push({ ticks, bpm: index === 32 ? 84 : 66 });
  }
  const durationTicks = Math.round(note.beats * ppq * .86);
  const velocityByte = [88, 71, 78, 74, 84, 69, 80, 76][index % 8];
  track.addNote({ midi: note.midi, ticks, durationTicks, velocity: velocityByte / 127 });
  expected.push({ ...note, ticks, durationTicks });
  ticks += Math.round(note.beats * ppq);
}
midi.header.update();

// Calculate seconds independently from the serialized MIDI tempo values.
// Tempo meta-events store integer microseconds per quarter note.
const secondsAt = target => {
  let seconds = 0;
  const tempos = midi.header.tempos;
  for (let index = 0; index < tempos.length; index += 1) {
    const start = tempos[index].ticks;
    const end = Math.min(target, tempos[index + 1]?.ticks ?? target);
    if (end > start) seconds += (end - start) / ppq * Math.floor(60_000_000 / tempos[index].bpm) / 1_000_000;
    if (end === target) break;
  }
  return seconds;
};

function validate(bytes, transposition = 0) {
  const buffer = Buffer.from(bytes);
  assert.equal(buffer.toString('ascii', 0, 4), 'MThd');
  assert.equal(buffer.readUInt32BE(4), 6);
  assert.equal(buffer.readUInt16BE(8), 1);
  assert.equal(buffer.readUInt16BE(10), 2); // Conductor + guitar.
  assert.equal(buffer.readUInt16BE(12), ppq);
  const parsed = new Midi(bytes);
  assert.ok(decodedText(parsed.name).startsWith(title));
  assert.equal(parsed.tracks.length, 1);
  assert.equal(parsed.tracks[0].instrument.number, 24);
  assert.equal(parsed.tracks[0].channel, 0);
  assert.equal(parsed.tracks[0].pitchBends.length, 0);
  assert.deepEqual(Object.keys(parsed.tracks[0].controlChanges), []);
  assert.equal(parsed.header.tempos.length, 3);
  for (const [index, tempo] of parsed.header.tempos.entries()) {
    assert.equal(tempo.ticks, midi.header.tempos[index].ticks);
    assert.ok(Math.abs(tempo.bpm - midi.header.tempos[index].bpm) < .0002);
  }
  const actual = parsed.tracks[0].notes;
  assert.equal(actual.length, 96);
  assert.ok(new Set(actual.map(note => note.velocity)).size > 4);
  for (const [index, note] of actual.entries()) {
    assert.equal(note.midi, expected[index].midi + transposition);
    assert.equal(note.ticks, expected[index].ticks);
    assert.equal(note.durationTicks, expected[index].durationTicks);
    assert.ok(Math.abs(note.time - secondsAt(expected[index].ticks)) < 1e-8);
    const duration = secondsAt(note.ticks + note.durationTicks) - secondsAt(note.ticks);
    assert.ok(Math.abs(note.duration - duration) < 1e-8);
  }
  assert.ok(actual[0].time > .8);
  assert.ok(actual[32].time - actual[31].time - actual[31].duration > 1.5);
  assert.ok(actual[64].time - actual[63].time - actual[63].duration > 1);
  return parsed;
}

const validBytes = midi.toArray();
const parsed = validate(validBytes);
const wrong = midi.clone();
wrong.name = midiText(`${title}（不匹配）`);
wrong.tracks[0].notes.forEach(note => { note.midi += 1; });
const wrongBytes = wrong.toArray();
validate(wrongBytes, 1);
const invalidBytes = Buffer.from(validBytes);
invalidBytes.write('BAD!', 0, 'ascii'); // A corrupt header, rejected deterministically.
assert.throws(() => new Midi(invalidBytes));

await writeFile(fixture('guitar-study.mid'), validBytes);
await writeFile(fixture('guitar-study-wrong.mid'), wrongBytes);
await writeFile(fixture('guitar-study-invalid.mid'), invalidBytes);
console.log(JSON.stringify({
  title,
  notes: notes.length,
  pages: page + 1,
  instrument: parsed.tracks[0].instrument.name,
  ppq,
  duration: Number(parsed.duration.toFixed(6)),
  tempos: parsed.header.tempos.map(tempo => ({ ticks: tempo.ticks, bpm: Number(tempo.bpm.toFixed(3)), time: Number(tempo.time.toFixed(6)) })),
  pageStarts: [0, 32, 64].map(index => Number(parsed.tracks[0].notes[index].time.toFixed(6))),
  files: ['guitar-study.mid', 'guitar-study-invalid.mid', 'guitar-study-wrong.mid'],
}, null, 2));
