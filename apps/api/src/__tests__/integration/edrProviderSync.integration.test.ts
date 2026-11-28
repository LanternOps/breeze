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
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  /** getEndpointDetails answers, by vendor endpoint id (the reconciler's live read, #12789). */
  endpointDetails: new Map<string, Record<string, unknown>>(),
  /** Runs once inside getInventoryAll: after the vendor read, before the sync writes. */
  inventoryHook: null as null | (() => Promise<void>),
  /** The key owner's account (#12821): its timezone reads offset-less vendor times; an Error is thrown. */
  account: { profile: { timezone: 'UTC' } } as Record<string, unknown> | Error,
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
      const items = gz.inventory.get(companyId) ?? [];
      if (gz.inventoryHook) { const h = gz.inventoryHook; gz.inventoryHook = null; await h(); }
      return items;
    }
    async getInventoryTotal(companyId: string) {
      this.note(`getInventoryTotal:${companyId}`);
      return (gz.inventory.get(companyId) ?? []).length;
    }
    async getEndpointDetails(id: string) { this.note('getEndpointDetails'); return gz.endpointDetails.get(id) ?? {}; }
    async getAccountDetails() {
      this.note('getAccountDetails');
      if (gz.account instanceof Error) throw gz.account;
      return gz.account;
    }
    async getIncidentsChangedBetween(from: Date, to: Date) {
      this.note('getIncidentsChangedBetween');
      gz.incidentWindows.push({ from, to });
      if (midFetch.hook) { const h = midFetch.hook; midFetch.hook = null; await h(); }
      return gz.incidents;
    }
    async getQuarantineBetween() { this.note('getQuarantineBetween'); return []; }
  }
  return { ...actual, GravityZoneClient: FakeGravityZoneClient };
});
// #8166 Phase 4: record published events instead of hitting the bus.
const published = vi.hoisted(() => [] as Array<{ type: string; payload: Record<string, unknown> }>);
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return {
    ...actual,
    publishEvent: vi.fn(async (type: string, _orgId: string, payload: Record<string, unknown>) => {
      published.push({ type, payload });
      return 'event-id';
    }),
  };
});
// W03 PR-B: record queue enqueues (a hint rerun) instead of touching BullMQ.
const enqueued = vi.hoisted(() => [] as string[]);
vi.mock('../../services/bullmqUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/bullmqUtils')>();
  return {
    ...actual,
    enqueueOrReplaceStale: vi.fn(async (_q: unknown, _name: string, jobId: string) => {
      enqueued.push(jobId);
      return { id: jobId };
    }),
  };
});
// A seam the hint cases use to land a push in the middle of a run's vendor fetch.
const midFetch = vi.hoisted(() => ({ hook: null as null | (() => Promise<void>) }));
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
import { __testOnly, syncEdrDetections, syncEdrInventory } from '../../jobs/edrProviderSync';
import { pollEdrActionStatus } from '../../services/edrProviders/actionStatus';
import { recordEdrHint } from '../../services/edrProviders/hints';
import { encryptEdrSecret } from '../../services/edrProviders/credentials';
import { matchEdrEndpoints } from '../../services/edrProviders/deviceMatching';
import { EdrProviderRequestError } from '../../services/edrProviders/types';
import { deleteDeviceCascade, type DeviceDeletionTx } from '../../services/deviceDeletion';
import { moveDeviceOrgInTransaction } from '../../services/deviceOrgMove/moveDeviceOrgInTransaction';
import { getTestDb } from './setup';
import { replayMigration } from './replayMigration';
import { remapEdrTenant } from '../../services/edrProviders/mapping';
import { applyDetectionStatusUpdates, loadOpenDetectionRefs, persistDetections, persistInventory } from '../../services/edrProviders/persist';
import { evaluateEdrAlerts, evaluateEdrEndpointHealth } from '../../services/edrProviders/alerts';
import type { VendorEdrDetection } from '../../services/edrProviders/types';
import { __testOnly as gzAdapterTestOnly, bitdefenderAdapter } from '../../services/edrProviders/bitdefender/adapter';

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
  gz.endpointDetails = new Map();
  gz.inventoryHook = null;
  gz.account = { profile: { timezone: 'UTC' } };
  // Every seeded connection uses the same key, so the adapter's per-key "failing since" record is reset too.
  gzAdapterTestOnly.resetAccountReadFailures();
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

  runDb('#12821: an offset-less lastSeen is stored in UTC from the key owner timezone, and as null when that cannot be read', async () => {
    const fx = await seedJob();
    const co = `co-tz-${sfx()}`;
    await fx.addTenant(co, fx.orgA.id);
    const vep = `ep-tz-${sfx()}`;
    gz.companies = [{ id: co, name: `Tz ${sfx()}` }];
    gz.inventory.set(co, [gzEndpoint(vep, co, 'WS-TZ', 'ws-tz.corp.example')]);
    // Live shape: a personal key owned by a New York account sends New York wall time, no offset.
    gz.endpointDetails.set(vep, { state: 1, lastSeen: '2026-11-27T17:17:34', agent: { productVersion: '8.26.11.679' } });
    gz.account = { profile: { timezone: 'America/New_York' } };

    await syncEdrInventory(fx.connectionId);
    const [row] = (await endpointsOf(fx.connectionId)).filter((r) => r.vendor_endpoint_id === vep);
    expect(new Date(row!.last_seen_at as string).toISOString()).toBe('2026-11-27T22:17:34.000Z');

    // A key without the Accounts API: the time is not stored rather than stored five hours off.
    gz.account = new EdrProviderRequestError('GravityZone accounts.getAccountDetails failed', {
      code: 'api_not_enabled', reauth: false, scope: 'operation',
    });
    await withSystemDbAccessContext(() => db.update(edrEndpoints).set({ vendorDetailSyncedAt: null }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await syncEdrInventory(fx.connectionId);
    } finally {
      warn.mockRestore();
    }
    const [after] = (await endpointsOf(fx.connectionId)).filter((r) => r.vendor_endpoint_id === vep);
    expect(after!.last_seen_at).toBeNull();
    expect(after!.agent_version).toBe('8.26.11.679');
    expect(await tenantRow(fx.connectionId, co)).toMatchObject({ last_inventory_sync_status: 'success' });
  });

  runDb('#12825: an endpoint not re-read in a run keeps its detail-owned fields (last seen, health, online, agent version)', async () => {
    const fx = await seedJob();
    const co = `co-many-${sfx()}`;
    await fx.addTenant(co, fx.orgA.id);
    // One more endpoint than a run enriches (DETAIL_ENRICH_PER_RUN = 50), so each run leaves one out.
    const ids = Array.from({ length: 51 }, (_, i) => `ep-many-${String(i).padStart(2, '0')}-${sfx()}`);
    gz.companies = [{ id: co, name: `Many ${sfx()}` }];
    gz.inventory.set(co, ids.map((id, i) => gzEndpoint(id, co, `WS-M${i}`, `ws-m${i}.corp.example`)));
    for (const id of ids) {
      gz.endpointDetails.set(id, { state: 1, lastSeen: '2026-11-27T22:17:34', agent: { productVersion: '8.26.11.679' } });
    }

    const enrichedIn = async (run: () => Promise<unknown>) => {
      gz.calls = [];
      await run();
      return gz.calls.filter((c) => c === 'getEndpointDetails').length;
    };
    // Run 1 enriches the first 50 new endpoints; run 2 the one left out plus the 49 stalest.
    expect(await enrichedIn(() => syncEdrInventory(fx.connectionId))).toBe(50);
    expect(await enrichedIn(() => syncEdrInventory(fx.connectionId))).toBe(50);

    const rows = await endpointsOf(fx.connectionId);
    expect(rows).toHaveLength(51);
    // Every endpoint has been read once within ceil(51 / 50) = 2 runs, and none was cleared by the
    // list upsert of a run that did not re-read it.
    expect(rows.filter((r) => r.vendor_detail_synced_at === null)).toEqual([]);
    for (const r of rows) {
      expect({
        id: r.vendor_endpoint_id,
        lastSeen: r.last_seen_at === null ? null : new Date(r.last_seen_at as string).toISOString(),
        health: r.health, online: r.online, agent: r.agent_version,
      }).toEqual({ id: r.vendor_endpoint_id, lastSeen: '2026-11-27T22:17:34.000Z', health: 'healthy', online: true, agent: '8.26.11.679' });
    }
  });

  runDb('#12825: a run whose account read fails transiently keeps the stored last seen ("unset" keeps the value, #12821)', async () => {
    const fx = await seedJob();
    const co = `co-keep-${sfx()}`;
    await fx.addTenant(co, fx.orgA.id);
    const vep = `ep-keep-${sfx()}`;
    gz.companies = [{ id: co, name: `Keep ${sfx()}` }];
    gz.inventory.set(co, [gzEndpoint(vep, co, 'WS-KEEP', 'ws-keep.corp.example')]);
    gz.endpointDetails.set(vep, { state: 1, lastSeen: '2026-11-27T17:17:34', agent: { productVersion: '8.26.11.679' } });
    gz.account = { profile: { timezone: 'America/New_York' } };
    await syncEdrInventory(fx.connectionId);
    const [stored] = (await endpointsOf(fx.connectionId)).filter((r) => r.vendor_endpoint_id === vep);
    expect(new Date(stored!.last_seen_at as string).toISOString()).toBe('2026-11-27T22:17:34.000Z');

    gz.account = new EdrProviderRequestError('GravityZone accounts.getAccountDetails failed: Server error', {
      code: 'vendor_error', reauth: false, scope: 'operation',
    });
    gz.endpointDetails.set(vep, { state: 1, lastSeen: '2026-11-27T18:00:00', agent: { productVersion: '8.26.11.679' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      gz.calls = [];
      await syncEdrInventory(fx.connectionId);
    } finally {
      warn.mockRestore();
    }
    expect(gz.calls).toContain('getEndpointDetails');
    const [after] = (await endpointsOf(fx.connectionId)).filter((r) => r.vendor_endpoint_id === vep);
    expect(after!.last_seen_at === null ? null : new Date(after!.last_seen_at as string).toISOString()).toBe('2026-11-27T22:17:34.000Z');
    expect(await tenantRow(fx.connectionId, co)).toMatchObject({ last_inventory_sync_status: 'success' });
  });

  runDb('#12825 data step: clears GravityZone last seen times stored before the UTC fix, once, and queues those endpoints first', async () => {
    const FILE = '2027-02-01-100000-gravityzone-clear-pre-utc-last-seen.sql';
    const fx = await seedJob();
    const co = `co-clear-${sfx()}`;
    const tenantId = await fx.addTenant(co, fx.orgA.id);
    // 51 endpoints, one more than a run enriches. Before the fix only the batch read last held a
    // time (each list upsert nulled the rest), so the misread rows are the most recently read ones.
    const ids = Array.from({ length: 51 }, (_, i) => `ep-clear-${String(i).padStart(2, '0')}-${sfx()}`);
    const misread = ids[50]!;
    const unknownTime = ids[49]!;
    for (const id of ids) await fx.addEndpoint(tenantId, fx.orgA.id, id, id);
    const set = (id: string, lastSeen: string | null, synced: string | null) => admin().execute(sql`
      UPDATE edr_endpoints SET last_seen_at = ${lastSeen}::timestamptz, vendor_detail_synced_at = ${synced}::timestamptz
       WHERE connection_id = ${fx.connectionId}::uuid AND vendor_endpoint_id = ${id}
    `);
    for (const [i, id] of ids.entries()) {
      await set(id, null, `2026-11-27T${10 + Math.floor(i / 10)}:0${i % 10}:00Z`);
    }
    // A New York key's 17:17:34 wall time read as UTC (5 h early), from the last run before the deploy.
    await set(misread, '2026-11-27T17:17:34Z', '2026-11-27T20:00:00Z');
    // A row with no stored time keeps its place in the rotation.
    await set(unknownTime, null, '2026-11-27T19:00:00Z');
    // Another provider's time is not touched.
    const emsiConn = randomUUID();
    await withSystemDbAccessContext(() => db.insert(edrConnections).values({
      id: emsiConn, partnerId: fx.partner.id, provider: 'emsisoft', name: `Emsisoft ${sfx()}`,
      credentialsEncrypted: 'enc:test', vendorRootId: 'root-emsi', vendorRootType: 'partner',
    }));
    const emsiTenant = await withSystemDbAccessContext(async () => (await db.insert(edrTenants).values({
      connectionId: emsiConn, partnerId: fx.partner.id, vendorTenantId: randomUUID(), vendorTenantName: `WS ${sfx()}`,
      vendorTenantType: 'workspace', orgId: fx.orgA.id, mappingSource: 'manual',
    }).returning({ id: edrTenants.id }))[0]!.id);
    await withSystemDbAccessContext(() => db.insert(edrEndpoints).values({
      connectionId: emsiConn, partnerId: fx.partner.id, orgId: fx.orgA.id, tenantId: emsiTenant, provider: 'emsisoft',
      vendorEndpointId: 'em-keep', hostname: 'pc-keep',
      lastSeenAt: new Date('2026-11-27T17:17:34Z'), vendorDetailSyncedAt: new Date('2026-11-27T20:00:00Z'),
    }));
    const rowOf = async (connectionId: string, vendorEndpointId: string) => {
      const [r] = await adminRows<Row>(sql`
        SELECT last_seen_at, vendor_detail_synced_at FROM edr_endpoints
         WHERE connection_id = ${connectionId}::uuid AND vendor_endpoint_id = ${vendorEndpointId}
      `);
      const iso = (v: unknown) => (v === null ? null : new Date(v as string).toISOString());
      return { lastSeen: iso(r!.last_seen_at), synced: iso(r!.vendor_detail_synced_at) };
    };

    // First application, as autoMigrate runs it: the file's own ledger row is written after it.
    const [ledger] = await adminRows<{ checksum: string; applied_at: string }>(sql`
      SELECT checksum, applied_at::text AS applied_at FROM breeze_migrations WHERE filename = ${FILE}
    `);
    await admin().execute(sql`DELETE FROM breeze_migrations WHERE filename = ${FILE}`);
    try {
      await replayMigration(FILE);
      expect(await rowOf(fx.connectionId, misread)).toEqual({ lastSeen: null, synced: null });
      expect(await rowOf(fx.connectionId, unknownTime)).toEqual({ lastSeen: null, synced: '2026-11-27T19:00:00.000Z' });
      expect(await rowOf(emsiConn, 'em-keep')).toEqual({ lastSeen: '2026-11-27T17:17:34.000Z', synced: '2026-11-27T20:00:00.000Z' });

      // A replay once the ledger holds the file (a manual psql -f, an integration replay) changes nothing.
      await admin().execute(sql`
        INSERT INTO breeze_migrations (filename, checksum, applied_at)
        VALUES (${FILE}, ${ledger?.checksum ?? 'test-ledger-row'}, COALESCE(${ledger?.applied_at ?? null}::timestamptz, now()))
      `);
      await set(ids[0]!, '2026-11-27T22:17:34Z', '2026-11-27T21:00:00Z');
      await replayMigration(FILE);
      expect(await rowOf(fx.connectionId, ids[0]!)).toEqual({ lastSeen: '2026-11-27T22:17:34.000Z', synced: '2026-11-27T21:00:00.000Z' });
    } finally {
      if (!ledger) await admin().execute(sql`DELETE FROM breeze_migrations WHERE filename = ${FILE}`);
      else {
        await admin().execute(sql`
          INSERT INTO breeze_migrations (filename, checksum, applied_at)
          VALUES (${FILE}, ${ledger.checksum}, ${ledger.applied_at}::timestamptz) ON CONFLICT DO NOTHING
        `);
      }
    }
    await set(ids[0]!, null, '2026-11-27T10:00:00Z');

    // The next run reads the cleared endpoint first (NULLS FIRST) and stores its time in UTC.
    gz.companies = [{ id: co, name: `Clear ${sfx()}` }];
    gz.inventory.set(co, ids.map((id, i) => gzEndpoint(id, co, `WS-C${i}`, `ws-c${i}.corp.example`)));
    for (const id of ids) gz.endpointDetails.set(id, { state: 1, lastSeen: '2026-11-27T17:17:34', agent: { productVersion: '8.26.11.679' } });
    gz.account = { profile: { timezone: 'America/New_York' } };
    await syncEdrInventory(fx.connectionId);
    const after = await rowOf(fx.connectionId, misread);
    expect(after.lastSeen).toBe('2026-11-27T22:17:34.000Z');
    expect(after.synced).not.toBeNull();
    // The 50-per-run cap still holds: the freshest of the others waits for the next run.
    expect(await rowOf(fx.connectionId, unknownTime)).toEqual({ lastSeen: null, synced: '2026-11-27T19:00:00.000Z' });
  });

  runDb('#12821: after a confirmed release, an account read failing transiently does not fail inventory: isolation_state goes not_isolated and isolate is offered', async () => {
    const fx = await seedJob();
    const co = `co-rel-${sfx()}`;
    const tenantId = await fx.addTenant(co, fx.orgA.id);
    const vep = `ep-rel-${sfx()}`;
    gz.companies = [{ id: co, name: `Rel ${sfx()}` }];
    gz.inventory.set(co, [gzEndpoint(vep, co, 'WS-REL', 'ws-rel.corp.example', { isIsolated: true })]);
    gz.endpointDetails.set(vep, { state: 1, lastSeen: '2026-11-27T17:17:34', agent: { productVersion: '8.26.11.679' } });
    await syncEdrInventory(fx.connectionId);
    const [isolated] = (await endpointsOf(fx.connectionId)).filter((r) => r.vendor_endpoint_id === vep);
    expect(isolated!.isolation_state).toBe('isolated');
    const endpointId = isolated!.id as string;

    // The release is requested, accepted, and confirmed by a live read.
    const [release] = await withSystemDbAccessContext(() => db.insert(edrActions).values({
      connectionId: fx.connectionId, partnerId: fx.partner.id, orgId: fx.orgA.id, tenantId, endpointId,
      provider: 'bitdefender', action: 'unisolate', status: 'submitted', requestedVia: 'ui', requestedBy: fx.user.id,
      submittedAt: new Date(), payload: { target: { kind: 'endpoint', vendorEndpointId: vep } },
    } as typeof edrActions.$inferInsert).returning({ id: edrActions.id }));
    gz.endpointDetails.set(vep, { ...gz.endpointDetails.get(vep), isIsolated: false });
    expect(await pollEdrActionStatus(fx.connectionId, new Date())).toMatchObject({ checked: 1, settled: 1 });
    expect((await adminRows<{ status: string }>(sql`SELECT status FROM edr_actions WHERE id = ${release!.id}::uuid`))[0]!.status)
      .toBe('succeeded');

    // Next inventory run: the vendor lists the endpoint released; the account read fails transiently.
    gz.inventory.set(co, [gzEndpoint(vep, co, 'WS-REL', 'ws-rel.corp.example', { isIsolated: false })]);
    gz.account = new EdrProviderRequestError('GravityZone accounts.getAccountDetails failed: Server error', {
      code: 'vendor_error', reauth: false, scope: 'operation',
    });
    await withSystemDbAccessContext(() => db.update(edrEndpoints).set({ vendorDetailSyncedAt: null })
      .where(sql`${edrEndpoints.connectionId} = ${fx.connectionId}::uuid`));
    gz.calls = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await syncEdrInventory(fx.connectionId);
    } finally {
      warn.mockRestore();
    }
    expect(gz.calls).toContain('getAccountDetails');
    expect(await tenantRow(fx.connectionId, co)).toMatchObject({ last_inventory_sync_status: 'success' });
    const [after] = (await endpointsOf(fx.connectionId)).filter((r) => r.vendor_endpoint_id === vep);
    expect(after).toMatchObject({ isolation_state: 'not_isolated', agent_version: '8.26.11.679' });
    // The action check reads exactly this column.
    expect(bitdefenderAdapter.supportsAction!({
      vendorEndpointId: vep, osPlatform: after!.os_platform as never, isolationState: after!.isolation_state as never,
      online: after!.online as boolean | null, tenantUnsupportedActions: [], connectionCapabilityNotes: [],
    }, 'isolate')).toEqual({ ok: true });
  });

  runDb('#12821: a detection sync whose account read fails transiently still stores new detections and status changes; stored times are kept, a new row has none', async () => {
    const fx = await seedJob();
    const co = `co-dtz-${sfx()}`;
    await fx.addTenant(co, fx.orgA.id);
    const offsetless = (id: string, status: number) => ({
      ...gzIncident(id, co, status), created: '2026-11-25T16:26:45', lastIncidentChange: '2026-11-25T16:29:18',
    });
    const known = `inc-k-${sfx()}`;
    gz.account = { profile: { timezone: 'America/New_York' } };
    gz.incidents = [offsetless(known, 1)];
    await syncEdrDetections(fx.connectionId);
    const byVendorId = async () => new Map((await adminRows<Row>(sql`
      SELECT vendor_detection_id, status, detected_at, resolved_at, last_vendor_update_at
      FROM edr_detections WHERE connection_id = ${fx.connectionId}::uuid`)).map((r) => [r.vendor_detection_id as string, r]));
    const iso = (v: unknown) => (v === null ? null : new Date(v as string).toISOString());
    const first = (await byVendorId()).get(known)!;
    expect([iso(first.detected_at), iso(first.last_vendor_update_at)]).toEqual(['2026-11-25T21:26:45.000Z', '2026-11-25T21:29:18.000Z']);
    const cursor1 = (await tenantRow(fx.connectionId, co)).detection_cursor;

    // Next run: the account read fails; the known incident is closed and a new one appears.
    gz.account = new EdrProviderRequestError('GravityZone accounts.getAccountDetails failed: Server error', {
      code: 'vendor_error', reauth: false, scope: 'operation',
    });
    const fresh = `inc-n-${sfx()}`;
    gz.incidents = [offsetless(known, 3), offsetless(fresh, 1)];
    await new Promise((r) => setTimeout(r, 20)); // distinct window end
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await syncEdrDetections(fx.connectionId);
    } finally {
      warn.mockRestore();
    }
    const rows = await byVendorId();
    const k = rows.get(known)!;
    expect(k.status).toBe('resolved');
    // Stored times kept, not nulled and not guessed.
    expect([iso(k.detected_at), iso(k.last_vendor_update_at)]).toEqual(['2026-11-25T21:26:45.000Z', '2026-11-25T21:29:18.000Z']);
    const n = rows.get(fresh)!;
    expect(n).toMatchObject({ status: 'open', detected_at: null, last_vendor_update_at: null });
    const tenant = await tenantRow(fx.connectionId, co);
    expect(tenant.detection_cursor).not.toBe(cursor1);
    expect(tenant).toMatchObject({ last_detection_sync_status: 'partial' });
    expect(tenant.last_detection_sync_error).toContain('incidents: times not updated (account timezone read failed)');
  });

  runDb('#12789: a sync that read the vendor BEFORE an isolate and wrote AFTER it does not confirm it; a live read after the request does', async () => {
    const fx = await seedJob();
    const co = `co-iso-${sfx()}`;
    const tenantId = await fx.addTenant(co, fx.orgA.id);
    const vep = `ep-iso-${sfx()}`;
    const endpointId = await fx.addEndpoint(tenantId, fx.orgA.id, vep, 'WS-ISO');
    gz.companies = [{ id: co, name: `Iso ${sfx()}` }];
    // What the sync's vendor read sees: the endpoint isolated (state from before the request).
    gz.inventory.set(co, [gzEndpoint(vep, co, 'WS-ISO', 'ws-iso.corp.example', { isIsolated: true })]);
    let actionId = '';
    // The isolate is requested and accepted AFTER that read, BEFORE the sync writes.
    gz.inventoryHook = async () => {
      const [row] = await withSystemDbAccessContext(() => db.insert(edrActions).values({
        connectionId: fx.connectionId, partnerId: fx.partner.id, orgId: fx.orgA.id, tenantId, endpointId,
        provider: 'bitdefender', action: 'isolate', status: 'submitted', requestedVia: 'ui', requestedBy: fx.user.id,
        submittedAt: new Date(), payload: { target: { kind: 'endpoint', vendorEndpointId: vep } },
      } as typeof edrActions.$inferInsert).returning({ id: edrActions.id }));
      actionId = row!.id;
    };

    await syncEdrInventory(fx.connectionId);

    // Premise: the sync's write is stamped after the request and recorded the endpoint isolated.
    const [action] = await adminRows<{ status: string; submitted_at: Date }>(sql`
      SELECT status, submitted_at FROM edr_actions WHERE id = ${actionId}::uuid`);
    const tenant = await tenantRow(fx.connectionId, co);
    expect(new Date(tenant.last_inventory_sync_at as string).getTime()).toBeGreaterThan(new Date(action!.submitted_at).getTime());
    const [endpoint] = await adminRows<{ isolation_state: string }>(sql`
      SELECT isolation_state FROM edr_endpoints WHERE id = ${endpointId}::uuid`);
    expect(endpoint!.isolation_state).toBe('isolated');

    // The live read (after the request) does not show the endpoint isolated: not confirmed.
    gz.endpointDetails.set(vep, { isIsolated: false });
    expect(await pollEdrActionStatus(fx.connectionId, new Date())).toMatchObject({ checked: 1, settled: 0 });
    expect((await adminRows<{ status: string }>(sql`SELECT status FROM edr_actions WHERE id = ${actionId}::uuid`))[0]!.status)
      .toBe('submitted');

    // A live read showing it isolated confirms it.
    gz.endpointDetails.set(vep, { isIsolated: true });
    expect(await pollEdrActionStatus(fx.connectionId, new Date())).toMatchObject({ checked: 1, settled: 1 });
    expect((await adminRows<{ status: string }>(sql`SELECT status FROM edr_actions WHERE id = ${actionId}::uuid`))[0]!.status)
      .toBe('succeeded');
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

  // #8166 A6 / Review Focus 1: the first detection sync back-fills history
  // without paging; a detection first seen on a LATER sync publishes once; a
  // re-run publishes nothing.
  runDb('Phase 4: first-sync back-fill is stamped silently; a later new detection publishes exactly once', async () => {
    const fx = await seedJob();
    const mapped = `co-p4-${sfx()}`;
    await fx.addTenant(mapped, fx.orgA.id);
    const detectionEvents = () => published.filter((e) => e.type.startsWith('edr.detection_'));
    published.length = 0;

    gz.incidents = [{ ...gzIncident(`inc-old-${sfx()}`, mapped, 1), severityScore: 95 }];
    await syncEdrDetections(fx.connectionId);
    const backfill = await adminRows<Row>(sql`
      SELECT severity, notified_severity FROM edr_detections WHERE connection_id = ${fx.connectionId}::uuid`);
    expect(backfill).toHaveLength(1);
    expect(backfill[0]).toMatchObject({ severity: 'critical', notified_severity: 'critical' });
    expect(detectionEvents()).toHaveLength(0);

    const freshId = `inc-new-${sfx()}`;
    // Seen now (inside the 24 h notify horizon) and critical.
    gz.incidents = [{ ...gzIncident(freshId, mapped, 1), severityScore: 95, created: new Date().toISOString() }];
    await new Promise((r) => setTimeout(r, 20));
    await syncEdrDetections(fx.connectionId);
    const [fresh] = await adminRows<Row>(sql`
      SELECT id, severity, notified_severity FROM edr_detections
      WHERE connection_id = ${fx.connectionId}::uuid AND vendor_detection_id LIKE ${'%' + freshId + '%'}`);
    expect(fresh).toBeDefined();
    expect(fresh!.notified_severity).toBe(fresh!.severity);
    expect(fresh!.severity).toBe('critical');
    expect(detectionEvents()).toHaveLength(1);
    expect(detectionEvents()[0]).toMatchObject({
      type: 'edr.detection_detected', payload: { detectionId: fresh!.id, provider: 'bitdefender', severity: 'critical' },
    });

    await new Promise((r) => setTimeout(r, 20));
    await syncEdrDetections(fx.connectionId);
    expect(detectionEvents()).toHaveLength(1);
  });

  // #8166 A6: a linked detection raises ONE device alert (deduped across runs);
  // when the vendor closes it, the next evaluation resolves the alert.
  runDb('Phase 4: linked detection alert is raised once and resolves when the detection closes', async () => {
    const fx = await seedJob();
    const tenantId = await fx.addTenant(`co-al-${sfx()}`, fx.orgA.id, { lastDetectionSyncAt: new Date() });
    const [det] = await withSystemDbAccessContext(() => db.insert(edrDetections).values({
      connectionId: fx.connectionId, partnerId: fx.partner.id, orgId: fx.orgA.id, tenantId, provider: 'bitdefender',
      vendorDetectionId: `inc-al-${sfx()}`, vendorKind: 'incident', severity: 'critical', status: 'open',
      breezeDeviceId: fx.deviceA.id, title: 'Trojan', detectedAt: new Date(),
    }).returning({ id: edrDetections.id }));
    const openAlerts = () => adminRows<Row>(sql`
      SELECT id, status, severity FROM alerts
      WHERE context->>'source' = 'edr_provider' AND context->>'detectionId' = ${det!.id}`);

    expect(await evaluateEdrAlerts(fx.connectionId, { now: new Date() })).toEqual({ published: 1, suppressed: 0 });
    const raised = await openAlerts();
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ status: 'active', severity: 'critical' });
    expect(await evaluateEdrAlerts(fx.connectionId, { now: new Date() })).toEqual({ published: 0, suppressed: 0 });
    expect(await openAlerts()).toHaveLength(1);

    await admin().execute(sql`UPDATE edr_detections SET status = 'resolved' WHERE id = ${det!.id}::uuid`);
    await evaluateEdrAlerts(fx.connectionId, { now: new Date() });
    const after = await openAlerts();
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe('resolved');
  });

  // #12825: a detection with no vendor time and an unknown status is held, not consumed: it raises
  // nothing while unknown, and alerts exactly once when the vendor later calls it open, however old.
  // A row with a vendor time is decided by that time, as before.
  runDb('Phase 4 #12825: a held no-time unknown detection alerts once when it turns open; a timed one is unchanged', async () => {
    const fx = await seedJob();
    const tenantId = await fx.addTenant(`co-hold-${sfx()}`, fx.orgA.id, { lastDetectionSyncAt: new Date() });
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3_600_000);
    const [held, timed] = await withSystemDbAccessContext(() => db.insert(edrDetections).values([
      {
        connectionId: fx.connectionId, partnerId: fx.partner.id, orgId: fx.orgA.id, tenantId, provider: 'bitdefender',
        vendorDetectionId: `q-hold-${sfx()}`, vendorKind: 'quarantine_item', severity: 'high', status: 'unknown',
        breezeDeviceId: fx.deviceA.id, title: 'Quarantined file', detectedAt: null, createdAt: tenDaysAgo,
      },
      {
        connectionId: fx.connectionId, partnerId: fx.partner.id, orgId: fx.orgA.id, tenantId, provider: 'bitdefender',
        vendorDetectionId: `inc-old-${sfx()}`, vendorKind: 'incident', severity: 'high', status: 'unknown',
        breezeDeviceId: fx.deviceA.id, title: 'Old', detectedAt: tenDaysAgo, createdAt: tenDaysAgo,
      },
    ]).returning({ id: edrDetections.id }));
    const notified = async (id: string) => (await adminRows<Row>(sql`
      SELECT notified_severity FROM edr_detections WHERE id = ${id}::uuid`))[0]!.notified_severity;
    const alertsFor = (id: string) => adminRows<Row>(sql`
      SELECT id FROM alerts WHERE context->>'source' = 'edr_provider' AND context->>'detectionId' = ${id}`);

    expect(await evaluateEdrAlerts(fx.connectionId, { now: new Date() })).toEqual({ published: 0, suppressed: 1 });
    expect(await notified(held!.id)).toBe('unknown');
    expect(await notified(timed!.id)).toBe('high');
    expect(await alertsFor(held!.id)).toHaveLength(0);

    // Still unknown: nothing.
    expect(await evaluateEdrAlerts(fx.connectionId, { now: new Date() })).toEqual({ published: 0, suppressed: 0 });
    expect(await notified(held!.id)).toBe('unknown');

    await admin().execute(sql`UPDATE edr_detections SET status = 'open' WHERE id = ${held!.id}::uuid`);
    expect(await evaluateEdrAlerts(fx.connectionId, { now: new Date() })).toEqual({ published: 1, suppressed: 0 });
    expect(await notified(held!.id)).toBe('high');
    expect(await alertsFor(held!.id)).toHaveLength(1);
    expect(await evaluateEdrAlerts(fx.connectionId, { now: new Date() })).toEqual({ published: 0, suppressed: 0 });
    expect(await alertsFor(held!.id)).toHaveLength(1);
    expect(await alertsFor(timed!.id)).toHaveLength(0);
  });

  // #8166 review: endpoint-health alerts are bounded per run, raised once per
  // endpoint, and resolve when the vendor reports the endpoint healthy again.
  runDb('Phase 4: endpoint-health alerts are capped per run, deduped, and resolve on recovery', async () => {
    const fx = await seedJob();
    const tenantId = await fx.addTenant(`co-eh-${sfx()}`, fx.orgA.id);
    const deviceB = await fx.mkDevice(fx.orgA.id, fx.siteA.id, `eh-b-${sfx()}`);
    const devices2 = [fx.deviceA.id, deviceB.id];
    const endpointIds: string[] = [];
    for (const [i, deviceId] of devices2.entries()) {
      const id = await fx.addEndpoint(tenantId, fx.orgA.id, `ep-eh-${i}-${sfx()}`, `EH-${i}`);
      await admin().execute(sql`UPDATE edr_endpoints SET breeze_device_id = ${deviceId}::uuid, health = 'unhealthy' WHERE id = ${id}::uuid`);
      endpointIds.push(id);
    }
    const healthAlerts = () => adminRows<Row>(sql`
      SELECT status, context->>'endpointId' AS endpoint_id FROM alerts
      WHERE context->>'source' = 'edr_provider' AND context->>'kind' = 'endpoint_health'
        AND context->>'connectionId' = ${fx.connectionId}`);

    expect(await evaluateEdrEndpointHealth(fx.connectionId, { maxAlertsPerRun: 1 })).toEqual({ raised: 1, resolved: 0 });
    expect(await healthAlerts()).toHaveLength(1);
    expect(await evaluateEdrEndpointHealth(fx.connectionId, { maxAlertsPerRun: 1 })).toEqual({ raised: 1, resolved: 0 });
    expect(await evaluateEdrEndpointHealth(fx.connectionId, { maxAlertsPerRun: 1 })).toEqual({ raised: 0, resolved: 0 });
    expect(await healthAlerts()).toHaveLength(2);

    await admin().execute(sql`UPDATE edr_endpoints SET health = 'healthy' WHERE id = ${endpointIds[0]!}::uuid`);
    expect(await evaluateEdrEndpointHealth(fx.connectionId)).toEqual({ raised: 0, resolved: 1 });
    const after = await healthAlerts();
    expect(after.find((a) => a.endpoint_id === endpointIds[0])!.status).toBe('resolved');
    expect(after.find((a) => a.endpoint_id === endpointIds[1])!.status).toBe('active');
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

describe('edr push hints — durable marker against Postgres (W03 PR-B)', () => {
  // A hook left armed by a case whose fetch path did not fire must not leak.
  beforeEach(() => { midFetch.hook = null; });
  const rerunId = (id: string) => `edr-detections-${id}-rerun`;
  const marker = async (id: string) => (await adminRows<{ m: string | null }>(sql`
    SELECT pending_hint_at::text AS m FROM edr_connections WHERE id = ${id}::uuid`))[0]!.m;
  const enablePush = (id: string) => admin().execute(sql`UPDATE edr_connections SET push_enabled = true WHERE id = ${id}::uuid`);

  runDb('a hint recorded BEFORE the run is cleared by the run (microsecond-exact CAS) and queues no rerun', async () => {
    const fx = await seedJob();
    await fx.addTenant(`co-${sfx()}`, fx.orgA.id);
    await enablePush(fx.connectionId);
    expect(await recordEdrHint(fx.connectionId, [{ vendorTenantId: 'x' }], null)).toBe(true);
    // Force a non-zero microsecond component so a JS-Date (ms) compare could never match it. The fraction is
    // pinned to .123456 (from a second-truncated now()) rather than now() + 123 µs: Postgres trims trailing
    // fractional zeros in the text form, so a now() whose microseconds happened to end in 7 rendered only
    // 4–5 digits and failed the six-digit assertion about one run in ten (#9048).
    await admin().execute(sql`UPDATE edr_connections SET pending_hint_at = date_trunc('second', now()) - interval '1 second' + interval '123456 microseconds' WHERE id = ${fx.connectionId}::uuid`);
    expect(await marker(fx.connectionId)).toMatch(/\.123456/);
    enqueued.length = 0;

    await syncEdrDetections(fx.connectionId);

    expect(await marker(fx.connectionId)).toBeNull();
    expect(enqueued).not.toContain(rerunId(fx.connectionId));
  });

  runDb('a hint that lands DURING the vendor fetch survives the run and queues exactly one rerun', async () => {
    const fx = await seedJob();
    await fx.addTenant(`co-${sfx()}`, fx.orgA.id);
    await enablePush(fx.connectionId);
    await recordEdrHint(fx.connectionId, [{ vendorTenantId: 'x' }], null);
    const before = await marker(fx.connectionId);
    midFetch.hook = async () => {
      await new Promise((r) => setTimeout(r, 5));
      await recordEdrHint(fx.connectionId, [{ vendorTenantId: 'y' }], null);
    };
    enqueued.length = 0;

    await syncEdrDetections(fx.connectionId);

    const after = await marker(fx.connectionId);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    expect(enqueued.filter((j) => j === rerunId(fx.connectionId))).toHaveLength(1);
  });

  runDb('a failed run leaves the marker; sync-all treats the connection as due from the DB marker alone', async () => {
    const fx = await seedJob();
    const co = `co-${sfx()}`;
    await fx.addTenant(co, fx.orgA.id);
    await enablePush(fx.connectionId);
    await recordEdrHint(fx.connectionId, [{ vendorTenantId: co }], null);
    const before = await marker(fx.connectionId);
    midFetch.hook = async () => { throw new EdrProviderRequestError('vendor down', { code: 'upstream_error', reauth: false, scope: 'connection' }); };

    await syncEdrDetections(fx.connectionId, { isFinalAttempt: false }).catch(() => {});
    expect(await marker(fx.connectionId)).toBe(before);

    // A just-synced connection with an unacked newer hint is due on the next tick.
    await admin().execute(sql`UPDATE edr_connections SET last_detection_sync_at = now() - interval '1 minute',
      last_inventory_sync_at = now(), pending_hint_at = now() WHERE id = ${fx.connectionId}::uuid`);
    enqueued.length = 0;
    await __testOnly.processSyncAll();
    expect(enqueued).toContain(`edr-detections-${fx.connectionId}`);
  });

  runDb('a hint for a push-disabled or inactive connection records nothing', async () => {
    const fx = await seedJob();
    expect(await recordEdrHint(fx.connectionId, [{ vendorTenantId: 'x' }], null)).toBe(false);
    expect(await marker(fx.connectionId)).toBeNull();
    await enablePush(fx.connectionId);
    await admin().execute(sql`UPDATE edr_connections SET is_active = false WHERE id = ${fx.connectionId}::uuid`);
    expect(await recordEdrHint(fx.connectionId, [{ vendorTenantId: 'x' }], null)).toBe(false);
    expect(await marker(fx.connectionId)).toBeNull();
  });
});

// ===========================================================================
// W04 PR-A (#8168): Emsisoft-shaped matching, attribution and re-read on REAL rows.
// The unit suites pin the SQL text; these pin what Postgres actually does.
// ===========================================================================

describe('edr sync — Emsisoft-shaped framework behaviour on real rows (W04 PR-A)', () => {
  async function seedEmsisoft() {
    const partner = await withSystemDbAccessContext(() => createPartner());
    const { orgA, siteA, orgB, siteB } = await withSystemDbAccessContext(async () => {
      const a = await createOrganization({ partnerId: partner.id });
      const b = await createOrganization({ partnerId: partner.id });
      return { orgA: a, siteA: (await createSite({ orgId: a.id }))!, orgB: b, siteB: (await createSite({ orgId: b.id }))! };
    });
    const mkDevice = async (orgId: string, siteId: string, hostname: string) => {
      const [d] = await admin().insert(devices).values({
        orgId, siteId, agentId: randomUUID(), hostname, osType: 'windows', osVersion: '11',
        architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
      }).returning({ id: devices.id });
      return d!.id;
    };
    const connectionId = randomUUID();
    await withSystemDbAccessContext(() => db.insert(edrConnections).values({
      id: connectionId, partnerId: partner.id, provider: 'emsisoft', name: `Emsisoft ${sfx()}`,
      credentialsEncrypted: 'enc:test', vendorRootId: 'root-emsi', vendorRootType: 'partner',
    }));
    const conn = { id: connectionId, partnerId: partner.id, provider: 'emsisoft' };
    const addTenant = (orgId: string) => withSystemDbAccessContext(async () => {
      const [t] = await db.insert(edrTenants).values({
        connectionId, partnerId: partner.id, vendorTenantId: randomUUID(), vendorTenantName: `WS ${sfx()}`,
        vendorTenantType: 'workspace', orgId, mappingSource: 'manual',
      }).returning({ id: edrTenants.id, vendorTenantId: edrTenants.vendorTenantId });
      return t!;
    });
    const addEndpoint = (tenantId: string, orgId: string, vendorEndpointId: string, hostname: string, over: Partial<typeof edrEndpoints.$inferInsert> = {}) =>
      withSystemDbAccessContext(async () => {
        const [e] = await db.insert(edrEndpoints).values({
          connectionId, partnerId: partner.id, orgId, tenantId, provider: 'emsisoft', vendorEndpointId, hostname, ...over,
        }).returning({ id: edrEndpoints.id });
        return e!.id;
      });
    return { partner, orgA, siteA, orgB, siteB, mkDevice, connectionId, conn, addTenant, addEndpoint };
  }
  const link = (id: string) => adminRows<{ breeze_device_id: string | null; device_match_source: string | null }>(sql`
    SELECT breeze_device_id, device_match_source FROM edr_endpoints WHERE id = ${id}::uuid`).then((r) => r[0]!);

  runDb('(a) strict-unique matching: duplicates stay ambiguous, a manual link on one twin never auto-links the other, org B is never a candidate', async () => {
    const fx = await seedEmsisoft();
    const d01 = await fx.mkDevice(fx.orgA.id, fx.siteA.id, 'PC01');
    const d04a = await fx.mkDevice(fx.orgA.id, fx.siteA.id, 'PC04');
    const d04b = await fx.mkDevice(fx.orgA.id, fx.siteA.id, 'PC04');
    await fx.mkDevice(fx.orgB.id, fx.siteB.id, 'PC03');
    const tenant = await fx.addTenant(fx.orgA.id);
    const e01 = await fx.addEndpoint(tenant.id, fx.orgA.id, 'em-01', 'pc01');
    const e03 = await fx.addEndpoint(tenant.id, fx.orgA.id, 'em-03', 'pc03');
    const e04 = await fx.addEndpoint(tenant.id, fx.orgA.id, 'em-04', 'pc04');

    const first = await withSystemDbAccessContext(() => matchEdrEndpoints(db as never, fx.connectionId, { strictUnique: true }));
    expect(first).toEqual({ linked: 1, ambiguous: 1 });
    expect(await link(e01)).toEqual({ breeze_device_id: d01, device_match_source: 'auto_hostname' });
    expect((await link(e03)).breeze_device_id).toBeNull(); // PC03 lives in org B: never a candidate
    expect((await link(e04)).breeze_device_id).toBeNull(); // two PC04s in org A: ambiguous

    // Link ONE twin by hand. The other device is still free, and a second EMC record carries the same name.
    await withSystemDbAccessContext(() => db.execute(sql`
      UPDATE edr_endpoints SET breeze_device_id = ${d04a}::uuid, device_match_source = 'manual' WHERE id = ${e04}::uuid`));
    const e04dup = await fx.addEndpoint(tenant.id, fx.orgA.id, 'em-04-dup', 'pc04');

    const strict = await withSystemDbAccessContext(() => matchEdrEndpoints(db as never, fx.connectionId, { strictUnique: true }));
    expect(strict.ambiguous).toBe(1);
    expect((await link(e04dup)).breeze_device_id).toBeNull(); // NOT linked to the other twin by elimination
    expect((await link(e04)).breeze_device_id).toBe(d04a); // the manual link is untouched

    // Discriminating control: WITHOUT strictUnique (the pre-A3 behaviour) the leftover twin IS handed to the duplicate record.
    await withSystemDbAccessContext(() => matchEdrEndpoints(db as never, fx.connectionId));
    expect(await link(e04dup)).toEqual({ breeze_device_id: d04b, device_match_source: 'auto_hostname' });
  });

  runDb('(b) a detection\'s vendor endpoint is sticky: a later attribution never re-binds it, a null never erases it, a first null is filled', async () => {
    const fx = await seedEmsisoft();
    const tenant = await fx.addTenant(fx.orgA.id);
    const e1 = await fx.addEndpoint(tenant.id, fx.orgA.id, 'em-e1', 'pc01');
    const e2 = await fx.addEndpoint(tenant.id, fx.orgA.id, 'em-e2', 'pc02');
    const persist = (id: string, vendorEndpointId: string | null, at: string) => withSystemDbAccessContext(() => persistDetections(
      db as never, fx.conn,
      [{ vendorTenantId: tenant.vendorTenantId, ok: true, value: { detections: [vendorDetection(tenant.vendorTenantId, id, { vendorEndpointId })], cursor: null, warnings: [] } }],
      new Date(at),
    ));
    const row = async (id: string) => (await adminRows<{ vendor_endpoint_id: string | null; endpoint_id: string | null }>(sql`
      SELECT vendor_endpoint_id, endpoint_id FROM edr_detections WHERE connection_id = ${fx.connectionId}::uuid AND vendor_detection_id = ${id}`))[0]!;

    await persist('inc-1:pc01', 'em-e1', '2026-12-16T10:00:00Z');
    await persist('inc-1:pc01', 'em-e2', '2026-12-16T11:00:00Z');
    expect(await row('inc-1:pc01')).toEqual({ vendor_endpoint_id: 'em-e1', endpoint_id: e1 }); // re-attribution ignored

    await persist('inc-2:pc02', null, '2026-12-16T10:00:00Z');
    expect(await row('inc-2:pc02')).toEqual({ vendor_endpoint_id: null, endpoint_id: null });
    await persist('inc-2:pc02', 'em-e2', '2026-12-16T11:00:00Z');
    expect(await row('inc-2:pc02')).toEqual({ vendor_endpoint_id: 'em-e2', endpoint_id: e2 }); // first null is filled

    await persist('inc-2:pc02', null, '2026-12-16T12:00:00Z');
    expect(await row('inc-2:pc02')).toEqual({ vendor_endpoint_id: 'em-e2', endpoint_id: e2 }); // a later null keeps the link

    // No split attribution: the original endpoint row is pruned (FK nulls endpoint_id) and the name is re-used by
    // another machine. The row keeps its vendor id AND does not get linked to the new machine's endpoint row.
    await persist('inc-3:pc01', 'em-e1', '2026-12-16T10:00:00Z');
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM edr_endpoints WHERE id = ${e1}::uuid`));
    expect(await row('inc-3:pc01')).toEqual({ vendor_endpoint_id: 'em-e1', endpoint_id: null });
    await persist('inc-3:pc01', 'em-e2', '2026-12-16T13:00:00Z');
    expect(await row('inc-3:pc01')).toEqual({ vendor_endpoint_id: 'em-e1', endpoint_id: null });
  });

  runDb('(b2) details._breeze holds the vendor locator + group key; an adapter-supplied _breeze is overwritten', async () => {
    const fx = await seedEmsisoft();
    const tenant = await fx.addTenant(fx.orgA.id);
    await withSystemDbAccessContext(() => persistDetections(db as never, fx.conn, [{
      vendorTenantId: tenant.vendorTenantId, ok: true,
      value: {
        detections: [vendorDetection(tenant.vendorTenantId, 'inc-3:pc01', {
          vendorRef: 'a'.repeat(40), groupKey: 'inc-3', details: { _breeze: { vendorRef: 'forged' }, k: 1 },
        })],
        cursor: null, warnings: [],
      },
    }], new Date('2026-12-16T10:00:00Z')));
    const [r] = await adminRows<{ details: Record<string, unknown> }>(sql`
      SELECT details FROM edr_detections WHERE connection_id = ${fx.connectionId}::uuid AND vendor_detection_id = 'inc-3:pc01'`);
    expect(r!.details).toEqual({ k: 1, _breeze: { vendorRef: 'a'.repeat(40), groupKey: 'inc-3' } });
  });

  runDb('(c) re-read rotation: the cap of 1 re-reads each open row once, omitted rows rotate without closing, updates leave notified_severity alone', async () => {
    const fx = await seedEmsisoft();
    const tenant = await fx.addTenant(fx.orgA.id);
    const persist = (ids: string[], at: string) => withSystemDbAccessContext(() => persistDetections(db as never, fx.conn, [{
      vendorTenantId: tenant.vendorTenantId, ok: true,
      value: { detections: ids.map((id) => vendorDetection(tenant.vendorTenantId, id, { vendorRef: `ref-${id}`, groupKey: `g-${id}` })), cursor: null, warnings: [] },
    }], new Date(at)));
    // Seeded in the PAST: the rotation bump uses the database's now().
    await persist(['older'], '2026-10-01T08:00:00Z');
    await persist(['newer'], '2026-10-01T09:00:00Z');

    const load = () => withSystemDbAccessContext(() => loadOpenDetectionRefs(db as never, fx.connectionId, [tenant.id], 1));
    const ids = (m: Map<string, Array<{ vendorDetectionId: string }>>) => (m.get(tenant.id) ?? []).map((r) => r.vendorDetectionId);

    // Run 1: the stalest row is re-read; the vendor no longer knows it (omitted) -> it rotates, status untouched.
    const run1 = await load();
    expect(ids(run1)).toEqual(['older']);
    expect(run1.get(tenant.id)![0]).toMatchObject({ vendorRef: 'ref-older', groupKey: 'g-older', vendorKind: 'incident' });
    await withSystemDbAccessContext(() => applyDetectionStatusUpdates(db as never, {
      connectionId: fx.connectionId, tenantId: tenant.id, orgId: fx.orgA.id, updates: [],
      attempted: [{ vendorDetectionId: 'older', vendorKind: 'incident' }],
    }));
    const [older] = await adminRows<{ status: string; updated_at: Date }>(sql`
      SELECT status, updated_at FROM edr_detections WHERE connection_id = ${fx.connectionId}::uuid AND vendor_detection_id = 'older'`);
    expect(older!.status).toBe('open');
    expect(new Date(older!.updated_at).getTime()).toBeGreaterThan(new Date('2026-10-01T09:00:00Z').getTime());

    // Run 2: the OTHER row reaches the front.
    const run2 = await load();
    expect(ids(run2)).toEqual(['newer']);

    // The vendor now says benign: applied in place, notified_severity (Phase 4 state) untouched, open count recomputed.
    const before = await adminRows<{ notified_severity: string | null; org_id: string; tenant_id: string }>(sql`
      SELECT notified_severity, org_id, tenant_id FROM edr_detections WHERE connection_id = ${fx.connectionId}::uuid AND vendor_detection_id = 'newer'`);
    const applied = await withSystemDbAccessContext(() => applyDetectionStatusUpdates(db as never, {
      connectionId: fx.connectionId, tenantId: tenant.id, orgId: fx.orgA.id,
      updates: [{
        vendorDetectionId: 'newer', vendorKind: 'incident', status: 'false_positive', vendorStatus: 'ConfirmedBenign/None',
        severity: 'low', vendorSeverity: 'Unwanted', resolvedAt: new Date('2026-12-17T00:00:00Z'), lastVendorUpdateAt: new Date('2026-12-17T00:00:00Z'),
      }],
      attempted: [{ vendorDetectionId: 'newer', vendorKind: 'incident' }],
    }));
    expect(applied).toBe(1);
    const [after] = await adminRows<{ status: string; severity: string; vendor_status: string; notified_severity: string | null; org_id: string; tenant_id: string; resolved_at: Date | null }>(sql`
      SELECT status, severity, vendor_status, notified_severity, org_id, tenant_id, resolved_at FROM edr_detections
      WHERE connection_id = ${fx.connectionId}::uuid AND vendor_detection_id = 'newer'`);
    expect(after).toMatchObject({ status: 'false_positive', severity: 'low', vendor_status: 'ConfirmedBenign/None', org_id: fx.orgA.id, tenant_id: tenant.id });
    expect(after!.notified_severity).toBe(before[0]!.notified_severity);
    expect(after!.resolved_at).not.toBeNull();
    const [t] = await adminRows<{ open_detection_count: number }>(sql`SELECT open_detection_count FROM edr_tenants WHERE id = ${tenant.id}::uuid`);
    expect(t!.open_detection_count).toBe(1);

    // Only the remaining open row is ever loaded now; closed rows are never re-read.
    expect(ids(await load())).toEqual(['older']);
  });

  runDb('(c2) a re-read for another org/tenant\'s ids changes nothing (scoped by connection + tenant + org)', async () => {
    const fx = await seedEmsisoft();
    const t1 = await fx.addTenant(fx.orgA.id);
    const t2 = await fx.addTenant(fx.orgB.id);
    await withSystemDbAccessContext(() => persistDetections(db as never, fx.conn, [{
      vendorTenantId: t1.vendorTenantId, ok: true, value: { detections: [vendorDetection(t1.vendorTenantId, 'mine')], cursor: null, warnings: [] },
    }], new Date('2026-12-16T08:00:00Z')));
    const n = await withSystemDbAccessContext(() => applyDetectionStatusUpdates(db as never, {
      connectionId: fx.connectionId, tenantId: t2.id, orgId: fx.orgB.id,
      updates: [{ vendorDetectionId: 'mine', vendorKind: 'incident', status: 'false_positive', vendorStatus: 'x', severity: 'low', vendorSeverity: null, resolvedAt: null, lastVendorUpdateAt: null }],
      attempted: [],
    }));
    expect(n).toBe(0);
    const [r] = await adminRows<{ status: string }>(sql`
      SELECT status FROM edr_detections WHERE connection_id = ${fx.connectionId}::uuid AND vendor_detection_id = 'mine'`);
    expect(r!.status).toBe('open');
  });

  runDb('(c3) closed and tombstoned rows are never loaded for re-read and never rewritten by an update', async () => {
    const fx = await seedEmsisoft();
    const tenant = await fx.addTenant(fx.orgA.id);
    await withSystemDbAccessContext(() => persistDetections(db as never, fx.conn, [{
      vendorTenantId: tenant.vendorTenantId, ok: true,
      value: { detections: ['live', 'closed', 'tomb'].map((id) => vendorDetection(tenant.vendorTenantId, id)), cursor: null, warnings: [] },
    }], new Date('2026-10-01T08:00:00Z')));
    await withSystemDbAccessContext(() => db.execute(sql`
      UPDATE edr_detections SET status = 'false_positive' WHERE connection_id = ${fx.connectionId}::uuid AND vendor_detection_id = 'closed'`));
    await withSystemDbAccessContext(() => db.execute(sql`
      UPDATE edr_detections SET detached_at = now(), tenant_id = NULL WHERE connection_id = ${fx.connectionId}::uuid AND vendor_detection_id = 'tomb'`));
    const loaded = await withSystemDbAccessContext(() => loadOpenDetectionRefs(db as never, fx.connectionId, [tenant.id], 10));
    expect((loaded.get(tenant.id) ?? []).map((r) => r.vendorDetectionId)).toEqual(['live']);
    const mk = (id: string) => ({ vendorDetectionId: id, vendorKind: 'incident' as const, status: 'mitigated' as const, vendorStatus: 'x', severity: 'low' as const, vendorSeverity: null, resolvedAt: null, lastVendorUpdateAt: null });
    const n = await withSystemDbAccessContext(() => applyDetectionStatusUpdates(db as never, {
      connectionId: fx.connectionId, tenantId: tenant.id, orgId: fx.orgA.id, updates: [mk('closed'), mk('tomb')], attempted: [],
    }));
    expect(n).toBe(0);
    const rows = await adminRows<{ vendor_detection_id: string; status: string }>(sql`
      SELECT vendor_detection_id, status FROM edr_detections WHERE connection_id = ${fx.connectionId}::uuid ORDER BY vendor_detection_id`);
    expect(rows).toEqual([
      { vendor_detection_id: 'closed', status: 'false_positive' },
      { vendor_detection_id: 'live', status: 'open' },
      { vendor_detection_id: 'tomb', status: 'open' },
    ]);
  });

  runDb('(d) detail-owned fields survive a list-only inventory run; an explicit null clears; hostname/policy still overwrite', async () => {
    const fx = await seedEmsisoft();
    const tenant = await fx.addTenant(fx.orgA.id);
    const listItem = (hostname: string, policy: string) => ({
      vendorEndpointId: 'em-d1', vendorTenantId: tenant.vendorTenantId, hostname, fqdn: null, serialNumber: null, macAddresses: [], ipAddresses: [],
      osPlatform: 'other' as const, osName: null, endpointType: 'unknown' as const, agentVersion: null, health: 'unknown' as const, online: null,
      isolationState: 'unknown' as const, tamperProtection: null, policyName: policy, lastSeenAt: null, raw: {},
    });
    const run = (value: { endpoints: unknown[]; details: unknown[] }, at: string) => withSystemDbAccessContext(() => persistInventory(
      db as never, fx.conn, [{ vendorTenantId: tenant.vendorTenantId, ok: true, value: value as never }], new Date(at)));
    const row = async () => (await adminRows<Row>(sql`
      SELECT hostname, policy_name, fqdn, os_name, os_platform, endpoint_type, online, health, agent_version, ip_addresses
      FROM edr_endpoints WHERE connection_id = ${fx.connectionId}::uuid AND vendor_endpoint_id = 'em-d1'`))[0]!;

    // Run 1: first insert takes the list values; the detail then fills the detail-owned columns.
    await run({
      endpoints: [listItem('PC01', 'Default')],
      details: [{ vendorEndpointId: 'em-d1', fqdn: 'pc01.corp.example.test', ipAddresses: ['192.0.2.10'], osName: 'Windows 11 Pro', osPlatform: 'windows', endpointType: 'workstation', online: true, health: 'healthy', agentVersion: '2026.9' }],
    }, '2026-12-16T10:00:00Z');
    expect(await row()).toMatchObject({ hostname: 'PC01', fqdn: 'pc01.corp.example.test', os_name: 'Windows 11 Pro', os_platform: 'windows', online: true, health: 'healthy', ip_addresses: ['192.0.2.10'] });

    // Run 2: list-only (the list says unknown/null for everything detail-owned) -> they SURVIVE; hostname/policy overwrite.
    await run({ endpoints: [listItem('PC01-renamed', 'Servers')], details: [] }, '2026-12-16T11:00:00Z');
    expect(await row()).toMatchObject({
      hostname: 'PC01-renamed', policy_name: 'Servers', fqdn: 'pc01.corp.example.test', os_name: 'Windows 11 Pro', os_platform: 'windows',
      endpoint_type: 'workstation', online: true, health: 'healthy', agent_version: '2026.9', ip_addresses: ['192.0.2.10'],
    });

    // Run 3: the detail says the device left its domain (explicit null) but has no OS key -> fqdn clears, osName stays.
    await run({ endpoints: [listItem('PC01-renamed', 'Servers')], details: [{ vendorEndpointId: 'em-d1', fqdn: null }] }, '2026-12-16T12:00:00Z');
    expect(await row()).toMatchObject({ fqdn: null, os_name: 'Windows 11 Pro', online: true });
  });
});
