import type { ScoreAudio } from '../types.ts';
import type { ScoreReference } from './score-following/types.ts';
import { parseMidi, renderMidiWav } from './midi.ts';
import { alignMidiToScore } from './midi-alignment.ts';

/** Use MIDI note times directly; render locally only for audible playback. */
export async function importMidi(
  file: File, reference: ScoreReference, pageCount: number,
  onProgress?: (message: string) => void, signal?: AbortSignal,
): Promise<ScoreAudio> {
  signal?.throwIfAborted();
  if (file.size > 5 * 1024 * 1024) throw new Error('MIDI 文件不能超过 5 MB。');
  onProgress?.('读取 MIDI…');
  const performance = await parseMidi(await file.arrayBuffer(), signal);
  signal?.throwIfAborted();
  onProgress?.('匹配 MIDI 与谱面…');
  const alignment = await alignMidiToScore(performance, reference, pageCount, signal);
  onProgress?.('合成 MIDI 音频…');
  const blob = await renderMidiWav(performance, signal, onProgress);
  signal?.throwIfAborted();
  onProgress?.('对齐完成');
  return { name: file.name, kind: 'midi', originalBlob: file, blob, duration: performance.duration, alignment };
}
