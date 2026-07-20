import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addBulkMock, selectMock, fromMock, whereMock, groupByMock, workerProcessors, dbCtx } = vi.hoisted(() => ({
  addBulkMock: vi.fn(),
  selectMock: vi.fn(),
  fromMock: vi.fn(),
  whereMock: vi.fn(),
  groupByMock: vi.fn(),
  workerProcessors: [] as Array<(job: { data: unknown }) => Promise<unknown>>,
  // Tracks simulated withSystemDbAccessContext nesting so tests can assert
  // WHERE an enqueue ran relative to the held context (#1105, BREEZE-K class).
  dbCtx: { depth: 0 },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = vi.fn();
    addBulk = addBulkMock;
    close = vi.fn();
  },
  Worker: class {
    constructor(_name: string, processor: (job: { data: unknown }) => Promise<unknown>) {
      workerProcessors.push(processor);
    }

    close = vi.fn();
    on = vi.fn();
  },
  Job: class {}
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  db: {
    select: selectMock
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    dbCtx.depth++;
    try {
      return await fn();
    } finally {
      dbCtx.depth--;
    }
  }),
  // #1105 tripwire used by createInstrumentedQueue (the queue factory this
  // worker now constructs through). No-op here — no held context under test.
  assertOutsideHeldDbContext: vi.fn()
}));

vi.mock('../db/schema', () => ({
  devices: {
    orgId: 'org_id',
    status: 'status'
  }
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/securityPosture', () => ({
  computeAndPersistOrgSecurityPosture: vi.fn()
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn()
}));

import { publishEvent } from '../services/eventBus';
import {
  createSecurityPostureWorker,
  publishSecurityScoreChangedEvents,
  shutdownSecurityPostureWorker
} from './securityPostureWorker';

function buildChanges(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    orgId: '11111111-1111-1111-1111-111111111111',
    deviceId: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
    previousScore: 70,
    currentScore: 75,
    delta: 5,
    previousRiskLevel: 'medium' as const,
    currentRiskLevel: 'low' as const,
    changedFactors: ['patch_compliance']
  }));
}

describe('publishSecurityScoreChangedEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(publishEvent).mockResolvedValue('event-id');
  });

  it('caps published events at the configured limit', async () => {
    const changes = buildChanges(250);
    const result = await publishSecurityScoreChangedEvents(changes, '2026-02-22T00:00:00.000Z', {
      limit: 200,
      concurrency: 8
    });

    expect(vi.mocked(publishEvent)).toHaveBeenCalledTimes(200);
    expect(result).toEqual({
      attempted: 200,
      published: 200,
      failed: 0
    });
  });

  it('continues publishing when some events fail', async () => {
    let callCount = 0;
    vi.mocked(publishEvent).mockImplementation(async () => {
      callCount++;
      if (callCount === 4) {
        throw new Error('publish failed');
      }
      return 'event-id';
    });

    const changes = buildChanges(10);
    const result = await publishSecurityScoreChangedEvents(changes, '2026-02-22T00:00:00.000Z', {
      limit: 10,
      concurrency: 4
    });

    expect(vi.mocked(publishEvent)).toHaveBeenCalledTimes(10);
    expect(result).toEqual({
      attempted: 10,
      published: 9,
      failed: 1
    });
  });

  it('respects bounded concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    vi.mocked(publishEvent).mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return 'event-id';
    });

    const changes = buildChanges(12);
    const result = await publishSecurityScoreChangedEvents(changes, '2026-02-22T00:00:00.000Z', {
      limit: 12,
      concurrency: 3
    });

    expect(result.failed).toBe(0);
    expect(result.published).toBe(12);
    expect(maxActive).toBeLessThanOrEqual(3);
  });
});

describe('scan-orgs enqueue context (#1105, BREEZE-K class)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    workerProcessors.length = 0;
    dbCtx.depth = 0;
    selectMock.mockReturnValue({ from: fromMock });
    fromMock.mockReturnValue({ where: whereMock });
    whereMock.mockReturnValue({ groupBy: groupByMock });
    await shutdownSecurityPostureWorker();
  });

  it('fans out scan-orgs enqueues OUTSIDE the held system DB context, read inside it', async () => {
    createSecurityPostureWorker();

    let depthAtRead = -1;
    groupByMock.mockImplementation(async () => {
      depthAtRead = dbCtx.depth;
      return [{ orgId: '11111111-1111-1111-1111-111111111111' }];
    });
    const depthAtEnqueue: number[] = [];
    addBulkMock.mockImplementation(async () => {
      depthAtEnqueue.push(dbCtx.depth);
      return [];
    });

    const result = await workerProcessors[0]!({
      data: { type: 'scan-orgs', queuedAt: '2026-02-22T00:00:00.000Z' }
    });

    expect(result).toEqual({ queued: 1 });
    expect(depthAtRead).toBe(1);
    expect(depthAtEnqueue).toEqual([0]);
  });
});
