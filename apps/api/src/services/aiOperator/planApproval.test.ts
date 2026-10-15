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
