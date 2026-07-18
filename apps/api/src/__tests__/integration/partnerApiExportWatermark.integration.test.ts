import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db as appDb, withDbAccessContext } from '../../db';
import {
  deviceGroupMemberships,
  deviceGroups,
  deviceHardware,
  devices,
  organizations,
  sites,
} from '../../db/schema';
import { partnerDeviceRoutes } from '../../routes/partnerApi/devices';
import { partnerOrganizationRoutes } from '../../routes/partnerApi/organizations';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MIGRATION_FILE = join(__dirname, '../../../migrations/2026-07-18-partner-export-org-locks.sql');
const COMPLETION_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-19-partner-export-consistency-completion.sql',
);
const CANONICAL_MUTATION_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-21-partner-export-canonical-org-mutations.sql',
);
const LOCK_HARDENING_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-22-partner-export-lock-upgrade-hardening.sql',
);
const LOCK_KEY_COLLISION_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-22-z-partner-export-lock-key-collision-hardening.sql',
);
const STALE_TIMESTAMP = new Date('2000-01-01T00:00:00.000Z');

type ChangeKind = 'membership' | 'device' | 'hardware' | 'site' | 'organization';

describe('partner export transaction watermark serialization', () => {
  runDb('migration is idempotent and documents its lock namespace and order', async () => {
    const migration = readFileSync(MIGRATION_FILE, 'utf8');
    const completionMigration = readFileSync(COMPLETION_MIGRATION_FILE, 'utf8');
    const canonicalMutationMigration = readFileSync(CANONICAL_MUTATION_MIGRATION_FILE, 'utf8');
    const lockHardeningMigration = readFileSync(LOCK_HARDENING_MIGRATION_FILE, 'utf8');
    const lockKeyCollisionMigration = readFileSync(LOCK_KEY_COLLISION_MIGRATION_FILE, 'utf8');
    const db = getTestDb();
    await expect(db.execute(sql.raw(migration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(completionMigration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(canonicalMutationMigration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(canonicalMutationMigration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(lockHardeningMigration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(lockHardeningMigration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(lockKeyCollisionMigration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(lockKeyCollisionMigration))).resolves.toBeDefined();
    expect(migration).toMatch(/1000201/);
    expect(migration).toMatch(/ORDER BY org_id/);
    expect(migration).toMatch(/pg_advisory_xact_lock_shared/);
    expect(completionMigration).toMatch(/REFERENCING OLD TABLE AS old_rows/);
    expect(completionMigration).toMatch(/breeze_partner_export_hardware_delete/);
    expect(canonicalMutationMigration).toMatch(/exclusive_partner_locks/);
    expect(lockHardeningMigration).toMatch(/shared partner locks cannot be upgraded to exclusive/);
    expect(lockHardeningMigration).toMatch(/REVOKE ALL ON FUNCTION/);
    expect(lockKeyCollisionMigration).toMatch(/partner_export_partner_lock_keys/);
  });

  runDb.each<ChangeKind>(['membership', 'device', 'hardware', 'site', 'organization'])(
    'an open %s change is visible in the current or immediately following traversal',
    async (kind) => {
      const fixture = await seedFixture();
      const baseline = await sourceUpdatedAt(kind, fixture);
      const writer = await startHeldWriter(fixture, kind);
      const app = exportApp(fixture);
      const resource = kind === 'organization' ? 'organizations' : kind === 'site' ? 'sites' : 'devices';
      const expectedId = kind === 'organization' ? fixture.org.id : kind === 'site' ? fixture.site.id : fixture.device.id;
      const firstRequest = Promise.resolve(app.request(
        `/${resource}?updatedSince=${encodeURIComponent(baseline.toISOString())}`,
      ));
      let settledBeforeCommit = false;
      void firstRequest.finally(() => { settledBeforeCommit = true; });

      await delay(100);
      const racedPastOpenWriter = settledBeforeCommit;
      writer.release();
      const firstResponse = await firstRequest;
      await writer.done;
      expect(firstResponse.status).toBe(200);
      const first = await firstResponse.json() as ExportEnvelope;
      const followingResponse = await app.request(
        `/${resource}?updatedSince=${encodeURIComponent(first.snapshotAt)}`,
      );
      expect(followingResponse.status).toBe(200);
      const following = await followingResponse.json() as ExportEnvelope;

      expect(racedPastOpenWriter).toBe(false);
      expect([...first.data, ...following.data].map((record) => record.id)).toContain(expectedId);
    },
    15_000,
  );

  runDb('canonicalizes complete sets, permits organization cleanup, and rejects unknown descending keys', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const [low, high] = [orgA, orgB].sort((left, right) => left.id.localeCompare(right.id));
    const firstAcquired = deferred<void>();
    const releaseFirst = deferred<void>();
    const first = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT public.breeze_partner_export_lock_orgs_exclusive(
        ARRAY[${high.id}::uuid, ${low.id}::uuid]
      )`);
      firstAcquired.resolve();
      await releaseFirst.promise;
    });
    await firstAcquired.promise;
    const second = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT public.breeze_partner_export_lock_orgs_exclusive(
        ARRAY[${low.id}::uuid, ${high.id}::uuid]
      )`);
    });
    await delay(75);
    releaseFirst.resolve();
    await expect(Promise.all([first, second])).resolves.toBeDefined();

    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`SELECT public.breeze_partner_export_lock_orgs_exclusive(
        ARRAY[${high.id}::uuid]
      )`);
      await tx.execute(sql`SELECT public.breeze_partner_export_lock_orgs_exclusive(
        ARRAY[${low.id}::uuid]
      )`);
    })).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'P0001' }) });

    await expect(db.transaction(async (tx) => {
      await tx.update(organizations).set({ name: 'Updated high org' })
        .where(eq(organizations.id, high.id));
      await tx.update(organizations).set({ name: 'Updated low org' })
        .where(eq(organizations.id, low.id));
    })).resolves.toBeUndefined();

    await expect(db.transaction(async (tx) => {
      await tx.delete(organizations).where(eq(organizations.id, high.id));
      await tx.delete(organizations).where(eq(organizations.id, low.id));
    })).resolves.toBeUndefined();
  }, 10_000);

  runDb('lock hierarchy rejects partner acquisition after an organization lock', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`SELECT public.breeze_partner_export_lock_orgs_exclusive(
        ARRAY[${org.id}::uuid]
      )`);
      await tx.execute(sql`SELECT public.breeze_partner_export_lock_partners_exclusive(
        ARRAY[${partner.id}::uuid]
      )`);
    })).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'P0001' }) });
  });

  runDb('concurrent shared partner holders reject exclusive lock upgrades without deadlocking', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const firstShared = deferred<void>();
    const secondShared = deferred<void>();
    const attemptUpgrade = deferred<void>();

    const first = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT public.breeze_partner_export_lock_partners_shared(
        ARRAY[${partner.id}::uuid]
      )`);
      firstShared.resolve();
      await attemptUpgrade.promise;
      await tx.execute(sql`SELECT public.breeze_partner_export_lock_partners_exclusive(
        ARRAY[${partner.id}::uuid]
      )`);
    });
    const second = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT public.breeze_partner_export_lock_partners_shared(
        ARRAY[${partner.id}::uuid]
      )`);
      secondShared.resolve();
      await attemptUpgrade.promise;
      await tx.execute(sql`SELECT public.breeze_partner_export_lock_partners_exclusive(
        ARRAY[${partner.id}::uuid]
      )`);
    });

    await Promise.all([firstShared.promise, secondShared.promise]);
    attemptUpgrade.resolve();
    const results = await Promise.allSettled([first, second]);
    expect(results).toEqual([
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ cause: expect.objectContaining({ code: 'P0001' }) }),
      }),
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ cause: expect.objectContaining({ code: 'P0001' }) }),
      }),
    ]);
  }, 10_000);

  runDb('colliding partner UUIDs reject shared-key to exclusive-key upgrades without deadlocking', async () => {
    const db = getTestDb();
    // Verified hashtext collision on the PostgreSQL 16 runtime used by the
    // integration suite. Advisory-lock ownership must be tracked by this
    // physical key, not only by the logical UUID.
    const sharedPartnerId = '54287acf-3cc2-43c7-a19c-73f3e7f03d16';
    const collidingPartnerId = '5815dab9-7e09-471b-a11e-6d851f641774';
    const [hashes] = await db.execute<{ first: number; second: number }>(sql`
      SELECT hashtext(${sharedPartnerId}) AS first, hashtext(${collidingPartnerId}) AS second
    `);
    expect(hashes?.first).toBe(1887689276);
    expect(hashes?.second).toBe(hashes?.first);

    const firstShared = deferred<void>();
    const secondShared = deferred<void>();
    const attemptUpgrade = deferred<void>();
    const contender = (entered: ReturnType<typeof deferred<void>>) => db.transaction(async (tx) => {
      await tx.execute(sql`SELECT public.breeze_partner_export_lock_partners_shared(
        ARRAY[${sharedPartnerId}::uuid]
      )`);
      entered.resolve();
      await attemptUpgrade.promise;
      await tx.execute(sql`SELECT public.breeze_partner_export_lock_partners_exclusive(
        ARRAY[${collidingPartnerId}::uuid]
      )`);
    });
    const first = contender(firstShared);
    const second = contender(secondShared);
    await Promise.all([firstShared.promise, secondShared.promise]);
    attemptUpgrade.resolve();

    const results = await Promise.allSettled([first, second]);
    for (const result of results) {
      expect(result).toEqual(expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ cause: expect.objectContaining({ code: 'P0001' }) }),
      }));
    }
  }, 10_000);

  runDb('specialized organization locking rejects a caller-supplied unrelated partner', async () => {
    const db = getTestDb();
    const lockedPartner = await createPartner();
    const actualPartner = await createPartner();
    const actualOrg = await createOrganization({ partnerId: actualPartner.id });

    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`SELECT public.breeze_partner_export_lock_partners_exclusive(
        ARRAY[${lockedPartner.id}::uuid]
      )`);
      await tx.execute(sql`SELECT public.breeze_partner_export_lock_orgs_under_exclusive_partners(
        ARRAY[${actualOrg.id}::uuid],
        ARRAY[${lockedPartner.id}::uuid, NULL]
      )`);
    })).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'P0001' }) });
  });

  runDb('private mutation lock helpers are not executable by breeze_app', async () => {
    const rows = await getTestDb().execute(sql`
      SELECT
        has_function_privilege(
          'breeze_app',
          'public.breeze_partner_export_lock_partners_exclusive(uuid[])',
          'EXECUTE'
        ) AS "canLockPartnersExclusive",
        has_function_privilege(
          'breeze_app',
          'public.breeze_partner_export_lock_orgs_under_exclusive_partners(uuid[],uuid[])',
          'EXECUTE'
        ) AS "canLockOrgsUnderExclusivePartners"
    `) as unknown as Array<{
      canLockPartnersExclusive: boolean;
      canLockOrgsUnderExclusivePartners: boolean;
    }>;
    expect(rows[0]).toEqual({
      canLockPartnersExclusive: false,
      canLockOrgsUnderExclusivePartners: false,
    });
  });

  runDb('general organization locking rejects inaccessible organization IDs before locking them', async () => {
    const accessiblePartner = await createPartner();
    const accessibleOrg = await createOrganization({ partnerId: accessiblePartner.id });
    const inaccessiblePartner = await createPartner();
    const inaccessibleOrg = await createOrganization({ partnerId: inaccessiblePartner.id });

    await expect(withDbAccessContext(
      partnerContext(accessiblePartner.id, accessibleOrg.id),
      () => appDb.execute(sql`SELECT public.breeze_partner_export_lock_orgs_exclusive(
        ARRAY[${inaccessibleOrg.id}::uuid]
      )`),
    )).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'P0001' }) });
  });

  runDb('volatile device telemetry does not advance the material export watermark', async () => {
    const fixture = await seedFixture();
    const db = getTestDb();
    const before = await sourceUpdatedAt('device', fixture);
    await db.update(devices).set({
      status: 'online',
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(devices.id, fixture.device.id));
    expect((await sourceUpdatedAt('device', fixture)).getTime()).toBe(before.getTime());
  });

  runDb('database-owned material watermarks cannot be directly regressed', async () => {
    const fixture = await seedFixture();
    const context = partnerContext(fixture.partner.id, fixture.org.id);
    await withDbAccessContext(context, () => appDb.insert(deviceHardware).values({
      deviceId: fixture.device.id,
      orgId: fixture.org.id,
      serialNumber: 'protected-serial',
    }));
    const db = getTestDb();
    const [beforeOrg] = await db.select({ value: organizations.partnerExportUpdatedAt })
      .from(organizations).where(eq(organizations.id, fixture.org.id));
    const [beforeSite] = await db.select({ value: sites.partnerExportUpdatedAt })
      .from(sites).where(eq(sites.id, fixture.site.id));
    const [beforeDevice] = await db.select({ value: devices.partnerExportUpdatedAt })
      .from(devices).where(eq(devices.id, fixture.device.id));
    const [beforeHardware] = await db.select({ value: deviceHardware.partnerExportUpdatedAt })
      .from(deviceHardware).where(eq(deviceHardware.deviceId, fixture.device.id));
    if (!beforeOrg || !beforeSite || !beforeDevice || !beforeHardware) throw new Error('watermark baseline missing');

    await withDbAccessContext(context, async () => {
      await appDb.update(organizations).set({ partnerExportUpdatedAt: STALE_TIMESTAMP })
        .where(eq(organizations.id, fixture.org.id));
      await appDb.update(sites).set({ partnerExportUpdatedAt: STALE_TIMESTAMP })
        .where(eq(sites.id, fixture.site.id));
      await appDb.update(devices).set({ partnerExportUpdatedAt: STALE_TIMESTAMP })
        .where(eq(devices.id, fixture.device.id));
      await appDb.update(deviceHardware).set({ partnerExportUpdatedAt: STALE_TIMESTAMP })
        .where(eq(deviceHardware.deviceId, fixture.device.id));
    });

    const [afterOrg] = await db.select({ value: organizations.partnerExportUpdatedAt })
      .from(organizations).where(eq(organizations.id, fixture.org.id));
    const [afterSite] = await db.select({ value: sites.partnerExportUpdatedAt })
      .from(sites).where(eq(sites.id, fixture.site.id));
    const [afterDevice] = await db.select({ value: devices.partnerExportUpdatedAt })
      .from(devices).where(eq(devices.id, fixture.device.id));
    const [afterHardware] = await db.select({ value: deviceHardware.partnerExportUpdatedAt })
      .from(deviceHardware).where(eq(deviceHardware.deviceId, fixture.device.id));
    expect(afterOrg?.value.getTime()).toBe(beforeOrg.value.getTime());
    expect(afterSite?.value.getTime()).toBe(beforeSite.value.getTime());
    expect(afterDevice?.value.getTime()).toBe(beforeDevice.value.getTime());
    expect(afterHardware?.value.getTime()).toBe(beforeHardware.value.getTime());
  });

  runDb('hardware deletion advances the parent device and re-emits null hardware identity', async () => {
    const fixture = await seedFixture();
    const context = partnerContext(fixture.partner.id, fixture.org.id);
    await withDbAccessContext(context, () => appDb.insert(deviceHardware).values({
      deviceId: fixture.device.id,
      orgId: fixture.org.id,
      serialNumber: 'delete-me',
      manufacturer: 'Breeze Test',
      model: 'Transient Hardware',
    }));
    const baseline = await sourceUpdatedAt('hardware', fixture);
    await withDbAccessContext(context, () => appDb.delete(deviceHardware)
      .where(eq(deviceHardware.deviceId, fixture.device.id)));

    const response = await exportApp(fixture).request(
      `/devices?updatedSince=${encodeURIComponent(baseline.toISOString())}`,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as ExportEnvelope;
    expect(body.data).toContainEqual(expect.objectContaining({
      id: fixture.device.id,
      hardwareIdentity: { serialNumber: null, manufacturer: null, model: null },
    }));
  });

  runDb('an open hard organization delete serializes partner export readers', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const context = partnerContext(partner.id, org.id);
    const started = deferred<void>();
    const release = deferred<void>();
    const deleteDone = withDbAccessContext(context, async () => {
      await appDb.delete(organizations).where(eq(organizations.id, org.id));
      started.resolve();
      await release.promise;
    });
    await started.promise;

    const request = Promise.resolve(exportAppFor(partner.id, [org.id]).request('/organizations'));
    let settled = false;
    void request.finally(() => { settled = true; });
    await delay(100);
    const racedPastDelete = settled;
    release.resolve();
    const response = await request;
    await deleteDone;
    expect(racedPastDelete).toBe(false);
    expect(response.status).toBe(200);
  }, 15_000);

  runDb('tenantCascade hard deletion waits for an in-flight export reader', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const org = await createOrganization({ partnerId: partner.id });
    const entered = deferred<void>();
    const release = deferred<void>();
    const reader = withDbAccessContext(partnerContext(partner.id, org.id), async () => {
      await appDb.execute(sql`SELECT public.breeze_partner_export_lock_partners_shared(
        ARRAY[${partner.id}::uuid]
      )`);
      await appDb.execute(sql`SELECT public.breeze_partner_export_lock_orgs_shared_snapshot(
        ARRAY[${org.id}::uuid]
      )`);
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const cascade = cascadeDeleteOrg(org.id, user.id);
    await waitForAdvisoryWaiter();
    release.resolve();
    await reader;
    const stats = await cascade;
    expect(stats.tablesDeleted.organizations).toBe(1);
    const remaining = await getTestDb().select({ id: organizations.id })
      .from(organizations).where(eq(organizations.id, org.id));
    expect(remaining).toEqual([]);
  }, 20_000);

  runDb('a device and hardware can reacquire the same sorted org locks during one move transaction', async () => {
    const fixture = await seedFixture();
    const targetOrg = await createOrganization({ partnerId: fixture.partner.id });
    const targetSite = await createSite({ orgId: targetOrg.id });
    await getTestDb().insert(deviceHardware).values({
      deviceId: fixture.device.id,
      orgId: fixture.org.id,
      serialNumber: 'move-me',
    });
    const context = {
      ...partnerContext(fixture.partner.id, fixture.org.id),
      accessibleOrgIds: [fixture.org.id, targetOrg.id],
    };
    await expect(withDbAccessContext(context, async () => {
      await appDb.update(devices).set({ orgId: targetOrg.id, siteId: targetSite.id })
        .where(eq(devices.id, fixture.device.id));
      await appDb.update(deviceHardware).set({ orgId: targetOrg.id })
        .where(eq(deviceHardware.deviceId, fixture.device.id));
    })).resolves.toBeUndefined();
    const [moved] = await getTestDb().select({ deviceOrgId: devices.orgId, hardwareOrgId: deviceHardware.orgId })
      .from(devices)
      .innerJoin(deviceHardware, eq(deviceHardware.deviceId, devices.id))
      .where(eq(devices.id, fixture.device.id));
    expect(moved).toEqual({ deviceOrgId: targetOrg.id, hardwareOrgId: targetOrg.id });
  });
});

