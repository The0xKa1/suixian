import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { audioSourceFile, importAudio } from './import-audio.ts';
import { isMidiFile, isPlaybackFile } from './media-file.ts';
import { audioPositionAtTime, audioTimeAtPosition } from './audio-alignment.ts';
import type { ScoreReference } from './score-following/types.ts';

const fixtures = new URL('../../tests/fixtures/', import.meta.url);
const xml = await readFile(new URL('guitar-study.musicxml', fixtures), 'utf8');
const pitches = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const reference: ScoreReference = { events: [...xml.matchAll(/<note>(.*?)<\/note>/gs)].map((match, i) => {
  const step = match[1].match(/<step>(.*?)<\/step>/)![1] as keyof typeof pitches;
  const octave = Number(match[1].match(/<octave>(.*?)<\/octave>/)![1]);
  const alter = Number(match[1].match(/<alter>(.*?)<\/alter>/)?.[1] ?? 0);
  return { midi: [(octave + 1) * 12 + pitches[step] + alter], beat: i / 2, durationBeats: .5, position: (i + .2) / 32 };
}) };
const midiFile = async (name: string, type = 'audio/midi') => new File([await readFile(new URL(name, fixtures))], name, { type });

test('MIDI file classification covers extensions, MIDI MIME and mixed score selections', () => {
  for (const file of [{ name: 'PIECE.MID', type: '' }, { name: 'piece.midi', type: 'application/octet-stream' }, { name: 'piece', type: 'application/x-midi' }]) {
    assert.equal(isMidiFile(file), true);
    assert.equal(isPlaybackFile(file), true);
  }
  assert.equal(isMidiFile({ name: 'piece.wav', type: 'audio/wav' }), false);
  assert.equal(isPlaybackFile({ name: 'piece.musicxml', type: 'application/xml' }), false);
  assert.equal(isPlaybackFile({ name: 'piece.pdf', type: 'application/pdf' }), false);
});

test('real MIDI import preserves original, renders a playable WAV and maps all three pages by note times', async () => {
  const file = await midiFile('guitar-study.mid', 'application/octet-stream');
  const result = await importAudio(file, reference, 3);
  assert.equal(result.kind, 'midi');
  assert.equal(result.originalBlob, file);
  assert.equal(result.blob.type, 'audio/wav');
  assert.equal(result.alignment.method, 'midi-notes');
  assert.equal(result.alignment.coverage, 1);
  assert.ok(result.duration > 40 && result.duration < 45);
  const wav = new DataView(await result.blob.arrayBuffer());
  assert.equal(wav.getUint32(0), 0x52494646);
  assert.equal(wav.getUint32(8), 0x57415645);
  const duration = wav.getUint32(40, true) / wav.getUint32(28, true);
  assert.ok(Math.abs(duration - result.duration) < 1 / 22050);
  let peak = 0;
  for (let i = 44; i + 1 < wav.byteLength; i += 2) peak = Math.max(peak, Math.abs(wav.getInt16(i, true)));
  assert.ok(peak > 1000, 'playable waveform is audible');
  assert.ok(peak <= 32767, 'PCM does not overflow');
  for (const [page, time] of [[1, 15.833327], [2, 28.333315]]) {
    const boundary = audioTimeAtPosition(result.alignment, page, result.duration, 3);
    assert.ok(Math.abs(boundary - time) < .00001);
    assert.ok(audioPositionAtTime(result.alignment, boundary - .001, result.duration, 3) < page);
    assert.ok(audioPositionAtTime(result.alignment, boundary, result.duration, 3) >= page);
  }
  const saved = structuredClone(result);
  assert.deepEqual(await saved.originalBlob!.arrayBuffer(), await file.arrayBuffer());
  assert.deepEqual(saved.alignment, result.alignment);
  const original = audioSourceFile(saved);
  assert.equal(original.type, 'audio/midi');
  assert.deepEqual(await original.arrayBuffer(), await file.arrayBuffer());
  assert.throws(() => audioSourceFile({ ...saved, originalBlob: undefined }), /原文件缺失/);
  const rematched = await importAudio(original, reference, 3);
  assert.deepEqual(rematched.alignment, result.alignment, 're-recognition reuses actual MIDI note times');
});

test('MIDI importer rejects corrupt, wrong-song and oversized MIDI and observes cancellation', async () => {
  await assert.rejects(importAudio(await midiFile('guitar-study-invalid.mid'), reference, 3), /MIDI|格式|文件/);
  await assert.rejects(importAudio(await midiFile('guitar-study-wrong.mid'), reference, 3), /匹配|MIDI|音符/);
  await assert.rejects(importAudio(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.mid'), reference, 3), /5 MB/);
  const controller = new AbortController();
  const file = await midiFile('guitar-study.mid');
  await assert.rejects(importAudio(file, reference, 3, message => {
    if (message === '合成 MIDI 音频…') controller.abort();
  }, controller.signal), { name: 'AbortError' });
});
