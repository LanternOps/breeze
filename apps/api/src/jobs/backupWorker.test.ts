import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DispatchOutcome } from '../services/agentCommandRelay';

// Mock db module — backupWorker uses `import * as dbModule from '../db'`
// then destructures: `const { db } = dbModule;`
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue([]),
  selectDistinct: vi.fn(),
  update: vi.fn(),
};

vi.mock('../db', () => ({
  db: mockDb,
  withSystemDbAccessContext: undefined,
  runOutsideDbContext: <T>(fn: () => T): T => fn(),
  SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system', orgId: null, partnerId: null },
}));

const cleanupExpiredSnapshotsMock = vi.fn();
const sweepUnreferencedBackupObjectsMock = vi.fn();

vi.mock('./backupRetention', () => ({
  cleanupExpiredSnapshots: cleanupExpiredSnapshotsMock,
  sweepUnreferencedBackupObjects: sweepUnreferencedBackupObjectsMock,
}));

const captureExceptionMock = vi.fn();
vi.mock('../services/sentry', () => ({ captureException: captureExceptionMock }));

const applyBackupCommandResultToJobMock = vi.fn(async () => ({
  applied: true,
  snapshotDbId: null,
  providerSnapshotId: null,
}));
const markBackupJobFailedIfInFlightMock = vi.fn();
vi.mock('../services/backupResultPersistence', () => ({
  applyBackupCommandResultToJob: applyBackupCommandResultToJobMock,
  markBackupJobFailedIfInFlight: markBackupJobFailedIfInFlightMock,
}));

const recordDispatchedExpectationMock = vi.fn(async () => undefined);
vi.mock('../services/agentWorkExpectation', () => ({
  recordDispatchedExpectation: recordDispatchedExpectationMock,
}));

const agentRelayMock = {
  isAgentConnectedAnywhere: vi.fn(async () => true),
  dispatchCommandToAgent: vi.fn(async (): Promise<DispatchOutcome> => ({ status: 'sent', via: 'local' })),
};
vi.mock('../services/agentCommandRelay', () => ({
  isAgentConnectedAnywhere: agentRelayMock.isAgentConnectedAnywhere,
  dispatchCommandToAgent: agentRelayMock.dispatchCommandToAgent,
}));

// Must import AFTER mock so the module-level destructure picks up our mock
const { resolveBackupTargets, processCleanupExpiredSnapshots, __testOnly } = await import('./backupWorker');

