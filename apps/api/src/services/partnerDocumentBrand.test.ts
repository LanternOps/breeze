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
});
