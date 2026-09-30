import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ScoreDocument } from '../types';

/** The media element is the only clock; frames only read its current position. */
export function useAudioPlayback(source: ScoreDocument['audio'], active: boolean) {
  const element = useRef<HTMLAudioElement | null>(null);
  const allowed = useRef(active);
  const requested = useRef(false);
  const generation = useRef(0);
  const pendingSeek = useRef<number | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(source?.duration ?? 0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');

  const pause = useCallback(() => {
    generation.current++;
    requested.current = false;
    element.current?.pause();
    setPlaying(false);
  }, []);

  useLayoutEffect(() => {
    allowed.current = active;
    if (!active) pause();
  }, [active, pause]);

  useEffect(() => {
    setTime(0);
    setDuration(source?.duration ?? 0);
    setPlaying(false);
    setError('');
    requested.current = false;
    pendingSeek.current = null;
    if (!source) return;
    const url = URL.createObjectURL(source.blob);
    const media = new Audio();
    media.preload = 'auto';
    element.current = media;
    let frame = 0;
    let disposed = false;
    const sample = () => {
      if (disposed) return;
      setTime(media.currentTime);
      if (Number.isFinite(media.duration) && media.duration > 0) setDuration(media.duration);
    };
    const tick = () => {
      sample();
      if (!media.paused && !media.ended) frame = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      if (!requested.current || !allowed.current || globalThis.document.hidden) { pause(); return; }
      cancelAnimationFrame(frame);
      setPlaying(true);
      tick();
    };
    const onPause = () => {
      cancelAnimationFrame(frame);
      sample();
      setPlaying(false);
    };
    const onMetadata = () => {
      if (pendingSeek.current !== null) {
        const limit = Number.isFinite(media.duration) ? media.duration : source.duration;
        media.currentTime = Math.max(0, Math.min(limit, pendingSeek.current));
        pendingSeek.current = null;
      }
      sample();
    };
    const onError = () => {
      pause();
      setError('音频无法播放，请更换文件。');
    };
    media.addEventListener('play', onPlay);
    media.addEventListener('pause', onPause);
    media.addEventListener('ended', onPause);
    media.addEventListener('timeupdate', sample);
    media.addEventListener('seeked', sample);
    media.addEventListener('loadedmetadata', onMetadata);
    media.addEventListener('durationchange', sample);
    media.addEventListener('error', onError);
    media.src = url;
    return () => {
      disposed = true;
      generation.current++;
      requested.current = false;
      cancelAnimationFrame(frame);
      media.removeEventListener('play', onPlay);
      media.removeEventListener('pause', onPause);
      media.removeEventListener('ended', onPause);
      media.removeEventListener('timeupdate', sample);
      media.removeEventListener('seeked', sample);
      media.removeEventListener('loadedmetadata', onMetadata);
      media.removeEventListener('durationchange', sample);
      media.removeEventListener('error', onError);
      media.pause();
      media.removeAttribute('src');
      media.load();
      URL.revokeObjectURL(url);
      if (element.current === media) element.current = null;
    };
  }, [source, pause]);

  useEffect(() => {
    const onVisibility = () => { if (globalThis.document.hidden) pause(); };
    globalThis.document.addEventListener('visibilitychange', onVisibility);
    return () => globalThis.document.removeEventListener('visibilitychange', onVisibility);
  }, [pause]);

  const seek = useCallback((value: number) => {
    const media = element.current;
    if (!media || !Number.isFinite(value)) return;
    const limit = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : source?.duration ?? 0;
    const target = Math.max(0, Math.min(value, limit));
    // Preserve seeks made before metadata is ready (e.g. immediately after opening a score).
    pendingSeek.current = media.readyState === 0 ? target : null;
    try {
      media.currentTime = target;
      setTime(media.currentTime);
    } catch {
      setError('暂时无法跳转音频，请稍后再试。');
    }
  }, [source?.duration]);

  const play = useCallback(async () => {
    const media = element.current;
    if (!media || !allowed.current || globalThis.document.hidden) return;
    const token = ++generation.current;
    requested.current = true;
    setError('');
    if (media.ended || (Number.isFinite(media.duration) && media.currentTime >= media.duration)) {
      media.currentTime = 0;
      setTime(0);
    }
    try {
      await media.play();
      // A stale play promise must not pause a newer play request on the same element.
      if (element.current !== media || !requested.current || !allowed.current || globalThis.document.hidden) media.pause();
    } catch (cause) {
      if (element.current !== media || generation.current !== token) return;
      requested.current = false;
      setPlaying(false);
      if (cause instanceof Error && cause.name === 'AbortError') return;
      setError('音频未能播放，请再次点击播放。');
    }
  }, []);

  return { time, duration, playing, error, play, pause, seek };
}
