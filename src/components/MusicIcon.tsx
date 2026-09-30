import type { CSSProperties } from 'react';

export type MusicIconName = 'mark' | 'score' | 'library' | 'upload' | 'close' | 'play' | 'pause' | 'replay' | 'previous' | 'next' | 'buffer' | 'trash' | 'check' | 'loading' | 'mic';

interface MusicIconProps { name: MusicIconName; size?: number; weight?: number; className?: string; style?: CSSProperties }

/**
 * Bespoke line drawings on a 24 grid. `weight` is the rendered stroke in CSS pixels,
 * so a 15 px transport glyph and a 36 px brand mark read with the same pen.
 * Motion belongs to the interactive parent; see the icon section of styles.css.
 */
export default function MusicIcon({ name, size = 22, weight, className = '', style }: MusicIconProps) {
  const stroke = (weight ?? (size >= 30 ? 1.6 : 1.3)) * 24 / size;
  return <svg className={`music-icon icon-${name} ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>
    {name === 'mark' && <><circle className="mark-hole" cx="12" cy="12" r="7.25" pathLength={1}/><g className="mark-pluck"><path className="mark-string" d="M1.75 12h5.1c1.5 0 2.2-3 3.4-3s2.1 6 3.5 6 2.1-3 3.4-3h5.1" pathLength={1}/></g></>}
    {name === 'score' && <><rect className="icon-page" x="5.25" y="3" width="13.5" height="18" rx="1.6"/><path d="M8.25 8.5h7.5M8.25 11.5h7.5M8.25 14.5h7.5" opacity=".42"/><g className="icon-note"><path d="M13.6 7v8.1"/><ellipse cx="11.9" cy="15.4" rx="1.85" ry="1.35" transform="rotate(-18 11.9 15.4)" fill="currentColor" stroke="none"/></g></>}
    {name === 'library' && <><rect className="icon-book first-book" x="4" y="4.5" width="3.6" height="15.5" rx=".9"/><rect className="icon-book second-book" x="9.6" y="3" width="3.6" height="17" rx=".9"/><g className="icon-book third-book"><rect x="17" y="4.5" width="3.6" height="15.5" rx=".9" transform="rotate(-12 17 20)"/></g><path d="M2.75 21.75h18.5" opacity=".5"/></>}
    {name === 'upload' && <><path d="M4.5 14.5v3.25a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V14.5"/><g className="icon-upload-arrow"><path d="M12 15.5V4.25M7.75 8.5 12 4.25l4.25 4.25"/></g></>}
    {name === 'close' && <path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>}
    {name === 'play' && <path d="M8.2 5.35v13.3a.9.9 0 0 0 1.37.77l10.6-6.65a.9.9 0 0 0 0-1.53L9.57 4.58a.9.9 0 0 0-1.37.77Z" fill="currentColor" stroke="none"/>}
    {name === 'pause' && <g fill="currentColor" stroke="none"><rect x="6.75" y="5" width="3.3" height="14" rx="1.1"/><rect x="13.95" y="5" width="3.3" height="14" rx="1.1"/></g>}
    {name === 'replay' && <g className="icon-replay"><path d="M5.1 13.2A7 7 0 1 0 7.3 7.1"/><path d="M5.2 4.4v3.9h3.9"/></g>}
    {name === 'previous' && <path className="icon-direction" d="M19.5 12h-15M9.75 6.75 4.5 12l5.25 5.25"/>}
    {name === 'next' && <path className="icon-direction" d="M4.5 12h15M14.25 6.75 19.5 12l-5.25 5.25"/>}
    {name === 'buffer' && <><g className="icon-buffer-page"><path d="M5.5 2.75v5.5a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-5.5"/><path d="M8.5 6.25h7" opacity=".42"/></g><path className="icon-buffer-seam" d="M3 12h1.2M7 12h1.2M11 12h2M15.8 12H17M19.8 12H21" opacity=".55"/><g className="icon-buffer-next"><path d="M5.5 21.25v-5.5a1.5 1.5 0 0 1 1.5-1.5h10a1.5 1.5 0 0 1 1.5 1.5v5.5"/><path d="M8.5 17.75h7" opacity=".42"/></g></>}
    {name === 'trash' && <><g className="icon-lid"><path d="M4.75 7h14.5"/><path d="M9.5 7V5.25a1.25 1.25 0 0 1 1.25-1.25h2.5a1.25 1.25 0 0 1 1.25 1.25V7"/></g><path d="m6.75 7 .8 11.6a1.6 1.6 0 0 0 1.6 1.5h5.7a1.6 1.6 0 0 0 1.6-1.5L17.25 7"/><path d="M10.25 10.75v5.5M13.75 10.75v5.5" opacity=".6"/></>}
    {name === 'check' && <path className="icon-check-path" d="m5.25 12.5 4.25 4.25 9.25-9.5" pathLength={1}/>}
    {name === 'loading' && <><circle cx="12" cy="12" r="8" opacity=".22"/><path d="M12 4a8 8 0 0 1 8 8"/></>}
    {name === 'mic' && <><rect x="9.25" y="3" width="5.5" height="10.5" rx="2.75"/><path d="M6.75 11a5.25 5.25 0 0 0 10.5 0M12 16.25V20.5M9.25 20.5h5.5"/><path className="icon-mic-wave wave-left" d="M3.8 8.4a6 6 0 0 0 0 5.2" opacity=".5"/><path className="icon-mic-wave wave-right" d="M20.2 8.4a6 6 0 0 1 0 5.2" opacity=".5"/></>}
  </svg>;
}
