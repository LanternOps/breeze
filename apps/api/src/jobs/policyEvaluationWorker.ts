/**
 * Policy Evaluation Worker
 *
 * Schedules and runs policy evaluations based on checkIntervalMinutes.
 */

import { Job, Queue, Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import * as dbModule from '../db';
import { automationPolicies } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';
import { evaluatePolicy, scanAndEvaluateConfigPolicyCompliance } from '../services/policyEvaluationService';
import type { ComplianceAlertReconcileResult } from '../services/complianceAlertReconcile';
import type { ComplianceAlertReconcileScope } from '../services/complianceAlertReconcileTrigger';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

/** Check if a Drizzle/Postgres error is "relation does not exist" (42P01). */
function isRelationNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const cause = (error as { cause?: { code?: string } }).cause;
  // eslint-disable-next-line breeze/no-direct-sqlstate -- Existing guard explicitly reads the Drizzle driver cause.
  return cause?.code === '42P01';
}

let _configPolicyTableWarningLogged = false;

const POLICY_EVALUATION_QUEUE = 'policy-evaluation';
const SCAN_INTERVAL_MS = 60 * 1000;
/** The periodic compliance-alert reconcile: the safety net behind the config-write hooks. */
const RECONCILE_INTERVAL_MS = 15 * 60 * 1000;

type ScanDuePoliciesJob = {
  type: 'scan-due-policies';
};

type EvaluatePolicyJob = {
  type: 'evaluate-policy';
  policyId: string;
};

type ScanConfigPolicyComplianceJob = {
  type: 'scan-config-policy-compliance';
};

/**
 * Closes compliance alerts whose rule no longer applies. With a scope it is the
 * follow-up of a config write (complianceAlertReconcileTrigger.ts); without one
 * it is the periodic sweep over every open compliance alert.
 */
type ReconcileComplianceAlertsJob = {
  type: 'reconcile-compliance-alerts';
  configPolicyId?: string;
  orgId?: string;
  partnerId?: string;
};

type PolicyEvaluationJobData =
  | ScanDuePoliciesJob
  | EvaluatePolicyJob
  | ScanConfigPolicyComplianceJob
  | ReconcileComplianceAlertsJob;

let policyEvaluationQueue: Queue<PolicyEvaluationJobData> | null = null;
let policyEvaluationWorker: Worker<PolicyEvaluationJobData> | null = null;

function isPolicyDue(policy: typeof automationPolicies.$inferSelect, nowMs: number): boolean {
  if (!policy.enabled) {
    return false;
  }

  if (!policy.lastEvaluatedAt) {
    return true;
  }

  const intervalMs = Math.max(1, policy.checkIntervalMinutes) * 60 * 1000;
  return nowMs - policy.lastEvaluatedAt.getTime() >= intervalMs;
}

