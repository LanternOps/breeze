import { describe, expect, it } from 'vitest';
import {
  assignmentWriteAllowed,
  brandingScopeId,
  brandingWriteAllowed,
  resolvePartnerOrgBranding,
} from './helperBranding';

const set = { branding: { displayName: 'Example Assist', primaryColor: '#2255AA' } };

describe('resolvePartnerOrgBranding', () => {
  it('ignores site, device group and device candidates even when they carry branding', () => {
    const out = resolvePartnerOrgBranding([
      { level: 'device', priority: 0, inlineSettings: { branding: { displayName: 'Device' } } },
      { level: 'site', priority: 0, inlineSettings: { branding: { displayName: 'Site' } } },
      { level: 'device_group', priority: 0, inlineSettings: { branding: { displayName: 'Group' } } },
    ]);
    expect(out).toEqual({});
  });

  it('merges partner then organization field by field', () => {
    const out = resolvePartnerOrgBranding([
      { level: 'partner', priority: 0, inlineSettings: { branding: { companyName: 'Partner Co', primaryColor: '#111111' } } },
      { level: 'organization', priority: 0, inlineSettings: { branding: { companyName: 'Org Co' } } },
    ]);
    expect(out).toEqual({ companyName: 'Org Co', primaryColor: '#111111' });
  });

  it('within a level, the lowest assignment priority wins; ties keep input order', () => {
    const out = resolvePartnerOrgBranding([
      { level: 'organization', priority: 5, inlineSettings: { branding: { displayName: 'Late' } } },
      { level: 'organization', priority: 1, inlineSettings: { branding: { displayName: 'Early' } } },
      { level: 'partner', priority: 0, inlineSettings: { branding: { displayName: 'P1' } } },
      { level: 'partner', priority: 0, inlineSettings: { branding: { displayName: 'P2' } } },
    ]);
    expect(out).toEqual({ displayName: 'Early' });
  });

  it('a winner without branding does not fall through to a lower-priority sibling', () => {
    const out = resolvePartnerOrgBranding([
      { level: 'organization', priority: 0, inlineSettings: { enabled: true } },
      { level: 'organization', priority: 1, inlineSettings: set },
    ]);
    expect(out).toEqual({});
  });

  it('drops invalid persisted branding instead of trusting it', () => {
    const out = resolvePartnerOrgBranding([
      { level: 'partner', priority: 0, inlineSettings: { branding: { displayName: 'x'.repeat(61), companyName: 'OK' } } },
    ]);
    expect(out).toEqual({});
  });

  it('drops persisted branding carrying a bidi override or zero-width character (#9396)', () => {
    for (const companyName of ['Acme\u202Eytiruces', 'Mic\u200Brosoft']) {
      const out = resolvePartnerOrgBranding([
        { level: 'organization', priority: 0, inlineSettings: { branding: { companyName, primaryColor: '#2255AA' } } },
      ]);
      expect(out).toEqual({});
    }
  });

  it('returns empty when there are no candidates', () => {
    expect(resolvePartnerOrgBranding([])).toEqual({});
  });
});

describe('brandingScopeId', () => {
  it('is stable for the same partner and organization', () => {
    expect(brandingScopeId('p1', 'o1')).toBe(brandingScopeId('p1', 'o1'));
  });

  it('changes when either partner or organization changes', () => {
    expect(brandingScopeId('p1', 'o1')).not.toBe(brandingScopeId('p1', 'o2'));
    expect(brandingScopeId('p1', 'o1')).not.toBe(brandingScopeId('p2', 'o1'));
  });

  it('is opaque: 32 lowercase hex characters, not the raw ids', () => {
    const id = brandingScopeId('p1', 'o1');
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).not.toContain('p1');
  });
});

describe('brandingWriteAllowed (feature link door)', () => {
  it('allows writes that do not touch branding', () => {
    expect(brandingWriteAllowed(undefined, ['site', 'device'])).toBe(true);
  });

  it('allows clearing branding even when lower-level assignments exist', () => {
    expect(brandingWriteAllowed({}, ['site', 'device_group', 'device'])).toBe(true);
  });

  it('allows setting branding on a policy with only partner or organization assignments', () => {
    expect(brandingWriteAllowed(set.branding, ['partner', 'organization'])).toBe(true);
    expect(brandingWriteAllowed(set.branding, [])).toBe(true);
  });

  it.each(['site', 'device_group', 'device'])('rejects setting branding when a %s assignment exists', (level) => {
    expect(brandingWriteAllowed(set.branding, ['organization', level])).toBe(false);
  });
});

describe('assignmentWriteAllowed (assignment door)', () => {
  it('allows partner and organization assignments regardless of branding', () => {
    expect(assignmentWriteAllowed('partner', true)).toBe(true);
    expect(assignmentWriteAllowed('organization', true)).toBe(true);
  });

  it('allows lower-level assignments when the policy carries no branding', () => {
    expect(assignmentWriteAllowed('site', false)).toBe(true);
  });

  it.each(['site', 'device_group', 'device'])('rejects a %s assignment when the policy carries branding', (level) => {
    expect(assignmentWriteAllowed(level, true)).toBe(false);
  });
});
