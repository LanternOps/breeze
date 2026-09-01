/**
 * aiAgentImpactRollup (Phase 2 wave P2-6, #4193 task A5) — mocked-DB unit
 * tests for the nightly scan + per-org rebuild fan-out.
 *
 * The real SQL and UTC day arithmetic are proven in
 * `services/aiAgents/impactRollup.test.ts` and the integration suite; what is
 * provable here is: the producer gate reads `envFlag` at CALL time (not a
 * frozen module-scope const), the per-org bootstrap-vs-nightly window
 * selection, the deterministic job ids, the manual-refresh enqueue helper,
 * the scan/rebuild worker dispatch, and that the repeatable scan registers
 * with the registry-allocated cron pattern (not a hardcoded string).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  addBulkMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  queueCloseMock,
  workerCloseMock,
  capturedWorkerProcessor,
  attachWorkerObservabilityMock,
  runOutsideDbContextMock,
  rebuildOrgImpactRangeMock,
  findImpactSourceOrgIdsMock,
  needsImpactBootstrapMock,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  addBulkMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  capturedWorkerProcessor: { current: null as null | ((job: { data: unknown }) => Promise<unknown>) },
  attachWorkerObservabilityMock: vi.fn(),
  runOutsideDbContextMock: vi.fn(async <T>(fn: () => T | Promise<T>): Promise<T> => fn()),
  rebuildOrgImpactRangeMock: vi.fn(),
  findImpactSourceOrgIdsMock: vi.fn(),
  needsImpactBootstrapMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = (...args: unknown[]) => addMock(...(args as []));
    addBulk = (...args: unknown[]) => addBulkMock(...(args as []));
    getRepeatableJobs = () => getRepeatableJobsMock();
    removeRepeatableByKey = (key: string) => removeRepeatableByKeyMock(key);
    close = () => queueCloseMock();
  },
  Worker: class {
    constructor(_name: string, processor: (job: { data: unknown }) => Promise<unknown>) {
      capturedWorkerProcessor.current = processor;
    }
    on = vi.fn();
    close = () => workerCloseMock();
  },
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: (...args: unknown[]) => attachWorkerObservabilityMock(...(args as [])),
}));

// The real module: fully mocked '../db' (below) makes it safe to keep the
// REAL `lastCompleteUtcDay` / `shiftUtcDay` pure day-math, so the per-org
// bootstrap-vs-nightly assertions below check this module's arithmetic
// against the service's own, not a hand-duplicated copy that could drift.
vi.mock('../services/aiAgents/impactRollup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/aiAgents/impactRollup')>();
  return {
    ...actual,
    rebuildOrgImpactRange: rebuildOrgImpactRangeMock,
    findImpactSourceOrgIds: findImpactSourceOrgIdsMock,
    needsImpactBootstrap: needsImpactBootstrapMock,
  };
});

// Resolves to the same absolute module as `services/aiAgents/impactRollup.ts`'s
// own `'../../db'` import, so the real module (unwrapped above via
// importOriginal) never touches a live pool.
vi.mock('../db', () => ({
  db: { execute: vi.fn() },
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { jobSchedule } from './scheduleRegistry';
import {
  AI_AGENT_IMPACT_ROLLUP_QUEUE,
  IMPACT_NIGHTLY_TRAILING_DAYS,
  buildImpactRollupJobId,
  createAiAgentImpactRollupWorker,
  enqueueImpactRollupForOrgs,
  getAiAgentImpactRollupQueue,
  initializeAiAgentImpactRollupWorker,
  processImpactScan,
  shutdownAiAgentImpactRollupWorker,
} from './aiAgentImpactRollup';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

describe('aiAgentImpactRollup', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T12:00:00.000Z'));

    addMock.mockReset();
    addBulkMock.mockReset();
    getRepeatableJobsMock.mockReset();
    removeRepeatableByKeyMock.mockReset();
    queueCloseMock.mockReset();
    workerCloseMock.mockReset();
    capturedWorkerProcessor.current = null;
    attachWorkerObservabilityMock.mockReset();
    runOutsideDbContextMock.mockClear();
    runOutsideDbContextMock.mockImplementation(async <T>(fn: () => T | Promise<T>): Promise<T> => fn());
    rebuildOrgImpactRangeMock.mockReset();
    findImpactSourceOrgIdsMock.mockReset();
    needsImpactBootstrapMock.mockReset();

    addMock.mockResolvedValue({ id: 'scan-job' });
    addBulkMock.mockResolvedValue([]);
    getRepeatableJobsMock.mockResolvedValue([]);
    findImpactSourceOrgIdsMock.mockResolvedValue([]);
    needsImpactBootstrapMock.mockResolvedValue(false);
    rebuildOrgImpactRangeMock.mockResolvedValue({ orgId: ORG_A, fromDay: '2026-06-11', toDay: '2026-06-17', days: 7 });

    delete process.env.BREEZE_AI_AGENTS_ENABLED;
    await shutdownAiAgentImpactRollupWorker();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.BREEZE_AI_AGENTS_ENABLED;
  });

  describe('buildImpactRollupJobId', () => {
    it('is deterministic and colon-delimited', () => {
      expect(buildImpactRollupJobId(ORG_A, '2026-06-11', '2026-06-17')).toBe(
        `impact:${ORG_A}:2026-06-11:2026-06-17`,
      );
    });
  });

  describe('processImpactScan — producer gate', () => {
    it('returns zeros and never queries when BREEZE_AI_AGENTS_ENABLED is unset', async () => {
      delete process.env.BREEZE_AI_AGENTS_ENABLED;

      const result = await processImpactScan();

      expect(result).toEqual({ scanned: 0, enqueued: 0 });
      expect(findImpactSourceOrgIdsMock).not.toHaveBeenCalled();
      expect(addBulkMock).not.toHaveBeenCalled();
    });

    it('reads the flag at CALL time — the same imported function proceeds once the env var flips', async () => {
      delete process.env.BREEZE_AI_AGENTS_ENABLED;
      findImpactSourceOrgIdsMock.mockResolvedValue([]);

      const before = await processImpactScan();
      expect(before).toEqual({ scanned: 0, enqueued: 0 });
      expect(findImpactSourceOrgIdsMock).not.toHaveBeenCalled();

      process.env.BREEZE_AI_AGENTS_ENABLED = 'true';
      const after = await processImpactScan();

      expect(after).toEqual({ scanned: 0, enqueued: 0 });
      expect(findImpactSourceOrgIdsMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('processImpactScan — per-org bootstrap vs. nightly window', () => {
    beforeEach(() => {
      process.env.BREEZE_AI_AGENTS_ENABLED = 'true';
    });

    it('gives an already-bootstrapped org the 7-day nightly window and a bootstrap org the 90-day window, in ONE scan', async () => {
      // through = last complete UTC day for 2026-06-18T12:00:00Z = 2026-06-17
      findImpactSourceOrgIdsMock.mockResolvedValue([ORG_A, ORG_B]);
      needsImpactBootstrapMock.mockImplementation(async (orgId: string) => orgId === ORG_B);

      const result = await processImpactScan();

      expect(result).toEqual({ scanned: 2, enqueued: 2 });
      expect(findImpactSourceOrgIdsMock).toHaveBeenCalledWith('2026-06-11', '2026-06-17');
      expect(needsImpactBootstrapMock).toHaveBeenCalledWith(ORG_A, '2026-06-17');
      expect(needsImpactBootstrapMock).toHaveBeenCalledWith(ORG_B, '2026-06-17');

      expect(addBulkMock).toHaveBeenCalledTimes(1);
      const jobs = addBulkMock.mock.calls[0]![0] as Array<{ data: { orgId: string; fromDay: string; toDay: string }; opts: { jobId: string } }>;

      const jobA = jobs.find((j) => j.data.orgId === ORG_A);
      const jobB = jobs.find((j) => j.data.orgId === ORG_B);

      expect(jobA?.data).toMatchObject({ orgId: ORG_A, fromDay: '2026-06-11', toDay: '2026-06-17' });
      expect(jobB?.data).toMatchObject({ orgId: ORG_B, fromDay: '2026-03-20', toDay: '2026-06-17' });

      expect(jobA?.opts.jobId).toBe(buildImpactRollupJobId(ORG_A, '2026-06-11', '2026-06-17'));
      expect(jobB?.opts.jobId).toBe(buildImpactRollupJobId(ORG_B, '2026-03-20', '2026-06-17'));
      expect(jobA?.opts.jobId).not.toBe(jobB?.opts.jobId);
    });

    it('uses IMPACT_NIGHTLY_TRAILING_DAYS = 7 for the nightly window', () => {
      expect(IMPACT_NIGHTLY_TRAILING_DAYS).toBe(7);
    });
  });

  describe('enqueueImpactRollupForOrgs', () => {
    it('adds one deterministic job per org id and returns the count', async () => {
      const count = await enqueueImpactRollupForOrgs([ORG_A, ORG_B], '2026-06-01', '2026-06-17');

      expect(count).toBe(2);
      expect(addBulkMock).toHaveBeenCalledTimes(1);
      const jobs = addBulkMock.mock.calls[0]![0] as Array<{ data: { orgId: string }; opts: { jobId: string } }>;
      expect(jobs).toHaveLength(2);
      expect(jobs.find((j) => j.data.orgId === ORG_A)?.opts.jobId).toBe(
        buildImpactRollupJobId(ORG_A, '2026-06-01', '2026-06-17'),
      );
      expect(jobs.find((j) => j.data.orgId === ORG_B)?.opts.jobId).toBe(
        buildImpactRollupJobId(ORG_B, '2026-06-01', '2026-06-17'),
      );
    });

    it('returns 0 and never calls addBulk for an empty org list', async () => {
      const count = await enqueueImpactRollupForOrgs([], '2026-06-01', '2026-06-17');

      expect(count).toBe(0);
      expect(addBulkMock).not.toHaveBeenCalled();
    });
  });

  describe('worker dispatch', () => {
    it('dispatches a scan job to processImpactScan', async () => {
      process.env.BREEZE_AI_AGENTS_ENABLED = 'true';
      findImpactSourceOrgIdsMock.mockResolvedValue([]);

      createAiAgentImpactRollupWorker();
      expect(capturedWorkerProcessor.current).toBeTruthy();

      const result = await capturedWorkerProcessor.current!({ data: { type: 'scan' } });

      expect(result).toEqual({ scanned: 0, enqueued: 0 });
      expect(findImpactSourceOrgIdsMock).toHaveBeenCalledTimes(1);
    });

    it('dispatches a rebuild-org-range job to rebuildOrgImpactRange with the job\'s exact (orgId, fromDay, toDay), outside any DB context', async () => {
      createAiAgentImpactRollupWorker();
      runOutsideDbContextMock.mockClear();

      await capturedWorkerProcessor.current!({
        data: { type: 'rebuild-org-range', orgId: ORG_A, fromDay: '2026-06-01', toDay: '2026-06-17', queuedAt: '2026-06-18T12:00:00.000Z' },
      });

      expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
      expect(rebuildOrgImpactRangeMock).toHaveBeenCalledWith(ORG_A, '2026-06-01', '2026-06-17');
    });
  });

  describe('initializeAiAgentImpactRollupWorker', () => {
    it('attaches observability, removes any pre-existing scan repeatable by key, and registers the registry-allocated pattern', async () => {
      getRepeatableJobsMock.mockResolvedValue([
        { name: 'scan', key: 'stale-scan-key' },
        { name: 'other-job', key: 'unrelated-key' },
      ]);

      await initializeAiAgentImpactRollupWorker();

      expect(attachWorkerObservabilityMock).toHaveBeenCalledWith(expect.anything(), expect.any(String));

      expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('stale-scan-key');
      expect(removeRepeatableByKeyMock).not.toHaveBeenCalledWith('unrelated-key');

      expect(addMock).toHaveBeenCalledWith(
        'scan',
        expect.objectContaining({ type: 'scan' }),
        expect.objectContaining({
          jobId: 'ai-agent-impact-rollup-scan',
          repeat: { pattern: jobSchedule('ai-agent-impact-rollup') },
        }),
      );
    });
  });

  describe('getAiAgentImpactRollupQueue', () => {
    it('uses the exported queue name', () => {
      getAiAgentImpactRollupQueue();
      expect(AI_AGENT_IMPACT_ROLLUP_QUEUE).toBe('ai-agent-impact-rollup');
    });
  });
});
