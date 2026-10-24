/**
 * `identity_offboarding`'s coordinator advancers (Recipe Library spec §6.1,
 * §6.3; W06 R1a Task 11). The coordinator consults `RECIPE_ADVANCERS[key]`
 * before its `KIND_ADVANCERS` fallback; this table is that entry.
 *
 *   intake            advanceIntake            bounded reasoning run; candidates validated
 *   confirm_identity  advanceConfirmIdentity   opens the item NAMING the frozen person, then E3's advanceHumanWork
 *   discover          advanceDiscover          coordinator reads + readiness, sealed planning snapshot
 *   review            advanceReview            bounded reasoning run over the SNAPSHOT plan; proposes nothing
 *   effects           advanceIdentityEffects   live-readiness veto, then E4's advanceEffect unchanged
 *   manual_work       advanceManualWork        every item up front, wait on the first open one
 *   verify_outcome    advanceVerifyOutcome     post-probe every planned effect + residual re-read
 *   document          advanceDocument          completion record, then the terminal settle
 *
 * THE TRANSITION RULE (D-R1-2). An advancer that moves the task into step S
 * resolves S's successor with `resolveDeterministicNextStep` and writes it as
 * `checkpoint.resumeStepKey`; an unresolvable `next` settles fail/unresolved
 * and is never guessed.
 *
 * THROW VS SETTLE. Every refusal — an invalid model output, a missing or
 * foreign row, a snapshot that fails its digest — SETTLES the task. A
 * transient I/O error THROWS, so the wake job retries and the reconciler
 * re-wakes (E4's rule in `applyEffectDirective`).
 *
 * LEASE SAFETY. Every task write goes through `COORDINATOR_STEP_OPS`, the
 * coordinator's own lease-CAS writers, imported LAZILY: the coordinator
 * imports this table at load, so a static import back is a load-time cycle.
 * Where a step must write step-row data together with the task row (the
 * planning snapshot, the review output, the manual items), it uses
 * `COORDINATOR_STEP_OPS.writeLeased` and its `alsoInTransaction`, so the
 * task row and the step rows commit together or not at all.
 *
 * TENANCY. Every read here runs in system scope with an explicit `org_id`
 * predicate; that predicate is the isolation.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  identityOffboardingCheckpointSchema,
  type IdentityOffboardingCheckpoint,
  type IdentityOffboardingInput,
  type IdentityReviewOutput,
  isIdentityOffboardingCheckpoint,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiOperatorTasks, aiOperatorOperations } from '../../db/schema/aiOperatorTasks';
import { aiOperatorTaskSteps, aiOperatorTaskTargetAccounts, aiOperatorTaskTargets } from '../../db/schema/aiOperatorTaskGraph';
import { contacts } from '../../db/schema/contacts';
import type { StepAdvancer } from './taskCoordinator';
import type { DiscoveryFacts, PlannedEffect, RecipeDefinition } from './recipes/types';
import type { IdentityDiscoveryFacts } from './identityDiscovery';
import { IDENTITY_OFFBOARDING_EFFECT_TOOLS } from './recipes/identityOffboarding';
import { nextTaskState } from './taskTransitions';

export type StepAdvancerArgs = Parameters<StepAdvancer>[0];

const COORDINATOR = { kind: 'coordinator' } as const;
const RUN_POLL_MS = 10 * 60 * 1000;
const HUMAN_WORK_REMIND_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Everything this module calls, loaded LAZILY. The coordinator imports this
 * table at load, so a static import of the coordinator back is a load-time
 * cycle; and keeping the service graph (discovery, readiness, probes, manual
 * work, the completion record) out of the coordinator's load-time imports
 * keeps every existing suite that mocks those modules loading exactly what it
 * loaded before R1a.
 */
async function ops() {
  const [nextStep, coordinator, recipes, identity, planning, approval, probes, discovery, readiness, context, manual, record, humanWork, steps, events] =
    await Promise.all([
      import('./recipes/resolveNextStep'), import('./taskCoordinator'), import('./recipes'), import('./recipes/identityOffboarding'),
      import('./planningSnapshot'), import('./planApproval'), import('./effectProbes'), import('./identityDiscovery'),
      import('./recipeReadiness'), import('./taskContextIdentity'), import('./manualWork'), import('./completionRecord'),
      import('./humanWorkService'), import('./stepService'), import('./eventService'),
    ]);
  return {
    resolveDeterministicNextStep: nextStep.resolveDeterministicNextStep,
    ...coordinator.COORDINATOR_STEP_OPS,
    advanceEffect: coordinator.advanceEffect,
    advanceHumanWork: coordinator.advanceHumanWork,
    validateRecipeNextStep: recipes.validateRecipeNextStep,
    buildIdentityOffboardingManualWork: identity.buildIdentityOffboardingManualWork,
    capManualWork: identity.capManualWork,
    MAIL_ROUTING_TOOLS: identity.MAIL_ROUTING_TOOLS,
    LOCKOUT_TOOL: identity.LOCKOUT_TOOL,
    loadPlanningFacts: planning.loadPlanningFacts,
    sealPlanningSnapshot: planning.sealPlanningSnapshot,
    planEffectOperationKey: approval.planEffectOperationKey,
    probeEffect: probes.probeEffect,
    isStructurallyUnobservable: probes.isStructurallyUnobservable,
    discoverIdentityFacts: discovery.discoverIdentityFacts,
    computeRecipeReadinessSystem: readiness.computeRecipeReadinessSystem,
    validateIntakeOutput: context.validateIntakeOutput,
    validateReviewOutput: context.validateReviewOutput,
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
  };
}

