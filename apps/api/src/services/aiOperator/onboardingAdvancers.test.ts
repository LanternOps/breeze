/**
 * `identity_onboarding`'s coordinator advancers (W07 R2a Task 12; Amendment
 * B1, B2, B7, B.9 item 12), driven against stubbed coordinator ops,
 * discovery, account resolution, readiness, probes and stores — the seam of
 * `identityAdvancers.test.ts` (hoisted `h`, a stubbed `../../db`, the
 * coordinator's ops mocked), with the select queue keyed by TABLE so a case
 * does not depend on read order. The real recipe, its pure plans, the
 * resolver and the validators are used. Real-row behaviour is Task 15's
 * `aiOperatorIdentityOnboardingE2E.integration.test.ts`.
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { identityOnboardingCheckpointSchema, type IdentityOnboardingCheckpoint } from '@breeze/shared';

const h = vi.hoisted(() => ({
  settle: vi.fn(), yieldToWait: vi.fn(), admitReasoningRun: vi.fn(), settleStepAndMove: vi.fn(),
  writeLeasedStep: vi.fn(), readLatestTaskRun: vi.fn(), advanceEffect: vi.fn(), advanceHumanWork: vi.fn(), advanceWait: vi.fn(),
  loadPlanningFacts: vi.fn(), probeEffect: vi.fn(), discoverOnboardingFacts: vi.fn(), readiness: vi.fn(),
  resolveCreatedAccounts: vi.fn(), commitOnboardingStageTransition: vi.fn(), m365Read: vi.fn(),
  resolveContextByOrg: vi.fn(), googleUsersGet: vi.fn(),
  readManualWork: vi.fn(), ensureManualWorkItems: vi.fn(), buildCompletionRecord: vi.fn(), postCompletionRecord: vi.fn(),
  readHumanWorkStep: vi.fn(), openHumanWorkStep: vi.fn(), ensureTaskTicket: vi.fn(),
  openStep: vi.fn(), settleStep: vi.fn(), appendTaskEvent: vi.fn(),
  /** Select results by table name, each read shifts one. */
  q: {} as Record<string, unknown[][]>,
  updates: [] as Array<{ table: unknown; set: Record<string, unknown>; where: unknown }>,
  /** `.returning()` results in order; the default is the won CAS row. */
  returning: [] as unknown[][],
}));

vi.mock('../../db', async () => {
  const { getTableName } = await import('drizzle-orm');
  const select = () => ({
    from: (table: unknown) => {
      const name = getTableName(table as never);
      const c: any = { where: () => c, orderBy: () => c, for: () => c, limit: async () => h.q[name]?.shift() ?? [] };
      c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(h.q[name]?.shift() ?? []).then(res, rej);
      return c;
    },
  });
  const db = {
    select,
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: unknown) => {
          h.updates.push({ table, set, where });
          const r: any = Promise.resolve([]);
          r.returning = async () => (h.returning.length > 0 ? h.returning.shift() : [{ id: 'task-1' }]);
          return r;
        },
      }),
    }),
  };
  return { db, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() };
});
vi.mock('./taskCoordinator', () => ({
  COORDINATOR_STEP_OPS: {
    settle: h.settle, yieldToWait: h.yieldToWait, admitReasoningRun: h.admitReasoningRun,
    settleStepAndMove: h.settleStepAndMove, writeLeasedStep: h.writeLeasedStep, readLatestTaskRun: h.readLatestTaskRun,
  },
  advanceEffect: h.advanceEffect,
  advanceHumanWork: h.advanceHumanWork,
  advanceWait: h.advanceWait,
}));
vi.mock('./planningSnapshot', async (orig) => ({ ...(await orig<typeof import('./planningSnapshot')>()), loadPlanningFacts: h.loadPlanningFacts }));
vi.mock('./effectProbes', () => ({ probeEffect: h.probeEffect, isStructurallyUnobservable: () => false }));
vi.mock('./identityProvisioning', () => ({ discoverOnboardingFacts: h.discoverOnboardingFacts }));
vi.mock('./onboardingAccounts', async (orig) => ({
  ...(await orig<typeof import('./onboardingAccounts')>()),
  resolveCreatedAccounts: h.resolveCreatedAccounts,
  commitOnboardingStageTransition: h.commitOnboardingStageTransition,
}));
vi.mock('./identityDiscovery', async (orig) => ({
  ...(await orig<typeof import('./identityDiscovery')>()),
  m365Read: h.m365Read,
  inOrgContext: (_org: string, fn: () => unknown) => fn(),
}));
vi.mock('../aiToolsGoogle', async (orig) => ({ ...(await orig<typeof import('../aiToolsGoogle')>()), resolveContextByOrg: h.resolveContextByOrg }));
vi.mock('../googleClient', async (orig) => ({
  ...(await orig<typeof import('../googleClient')>()),
  getDirectoryClient: () => ({ users: { get: h.googleUsersGet } }),
}));
vi.mock('./recipeReadiness', () => ({ computeRecipeReadinessSystem: h.readiness }));
vi.mock('./manualWork', async (orig) => ({
  ...(await orig<typeof import('./manualWork')>()), readManualWork: h.readManualWork, ensureManualWorkItems: h.ensureManualWorkItems,
}));
vi.mock('./completionRecord', async (orig) => ({
  ...(await orig<typeof import('./completionRecord')>()), buildCompletionRecord: h.buildCompletionRecord, postCompletionRecord: h.postCompletionRecord,
}));
vi.mock('./humanWorkService', () => ({
  HUMAN_WORK_POLL_WAKE_MS: 6 * 3600_000, readHumanWorkStep: h.readHumanWorkStep, openHumanWorkStep: h.openHumanWorkStep, ensureTaskTicket: h.ensureTaskTicket,
}));
vi.mock('./stepService', () => ({ openStep: h.openStep, settleStep: h.settleStep, resolveStepKind: () => 'probe' }));
vi.mock('./eventService', () => ({ appendTaskEvent: h.appendTaskEvent }));

import {
  IDENTITY_ONBOARDING_ADVANCERS,
  advanceConfirmDetails,
  advanceManualCreateGoogle,
  advanceOnboardingCreateEffects,
  advanceOnboardingDiscover,
  advanceOnboardingDocument,
  advanceOnboardingIntake,
  advanceOnboardingManualWork,
  advanceOnboardingProvisionEffects,
  advanceOnboardingReview,
  advanceOnboardingVerifyOutcome,
  advanceResolveAccounts,
  advanceWaitStart,
} from './onboardingAdvancers';
import {
  IDENTITY_ONBOARDING_STEP_KEYS,
  buildIdentityOnboardingCreatePlan,
  buildIdentityOnboardingProvisionPlan,
  identityOnboardingRecipe,
} from './recipes/identityOnboarding';
import { identityOffboardingCheckpointSchema } from '@breeze/shared';
import { sealPlanningSnapshot } from './planningSnapshot';
import { planEffectOperationKey } from './planApproval';
import { classifyEffectIdempotency } from './effectDispatch';
import { OnboardingStageTransitionAbort } from './onboardingAccounts';
import { M365ReadFailed } from './identityDiscovery';
import { aiOperatorTasks } from '../../db/schema/aiOperatorTasks';
import { aiOperatorTaskSteps } from '../../db/schema/aiOperatorTaskGraph';
import type { RecipeDefinition } from './recipes/types';

