import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { db } from '../../db';
import {
  backupProviderCustomers,
  backupProviderDeviceHistory,
  backupProviderDevices,
} from '../../db/schema';
// Package ROOT (see Step 1): `@breeze/shared/utils/backupHealth` is NOT in
// packages/shared's `exports` map, and these are VALUE imports, so a deep
// subpath fails at module load under vitest.integration.config.ts even though
// the unit runner's alias resolves it (apps/api/src/services/aiToolHandoff.ts:42-48).
import {
  EXTERNAL_BACKUP_STATUSES,
  EXTERNAL_BACKUP_STATUS_SEVERITY,
  type ExternalBackupStatus,
} from '@breeze/shared';
import type { VendorCustomer, VendorDevice } from './types';
import { autoMapCustomers } from './mapping';
import { matchProviderDevices } from './deviceMatching';

/**
 * The subset of the drizzle handle every backup-provider sync service needs.
 *
 * Callers pass the ambient `db` proxy from inside a
 * `withSystemDbAccessContext(...)`: under an open context that proxy IS the
 * transaction (apps/api/src/db/index.ts:525-575), so "pass the tx" and "pass
 * db" are the same object. Typing it as a `Pick` — the shape
 * services/softwareInventoryObservations.ts:231 uses — documents which
 * operations the callee performs and keeps the unit tests' hand-rolled stubs
 * small.
 */
export type ProviderSyncTx = Pick<
  typeof db,
  'select' | 'insert' | 'update' | 'delete' | 'transaction' | 'execute'
>;

export interface VendorSnapshot {
  customers: VendorCustomer[];
  devices: VendorDevice[];
}

export interface SyncCounters {
  customers: number;
  unmappedCustomers: number;
  devices: number;
  unmappedDevices: number;
  linked: number;
  ambiguous: number;
}

export interface PersistConnection {
  id: string;
  partnerId: string;
  provider: string;
  showProviderNameInPortal: boolean;
}

/** Spec: rows older than 60 days are pruned per connection. */
export const LEDGER_RETENTION_DAYS = 60;

const UPSERT_CHUNK = 500;

/**
 * The severity table the ledger's worst-of-day CASE is generated from.
 *
 * Derived from the SHARED record so the SQL and `worstBackupStatus` cannot
 * drift — persist.test.ts pins that agreement over every ordered pair, and
 * fails loudly if a new `external_backup_status` member is added without a
 * severity (it would otherwise fall into the CASE's `ELSE 0` and silently rank
 * as "better than completed").
 */
export const LEDGER_STATUS_SEVERITY: ReadonlyArray<readonly [ExternalBackupStatus, number]> =
  EXTERNAL_BACKUP_STATUSES.map((status) => [status, EXTERNAL_BACKUP_STATUS_SEVERITY[status]] as const);

