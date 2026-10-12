/**
 * probe → write → probe for plan-approved effects (Recipe Library spec §6.1
 * step kinds `effect` / `probe`, §6.4, §6.6) — wave E4 (#6169).
 *
 * The coordinator half of the two step kinds, kept OUT of taskCoordinator.ts
 * (plan D-E4-8). Every function here RETURNS a typed directive; the
 * coordinator's arm performs the one write to `ai_operator_tasks` (wait /
 * settle / move), so invariant 1 — the coordinator is the only writer of the
 * task row, under its lease CAS — is unchanged. What this module does write
 * is plan content (via planApproval.ts), child action intents (via the
 * ordinary `createActionIntent`), and operation rows — each idempotent by its
 * own unique key, so a stale coordinator re-running a tick converges instead
 * of duplicating.
 *
 * THE RULES (each has a test):
 *  - Every decision re-reads rows (invariant 2): the approval, the effect
 *    set, the operations and the child intents. The plan's ARGUMENTS come
 *    from re-running the recipe's pure `buildPlan`, and must re-seal to the
 *    approved digest — a plan that changed under a live approval hands off
 *    (R1 calls `bumpPlanRevision` instead).
 *  - Membership is checked BEFORE any provider I/O.
 *  - A pre-probe that already observes the end state settles the operation
 *    `succeeded` with `result.noop = true` and dispatches NOTHING.
 *  - A `non_idempotent` effect whose pre-probe is anything but `unsatisfied`
 *    hands off (spec §6.4: for a create, `satisfied` means a collision).
 *  - A post-probe `unsatisfied` or `unknown` is NEVER `verified`; this wave
 *    does not auto-retry (the operation key is permanent, so a retry needs a
 *    new key — follow-up), it hands off with the remaining plan named.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { computeEffectSetDigest } from '@breeze/shared/canonicalize/effectSet';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiOperatorOperations, type AiOperatorTaskRow } from '../../db/schema/aiOperatorTasks';
import { actionIntents } from '../../db/schema/actionIntents';
import { aiOperatorPlanApprovalEffects, type AiOperatorEffectIdempotencyClass } from '../../db/schema/aiOperatorPlanApprovals';
import { aiOperatorTaskTargetAccounts, aiOperatorTaskTargets } from '../../db/schema/aiOperatorTaskGraph';
import { buildActionLabel } from '../actionIntents/actionLabel';
import { probeEffect, type EffectProbeResult } from './effectProbes';
import {
  checkPlanEffectMembershipSystem,
  closePendingPlan,
  effectArgumentDigest,
  planEffectOperationKey,
  proposePlanApproval,
  readPlanApprovalAtRevision,
  toDigestProjection,
  type PlanEffectLabels,
} from './planApproval';
import { appendTaskEvent } from './eventService';
import type { PlannedEffect, RecipeDefinition } from './recipes/types';
import type { TaskCheckpoint } from '@breeze/shared';

/** How often a task waiting on a plan decision or a child effect re-reads its rows. */
export const PLAN_POLL_WAKE_MS = 5 * 60 * 1000;

/**
 * Spec §6.6 per-action classification, stated next to the action. A tool
 * this table does not name is `non_idempotent` — the strictest class, so an
 * unclassified effect is never auto-retried and an unknown pre-state hands
 * off. M365 entries arrive with the M1 write catalog.
 */
const EFFECT_IDEMPOTENCY: Readonly<Record<string, AiOperatorEffectIdempotencyClass>> = Object.freeze({
  google_remove_from_group: 'idempotent',
  google_remove_license: 'idempotent',
  google_suspend_user: 'idempotent',
  google_signout: 'idempotent',
  google_set_vacation: 'idempotent_by_probe',
  google_set_forwarding: 'idempotent_by_probe',
  google_add_mail_delegate: 'idempotent_by_probe',
});

export function classifyEffectIdempotency(toolName: string): AiOperatorEffectIdempotencyClass {
  return EFFECT_IDEMPOTENCY[toolName] ?? 'non_idempotent';
}

// ---------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------

