import { Job, Queue, Worker } from 'bullmq';
import { eq, inArray, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { db } from '../db';
import { tickets } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import {
  computeSlaDeadlines,
  isResolutionFrozen,
  isResponseFrozen,
  loadTicketCalendars,
  slaClockRowOf,
  type SlaDeadlinePatch,
  type TicketCalendar,
} from '../services/ticketSlaDeadlines';
import { attachWorkerObservability } from './workerObservability';

/**
 * Business-calendar holiday recompute (#8973 W4, spec §4.5).
 *
 * A holiday added or removed with a date strictly after today (in the
 * calendar's time zone) changes only time strictly after now, so the
 * unfrozen deadlines of open tickets on ANY revision of that calendar are
 * recomputed. A partner-wide calendar's tickets span every org under the
 * partner, so tickets are found by `sla_calendar_revision_id IN (revisions of
 * the calendar)` — never by the calendar's org (tenancy-rls.md step 5).
 *
 * One-shot jobs, queued after commit by services/businessCalendars/service.ts.
 * Each chunk of RECOMPUTE_CHUNK tickets is one short system transaction that
 * locks its rows FOR UPDATE SKIP LOCKED; a row a concurrent writer holds is
 * retried in the next chunk (that writer recomputes on the fresh holidays it
 * reads under the same row lock anyway). A row still locked after
 * MAX_LOCK_ROUNDS fails the job, and BullMQ retries it.
 *
 * Why this cannot race the breach sweep into stamping an obsolete deadline
 * (quorum C4): the edit only moves time after now, so every deadline it can
 * change is still in the future; the sweep stamps only `now() >= due`.
 *
 * Merged tombstones (#8972) are never recomputed: ELIGIBLE excludes
 * `merged_into_ticket_id IS NOT NULL` (cross-wave rebase rule) on top of the
 * open-status filter a tombstone (always closed) already fails.
 */
export const BUSINESS_CALENDAR_RECOMPUTE_QUEUE = 'business-calendar-recompute';
export const RECOMPUTE_CHUNK = 500;
const MAX_LOCK_ROUNDS = 5;

export type BusinessCalendarRecomputeJobData = {
  calendarId: string;
  reason: 'holiday_added' | 'holiday_removed';
};

let queue: Queue<BusinessCalendarRecomputeJobData> | null = null;
let worker: Worker<BusinessCalendarRecomputeJobData> | null = null;

function getQueue(): Queue<BusinessCalendarRecomputeJobData> {
  if (!queue) queue = new Queue<BusinessCalendarRecomputeJobData>(BUSINESS_CALENDAR_RECOMPUTE_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

export async function enqueueBusinessCalendarRecompute(data: BusinessCalendarRecomputeJobData): Promise<void> {
  await getQueue().add('recompute', data, {
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 200 },
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
  });
}

const OPEN_STATUSES = new Set(['new', 'open', 'pending', 'on_hold']);

/** Open, live, with at least one target whose arm is not frozen. */
const ELIGIBLE = sql`
  t.status IN ('new', 'open', 'pending', 'on_hold')
  AND t.deleted_at IS NULL
  AND t.merged_into_ticket_id IS NULL
  AND (
    (t.response_sla_minutes IS NOT NULL AND t.first_response_at IS NULL
      AND NOT ('response' = ANY(string_to_array(COALESCE(t.sla_breach_reason, ''), ','))))
    OR (t.resolution_sla_minutes IS NOT NULL AND t.resolved_at IS NULL
      AND NOT ('resolution' = ANY(string_to_array(COALESCE(t.sla_breach_reason, ''), ','))))
  )`;

const ON_CALENDAR = (calendarId: string) =>
  sql`t.sla_calendar_revision_id IN (SELECT r.id FROM business_calendar_revisions r WHERE r.calendar_id = ${calendarId})`;


type PatchSource = Parameters<typeof slaClockRowOf>[0] & {
  responseDueAt: Date | null;
  responseWarnAt: Date | null;
  resolutionDueAt: Date | null;
  resolutionWarnAt: Date | null;
};

const sameInstant = (a: Date | null | undefined, b: Date | null | undefined) =>
  (a == null && b == null) || (a != null && b != null && new Date(a).getTime() === new Date(b).getTime());

/** The unfrozen deadlines that CHANGE on the calendar's current holidays, or null. */
export function recomputePatch(row: PatchSource, calendar: TicketCalendar): SlaDeadlinePatch | null {
  const next = computeSlaDeadlines(slaClockRowOf(row), calendar);
  const patch: SlaDeadlinePatch = {};
  for (const key of ['responseDueAt', 'responseWarnAt', 'resolutionDueAt', 'resolutionWarnAt'] as const) {
    if (key in next && !sameInstant(next[key], row[key])) patch[key] = next[key] ?? null;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows?: T[] }).rows ?? (result as T[]);
}

export type RecomputeDeps = {
  listCandidates(calendarId: string, afterId: string | null, limit: number): Promise<string[]>;
  recomputeLocked(calendarId: string, ids: string[]): Promise<{ locked: string[]; updated: number }>;
  sleep?(ms: number): Promise<void>;
};

const withSystem = <T>(fn: () => Promise<T>): Promise<T> => dbModule.withSystemDbAccessContext(fn);

export const defaultRecomputeDeps: RecomputeDeps = {
  async listCandidates(calendarId, afterId, limit) {
    return withSystem(async () => {
      const result = await db.execute<{ id: string }>(sql`
        SELECT t.id FROM tickets t
         WHERE ${ON_CALENDAR(calendarId)}
           AND ${ELIGIBLE}
           ${afterId ? sql`AND t.id > ${afterId}::uuid` : sql``}
         ORDER BY t.id
         LIMIT ${limit}`);
      return rowsOf<{ id: string }>(result).map((r) => r.id);
    });
  },

  async recomputeLocked(calendarId, ids) {
    return withSystem(async () => {
      // Typed query builder, not raw SQL: postgres-js parses a raw
      // `timestamp without time zone` as HOST-LOCAL time, which would skew
      // every recomputed deadline by the server's UTC offset.
      const lockedRows = await db
        .select({
          id: tickets.id,
          status: tickets.status,
          deletedAt: tickets.deletedAt,
          slaCalendarRevisionId: tickets.slaCalendarRevisionId,
          calendarId: sql<string | null>`(SELECT r.calendar_id FROM business_calendar_revisions r WHERE r.id = ${tickets.slaCalendarRevisionId})`,
          createdAt: tickets.createdAt,
          responseSlaMinutes: tickets.responseSlaMinutes,
          resolutionSlaMinutes: tickets.resolutionSlaMinutes,
          slaPausedAt: tickets.slaPausedAt,
          slaPausedBusinessMinutes: tickets.slaPausedBusinessMinutes,
          firstResponseAt: tickets.firstResponseAt,
          resolvedAt: tickets.resolvedAt,
          slaBreachReason: tickets.slaBreachReason,
          responseDueAt: tickets.responseDueAt,
          responseWarnAt: tickets.responseWarnAt,
          resolutionDueAt: tickets.resolutionDueAt,
          resolutionWarnAt: tickets.resolutionWarnAt,
        })
        .from(tickets)
        .where(inArray(tickets.id, ids))
        .for('update', { skipLocked: true });
      const lockedIds = new Set(lockedRows.map((r) => r.id));
      // A missing id is either held by a concurrent writer (retry it) or gone.
      const missing = ids.filter((id) => !lockedIds.has(id));
      const stillThere = missing.length === 0
        ? new Set<string>()
        : new Set((await db.select({ id: tickets.id }).from(tickets).where(inArray(tickets.id, missing))).map((r) => r.id));
      const done = ids.filter((id) => lockedIds.has(id) || !stillThere.has(id));

      const eligible = lockedRows.filter((r) => {
        if (r.calendarId !== calendarId || r.deletedAt) return false;
        if (!OPEN_STATUSES.has(r.status)) return false;
        return (r.responseSlaMinutes != null && !isResponseFrozen(r))
          || (r.resolutionSlaMinutes != null && !isResolutionFrozen(r));
      });
      const calendars = await loadTicketCalendars(db, eligible.map((r) => r.slaCalendarRevisionId));
      let updated = 0;
      for (const r of eligible) {
        const calendar = calendars.get(r.slaCalendarRevisionId!) ?? null;
        if (!calendar) {
          // Under system scope every revision is readable, so this only
          // happens if the revision was deleted mid-chunk (tenant erasure).
          console.warn(`[BusinessCalendarRecompute] revision ${r.slaCalendarRevisionId} of ticket ${r.id} is gone; skipped`);
          continue;
        }
        const patch = recomputePatch(r, calendar);
        if (!patch) continue;
        await db.update(tickets).set(patch).where(eq(tickets.id, r.id));
        updated++;
      }
      return { locked: done, updated };
    });
  },
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Walks every eligible ticket of the calendar in id order, RECOMPUTE_CHUNK at
 * a time; rows skipped under SKIP LOCKED ride along with the next chunk.
 */
export async function runBusinessCalendarRecompute(
  calendarId: string,
  deps: RecomputeDeps = defaultRecomputeDeps,
): Promise<{ processed: number; updated: number }> {
  const sleep = deps.sleep ?? defaultSleep;
  let after: string | null = null;
  let exhausted = false;
  let carry: string[] = [];
  const rounds = new Map<string, number>();
  let processed = 0;
  let updated = 0;
  for (;;) {
    let fresh: string[] = [];
    const room = RECOMPUTE_CHUNK - carry.length;
    if (!exhausted && room > 0) {
      fresh = await deps.listCandidates(calendarId, after, room);
      if (fresh.length < room) exhausted = true;
      if (fresh.length > 0) after = fresh[fresh.length - 1]!;
    }
    const batch = [...carry, ...fresh];
    if (batch.length === 0) break;
    const result = await deps.recomputeLocked(calendarId, batch);
    const locked = new Set(result.locked);
    processed += locked.size;
    updated += result.updated;
    carry = batch.filter((id) => !locked.has(id));
    for (const id of carry) {
      const n = (rounds.get(id) ?? 0) + 1;
      rounds.set(id, n);
      if (n >= MAX_LOCK_ROUNDS) {
        throw new Error(`[BusinessCalendarRecompute] ${carry.length} ticket(s) still locked after ${MAX_LOCK_ROUNDS} rounds (calendar ${calendarId})`);
      }
    }
    if (carry.length > 0 && fresh.length === 0) await sleep(50 * Math.max(...carry.map((id) => rounds.get(id) ?? 1)));
  }
  return { processed, updated };
}

function createWorker(): Worker<BusinessCalendarRecomputeJobData> {
  return new Worker<BusinessCalendarRecomputeJobData>(
    BUSINESS_CALENDAR_RECOMPUTE_QUEUE,
    async (job: Job<BusinessCalendarRecomputeJobData>) => {
      const { calendarId, reason } = job.data;
      const result = await runBusinessCalendarRecompute(calendarId);
      if (result.updated > 0) {
        console.log(`[BusinessCalendarRecompute] ${reason}: recomputed ${result.updated} of ${result.processed} ticket(s) on calendar ${calendarId}`);
      }
      return result;
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeBusinessCalendarRecomputeWorker(): Promise<void> {
  if (worker) return;
  worker = createWorker();
  attachWorkerObservability(worker, 'businessCalendarRecomputeWorker');
  worker.on('error', (error) => {
    console.error('[BusinessCalendarRecompute] Worker error:', error);
    captureException(error);
  });
  worker.on('failed', (job, error) => {
    const exhausted = job ? job.attemptsMade >= (job.opts.attempts ?? 1) : false;
    console.error(
      `[BusinessCalendarRecompute] Job ${job?.id} failed${exhausted ? ' — retries exhausted, open tickets on this calendar keep stale deadlines' : ''}:`,
      { calendarId: job?.data?.calendarId, reason: job?.data?.reason, attemptsMade: job?.attemptsMade },
      error,
    );
    captureException(error, undefined, { worker: 'businessCalendarRecomputeWorker', calendarId: job?.data?.calendarId ?? 'unknown', exhausted: String(exhausted) });
  });
}

export async function shutdownBusinessCalendarRecomputeWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