const recipe = identityOnboardingRecipe as unknown as RecipeDefinition<never>;
const ORG = '00000000-0000-4000-8000-0000000000aa';
const CONTACT = '00000000-0000-4000-8000-000000000001';
const MANAGER = '00000000-0000-4000-8000-000000000002';
const STRANGER = '00000000-0000-4000-8000-000000000003';
const CONTACT_TARGET = '00000000-0000-4000-8000-0000000000e1';
const DISCOVER_ROW = '00000000-0000-4000-8000-0000000000d1';
const RESOLVE_ROW = '00000000-0000-4000-8000-0000000000d2';
const SKU = '00000000-0000-4000-8000-00000000c001';
const GROUP = '00000000-0000-4000-8000-00000000c002';
const M365_ID = '00000000-0000-4000-8000-00000000b001';
const GOOGLE_ID = '900100';
const NOW = new Date('2026-10-23T12:00:00.000Z');
const START = '2026-10-27T09:00:00.000Z';
const UPN = 'robin@customer.example';

const INPUT = {
  displayName: 'Robin Vale',
  m365: { userPrincipalName: UPN, mailNickname: 'robin', usageLocation: 'US', skuIds: [SKU], groupIds: [GROUP] },
  google: { primaryEmail: UPN, givenName: 'Robin', familyName: 'Vale', groupEmails: ['team@customer.example'] },
};

function cp(over: Record<string, unknown> = {}, input: Record<string, unknown> = {}): IdentityOnboardingCheckpoint {
  return identityOnboardingCheckpointSchema.parse({
    version: 1, checkpointKind: 'identity_onboarding', recipeInput: { ...INPUT, ...input }, ...over,
  });
}
function task(stepKey: string, over: Record<string, unknown> = {}) {
  return {
    id: 'task-1', orgId: ORG, revision: 1, leaseEpoch: 3, attemptOrdinal: 0, state: 'running', currentStepKey: stepKey,
    workflowKey: 'identity_onboarding', workflowVersion: 1, objective: 'Onboard Robin', requesterUserId: 'u1', ...over,
  } as never;
}
const args = (stepKey: string, checkpoint = cp(), over: Record<string, unknown> = {}) =>
  ({ task: task(stepKey, over), leaseEpoch: 3, checkpoint, recipe, now: NOW });

const DISCOVERED = {
  collisions: { m365: { upnTaken: false, existingObjectId: null }, google: { emailTaken: false, existingUserId: null } },
  seats: { m365: [{ skuId: SKU, skuPartNumber: 'SPE_E3', state: 'available', available: 3, observedAt: NOW.toISOString(), reason: null }] },
  groups: {
    m365: [{ id: GROUP, name: 'Staff', dynamic: false, roleAssignable: null }],
    google: [{ email: 'team@customer.example', name: 'Team', modelAfterRole: null }],
  },
  modelAfter: null,
  flags: [],
  truncated: [],
};
const S1 = {
  stage: 'create', targets: { contactTargetId: CONTACT_TARGET, contactLabel: 'Robin Vale' },
  ...DISCOVERED, degradedTools: [] as string[], capabilityReadiness: {},
};
const S2 = {
  ...S1, stage: 'provision',
  accounts: { m365: { externalId: M365_ID, principalLabel: UPN }, google: { externalId: GOOGLE_ID, principalLabel: UPN } },
};
const READY = { readiness: 'ready', degradedEffects: [], callerVerificationBlocked: [], capabilityReadiness: {} };
const CONTACT_ROW = [{ id: CONTACT_TARGET, label: 'Robin Vale', contactId: CONTACT }];
const REF1 = { stepId: DISCOVER_ROW, digest: 'a'.repeat(64) };
const REF2 = { stepId: RESOLVE_ROW, digest: 'b'.repeat(64) };

function stepRun(key: string, inputs: Record<string, unknown>) {
  return { id: 'run-1', status: 'completed', outcome: { taskStep: { version: 1, findings: [], nextStep: { kind: 'step', key, inputs } } } };
}
/** The task-row writes, in order (the CAS first). */
const taskWrites = () => h.updates.filter((u) => u.table === aiOperatorTasks);
const settled = () => h.settle.mock.calls.map((c) => c[0] as { event: string; outcome: string; detail: string; handoffSummary?: string });

beforeAll(async () => {
  await Promise.all([
    import('./recipes/resolveNextStep'), import('./taskCoordinator'), import('./recipes'), import('./recipes/identityOnboarding'),
    import('./planningSnapshot'), import('./planApproval'), import('./effectProbes'), import('./identityProvisioning'),
    import('./onboardingAccounts'), import('./identityDiscovery'), import('./recipeReadiness'), import('./taskContextOnboarding'),
    import('./manualWork'), import('./completionRecord'), import('./humanWorkService'), import('./stepService'), import('./eventService'),
    import('../aiToolsGoogle'), import('../googleClient'),
  ]);
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  h.q = {};
  h.updates = [];
  h.returning = [];
  h.openStep.mockResolvedValue({ id: DISCOVER_ROW });
  h.readiness.mockResolvedValue(READY);
});

// ---------------------------------------------------------------------------

describe('the advancer table', () => {
  it('1. every one of the twelve step keys has an onboarding advancer — none falls through to "unknown step"', () => {
    expect(Object.keys(IDENTITY_ONBOARDING_ADVANCERS).sort()).toEqual([...IDENTITY_ONBOARDING_STEP_KEYS].sort());
    for (const k of IDENTITY_ONBOARDING_STEP_KEYS) expect(typeof IDENTITY_ONBOARDING_ADVANCERS[k]).toBe('function');
    expect(IDENTITY_ONBOARDING_ADVANCERS.create_accounts).toBe(advanceOnboardingCreateEffects);
    expect(IDENTITY_ONBOARDING_ADVANCERS.provision_effects).toBe(advanceOnboardingProvisionEffects);
    expect(IDENTITY_ONBOARDING_ADVANCERS.resolve_accounts).toBe(advanceResolveAccounts);
    expect(IDENTITY_ONBOARDING_ADVANCERS.wait_start).toBe(advanceWaitStart);
    expect(IDENTITY_ONBOARDING_ADVANCERS.manual_create_google).toBe(advanceManualCreateGoogle);
  });

  // PIN of shipped behaviour (Task 6 / effectDispatch.ts:143), green on first run by design.
  it('9. the create is classified non_idempotent, so a satisfied pre-probe hands off (E4 + Task 6), never no-ops', () => {
    expect(classifyEffectIdempotency('m365_create_user')).toBe('non_idempotent');
  });

  it('every advancer refuses a non-onboarding checkpoint arm with a settle, never a throw', async () => {
    const offboarding = identityOffboardingCheckpointSchema.parse({ version: 1, recipeInput: { contactId: CONTACT } });
    for (const k of IDENTITY_ONBOARDING_STEP_KEYS) {
      vi.clearAllMocks();
      const out = await IDENTITY_ONBOARDING_ADVANCERS[k]!({ ...args(k), checkpoint: offboarding as never });
      expect(out, k).toBe('failed: checkpoint arm mismatch');
      expect(h.settle, k).toHaveBeenCalledWith(expect.objectContaining({ event: 'fail', detail: expect.stringContaining('without an onboarding checkpoint') }));
      expect(h.advanceEffect, k).not.toHaveBeenCalled();
    }
  });
});

