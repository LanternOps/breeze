import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * #3525 W05 (#4766) — the automation-run dispatch fence and fan-out.
 *
 * The fence is what stops a queued BullMQ job for an already-cancelled run
 * from dispatching anything: today neither runner checks run status before
 * seeding or dispatching, so a job picked up after a cancel runs to completion.
 */

const dialect = new PgDialect();
const renderSql = (clause: unknown) => dialect.sqlToQuery(clause as SQL).sql;
const sqlParams = (clause: unknown) => dialect.sqlToQuery(clause as SQL).params;

type ActionRow = { id: string; actionIndex: number; actionType: string; status: string };

const state: {
  run: { id: string; status: string } | null;
  actionRows: ActionRow[];
  /** Every `SELECT ... FOR SHARE` issued through the fence, as rendered SQL. */
  fenceQueries: Array<{ sql: string; params: unknown[] }>;
  runUpdatePatches: Array<Record<string, unknown>>;
  runUpdateWheres: unknown[];
  actionUpdatePatches: Array<Record<string, unknown>>;
  actionUpdateWheres: unknown[];
  actionSelectWheres: unknown[];
  cancelledActionIds: string[];
} = {
  run: null,
  actionRows: [],
  fenceQueries: [],
  runUpdatePatches: [],
  runUpdateWheres: [],
  actionUpdatePatches: [],
  actionUpdateWheres: [],
  actionSelectWheres: [],
  cancelledActionIds: [],
};

function tableName(table: unknown): string {
  const candidate = table as Record<symbol, unknown> | null;
  if (!candidate) return '';
  for (const symbol of Object.getOwnPropertySymbols(candidate)) {
    if (String(symbol).includes('Name')) return String(candidate[symbol]);
  }
  return '';
}

function makeTx() {
  return {
    execute: (query: SQL) => {
      state.fenceQueries.push({ sql: renderSql(query), params: sqlParams(query) });
      return Promise.resolve(state.run ? [{ status: state.run.status }] : []);
    },
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () => ({
            for: () => Promise.resolve(
              tableName(table) === 'automation_runs' && state.run ? [state.run] : [],
            ),
          }),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (where: unknown) => {
          const name = tableName(table);
          if (name === 'automation_runs') {
            state.runUpdatePatches.push(patch);
            state.runUpdateWheres.push(where);
          }
          if (name === 'automation_action_results') {
            state.actionUpdatePatches.push(patch);
            state.actionUpdateWheres.push(where);
          }
          const rows = name === 'automation_action_results'
            ? state.actionRows.filter((row) => row.status === 'pending').map((row) => ({ id: row.id }))
            : [{ id: 'run-1' }];
          if (name === 'automation_action_results') {
            state.cancelledActionIds.push(...rows.map((row) => row.id));
          }
          const inner = Promise.resolve(rows) as Promise<unknown[]> & {
            returning?: () => Promise<unknown[]>;
          };
          inner.returning = () => Promise.resolve(rows);
          return inner;
        },
      }),
    }),
  };
}

vi.mock('../db', () => ({
  db: {
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()),
    select: () => ({
      from: (table: unknown) => ({
        where: (where: unknown) => {
          if (tableName(table) === 'automation_action_results') {
            state.actionSelectWheres.push(where);
            const terminal = new Set(['succeeded', 'failed', 'skipped', 'timed_out', 'cancelled']);
            return Promise.resolve(
              state.actionRows
                .filter((row) => !terminal.has(row.status)
                  && (row.actionType === 'execute_command' || row.actionType === 'deploy_software'))
                .map((row) => ({ actionIndex: row.actionIndex, actionType: row.actionType })),
            );
          }
          return Promise.resolve([]);
        },
      }),
    }),
  },
  getCurrentDbAccessContext: () => ({ scope: 'system' }),
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

const cancelExecutionsForRunMock = vi.hoisted(() => vi.fn(async () => ({
  requested: 0,
  retracted: 0,
  alreadyCancelling: 0,
  noActionNeeded: 0,
  failed: 0,
})));
vi.mock('./scriptCancellation', () => ({
  cancelExecutionsForRun: cancelExecutionsForRunMock,
}));

const reconcileAutomationRunMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./automationActionResults', () => ({
  reconcileAutomationRun: reconcileAutomationRunMock,
}));

vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import {
  assertRunNotCancelled,
  cancelAutomationRun,
  RunCancelledError,
} from './automationRunCancellation';

const actor = { actorId: 'user-1', actorLabel: 'tech@example.com' };

beforeEach(() => {
  state.run = { id: 'run-1', status: 'running' };
  state.actionRows = [];
  state.fenceQueries = [];
  state.runUpdatePatches = [];
  state.runUpdateWheres = [];
  state.actionUpdatePatches = [];
  state.actionUpdateWheres = [];
  state.actionSelectWheres = [];
  state.cancelledActionIds = [];
  cancelExecutionsForRunMock.mockClear();
  reconcileAutomationRunMock.mockReset().mockResolvedValue(undefined);
  cancelExecutionsForRunMock.mockResolvedValue({
    requested: 0, retracted: 0, alreadyCancelling: 0, noActionNeeded: 0, failed: 0,
  });
});

describe('dispatch fence', () => {
  it('assertRunNotCancelled takes FOR SHARE on the run row inside the caller tx', async () => {
    const tx = makeTx();
    await assertRunNotCancelled(tx, 'run-1');
    const fence = state.fenceQueries.at(-1)!;
    expect(fence.sql.toLowerCase()).toContain('for share');
    expect(fence.sql.toLowerCase()).toContain('automation_runs');
    // Keyed on the run id, bound rather than interpolated.
    expect(fence.params).toContain('run-1');
  });

  it('throws RunCancelledError once the run is cancelled', async () => {
    state.run = { id: 'run-1', status: 'cancelled' };
    await expect(assertRunNotCancelled(makeTx(), 'run-1')).rejects.toBeInstanceOf(RunCancelledError);
  });

  it('is a no-op for a running run and for a run that no longer exists', async () => {
    await expect(assertRunNotCancelled(makeTx(), 'run-1')).resolves.toBeUndefined();
    state.run = null;
    await expect(assertRunNotCancelled(makeTx(), 'run-1')).resolves.toBeUndefined();
  });
});