/** `(CASE <expr>::text WHEN 'failed' THEN 10 … ELSE 0 END)` */
export function backupStatusSeveritySql(expr: SQL): SQL {
  const whens = LEDGER_STATUS_SEVERITY.map(
    ([status, severity]) => sql`WHEN ${status} THEN ${sql.raw(String(severity))}`,
  );
  return sql`(CASE ${expr}::text ${sql.join(whens, sql` `)} ELSE 0 END)`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Persist one complete vendor snapshot inside the caller's transaction.
 *
 * The caller has already taken the per-connection advisory lock and re-read the
 * connection FOR UPDATE, so nothing here re-checks liveness. Deletions are safe
 * ONLY because the adapter throws on any partial page (spec, Provider adapter):
 * a caught enumeration error never reaches this function, so "absent from the
 * snapshot" genuinely means "gone from the vendor".
 */
export async function persistVendorSnapshot(
  tx: ProviderSyncTx,
  connection: PersistConnection,
  snapshot: VendorSnapshot,
  options: { now?: Date } = {},
): Promise<SyncCounters> {
  const now = options.now ?? new Date();

  // Defer the DEFERRABLE INITIALLY IMMEDIATE composite FKs for this transaction
  // (CLAUDE.md, org-merge contract). A customer whose mapping moved org forces
  // parent and child org_id to be re-pointed in SEPARATE statements; an
  // immediate check would abort with 23503 the moment the device row moved
  // ahead of its history rows. Non-deferrable constraints are unaffected.
  await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);

  // ---- customers -------------------------------------------------------
  const existingCustomers = await tx
    .select({
      id: backupProviderCustomers.id,
      vendorCustomerId: backupProviderCustomers.vendorCustomerId,
    })
    .from(backupProviderCustomers)
    .where(eq(backupProviderCustomers.connectionId, connection.id));

  const deviceCountByVendorCustomer = new Map<string, number>();
  for (const device of snapshot.devices) {
    deviceCountByVendorCustomer.set(
      device.vendorCustomerId,
      (deviceCountByVendorCustomer.get(device.vendorCustomerId) ?? 0) + 1,
    );
  }

  const customerValues = snapshot.customers.map((customer) => ({
    connectionId: connection.id,
    partnerId: connection.partnerId,
    vendorCustomerId: customer.vendorCustomerId,
    vendorCustomerName: customer.name.slice(0, 255),
    vendorParentId: customer.parentId?.slice(0, 128) ?? null,
    vendorLevel: customer.level?.slice(0, 40) ?? null,
    vendorExternalCode: customer.externalCode?.slice(0, 255) ?? null,
    // device_count counts ALL devices under the customer, mapped or not — it is
    // what the "N customers / M devices unmapped" summary is built from.
    deviceCount: deviceCountByVendorCustomer.get(customer.vendorCustomerId) ?? 0,
    lastSeenAt: now,
    updatedAt: now,
  }));

  const upsertedCustomers: Array<{ id: string; vendorCustomerId: string }> = [];
  for (const batch of chunk(customerValues, UPSERT_CHUNK)) {
    const rows = await tx
      .insert(backupProviderCustomers)
      .values(batch)
      .onConflictDoUpdate({
        target: [backupProviderCustomers.connectionId, backupProviderCustomers.vendorCustomerId],
        set: {
          vendorCustomerName: sql`excluded.vendor_customer_name`,
          vendorParentId: sql`excluded.vendor_parent_id`,
          vendorLevel: sql`excluded.vendor_level`,
          vendorExternalCode: sql`excluded.vendor_external_code`,
          deviceCount: sql`excluded.device_count`,
          lastSeenAt: sql`excluded.last_seen_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning({
        id: backupProviderCustomers.id,
        vendorCustomerId: backupProviderCustomers.vendorCustomerId,
      });
    upsertedCustomers.push(...rows);
  }

  const seenVendorCustomerIds = new Set(snapshot.customers.map((c) => c.vendorCustomerId));
  const vanishedCustomerIds = existingCustomers
    .filter((row) => !seenVendorCustomerIds.has(row.vendorCustomerId))
    .map((row) => row.id);
  for (const batch of chunk(vanishedCustomerIds, UPSERT_CHUNK)) {
    await tx.delete(backupProviderCustomers).where(inArray(backupProviderCustomers.id, batch));
  }

  await autoMapCustomers(tx, connection.id, connection.partnerId);

  // Mappings are read AFTER auto-mapping and inside this transaction, so a
  // manual remap that landed during the vendor fetch wins (spec, Sync job 3.2).
  const mappings = await tx
    .select({
      id: backupProviderCustomers.id,
      vendorCustomerId: backupProviderCustomers.vendorCustomerId,
      orgId: backupProviderCustomers.orgId,
    })
    .from(backupProviderCustomers)
    .where(eq(backupProviderCustomers.connectionId, connection.id));

  const mappedByVendorId = new Map<string, { id: string; orgId: string }>();
  let unmappedCustomers = 0;
  for (const mapping of mappings) {
    if (mapping.orgId) mappedByVendorId.set(mapping.vendorCustomerId, { id: mapping.id, orgId: mapping.orgId });
    else unmappedCustomers += 1;
  }

  // ---- devices ---------------------------------------------------------
  const existingDevices = await tx
    .select({
      id: backupProviderDevices.id,
      vendorDeviceId: backupProviderDevices.vendorDeviceId,
      customerId: backupProviderDevices.customerId,
    })
    .from(backupProviderDevices)
    .where(eq(backupProviderDevices.connectionId, connection.id));

  const mappedCustomerRowIds = new Set([...mappedByVendorId.values()].map((m) => m.id));
  let unmappedDevices = 0;
  const deviceValues: Array<Record<string, unknown>> = [];
  for (const device of snapshot.devices) {
    const mapping = mappedByVendorId.get(device.vendorCustomerId);
    if (!mapping) {
      unmappedDevices += 1;
      continue;
    }
    deviceValues.push({
      connectionId: connection.id,
      partnerId: connection.partnerId,
      orgId: mapping.orgId,
      customerId: mapping.id,
      provider: connection.provider,
      portalShowProviderName: connection.showProviderNameInPortal,
      vendorDeviceId: device.vendorDeviceId,
      vendorDeviceName: device.name.slice(0, 255),
      computerName: device.computerName?.slice(0, 255) ?? null,
      osType: device.osType,
      osVersion: device.osVersion?.slice(0, 255) ?? null,
      clientVersion: device.clientVersion?.slice(0, 64) ?? null,
      macAddresses: device.macAddresses,
      accountType: device.accountType,
      dataSources: device.dataSources,
      status: device.status,
      vendorStatusCode: device.vendorStatusCode,
      lastSessionAt: device.lastSessionAt,
      lastSuccessAt: device.lastSuccessAt,
      lastCompletedAt: device.lastCompletedAt,
      selectedBytes: device.selectedBytes,
      usedBytes: device.usedBytes,
      errorsCount: device.errorsCount,
      vendorCreatedAt: device.vendorCreatedAt,
      vendorExpiresAt: device.vendorExpiresAt,
      lastSeenAt: now,
      vendorRaw: device.raw,
      updatedAt: now,
    });
  }

  const upsertedDevices: Array<{
    id: string;
    orgId: string;
    status: ExternalBackupStatus;
    lastSuccessAt: Date | null;
    errorsCount: number;
  }> = [];
  for (const batch of chunk(deviceValues, UPSERT_CHUNK)) {
    const inputRows = batch as Array<{
      status: ExternalBackupStatus;
      lastSuccessAt: Date | null;
      errorsCount: number;
    }>;
    const rows = await tx
      .insert(backupProviderDevices)
      .values(batch as never)
      .onConflictDoUpdate({
        target: [backupProviderDevices.connectionId, backupProviderDevices.vendorDeviceId],
        set: {
          // org_id / customer_id follow the mapping read in THIS transaction, so
          // a device whose customer was re-homed lands under the new org in the
          // same commit that moved its parent (hence SET CONSTRAINTS above).
          orgId: sql`excluded.org_id`,
          customerId: sql`excluded.customer_id`,
          provider: sql`excluded.provider`,
          portalShowProviderName: sql`excluded.portal_show_provider_name`,
          vendorDeviceName: sql`excluded.vendor_device_name`,
          computerName: sql`excluded.computer_name`,
          osType: sql`excluded.os_type`,
          osVersion: sql`excluded.os_version`,
          clientVersion: sql`excluded.client_version`,
          macAddresses: sql`excluded.mac_addresses`,
          accountType: sql`excluded.account_type`,
          dataSources: sql`excluded.data_sources`,
          status: sql`excluded.status`,
          vendorStatusCode: sql`excluded.vendor_status_code`,
          lastSessionAt: sql`excluded.last_session_at`,
          lastSuccessAt: sql`excluded.last_success_at`,
          lastCompletedAt: sql`excluded.last_completed_at`,
          selectedBytes: sql`excluded.selected_bytes`,
          usedBytes: sql`excluded.used_bytes`,
          errorsCount: sql`excluded.errors_count`,
          vendorCreatedAt: sql`excluded.vendor_created_at`,
          vendorExpiresAt: sql`excluded.vendor_expires_at`,
          lastSeenAt: sql`excluded.last_seen_at`,
          vendorRaw: sql`excluded.vendor_raw`,
          updatedAt: sql`excluded.updated_at`,
          // breeze_device_id / device_match_source / pending_condition are
          // DELIBERATELY absent: the link and the alert state belong to Breeze,
          // not to the vendor payload, and an `excluded.` assignment here would
          // wipe both on every poll.
        },
      })
      .returning({
        id: backupProviderDevices.id,
        orgId: backupProviderDevices.orgId,
        status: backupProviderDevices.status,
        lastSuccessAt: backupProviderDevices.lastSuccessAt,
        errorsCount: backupProviderDevices.errorsCount,
      });
    // RETURNING preserves the VALUES list order for a plain multi-row INSERT,
    // so a returned row is zipped with the JS input at the same index. The
    // fallback (`??`) only ever fires against a test double that omits
    // requested columns — a real Postgres RETURNING always carries them.
    (rows as typeof upsertedDevices).forEach((row, i) => {
      const input = inputRows[i];
      upsertedDevices.push({
        id: row.id,
        orgId: row.orgId,
        status: row.status ?? input?.status,
        lastSuccessAt: row.lastSuccessAt ?? input?.lastSuccessAt ?? null,
        errorsCount: row.errorsCount ?? input?.errorsCount,
      });
    });
  }

  // Re-stamp any history row left behind by a device that changed org. The FK
  // is deferred for this transaction, so the mismatch is legal until COMMIT and
  // this statement is what makes it legal AT commit.
  await tx.execute(sql`
    UPDATE backup_provider_device_history AS h
    SET org_id = d.org_id
    FROM backup_provider_devices AS d
    WHERE h.provider_device_id = d.id
      AND d.connection_id = ${connection.id}::uuid
      AND h.org_id <> d.org_id
  `);

  const seenVendorDeviceIds = new Set(snapshot.devices.map((d) => d.vendorDeviceId));
  const staleDeviceIds = existingDevices
    .filter((row) => !seenVendorDeviceIds.has(row.vendorDeviceId) || !mappedCustomerRowIds.has(row.customerId))
    .map((row) => row.id);
  for (const batch of chunk(staleDeviceIds, UPSERT_CHUNK)) {
    await tx.delete(backupProviderDevices).where(inArray(backupProviderDevices.id, batch));
  }

  const { linked, ambiguous } = await matchProviderDevices(tx, connection.id);

  // ---- ledger ----------------------------------------------------------
  const day = utcDay(now);
  const ledgerValues = upsertedDevices.map((device) => ({
    providerDeviceId: device.id,
    orgId: device.orgId,
    day,
    status: device.status,
    lastSuccessAt: device.lastSuccessAt,
    errorsCount: device.errorsCount,
    observations: 1,
    updatedAt: now,
  }));

  const existingSeverity = backupStatusSeveritySql(sql`${backupProviderDeviceHistory.status}`);
  const incomingSeverity = backupStatusSeveritySql(sql`excluded.status`);

  for (const batch of chunk(ledgerValues, UPSERT_CHUNK)) {
    await tx
      .insert(backupProviderDeviceHistory)
      .values(batch as never)
      .onConflictDoUpdate({
        target: [backupProviderDeviceHistory.providerDeviceId, backupProviderDeviceHistory.day],
        set: {
          // Worst status observed that day wins; a day with 48 polls of one
          // failed session is ONE failed day, never 48 failures.
          status: sql`CASE WHEN ${incomingSeverity} > ${existingSeverity}
                           THEN excluded.status ELSE ${backupProviderDeviceHistory.status} END`,
          errorsCount: sql`GREATEST(${backupProviderDeviceHistory.errorsCount}, excluded.errors_count)`,
          observations: sql`${backupProviderDeviceHistory.observations} + 1`,
          // GREATEST ignores NULLs in Postgres, so a first-ever success on the
          // second poll of the day is adopted rather than discarded.
          lastSuccessAt: sql`GREATEST(${backupProviderDeviceHistory.lastSuccessAt}, excluded.last_success_at)`,
          orgId: sql`excluded.org_id`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  await tx.execute(sql`
    DELETE FROM backup_provider_device_history AS h
    USING backup_provider_devices AS d
    WHERE h.provider_device_id = d.id
      AND d.connection_id = ${connection.id}::uuid
      AND h.day < (${day}::date - ${sql.raw(String(LEDGER_RETENTION_DAYS))})
  `);

  return {
    customers: upsertedCustomers.length,
    unmappedCustomers,
    devices: upsertedDevices.length,
    unmappedDevices,
    linked,
    ambiguous,
  };
}
