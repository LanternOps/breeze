import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { monitorDefinitions, organizations, partners } from '../../db/schema';

const h = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  granted: new Set<string>(),
  rows: new Map<unknown, Array<Record<string, unknown>>>(),
  updates: [] as Array<{ table: unknown; set: Record<string, unknown> }>,
  updateReturning: [{ id: 'row' }] as unknown[],
  audit: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    if (!scopes.includes(h.auth.scope as string)) return c.json({ error: 'Forbidden' }, 403);
    c.set('auth', h.auth);
    await next();
  },
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    if (!h.granted.has(`${resource}:${action}`)) return c.json({ error: 'Forbidden' }, 403);
    await next();
  },
  requireMfa: () => async (_c: any, next: any) => next(),
}));

vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const result = h.rows.get(table) ?? [];
          return { limit: async () => result, then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve) };
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        h.updates.push({ table, set });
        return { where: () => ({ returning: async () => h.updateReturning }) };
      },
    }),
  },
}));
vi.mock('../../db/partnerAxisRead', () => ({
  readWithPartnerAxisVisibility: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: h.audit }));

import { lifecycleDefaultsRoutes } from './lifecycleDefaults';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG = '33333333-3333-4333-8333-333333333333';
const READ = 'alerts:read';
const WRITE = 'alerts:write';

const PARTNER_ROW = {
  alertAutoResolve: true, alertRearmMode: 'after_delay', alertRearmDelayMinutes: 60, alertCooldownMinutes: 10,
};
const PARTNER_VALUES = { autoResolve: true, rearmMode: 'after_delay', rearmDelayMinutes: 60, cooldownMinutes: 10 };
const orgRow = (overrides: Record<string, unknown> = {}) => ({
  partnerId: PARTNER, alertAutoResolve: null, alertRearmMode: null, alertRearmDelayMinutes: null, alertCooldownMinutes: null, ...overrides,
});
const allSources = (source: string) => ({
  autoResolve: source, rearmMode: source, rearmDelayMinutes: source, cooldownMinutes: source,
});

function asOrgUser() {
  h.auth = {
    scope: 'organization', partnerId: PARTNER, orgId: ORG, partnerOrgAccess: null,
    user: { id: 'u-1', email: 'u@example.test' }, canAccessOrg: (id: string) => id === ORG,
  };
}
function asPartnerUser(partnerOrgAccess: 'all' | 'selected' = 'all', accessible: string[] = [ORG]) {
  h.auth = {
    scope: 'partner', partnerId: PARTNER, orgId: null, partnerOrgAccess,
    user: { id: 'u-2', email: 'p@example.test' }, canAccessOrg: (id: string) => accessible.includes(id),
  };
}

