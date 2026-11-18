import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  contextDepth: 0,
  depthAtRecheck: [] as number[],
  queue: null as any,
  worker: null as any,
}));

vi.mock('../db', () => ({
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
    state.contextDepth += 1;
    try { return await fn(); } finally { state.contextDepth -= 1; }
  },
  runOutsideDbContext: <T>(fn: () => T): T => fn(),
}));
vi.mock('./redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./bullmqQueue', () => ({
  createInstrumentedQueue: vi.fn(() => {
    state.queue = {
      getRepeatableJobs: vi.fn(async () => []),
      removeRepeatableByKey: vi.fn(),
      add: vi.fn(),
      close: vi.fn(),
    };
    return state.queue;
  }),
}));
vi.mock('bullmq', () => ({
  Queue: vi.fn(),
  Worker: vi.fn().mockImplementation(function () {
    state.worker = { on: vi.fn(), close: vi.fn() };
    return state.worker;
  }),
}));
const jobScheduleMock = vi.fn((key: string) => `sched:${key}`);
vi.mock('../jobs/scheduleRegistry', () => ({ jobSchedule: (k: string) => jobScheduleMock(k) }));
vi.mock('../jobs/workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

const listDueMock = vi.fn();
const recheckMock = vi.fn();
vi.mock('./portalDomainVerification', () => ({
  PORTAL_DOMAIN_STALE_DAYS: 7,
  listCustomerDomainsDueForRecheck: (...a: unknown[]) => listDueMock(...a),
  recheckCustomerDomain: (...a: unknown[]) => {
    state.depthAtRecheck.push(state.contextDepth);
    return recheckMock(...a);
  },
}));

import {
  PORTAL_DOMAIN_RECHECK_BATCH,
  PORTAL_DOMAIN_RECHECK_MIN_AGE_HOURS,
  PORTAL_DOMAIN_RECHECK_QUEUE,
  initializePortalDomainRecheckWorker,
  runPortalDomainRecheck,
} from './portalDomainRecheckWorker';

describe('portalDomainRecheckWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.contextDepth = 0;
    state.depthAtRecheck = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('selects only verified rows last checked more than 23 h ago, oldest first, at most 100', async () => {
    const now = new Date('2027-02-01T12:00:00Z');
    listDueMock.mockResolvedValue(['a', 'b', 'c']);
    const order: string[] = [];
    recheckMock.mockImplementation(async (id: string) => {
      order.push(`start:${id}`);
      await new Promise((r) => setTimeout(r, 1));
      order.push(`end:${id}`);
      return { status: id === 'b' ? 'skipped' : 'pass', cleared: null };
    });

    const out = await runPortalDomainRecheck({ now });

    expect(PORTAL_DOMAIN_RECHECK_BATCH).toBe(100);
    expect(PORTAL_DOMAIN_RECHECK_MIN_AGE_HOURS).toBe(23);
    // Due: last checked > 23 h ago, OR no pass for 7 days (a failing manual check must not postpone the stale clear).
    expect(listDueMock).toHaveBeenCalledWith(new Date(now.getTime() - 23 * 3600_000), 100, new Date(now.getTime() - 7 * 24 * 3600_000));
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
    expect(recheckMock).toHaveBeenCalledWith('a', expect.objectContaining({ now }));
    expect(out).toEqual({ checked: 2, cleared: 0 });
    expect(state.depthAtRecheck).toEqual([0, 0, 0]);
  });

  it('an error on one row does not stop the batch', async () => {
    listDueMock.mockResolvedValue(['a', 'b', 'c']);
    recheckMock.mockImplementation(async (id: string) => {
      if (id === 'b') throw new Error('boom');
      return { status: 'fail', cleared: id === 'a' ? 'record_missing' : null };
    });

    const out = await runPortalDomainRecheck();

    expect(recheckMock).toHaveBeenCalledTimes(3);
    expect(out).toEqual({ checked: 2, cleared: 1 });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('b'), expect.stringContaining('boom'));
  });

  it('registers a repeatable job with jobSchedule("portal-domain-recheck")', async () => {
    await initializePortalDomainRecheckWorker();
    expect(PORTAL_DOMAIN_RECHECK_QUEUE).toBe('portal-domain-recheck');
    expect(jobScheduleMock).toHaveBeenCalledWith('portal-domain-recheck');
    expect(state.queue.add).toHaveBeenCalledWith(
      'recheck',
      expect.anything(),
      expect.objectContaining({ repeat: { pattern: 'sched:portal-domain-recheck' } }),
    );
  });
});
