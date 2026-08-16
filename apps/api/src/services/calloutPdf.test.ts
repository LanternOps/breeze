import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import PDFDocument from 'pdfkit';
import { PDFDocument as PdfLibDocument } from 'pdf-lib';
import { renderCalloutIntoPdf } from './calloutPdf';
import { registerThemeFonts } from './documentThemes';
import type { EnsureRoomRich } from './tablePdf';
import type { QuoteCalloutContent } from '@breeze/shared';

// Same inflate/decode/rect-extraction approach as tablePdf.test.ts — see that
// file's header comment for why these live locally rather than shared.

function inflatePdfStreams(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1');
  const headerRe = /\/Length\s+(\d+)[\s\S]{0,120}?\/Filter\s+\/FlateDecode[\s\S]{0,40}?stream\r?\n/g;
  const streams: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(raw))) {
    const length = Number(match[1]);
    const compressed = Buffer.from(raw.slice(headerRe.lastIndex, headerRe.lastIndex + length), 'latin1');
    try { streams.push(zlib.inflateSync(compressed).toString('latin1')); } catch { /* skip non-flate/corrupt streams */ }
  }
  return streams;
}

function decodeShowTextTokens(body: string): string {
  const tokenRe = /<([0-9a-fA-F]+)>|\(((?:[^()\\]|\\.)*)\)/g;
  let out = '';
  let tm: RegExpExecArray | null;
  while ((tm = tokenRe.exec(body))) {
    if (tm[1] !== undefined) {
      const hex = tm[1].length % 2 ? `${tm[1]}0` : tm[1];
      out += Buffer.from(hex, 'hex').toString('latin1');
    } else {
      out += tm[2]!.replace(/\\([()\\])/g, '$1');
    }
  }
  return out;
}

function extractPdfText(pdf: Buffer): string {
  return inflatePdfStreams(pdf).map(decodeShowTextTokens).join(' ');
}

/** Straight-rect fill ops (`x y w h re ... scn f`) — the callout's 3pt left
 *  accent bar draws this way. */
function extractFilledRects(pdf: Buffer): { r: number; g: number; b: number }[] {
  const rects: { r: number; g: number; b: number }[] = [];
  for (const body of inflatePdfStreams(pdf)) {
    const re = /(?:-?[\d.]+) (?:-?[\d.]+) (?:-?[\d.]+) (?:-?[\d.]+) re\s*\/DeviceRGB cs\s*([\d.]+) ([\d.]+) ([\d.]+) scn\s*f/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) rects.push({ r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) });
  }
  return rects;
}

/** roundedRect fill ops: pdfkit draws these as a closed Bézier path (ending
 *  in `h` — closepath — right before the color-set + fill), unlike a plain
 *  `.rect()` fill which has no `h`. This is what the callout's tinted card
 *  background draws with. */
function extractFilledRoundedRects(pdf: Buffer): { r: number; g: number; b: number }[] {
  const rects: { r: number; g: number; b: number }[] = [];
  for (const body of inflatePdfStreams(pdf)) {
    const re = /h\s*\/DeviceRGB cs\s*([\d.]+) ([\d.]+) ([\d.]+) scn\s*f/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) rects.push({ r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) });
  }
  return rects;
}

function renderToBuffer(draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (d: Buffer) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  draw(doc);
  doc.end();
  return done;
}

function ensureSpace(doc: PDFKit.PDFDocument, y: number, needed = 40): number {
  if (y > doc.page.height - doc.page.margins.bottom - needed) {
    doc.addPage();
    return doc.page.margins.top;
  }
  return y;
}

function makeEnsureRoomRich(doc: PDFKit.PDFDocument, yRef: { y: number }): EnsureRoomRich {
  return (needed: number) => {
    const before = doc.y;
    yRef.y = ensureSpace(doc, doc.y, needed);
    return { y: yRef.y, didBreak: doc.y !== before };
  };
}

const ACCENT = '#2563eb';

function makeContent(overrides: Partial<QuoteCalloutContent> = {}): QuoteCalloutContent {
  return { variant: 'info', html: '<p>Body copy for the callout.</p>', ...overrides } as QuoteCalloutContent;
}

