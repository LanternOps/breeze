import { and, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { connectionHealthIncidents as chi } from '../../db/schema';
import { publishEvent } from '../eventBus';
import {
  buildHealthEventPayload,
  dueHealthEvent,
  HEALTH_EVENT_TYPE,
  healthEventId,
  type HealthEventPayload,
} from './eventPayload';

// Publisher for integration.health_opened / integration.health_resolved (spec
// 2026-10-15 §2.4, W5 plan D7–D10). `event_state` records what consumers were
// last told; dueHealthEvent() says what they should hear next. Each due row is
// handled in its own system transaction that holds the row lock (FOR UPDATE
// SKIP LOCKED) across publish → mark, so two overlapping runs never publish the
// same row's events out of order and the mark always matches what was
// published. publishEvent opens no transaction of its own (it escapes the DB
// context), so the lock is held for one Redis round trip only.
//
// Delivery to the event bus is at least once: a crash or rollback after the
// publish re-publishes the same deterministic event id next run, and webhook
// delivery dedupes on (webhook_id, event_id). A failed publish leaves the row
// due for the next run.

export type PublishHealthEvent = (
  type: (typeof HEALTH_EVENT_TYPE)[keyof typeof HEALTH_EVENT_TYPE],
  orgId: string,
  payload: HealthEventPayload,
  source: string,
  options: { eventId: string; occurredAt?: string },
) => Promise<unknown>;

export type EventPublishCounts = { published: number; failed: number };

const EVENT_SOURCE = 'connection-health';

/** Same predicate as the migration's connection_health_incidents_event_due_idx. */
export function dueEventsWhere(): SQL {
  return and(
    isNotNull(chi.orgId),
    isNotNull(chi.openedAt),
    or(
      and(isNull(chi.resolvedAt), sql`${chi.eventState} IS DISTINCT FROM 'opened'`),
      and(isNotNull(chi.resolvedAt), eq(chi.eventState, 'opened')),
    ),
  ) as SQL;
}

const sys = <T>(fn: () => Promise<T>, label: string): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

/** Returns true when an event was published and recorded; false when the row was locked or no longer due. */
async function publishOne(id: string, publish: PublishHealthEvent): Promise<boolean> {
  const [row] = await db.select().from(chi).where(eq(chi.id, id)).for('update', { skipLocked: true });
  if (!row) return false; // another run holds it, or retention removed it
  const due = dueHealthEvent(row);
  if (!due || !row.orgId) return false;
  const payload = buildHealthEventPayload(row);
  await publish(HEALTH_EVENT_TYPE[due], row.orgId, payload, EVENT_SOURCE, {
    eventId: healthEventId(row, due),
    // A reopen keeps opened_at (same episode), so its event time is "now".
    occurredAt: due === 'resolved'
      ? payload.resolvedAt ?? undefined
      : row.flapCount === 0 ? payload.openedAt : undefined,
  });
  await db.update(chi).set({ eventState: due }).where(eq(chi.id, row.id));
  return true;
}

/** Drain the event outbox. One failure never blocks the rest. */
export async function publishPendingEvents(
  _now: Date,
  opts: { limit?: number; publish?: PublishHealthEvent } = {},
): Promise<EventPublishCounts> {
  const limit = opts.limit ?? 200;
  const publish = opts.publish ?? (publishEvent as PublishHealthEvent);
  const rows = await sys(
    () => db.select({ id: chi.id }).from(chi).where(dueEventsWhere()).orderBy(chi.id).limit(limit),
    'connectionHealth.dueEvents',
  );
  let published = 0;
  let failed = 0;
  for (const { id } of rows) {
    try {
      if (await sys(() => publishOne(id, publish), 'connectionHealth.publishEvent')) published += 1;
    } catch (err) {
      failed += 1;
      console.error(JSON.stringify({
        event: 'connection_health_event_publish_failed',
        incidentId: id,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }
  return { published, failed };
}
