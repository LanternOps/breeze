import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { UserPermissions } from '../services/permissions';

/**
 * Route tests for the flow limits settings (Tool Catalog W05 #5220, plan
 * Decision 15 / Task D3). Scope, permission and MFA middleware and
 * canManagePartnerWidePolicies stay REAL; only the DB, the audit sink, the
 * auth identity and the permission lookup are mocked.
 */

const PARTNER = '22222222-2222-4222-8222-222222222222';
const OTHER_PARTNER = '99999999-9999-4999-8999-999999999999';
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '44444444-4444-4444-8444-444444444444';
const USER_ID = '33333333-3333-4333-8333-333333333333';

let orgRows: Array<Record<string, unknown>> = [];
let partnerRows: Array<Record<string, unknown>> = [];
let updates: Array<{ table: string; set: Record<string, unknown> }> = [];
let updateReturning: Array<Record<string, unknown>> = [{ id: 'row' }];

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: { __t: string }) => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => (table.__t === 'org' ? orgRows : partnerRows)) })),
      })),
    })),
    update: vi.fn((table: { __t: string }) => ({
      set: vi.fn((set: Record<string, unknown>) => {
        updates.push({ table: table.__t, set });
        return { where: vi.fn(() => ({ returning: vi.fn(async () => updateReturning) })) };
      }),
    })),
  },
}));
vi.mock('../db/schema', () => ({
  organizations: { __t: 'org', id: 'organizations.id', settings: 'organizations.settings', partnerId: 'organizations.partner_id' },
  partners: { __t: 'partner', id: 'partners.id', settings: 'partners.settings' },
}));
vi.mock('../db/partnerAxisRead', () => ({ readWithPartnerAxisVisibility: (fn: () => unknown) => fn() }));

const auditLog: Array<Record<string, unknown>> = [];
vi.mock('../services/auditService', () => ({
  createAuditLogAsync: vi.fn(async (p: Record<string, unknown>) => { auditLog.push(p); }),
}));

let currentAuth: Record<string, unknown> = {};
vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('auth', currentAuth);
      await next();
    },
  };
});

let currentPerms: UserPermissions | null = null;
vi.mock('../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/permissions')>();
  return { ...actual, getUserPermissions: vi.fn(async () => currentPerms) };
});

import { FLOW_LIMIT_CEILINGS, FLOW_LIMIT_DEFAULTS } from '@breeze/shared';
import { PERMISSIONS } from '../services/permissions';
import { authMiddleware } from '../middleware/auth';
import { flowLimitsSettingsUpdate, registerFlowLimitsRoutes } from './flowLimits';

function partnerAuth(over: Record<string, unknown> = {}): Record<string, unknown> {
  const accessible = (over.accessibleOrgIds as string[] | undefined) ?? [ORG];
  return {
    user: { id: USER_ID, email: 'admin@example.com' },
    scope: 'partner',
    orgId: null,
    partnerId: PARTNER,
    partnerOrgAccess: 'all',
    accessibleOrgIds: accessible,
    canAccessOrg: (id: string) => accessible.includes(id),
    token: { mfa: true, sid: 'sid-1' },
    ...over,
  };
}
const orgAuth = () => partnerAuth({ scope: 'organization', orgId: ORG, partnerId: PARTNER, partnerOrgAccess: undefined });
const perms = (grants: Array<{ resource: string; action: string }>): UserPermissions =>
  ({ permissions: grants, partnerId: PARTNER, orgId: null, roleId: 'r', scope: 'partner' });
const flows = (v: Record<string, unknown>) => ({ flows: v, other: 'kept' });

let app: Hono;
beforeEach(() => {
  vi.clearAllMocks();
  orgRows = [{ settings: {}, partnerId: PARTNER }];
  partnerRows = [{ settings: {} }];
  updates = [];
  updateReturning = [{ id: 'row' }];
  auditLog.length = 0;
  currentAuth = partnerAuth();
  currentPerms = perms([PERMISSIONS.AUTOMATIONS_READ, PERMISSIONS.AUTOMATIONS_WRITE]);
  app = new Hono();
  app.use('*', authMiddleware);
  registerFlowLimitsRoutes(app);
});

