import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import MusicIcon from './MusicIcon';
import { useScoreFollowing } from '../hooks/useScoreFollowing';
import { useTrackSpring } from '../hooks/useTrackSpring';
import { usePageGestures } from '../hooks/usePageGestures';
import { useAudioPlayback } from '../hooks/useAudioPlayback';
import { useNotationView } from '../hooks/useNotationView';
import { mapReadingPosition } from '../lib/notation-alignment';
import type { ScoreDocument } from '../types';
import { PAGE_GAP, followingTrackOffset, pageOpacity, readerGeometry, readingState } from '../lib/transition';
import { audioPositionAtTime, audioTimeAtPosition } from '../lib/audio-alignment';
import { audioBufferState } from '../lib/audio-buffer';
import { audioCursorAtTime, buildCursorTimeline, cursorVisibleOffset } from '../lib/audio-cursor';
import './ScoreReader.css';

export interface ReaderLocation { position: number; audioTime: number; mode: 'follow' | 'audio'; }

interface ScoreReaderProps {
  document: ScoreDocument;
  onUpload: () => void;
  onReset: () => void;
  onAttachAudio?: () => void;
  active?: boolean;
  storageKey?: string;
  onPrepareNotation?: (location: ReaderLocation) => void;
  preparingNotation?: boolean;
  prepareStatus?: string;
  onCancelPreparation?: () => void;
  initialLocation?: ReaderLocation;
}