describe('intake', () => {
  it('2. an unknown contact settles fail and does NOT open confirm_details', async () => {
    h.readLatestTaskRun.mockResolvedValue(stepRun('confirm_details', {
      managerCandidateContactIds: [MANAGER], modelAfterCandidateContactIds: [STRANGER], ambiguous: false, rationale: 'r',
    }));
    h.q.ai_operator_task_targets = [CONTACT_ROW];
    h.q.contacts = [[{ id: MANAGER, name: 'Morgan Lee' }]]; // STRANGER is not this org's
    await advanceOnboardingIntake(args('intake'));
    expect(settled()[0]).toMatchObject({ event: 'fail', outcome: 'unresolved', detail: expect.stringContaining('unknown_contact') });
    expect(h.openStep).not.toHaveBeenCalled();
    expect(taskWrites()).toEqual([]);
  });

  it('a valid intake moves into confirm_details with resumeStepKey = discover; the rationale is an event, not a decision', async () => {
    h.readLatestTaskRun.mockResolvedValue(stepRun('confirm_details', {
      managerCandidateContactIds: [MANAGER], modelAfterCandidateContactIds: [], ambiguous: true, rationale: 'same surname in the ticket',
    }));
    h.q.ai_operator_task_targets = [CONTACT_ROW, [{ id: CONTACT_TARGET }]];
    h.q.contacts = [[{ id: MANAGER, name: 'Morgan Lee' }]];
    await advanceOnboardingIntake(args('intake'));
    const cas = taskWrites()[0]!;
    expect(cas.set.currentStepKey).toBe('confirm_details');
    const c = cas.set.checkpoint as IdentityOnboardingCheckpoint;
    expect(c.resumeStepKey).toBe('discover');
    expect(c.findings.at(-1)!.text).toContain('Morgan Lee');
    expect(c.findings.at(-1)!.text).not.toContain('same surname');
    expect(h.settleStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      stepKey: 'intake', state: 'succeeded', detail: expect.stringContaining('same surname in the ticket'),
    }));
    expect(h.openStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stepKey: 'confirm_details' }));
  });

  it('16. an unresolvable successor settles fail with the resolver\'s detail — never guessed', async () => {
    h.readLatestTaskRun.mockResolvedValue(stepRun('confirm_details', {
      managerCandidateContactIds: [], modelAfterCandidateContactIds: [], ambiguous: false, rationale: 'r',
    }));
    h.q.ai_operator_task_targets = [CONTACT_ROW];
    const { next: _drop, ...noNext } = recipe.steps.confirm_details as unknown as { next?: unknown } & Record<string, unknown>;
    void _drop;
    const broken = { ...recipe, steps: { ...recipe.steps, confirm_details: noNext } } as never;
    await advanceOnboardingIntake({ ...args('intake'), recipe: broken });
    expect(settled()[0]).toMatchObject({ event: 'fail', detail: expect.stringContaining("next step after 'confirm_details' could not be resolved") });
    expect(taskWrites()).toEqual([]);
  });
});

describe('confirm_details', () => {
  it('opens ONE item naming the new hire and the accounts to create, then hands later wakes to advanceHumanWork', async () => {
    h.readHumanWorkStep.mockResolvedValue(null);
    h.q.ai_operator_task_targets = [CONTACT_ROW];
    h.openHumanWorkStep.mockResolvedValue({ stepId: 's', checklistItemId: 'item-1', ticketId: 't' });
    await advanceConfirmDetails(args('confirm_details', cp({ resumeStepKey: 'discover' })));
    const opened = h.openHumanWorkStep.mock.calls[0]![1];
    expect(opened.stepKey).toBe('confirm_details');
    expect(opened.label).toContain('Robin Vale');
    expect(opened.detail).toContain(UPN);
    expect((taskWrites()[0]!.set.checkpoint as IdentityOnboardingCheckpoint).resumeStepKey).toBe('discover');

    vi.clearAllMocks();
    h.readHumanWorkStep.mockResolvedValue({ dependencyId: 'item-1', checklistItemId: 'item-1', itemLabel: 'x', itemDoneAt: null });
    h.advanceHumanWork.mockResolvedValue('waiting');
    const a = args('confirm_details', cp({ resumeStepKey: 'discover' }));
    await advanceConfirmDetails(a);
    expect(h.advanceHumanWork).toHaveBeenCalledWith(a);
    expect(h.ensureManualWorkItems).not.toHaveBeenCalled();
  });
});

describe('discover', () => {
  it('3. seals snapshot 1 (stage create, targets frozen) and the ref in ONE leased transaction; one collision is a fact, not a hand-off', async () => {
    h.q.ai_operator_task_targets = [CONTACT_ROW, [{ id: CONTACT_TARGET }]];
    h.discoverOnboardingFacts.mockResolvedValue({
      ...DISCOVERED, collisions: { ...DISCOVERED.collisions, m365: { upnTaken: true, existingObjectId: 'obj-1111' } },
    });
    h.readiness.mockResolvedValue({ ...READY, degradedEffects: ['google_move_ou', 'not_a_catalog_tool'], capabilityReadiness: { 'google.directory.ou_write': false } });
    await advanceOnboardingDiscover(args('discover', cp({ resumeStepKey: 'discover' })));
    expect(settled()).toEqual([]);
    const stepWrite = h.updates.find((u) => u.table === aiOperatorTaskSteps)!;
    const envelope = (stepWrite.set.checkpoint as { planningSnapshot: { facts: Record<string, any> } }).planningSnapshot;
    expect(envelope.facts.stage).toBe('create');
    expect(envelope.facts.targets).toEqual({ contactTargetId: CONTACT_TARGET, contactLabel: 'Robin Vale' });
    expect(envelope.facts.degradedTools).toEqual(['google_move_ou']);
    const ref = (taskWrites().at(-1)!.set.checkpoint as IdentityOnboardingCheckpoint).planningSnapshot!;
    expect(ref.stepId).toBe(DISCOVER_ROW);
    expect(ref.digest).toBe(sealPlanningSnapshot(envelope.facts, new Date(0)).digest);
    expect(h.settleStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stepKey: 'discover', state: 'succeeded' }));
    expect(h.openStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stepKey: 'review' }));
    expect((taskWrites()[0]!.set.checkpoint as IdentityOnboardingCheckpoint).resumeStepKey).toBe('create_accounts');
  });

  it('4. hands off when EVERY in-scope provider\'s collision check could not run (null), with no snapshot written', async () => {
    h.q.ai_operator_task_targets = [CONTACT_ROW];
    h.discoverOnboardingFacts.mockResolvedValue({
      ...DISCOVERED,
      collisions: { m365: { upnTaken: null, existingObjectId: null }, google: { emailTaken: null, existingUserId: null } },
    });
    await advanceOnboardingDiscover(args('discover'));
    expect(settled()[0]).toMatchObject({ event: 'hand_off', detail: expect.stringContaining('collision') });
    expect(h.updates).toEqual([]);
  });

  it('…but NOT when one in-scope check ran (the other provider is null)', async () => {
    h.q.ai_operator_task_targets = [CONTACT_ROW, [{ id: CONTACT_TARGET }]];
    h.discoverOnboardingFacts.mockResolvedValue({
      ...DISCOVERED, collisions: { m365: { upnTaken: null, existingObjectId: null }, google: { emailTaken: false, existingUserId: null } },
    });
    await advanceOnboardingDiscover(args('discover'));
    expect(settled()).toEqual([]);
    expect(h.openStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stepKey: 'review' }));
  });

  it('a transient fault RETHROWS (the wake retries) and settles nothing', async () => {
    h.q.ai_operator_task_targets = [CONTACT_ROW];
    h.discoverOnboardingFacts.mockRejectedValue(new Error('connection terminated'));
    await expect(advanceOnboardingDiscover(args('discover'))).rejects.toThrow('connection terminated');
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('refuses to re-discover a task that already holds a snapshot', async () => {
    await advanceOnboardingDiscover(args('discover', cp({ planningSnapshot: REF1 })));
    expect(settled()[0]).toMatchObject({ event: 'fail', detail: expect.stringContaining('already holds') });
  });
});

