import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

vi.mock('../../db', () => ({ db: { select: vi.fn() } }));
vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    const scope = c.req.header('x-scope') ?? 'partner';
    c.set('auth', {
      scope,
      partnerId: '33333333-3333-4333-8333-333333333333',
      orgId: scope === 'organization' ? '11111111-1111-4111-8111-111111111111' : null,
      accessibleOrgIds: ['11111111-1111-4111-8111-111111111111'],
      canAccessOrg: (id: string) => id === '11111111-1111-4111-8111-111111111111',
    });
    return next();
  }),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (c.req.header('x-deny-permission')) return c.json({ error: 'Forbidden' }, 403);
    const sites = c.req.header('x-sites');
    c.set('permissions', { allowedSiteIds: sites === undefined ? null : JSON.parse(sites) });
    return next();
  }),
}));

import { db } from '../../db';
import { complianceRoutes } from './compliance';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const POLICY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONFIG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LINK = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEVICE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const dialect = new PgDialect();
const app = new Hono().route('/policies', complianceRoutes);

type Captured = { sql: string; params: unknown[] };
const conditions = new Map<string, Captured>();

// Each query keeps its actual Drizzle predicate; assertions below inspect SQL
// and bound values as well as the response assembled from the returned rows.
function query(name: string, rows: unknown[]) {
  const chain: any = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn((condition?: SQL) => {
      conditions.set(name, condition ? dialect.sqlToQuery(condition) : { sql: '', params: [] });
      return chain;
    }),
    groupBy: vi.fn(() => chain),
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
  };
  vi.mocked(db.select).mockReturnValueOnce(chain);
}

function prepare(emptySites = false) {
  query('policies', [{ id: POLICY, name: 'Legacy', enforcement: 'monitor' }]);
  if (!emptySites) query('legacyTotals', [{ policyId: POLICY, status: 'non_compliant', count: 1 }]);
  query('policyCount', [{ total: 1, enabled: 1 }]);
  query('configCount', [{ total: 1, active: 1 }]);
  query('enforcement', [{ enforcement: 'monitor', count: 1 }]);
  query('rules', [{
    configPolicyId: CONFIG, configPolicyName: 'Config', featureLinkId: LINK,
    complianceRuleId: POLICY, complianceRuleName: 'Rule', enforcementLevel: 'warn',
  }]);
  if (!emptySites) {
    query('configTotals', [{ configPolicyId: LINK, status: 'non_compliant', count: 1 }]);
    const row = {
      deviceId: DEVICE, hostname: 'allowed-device', status: 'non_compliant',
      details: {}, lastCheckedAt: new Date('2026-09-04T00:00:00Z'),
    };
    query('legacyDevices', [{ ...row, policyId: POLICY }]);
    query('configDevices', [{ ...row, configPolicyId: LINK, configItemName: 'Rule' }]);
  }
}

function request(sites?: string[], suffix = '', scope = 'partner', path = '/policies/compliance/summary') {
  return app.request(`${path}${suffix}`, {
    headers: {
      authorization: 'Bearer test',
      'x-scope': scope,
      ...(sites ? { 'x-sites': JSON.stringify(sites) } : {}),
    },
  });
}

// GET /compliance/stats issues: policyCount, configCount, policyIds,
// legacyTotals (skipped on []), rules, configTotals (skipped on []).
function prepareStats(emptySites = false) {
  query('policyCount', [{ total: 1, enabled: 1 }]);
  query('configCount', [{ total: 1, active: 1 }]);
  query('policyIds', [{ id: POLICY }]);
  if (!emptySites) query('legacyTotals', [{ status: 'non_compliant', count: 1 }]);
  query('rules', [{
    configPolicyId: CONFIG, configPolicyName: 'Config', featureLinkId: LINK,
    complianceRuleId: POLICY, complianceRuleName: 'Rule', enforcementLevel: 'warn',
  }]);
  if (!emptySites) query('configTotals', [{ configPolicyId: LINK, status: 'compliant', count: 1 }]);
}

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  conditions.clear();
});

