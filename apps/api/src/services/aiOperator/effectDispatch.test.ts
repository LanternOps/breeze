/**
 * probe → write → probe (Recipe Library spec §6.6, E4 #6169).
 *
 *  1. A PRE-probe that already observes the end state settles the operation
 *     `succeeded` with `result.noop = true` and DISPATCHES NOTHING.
 *  2. A POST-probe `unsatisfied` / `unknown` is never `verified`.
 *  3. Membership is checked BEFORE any provider I/O.
 *  4. A `non_idempotent` effect whose pre-probe is anything but `unsatisfied`
 *     hands off (spec §6.4).
 * The end-to-end coordinator walk is proved against real Postgres in
 * `aiOperatorEffectDispatchReplay.integration.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { probeEffect, checkPlanEffectMembershipSystem, createActionIntent, buildTaskActorAuthContext, appendTaskEvent, dbState } = vi.hoisted(() => ({
  probeEffect: vi.fn(),
  checkPlanEffectMembershipSystem: vi.fn(),
  createActionIntent: vi.fn(),
  buildTaskActorAuthContext: vi.fn(async () => ({ user: { id: 'u-approver' } })),
  appendTaskEvent: vi.fn(),
  dbState: { inserted: [] as Record<string, unknown>[] },
}));

vi.mock('./effectProbes', () => ({ probeEffect }));
vi.mock('./planApproval', async (orig) => ({
  ...(await orig<typeof import('./planApproval')>()),
  checkPlanEffectMembershipSystem,
}));
vi.mock('../actionIntents/intentService', () => ({
  createActionIntent,
  ActionIntentError: class ActionIntentError extends Error {
    constructor(message: string, public code: string) { super(message); }
  },
}));
vi.mock('../actionIntents/actorContext', () => ({ buildTaskActorAuthContext }));
vi.mock('./eventService', () => ({ appendTaskEvent }));
vi.mock('../../db', () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        dbState.inserted.push(v);
        return { onConflictDoNothing: () => ({ returning: async () => [{ id: 'op-1' }] }) };
      },
    }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { classifyEffectIdempotency, dispatchPlannedEffect, verifyDispatchedEffect } from './effectDispatch';
import { M365_WRITE_ACTION_IDEMPOTENCY } from '@breeze/shared/m365';
import { M365_HEADLESS_ACTIONS } from '../m365ToolsHeadless';
import { planEffectOperationKey } from './planApproval';
import type { PlannedEffect } from './recipes/types';

const task = { id: '00000000-0000-4000-8000-0000000000a1', orgId: 'o1', attemptOrdinal: 0 };
const effect: PlannedEffect = {
  ordinal: 3, toolName: 'google_remove_from_group', provider: 'google',
  targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: '101',
  canonicalArguments: { groupEmail: 'sales@customer.example', reason: 'offboarding', userEmail: 'dana@customer.example' },
};
const approval = { id: 'p1', planRevision: 2, approverUserId: 'u-approver' };
const member = { ok: true, approvalId: 'p1', approverUserId: 'u-approver', approvedAssuranceLevel: 3, planRevision: 2, idempotencyClass: 'idempotent' };
const dispatch = () => dispatchPlannedEffect({ task, stepKey: 'offboard', approval, effect, partnerId: null });

beforeEach(() => {
  vi.clearAllMocks();
  dbState.inserted = [];
  checkPlanEffectMembershipSystem.mockResolvedValue(member);
  createActionIntent.mockResolvedValue({ id: 'i1', status: 'approved' });
});

describe('dispatchPlannedEffect — the PRE probe', () => {
  it('settles succeeded with noop and dispatches NOTHING when the end state already holds', async () => {
    probeEffect.mockResolvedValue({ state: 'satisfied', observedAt: new Date(), detail: 'already not a member' });
    await expect(dispatch()).resolves.toMatchObject({ kind: 'noop' });
    expect(createActionIntent).not.toHaveBeenCalled();
    expect(dbState.inserted[0]).toMatchObject({
      intentId: null, resultState: 'succeeded', result: expect.objectContaining({ noop: true }),
      operationKey: planEffectOperationKey({ stepKey: 'offboard', planRevision: 2, toolName: effect.toolName, targetId: effect.targetId, ordinal: 3 }),
    });
    expect(appendTaskEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'operation_settled', detail: expect.stringContaining('nothing sent'),
    }));
  });

  it('DISPATCHES when the pre-probe says unsatisfied', async () => {
    probeEffect.mockResolvedValue({ state: 'unsatisfied', observedAt: new Date(), detail: 'still a member' });
    await expect(dispatch()).resolves.toMatchObject({ kind: 'dispatching', intentId: 'i1' });
  });

  it('DISPATCHES an IDEMPOTENT effect whose pre-probe is unknown — unprovable is not permission to skip', async () => {
    probeEffect.mockResolvedValue({ state: 'unknown', observedAt: new Date(), detail: 'API 503' });
    await expect(dispatch()).resolves.toMatchObject({ kind: 'dispatching' });
  });

  it.each(['unknown', 'satisfied'])('HANDS OFF a NON_IDEMPOTENT effect whose pre-probe is %s', async (state) => {
    checkPlanEffectMembershipSystem.mockResolvedValue({ ...member, idempotencyClass: 'non_idempotent' });
    probeEffect.mockResolvedValue({ state, observedAt: new Date(), detail: 'x' });
    await expect(dispatch()).resolves.toMatchObject({ kind: 'handoff' });
    expect(createActionIntent).not.toHaveBeenCalled();
    expect(dbState.inserted).toHaveLength(0);
  });
});

describe('dispatchPlannedEffect — membership and the mint', () => {
  it('REFUSES without any provider I/O or mint when membership fails', async () => {
    checkPlanEffectMembershipSystem.mockResolvedValue({ ok: false, refusal: 'plan_superseded', detail: 'r3' });
    await expect(dispatch()).resolves.toMatchObject({ kind: 'refused', refusal: 'plan_superseded' });
    expect(probeEffect).not.toHaveBeenCalled();
    expect(createActionIntent).not.toHaveBeenCalled();
  });

  it('mints AS the approver with task ctx, the derived operation key and planApproval', async () => {
    probeEffect.mockResolvedValue({ state: 'unsatisfied', observedAt: new Date(), detail: '' });
    await dispatch();
    expect(buildTaskActorAuthContext).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-approver', orgId: 'o1' }));
    expect(createActionIntent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      toolName: 'google_remove_from_group', source: 'mcp_api',
      task: expect.objectContaining({
        taskId: task.id, taskStepKey: 'offboard',
        operationKey: planEffectOperationKey({ stepKey: 'offboard', planRevision: 2, toolName: effect.toolName, targetId: effect.targetId, ordinal: 3 }),
      }),
      planApproval: { approvalId: 'p1', ordinal: 3 },
    }));
    const key = createActionIntent.mock.calls[0]![1].task.operationKey as string;
    expect(key).toContain(':r2:');
    expect(key.endsWith(':n3')).toBe(true);
  });

  it('refuses (does not throw) when the approver can no longer act', async () => {
    probeEffect.mockResolvedValue({ state: 'unsatisfied', observedAt: new Date(), detail: '' });
    buildTaskActorAuthContext.mockResolvedValueOnce(null as never);
    await expect(dispatch()).resolves.toMatchObject({ kind: 'refused', refusal: 'approver_invalid' });
  });

  it('a mint refusal surfaces its code instead of throwing', async () => {
    probeEffect.mockResolvedValue({ state: 'unsatisfied', observedAt: new Date(), detail: '' });
    const { ActionIntentError } = await import('../actionIntents/intentService');
    createActionIntent.mockRejectedValueOnce(new ActionIntentError('nope', 'tool_not_in_agent_allowlist'));
    await expect(dispatch()).resolves.toMatchObject({ kind: 'refused', refusal: 'tool_not_in_agent_allowlist' });
  });

  it('an infrastructure fault from the mint PROPAGATES (retry), never becomes a refusal', async () => {
    probeEffect.mockResolvedValue({ state: 'unsatisfied', observedAt: new Date(), detail: '' });
    createActionIntent.mockRejectedValueOnce(Object.assign(new Error('could not serialize access'), { code: '40001' }));
    await expect(dispatch()).rejects.toThrow('could not serialize access');
  });
});

describe('verifyDispatchedEffect — the POST probe', () => {
  const requestedAt = new Date('2026-09-17T10:00:00Z');
  const verify = (idempotencyClass: 'idempotent' | 'non_idempotent' = 'idempotent') =>
    verifyDispatchedEffect({ task, planRevision: 2, effect, idempotencyClass, effectRequestedAt: requestedAt });

  it('verified only on satisfied', async () => {
    probeEffect.mockResolvedValue({ state: 'satisfied', observedAt: new Date(), detail: 'gone' });
    await expect(verify()).resolves.toMatchObject({ kind: 'verified' });
  });
  it('NEVER verified on unsatisfied; retryable only for an idempotent effect', async () => {
    probeEffect.mockResolvedValue({ state: 'unsatisfied', observedAt: new Date(), detail: 'still' });
    await expect(verify()).resolves.toMatchObject({ kind: 'unverified', retryable: true });
    await expect(verify('non_idempotent')).resolves.toMatchObject({ kind: 'unverified', retryable: false });
  });
  it('UNKNOWN hands off, naming the effect', async () => {
    probeEffect.mockResolvedValue({ state: 'unknown', observedAt: new Date(), detail: 'no probe' });
    const out = await verify();
    expect(out.kind).toBe('handoff');
    expect((out as { handoffSummary: string }).handoffSummary).toContain('google_remove_from_group');
  });
  it('passes effectRequestedAt and phase post to the probe', async () => {
    probeEffect.mockResolvedValue({ state: 'satisfied', observedAt: new Date(), detail: '' });
    await verify();
    expect(probeEffect).toHaveBeenCalledWith(effect, expect.objectContaining({ effectRequestedAt: requestedAt, phase: 'post' }));
  });
});

describe('classifyEffectIdempotency', () => {
  it('defaults an unclassified tool to non_idempotent (never auto-retried)', () => {
    expect(classifyEffectIdempotency('some_future_tool')).toBe('non_idempotent');
    expect(classifyEffectIdempotency('google_remove_from_group')).toBe('idempotent');
    expect(classifyEffectIdempotency('google_set_forwarding')).toBe('idempotent_by_probe');
  });

  it('classifies every headless M365 tool by its action’s spec §6.6 class (M1 #6170)', () => {
    expect(classifyEffectIdempotency('m365_disable_user')).toBe('idempotent');
    expect(classifyEffectIdempotency('m365_reset_password')).toBe('non_idempotent');
    expect(classifyEffectIdempotency('m365_revoke_sessions')).toBe('idempotent_by_probe');
    expect(classifyEffectIdempotency('m365_remove_from_group')).toBe('idempotent');
    expect(classifyEffectIdempotency('m365_assign_license')).toBe('idempotent_by_probe');
    expect(classifyEffectIdempotency('m365_retire_intune_device')).toBe('idempotent');
    expect(classifyEffectIdempotency('m365_create_user')).toBe('non_idempotent');
    expect(classifyEffectIdempotency('m365_set_auto_reply')).toBe('idempotent_by_probe');
    for (const [tool, actionId] of Object.entries(M365_HEADLESS_ACTIONS)) {
      expect(classifyEffectIdempotency(tool)).toBe(M365_WRITE_ACTION_IDEMPOTENCY[actionId]);
    }
  });
});

// ---------------------------------------------------------------------------
// R2a Task 6 (W07 Amendment B5 / G1 / G10; D-R2-4). Appended; every case above
// is unchanged.
//
// PINS THE SHIPPED BRANCH; R2 DEPENDS ON IT. `dispatchPlannedEffect` already
// hands off a `non_idempotent` effect whose pre-probe is anything but
// `unsatisfied` (E4). Onboarding's `m365_create_user` relies on that: its
// pre-probe is "a user with this UPN exists", so `satisfied` means either this
// task created it on an earlier attempt or somebody else holds the UPN, and
// only one reading is safe. These cases pin the branch (they are not reds);
// the one wording case names the possible collision in the `satisfied`
// summary.
//
// G10: `google_account_wipe_mobile_device` is ALREADY `non_idempotent` (it is
// not in EFFECT_IDEMPOTENCY, so `classifyEffectIdempotency` defaults it) and
// ALREADY runs under this shipped branch in the offboarding recipe; it is not
// reclassified here. The catalog case below asserts the M365 half only.
// ---------------------------------------------------------------------------
describe('classifyEffectIdempotency — the Google provisioning writes (R2a)', () => {
  // They mirror their M365 counterparts (m365.user.license.assign is
  // idempotent_by_probe, m365.group.membership.add is idempotent), so a replay
  // whose pre-probe is satisfied is a no-op, not a non_idempotent hand-off.
  it('classifies google_assign_license / google_add_to_group / google_move_ou', () => {
    expect(classifyEffectIdempotency('google_assign_license')).toBe('idempotent_by_probe');
    expect(classifyEffectIdempotency('google_add_to_group')).toBe('idempotent');
    expect(classifyEffectIdempotency('google_move_ou')).toBe('idempotent');
  });
});

describe('dispatchPlannedEffect — the shipped non_idempotent pre-probe branch (R2a Task 6 PIN)', () => {
  const createEffect: PlannedEffect = {
    ordinal: 0, toolName: 'm365_create_user', provider: 'm365',
    targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: null,
    canonicalArguments: { userPrincipalName: 'priya@customer.example', displayName: 'Priya', reason: 'onboarding' },
  };
  const dispatchCreate = () =>
    dispatchPlannedEffect({ task, stepKey: 'create_accounts', approval, effect: createEffect, partnerId: null });

  it('PIN: a non_idempotent create whose pre-probe is SATISFIED hands off — no mint, no noop row', async () => {
    checkPlanEffectMembershipSystem.mockResolvedValue({
      ...member, idempotencyClass: 'non_idempotent', setSecrecy: 'all_secret_bearing',
    });
    probeEffect.mockResolvedValue({ state: 'satisfied', observedAt: new Date(), detail: 'user exists' });
    const out = await dispatchCreate();
    expect(out).toMatchObject({ kind: 'handoff', detail: 'pre-probe for m365_create_user was satisfied: user exists' });
    expect(createActionIntent).not.toHaveBeenCalled();
    expect(buildTaskActorAuthContext).not.toHaveBeenCalled();
    expect(dbState.inserted).toHaveLength(0);
  });

  it('the SATISFIED hand-off names the possible collision', async () => {
    checkPlanEffectMembershipSystem.mockResolvedValue({
      ...member, idempotencyClass: 'non_idempotent', setSecrecy: 'all_secret_bearing',
    });
    probeEffect.mockResolvedValue({ state: 'satisfied', observedAt: new Date(), detail: 'user exists' });
    const out = await dispatchCreate();
    const summary = (out as { handoffSummary: string }).handoffSummary;
    expect(summary).toContain('m365_create_user');
    expect(summary).toMatch(/already exists/);
    expect(summary).toMatch(/collision/);
  });

  it('the SATISFIED hand-off of a NON-create tool keeps the shipped wording (offboarding wipe unchanged)', async () => {
    checkPlanEffectMembershipSystem.mockResolvedValue({
      ...member, idempotencyClass: 'non_idempotent', setSecrecy: 'none_secret_bearing',
    });
    probeEffect.mockResolvedValue({ state: 'satisfied', observedAt: new Date(), detail: 'all devices wiping' });
    const wipe: PlannedEffect = { ...createEffect, toolName: 'google_account_wipe_mobile_device', provider: 'google',
      canonicalArguments: { userEmail: 'dana@customer.example' } };
    const out = await dispatchPlannedEffect({ task, stepKey: 'device_actions', approval, effect: wipe, partnerId: null });
    expect(out).toEqual({
      kind: 'handoff',
      detail: 'pre-probe for google_account_wipe_mobile_device was satisfied: all devices wiping',
      handoffSummary:
        'Breeze did not run google_account_wipe_mobile_device because it cannot be safely repeated and its current state '
        + 'could not be confirmed as not-yet-done (satisfied). Nothing was sent for this step. '
        + 'Check the provider and complete it by hand if it is still needed.',
    });
  });

  it('PIN: the UNKNOWN hand-off summary is unchanged, byte for byte', async () => {
    checkPlanEffectMembershipSystem.mockResolvedValue({
      ...member, idempotencyClass: 'non_idempotent', setSecrecy: 'all_secret_bearing',
    });
    probeEffect.mockResolvedValue({ state: 'unknown', observedAt: new Date(), detail: 'API 503' });
    const out = await dispatchCreate();
    expect(out).toEqual({
      kind: 'handoff',
      detail: 'pre-probe for m365_create_user was unknown: API 503',
      handoffSummary:
        'Breeze did not run m365_create_user because it cannot be safely repeated and its current state '
        + 'could not be confirmed as not-yet-done (unknown). Nothing was sent for this step. '
        + 'Check the provider and complete it by hand if it is still needed.',
    });
    expect(createActionIntent).not.toHaveBeenCalled();
  });

  it('PIN: a non_idempotent create whose pre-probe is UNSATISFIED dispatches (the only actionable pre-state)', async () => {
    checkPlanEffectMembershipSystem.mockResolvedValue({
      ...member, idempotencyClass: 'non_idempotent', setSecrecy: 'all_secret_bearing',
    });
    probeEffect.mockResolvedValue({ state: 'unsatisfied', observedAt: new Date(), detail: 'no such user' });
    await expect(dispatchCreate()).resolves.toMatchObject({ kind: 'dispatching', intentId: 'i1' });
  });

  it('PIN (unchanged): an IDEMPOTENT effect whose pre-probe is satisfied still settles a noop', async () => {
    checkPlanEffectMembershipSystem.mockResolvedValue({
      ...member, idempotencyClass: 'idempotent', setSecrecy: 'none_secret_bearing',
    });
    probeEffect.mockResolvedValue({ state: 'satisfied', observedAt: new Date(), detail: 'already not a member' });
    await expect(dispatch()).resolves.toMatchObject({ kind: 'noop' });
    expect(createActionIntent).not.toHaveBeenCalled();
    expect(dbState.inserted).toHaveLength(1);
  });

  it('G10: no M365 tool in the OFFBOARDING catalog is non_idempotent (the Google wipe already is, by default)', async () => {
    // If a future wave adds a non_idempotent M365 tool to the offboarding
    // catalog, this fails and that wave must re-read D-R2-4 before shipping.
    const { IDENTITY_OFFBOARDING_EFFECT_TOOLS } = await import('./recipes/identityOffboarding');
    const m365Tools = IDENTITY_OFFBOARDING_EFFECT_TOOLS.filter((t) => t in M365_HEADLESS_ACTIONS);
    expect(m365Tools.length).toBeGreaterThan(0);
    for (const tool of m365Tools) {
      const actionId = (M365_HEADLESS_ACTIONS as Record<string, string>)[tool]!;
      expect(
        (M365_WRITE_ACTION_IDEMPOTENCY as Record<string, string>)[actionId],
        `${tool} is non_idempotent and reaches the non_idempotent hand-off branch`,
      ).not.toBe('non_idempotent');
      expect(classifyEffectIdempotency(tool)).not.toBe('non_idempotent');
    }
    // Recorded, not changed: the Google wipe is non_idempotent by default and
    // already runs under the shipped branch.
    expect(IDENTITY_OFFBOARDING_EFFECT_TOOLS).toContain('google_account_wipe_mobile_device');
    expect(classifyEffectIdempotency('google_account_wipe_mobile_device')).toBe('non_idempotent');
  });
});
