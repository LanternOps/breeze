import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #3525 W05 (#4766) — cancellation-aware aggregation and reconciliation.
 *
 * Two contracts live here:
 *  1. OD6-A: `cancelled` is neither a success nor a failure. Before this wave
 *     `aggregateActionStatuses` lumped it in with failed/timed_out, which
 *     poisons automation health reporting and any alerting keyed on
 *     devicesFailed.
 *  2. Reconciliation never re-opens a cancelled run, and a run that was
 *     cancelled keeps counting its children home instead of freezing.
 */

type RunRow = {
  id: string;
  automationId: string | null;
  configPolicyId: string | null;
  configItemName: string | null;
  triggeredBy: string;
  status: string;
};

const state: {
  run: RunRow;
  actionRows: Array<Record<string, unknown>>;
  deviceRows: Array<{ deviceId: string; status: string }>;
  deviceUpdates: Array<Record<string, unknown>>;
  runUpdates: Array<Record<string, unknown>>;
  /** Whether each successive guarded run UPDATE wins its CAS. */
  runUpdateWins: boolean[];
} = {
  run: {
    id: 'run-1',
    automationId: 'automation-1',
    configPolicyId: null,
    configItemName: null,
    triggeredBy: 'manual:user-1',
    status: 'running',
  },
  actionRows: [],
  deviceRows: [],
  deviceUpdates: [],
  runUpdates: [],
  runUpdateWins: [],
};

function tableName(table: unknown): string {
  const candidate = table as Record<symbol, unknown> | null;
  if (!candidate) return '';
  for (const symbol of Object.getOwnPropertySymbols(candidate)) {
    if (String(symbol).includes('Name')) return String(candidate[symbol]);
  }
  return '';
}

vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const name = tableName(table);
          const rows = name === 'automation_runs'
            ? [state.run]
            : name === 'automation_action_results'
              ? state.actionRows
              : name === 'automation_run_device_results'
                ? state.deviceRows
                : [];
          const promise = Promise.resolve(rows) as Promise<unknown[]> & {
            limit?: (n: number) => { for: (mode: string) => Promise<unknown[]> };
          };
          promise.limit = () => ({ for: () => Promise.resolve(rows) });
          return promise;
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => {
        const name = tableName(table);
        if (name === 'automation_run_device_results') state.deviceUpdates.push(patch);
        if (name === 'automation_runs') state.runUpdates.push(patch);
        return {
          where: () => {
            const returningRows = name === 'automation_run_device_results'
              ? [{ id: 'device-result-1' }]
              : (state.runUpdateWins.shift() ?? true) ? [{ id: 'run-1' }] : [];
            const inner = Promise.resolve(returningRows) as Promise<unknown[]> & {
              returning?: () => Promise<unknown[]>;
            };
            inner.returning = () => Promise.resolve(returningRows);
            return inner;
          },
        };
      },
    }),
  },
  getCurrentDbAccessContext: () => ({ scope: 'system' }),
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

const publishEventMock = vi.hoisted(() => vi.fn(
  async (
    _type: string,
    _orgId: string,
    _payload: Record<string, unknown>,
    _source: string,
  ): Promise<void> => undefined,
));
vi.mock('./eventBus', () => ({ publishEvent: publishEventMock }));

import { __testOnly, reconcileAutomationRun } from './automationActionResults';

const { aggregateActionStatuses, aggregateDeviceStatuses } = __testOnly;

function seedActions(statuses: string[], deviceId = 'device-1') {
  state.actionRows = statuses.map((status, index) => ({
    id: `action-${index}`,
    deviceId,
    orgId: 'org-1',
    actionIndex: index,
    status,
    message: null,
    output: null,
    error: null,
    completedAt: null,
  }));
}

beforeEach(() => {
  publishEventMock.mockClear();
  state.run = {
    id: 'run-1',
    automationId: 'automation-1',
    configPolicyId: null,
    configItemName: null,
    triggeredBy: 'manual:user-1',
    status: 'running',
  };
  state.actionRows = [];
  state.deviceRows = [];
  state.deviceUpdates = [];
  state.runUpdates = [];
  state.runUpdateWins = [];
});

