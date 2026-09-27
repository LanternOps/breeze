import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #3189 — run-level idempotency.
 *
 *  - A replayed trigger job (same automation, same schedule slot / event) must
 *    get the run the first attempt minted back, not a second run.
 *  - A replayed `execute-run` for a run that already finished must not seed or
 *    dispatch anything.
 *
 * The unique index itself is proven against Postgres in
 * `automationReplayIdempotency.integration.test.ts`.
 */

const {
  insertMock,
  insertValuesMock,
  onConflictDoNothingMock,
  publishEventMock,
  selectMock,
  transactionMock,
  updateMock,
  seedActionResultsMock,
} = vi.hoisted(() => ({
  insertMock: vi.fn(),
  insertValuesMock: vi.fn(),
  onConflictDoNothingMock: vi.fn(),
  publishEventMock: vi.fn(),
  selectMock: vi.fn(),
  transactionMock: vi.fn(),
  updateMock: vi.fn(),
  seedActionResultsMock: vi.fn(),
}));

vi.mock('../db', () => {
  const tx = {
    insert: insertMock,
    update: updateMock,
    select: selectMock,
    selectDistinct: vi.fn(),
  };
  transactionMock.mockImplementation((fn: (value: typeof tx) => unknown) => fn(tx));
  return {
    db: { ...tx, transaction: transactionMock, execute: vi.fn() },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
    withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
    getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system' })),
  };
});

vi.mock('./eventBus', () => ({ publishEvent: publishEventMock }));
vi.mock('./automationActionResults', () => ({
  recordAutomationActionDispatch: vi.fn(),
  reconcileAutomationRun: vi.fn(),
  seedAutomationActionResults: seedActionResultsMock,
  claimAutomationActionDispatch: vi.fn(),
  claimAutomationActionDispatches: vi.fn(),
  stampClaimedAutomationActionOutcome: vi.fn(),
  readAutomationActionState: vi.fn(),
}));

import { createAutomationRunRecord, executeAutomationRun } from './automationRuntime';

const AUTOMATION = {
  id: 'auto-1',
  orgId: 'org-1',
  partnerId: null,
  name: 'Nightly',
  trigger: { type: 'schedule', cronExpression: '0 2 * * *' },
  actions: [{ type: 'execute_command', command: 'echo hi' }],
  conditions: null,
  onFailure: 'stop',
  notificationTargets: null,
  createdBy: 'user-1',
  managedByAgentId: null,
} as any;

const FIRST_RUN = {
  id: 'run-first',
  automationId: 'auto-1',
  triggeredBy: 'schedule:202609260200',
  status: 'running',
  occurrenceKey: 'schedule:202609260200',
};

function selectReturning(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  };
}

/** The two admission reads `resolveStandaloneAutomationReferencesForAdmission` makes. */
function mockAdmissionSelects() {
  selectMock
    .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) })
    .mockReturnValueOnce(selectReturning([{ partnerId: 'partner-1' }]));
}

beforeEach(() => {
  vi.clearAllMocks();
  selectMock.mockReset();
  insertMock.mockReturnValue({ values: insertValuesMock });
  updateMock.mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) });
  publishEventMock.mockResolvedValue(undefined);
});

describe('createAutomationRunRecord — trigger occurrence key (#3189)', () => {
  it('stores the occurrence key and arbitrates on the partial unique index', async () => {
    mockAdmissionSelects();
    onConflictDoNothingMock.mockReturnValue({ returning: vi.fn().mockResolvedValue([FIRST_RUN]) });
    insertValuesMock.mockReturnValue({ onConflictDoNothing: onConflictDoNothingMock });

    const result = await createAutomationRunRecord({
      automation: AUTOMATION,
      triggeredBy: 'schedule:202609260200',
      boundDeviceIds: ['dev-1'],
      occurrenceKey: 'schedule:202609260200',
    });

    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ occurrenceKey: 'schedule:202609260200' }));
    expect(onConflictDoNothingMock).toHaveBeenCalledTimes(1);
    const conflict = onConflictDoNothingMock.mock.calls[0]![0] as { target: unknown[] };
    expect(conflict.target).toHaveLength(2);
    expect(result).toMatchObject({ run: FIRST_RUN, reused: false });
    expect(updateMock).toHaveBeenCalledTimes(1); // runCount + 1
    expect(publishEventMock).toHaveBeenCalledWith('automation.started', 'org-1', expect.anything(), 'automation-runtime');
  });

  it('a replayed trigger for the same slot returns the existing run and mints nothing', async () => {
    mockAdmissionSelects();
    // The conflict: ON CONFLICT DO NOTHING returns no row.
    onConflictDoNothingMock.mockReturnValue({ returning: vi.fn().mockResolvedValue([]) });
    insertValuesMock.mockReturnValue({ onConflictDoNothing: onConflictDoNothingMock });
    selectMock.mockReturnValueOnce(selectReturning([FIRST_RUN]));

    const result = await createAutomationRunRecord({
      automation: AUTOMATION,
      triggeredBy: 'schedule:202609260200',
      boundDeviceIds: ['dev-1'],
      occurrenceKey: 'schedule:202609260200',
    });

    expect(result.run.id).toBe('run-first');
    expect(result.reused).toBe(true);
    // Neither the run counter nor the started event may fire twice for one occurrence.
    expect(updateMock).not.toHaveBeenCalled();
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it('a manual run (no occurrence key) never takes the conflict path', async () => {
    mockAdmissionSelects();
    insertValuesMock.mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ ...FIRST_RUN, occurrenceKey: null }]),
      onConflictDoNothing: onConflictDoNothingMock,
    });

    const result = await createAutomationRunRecord({
      automation: AUTOMATION,
      triggeredBy: 'manual:user-1',
      boundDeviceIds: ['dev-1'],
    });

    expect(onConflictDoNothingMock).not.toHaveBeenCalled();
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ occurrenceKey: null }));
    expect(result.reused).toBe(false);
  });
});

describe('executeAutomationRun — terminal-run short-circuit (#3189)', () => {
  it.each([
    ['completed', 3, 0],
    ['failed', 0, 3],
    ['partial', 2, 1],
  ] as const)('a replay of a %s run returns its stored outcome and dispatches nothing', async (status, ok, bad) => {
    selectMock.mockReturnValueOnce(selectReturning([{
      id: 'run-done',
      automationId: 'auto-1',
      status,
      devicesSucceeded: ok,
      devicesFailed: bad,
      logs: [],
    }]));

    const result = await executeAutomationRun('run-done', ['dev-1']);

    expect(result).toEqual({ status, devicesSucceeded: ok, devicesFailed: bad });
    // Only the run row was read: no automation load, no seeding, no writes.
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(seedActionResultsMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('a replay of a cancelled run returns cancelled and dispatches nothing', async () => {
    selectMock.mockReturnValueOnce(selectReturning([{
      id: 'run-stopped', automationId: 'auto-1', status: 'cancelled', devicesSucceeded: 0, devicesFailed: 0, logs: [],
    }]));

    const result = await executeAutomationRun('run-stopped', ['dev-1']);

    expect(result).toEqual({ status: 'cancelled', devicesSucceeded: 0, devicesFailed: 0 });
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(seedActionResultsMock).not.toHaveBeenCalled();
  });
});
