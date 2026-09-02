import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  queueCloseMock,
  workerCloseMock,
  withSystemDbAccessContextMock,
  dbExecuteMock,
  attachWorkerObservabilityMock,
  recordRetentionRunMock,
  capturedWorkerProcessor,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  dbExecuteMock: vi.fn(),
  attachWorkerObservabilityMock: vi.fn(),
  recordRetentionRunMock: vi.fn(),
  capturedWorkerProcessor: { current: null as null | ((job: { data: Record<string, unknown> }) => Promise<unknown>) },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = (...args: unknown[]) => addMock(...(args as []));
    getRepeatableJobs = () => getRepeatableJobsMock();
    removeRepeatableByKey = (...args: unknown[]) => removeRepeatableByKeyMock(...(args as []));
    close = () => queueCloseMock();
  },
  Worker: class {
    constructor(_name: string, processor: (job: { data: Record<string, unknown> }) => Promise<unknown>) {
      capturedWorkerProcessor.current = processor;
    }
    on = vi.fn();
    close = () => workerCloseMock();
  },
  Job: class {},
}));

vi.mock('../db', () => ({
  db: {
    execute: (...args: unknown[]) => dbExecuteMock(...(args as [])),
  },
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => withSystemDbAccessContextMock(fn),
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: (...args: unknown[]) => attachWorkerObservabilityMock(...(args as [])),
}));

vi.mock('../services/retentionMetrics', () => ({
  recordRetentionRun: (...args: unknown[]) => recordRetentionRunMock(...(args as [])),
}));

import {
  AI_AGENT_GRADUATION_JOB_NAME,
  AI_AGENT_GRADUATION_QUEUE,
  initializeAiAgentGraduationWorker,
  pruneOpEvidence,
  shutdownAiAgentGraduationWorker,
} from './aiAgentGraduationWorker';

describe('AI agent graduation worker — evidence retention (P2-5 Task 9, #4192)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    getRepeatableJobsMock.mockResolvedValue([]);
    removeRepeatableByKeyMock.mockResolvedValue(undefined);
    addMock.mockResolvedValue(undefined);
    queueCloseMock.mockResolvedValue(undefined);
    workerCloseMock.mockResolvedValue(undefined);
    dbExecuteMock.mockResolvedValue({ rowCount: 0 });
    capturedWorkerProcessor.current = null;
  });

  afterEach(async () => {
    await shutdownAiAgentGraduationWorker();
  });

  it('names the queue and job "ai-agent-graduation"', () => {
    expect(AI_AGENT_GRADUATION_QUEUE).toBe('ai-agent-graduation');
    expect(AI_AGENT_GRADUATION_JOB_NAME).toBe('ai-agent-graduation');
  });

  it('registers a repeatable prune-evidence job at the scheduleRegistry-allocated daily slot', async () => {
    await initializeAiAgentGraduationWorker();

    expect(attachWorkerObservabilityMock).toHaveBeenCalledWith(expect.anything(), 'aiAgentGraduation');
    expect(addMock).toHaveBeenCalledWith(
      'ai-agent-graduation',
      { task: 'prune-evidence' },
      expect.objectContaining({
        jobId: 'ai-agent-op-evidence-retention',
        repeat: { pattern: '48 18 * * *' },
      }),
    );
  });

  it('clears any stale repeatable jobs before registering the current one', async () => {
    getRepeatableJobsMock.mockResolvedValue([{ key: 'stale-key-1' }, { key: 'stale-key-2' }]);
    await initializeAiAgentGraduationWorker();
    expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('stale-key-1');
    expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('stale-key-2');
  });

  it('pruneOpEvidence deletes rows older than a 400-day cutoff, passed as an ISO string param', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rowCount: 7 });
    const before = Date.now();

    const result = await pruneOpEvidence();

    expect(dbExecuteMock).toHaveBeenCalledTimes(1);
    const queryChunks = (dbExecuteMock.mock.calls[0]![0] as { queryChunks: unknown[] }).queryChunks;
    const sqlCall = JSON.stringify(dbExecuteMock.mock.calls[0]);
    expect(sqlCall).toContain('DELETE FROM ai_agent_op_evidence');
    expect(sqlCall).toContain('occurred_at <');
    expect(sqlCall).toContain('::timestamptz');

    // The single interpolated param is the ISO-string cutoff, not a Date
    // instance — postgres-js does not coerce Date in template params.
    const cutoffParam = queryChunks.find((c) => typeof c === 'string') as string | undefined;
    expect(typeof cutoffParam).toBe('string');
    expect(new Date(cutoffParam as string).toISOString()).toBe(cutoffParam);

    const cutoffMs = new Date(cutoffParam as string).getTime();
    const expectedCutoffMs = before - 400 * 24 * 60 * 60 * 1000;
    // Allow a small window for test execution time.
    expect(Math.abs(cutoffMs - expectedCutoffMs)).toBeLessThan(5000);

    expect(result).toEqual({ deletedCount: 7, durationMs: expect.any(Number) });
  });

  it('pruneOpEvidence reports zero rows deleted without throwing when nothing is due', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rowCount: 0 });
    const result = await pruneOpEvidence();
    expect(result.deletedCount).toBe(0);
  });

  it('runs the prune-evidence task inside system DB context when dispatched via the worker processor', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rowCount: 3 });
    await initializeAiAgentGraduationWorker();

    const result = await capturedWorkerProcessor.current!({ data: { task: 'prune-evidence' } });

    expect(withSystemDbAccessContextMock).toHaveBeenCalled();
    expect(result).toEqual({ deletedCount: 3, durationMs: expect.any(Number) });
  });

  it('records a retention-metrics run after each prune', async () => {
    dbExecuteMock.mockResolvedValueOnce({ rowCount: 5 });
    await pruneOpEvidence();
    expect(recordRetentionRunMock).toHaveBeenCalledWith('ai_agent_op_evidence_retention', { rowsDeleted: 5 });
  });
});
