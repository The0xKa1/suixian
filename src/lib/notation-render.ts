import type { GraphicalNote, MusicSystem, OpenSheetMusicDisplay, VexFlowGraphicalNote, VexFlowVoiceEntry } from 'opensheetmusicdisplay';
import type { ScorePage } from '../types';
import type { ScoreReference } from './score-following/types';
import type { NotationSource, StructuredScore } from './notation';
import { notationRenderDocument } from './notation';
import { mapNotationReference } from './notation-layout';
import type { NotationEventLocation, NotationMeasureLocation } from './notation-layout';

export interface NotationRenderOptions { width?: number; rowsPerPage?: number; signal?: AbortSignal; }
export interface NotationRenderResult { pages: ScorePage[]; reference: ScoreReference; }

interface RenderedRow {
  svg: SVGSVGElement;
  top: number;
  bottom: number;
  notes: Array<{ beat: number; midi: number[]; x: number; y: number; height: number }>;
  measures: Array<{ startBeat: number; durationBeats: number }>;
}

const PIXELS_PER_UNIT = 10;
const PAGE_PADDING = 22;
const ROW_GAP = 18;
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('导入已取消。', 'AbortError'); };

function systemBounds(system: MusicSystem): { top: number; bottom: number } {
  const box = system.PositionAndShape;
  let top = box.AbsolutePosition.y + Math.min(box.BorderTop, box.BorderMarginTop);
  let bottom = box.AbsolutePosition.y + Math.max(box.BorderBottom, box.BorderMarginBottom);
  for (const staff of system.StaffLines) {
    const y = staff.PositionAndShape.AbsolutePosition.y;
    const sky = staff.SkyLine.filter(Number.isFinite);
    const floor = staff.BottomLine.filter(Number.isFinite);
    top = Math.min(top, y + (sky.length ? Math.min(...sky) : 0));
    bottom = Math.max(bottom, y + (floor.length ? Math.max(...floor) : staff.StaffHeight));
  }
  return { top: top * PIXELS_PER_UNIT, bottom: bottom * PIXELS_PER_UNIT };
}

function noteX(note: GraphicalNote, svg: SVGSVGElement): number | undefined {
  // The rendered notehead/fret has the final VexFlow chord offsets and clef spacing.
  const graphical = note as VexFlowGraphicalNote;
  const voice = note.parentVoiceEntry as VexFlowVoiceEntry;
  const id = voice.vfStaveNote?.getAttribute('id') as string | undefined;
  // The bundled VexFlow TAB backend keeps the generated id but not its optional `el` handle.
  const group = (voice.vfStaveNote?.getAttribute('el') as SVGGraphicsElement | undefined)
    ?? (id ? svg.querySelector<SVGGraphicsElement>(`[id="${CSS.escape(`vf-${id}`)}"]`) : undefined);
  const head = graphical.getNoteheadSVGs?.()?.[0] ?? graphical.getSVGGElement?.()
    ?? group?.querySelector('.vf-notehead') ?? group?.querySelector('text') ?? group;
  if (!head?.isConnected) return undefined;
  const rect = head.getBoundingClientRect();
  const page = svg.getBoundingClientRect();
  if (rect.width <= 0 || page.width <= 0) return undefined;
  return rect.left + rect.width / 2 - page.left;
}