describe('resolveBackupTargets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset chainable defaults
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockReturnThis();
    mockDb.limit.mockResolvedValue([]);
  });

  it('returns file targets unchanged, omitting excludes when not configured', async () => {
    // No excludes key at all — the agent treats a missing field as "fall back
    // to locally-configured excludes", so the worker must not invent one.
    const result = await resolveBackupTargets(
      'file',
      { paths: ['/data', '/etc'] },
      'device-id'
    );
    expect(result).toEqual([
      {
        commandType: 'backup_run',
        payload: { paths: ['/data', '/etc'] },
      },
    ]);
    expect(result[0]!.payload).not.toHaveProperty('excludes');
  });

  it('forwards an explicit empty excludes list for file mode', async () => {
    // Explicit [] means "no exclusions for this run" on the agent side.
    const result = await resolveBackupTargets(
      'file',
      { paths: ['/data'], excludes: [] },
      'device-id'
    );
    expect(result).toEqual([
      { commandType: 'backup_run', payload: { paths: ['/data'], excludes: [] } },
    ]);
  });

  it('forwards exclusion patterns for file mode (#2418)', async () => {
    const result = await resolveBackupTargets(
      'file',
      {
        paths: ['C:\\Users'],
        excludes: ['*.tmp', 'node_modules/**', '**/AppData/Local/Temp/**'],
      },
      'device-id'
    );
    expect(result).toEqual([
      {
        commandType: 'backup_run',
        payload: {
          paths: ['C:\\Users'],
          excludes: ['*.tmp', 'node_modules/**', '**/AppData/Local/Temp/**'],
        },
      },
    ]);
  });

  it('returns system_image target', async () => {
    const result = await resolveBackupTargets(
      'system_image',
      { includeSystemState: true },
      'device-id'
    );
    expect(result).toEqual([
      { commandType: 'backup_run', payload: { systemImage: true } },
    ]);
  });

  it('returns one entry per discovered VM for hyperv minus excludes', async () => {
    // Chain: db.select({vmName}).from(hypervVms).where(eq(deviceId))
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { vmName: 'DC-01' },
          { vmName: 'SQL-01' },
          { vmName: 'DevVM' },
        ]),
      }),
    });

    const result = await resolveBackupTargets(
      'hyperv',
      {
        exportPath: 'D:\\Backups',
        consistencyType: 'application',
        excludeVms: ['DevVM'],
      },
      'device-id'
    );

    expect(result).toHaveLength(2);
    expect(result[0]!).toEqual({
      commandType: 'hyperv_backup',
      payload: {
        vmName: 'DC-01',
        consistencyType: 'application',
      },
    });
    expect(result[1]!).toEqual({
      commandType: 'hyperv_backup',
      payload: {
        vmName: 'SQL-01',
        consistencyType: 'application',
      },
    });
  });

  it('returns empty array when all VMs excluded', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ vmName: 'DevVM' }]),
      }),
    });

    const result = await resolveBackupTargets(
      'hyperv',
      { exportPath: 'D:\\Backups', excludeVms: ['DevVM'] },
      'device-id'
    );

    expect(result).toEqual([]);
  });

  it('returns one entry per database for mssql minus excludes', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            instanceName: 'SQLEXPRESS',
            databases: ['AppDB', 'AuthDB', 'tempdb'],
          },
        ]),
      }),
    });

    const result = await resolveBackupTargets(
      'mssql',
      {
        outputPath: 'D:\\SQLBackups',
        backupType: 'full',
        excludeDatabases: ['tempdb'],
      },
      'device-id'
    );

    expect(result).toHaveLength(2);
    expect(result[0]!.payload).toEqual({
      instance: 'SQLEXPRESS',
      database: 'AppDB',
      backupType: 'full',
    });
    expect(result[1]!.payload).toEqual({
      instance: 'SQLEXPRESS',
      database: 'AuthDB',
      backupType: 'full',
    });
  });

  it('handles multiple SQL instances', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { instanceName: 'MSSQLSERVER', databases: ['master', 'AppDB'] },
          { instanceName: 'SQLEXPRESS', databases: ['DevDB'] },
        ]),
      }),
    });

    const result = await resolveBackupTargets(
      'mssql',
      { outputPath: 'D:\\SQLBackups', backupType: 'differential' },
      'device-id'
    );

    expect(result).toHaveLength(3);
    expect(result[0]!.payload).toMatchObject({
      instance: 'MSSQLSERVER',
      database: 'master',
    });
    expect(result[1]!.payload).toMatchObject({
      instance: 'MSSQLSERVER',
      database: 'AppDB',
    });
    expect(result[2]!.payload).toMatchObject({
      instance: 'SQLEXPRESS',
      database: 'DevDB',
    });
  });

  it('extracts database names from discovered MSSQL database objects', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            instanceName: 'MSSQLSERVER',
            databases: [
              { name: 'master' },
              { name: 'AppDB' },
            ],
          },
        ]),
      }),
    });

    const result = await resolveBackupTargets(
      'mssql',
      { backupType: 'full' },
      'device-id'
    );

    expect(result).toHaveLength(2);
    expect(result[0]!.payload).toMatchObject({
      instance: 'MSSQLSERVER',
      database: 'master',
    });
    expect(result[1]!.payload).toMatchObject({
      instance: 'MSSQLSERVER',
      database: 'AppDB',
    });
  });

  it('defaults backupType to full for mssql when not specified', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { instanceName: 'SQL01', databases: ['TestDB'] },
        ]),
      }),
    });

    const result = await resolveBackupTargets(
      'mssql',
      { outputPath: 'D:\\Backups' },
      'device-id'
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.payload).toMatchObject({ backupType: 'full' });
  });

  it('defaults consistencyType to application for hyperv', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ vmName: 'VM-01' }]),
      }),
    });

    const result = await resolveBackupTargets(
      'hyperv',
      { exportPath: 'D:\\Backups' },
      'device-id'
    );

    expect(result[0]!.payload).toMatchObject({
      consistencyType: 'application',
    });
  });

  it('returns empty array for unknown mode', async () => {
    const result = await resolveBackupTargets(
      'unknown' as any,
      {},
      'device-id'
    );
    expect(result).toEqual([]);
  });

  it('returns empty paths and no excludes field for file mode when not provided', async () => {
    const result = await resolveBackupTargets('file', {}, 'device-id');
    expect(result).toEqual([
      { commandType: 'backup_run', payload: { paths: [] } },
    ]);
  });
});

