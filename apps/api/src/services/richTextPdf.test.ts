import { describe, it, expect } from 'vitest';
import PDFDocument from 'pdfkit';
import { parseRichText, renderRichTextIntoPdf } from './richTextPdf';

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
