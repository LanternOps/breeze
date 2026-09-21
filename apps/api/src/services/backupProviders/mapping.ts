import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, runOutsideDbContext } from '../../db';
import {
  backupProviderCustomers,
  backupProviderDeviceHistory,
  backupProviderDevices,
  organizations,
} from '../../db/schema';
import { enqueueBackupProviderSync } from '../../jobs/backupProviderSync';
import { resolveProviderAlertsForCustomer } from './alertsResolve';

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
