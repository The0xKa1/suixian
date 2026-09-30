/** Normalized coordinates on the original rendered page; system is zero-based per page. */
export interface ScoreCursor {
  x: number;
  y: number;
  height: number;
  system: number;
}

export interface ScoreEvent {
  /** Stable onset identity across original and reflowed layouts. */
  id?: string;
  /** MIDI pitches sounding at this onset. Rest-only events are omitted. */
  midi: number[];
  beat: number;
  durationBeats: number;
  /** Zero-based page plus fraction of that page, in reading order. */
  position: number;
  /** Only present when the renderer or recognizer supplies a real visual location. */
  cursor?: ScoreCursor;
}

export interface ScoreReference {
  events: ScoreEvent[];
  initialTempo?: number;
}

export interface AudioScoreFrame {
  timestampMs: number;
  chroma: readonly number[];
  rms: number;
  onset: boolean;
}

export type FollowingState = 'waiting' | 'tracking' | 'uncertain' | 'silent' | 'complete';

export interface FollowingResult {
  position: number;
  eventIndex: number;
  confidence: number;
  state: FollowingState;
}

export interface FollowerOptions {
  silenceRms?: number;
  minSimilarity?: number;
  confirmationFrames?: number;
  minEventMs?: number;
}
