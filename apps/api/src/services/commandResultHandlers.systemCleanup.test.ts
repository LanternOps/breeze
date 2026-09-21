import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock, updateMock, writeAuditEventMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  writeAuditEventMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: selectMock, update: updateMock },
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));

vi.mock('./auditEvents', () => ({
  writeAuditEvent: writeAuditEventMock,
  requestLikeFromSnapshot: () => ({ req: { header: () => undefined } }),
  ANONYMOUS_ACTOR_ID: '00000000-0000-0000-0000-000000000000',
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { commandResultHandlers, handleSystemCleanupRunResult } from './commandResultHandlers';

const RUN_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';

const runRow = {
  id: RUN_ID, deviceId: DEVICE_ID, orgId: 'org-1', requestedBy: 'user-1', status: 'running',
};

function params(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'agent-1',
    command: { id: 'cmd-1', deviceId: DEVICE_ID, type: 'system_cleanup_run', payload: { runId: RUN_ID } },
    commandId: 'cmd-1',
    result: { status: 'completed', exitCode: 0 },
    resolvedDeviceId: DEVICE_ID,
    stdout: JSON.stringify({
      runId: RUN_ID,
      actions: [
        { id: 'linux_pkg_cache_clean', status: 'completed', exitCode: 0, durationMs: 800 },
        { id: 'linux_journal_vacuum', status: 'failed', exitCode: 1, durationMs: 40, error: 'permission denied' },
      ],
      volumes: [{ mount: '/', freeBefore: 1_000, freeAfter: 4_000 }],
      freedBytes: 3_000,
    }),
    ...overrides,
  } as never;
}

let setSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  selectMock.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([runRow]) }) }) });
  setSpy = vi.fn((_fields: Record<string, unknown>) => ({ where: () => Object.assign(Promise.resolve([{ id: RUN_ID }]), { returning: async () => [{ id: RUN_ID }] }) }));
  updateMock.mockReturnValue({ set: setSpy });
});

