import { describe, it, expect } from 'vitest';
import PDFDocument from 'pdfkit';
import { formatMoneyForPdf } from './pdfMoney';
import { fitFontSize } from './pdfFitText';

describe('fitFontSize', () => {
  it('keeps the preferred size when the text already fits', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.font('Helvetica');
    expect(fitFontSize(doc, '$100.00', 80, 10)).toBe(10);
    doc.end();
  });

  it('steps the size down until a schema-maximum CHF figure fits the summary box at bold 14', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.font('Helvetica-Bold');
    const text = formatMoneyForPdf(9999999999.99, 'CHF', 'de-CH');
    const box = (doc.page.width - 100) * 0.24;
    doc.fontSize(14);
    expect(doc.widthOfString(text)).toBeGreaterThan(box); // the finding
    const size = fitFontSize(doc, text, box, 14);
    expect(size).toBeLessThan(14);
    expect(size).toBeGreaterThanOrEqual(6);
    expect(doc.widthOfString(text)).toBeLessThanOrEqual(box); // doc left at the fitted size
    doc.end();
  });

  it('never goes below the floor, even when the text still overflows', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.font('Helvetica');
    expect(fitFontSize(doc, 'x'.repeat(200), 10, 10, 6)).toBe(6);
    doc.end();
  });
});
