import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DispatchOutcome } from '../services/agentCommandRelay';

/**
 * Multi-target dispatch coverage for `processDispatchBackup` (#4137).
 *
 * Every pre-existing dispatch test pins the job's mode lookup to
 * `backupMode: 'file'`, which resolves to exactly ONE target — so the
 * `i > 0` branch of `prepareBackupDispatchTargets` (the child `backup_jobs`
 * row insert), `preFailedTargets`, the partial-dispatch errorLog and the
 * `failedChildJobs` settle loop had NO coverage at all. This file uses
 * `backupMode: 'hyperv'` with N discovered VMs to get N targets.
 *
 * It also pins the #4137 retry semantics: the dispatch is not idempotent
 * (Phase 3 commits fresh child rows every run), so a BullMQ re-delivery must
 * be refused outright, and an exception mid-dispatch must settle exactly the
 * rows that provably never reached the agent.
 */

const mockDb = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  selectDistinct: vi.fn(),
};

vi.mock('../db', () => ({
  db: mockDb,
  withSystemDbAccessContext: undefined,
  runOutsideDbContext: <T>(fn: () => T): T => fn(),
  SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system', orgId: null, partnerId: null },
}));

vi.mock('./backupRetention', () => ({
  cleanupExpiredSnapshots: vi.fn(),
  sweepUnreferencedBackupObjects: vi.fn(),
}));

const captureExceptionMock = vi.fn();
vi.mock('../services/sentry', () => ({ captureException: captureExceptionMock }));

vi.mock('../services/backupResultPersistence', () => ({
  applyBackupCommandResultToJob: vi.fn(),
  markBackupJobFailedIfInFlight: vi.fn(),
}));

const recordDispatchedExpectationMock = vi.fn(async () => undefined);
vi.mock('../services/agentWorkExpectation', () => ({
  recordDispatchedExpectation: recordDispatchedExpectationMock,
}));

const agentRelayMock = {
  isAgentConnectedAnywhere: vi.fn(async () => true),
  // Typed with the real arity so assertions can read the dispatched command.
  dispatchCommandToAgent: vi.fn(
    async (_agentId: string, _command: { id: string }): Promise<DispatchOutcome> => ({ status: 'sent', via: 'local' }),
  ),
};
vi.mock('../services/agentCommandRelay', () => ({
  isAgentConnectedAnywhere: agentRelayMock.isAgentConnectedAnywhere,
  dispatchCommandToAgent: agentRelayMock.dispatchCommandToAgent,
}));

// Must import AFTER the mocks so the module-level `const { db } = dbModule`
// destructure picks up the mock.
const { __testOnly } = await import('./backupWorker');

const DATA = {
  type: 'dispatch-backup' as const,
  jobId: 'job-1',
  configId: 'config-1',
  orgId: 'org-1',
  deviceId: 'device-1',
};
const CONFIG_ROW = { id: 'config-1', provider: 'local', providerConfig: {}, encryption: false };

/** Discovered Hyper-V VMs for this run — one dispatch target each. */
let vmRows: Array<{ vmName: string }> = [];
/** `isBackupJobCancelled` reports 'cancelled' from this 1-based call onwards. */
let cancelFromStatusCall: number | null = null;
let statusCalls = 0;
let childCounter = 0;

const insertLog: Array<{ payload: Record<string, unknown>; id: string }> = [];
const updateLog: Array<{ payload: Record<string, unknown>; ids: string[] }> = [];

/**
 * Recursively pull the bound parameter values out of a Drizzle `where`
 * expression so an assertion can name WHICH row an UPDATE targeted. Also picks
 * up the status-guard literals ('pending'/'running'), which is harmless — the
 * assertions only ever ask whether a specific job id is present.
 */
function whereValues(node: unknown, out: string[] = []): string[] {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) whereValues(child, out);
    return out;
  }
  const rec = node as Record<string, unknown>;
  if (typeof rec.value === 'string') out.push(rec.value);
  if (Array.isArray(rec.value)) {
    for (const v of rec.value) if (typeof v === 'string') out.push(v);
  }
  if (Array.isArray(rec.queryChunks)) whereValues(rec.queryChunks, out);
  return out;
}

/**
 * A `.from().where()` chain that is both awaitable (the Hyper-V VM query ends
 * at `.where()`) and `.limit()`-able (every other query ends at `.limit(1)`).
 */
function selectResult(rows: unknown[]) {
  const awaited = Promise.resolve(rows) as Promise<unknown[]> & { limit: () => Promise<unknown[]> };
  awaited.limit = async () => rows;
  return { from: () => ({ where: () => awaited }) };
}

