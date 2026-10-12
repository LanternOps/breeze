/**
 * Plan approval — Operator Recipe Library spec §6.4, wave E4 (#6169).
 *
 * ONE four-eyes decision authorizes an ordered, digest-pinned SET of provider
 * effects. This module is the whole primitive, and it deliberately owns NO
 * decision path of its own:
 *
 *  - The decision is ONE ordinary action intent (tool `operator_plan`) minted
 *    through `createActionIntent` and decided on the existing approval_requests
 *    flow (`decideApprovalRequest`) — requester-cannot-self-approve, the
 *    sole-operator step-up and expiry are inherited unchanged.
 *  - Each approved effect is then minted as its own ordinary action intent,
 *    `decided_via = 'plan_approval'`, and released by the durable release
 *    worker only if `checkPlanEffectMembership` — the ONE predicate below —
 *    still holds against ROWS, read at release.
 *
 * The rows (`ai_operator_plan_approvals` + `_effects`) are plan CONTENT. They
 * are written BEFORE the plan intent is minted so that the intent's
 * effect-digest resolver (EFFECT_DIGEST_RESOLVERS.operator_plan) pins a
 * digest over rows that already exist — `action_intents.effect_digest` is
 * immutable after insert, so the order cannot be reversed — and the link
 * (`intent_id`) is stamped once, afterwards, or by the approval CAS itself
 * when the release outran that stamp.
 *
 * NOT `admitReasoningRun`'s `bumpPlanRevision: boolean`. The exported
 * `bumpPlanRevision()` here is a separate function that supersedes a plan.
 */
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  canonicalizeEffectSet,
  computeEffectSetDigest,
  type PlannedEffectForDigest,
} from '@breeze/shared/canonicalize/effectSet';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  aiOperatorPlanApprovalEffects,
  aiOperatorPlanApprovals,
  type AiOperatorEffectIdempotencyClass,
  type AiOperatorPlanApprovalRow,
} from '../../db/schema/aiOperatorPlanApprovals';
import { aiOperatorOperations, aiOperatorTasks } from '../../db/schema/aiOperatorTasks';
import { actionIntents } from '../../db/schema/actionIntents';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { canonicalizeArguments, computeArgumentDigest } from '../actionIntents/canonicalize';
import { isSecretBearingTool } from '../actionIntents/secretBearingTools';
import { buildTaskOperationKey } from './operationKey';
import { enqueueTaskOutbox, INTENT_TERMINAL_OUTBOX_TRANSITION_SEQ } from './taskOutbox';
import { appendTaskEvent } from './eventService';
import type { PlannedEffect } from './recipes/types';

export type PlanDbHandle = Pick<typeof db, 'insert' | 'update' | 'select'>;

/** The tool name of the single intent that carries a plan approval. */
export const OPERATOR_PLAN_TOOL = 'operator_plan';

/** Mirrors `ai_operator_plan_approvals_effect_count_chk`. */
export const MAX_PLAN_EFFECTS = 64;

// ---------------------------------------------------------------------------
// Pure halves
// ---------------------------------------------------------------------------

/**
 * The per-effect digest. MUST be the value `action_intents.argument_digest`
 * will carry for that effect's child intent: the release-time membership key
 * reads the digest off the INTENT, so a second canonicalizer here would turn
 * membership into a self-consistency check.
 */
export function effectArgumentDigest(effect: Pick<PlannedEffect, 'canonicalArguments'>): string {
  return computeArgumentDigest(
    canonicalizeArguments(effect.canonicalArguments as Record<string, unknown>),
  );
}

/** The six sealed fields, in effect order. */
export function toDigestProjection(effects: readonly PlannedEffect[]): PlannedEffectForDigest[] {
  return effects.map((e) => ({
    ordinal: e.ordinal,
    toolName: e.toolName,
    provider: e.provider,
    targetId: e.targetId,
    accountExternalId: e.accountExternalId,
    argumentDigest: effectArgumentDigest(e),
  }));
}

/** Same projection, from stored rows — the release-time recomputation. */
export function rowsToDigestProjection(rows: ReadonlyArray<{
  ordinal: number; toolName: string; provider: string; targetId: string | null;
  accountExternalId: string | null; argumentDigest: string;
}>): PlannedEffectForDigest[] {
  return rows.map((r) => ({
    ordinal: r.ordinal,
    toolName: r.toolName,
    provider: r.provider as PlannedEffectForDigest['provider'],
    targetId: r.targetId,
    accountExternalId: r.accountExternalId,
    argumentDigest: r.argumentDigest,
  }));
}

/**
 * The operation key a child effect of this plan MUST carry. Membership alone
 * does not bind the dispatch identity (codex quorum): two keys differing only
 * in their step or target segment would be two operations for one approved
 * slot. Child mint and release both compare against exactly this string.
 */
export function planEffectOperationKey(args: {
  stepKey: string; planRevision: number; toolName: string; targetId: string | null; ordinal: number;
}): string {
  return buildTaskOperationKey({
    taskStepKey: args.stepKey,
    planRevision: args.planRevision,
    toolName: args.toolName,
    targetId: args.targetId,
    ordinal: args.ordinal,
  });
}

