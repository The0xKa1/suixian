# Reader specification

## Scope
- Target: src/components/ScoreReader.tsx, src/components/ScoreReader.css, src/lib/transition.ts, src/lib/audio-buffer.ts.
- Style adaptation of WeekSync; functional music reader content is original.
- Interaction: buttons, keyboard, gestures, microphone following, and uploaded audio time.

## Reference evidence
- WeekSync inspected 2026-09-29 at 1280×720.
- Body background rgb(210,210,210); warm gray panel visually gray-beige.
- Body Inter; metadata Red Hat Mono, 10.6667px at observed viewport.
- Text black; bracket CTA transition .2s; minimal rounding except dotted outer frame.
- Fixed left rail; large content area and generous spacing.

## Prototype adaptation
- Warm background #cec9c0, paper #f9f7f3, ink #23251f, muted #66685f.
- Reader compact header above score, 1px hairline separators, restrained mono metadata.
- Accent #dfe296 is a subtle score-following indicator, not a broad theme color.
- Paper remains same scale during all transitions.
- Viewport fits the remaining screen height and paper aspect ratio; layout respects mobile width.
- Persistent vertical track; pages stay mounted and translate continuously.
- Listening: hold overlap until the next page's first confirmed event; never scroll the last row away early.
- Pages fade in while entering and out while leaving, driven by painted offset rather than logical page changes. Both buffer halves remain fully opaque; no duplicated sheets or hard swaps.
- Track follows its target with a critically damped spring (ω = 8): gentler start, no overshoot, velocity kept on retarget. Reduced motion disables travel easing and page fades, including when toggled mid-turn.
- The seam between two leaves shows a dotted rule and the next page number only while moving or buffering.
- Without uploaded audio, show only the listening option and manual page controls; no timed demo, preview, or progress slider.
- Original PDF/image musical progress is not a visual row coordinate; microphone mode holds whole pages until the next matched page. Reflow uses proven engraver system geometry to protect the current staff.
- Uploaded audio starts a half-page overlap 4 seconds before the matched boundary, holds both halves until 2 seconds after it, then completes the move. Approach and departure each take up to 1.1 seconds using quintic easing and the same spring.
- Lead is limited to 40% of the preceding page duration; hold and departure to 25% and 15% of the next page duration. Short-page buffers never overlap.
- Visual overlap does not change the logical audio page or alignment. Both visible pages remain accessible after the logical page changes.
- Audio cursor uses geometry of the selected layout joined to matched note times. It interpolates horizontally only within a known system; row/page changes await the next onset and fade in without diagonal travel.
- Cursor top and height remain fixed across every onset in the same page/system, spanning the whole staff group even when only one staff starts a note. Saved per-onset bounds are normalized from valid coordinates; missing/invalid cursors stay absent.
- Cursor staff visibility constrains the buffer offset; unusually tall systems may reduce the next-page preview. Intro/outro silence and missing geometry show no cursor.

## Controls
- Reflow / original selector above the stage; generated XML/demo imports call their preserved view “导入版”. Selection persists per library record.
- Reflow groups complete systems by available width, at most 3 per desktop page and 2 on narrow screens. Credits stay outside the moving track.
- A view or width change maps by stable musical events and keeps the existing media clock. An unavailable or incomplete layout leaves the original visible with a reason.
- Legacy PDF/image records can request local parsing, with progress and cancellation; successful replacement resumes the prior reading position and media time.
- Without audio: listening toggle and previous/next page. Do not automatically request microphone access.
- With audio: playback, actual audio progress, cursor, buffer setting and near-boundary preview.
- Space toggles uploaded audio only when not editing fields; arrows and PageUp / PageDown navigate pages.
- Drag or swipe the score: ≥16% of a page (after 0.16 s velocity projection) turns, less springs back; ends rubber-band.
- Holding the score pauses uploaded audio and resumes on release. Wheel turns one page per gesture, ignoring inertia.
- End stops without wrapping. One-page document disables next/buffer controls.
- Public props: document: ScoreDocument, onUpload: () => void, onReset: () => void.
- Optional active prop pauses and releases microphone when the separate library page is shown.
- Uploaded audio uses actual media currentTime, a seconds timeline, matched page markers, page-to-audio seeks and replay.
- Cursor toggle is available when reliable event geometry exists. Coordinates resize with the page; reduced motion suppresses cursor fade. No microphone cursor yet.
- Audio buffer lead is off / 2 / 4 / 6 seconds, persisted locally. Page buttons bypass the incoming buffer; timeline seeks restore it. Buffer preview pauses and seeks real audio.
- Optional onAttachAudio opens paired import; inactive route, upload dialog, hidden tab and unmount pause audio.
- Listening is available only with ScoreDocument.reference; otherwise disable it and show a short unavailable state. Silence and uncertain input hold position.
- ScoreDocument and ScorePage types are in src/types.ts.
- Parent imports default ScoreReader; expose all styling in ScoreReader.css.

## QA
- Import without audio; local OMR success and unavailable structure; old records; cancellation and switching documents during preparation.
- Switch original/reflow while paused and playing, resize across page counts, reload library data, and preserve real note/cursor time without resetting playback.
- Continuous offset at page boundary; manual previous/next; pause/resume; final page.
- Mobile width without horizontal overflow; buttons labeled; range input labeled.
- Check before/after-boundary overlap, stable scale, backward seeks, pause, manual page navigation, persisted lead and reduced motion on desktop/mobile.
- Sample actual frames for continuous opacity, no blank viewport, and fully opaque buffered pages; verify reduced motion can stop an in-progress turn.
- Check cursor at real note anchors, forward/backward seek, pause, row/page boundary, old rendered SVG hydration, and absent coordinates without guessed markers.
