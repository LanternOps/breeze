import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import PDFDocument from 'pdfkit';
import { PDFDocument as PdfLibDocument } from 'pdf-lib';
import { parseTable, measureTable, renderTableIntoPdf, MIN_COLUMN_WIDTH, CELL_PADDING, type EnsureRoomRich, type TableModel } from './tablePdf';
import { registerThemeFonts } from './documentThemes';
import type { QuoteTableContent } from '@breeze/shared';

// ---------------------------------------------------------------------------
// Render-test helpers (same inflate/decode approach as quotePdf.test.ts's
// content-stream assertions — kept local here rather than shared, since the
// two suites' needs diverge slightly: this one also needs per-stream/per-page
// correlation and rect-fill-op extraction).
// ---------------------------------------------------------------------------

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

/** Per-stream extracted text — pdfkit emits one content stream per page (for
 *  text-only pages, no images), so for our table-only fixtures this array's
 *  index lines up with page index. */
function extractPdfTextByStream(pdf: Buffer): string[] {
  return inflatePdfStreams(pdf).map(decodeShowTextTokens);
}

function extractPdfText(pdf: Buffer): string {
  return extractPdfTextByStream(pdf).join(' ');
}

/** Filled-rect ops: `x y w h re ... scn f` (plain doc.rect().fill(color)) —
 *  roundedRect draws curves instead of `re`, so this deliberately only
 *  matches straight rects (table header/zebra/degrade fills). */
function extractFilledRects(pdf: Buffer): { x: number; y: number; w: number; h: number; r: number; g: number; b: number }[] {
  const rects: { x: number; y: number; w: number; h: number; r: number; g: number; b: number }[] = [];
  for (const body of inflatePdfStreams(pdf)) {
    const re = /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re\s*\/DeviceRGB cs\s*([\d.]+) ([\d.]+) ([\d.]+) scn\s*f/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      rects.push({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]), r: Number(m[5]), g: Number(m[6]), b: Number(m[7]) });
    }
  }
  return rects;
}

/** Positioned text fragments: each `BT ... Tm ... (text)/<hex> ... ET` text
 *  object's origin (in top-down page coordinates) plus its decoded text —
 *  needed to assert row N's last drawn line sits ABOVE (smaller y) row N+1's
 *  first drawn line, i.e. no vertical overlap between rows. */
function extractPositionedPdfText(pdf: Buffer, pageHeight = 841.89): { text: string; x: number; y: number }[] {
  const fragments: { text: string; x: number; y: number }[] = [];
  for (const body of inflatePdfStreams(pdf)) {
    const textObjectRe = /BT\s+([\s\S]*?)\s+ET/g;
    let textObject: RegExpExecArray | null;
    while ((textObject = textObjectRe.exec(body))) {
      const tm = /1 0 0 1 ([\d.]+) ([\d.]+) Tm/.exec(textObject[1]!);
      if (!tm) continue;
      const text = decodeShowTextTokens(textObject[1]!);
      if (text) fragments.push({ text, x: Number(tm[1]), y: pageHeight - Number(tm[2]) });
    }
  }
  return fragments;
}