type Ops = Awaited<ReturnType<typeof ops>>;

/**
 * The coordinator's lease CAS with step-row writes in the SAME transaction —
 * a deliberate MIRROR of `taskCoordinator.ts`'s private `writeLeased`, line
 * for line: `UPDATE ai_operator_tasks … WHERE (id, org_id, revision,
 * lease_epoch)`, exactly one row or nothing, and `alsoInTransaction` runs only
 * when the CAS won, so a stale coordinator commits nothing (Operator spec
 * §6.2). It exists because `COORDINATOR_STEP_OPS` is frozen at six members by
 * a pinned test, and `discover` (the planning snapshot), `review` (its
 * validated output) and `manual_work` (the items) must write step rows and
 * the task row together. `identityAdvancers.test.ts` pins the predicate.
 */
export async function leasedWrite(args: {
  orgId: string;
  taskId: string;
  revision: number;
  leaseEpoch: number;
  patch: Partial<typeof aiOperatorTasks.$inferInsert>;
  alsoInTransaction?: () => Promise<void>;
}): Promise<boolean> {
  const committed = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const rows = await db
        .update(aiOperatorTasks)
        .set({ ...args.patch, updatedAt: new Date() })
        .where(and(
          eq(aiOperatorTasks.id, args.taskId),
          eq(aiOperatorTasks.orgId, args.orgId),
          eq(aiOperatorTasks.revision, args.revision),
          eq(aiOperatorTasks.leaseEpoch, args.leaseEpoch),
        ))
        .returning({ id: aiOperatorTasks.id });
      if (rows.length !== 1) return false;
      if (args.alsoInTransaction) await args.alsoInTransaction();
      return true;
    }));
  if (!committed) {
    console.warn('[aiOperator] stale coordinator lost its lease CAS; another holder owns this task', {
      taskId: args.taskId, orgId: args.orgId, revision: args.revision, leaseEpoch: args.leaseEpoch,
    });
  }
  return committed;
}

async function fail(o: Ops, a: StepAdvancerArgs, detail: string, checkpoint?: IdentityOffboardingCheckpoint): Promise<string> {
  await o.settle({ task: a.task, leaseEpoch: a.leaseEpoch, event: 'fail', outcome: 'unresolved', detail, ...(checkpoint ? { checkpoint } : {}) });
  return `failed: ${detail}`;
}

async function handOff(
  o: Ops, a: StepAdvancerArgs, detail: string, handoffSummary: string, checkpoint?: IdentityOffboardingCheckpoint,
): Promise<string> {
  await o.settle({
    task: a.task, leaseEpoch: a.leaseEpoch, event: 'hand_off', outcome: 'unresolved', detail, handoffSummary,
    ...(checkpoint ? { checkpoint } : {}),
  });
  return `handed off: ${detail}`;
}

/** Narrow once; a miss cannot happen for an admitted task, but it is never a cast. */
async function identityCheckpoint(o: Ops, a: StepAdvancerArgs): Promise<IdentityOffboardingCheckpoint | null> {
  if (isIdentityOffboardingCheckpoint(a.checkpoint)) return a.checkpoint;
  await fail(o, a, `identity_offboarding step '${a.task.currentStepKey}' reached without an identity checkpoint`);
  return null;
}

function nextCheckpoint(cp: IdentityOffboardingCheckpoint, patch: Partial<IdentityOffboardingCheckpoint>): IdentityOffboardingCheckpoint {
  return identityOffboardingCheckpointSchema.parse({ ...cp, ...patch });
}

/** The successor of `stepKey`, or null (the caller settles fail with `detail`). */
function successorOf(
  o: Ops, recipe: RecipeDefinition<never>, stepKey: string, cp: IdentityOffboardingCheckpoint, facts: DiscoveryFacts = {},
): { ok: true; key: string } | { ok: false; detail: string } {
  const r = o.resolveDeterministicNextStep(recipe, stepKey, { input: cp.recipeInput, facts, readiness: {} });
  return r.ok ? r : { ok: false, detail: `next step after '${stepKey}' could not be resolved: ${r.detail}` };
}

interface TaskTargets {
  contact: { id: string; label: string; contactId: string | null } | null;
  devices: Array<{ deviceId: string | null; label: string }>;
  accounts: Array<{ provider: 'm365' | 'google'; externalId: string; principalLabel: string }>;
}

async function readTaskTargets(orgId: string, taskId: string): Promise<TaskTargets> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const targets = await db
      .select({
        id: aiOperatorTaskTargets.id, kind: aiOperatorTaskTargets.targetKind, label: aiOperatorTaskTargets.targetLabel,
        contactId: aiOperatorTaskTargets.contactId, deviceId: aiOperatorTaskTargets.deviceId, ordinal: aiOperatorTaskTargets.targetOrdinal,
      })
      .from(aiOperatorTaskTargets)
      .where(and(eq(aiOperatorTaskTargets.orgId, orgId), eq(aiOperatorTaskTargets.taskId, taskId)))
      .orderBy(asc(aiOperatorTaskTargets.targetOrdinal));
    const accounts = await db
      .select({ provider: aiOperatorTaskTargetAccounts.provider, externalId: aiOperatorTaskTargetAccounts.externalId, principalLabel: aiOperatorTaskTargetAccounts.principalLabel })
      .from(aiOperatorTaskTargetAccounts)
      .where(and(eq(aiOperatorTaskTargetAccounts.orgId, orgId), eq(aiOperatorTaskTargetAccounts.taskId, taskId)));
    const contact = targets.find((t) => t.kind === 'contact' && t.ordinal === 0) ?? null;
    return {
      contact: contact ? { id: contact.id, label: contact.label, contactId: contact.contactId } : null,
      devices: targets.filter((t) => t.kind === 'device').map((t) => ({ deviceId: t.deviceId, label: t.label })),
      accounts: accounts.filter((x): x is typeof x & { provider: 'm365' | 'google' } => x.provider === 'm365' || x.provider === 'google'),
    };
  }));
}

