import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, runOutsideDbContext } from '../../db';
import {
  backupProviderCustomers,
  backupProviderDeviceHistory,
  backupProviderDevices,
  organizations,
} from '../../db/schema';
import { enqueueBackupProviderSync } from '../../jobs/backupProviderSync';
import { captureException } from '../sentry';
import { resolveProviderAlertsForCustomer } from './alertsResolve';
import type { ProviderSyncTx } from './persist';

export interface RemapCustomerActor {
  userId: string | null;
  partnerId: string;
}

export interface RemapCustomerResult {
  customerId: string;
  connectionId: string;
  orgId: string | null;
  mappingSource: 'manual' | 'manual_unmapped';
  deletedDevices: number;
  deletedHistory: number;
  resolvedAlerts: number;
  /** Null when the post-commit enqueue failed; the next scheduled sync still picks it up. */
  syncJobId: string | null;
}

export type RemapCustomerErrorCode = 'NOT_FOUND' | 'ORG_NOT_IN_PARTNER';

export class RemapCustomerError extends Error {
  readonly code: RemapCustomerErrorCode;
  constructor(code: RemapCustomerErrorCode, message: string) {
    super(message);
    this.name = 'RemapCustomerError';
    this.code = code;
  }
}

/**
 * Map, re-map or un-map one vendor customer — atomically, so nothing about the
 * OLD organization outlives the change.
 *
 * Order, and why:
 *   1. Resolve the customer's open provider alerts. OUTSIDE the transaction on
 *      purpose: `resolveAlert` publishes `alert.resolved` on the event bus, and
 *      announcing a resolution from inside a transaction that can still roll
 *      back would have webhooks and automations act on something that did not
 *      happen. If the transaction does roll back, W02's two-poll hysteresis
 *      re-raises the condition on the next sync.
 *   2. ONE transaction: delete the ledger rows, then the device rows, then
 *      update `org_id` / `mapping_source`. This is the guarantee that matters —
 *      nothing stays visible to the old org for even a moment.
 *   3. Enqueue a sync AFTER the commit and OUTSIDE any DB context, so the rows
 *      reappear under the new org within seconds. The queue is instrumented
 *      with `assertOutsideHeldDbContext`, which throws in CI if this runs
 *      inside a held transaction.
 *
 * `manual` and `manual_unmapped` are both terminal for auto-mapping: W02's
 * `autoMapCustomers` only ever touches rows whose `mapping_source IS NULL`, so
 * an operator's decision to leave a customer unmapped is never silently undone.
 */