describe('review', () => {
  const output = { flags: [], exceptions: [], summary: 'Routine onboarding.' };

  it('7. writes createPlanRevision and resumeStepKey and NOTHING else on the checkpoint; proposes nothing', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S1 });
    h.readLatestTaskRun.mockResolvedValue(stepRun('create_accounts', output));
    h.q.ai_operator_task_targets = [[{ id: CONTACT_TARGET }]];
    const before = cp({ planningSnapshot: REF1, resumeStepKey: 'create_accounts' });
    await advanceOnboardingReview(args('review', before, { revision: 4 }));
    expect(h.loadPlanningFacts).toHaveBeenCalledWith(expect.anything(), recipe, before, 'review');
    const cas = taskWrites()[0]!;
    expect(cas.set.currentStepKey).toBe('create_accounts');
    const after = cas.set.checkpoint as IdentityOnboardingCheckpoint;
    const changed = Object.keys(after).filter((k) => JSON.stringify((after as never)[k]) !== JSON.stringify((before as never)[k]));
    expect(changed.sort()).toEqual(['createPlanRevision', 'resumeStepKey']);
    expect(after.createPlanRevision).toBe(4);
    // Google in scope and its address strictly free → the manual create is next.
    expect(after.resumeStepKey).toBe('manual_create_google');
    expect(h.advanceEffect).not.toHaveBeenCalled();
  });

  it('…resumes at resolve_accounts when the Google address collided', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: { ...S1, collisions: { ...S1.collisions, google: { emailTaken: true, existingUserId: 'g-1' } } } });
    h.readLatestTaskRun.mockResolvedValue(stepRun('create_accounts', output));
    h.q.ai_operator_task_targets = [[{ id: CONTACT_TARGET }]];
    await advanceOnboardingReview(args('review', cp({ planningSnapshot: REF1 })));
    expect((taskWrites()[0]!.set.checkpoint as IdentityOnboardingCheckpoint).resumeStepKey).toBe('resolve_accounts');
  });

  it('an exception about a provisioning tool (not in the CREATE plan it reviewed) is refused', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S1 });
    h.readLatestTaskRun.mockResolvedValue(stepRun('create_accounts', {
      ...output, exceptions: [{ toolName: 'm365_add_to_group', classification: 'retry', detail: 'd' }],
    }));
    await advanceOnboardingReview(args('review', cp({ planningSnapshot: REF1 })));
    expect(settled()[0]).toMatchObject({ event: 'fail', detail: expect.stringContaining('unknown_tool') });
    expect(taskWrites()).toEqual([]);
  });

  it('a missing snapshot fails closed BEFORE a run is spent (no approval exists yet at review)', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: false, reason: 'snapshot_digest_mismatch', detail: 'altered' });
    await advanceOnboardingReview(args('review', cp({ planningSnapshot: REF1 })));
    expect(settled()[0]).toMatchObject({ event: 'fail', detail: expect.stringContaining('snapshot_digest_mismatch') });
    expect(h.readLatestTaskRun).not.toHaveBeenCalled();
  });
});

describe('the effect wrappers (live-readiness veto + stage check over advanceEffect)', () => {
  const createKeyFor = (ordinal: number, toolName: string) =>
    planEffectOperationKey({ stepKey: 'create_accounts', planRevision: 1, toolName, targetId: CONTACT_TARGET, ordinal });

  it('readiness intact → advanceEffect exactly once with the same args', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S1 });
    h.q.ai_operator_operations = [[]];
    h.advanceEffect.mockResolvedValue('waiting: approval');
    const a = args('create_accounts', cp({ planningSnapshot: REF1, resumeStepKey: 'manual_create_google' }));
    expect(await advanceOnboardingCreateEffects(a)).toBe('waiting: approval');
    expect(h.advanceEffect).toHaveBeenCalledWith(a);
    expect(h.loadPlanningFacts).toHaveBeenCalledWith(expect.anything(), recipe, a.checkpoint, 'create_accounts');
  });

  it('Todd\'s D3: a not-yet-started planned create whose readiness is now lost hands off and never calls advanceEffect', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S1 });
    h.readiness.mockResolvedValue({ ...READY, degradedEffects: ['m365_create_user'] });
    h.q.ai_operator_operations = [[]];
    await advanceOnboardingCreateEffects(args('create_accounts', cp({ planningSnapshot: REF1 })));
    expect(settled()[0]).toMatchObject({ event: 'hand_off', detail: expect.stringContaining('m365_create_user') });
    expect(h.advanceEffect).not.toHaveBeenCalled();
  });

  it('…an in-flight effect is observed first: the veto delegates while an operation is pending', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S2 });
    h.readiness.mockResolvedValue({ ...READY, degradedEffects: ['m365_add_to_group'] });
    h.q.ai_operator_operations = [[{ operationKey: 'k', resultState: 'pending' }]];
    await advanceOnboardingProvisionEffects(args('provision_effects', cp({ planningSnapshot: REF2 }), { revision: 2 }));
    expect(h.advanceEffect).toHaveBeenCalledTimes(1);
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('14. an executor refusal arrives as a FAILED operation: the wrapper adds no branch — E4\'s walk hands off naming the rest', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S2 });
    const plan = buildIdentityOnboardingProvisionPlan(cp().recipeInput, S2);
    const lic = plan.find((e) => e.toolName === 'm365_assign_license')!;
    h.q.ai_operator_operations = [[{
      operationKey: planEffectOperationKey({ stepKey: 'provision_effects', planRevision: 2, toolName: lic.toolName, targetId: lic.targetId, ordinal: lic.ordinal }),
      resultState: 'failed',
    }]];
    h.advanceEffect.mockResolvedValue('handed off: m365_assign_license failed. Not done by Breeze: m365_add_to_group.');
    const out = await advanceOnboardingProvisionEffects(args('provision_effects', cp({ planningSnapshot: REF2 }), { revision: 2 }));
    expect(out).toContain('Not done by Breeze');
    expect(h.advanceEffect).toHaveBeenCalledTimes(1);
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('stage mismatch at create_accounts BEFORE any approval at r: settles fail and does NOT delegate', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S2 });
    h.q.ai_operator_plan_approvals = [[]];
    await advanceOnboardingCreateEffects(args('create_accounts', cp({ planningSnapshot: REF1 })));
    expect(settled()[0]).toMatchObject({ event: 'fail', detail: expect.stringContaining("stage 'provision'") });
    expect(h.advanceEffect).not.toHaveBeenCalled();
  });

  it('stage mismatch at create_accounts WITH an approval at r: hands off (unknown_effect while an operation is unsettled)', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S2 });
    h.q.ai_operator_plan_approvals = [[{ id: 'appr-1' }]];
    h.q.ai_operator_operations = [[{ id: 'op-1' }]];
    await advanceOnboardingCreateEffects(args('create_accounts', cp({ planningSnapshot: REF1 })));
    expect(settled()[0]).toMatchObject({ event: 'hand_off', outcome: 'unknown_effect' });
    expect(h.advanceEffect).not.toHaveBeenCalled();
  });

  it('stage mismatch at provision_effects ALWAYS hands off (stage 1 may have created an account)', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S1 });
    h.q.ai_operator_operations = [[]];
    await advanceOnboardingProvisionEffects(args('provision_effects', cp({ planningSnapshot: REF2 }), { revision: 2 }));
    expect(settled()[0]).toMatchObject({ event: 'hand_off', outcome: 'unresolved', detail: expect.stringContaining("stage 'create'") });
    expect(h.advanceEffect).not.toHaveBeenCalled();
  });

  it('a snapshot load failure is E4\'s to classify (B2\'s branch lives in planBuildFailure): delegate', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: false, reason: 'snapshot_wrong_step', detail: 'x' });
    await advanceOnboardingProvisionEffects(args('provision_effects', cp({ planningSnapshot: REF1 }), { revision: 2 }));
    expect(h.advanceEffect).toHaveBeenCalledTimes(1);
  });

  it('an effect that already has an operation row is never vetoed', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S1 });
    h.readiness.mockResolvedValue({ ...READY, degradedEffects: ['m365_create_user'] });
    h.q.ai_operator_operations = [[{ operationKey: createKeyFor(0, 'm365_create_user'), resultState: 'succeeded' }]];
    await advanceOnboardingCreateEffects(args('create_accounts', cp({ planningSnapshot: REF1 })));
    expect(h.advanceEffect).toHaveBeenCalledTimes(1);
  });
});

