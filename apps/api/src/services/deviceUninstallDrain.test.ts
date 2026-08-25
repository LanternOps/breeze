import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

// Real drizzle-orm + real schema throughout this suite (deliberately NOT
// mocked): the security-critical WHERE clauses (the `device_remove` reason
// filter, the deadline filter) are asserted on COMPILED SQL via
// `new PgDialect().sqlToQuery(...)`, matching `routes/devices/network.test.ts`
// and `services/siteScope.test.ts`. A test that only asserts
// `expect(where).toHaveBeenCalled()` would pass identically whether the code
// wrote `eq()`, `ne()`, or the wrong column — this codebase has shipped that
// exact vacuous-assertion bug before.

const selectMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    transaction: (...args: unknown[]) => transactionMock(...args),
  },
}));

const ERASURE_MARKER = { __erased: true };
vi.mock('./sensitiveCommandPayload', () => ({
  terminalPayloadErasureSet: vi.fn(() => ({ payload: ERASURE_MARKER })),
}));

import { deviceCommands, devices } from '../db/schema';
import {
  DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS,
  UNINSTALL_REASON_DEVICE_REMOVE,
  isDeviceUninstallDraining,
  queueDeviceUninstall,
  releaseDeviceRemoveReason,
} from './deviceUninstallDrain';

const dialect = new PgDialect();

/**
 * A chainable `.from()/.innerJoin()/.where()/.limit()/.for()` surface where
 * every link is both awaitable (resolves to `rows`) AND continues the chain,
 * mirroring `tenantOffboarding.test.ts`'s `queueSelect` helper. Captures the
 * condition passed to `.where()` for compiled-SQL assertions.
 */
function rigSelect(rows: unknown[]): { where: () => unknown } {
  const captured: { where?: unknown } = {};
  const chain: Record<string, any> = {};
  for (const method of ['from', 'innerJoin', 'limit', 'for']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(rows), chain));
  }
  chain.where = vi.fn((cond: unknown) => {
    captured.where = cond;
    return Object.assign(Promise.resolve(rows), chain);
  });
  selectMock.mockReturnValueOnce(Object.assign(Promise.resolve(rows), chain));
  return { where: () => captured.where };
}

function sqlOf(cond: unknown) {
  return dialect.sqlToQuery(cond as never);
}

/**
 * Asserts the compiled SQL is a flat `expectedClauseCount`-way CONJUNCTION
 * (AND), not a disjunction (OR) or anything else.
 *
 * Why this exists (and why `toContain('"foo" = $1')`-style substring checks
 * are NOT enough on their own): `and(a, b, c, d, e, f)` and
 * `or(a, b, c, d, e, f)` compile to text containing every one of `a..f` as a
 * substring either way — they only differ in the JOINER between fragments
 * (`" and "` vs `" or "`). A regression that flips the top-level `and(...)`
 * in `deviceUninstallDrain.ts` to `or(...)` would leave every
 * `toContain(...)` assertion in this file green while silently turning the
 * drain predicate into "decommissioned OR self_uninstall OR ... OR
 * unexpired" — which an abuse-queued row (no `device_remove` reason) can
 * satisfy on the `status`/`type` clauses alone. That is the exact incident
 * this module exists to prevent, so the operator itself — not just the
 * clause substrings — must be under test. Do not "simplify" this back to a
 * bag of `toContain` checks.
 *
 * None of the six leaf predicates here (`eq`, `inArray`, `arrayContains`,
 * `gt`) can themselves emit the literal strings `" and "` or `" or "`, so
 * splitting the whole compiled string on `" and "` reliably counts top-level
 * conjuncts, and a bare `" or "` substring can only appear if the top-level
 * operator itself changed.
 */