export async function remapCustomer(
  customerId: string,
  orgId: string | null,
  actor: RemapCustomerActor,
): Promise<RemapCustomerResult> {
  // Validate the target org BEFORE anything is written or resolved. The
  // composite FK (org_id, partner_id) -> organizations(id, partner_id) would
  // also refuse a foreign org, but as a 23503 inside the request transaction —
  // which poisons it, so the friendly 422 would become a 500 at COMMIT.
  if (orgId !== null) {
    const [org] = await db
      .select({ id: organizations.id, partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org || org.partnerId !== actor.partnerId) {
      throw new RemapCustomerError(
        'ORG_NOT_IN_PARTNER',
        'The target organization does not belong to this partner',
      );
    }
  }

  const resolvedAlerts = await resolveProviderAlertsForCustomer(
    customerId,
    'Resolved by a backup provider customer remap',
  );

  const mappingSource: 'manual' | 'manual_unmapped' = orgId === null ? 'manual_unmapped' : 'manual';

  const outcome = await db.transaction(async (tx) => {
    const [customer] = await tx
      .select({
        id: backupProviderCustomers.id,
        connectionId: backupProviderCustomers.connectionId,
        partnerId: backupProviderCustomers.partnerId,
      })
      .from(backupProviderCustomers)
      .where(eq(backupProviderCustomers.id, customerId))
      .for('update')
      .limit(1);

    // RLS already hides another partner's row, so this is normally
    // belt-and-braces — but a system-context caller (a future admin tool) sees
    // every row, and this check is what stops one partner's mapping being
    // rewritten through such a path.
    if (!customer || customer.partnerId !== actor.partnerId) {
      throw new RemapCustomerError('NOT_FOUND', 'Backup provider customer not found');
    }

    const deviceRows = await tx
      .select({ id: backupProviderDevices.id })
      .from(backupProviderDevices)
      .where(eq(backupProviderDevices.customerId, customerId));
    const deviceIds = deviceRows.map((row) => row.id);

    // Ledger before devices. The FK is ON DELETE CASCADE, so Postgres would do
    // it either way — but doing it explicitly keeps the deleted-row counts
    // honest for the audit entry, and keeps the statement order legible when
    // the cascade contract is next reviewed.
    let deletedHistory = 0;
    if (deviceIds.length > 0) {
      const historyResult = await tx
        .delete(backupProviderDeviceHistory)
        .where(inArray(backupProviderDeviceHistory.providerDeviceId, deviceIds))
        .returning({ id: backupProviderDeviceHistory.id });
      deletedHistory = historyResult.length;
    }

    const deletedDeviceRows = deviceIds.length === 0 ? [] : await tx
      .delete(backupProviderDevices)
      .where(eq(backupProviderDevices.customerId, customerId))
      .returning({ id: backupProviderDevices.id });

    const [updated] = await tx
      .update(backupProviderCustomers)
      .set({ orgId, mappingSource, deviceCount: 0, updatedAt: new Date() })
      .where(eq(backupProviderCustomers.id, customerId))
      .returning({
        id: backupProviderCustomers.id,
        orgId: backupProviderCustomers.orgId,
      });
    if (!updated) {
      throw new RemapCustomerError('NOT_FOUND', 'Backup provider customer not found');
    }

    return {
      connectionId: customer.connectionId,
      deletedDevices: deletedDeviceRows.length,
      deletedHistory,
    };
  });

  // After COMMIT, outside every DB context (#1105 / the instrumented queue's
  // tripwire). A failure here is NOT a failure of the remap: the mapping has
  // changed and the rows are gone, and the scheduled sync will refill them.
  let syncJobId: string | null = null;
  try {
    syncJobId = await runOutsideDbContext(() => enqueueBackupProviderSync(outcome.connectionId));
  } catch (error) {
    console.error(
      `[backupProvider] remap of customer ${customerId} committed, but the follow-up sync could not be queued:`,
      error instanceof Error ? error.message : error,
    );
    captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
      service: 'backupProviders',
      operation: 'remapCustomer.enqueueSync',
      customerId,
      connectionId: outcome.connectionId,
    });
  }

  return {
    customerId,
    connectionId: outcome.connectionId,
    orgId,
    mappingSource,
    deletedDevices: outcome.deletedDevices,
    deletedHistory: outcome.deletedHistory,
    resolvedAlerts,
    syncJobId,
  };
}

/**
 * Version/variant-agnostic UUID shape — deliberately NOT the RFC-4122-strict
 * pattern, matching `PG_UUID_REGEX`'s rationale in apps/api/src/db/index.ts:634-641.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AutoMapCustomerRow {
  id: string;
  vendorCustomerName: string;
  vendorExternalCode: string | null;
}

export interface AutoMapOrgRow {
  id: string;
  name: string;
}

export type AutoMapDecision = {
  customerId: string;
  orgId: string;
  mappingSource: 'auto_external_code' | 'auto_name';
};

function normalizeName(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * PURE auto-mapping rules (spec, `backup_provider_customers` section).
 *
 * Both inputs are already scoped to ONE connection and ONE partner by the
 * caller; this function never widens that. Rule order is deliberate and the
 * external code always wins: it is an identifier the MSP typed on purpose,
 * while a name collision is an accident waiting to happen.
 *
 * An org is claimed by at most one customer per pass — two vendor customers
 * pointing at one Breeze org is a data problem a human must settle, and
 * silently mapping both would double-count that org's coverage.
 */