/**
 * Settle the current step, open `toStepKey`, write the task row — and run
 * `extra` step-row writes — in ONE lease-CAS transaction. The task patch is
 * the one `settleStepAndMove` writes (due now, expired lease, wait cleared).
 */
async function moveWithStepData(args: {
  o: Ops; a: StepAdvancerArgs; toStepKey: string; checkpoint: IdentityOffboardingCheckpoint;
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
      const [t] = await db.select({ id: aiOperatorTaskTargets.id }).from(aiOperatorTaskTargets)
        .where(and(eq(aiOperatorTaskTargets.orgId, task.orgId), eq(aiOperatorTaskTargets.taskId, task.id), eq(aiOperatorTaskTargets.targetOrdinal, 0)))
        .limit(1);
      const targetId = t?.id ?? null;
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

function mergeRunFindings(cp: IdentityOffboardingCheckpoint, outcome: unknown): IdentityOffboardingCheckpoint['findings'] {
  const submitted = (outcome as { taskStep?: { findings?: IdentityOffboardingCheckpoint['findings'] } } | null)?.taskStep?.findings ?? [];
  return [...cp.findings, ...submitted].slice(-50);
}

/**
 * The shared shape of a reason step: admit a bounded run, wait for it, then
 * hand back its validated `nextStep` proposal — or settle.
 */
async function reasonStep(
  o: Ops, a: StepAdvancerArgs, cp: IdentityOffboardingCheckpoint, stepKey: 'intake' | 'review',
): Promise<{ done: true; result: string } | { done: false; inputs: Record<string, unknown>; findings: IdentityOffboardingCheckpoint['findings'] }> {
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
    // A reason step of a deterministic recipe never proposes an action.
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
// The advancers
// ---------------------------------------------------------------------------

export async function advanceIntake(a: StepAdvancerArgs): Promise<string> {
  const o = await ops();
  const cp = await identityCheckpoint(o, a);
  if (!cp) return 'failed: checkpoint arm mismatch';
  const reasoned = await reasonStep(o, a, cp, 'intake');
  if (reasoned.done) return reasoned.result;

  const targets = await readTaskTargets(a.task.orgId, a.task.id);
  if (!targets.contact?.contactId) return fail(o, a, 'the task has no live contact target to confirm');
  const proposed = Array.isArray(reasoned.inputs.candidateContactIds)
    ? (reasoned.inputs.candidateContactIds as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  // The org-scoped existence set the validator checks against.
  const inOrg = proposed.length === 0 ? [] : await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ id: contacts.id }).from(contacts)
    .where(and(eq(contacts.orgId, a.task.orgId), inArray(contacts.id, proposed)))
    .limit(10)));
  const intake = o.validateIntakeOutput(reasoned.inputs, new Set(inOrg.map((r) => r.id)));
  if (!intake.ok) return fail(o, a, `intake output refused (${intake.reason}): ${intake.detail}`);

  const next = successorOf(o, a.recipe, 'confirm_identity', cp);
  if (!next.ok) return fail(o, a, next.detail);
  const includesFrozen = intake.candidateContactIds.includes(targets.contact.contactId);
  const note = `intake proposed ${intake.candidateContactIds.length} candidate contact(s); the admitted contact `
    + `${includesFrozen ? 'is' : 'is NOT'} among them`
    + `${reasoned.inputs.ambiguous === true ? ' and the Operator marked the match ambiguous' : ''}`;
  const checkpoint = nextCheckpoint(cp, {
    findings: [...reasoned.findings, {
      text: note, sourceKind: 'other' as const, sourceId: 'intake', observedAt: a.now.toISOString(),
    }].slice(-50),
    resumeStepKey: next.key,
  });
  await o.writeLeasedStep(a.task, a.leaseEpoch, 'confirm_identity', a.recipe, checkpoint);
  return `advanced: intake done (${note}), confirming identity`;
}

/**
 * Open the confirmation item so it NAMES who will be offboarded and which
 * accounts will be acted on — the human gate (spec §11 risk row 1) — then hand
 * every later wake to E3's generic `advanceHumanWork`, which waits for the
 * tick and resumes at `resumeStepKey` ('discover').
 */
