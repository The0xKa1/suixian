import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMidi, renderMidiWav } from './midi.ts';
import type { MidiPerformance } from './midi.ts';

const u16 = (value: number) => [value >> 8 & 255, value & 255];
const u32 = (value: number) => [value >>> 24, value >>> 16 & 255, value >>> 8 & 255, value & 255];
const ascii = (text: string) => [...text].map(c => c.charCodeAt(0));
function vlq(value: number): number[] {
  const bytes = [value & 127];
  while (value = Math.floor(value / 128)) bytes.unshift((value & 127) | 128);
  return bytes;
}
const event = (delta: number, ...bytes: number[]) => [...vlq(delta), ...bytes];
const eot = (delta = 0) => event(delta, 0xff, 0x2f, 0);
const tempo = (delta: number, micros: number) => event(delta, 0xff, 0x51, 3, micros >> 16 & 255, micros >> 8 & 255, micros & 255);
function smf(tracks: number[][], format = tracks.length === 1 ? 0 : 1, ppq = 480): ArrayBuffer {
  return Uint8Array.from([
    ...ascii('MThd'), ...u32(6), ...u16(format), ...u16(tracks.length), ...u16(ppq),
    ...tracks.flatMap(track => [...ascii('MTrk'), ...u32(track.length), ...track]),
  ]).buffer;
}
const simple = () => smf([[...event(0, 0x90, 60, 100), ...event(480, 0x80, 60, 64), ...eot()]]);
const close = (actual: number, expected: number, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test('SMF1 preserves chords, independent tracks, velocities and tempo changes in seconds', async () => {
  const performance = await parseMidi(smf([
    [...tempo(0, 500000), ...tempo(480, 1000000), ...eot(480)],
    [...event(0, 0x90, 60, 100), ...event(0, 0x90, 64, 64), ...event(480, 0x80, 60, 0), ...event(0, 0x80, 64, 0), ...event(0, 0x90, 67, 127), ...event(480, 0x80, 67, 0), ...eot()],
    [...event(240, 0x91, 55, 32), ...event(480, 0x81, 55, 0), ...eot(240)],
  ]));
  assert.equal(performance.notes.length, 4);
  const [c, e, gLow, g] = performance.notes;
  close(c.time, 0); close(c.duration, .5); close(c.velocity, 100 / 127);
  close(e.time, 0); close(e.duration, .5); close(e.velocity, 64 / 127);
  close(gLow.time, .25); close(gLow.duration, .75); close(gLow.velocity, 32 / 127);
  close(g.time, .5); close(g.duration, 1); close(g.velocity, 1);
  assert.equal(c.track, e.track); assert.notEqual(c.track, gLow.track);
  close(performance.duration, 1.5);
});

test('late first tempo keeps default 120 BPM before the tempo event and preserves EOT', async () => {
  const performance = await parseMidi(smf([
    [...tempo(480, 1000000), ...eot(960)],
    [...event(240, 0x90, 60, 127), ...event(720, 0x80, 60, 0), ...eot()],
  ]));
  close(performance.notes[0].time, .25);
  close(performance.notes[0].duration, 1.25);
  close(performance.duration, 2.5);
});

test('SMF0 handles running status and velocity-zero note-off without a second onset', async () => {
  const performance = await parseMidi(smf([[
    ...event(480, 0x90, 60, 127), ...event(480, 60, 0), ...eot(960),
  ]]));
  assert.equal(performance.notes.length, 1);
  close(performance.notes[0].time, .5); close(performance.notes[0].duration, .5);
  close(performance.duration, 2);
});

test('percussion is excluded without truncating file time; all-drum and empty files reject', async () => {
  const melody = [...event(0, 0x90, 60, 100), ...event(480, 0x80, 60, 0), ...eot()];
  const drums = [...event(0, 0x99, 36, 127), ...event(480, 0x89, 36, 0), ...eot(480)];
  const performance = await parseMidi(smf([melody, drums]));
  assert.equal(performance.notes.length, 1); assert.equal(performance.notes[0].midi, 60);
  close(performance.duration, 1);
  await assert.rejects(parseMidi(smf([drums])), /没有可用的旋律音符/);
  await assert.rejects(parseMidi(smf([eot()])), /没有可用的旋律音符/);
  await assert.rejects(parseMidi(new ArrayBuffer(0)), /为空/);
});

test('SMF2, SMPTE, pitch bend, sustain and unsupported performance controls reject explicitly', async () => {
  const notes = [...event(0, 0x90, 60, 100), ...event(480, 0x80, 60, 0), ...eot()];
  await assert.rejects(parseMidi(smf([notes], 2)), /SMF 2/);
  await assert.rejects(parseMidi(smf([notes], 0, 0xe728)), /SMPTE/);
  for (const [control, message] of [
    [[0xe0, 1, 64], /弯音/], [[0xb0, 64, 127], /延音踏板/],
    [[0xb0, 11, 0], /音量或表情/], [[0xb0, 6, 0], /参数或调音/],
    [[0xd0, 100], /触后/], [[0xf0, 1, 0xf7], /SysEx/],
  ] as const) await assert.rejects(parseMidi(smf([[...event(0, ...control), ...notes]])), message);
  const neutral = await parseMidi(smf([[
    ...event(0, 0xe0, 0, 64), ...event(0, 0xb0, 64, 0), ...event(0, 0xc0, 24), ...notes,
  ]]));
  assert.equal(neutral.notes.length, 1);
});

test('invalid chunks, variable lengths, data bytes and unterminated notes fail before library parsing', async () => {
  const truncated = simple().slice(0, -1);
  const wrongLength = simple(); new DataView(wrongLength).setUint32(18, 0xffffffff);
  const cases = [
    Uint8Array.from([1, 2, 3]).buffer, truncated, wrongLength,
    smf([[0x81, 0x80, 0x80, 0x80, 0x00, 0xff, 0x2f, 0]]),
    smf([[...event(0, 60, 100), ...eot()]]),
    smf([[...event(0, 0x90, 60, 255), ...eot()]]),
    smf([[...event(0, 0x90, 60, 100), ...eot(480)]]),
    smf([[...event(0, 0x90, 60, 100), ...event(480, 0x80, 60, 0)]]),
    smf([[...event(0, 0xff, 0x51, 3, 0, 0, 0), ...eot()]]),
    smf([[...eot(), ...eot()]]),
  ];
  for (const data of cases) await assert.rejects(parseMidi(data), /损坏或不完整/);
});

test('size, duration, overlapping pitches and synthesis work budgets are bounded', async () => {
  await assert.rejects(parseMidi(new ArrayBuffer(5 * 1024 * 1024 + 1)), /5 MB/);
  await assert.rejects(parseMidi(smf([[
    ...event(0, 0x90, 60, 100), ...event(480 * 961, 0x80, 60, 0), ...eot(),
  ]])), /8 分钟/);
  await assert.rejects(parseMidi(smf([[
    ...event(0, 0x90, 60, 100), ...event(1, 0x90, 60, 90), ...eot(),
  ]])), /同音高重叠/);
  const dense: MidiPerformance = { duration: 480, notes: Array.from({ length: 6 }, (_, i) => ({ midi: 60 + i, time: 0, duration: 480, velocity: 1, track: i })) };
  await assert.rejects(renderMidiWav(dense), /复音量过大/);
  await assert.rejects(renderMidiWav({ ...dense, notes: Array(10001).fill(dense.notes[0]) }), /10000/);
});

test('MIDI parsing and synthesis honour already-aborted and in-flight cancellation', async () => {
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(parseMidi(simple(), cancelled.signal), { name: 'AbortError' });
  const performance: MidiPerformance = { duration: 4, notes: Array.from({ length: 4 }, (_, i) => ({ midi: 60 + i, time: 0, duration: 3, velocity: .5, track: i })) };
  await assert.rejects(renderMidiWav(performance, cancelled.signal), { name: 'AbortError' });
  const parsing = new AbortController();
  const events = Array.from({ length: 1000 }, () => [...event(0, 0x90, 60, 100), ...event(1, 0x80, 60, 0)]).flat();
  const pending = parseMidi(smf([[...events, ...eot()]]), parsing.signal);
  setTimeout(() => parsing.abort(), 0);
  await assert.rejects(pending, { name: 'AbortError' });
  const rendering = new AbortController();
  await assert.rejects(renderMidiWav(performance, rendering.signal, message => {
    if (message.endsWith('25%')) rendering.abort();
  }), { name: 'AbortError' });
});

async function readWav(performance: MidiPerformance) {
  const blob = await renderMidiWav(performance);
  assert.equal(blob.type, 'audio/wav');
  const buffer = await blob.arrayBuffer(), view = new DataView(buffer);
  assert.equal(new TextDecoder().decode(buffer.slice(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(buffer.slice(8, 12)), 'WAVE');
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), buffer.byteLength - 44);
  const rate = view.getUint32(24, true);
  const pcm = Array.from({ length: (buffer.byteLength - 44) / 2 }, (_, i) => view.getInt16(44 + i * 2, true) / 32767);
  return { pcm, rate };
}

test('WAV retains intro/end silence and duration, stays audible and avoids clipping/clicks', async () => {
  const performance: MidiPerformance = { duration: 2, notes: [{ midi: 69, time: .5, duration: .5, velocity: .7, track: 0 }] };
  const { pcm, rate } = await readWav(performance);
  close(pcm.length / rate, performance.duration, 1 / rate);
  assert.ok(pcm.slice(0, rate / 2).every(sample => sample === 0));
  assert.ok(pcm.slice(rate).every(sample => sample === 0));
  const peak = pcm.reduce((value, sample) => Math.max(value, Math.abs(sample)), 0);
  assert.ok(peak > .87 && peak < .881);
  assert.equal(pcm[rate / 2], 0);
  assert.ok(Math.abs(pcm[rate - 1]) < .0001);
});

test('one global gain preserves relative note velocity', async () => {
  const { pcm, rate } = await readWav({ duration: 1, notes: [
    { midi: 60, time: .1, duration: .2, velocity: 1, track: 0 },
    { midi: 60, time: .5, duration: .2, velocity: .25, track: 0 },
  ] });
  const power = (start: number) => pcm.slice(Math.round(start * rate), Math.round((start + .2) * rate)).reduce((sum, sample) => sum + sample ** 2, 0);
  close(Math.sqrt(power(.5) / power(.1)), .25, .0001);
});

test('the highest MIDI pitch stays below Nyquist and is not folded into an audible alias', async () => {
  const { pcm, rate } = await readWav({ duration: .2, notes: [{ midi: 127, time: 0, duration: .2, velocity: 1, track: 0 }] });
  const frequency = 440 * 2 ** ((127 - 69) / 12);
  assert.ok(rate / 2 > frequency);
  const energy = (hz: number) => {
    let real = 0, imag = 0;
    for (let i = Math.floor(rate * .02); i < Math.floor(rate * .18); i++) {
      real += pcm[i] * Math.cos(2 * Math.PI * hz * i / rate);
      imag += pcm[i] * Math.sin(2 * Math.PI * hz * i / rate);
    }
    return real * real + imag * imag;
  };
  assert.ok(energy(frequency) > 1000 * energy(22050 - frequency));
});
