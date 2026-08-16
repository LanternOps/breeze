// Unit tests for the document theme registry (Task 4 of the proposal
// presentation system). Covers safe-default resolution of unknown theme/page
// size values, the classic theme's use of pdfkit built-ins (no font file I/O),
// and the condensed theme's real font registration against a live PDFDocument.

import { describe, it, expect, vi } from 'vitest';
import PDFDocument from 'pdfkit';
import { resolveThemeId, resolvePageSize, pdfPageSize, registerThemeFonts } from './documentThemes';

describe('documentThemes', () => {
  it('resolves unknown values to safe defaults', () => {
    expect(resolveThemeId('brutalist')).toBe('classic');
    expect(resolveThemeId(null)).toBe('classic');
    expect(resolvePageSize('tabloid')).toBe('a4');
    expect(pdfPageSize('letter')).toBe('LETTER');
  });

  it('classic returns pdfkit built-ins without touching doc', () => {
    const doc = { registerFont: vi.fn() } as unknown as PDFKit.PDFDocument;
    const fonts = registerThemeFonts(doc, 'classic');
    expect(fonts.body).toEqual({
      regular: 'Helvetica',
      bold: 'Helvetica-Bold',
      italic: 'Helvetica-Oblique',
      boldItalic: 'Helvetica-BoldOblique',
    });
    expect(fonts.heading).toEqual({ regular: 'Helvetica', bold: 'Helvetica-Bold' });
    expect(doc.registerFont).not.toHaveBeenCalled();
  });

  it('condensed registers real font files on a real document', () => {
    const doc = new PDFDocument({ size: 'A4' });
    const fonts = registerThemeFonts(doc, 'condensed');
    expect(fonts.heading.regular).toBe('Doc-Heading');
    doc.font('Doc-Heading'); // throws if registration failed
    doc.end();
  });
});
