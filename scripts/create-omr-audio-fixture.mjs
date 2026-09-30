import { readFile, writeFile } from 'node:fs/promises';
// Notes manually transcribed from the public score image, independent of the OMR output.
const expected = JSON.parse(await readFile(new URL('../server/fixtures/cucaracha-expected.json', import.meta.url), 'utf8'));
const rate = 22050, beatSeconds = 60 / expected.tempo;
const pageSeconds = expected.durationBeats * beatSeconds;
const samples = new Float32Array(Math.ceil((1.6 + 2 * pageSeconds) * rate));
for (let page = 0; page < 2; page++) {
  for (const note of expected.notes) {
    const onset = .6 + page * pageSeconds + note.beat * beatSeconds;
    const duration = note.durationBeats * beatSeconds;
    for (const midi of note.midi) {
      const f = 440 * 2 ** ((midi - 69) / 12);
      for (let i = 0; i < Math.floor(duration * .94 * rate); i++) {
        const t = i / rate;
        const envelope = Math.min(1, t / .007) * Math.exp(-3 * t / duration);
        samples[Math.floor(onset * rate) + i] += .13 * envelope * (Math.sin(2 * Math.PI * f * t) + .18 * Math.sin(4 * Math.PI * f * t));
      }
    }
  }
}
const wav = Buffer.alloc(44 + samples.length * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(samples.length * 2, 40);
samples.forEach((v, i) => wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
await writeFile(new URL('../tests/fixtures/cucaracha-two-pages.wav', import.meta.url), wav);
console.log(`Independent two-page audio: page 2 starts at ${(.6 + pageSeconds).toFixed(3)}s.`);
