/**
 * `identity_onboarding`'s coordinator advancers (Recipe Library spec §6.3;
 * W07 R2a Task 12, Amendment B1, B2, B7, B.9 item 12). The coordinator
 * consults `RECIPE_ADVANCERS[key]` before its `KIND_ADVANCERS` fallback; this
 * table is that entry, and it names all twelve steps.
 *
 *   intake                advanceOnboardingIntake           reason      bounded run; candidate ids validated in-org
 *   confirm_details       advanceConfirmDetails             human_work  opens the item NAMING the hire + accounts, then E3's advanceHumanWork
 *   discover              advanceOnboardingDiscover         probe       collision/seat/model-after reads + readiness; seals snapshot 1
 *   review                advanceOnboardingReview           reason      bounded run over the CREATE plan; writes createPlanRevision + resumeStepKey
 *   create_accounts       advanceOnboardingCreateEffects    effect      stage check + live-readiness veto, then E4's advanceEffect at r
 *   manual_create_google  advanceManualCreateGoogle         human_work  arms resolve_accounts, opens the item, then E3's advanceHumanWork
 *   resolve_accounts      advanceResolveAccounts            probe       reads back OWN creations; ONE transaction bumps r→r+1, writes snapshot 2, moves
 *   provision_effects     advanceOnboardingProvisionEffects effect      stage check + live-readiness veto, then E4's advanceEffect at r+1
 *   wait_start            advanceWaitStart                  wait        arms waitUntil = startAt + manual_work, then E3's advanceWait
 *   manual_work           advanceOnboardingManualWork       human_work  R1's cursor pattern on `onboardingWorkCursor`
 *   verify_outcome        advanceOnboardingVerifyOutcome    probe       D-R2-11's conjunction; an unverifiable creation is partial
 *   document              advanceOnboardingDocument         document    completion record, then the terminal settle
 *
 * THE TRANSITION RULE (D-R1-2, B.0 item 8). An advancer that moves the task
 * into step S writes S's successor (`resolveDeterministicNextStep`) as
 * `checkpoint.resumeStepKey`. A GENERIC move out of an effect step keeps the
 * checkpoint unchanged, so every step such a move can enter
 * (`manual_create_google`, `resolve_accounts`, `wait_start`, `manual_work`)
 * is a recipe advancer that arms its own successor on entry. An unresolvable
 * `next` settles fail/unresolved and is never guessed.
 *
 * THROW VS SETTLE (R1's rule). Every refusal SETTLES (or returns a lost-lease
 * result). A transient I/O fault THROWS, so the wake retries. The one typed
 * throw this module raises on purpose is `OnboardingStageTransitionAbort`
 * inside `resolve_accounts`' leased callback — that is how the transaction
 * rolls back — and it is caught outside it.
 *
 * AFTER STAGE 1 NOTHING FAILS SILENTLY INTO `fail` (B2). A snapshot or plan
 * fault is classified on trusted context (recipe data + the current step): a
 * step planning from stage 1's snapshot fails only while no approval exists
 * at the task's revision; anything later hands off, because an account may
 * already exist.
 *
 * DISPATCH-TIME DEGRADATION IS NOT BUILT (quorum Q3). An executor refusal
 * (`license_unavailable`, `unsupported_group_type`) arrives as a failed
 * operation and E4's walk hands off naming the remaining effects; the effect
 * wrappers add no branch for it.
 *
 * SECRETS. The created account's temporary credential lives only in the
 * create intent's sealed result. Nothing here selects an operation's
 * `result`, and nothing here writes a credential into a checkpoint, an event
 * or a step row (`credentialHandover.secrets.contract.test.ts`).
 *
 * LEASE SAFETY + TENANCY: as `identityAdvancers.ts` — every task write is a
 * lease CAS (`COORDINATOR_STEP_OPS` or R1's `leasedWrite`), and every read
 * runs in system scope with an explicit `org_id` predicate.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  identityOnboardingCheckpointSchema,
  isIdentityOnboardingCheckpoint,
  type IdentityOnboardingCheckpoint,
  type IdentityOnboardingInput,
  type IdentityOnboardingReviewOutput,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiOperatorOperations, aiOperatorTasks, type AiOperatorTaskOutcome } from '../../db/schema/aiOperatorTasks';
import { aiOperatorPlanApprovals } from '../../db/schema/aiOperatorPlanApprovals';
import { aiOperatorTaskSteps, aiOperatorTaskTargets } from '../../db/schema/aiOperatorTaskGraph';
import { contacts } from '../../db/schema/contacts';
import type { StepAdvancer } from './taskCoordinator';
import { leasedWrite, type StepAdvancerArgs } from './identityAdvancers';
import type { DiscoveryFacts, PlannedEffect, RecipeDefinition } from './recipes/types';
import { IDENTITY_ONBOARDING_EFFECT_TOOLS } from './recipes/identityOnboarding';
import { nextTaskState } from './taskTransitions';

const COORDINATOR = { kind: 'coordinator' } as const;
const RUN_POLL_MS = 10 * 60 * 1000;
const HUMAN_WORK_REMIND_AFTER_MS = 24 * 60 * 60 * 1000;
const FINDING_MAX_CHARS = 500;
const LABEL_MAX_CHARS = 500;
const DETAIL_MAX_CHARS = 2000;

/**
 * Everything this module calls, loaded LAZILY — the coordinator imports this
 * table at load (a static import back is a load-time cycle), and keeping the
 * service graph out of the coordinator's load-time imports keeps every suite
 * that mocks those modules loading what it loaded before.
 */
async function ops() {
  const [
    nextStep, coordinator, recipes, onboarding, planning, approval, probes, provisioning, accounts,
    discovery, readiness, context, manual, record, humanWork, steps, events, googleTools, googleClient,
  ] = await Promise.all([
    import('./recipes/resolveNextStep'), import('./taskCoordinator'), import('./recipes'), import('./recipes/identityOnboarding'),
    import('./planningSnapshot'), import('./planApproval'), import('./effectProbes'), import('./identityProvisioning'),
    import('./onboardingAccounts'), import('./identityDiscovery'), import('./recipeReadiness'), import('./taskContextOnboarding'),
    import('./manualWork'), import('./completionRecord'), import('./humanWorkService'), import('./stepService'),
    import('./eventService'), import('../aiToolsGoogle'), import('../googleClient'),
  ]);
  return {
    resolveDeterministicNextStep: nextStep.resolveDeterministicNextStep,
    ...coordinator.COORDINATOR_STEP_OPS,
    advanceEffect: coordinator.advanceEffect,
    advanceHumanWork: coordinator.advanceHumanWork,
    advanceWait: coordinator.advanceWait,
    validateRecipeNextStep: recipes.validateRecipeNextStep,
    parseIdentityOnboardingFacts: onboarding.parseIdentityOnboardingFacts,
    buildIdentityOnboardingCreatePlan: onboarding.buildIdentityOnboardingCreatePlan,
    buildIdentityOnboardingProvisionPlan: onboarding.buildIdentityOnboardingProvisionPlan,
    buildIdentityOnboardingManualWork: onboarding.buildIdentityOnboardingManualWork,
    buildManualCreateGoogleItem: onboarding.buildManualCreateGoogleItem,
    capOnboardingManualWork: onboarding.capOnboardingManualWork,
    loadPlanningFacts: planning.loadPlanningFacts,
    sealPlanningSnapshot: planning.sealPlanningSnapshot,
    planEffectOperationKey: approval.planEffectOperationKey,
    probeEffect: probes.probeEffect,
    discoverOnboardingFacts: provisioning.discoverOnboardingFacts,
    resolveCreatedAccounts: accounts.resolveCreatedAccounts,
    commitOnboardingStageTransition: accounts.commitOnboardingStageTransition,
    OnboardingStageTransitionAbort: accounts.OnboardingStageTransitionAbort,
    isExpectedAbsentReason: accounts.isExpectedAbsentReason,
    m365Read: discovery.m365Read,
    M365ReadFailed: discovery.M365ReadFailed,
    rethrowIfTransientM365: discovery.rethrowIfTransientM365,
    inOrgContext: discovery.inOrgContext,
    isTransientGoogle: discovery.isTransientGoogle,
    DiscoveryTransientError: discovery.DiscoveryTransientError,
    errorMessage: discovery.errorMessage,
    computeRecipeReadinessSystem: readiness.computeRecipeReadinessSystem,
    validateOnboardingConfirmOutput: context.validateOnboardingConfirmOutput,
    validateOnboardingReviewOutput: context.validateOnboardingReviewOutput,
    ensureManualWorkItems: manual.ensureManualWorkItems,
    nextOpenManualItem: manual.nextOpenManualItem,
    readManualWork: manual.readManualWork,
    CompletionRecordNoTicketError: record.CompletionRecordNoTicketError,
    buildCompletionRecord: record.buildCompletionRecord,
    postCompletionRecord: record.postCompletionRecord,
    HUMAN_WORK_POLL_WAKE_MS: humanWork.HUMAN_WORK_POLL_WAKE_MS,
    ensureTaskTicket: humanWork.ensureTaskTicket,
    openHumanWorkStep: humanWork.openHumanWorkStep,
    readHumanWorkStep: humanWork.readHumanWorkStep,
    openStep: steps.openStep,
    resolveStepKind: steps.resolveStepKind,
    settleStep: steps.settleStep,
    appendTaskEvent: events.appendTaskEvent,
    resolveContextByOrg: googleTools.resolveContextByOrg,
    getDirectoryClient: googleClient.getDirectoryClient,
    normalizeGoogleError: googleClient.normalizeGoogleError,
  };
}

