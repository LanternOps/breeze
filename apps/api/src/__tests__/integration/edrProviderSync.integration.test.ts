/**
 * EDR provider framework W01b (#8164 / #8165) — Phase 3 writers against real
 * Postgres. Review Focus 2: a remap must not drag history into the new org.
 *
 * The vendor is not involved: pages are handed straight to `persistDetections`,
 * exactly as the sync job would after fetching them. Everything else (remap,
 * tombstoning, the partial live-identity index, RLS) is real.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

// ---- vendor seam ---------------------------------------------------------------
// Only the GravityZone HTTP client and the Redis-backed context are replaced. The
// REAL bitdefender adapter, normalisers, job functions, persist, mapping, device
// matching and RLS all run against Postgres. Vendor data is shaped from the
// recorded fixtures in services/edrProviders/bitdefender/__fixtures__.
const gz = vi.hoisted(() => ({
  companies: [] as Array<{ id: string; name: string }>,
  inventory: new Map<string, Array<Record<string, unknown>>>(),
  inventoryError: new Map<string, Error>(),
  incidents: [] as Array<Record<string, unknown>>,
  calls: [] as string[],
  /** vendor calls made while a DB access context was held (must stay empty). */
  heldCalls: [] as string[],
  incidentWindows: [] as Array<{ from: Date; to: Date }>,
}));
vi.mock('../../services/edrProviders/bitdefender/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/edrProviders/bitdefender/client')>();
  const dbMod = await import('../../db');
  class FakeGravityZoneClient {
    private note(call: string) {
      gz.calls.push(call);
      if (dbMod.hasDbAccessContext()) gz.heldCalls.push(call);
      dbMod.assertOutsideHeldDbContext(`gravityzone.${call}`);
    }
    async getOwnCompany() { this.note('getOwnCompany'); return { id: 'root-1', name: 'MSP', type: 0 }; }
    async getCompaniesList(parentId: string, type: 0 | 1) {
      this.note('getCompaniesList');
      return type === 1 && parentId === 'root-1' ? gz.companies : [];
    }
    async getInventoryAll(companyId: string) {
      this.note(`getInventoryAll:${companyId}`);
      const err = gz.inventoryError.get(companyId);
      if (err) throw err;
      return gz.inventory.get(companyId) ?? [];
    }
    async getInventoryTotal(companyId: string) {
      this.note(`getInventoryTotal:${companyId}`);
      return (gz.inventory.get(companyId) ?? []).length;
    }
    async getEndpointDetails() { this.note('getEndpointDetails'); return {}; }
    async getIncidentsChangedBetween(from: Date, to: Date) {
      this.note('getIncidentsChangedBetween');
      gz.incidentWindows.push({ from, to });
      return gz.incidents;
    }
    async getQuarantineBetween() { this.note('getQuarantineBetween'); return []; }
  }
  return { ...actual, GravityZoneClient: FakeGravityZoneClient };
});
// No Redis: a no-op limiter, and a live fetch is a test failure.
vi.mock('../../services/edrProviders/context', () => ({
  buildEdrAdapterContext: (_adapter: unknown, o: { creds: unknown; baseUrl: string | null; region: string | null }) => ({
    creds: o.creds,
    baseUrl: o.baseUrl,
    region: o.region,
    fetch: async () => { throw new Error('live vendor HTTP is forbidden in tests'); },
    limiter: { acquire: async () => {} },
    runCache: new Map(),
  }),
}));

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { devices, edrActions, edrConnections, edrDetections, edrEndpoints, edrTenants } from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { syncEdrDetections, syncEdrInventory } from '../../jobs/edrProviderSync';
import { encryptEdrSecret } from '../../services/edrProviders/credentials';
import { matchEdrEndpoints } from '../../services/edrProviders/deviceMatching';
import { EdrProviderRequestError } from '../../services/edrProviders/types';
import { deleteDeviceCascade, type DeviceDeletionTx } from '../../services/deviceDeletion';
import { moveDeviceOrgInTransaction } from '../../services/deviceOrgMove/moveDeviceOrgInTransaction';
import { getTestDb } from './setup';
import { remapEdrTenant } from '../../services/edrProviders/mapping';
import { persistDetections } from '../../services/edrProviders/persist';
import type { VendorEdrDetection } from '../../services/edrProviders/types';

const runDb = it.runIf(!!process.env.DATABASE_URL);

type Row = Record<string, unknown>;
const admin = () => getTestDb() as typeof db;
async function adminRows<T = Row>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await admin().execute(query)) as unknown as T[];
}

