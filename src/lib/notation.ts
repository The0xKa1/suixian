/** MusicXML remains the lossless musical source. Layout and annotations never replace it. */
export interface NotationSource {
  id: string;
  xml: string;
  originalPage: number;
  startBeat: number;
  durationBeats: number;
}

export interface NotationMeasure {
  id: string;
  sourceId: string;
  partId: string;
  index: number;
  number: string;
  startBeat: number;
  durationBeats: number;
  noteIds: string[];
}

export interface NotationNote {
  id: string;
  measureId: string;
  sourceId: string;
  partId: string;
  voice: string;
  staff: string;
  beat: number;
  durationBeats: number;
  midi?: number;
  rest: boolean;
  grace: boolean;
  visible: boolean;
  tieStart: boolean;
  tieStop: boolean;
  string?: number;
  fret?: number;
}

export interface NotationAnnotation {
  id: string;
  anchor: { kind: 'measure' | 'note'; id: string };
  text: string;
}

export interface StructuredScore {
  version: 1;
  sources: NotationSource[];
  measures: NotationMeasure[];
  notes: NotationNote[];
  annotations: NotationAnnotation[];
}

const STEPS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const elements = (node: Element, name?: string): Element[] => Array.from(node.childNodes)
  .filter((item): item is Element => item.nodeType === 1 && (!name || (item as Element).localName === name));
const first = (node: Element, name: string) => elements(node, name)[0];
const text = (node: Element, name: string) => first(node, name)?.textContent?.trim() ?? '';
const number = (node: Element, name: string, fallback: number) => text(node, name) === '' ? fallback : Number(text(node, name));
const finite = (value: number, min = 0, max = 1_000_000) => Number.isFinite(value) && value >= min && value <= max;

/** Compatibility for older exports with a playback-only direction but no required direction-type.
 * Work on a fresh display document; the persistent musical source is not changed.
 */
export function notationRenderDocument(sourceXml: string): Document {
  const document = new DOMParser().parseFromString(sourceXml, 'application/xml');
  for (const direction of Array.from(document.getElementsByTagNameNS('*', 'direction'))) {
    if (first(direction, 'direction-type')) continue;
    const sound = first(direction, 'sound');
    if (!sound) continue;
    const type = document.createElementNS(direction.namespaceURI, 'direction-type');
    const tempo = Number(sound.getAttribute('tempo'));
    if (sound.hasAttribute('tempo') && finite(tempo, 1, 1000)) {
      const metronome = document.createElementNS(direction.namespaceURI, 'metronome');
      const unit = document.createElementNS(direction.namespaceURI, 'beat-unit');
      unit.textContent = 'quarter';
      const perMinute = document.createElementNS(direction.namespaceURI, 'per-minute');
      perMinute.textContent = String(tempo);
      metronome.appendChild(unit);
      metronome.appendChild(perMinute);
      type.appendChild(metronome);
    } else {
      const words = document.createElementNS(direction.namespaceURI, 'words');
      words.setAttribute('print-object', 'no');
      type.appendChild(words);
    }
    direction.insertBefore(type, sound);
  }
  return document;
}