interface Fixture {
  partner: { id: string };
  org: { id: string };
  site: { id: string };
  device: { id: string };
  group: { id: string };
}

interface ExportEnvelope {
  snapshotAt: string;
  data: Array<{
    id: string;
    hardwareIdentity?: { serialNumber: string | null; manufacturer: string | null; model: string | null };
  }>;
}

async function seedFixture(): Promise<Fixture> {
  const db = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const [device] = await db.insert(devices).values({
    orgId: org.id,
    siteId: site.id,
    agentId: `export-watermark-${crypto.randomUUID()}`.slice(0, 64),
    hostname: 'watermark-device',
    osType: 'linux',
    osVersion: '1',
    architecture: 'amd64',
    agentVersion: '1',
  }).returning();
  const [group] = await db.insert(deviceGroups).values({
    orgId: org.id,
    siteId: site.id,
    name: 'Watermark group',
  }).returning();
  if (!device || !group) throw new Error('watermark fixture insert failed');
  return { partner, org, site, device, group };
}

async function sourceUpdatedAt(kind: ChangeKind, fixture: Fixture): Promise<Date> {
  const db = getTestDb();
  if (kind === 'organization') {
    const [row] = await db.select({ updatedAt: organizations.partnerExportUpdatedAt })
      .from(organizations).where(eq(organizations.id, fixture.org.id));
    if (!row) throw new Error('organization watermark missing');
    return row.updatedAt;
  }
  if (kind === 'site') {
    const [row] = await db.select({ updatedAt: sites.partnerExportUpdatedAt })
      .from(sites).where(eq(sites.id, fixture.site.id));
    if (!row) throw new Error('site watermark missing');
    return row.updatedAt;
  }
  const [row] = await db.select({
    deviceUpdatedAt: devices.partnerExportUpdatedAt,
    hardwareUpdatedAt: deviceHardware.partnerExportUpdatedAt,
  }).from(devices)
    .leftJoin(deviceHardware, and(
      eq(deviceHardware.deviceId, devices.id),
      eq(deviceHardware.orgId, devices.orgId),
    ))
    .where(eq(devices.id, fixture.device.id));
  if (!row) throw new Error('device watermark missing');
  return row.hardwareUpdatedAt && row.hardwareUpdatedAt > row.deviceUpdatedAt
    ? row.hardwareUpdatedAt
    : row.deviceUpdatedAt;
}

