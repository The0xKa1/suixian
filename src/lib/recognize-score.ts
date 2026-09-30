import type { ScorePage } from '../types';
import type { ScoreReference } from './score-following/types';
import { validScoreCursor } from './audio-cursor';
import { createNotation } from './notation';
import type { StructuredScore } from './notation';

export interface RecognizedScore {
  reference: ScoreReference;
  notation?: StructuredScore;
  notationError?: string;
}

/** Only rendered score pages go to the loopback OMR service; audio stays in the browser. */
export async function recognizeScore(pages: ScorePage[], signal?: AbortSignal): Promise<RecognizedScore> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.throwIfAborted();
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = window.setTimeout(() => controller.abort(), 600_000);
  try {
    const response = await fetch('/api/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pages: pages.map(({ src, width, height }) => ({ src, width, height })) }),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.reference) {
      throw new Error(result?.error || '本机识谱服务不可用，请启动识谱服务后重试。');
    }
    const reference = result.reference as ScoreReference;
    if (!Array.isArray(reference.events) || !reference.events.length || reference.events.length > 20_000) {
      throw new Error('谱面中未识别到可用音符。');
    }
    let previousBeat = -1;
    let previousPosition = -1;
    const covered = new Set<number>();
    for (const [index, event] of reference.events.entries()) {
      if (!Array.isArray(event.midi) || !event.midi.length || event.midi.some(pitch => !Number.isInteger(pitch) || pitch < 0 || pitch > 127)
        || !Number.isFinite(event.beat) || event.beat < 0 || event.beat < previousBeat
        || !Number.isFinite(event.durationBeats) || event.durationBeats <= 0
        || !Number.isFinite(event.position) || event.position < previousPosition || event.position < 0 || event.position >= pages.length) {
        throw new Error('识谱结果不完整，无法建立时间轴。');
      }
      previousBeat = event.beat;
      event.id = `event-${index}`;
      if (!validScoreCursor(event.cursor)) delete event.cursor;
      previousPosition = event.position;
      covered.add(Math.floor(event.position));
    }
    if (covered.size !== pages.length) throw new Error('部分谱页没有识别到音符，无法自动对齐。');
    let notation: StructuredScore | undefined;
    let notationError = typeof result.notationUnavailable === 'string' ? result.notationUnavailable : undefined;
    if (Array.isArray(result.notationSources) && result.notationSources.length === pages.length) {
      try { notation = createNotation(result.notationSources); }
      catch (cause) { notationError = cause instanceof Error ? cause.message : '乐谱结构无法读取，已保留原件。'; }
    } else if (!notationError) notationError = '未取得完整乐谱结构，当前显示原件。';
    return { reference, notation, notationError };
  } catch (error) {
    signal?.throwIfAborted();
    if (controller.signal.aborted) throw new Error('识谱超时，请减少页数后重试。');
    if (error instanceof TypeError) throw new Error('无法连接本机识谱服务。');
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
