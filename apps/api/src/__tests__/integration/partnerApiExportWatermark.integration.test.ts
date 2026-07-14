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
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MIGRATION_FILE = join(__dirname, '../../../migrations/2026-07-18-partner-export-org-locks.sql');
const STALE_TIMESTAMP = new Date('2000-01-01T00:00:00.000Z');

type ChangeKind = 'membership' | 'device' | 'hardware' | 'site' | 'organization';

describe('partner export transaction watermark serialization', () => {
  runDb('migration is idempotent and documents its lock namespace and order', async () => {
    const migration = readFileSync(MIGRATION_FILE, 'utf8');
    const db = getTestDb();
    await expect(db.execute(sql.raw(migration))).resolves.toBeDefined();
    await expect(db.execute(sql.raw(migration))).resolves.toBeDefined();
    expect(migration).toMatch(/1000201/);
    expect(migration).toMatch(/ORDER BY org_id/);
    expect(migration).toMatch(/pg_advisory_xact_lock_shared/);
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

  runDb('exclusive multi-org helper canonicalizes reverse input without deadlock', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const low = await createOrganization({ partnerId: partner.id });
    const high = await createOrganization({ partnerId: partner.id });
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
  data: Array<{ id: string }>;
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
  const context = partnerContext(fixture.partner.id, fixture.org.id);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('partnerApiPrincipal', {
      servicePrincipalId: crypto.randomUUID(),
      keyId: crypto.randomUUID(),
      partnerId: fixture.partner.id,
      name: 'Watermark integration test',
      scopes: ['organizations:read', 'sites:read', 'devices:read'],
      accessibleOrgIds: [fixture.org.id],
      rateLimit: 600,
    });
    await withDbAccessContext(context, async () => {
      await appDb.execute(sql`SELECT public.breeze_partner_export_lock_partners_shared(
        ARRAY[${fixture.partner.id}::uuid]
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
