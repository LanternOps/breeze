import { beforeEach, describe, expect, it, vi } from 'vitest';

// Chainable Drizzle mock: db.select().from(table).where().orderBy() resolves to
// the rows registered for that table. .from() picks the result by table identity
// (the same sentinel objects the schema mock exports), so Promise.all ordering
// doesn't matter.
const tableResults = new Map<unknown, unknown[]>();
function selectBuilder() {
  let rows: unknown[] = [];
  const builder: Record<string, unknown> = {
    from(table: unknown) {
      rows = tableResults.get(table) ?? [];
      return builder;
    },
    where() {
      return builder;
    },
    orderBy() {
      return builder;
    },
    then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
      return Promise.resolve(rows).then(resolve, reject);
    }
  };
  return builder;
}

vi.mock('bullmq', () => ({
  Queue: vi.fn(function QueueMock() {
    return { add: vi.fn(), getJob: vi.fn() };
  }),
  Worker: vi.fn(function WorkerMock() {
    return { on: vi.fn(), close: vi.fn() };
  }),
  Job: class {}
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true)
}));

vi.mock('../db', () => ({
  db: { select: () => selectBuilder() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn())
}));

vi.mock('../db/schema', () => ({
  devices: { __table: 'devices' },
  peripheralEvents: { __table: 'peripheral_events' },
  peripheralPolicies: { __table: 'peripheral_policies' }
}));

vi.mock('../services/eventBus', () => ({ publishEvent: vi.fn() }));

const queueCommand = vi.fn();
const queueCommandForExecution = vi.fn();
vi.mock('../services/commandQueue', () => ({
  CommandTypes: { PERIPHERAL_POLICY_SYNC: 'peripheral_policy_sync' },
  queueCommand: (...args: unknown[]) => queueCommand(...args),
  queueCommandForExecution: (...args: unknown[]) => queueCommandForExecution(...args)
}));

import { findUncommittedPolicyIds, processPolicyDistribution } from './peripheralJobs';
import { devices as devicesTable, peripheralPolicies as policiesTable } from '../db/schema';

const activePolicyRow = {
  id: 'p1',
  orgId: 'org-1',
  name: 'Block USB storage',
  deviceClass: 'storage',
  action: 'block',
  targetType: 'organization',
  targetIds: {},
  exceptions: [],
  isActive: true,
  updatedAt: new Date('2026-06-24T00:00:00.000Z')
};

beforeEach(() => {
  vi.clearAllMocks();
  tableResults.clear();
});

describe('findUncommittedPolicyIds', () => {
  it('returns changed ids that are not visible in the DB (uncommitted race)', () => {
    expect(findUncommittedPolicyIds(['p1', 'p2'], ['p1'])).toEqual(['p2']);
  });

  it('returns empty when all changed ids are visible (incl. disabled ones)', () => {
    expect(findUncommittedPolicyIds(['p1', 'p2'], ['p2', 'p1', 'p3'])).toEqual([]);
  });

  it('returns empty when nothing changed', () => {
    expect(findUncommittedPolicyIds([], ['p1'])).toEqual([]);
  });
});

describe('processPolicyDistribution race handling', () => {
  it('throws (so BullMQ retries) when a changed policy is not yet visible — the enqueue-before-commit race', async () => {
    // Producer txn not committed yet: the changed policy id is absent from the DB.
    tableResults.set(policiesTable, []);
    tableResults.set(devicesTable, [{ id: 'd1', status: 'online' }]);

    await expect(
      processPolicyDistribution({
        type: 'policy-distribution',
        orgId: 'org-1',
        changedPolicyIds: ['p1'],
        reason: 'policy-created',
        queuedAt: '2026-06-24T00:00:00.000Z'
      })
    ).rejects.toThrow(/not yet visible|raced/i);

    // Must NOT have shipped an (empty) policy set to any device.
    expect(queueCommandForExecution).not.toHaveBeenCalled();
    expect(queueCommand).not.toHaveBeenCalled();
  });

  it('distributes the policy once it is visible (post-commit / retry)', async () => {
    tableResults.set(policiesTable, [activePolicyRow]);
    tableResults.set(devicesTable, [{ id: 'd1', status: 'online' }]);
    queueCommandForExecution.mockResolvedValue({ command: { id: 'cmd-1' } });

    const result = await processPolicyDistribution({
      type: 'policy-distribution',
      orgId: 'org-1',
      changedPolicyIds: ['p1'],
      reason: 'policy-created',
      queuedAt: '2026-06-24T00:00:00.000Z'
    });

    expect(queueCommandForExecution).toHaveBeenCalledTimes(1);
    const payload = queueCommandForExecution.mock.calls[0]![2] as { policies: Array<{ id: string }> };
    expect(payload.policies).toHaveLength(1);
    expect(payload.policies[0]!.id).toBe('p1');
    expect(result.queued).toBe(1);
  });

  it('excludes disabled policies from the payload but does not treat them as a race', async () => {
    const disabled = { ...activePolicyRow, id: 'p2', isActive: false };
    tableResults.set(policiesTable, [activePolicyRow, disabled]);
    tableResults.set(devicesTable, [{ id: 'd1', status: 'online' }]);
    queueCommandForExecution.mockResolvedValue({ command: { id: 'cmd-1' } });

    await processPolicyDistribution({
      type: 'policy-distribution',
      orgId: 'org-1',
      changedPolicyIds: ['p2'], // the just-disabled policy — exists, so not a race
      reason: 'policy-disabled',
      queuedAt: '2026-06-24T00:00:00.000Z'
    });

    const payload = queueCommandForExecution.mock.calls[0]![2] as { policies: Array<{ id: string }> };
    const ids = payload.policies.map((p) => p.id);
    expect(ids).toEqual(['p1']); // active only; disabled p2 excluded, no throw
  });
});