function assertConjunction(sqlText: string, expectedClauseCount: number) {
  expect(sqlText).not.toContain(' or ');
  expect(sqlText.split(' and ')).toHaveLength(expectedClauseCount);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isDeviceUninstallDraining — the shared predicate', () => {
  it('compiles a 6-way CONJUNCTION requiring decommissioned + self_uninstall + pending/sent + the device_remove reason + an unexpired deadline', async () => {
    const rig = rigSelect([]);

    await isDeviceUninstallDraining('device-1');

    const built = sqlOf(rig.where());
    const sqlText = built.sql.toLowerCase();

    // The operator itself: AND, not OR — see assertConjunction's doc for why
    // this is asserted structurally rather than just via substring checks.
    assertConjunction(sqlText, 6);

    // status = 'decommissioned' on devices
    expect(sqlText).toContain('"status" = $');
    expect(built.params).toContain('decommissioned');

    // type = 'self_uninstall', status in ('pending','sent')
    expect(sqlText).toContain('"type" = $');
    expect(built.params).toContain('self_uninstall');
    expect(sqlText).toMatch(/"status" in \(\$\d+, \$\d+\)/);
    expect(built.params).toContain('pending');
    expect(built.params).toContain('sent');

    // THE incident guard: uninstall_reasons @> ARRAY['device_remove'] — never
    // bare presence of a pending self_uninstall. This is the clause that must
    // fail this test if someone drops it.
    expect(sqlText).toContain('"uninstall_reasons" @> $');
    // Postgres array-literal binding — assert the reason value is actually
    // bound rather than relying on exact literal formatting.
    expect(built.params.some((p) => typeof p === 'string' && p.includes(UNINSTALL_REASON_DEVICE_REMOVE))).toBe(true);

    // device_remove_expires_at > now() — closes the drain without a sweeper.
    expect(sqlText).toContain('"device_remove_expires_at" > now()');
  });

  it('returns true when a matching row is found', async () => {
    rigSelect([{ id: 'cmd-1' }]);
    await expect(isDeviceUninstallDraining('device-1')).resolves.toBe(true);
  });

  it('returns false when no matching row is found', async () => {
    rigSelect([]);
    await expect(isDeviceUninstallDraining('device-1')).resolves.toBe(false);
  });

  // The two tests below are named exactly as the task-6 brief specifies —
  // the name IS the incident it guards, so it survives a refactor instead of
  // being deleted as "redundant" with the general compiled-SQL test above.
  //
  // `db.select` is mocked in this file (see the file-header comment), so the
  // WHERE clause below is never actually evaluated against real rows here —
  // these tests assert the COMPILED-SQL facts that make each scenario
  // impossible, not a live run against Postgres. Real behavioural coverage
  // of this predicate's row-level semantics (NULL/empty-array
  // `uninstall_reasons`, an actually-expired timestamp) against a live
  // database belongs in the integration suite — a later task — not here.

  it('is NOT draining for an abuse-queued uninstall (no device_remove reason)', async () => {
    // The incident guard (see module doc + assertConjunction doc): abuse.ts
    // queues a bare self_uninstall with NO reason stamped (uninstall_reasons
    // IS NULL, the fail-closed default). `NULL @> ARRAY[...]` is NULL (not
    // true) in Postgres, so this clause alone excludes every abuse-queued
    // row — but only because it is AND-ed, not OR-ed, with the rest of the
    // predicate, and only because it is present at all.
    const rig = rigSelect([]);

    await isDeviceUninstallDraining('device-1');

    const built = sqlOf(rig.where());
    const sqlText = built.sql.toLowerCase();

    // Structural: the reason clause is one REQUIRED conjunct among six, not
    // an alternative a status-only match could satisfy without it.
    assertConjunction(sqlText, 6);
    expect(sqlText).toContain('"uninstall_reasons" @> $');
    expect(built.params.some((p) => typeof p === 'string' && p.includes(UNINSTALL_REASON_DEVICE_REMOVE))).toBe(true);
  });

  it('is NOT draining once device_remove_expires_at has passed', async () => {
    // Closes the drain without needing a separate sweeper job: once the
    // deadline is in the past, `device_remove_expires_at > now()` is false,
    // and — because it is AND-ed with the rest of the predicate, not OR-ed —
    // that alone is enough to exclude the row regardless of how the other
    // clauses evaluate.
    const rig = rigSelect([]);

    await isDeviceUninstallDraining('device-1');

    const built = sqlOf(rig.where());
    const sqlText = built.sql.toLowerCase();

    assertConjunction(sqlText, 6);
    // Strict `>` (not `>=`/missing entirely): a deadline equal to `now()` at
    // read time is already expired, not still draining.
    expect(sqlText).toContain('"device_remove_expires_at" > now()');
  });
});

/**
 * Fake caller-owned transaction handle for `queueDeviceUninstall`, which
 * takes `tx` as an explicit parameter rather than opening its own
 * transaction (the device-remove route composes this into its own
 * decommission-write transaction).
 */
