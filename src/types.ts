import type { ScoreReference } from './lib/score-following/types';
import type { StructuredScore } from './lib/notation';
export interface ScorePage { id: string; src: string; width: number; height: number; }
export interface ScoreDocument {
  name: string;
  /** Immutable imported pages, retained independently from our reading layout. */
  pages: ScorePage[];
  kind: 'demo' | 'pdf' | 'image' | 'musicxml';
  reference?: ScoreReference;
  audio?: ScoreAudio;
  notation?: StructuredScore;
  notationError?: string;
  originals?: Array<{ name: string; type: string; blob: Blob }>;
}

export interface AudioAlignment {
  points: Array<{ time: number; position: number }>;
  /** Acoustic anchors survive pagination changes. points is the original-page projection. */
  anchors?: Array<{ eventId: string; beat: number; time: number }>;
  confidence: number;
  pageConfidence: number[];
  coverage: number;
  method: 'chroma-dtw' | 'midi-notes';
  duration: number;
  activeStart: number;
  activeEnd: number;
}
export interface ScoreAudio {
  name: string;
  /** Playable recording or locally rendered MIDI WAV. */
  blob: Blob;
  duration: number;
  alignment: AudioAlignment;
  kind?: 'midi';
  /** Preserve the uploaded MIDI alongside its playable rendering. */
  originalBlob?: Blob;
}