export function getPolicyEvaluationQueue(): Queue<PolicyEvaluationJobData> {
  if (!policyEvaluationQueue) {
    policyEvaluationQueue = new Queue<PolicyEvaluationJobData>(POLICY_EVALUATION_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return policyEvaluationQueue;
}

async function processScanDuePolicies(): Promise<{ queued: number }> {
  const nowMs = Date.now();
  const policies = await db
    .select()
    .from(automationPolicies)
    .where(eq(automationPolicies.enabled, true));

  const duePolicies = policies.filter((policy) => isPolicyDue(policy, nowMs));

  if (duePolicies.length === 0) {
    return { queued: 0 };
  }

  const queue = getPolicyEvaluationQueue();

  await queue.addBulk(
    duePolicies.map((policy) => ({
      name: 'evaluate-policy',
      data: {
        type: 'evaluate-policy',
        policyId: policy.id,
      },
      opts: {
        jobId: `policy-evaluate-${policy.id}`,
        removeOnComplete: true,
        removeOnFail: { count: 100 },
      },
    }))
  );

  return { queued: duePolicies.length };
}

/**
 * #7347 — runs an evaluation in its own system transaction, then — only once
 * that transaction has committed — enqueues the remediation runs it created
 * (`afterCommit`, which never rejects). Each run row is INSERTed in the
 * transaction and the execute-run worker reads it on its own connection:
 * enqueued inside, a fast worker finds no run and throws `Automation run not
 * found`, and a rollback leaves a job for a run that never existed. A
 * transaction that throws — including a failed commit — propagates before
 * anything is enqueued. The worker calls these with no ambient context, so
 * this transaction is the outermost one and really commits when it returns.
 *
 * The config-compliance scan also publishes its policy.* events from
 * `afterCommit`. The policy-alert-bridge reads the committed compliance row on
 * its own connection, so an event published inside the transaction made the
 * first failing check raise nothing.
 */
async function commitThenEnqueue<R extends object>(
  evaluate: () => Promise<R & { afterCommit?: () => Promise<void> }>,
): Promise<R> {
  const { afterCommit, ...result } = await runWithSystemDbAccess(evaluate);
  if (afterCommit) await afterCommit();
  return result as unknown as R;
}

function processEvaluatePolicy(policyId: string): Promise<{
  policyId: string;
  devicesEvaluated: number;
  compliant: number;
  nonCompliant: number;
}> {
  return commitThenEnqueue(() => admitEvaluatePolicy(policyId));
}

async function admitEvaluatePolicy(policyId: string): Promise<{
  policyId: string;
  devicesEvaluated: number;
  compliant: number;
  nonCompliant: number;
  afterCommit?: () => Promise<void>;
}> {
  const [policy] = await db
    .select()
    .from(automationPolicies)
    .where(
      and(
        eq(automationPolicies.id, policyId),
        eq(automationPolicies.enabled, true)
      )
    )
    .limit(1);

  if (!policy) {
    return {
      policyId,
      devicesEvaluated: 0,
      compliant: 0,
      nonCompliant: 0,
    };
  }

  const result = await evaluatePolicy(policy, {
    source: 'policy-evaluation-worker',
    requestRemediation: true,
    deferEnqueue: true,
  });

  return {
    policyId,
    devicesEvaluated: result.devicesEvaluated,
    compliant: result.summary.compliant,
    nonCompliant: result.summary.non_compliant,
    ...(result.afterCommit ? { afterCommit: result.afterCommit } : {}),
  };
}

async function processConfigPolicyComplianceScan(): Promise<{
  rulesScanned: number;
  devicesEvaluated: number;
}> {
  try {
    return await commitThenEnqueue(async () => {
      const result = await scanAndEvaluateConfigPolicyCompliance({ deferEnqueue: true });
      return {
        rulesScanned: result.rulesScanned,
        devicesEvaluated: result.devicesEvaluated,
        ...(result.afterCommit ? { afterCommit: result.afterCommit } : {}),
      };
    });
  } catch (error: unknown) {
    if (isRelationNotFoundError(error)) {
      if (!_configPolicyTableWarningLogged) {
        _configPolicyTableWarningLogged = true;
        console.warn('[PolicyEvaluationWorker] Config policy tables not found — run "pnpm db:migrate" to create them. Skipping compliance scan.');
      }
      return { rulesScanned: 0, devicesEvaluated: 0 };
    }
    throw error;
  }
}

function reconcileScopeOf(data: ReconcileComplianceAlertsJob): ComplianceAlertReconcileScope | undefined {
  if (data.configPolicyId) return { configPolicyId: data.configPolicyId };
  if (data.orgId) return { orgId: data.orgId };
  if (data.partnerId) return { partnerId: data.partnerId };
  return undefined;
}

/**
 * Where the periodic sweep resumes. It checks at most a bounded number of
 * devices per run and carries on from here on the next one; a scoped run
 * always starts from the beginning of its scope.
 */
let sweepCursor: string | null = null;

/**
 * The reconcile opens its own system transaction per batch, so it runs with no
 * ambient context (see the #7347 note in the processor below).
 */
async function processReconcileComplianceAlerts(data: ReconcileComplianceAlertsJob): Promise<ComplianceAlertReconcileResult> {
  // Loaded on first use, like the automation worker below: it pulls in the
  // alert service and both alert bridges, which the evaluation jobs never need.
  const { reconcileComplianceAlerts } = await import('../services/complianceAlertReconcile');
  const scope = reconcileScopeOf(data);
  if (scope) return reconcileComplianceAlerts(scope);
  const result = await reconcileComplianceAlerts(undefined, { afterDeviceId: sweepCursor });
  sweepCursor = result.nextDeviceCursor;
  return result;
}

/**
 * Queues a scoped reconcile. Requests for one scope coalesce while one is
 * waiting; one that arrives while it runs is kept and runs after it, so a
 * change committed mid-run is never missed (`keepLastIfActive`).
 */
export async function enqueueComplianceAlertReconcile(scope: ComplianceAlertReconcileScope): Promise<void> {
  const key = 'configPolicyId' in scope
    ? `policy-${scope.configPolicyId}`
    : 'orgId' in scope ? `org-${scope.orgId}` : `partner-${scope.partnerId}`;
  await getPolicyEvaluationQueue().add(
    'reconcile-compliance-alerts',
    { type: 'reconcile-compliance-alerts', ...scope },
    {
      deduplication: { id: `compliance-alert-reconcile-${key}`, keepLastIfActive: true },
      removeOnComplete: true,
      removeOnFail: { count: 50 },
    },
  );
}

/** Test-only: the `reconcile-compliance-alerts` job body, driven against real Postgres. */
export const __processReconcileComplianceAlerts = processReconcileComplianceAlerts;

/** Test-only: the `scan-config-policy-compliance` job body, driven against real Postgres. */
export const __processConfigPolicyComplianceScan = processConfigPolicyComplianceScan;
/** Test-only: the `evaluate-policy` job body, driven against real Postgres. */
export const __processEvaluatePolicy = processEvaluatePolicy;

export function createPolicyEvaluationWorker(): Worker<PolicyEvaluationJobData> {
  return new Worker<PolicyEvaluationJobData>(
    POLICY_EVALUATION_QUEUE,
    async (job: Job<PolicyEvaluationJobData>) => {
      const { data } = job;
      if (data.type === 'scan-due-policies') {
        return runWithSystemDbAccess(() => processScanDuePolicies());
      }

      // #7347 — both evaluations own their transaction (commitThenEnqueue) and
      // enqueue remediation runs only after it commits, so they run with NO
      // ambient context here: wrapped in a worker transaction, theirs would
      // join it and the enqueue would again precede the commit.
      if (data.type === 'scan-config-policy-compliance') {
        return processConfigPolicyComplianceScan();
      }

      if (data.type === 'reconcile-compliance-alerts') {
        return processReconcileComplianceAlerts(data);
      }

      return processEvaluatePolicy(data.policyId);
    },
    {
      connection: getBullMQConnection(),
      concurrency: 3,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    }
  );
}

export async function initializePolicyEvaluationWorker(): Promise<void> {
  policyEvaluationWorker = createPolicyEvaluationWorker();
  attachWorkerObservability(policyEvaluationWorker, 'policyEvaluationWorker');

  policyEvaluationWorker.on('error', (error) => {
    console.error('[PolicyEvaluationWorker] Worker error:', error);
  });

  policyEvaluationWorker.on('failed', (job, error) => {
    console.error(`[PolicyEvaluationWorker] Job ${job?.id} failed:`, error);
  });

  const queue = getPolicyEvaluationQueue();

  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    await queue.removeRepeatableByKey(job.key);
  }

  await queue.add(
    'scan-due-policies',
    { type: 'scan-due-policies' },
    {
      repeat: { every: SCAN_INTERVAL_MS },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    }
  );

  // Schedule config policy compliance scans (runs alongside standalone policy scans)
  await queue.add(
    'scan-config-policy-compliance',
    { type: 'scan-config-policy-compliance' },
    {
      repeat: { every: SCAN_INTERVAL_MS },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    }
  );

  // Safety net for compliance alerts whose rule stopped applying through a path
  // with no hook (a device moved, a group deleted, a policy retired, a hook's
  // enqueue lost): the config-write hooks only cover the common paths.
  await queue.add(
    'reconcile-compliance-alerts',
    { type: 'reconcile-compliance-alerts' },
    {
      repeat: { every: RECONCILE_INTERVAL_MS },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    }
  );

  console.log('[PolicyEvaluationWorker] Scheduled policy evaluation scan jobs (standalone + config policy) and the compliance-alert reconcile');
}

export async function shutdownPolicyEvaluationWorker(): Promise<void> {
  if (policyEvaluationWorker) {
    await policyEvaluationWorker.close();
    policyEvaluationWorker = null;
  }

  if (policyEvaluationQueue) {
    await policyEvaluationQueue.close();
    policyEvaluationQueue = null;
  }
}
