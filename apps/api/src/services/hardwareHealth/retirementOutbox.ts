/**
 * W03 Task 12 — the durable retirement recovery outbox.
 *
 * `resolveAlertsForRemovedComponents` (`retire.ts`) resolves an alert with
 * `deferSubjectEffects=true`, which stages a `SubjectAlertDispatch` recovery
 * envelope on the alert row (`alerts.context._subjectResolutionDispatch`)
 * inside the caller's transaction. `stageRetiredSubjectResolution` copies
 * that envelope into `hardware_alert_retirement_outbox` — an org-scoped
 * table with no device_id/alert_id FK — in the SAME transaction, then wipes
 * the alert-local copy so there is only one dispatch path. The device (and
 * therefore the alert, via its cascade) may be deleted before the recovery
 * is ever published; the outbox row survives that because it belongs to the
 * organization, not the device.
 *
 * `drainRetirementOutbox` runs strictly after commit (mirrors
 * `subjectAlertOutbox.ts`'s "nothing publishes before commit" contract) and
 * is wired into `drainSubjectAlertOutbox` so both the per-device worker
 * drain and the fleet-wide minute tick retry it.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, assertInTransaction, hasDbAccessContext, withSystemDbAccessContext } from '../../db';
import { alerts, hardwareAlertRetirementOutbox } from '../../db/schema';
import type { SubjectAlertDispatch } from '../alertService';
import { publishEvent } from '../eventBus';
import { recordStateTransition, setCooldown } from '../alertCooldown';
import { captureException } from '../sentry';

export async function stageRetiredSubjectResolution(alertId: string): Promise<void> {
  assertInTransaction('stageRetiredSubjectResolution');
  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO hardware_alert_retirement_outbox (id, org_id, envelope)
    SELECT (context->'_subjectResolutionDispatch'->>'eventId')::uuid, org_id,
      context->'_subjectResolutionDispatch' FROM alerts
    WHERE id = ${alertId} AND status = 'resolved' AND context ? '_subjectResolutionDispatch'
    RETURNING id`);
  if (inserted.length !== 1) throw new Error('Retired subject has no recovery envelope');
  await db.update(alerts).set({ context: sql`${alerts.context} - '_subjectResolutionDispatch'` })
    .where(eq(alerts.id, alertId));
}

/**
 * Drain every committed-but-undelivered retirement recovery envelope.
 * Optionally scoped to one device (the per-device worker drain, called by
 * `drainSubjectAlertOutbox`); with no `deviceId`, drains fleet-wide (the
 * minute tick), which is what lets a retirement staged just before a device
 * was deleted still retry and publish.
 */
export async function drainRetirementOutbox(deviceId?: string): Promise<void> {
  if (hasDbAccessContext()) throw new Error('Retirement outbox must run after commit');
  const token = randomUUID();
  const rows = await withSystemDbAccessContext(() => db.execute<{
    id: string; orgId: string; envelope: SubjectAlertDispatch;
  }>(sql`
    WITH candidates AS (
      SELECT id FROM hardware_alert_retirement_outbox
      WHERE COALESCE(lease_until, '-infinity') < now()
        AND (${deviceId ?? null}::text IS NULL OR envelope->'payload'->>'deviceId' = ${deviceId ?? null})
      ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 100
    )
    UPDATE hardware_alert_retirement_outbox o SET lease_token = ${token}, lease_until = now() + interval '5 minutes'
    FROM candidates c WHERE o.id = c.id RETURNING o.id, o.org_id AS "orgId", o.envelope`));
  for (const row of rows) {
    const owned = and(eq(hardwareAlertRetirementOutbox.id, row.id), eq(hardwareAlertRetirementOutbox.leaseToken, token));
    try {
      const p = row.envelope;
      await publishEvent('alert.resolved', row.orgId, p.payload, 'alert-service',
        { eventId: p.eventId, siteId: p.siteId });
      const { ruleId, deviceId: retiredDeviceId, subjectKey } = p.payload;
      if (typeof ruleId === 'string' && typeof retiredDeviceId === 'string' && typeof subjectKey === 'string') {
        await recordStateTransition(ruleId, retiredDeviceId, 'resolved', subjectKey);
        await setCooldown(ruleId, retiredDeviceId, p.cooldownMinutes, subjectKey);
      }
      await withSystemDbAccessContext(() => db.delete(hardwareAlertRetirementOutbox).where(owned));
    } catch (error) {
      captureException(error, undefined, { errorId: 'hardware-retirement-outbox-dispatch-failed', outboxId: row.id });
      console.error('[RetirementOutbox] Committed recovery will retry', row.id, error);
      await withSystemDbAccessContext(() => db.update(hardwareAlertRetirementOutbox)
        .set({ leaseToken: null, leaseUntil: null }).where(owned));
    }
  }
}
