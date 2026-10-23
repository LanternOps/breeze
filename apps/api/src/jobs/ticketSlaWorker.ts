import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { db } from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { emitTicketEvent } from '../services/ticketEvents';
import { expireDueApprovalRequests } from '../services/ticketApproval/decisions';
import { getEventBus } from '../services/eventBus';
import { attachWorkerObservability } from './workerObservability';

/**
 * Ticket SLA monitor (spec §3, Phase 2): every 60s, stamp sla_breached_at /
 * sla_breach_reason on active tickets whose response or resolution deadline
 * has passed, then emit ticket.sla_breached per stamped target.
 *
 * Targets are one-shot (D3): sla_breach_reason is a CSV of breached targets and
 * the sweep's WHERE excludes targets already present. Deadlines are the STORED
 * response_due_at / resolution_due_at (#8973 W3), written by
 * services/ticketSlaDeadlines.ts at every write point; until W4 adds calendars
 * they equal the wall-clock created_at + (target + paused minutes). Paused
 * tickets (sla_paused_at set / status pending|on_hold) are skipped entirely.
 *
 * DB work runs inside withSystemDbAccessContext (one short transaction);
 * event emission happens AFTER the context exits (#1105 pool-poison rule).
 * If the process dies after stamping but before notifyBreaches completes, those breach notifications are lost by design — the one-shot guard prevents re-stamping (duplicate notifications would be worse); sla_breached_at remains queryable for auditing gaps.
 */

const QUEUE_NAME = 'ticket-sla-monitor';
const SWEEP_INTERVAL_MS = 60 * 1000;
const MAX_BREACHES_PER_RUN = 200; // per target per sweep

/**
 * #4617 spec §5.6: customer approval requests past `expires_at` are marked
 * `expired` every 5 minutes on this same queue. Their entries stay held.
 */
const APPROVAL_EXPIRY_INTERVAL_MS = 5 * 60 * 1000;

type SlaSweepJobData =
  | { type: 'sla-sweep'; queuedAt: string }
  | { type: 'approval-expiry'; queuedAt: string };

export type BreachedTicketRow = {
  id: string;
  org_id: string;
  partner_id: string | null;
  internal_number: string | null;
  subject: string;
  assigned_to: string | null;
};

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    throw new Error('[TicketSlaWorker] withSystemDbAccessContext not available');
  }
  return withSystem(fn);
};

let slaQueue: Queue<SlaSweepJobData> | null = null;
let slaWorker: Worker<SlaSweepJobData> | null = null;

