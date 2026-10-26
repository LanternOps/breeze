/**
 * #9387 gap 1 — GET /patches (the patch catalog list) shows the same resolved
 * severity the ring list and the approval evaluator already use: the trusted
 * `patches.severity` when it is known, otherwise the highest
 * `device_patches.reported_severity` across the caller's own devices.
 *
 * `patches.severity` is trusted-source-only and stays `'unknown'` forever for
 * `microsoft`/`apple`/`linux` rows, so the raw column renders almost the whole
 * Windows catalog as Unrated even when every device reported a rating.
 *
 * Real Postgres on purpose: what must be right is which device rows feed the
 * fallback (the caller's devices only, never another tenant's on the same
 * global catalog row), and that the column, the `?severity=` filter, and the
 * severity sort all read the same resolved value. A Drizzle mock runs none of
 * that SQL.
 *
 * Run:
 *   pnpm test-stack up
 *   npx vitest run --config vitest.integration.config.ts src/__tests__/integration/patchCatalogSeverity.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { getTestDb } from './setup';
import { authMiddleware } from '../../middleware/auth';
import { patchRoutes } from '../../routes/patches';
import { devices, patches, devicePatches, organizationUsers } from '../../db/schema';
import {
  createIntegrationTestClient,
  createOrganization,
  createSite,
  type IntegrationTestClient,
} from './db-utils';

type Severity = 'critical' | 'important' | 'moderate' | 'low' | 'unknown';

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/patches', patchRoutes);
  return app;
}

let agentSeq = 0;
async function seedDevice(orgId: string, siteId: string, hostname: string): Promise<string> {
  agentSeq++;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `agent-9387-${agentSeq}-${Date.now()}`,
      hostname,
      displayName: hostname,
      osType: 'windows',
      osVersion: '11',
      osBuild: '22631',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('seedDevice: no row returned');
  return row.id;
}

/** Defaults to an unclassified `microsoft` row — the shape gap 1 is about. */
async function restrictToSites(client: IntegrationTestClient, orgId: string, siteIds: string[]): Promise<void> {
  await getTestDb()
    .update(organizationUsers)
    .set({ siteIds })
    .where(and(eq(organizationUsers.userId, client.env.user.id), eq(organizationUsers.orgId, orgId)));
}

async function seedPatch(opts: { source?: 'microsoft' | 'third_party'; severity?: Severity } = {}): Promise<string> {
  const [row] = await getTestDb()
    .insert(patches)
    .values({
      source: opts.source ?? 'microsoft',
      externalId: `9387:${randomUUID()}`,
      title: `KB-9387-${randomUUID().slice(0, 8)}`,
      severity: opts.severity ?? 'unknown',
      osTypes: ['windows'],
    })
    .returning({ id: patches.id });
  if (!row) throw new Error('seedPatch: no row returned');
  return row.id;
}

async function seedDevicePatch(opts: {
  orgId: string;
  deviceId: string;
  patchId: string;
  reportedSeverity: Severity | null;
  lastCheckedAt?: Date;
}): Promise<void> {
  await getTestDb().insert(devicePatches).values({
    orgId: opts.orgId,
    deviceId: opts.deviceId,
    patchId: opts.patchId,
    status: 'pending',
    reportedSeverity: opts.reportedSeverity,
    lastCheckedAt: opts.lastCheckedAt ?? new Date(),
  });
}

type ListRow = { id: string; severity: string };

async function listIds(client: IntegrationTestClient, qs: string): Promise<string[]> {
  const res = await client.get(`/patches?limit=200&${qs}`);
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.data.map((p: ListRow) => p.id);
}

async function severityOf(client: IntegrationTestClient, patchId: string, qs = ''): Promise<string> {
  const res = await client.get(`/patches?limit=200${qs ? `&${qs}` : ''}`);
  expect(res.status).toBe(200);
  const body = await res.json();
  const row = body.data.find((p: ListRow) => p.id === patchId);
  expect(row).toBeDefined();
  return row.severity;
}

