/**
 * Policy Evaluation Worker
 *
 * Schedules and runs policy evaluations based on checkIntervalMinutes.
 */

import { Job, Queue, Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { automationPolicies } from '../db/schema';
import { getRedisConnection } from '../services/redis';
import { evaluatePolicy } from '../services/policyEvaluationService';

const POLICY_EVALUATION_QUEUE = 'policy-evaluation';
const SCAN_INTERVAL_MS = 60 * 1000;

type ScanDuePoliciesJob = {
  type: 'scan-due-policies';
};

type EvaluatePolicyJob = {
  type: 'evaluate-policy';
  policyId: string;
};

type PolicyEvaluationJobData = ScanDuePoliciesJob | EvaluatePolicyJob;

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
      connection: getRedisConnection(),
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
        jobId: `policy-evaluate:${policy.id}`,
        removeOnComplete: true,
        removeOnFail: { count: 100 },
      },
    }))
  );

  return { queued: duePolicies.length };
}

async function processEvaluatePolicy(policyId: string): Promise<{
  policyId: string;
  devicesEvaluated: number;
  compliant: number;
  nonCompliant: number;
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
  });

  return {
    policyId,
    devicesEvaluated: result.devicesEvaluated,
    compliant: result.summary.compliant,
    nonCompliant: result.summary.non_compliant,
  };
}

export function createPolicyEvaluationWorker(): Worker<PolicyEvaluationJobData> {
  return new Worker<PolicyEvaluationJobData>(
    POLICY_EVALUATION_QUEUE,
    async (job: Job<PolicyEvaluationJobData>) => {
      if (job.data.type === 'scan-due-policies') {
        return processScanDuePolicies();
      }

      return processEvaluatePolicy(job.data.policyId);
    },
    {
      connection: getRedisConnection(),
      concurrency: 5,
    }
  );
}

export async function initializePolicyEvaluationWorker(): Promise<void> {
  policyEvaluationWorker = createPolicyEvaluationWorker();

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

  console.log('[PolicyEvaluationWorker] Scheduled policy evaluation scan jobs');
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
