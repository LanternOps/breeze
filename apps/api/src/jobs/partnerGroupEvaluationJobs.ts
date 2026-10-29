/** Revisioned partner-group evaluation. The worker owns no ambient transaction:
 * discovery, each org write, and finalization release their connection in turn. */
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db, hasDbAccessContext, runAfterDbContextCommit, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deviceGroups } from '../db/schema';
import { isReusableState } from '../services/bullmqUtils';
import { evaluateGroupMembership } from '../services/groupMembership';
import {
  PARTNER_GROUP_ORG_PAGE_SIZE, evaluatePartnerGroupForOrg, listPartnerGroupEvaluationOrgIds,
  type PartnerGroupOrgResult,
} from '../services/partnerGroupEvaluation';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';

export const PARTNER_GROUP_EVALUATION_QUEUE = 'partner-group-evaluation';
export const PARTNER_GROUP_SWEEP_INTERVAL_MS = 21_600_000;
export const PARTNER_GROUP_SWEEP_JITTER_MS = 900_000;
const SWEEP_QUEUE = 'partner-group-evaluation-sweep';
const HEAD_DELAY_MS = 5000;

export interface PartnerGroupEvaluationJobData {
  type: 'partner-group-evaluation';
  groupId: string;
  revision: number | null;
  afterOrgId: string | null;
  failedOrgs: number;
  evaluatedOrgs: number;
  reason: string;
  queuedAt: string;
}
export interface PartnerGroupEnqueueOptions { jobId?: string; delayMs?: number }
export interface PartnerGroupEvaluationDeps {
  enqueue?: (data: PartnerGroupEvaluationJobData, opts: PartnerGroupEnqueueOptions) => Promise<unknown>;
  pageSize?: number;
  now?: () => Date;
}
export interface PartnerGroupEvaluationResult {
  status: 'continued' | 'finalized' | 'superseded' | 'gone';
  evaluatedOrgs: number;
  failedOrgs: number;
  next?: PartnerGroupEvaluationJobData;
  orgResults: PartnerGroupOrgResult[];
}

let queue: Queue<PartnerGroupEvaluationJobData> | null = null;
let sweepQueue: Queue | null = null;
let worker: Worker<PartnerGroupEvaluationJobData> | null = null;
let sweepWorker: Worker | null = null;

export function getPartnerGroupEvaluationQueue(): Queue<PartnerGroupEvaluationJobData> {
  if (!queue) queue = new Queue<PartnerGroupEvaluationJobData>(PARTNER_GROUP_EVALUATION_QUEUE, { connection: getBullMQConnection() });
  return queue;
}
function getSweepQueue(): Queue {
  if (!sweepQueue) sweepQueue = new Queue(SWEEP_QUEUE, { connection: getBullMQConnection() });
  return sweepQueue;
}
function headData(groupId: string, reason: string, now: () => Date): PartnerGroupEvaluationJobData {
  return { type: 'partner-group-evaluation', groupId, revision: null, afterOrgId: null,
    failedOrgs: 0, evaluatedOrgs: 0, reason, queuedAt: now().toISOString() };
}
function jobOptions(delay = HEAD_DELAY_MS) {
  return { delay, attempts: 5, backoff: { type: 'exponential', delay: 500 },
    removeOnComplete: { count: 100 }, removeOnFail: { count: 200 } };
}

async function enqueueEvaluation(data: PartnerGroupEvaluationJobData, opts: PartnerGroupEnqueueOptions): Promise<string> {
  const target = getPartnerGroupEvaluationQueue();
  let jobId = opts.jobId ?? `partner-group-eval-${data.groupId}`;
  const existing = await target.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      if (state !== 'active') return String(existing.id);
      // Active heads have already read their revision. A distinct head is
      // required or a filter edit during evaluation would be silently lost.
      jobId = `${jobId}-follow-up-${randomUUID()}`;
    } else {
      await existing.remove();
    }
  }
  const added = await target.add('partner-group-evaluation', data, {
    ...jobOptions(opts.delayMs ?? (data.revision === null ? HEAD_DELAY_MS : 0)), jobId,
  });
  return String(added.id);
}

