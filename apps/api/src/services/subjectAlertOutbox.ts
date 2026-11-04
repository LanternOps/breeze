/**
 * The transactional outbox dispatcher for `alert.triggered` (and subject
 * `alert.resolved`).
 *
 * Alert creators stage a `SubjectAlertDispatch` envelope on the alert row
 * itself (`alerts.context._subjectDispatch`, or `_subjectResolutionDispatch`
 * for a subject recovery) inside the SAME transaction that writes the alert:
 * the subject path of `createAlert` (W03 Task 10), and since #10926 the legacy
 * `createAlert` path and `createSourcedAlert` too. The key keeps its W03 name;
 * it is the alert dispatch outbox for all of them. This module reads the
 * envelope back only AFTER the writing transaction has committed, so the
 * `process-alert` worker, PSA admission and webhook enrichment always find
 * the row they are told about. `withDbTransaction` alone is a savepoint, not a
 * commit, so nothing here may run under an ambient DB access context.
 *
 * Three drains share one claim (`FOR UPDATE SKIP LOCKED` plus a 5-minute
 * lease, so they never double-claim): the after-commit dispatch that
 * `scheduleStagedAlertDispatch` registers (low latency), the per-device drain
 * at the end of `evaluate-device`, and the fleet-wide drain on the minute tick
 * (crash recovery). Event IDs (and, for #10926 envelopes, `occurredAt`) are
 * fixed at staging, so publication is at-least-once across a crash between
 * publish and acknowledgement. "Published" means the event bus accepted the
 * event; a local subscriber's own failure is swallowed by the bus, as before.
 *
 * Publish failure: a legacy or sourced envelope (`retryOnPublishFailure`)
 * keeps its row and backs off for a minute before a drain retries it.
 * Deleting it would strand references its creator already wrote (episode
 * links, `monitor_device_state.escalation_alert_id`, EDR `notified_severity`,
 * network-baseline change events) and lose one-shot alerts. A durable,
 * retried envelope is not the "active but never announced" row that #5241
 * deleted to avoid. A subject envelope keeps its W03 compensation: delete the
 * row, unlink its episode and escalation pointer, and let the next sweep raise
 * it again.
 *
 * Lifecycle order: a trigger is never published for an alert that is already
 * closed when a drain claims or renews it, so a trigger staged for an alert
 * resolved before dispatch is never announced. A resolve that lands while a
 * claimed trigger is in flight can still publish `alert.resolved` first; the
 * dispatcher's status guard (#4123) already makes that `process-alert` a
 * no-op.
 *
 * Cooldown, flap state and correlation run only after a successful publish
 * AND acknowledgement, so a replay never records them twice (a doubled
 * transition can fake flapping; a doubled cooldown grows the adaptive
 * multiplier). A crash between the two loses them once, which is benign.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import { db, hasDbAccessContext, runAfterDbContextCommit, withSystemDbAccessContext } from '../db';
import { alerts, monitorEpisodes, monitorDeviceState, monitorDefinitions, devices } from '../db/schema';
import { publishEvent } from './eventBus';
import { recordStateTransition, setCooldown } from './alertCooldown';
import { enqueueAlertCorrelation } from '../jobs/alertCorrelation';
import { captureException } from './sentry';
import type { SubjectAlertDispatch } from './alertService';
import { escalationSeverityFor } from './monitors/escalationLatch';
import { drainRetirementOutbox } from './hardwareHealth/retirementOutbox';
import { notParkedDeviceCondition } from './unassignedPool/selectorPredicate';
import { SUBJECT_MONITOR_KINDS } from './monitors/subjectMonitorKinds';

type Claimed = {
  id: string;
  orgId: string;
  /** Null for an org-level owner (a backup workload): no device effects. */
  deviceId: string | null;
  ruleId: string | null;
  episodeId: string | null;
  subjectKey: string | null;
  pending: SubjectAlertDispatch;
};

/**
 * Drain every committed-but-undelivered alert envelope (subject, legacy and
 * sourced alike), after the subject retirement outbox and subject escalation
 * staging. Optionally scoped to one device (the per-device worker drain); with
 * no `deviceId`, drains fleet-wide (the minute tick: crash recovery for an
 * after-commit dispatch that never ran, and the retry for a failed publish).
 */