describe('cancellation-aware aggregation (#3525 OD6-A)', () => {
  it('a cancelled action maps the device to cancelled, not failed', () => {
    expect(aggregateActionStatuses(['cancelled', 'succeeded'])).toEqual({ status: 'cancelled' });
  });

  it('a mix of failed and cancelled still reports failed — a real failure outranks a stop', () => {
    expect(aggregateActionStatuses(['cancelled', 'failed'])).toEqual({ status: 'failed' });
    expect(aggregateActionStatuses(['cancelled', 'timed_out'])).toEqual({ status: 'failed' });
  });

  it('leaves a run with no cancelled action untouched', () => {
    expect(aggregateActionStatuses(['succeeded', 'succeeded'])).toEqual({ status: 'success' });
    expect(aggregateActionStatuses(['skipped', 'skipped'])).toEqual({ status: 'skipped' });
    expect(aggregateActionStatuses(['running', 'succeeded'])).toEqual({ status: 'running' });
  });

  it('a run whose devices all cancelled is cancelled, and counts in devicesCancelled', () => {
    expect(aggregateDeviceStatuses(['cancelled', 'cancelled']))
      .toEqual({ status: 'cancelled', devicesSucceeded: 0, devicesFailed: 0, devicesCancelled: 2 });
  });

  it('a real device failure still outranks a cancelled sibling', () => {
    expect(aggregateDeviceStatuses(['cancelled', 'failed']))
      .toMatchObject({ status: 'failed', devicesFailed: 1, devicesCancelled: 1 });
  });

  it('counters still sum to the number of classified devices', () => {
    const a = aggregateDeviceStatuses(['success', 'failed', 'cancelled']);
    expect(a.devicesSucceeded + a.devicesFailed + a.devicesCancelled).toBe(3);
    expect(a.status).toBe('partial');
  });

  it('a still-running device keeps the run running even when a sibling cancelled', () => {
    expect(aggregateDeviceStatuses(['cancelled', 'running']))
      .toMatchObject({ status: 'running', devicesCancelled: 1 });
  });
});

describe('reconciliation never re-opens a cancelled run', () => {
  it('does not DOWNGRADE a device-level cancelled to a non-terminal status', async () => {
    // The in-flight action has not closed yet, so the action aggregate is
    // `running` — but the device row already proved it stopped.
    seedActions(['cancelled', 'running']);
    state.deviceRows = [{ deviceId: 'device-1', status: 'cancelled' }];
    await reconcileAutomationRun('run-1');
    expect(state.deviceUpdates.at(-1)).toMatchObject({ status: 'cancelled' });
  });

  it('publishes automation.cancelled when every child cancelled', async () => {
    seedActions(['cancelled']);
    state.deviceRows = [{ deviceId: 'device-1', status: 'cancelled' }];
    await reconcileAutomationRun('run-1');
    expect(publishEventMock).toHaveBeenCalledWith(
      'automation.cancelled',
      'org-1',
      expect.objectContaining({ runId: 'run-1', status: 'cancelled', devicesCancelled: 1 }),
      'automation-action-results',
    );
  });

  it('keeps counting children home for a run already marked cancelled, and never restores it to running', async () => {
    state.run.status = 'cancelled';
    seedActions(['cancelled', 'running']);
    state.deviceRows = [{ deviceId: 'device-1', status: 'running' }];
    await reconcileAutomationRun('run-1');
    const runPatch = state.runUpdates.at(-1)!;
    expect(runPatch).toMatchObject({ devicesTargeted: 1 });
    expect(runPatch.status).toBeUndefined();
    expect(runPatch.completedAt).toBeUndefined();
  });

  it('a cancelled run whose device genuinely FAILED still publishes automation.failed', async () => {
    // A stop must not hide a failure. There is no false-alarm cost: W03's
    // closers stamp a PROVEN post-cancel kill as `cancelled`, never `failed`,
    // so a device still reading `failed` here is a failure the cancellation
    // machinery did not account for.
    state.run.status = 'cancelled';
    seedActions(['failed']);
    state.deviceRows = [{ deviceId: 'device-1', status: 'failed' }];
    await reconcileAutomationRun('run-1');

    const types = publishEventMock.mock.calls.map((call) => call[0]);
    expect(types).toContain('automation.cancelled');
    expect(types).toContain('automation.failed');
    // The run KEEPS its cancelled label — relabelling a deliberate stop as a
    // failure is the other half of the dishonesty.
    for (const call of publishEventMock.mock.calls) {
      expect(call[2]).toMatchObject({ status: 'cancelled', devicesFailed: 1 });
    }
    expect(state.runUpdates.at(-1)!.status).toBeUndefined();
  });

  it('a cancelled run with no failures publishes ONLY automation.cancelled', async () => {
    state.run.status = 'cancelled';
    seedActions(['cancelled']);
    state.deviceRows = [{ deviceId: 'device-1', status: 'cancelled' }];
    await reconcileAutomationRun('run-1');
    const types = publishEventMock.mock.calls.map((call) => call[0]);
    expect(types).toEqual(['automation.cancelled']);
  });

  it('stamps completedAt exactly once on a cancelled run whose children are all terminal', async () => {
    state.run.status = 'cancelled';
    seedActions(['cancelled']);
    state.deviceRows = [{ deviceId: 'device-1', status: 'cancelled' }];
    await reconcileAutomationRun('run-1');
    expect(state.runUpdates.at(-1)).toMatchObject({ completedAt: expect.any(Date), devicesCancelled: 1 });
    expect(publishEventMock).toHaveBeenCalledWith(
      'automation.cancelled',
      'org-1',
      expect.objectContaining({ status: 'cancelled' }),
      'automation-action-results',
    );

    // Second pass: the guarded UPDATE loses (completed_at already set), so
    // nothing is published a second time.
    publishEventMock.mockClear();
    state.runUpdates = [];
    state.runUpdateWins = [false];
    await reconcileAutomationRun('run-1');
    expect(publishEventMock).not.toHaveBeenCalled();
  });
});