export function schedulePartnerGroupEvaluation(
  groupId: string, reason: string, opts: { delayMs?: number } = {},
): Promise<string> {
  return enqueueEvaluation(headData(groupId, reason, () => new Date()), opts);
}

export function requestPartnerGroupEvaluationAfterCommit(groupId: string, reason: string): void {
  runAfterDbContextCommit(`partnerGroupEvaluation.${reason}`, async () => {
    try {
      await schedulePartnerGroupEvaluation(groupId, reason);
    } catch (error) {
      console.error(`[PartnerGroupEvaluation] Failed to enqueue ${groupId}:`, error);
    }
  });
}

export async function processPartnerGroupEvaluation(
  data: PartnerGroupEvaluationJobData, deps: PartnerGroupEvaluationDeps = {},
): Promise<PartnerGroupEvaluationResult> {
  if (hasDbAccessContext()) throw new Error('partner group evaluation requires no ambient DB context');
  const enqueue = deps.enqueue ?? enqueueEvaluation;
  const now = deps.now ?? (() => new Date());
  const pageSize = deps.pageSize ?? PARTNER_GROUP_ORG_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('pageSize must be a positive integer');
  let evaluatedOrgs = data.evaluatedOrgs;
  let failedOrgs = data.failedOrgs;
  const orgResults: PartnerGroupOrgResult[] = [];
  const outcome = (status: PartnerGroupEvaluationResult['status']): PartnerGroupEvaluationResult => ({ status, evaluatedOrgs, failedOrgs, orgResults });
  const superseded = async () => {
    await enqueue(headData(data.groupId, data.reason, now), { jobId: `partner-group-eval-${data.groupId}` });
    return outcome('superseded');
  };
  const [group] = await withSystemDbAccessContext(() => db.select({
    id: deviceGroups.id, orgId: deviceGroups.orgId, partnerId: deviceGroups.partnerId,
    type: deviceGroups.type, filterRevision: deviceGroups.filterRevision,
  }).from(deviceGroups).where(eq(deviceGroups.id, data.groupId)).limit(1), 'partnerGroupEvaluation.read');
  if (!group || group.orgId !== null || !group.partnerId || group.type !== 'dynamic') return outcome('gone');
  const revision = data.revision ?? group.filterRevision;
  if (data.revision !== null && group.filterRevision > data.revision) return superseded();

  const page = await listPartnerGroupEvaluationOrgIds(group.partnerId, data.afterOrgId, pageSize);
  for (const orgId of page) {
    const result = await evaluatePartnerGroupForOrg(data.groupId, orgId, { expectedRevision: revision });
    orgResults.push(result);
    if (result.status === 'superseded') return superseded();
    if (result.status === 'gone') return outcome('gone');
    evaluatedOrgs += 1;
    if (!result.ok) {
      failedOrgs += 1;
      // The org keeps its previous members; the count lands in evaluation_failed_orgs.
      console.error(`[PartnerGroupEvaluation] group ${data.groupId} org ${orgId} not evaluated: ${result.error ?? 'unknown error'}`);
    }
  }
  const afterOrgId = page.at(-1);
  if (page.length === pageSize && afterOrgId) {
    const next: PartnerGroupEvaluationJobData = { ...data, revision, afterOrgId, evaluatedOrgs, failedOrgs, queuedAt: now().toISOString() };
    await enqueue(next, { jobId: `partner-group-eval-${data.groupId}-r${revision}-after-${afterOrgId}`, delayMs: 0 });
    return { ...outcome('continued'), next };
  }
  const finalized = await withSystemDbAccessContext(() => db.update(deviceGroups).set({
    evaluatedRevision: sql`greatest(${deviceGroups.evaluatedRevision}, ${revision})`,
    evaluatedAt: now(), evaluationFailedOrgs: failedOrgs,
  }).where(and(eq(deviceGroups.id, data.groupId), eq(deviceGroups.filterRevision, revision)))
    .returning({ id: deviceGroups.id }), 'partnerGroupEvaluation.finalize');
  if (finalized.length === 0) return superseded();
  return outcome('finalized');
}