const orgContext = (orgId: string, userId: string): DbAccessContext => ({
  scope: 'organization',
  orgId,
  accessibleOrgIds: [orgId],
  accessiblePartnerIds: [],
  userId,
});

const vendorDetection = (vendorTenantId: string, vendorDetectionId: string, over: Partial<VendorEdrDetection> = {}): VendorEdrDetection => ({
  vendorDetectionId,
  vendorKind: 'incident',
  vendorTenantId,
  vendorEndpointId: null,
  severity: 'high',
  vendorSeverity: 'high',
  status: 'open',
  vendorStatus: 'open',
  title: 'Ransomware behaviour',
  category: null,
  threatName: null,
  filePath: null,
  processName: null,
  mitreTechniques: [],
  detectedAt: new Date('2026-12-16T09:00:00Z'),
  resolvedAt: null,
  lastVendorUpdateAt: new Date('2026-12-16T09:05:00Z'),
  details: {},
  ...over,
});

async function seed() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const user = await createUser({
      partnerId: partner.id,
      orgId: orgA.id,
      email: `edr-sync-${randomUUID()}@example.com`,
    });
    const [connection] = await db.insert(edrConnections).values({
      partnerId: partner.id,
      provider: 'bitdefender',
      name: `GravityZone ${randomUUID().slice(0, 6)}`,
      credentialsEncrypted: 'enc:test',
      vendorRootId: 'root-1',
      vendorRootType: 'partner',
    }).returning({ id: edrConnections.id });
    const vendorTenantId = `company-${randomUUID().slice(0, 8)}`;
    const [tenant] = await db.insert(edrTenants).values({
      connectionId: connection!.id,
      partnerId: partner.id,
      vendorTenantId,
      vendorTenantName: 'Acme',
      vendorTenantType: 'company',
      orgId: orgA.id,
      mappingSource: 'manual',
    }).returning({ id: edrTenants.id });
    const vendorDetectionId = `incident-${randomUUID().slice(0, 8)}`;
    const [endpoint] = await db.insert(edrEndpoints).values({
      connectionId: connection!.id,
      partnerId: partner.id,
      orgId: orgA.id,
      tenantId: tenant!.id,
      provider: 'bitdefender',
      vendorEndpointId: `ep-${randomUUID().slice(0, 8)}`,
      hostname: 'WS-01',
    }).returning({ id: edrEndpoints.id });
    const [detection] = await db.insert(edrDetections).values({
      connectionId: connection!.id,
      partnerId: partner.id,
      orgId: orgA.id,
      tenantId: tenant!.id,
      endpointId: endpoint!.id,
      provider: 'bitdefender',
      vendorDetectionId,
      vendorKind: 'incident',
      severity: 'high',
      status: 'open',
    }).returning({ id: edrDetections.id });
    return {
      partner, orgA, orgB, user, vendorTenantId, vendorDetectionId,
      conn: { id: connection!.id, partnerId: partner.id, provider: 'bitdefender' },
      tenantId: tenant!.id,
      endpointId: endpoint!.id,
      detectionId: detection!.id,
    };
  });
}

