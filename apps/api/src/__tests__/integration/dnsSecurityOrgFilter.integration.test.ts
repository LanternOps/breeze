/**
 * #10931 — the DNS Security reads honour the selected org, on real Postgres.
 *
 * THE DEFECT: GET /dns-security/events, /integrations, /stats, /top-blocked
 * and /policies ignored `?orgId=`. A partner technician with one customer
 * selected saw every customer they can reach under that customer's name, and
 * an orgId outside their reach answered 200 instead of 403. RLS kept foreign
 * partners' rows out, so this was wrong-org display, not a cross-tenant read.
 *
 * Drives the real router (authMiddleware -> requireScope -> requirePermission
 * -> handler) with minted tokens, so access comes from genuine memberships and
 * the queries run as `breeze_app` under forced RLS. Each org gets a different
 * number of rows, so a count shows which orgs a read covered.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/dnsSecurityOrgFilter.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { dnsSecurityRoutes } from '../../routes/dnsSecurity';
import { dnsEventAggregations, dnsFilterIntegrations, dnsPolicies, dnsSecurityEvents } from '../../db/schema';
import { createAccessToken } from '../../services/jwt';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const DEVICES_READ = [{ resource: 'devices', action: 'read' }];
const DAY_MS = 86_400_000;

const app = new Hono();
app.route('/dns-security', dnsSecurityRoutes);

type Token = string;

async function mint(
  user: { id: string; email: string },
  roleId: string,
  scope: { partnerId: string; orgId: string | null; scope: 'partner' | 'organization' },
): Promise<Token> {
  return createAccessToken({
    sub: user.id, email: user.email, roleId, orgId: scope.orgId, partnerId: scope.partnerId,
    scope: scope.scope, mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
}

function get(token: Token, path: string) {
  return app.request(`/dns-security${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

/**
 * One integration, one policy, `count` blocked events and one aggregation row
 * of `count * 10` blocked queries, all tagged with `tag`.
 */
async function seedOrgDns(orgId: string, tag: string, count: number, config: Record<string, unknown> = {}) {
  const database = getTestDb() as any;
  const [integration] = await database.insert(dnsFilterIntegrations).values({
    orgId, provider: 'umbrella', name: `${tag}-integration`, config,
  }).returning();
  await database.insert(dnsPolicies).values({
    orgId, integrationId: integration.id, name: `${tag}-policy`, type: 'blocklist',
  });
  const now = Date.now();
  await database.insert(dnsSecurityEvents).values(
    Array.from({ length: count }, (_, i) => ({
      orgId,
      integrationId: integration.id,
      timestamp: new Date(now - (i + 1) * 60_000),
      domain: `${tag}.example`,
      action: 'blocked',
      providerEventId: `${tag}-${i}`,
    })),
  );
  await database.insert(dnsEventAggregations).values({
    orgId,
    integrationId: integration.id,
    date: new Date(now - 3 * DAY_MS).toISOString().slice(0, 10),
    domain: `${tag}.example`,
    totalQueries: count * 10,
    blockedQueries: count * 10,
    allowedQueries: 0,
  });
}

async function seed() {
  const u = randomUUID().slice(0, 8);
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const foreignPartner = await createPartner();
  const orgForeign = await createOrganization({ partnerId: foreignPartner.id });

  // Only org A's integration stores allowed traffic (#10054), so /stats'
  // allowedTraffic coverage shows which integrations a read looked at.
  await seedOrgDns(orgA.id, `a-${u}`, 1, { storeAllowedTraffic: true });
  await seedOrgDns(orgB.id, `b-${u}`, 2);
  await seedOrgDns(orgForeign.id, `x-${u}`, 4);

  const pRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(pRole.id, DEVICES_READ);
  const tech = await createUser({ partnerId: partner.id, email: `dns-org-tech-${u}@example.test` });
  await assignUserToPartner(tech.id, partner.id, pRole.id, 'all');

  const orgRole = await createRole({ scope: 'organization', orgId: orgA.id, partnerId: partner.id });
  await grantRolePermissions(orgRole.id, DEVICES_READ);
  const orgUser = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `dns-org-user-${u}@example.test` });
  await assignUserToOrganization(orgUser.id, orgA.id, orgRole.id);

  return {
    u,
    orgA: orgA.id,
    orgB: orgB.id,
    orgForeign: orgForeign.id,
    tech: await mint(tech, pRole.id, { partnerId: partner.id, orgId: null, scope: 'partner' }),
    orgUser: await mint(orgUser, orgRole.id, { partnerId: partner.id, orgId: orgA.id, scope: 'organization' }),
  };
}