/**
 * Allowlist match, identical to `checkAgentGuardrails`' own
 * (`aiGuardrails.ts`: the bare tool name, or `tool:action` for an
 * action-dispatched tool).
 */
export function allowlistPermits(
  allowlist: readonly string[],
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): boolean {
  const action = typeof args.action === 'string' ? args.action : undefined;
  return allowlist.includes(toolName)
    || (action !== undefined && allowlist.includes(`${toolName}:${action}`));
}

// ---------------------------------------------------------------------------
// The allowlist ceiling (spec §6.4 closing paragraph)
// ---------------------------------------------------------------------------

export interface TaskAgentAllowlists {
  /** The admitting run's frozen snapshot allowlist; null when none recorded. */
  snapshot: string[] | null;
  /** The agent kind's CURRENT effective allowlist; null when no live agent. */
  live: string[] | null;
}

function readAllowlist(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return null;
  return value as string[];
}

/**
 * The two allowlists the ceiling intersects. FROZEN = the earliest
 * task-linked run's policy snapshot (deterministic: queued_at, then id), so a
 * policy WIDENED after admission cannot authorize an effect; LIVE = the agent
 * kind's current effective policy, so a policy NARROWED after approval
 * revokes. Same snapshot ∩ live shape `checkAgentReleaseAuthority` applies to
 * ordinary agent intents. Runs in its own system context.
 */
export async function loadTaskAgentToolAllowlists(orgId: string, taskId: string): Promise<TaskAgentAllowlists> {
  const { resolveEffectiveAgentSystem } = await import('../aiAgents/effectivePolicy');
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [task] = await db
      .select({ agentKind: aiOperatorTasks.agentKind })
      .from(aiOperatorTasks)
      .where(and(eq(aiOperatorTasks.id, taskId), eq(aiOperatorTasks.orgId, orgId)))
      .limit(1);
    if (!task) return { snapshot: null, live: null };
    const [run] = await db
      .select({ policySnapshot: aiAgentRuns.policySnapshot })
      .from(aiAgentRuns)
      .where(and(eq(aiAgentRuns.orgId, orgId), eq(aiAgentRuns.taskId, taskId)))
      .orderBy(asc(aiAgentRuns.queuedAt), asc(aiAgentRuns.id))
      .limit(1);
    const snapshot = readAllowlist(
      (run?.policySnapshot as { effective?: { toolAllowlist?: unknown } } | undefined)?.effective?.toolAllowlist,
    );
    let live: string[] | null = null;
    try {
      const resolved = await resolveEffectiveAgentSystem(orgId, task.agentKind as never);
      // A disabled agent grants nothing; fail closed exactly like a missing one.
      live = resolved && resolved.effective?.enabled !== false
        ? readAllowlist(resolved.effective?.toolAllowlist)
        : null;
    } catch {
      live = null;
    }
    return { snapshot, live };
  }));
}

export type CeilingRefusal = { ok: false; detail: string } | { ok: true };

