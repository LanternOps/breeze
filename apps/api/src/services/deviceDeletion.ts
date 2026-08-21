import * as Sentry from '@sentry/node';
import { eq, sql } from 'drizzle-orm';
import { devices } from '../db/schema';
import {
  DEVICE_DETACH_DEVICE_ID_TABLES,
  DEVICE_LINKED_DEVICE_ID_TABLES,
  getDeviceCascadeDeleteTables,
} from '../routes/devices/core';

/**
 * Minimal transaction surface this needs — satisfied by a Drizzle tx handle.
 * Typed structurally so callers can pass either a tx or the db handle without
 * dragging Drizzle's full generic transaction type through every signature.
 */
export interface DeviceDeletionTx {
  execute(query: unknown): Promise<unknown>;
  delete(table: typeof devices): { where(condition: unknown): Promise<unknown> };
}

/**
 * Delete a device row and every record that references it.
 *
 * Extracted from DELETE /devices/:id/permanent so the Quick Support reaper
 * purges ephemeral devices through the SAME code path. Two hand-rolled cascade
 * implementations would drift the moment a table is added to one list and not
 * the other — the exact failure mode that has produced FK-violation and
 * orphaned-row bugs in this repo before.
 *
 * Order matters and is not alphabetical:
 *   0. lock the devices row (SELECT ... FOR UPDATE) so this transaction takes
 *      the parent lock first, matching every other writer — see below
 *   1. transitive children (rows referencing alerts/ai_sessions, which
 *      themselves reference the device) — they have no device_id of their own
 *   2. linked_device_id and device_id detach targets set to NULL (business
 *      records like tickets and support_sessions outlive the device)
 *   3. the device_id cascade tables
 *   4. the device row itself
 *
 * Caller supplies the transaction: the route pairs this with link-group
 * dissolution, and the reaper runs it standalone.
 */
export async function deleteDeviceCascade(
  tx: DeviceDeletionTx,
  deviceId: string,
): Promise<void> {
  // Take the PARENT lock first, before any child table is touched.
  //
  // FK constraints force children-before-parent for the DELETEs themselves, so
  // the delete order cannot be inverted to match the rest of the codebase. That
  // leaves this transaction acquiring child locks first while every other
  // writer spanning both levels — re-enrollment, site move, moveOrg, and
  // PUT /agents/:id/network since #3739 — takes the devices row first. A
  // permanent delete racing any of them on the same device is a textbook AB-BA
  // deadlock (Postgres 40P01, the class of failure #3739 fixed as BREEZE-1S).
  //
  // A SELECT ... FOR UPDATE restores devices-first ordering without violating
  // the FK delete order, and gives the cascade a serialization point against
  // concurrent agent writes. It must stay the FIRST statement here: this
  // function is the single choke point both the route and the Quick Support
  // reaper go through, so the lock cannot be forgotten by a new caller.
  //
  // IMPORTANT — the guarantee is conditional, and issuing this statement is NOT
  // the same as holding the lock. FOR UPDATE locks only rows the statement can
  // SEE, so it locks nothing when the device row is already gone (a re-run, or
  // two reapers racing) or when RLS filters it out — this cascade runs inside
  // the caller's tenant-scoped context, and at least one table it touches is
  // deliberately invisible under that policy (see the abuse_endpoint_fingerprints
  // note below). In that case the child cleanup below proceeds under the OLD
  // child-first ordering, which is the exact race this lock exists to close.
  //
  // Deleting an absent device is legitimately idempotent, so a zero-row result
  // must NOT abort — two reapers racing would then error instead of one simply
  // finding nothing. Report it instead, so an unserialized cascade is visible
  // rather than silently assumed safe.
  const locked = (await tx.execute(
    sql`SELECT id FROM devices WHERE id = ${deviceId} FOR UPDATE`
  )) as { rowCount?: number | null; rows?: unknown[] } | undefined;
  const lockedRows = locked?.rowCount ?? locked?.rows?.length ?? 0;
  if (lockedRows === 0) {
    Sentry.captureMessage('device cascade ran without holding the devices row lock', {
      level: 'warning',
      tags: { area: 'device-deletion' },
      extra: { deviceId, reason: 'device row absent or filtered by RLS' },
    });
  }

  const deviceAlertIds = sql`(SELECT id FROM alerts WHERE device_id = ${deviceId})`;
  const deviceAiSessionIds = sql`(SELECT id FROM ai_sessions WHERE device_id = ${deviceId})`;

  await tx.execute(sql`DELETE FROM ai_tool_executions WHERE session_id IN ${deviceAiSessionIds}`);
  await tx.execute(sql`DELETE FROM ai_messages WHERE session_id IN ${deviceAiSessionIds}`);
  await tx.execute(sql`DELETE FROM ai_action_plans WHERE session_id IN ${deviceAiSessionIds}`);
  await tx.execute(sql`DELETE FROM alert_correlations WHERE parent_alert_id IN ${deviceAlertIds} OR child_alert_id IN ${deviceAlertIds}`);
  await tx.execute(sql`DELETE FROM alert_notifications WHERE alert_id IN ${deviceAlertIds}`);
  // psa_ticket_mappings.alert_id -> alerts(id) has NO explicit ON DELETE (so
  // NO ACTION), and 'alerts' sits in the "Monitoring & logs" block of
  // CORE_DEVICE_CASCADE_DELETE_TABLES, ~30 entries AHEAD of
  // 'psa_ticket_mappings' in "Portal & integrations". The list-driven loop
  // below therefore deletes the alerts first and raises 23503 on any mapping
  // that referenced one. Clear both FK arms here, with the other transitive
  // alert children. The list entry stays — this just makes it a no-op.
  await tx.execute(sql`DELETE FROM psa_ticket_mappings WHERE alert_id IN ${deviceAlertIds} OR device_id = ${deviceId}`);
  await tx.execute(sql`UPDATE log_correlations SET alert_id = NULL WHERE alert_id IN ${deviceAlertIds}`);
  await tx.execute(sql`UPDATE network_change_events SET alert_id = NULL WHERE alert_id IN ${deviceAlertIds}`);

  for (const linkedTable of DEVICE_LINKED_DEVICE_ID_TABLES) {
    await tx.execute(sql`UPDATE ${sql.identifier(linkedTable)} SET linked_device_id = NULL WHERE linked_device_id = ${deviceId}`);
  }

  // Tenant business records (tickets, support_sessions): preserve history,
  // detach the device.
  //
  // For abuse_endpoint_fingerprints specifically, this UPDATE is a structural
  // no-op: it's a system-only-RLS corpus table, and this cascade runs inside
  // the caller's tenant-scoped request context, so the tenant policy filters
  // every row out before the UPDATE ever sees one. The real detach happens
  // via the column's `device_id` FK, declared ON DELETE SET NULL — that fires
  // unconditionally at the DB layer once the device row below is deleted, no
  // RLS context involved. Listed here anyway for the single detach-tables
  // contract (getDeviceCascadeDeleteTables et al.), not because this line
  // does the work for that table.
  for (const detachTable of DEVICE_DETACH_DEVICE_ID_TABLES) {
    await tx.execute(sql`UPDATE ${sql.identifier(detachTable)} SET device_id = NULL WHERE device_id = ${deviceId}`);
  }

  for (const table of getDeviceCascadeDeleteTables()) {
    await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE device_id = ${deviceId}`);
  }

  await tx.delete(devices).where(eq(devices.id, deviceId));
}