describe('GET /policies/compliance/summary site isolation (#4880)', () => {
  it('narrows both device sources and their totals using the live permissions context', async () => {
    prepare();
    const response = await request([SITE], `?orgId=${ORG}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.nonCompliantDevices).toHaveLength(1);
    expect(body.nonCompliantDevices[0]).toMatchObject({ deviceId: DEVICE, deviceName: 'allowed-device' });
    expect(body.overall).toEqual({ total: 2, compliant: 0, nonCompliant: 2, unknown: 0 });
    for (const name of ['legacyTotals', 'configTotals', 'legacyDevices', 'configDevices']) {
      const condition = conditions.get(name)!;
      expect(condition.sql, name).toContain('"devices"."site_id" in');
      expect(condition.params, name).toContain(SITE);
      expect(condition.params, name).toContain(name.startsWith('legacy') ? POLICY : LINK);
    }
    for (const name of ['legacyTotals', 'configTotals']) {
      expect(conditions.get(name)!.sql).toContain('"devices"."id" = "automation_policy_compliance"."device_id"');
    }
    expect(conditions.get('policies')!.params).toContain(ORG);
    expect(conditions.get('rules')!.params).toContain(ORG);
    // Policy inventory is org-wide; it is not a count of observed devices.
    expect(body.totalPolicies).toBe(2);
    expect(body.byEnforcement).toEqual({ monitor: 1, warn: 1, enforce: 0 });
    expect(conditions.get('policyCount')!.params).not.toContain(SITE);
  });

  it('returns no device observations and skips all compliance queries for an empty site allowlist', async () => {
    prepare(true);
    const response = await request([]);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.nonCompliantDevices).toEqual([]);
    expect(body.overall).toEqual({ total: 0, compliant: 0, nonCompliant: 0, unknown: 0 });
    expect(body.complianceRate).toBe(0);
    expect(body.totalPolicies).toBe(2);
    expect(db.select).toHaveBeenCalledTimes(5);
  });

  it('narrows an organization-scope caller restricted to two sites, binding both site ids', async () => {
    const SITE2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    prepare();
    const response = await request([SITE, SITE2], '', 'organization');
    expect(response.status).toBe(200);
    expect((await response.json()).nonCompliantDevices).toHaveLength(1);
    for (const name of ['legacyTotals', 'configTotals', 'legacyDevices', 'configDevices']) {
      const condition = conditions.get(name)!;
      expect(condition.sql, name).toContain('"devices"."site_id" in');
      expect(condition.params, name).toContain(SITE);
      expect(condition.params, name).toContain(SITE2);
    }
    // Org scope resolves orgIds from the token, not the query string.
    expect(conditions.get('policies')!.params).toContain(ORG);
  });

  it('counts a feature link once per config policy, not once per compliance rule', async () => {
    query('policies', []);
    query('policyCount', [{ total: 0, enabled: 0 }]);
    query('configCount', [{ total: 1, active: 1 }]);
    query('enforcement', []);
    const rule = {
      configPolicyId: CONFIG, configPolicyName: 'Config', featureLinkId: LINK,
      complianceRuleName: 'Rule', enforcementLevel: 'monitor',
    };
    query('rules', [
      { ...rule, complianceRuleId: POLICY },
      { ...rule, complianceRuleId: DEVICE, enforcementLevel: 'enforce' },
      { ...rule, complianceRuleId: SITE, enforcementLevel: 'warn' },
    ]);
    query('configTotals', [{ configPolicyId: LINK, status: 'non_compliant', count: 1 }]);
    query('configDevices', []);
    const response = await request();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.policies).toHaveLength(1);
    expect(body.policies[0]).toMatchObject({
      policyId: CONFIG, enforcementLevel: 'enforce',
      compliance: { total: 1, nonCompliant: 1 },
    });
    expect(body.overall).toEqual({ total: 1, compliant: 0, nonCompliant: 1, unknown: 0 });
  });

  it('preserves unrestricted compliance reads', async () => {
    prepare();
    const response = await request();
    expect(response.status).toBe(200);
    expect((await response.json()).overall.total).toBe(2);
    for (const name of ['legacyTotals', 'configTotals', 'legacyDevices', 'configDevices']) {
      expect(conditions.get(name)!.sql).not.toContain('site_id');
    }
  });

  it('denies an inaccessible organization before reading data', async () => {
    const response = await request([SITE], '?orgId=22222222-2222-4222-8222-222222222222');
    expect(response.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    const response = await app.request('/policies/compliance/summary');
    expect(response.status).toBe(401);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('requires device read permission before reading data', async () => {
    const response = await app.request('/policies/compliance/summary', {
      headers: { authorization: 'Bearer test', 'x-deny-permission': 'true' },
    });
    expect(response.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('GET /policies/compliance/stats site isolation (#4880)', () => {
  const STATS = '/policies/compliance/stats';

  it('narrows legacy and config compliance totals to the site allowlist', async () => {
    prepareStats();
    const response = await request([SITE], `?orgId=${ORG}`, 'partner', STATS);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.complianceOverview).toEqual({ compliant: 1, non_compliant: 1, pending: 0 });
    expect(body.data.complianceRate).toBe(50);
    expect(body.data.totalPolicies).toBe(2);
    for (const name of ['legacyTotals', 'configTotals']) {
      const condition = conditions.get(name)!;
      expect(condition.sql, name).toContain('"devices"."site_id" in');
      expect(condition.sql, name).toContain('"devices"."id" = "automation_policy_compliance"."device_id"');
      expect(condition.params, name).toContain(SITE);
    }
    expect(conditions.get('policyCount')!.params).not.toContain(SITE);
    expect(conditions.get('configCount')!.params).not.toContain(SITE);
  });

  it('reports zero observations and skips compliance queries for an empty allowlist', async () => {
    prepareStats(true);
    const response = await request([], '', 'partner', STATS);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.complianceOverview).toEqual({ compliant: 0, non_compliant: 0, pending: 0 });
    expect(body.data.complianceRate).toBe(0);
    expect(body.data.totalPolicies).toBe(2);
    expect(db.select).toHaveBeenCalledTimes(4);
  });

  it('preserves unrestricted reads', async () => {
    prepareStats();
    const response = await request(undefined, '', 'organization', STATS);
    expect(response.status).toBe(200);
    for (const name of ['legacyTotals', 'configTotals']) {
      expect(conditions.get(name)!.sql).not.toContain('site_id');
    }
  });

  it('requires device read permission before reading data', async () => {
    const response = await app.request(STATS, {
      headers: { authorization: 'Bearer test', 'x-deny-permission': 'true' },
    });
    expect(response.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });
});