/** Fail closed: a missing snapshot or a missing live agent refuses. */
export function checkToolCeiling(
  lists: TaskAgentAllowlists,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): CeilingRefusal {
  if (!lists.snapshot) return { ok: false, detail: 'the task records no admitting policy snapshot' };
  if (!lists.live) return { ok: false, detail: 'the task\'s agent has no current effective policy' };
  if (!allowlistPermits(lists.snapshot, toolName, args)) {
    return { ok: false, detail: `${toolName} is not in the admitting policy snapshot's allowlist` };
  }
  if (!allowlistPermits(lists.live, toolName, args)) {
    return { ok: false, detail: `${toolName} is not in the agent's current allowlist` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// THE membership predicate
// ---------------------------------------------------------------------------

export type PlanMembershipRefusal =
  | 'plan_approval_missing' | 'plan_not_approved' | 'plan_superseded' | 'plan_expired'
  | 'revision_moved' | 'approval_mismatch' | 'effect_not_in_set' | 'tool_not_in_set'
  | 'argument_digest_mismatch' | 'effect_count_mismatch' | 'effect_set_digest_mismatch'
  | 'operation_identity_mismatch';

export type PlanMembershipResult =
  | {
      ok: true;
      approvalId: string;
      approverUserId: string;
      approvedAssuranceLevel: number | null;
      planRevision: number;
      idempotencyClass: AiOperatorEffectIdempotencyClass;
    }
  | { ok: false; refusal: PlanMembershipRefusal; detail: string };

export interface PlanMembershipInput {
  orgId: string;
  taskId: string;
  ordinal: number;
  toolName: string;
  argumentDigest: string;
  /** The child intent's task step key and operation key, both REQUIRED to match. */
  taskStepKey: string;
  operationKey: string;
  /** When the caller names an approval (mint), it must be the one membership finds. */
  approvalId?: string;
}

/**
 * Is this effect a member of an APPROVED plan at the task's LIVE revision?
 *
 * Reads, never trusts: the task's current `revision` (supersession is judged
 * by the task, not the approval row's state — spec §6.4), the approval row at
 * that revision, the effect row at `(task, revision, ordinal)`, and the whole
 * set — recomputing `effect_set_digest` from the rows, so a DELETE+INSERT
 * replacement at the same ordinal is caught even though it preserves the
 * count. Refuses in a fixed order. Performs NO writes; pass the caller's
 * transaction handle to join it.
 */
export async function checkPlanEffectMembership(
  dbh: PlanDbHandle,
  input: PlanMembershipInput,
): Promise<PlanMembershipResult> {
  const refuse = (refusal: PlanMembershipRefusal, detail: string): PlanMembershipResult =>
    ({ ok: false, refusal, detail });

  const [task] = await dbh
    .select({ revision: aiOperatorTasks.revision })
    .from(aiOperatorTasks)
    .where(and(eq(aiOperatorTasks.id, input.taskId), eq(aiOperatorTasks.orgId, input.orgId)))
    .limit(1);
  if (!task) return refuse('plan_approval_missing', 'the task is not visible in this organization');

  // The approval the effect claims (by id when named, else the live
  // revision's). Read independently of the revision so a superseded plan is
  // reported as superseded, not as missing.
  const approvalWhere = input.approvalId
    ? and(
        eq(aiOperatorPlanApprovals.id, input.approvalId),
        eq(aiOperatorPlanApprovals.orgId, input.orgId),
        eq(aiOperatorPlanApprovals.taskId, input.taskId),
      )
    : and(
        eq(aiOperatorPlanApprovals.orgId, input.orgId),
        eq(aiOperatorPlanApprovals.taskId, input.taskId),
        eq(aiOperatorPlanApprovals.planRevision, task.revision),
      );
  const [approval] = await dbh
    .select()
    .from(aiOperatorPlanApprovals)
    .where(approvalWhere)
    .limit(1);
  if (!approval) return refuse('plan_approval_missing', 'no plan approval exists for this task revision');

  if (approval.state === 'superseded') {
    return refuse('plan_superseded', `superseded by revision ${approval.supersededByRevision ?? '?'}`);
  }
  if (approval.state === 'expired') return refuse('plan_expired', 'the plan approval expired');
  if (approval.state !== 'approved' || !approval.approvedByUserId) {
    return refuse('plan_not_approved', `the plan is ${approval.state}`);
  }
  if (approval.planRevision !== task.revision) {
    return refuse('revision_moved', `task is at revision ${task.revision}, plan is ${approval.planRevision}`);
  }

  const setRows = await dbh
    .select({
      ordinal: aiOperatorPlanApprovalEffects.ordinal,
      toolName: aiOperatorPlanApprovalEffects.toolName,
      provider: aiOperatorPlanApprovalEffects.provider,
      targetId: aiOperatorPlanApprovalEffects.targetId,
      accountExternalId: aiOperatorPlanApprovalEffects.accountExternalId,
      argumentDigest: aiOperatorPlanApprovalEffects.argumentDigest,
      idempotencyClass: aiOperatorPlanApprovalEffects.idempotencyClass,
      approvalId: aiOperatorPlanApprovalEffects.approvalId,
    })
    .from(aiOperatorPlanApprovalEffects)
    .where(and(
      eq(aiOperatorPlanApprovalEffects.orgId, input.orgId),
      eq(aiOperatorPlanApprovalEffects.taskId, input.taskId),
      eq(aiOperatorPlanApprovalEffects.planRevision, approval.planRevision),
    ))
    .orderBy(asc(aiOperatorPlanApprovalEffects.ordinal));

  const effect = setRows.find((r) => r.ordinal === input.ordinal);
  if (!effect || effect.approvalId !== approval.id) {
    return refuse('effect_not_in_set', `ordinal ${input.ordinal} is not in the approved set`);
  }
  if (effect.toolName !== input.toolName) {
    return refuse('tool_not_in_set', `ordinal ${input.ordinal} approved ${effect.toolName}, not ${input.toolName}`);
  }
  if (effect.argumentDigest !== input.argumentDigest) {
    return refuse('argument_digest_mismatch', `ordinal ${input.ordinal} arguments differ from the approved ones`);
  }
  const expectedKey = planEffectOperationKey({
    stepKey: approval.stepKey, planRevision: approval.planRevision,
    toolName: effect.toolName, targetId: effect.targetId, ordinal: effect.ordinal,
  });
  if (input.taskStepKey !== approval.stepKey || input.operationKey !== expectedKey) {
    return refuse('operation_identity_mismatch', `ordinal ${input.ordinal} must dispatch as ${expectedKey}`);
  }
  if (setRows.length !== approval.effectCount || setRows.some((r) => r.approvalId !== approval.id)) {
    return refuse('effect_count_mismatch', `approved ${approval.effectCount} effects, found ${setRows.length}`);
  }
  let recomputed: string;
  try {
    recomputed = computeEffectSetDigest({
      taskId: input.taskId, planRevision: approval.planRevision, effects: rowsToDigestProjection(setRows),
    });
  } catch (err) {
    return refuse('effect_set_digest_mismatch', `the stored set is malformed: ${(err as Error).message}`);
  }
  if (recomputed !== approval.effectSetDigest) {
    return refuse('effect_set_digest_mismatch', 'the stored effect rows no longer match the approved seal');
  }

  return {
    ok: true,
    approvalId: approval.id,
    approverUserId: approval.approvedByUserId,
    approvedAssuranceLevel: approval.approvedAssuranceLevel ?? null,
    planRevision: approval.planRevision,
    idempotencyClass: effect.idempotencyClass,
  };
}

/** Runs the predicate in its own short system context (no ambient handle). */
export function checkPlanEffectMembershipSystem(input: PlanMembershipInput): Promise<PlanMembershipResult> {
  return runOutsideDbContext(() => withSystemDbAccessContext(() => checkPlanEffectMembership(db, input)));
}

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

export interface PlanEffectLabels {
  targetLabel: string;
  principalLabel: string | null;
  rendering: string;
}

export interface ProposePlanApprovalInput {
  orgId: string;
  taskId: string;
  stepKey: string;
  planRevision: number;
  requesterUserId: string | null;
  effects: readonly PlannedEffect[];
  labels: ReadonlyMap<number, PlanEffectLabels>;
  idempotencyClasses: ReadonlyMap<number, AiOperatorEffectIdempotencyClass>;
}

export type ProposePlanRefusal =
  | 'no_requester' | 'empty_plan' | 'too_many_effects' | 'secret_bearing_effect' | 'revision_moved'
  | 'tool_not_in_agent_allowlist' | 'malformed_plan' | 'requester_invalid' | 'mint_failed' | 'already_decided';

export type ProposePlanApprovalResult =
  | { ok: true; approvalId: string; intentId: string; effectSetDigest: string; effectCount: number }
  | { ok: false; reason: ProposePlanRefusal; detail: string };

/** The bounded rendering carried in the plan intent's arguments (the card). */
export interface OperatorPlanEffectRendering {
  ordinal: number;
  provider: PlannedEffect['provider'];
  toolName: string;
  targetLabel: string;
  principalLabel: string | null;
  rendering: string;
}

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/**
 * Write the plan rows, mint the `operator_plan` intent under the task's
 * REQUESTER (plan D-E4-2), then link them.
 *
 * Every refusal is a typed result, never a throw, so the coordinator settles
 * the task instead of retrying a wake against a plan that cannot be proposed.
 * Re-entrant: a re-run at the same revision reuses an unlinked pending row
 * whose digest matches, and the intent's explicit idempotency key converges
 * on the same live intent.
 */
export async function proposePlanApproval(input: ProposePlanApprovalInput): Promise<ProposePlanApprovalResult> {
  if (!input.requesterUserId) {
    return { ok: false, reason: 'no_requester', detail: 'a plan approval needs a named human requester' };
  }
  if (input.effects.length === 0) return { ok: false, reason: 'empty_plan', detail: 'the plan has no effects' };
  if (input.effects.length > MAX_PLAN_EFFECTS) {
    return { ok: false, reason: 'too_many_effects', detail: `at most ${MAX_PLAN_EFFECTS} effects per plan` };
  }
  // Spec §6.4: secret-bearing effects never ride a mixed plan. This wave
  // refuses them under a plan outright (the stricter rule); the R2 onboarding
  // wave narrows it to "mixed sets refused".
  const secret = input.effects.find((e) => isSecretBearingTool(e.toolName));
  if (secret) {
    return { ok: false, reason: 'secret_bearing_effect', detail: `${secret.toolName} mints a credential and cannot ride a plan approval` };
  }
  if (input.effects.some((e) => e.toolName === OPERATOR_PLAN_TOOL)) {
    return { ok: false, reason: 'malformed_plan', detail: 'a plan cannot contain another plan' };
  }
  for (const e of input.effects) {
    const label = input.labels.get(e.ordinal);
    if (!label || !input.idempotencyClasses.get(e.ordinal)) {
      return { ok: false, reason: 'malformed_plan', detail: `ordinal ${e.ordinal} has no label or idempotency class` };
    }
  }

  let effectSetDigest: string;
  try {
    effectSetDigest = computeEffectSetDigest({
      taskId: input.taskId, planRevision: input.planRevision, effects: toDigestProjection(input.effects),
    });
  } catch (err) {
    return { ok: false, reason: 'malformed_plan', detail: (err as Error).message };
  }

  // The ceiling, at proposal time, over every effect: a plan cannot bundle a
  // tool the admitting agent was never granted (a four-eyes bypass by
  // composition). Re-checked at the plan's release and at each child's.
  const lists = await loadTaskAgentToolAllowlists(input.orgId, input.taskId);
  for (const e of input.effects) {
    const ceiling = checkToolCeiling(lists, e.toolName, e.canonicalArguments);
    if (!ceiling.ok) return { ok: false, reason: 'tool_not_in_agent_allowlist', detail: ceiling.detail };
  }

  // tx1: the rows (or reuse an unlinked pending row from a crashed attempt).
  type Tx1 =
    | { ok: true; approvalId: string; linkedIntentId: string | null; partnerId: string | null }
    | { ok: false; reason: ProposePlanRefusal; detail: string };
  const tx1: Tx1 = await runOutsideDbContext(() => withSystemDbAccessContext(async (): Promise<Tx1> => {
    const [task] = await db
      .select({ revision: aiOperatorTasks.revision })
      .from(aiOperatorTasks)
      .where(and(eq(aiOperatorTasks.id, input.taskId), eq(aiOperatorTasks.orgId, input.orgId)))
      .for('update')
      .limit(1);
    if (!task || task.revision !== input.planRevision) {
      return { ok: false, reason: 'revision_moved', detail: `task is at revision ${task?.revision ?? '?'}` };
    }
    const { organizations } = await import('../../db/schema/orgs');
    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, input.orgId))
      .limit(1);

    const [existing] = await db
      .select()
      .from(aiOperatorPlanApprovals)
      .where(and(
        eq(aiOperatorPlanApprovals.orgId, input.orgId),
        eq(aiOperatorPlanApprovals.taskId, input.taskId),
        eq(aiOperatorPlanApprovals.planRevision, input.planRevision),
      ))
      .limit(1);
    if (existing) {
      if (existing.effectSetDigest !== effectSetDigest || existing.stepKey !== input.stepKey) {
        // A different plan at the same revision is a plan change that skipped
        // bumpPlanRevision. Refuse; never overwrite what an approver may see.
        return { ok: false, reason: 'revision_moved', detail: 'a different plan already exists at this revision' };
      }
      if (existing.state !== 'pending') {
        return { ok: false, reason: 'already_decided', detail: `the plan at this revision is ${existing.state}` };
      }
      return { ok: true, approvalId: existing.id, linkedIntentId: existing.intentId, partnerId: org?.partnerId ?? null };
    }

    const [row] = await db
      .insert(aiOperatorPlanApprovals)
      .values({
        orgId: input.orgId,
        taskId: input.taskId,
        stepKey: input.stepKey,
        planRevision: input.planRevision,
        effectSetDigest,
        effectCount: input.effects.length,
        intentId: null,
        state: 'pending',
      })
      .returning({ id: aiOperatorPlanApprovals.id });
    await db.insert(aiOperatorPlanApprovalEffects).values(input.effects.map((e) => {
      const label = input.labels.get(e.ordinal)!;
      return {
        orgId: input.orgId,
        approvalId: row!.id,
        taskId: input.taskId,
        planRevision: input.planRevision,
        ordinal: e.ordinal,
        toolName: e.toolName,
        provider: e.provider,
        targetId: e.targetId,
        accountExternalId: e.provider === 'breeze' ? null : e.accountExternalId,
        argumentDigest: effectArgumentDigest(e),
        targetLabel: clip(label.targetLabel, 200),
        principalLabel: label.principalLabel ? clip(label.principalLabel, 320) : null,
        rendering: clip(label.rendering, 500),
        idempotencyClass: input.idempotencyClasses.get(e.ordinal)!,
      };
    }));
    return { ok: true, approvalId: row!.id, linkedIntentId: null, partnerId: org?.partnerId ?? null };
  }));
  if (!tx1.ok) return tx1;
  if (tx1.linkedIntentId) {
    return {
      ok: true, approvalId: tx1.approvalId, intentId: tx1.linkedIntentId,
      effectSetDigest, effectCount: input.effects.length,
    };
  }

  // Mint under the REQUESTER (D-E4-2). No task context: the plan intent
  // reserves no operation and dispatches nothing.
  const { buildTaskActorAuthContext } = await import('../actionIntents/actorContext');
  const requesterAuth = await buildTaskActorAuthContext({
    orgId: input.orgId, partnerId: tx1.partnerId, userId: input.requesterUserId,
  });
  if (!requesterAuth) {
    return { ok: false, reason: 'requester_invalid', detail: 'the task requester is inactive or can no longer reach this organization' };
  }
  const renderings: OperatorPlanEffectRendering[] = input.effects.map((e) => {
    const label = input.labels.get(e.ordinal)!;
    return {
      ordinal: e.ordinal,
      provider: e.provider,
      toolName: e.toolName,
      targetLabel: clip(label.targetLabel, 200),
      principalLabel: label.principalLabel ? clip(label.principalLabel, 320) : null,
      rendering: clip(label.rendering, 500),
    };
  });
  let intentId: string;
  try {
    const { createActionIntent } = await import('../actionIntents/intentService');
    const snap = await createActionIntent(requesterAuth, {
      toolName: OPERATOR_PLAN_TOOL,
      source: 'mcp_api',
      orgId: input.orgId,
      idempotencyKey: `operator_plan:${input.taskId}:r${input.planRevision}`,
      requestingClientLabel: 'AI Operator',
      input: {
        taskId: input.taskId,
        planRevision: input.planRevision,
        effectSetDigest,
        effects: renderings,
      },
    });
    intentId = snap.id;
  } catch (err) {
    return { ok: false, reason: 'mint_failed', detail: err instanceof Error ? err.message : String(err) };
  }

  // tx2: the one-shot link. Zero rows means the approval CAS already linked
  // it (release outran us) or the plan was superseded meanwhile — both fine.
  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    await db
      .update(aiOperatorPlanApprovals)
      .set({ intentId, updatedAt: new Date() })
      .where(and(
        eq(aiOperatorPlanApprovals.id, tx1.approvalId),
        eq(aiOperatorPlanApprovals.orgId, input.orgId),
        isNull(aiOperatorPlanApprovals.intentId),
        eq(aiOperatorPlanApprovals.state, 'pending'),
      ));
  }));

  return { ok: true, approvalId: tx1.approvalId, intentId, effectSetDigest, effectCount: input.effects.length };
}

