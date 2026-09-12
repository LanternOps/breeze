import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { scriptRoutes } from './scripts';

// Valid UUID constants
const SCRIPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_ORG_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
  writeRouteAudit: vi.fn(),
}));

// This route is a pure read — no writer/service mocks are needed beyond `db`.
// `runOutsideDbContext` / `withSystemDbAccessContext` are no-ops here, mirroring
// the shared pattern in scripts.test.ts and accessReviews.test.ts.
vi.mock('../db', () => {
  const db: any = {
    select: vi.fn(),
  };
  return {
    db,
    runOutsideDbContext: vi.fn((fn: () => any) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
  };
});

vi.mock('../db/schema', () => ({
  scripts: { id: 'scripts.id', orgId: 'scripts.orgId', deletedAt: 'scripts.deletedAt', isSystem: 'scripts.isSystem' },
  scriptVersions: { id: 'sv.id', scriptId: 'sv.scriptId', version: 'sv.version' },
  scriptProposalReviews: { id: 'spr.id' },
  scriptExecutions: {},
  devices: {},
  automationPolicies: {},
  patchPolicies: {},
  configPolicyComplianceRules: {},
  configPolicyFeatureLinks: {},
  configurationPolicies: {},
  scriptTags: { id: 'stg.id', name: 'stg.name', orgId: 'stg.orgId', partnerId: 'stg.partnerId' },
  scriptToTags: { scriptId: 'stt.scriptId', tagId: 'stt.tagId' },
  scriptExecutionBatches: {},
  deviceCommands: {},
  organizations: { id: 'o.id', partnerId: 'o.partnerId' },
  alertRules: {},
  backupConfigs: {},
  securityPolicies: {},
  maintenanceWindows: {},
  softwarePolicies: {},
  sensitiveDataPolicies: {},
  peripheralPolicies: {},
  tenantVariables: {
    id: 'tv.id',
    key: 'tv.key',
    value: 'tv.value',
    isSecret: 'tv.isSecret',
    version: 'tv.version',
    orgId: 'tv.orgId',
    partnerId: 'tv.partnerId'
  },
  discoveredAssetTypeEnum: { enumValues: ['workstation', 'server', 'printer', 'unknown'] }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      token: {
        sub: 'user-123',
        email: 'test@example.com',
        roleId: 'role-123',
        orgId: ORG_ID,
        partnerId: null,
        scope: 'organization',
        type: 'access',
        mfa: true,
      },
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  // Mirror tunnels.test.ts: a caller lacking the required grant is rejected
  // with 403, opted into via `x-deny-permission: <resource>:<action>`.
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    const denied = c.req.header('x-deny-permission');
    if (denied && denied === `${resource}:${action}`) {
      return c.json({ error: 'Insufficient permissions' }, 403);
    }
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

import { db } from '../db';

function mockScriptLookup(script: unknown) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(script ? [script] : []),
      }),
    }),
  } as any);
}

function mockVersionsQuery(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as any);
}

function mockReviewsQuery(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as any);
}

