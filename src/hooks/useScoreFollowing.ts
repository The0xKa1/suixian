import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createScoreFollower } from '../lib/score-following/follower';
import { createMicrophoneSession } from '../lib/score-following/microphone';
import type { FollowingResult, ScoreReference } from '../lib/score-following/types';

export type MicrophoneStatus = 'idle' | 'requesting' | 'listening' | 'error';
const INITIAL: FollowingResult = { position: 0, eventIndex: 0, confidence: 0, state: 'waiting' };

export function useScoreFollowing(reference?: ScoreReference) {
  const follower = useMemo(() => reference ? createScoreFollower(reference) : undefined, [reference]);
  const microphone = useMemo(() => createMicrophoneSession(), []);
  const [status, setStatus] = useState<MicrophoneStatus>('idle');
  const [result, setResult] = useState<FollowingResult>(INITIAL);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const active = useRef(false);

  const stop = useCallback(() => {
    generation.current++;
    active.current = false;
    microphone.stop();
    setStatus('idle');
  }, [microphone]);

  useEffect(() => {
    generation.current++;
    active.current = false;
    microphone.stop();
    setStatus('idle');
    setResult(follower?.reset() ?? INITIAL);
    setError('');
    return () => {
      generation.current++;
      active.current = false;
      microphone.stop();
    };
  }, [follower, microphone]);

  const seek = useCallback((position: number) => {
    setResult(follower?.seek(position) ?? INITIAL);
  }, [follower]);

  const reset = useCallback((position = 0) => {
    stop();
    setError('');
    setResult(follower?.reset(position) ?? INITIAL);
  }, [follower, stop]);

  const start = useCallback(async (position?: number) => {
    if (!follower) { setError('此谱暂不支持跟随'); setStatus('error'); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') {
      setError('浏览器不支持麦克风'); setStatus('error'); return;
    }
    if (active.current) return;
    const token = ++generation.current;
    active.current = true;
    if (position !== undefined) setResult(follower.seek(position));
    setError('');
    setStatus('requesting');
    try {
      const started = await microphone.start((frame) => {
        if (generation.current === token) setResult(follower.process(frame));
      }, () => {
        if (generation.current !== token) return;
        active.current = false;
        setStatus('idle');
      });
      if (generation.current === token && started) setStatus('listening');
    } catch (cause) {
      if (generation.current !== token) return;
      active.current = false;
      const name = cause instanceof Error ? cause.name : '';
      setError(name === 'NotAllowedError' ? '麦克风未授权' : name === 'NotFoundError' ? '未找到麦克风' : '麦克风暂不可用');
      setStatus('error');
    }
  }, [follower, microphone]);

  return { status, result, error, start, stop, reset, seek };
}
