import '../__tests__/integration/setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { dnsFilterIntegrations, organizationUsers, partnerUsers, psaConnections, users } from '../db/schema';
import { getTestDb } from '../__tests__/integration/setup';
import {
  assignUserToOrganization, assignUserToPartner, createOrganization, createPartner,
  createRole, createSite, createUser, grantRolePermissions,
} from '../__tests__/integration/db-utils';
import { createAccessToken } from '../services/jwt';
import { encryptCredentials } from '../services/psa/credentials';

const effects = vi.hoisted(() => ({ provider: vi.fn(), test: vi.fn(), sync: vi.fn(), policy: vi.fn(), audit: vi.fn() }));
// Network/queue sinks are mocked; bearer validation, membership/permission
// resolution, encryption and all connection SQL use production code.
vi.mock('../services/psa', () => ({ createPSAProvider: effects.provider }));
vi.mock('../jobs/dnsSyncJob', () => ({ scheduleDnsEventSync: effects.sync, schedulePolicySync: effects.policy }));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: effects.audit }));
import { psaRoutes } from './psa';
import { dnsSecurityRoutes } from './dnsSecurity';

const credentials = { baseUrl: 'https://example.atlassian.net', email: 'admin@example.com', apiToken: 'synthetic-token' };

async function fixture(mode: 'selected-site' | 'empty-sites' | 'organization' | 'selected-partner' | 'partner' | 'system') {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const otherOrg = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const orgScope = ['selected-site', 'empty-sites', 'organization'].includes(mode);
  const scope = orgScope ? 'organization' : mode === 'system' ? 'system' : 'partner';
  const role = await createRole({ scope: orgScope ? 'organization' : 'partner', orgId: orgScope ? org.id : undefined, partnerId: partner.id });
  await grantRolePermissions(role.id, [{ resource: 'organizations', action: 'write' }]);
  const user = await createUser({ partnerId: partner.id, orgId: orgScope ? org.id : null, mfaEnabled: true, email: `${randomUUID()}@example.test` });
  if (orgScope) {
    const membership = await assignUserToOrganization(user.id, org.id, role.id);
    if (mode !== 'organization') {
      await getTestDb().update(organizationUsers).set({ siteIds: mode === 'empty-sites' ? [] : [site.id] }).where(eq(organizationUsers.id, membership.id));
    }
  } else {
    const membership = await assignUserToPartner(user.id, partner.id, role.id, mode === 'selected-partner' ? 'selected' : 'all');
    if (mode === 'selected-partner') {
      await getTestDb().update(partnerUsers).set({ orgIds: [org.id] }).where(eq(partnerUsers.id, membership.id));
    }
    if (mode === 'system') await getTestDb().update(users).set({ isPlatformAdmin: true }).where(eq(users.id, user.id));
  }
  const token = await createAccessToken({
    sub: user.id, email: user.email, roleId: role.id, scope,
    orgId: orgScope ? org.id : null, partnerId: partner.id,
    mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
  const [psa] = await getTestDb().insert(psaConnections).values({ orgId: org.id, name: 'Original PSA', provider: 'jira', credentials: encryptCredentials(credentials) }).returning();
  const [dns] = await getTestDb().insert(dnsFilterIntegrations).values({ orgId: org.id, name: 'Original DNS', provider: 'cloudflare', apiKey: 'synthetic-stored-key' }).returning();
  const app = new Hono();
  app.route('/api/v1/psa', psaRoutes);
  app.route('/api/v1/dns-security', dnsSecurityRoutes);
  const request = (method: string, path: string, body?: unknown) => app.request(`/api/v1${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { org, otherOrg, psa: psa!, dns: dns!, request };
}

describe('integration connection authority with real bearer authentication and PostgreSQL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    effects.provider.mockReturnValue({ testConnection: effects.test });
    effects.test.mockResolvedValue({ success: true });
  });

  it('uses the unprivileged production request role', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
    expect(rows[0]).toMatchObject({ role: 'breeze_app', rolsuper: false, rolbypassrls: false });
  });

  it.each(['selected-site', 'empty-sites'] as const)('denies all seven routes with %s membership and preserves stored state', async (mode) => {
    const f = await fixture(mode);
    const beforePsa = await getTestDb().select().from(psaConnections);
    const beforeDns = await getTestDb().select().from(dnsFilterIntegrations);
    const requests = [
      () => f.request('POST', '/psa/connections', { provider: 'jira', name: 'Denied PSA', credentials }),
      () => f.request('PATCH', `/psa/connections/${f.psa.id}`, { name: 'Denied change' }),
      () => f.request('DELETE', `/psa/connections/${f.psa.id}`),
      () => f.request('POST', `/psa/connections/${f.psa.id}/test`),
      () => f.request('POST', `/psa/connections/${f.psa.id}/status`, { status: 'paused' }),
      () => f.request('POST', '/dns-security/integrations', { provider: 'cloudflare', name: 'Denied DNS', apiKey: 'synthetic-key', config: { accountId: 'synthetic-account' } }),
      () => f.request('DELETE', `/dns-security/integrations/${f.dns.id}`),
    ];
    for (const request of requests) {
      const response = await request();
      expect(response.status, await response.clone().text()).toBe(403);
      expect(await response.json()).toEqual({ error: 'Integration connection management requires unrestricted site access' });
    }
    expect(await getTestDb().select().from(psaConnections)).toEqual(beforePsa);
    expect(await getTestDb().select().from(dnsFilterIntegrations)).toEqual(beforeDns);
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
  });

  it.each(['organization', 'selected-partner', 'partner', 'system'] as const)('preserves all seven operations for %s authority', async (mode) => {
    const f = await fixture(mode);
    const created = await f.request('POST', '/psa/connections', { orgId: f.org.id, provider: 'jira', name: 'New PSA', credentials });
    expect(created.status, await created.clone().text()).toBe(201);
    const psa = await created.json();
    const id = psa.id;
    expect(id).toBeTypeOf('string');
    const updated = await f.request('PATCH', `/psa/connections/${id}`, { name: 'Updated PSA' });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const tested = await f.request('POST', `/psa/connections/${id}/test`);
    expect(tested.status, await tested.clone().text()).toBe(200);
    expect(effects.test).toHaveBeenCalledOnce();
    expect((await f.request('POST', `/psa/connections/${id}/status`, { status: 'paused' })).status).toBe(200);
    const [stored] = await getTestDb().select().from(psaConnections).where(eq(psaConnections.id, id));
    expect(stored).toMatchObject({ orgId: f.org.id, name: 'Updated PSA', syncSettings: { status: 'paused' } });
    expect((await f.request('DELETE', `/psa/connections/${id}`)).status).toBe(200);
    expect(await getTestDb().select().from(psaConnections).where(eq(psaConnections.id, id))).toEqual([]);
    const dnsResponse = await f.request('POST', '/dns-security/integrations', { orgId: f.org.id, provider: 'cloudflare', name: 'New DNS', apiKey: 'synthetic-key', config: { accountId: 'synthetic-account' } });
    expect(dnsResponse.status, await dnsResponse.clone().text()).toBe(201);
    const dns = await dnsResponse.json();
    expect(effects.sync).toHaveBeenCalledExactlyOnceWith(dns.id);
    expect((await f.request('DELETE', `/dns-security/integrations/${dns.id}`)).status).toBe(200);
    expect(await getTestDb().select().from(dnsFilterIntegrations).where(eq(dnsFilterIntegrations.id, dns.id))).toEqual([]);
    expect(effects.audit).toHaveBeenCalledTimes(7);
  });

  it('retains the selected partner org ceiling for both connection families', async () => {
    const f = await fixture('selected-partner');
    const [foreignPsa] = await getTestDb().insert(psaConnections).values({ orgId: f.otherOrg.id, provider: 'jira', name: 'Other org PSA', credentials: encryptCredentials(credentials) }).returning();
    const [foreignDns] = await getTestDb().insert(dnsFilterIntegrations).values({ orgId: f.otherOrg.id, provider: 'cloudflare', name: 'Other org DNS', apiKey: 'synthetic-key' }).returning();
    expect((await f.request('DELETE', `/psa/connections/${foreignPsa!.id}`)).status).toBe(404);
    expect((await f.request('DELETE', `/dns-security/integrations/${foreignDns!.id}`)).status).toBe(404);
    expect((await f.request('POST', '/psa/connections', { orgId: f.otherOrg.id, provider: 'jira', name: 'Denied', credentials })).status).toBe(403);
    expect((await f.request('POST', '/dns-security/integrations', { orgId: f.otherOrg.id, provider: 'cloudflare', name: 'Denied', apiKey: 'synthetic-key', config: { accountId: 'synthetic-account' } })).status).toBe(403);
    expect(effects.audit).not.toHaveBeenCalled();
    expect(effects.sync).not.toHaveBeenCalled();
  });
});
