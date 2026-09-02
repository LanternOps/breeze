/**
 * Update-ring DEVICES count for PARTNER-level policy assignments (#3954).
 *
 * `resolveRingAssignedDeviceIds` (apps/api/src/routes/updateRingsHelpers.ts)
 * used to lump partner-level assignments in with org-level ones:
 *
 *     else if (a.level === 'organization' || a.level === 'partner') orgIds.push(a.targetId);
 *     ... where(inArray(devices.orgId, orgIds))
 *
 * A partner-level assignment's `targetId` is a PARTNER id, so that matched zero
 * rows and the Update Rings list rendered "DEVICES 0" for a ring that was
 * genuinely applied (the patch scheduler has its own correct partner branch).
 *
 * WHY REAL POSTGRES: the failure was entirely inside a `.where()` predicate and
 * depends on the devices→organizations join actually existing. A chainable
 * Drizzle mock that ignores `.where()` passes against both the broken and the
 * fixed code (see memory: vacuous_drizzle_where_clause_assertions). The
 * compiled-SQL unit suite (updateRingsHelpers.partnerFanout.test.ts) pins the
 * predicate text; this proves the resolved COUNT against real rows, under a
 * real partner-scope RLS context on the unprivileged `breeze_app` role.
 *
 * Coverage:
 *   - partner-wide policy + partner-level assignment counts devices across ALL
 *     of the partner's orgs (the regression: was 0, must be 2)
 *   - ephemeral Quick Support devices stay excluded from the partner fan-out
 *   - another partner's devices are never counted (cross-partner isolation)
 *   - a partner B context resolves 0 for partner A's ring (RLS hides the chain)
 *   - a legacy ORG-owned policy carrying a partner-level assignment clamps to
 *     its own org, mirroring patchSchedulerWorker.resolveDeviceIdsForAssignment
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  devices,
  patchPolicies,
} from '../../db/schema';
import { resolveRingDeviceCounts, resolveRingDeviceIds } from '../../routes/updateRingsHelpers';
import { createPartner, createOrganization, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function partnerCtx(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    // Mirrors computeAccessibleOrgIds(scope='partner'): the partner's active
    // orgs. Partner-wide rows are reachable via accessiblePartnerIds.
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

/**
 * One device, in its OWN system-scope transaction. `breeze_partner_export_devices_insert`
 * takes a partner-export lock per touched org and requires ascending-UUID lock
 * order, so seeding devices across several orgs inside a single transaction
 * fails with "locks must be acquired in ascending UUID order". One org per
 * transaction sidesteps the ordering constraint entirely.
 */
