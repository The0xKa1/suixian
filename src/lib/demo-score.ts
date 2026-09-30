import type { ScoreDocument, ScorePage } from '../types';
import { createNotation } from './notation.ts';

const PAPER = '#f9f7f3';
type Fingering = [string: number, fret: number];
interface Bar { chord: string; notes: Fingering[] }

// An original, playable C-major arpeggio study. String 1 is the high E string.
const bars: Bar[] = [
  { chord: 'C', notes: [[5, 3], [3, 0], [2, 1], [1, 0], [4, 2], [3, 0], [2, 1], [1, 3]] },
  { chord: 'Am', notes: [[5, 0], [3, 2], [2, 1], [1, 0], [4, 2], [3, 2], [2, 1], [1, 0]] },
  { chord: 'Fmaj7', notes: [[4, 3], [3, 2], [2, 1], [1, 0], [4, 3], [3, 2], [2, 1], [1, 1]] },
  { chord: 'G', notes: [[6, 3], [3, 0], [2, 0], [1, 3], [4, 0], [3, 0], [2, 0], [1, 1]] },
  { chord: 'C', notes: [[5, 3], [3, 0], [2, 1], [1, 0], [4, 2], [3, 0], [1, 3], [2, 1]] },
  { chord: 'Em', notes: [[6, 0], [4, 2], [3, 0], [2, 0], [5, 2], [3, 0], [1, 0], [2, 0]] },
  { chord: 'Dm', notes: [[4, 0], [3, 2], [2, 3], [1, 1], [4, 0], [3, 2], [2, 3], [1, 0]] },
  { chord: 'G', notes: [[6, 3], [4, 0], [3, 0], [2, 0], [5, 2], [3, 0], [1, 3], [2, 0]] },
  { chord: 'Am', notes: [[5, 0], [3, 2], [2, 1], [1, 0], [4, 2], [2, 1], [1, 3], [2, 1]] },
  { chord: 'Em', notes: [[6, 0], [3, 0], [2, 0], [1, 0], [5, 2], [3, 0], [2, 0], [1, 3]] },
  { chord: 'Fmaj7', notes: [[4, 3], [3, 2], [2, 1], [1, 0], [4, 3], [2, 1], [1, 1], [2, 1]] },
  { chord: 'C', notes: [[5, 3], [3, 0], [2, 1], [1, 0], [4, 2], [3, 0], [2, 1], [1, 0]] },
  { chord: 'Dm', notes: [[4, 0], [3, 2], [2, 3], [1, 1], [4, 0], [2, 3], [1, 0], [3, 2]] },
  { chord: 'Am', notes: [[5, 0], [3, 2], [2, 1], [1, 0], [4, 2], [3, 2], [2, 1], [1, 3]] },
  { chord: 'Fmaj7', notes: [[4, 3], [3, 2], [2, 1], [1, 0], [4, 3], [3, 2], [2, 1], [1, 1]] },
  { chord: 'G', notes: [[6, 3], [3, 0], [2, 0], [1, 3], [4, 0], [3, 0], [2, 0], [1, 1]] },
  { chord: 'C', notes: [[5, 3], [3, 0], [2, 1], [1, 0], [4, 2], [2, 1], [1, 3], [2, 1]] },
  { chord: 'Am', notes: [[5, 0], [3, 2], [2, 1], [1, 0], [4, 2], [3, 2], [2, 1], [1, 0]] },
  { chord: 'Fmaj7', notes: [[4, 3], [3, 2], [2, 1], [1, 0], [4, 3], [3, 2], [1, 1], [2, 1]] },
  { chord: 'G', notes: [[6, 3], [3, 0], [2, 0], [1, 3], [4, 0], [3, 0], [1, 1], [2, 0]] },
  { chord: 'Em', notes: [[6, 0], [3, 0], [2, 0], [1, 0], [5, 2], [3, 0], [2, 0], [1, 3]] },
  { chord: 'Am', notes: [[5, 0], [3, 2], [2, 1], [1, 0], [4, 2], [3, 2], [2, 1], [1, 0]] },
  { chord: 'G', notes: [[6, 3], [3, 0], [2, 0], [1, 3], [4, 0], [3, 0], [2, 0], [1, 1]] },
  { chord: 'C', notes: [[5, 3], [3, 0], [2, 1], [1, 0], [4, 2], [3, 0], [2, 1], [1, 0]] },
];