function getQueue(): Queue<SlaSweepJobData> {
  if (!slaQueue) {
    slaQueue = new Queue<SlaSweepJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return slaQueue;
}

function extractRows<T>(result: unknown): T[] {
  const maybe = result as { rows?: T[] };
  return maybe.rows ?? (result as T[]);
}

/**
 * #8973 Gate B12 — rolling-deploy heal. A ticket created (or given a target)
 * by a pre-W3 API instance still serving during the deploy has a target but
 * no stored deadline, so the stored-deadline passes below would never breach
 * it. Fill the missing arms with the wall-clock formula the backfill used
 * (2027-01-02-190200), at most HEAL_BATCH rows per tick. The partial index
 * tickets_sla_deadlines_missing_idx (2027-01-02-190300) is empty in steady
 * state, so this costs one empty index probe per tick.
 *
 * W4 adds `sla_calendar_revision_id IS NULL` to the predicate: a ticket on a
 * calendar always has its deadlines written by the calendar-aware writers.
 */
const HEAL_BATCH = 500;

async function healMissingDeadlines(): Promise<number> {
  const paused = sql.raw('GREATEST(t.sla_paused_business_minutes, COALESCE(t.sla_paused_minutes, 0))');
  const result = await db.execute<{ id: string }>(sql`
    WITH missing AS (
      SELECT id
      FROM tickets
      WHERE (response_sla_minutes IS NOT NULL AND response_due_at IS NULL)
         OR (resolution_sla_minutes IS NOT NULL AND resolution_due_at IS NULL)
      ORDER BY created_at ASC
      LIMIT ${sql.raw(String(HEAL_BATCH))}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE tickets t
    SET sla_paused_business_minutes = ${paused},
        response_due_at = CASE WHEN t.response_due_at IS NULL AND t.response_sla_minutes IS NOT NULL
          THEN t.created_at + (t.response_sla_minutes + ${paused}) * interval '1 minute'
          ELSE t.response_due_at END,
        response_warn_at = CASE WHEN t.response_due_at IS NULL AND t.response_sla_minutes IS NOT NULL
          THEN t.created_at + ${paused} * interval '1 minute' + t.response_sla_minutes * interval '1 minute' * 0.8
          ELSE t.response_warn_at END,
        resolution_due_at = CASE WHEN t.resolution_due_at IS NULL AND t.resolution_sla_minutes IS NOT NULL
          THEN t.created_at + (t.resolution_sla_minutes + ${paused}) * interval '1 minute'
          ELSE t.resolution_due_at END,
        resolution_warn_at = CASE WHEN t.resolution_due_at IS NULL AND t.resolution_sla_minutes IS NOT NULL
          THEN t.created_at + ${paused} * interval '1 minute' + t.resolution_sla_minutes * interval '1 minute' * 0.8
          ELSE t.resolution_warn_at END
    FROM missing
    WHERE t.id = missing.id
    RETURNING t.id;
  `);
  const healed = extractRows<{ id: string }>(result).length;
  if (healed > 0) {
    console.warn(`[TicketSlaWorker] Healed stored SLA deadlines on ${healed} ticket(s) written without them`);
  }
  return healed;
}

/**
 * #8973 W3 (spec §4.3 reader 1): compare now() with the STORED deadline. The
 * WHERE matches the partial indexes tickets_sla_response_due_idx /
 * tickets_sla_resolution_due_idx exactly (2027-01-02-190300), so the pass is
 * an index range scan in deadline order.
 */
async function stampBreaches(target: 'response' | 'resolution'): Promise<BreachedTicketRow[]> {
  const dueColumn = target === 'response' ? sql.raw('response_due_at') : sql.raw('resolution_due_at');
  const unmetCondition = target === 'response'
    ? sql.raw('first_response_at IS NULL')
    : sql.raw('resolved_at IS NULL');

  const result = await db.execute<BreachedTicketRow>(sql`
    WITH due AS (
      SELECT id
      FROM tickets
      WHERE status IN ('new', 'open')
        -- #5573 spec §4.8: planned work has a due date, not an SLA. Rows
        -- written before tickets.work_kind shipped default to 'support', so
        -- this narrows nothing that used to be swept.
        AND work_kind = 'support'
        AND sla_paused_at IS NULL
        AND ${unmetCondition}
        AND ${dueColumn} IS NOT NULL
        AND NOT (${target} = ANY(string_to_array(COALESCE(sla_breach_reason, ''), ',')))
        AND now() >= ${dueColumn}
      ORDER BY ${dueColumn} ASC
      LIMIT ${MAX_BREACHES_PER_RUN}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE tickets t
    SET sla_breached_at = COALESCE(t.sla_breached_at, now()),
        sla_breach_reason = CASE
          WHEN COALESCE(t.sla_breach_reason, '') = '' THEN ${target}
          ELSE t.sla_breach_reason || ',' || ${target}
        END,
        updated_at = now()
    FROM due
    WHERE t.id = due.id
    RETURNING t.id, t.org_id, t.partner_id, t.internal_number, t.subject, t.assigned_to;
  `);
  return extractRows<BreachedTicketRow>(result);
}

export async function sweepTicketSlaBreaches(): Promise<Array<BreachedTicketRow & { target: 'response' | 'resolution' }>> {
  await healMissingDeadlines();
  const response = await stampBreaches('response');
  const resolution = await stampBreaches('resolution');
  if (response.length === MAX_BREACHES_PER_RUN || resolution.length === MAX_BREACHES_PER_RUN) {
    console.warn(`[TicketSlaWorker] Hit ${MAX_BREACHES_PER_RUN}-row cap — breach backlog may be growing`);
  }
  return [
    ...response.map((r) => ({ ...r, target: 'response' as const })),
    ...resolution.map((r) => ({ ...r, target: 'resolution' as const }))
  ];
}

async function notifyBreaches(rows: Array<BreachedTicketRow & { target: 'response' | 'resolution' }>): Promise<void> {
  for (const row of rows) {
    await emitTicketEvent({
      type: 'ticket.sla_breached',
      ticketId: row.id,
      orgId: row.org_id,
      partnerId: row.partner_id,
      actorUserId: null,
      payload: { target: row.target, internalNumber: row.internal_number, subject: row.subject, assigneeId: row.assigned_to }
    });
    try {
      // Routing-rule hook, mirroring backupSlaWorker's breach publish.
      // Signature verified against eventBus.ts: publish(type, orgId, payload, source, options?)
      // — matches as written; 'ticket.sla_breached' added to the EventType union.
      await getEventBus().publish('ticket.sla_breached', row.org_id, {
        ticketId: row.id,
        internalNumber: row.internal_number,
        subject: row.subject,
        target: row.target,
        assigneeId: row.assigned_to
      }, 'ticket-sla-monitor');
    } catch (err) {
      console.error('[TicketSlaWorker] eventBus publish failed:', err instanceof Error ? err.message : err);
    }
  }
}

function createWorker(): Worker<SlaSweepJobData> {
  return new Worker<SlaSweepJobData>(
    QUEUE_NAME,
    async (job: Job<SlaSweepJobData>) => {
      if (job.data?.type === 'approval-expiry') return runApprovalExpiry();
      try {
        // DB stamping inside the system context; notifications after it exits.
        const rows = await runWithSystemDbAccess(sweepTicketSlaBreaches);
        if (rows.length > 0) {
          console.log(`[TicketSlaWorker] Stamped ${rows.length} SLA breach(es)`);
          await notifyBreaches(rows);
        }
        return { breached: rows.length };
      } catch (err) {
        console.error('[TicketSlaWorker] Sweep failed:', err);
        captureException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    { connection: getBullMQConnection(), concurrency: 1 }
  );
}

/**
 * expireDueApprovalRequests opens its OWN system transaction per request (each
 * under its ticket lock, SKIP LOCKED) — it is deliberately not wrapped in one
 * worker-level context. Events are emitted after every transaction committed.
 */
async function runApprovalExpiry(): Promise<{ expired: number }> {
  try {
    const { expired, events } = await expireDueApprovalRequests(new Date());
    if (expired > 0) console.log(`[TicketSlaWorker] Expired ${expired} customer approval request(s)`);
    for (const event of events) await emitTicketEvent(event);
    return { expired };
  } catch (err) {
    console.error('[TicketSlaWorker] Approval expiry failed:', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

async function scheduleRepeatableJob(): Promise<void> {
  const queue = getQueue();
  const repeatables = await queue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === 'sla-sweep' || job.name === 'ticket-approval-expiry') {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  await queue.add(
    'ticket-approval-expiry',
    { type: 'approval-expiry', queuedAt: new Date().toISOString() },
    {
      // jobId rule: '-' separators, 0 colons (BullMQ repeat-key parsing, #1118)
      jobId: 'ticket-approval-expiry',
      repeat: { every: APPROVAL_EXPIRY_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 }
    }
  );
  await queue.add(
    'sla-sweep',
    { type: 'sla-sweep', queuedAt: new Date().toISOString() },
    {
      // jobId rule: '-' separators, 0 colons (BullMQ repeat-key parsing, #1118)
      jobId: 'ticket-sla-monitor-sweep',
      repeat: { every: SWEEP_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 }
    }
  );
}

export async function initializeTicketSlaWorker(): Promise<void> {
  if (slaWorker) return;
  slaWorker = createWorker();
  attachWorkerObservability(slaWorker, 'ticketSlaWorker');
  slaWorker.on('error', (error) => {
    console.error('[TicketSlaWorker] Worker error:', error);
    captureException(error);
  });
  slaWorker.on('failed', (job, error) => {
    console.error(`[TicketSlaWorker] Job ${job?.id} failed:`, error);
    captureException(error);
  });
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await slaWorker.close();
    slaWorker = null;
    throw err;
  }
  console.log('[TicketSlaWorker] Initialized');
}

export async function shutdownTicketSlaWorker(): Promise<void> {
  const worker = slaWorker;
  const queue = slaQueue;
  slaWorker = null;
  slaQueue = null;
  if (worker) {
    try { await worker.close(); } catch (err) { console.error('[TicketSlaWorker] Error closing worker:', err); }
  }
  if (queue) {
    try { await queue.close(); } catch (err) { console.error('[TicketSlaWorker] Error closing queue:', err); }
  }
}