export async function drainSubjectAlertOutbox(deviceId?: string): Promise<void> {
  if (hasDbAccessContext()) {
    throw new Error('Subject outbox must run after commit — call it with no ambient DB access context');
  }
  // Every alert's crash recovery and publish retry runs in the dispatch below,
  // so neither subject-only step may stop it. A failed step is still rethrown
  // afterwards, so the tick logs it and an evaluate-device job still fails.
  const failures: unknown[] = [];
  for (const step of [() => drainRetirementOutbox(deviceId), () => stagePendingSubjectEscalations(deviceId)]) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  await dispatchStagedAlerts({ deviceId });
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Subject outbox drain steps failed');
}

/** How long a `retryOnPublishFailure` envelope waits after a failed publish. */
const PUBLISH_RETRY_BACKOFF = sql`interval '1 minute'`;

/**
 * Publish every committed, unacknowledged envelope in scope: one device, a set
 * of alert ids (the after-commit dispatch), or, with neither, fleet-wide. At
 * most 100 rows per slot per call; the next drain takes the rest.
 */
export async function dispatchStagedAlerts(
  scope: { deviceId?: string; alertIds?: readonly string[] } = {},
): Promise<void> {
  if (hasDbAccessContext()) {
    throw new Error('Alert outbox must run after commit — call it with no ambient DB access context');
  }
  const { deviceId, alertIds } = scope;
  if (alertIds && alertIds.length === 0) return;

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
            AND ${alertIds ? sql`id = ANY(${sql.param([...alertIds])}::uuid[])` : sql`TRUE`}
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
          {
            siteId: row.pending.siteId, eventId: row.pending.eventId,
            ...(row.pending.occurredAt ? { occurredAt: row.pending.occurredAt } : {}),
          },
        );
      } catch (error) {
        captureException(error, undefined, { errorId: 'subject-alert-publish-failed', alertId: row.id });
        console.error('[SubjectAlertOutbox] Publication failed', row.id, error);
        try {
          await withSystemDbAccessContext(async () => {
            if (triggering && row.pending.retryOnPublishFailure) {
              // #10926: keep the row. Push the lease out instead of releasing
              // it, so failing rows step aside and the oldest failures cannot
              // monopolise every drain's batch of 100.
              await db.update(alerts).set({
                context: sql`jsonb_set(${alerts.context}, ARRAY[${slot}::text],
                  (${alerts.context}->${slot}) || jsonb_build_object(
                    'leaseUntil', now() + ${PUBLISH_RETRY_BACKOFF},
                    'failedAttempts', COALESCE((${alerts.context}->${slot}->>'failedAttempts')::int, 0) + 1))`,
              }).where(ownsLease);
              return;
            }
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
        captureException(error, undefined, { errorId: 'subject-alert-ack-failed', alertId: row.id });
        console.error('[SubjectAlertOutbox] Acknowledgement failed; stable event ID will retry', row.id, error);
        // The envelope stays, so a later drain republishes it and runs the
        // effects then. Running them here as well would record them twice.
        continue;
      }

      const effects: Array<() => Promise<unknown>> = [];
      const { ruleId, subjectKey, deviceId: ownerDeviceId } = row;
      if (ruleId && ownerDeviceId && subjectKey) {
        effects.push(
          () => recordStateTransition(ruleId, ownerDeviceId, triggering ? 'triggered' : 'resolved', subjectKey),
          () => setCooldown(ruleId, ownerDeviceId, row.pending.cooldownMinutes, subjectKey),
        );
      } else if (ruleId && ownerDeviceId && triggering) {
        // A legacy (NULL-subject) rule alert from `createAlert`: the flap
        // transition and cooldown it used to write right after its inline
        // publish.
        effects.push(
          () => recordStateTransition(ruleId, ownerDeviceId, 'triggered'),
          () => setCooldown(ruleId, ownerDeviceId, row.pending.cooldownMinutes),
        );
      }
      // A workload owner has no device to correlate.
      if (triggering && ownerDeviceId) {
        effects.push(() => enqueueAlertCorrelation({ orgId: row.orgId, deviceId: ownerDeviceId }));
      }
      for (const effect of effects) {
        try {
          await effect();
        } catch (error) {
          captureException(error, undefined, { errorId: 'subject-alert-post-publish-effect-failed', alertId: row.id });
          console.error('[SubjectAlertOutbox] Post-publication effect failed', row.id, error);
        }
      }
    }
  }
}

