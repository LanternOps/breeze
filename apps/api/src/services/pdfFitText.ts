/**
 * Shrink-to-fit for single-line pdfkit cells (#3777 review F10).
 *
 * Invoice/quote money cells are fixed-width boxes drawn with `lineBreak: false`
 * (row heights are measured from the description column and the summary rows
 * advance by constants). pdfkit's behaviour for an over-wide single-line string
 * is NOT a clip into the gutter: it silently truncates the string to what fits
 * — `CHF 9'999'999'999.99` prints as `CHF 9'999'999'99`, a different number on
 * a legal document. The boxes are sized for ~1M, but the schema permits
 * numeric(12,2), so the renderer must adapt the font size instead of trusting
 * the box.
 *
 * Returns the largest size ≤ `preferred` (stepping down by 0.5pt to `floor`)
 * at which `text` fits `maxWidth` in the doc's CURRENT font, and leaves the doc
 * set to that size so the caller can chain `.text(...)`. At `floor` the text
 * may still overflow; the floor only guards legibility.
 */
export function fitFontSize(doc: PDFKit.PDFDocument, text: string, maxWidth: number, preferred: number, floor = 6): number {
  let size = preferred;
  doc.fontSize(size);
  while (size > floor && doc.widthOfString(text) > maxWidth) {
    size = Math.max(floor, size - 0.5);
    doc.fontSize(size);
  }
  return size;
}
