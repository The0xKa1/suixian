import { useEffect, useRef, useState } from 'react';
import type { ScoreDocument, ScorePage } from '../types';
import type { ScoreReference } from '../lib/score-following/types';
import { mapReadingPosition, remapAlignment } from '../lib/notation-alignment';

type View = 'original' | 'reflow';
type Layout = { pages: ScorePage[]; reference: ScoreReference };

/** Rendering is a disposable projection. Imported pages and the media source stay intact. */
export function useNotationView(source: ScoreDocument, storageKey: string, width: number) {
  const [requestedView, setRequestedView] = useState<View>(() => {
    try {
      const saved = localStorage.getItem(`suixian-view:${storageKey}`);
      if (saved === 'original' || (saved === 'reflow' && source.notation)) return saved;
    } catch { /* Preferences are optional. */ }
    return source.notation ? 'reflow' : 'original';
  });
  const [rendered, setRendered] = useState<ScoreDocument>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const cache = useRef(new Map<number, Layout>());
  const renderWidth = Math.max(480, Math.min(1200, Math.round(width / 80) * 80));

  useEffect(() => {
    if (requestedView !== 'reflow' || !source.notation || !source.reference) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true); setError('');
    const run = async () => {
      try {
        let layout = cache.current.get(renderWidth);
        if (!layout) {
          const { renderNotation } = await import('../lib/notation-render');
          controller.signal.throwIfAborted();
          layout = await renderNotation(source.notation!, source.reference!, {
            width: renderWidth, rowsPerPage: renderWidth <= 640 ? 2 : 3, signal: controller.signal,
          });
          controller.signal.throwIfAborted();
          cache.current.set(renderWidth, layout);
        }
        if (mapReadingPosition(0, source.reference!, layout.reference, source.pages.length, layout.pages.length) === null) {
          throw new Error('重排结果无法对应原谱，已保留原件。');
        }
        const audio = source.audio ? { ...source.audio, alignment: remapAlignment(
          source.audio.alignment, source.reference!, layout.reference, layout.pages.length,
        ) } : undefined;
        setRendered({ ...source, ...layout, audio });
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : '重新排版失败，已保留原件。');
          setRequestedView('original');
        }
      } finally { if (!controller.signal.aborted) setLoading(false); }
    };
    void run();
    return () => controller.abort();
  }, [source, requestedView, renderWidth]);

  const setView = (view: View) => {
    setError(''); setRequestedView(view);
    try { localStorage.setItem(`suixian-view:${storageKey}`, view); } catch { /* Optional preference. */ }
  };
  const reflow = requestedView === 'reflow' && !!rendered;
  return { document: reflow ? rendered! : source, reflow, requestedView, setView, loading, error };
}