// ---------------------------------------------------------------------------
// Approval (the operator_plan release handler's job)
// ---------------------------------------------------------------------------

/** The card's lines (intent arguments) equal the sealed rows, in order. */
export function renderingsMatchRows(
  rendered: unknown,
  rows: ReadonlyArray<{ ordinal: number; provider: string; toolName: string; targetLabel: string; principalLabel: string | null; rendering: string }>,
): boolean {
  if (!Array.isArray(rendered) || rendered.length !== rows.length) return false;
  return rows.every((r, i) => {
    const e = rendered[i] as Record<string, unknown> | null;
    return !!e
      && e.ordinal === r.ordinal && e.provider === r.provider && e.toolName === r.toolName
      && e.targetLabel === r.targetLabel && (e.principalLabel ?? null) === r.principalLabel
      && e.rendering === r.rendering;
  });
}

export type MarkPlanApprovedResult =
  | { ok: true; taskId: string; planRevision: number; effectCount: number; approverUserId: string }
  | { ok: false; reason: 'intent_invalid' | 'plan_approval_missing' | 'not_pending' | 'digest_mismatch'
      | 'revision_moved' | 'tool_not_in_agent_allowlist'; detail: string };

/**
 * Called by the `operator_plan` handler during the durable release of the
 * plan intent. The approver is read from the INTENT ROW's decision columns —
 * the release `auth` is the requester's, never the approver's.
 *
 * One CAS (`pending → approved`) bound to the intent, its digest and the
 * task's live revision; zero rows is a refusal, never a retry. Wakes the task
 * in the same transaction.
 */
