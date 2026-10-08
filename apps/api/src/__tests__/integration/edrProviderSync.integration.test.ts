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
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { edrConnections, edrDetections, edrEndpoints, edrTenants } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
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
