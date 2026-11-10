import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { partnerDocumentBrand, resolveDocumentBrand } from './partnerDocumentBrand';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('partnerDocumentBrand', () => {
  it('reads logo + colours from partners.settings.branding (Settings → Partner → Branding)', () => {
    expect(partnerDocumentBrand({ branding: { logoUrl: PNG, primaryColor: '#00bfa6', secondaryColor: '#0b1b2d' } }))
      .toEqual({ logoUrl: PNG, primaryColor: '#00bfa6', secondaryColor: '#0b1b2d' });
  });

  it('accepts an https logo URL and 3-digit hex', () => {
    expect(partnerDocumentBrand({ branding: { logoUrl: 'https://cdn.example.com/logo.png', primaryColor: '#0af' } }))
      .toEqual({ logoUrl: 'https://cdn.example.com/logo.png', primaryColor: '#0af', secondaryColor: null });
  });

  it('drops values a document cannot use safely', () => {
    expect(partnerDocumentBrand({ branding: { logoUrl: 'javascript:alert(1)', primaryColor: 'teal', secondaryColor: 'rgb(0,0,0)' } }))
      .toEqual({ logoUrl: null, primaryColor: null, secondaryColor: null });
    expect(partnerDocumentBrand({ branding: { logoUrl: 'http://insecure.example.com/l.png' } }).logoUrl).toBeNull();
  });

  it('tolerates missing or malformed settings', () => {
    const empty = { logoUrl: null, primaryColor: null, secondaryColor: null };
    expect(partnerDocumentBrand(null)).toEqual(empty);
    expect(partnerDocumentBrand('nope')).toEqual(empty);
    expect(partnerDocumentBrand({ branding: 'nope' })).toEqual(empty);
    expect(partnerDocumentBrand({ branding: { logoUrl: 42, primaryColor: ['#fff'] } })).toEqual(empty);
  });
});

describe('resolveDocumentBrand', () => {
  const partnerSettings = { branding: { logoUrl: PNG, primaryColor: '#00bfa6', secondaryColor: '#0b1b2d' } };

  it("falls back to the partner's branding when the customer org has no portal branding row", () => {
    expect(resolveDocumentBrand(undefined, partnerSettings)).toEqual({ logoUrl: PNG, primaryColor: '#00bfa6', secondaryColor: '#0b1b2d' });
  });

  it('an empty org value falls through to the partner (only a real value overrides)', () => {
    expect(resolveDocumentBrand({ logoUrl: '', primaryColor: '' }, partnerSettings))
      .toEqual({ logoUrl: PNG, primaryColor: '#00bfa6', secondaryColor: '#0b1b2d' });
  });

  it('a per-org portal_branding value wins field by field', () => {
    expect(resolveDocumentBrand({ logoUrl: 'org-logo.png', primaryColor: null }, partnerSettings))
      .toEqual({ logoUrl: 'org-logo.png', primaryColor: '#00bfa6', secondaryColor: '#0b1b2d' });
    expect(resolveDocumentBrand({ logoUrl: null, primaryColor: '#123456' }, partnerSettings).primaryColor).toBe('#123456');
  });

  // #9673: the secondary colour had no org level at all, so the org tab's field
  // could never change a document.
  it("the org's secondary colour overrides the partner's", () => {
    expect(resolveDocumentBrand({ secondaryColor: '#123456' }, partnerSettings).secondaryColor).toBe('#123456');
  });

  // The resolver can only honour what its caller selected, and a mocked DB hands
  // back the stubbed row whatever was selected. A quote path that leaves this
  // column out silently prints the partner's colour.
  it.each(['customerQuotePdf.ts', 'quoteLifecycle.ts', 'quoteBranding.ts', 'customerQuoteDocument.ts', 'reportBranding.ts'])(
    '%s selects the org secondary colour',
    (file) => {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).toContain('secondaryColor: portalBranding.secondaryColor');
    },
  );

  it('a blank or non-hex org secondary colour falls through to the partner', () => {
    expect(resolveDocumentBrand({ secondaryColor: '' }, partnerSettings).secondaryColor).toBe('#0b1b2d');
    expect(resolveDocumentBrand({ secondaryColor: null }, partnerSettings).secondaryColor).toBe('#0b1b2d');
    expect(resolveDocumentBrand({ secondaryColor: 'red;}' }, partnerSettings).secondaryColor).toBe('#0b1b2d');
  });
});