describe('manual_create_google — arms its successor on first entry', () => {
  it('opens the item from buildManualCreateGoogleItem and writes resumeStepKey = resolve_accounts', async () => {
    h.readHumanWorkStep.mockResolvedValue(null);
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S1 });
    h.openHumanWorkStep.mockResolvedValue({ stepId: 's', checklistItemId: 'item-g', ticketId: 't' });
    // Entered by create_accounts' generic move, which kept its own key.
    await advanceManualCreateGoogle(args('manual_create_google', cp({ planningSnapshot: REF1, resumeStepKey: 'manual_create_google' })));
    const opened = h.openHumanWorkStep.mock.calls[0]![1];
    expect(opened.stepKey).toBe('manual_create_google');
    expect(opened.label).toContain("Robin Vale's Google Workspace account");
    expect(opened.detail).toContain(UPN);
    expect((taskWrites()[0]!.set.checkpoint as IdentityOnboardingCheckpoint).resumeStepKey).toBe('resolve_accounts');
    expect(h.advanceHumanWork).not.toHaveBeenCalled();
  });

  it('every later wake delegates to E3\'s advanceHumanWork', async () => {
    h.readHumanWorkStep.mockResolvedValue({ dependencyId: 'item-g', checklistItemId: 'item-g', itemLabel: 'x', itemDoneAt: null });
    const a = args('manual_create_google', cp({ planningSnapshot: REF1, resumeStepKey: 'resolve_accounts' }));
    await advanceManualCreateGoogle(a);
    expect(h.advanceHumanWork).toHaveBeenCalledWith(a);
  });
});

describe('wait_start — arms waitUntil and its successor, then E3\'s advanceWait', () => {
  it('delegates with waitUntil = input.startAt and resumeStepKey = manual_work', async () => {
    h.advanceWait.mockResolvedValue('waiting');
    // Entered by provision_effects' generic move, which kept its own key.
    await advanceWaitStart(args('wait_start', cp({ planningSnapshot: REF2, resumeStepKey: 'wait_start' }, { startAt: START }), { revision: 2 }));
    const passed = h.advanceWait.mock.calls[0]![0].checkpoint as IdentityOnboardingCheckpoint;
    expect(passed.waitUntil).toBe(START);
    expect(passed.resumeStepKey).toBe('manual_work');
  });

  it('a wait_start with no start time hands off (the accounts exist) and never sleeps', async () => {
    await advanceWaitStart(args('wait_start', cp({ planningSnapshot: REF2 }), { revision: 2 }));
    expect(settled()[0]).toMatchObject({ event: 'hand_off' });
    expect(h.advanceWait).not.toHaveBeenCalled();
  });
});

