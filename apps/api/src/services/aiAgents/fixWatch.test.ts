// apps/api/src/services/aiAgents/fixWatch.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { AiAgentMode } from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-0000000000d1';
const AGENT_ID = '00000000-0000-4000-8000-0000000000d2';
const RUN_ID = '00000000-0000-4000-8000-0000000000d3';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000d4';
const ALERT_ID = '00000000-0000-4000-8000-0000000000d5';
const DEVICE_ID = '00000000-0000-4000-8000-0000000000d6';
const RULE_ID = '00000000-0000-4000-8000-0000000000d7';
const WATCH_ID = '00000000-0000-4000-8000-0000000000d8';
const USER_ID = '00000000-0000-4000-8000-0000000000d9';
const RECURRENCE_ALERT_ID = '00000000-0000-4000-8000-0000000000da';
const INTENT_ID = '00000000-0000-4000-8000-0000000000db';
/** A SECOND watch of the SAME run — one run releases N intent-anchored
 *  watches (P2-5, #4192), and all of them denormalize the same alert. */
const SIBLING_WATCH_ID = '00000000-0000-4000-8000-0000000000dc';
/** A colon key — `canonicalPolicyKey`'s shape for a released intent, as
 *  opposed to the dot keys an act manifest uses. */
const OP_KEY = 'manage_services:restart';

const state = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  selectWheres: [] as unknown[],
  selectOrderBys: [] as unknown[][],
  selectLimits: [] as number[],
  insertReturningQueue: [] as (unknown[] | undefined)[],
  insertValues: [] as Record<string, unknown>[],
  // The `onConflictDoNothing({ target, where })` argument, captured so the
  // partial-unique-index PREDICATE can be asserted (P2-5, #4192): Postgres
  // cannot infer a partial unique index as the conflict arbiter without it,
  // and both watch indexes became partial in this wave.
  insertConflicts: [] as ({ target?: unknown; where?: unknown } | undefined)[],
  updateSets: [] as Record<string, unknown>[],
  updateWheres: [] as unknown[],
  // Consumed by `.returning()` on the update builder — a queued `[]` (or
  // explicitly pushed empty array) simulates a LOST CAS race (the `WHERE
  // ... AND state = '<expected>'` matched zero rows because some other
  // delivery already moved it). Defaults to "the CAS won" so every existing
  // test that never pushes onto this queue keeps its prior behavior.
  updateReturningQueue: [] as (unknown[] | undefined)[],
  selectCount: 0,
  insertCount: 0,
  updateCount: 0,
  // P2-5 (#4192) fix round 1 — the auto-demote runs in a SAVEPOINT nested
  // inside the phase-2 CAS transaction. `transactionDepth` is what proves the
  // nesting; `savepointExecutor` is the sentinel the callback receives, so a
  // test can prove the executor threaded into `demoteSupervisedKey` is the
  // savepoint's and NOT the ambient `db` proxy (a statement issued through the
  // proxy would abort the outer transaction no matter how it were wrapped).
  transactionCount: 0,
  transactionDepth: 0,
  savepointExecutor: { __savepoint: true } as Record<string, unknown>,
}));

function resetDbState(): void {
  state.selectQueue = [];
  state.selectWheres = [];
  state.selectOrderBys = [];
  state.selectLimits = [];
  state.insertReturningQueue = [];
  state.insertValues = [];
  state.insertConflicts = [];
  state.updateSets = [];
  state.updateWheres = [];
  state.updateReturningQueue = [];
  state.selectCount = 0;
  state.insertCount = 0;
  state.updateCount = 0;
  state.transactionCount = 0;
  state.transactionDepth = 0;
}

vi.mock('../../db', () => {
  function selectBuilder() {
    state.selectCount += 1;
    const builder: Record<string, unknown> = {
      from: vi.fn(() => builder),
      where: vi.fn((w: unknown) => {
        state.selectWheres.push(w);
        return builder;
      }),
      orderBy: vi.fn((...cols: unknown[]) => {
        state.selectOrderBys.push(cols);
        return builder;
      }),
      limit: vi.fn((n: number) => {
        state.selectLimits.push(n);
        return builder;
      }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => {
            if (state.selectQueue.length === 0) throw new Error('no queued select rows');
            return state.selectQueue.shift();
          })
          .then(resolve, reject),
    };
    return builder;
  }

  function insertBuilder() {
    state.insertCount += 1;
    const builder: Record<string, unknown> = {
      values: vi.fn((v: Record<string, unknown>) => {
        state.insertValues.push(v);
        return builder;
      }),
      onConflictDoNothing: vi.fn((clause?: { target?: unknown; where?: unknown }) => {
        state.insertConflicts.push(clause);
        return builder;
      }),
      returning: vi.fn(() => ({
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(state.insertReturningQueue.shift() ?? []).then(resolve, reject),
      })),
      // Plain `await db.insert(...).values(...)` with no `.returning()`
      // (the alerts insert in sendRecurrenceNotifications).
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(undefined).then(resolve, reject),
    };
    return builder;
  }

  function updateBuilder() {
    state.updateCount += 1;
    const builder: Record<string, unknown> = {
      set: vi.fn((v: Record<string, unknown>) => {
        state.updateSets.push(v);
        return builder;
      }),
      where: vi.fn((w: unknown) => {
        state.updateWheres.push(w);
        return builder;
      }),
      returning: vi.fn(() => ({
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(
            state.updateReturningQueue.length > 0 ? state.updateReturningQueue.shift() : [{ id: 'cas-won' }],
          ).then(resolve, reject),
      })),
      // Plain `await db.update(...).set(...).where(...)` with no
      // `.returning()` — none of this module's call sites do that anymore,
      // kept only so an accidental bare update in a future edit doesn't hang
      // a test instead of failing loudly.
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(undefined).then(resolve, reject),
    };
    return builder;
  }

  return {
    db: {
      select: vi.fn(() => selectBuilder()),
      insert: vi.fn(() => insertBuilder()),
      update: vi.fn(() => updateBuilder()),
      // `db.transaction` inside an already-open context transaction is a
      // SAVEPOINT (postgres-js). The callback gets a DISTINCT executor object
      // on purpose — see `state.savepointExecutor`.
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        state.transactionCount += 1;
        state.transactionDepth += 1;
        try {
          return await fn(state.savepointExecutor);
        } finally {
          state.transactionDepth -= 1;
        }
      }),
    },
    getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system' })),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  };
});

const resolveRecipientUserIdsMock = vi.fn();
vi.mock('./recipients', () => ({
  resolveRecipientUserIds: (...args: unknown[]) => resolveRecipientUserIdsMock(...args),
}));

const createNotificationMock = vi.fn();
vi.mock('../userNotifications', () => ({
  createNotification: (...args: unknown[]) => createNotificationMock(...args),
}));

const captureExceptionMock = vi.fn();
vi.mock('../sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
}));

// P2-5 (#4192) Task 6 — auto-demote. Mocked at the module boundary: the
// revoke's own advisory-lock / FOR UPDATE / SET-clause contract is pinned
// against the real dialect in `supervisedKeyDemote.test.ts`. What THIS file
// proves is which keys a `recurred` verdict hands it, that it runs inside the
// winning CAS's transaction, and that the notification runs strictly after.
const demoteSupervisedKeyMock = vi.fn(
  async (_input: Record<string, unknown>, _database?: unknown) =>
    ({ revoked: false, orgAgentId: null as string | null }),
);
const notifyDemotionMock = vi.fn(async (_input: Record<string, unknown>) => undefined);
vi.mock('./supervisedKeyDemote', () => ({
  demoteSupervisedKey: (input: Record<string, unknown>, database?: unknown) =>
    demoteSupervisedKeyMock(input, database),
  notifyDemotion: (input: Record<string, unknown>) => notifyDemotionMock(input),
}));