function collectRows(osmd: OpenSheetMusicDisplay, host: HTMLElement, notation: StructuredScore, source: NotationSource): RenderedRow[] {
  const svgs = [...host.querySelectorAll<SVGSVGElement>('svg')];
  const rows: RenderedRow[] = [];
  const sourceMeasures = notation.measures.filter(measure => measure.sourceId === source.id);
  const indexed = new Map(sourceMeasures.map(measure => [measure.index, measure]));
  for (const [pageIndex, page] of osmd.GraphicSheet.MusicPages.entries()) {
    const svg = svgs[pageIndex];
    if (!svg) throw new Error('无法生成谱面图形。');
    const bounds = page.MusicSystems.map(systemBounds);
    for (const [systemIndex, system] of page.MusicSystems.entries()) {
      const own = bounds[systemIndex];
      const previous = bounds[systemIndex - 1];
      const next = bounds[systemIndex + 1];
      const top = Math.max(0, own.top - (previous ? Math.max(0, Math.min(16, (own.top - previous.bottom) / 2)) : 16));
      const bottom = own.bottom + (next ? Math.max(0, Math.min(16, (next.top - own.bottom) / 2)) : 16);
      if (!Number.isFinite(top + bottom) || bottom <= top) throw new Error('排版器没有返回有效谱行。');
      const row: RenderedRow = { svg, top, bottom, notes: [], measures: [] };
      // A playback marker spans the whole system, including staves that only
      // sustain notes or rest at this onset. Its height must not follow chord size.
      const staffTop = Math.max(top, Math.min(...system.StaffLines.map(staff =>
        staff.PositionAndShape.AbsolutePosition.y * PIXELS_PER_UNIT - 8)));
      const staffBottom = Math.min(bottom, Math.max(...system.StaffLines.map(staff =>
        (staff.PositionAndShape.AbsolutePosition.y + staff.StaffHeight) * PIXELS_PER_UNIT + 8)));
      const measureIndices = new Set<number>();
      for (const staff of system.StaffLines) {
        for (const measure of staff.Measures) {
          if (measure.IsExtraGraphicalMeasure) continue;
          const index = measure.parentSourceMeasure.measureListIndex;
          const semantic = indexed.get(index);
          if (!semantic) throw new Error('排版器小节与乐谱内容不一致。');
          if (!measureIndices.has(index)) {
            row.measures.push({ startBeat: semantic.startBeat, durationBeats: semantic.durationBeats });
            measureIndices.add(index);
          }
          for (const entry of measure.staffEntries) {
            const notes = entry.graphicalVoiceEntries.flatMap(voice => voice.notes)
              .filter(note => !note.sourceNote.isRest() && !note.sourceNote.IsGraceNote && note.sourceNote.PrintObject);
            if (!notes.length) continue;
            const candidates = notes.map(note => noteX(note, svg)).filter((x): x is number => x !== undefined);
            // OSMD may catch a drawing error and still return a partial SVG. Never publish
            // an apparently successful score with a whole sounding entry missing.
            if (!candidates.length) throw new Error('部分音符未能完整排版，请使用原件。');
            // OSMD's pitch numbering starts at C0; MIDI starts one octave lower (C-1).
            const midi = [...new Set(notes.filter(note => !!note.sourceNote.Pitch).map(note => note.sourceNote.Pitch.getHalfTone() + 12))];
            row.notes.push({ beat: semantic.startBeat + entry.relInMeasureTimestamp.RealValue * 4, midi,
              x: Math.min(...candidates), y: staffTop, height: staffBottom - staffTop });
          }
        }
      }
      rows.push(row);
    }
  }
  const placedNotes = rows.flatMap(row => row.notes);
  const expectedNotes = notation.notes.filter(note => note.sourceId === source.id && note.visible !== false && !note.rest && !note.grace && note.midi !== undefined);
  if (expectedNotes.some(note => !placedNotes.some(placed => Math.abs(placed.beat - note.beat) < 0.00001 && placed.midi.includes(note.midi!)))) {
    throw new Error('部分小节未能完整排版，请使用原件。');
  }
  return rows;
}

