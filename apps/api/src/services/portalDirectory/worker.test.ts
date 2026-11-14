import { beforeEach, describe, expect, it, vi } from 'vitest';

// The portal-directory-deprovision worker (portal registration W8, plan D10).
// The run store, the purge retry, the queue and BullMQ are mocked at their
// boundaries; the real-Postgres legs live in the run-store integration suite.

const h = vi.hoisted(() => ({
  applyRun: vi.fn(),
  retryPendingPurges: vi.fn(),
  pruneDirectoryRuns: vi.fn(),
  enqueueApplyRun: vi.fn(),
  runGoogleSweep: vi.fn(),
  evaluateGoogleOrg: vi.fn(),
  enforced: { value: false },
  staleRows: [] as Array<{ id: string; orgId: string }>,
  staleWhere: [] as unknown[],
  attach: vi.fn(),
  repeatables: [] as Array<{ name: string; key: string }>,
  queue: {
    add: vi.fn(),
    getRepeatableJobs: vi.fn(),
    removeRepeatableByKey: vi.fn(),
  },
  closeQueue: vi.fn(),
  workers: [] as Array<{ name: string; processor: (job: unknown) => Promise<unknown>; opts: Record<string, unknown>; close: ReturnType<typeof vi.fn> }>,
}));

vi.mock('bullmq', () => ({
  Worker: class {
    on = vi.fn();
    close = vi.fn();
    constructor(public name: string, public processor: (job: unknown) => Promise<unknown>, public opts: Record<string, unknown>) {
      h.workers.push(this as never);
    }
  },
}));
vi.mock('../redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../jobs/workerObservability', () => ({ attachWorkerObservability: h.attach }));
vi.mock('../../db', () => {
  const chain = {
    from: () => chain,
    where: (w: unknown) => { h.staleWhere.push(w); return chain; },
    orderBy: () => chain,
    limit: async () => h.staleRows,
  };
  return { db: { select: () => chain }, withSystemDbAccessContext: (fn: () => unknown) => fn() };
});
vi.mock('./runStore', () => ({ applyRun: h.applyRun, pruneDirectoryRuns: h.pruneDirectoryRuns }));
vi.mock('./identityDisable', () => ({
  PortalDirectoryIdentityError: class extends Error {
    constructor(readonly code: string, readonly httpStatus: number, message: string) { super(message); }
  },
  retryPendingPurges: h.retryPendingPurges,
}));
vi.mock('./mode', () => ({ isDirectoryDeprovisionEnforced: () => h.enforced.value }));
vi.mock('./googleSource', () => ({ runGoogleSweep: h.runGoogleSweep, evaluateGoogleOrg: h.evaluateGoogleOrg }));
vi.mock('./queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./queue')>()),
  enqueueApplyRun: h.enqueueApplyRun,
  getPortalDirectoryQueue: () => h.queue,
  closePortalDirectoryQueue: h.closeQueue,
}));

import { jobSchedule } from '../../jobs/scheduleRegistry';
import { PortalDirectoryIdentityError } from './identityDisable';
import { PORTAL_DIRECTORY_QUEUE } from './queue';
import {
  APPLYING_STALE_AFTER_MS,
  initializePortalDirectoryWorker,
  processPortalDirectoryJob,
  shutdownPortalDirectoryWorker,
} from './worker';

const ORG = '11111111-1111-4111-8111-111111111111';
const RUN = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-11-14T10:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  h.workers = [];
  h.staleRows = [];
  h.staleWhere = [];
  h.repeatables = [];
  h.enforced.value = false;
  h.applyRun.mockResolvedValue({ applied: 2, skipped: 1 });
  h.retryPendingPurges.mockResolvedValue(0);
  h.pruneDirectoryRuns.mockResolvedValue(0);
  h.enqueueApplyRun.mockResolvedValue(true);
  h.queue.getRepeatableJobs.mockImplementation(async () => h.repeatables);
  h.queue.add.mockResolvedValue(undefined);
});

