/**
 * #8728 — the patch approval list (GET /patches) shows, per patch, how many
 * devices in the caller's scope still need it, and GET /patches/:id/devices
 * names them.
 *
 * Real Postgres on purpose: the count is a grouped read over device_patches
 * joined to devices, and what it must get right is which rows it counts
 * (pending yes, the 'missing' scan tombstone no) and whose devices it sees
 * (org, partner all-orgs, site-restricted users). A Drizzle mock would return
 * whatever rows we fabricate without running either.
 *
 * Run:
 *   pnpm test-stack up
 *   npx vitest run --config vitest.integration.config.ts src/__tests__/integration/patchOutstandingDevices.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { getTestDb } from './setup';
import { authMiddleware } from '../../middleware/auth';
import { patchRoutes } from '../../routes/patches';
import { devices, patches, devicePatches, organizationUsers, users } from '../../db/schema';
import {
  createIntegrationTestClient,
  createOrganization,
  createSite,
  type IntegrationTestClient,
} from './db-utils';

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/patches', patchRoutes);
  return app;
}

let agentSeq = 0;
async function seedDevice(
  orgId: string,
  siteId: string,
  hostname: string,
  opts: { isEphemeral?: boolean } = {},
): Promise<string> {
  agentSeq++;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `agent-8728-${agentSeq}-${Date.now()}`,
      hostname,
      displayName: hostname,
      osType: 'windows',
      osVersion: '11',
      osBuild: '22631',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
      isEphemeral: opts.isEphemeral ?? false,
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('seedDevice: no row returned');
  return row.id;
}

async function seedPatch(): Promise<string> {
  // `patches` is a global catalog; externalId must be globally unique.
  const [row] = await getTestDb()
    .insert(patches)
    .values({
      source: 'microsoft',
      externalId: `microsoft:${randomUUID()}`,
      title: `KB-8728-${randomUUID().slice(0, 8)}`,
      severity: 'important',
      osTypes: ['windows'],
    })
    .returning({ id: patches.id });
  if (!row) throw new Error('seedPatch: no row returned');
  return row.id;
}

async function seedDevicePatch(
  orgId: string,
  deviceId: string,
  patchId: string,
  status: 'pending' | 'installed' | 'missing',
) {
  await getTestDb().insert(devicePatches).values({
    deviceId,
    orgId,
    patchId,
    status,
    lastCheckedAt: new Date(),
  });
}

type ListRow = { id: string; outstandingDeviceCount: number };
type DeviceRow = { deviceId: string; hostname: string; status: string; lastCheckedAt: string | null };

async function listRow(client: IntegrationTestClient, patchId: string, orgId?: string): Promise<ListRow> {
  const qs = orgId ? `?orgId=${orgId}&limit=200` : '?limit=200';
  const res = await client.get(`/patches${qs}`);
  expect(res.status).toBe(200);
  const body = await res.json();
  const row = body.data.find((p: ListRow) => p.id === patchId);
  expect(row).toBeDefined();
  return row;
}

describe('#8728 — outstanding device count on the patch list (org scope)', () => {
  let client: IntegrationTestClient;
  let orgId: string;
  let siteId: string;

  beforeEach(async () => {
    client = await createIntegrationTestClient(buildApp(), { scope: 'organization' });
    orgId = client.env.organization.id;
    siteId = client.env.site.id;
  });

  it('counts devices with the patch pending, and not installed or missing (tombstone) rows', async () => {
    const patchId = await seedPatch();
    const pendingA = await seedDevice(orgId, siteId, 'pending-a');
    const pendingB = await seedDevice(orgId, siteId, 'pending-b');
    const installed = await seedDevice(orgId, siteId, 'installed');
    const tombstone = await seedDevice(orgId, siteId, 'tombstone');
    await seedDevicePatch(orgId, pendingA, patchId, 'pending');
    await seedDevicePatch(orgId, pendingB, patchId, 'pending');
    await seedDevicePatch(orgId, installed, patchId, 'installed');
    await seedDevicePatch(orgId, tombstone, patchId, 'missing');

    const row = await listRow(client, patchId, orgId);
    expect(row.outstandingDeviceCount).toBe(2);
  });

  it('reports 0, not an absent field, when no device still needs the patch', async () => {
    const patchId = await seedPatch();
    const deviceId = await seedDevice(orgId, siteId, 'all-done');
    await seedDevicePatch(orgId, deviceId, patchId, 'installed');

    const row = await listRow(client, patchId, orgId);
    expect(row.outstandingDeviceCount).toBe(0);
  });

  it('does not count ephemeral Quick Support devices', async () => {
    const patchId = await seedPatch();
    const managed = await seedDevice(orgId, siteId, 'managed');
    const ephemeral = await seedDevice(orgId, siteId, 'quick-support', { isEphemeral: true });
    await seedDevicePatch(orgId, managed, patchId, 'pending');
    await seedDevicePatch(orgId, ephemeral, patchId, 'pending');

    const row = await listRow(client, patchId, orgId);
    expect(row.outstandingDeviceCount).toBe(1);
  });

  it('isolates two orgs that both need the same patch', async () => {
    const patchId = await seedPatch();
    const otherOrg = await createOrganization({ partnerId: client.env.partner.id });
    const otherSite = await createSite({ orgId: otherOrg.id });
    const mine = await seedDevice(orgId, siteId, 'mine');
    await seedDevicePatch(orgId, mine, patchId, 'pending');
    for (const name of ['theirs-1', 'theirs-2', 'theirs-3']) {
      const d = await seedDevice(otherOrg.id, otherSite.id, name);
      await seedDevicePatch(otherOrg.id, d, patchId, 'pending');
    }

    const row = await listRow(client, patchId, orgId);
    expect(row.outstandingDeviceCount).toBe(1);

    const res = await client.get(`/patches/${patchId}/devices`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((d: DeviceRow) => d.hostname)).toEqual(['mine']);
    expect(body.pagination.total).toBe(1);
  });

  it('counts only the sites a site-restricted user can see, and names only those devices', async () => {
    const patchId = await seedPatch();
    const otherSite = await createSite({ orgId });
    const visible = await seedDevice(orgId, siteId, 'visible-site');
    const hidden = await seedDevice(orgId, otherSite.id, 'other-site');
    await seedDevicePatch(orgId, visible, patchId, 'pending');
    await seedDevicePatch(orgId, hidden, patchId, 'pending');
    await getTestDb()
      .update(organizationUsers)
      .set({ siteIds: [siteId] })
      .where(and(eq(organizationUsers.userId, client.env.user.id), eq(organizationUsers.orgId, orgId)));

    const row = await listRow(client, patchId, orgId);
    expect(row.outstandingDeviceCount).toBe(1);

    const res = await client.get(`/patches/${patchId}/devices`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((d: DeviceRow) => d.hostname)).toEqual(['visible-site']);
  });
});

describe('#8728 — outstanding device count, partner "All organizations"', () => {
  let client: IntegrationTestClient;

  beforeEach(async () => {
    client = await createIntegrationTestClient(buildApp(), { scope: 'partner' });
  });

  it('sums over the partner\'s orgs and excludes another partner\'s devices', async () => {
    const patchId = await seedPatch();
    const orgA = client.env.organization.id;
    const siteA = client.env.site.id;
    const orgB = await createOrganization({ partnerId: client.env.partner.id });
    const siteB = await createSite({ orgId: orgB.id });

    const otherPartnerClient = await createIntegrationTestClient(buildApp(), { scope: 'organization' });
    const foreignOrg = otherPartnerClient.env.organization.id;
    const foreignSite = otherPartnerClient.env.site.id;

    const a = await seedDevice(orgA, siteA, 'a-1');
    const b1 = await seedDevice(orgB.id, siteB.id, 'b-1');
    const b2 = await seedDevice(orgB.id, siteB.id, 'b-2');
    const foreign = await seedDevice(foreignOrg, foreignSite, 'foreign');
    await seedDevicePatch(orgA, a, patchId, 'pending');
    await seedDevicePatch(orgB.id, b1, patchId, 'pending');
    await seedDevicePatch(orgB.id, b2, patchId, 'pending');
    await seedDevicePatch(foreignOrg, foreign, patchId, 'pending');

    expect((await listRow(client, patchId)).outstandingDeviceCount).toBe(3);
    // ?orgId= narrows to that org.
    expect((await listRow(client, patchId, orgB.id)).outstandingDeviceCount).toBe(2);

    const res = await client.get(`/patches/${patchId}/devices`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((d: DeviceRow) => d.hostname)).toEqual(['a-1', 'b-1', 'b-2']);
    expect(body.pagination.total).toBe(3);
  });
});

describe('#8728 — GET /patches/:id/devices', () => {
  let client: IntegrationTestClient;
  let orgId: string;
  let siteId: string;

  beforeEach(async () => {
    client = await createIntegrationTestClient(buildApp(), { scope: 'organization' });
    orgId = client.env.organization.id;
    siteId = client.env.site.id;
  });

  it('returns the outstanding devices sorted by hostname, with device status and last check', async () => {
    const patchId = await seedPatch();
    const zulu = await seedDevice(orgId, siteId, 'zulu');
    const alpha = await seedDevice(orgId, siteId, 'alpha');
    const done = await seedDevice(orgId, siteId, 'done');
    await seedDevicePatch(orgId, zulu, patchId, 'pending');
    await seedDevicePatch(orgId, alpha, patchId, 'pending');
    await seedDevicePatch(orgId, done, patchId, 'installed');

    const res = await client.get(`/patches/${patchId}/devices`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({ deviceId: alpha, hostname: 'alpha', status: 'online' });
    expect(typeof body.data[0].lastCheckedAt).toBe('string');
    expect(body.data[1]).toMatchObject({ deviceId: zulu, hostname: 'zulu' });
    expect(body.pagination).toEqual({ page: 1, limit: 50, total: 2 });
  });

  it('paginates, and caps the page size at 200', async () => {
    const patchId = await seedPatch();
    for (let i = 0; i < 5; i++) {
      const d = await seedDevice(orgId, siteId, `host-${i}`);
      await seedDevicePatch(orgId, d, patchId, 'pending');
    }

    const page2 = await (await client.get(`/patches/${patchId}/devices?limit=2&page=2`)).json();
    expect(page2.data.map((d: DeviceRow) => d.hostname)).toEqual(['host-2', 'host-3']);
    expect(page2.pagination).toEqual({ page: 2, limit: 2, total: 5 });

    const capped = await (await client.get(`/patches/${patchId}/devices?limit=1000`)).json();
    expect(capped.pagination.limit).toBe(200);
  });

  it('returns an empty list for a patch the caller has, but no longer needs anywhere', async () => {
    const patchId = await seedPatch();
    const d = await seedDevice(orgId, siteId, 'patched');
    await seedDevicePatch(orgId, d, patchId, 'installed');

    const res = await client.get(`/patches/${patchId}/devices`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.pagination.total).toBe(0);
  });

  it('returns the same 404 for a patch on another org\'s devices only and for no such patch', async () => {
    const patchId = await seedPatch();
    const otherOrg = await createOrganization({ partnerId: client.env.partner.id });
    const otherSite = await createSite({ orgId: otherOrg.id });
    const theirs = await seedDevice(otherOrg.id, otherSite.id, 'theirs');
    await seedDevicePatch(otherOrg.id, theirs, patchId, 'pending');

    const notYours = await client.get(`/patches/${patchId}/devices`);
    const noSuch = await client.get(`/patches/${randomUUID()}/devices`);
    expect(notYours.status).toBe(404);
    expect(noSuch.status).toBe(404);
    expect(await notYours.json()).toEqual(await noSuch.json());
  });

  it('403s an ?orgId= the caller cannot access', async () => {
    const patchId = await seedPatch();
    const otherOrg = await createOrganization({ partnerId: client.env.partner.id });
    const res = await client.get(`/patches/${patchId}/devices?orgId=${otherOrg.id}`);
    expect(res.status).toBe(403);
  });
});

describe('#8728 follow-up — a parked device is excluded from the count and the list', () => {
  // A SYSTEM caller: org and partner callers cannot see a holding org at all,
  // so for them tenant scope alone would hide the parked device and the test
  // would pass even without the parked-device predicate. Only a caller that
  // can see the holding org proves the exclusion itself.
  let client: IntegrationTestClient;

  beforeEach(async () => {
    client = await createIntegrationTestClient(buildApp(), { scope: 'system' });
    // System scope is granted by the live platform-admin flag, as in production
    // (services/permissions.ts resolveSystemScopePermissions).
    await getTestDb().update(users).set({ isPlatformAdmin: true }).where(eq(users.id, client.env.user.id));
  });

  async function seedParkedDevice(): Promise<{ deviceId: string; holdingOrgId: string }> {
    const holding = await createOrganization({ partnerId: client.env.partner.id, type: 'unassigned_pool' });
    const holdingSite = await createSite({ orgId: holding.id });
    // Only enrollment admission may create a device in a holding org.
    const deviceId = await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('breeze.parked_device_admission', 'enrollment', true)`);
      const [row] = await tx
        .insert(devices)
        .values({
          orgId: holding.id,
          siteId: holdingSite.id,
          agentId: `agent-8728-parked-${randomUUID()}`,
          hostname: 'parked-only-laptop',
          osType: 'windows',
          osVersion: '11',
          architecture: 'x86_64',
          agentVersion: '0.0.0-test',
          status: 'online',
          enrolledAt: new Date(),
        })
        .returning({ id: devices.id });
      return row!.id;
    });
    return { deviceId, holdingOrgId: holding.id };
  }

  it('answers a patch present only on a parked device like a patch that does not exist (404)', async () => {
    const patchId = await seedPatch();
    const { deviceId, holdingOrgId } = await seedParkedDevice();
    await seedDevicePatch(holdingOrgId, deviceId, patchId, 'pending');

    const res = await client.get(`/patches/${patchId}/devices`);
    const noSuch = await client.get(`/patches/${randomUUID()}/devices`);
    expect(res.status).toBe(404);
    expect(noSuch.status).toBe(404);
    expect(await res.json()).toEqual(await noSuch.json());
  });

  it('counts and names only the managed device, not the one parked in the holding org', async () => {
    const patchId = await seedPatch();
    const orgId = client.env.organization.id;
    const managed = await seedDevice(orgId, client.env.site.id, 'managed-laptop');
    await seedDevicePatch(orgId, managed, patchId, 'pending');

    const holding = await createOrganization({ partnerId: client.env.partner.id, type: 'unassigned_pool' });
    const holdingSite = await createSite({ orgId: holding.id });
    // Only enrollment admission may create a device in a holding org.
    const parked = await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('breeze.parked_device_admission', 'enrollment', true)`);
      const [row] = await tx
        .insert(devices)
        .values({
          orgId: holding.id,
          siteId: holdingSite.id,
          agentId: `agent-8728-parked-${randomUUID()}`,
          hostname: 'parked-laptop',
          osType: 'windows',
          osVersion: '11',
          architecture: 'x86_64',
          agentVersion: '0.0.0-test',
          status: 'online',
          enrolledAt: new Date(),
        })
        .returning({ id: devices.id });
      return row!.id;
    });
    await seedDevicePatch(holding.id, parked, patchId, 'pending');

    const list = await client.get('/patches?limit=200');
    expect(list.status).toBe(200);
    const row = (await list.json()).data.find((p: ListRow) => p.id === patchId);
    expect(row?.outstandingDeviceCount).toBe(1);

    const res = await client.get(`/patches/${patchId}/devices`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((d: DeviceRow) => d.hostname)).toEqual(['managed-laptop']);
    expect(body.pagination.total).toBe(1);
  });
});
