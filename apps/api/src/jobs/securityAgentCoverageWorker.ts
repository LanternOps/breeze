import { Job, Queue, Worker } from 'bullmq';
import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import {
  listCoverageOrgsForPartner,
  listCoveragePartners,
  reconcileOrgCoverage,
} from '../services/securityAgents/coverageReconcileRun';
import { attachWorkerObservability } from './workerObservability';

/**
 * Security agent coverage reconciliation (#6960 W03, spec 2.7).
 *
 * BullMQ, system context, fan-out partner → org:
 *   scan (repeatable)      → one `reconcile-partner` job per partner with coverage rows
 *   reconcile-partner      → one `reconcile-org` job per org of that partner with rows
 *   reconcile-org          → `reconcileOrgCoverage(orgId)`
 *
 * The scope comes from `security_agent_device_status` rows, which the software
 * compliance worker writes under each DEVICE's org. A partner-wide managed
 * policy (org_id NULL) therefore fans out by its devices' orgs; nothing here
 * filters on a policy's org, and nothing depends on a caller's tenant scope.
 * Holding (unassigned-pool) orgs are skipped.
 */

export const SECURITY_AGENT_COVERAGE_QUEUE = 'security-agent-coverage';
const SCAN_INTERVAL_MS = 15 * 60 * 1000;

export type SecurityAgentCoverageJobData =
  | { type: 'scan' }
  | { type: 'reconcile-partner'; partnerId: string }
  | { type: 'reconcile-org'; partnerId: string; orgId: string };

let coverageQueue: Queue<SecurityAgentCoverageJobData> | null = null;
let coverageWorker: Worker<SecurityAgentCoverageJobData> | null = null;

export function getSecurityAgentCoverageQueue(): Queue<SecurityAgentCoverageJobData> {
  if (!coverageQueue) {
    coverageQueue = new Queue<SecurityAgentCoverageJobData>(SECURITY_AGENT_COVERAGE_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return coverageQueue;
}

const system = <T>(fn: () => Promise<T>, label: string): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

/** One slot per scan interval: a partner or org is reconciled at most once per slot. */
function slot(now = Date.now()): string {
  return Math.floor(now / SCAN_INTERVAL_MS).toString(36);
}

const CHILD_JOB_OPTS = {
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 300 },
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 10_000 },
};

export async function processCoverageScan(): Promise<{ partners: number }> {
  const partners = await system(() => listCoveragePartners(), 'securityAgentCoverage.scan');
  if (partners.length === 0) return { partners: 0 };
  const s = slot();
  await getSecurityAgentCoverageQueue().addBulk(partners.map((partnerId) => ({
    name: 'reconcile-partner',
    data: { type: 'reconcile-partner' as const, partnerId },
    // '-' separators: BullMQ rejects custom ids whose colon-split length !== 3 (#1101).
    opts: { ...CHILD_JOB_OPTS, jobId: `sa-coverage-partner-${partnerId}-${s}` },
  })));
  return { partners: partners.length };
}

export async function processCoveragePartner(partnerId: string): Promise<{ orgs: number }> {
  const orgs = await system(() => listCoverageOrgsForPartner(partnerId), 'securityAgentCoverage.partner');
  if (orgs.length === 0) return { orgs: 0 };
  const s = slot();
  await getSecurityAgentCoverageQueue().addBulk(orgs.map((orgId) => ({
    name: 'reconcile-org',
    data: { type: 'reconcile-org' as const, partnerId, orgId },
    opts: { ...CHILD_JOB_OPTS, jobId: `sa-coverage-org-${orgId}-${s}` },
  })));
  return { orgs: orgs.length };
}

export async function processSecurityAgentCoverageJob(data: SecurityAgentCoverageJobData): Promise<unknown> {
  switch (data.type) {
    case 'scan':
      return processCoverageScan();
    case 'reconcile-partner':
      return processCoveragePartner(data.partnerId);
    case 'reconcile-org':
      // Manages its own system contexts (loads, per-alert, persist).
      return reconcileOrgCoverage(data.orgId);
    default: {
      const unreachable: never = data;
      throw new Error(`Unknown security agent coverage job: ${JSON.stringify(unreachable)}`);
    }
  }
}

export function createSecurityAgentCoverageWorker(): Worker<SecurityAgentCoverageJobData> {
  return new Worker<SecurityAgentCoverageJobData>(
    SECURITY_AGENT_COVERAGE_QUEUE,
    async (job: Job<SecurityAgentCoverageJobData>) => processSecurityAgentCoverageJob(job.data),
    {
      connection: getBullMQConnection(),
      concurrency: 2,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );
}

async function scheduleCoverageScan(): Promise<void> {
  const queue = getSecurityAgentCoverageQueue();
  for (const job of await queue.getRepeatableJobs()) {
    if (job.name === 'scan') await queue.removeRepeatableByKey(job.key);
  }
  await queue.add('scan', { type: 'scan' }, {
    repeat: { every: SCAN_INTERVAL_MS },
    removeOnComplete: { count: 20 },
    removeOnFail: { count: 50 },
  });
}

export async function initializeSecurityAgentCoverageWorker(): Promise<void> {
  coverageWorker = createSecurityAgentCoverageWorker();
  attachWorkerObservability(coverageWorker, 'securityAgentCoverageWorker');

  coverageWorker.on('error', (error) => {
    console.error('[SecurityAgentCoverage] Worker error', { error });
    captureException(error);
  });
  coverageWorker.on('failed', (job, error) => {
    console.error('[SecurityAgentCoverage] Job failed', { jobId: job?.id, jobType: job?.data?.type, error });
    captureException(error);
  });

  try {
    await scheduleCoverageScan();
    console.log('[SecurityAgentCoverage] Initialized');
  } catch (error) {
    console.error('[SecurityAgentCoverage] Failed to schedule the coverage scan — coverage will not reconcile:', error);
    captureException(error);
  }
}

export async function shutdownSecurityAgentCoverageWorker(): Promise<void> {
  if (coverageWorker) {
    await coverageWorker.close();
    coverageWorker = null;
  }
  if (coverageQueue) {
    await coverageQueue.close();
    coverageQueue = null;
  }
}
