import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { ScoreDocument, ScorePage } from '../types';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Vite emits these assets locally; score bytes never leave the browser.
const pdfAssets = import.meta.glob<string>([
  '/node_modules/pdfjs-dist/cmaps/*.bcmap',
  '/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}',
  '/node_modules/pdfjs-dist/wasm/*.{wasm,js}',
], { query: '?url', import: 'default', eager: true });

const assetFolders: Record<string, string> = {
  cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm',
};

class LocalPdfAssets {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const url = pdfAssets[`/node_modules/pdfjs-dist/${assetFolders[kind]}/${filename}`];
    if (!url) throw new Error('PDF 字体资源无法读取。');
    const response = await fetch(url);
    if (!response.ok) throw new Error('PDF 字体资源无法读取。');
    return new Uint8Array(await response.arrayBuffer());
  }
}

const MAX_BYTES = 30 * 1024 * 1024;
const MAX_PAGES = 20;
const MAX_SOURCE_PIXELS = 40_000_000;
const MAX_RENDER_PIXELS = 2_400_000;
const MAX_RENDER_EDGE = 2200;

class ScoreImportError extends Error {}

function fail(message: string): never { throw new ScoreImportError(message); }

function pageSize(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    fail('谱面尺寸无法读取，请换一个文件。');
  }
  const scale = Math.min(1, MAX_RENDER_EDGE / Math.max(width, height), Math.sqrt(MAX_RENDER_PIXELS / (width * height)));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function makeCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) fail('浏览器无法绘制谱面，请换一个浏览器。');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  return { canvas, context };
}

function capturePage(canvas: HTMLCanvasElement, index: number): ScorePage {
  const src = canvas.toDataURL('image/webp', 0.94);
  if (src === 'data:,') fail('谱面尺寸过大，无法绘制。');
  return { id: `page-${index + 1}`, src, width: canvas.width, height: canvas.height };
}

function title(file: File) { return file.name.replace(/\.[^.]+$/, '') || '我的谱子'; }

async function importPdf(file: File): Promise<ScoreDocument> {
  const loading = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    BinaryDataFactory: LocalPdfAssets,
    useWorkerFetch: false,
    cMapPacked: true,
    useSystemFonts: true,
    stopAtErrors: true,
    canvasMaxAreaInBytes: MAX_RENDER_PIXELS * 4,
    enableXfa: false,
  });
  // Reject encrypted files immediately instead of leaving a pending password prompt.
  loading.onPassword = (updatePassword: (password: string | Error) => void) => updatePassword(new Error('PasswordException'));
  try {
    const pdf = await loading.promise;
    if (pdf.numPages > MAX_PAGES) fail('谱子最多支持 20 页，请拆分后上传。');
    if (pdf.numPages < 1) fail('这份 PDF 没有可显示的谱面。');
    const pages: ScorePage[] = [];
    for (let index = 0; index < pdf.numPages; index += 1) {
      const page = await pdf.getPage(index + 1);
      let canvas: HTMLCanvasElement | undefined;
      try {
        const original = page.getViewport({ scale: 2 });
        const size = pageSize(original.width, original.height);
        const viewport = page.getViewport({ scale: 2 * Math.min(size.width / original.width, size.height / original.height) });
        const output = makeCanvas(size.width, size.height);
        canvas = output.canvas;
        await page.render({ canvas, canvasContext: output.context, viewport, background: '#ffffff' }).promise;
        pages.push(capturePage(canvas, index));
      } finally {
        page.cleanup();
        if (canvas) { canvas.width = 0; canvas.height = 0; }
      }
    }
    return { name: title(file), kind: 'pdf', pages };
  } catch (error) {
    if (error instanceof ScoreImportError) throw error;
    const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
    if (/password|encrypt/i.test(message)) fail('请先移除 PDF 密码，再上传。');
    fail('这份 PDF 无法读取，请检查文件是否完整。');
  } finally {
    await loading.destroy();
  }
}

// Read dimensions before decoding, so an unusually large compressed image is rejected early.
function imageDimensions(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const textAt = (at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
  if (bytes.length >= 24 && bytes[0] === 0x89 && textAt(1, 3) === 'PNG' && textAt(12, 4) === 'IHDR') {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 7) {
        return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      }
      offset += length;
    }
  }
  if (bytes.length >= 30 && textAt(0, 4) === 'RIFF' && textAt(8, 4) === 'WEBP') {
    const kind = textAt(12, 4);
    if (kind === 'VP8X') {
      if (bytes[20] & 0x02) fail('请上传静态图片，暂不支持动画 WebP。');
      return { width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16) };
    }
    if (kind === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    if (kind === 'VP8L' && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
  }
  fail('图片无法读取，请使用完整的 JPG、PNG 或 WebP 文件。');
}

async function importImage(file: File, index: number): Promise<ScorePage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const dimensions = imageDimensions(bytes);
  if (Math.max(dimensions.width, dimensions.height) > 30_000 || dimensions.width * dimensions.height > MAX_SOURCE_PIXELS) {
    fail('图片尺寸过大，请先缩小图片。');
  }
  pageSize(dimensions.width, dimensions.height);
  const url = URL.createObjectURL(file);
  const image = new Image();
  let canvas: HTMLCanvasElement | undefined;
  try {
    image.src = url;
    await image.decode();
    // Natural size respects EXIF rotation; use it for the final aspect ratio.
    const actualSize = pageSize(image.naturalWidth, image.naturalHeight);
    const output = makeCanvas(actualSize.width, actualSize.height);
    canvas = output.canvas;
    output.context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return capturePage(canvas, index);
  } catch (error) {
    if (error instanceof ScoreImportError) throw error;
    throw new ScoreImportError(`“${file.name}”无法读取，请换一张图片。`);
  } finally {
    image.removeAttribute('src');
    URL.revokeObjectURL(url);
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

export async function importScore(files: File[]): Promise<ScoreDocument> {
  if (!files.length) fail('请选择一份谱子。');
  if (files.some((file) => file.size === 0)) fail('文件为空，请重新选择。');
  if (files.reduce((total, file) => total + file.size, 0) > MAX_BYTES) fail('文件总大小不能超过 30 MB。');
  const xmls = files.filter(file => /\.(musicxml|xml)$/i.test(file.name) || ['application/vnd.recordare.musicxml+xml','application/xml','text/xml'].includes(file.type));
  if (xmls.length) {
    if (files.length !== 1) fail('一次上传一份 MusicXML。');
    const { importMusicXml } = await import('./score-import/musicxml');
    return importMusicXml(await xmls[0].text(), xmls[0].name);
  }
  const pdfs = files.filter((file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name));
  if (pdfs.length) {
    if (files.length !== 1) fail('一次上传一份 PDF，或按页选择多张图片。');
    return importPdf(pdfs[0]);
  }
  if (files.length > MAX_PAGES) fail('谱子最多支持 20 页，请减少图片数量。');
  if (files.some((file) => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) && !/\.(jpe?g|png|webp)$/i.test(file.name))) {
    fail('支持 PDF、图片和 MusicXML 文件。');
  }
  const pages: ScorePage[] = [];
  for (let index = 0; index < files.length; index += 1) pages.push(await importImage(files[index], index));
  return { name: title(files[0]), kind: 'image', pages };
}
