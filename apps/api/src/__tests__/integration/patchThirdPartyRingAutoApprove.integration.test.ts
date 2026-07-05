/**
 * Third-party ring auto-approve severity exemption (#2218) — real Postgres.
 *
 * Winget/chocolatey/homebrew patches are ingested with severity='unknown' and
 * no releaseDate, so the ring auto-approve severity gate (fail-closed on the
 * configured severity set) could NEVER approve them — enabling third-party
 * sources on a ring was dead configuration. When the policy explicitly opts
 * into 'third_party' sources, a third-party candidate is exempt from the
 * severity MEMBERSHIP check (OS patches keep full severity gating, and the
 * source gate, empty-severities kill-switch, app rules, and deferral windows
 * all still apply).
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 * Run:
 *   pnpm test:integration -- src/__tests__/integration/patchThirdPartyRingAutoApprove.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb } from './setup';
import { withDbAccessContext } from '../../db';
import { devices, patches, devicePatches } from '../../db/schema';
import {
  resolveApprovedPatchesForDevice,
  type ApprovalEvaluationConfig,
} from '../../services/patchApprovalEvaluator';
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
      agentId: `agent-3p-${agentSeq}-${Date.now()}`,
      hostname,
      displayName: hostname,
      osType: 'windows',
      osVersion: '10.0.22631',
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

/** Seed a pending device patch. No manual approval — auto-approve is what's under test. */
async function seedPendingPatch(opts: {
  orgId: string;
  deviceId: string;
  source: 'third_party' | 'microsoft';
  severity: 'critical' | 'important' | 'moderate' | 'low' | 'unknown';
  packageId?: string;
}): Promise<string> {
  const tdb = getTestDb();
  const [patch] = await tdb
    .insert(patches)
    .values({
      source: opts.source,
      externalId: `${opts.source}:${randomUUID()}`,
      title: opts.source === 'third_party' ? 'Mozilla Firefox 121.0' : 'Cumulative Update',
      severity: opts.severity,
      category: opts.source === 'third_party' ? 'application' : 'security',
      packageId: opts.packageId ?? null,
      version: opts.source === 'third_party' ? '121.0' : null,
      // releaseDate deliberately omitted (NULL) — the winget shape.
    })
    .returning({ id: patches.id });
  if (!patch) throw new Error('seedPendingPatch: no patch');
  await tdb.insert(devicePatches).values({
    deviceId: opts.deviceId,
    orgId: opts.orgId,
    patchId: patch.id,
    status: 'pending',
    lastCheckedAt: new Date(),
  });
  return patch.id;
}

function ringConfig(partnerId: string, sources: string[]): ApprovalEvaluationConfig {
  return {
    ringId: randomUUID(),
    ringPartnerId: partnerId,
    categoryRules: [],
    autoApprove: { enabled: true, severities: ['critical', 'important'], deferralDays: 0 },
    deferralDays: 0,
    sources,
  };
}

describe('third-party ring auto-approve (#2218) — end-to-end against Postgres', () => {
  let orgId: string;
  let partnerId: string;
  let siteId: string;

  beforeEach(async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    orgId = env.organization.id;
    partnerId = env.partner.id;
    siteId = env.site.id;
  });

  async function evaluate(deviceId: string, config: ApprovalEvaluationConfig) {
    return withDbAccessContext(
      {
        scope: 'organization',
        orgId,
        accessibleOrgIds: [orgId],
        // patch_approvals is partner-scoped (RLS: breeze_has_partner_access);
        // the evaluator queries it by the device-org's partner.
        accessiblePartnerIds: [partnerId],
        userId: null,
      },
      () => resolveApprovedPatchesForDevice(deviceId, orgId, config),
    );
  }

  it('auto-approves a winget-shaped patch (severity=unknown, releaseDate=null) on a third_party-enabled ring', async () => {
    const deviceId = await seedDevice(orgId, siteId, '3p-device-a');
    const patchId = await seedPendingPatch({
      orgId,
      deviceId,
      source: 'third_party',
      severity: 'unknown',
      packageId: 'Mozilla.Firefox',
    });

    const approved = await evaluate(deviceId, ringConfig(partnerId, ['third_party']));

    expect(approved).toHaveLength(1);
    expect(approved[0]!.patchId).toBe(patchId);
    expect(approved[0]!.approvalReason).toBe('ring_auto_approve');
  });

  it('does NOT approve the same winget-shaped patch when the ring only enables OS sources', async () => {
    const deviceId = await seedDevice(orgId, siteId, '3p-device-b');
    await seedPendingPatch({
      orgId,
      deviceId,
      source: 'third_party',
      severity: 'unknown',
      packageId: 'Mozilla.Firefox',
    });

    const approved = await evaluate(deviceId, ringConfig(partnerId, ['os']));

    expect(approved).toEqual([]);
  });

  it('keeps OS severity gating unchanged on a third_party-enabled ring', async () => {
    const deviceId = await seedDevice(orgId, siteId, '3p-device-c');
    const unknownOsPatch = await seedPendingPatch({
      orgId,
      deviceId,
      source: 'microsoft',
      severity: 'unknown',
    });
    const criticalOsPatch = await seedPendingPatch({
      orgId,
      deviceId,
      source: 'microsoft',
      severity: 'critical',
    });

    const approved = await evaluate(deviceId, ringConfig(partnerId, ['os', 'third_party']));

    expect(approved.map((p) => p.patchId)).toEqual([criticalOsPatch]);
    expect(approved.map((p) => p.patchId)).not.toContain(unknownOsPatch);
  });
});