const app = () => {
  const root = new Hono();
  root.route('/alerts', lifecycleDefaultsRoutes);
  return root;
};
const get = (query = '') => app().request(`/alerts/lifecycle-defaults${query}`);
const put = (body: unknown) => app().request('/alerts/lifecycle-defaults', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

const partnerBody = { scope: 'partner', autoResolve: false, rearmMode: 'new_evidence', rearmDelayMinutes: null, cooldownMinutes: 15 };
const orgBody = { scope: 'organization', orgId: ORG, autoResolve: null, rearmMode: null, rearmDelayMinutes: null, cooldownMinutes: null };

beforeEach(() => {
  h.audit.mockReset();
  h.granted = new Set([READ, WRITE]);
  h.updates.length = 0;
  h.updateReturning = [{ id: 'row' }];
  h.rows.clear();
  h.rows.set(partners, [PARTNER_ROW]);
  h.rows.set(organizations, [orgRow()]);
  h.rows.set(monitorDefinitions, [{ autoResolve: 1, rearmMode: 2, rearmDelayMinutes: 2, cooldownMinutes: 3 }]);
  asOrgUser();
});

describe('GET /alerts/lifecycle-defaults', () => {
  it('org user reads the inherited value and source', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      partner: PARTNER_VALUES,
      org: { autoResolve: null, rearmMode: null, rearmDelayMinutes: null, cooldownMinutes: null },
      effective: PARTNER_VALUES,
      sources: allSources('partner'),
      monitorOverrideCounts: { autoResolve: 1, rearmMode: 2, rearmDelayMinutes: 2, cooldownMinutes: 3 },
    });
  });

  it('an org override shows as the effective value with source org', async () => {
    h.rows.set(organizations, [orgRow({ alertCooldownMinutes: 0 })]);
    const body = await (await get()).json();
    expect(body.effective.cooldownMinutes).toBe(0);
    expect(body.sources.cooldownMinutes).toBe('org');
    expect(body.effective.autoResolve).toBe(true);
    expect(body.sources.autoResolve).toBe('partner');
  });

  it('partner scope with no org reads the partner default and no org block', async () => {
    asPartnerUser();
    const body = await (await get()).json();
    expect(body.org).toBeNull();
    expect(body.partner).toEqual(PARTNER_VALUES);
    expect(body.effective).toEqual(PARTNER_VALUES);
    expect(body.sources).toEqual(allSources('partner'));
  });

  it('partner scope with an org selected reads that org', async () => {
    asPartnerUser();
    h.rows.set(organizations, [orgRow({ alertAutoResolve: false })]);
    const body = await (await get(`?orgId=${ORG}`)).json();
    expect(body.org.autoResolve).toBe(false);
    expect(body.sources.autoResolve).toBe('org');
  });

  it('rejects an org the caller cannot access', async () => {
    expect((await get(`?orgId=${OTHER_ORG}`)).status).toBe(403);
    asPartnerUser('selected', []);
    expect((await get(`?orgId=${ORG}`)).status).toBe(403);
  });

  it('hides an org of another partner that passes the access check', async () => {
    asPartnerUser('all', [OTHER_ORG]);
    h.rows.set(organizations, [orgRow({ partnerId: '99999999-9999-4999-8999-999999999999' })]);
    expect((await get(`?orgId=${OTHER_ORG}`)).status).toBe(404);
  });

  it('a missing org is 404, and an org-scoped caller with no org context is 403', async () => {
    h.rows.set(organizations, []);
    expect((await get()).status).toBe(404);
    h.auth = { ...h.auth, orgId: null };
    expect((await get()).status).toBe(403);
  });

  it('system scope with no org and no partner has nothing to read', async () => {
    h.auth = { scope: 'system', partnerId: null, orgId: null, partnerOrgAccess: null, canAccessOrg: () => true };
    expect((await get()).status).toBe(400);
  });

  it('requires ALERTS_READ', async () => {
    h.granted = new Set([WRITE]);
    expect((await get()).status).toBe(403);
  });
});

