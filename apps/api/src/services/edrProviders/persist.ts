import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { edrDetections, edrEndpoints, edrTenants } from '../../db/schema';
import type { ProviderSyncTx } from '../backupProviders/persist';
import { validateVendorUrl } from './guardedFetch';
import { getEdrProvider } from './registry';
import type {
  EdrDetectionPage,
  EdrErrorScope,
  VendorEdrEndpoint,
  VendorEdrEndpointDetail,
  VendorEdrTenant,
} from './types';

/*
 * EDR sync Phase 3 writers (everything that touches the database after the
 * vendor fetch). Mirrors backupProviders/persist.ts, with three differences
 * that matter:
 *
 *  - Persistence is PER TENANT. A tenant whose vendor fetch failed is passed in
 *    as `{ ok: false }` and gets a status/error write ONLY -- its endpoints are
 *    never deleted and its detection cursor never advances (Review Focus 1: a
 *    partial enumeration must never read as "gone").
 *  - Detections are never deleted, and the live-identity upsert names the
 *    partial index predicate (`WHERE detached_at IS NULL`) so a re-fetch after a
 *    remap creates a FRESH row in the new org instead of moving the D13
 *    tombstone across customers (plan index correction 1).
 *  - Unmapped tenants' endpoints are counted, never stored (D5).
 *
 * LOCK ORDER / 40P01 (W01a review). A device hard delete and a device org move
 * take the `devices` row FOR UPDATE first and THEN update `edr_endpoints` /
 * `edr_detections` (detach). Phase 3 goes the other way: it writes
 * edr_endpoints / edr_detections rows whose composite FK
 * `(breeze_device_id, org_id) -> devices(id, org_id)` takes a KEY SHARE lock on
 * the `devices` row, i.e. it holds an edr_* row lock and then wants the device.
 * Opposite orders over the same pair => Postgres can pick either side as a
 * deadlock victim (SQLSTATE 40P01). Neither order can be changed (the device
 * paths own the devices-first order for every other child table), so the sync
 * job must treat 40P01 as retryable: re-run Phase 3 in a fresh transaction when
 * `isDeadlockError(err)` is true. Phase 3 is idempotent, so a rerun is safe.
 */

/** The drizzle handle every EDR Phase-3 writer needs (same shape as backup's). */
export type EdrSyncTx = ProviderSyncTx;

export interface PersistConnection {
  id: string;
  partnerId: string;
  provider: string;
}

export type TenantFetch<T> =
  | { vendorTenantId: string; ok: true; value: T }
  | { vendorTenantId: string; ok: false; error: string; scope: EdrErrorScope };

export interface InventoryFetch {
  endpoints: VendorEdrEndpoint[];
  details: VendorEdrEndpointDetail[];
  /** Vendor-reported total, used for UNMAPPED tenants (their endpoints are counted, never stored). */
  count?: number;
}

/** Endpoints of a tenant absent from the vendor's tenant list are pruned after this long (D13). */
export const MISSING_TENANT_ENDPOINT_RETENTION_DAYS = 7;

const UPSERT_CHUNK = 500;
const ERROR_MAX = 1000;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function clip(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  return value.slice(0, max);
}

/**
 * True for a Postgres deadlock_detected (SQLSTATE 40P01), looking through
 * `err.cause` (drizzle wraps driver errors in DrizzleQueryError). See the
 * lock-order note above: the sync job retries Phase 3 on this.
 */