type Ops = Awaited<ReturnType<typeof ops>>;
type Cp = IdentityOnboardingCheckpoint;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

async function fail(o: Ops, a: StepAdvancerArgs, detail: string, checkpoint?: Cp): Promise<string> {
  await o.settle({ task: a.task, leaseEpoch: a.leaseEpoch, event: 'fail', outcome: 'unresolved', detail, ...(checkpoint ? { checkpoint } : {}) });
  return `failed: ${detail}`;
}

async function handOff(
  o: Ops, a: StepAdvancerArgs, detail: string, handoffSummary: string, checkpoint?: Cp,
  outcome: Extract<AiOperatorTaskOutcome, 'unresolved' | 'unknown_effect'> = 'unresolved',
): Promise<string> {
  await o.settle({
    task: a.task, leaseEpoch: a.leaseEpoch, event: 'hand_off', outcome, detail, handoffSummary,
    ...(checkpoint ? { checkpoint } : {}),
  });
  return `handed off: ${detail}`;
}

/** Narrow once; a miss cannot happen for an admitted task, but it is never a cast. */
async function onboardingCheckpoint(o: Ops, a: StepAdvancerArgs): Promise<Cp | null> {
  if (isIdentityOnboardingCheckpoint(a.checkpoint)) return a.checkpoint;
  await fail(o, a, `identity_onboarding step '${a.task.currentStepKey}' reached without an onboarding checkpoint`);
  return null;
}

function nextCheckpoint(cp: Cp, patch: Partial<Cp>): Cp {
  return identityOnboardingCheckpointSchema.parse({ ...cp, ...patch });
}

function inputOf(cp: Cp): IdentityOnboardingInput {
  return cp.recipeInput;
}

/** The successor of `stepKey`, or a detail the caller settles fail with. */
function successorOf(
  o: Ops, recipe: RecipeDefinition<never>, stepKey: string, cp: Cp, facts: DiscoveryFacts = {},
): { ok: true; key: string } | { ok: false; detail: string } {
  const r = o.resolveDeterministicNextStep(recipe, stepKey, { input: cp.recipeInput, facts, readiness: {} });
  return r.ok ? r : { ok: false, detail: `next step after '${stepKey}' could not be resolved: ${r.detail}` };
}

/** The new hire's contact target (admission creates it at ordinal 0). */
async function readContactTarget(orgId: string, taskId: string): Promise<{ id: string; label: string; contactId: string | null } | null> {
  const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ id: aiOperatorTaskTargets.id, label: aiOperatorTaskTargets.targetLabel, contactId: aiOperatorTaskTargets.contactId })
    .from(aiOperatorTaskTargets)
    .where(and(eq(aiOperatorTaskTargets.orgId, orgId), eq(aiOperatorTaskTargets.taskId, taskId), eq(aiOperatorTaskTargets.targetKind, 'contact')))
    .orderBy(asc(aiOperatorTaskTargets.targetOrdinal))
    .limit(1)));
  return row ?? null;
}

/** Inside a leased transaction: the ordinal-0 target the coordinator keys step rows by. */
async function ordinalZeroTargetId(orgId: string, taskId: string): Promise<string | null> {
  const [t] = await db.select({ id: aiOperatorTaskTargets.id }).from(aiOperatorTaskTargets)
    .where(and(eq(aiOperatorTaskTargets.orgId, orgId), eq(aiOperatorTaskTargets.taskId, taskId), eq(aiOperatorTaskTargets.targetOrdinal, 0)))
    .limit(1);
  return t?.id ?? null;
}

/**
 * Settle the current step, open `toStepKey`, write the task row — and run
 * `extra` step-row writes — in ONE lease-CAS transaction (R1's shape). The
 * successor is opened at the task's CURRENT revision; `resolve_accounts`
 * does not use this, because it opens `provision_effects` at r+1.
 */
async function moveWithStepData(args: {
  o: Ops; a: StepAdvancerArgs; toStepKey: string; checkpoint: Cp;
  settledDetail: string; extra?: (targetId: string | null) => Promise<void>;
}): Promise<boolean> {
  const { o, a, toStepKey, checkpoint } = args;
  const { task, leaseEpoch, recipe } = a;
  return leasedWrite({
    orgId: task.orgId, taskId: task.id, revision: task.revision, leaseEpoch,
    patch: {
      currentStepKey: toStepKey,
      phase: recipe.steps[toStepKey]?.phase ?? 'investigate',
      checkpoint: checkpoint as unknown as Record<string, unknown>,
      waitReason: null, waitDependencyKind: null, waitDependencyId: null,
      nextWakeAt: new Date(), leaseOwner: null, leaseExpiresAt: new Date(Date.now() - 1),
    },
    alsoInTransaction: async () => {
      const targetId = await ordinalZeroTargetId(task.orgId, task.id);
      if (args.extra) await args.extra(targetId);
      if (task.currentStepKey) {
        await o.settleStep(db, {
          orgId: task.orgId, taskId: task.id, stepKey: task.currentStepKey, targetId,
          attemptOrdinal: task.attemptOrdinal, state: 'succeeded', detail: args.settledDetail, actor: COORDINATOR,
        });
      }
      await o.openStep(db, {
        orgId: task.orgId, taskId: task.id, stepKey: toStepKey,
        stepKind: o.resolveStepKind(task.workflowKey, task.workflowVersion, toStepKey),
        targetId, attemptOrdinal: task.attemptOrdinal, planRevision: task.revision,
        checkpoint: checkpoint as unknown as Record<string, unknown>, actor: COORDINATOR,
      });
    },
  });
}

/** The step row of `stepKey` at the task's attempt, opened if absent (idempotent upsert); its id. */
async function stepRowId(o: Ops, a: StepAdvancerArgs, stepKey: string, targetId: string | null): Promise<string> {
  const row = await o.openStep(db, {
    orgId: a.task.orgId, taskId: a.task.id, stepKey,
    stepKind: o.resolveStepKind(a.task.workflowKey, a.task.workflowVersion, stepKey),
    targetId, attemptOrdinal: a.task.attemptOrdinal, planRevision: a.task.revision,
  });
  return row.id;
}

async function readStepCheckpoint(orgId: string, taskId: string, stepKey: string): Promise<Record<string, unknown> | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [row] = await db.select({ checkpoint: aiOperatorTaskSteps.checkpoint }).from(aiOperatorTaskSteps)
      .where(and(eq(aiOperatorTaskSteps.orgId, orgId), eq(aiOperatorTaskSteps.taskId, taskId), eq(aiOperatorTaskSteps.stepKey, stepKey)))
      .orderBy(desc(aiOperatorTaskSteps.createdAt))
      .limit(1);
    return (row?.checkpoint as Record<string, unknown> | null) ?? null;
  }));
}

function mergeRunFindings(cp: Cp, outcome: unknown): Cp['findings'] {
  const submitted = (outcome as { taskStep?: { findings?: Cp['findings'] } } | null)?.taskStep?.findings ?? [];
  return [...cp.findings, ...submitted].slice(-50);
}

/** R1's reason-step shape: admit a bounded run, wait, then hand back its validated proposal — or settle. */
async function reasonStep(
  o: Ops, a: StepAdvancerArgs, cp: Cp, stepKey: 'intake' | 'review',
): Promise<{ done: true; result: string } | { done: false; inputs: Record<string, unknown>; findings: Cp['findings'] }> {
  const run = await o.readLatestTaskRun(a.task.orgId, a.task.id, stepKey);
  if (!run) {
    const admitted = await o.admitReasoningRun({
      task: a.task, leaseEpoch: a.leaseEpoch, checkpoint: cp, stepKey, bumpPlanRevision: false, recipe: a.recipe,
    });
    if (admitted.admitted) return { done: true, result: admitted.detail };
    return { done: true, result: await handOff(o, a, admitted.detail, `Operator could not start the ${stepKey} step: ${admitted.detail}`) };
  }
  if (run.status === 'queued' || run.status === 'running') {
    await o.yieldToWait({ task: a.task, leaseEpoch: a.leaseEpoch, reason: 'information', dependency: { kind: 'run', id: run.id }, wakeAfterMs: RUN_POLL_MS });
    return { done: true, result: `waiting: ${stepKey} run in flight` };
  }
  const findings = mergeRunFindings(cp, run.outcome);
  if (run.status === 'awaiting_approval') {
    return { done: true, result: await handOff(o, a, `${stepKey} run proposed an action; this step may not act`,
      'The Operator tried to take an action during a reasoning step, which this workflow does not allow. Nothing was changed.') };
  }
  const proposal = run.outcome?.taskStep;
  if (!proposal) {
    return { done: true, result: await handOff(o, a, `run ${run.id} ended '${run.status}' without submitting a task step`,
      `The Operator finished the ${stepKey} step without an answer. Review the linked run.`) };
  }
  if (proposal.nextStep.kind !== 'step') {
    const detail = proposal.nextStep.kind === 'handoff' ? proposal.nextStep.reason : `the model asked a question: ${proposal.nextStep.text}`;
    const summary = proposal.nextStep.kind === 'handoff' ? proposal.nextStep.summary : proposal.nextStep.text;
    return { done: true, result: await handOff(o, a, detail.slice(0, 500), summary.slice(0, 2000)) };
  }
  const validated = o.validateRecipeNextStep(
    a.recipe, stepKey, { key: proposal.nextStep.key, inputs: proposal.nextStep.inputs }, cp.recipeInput as never,
  );
  if (!validated.ok) return { done: true, result: await fail(o, a, `${stepKey} output refused (${validated.reason}): ${validated.detail}`) };
  return { done: false, inputs: validated.inputs, findings };
}

