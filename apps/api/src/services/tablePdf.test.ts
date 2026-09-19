import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import PDFDocument from 'pdfkit';
import { PDFDocument as PdfLibDocument, PDFArray, PDFDict, PDFName, PDFRawStream, PDFStream, PDFString, decodePDFRawStream } from 'pdf-lib';
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

// ---------------------------------------------------------------------------
// Multi-run cells in non-left-aligned columns (#4438).
//
// A cell whose HTML carries formatting (`<strong>`, `<a>`) is drawn as several
// pdfkit `continued: true` runs. pdfkit applies `align` to EVERY text() call —
// including each continued run — so a multi-run cell in a centered or
// right-aligned column used to paint each run individually aligned inside the
// box: all the runs of one line landed on top of each other. drawRuns now lays
// those lines out itself (richTextPdf.ts); these tests pin the geometry from
// the rendered bytes rather than trusting the implementation.
// ---------------------------------------------------------------------------
describe('renderTableIntoPdf multi-run cells in non-left-aligned columns (#4438)', () => {
  const ACCENT = '#2563eb';
  // Column weights 3/2 over an A4 content width (495pt) → 297pt + 198pt boxes.
  const CENTER_HTML =
    '<strong>Bold</strong> lead then a <a href="https://example.com/sla">service level link</a> plus enough trailing words that the cell wraps onto a second line';
  const RIGHT_HTML = 'Base <strong>$1,200.00</strong> per <a href="https://example.com/pricing">month</a>';

  interface Fragment { text: string; x: number; y: number; width: number; baseFont: string; size: number }

  /** Every drawn text run with its origin, font and advance width. pdfkit
   *  emits one `BT … ET` object per run: a `1 0 0 1 x y Tm` origin, a
   *  `/Fn size Tf` font selection and a TJ show-text array. Widths are
   *  re-measured at the fragment's own font+size — the TJ kerning adjustments
   *  pdfkit interleaves are already included in widthOfString, so adding them
   *  back would over-measure (verified against the underline rule pdfkit draws
   *  for the same run, which spans exactly widthOfString). */
  async function extractTextFragments(pdf: Buffer, pageHeight = 841.89): Promise<Fragment[]> {
    const lib = await PdfLibDocument.load(pdf);
    const measurer = new PDFDocument({ size: 'A4', margin: 50 });
    const fragments: Fragment[] = [];
    try {
      for (const page of lib.getPages()) {
        const fontByResourceName = new Map<string, string>();
        const resources = page.node.Resources();
        const fontEntry = resources instanceof PDFDict ? resources.get(PDFName.of('Font')) : undefined;
        const fontDict = fontEntry instanceof PDFDict ? fontEntry : lib.context.lookupMaybe(fontEntry as never, PDFDict);
        for (const [name, value] of fontDict?.entries() ?? []) {
          const fontObj = lib.context.lookupMaybe(value as never, PDFDict);
          const baseFont = fontObj?.get(PDFName.of('BaseFont'));
          if (baseFont) fontByResourceName.set(name.toString(), baseFont.toString().replace(/^\//, ''));
        }
        const contentsEntry = page.node.get(PDFName.of('Contents'));
        const contents = contentsEntry instanceof PDFArray
          ? contentsEntry.asArray().map((ref) => lib.context.lookupMaybe(ref as never, PDFStream))
          : [lib.context.lookupMaybe(contentsEntry as never, PDFStream)];
        for (const stream of contents.filter((s): s is PDFRawStream => s instanceof PDFRawStream)) {
          const body = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
          const textObjectRe = /BT\s+([\s\S]*?)\s+ET/g;
          let textObject: RegExpExecArray | null;
          while ((textObject = textObjectRe.exec(body))) {
            const block = textObject[1]!;
            const tm = /1 0 0 1 ([\d.]+) ([\d.]+) Tm/.exec(block);
            if (!tm) continue;
            const tf = /\/(\w+) ([\d.]+) Tf/.exec(block);
            const tokenRe = /<([0-9a-fA-F]+)>|\(((?:[^()\\]|\\.)*)\)/g;
            let text = '';
            let token: RegExpExecArray | null;
            while ((token = tokenRe.exec(block))) {
              text += token[1] !== undefined
                ? Buffer.from(token[1].length % 2 ? `${token[1]}0` : token[1], 'hex').toString('latin1')
                : token[2]!.replace(/\\([()\\])/g, '$1');
            }
            if (!text.length) continue;
            const size = Number(tf?.[2] ?? 10);
            const baseFont = fontByResourceName.get(`/${tf?.[1] ?? ''}`) ?? 'Helvetica';
            measurer.font(baseFont).fontSize(size);
            fragments.push({ text, x: Number(tm[1]), y: pageHeight - Number(tm[2]), size, baseFont, width: measurer.widthOfString(text) });
          }
        }
      }
    } finally {
      measurer.end();
    }
    return fragments;
  }

  /** Link annotations on page 1: URI + rect (PDF user space, y up). */
  async function extractLinkAnnotations(pdf: Buffer): Promise<{ uri: string; rect: number[] }[]> {
    const lib = await PdfLibDocument.load(pdf);
    const annots = lib.getPage(0).node.Annots();
    const links: { uri: string; rect: number[] }[] = [];
    for (const ref of annots?.asArray() ?? []) {
      const annot = lib.context.lookupMaybe(ref as never, PDFDict);
      if (!annot || annot.get(PDFName.of('Subtype'))?.toString() !== '/Link') continue;
      const action = lib.context.lookupMaybe(annot.get(PDFName.of('A')) as never, PDFDict);
      const uri = action?.get(PDFName.of('URI'));
      const rect = annot.get(PDFName.of('Rect'));
      links.push({
        uri: uri instanceof PDFString ? uri.decodeText() : String(uri ?? ''),
        rect: rect instanceof PDFArray ? rect.asArray().map((n) => Number(String(n))) : [],
      });
    }
    return links;
  }

  /** Group fragments into drawn lines (same baseline) and sort each left→right. */
  function toLines(fragments: Fragment[]): Fragment[][] {
    const lines: Fragment[][] = [];
    for (const f of [...fragments].sort((a, b) => a.y - b.y || a.x - b.x)) {
      const line = lines[lines.length - 1];
      if (line && Math.abs(line[0]!.y - f.y) < 0.5) line.push(f);
      else lines.push([f]);
    }
    return lines;
  }

  interface ColumnBox { inner: { left: number; right: number }; outer: { left: number; right: number } }
  interface Rendered { buf: Buffer; columns: ColumnBox[]; rowTop: number }

  async function renderAlignedTable(
    aligns: ['center' | 'right' | 'left', 'center' | 'right' | 'left'],
    cells: [string, string] = [CENTER_HTML, RIGHT_HTML],
  ): Promise<Rendered> {
    const content = {
      columns: [{ label: 'Item', align: aligns[0], weight: 3 }, { label: 'Amount', align: aligns[1], weight: 2 }],
      rows: [{ cells }],
    } as unknown as QuoteTableContent;
    const captured: Rendered = { buf: Buffer.alloc(0), columns: [], rowTop: 0 };
    captured.buf = await renderToBuffer((doc) => {
      const theme = registerThemeFonts(doc, 'classic');
      const model = measureTable(doc, parseTable(content, doc.page.width - 100)!, theme);
      let cx = doc.page.margins.left;
      captured.columns = model.columns.map((col) => {
        const box = {
          outer: { left: cx, right: cx + col.width },
          inner: { left: cx + CELL_PADDING, right: cx + col.width - CELL_PADDING },
        };
        cx += col.width;
        return box;
      });
      const yRef = { y: 100 };
      const ensureRoom = makeEnsureRoomRich(doc, yRef);
      captured.rowTop = yRef.y + model.headerHeight;
      renderTableIntoPdf(doc, model, { x: doc.page.margins.left, startY: yRef.y, accent: ACCENT, fonts: theme, ensureRoom });
    });
    return captured;
  }

  /** The row's fragments for one column, grouped into lines. Column membership
   *  is decided by the fragment's origin against the column's OUTER box, so a
   *  neighbouring column's runs can't leak in however badly aligned they are. */
  async function cellLines(rendered: Rendered, columnIndex: number): Promise<Fragment[][]> {
    const fragments = await extractTextFragments(rendered.buf);
    const { outer } = rendered.columns[columnIndex]!;
    const inCell = fragments.filter((f) => f.y > rendered.rowTop && f.x >= outer.left - 0.5 && f.x < outer.right - 0.5);
    return toLines(inCell);
  }

  it('lays a bold/link multi-run cell out as one centered line sequence, run after run', async () => {
    const rendered = await renderAlignedTable(['center', 'left']);
    const span = rendered.columns[0]!.inner;
    const center = (span.left + span.right) / 2;
    const lines = await cellLines(rendered, 0);

    // Non-vacuity: the cell really wrapped, and it really drew in more than one
    // font (the <strong> run) with the link run present.
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]!.length).toBeGreaterThanOrEqual(2);
    expect(new Set(lines.flat().map((f) => f.baseFont)).size).toBeGreaterThanOrEqual(2);
    expect(lines.flat().some((f) => f.text.includes('service level link'))).toBe(true);

    for (const line of lines) {
      const first = line[0]!;
      const last = line[line.length - 1]!;
      const lastRight = last.x + last.width;
      // Centered as a LINE: the whole line's box is centered in the cell, not
      // each run on its own.
      expect((first.x + lastRight) / 2).toBeCloseTo(center, 0);
      expect(first.x).toBeGreaterThanOrEqual(span.left - 0.5);
      expect(lastRight).toBeLessThanOrEqual(span.right + 0.5);
      // Runs of one line follow each other instead of painting over each other.
      for (let i = 1; i < line.length; i++) {
        const prev = line[i - 1]!;
        expect(line[i]!.x, `run ${i} overlaps "${prev.text}"`).toBeGreaterThanOrEqual(prev.x + prev.width - 0.6);
      }
    }
  });

  it('right-aligns every line of a bold/link multi-run cell to the cell\'s inner right edge', async () => {
    const rendered = await renderAlignedTable(['left', 'right']);
    const span = rendered.columns[1]!.inner;
    const lines = await cellLines(rendered, 1);

    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.flat().length).toBeGreaterThanOrEqual(4); // Base / $1,200.00 / per / month
    expect(new Set(lines.flat().map((f) => f.baseFont)).size).toBeGreaterThanOrEqual(2);

    for (const line of lines) {
      const first = line[0]!;
      const last = line[line.length - 1]!;
      const lastRight = last.x + last.width;
      expect(lastRight).toBeCloseTo(span.right, 0);
      expect(first.x).toBeGreaterThanOrEqual(span.left - 0.5);
      for (let i = 1; i < line.length; i++) {
        const prev = line[i - 1]!;
        expect(line[i]!.x, `run ${i} overlaps "${prev.text}"`).toBeGreaterThanOrEqual(prev.x + prev.width - 0.6);
      }
    }
  });

  it('positions a plain single-run center/right cell where pdfkit\'s native box alignment would (control, #5013 review)', async () => {
    // The aligned path now handles EVERY non-left cell, not only multi-run
    // ones — including the far more common plain numeric/text cell that used
    // to go through pdfkit's own `align`. Pin that the hand-rolled placement
    // agrees with the native box math for a single run: right edge on the
    // inner right padding, centre on the inner centre.
    const rendered = await renderAlignedTable(['center', 'right'], ['Total', '$1,200.00']);
    const centerSpan = rendered.columns[0]!.inner;
    const rightSpan = rendered.columns[1]!.inner;

    const centerLines = await cellLines(rendered, 0);
    const rightLines = await cellLines(rendered, 1);
    expect(centerLines).toHaveLength(1);
    expect(rightLines).toHaveLength(1);
    expect(centerLines[0]).toHaveLength(1); // one run, one fragment — nothing split or duplicated
    expect(rightLines[0]).toHaveLength(1);

    const c = centerLines[0]![0]!;
    expect(c.text).toBe('Total');
    expect(c.x + c.width / 2).toBeCloseTo((centerSpan.left + centerSpan.right) / 2, 0);

    const r = rightLines[0]![0]!;
    expect(r.text).toBe('$1,200.00');
    expect(r.x + r.width).toBeCloseTo(rightSpan.right, 0);
    expect(r.x).toBeGreaterThan(rightSpan.left);
  });

  it('keeps a left-aligned multi-run cell run after run (control for the two above)', async () => {
    const rendered = await renderAlignedTable(['left', 'left']);
    const span = rendered.columns[0]!.inner;
    const lines = await cellLines(rendered, 0);

    expect(lines.length).toBeGreaterThanOrEqual(2);
    // Left-aligned: the first run of every line starts at the cell's left padding.
    for (const line of lines) {
      expect(line[0]!.x).toBeCloseTo(span.left, 0);
      for (let i = 1; i < line.length; i++) {
        const prev = line[i - 1]!;
        expect(line[i]!.x).toBeGreaterThanOrEqual(prev.x + prev.width - 0.6);
      }
    }
  });

  it('gives each link run exactly one annotation, inside its own cell', async () => {
    const rendered = await renderAlignedTable(['center', 'right']);
    const links = await extractLinkAnnotations(rendered.buf);

    expect(links.map((l) => l.uri).sort()).toEqual(['https://example.com/pricing', 'https://example.com/sla']);
    for (const link of links) {
      const [x1, , x2] = link.rect;
      const span = (link.uri.endsWith('/sla') ? rendered.columns[0]! : rendered.columns[1]!).inner;
      expect(x1!).toBeGreaterThanOrEqual(span.left - 0.5);
      expect(x2!).toBeLessThanOrEqual(span.right + 0.5);
      expect(x2!).toBeGreaterThan(x1!);
    }
    // And no link bled onto the runs that follow it (pdfkit continued-option
    // stickiness — the same hazard richTextPdf.test.ts guards for paragraphs).
    const raw = rendered.buf.toString('latin1');
    expect((raw.match(/\/Subtype \/Link/g) ?? []).length).toBe(2);
  });
});
