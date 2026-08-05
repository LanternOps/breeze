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
  const deviceAlertIds = sql`(SELECT id FROM alerts WHERE device_id = ${deviceId})`;
  const deviceAiSessionIds = sql`(SELECT id FROM ai_sessions WHERE device_id = ${deviceId})`;

  await tx.execute(sql`DELETE FROM ai_tool_executions WHERE session_id IN ${deviceAiSessionIds}`);
  await tx.execute(sql`DELETE FROM ai_messages WHERE session_id IN ${deviceAiSessionIds}`);
  await tx.execute(sql`DELETE FROM ai_action_plans WHERE session_id IN ${deviceAiSessionIds}`);
  await tx.execute(sql`DELETE FROM alert_correlations WHERE parent_alert_id IN ${deviceAlertIds} OR child_alert_id IN ${deviceAlertIds}`);
  await tx.execute(sql`DELETE FROM alert_notifications WHERE alert_id IN ${deviceAlertIds}`);
  await tx.execute(sql`UPDATE log_correlations SET alert_id = NULL WHERE alert_id IN ${deviceAlertIds}`);
  await tx.execute(sql`UPDATE network_change_events SET alert_id = NULL WHERE alert_id IN ${deviceAlertIds}`);

  for (const linkedTable of DEVICE_LINKED_DEVICE_ID_TABLES) {
    await tx.execute(sql`UPDATE ${sql.identifier(linkedTable)} SET linked_device_id = NULL WHERE linked_device_id = ${deviceId}`);
  }

  // Tenant business records (tickets, support_sessions): preserve history,
  // detach the device.
  for (const detachTable of DEVICE_DETACH_DEVICE_ID_TABLES) {
    await tx.execute(sql`UPDATE ${sql.identifier(detachTable)} SET device_id = NULL WHERE device_id = ${deviceId}`);
  }

  for (const table of getDeviceCascadeDeleteTables()) {
    await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE device_id = ${deviceId}`);
  }

  await tx.delete(devices).where(eq(devices.id, deviceId));
}