describe('edr sync — remap and tombstones (Review Focus 2)', () => {
  runDb('remap tombstones history under the old org and a re-fetch never repoints it', async () => {
    const fx = await seed();

    // ---- remap A -> B (the PUT /edr/tenants/:id/mapping path) -------------------
    const remap = await withSystemDbAccessContext(() => remapEdrTenant(
      db as never,
      { partnerId: fx.partner.id, userId: fx.user.id },
      fx.tenantId,
      fx.orgB.id,
    ));
    expect(remap).toMatchObject({
      previousOrgId: fx.orgA.id, orgId: fx.orgB.id,
      endpointsDeleted: 1, detectionsDetached: 1, actionsDetached: 0,
    });

    const [tombstone] = await adminRows<{ org_id: string; tenant_id: string | null; endpoint_id: string | null; detached_at: Date | null; status: string; updated_at: Date }>(sql`
      SELECT org_id, tenant_id, endpoint_id, detached_at, status, updated_at FROM edr_detections WHERE id = ${fx.detectionId}::uuid
    `);
    expect(tombstone).toMatchObject({ org_id: fx.orgA.id, tenant_id: null, endpoint_id: null });
    expect(tombstone!.detached_at).not.toBeNull();
    const endpointRows = await adminRows(sql`SELECT id FROM edr_endpoints WHERE id = ${fx.endpointId}::uuid`);
    expect(endpointRows).toHaveLength(0);
    const [tenantAfter] = await adminRows<{ org_id: string; mapping_source: string }>(sql`
      SELECT org_id, mapping_source FROM edr_tenants WHERE id = ${fx.tenantId}::uuid
    `);
    expect(tenantAfter).toMatchObject({ org_id: fx.orgB.id, mapping_source: 'manual' });

    // ---- the next sync re-fetches the SAME vendor detection ---------------------
    const page = { detections: [vendorDetection(fx.vendorTenantId, fx.vendorDetectionId)], cursor: '2026-12-16T10:00:00.000Z', warnings: [] };
    for (let run = 0; run < 2; run += 1) {
      const persisted = await withSystemDbAccessContext(() => persistDetections(
        db as never,
        fx.conn,
        [{ vendorTenantId: fx.vendorTenantId, ok: true, value: page }],
        new Date('2026-12-16T10:00:00Z'),
      ));
      expect(persisted).toMatchObject({ upserted: 1, skipped: 0, failedTenants: 0 });
    }

    const rows = await adminRows<{ id: string; org_id: string; tenant_id: string | null; detached_at: Date | null; updated_at: Date }>(sql`
      SELECT id, org_id, tenant_id, detached_at, updated_at FROM edr_detections
      WHERE connection_id = ${fx.conn.id}::uuid AND vendor_detection_id = ${fx.vendorDetectionId}
      ORDER BY created_at
    `);
    // The tombstone plus exactly ONE fresh live row (the second run updated it in place).
    expect(rows).toHaveLength(2);
    const [oldRow, newRow] = rows;
    expect(oldRow).toMatchObject({ id: fx.detectionId, org_id: fx.orgA.id, tenant_id: null });
    expect(oldRow!.detached_at).not.toBeNull();
    expect(oldRow!.updated_at).toEqual(tombstone!.updated_at); // never touched by the re-fetch
    expect(newRow).toMatchObject({ org_id: fx.orgB.id, tenant_id: fx.tenantId, detached_at: null });
    expect(newRow!.id).not.toBe(fx.detectionId);

    const [tenantCursor] = await adminRows<{ detection_cursor: string; open_detection_count: number }>(sql`
      SELECT detection_cursor, open_detection_count FROM edr_tenants WHERE id = ${fx.tenantId}::uuid
    `);
    expect(tenantCursor).toMatchObject({ detection_cursor: '2026-12-16T10:00:00.000Z', open_detection_count: 1 });

    // ---- who sees what -----------------------------------------------------------
    const seenByA = await withDbAccessContext(orgContext(fx.orgA.id, fx.user.id), () =>
      db.select({ id: edrDetections.id }).from(edrDetections));
    expect(seenByA.map((r) => r.id)).toEqual([fx.detectionId]);
    const seenByB = await withDbAccessContext(orgContext(fx.orgB.id, fx.user.id), () =>
      db.select({ id: edrDetections.id }).from(edrDetections));
    expect(seenByB.map((r) => r.id)).toEqual([newRow!.id]);
  });
});

// ===========================================================================
// Real job functions (syncEdrInventory / syncEdrDetections) against Postgres
// ===========================================================================

const FIXTURES = new URL('../../services/edrProviders/bitdefender/__fixtures__/', import.meta.url);
const fixture = (name: string) => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')).result;
const fixtureManaged = fixture('inventory-page1.json').items[0] as Record<string, any>;
const fixtureUnmanaged = fixture('inventory-page2.json').items[0] as Record<string, any>;
const fixtureIncident = fixture('incidents-page.json').items[0] as Record<string, any>;

const sfx = () => randomUUID().slice(0, 8);

/** A managed inventory item as the recorded fixture shapes it. */
function gzEndpoint(id: string, companyId: string, name: string, fqdn: string, over: Record<string, any> = {}) {
  return {
    ...fixtureManaged,
    id,
    name,
    companyId,
    details: { ...fixtureManaged.details, fqdn, isManaged: true, macs: [], ...over },
  };
}
const gzUnmanaged = (id: string, companyId: string) => ({ ...fixtureUnmanaged, id, companyId });
function gzIncident(id: string, companyId: string, status: number | string, computerId: string | null = null) {
  return {
    ...fixtureIncident,
    incidentId: id,
    company: { id: companyId, name: 'x' },
    status,
    details: { ...fixtureIncident.details, computerId },
  };
}

function resetVendor() {
  gz.companies = [];
  gz.inventory = new Map();
  gz.inventoryError = new Map();
  gz.incidents = [];
  gz.calls = [];
  gz.heldCalls = [];
  gz.incidentWindows = [];
}

