/**
 * Real-BullMQ proof that a throttled accounting job keeps its attempt budget
 * (jobs/accountingJobDelay.ts, PR #7197 review F8). The unit suite can only
 * show that `moveToDelayed(ts, token)` is called and `DelayedError` thrown;
 * that this consumes NO attempt is BullMQ's behaviour, so only a real queue
 * can prove it. The job runs with `attempts: 1`: had the throttle spent that
 * one attempt, the second run could never happen and the job would fail.
 *
 * A control job with the same `attempts: 1` that throws an ordinary error
 * proves the setup can tell the difference: it fails on its first run.
 *
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/accountingJobDelay.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Queue, Worker, type Job } from 'bullmq';
import Redis from 'ioredis';
import { delayJobForRateLimit } from '../../jobs/accountingJobDelay';
import { AccountingProviderError } from '../../services/accounting/accountingProviderError';

const RUN = !!process.env.REDIS_URL;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => undefined);
});

function harness(processor: (job: Job, token?: string) => Promise<unknown>) {
  const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  const name = `acct-delay-it-${randomUUID()}`;
  const queue = new Queue(name, { connection });
  const worker = new Worker(name, processor, { connection, autorun: true });
  const failed = vi.fn();
  const completed = vi.fn();
  worker.on('failed', failed);
  worker.on('completed', completed);
  cleanups.push(async () => {
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
  });
  return { queue, worker, failed, completed };
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('queue never reached the expected state');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!RUN)('delayJobForRateLimit against a real BullMQ queue', () => {
  it('a throttled job is re-run after Retry-After and completes on attempts: 1 (no attempt consumed)', async () => {
    const runs: Array<{ attemptsMade: number; at: number }> = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    cleanups.push(async () => warnSpy.mockRestore());
    const throttle = new AccountingProviderError({
      kind: 'rate_limited', provider: 'quickbooks', operation: 'QuickBooks payment create', retryAfterMs: 1_000, throttleSource: 'provider',
    });
    const { queue, failed, completed } = harness(async (job, token) => {
      runs.push({ attemptsMade: job.attemptsMade, at: Date.now() });
      if (runs.length === 1) return delayJobForRateLimit({ job, token }, throttle, 1_000);
      return 'pushed';
    });

    const job = await queue.add('push-payment', { mappingId: 'm1' }, { attempts: 1 });
    await until(() => completed.mock.calls.length > 0 || failed.mock.calls.length > 0);

    expect(failed).not.toHaveBeenCalled();
    expect(runs).toHaveLength(2);
    // The throttled run did not count: the second run still saw zero attempts made…
    expect(runs[1]!.attemptsMade).toBe(0);
    // …and it waited out the Retry-After before running again.
    expect(runs[1]!.at - runs[0]!.at).toBeGreaterThanOrEqual(900);
    const finished = (await queue.getJob(job.id!))!;
    expect(await finished.getState()).toBe('completed');
    expect(finished.returnvalue).toBe('pushed');
    // Only the successful run is an attempt.
    expect(finished.attemptsMade).toBe(1);
  });

  it('control: the same attempts: 1 job that throws an ordinary error fails on its first run', async () => {
    let runs = 0;
    const { queue, failed, completed } = harness(async () => {
      runs++;
      throw new Error('ordinary provider failure');
    });

    const job = await queue.add('push-payment', { mappingId: 'm1' }, { attempts: 1 });
    await until(() => completed.mock.calls.length > 0 || failed.mock.calls.length > 0);

    expect(failed).toHaveBeenCalledTimes(1);
    expect(runs).toBe(1);
    expect(await (await queue.getJob(job.id!))!.getState()).toBe('failed');
  });
});