// ---------------------------------------------------------------------------
// B2's build-failure classification, applied where this module loads facts
// itself. Keyed on TRUSTED context: the recipe's map and the current step.
// ---------------------------------------------------------------------------

async function approvalExistsAtRevision(a: StepAdvancerArgs): Promise<boolean> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ id: aiOperatorPlanApprovals.id })
    .from(aiOperatorPlanApprovals)
    .where(and(
      eq(aiOperatorPlanApprovals.orgId, a.task.orgId),
      eq(aiOperatorPlanApprovals.taskId, a.task.id),
      eq(aiOperatorPlanApprovals.planRevision, a.task.revision),
    ))
    .limit(1)));
  return rows.length > 0;
}

/** Any operation of the task — any step, any revision — still `pending` or `unknown` (may still land). */
async function anyUnsettledOperation(a: StepAdvancerArgs): Promise<boolean> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ id: aiOperatorOperations.id })
    .from(aiOperatorOperations)
    .where(and(
      eq(aiOperatorOperations.orgId, a.task.orgId),
      eq(aiOperatorOperations.taskId, a.task.id),
      inArray(aiOperatorOperations.resultState, ['pending', 'unknown']),
    ))
    .limit(1)));
  return rows.length > 0;
}

/** True iff the current step plans from stage 1's snapshot (`planningSnapshotStepKey`). */
function plansFromFirstStage(a: StepAdvancerArgs): boolean {
  const map = a.recipe.planningSnapshotStepFor;
  const stepKey = a.task.currentStepKey;
  if (map === undefined || stepKey === null || !Object.hasOwn(map, stepKey)) return false;
  return map[stepKey] === a.recipe.planningSnapshotStepKey;
}

/** Hand off after stage 1 (an account may exist); `unknown_effect` while any operation may still land. */
async function handOffAfterStageOne(o: Ops, a: StepAdvancerArgs, detail: string, cp: Cp): Promise<string> {
  const unsettled = await anyUnsettledOperation(a);
  return handOff(o, a, detail,
    `Breeze could not continue this onboarding (${detail}). An earlier step may already have created an account or `
    + 'granted access. Nothing further was changed. '
    + `${unsettled ? 'An earlier step may still be running; check the provider before retrying. ' : ''}`
    + 'Review what was already done and complete the rest by hand.',
    cp, unsettled ? 'unknown_effect' : 'unresolved');
}

/**
 * B2's classification: a step planning from stage 1 with NO approval at the
 * task's revision has changed nothing → `fail`. Anything else hands off.
 */
async function settlePlanningFailure(o: Ops, a: StepAdvancerArgs, detail: string, cp: Cp): Promise<string> {
  if (plansFromFirstStage(a) && !(await approvalExistsAtRevision(a))) return fail(o, a, detail, cp);
  return handOffAfterStageOne(o, a, detail, cp);
}

/** The current step's verified facts, or a settled refusal. */
async function loadFacts(
  o: Ops, a: StepAdvancerArgs, cp: Cp, stepKey: string,
): Promise<{ ok: true; facts: DiscoveryFacts } | { ok: false; result: string }> {
  const loaded = await o.loadPlanningFacts(a.task, a.recipe, cp, stepKey);
  if (loaded.ok) return { ok: true, facts: loaded.facts };
  return { ok: false, result: await settlePlanningFailure(o, a, `planning snapshot ${loaded.reason}: ${loaded.detail}`, cp) };
}

// ---------------------------------------------------------------------------
// intake → confirm_details → discover → review
// ---------------------------------------------------------------------------

export async function advanceOnboardingIntake(a: StepAdvancerArgs): Promise<string> {
  const o = await ops();
  const cp = await onboardingCheckpoint(o, a);
  if (!cp) return 'failed: checkpoint arm mismatch';
  const reasoned = await reasonStep(o, a, cp, 'intake');
  if (reasoned.done) return reasoned.result;

  const contact = await readContactTarget(a.task.orgId, a.task.id);
  if (!contact?.contactId) return fail(o, a, 'the task has no live contact target for the new hire');
  const idsOf = (key: string): string[] => (Array.isArray(reasoned.inputs[key])
    ? (reasoned.inputs[key] as unknown[]).filter((x): x is string => typeof x === 'string') : []);
  const proposed = [...new Set([...idsOf('managerCandidateContactIds'), ...idsOf('modelAfterCandidateContactIds')])];
  // ONE org-scoped existence read over BOTH lists; the validator checks against it.
  const inOrg = proposed.length === 0 ? [] : await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ id: contacts.id, name: contacts.name }).from(contacts)
    .where(and(eq(contacts.orgId, a.task.orgId), inArray(contacts.id, proposed)))
    .limit(10)));
  const intake = o.validateOnboardingConfirmOutput(reasoned.inputs, new Set(inOrg.map((r) => r.id)));
  if (!intake.ok) return fail(o, a, `intake output refused (${intake.reason}): ${intake.detail}`);

  const next = successorOf(o, a.recipe, 'confirm_details', cp);
  if (!next.ok) return fail(o, a, next.detail);
  const names = new Map(inOrg.map((r) => [r.id, r.name ?? r.id]));
  const list = (ids: string[]): string => (ids.length === 0 ? 'none' : ids.map((id) => names.get(id) ?? id).join(', '));
  const input = inputOf(cp);
  const manager = input.managerContactId === null ? ''
    : `; the requested manager ${intake.managerCandidateContactIds.includes(input.managerContactId) ? 'is' : 'is NOT'} among them`;
  const note = `intake proposed manager candidate(s): ${list(intake.managerCandidateContactIds)}; `
    + `model-after candidate(s): ${list(intake.modelAfterCandidateContactIds)}${manager}`
    + `${reasoned.inputs.ambiguous === true ? '; the Operator marked the match ambiguous' : ''}`;
  const rationale = typeof reasoned.inputs.rationale === 'string' ? reasoned.inputs.rationale : '';
  const checkpoint = nextCheckpoint(cp, {
    findings: [...reasoned.findings, {
      text: clip(note, FINDING_MAX_CHARS), sourceKind: 'other' as const, sourceId: 'intake', observedAt: a.now.toISOString(),
    }].slice(-50),
    resumeStepKey: next.key,
  });
  // The model's rationale is recorded on the step_settled EVENT only; it
  // never reaches a decision, a checklist item or the checkpoint.
  const committed = await moveWithStepData({
    o, a, toStepKey: 'confirm_details', checkpoint,
    settledDetail: clip(`${note}. Operator rationale: ${rationale}`, DETAIL_MAX_CHARS),
  });
  if (!committed) return 'lost lease: intake not recorded';
  return 'advanced: intake done, confirming details';
}

function principalsOf(input: IdentityOnboardingInput): string {
  const out: string[] = [];
  if (input.m365 !== null) out.push(`a Microsoft 365 account ${input.m365.userPrincipalName}`);
  if (input.google !== null) out.push(`a Google Workspace account ${input.google.primaryEmail}`);
  return out.join(' and ');
}

/**
 * Open the confirmation item so it NAMES who is being onboarded and which
 * accounts will be created (the human gate), then hand every later wake to
 * E3's generic `advanceHumanWork`, which resumes at `resumeStepKey`
 * ('discover', written by intake). Step-key-aware E3 writers, never
 * `manualWork.ts` (B3: those rows belong to the final `manual_work`).
 */