describe('handleSystemCleanupRunResult (spec §5.3)', () => {
  it('registers the handler for WebSocket dispatch', () => {
    expect(commandResultHandlers.system_cleanup_run).toBeTypeOf('function');
    expect(commandResultHandlers.system_cleanup_run).toBe(handleSystemCleanupRunResult);
  });

  it('records executed when at least one action succeeded, with the MEASURED bytes', async () => {
    await handleSystemCleanupRunResult(params());
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({
      status: 'executed',
      bytesReclaimed: 3_000,
      approvedAt: expect.any(Date),
    }));
    const written = setSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.executedActions).toMatchObject({ freedBytes: 3_000 });
  });

  it('records failed when EVERY action failed', async () => {
    await handleSystemCleanupRunResult(params({
      stdout: JSON.stringify({
        runId: RUN_ID,
        actions: [{ id: 'linux_pkg_cache_clean', status: 'failed', exitCode: 1, durationMs: 5, error: 'boom' }],
        volumes: [], freedBytes: 0,
      }),
    }));
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  // "unavailable" is not success: the tech asked for something the device
  // could not do, and reporting `executed` would claim work that never ran.
  it('records failed when every action was unavailable', async () => {
    await handleSystemCleanupRunResult(params({
      stdout: JSON.stringify({
        runId: RUN_ID,
        actions: [{ id: 'mac_brew_cleanup', status: 'unavailable', exitCode: 1, error: 'Homebrew is not installed' }],
        volumes: [], freedBytes: 0,
      }),
    }));
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('writes the measured-bytes audit with per-action status', async () => {
    await handleSystemCleanupRunResult(params());
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'device.filesystem.system_cleanup.run',
      orgId: 'org-1',
      resourceType: 'device',
      resourceId: DEVICE_ID,
      actorId: 'user-1',
      details: expect.objectContaining({
        cleanupRunId: RUN_ID,
        bytesReclaimed: 3_000,
        actions: [
          { id: 'linux_pkg_cache_clean', status: 'completed' },
          { id: 'linux_journal_vacuum', status: 'failed' },
        ],
      }),
    }));
  });

  it('preserves late evidence and audits late_result when timeout wins the finish CAS', async () => {
    const conditions: SQL[] = [];
    setSpy.mockImplementationOnce(() => ({ where: (condition: SQL) => {
      conditions.push(condition);
      return Object.assign(Promise.resolve([]), { returning: async () => [] });
    } }));
    setSpy.mockImplementationOnce(() => ({ where: (condition: SQL) => {
      conditions.push(condition);
      return Object.assign(Promise.resolve([{ id: RUN_ID }]), { returning: async () => [{ id: RUN_ID }] });
    } }));
    await handleSystemCleanupRunResult(params());
    expect(setSpy).toHaveBeenCalledTimes(2);
    const late = setSpy.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(late.status).toBeUndefined();
    // Same shape as the already-terminal branch: evidence nested under
    // `lateResult`, the run's own `bytesReclaimed`/`actions` untouched, so the
    // poll projection cannot show a timed-out run as if it had succeeded.
    expect(late.bytesReclaimed).toBeUndefined();
    const lateSql = new PgDialect().sqlToQuery(late.executedActions as SQL);
    expect(lateSql.sql).toContain("jsonb_set");
    expect(lateSql.sql).toContain("{lateResult}");
    expect(lateSql.params.some((param) => typeof param === 'string' && param.includes('"freedBytes":3000'))).toBe(true);
    expect(new PgDialect().sqlToQuery(conditions[1]!).sql).toContain('<>');
    expect(writeAuditEventMock).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
      action: 'device.filesystem.system_cleanup.late_result',
    }));
  });

  it('marks the run failed when the agent reports a non-completed command', async () => {
    await handleSystemCleanupRunResult(params({
      result: { status: 'timeout', exitCode: 1, error: 'command timed out' },
      stdout: undefined,
    }));
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', error: 'command timed out' }));
  });

  it('marks the run failed — never executed — when the payload is unreadable', async () => {
    await handleSystemCleanupRunResult(params({ stdout: 'not json' }));
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    const written = setSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.bytesReclaimed).toBeUndefined();
  });

  it('records the agent-update case with a recognisable error', async () => {
    await handleSystemCleanupRunResult(params({
      result: { status: 'failed', exitCode: 1, error: 'unknown command type: system_cleanup_run' },
      stdout: undefined,
    }));
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed', error: 'agent_update_required',
    }));
  });

  // Replays and a result whose runId does not match the payload must be inert.
  it('is a no-op when the payload carries no runId', async () => {
    await handleSystemCleanupRunResult(params({
      command: { id: 'cmd-1', deviceId: DEVICE_ID, type: 'system_cleanup_run', payload: {} },
    }));
    expect(updateMock).not.toHaveBeenCalled();
  });

  // Spec §13 #13: a late result is RECORDED, not applied. Flipping a failed
  // row back to executed would contradict what the operator was told; dropping
  // it would erase the only evidence that the work actually happened.
  it('records a result for a finalised run as lateResult without flipping its status', async () => {
    selectMock.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ ...runRow, status: 'failed' }]) }) }) });
    await handleSystemCleanupRunResult(params());

    expect(setSpy).toHaveBeenCalledTimes(1);
    const written = setSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.status).toBeUndefined();
    expect(written.bytesReclaimed).toBeUndefined();
    expect(JSON.stringify(new PgDialect().sqlToQuery(written.executedActions as SQL))).toContain('lateResult');
    // The audit belongs to the run that completed, not to one already closed.
    expect(writeAuditEventMock).not.toHaveBeenCalled();
  });

  it('records an UNREADABLE late result too, flagged', async () => {
    selectMock.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ ...runRow, status: 'executed' }]) }) }) });
    await handleSystemCleanupRunResult(params({ stdout: 'not json' }));
    const written = setSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(JSON.stringify(new PgDialect().sqlToQuery(written.executedActions as SQL))).toContain('unreadable');
  });

  it('is a no-op when the run belongs to another device', async () => {
    selectMock.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) });
    await handleSystemCleanupRunResult(params());
    expect(updateMock).not.toHaveBeenCalled();
  });
});
