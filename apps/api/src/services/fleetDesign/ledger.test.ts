import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fake Drizzle executor (pattern: services/deviceFunction.test.ts). A FIFO
 * queue of result rows is consumed on every `.from()` call in call order;
 * chain calls (`.where`, `.limit`, `.for`, `.orderBy`, `.onConflictDoNothing`,
 * `.returning`) are captured on the matching entry so tests can assert the
 * SHAPE of the statement, not just its result.
 */
interface SelectEntry { table: unknown; seq: number; where?: unknown; limit?: number; lockMode?: string; lockOf?: unknown; orderBy?: unknown[] }
interface InsertEntry { table: unknown; values: Record<string, unknown>; seq: number; conflict?: boolean }
interface UpdateEntry { table: unknown; set: Record<string, unknown>; where?: unknown; seq: number }
interface Capture { selects: SelectEntry[]; inserts: InsertEntry[]; updates: UpdateEntry[] }

function thenable(rows: Array<Record<string, unknown>>, entry: SelectEntry) {
  const p = Promise.resolve(rows) as Promise<Array<Record<string, unknown>>> & Record<string, unknown>;
  p.limit = (n: number) => { entry.limit = n; return thenable(rows.slice(0, n), entry); };
  p.for = (mode: string, opts?: { of?: unknown }) => { entry.lockMode = mode; entry.lockOf = opts?.of; return thenable(rows, entry); };
  p.orderBy = (...cols: unknown[]) => { entry.orderBy = cols; return thenable(rows, entry); };
  return p;
}

function makeExec(rowQueue: Array<Array<Record<string, unknown>>>) {
  const q = [...rowQueue];
  const calls: Capture = { selects: [], inserts: [], updates: [] };
  let seq = 0;
  const exec = {
    select: (_proj?: unknown) => ({
      from: (table: unknown) => {
        const rows = q.shift() ?? [];
        const entry: SelectEntry = { table, seq: (seq += 1) };
        calls.selects.push(entry);
        const chain = {
          where: (cond: unknown) => { entry.where = cond; return thenable(rows, entry); },
          innerJoin: () => chain,
        };
        return chain;
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const entry: InsertEntry = { table, values, seq: (seq += 1) };
        calls.inserts.push(entry);
        return {
          onConflictDoNothing: () => {
            entry.conflict = true;
            return { returning: () => Promise.resolve(q.shift() ?? []) };
          },
          returning: () => Promise.resolve(q.shift() ?? []),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        const entry: UpdateEntry = { table, set, seq: (seq += 1) };
        calls.updates.push(entry);
        return { where: (cond: unknown) => { entry.where = cond; return Promise.resolve(); } };
      },
    }),
  };
  return { exec, calls };
}

const holder: { exec: ReturnType<typeof makeExec>['exec'] | null } = { exec: null };
vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => (holder.exec as unknown as { select: (...a: unknown[]) => unknown }).select(...args),
    insert: (...args: unknown[]) => (holder.exec as unknown as { insert: (...a: unknown[]) => unknown }).insert(...args),
    update: (...args: unknown[]) => (holder.exec as unknown as { update: (...a: unknown[]) => unknown }).update(...args),
  },
}));

import {
  findReusableGroup,
  loadLedger,
  lockReportRun,
  markRolledBack,
  recordApplied,
  recordFailed,
  toLedgerItem,
  updateCreatedRefs,
  type FleetDesignLedgerRow,
} from './ledger';
import { deviceGroups, reportRuns } from '../../db/schema';

const ORG = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

function seed(rows: Array<Array<Record<string, unknown>>>) {
  const made = makeExec(rows);
  holder.exec = made.exec;
  return made.calls;
}

beforeEach(() => { holder.exec = null; });

