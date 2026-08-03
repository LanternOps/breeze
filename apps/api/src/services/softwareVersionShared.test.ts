import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { transaction: vi.fn() },
}));

import {
  ALLOWED_EXTENSIONS,
  MAX_UPLOAD_SIZE,
  getFileExtension,
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
});