function createFakeTx() {
  const updateLog: { values: Record<string, unknown>; where: unknown }[] = [];
  const insertLog: Record<string, unknown>[] = [];
  // Rows are bound at the moment `tx.select()` itself is called (one queue
  // entry per call, in call order) — mirrors `tenantOffboarding.test.ts`'s
  // `queueSelect` helper, and avoids the earlier bug of re-dequeuing on
  // every subsequent chained call (`.where()`, `.for()`, ...) instead of once
  // per `select()`.
  const selectQueue: unknown[][] = [];
  // One record per `tx.select()` call, IN CALL ORDER, capturing what that
  // select was actually given. The earlier version of this helper built
  // `where`/`for` as throwaway `vi.fn`s that nothing ever read, so the two
  // things the caller most needs to be true — the row lock exists, and each
  // WHERE is the right one — were both unobservable: deleting `.for('update')`
  // or dropping a WHERE conjunct left this suite green. Index IS call order,
  // so `selectCalls[0]` being the `devices` lock also proves it ran BEFORE the
  // `device_commands` read.
  const selectCalls: { from?: unknown; where?: unknown; forArgs?: unknown[] }[] = [];

  const tx = {
    select: vi.fn(() => {
      const rows = selectQueue.shift() ?? [];
      const record: { from?: unknown; where?: unknown; forArgs?: unknown[] } = {};
      selectCalls.push(record);
      const chain: Record<string, any> = {};
      const settle = () => Object.assign(Promise.resolve(rows), chain);
      chain.from = vi.fn((table: unknown) => {
        record.from = table;
        return settle();
      });
      chain.where = vi.fn((condition: unknown) => {
        record.where = condition;
        return settle();
      });
      chain.for = vi.fn((...args: unknown[]) => {
        record.forArgs = args;
        return settle();
      });
      return chain;
    }),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn((where: unknown) => {
          updateLog.push({ values, where });
          return Promise.resolve([]);
        }),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (row: Record<string, unknown>) => {
        insertLog.push(row);
      }),
    })),
  };

  return {
    tx,
    updateLog,
    insertLog,
    selectCalls,
    queueSelect(rows: unknown[]) {
      selectQueue.push(rows);
    },
  };
}