describe('resolve_accounts (B2 order, B7)', () => {
  const RESOLVED = {
    ok: true, accounts: S2.accounts, connectionIds: { m365: 'conn-m', google: 'conn-g' }, unresolved: [],
  };
  const OUT = {
    newRevision: 2, resolveStepId: RESOLVE_ROW, snapshot: REF2, envelope: {}, contactTargetId: CONTACT_TARGET,
    frozen: ['google', 'm365'], supersededApprovalId: 'appr-1',
  };
  const resolveCp = () => cp({ planningSnapshot: REF1, createPlanRevision: 1, resumeStepKey: 'resolve_accounts' });

  it('happy path: reads outside the tx, then ONE leased write that commits the transition and moves to provision_effects at r+1', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S1 });
    h.resolveCreatedAccounts.mockResolvedValue(RESOLVED);
    h.commitOnboardingStageTransition.mockResolvedValue(OUT);
    h.q.ai_operator_task_targets = [[{ id: CONTACT_TARGET }]];
    const out = await advanceResolveAccounts(args('resolve_accounts', resolveCp()));
    expect(out).toContain('advanced');
    expect(h.resolveCreatedAccounts).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, taskId: 'task-1', createPlanRevision: 1, facts: S1 }));
    expect(h.commitOnboardingStageTransition).toHaveBeenCalledTimes(1);
    const [, commitArgs] = h.commitOnboardingStageTransition.mock.calls[0]!;
    expect(commitArgs).toMatchObject({ createPlanRevision: 1, leaseEpoch: 3, snapshotRef: REF1, facts: S1, resolved: RESOLVED });
    const writes = taskWrites();
    // 1: the CAS at r with an EMPTY patch (no step, checkpoint or revision change).
    expect(Object.keys(writes[0]!.set)).toEqual(['updatedAt']);
    const cas = new PgDialect().sqlToQuery(writes[0]!.where as SQL);
    expect(cas.params).toEqual(['task-1', ORG, 1, 3]);
    // 2: the move, at r+1.
    const move = writes[1]!;
    expect(move.set.currentStepKey).toBe('provision_effects');
    const moved = move.set.checkpoint as IdentityOnboardingCheckpoint;
    expect(moved.planningSnapshot).toEqual(REF2);
    expect(moved.resumeStepKey).toBe('manual_work');
    expect(moved.createPlanRevision).toBe(1);
    expect(new PgDialect().sqlToQuery(move.where as SQL).params).toEqual(['task-1', ORG, 2, 3]);
    expect(h.settleStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stepKey: 'resolve_accounts', state: 'succeeded' }));
    expect(h.openStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stepKey: 'provision_effects', planRevision: 2 }));
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('with a start date, provision_effects\' successor is wait_start', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S1 });
    h.resolveCreatedAccounts.mockResolvedValue(RESOLVED);
    h.commitOnboardingStageTransition.mockResolvedValue(OUT);
    await advanceResolveAccounts(args('resolve_accounts', cp({ planningSnapshot: REF1, createPlanRevision: 1 }, { startAt: START })));
    expect((taskWrites()[1]!.set.checkpoint as IdentityOnboardingCheckpoint).resumeStepKey).toBe('wait_start');
  });

  it('10. no_account_resolved hands off naming what is left and does NOT bump', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: { ...S1, collisions: { ...S1.collisions, m365: { upnTaken: true, existingObjectId: 'obj-1111' } } } });
    h.resolveCreatedAccounts.mockResolvedValue({
      ok: false, reason: 'no_account_resolved', detail: 'no created account resolved',
      unresolved: [{ provider: 'm365', reason: 'upn_collision', detail: 'taken' }, { provider: 'google', reason: 'manual_item_not_ticked', detail: 'n' }],
    });
    await advanceResolveAccounts(args('resolve_accounts', resolveCp()));
    const s = settled()[0]!;
    expect(s).toMatchObject({ event: 'hand_off', detail: expect.stringContaining('no_account_resolved') });
    expect(s.handoffSummary).toContain('upn_collision');
    expect(s.handoffSummary).toContain(UPN);
    expect(h.commitOnboardingStageTransition).not.toHaveBeenCalled();
    expect(taskWrites()).toEqual([]);
  });

  it('the collision path still bumps: M365 collided (empty create plan), Google resolved', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: { ...S1, collisions: { ...S1.collisions, m365: { upnTaken: true, existingObjectId: 'obj-1111' } } } });
    h.resolveCreatedAccounts.mockResolvedValue({ ...RESOLVED, accounts: { m365: null, google: S2.accounts.google }, unresolved: [{ provider: 'm365', reason: 'upn_collision', detail: 't' }] });
    h.commitOnboardingStageTransition.mockResolvedValue({ ...OUT, frozen: ['google'], supersededApprovalId: null });
    await advanceResolveAccounts(args('resolve_accounts', resolveCp()));
    expect(h.commitOnboardingStageTransition).toHaveBeenCalledTimes(1);
    expect(taskWrites()[1]!.set.currentStepKey).toBe('provision_effects');
  });

  it.each(['email_collision', 'collision_unchecked', 'create_not_planned'] as const)(
    '(pin) an expected-absent unresolved provider (%s) still bumps: nothing was created there',
    async (reason) => {
      h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S1 });
      h.resolveCreatedAccounts.mockResolvedValue({ ...RESOLVED, accounts: { m365: S2.accounts.m365, google: null }, unresolved: [{ provider: 'google', reason, detail: 't' }] });
      h.commitOnboardingStageTransition.mockResolvedValue({ ...OUT, frozen: ['m365'] });
      await advanceResolveAccounts(args('resolve_accounts', resolveCp()));
      expect(h.commitOnboardingStageTransition).toHaveBeenCalledTimes(1);
      expect(h.settle).not.toHaveBeenCalled();
    },
  );

  it.each(['account_read_failed', 'account_mismatch'] as const)(
    'M365 create succeeded but its read-back is %s while Google resolves: hands off naming M365, NO bump, no leased write',
    async (reason) => {
      h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S1 });
      h.resolveCreatedAccounts.mockResolvedValue({
        ...RESOLVED, accounts: { m365: null, google: S2.accounts.google },
        unresolved: [{ provider: 'm365', reason, detail: 'read-back refused' }],
      });
      h.q.ai_operator_operations = [[]];
      const out = await advanceResolveAccounts(args('resolve_accounts', resolveCp()));
      expect(out).toContain('handed off');
      expect(h.commitOnboardingStageTransition).not.toHaveBeenCalled();
      expect(taskWrites()).toEqual([]);
      const s = settled()[0]!;
      expect(s).toMatchObject({ event: 'hand_off', outcome: 'unresolved' });
      expect(s.detail).toContain('m365');
      expect(s.detail).toContain(reason);
      expect(s.handoffSummary).toContain('Microsoft 365');
      expect(s.handoffSummary).toMatch(/may (already )?exist/);
      expect(s.handoffSummary).toMatch(/before (anything is|creating anything)/);
    },
  );

  it('Google ticked but account_not_found while M365 resolves: hands off naming Google, NO bump', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S1 });
    h.resolveCreatedAccounts.mockResolvedValue({
      ...RESOLVED, accounts: { m365: S2.accounts.m365, google: null },
      unresolved: [{ provider: 'google', reason: 'account_not_found', detail: 'no user' }],
    });
    await advanceResolveAccounts(args('resolve_accounts', resolveCp()));
    expect(h.commitOnboardingStageTransition).not.toHaveBeenCalled();
    expect(taskWrites()).toEqual([]);
    const s = settled()[0]!;
    expect(s).toMatchObject({ event: 'hand_off' });
    expect(s.detail).toContain('account_not_found');
    expect(s.handoffSummary).toContain('Google Workspace');
  });

  it('…an unexpected-absent provider with an UNSETTLED operation hands off unknown_effect', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S1 });
    h.resolveCreatedAccounts.mockResolvedValue({
      ...RESOLVED, accounts: { m365: null, google: S2.accounts.google },
      unresolved: [{ provider: 'm365', reason: 'create_result_unproven', detail: 'pending' }],
    });
    h.q.ai_operator_operations = [[{ id: 'op-1' }]];
    await advanceResolveAccounts(args('resolve_accounts', resolveCp()));
    expect(h.commitOnboardingStageTransition).not.toHaveBeenCalled();
    expect(settled()[0]).toMatchObject({ event: 'hand_off', outcome: 'unknown_effect' });
  });

  it('(pin of shipped behaviour) an operation_unsettled abort inside the transaction hands off with outcome unknown_effect', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S1 });
    h.resolveCreatedAccounts.mockResolvedValue(RESOLVED);
    h.commitOnboardingStageTransition.mockRejectedValue(new OnboardingStageTransitionAbort('operation_unsettled', 'op pending'));
    const out = await advanceResolveAccounts(args('resolve_accounts', resolveCp()));
    expect(out).toContain('handed off');
    expect(h.settleStep).not.toHaveBeenCalled();
    expect(settled()[0]).toMatchObject({ event: 'hand_off', outcome: 'unknown_effect', detail: expect.stringContaining('operation_unsettled') });
  });

  it('a guard miss inside the transaction is the typed sentinel, caught OUTSIDE: nothing more is written, the task hands off', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S1 });
    h.resolveCreatedAccounts.mockResolvedValue(RESOLVED);
    h.commitOnboardingStageTransition.mockRejectedValue(new OnboardingStageTransitionAbort('snapshot_ref_moved', 'moved'));
    const out = await advanceResolveAccounts(args('resolve_accounts', resolveCp()));
    expect(out).toContain('handed off');
    expect(taskWrites()).toHaveLength(1); // the CAS only; the transaction rolled back
    expect(h.settleStep).not.toHaveBeenCalled();
    expect(h.openStep).not.toHaveBeenCalled();
    expect(settled()[0]).toMatchObject({ event: 'hand_off', detail: expect.stringContaining('snapshot_ref_moved') });
  });

  it('a lost bump (another holder moved the task) returns lost-lease and settles nothing', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S1 });
    h.resolveCreatedAccounts.mockResolvedValue(RESOLVED);
    h.commitOnboardingStageTransition.mockRejectedValue(new OnboardingStageTransitionAbort('bump_lost', 'b'));
    expect(await advanceResolveAccounts(args('resolve_accounts', resolveCp()))).toContain('lost lease');
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('the move at r+1 missing its row is the same sentinel: rolled back, lost-lease', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S1 });
    h.resolveCreatedAccounts.mockResolvedValue(RESOLVED);
    h.commitOnboardingStageTransition.mockResolvedValue(OUT);
    h.returning = [[{ id: 'task-1' }], []]; // CAS wins; the r+1 move matches nothing
    expect(await advanceResolveAccounts(args('resolve_accounts', resolveCp()))).toContain('lost lease');
    expect(h.settleStep).not.toHaveBeenCalled();
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('a lost CAS commits nothing and calls no transition', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S1 });
    h.resolveCreatedAccounts.mockResolvedValue(RESOLVED);
    h.returning = [[]];
    expect(await advanceResolveAccounts(args('resolve_accounts', resolveCp()))).toContain('lost lease');
    expect(h.commitOnboardingStageTransition).not.toHaveBeenCalled();
  });

  it('re-entry with the ref already on a succeeded resolve_accounts row writes NOTHING', async () => {
    h.loadPlanningFacts.mockImplementation(async (_t: unknown, _r: unknown, _c: unknown, stepKey: string) => (stepKey === 'resolve_accounts'
      ? { ok: false, reason: 'snapshot_wrong_step', detail: "is 'resolve_accounts', not 'discover'" }
      : { ok: true, facts: S2 }));
    const out = await advanceResolveAccounts(args('resolve_accounts', cp({ planningSnapshot: REF2, createPlanRevision: 1 }), { revision: 2 }));
    expect(out).toContain('already');
    expect(h.updates).toEqual([]);
    expect(h.settle).not.toHaveBeenCalled();
    expect(h.resolveCreatedAccounts).not.toHaveBeenCalled();
  });

  it('a snapshot failure hands off (stage 1 may have created an account), never fails', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: false, reason: 'snapshot_digest_mismatch', detail: 'altered' });
    h.q.ai_operator_operations = [[]];
    await advanceResolveAccounts(args('resolve_accounts', resolveCp()));
    expect(settled()[0]).toMatchObject({ event: 'hand_off' });
    expect(h.resolveCreatedAccounts).not.toHaveBeenCalled();
  });

  it('createPlanRevision missing or not the task\'s revision hands off before any read', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S1 });
    await advanceResolveAccounts(args('resolve_accounts', cp({ planningSnapshot: REF1, createPlanRevision: null })));
    await advanceResolveAccounts(args('resolve_accounts', cp({ planningSnapshot: REF1, createPlanRevision: 1 }), { revision: 5 }));
    expect(settled().map((s) => s.event)).toEqual(['hand_off', 'hand_off']);
    expect(h.resolveCreatedAccounts).not.toHaveBeenCalled();
  });

  it('a transient provider fault RETHROWS (the wake retries)', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S1 });
    h.resolveCreatedAccounts.mockRejectedValue(new Error('graph throttled'));
    await expect(advanceResolveAccounts(args('resolve_accounts', resolveCp()))).rejects.toThrow('graph throttled');
    expect(h.settle).not.toHaveBeenCalled();
  });
});

