/**
 * Per-device reported severity/category overlay (device_patches.reported_severity
 * / reported_category).
 *
 * `patches.severity`/`.category` only accept a value from a trusted source (a
 * curated third-party catalog match); every `microsoft`/`apple`/`linux`/`custom`
 * row starts and stays `'unknown'`/NULL there forever, since no trusted
 * classifier exists for those sources. That silently breaks severity-keyed
 * auto-approval rules for the majority of patch volume on a Windows-heavy
 * fleet. The per-device overlay gives each tenant its own agent's report back
 * as a fallback, WITHOUT letting one device's report move the shared,
 * un-tenanted row (and therefore every other tenant's decisions).
 *
 * Prerequisites:
 *   pnpm test-stack up   (or docker compose -f docker-compose.test.yml up -d)
 * Run:
 *   pnpm test:integration -- src/__tests__/integration/patchReportedSeverityOverlay.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb } from './setup';
import { withDbAccessContext } from '../../db';
import { devices, patches, devicePatches } from '../../db/schema';
import { resolveApprovedPatchesForDevice } from '../../services/patchEligibility';
import type { RingConfig } from '../../services/patchApprovalEvaluator';
import { setupTestEnvironment, createOrganization, createSite } from './db-utils';

let agentSeq = 0;
async function seedDevice(orgId: string, siteId: string, hostname: string): Promise<string> {
  const tdb = getTestDb();
  agentSeq++;
  const [row] = await tdb
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `agent-severity-overlay-${agentSeq}-${Date.now()}`,
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
  if (!row) throw new Error('seedDevice: no row');
  return row.id;
}

/**
 * A `microsoft`-source patch with NO trusted classification on the shared row
 * (severity 'unknown', category NULL — exactly what upsertPendingPatches
 * writes for an uncurated report). Real WUA/MSRC severity, when present, only
 * ever lands via the per-device `reported_severity` overlay.
 */
async function seedUnclassifiedMicrosoftPatch(): Promise<string> {
  const tdb = getTestDb();
  const [patch] = await tdb
    .insert(patches)
    .values({
      source: 'microsoft',
      externalId: `msrc:${randomUUID()}`,
      title: 'Cumulative Update for Windows',
      severity: 'unknown',
      category: null,
    })
    .returning({ id: patches.id });
  if (!patch) throw new Error('seedUnclassifiedMicrosoftPatch: no patch');
  return patch.id;
}

async function seedDevicePatch(opts: {
  deviceId: string;
  orgId: string;
  patchId: string;
  reportedSeverity: string | null;
}): Promise<void> {
  const tdb = getTestDb();
  await tdb.insert(devicePatches).values({
    deviceId: opts.deviceId,
    orgId: opts.orgId,
    patchId: opts.patchId,
    status: 'pending',
    reportedSeverity: opts.reportedSeverity as never,
    lastCheckedAt: new Date(),
  });
}

// Ring auto-approves 'critical' OS patches only, no deferral, no category
// rules — isolates the severity gate this overlay feeds.
function criticalAutoApproveRing(): RingConfig {
  return {
    ringId: randomUUID(),
    categoryRules: [],
    autoApprove: { enabled: true, severities: ['critical'] },
    deferralDays: 0,
  };
}

describe('device_patches reported severity overlay — approval-rule effect', () => {
  let orgId: string;
  let partnerId: string;
  let siteId: string;

  beforeEach(async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    orgId = env.organization.id;
    partnerId = env.partner.id;
    siteId = env.site.id;
  });

  it('auto-approves a Windows patch by its own reported severity when the shared row carries none', async () => {
    const deviceId = await seedDevice(orgId, siteId, 'reporting-device');
    const patchId = await seedUnclassifiedMicrosoftPatch();
    await seedDevicePatch({ deviceId, orgId, patchId, reportedSeverity: 'critical' });

    const approved = await withDbAccessContext(
      {
        scope: 'organization',
        orgId,
        accessibleOrgIds: [orgId],
        accessiblePartnerIds: [partnerId],
        userId: null,
      },
      () => resolveApprovedPatchesForDevice(deviceId, orgId, criticalAutoApproveRing()),
    );

    expect(approved).toHaveLength(1);
    expect(approved[0]!.patchId).toBe(patchId);
    expect(approved[0]!.severity).toBe('critical');
    expect(approved[0]!.approvalReason).toBe('ring_auto_approve');
  });

  it('does not let one org device\'s reported severity affect another org\'s view of the same shared patch row', async () => {
    // Same shared, un-tenanted patch row for both orgs.
    const patchId = await seedUnclassifiedMicrosoftPatch();

    const reportingDeviceId = await seedDevice(orgId, siteId, 'reporting-device-2');
    await seedDevicePatch({ deviceId: reportingDeviceId, orgId, patchId, reportedSeverity: 'critical' });

    // A second, unrelated org+device with no severity report of its own.
    const otherOrg = await createOrganization({ partnerId });
    const otherSite = await createSite({ orgId: otherOrg.id });
    const silentDeviceId = await seedDevice(otherOrg.id, otherSite.id, 'silent-device');
    await seedDevicePatch({ deviceId: silentDeviceId, orgId: otherOrg.id, patchId, reportedSeverity: null });

    const otherApproved = await withDbAccessContext(
      {
        scope: 'organization',
        orgId: otherOrg.id,
        accessibleOrgIds: [otherOrg.id],
        accessiblePartnerIds: [partnerId],
        userId: null,
      },
      () => resolveApprovedPatchesForDevice(silentDeviceId, otherOrg.id, criticalAutoApproveRing()),
    );

    // The other org's device never reported a severity, and the first org's
    // report must not have been copied onto the shared row — so nothing is approved.
    expect(otherApproved).toHaveLength(0);

    // The original org's own report still applies, unaffected by the second org's read.
    const originalApproved = await withDbAccessContext(
      {
        scope: 'organization',
        orgId,
        accessibleOrgIds: [orgId],
        accessiblePartnerIds: [partnerId],
        userId: null,
      },
      () => resolveApprovedPatchesForDevice(reportingDeviceId, orgId, criticalAutoApproveRing()),
    );
    expect(originalApproved).toHaveLength(1);
    expect(originalApproved[0]!.patchId).toBe(patchId);
  });
});
