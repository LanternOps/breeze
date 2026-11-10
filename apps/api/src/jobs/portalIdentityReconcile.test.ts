import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// Unit shape of the daily identity drift report (portal registration W3,
// identities release B, plan D10: report, never repair). The real-Postgres run
// of the job handler is in
// __tests__/integration/portalUserIdentities.integration.test.ts.

const h = vi.hoisted(() => ({
  reconcile: vi.fn(),
  captureException: vi.fn(),
  attachObservability: vi.fn(),
  withSystem: vi.fn(),
  dbWrite: vi.fn(),
  failNextAdd: false,
  repeatables: [] as Array<{ name: string; key: string }>,
  queues: [] as Array<{ add: ReturnType<typeof vi.fn>; getRepeatableJobs: ReturnType<typeof vi.fn>; removeRepeatableByKey: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
  workers: [] as Array<{ name: string; processor: (job: unknown) => Promise<unknown>; on: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = vi.fn(async () => { if (h.failNextAdd) { h.failNextAdd = false; throw new Error('redis down'); } });
    getRepeatableJobs = vi.fn(async () => h.repeatables);
    removeRepeatableByKey = vi.fn();
    close = vi.fn();
    constructor() { h.queues.push(this as never); }
  },
  Worker: class {
    on = vi.fn();
    close = vi.fn();
    constructor(public name: string, public processor: (job: unknown) => Promise<unknown>) { h.workers.push(this as never); }
  },
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: h.captureException }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: h.attachObservability }));
// Any DB write or context escalation by the job itself is a bug: the W2
// reconcile function opens its own read-only system context.
vi.mock('../db', () => ({
  db: new Proxy({}, { get: (_t, prop) => (...args: unknown[]) => { h.dbWrite(prop, ...args); throw new Error(`job touched db.${String(prop)}`); } }),
  withSystemDbAccessContext: h.withSystem,
  hasDbAccessContext: () => false,
}));
vi.mock('../services/portalUserIdentities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/portalUserIdentities')>()),
  reconcilePortalUserIdentities: h.reconcile,
}));

import {
  initializePortalIdentityReconcileJob,
  processPortalIdentityReconcileJob,
  runPortalIdentityReconcile,
  shutdownPortalIdentityReconcileJob,
} from './portalIdentityReconcile';
import { jobSchedule } from './scheduleRegistry';
import type { PortalIdentityDriftReport } from '../services/portalUserIdentities';

const report = (counts: Partial<PortalIdentityDriftReport['counts']> = {}): PortalIdentityDriftReport => ({
  checkedAt: '2026-11-08T11:23:00.000Z',
  counts: { missingIdentity: 0, orphanIdentity: 0, mismatched: 0, halfPopulated: 0, ...counts },
  samples: {
    missingIdentity: counts.missingIdentity ? [{ portalUserId: 'pu-missing', orgId: 'org-1' }] : [],
    orphanIdentity: [],
    mismatched: [],
    halfPopulated: [],
  },
});

let logSpy: MockInstance<typeof console.log> | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  await shutdownPortalIdentityReconcileJob();
  h.queues.length = 0;
  h.workers.length = 0;
  h.repeatables = [];
  logSpy?.mockRestore();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

/** The one JSON log line the run writes. */
function loggedReport(): Record<string, unknown> {
  const lines = logSpy!.mock.calls
    .map((c) => c[0] as unknown)
    .filter((l): l is string => typeof l === 'string' && l.startsWith('{'));
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

describe('runPortalIdentityReconcile', () => {
  it('reports and never writes; calls captureException with tag eventCode portal_identity_drift when not clean', async () => {
    h.reconcile.mockResolvedValueOnce(report({ missingIdentity: 2, mismatched: 1 }));

    const out = await runPortalIdentityReconcile();

    expect(out.counts).toEqual({ missingIdentity: 2, orphanIdentity: 0, mismatched: 1, halfPopulated: 0 });
    // Called with no context held and no arguments (whole deployment, default sample cap).
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.reconcile).toHaveBeenCalledWith();
    expect(h.withSystem).not.toHaveBeenCalled();
    expect(h.dbWrite).not.toHaveBeenCalled();

    expect(h.captureException).toHaveBeenCalledTimes(1);
    const [err, ctx, tags, options] = h.captureException.mock.calls[0]!;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('portal identity drift');
    expect(ctx).toBeUndefined();
    expect(tags).toEqual({ eventCode: 'portal_identity_drift' });
    expect(options).toEqual({ fingerprint: ['portal_identity_drift'] });

    // The counts live in ONE JSON log line, not in Sentry.
    expect(loggedReport()).toEqual({
      event: 'portal_identity_drift_report',
      clean: false,
      checkedAt: '2026-11-08T11:23:00.000Z',
      counts: { missingIdentity: 2, orphanIdentity: 0, mismatched: 1, halfPopulated: 0 },
    });
    expect(JSON.stringify(h.captureException.mock.calls)).not.toContain('missingIdentity');
  });

  it('a clean report logs one line and never alerts', async () => {
    h.reconcile.mockResolvedValueOnce(report());
    await runPortalIdentityReconcile();
    expect(h.captureException).not.toHaveBeenCalled();
    expect(loggedReport()).toMatchObject({ event: 'portal_identity_drift_report', clean: true });
  });

  it('never logs sample ids (the CLI prints those on demand)', async () => {
    h.reconcile.mockResolvedValueOnce(report({ missingIdentity: 1 }));
    await runPortalIdentityReconcile();
    expect(JSON.stringify(logSpy!.mock.calls)).not.toContain('pu-missing');
  });
});