export async function advanceConfirmDetails(a: StepAdvancerArgs): Promise<string> {
  const o = await ops();
  const cp = await onboardingCheckpoint(o, a);
  if (!cp) return 'failed: checkpoint arm mismatch';
  const stepKey = a.task.currentStepKey ?? 'confirm_details';
  const existing = await o.readHumanWorkStep(a.task.orgId, a.task.id, stepKey, a.task.attemptOrdinal);
  if (existing && existing.dependencyId !== null) return o.advanceHumanWork(a);

  const contact = await readContactTarget(a.task.orgId, a.task.id);
  if (!contact) return fail(o, a, 'the task has no contact target to confirm', cp);
  const next = successorOf(o, a.recipe, 'confirm_details', cp);
  if (!next.ok) return fail(o, a, next.detail, cp);
  const armed = cp.resumeStepKey === next.key ? cp : nextCheckpoint(cp, { resumeStepKey: next.key });
  const input = inputOf(cp);
  const intakeNote = cp.findings.filter((f) => f.sourceId === 'intake').at(-1)?.text;
  const label = clip(`Confirm the onboarding of ${contact.label}: ${principalsOf(input)}`, LABEL_MAX_CHARS);
  const detail = clip(`The Operator will create ${principalsOf(input)} for ${input.displayName}`
    + `${input.startAt ? `, starting ${input.startAt}` : ''}, and then ask for approval of the licences and groups.`
    + `${intakeNote ? ` (${intakeNote}.)` : ''} Tick this only after confirming with the requester that the name, the `
    + 'sign-in addresses, the manager and the person to model access on are right. If anything is wrong, cancel this '
    + 'task and start a new one — do not tick it.', DETAIL_MAX_CHARS);
  let itemId: string | null = null;
  const committed = await leasedWrite({
    orgId: a.task.orgId, taskId: a.task.id, revision: a.task.revision, leaseEpoch: a.leaseEpoch,
    patch: {
      state: nextTaskState(a.task.state as string, 'wait'),
      waitReason: 'information', waitDependencyKind: null, waitDependencyId: null,
      nextWakeAt: new Date(a.now.getTime() + o.HUMAN_WORK_POLL_WAKE_MS),
      leaseOwner: null, leaseExpiresAt: null, currentStepKey: stepKey,
      checkpoint: armed as unknown as Record<string, unknown>,
    },
    alsoInTransaction: async () => {
      const taskRef = { id: a.task.id, orgId: a.task.orgId, objective: a.task.objective, revision: a.task.revision, attemptOrdinal: a.task.attemptOrdinal };
      await o.ensureTaskTicket(db, taskRef);
      const opened = await o.openHumanWorkStep(db, {
        task: taskRef, stepKey, targetId: contact.id, label, detail,
        remindAfterMs: HUMAN_WORK_REMIND_AFTER_MS, emitOpenEvent: existing === null, now: a.now,
      });
      itemId = opened.checklistItemId;
      // Both dependency columns together (ai_operator_tasks_wait_dependency_chk).
      await db.update(aiOperatorTasks)
        .set({ waitDependencyKind: 'user_answer', waitDependencyId: opened.checklistItemId })
        .where(and(eq(aiOperatorTasks.id, a.task.id), eq(aiOperatorTasks.orgId, a.task.orgId)));
    },
  });
  if (!committed) return `lost lease: '${stepKey}' not opened`;
  return `waiting: onboarding confirmation (item ${itemId})`;
}

/** Discover, compute readiness, seal snapshot 1 (`stage: 'create'`), move to `review`. */
export async function advanceOnboardingDiscover(a: StepAdvancerArgs): Promise<string> {
  const o = await ops();
  const cp = await onboardingCheckpoint(o, a);
  if (!cp) return 'failed: checkpoint arm mismatch';
  // Runs at most once per task: snapshot 1 is never rewritten (B2).
  if (cp.planningSnapshot) return fail(o, a, 'discover re-entered on a task that already holds a planning snapshot', cp);

  const contact = await readContactTarget(a.task.orgId, a.task.id);
  if (!contact) return fail(o, a, 'the task has no contact target to discover for', cp);
  const input = inputOf(cp);
  // THROWS on a transient fault (the wake retries); refusals are facts.
  const discovered = await o.discoverOnboardingFacts({ orgId: a.task.orgId, input, now: a.now });
  // B1: a create is never planned on a name nobody could check. When EVERY
  // in-scope provider's check failed to run there is nothing to do but hand off.
  const checks = [
    ...(input.m365 !== null ? [discovered.collisions.m365?.upnTaken ?? null] : []),
    ...(input.google !== null ? [discovered.collisions.google?.emailTaken ?? null] : []),
  ];
  if (checks.length > 0 && checks.every((c) => c === null)) {
    const flags = discovered.flags.map((f) => `${f.code} (${f.subject})`).join('; ') || 'no reason recorded';
    return handOff(o, a, `no collision check could run for any requested account: ${flags}`.slice(0, 1000),
      `Breeze could not check whether the requested sign-in names are free (${flags}), so it created nothing. `
      + 'Check the names in the admin consoles, then start a new task or create the accounts by hand.', cp);
  }
  const readiness = await o.computeRecipeReadinessSystem(a.task.orgId, a.recipe, { ignoreFlag: true });
  if (readiness.readiness === 'unavailable') {
    return handOff(o, a, 'no provider connection is usable for this organization',
      'Neither Microsoft 365 nor Google Workspace is connected in a usable state for this organization. Nothing was changed.', cp);
  }
  const catalog = new Set<string>(IDENTITY_ONBOARDING_EFFECT_TOOLS);
  const facts = {
    stage: 'create' as const,
    targets: { contactTargetId: contact.id, contactLabel: contact.label },
    ...discovered,
    // FROZEN with the facts: a later readiness change cannot alter the sealed
    // plan. The live re-check is the effect wrappers' veto.
    degradedTools: readiness.degradedEffects.filter((t) => catalog.has(t)),
    capabilityReadiness: { ...readiness.capabilityReadiness },
  };
  const sealed = o.sealPlanningSnapshot(facts, a.now);
  try {
    a.recipe.buildPlan(cp.recipeInput as never, sealed.envelope.facts);
  } catch (err) {
    return fail(o, a, `the plan cannot be built from the discovered facts: ${err instanceof Error ? err.message : String(err)}`, cp);
  }
  const next = successorOf(o, a.recipe, 'discover', cp, sealed.envelope.facts);
  if (!next.ok) return fail(o, a, next.detail, cp);
  const review = successorOf(o, a.recipe, next.key, cp, sealed.envelope.facts);
  if (!review.ok) return fail(o, a, review.detail, cp);
  const armed = nextCheckpoint(cp, { resumeStepKey: review.key });

  const summary = `discovered m365 collision=${String(discovered.collisions.m365?.upnTaken ?? 'n/a')} `
    + `google collision=${String(discovered.collisions.google?.emailTaken ?? 'n/a')}; `
    + `${facts.degradedTools.length} tool(s) degraded to human work; ${discovered.flags.length} flag(s)`;
  // ONE leased transaction: the envelope on the discover row, the step
  // settled, review opened, and the task checkpoint's ref.
  const committed = await moveWithStepData({
    o, a, toStepKey: next.key, checkpoint: armed, settledDetail: summary,
    extra: async (targetId) => {
      const stepId = await stepRowId(o, a, a.task.currentStepKey ?? 'discover', targetId);
      await db.update(aiOperatorTaskSteps)
        .set({ checkpoint: { planningSnapshot: sealed.envelope } as unknown as Record<string, unknown>, updatedAt: new Date() })
        .where(and(eq(aiOperatorTaskSteps.id, stepId), eq(aiOperatorTaskSteps.orgId, a.task.orgId), eq(aiOperatorTaskSteps.taskId, a.task.id)));
      const withRef = nextCheckpoint(armed, { planningSnapshot: { stepId, digest: sealed.digest } });
      await db.update(aiOperatorTasks)
        .set({ checkpoint: withRef as unknown as Record<string, unknown> })
        .where(and(eq(aiOperatorTasks.id, a.task.id), eq(aiOperatorTasks.orgId, a.task.orgId)));
    },
  });
  if (!committed) return 'lost lease: discover not sealed';
  return `advanced: ${summary}, reviewing`;
}

/**
 * A bounded run over the CREATE plan (stage 1 of 2). Validates the model's
 * flags; records them on the review step row for `manual_work`; then moves
 * into `create_accounts`. The task checkpoint changes in exactly two fields:
 * `createPlanRevision` (the revision `create_accounts` proposes at) and
 * `resumeStepKey` (`create_accounts`' successor). Proposes nothing.
 */
