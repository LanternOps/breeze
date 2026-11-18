/**
 * #9611 — decommissioned devices are not in the patch-compliance population.
 *
 * The dashboard card read "80 of 98 devices fully patched" beside a Total
 * Devices tile of 94: GET /patches/compliance counted decommissioned devices
 * while the device KPIs (queryDeviceStats) did not. Both now share
 * techFacingDeviceConditions; so does the exported compliance report.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/patchComplianceDecommissioned.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getTestDb } from './setup';
import { withSystemDbAccessContext } from '../../db';
import { authMiddleware } from '../../middleware/auth';
import { patchRoutes } from '../../routes/patches';
import { generateComplianceSummary } from '../../jobs/patchComplianceReportWorker';
import { queryDeviceStats } from '../../services/deviceStats';
import { devices, patches, devicePatches } from '../../db/schema';
import { createDevice, createIntegrationTestClient, type IntegrationTestClient } from './db-utils';

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/patches', patchRoutes);
  return app;
}

async function seedPendingPatch(orgId: string, deviceId: string): Promise<void> {
  const tdb = getTestDb();
  const [patch] = await tdb
    .insert(patches)
    .values({ source: 'linux', externalId: `linux:${randomUUID()}`, title: 'Test patch', severity: 'unknown' })
    .returning({ id: patches.id });
  await tdb.insert(devicePatches).values({
    deviceId,
    orgId,
    patchId: patch!.id,
    status: 'pending',
    lastCheckedAt: new Date(),
  });
}

describe('patch compliance excludes decommissioned devices (#9611)', () => {
  let client: IntegrationTestClient;
  let orgId: string;
  let liveId: string;
  let decomId: string;

  beforeEach(async () => {
    client = await createIntegrationTestClient(buildApp(), { scope: 'organization' });
    orgId = client.env.organization.id;
    const siteId = client.env.site.id;
    liveId = (await createDevice({ orgId, siteId, hostname: 'live-device' })).id;
    decomId = (await createDevice({ orgId, siteId, hostname: 'decom-device' })).id;
    // Both have an outstanding patch; only the live one may count.
    await seedPendingPatch(orgId, liveId);
    await seedPendingPatch(orgId, decomId);
    await getTestDb().update(devices).set({ status: 'decommissioned' }).where(eq(devices.id, decomId));
  });

  it('GET /patches/compliance counts the same population as the device KPIs', async () => {
    const res = await client.get(`/patches/compliance?orgId=${orgId}`);
    expect(res.status).toBe(200);
    const { data } = await res.json();

    expect(data.totalDevices).toBe(1);
    const needing = data.devicesNeedingPatches.map((d: { id: string }) => d.id);
    expect(needing).toEqual([liveId]);
    expect(data.summary.pending).toBe(1);

    const stats = await withSystemDbAccessContext(() => queryDeviceStats(eq(devices.orgId, orgId)));
    expect(data.totalDevices).toBe(stats.total);
  });

  it('the exported compliance report summary excludes the decommissioned device too', async () => {
    const summary = await withSystemDbAccessContext(() =>
      generateComplianceSummary(orgId, { version: 1, kind: 'unrestricted', orgId }, null, null),
    );
    expect(summary.pending).toBe(1);
    expect(summary.total).toBe(1);
  });
});
