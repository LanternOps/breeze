import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import { alerts, backupProviderDevices } from '../../db/schema';
import { RESOLVABLE_ALERT_STATUSES, resolveAlert } from '../alertService';

/**
 * The `alerts.context.source` discriminator every backup-provider alert
 * carries. W02's evaluator writes it; this module is the only thing that
 * closes them outside the sync.
 */
export const BACKUP_PROVIDER_ALERT_SOURCE = 'backup_provider';

/** The `publisher` label on the event-bus side (W02). Declared here so both waves agree. */
export const BACKUP_PROVIDER_ALERT_PUBLISHER = 'backup-provider-sync';

/**
 * Close a set of alerts, one compare-and-swap at a time.
 *
 * `resolveAlert` returns false when it LOSES the CAS (someone else already
 * resolved or dismissed the row); those are not counted, so the number the
 * route puts in its audit entry is the number of transitions this call actually
 * made.
 *
 * A throw on one alert is logged and skipped rather than propagated: these
 * calls stand between an operator and a connection delete or a customer remap,
 * and one wedged alert must not block either.
 */
async function resolveEach(alertIds: string[], note: string): Promise<number> {
  let resolved = 0;
  for (const alertId of alertIds) {
    try {
      if (await resolveAlert(alertId, note)) resolved += 1;
    } catch (error) {
      console.error(
        `[backupProvider] failed to resolve alert ${alertId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return resolved;
}

/** Open provider alerts (`active | acknowledged | suppressed`) matching a jsonb context predicate. */
async function openProviderAlertIds(extra: ReturnType<typeof sql>): Promise<string[]> {
  const rows = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(
      inArray(alerts.status, [...RESOLVABLE_ALERT_STATUSES]),
      sql`${alerts.context}->>'source' = ${BACKUP_PROVIDER_ALERT_SOURCE}`,
      extra,
    ));
  return rows.map((row) => row.id);
}

/**
 * Every open alert raised for any device under `connectionId`.
 *
 * Called by `DELETE /backup/providers/connections/:id` BEFORE the delete: the
 * rows the alerts describe are about to cascade away, and an alert pointing at
 * a deleted provider device can never auto-resolve — it would sit in the alert
 * center forever with a device name nobody can find.
 */
export async function resolveProviderAlertsForConnection(
  connectionId: string,
  note = 'Backup provider connection removed from Breeze',
): Promise<number> {
  const ids = await openProviderAlertIds(sql`${alerts.context}->>'connectionId' = ${connectionId}`);
  return resolveEach(ids, note);
}

/** Every open alert raised for one of the given provider device rows. */
export async function resolveProviderAlertsForProviderDevices(
  providerDeviceIds: string[],
  note = 'Backup provider device row removed',
): Promise<number> {
  if (providerDeviceIds.length === 0) return 0;
  const ids = await openProviderAlertIds(
    sql`${alerts.context}->>'providerDeviceId' = ANY(${providerDeviceIds})`,
  );
  return resolveEach(ids, note);
}

/**
 * Every open alert raised for a device under one vendor customer. Used by the
 * atomic remap, whose whole point is that nothing about the old org survives
 * the mapping change.
 */
export async function resolveProviderAlertsForCustomer(
  customerId: string,
  note = 'Backup provider customer remapped to a different organization',
): Promise<number> {
  const rows = await db
    .select({ id: backupProviderDevices.id })
    .from(backupProviderDevices)
    .where(eq(backupProviderDevices.customerId, customerId));
  return resolveProviderAlertsForProviderDevices(rows.map((row) => row.id), note);
}