describe('manual_work (R1\'s cursor pattern on onboardingWorkCursor)', () => {
  const mwCp = () => cp({ planningSnapshot: REF2, createPlanRevision: 1, resumeStepKey: 'manual_work' });
  const row = (index: number, over: Record<string, unknown> = {}) => ({
    index, stepId: `s${index}`, stepState: 'waiting', checklistItemId: `i${index}`, itemLabel: 'x',
    itemDoneAt: null, itemDoneByUserId: null, ...over,
  });
  beforeEach(() => { h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S2 }); });

  it('creates every item up front from SNAPSHOT 2 and waits, writing onboardingWorkCursor (never manualWorkCursor)', async () => {
    h.q.ai_operator_task_steps = [[{ checkpoint: { reviewOutput: { flags: [{ code: 'unverified_domain', subject: 'customer.example', detail: 'd' }], exceptions: [], summary: 's' } } }]];
    h.q.ai_operator_task_targets = [[{ id: CONTACT_TARGET }]];
    h.readManualWork.mockResolvedValue([]);
    h.ensureManualWorkItems.mockImplementation(async (_db: unknown, _t: unknown, items: unknown[]) => ({
      ticketId: 't', itemIds: items.map((_, i) => `i${i}`), created: items.length,
    }));
    await advanceOnboardingManualWork(args('manual_work', mwCp(), { revision: 2 }));
    expect(h.loadPlanningFacts).toHaveBeenCalledWith(expect.anything(), recipe, expect.anything(), 'manual_work');
    const items = h.ensureManualWorkItems.mock.calls[0]![2] as Array<{ key: string }>;
    expect(items.map((i) => i.key)).toContain('credential_handover');
    expect(items.map((i) => i.key)).toContain('flag:unverified_domain:customer.example');
    const c = taskWrites()[0]!.set.checkpoint as Record<string, unknown>;
    expect(c.onboardingWorkCursor).toBe(0);
    expect('manualWorkCursor' in c).toBe(false);
  });

  it('a DETACHED item hands off — it is never re-created on a new ticket', async () => {
    h.q.ai_operator_task_steps = [[]];
    h.readManualWork.mockResolvedValue([row(0), row(1, { checklistItemId: null, itemLabel: null })]);
    await advanceOnboardingManualWork(args('manual_work', mwCp(), { revision: 2 }));
    expect(h.ensureManualWorkItems).not.toHaveBeenCalled();
    expect(settled()[0]).toMatchObject({ event: 'hand_off', detail: expect.stringContaining('no longer reachable') });
  });

  it('waits on the next open item and records its index on onboardingWorkCursor', async () => {
    h.q.ai_operator_task_steps = [[]];
    h.q.ai_operator_task_targets = [[{ id: CONTACT_TARGET }]];
    const items = (await import('./recipes/identityOnboarding')).buildIdentityOnboardingManualWork(mwCp().recipeInput, S2, {}, []);
    h.readManualWork.mockResolvedValue(items.map((_, i) => row(i, i < 2 ? { itemDoneAt: NOW, itemDoneByUserId: 'u2' } : {})));
    await advanceOnboardingManualWork(args('manual_work', mwCp(), { revision: 2 }));
    const w = taskWrites()[0]!;
    expect(w.set.waitDependencyId).toBe('i2');
    expect((w.set.checkpoint as IdentityOnboardingCheckpoint).onboardingWorkCursor).toBe(2);
  });

  it('all done → moves to verify_outcome with resumeStepKey = document', async () => {
    h.q.ai_operator_task_steps = [[]];
    h.q.ai_operator_task_targets = [[{ id: CONTACT_TARGET }]];
    const items = (await import('./recipes/identityOnboarding')).buildIdentityOnboardingManualWork(mwCp().recipeInput, S2, {}, []);
    h.readManualWork.mockResolvedValue(items.map((_, i) => row(i, { itemDoneAt: NOW, itemDoneByUserId: 'u2' })));
    await advanceOnboardingManualWork(args('manual_work', mwCp(), { revision: 2 }));
    const w = taskWrites()[0]!;
    expect(w.set.currentStepKey).toBe('verify_outcome');
    expect((w.set.checkpoint as IdentityOnboardingCheckpoint).resumeStepKey).toBe('document');
  });

  it('a snapshot failure after stage 1 hands off, never fails', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: false, reason: 'snapshot_wrong_step', detail: 'x' });
    h.q.ai_operator_operations = [[]];
    await advanceOnboardingManualWork(args('manual_work', mwCp(), { revision: 2 }));
    expect(settled()[0]).toMatchObject({ event: 'hand_off' });
  });
});