describe('processCleanupExpiredSnapshots — GC wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.selectDistinct.mockReset();
    cleanupExpiredSnapshotsMock.mockReset();
    sweepUnreferencedBackupObjectsMock.mockReset();
  });

  it('runs the GC sweep exactly once, after row-level retention has completed for every org', async () => {
    mockDb.selectDistinct.mockReturnValue({
      from: vi.fn().mockResolvedValue([{ orgId: 'org-a' }, { orgId: 'org-b' }]),
    });
    cleanupExpiredSnapshotsMock.mockResolvedValue({
      deleted: 1,
      skippedLegalHold: 0,
      skippedImmutable: 0,
      prunedByMaxVersions: 0,
    });
    sweepUnreferencedBackupObjectsMock.mockResolvedValue({ deleted: 5, skippedIdentities: 2, blockedIdentities: 1 });

    const result = await processCleanupExpiredSnapshots();

    // Row-level retention for both orgs happens before the sweep is called.
    expect(cleanupExpiredSnapshotsMock).toHaveBeenCalledTimes(2);
    expect(cleanupExpiredSnapshotsMock).toHaveBeenNthCalledWith(1, 'org-a');
    expect(cleanupExpiredSnapshotsMock).toHaveBeenNthCalledWith(2, 'org-b');
    expect(sweepUnreferencedBackupObjectsMock).toHaveBeenCalledTimes(1);
    // Sweep is storage-identity-scoped, not org-scoped — called once total, not once per org.
    expect(result).toEqual({
      deleted: 2,
      skipped: 0,
      prunedByMaxVersions: 0,
      gcDeleted: 5,
      gcSkippedIdentities: 2,
      gcBlockedIdentities: 1,
    });
  });

  it('does not fail the retention run when the GC sweep throws', async () => {
    mockDb.selectDistinct.mockReturnValue({
      from: vi.fn().mockResolvedValue([{ orgId: 'org-a' }]),
    });
    cleanupExpiredSnapshotsMock.mockResolvedValue({
      deleted: 3,
      skippedLegalHold: 1,
      skippedImmutable: 0,
      prunedByMaxVersions: 0,
    });
    sweepUnreferencedBackupObjectsMock.mockRejectedValue(new Error('S3 listing failed'));

    // Must resolve, not reject — a GC failure isn't a retention-run failure.
    const result = await processCleanupExpiredSnapshots();

    expect(result.deleted).toBe(3);
    expect(result.skipped).toBe(1);
    expect(result.gcDeleted).toBe(0);
    expect(result.gcSkippedIdentities).toBe(0);
    expect(result.gcBlockedIdentities).toBe(0);
    // A thrown GC sweep is escalated to Sentry (retention run still succeeds).
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('still runs the sweep when there are no orgs with snapshots (row-level retention is a no-op)', async () => {
    mockDb.selectDistinct.mockReturnValue({
      from: vi.fn().mockResolvedValue([]),
    });
    sweepUnreferencedBackupObjectsMock.mockResolvedValue({ deleted: 0, skippedIdentities: 0, blockedIdentities: 0 });

    const result = await processCleanupExpiredSnapshots();

    expect(cleanupExpiredSnapshotsMock).not.toHaveBeenCalled();
    expect(sweepUnreferencedBackupObjectsMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      deleted: 0,
      skipped: 0,
      prunedByMaxVersions: 0,
      gcDeleted: 0,
      gcSkippedIdentities: 0,
      gcBlockedIdentities: 0,
    });
  });
});