export type EffectStepDirective =
  | { action: 'wait'; reason: 'approval' | 'execution'; dependency: { kind: 'intent'; id: string } | null; wakeAfterMs: number; detail: string }
  | { action: 'settle'; event: 'complete' | 'partial' | 'hand_off' | 'fail'; outcome: 'verified_resolved' | 'unresolved' | 'unknown_effect'; detail: string; handoffSummary?: string }
  | { action: 'move'; toStepKey: string; settledDetail: string; resolvedDetail: string };

const handOff = (outcome: 'unresolved' | 'unknown_effect', detail: string, handoffSummary: string): EffectStepDirective =>
  ({ action: 'settle', event: 'hand_off', outcome, detail, handoffSummary });

// ---------------------------------------------------------------------------
// Per-effect halves
// ---------------------------------------------------------------------------

export type EffectDispatchOutcome =
  | { kind: 'noop'; detail: string }
  | { kind: 'dispatching'; intentId: string; detail: string }
  | { kind: 'refused'; refusal: string; detail: string }
  | { kind: 'handoff'; detail: string; handoffSummary: string };

/**
 * One effect of an APPROVED plan: membership → pre-probe → noop or mint.
 * `approverUserId` is the plan's approver read from the approval row; the
 * child is minted AS them (D-E4-2) — `createActionIntent` re-proves it.
 */
export async function dispatchPlannedEffect(args: {
  task: Pick<AiOperatorTaskRow, 'id' | 'orgId' | 'attemptOrdinal'>;
  stepKey: string;
  approval: { id: string; planRevision: number; approverUserId: string };
  effect: PlannedEffect;
  partnerId: string | null;
  now?: Date;
}): Promise<EffectDispatchOutcome> {
  const { task, stepKey, approval, effect } = args;
  const now = args.now ?? new Date();
  const argumentDigest = effectArgumentDigest(effect);
  const operationKey = planEffectOperationKey({
    stepKey, planRevision: approval.planRevision, toolName: effect.toolName,
    targetId: effect.targetId, ordinal: effect.ordinal,
  });

  // 1. Membership first — a superseded plan costs one local read, never a
  //    provider round trip.
  const membership = await checkPlanEffectMembershipSystem({
    orgId: task.orgId, taskId: task.id, ordinal: effect.ordinal, toolName: effect.toolName,
    argumentDigest, taskStepKey: stepKey, operationKey, approvalId: approval.id,
  });
  if (!membership.ok) return { kind: 'refused', refusal: membership.refusal, detail: membership.detail };

  // 2. Pre-probe.
  const pre = await probeEffect(effect, {
    orgId: task.orgId, taskId: task.id, planRevision: approval.planRevision,
    effectRequestedAt: now, phase: 'pre',
  });
  if (membership.idempotencyClass === 'non_idempotent' && pre.state !== 'unsatisfied') {
    return {
      kind: 'handoff',
      detail: `pre-probe for ${effect.toolName} was ${pre.state}: ${pre.detail}`,
      handoffSummary:
        `Breeze did not run ${effect.toolName} because it cannot be safely repeated and its current state `
        + `could not be confirmed as not-yet-done (${pre.state}). Nothing was sent for this step. `
        + 'Check the provider and complete it by hand if it is still needed.',
    };
  }
  if (pre.state === 'satisfied') {
    await recordNoopOperation({
      orgId: task.orgId, taskId: task.id, stepKey, operationKey, attemptOrdinal: task.attemptOrdinal,
      argumentDigest, planRevision: approval.planRevision, probe: pre,
    });
    return { kind: 'noop', detail: `already in the desired state: ${pre.detail}` };
  }

  // 3. Mint the child as the plan's approver. createActionIntent reserves the
  //    operation in the same transaction, so at-most-once comes from the
  //    permanent (org, task, operation_key) index.
  const { buildTaskActorAuthContext } = await import('../actionIntents/actorContext');
  const approverAuth = await buildTaskActorAuthContext({
    orgId: task.orgId, partnerId: args.partnerId, userId: membership.approverUserId,
  });
  if (!approverAuth) {
    return {
      kind: 'refused', refusal: 'approver_invalid',
      detail: 'the plan approver is inactive or can no longer reach this organization',
    };
  }
  try {
    const { createActionIntent } = await import('../actionIntents/intentService');
    const snap = await createActionIntent(approverAuth, {
      toolName: effect.toolName,
      input: effect.canonicalArguments as Record<string, unknown>,
      source: 'mcp_api',
      orgId: task.orgId,
      requestingClientLabel: 'AI Operator',
      task: { taskId: task.id, taskStepKey: stepKey, operationKey, attemptOrdinal: task.attemptOrdinal },
      planApproval: { approvalId: approval.id, ordinal: effect.ordinal },
    });
    return { kind: 'dispatching', intentId: snap.id, detail: `dispatching ${effect.toolName} (ordinal ${effect.ordinal})` };
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'mint_failed';
    return { kind: 'refused', refusal: code, detail: err instanceof Error ? err.message : String(err) };
  }
}