describe('verify_outcome (D-R2-11: a conjunction; no subsumption branch)', () => {
  const vCp = () => cp({ planningSnapshot: REF2, createPlanRevision: 1, resumeStepKey: 'document' });
  const DISPATCHED = new Date('2026-10-22T09:00:00.000Z');
  const verdict = () => (h.settleStepAndMove.mock.calls[0]![0].checkpoint as IdentityOnboardingCheckpoint).lastVerification!;
  function walkRows(facts: typeof S2 = S2, skip: (tool: string) => boolean = () => false) {
    const input = vCp().recipeInput;
    const s1 = { ...facts, stage: 'create' } as Record<string, unknown>;
    delete s1.accounts;
    const create = buildIdentityOnboardingCreatePlan(input, s1).map((e) => ({ e, step: 'create_accounts', rev: 1 }));
    const provision = buildIdentityOnboardingProvisionPlan(input, facts).map((e) => ({ e, step: 'provision_effects', rev: 2 }));
    return [...create, ...provision].filter(({ e }) => !skip(e.toolName)).map(({ e, step, rev }) => ({
      operationKey: planEffectOperationKey({ stepKey: step, planRevision: rev, toolName: e.toolName, targetId: e.targetId, ordinal: e.ordinal }),
      dispatchedAt: DISPATCHED,
    }));
  }
  beforeEach(() => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: S2 });
    h.probeEffect.mockResolvedValue({ state: 'satisfied', detail: 'd', observedAt: NOW });
    h.m365Read.mockResolvedValue({ ok: true, kind: 'resource', resource: { id: M365_ID, userPrincipalName: UPN, accountEnabled: true } });
    h.resolveContextByOrg.mockResolvedValue({ conn: { adminEmail: 'admin@customer.example' }, keyJson: '{}' });
    h.googleUsersGet.mockResolvedValue({ data: { id: GOOGLE_ID, primaryEmail: UPN, suspended: false } });
  });

  it('15a. verified_resolved: every dispatched effect (both stages) post-probes satisfied AND each account exists and is enabled', async () => {
    h.q.ai_operator_operations = [walkRows()];
    await advanceOnboardingVerifyOutcome(args('verify_outcome', vCp(), { revision: 2 }));
    expect(verdict().result).toBe('passed');
    expect(h.settleStepAndMove).toHaveBeenCalledWith(expect.objectContaining({ toStepKey: 'document' }));
    const probed = h.probeEffect.mock.calls.map((c) => [c[0].toolName, c[1].planRevision]);
    expect(probed).toContainEqual(['m365_create_user', 1]);
    expect(probed).toContainEqual(['m365_assign_license', 2]);
    for (const call of h.probeEffect.mock.calls) {
      expect(call[1]).toMatchObject({ phase: 'post', effectRequestedAt: DISPATCHED });
    }
  });

  it('15b. an observable effect that probed unknown is partial, with that effect listed', async () => {
    h.q.ai_operator_operations = [walkRows()];
    h.probeEffect.mockImplementation(async (e: { toolName: string }) => ({ state: e.toolName === 'google_add_to_group' ? 'unknown' : 'satisfied', detail: 'd', observedAt: NOW }));
    await advanceOnboardingVerifyOutcome(args('verify_outcome', vCp(), { revision: 2 }));
    expect(verdict().result).toBe('failed');
    expect(verdict().detail).toContain('google_add_to_group (unknown)');
  });

  it('a created account that is not enabled is partial (the opposite polarity of offboarding)', async () => {
    h.q.ai_operator_operations = [walkRows()];
    h.m365Read.mockResolvedValue({ ok: true, kind: 'resource', resource: { id: M365_ID, userPrincipalName: UPN, accountEnabled: false } });
    await advanceOnboardingVerifyOutcome(args('verify_outcome', vCp(), { revision: 2 }));
    expect(verdict().result).toBe('failed');
    expect(verdict().detail).toContain('Microsoft 365 account');
  });

  it('an unverifiable creation is partial, never verified_resolved: an in-scope provider with no resolved account', async () => {
    const googleCollided = {
      ...S2, collisions: { ...S2.collisions, google: { emailTaken: true, existingUserId: 'g-1' } },
      accounts: { m365: S2.accounts.m365, google: null },
    };
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: googleCollided });
    h.q.ai_operator_operations = [walkRows(googleCollided as never)];
    await advanceOnboardingVerifyOutcome(args('verify_outcome', vCp(), { revision: 2 }));
    expect(verdict().result).toBe('failed');
    expect(verdict().detail).toContain('Google Workspace account');
  });

  it('…and an account read that fails definitively is partial too', async () => {
    h.q.ai_operator_operations = [walkRows()];
    h.m365Read.mockRejectedValue(new M365ReadFailed('graph_forbidden', 'no'));
    await advanceOnboardingVerifyOutcome(args('verify_outcome', vCp(), { revision: 2 }));
    expect(verdict().result).toBe('failed');
  });

  it('15c. degradation is not failure: a degraded provision tool was never planned, so it does not block verified_resolved', async () => {
    const degraded = { ...S2, degradedTools: ['m365_add_to_group'] };
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: degraded });
    h.q.ai_operator_operations = [walkRows(degraded as never)];
    await advanceOnboardingVerifyOutcome(args('verify_outcome', vCp(), { revision: 2 }));
    expect(h.probeEffect.mock.calls.map((c) => c[0].toolName)).not.toContain('m365_add_to_group');
    expect(verdict().result).toBe('passed');
  });

  it('…and a degraded CREATE leaves that provider to people without blocking the verdict', async () => {
    const degraded = { ...S2, degradedTools: ['m365_create_user'], accounts: { m365: null, google: S2.accounts.google } };
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: degraded });
    h.q.ai_operator_operations = [walkRows(degraded as never)];
    await advanceOnboardingVerifyOutcome(args('verify_outcome', vCp(), { revision: 2 }));
    expect(verdict().result).toBe('passed');
  });

  it('a planned effect with NO operation row never ran: unconfirmed, and not probed', async () => {
    h.q.ai_operator_operations = [walkRows(S2, (t) => t === 'm365_assign_license')];
    await advanceOnboardingVerifyOutcome(args('verify_outcome', vCp(), { revision: 2 }));
    expect(verdict().result).toBe('failed');
    expect(verdict().detail).toContain('m365_assign_license (not dispatched)');
    expect(h.probeEffect.mock.calls.map((c) => c[0].toolName)).not.toContain('m365_assign_license');
  });

  // PIN of the recipe's declaration (Task 3), green on first run by design.
  it('the recipe declares no unobservable effects, so there is nothing to subsume (asserted, not branched)', () => {
    expect(identityOnboardingRecipe.unobservableEffects).toEqual({});
  });
});

describe('document', () => {
  beforeEach(() => {
    h.buildCompletionRecord.mockResolvedValue({ text: 'record', truncated: false, ticketId: 't' });
    h.q.ai_operator_task_targets = [[{ id: CONTACT_TARGET }]];
  });

  it('posts the record, then settles verified_resolved from a passed verdict', async () => {
    await advanceOnboardingDocument(args('document', cp({ lastVerification: { result: 'passed', detail: 'ok', at: NOW.toISOString() } }), { revision: 2 }));
    expect(h.buildCompletionRecord).toHaveBeenCalledWith({ orgId: ORG, taskId: 'task-1', recipeKey: 'identity_onboarding' });
    expect(h.postCompletionRecord).toHaveBeenCalledTimes(1);
    expect(settled()[0]).toMatchObject({ event: 'complete', outcome: 'verified_resolved' });
  });

  it('a failed verdict is partial, with an onboarding hand-off summary', async () => {
    await advanceOnboardingDocument(args('document', cp({ lastVerification: { result: 'failed', detail: 'x', at: NOW.toISOString() } }), { revision: 2 }));
    const s = settled()[0]!;
    expect(s).toMatchObject({ event: 'partial', outcome: 'unresolved' });
    expect(s.handoffSummary).toContain('onboarding');
  });
});
