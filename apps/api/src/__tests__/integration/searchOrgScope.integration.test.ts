/**
 * #9612 — GET /search (Cmd+K) honors the org selected in the switcher and
 * orders each category deterministically before its LIMIT, against a real
 * Postgres so the ranking SQL (CASE / starts_with / lower) actually executes
 * and RLS sits underneath the app-layer narrowing.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/searchOrgScope.integration.test.ts
 */
import './setup';

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { getAppDb, getTestDb } from './setup';
import { authMiddleware } from '../../middleware/auth';
import { searchRoutes } from '../../routes/search';
import { alerts, organizationUsers, partnerUsers, scripts, users } from '../../db/schema';
import { eq, sql } from 'drizzle-orm';
import { clearPermissionCache } from '../../services/permissions';
import {
  createDevice,
  createIntegrationTestClient,
  createOrganization,
  createPartner,
  createSite,
  type IntegrationTestClient,
} from './db-utils';

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/search', searchRoutes);
  return app;
}

type Row = { id: string; type: string; title: string; orgId?: string | null; orgName?: string | null };

async function seedScript(name: string, owner: { orgId: string | null; partnerId: string }, createdBy: string) {
  const [row] = await getTestDb()
    .insert(scripts)
    .values({
      orgId: owner.orgId,
      partnerId: owner.partnerId,
      name,
      osTypes: ['windows'],
      language: 'powershell',
      content: 'Write-Output 1',
      createdBy,
    })
    .returning({ id: scripts.id });
  return row!.id;
}