export async function advanceOnboardingReview(a: StepAdvancerArgs): Promise<string> {
  const o = await ops();
  const cp = await onboardingCheckpoint(o, a);
  if (!cp) return 'failed: checkpoint arm mismatch';
  // Fail closed on a missing, foreign or altered snapshot BEFORE spending a run.
  const loaded = await loadFacts(o, a, cp, 'review');
  if (!loaded.ok) return loaded.result;
  let createPlan: PlannedEffect[];
  try {
    createPlan = o.buildIdentityOnboardingCreatePlan(inputOf(cp), loaded.facts);
  } catch (err) {
    return settlePlanningFailure(o, a, `the create plan cannot be built: ${err instanceof Error ? err.message : String(err)}`, cp);
  }
  const reasoned = await reasonStep(o, a, cp, 'review');
  if (reasoned.done) return reasoned.result;

  const review = o.validateOnboardingReviewOutput(reasoned.inputs, new Set(createPlan.map((e) => e.toolName)));
  if (!review.ok) return fail(o, a, `review output refused (${review.reason}): ${review.detail}`, cp);
  const handoffs = review.exceptions.filter((e) => e.classification === 'handoff');
  if (handoffs.length > 0) {
    const names = handoffs.map((e) => `${e.toolName}: ${e.detail}`).join('; ');
    return handOff(o, a, `review classified an exception as handoff: ${names}`.slice(0, 1000),
      `Before anything was approved, the Operator flagged a problem a person must decide on: ${names}`.slice(0, 2000), cp);
  }
  const next = successorOf(o, a.recipe, 'create_accounts', cp, loaded.facts);
  if (!next.ok) return fail(o, a, next.detail, cp);
  const checkpoint = nextCheckpoint(cp, { createPlanRevision: a.task.revision, resumeStepKey: next.key });
  const reviewOutput: IdentityOnboardingReviewOutput = { flags: review.flags, exceptions: review.exceptions, summary: review.summary };
  const committed = await moveWithStepData({
    o, a, toStepKey: 'create_accounts', checkpoint,
    settledDetail: `review: ${review.flags.length} flag(s), ${review.exceptions.length} exception(s)`,
    extra: async (targetId) => {
      const stepId = await stepRowId(o, a, a.task.currentStepKey ?? 'review', targetId);
      await db.update(aiOperatorTaskSteps)
        .set({ checkpoint: { reviewOutput } as unknown as Record<string, unknown>, updatedAt: new Date() })
        .where(and(eq(aiOperatorTaskSteps.id, stepId), eq(aiOperatorTaskSteps.orgId, a.task.orgId), eq(aiOperatorTaskSteps.taskId, a.task.id)));
    },
  });
  if (!committed) return 'lost lease: review not recorded';
  return `advanced: review done, ${createPlan.length} create effect(s) to propose`;
}

// ---------------------------------------------------------------------------
// The two effect steps
// ---------------------------------------------------------------------------

/**
 * The live-readiness VETO (Todd's D3) and the STAGE CHECK, then E4's
 * `advanceEffect` unchanged. A COPY of `advanceIdentityEffects`' shape, not a
 * call: that one's checkpoint guard is offboarding's.
 *
 * The stage check exists because `buildPlan` has no step argument and
 * dispatches on `facts.stage`; delegating on a mismatched snapshot would plan
 * the OTHER stage. A mismatch is settled here with B2's classification.
 * Any other snapshot or build failure is E4's to classify (its
 * `planBuildFailure` carries B2's post-stage-1 branch): delegate.
 */
async function advanceOnboardingEffects(a: StepAdvancerArgs, stage: 'create' | 'provision'): Promise<string> {
  const o = await ops();
  const cp = await onboardingCheckpoint(o, a);
  if (!cp) return 'failed: checkpoint arm mismatch';
  const stepKey = a.task.currentStepKey ?? (stage === 'create' ? 'create_accounts' : 'provision_effects');
  const loaded = await o.loadPlanningFacts(a.task, a.recipe, cp, stepKey);
  if (!loaded.ok) return o.advanceEffect(a);
  const factsStage = (loaded.facts as { stage?: unknown }).stage;
  if (factsStage !== stage) {
    return settlePlanningFailure(o, a,
      `the planning facts at '${stepKey}' are stage '${String(factsStage)}', not '${stage}'`, cp);
  }
  let plan: PlannedEffect[];
  try {
    plan = a.recipe.buildPlan(cp.recipeInput as never, loaded.facts);
  } catch (err) {
    console.warn(`[aiOperator] onboarding effects veto: buildPlan failed for task ${a.task.id}: ${err instanceof Error ? err.message : String(err)}`);
    return o.advanceEffect(a);
  }
  // An empty plan follows A.4's empty-plan rule inside E4 unchanged.
  if (plan.length === 0) return o.advanceEffect(a);

  const readiness = await o.computeRecipeReadinessSystem(a.task.orgId, a.recipe, { ignoreFlag: true });
  const lost = new Set(readiness.degradedEffects);
  const keys = plan.map((e) => o.planEffectOperationKey({
    stepKey, planRevision: a.task.revision, toolName: e.toolName, targetId: e.targetId, ordinal: e.ordinal,
  }));
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ operationKey: aiOperatorOperations.operationKey, resultState: aiOperatorOperations.resultState })
    .from(aiOperatorOperations)
    .where(and(eq(aiOperatorOperations.orgId, a.task.orgId), eq(aiOperatorOperations.taskId, a.task.id), inArray(aiOperatorOperations.operationKey, keys)))));
  const started = new Map(rows.map((r) => [r.operationKey, r.resultState]));
  // Only effects with NO operation row are vetoed; one already started is E4's to observe.
  const blocked = plan.filter((e, i) => !started.has(keys[i]!) && lost.has(e.toolName));
  if (blocked.length === 0) return o.advanceEffect(a);
  const inFlight = [...started.values()].some((s) => s === 'pending' || s === 'unknown');
  if (inFlight) return o.advanceEffect(a);

  const names = blocked.map((e) => `${e.toolName} (ordinal ${e.ordinal})`).join(', ');
  const remaining = plan.filter((_, i) => !started.has(keys[i]!)).map((e) => e.toolName).join(', ');
  return handOff(o, a, `readiness lost after planning: ${names}`,
    `This organization can no longer run ${names} (a connection, permission or agent tool changed after the plan was made). `
    + `Breeze stopped before starting it. Not done by Breeze: ${remaining}. Complete these by hand or start a new task.`, cp);
}

/** `create_accounts` (stage 1, revision r). */
export async function advanceOnboardingCreateEffects(a: StepAdvancerArgs): Promise<string> {
  return advanceOnboardingEffects(a, 'create');
}

/** `provision_effects` (stage 2, revision r+1). */
export async function advanceOnboardingProvisionEffects(a: StepAdvancerArgs): Promise<string> {
  return advanceOnboardingEffects(a, 'provision');
}

// ---------------------------------------------------------------------------
// manual_create_google → resolve_accounts → [wait_start]
// ---------------------------------------------------------------------------

/**
 * Entered by `create_accounts`' generic move, whose checkpoint still names
 * `create_accounts`' successor (this step). On first entry it opens the
 * recipe's own item (what to create, exactly) and arms `resolve_accounts`;
 * every later wake is E3's `advanceHumanWork`, which resumes there.
 */
export async function advanceManualCreateGoogle(a: StepAdvancerArgs): Promise<string> {
  const o = await ops();
  const cp = await onboardingCheckpoint(o, a);
  if (!cp) return 'failed: checkpoint arm mismatch';
  const stepKey = a.task.currentStepKey ?? 'manual_create_google';
  const existing = await o.readHumanWorkStep(a.task.orgId, a.task.id, stepKey, a.task.attemptOrdinal);
  if (existing && existing.dependencyId !== null) return o.advanceHumanWork(a);

  const loaded = await loadFacts(o, a, cp, stepKey);
  if (!loaded.ok) return loaded.result;
  let item: ReturnType<Ops['buildManualCreateGoogleItem']>;
  try {
    item = o.buildManualCreateGoogleItem(inputOf(cp), loaded.facts);
  } catch (err) {
    return settlePlanningFailure(o, a, `the Google create item cannot be built: ${err instanceof Error ? err.message : String(err)}`, cp);
  }
  if (item === null) {
    return settlePlanningFailure(o, a, 'manual_create_google reached without a Google account to create', cp);
  }
  const next = successorOf(o, a.recipe, stepKey, cp, loaded.facts);
  if (!next.ok) return fail(o, a, next.detail, cp);
  const armed = nextCheckpoint(cp, { resumeStepKey: next.key });
  const contact = await readContactTarget(a.task.orgId, a.task.id);
  let itemId: string | null = null;
  const committed = await leasedWrite({
    orgId: a.task.orgId, taskId: a.task.id, revision: a.task.revision, leaseEpoch: a.leaseEpoch,
    patch: {
      state: nextTaskState(a.task.state as string, 'wait'),
      waitReason: 'information', waitDependencyKind: null, waitDependencyId: null,
      nextWakeAt: new Date(a.now.getTime() + o.HUMAN_WORK_POLL_WAKE_MS),
      leaseOwner: null, leaseExpiresAt: null, currentStepKey: stepKey,
      checkpoint: armed as unknown as Record<string, unknown>,
    },
    alsoInTransaction: async () => {
      const taskRef = { id: a.task.id, orgId: a.task.orgId, objective: a.task.objective, revision: a.task.revision, attemptOrdinal: a.task.attemptOrdinal };
      await o.ensureTaskTicket(db, taskRef);
      const opened = await o.openHumanWorkStep(db, {
        task: taskRef, stepKey, targetId: contact?.id ?? null, label: item.label, detail: item.detail,
        remindAfterMs: HUMAN_WORK_REMIND_AFTER_MS, emitOpenEvent: existing === null, now: a.now,
      });
      itemId = opened.checklistItemId;
      await db.update(aiOperatorTasks)
        .set({ waitDependencyKind: 'user_answer', waitDependencyId: opened.checklistItemId })
        .where(and(eq(aiOperatorTasks.id, a.task.id), eq(aiOperatorTasks.orgId, a.task.orgId)));
    },
  });
  if (!committed) return `lost lease: '${stepKey}' not opened`;
  return `waiting: Google account creation by hand (item ${itemId})`;
}

