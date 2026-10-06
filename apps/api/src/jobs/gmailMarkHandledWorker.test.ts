import { describe, it, expect, vi } from 'vitest';

const workerCtorArgs = vi.hoisted(() => [] as unknown[][]);
vi.mock('bullmq', () => {
  class MockWorker {
    constructor(...args: unknown[]) { workerCtorArgs.push(args); }
    on() { return this; }
    async close() { return undefined; }
  }
  return { Queue: vi.fn(() => ({ add: vi.fn() })), Worker: MockWorker };
});
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
const { markMock } = vi.hoisted(() => ({ markMock: vi.fn(async (..._a: unknown[]) => 'marked') }));
vi.mock('../services/ticketMailbox/markIngestedGmailHandled', () => ({ markIngestedGmailHandled: markMock }));

import { attachWorkerObservability } from './workerObservability';
import {
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
    expect(attachWorkerObservability).toHaveBeenCalledWith(expect.anything(), 'gmailMarkHandledWorker');
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
});
