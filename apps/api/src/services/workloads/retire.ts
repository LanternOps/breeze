/**
 * Image alert retirement (workload inventory W06, #8195, spec §10.2).
 *
 * When ingest removes the last container row referencing an image subject on
 * a device, that image's open container_image_currency alert is resolved in
 * the SAME transaction, and its recovery envelope is staged in the shared
 * retirement outbox (published only after commit by `drainRetirementOutbox`,
 * via the alert worker's per-device drain or the minute tick). Same contract
 * as hardware retirement (`services/hardwareHealth/retire.ts`), scoped to
 * this monitor kind so a subject key shared with another kind never matches.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, withDbTransaction } from '../../db';
import { alerts } from '../../db/schema';
import { resolveAlert, RESOLVABLE_ALERT_STATUSES } from '../alertService';
import { stageRetiredSubjectResolution } from '../hardwareHealth/retirementOutbox';

export async function resolveAlertsForRetiredImages(
  deviceId: string,
  subjectKeys: string[],
  note = 'image no longer running on this device',
): Promise<number> {
  if (subjectKeys.length === 0) return 0;
  return withDbTransaction(async () => {
    const open = await db.select({ id: alerts.id }).from(alerts).where(and(
      eq(alerts.deviceId, deviceId),
      inArray(alerts.subjectKey, subjectKeys),
      inArray(alerts.status, [...RESOLVABLE_ALERT_STATUSES]),
      sql`${alerts.context}->>'source' = 'container_image_currency'`,
    ));
    let count = 0;
    for (const alert of open) {
      if (!await resolveAlert(alert.id, note, undefined, true, 'source_retired')) continue;
      await stageRetiredSubjectResolution(alert.id);
      count++;
    }
    return count;
  });
}