export async function advanceConfirmIdentity(a: StepAdvancerArgs): Promise<string> {
  const o = await ops();
  const cp = await identityCheckpoint(o, a);
  if (!cp) return 'failed: checkpoint arm mismatch';
  const stepKey = a.task.currentStepKey ?? 'confirm_identity';
  const existing = await o.readHumanWorkStep(a.task.orgId, a.task.id, stepKey, a.task.attemptOrdinal);
  if (existing && existing.dependencyId !== null) return o.advanceHumanWork(a);

  const targets = await readTaskTargets(a.task.orgId, a.task.id);
  if (!targets.contact) return fail(o, a, 'the task has no contact target to confirm', cp);
  const accounts = targets.accounts.map((x) => `${x.provider === 'm365' ? 'Microsoft 365' : 'Google Workspace'} ${x.principalLabel}`);
  const intakeNote = cp.findings.filter((f) => f.sourceId === 'intake').at(-1)?.text;
  const label = `Confirm that ${targets.contact.label} is the person to offboard`;
  const detail = `The Operator will act on: ${accounts.join('; ') || 'no provider accounts'}.`
    + `${intakeNote ? ` (${intakeNote}.)` : ''} Tick this only after confirming with the requester that this is the `
    + 'right person and the right accounts. If it is not, cancel this task and start again with the correct contact — do not tick it.';
  let itemId: string | null = null;
  const committed = await leasedWrite({
    orgId: a.task.orgId, taskId: a.task.id, revision: a.task.revision, leaseEpoch: a.leaseEpoch,
    patch: {
      state: nextTaskState(a.task.state as string, 'wait'),
      waitReason: 'information', waitDependencyKind: null, waitDependencyId: null,
      nextWakeAt: new Date(a.now.getTime() + o.HUMAN_WORK_POLL_WAKE_MS),
      leaseOwner: null, leaseExpiresAt: null, currentStepKey: stepKey,
      checkpoint: cp as unknown as Record<string, unknown>,
    },
    alsoInTransaction: async () => {
      const taskRef = { id: a.task.id, orgId: a.task.orgId, objective: a.task.objective, revision: a.task.revision, attemptOrdinal: a.task.attemptOrdinal };
      await o.ensureTaskTicket(db, taskRef);
      const opened = await o.openHumanWorkStep(db, {
        task: taskRef, stepKey, targetId: targets.contact!.id, label, detail,
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
  return `waiting: identity confirmation (item ${itemId})`;
}

/** Read the frozen accounts, discover, compute readiness, seal the snapshot, move to `review`. */
export async function advanceDiscover(a: StepAdvancerArgs): Promise<string> {
  const o = await ops();
  const cp = await identityCheckpoint(o, a);
  if (!cp) return 'failed: checkpoint arm mismatch';
  // Runs at most once per task: there is no re-discovery after review (A.4).
  if (cp.planningSnapshot) return fail(o, a, 'discover re-entered on a task that already holds a planning snapshot', cp);

  const targets = await readTaskTargets(a.task.orgId, a.task.id);
  if (!targets.contact) return fail(o, a, 'the task has no contact target to discover', cp);
  if (targets.accounts.length === 0) {
    return handOff(o, a, 'no provider account is frozen on this task',
      'The Operator has no Microsoft 365 or Google Workspace account to act on for this person. Nothing was changed.', cp);
  }
  const input = cp.recipeInput as IdentityOffboardingInput;
  // I/O below THROWS on a transient fault (the wake retries); provider
  // failures are already facts (`present: false` + a flag), never throws.
  const discovered = await o.discoverIdentityFacts({
    orgId: a.task.orgId, accounts: targets.accounts, inheritorContactId: input.inheritorContactId, now: a.now,
  });
  if (!discovered.google.present && !discovered.m365.present) {
    const flags = discovered.flags.map((f) => `${f.code} (${f.subject})`).join('; ') || 'no account found';
    return handOff(o, a, `discovery found neither provider account: ${flags}`,
      `The Operator could not read this person's accounts from either provider (${flags}). Nothing was changed.`, cp);
  }
  const readiness = await o.computeRecipeReadinessSystem(a.task.orgId, a.recipe, { ignoreFlag: true });
  if (readiness.readiness === 'unavailable') {
    return handOff(o, a, 'no provider connection is usable for this organization',
      'Neither Microsoft 365 nor Google Workspace is connected in a usable state for this organization. Nothing was changed.', cp);
  }
  const catalog = new Set<string>(IDENTITY_OFFBOARDING_EFFECT_TOOLS);
  const facts = {
    ...discovered,
    targets: {
      contactTargetId: targets.contact.id,
      contactLabel: targets.contact.label,
      deviceLabels: Object.fromEntries(targets.devices.filter((d) => d.deviceId).map((d) => [d.deviceId!, d.label])),
    },
    // FROZEN with the facts (A.3 refinement 1): a later readiness change can
    // never alter the sealed plan. The live re-check is the effects veto.
    degradedTools: readiness.degradedEffects.filter((t) => catalog.has(t)),
    // The degraded tools held back by caller verification, so the manual
    // item can say why (it is a policy choice, not a missing grant).
    callerVerificationTools: readiness.callerVerificationBlocked.filter((t) => catalog.has(t)),
    capabilityReadiness: readiness.capabilityReadiness,
    // Frozen with the facts so the manual list can name each gap.
    admissionProblems: cp.admissionProblems,
  };
  const sealed = o.sealPlanningSnapshot(facts, a.now);
  try {
    a.recipe.buildPlan(cp.recipeInput as never, sealed.envelope.facts);
  } catch (err) {
    return fail(o, a, `the plan cannot be built from the discovered facts: ${err instanceof Error ? err.message : String(err)}`, cp);
  }
  const next = successorOf(o, a.recipe, 'discover', cp, sealed.envelope.facts);
  if (!next.ok) return fail(o, a, next.detail, cp);

  const summary = `discovered google=${discovered.google.present} m365=${discovered.m365.present}; `
    + `${facts.degradedTools.length} tool(s) degraded to human work; ${discovered.flags.length} flag(s)`;
  // ONE leased transaction: the envelope on the discover step row, the step
  // settled, review opened, and the task checkpoint's ref — the envelope and
  // the ref can never disagree.
  const committed = await moveWithStepData({
    o, a, toStepKey: next.key, checkpoint: cp, settledDetail: summary,
    extra: async (targetId) => {
      const stepId = await stepRowId(o, a, a.task.currentStepKey ?? 'discover', targetId);
      await db.update(aiOperatorTaskSteps)
        .set({ checkpoint: { planningSnapshot: sealed.envelope } as unknown as Record<string, unknown>, updatedAt: new Date() })
        .where(and(eq(aiOperatorTaskSteps.id, stepId), eq(aiOperatorTaskSteps.orgId, a.task.orgId), eq(aiOperatorTaskSteps.taskId, a.task.id)));
      const withRef = nextCheckpoint(cp, { planningSnapshot: { stepId, digest: sealed.digest } });
      await db.update(aiOperatorTasks)
        .set({ checkpoint: withRef as unknown as Record<string, unknown> })
        .where(and(eq(aiOperatorTasks.id, a.task.id), eq(aiOperatorTasks.orgId, a.task.orgId)));
    },
  });
  if (!committed) return 'lost lease: discover not sealed';
  return `advanced: ${summary}, reviewing`;
}

/** The plan from the frozen snapshot, or a settled refusal. */
async function snapshotPlan(
  o: Ops, a: StepAdvancerArgs, cp: IdentityOffboardingCheckpoint,
): Promise<{ ok: true; facts: DiscoveryFacts; plan: PlannedEffect[] } | { ok: false; result: string }> {
  const loaded = await o.loadPlanningFacts(a.task, a.recipe, cp);
  if (!loaded.ok) return { ok: false, result: await fail(o, a, `planning snapshot ${loaded.reason}: ${loaded.detail}`, cp) };
  try {
    return { ok: true, facts: loaded.facts, plan: a.recipe.buildPlan(cp.recipeInput as never, loaded.facts) };
  } catch (err) {
    return { ok: false, result: await fail(o, a, `buildPlan threw: ${err instanceof Error ? err.message : String(err)}`, cp) };
  }
}

/** A bounded run over the SNAPSHOT plan; validates flags; moves into `effects`. Proposes nothing. */
export async function advanceReview(a: StepAdvancerArgs): Promise<string> {
  const o = await ops();
  const cp = await identityCheckpoint(o, a);
  if (!cp) return 'failed: checkpoint arm mismatch';
  // Fail closed on a missing, foreign or altered snapshot BEFORE spending a run.
  const built = await snapshotPlan(o, a, cp);
  if (!built.ok) return built.result;
  const reasoned = await reasonStep(o, a, cp, 'review');
  if (reasoned.done) return reasoned.result;

  const review = o.validateReviewOutput(reasoned.inputs, new Set(built.plan.map((e) => e.toolName)));
  if (!review.ok) return fail(o, a, `review output refused (${review.reason}): ${review.detail}`, cp);
  const handoffs = review.exceptions.filter((e) => e.classification === 'handoff');
  if (handoffs.length > 0) {
    const names = handoffs.map((e) => `${e.toolName}: ${e.detail}`).join('; ');
    return handOff(o, a, `review classified an exception as handoff: ${names}`.slice(0, 1000),
      `Before anything was approved, the Operator flagged a problem a person must decide on: ${names}`.slice(0, 2000), cp);
  }
  const next = successorOf(o, a.recipe, 'effects', cp, built.facts);
  if (!next.ok) return fail(o, a, next.detail, cp);
  const input = cp.recipeInput as IdentityOffboardingInput;
  const checkpoint = nextCheckpoint(cp, {
    findings: reasoned.findings,
    resumeStepKey: next.key,
    // The post-approval not-before gate (A.3 refinement 2). Absent = start
    // as soon as the plan is approved.
    ...(input.cutoffAt ? { dispatchNotBefore: input.cutoffAt } : {}),
  });
  const reviewOutput: IdentityReviewOutput = { flags: review.flags, exceptions: review.exceptions, summary: review.summary };
  const committed = await moveWithStepData({
    o, a, toStepKey: 'effects', checkpoint,
    settledDetail: `review: ${review.flags.length} flag(s), ${review.exceptions.length} exception(s)`,
    extra: async (targetId) => {
      const stepId = await stepRowId(o, a, a.task.currentStepKey ?? 'review', targetId);
      await db.update(aiOperatorTaskSteps)
        .set({ checkpoint: { reviewOutput } as unknown as Record<string, unknown>, updatedAt: new Date() })
        .where(and(eq(aiOperatorTaskSteps.id, stepId), eq(aiOperatorTaskSteps.orgId, a.task.orgId), eq(aiOperatorTaskSteps.taskId, a.task.id)));
    },
  });
  if (!committed) return 'lost lease: review not recorded';
  return `advanced: review done, ${built.plan.length} effect(s) to propose`;
}

/**
 * The live-readiness VETO (A.4, D3), then E4 unchanged. Only planned effects
 * with NO operation row are considered — an effect already started is never
 * vetoed; E4 observes and verifies it. While any planned effect's operation is
 * unsettled the veto delegates, so the in-flight effect is observed first.
 */
export async function advanceIdentityEffects(a: StepAdvancerArgs): Promise<string> {
  const o = await ops();
  const cp = await identityCheckpoint(o, a);
  if (!cp) return 'failed: checkpoint arm mismatch';
  const loaded = await o.loadPlanningFacts(a.task, a.recipe, cp);
  let plan: PlannedEffect[] | null = null;
  if (loaded.ok) {
    try {
      plan = a.recipe.buildPlan(cp.recipeInput as never, loaded.facts);
    } catch (err) {
      // E4 rebuilds and classifies this failure; logged so it is never invisible here.
      console.warn(`[aiOperator] identity effects veto: buildPlan failed for task ${a.task.id}: ${err instanceof Error ? err.message : String(err)}`);
      plan = null;
    }
  }
  // A snapshot or build failure is E4's to classify (fail vs hand-off by
  // whether an approval exists): delegate rather than duplicate that rule.
  if (!plan || plan.length === 0) return o.advanceEffect(a);

  const readiness = await o.computeRecipeReadinessSystem(a.task.orgId, a.recipe, { ignoreFlag: true });
  const lost = new Set(readiness.degradedEffects);
  const stepKey = a.task.currentStepKey ?? 'effects';
  const keys = plan.map((e) => o.planEffectOperationKey({
    stepKey, planRevision: a.task.revision, toolName: e.toolName, targetId: e.targetId, ordinal: e.ordinal,
  }));
  const ops_ = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ operationKey: aiOperatorOperations.operationKey, resultState: aiOperatorOperations.resultState })
    .from(aiOperatorOperations)
    .where(and(eq(aiOperatorOperations.orgId, a.task.orgId), eq(aiOperatorOperations.taskId, a.task.id), inArray(aiOperatorOperations.operationKey, keys)))));
  const started = new Map(ops_.map((r) => [r.operationKey, r.resultState]));
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

/** Every manual item up front; wait on the first open one; move on when all are done (D-R1-5). */
export async function advanceManualWork(a: StepAdvancerArgs): Promise<string> {
  const o = await ops();
  const cp = await identityCheckpoint(o, a);
  if (!cp) return 'failed: checkpoint arm mismatch';
  const built = await snapshotPlan(o, a, cp);
  if (!built.ok) return built.result;
  const reviewCp = await readStepCheckpoint(a.task.orgId, a.task.id, 'review');
  const reviewOutput = (reviewCp?.reviewOutput ?? null) as IdentityReviewOutput | null;
  const flags = [
    ...(reviewOutput?.flags ?? []),
    // Numbered: two exceptions about the same tool are two items, not one
    // silently deduplicated away.
    ...(reviewOutput?.exceptions ?? []).filter((e) => e.classification === 'human_work')
      .map((e, i) => ({ code: 'review_exception', subject: `${e.toolName} (${i + 1})`, detail: e.detail })),
  ];
  const facts = built.facts as DiscoveryFacts & { capabilityReadiness?: Record<string, boolean> };
  // Capped at the checklist bound by folding the overflow into one item that
  // names the rest — never a throw (which would wedge the task after its
  // effects ran) and never a silent drop.
  const items = o.capManualWork(o.buildIdentityOffboardingManualWork(
    cp.recipeInput as IdentityOffboardingInput, facts, facts.capabilityReadiness ?? {}, flags,
  ));
  const next = successorOf(o, a.recipe, 'manual_work', cp, built.facts);
  if (!next.ok) return fail(o, a, next.detail, cp);
  const taskRef = { id: a.task.id, orgId: a.task.orgId, objective: a.task.objective, revision: a.task.revision };

  const rows = await o.readManualWork(a.task.orgId, a.task.id);
  const linked = rows.filter((r) => r.checklistItemId !== null);
  // Checked BEFORE creation. An item's step row is linked and set `waiting` in
  // the transaction that creates the item, so a `waiting` row with NO link was
  // detached — the ticket moved to another org, or the item was deleted.
  // (The coordinator opens the first row `running` and unlinked before this
  // advancer ever runs; that one is not detached.) Re-creating would open a
  // second ticket here and reset ticked work; hand off instead.
  const unreachable = linked.filter((r) => r.itemLabel === null);
  const detached = rows.filter((r) => r.checklistItemId === null && r.stepState === 'waiting');
  if (detached.length > 0 || unreachable.length > 0) {
    return handOff(o, a, 'a manual-work checklist item is no longer reachable from this task',
      'A ticket step this task was waiting on is no longer part of this organization (it was moved or removed). '
      + 'Nothing further was changed. Confirm the remaining work by hand.', cp);
  }
  // A row already completed by a person counts even if its link was removed
  // later; only a never-created item is created.
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
        checkpoint: nextCheckpoint(cp, { manualWorkCursor: 0 }) as unknown as Record<string, unknown>,
      },
      alsoInTransaction: async () => {
        const [t] = await db.select({ id: aiOperatorTaskTargets.id }).from(aiOperatorTaskTargets)
          .where(and(eq(aiOperatorTaskTargets.orgId, a.task.orgId), eq(aiOperatorTaskTargets.taskId, a.task.id), eq(aiOperatorTaskTargets.targetOrdinal, 0)))
          .limit(1);
        const created = await o.ensureManualWorkItems(db, taskRef, items, {
          targetId: t?.id ?? null, remindAfterMs: HUMAN_WORK_REMIND_AFTER_MS, now: a.now,
        });
        const done = new Set(rows.filter((r) => r.itemDoneAt).map((r) => r.index));
        waitOn = created.itemIds.find((_, i) => !done.has(i)) ?? created.itemIds[0] ?? null;
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
  const settleDone = async (targetId: string | null) => {
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
        checkpoint: nextCheckpoint(cp, { manualWorkCursor: open.index }) as unknown as Record<string, unknown>,
      },
      alsoInTransaction: async () => {
        const [t] = await db.select({ id: aiOperatorTaskTargets.id }).from(aiOperatorTaskTargets)
          .where(and(eq(aiOperatorTaskTargets.orgId, a.task.orgId), eq(aiOperatorTaskTargets.taskId, a.task.id), eq(aiOperatorTaskTargets.targetOrdinal, 0)))
          .limit(1);
        await settleDone(t?.id ?? null);
      },
    });
    if (!committed) return 'lost lease: manual work not re-armed';
    return `waiting: manual item ${open.index + 1} of ${rows.length}`;
  }
  const committed = await moveWithStepData({
    o, a, toStepKey: next.key, checkpoint: cp,
    settledDetail: `all ${rows.length} manual item(s) completed by people`,
    extra: settleDone,
  });
  if (!committed) return 'lost lease: manual work not completed';
  return `advanced: manual work done, verifying`;
}