describe('PUT /alerts/lifecycle-defaults', () => {
  it('partner-scope write requires canManagePartnerWidePolicies', async () => {
    asPartnerUser('selected');
    const denied = await put(partnerBody);
    expect(denied.status).toBe(403);
    expect(h.updates).toHaveLength(0);
    expect(h.audit).not.toHaveBeenCalled();

    asPartnerUser('all');
    const ok = await put(partnerBody);
    expect(ok.status).toBe(200);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]!.table).toBe(partners);
    expect(h.updates[0]!.set).toMatchObject({
      alertAutoResolve: false, alertRearmMode: 'new_evidence', alertRearmDelayMinutes: null, alertCooldownMinutes: 15,
    });
  });

  it('an org-scoped user can never write the partner default', async () => {
    asOrgUser();
    expect((await put(partnerBody)).status).toBe(403);
    expect(h.updates).toHaveLength(0);
  });

  it('audit-logs the partner write on the partner axis', async () => {
    asPartnerUser('all');
    await put(partnerBody);
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: null, partnerId: PARTNER, action: 'alert.lifecycle_defaults.update', resourceType: 'partner', resourceId: PARTNER,
      details: expect.objectContaining({ level: 'partner', cooldownMinutes: 15 }),
    }));
  });

  it('partner write without a partner context is 400', async () => {
    h.auth = { scope: 'system', partnerId: null, orgId: null, partnerOrgAccess: null, canAccessOrg: () => true };
    expect((await put(partnerBody)).status).toBe(400);
  });

  it("org write rejected for another partner's org", async () => {
    // The caller's access list does not reach it.
    asPartnerUser('all', [ORG]);
    expect((await put({ ...orgBody, orgId: OTHER_ORG })).status).toBe(403);
    // A row that passes the access check but belongs elsewhere is hidden.
    asPartnerUser('all', [OTHER_ORG]);
    h.rows.set(organizations, [orgRow({ partnerId: '99999999-9999-4999-8999-999999999999' })]);
    expect((await put({ ...orgBody, orgId: OTHER_ORG })).status).toBe(404);
    expect(h.updates).toHaveLength(0);
  });

  it('a site-restricted org user cannot change the org-wide setting', async () => {
    h.auth = { ...h.auth, allowedSiteIds: ['44444444-4444-4444-8444-444444444444'] };
    const res = await put(orgBody);
    expect(res.status).toBe(403);
    expect(h.updates).toHaveLength(0);
    expect(h.audit).not.toHaveBeenCalled();
    // Reading what it inherits is still allowed.
    expect((await get()).status).toBe(200);
  });

  it('an exact-device-ceiling caller cannot change either level', async () => {
    asPartnerUser('all');
    h.auth = { ...h.auth, allowedDeviceIds: ['55555555-5555-4555-8555-555555555555'] };
    expect((await put(partnerBody)).status).toBe(403);
    expect((await put(orgBody)).status).toBe(403);
    expect(h.updates).toHaveLength(0);
  });

  it('a selected-access partner user may write an org it can reach, not the partner default', async () => {
    asPartnerUser('selected', [ORG]);
    expect((await put(orgBody)).status).toBe(200);
    expect(h.updates[0]!.table).toBe(organizations);
  });

  it('null saves inherit', async () => {
    const res = await put(orgBody);
    expect(res.status).toBe(200);
    expect(h.updates[0]!.table).toBe(organizations);
    expect(h.updates[0]!.set).toMatchObject({
      alertAutoResolve: null, alertRearmMode: null, alertRearmDelayMinutes: null, alertCooldownMinutes: null,
    });
    const body = await res.json();
    expect(body.effective).toEqual(PARTNER_VALUES);
    expect(body.sources).toEqual(allSources('partner'));
  });

  it('audit-logs the org write on the org axis', async () => {
    await put({ ...orgBody, cooldownMinutes: 0 });
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG, action: 'alert.lifecycle_defaults.update', resourceType: 'organization', resourceId: ORG,
      details: expect.objectContaining({ level: 'organization', cooldownMinutes: 0 }),
    }));
  });

  it('an org whose update hits no row is 404 with no audit', async () => {
    h.updateReturning = [];
    expect((await put(orgBody)).status).toBe(404);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('after_delay without minutes is 400', async () => {
    expect((await put({ ...orgBody, rearmMode: 'after_delay' })).status).toBe(400);
    asPartnerUser('all');
    expect((await put({ ...partnerBody, rearmMode: 'after_delay' })).status).toBe(400);
    expect(h.updates).toHaveLength(0);
  });

  it('omitting a field is 400: a PUT never wipes a value the client did not send', async () => {
    const { cooldownMinutes: _omit, ...partial } = orgBody;
    expect((await put(partial)).status).toBe(400);
    expect(h.updates).toHaveLength(0);
  });

  it('requires ALERTS_WRITE', async () => {
    h.granted = new Set([READ]);
    expect((await put(orgBody)).status).toBe(403);
    expect(h.updates).toHaveLength(0);
  });
});
