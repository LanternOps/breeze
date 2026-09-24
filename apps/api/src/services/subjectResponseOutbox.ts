/**
 * W03 Task 10 — durable response admission for hardware-subject episodes.
 *
 * `admitSubjectResponse` is the single-response-owner CAS: it can only ever
 * set `monitor_episodes.responses_admitted_at` ONCE per episode (the WHERE
 * clause requires it to still be NULL), atomically with creating the
 * automation run record and staging its dispatch envelope in the SAME
 * savepoint/outer commit. A loser of the CAS creates no run and queues
 * nothing. Stable event IDs and BullMQ's 200-job retention do not deduplicate
 * local redelivery on their own — the database admission marker is what
 * actually prevents a second response run for the episode, including under
 * replay after acknowledgement failure or queue eviction.
 *
 * `drainSubjectResponseOutbox` may only run with no ambient DB access
 * context, mirroring `subjectAlertOutbox`'s commit-then-dispatch contract:
 * `automation.started` publishes, then the caller's `enqueue` callback runs,
 * and only a successful enqueue clears the envelope — never the admission
 * marker itself, so a failed enqueue retries against the SAME run.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, hasDbAccessContext, withDbTransaction, withSystemDbAccessContext } from '../db';
import { automations, monitorEpisodes } from '../db/schema';
import { createAutomationRunRecord, type AutomationTriggerContext } from './automationRuntime';
import { publishEvent } from './eventBus';

type Dispatch = {
  runId: string;
  automationId: string;
  deviceId: string;
  triggeredBy: string;
  triggerContext: AutomationTriggerContext;
  leaseToken?: string;
  leaseUntil?: string;
};

export async function admitSubjectResponse(input: {
  automation: typeof automations.$inferSelect;
  episodeId: string;
  alertId: string;
  deviceId: string;
  eventType: string;
  eventId?: string;
  eventTimestamp: string;
  triggerContext: AutomationTriggerContext;
}): Promise<{ runId?: string; skipped?: string }> {
  return withDbTransaction(async () => {
    const [episode] = await db.update(monitorEpisodes).set({
      responsesAdmittedAt: new Date(), updatedAt: new Date(),
    }).where(and(
      eq(monitorEpisodes.id, input.episodeId),
      eq(monitorEpisodes.monitorId, input.automation.managedByMonitorId!),
      eq(monitorEpisodes.deviceId, input.deviceId),
      eq(monitorEpisodes.alertId, input.alertId),
      isNull(monitorEpisodes.endedAt),
      isNull(monitorEpisodes.responsesAdmittedAt),
    )).returning({ id: monitorEpisodes.id });
    if (!episode) return { skipped: 'subject_episode_response_already_admitted_or_ineligible' };

    const triggeredBy = `event:${input.eventType}`;
    const { run } = await createAutomationRunRecord({
      automation: input.automation,
      triggeredBy,
      boundDeviceIds: [input.deviceId],
      deferStartedEvent: true,
      details: { eventId: input.eventId, eventType: input.eventType, eventTimestamp: input.eventTimestamp },
    });

    const pending: Dispatch = {
      runId: run.id, automationId: input.automation.id, deviceId: input.deviceId,
      triggeredBy, triggerContext: input.triggerContext,
    };
    const actions = Array.isArray(input.automation.actions) ? input.automation.actions : [];
    await db.update(monitorEpisodes).set({
      responseRunId: run.id,
      responseOutcome: actions.length === 0 ? 'skipped_no_response' : 'queued',
      responseDispatch: pending,
      updatedAt: new Date(),
    }).where(eq(monitorEpisodes.id, episode.id));

    return { runId: run.id };
  });
}

export async function drainSubjectResponseOutbox(
  enqueue: (pending: Dispatch) => Promise<unknown>,
): Promise<void> {
  if (hasDbAccessContext()) {
    throw new Error('Subject response outbox must run after commit — call it with no ambient DB access context');
  }
  const token = randomUUID();
  const rows = await withSystemDbAccessContext(() => db.execute<{
    id: string; orgId: string; pending: Dispatch;
  }>(sql`
    WITH candidates AS (
      SELECT id FROM monitor_episodes WHERE response_dispatch IS NOT NULL
        AND COALESCE((response_dispatch->>'leaseUntil')::timestamptz, '-infinity') < now()
      ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 100
    )
    UPDATE monitor_episodes e SET response_dispatch = e.response_dispatch || jsonb_build_object(
      'leaseToken', ${token}::text, 'leaseUntil', now() + interval '5 minutes')
    FROM candidates c WHERE e.id = c.id
    RETURNING e.id, e.org_id AS "orgId", e.response_dispatch AS pending`));

  for (const row of rows) {
    const ownsLease = and(
      eq(monitorEpisodes.id, row.id),
      sql`${monitorEpisodes.responseDispatch}->>'leaseToken' = ${token}`,
    );
    try {
      const p = row.pending;
      await publishEvent('automation.started', row.orgId, {
        automationId: p.automationId, runId: p.runId, triggeredBy: p.triggeredBy, devicesTargeted: 1,
      }, 'automation-runtime', { eventId: p.runId });
      await enqueue(p);
      await withSystemDbAccessContext(() =>
        db.update(monitorEpisodes).set({ responseDispatch: null, updatedAt: new Date() }).where(ownsLease));
    } catch (error) {
      console.error('[SubjectResponseOutbox] Dispatch failed; admission remains committed', row.id, error);
      await withSystemDbAccessContext(() =>
        db.update(monitorEpisodes).set({
          responseDispatch: sql`${monitorEpisodes.responseDispatch} - 'leaseToken' - 'leaseUntil'`,
        }).where(ownsLease));
    }
  }
}