// #3000: `processResults` is the queue-side hop that carries the agent's own
// terminal status into persistence. `data.result.status` here is the OUTER
// completed/failed status, so the agent's `partial` can only travel on the
// separate `agentStatus` key — this pins that it is actually forwarded.
describe('processResults — agent terminal status hop (#3000)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards agentStatus to persistence alongside the outer result status', async () => {
    await __testOnly.processResults({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      result: {
        status: 'completed',
        agentStatus: 'partial',
        snapshotId: 'snap-1',
        filesBackedUp: 1,
        errorCount: 21,
      },
    } as any);

    expect(applyBackupCommandResultToJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        resultStatus: 'completed',
        agentStatus: 'partial',
      })
    );
  });

  it('leaves agentStatus undefined for a legacy agent that sends none', async () => {
    await __testOnly.processResults({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      result: { status: 'completed', snapshotId: 'snap-1' },
    } as any);

    expect(applyBackupCommandResultToJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ resultStatus: 'completed', agentStatus: undefined })
    );
  });
});

// #3260: a malformed `result` payload used to report
// `Malformed backup result payload: expected object, received null` with no
// indication of WHICH field was wrong, because the old message only joined
// `issue.message` and dropped `issue.path` — indistinguishable from "some
// named field inside the payload is null". describeZodIssues fixes this by
// rendering an issue's empty path as the literal `<root>` instead of
// silently omitting it.
//
// NOTE: a literal top-level `result: null` cannot be driven through this
// function as a regression case — `data.result.status` (evaluated one line
// above the schema parse, to capture the outer command status) dereferences
// `data.result` before `backupCommandResultSchema.safeParse` ever runs, so a
// null `result` throws a TypeError instead of reaching the malformed-payload
// branch this test targets. An array reproduces the same root-level
// "expected object" Zod failure (empty `issue.path`) without that crash, so
// it exercises the same describeZodIssues code path #3260 was about.
describe('processResults — malformed payload path rendering (#3260)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('labels a root-level schema failure as <root> instead of dropping the path', async () => {
    await __testOnly.processResults({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      result: [],
    } as any);

    expect(markBackupJobFailedIfInFlightMock).toHaveBeenCalledWith(
      'job-1',
      expect.stringMatching(/^Malformed backup result payload:.*<root>/)
    );
  });

  it('labels a malformed named field with its own path, not <root>', async () => {
    await __testOnly.processResults({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      // filesBackedUp must be a nonnegative int — a negative number fails
      // validation at a named path, which must NOT collapse to <root>.
      result: { status: 'completed', filesBackedUp: -1 },
    } as any);

    const [, message] = markBackupJobFailedIfInFlightMock.mock.calls[0]!;
    expect(message).toMatch(/^Malformed backup result payload:/);
    expect(message).toContain('filesBackedUp');
    expect(message).not.toContain('<root>');
  });
});

