/**
 * Unit tests for the org archive HTTP endpoints (org-lifecycle Wave 4, Task 2).
 *
 * The lifecycle service is mocked: this suite proves the route middleware,
 * suspended/archived-compatible tenancy check, validation, response mapping,
 * and audit contract.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { orgRows } = vi.hoisted(() => ({
  orgRows: {
    current: [] as Array<{
      id: string;
      partnerId: string;
      name: string;
      status: string;
    }>,
  },
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(orgRows.current.slice(0, 1))),
        })),
      })),
    })),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('../db/schema', () => ({
  organizations: {
    id: { __column: 'organizations.id' },
    partnerId: { __column: 'organizations.partnerId' },
    name: { __column: 'organizations.name' },
    status: { __column: 'organizations.status' },
  },
}));

vi.mock('drizzle-orm', async (importActual) => {
  const actual = await importActual<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn((column: unknown, value: unknown) => ({ __eq: { column, value } })),
  };
});

const { writeRouteAuditMock, writeAuditEventMock } = vi.hoisted(() => ({
  writeRouteAuditMock: vi.fn(),
  writeAuditEventMock: vi.fn(),
}));
vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: writeRouteAuditMock,
  writeAuditEvent: writeAuditEventMock,
}));

const { beginOrgArchiveMock, restoreOrgFromArchiveMock } = vi.hoisted(() => ({
  beginOrgArchiveMock: vi.fn(),
  restoreOrgFromArchiveMock: vi.fn(),
}));
vi.mock('../services/orgArchive', () => {
  class OrgArchiveStateError extends Error {
    constructor(
      message: string,
      readonly currentStatus: string | null = null,
    ) {
      super(message);
      this.name = 'OrgArchiveStateError';
    }
  }
  return {
    OrgArchiveStateError,
    beginOrgArchive: beginOrgArchiveMock,
    restoreOrgFromArchive: restoreOrgFromArchiveMock,
  };
});

// The per-org selection boundary (review fix C-B) is a separate system-context
// read; mocked here so the db fixture above stays the org row only. Its own
// fail-closed behaviour is covered by services/partnerOrgSelection.test.ts.
const { mayReachOrgMock } = vi.hoisted(() => ({ mayReachOrgMock: vi.fn(async () => true) }));
vi.mock('../services/partnerOrgSelection', () => ({
  partnerMemberMayReachOrg: mayReachOrgMock,
}));

const { permissionAllowed } = vi.hoisted(() => ({
  permissionAllowed: { current: true },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn((...scopes: string[]) => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Not authenticated' }, 401);
    if (!scopes.includes(auth.scope)) {
      return c.json({ error: 'Insufficient permissions' }, 403);
    }
    return next();
  }),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (!permissionAllowed.current) {
      return c.json({ error: 'Insufficient permissions' }, 403);
    }
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Not authenticated' }, 401);
    if (auth.token?.mfa === false) {
      return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
    }
    return next();
  }),
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { OrgArchiveStateError } from '../services/orgArchive';
import { orgArchiveRoutes } from './orgArchive';

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARTNER_ID = 'partner-1';
const OTHER_PARTNER_ID = 'partner-2';
const PURGE_AT = new Date('2026-11-24T12:00:00.000Z');

type FakeAuth = {
  user: { id: string; email: string; name?: string };
  token: { mfa?: boolean };
  scope: 'system' | 'partner' | 'organization';
  partnerId: string | null;
  partnerOrgAccess: 'all' | 'selected' | 'none' | null;
  orgId?: string | null;
  canAccessOrg: (orgId: string) => boolean;
};

function setAuthContext(overrides: Partial<FakeAuth> = {}) {
  const auth: FakeAuth = {
    user: { id: 'user-1', email: 'tech@example.com', name: 'Tech' },
    token: { mfa: true },
    scope: 'partner',
    partnerId: PARTNER_ID,
    partnerOrgAccess: 'all',
    orgId: null,
    canAccessOrg: () => true,
    ...overrides,
  };
  vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
    c.set('auth', auth);
    return next();
  });
}

function buildApp() {
  const app = new Hono();
  app.route('/orgs', orgArchiveRoutes);
  return app;
}

async function postJson(path: string, body?: unknown) {
  return buildApp().request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('org archive routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionAllowed.current = true;
    orgRows.current = [
      {
        id: ORG_ID,
        partnerId: PARTNER_ID,
        name: 'Acme Corp',
        status: 'active',
      },
    ];
    mayReachOrgMock.mockResolvedValue(true);
    beginOrgArchiveMock.mockResolvedValue({ status: 'offboarding', purgeAt: PURGE_AT });
    restoreOrgFromArchiveMock.mockResolvedValue({
      status: 'active',
      recreateRequired: ['Agents that completed the archive uninstall must be re-enrolled.'],
      aborted: false,
      uninstallsCancelled: 0,
    });
    setAuthContext();
  });

  describe('POST /orgs/organizations/:id/archive', () => {
    it('returns 202, calls the service with the requested retention, and audits the target org', async () => {
      const res = await postJson(`/orgs/organizations/${ORG_ID}/archive`, {
        retentionDays: 30,
      });

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({
        status: 'offboarding',
        purgeAt: PURGE_AT.toISOString(),
      });
      expect(beginOrgArchiveMock).toHaveBeenCalledWith({
        orgId: ORG_ID,
        retentionDays: 30,
        actor: 'user-1',
      });
      expect(writeRouteAuditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          orgId: ORG_ID,
          action: 'org.archive.requested',
          resourceType: 'organization',
          resourceId: ORG_ID,
          resourceName: 'Acme Corp',
          details: expect.objectContaining({ retentionDays: 30 }),
        }),
      );
    });

    it('serializes purgeAt as an ISO string in the audit details, not a Date object', async () => {
      await postJson(`/orgs/organizations/${ORG_ID}/archive`, { retentionDays: 30 });

      const isoPurgeAt = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/);
      expect(writeRouteAuditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'org.archive.requested',
          details: expect.objectContaining({ purgeAt: isoPurgeAt }),
        }),
      );
      expect(writeAuditEventMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'org.archive.requested',
          details: expect.objectContaining({ purgeAt: isoPurgeAt }),
        }),
      );
    });

    it('passes null retention through as never purge', async () => {
      beginOrgArchiveMock.mockResolvedValueOnce({ status: 'archived', purgeAt: null });
      const res = await postJson(`/orgs/organizations/${ORG_ID}/archive`, {
        retentionDays: null,
      });

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: 'archived', purgeAt: null });
      expect(beginOrgArchiveMock).toHaveBeenCalledWith(
        expect.objectContaining({ retentionDays: null }),
      );
    });

    it('passes an absent retention through for the service env default', async () => {
      const res = await postJson(`/orgs/organizations/${ORG_ID}/archive`, {});

      expect(res.status).toBe(202);
      expect(beginOrgArchiveMock).toHaveBeenCalledWith(
        expect.objectContaining({ retentionDays: undefined }),
      );
      expect(writeRouteAuditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          details: expect.objectContaining({
            retentionDays: 'default',
            purgeAt: PURGE_AT.toISOString(),
          }),
        }),
      );
    });

    it.each([0, 3651])('returns 400 for retentionDays=%s', async (retentionDays) => {
      const res = await postJson(`/orgs/organizations/${ORG_ID}/archive`, {
        retentionDays,
      });

      expect(res.status).toBe(400);
      expect(beginOrgArchiveMock).not.toHaveBeenCalled();
    });

    it('maps a service retention RangeError to 400', async () => {
      beginOrgArchiveMock.mockRejectedValueOnce(new RangeError('bad retention'));
      const res = await postJson(`/orgs/organizations/${ORG_ID}/archive`, {});

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('bad retention');
    });

    it('maps an invalid archive lifecycle state to 409', async () => {
      beginOrgArchiveMock.mockRejectedValueOnce(
        new OrgArchiveStateError('Organization cannot be archived', 'archived'),
      );
      const res = await postJson(`/orgs/organizations/${ORG_ID}/archive`, {});

      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('Organization cannot be archived');
    });

    it('does not use canAccessOrg for a same-partner suspended target', async () => {
      // canAccessOrg is false for EVERY member on a suspended/archived target
      // (computeAccessibleOrgIds allowlists active|trial), so it cannot be the
      // boundary here — the raw partner_users selection is (see below).
      orgRows.current[0]!.status = 'suspended';
      setAuthContext({ canAccessOrg: () => false });
      const res = await postJson(`/orgs/organizations/${ORG_ID}/archive`, {});

      expect(res.status).toBe(202);
      expect(beginOrgArchiveMock).toHaveBeenCalled();
    });

    it('returns a 404-shaped response for a target belonging to another partner', async () => {
      orgRows.current[0]!.partnerId = OTHER_PARTNER_ID;
      const res = await postJson(`/orgs/organizations/${ORG_ID}/archive`, {});

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Organization not found' });
      expect(beginOrgArchiveMock).not.toHaveBeenCalled();
    });

    it('rejects an organization-scope token', async () => {
      setAuthContext({ scope: 'organization', partnerId: null, orgId: ORG_ID });
      const res = await postJson(`/orgs/organizations/${ORG_ID}/archive`, {});

      expect(res.status).toBe(403);
      expect(beginOrgArchiveMock).not.toHaveBeenCalled();
    });

    it('rejects an unauthenticated request', async () => {
      vi.mocked(authMiddleware).mockImplementation((_c: any, next: any) => next());
      const res = await postJson(`/orgs/organizations/${ORG_ID}/archive`, {});

      expect(res.status).toBe(401);
      expect(beginOrgArchiveMock).not.toHaveBeenCalled();
    });

    it('rejects a caller without organization write permission', async () => {
      permissionAllowed.current = false;
      const res = await postJson(`/orgs/organizations/${ORG_ID}/archive`, {});

      expect(res.status).toBe(403);
      expect(beginOrgArchiveMock).not.toHaveBeenCalled();
    });

    it('rejects partner scope without a partner context', async () => {
      setAuthContext({ partnerId: null });
      const res = await postJson(`/orgs/organizations/${ORG_ID}/archive`, {});

      expect(res.status).toBe(400);
      expect(beginOrgArchiveMock).not.toHaveBeenCalled();
    });

    it('lets system scope resolve the target partner from the organization row', async () => {
      setAuthContext({ scope: 'system', partnerId: null });
      const res = await postJson(`/orgs/organizations/${ORG_ID}/archive`, {});

      expect(res.status).toBe(202);
      expect(writeRouteAuditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          details: expect.objectContaining({ partnerId: PARTNER_ID }),
        }),
      );
    });

    it('rejects a request without MFA', async () => {
      setAuthContext({ token: { mfa: false } });
      const res = await postJson(`/orgs/organizations/${ORG_ID}/archive`, {});

      expect(res.status).toBe(403);
      expect(beginOrgArchiveMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /orgs/organizations/:id/restore', () => {
    it('returns the restored status with recreateRequired and audits the restored org', async () => {
      orgRows.current[0]!.status = 'archived';
      const recreateRequired = [
        'Agents that completed the archive uninstall must be re-enrolled.',
      ];
      restoreOrgFromArchiveMock.mockResolvedValueOnce({
        status: 'active', recreateRequired, aborted: false, uninstallsCancelled: 0,
      });

      const res = await postJson(`/orgs/organizations/${ORG_ID}/restore`, {});

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: 'active', recreateRequired, aborted: false, uninstallsCancelled: 0,
      });
      expect(restoreOrgFromArchiveMock).toHaveBeenCalledWith({
        orgId: ORG_ID,
        actor: 'user-1',
      });
      expect(writeRouteAuditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          orgId: ORG_ID,
          action: 'org.archive.restored',
          resourceType: 'organization',
          resourceId: ORG_ID,
          resourceName: 'Acme Corp',
          details: expect.objectContaining({ recreateRequired, restoredStatus: 'active' }),
        }),
      );
    });

    // Review fix I-3: restore is status-PRESERVING, so the route must report
    // whatever came back, not the hard-coded 'active' it used to send.
    it('reports a suspended org restoring to suspended, not active', async () => {
      orgRows.current[0]!.status = 'archived';
      restoreOrgFromArchiveMock.mockResolvedValueOnce({
        status: 'suspended', recreateRequired: [], aborted: false, uninstallsCancelled: 0,
      });

      const res = await postJson(`/orgs/organizations/${ORG_ID}/restore`, {});

      expect((await res.json()).status).toBe('suspended');
    });

    // Review fix I-4: the abort edge surfaces the cancellation count so the
    // operator knows the drain was actually stopped.
    it('reports an aborted drain with the uninstalls it cancelled', async () => {
      orgRows.current[0]!.status = 'offboarding';
      restoreOrgFromArchiveMock.mockResolvedValueOnce({
        status: 'active', recreateRequired: [], aborted: true, uninstallsCancelled: 12,
      });

      const res = await postJson(`/orgs/organizations/${ORG_ID}/restore`, {});

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ aborted: true, uninstallsCancelled: 12 });
    });

    it('maps a purging restore refusal to 410', async () => {
      orgRows.current[0]!.status = 'purging';
      restoreOrgFromArchiveMock.mockRejectedValueOnce(
        new OrgArchiveStateError('Organization is not archived'),
      );

      const res = await postJson(`/orgs/organizations/${ORG_ID}/restore`, {});

      expect(res.status).toBe(410);
      expect((await res.json()).error).toMatch(/already purging/i);
      expect(restoreOrgFromArchiveMock).toHaveBeenCalled();
      expect(writeRouteAuditMock).not.toHaveBeenCalled();
    });

    it('maps any other restore state refusal to 409', async () => {
      orgRows.current[0]!.status = 'active';
      restoreOrgFromArchiveMock.mockRejectedValueOnce(
        new OrgArchiveStateError('Organization is not archived'),
      );

      const res = await postJson(`/orgs/organizations/${ORG_ID}/restore`, {});

      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('Organization is not archived');
      expect(writeRouteAuditMock).not.toHaveBeenCalled();
    });

    it('returns a 404-shaped response for a target belonging to another partner', async () => {
      orgRows.current[0]!.partnerId = OTHER_PARTNER_ID;
      const res = await postJson(`/orgs/organizations/${ORG_ID}/restore`, {});

      expect(res.status).toBe(404);
      expect(restoreOrgFromArchiveMock).not.toHaveBeenCalled();
    });

    it('rejects an organization-scope token', async () => {
      setAuthContext({ scope: 'organization', partnerId: null, orgId: ORG_ID });
      const res = await postJson(`/orgs/organizations/${ORG_ID}/restore`, {});

      expect(res.status).toBe(403);
      expect(restoreOrgFromArchiveMock).not.toHaveBeenCalled();
    });

    it('rejects an unauthenticated request', async () => {
      vi.mocked(authMiddleware).mockImplementation((_c: any, next: any) => next());
      const res = await postJson(`/orgs/organizations/${ORG_ID}/restore`, {});

      expect(res.status).toBe(401);
      expect(restoreOrgFromArchiveMock).not.toHaveBeenCalled();
    });

    it('rejects a caller without organization write permission', async () => {
      permissionAllowed.current = false;
      const res = await postJson(`/orgs/organizations/${ORG_ID}/restore`, {});

      expect(res.status).toBe(403);
      expect(restoreOrgFromArchiveMock).not.toHaveBeenCalled();
    });

    it('rejects partner scope without a partner context', async () => {
      setAuthContext({ partnerId: null });
      const res = await postJson(`/orgs/organizations/${ORG_ID}/restore`, {});

      expect(res.status).toBe(400);
      expect(restoreOrgFromArchiveMock).not.toHaveBeenCalled();
    });

    it('lets system scope restore an archived target', async () => {
      orgRows.current[0]!.status = 'archived';
      setAuthContext({ scope: 'system', partnerId: null });
      const res = await postJson(`/orgs/organizations/${ORG_ID}/restore`, {});

      expect(res.status).toBe(200);
      expect(restoreOrgFromArchiveMock).toHaveBeenCalledWith({
        orgId: ORG_ID,
        actor: 'user-1',
      });
    });

    it('rejects a request without MFA', async () => {
      setAuthContext({ token: { mfa: false } });
      const res = await postJson(`/orgs/organizations/${ORG_ID}/restore`, {});

      expect(res.status).toBe(403);
      expect(restoreOrgFromArchiveMock).not.toHaveBeenCalled();
    });
  });
  // ── per-org selection boundary (review fix C-B / I-1) ────────────────────
  // Every adjacent destructive org route enforces the partner member's
  // org_access='selected' allowlist (DELETE /organizations/:id via
  // canAccessOrg, orgMerge on the survivor, canApplySuspendedOrgLifecycleTransition
  // by re-reading partner_users.org_ids). Archive/restore did not — so a tech
  // whose selection excludes customer C could drain C's fleet and schedule its
  // permanent erasure, or undo an archive their admin started.
  describe('org_access=selected boundary', () => {
    it.each(['archive', 'restore'])(
      '404s %s for a same-partner org outside the selection',
      async (action) => {
        setAuthContext({ partnerOrgAccess: 'selected', canAccessOrg: () => false });
        mayReachOrgMock.mockResolvedValue(false);

        const res = await postJson(`/orgs/organizations/${ORG_ID}/${action}`, {});

        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Organization not found' });
        expect(beginOrgArchiveMock).not.toHaveBeenCalled();
        expect(restoreOrgFromArchiveMock).not.toHaveBeenCalled();
      },
    );

    it('allows archive for an org INSIDE the selection', async () => {
      setAuthContext({ partnerOrgAccess: 'selected', canAccessOrg: () => false });
      mayReachOrgMock.mockResolvedValue(true);

      const res = await postJson(`/orgs/organizations/${ORG_ID}/archive`, {});

      expect(res.status).toBe(202);
      expect(mayReachOrgMock).toHaveBeenCalledWith(
        expect.objectContaining({ partnerOrgAccess: 'selected', partnerId: PARTNER_ID }),
        ORG_ID,
      );
    });

    it('allows restore for an org INSIDE the selection', async () => {
      orgRows.current[0]!.status = 'archived';
      setAuthContext({ partnerOrgAccess: 'selected', canAccessOrg: () => false });
      mayReachOrgMock.mockResolvedValue(true);

      const res = await postJson(`/orgs/organizations/${ORG_ID}/restore`, {});

      expect(res.status).toBe(200);
    });

    it('does not consult the selection for system scope', async () => {
      orgRows.current[0]!.status = 'archived';
      setAuthContext({ scope: 'system', partnerId: null, partnerOrgAccess: null });

      const res = await postJson(`/orgs/organizations/${ORG_ID}/restore`, {});

      expect(res.status).toBe(200);
      expect(mayReachOrgMock).not.toHaveBeenCalled();
    });
  });
  // ── durable audit (review fix I-2) ───────────────────────────────────────
  // cascadeDeleteOrg deletes the target org's own audit_logs rows at purge, so
  // an org-tenanted archive audit is erased by the very purge it authorized.
  // The merge path already writes org.merge.* org-less for this reason.
  describe('durable (org-less) audit twin', () => {
    it('writes an org-less org.archive.requested carrying the org id and name', async () => {
      await postJson(`/orgs/organizations/${ORG_ID}/archive`, { retentionDays: 30 });

      expect(writeAuditEventMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          orgId: null,
          action: 'org.archive.requested',
          resourceId: ORG_ID,
          resourceName: 'Acme Corp',
          actorId: 'user-1',
          details: expect.objectContaining({
            orgId: ORG_ID,
            orgName: 'Acme Corp',
            partnerId: PARTNER_ID,
            retentionDays: 30,
            priorStatus: 'active',
            durable: true,
          }),
        }),
      );
    });

    it('writes an org-less org.archive.restored alongside the org-bound row', async () => {
      orgRows.current[0]!.status = 'archived';

      await postJson(`/orgs/organizations/${ORG_ID}/restore`, {});

      expect(writeAuditEventMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          orgId: null,
          action: 'org.archive.restored',
          resourceId: ORG_ID,
          details: expect.objectContaining({ orgId: ORG_ID, durable: true }),
        }),
      );
      // The org-bound row still exists — it is what the customer's own audit
      // view shows while the tenant is alive.
      expect(writeRouteAuditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ orgId: ORG_ID, action: 'org.archive.restored' }),
      );
    });

    it('writes no durable audit when the target is refused', async () => {
      orgRows.current[0]!.partnerId = OTHER_PARTNER_ID;

      await postJson(`/orgs/organizations/${ORG_ID}/archive`, {});

      expect(writeAuditEventMock).not.toHaveBeenCalled();
    });
  });
  // ── malformed :id (review fix, flagged concern) ──────────────────────────
  // `:id` is a raw path segment and `loadArchiveOrg` feeds it straight to a
  // `uuid` column, where a non-UUID raises Postgres 22P02 — an uncaught 500
  // plus a Sentry event that anyone can pump with `/organizations/undefined`.
  // A malformed id cannot name a real org, so it 404s, and it must do so
  // BEFORE any DB access. Mirrors the detail route in routes/orgs.ts.
  describe('malformed organization id', () => {
    it.each(['archive', 'restore'])(
      '404s %s for a non-uuid id without touching the database',
      async (action) => {
        const res = await postJson(`/orgs/organizations/not-a-uuid/${action}`, {});

        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Organization not found' });
        // The guard runs before the target load, the selection check, the
        // service call and the audits.
        expect(db.select).not.toHaveBeenCalled();
        expect(mayReachOrgMock).not.toHaveBeenCalled();
        expect(beginOrgArchiveMock).not.toHaveBeenCalled();
        expect(restoreOrgFromArchiveMock).not.toHaveBeenCalled();
        expect(writeRouteAuditMock).not.toHaveBeenCalled();
        expect(writeAuditEventMock).not.toHaveBeenCalled();
      },
    );

    it.each(['archive', 'restore'])(
      'still reaches the service for a well-formed id on %s',
      async (action) => {
        orgRows.current[0]!.status = action === 'restore' ? 'archived' : 'active';

        const res = await postJson(`/orgs/organizations/${ORG_ID}/${action}`, {});

        expect([200, 202]).toContain(res.status);
        expect(db.select).toHaveBeenCalled();
      },
    );
  });
});