/**
 * #10926: announce a staged alert as soon as the transaction that wrote it
 * commits. Call it right after staging the envelope, inside that transaction.
 *
 * Registers commit-only deferred work on the OUTERMOST context: a rollback
 * drops it (and the row with it), and with no context held it starts at once.
 * The work joins a per-process queue drained by one loop, so a transaction
 * that staged hundreds of alerts (a backup pass, an org-wide network-check
 * sweep) dispatches them in batches instead of opening hundreds of short
 * system transactions at once. Anything this process never gets to (it died,
 * or the dispatch failed) stays durable on the row for the per-device and
 * minute-tick drains.
 */
export function scheduleStagedAlertDispatch(alertId: string): void {
  runAfterDbContextCommit('alert-outbox.dispatch', () => {
    pendingDispatchIds.add(alertId);
    return runPendingDispatches();
  });
}

const pendingDispatchIds = new Set<string>();
let dispatchLoop: Promise<void> | null = null;

// The `finally` that clears `dispatchLoop` must stay INSIDE the async body: it
// then runs in the same turn as the `while` check that found the queue empty,
// so no id can be added after that check and before the loop is cleared. A
// `.finally()` chained outside would leave a microtask gap where a new id
// joins a loop that has already stopped.
function runPendingDispatches(): Promise<void> {
  dispatchLoop ??= (async () => {
    try {
      while (pendingDispatchIds.size > 0) {
        const batch = [...pendingDispatchIds].slice(0, 100);
        for (const id of batch) pendingDispatchIds.delete(id);
        try {
          await dispatchStagedAlerts({ alertIds: batch });
        } catch (error) {
          // The envelopes are still on their rows; the next drain retries them.
          captureException(error, undefined, { errorId: 'alert-outbox-dispatch-failed' });
          console.error('[AlertOutbox] After-commit dispatch failed; the next drain will retry', batch, error);
        }
      }
    } finally {
      dispatchLoop = null;
    }
  })();
  return dispatchLoop;
}

/**
 * Stage a pending `alert.triggered` envelope for every subject-monitor
 * (`SUBJECT_MONITOR_KINDS`: hardware_health, time_sync, container_image_currency) (monitor, device)
 * pair that has latched recurrence escalation but has not yet had its
 * escalation alert raised. Legacy (non-subject) recurrence escalation still
 * runs synchronously through `fireEscalationLatch` — the subject path never
 * calls it, because its whole sweep runs inside `withDbTransaction`'s
 * savepoint, where a direct publish would violate the "nothing publishes
 * before commit" contract. A subject kind missing from the list would latch
 * (`escalatedAt` set, responses paused) with no alert ever telling a human.
 */
async function stagePendingSubjectEscalations(deviceId?: string): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const candidates = await db.select({ state: monitorDeviceState, monitor: monitorDefinitions, device: devices })
      .from(monitorDeviceState)
      .innerJoin(monitorDefinitions, eq(monitorDefinitions.id, monitorDeviceState.monitorId))
      .innerJoin(devices, eq(devices.id, monitorDeviceState.deviceId))
      .where(and(
        inArray(monitorDefinitions.kind, [...SUBJECT_MONITOR_KINDS]),
        isNotNull(monitorDeviceState.escalatedAt),
        isNull(monitorDeviceState.escalationAlertId),
        isNotNull(monitorDeviceState.currentEpisodeId),
        eq(monitorDeviceState.lastState, 'breach'),
        // No escalation alert for a device parked in its partner's holding org.
        notParkedDeviceCondition(),
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
          monitorId: monitor.id, kind: monitor.kind, episodeId, requiresHuman: true,
          subjectKey: null, responsesOwner: true, source: 'monitor_recurrence',
        },
      };
      await db.insert(alerts).values({
        ownerKind: 'device',
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