describe('cancelAutomationRun', () => {
  it('reports a missing run rather than inventing one', async () => {
    state.run = null;
    await expect(cancelAutomationRun({ runId: 'run-1', ...actor }))
      .resolves.toMatchObject({ kind: 'not_found' });
    expect(cancelExecutionsForRunMock).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed', 'partial'] as const)(
    'refuses to relabel an already-%s run as cancelled',
    async (status) => {
      state.run = { id: 'run-1', status };
      await expect(cancelAutomationRun({ runId: 'run-1', ...actor }))
        .resolves.toMatchObject({ kind: 'already_terminal', status });
      expect(state.runUpdatePatches).toHaveLength(0);
      expect(cancelExecutionsForRunMock).not.toHaveBeenCalled();
    },
  );

  it('sets the run cancelled and appends the log entry atomically with jsonb ||', async () => {
    await cancelAutomationRun({ runId: 'run-1', ...actor });
    const patch = state.runUpdatePatches.at(0)!;
    expect(patch.status).toBe('cancelled');
    // Both runners write the whole stale logs array, so a plain set({ logs })
    // would be erased by a concurrent completion.
    expect(renderSql(patch.logs)).toContain('||');
    expect(JSON.stringify(sqlParams(patch.logs))).toContain('tech@example.com');
  });

  it('marks NEVER-DISPATCHED actions cancelled but leaves in-flight ones alone', async () => {
    state.actionRows = [
      { id: 'a-0', actionIndex: 0, actionType: 'run_script', status: 'running' },
      { id: 'a-1', actionIndex: 1, actionType: 'run_script', status: 'pending' },
    ];
    const out = await cancelAutomationRun({ runId: 'run-1', ...actor });
    expect(out).toMatchObject({ kind: 'cancelled', actionsCancelled: 1 });
    expect(state.cancelledActionIds).toEqual(['a-1']);
    const patch = state.actionUpdatePatches.at(0)!;
    expect(patch).toMatchObject({ status: 'cancelled', terminalSource: 'cancellation' });
    // The predicate, not the mock, is what keeps a running action out of it.
    expect(sqlParams(state.actionUpdateWheres.at(0))).toContain('pending');
  });

  it('fans out keyed on the run id ONLY, never on the caller org', async () => {
    await cancelAutomationRun({ runId: 'run-1', ...actor, graceSeconds: 10 });
    expect(cancelExecutionsForRunMock).toHaveBeenCalledWith({
      runId: 'run-1',
      actorId: 'user-1',
      actorLabel: 'tech@example.com',
      graceSeconds: 10,
    });
    const [[call]] = cancelExecutionsForRunMock.mock.calls as unknown as [[Record<string, unknown>]];
    expect(Object.keys(call)).not.toContain('orgId');
  });

  it('counts requested and retracted executions, not the ones already in flight', async () => {
    cancelExecutionsForRunMock.mockResolvedValue({
      requested: 3, retracted: 2, alreadyCancelling: 4, noActionNeeded: 1, failed: 1,
    });
    const out = await cancelAutomationRun({ runId: 'run-1', ...actor });
    expect(out).toMatchObject({
      kind: 'cancelled',
      executionsCancelled: 5,
      executions: { requested: 3, retracted: 2, alreadyCancelling: 4 },
    });
  });

  it('reports in-flight execute_command and deployment actions as uncancellable', async () => {
    // execute_command deliberately creates NO script_executions row and
    // deployments live in deployment_results, so the UI must not claim the run
    // stopped while one of these is still live.
    state.actionRows = [
      { id: 'a-0', actionIndex: 0, actionType: 'execute_command', status: 'running' },
      { id: 'a-1', actionIndex: 1, actionType: 'deploy_software', status: 'delivered' },
      { id: 'a-2', actionIndex: 2, actionType: 'run_script', status: 'running' },
    ];
    const out = await cancelAutomationRun({ runId: 'run-1', ...actor });
    expect(out).toMatchObject({ kind: 'cancelled' });
    const uncancellable = (out as { uncancellableActions: Array<{ actionType: string; reason: string }> })
      .uncancellableActions;
    expect(uncancellable).toHaveLength(2);
    expect(uncancellable.map((entry) => entry.actionType).sort())
      .toEqual(['deploy_software', 'execute_command']);
    expect(uncancellable.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it('rolls the newly cancelled rows up AFTER the fan-out, so devices_cancelled is real', async () => {
    const order: string[] = [];
    cancelExecutionsForRunMock.mockImplementation(async () => {
      order.push('fanout');
      return { requested: 0, retracted: 0, alreadyCancelling: 0, noActionNeeded: 0, failed: 0 };
    });
    reconcileAutomationRunMock.mockImplementation(async () => { order.push('reconcile'); });
    await cancelAutomationRun({ runId: 'run-1', ...actor });
    expect(order).toEqual(['fanout', 'reconcile']);
  });

  it('still reports success when the follow-up reconcile throws — the stop is already committed', async () => {
    reconcileAutomationRunMock.mockRejectedValue(new Error('Redis down'));
    await expect(cancelAutomationRun({ runId: 'run-1', ...actor }))
      .resolves.toMatchObject({ kind: 'cancelled' });
    // The fence write and the fan-out both happened before reconcile.
    expect(state.runUpdatePatches.at(0)).toMatchObject({ status: 'cancelled' });
    expect(cancelExecutionsForRunMock).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a second cancel re-asks the devices but does not rewrite the run', async () => {
    state.run = { id: 'run-1', status: 'cancelled' };
    const out = await cancelAutomationRun({ runId: 'run-1', ...actor });
    expect(out).toMatchObject({ kind: 'cancelled', alreadyCancelling: true, actionsCancelled: 0 });
    expect(state.runUpdatePatches).toHaveLength(0);
    expect(state.actionUpdatePatches).toHaveLength(0);
    expect(cancelExecutionsForRunMock).toHaveBeenCalledTimes(1);
  });
});