describe('GET /scripts/:id/versions', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/scripts', scriptRoutes);
  });

  it('returns versions newest-first with provenance', async () => {
    mockScriptLookup({ id: SCRIPT_ID, orgId: ORG_ID, isSystem: false, deletedAt: null });
    mockVersionsQuery([
      { id: 'v2', version: 2, contentDigest: 'd2', changelog: null, createdAt: new Date('2026-01-02T00:00:00Z'), origin: 'human', proposalId: null, reviewId: null, reviewedAt: null, approvedBy: null, approvedAt: null, approvalMethod: null },
      { id: 'v1', version: 1, contentDigest: 'd1', changelog: null, createdAt: new Date('2026-01-01T00:00:00Z'), origin: 'ai_proposal', proposalId: 'p1', reviewId: 'r1', reviewedAt: new Date('2026-01-01T00:05:00Z'), approvedBy: 'user-1', approvedAt: new Date('2026-01-01T00:10:00Z'), approvalMethod: 'manual' },
    ]);
    mockReviewsQuery([{ id: 'r1', summary: 'Targets one service', riskTier: 'low', model: 'gpt-6-astra' }]);

    const res = await app.request(`/scripts/${SCRIPT_ID}/versions`, {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(body.versions[1].origin).toBe('ai_proposal');
    expect(body.versions[1].reviewSummary).toBe('Targets one service');
    expect(body.versions[1].reviewEvidenceErased).toBe(false);
  });

  it('marks review evidence erased when the cited review row is gone', async () => {
    mockScriptLookup({ id: SCRIPT_ID, orgId: ORG_ID, isSystem: false, deletedAt: null });
    mockVersionsQuery([
      { id: 'v1', version: 1, contentDigest: 'd1', changelog: null, createdAt: new Date('2026-01-01T00:00:00Z'), origin: 'ai_proposal', proposalId: 'p1', reviewId: 'r1', reviewedAt: null, approvedBy: null, approvedAt: null, approvalMethod: null },
    ]);
    mockReviewsQuery([]); // review erased with the source org

    const res = await app.request(`/scripts/${SCRIPT_ID}/versions`, {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token' },
    });
    const body = await res.json();
    expect(body.versions[0].reviewEvidenceErased).toBe(true);
    expect(body.versions[0].reviewSummary).toBeNull();
  });

  it('does not query reviews when no version cites one', async () => {
    mockScriptLookup({ id: SCRIPT_ID, orgId: ORG_ID, isSystem: false, deletedAt: null });
    mockVersionsQuery([
      { id: 'v1', version: 1, contentDigest: 'd1', changelog: null, createdAt: new Date('2026-01-01T00:00:00Z'), origin: 'human', proposalId: null, reviewId: null, reviewedAt: null, approvedBy: null, approvedAt: null, approvalMethod: null },
    ]);

    const res = await app.request(`/scripts/${SCRIPT_ID}/versions`, {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token' },
    });
    const body = await res.json();
    expect(body.versions[0].reviewEvidenceErased).toBe(false);
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2); // script lookup + versions only
  });

  it('404s a script in another org', async () => {
    mockScriptLookup({ id: SCRIPT_ID, orgId: OTHER_ORG_ID, isSystem: false, deletedAt: null });

    const res = await app.request(`/scripts/${SCRIPT_ID}/versions`, {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(res.status).toBe(404);
  });

  it('404s a script that does not exist', async () => {
    mockScriptLookup(null);

    const res = await app.request(`/scripts/${SCRIPT_ID}/versions`, {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(res.status).toBe(404);
  });

  it('requires scripts:read', async () => {
    const res = await app.request(`/scripts/${SCRIPT_ID}/versions`, {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token', 'x-deny-permission': 'scripts:read' },
    });
    expect(res.status).toBe(403);
  });
});

// Task 22: GET /scripts must project `origin` and `reviewedAtHead` so the
// list UI never has to fetch versions per row. A mock DB row with neither
// field (the shape every pre-existing scripts.test.ts mock uses) must default
// to a plain human/unreviewed script rather than throwing or coming back
// `undefined`.
describe('GET /scripts — origin and reviewedAtHead projection', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/scripts', scriptRoutes);
  });

  it('correlates the reviewedAtHead EXISTS on the OUTER scripts columns, not the subquery alias', async () => {
    // Regression: `${scripts.id}` inside a raw fragment renders as a bare "id",
    // which the correlated subquery resolves against `sv` — the EXISTS then
    // compares a version row to itself and every script reads "Edited since
    // review". The fix spells the outer columns as "scripts"."id".
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 0 }]) }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({ offset: vi.fn().mockResolvedValue([]) }),
            }),
          }),
        }),
      } as any);

    await app.request('/scripts?limit=10&page=1', { method: 'GET', headers: { Authorization: 'Bearer valid-token' } });

    const projection = vi.mocked(db.select).mock.calls[1]![0] as { reviewedAtHead: SQL };
    const rendered = new PgDialect().sqlToQuery(projection.reviewedAtHead).sql.replace(/\s+/g, ' ');
    expect(rendered).toContain('sv.script_id = "scripts"."id"');
    expect(rendered).toContain('sv.version = "scripts"."version"');
  });

  it('passes through origin and reviewedAtHead when the query already projects them', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 1 }]) }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue([
                  { id: SCRIPT_ID, name: 'AI script', origin: 'ai_proposal', reviewedAtHead: true },
                ]),
              }),
            }),
          }),
        }),
      } as any);

    const res = await app.request('/scripts?limit=10&page=1', {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token' },
    });
    const body = await res.json();
    expect(body.data[0].origin).toBe('ai_proposal');
    expect(body.data[0].reviewedAtHead).toBe(true);
  });

  it('defaults origin to human and reviewedAtHead to false when the mock omits them', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 1 }]) }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue([{ id: SCRIPT_ID, name: 'Plain script' }]),
              }),
            }),
          }),
        }),
      } as any);

    const res = await app.request('/scripts?limit=10&page=1', {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token' },
    });
    const body = await res.json();
    expect(body.data[0].origin).toBe('human');
    expect(body.data[0].reviewedAtHead).toBe(false);
  });
});