function hexToRgbFrac(hex: string): [number, number, number] {
  const v = hex.replace('#', '');
  const num = parseInt(v, 16);
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
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

/** Same `ensureSpace` quotePdf.ts uses (:247-253): add a page if `y` is
 *  within the bottom margin band. */
function ensureSpace(doc: PDFKit.PDFDocument, y: number, needed = 40): number {
  if (y > doc.page.height - doc.page.margins.bottom - needed) {
    doc.addPage();
    return doc.page.margins.top;
  }
  return y;
}

/** Mirrors quotePdf.ts's block-walk `ensureRoomRich` closure exactly (the
 *  brief's snippet): reserves `needed` px via ensureSpace, page-breaking
 *  first if it won't fit, and reports whether a break happened via doc.y
 *  changing across the call. `yRef` is a one-element mutable box standing in
 *  for the outer `y` variable the real closure captures. */
function makeEnsureRoomRich(doc: PDFKit.PDFDocument, yRef: { y: number }): EnsureRoomRich {
  return (needed: number) => {
    const before = doc.y;
    yRef.y = ensureSpace(doc, doc.y, needed);
    return { y: yRef.y, didBreak: doc.y !== before };
  };
}

function makeContent(overrides: Partial<QuoteTableContent> = {}): QuoteTableContent {
  return {
    columns: [{ label: 'Item' }, { label: 'Price' }],
    rows: [{ cells: ['Widget', '$10'] }],
    ...overrides,
  } as QuoteTableContent;
}

describe('parseTable', () => {
  it('distributes column widths by weight over availableWidth', () => {
    const content = makeContent({
      columns: [{ label: 'A', weight: 1 }, { label: 'B', weight: 3 }],
      rows: [{ cells: ['a', 'b'] }],
    });
    const model = parseTable(content, 400);
    expect(model).not.toBeNull();
    expect(model!.columns.map((c) => c.width)).toEqual([100, 300]);
  });

  it('applies the 40pt floor when weights would otherwise starve a column', () => {
    // 8 skinny columns over a modest width — equal weights would each get
    // less than MIN_COLUMN_WIDTH without the floor.
    const columns = Array.from({ length: 8 }, (_, i) => ({ label: `C${i}`, weight: 1 }));
    const rows = [{ cells: Array.from({ length: 8 }, (_, i) => `r${i}`) }];
    const model = parseTable(makeContent({ columns, rows }), 200);
    expect(model).not.toBeNull();
    for (const col of model!.columns) {
      expect(col.width).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH);
    }
  });

  it('returns null for out-of-contract content', () => {
    expect(parseTable({ columns: [], rows: [] }, 400)).toBeNull();
    expect(parseTable(null, 400)).toBeNull();
    expect(parseTable({ columns: [{ label: 'A' }], rows: [{ cells: ['a', 'b'] }] }, 400)).toBeNull();
  });

  it('defaults align to left, zebra to false, headerStyle to accent', () => {
    const model = parseTable(makeContent(), 400);
    expect(model).not.toBeNull();
    expect(model!.columns.every((c) => c.align === 'left')).toBe(true);
    expect(model!.zebra).toBe(false);
    expect(model!.headerStyle).toBe('accent');
  });

  it('preserves explicit align/zebra/headerStyle/caption', () => {
    const content = makeContent({
      columns: [{ label: 'A', align: 'right' }, { label: 'B', align: 'center' }],
      zebra: true,
      headerStyle: 'plain',
      caption: 'A caption',
    });
    const model = parseTable(content, 400);
    expect(model).not.toBeNull();
    expect(model!.columns.map((c) => c.align)).toEqual(['right', 'center']);
    expect(model!.zebra).toBe(true);
    expect(model!.headerStyle).toBe('plain');
    expect(model!.caption).toBe('A caption');
  });
});

describe('measureTable', () => {
  it('sets row height to max cell height + 2x CELL_PADDING', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const model = parseTable(makeContent(), 400)!;
    const theme = registerThemeFonts(doc, 'classic');
    const measured = measureTable(doc, model, theme);
    expect(measured.rows[0]!.height).toBeGreaterThanOrEqual(2 * CELL_PADDING);
  });

  it('a long wrapping cell makes its row taller than a sibling row with short cells', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const longText =
      'This is a very long cell value that will wrap across several lines when constrained to a narrow column width in the rendered PDF table.';
    const content = makeContent({
      columns: [{ label: 'A', weight: 1 }, { label: 'B', weight: 1 }],
      rows: [{ cells: [longText, 'x'] }, { cells: ['y', 'z'] }],
    });
    const model = parseTable(content, 200)!;
    const theme = registerThemeFonts(doc, 'classic');
    const measured = measureTable(doc, model, theme);
    expect(measured.rows[0]!.height).toBeGreaterThan(measured.rows[1]!.height);
  });

  it('measures a bold-heavy cell at bold font — taller-or-equal vs the flattened regular measurement', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const longText =
      'The quick brown fox jumps over the lazy dog and then keeps running through the proposal terms section.';
    const content = makeContent({
      columns: [{ label: 'A', weight: 1 }],
      rows: [{ cells: [`<strong>${longText}</strong>`] }],
    });
    const model = parseTable(content, 160)!;
    const theme = registerThemeFonts(doc, 'classic');
    const measured = measureTable(doc, model, theme);

    doc.font(theme.body.regular).fontSize(10);
    const flattenedHeight = doc.heightOfString(longText, { width: model.columns[0]!.width - 2 * CELL_PADDING });

    expect(measured.rows[0]!.height).toBeGreaterThanOrEqual(flattenedHeight + 2 * CELL_PADDING);
  });

  it('fills headerHeight', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const model = parseTable(makeContent(), 400)!;
    const theme = registerThemeFonts(doc, 'classic');
    const measured = measureTable(doc, model, theme);
    expect(measured.headerHeight).toBeGreaterThanOrEqual(2 * CELL_PADDING);
  });

  it('restores the doc font state after measuring', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.font('Helvetica').fontSize(9);
    const before = doc as unknown as { _font: { name: string }; _fontSize: number };
    const beforeFontName = before._font.name;
    const beforeFontSize = before._fontSize;

    const model = parseTable(makeContent(), 400)!;
    const theme = registerThemeFonts(doc, 'classic');
    measureTable(doc, model, theme);

    const after = doc as unknown as { _font: { name: string }; _fontSize: number };
    expect(after._font.name).toBe(beforeFontName);
    expect(after._fontSize).toBe(beforeFontSize);
  });
});

