import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { db } from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { emitTicketEvent } from '../services/ticketEvents';
import { getEventBus } from '../services/eventBus';

/**
 * Ticket SLA monitor (spec §3, Phase 2): every 60s, stamp sla_breached_at /
 * sla_breach_reason on active tickets whose response or resolution deadline
 * has passed, then emit ticket.sla_breached per stamped target.
 *
 * Targets are one-shot (D3): sla_breach_reason is a CSV of breached targets and
 * the sweep's WHERE excludes targets already present. Deadlines are wall-clock
 * (D1): created_at + (target_minutes + sla_paused_minutes). Paused tickets
 * (sla_paused_at set / status pending|on_hold) are skipped entirely.
 *
 * DB work runs inside withSystemDbAccessContext (one short transaction);
 * event emission happens AFTER the context exits (#1105 pool-poison rule).
 */

const QUEUE_NAME = 'ticket-sla-monitor';
const SWEEP_INTERVAL_MS = 60 * 1000;
const MAX_BREACHES_PER_RUN = 200; // per target per sweep

type SlaSweepJobData = { type: 'sla-sweep'; queuedAt: string };

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

async function stampBreaches(target: 'response' | 'resolution'): Promise<BreachedTicketRow[]> {
  const targetColumn = target === 'response' ? sql.raw('response_sla_minutes') : sql.raw('resolution_sla_minutes');
  const unmetCondition = target === 'response'
    ? sql.raw('first_response_at IS NULL')
    : sql.raw('resolved_at IS NULL');

  const result = await db.execute<BreachedTicketRow>(sql`
    WITH due AS (
      SELECT id
      FROM tickets
      WHERE status IN ('new', 'open')
        AND sla_paused_at IS NULL
        AND ${unmetCondition}
        AND ${targetColumn} IS NOT NULL
        AND NOT (${sql.raw(`'${target}'`)} = ANY(string_to_array(COALESCE(sla_breach_reason, ''), ',')))
        AND now() >= created_at
          + (${targetColumn} + COALESCE(sla_paused_minutes, 0)) * interval '1 minute'
      ORDER BY created_at ASC
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
    async (_job: Job<SlaSweepJobData>) => {
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

async function scheduleRepeatableJob(): Promise<void> {
  const queue = getQueue();
  const repeatables = await queue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === 'sla-sweep') {
      await queue.removeRepeatableByKey(job.key);
    }
  }
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
