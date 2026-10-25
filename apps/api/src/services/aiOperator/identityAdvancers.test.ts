/**
 * `identity_offboarding`'s coordinator advancers (W06 R1a Task 11), driven
 * against stubbed coordinator ops, discovery, readiness, probes and stores.
 * The real recipe, its pure plan, the resolver and the validators are used.
 * Real-row behaviour is `aiOperatorIdentityOffboardingE2E.integration.test.ts`.
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { identityOffboardingCheckpointSchema, type IdentityOffboardingCheckpoint } from '@breeze/shared';

const h = vi.hoisted(() => ({
  settle: vi.fn(), yieldToWait: vi.fn(), admitReasoningRun: vi.fn(), settleStepAndMove: vi.fn(),
  writeLeasedStep: vi.fn(), readLatestTaskRun: vi.fn(), advanceEffect: vi.fn(), advanceHumanWork: vi.fn(),
  loadPlanningFacts: vi.fn(), probeEffect: vi.fn(), discoverIdentityFacts: vi.fn(), readiness: vi.fn(),
  readManualWork: vi.fn(), ensureManualWorkItems: vi.fn(), buildCompletionRecord: vi.fn(), postCompletionRecord: vi.fn(),
  readHumanWorkStep: vi.fn(), openHumanWorkStep: vi.fn(), ensureTaskTicket: vi.fn(),
  openStep: vi.fn(), settleStep: vi.fn(), appendTaskEvent: vi.fn(),
  selectQueue: [] as unknown[][],
  updates: [] as Array<{ table: unknown; set: Record<string, unknown>; where: unknown }>,
  casRows: [{ id: 'task-1' }] as unknown[],
}));

vi.mock('../../db', () => {
  const chain = () => {
    const c: any = { from: () => c, where: () => c, orderBy: () => c, limit: async () => h.selectQueue.shift() ?? [] };
    // a select awaited without .limit()
    c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(h.selectQueue.shift() ?? []).then(res, rej);
    return c;
  };
  const db = {
    select: () => chain(),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: unknown) => {
          h.updates.push({ table, set, where });
          const r: any = Promise.resolve([]);
          r.returning = async () => h.casRows;
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
}));
vi.mock('./planningSnapshot', async (orig) => ({ ...(await orig<typeof import('./planningSnapshot')>()), loadPlanningFacts: h.loadPlanningFacts }));
vi.mock('./effectProbes', () => ({ probeEffect: h.probeEffect, isStructurallyUnobservable: (t: string) => t === 'google_signout' }));
vi.mock('./identityDiscovery', () => ({ discoverIdentityFacts: h.discoverIdentityFacts }));
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
  IDENTITY_OFFBOARDING_ADVANCERS,
  advanceDiscover,
  advanceIdentityEffects,
  advanceIntake,
  advanceManualWork,
  advanceReview,
  advanceVerifyOutcome,
  leasedWrite,
  residualAfterOffboarding,
} from './identityAdvancers';
import { IDENTITY_OFFBOARDING_EFFECT_TOOLS, IDENTITY_OFFBOARDING_STEP_KEYS, identityOffboardingRecipe } from './recipes/identityOffboarding';
import { sealPlanningSnapshot } from './planningSnapshot';
import { aiOperatorTasks } from '../../db/schema/aiOperatorTasks';
import { aiOperatorTaskSteps } from '../../db/schema/aiOperatorTaskGraph';
import { isSecretBearingTool } from '../actionIntents/secretBearingTools';
import type { RecipeDefinition } from './recipes/types';
import { TicketMergedError } from '../ticketMerge/errors';

const recipe = identityOffboardingRecipe as unknown as RecipeDefinition<never>;
const ORG = '00000000-0000-4000-8000-0000000000aa';
const CONTACT = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const CONTACT_TARGET = '00000000-0000-4000-8000-0000000000e1';
const NOW = new Date('2026-10-23T12:00:00.000Z');

function cp(over: Partial<IdentityOffboardingCheckpoint> = {}, input: Record<string, unknown> = {}): IdentityOffboardingCheckpoint {
  return identityOffboardingCheckpointSchema.parse({ version: 1, recipeInput: { contactId: CONTACT, ...input }, ...over });
}
function task(stepKey: string, over: Record<string, unknown> = {}) {
  return {
    id: 'task-1', orgId: ORG, revision: 1, leaseEpoch: 3, attemptOrdinal: 0, state: 'running', currentStepKey: stepKey,
    workflowKey: 'identity_offboarding', workflowVersion: 1, objective: 'Offboard Dana', requesterUserId: 'u1', ...over,
  } as never;
}
const args = (stepKey: string, checkpoint = cp(), over: Record<string, unknown> = {}) =>
  ({ task: task(stepKey, over), leaseEpoch: 3, checkpoint, recipe, now: NOW });

const FACTS = {
  version: 1, observedAt: NOW.toISOString(),
  google: {
    present: true, externalId: '101', primaryEmail: 'dana@customer.example', suspended: false,
    groups: [{ id: 'g1', name: 'All', email: 'all@customer.example', ownership: 'shared', dynamic: false, roleAssignable: false }],
    licenses: [], mobileDevices: [],
  },
  m365: {
    present: true, externalId: 'obj-1', userPrincipalName: 'dana@customer.example', accountEnabled: true,
    groups: [], licenses: [], intuneDevices: [{ id: 'id1', model: 'PHONE', status: null }],
  },
  breeze: { suggestedDevices: [] }, inheritor: null, flags: [], truncated: [],
};
const SNAPSHOT_FACTS = { ...FACTS, targets: { contactTargetId: CONTACT_TARGET, contactLabel: 'Dana Ruiz', deviceLabels: {} }, degradedTools: [], capabilityReadiness: {} };
const TARGETS = [{ id: CONTACT_TARGET, kind: 'contact', label: 'Dana Ruiz', contactId: CONTACT, deviceId: null, ordinal: 0 }];
const ACCOUNTS = [
  { provider: 'google', externalId: '101', principalLabel: 'dana@customer.example' },
  { provider: 'm365', externalId: 'obj-1', principalLabel: 'dana@customer.example' },
];
const READY = { readiness: 'ready', degradedEffects: [], callerVerificationBlocked: [], capabilityReadiness: {} };

function stepRun(key: string, inputs: Record<string, unknown>) {
  return { id: 'run-1', status: 'completed', outcome: { taskStep: { version: 1, findings: [], nextStep: { kind: 'step', key, inputs } } } };
}

// The advancers load their service graph lazily on first call; load it once
// here so no single case pays that cost against the default timeout.
beforeAll(async () => {
  await Promise.all([
    import('./recipes/resolveNextStep'), import('./taskCoordinator'), import('./recipes'), import('./recipes/identityOffboarding'),
    import('./planningSnapshot'), import('./planApproval'), import('./effectProbes'), import('./identityDiscovery'),
    import('./recipeReadiness'), import('./taskContextIdentity'), import('./manualWork'), import('./completionRecord'),
    import('./humanWorkService'), import('./stepService'), import('./eventService'),
  ]);
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  h.selectQueue = [];
  h.updates = [];
  h.casRows = [{ id: 'task-1' }];
  h.openStep.mockResolvedValue({ id: '00000000-0000-4000-8000-0000000000d5' });
  h.readiness.mockResolvedValue(READY);
});

describe('the advancer table', () => {
  it('1. every step key resolves to an R1 advancer — none falls through to "unknown step"', () => {
    expect(Object.keys(IDENTITY_OFFBOARDING_ADVANCERS).sort()).toEqual([...IDENTITY_OFFBOARDING_STEP_KEYS].sort());
    for (const k of IDENTITY_OFFBOARDING_STEP_KEYS) expect(typeof IDENTITY_OFFBOARDING_ADVANCERS[k]).toBe('function');
  });

  it('confirm_identity hands every wake after the opening one to E3\'s generic advanceHumanWork', async () => {
    h.readHumanWorkStep.mockResolvedValue({ dependencyId: 'item-1', checklistItemId: 'item-1', itemLabel: 'x', itemDoneAt: null });
    h.advanceHumanWork.mockResolvedValue('waiting');
    const a = args('confirm_identity', cp({ resumeStepKey: 'discover' }));
    await IDENTITY_OFFBOARDING_ADVANCERS.confirm_identity!(a);
    expect(h.advanceHumanWork).toHaveBeenCalledWith(a);
  });

  it('5. no tool in the closed catalog is secret-bearing', () => {
    expect(IDENTITY_OFFBOARDING_EFFECT_TOOLS.every((t) => !isSecretBearingTool(t))).toBe(true);
  });
});

describe('leasedWrite — the mirrored lease CAS', () => {
  it('CASes on (id, org_id, revision, lease_epoch) and runs alsoInTransaction ONLY when it won', async () => {
    const also = vi.fn();
    expect(await leasedWrite({ orgId: ORG, taskId: 'task-1', revision: 4, leaseEpoch: 9, patch: { phase: 'plan' }, alsoInTransaction: also })).toBe(true);
    const q = new PgDialect().sqlToQuery(h.updates[0]!.where as SQL);
    expect(q.sql).toBe('("ai_operator_tasks"."id" = $1 and "ai_operator_tasks"."org_id" = $2 and "ai_operator_tasks"."revision" = $3 and "ai_operator_tasks"."lease_epoch" = $4)');
    expect(q.params).toEqual(['task-1', ORG, 4, 9]);
    expect(also).toHaveBeenCalledTimes(1);
    h.casRows = [];
    const lost = vi.fn();
    expect(await leasedWrite({ orgId: ORG, taskId: 'task-1', revision: 4, leaseEpoch: 9, patch: {}, alsoInTransaction: lost })).toBe(false);
    expect(lost).not.toHaveBeenCalled();
  });
});

describe('advanceIntake', () => {
  it('2. an unknown contact settles fail and does NOT open confirm_identity', async () => {
    h.readLatestTaskRun.mockResolvedValue(stepRun('confirm_identity', { candidateContactIds: [OTHER], ambiguous: false, rationale: 'r' }));
    h.selectQueue = [TARGETS, ACCOUNTS, []]; // targets, accounts, the org-scoped existence read (OTHER not in org)
    await advanceIntake(args('intake'));
    expect(h.settle).toHaveBeenCalledWith(expect.objectContaining({ event: 'fail', outcome: 'unresolved', detail: expect.stringContaining('unknown_contact') }));
    expect(h.writeLeasedStep).not.toHaveBeenCalled();
  });

  it('11. a valid intake moves into confirm_identity with resumeStepKey = discover (that step\'s successor)', async () => {
    h.readLatestTaskRun.mockResolvedValue(stepRun('confirm_identity', { candidateContactIds: [CONTACT], ambiguous: false, rationale: 'exact email' }));
    h.selectQueue = [TARGETS, ACCOUNTS, [{ id: CONTACT }]];
    await advanceIntake(args('intake'));
    const [, , toStep, , checkpoint] = h.writeLeasedStep.mock.calls[0]!;
    expect(toStep).toBe('confirm_identity');
    expect(checkpoint.resumeStepKey).toBe('discover');
    expect(checkpoint.findings.at(-1).text).toContain('is among them');
  });

  it('a model proposal of any OTHER step (e.g. discover) is refused — the human confirmation cannot be skipped', async () => {
    h.readLatestTaskRun.mockResolvedValue(stepRun('discover', {}));
    await advanceIntake(args('intake'));
    expect(h.settle).toHaveBeenCalledWith(expect.objectContaining({ event: 'fail', detail: expect.stringContaining('step_not_permitted') }));
    expect(h.writeLeasedStep).not.toHaveBeenCalled();
  });

  it('no run yet admits one; an in-flight run re-arms the wait', async () => {
    h.readLatestTaskRun.mockResolvedValue(null);
    h.admitReasoningRun.mockResolvedValue({ admitted: true, detail: 'admitted' });
    await advanceIntake(args('intake'));
    expect(h.admitReasoningRun).toHaveBeenCalledWith(expect.objectContaining({ stepKey: 'intake', bumpPlanRevision: false }));
    h.readLatestTaskRun.mockResolvedValue({ id: 'run-1', status: 'running', outcome: null });
    await advanceIntake(args('intake'));
    expect(h.yieldToWait).toHaveBeenCalledWith(expect.objectContaining({ reason: 'information', dependency: { kind: 'run', id: 'run-1' } }));
  });
});

describe('advanceDiscover', () => {
  it('3. seals the envelope on the discover step row AND the ref on the task in ONE leased transaction', async () => {
    h.selectQueue = [TARGETS, ACCOUNTS, [{ id: CONTACT_TARGET }]];
    h.discoverIdentityFacts.mockResolvedValue(FACTS);
    h.readiness.mockResolvedValue({
      ...READY, degradedEffects: ['m365_retire_intune_device', 'm365_disable_user', 'not_a_catalog_tool'],
      callerVerificationBlocked: ['m365_disable_user'], capabilityReadiness: { 'm365.graph.intune_retire': false },
    });
    await advanceDiscover(args('discover', cp({ resumeStepKey: 'discover' })));
    expect(h.readiness).toHaveBeenCalledWith(ORG, recipe, { ignoreFlag: true });

    // The CAS update, then the step-row envelope, then the task-checkpoint ref.
    expect(h.updates[0]!.table).toBe(aiOperatorTasks);
    const stepWrite = h.updates.find((u) => u.table === aiOperatorTaskSteps)!;
    const envelope = (stepWrite.set.checkpoint as { planningSnapshot: { facts: Record<string, any> } }).planningSnapshot;
    expect(envelope.facts.targets.contactTargetId).toBe(CONTACT_TARGET);
    expect(envelope.facts.degradedTools).toEqual(['m365_retire_intune_device', 'm365_disable_user']);
    expect(envelope.facts.callerVerificationTools).toEqual(['m365_disable_user']);
    const refWrite = h.updates.filter((u) => u.table === aiOperatorTasks).at(-1)!;
    const ref = (refWrite.set.checkpoint as IdentityOffboardingCheckpoint).planningSnapshot!;
    expect(ref.stepId).toBe('00000000-0000-4000-8000-0000000000d5');
    // The digest depends on the facts alone, never on capturedAt.
    expect(ref.digest).toBe(sealPlanningSnapshot(envelope.facts, new Date(0)).digest);
    expect(h.settleStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stepKey: 'discover', state: 'succeeded' }));
    expect(h.openStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stepKey: 'review' }));
  });

  it('hands off when neither provider account is present, with no snapshot written', async () => {
    h.selectQueue = [TARGETS, ACCOUNTS];
    h.discoverIdentityFacts.mockResolvedValue({ ...FACTS, google: { ...FACTS.google, present: false }, m365: { ...FACTS.m365, present: false } });
    await advanceDiscover(args('discover'));
    expect(h.settle).toHaveBeenCalledWith(expect.objectContaining({ event: 'hand_off' }));
    expect(h.updates).toEqual([]);
  });

  it('12. a transient I/O fault RETHROWS (the wake retries) and settles nothing', async () => {
    h.selectQueue = [TARGETS, ACCOUNTS];
    h.discoverIdentityFacts.mockRejectedValue(new Error('connection terminated'));
    await expect(advanceDiscover(args('discover'))).rejects.toThrow('connection terminated');
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('refuses to re-discover a task that already holds a snapshot', async () => {
    await advanceDiscover(args('discover', cp({ planningSnapshot: { stepId: '00000000-0000-4000-8000-0000000000f1', digest: 'a'.repeat(64) } })));
    expect(h.settle).toHaveBeenCalledWith(expect.objectContaining({ event: 'fail', detail: expect.stringContaining('already holds') }));
  });
});

describe('advanceReview', () => {
  const review = { flags: [], exceptions: [], summary: 'Looks routine.' };

  it('4. plans from the SNAPSHOT (degraded tool absent), writes manual_work + the cutoff, proposes nothing', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: { ...SNAPSHOT_FACTS, degradedTools: ['m365_retire_intune_device'] } });
    h.readLatestTaskRun.mockResolvedValue(stepRun('effects', {
      ...review, exceptions: [{ toolName: 'm365_retire_intune_device', classification: 'retry', detail: 'd' }],
    }));
    await advanceReview(args('review', cp({}, { cutoffAt: '2026-10-24T17:00:00.000Z', effects: { wipeMobile: true } })));
    // The exception names a tool the snapshot plan does NOT hold → refused.
    expect(h.settle).toHaveBeenCalledWith(expect.objectContaining({ event: 'fail', detail: expect.stringContaining('unknown_tool') }));

    vi.clearAllMocks();
    h.casRows = [{ id: 'task-1' }];
    h.updates = [];
    h.openStep.mockResolvedValue({ id: 'step-review' });
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: { ...SNAPSHOT_FACTS, degradedTools: ['m365_retire_intune_device'] } });
    h.readLatestTaskRun.mockResolvedValue(stepRun('effects', review));
    h.selectQueue = [[{ id: CONTACT_TARGET }]];
    await advanceReview(args('review', cp({}, { cutoffAt: '2026-10-24T17:00:00.000Z', effects: { wipeMobile: true } })));
    const cas = h.updates[0]!;
    expect(cas.set.currentStepKey).toBe('effects');
    expect((cas.set.checkpoint as IdentityOffboardingCheckpoint).resumeStepKey).toBe('manual_work');
    expect((cas.set.checkpoint as IdentityOffboardingCheckpoint).dispatchNotBefore).toBe('2026-10-24T17:00:00.000Z');
    const stepWrite = h.updates.find((u) => u.table === aiOperatorTaskSteps)!;
    expect(stepWrite.set.checkpoint).toEqual({ reviewOutput: review });
    expect(h.advanceEffect).not.toHaveBeenCalled();
  });

  it('6 (review). a missing or altered snapshot fails closed BEFORE a run is spent', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: false, reason: 'snapshot_digest_mismatch', detail: 'altered' });
    await advanceReview(args('review'));
    expect(h.settle).toHaveBeenCalledWith(expect.objectContaining({ event: 'fail', detail: expect.stringContaining('snapshot_digest_mismatch') }));
    expect(h.admitReasoningRun).not.toHaveBeenCalled();
    expect(h.readLatestTaskRun).not.toHaveBeenCalled();
  });

  it('a handoff-classified exception hands off before anything is proposed', async () => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: SNAPSHOT_FACTS });
    h.readLatestTaskRun.mockResolvedValue(stepRun('effects', {
      ...review, exceptions: [{ toolName: 'google_suspend_user', classification: 'handoff', detail: 'is the CEO' }],
    }));
    await advanceReview(args('review'));
    expect(h.settle).toHaveBeenCalledWith(expect.objectContaining({ event: 'hand_off', detail: expect.stringContaining('is the CEO') }));
  });
});

describe('advanceIdentityEffects — the live-readiness veto', () => {
  beforeEach(() => { h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: SNAPSHOT_FACTS }); });

  it('6. readiness intact → advanceEffect exactly once with the same args', async () => {
    h.selectQueue = [[]];
    h.advanceEffect.mockResolvedValue('waiting: approval');
    const a = args('effects', cp({ resumeStepKey: 'manual_work' }));
    expect(await advanceIdentityEffects(a)).toBe('waiting: approval');
    expect(h.advanceEffect).toHaveBeenCalledTimes(1);
    expect(h.advanceEffect).toHaveBeenCalledWith(a);
  });

  it('7. a not-yet-started planned tool that is now unready hands off and never calls advanceEffect', async () => {
    h.readiness.mockResolvedValue({ ...READY, degradedEffects: ['google_suspend_user'] });
    h.selectQueue = [[]];
    await advanceIdentityEffects(args('effects', cp({ resumeStepKey: 'manual_work' })));
    expect(h.settle).toHaveBeenCalledWith(expect.objectContaining({ event: 'hand_off', detail: expect.stringContaining('google_suspend_user') }));
    expect(h.advanceEffect).not.toHaveBeenCalled();
  });

  it('7. while an earlier effect is still pending it DELEGATES, so E4 observes the in-flight effect first', async () => {
    h.readiness.mockResolvedValue({ ...READY, degradedEffects: ['google_suspend_user'] });
    h.selectQueue = [[{ operationKey: 'effects:google_set_vacation:x:r1:n0', resultState: 'pending' }]];
    await advanceIdentityEffects(args('effects', cp({ resumeStepKey: 'manual_work' })));
    expect(h.advanceEffect).toHaveBeenCalledTimes(1);
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('an effect that already has an operation row is never vetoed', async () => {
    h.readiness.mockResolvedValue({ ...READY, degradedEffects: ['google_set_vacation'] });
    const key = (await import('./planApproval')).planEffectOperationKey({
      stepKey: 'effects', planRevision: 1, toolName: 'google_set_vacation', targetId: CONTACT_TARGET, ordinal: 0,
    });
    h.selectQueue = [[{ operationKey: key, resultState: 'succeeded' }]];
    await advanceIdentityEffects(args('effects', cp({ resumeStepKey: 'manual_work' })));
    expect(h.advanceEffect).toHaveBeenCalledTimes(1);
  });

  it('a readiness I/O fault rethrows rather than settling', async () => {
    h.readiness.mockRejectedValue(new Error('pool timeout'));
    await expect(advanceIdentityEffects(args('effects', cp({ resumeStepKey: 'manual_work' })))).rejects.toThrow('pool timeout');
    expect(h.settle).not.toHaveBeenCalled();
  });
});

describe('advanceVerifyOutcome (spec §6.6)', () => {
  const plan = (over: Record<string, unknown> = {}) => cp({ resumeStepKey: 'document' }, over);
  beforeEach(() => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: SNAPSHOT_FACTS });
    h.selectQueue = [TARGETS, ACCOUNTS];
    // A clean re-read: nothing left.
    h.discoverIdentityFacts.mockResolvedValue({
      ...FACTS,
      google: { ...FACTS.google, groups: [], suspended: true },
      m365: { ...FACTS.m365, accountEnabled: false },
    });
  });
  const verdict = () => (h.settleStepAndMove.mock.calls[0]![0].checkpoint as IdentityOffboardingCheckpoint).lastVerification!;
  const DISPATCHED = new Date('2026-10-20T09:00:00.000Z');
  /** The walk's operation rows for this checkpoint's plan (all dispatched + verified unless overridden). */
  async function walkRows(c: IdentityOffboardingCheckpoint, rec: RecipeDefinition<never> = recipe,
    over: (toolName: string) => Record<string, unknown> | null = () => ({})) {
    const { planEffectOperationKey } = await import('./planApproval');
    return rec.buildPlan(c.recipeInput as never, SNAPSHOT_FACTS).flatMap((e) => {
      const o = over(e.toolName);
      if (o === null) return [];
      return [{
        operationKey: planEffectOperationKey({ stepKey: 'effects', planRevision: 1, toolName: e.toolName, targetId: e.targetId, ordinal: e.ordinal }),
        dispatchedAt: DISPATCHED, result: { verified: { ok: true } }, ...o,
      }];
    });
  }
  async function verifyWith(c: IdentityOffboardingCheckpoint, rec: RecipeDefinition<never> = recipe,
    over?: (toolName: string) => Record<string, unknown> | null) {
    h.selectQueue = [await walkRows(c, rec, over), TARGETS, ACCOUNTS];
    return advanceVerifyOutcome({ ...args('verify_outcome', c), recipe: rec });
  }

  it('8. an OBSERVABLE effect that probed unknown is a failed verification (partial)', async () => {
    h.probeEffect.mockImplementation(async (e: { toolName: string }) => ({ state: e.toolName === 'm365_disable_user' ? 'unknown' : 'satisfied', detail: 'd', observedAt: NOW }));
    await verifyWith(plan());
    expect(verdict().result).toBe('failed');
    expect(verdict().detail).toContain('m365_disable_user');
  });

  it('9. verified when the only unknown is google_signout AND the suspend is satisfied on the same account', async () => {
    h.probeEffect.mockImplementation(async (e: { toolName: string }) => ({ state: e.toolName === 'google_signout' ? 'unknown' : 'satisfied', detail: 'd', observedAt: NOW }));
    await verifyWith(plan());
    expect(verdict().result).toBe('passed');
    expect(h.settleStepAndMove).toHaveBeenCalledWith(expect.objectContaining({ toStepKey: 'document' }));
  });

  it('10. NOT verified when the suspend is absent from the plan', async () => {
    h.probeEffect.mockImplementation(async (e: { toolName: string }) => ({ state: e.toolName === 'google_signout' ? 'unknown' : 'satisfied', detail: 'd', observedAt: NOW }));
    await verifyWith(plan({ effects: { disableAccount: false } }));
    expect(verdict().result).toBe('failed');
    expect(verdict().detail).toContain('google_signout');
  });

  it('10. NOT verified when the suspend acts on a DIFFERENT account', async () => {
    h.probeEffect.mockImplementation(async (e: { toolName: string }) => ({ state: e.toolName === 'google_signout' || e.toolName === 'google_suspend_user' ? 'unknown' : 'satisfied', detail: 'd', observedAt: NOW }));
    await verifyWith(plan());
    expect(verdict().result).toBe('failed');
  });

  it('10. NOT verified when the satisfied suspend is on a different account than the sign-out', async () => {
    h.probeEffect.mockImplementation(async (e: { toolName: string }) => ({ state: e.toolName === 'google_signout' ? 'unknown' : 'satisfied', detail: 'd', observedAt: NOW }));
    const effect = (ordinal: number, toolName: string, accountExternalId: string) => ({
      ordinal, toolName, provider: 'google' as const, targetId: CONTACT_TARGET, accountExternalId, canonicalArguments: { reason: 'r' },
    });
    const split = { ...recipe, buildPlan: () => [effect(0, 'google_signout', '101'), effect(1, 'google_suspend_user', '202')] } as never;
    await verifyWith(plan(), split);
    expect(verdict().result).toBe('failed');
    expect(verdict().detail).toContain('google_signout');
  });

  it('world drift: a group added after discovery surfaces as a leftover', async () => {
    h.probeEffect.mockResolvedValue({ state: 'satisfied', detail: 'd', observedAt: NOW });
    h.discoverIdentityFacts.mockResolvedValue({
      ...FACTS, google: { ...FACTS.google, suspended: true, groups: [{ id: 'g9', name: 'Added Wednesday', email: 'w@x', ownership: 'none', dynamic: false, roleAssignable: false }] },
      m365: { ...FACTS.m365, accountEnabled: false },
    });
    await verifyWith(plan());
    expect(verdict().result).toBe('failed');
    expect(verdict().detail).toContain('Added Wednesday');
  });
  it('probes each effect against WHEN THE WALK DISPATCHED IT, not verify time (a revoke must not look undone)', async () => {
    h.probeEffect.mockResolvedValue({ state: 'satisfied', detail: 'd', observedAt: NOW });
    await verifyWith(plan());
    expect(h.probeEffect.mock.calls.length).toBeGreaterThan(0);
    for (const call of h.probeEffect.mock.calls) expect(call[1].effectRequestedAt).toEqual(DISPATCHED);
    expect(verdict().result).toBe('passed');
  });

  it('a mail setting unreadable after the suspend stands on the WALK\'s verification when that suspend is observed', async () => {
    h.probeEffect.mockImplementation(async (e: { toolName: string }) => ({
      state: e.toolName === 'google_set_vacation' || e.toolName === 'google_signout' ? 'unknown' : 'satisfied', detail: 'd', observedAt: NOW,
    }));
    await verifyWith(plan());
    expect(verdict().result).toBe('passed');
  });

  it('…but NOT when the walk did not verify it, or the suspend is not observed', async () => {
    h.probeEffect.mockImplementation(async (e: { toolName: string }) => ({
      state: e.toolName === 'google_set_vacation' || e.toolName === 'google_signout' ? 'unknown' : 'satisfied', detail: 'd', observedAt: NOW,
    }));
    await verifyWith(plan(), recipe, (t) => (t === 'google_set_vacation' ? { result: { verified: { ok: false } } } : {}));
    expect(verdict().result).toBe('failed');
    expect(verdict().detail).toContain('google_set_vacation');
    vi.clearAllMocks();
    h.probeEffect.mockImplementation(async (e: { toolName: string }) => ({
      state: ['google_set_vacation', 'google_signout', 'google_suspend_user'].includes(e.toolName) ? 'unknown' : 'satisfied', detail: 'd', observedAt: NOW,
    }));
    await verifyWith(plan());
    expect(verdict().result).toBe('failed');
    expect(verdict().detail).toContain('google_set_vacation');
  });

  it('a mail setting the walk found ALREADY in place (no-op) also stands once the suspend is observed', async () => {
    h.probeEffect.mockImplementation(async (e: { toolName: string }) => ({
      state: e.toolName === 'google_set_vacation' || e.toolName === 'google_signout' ? 'unknown' : 'satisfied', detail: 'd', observedAt: NOW,
    }));
    await verifyWith(plan(), recipe, (t) => (t === 'google_set_vacation' ? { result: { noop: true } } : {}));
    expect(verdict().result).toBe('passed');
  });

  it('a re-check that could not list everything (truncated) is not a pass', async () => {
    h.probeEffect.mockResolvedValue({ state: 'satisfied', detail: 'd', observedAt: NOW });
    h.discoverIdentityFacts.mockResolvedValue({
      ...FACTS, google: { ...FACTS.google, groups: [], suspended: true }, m365: { ...FACTS.m365, accountEnabled: false },
      truncated: ['m365.groups'],
    });
    await verifyWith(plan());
    expect(verdict().result).toBe('failed');
    expect(verdict().detail).toContain('m365.groups');
  });

  it('a planned effect with NO operation row never ran: unconfirmed, and it is not probed', async () => {
    h.probeEffect.mockResolvedValue({ state: 'satisfied', detail: 'd', observedAt: NOW });
    await verifyWith(plan(), recipe, (t) => (t === 'm365_disable_user' ? null : {}));
    expect(verdict().result).toBe('failed');
    expect(verdict().detail).toContain('m365_disable_user (not dispatched)');
    expect(h.probeEffect.mock.calls.map((c) => c[0].toolName)).not.toContain('m365_disable_user');
  });

  it('an admission lookup problem keeps the verdict from passing — Breeze never checked that provider', async () => {
    h.probeEffect.mockResolvedValue({ state: 'satisfied', detail: 'd', observedAt: NOW });
    await verifyWith(cp({ resumeStepKey: 'document', admissionProblems: ['m365 lookup failed (executor_unavailable)'] }));
    expect(verdict().result).toBe('failed');
    expect(verdict().detail).toContain('not checked by Breeze: m365 lookup failed (executor_unavailable)');
  });
});