/**
 * Spec §6.6's last rule. `passed` requires every OBSERVABLE planned effect to
 * post-probe `satisfied`, an unobservable one counting only when its declared
 * subsumer is `satisfied` on the same non-null account — AND a fresh re-read
 * of the providers showing nothing the plan was meant to remove still there,
 * so world drift after discovery (a group added later) surfaces as `failed`
 * with the leftover named. The verdict is recorded on the checkpoint;
 * `document` settles from it.
 */
export async function advanceVerifyOutcome(a: StepAdvancerArgs): Promise<string> {
  const o = await ops();
  const cp = await identityCheckpoint(o, a);
  if (!cp) return 'failed: checkpoint arm mismatch';
  const built = await snapshotPlan(o, a, cp);
  if (!built.ok) return built.result;
  const next = successorOf(o, a.recipe, 'verify_outcome', cp, built.facts);
  if (!next.ok) return fail(o, a, next.detail, cp);

  // The walk's own record of each effect: WHEN it was dispatched (a probe
  // judges "after the request", so verify must ask about the request time —
  // asking about now makes a session revoke look undone) and whether the walk
  // verified it. No operation row means the effect never ran.
  const walk = await readWalkRecord(a, built.plan);
  const states = new Map<number, string>();
  for (const effect of built.plan) {
    const ran = walk.get(effect.ordinal);
    if (!ran) { states.set(effect.ordinal, 'not dispatched'); continue; }
    const probe = await o.probeEffect(effect, {
      orgId: a.task.orgId, taskId: a.task.id, planRevision: a.task.revision,
      effectRequestedAt: ran.dispatchedAt ?? a.now, phase: 'post',
    });
    states.set(effect.ordinal, probe.state);
  }
  const satisfied = built.plan.filter((e) => states.get(e.ordinal) === 'satisfied');
  // A mail setting cannot be re-read once the account is locked (Google reads
  // it by impersonating the mailbox owner, which a suspended user cannot be).
  // When the walk verified it and the SAME account's lockout is now observed,
  // the walk's verification stands — the lockout is evidence nothing undid it.
  const confirmedAtWalk = (e: PlannedEffect): boolean => {
    const ran = walk.get(e.ordinal);
    // Verified by the walk, or found already in place by it (a no-op).
    if (states.get(e.ordinal) !== 'unknown' || !(ran?.verified === true || ran?.noop === true)) return false;
    if (e.provider === 'breeze' || e.accountExternalId === null || !o.MAIL_ROUTING_TOOLS[e.provider].includes(e.toolName)) return false;
    const lockout = o.LOCKOUT_TOOL[e.provider];
    return satisfied.some((s) => s.toolName === lockout && s.accountExternalId === e.accountExternalId);
  };
  const unconfirmed = built.plan.filter((e) => {
    if (states.get(e.ordinal) === 'satisfied' || confirmedAtWalk(e)) return false;
    const subsumer = a.recipe.unobservableEffects?.[e.toolName];
    const subsumed = subsumer !== undefined && states.get(e.ordinal) === 'unknown' && o.isStructurallyUnobservable(e.toolName)
      && e.accountExternalId !== null
      && satisfied.some((s) => s.toolName === subsumer && s.accountExternalId === e.accountExternalId);
    return !subsumed;
  }).map((e) => `${e.toolName} (${states.get(e.ordinal)})`);

  const targets = await readTaskTargets(a.task.orgId, a.task.id);
  const fresh = await o.discoverIdentityFacts({ orgId: a.task.orgId, accounts: targets.accounts, now: a.now });
  const residual = residualAfterOffboarding(cp.recipeInput as IdentityOffboardingInput, fresh);

  // A provider whose admission lookup failed was never checked by Breeze.
  const unchecked = (cp.admissionProblems).map((p) => `not checked by Breeze: ${p}`);
  const problems = [...unconfirmed.map((u) => `unconfirmed: ${u}`), ...residual, ...unchecked];
  const passed = problems.length === 0;
  const detail = passed
    ? `all ${built.plan.length} planned effect(s) observed in their end state; nothing left to remove`
    : problems.join('; ').slice(0, 500);
  const checkpoint = nextCheckpoint(cp, {
    lastVerification: { result: passed ? 'passed' : 'failed', detail, at: a.now.toISOString() },
  });
  await o.settleStepAndMove({
    task: a.task, leaseEpoch: a.leaseEpoch, recipe: a.recipe, checkpoint, toStepKey: next.key,
    settledDetail: detail, resolvedDetail: `verification ${passed ? 'passed' : 'found leftovers'}`,
  });
  return `advanced: verification ${passed ? 'passed' : 'failed'}, documenting`;
}

