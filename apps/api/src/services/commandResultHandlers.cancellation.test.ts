import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #3525 W03 closers 1 and 3 — the script result handler's cancellation paths.
 *
 * The harness below is deliberately EVALUATING, not scripted: the fake `db`
 * interprets the real `where()` predicate against a simulated
 * `script_executions` row instead of returning a canned list per call. A
 * scripted mock would answer "which update ran first" by construction and
 * could not tell a correct CAS from one whose predicate silently matches
 * everything — which is the whole risk in a four-way compare-and-swap ladder.
 *
 * To make the predicate readable, the four drizzle combinators this module uses
 * are replaced with plain descriptors; everything else in `drizzle-orm` (notably
 * `sql`, which the schema modules build partial indexes with) stays real.
 */

type LeafCond =
  | { op: 'eq'; col: string; val: unknown }
  | { op: 'inArray'; col: string; vals: unknown[] }
  | { op: 'isNull'; col: string };
type Cond = { op: 'and'; conds: Cond[] } | LeafCond;

const colName = (c: unknown): string =>
  c !== null && typeof c === 'object' && 'name' in (c as Record<string, unknown>)
    ? String((c as { name: unknown }).name)
    : String(c);

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    and: (...conds: unknown[]) => ({ op: 'and', conds: conds.filter(Boolean) }),
    eq: (col: unknown, val: unknown) => ({ op: 'eq', col: colName(col), val }),
    inArray: (col: unknown, vals: unknown[]) => ({ op: 'inArray', col: colName(col), vals }),
    isNull: (col: unknown) => ({ op: 'isNull', col: colName(col) }),
  };
});

const applyCustomFieldsMock = vi.fn().mockResolvedValue(null);
vi.mock('./customFields/scriptWriteBack', () => ({
  applyScriptCustomFieldWrites: (...args: unknown[]) => applyCustomFieldsMock(...args),
}));

const applyAutomationActionTerminalMock = vi.fn().mockResolvedValue(true);
vi.mock('./automationActionResults', () => ({
  applyAutomationActionTerminal: (...args: unknown[]) => applyAutomationActionTerminalMock(...args),
}));

const captureExceptionMock = vi.fn();
vi.mock('./sentry', () => ({ captureException: (...args: unknown[]) => captureExceptionMock(...args) }));

// ── the simulated row + evaluating db mock ────────────────────────────────

type Row = Record<string, unknown>;
let row: Row | null = null;
const updates: Array<{ label: string; values: Row; matched: boolean }> = [];
const markerGuarded: boolean[] = [];

function evalCond(cond: Cond | undefined | null, target: Row): boolean {
  if (!cond) return true;
  switch (cond.op) {
    case 'and': return cond.conds.every((c) => evalCond(c, target));
    case 'eq': return target[cond.col] === cond.val;
    case 'inArray': return cond.vals.includes(target[cond.col]);
    case 'isNull': return target[cond.col] === null || target[cond.col] === undefined;
    default: return true;
  }
}

/** Flatten an AND tree so a label can be derived from the leaf predicates. */
function leaves(cond: Cond | undefined | null): LeafCond[] {
  if (!cond) return [];
  return cond.op === 'and' ? cond.conds.flatMap(leaves) : [cond];
}

function labelOf(cond: Cond | undefined | null): string {
  const ls = leaves(cond);
  const status = ls.find((l) => l.col === 'status');
  if (status?.op === 'eq' && status.val === 'cancelling') return 'cancellation';
  if (status?.op === 'eq' && status.val === 'cancelled') return 'lateOutput';
  if (status?.op === 'inArray' && status.vals.includes('pending')) return 'primary';
  if (status?.op === 'inArray' && status.vals.includes('timeout')) return 'recovery3607';
  return 'unknown';
}

/** True when the CAS additionally pins the agent-reported cancel command id. */
function guardsMarkerCommandId(cond: Cond | undefined | null): boolean {
  return leaves(cond).some((l) => l.col === 'cancel_command_id');
}