const get = (q = '') => app.request(`/limits${q}`);
const put = (body: unknown) =>
  app.request('/limits', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const setSql = (i = 0) => new PgDialect().sqlToQuery(updates[i]!.set.settings as SQL);

describe('GET /limits', () => {
  it('partner level: stored values, the resolved limits with their source, and canManage', async () => {
    partnerRows = [{ settings: flows({ monthlyRunsPerFlow: 500 }) }];
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      level: 'partner',
      partnerId: PARTNER,
      orgId: null,
      stored: { monthlyRunsPerOwner: null, monthlyRunsPerFlow: 500, aiTokensPerRun: null },
      limits: {
        effective: { monthlyRunsPerOwner: FLOW_LIMIT_DEFAULTS.monthlyRunsPerOwner, monthlyRunsPerFlow: 500, aiTokensPerRun: FLOW_LIMIT_DEFAULTS.aiTokensPerRun },
        source: { monthlyRunsPerOwner: 'default', monthlyRunsPerFlow: 'partner', aiTokensPerRun: 'default' },
        partnerCeiling: null,
      },
      defaults: FLOW_LIMIT_DEFAULTS,
      ceilings: FLOW_LIMIT_CEILINGS,
      canManage: true,
    });
  });

  it('org level: the partner value is the ceiling, a lower org value wins, a raise is stored but not in effect', async () => {
    partnerRows = [{ settings: flows({ monthlyRunsPerFlow: 500, aiTokensPerRun: 2000 }) }];
    orgRows = [{ settings: flows({ monthlyRunsPerFlow: 100, aiTokensPerRun: 9000 }), partnerId: PARTNER }];
    const res = await get(`?orgId=${ORG}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.level).toBe('org');
    expect(body.orgId).toBe(ORG);
    expect(body.stored).toEqual({ monthlyRunsPerOwner: null, monthlyRunsPerFlow: 100, aiTokensPerRun: 9000 });
    expect(body.limits.effective).toMatchObject({ monthlyRunsPerFlow: 100, aiTokensPerRun: 2000 });
    expect(body.limits.source).toMatchObject({ monthlyRunsPerFlow: 'org', aiTokensPerRun: 'partner' });
    expect(body.limits.partnerCeiling).toMatchObject({ monthlyRunsPerFlow: 500, aiTokensPerRun: 2000 });
    expect(body.canManage).toBe(true);
  });

  it('an org-scope caller reads its own org by default, read-only', async () => {
    currentAuth = orgAuth();
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ level: 'org', orgId: ORG, canManage: false });
  });

  it('cross-org: an org the caller cannot access is a 404', async () => {
    expect((await get(`?orgId=${OTHER_ORG}`)).status).toBe(404);
    currentAuth = orgAuth();
    expect((await get(`?orgId=${OTHER_ORG}`)).status).toBe(404);
  });

  it("an org of another partner is a 404 even when the RLS read returns it", async () => {
    orgRows = [{ settings: {}, partnerId: OTHER_PARTNER }];
    expect((await get(`?orgId=${ORG}`)).status).toBe(404);
  });

  it('canManage is false without partner-wide authority', async () => {
    currentAuth = partnerAuth({ partnerOrgAccess: 'selected' });
    expect(await (await get()).json()).toMatchObject({ canManage: false });
  });

  it('403 without automations.read', async () => {
    currentPerms = perms([]);
    expect((await get()).status).toBe(403);
  });
});

describe('PUT /limits — response reflects the write', () => {
  // The re-read helpers open a separate (system) context that cannot see the
  // request's uncommitted UPDATE, so the response must come from RETURNING.
  it('partner write: the response is built from the returned settings, not a re-read', async () => {
    partnerRows = [{ settings: {} }]; // a re-read would still see the old row
    updateReturning = [{ id: PARTNER, settings: flows({ monthlyRunsPerFlow: 500 }) }];
    const body = await (await put({ limits: { monthlyRunsPerFlow: 500 } })).json();
    expect(body.stored.monthlyRunsPerFlow).toBe(500);
    expect(body.limits.effective.monthlyRunsPerFlow).toBe(500);
  });

  it('org write: the response is built from the returned org settings', async () => {
    partnerRows = [{ settings: flows({ monthlyRunsPerFlow: 500 }) }];
    orgRows = [{ settings: {}, partnerId: PARTNER }];
    updateReturning = [{ id: ORG, settings: flows({ monthlyRunsPerFlow: 100 }) }];
    const body = await (await put({ orgId: ORG, limits: { monthlyRunsPerFlow: 100 } })).json();
    expect(body).toMatchObject({ level: 'org', orgId: ORG, stored: { monthlyRunsPerFlow: 100 } });
    expect(body.limits.effective.monthlyRunsPerFlow).toBe(100);
    expect(body.limits.source.monthlyRunsPerFlow).toBe('org');
  });
});

describe('PUT /limits — partner default', () => {
  it('sets and clears fields with one path-level update of settings.flows', async () => {
    const res = await put({ limits: { monthlyRunsPerFlow: 500, aiTokensPerRun: null } });
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.table).toBe('partner');
    const q = setSql();
    expect(q.sql).toContain("'{flows}'");
    expect(q.params).toEqual(expect.arrayContaining(['aiTokensPerRun', 'monthlyRunsPerFlow', 500]));
    expect(auditLog[0]).toMatchObject({ action: 'flows.limits.updated', resourceType: 'partner', resourceId: PARTNER, details: { level: 'partner', limits: { monthlyRunsPerFlow: 500, aiTokensPerRun: null } } });
  });

  it('is refused without partner-wide authority (canManagePartnerWidePolicies)', async () => {
    currentAuth = partnerAuth({ partnerOrgAccess: 'selected' });
    const res = await put({ limits: { monthlyRunsPerFlow: 500 } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'partner_wide_forbidden' });
    expect(updates).toHaveLength(0);
  });

  it('is refused for an org-scope caller', async () => {
    currentAuth = orgAuth();
    const res = await put({ limits: { monthlyRunsPerFlow: 5 } });
    expect(res.status).toBe(403);
    expect(updates).toHaveLength(0);
  });

  it('is refused without automations.write, and without MFA', async () => {
    currentPerms = perms([PERMISSIONS.AUTOMATIONS_READ]);
    expect((await put({ limits: { monthlyRunsPerFlow: 5 } })).status).toBe(403);
    currentPerms = perms([PERMISSIONS.AUTOMATIONS_READ, PERMISSIONS.AUTOMATIONS_WRITE]);
    currentAuth = partnerAuth({ token: { mfa: false, sid: 'sid-1' } });
    expect((await put({ limits: { monthlyRunsPerFlow: 5 } })).status).toBe(403);
    expect(updates).toHaveLength(0);
  });

  it('a value above the platform ceiling is a 400', async () => {
    expect((await put({ limits: { monthlyRunsPerFlow: FLOW_LIMIT_CEILINGS.monthlyRunsPerFlow + 1 } })).status).toBe(400);
    expect(updates).toHaveLength(0);
  });
});

describe('PUT /limits — org override (lower-only)', () => {
  it('a value at or below the partner ceiling is written to the org', async () => {
    partnerRows = [{ settings: flows({ monthlyRunsPerFlow: 500 }) }];
    const res = await put({ orgId: ORG, limits: { monthlyRunsPerFlow: 500, monthlyRunsPerOwner: 10 } });
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.table).toBe('org');
    expect(auditLog[0]).toMatchObject({ orgId: ORG, resourceType: 'organization', resourceId: ORG, details: { level: 'organization' } });
  });

  it('raising above the partner value is refused server-side, nothing is written', async () => {
    partnerRows = [{ settings: flows({ monthlyRunsPerFlow: 500 }) }];
    const res = await put({ orgId: ORG, limits: { monthlyRunsPerFlow: 501 } });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'limit_above_partner_ceiling', field: 'monthlyRunsPerFlow', ceiling: 500 });
    expect(updates).toHaveLength(0);
  });

  it('the ceiling is the platform default when the partner sets nothing', async () => {
    const res = await put({ orgId: ORG, limits: { aiTokensPerRun: FLOW_LIMIT_DEFAULTS.aiTokensPerRun + 1 } });
    expect(res.status).toBe(422);
    expect(updates).toHaveLength(0);
  });

  it('clearing an org field (null) is always allowed', async () => {
    partnerRows = [{ settings: flows({ monthlyRunsPerFlow: 1 }) }];
    expect((await put({ orgId: ORG, limits: { monthlyRunsPerFlow: null } })).status).toBe(200);
  });

  it('cross-org: an inaccessible org is a 404 and nothing is written', async () => {
    const res = await put({ orgId: OTHER_ORG, limits: { monthlyRunsPerFlow: 1 } });
    expect(res.status).toBe(404);
    expect(updates).toHaveLength(0);
  });

  it('an org of another partner is a 404', async () => {
    orgRows = [{ settings: {}, partnerId: OTHER_PARTNER }];
    expect((await put({ orgId: ORG, limits: { monthlyRunsPerFlow: 1 } })).status).toBe(404);
    expect(updates).toHaveLength(0);
  });

  it('an org-scope caller cannot write its own override', async () => {
    currentAuth = orgAuth();
    const res = await put({ orgId: ORG, limits: { monthlyRunsPerFlow: 1 } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'org_scope_read_only' });
    expect(updates).toHaveLength(0);
  });

  it('a partner user without partner-wide authority may still lower an org it can access', async () => {
    currentAuth = partnerAuth({ partnerOrgAccess: 'selected' });
    expect((await put({ orgId: ORG, limits: { monthlyRunsPerFlow: 1 } })).status).toBe(200);
  });
});

describe('flowLimitsSettingsUpdate', () => {
  it('only whitelisted keys reach SQL, as bound parameters', () => {
    const q = new PgDialect().sqlToQuery(flowLimitsSettingsUpdate('settings_col' as never, { monthlyRunsPerOwner: 7, aiTokensPerRun: null }));
    expect(q.params).toEqual(expect.arrayContaining(['aiTokensPerRun', 'monthlyRunsPerOwner', 7]));
    expect(q.sql).not.toContain('monthlyRunsPerOwner');
  });
});