describe('residualAfterOffboarding', () => {
  it('respects the toggles and keepMailbox', () => {
    const input = cp({}, { keepMailbox: true }).recipeInput as never;
    const fresh = { ...FACTS, m365: { ...FACTS.m365, licenses: [{ productId: null, skuId: 's', name: 'E3' }] } } as never;
    expect(residualAfterOffboarding(input, fresh).join(' ')).not.toContain('Microsoft 365 licence');
  });
});

describe('advanceManualWork', () => {
  beforeEach(() => {
    h.loadPlanningFacts.mockResolvedValue({ ok: true, facts: SNAPSHOT_FACTS });
  });
  const mwCp = () => cp({ resumeStepKey: 'verify_outcome' });
  const row = (index: number, over: Record<string, unknown> = {}) => ({
    index, stepId: `s${index}`, stepState: 'waiting', checklistItemId: `i${index}`, itemLabel: 'x',
    itemDoneAt: null, itemDoneByUserId: null, ...over,
  });

  it('a DETACHED item (ticket moved / item deleted) hands off — it is never re-created on a new ticket', async () => {
    h.selectQueue = [[]]; // review step checkpoint
    h.readManualWork.mockResolvedValue([row(0), row(1, { checklistItemId: null, itemLabel: null })]);
    await advanceManualWork(args('manual_work', mwCp()));
    expect(h.ensureManualWorkItems).not.toHaveBeenCalled();
    expect(h.settle).toHaveBeenCalledWith(expect.objectContaining({ event: 'hand_off', detail: expect.stringContaining('no longer reachable') }));
  });

  it('the coordinator-opened first row (running, not yet linked) is NOT taken for a detached item', async () => {
    h.selectQueue = [[], [{ id: CONTACT_TARGET }]];
    h.readManualWork.mockResolvedValue([row(0, { stepState: 'running', checklistItemId: null, itemLabel: null })]);
    h.ensureManualWorkItems.mockImplementation(async (_db: unknown, _t: unknown, items: unknown[]) => ({
      ticketId: 't', itemIds: items.map((_, i) => `i${i}`), created: items.length,
    }));
    await advanceManualWork(args('manual_work', mwCp()));
    expect(h.ensureManualWorkItems).toHaveBeenCalledTimes(1);
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('a merged-tombstone refusal (#8972 W1) is rethrown for the coordinator retry, never settled', async () => {
    // The merge re-pointed the task's ticket target to the survivor, so the
    // retry's fresh read lands there; settling would fail the task for a race.
    h.selectQueue = [[], [{ id: CONTACT_TARGET }]];
    h.readManualWork.mockResolvedValue([row(0, { stepState: 'running', checklistItemId: null, itemLabel: null })]);
    h.ensureManualWorkItems.mockRejectedValue(new TicketMergedError('t', 'survivor-1'));
    await expect(advanceManualWork(args('manual_work', mwCp()))).rejects.toBeInstanceOf(TicketMergedError);
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('an item already completed and settled whose link was later removed is NOT re-created', async () => {
    h.selectQueue = [[], [{ id: CONTACT_TARGET }]];
    const items = (await import('./recipes/identityOffboarding')).buildIdentityOffboardingManualWork(
      mwCp().recipeInput as never, SNAPSHOT_FACTS, {}, [],
    );
    h.readManualWork.mockResolvedValue(items.map((_, i) => row(i, i === 0
      ? { stepState: 'succeeded', checklistItemId: null, itemLabel: null, itemDoneAt: NOW }
      : { stepState: 'succeeded', itemDoneAt: NOW })));
    await advanceManualWork(args('manual_work', mwCp()));
    expect(h.ensureManualWorkItems).not.toHaveBeenCalled();
  });

  it('more review items than the checklist bound are folded into one, never a throw', async () => {
    const flags = Array.from({ length: 40 }, (_, i) => ({ code: 'sole_group_owner', subject: `Group ${i}`, detail: 'd' }));
    const exceptions = Array.from({ length: 20 }, (_, i) => ({ toolName: 'google_suspend_user', classification: 'human_work', detail: `e${i}` }));
    h.selectQueue = [[{ checkpoint: { reviewOutput: { flags, exceptions, summary: 's' } } }], [{ id: CONTACT_TARGET }]];
    h.readManualWork.mockResolvedValue([]);
    h.ensureManualWorkItems.mockImplementation(async (_db: unknown, _t: unknown, items: unknown[]) => ({
      ticketId: 't', itemIds: items.map((_, i) => `i${i}`), created: items.length,
    }));
    await advanceManualWork(args('manual_work', mwCp()));
    const items = h.ensureManualWorkItems.mock.calls[0]![2] as Array<{ key: string; detail: string }>;
    expect(items).toHaveLength(64);
    expect(items[63]!.key).toBe('overflow');
    // Two exceptions about the SAME tool are two entries, not one deduplicated away.
    const all = items.map((i) => i.key).join(' ') + items[63]!.detail;
    expect(all).toContain('google_suspend_user (1)');
    expect(all).toContain('google_suspend_user (20)');
  });
});