/** What is left after an unresolved stage 1, in words: the unresolved accounts and the collision/capability items. */
function unresolvedSummary(
  o: Ops, taskId: string, cp: Cp, facts: DiscoveryFacts,
  unresolved: ReadonlyArray<{ provider: string; reason: string; detail: string }>,
): string {
  const parts = unresolved.map((u) => `${u.provider === 'm365' ? 'Microsoft 365' : 'Google Workspace'}: ${u.reason} (${u.detail})`);
  try {
    const f = facts as DiscoveryFacts & { capabilityReadiness?: Record<string, boolean> };
    const items = o.buildIdentityOnboardingManualWork(inputOf(cp), facts, f.capabilityReadiness ?? {}, [])
      .filter((i) => /^(resolve_upn_collision|resolve_email_collision|collision_check_failed|capability):/.test(i.key));
    for (const i of items) parts.push(i.label);
  } catch (err) {
    // The unresolved list alone still names what is left; say why the items are missing.
    console.warn(`[aiOperator] identity_onboarding resolve_accounts: manual-work summary unavailable for task ${taskId}: `
      + `${err instanceof Error ? err.message : String(err)}`);
  }
  return parts.join('; ');
}

/**
 * B2's order, exactly. Provider reads first, OUTSIDE any transaction; then
 * ONE leased write at r whose callback runs Task 9's transition (guards, the
 * in-transaction bump r→r+1, the freeze, snapshot 2) and then, on the same
 * handle, moves the task to `provision_effects` at r+1 with the ref re-pointed
 * and `provision_effects`' successor armed. A guard miss THROWS the typed
 * sentinel (so the bump rolls back with everything else) and is caught here.
 */
export async function advanceResolveAccounts(a: StepAdvancerArgs): Promise<string> {
  const o = await ops();
  const cp = await onboardingCheckpoint(o, a);
  if (!cp) return 'failed: checkpoint arm mismatch';
  const stepKey = 'resolve_accounts';
  const loaded = await o.loadPlanningFacts(a.task, a.recipe, cp, stepKey);
  if (!loaded.ok) {
    // Re-entry after the transition committed: the ref already points at a
    // SUCCEEDED resolve_accounts row (only stage 2's loader accepts that).
    // The resolve row is written once; write nothing more.
    if (loaded.reason === 'snapshot_wrong_step') {
      const committed = await o.loadPlanningFacts(a.task, a.recipe, cp, 'provision_effects');
      if (committed.ok) return 'noop: resolve_accounts already committed the stage transition';
    }
    return handOffAfterStageOne(o, a, `planning snapshot ${loaded.reason}: ${loaded.detail}`, cp);
  }
  const r = cp.createPlanRevision;
  if (r === null || r !== a.task.revision || !cp.planningSnapshot) {
    return handOffAfterStageOne(o, a,
      `resolve_accounts expects the create revision ${String(r)} but the task is at revision ${a.task.revision}`, cp);
  }

  // Outside any transaction. A transient fault or db error THROWS (the wake retries).
  const res = await o.resolveCreatedAccounts({
    orgId: a.task.orgId, taskId: a.task.id, attemptOrdinal: a.task.attemptOrdinal,
    createPlanRevision: r, input: inputOf(cp), facts: loaded.facts,
  });
  if (!res.ok) {
    const left = res.reason === 'no_account_resolved' ? unresolvedSummary(o, a.task.id, cp, loaded.facts, res.unresolved) : res.detail;
    // No bump: a bump with nothing to provision would supersede the creation approval for nothing.
    return handOff(o, a, `resolve_accounts: ${res.reason}: ${res.detail}`.slice(0, 1000),
      `Breeze could not confirm any account this onboarding created, so it did not go on to licences and groups. `
      + `What is left: ${left}. Finish the onboarding by hand, or start a new task once the accounts are sorted out.`.slice(0, 2000), cp);
  }
  // A provider whose create was expected but did not resolve may hold an
  // account Breeze cannot confirm. Bumping would drop its provisioning and let
  // verify_outcome call it "not created"; hand off instead, naming it.
  const unconfirmed = res.unresolved.filter((u) => !o.isExpectedAbsentReason(u.reason));
  if (unconfirmed.length > 0) {
    const named = unconfirmed
      .map((u) => `${u.provider === 'm365' ? 'Microsoft 365' : 'Google Workspace'} (${u.provider}: ${u.reason}: ${u.detail})`)
      .join('; ');
    return handOffAfterStageOne(o, a, clip(
      `resolve_accounts could not confirm ${named}; its account may already exist and must be checked `
      + 'before anything is created again', 1000), cp);
  }
  const next = successorOf(o, a.recipe, 'provision_effects', cp, loaded.facts);
  if (!next.ok) return fail(o, a, next.detail, cp);

  const snapshotRef = cp.planningSnapshot;
  let moved: { newRevision: number; frozen: string[] } | null = null;
  try {
    const committed = await leasedWrite({
      // The CAS at r with an EMPTY patch: the step, checkpoint and revision
      // are written below, after the in-transaction bump, never ahead of it.
      orgId: a.task.orgId, taskId: a.task.id, revision: r, leaseEpoch: a.leaseEpoch,
      patch: {},
      alsoInTransaction: async () => {
        const out = await o.commitOnboardingStageTransition(db, {
          orgId: a.task.orgId, taskId: a.task.id, leaseEpoch: a.leaseEpoch, attemptOrdinal: a.task.attemptOrdinal,
          createPlanRevision: r, snapshotRef, facts: loaded.facts, resolved: res, now: a.now,
        });
        const checkpoint = nextCheckpoint(cp, { planningSnapshot: out.snapshot, resumeStepKey: next.key });
        const rows = await db.update(aiOperatorTasks)
          .set({
            currentStepKey: 'provision_effects',
            phase: a.recipe.steps.provision_effects?.phase ?? 'execute',
            checkpoint: checkpoint as unknown as Record<string, unknown>,
            waitReason: null, waitDependencyKind: null, waitDependencyId: null,
            nextWakeAt: new Date(), leaseOwner: null, leaseExpiresAt: new Date(Date.now() - 1), updatedAt: new Date(),
          })
          .where(and(
            eq(aiOperatorTasks.id, a.task.id),
            eq(aiOperatorTasks.orgId, a.task.orgId),
            eq(aiOperatorTasks.revision, out.newRevision),
            eq(aiOperatorTasks.leaseEpoch, a.leaseEpoch),
          ))
          .returning({ id: aiOperatorTasks.id });
        if (rows.length !== 1) {
          throw new o.OnboardingStageTransitionAbort('bump_lost', `the task did not move to provision_effects at revision ${out.newRevision}`);
        }
        const targetId = await ordinalZeroTargetId(a.task.orgId, a.task.id);
        await o.settleStep(db, {
          orgId: a.task.orgId, taskId: a.task.id, stepKey, targetId, attemptOrdinal: a.task.attemptOrdinal,
          state: 'succeeded', actor: COORDINATOR,
          detail: `froze ${out.frozen.join(', ')}; plan revision ${r} -> ${out.newRevision}`
            + `${res.unresolved.length > 0 ? `; unresolved: ${res.unresolved.map((u) => `${u.provider} ${u.reason}`).join(', ')}` : ''}`,
        });
        await o.openStep(db, {
          orgId: a.task.orgId, taskId: a.task.id, stepKey: 'provision_effects',
          stepKind: o.resolveStepKind(a.task.workflowKey, a.task.workflowVersion, 'provision_effects'),
          targetId, attemptOrdinal: a.task.attemptOrdinal, planRevision: out.newRevision,
          checkpoint: checkpoint as unknown as Record<string, unknown>, actor: COORDINATOR,
        });
        moved = { newRevision: out.newRevision, frozen: out.frozen };
      },
    });
    if (!committed) return 'lost lease: resolve_accounts not committed';
  } catch (err) {
    if (err instanceof o.OnboardingStageTransitionAbort) {
      // Rolled back: nothing of the transition was committed.
      if (err.guard === 'revision_moved' || err.guard === 'bump_lost') return `lost lease: ${err.message}`;
      return handOff(o, a, err.message.slice(0, 1000),
        `Breeze stopped between creating the accounts and assigning their access (${err.guard}). Nothing further was `
        + 'changed. Review the accounts that exist and finish the onboarding by hand.', cp,
        err.guard === 'operation_unsettled' ? 'unknown_effect' : 'unresolved');
    }
    throw err;
  }
  const done = moved as { newRevision: number; frozen: string[] } | null;
  return `advanced: resolved ${done?.frozen.join(', ') ?? ''}; provisioning plans at revision ${done?.newRevision ?? ''}`;
}

/**
 * Entered by `provision_effects`' generic move. Arms `waitUntil` =
 * `input.startAt` and `resumeStepKey` = `manual_work`, and hands that
 * checkpoint to E3's `advanceWait`, whose own leased write persists it.
 */
export async function advanceWaitStart(a: StepAdvancerArgs): Promise<string> {
  const o = await ops();
  const cp = await onboardingCheckpoint(o, a);
  if (!cp) return 'failed: checkpoint arm mismatch';
  const startAt = inputOf(cp).startAt;
  if (startAt === null) {
    return handOffAfterStageOne(o, a, 'wait_start reached on an onboarding with no start time', cp);
  }
  const next = successorOf(o, a.recipe, 'wait_start', cp);
  if (!next.ok) return fail(o, a, next.detail, cp);
  const armed = cp.waitUntil === startAt && cp.resumeStepKey === next.key
    ? cp : nextCheckpoint(cp, { waitUntil: startAt, resumeStepKey: next.key });
  return o.advanceWait({ ...a, checkpoint: armed });
}