describe('queueDeviceUninstall', () => {
  it('queues one pending self_uninstall stamped device_remove with a deadline', async () => {
    const fake = createFakeTx();
    fake.queueSelect([{ id: 'device-1' }]); // devices FOR UPDATE
    fake.queueSelect([]); // no existing self_uninstall

    const before = Date.now();
    const result = await queueDeviceUninstall(fake.tx as never, 'device-1', 'user-1');
    const after = Date.now();

    expect(result).toEqual({ queued: true, mergedIntoExisting: false });
    expect(fake.insertLog).toHaveLength(1);
    const row = fake.insertLog[0]!;
    expect(row).toMatchObject({
      deviceId: 'device-1',
      type: 'self_uninstall',
      payload: { removeConfig: true },
      status: 'pending',
      targetRole: 'agent',
      createdBy: 'user-1',
      uninstallReasons: [UNINSTALL_REASON_DEVICE_REMOVE],
    });
    const deadline = row.deviceRemoveExpiresAt as Date;
    expect(deadline).toBeInstanceOf(Date);
    const expectedMs = DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS * 60 * 60 * 1000;
    expect(deadline.getTime()).toBeGreaterThanOrEqual(before + expectedMs - 1000);
    expect(deadline.getTime()).toBeLessThanOrEqual(after + expectedMs + 1000);
    expect(fake.updateLog).toHaveLength(0);
  });

  it('MERGES into an existing tenant-offboarding uninstall instead of inserting a second row', async () => {
    const fake = createFakeTx();
    fake.queueSelect([{ id: 'device-1' }]); // devices FOR UPDATE
    fake.queueSelect([
      { id: 'cmd-1', uninstallReasons: ['tenant_offboarding'], deviceRemoveExpiresAt: null },
    ]);

    const result = await queueDeviceUninstall(fake.tx as never, 'device-1', 'user-1');

    expect(result).toEqual({ queued: false, mergedIntoExisting: true });
    expect(fake.insertLog).toHaveLength(0);
    expect(fake.updateLog).toHaveLength(1);
    const update = fake.updateLog[0]!;
    expect(update.values.uninstallReasons).toEqual(['tenant_offboarding', UNINSTALL_REASON_DEVICE_REMOVE]);
    expect(update.values.deviceRemoveExpiresAt).toBeInstanceOf(Date);

    // ...ONTO THAT ROW AND NOTHING ELSE. This UPDATE stamps `device_remove`
    // AND a fresh 72h deadline, i.e. it hands out the drain exemption itself,
    // and `device_commands` has no RLS to bound it. Swapping the row-id scope
    // for `eq(type, 'self_uninstall')` left all 41 tests here and in
    // core.decommission.test.ts green while granting that exemption to every
    // non-terminal self_uninstall in the table, across every tenant —
    // including the abuse-suspension rows this module's header exists to keep
    // out. They would then survive the reaper and deliver on un-suspension:
    // the same fleet-wide incident as the sibling merge loop in
    // tenantOffboarding.ts, reached from the opposite direction.
    const mergeWhere = sqlOf(update.where);
    expect(mergeWhere.sql.toLowerCase()).toContain('"id" = $');
    expect(mergeWhere.sql.toLowerCase()).not.toContain('"type"');
    expect(mergeWhere.params).toEqual(['cmd-1']);
  });

  it('preserves an already-set deadline on a retried device-remove call (does not push the window out)', async () => {
    const fake = createFakeTx();
    const existingDeadline = new Date('2026-09-01T00:00:00.000Z');
    fake.queueSelect([{ id: 'device-1' }]);
    fake.queueSelect([
      { id: 'cmd-1', uninstallReasons: [UNINSTALL_REASON_DEVICE_REMOVE], deviceRemoveExpiresAt: existingDeadline },
    ]);

    await queueDeviceUninstall(fake.tx as never, 'device-1', 'user-1');

    expect(fake.updateLog[0]!.values.deviceRemoveExpiresAt).toBe(existingDeadline);
    expect(fake.updateLog[0]!.values.uninstallReasons).toEqual([UNINSTALL_REASON_DEVICE_REMOVE]);
  });

  it('locks the devices row FOR UPDATE before reading/writing device_commands (concurrency contract)', async () => {
    const fake = createFakeTx();
    fake.queueSelect([{ id: 'device-1' }]);
    fake.queueSelect([]);

    await queueDeviceUninstall(fake.tx as never, 'device-1', null);

    // Two independent .select() calls: the FOR UPDATE lock, then the
    // existing-row read.
    expect(fake.tx.select).toHaveBeenCalledTimes(2);
    expect(fake.selectCalls).toHaveLength(2);

    // THE LOCK ITSELF. A unique index on device_commands was deliberately
    // declined upstream (module doc, and tenantOffboarding.ts's comment on
    // queueDrainUninstalls: it would break abuse.ts's bulk insert), so this
    // row lock is the ONLY thing standing between two concurrent Removes and
    // a pair of duplicate self_uninstall rows. Integration cannot cover that
    // deterministically, which makes this assertion the whole guard — assert
    // the ARGUMENT too, since `.for('share')` would not serialise writers.
    const [lockSelect, existingSelect] = fake.selectCalls;
    expect(lockSelect!.forArgs).toEqual(['update']);

    // The lock is on DEVICES. Asserting only the WHERE column and `for()`
    // would still pass if the lock were moved onto `device_commands` — which
    // locks the wrong rows entirely: two concurrent Removes of a device with
    // no existing command would each lock nothing and both insert.
    expect(lockSelect!.from).toBe(devices);
    expect(existingSelect!.from).toBe(deviceCommands);

    // ...and that the lock is on the DEVICES select, not the command read:
    // `selectCalls` is in call order, so proving index 0 is the devices row
    // lock proves it ran BEFORE any device_commands work.
    const lockSql = sqlOf(lockSelect!.where).sql.toLowerCase();
    expect(lockSql).toContain('"id" = $');
    expect(lockSql).not.toContain('"device_id"');
    expect(sqlOf(lockSelect!.where).params).toEqual(['device-1']);

    // The second select is the device_commands read, and it is NOT locked
    // (the devices row lock is what serialises; a second FOR UPDATE here
    // would lock command rows for no reason).
    expect(existingSelect!.forArgs).toBeUndefined();
    expect(sqlOf(existingSelect!.where).sql.toLowerCase()).toContain('"device_id" = $');
  });

  it('scopes BOTH reads: the lock to this device row, the existing-row lookup to this device + self_uninstall + pending (compiled SQL)', async () => {
    // Dropping `eq(deviceCommands.type, 'self_uninstall')` from the lookup
    // used to leave this suite AND core.decommission.test.ts green, because
    // `chain.where` captured nothing. With that conjunct gone, Removing a
    // device that has any other pending command (a script run, a backup job)
    // stamps `uninstall_reasons=['device_remove']` and a 72h deadline onto
    // THAT row, returns mergedIntoExisting -> uninstallQueued:true, and never
    // queues an uninstall at all — while corrupting an unrelated command.
    const fake = createFakeTx();
    fake.queueSelect([{ id: 'device-1' }]);
    fake.queueSelect([]);

    await queueDeviceUninstall(fake.tx as never, 'device-1', null);

    const existingBuilt = sqlOf(fake.selectCalls[1]!.where);
    const existingSql = existingBuilt.sql.toLowerCase();

    // Three REQUIRED conjuncts — an OR here would match half of
    // device_commands, exactly as it would in the strip UPDATE below.
    assertConjunction(existingSql, 3);
    expect(existingSql).toContain('"device_id" = $');
    expect(existingBuilt.params).toContain('device-1');
    expect(existingSql).toContain('"type" = $');
    expect(existingBuilt.params).toContain('self_uninstall');
    expect(existingSql).toContain('"status" = $');
    expect(existingBuilt.params).toContain('pending');
  });

  it('merges ONLY into a pending row — never into a sent one (a sent row can never be claimed again)', async () => {
    // `claimPendingCommandsForDevice` claims `pending` and nothing else, so a
    // `sent` row is not a row this Remove can rely on for delivery. Merging
    // into one would open a fresh 72h authenticated window around a command
    // the agent can never be handed again. Asserted on compiled SQL because
    // the mocked tx returns whatever rows a test scripts REGARDLESS of the
    // WHERE — a behavioural test here could not tell the two apart.
    const fake = createFakeTx();
    fake.queueSelect([{ id: 'device-1' }]);
    fake.queueSelect([]);

    await queueDeviceUninstall(fake.tx as never, 'device-1', null);

    const built = sqlOf(fake.selectCalls[1]!.where);
    // Equality on one status, not `IN ('pending','sent')`.
    expect(built.sql.toLowerCase()).toContain('"status" = $');
    expect(built.sql.toLowerCase()).not.toMatch(/"status" in \(/);
    expect(built.params).toContain('pending');
    expect(built.params).not.toContain('sent');
  });

  it('is a no-op when the device row does not exist', async () => {
    const fake = createFakeTx();
    fake.queueSelect([]); // devices FOR UPDATE finds nothing

    const result = await queueDeviceUninstall(fake.tx as never, 'missing-device', null);

    expect(result).toEqual({ queued: false, mergedIntoExisting: false });
    expect(fake.insertLog).toHaveLength(0);
    expect(fake.updateLog).toHaveLength(0);
  });
});

/**
 * Fake CALLER transaction handle for `releaseDeviceRemoveReason` (#3986 task
 * 8 fix round 1: it now takes `tx` as its first parameter instead of opening
 * its own `db.transaction`, mirroring `queueDeviceUninstall` — the restore
 * route composes it with the `devices` status write in ONE transaction, in
 * release-then-flip order, so the "device is restored but the pending
 * uninstall is still live" window can never be observed).
 */
function rigReleaseTx(strippedRows: Array<{ id: string; status: string; uninstallReasons: string[] | null }>) {
  const stripUpdateLog: { values: Record<string, unknown>; where: unknown }[] = [];
  const cancelUpdateLog: { values: Record<string, unknown>; where: unknown }[] = [];
  let updateCallCount = 0;

  const tx = {
    update: vi.fn(() => {
      updateCallCount += 1;
      const isFirstCall = updateCallCount === 1;
      return {
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn((where: unknown) => {
            if (isFirstCall) {
              stripUpdateLog.push({ values, where });
              return {
                returning: vi.fn(async () => strippedRows),
              };
            }
            cancelUpdateLog.push({ values, where });
            return Promise.resolve([]);
          }),
        })),
      };
    }),
  };

  return { tx, stripUpdateLog, cancelUpdateLog };
}

