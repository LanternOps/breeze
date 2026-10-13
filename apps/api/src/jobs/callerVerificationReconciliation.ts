/**
 * Caller verification workstation reconciliation (#6354 W02).
 *
 * Repairs decisions the transports could not finish, by replaying them
 * through the SAME leaf handler both transports use (no second decision
 * implementation):
 *
 *  - a still-`pending` workstation verification whose `caller_verify`
 *    command is already terminal (a handler failure parked the row, an
 *    eligibility check cancelled it, the reaper failed it) → replay the
 *    stored result; anything unreadable becomes `undeliverable`, never an
 *    approval;
 *  - a durable late-rejection receipt on the command row while the
 *    verification is not yet `rejected_by_user` → re-apply "not me". There
 *    is no time limit on an agent-delivered rejection (the 24 h window is
 *    the public link tier's).
 *
 * Expiry of pending rows stays with the publisher. Every row runs in its own
 * short system context; the scan holds no transaction across the fleet. It
 * keeps running while the feature flag is off so results already issued are
 * still applied.
 */
import { Queue, Worker } from 'bullmq';
import { and, eq, gt, ne, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deviceCommands } from '../db/schema';
import { callerVerifications as v } from '../db/schema/callerVerification';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { handleCallerVerifyResult, NOT_ME_RECEIPT_KEY } from '../services/callerVerification/workstationResult';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'caller-verification-reconciliation';
const JOB_NAME = 'reconcile';
const JOB_ID = 'caller-verification-reconcile';
const INTERVAL_MS = 30_000;
const PAGE = 100;

type CommandRow = typeof deviceCommands.$inferSelect;
type StoredResult = { status?: string; stdout?: string; error?: string; [NOT_ME_RECEIPT_KEY]?: boolean } | null;
type ReplayInput = {
  result: { status: 'completed' | 'failed'; result?: unknown; error?: string };
  stdout: string | undefined;
};

const IN_FLIGHT = new Set(['pending', 'sent']);

/** What to replay for one candidate, or null when nothing is owed. */
export function reconciliationInput(status: string, command: CommandRow): ReplayInput | null {
  if (status === 'rejected_by_user') return null;
  const stored = (command.result ?? null) as StoredResult;
  if (stored?.[NOT_ME_RECEIPT_KEY] === true) {
    return { result: { status: 'completed', result: { delivered: true, choice: 'not_me' } }, stdout: undefined };
  }
  if (status !== 'pending' || IN_FLIGHT.has(command.status)) return null;
  // The server timed the command out (wait deadline / stale reaper): that is
  // the challenge expiring, not an undeliverable device.
  if (stored?.status === 'timeout') {
    return { result: { status: 'completed', result: { delivered: true, choice: 'timeout' } }, stdout: undefined };
  }
  return {
    result: {
      status: command.status === 'completed' && stored?.status === 'completed' ? 'completed' : 'failed',
      result: undefined,
      error: stored?.error,
    },
    stdout: typeof stored?.stdout === 'string' ? stored.stdout : undefined,
  };
}

const system = <T>(fn: () => Promise<T>, label: string) =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

export async function reconcileCallerVerifications(): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await system(() => db.select({ id: v.id, status: v.status, command: deviceCommands }).from(v)
      .innerJoin(deviceCommands, eq(deviceCommands.id, v.agentCommandId))
      .where(and(
        eq(v.method, 'workstation'),
        ne(v.status, 'rejected_by_user'),
        // Bounded: a receipt that can never apply (its device left the org)
        // must not be rescanned forever.
        sql`${v.createdAt} > now() - interval '30 days'`,
        or(
          and(eq(v.status, 'pending'), sql`${deviceCommands.status} NOT IN ('pending','sent')`),
          sql`${deviceCommands.result}->>${NOT_ME_RECEIPT_KEY} = 'true'`,
        ),
        cursor ? gt(v.id, cursor) : undefined,
      ))
      .orderBy(v.id)
      .limit(PAGE), 'callerVerification.reconcile.scan');
    if (!rows.length) return;
    for (const row of rows) {
      const input = reconciliationInput(row.status, row.command);
      if (!input) continue;
      try {
        await system(() => handleCallerVerifyResult({
          agentId: 'reconciler',
          command: row.command,
          commandId: row.command.id,
          resolvedDeviceId: row.command.deviceId,
          result: input.result as never,
          stdout: input.stdout,
        }), 'callerVerification.reconcile.row');
      } catch (err) {
        captureException(err instanceof Error ? err : new Error(String(err)), undefined, { verificationId: row.id });
      }
    }
    cursor = rows[rows.length - 1]!.id;
    if (rows.length < PAGE) return;
  }
}

let queue: Queue | null = null;
let worker: Worker | null = null;

export async function initializeCallerVerificationReconciliation(): Promise<void> {
  if (worker) return;
  queue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  worker = new Worker(QUEUE_NAME, async () => {
    try {
      await reconcileCallerVerifications();
    } catch (err) {
      console.error('[CallerVerificationReconciliation] Run failed:', err);
      captureException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }, { connection: getBullMQConnection(), concurrency: 1 });
  attachWorkerObservability(worker, 'callerVerificationReconciliation');
  worker.on('error', (error) => {
    console.error('[CallerVerificationReconciliation] Worker error:', error);
    captureException(error);
  });
  try {
    for (const job of await queue.getRepeatableJobs()) {
      if (job.name === JOB_NAME) await queue.removeRepeatableByKey(job.key);
    }
    await queue.add(JOB_NAME, {}, { jobId: JOB_ID, repeat: { every: INTERVAL_MS }, removeOnComplete: { count: 20 }, removeOnFail: { count: 100 } });
  } catch (err) {
    await shutdownCallerVerificationReconciliation();
    throw err;
  }
}

export async function shutdownCallerVerificationReconciliation(): Promise<void> {
  const w = worker;
  const q = queue;
  worker = null;
  queue = null;
  await w?.close();
  await q?.close();
}