export async function markPlanApproved(args: { orgId: string; intentId: string }): Promise<MarkPlanApprovedResult> {
  const lists = { value: null as TaskAgentAllowlists | null };
  type Pre = { ok: true; intent: typeof actionIntents.$inferSelect } | { ok: false; detail: string };
  const pre: Pre = await runOutsideDbContext(() => withSystemDbAccessContext(async (): Promise<Pre> => {
    const [intent] = await db
      .select()
      .from(actionIntents)
      .where(and(eq(actionIntents.id, args.intentId), eq(actionIntents.orgId, args.orgId)))
      .limit(1);
    if (!intent || intent.actionName !== OPERATOR_PLAN_TOOL || intent.status !== 'executing' || !intent.decidedByUserId) {
      return { ok: false, detail: 'the releasing intent is not an executing, human-decided operator_plan intent' };
    }
    return { ok: true, intent };
  }));
  if (!pre.ok) return { ok: false, reason: 'intent_invalid', detail: pre.detail };
  const intent = pre.intent;
  const a = intent.arguments as Record<string, unknown>;
  const taskId = typeof a.taskId === 'string' ? a.taskId : null;
  const planRevision = typeof a.planRevision === 'number' ? a.planRevision : null;
  const digest = typeof a.effectSetDigest === 'string' ? a.effectSetDigest : null;
  if (!taskId || planRevision === null || !digest) {
    return { ok: false, reason: 'intent_invalid', detail: 'operator_plan arguments are incomplete' };
  }

  lists.value = await loadTaskAgentToolAllowlists(args.orgId, taskId);

  return runOutsideDbContext(() => withSystemDbAccessContext(async (): Promise<MarkPlanApprovedResult> => {
    const [task] = await db
      .select({ revision: aiOperatorTasks.revision, requesterUserId: aiOperatorTasks.requesterUserId })
      .from(aiOperatorTasks)
      .where(and(eq(aiOperatorTasks.id, taskId), eq(aiOperatorTasks.orgId, args.orgId)))
      .for('update')
      .limit(1);
    if (!task) return { ok: false, reason: 'plan_approval_missing', detail: 'task not found' };
    // Only the coordinator mints the plan intent, and it mints it AS the
    // task's requester (D-E4-2). A plan intent raised by anyone else is not
    // this task's plan, whatever its arguments say.
    if (!task.requesterUserId || intent.requestedByUserId !== task.requesterUserId) {
      return { ok: false, reason: 'intent_invalid', detail: 'the plan intent was not raised for the task requester' };
    }
    if (task.revision !== planRevision) {
      return { ok: false, reason: 'revision_moved', detail: `task is at revision ${task.revision}, plan is ${planRevision}` };
    }
    const [approval] = await db
      .select()
      .from(aiOperatorPlanApprovals)
      .where(and(
        eq(aiOperatorPlanApprovals.orgId, args.orgId),
        eq(aiOperatorPlanApprovals.taskId, taskId),
        eq(aiOperatorPlanApprovals.planRevision, planRevision),
      ))
      .limit(1);
    if (!approval) return { ok: false, reason: 'plan_approval_missing', detail: 'no plan row at this revision' };
    if (approval.state !== 'pending') return { ok: false, reason: 'not_pending', detail: `the plan is ${approval.state}` };
    if (approval.intentId && approval.intentId !== args.intentId) {
      return { ok: false, reason: 'intent_invalid', detail: 'the plan is linked to a different intent' };
    }
    const rows = await db
      .select()
      .from(aiOperatorPlanApprovalEffects)
      .where(and(
        eq(aiOperatorPlanApprovalEffects.orgId, args.orgId),
        eq(aiOperatorPlanApprovalEffects.approvalId, approval.id),
      ))
      .orderBy(asc(aiOperatorPlanApprovalEffects.ordinal));
    let recomputed: string | null = null;
    try {
      recomputed = computeEffectSetDigest({ taskId, planRevision, effects: rowsToDigestProjection(rows) });
    } catch { recomputed = null; }
    if (recomputed !== digest || approval.effectSetDigest !== digest || rows.length !== approval.effectCount) {
      return { ok: false, reason: 'digest_mismatch', detail: 'the stored effect set no longer matches the approved seal' };
    }
    // What the approver READ is the intent's `effects` rendering (the card
    // needs no fetch); what the seal binds is the rows. They must be the same
    // list, line for line, or the card could have shown one plan while the
    // seal authorizes another.
    if (!renderingsMatchRows(a.effects, rows)) {
      return { ok: false, reason: 'digest_mismatch', detail: 'the approved card rendering does not match the stored effect rows' };
    }
    // The ceiling over every effect, re-run at the plan's own release: a
    // human-shaped, task-less plan intent reaches neither the agent release
    // authority nor the child arm, so this is where a narrowed policy stops a
    // plan before any effect is minted.
    for (const r of rows) {
      // Arguments are not stored on the row; the action segment, if any, is
      // only meaningful for action-dispatched tools, which plans name whole.
      const ceiling = checkToolCeiling(lists.value!, r.toolName, {});
      if (!ceiling.ok) return { ok: false, reason: 'tool_not_in_agent_allowlist', detail: ceiling.detail };
    }

    const updated = await db
      .update(aiOperatorPlanApprovals)
      .set({
        state: 'approved',
        intentId: args.intentId,
        approvedByUserId: intent.decidedByUserId!,
        approvedAt: new Date(),
        approvedAssuranceLevel: intent.decidedAssuranceLevel ?? null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(aiOperatorPlanApprovals.id, approval.id),
        eq(aiOperatorPlanApprovals.orgId, args.orgId),
        eq(aiOperatorPlanApprovals.state, 'pending'),
        eq(aiOperatorPlanApprovals.effectSetDigest, digest),
        or(isNull(aiOperatorPlanApprovals.intentId), eq(aiOperatorPlanApprovals.intentId, args.intentId)),
      ))
      .returning({ id: aiOperatorPlanApprovals.id });
    if (updated.length !== 1) return { ok: false, reason: 'not_pending', detail: 'lost the approval CAS' };

    await appendTaskEvent(db, {
      orgId: args.orgId, taskId, eventType: 'wait_resolved', actor: { kind: 'coordinator' },
      stepKey: approval.stepKey, targetId: null,
      detail: `plan revision ${planRevision} approved (${approval.effectCount} effect(s)) by user ${intent.decidedByUserId}`,
    });
    // The plan intent carries no task_id (D-E4-2), so the terminal-outbox
    // writer cannot wake the task for us; do it here, in the same
    // transaction as the approval.
    await enqueueTaskOutbox(db, {
      orgId: args.orgId, taskId, sourceKind: 'intent', sourceId: args.intentId,
      transitionSeq: INTENT_TERMINAL_OUTBOX_TRANSITION_SEQ.intent_completed,
    });
    return {
      ok: true, taskId, planRevision, effectCount: approval.effectCount, approverUserId: intent.decidedByUserId!,
    };
  }));
}

