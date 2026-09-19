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
    startedAt: 'backupJobs.startedAt',
    updatedAt: 'backupJobs.updatedAt',
  },
  devices: {
    id: 'devices.id',
    agentId: 'devices.agentId',
  },
  IN_FLIGHT_BACKUP_JOB_STATUSES: ['pending', 'running'] as const,
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
  isBackupQueuedAck,
  isLegacyBackupTimeoutResult,
  tryParseBackupResultPayload,
} from './backupProgress';

// applyBackupProgress now UUID-gates commandId before any DB access, so test
// commandIds must be real UUIDs (the job rows they resolve to can keep the
// readable 'job-1' ids — only the commandId itself is gated).
const JOB_UUID = '2c9e6679-7425-40de-944b-e07fc1f90ae7';
const NOT_FOUND_UUID = '3d0f7780-8536-41ef-a55c-f18fd2fa1bf8';

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
      commandId: JOB_UUID,
      progress: { phase: 'uploading', current: 1000, total: 5000, filesDone: 2, filesTotal: 10 },
    });

    expect(result).toEqual({ applied: true });
    const updateCall = vi.mocked(db.update).mock.results[0]!.value;
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
      commandId: JOB_UUID,
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
      commandId: JOB_UUID,
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
      commandId: JOB_UUID,
      progress: { current: 1000, total: 0, filesDone: 2, filesTotal: 10 },
    });

    const updateCall = vi.mocked(db.update).mock.results[0]!.value;
    const setArg = updateCall.set.mock.calls[0][0];
    expect(setArg).not.toHaveProperty('totalSize');
    expect(setArg.transferredSize).toBe(1000);
  });

  // #3006: registering the snapshot id mid-run is what makes an orphaned
  // snapshot structurally impossible — without it, a terminal result lost in
  // transit leaves the uploaded objects with nothing linking them to a job.
  it('persists the snapshot id reported mid-run', async () => {
    vi.mocked(db.select).mockReturnValue(
      selectChain([
        { id: 'job-1', deviceId: 'device-1', agentId: 'agent-1', status: 'running' },
      ]) as any
    );
    vi.mocked(db.update).mockReturnValue(updateChain([{ id: 'job-1' }]) as any);

    const result = await applyBackupProgress({
      agentId: 'agent-1',
      commandId: JOB_UUID,
      progress: {
        phase: 'uploading',
        current: 0,
        total: 5000,
        snapshotId: 'snapshot-20260801T101500Z-a1b2c3d4',
      },
    });

    expect(result).toEqual({ applied: true });
    const updateCall = vi.mocked(db.update).mock.results[0]!.value;
    expect(updateCall.set).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: 'snapshot-20260801T101500Z-a1b2c3d4' })
    );
  });

  it('leaves snapshotId untouched on the pre-snapshot keepalive frames', async () => {
    vi.mocked(db.select).mockReturnValue(
      selectChain([
        { id: 'job-1', deviceId: 'device-1', agentId: 'agent-1', status: 'running' },
      ]) as any
    );
    vi.mocked(db.update).mockReturnValue(updateChain([{ id: 'job-1' }]) as any);

    // The agent's whole-run keepalive fires before any snapshot exists and
    // omits snapshotId entirely; writing '' there would record a snapshot id
    // for objects that were never uploaded.
    await applyBackupProgress({
      agentId: 'agent-1',
      commandId: JOB_UUID,
      progress: { phase: 'uploading', current: 0, total: 0 },
    });

    const updateCall = vi.mocked(db.update).mock.results[0]!.value;
    expect(updateCall.set.mock.calls[0][0]).not.toHaveProperty('snapshotId');
  });

  it('drops only the unusable snapshotId, never the counters that keep the job alive', async () => {
    // backup_jobs.snapshot_id is varchar(200). An over-long value must not take
    // the whole payload down with it: losing the payload also loses
    // lastProgressAt (so the stale reaper kills a healthy in-flight upload) and
    // the dispatch-expectation refresh (so the real terminal result is later
    // dropped as a replay) — i.e. it would reproduce #3006 fleet-wide via the
    // very field added to prevent it. The id is best-effort recovery metadata;
    // the counters are load-bearing.
    vi.mocked(db.select).mockReturnValue(
      selectChain([
        { id: 'job-1', deviceId: 'device-1', agentId: 'agent-1', status: 'running' },
      ]) as any
    );
    vi.mocked(db.update).mockReturnValue(updateChain([{ id: 'job-1' }]) as any);

    const result = await applyBackupProgress({
      agentId: 'agent-1',
      commandId: JOB_UUID,
      progress: { current: 1000, total: 5000, snapshotId: 'x'.repeat(201) },
    });

    expect(result).toEqual({ applied: true, snapshotIdDropped: true });
    const updateCall = vi.mocked(db.update).mock.results[0]!.value;
    const setArg = updateCall.set.mock.calls[0][0];
    expect(setArg).not.toHaveProperty('snapshotId');
    expect(setArg.transferredSize).toBe(1000);
    expect(setArg.lastProgressAt).toBeInstanceOf(Date);
    expect(refreshDispatchedExpectationMock).toHaveBeenCalledWith('backup', 'device-1', 'job-1');
  });

  it('still drops a payload whose load-bearing fields are malformed', async () => {
    const result = await applyBackupProgress({
      agentId: 'agent-1',
      commandId: JOB_UUID,
      progress: { current: 'not-a-number' as unknown as number, snapshotId: 'snapshot-1' },
    });

    expect(result).toEqual({ applied: false, reason: 'invalid-payload' });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns not-found when no backup job matches the commandId', async () => {
    vi.mocked(db.select).mockReturnValue(selectChain([]) as any);

    const result = await applyBackupProgress({
      agentId: 'agent-1',
      commandId: NOT_FOUND_UUID,
      progress: { current: 100 },
    });

    expect(result).toEqual({ applied: false, reason: 'not-found' });
  });

  it('drops a non-UUID commandId before any DB access (restore progress / garbage ids)', async () => {
    const result = await applyBackupProgress({
      agentId: 'agent-1',
      commandId: 'not-a-uuid',
      progress: { current: 100, total: 200 },
    });

    expect(result).toEqual({ applied: false, reason: 'invalid-command-id' });
    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(refreshDispatchedExpectationMock).not.toHaveBeenCalled();
  });

  it('drops an invalid progress payload without throwing', async () => {
    const result = await applyBackupProgress({
      agentId: 'agent-1',
      commandId: JOB_UUID,
      progress: { current: 'not-a-number' as unknown as number },
    });

    expect(result).toEqual({ applied: false, reason: 'invalid-payload' });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('drops progress on a concurrent terminal transition between select and the guarded update', async () => {
    // The row is `running` at select time, but the guarded UPDATE (which carries
    // inArray(status, IN_FLIGHT)) matches zero rows because the job transitioned
    // to a terminal status in between. Dropping the `inArray` guard from the
    // UPDATE would let this write through and make this test fail.
    vi.mocked(db.select).mockReturnValue(
      selectChain([
        { id: 'job-1', deviceId: 'device-1', agentId: 'agent-1', status: 'running' },
      ]) as any
    );
    vi.mocked(db.update).mockReturnValue(updateChain([]) as any);

    const result = await applyBackupProgress({
      agentId: 'agent-1',
      commandId: JOB_UUID,
      progress: { current: 100, total: 200 },
    });

    expect(result).toEqual({ applied: false, reason: 'terminal-status' });
    expect(refreshDispatchedExpectationMock).not.toHaveBeenCalled();
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
    const updateCall = vi.mocked(db.update).mock.results[0]!.value;
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


describe('queued backup lifecycle', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('recognizes queued acknowledgements without treating terminal data as admission', () => {
    expect(isBackupQueuedAck({ queued: true })).toBe(true);
    for (const payload of [null, [], 'queued', { queued: false }, { started: true }, { status: 'completed' }]) {
      expect(isBackupQueuedAck(payload)).toBe(false);
    }
  });

  it.each(['queued', 'starting', 'uploading', 'scanning', undefined])('guards %s lifecycle updates by owning agent and in-flight state', async (phase) => {
    vi.mocked(db.select).mockReturnValue(selectChain([{ id: JOB_UUID, deviceId: 'device-1', agentId: 'agent-1', status: 'pending' }]) as any);
    const update = updateChain([{ id: JOB_UUID }]);
    vi.mocked(db.update).mockReturnValue(update as any);
    await applyBackupProgress({ agentId: 'agent-1', commandId: JOB_UUID, progress: { phase } });
    const changes = update.set.mock.calls[0][0];
    expect(changes.lastProgressAt).toBeInstanceOf(Date);
    // The database evaluates these guards atomically against the latest row,
    // not the SELECT snapshot: late queued messages cannot demote starting.
    const startedAt = JSON.stringify(changes.startedAt);
    expect(startedAt).toContain('lastProgressAt');
    expect(startedAt).toContain('IS NULL');
    expect(startedAt).toContain('ELSE');
    if (phase !== 'queued') {
      expect(changes.status).toBe('running');
      expect(startedAt).toContain("= 'pending'");
    } else {
      expect(JSON.stringify(changes.status)).toContain("'pending'::backup_status ELSE");
    }
    expect(JSON.stringify(update.where.mock.calls[0][0])).toContain('running');
    expect(refreshDispatchedExpectationMock).toHaveBeenCalledWith('backup', 'device-1', JOB_UUID);
  });

  it('does not apply queued/starting signals from a different device agent', async () => {
    vi.mocked(db.select).mockReturnValue(selectChain([{ id: JOB_UUID, agentId: 'owner', status: 'pending' }]) as any);
    for (const phase of ['queued', 'starting']) {
      expect(await applyBackupProgress({ agentId: 'other', commandId: JOB_UUID, progress: { phase } }))
        .toEqual({ applied: false, reason: 'agent-mismatch' });
    }
    expect(db.update).not.toHaveBeenCalled();
  });

  it('queued ack preserves an already-started row through an atomic first-signal guard', async () => {
    const update = updateChain([{ id: JOB_UUID }]);
    vi.mocked(db.update).mockReturnValue(update as any);
    await applyBackupStartedAck({ jobId: JOB_UUID, deviceId: 'device-1', queued: true });
    expect(JSON.stringify(update.set.mock.calls[0][0].status)).toContain('IS NULL');
    expect(JSON.stringify(update.set.mock.calls[0][0].startedAt)).toContain('ELSE');
    expect(refreshDispatchedExpectationMock).toHaveBeenCalledWith('backup', 'device-1', JOB_UUID);
  });
});