/** Engrave complete MusicXML locally and pack whole systems into equal-height reader pages. */
export async function renderNotation(notation: StructuredScore, originalReference: ScoreReference, options: NotationRenderOptions = {}): Promise<NotationRenderResult> {
  checkAbort(options.signal);
  if (notation.version !== 1 || !notation.sources.length) throw new Error('不支持这份结构化谱面。');
  const width = Math.round(Math.max(480, Math.min(1200, options.width ?? 920)));
  const rowsPerPage = Math.round(Math.max(1, Math.min(4, options.rowsPerPage ?? 3)));
  const { OpenSheetMusicDisplay: Engraver } = await import('opensheetmusicdisplay');
  checkAbort(options.signal);
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${width}px;opacity:0;pointer-events:none;z-index:-1;contain:layout style;`;
  document.body.append(host);
  const renderers: OpenSheetMusicDisplay[] = [];
  const rows: RenderedRow[] = [];
  try {
    for (const source of notation.sources) {
      checkAbort(options.signal);
      const container = document.createElement('div');
      container.style.width = `${width}px`;
      host.append(container);
      const osmd = new Engraver(container, {
        backend: 'svg', autoResize: false, pageFormat: 'Endless', drawCredits: false,
        drawTitle: false, drawSubtitle: false, drawComposer: false, drawLyricist: false,
        drawPartNames: false, drawPartAbbreviations: false, disableCursor: true,
        drawMeasureNumbers: true, drawMeasureNumbersOnlyAtSystemStart: true,
        newSystemFromXML: false, newSystemFromNewPageInXML: false, newPageFromXML: false,
        autoGenerateMultipleRestMeasuresFromRestMeasures: false,
        defaultColorMusic: '#282b28', defaultFontFamily: 'Times New Roman',
      });
      renderers.push(osmd);
      osmd.EngravingRules.RenderCopyright = false;
      osmd.EngravingRules.TabTimeSignatureRendered = true;
      osmd.EngravingRules.PageLeftMargin = 2.2;
      osmd.EngravingRules.PageRightMargin = 2.2;
      // OSMD treats a string without an XML declaration as a URL; hand it the parsed document.
      await osmd.load(notationRenderDocument(source.xml));
      checkAbort(options.signal);
      osmd.render();
      rows.push(...collectRows(osmd, container, notation, source));
    }
    if (!rows.length) throw new Error('乐谱中没有可排版的谱行。');
    const chunks = Array.from({ length: Math.ceil(rows.length / rowsPerPage) }, (_, page) => rows.slice(page * rowsPerPage, (page + 1) * rowsPerPage));
    const pageHeight = Math.ceil(Math.max(...chunks.map(chunk => PAGE_PADDING * 2 + chunk.reduce((sum, row) => sum + row.bottom - row.top, 0) + (chunk.length - 1) * ROW_GAP)));
    const locations: NotationEventLocation[] = [];
    const measures: NotationMeasureLocation[] = [];
    const serializer = new XMLSerializer();
    const pages = chunks.map((chunk, page): ScorePage => {
      let y = PAGE_PADDING;
      const fragments = chunk.map((row, system) => {
        const height = row.bottom - row.top;
        const crop = row.svg.cloneNode(true) as SVGSVGElement;
        crop.setAttribute('x', '0'); crop.setAttribute('y', String(y));
        crop.setAttribute('width', String(width)); crop.setAttribute('height', String(height));
        crop.setAttribute('viewBox', `0 ${row.top} ${width} ${height}`);
        crop.setAttribute('overflow', 'hidden'); crop.removeAttribute('style');
        for (const note of row.notes) locations.push({ ...note, page, system, x: note.x / width, y: (y + note.y - row.top) / pageHeight, height: note.height / pageHeight });
        for (const measure of row.measures) measures.push({ ...measure, page });
        y += height + ROW_GAP;
        return serializer.serializeToString(crop);
      });
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${pageHeight}" viewBox="0 0 ${width} ${pageHeight}"><rect width="100%" height="100%" fill="#f9f7f3"/>${fragments.join('')}</svg>`;
      return { id: `notation-${width}-${page}`, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width, height: pageHeight };
    });
    checkAbort(options.signal);
    return { pages, reference: mapNotationReference(originalReference, locations, measures) };
  } finally {
    for (const renderer of renderers) renderer.clear();
    host.remove();
  }
}
