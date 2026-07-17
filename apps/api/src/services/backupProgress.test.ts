import { beforeEach, describe, expect, it, vi } from 'vitest';

const refreshDispatchedExpectationMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  backupJobs: {
    id: 'backupJobs.id',
    deviceId: 'backupJobs.deviceId',
    status: 'backupJobs.status',
    transferredSize: 'backupJobs.transferredSize',
    totalSize: 'backupJobs.totalSize',
    fileCount: 'backupJobs.fileCount',
    totalFiles: 'backupJobs.totalFiles',
    lastProgressAt: 'backupJobs.lastProgressAt',
    updatedAt: 'backupJobs.updatedAt',
  },
  devices: {
    id: 'devices.id',
    agentId: 'devices.agentId',
  },
}));

vi.mock('./agentWorkExpectation', () => ({
  refreshDispatchedExpectation: (...args: unknown[]) =>
    refreshDispatchedExpectationMock(...(args as [])),
}));

import { db } from '../db';
import {
  applyBackupProgress,
  applyBackupStartedAck,
  isBackupStartedAck,
  isLegacyBackupTimeoutResult,
  tryParseBackupResultPayload,
} from './backupProgress';

function selectChain(rows: unknown[]) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'innerJoin', 'where', 'limit']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain;
}

function updateChain(rows: unknown[]) {
  const chain: Record<string, any> = {};
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  return chain;
}