describe('recordApplied', () => {
  it('inserts through onConflictDoNothing and returns the row on the first write', async () => {
    const ROW = { id: 'row-1', reportRunId: RUN, itemRef: 'functions:file_server', itemKind: 'function', step: 1 };
    const calls = seed([[ROW]]);
    const result = await recordApplied({ orgId: ORG, reportRunId: RUN, itemRef: 'functions:file_server', itemKind: 'function', step: 1, userId: USER });
    expect(result).toEqual(ROW);
    expect(calls.inserts).toHaveLength(1);
    expect(calls.inserts[0]!.conflict).toBe(true);
  });

  it('returns null when the (report_run_id, item_ref) conflict fires, with no thrown error and no second row created', async () => {
    const ROW = { id: 'row-1', reportRunId: RUN, itemRef: 'functions:file_server', itemKind: 'function', step: 1 };
    // First insert wins; the second returns no row (the DB suppressed the conflict via onConflictDoNothing).
    const calls = seed([[ROW], []]);
    const first = await recordApplied({ orgId: ORG, reportRunId: RUN, itemRef: 'functions:file_server', itemKind: 'function', step: 1, userId: USER });
    const second = await recordApplied({ orgId: ORG, reportRunId: RUN, itemRef: 'functions:file_server', itemKind: 'function', step: 1, userId: USER });
    expect(first).toEqual(ROW);
    expect(second).toBeNull();
    // Both attempts go through the conflict-safe path — neither raises.
    expect(calls.inserts).toHaveLength(2);
    expect(calls.inserts.every((i) => i.conflict)).toBe(true);
  });

  it('defaults createdRefs to {} and beforeImage to null when omitted', async () => {
    const calls = seed([[{ id: 'row-1' }]]);
    await recordApplied({ orgId: ORG, reportRunId: RUN, itemRef: 'retired:0', itemKind: 'retired', step: 2, userId: USER });
    expect(calls.inserts[0]!.values).toMatchObject({ createdRefs: {}, beforeImage: null, status: 'applied' });
  });
});

describe('recordFailed', () => {
  it('stores status failed and truncates the error to 500 characters', async () => {
    const longError = 'x'.repeat(600);
    const calls = seed([[{ id: 'row-2' }]]);
    await recordFailed({ orgId: ORG, reportRunId: RUN, itemRef: 'step:3', itemKind: 'policy', step: 3, error: longError, userId: USER });
    expect(calls.inserts[0]!.values.status).toBe('failed');
    expect((calls.inserts[0]!.values.error as string)).toHaveLength(500);
  });

  it('also goes through onConflictDoNothing and returns null on a repeat write for the same ref', async () => {
    const calls = seed([[{ id: 'row-2' }], []]);
    const first = await recordFailed({ orgId: ORG, reportRunId: RUN, itemRef: 'step:3', itemKind: 'policy', step: 3, error: 'boom', userId: USER });
    const second = await recordFailed({ orgId: ORG, reportRunId: RUN, itemRef: 'step:3', itemKind: 'policy', step: 3, error: 'boom again', userId: USER });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(calls.inserts.every((i) => i.conflict)).toBe(true);
  });
});

describe('findReusableGroup', () => {
  it('returns null immediately when there is no applied function ledger row (no second query)', async () => {
    const calls = seed([[]]);
    const result = await findReusableGroup(ORG, 'file_server');
    expect(result).toBeNull();
    expect(calls.selects).toHaveLength(1);
  });

  it('ignores a candidate groupId that no longer exists in device_groups, falling through to the next alive candidate', async () => {
    const calls = seed([
      [{ createdRefs: { groupId: 'g-deleted' } }, { createdRefs: { groupId: 'g-alive' } }],
      [{ id: 'g-alive' }],
    ]);
    const result = await findReusableGroup(ORG, 'file_server');
    expect(result).toEqual({ groupId: 'g-alive' });
    expect(calls.selects[1]!.table).toBe(deviceGroups);
  });

  it('returns null when every candidate group has been deleted', async () => {
    const calls = seed([
      [{ createdRefs: { groupId: 'g-deleted-1' } }, { createdRefs: { groupId: 'g-deleted-2' } }],
      [],
    ]);
    const result = await findReusableGroup(ORG, 'file_server');
    expect(result).toBeNull();
    expect(calls.selects).toHaveLength(2);
  });
});

describe('lockReportRun', () => {
  it('locks report_runs FOR UPDATE and returns null when no row matches', async () => {
    const calls = seed([[]]);
    const result = await lockReportRun(RUN, () => undefined);
    expect(result).toBeNull();
    const entry = calls.selects[0]!;
    expect(entry.lockMode).toBe('update');
    expect(entry.lockOf).toBe(reportRuns);
  });

  it('returns the org id and the stored outcome from the summary in one round trip', async () => {
    const outcome = { schemaVersion: 1 };
    const calls = seed([[{ reportRunId: RUN, reportId: 'report-1', orgId: ORG, summary: { fleetDesign: { outcome } } }]]);
    const result = await lockReportRun(RUN, () => undefined);
    expect(result).toEqual({ reportRunId: RUN, reportId: 'report-1', orgId: ORG, summary: { fleetDesign: { outcome } }, outcome });
    expect(calls.selects[0]!.lockMode).toBe('update');
  });

  it('resolves outcome to null (not undefined-throw) when the summary carries no fleetDesign key', async () => {
    seed([[{ reportRunId: RUN, reportId: 'report-1', orgId: ORG, summary: null }]]);
    const result = await lockReportRun(RUN, () => undefined);
    expect(result).toEqual({ reportRunId: RUN, reportId: 'report-1', orgId: ORG, summary: null, outcome: null });
  });
});

