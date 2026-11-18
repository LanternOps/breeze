// Unit tests for the document theme registry (Task 4 of the proposal
// presentation system). Covers safe-default resolution of unknown theme/page
// size values, the classic theme's use of pdfkit built-ins (no font file I/O),
// and the condensed theme's real font registration against a live PDFDocument.

import { describe, it, expect, vi, afterEach } from 'vitest';
import PDFDocument from 'pdfkit';
import { resolveThemeId, resolvePageSize, pdfPageSize, registerThemeFonts, resolvePartnerPageSize, deploymentDefaultPageSize, partnerPageSizeWire } from './documentThemes';

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

// #12097: a partner that never chose a page size prints on its region default.
describe('resolvePartnerPageSize', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('unset partner, US billing country → Letter on every deployment', () => {
    vi.stubEnv('BREEZE_REGION', 'eu');
    expect(resolvePartnerPageSize({ documentPageSize: null, billingAddressCountry: 'US' })).toBe('letter');
  });

  it('unset partner, DE company country → A4 on every deployment', () => {
    vi.stubEnv('BREEZE_REGION', 'us');
    expect(resolvePartnerPageSize({ documentPageSize: null, settings: { address: { country: 'DE' } } })).toBe('a4');
  });

  it('unknown country → A4 on the EU deployment, Letter elsewhere', () => {
    vi.stubEnv('BREEZE_REGION', 'eu');
    expect(deploymentDefaultPageSize()).toBe('a4');
    expect(resolvePartnerPageSize({ documentPageSize: null })).toBe('a4');
    expect(resolvePartnerPageSize(undefined)).toBe('a4');
    vi.stubEnv('BREEZE_REGION', 'us');
    expect(deploymentDefaultPageSize()).toBe('letter');
    expect(resolvePartnerPageSize({ documentPageSize: null })).toBe('letter');
    vi.stubEnv('BREEZE_REGION', '');
    expect(resolvePartnerPageSize({ documentPageSize: null })).toBe('letter');
  });

  it('an explicit choice wins', () => {
    vi.stubEnv('BREEZE_REGION', 'eu');
    expect(resolvePartnerPageSize({ documentPageSize: 'letter', billingAddressCountry: 'DE' })).toBe('letter');
  });
});

// #12097 wire shape: what partner-settings responses carry for the page size.
describe('partnerPageSizeWire', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('a partner with no choice: documentPageSize is the region default, the choice is null', () => {
    vi.stubEnv('BREEZE_REGION', 'eu');
    expect(partnerPageSizeWire({ documentPageSize: null, billingAddressCountry: 'CA', settings: null })).toEqual({
      documentPageSize: 'letter', documentPageSizeChoice: null, documentPageSizeFallback: 'a4',
    });
  });

  it('an explicit choice is both the printed size and the choice', () => {
    vi.stubEnv('BREEZE_REGION', 'us');
    expect(partnerPageSizeWire({ documentPageSize: 'a4', billingAddressCountry: 'US', settings: null })).toEqual({
      documentPageSize: 'a4', documentPageSizeChoice: 'a4', documentPageSizeFallback: 'letter',
    });
  });
});
