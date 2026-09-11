/**
 * Deliverable Worker
 *
 * Daily sweep (spec #5573 §5): for every active deliverable inside its
 * effective window, materialize missing occurrences, open the due ones as
 * tickets, generate auto-evidence, mark the ones past grace as missed; then key
 * dates for the whole fleet. Same singleton shape as contractWorker.ts.
 *
 * Also owns the FIRST consumer of the `contract-events` queue (spec §5.4).
 *
 * DB context: every step opens its own short system transaction
 * (`runOutsideDbContext(() => withSystemDbAccessContext(fn, label))`), never
 * one around the loop — one transaction per deliverable step, or per
 * occurrence where the step creates a ticket, so a failure rolls back that
 * unit alone and the sweep carries on.
 */
import { Queue, Worker } from 'bullmq';
import { and, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { serviceDeliverables } from '../db/schema/serviceDeliverables';
import { buildAutomationEligibleOrgPredicate } from '../services/tenantStatus';
import {
  materializeOccurrences, openDueOccurrencesForDeliverable,
  markDueOccurrencesMissedForDeliverable, applyContractCancelledToDeliverables,
  type SweepDeliverable,
} from '../services/serviceDeliverableService';
import { generateAutoEvidenceForDeliverable } from '../services/deliverableAutoEvidence';
import { sweepKeyDateReminders } from '../services/orgKeyDateService';
import { CONTRACT_EVENTS_QUEUE, type ContractEvent } from '../services/contractEvents';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

const DELIVERABLE_QUEUE = 'deliverable-jobs';
const DELIVERABLE_SWEEP_CRON = jobSchedule('deliverable-sweep');

let deliverableQueue: Queue | null = null;
let deliverableWorker: Worker | null = null;
let contractEventsWorker: Worker | null = null;

export interface DeliverableSweepResult {
  deliverables: number; materialized: number; opened: number;
  missed: number; autoEvidence: number; keyDateReminders: number; failed: number;
}

export function getDeliverableQueue(): Queue {
  if (!deliverableQueue) deliverableQueue = new Queue(DELIVERABLE_QUEUE, { connection: getBullMQConnection() });
  return deliverableQueue;
}

/** "Today" is UTC, exactly as the billing sweep computes it (contractWorker.ts). */
const utcToday = (asOf: Date) => asOf.toISOString().slice(0, 10);

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Spec §5.2. Contract status is deliberately NOT consulted: generateDueInvoice
 * flips a contract to `expired` the day after its final invoice while service
 * runs on for months. The effective window is the authority.
 */
export async function runDeliverableSweep(asOf: Date = new Date()): Promise<DeliverableSweepResult> {
  const today = utcToday(asOf);

  const due: SweepDeliverable[] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({
        id: serviceDeliverables.id, orgId: serviceDeliverables.orgId, name: serviceDeliverables.name,
        cadence: serviceDeliverables.cadence, anchorDueDate: serviceDeliverables.anchorDueDate,
        effectiveFrom: serviceDeliverables.effectiveFrom, effectiveUntil: serviceDeliverables.effectiveUntil,
        leadDays: serviceDeliverables.leadDays, graceDays: serviceDeliverables.graceDays,
        autoEvidenceReportId: serviceDeliverables.autoEvidenceReportId,
      })
      .from(serviceDeliverables)
      .where(and(
        eq(serviceDeliverables.active, true),
        lte(serviceDeliverables.effectiveFrom, today),
        or(isNull(serviceDeliverables.effectiveUntil), gte(serviceDeliverables.effectiveUntil, today)),
        // An archived tenant inside its purge countdown gets no tickets.
        buildAutomationEligibleOrgPredicate(serviceDeliverables.orgId),
      )), 'deliverableSweep.selectDue'));

  const res: DeliverableSweepResult = {
    deliverables: due.length, materialized: 0, opened: 0, missed: 0,
    autoEvidence: 0, keyDateReminders: 0, failed: 0,
  };
  // Spec §5.3 step 2: one Service-Management-off warning per org per run.
  const serviceOffWarned = new Set<string>();

  for (const d of due) {
    try {
      res.materialized += (await runOutsideDbContext(() => withSystemDbAccessContext(
        () => materializeOccurrences(d.id, today), 'deliverableSweep.materialize'))).length;
      // Self-wrapping: one transaction per occurrence (claim + ticket commit together).
      res.opened += await openDueOccurrencesForDeliverable(d, today, serviceOffWarned);
      // Self-wrapping: one transaction per occurrence.
      if (d.autoEvidenceReportId) res.autoEvidence += await generateAutoEvidenceForDeliverable(d, today);
      res.missed += await runOutsideDbContext(() => withSystemDbAccessContext(
        () => markDueOccurrencesMissedForDeliverable(d, today), 'deliverableSweep.markMissed'));
    } catch (err) {
      res.failed++;
      console.error('[DeliverableWorker] deliverable sweep failed', `deliverableId=${d.id}`, `orgId=${d.orgId}`, errMessage(err));
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // Fleet-wide, not per deliverable: a key date needs no deliverable at all.
  try {
    res.keyDateReminders = await sweepKeyDateReminders(today);
  } catch (err) {
    res.failed++;
    console.error('[DeliverableWorker] key-date sweep failed', errMessage(err));
    captureException(err instanceof Error ? err : new Error(String(err)));
  }

  console.log('[DeliverableWorker] sweep complete', JSON.stringify({ today, ...res }));
  return res;
}

/**
 * Spec §5.4. Acts on `contract.cancelled` only. `contract-events` was a
 * reserved, unconsumed bus until now, so the first deploy drains whatever
 * sits in `wait`; that replay is safe by construction —
 * applyContractCancelledToDeliverables re-reads the contract and applies
 * nothing unless it is STILL cancelled, and only touches deliverables whose
 * effective_until is NULL.
 */
export async function handleContractEvent(event: ContractEvent, asOf: Date = new Date()): Promise<void> {
  if (event?.type !== 'contract.cancelled') return;
  if (typeof event.contractId !== 'string' || event.contractId.length === 0) {
    // A retry cannot fix a malformed payload; drop it loudly.
    console.error('[DeliverableWorker] malformed contract.cancelled event — dropping', JSON.stringify(event));
    return;
  }
  await applyContractCancelledToDeliverables(event.contractId, utcToday(asOf));
}

export function createDeliverableWorker(): Worker {
  return new Worker(DELIVERABLE_QUEUE, async (job) => {
    if (job.name === 'deliverable-sweep') return runDeliverableSweep();
    throw new Error(`Unknown deliverable job: ${job.name}`);
  }, { connection: getBullMQConnection(), concurrency: 1 });
}

export function createContractEventsWorker(): Worker {
  return new Worker(CONTRACT_EVENTS_QUEUE, async (job) => {
    await handleContractEvent(job.data as ContractEvent);
  }, { connection: getBullMQConnection(), concurrency: 1 });
}

export async function scheduleDeliverableJobs(): Promise<void> {
  const queue = getDeliverableQueue();
  for (const job of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(job.key);
  await queue.add('deliverable-sweep', { type: 'deliverable-sweep' },
    { repeat: { pattern: DELIVERABLE_SWEEP_CRON }, removeOnComplete: { count: 10 }, removeOnFail: { count: 50 } });
  console.log('[DeliverableWorker] Scheduled daily deliverable sweep');
}

export async function initializeDeliverableWorkers(): Promise<void> {
  try {
    deliverableWorker = createDeliverableWorker();
    attachWorkerObservability(deliverableWorker, 'deliverableWorker');
    deliverableWorker.on('error', (e) => { console.error('[DeliverableWorker] Worker error:', e); captureException(e); });
    deliverableWorker.on('failed', (job, e) => { console.error(`[DeliverableWorker] Job ${job?.id} failed:`, e); captureException(e); });

    contractEventsWorker = createContractEventsWorker();
    attachWorkerObservability(contractEventsWorker, 'deliverableContractEventsWorker');
    contractEventsWorker.on('error', (e) => { console.error('[DeliverableWorker] contract-events worker error:', e); captureException(e); });
    contractEventsWorker.on('failed', (job, e) => { console.error(`[DeliverableWorker] contract-events job ${job?.id} failed:`, e); captureException(e); });

    await scheduleDeliverableJobs();
    console.log('[DeliverableWorker] Deliverable workers initialized');
  } catch (error) {
    console.error('[DeliverableWorker] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownDeliverableWorkers(): Promise<void> {
  if (deliverableWorker) { await deliverableWorker.close(); deliverableWorker = null; }
  if (contractEventsWorker) { await contractEventsWorker.close(); contractEventsWorker = null; }
  if (deliverableQueue) { await deliverableQueue.close(); deliverableQueue = null; }
  console.log('[DeliverableWorker] Deliverable workers shut down');
}
