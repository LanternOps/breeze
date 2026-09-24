/**
 * W03 Task 10 — the transactional outbox dispatcher for hardware-subject
 * alerts.
 *
 * `createAlert`'s subject path and `resolveAlert(..., deferSubjectEffects)`
 * stage a `SubjectAlertDispatch` envelope on the alert row itself
 * (`alerts.context._subjectDispatch` / `_subjectResolutionDispatch`) inside
 * the SAME transaction that writes the alert/episode/ownership state. This
 * module reads that envelope back only AFTER the writing transaction has
 * committed — `withDbTransaction` alone is a savepoint, not a commit, so
 * nothing here may run under an ambient DB access context.
 *
 * Mirrors `publishAlertTriggeredOrRollback`'s ordering for the legacy path:
 * commit first, publish second, compensate a failed publish in a NEW
 * transaction, then run cooldown/correlation only after a successful
 * publish. The outbox lease (`leaseToken`/`leaseUntil`) prevents two workers
 * from claiming one pending envelope; a process death leaves a durable row
 * eligible again after five minutes. Event IDs are stable across retries, so
 * delivery is at-least-once across a crash between publish and
 * acknowledgement.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import { db, hasDbAccessContext, withSystemDbAccessContext } from '../db';
import { alerts, monitorEpisodes, monitorDeviceState, monitorDefinitions, devices } from '../db/schema';
import { publishEvent } from './eventBus';
import { recordStateTransition, setCooldown } from './alertCooldown';
import { enqueueAlertCorrelation } from '../jobs/alertCorrelation';
import { captureException } from './sentry';
import type { SubjectAlertDispatch } from './alertService';
import { escalationSeverityFor } from './monitors/escalationLatch';

type Claimed = {
  id: string;
  orgId: string;
  deviceId: string;
  ruleId: string | null;
  episodeId: string | null;
  subjectKey: string | null;
  pending: SubjectAlertDispatch;
};

/**
 * Drain every committed-but-undelivered subject alert envelope. Optionally
 * scoped to one device (the per-device worker drain); with no `deviceId`,
 * drains fleet-wide (the minute tick, and this function's own staging of
 * pending hardware recurrence escalations).
 */
export async function drainSubjectAlertOutbox(deviceId?: string): Promise<void> {
  if (hasDbAccessContext()) {
    throw new Error('Subject outbox must run after commit — call it with no ambient DB access context');
  }
  await stagePendingHardwareEscalations(deviceId);

  // System scope belongs only to this background cross-tenant dispatcher.
  for (const slot of ['_subjectDispatch', '_subjectResolutionDispatch'] as const) {
    const triggering = slot === '_subjectDispatch';
    const statuses = triggering ? (['active', 'acknowledged', 'suppressed'] as const) : (['resolved'] as const);

    const claimed = await withSystemDbAccessContext(async () => {
      const token = randomUUID();
      return db.execute<Claimed>(sql`
        WITH candidates AS (
          SELECT id FROM alerts
          WHERE context ? ${slot}
            AND status IN (${sql.join(statuses.map(status => sql`${status}`), sql`, `)})
            AND (${deviceId ?? null}::uuid IS NULL OR device_id = ${deviceId ?? null}::uuid)
            AND COALESCE((context->${slot}->>'leaseUntil')::timestamptz, '-infinity') < now()
          ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 100
        )
        UPDATE alerts a SET context = jsonb_set(a.context, ARRAY[${slot}::text],
          (a.context->${slot}) || jsonb_build_object(
            'leaseToken', ${token}::text, 'leaseUntil', now() + interval '5 minutes'))
        FROM candidates c WHERE a.id = c.id
        RETURNING a.id, a.org_id AS "orgId", a.device_id AS "deviceId", a.rule_id AS "ruleId",
          a.episode_id AS "episodeId", a.subject_key AS "subjectKey", a.context->${slot} AS pending`);
    });

    for (const row of claimed) {
      const ownsLease = and(
        eq(alerts.id, row.id),
        sql`${alerts.context}->${slot}->>'leaseToken' = ${row.pending.leaseToken}`,
      );
      // Renew just before each send; skip a trigger canceled by recovery
      // while this batch was waiting. A send racing a later recovery is
      // at-least-once.
      const live = await withSystemDbAccessContext(() =>
        db.update(alerts).set({
          context: sql`jsonb_set(${alerts.context}, ARRAY[${slot}::text, 'leaseUntil'], to_jsonb(now() + interval '5 minutes'))`,
        }).where(and(ownsLease, inArray(alerts.status, [...statuses]))).returning({ id: alerts.id }),
      );
      if (live.length === 0) continue;

      try {
        await publishEvent(
          row.pending.eventType, row.orgId, row.pending.payload,
          row.pending.publisher ?? 'alert-service',
          { siteId: row.pending.siteId, eventId: row.pending.eventId },
        );
      } catch (error) {
        captureException(error, undefined, { errorId: 'subject-alert-publish-failed', alertId: row.id });
        console.error('[SubjectAlertOutbox] Publication failed', row.id, error);
        try {
          await withSystemDbAccessContext(async () => {
            if (!triggering) {
              // A resolved alert survives transport failure and retries on
              // the next tick.
              await db.update(alerts).set({
                context: sql`jsonb_set(${alerts.context}, ARRAY[${slot}::text],
                  (${alerts.context}->${slot}) - 'leaseToken' - 'leaseUntil')`,
              }).where(ownsLease);
              return;
            }
            const [locked] = await db.select({ id: alerts.id }).from(alerts).where(ownsLease).for('update');
            if (!locked) return;
            if (row.episodeId) {
              await db.update(monitorEpisodes).set({ alertId: null, updatedAt: new Date() })
                .where(and(eq(monitorEpisodes.id, row.episodeId), eq(monitorEpisodes.alertId, row.id)));
            }
            await db.update(monitorDeviceState).set({ escalationAlertId: null, updatedAt: new Date() })
              .where(eq(monitorDeviceState.escalationAlertId, row.id));
            await db.delete(alerts).where(ownsLease);
          });
        } catch (cleanupError) {
          captureException(cleanupError, undefined, { errorId: 'subject-alert-compensation-failed', alertId: row.id });
          console.error('[SubjectAlertOutbox] Compensation failed; durable envelope will retry', row.id, cleanupError);
        }
        continue;
      }

      // No failure after a successful publish may delete an alert or its
      // owner.
      try {
        await withSystemDbAccessContext(
          () => db.update(alerts).set({ context: sql`${alerts.context} - ${slot}` }).where(ownsLease),
          'subject-alert-outbox.ack',
        );
      } catch (error) {
        console.error('[SubjectAlertOutbox] Acknowledgement failed; stable event ID will retry', row.id, error);
      }

      const effects: Array<() => Promise<unknown>> = [];
      const { ruleId, subjectKey } = row;
      if (ruleId && subjectKey) {
        effects.push(
          () => recordStateTransition(ruleId, row.deviceId, triggering ? 'triggered' : 'resolved', subjectKey),
          () => setCooldown(ruleId, row.deviceId, row.pending.cooldownMinutes, subjectKey),
        );
      }
      if (triggering) effects.push(() => enqueueAlertCorrelation({ orgId: row.orgId, deviceId: row.deviceId }));
      for (const effect of effects) {
        try {
          await effect();
        } catch (error) {
          console.error('[SubjectAlertOutbox] Post-publication effect failed', row.id, error);
        }
      }
    }
  }
}