function system(row: number, page: number): string {
  const y = 156 + row * 108;
  const left = 86;
  const middle = 476;
  const right = 866;
  const strings = Array.from({ length: 6 }, (_, string) => `<line x1="${left}" x2="${right}" y1="${y + string * 10}" y2="${y + string * 10}"/>`).join('');
  const barlines = [left, middle, right].map((x) => `<line x1="${x}" x2="${x}" y1="${y}" y2="${y + 50}"/>`).join('');
  const notation = [0, 1].map((column) => {
    const barIndex = page * 8 + row * 2 + column;
    const bar = bars[barIndex];
    const x = left + column * 390;
    const notes = bar.notes.map(([string, fret], beat) => {
      const nx = x + 36 + beat * 45;
      const ny = y + (string - 1) * 10;
      return `<rect x="${nx - 8}" y="${ny - 8}" width="16" height="16" fill="${PAPER}"/><text x="${nx}" y="${ny + 5}" text-anchor="middle" font-size="15" font-family="'Courier New',monospace">${fret}</text>`;
    }).join('');
    const rhythm = Array.from({ length: 8 }, (_, beat) => {
      const nx = x + 36 + beat * 45;
      return `<line x1="${nx}" x2="${nx}" y1="${y + 62}" y2="${y + 72}"/>`;
    }).join('');
    const beams = [0, 1].map((group) => `<line x1="${x + 36 + group * 180}" x2="${x + 171 + group * 180}" y1="${y + 72}" y2="${y + 72}" stroke-width="2"/>`).join('');
    return `<text x="${x + 7}" y="${y - 20}" font-size="10" fill="#777970" letter-spacing="1">${String(barIndex + 1).padStart(2, '0')}</text><text x="${x + 36}" y="${y - 19}" font-size="17" font-weight="500">${bar.chord}</text>${notes}<g stroke="#63665c" stroke-width="0.8">${rhythm}${beams}</g>`;
  }).join('');
  const tab = `<text x="61" y="${y + 10}" font-size="12" font-weight="600" text-anchor="middle"><tspan x="61">T</tspan><tspan x="61" dy="17">A</tspan><tspan x="61" dy="17">B</tspan></text>`;
  const ending = page === 2 && row === 3 ? `<line x1="861" x2="861" y1="${y}" y2="${y + 50}" stroke="#23251f" stroke-width="1"/><line x1="867" x2="867" y1="${y}" y2="${y + 50}" stroke="#23251f" stroke-width="3"/>` : '';
  return `<g stroke="#77796f" stroke-width="0.65">${strings}${barlines}</g>${tab}${notation}${ending}`;
}

function demoPage(page: number): ScorePage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="920" height="620" viewBox="0 0 920 620"><rect width="920" height="620" fill="${PAPER}"/><g fill="#23251f" font-family="Arial,'PingFang SC','Microsoft YaHei',sans-serif"><text x="460" y="47" text-anchor="middle" font-size="26" font-weight="500" letter-spacing="5">晚风练习曲</text><text x="460" y="69" text-anchor="middle" font-size="10" fill="#828578" letter-spacing="1.5">Original study · Fingerstyle</text><text x="55" y="112" font-size="12">C / 4/4</text><text x="150" y="112" font-size="12">♩ = 72</text><text x="866" y="112" text-anchor="end" font-size="11" fill="#777970">Standard tuning · E A D G B E</text>${Array.from({ length: 4 }, (_, row) => system(row, page)).join('')}<text x="55" y="591" font-size="10" fill="#92958a" letter-spacing="2">SUIXIAN</text><text x="866" y="591" text-anchor="end" font-size="11" fill="#777970">${page + 1} / 3</text></g></svg>`;
  return { id: `demo-${page + 1}`, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width: 920, height: 620 };
}

export function createDemoScore(): ScoreDocument {
  const tuning = [64, 59, 55, 50, 45, 40];
  const events = bars.flatMap((bar, barIndex) => bar.notes.map(([string, fret], noteIndex) => ({
    id: `event-${barIndex * 8 + noteIndex}`,
    midi: [tuning[string - 1] + fret],
    beat: barIndex * 4 + noteIndex * .5,
    durationBeats: .5,
    position: Math.floor(barIndex / 8) + ((barIndex % 8) * 8 + noteIndex + .5) / 64,
    cursor: {
      x: (122 + (barIndex % 2) * 390 + noteIndex * 45) / 920,
      y: (146 + Math.floor((barIndex % 8) / 2) * 108) / 620,
      height: 70 / 620,
      system: Math.floor((barIndex % 8) / 2),
    },
  })));
  const notation = typeof DOMParser === 'undefined' ? undefined : createNotation([{
    id: 'source-1', originalPage: 0, startBeat: 0, durationBeats: bars.length * 4,
    xml: demoMusicXml(tuning),
  }]);
  return { name: '晚风练习曲', kind: 'demo', pages: [0, 1, 2].map(demoPage), reference: { events, initialTempo: 72 }, notation };
}

/** The demo's actual fingering and rhythm, independent of its original SVG layout. */
function demoMusicXml(tuning: number[]): string {
  const steps = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
  const sharp = new Set([1, 3, 6, 8, 10]);
  const measures = bars.map((bar, index) => {
    const chordRoot = bar.chord[0], suffix = bar.chord.slice(1);
    const kind = suffix === 'm' ? 'minor' : suffix === 'maj7' ? 'major-seventh' : 'major';
    const notes = bar.notes.map(([string, fret]) => {
      const midi = tuning[string - 1] + fret;
      return `<note><pitch><step>${steps[midi % 12]}</step>${sharp.has(midi % 12) ? '<alter>1</alter>' : ''}<octave>${Math.floor(midi / 12) - 1}</octave></pitch><duration>1</duration><voice>1</voice><type>eighth</type><notations><technical><string>${string}</string><fret>${fret}</fret></technical></notations></note>`;
    }).join('');
    const attributes = index ? '' : '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>TAB</sign><line>5</line></clef><staff-details><staff-lines>6</staff-lines></staff-details></attributes><direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>72</per-minute></metronome></direction-type><sound tempo="72"/></direction>';
    return `<measure number="${index + 1}">${attributes}<harmony><root><root-step>${chordRoot}</root-step></root><kind>${kind}</kind></harmony>${notes}</measure>`;
  }).join('');
  return `<score-partwise version="4.0"><work><work-title>晚风练习曲</work-title></work><part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list><part id="P1">${measures}</part></score-partwise>`;
}