describe('processPortalDirectoryJob — apply-run', () => {
  it('applies the run as the system actor', async () => {
    h.enforced.value = true;
    const out = await processPortalDirectoryJob({ name: 'apply-run', data: { runId: RUN, orgId: ORG } }, NOW);
    expect(h.applyRun).toHaveBeenCalledWith({ orgId: ORG, runId: RUN, actor: 'system' });
    expect(out).toEqual({ status: 'applied', applied: 2, skipped: 1 });
  });

  it('report mode is terminal: the job completes, logs, and is never retried', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    h.applyRun.mockRejectedValueOnce(new PortalDirectoryIdentityError(
      'PORTAL_DIRECTORY_ENFORCEMENT_OFF', 409, 'report only',
    ));
    const out = await processPortalDirectoryJob({ name: 'apply-run', data: { runId: RUN, orgId: ORG } }, NOW);
    expect(out).toEqual({ status: 'enforcement_off' });
    expect(JSON.stringify(log.mock.calls)).toContain(RUN);
  });

  it('a run that no longer exists is terminal too', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.applyRun.mockRejectedValueOnce(new PortalDirectoryIdentityError('PORTAL_DIRECTORY_RUN_NOT_FOUND', 404, 'gone'));
    await expect(processPortalDirectoryJob({ name: 'apply-run', data: { runId: RUN, orgId: ORG } }, NOW))
      .resolves.toEqual({ status: 'PORTAL_DIRECTORY_RUN_NOT_FOUND' });
  });

  it('any other failure is rethrown for a retry, sanitized (no query text)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.applyRun.mockRejectedValueOnce(Object.assign(new Error('insert ... values (person@example.com)'), { code: '40001' }));
    const err = await processPortalDirectoryJob({ name: 'apply-run', data: { runId: RUN, orgId: ORG } }, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('example.com');
    expect((err as Error).message).toContain('40001');
  });

  it('a malformed payload is dropped, not retried', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(processPortalDirectoryJob({ name: 'apply-run', data: { runId: 'x' } }, NOW)).resolves.toEqual({ status: 'invalid' });
    expect(h.applyRun).not.toHaveBeenCalled();
  });
});

describe('processPortalDirectoryJob — recover', () => {
  it('enforced: re-enqueues applying runs older than 15 min, retries pending purges and prunes', async () => {
    h.enforced.value = true;
    h.staleRows = [{ id: RUN, orgId: ORG }, { id: '55555555-5555-4555-8555-555555555555', orgId: ORG }];
    h.retryPendingPurges.mockResolvedValueOnce(3);
    h.pruneDirectoryRuns.mockResolvedValueOnce(4);
    const out = await processPortalDirectoryJob({ name: 'recover', data: {} }, NOW);
    expect(APPLYING_STALE_AFTER_MS).toBe(15 * 60_000);
    expect(h.enqueueApplyRun).toHaveBeenCalledTimes(2);
    expect(h.enqueueApplyRun).toHaveBeenCalledWith(RUN, ORG);
    expect(h.retryPendingPurges).toHaveBeenCalledWith(NOW);
    expect(h.pruneDirectoryRuns).toHaveBeenCalledWith(NOW);
    expect(out).toEqual({ status: 'ok', staleApplying: 2, requeued: 2, purgesRetried: 3, pruned: 4 });
  });

  it('report mode: counts applying runs but never re-enqueues them (no hourly loop)', async () => {
    h.staleRows = [{ id: RUN, orgId: ORG }];
    const out = await processPortalDirectoryJob({ name: 'recover', data: {} }, NOW);
    expect(h.enqueueApplyRun).not.toHaveBeenCalled();
    expect(out).toMatchObject({ staleApplying: 1, requeued: 0 });
    expect(h.retryPendingPurges).toHaveBeenCalled();
    expect(h.pruneDirectoryRuns).toHaveBeenCalled();
  });

  it('one failing leg does not skip the others; the job then fails for a retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.enforced.value = true;
    h.retryPendingPurges.mockRejectedValueOnce(new Error('redis down'));
    await expect(processPortalDirectoryJob({ name: 'recover', data: {} }, NOW)).rejects.toThrow(/recover/);
    expect(h.pruneDirectoryRuns).toHaveBeenCalled();
  });
});

