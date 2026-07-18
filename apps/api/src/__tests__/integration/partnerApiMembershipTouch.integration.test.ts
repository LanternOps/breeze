import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq, gt, sql } from 'drizzle-orm';
import { db as appDb, withDbAccessContext } from '../../db';
import { deviceGroupMemberships, deviceGroups, devices } from '../../db/schema';
import { partnerDeviceRoutes } from '../../routes/partnerApi/devices';
import { deviceExportEnvelopeSchema } from '../../routes/partnerApi/schemas';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MEMBERSHIP_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-17-device-group-membership-touch.sql',
);
const WATERMARK_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-18-partner-export-org-locks.sql',
);
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

async function seedDeviceAndGroup() {
  const db = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const baseline = new Date('2026-07-13T12:00:00.000Z');
  const [device, destinationDevice] = await db.insert(devices).values([{
    orgId: org.id,
    siteId: site.id,
    agentId: `membership-touch-${crypto.randomUUID()}`.slice(0, 64),
    hostname: 'membership-touch-device',
    osType: 'linux',
    osVersion: '1',
    architecture: 'amd64',
    agentVersion: '1',
    updatedAt: baseline,
  }, {
    orgId: org.id,
    siteId: site.id,
    agentId: `membership-touch-destination-${crypto.randomUUID()}`.slice(0, 64),
    hostname: 'membership-touch-destination',
    osType: 'linux',
    osVersion: '1',
    architecture: 'amd64',
    agentVersion: '1',
    updatedAt: baseline,
  }]).returning();
  const [group] = await db.insert(deviceGroups).values({
    orgId: org.id,
    siteId: site.id,
    name: 'Reconstruction group',
  }).returning();
  if (!device || !destinationDevice || !group) throw new Error('membership fixture insert failed');
  const watermarkRows = await db.select({ updatedAt: devices.partnerExportUpdatedAt })
    .from(devices).where(eq(devices.orgId, org.id));
  const exportBaseline = new Date(Math.max(...watermarkRows.map((row) => row.updatedAt.getTime())));
  return { db, device, destinationDevice, group, org, partner, baseline, exportBaseline };
}