function wireDb() {
  mockDb.select.mockImplementation(((cols?: Record<string, unknown>) => {
    const keys = cols ? Object.keys(cols) : [];
    if (keys.length === 0) return selectResult([CONFIG_ROW]); // config load
    if (keys.length === 1 && keys[0] === 'status') {
      statusCalls += 1;
      const cancelled = cancelFromStatusCall !== null && statusCalls >= cancelFromStatusCall;
      return selectResult([{ status: cancelled ? 'cancelled' : 'pending' }]);
    }
    if (keys.length === 1 && keys[0] === 'agentId') return selectResult([{ agentId: 'agent-1' }]);
    if (keys.includes('featureLinkId')) {
      return selectResult([{ featureLinkId: 'link-1', backupMode: 'hyperv', modeTargets: {} }]);
    }
    if (keys.length === 1 && keys[0] === 'vmName') return selectResult(vmRows);
    throw new Error(`unexpected select shape: ${JSON.stringify(keys)}`);
  }) as never);

  mockDb.insert.mockImplementation((() => ({
    values: (payload: Record<string, unknown>) => ({
      returning: async () => {
        childCounter += 1;
        const id = `child-${childCounter}`;
        insertLog.push({ payload, id });
        return [{ id }];
      },
    }),
  })) as never);

  mockDb.update.mockImplementation((() => ({
    set: (payload: Record<string, unknown>) => ({
      where: async (clause: unknown) => {
        updateLog.push({ payload, ids: whereValues(clause) });
      },
    }),
  })) as never);
}

/** Every UPDATE whose `where` named this job id. */
function updatesFor(jobId: string) {
  return updateLog.filter((u) => u.ids.includes(jobId));
}