async function startHeldWriter(fixture: Fixture, kind: ChangeKind) {
  const started = deferred<void>();
  const release = deferred<void>();
  const context = partnerContext(fixture.partner.id, fixture.org.id);
  const done = withDbAccessContext(context, async () => {
    await applyChange(kind, fixture);
    started.resolve();
    await release.promise;
  }).catch((error) => {
    started.reject(error);
    throw error;
  });
  await started.promise;
  return { done, release: () => release.resolve() };
}

async function applyChange(kind: ChangeKind, fixture: Fixture): Promise<void> {
  if (kind === 'membership') {
    await appDb.insert(deviceGroupMemberships).values({
      deviceId: fixture.device.id,
      groupId: fixture.group.id,
      orgId: fixture.org.id,
    });
    return;
  }
  if (kind === 'device') {
    await appDb.update(devices).set({
      displayName: 'committed device name',
      updatedAt: STALE_TIMESTAMP,
      partnerExportUpdatedAt: STALE_TIMESTAMP,
    })
      .where(eq(devices.id, fixture.device.id));
    return;
  }
  if (kind === 'hardware') {
    await appDb.insert(deviceHardware).values({
      deviceId: fixture.device.id,
      orgId: fixture.org.id,
      serialNumber: 'committed-serial',
      updatedAt: STALE_TIMESTAMP,
      partnerExportUpdatedAt: STALE_TIMESTAMP,
    });
    return;
  }
  if (kind === 'site') {
    await appDb.update(sites).set({
      name: 'Committed site',
      updatedAt: STALE_TIMESTAMP,
      partnerExportUpdatedAt: STALE_TIMESTAMP,
    })
      .where(eq(sites.id, fixture.site.id));
    return;
  }
  await appDb.update(organizations).set({
    name: 'Committed organization',
    updatedAt: STALE_TIMESTAMP,
    partnerExportUpdatedAt: STALE_TIMESTAMP,
  })
    .where(eq(organizations.id, fixture.org.id));
}

