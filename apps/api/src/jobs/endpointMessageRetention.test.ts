import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  added: [] as Array<{ name: string; opts: Record<string, unknown> }>,
  execute: vi.fn(async () => []),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    async getRepeatableJobs() { return []; }
    async removeRepeatableByKey() {}
    async add(name: string, _data: unknown, opts: Record<string, unknown>) { h.added.push({ name, opts }); }
    async close() {}
  },
  Worker: class {
    async close() {}
    on() { return this; }
  },
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: () => {} }));
vi.mock('../db', () => ({
  db: { execute: h.execute },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('../services/commandQueue', () => ({ queueCommandForExecutionWithSystemPrecheck: vi.fn() }));

import {
  CHAT_JOB_NAME,
  CHAT_RETENTION_EVERY_MS,
  initializeEndpointMessageRetentionWorker,
  processEndpointMessageRetentionJob,
  shutdownEndpointMessageRetentionWorker,
} from './endpointMessageRetention';

describe('endpoint message retention worker: live chat tick (#8743)', () => {
  beforeEach(async () => {
    h.added.length = 0;
    h.execute.mockClear();
    await shutdownEndpointMessageRetentionWorker();
  });

  it('schedules the chat sweep every 5 minutes alongside the 6-hourly message retention', async () => {
    await initializeEndpointMessageRetentionWorker();
    const chat = h.added.find((j) => j.name === CHAT_JOB_NAME);
    // A 30-minute idle close needs a tick well under 30 minutes.
    expect(CHAT_RETENTION_EVERY_MS).toBe(5 * 60_000);
    expect(chat?.opts).toMatchObject({ repeat: { every: CHAT_RETENTION_EVERY_MS } });
    expect(h.added.find((j) => j.name === 'endpoint-message-retention')?.opts).toMatchObject({ repeat: { pattern: expect.any(String) } });
  });

  it('routes the chat job to the chat pass only (4 statements), and the message job to the W02 pass (4 statements)', async () => {
    const chat = await processEndpointMessageRetentionJob({ name: CHAT_JOB_NAME });
    expect(chat).toEqual({ idleExpired: 0, opensTimedOut: 0, bodiesPurged: 0, conversationsDeleted: 0 });
    expect(h.execute).toHaveBeenCalledTimes(4);
    h.execute.mockClear();
    const messages = await processEndpointMessageRetentionJob({ name: 'endpoint-message-retention' });
    expect(messages).toEqual({ bodiesPurged: 0, deliveriesExpired: 0, messagesDeleted: 0, detachedDeliveriesDeleted: 0 });
    expect(h.execute).toHaveBeenCalledTimes(4);
  });
});
