import * as Sentry from '@sentry/node';
import { eq, sql } from 'drizzle-orm';
import { devices } from '../db/schema';
// Shared postgres-js/drizzle row-count reader. Imported rather than re-derived:
// this repo already has six copies of the same three-shape check, and getting it
// wrong here reports the opposite of the truth (see the lock check below).
import { extractRowCount } from '../jobs/deviceMetricsRetention';
import {
  DEVICE_DETACH_DEVICE_ID_TABLES,
  DEVICE_LINKED_DEVICE_ID_TABLES,
  getDeviceCascadeDeleteTables,
} from '../routes/devices/core';

/**
 * Bound on how long the parent-row lock below may wait.
 *
 * Without it, converting a deadlock into a plain lock wait trades a fast 40P01
 * for a potentially unbounded block on a request-path DELETE — and a hung
 * transaction holds its pooled connection, which has been a recurring
 * production failure here rather than a hypothetical. A deadlock resolves in
 * milliseconds; a wait behind a long-running site move does not. Bounding it
 * turns that case into a fast 55P03 (lock_not_available), which the permanent
 * -delete route maps to a retryable 409 rather than a generic 500.
 *
 * The setting is RESTORED immediately after the lock is taken — see below. It
 * must not stay in force for the child deletes or for the caller's later work.
 */
const DEVICE_LOCK_TIMEOUT_MS = 3000;

/**
 * Read `current_setting('lock_timeout')` out of a postgres-js result.
 *
 * postgres-js resolves to an array-like of row objects, so the value is at
 * `[0].lock_timeout`.
 *
 * Throws rather than substituting a default. There is no safe guess: `'0'`
 * means "wait forever" in Postgres, so inventing it would silently WIDEN a
 * caller or role that had deliberately set a stricter timeout, for the whole
 * remainder of the outer transaction. This can only fire if the driver's result
 * shape changes, which is precisely the class of silent breakage that produced
 * the row-count bug this same commit fixes — fail loudly instead. Nothing has
 * been mutated at this point, so aborting here is safe.
 */
function extractLockTimeout(result: unknown): string {
  const row = Array.isArray(result)
    ? (result[0] as { lock_timeout?: unknown } | undefined)
    : undefined;
  if (typeof row?.lock_timeout !== 'string') {
    throw new Error(
      "deleteDeviceCascade: could not read current_setting('lock_timeout') — " +
        'refusing to change the lock timeout without being able to restore it'
    );
  }
  return row.lock_timeout;
}

/**
 * Minimal transaction surface this needs — satisfied by a Drizzle tx handle.
 * Typed structurally so callers need not drag Drizzle's full generic
 * transaction type through every signature.
 *
 * This MUST be a real transaction (or savepoint), never the raw `db` handle.
 * Under autocommit each statement commits on its own, which would (a) discard
 * the transaction-local lock_timeout before the lock is even attempted, (b)
 * release the parent row lock before the first child delete — defeating the
 * entire point of this function — and (c) allow a half-finished cascade to
 * persist. Both callers pass a transaction; keep it that way.
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
 *   0. bound the wait (transaction-local lock_timeout), then lock the devices
 *      row (SELECT ... FOR UPDATE) so this transaction takes the parent lock
 *      first, matching every other writer — see below
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
  //
  // Bound the wait, then put it back.
  //
  // `set_config(..., true)` is transaction-local, NOT statement-local: Postgres
  // applies lock_timeout to every subsequent lock acquisition until the
  // transaction ends. Both callers already run inside an outer transaction
  // (withDbAccessContext opens one — db/index.ts), and a nested
  // `db.transaction()` is only a SAVEPOINT, whose release does NOT undo a
  // SET LOCAL. So without an explicit restore this 3s bound would silently
  // govern every child DELETE below, the route's link-group dissolution, and —
  // in the reaper, which wraps its whole pass in one context — every device
  // purged after this one. Capture the caller's value and restore it as soon as
  // the row lock is held; the lock itself survives to transaction end, so the
  // timeout does not need to stay in force.
  const priorLockTimeout = extractLockTimeout(
    await tx.execute(sql`SELECT current_setting('lock_timeout') AS lock_timeout`)
  );
  await tx.execute(
    sql`select set_config('lock_timeout', ${`${DEVICE_LOCK_TIMEOUT_MS}ms`}, true)`
  );
  const locked = await tx.execute(
    sql`SELECT id FROM devices WHERE id = ${deviceId} FOR UPDATE`
  );
  // Restored only on the success path, deliberately. If the lock times out the
  // statement aborts the (sub)transaction, and any statement issued after that
  // fails with 25P02 — a `finally` here would mask the 55P03 the caller needs
  // to see. Nothing leaks on that path: rolling back to the savepoint that
  // precedes a SET LOCAL undoes it, which is exactly what Drizzle's nested
  // transaction does on error.
  await tx.execute(
    sql`select set_config('lock_timeout', ${priorLockTimeout}, true)`
  );
  // postgres-js resolves to an array-like carrying `.count` — NOT node-postgres'
  // `.rowCount`/`.rows`. Reading the wrong shape yields 0 on every call, which
  // would fire the warning below on every successful delete and bury the one
  // signal that the RLS/absent-row branch actually happened.
  const lockedRows = extractRowCount(locked);
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