import {
  checkFixWatchPhase1,
  checkFixWatchPhase2,
  createFixWatchRow,
  createIntentFixWatchRow,
  FIX_HOLD_MINUTES,
  listPendingWatchesForRecovery,
  RECOVERY_TIMEOUT_HOURS,
  STRANDED_WATCH_SWEEP_PAGE,
  isFixWatchEligible,
  type FinishedRunForWatch,
  type FixWatchOutcomeInput,
  type IntentForWatch,
} from './fixWatch';
// Type-only (erased at runtime, so no module cycle and no runLoop mock): the
// structural `actOpKey` field `FixWatchOutcomeInput` snapshots must keep
// naming the property `runLoop.ts` actually populates. Renaming or dropping
// it there would otherwise leave `op_keys` silently empty with no type error
// anywhere, since every field of the structural input is optional.
import type { OutcomeExecutedAction } from './runLoop';
import { db } from '../../db';

const dialect = new PgDialect();

function sqlText(value: unknown): string {
  return dialect.sqlToQuery(value as SQL).sql;
}

function sqlParams(value: unknown): unknown[] {
  return dialect.sqlToQuery(value as SQL).params;
}

function finishedRun(overrides: Partial<FinishedRunForWatch> = {}): FinishedRunForWatch {
  return {
    id: RUN_ID,
    orgId: ORG_ID,
    agentId: AGENT_ID,
    alertId: ALERT_ID,
    modeAtStart: 'act' as Exclude<AiAgentMode, 'off'>,
    ...overrides,
  };
}

function outcome(overrides: Partial<FixWatchOutcomeInput> = {}): FixWatchOutcomeInput {
  return {
    executedActions: [{ verification: 'passed', execution: 'succeeded' }],
    ...overrides,
  };
}

function watchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: WATCH_ID,
    orgId: ORG_ID,
    partnerId: PARTNER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    alertId: ALERT_ID,
    ruleId: RULE_ID,
    deviceId: DEVICE_ID,
    configItemName: 'disk_cleanup',
    state: 'pending',
    recoveryObservedAt: null,
    dueAt: null,
    evaluatedAt: null,
    recurrenceAlertId: null,
    notifiedAt: null,
    createdAt: new Date(),
    // P2-5 (#4192) — a pre-P2-5 watch (or the default fixture here) carries
    // no op keys, which `recordWatchVerdictEvidence` reads as "nothing to
    // grade" and writes zero evidence rows for, keeping every existing
    // `insertCount`-based assertion below unchanged.
    sourceKind: 'act_run',
    opKeys: [] as string[],
    ...overrides,
  };
}