async function seedDevice(orgId: string, siteId: string, isEphemeral = false): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [d] = await db
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `agent-${randomUUID()}`,
        hostname: `host-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '1.0',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
        deviceRole: 'workstation',
        isEphemeral,
      })
      .returning({ id: devices.id });
    if (!d) throw new Error('failed to seed device');
    return d.id;
  });
}

/**
 * Partner A: two orgs, one device each, plus one EPHEMERAL device in org 1.
 * Partner B: one org with one device (must never be counted for A's ring).
 */
async function seedFixture() {
  const base = await withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();

    const orgA1 = await createOrganization({ partnerId: partnerA.id });
    const orgA2 = await createOrganization({ partnerId: partnerA.id });
    const orgB1 = await createOrganization({ partnerId: partnerB.id });

    const siteA1 = await createSite({ orgId: orgA1.id });
    const siteA2 = await createSite({ orgId: orgA2.id });
    const siteB1 = await createSite({ orgId: orgB1.id });

    const [ringA] = await db
      .insert(patchPolicies)
      .values({ partnerId: partnerA.id, kind: 'ring', name: `ring-a-${randomUUID().slice(0, 8)}` })
      .returning({ id: patchPolicies.id });
    if (!ringA) throw new Error('failed to seed ring');

    return { partnerA, partnerB, orgA1, orgA2, orgB1, siteA1, siteA2, siteB1, ringA };
  });

  // Each seedDevice opens its own transaction — see the note on seedDevice.
  const deviceA1 = await seedDevice(base.orgA1.id, base.siteA1.id);
  const deviceA2 = await seedDevice(base.orgA2.id, base.siteA2.id);
  // Quick Support machine — a stranger's personal PC, must stay out of the count.
  const ephemeralA = await seedDevice(base.orgA1.id, base.siteA1.id, true);
  const deviceB1 = await seedDevice(base.orgB1.id, base.siteB1.id);

  return { ...base, deviceA1, deviceA2, ephemeralA, deviceB1 };
}

/**
 * Link a config policy to `ringId` (featureType 'patch') and assign it.
 * `ownerOrgId` null => partner-wide policy; set => legacy org-owned policy.
 */
async function linkPolicyToRing(opts: {
  ringId: string;
  partnerId: string;
  ownerOrgId?: string | null;
  level: 'partner' | 'organization';
  targetId: string;
}): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const ownerOrgId = opts.ownerOrgId ?? null;
    const [policy] = await db
      .insert(configurationPolicies)
      .values({
        // Exactly one ownership axis (config_policies_one_owner_chk).
        orgId: ownerOrgId,
        partnerId: ownerOrgId ? null : opts.partnerId,
        name: `cfg-${randomUUID().slice(0, 8)}`,
        status: 'active',
      })
      .returning({ id: configurationPolicies.id });
    if (!policy) throw new Error('failed to seed config policy');

    await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy.id,
      featureType: 'patch',
      featurePolicyId: opts.ringId,
    });

    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy.id,
      level: opts.level,
      targetId: opts.targetId,
    });

    return policy.id;
  });
}

describe('update-ring device count — partner-level assignment fan-out (#3954)', () => {
  runDb('counts devices across ALL the partner orgs (regression: was 0)', async () => {
    const f = await seedFixture();
    await linkPolicyToRing({
      ringId: f.ringA.id,
      partnerId: f.partnerA.id,
      level: 'partner',
      targetId: f.partnerA.id,
    });

    const counts = await withDbAccessContext(
      partnerCtx(f.partnerA.id, [f.orgA1.id, f.orgA2.id]),
      () => resolveRingDeviceCounts([f.ringA.id])
    );

    // Pre-fix this was 0: partnerA.id was matched against devices.org_id.
    // 2 (not 3) — the ephemeral Quick Support device is excluded.
    expect(counts.get(f.ringA.id)).toBe(2);
  });

  runDb('resolves the exact device ids, excluding ephemeral and other partners', async () => {
    const f = await seedFixture();
    await linkPolicyToRing({
      ringId: f.ringA.id,
      partnerId: f.partnerA.id,
      level: 'partner',
      targetId: f.partnerA.id,
    });

    const ids = await withDbAccessContext(
      partnerCtx(f.partnerA.id, [f.orgA1.id, f.orgA2.id]),
      () => resolveRingDeviceIds(f.ringA.id)
    );

    expect(ids.sort()).toEqual([f.deviceA1, f.deviceA2].sort());
    expect(ids).not.toContain(f.ephemeralA);
    expect(ids).not.toContain(f.deviceB1);
  });

  runDb('partner B resolves 0 for partner A ring (RLS hides the policy chain)', async () => {
    const f = await seedFixture();
    await linkPolicyToRing({
      ringId: f.ringA.id,
      partnerId: f.partnerA.id,
      level: 'partner',
      targetId: f.partnerA.id,
    });

    const counts = await withDbAccessContext(
      partnerCtx(f.partnerB.id, [f.orgB1.id]),
      () => resolveRingDeviceCounts([f.ringA.id])
    );

    expect(counts.get(f.ringA.id) ?? 0).toBe(0);
  });

  runDb('legacy org-owned policy at partner level clamps to its own org', async () => {
    const f = await seedFixture();
    // Org-owned policy (orgA1) carrying a partner-level assignment. The DB
    // integrity trigger permits this because the target partner matches the
    // owning org's partner; the scheduler clamps such a policy to its own org,
    // so the displayed count must not claim the whole partner.
    await linkPolicyToRing({
      ringId: f.ringA.id,
      partnerId: f.partnerA.id,
      ownerOrgId: f.orgA1.id,
      level: 'partner',
      targetId: f.partnerA.id,
    });

    const counts = await withDbAccessContext(
      partnerCtx(f.partnerA.id, [f.orgA1.id, f.orgA2.id]),
      () => resolveRingDeviceCounts([f.ringA.id])
    );

    // orgA1's single non-ephemeral device only — NOT orgA2's.
    expect(counts.get(f.ringA.id)).toBe(1);
  });

  runDb('SYSTEM scope: a target org under another partner is clamped out', async () => {
    // The ring-partner clamp is defense-in-depth against a subset assignment
    // whose target org has been reparented to a different partner. Normally the
    // DB forbids reaching that state (config_policy_assignment_target_integrity
    // rejects the write, and a_config_policy_assignment_target_update rejects
    // the reparent), so we FORGE it with triggers disabled — the same idiom the
    // cross-tenant forge suites use.
    //
    // This runs under SYSTEM scope deliberately: accessible_org_ids is
    // unrestricted there, so RLS contributes NO org clamp. If this passes, the
    // SQL clamp is doing the work, not the caller's RLS context.
    const f = await seedFixture();
    const policyId = await linkPolicyToRing({
      ringId: f.ringA.id,
      partnerId: f.partnerA.id,
      level: 'organization',
      targetId: f.orgA2.id, // legal: orgA2 belongs to partner A
    });

    const admin = getTestDb();
    // DISABLE TRIGGER USER rather than naming one: the integrity trigger has
    // already been renamed once (2026-07-29-serialize-config-policy-assignment-integrity.sql
    // split it into a_config_policy_assignment_integrity_{insert,update,delete}),
    // and a name-specific ALTER would silently rot into a 42704 on the next rename.
    await admin.execute(sql`ALTER TABLE config_policy_assignments DISABLE TRIGGER USER`);
    try {
      // Repoint at partner B's org — the state a reparent would have produced.
      await admin.execute(
        sql`UPDATE config_policy_assignments SET target_id = ${f.orgB1.id}
            WHERE config_policy_id = ${policyId} AND level = 'organization'`
      );
    } finally {
      await admin.execute(sql`ALTER TABLE config_policy_assignments ENABLE TRIGGER USER`);
    }

    const counts = await withSystemDbAccessContext(() => resolveRingDeviceCounts([f.ringA.id]));

    // partnerB's device must NOT be attributed to partnerA's ring.
    expect(counts.get(f.ringA.id) ?? 0).toBe(0);
  });

  runDb('non-vacuity probe: system scope sees the seeded partner devices', async () => {
    // If .env.test were missing and these tests ran on a BYPASSRLS connection,
    // the isolation assertion above would pass vacuously. This probe fails loudly
    // if the fixture itself never landed.
    const f = await seedFixture();
    const rows = await withSystemDbAccessContext(() =>
      db
        .select({ id: devices.id })
        .from(devices)
        .where(inArray(devices.id, [f.deviceA1, f.deviceA2, f.deviceB1]))
    );
    expect(rows).toHaveLength(3);
  });
});