export type EffectVerificationOutcome =
  | { kind: 'verified'; detail: string }
  | { kind: 'unverified'; detail: string; retryable: boolean }
  | { kind: 'handoff'; detail: string; handoffSummary: string };

/** The post-probe, as a pure classifier over one `probeEffect` call. */
export async function verifyDispatchedEffect(args: {
  task: Pick<AiOperatorTaskRow, 'id' | 'orgId'>;
  planRevision: number;
  effect: PlannedEffect;
  idempotencyClass: AiOperatorEffectIdempotencyClass;
  effectRequestedAt: Date;
}): Promise<EffectVerificationOutcome> {
  const probe = await probeEffect(args.effect, {
    orgId: args.task.orgId, taskId: args.task.id, planRevision: args.planRevision,
    effectRequestedAt: args.effectRequestedAt, phase: 'post',
  });
  switch (probe.state) {
    case 'satisfied':
      return { kind: 'verified', detail: probe.detail };
    case 'unsatisfied':
      // Never `verified` (Operator spec §13). Retry is permitted only for an
      // effect classified safe to re-send.
      return { kind: 'unverified', detail: probe.detail, retryable: args.idempotencyClass !== 'non_idempotent' };
    default:
      return {
        kind: 'handoff',
        detail: probe.detail,
        handoffSummary:
          `Breeze could not confirm the result of ${args.effect.toolName} on `
          + `${args.effect.accountExternalId ?? args.effect.targetId ?? 'the target'}. `
          + 'It may or may not have been applied. Check the provider before retrying.',
      };
  }
}

// ---------------------------------------------------------------------------
// Operation-row writes (plan content side; never the task row)
// ---------------------------------------------------------------------------

async function recordNoopOperation(args: {
  orgId: string; taskId: string; stepKey: string; operationKey: string; attemptOrdinal: number;
  argumentDigest: string; planRevision: number; probe: EffectProbeResult;
}): Promise<void> {
  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    // No intent: nothing is dispatched. ON CONFLICT DO NOTHING on the
    // permanent (org, task, operation_key) unique — a replayed tick converges
    // on the first observation instead of rewriting it.
    const inserted = await db
      .insert(aiOperatorOperations)
      .values({
        orgId: args.orgId,
        taskId: args.taskId,
        taskStepKey: args.stepKey,
        operationKey: args.operationKey,
        attemptOrdinal: args.attemptOrdinal,
        intentId: null,
        originatingRunId: null,
        argumentDigest: args.argumentDigest,
        planRevision: args.planRevision,
        dispatchState: 'reserved',
        resultState: 'succeeded',
        result: {
          noop: true,
          probe: { state: args.probe.state, detail: args.probe.detail, observedAt: args.probe.observedAt.toISOString() },
        },
        resultAt: new Date(),
      })
      .onConflictDoNothing({
        target: [aiOperatorOperations.orgId, aiOperatorOperations.taskId, aiOperatorOperations.operationKey],
      })
      .returning({ id: aiOperatorOperations.id });
    if (inserted.length === 1) {
      await appendTaskEvent(db, {
        orgId: args.orgId, taskId: args.taskId, eventType: 'operation_settled', actor: { kind: 'coordinator' },
        stepKey: args.stepKey, targetId: null,
        detail: `${args.operationKey}: already in the desired state, nothing sent (${args.probe.detail})`.slice(0, 1000),
      });
    }
  }));
}

