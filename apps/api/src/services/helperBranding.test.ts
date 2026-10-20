import { describe, expect, it } from 'vitest';
import {
  TEXT_LIMITS,
  buildBrandingDecision,
  mergeBrandingLayers,
  validateBrandingValues,
} from './helperBranding';

describe('validateBrandingValues', () => {
  it('accepts a valid subtree and returns the same values', () => {
    const input = { displayName: 'Example Assist', companyName: 'Example MSP', welcomeTitle: 'Welcome', primaryColor: '#2255AA' };
    expect(validateBrandingValues(input)).toEqual({ ok: true, value: input });
  });

  it('rejects non-object input', () => {
    expect(validateBrandingValues(null).ok).toBe(false);
    expect(validateBrandingValues([]).ok).toBe(false);
    expect(validateBrandingValues('Acme').ok).toBe(false);
  });

  it('counts Unicode code points, not UTF-16 units', () => {
    const sixtyEmoji = '😀'.repeat(60); // 60 code points, 120 UTF-16 units
    expect(validateBrandingValues({ displayName: sixtyEmoji }).ok).toBe(true);
    expect(validateBrandingValues({ displayName: `${sixtyEmoji}x` }).ok).toBe(false);
  });

  it.each(Object.entries(TEXT_LIMITS))('enforces the %s limit at %i code points', (field, max) => {
    expect(validateBrandingValues({ [field]: 'a'.repeat(max) }).ok).toBe(true);
    expect(validateBrandingValues({ [field]: 'a'.repeat(max + 1) }).ok).toBe(false);
  });

  it('rejects control characters in text fields', () => {
    expect(validateBrandingValues({ companyName: 'Acme\u0007' }).ok).toBe(false);
    expect(validateBrandingValues({ welcomeMessage: 'line1\nline2' }).ok).toBe(false);
  });

  // #9396: invisible and reordering characters can hide or reverse sender text in the toast.
  it.each([
    ['U+202E right-to-left override', 'Acme\u202Eytiruces tfosorciM'],
    ['U+200B zero-width space', 'Mic\u200Brosoft'],
    ['U+202A left-to-right embedding', 'Acme\u202AIT'],
    ['U+2069 pop directional isolate', 'Acme\u2069IT'],
    ['U+2060 word joiner', 'Mic\u2060rosoft'],
    ['U+FEFF zero-width no-break space', '\uFEFFAcme'],
    ['U+2066 left-to-right isolate', 'Acme\u2066IT'],
    ['U+E000 private use', 'Acme\uE000'],
    ['lone surrogate U+D800', 'Acme\uD800'],
    ['U+2028 line separator', 'Acme\u2028IT'],
    ['U+2029 paragraph separator', 'Acme\u2029IT'],
  ])('rejects %s in every text field', (_label, payload) => {
    for (const field of Object.keys(TEXT_LIMITS)) {
      expect(validateBrandingValues({ [field]: payload })).toEqual({ ok: false, errors: [`control:${field}`] });
    }
  });

  // Allowlist: ZWNJ/ZWJ are required by Persian and Indic scripts and by emoji
  // sequences; unassigned code points are allowed so a Unicode table older than
  // the emoji does not refuse it.
  it.each([
    ['ZWNJ in a Persian name', 'می\u200Cخواهم'],
    ['ZWNJ in a Hindi/Devanagari name', 'क्\u200Cष'],
    ['emoji ZWJ sequence', 'Acme 👩\u200D💻'],
    ['unassigned code point', 'Acme \u0378'],
  ])('accepts %s', (_label, name) => {
    expect(validateBrandingValues({ companyName: name })).toEqual({ ok: true, value: { companyName: name } });
  });

  it('still rejects an RLO payload alongside an allowed ZWNJ', () => {
    expect(validateBrandingValues({ companyName: 'می\u200Cخواهم\u202E' })).toEqual({ ok: false, errors: ['control:companyName'] });
  });

  it('still accepts ordinary non-ASCII names', () => {
    for (const name of ['Société Générale IT', 'Müller & Söhne', '株式会社テスト', 'Acme IT 😀']) {
      expect(validateBrandingValues({ companyName: name }).ok).toBe(true);
    }
  });

  it('rejects empty text fields', () => {
    expect(validateBrandingValues({ displayName: '' }).ok).toBe(false);
  });

  it('accepts strict #RRGGBB colours only', () => {
    expect(validateBrandingValues({ primaryColor: '#2255AA' }).ok).toBe(true);
    expect(validateBrandingValues({ accentColor: '#2255aa' }).ok).toBe(true);
    for (const bad of ['#225', '#2255AAFF', 'red', 'rgb(0,0,0)', 'url(x)', '2255AA', '#GG55AA']) {
      expect(validateBrandingValues({ primaryColor: bad }).ok).toBe(false);
    }
  });

  it('rejects unknown keys inside the branding subtree', () => {
    expect(validateBrandingValues({ displayName: 'Acme', css: 'body{}' }).ok).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(validateBrandingValues({ displayName: 5 }).ok).toBe(false);
    expect(validateBrandingValues({ primaryColor: null }).ok).toBe(false);
  });
});

describe('mergeBrandingLayers', () => {
  it('merges field by field with later layers winning (partner, then organization)', () => {
    const partner = { companyName: 'Partner Co', primaryColor: '#111111' };
    const organization = { companyName: 'Org Co' };
    expect(mergeBrandingLayers(partner, organization)).toEqual({ companyName: 'Org Co', primaryColor: '#111111' });
  });

  it('skips absent layers and undefined fields (absent means Breeze default)', () => {
    expect(mergeBrandingLayers(undefined, null, { displayName: 'A' })).toEqual({ displayName: 'A' });
    expect(mergeBrandingLayers({ displayName: 'A' }, { displayName: undefined })).toEqual({ displayName: 'A' });
  });
});

describe('buildBrandingDecision', () => {
  it('returns cleared when no partner or organization branding resolved', () => {
    expect(buildBrandingDecision({}, 'scope-1')).toEqual({ state: 'cleared' });
  });

  it('returns set with the opaque scope id and the effective values', () => {
    expect(buildBrandingDecision({ displayName: 'Example Assist' }, 'scope-1')).toEqual({
      state: 'set',
      scopeId: 'scope-1',
      values: { displayName: 'Example Assist' },
    });
  });
});
