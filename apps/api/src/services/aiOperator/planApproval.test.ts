/**
 * The plan-approval primitive (Recipe Library spec §6.4, E4 #6169).
 *
 * The PURE halves plus the membership predicate against a stubbed handle. The
 * row-level, cross-tenant and replay properties are proved against real
 * Postgres in `src/__tests__/integration/aiOperatorPlanApproval*.integration.test.ts`
 * — a stub cannot prove RLS, a unique index or a trigger, and this file does
 * not pretend to.
 */
import { describe, expect, it } from 'vitest';
import { computeEffectSetDigest } from '@breeze/shared/canonicalize/effectSet';
import { canonicalizeArguments, computeArgumentDigest } from '../actionIntents/canonicalize';
import {
  allowlistPermits,
  checkPlanEffectMembership,
  checkToolCeiling,
  effectArgumentDigest,
  planEffectOperationKey,
  renderingsMatchRows,
  toDigestProjection,
} from './planApproval';
import type { PlannedEffect } from './recipes/types';

const TASK = '00000000-0000-4000-8000-0000000000a1';
const suspend: PlannedEffect = {
  ordinal: 0, toolName: 'google_suspend_user', provider: 'google',
  targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: '101',
  canonicalArguments: { reason: 'offboarding', userEmail: 'dana@customer.example' },
};
const removeGroup: PlannedEffect = {
  ordinal: 1, toolName: 'google_remove_from_group', provider: 'google',
  targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: '101',
  canonicalArguments: { groupEmail: 'sales@customer.example', reason: 'offboarding', userEmail: 'dana@customer.example' },
};

describe('effectArgumentDigest', () => {
  it('is the SAME digest action_intents.argument_digest carries for that effect', () => {
    expect(effectArgumentDigest(suspend))
      .toBe(computeArgumentDigest(canonicalizeArguments(suspend.canonicalArguments as Record<string, unknown>)));
  });
  it('ignores argument key order', () => {
    expect(effectArgumentDigest({ canonicalArguments: { userEmail: 'dana@customer.example', reason: 'offboarding' } }))
      .toBe(effectArgumentDigest(suspend));
  });
});

describe('toDigestProjection', () => {
  it('projects exactly the six sealed fields with the argument digest', () => {
    expect(toDigestProjection([suspend])).toEqual([{
      ordinal: 0, toolName: 'google_suspend_user', provider: 'google',
      targetId: suspend.targetId, accountExternalId: '101', argumentDigest: effectArgumentDigest(suspend),
    }]);
  });
});