function aggWindow(): string {
  const end = new Date();
  const start = new Date(end.getTime() - 10 * DAY_MS);
  return `start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;
}

function withOrg(path: string, orgId: string | null): string {
  if (!orgId) return path;
  return `${path}${path.includes('?') ? '&' : '?'}orgId=${orgId}`;
}

/** What each read returns, reduced to the orgs it covered. */
const READS = [
  {
    name: 'GET /events',
    path: () => '/events',
    orgs: (body: any) => new Set(body.data.map((r: any) => r.orgId)),
    total: (body: any) => body.data.length,
  },
  {
    name: 'GET /integrations',
    path: () => '/integrations',
    orgs: (body: any) => new Set(body.data.map((r: any) => r.orgId)),
    total: (body: any) => body.data.length,
  },
  {
    name: 'GET /policies',
    path: () => '/policies',
    orgs: (body: any) => new Set(body.data.map((r: any) => r.orgId)),
    total: (body: any) => body.data.length,
  },
] as const;

describe('DNS Security reads honour the selected org (#10931)', () => {
  it.each(READS)('$name lists only the selected org, and both siblings with no orgId', async (read) => {
    const s = await seed();

    const a = await get(s.tech, withOrg(read.path(), s.orgA));
    expect(a.status).toBe(200);
    expect([...read.orgs(await a.json())]).toEqual([s.orgA]);

    const b = await get(s.tech, withOrg(read.path(), s.orgB));
    expect(b.status).toBe(200);
    expect([...read.orgs(await b.json())]).toEqual([s.orgB]);

    const all = await get(s.tech, read.path());
    expect(all.status).toBe(200);
    expect(read.orgs(await all.json())).toEqual(new Set([s.orgA, s.orgB]));
  });

  it('GET /stats (raw) counts only the selected org', async () => {
    const s = await seed();
    const total = async (orgId: string | null) => {
      const res = await get(s.tech, withOrg('/stats', orgId));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.source).toBe('raw');
      return body.summary.totalQueries;
    };
    expect(await total(s.orgA)).toBe(1);
    expect(await total(s.orgB)).toBe(2);
    expect(await total(null)).toBe(3);
  });

  it('GET /stats (aggregated) counts only the selected org', async () => {
    const s = await seed();
    const total = async (orgId: string | null) => {
      const res = await get(s.tech, withOrg(`/stats?${aggWindow()}`, orgId));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.source).toBe('aggregated');
      return body.summary.totalQueries;
    };
    expect(await total(s.orgA)).toBe(10);
    expect(await total(s.orgB)).toBe(20);
    expect(await total(null)).toBe(30);
  });

  it.each([
    { name: 'raw', path: () => '/stats' },
    { name: 'aggregated', path: () => `/stats?${aggWindow()}` },
  ])('GET /stats ($name) reports allowed-traffic coverage for the selected org only', async ({ path }) => {
    const s = await seed();
    const coverage = async (orgId: string | null) => {
      const res = await get(s.tech, withOrg(path(), orgId));
      expect(res.status).toBe(200);
      return (await res.json()).allowedTraffic;
    };
    expect(await coverage(s.orgA)).toBe('all');
    expect(await coverage(s.orgB)).toBe('none');
    expect(await coverage(null)).toBe('some');
  });

  it.each([
    { name: 'raw', path: () => '/top-blocked', source: 'raw' },
    { name: 'aggregated', path: () => `/top-blocked?${aggWindow()}`, source: 'aggregated' },
  ])('GET /top-blocked ($name) ranks only the selected org', async ({ path, source }) => {
    const s = await seed();
    const domains = async (orgId: string | null) => {
      const res = await get(s.tech, withOrg(path(), orgId));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.source).toBe(source);
      return new Set(body.data.map((r: any) => r.domain));
    };
    expect(await domains(s.orgA)).toEqual(new Set([`a-${s.u}.example`]));
    expect(await domains(s.orgB)).toEqual(new Set([`b-${s.u}.example`]));
    expect(await domains(null)).toEqual(new Set([`a-${s.u}.example`, `b-${s.u}.example`]));
  });

  const ALL_PATHS = ['/events', '/integrations', '/policies', '/stats', '/top-blocked'];

  it.each(ALL_PATHS)('%s refuses a foreign partner org with 403', async (path) => {
    const s = await seed();
    const res = await get(s.tech, withOrg(path, s.orgForeign));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Access to this organization denied');
  });

  it.each(ALL_PATHS)('%s refuses an org-scope caller naming a sibling org', async (path) => {
    const s = await seed();
    const res = await get(s.orgUser, withOrg(path, s.orgB));
    expect(res.status).toBe(403);
  });

  it('an org-scope caller naming its own org reads only that org', async () => {
    const s = await seed();
    const res = await get(s.orgUser, withOrg('/events', s.orgA));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(new Set(body.data.map((r: any) => r.orgId))).toEqual(new Set([s.orgA]));
  });
});