vi.mock('../db', () => ({
  db: {
    update: () => ({
      set: (values: Row) => ({
        where: (cond: Cond) => {
          const label = labelOf(cond);
          const matched = row !== null && evalCond(cond, row);
          updates.push({ label, values, matched });
          if (label === 'cancellation') markerGuarded.push(guardsMarkerCommandId(cond));
          if (matched && row) Object.assign(row, values);
          const rows = matched && row ? [{ id: row.id, scriptId: row.script_id }] : [];
          return {
            returning: async () => rows,
            then: (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res),
          };
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (row
            ? [{ status: row.status, exitCode: row.exit_code, deviceId: row.device_id }]
            : []),
        }),
      }),
    }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { commandResultHandlers } from './commandResultHandlers';

const EXEC_ID = '55555555-5555-4555-8555-555555555555';
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const SCRIPT_ID = '22222222-2222-4222-8222-222222222222';
const CC1 = 'cc-1';
const CC2 = 'cc-2';

function seed(overrides: Row): void {
  row = {
    id: EXEC_ID,
    script_id: SCRIPT_ID,
    device_id: DEVICE_ID,
    status: 'running',
    cancel_state: null,
    cancel_command_id: null,
    exit_code: null,
    stdout: null,
    ...overrides,
  };
}

async function handleResult(result: Record<string, unknown>): Promise<void> {
  await commandResultHandlers.script!({
    agentId: '33333333-3333-4333-8333-333333333333',
    command: { id: 'cmd-1', payload: { executionId: EXEC_ID }, type: 'script' } as never,
    commandId: 'cmd-1',
    result: result as never,
    resolvedDeviceId: DEVICE_ID,
    stdout: result.stdout as string | undefined,
  });
}

/** The values of the last update that actually matched a row. */
function lastExecutionUpdate(): Row | undefined {
  return [...updates].reverse().find((u) => u.matched)?.values;
}
const casOrder = () => updates.map((u) => u.label);

beforeEach(() => {
  vi.clearAllMocks();
  applyCustomFieldsMock.mockResolvedValue(null);
  updates.length = 0;
  markerGuarded.length = 0;
  row = null;
});

describe('script result closes a cancelling execution (#3525 closer 1)', () => {
  it('a result carrying the cancellation marker confirms the cancel', async () => {
    seed({ status: 'cancelling', cancel_state: 'requested', cancel_command_id: CC1 });
    await handleResult({ status: 'failed', exitCode: -1, cancelled: true, cancelledByCommandId: CC1 });
    expect(lastExecutionUpdate()).toMatchObject({ status: 'cancelled', cancelState: 'confirmed' });
  });

  it('a marker naming a DIFFERENT cancel command does not confirm', async () => {
    // A stale or retried cancel must not be credited with a kill it did not do.
    seed({ status: 'cancelling', cancel_state: 'requested', cancel_command_id: CC2 });
    await handleResult({ status: 'failed', exitCode: -1, cancelled: true, cancelledByCommandId: CC1 });
    expect(lastExecutionUpdate()).toMatchObject({ cancelState: 'unconfirmed' });
    expect(lastExecutionUpdate()?.status).not.toBe('cancelled');
  });

  it('pins the confirming CAS to the agent-reported cancel command id', async () => {
    seed({ status: 'cancelling', cancel_state: 'requested', cancel_command_id: CC1 });
    await handleResult({ status: 'failed', exitCode: -1, cancelled: true, cancelledByCommandId: CC1 });
    expect(markerGuarded[0]).toBe(true);
  });

  it('an UNMARKED result preserves the real outcome (OD9-C) and records the losing cancel', async () => {
    seed({ status: 'cancelling', cancel_state: 'requested', cancel_command_id: CC1 });
    await handleResult({ status: 'completed', exitCode: 0, stdout: 'done' });
    expect(lastExecutionUpdate()).toMatchObject({ status: 'completed', cancelState: 'unconfirmed', exitCode: 0 });
  });

  it('treats `cancelled: true` with no command id as a request, not a receipt', async () => {
    // A pre-#3525 agent answers the non-blocking signal this way. It is not proof.
    seed({ status: 'cancelling', cancel_state: 'requested', cancel_command_id: CC1 });
    await handleResult({ status: 'failed', exitCode: -1, cancelled: true });
    expect(lastExecutionUpdate()).toMatchObject({ cancelState: 'unconfirmed' });
    expect(lastExecutionUpdate()?.status).not.toBe('cancelled');
  });

  it('the cancellation CAS is ordered BEFORE the #3607 recovery branch', async () => {
    seed({ status: 'cancelling', cancel_state: 'requested', cancel_command_id: CC1 });
    await handleResult({ status: 'completed', exitCode: 0 });
    expect(casOrder()[0]).toBe('cancellation');
  });

  it('does not run the primary CAS once the cancellation CAS closed the row', async () => {
    seed({ status: 'cancelling', cancel_state: 'requested', cancel_command_id: CC1 });
    await handleResult({ status: 'completed', exitCode: 0 });
    expect(casOrder()).not.toContain('primary');
    expect(casOrder()).not.toContain('recovery3607');
  });

  it('closes the automation action as cancelled, not failed, on a confirmed cancel', async () => {
    // The agent reports a killed process as `failed` with exit -1. Passing that
    // straight through would have an automation step read "failed" when the
    // operator stopped it — the same dishonesty the execution row avoids.
    seed({ status: 'cancelling', cancel_state: 'requested', cancel_command_id: CC1 });
    await handleResult({ status: 'failed', exitCode: -1, cancelled: true, cancelledByCommandId: CC1 });
    expect(applyAutomationActionTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({ terminalStatus: 'cancelled' }),
    );
  });

  it('closes the automation action with the REAL outcome on an unconfirmed cancel', async () => {
    seed({ status: 'cancelling', cancel_state: 'requested', cancel_command_id: CC1 });
    await handleResult({ status: 'completed', exitCode: 0, stdout: 'done' });
    expect(applyAutomationActionTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({ terminalStatus: 'succeeded' }),
    );
  });

  it('leaves a non-cancelling execution on the ordinary primary CAS', async () => {
    seed({ status: 'running' });
    await handleResult({ status: 'completed', exitCode: 0, stdout: 'ok' });
    expect(casOrder()).toContain('primary');
    expect(lastExecutionUpdate()).toMatchObject({ status: 'completed' });
    expect(lastExecutionUpdate()?.cancelState).toBeUndefined();
  });
});

describe('late original result after a terminal cancel (#3525 closer 3)', () => {
  it('fills stdout/stderr/exit_code but does NOT change status', async () => {
    seed({ status: 'cancelled', cancel_state: 'confirmed', cancel_command_id: CC1 });
    await handleResult({ status: 'completed', exitCode: 0, stdout: 'partial output' });
    const patch = lastExecutionUpdate();
    expect(patch).toMatchObject({ stdout: 'partial output', exitCode: 0 });
    expect(patch?.status).toBeUndefined();
    expect(patch?.cancelState).toBeUndefined();
  });

  it('is NOT gated on cancel_state — a confirmed cancel still recovers output', async () => {
    seed({ status: 'cancelled', cancel_state: 'confirmed', cancel_command_id: CC1 });
    await handleResult({ status: 'completed', exitCode: 0, stdout: 'x' });
    expect(lastExecutionUpdate()?.stdout).toBe('x');
    // and no captureException: the old code alerted on every non-cancelled miss
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('only fills an execution that has no exit code yet', async () => {
    seed({ status: 'cancelled', cancel_state: 'confirmed', exit_code: 0, stdout: 'first' });
    await handleResult({ status: 'completed', exitCode: 9, stdout: 'second' });
    expect(updates.find((u) => u.label === 'lateOutput')?.matched).toBe(false);
    expect(row?.stdout).toBe('first');
  });

  it('does not re-run batch accounting or applyAutomationActionTerminal', async () => {
    seed({ status: 'cancelled', cancel_state: 'confirmed' });
    await handleResult({ status: 'completed', exitCode: 0, stdout: 'x' });
    expect(applyAutomationActionTerminalMock).not.toHaveBeenCalled();
  });

  it('still applies script custom-field writes (the script really did run)', async () => {
    seed({ status: 'cancelled', cancel_state: 'confirmed' });
    await handleResult({ status: 'completed', exitCode: 0, stdout: 'x' });
    expect(applyCustomFieldsMock).toHaveBeenCalled();
  });

  it('still reports a late result that matched nothing at all', async () => {
    // The #3162/#3607 lesson: report, never skip quietly. Only `cancelled` is benign.
    seed({ status: 'completed', exit_code: 0, stdout: 'already here' });
    await handleResult({ status: 'completed', exitCode: 0, stdout: 'late' });
    expect(captureExceptionMock).toHaveBeenCalled();
  });
});