describe('allowlistPermits / checkToolCeiling', () => {
  it('matches the bare tool or tool:action, like checkAgentGuardrails', () => {
    expect(allowlistPermits(['google_suspend_user'], 'google_suspend_user', {})).toBe(true);
    expect(allowlistPermits(['manage_services:restart'], 'manage_services', { action: 'restart' })).toBe(true);
    expect(allowlistPermits(['manage_services:restart'], 'manage_services', { action: 'stop' })).toBe(false);
  });
  it('requires BOTH the frozen snapshot and the live policy — widening live alone does not authorize', () => {
    const out = checkToolCeiling(
      { snapshot: ['google_suspend_user'], live: ['google_suspend_user', 'google_signout'] },
      'google_signout', {},
    );
    expect(out).toMatchObject({ ok: false });
  });
  it('a narrowed live policy revokes', () => {
    expect(checkToolCeiling({ snapshot: ['google_signout'], live: [] }, 'google_signout', {}))
      .toMatchObject({ ok: false });
  });
  it('fails CLOSED with no snapshot or no live agent', () => {
    expect(checkToolCeiling({ snapshot: null, live: ['x'] }, 'x', {})).toMatchObject({ ok: false });
    expect(checkToolCeiling({ snapshot: ['x'], live: null }, 'x', {})).toMatchObject({ ok: false });
    expect(checkToolCeiling({ snapshot: ['x'], live: ['x'] }, 'x', {})).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// membership, against a handle that answers its three reads in order:
// [task], [approval], [set rows]
// ---------------------------------------------------------------------------

function handleReturning(...resultSets: unknown[][]) {
  let call = 0;
  const chain = (rows: unknown[]) => {
    const p: Record<string, unknown> = {};
    for (const k of ['from', 'where', 'orderBy', 'limit', 'for']) {
      p[k] = () => Object.assign(Promise.resolve(rows), p);
    }
    return Object.assign(Promise.resolve(rows), p);
  };
  return {
    select: () => { const rows = resultSets[call] ?? []; call += 1; return chain(rows); },
    insert: () => { throw new Error('membership must not write'); },
    update: () => { throw new Error('membership must not write'); },
  } as never;
}

const STEP = 'offboard_effects';
const setRows = (effects: PlannedEffect[], approvalId = 'p1') => effects.map((e) => ({
  ordinal: e.ordinal, toolName: e.toolName, provider: e.provider, targetId: e.targetId,
  accountExternalId: e.accountExternalId, argumentDigest: effectArgumentDigest(e),
  idempotencyClass: 'idempotent', approvalId,
}));
const approved = (over: Record<string, unknown> = {}) => ({
  id: 'p1', stepKey: STEP, state: 'approved', planRevision: 2, effectCount: 2,
  approvedByUserId: 'u-approver', approvedAssuranceLevel: 3, supersededByRevision: null,
  effectSetDigest: computeEffectSetDigest({ taskId: TASK, planRevision: 2, effects: toDigestProjection([suspend, removeGroup]) }),
  ...over,
});
const base = {
  orgId: 'o1', taskId: TASK, ordinal: 0, toolName: 'google_suspend_user',
  argumentDigest: effectArgumentDigest(suspend), taskStepKey: STEP,
  operationKey: planEffectOperationKey({ stepKey: STEP, planRevision: 2, toolName: 'google_suspend_user', targetId: suspend.targetId, ordinal: 0 }),
};

describe('checkPlanEffectMembership — the ONE predicate both mint and release call', () => {
  it('ADMITS a member of an approved plan at the task\'s live revision', async () => {
    const res = await checkPlanEffectMembership(
      handleReturning([{ revision: 2 }], [approved()], setRows([suspend, removeGroup])), base,
    );
    expect(res).toMatchObject({ ok: true, approvalId: 'p1', approverUserId: 'u-approver', planRevision: 2 });
  });

  it('REFUSES with no approval row', async () => {
    expect(await checkPlanEffectMembership(handleReturning([{ revision: 2 }], []), base))
      .toMatchObject({ ok: false, refusal: 'plan_approval_missing' });
  });

  it('REFUSES a pending plan — approval is a state, not a row', async () => {
    expect(await checkPlanEffectMembership(handleReturning([{ revision: 2 }], [approved({ state: 'pending' })]), base))
      .toMatchObject({ ok: false, refusal: 'plan_not_approved' });
  });

  it('REFUSES superseded and expired plans distinctly', async () => {
    expect(await checkPlanEffectMembership(handleReturning([{ revision: 3 }], [approved({ state: 'superseded', supersededByRevision: 3 })]), { ...base, approvalId: 'p1' }))
      .toMatchObject({ ok: false, refusal: 'plan_superseded' });
    expect(await checkPlanEffectMembership(handleReturning([{ revision: 2 }], [approved({ state: 'expired' })]), base))
      .toMatchObject({ ok: false, refusal: 'plan_expired' });
  });

  it('REFUSES when the TASK moved on even though the approval row still reads approved', async () => {
    expect(await checkPlanEffectMembership(handleReturning([{ revision: 3 }], [approved()]), { ...base, approvalId: 'p1' }))
      .toMatchObject({ ok: false, refusal: 'revision_moved' });
  });

  it('REFUSES an ordinal not in the set', async () => {
    expect(await checkPlanEffectMembership(
      handleReturning([{ revision: 2 }], [approved()], setRows([suspend, removeGroup])), { ...base, ordinal: 7 },
    )).toMatchObject({ ok: false, refusal: 'effect_not_in_set' });
  });

  it('REFUSES the same ordinal under a different tool', async () => {
    expect(await checkPlanEffectMembership(
      handleReturning([{ revision: 2 }], [approved()], setRows([suspend, removeGroup])), { ...base, toolName: 'google_signout' },
    )).toMatchObject({ ok: false, refusal: 'tool_not_in_set' });
  });

  it('REFUSES the same ordinal with a DIFFERENT argument digest — the §7.1 property', async () => {
    expect(await checkPlanEffectMembership(
      handleReturning([{ revision: 2 }], [approved()], setRows([suspend, removeGroup])), { ...base, argumentDigest: 'e'.repeat(64) },
    )).toMatchObject({ ok: false, refusal: 'argument_digest_mismatch' });
  });

  it('REFUSES an operation key with a different step or target segment (one slot, one operation)', async () => {
    const otherKey = planEffectOperationKey({ stepKey: 'other', planRevision: 2, toolName: 'google_suspend_user', targetId: suspend.targetId, ordinal: 0 });
    expect(await checkPlanEffectMembership(
      handleReturning([{ revision: 2 }], [approved()], setRows([suspend, removeGroup])), { ...base, operationKey: otherKey },
    )).toMatchObject({ ok: false, refusal: 'operation_identity_mismatch' });
    expect(await checkPlanEffectMembership(
      handleReturning([{ revision: 2 }], [approved()], setRows([suspend, removeGroup])), { ...base, taskStepKey: 'other' },
    )).toMatchObject({ ok: false, refusal: 'operation_identity_mismatch' });
  });

  it('REFUSES when a row was deleted (count no longer matches)', async () => {
    expect(await checkPlanEffectMembership(
      handleReturning([{ revision: 2 }], [approved()], setRows([suspend])), base,
    )).toMatchObject({ ok: false, refusal: 'effect_count_mismatch' });
  });

  it('REFUSES a DELETE+INSERT replacement that preserves the count — the set digest is recomputed from rows', async () => {
    const replaced = { ...removeGroup, canonicalArguments: { ...removeGroup.canonicalArguments, groupEmail: 'finance@customer.example' } };
    expect(await checkPlanEffectMembership(
      handleReturning([{ revision: 2 }], [approved()], setRows([suspend, replaced])), base,
    )).toMatchObject({ ok: false, refusal: 'effect_set_digest_mismatch' });
  });

  it('REFUSES when the caller names a different approval than the one at the live revision', async () => {
    expect(await checkPlanEffectMembership(handleReturning([{ revision: 2 }], []), { ...base, approvalId: 'p-other' }))
      .toMatchObject({ ok: false, refusal: 'plan_approval_missing' });
  });

  it('returns the effect\'s idempotency class for the dispatcher', async () => {
    const rows = setRows([suspend, removeGroup]).map((r, i) => (i === 0 ? { ...r, idempotencyClass: 'non_idempotent' } : r));
    expect(await checkPlanEffectMembership(handleReturning([{ revision: 2 }], [approved()], rows), base))
      .toMatchObject({ ok: true, idempotencyClass: 'non_idempotent' });
  });
});

describe('renderingsMatchRows — what the approver read must be what the seal binds', () => {
  const row = { ordinal: 0, provider: 'google', toolName: 'google_suspend_user', targetLabel: 'Dana', principalLabel: 'dana@customer.example', rendering: 'Suspend Dana' };
  it('accepts the identical list', () => {
    expect(renderingsMatchRows([{ ...row }], [row])).toBe(true);
  });
  it('refuses a card line that differs from its row (display spoof)', () => {
    expect(renderingsMatchRows([{ ...row, rendering: 'Set an auto-reply' }], [row])).toBe(false);
    expect(renderingsMatchRows([{ ...row, toolName: 'google_set_vacation' }], [row])).toBe(false);
    expect(renderingsMatchRows([{ ...row, principalLabel: 'someone@else.example' }], [row])).toBe(false);
  });
  it('refuses a missing, extra or non-array rendering', () => {
    expect(renderingsMatchRows([], [row])).toBe(false);
    expect(renderingsMatchRows([row, row], [row])).toBe(false);
    expect(renderingsMatchRows('nope', [row])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R2a Task 3a (W07 Amendment B2/B7): `bumpPlanRevisionInTx`, the
// transaction-bound core of `bumpPlanRevision`. Appended; every case above is
// unchanged and still runs against the module as first imported.
//
// This section loads a FRESH `./planApproval` with `../../db` replaced
// (`vi.doMock` + `vi.resetModules`, so nothing above sees the stub). Every
// statement either function issues is recorded on a handle and rendered to
// SQL text + params with drizzle's own Postgres dialect, so "identical rows"
// means the identical statements, in the identical order, with the identical
// predicates — including the `(id, org_id, revision, lease_epoch)` CAS.
// Row-level behaviour against real Postgres stays with the integration suites
// (`aiOperatorPlanApproval*.integration.test.ts`).
// ---------------------------------------------------------------------------
import { beforeAll, vi } from 'vitest';
import { Column, SQL, Table, getTableName, is } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

describe('bumpPlanRevisionInTx — the transaction-bound core (R2a Task 3a)', () => {
  type Stmt = { op: string; table: string | null; calls: Array<[string, unknown[]]> };
  type Script = Record<string, unknown[][]>;
  const dialect = new PgDialect();
  const norm = (v: unknown): unknown => {
    if (v instanceof Date) return '<date>';
    if (is(v, SQL)) return dialect.sqlToQuery(v);
    if (is(v, Table)) return getTableName(v);
    if (is(v, Column)) return (v as Column).name;
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]));
    return v;
  };

  /** A handle that records every statement and answers from `script`, keyed `op:table`, in order. */
  function recordingHandle(script: Script) {
    const log: Stmt[] = [];
    const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
    const start = (op: string, table: unknown) => {
      const stmt: Stmt = { op, table: table ? getTableName(table as Table) : null, calls: [] };
      log.push(stmt);
      const chain: Record<string, unknown> = {};
      for (const m of ['set', 'where', 'returning', 'values', 'onConflictDoNothing', 'from', 'for', 'limit']) {
        chain[m] = (...args: unknown[]) => {
          if (m === 'from') stmt.table = getTableName(args[0] as Table);
          stmt.calls.push([m, args.map(norm)]);
          return chain;
        };
      }
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        const q = queues.get(`${stmt.op}:${stmt.table}`);
        return Promise.resolve(q && q.length > 0 ? q.shift() : []).then(res, rej);
      };
      return chain;
    };
    return {
      log,
      handle: {
        select: (fields?: unknown) => {
          const c = start('select', null);
          log[log.length - 1]!.calls.push(['select', [norm(fields)]]);
          return c;
        },
        update: (table: unknown) => start('update', table),
        insert: (table: unknown) => start('insert', table),
      },
    };
  }

  const ORG = '00000000-0000-4000-8000-0000000000b1';
  const TASK = '00000000-0000-4000-8000-0000000000a1';
  const ARGS = { orgId: ORG, taskId: TASK, fromRevision: 2, leaseEpoch: 7, detail: 'accounts resolved' };
  /** Won CAS; a superseded approval whose plan intent and one reserved child are both cancelled. */
  const wonScript = (): Script => ({
    'update:ai_operator_tasks': [[{ revision: 3 }], [{ eventSeq: 11 }]],
    'update:ai_operator_plan_approvals': [[{ id: 'ap-2', intentId: 'plan-intent' }]],
    'select:ai_operator_operations': [[{ intentId: 'child-1' }, { intentId: null }]],
    'update:action_intents': [[{ id: 'plan-intent', orgId: ORG, taskId: TASK }, { id: 'child-1', orgId: ORG, taskId: TASK }]],
  });
  const lostScript = (): Script => ({ 'update:ai_operator_tasks': [[]] });
  /** Normal path (B7): approval superseded, nothing left to cancel. */
  const quietScript = (): Script => ({
    'update:ai_operator_tasks': [[{ revision: 3 }], [{ eventSeq: 11 }]],
    'update:ai_operator_plan_approvals': [[{ id: 'ap-2', intentId: 'plan-intent-done' }]],
    'select:ai_operator_operations': [[]],
    'update:action_intents': [[]],
  });

  let moduleDb: ReturnType<typeof recordingHandle>;
  const ctx = { outside: 0, system: 0 };
  let mod: typeof import('./planApproval');

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('../../db', async (orig) => ({
      ...(await orig<typeof import('../../db')>()),
      get db() { return moduleDb.handle; },
      runOutsideDbContext: (fn: () => unknown) => { ctx.outside += 1; return fn(); },
      withSystemDbAccessContext: (fn: () => unknown) => { ctx.system += 1; return fn(); },
    }));
    mod = await import('./planApproval');
  });

  const runWrapper = async (script: Script) => {
    moduleDb = recordingHandle(script);
    ctx.outside = 0; ctx.system = 0;
    const result = await mod.bumpPlanRevision({ ...ARGS });
    return { result, log: moduleDb.log, ctx: { ...ctx } };
  };
  const runCore = async (script: Script) => {
    moduleDb = recordingHandle({});
    ctx.outside = 0; ctx.system = 0;
    const callerTx = recordingHandle(script);
    const result = await mod.bumpPlanRevisionInTx(callerTx.handle as never, { ...ARGS });
    return { result, log: callerTx.log, moduleLog: moduleDb.log, ctx: { ...ctx } };
  };

  it.each([
    ['a won CAS that supersedes and cancels', wonScript],
    ['a won CAS on the normal path (nothing to cancel)', quietScript],
    ['a lost CAS', lostScript],
  ])('the wrapper and the core issue identical statements and return identical results: %s', async (_label, script) => {
    const wrapped = await runWrapper(script());
    const core = await runCore(script());
    expect(core.result).toEqual(wrapped.result);
    expect(core.log).toEqual(wrapped.log);
    expect(wrapped.log.length).toBeGreaterThan(0);
  });

  it('the CAS is on (id, org_id, revision, lease_epoch); a lost CAS writes nothing else', async () => {
    const { result, log } = await runCore(lostScript());
    expect(result).toEqual({ bumped: false, newRevision: 2, supersededApprovalId: null, cancelledIntentIds: [] });
    expect(log).toHaveLength(1);
    const where = log[0]!.calls.find(([m]) => m === 'where')![1][0] as { sql: string; params: unknown[] };
    for (const col of ['"id"', '"org_id"', '"revision"', '"lease_epoch"']) expect(where.sql).toContain(col);
    expect(where.params).toEqual([TASK, ORG, 2, 7]);
  });

  it('a won core reports the bump, the superseded approval and the cancelled intents, and records the event', async () => {
    const { result, log } = await runCore(wonScript());
    expect(result).toEqual({ bumped: true, newRevision: 3, supersededApprovalId: 'ap-2', cancelledIntentIds: ['plan-intent', 'child-1'] });
    expect(log.some((s) => s.op === 'insert' && s.table === 'ai_operator_task_events')).toBe(true);
  });

  it('the core participates in the CALLER\'s transaction: every statement goes to the passed handle, and it opens no context of its own', async () => {
    const { log, moduleLog, ctx: seen } = await runCore(wonScript());
    expect(log.length).toBeGreaterThan(0);
    expect(moduleLog).toEqual([]);
    expect(seen).toEqual({ outside: 0, system: 0 });
  });

  it('PIN: the wrapper keeps its own single system-scoped transaction around the core', async () => {
    const { ctx: seen } = await runWrapper(wonScript());
    expect(seen).toEqual({ outside: 1, system: 1 });
  });
});

// ---------------------------------------------------------------------------
// R2a Task 6 (W07 Amendment B5 / G1; D-R2-2): the SINGLE-KIND approved set.
// Appended; every case above is unchanged.
//
// E4 refused any set containing a secret-bearing (credential-minting) effect.
// The refusal narrows to MIXED sets: a set of ONLY credentials (onboarding's
// account creation) proposes, a set of only ordinary effects proposes exactly
// as before, and a set mixing the two is still refused — at propose, and again
// by the membership predicate that both mint and release call.
// ---------------------------------------------------------------------------
import { classifyPlanSetSecrecy, proposePlanApproval } from './planApproval';
import type { PlanEffectLabels } from './planApproval';

describe('classifyPlanSetSecrecy (R2a Task 6, D-R2-2)', () => {
  it('classifies a set whose every member mints a credential', () => {
    expect(classifyPlanSetSecrecy(['m365_create_user'])).toBe('all_secret_bearing');
    expect(classifyPlanSetSecrecy(['m365_create_user', 'google_reset_password'])).toBe('all_secret_bearing');
  });

  it('classifies a set with no credential-minting member', () => {
    expect(classifyPlanSetSecrecy(['google_suspend_user', 'm365_add_to_group'])).toBe('none_secret_bearing');
  });

  it('a MIXED set is `mixed`, whichever end the credential sits at — this is the whole control', () => {
    expect(classifyPlanSetSecrecy(['m365_create_user', 'm365_add_to_group'])).toBe('mixed');
    expect(classifyPlanSetSecrecy(['m365_add_to_group', 'm365_create_user'])).toBe('mixed');
    expect(classifyPlanSetSecrecy(['google_suspend_user', 'google_reset_password', 'google_signout'])).toBe('mixed');
  });

  it('an EMPTY set is `mixed` (fails closed: it is not provably either kind)', () => {
    // Vacuously, an empty set is both "all secret-bearing" and "none
    // secret-bearing"; naming either would let a future caller read it as
    // permission for that kind. `mixed` is the only refusing value.
    expect(classifyPlanSetSecrecy([])).toBe('mixed');
  });

  it('uses the SHIPPED predicate, including its mcp-prefix stripping', () => {
    expect(classifyPlanSetSecrecy(['mcp__breeze__m365_create_user'])).toBe('all_secret_bearing');
    expect(classifyPlanSetSecrecy(['mcp__breeze__m365_create_user', 'google_suspend_user'])).toBe('mixed');
  });
});

const createUser: PlannedEffect = {
  ordinal: 0, toolName: 'm365_create_user', provider: 'm365',
  targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: null,
  canonicalArguments: { userPrincipalName: 'priya@customer.example', displayName: 'Priya', reason: 'onboarding' },
};
const resetGoogle: PlannedEffect = {
  ordinal: 1, toolName: 'google_reset_password', provider: 'google',
  targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: '101',
  canonicalArguments: { userEmail: 'dana@customer.example' },
};

describe('proposePlanApproval — set secrecy (R2a Task 6)', () => {
  // No labels are passed, so a set that clears the secrecy gate stops at the
  // NEXT check (`malformed_plan`: "no label or idempotency class") before any
  // database I/O. Reaching `malformed_plan` therefore proves the secrecy gate
  // let the set through; the full row-backed proposal is proved in
  // `aiOperatorPlanApproval*.integration.test.ts`.
  const propose = (effects: PlannedEffect[]) => proposePlanApproval({
    orgId: 'o1', taskId: TASK, stepKey: 'create_accounts', planRevision: 1, requesterUserId: 'u-requester',
    effects, labels: new Map<number, PlanEffectLabels>(), idempotencyClasses: new Map(),
  });

  it('an ALL-secret-bearing set clears the secrecy gate (no longer refused for containing a credential)', async () => {
    await expect(propose([createUser])).resolves.toMatchObject({ ok: false, reason: 'malformed_plan' });
    await expect(propose([createUser, resetGoogle])).resolves.toMatchObject({ ok: false, reason: 'malformed_plan' });
  });

  it('REFUSES a mixed set with mixed_secret_bearing, from either end', async () => {
    await expect(propose([createUser, { ...removeGroup, ordinal: 1 }]))
      .resolves.toMatchObject({ ok: false, reason: 'mixed_secret_bearing' });
    await expect(propose([suspend, { ...resetGoogle, ordinal: 1 }]))
      .resolves.toMatchObject({ ok: false, reason: 'mixed_secret_bearing' });
  });

  it('CONTROL (unchanged): an all-ordinary set clears the secrecy gate exactly as before', async () => {
    await expect(propose([suspend, removeGroup])).resolves.toMatchObject({ ok: false, reason: 'malformed_plan' });
  });

  it('CONTROL (unchanged): an empty set is still `empty_plan`, reported before the secrecy gate', async () => {
    await expect(propose([])).resolves.toMatchObject({ ok: false, reason: 'empty_plan' });
  });
});

describe('checkPlanEffectMembership — setSecrecy (R2a Task 6)', () => {
  const sealed = (effects: PlannedEffect[]) => approved({
    effectCount: effects.length,
    effectSetDigest: computeEffectSetDigest({ taskId: TASK, planRevision: 2, effects: toDigestProjection(effects) }),
  });
  const asMember = (e: PlannedEffect) => ({
    ...base, ordinal: e.ordinal, toolName: e.toolName, argumentDigest: effectArgumentDigest(e),
    operationKey: planEffectOperationKey({ stepKey: STEP, planRevision: 2, toolName: e.toolName, targetId: e.targetId, ordinal: e.ordinal }),
  });

  it('reports none_secret_bearing for an ordinary approved set (computed over the WHOLE set)', async () => {
    const res = await checkPlanEffectMembership(
      handleReturning([{ revision: 2 }], [approved()], setRows([suspend, removeGroup])), base,
    );
    expect(res).toMatchObject({ ok: true, setSecrecy: 'none_secret_bearing' });
  });

  it('reports all_secret_bearing for a credential-only set, at every member', async () => {
    const set = [createUser, resetGoogle];
    for (const e of set) {
      const res = await checkPlanEffectMembership(
        handleReturning([{ revision: 2 }], [sealed(set)], setRows(set)), asMember(e),
      );
      expect(res).toMatchObject({ ok: true, setSecrecy: 'all_secret_bearing' });
    }
  });

  it('REFUSES a stored set that is mixed — at EVERY member, secret or ordinary', async () => {
    // Propose-time classification cannot protect a set whose rows (and seal)
    // were written some other way. Membership re-classifies from the rows it
    // already reads, so a mixed stored set refuses at every ordinal — the
    // ordinary member included — rather than choosing a secrecy. Mint and
    // release both run this predicate.
    const set = [createUser, { ...removeGroup, ordinal: 1 }];
    for (const e of set) {
      const res = await checkPlanEffectMembership(
        handleReturning([{ revision: 2 }], [sealed(set)], setRows(set)), asMember(e),
      );
      expect(res).toMatchObject({ ok: false, refusal: 'mixed_secret_bearing' });
    }
  });

  it('a mixed set whose rows no longer match the seal is refused by the seal first (existing order unchanged)', async () => {
    const res = await checkPlanEffectMembership(
      handleReturning([{ revision: 2 }], [approved()], setRows([suspend, { ...resetGoogle, ordinal: 1 }])), base,
    );
    expect(res).toMatchObject({ ok: false, refusal: 'effect_set_digest_mismatch' });
  });
});
