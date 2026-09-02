import './setup';

import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import { auditLogs, deviceCommands, devices, enrollmentKeys, organizations, partners } from '../../db/schema';
import {
  abortOrganizationOffboarding,
  repairIncompleteEntry,
} from '../../services/tenantOffboarding';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

/**
 * #4022 — the offboarding sweep selects candidates in one system context and
 * repairs each in a separate one, keying on the SNAPSHOTTED `startedAt`. An
 * operator can abort the tenant in between, and that abort is a legitimate
 * no-op when the stamp is null: its UPDATE guards on
 * `isNotNull(offboardingStartedAt)` and returns before cancelling anything.
 *
 * So the repair could arrive at a tenant that is back to `active`, take its
 * lock on `eq(id)` alone, and queue fresh `self_uninstall` rows plus a live
 * stamp. Because the tenant is no longer `offboarding`, `getAgentTenantState`
 * stops returning `'draining'` and the claim runs with no type allowlist — the
 * fleet collects those uninstalls as ordinary commands on the next heartbeat.
 * The audit row records `offboarding_entry_repaired` with a success result, so
 * nothing about it looks wrong afterwards.
 *
 * This drives the real service against real Postgres, staging the race by
 * calling the repair with a snapshotted candidate — the sweep's own select
 * would not return the tenant once the abort has committed.
 *
 * Scope, deliberately: this pins the RECHECK, not the lock. Every abort here
 * commits before the repair starts, so removing `.for('update')` still leaves
 * all of these green — do not read a green run of THIS file as the lock being
 * covered.
 *
 * The lock is covered, separately: `offboardingRepairLockBarrier.integration.test.ts`
 * (#4036) holds an uncommitted UPDATE open across the repair and drives the
 * real `sweepOffboardingTenants`, asserting via `pg_blocking_pids` that the
 * repair queues behind the tenant row. Deleting `.for('update')` reds THAT
 * file. The two suites are complementary and both are load-bearing.
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedDevice(orgId: string, siteId: string, label: string): Promise<string> {
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `agent-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      hostname: `host-${label}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'offline',
    })
    .returning({ id: devices.id });
  return row!.id;
}

/**
 * `prepareAgentDrainForOrgIds` expires every unexpired enrollment key for the
 * org (`expiresAt = now`). Seeding one with a far-future expiry gives the
 * abandon path a DB-observable probe: if the early return were placed AFTER
 * drain prep instead of before it, this key would come back stamped to ~now
 * even though nothing was queued and no stamp was written. The audit row alone
 * cannot cover this — it is emitted only after prep, queue and stamp, and
 * `writeAuditEvent` is fire-and-forget, so its absence proves neither.
 */
const FAR_FUTURE = new Date('2099-01-01T00:00:00Z');