export function isDeadlockError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current !== null && typeof current === 'object'; depth += 1) {
    if ((current as { code?: unknown }).code === '40P01') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

export async function upsertTenants(
  tx: EdrSyncTx,
  conn: PersistConnection,
  tenants: VendorEdrTenant[],
  now: Date,
  opts: { hostAllowlist?: readonly string[] } = {},
): Promise<{ total: number; unmapped: number; newlyMissing: number }> {
  const allowlist = opts.hostAllowlist ?? getEdrProvider(conn.provider).hostAllowlist;

  const existing = await tx
    .select({
      id: edrTenants.id,
      vendorTenantId: edrTenants.vendorTenantId,
      vendorMissingSince: edrTenants.vendorMissingSince,
    })
    .from(edrTenants)
    .where(eq(edrTenants.connectionId, conn.id));

  // Vendor-supplied hosts are validated before they are stored (never stored
  // unvalidated); the dial path validates again.
  const rejectedHosts = new Map<string, string>();
  const seen = new Map<string, VendorEdrTenant>();
  for (const tenant of tenants) seen.set(tenant.vendorTenantId, tenant);
  const values = [...seen.values()].map((tenant) => {
    let apiHost: string | null = null;
    if (tenant.apiHost) {
      const checked = validateVendorUrl(tenant.apiHost, allowlist);
      if (checked.ok) apiHost = tenant.apiHost.slice(0, 300);
      else rejectedHosts.set(tenant.vendorTenantId, `api_host rejected: ${checked.reason}`);
    }
    return {
      connectionId: conn.id,
      partnerId: conn.partnerId,
      vendorTenantId: tenant.vendorTenantId.slice(0, 128),
      vendorTenantName: tenant.name.slice(0, 255),
      vendorParentId: clip(tenant.parentId, 128),
      vendorTenantType: clip(tenant.tenantType, 40),
      vendorExternalCode: clip(tenant.externalCode, 255),
      apiHost,
      lastSeenAt: now,
      vendorMissingSince: null,
      updatedAt: now,
    };
  });

  for (const batch of chunk(values, UPSERT_CHUNK)) {
    await tx
      .insert(edrTenants)
      .values(batch)
      .onConflictDoUpdate({
        target: [edrTenants.connectionId, edrTenants.vendorTenantId],
        set: {
          vendorTenantName: sql`excluded.vendor_tenant_name`,
          vendorParentId: sql`excluded.vendor_parent_id`,
          vendorTenantType: sql`excluded.vendor_tenant_type`,
          vendorExternalCode: sql`excluded.vendor_external_code`,
          apiHost: sql`excluded.api_host`,
          lastSeenAt: sql`excluded.last_seen_at`,
          vendorMissingSince: sql`NULL`,
          updatedAt: sql`excluded.updated_at`,
          // org_id / mapping_source / cursors / sync state are DELIBERATELY absent:
          // the mapping is a human decision and sync state belongs to the streams.
        },
      });
  }

  for (const [vendorTenantId, message] of rejectedHosts) {
    await tx
      .update(edrTenants)
      .set({ lastInventorySyncStatus: 'error', lastInventorySyncError: message, updatedAt: now })
      .where(and(eq(edrTenants.connectionId, conn.id), eq(edrTenants.vendorTenantId, vendorTenantId)));
  }

  // D13: absent from the list => tombstone, never delete.
  const absent = existing.filter((row) => !seen.has(row.vendorTenantId));
  const newlyMissing = absent.filter((row) => row.vendorMissingSince === null).length;
  for (const batch of chunk(absent.map((row) => row.id), UPSERT_CHUNK)) {
    await tx
      .update(edrTenants)
      .set({
        vendorMissingSince: sql`coalesce(${edrTenants.vendorMissingSince}, ${now.toISOString()}::timestamptz)`,
        updatedAt: now,
      })
      .where(inArray(edrTenants.id, batch));
  }

  const [unmappedRow] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(edrTenants)
    .where(and(
      eq(edrTenants.connectionId, conn.id),
      isNull(edrTenants.orgId),
      isNull(edrTenants.vendorMissingSince),
    ));

  return { total: seen.size, unmapped: unmappedRow?.n ?? 0, newlyMissing };
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

async function loadTenantsByVendorId(tx: EdrSyncTx, connectionId: string) {
  const rows = await tx
    .select({
      id: edrTenants.id,
      vendorTenantId: edrTenants.vendorTenantId,
      orgId: edrTenants.orgId,
    })
    .from(edrTenants)
    .where(eq(edrTenants.connectionId, connectionId));
  return new Map(rows.map((row) => [row.vendorTenantId, row]));
}

export async function persistInventory(
  tx: EdrSyncTx,
  conn: PersistConnection,
  results: TenantFetch<InventoryFetch>[],
  now: Date,
): Promise<{ endpoints: number; failedTenants: number }> {
  const tenantByVendorId = await loadTenantsByVendorId(tx, conn.id);
  let endpointTotal = 0;
  let failedTenants = 0;

  for (const result of results) {
    const tenant = tenantByVendorId.get(result.vendorTenantId);
    if (!tenant) continue;

    if (!result.ok) {
      // Status/error ONLY: the endpoints that were on unfetched pages must stay.
      failedTenants += 1;
      await tx
        .update(edrTenants)
        .set({
          lastInventorySyncStatus: 'error',
          lastInventorySyncError: result.error.slice(0, ERROR_MAX),
          updatedAt: now,
        })
        .where(eq(edrTenants.id, tenant.id));
      continue;
    }

    const { endpoints, details, count } = result.value;

    if (!tenant.orgId) {
      // Unmapped: counted, never stored (D5).
      await tx
        .update(edrTenants)
        .set({
          endpointCount: count ?? endpoints.length,
          lastInventorySyncAt: now,
          lastInventorySyncStatus: 'success',
          lastInventorySyncError: null,
          updatedAt: now,
        })
        .where(eq(edrTenants.id, tenant.id));
      continue;
    }

    const orgId = tenant.orgId;
    const byVendorId = new Map<string, VendorEdrEndpoint>();
    for (const endpoint of endpoints) byVendorId.set(endpoint.vendorEndpointId, endpoint);
    const vendorIds = [...byVendorId.keys()];

    // An endpoint row held by a different org/tenant (company moved, or the
    // tenant was remapped) is deleted and re-inserted below, never updated
    // across orgs.
    for (const batch of chunk(vendorIds, UPSERT_CHUNK)) {
      await tx
        .delete(edrEndpoints)
        .where(and(
          eq(edrEndpoints.connectionId, conn.id),
          inArray(edrEndpoints.vendorEndpointId, batch),
          sql`(${edrEndpoints.orgId} <> ${orgId}::uuid OR ${edrEndpoints.tenantId} <> ${tenant.id}::uuid)`,
        ));
    }

    const values = [...byVendorId.values()].map((endpoint) => ({
      connectionId: conn.id,
      partnerId: conn.partnerId,
      orgId,
      tenantId: tenant.id,
      provider: conn.provider,
      vendorEndpointId: endpoint.vendorEndpointId.slice(0, 128),
      hostname: clip(endpoint.hostname, 255),
      fqdn: clip(endpoint.fqdn, 255),
      serialNumber: clip(endpoint.serialNumber, 128),
      macAddresses: endpoint.macAddresses,
      ipAddresses: endpoint.ipAddresses,
      osPlatform: endpoint.osPlatform,
      osName: clip(endpoint.osName, 255),
      endpointType: endpoint.endpointType,
      agentVersion: clip(endpoint.agentVersion, 64),
      health: endpoint.health,
      online: endpoint.online,
      isolationState: endpoint.isolationState,
      tamperProtection: endpoint.tamperProtection,
      policyName: clip(endpoint.policyName, 255),
      lastSeenAt: endpoint.lastSeenAt,
      vendorRaw: endpoint.raw,
      updatedAt: now,
    }));

    for (const batch of chunk(values, UPSERT_CHUNK)) {
      await tx
        .insert(edrEndpoints)
        .values(batch)
        .onConflictDoUpdate({
          target: [edrEndpoints.connectionId, edrEndpoints.vendorEndpointId],
          set: {
            hostname: sql`excluded.hostname`,
            fqdn: sql`excluded.fqdn`,
            serialNumber: sql`excluded.serial_number`,
            macAddresses: sql`excluded.mac_addresses`,
            ipAddresses: sql`excluded.ip_addresses`,
            osPlatform: sql`excluded.os_platform`,
            osName: sql`excluded.os_name`,
            endpointType: sql`excluded.endpoint_type`,
            agentVersion: sql`excluded.agent_version`,
            health: sql`excluded.health`,
            online: sql`excluded.online`,
            isolationState: sql`excluded.isolation_state`,
            tamperProtection: sql`excluded.tamper_protection`,
            policyName: sql`excluded.policy_name`,
            lastSeenAt: sql`excluded.last_seen_at`,
            vendorRaw: sql`excluded.vendor_raw`,
            updatedAt: sql`excluded.updated_at`,
            // org_id / tenant_id are DELIBERATELY absent (a row never moves across
            // orgs); breeze_device_id / device_match_source belong to Breeze matching.
          },
          setWhere: sql`${edrEndpoints.orgId} = excluded.org_id AND ${edrEndpoints.tenantId} = excluded.tenant_id`,
        });
    }

    for (const detail of details) {
      if (!byVendorId.has(detail.vendorEndpointId)) continue;
      const set: Record<string, unknown> = { vendorDetailSyncedAt: now, updatedAt: now };
      if (detail.health !== undefined) set.health = detail.health;
      if (detail.online !== undefined) set.online = detail.online;
      if (detail.lastSeenAt !== undefined) set.lastSeenAt = detail.lastSeenAt;
      if (detail.agentVersion !== undefined) set.agentVersion = clip(detail.agentVersion, 64);
      if (detail.osName !== undefined) set.osName = clip(detail.osName, 255);
      if (detail.serialNumber !== undefined) set.serialNumber = clip(detail.serialNumber, 128);
      await tx
        .update(edrEndpoints)
        .set(set as never)
        .where(and(
          eq(edrEndpoints.connectionId, conn.id),
          eq(edrEndpoints.tenantId, tenant.id),
          eq(edrEndpoints.vendorEndpointId, detail.vendorEndpointId),
        ));
    }

    // This tenant's endpoints that were NOT in the (complete) fetched set are gone.
    const held = await tx
      .select({ id: edrEndpoints.id, vendorEndpointId: edrEndpoints.vendorEndpointId })
      .from(edrEndpoints)
      .where(and(eq(edrEndpoints.connectionId, conn.id), eq(edrEndpoints.tenantId, tenant.id)));
    const staleIds = held.filter((row) => !byVendorId.has(row.vendorEndpointId)).map((row) => row.id);
    for (const batch of chunk(staleIds, UPSERT_CHUNK)) {
      await tx.delete(edrEndpoints).where(inArray(edrEndpoints.id, batch));
    }

    await tx
      .update(edrTenants)
      .set({
        endpointCount: byVendorId.size,
        lastInventorySyncAt: now,
        lastInventorySyncStatus: 'success',
        lastInventorySyncError: null,
        updatedAt: now,
      })
      .where(eq(edrTenants.id, tenant.id));
    endpointTotal += byVendorId.size;
  }

  // Detections that arrived before their endpoint existed: resolve the link now.
  await tx.execute(sql`
    UPDATE edr_detections AS d
    SET endpoint_id = e.id,
        breeze_device_id = COALESCE(d.breeze_device_id, e.breeze_device_id),
        updated_at = now()
    FROM edr_endpoints AS e
    WHERE d.connection_id = ${conn.id}::uuid
      AND d.endpoint_id IS NULL
      AND d.detached_at IS NULL
      AND d.vendor_endpoint_id IS NOT NULL
      AND e.connection_id = d.connection_id
      AND e.vendor_endpoint_id = d.vendor_endpoint_id
      AND e.org_id = d.org_id
  `);

  return { endpoints: endpointTotal, failedTenants };
}

// ---------------------------------------------------------------------------
// Detections
// ---------------------------------------------------------------------------

export async function persistDetections(
  tx: EdrSyncTx,
  conn: PersistConnection,
  results: TenantFetch<EdrDetectionPage>[],
  now: Date,
): Promise<{ upserted: number; failedTenants: number; skipped: number }> {
  const tenantByVendorId = await loadTenantsByVendorId(tx, conn.id);
  let upserted = 0;
  let skipped = 0;
  let failedTenants = 0;

  for (const result of results) {
    const tenant = tenantByVendorId.get(result.vendorTenantId);
    if (!tenant) continue;

    if (!result.ok) {
      // Status/error only; the cursor stays where it was so the window is re-read.
      failedTenants += 1;
      await tx
        .update(edrTenants)
        .set({
          lastDetectionSyncStatus: 'error',
          lastDetectionSyncError: result.error.slice(0, ERROR_MAX),
          updatedAt: now,
        })
        .where(eq(edrTenants.id, tenant.id));
      continue;
    }

    // Detections of unmapped tenants are not fetched; if a page arrives anyway
    // (remap raced the fetch) it is dropped, not stored under no org.
    if (!tenant.orgId) continue;
    const orgId = tenant.orgId;
    const page = result.value;

    const vendorEndpointIds = [...new Set(
      page.detections.map((d) => d.vendorEndpointId).filter((id): id is string => !!id),
    )];
    const endpointByVendorId = new Map<string, { id: string; breezeDeviceId: string | null }>();
    for (const batch of chunk(vendorEndpointIds, UPSERT_CHUNK)) {
      const rows = await tx
        .select({
          id: edrEndpoints.id,
          vendorEndpointId: edrEndpoints.vendorEndpointId,
          breezeDeviceId: edrEndpoints.breezeDeviceId,
        })
        .from(edrEndpoints)
        .where(and(
          eq(edrEndpoints.connectionId, conn.id),
          eq(edrEndpoints.orgId, orgId),
          inArray(edrEndpoints.vendorEndpointId, batch),
        ));
      for (const row of rows) {
        endpointByVendorId.set(row.vendorEndpointId, { id: row.id, breezeDeviceId: row.breezeDeviceId });
      }
    }

    // ON CONFLICT DO UPDATE cannot touch one row twice in a statement.
    const byKey = new Map<string, (typeof page.detections)[number]>();
    for (const detection of page.detections) {
      byKey.set(`${detection.vendorKind}\u0000${detection.vendorDetectionId}`, detection);
    }

    const values = [...byKey.values()].map((d) => {
      const endpoint = d.vendorEndpointId ? endpointByVendorId.get(d.vendorEndpointId) : undefined;
      return {
        connectionId: conn.id,
        partnerId: conn.partnerId,
        orgId,
        tenantId: tenant.id,
        endpointId: endpoint?.id ?? null,
        vendorEndpointId: clip(d.vendorEndpointId, 128),
        breezeDeviceId: endpoint?.breezeDeviceId ?? null,
        provider: conn.provider,
        vendorDetectionId: d.vendorDetectionId.slice(0, 255),
        vendorKind: d.vendorKind,
        severity: d.severity,
        vendorSeverity: clip(d.vendorSeverity, 64),
        status: d.status,
        vendorStatus: clip(d.vendorStatus, 64),
        title: clip(d.title, 500),
        category: clip(d.category, 128),
        threatName: clip(d.threatName, 500),
        filePath: d.filePath,
        processName: clip(d.processName, 500),
        mitreTechniques: d.mitreTechniques,
        detectedAt: d.detectedAt,
        resolvedAt: d.resolvedAt,
        lastVendorUpdateAt: d.lastVendorUpdateAt,
        details: d.details,
        updatedAt: now,
      };
    });

    for (const batch of chunk(values, UPSERT_CHUNK)) {
      const written = await tx
        .insert(edrDetections)
        .values(batch)
        .onConflictDoUpdate({
          target: [edrDetections.connectionId, edrDetections.vendorKind, edrDetections.vendorDetectionId],
          // The unique index is PARTIAL (live rows only). A tombstone
          // (detached_at set) is invisible to this conflict target, so a
          // re-fetched detection after a remap inserts a fresh row.
          targetWhere: sql`${edrDetections.detachedAt} IS NULL`,
          set: {
            severity: sql`excluded.severity`,
            vendorSeverity: sql`excluded.vendor_severity`,
            status: sql`excluded.status`,
            vendorStatus: sql`excluded.vendor_status`,
            title: sql`excluded.title`,
            category: sql`excluded.category`,
            threatName: sql`excluded.threat_name`,
            filePath: sql`excluded.file_path`,
            processName: sql`excluded.process_name`,
            mitreTechniques: sql`excluded.mitre_techniques`,
            detectedAt: sql`excluded.detected_at`,
            resolvedAt: sql`excluded.resolved_at`,
            lastVendorUpdateAt: sql`excluded.last_vendor_update_at`,
            details: sql`excluded.details`,
            vendorEndpointId: sql`COALESCE(excluded.vendor_endpoint_id, ${edrDetections.vendorEndpointId})`,
            endpointId: sql`COALESCE(excluded.endpoint_id, ${edrDetections.endpointId})`,
            // A closed detection keeps its historical device; refreshDetectionDeviceLinks
            // re-points open ones. Only fill a missing link here.
            breezeDeviceId: sql`COALESCE(${edrDetections.breezeDeviceId}, excluded.breeze_device_id)`,
            updatedAt: sql`excluded.updated_at`,
            // org_id / tenant_id / notified_severity / detached_at / last_site_id are
            // DELIBERATELY absent: a live row never moves across orgs.
          },
          // Defence in depth: a conflict row owned by another tenant/org is skipped
          // (and counted below) rather than overwritten.
          setWhere: sql`${edrDetections.tenantId} = excluded.tenant_id AND ${edrDetections.orgId} = excluded.org_id`,
        })
        .returning({ id: edrDetections.id });
      const wrote = (written as unknown[]).length;
      upserted += wrote;
      skipped += batch.length - wrote;
    }

    await tx
      .update(edrTenants)
      .set({
        // Only this tenant's cursor moves, and only to a real value.
        detectionCursor: page.cursor ?? sql`${edrTenants.detectionCursor}`,
        lastDetectionSyncAt: now,
        lastDetectionSyncStatus: page.warnings.length > 0 ? 'partial' : 'success',
        lastDetectionSyncError: page.warnings.length > 0 ? page.warnings.join('; ').slice(0, ERROR_MAX) : null,
        openDetectionCount: sql`(
          SELECT count(*)::int FROM edr_detections x
          WHERE x.tenant_id = ${tenant.id}::uuid
            AND x.detached_at IS NULL
            AND x.status IN ('open', 'in_progress', 'unknown')
        )`,
        updatedAt: now,
      })
      .where(eq(edrTenants.id, tenant.id));
  }

  return { upserted, failedTenants, skipped };
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/** Delete the endpoints of tenants that have been absent from the vendor list for more than 7 days. */
export async function pruneMissingTenantEndpoints(
  tx: EdrSyncTx,
  connectionId: string,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - MISSING_TENANT_ENDPOINT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await tx.execute(sql`
    DELETE FROM edr_endpoints AS e
    USING edr_tenants AS t
    WHERE e.tenant_id = t.id
      AND e.connection_id = ${connectionId}::uuid
      AND t.connection_id = ${connectionId}::uuid
      AND t.vendor_missing_since IS NOT NULL
      AND t.vendor_missing_since < ${cutoff.toISOString()}::timestamptz
    RETURNING e.id
  `);
  const count = (deleted as unknown as unknown[]).length;
  if (count > 0) {
    await tx.execute(sql`
      UPDATE edr_tenants SET endpoint_count = 0, updated_at = now()
      WHERE connection_id = ${connectionId}::uuid
        AND vendor_missing_since IS NOT NULL
        AND vendor_missing_since < ${cutoff.toISOString()}::timestamptz
        AND endpoint_count <> 0
    `);
  }
  return count;
}

/**
 * After matching: OPEN detections follow their endpoint's device link. Closed
 * detections keep the historical device (spec 4.2).
 */
export async function refreshDetectionDeviceLinks(tx: EdrSyncTx, connectionId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE edr_detections AS d
    SET breeze_device_id = e.breeze_device_id, updated_at = now()
    FROM edr_endpoints AS e
    WHERE d.endpoint_id = e.id
      AND d.connection_id = ${connectionId}::uuid
      AND d.detached_at IS NULL
      AND d.status IN ('open', 'in_progress', 'unknown')
      AND d.breeze_device_id IS DISTINCT FROM e.breeze_device_id
  `);
}
