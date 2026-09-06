/**
 * #2787 item 4 — the retention purge job against REAL Postgres.
 *
 * The unit suite (`jobs/removedDevicePurge.test.ts`) drives a fake db and can
 * prove the CONTROL FLOW — which branch counts what, that a policy-less org is
 * never queried — but not what Postgres does with the query it built. Four
 * properties live entirely in the database and cannot be argued in a mock:
 *
 *   - ELIGIBILITY. `decommissioned_at < now() - N days` evaluated by the
 *     database over real rows, with a device inside the window and a device
 *     outside it in the SAME org. A predicate that is off by a sign or a unit
 *     deletes a customer's whole removed-device history on the first run.
 *
 *   - TENANCY. The window belongs to ONE partner's org. A second org under a
 *     DIFFERENT partner, with an equally-old removed device and no policy of
 *     its own, must be untouched — the `policyOwnershipCondition` + dual-axis
 *     assignment resolution the resolver builds is only provable against real
 *     rows, since a partner-wide policy is `org_id NULL` and an org-axis-only
 *     predicate silently matches nothing (#3963).
 *
 *   - PRECEDENCE, end to end: an org-level link outranking its partner's.
 *
 *   - THE UNINSTALL REFUSAL, through the real `device_commands` predicate
 *     (`uninstall_reasons @> ARRAY['device_remove']` with
 *     `device_remove_expires_at > now()` on the DATABASE clock). A device this
 *     misses is a device whose agent nobody can ever remove.
 *
 * Plus a fifth, which is not about the job at all: the migration's BACKFILL
 * statement, replayed against a decommissioned row with a NULL stamp. Without
 * it every device removed before this feature shipped would be exempt forever.
 *
 * Deliberately NOT `it.runIf(...)`: a skipped guard is indistinguishable from
 * a passing one in a CI log.
 *
 * Run (note: NO `--` before the path — `pnpm ... test:integration -- <path>`
 * silently runs the whole integration suite instead of filtering):
 *   pnpm test-stack up
 *   cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/removedDevicePurge.integration.test.ts
 */
import './setup';

import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import type { DbAccessContext } from '../../db';
import {
  auditLogs,
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceCommands,
  devices,
} from '../../db/schema';
import { ANONYMOUS_ACTOR_ID } from '../../services/auditEvents';
import { queueDeviceUninstall } from '../../services/deviceUninstallDrain';
import { getOrgPurgeRemovedAfterDays } from '../../services/deviceLifecyclePolicy';
import { runRemovedDevicePurgeOnce } from '../../jobs/removedDevicePurge';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const DAY_MS = 24 * 60 * 60 * 1000;

const createdPolicies: string[] = [];
const createdDevices: string[] = [];

afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const id of createdDevices) {
      await db.delete(deviceCommands).where(eq(deviceCommands.deviceId, id));
      await db.delete(devices).where(eq(devices.id, id));
    }
    for (const id of createdPolicies) {
      await db.delete(configurationPolicies).where(eq(configurationPolicies.id, id));
    }
  });
  createdDevices.length = 0;
  createdPolicies.length = 0;
});

async function seedTenant() {
  const partner = await createPartner({ status: 'active' });
  const org = await createOrganization({ partnerId: partner!.id, status: 'active' });
  const site = await createSite({ orgId: org!.id });
  const user = await createUser({ partnerId: partner!.id, orgId: org!.id });
  return { partner: partner!, org: org!, site: site!, user: user! };
}

/**
 * A removed device whose `decommissioned_at` is `removedDaysAgo` in the past.
 * Passing `null` seeds the pre-migration shape: removed, but with no stamp.
 */
async function seedRemovedDevice(
  orgId: string,
  siteId: string,
  removedDaysAgo: number | null,
): Promise<{ id: string; hostname: string }> {
  const unique = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const hostname = `purge-host-${unique}`;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `purge-agent-${unique}`,
      hostname,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'decommissioned',
      decommissionedAt: removedDaysAgo === null ? null : new Date(Date.now() - removedDaysAgo * DAY_MS),
      agentTokenHash: createHash('sha256').update(`brz_purge_${unique}`).digest('hex'),
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('seedRemovedDevice: insert returned no row');
  createdDevices.push(row.id);
  return { id: row.id, hostname };
}

/** A device_lifecycle policy carrying `purgeRemovedAfterDays`, plus its assignment. */
async function seedPurgePolicy(
  owner: { orgId: string | null; partnerId: string | null },
  purgeRemovedAfterDays: number | null,
  assignment: { level: 'partner' | 'organization'; targetId: string; priority?: number },
): Promise<string> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({
        orgId: owner.orgId,
        partnerId: owner.partnerId,
        name: `device_lifecycle policy ${randomUUID()}`,
        status: 'active',
      })
      .returning();
    createdPolicies.push(policy!.id);
    await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id,
      featureType: 'device_lifecycle',
      inlineSettings: { purgeRemovedAfterDays },
    });
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy!.id,
      level: assignment.level,
      targetId: assignment.targetId,
      priority: assignment.priority ?? 0,
    });
    return policy!.id;
  });
}

