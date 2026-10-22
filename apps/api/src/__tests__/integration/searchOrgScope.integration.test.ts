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
import { getTestDb } from './setup';
import { authMiddleware } from '../../middleware/auth';
import { searchRoutes } from '../../routes/search';
import { alerts, scripts, users } from '../../db/schema';
import { eq } from 'drizzle-orm';
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

type Row = { id: string; type: string; title: string };

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