/** partner + orgA(+site+device) + orgB(+site) + a real-credentialled GravityZone connection. */
async function seedJob(opts: { deviceHostname?: string } = {}) {
  resetVendor();
  const partner = await withSystemDbAccessContext(() => createPartner());
  const { orgA, siteA, user, orgB, siteB } = await withSystemDbAccessContext(async () => {
    const a = await createOrganization({ partnerId: partner.id });
    const b = await createOrganization({ partnerId: partner.id });
    const sa = await createSite({ orgId: a.id });
    const sb = await createSite({ orgId: b.id });
    const u = await createUser({ partnerId: partner.id, orgId: a.id, email: `edr-job-${randomUUID()}@example.com` });
    return { orgA: a, siteA: sa!, orgB: b, siteB: sb!, user: u };
  });
  const mkDevice = async (orgId: string, siteId: string, hostname: string) => {
    const [d] = await admin().insert(devices).values({
      orgId, siteId, agentId: randomUUID(), hostname, osType: 'windows', osVersion: '11',
      architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
    }).returning({ id: devices.id });
    return d!;
  };
  const deviceA = await mkDevice(orgA.id, siteA.id, opts.deviceHostname ?? 'ws-01.corp.example');
  const connectionId = randomUUID();
  await withSystemDbAccessContext(() => db.insert(edrConnections).values({
    id: connectionId,
    partnerId: partner.id,
    provider: 'bitdefender',
    name: `GravityZone ${sfx()}`,
    credentialsEncrypted: encryptEdrSecret('connection_credentials', connectionId, { apiKey: 'k'.repeat(24) }),
    baseUrl: 'https://cloud.gravityzone.bitdefender.com/api',
    vendorRootId: 'root-1',
    vendorRootType: 'partner',
  }));
  const addTenant = (vendorTenantId: string, orgId: string | null, over: Partial<typeof edrTenants.$inferInsert> = {}) =>
    withSystemDbAccessContext(async () => {
      const [t] = await db.insert(edrTenants).values({
        connectionId, partnerId: partner.id, vendorTenantId, vendorTenantName: `Co ${vendorTenantId}`,
        vendorTenantType: 'company', orgId, mappingSource: orgId ? 'manual' : null, ...over,
      } as typeof edrTenants.$inferInsert).returning({ id: edrTenants.id });
      return t!.id;
    });
  const addEndpoint = (tenantId: string, orgId: string, vendorEndpointId: string, hostname: string) =>
    withSystemDbAccessContext(async () => {
      const [e] = await db.insert(edrEndpoints).values({
        connectionId, partnerId: partner.id, orgId, tenantId, provider: 'bitdefender', vendorEndpointId, hostname,
      }).returning({ id: edrEndpoints.id });
      return e!.id;
    });
  return { partner, orgA, siteA, orgB, siteB, user, deviceA, mkDevice, connectionId, addTenant, addEndpoint };
}

const tenantRow = async (connectionId: string, vendorTenantId: string) => (await adminRows<Row>(sql`
  SELECT * FROM edr_tenants WHERE connection_id = ${connectionId}::uuid AND vendor_tenant_id = ${vendorTenantId}
`))[0]!;
const connRow = async (id: string) => (await adminRows<Row>(sql`SELECT * FROM edr_connections WHERE id = ${id}::uuid`))[0]!;
const endpointsOf = (connectionId: string) => adminRows<Row>(sql`
  SELECT e.*, t.vendor_tenant_id AS vtid FROM edr_endpoints e JOIN edr_tenants t ON t.id = e.tenant_id
  WHERE e.connection_id = ${connectionId}::uuid ORDER BY e.vendor_endpoint_id
`);