/** A persistent semantic index. IDs are written to XML so later edits can retain their anchors. */
export function createNotation(input: readonly NotationSource[]): StructuredScore {
  if (!input.length || input.length > 20) throw new Error('结构化谱面需要 1 至 20 份 MusicXML。');
  const score: StructuredScore = { version: 1, sources: [], measures: [], notes: [], annotations: [] };
  const sourceIds = new Set<string>();
  const allIds = new Set<string>();
  for (const source of input) {
    if (!source.id || sourceIds.has(source.id) || !Number.isInteger(source.originalPage) || source.originalPage < 0
      || !finite(source.startBeat) || !finite(source.durationBeats, 0.000001)
      || !source.xml || source.xml.length > 15_000_000 || /<!ENTITY/i.test(source.xml)) {
      throw new Error('结构化谱面数据无效。');
    }
    sourceIds.add(source.id);
    const xml = new DOMParser().parseFromString(source.xml, 'application/xml');
    if (xml.getElementsByTagName('parsererror').length || xml.documentElement?.localName !== 'score-partwise') {
      throw new Error('无法读取结构化 MusicXML。');
    }
    const root = xml.documentElement;
    const parts = elements(root, 'part');
    if (!parts.length || parts.length > 12) throw new Error('结构化谱面声部数量无效。');
    const count = elements(parts[0], 'measure').length;
    if (!count || count > 800 || parts.some(part => elements(part, 'measure').length !== count)) {
      throw new Error('结构化谱面的声部小节不一致。');
    }
    const lengths = new Array<number>(count).fill(0);
    const sourceMeasures: NotationMeasure[] = [];
    const sourceNotes: NotationNote[] = [];
    const assignId = (node: Element, fallback: string) => {
      // XML IDs are source-local; our stored identifiers include their source namespace.
      const local = node.getAttribute('id') || fallback;
      const id = `${source.id}/${local}`;
      if (allIds.has(id)) throw new Error('结构化谱面包含重复标识。');
      allIds.add(id);
      node.setAttribute('id', local);
      return id;
    };
    for (const [partIndex, part] of parts.entries()) {
      const partId = part.getAttribute('id') || `part-${partIndex}`;
      let divisions = 1, meter = 4;
      for (const [index, measure] of elements(part, 'measure').entries()) {
        const id = assignId(measure, `sx-p${partIndex}-m${index}`);
        const model: NotationMeasure = { id, sourceId: source.id, partId, index, number: measure.getAttribute('number') || String(index + 1), startBeat: 0, durationBeats: 0, noteIds: [] };
        let cursor = 0, lastOnset = 0, extent = 0, noteIndex = 0;
        for (const node of elements(measure)) {
          if (node.localName === 'attributes') {
            divisions = number(node, 'divisions', divisions);
            if (!finite(divisions, 0.000001)) throw new Error('结构化谱面节拍单位无效。');
            const time = first(node, 'time');
            if (time && !first(time, 'senza-misura')) {
              const beats = text(time, 'beats').split('+').map(Number);
              const unit = number(time, 'beat-type', 4);
              meter = beats.reduce((sum, value) => sum + value, 0) * 4 / unit;
              if (!finite(meter, 0.000001, 128)) throw new Error('结构化谱面拍号无效。');
            }
          } else if (node.localName === 'backup' || node.localName === 'forward') {
            const duration = number(node, 'duration', NaN) / divisions;
            if (!finite(duration, 0, 128)) throw new Error('结构化谱面时值无效。');
            cursor += (node.localName === 'backup' ? -1 : 1) * duration;
            if (!finite(cursor, -0.001, 128)) throw new Error('结构化谱面声部时间无效。');
            cursor = Math.max(0, cursor);
            extent = Math.max(extent, cursor);
          } else if (node.localName === 'note') {
            const grace = !!first(node, 'grace');
            const duration = grace ? 0 : number(node, 'duration', NaN) / divisions;
            if (!finite(duration, grace ? 0 : 0.000001, 128)) throw new Error('结构化谱面音符缺失时值。');
            const chord = !!first(node, 'chord');
            const onset = chord ? lastOnset : cursor;
            if (!chord && !grace) { lastOnset = onset; cursor += duration; }
            extent = Math.max(extent, onset + duration);
            const pitch = first(node, 'pitch');
            const midi = pitch ? (number(pitch, 'octave', NaN) + 1) * 12 + STEPS[text(pitch, 'step')] + number(pitch, 'alter', 0) : undefined;
            if (midi !== undefined && !finite(midi, 0, 127)) throw new Error('结构化谱面音高无效。');
            const technical = first(first(node, 'notations') ?? node, 'technical');
            const note: NotationNote = {
              id: assignId(node, `sx-p${partIndex}-m${index}-n${noteIndex++}`), measureId: id, sourceId: source.id, partId,
              voice: text(node, 'voice') || '1', staff: text(node, 'staff') || '1', beat: onset,
              durationBeats: duration, midi, rest: !!first(node, 'rest'), grace, visible: node.getAttribute('print-object') !== 'no',
              tieStart: elements(node, 'tie').some(tie => tie.getAttribute('type') === 'start'),
              tieStop: elements(node, 'tie').some(tie => tie.getAttribute('type') === 'stop'),
            };
            if (technical && text(technical, 'string')) note.string = number(technical, 'string', NaN);
            if (technical && text(technical, 'fret')) note.fret = number(technical, 'fret', NaN);
            model.noteIds.push(note.id);
            sourceNotes.push(note);
          }
        }
        model.durationBeats = measure.getAttribute('implicit') === 'yes' ? extent : Math.max(extent, meter);
        if (!finite(model.durationBeats, 0.000001, 128)) throw new Error('结构化谱面小节时值无效。');
        lengths[index] = Math.max(lengths[index], model.durationBeats);
        sourceMeasures.push(model);
      }
    }
    let beat = source.startBeat;
    const starts = lengths.map(length => { const start = beat; beat += length; return start; });
    const measuresById = new Map(sourceMeasures.map(measure => [measure.id, measure]));
    for (const measure of sourceMeasures) { measure.startBeat = starts[measure.index]; measure.durationBeats = lengths[measure.index]; }
    for (const note of sourceNotes) note.beat += measuresById.get(note.measureId)!.startBeat;
    if (score.notes.length + sourceNotes.length > 40_000) throw new Error('结构化谱面过于复杂，请拆分后导入。');
    score.sources.push({ ...source, xml: new XMLSerializer().serializeToString(root) });
    score.measures.push(...sourceMeasures);
    score.notes.push(...sourceNotes);
  }
  return score;
}