async function recordVerification(args: {
  orgId: string; taskId: string; stepKey: string; operationId: string; operationKey: string; verified: boolean; detail: string;
}): Promise<void> {
  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const stamp = JSON.stringify({ verified: { ok: args.verified, detail: args.detail.slice(0, 500), at: new Date().toISOString() } });
    await db
      .update(aiOperatorOperations)
      .set({ result: sql`${aiOperatorOperations.result} || ${stamp}::jsonb`, updatedAt: new Date() })
      .where(and(eq(aiOperatorOperations.id, args.operationId), eq(aiOperatorOperations.orgId, args.orgId)));
    await appendTaskEvent(db, {
      orgId: args.orgId, taskId: args.taskId, eventType: 'verification_recorded', actor: { kind: 'coordinator' },
      stepKey: args.stepKey, targetId: null,
      detail: `${args.operationKey}: ${args.verified ? 'verified' : 'not verified'} — ${args.detail}`.slice(0, 1000),
    });
  }));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface EffectProgress {
  operationId: string;
  resultState: string;
  noop: boolean;
  verified: boolean | null;
  intentId: string | null;
  intentStatus: string | null;
  dispatchedAt: Date | null;
}

async function readEffectProgress(orgId: string, taskId: string, keys: string[]): Promise<Map<string, EffectProgress>> {
  if (keys.length === 0) return new Map();
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const ops = await db
      .select({
        id: aiOperatorOperations.id,
        operationKey: aiOperatorOperations.operationKey,
        resultState: aiOperatorOperations.resultState,
        result: aiOperatorOperations.result,
        intentId: aiOperatorOperations.intentId,
        dispatchedAt: aiOperatorOperations.dispatchedAt,
      })
      .from(aiOperatorOperations)
      .where(and(
        eq(aiOperatorOperations.orgId, orgId),
        eq(aiOperatorOperations.taskId, taskId),
        inArray(aiOperatorOperations.operationKey, keys),
      ));
    const intentIds = ops.map((o) => o.intentId).filter((v): v is string => !!v);
    const statuses = new Map<string, string>();
    if (intentIds.length > 0) {
      const rows = await db
        .select({ id: actionIntents.id, status: actionIntents.status })
        .from(actionIntents)
        .where(and(eq(actionIntents.orgId, orgId), inArray(actionIntents.id, intentIds)));
      for (const r of rows) statuses.set(r.id, r.status);
    }
    const out = new Map<string, EffectProgress>();
    for (const o of ops) {
      const result = (o.result ?? {}) as { noop?: unknown; verified?: { ok?: unknown } };
      out.set(o.operationKey, {
        operationId: o.id,
        resultState: o.resultState,
        noop: result.noop === true,
        verified: typeof result.verified?.ok === 'boolean' ? (result.verified.ok as boolean) : null,
        intentId: o.intentId,
        intentStatus: o.intentId ? statuses.get(o.intentId) ?? null : null,
        dispatchedAt: o.dispatchedAt,
      });
    }
    return out;
  }));
}

async function readPlanLabels(
  orgId: string, taskId: string, effects: readonly PlannedEffect[],
): Promise<{ labels: Map<number, PlanEffectLabels>; partnerId: string | null }> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const targetIds = [...new Set(effects.map((e) => e.targetId).filter((v): v is string => !!v))];
    const targets = targetIds.length === 0 ? [] : await db
      .select({ id: aiOperatorTaskTargets.id, label: aiOperatorTaskTargets.targetLabel })
      .from(aiOperatorTaskTargets)
      .where(and(eq(aiOperatorTaskTargets.orgId, orgId), eq(aiOperatorTaskTargets.taskId, taskId), inArray(aiOperatorTaskTargets.id, targetIds)));
    const accounts = await db
      .select({ externalId: aiOperatorTaskTargetAccounts.externalId, principalLabel: aiOperatorTaskTargetAccounts.principalLabel })
      .from(aiOperatorTaskTargetAccounts)
      .where(and(eq(aiOperatorTaskTargetAccounts.orgId, orgId), eq(aiOperatorTaskTargetAccounts.taskId, taskId)));
    const { organizations } = await import('../../db/schema/orgs');
    const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
    const targetLabel = new Map(targets.map((t) => [t.id, t.label]));
    const principal = new Map(accounts.map((a) => [a.externalId, a.principalLabel]));
    const labels = new Map<number, PlanEffectLabels>();
    for (const e of effects) {
      labels.set(e.ordinal, {
        // FROZEN labels: what the approver reads is what is stored.
        targetLabel: (e.targetId && targetLabel.get(e.targetId)) || 'Task target',
        principalLabel: e.accountExternalId ? principal.get(e.accountExternalId) ?? e.accountExternalId : null,
        rendering: buildActionLabel({ toolName: e.toolName, input: e.canonicalArguments as Record<string, unknown>, reason: null, deviceHostname: null }),
      });
    }
    return { labels, partnerId: org?.partnerId ?? null };
  }));
}

