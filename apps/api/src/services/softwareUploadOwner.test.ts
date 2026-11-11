import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../middleware/auth';
import {
  authorizeUploadSessionAccess,
  softwarePackageObjectKey,
  uploadOwnerColumns,
  uploadOwnerOf,
  uploadOwnerSessionCondition,
} from './softwareUploadOwner';

const dialect = new PgDialect();
const render = (condition: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(condition);

function auth(overrides: Partial<AuthContext> & Record<string, unknown>): AuthContext {
  return {
    principal: 'user',
    user: { id: 'user-1', email: 'u@example.test', name: 'U' },
    canAccessOrg: (orgId: string) => ((overrides.accessibleOrgIds as string[] | undefined) ?? []).includes(orgId),
    ...overrides,
  } as unknown as AuthContext;
}

const fullPartnerAdmin = auth({ scope: 'partner', partnerId: 'partner-1', orgId: null, partnerOrgAccess: 'all', accessibleOrgIds: ['org-1', 'org-2'] });
const selectedPartnerUser = auth({ scope: 'partner', partnerId: 'partner-1', orgId: null, partnerOrgAccess: 'selected', accessibleOrgIds: ['org-1'] });
const otherPartnerAdmin = auth({ scope: 'partner', partnerId: 'partner-2', orgId: null, partnerOrgAccess: 'all', accessibleOrgIds: ['org-9'] });
const orgUser = auth({ scope: 'organization', partnerId: 'partner-1', orgId: 'org-1', accessibleOrgIds: ['org-1'] });
const systemAuth = auth({ scope: 'system', partnerId: null, orgId: null, accessibleOrgIds: null });

const partnerSession = { orgId: null, partnerId: 'partner-1' };
const orgSession = { orgId: 'org-1', partnerId: null };

describe('uploadOwnerOf / uploadOwnerColumns', () => {
  it('reads an org owner', () => {
    expect(uploadOwnerOf(orgSession)).toEqual({ kind: 'organization', orgId: 'org-1' });
  });

  it('reads a partner owner', () => {
    expect(uploadOwnerOf(partnerSession)).toEqual({ kind: 'partner', partnerId: 'partner-1' });
  });

  it('throws when neither or both owner columns are set', () => {
    expect(() => uploadOwnerOf({ orgId: null, partnerId: null })).toThrow();
    expect(() => uploadOwnerOf({ orgId: 'org-1', partnerId: 'partner-1' })).toThrow();
  });

  it('round-trips to insert columns with exactly one owner set', () => {
    expect(uploadOwnerColumns({ kind: 'organization', orgId: 'org-1' })).toEqual({ orgId: 'org-1', partnerId: null });
    expect(uploadOwnerColumns({ kind: 'partner', partnerId: 'partner-1' })).toEqual({ orgId: null, partnerId: 'partner-1' });
  });
});

describe('uploadOwnerSessionCondition', () => {
  it('org owner filters on org_id only', () => {
    const q = render(uploadOwnerSessionCondition({ kind: 'organization', orgId: 'org-1' }));
    expect(q.sql).toBe('"software_upload_sessions"."org_id" = $1');
    expect(q.params).toEqual(['org-1']);
  });

  it('partner owner requires org_id IS NULL and the partner id', () => {
    const q = render(uploadOwnerSessionCondition({ kind: 'partner', partnerId: 'partner-1' }));
    expect(q.sql).toBe('("software_upload_sessions"."org_id" is null and "software_upload_sessions"."partner_id" = $1)');
    expect(q.params).toEqual(['partner-1']);
  });
});

describe('softwarePackageObjectKey', () => {
  it('keeps the org layout for an org owner', () => {
    expect(softwarePackageObjectKey({ kind: 'organization', orgId: 'org-1' }, 'cat-1', 'ver-1', 'installer.msi'))
      .toBe('software/org-1/cat-1/ver-1/installer.msi');
  });

  it('stores one partner-keyed object for a partner owner', () => {
    expect(softwarePackageObjectKey({ kind: 'partner', partnerId: 'partner-1' }, 'cat-1', 'ver-1', 'installer.msi'))
      .toBe('software/partner/partner-1/cat-1/ver-1/installer.msi');
  });
});

describe('authorizeUploadSessionAccess', () => {
  describe('partner-owned session', () => {
    it('system scope → allowed', () => {
      expect(authorizeUploadSessionAccess(systemAuth, partnerSession, undefined)).toBeNull();
    });

    it('full-partner admin of the owning partner → allowed, with or without ?orgId', () => {
      expect(authorizeUploadSessionAccess(fullPartnerAdmin, partnerSession, undefined)).toBeNull();
      expect(authorizeUploadSessionAccess(fullPartnerAdmin, partnerSession, 'org-2')).toBeNull();
    });

    it('partner user with orgAccess "selected" → 403', () => {
      expect(authorizeUploadSessionAccess(selectedPartnerUser, partnerSession, undefined)).toEqual({
        error: 'Modifying a partner-wide package requires full partner org access (orgAccess must be "all")',
        status: 403,
      });
    });

    it('another partner → 404 Upload session not found', () => {
      expect(authorizeUploadSessionAccess(otherPartnerAdmin, partnerSession, undefined))
        .toEqual({ error: 'Upload session not found', status: 404 });
    });

    it('org scope → 404 Upload session not found', () => {
      expect(authorizeUploadSessionAccess(orgUser, partnerSession, 'org-1'))
        .toEqual({ error: 'Upload session not found', status: 404 });
    });
  });

  describe('org-owned session', () => {
    it('the org\'s own user → allowed', () => {
      expect(authorizeUploadSessionAccess(orgUser, orgSession, undefined)).toBeNull();
      expect(authorizeUploadSessionAccess(orgUser, orgSession, 'org-1')).toBeNull();
    });

    it('?orgId resolving to a different org → 404 Upload session not found', () => {
      expect(authorizeUploadSessionAccess(fullPartnerAdmin, orgSession, 'org-2'))
        .toEqual({ error: 'Upload session not found', status: 404 });
    });

    it('a forbidden ?orgId keeps the resolver\'s 403', () => {
      expect(authorizeUploadSessionAccess(orgUser, orgSession, 'org-2'))
        .toEqual({ error: 'Access to this organization denied', status: 403 });
    });

    it('a multi-org partner caller with no ?orgId keeps the resolver\'s 400', () => {
      expect(authorizeUploadSessionAccess(fullPartnerAdmin, orgSession, undefined))
        .toEqual({ error: 'orgId is required for this scope', status: 400 });
    });

    it('a partner caller whose ?orgId names the session org → allowed (any org writer may drive it)', () => {
      expect(authorizeUploadSessionAccess(selectedPartnerUser, orgSession, 'org-1')).toBeNull();
    });
  });
});