describe('renderTableIntoPdf', () => {
  const ACCENT = '#2563eb';

  function buildMeasured(content: Partial<QuoteTableContent>, doc: PDFKit.PDFDocument, width = 400): TableModel {
    const model = parseTable(makeContent(content), width)!;
    const theme = registerThemeFonts(doc, 'classic');
    return measureTable(doc, model, theme);
  }

  it('draws header labels and cell text', async () => {
    const buf = await renderToBuffer((doc) => {
      const theme = registerThemeFonts(doc, 'classic');
      const model = buildMeasured({ columns: [{ label: 'Item' }, { label: 'Price' }], rows: [{ cells: ['Widget', '$10'] }] }, doc);
      const yRef = { y: 100 };
      const ensureRoom = makeEnsureRoomRich(doc, yRef);
      renderTableIntoPdf(doc, model, { x: doc.page.margins.left, startY: yRef.y, accent: ACCENT, fonts: theme, ensureRoom });
    });
    const text = extractPdfText(buf);
    expect(text).toContain('Item');
    expect(text).toContain('Price');
    expect(text).toContain('Widget');
    expect(text).toContain('$10');
  });

  it('spans multiple pages and repeats the header label on every page', async () => {
    const longCell = 'Detailed line item description that wraps across several lines '.repeat(4);
    const rows = Array.from({ length: 30 }, (_, i) => ({ cells: [`Row ${i}`, longCell] }));
    const buf = await renderToBuffer((doc) => {
      const theme = registerThemeFonts(doc, 'classic');
      const model = buildMeasured({ columns: [{ label: 'Row', weight: 1 }, { label: 'Description', weight: 3 }], rows }, doc, doc.page.width - 100);
      const yRef = { y: 100 };
      const ensureRoom = makeEnsureRoomRich(doc, yRef);
      renderTableIntoPdf(doc, model, { x: doc.page.margins.left, startY: yRef.y, accent: ACCENT, fonts: theme, ensureRoom });
    });
    const pdfLibDoc = await PdfLibDocument.load(buf);
    expect(pdfLibDoc.getPageCount()).toBeGreaterThan(1);

    const streamTexts = extractPdfTextByStream(buf);
    expect(streamTexts.length).toBeGreaterThanOrEqual(pdfLibDoc.getPageCount());
    // Every stream that contains at least one row's marker text ("Row N")
    // must also contain the header label — i.e. the header was redrawn on
    // every page the table actually spans, not just the first.
    const pagesWithRows = streamTexts.filter((t) => /Row \d/.test(t));
    expect(pagesWithRows.length).toBeGreaterThan(1);
    for (const t of pagesWithRows) {
      expect(t).toContain('Description');
    }
  });

  it('degrades an oversized row to a stacked label: value paragraph without throwing or looping', async () => {
    // Cell strings are capped at 2000 chars by quoteTableContentSchema, so a
    // single unbroken word can't be used to force height (an unbreakable
    // token never wraps — see richTextPdf.ts's countWrappedLines: it only
    // wraps once lineWidth already has content). Instead: many short
    // whitespace-separated tokens (which DO wrap) inside a MIN_COLUMN_WIDTH
    // (40pt) column, so the row measures far taller than a full A4 page.
    const hugeCell = 'x '.repeat(999).trim();
    let threw = false;
    let buf: Buffer | undefined;
    try {
      buf = await renderToBuffer((doc) => {
        const theme = registerThemeFonts(doc, 'classic');
        const model = buildMeasured(
          { columns: [{ label: 'Notes', weight: 1 }], rows: [{ cells: [hugeCell] }, { cells: ['normal row'] }] },
          doc,
          MIN_COLUMN_WIDTH,
        );
        const yRef = { y: 100 };
        const ensureRoom = makeEnsureRoomRich(doc, yRef);
        renderTableIntoPdf(doc, model, { x: doc.page.margins.left, startY: yRef.y, accent: ACCENT, fonts: theme, ensureRoom });
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(buf).toBeDefined();

    const pdfLibDoc = await PdfLibDocument.load(buf!);
    // A real infinite loop would OOM/hang long before pdfkit ever emits a
    // buffer; a passing render with a bounded page count is the completion
    // signal (this test's own timeout is the loop backstop).
    expect(pdfLibDoc.getPageCount()).toBeGreaterThan(1);

    const text = extractPdfText(buf!);
    expect(text).toContain('Notes:');
    expect(text).toContain('normal row');

    // The degraded row draws no header-style/zebra rect for ITSELF — only the
    // table header's own fill rects should appear, one per page it repeats on.
    const rects = extractFilledRects(buf!);
    expect(rects.length).toBeGreaterThan(0);
    expect(rects.length).toBeLessThanOrEqual(pdfLibDoc.getPageCount() + 1);
  });

  it('zebra striping alternates row fill color; headerStyle "accent" fills the header with the accent color', async () => {
    const buf = await renderToBuffer((doc) => {
      const theme = registerThemeFonts(doc, 'classic');
      const model = buildMeasured(
        {
          columns: [{ label: 'A' }, { label: 'B' }],
          rows: [{ cells: ['1', '2'] }, { cells: ['3', '4'] }, { cells: ['5', '6'] }, { cells: ['7', '8'] }],
          zebra: true,
          headerStyle: 'accent',
        },
        doc,
      );
      const yRef = { y: 100 };
      const ensureRoom = makeEnsureRoomRich(doc, yRef);
      renderTableIntoPdf(doc, model, { x: doc.page.margins.left, startY: yRef.y, accent: ACCENT, fonts: theme, ensureRoom });
    });

    const rects = extractFilledRects(buf);
    expect(rects.length).toBeGreaterThanOrEqual(3); // 1 header + 2 zebra stripes (rows 1 & 3, 0-indexed odd rows)

    const [ar, ag, ab] = hexToRgbFrac(ACCENT);
    const headerRect = rects.find((r) => Math.abs(r.r - ar) < 0.01 && Math.abs(r.g - ag) < 0.01 && Math.abs(r.b - ab) < 0.01);
    expect(headerRect).toBeDefined();

    const zebraColor = hexToRgbFrac('#f8fafc');
    const zebraRects = rects.filter((r) => Math.abs(r.r - zebraColor[0]) < 0.01 && Math.abs(r.g - zebraColor[1]) < 0.01 && Math.abs(r.b - zebraColor[2]) < 0.01);
    expect(zebraRects.length).toBe(2); // rows at index 1 and 3 (odd)
  });

  it('headerStyle "plain" does NOT fill the header with the accent color', async () => {
    const buf = await renderToBuffer((doc) => {
      const theme = registerThemeFonts(doc, 'classic');
      const model = buildMeasured({ columns: [{ label: 'A' }], rows: [{ cells: ['1'] }], headerStyle: 'plain' }, doc);
      const yRef = { y: 100 };
      const ensureRoom = makeEnsureRoomRich(doc, yRef);
      renderTableIntoPdf(doc, model, { x: doc.page.margins.left, startY: yRef.y, accent: ACCENT, fonts: theme, ensureRoom });
    });
    const rects = extractFilledRects(buf);
    const [ar, ag, ab] = hexToRgbFrac(ACCENT);
    const accentRect = rects.find((r) => Math.abs(r.r - ar) < 0.01 && Math.abs(r.g - ag) < 0.01 && Math.abs(r.b - ab) < 0.01);
    expect(accentRect).toBeUndefined();
  });

  // Regression tests for two acceptance-testing bugs found on a live stack
  // after this table renderer first shipped:
  //
  //  Bug A (Critical): wrapped cell text overlapped the next row. Root cause —
  //  ensureRoom's underlying implementation reads pdfkit's own doc.y cursor,
  //  which drawHeader/drawRow's per-COLUMN doc.text() calls leave at wherever
  //  the LAST-drawn column's cell ended (not the row's true bottom, since row
  //  height is the MAX across cells). When the last-drawn column's cell was
  //  shorter than another column's in the same row — e.g. a short "Qty"
  //  column after a long wrapping "Description" column — the next row started
  //  from that too-small stale y, overlapping the previous row's last line.
  //  Fixed by resyncing doc.y to renderTableIntoPdf's own tracked `y`
  //  immediately before every ensureRoom call.
  //
  //  Bug B (Important): a column label containing real inline HTML (e.g.
  //  `<strong>Managed</strong>` — labels are sanitized inline-HTML per the
  //  schema, same as body cells) rendered its literal tag characters, because
  //  drawHeader escaped the label as plain text and then wrapped the escaped
  //  string in a SYNTHETIC `<strong>`. Fixed by drawing the label as real
  //  inline HTML (like body cells) with a `forceBold` draw/measure flag
  //  instead of the escape-and-wrap trick.
  it('Bug A regression: a wrapped middle-column cell does not overlap the next row, even when the LAST column is short', async () => {
    // weights 2/4/1 mirrors the acceptance repro exactly: column 2 (index 2,
    // drawn last) is short ("Qty"), column 1 (index 1) is the one that wraps.
    const midText =
      'Comprehensive managed detection and response coverage across every endpoint in the fleet monitored continuously by our SOC team around the clock every single day.';
    const buf = await renderToBuffer((doc) => {
      const theme = registerThemeFonts(doc, 'classic');
      const model = buildMeasured(
        {
          columns: [{ label: 'Item', weight: 2 }, { label: 'Description', weight: 4 }, { label: 'Qty', weight: 1 }],
          rows: [
            { cells: ['Service A', midText, '1'] },
            { cells: ['Service B', midText, '2'] },
            { cells: ['Service C', midText, '3'] },
          ],
        },
        doc,
        doc.page.width - 100,
      );
      const yRef = { y: 100 };
      const ensureRoom = makeEnsureRoomRich(doc, yRef);
      renderTableIntoPdf(doc, model, { x: doc.page.margins.left, startY: yRef.y, accent: ACCENT, fonts: theme, ensureRoom });
    });

    const positioned = extractPositionedPdfText(buf);
    const rowStarts = positioned.filter((f) => /^Service [ABC]$/.test(f.text)).sort((a, b) => a.y - b.y);
    expect(rowStarts.length).toBe(3);
    // The wrapped middle-column text's LAST line ("our SOC team...") for each
    // row must sit ABOVE (smaller y, since y grows downward here) the NEXT
    // row's label — i.e. real vertical separation, not overlap/collapse.
    const lastLines = positioned.filter((f) => f.text.startsWith('our SOC team')).sort((a, b) => a.y - b.y);
    expect(lastLines.length).toBe(3);
    for (let i = 0; i < 2; i++) {
      expect(rowStarts[i + 1]!.y).toBeGreaterThan(lastLines[i]!.y);
    }
    // Also assert the row-to-row spacing is at least the full 3-line cell
    // height (a loose lower bound — well beyond what a collapsed-row bug like
    // the one this regression guards against could produce).
    const rowGap = rowStarts[1]!.y - rowStarts[0]!.y;
    expect(rowGap).toBeGreaterThan(30);
  });

  it('Bug B regression: a header label with real inline HTML draws formatted text, not literal tag characters, and stays bold', async () => {
    const buf = await renderToBuffer((doc) => {
      const theme = registerThemeFonts(doc, 'classic');
      const model = buildMeasured({ columns: [{ label: '<strong>Managed</strong> Services' }, { label: 'Price' }], rows: [{ cells: ['x', 'y'] }] }, doc);
      const yRef = { y: 100 };
      const ensureRoom = makeEnsureRoomRich(doc, yRef);
      renderTableIntoPdf(doc, model, { x: doc.page.margins.left, startY: yRef.y, accent: ACCENT, fonts: theme, ensureRoom });
    });
    const text = extractPdfText(buf);
    expect(text).not.toContain('<strong>');
    expect(text).not.toContain('</strong>');
    expect(text).toContain('Managed');
    expect(text).toContain('Services');

    // The header cell must draw at the BOLD font, not the regular one — check
    // the content stream's font-selection operator (`/F<n> <size> Tf`)
    // immediately preceding the "Managed" show-text op resolves to a bold
    // BaseFont via the page's font resource dictionary. Simpler proxy: since
    // renderInlineRunsIntoPdf's forceBold path selects fonts.body.bold for
    // EVERY run regardless of the label's own <strong> tag, and Helvetica-Bold
    // is a distinct Tf font name from Helvetica, assert the operator stream
    // references Helvetica-Bold's font resource at least once (pdfkit names
    // resources positionally, so we check for the BaseFont string directly
    // in the (uncompressed) object bodies instead of the content stream).
    const raw = buf.toString('latin1');
    expect(raw).toContain('Helvetica-Bold');
  });
});