export function resolveCustomerAutoMappings(
  customers: AutoMapCustomerRow[],
  orgs: AutoMapOrgRow[],
): AutoMapDecision[] {
  const orgById = new Map(orgs.map((o) => [o.id.toLowerCase(), o.id]));
  const orgsByName = new Map<string, string[]>();
  for (const org of orgs) {
    const key = normalizeName(org.name);
    if (!key) continue;
    const bucket = orgsByName.get(key);
    if (bucket) bucket.push(org.id);
    else orgsByName.set(key, [org.id]);
  }

  const byCode: AutoMapDecision[] = [];
  const byName: AutoMapDecision[] = [];

  for (const customer of customers) {
    const code = customer.vendorExternalCode?.trim();
    if (code && UUID_RE.test(code)) {
      const orgId = orgById.get(code.toLowerCase());
      if (orgId) {
        byCode.push({ customerId: customer.id, orgId, mappingSource: 'auto_external_code' });
        continue;
      }
    }
    const key = normalizeName(customer.vendorCustomerName);
    if (!key) continue;
    const candidates = orgsByName.get(key);
    if (!candidates || candidates.length !== 1) continue;
    byName.push({ customerId: customer.id, orgId: candidates[0]!, mappingSource: 'auto_name' });
  }

  // Two passes so an external-code match always beats a name match for the
  // same org, whatever order the vendor returned the customers in.
  const claimed = new Set<string>();
  const out: AutoMapDecision[] = [];
  for (const decision of [...byCode, ...byName]) {
    if (claimed.has(decision.orgId)) continue;
    claimed.add(decision.orgId);
    out.push(decision);
  }
  return out;
}

/**
 * Map every still-unmapped customer of this connection, in ONE statement.
 *
 * `mapping_source IS NULL` is the whole eligibility rule: `manual` and
 * `manual_unmapped` are a technician's decision that auto-mapping never
 * overrides, and an existing `auto_*` row is left alone so a rename on the
 * vendor side cannot silently re-home devices mid-sync (the remap route is the
 * only path that moves rows between orgs, and it does so atomically).
 *
 * @returns the number of customers newly mapped.
 */
export async function autoMapCustomers(
  tx: ProviderSyncTx,
  connectionId: string,
  partnerId: string,
): Promise<number> {
  const customers = await tx
    .select({
      id: backupProviderCustomers.id,
      vendorCustomerName: backupProviderCustomers.vendorCustomerName,
      vendorExternalCode: backupProviderCustomers.vendorExternalCode,
    })
    .from(backupProviderCustomers)
    .where(and(
      eq(backupProviderCustomers.connectionId, connectionId),
      isNull(backupProviderCustomers.mappingSource),
    ));

  if (customers.length === 0) return 0;

  const orgs = await tx
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(and(
      eq(organizations.partnerId, partnerId),
      isNull(organizations.deletedAt),
      isNull(organizations.archivedAt),
      sql`${organizations.status} NOT IN ('archived','purging','merging')`,
    ));

  const decisions = resolveCustomerAutoMappings(customers, orgs);
  if (decisions.length === 0) return 0;

  // One UPDATE ... FROM (VALUES ...) rather than N statements. The
  // `mapping_source IS NULL` predicate is repeated here on purpose: it is the
  // concurrency control, so a manual remap that landed between the SELECT and
  // this write wins instead of being clobbered.
  const values = sql.join(
    decisions.map((d) => sql`(${d.customerId}::uuid, ${d.orgId}::uuid, ${d.mappingSource})`),
    sql`, `,
  );
  const updated = await tx.execute(sql`
    UPDATE backup_provider_customers AS c
    SET org_id = v.org_id, mapping_source = v.mapping_source, updated_at = now()
    FROM (VALUES ${values}) AS v(customer_id, org_id, mapping_source)
    WHERE c.id = v.customer_id
      AND c.connection_id = ${connectionId}::uuid
      AND c.mapping_source IS NULL
    RETURNING c.id
  `);
  return (updated as unknown as unknown[]).length;
}