describe('processDispatchBackup (wave 3.5b #4084 — dispatch via facade)', () => {
  const DATA = { type: 'dispatch-backup' as const, jobId: 'job-1', configId: 'config-1', orgId: 'org-1', deviceId: 'device-1' };
  const CONFIG_ROW = { id: 'config-1', provider: 'local', providerConfig: {}, encryption: false };
  const updateLog: Array<{ table: unknown; payload: Record<string, unknown> }> = [];

  // Route every db.select() call by the shape of its column-selector argument
  // (all these queries hit different tables/columns, real schema refs — not
  // stringly-typed, so we key off which fields were requested).
  function wireSelects() {
    mockDb.select.mockImplementation(((cols?: Record<string, unknown>) => {
      const keys = cols ? Object.keys(cols) : [];
      let rows: unknown[];
      if (keys.length === 0) {
        rows = [CONFIG_ROW]; // config load: db.select() with no arg
      } else if (keys.length === 1 && keys[0] === 'status') {
        rows = []; // isBackupJobCancelled: never cancelled
      } else if (keys.length === 1 && keys[0] === 'agentId') {
        rows = [{ agentId: 'agent-1' }]; // device -> agent lookup
      } else if (keys.includes('featureLinkId')) {
        rows = [{ featureLinkId: null, backupMode: 'file', modeTargets: { paths: ['/data'] } }]; // job mode lookup
      } else {
        throw new Error(`unexpected select shape: ${JSON.stringify(keys)}`);
      }
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows),
          }),
        }),
      };
    }) as never);
  }

  function wireUpdates() {
    mockDb.update.mockImplementation(((table: unknown) => ({
      set: (payload: Record<string, unknown>) => ({
        where: async () => {
          updateLog.push({ table, payload });
        },
      }),
    })) as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    updateLog.length = 0;
    wireSelects();
    wireUpdates();
    agentRelayMock.isAgentConnectedAnywhere.mockResolvedValue(true);
    agentRelayMock.dispatchCommandToAgent.mockResolvedValue({ status: 'sent', via: 'local' });
  });

  it('marks the job failed with "Agent not connected" (byte-identical to today) when no agent is connected anywhere, without calling dispatch', async () => {
    agentRelayMock.isAgentConnectedAnywhere.mockResolvedValue(false);

    const result = await __testOnly.processDispatchBackup(DATA as any);

    expect(result).toEqual({ dispatched: false });
    expect(agentRelayMock.dispatchCommandToAgent).not.toHaveBeenCalled();
    expect(updateLog.some((u) => u.payload.errorLog === 'Agent not connected')).toBe(true);
  });

  it('dispatches normally (sentCount incremented) when the outcome is sent', async () => {
    const result = await __testOnly.processDispatchBackup(DATA as any);

    expect(result).toEqual({ dispatched: true });
    // Final status flip to 'running' proves sentCount > 0 took the happy path.
    expect(updateLog.some((u) => u.payload.status === 'running')).toBe(true);
    expect(updateLog.some((u) => typeof u.payload.errorLog === 'string' && u.payload.errorLog.includes('Failed to send'))).toBe(false);
  });

  it('marks the target failed with "Failed to send ... command to agent" (today\'s message) when the outcome is offline', async () => {
    agentRelayMock.dispatchCommandToAgent.mockResolvedValue({ status: 'offline' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await __testOnly.processDispatchBackup(DATA as any);

    expect(result).toEqual({ dispatched: false });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[BackupWorker\] Failed to send backup_run command to agent for job/));
    // Single target reuses the original jobId, so no per-target failed-row
    // UPDATE fires (that branch only runs when commandJobId !== data.jobId);
    // the only observable failure signal is the final markJobFailed.
    expect(updateLog.some((u) => u.payload.errorLog === 'Failed to send command to agent')).toBe(true);
    warn.mockRestore();
  });

  it('marks the job failed naming the outcome when indeterminate (still may have been sent)', async () => {
    agentRelayMock.dispatchCommandToAgent.mockResolvedValue({ status: 'indeterminate' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await __testOnly.processDispatchBackup(DATA as any);

    expect(result).toEqual({ dispatched: false });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/dispatch outcome indeterminate/i));
    // The persisted job errorLog (not just the console.warn) must name the
    // outcome so ops/dashboards can distinguish "maybe sent" (indeterminate)
    // from a genuine "offline" — same distinct-message contract as
    // discoveryWorker. Single target reuses the original jobId, so the only
    // observable failure signal is the final markJobFailed UPDATE.
    expect(
      updateLog.some((u) => u.payload.errorLog === 'Failed to send command to agent (dispatch outcome indeterminate)')
    ).toBe(true);
    expect(updateLog.some((u) => u.payload.errorLog === 'Failed to send command to agent')).toBe(false);
    warn.mockRestore();
  });

  it('calls recordDispatchedExpectation BEFORE dispatchCommandToAgent (expectation-first, backupWorker.ts:645-651)', async () => {
    await __testOnly.processDispatchBackup(DATA as any);

    expect(recordDispatchedExpectationMock).toHaveBeenCalledWith('backup', 'device-1', 'job-1');
    const expectationOrder = recordDispatchedExpectationMock.mock.invocationCallOrder[0] as number;
    const dispatchOrder = agentRelayMock.dispatchCommandToAgent.mock.invocationCallOrder[0] as number;
    expect(expectationOrder).toBeLessThan(dispatchOrder);
  });
});