// ---------------------------------------------------------------------------
// Supersession
// ---------------------------------------------------------------------------

/**
 * Supersede the plan at `fromRevision` and move the task to a new revision —
 * in ONE transaction, task → operation → intent lock order (dispatchClaim.ts).
 *
 * Cancels the plan intent if still undecided/undispatched, and child intents
 * whose operation is still only `reserved`. A DISPATCHED child is a real-world
 * change: cancelling its intent would destroy the record without undoing it.
 *
 * Not called by any recipe in E4 (none changes its plan yet); R1's discovery
 * path calls it. Distinct from `admitReasoningRun`'s boolean of the same name.
 */
export async function bumpPlanRevision(args: {
  orgId: string; taskId: string; fromRevision: number; leaseEpoch: number; detail: string;
}): Promise<{ bumped: boolean; newRevision: number; supersededApprovalId: string | null; cancelledIntentIds: string[] }> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const moved = await db
      .update(aiOperatorTasks)
      .set({ revision: sql`${aiOperatorTasks.revision} + 1`, updatedAt: new Date() })
      .where(and(
        eq(aiOperatorTasks.id, args.taskId),
        eq(aiOperatorTasks.orgId, args.orgId),
        eq(aiOperatorTasks.revision, args.fromRevision),
        eq(aiOperatorTasks.leaseEpoch, args.leaseEpoch),
      ))
      .returning({ revision: aiOperatorTasks.revision });
    if (moved.length !== 1) {
      return { bumped: false, newRevision: args.fromRevision, supersededApprovalId: null, cancelledIntentIds: [] };
    }
    const newRevision = moved[0]!.revision;

    const superseded = await db
      .update(aiOperatorPlanApprovals)
      .set({ state: 'superseded', supersededByRevision: newRevision, updatedAt: new Date() })
      .where(and(
        eq(aiOperatorPlanApprovals.orgId, args.orgId),
        eq(aiOperatorPlanApprovals.taskId, args.taskId),
        eq(aiOperatorPlanApprovals.planRevision, args.fromRevision),
        inArray(aiOperatorPlanApprovals.state, ['pending', 'approved']),
      ))
      .returning({ id: aiOperatorPlanApprovals.id, intentId: aiOperatorPlanApprovals.intentId });
    const supersededRow = superseded[0] ?? null;

    // Child intents whose operation never left `reserved` (lock the operation
    // rows first: task → operation → intent).
    const reservedOps = await db
      .select({ intentId: aiOperatorOperations.intentId })
      .from(aiOperatorOperations)
      .where(and(
        eq(aiOperatorOperations.orgId, args.orgId),
        eq(aiOperatorOperations.taskId, args.taskId),
        eq(aiOperatorOperations.planRevision, args.fromRevision),
        eq(aiOperatorOperations.dispatchState, 'reserved'),
      ))
      .for('update');
    const candidateIds = [
      ...(supersededRow?.intentId ? [supersededRow.intentId] : []),
      ...reservedOps.map((o) => o.intentId).filter((v): v is string => !!v),
    ];
    let cancelledIntentIds: string[] = [];
    if (candidateIds.length > 0) {
      const { publishIntentTerminalOutbox } = await import('./taskOutbox');
      const cancelled = await db
        .update(actionIntents)
        .set({ status: 'cancelled', errorCode: 'plan_superseded' })
        .where(and(
          eq(actionIntents.orgId, args.orgId),
          inArray(actionIntents.id, candidateIds),
          inArray(actionIntents.status, ['pending_approval', 'approved']),
        ))
        .returning({ id: actionIntents.id, orgId: actionIntents.orgId, taskId: actionIntents.taskId });
      for (const c of cancelled) {
        await publishIntentTerminalOutbox(db, c, 'intent_cancelled');
      }
      cancelledIntentIds = cancelled.map((c) => c.id);
      if (cancelledIntentIds.length > 0) {
        const { markOperationCancelled } = await import('./operationService');
        for (const id of cancelledIntentIds) await markOperationCancelled(db, id);
      }
    }

    await appendTaskEvent(db, {
      orgId: args.orgId, taskId: args.taskId, eventType: 'plan_revision_bumped', actor: { kind: 'coordinator' },
      stepKey: null, targetId: null,
      detail: `plan revision ${args.fromRevision} -> ${newRevision}: ${args.detail}`.slice(0, 1000),
    });
    return { bumped: true, newRevision, supersededApprovalId: supersededRow?.id ?? null, cancelledIntentIds };
  }));
}

