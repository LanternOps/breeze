import { describe, expect, it } from 'vitest';
import { buildReportPdf, paletteForBranding, parseHexColor } from './reportPdf';

const opts = { reportType: 'compliance', generatedAt: 'Jun 10, 2026', timezone: 'UTC' };

function pdfOps(doc: ReturnType<typeof buildReportPdf>): string {
  return ((doc.internal as unknown as { pages: Array<string[] | undefined> }).pages ?? [])
    .filter((p): p is string[] => Array.isArray(p))
    .map((p) => p.join('\n'))
    .join('\n');
}

/** jsPDF writes fill colours as "r g b rg", each channel n/255 rounded to 2 or 3 places
 *  depending on the code path, trailing zeros trimmed — so match either. */
const ch = (n: number) => {
  const a = String(Number((n / 255).toFixed(3)));
  const b = String(Number((n / 255).toFixed(2)));
  return a === b ? a.replace('.', '\\.') : `(?:${a.replace('.', '\\.')}|${b.replace('.', '\\.')})`;
};
const rg = ([r, g, b]: [number, number, number]) => new RegExp(`${ch(r)} ${ch(g)} ${ch(b)} rg`);

describe('report PDF brand colours', () => {
  it('parses 3- and 6-digit hex and rejects anything else', () => {
    expect(parseHexColor('#7a1d18')).toEqual([122, 29, 24]);
    expect(parseHexColor('#ABC')).toEqual([170, 187, 204]);
    expect(parseHexColor('rgb(1,2,3)')).toBeNull();
    expect(parseHexColor('#12345')).toBeNull();
    expect(parseHexColor(null)).toBeNull();
  });

  it('keeps the Breeze palette when no primary is supplied', () => {
    const p = paletteForBranding({ name: 'Olive MSP', logoDataUrl: null, logoAspect: null });
    expect(p.primary).toEqual([47, 85, 198]);
    expect(p.teal).toEqual([14, 212, 197]);
  });

  it('uses the brand primary for the band and derives an accent when none is given', () => {
    const p = paletteForBranding({ name: 'Olive MSP', logoDataUrl: null, logoAspect: null, primaryColor: '#7a1d18' });
    expect(p.primary).toEqual([122, 29, 24]);
    expect(p.teal).not.toEqual([14, 212, 197]);
    // Status colours are meaning, never brand.
    expect(p.success).toEqual([42, 147, 98]);
    expect(p.danger).toEqual([221, 70, 60]);
  });

  it('darkens a light brand primary so white band text still reads', () => {
    const p = paletteForBranding({ name: 'Olive MSP', logoDataUrl: null, logoAspect: null, primaryColor: '#ffd166' });
    const [r, g, b] = p.primary;
    // Luminance must have dropped well below the pastel input.
    expect(r + g + b).toBeLessThan(255 + 209 + 102 - 150);
  });

  it('paints the header band in the brand colour and restores the default afterwards', () => {
    const branded = buildReportPdf([], { ...opts, branding: { name: 'Olive MSP', logoDataUrl: null, logoAspect: null, primaryColor: '#7a1d18', accentColor: '#f4a261' } });
    const ops = pdfOps(branded);
    expect(ops).toMatch(rg([122, 29, 24]));
    expect(ops).toMatch(rg([244, 162, 97]));
    expect(ops).not.toMatch(rg([47, 85, 198]));

    const plain = buildReportPdf([], { ...opts, branding: { name: 'Olive MSP', logoDataUrl: null, logoAspect: null } });
    expect(pdfOps(plain)).toMatch(rg([47, 85, 198]));
  });
});