export interface PartnerGroupSweepDeps extends Pick<PartnerGroupEvaluationDeps, 'enqueue' | 'now'> {
  random?: () => number;
}
export async function runPartnerGroupSweep(deps: PartnerGroupSweepDeps = {}): Promise<{ partnerGroups: number; orgGroups: number }> {
  if (hasDbAccessContext()) throw new Error('partner group sweep requires no ambient DB context');
  const enqueue = deps.enqueue ?? enqueueEvaluation;
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  const partnerGroups = await withSystemDbAccessContext(() => db.select({ id: deviceGroups.id }).from(deviceGroups)
    .where(and(isNull(deviceGroups.orgId), isNotNull(deviceGroups.partnerId), eq(deviceGroups.type, 'dynamic'), isNotNull(deviceGroups.filterConditions))),
  'partnerGroupEvaluation.sweep.discovery');
  for (const group of partnerGroups) {
    try {
      await enqueue(headData(group.id, 'periodic_sweep', now), { delayMs: Math.floor(random() * PARTNER_GROUP_SWEEP_JITTER_MS) });
    } catch (error) {
      console.error(`[PartnerGroupEvaluation] Sweep enqueue failed for ${group.id}:`, error);
    }
  }
  const orgGroups = await withSystemDbAccessContext(() => db.select({ id: deviceGroups.id }).from(deviceGroups)
    .where(and(isNotNull(deviceGroups.orgId), eq(deviceGroups.type, 'dynamic'), isNotNull(deviceGroups.filterConditions),
      sql`exists (select 1 from unnest(${deviceGroups.filterFieldsUsed}) f where f like 'software.%')`)),
  'partnerGroupEvaluation.sweep.orgDiscovery');
  for (const group of orgGroups) {
    try {
      await runOutsideDbContext(() => withSystemDbAccessContext(() => evaluateGroupMembership(group.id), 'partnerGroupEvaluation.sweep.org'));
    } catch (error) {
      console.error(`[PartnerGroupEvaluation] Sweep evaluation failed for org group ${group.id}:`, error);
    }
  }
  return { partnerGroups: partnerGroups.length, orgGroups: orgGroups.length };
}

export async function schedulePartnerGroupEvaluationSweep(random: () => number = Math.random): Promise<void> {
  const target = getSweepQueue();
  for (const job of await target.getRepeatableJobs()) {
    if (job.name === 'partner-group-sweep') await target.removeRepeatableByKey(job.key);
  }
  await target.add('partner-group-sweep', { queuedAt: new Date().toISOString() }, {
    jobId: 'partner-group-sweep', repeat: { every: PARTNER_GROUP_SWEEP_INTERVAL_MS },
    delay: Math.floor(random() * PARTNER_GROUP_SWEEP_INTERVAL_MS),
    removeOnComplete: { count: 20 }, removeOnFail: { count: 50 },
  });
}

export async function initializePartnerGroupEvaluationJobs(): Promise<void> {
  worker = new Worker<PartnerGroupEvaluationJobData>(PARTNER_GROUP_EVALUATION_QUEUE,
    (job) => processPartnerGroupEvaluation(job.data), { connection: getBullMQConnection(), concurrency: 1 });
  attachWorkerObservability(worker, 'partnerGroupEvaluationWorker');
  worker.on('error', (error) => console.error('[PartnerGroupEvaluation] worker error:', error));
  worker.on('failed', (job, error) => console.error(`[PartnerGroupEvaluation] job ${job?.id} failed:`, error));
  sweepWorker = new Worker(SWEEP_QUEUE, () => runPartnerGroupSweep(), { connection: getBullMQConnection(), concurrency: 1 });
  attachWorkerObservability(sweepWorker, 'partnerGroupSweepWorker');
  sweepWorker.on('error', (error) => console.error('[PartnerGroupEvaluation] sweep worker error:', error));
  sweepWorker.on('failed', (job, error) => console.error(`[PartnerGroupEvaluation] sweep ${job?.id} failed:`, error));
  await schedulePartnerGroupEvaluationSweep();
}

export async function shutdownPartnerGroupEvaluationJobs(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  if (sweepWorker) { await sweepWorker.close(); sweepWorker = null; }
  if (queue) { await queue.close(); queue = null; }
  if (sweepQueue) { await sweepQueue.close(); sweepQueue = null; }
}