describe('edr sync — real job functions against Postgres', () => {
  runDb('inventory sync persists endpoints only for mapped companies and links a hostname match in the same org', async () => {
    const fx = await seedJob();
    const mapped = `co-mapped-${sfx()}`;
    const unmapped = `co-unmapped-${sfx()}`;
    await fx.addTenant(mapped, fx.orgA.id);
    // An orgB device with the other endpoint's name: the match must stay inside the tenant's org.
    await fx.mkDevice(fx.orgB.id, fx.siteB.id, 'lnx-beta');
    gz.companies = [{ id: mapped, name: `Mapped ${sfx()}` }, { id: unmapped, name: `Unmapped ${sfx()}` }];
    gz.inventory.set(mapped, [
      gzEndpoint(`ep-ws-${sfx()}`, mapped, 'WS-01', 'ws-01.corp.example'),
      gzEndpoint(`ep-lnx-${sfx()}`, mapped, 'lnx-beta', 'lnx-beta.corp.example'),
      gzUnmanaged(`ep-prn-${sfx()}`, mapped),
    ]);
    gz.inventory.set(unmapped, [
      gzEndpoint(`ep-u1-${sfx()}`, unmapped, 'U-1', 'u-1.other'),
      gzEndpoint(`ep-u2-${sfx()}`, unmapped, 'U-2', 'u-2.other'),
      gzEndpoint(`ep-u3-${sfx()}`, unmapped, 'U-3', 'u-3.other'),
    ]);

    await syncEdrInventory(fx.connectionId);

    const rows = await endpointsOf(fx.connectionId);
    expect(rows.map((r) => r.vtid)).toEqual([mapped, mapped]); // unmanaged dropped, unmapped never stored
    expect(rows.every((r) => r.org_id === fx.orgA.id)).toBe(true);
    const ws = rows.find((r) => String(r.hostname).toLowerCase() === 'ws-01')!;
    // FQDN regression: Breeze `ws-01.corp.example` <-> vendor `WS-01`.
    expect(ws).toMatchObject({ breeze_device_id: fx.deviceA.id, device_match_source: 'auto_hostname' });
    const lnx = rows.find((r) => r.hostname === 'lnx-beta')!;
    expect(lnx.breeze_device_id).toBeNull(); // the only 'lnx-beta' device is in orgB

    const unmappedTenant = await tenantRow(fx.connectionId, unmapped);
    expect(unmappedTenant).toMatchObject({ org_id: null, endpoint_count: 3 });
    expect(await adminRows(sql`SELECT 1 FROM edr_endpoints WHERE tenant_id = ${unmappedTenant.id as string}::uuid`)).toHaveLength(0);
    expect(await tenantRow(fx.connectionId, mapped)).toMatchObject({ endpoint_count: 2, last_inventory_sync_status: 'success' });
    expect(await connRow(fx.connectionId)).toMatchObject({
      status: 'connected', last_inventory_sync_status: 'success', last_sync_linked_endpoints: 1,
      // the root partner company is itself a tenant (commit 2785805fae), unmapped here
      last_sync_tenants: 3, last_sync_unmapped_tenants: 2,
    });
  });

  runDb('a company whose fetch fails keeps its existing endpoints; the connection stays connected', async () => {
    const fx = await seedJob();
    const bad = `co-bad-${sfx()}`;
    const good = `co-good-${sfx()}`;
    const badTenant = await fx.addTenant(bad, fx.orgA.id);
    await fx.addTenant(good, fx.orgA.id);
    const keptA = await fx.addEndpoint(badTenant, fx.orgA.id, 'old-1', 'OLD-1');
    const keptB = await fx.addEndpoint(badTenant, fx.orgA.id, 'old-2', 'OLD-2');
    gz.companies = [{ id: bad, name: 'Bad' }, { id: good, name: 'Good' }];
    gz.inventoryError.set(bad, new EdrProviderRequestError('API key is not allowed to access company', {
      code: 'permission', reauth: false, scope: 'tenant',
    }));
    gz.inventory.set(good, [gzEndpoint(`ep-g-${sfx()}`, good, 'good-1', 'good-1.corp')]);

    await syncEdrInventory(fx.connectionId);

    const survivors = await adminRows<{ id: string }>(sql`SELECT id FROM edr_endpoints WHERE tenant_id = ${badTenant}::uuid`);
    expect(survivors.map((r) => r.id).sort()).toEqual([keptA, keptB].sort());
    expect((await tenantRow(fx.connectionId, bad)).last_inventory_sync_status).toBe('error');
    expect((await tenantRow(fx.connectionId, good)).last_inventory_sync_status).toBe('success');
    expect(await endpointsOf(fx.connectionId)).toHaveLength(3);
    expect(await connRow(fx.connectionId)).toMatchObject({
      status: 'connected', last_inventory_sync_status: 'partial', last_sync_failed_tenants: 1,
    });
  });

  runDb('vendor fetch happens with no held DB context (DB_CONTEXT_TRIPWIRE_STRICT=true)', async () => {
    const fx = await seedJob();
    const co = `co-trip-${sfx()}`;
    await fx.addTenant(co, fx.orgA.id);
    gz.companies = [{ id: co, name: 'Trip' }];
    gz.inventory.set(co, [gzEndpoint(`ep-t-${sfx()}`, co, 'trip-1', 'trip-1.corp')]);
    gz.incidents = [gzIncident(`inc-${sfx()}`, co, 1)];

    const prior = process.env.DB_CONTEXT_TRIPWIRE_STRICT;
    process.env.DB_CONTEXT_TRIPWIRE_STRICT = 'true';
    try {
      await syncEdrInventory(fx.connectionId);
      await syncEdrDetections(fx.connectionId);
    } finally {
      if (prior === undefined) delete process.env.DB_CONTEXT_TRIPWIRE_STRICT;
      else process.env.DB_CONTEXT_TRIPWIRE_STRICT = prior;
    }

    // The vendor really was called, from both streams, and never under a held context.
    expect(gz.calls).toEqual(expect.arrayContaining([`getInventoryAll:${co}`, 'getIncidentsChangedBetween']));
    expect(gz.heldCalls).toEqual([]);
    // Strict mode would have thrown into a tenant failure; both streams stayed clean.
    expect(await tenantRow(fx.connectionId, co)).toMatchObject({
      last_inventory_sync_status: 'success', last_detection_sync_status: 'success',
    });
    expect(await endpointsOf(fx.connectionId)).toHaveLength(1);
  });

  runDb('detection sync upserts idempotently across overlapping windows and advances only that tenant cursor', async () => {
    const fx = await seedJob();
    const mapped = `co-det-${sfx()}`;
    const other = `co-unmapped-${sfx()}`;
    await fx.addTenant(mapped, fx.orgA.id);
    await fx.addTenant(other, null);
    const incidentId = `inc-${sfx()}`;
    gz.incidents = [gzIncident(incidentId, mapped, 1), gzIncident(`inc-o-${sfx()}`, other, 1)];

    await syncEdrDetections(fx.connectionId);
    const first = await adminRows<Row>(sql`
      SELECT id, status, org_id FROM edr_detections WHERE connection_id = ${fx.connectionId}::uuid`);
    expect(first).toHaveLength(1); // the unmapped tenant's incident is never persisted
    expect(first[0]).toMatchObject({ status: 'open', org_id: fx.orgA.id });
    const cursor1 = (await tenantRow(fx.connectionId, mapped)).detection_cursor as string;
    expect(cursor1).toBeTruthy();
    expect((await tenantRow(fx.connectionId, other)).detection_cursor).toBeNull(); // unmapped: not fetched, not advanced

    // The vendor re-delivers the SAME incident (overlap window) with a new status.
    gz.incidents = [gzIncident(incidentId, mapped, 3)];
    await new Promise((r) => setTimeout(r, 20)); // distinct window end
    await syncEdrDetections(fx.connectionId);

    const second = await adminRows<Row>(sql`
      SELECT id, status FROM edr_detections WHERE connection_id = ${fx.connectionId}::uuid`);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ id: first[0]!.id, status: 'resolved' });
    const cursor2 = (await tenantRow(fx.connectionId, mapped)).detection_cursor as string;
    expect(cursor2).not.toBe(cursor1);
    // The second window started BEFORE the first cursor's end (5 min overlap), so nothing can fall in a gap.
    const parsed1 = JSON.parse(cursor1) as { incidentsChangedAfter: string };
    const w2 = gz.incidentWindows[gz.incidentWindows.length - 1]!;
    expect(w2.from.getTime()).toBe(Date.parse(parsed1.incidentsChangedAfter) - 5 * 60_000);
    expect((await tenantRow(fx.connectionId, other)).detection_cursor).toBeNull();
    expect(await connRow(fx.connectionId)).toMatchObject({ status: 'connected', last_detection_sync_status: 'success' });
  });

  runDb('a company missing from listTenants is tombstoned, not deleted; its endpoints go after 7 days', async () => {
    const fx = await seedJob();
    const stays = `co-stays-${sfx()}`;
    const gone = `co-gone-${sfx()}`;
    await fx.addTenant(stays, fx.orgA.id);
    const goneTenant = await fx.addTenant(gone, fx.orgA.id);
    const goneEndpoint = await fx.addEndpoint(goneTenant, fx.orgA.id, 'gone-ep', 'GONE-1');
    const [goneDetection] = await withSystemDbAccessContext(() => db.insert(edrDetections).values({
      connectionId: fx.connectionId, partnerId: fx.partner.id, orgId: fx.orgA.id, tenantId: goneTenant,
      endpointId: goneEndpoint, provider: 'bitdefender', vendorDetectionId: `det-${sfx()}`,
      vendorKind: 'incident', severity: 'high', status: 'open',
    }).returning({ id: edrDetections.id }));
    gz.companies = [{ id: stays, name: 'Stays' }]; // `gone` has left the vendor tree
    gz.inventory.set(stays, [gzEndpoint(`ep-s-${sfx()}`, stays, 'stays-1', 'stays-1.corp')]);

    await syncEdrInventory(fx.connectionId);

    const t1 = await tenantRow(fx.connectionId, gone);
    expect(t1.vendor_missing_since).not.toBeNull();
    expect(await adminRows(sql`SELECT 1 FROM edr_endpoints WHERE id = ${goneEndpoint}::uuid`)).toHaveLength(1);
    expect(await adminRows(sql`SELECT 1 FROM edr_detections WHERE id = ${goneDetection!.id}::uuid`)).toHaveLength(1);

    // A later run does not restart the clock, so a backdated stamp sticks; 6 days is inside retention.
    await admin().execute(sql`UPDATE edr_tenants SET vendor_missing_since = now() - interval '6 days' WHERE id = ${goneTenant}::uuid`);
    await syncEdrInventory(fx.connectionId);
    expect(await adminRows(sql`SELECT 1 FROM edr_endpoints WHERE id = ${goneEndpoint}::uuid`)).toHaveLength(1);

    // Past the retention window the endpoints go; the tenant row and its detections stay.
    await admin().execute(sql`UPDATE edr_tenants SET vendor_missing_since = now() - interval '8 days' WHERE id = ${goneTenant}::uuid`);
    await syncEdrInventory(fx.connectionId);
    expect(await adminRows(sql`SELECT 1 FROM edr_endpoints WHERE id = ${goneEndpoint}::uuid`)).toHaveLength(0);
    const t2 = await tenantRow(fx.connectionId, gone);
    expect(t2).toMatchObject({ endpoint_count: 0, org_id: fx.orgA.id });
    expect(t2.vendor_missing_since).not.toBeNull();
    expect(await adminRows(sql`SELECT 1 FROM edr_detections WHERE id = ${goneDetection!.id}::uuid`)).toHaveLength(1);
    expect((await endpointsOf(fx.connectionId)).filter((r) => r.vtid === stays)).toHaveLength(1);
  });
});

