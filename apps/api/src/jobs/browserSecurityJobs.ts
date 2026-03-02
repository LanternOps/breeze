import { Job, Queue, Worker } from 'bullmq';
import { and, eq, isNull, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { browserExtensions, browserPolicies, browserPolicyViolations, devices } from '../db/schema';
import { getRedisConnection } from '../services/redis';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const BROWSER_POLICY_EVAL_QUEUE = 'browser-policy-evaluation';
const EVAL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

interface PolicyEvalJobData {
  type: 'evaluate';
  orgId?: string;
  policyId?: string;
  queuedAt: string;
}

let evalQueue: Queue<PolicyEvalJobData> | null = null;
let evalWorker: Worker<PolicyEvalJobData> | null = null;

function getEvalQueue(): Queue<PolicyEvalJobData> {
  if (!evalQueue) {
    evalQueue = new Queue<PolicyEvalJobData>(BROWSER_POLICY_EVAL_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return evalQueue;
}

async function processEvaluation(data: PolicyEvalJobData): Promise<{ checked: number; violations: number }> {
  const conditions = [eq(browserPolicies.isActive, true)];
  if (data.orgId) conditions.push(eq(browserPolicies.orgId, data.orgId));
  if (data.policyId) conditions.push(eq(browserPolicies.id, data.policyId));

  const policies = await db
    .select()
    .from(browserPolicies)
    .where(and(...conditions));

  let checked = 0;
  let violations = 0;

  for (const policy of policies) {
    const extensions = await db
      .select()
      .from(browserExtensions)
      .where(eq(browserExtensions.orgId, policy.orgId));

    const blocked = policy.blockedExtensions as string[] | null;
    if (blocked && blocked.length > 0) {
      for (const ext of extensions) {
        if (blocked.includes(ext.extensionId)) {
          const existing = await db
            .select({ id: browserPolicyViolations.id })
            .from(browserPolicyViolations)
            .where(and(
              eq(browserPolicyViolations.orgId, policy.orgId),
              eq(browserPolicyViolations.deviceId, ext.deviceId),
              eq(browserPolicyViolations.policyId, policy.id),
              eq(browserPolicyViolations.violationType, 'blocked_extension'),
              isNull(browserPolicyViolations.resolvedAt)
            ))
            .limit(1);

          if (existing.length === 0) {
            await db.insert(browserPolicyViolations).values({
              orgId: policy.orgId,
              deviceId: ext.deviceId,
              policyId: policy.id,
              violationType: 'blocked_extension',
              details: { extensionId: ext.extensionId, name: ext.name, browser: ext.browser },
              detectedAt: new Date(),
            });
            violations++;
          }
        }
      }
    }
    checked++;
  }

  return { checked, violations };
}

export async function triggerBrowserPolicyEvaluation(
  orgId: string,
  policyId?: string
): Promise<string> {
  const queue = getEvalQueue();
  const job = await queue.add(
    'evaluate',
    {
      type: 'evaluate',
      orgId,
      policyId,
      queuedAt: new Date().toISOString(),
    },
    {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    }
  );
  return String(job.id);
}

export async function initializeBrowserSecurityJobs(): Promise<void> {
  evalWorker = new Worker<PolicyEvalJobData>(
    BROWSER_POLICY_EVAL_QUEUE,
    async (job: Job<PolicyEvalJobData>) => {
      return runWithSystemDbAccess(async () => {
        return processEvaluation(job.data);
      });
    },
    {
      connection: getRedisConnection(),
      concurrency: 1,
    }
  );

  evalWorker.on('error', (error) => {
    console.error('[BrowserSecurityJobs] Worker error:', error);
  });
  evalWorker.on('failed', (job, error) => {
    console.error(`[BrowserSecurityJobs] Job ${job?.id} failed:`, error);
  });

  const queue = getEvalQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === 'evaluate') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'evaluate',
    {
      type: 'evaluate',
      queuedAt: new Date().toISOString(),
    },
    {
      repeat: { every: EVAL_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 50 },
    }
  );

  console.log('[BrowserSecurityJobs] Browser policy evaluation worker initialized');
}

export async function shutdownBrowserSecurityJobs(): Promise<void> {
  if (evalWorker) {
    await evalWorker.close();
    evalWorker = null;
  }
  if (evalQueue) {
    await evalQueue.close();
    evalQueue = null;
  }
}