describe('releaseDeviceRemoveReason', () => {
  it('strips only the device_remove reason (compiled SQL: array_remove bound to the exact reason, scoped to self_uninstall pending/sent rows carrying it)', async () => {
    const { tx, stripUpdateLog } = rigReleaseTx([]);

    await releaseDeviceRemoveReason(tx as never, 'device-1', 'device_restored');

    expect(stripUpdateLog).toHaveLength(1);
    const strip = stripUpdateLog[0]!;

    const reasonsExpr = sqlOf(strip.values.uninstallReasons);
    expect(reasonsExpr.sql).toContain('array_remove(');
    expect(reasonsExpr.sql).toContain('"uninstall_reasons"');
    expect(reasonsExpr.params).toEqual([UNINSTALL_REASON_DEVICE_REMOVE]);

    // The deadline is released with the reason it belongs to, keyed on that
    // reason's PRESENCE. The earlier `array_remove(...) = '{}'` form keyed on
    // the row becoming reason-LESS, so a co-owned row (device removed while
    // its tenant offboards) kept a live deadline through the restore; the
    // next Remove then inherited it via the `?? deadline` preserve branch and
    // — once it had passed — produced a device agentAuth hard-403s while the
    // API reports uninstallQueued:true. Asserted structurally: the emptiness
    // form contains `array_remove` and no `@>`, so it cannot pass this.
    const deadlineExpr = sqlOf(strip.values.deviceRemoveExpiresAt);
    const deadlineSql = deadlineExpr.sql.toLowerCase();
    expect(deadlineSql).toContain('case when');
    expect(deadlineSql).toContain('"uninstall_reasons" @> $');
    expect(deadlineSql).not.toContain('array_remove');
    expect(deadlineSql).not.toContain("= '{}'");
    // (In a SET expression drizzle qualifies columns as
    // `"device_commands"."device_remove_expires_at"`, unlike a WHERE clause.)
    expect(deadlineSql).toContain('then null else');
    expect(deadlineSql).toContain('"device_remove_expires_at" end');
    expect(deadlineExpr.params.some((p) => typeof p === 'string' && p.includes(UNINSTALL_REASON_DEVICE_REMOVE))).toBe(true);

    const whereBuilt = sqlOf(strip.where);
    const whereSql = whereBuilt.sql.toLowerCase();

    // THE OPERATOR, not just the clauses (see assertConjunction's doc). This
    // is the one UPDATE in this module that WRITES, and `device_commands` has
    // no RLS. Under `or(...)` this WHERE matches `device_id = $1` OR
    // `type='self_uninstall'` OR `status IN (...)` OR `uninstall_reasons @>
    // [...]` — i.e. every non-terminal row in the table, across every tenant.
    // RETURNING then feeds the cancel loop, where a legacy NULL-reason row
    // has zero reasons left, so ONE operator clicking Restore on ONE device
    // would flip every pending command in the entire fleet to `cancelled`.
    // Every other assertion in this test is a substring or param-membership
    // check and stays green under that mutant; this line is what fails.
    assertConjunction(whereSql, 4);

    expect(whereSql).toContain('"device_id" = $');
    expect(whereBuilt.params).toContain('device-1');
    expect(whereSql).toContain('"type" = $');
    expect(whereBuilt.params).toContain('self_uninstall');
    expect(whereSql).toMatch(/"status" in \(\$\d+, \$\d+\)/);
    expect(whereBuilt.params).toContain('pending');
    expect(whereBuilt.params).toContain('sent');
    // Only rows that actually carry our reason are touched.
    expect(whereSql).toContain('"uninstall_reasons" @> $');
    expect(whereBuilt.params.some((p) => typeof p === 'string' && p.includes('device_remove'))).toBe(true);
  });

  it('releases only its own reason, leaving a tenant-owned uninstall live (retainedOtherOwner, no cancel)', async () => {
    const { tx, cancelUpdateLog } = rigReleaseTx([
      { id: 'cmd-1', status: 'pending', uninstallReasons: ['tenant_offboarding'] },
    ]);

    const result = await releaseDeviceRemoveReason(tx as never, 'device-1', 'device_restored');

    expect(result).toEqual({ cancelled: 0, retainedOtherOwner: 1, alreadyDispatched: 0 });
    expect(cancelUpdateLog).toHaveLength(0);
  });

  it('reports alreadyDispatched for a row already in sent (no cancel, but reason is stripped)', async () => {
    const { tx, cancelUpdateLog } = rigReleaseTx([
      { id: 'cmd-1', status: 'sent', uninstallReasons: [] },
    ]);

    const result = await releaseDeviceRemoveReason(tx as never, 'device-1', 'device_restored');

    expect(result).toEqual({ cancelled: 0, retainedOtherOwner: 0, alreadyDispatched: 1 });
    expect(cancelUpdateLog).toHaveLength(0);
  });

  it('cancels a pending row with no reasons left, including terminalPayloadErasureSet', async () => {
    const { tx, cancelUpdateLog } = rigReleaseTx([
      { id: 'cmd-1', status: 'pending', uninstallReasons: [] },
    ]);

    const result = await releaseDeviceRemoveReason(tx as never, 'device-1', 'device_restored');

    expect(result).toEqual({ cancelled: 1, retainedOtherOwner: 0, alreadyDispatched: 0 });
    expect(cancelUpdateLog).toHaveLength(1);
    const cancel = cancelUpdateLog[0]!;
    expect(cancel.values.status).toBe('cancelled');
    expect(cancel.values.completedAt).toBeInstanceOf(Date);
    expect(cancel.values.result).toEqual({ reason: 'device_restored' });
    // Every terminal write must spread terminalPayloadErasureSet().
    expect(cancel.values.payload).toEqual({ __erased: true });

    const whereBuilt = sqlOf(cancel.where);
    expect(whereBuilt.params).toContain('cmd-1');
  });

  it('handles a mix of rows in one release call (partial cancel, partial retain)', async () => {
    const { tx, cancelUpdateLog } = rigReleaseTx([
      { id: 'cmd-1', status: 'pending', uninstallReasons: [] },
      { id: 'cmd-2', status: 'pending', uninstallReasons: ['tenant_offboarding'] },
    ]);

    const result = await releaseDeviceRemoveReason(tx as never, 'device-1', 'device_restored');

    expect(result).toEqual({ cancelled: 1, retainedOtherOwner: 1, alreadyDispatched: 0 });
    expect(cancelUpdateLog).toHaveLength(1);
    expect(sqlOf(cancelUpdateLog[0]!.where).params).toEqual(['cmd-1']);
  });
});