describe('partner device membership incremental change contract', () => {
  runDb('migration is idempotent', async () => {
    const db = getTestDb();
    const migration = readFileSync(MEMBERSHIP_MIGRATION_FILE, 'utf8');
    const watermarkMigration = readFileSync(WATERMARK_MIGRATION_FILE, 'utf8');
    const completionMigration = readFileSync(COMPLETION_MIGRATION_FILE, 'utf8');
    const canonicalMutationMigration = readFileSync(CANONICAL_MUTATION_MIGRATION_FILE, 'utf8');
    const lockHardeningMigration = readFileSync(LOCK_HARDENING_MIGRATION_FILE, 'utf8');
    const lockKeyCollisionMigration = readFileSync(LOCK_KEY_COLLISION_MIGRATION_FILE, 'utf8');
    for (let pass = 0; pass < 2; pass += 1) {
      await expect(db.execute(sql.raw(migration))).resolves.toBeDefined();
      await expect(db.execute(sql.raw(watermarkMigration))).resolves.toBeDefined();
      await expect(db.execute(sql.raw(completionMigration))).resolves.toBeDefined();
      await expect(db.execute(sql.raw(canonicalMutationMigration))).resolves.toBeDefined();
      await expect(db.execute(sql.raw(lockHardeningMigration))).resolves.toBeDefined();
      await expect(db.execute(sql.raw(lockKeyCollisionMigration))).resolves.toBeDefined();
    }
    expect(migration.match(/FOR EACH STATEMENT/gu)).toHaveLength(3);
    expect(migration).toMatch(/REFERENCING NEW TABLE AS new_memberships/gu);
    expect(migration).toMatch(/REFERENCING OLD TABLE AS old_memberships/gu);
    expect(migration).toMatch(/SELECT DISTINCT device_id, org_id/gu);
  });

  runDb('ordinary RLS-scoped insert, identity update, and delete advance every affected device', async () => {
    const { db, device, destinationDevice, group, org, partner, baseline } = await seedDeviceAndGroup();
    const context = {
      scope: 'partner' as const,
      orgId: null,
      accessibleOrgIds: [org.id],
      accessiblePartnerIds: [partner.id],
      currentPartnerId: partner.id,
      userId: null,
    };

    await withDbAccessContext(context, () => appDb.insert(deviceGroupMemberships).values({
        deviceId: device.id,
        groupId: group.id,
        orgId: org.id,
      }));
    const [afterInsert] = await db.select({ updatedAt: devices.updatedAt })
      .from(devices).where(andDeviceChanged(device.id, baseline));
    expect(afterInsert?.updatedAt.getTime()).toBeGreaterThan(baseline.getTime());

    await withDbAccessContext(context, () => appDb.update(deviceGroupMemberships)
      .set({ deviceId: destinationDevice.id })
      .where(eq(deviceGroupMemberships.deviceId, device.id)));
    const [oldAfterMove] = await db.select({ updatedAt: devices.updatedAt })
      .from(devices).where(andDeviceChanged(device.id, afterInsert!.updatedAt));
    const [newAfterMove] = await db.select({ updatedAt: devices.updatedAt })
      .from(devices).where(andDeviceChanged(destinationDevice.id, baseline));
    expect(oldAfterMove?.updatedAt.getTime()).toBeGreaterThan(afterInsert!.updatedAt.getTime());
    expect(newAfterMove?.updatedAt.getTime()).toBeGreaterThan(baseline.getTime());

    await withDbAccessContext(context, () => appDb.delete(deviceGroupMemberships)
      .where(eq(deviceGroupMemberships.deviceId, destinationDevice.id)));
    const [afterDelete] = await db.select({ updatedAt: devices.updatedAt })
      .from(devices).where(andDeviceChanged(destinationDevice.id, newAfterMove!.updatedAt));
    expect(afterDelete?.updatedAt.getTime()).toBeGreaterThan(newAfterMove!.updatedAt.getTime());
  });

  runDb('membership-only insert re-emits the bounded group fact after updatedSince', async () => {
    const { device, group, org, partner, exportBaseline } = await seedDeviceAndGroup();
    const context = partnerContext(partner.id, org.id);
    await withDbAccessContext(context, () => appDb.insert(deviceGroupMemberships).values({
      deviceId: device.id,
      groupId: group.id,
      orgId: org.id,
    }));

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('partnerApiPrincipal', {
        partnerServicePrincipalId: crypto.randomUUID(),
        keyId: crypto.randomUUID(),
        partnerId: partner.id,
        name: 'Integration test',
        scopes: ['devices:read'],
        accessibleOrgIds: [org.id],
        rateLimit: 600,
      });
      await withDbAccessContext(context, async () => {
        await appDb.execute(sql`SELECT public.breeze_partner_export_lock_partners_shared(
          ARRAY[${partner.id}::uuid]
        )`);
        await next();
      });
    });
    app.route('/', partnerDeviceRoutes);

    const response = await app.request(`/devices?updatedSince=${encodeURIComponent(exportBaseline.toISOString())}`);
    const errorBody = response.status === 200 ? '' : await response.clone().text();
    expect(response.status, errorBody).toBe(200);
    const envelope = deviceExportEnvelopeSchema.parse(await response.json());
    expect(envelope.data).toHaveLength(1);
    expect(envelope.data[0]).toMatchObject({
      id: device.id,
      groupIds: [group.id],
      groupMembership: { total: 1, included: 1, complete: true, reason: null },
    });
  });
});

function andDeviceChanged(deviceId: string, since: Date) {
  return and(eq(devices.id, deviceId), gt(devices.updatedAt, since));
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