describe('GET /search — selected org + deterministic order (#9612)', () => {
  let client: IntegrationTestClient;
  let orgA: string;
  let siteA: string;
  let orgB: string;
  let siteB: string;

  beforeEach(async () => {
    client = await createIntegrationTestClient(buildApp(), { scope: 'partner' });
    orgA = client.env.organization.id;
    siteA = client.env.site.id;
    const second = await createOrganization({ partnerId: client.env.partner.id, name: 'Vega Corp' });
    orgB = second!.id;
    siteB = (await createSite({ orgId: orgB }))!.id;
  });

  async function devicesFor(path: string): Promise<Row[]> {
    const res = await client.get(path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Row[] };
    return body.results.filter((r) => r.type === 'devices');
  }

  it('narrows to the selected org; without one, spans every accessible org', async () => {
    const a = await createDevice({ orgId: orgA, siteId: siteA, hostname: 'ACME-SRV-02' });
    const b = await createDevice({ orgId: orgB, siteId: siteB, hostname: 'VEGA-SRV-02' });

    const narrowed = await devicesFor(`/search?q=srv-02&orgId=${orgA}`);
    expect(narrowed.map((r) => r.id)).toEqual([a.id]);

    const fleet = await devicesFor('/search?q=srv-02');
    expect(fleet.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('refuses an org outside the caller access with 403', async () => {
    const otherPartner = await createPartner();
    const foreignOrg = await createOrganization({ partnerId: otherPartner!.id });

    const res = await client.get(`/search?q=srv-02&orgId=${foreignOrg!.id}`);
    expect(res.status).toBe(403);
  });

  it('ranks exact, then prefix, then substring matches before the per-category limit', async () => {
    // Six substring-only matches would fill the 5-row device slot on their own.
    for (const host of ['a-srv-02', 'b-srv-02', 'c-srv-02', 'd-srv-02', 'e-srv-02', 'f-srv-02']) {
      await createDevice({ orgId: orgA, siteId: siteA, hostname: host });
    }
    const prefix = await createDevice({ orgId: orgA, siteId: siteA, hostname: 'srv-02-backup' });
    const exact = await createDevice({ orgId: orgA, siteId: siteA, hostname: 'SRV-02' });

    const first = await devicesFor(`/search?q=srv-02&orgId=${orgA}`);
    expect(first).toHaveLength(5);
    expect(first[0]!.id).toBe(exact.id);
    expect(first[1]!.id).toBe(prefix.id);
    // Then substring matches by name.
    expect(first.slice(2).map((r) => r.title)).toEqual(['a-srv-02', 'b-srv-02', 'c-srv-02']);

    // Same query, same answer.
    const second = await devicesFor(`/search?q=srv-02&orgId=${orgA}`);
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
  });

  it('keeps the partner-wide scripts and drops the other org scripts when narrowed', async () => {
    const partnerId = client.env.partner.id;
    const userId = client.env.user.id;
    const ownA = await seedScript('cleanup-acme', { orgId: orgA, partnerId }, userId);
    const ownB = await seedScript('cleanup-vega', { orgId: orgB, partnerId }, userId);
    const shared = await seedScript('cleanup-shared', { orgId: null, partnerId }, userId);

    const res = await client.get(`/search?q=cleanup&orgId=${orgA}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Row[] };
    const ids = body.results.filter((r) => r.type === 'scripts').map((r) => r.id).sort();
    expect(ids).toEqual([ownA, shared].sort());
    expect(ids).not.toContain(ownB);
  });

  it('orders alerts newest first', async () => {
    const device = await createDevice({ orgId: orgA, siteId: siteA, hostname: 'alert-host' });
    const base = { orgId: orgA, deviceId: device.id, severity: 'high' as const, message: 'disk' };
    const [older] = await getTestDb()
      .insert(alerts)
      .values({ ...base, title: 'Disk alert older', triggeredAt: new Date(Date.now() - 60_000) } as never)
      .returning({ id: alerts.id });
    const [newer] = await getTestDb()
      .insert(alerts)
      .values({ ...base, title: 'Disk alert newer', triggeredAt: new Date() } as never)
      .returning({ id: alerts.id });

    const res = await client.get(`/search?q=disk+alert&orgId=${orgA}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Row[] };
    expect(body.results.filter((r) => r.type === 'alerts').map((r) => r.id)).toEqual([newer!.id, older!.id]);
  });
});

describe('GET /search — system scope narrowed to one org (#9612)', () => {
  it('returns that org devices and its partner-wide scripts only', async () => {
    const client = await createIntegrationTestClient(buildApp(), { scope: 'system' });
    // System scope is granted by the live platform-admin flag, as in production.
    await getTestDb().update(users).set({ isPlatformAdmin: true }).where(eq(users.id, client.env.user.id));
    const partnerId = client.env.partner.id;
    const orgA = client.env.organization.id;
    const otherPartner = await createPartner();
    const orgX = (await createOrganization({ partnerId: otherPartner!.id }))!.id;
    const siteX = (await createSite({ orgId: orgX }))!.id;

    const a = await createDevice({ orgId: orgA, siteId: client.env.site.id, hostname: 'sys-host-a' });
    await createDevice({ orgId: orgX, siteId: siteX, hostname: 'sys-host-x' });
    const sharedA = await seedScript('sysclean-a-shared', { orgId: null, partnerId }, client.env.user.id);
    await seedScript('sysclean-x-shared', { orgId: null, partnerId: otherPartner!.id }, client.env.user.id);

    const devicesRes = await client.get(`/search?q=sys-host&orgId=${orgA}`);
    expect(devicesRes.status).toBe(200);
    const deviceRows = ((await devicesRes.json()) as { results: Row[] }).results.filter((r) => r.type === 'devices');
    expect(deviceRows.map((r) => r.id)).toEqual([a.id]);

    const scriptsRes = await client.get(`/search?q=sysclean&orgId=${orgA}`);
    expect(scriptsRes.status).toBe(200);
    const scriptRows = ((await scriptsRes.json()) as { results: Row[] }).results.filter((r) => r.type === 'scripts');
    expect(scriptRows.map((r) => r.id)).toEqual([sharedA]);
  });
});

// #11803: Cmd+K searches every customer the caller can access (the palette no
// longer sends the header's org), labels each result with its customer, and can
// rank the selected customer first with `preferOrgId`. RLS and the caller's
// access list stay the only hard filters; `orgId` stays the optional
// "This customer only" narrowing.
describe('GET /search — every accessible customer, labelled (#11803)', () => {
  async function results(client: IntegrationTestClient, path: string): Promise<Row[]> {
    const res = await client.get(path);
    expect(res.status).toBe(200);
    return ((await res.json()) as { results: Row[] }).results;
  }

  async function seedAlert(orgId: string, deviceId: string, title: string) {
    await getTestDb()
      .insert(alerts)
      .values({ orgId, deviceId, severity: 'high', title, message: 'x', triggeredAt: new Date() } as never);
  }

  it('runs as the unprivileged app role, so RLS sits under every assertion here', async () => {
    const [role] = await getAppDb().execute<{ current_user: string; rolbypassrls: boolean }>(
      sql`select current_user, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(role).toMatchObject({ current_user: 'breeze_app', rolbypassrls: false });
  });

  it('partner user with several customers: finds matches in each, labelled with the customer', async () => {
    const client = await createIntegrationTestClient(buildApp(), { scope: 'partner' });
    const partnerId = client.env.partner.id;
    const orgA = client.env.organization.id;
    const orgB = (await createOrganization({ partnerId, name: 'Vega Corp' }))!.id;
    const orgC = (await createOrganization({ partnerId, name: 'Lyra Ltd' }))!.id;
    const a = await createDevice({ orgId: orgA, siteId: client.env.site.id, hostname: 'fleet-node-a' });
    const b = await createDevice({ orgId: orgB, siteId: (await createSite({ orgId: orgB }))!.id, hostname: 'fleet-node-b' });
    const c = await createDevice({ orgId: orgC, siteId: (await createSite({ orgId: orgC }))!.id, hostname: 'fleet-node-c' });
    const scriptB = await seedScript('fleetscript-b', { orgId: orgB, partnerId }, client.env.user.id);
    const shared = await seedScript('fleetscript-shared', { orgId: null, partnerId }, client.env.user.id);
    await seedAlert(orgB, b.id, 'fleet-alert-b');

    const devicesFound = (await results(client, '/search?q=fleet-node')).filter((r) => r.type === 'devices');
    expect(devicesFound.map((r) => r.id).sort()).toEqual([a.id, b.id, c.id].sort());
    const byId = new Map(devicesFound.map((r) => [r.id, r]));
    expect(byId.get(a.id)).toMatchObject({ orgId: orgA, orgName: client.env.organization.name });
    expect(byId.get(b.id)).toMatchObject({ orgId: orgB, orgName: 'Vega Corp' });
    expect(byId.get(c.id)).toMatchObject({ orgId: orgC, orgName: 'Lyra Ltd' });

    const scriptRows = (await results(client, '/search?q=fleetscript')).filter((r) => r.type === 'scripts');
    expect(scriptRows.find((r) => r.id === scriptB)).toMatchObject({ orgId: orgB, orgName: 'Vega Corp' });
    // A partner-wide script belongs to no single customer.
    expect(scriptRows.find((r) => r.id === shared)).toMatchObject({ orgId: null, orgName: null });

    const alertRows = (await results(client, '/search?q=fleet-alert')).filter((r) => r.type === 'alerts');
    expect(alertRows).toEqual([expect.objectContaining({ orgId: orgB, orgName: 'Vega Corp' })]);
  });

  it('ranks the preferred customer first without hiding the others', async () => {
    const client = await createIntegrationTestClient(buildApp(), { scope: 'partner' });
    const partnerId = client.env.partner.id;
    const orgA = client.env.organization.id;
    const orgB = (await createOrganization({ partnerId, name: 'Vega Corp' }))!.id;
    const siteB = (await createSite({ orgId: orgB }))!.id;
    // orgA holds the better (exact) match; orgB only a substring match.
    const exactA = await createDevice({ orgId: orgA, siteId: client.env.site.id, hostname: 'rank-me' });
    const subB = await createDevice({ orgId: orgB, siteId: siteB, hostname: 'z-rank-me-b' });
    const ownA = await seedScript('rankscript', { orgId: orgA, partnerId }, client.env.user.id);
    const ownB = await seedScript('rankscript-b', { orgId: orgB, partnerId }, client.env.user.id);
    const deviceB = await createDevice({ orgId: orgB, siteId: siteB, hostname: 'rank-alert-host' });
    const deviceA = await createDevice({ orgId: orgA, siteId: client.env.site.id, hostname: 'rank-alert-host-a' });
    await getTestDb().insert(alerts).values([
      { orgId: orgB, deviceId: deviceB.id, severity: 'high', title: 'rank-alert older', message: 'x', triggeredAt: new Date(Date.now() - 60_000) },
      { orgId: orgA, deviceId: deviceA.id, severity: 'high', title: 'rank-alert newer', message: 'x', triggeredAt: new Date() },
    ] as never);

    const plain = (await results(client, '/search?q=rank-me')).filter((r) => r.type === 'devices');
    expect(plain.map((r) => r.id)).toEqual([exactA.id, subB.id]);

    const preferred = (await results(client, `/search?q=rank-me&preferOrgId=${orgB}`)).filter((r) => r.type === 'devices');
    expect(preferred.map((r) => r.id)).toEqual([subB.id, exactA.id]);

    const scriptRows = (await results(client, `/search?q=rankscript&preferOrgId=${orgB}`)).filter((r) => r.type === 'scripts');
    expect(scriptRows.map((r) => r.id)).toEqual([ownB, ownA]);

    const alertTitles = (await results(client, `/search?q=rank-alert&preferOrgId=${orgB}`))
      .filter((r) => r.type === 'alerts')
      .map((r) => r.title);
    expect(alertTitles).toEqual(['rank-alert older', 'rank-alert newer']);
  });

  it('partner user restricted to a subset of customers never sees the rest, and cannot ask for them', async () => {
    const client = await createIntegrationTestClient(buildApp(), { scope: 'partner' });
    const partnerId = client.env.partner.id;
    const orgA = client.env.organization.id;
    const orgB = (await createOrganization({ partnerId, name: 'Vega Corp' }))!.id;
    const siteB = (await createSite({ orgId: orgB }))!.id;
    const a = await createDevice({ orgId: orgA, siteId: client.env.site.id, hostname: 'subset-host-a' });
    const b = await createDevice({ orgId: orgB, siteId: siteB, hostname: 'subset-host-b' });
    await seedAlert(orgB, b.id, 'subset-alert-b');
    const ownB = await seedScript('subsetscript-b', { orgId: orgB, partnerId }, client.env.user.id);
    await getTestDb()
      .update(partnerUsers)
      .set({ orgAccess: 'selected', orgIds: [orgA] })
      .where(eq(partnerUsers.userId, client.env.user.id));
    await clearPermissionCache(client.env.user.id);

    const rows = await results(client, '/search?q=subset');
    expect(rows.filter((r) => r.type === 'devices').map((r) => r.id)).toEqual([a.id]);
    expect(rows.map((r) => r.id)).not.toContain(b.id);
    expect(rows.map((r) => r.id)).not.toContain(ownB);
    expect(rows.filter((r) => r.type === 'alerts')).toEqual([]);
    expect(rows.every((r) => r.orgId === orgA || r.orgId === null)).toBe(true);

    expect((await client.get(`/search?q=subset&orgId=${orgB}`)).status).toBe(403);
    expect((await client.get(`/search?q=subset&preferOrgId=${orgB}`)).status).toBe(403);
  });

  it('org user is unchanged: own customer only, labelled, and a sibling customer is refused', async () => {
    const client = await createIntegrationTestClient(buildApp(), { scope: 'organization' });
    const orgA = client.env.organization.id;
    const sibling = (await createOrganization({ partnerId: client.env.partner.id, name: 'Vega Corp' }))!.id;
    const a = await createDevice({ orgId: orgA, siteId: client.env.site.id, hostname: 'orguser-host-a' });
    await createDevice({ orgId: sibling, siteId: (await createSite({ orgId: sibling }))!.id, hostname: 'orguser-host-b' });

    const rows = (await results(client, '/search?q=orguser-host')).filter((r) => r.type === 'devices');
    expect(rows).toEqual([expect.objectContaining({ id: a.id, orgId: orgA, orgName: client.env.organization.name })]);

    expect((await client.get(`/search?q=orguser-host&orgId=${sibling}`)).status).toBe(403);
    expect((await client.get(`/search?q=orguser-host&preferOrgId=${sibling}`)).status).toBe(403);
  });

  it('site-restricted user sees no device or alert from another site of the same customer', async () => {
    const client = await createIntegrationTestClient(buildApp(), { scope: 'organization' });
    const orgA = client.env.organization.id;
    const allowedSite = client.env.site.id;
    const hiddenSite = (await createSite({ orgId: orgA }))!.id;
    const visible = await createDevice({ orgId: orgA, siteId: allowedSite, hostname: 'sitescope-host-1' });
    const hidden = await createDevice({ orgId: orgA, siteId: hiddenSite, hostname: 'sitescope-host-2' });
    await seedAlert(orgA, visible.id, 'sitescope-alert-visible');
    await seedAlert(orgA, hidden.id, 'sitescope-alert-hidden');
    await getTestDb()
      .update(organizationUsers)
      .set({ siteIds: [allowedSite] })
      .where(eq(organizationUsers.userId, client.env.user.id));
    await clearPermissionCache(client.env.user.id);

    const devicesFound = (await results(client, '/search?q=sitescope-host')).filter((r) => r.type === 'devices');
    expect(devicesFound.map((r) => r.id)).toEqual([visible.id]);
    const alertTitles = (await results(client, '/search?q=sitescope-alert'))
      .filter((r) => r.type === 'alerts')
      .map((r) => r.title);
    expect(alertTitles).toEqual(['sitescope-alert-visible']);
    // Ranking by the user's own customer does not widen the site axis.
    const preferred = (await results(client, `/search?q=sitescope-host&preferOrgId=${orgA}`)).filter((r) => r.type === 'devices');
    expect(preferred.map((r) => r.id)).toEqual([visible.id]);
  });

  it('a client-supplied foreign customer id is refused on both parameters and leaks nothing', async () => {
    const client = await createIntegrationTestClient(buildApp(), { scope: 'partner' });
    const otherPartner = await createPartner();
    const foreignOrg = (await createOrganization({ partnerId: otherPartner!.id, name: 'Foreign Co' }))!.id;
    const foreignSite = (await createSite({ orgId: foreignOrg }))!.id;
    const foreignDevice = await createDevice({ orgId: foreignOrg, siteId: foreignSite, hostname: 'foreign-host' });

    for (const param of ['orgId', 'preferOrgId']) {
      const res = await client.get(`/search?q=foreign-host&${param}=${foreignOrg}`);
      expect(res.status).toBe(403);
    }
    const rows = await results(client, '/search?q=foreign-host');
    expect(rows.map((r) => r.id)).not.toContain(foreignDevice.id);
    expect(rows.map((r) => r.orgName)).not.toContain('Foreign Co');
  });
});
