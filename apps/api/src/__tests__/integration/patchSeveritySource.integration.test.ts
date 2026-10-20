/**
 * #9387 gap 2 — provenance of a device-reported patch severity on the catalog
 * list (GET /patches).
 *
 * The agent derives a Windows severity from the update's classification when
 * MSRC sends none and reports it as 'derived'; ingest stores that on
 * device_patches.reported_severity_source. loadCatalogReportedSeverities is a
 * grouped read over device_patches joined to devices and patches, and what it
 * must get right is which rows it reads (only patches whose shared severity is
 * unknown, never 'unknown' reports, the worst level only) and whose devices it
 * sees (the caller's scope, never another tenant's). A Drizzle mock would
 * return whatever rows we fabricate without running any of that.
 *
 * Run:
 *   pnpm test-stack up
 *   npx vitest run --config vitest.integration.config.ts src/__tests__/integration/patchSeveritySource.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb } from './setup';
import { withDbAccessContext } from '../../db';
import { devices, patches, devicePatches } from '../../db/schema';
import { resolveOutstandingDeviceScope } from '../../services/patchOutstandingDevices';
import { loadCatalogReportedSeverities } from '../../services/patchSeveritySource';
import { setupTestEnvironment, createOrganization, createSite } from './db-utils';

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

async function seedPatch(severity: 'unknown' | 'critical' = 'unknown'): Promise<string> {
  const [row] = await getTestDb()
    .insert(patches)
    .values({
      source: 'microsoft',
      externalId: `microsoft:${randomUUID()}`,
      title: `KB-9387-${randomUUID().slice(0, 8)}`,
      severity,
      osTypes: ['windows'],
    })
    .returning({ id: patches.id });
  if (!row) throw new Error('seedPatch: no row returned');
  return row.id;
}

async function seedReport(opts: {
  orgId: string;
  deviceId: string;
  patchId: string;
  severity: 'critical' | 'important' | 'moderate' | 'low' | 'unknown';
  source: 'vendor' | 'derived' | null;
}): Promise<void> {
  await getTestDb().insert(devicePatches).values({
    deviceId: opts.deviceId,
    orgId: opts.orgId,
    patchId: opts.patchId,
    status: 'pending',
    reportedSeverity: opts.severity,
    reportedSeveritySource: opts.source,
    lastCheckedAt: new Date(),
  });
}

describe('#9387 gap 2 — catalog severity provenance', () => {
  let orgId: string;
  let partnerId: string;
  let siteId: string;

  beforeEach(async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    orgId = env.organization.id;
    partnerId = env.partner.id;
    siteId = env.site.id;
  });

  function loadForOrg(patchIds: string[]) {
    const scope = resolveOutstandingDeviceScope(
      { orgCondition: (column) => eq(column, orgId) },
      {},
    );
    if (!scope) throw new Error('expected a device scope');
    return withDbAccessContext(
      { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId], userId: null },
      () => loadCatalogReportedSeverities(patchIds, scope),
    );
  }

  it('reports a derived severity as derived', async () => {
    const patchId = await seedPatch();
    const a = await seedDevice(orgId, siteId, 'a');
    const b = await seedDevice(orgId, siteId, 'b');
    await seedReport({ orgId, deviceId: a, patchId, severity: 'important', source: 'derived' });
    await seedReport({ orgId, deviceId: b, patchId, severity: 'important', source: 'derived' });

    const result = await loadForOrg([patchId]);
    expect(result.get(patchId)).toEqual({ severity: 'important', source: 'derived' });
  });

  it('is not derived when a vendor rating backs the same severity', async () => {
    const patchId = await seedPatch();
    const a = await seedDevice(orgId, siteId, 'a');
    const b = await seedDevice(orgId, siteId, 'b');
    await seedReport({ orgId, deviceId: a, patchId, severity: 'important', source: 'derived' });
    await seedReport({ orgId, deviceId: b, patchId, severity: 'important', source: 'vendor' });

    const result = await loadForOrg([patchId]);
    expect(result.get(patchId)).toEqual({ severity: 'important', source: 'vendor' });
  });

  it('takes provenance from the most severe level only, and ignores unknown reports', async () => {
    const patchId = await seedPatch();
    const a = await seedDevice(orgId, siteId, 'a');
    const b = await seedDevice(orgId, siteId, 'b');
    const c = await seedDevice(orgId, siteId, 'c');
    await seedReport({ orgId, deviceId: a, patchId, severity: 'critical', source: 'derived' });
    await seedReport({ orgId, deviceId: b, patchId, severity: 'low', source: 'vendor' });
    await seedReport({ orgId, deviceId: c, patchId, severity: 'unknown', source: null });

    const result = await loadForOrg([patchId]);
    expect(result.get(patchId)).toEqual({ severity: 'critical', source: 'derived' });
  });

  it('reports no provenance for agents that sent none', async () => {
    const patchId = await seedPatch();
    const a = await seedDevice(orgId, siteId, 'a');
    await seedReport({ orgId, deviceId: a, patchId, severity: 'moderate', source: null });

    const result = await loadForOrg([patchId]);
    expect(result.get(patchId)).toEqual({ severity: 'moderate', source: null });
  });

  it('is not derived when an older agent reported the same severity without provenance', async () => {
    const patchId = await seedPatch();
    const a = await seedDevice(orgId, siteId, 'a');
    const b = await seedDevice(orgId, siteId, 'b');
    await seedReport({ orgId, deviceId: a, patchId, severity: 'important', source: 'derived' });
    await seedReport({ orgId, deviceId: b, patchId, severity: 'important', source: null });

    const result = await loadForOrg([patchId]);
    expect(result.get(patchId)).toEqual({ severity: 'important', source: null });
  });

  it('skips patches whose shared severity is already known (the trusted value wins)', async () => {
    const patchId = await seedPatch('critical');
    const a = await seedDevice(orgId, siteId, 'a');
    await seedReport({ orgId, deviceId: a, patchId, severity: 'important', source: 'derived' });

    const result = await loadForOrg([patchId]);
    expect(result.has(patchId)).toBe(false);
  });

  it('never reads another org\'s device reports for the same shared patch', async () => {
    const patchId = await seedPatch();
    const otherOrg = await createOrganization({ partnerId });
    const otherSite = await createSite({ orgId: otherOrg.id });
    const otherDevice = await seedDevice(otherOrg.id, otherSite.id, 'other-org');
    await seedReport({ orgId: otherOrg.id, deviceId: otherDevice, patchId, severity: 'critical', source: 'derived' });

    const result = await loadForOrg([patchId]);
    expect(result.has(patchId)).toBe(false);
  });

  it('rejects a provenance value outside the allowed set at the database', async () => {
    const patchId = await seedPatch();
    const a = await seedDevice(orgId, siteId, 'a');
    await expect(
      getTestDb().insert(devicePatches).values({
        deviceId: a,
        orgId,
        patchId,
        status: 'pending',
        reportedSeverity: 'important',
        reportedSeveritySource: 'msrc',
        lastCheckedAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});
