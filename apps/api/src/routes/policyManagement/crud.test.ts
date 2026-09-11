import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

vi.mock('../../db', () => ({ db: { select: vi.fn() } }));
vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', {
      scope: 'organization',
      orgId: '11111111-1111-4111-8111-111111111111',
      partnerId: '33333333-3333-4333-8333-333333333333',
      canAccessOrg: (id: string) => id === '11111111-1111-4111-8111-111111111111',
    });
    return next();
  }),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (c.req.header('x-deny-permission')) return c.json({ error: 'Forbidden' }, 403);
    const sites = c.req.header('x-sites');
    c.set('permissions', { allowedSiteIds: sites === undefined ? undefined : JSON.parse(sites) });
    return next();
  }),
}));

import { db } from '../../db';
import { crudRoutes } from './crud';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const POLICY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const dialect = new PgDialect();
const app = new Hono().route('/policies', crudRoutes);

type Captured = { sql: string; params: unknown[] };
const conditions = new Map<string, Captured>();

function query(name: string, rows: unknown[]) {
  const chain: any = {
    from: vi.fn(() => chain),
    where: vi.fn((condition?: SQL) => {
      conditions.set(name, condition ? dialect.sqlToQuery(condition) : { sql: '', params: [] });
      return chain;
    }),
    groupBy: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    offset: vi.fn(() => chain),
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
  };
  vi.mocked(db.select).mockReturnValueOnce(chain);
}

const policyRow = {
  id: POLICY, orgId: ORG, partnerId: null, name: 'Legacy', enforcement: 'monitor',
  enabled: true, targets: { type: 'all' }, rules: [], remediationScriptId: null,
};

function request(path: string, sites?: string[]) {
  return app.request(path, {
    headers: { authorization: 'Bearer test', ...(sites ? { 'x-sites': JSON.stringify(sites) } : {}) },
  });
}

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  conditions.clear();
});

describe('GET /policies site isolation (#4880)', () => {
  it('narrows embedded per-policy compliance counts to the site allowlist', async () => {
    query('count', [{ count: 1 }]);
    query('list', [policyRow]);
    query('compliance', [{ policyId: POLICY, status: 'non_compliant', count: 1 }]);
    const response = await request('/policies', [SITE]);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data[0].compliance).toMatchObject({ total: 1, nonCompliant: 1 });
    const condition = conditions.get('compliance')!;
    expect(condition.sql).toContain('"devices"."site_id" in');
    expect(condition.sql).toContain('"devices"."id" = "automation_policy_compliance"."device_id"');
    expect(condition.params).toContain(SITE);
    expect(condition.params).toContain(POLICY);
    expect(conditions.get('list')!.params).not.toContain(SITE);
  });

  it('returns empty compliance and skips the compliance query for an empty allowlist', async () => {
    query('count', [{ count: 1 }]);
    query('list', [policyRow]);
    const response = await request('/policies', []);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data[0].compliance).toMatchObject({ total: 0, nonCompliant: 0 });
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('preserves unrestricted reads', async () => {
    query('count', [{ count: 1 }]);
    query('list', [policyRow]);
    query('compliance', [{ policyId: POLICY, status: 'compliant', count: 3 }]);
    const response = await request('/policies');
    expect(response.status).toBe(200);
    expect((await response.json()).data[0].compliance.total).toBe(3);
    expect(conditions.get('compliance')!.sql).not.toContain('site_id');
  });

  it('requires device read permission before reading data', async () => {
    const response = await app.request('/policies', {
      headers: { authorization: 'Bearer test', 'x-deny-permission': 'true' },
    });
    expect(response.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('GET /policies/:id site isolation (#4880)', () => {
  it('narrows the compliance summary to the site allowlist', async () => {
    query('policy', [policyRow]);
    query('compliance', [{ status: 'non_compliant', count: 2 }]);
    const response = await request(`/policies/${POLICY}`, [SITE]);
    expect(response.status).toBe(200);
    expect((await response.json()).compliance).toMatchObject({ total: 2, nonCompliant: 2 });
    const condition = conditions.get('compliance')!;
    expect(condition.sql).toContain('"devices"."site_id" in');
    expect(condition.params).toContain(SITE);
    expect(condition.params).toContain(POLICY);
  });

  it('returns an empty summary without querying compliance for an empty allowlist', async () => {
    query('policy', [policyRow]);
    const response = await request(`/policies/${POLICY}`, []);
    expect(response.status).toBe(200);
    expect((await response.json()).compliance).toMatchObject({ total: 0 });
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('requires device read permission before reading data', async () => {
    const response = await app.request(`/policies/${POLICY}`, {
      headers: { authorization: 'Bearer test', 'x-deny-permission': 'true' },
    });
    expect(response.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });
});