function exportApp(fixture: Fixture): Hono {
  return exportAppFor(fixture.partner.id, [fixture.org.id]);
}

function exportAppFor(partnerId: string, orgIds: string[]): Hono {
  const context = {
    ...partnerContext(partnerId, orgIds[0] ?? crypto.randomUUID()),
    accessibleOrgIds: orgIds,
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('partnerApiPrincipal', {
      partnerServicePrincipalId: crypto.randomUUID(),
      keyId: crypto.randomUUID(),
      partnerId,
      name: 'Watermark integration test',
      scopes: ['organizations:read', 'sites:read', 'devices:read'],
      accessibleOrgIds: orgIds,
      rateLimit: 600,
    });
    await withDbAccessContext(context, async () => {
      await appDb.execute(sql`SELECT public.breeze_partner_export_lock_partners_shared(
        ARRAY[${partnerId}::uuid]
      )`);
      await next();
    });
  });
  app.route('/', partnerOrganizationRoutes);
  app.route('/', partnerDeviceRoutes);
  return app;
}

function partnerContext(partnerId: string, orgId: string) {
  return {
    scope: 'partner' as const,
    orgId: null,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [partnerId],
    currentPartnerId: partnerId,
    userId: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAdvisoryWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await getTestDb().execute(sql`
      SELECT 1
        FROM pg_catalog.pg_locks
       WHERE locktype = 'advisory'
         AND classid = 1000202
         AND NOT granted
       LIMIT 1
    `);
    if (rows.length > 0) return;
    await delay(25);
  }
  throw new Error('tenant cascade never waited on the partner export advisory lock');
}