describe('edr sync — device lifecycle on sync-created links', () => {
  /** Inventory + detection sync link an endpoint and an open detection to the device; one action is added by hand. */
  async function syncedAndLinked() {
    const fx = await seedJob();
    const co = `co-link-${sfx()}`;
    const vendorEp = `ep-link-${sfx()}`;
    await fx.addTenant(co, fx.orgA.id);
    gz.companies = [{ id: co, name: 'Link' }];
    gz.inventory.set(co, [gzEndpoint(vendorEp, co, 'WS-01', 'ws-01.corp.example')]);
    gz.incidents = [gzIncident(`inc-${sfx()}`, co, 1, vendorEp)];
    await syncEdrInventory(fx.connectionId);
    await syncEdrDetections(fx.connectionId);
    const [endpoint] = await adminRows<{ id: string; breeze_device_id: string | null }>(sql`
      SELECT id, breeze_device_id FROM edr_endpoints WHERE connection_id = ${fx.connectionId}::uuid`);
    const [detection] = await adminRows<{ id: string; breeze_device_id: string | null; endpoint_id: string | null }>(sql`
      SELECT id, breeze_device_id, endpoint_id FROM edr_detections WHERE connection_id = ${fx.connectionId}::uuid`);
    // Premise: the REAL sync (not a seed) produced the links.
    expect(endpoint!.breeze_device_id).toBe(fx.deviceA.id);
    expect(detection).toMatchObject({ breeze_device_id: fx.deviceA.id, endpoint_id: endpoint!.id });
    const tenant = await tenantRow(fx.connectionId, co);
    const [action] = await withSystemDbAccessContext(() => db.insert(edrActions).values({
      connectionId: fx.connectionId, partnerId: fx.partner.id, orgId: fx.orgA.id,
      tenantId: tenant.id as string, endpointId: endpoint!.id,
      detectionId: detection!.id, breezeDeviceId: fx.deviceA.id, provider: 'bitdefender',
      action: 'isolate', requestedVia: 'ui', requestedBy: fx.user.id,
    } as typeof edrActions.$inferInsert).returning({ id: edrActions.id }));
    return { fx, endpoint: endpoint!, detection: detection!, action: action! };
  }

  runDb('device org-move detaches endpoint/detection/action links of sync-created rows and stamps last_site_id', async () => {
    // edrProviderRls.integration.test.ts already proves the engine on HAND-SEEDED
    // links; what this adds is that the rows produced by the real sync (match
    // source, detection->device refresh) are the ones the engine detaches, and
    // that the next sync does not re-link them across orgs.
    const { fx, endpoint, detection, action } = await syncedAndLinked();
    await withSystemDbAccessContext(() => db.transaction((tx) => moveDeviceOrgInTransaction(tx, {
      deviceId: fx.deviceA.id,
      sourceOrgId: fx.orgA.id,
      targetOrgId: fx.orgB.id,
      targetSiteId: fx.siteB.id,
      targetOrgName: 'target',
      deviceLinkGroupId: null,
      acceptCurrencyMismatch: false,
      actor: { userId: fx.user.id, allowedSiteIds: undefined },
      stepUp: null,
      via: 'generic_move',
    })));
    const [ep] = await adminRows<Row>(sql`SELECT org_id, breeze_device_id, device_match_source FROM edr_endpoints WHERE id = ${endpoint.id}::uuid`);
    expect(ep).toEqual({ org_id: fx.orgA.id, breeze_device_id: null, device_match_source: null });
    const [det] = await adminRows<Row>(sql`
      SELECT org_id, breeze_device_id, last_site_id, device_detached_at IS NOT NULL AS detached FROM edr_detections WHERE id = ${detection.id}::uuid`);
    expect(det).toEqual({ org_id: fx.orgA.id, breeze_device_id: null, last_site_id: fx.siteA.id, detached: true });
    const [act] = await adminRows<Row>(sql`SELECT org_id, breeze_device_id FROM edr_actions WHERE id = ${action.id}::uuid`);
    expect(act).toEqual({ org_id: fx.orgA.id, breeze_device_id: null });

    await syncEdrInventory(fx.connectionId);
    const [after] = await adminRows<Row>(sql`SELECT breeze_device_id FROM edr_endpoints WHERE id = ${endpoint.id}::uuid`);
    expect(after).toEqual({ breeze_device_id: null });
  });

  runDb('device hard delete stamps device_detached_at + last_site_id on sync-created detection links before the FK clears them', async () => {
    // edrProviderRls.integration.test.ts proves this for hand-seeded rows; this
    // runs it on rows produced by the real sync.
    const { fx, endpoint, detection } = await syncedAndLinked();
    await withSystemDbAccessContext(() => db.transaction(async (tx) => {
      await deleteDeviceCascade(tx as unknown as DeviceDeletionTx, fx.deviceA.id);
    }));
    const [det] = await adminRows<Row>(sql`
      SELECT breeze_device_id, last_site_id, device_detached_at IS NOT NULL AS detached, org_id
      FROM edr_detections WHERE id = ${detection.id}::uuid`);
    expect(det).toEqual({ breeze_device_id: null, last_site_id: fx.siteA.id, detached: true, org_id: fx.orgA.id });
    const [ep] = await adminRows<Row>(sql`SELECT breeze_device_id, device_match_source FROM edr_endpoints WHERE id = ${endpoint.id}::uuid`);
    expect(ep).toEqual({ breeze_device_id: null, device_match_source: null });
  });

  runDb('two connections may link the same device (per-connection uniqueness) via matchEdrEndpoints', async () => {
    const fx = await seedJob({ deviceHostname: 'shared-host.corp.example' });
    const t1 = await fx.addTenant(`co-m1-${sfx()}`, fx.orgA.id);
    const e1 = await fx.addEndpoint(t1, fx.orgA.id, 'm1', 'SHARED-HOST');
    // A second protection product (a different connection of the same partner) on the same device.
    const conn2 = await withSystemDbAccessContext(async () => {
      const [c] = await db.insert(edrConnections).values({
        partnerId: fx.partner.id, provider: 'sophos', name: `Sophos ${sfx()}`, credentialsEncrypted: 'enc:test',
      }).returning({ id: edrConnections.id });
      const [t] = await db.insert(edrTenants).values({
        connectionId: c!.id, partnerId: fx.partner.id, vendorTenantId: `sophos-${sfx()}`,
        vendorTenantName: 'Sophos T', orgId: fx.orgA.id, mappingSource: 'manual',
      }).returning({ id: edrTenants.id });
      const [e] = await db.insert(edrEndpoints).values({
        connectionId: c!.id, partnerId: fx.partner.id, orgId: fx.orgA.id, tenantId: t!.id,
        provider: 'sophos', vendorEndpointId: 'm2', hostname: 'shared-host',
      }).returning({ id: edrEndpoints.id });
      return { id: c!.id, endpointId: e!.id };
    });

    const r1 = await withSystemDbAccessContext(() => matchEdrEndpoints(db as never, fx.connectionId));
    const r2 = await withSystemDbAccessContext(() => matchEdrEndpoints(db as never, conn2.id));
    expect(r1).toMatchObject({ linked: 1, ambiguous: 0 });
    expect(r2).toMatchObject({ linked: 1, ambiguous: 0 });
    const linked = await adminRows<{ id: string; breeze_device_id: string }>(sql`
      SELECT id, breeze_device_id FROM edr_endpoints WHERE id IN (${e1}::uuid, ${conn2.endpointId}::uuid)`);
    expect(linked).toHaveLength(2);
    expect(linked.every((r) => r.breeze_device_id === fx.deviceA.id)).toBe(true);
  });
});