// ---------------------------------------------------------------------------
// manual_work → verify_outcome → document
// ---------------------------------------------------------------------------

/** Every manual item up front (from snapshot 2); wait on the first open one; move on when all are done. */
export async function advanceOnboardingManualWork(a: StepAdvancerArgs): Promise<string> {
  const o = await ops();
  const cp = await onboardingCheckpoint(o, a);
  if (!cp) return 'failed: checkpoint arm mismatch';
  const loaded = await loadFacts(o, a, cp, 'manual_work');
  if (!loaded.ok) return loaded.result;
  const reviewCp = await readStepCheckpoint(a.task.orgId, a.task.id, 'review');
  const reviewOutput = (reviewCp?.reviewOutput ?? null) as IdentityOnboardingReviewOutput | null;
  const flags = [
    ...(reviewOutput?.flags ?? []),
    ...(reviewOutput?.exceptions ?? []).filter((e) => e.classification === 'human_work')
      .map((e, i) => ({ code: 'review_exception', subject: `${e.toolName} (${i + 1})`, detail: e.detail })),
  ];
  const facts = loaded.facts as DiscoveryFacts & { capabilityReadiness?: Record<string, boolean> };
  let items: ReturnType<Ops['capOnboardingManualWork']>;
  try {
    items = o.capOnboardingManualWork(o.buildIdentityOnboardingManualWork(inputOf(cp), facts, facts.capabilityReadiness ?? {}, flags));
  } catch (err) {
    return handOffAfterStageOne(o, a, `the manual work list cannot be built: ${err instanceof Error ? err.message : String(err)}`, cp);
  }
  const next = successorOf(o, a.recipe, 'manual_work', cp, loaded.facts);
  if (!next.ok) return fail(o, a, next.detail, cp);
  const after = successorOf(o, a.recipe, next.key, cp, loaded.facts);
  if (!after.ok) return fail(o, a, after.detail, cp);
  const taskRef = { id: a.task.id, orgId: a.task.orgId, objective: a.task.objective, revision: a.task.revision };

  const rows = await o.readManualWork(a.task.orgId, a.task.id);
  const linked = rows.filter((r) => r.checklistItemId !== null);
  // R1's detached rule: a `waiting` row with no link, or a linked item no
  // longer readable in this org, was moved or removed. Re-creating would open
  // a second ticket and reset ticked work; hand off instead.
  const unreachable = linked.filter((r) => r.itemLabel === null);
  const detached = rows.filter((r) => r.checklistItemId === null && r.stepState === 'waiting');
  if (detached.length > 0 || unreachable.length > 0) {
    return handOff(o, a, 'a manual-work checklist item is no longer reachable from this task',
      'A ticket step this task was waiting on is no longer part of this organization (it was moved or removed). '
      + 'Nothing further was changed. Confirm the remaining work by hand.', cp);
  }
  const accounted = rows.filter((r) => r.checklistItemId !== null || r.stepState === 'succeeded');
  if (items.length > 0 && accounted.length < items.length) {
    let waitOn: string | null = null;
    const committed = await leasedWrite({
      orgId: a.task.orgId, taskId: a.task.id, revision: a.task.revision, leaseEpoch: a.leaseEpoch,
      patch: {
        state: nextTaskState(a.task.state as string, 'wait'),
        waitReason: 'information', waitDependencyKind: null, waitDependencyId: null,
        nextWakeAt: new Date(a.now.getTime() + o.HUMAN_WORK_POLL_WAKE_MS),
        leaseOwner: null, leaseExpiresAt: null, currentStepKey: 'manual_work',
        checkpoint: nextCheckpoint(cp, { onboardingWorkCursor: 0 }) as unknown as Record<string, unknown>,
      },
      alsoInTransaction: async () => {
        const targetId = await ordinalZeroTargetId(a.task.orgId, a.task.id);
        const created = await o.ensureManualWorkItems(db, taskRef, items, {
          targetId, remindAfterMs: HUMAN_WORK_REMIND_AFTER_MS, now: a.now,
        });
        const ticked = new Set(rows.filter((r) => r.itemDoneAt).map((r) => r.index));
        waitOn = created.itemIds.find((_, i) => !ticked.has(i)) ?? created.itemIds[0] ?? null;
        if (waitOn) {
          await db.update(aiOperatorTasks)
            .set({ waitDependencyKind: 'user_answer', waitDependencyId: waitOn })
            .where(and(eq(aiOperatorTasks.id, a.task.id), eq(aiOperatorTasks.orgId, a.task.orgId)));
        }
        await o.appendTaskEvent(db, {
          orgId: a.task.orgId, taskId: a.task.id, eventType: 'wait_entered', actor: COORDINATOR, stepKey: 'manual_work',
          detail: `${created.created} manual item(s) put on ticket ${created.ticketId}; waiting on people`,
        });
      },
    });
    if (!committed) return 'lost lease: manual items not created';
    return `waiting: ${items.length} manual item(s) on the ticket`;
  }

  const toSettle = rows.filter((r) => r.itemDoneAt && r.stepState !== 'succeeded');
  const settleTicked = async (targetId: string | null) => {
    for (const r of toSettle) {
      await o.settleStep(db, {
        orgId: a.task.orgId, taskId: a.task.id, stepKey: 'manual_work', targetId,
        attemptOrdinal: r.index, state: 'succeeded',
        detail: `completed by user ${r.itemDoneByUserId ?? 'unknown'} at ${r.itemDoneAt!.toISOString()}`, actor: COORDINATOR,
      });
    }
  };
  const open = o.nextOpenManualItem(rows, 0);
  if (open) {
    const committed = await leasedWrite({
      orgId: a.task.orgId, taskId: a.task.id, revision: a.task.revision, leaseEpoch: a.leaseEpoch,
      patch: {
        state: nextTaskState(a.task.state as string, 'wait'),
        waitReason: 'information', waitDependencyKind: 'user_answer', waitDependencyId: open.itemId,
        nextWakeAt: new Date(a.now.getTime() + o.HUMAN_WORK_POLL_WAKE_MS),
        leaseOwner: null, leaseExpiresAt: null, currentStepKey: 'manual_work',
        checkpoint: nextCheckpoint(cp, { onboardingWorkCursor: open.index }) as unknown as Record<string, unknown>,
      },
      alsoInTransaction: async () => {
        await settleTicked(await ordinalZeroTargetId(a.task.orgId, a.task.id));
      },
    });
    if (!committed) return 'lost lease: manual work not re-armed';
    return `waiting: manual item ${open.index + 1} of ${rows.length}`;
  }
  const committed = await moveWithStepData({
    o, a, toStepKey: next.key, checkpoint: nextCheckpoint(cp, { resumeStepKey: after.key }),
    settledDetail: `all ${rows.length} manual item(s) completed by people`,
    extra: settleTicked,
  });
  if (!committed) return 'lost lease: manual work not completed';
  return 'advanced: manual work done, verifying';
}

/** Per operation key: when the walk dispatched it. Never selects `result` (it carries the sealed credential). */
async function readDispatchTimes(a: StepAdvancerArgs, keys: readonly string[]): Promise<Map<string, Date | null>> {
  if (keys.length === 0) return new Map();
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ operationKey: aiOperatorOperations.operationKey, dispatchedAt: aiOperatorOperations.dispatchedAt })
    .from(aiOperatorOperations)
    .where(and(eq(aiOperatorOperations.orgId, a.task.orgId), eq(aiOperatorOperations.taskId, a.task.id), inArray(aiOperatorOperations.operationKey, [...keys])))));
  return new Map(rows.map((r) => [r.operationKey, r.dispatchedAt ?? null]));
}

/**
 * This step's OWN probe (D-R2-11's first claim): the resolved account exists
 * and is enabled. Read by its frozen immutable id. A transient fault THROWS;
 * a definitive refusal is a problem (the account could not be confirmed).
 */
