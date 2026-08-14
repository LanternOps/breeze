import { describe, it, expect } from 'vitest';
import PDFDocument from 'pdfkit';
import { parseRichText, renderRichTextIntoPdf, measureRichText, measureInlineRuns } from './richTextPdf';

describe('parseRichText', () => {
  it('splits paragraphs and inline formatting runs', () => {
    expect(parseRichText('<p>plain <strong>bold <em>bolditalic</em></strong> tail</p>')).toEqual([
      { kind: 'p', indent: 0, runs: [
        { text: 'plain ', bold: false, italic: false, underline: false },
        { text: 'bold ', bold: true, italic: false, underline: false },
        { text: 'bolditalic', bold: true, italic: true, underline: false },
        { text: ' tail', bold: false, italic: false, underline: false },
      ] },
    ]);
  });
  it('numbers ordered list items and bullets unordered ones', () => {
    const blocks = parseRichText('<ol><li>a</li><li>b</li></ol><ul><li>c</li></ul>');
    expect(blocks.map((b) => [b.kind, b.ordinal ?? null])).toEqual([['li', 1], ['li', 2], ['li', null]]);
  });
  it('renders h3/h4 as heading blocks and br as run breaks', () => {
    const blocks = parseRichText('<h3>Key Terms</h3><p>one<br>two</p>');
    expect(blocks[0]).toMatchObject({ kind: 'h3' });
    expect(blocks[1]!.runs.some((r) => r.text.includes('\n'))).toBe(true);
  });
  it('is resilient to empty/whitespace input', () => {
    expect(parseRichText('')).toEqual([]);
  });
  it('folds stray root-level inline content into an implicit paragraph (raw API/MCP bodies)', () => {
    // Not producible by the TipTap editor, but a raw contract body can have bare
    // inline content at the root — it must render, not vanish, to match the HTML.
    const blocks = parseRichText('Plain lead <strong>bold</strong> and <a href="https://x.example">link</a>');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe('p');
    expect(blocks[0]!.runs.map((r) => r.text).join('')).toBe('Plain lead bold and link');
    expect(blocks[0]!.runs.some((r) => r.bold)).toBe(true);
    expect(blocks[0]!.runs.some((r) => r.link === 'https://x.example')).toBe(true);
  });
  it('does not manufacture an empty paragraph from whitespace between block tags', () => {
    // Whitespace text nodes between block elements must not become paragraphs.
    expect(parseRichText('<p>a</p>\n  \n<p>b</p>').map((b) => b.kind)).toEqual(['p', 'p']);
  });
  it('does not throw on an out-of-range numeric character reference (body text)', () => {
    // String.fromCodePoint(0x110000) throws RangeError — must fall back to the
    // original literal text instead of crashing the render.
    expect(() => parseRichText('<p>bad &#x110000; ref</p>')).not.toThrow();
    const blocks = parseRichText('<p>bad &#x110000; ref</p>');
    expect(blocks[0]!.runs.map((r) => r.text).join('')).toContain('&#x110000;');
  });
  it('does not throw on an out-of-range numeric character reference (attribute value)', () => {
    // Same decode path runs for attribute values via parseAttrs.
    expect(() => parseRichText('<p><a href="https://x.example?bad=&#x110000;">link</a></p>')).not.toThrow();
  });
});