describe('renderCalloutIntoPdf', () => {
  it('draws tinted chrome (rounded rect background + accent bar) and the body text', async () => {
    const buf = await renderToBuffer((doc) => {
      const theme = registerThemeFonts(doc, 'classic');
      const yRef = { y: 100 };
      const ensureRoom = makeEnsureRoomRich(doc, yRef);
      renderCalloutIntoPdf(doc, makeContent({ variant: 'accent', title: 'Why this matters' }), {
        x: doc.page.margins.left, width: doc.page.width - 100, startY: yRef.y, accent: ACCENT, fonts: theme, ensureRoom,
      });
    });
    expect(extractFilledRoundedRects(buf).length).toBeGreaterThanOrEqual(1);
    expect(extractFilledRects(buf).length).toBeGreaterThanOrEqual(1); // the accent bar
    const text = extractPdfText(buf);
    expect(text).toContain('Why this matters');
    expect(text).toContain('Body copy for the callout');
  });

  it('accent variant tints with the passed accent color; info/warn use fixed hues', async () => {
    async function renderVariant(variant: 'info' | 'accent' | 'warn') {
      return renderToBuffer((doc) => {
        const theme = registerThemeFonts(doc, 'classic');
        const yRef = { y: 100 };
        const ensureRoom = makeEnsureRoomRich(doc, yRef);
        renderCalloutIntoPdf(doc, makeContent({ variant }), {
          x: doc.page.margins.left, width: doc.page.width - 100, startY: yRef.y, accent: ACCENT, fonts: theme, ensureRoom,
        });
      });
    }
    const accentBuf = await renderVariant('accent');
    const infoBuf = await renderVariant('info');
    const warnBuf = await renderVariant('warn');

    const accentBar = extractFilledRects(accentBuf)[0]!;
    const infoBar = extractFilledRects(infoBuf)[0]!;
    const warnBar = extractFilledRects(warnBuf)[0]!;

    // accent bar should be near the branding accent (#2563eb ≈ 0.145/0.388/0.921)
    expect(accentBar.r).toBeCloseTo(0x25 / 255, 1);
    expect(accentBar.g).toBeCloseTo(0x63 / 255, 1);
    expect(accentBar.b).toBeCloseTo(0xeb / 255, 1);
    // info/warn are fixed hues, independent of the passed accent, and differ
    // from each other and from the accent variant's bar color.
    expect(infoBar).not.toEqual(accentBar);
    expect(warnBar).not.toEqual(accentBar);
    expect(infoBar).not.toEqual(warnBar);
  });

  it('a callout taller than a full page renders as plain rich text with no chrome', async () => {
    const tallHtml = Array.from({ length: 120 }, (_, i) => `<p>Paragraph number ${i} of a very long callout body that keeps going.</p>`).join('');
    const buf = await renderToBuffer((doc) => {
      const theme = registerThemeFonts(doc, 'classic');
      const yRef = { y: 100 };
      const ensureRoom = makeEnsureRoomRich(doc, yRef);
      renderCalloutIntoPdf(doc, makeContent({ variant: 'warn', title: 'Overflowing', html: tallHtml }), {
        x: doc.page.margins.left, width: doc.page.width - 100, startY: yRef.y, accent: ACCENT, fonts: theme, ensureRoom,
      });
    });
    expect(extractFilledRoundedRects(buf).length).toBe(0);
    expect(extractFilledRects(buf).length).toBe(0);
    const pdfLibDoc = await PdfLibDocument.load(buf);
    expect(pdfLibDoc.getPageCount()).toBeGreaterThan(1);
    const text = extractPdfText(buf);
    expect(text).toContain('Overflowing');
    expect(text).toContain('Paragraph number 0');
  });

  it('returns startY unchanged and draws nothing for out-of-contract content', async () => {
    let returned = -1;
    const buf = await renderToBuffer((doc) => {
      registerThemeFonts(doc, 'classic');
      const theme = registerThemeFonts(doc, 'classic');
      const yRef = { y: 137 };
      const ensureRoom = makeEnsureRoomRich(doc, yRef);
      returned = renderCalloutIntoPdf(doc, { variant: 'loud', html: 'x' }, {
        x: doc.page.margins.left, width: doc.page.width - 100, startY: yRef.y, accent: ACCENT, fonts: theme, ensureRoom,
      });
    });
    expect(returned).toBe(137);
    expect(extractFilledRoundedRects(buf).length).toBe(0);
    expect(extractPdfText(buf).trim()).toBe('');
  });
});
