/**
 * EDR provider framework W02 (#8166) - portal `enableEdrVisibility` against real
 * Postgres. Proves: org A's portal never counts org B's EDR rows (RLS + explicit
 * org predicates), the flag fails closed (off => zero EDR influence), only a
 * healthy + online linked endpoint counts as protected, tombstoned detections are
 * excluded, and no vendor/provider/product string reaches a portal DTO.
 *
 * Migration: 2026-12-25-180000-portal-branding-enable-edr-visibility.sql
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  devices,
  edrConnections,
  edrDetections,
  edrEndpoints,
  edrTenants,
  portalBranding,
} from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';
import {
  devicesProtectedTile,
  securityDevicesPage,
  securityOverview,
} from '../../services/portal/securityReadModel';
import { isEdrVisibilityEnabled } from '../../services/portal/edrVisibility';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const NOW = new Date('2026-10-12T12:00:00.000Z');
const IN_WINDOW = new Date('2026-10-10T12:00:00.000Z');
const GENERIC_LABEL = 'Managed endpoint protection';
const admin = () => getTestDb() as typeof db;

async function seedOrg(label: string, partnerId: string) {
  const org = await createOrganization({ partnerId });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({
    partnerId,
    orgId: org.id,
    email: `portal-edr-${label}-${randomUUID()}@example.com`,
  });
  const makeDevice = async (name: string) => {
    const [device] = await admin().insert(devices).values({
      orgId: org.id,
      siteId: site!.id,
      agentId: randomUUID(),
      hostname: `${name}-${randomUUID().slice(0, 8)}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
    }).returning({ id: devices.id });
    return device!.id;
  };
  const [connection] = await db.insert(edrConnections).values({
    partnerId,
    provider: 'bitdefender',
    name: `GravityZone ${label} ${randomUUID().slice(0, 6)}`,
    credentialsEncrypted: 'enc:test',
    vendorRootId: 'root-1',
    vendorRootType: 'partner',
  }).returning({ id: edrConnections.id });
  const [tenant] = await db.insert(edrTenants).values({
    connectionId: connection!.id,
    partnerId,
    vendorTenantId: `company-${label}-${randomUUID().slice(0, 6)}`,
    vendorTenantName: `Company ${label}`,
    vendorTenantType: 'company',
    orgId: org.id,
    mappingSource: 'manual',
  }).returning({ id: edrTenants.id });

  const context: DbAccessContext = {
    scope: 'organization',
    orgId: org.id,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [],
    userId: user.id,
    currentPartnerId: partnerId,
  };

  const endpoint = (deviceId: string | null, over: Record<string, unknown> = {}) =>
    db.insert(edrEndpoints).values({
      connectionId: connection!.id,
      partnerId,
      orgId: org.id,
      tenantId: tenant!.id,
      provider: 'bitdefender',
      vendorEndpointId: `ep-${randomUUID().slice(0, 8)}`,
      hostname: 'WS-01',
      breezeDeviceId: deviceId,
      ...over,
    } as typeof edrEndpoints.$inferInsert);

  const detection = (over: Record<string, unknown> = {}) =>
    db.insert(edrDetections).values({
      connectionId: connection!.id,
      partnerId,
      orgId: org.id,
      tenantId: tenant!.id,
      provider: 'bitdefender',
      vendorDetectionId: `det-${randomUUID().slice(0, 8)}`,
      vendorKind: 'incident',
      severity: 'high',
      status: 'open',
      title: 'GravityZone incident',
      detectedAt: IN_WINDOW,
      ...over,
    } as typeof edrDetections.$inferInsert);

  return { org, context, makeDevice, endpoint, detection };
}

async function setFlag(orgId: string, enabled: boolean) {
  await admin().insert(portalBranding).values({ orgId, enableEdrVisibility: enabled })
    .onConflictDoUpdate({ target: portalBranding.orgId, set: { enableEdrVisibility: enabled } });
}

async function seed() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const a = await seedOrg('a', partner.id);
    const b = await seedOrg('b', partner.id);

    const aHealthy = await a.makeDevice('a-healthy');
    const aUnhealthy = await a.makeDevice('a-unhealthy');
    const aOffline = await a.makeDevice('a-offline');
    const aNone = await a.makeDevice('a-none');
    await a.endpoint(aHealthy, { health: 'healthy', online: true });
    await a.endpoint(aUnhealthy, { health: 'unhealthy', online: true });
    await a.endpoint(aOffline, { health: 'healthy', online: false });
    await a.detection({ resolvedAt: IN_WINDOW });
    await a.detection({ detachedAt: IN_WINDOW, tenantId: null }); // D13 tombstone: excluded

    const bHealthy = await b.makeDevice('b-healthy');
    await b.endpoint(bHealthy, { health: 'healthy', online: true });
    await b.detection();
    await b.detection();
    await b.detection();

    return { a, b, aHealthy, aUnhealthy, aOffline, aNone, bHealthy };
  });
}

const edrTotal = (dto: Awaited<ReturnType<typeof securityOverview>>, key: 'detectedBySource' | 'resolvedBySource') =>
  dto.threatEvents.weeks.reduce((n, w) => n + (w[key].edr ?? 0), 0);

describe('portal EDR visibility (real PostgreSQL)', () => {
  runDb('migration replays idempotently and defaults existing and new rows to false', async () => {
    const migration = readFileSync(
      new URL('../../../migrations/2026-12-25-180000-portal-branding-enable-edr-visibility.sql', import.meta.url),
      'utf8',
    );
    await getTestDb().transaction(async (tx) => {
      // Transaction-local shadow: never changes the real portal_branding table.
      await tx.execute(sql.raw('CREATE TEMP TABLE portal_branding (id integer PRIMARY KEY) ON COMMIT DROP'));
      await tx.execute(sql.raw('INSERT INTO portal_branding (id) VALUES (1)'));
      await tx.execute(sql.raw(migration));
      await tx.execute(sql.raw(migration));
      await tx.execute(sql.raw('INSERT INTO portal_branding (id) VALUES (2)'));
      const rows = await tx.execute(sql.raw('SELECT enable_edr_visibility FROM portal_branding ORDER BY id'));
      expect(Array.from(rows)).toEqual([{ enable_edr_visibility: false }, { enable_edr_visibility: false }]);
    });
  });

  runDb('flag defaults to off for an org with no settings row, and is isolated per org', async () => {
    const fx = await seed();
    expect(await withDbAccessContext(fx.a.context, () => isEdrVisibilityEnabled(fx.a.org.id))).toBe(false);

    await setFlag(fx.a.org.id, true);
    expect(await withDbAccessContext(fx.a.context, () => isEdrVisibilityEnabled(fx.a.org.id))).toBe(true);
    // Org B never turned it on, and org A's context cannot read B's settings row.
    expect(await withDbAccessContext(fx.b.context, () => isEdrVisibilityEnabled(fx.b.org.id))).toBe(false);
    expect(await withDbAccessContext(fx.a.context, () => isEdrVisibilityEnabled(fx.b.org.id))).toBe(false);
  });

  runDb('flag on: only a healthy+online linked endpoint is protected, and org B rows never count for org A', async () => {
    const fx = await seed();
    await setFlag(fx.a.org.id, true);
    await setFlag(fx.b.org.id, true);

    const tileA = await withDbAccessContext(fx.a.context, () => devicesProtectedTile(fx.a.org.id, NOW));
    // 4 devices, none with a security_status row: healthy+online EDR => protected,
    // the unhealthy, offline and unlinked devices stay unknown (never upgraded).
    expect(tileA).toMatchObject({ status: 'ok', protected: 1, unprotected: 0, unknown: 3, total: 4 });

    const page = await withDbAccessContext(fx.a.context, () =>
      securityDevicesPage(fx.a.org.id, { page: 1, limit: 50, timezone: 'UTC', now: NOW }));
    const byId = new Map(page.data.map((row) => [row.id, row]));
    expect(byId.get(fx.aHealthy)).toMatchObject({ protection: 'protected', avProducts: [GENERIC_LABEL] });
    expect(byId.get(fx.aUnhealthy)).toMatchObject({ protection: 'unknown', avProducts: [GENERIC_LABEL] });
    expect(byId.get(fx.aOffline)).toMatchObject({ protection: 'unknown', avProducts: [GENERIC_LABEL] });
    expect(byId.get(fx.aNone)).toMatchObject({ protection: 'unknown', avProducts: [] });
    // Org B's device is not visible to org A at all.
    expect(byId.has(fx.bHealthy)).toBe(false);

    // Asking for org B's data from org A's context yields nothing (RLS + org predicates).
    const crossTile = await withDbAccessContext(fx.a.context, () => devicesProtectedTile(fx.b.org.id, NOW));
    expect(crossTile.status).toBe('no_data');

    const overviewA = await withDbAccessContext(fx.a.context, () =>
      securityOverview(fx.a.org.id, { days: 30, timezone: 'UTC', now: NOW }));
    // A has one live detection (resolved) plus one tombstone: only the live one counts.
    expect(edrTotal(overviewA, 'detectedBySource')).toBe(1);
    expect(edrTotal(overviewA, 'resolvedBySource')).toBe(1);
    expect(overviewA.dataStatus).toBe('ok');

    const overviewB = await withDbAccessContext(fx.b.context, () =>
      securityOverview(fx.b.org.id, { days: 30, timezone: 'UTC', now: NOW }));
    expect(edrTotal(overviewB, 'detectedBySource')).toBe(3);

    const crossOverview = await withDbAccessContext(fx.a.context, () =>
      securityOverview(fx.b.org.id, { days: 30, timezone: 'UTC', now: NOW }));
    expect(edrTotal(crossOverview, 'detectedBySource')).toBe(0);

    // Vendor neutrality: seeded provider is 'bitdefender', connection name 'GravityZone ...'.
    const json = JSON.stringify({ tileA, page, overviewA, overviewB });
    expect(json).not.toMatch(/bitdefender/i);
    expect(json).not.toMatch(/gravityzone/i);
  });

  runDb('flag off: zero EDR influence even with healthy EDR endpoints and detections present', async () => {
    const fx = await seed();
    // Explicit false row for A, no settings row at all for B: both fail closed.
    await setFlag(fx.a.org.id, false);

    const tileA = await withDbAccessContext(fx.a.context, () => devicesProtectedTile(fx.a.org.id, NOW));
    expect(tileA).toMatchObject({ status: 'ok', protected: 0, unprotected: 0, unknown: 4, total: 4 });

    const page = await withDbAccessContext(fx.a.context, () =>
      securityDevicesPage(fx.a.org.id, { page: 1, limit: 50, timezone: 'UTC', now: NOW }));
    for (const row of page.data) {
      expect(row.protection).toBe('unknown');
      expect(row.avProducts).toEqual([]);
    }

    const overviewA = await withDbAccessContext(fx.a.context, () =>
      securityOverview(fx.a.org.id, { days: 30, timezone: 'UTC', now: NOW }));
    expect(overviewA.dataStatus).toBe('no_data');
    expect(JSON.stringify(overviewA)).not.toContain('"edr"');
    for (const week of overviewA.threatEvents.weeks) {
      expect(Object.keys(week.detectedBySource).sort()).toEqual(['huntress', 'native', 'sentinelOne']);
    }

    const overviewB = await withDbAccessContext(fx.b.context, () =>
      securityOverview(fx.b.org.id, { days: 30, timezone: 'UTC', now: NOW }));
    expect(overviewB.dataStatus).toBe('no_data');
    expect(JSON.stringify(overviewB)).not.toContain('"edr"');

    // The stored flag really is false/absent (guards a fixture that silently set it).
    const [row] = await admin().select({ v: portalBranding.enableEdrVisibility })
      .from(portalBranding).where(eq(portalBranding.orgId, fx.a.org.id));
    expect(row?.v).toBe(false);
  });
});