// ---------------------------------------------------------------------------
// Reads the coordinator needs
// ---------------------------------------------------------------------------

export async function readPlanApprovalAtRevision(
  orgId: string, taskId: string, planRevision: number,
): Promise<AiOperatorPlanApprovalRow | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [row] = await db
      .select()
      .from(aiOperatorPlanApprovals)
      .where(and(
        eq(aiOperatorPlanApprovals.orgId, orgId),
        eq(aiOperatorPlanApprovals.taskId, taskId),
        eq(aiOperatorPlanApprovals.planRevision, planRevision),
      ))
      .limit(1);
    return row ?? null;
  }));
}

/**
 * Close a pending plan whose intent reached a terminal non-approved status
 * (rejected / expired / cancelled / failed). Only the coordinator calls this,
 * after re-reading the intent row (invariant 2). `rejected` requires the link.
 */
export async function closePendingPlan(args: {
  orgId: string; approvalId: string; state: 'rejected' | 'expired';
}): Promise<boolean> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db
      .update(aiOperatorPlanApprovals)
      .set({ state: args.state, updatedAt: new Date() })
      .where(and(
        eq(aiOperatorPlanApprovals.id, args.approvalId),
        eq(aiOperatorPlanApprovals.orgId, args.orgId),
        eq(aiOperatorPlanApprovals.state, 'pending'),
      ))
      .returning({ id: aiOperatorPlanApprovals.id });
    return rows.length === 1;
  }));
}

/** Test seam: the canonical envelope string, for the resolver parity test. */
export const __forTest = { canonicalizeEffectSet };