async function seedEnrollmentKey(orgId: string, label: string): Promise<string> {
  const [row] = await getTestDb()
    .insert(enrollmentKeys)
    .values({
      orgId,
      name: `key-${label}`,
      key: `k-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      expiresAt: FAR_FUTURE,
    })
    .returning({ id: enrollmentKeys.id });
  return row!.id;
}

async function keyStillUnexpired(keyId: string): Promise<boolean> {
  const [row] = await getTestDb()
    .select({ expiresAt: enrollmentKeys.expiresAt })
    .from(enrollmentKeys)
    .where(eq(enrollmentKeys.id, keyId));
  return row?.expiresAt?.getTime() === FAR_FUTURE.getTime();
}

async function repairAudits(orgId: string): Promise<number> {
  const rows = await getTestDb()
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.orgId, orgId),
        eq(auditLogs.action, 'organization.offboarding_entry_repaired')
      )
    );
  return rows.length;
}

async function pendingUninstalls(deviceId: string): Promise<number> {
  const rows = await getTestDb()
    .select({ id: deviceCommands.id })
    .from(deviceCommands)
    .where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.type, 'self_uninstall')));
  return rows.length;
}

describe('#4022 — repairIncompleteEntry rechecks the precondition under its lock', () => {
  runDb(
    'abandons an organization that was aborted back to active between snapshot and repair',
    async () => {
      const partner = await createPartner({ status: 'active' });
      const org = await createOrganization({ partnerId: partner.id, status: 'active' });
      const site = await createSite({ orgId: org.id });
      const orgId = org.id;
      const deviceId = await seedDevice(orgId, site.id, 'org-abort');
      const keyId = await seedEnrollmentKey(orgId, 'org-abort');

      await withSystemDbAccessContext(async () => {
        // The torn state the sweep looks for: offboarding, no drain stamp.
        await getTestDb()
          .update(organizations)
          .set({ status: 'offboarding', offboardingStartedAt: null })
          .where(eq(organizations.id, orgId));
      });

      // The sweep snapshots {id, startedAt: null} at this point; the repair
      // below is called with exactly that stale candidate.

      // The operator aborts. With a null stamp this is correctly a no-op on the
      // command rows — which is precisely why nothing downstream notices.
      await withSystemDbAccessContext(async () => {
        await getTestDb()
          .update(organizations)
          .set({ status: 'active' })
          .where(eq(organizations.id, orgId));
      });
      const abortResult = await abortOrganizationOffboarding(orgId);
      expect(abortResult.aborted).toBe(false);

      // The repair now runs against the rescued tenant.
      await withSystemDbAccessContext(() =>
        repairIncompleteEntry('organization', orgId, [orgId], new Date())
      );

      expect(await pendingUninstalls(deviceId)).toBe(0);
      // Not just "no rows": the repair must not have run its side effects at
      // all. prepareAgentDrainForOrgIds invalidates caches, expires enrollment
      // keys and can restore agent tokens, so a predicate placed AFTER it would
      // still satisfy a rows-only assertion.
      expect(await repairAudits(orgId)).toBe(0);
      // The real proof that drain prep never ran.
      expect(await keyStillUnexpired(keyId)).toBe(true);

      const [after] = await getTestDb()
        .select({ status: organizations.status, startedAt: organizations.offboardingStartedAt })
        .from(organizations)
        .where(eq(organizations.id, orgId));
      expect(after?.status).toBe('active');
      expect(after?.startedAt).toBeNull();
    }
  );

  runDb('still repairs an organization that is genuinely still torn', async () => {
    const partner = await createPartner({ status: 'active' });
    const org = await createOrganization({ partnerId: partner.id, status: 'active' });
    const site = await createSite({ orgId: org.id });
    const orgId = org.id;
    const deviceId = await seedDevice(orgId, site.id, 'org-torn');

    await withSystemDbAccessContext(async () => {
      await getTestDb()
        .update(organizations)
        .set({ status: 'offboarding', offboardingStartedAt: null })
        .where(eq(organizations.id, orgId));
    });

    // No abort this time: the precondition still holds under the lock.
    await withSystemDbAccessContext(() =>
      repairIncompleteEntry('organization', orgId, [orgId], new Date())
    );

    expect(await pendingUninstalls(deviceId)).toBeGreaterThan(0);

    const [after] = await getTestDb()
      .select({ startedAt: organizations.offboardingStartedAt })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    expect(after?.startedAt).not.toBeNull();
  });

  // Pins the STAMP half of the predicate. Without it, deleting
  // `offboardingStartedAt === null` from the check still passes every other test.
  runDb('abandons a tenant that is still offboarding but has already been stamped', async () => {
    const partner = await createPartner({ status: 'active' });
    const org = await createOrganization({ partnerId: partner.id, status: 'active' });
    const site = await createSite({ orgId: org.id });
    const orgId = org.id;
    const deviceId = await seedDevice(orgId, site.id, 'org-stamped');

    const alreadyStamped = new Date(Date.now() - 60_000);
    await withSystemDbAccessContext(async () => {
      await getTestDb()
        .update(organizations)
        .set({ status: 'offboarding', offboardingStartedAt: alreadyStamped })
        .where(eq(organizations.id, orgId));
    });

    // `offboarding` + a stamp is the completion marker: entry paths commit the
    // stamp and the queued commands together, so a stamped tenant has already
    // been handled. This fixture stamps the marker WITHOUT queueing, so it pins
    // the marker check itself rather than reproducing a completed repair.
    await withSystemDbAccessContext(() =>
      repairIncompleteEntry('organization', orgId, [orgId], new Date())
    );

    expect(await pendingUninstalls(deviceId)).toBe(0);
    expect(await repairAudits(orgId)).toBe(0);

    const [after] = await getTestDb()
      .select({ startedAt: organizations.offboardingStartedAt })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    expect(after?.startedAt?.getTime()).toBe(alreadyStamped.getTime());
  });

  // Partner POSITIVE control. Without it, making the partner branch an
  // unconditional no-op passes the partner abandon test.
  runDb('still repairs a partner that is genuinely still torn', async () => {
    const partner = await createPartner({ status: 'active' });
    const org = await createOrganization({ partnerId: partner.id, status: 'active' });
    const site = await createSite({ orgId: org.id });
    const deviceId = await seedDevice(org.id, site.id, 'partner-torn');

    await withSystemDbAccessContext(async () => {
      await getTestDb()
        .update(partners)
        .set({ status: 'offboarding', offboardingStartedAt: null })
        .where(eq(partners.id, partner.id));
    });

    await withSystemDbAccessContext(() =>
      repairIncompleteEntry('partner', partner.id, [org.id], new Date())
    );

    expect(await pendingUninstalls(deviceId)).toBeGreaterThan(0);

    const [after] = await getTestDb()
      .select({ startedAt: partners.offboardingStartedAt })
      .from(partners)
      .where(eq(partners.id, partner.id));
    expect(after?.startedAt).not.toBeNull();
  });

  // Pins the stamp conjunct on the PARTNER branch specifically. Removing it
  // from the org branch alone is caught by the org case above; removing it from
  // the partner branch alone was not caught by anything until this existed.
  runDb('abandons a partner that is still offboarding but has already been stamped', async () => {
    const partner = await createPartner({ status: 'active' });
    const org = await createOrganization({ partnerId: partner.id, status: 'active' });
    const site = await createSite({ orgId: org.id });
    const deviceId = await seedDevice(org.id, site.id, 'partner-stamped');
    const keyId = await seedEnrollmentKey(org.id, 'partner-stamped');

    const alreadyStamped = new Date(Date.now() - 60_000);
    await withSystemDbAccessContext(async () => {
      await getTestDb()
        .update(partners)
        .set({ status: 'offboarding', offboardingStartedAt: alreadyStamped })
        .where(eq(partners.id, partner.id));
    });

    await withSystemDbAccessContext(() =>
      repairIncompleteEntry('partner', partner.id, [org.id], new Date())
    );

    expect(await pendingUninstalls(deviceId)).toBe(0);
    expect(await keyStillUnexpired(keyId)).toBe(true);

    const [after] = await getTestDb()
      .select({ startedAt: partners.offboardingStartedAt })
      .from(partners)
      .where(eq(partners.id, partner.id));
    expect(after?.startedAt?.getTime()).toBe(alreadyStamped.getTime());
  });

  runDb('abandons a partner that was aborted back to active between snapshot and repair', async () => {
    const partner = await createPartner({ status: 'active' });
    const org = await createOrganization({ partnerId: partner.id, status: 'active' });
    const site = await createSite({ orgId: org.id });
    const partnerId = partner.id;
    const orgId = org.id;
    const deviceId = await seedDevice(orgId, site.id, 'partner-abort');

    await withSystemDbAccessContext(async () => {
      await getTestDb()
        .update(partners)
        .set({ status: 'offboarding', offboardingStartedAt: null })
        .where(eq(partners.id, partnerId));
    });

    await withSystemDbAccessContext(async () => {
      await getTestDb()
        .update(partners)
        .set({ status: 'active' })
        .where(eq(partners.id, partnerId));
    });

    await withSystemDbAccessContext(() =>
      repairIncompleteEntry('partner', partnerId, [orgId], new Date())
    );

    expect(await pendingUninstalls(deviceId)).toBe(0);

    const [after] = await getTestDb()
      .select({ startedAt: partners.offboardingStartedAt })
      .from(partners)
      .where(eq(partners.id, partnerId));
    expect(after?.startedAt).toBeNull();
  });
});