// Sanity check referenced by the module doc: `devices`/`deviceCommands`
// column identifiers used above must be the real schema objects (not a
// mocked stand-in), otherwise PgDialect().sqlToQuery(...) above could not
// have compiled real column names in the first place.
describe('module wiring sanity', () => {
  it('uses the real device_commands/devices schema objects', () => {
    expect(deviceCommands.uninstallReasons).toBeDefined();
    expect(devices.status).toBeDefined();
  });
});

/**
 * The window constant is computed ONCE at module load from the environment,
 * so every case here re-imports the module under a stubbed env.
 *
 * Why literals, never `DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS` itself: the
 * deadline assertion in `queueDeviceUninstall` above derives its expected
 * value FROM the constant under test, so it holds for 0, for a negative, and
 * for any other value the floor was supposed to reject — it can only prove
 * the deadline is self-consistent, never that the window is sane. `envInt`
 * returns 0 for the string '0' (a compose file renders an unset variable as
 * `VAR: ""`, and an operator can set it outright), and with the floor deleted
 * a 0-hour window makes every deadline already expired at insert time: the
 * drain predicate is false the instant the row is written, agentAuth 403s the
 * device forever, and the feature is inert with no error anywhere.
 */
describe('DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS — the Math.max(..., 1) floor', () => {
  async function importWindowHours(raw: string | undefined): Promise<number> {
    vi.resetModules();
    if (raw === undefined) {
      vi.stubEnv('DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS', undefined as never);
    } else {
      vi.stubEnv('DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS', raw);
    }
    const mod = await import('./deviceUninstallDrain');
    return mod.DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('floors an explicit 0 up to 1 hour (not to the 72h default)', async () => {
    // 1, not 72: this is a FLOOR, not a fallback. An operator asking for the
    // shortest possible window gets the shortest LEGAL one — a ternary
    // (`RAW >= 1 ? RAW : 72`) would look almost identical and silently do the
    // opposite. Both literals are asserted so neither substitution passes.
    await expect(importWindowHours('0')).resolves.toBe(1);
  });

  it('floors a negative value up to 1 hour', async () => {
    await expect(importWindowHours('-5')).resolves.toBe(1);
  });

  it('passes a legitimate override through unchanged (the floor is not a clamp to 1)', async () => {
    await expect(importWindowHours('5')).resolves.toBe(5);
  });

  it('defaults to 72 hours when unset', async () => {
    await expect(importWindowHours(undefined)).resolves.toBe(72);
  });
});
