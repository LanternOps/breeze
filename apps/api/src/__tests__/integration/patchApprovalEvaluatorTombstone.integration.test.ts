/**
 * Patch approval automation must not act on stale 'missing' tombstones.
 *
 * `resolveApprovedPatchesForDevice` selects which patches to actually install on
 * a device. It previously queried device_patches `status IN ('pending','missing')`,
 * so on a device with a large tombstone backlog (see the pressless case in
 * patchComplianceTombstone.integration.test.ts) automation could try to install
 * hundreds of patches the device no longer reports — phantom installs. Only
 * 'pending' is outstanding; 'missing' is a tombstone (OUTSTANDING_DEVICE_PATCH_STATUSES).
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 * Run:
 *   pnpm test:integration -- src/__tests__/integration/patchApprovalEvaluatorTombstone.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb } from './setup';
import { withDbAccessContext } from '../../db';
import { devices, patches, devicePatches, patchApprovals } from '../../db/schema';
import { resolveApprovedPatchesForDevice, type RingConfig } from '../../services/patchApprovalEvaluator';
import { setupTestEnvironment } from './db-utils';

let agentSeq = 0;
async function seedDevice(orgId: string, siteId: string, hostname: string): Promise<string> {
  const tdb = getTestDb();
  agentSeq++;
  const [row] = await tdb
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `agent-eval-${agentSeq}-${Date.now()}`,
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
  if (!row) throw new Error('seedDevice: no row');
  return row.id;
}

/** Seed a patch + a device_patches row + a manual 'approved' approval (org-wide).
 *  Returns the patchId. The approval means automation WOULD install it if the
 *  row is treated as outstanding. */
async function seedApprovedPatch(opts: {
  orgId: string;
  deviceId: string;
  status: 'pending' | 'missing';
}): Promise<string> {
  const tdb = getTestDb();
  const [patch] = await tdb
    .insert(patches)
    .values({
      source: 'linux',
      externalId: `linux:${randomUUID()}`,
      title: 'Eval test patch',
      severity: 'important',
    })
    .returning({ id: patches.id });
  if (!patch) throw new Error('seedApprovedPatch: no patch');
  await tdb.insert(devicePatches).values({
    deviceId: opts.deviceId,
    orgId: opts.orgId,
    patchId: patch.id,
    status: opts.status,
    lastCheckedAt: new Date(),
  });
  await tdb.insert(patchApprovals).values({
    orgId: opts.orgId,
    patchId: patch.id,
    ringId: null,
    status: 'approved',
  });
  return patch.id;
}

const RING_CONFIG: RingConfig = {
  ringId: null,
  categoryRules: [],
  autoApprove: null,
  deferralDays: 0,
};

describe('resolveApprovedPatchesForDevice — tombstone exclusion', () => {
  let orgId: string;
  let siteId: string;

  beforeEach(async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    orgId = env.organization.id;
    siteId = env.site.id;
  });

  it('does not select stale "missing" tombstones for installation, even when approved', async () => {
    const deviceId = await seedDevice(orgId, siteId, 'eval-device');
    const pendingPatchId = await seedApprovedPatch({ orgId, deviceId, status: 'pending' });
    // An approved-but-tombstoned patch: must be ignored by automation.
    await seedApprovedPatch({ orgId, deviceId, status: 'missing' });

    const approved = await withDbAccessContext(
      {
        scope: 'organization',
        orgId,
        accessibleOrgIds: [orgId],
        accessiblePartnerIds: null,
        userId: null,
      },
      () => resolveApprovedPatchesForDevice(deviceId, orgId, RING_CONFIG),
    );

    expect(approved).toHaveLength(1);
    expect(approved[0]!.patchId).toBe(pendingPatchId);
  });
});