/**
 * Stage a pending `alert.triggered` envelope for every hardware-health
 * (monitor, device) pair that has latched recurrence escalation but has not
 * yet had its escalation alert raised. Legacy (non-hardware) recurrence
 * escalation still runs synchronously through `fireEscalationLatch` —
 * only the hardware subject path defers this because its whole sweep
 * runs inside `withDbTransaction`'s savepoint, where a direct publish would
 * violate the "nothing publishes before commit" contract.
 */
async function stagePendingHardwareEscalations(deviceId?: string): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const candidates = await db.select({ state: monitorDeviceState, monitor: monitorDefinitions, device: devices })
      .from(monitorDeviceState)
      .innerJoin(monitorDefinitions, eq(monitorDefinitions.id, monitorDeviceState.monitorId))
      .innerJoin(devices, eq(devices.id, monitorDeviceState.deviceId))
      .where(and(
        eq(monitorDefinitions.kind, 'hardware_health'),
        isNotNull(monitorDeviceState.escalatedAt),
        isNull(monitorDeviceState.escalationAlertId),
        isNotNull(monitorDeviceState.currentEpisodeId),
        eq(monitorDeviceState.lastState, 'breach'),
        deviceId ? eq(monitorDeviceState.deviceId, deviceId) : undefined,
      ))
      .orderBy(monitorDeviceState.updatedAt).limit(100)
      .for('update', { of: monitorDeviceState, skipLocked: true });

    for (const { state, monitor, device } of candidates) {
      const id = randomUUID();
      const episodeId = state.currentEpisodeId!;
      const n = state.episodesInWindow;
      const occurrences = `${n} ${n === 1 ? 'time' : 'times'}`;
      const hours = monitor.recurrenceWindowHours;
      const days = hours ? Math.round(hours / 24) : 0;
      const window = !hours
        ? 'the recurrence window'
        : hours < 24
          ? `${hours} ${hours === 1 ? 'hour' : 'hours'}`
          : `${days} ${days === 1 ? 'day' : 'days'}`;
      const name = device.displayName || device.hostname || device.id;
      const severity = escalationSeverityFor(monitor.severity as Parameters<typeof escalationSeverityFor>[0]);
      const title = `${monitor.name} recurred ${occurrences} in ${window} on ${name}`;
      const message = `${monitor.name} has opened ${occurrences} on ${name} within ${window}. Automatic responses for this device are held until a human resets the escalation.`;
      const recurrenceActions = Array.isArray(monitor.recurrenceActions) ? monitor.recurrenceActions : [];
      const pending: SubjectAlertDispatch = {
        eventId: id,
        eventType: 'alert.triggered',
        siteId: device.siteId,
        cooldownMinutes: 0,
        publisher: 'monitor-escalation',
        payload: {
          alertId: id, ruleId: null, deviceId: device.id, severity, title, message,
          monitorId: monitor.id, kind: 'hardware_health', episodeId, requiresHuman: true,
          subjectKey: null, responsesOwner: true, source: 'monitor_recurrence',
        },
      };
      await db.insert(alerts).values({
        id, ruleId: null, deviceId: device.id, orgId: device.orgId,
        severity, title, message, monitorId: monitor.id, episodeId, requiresHuman: true,
        status: 'active', context: {
          source: 'monitor_recurrence', monitorId: monitor.id, episodeId,
          episodesInWindow: n, recurrenceThreshold: monitor.recurrenceThreshold,
          recurrenceWindowHours: hours, recurrenceActionsPending: recurrenceActions.length,
          _subjectDispatch: pending,
        },
      });
      await db.update(monitorDeviceState).set({ escalationAlertId: id, updatedAt: new Date() })
        .where(and(eq(monitorDeviceState.monitorId, monitor.id), eq(monitorDeviceState.deviceId, device.id)));
    }
  });
}