describe('processPortalDirectoryJob — Google', () => {
  it('google-sweep fans out for the current UTC day', async () => {
    h.runGoogleSweep.mockResolvedValueOnce({ enqueued: 3 });
    expect(await processPortalDirectoryJob({ name: 'google-sweep', data: {} }, NOW)).toEqual({ enqueued: 3 });
    expect(h.runGoogleSweep).toHaveBeenCalledWith(NOW);
  });

  it('google-org evaluates one org for its day; a malformed payload is dropped', async () => {
    h.evaluateGoogleOrg.mockResolvedValueOnce({ outcome: 'evaluated' });
    expect(await processPortalDirectoryJob({ name: 'google-org', data: { orgId: ORG, utcDate: '2026-11-14' } }, NOW))
      .toEqual({ outcome: 'evaluated' });
    expect(h.evaluateGoogleOrg).toHaveBeenCalledWith(ORG, '2026-11-14');

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await processPortalDirectoryJob({ name: 'google-org', data: { orgId: ORG, utcDate: 'today' } }, NOW))
      .toEqual({ status: 'invalid' });
    expect(h.evaluateGoogleOrg).toHaveBeenCalledOnce();
  });

  it('a google-org failure propagates for the job retry', async () => {
    h.evaluateGoogleOrg.mockRejectedValueOnce(new Error('portal directory google-org failed: Error'));
    await expect(processPortalDirectoryJob({ name: 'google-org', data: { orgId: ORG, utcDate: '2026-11-14' } }, NOW))
      .rejects.toThrow('google-org');
  });
});

describe('the worker', () => {
  it('consumes portal-directory-deprovision at concurrency 2 and dispatches by job name', async () => {
    await initializePortalDirectoryWorker();
    expect(h.workers).toHaveLength(1);
    const w = h.workers[0]!;
    expect(w.name).toBe(PORTAL_DIRECTORY_QUEUE);
    expect(w.opts).toMatchObject({ concurrency: 2 });
    expect(h.attach).toHaveBeenCalledWith(w, 'portalDirectoryWorker');

    h.enforced.value = true;
    await w.processor({ name: 'apply-run', data: { runId: RUN, orgId: ORG } });
    expect(h.applyRun).toHaveBeenCalledOnce();
    await w.processor({ name: 'recover', data: {} });
    expect(h.pruneDirectoryRuns).toHaveBeenCalledOnce();
    h.runGoogleSweep.mockResolvedValueOnce({ enqueued: 0 });
    await w.processor({ name: 'google-sweep', data: {} });
    expect(h.runGoogleSweep).toHaveBeenCalledOnce();
    h.evaluateGoogleOrg.mockResolvedValueOnce({ outcome: 'no_identities' });
    await w.processor({ name: 'google-org', data: { orgId: ORG, utcDate: '2026-11-14' } });
    expect(h.evaluateGoogleOrg).toHaveBeenCalledOnce();
    await shutdownPortalDirectoryWorker();
    expect(w.close).toHaveBeenCalled();
    expect(h.closeQueue).toHaveBeenCalled();
  });

  it('registers the hourly recover repeatable on its registry slot, replacing a stale one', async () => {
    h.repeatables = [{ name: 'recover', key: 'old-recover' }, { name: 'other', key: 'keep' }];
    await initializePortalDirectoryWorker();
    expect(h.queue.removeRepeatableByKey).toHaveBeenCalledWith('old-recover');
    expect(h.queue.removeRepeatableByKey).not.toHaveBeenCalledWith('keep');
    expect(h.queue.add).toHaveBeenCalledWith('recover', expect.anything(), expect.objectContaining({
      repeat: { pattern: jobSchedule('portal-directory-recover') },
    }));
    const opts = h.queue.add.mock.calls.find((c) => c[0] === 'recover')![2] as { jobId: string };
    expect(opts.jobId).not.toContain(':');
    await shutdownPortalDirectoryWorker();
  });

  it('registers the daily google-sweep repeatable on its registry slot, replacing a stale one', async () => {
    h.repeatables = [{ name: 'google-sweep', key: 'old-sweep' }];
    await initializePortalDirectoryWorker();
    expect(h.queue.removeRepeatableByKey).toHaveBeenCalledWith('old-sweep');
    expect(h.queue.add).toHaveBeenCalledWith('google-sweep', expect.anything(), expect.objectContaining({
      repeat: { pattern: jobSchedule('portal-directory-google') },
    }));
    const opts = h.queue.add.mock.calls.find((c) => c[0] === 'google-sweep')![2] as { jobId: string };
    expect(opts.jobId).not.toContain(':');
    await shutdownPortalDirectoryWorker();
  });
});
