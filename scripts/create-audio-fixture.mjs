import { readFile, writeFile } from 'node:fs/promises';

// Controlled recording for integration tests, synthesized from the fixture's written pitches.
const xml = await readFile(new URL('../tests/fixtures/guitar-study.musicxml', import.meta.url), 'utf8');
const pitchClass = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const notes = [...xml.matchAll(/<note>(.*?)<\/note>/gs)].map(match => {
  const step = match[1].match(/<step>(.*?)<\/step>/)[1];
  const octave = Number(match[1].match(/<octave>(.*?)<\/octave>/)[1]);
  const alter = Number(match[1].match(/<alter>(.*?)<\/alter>/)?.[1] ?? 0);
  return (octave + 1) * 12 + pitchClass[step] + alter;
});
const sampleRate = 22050;
let cursor = 0.8;
const events = notes.map((midi, index) => {
  const seconds = 0.34 + 0.055 * Math.sin(index / 7);
  const event = { midi, time: cursor, duration: seconds, page: Math.floor(index / 32) + 1 };
  cursor += seconds;
  return event;
});
const samples = new Float32Array(Math.ceil((cursor + 1.2) * sampleRate));
for (const { midi, time, duration } of events) {
  const frequency = 440 * 2 ** ((midi - 69) / 12);
  for (let i = 0; i < Math.floor(duration * 1.2 * sampleRate); i++) {
    const t = i / sampleRate;
    const envelope = Math.min(1, t / 0.007) * Math.exp(-t / (duration * 0.45));
    const wave = Math.sin(2 * Math.PI * frequency * t) + 0.22 * Math.sin(4 * Math.PI * frequency * t) + 0.07 * Math.sin(6 * Math.PI * frequency * t);
    samples[Math.floor(time * sampleRate) + i] += 0.45 * envelope * wave;
  }
}
const wav = Buffer.alloc(44 + samples.length * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples.length * 2, 40);
samples.forEach((value, index) => wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + index * 2));
await writeFile(new URL('../tests/fixtures/guitar-study.wav', import.meta.url), wav);
await writeFile(new URL('../tests/fixtures/guitar-study-timing.json', import.meta.url), JSON.stringify({ sampleRate, events }, null, 2));
console.log(`Created ${notes.length}-note synthetic WAV (${(samples.length / sampleRate).toFixed(1)} s), with tempo changes and lead/tail silence.`);