describe('#9387 — GET /patches resolves severity from device reports (org scope)', () => {
  let client: IntegrationTestClient;
  let orgId: string;
  let siteId: string;

  beforeEach(async () => {
    client = await createIntegrationTestClient(buildApp(), { scope: 'organization' });
    orgId = client.env.organization.id;
    siteId = client.env.site.id;
  });

  it('shows the device-reported severity for an unclassified microsoft patch', async () => {
    const patchId = await seedPatch();
    const deviceId = await seedDevice(orgId, siteId, 'ws-1');
    await seedDevicePatch({ orgId, deviceId, patchId, reportedSeverity: 'important' });

    expect(await severityOf(client, patchId)).toBe('important');
  });

  it('keeps the trusted catalog severity over any device report', async () => {
    const patchId = await seedPatch({ source: 'third_party', severity: 'moderate' });
    const deviceId = await seedDevice(orgId, siteId, 'ws-1');
    await seedDevicePatch({ orgId, deviceId, patchId, reportedSeverity: 'critical' });

    expect(await severityOf(client, patchId)).toBe('moderate');
  });

  it('takes the highest report across devices, not the most recent one', async () => {
    const patchId = await seedPatch();
    const older = await seedDevice(orgId, siteId, 'ws-old');
    const newer = await seedDevice(orgId, siteId, 'ws-new');
    await seedDevicePatch({
      orgId, deviceId: older, patchId, reportedSeverity: 'critical',
      lastCheckedAt: new Date(Date.now() - 86_400_000),
    });
    await seedDevicePatch({ orgId, deviceId: newer, patchId, reportedSeverity: 'low' });

    expect(await severityOf(client, patchId)).toBe('critical');
  });

  it('stays unknown when no device in scope reported a severity', async () => {
    const patchId = await seedPatch();
    const deviceId = await seedDevice(orgId, siteId, 'ws-1');
    await seedDevicePatch({ orgId, deviceId, patchId, reportedSeverity: null });

    expect(await severityOf(client, patchId)).toBe('unknown');
  });

  it('never folds another tenant\'s device report into the caller\'s value', async () => {
    const patchId = await seedPatch();
    const own = await seedDevice(orgId, siteId, 'own');
    await seedDevicePatch({ orgId, deviceId: own, patchId, reportedSeverity: 'low' });

    const foreignClient = await createIntegrationTestClient(buildApp(), { scope: 'organization' });
    const foreignOrg = foreignClient.env.organization.id;
    const foreign = await seedDevice(foreignOrg, foreignClient.env.site.id, 'foreign');
    await seedDevicePatch({ orgId: foreignOrg, deviceId: foreign, patchId, reportedSeverity: 'critical' });

    expect(await severityOf(client, patchId)).toBe('low');
    expect(await severityOf(foreignClient, patchId)).toBe('critical');
  });

  it('filters on the resolved severity, so the filter and the column agree', async () => {
    const reported = await seedPatch();
    const trusted = await seedPatch({ source: 'third_party', severity: 'important' });
    const unrated = await seedPatch();
    const deviceId = await seedDevice(orgId, siteId, 'ws-1');
    await seedDevicePatch({ orgId, deviceId, patchId: reported, reportedSeverity: 'important' });
    await seedDevicePatch({ orgId, deviceId, patchId: trusted, reportedSeverity: 'low' });
    await seedDevicePatch({ orgId, deviceId, patchId: unrated, reportedSeverity: null });

    const important = await listIds(client, `orgId=${orgId}&severity=important`);
    expect(important.sort()).toEqual([reported, trusted].sort());

    const unknown = await listIds(client, `orgId=${orgId}&severity=unknown`);
    expect(unknown).toEqual([unrated]);

    const res = await client.get(`/patches?orgId=${orgId}&severity=important`);
    const body = await res.json();
    expect(body.pagination.total).toBe(2);
  });

  it('sorts on the resolved severity, most severe first ascending', async () => {
    const critical = await seedPatch();
    const low = await seedPatch({ source: 'third_party', severity: 'low' });
    const unrated = await seedPatch();
    const moderate = await seedPatch();
    const deviceId = await seedDevice(orgId, siteId, 'ws-1');
    await seedDevicePatch({ orgId, deviceId, patchId: critical, reportedSeverity: 'critical' });
    await seedDevicePatch({ orgId, deviceId, patchId: low, reportedSeverity: null });
    await seedDevicePatch({ orgId, deviceId, patchId: unrated, reportedSeverity: null });
    await seedDevicePatch({ orgId, deviceId, patchId: moderate, reportedSeverity: 'moderate' });

    expect(await listIds(client, `orgId=${orgId}&sortBy=severity&sortDir=asc`))
      .toEqual([critical, moderate, low, unrated]);
  });

  it('narrows the per-source counts by the resolved severity, ignoring the source filter', async () => {
    const msImportant = await seedPatch();
    const tpImportant = await seedPatch({ source: 'third_party', severity: 'important' });
    const msLow = await seedPatch();
    const deviceId = await seedDevice(orgId, siteId, 'ws-1');
    await seedDevicePatch({ orgId, deviceId, patchId: msImportant, reportedSeverity: 'important' });
    await seedDevicePatch({ orgId, deviceId, patchId: tpImportant, reportedSeverity: null });
    await seedDevicePatch({ orgId, deviceId, patchId: msLow, reportedSeverity: 'low' });

    for (const qs of [`orgId=${orgId}&severity=important`, `orgId=${orgId}&severity=important&source=microsoft`]) {
      const res = await client.get(`/patches?${qs}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.counts.microsoft).toBe(1);
      expect(body.counts.third_party).toBe(1);
    }
  });

  it('ignores reports from devices at sites a site-restricted user cannot see', async () => {
    const patchId = await seedPatch();
    const hiddenSite = await createSite({ orgId });
    const visible = await seedDevice(orgId, siteId, 'visible-site');
    const hidden = await seedDevice(orgId, hiddenSite.id, 'hidden-site');
    await seedDevicePatch({ orgId, deviceId: visible, patchId, reportedSeverity: 'low' });
    await seedDevicePatch({ orgId, deviceId: hidden, patchId, reportedSeverity: 'critical' });
    await restrictToSites(client, orgId, [siteId]);

    expect(await severityOf(client, patchId)).toBe('low');
    expect(await listIds(client, `orgId=${orgId}&severity=critical`)).toEqual([]);
  });

  it('shows only the trusted value when the user can see no sites at all', async () => {
    const reported = await seedPatch();
    const trusted = await seedPatch({ source: 'third_party', severity: 'moderate' });
    const deviceId = await seedDevice(orgId, siteId, 'ws-1');
    await seedDevicePatch({ orgId, deviceId, patchId: reported, reportedSeverity: 'critical' });
    await seedDevicePatch({ orgId, deviceId, patchId: trusted, reportedSeverity: 'critical' });
    await restrictToSites(client, orgId, []);

    expect(await severityOf(client, reported)).toBe('unknown');
    expect(await severityOf(client, trusted)).toBe('moderate');
    expect(await listIds(client, `orgId=${orgId}&severity=critical`)).toEqual([]);
    const sorted = await client.get(`/patches?orgId=${orgId}&sortBy=severity&sortDir=asc`);
    expect(sorted.status).toBe(200);
  });
});

describe('#9387 — GET /patches resolved severity, partner "All organizations"', () => {
  let client: IntegrationTestClient;

  beforeEach(async () => {
    client = await createIntegrationTestClient(buildApp(), { scope: 'partner' });
  });

  it('takes the highest across the partner\'s orgs, narrows with ?orgId=, and excludes another partner', async () => {
    const patchId = await seedPatch();
    const orgA = client.env.organization.id;
    const orgB = await createOrganization({ partnerId: client.env.partner.id });
    const siteB = await createSite({ orgId: orgB.id });

    const otherPartnerClient = await createIntegrationTestClient(buildApp(), { scope: 'organization' });
    const foreignOrg = otherPartnerClient.env.organization.id;

    const a = await seedDevice(orgA, client.env.site.id, 'a-1');
    const b = await seedDevice(orgB.id, siteB.id, 'b-1');
    const foreign = await seedDevice(foreignOrg, otherPartnerClient.env.site.id, 'foreign');
    await seedDevicePatch({ orgId: orgA, deviceId: a, patchId, reportedSeverity: 'low' });
    await seedDevicePatch({ orgId: orgB.id, deviceId: b, patchId, reportedSeverity: 'important' });
    await seedDevicePatch({ orgId: foreignOrg, deviceId: foreign, patchId, reportedSeverity: 'critical' });

    expect(await severityOf(client, patchId)).toBe('important');
    expect(await severityOf(client, patchId, `orgId=${orgA}`)).toBe('low');
  });
});