/** Per planned ordinal: when the walk dispatched it, and whether the walk verified it. */
async function readWalkRecord(
  a: StepAdvancerArgs,
  plan: readonly PlannedEffect[],
): Promise<Map<number, { dispatchedAt: Date | null; verified: boolean | null; noop: boolean }>> {
  const o = await ops();
  const keys = plan.map((e) => o.planEffectOperationKey({
    stepKey: 'effects', planRevision: a.task.revision, toolName: e.toolName, targetId: e.targetId, ordinal: e.ordinal,
  }));
  if (keys.length === 0) return new Map();
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ operationKey: aiOperatorOperations.operationKey, dispatchedAt: aiOperatorOperations.dispatchedAt, result: aiOperatorOperations.result })
    .from(aiOperatorOperations)
    .where(and(eq(aiOperatorOperations.orgId, a.task.orgId), eq(aiOperatorOperations.taskId, a.task.id), inArray(aiOperatorOperations.operationKey, keys)))));
  const byKey = new Map(rows.map((r) => [r.operationKey, r]));
  const out = new Map<number, { dispatchedAt: Date | null; verified: boolean | null; noop: boolean }>();
  plan.forEach((e, i) => {
    const r = byKey.get(keys[i]!);
    if (!r) return;
    const result = (r.result ?? {}) as { noop?: unknown; verified?: { ok?: unknown } };
    const ok = result.verified?.ok;
    out.set(e.ordinal, { dispatchedAt: r.dispatchedAt ?? null, verified: typeof ok === 'boolean' ? ok : null, noop: result.noop === true });
  });
  return out;
}

