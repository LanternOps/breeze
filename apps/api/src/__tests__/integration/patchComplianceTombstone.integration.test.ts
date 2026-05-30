/**
 * Patch compliance must not count 'missing' tombstones as outstanding patches.
 *
 * Reproduces the production discrepancy where the US "pressless" Linux device
 * showed ~960 "missing" in the Patch-Management Compliance tab while its own
 * device Patches tab showed nothing to install.
 *
 * Root cause: the agent scan ingestion (routes/agents/patches.ts) marks ALL of
 * a device's existing device_patches rows `status='missing'` at the start of a
 * scan, then re-inserts the rows the current scan reports as 'pending' or
 * 'installed'. Rows left at 'missing' are STALE TOMBSTONES from a prior scan
 * (e.g. a linux package upgraded to a new externalId), NOT patches the device
 * still needs. The device-detail endpoint correctly treats 'missing' as stale
 * (compliance = installed / (pending + installed)), but the compliance endpoint
 * counted `status IN ('pending','missing')`, inflating every device's
 * "missing" count by its tombstone backlog.
 *
 * The only status that means "device still needs this patch installed" is
 * 'pending'. These tests assert the compliance endpoint counts accordingly,
 * against a real DB so the SQL aggregation itself is exercised (a Drizzle mock
 * would happily return whatever rows we fabricate and never run the filter).
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 * Run:
 *   pnpm test:integration -- src/__tests__/integration/patchComplianceTombstone.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { getTestDb } from './setup';
import { authMiddleware } from '../../middleware/auth';
import { patchRoutes } from '../../routes/patches';
import { devices, patches, devicePatches } from '../../db/schema';
import { createIntegrationTestClient, type IntegrationTestClient } from './db-utils';

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/patches', patchRoutes);
  return app;
}

let agentSeq = 0;
async function seedDevice(orgId: string, siteId: string, hostname: string): Promise<string> {
  const tdb = getTestDb();
  agentSeq++;
  const [row] = await tdb
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `agent-patchcompliance-${agentSeq}-${Date.now()}`,
      hostname,
      displayName: hostname,
      osType: 'linux',
      osVersion: '22.04',
      osBuild: 'jammy',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('seedDevice: no row returned');
  return row.id;
}

let patchSeq = 0;
async function seedDevicePatch(opts: {
  orgId: string;
  deviceId: string;
  status: 'pending' | 'installed' | 'missing' | 'failed' | 'skipped';
  source?: 'microsoft' | 'apple' | 'linux' | 'third_party' | 'custom';
  severity?: 'critical' | 'important' | 'moderate' | 'low' | 'unknown';
}): Promise<void> {
  const tdb = getTestDb();
  patchSeq++;
  const source = opts.source ?? 'linux';
  // `patches` is a GLOBAL catalog table — cleanupDatabase() only truncates
  // tenant tables, so externalId must be globally unique to avoid colliding
  // with rows left by earlier tests/runs (patches_source_external_id_unique).
  const [patch] = await tdb
    .insert(patches)
    .values({
      source,
      externalId: `${source}:${randomUUID()}`,
      title: `Test patch ${patchSeq}`,
      severity: opts.severity ?? 'unknown',
    })
    .returning({ id: patches.id });
  if (!patch) throw new Error('seedDevicePatch: no patch row');
  await tdb.insert(devicePatches).values({
    deviceId: opts.deviceId,
    orgId: opts.orgId,
    patchId: patch.id,
    status: opts.status,
    lastCheckedAt: new Date(),
  });
}

describe('GET /patches/compliance — tombstone exclusion', () => {
  let client: IntegrationTestClient;
  let orgId: string;
  let siteId: string;

  beforeEach(async () => {
    const app = buildApp();
    client = await createIntegrationTestClient(app, { scope: 'organization' });
    orgId = client.env.organization.id;
    siteId = client.env.site.id;
  });

  it('excludes a fully-patched device whose only outstanding rows are stale "missing" tombstones', async () => {
    // Exactly the pressless shape: 0 pending, several 'missing' tombstones,
    // and a pile of 'installed'. The device needs nothing installed.
    const deviceId = await seedDevice(orgId, siteId, 'pressless-like');
    for (let i = 0; i < 5; i++) {
      await seedDevicePatch({ orgId, deviceId, status: 'missing' });
    }
    for (let i = 0; i < 3; i++) {
      await seedDevicePatch({ orgId, deviceId, status: 'installed' });
    }

    const res = await client.get(`/patches/compliance?orgId=${orgId}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    const listed = body.data.devicesNeedingPatches.find((d: { id: string }) => d.id === deviceId);
    // 0 pending → device is fully patched → must NOT appear in the list.
    expect(listed).toBeUndefined();
  });

  it('counts only pending (not missing) as the per-device missing/critical/osMissing total', async () => {
    const deviceId = await seedDevice(orgId, siteId, 'partial-device');
    // 2 genuinely outstanding pending patches (one critical) ...
    await seedDevicePatch({ orgId, deviceId, status: 'pending', severity: 'critical' });
    await seedDevicePatch({ orgId, deviceId, status: 'pending', severity: 'important' });
    // ... plus 4 stale tombstones (one critical, which must NOT inflate counts) ...
    await seedDevicePatch({ orgId, deviceId, status: 'missing', severity: 'critical' });
    await seedDevicePatch({ orgId, deviceId, status: 'missing', severity: 'low' });
    await seedDevicePatch({ orgId, deviceId, status: 'missing', severity: 'low' });
    await seedDevicePatch({ orgId, deviceId, status: 'missing', severity: 'low' });
    // ... plus installed rows that don't count as outstanding.
    await seedDevicePatch({ orgId, deviceId, status: 'installed' });

    const res = await client.get(`/patches/compliance?orgId=${orgId}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    const listed = body.data.devicesNeedingPatches.find((d: { id: string }) => d.id === deviceId);
    expect(listed).toBeDefined();
    // 2 pending only — tombstones excluded.
    expect(listed.missingCount).toBe(2);
    // 1 pending critical — the tombstone critical must not be counted.
    expect(listed.criticalCount).toBe(1);
    expect(listed.importantCount).toBe(1);
    // Both pending patches are linux (OS), zero third-party.
    expect(listed.osMissing).toBe(2);
    expect(listed.thirdPartyMissing).toBe(0);
  });

  it('computes summary compliancePercent and severity summaries over installed+outstanding, excluding tombstones', async () => {
    const deviceId = await seedDevice(orgId, siteId, 'summary-device');
    // 1 installed, 1 outstanding critical pending, 3 stale tombstones (2 critical).
    await seedDevicePatch({ orgId, deviceId, status: 'installed' });
    await seedDevicePatch({ orgId, deviceId, status: 'pending', severity: 'critical' });
    await seedDevicePatch({ orgId, deviceId, status: 'missing', severity: 'critical' });
    await seedDevicePatch({ orgId, deviceId, status: 'missing', severity: 'critical' });
    await seedDevicePatch({ orgId, deviceId, status: 'missing', severity: 'low' });

    const res = await client.get(`/patches/compliance?orgId=${orgId}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    // installed=1, outstanding=1 → 1/(1+1)=50%. (Buggy code divided by all 5 rows → 20%.)
    expect(body.data.compliancePercent).toBe(50);
    // Critical relevant set is just the 1 pending critical; the 2 tombstone
    // criticals must not appear. (Buggy code reported total=3, pending=3.)
    expect(body.data.criticalSummary).toEqual({ total: 1, patched: 0, pending: 1 });
  });
});
