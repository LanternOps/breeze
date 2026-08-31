/**
 * Unit tests for the org merge HTTP endpoints (org-lifecycle Wave 2, Task 5).
 *
 * `services/orgMerge.ts` (the engine) and `jobs/orgMerge.ts` (the worker) are
 * both fully mocked — this suite only proves the route-level contract: the
 * middleware chain, the tenancy/access checks in `authorizeMergePair`
 * (especially the suspended-loser carve-out), the confirmName gate, the
 * verdict recheck, and the cross-partner guard on the job-status lookup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// --- db ----------------------------------------------------------------

const { orgRows } = vi.hoisted(() => ({
  orgRows: { current: [] as Array<{ id: string; partnerId: string; name: string }> },
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(orgRows.current)),
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
  },
}));

// db is fully mocked (the `.where()` above ignores its argument), but
// `inArray(organizations.id, [...])` still runs for real against the
// sentinel columns above before the result is thrown away — stub it so a
// plain-object sentinel doesn't trip real drizzle's column introspection.
vi.mock('drizzle-orm', async (importActual) => {
  const actual = await importActual<typeof import('drizzle-orm')>();
  return {
    ...actual,
    inArray: vi.fn((column: unknown, values: unknown) => ({ __inArray: { column, values } })),
  };
});

// --- auditEvents ---------------------------------------------------------

const { writeRouteAuditMock } = vi.hoisted(() => ({ writeRouteAuditMock: vi.fn() }));
vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: writeRouteAuditMock,
}));

// --- engine (services/orgMerge) ------------------------------------------
//
// A local MergeValidationError class, NOT the real module's — the route
// imports the class from this same mocked module, so `instanceof` checks
// stay consistent as long as tests throw instances built from the import
// below rather than a hand-rolled Error.

const { previewOrgMergeMock } = vi.hoisted(() => ({ previewOrgMergeMock: vi.fn() }));
vi.mock('../services/orgMerge', () => {
  class MergeValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'MergeValidationError';
    }
  }
  return {
    MergeValidationError,
    previewOrgMerge: previewOrgMergeMock,
  };
});

// --- job (jobs/orgMerge) ---------------------------------------------------

const { enqueueOrgMergeMock, getJobMock } = vi.hoisted(() => ({
  enqueueOrgMergeMock: vi.fn(),
  getJobMock: vi.fn(),
}));
vi.mock('../jobs/orgMerge', () => ({
  enqueueOrgMerge: enqueueOrgMergeMock,
  getOrgMergeQueue: vi.fn(() => ({ getJob: getJobMock })),
}));

// --- middleware/auth -------------------------------------------------------

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn((...scopes: string[]) => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Not authenticated' }, 401);
    if (!scopes.includes(auth.scope)) return c.json({ error: 'Insufficient permissions' }, 403);
    return next();
  }),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Not authenticated' }, 401);
    if (auth.token?.mfa === false) {
      return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
    }
    return next();
  }),
}));

import { authMiddleware } from '../middleware/auth';
import { MergeValidationError } from '../services/orgMerge';
import { orgMergeRoutes } from './orgMerge';

const LOSER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SURVIVOR_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PARTNER_ID = 'partner-1';
const OTHER_PARTNER_ID = 'partner-2';

type FakeAuth = {
  user: { id: string; email: string; name?: string };
  token: { mfa?: boolean };
  scope: 'system' | 'partner' | 'organization';
  partnerId: string | null;
  orgId?: string | null;
  canAccessOrg: (orgId: string) => boolean;
};

function setAuthContext(overrides: Partial<FakeAuth> = {}) {
  const auth: FakeAuth = {
    user: { id: 'user-1', email: 'tech@example.com', name: 'Tech' },
    token: { mfa: true },
    scope: 'partner',
    partnerId: PARTNER_ID,
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
  app.route('/orgs', orgMergeRoutes);
  return app;
}

const PREVIEW_RESULT = {
  tables: [{ table: 'devices', policy: 'repoint', loserRows: 3, wouldDrop: 0 }],
  totalMovableRows: 3,
  verdict: 'ok' as const,
  warnings: [],
};

async function postJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('org merge routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgRows.current = [
      { id: LOSER_ID, partnerId: PARTNER_ID, name: 'Acme Loser' },
      { id: SURVIVOR_ID, partnerId: PARTNER_ID, name: 'Acme Survivor' },
    ];
    previewOrgMergeMock.mockResolvedValue(PREVIEW_RESULT);
    enqueueOrgMergeMock.mockResolvedValue({ id: `org-merge-${LOSER_ID}` });
    getJobMock.mockResolvedValue(undefined);
    setAuthContext();
  });

  describe('POST /orgs/organizations/:id/merge-preview', () => {
    it('returns 200 with the engine preview on a valid pair', async () => {
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge-preview`, {
        survivorId: SURVIVOR_ID,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(PREVIEW_RESULT);
      expect(previewOrgMergeMock).toHaveBeenCalledWith(LOSER_ID, SURVIVOR_ID, PARTNER_ID);
    });

    it('404s when the loser org does not exist', async () => {
      orgRows.current = orgRows.current.filter((o) => o.id !== LOSER_ID);
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge-preview`, {
        survivorId: SURVIVOR_ID,
      });
      expect(res.status).toBe(404);
      expect(previewOrgMergeMock).not.toHaveBeenCalled();
    });

    it('404s when the loser belongs to a different partner (never a 403 — no existence leak)', async () => {
      orgRows.current = orgRows.current.map((o) =>
        o.id === LOSER_ID ? { ...o, partnerId: OTHER_PARTNER_ID } : o,
      );
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge-preview`, {
        survivorId: SURVIVOR_ID,
      });
      expect(res.status).toBe(404);
      expect(previewOrgMergeMock).not.toHaveBeenCalled();
    });

    it('succeeds for a SUSPENDED loser even though auth.canAccessOrg(loserId) is false', async () => {
      // computeAccessibleOrgIds only ever populates active/trial orgs, so a
      // suspended loser (a legal merge input) is never in accessibleOrgIds.
      // The route must gate the loser on partner_id equality, never on
      // canAccessOrg — this proves canAccessOrg(loserId) is never consulted.
      setAuthContext({ canAccessOrg: (orgId) => orgId !== LOSER_ID });
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge-preview`, {
        survivorId: SURVIVOR_ID,
      });
      expect(res.status).toBe(200);
      expect(previewOrgMergeMock).toHaveBeenCalledWith(LOSER_ID, SURVIVOR_ID, PARTNER_ID);
    });

    it('404s when the survivor org does not exist', async () => {
      orgRows.current = orgRows.current.filter((o) => o.id !== SURVIVOR_ID);
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge-preview`, {
        survivorId: SURVIVOR_ID,
      });
      expect(res.status).toBe(404);
      expect(previewOrgMergeMock).not.toHaveBeenCalled();
    });

    it('403s on a cross-partner survivor', async () => {
      orgRows.current = orgRows.current.map((o) =>
        o.id === SURVIVOR_ID ? { ...o, partnerId: OTHER_PARTNER_ID } : o,
      );
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge-preview`, {
        survivorId: SURVIVOR_ID,
      });
      expect(res.status).toBe(403);
      expect(previewOrgMergeMock).not.toHaveBeenCalled();
    });

    it('403s when a selected-access partner member cannot access the survivor (same partner, canAccessOrg false)', async () => {
      setAuthContext({ canAccessOrg: (orgId) => orgId !== SURVIVOR_ID });
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge-preview`, {
        survivorId: SURVIVOR_ID,
      });
      expect(res.status).toBe(403);
      expect(previewOrgMergeMock).not.toHaveBeenCalled();
    });

    it('400s when auth.partnerId is missing for a partner-scope caller', async () => {
      setAuthContext({ partnerId: null });
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge-preview`, {
        survivorId: SURVIVOR_ID,
      });
      expect(res.status).toBe(400);
    });

    it('maps a MergeValidationError from the engine to 400', async () => {
      previewOrgMergeMock.mockRejectedValueOnce(new MergeValidationError('An organization cannot be merged into itself'));
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge-preview`, {
        survivorId: SURVIVOR_ID,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/merged into itself/);
    });

    it('403s an organization-scope token (requireScope)', async () => {
      setAuthContext({ scope: 'organization', partnerId: null, orgId: LOSER_ID });
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge-preview`, {
        survivorId: SURVIVOR_ID,
      });
      expect(res.status).toBe(403);
    });

    it('403s when MFA has not been satisfied', async () => {
      setAuthContext({ token: { mfa: false } });
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge-preview`, {
        survivorId: SURVIVOR_ID,
      });
      expect(res.status).toBe(403);
      expect(previewOrgMergeMock).not.toHaveBeenCalled();
    });

    it('400s on a non-uuid survivorId', async () => {
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge-preview`, {
        survivorId: 'not-a-uuid',
      });
      expect(res.status).toBe(400);
    });

    it('a system-scope caller resolves the partner from the loser row', async () => {
      setAuthContext({ scope: 'system', partnerId: null });
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge-preview`, {
        survivorId: SURVIVOR_ID,
      });
      expect(res.status).toBe(200);
      expect(previewOrgMergeMock).toHaveBeenCalledWith(LOSER_ID, SURVIVOR_ID, PARTNER_ID);
    });
  });

  describe('POST /orgs/organizations/:id/merge', () => {
    it('202s, enqueues with the auth identity, and audits org.merge.requested on the survivor', async () => {
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge`, {
        survivorId: SURVIVOR_ID,
        confirmName: 'Acme Loser',
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ jobId: `org-merge-${LOSER_ID}` });

      expect(enqueueOrgMergeMock).toHaveBeenCalledWith({
        loserOrgId: LOSER_ID,
        survivorOrgId: SURVIVOR_ID,
        partnerId: PARTNER_ID,
        performedBy: 'user-1',
        performedByEmail: 'tech@example.com',
      });

      expect(writeRouteAuditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          orgId: SURVIVOR_ID,
          action: 'org.merge.requested',
          resourceType: 'organization',
          resourceId: LOSER_ID,
        }),
      );
    });

    it('400s on a confirmName mismatch and never enqueues', async () => {
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge`, {
        survivorId: SURVIVOR_ID,
        confirmName: 'Wrong Name',
      });
      expect(res.status).toBe(400);
      expect(enqueueOrgMergeMock).not.toHaveBeenCalled();
      expect(previewOrgMergeMock).not.toHaveBeenCalled();
    });

    it('confirmName compare is exact / case-sensitive', async () => {
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge`, {
        survivorId: SURVIVOR_ID,
        confirmName: 'acme loser',
      });
      expect(res.status).toBe(400);
      expect(enqueueOrgMergeMock).not.toHaveBeenCalled();
    });

    it('422s when the engine verdict is too-large and never enqueues', async () => {
      previewOrgMergeMock.mockResolvedValueOnce({ ...PREVIEW_RESULT, verdict: 'too-large', totalMovableRows: 999_999 });
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge`, {
        survivorId: SURVIVOR_ID,
        confirmName: 'Acme Loser',
      });
      expect(res.status).toBe(422);
      expect(enqueueOrgMergeMock).not.toHaveBeenCalled();
    });

    it('refuses a blocked merge with 422 ORG_MERGE_BLOCKED and never enqueues', async () => {
      previewOrgMergeMock.mockResolvedValueOnce({
        ...PREVIEW_RESULT,
        verdict: 'blocked',
        totalMovableRows: 0,
        blockers: ['merge blocked: the merged-away organization holds durable PAM lifecycle evidence'],
      });
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge`, {
        survivorId: SURVIVOR_ID,
        confirmName: 'Acme Loser',
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('ORG_MERGE_BLOCKED');
      expect(body.blockers).toHaveLength(1);
      expect(enqueueOrgMergeMock).not.toHaveBeenCalled();
    });

    it('maps a MergeValidationError from the recheck to 400 and never enqueues', async () => {
      previewOrgMergeMock.mockRejectedValueOnce(new MergeValidationError('bad state'));
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge`, {
        survivorId: SURVIVOR_ID,
        confirmName: 'Acme Loser',
      });
      expect(res.status).toBe(400);
      expect(enqueueOrgMergeMock).not.toHaveBeenCalled();
    });

    it('404s a cross-partner (wrong-partner) loser before ever checking confirmName', async () => {
      orgRows.current = orgRows.current.map((o) =>
        o.id === LOSER_ID ? { ...o, partnerId: OTHER_PARTNER_ID } : o,
      );
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge`, {
        survivorId: SURVIVOR_ID,
        confirmName: 'anything',
      });
      expect(res.status).toBe(404);
      expect(enqueueOrgMergeMock).not.toHaveBeenCalled();
    });

    it('403s a cross-partner survivor', async () => {
      orgRows.current = orgRows.current.map((o) =>
        o.id === SURVIVOR_ID ? { ...o, partnerId: OTHER_PARTNER_ID } : o,
      );
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge`, {
        survivorId: SURVIVOR_ID,
        confirmName: 'Acme Loser',
      });
      expect(res.status).toBe(403);
      expect(enqueueOrgMergeMock).not.toHaveBeenCalled();
    });

    it('succeeds merging away a suspended loser (canAccessOrg(loserId) false, partner matches)', async () => {
      setAuthContext({ canAccessOrg: (orgId) => orgId !== LOSER_ID });
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge`, {
        survivorId: SURVIVOR_ID,
        confirmName: 'Acme Loser',
      });
      expect(res.status).toBe(202);
      expect(enqueueOrgMergeMock).toHaveBeenCalled();
    });

    it('403s an organization-scope token (requireScope)', async () => {
      setAuthContext({ scope: 'organization', partnerId: null, orgId: LOSER_ID });
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge`, {
        survivorId: SURVIVOR_ID,
        confirmName: 'Acme Loser',
      });
      expect(res.status).toBe(403);
      expect(enqueueOrgMergeMock).not.toHaveBeenCalled();
    });

    it('403s when MFA has not been satisfied and never enqueues', async () => {
      setAuthContext({ token: { mfa: false } });
      const app = buildApp();
      const res = await postJson(app, `/orgs/organizations/${LOSER_ID}/merge`, {
        survivorId: SURVIVOR_ID,
        confirmName: 'Acme Loser',
      });
      expect(res.status).toBe(403);
      expect(enqueueOrgMergeMock).not.toHaveBeenCalled();
    });
  });

  describe('GET /orgs/organizations/merge-runs/:jobId', () => {
    const JOB_ID = `org-merge-${LOSER_ID}`;

    it('404s an unknown job', async () => {
      getJobMock.mockResolvedValueOnce(undefined);
      const app = buildApp();
      const res = await app.request(`/orgs/organizations/merge-runs/${JOB_ID}`);
      expect(res.status).toBe(404);
    });

    it('404s a job belonging to another partner (guessable jobId guard)', async () => {
      getJobMock.mockResolvedValueOnce({
        data: { loserOrgId: LOSER_ID, survivorOrgId: SURVIVOR_ID, partnerId: OTHER_PARTNER_ID },
        getState: vi.fn().mockResolvedValue('completed'),
        returnvalue: { ok: true },
        failedReason: undefined,
      });
      const app = buildApp();
      const res = await app.request(`/orgs/organizations/merge-runs/${JOB_ID}`);
      expect(res.status).toBe(404);
    });

    it('returns the job state for a same-partner job', async () => {
      getJobMock.mockResolvedValueOnce({
        data: { loserOrgId: LOSER_ID, survivorOrgId: SURVIVOR_ID, partnerId: PARTNER_ID },
        getState: vi.fn().mockResolvedValue('completed'),
        returnvalue: { mergeEventId: 'evt-1' },
        failedReason: undefined,
      });
      const app = buildApp();
      const res = await app.request(`/orgs/organizations/merge-runs/${JOB_ID}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        state: 'completed',
        result: { mergeEventId: 'evt-1' },
        failedReason: undefined,
      });
    });

    it('surfaces a failed job with failedReason', async () => {
      getJobMock.mockResolvedValueOnce({
        data: { loserOrgId: LOSER_ID, survivorOrgId: SURVIVOR_ID, partnerId: PARTNER_ID },
        getState: vi.fn().mockResolvedValue('failed'),
        returnvalue: undefined,
        failedReason: 'boom',
      });
      const app = buildApp();
      const res = await app.request(`/orgs/organizations/merge-runs/${JOB_ID}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.state).toBe('failed');
      expect(body.failedReason).toBe('boom');
    });

    it('a system-scope caller CAN see a job belonging to another partner', async () => {
      setAuthContext({ scope: 'system', partnerId: null });
      getJobMock.mockResolvedValueOnce({
        data: { loserOrgId: LOSER_ID, survivorOrgId: SURVIVOR_ID, partnerId: OTHER_PARTNER_ID },
        getState: vi.fn().mockResolvedValue('active'),
        returnvalue: undefined,
        failedReason: undefined,
      });
      const app = buildApp();
      const res = await app.request(`/orgs/organizations/merge-runs/${JOB_ID}`);
      expect(res.status).toBe(200);
      expect((await res.json()).state).toBe('active');
    });

    it('403s an organization-scope token (requireScope)', async () => {
      setAuthContext({ scope: 'organization', partnerId: null, orgId: OTHER_ORG_ID });
      const app = buildApp();
      const res = await app.request(`/orgs/organizations/merge-runs/${JOB_ID}`);
      expect(res.status).toBe(403);
      expect(getJobMock).not.toHaveBeenCalled();
    });
  });
});