async function readIntentStatus(orgId: string, intentId: string): Promise<string | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({ status: actionIntents.status })
      .from(actionIntents)
      .where(and(eq(actionIntents.id, intentId), eq(actionIntents.orgId, orgId)))
      .limit(1);
    return row?.status ?? null;
  }));
}

async function readApprovalIdempotency(orgId: string, approvalId: string): Promise<Map<number, AiOperatorEffectIdempotencyClass>> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db
      .select({ ordinal: aiOperatorPlanApprovalEffects.ordinal, idempotencyClass: aiOperatorPlanApprovalEffects.idempotencyClass })
      .from(aiOperatorPlanApprovalEffects)
      .where(and(eq(aiOperatorPlanApprovalEffects.orgId, orgId), eq(aiOperatorPlanApprovalEffects.approvalId, approvalId)));
    return new Map(rows.map((r) => [r.ordinal, r.idempotencyClass]));
  }));
}

// ---------------------------------------------------------------------------
// The `effect` step: propose → approval → each effect in order → done
// ---------------------------------------------------------------------------

function buildRecipePlan(recipe: RecipeDefinition<never>, checkpoint: TaskCheckpoint):
  { ok: true; effects: PlannedEffect[] } | { ok: false; detail: string } {
  try {
    const effects = recipe.buildPlan(checkpoint.recipeInput as never, {});
    return { ok: true, effects: [...effects].sort((a, b) => a.ordinal - b.ordinal) };
  } catch (err) {
    return { ok: false, detail: `buildPlan threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function remainingSummary(effects: readonly PlannedEffect[], fromOrdinal: number): string {
  const rest = effects.filter((e) => e.ordinal >= fromOrdinal).map((e) => e.toolName);
  return rest.length === 0 ? 'No further effects were planned.' : `Not done by Breeze: ${rest.join(', ')}.`;
}

export async function planEffectStep(args: {
  task: AiOperatorTaskRow;
  recipe: RecipeDefinition<never>;
  checkpoint: TaskCheckpoint;
  now: Date;
}): Promise<EffectStepDirective> {
  const { task, recipe, checkpoint, now } = args;
  const stepKey = task.currentStepKey ?? '';

  const built = buildRecipePlan(recipe, checkpoint);
  if (!built.ok) return { action: 'settle', event: 'fail', outcome: 'unresolved', detail: built.detail };
  const effects = built.effects;

  const finish = (detail: string): EffectStepDirective => {
    const resume = checkpoint.resumeStepKey;
    if (resume && recipe.steps[resume]) {
      return { action: 'move', toStepKey: resume, settledDetail: detail, resolvedDetail: `effects of '${stepKey}' complete` };
    }
    return { action: 'settle', event: 'complete', outcome: 'verified_resolved', detail };
  };
  if (effects.length === 0) return finish('the plan produced no effects');

  let approval = await readPlanApprovalAtRevision(task.orgId, task.id, task.revision);

  // ── No plan yet: propose it, then wait for the four-eyes decision. ──────
  if (!approval || (approval.state === 'pending' && !approval.intentId)) {
    const { labels, partnerId } = await readPlanLabels(task.orgId, task.id, effects);
    void partnerId;
    const proposed = await proposePlanApproval({
      orgId: task.orgId, taskId: task.id, stepKey, planRevision: task.revision,
      requesterUserId: task.requesterUserId ?? null,
      effects, labels,
      idempotencyClasses: new Map(effects.map((e) => [e.ordinal, classifyEffectIdempotency(e.toolName)])),
    });
    if (!proposed.ok) {
      return handOff('unresolved', `plan approval could not be requested: ${proposed.reason} (${proposed.detail})`,
        `Breeze prepared a plan but could not request approval for it (${proposed.detail}). `
        + 'Nothing was changed. Review the plan and complete it by hand, or start a new task.');
    }
    return {
      action: 'wait', reason: 'approval', dependency: { kind: 'intent', id: proposed.intentId },
      wakeAfterMs: PLAN_POLL_WAKE_MS,
      detail: `plan revision ${task.revision} (${proposed.effectCount} effect(s)) awaiting four-eyes approval`,
    };
  }

  // The approved seal must still describe what buildPlan produces now.
  const sealNow = computeEffectSetDigest({ taskId: task.id, planRevision: task.revision, effects: toDigestProjection(effects) });
  if (sealNow !== approval.effectSetDigest) {
    return handOff('unresolved', 'the plan changed under its approval',
      'The plan Breeze would run no longer matches the one that was approved. Nothing further was changed. '
      + 'A new approval is required.');
  }

  if (approval.state === 'pending') {
    const status = await readIntentStatus(task.orgId, approval.intentId!);
    if (status === 'pending_approval' || status === 'approved' || status === 'executing') {
      return {
        action: 'wait', reason: 'approval', dependency: { kind: 'intent', id: approval.intentId! },
        wakeAfterMs: PLAN_POLL_WAKE_MS, detail: `plan revision ${task.revision} still awaiting approval (${status})`,
      };
    }
    // Terminal without the handler having approved the plan: rejected,
    // expired, cancelled, or the release itself failed closed.
    await closePendingPlan({ orgId: task.orgId, approvalId: approval.id, state: status === 'rejected' ? 'rejected' : 'expired' });
    return handOff('unresolved', `plan approval ended as ${status ?? 'missing'}`,
      `The plan for this task was not approved (${status ?? 'the request is gone'}). Nothing was changed.`);
  }
  if (approval.state !== 'approved' || !approval.approvedByUserId) {
    return handOff('unresolved', `the plan is ${approval.state}`,
      `The plan approval for this task is ${approval.state}. Nothing further was changed.`);
  }
  approval = approval as typeof approval & { approvedByUserId: string };

  // ── Approved: walk the effects in order. ─────────────────────────────────
  const keys = effects.map((e) => planEffectOperationKey({
    stepKey, planRevision: task.revision, toolName: e.toolName, targetId: e.targetId, ordinal: e.ordinal,
  }));
  const progress = await readEffectProgress(task.orgId, task.id, keys);
  const classes = await readApprovalIdempotency(task.orgId, approval.id);

  for (let i = 0; i < effects.length; i += 1) {
    const effect = effects[i]!;
    const key = keys[i]!;
    const p = progress.get(key);

    if (!p) {
      const { partnerId } = await readPlanLabels(task.orgId, task.id, []);
      const out = await dispatchPlannedEffect({
        task, stepKey, effect, partnerId, now,
        approval: { id: approval.id, planRevision: approval.planRevision, approverUserId: approval.approvedByUserId! },
      });
      if (out.kind === 'noop') continue; // observed done; move straight on
      if (out.kind === 'dispatching') {
        return {
          action: 'wait', reason: 'execution', dependency: { kind: 'intent', id: out.intentId },
          wakeAfterMs: PLAN_POLL_WAKE_MS, detail: out.detail,
        };
      }
      if (out.kind === 'handoff') {
        return handOff('unresolved', out.detail, `${out.handoffSummary} ${remainingSummary(effects, effect.ordinal)}`);
      }
      return handOff('unresolved', `effect ${effect.ordinal} refused: ${out.refusal} (${out.detail})`,
        `Breeze stopped before ${effect.toolName} because its approval no longer holds (${out.refusal}). `
        + remainingSummary(effects, effect.ordinal));
    }

    if (p.noop || p.verified === true) continue;

    if (p.resultState === 'pending') {
      const live = p.intentStatus === 'approved' || p.intentStatus === 'executing' || p.intentStatus === 'pending_approval';
      if (live && p.intentId) {
        return {
          action: 'wait', reason: 'execution', dependency: { kind: 'intent', id: p.intentId },
          wakeAfterMs: PLAN_POLL_WAKE_MS, detail: `${effect.toolName} (ordinal ${effect.ordinal}) still executing`,
        };
      }
      return handOff(p.dispatchedAt ? 'unknown_effect' : 'unresolved',
        `${effect.toolName} (ordinal ${effect.ordinal}) ended as ${p.intentStatus ?? 'unknown'} without a result`,
        `${effect.toolName} did not complete (${p.intentStatus ?? 'unknown'}). `
        + `${p.dispatchedAt ? 'It may or may not have been applied; check the provider. ' : ''}`
        + remainingSummary(effects, effect.ordinal));
    }
    if (p.resultState !== 'succeeded') {
      return handOff(p.resultState === 'unknown' ? 'unknown_effect' : 'unresolved',
        `${effect.toolName} (ordinal ${effect.ordinal}) result ${p.resultState}`,
        `${effect.toolName} reported ${p.resultState}. ${remainingSummary(effects, effect.ordinal)}`);
    }

    // Write reported success: success of the call never implies success of
    // the effect — the post-probe is the verification adapter.
    const verdict = await verifyDispatchedEffect({
      task, planRevision: task.revision, effect,
      idempotencyClass: classes.get(effect.ordinal) ?? 'non_idempotent',
      effectRequestedAt: p.dispatchedAt ?? now,
    });
    await recordVerification({
      orgId: task.orgId, taskId: task.id, stepKey, operationId: p.operationId, operationKey: key,
      verified: verdict.kind === 'verified', detail: verdict.detail,
    });
    if (verdict.kind === 'verified') continue;
    if (verdict.kind === 'handoff') {
      return handOff('unknown_effect', verdict.detail, `${verdict.handoffSummary} ${remainingSummary(effects, effect.ordinal + 1)}`);
    }
    return handOff('unresolved', `${effect.toolName} not verified: ${verdict.detail}`,
      `${effect.toolName} ran but its result could not be confirmed (${verdict.detail}). `
      + `Breeze did not retry it. ${remainingSummary(effects, effect.ordinal + 1)}`);
  }

  return finish(`all ${effects.length} effect(s) of plan revision ${task.revision} done and observed`);
}

// ---------------------------------------------------------------------------
// The `probe` step: re-run the verification adapter over the approved set
// ---------------------------------------------------------------------------

export async function planProbeStep(args: {
  task: AiOperatorTaskRow;
  recipe: RecipeDefinition<never>;
  checkpoint: TaskCheckpoint;
  now: Date;
}): Promise<EffectStepDirective> {
  const { task, recipe, checkpoint, now } = args;
  const stepKey = task.currentStepKey ?? '';
  const built = buildRecipePlan(recipe, checkpoint);
  if (!built.ok) return { action: 'settle', event: 'fail', outcome: 'unresolved', detail: built.detail };

  const unconfirmed: string[] = [];
  for (const effect of built.effects) {
    const probe = await probeEffect(effect, {
      orgId: task.orgId, taskId: task.id, planRevision: task.revision, effectRequestedAt: now, phase: 'post',
    });
    if (probe.state !== 'satisfied') unconfirmed.push(`${effect.toolName} (${probe.state})`);
  }
  const detail = unconfirmed.length === 0
    ? `all ${built.effects.length} effect(s) observed in their end state`
    : `unconfirmed: ${unconfirmed.join(', ')}`;
  if (unconfirmed.length > 0) {
    return handOff('unresolved', detail,
      `Breeze could not confirm every outcome: ${unconfirmed.join(', ')}. Check these by hand.`);
  }
  const resume = checkpoint.resumeStepKey;
  if (resume && recipe.steps[resume]) {
    return { action: 'move', toStepKey: resume, settledDetail: detail, resolvedDetail: `verification '${stepKey}' passed` };
  }
  return { action: 'settle', event: 'complete', outcome: 'verified_resolved', detail };
}