async function deviceExists(deviceId: string): Promise<boolean> {
  const rows = await getTestDb().select({ id: devices.id }).from(devices).where(eq(devices.id, deviceId));
  return rows.length > 0;
}

/** Queue the durable `device_remove` uninstall exactly the Remove route does. */
async function queueRemoveUninstall(deviceId: string, actorUserId: string): Promise<void> {
  await withSystemDbAccessContext(() =>
    db.transaction(async (tx) => {
      const result = await queueDeviceUninstall(tx, deviceId, actorUserId);
      if (!result.queued && !result.mergedIntoExisting) {
        throw new Error('queueRemoveUninstall: nothing was queued — fixture is not exercising the guard');
      }
    }),
  );
}

describe('removedDevicePurge (integration)', () => {
  it('purges only devices past the partner-wide window, and only in orgs that window covers', async () => {
    const a = await seedTenant();
    const b = await seedTenant(); // a DIFFERENT partner, no policy of its own

    await seedPurgePolicy({ orgId: null, partnerId: a.partner.id }, 7, {
      level: 'partner',
      targetId: a.partner.id,
    });

    // Positive control on the fixture: a partner-wide policy is `org_id NULL`,
    // so if the resolver's ownership arm were missing this whole test would
    // pass vacuously with "nothing was purged anywhere".
    const resolved = await withDbAccessContext(SYSTEM_CTX, () => getOrgPurgeRemovedAfterDays(a.org.id));
    expect(resolved).toBe(7);

    const eligible = await seedRemovedDevice(a.org.id, a.site.id, 10);
    const tooRecent = await seedRemovedDevice(a.org.id, a.site.id, 3);
    const otherPartner = await seedRemovedDevice(b.org.id, b.site.id, 10);

    const result = await runRemovedDevicePurgeOnce();

    expect(result.purged).toBeGreaterThanOrEqual(1);
    expect(await deviceExists(eligible.id)).toBe(false);
    // Inside the window — the org opted into 7 days, not 3.
    expect(await deviceExists(tooRecent.id)).toBe(true);
    // Another MSP's customer. Same age, no policy: an ownership or assignment
    // bug that leaked the window across partners would delete this row.
    expect(await deviceExists(otherPartner.id)).toBe(true);
    expect(await withDbAccessContext(SYSTEM_CTX, () => getOrgPurgeRemovedAfterDays(b.org.id))).toBeNull();
  });

  it('writes one system-actor audit row per purged device recording the policy that authorised it', async () => {
    const a = await seedTenant();
    await seedPurgePolicy({ orgId: null, partnerId: a.partner.id }, 7, {
      level: 'partner',
      targetId: a.partner.id,
    });
    const eligible = await seedRemovedDevice(a.org.id, a.site.id, 10);

    await runRemovedDevicePurgeOnce();
    expect(await deviceExists(eligible.id)).toBe(false);

    // The devices row is permanently gone, so this entry is the ONLY durable
    // record that a background job deleted a customer's device.
    const [audit] = await getTestDb()
      .select({
        actorType: auditLogs.actorType,
        actorId: auditLogs.actorId,
        action: auditLogs.action,
        resourceName: auditLogs.resourceName,
        details: auditLogs.details,
      })
      .from(auditLogs)
      .where(and(eq(auditLogs.resourceId, eligible.id), eq(auditLogs.action, 'device.permanent_delete')));

    expect(audit).toBeDefined();
    expect(audit!.actorType).toBe('system');
    // `audit_logs.actor_id` is `uuid NOT NULL`, so the job identifies itself in
    // `details.job`, not in the actor column.
    expect(audit!.actorId).toBe(ANONYMOUS_ACTOR_ID);
    expect(audit!.resourceName).toBe(eligible.hostname);
    expect(audit!.details).toMatchObject({
      job: 'removed-device-purge',
      retentionPolicy: true,
      purgeRemovedAfterDays: 7,
    });
  });

  it('lets an org-level window outrank the partner-wide one', async () => {
    const a = await seedTenant();
    await seedPurgePolicy({ orgId: null, partnerId: a.partner.id }, 7, {
      level: 'partner',
      targetId: a.partner.id,
    });
    await seedPurgePolicy({ orgId: a.org.id, partnerId: null }, 30, {
      level: 'organization',
      targetId: a.org.id,
    });

    expect(await withDbAccessContext(SYSTEM_CTX, () => getOrgPurgeRemovedAfterDays(a.org.id))).toBe(30);

    // 10 days old: eligible under the partner's 7-day window, NOT under the
    // org's 30-day one. The closer assignment wins, so this row survives.
    const protectedByOrgPolicy = await seedRemovedDevice(a.org.id, a.site.id, 10);
    const past30 = await seedRemovedDevice(a.org.id, a.site.id, 45);

    await runRemovedDevicePurgeOnce();

    expect(await deviceExists(protectedByOrgPolicy.id)).toBe(true);
    expect(await deviceExists(past30.id)).toBe(false);
  });

  it('lets an org-level null opt that org out of its partner-wide window entirely', async () => {
    const a = await seedTenant();
    await seedPurgePolicy({ orgId: null, partnerId: a.partner.id }, 7, {
      level: 'partner',
      targetId: a.partner.id,
    });
    await seedPurgePolicy({ orgId: a.org.id, partnerId: null }, null, {
      level: 'organization',
      targetId: a.org.id,
    });

    expect(await withDbAccessContext(SYSTEM_CTX, () => getOrgPurgeRemovedAfterDays(a.org.id))).toBeNull();

    const survives = await seedRemovedDevice(a.org.id, a.site.id, 400);

    await runRemovedDevicePurgeOnce();

    expect(await deviceExists(survives.id)).toBe(true);
  });

  it('never purges a device whose removal time is unknown (NULL stamp)', async () => {
    const a = await seedTenant();
    await seedPurgePolicy({ orgId: null, partnerId: a.partner.id }, 1, {
      level: 'partner',
      targetId: a.partner.id,
    });

    const unstamped = await seedRemovedDevice(a.org.id, a.site.id, null);
    const stamped = await seedRemovedDevice(a.org.id, a.site.id, 10);

    const result = await runRemovedDevicePurgeOnce();

    // `stamped` is the positive control: without it, "unstamped survived"
    // would also be satisfied by a run that purged nothing at all.
    expect(await deviceExists(stamped.id)).toBe(false);
    expect(await deviceExists(unstamped.id)).toBe(true);
    expect(result.purged).toBeGreaterThanOrEqual(1);
  });

  it('skips a device whose agent uninstall is still queued, and leaves both the device and the command intact', async () => {
    const a = await seedTenant();
    await seedPurgePolicy({ orgId: null, partnerId: a.partner.id }, 7, {
      level: 'partner',
      targetId: a.partner.id,
    });

    const draining = await seedRemovedDevice(a.org.id, a.site.id, 10);
    await queueRemoveUninstall(draining.id, a.user.id);
    const alsoEligible = await seedRemovedDevice(a.org.id, a.site.id, 10);

    const result = await runRemovedDevicePurgeOnce();

    expect(result.skippedUninstallPending).toBeGreaterThanOrEqual(1);
    expect(await deviceExists(draining.id)).toBe(true);
    // `device_commands` is IN the device cascade: a purge that ran here would
    // have destroyed the only command that will ever clean the endpoint.
    const stillQueued = await getTestDb()
      .select({ id: deviceCommands.id, status: deviceCommands.status })
      .from(deviceCommands)
      .where(eq(deviceCommands.deviceId, draining.id));
    expect(stillQueued).toHaveLength(1);
    expect(stillQueued[0]!.status).toBe('pending');

    // The skip is per device, not per org: its neighbour still goes.
    expect(await deviceExists(alsoEligible.id)).toBe(false);
  });

  it("replaying the migration's backfill stamps an already-removed device that has no stamp", async () => {
    const a = await seedTenant();
    const legacy = await seedRemovedDevice(a.org.id, a.site.id, null);

    const before = await getTestDb()
      .select({ decommissionedAt: devices.decommissionedAt, updatedAt: devices.updatedAt })
      .from(devices)
      .where(eq(devices.id, legacy.id));
    expect(before[0]!.decommissionedAt).toBeNull();

    // The exact statement from
    // 2026-10-11-160000-device-lifecycle-feature-and-decommissioned-at.sql.
    // Scoped to this fixture row so a replay cannot disturb sibling suites'
    // data; the migration itself is unscoped by design.
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.execute(sql`
        UPDATE devices
           SET decommissioned_at = updated_at
         WHERE status = 'decommissioned' AND decommissioned_at IS NULL
           AND id = ${legacy.id}
      `),
    );

    const after = await getTestDb()
      .select({ decommissionedAt: devices.decommissionedAt, updatedAt: devices.updatedAt })
      .from(devices)
      .where(eq(devices.id, legacy.id));

    expect(after[0]!.decommissionedAt).not.toBeNull();
    expect(after[0]!.decommissionedAt!.getTime()).toBe(before[0]!.updatedAt!.getTime());
  });
});