describe('renderRichTextIntoPdf', () => {
  // A minimal ensureRoom stand-in mirroring quotePdf.ts's real wiring: reserves
  // `needed` px from doc's OWN y cursor (not a hand-tracked variable — see the
  // comment on the real closure in quotePdf.ts for why that distinction matters),
  // page-breaking via doc.addPage() when it won't fit.
  function makeEnsureRoom(doc: PDFKit.PDFDocument) {
    return (needed: number): number => {
      if (doc.y > doc.page.height - doc.page.margins.bottom - needed) doc.addPage();
      return doc.y;
    };
  }

  it('honors startY when pdfkit\'s cursor was left higher by a side-by-side column', () => {
    // Regression: quotePdf tracks the bottom of two identity columns separately.
    // If the right column was drawn last but the left column was taller, doc.y
    // could be above the explicit startY. The renderer must not jump back to
    // that stale cursor and draw the first paragraph over the identity block.
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.y = 140;
    const after = renderRichTextIntoPdf(doc, '<p>First proposal paragraph.</p>', {
      x: 50,
      width: 495,
      startY: 320,
      ensureRoom: makeEnsureRoom(doc),
    });

    expect(after).toBeGreaterThan(320);
  });

  it('spaces consecutive blocks apart instead of drawing them flush against each other', () => {
    // Regression: an earlier version of this renderer computed each block's
    // trailing gap into a local variable that was never actually reserved via
    // ensureRoom, so blocks silently drew with ZERO gap between them (and the
    // page-break check under-counted by one gap per block). Assert the y
    // cursor advances by MORE than the bare text height alone.
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.font('Helvetica').fontSize(11);
    const bareTextHeight = doc.heightOfString('Paragraph one.', { width: 495 });

    const html = '<p>Paragraph one.</p><p>Paragraph two.</p>';
    const before = 200;
    // In real usage (quotePdf.ts) doc.y is already at `before` by the time
    // renderRichTextIntoPdf is called — every other block-type branch keeps its
    // outer `y` snapshot in sync with pdfkit's cursor. Mirror that here.
    doc.y = before;
    const after = renderRichTextIntoPdf(doc, html, { x: 50, width: 495, startY: before, ensureRoom: makeEnsureRoom(doc) });
    // Two blocks drawn: the gap between them must show up in the total advance —
    // i.e. the cursor moves by strictly more than 2x the bare per-line text height.
    expect(after - before).toBeGreaterThan(bareTextHeight * 2);
    expect(after - before - bareTextHeight * 2).toBeGreaterThanOrEqual(5.5);
  });

  // Render into an UNCOMPRESSED pdfkit doc and return the raw bytes, so tests can
  // inspect link annotations (/Subtype /Link) and text-show operators (TJ) that
  // are otherwise flate-compressed away.
  function renderToBuffer(html: string): Promise<Buffer> {
    const doc = new PDFDocument({ size: 'A4', margin: 50, compress: false });
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve) => {
      doc.on('data', (d: Buffer) => chunks.push(d));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
    });
    doc.y = 60;
    const ensureRoom = (needed: number): number => {
      if (doc.y > doc.page.height - doc.page.margins.bottom - needed) doc.addPage();
      return doc.y;
    };
    renderRichTextIntoPdf(doc, html, { x: 50, width: 495, startY: doc.y, ensureRoom });
    doc.end();
    return done;
  }

  it('does not bleed a link onto text that follows it in the same block (pdfkit continued-option stickiness)', async () => {
    // Regression: a run after a link run omitted the `link` option, so pdfkit's
    // `continued: true` inheritance kept the previous URL and made the trailing
    // text a second live link. Exactly ONE link annotation must exist.
    const pdf = await renderToBuffer('<p>See <a href="https://x.example">terms</a> after</p>');
    const s = pdf.toString('latin1');
    expect((s.match(/\/Subtype \/Link/g) ?? []).length).toBe(1);
    expect(s).toContain('/URI (https://x.example)');
  });

  it('renders a 2-digit ordered-list ordinal ("10.") as a single un-wrapped text run', async () => {
    // Regression: "10." overflowed the fixed 14pt gutter and character-wrapped,
    // splitting into two text shows ("10" then ".") at different y positions.
    // The measured gutter must keep it a single TJ show. Hex 31302e === "10.".
    const html = '<ol>' + Array.from({ length: 12 }, (_, i) => `<li>Item ${i + 1}</li>`).join('') + '</ol>';
    const pdf = await renderToBuffer(html);
    const s = pdf.toString('latin1');
    expect(s).toContain('<31302e>'); // "10." shown as one run
    expect(s).not.toContain('<3130> 0] TJ\nET\nBT'); // not split "10" / "." across lines
  });

  it('advances the cursor by one line per ordered-list item (no ordinal-driven wrapping)', () => {
    // Each single-line <li> should advance the cursor by ~one line + spacing;
    // 12 items must never balloon past a two-lines-per-item budget (which is what
    // a wrapped ordinal would have caused if it leaked into the flow).
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.font('Helvetica').fontSize(11);
    const oneLine = doc.heightOfString('Item 10', { width: 480 });
    doc.y = 60;
    const html = '<ol>' + Array.from({ length: 12 }, (_, i) => `<li>Item ${i + 1}</li>`).join('') + '</ol>';
    const after = renderRichTextIntoPdf(doc, html, {
      x: 50, width: 495, startY: 60,
      ensureRoom: (needed: number) => { if (doc.y > doc.page.height - doc.page.margins.bottom - needed) doc.addPage(); return doc.y; },
    });
    // 12 items, one line each (~oneLine) plus 8px spacing per item — comfortably
    // under a two-line-per-item budget.
    expect(after - 60).toBeLessThan(12 * (oneLine * 2 + 8));
  });

  it('page-breaks mid-content when blocks overflow the remaining page height', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.y = 200;
    const paragraphs = Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i + 1}: some reasonably sized proposal text.</p>`).join('');
    let pageAdds = 0;
    const ensureRoom = (needed: number): number => {
      if (doc.y > doc.page.height - doc.page.margins.bottom - needed) { doc.addPage(); pageAdds += 1; }
      return doc.y;
    };
    renderRichTextIntoPdf(doc, paragraphs, { x: 50, width: 495, startY: 200, ensureRoom });
    // 40 paragraphs plus their spacing cannot fit in one A4 page starting at
    // y=200 — the renderer must call ensureRoom often enough (and reserve
    // enough per block) for at least one page break to actually fire.
    expect(pageAdds).toBeGreaterThan(0);
  });
});

describe('measureRichText', () => {
  // Long enough, at a narrow width, that bold's wider glyphs push it onto more
  // wrapped lines than the same text would take set in the regular face.
  const LONG_TEXT =
    'The quick brown fox jumps over the lazy dog and then keeps running through the proposal terms section without stopping for quite a while.';
  const NARROW_WIDTH = 160;

  it('measures a bold-heavy string at its actual (wider) bold glyphs — taller-or-equal vs a flattened single-font measurement', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const boldHtml = `<p><strong>${LONG_TEXT}</strong></p>`;

    const perRunHeight = measureRichText(doc, boldHtml, NARROW_WIDTH);

    // Flattened single-font measurement: same text, same width, but measured
    // in the regular (narrower) face — what a naive "ignore run fonts" measurer
    // would produce.
    doc.font('Helvetica').fontSize(11);
    const flattenedHeight = doc.heightOfString(LONG_TEXT, { width: NARROW_WIDTH });

    expect(perRunHeight).toBeGreaterThanOrEqual(flattenedHeight);
  });

  it('is deterministic across repeated calls', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const html = `<p>plain <strong>bold</strong> and <em>italic</em> text mixed together for measurement.</p>`;

    const first = measureRichText(doc, html, 250);
    const second = measureRichText(doc, html, 250);

    expect(first).toBe(second);
  });

  it('restores the doc font state (font name + size) after measuring', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.font('Helvetica').fontSize(9);
    const before = doc as unknown as { _font: { name: string }; _fontSize: number };
    const beforeFontName = before._font.name;
    const beforeFontSize = before._fontSize;

    measureRichText(doc, `<p><strong>${LONG_TEXT}</strong></p>`, NARROW_WIDTH);

    const after = doc as unknown as { _font: { name: string }; _fontSize: number };
    expect(after._font.name).toBe(beforeFontName);
    expect(after._fontSize).toBe(beforeFontSize);
  });

  it('returns 0 for empty/whitespace input', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    expect(measureRichText(doc, '', 300)).toBe(0);
  });
});

describe('measureInlineRuns', () => {
  const LONG_TEXT =
    'The quick brown fox jumps over the lazy dog and then keeps running through the proposal terms section without stopping for quite a while.';
  const NARROW_WIDTH = 140;

  it('measures a bold-heavy inline-runs string taller-or-equal vs a flattened single-font measurement at narrow width', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const boldHtml = `<strong>${LONG_TEXT}</strong>`;

    const perRunHeight = measureInlineRuns(doc, boldHtml, NARROW_WIDTH, 10);

    doc.font('Helvetica').fontSize(10);
    const flattenedHeight = doc.heightOfString(LONG_TEXT, { width: NARROW_WIDTH });

    expect(perRunHeight).toBeGreaterThanOrEqual(flattenedHeight);
  });

  it('is deterministic across repeated calls', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const html = 'plain <strong>bold</strong> and <em>italic</em> text for a table cell.';

    const first = measureInlineRuns(doc, html, 200, 10);
    const second = measureInlineRuns(doc, html, 200, 10);

    expect(first).toBe(second);
  });

  it('restores the doc font state (font name + size) after measuring', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.font('Helvetica').fontSize(9);
    const before = doc as unknown as { _font: { name: string }; _fontSize: number };
    const beforeFontName = before._font.name;
    const beforeFontSize = before._fontSize;

    measureInlineRuns(doc, `<strong>${LONG_TEXT}</strong>`, NARROW_WIDTH, 10);

    const after = doc as unknown as { _font: { name: string }; _fontSize: number };
    expect(after._font.name).toBe(beforeFontName);
    expect(after._fontSize).toBe(beforeFontSize);
  });
});
