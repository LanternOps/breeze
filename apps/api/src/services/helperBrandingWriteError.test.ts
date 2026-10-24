import { describe, expect, it } from 'vitest';
import { brandingWriteError, hasHelperBranding } from './helperBranding';

describe('brandingWriteError (feature link door)', () => {
  it('passes writes without a branding key', () => {
    expect(brandingWriteError({ enabled: true }, ['device'])).toBeNull();
    expect(brandingWriteError(undefined, ['device'])).toBeNull();
  });

  it('passes clearing branding even with lower-level assignments', () => {
    expect(brandingWriteError({ branding: {} }, ['site', 'device'])).toBeNull();
    expect(brandingWriteError({ branding: null }, ['site', 'device'])).toBeNull();
  });

  it('returns 400 with the validation errors for invalid branding', () => {
    const err = brandingWriteError({ branding: { displayName: 'x'.repeat(61) } }, ['organization']);
    expect(err).toEqual({ status: 400, error: 'Invalid Helper branding', details: ['length:displayName'] });
  });

  it('returns 409 when setting branding on a policy with a lower-level assignment', () => {
    const err = brandingWriteError({ branding: { displayName: 'Acme' } }, ['organization', 'site']);
    expect(err?.status).toBe(409);
  });

  it('passes valid branding on a partner/organization-only policy', () => {
    expect(brandingWriteError({ branding: { displayName: 'Acme' } }, ['partner', 'organization'])).toBeNull();
  });
});

describe('hasHelperBranding', () => {
  it('is true only for a non-empty branding object', () => {
    expect(hasHelperBranding({ branding: { displayName: 'Acme' } })).toBe(true);
    expect(hasHelperBranding({ branding: {} })).toBe(false);
    expect(hasHelperBranding({ branding: null })).toBe(false);
    expect(hasHelperBranding({ enabled: true })).toBe(false);
    expect(hasHelperBranding(null)).toBe(false);
  });
});