describe('applyBackupProgress', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    refreshDispatchedExpectationMock.mockResolvedValue(true);
  });

  it('applies progress fields for a running job with the owning agent', async () => {
    vi.mocked(db.select).mockReturnValue(
      selectChain([
        { id: 'job-1', deviceId: 'device-1', agentId: 'agent-1', status: 'running' },
      ]) as any
    );
    vi.mocked(db.update).mockReturnValue(
      updateChain([{ id: 'job-1' }]) as any
    );

    const result = await applyBackupProgress({
      agentId: 'agent-1',
      commandId: 'job-1',
      progress: { phase: 'uploading', current: 1000, total: 5000, filesDone: 2, filesTotal: 10 },
    });

    expect(result).toEqual({ applied: true });
    const updateCall = vi.mocked(db.update).mock.results[0].value;
    expect(updateCall.set).toHaveBeenCalledWith(
      expect.objectContaining({
        transferredSize: 1000,
        totalSize: 5000,
        fileCount: 2,
        totalFiles: 10,
        lastProgressAt: expect.any(Date),
        updatedAt: expect.any(Date),
      })
    );
    expect(refreshDispatchedExpectationMock).toHaveBeenCalledWith('backup', 'device-1', 'job-1');
  });

  it('rejects a progress message from a non-owning agent', async () => {
    vi.mocked(db.select).mockReturnValue(
      selectChain([
        { id: 'job-1', deviceId: 'device-1', agentId: 'agent-1', status: 'running' },
      ]) as any
    );

    const result = await applyBackupProgress({
      agentId: 'agent-evil',
      commandId: 'job-1',
      progress: { current: 100, total: 200 },
    });

    expect(result).toEqual({ applied: false, reason: 'agent-mismatch' });
    expect(db.update).not.toHaveBeenCalled();
    expect(refreshDispatchedExpectationMock).not.toHaveBeenCalled();
  });

  it('does not apply progress for a job already in a terminal status', async () => {
    vi.mocked(db.select).mockReturnValue(
      selectChain([
        { id: 'job-1', deviceId: 'device-1', agentId: 'agent-1', status: 'completed' },
      ]) as any
    );

    const result = await applyBackupProgress({
      agentId: 'agent-1',
      commandId: 'job-1',
      progress: { current: 100, total: 200 },
    });

    expect(result).toEqual({ applied: false, reason: 'terminal-status' });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('does not clobber an existing totalSize when total is 0', async () => {
    vi.mocked(db.select).mockReturnValue(
      selectChain([
        { id: 'job-1', deviceId: 'device-1', agentId: 'agent-1', status: 'running' },
      ]) as any
    );
    vi.mocked(db.update).mockReturnValue(
      updateChain([{ id: 'job-1' }]) as any
    );

    await applyBackupProgress({
      agentId: 'agent-1',
      commandId: 'job-1',
      progress: { current: 1000, total: 0, filesDone: 2, filesTotal: 10 },
    });

    const updateCall = vi.mocked(db.update).mock.results[0].value;
    const setArg = updateCall.set.mock.calls[0][0];
    expect(setArg).not.toHaveProperty('totalSize');
    expect(setArg.transferredSize).toBe(1000);
  });

  it('returns not-found when no backup job matches the commandId', async () => {
    vi.mocked(db.select).mockReturnValue(selectChain([]) as any);

    const result = await applyBackupProgress({
      agentId: 'agent-1',
      commandId: 'nonexistent',
      progress: { current: 100 },
    });

    expect(result).toEqual({ applied: false, reason: 'not-found' });
  });

  it('drops an invalid progress payload without throwing', async () => {
    const result = await applyBackupProgress({
      agentId: 'agent-1',
      commandId: 'job-1',
      progress: { current: 'not-a-number' as unknown as number },
    });

    expect(result).toEqual({ applied: false, reason: 'invalid-payload' });
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('tryParseBackupResultPayload', () => {
  it('parses a JSON string in result.result', () => {
    expect(tryParseBackupResultPayload('{"started":true}', undefined)).toEqual({ started: true });
  });

  it('falls back to result.stdout when result.result is absent', () => {
    expect(tryParseBackupResultPayload(undefined, '{"started":true}')).toEqual({ started: true });
  });

  it('returns undefined (no throw) on malformed JSON', () => {
    expect(tryParseBackupResultPayload('not-json{', undefined)).toBeUndefined();
  });

  it('passes through a non-string payload unchanged', () => {
    expect(tryParseBackupResultPayload({ started: true }, undefined)).toEqual({ started: true });
  });
});

describe('isBackupStartedAck', () => {
  it('recognizes a plain started-ack payload', () => {
    expect(isBackupStartedAck({ started: true })).toBe(true);
  });

  it('rejects a terminal completion payload', () => {
    expect(isBackupStartedAck({ snapshotId: 'snap-1', filesBackedUp: 10 })).toBe(false);
  });

  it('rejects non-object payloads', () => {
    expect(isBackupStartedAck(undefined)).toBe(false);
    expect(isBackupStartedAck('started')).toBe(false);
    expect(isBackupStartedAck(null)).toBe(false);
  });
});

describe('isLegacyBackupTimeoutResult', () => {
  it('recognizes the legacy 10-minute forwardToBackupHelper timeout', () => {
    expect(
      isLegacyBackupTimeoutResult({ status: 'failed', error: 'command timed out after 10m0s' })
    ).toBe(true);
  });

  it('checks stderr when error is absent', () => {
    expect(
      isLegacyBackupTimeoutResult({ status: 'timeout', stderr: 'Command timed out' })
    ).toBe(true);
  });

  it('does not match a completed result', () => {
    expect(
      isLegacyBackupTimeoutResult({ status: 'completed', error: 'command timed out' })
    ).toBe(false);
  });

  it('does not match a genuine (non-timeout) failure', () => {
    expect(
      isLegacyBackupTimeoutResult({ status: 'failed', error: 'disk full' })
    ).toBe(false);
  });
});

describe('applyBackupStartedAck', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    refreshDispatchedExpectationMock.mockResolvedValue(true);
  });

  it('sets lastProgressAt/updatedAt on an in-flight job and refreshes the expectation', async () => {
    vi.mocked(db.update).mockReturnValue(updateChain([{ id: 'job-1' }]) as any);

    const result = await applyBackupStartedAck({ jobId: 'job-1', deviceId: 'device-1' });

    expect(result).toBe(true);
    const updateCall = vi.mocked(db.update).mock.results[0].value;
    expect(updateCall.set).toHaveBeenCalledWith(
      expect.objectContaining({ lastProgressAt: expect.any(Date), updatedAt: expect.any(Date) })
    );
    expect(refreshDispatchedExpectationMock).toHaveBeenCalledWith('backup', 'device-1', 'job-1');
  });

  it('does not refresh the expectation when the job is no longer in flight', async () => {
    vi.mocked(db.update).mockReturnValue(updateChain([]) as any);

    const result = await applyBackupStartedAck({ jobId: 'job-1', deviceId: 'device-1' });

    expect(result).toBe(false);
    expect(refreshDispatchedExpectationMock).not.toHaveBeenCalled();
  });
});
