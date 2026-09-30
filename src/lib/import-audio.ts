import type { ScoreAudio } from '../types.ts';
import type { ScoreReference } from './score-following/types.ts';
import { alignPcmToScore, MAX_AUDIO_SECONDS } from './audio-alignment.ts';
import { bindAlignmentAnchors } from './notation-alignment.ts';
import { isMidiFile } from './media-file.ts';

export const MAX_AUDIO_BYTES = 60 * 1024 * 1024;

/** Re-alignment must use the uploaded MIDI, not its playable WAV rendering. */
export function audioSourceFile(audio: ScoreAudio): File {
  const source = audio.kind === 'midi' ? audio.originalBlob : audio.blob;
  if (!source) throw new Error('MIDI 原文件缺失，请重新添加 MIDI。');
  return new File([source], audio.name, { type: audio.kind === 'midi' ? 'audio/midi' : source.type });
}

async function checkDurationBeforeDecode(file: File, signal?: AbortSignal): Promise<void> {
  const url = URL.createObjectURL(file);
  const audio = new Audio();
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        audio.onloadedmetadata = null;
        audio.onerror = null;
      };
      const abort = () => { cleanup(); reject(signal?.reason ?? new DOMException('已取消', 'AbortError')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('音频信息读取超时，请换用 WAV 或 MP3。')); }, 15_000);
      signal?.addEventListener('abort', abort, { once: true });
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => {
        const valid = Number.isFinite(audio.duration) && audio.duration >= 1 && audio.duration <= MAX_AUDIO_SECONDS;
        cleanup();
        if (valid) resolve(); else reject(new Error('音频需为 1 秒至 8 分钟。'));
      };
      audio.onerror = () => { cleanup(); reject(new Error('音频无法读取，请转换为 WAV 或 MP3 后重试。')); };
      audio.src = url;
      if (signal?.aborted) abort();
    });
  } finally {
    audio.removeAttribute('src');
    audio.load();
    URL.revokeObjectURL(url);
  }
}

/** Decode locally; the original Blob is retained for playback and IndexedDB. */
export async function importAudio(
  file: File, reference: ScoreReference, pageCount: number,
  onProgress?: (message: string) => void, signal?: AbortSignal,
): Promise<ScoreAudio> {
  signal?.throwIfAborted();
  if (!file.size) throw new Error('音频文件为空。');
  if (isMidiFile(file)) {
    const { importMidi } = await import('./import-midi.ts');
    return importMidi(file, reference, pageCount, onProgress, signal);
  }
  if (file.size > MAX_AUDIO_BYTES) throw new Error('音频不能超过 60 MB。');
  if (!/\.(wav|mp3|m4a|aac|ogg|flac|opus|webm)$/i.test(file.name) && !file.type.startsWith('audio/')) {
    throw new Error('请选择 WAV、MP3、M4A、OGG、FLAC 音频或 MIDI 文件。');
  }
  if (typeof AudioContext === 'undefined') throw new Error('当前浏览器不支持本地音频解码。');
  onProgress?.('读取音频…');
  await checkDurationBeforeDecode(file, signal);
  signal?.throwIfAborted();
  const context = new AudioContext({ sampleRate: 22050 });
  try {
    let buffer: AudioBuffer;
    try { buffer = await context.decodeAudioData(await file.arrayBuffer()); }
    catch { throw new Error('音频无法解码，请转换为 WAV 或 MP3 后重试。'); }
    signal?.throwIfAborted();
    if (buffer.duration < 1 || buffer.duration > MAX_AUDIO_SECONDS || buffer.numberOfChannels > 8) {
      throw new Error('音频需为 1 秒至 8 分钟，最多 8 声道。');
    }
    const pcm = new Float32Array(buffer.length);
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    // Keep the strongest channel; summing opposite-phase stereo can cancel the instrument.
    const energies = channels.map((channel) => {
      let sum = 0;
      for (let i = 0; i < channel.length; i += 31) sum += channel[i] ** 2;
      return sum;
    });
    pcm.set(channels[energies.indexOf(Math.max(...energies))]);
    const alignment = bindAlignmentAnchors(await alignPcmToScore(pcm, buffer.sampleRate, reference, pageCount, onProgress, signal), reference);
    return { name: file.name, blob: file, duration: buffer.duration, alignment };
  } finally {
    if (context.state !== 'closed') await context.close().catch(() => undefined);
  }
}