describe('processDispatchBackup — multi-target dispatch (#4137)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertLog.length = 0;
    updateLog.length = 0;
    childCounter = 0;
    statusCalls = 0;
    cancelFromStatusCall = null;
    vmRows = [{ vmName: 'vm-a' }, { vmName: 'vm-b' }];
    wireDb();
    agentRelayMock.isAgentConnectedAnywhere.mockResolvedValue(true);
    agentRelayMock.dispatchCommandToAgent.mockResolvedValue({ status: 'sent', via: 'local' });
  });

  it('creates ONE child backup_jobs row for the second target and dispatches both', async () => {
    const result = await __testOnly.processDispatchBackup(DATA as never);

    expect(result).toEqual({ dispatched: true });

    // Target 0 reuses the parent jobId; only target 1 gets its own row.
    expect(insertLog).toHaveLength(1);
    expect(insertLog[0]!.payload).toMatchObject({
      orgId: 'org-1',
      configId: 'config-1',
      deviceId: 'device-1',
      featureLinkId: 'link-1',
      status: 'running',
      type: 'scheduled',
    });

    const dispatchedIds = agentRelayMock.dispatchCommandToAgent.mock.calls.map((call) => call[1].id);
    expect(dispatchedIds).toEqual(['job-1', 'child-1']);

    // Each target gets its OWN dispatch expectation — the child row's result
    // is verified against the child id, not the parent's.
    expect(recordDispatchedExpectationMock).toHaveBeenCalledWith('backup', 'device-1', 'job-1');
    expect(recordDispatchedExpectationMock).toHaveBeenCalledWith('backup', 'device-1', 'child-1');

    expect(updatesFor('job-1').some((u) => u.payload.status === 'running')).toBe(true);
  });

  it('settles the child row to failed and records a partial dispatch when the second target does not send', async () => {
    agentRelayMock.dispatchCommandToAgent
      .mockResolvedValueOnce({ status: 'sent', via: 'local' })
      .mockResolvedValueOnce({ status: 'offline' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await __testOnly.processDispatchBackup(DATA as never);

    expect(result).toEqual({ dispatched: true });

    // The child row must NOT be left at 'running' — nothing else sweeps it.
    expect(updatesFor('child-1')).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          status: 'failed',
          errorLog: 'Failed to send hyperv_backup command to agent',
        }),
      }),
    );

    const parentUpdates = updatesFor('job-1');
    expect(parentUpdates.some(
      (u) => u.payload.errorLog === 'Partial dispatch: 1 target(s) failed to send (hyperv_backup)',
    )).toBe(true);
    // The parent's OWN target did send, so the parent still goes running.
    expect(parentUpdates.some((u) => u.payload.status === 'running')).toBe(true);
    warn.mockRestore();
  });

  it('fails the parent row (never flips it to running) when the parent\'s own target does not send but a child does', async () => {
    agentRelayMock.dispatchCommandToAgent
      .mockResolvedValueOnce({ status: 'offline' })
      .mockResolvedValueOnce({ status: 'sent', via: 'local' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await __testOnly.processDispatchBackup(DATA as never);

    // A child did go out, so the dispatch as a whole is not a total failure…
    expect(result).toEqual({ dispatched: true });

    // …but the parent row carries the FIRST target's command, which the agent
    // never received. Flipping it to 'running' on the aggregate send count
    // would strand it in-flight until the stale reaper's 24h running timeout.
    const parentUpdates = updatesFor('job-1');
    expect(parentUpdates.some((u) => u.payload.status === 'running')).toBe(false);
    expect(parentUpdates).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          status: 'failed',
          errorLog: 'Failed to send hyperv_backup command to agent',
        }),
      }),
    );
    warn.mockRestore();
  });

  it('cancels EVERY child row already created when a cancel lands mid-preparation', async () => {
    vmRows = [{ vmName: 'vm-a' }, { vmName: 'vm-b' }, { vmName: 'vm-c' }];
    // isBackupJobCancelled call order for a 3-target hyperv run:
    //   1 phase-1 start · 2 phase-1 post-config · 3 phase-3 start
    //   4 phase-3 post-resolve · 5 loop i=0 · 6 loop i=1 · 7 loop i=1 post-insert
    //   8 loop i=2  ← cancel lands here, with child-1 already committed
    cancelFromStatusCall = 8;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await __testOnly.processDispatchBackup(DATA as never);

    expect(result).toEqual({ dispatched: false });
    expect(agentRelayMock.dispatchCommandToAgent).not.toHaveBeenCalled();
    expect(insertLog).toHaveLength(1);
    // Before #4137 this row was stranded at 'running' forever: the cancel route
    // only updates the parent id and there is no parent linkage to sweep by.
    expect(updatesFor('child-1')).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          status: 'cancelled',
          errorLog: 'Cancelled before dispatch',
        }),
      }),
    );
    warn.mockRestore();
  });

  it('refuses a BullMQ re-delivery outright instead of creating a second child set', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await __testOnly.processDispatchBackup(DATA as never, { redelivered: true });

    expect(result).toEqual({ dispatched: false });
    // Nothing is re-created and nothing is re-sent — the whole point of #4137.
    expect(insertLog).toHaveLength(0);
    expect(updateLog).toHaveLength(0);
    expect(agentRelayMock.dispatchCommandToAgent).not.toHaveBeenCalled();
    expect(mockDb.select).not.toHaveBeenCalled();
    // Silent at-most-once would be indistinguishable from a lost backup.
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      expect.objectContaining({ job_type: 'dispatch-backup', backup_job_id: 'job-1' }),
    );
    warn.mockRestore();
  });

  it('settles only the never-attempted rows when a send throws, and rethrows', async () => {
    agentRelayMock.dispatchCommandToAgent.mockRejectedValueOnce(new Error('relay exploded'));

    await expect(__testOnly.processDispatchBackup(DATA as never)).rejects.toThrow('relay exploded');

    // Target 1's child row was prepared and committed but never even attempted,
    // so it is provably undelivered and must not sit at 'running'.
    expect(updatesFor('child-1')).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          status: 'failed',
          errorLog: 'Backup dispatch aborted; the hyperv_backup target never reached the agent: relay exploded',
        }),
      }),
    );
    // The parent's send is the one that threw — delivery is AMBIGUOUS, so its
    // row stays in-flight for a genuine agent result to land on.
    expect(updatesFor('job-1')).toHaveLength(0);
  });

  it('leaves an already-sent target and the throwing target alone while settling the untouched one', async () => {
    vmRows = [{ vmName: 'vm-a' }, { vmName: 'vm-b' }, { vmName: 'vm-c' }];
    agentRelayMock.dispatchCommandToAgent
      .mockResolvedValueOnce({ status: 'sent', via: 'local' })
      .mockRejectedValueOnce(new Error('relay exploded'));

    await expect(__testOnly.processDispatchBackup(DATA as never)).rejects.toThrow('relay exploded');

    expect(updatesFor('job-1')).toHaveLength(0); // sent — result still coming
    expect(updatesFor('child-1')).toHaveLength(0); // threw — ambiguous
    expect(updatesFor('child-2')).toContainEqual(
      expect.objectContaining({ payload: expect.objectContaining({ status: 'failed' }) }),
    );
  });
});
