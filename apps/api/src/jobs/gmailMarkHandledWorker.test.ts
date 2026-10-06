import { describe, it, expect, vi } from 'vitest';

const workerCtorArgs = vi.hoisted(() => [] as unknown[][]);
const { setGlobalConcurrencyMock } = vi.hoisted(() => ({ setGlobalConcurrencyMock: vi.fn(async (..._a: unknown[]) => {}) }));
vi.mock('bullmq', () => {
  class MockWorker {
    constructor(...args: unknown[]) { workerCtorArgs.push(args); }
    on() { return this; }
    async close() { return undefined; }
  }
  return {
    Queue: vi.fn(function Queue() { return { add: vi.fn(), setGlobalConcurrency: setGlobalConcurrencyMock }; }),
    Worker: MockWorker,
  };
});
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
const { markMock } = vi.hoisted(() => ({ markMock: vi.fn(async (..._a: unknown[]) => 'marked') }));
vi.mock('../services/ticketMailbox/markIngestedGmailHandled', () => ({ markIngestedGmailHandled: markMock }));

import { attachWorkerObservability } from './workerObservability';
import {
  GmailMarkRetryLater,
  handleGmailMarkHandled,
  initializeGmailMarkHandledWorker,
  shutdownGmailMarkHandledWorker,
} from './gmailMarkHandledWorker';

describe('gmailMarkHandledWorker', () => {
  it('consumes the gmail-mark-handled queue one job at a time, with observability attached', async () => {
    await initializeGmailMarkHandledWorker();
    expect(workerCtorArgs).toHaveLength(1);
    const [queueName, , opts] = workerCtorArgs[0] as [string, unknown, { concurrency?: number }];
    expect(queueName).toBe('gmail-mark-handled');
    expect(opts.concurrency).toBe(1);
    // ...and one at a time across every process: the queue-wide BullMQ limit.
    expect(setGlobalConcurrencyMock).toHaveBeenCalledWith(1);
    expect(attachWorkerObservability).toHaveBeenCalledWith(expect.anything(), 'gmailMarkHandledWorker', expect.anything());
    // A retry-later attempt is reported only when attempts are exhausted; anything else as usual.
    const { classifyFailure } = (attachWorkerObservability as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![2] as {
      classifyFailure: (job: unknown, err: Error) => unknown;
    };
    expect(classifyFailure(undefined, new GmailMarkRetryLater())).toEqual(expect.objectContaining({ reportOnlyWhenExhausted: true, reason: 'gmail_mark_retry' }));
    expect(classifyFailure(undefined, new Error('boom'))).toBeNull();
    // Idempotent init.
    await initializeGmailMarkHandledWorker();
    expect(workerCtorArgs).toHaveLength(1);
    await shutdownGmailMarkHandledWorker();
  });

  it('runs the job through the existing mark-handled code with the job generation', async () => {
    const generation = { provider: 'gmail' as const, connectionId: 'c', partnerId: 'p', tenantId: null, consentAttemptId: 'a' };
    const email = { provider: 'gmail' as const, providerMessageId: 'gmail:s:m' };
    await expect(handleGmailMarkHandled({ data: { email, generation } } as never)).resolves.toBe('marked');
    expect(markMock).toHaveBeenCalledWith(email, generation);
  });

  it('asks BullMQ to retry a transient failure while attempts remain, and never a permanent one', async () => {
    const generation = { provider: 'gmail' as const, connectionId: 'c', partnerId: 'p', tenantId: null, consentAttemptId: 'a' };
    const email = { provider: 'gmail' as const, providerMessageId: 'gmail:s:m' };
    const job = (attemptsMade: number) => ({ data: { email, generation }, attemptsMade, opts: { attempts: 5 } }) as never;
    markMock.mockResolvedValue('retry');
    await expect(handleGmailMarkHandled(job(0))).rejects.toBeInstanceOf(GmailMarkRetryLater);
    await expect(handleGmailMarkHandled(job(3))).rejects.toBeInstanceOf(GmailMarkRetryLater);
    // The last attempt completes: the failure is already recorded on the mailbox.
    await expect(handleGmailMarkHandled(job(4))).resolves.toBe('failed');
    markMock.mockResolvedValue('failed');
    await expect(handleGmailMarkHandled(job(0))).resolves.toBe('failed');
    markMock.mockResolvedValue('marked');
  });
});