describe('toLedgerItem', () => {
  const BASE = {
    id: 'x', itemRef: 'functions:file_server', itemKind: 'function', status: 'applied', step: 1,
    createdRefs: { groupId: 'g1' }, error: null,
    appliedAt: new Date('2026-09-01T00:00:00Z'), rolledBackAt: null,
    orgId: ORG, reportRunId: RUN, beforeImage: null, appliedByUserId: USER, rolledBackByUserId: null,
  } as unknown as FleetDesignLedgerRow;

  it('converts Date fields to ISO strings and defaults nullable fields', () => {
    expect(toLedgerItem(BASE)).toEqual({
      id: 'x', itemRef: 'functions:file_server', itemKind: 'function', status: 'applied', step: 1,
      createdRefs: { groupId: 'g1' }, error: null,
      appliedAt: '2026-09-01T00:00:00.000Z', rolledBackAt: null,
    });
  });

  it('formats rolledBackAt when the row has been rolled back', () => {
    const row = { ...BASE, status: 'rolled_back', rolledBackAt: new Date('2026-09-02T00:00:00Z') } as unknown as FleetDesignLedgerRow;
    expect(toLedgerItem(row).rolledBackAt).toBe('2026-09-02T00:00:00.000Z');
  });

  it('falls back to {} when createdRefs is missing', () => {
    const row = { ...BASE, createdRefs: null } as unknown as FleetDesignLedgerRow;
    expect(toLedgerItem(row).createdRefs).toEqual({});
  });
});

describe('markRolledBack', () => {
  it('does nothing and issues no update when ids is empty', async () => {
    const calls = seed([]);
    await markRolledBack([], ORG, USER);
    expect(calls.updates).toHaveLength(0);
  });

  it('sets status rolled_back and rolledBackAt for the given ids, scoped to still-applied rows', async () => {
    const calls = seed([]);
    await markRolledBack(['id-1', 'id-2'], ORG, USER);
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0]!.set.status).toBe('rolled_back');
    expect(calls.updates[0]!.set.rolledBackByUserId).toBe(USER);
    expect(calls.updates[0]!.set.rolledBackAt).toBeInstanceOf(Date);
  });
});

describe('updateCreatedRefs', () => {
  it('writes only createdRefs, leaving every other column untouched', async () => {
    const calls = seed([]);
    await updateCreatedRefs('row-1', ORG, { policyId: 'p1' });
    expect(calls.updates[0]!.set).toEqual({ createdRefs: { policyId: 'p1' } });
  });
});

describe('loadLedger', () => {
  it('returns every row for the (reportRunId, orgId) pair, ordered by step then appliedAt', async () => {
    const ROWS = [{ id: 'a' }, { id: 'b' }];
    const calls = seed([ROWS]);
    const result = await loadLedger(RUN, ORG);
    expect(result).toBe(ROWS);
    expect(calls.selects[0]!.orderBy).toBeDefined();
  });
});

describe('explicit apply ledger executor', () => {
  it('records, refreshes and finds the group on the supplied savepoint', async () => {
    const ambient = makeExec([]);
    holder.exec = ambient.exec;
    const tx = makeExec([
      [{ id: 'ledger-row' }],
      [{ createdRefs: { groupId: 'group-1' } }],
      [{ id: 'group-1' }],
    ]);
    const executor = tx.exec as unknown as NonNullable<Parameters<typeof recordApplied>[1]>;
    await recordApplied({ orgId: ORG, reportRunId: RUN, itemRef: 'functions:file_server', itemKind: 'function', step: 1, userId: USER }, executor);
    await updateCreatedRefs('ledger-row', ORG, { groupId: 'group-1' }, executor);
    expect(await findReusableGroup(ORG, 'file_server', executor)).toEqual({ groupId: 'group-1' });
    expect(tx.calls.inserts).toHaveLength(1);
    expect(tx.calls.updates).toHaveLength(1);
    expect(tx.calls.selects).toHaveLength(2);
    expect(ambient.calls).toEqual({ selects: [], inserts: [], updates: [] });
  });
});
