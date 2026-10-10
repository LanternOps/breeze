import { beforeEach, describe, expect, it, vi } from 'vitest';

// Every enqueue goes through a Queue double whose `add` runs the REAL bullmq
// custom-jobId validator (`Job.validateOptions`), so an id bullmq would reject
// in production is rejected here too. `sync-policy:<policyId>` was: every DNS
// policy create / domain edit returned `syncScheduled:false` with the warning
// "Custom Id cannot contain :", and the change never reached the provider.
const { added, getJobMock } = vi.hoisted(() => ({
  added: [] as Array<{ name: string; data: unknown; opts: { jobId?: string } }>,
  getJobMock: vi.fn(async (_id: string) => null as unknown),
}));

vi.mock('bullmq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bullmq')>();
  class ValidatingQueue {
    getJob = getJobMock;
    async add(name: string, data: unknown, opts: { jobId?: string } = {}) {
      const queueStub = { opts: {}, toKey: (k: string) => k, keys: {}, client: Promise.resolve(null) } as never;
      const job = new actual.Job(queueStub, name, data, opts);
      (job as unknown as { validateOptions(d: { data: string }): void }).validateOptions({ data: '{}' });
      added.push({ name, data, opts });
      return { id: opts.jobId ?? 'generated' };
    }
  }
  return { ...actual, Queue: ValidatingQueue };
});

vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));

import { scheduleDnsEventSync, schedulePolicySync } from './dnsSyncJob';

const POLICY_ID = '4f0d3c0e-1111-4222-8333-444455556666';

describe('dnsSyncJob enqueue job ids', () => {
  beforeEach(() => {
    added.length = 0;
    getJobMock.mockClear();
  });

  it('schedulePolicySync enqueues under an id bullmq accepts, and looks up the same id', async () => {
    const id = await schedulePolicySync(POLICY_ID, { add: ['example.com'], remove: [] });
    expect(id).toBe(`sync-policy-${POLICY_ID}`);
    expect(added).toHaveLength(1);
    expect(added[0]!.opts.jobId).toBe(`sync-policy-${POLICY_ID}`);
    expect(getJobMock).toHaveBeenCalledWith(`sync-policy-${POLICY_ID}`);
  });

  it('scheduleDnsEventSync ids are accepted too', async () => {
    await scheduleDnsEventSync(POLICY_ID);
    await scheduleDnsEventSync();
    expect(added.map((a) => a.opts.jobId)).toEqual([`sync-integration-${POLICY_ID}`, 'sync-all-manual']);
  });
});