describe('BullMQ wiring', () => {
  it('the worker handler returns the counts and rethrows (after reporting) when the run fails', async () => {
    await initializePortalIdentityReconcileJob();
    const worker = h.workers[0]!;
    expect(worker.name).toBe('portal-identity-reconcile');
    expect(h.attachObservability).toHaveBeenCalledWith(worker, 'portalIdentityReconcile');

    h.reconcile.mockResolvedValueOnce(report({ orphanIdentity: 3 }));
    await expect(worker.processor({})).resolves.toEqual({
      clean: false,
      counts: { missingIdentity: 0, orphanIdentity: 3, mismatched: 0, halfPopulated: 0 },
    });

    h.captureException.mockClear();
    const boom = new Error('reconcilePortalUserIdentities must not run inside a held DB access context');
    h.reconcile.mockRejectedValueOnce(boom);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(worker.processor({})).rejects.toBe(boom);
      // The processor only rethrows; the worker `failed` listener is the one Sentry reporter.
      expect(h.captureException).not.toHaveBeenCalled();
      const failed = worker.on.mock.calls.find((c) => c[0] === 'failed')![1] as (job: unknown, e: Error) => void;
      failed({ id: '1' }, boom);
      expect(h.captureException).toHaveBeenCalledTimes(1);
      expect(h.captureException).toHaveBeenCalledWith(boom);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('a failing run produces exactly one capture and logs only the safe message, never the raw error', async () => {
    await initializePortalIdentityReconcileJob();
    const worker = h.workers[0]!;
    const secret = Object.assign(new Error('Failed query: select ... where email = $1'), { params: ['victim@example.com'] });
    h.reconcile.mockRejectedValueOnce(secret);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(worker.processor({})).rejects.toBe(secret);
      const failed = worker.on.mock.calls.find((c) => c[0] === 'failed')![1] as (job: unknown, e: Error) => void;
      failed({ id: '1' }, secret);
      expect(h.captureException).toHaveBeenCalledTimes(1);
      for (const call of errSpy.mock.calls) {
        for (const arg of call) expect(typeof arg).toBe('string');
      }
      expect(JSON.stringify(errSpy.mock.calls)).not.toContain('victim@example.com');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('closes the queue as well as the worker when scheduling fails during init', async () => {
    h.repeatables = [];
    h.failNextAdd = true;
    await expect(initializePortalIdentityReconcileJob()).rejects.toThrow('redis down');
    expect(h.workers[0]!.close).toHaveBeenCalledTimes(1);
    expect(h.queues[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('schedules a daily repeatable on its registry slot (never `every`), clearing a stale repeatable first', async () => {
    h.repeatables = [{ name: 'portal-identity-reconcile', key: 'stale-key' }, { name: 'someone-else', key: 'other-key' }];
    await initializePortalIdentityReconcileJob();
    const queue = h.queues[0]!;
    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('stale-key');
    expect(queue.removeRepeatableByKey).not.toHaveBeenCalledWith('other-key');
    expect(queue.add).toHaveBeenCalledWith(
      'portal-identity-reconcile',
      expect.objectContaining({ type: 'portal-identity-reconcile' }),
      expect.objectContaining({ repeat: { pattern: jobSchedule('portal-identity-reconcile') } }),
    );
    expect(jobSchedule('portal-identity-reconcile')).toMatch(/^\d+ \d+ \* \* \*$/);
  });

  it('processPortalIdentityReconcileJob is the handler body', async () => {
    h.reconcile.mockResolvedValueOnce(report());
    await expect(processPortalIdentityReconcileJob()).resolves.toEqual({
      clean: true,
      counts: { missingIdentity: 0, orphanIdentity: 0, mismatched: 0, halfPopulated: 0 },
    });
  });
});