function formatTime(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function savedBufferLead() {
  try {
    const value = localStorage.getItem('suixian-buffer-lead');
    return value !== null && [0, 2, 4, 6].includes(Number(value)) ? Number(value) : 4;
  } catch { return 4; }
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduced;
}

export default function ScoreReader({ document: sourceDocument, onUpload, onReset, onAttachAudio, active = true,
  storageKey = 'current', onPrepareNotation, preparingNotation = false, prepareStatus, onCancelPreparation, initialLocation }: ScoreReaderProps) {
  const [viewportSize, setViewportSize] = useState({ width: 900, maxHeight: 440 });
  const view = useNotationView(sourceDocument, storageKey, viewportSize.width);
  const document = view.document;
  const pageCount = document.pages.length;
  const [sourcePosition, setPosition] = useState(initialLocation?.position ?? 0);
  const manualPosition = view.reflow && sourceDocument.reference && document.reference
    ? mapReadingPosition(sourcePosition, sourceDocument.reference, document.reference, sourceDocument.pages.length, pageCount) ?? 0 : sourcePosition;
  const [bufferLead, setBufferLead] = useState(savedBufferLead);
  const [cursorEnabled, setCursorEnabled] = useState(true);
  const [skipBufferBoundary, setSkipBufferBoundary] = useState<number>();
  const [mode, setMode] = useState<'follow' | 'audio'>(initialLocation?.mode ?? (document.audio ? 'audio' : 'follow'));
  // Layout switches must not recreate the media element or restart the recording.
  const audio = useAudioPlayback(sourceDocument.audio, active);
  const { pause: pauseAudio, play: playAudio, seek: seekAudio } = audio;
  const audioMode = mode === 'audio' && !!document.audio;
  const position = audioMode && document.audio
    ? audioPositionAtTime(document.audio.alignment, audio.time, audio.duration, pageCount)
    : manualPosition;
  const transportActive = audioMode && audio.playing;
  const following = useScoreFollowing(sourceDocument.reference);
  const { stop: stopFollowing, seek: seekFollowing } = following;
  const listening = following.status === 'listening' || following.status === 'requesting';
  const viewport = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const cursorTimeline = useMemo(() => document.audio
    ? buildCursorTimeline(document.reference, document.audio.alignment, pageCount) : null,
  [document.reference, document.audio, pageCount]);
  const cursorAvailable = !!cursorTimeline?.points.some(point => point.cursor);
  const audioLocation = audioMode && cursorTimeline ? audioCursorAtTime(cursorTimeline, audio.time) : null;
  const cursor = cursorEnabled ? audioLocation : null;
  const followedEvent = view.reflow && listening ? document.reference?.events[following.result.eventIndex] : undefined;
  const visibleStaff = audioLocation ?? (followedEvent?.cursor ? { ...followedEvent.cursor, page: Math.floor(followedEvent.position) } : null);
  // Audio buffering is scheduled around matched page times, never inferred row coordinates.
  const audioBuffer = audioMode && document.audio
    ? audioBufferState(document.audio.alignment, audio.time, audio.duration, pageCount, bufferLead, skipBufferBoundary)
    : null;
  // Microphone OMR still lacks reliable row coordinates or a future audio clock.
  const pageOnly = !view.reflow && (document.kind === 'pdf' || document.kind === 'image');
  const reading = readingState(position, pageCount);
  const state = audioMode
    ? { ...reading, phase: audioBuffer ? 'buffer' as const : reading.phase === 'complete' ? 'complete' as const : 'reading' as const }
    : pageOnly && reading.phase === 'buffer' ? { ...reading, phase: 'reading' as const } : reading;
  const transportComplete = audio.duration > 0 && audio.time >= audio.duration;
  const maxWidth = Math.max(...document.pages.map(page => page.width), 1);
  const maxHeight = Math.max(...document.pages.map(page => page.height), 1);
  const { scale, leafHeight, topInset, stride, viewportHeight } = readerGeometry(viewportSize.width, viewportSize.maxHeight, maxWidth, maxHeight);
  const baseOffset = audioMode ? (audioBuffer?.offsetPages ?? state.pageIndex) * stride
    : pageOnly ? state.pageIndex * stride : followingTrackOffset(position, pageCount, stride);
  const cursorPage = visibleStaff ? document.pages[visibleStaff.page] : undefined;
  const cursorTop = visibleStaff && cursorPage ? topInset + visibleStaff.page * stride + (leafHeight - cursorPage.height * scale) / 2 + visibleStaff.y * cursorPage.height * scale : 0;
  const targetOffset = visibleStaff && cursorPage && (audioBuffer || (view.reflow && state.phase === 'buffer'))
    ? cursorVisibleOffset(baseOffset, cursorTop, cursorTop + visibleStaff.height * cursorPage.height * scale, viewportHeight) : baseOffset;
  const track = useRef<HTMLDivElement>(null);
  const moving = useRef(false);
  const paintTrack = useCallback((value: number, isMoving: boolean) => {
    const element = track.current;
    if (!element) return;
    element.style.transform = `translate3d(0, ${-value}px, 0)`;
    element.dataset.offset = value.toFixed(2);
    // Opacity follows the painted track, not the logical page: seeks and reverse
    // turns remain continuous, and the two buffered page halves stay clear.
    Array.from(element.children).forEach((leaf, index) => {
      const opacity = (reducedMotion ? 1 : pageOpacity(index, value / stride)).toFixed(4);
      const style = (leaf as HTMLElement).style;
      if (style.opacity !== opacity) style.opacity = opacity;
    });
    if (moving.current !== isMoving) {
      moving.current = isMoving;
      viewport.current?.toggleAttribute('data-moving', isMoving);
    }
  }, [stride, reducedMotion]);
  const spring = useTrackSpring(targetOffset, stride, reducedMotion, sourceDocument, paintTrack);
  const resumeAfterGesture = useRef(false);
  const pageMemory = useRef({ page: 0, direction: 1 });
  if (pageMemory.current.page !== state.pageIndex) {
    pageMemory.current = { page: state.pageIndex, direction: state.pageIndex > pageMemory.current.page ? 1 : -1 };
  }
  const phaseLabel = state.phase === 'complete' ? '已完成' : state.phase === 'buffer' ? '跨页缓冲' : '阅读中';
  const audioLabel = audio.error ? '播放失败' : audioBuffer
    ? audio.time < audioBuffer.boundaryTime ? '提前预览' : '保留前页'
    : state.phase === 'complete' ? '已完成' : !audio.playing ? '已暂停' : phaseLabel;
  const followLabel = !document.reference ? '此谱暂不支持跟随'
    : following.status === 'requesting' ? '等待授权'
    : following.status === 'error' ? following.error
    : following.result.state === 'complete' ? '已完成'
    : !listening ? '已停止'
    : following.result.state === 'uncertain' ? '待校准'
    : following.result.state === 'tracking' ? (state.phase === 'buffer' ? '跨页缓冲' : '跟随中') : '等待演奏';

  useLayoutEffect(() => {
    setPosition(initialLocation?.position ?? 0);
    setMode(initialLocation?.mode ?? (document.audio ? 'audio' : 'follow'));
    setSkipBufferBoundary(undefined);
    resumeAfterGesture.current = false;
  }, [sourceDocument]);

  useEffect(() => {
    if (initialLocation && sourceDocument.audio) seekAudio(initialLocation.audioTime);
  }, [sourceDocument]);

  // The same score position can move to a different display page after reflow.
  useLayoutEffect(() => {
    setSkipBufferBoundary(undefined);
    spring.hold(targetOffset);
    spring.release(0, targetOffset);
  // Only a new display layout triggers this snap, never ordinary playback frames.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.pages]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      const preferredHeight = Number.parseFloat(getComputedStyle(element).getPropertyValue('--reader-max-height')) || 640;
      const maxHeight = Math.min(preferredHeight, Math.max(260, window.innerHeight - element.getBoundingClientRect().top - 157));
      if (width === 0) return;
      setViewportSize(value => value.width === width && value.maxHeight === maxHeight ? value : { width, maxHeight });
    };
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    measure();
    window.addEventListener('resize', measure);
    return () => {
      resize.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  useEffect(() => {
    if (!active) {
      stopFollowing();
      resumeAfterGesture.current = false;
    }
  }, [active, stopFollowing]);

  useEffect(() => {
    const hide = () => {
      if (globalThis.document.hidden) {
        stopFollowing();
        resumeAfterGesture.current = false;
      }
    };
    globalThis.document.addEventListener('visibilitychange', hide);
    return () => globalThis.document.removeEventListener('visibilitychange', hide);
  }, [stopFollowing]);

  useEffect(() => {
    if (mode !== 'follow' || following.status !== 'listening') return;
    if (following.result.state === 'tracking' || following.result.state === 'complete') {
      setPosition(Math.min(sourceDocument.pages.length, following.result.position));
    }
    if (following.result.state === 'complete') stopFollowing();
  }, [mode, following.status, following.result, sourceDocument.pages.length, stopFollowing]);

  const ensureStageVisible = useCallback(() => {
    const element = stage.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    if (bounds.top < 20 || bounds.bottom > window.innerHeight - 120) {
      element.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    }
  }, [reducedMotion]);

  const togglePlay = useCallback(() => {
    if (!active || !document.audio) return;
    resumeAfterGesture.current = false;
    stopFollowing();
    setMode('audio');
    if (audioMode && audio.playing) pauseAudio();
    else {
      if (!audioMode || audio.time >= audio.duration) setSkipBufferBoundary(undefined);
      if (!audioMode) seekAudio(audioTimeAtPosition(document.audio.alignment, position, audio.duration, pageCount));
      ensureStageVisible();
      void playAudio();
    }
  }, [active, document.audio, audioMode, audio.playing, audio.time, audio.duration, position, pageCount, ensureStageVisible, stopFollowing, pauseAudio, seekAudio, playAudio]);

  const goTo = useCallback((value: number) => {
    const target = Math.max(0, Math.min(value, pageCount));
    if (audioMode && document.audio) {
      // Explicit page navigation opens that page fully; its outgoing buffer still works.
      setSkipBufferBoundary(Math.floor(target));
      seekAudio(audioTimeAtPosition(document.audio.alignment, target, audio.duration, pageCount));
      return;
    }
    const original = view.reflow && document.reference && sourceDocument.reference
      ? mapReadingPosition(target, document.reference, sourceDocument.reference, pageCount, sourceDocument.pages.length) : target;
    if (original === null) return;
    setPosition(original);
    seekFollowing(original);
  }, [audioMode, document.audio, document.reference, audio.duration, pageCount, seekAudio, seekFollowing, view.reflow, sourceDocument]);

  // Holding the score pauses the active clock; only an active, visible reader resumes.
  usePageGestures(viewport, {
    spring,
    stride,
    pageCount,
    enabled: active,
    onGrab: () => {
      resumeAfterGesture.current = audioMode && audio.playing;
      pauseAudio();
    },
    onSettle: page => {
      if (!active || globalThis.document.hidden) { resumeAfterGesture.current = false; return; }
      if (page !== null) goTo(page);
      if (resumeAfterGesture.current && audioMode) void playAudio();
      resumeAfterGesture.current = false;
    },
  });

  const previousPage = useCallback(() => {
    goTo(Math.min(Math.floor(position), pageCount - 1) - 1);
  }, [position, pageCount, goTo]);

  const nextPage = useCallback(() => {
    goTo(Math.min(Math.floor(position) + 1, pageCount - 1));
  }, [position, pageCount, goTo]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!active) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
      if (globalThis.document.querySelector('dialog[open]')) return;
      const element = event.target instanceof HTMLElement ? event.target : null;
      if (element?.closest('button, input, textarea, select, a, [contenteditable="true"], [role="button"]')) return;
      if (event.code === 'Space' && document.audio) {
        event.preventDefault();
        togglePlay();
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        previousPage();
      } else if ((event.key === 'ArrowRight' || event.key === 'PageDown') && state.hasNext) {
        event.preventDefault();
        nextPage();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [togglePlay, previousPage, nextPage, state.hasNext, active, document.audio]);

  const previewBuffer = () => {
    if (!active || !document.audio) return;
    resumeAfterGesture.current = false;
    pauseAudio();
    stopFollowing();
    setMode('audio');
    setSkipBufferBoundary(undefined);
    const next = Math.min(state.pageIndex + 1, pageCount - 1);
    const boundary = audioTimeAtPosition(document.audio.alignment, next, audio.duration, pageCount);
    const buffer = audioBufferState(document.audio.alignment, boundary, audio.duration, pageCount, bufferLead);
    if (buffer) seekAudio(Math.min(boundary, buffer.startTime + 1.2));
    ensureStageVisible();
  };

  const toggleFollowing = () => {
    if (!active || !document.reference) return;
    resumeAfterGesture.current = false;
    pauseAudio();
    setMode('follow');
    if (listening) stopFollowing();
    else {
      ensureStageVisible();
      const current = audioMode && sourceDocument.audio
        ? audioPositionAtTime(sourceDocument.audio.alignment, audio.time, audio.duration, sourceDocument.pages.length) : sourcePosition;
      const target = current >= sourceDocument.pages.length || (!audioMode && following.result.state === 'complete') ? 0 : current;
      setPosition(target);
      void following.start(target);
    }
  };

  return (
    <section className="score-reader" aria-label="乐谱阅读器" data-view={view.reflow ? 'reflow' : 'original'} data-phase={state.phase} data-mode={mode} data-buffer={audioBuffer?.phase} data-buffer-pages={audioBuffer ? `${audioBuffer.fromPage + 1},${audioBuffer.toPage + 1}` : undefined} data-position={position.toFixed(4)} data-page={state.pageIndex + 1} data-playing={transportActive}>
      <header className="reader-heading">
        <div className="reader-document">
          <h2 title={document.name}>{document.name}</h2>
          {document.audio && <p className="reader-audio-name" title={document.audio.name}>{document.audio.name}{document.audio.kind === 'midi' && ' · 合成音色'}</p>}
        </div>
        <div className="reader-heading-actions">
          {onAttachAudio && <button type="button" className="reader-bracket reader-upload" onClick={onAttachAudio}><span className="reader-bracket-label">{document.audio ? '更换音频' : '添加音频'}</span></button>}
          <button type="button" className="reader-bracket reader-upload" onClick={onUpload} aria-label="换一份谱"><span className="reader-bracket-label"><MusicIcon name="upload" size={16} />换一份谱</span></button>
        </div>
      </header>

      <div className="reader-view-bar">
        <div className="reader-view-switch" role="group" aria-label="谱面显示方式">
          <button type="button" aria-pressed={view.requestedView === 'reflow'} disabled={!sourceDocument.notation || preparingNotation}
            onClick={() => view.setView('reflow')}>重新排版</button>
          <button type="button" aria-pressed={view.requestedView === 'original'} disabled={preparingNotation}
            onClick={() => view.setView('original')}>{sourceDocument.kind === 'pdf' || sourceDocument.kind === 'image' ? '原件' : '导入版'}</button>
        </div>
        {preparingNotation ? <div className="reader-parse-state"><span role="status">{prepareStatus}</span>{prepareStatus !== '正在保存…' && <button type="button" onClick={onCancelPreparation}>取消</button>}</div>
          : view.loading ? <span className="reader-layout-status" role="status">正在排版…</span>
          : !sourceDocument.notation && onPrepareNotation ? <button type="button" className="reader-bracket" onClick={() => onPrepareNotation({ position: sourcePosition, audioTime: audio.time, mode })}><span className="reader-bracket-label">解析谱面</span></button> : null}
      </div>
      {(view.error || sourceDocument.notationError) && <p className="reader-notation-message" role="status">{view.error || sourceDocument.notationError}</p>}
      {!sourceDocument.notation && !onPrepareNotation && sourceDocument.kind === 'musicxml' && <p className="reader-notation-message">重新导入 MusicXML 后可使用重新排版。</p>}

      <div className="reader-stage" ref={stage}>
        <div className="reader-stage-bar">
          <span className="reader-mode"><span aria-hidden="true" />{audioMode ? document.audio?.kind === 'midi' ? 'MIDI 同步' : '音频同步' : '听音跟随'}</span>
          <span className="reader-status" aria-live="polite" aria-atomic="true"><span className={`reader-status-dot ${state.phase === 'buffer' ? 'is-buffer' : ''}`} aria-hidden="true" />{audioMode ? audioLabel : followLabel}</span>
        </div>
        <div className="reader-viewport" ref={viewport} style={{ height: viewportHeight }} aria-label={audioBuffer ? `跨页缓冲，第 ${audioBuffer.fromPage + 1} 页与第 ${audioBuffer.toPage + 1} 页，共 ${pageCount} 页` : `乐谱第 ${state.pageIndex + 1} 页，共 ${pageCount} 页`}>
          <div className="reader-track" ref={track} style={{ top: topInset, gap: PAGE_GAP }}>
            {document.pages.map((page, index) => (
              <div className="reader-leaf" key={page.id} style={{ height: leafHeight }} data-sheet={index + 1} aria-hidden={audioBuffer ? index !== audioBuffer.fromPage && index !== audioBuffer.toPage : index !== state.pageIndex && !(state.phase === 'buffer' && index === state.pageIndex + 1)}>
                {index > 0 && <span className="reader-seam" aria-hidden="true" style={{ top: -PAGE_GAP / 2, width: page.width * scale }}><span>{String(index + 1).padStart(2, '0')}</span></span>}
                <div className="reader-paper" style={{ width: page.width * scale, height: page.height * scale }}>
                  <img src={page.src} alt={`${document.name}，第 ${index + 1} 页`} draggable={false} style={{ width: page.width * scale, height: page.height * scale }} />
                  {cursor?.page === index && <span key={cursor.system} className="reader-cursor" role="img" aria-label={`音频位置，第 ${index + 1} 页，第 ${cursor.system + 1} 行`} data-event={cursor.eventIndex} data-system={cursor.system}
                    style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%`, height: `${cursor.height * 100}%` }} />}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="reader-page-strip">
          <span className="reader-page-number">PAGE <span className="reader-page-current"><strong key={state.pageIndex} className={pageMemory.current.direction > 0 ? 'is-forward' : 'is-back'}>{String(state.pageIndex + 1).padStart(2, '0')}</strong></span><span> / {String(pageCount).padStart(2, '0')}</span></span>
        </div>
      </div>

      <div className="reader-controls">
        <div className="reader-transport">
          <button type="button" className={`reader-follow ${listening ? 'is-active' : ''} ${following.status === 'requesting' ? 'is-requesting' : ''}`} onClick={toggleFollowing} disabled={!document.reference} aria-pressed={listening} title={document.reference ? undefined : '此谱暂不支持跟随'}>
            <MusicIcon name="mic" size={17} /><span>{following.status === 'requesting' ? '取消授权' : listening ? '停止跟随' : '听音跟随'}</span>
          </button>
          {document.audio && <button type="button" className="reader-play" onClick={togglePlay} aria-label={`${transportComplete ? '重新播放' : transportActive ? '暂停' : '播放'}音频`}>
            <span className="reader-play-icon" key={transportComplete ? 'replay' : transportActive ? 'pause' : 'play'}>{transportComplete ? <MusicIcon name="replay" size={16} /> : transportActive ? <MusicIcon name="pause" size={15} /> : <MusicIcon name="play" size={15} />}</span>
            <span>{transportComplete ? '重播' : transportActive ? '暂停' : '播放音频'}</span>
          </button>}
          <div className="reader-page-controls">
            <button type="button" className="reader-icon-button" onClick={previousPage} disabled={state.pageIndex === 0 && position < 1} aria-label="上一页" title="上一页 · ←"><MusicIcon name="previous" size={21} /></button>
            <button type="button" className="reader-icon-button" onClick={nextPage} disabled={!state.hasNext} aria-label="下一页" title="下一页 · →"><MusicIcon name="next" size={21} /></button>
          </div>
        </div>
        {document.audio && <div className="reader-buffer-controls">
          <button type="button" className="reader-cursor-toggle" aria-label="显示播放光标" aria-pressed={cursorEnabled && cursorAvailable} disabled={!cursorAvailable}
            title={cursorAvailable ? undefined : '此谱缺少音符坐标，请重新导入谱子与音频'} onClick={() => setCursorEnabled(value => !value)}><span aria-hidden="true" />光标</button>
          {pageCount > 1 && <label className="reader-buffer-setting"><span>缓冲</span><select aria-label="提前预览时间" value={bufferLead} onChange={event => {
            const value = Number(event.target.value);
            setBufferLead(value); setSkipBufferBoundary(undefined);
            try { localStorage.setItem('suixian-buffer-lead', String(value)); } catch { /* Optional local preference. */ }
          }}><option value="0">关闭</option><option value="2">提前 2 秒</option><option value="4">提前 4 秒</option><option value="6">提前 6 秒</option></select></label>}
          <button type="button" className="reader-bracket reader-preview" onClick={previewBuffer} disabled={pageCount < 2 || bufferLead === 0} aria-label="预览跨页"><span className="reader-bracket-label"><MusicIcon name="buffer" size={18} />预览跨页<span className="reader-button-arrow" aria-hidden="true">↗</span></span></button>
        </div>}
      </div>

      {audioMode && document.audio && <div className="reader-progress-row reader-audio-progress">
        <span className="reader-progress-label reader-time">{formatTime(audio.time)}</span>
        <span className="reader-progress-track">
          {Array.from({ length: pageCount - 1 }, (_, index) => {
            const time = audioTimeAtPosition(document.audio!.alignment, index + 1, audio.duration, pageCount);
            return <span key={index} className={`reader-progress-tick ${audio.time >= time ? 'is-passed' : ''}`} style={{ left: `${time / Math.max(audio.duration, 1) * 100}%` }} aria-hidden="true" />;
          })}
          <input className="reader-progress" type="range" min="0" max={audio.duration || 1} step="0.01" value={audio.time} onChange={event => { setSkipBufferBoundary(undefined); seekAudio(Number(event.target.value)); }} aria-label="音频进度" aria-valuetext={`${formatTime(audio.time)}，共 ${formatTime(audio.duration)}，第 ${state.pageIndex + 1} 页`} style={{ '--progress': `${audio.time / Math.max(audio.duration, 1) * 100}%` } as React.CSSProperties} />
        </span>
        <span className="reader-progress-value reader-time">{formatTime(audio.duration)}</span>
      </div>}

      {audioMode && audio.error && <p className="reader-error" role="alert">{audio.error}</p>}
      {mode === 'follow' && following.error && <p className="reader-error" role="alert">{following.error}</p>}

      {document.kind !== 'demo' && <div className="reader-reset"><button type="button" onClick={onReset}>示例乐谱 <span aria-hidden="true">↗</span></button></div>}
    </section>
  );
}
