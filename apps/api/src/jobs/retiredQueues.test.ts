import { beforeEach, describe, expect, it, vi } from 'vitest';

// Retired BullMQ queues (portal registration W10 #11387, plan D4): deleting a
// repeatable job's code leaves its repeat key (and the next delayed
// occurrence) in Redis. The cleanup removes both, idempotently, at boot.

const h = vi.hoisted(() => ({
  repeatables: new Map<string, Array<{ name: string; key: string }>>(),
  removed: [] as Array<{ queue: string; key: string }>,
  drained: [] as Array<{ queue: string; delayed: boolean }>,
  closed: [] as string[],
  failQueue: null as string | null,
}));

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(public name: string) {}
    async getRepeatableJobs() {
      if (h.failQueue === this.name) throw new Error('redis down');
      return h.repeatables.get(this.name) ?? [];
    }
    async removeRepeatableByKey(key: string) {
      h.removed.push({ queue: this.name, key });
      h.repeatables.set(this.name, (h.repeatables.get(this.name) ?? []).filter((r) => r.key !== key));
      return true;
    }
    async drain(delayed: boolean) { h.drained.push({ queue: this.name, delayed }); }
    async close() { h.closed.push(this.name); }
  },
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));

import { RETIRED_QUEUES, cleanupRetiredQueues } from './retiredQueues';

beforeEach(() => {
  h.repeatables.clear();
  h.removed = [];
  h.drained = [];
  h.closed = [];
  h.failQueue = null;
});

describe('retired BullMQ queues', () => {
  it('lists the W10 portal identity drift report queue', () => {
    expect(RETIRED_QUEUES.map((q) => q.name)).toContain('portal-identity-reconcile');
    for (const q of RETIRED_QUEUES) expect(q.reason.length, q.name).toBeGreaterThan(10);
  });

  it('removes every repeatable, drains waiting + delayed jobs and closes the queue', async () => {
    h.repeatables.set('portal-identity-reconcile', [{ name: 'portal-identity-reconcile', key: 'k1' }, { name: 'other', key: 'k2' }]);
    const result = await cleanupRetiredQueues();
    expect(h.removed).toEqual([
      { queue: 'portal-identity-reconcile', key: 'k1' },
      { queue: 'portal-identity-reconcile', key: 'k2' },
    ]);
    expect(h.drained).toContainEqual({ queue: 'portal-identity-reconcile', delayed: true });
    expect(h.closed).toContain('portal-identity-reconcile');
    expect(result).toContainEqual({ queue: 'portal-identity-reconcile', repeatablesRemoved: 2 });
  });

  it('is idempotent: a second run removes nothing and still succeeds', async () => {
    h.repeatables.set('portal-identity-reconcile', [{ name: 'portal-identity-reconcile', key: 'k1' }]);
    await cleanupRetiredQueues();
    const second = await cleanupRetiredQueues();
    expect(second).toContainEqual({ queue: 'portal-identity-reconcile', repeatablesRemoved: 0 });
  });

  it('a Redis failure on one queue is reported, never thrown (boot continues), and the queue is closed', async () => {
    h.failQueue = 'portal-identity-reconcile';
    const result = await cleanupRetiredQueues();
    expect(result).toContainEqual({ queue: 'portal-identity-reconcile', repeatablesRemoved: 0, error: 'redis down' });
    expect(h.closed).toContain('portal-identity-reconcile');
  });
});
