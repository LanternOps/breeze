/**
 * W03 Task 12 — fills the W01 seam. Retirement resolves ALL selected open
 * subjects regardless of autoResolve/requiresHuman (a component that no
 * longer reports at all is not a "recovery" the monitor observed; it is
 * gone), then stages a durable recovery envelope for each CAS winner in the
 * SAME savepoint so a later failure in the caller's transaction (ingest or
 * the reaper) rolls resolution and staging back together. Publication and
 * cooldown/state-transition effects happen only after commit, via
 * `drainRetirementOutbox` — see `retirementOutbox.ts`.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, withDbTransaction } from '../../db';
import { alerts } from '../../db/schema';
import { resolveAlert, RESOLVABLE_ALERT_STATUSES } from '../alertService';
import { stageRetiredSubjectResolution } from './retirementOutbox';

export async function resolveAlertsForRemovedComponents(deviceId: string, componentKeys: string[]): Promise<number> {
  if (componentKeys.length === 0) return 0;
  return withDbTransaction(async () => {
    const open = await db.select({ id: alerts.id }).from(alerts).where(and(
      eq(alerts.deviceId, deviceId), inArray(alerts.subjectKey, componentKeys),
      inArray(alerts.status, [...RESOLVABLE_ALERT_STATUSES]),
    ));
    let count = 0;
    for (const alert of open) {
      if (!await resolveAlert(alert.id, 'component no longer reported', undefined, true)) continue;
      await stageRetiredSubjectResolution(alert.id);
      count++;
    }
    return count;
  });
}