beforeEach(() => {
  resetDbState();
  resolveRecipientUserIdsMock.mockReset().mockResolvedValue([USER_ID]);
  createNotificationMock.mockReset().mockResolvedValue('notif-id');
  demoteSupervisedKeyMock.mockReset().mockResolvedValue({ revoked: false, orgAgentId: null });
  notifyDemotionMock.mockReset().mockResolvedValue(undefined);
  captureExceptionMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// isFixWatchEligible — eligibility matrix
// ---------------------------------------------------------------------------
describe('isFixWatchEligible', () => {
  it('is eligible: alertId set, act lane, a passed verification', () => {
    expect(isFixWatchEligible(finishedRun(), outcome())).toBe(true);
  });

  it('is NOT eligible without a triggering alert', () => {
    expect(isFixWatchEligible(finishedRun({ alertId: null }), outcome())).toBe(false);
  });

  it('is NOT eligible for a shadow-mode run (never acted)', () => {
    expect(isFixWatchEligible(finishedRun({ modeAtStart: 'shadow' }), outcome())).toBe(false);
  });

  it('is NOT eligible with zero executed actions', () => {
    expect(isFixWatchEligible(finishedRun(), outcome({ executedActions: [] }))).toBe(false);
  });

  it('is NOT eligible when every executed action failed/inconclusive/skipped verification', () => {
    expect(isFixWatchEligible(finishedRun(), outcome({
      executedActions: [{ verification: 'failed' }, { verification: 'inconclusive' }, { verification: 'skipped' }],
    }))).toBe(false);
  });

  it('is eligible when only ONE of several executed actions passed+succeeded and the run verdict is clean', () => {
    expect(isFixWatchEligible(finishedRun(), outcome({
      executedActions: [{ verification: 'skipped' }, { verification: 'passed', execution: 'succeeded' }],
      runVerdict: 'partial',
    }))).toBe(true);
  });

  // Mirrors `computeRunVerdict` (runLoop.ts): a dispatch that itself
  // failed/timed out/is unknown is not "clean" even when its read-back
  // reports 'passed' — review fix, #3828 (previously this admitted a watch
  // for an action `actVerify.ts` itself would page on immediately).
  it.each(['failed', 'timeout', 'unknown'] as const)(
    'is NOT eligible when the only passed-verification action has execution: %s',
    (execution) => {
      expect(isFixWatchEligible(finishedRun(), outcome({
        executedActions: [{ verification: 'passed', execution }],
      }))).toBe(false);
    },
  );

  // LOCKED: "act-lane clean runs only" — a mixed run's own rollup verdict
  // governs, not any single action in isolation (review fix, #3828: this
  // used to admit exactly the `needs_attention` shape `agentCircuit.ts`
  // treats as a circuit FAILURE, seeding a fix-held watch and opening the
  // breaker off the very same run at once).
  it('is NOT eligible when the run verdict is needs_attention, even with a passed+succeeded action present', () => {
    expect(isFixWatchEligible(finishedRun(), outcome({
      executedActions: [{ verification: 'failed', execution: 'succeeded' }, { verification: 'passed', execution: 'succeeded' }],
      runVerdict: 'needs_attention',
    }))).toBe(false);
  });

  it('is NOT eligible for a policy-decided run — modeAtStart never carries a disposition beyond off/shadow/act, so a policy-decide lane always fails this the same way a shadow run does', () => {
    // Policy-decided runs still set modeAtStart to 'act' or 'shadow' today —
    // the deferral the plan documents is real exclusion via the ABSENCE of a
    // verification field on policy-decided executed actions (they never go
    // through actVerify.ts), not a distinct modeAtStart value.
    expect(isFixWatchEligible(finishedRun(), outcome({ executedActions: [{}] }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createFixWatchRow
// ---------------------------------------------------------------------------
describe('createFixWatchRow', () => {
  it('is a no-op (no DB calls) for an ineligible run', async () => {
    const id = await createFixWatchRow(finishedRun({ alertId: null }), outcome());
    expect(id).toBeNull();
    expect(state.selectCount).toBe(0);
    expect(state.insertCount).toBe(0);
  });

  it('denormalizes rule_id/device_id/config_item_name from the ALERT row and inserts', async () => {
    state.selectQueue.push(
      [{ ruleId: RULE_ID, deviceId: DEVICE_ID, configItemName: 'disk_cleanup' }], // alert lookup
      [{ partnerId: PARTNER_ID }], // org lookup
    );
    state.insertReturningQueue.push([{ id: WATCH_ID }]);

    const id = await createFixWatchRow(finishedRun(), outcome());

    expect(id).toBe(WATCH_ID);
    expect(state.insertValues).toHaveLength(1);
    expect(state.insertValues[0]).toMatchObject({
      orgId: ORG_ID,
      partnerId: PARTNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      alertId: ALERT_ID,
      ruleId: RULE_ID,
      deviceId: DEVICE_ID,
      configItemName: 'disk_cleanup',
      state: 'pending',
    });
  });

  it('returns null when the triggering alert is gone (deleted, or moved out of the org)', async () => {
    state.selectQueue.push([]); // alert lookup — nothing found
    const id = await createFixWatchRow(finishedRun(), outcome());
    expect(id).toBeNull();
    expect(state.insertCount).toBe(0);
  });

  it('returns null when the org has no resolvable partner', async () => {
    state.selectQueue.push(
      [{ ruleId: RULE_ID, deviceId: DEVICE_ID, configItemName: null }],
      [], // org lookup — nothing found
    );
    const id = await createFixWatchRow(finishedRun(), outcome());
    expect(id).toBeNull();
    expect(state.insertCount).toBe(0);
  });

  it('returns null on a duplicate scheduling attempt (onConflictDoNothing — the run_id UNIQUE constraint)', async () => {
    state.selectQueue.push(
      [{ ruleId: RULE_ID, deviceId: DEVICE_ID, configItemName: null }],
      [{ partnerId: PARTNER_ID }],
    );
    state.insertReturningQueue.push([]); // conflict — nothing returned
    const id = await createFixWatchRow(finishedRun(), outcome());
    expect(id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createFixWatchRow — P2-5 (#4192) additions: op-key snapshot + the partial
// conflict target
// ---------------------------------------------------------------------------
describe('createFixWatchRow — P2-5 source_kind / op_keys / partial conflict target', () => {
  function primeInsert(): void {
    state.selectQueue.push(
      [{ ruleId: RULE_ID, deviceId: DEVICE_ID, configItemName: 'disk_cleanup' }],
      [{ partnerId: PARTNER_ID }],
    );
    state.insertReturningQueue.push([{ id: WATCH_ID }]);
  }

  it("stamps source_kind 'act_run' and snapshots the manifest op keys of the executed actions", async () => {
    primeInsert();

    await createFixWatchRow(finishedRun(), outcome({
      executedActions: [
        { verification: 'passed', execution: 'succeeded', actOpKey: 'manage_services.restart' },
        { verification: 'passed', execution: 'succeeded', actOpKey: 'run_script.execute' },
      ],
    }));

    expect(state.insertValues[0]).toMatchObject({
      sourceKind: 'act_run',
      opKeys: ['manage_services.restart', 'run_script.execute'],
    });
  });

  it('drops actions with no op key and de-duplicates repeats (one evidence source id per key, Task 6)', async () => {
    primeInsert();

    await createFixWatchRow(finishedRun(), outcome({
      executedActions: [
        { verification: 'passed', execution: 'succeeded', actOpKey: 'manage_services.restart' },
        { verification: 'skipped', execution: 'succeeded', actOpKey: 'manage_services.restart' },
        { verification: 'skipped', execution: 'succeeded' },
      ],
    }));

    expect(state.insertValues[0]).toMatchObject({ opKeys: ['manage_services.restart'] });
  });

  it('a pre-P2-5-shaped run (no act op keys at all) snapshots an empty array, never null', async () => {
    primeInsert();

    await createFixWatchRow(finishedRun(), outcome());

    expect(state.insertValues[0]!.opKeys).toEqual([]);
  });

  it('names the partial index predicate on the conflict target — Postgres cannot infer a partial unique index without it', async () => {
    primeInsert();

    await createFixWatchRow(finishedRun(), outcome());

    expect(state.insertConflicts).toHaveLength(1);
    const clause = state.insertConflicts[0]!;
    expect(sqlText(clause.where)).toContain("\"source_kind\" = 'act_run'");
  });
});

// ---------------------------------------------------------------------------
// createIntentFixWatchRow — the intent-anchored sibling (P2-5, #4192,
// closes #4206)
// ---------------------------------------------------------------------------
describe('createIntentFixWatchRow', () => {
  function intentForWatch(overrides: Partial<IntentForWatch> = {}): IntentForWatch {
    return {
      intentId: INTENT_ID,
      orgId: ORG_ID,
      runId: RUN_ID,
      agentId: AGENT_ID,
      alertId: ALERT_ID,
      opKey: OP_KEY,
      ...overrides,
    };
  }

  it("denormalizes rule_id/device_id/config_item_name from the ALERT row and writes source_kind 'intent' with the released op key", async () => {
    state.selectQueue.push(
      [{ ruleId: RULE_ID, deviceId: DEVICE_ID, configItemName: 'disk_cleanup' }], // alert lookup
      [{ partnerId: PARTNER_ID }], // org lookup
    );
    state.insertReturningQueue.push([{ id: WATCH_ID }]);

    const id = await createIntentFixWatchRow(intentForWatch());

    expect(id).toBe(WATCH_ID);
    expect(state.insertValues).toHaveLength(1);
    expect(state.insertValues[0]).toMatchObject({
      orgId: ORG_ID,
      partnerId: PARTNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      intentId: INTENT_ID,
      alertId: ALERT_ID,
      ruleId: RULE_ID,
      deviceId: DEVICE_ID,
      configItemName: 'disk_cleanup',
      state: 'pending',
      sourceKind: 'intent',
      opKeys: [OP_KEY],
    });
  });

  it('reads the triggering alert predicated by BOTH id and org_id — RLS passes unconditionally under the system context, so the org predicate IS the isolation', async () => {
    state.selectQueue.push(
      [{ ruleId: RULE_ID, deviceId: DEVICE_ID, configItemName: null }],
      [{ partnerId: PARTNER_ID }],
    );
    state.insertReturningQueue.push([{ id: WATCH_ID }]);

    await createIntentFixWatchRow(intentForWatch());

    const alertWhere = sqlText(state.selectWheres[0]);
    expect(alertWhere).toContain('"alerts"."id"');
    expect(alertWhere).toContain('"alerts"."org_id"');
  });

  it('returns null when the triggering alert is not readable in this org (deleted, or another tenant)', async () => {
    state.selectQueue.push([]); // alert lookup — nothing found

    const id = await createIntentFixWatchRow(intentForWatch());

    expect(id).toBeNull();
    expect(state.insertCount).toBe(0);
  });

  it('returns null when the org has no resolvable partner', async () => {
    state.selectQueue.push(
      [{ ruleId: RULE_ID, deviceId: DEVICE_ID, configItemName: null }],
      [], // org lookup — nothing found
    );

    const id = await createIntentFixWatchRow(intentForWatch());

    expect(id).toBeNull();
    expect(state.insertCount).toBe(0);
  });

  it('names the partial UNIQUE (intent_id) predicate on the conflict target', async () => {
    state.selectQueue.push(
      [{ ruleId: RULE_ID, deviceId: DEVICE_ID, configItemName: null }],
      [{ partnerId: PARTNER_ID }],
    );
    state.insertReturningQueue.push([{ id: WATCH_ID }]);

    await createIntentFixWatchRow(intentForWatch());

    const clause = state.insertConflicts[0]!;
    expect(sqlText(clause.where)).toContain('"intent_id" is not null');
  });

  it('a second call for the same intent inserts nothing and returns the EXISTING watch id — null must mean "no watch exists"', async () => {
    state.selectQueue.push(
      [{ ruleId: RULE_ID, deviceId: DEVICE_ID, configItemName: null }],
      [{ partnerId: PARTNER_ID }],
      [{ id: WATCH_ID }], // the row the partial UNIQUE already holds
    );
    state.insertReturningQueue.push([]); // ON CONFLICT DO NOTHING — no row back

    const id = await createIntentFixWatchRow(intentForWatch());

    expect(id).toBe(WATCH_ID);
  });

  it('issues every statement through the SAVEPOINT executor it was handed, never the ambient db', async () => {
    state.selectQueue.push(
      [{ ruleId: RULE_ID, deviceId: DEVICE_ID, configItemName: null }],
      [{ partnerId: PARTNER_ID }],
    );
    state.insertReturningQueue.push([{ id: WATCH_ID }]);
    // Delegates to the same builders, so behavior is unchanged and only the
    // ENTRY POINT differs — which is the thing under test: a statement issued
    // on the outer scope aborts the caller's whole transaction on any error,
    // savepoint or not (postgres-js records the first failed query of a scope
    // and rethrows it at scope end).
    const executor = {
      select: vi.fn((...args: unknown[]) => (db.select as (...a: unknown[]) => unknown)(...args)),
      insert: vi.fn((...args: unknown[]) => (db.insert as (...a: unknown[]) => unknown)(...args)),
    };

    const id = await createIntentFixWatchRow(intentForWatch(), executor as never);

    expect(id).toBe(WATCH_ID);
    expect(executor.select).toHaveBeenCalledTimes(2);
    expect(executor.insert).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// listPendingWatchesForRecovery — the durable-enqueue recovery reader
// ---------------------------------------------------------------------------
describe('listPendingWatchesForRecovery', () => {
  const OLDER = new Date('2026-09-01T00:00:00.000Z');

  it('selects only pending watches created before `now - olderThanMs`', async () => {
    state.selectQueue.push([{ id: WATCH_ID, createdAt: OLDER }, { id: 'watch-2', createdAt: OLDER }]);
    const before = Date.now();

    const rows = await listPendingWatchesForRecovery(120_000);
    const after = Date.now();

    expect(rows.map((row) => row.id)).toEqual([WATCH_ID, 'watch-2']);
    const compiled = dialect.sqlToQuery(state.selectWheres[0] as SQL);
    expect(compiled.sql).toContain('"state" =');
    expect(compiled.sql).toContain('"created_at" <');
    // The cutoff is `now - olderThanMs`, NOT `now` — a watch created seconds
    // ago is still waiting on its own delayed job, not stranded. A dropped
    // subtraction would re-enqueue every pending watch on every tick.
    expect(compiled.params).toContain('pending');
    // The timestamp param is mapped to the driver's string form by the
    // dialect, so compare it back as a Date rather than by identity.
    const cutoffParam = compiled.params.find((param) => param !== 'pending');
    const cutoff = new Date(String(cutoffParam));
    expect(Number.isNaN(cutoff.getTime())).toBe(false);
    // Bracket the cutoff between the clock readings taken around the call: the
    // lower bound proves the reader did not use a stale clock, the upper bound
    // proves the subtraction happened (a dropped one would land near `after`).
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 120_000);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - 120_000);
  });

  it('reads one PAGE, ordered (created_at, id) — the tuple the cursor compares', async () => {
    state.selectQueue.push([]);

    await listPendingWatchesForRecovery(120_000);

    expect(state.selectLimits).toEqual([STRANDED_WATCH_SWEEP_PAGE]);
    // Two keys, not one: `created_at` alone is not unique, so a single-key
    // ORDER BY would let the keyset cursor below skip or repeat rows that
    // share a timestamp.
    expect(state.selectOrderBys[0]).toHaveLength(2);
  });

  it('adds a keyset predicate when continuing from a cursor — never OFFSET', async () => {
    state.selectQueue.push([]);

    await listPendingWatchesForRecovery(120_000, { id: WATCH_ID, createdAt: OLDER });

    const compiled = dialect.sqlToQuery(state.selectWheres[0] as SQL);
    // The row-value form is what makes paging exact; a plain
    // `created_at > cursor` would drop every same-timestamp sibling.
    expect(compiled.sql).toContain('"created_at", "ai_agent_fix_watches"."id") > (');
    expect(compiled.sql).toContain('::timestamptz');
    expect(compiled.sql).toContain('::uuid');
    expect(compiled.params).toContain(WATCH_ID);
  });

  it('omits the keyset predicate on the first page', async () => {
    state.selectQueue.push([]);

    await listPendingWatchesForRecovery(120_000);

    const compiled = dialect.sqlToQuery(state.selectWheres[0] as SQL);
    expect(compiled.sql).not.toContain('::uuid');
  });

  it('returns an empty page when nothing is left to scan', async () => {
    state.selectQueue.push([]);
    await expect(listPendingWatchesForRecovery(120_000)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Compile-time: the op-key field name this module snapshots must be the one
// runLoop.ts populates. `OutcomeExecutedAction['actOpKey']` fails to compile
// if that property is ever renamed or removed there — the one failure mode a
// structural, all-optional input type cannot catch at the call site.
// ---------------------------------------------------------------------------
type ActOpKeyFieldIsAligned =
  OutcomeExecutedAction['actOpKey'] extends FixWatchOutcomeInput['executedActions'][number]['actOpKey']
    ? true
    : never;
const ACT_OP_KEY_FIELD_IS_ALIGNED: ActOpKeyFieldIsAligned = true;

describe('FixWatchOutcomeInput <-> runLoop.OutcomeExecutedAction', () => {
  it('names the same op-key property runLoop actually populates', () => {
    expect(ACT_OP_KEY_FIELD_IS_ALIGNED).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkFixWatchPhase1
// ---------------------------------------------------------------------------
describe('checkFixWatchPhase1', () => {
  it('not_found for a missing watch', async () => {
    state.selectQueue.push([]);
    const result = await checkFixWatchPhase1(WATCH_ID);
    expect(result).toEqual({ action: 'not_found' });
    expect(state.updateCount).toBe(0);
  });

  it('not_found for a watch already past pending (duplicate job delivery)', async () => {
    state.selectQueue.push([watchRow({ state: 'watching' })]);
    const result = await checkFixWatchPhase1(WATCH_ID);
    expect(result).toEqual({ action: 'not_found' });
    expect(state.updateCount).toBe(0);
  });

  it('resolved alert -> recovered: stamps recovery_observed_at and due_at FIX_HOLD_MINUTES out', async () => {
    state.selectQueue.push([watchRow()], [{ status: 'resolved' }]);
    const before = Date.now();

    const result = await checkFixWatchPhase1(WATCH_ID);

    expect(result).toEqual({ action: 'recovered' });
    expect(state.updateSets).toHaveLength(1);
    const set = state.updateSets[0] as { state: string; recoveryObservedAt: Date; dueAt: Date };
    expect(set.state).toBe('watching');
    expect(set.recoveryObservedAt).toBeInstanceOf(Date);
    const deltaMs = set.dueAt.getTime() - set.recoveryObservedAt.getTime();
    expect(deltaMs).toBe(FIX_HOLD_MINUTES * 60_000);
    expect(set.recoveryObservedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('dismissed alert -> cancelled: a manual dismissal never establishes recovery', async () => {
    state.selectQueue.push([watchRow()], [{ status: 'dismissed' }]);

    const result = await checkFixWatchPhase1(WATCH_ID);

    expect(result).toEqual({ action: 'cancelled' });
    expect(state.updateSets[0]).toMatchObject({ state: 'cancelled' });
  });

  it.each(['active', 'acknowledged', 'suppressed'])('still %s -> still_pending before the 24h ceiling', async (status) => {
    state.selectQueue.push([watchRow({ createdAt: new Date() })], [{ status }]);

    const result = await checkFixWatchPhase1(WATCH_ID);

    expect(result).toEqual({ action: 'still_pending' });
    expect(state.updateCount).toBe(0);
  });

  it('still open past RECOVERY_TIMEOUT_HOURS -> inconclusive (absence of resolution is not proof either way)', async () => {
    const old = new Date(Date.now() - (RECOVERY_TIMEOUT_HOURS * 60 * 60 * 1000 + 60_000));
    state.selectQueue.push([watchRow({ createdAt: old })], [{ status: 'active' }]);

    const result = await checkFixWatchPhase1(WATCH_ID);

    expect(result).toEqual({ action: 'timed_out' });
    expect(state.updateSets[0]).toMatchObject({ state: 'inconclusive' });
  });

  it('a deleted alert row (alert_id SET NULL by the FK) still times out after 24h rather than waiting forever', async () => {
    const old = new Date(Date.now() - (RECOVERY_TIMEOUT_HOURS * 60 * 60 * 1000 + 60_000));
    state.selectQueue.push([watchRow({ createdAt: old, alertId: null })]);

    const result = await checkFixWatchPhase1(WATCH_ID);

    expect(result).toEqual({ action: 'timed_out' });
    // No second select — alertId is null, so there is no alert row to read.
    expect(state.selectCount).toBe(1);
  });

  // Review fix, #3828: a REDELIVERED phase-1 job (BullMQ `attempts`, fired
  // because the phase-2 enqueue that follows a 'recovered' result threw)
  // must re-report 'recovered' instead of 'not_found', or the watch strands
  // in `watching` forever with no sweeper — the worker only re-enqueues
  // phase 2 off a 'recovered' result.
  it('a watch already watching WITH recovery observed re-reports recovered (idempotent retry), without re-reading the alert', async () => {
    state.selectQueue.push([watchRow({ state: 'watching', recoveryObservedAt: new Date() })]);

    const result = await checkFixWatchPhase1(WATCH_ID);

    expect(result).toEqual({ action: 'recovered' });
    expect(state.selectCount).toBe(1);
    expect(state.updateCount).toBe(0);
  });

  it('a watch already watching WITHOUT recovery observed (should not happen, defensive) is not_found', async () => {
    state.selectQueue.push([watchRow({ state: 'watching', recoveryObservedAt: null })]);

    const result = await checkFixWatchPhase1(WATCH_ID);

    expect(result).toEqual({ action: 'not_found' });
  });

  it('losing the CAS on the resolved->watching write (a concurrent delivery already moved it) reports not_found, not a second recovered', async () => {
    state.selectQueue.push([watchRow()], [{ status: 'resolved' }]);
    state.updateReturningQueue.push([]); // CAS lost

    const result = await checkFixWatchPhase1(WATCH_ID);

    expect(result).toEqual({ action: 'not_found' });
  });
});

// ---------------------------------------------------------------------------
// checkFixWatchPhase2
// ---------------------------------------------------------------------------
describe('checkFixWatchPhase2', () => {
  it('not_found for a missing watch', async () => {
    state.selectQueue.push([]);
    const result = await checkFixWatchPhase2(WATCH_ID);
    expect(result).toEqual({ action: 'not_found' });
  });

  it('not_found for a watch not currently watching (already terminal, or a duplicate job delivery)', async () => {
    state.selectQueue.push([watchRow({ state: 'pending' })]);
    const result = await checkFixWatchPhase2(WATCH_ID);
    expect(result).toEqual({ action: 'not_found' });
  });

  it('recurrence found (ruled watch) -> recurred: recurrence_alert_id set, notification + rule-less alert fired', async () => {
    const recoveredAt = new Date('2026-08-28T00:00:00Z');
    state.selectQueue.push(
      [watchRow({ state: 'watching', recoveryObservedAt: recoveredAt })], // watch
      [{ id: RECURRENCE_ALERT_ID }], // recurrence query
      [{ name: 'Disk Cleaner', orgId: null, partnerId: PARTNER_ID }], // agent
      [{ policySnapshot: { effective: { recipients: { userIds: [USER_ID] } } } }], // run
      [], // episode guard: no attention alert raised for this episode yet
    );

    const result = await checkFixWatchPhase2(WATCH_ID);

    expect(result).toEqual({ action: 'recurred' });
    // Watch-state write: recurred + recurrence_alert_id + notified_at.
    expect(state.updateSets[0]).toMatchObject({ state: 'recurred', recurrenceAlertId: RECURRENCE_ALERT_ID });
    // The recurrence query is anchored on the rule + device, not device alone.
    const recurrenceWhereSql = sqlText(state.selectWheres[1]);
    expect(recurrenceWhereSql).toContain('rule_id');

    expect(resolveRecipientUserIdsMock).toHaveBeenCalledWith(
      { orgId: null, partnerId: PARTNER_ID, recipients: { userIds: [USER_ID] } },
      ORG_ID,
    );
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    expect(createNotificationMock.mock.calls[0]![0]).toMatchObject({
      userId: USER_ID,
      orgId: ORG_ID,
      priority: 'high',
      dedupeKey: `fix-watch-${RUN_ID}-${RECURRENCE_ALERT_ID}-recurred`,
    });

    expect(state.insertValues).toHaveLength(1);
    expect(state.insertValues[0]).toMatchObject({
      ruleId: null,
      deviceId: DEVICE_ID,
      orgId: ORG_ID,
      configItemName: 'ai_agent_fix_watch',
      severity: 'high',
      status: 'active',
      context: expect.objectContaining({
        source: 'ai_agent_fix_watch',
        watchId: WATCH_ID,
        recurrenceAlertId: RECURRENCE_ALERT_ID,
      }),
    });
  });

  it('recurrence found for a RULE-LESS watch -> matches on device + config_item_name, not rule_id', async () => {
    const recoveredAt = new Date('2026-08-28T00:00:00Z');
    state.selectQueue.push(
      [watchRow({ state: 'watching', recoveryObservedAt: recoveredAt, ruleId: null, configItemName: 'ai_agent_act_verify_manage_services.restart' })],
      [{ id: RECURRENCE_ALERT_ID }],
      [{ name: 'Service Restarter', orgId: null, partnerId: PARTNER_ID }],
      [{ policySnapshot: { effective: { recipients: {} } } }],
      [], // episode guard
    );
    resolveRecipientUserIdsMock.mockResolvedValueOnce([]);

    const result = await checkFixWatchPhase2(WATCH_ID);

    expect(result).toEqual({ action: 'recurred' });
    const recurrenceWhereSql = sqlText(state.selectWheres[1]);
    expect(recurrenceWhereSql).toContain('rule_id');
    expect(recurrenceWhereSql).toContain('is null');
    expect(recurrenceWhereSql).toContain('config_item_name');
    // Zero resolved recipients -> no notification sent, but the rule-less
    // attention alert still fires (operators must still be paged some way).
    expect(createNotificationMock).not.toHaveBeenCalled();
    expect(state.insertValues).toHaveLength(1);
  });

  it('no recurrence -> held_qualified, quiet: no notification, no alert', async () => {
    const recoveredAt = new Date('2026-08-28T00:00:00Z');
    state.selectQueue.push(
      [watchRow({ state: 'watching', recoveryObservedAt: recoveredAt })],
      [], // no recurrence row
    );

    const result = await checkFixWatchPhase2(WATCH_ID);

    expect(result).toEqual({ action: 'held_qualified' });
    expect(state.updateSets[0]).toMatchObject({ state: 'held_qualified' });
    expect(createNotificationMock).not.toHaveBeenCalled();
    expect(state.insertCount).toBe(0);
  });

  it('the watch state is ALREADY committed before notify runs — a notify failure still returns recurred', async () => {
    const recoveredAt = new Date('2026-08-28T00:00:00Z');
    state.selectQueue.push(
      [watchRow({ state: 'watching', recoveryObservedAt: recoveredAt })],
      [{ id: RECURRENCE_ALERT_ID }],
      [{ name: 'Disk Cleaner', orgId: null, partnerId: PARTNER_ID }],
      [{ policySnapshot: { effective: { recipients: { userIds: [USER_ID] } } } }],
    );
    createNotificationMock.mockRejectedValueOnce(new Error('notification service down'));

    const result = await checkFixWatchPhase2(WATCH_ID);

    expect(result).toEqual({ action: 'recurred' });
    expect(state.updateSets[0]).toMatchObject({ state: 'recurred' });
  });

  // Review fix, #3828: a stalled/duplicated phase-2 delivery (lock-expired
  // job redelivered while the original invocation is still mid-flight; both
  // reads see `state: 'watching'`) must insert the operator-facing attention
  // alert AT MOST ONCE — that alert has no dedupe key, unlike the user
  // notification's `dedupeKey`.
  it('a second checkFixWatchPhase2 that loses the recurred-write CAS race inserts no alert and sends no notification', async () => {
    const recoveredAt = new Date('2026-08-28T00:00:00Z');
    state.selectQueue.push(
      [watchRow({ state: 'watching', recoveryObservedAt: recoveredAt })], // watch (still 'watching' — the winner hasn't committed yet)
      [{ id: RECURRENCE_ALERT_ID }], // recurrence query — both deliveries see the same recurrence row
    );
    state.updateReturningQueue.push([]); // this delivery loses the CAS — the other one already won

    const result = await checkFixWatchPhase2(WATCH_ID);

    expect(result).toEqual({ action: 'not_found' });
    expect(createNotificationMock).not.toHaveBeenCalled();
    expect(state.insertCount).toBe(0);
  });

  it('a second checkFixWatchPhase2 that loses the held_qualified-write CAS race is a no-op', async () => {
    const recoveredAt = new Date('2026-08-28T00:00:00Z');
    state.selectQueue.push(
      [watchRow({ state: 'watching', recoveryObservedAt: recoveredAt })],
      [], // no recurrence row
    );
    state.updateReturningQueue.push([]); // CAS lost

    const result = await checkFixWatchPhase2(WATCH_ID);

    expect(result).toEqual({ action: 'not_found' });
    expect(createNotificationMock).not.toHaveBeenCalled();
    expect(state.insertCount).toBe(0);
  });

  // ---------------------------------------------------------------------
  // Review fix (P2-5, #4192): one run now releases N intent-anchored watches
  // (`createIntentFixWatchRow`), and every one of them denormalizes the SAME
  // `alertId`/`ruleId`/`deviceId` off the triggering alert. A single
  // recurrence therefore wins N independent `watching -> recurred` CAS races
  // and reaches `sendRecurrenceNotifications` N times. Both operator-facing
  // artifacts must collapse to ONE per EPISODE (run + recurrence alert),
  // never one per watch.
  // ---------------------------------------------------------------------
  it('dedupes the recurrence notification on the RUN + recurrence alert, so sibling watches share one key', async () => {
    const recoveredAt = new Date('2026-08-28T00:00:00Z');
    const queueOneRecurrence = (watchId: string) => {
      state.selectQueue.push(
        [watchRow({ id: watchId, state: 'watching', recoveryObservedAt: recoveredAt })],
        [{ id: RECURRENCE_ALERT_ID }],
        [{ name: 'Disk Cleaner', orgId: null, partnerId: PARTNER_ID }],
        [{ policySnapshot: { effective: { recipients: { userIds: [USER_ID] } } } }],
        [], // no attention alert yet for this episode
      );
    };

    queueOneRecurrence(WATCH_ID);
    await checkFixWatchPhase2(WATCH_ID);
    queueOneRecurrence(SIBLING_WATCH_ID);
    await checkFixWatchPhase2(SIBLING_WATCH_ID);

    const episodeKey = `fix-watch-${RUN_ID}-${RECURRENCE_ALERT_ID}-recurred`;
    expect(createNotificationMock).toHaveBeenCalledTimes(2);
    expect(createNotificationMock.mock.calls[0]![0]).toMatchObject({ dedupeKey: episodeKey });
    // The SIBLING must present the identical key — that is what makes
    // `createNotification`'s (user_id, dedupe_key) unique index collapse it.
    expect(createNotificationMock.mock.calls[1]![0]).toMatchObject({ dedupeKey: episodeKey });
  });

  it('raises the attention alert only for the FIRST sibling of an episode', async () => {
    const recoveredAt = new Date('2026-08-28T00:00:00Z');
    state.selectQueue.push(
      [watchRow({ id: SIBLING_WATCH_ID, state: 'watching', recoveryObservedAt: recoveredAt })],
      [{ id: RECURRENCE_ALERT_ID }],
      [{ name: 'Disk Cleaner', orgId: null, partnerId: PARTNER_ID }],
      [{ policySnapshot: { effective: { recipients: { userIds: [USER_ID] } } } }],
      // An earlier sibling of the SAME episode already raised it.
      [{ id: '00000000-0000-4000-8000-0000000000e0' }],
    );

    const result = await checkFixWatchPhase2(SIBLING_WATCH_ID);

    expect(result).toEqual({ action: 'recurred' });
    // The notification still goes out (its own dedupe key absorbs it); the
    // rule-less attention alert — which has NO dedupe key of its own — does
    // not fire a second time.
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    expect(state.insertCount).toBe(0);
  });

  it('keys the attention-alert guard on the episode identifiers in `context`, predicated on the device', async () => {
    const recoveredAt = new Date('2026-08-28T00:00:00Z');
    state.selectQueue.push(
      [watchRow({ state: 'watching', recoveryObservedAt: recoveredAt })],
      [{ id: RECURRENCE_ALERT_ID }],
      [{ name: 'Disk Cleaner', orgId: null, partnerId: PARTNER_ID }],
      [{ policySnapshot: { effective: { recipients: { userIds: [USER_ID] } } } }],
      [],
    );

    await checkFixWatchPhase2(WATCH_ID);

    // selects: watch, recurrence, agent, run, attention-alert guard.
    const guardWhere = state.selectWheres[4];
    const guardSql = sqlText(guardWhere);
    expect(guardSql).toContain('config_item_name');
    // `device_id` keeps the probe on `idx_alerts_device_triggered` rather
    // than a full-table jsonb scan.
    expect(guardSql).toContain('device_id');
    expect(guardSql).toContain(`->>'runId'`);
    expect(guardSql).toContain(`->>'recurrenceAlertId'`);
    // Bound to the EPISODE, never to the watch that happens to be asking.
    const guardParams = sqlParams(guardWhere);
    expect(guardParams).toContain(RUN_ID);
    expect(guardParams).toContain(RECURRENCE_ALERT_ID);
    expect(guardParams).not.toContain(WATCH_ID);
  });

  it('a notify with no resolvable agent/run skips notification without failing the result', async () => {
    const recoveredAt = new Date('2026-08-28T00:00:00Z');
    state.selectQueue.push(
      [watchRow({ state: 'watching', recoveryObservedAt: recoveredAt })],
      [{ id: RECURRENCE_ALERT_ID }],
      [], // agent gone
      [{ policySnapshot: { effective: { recipients: {} } } }],
    );

    const result = await checkFixWatchPhase2(WATCH_ID);

    expect(result).toEqual({ action: 'recurred' });
    expect(createNotificationMock).not.toHaveBeenCalled();
    expect(state.insertCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// checkFixWatchPhase2 — P2-5 watch-verdict op evidence (#4192, Task 6)
// ---------------------------------------------------------------------------
describe('checkFixWatchPhase2 — P2-5 watch-verdict op evidence', () => {
  const recoveredAt = new Date('2026-08-28T00:00:00Z');

  it('recurred verdict with two op_keys inserts two "recurred" rows, one per key, source ids "<watchId>:<opKey>"', async () => {
    state.selectQueue.push(
      [watchRow({ state: 'watching', recoveryObservedAt: recoveredAt, sourceKind: 'act_run', opKeys: ['a:b', 'c:d'] })],
      [{ id: RECURRENCE_ALERT_ID }],
      [{ name: 'Disk Cleaner', orgId: null, partnerId: PARTNER_ID }],
      [{ policySnapshot: { effective: { recipients: { userIds: [USER_ID] } } } }],
      [], // episode guard
    );

    const result = await checkFixWatchPhase2(WATCH_ID);

    expect(result).toEqual({ action: 'recurred' });
    // The evidence insert is `state.insertValues[0]` — it lands INSIDE the
    // winning CAS's transaction, before `sendRecurrenceNotifications`'s own
    // (separate) alert insert, which is `state.insertValues[1]`.
    expect(state.insertValues[0]).toEqual([
      expect.objectContaining({
        orgId: ORG_ID, agentId: AGENT_ID, namespace: 'act_op', opKey: 'a:b', ruleId: RULE_ID,
        sourceKind: 'watch', sourceId: `${WATCH_ID}:a:b`, metric: 'recurred', runId: RUN_ID,
      }),
      expect.objectContaining({
        namespace: 'act_op', opKey: 'c:d', sourceKind: 'watch', sourceId: `${WATCH_ID}:c:d`, metric: 'recurred',
      }),
    ]);
    expect(state.insertValues[1]).toMatchObject({ configItemName: 'ai_agent_fix_watch' });
    // Notification still fires — the evidence write did not short-circuit it.
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('a LOST CAS on the recurred write inserts no evidence, even with non-empty op_keys', async () => {
    state.selectQueue.push(
      [watchRow({ state: 'watching', recoveryObservedAt: recoveredAt, opKeys: ['a:b'] })],
      [{ id: RECURRENCE_ALERT_ID }],
    );
    state.updateReturningQueue.push([]); // lost the CAS

    const result = await checkFixWatchPhase2(WATCH_ID);

    expect(result).toEqual({ action: 'not_found' });
    expect(state.insertCount).toBe(0);
  });

  it('held_qualified inserts a "verified" row per op_key', async () => {
    state.selectQueue.push(
      [watchRow({ state: 'watching', recoveryObservedAt: recoveredAt, opKeys: ['x:y'] })],
      [], // no recurrence row
    );

    const result = await checkFixWatchPhase2(WATCH_ID);

    expect(result).toEqual({ action: 'held_qualified' });
    expect(state.insertValues[0]).toEqual([
      expect.objectContaining({
        opKey: 'x:y', metric: 'verified', sourceKind: 'watch', sourceId: `${WATCH_ID}:x:y`, runId: RUN_ID,
      }),
    ]);
  });

  it('a LOST CAS on the held_qualified write inserts no evidence, even with non-empty op_keys', async () => {
    state.selectQueue.push(
      [watchRow({ state: 'watching', recoveryObservedAt: recoveredAt, opKeys: ['x:y'] })],
      [],
    );
    state.updateReturningQueue.push([]); // lost the CAS

    const result = await checkFixWatchPhase2(WATCH_ID);

    expect(result).toEqual({ action: 'not_found' });
    expect(state.insertCount).toBe(0);
  });

  it('an intent-anchored watch (source_kind "intent") writes namespace "policy_key"', async () => {
    state.selectQueue.push(
      [watchRow({ state: 'watching', recoveryObservedAt: recoveredAt, sourceKind: 'intent', opKeys: [OP_KEY] })],
      [], // no recurrence -> held_qualified
    );

    await checkFixWatchPhase2(WATCH_ID);

    expect(state.insertValues[0]).toEqual([
      expect.objectContaining({ namespace: 'policy_key', opKey: OP_KEY }),
    ]);
  });

  it('an act-run watch (source_kind "act_run") writes namespace "act_op"', async () => {
    state.selectQueue.push(
      [watchRow({ state: 'watching', recoveryObservedAt: recoveredAt, sourceKind: 'act_run', opKeys: ['manage_services.restart'] })],
      [],
    );

    await checkFixWatchPhase2(WATCH_ID);

    expect(state.insertValues[0]).toEqual([
      expect.objectContaining({ namespace: 'act_op', opKey: 'manage_services.restart' }),
    ]);
  });

  it('a watch with empty op_keys (pre-P2-5 row) writes no evidence on either verdict', async () => {
    state.selectQueue.push(
      [watchRow({ state: 'watching', recoveryObservedAt: recoveredAt, opKeys: [] })],
      [],
    );

    await checkFixWatchPhase2(WATCH_ID);

    expect(state.insertCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P2-5 (#4192) Task 6 — auto-demote on a `recurred` verdict
//
// A recurrence is the second disqualifying signal (the first is an ATTEMPTED
// failure, in `intentReleaseWorker.ts`): the agent's fix did not hold, so any
// colon key the ORG actually granted for it stops running unattended. The
// revoke rides the SAME transaction as the `recurred` CAS and its evidence
// rows, so it can never commit without them; the notification runs strictly
// after, like every other operator-facing artifact this module emits.
// ---------------------------------------------------------------------------
describe('checkFixWatchPhase2 — P2-5 auto-demote on recurrence', () => {
  const recoveredAt = new Date('2026-08-28T00:00:00Z');
  const OTHER_OP_KEY = 'manage_alerts:acknowledge';

  function queueRecurrence(overrides: Record<string, unknown>): void {
    state.selectQueue.push(
      [watchRow({ state: 'watching', recoveryObservedAt: recoveredAt, ...overrides })],
      [{ id: RECURRENCE_ALERT_ID }],
      [{ name: 'Disk Cleaner', orgId: null, partnerId: PARTNER_ID }],
      [{ policySnapshot: { effective: { recipients: { userIds: [USER_ID] } } } }],
      [], // episode guard
    );
  }

  it('asks to revoke every colon key on the watch, and notifies only for the ones actually granted', async () => {
    queueRecurrence({ sourceKind: 'intent', intentId: INTENT_ID, opKeys: [OP_KEY, OTHER_OP_KEY] });
    demoteSupervisedKeyMock
      .mockResolvedValueOnce({ revoked: true, orgAgentId: 'org-agent-1' })
      .mockResolvedValueOnce({ revoked: false, orgAgentId: 'org-agent-1' });

    const result = await checkFixWatchPhase2(WATCH_ID);

    expect(result).toEqual({ action: 'recurred' });
    expect(demoteSupervisedKeyMock).toHaveBeenCalledTimes(2);
    // Sorted, so two concurrent multi-key demotes can never take the same
    // pair of advisory locks in opposite orders.
    expect(demoteSupervisedKeyMock.mock.calls.map((c) => c[0].opKey))
      .toEqual([OTHER_OP_KEY, OP_KEY]);
    expect(demoteSupervisedKeyMock).toHaveBeenCalledWith({
      orgId: ORG_ID,
      agentId: AGENT_ID,
      opKey: OP_KEY,
      reason: 'recurrence',
      runId: RUN_ID,
      watchId: WATCH_ID,
      intentId: INTENT_ID,
    }, state.savepointExecutor);
    // Exactly one notification — the key that was only ever in the partner
    // ceiling had nothing revoked, so paging about it would be a lie.
    expect(notifyDemotionMock).toHaveBeenCalledTimes(1);
    expect(notifyDemotionMock).toHaveBeenCalledWith({
      orgId: ORG_ID,
      agentId: AGENT_ID,
      orgAgentId: 'org-agent-1',
      opKey: OTHER_OP_KEY,
      reason: 'recurrence',
      runId: RUN_ID,
      watchId: WATCH_ID,
    });
  });

  it('never asks to revoke an act-manifest DOT key — those are never granted', async () => {
    queueRecurrence({ sourceKind: 'act_run', intentId: null, opKeys: ['manage_services.restart', 'manage_alerts.acknowledge'] });

    await checkFixWatchPhase2(WATCH_ID);

    expect(demoteSupervisedKeyMock).not.toHaveBeenCalled();
    expect(notifyDemotionMock).not.toHaveBeenCalled();
  });

  it('revokes nothing on a held_qualified verdict — the fix held', async () => {
    state.selectQueue.push(
      [watchRow({ state: 'watching', recoveryObservedAt: recoveredAt, sourceKind: 'intent', intentId: INTENT_ID, opKeys: [OP_KEY] })],
      [], // no recurrence
    );

    const result = await checkFixWatchPhase2(WATCH_ID);

    expect(result).toEqual({ action: 'held_qualified' });
    expect(demoteSupervisedKeyMock).not.toHaveBeenCalled();
  });

  it('a LOST recurred CAS revokes nothing — the verdict belongs to whoever won it', async () => {
    state.selectQueue.push(
      [watchRow({ state: 'watching', recoveryObservedAt: recoveredAt, sourceKind: 'intent', intentId: INTENT_ID, opKeys: [OP_KEY] })],
      [{ id: RECURRENCE_ALERT_ID }],
    );
    state.updateReturningQueue.push([]); // lost the CAS

    const result = await checkFixWatchPhase2(WATCH_ID);

    expect(result).toEqual({ action: 'not_found' });
    expect(demoteSupervisedKeyMock).not.toHaveBeenCalled();
    expect(notifyDemotionMock).not.toHaveBeenCalled();
  });

  it('revokes inside the CAS transaction and notifies strictly after it', async () => {
    queueRecurrence({ sourceKind: 'intent', intentId: INTENT_ID, opKeys: [OP_KEY] });
    demoteSupervisedKeyMock.mockResolvedValueOnce({ revoked: true, orgAgentId: 'org-agent-1' });

    await checkFixWatchPhase2(WATCH_ID);

    const casOrder = (db.update as unknown as { mock: { invocationCallOrder: number[] } })
      .mock.invocationCallOrder[0]!;
    const revokeOrder = demoteSupervisedKeyMock.mock.invocationCallOrder[0]!;
    const notifyOrder = notifyDemotionMock.mock.invocationCallOrder[0]!;
    const recurrenceNotifyOrder = createNotificationMock.mock.invocationCallOrder[0]!;
    expect(revokeOrder).toBeGreaterThan(casOrder);
    expect(notifyOrder).toBeGreaterThan(revokeOrder);
    // ...and after the recurrence notification, i.e. outside the detection
    // transaction entirely.
    expect(notifyOrder).toBeGreaterThan(recurrenceNotifyOrder);
  });

  it('a demote-notification failure still returns recurred — the revoke is already committed', async () => {
    queueRecurrence({ sourceKind: 'intent', intentId: INTENT_ID, opKeys: [OP_KEY] });
    demoteSupervisedKeyMock.mockResolvedValueOnce({ revoked: true, orgAgentId: 'org-agent-1' });
    notifyDemotionMock.mockRejectedValueOnce(new Error('notification service down'));

    const result = await checkFixWatchPhase2(WATCH_ID);

    expect(result).toEqual({ action: 'recurred' });
    expect(state.updateSets[0]).toMatchObject({ state: 'recurred' });
  });

  it('a watch with empty op_keys revokes nothing', async () => {
    queueRecurrence({ sourceKind: 'intent', intentId: INTENT_ID, opKeys: [] });

    await checkFixWatchPhase2(WATCH_ID);

    expect(demoteSupervisedKeyMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Containment (review round 1). The revoke is the side that YIELDS: it runs
  // in a SAVEPOINT so a failure rolls back to it instead of unwinding the
  // `recurred` CAS, the watch-verdict evidence and the operator-facing
  // recurrence alert together. That matters more here than in the sibling
  // release-worker path: a watch left back in `watching` is NOT recoverable
  // (`listPendingWatchesForRecovery` scans `state = 'pending'` only), so once
  // the phase-2 job exhausts its BullMQ attempts the recurrence would never be
  // reported to anyone at all.
  // -------------------------------------------------------------------------
  it('revokes in a SAVEPOINT nested in the CAS transaction, on that savepoint executor', async () => {
    queueRecurrence({ sourceKind: 'intent', intentId: INTENT_ID, opKeys: [OP_KEY] });
    let depthAtRevoke = -1;
    demoteSupervisedKeyMock.mockImplementationOnce(async () => {
      depthAtRevoke = state.transactionDepth;
      return { revoked: true, orgAgentId: 'org-agent-1' };
    });

    await checkFixWatchPhase2(WATCH_ID);

    expect(state.transactionCount).toBe(1);
    expect(depthAtRevoke).toBe(1);
    // The savepoint's executor, never the ambient `db` proxy: postgres-js
    // latches a failed statement on the scope that issued it and rethrows at
    // scope end even when the caller catches, so a proxied statement would
    // abort the outer transaction however it were wrapped.
    expect(demoteSupervisedKeyMock.mock.calls[0]![1]).toBe(state.savepointExecutor);
    expect(demoteSupervisedKeyMock.mock.calls[0]![1]).not.toBe(db);
  });

  it('opens NO savepoint when the watch has nothing grantable to revoke', async () => {
    queueRecurrence({ sourceKind: 'act_run', intentId: null, opKeys: ['manage_services.restart'] });

    await checkFixWatchPhase2(WATCH_ID);

    expect(state.transactionCount).toBe(0);
  });

  it('a revoke that throws KEEPS the recurred verdict, its evidence and the recurrence page', async () => {
    queueRecurrence({ sourceKind: 'intent', intentId: INTENT_ID, opKeys: [OP_KEY] });
    demoteSupervisedKeyMock.mockRejectedValueOnce(new Error('deadlock detected'));

    const result = await checkFixWatchPhase2(WATCH_ID);

    expect(result).toEqual({ action: 'recurred' });
    expect(state.updateSets[0]).toMatchObject({ state: 'recurred' });
    // The watch-verdict evidence rows committed with the CAS...
    expect(state.insertValues[0]).toEqual([
      expect.objectContaining({ metric: 'recurred', opKey: OP_KEY }),
    ]);
    // ...and the human still hears about the recurrence.
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    // Loud, and identifiers only — no alert text, no model-authored text.
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const captured = captureExceptionMock.mock.calls[0]![0] as Error;
    expect(captured.message).toContain(WATCH_ID);
    expect(captured.message).not.toContain('deadlock detected');
    // Nothing was revoked, so nothing is announced as revoked.
    expect(notifyDemotionMock).not.toHaveBeenCalled();
  });

  it('a revoke that throws still lets the OTHER keys of the same verdict stay unrevoked', async () => {
    queueRecurrence({ sourceKind: 'intent', intentId: INTENT_ID, opKeys: [OP_KEY, OTHER_OP_KEY] });
    // The savepoint wraps the WHOLE loop, so one throw discards every revoke
    // in it — the alternative (a savepoint per key) would let a verdict commit
    // a partial authority change with no record of which half failed.
    demoteSupervisedKeyMock
      .mockResolvedValueOnce({ revoked: true, orgAgentId: 'org-agent-1' })
      .mockRejectedValueOnce(new Error('lock timeout'));

    const result = await checkFixWatchPhase2(WATCH_ID);

    expect(result).toEqual({ action: 'recurred' });
    expect(notifyDemotionMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});
