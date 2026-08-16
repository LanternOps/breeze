import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { transaction: vi.fn() },
}));

import {
  ALLOWED_EXTENSIONS,
  MAX_UPLOAD_SIZE,
  getFileExtension,
  authorizeCatalogItemRead,
  resolveScopedOrgId,
} from './softwareVersionShared';

describe('softwareVersionShared', () => {
  it('keeps the historical installer extension allowlist and 500MB cap', () => {
    expect([...ALLOWED_EXTENSIONS].sort()).toEqual(['.deb', '.dmg', '.exe', '.msi', '.pkg']);
    expect(MAX_UPLOAD_SIZE).toBe(500 * 1024 * 1024);
  });

  it('extracts lowercase extensions and empty string when there is none', () => {
    expect(getFileExtension('Setup.MSI')).toBe('.msi');
    expect(getFileExtension('archive.tar.gz')).toBe('.gz');
    expect(getFileExtension('no-extension')).toBe('');
  });

  it('resolveScopedOrgId: org scope is pinned to its own org', () => {
    expect(resolveScopedOrgId({ scope: 'organization', orgId: 'org-1' })).toEqual({ orgId: 'org-1' });
    expect(resolveScopedOrgId({ scope: 'organization', orgId: 'org-1' }, 'org-2')).toEqual({
      error: 'Access to this organization denied',
      status: 403,
    });
  });

  it('resolveScopedOrgId: partner scope needs an accessible requested org or a single accessible org', () => {
    expect(
      resolveScopedOrgId({ scope: 'partner', orgId: null, accessibleOrgIds: ['org-9'] }, 'org-9'),
    ).toEqual({ orgId: 'org-9' });
    expect(
      resolveScopedOrgId({ scope: 'partner', orgId: null, accessibleOrgIds: ['org-9'] }, 'org-2'),
    ).toEqual({ error: 'Access to this organization denied', status: 403 });
    expect(resolveScopedOrgId({ scope: 'partner', orgId: null, accessibleOrgIds: ['org-9'] })).toEqual({
      orgId: 'org-9',
    });
    expect(
      resolveScopedOrgId({ scope: 'partner', orgId: null, accessibleOrgIds: ['a', 'b'] }),
    ).toEqual({ error: 'orgId is required for this scope', status: 400 });
  });

  it('resolveScopedOrgId: system scope passes any requested org through', () => {
    expect(resolveScopedOrgId({ scope: 'system', orgId: null }, 'org-x')).toEqual({ orgId: 'org-x' });
  });

  describe('authorizeCatalogItemRead', () => {
    const notFound = { error: 'Catalog item not found', status: 404 };
    // Multi-org partner admin: canAccessOrg true for both orgs — the exact
    // shape where canAccessOrg alone is too weak.
    const partnerAuth = {
      scope: 'partner' as const,
      orgId: null,
      accessibleOrgIds: ['org-a', 'org-b'],
      canAccessOrg: (orgId: string) => ['org-a', 'org-b'].includes(orgId),
    };

    it('narrows an org-owned row to the requested org even when canAccessOrg is true', () => {
      // The #3575 regression: acting as org A must not read org B's package.
      expect(authorizeCatalogItemRead(partnerAuth, 'org-b', 'org-a')).toEqual(notFound);
      expect(authorizeCatalogItemRead(partnerAuth, 'org-a', 'org-a')).toBeNull();
    });

    it('passes partner-wide rows (org_id NULL) with or without an org context', () => {
      expect(authorizeCatalogItemRead(partnerAuth, null, 'org-a')).toBeNull();
      expect(authorizeCatalogItemRead(partnerAuth, null, undefined)).toBeNull();
    });

    it('rejects an explicitly requested inaccessible org with 403 regardless of row', () => {
      expect(authorizeCatalogItemRead(partnerAuth, null, 'org-z')).toEqual({
        error: 'Access to this organization denied',
        status: 403,
      });
      expect(authorizeCatalogItemRead(partnerAuth, 'org-a', 'org-z')).toEqual({
        error: 'Access to this organization denied',
        status: 403,
      });
    });

    it('fleet view (no org resolves) falls back to canAccessOrg for org-owned rows', () => {
      expect(authorizeCatalogItemRead(partnerAuth, 'org-b', undefined)).toBeNull();
      expect(authorizeCatalogItemRead(partnerAuth, 'foreign-org', undefined)).toEqual(notFound);
    });

    it('org scope stays pinned to its own org', () => {
      const orgAuth = {
        scope: 'organization' as const,
        orgId: 'org-a',
        accessibleOrgIds: ['org-a'],
        canAccessOrg: (orgId: string) => orgId === 'org-a',
      };
      // No requestedOrgId: auth.orgId resolves, so narrowing still applies.
      expect(authorizeCatalogItemRead(orgAuth, 'org-b', undefined)).toEqual(notFound);
      expect(authorizeCatalogItemRead(orgAuth, 'org-a', undefined)).toBeNull();
      expect(authorizeCatalogItemRead(orgAuth, null, undefined)).toBeNull();
    });
  });
});