async function observeAccount(
  o: Ops, orgId: string, provider: 'm365' | 'google', externalId: string,
): Promise<string | null> {
  if (provider === 'm365') {
    let user: Record<string, unknown>;
    try {
      const r = await o.m365Read(orgId, { type: 'm365.user.get', userIdOrUpn: externalId });
      if (r.kind !== 'resource') return 'the Microsoft 365 account read returned an unexpected shape';
      user = r.resource;
    } catch (err) {
      if (err instanceof o.M365ReadFailed && err.code === 'graph_not_found') return 'the Microsoft 365 account no longer exists';
      o.rethrowIfTransientM365(err);
      return `the Microsoft 365 account could not be read (${err instanceof o.M365ReadFailed ? err.code : 'error'})`;
    }
    if (typeof user.id !== 'string' || user.id.toLowerCase() !== externalId.toLowerCase()) {
      return 'Microsoft 365 returned a different user for the created account';
    }
    if (user.accountEnabled !== true) {
      return user.accountEnabled === false ? 'the Microsoft 365 account is disabled' : 'the Microsoft 365 account\'s enabled state could not be read';
    }
    return null;
  }
  let ctx: Awaited<ReturnType<Ops['resolveContextByOrg']>>;
  try {
    ctx = await o.inOrgContext(orgId, () => o.resolveContextByOrg(orgId));
  } catch (err) {
    throw new o.DiscoveryTransientError('google', 'connection', o.errorMessage(err));
  }
  if ('error' in ctx) return 'the Google Workspace account could not be read (no usable connection)';
  let data: { id?: unknown; suspended?: unknown };
  try {
    const dir = o.getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
    data = (await dir.users.get({ userKey: externalId })).data as typeof data;
  } catch (err) {
    const norm = o.normalizeGoogleError(err);
    if (norm.code === 'google_not_found') return 'the Google Workspace account no longer exists';
    if (o.isTransientGoogle(err)) throw new o.DiscoveryTransientError('google', norm.code, o.errorMessage(err));
    return `the Google Workspace account could not be read (${norm.code})`;
  }
  if (data.id !== externalId) return 'Google Workspace returned a different user for the created account';
  if (data.suspended !== false) {
    return data.suspended === true ? 'the Google Workspace account is suspended' : 'the Google Workspace account\'s state could not be read';
  }
  return null;
}

/**
 * D-R2-11, a conjunction. `passed` requires:
 *  - every OBSERVABLE dispatched effect of BOTH stages to post-probe
 *    `satisfied` (the licence and membership claims are the effects' own
 *    criteria), probed against when the walk dispatched it;
 *  - each resolved account to exist and be enabled (this step's own probe);
 *  - every in-scope provider to HAVE a resolved account, unless its create
 *    was degraded to human work at discovery (degradation is not failure).
 * An unverifiable creation is `failed` → `partial`. There is no subsumption
 * branch: `IDENTITY_ONBOARDING_UNOBSERVABLE_EFFECTS` is empty.
 */
export async function advanceOnboardingVerifyOutcome(a: StepAdvancerArgs): Promise<string> {
  const o = await ops();
  const cp = await onboardingCheckpoint(o, a);
  if (!cp) return 'failed: checkpoint arm mismatch';
  const loaded = await loadFacts(o, a, cp, 'verify_outcome');
  if (!loaded.ok) return loaded.result;
  const input = inputOf(cp);
  const createRevision = cp.createPlanRevision;
  let stage: Array<{ effect: PlannedEffect; stepKey: string; planRevision: number }>;
  let accounts: { m365: { externalId: string } | null; google: { externalId: string } | null };
  let degradedTools: readonly string[];
  try {
    const f = o.parseIdentityOnboardingFacts(loaded.facts);
    if (f.stage !== 'provision') throw new Error(`verify_outcome planned from stage '${f.stage}' facts`);
    if (createRevision === null) throw new Error('the checkpoint records no create revision');
    const { accounts: resolved, stage: _stage, ...rest } = f;
    void _stage;
    // Snapshot 2 = snapshot 1 + stage + accounts, so stage 1's plan rebuilds exactly.
    const create = o.buildIdentityOnboardingCreatePlan(input, { ...rest, stage: 'create' });
    const provision = o.buildIdentityOnboardingProvisionPlan(input, loaded.facts);
    stage = [
      ...create.map((effect) => ({ effect, stepKey: 'create_accounts', planRevision: createRevision })),
      ...provision.map((effect) => ({ effect, stepKey: 'provision_effects', planRevision: a.task.revision })),
    ];
    accounts = resolved;
    degradedTools = f.degradedTools;
  } catch (err) {
    return handOffAfterStageOne(o, a, `the plan cannot be rebuilt for verification: ${err instanceof Error ? err.message : String(err)}`, cp);
  }
  const next = successorOf(o, a.recipe, 'verify_outcome', cp, loaded.facts);
  if (!next.ok) return fail(o, a, next.detail, cp);

  const keyOf = (s: (typeof stage)[number]) => o.planEffectOperationKey({
    stepKey: s.stepKey, planRevision: s.planRevision, toolName: s.effect.toolName, targetId: s.effect.targetId, ordinal: s.effect.ordinal,
  });
  const dispatched = await readDispatchTimes(a, stage.map(keyOf));
  const unconfirmed: string[] = [];
  for (const s of stage) {
    const key = keyOf(s);
    if (!dispatched.has(key)) { unconfirmed.push(`${s.effect.toolName} (not dispatched)`); continue; }
    const probe = await o.probeEffect(s.effect, {
      orgId: a.task.orgId, taskId: a.task.id, planRevision: s.planRevision,
      effectRequestedAt: dispatched.get(key) ?? a.now, phase: 'post',
    });
    if (probe.state !== 'satisfied') unconfirmed.push(`${s.effect.toolName} (${probe.state})`);
  }

  const accountProblems: string[] = [];
  for (const provider of ['google', 'm365'] as const) {
    const inScope = provider === 'm365' ? input.m365 !== null : input.google !== null;
    if (!inScope) continue;
    const account = accounts[provider];
    const name = provider === 'm365' ? 'Microsoft 365' : 'Google Workspace';
    if (account === null) {
      // A create degraded to human work was never Breeze's to verify.
      if (provider === 'm365' && degradedTools.includes('m365_create_user')) continue;
      accountProblems.push(`the ${name} account was not created by this task or could not be confirmed`);
      continue;
    }
    const problem = await observeAccount(o, a.task.orgId, provider, account.externalId);
    if (problem) accountProblems.push(problem);
  }

  const problems = [...unconfirmed.map((u) => `unconfirmed: ${u}`), ...accountProblems];
  const passed = problems.length === 0;
  const detail = passed
    ? `all ${stage.length} dispatched effect(s) observed in their end state; every created account exists and is enabled`
    : problems.join('; ').slice(0, 500);
  const checkpoint = nextCheckpoint(cp, {
    lastVerification: { result: passed ? 'passed' : 'failed', detail, at: a.now.toISOString() },
  });
  await o.settleStepAndMove({
    task: a.task, leaseEpoch: a.leaseEpoch, recipe: a.recipe, checkpoint, toStepKey: next.key,
    settledDetail: detail, resolvedDetail: `verification ${passed ? 'passed' : 'found gaps'}`,
  });
  return `advanced: verification ${passed ? 'passed' : 'failed'}, documenting`;
}

/** Post the completion record once, then settle from the recorded verdict. */
export async function advanceOnboardingDocument(a: StepAdvancerArgs): Promise<string> {
  const o = await ops();
  const cp = await onboardingCheckpoint(o, a);
  if (!cp) return 'failed: checkpoint arm mismatch';
  const record = await o.buildCompletionRecord({ orgId: a.task.orgId, taskId: a.task.id, recipeKey: a.recipe.key });
  try {
    const committed = await leasedWrite({
      orgId: a.task.orgId, taskId: a.task.id, revision: a.task.revision, leaseEpoch: a.leaseEpoch,
      patch: {},
      alsoInTransaction: async () => {
        const stepId = await stepRowId(o, a, a.task.currentStepKey ?? 'document', await ordinalZeroTargetId(a.task.orgId, a.task.id));
        await o.postCompletionRecord(db, { orgId: a.task.orgId, taskId: a.task.id, ticketId: record.ticketId, stepId, text: record.text });
      },
    });
    if (!committed) return 'lost lease: completion record not posted';
  } catch (err) {
    if (err instanceof o.CompletionRecordNoTicketError) return handOffAfterStageOne(o, a, err.message, cp);
    throw err;
  }
  const verdict = cp.lastVerification;
  if (verdict?.result === 'passed') {
    await o.settle({ task: a.task, leaseEpoch: a.leaseEpoch, event: 'complete', outcome: 'verified_resolved', detail: verdict.detail, checkpoint: cp });
    return 'settled: verified_resolved';
  }
  const detail = verdict ? `verification ${verdict.result}: ${verdict.detail}` : 'no verification was recorded';
  await o.settle({
    task: a.task, leaseEpoch: a.leaseEpoch, event: 'partial', outcome: 'unresolved', detail, checkpoint: cp,
    handoffSummary: `The onboarding ran, but not everything could be confirmed: ${detail}. The completion record on the ticket lists what is left.`,
  });
  return 'settled: partial';
}

/** `RECIPE_ADVANCERS['identity_onboarding']` — all twelve steps. */
export const IDENTITY_ONBOARDING_ADVANCERS: Readonly<Record<string, StepAdvancer>> = Object.freeze({
  intake: advanceOnboardingIntake,
  confirm_details: advanceConfirmDetails,
  discover: advanceOnboardingDiscover,
  review: advanceOnboardingReview,
  create_accounts: advanceOnboardingCreateEffects,
  manual_create_google: advanceManualCreateGoogle,
  resolve_accounts: advanceResolveAccounts,
  provision_effects: advanceOnboardingProvisionEffects,
  wait_start: advanceWaitStart,
  manual_work: advanceOnboardingManualWork,
  verify_outcome: advanceOnboardingVerifyOutcome,
  document: advanceOnboardingDocument,
});
