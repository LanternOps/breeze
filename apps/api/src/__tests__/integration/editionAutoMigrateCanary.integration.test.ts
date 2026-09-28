/**
 * #5016 — real-Postgres proof of the two predicates that bound an automatic
 * agent edition migration gone wrong:
 *
 *  1. findUnresolvedOrgEditionMigration (the per-org canary): which sibling
 *     devices still hold an org. The mocked unit suite can only prove the gate
 *     acts on the lookup's answer; whether `last_seen_at < dispatched + '2 hours'
 *     ::interval`, the edition clause and the org/status scoping mean what they
 *     say needs a real planner, real timestamp arithmetic and real NULLs.
 *  2. processReapUninstallIntent's migration exclusion: an uninstall intent the
 *     migration's own `msiexec /x` stamped must not be auto-decommissioned.
 */
import './setup';
import { randomUUID } from 'crypto';
import { describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { createPartner, createOrganization, createSite } from './db-utils';
import { findUnresolvedOrgEditionMigration } from '../../services/agentEditionAutoMigrate';
import { processReapUninstallIntent } from '../../jobs/offlineDetector';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const MIN = 60_000;
const HOUR = 60 * MIN;

type DeviceOverrides = Partial<typeof devices.$inferInsert>;

async function makeDevice(orgId: string, siteId: string, over: DeviceOverrides = {}) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `edition-canary-${randomUUID()}`,
        hostname: `edition-canary-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: '0.105.1',
        status: 'online',
        enrolledAt: new Date(),
        ...over,
      })
      .returning({ id: devices.id });
    if (!row) throw new Error('device fixture insert failed');
    return row.id;
  });
}

async function fixtureOrg() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  return { orgId: org.id, siteId: site.id };
}

function lookup(orgId: string, excludeDeviceId: string) {
  return withSystemDbAccessContext(() =>
    findUnresolvedOrgEditionMigration({ orgId, excludeDeviceId, targetEdition: 'hosted' }),
  );
}

describe('edition auto-migrate per-org canary (#5016) — real Postgres', () => {
  runDb('a dispatched device that went silent holds its org, and only its org', async () => {
    const { orgId, siteId } = await fixtureOrg();
    const other = await fixtureOrg();
    const dispatchedAt = new Date(Date.now() - 30 * MIN);
    const canary = await makeDevice(orgId, siteId, {
      editionMigrationDispatchedAt: dispatchedAt,
      // Last beat was the one that triggered the dispatch; silent since.
      lastSeenAt: new Date(dispatchedAt.getTime() - MIN),
      agentEdition: 'self-host',
      status: 'offline',
    });
    const next = await makeDevice(orgId, siteId);
    const elsewhere = await makeDevice(other.orgId, other.siteId);

    const held = await lookup(orgId, next);
    expect(held?.id).toBe(canary);
    // The canary never holds itself.
    expect(await lookup(orgId, canary)).toBeNull();
    // Another org is untouched by this org's canary.
    expect(await lookup(other.orgId, elsewhere)).toBeNull();
  });

  runDb('a silent canary with NULL last_seen_at / NULL edition still holds', async () => {
    const { orgId, siteId } = await fixtureOrg();
    const canary = await makeDevice(orgId, siteId, {
      editionMigrationDispatchedAt: new Date(Date.now() - 5 * HOUR),
      lastSeenAt: null,
      agentEdition: null,
    });
    const next = await makeDevice(orgId, siteId);
    expect((await lookup(orgId, next))?.id).toBe(canary);
  });

  runDb('the old agent heartbeating mid-dance (inside the settle window) still holds', async () => {
    const { orgId, siteId } = await fixtureOrg();
    const dispatchedAt = new Date(Date.now() - 20 * MIN);
    const canary = await makeDevice(orgId, siteId, {
      editionMigrationDispatchedAt: dispatchedAt,
      lastSeenAt: new Date(dispatchedAt.getTime() + 10 * MIN),
      agentEdition: 'self-host',
    });
    const next = await makeDevice(orgId, siteId);
    expect((await lookup(orgId, next))?.id).toBe(canary);
  });

  runDb('a canary back on the target edition releases the org', async () => {
    const { orgId, siteId } = await fixtureOrg();
    const dispatchedAt = new Date(Date.now() - 20 * MIN);
    await makeDevice(orgId, siteId, {
      editionMigrationDispatchedAt: dispatchedAt,
      lastSeenAt: new Date(dispatchedAt.getTime() + 8 * MIN),
      agentEdition: 'hosted',
    });
    const next = await makeDevice(orgId, siteId);
    expect(await lookup(orgId, next)).toBeNull();
  });

  runDb('a canary still on its old edition well past the settle window survived the attempt and releases the org', async () => {
    const { orgId, siteId } = await fixtureOrg();
    const dispatchedAt = new Date(Date.now() - 5 * HOUR);
    await makeDevice(orgId, siteId, {
      editionMigrationDispatchedAt: dispatchedAt,
      lastSeenAt: new Date(dispatchedAt.getTime() + 3 * HOUR),
      agentEdition: 'self-host',
    });
    const next = await makeDevice(orgId, siteId);
    expect(await lookup(orgId, next)).toBeNull();
  });

  runDb('the settle window does not depend on the session time zone', async () => {
    // last_seen_at is `timestamp` (UTC wall clock) and the dispatch stamp is
    // `timestamptz`: comparing them raw casts through the session TimeZone.
    const { orgId, siteId } = await fixtureOrg();
    const dispatchedAt = new Date(Date.now() - 5 * HOUR);
    await makeDevice(orgId, siteId, {
      editionMigrationDispatchedAt: dispatchedAt,
      // Survived: seen 3h after dispatch, past the 2h window.
      lastSeenAt: new Date(dispatchedAt.getTime() + 3 * HOUR),
      agentEdition: 'self-host',
    });
    const next = await makeDevice(orgId, siteId);
    const inZone = (tz: string) =>
      withSystemDbAccessContext(async () => {
        await db.execute(sql`SELECT set_config('TimeZone', ${tz}, true)`);
        return findUnresolvedOrgEditionMigration({ orgId, excludeDeviceId: next, targetEdition: 'hosted' });
      });
    // Five hours west of UTC would shift a naive cast by -5h and re-hold the org.
    expect(await inZone('America/New_York')).toBeNull();
    expect(await inZone('Asia/Tokyo')).toBeNull();
  });

  runDb('a removed (decommissioned) canary releases the org', async () => {
    const { orgId, siteId } = await fixtureOrg();
    await makeDevice(orgId, siteId, {
      editionMigrationDispatchedAt: new Date(Date.now() - HOUR),
      lastSeenAt: new Date(Date.now() - 2 * HOUR),
      status: 'decommissioned',
    });
    const next = await makeDevice(orgId, siteId);
    expect(await lookup(orgId, next)).toBeNull();
  });
});

describe('uninstall-intent reaper vs edition migration (#5016) — real Postgres', () => {
  runDb('never reaps an intent stamped by the migration, still reaps a real one', async () => {
    const { orgId, siteId } = await fixtureOrg();
    const dispatchedAt = new Date(Date.now() - 3 * 24 * HOUR);

    // Migration dispatched, its msiexec /x stamped the intent 5 min later, the
    // reinstall never came back. Must stay (offline, visible, recoverable).
    const failedMigration = await makeDevice(orgId, siteId, {
      editionMigrationDispatchedAt: dispatchedAt,
      uninstallIntentAt: new Date(dispatchedAt.getTime() + 5 * MIN),
      lastSeenAt: new Date(dispatchedAt.getTime() - MIN),
      status: 'offline',
    });
    // Plain uninstall, no migration: reaped as before.
    const plainUninstall = await makeDevice(orgId, siteId, {
      uninstallIntentAt: new Date(dispatchedAt.getTime() + 5 * MIN),
      lastSeenAt: new Date(dispatchedAt.getTime() - MIN),
      status: 'offline',
    });
    // Migrated long ago, genuinely uninstalled much later: reaped as before.
    const laterUninstall = await makeDevice(orgId, siteId, {
      editionMigrationDispatchedAt: new Date(dispatchedAt.getTime() - 30 * 24 * HOUR),
      uninstallIntentAt: new Date(dispatchedAt.getTime() + 5 * MIN),
      lastSeenAt: new Date(dispatchedAt.getTime() - MIN),
      status: 'offline',
    });

    await withSystemDbAccessContext(() => processReapUninstallIntent());

    const statusOf = (id: string) =>
      withSystemDbAccessContext(async () => {
        const [row] = await db.select({ status: devices.status }).from(devices).where(eq(devices.id, id));
        return row?.status;
      });
    expect(await statusOf(failedMigration)).toBe('offline');
    expect(await statusOf(plainUninstall)).toBe('decommissioned');
    expect(await statusOf(laterUninstall)).toBe('decommissioned');
  });
});