/** What is still there that the toggles asked to remove. Pure over a fresh read. */
export function residualAfterOffboarding(input: IdentityOffboardingInput, fresh: IdentityDiscoveryFacts): string[] {
  const out: string[] = [];
  const fx = input.effects;
  for (const f of fresh.flags) out.push(`could not re-check: ${f.code} (${f.subject})`);
  // A re-read that stopped short (a cap, or the read budget) did not see everything.
  for (const t of fresh.truncated) out.push(`could not re-check all of ${t}`);
  if (fresh.google.present) {
    if (fx.removeGroups) for (const g of fresh.google.groups) out.push(`still in Google group ${g.name}`);
    if (fx.removeLicenses) for (const l of fresh.google.licenses) out.push(`still holds Google licence ${l.name ?? l.skuId}`);
    if (fx.disableAccount && fresh.google.suspended === false) out.push('Google account is still active');
  }
  if (fresh.m365.present) {
    if (fx.removeGroups) for (const g of fresh.m365.groups) out.push(`still in Microsoft 365 group ${g.name}`);
    if (fx.removeLicenses && !input.keepMailbox) for (const l of fresh.m365.licenses) out.push(`still holds Microsoft 365 licence ${l.name ?? l.skuId}`);
    if (fx.disableAccount && fresh.m365.accountEnabled === true) out.push('Microsoft 365 account is still enabled');
  }
  return out;
}

/** Post the completion record once, then settle from the recorded verdict. */
export async function advanceDocument(a: StepAdvancerArgs): Promise<string> {
  const o = await ops();
  const cp = await identityCheckpoint(o, a);
  if (!cp) return 'failed: checkpoint arm mismatch';
  const record = await o.buildCompletionRecord({ orgId: a.task.orgId, taskId: a.task.id, recipeKey: a.recipe.key });
  try {
    const committed = await leasedWrite({
      orgId: a.task.orgId, taskId: a.task.id, revision: a.task.revision, leaseEpoch: a.leaseEpoch,
      patch: {},
      alsoInTransaction: async () => {
        const [t] = await db.select({ id: aiOperatorTaskTargets.id }).from(aiOperatorTaskTargets)
          .where(and(eq(aiOperatorTaskTargets.orgId, a.task.orgId), eq(aiOperatorTaskTargets.taskId, a.task.id), eq(aiOperatorTaskTargets.targetOrdinal, 0)))
          .limit(1);
        const stepId = await stepRowId(o, a, a.task.currentStepKey ?? 'document', t?.id ?? null);
        await o.postCompletionRecord(db, { orgId: a.task.orgId, taskId: a.task.id, ticketId: record.ticketId, stepId, text: record.text });
      },
    });
    if (!committed) return 'lost lease: completion record not posted';
  } catch (err) {
    if (err instanceof o.CompletionRecordNoTicketError) return fail(o, a, err.message, cp);
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
    handoffSummary: `The offboarding ran, but not everything could be confirmed: ${detail}. The completion record on the ticket lists what is left.`,
  });
  return 'settled: partial';
}

/** `RECIPE_ADVANCERS['identity_offboarding']`. */
export const IDENTITY_OFFBOARDING_ADVANCERS: Readonly<Record<string, StepAdvancer>> = Object.freeze({
  intake: advanceIntake,
  confirm_identity: advanceConfirmIdentity,
  discover: advanceDiscover,
  review: advanceReview,
  effects: advanceIdentityEffects,
  manual_work: advanceManualWork,
  verify_outcome: advanceVerifyOutcome,
  document: advanceDocument,
});
