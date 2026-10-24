/**
 * Wisp W07 — specialist launchers (Wisp design §7.5; plan Task 3).
 *
 * One function per `SpecialistKind`. Each turns an ALREADY-GATED request (the
 * coordinator ran every grant / entitlement / depth / budget / permission
 * gate) into the existing admission path for that agent, pinned to the grant
 * revision and carrying the requesting assessment run as lineage. Nothing here
 * decides whether a request may run; that is `coordinator.ts`. The launchers
 * are reachable ONLY from the coordinator — no tool or route imports them.
 *
 * Idempotency (Review Focus 3): every launcher derives its admission key from
 * the request id (`specialistDedupeKey`), so a retried finalizer or a
 * redelivered release lands on the SAME `(org_id, dedupe_key)` row. A
 * `duplicate` skip resolves the existing row and reports it as admitted.
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AI_SWEEP_KINDS, bulkTicketReplyParamsSchema } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { devices } from '../../db/schema/devices';
import type { AuthContext } from '../../middleware/auth';
import { getAiAgentSweepQueue, getSweepOccurrenceJobId } from '../../jobs/aiAgentSweepScheduler';
import { admitAnalysisRun } from '../aiAgents/analysisAdmission';
import { resolveEffectiveAgentSystem } from '../aiAgents/effectivePolicy';
import { ensureResearchAgent } from '../aiAgents/researchProvisioning';
import { createAndEnqueueAgentRun, GrantDepthExceededError } from '../aiAgents/runService';
import { effectiveSchedule } from '../aiAgents/scheduleMerge';
import { resolveEffectiveSchedulesForPartner } from '../aiAgents/scheduleService';
import { RECIPE_AGENT_KINDS } from '../aiOperator/recipeReadiness';
import { getRecipe } from '../aiOperator/recipes';
import { admitTask } from '../aiOperator/taskService';
import type { GrantCeiling } from './grantAuthority';
import type { SpecialistKind } from './specialistPolicy';
import { executeBulkTicketReply, type BulkTicketReplyReport } from './specialists/bulkTicketReply';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export type SpecialistRefusal =
  | 'wisp_disabled' | 'not_entitled' | 'grant_inactive' | 'org_out_of_ceiling' | 'depth_exceeded'
  | 'budget_exhausted' | 'permission_missing' | 'workspace_execute_required' | 'unknown_kind'
  | 'invalid_params' | 'device_not_in_org' | 'no_sweep_schedule' | 'no_effective_agent'
  | 'admission_skipped' | 'too_many_requests';

export type LaunchResult =
  | { admitted: true; runId?: string; taskId?: string; report?: BulkTicketReplyReport }
  | { refused: SpecialistRefusal; detail?: string };

export interface LaunchContext {
  orgId: string;
  partnerId: string;
  grantorUserId: string;
  grant: { grantId: string; grantRevisionId: string; requestedByRunId: string | null };
  requestId: string;
  /** Parsed by `parseSpecialistParams` — the launcher re-narrows to its own shape. */
  params: Record<string, unknown>;
  /** The live ceiling the coordinator resolved (bulk reply re-checks every ticket against it). */
  ceiling: GrantCeiling;
  /** The acting human on the chat / approval paths; null on the auto-admit run path. */
  actorAuth: AuthContext | null;
  /** bulk_ticket_reply: the digest pinned when the request was made / approved. */
  pinnedDigest: string | null;
}

/** `wisp-specialist-${requestId}` — the admission idempotency key for every kind. */
export function specialistDedupeKey(requestId: string): string {
  return `wisp-specialist-${requestId}`;
}

// ---------------------------------------------------------------------------
// Params (coordinator gate 6)
// ---------------------------------------------------------------------------

export const sweepParamsSchema = z.strictObject({
  sweepKinds: z.array(z.enum(AI_SWEEP_KINDS)).min(1).max(AI_SWEEP_KINDS.length).optional(),
});
export const analysisParamsSchema = z.strictObject({
  goal: z.string().trim().min(1).max(2000),
  deviceIds: z.array(z.uuid()).max(25).optional(),
  siteId: z.uuid().optional(),
});
export const operatorRecipeParamsSchema = z.strictObject({
  workflowKey: z.string().trim().min(1).max(100),
  workflowVersion: z.number().int().min(1),
  objective: z.string().trim().min(1).max(500),
  recipeInput: z.unknown(),
});
export const patchPlanParamsSchema = z.strictObject({});
export const researchParamsSchema = z.strictObject({
  deviceId: z.uuid(),
  alertId: z.uuid().optional(),
});

const PARAMS_SCHEMAS: Readonly<Record<SpecialistKind, z.ZodType>> = Object.freeze({
  sweep: sweepParamsSchema,
  analysis: analysisParamsSchema,
  operator_recipe: operatorRecipeParamsSchema,
  patch_plan: patchPlanParamsSchema,
  remediation_research: researchParamsSchema,
  bulk_ticket_reply: bulkTicketReplyParamsSchema,
});

/** The parsed params for `kind`, or null when they do not fit its schema. */
export function parseSpecialistParams(kind: SpecialistKind, params: unknown): Record<string, unknown> | null {
  const parsed = PARAMS_SCHEMAS[kind].safeParse(params ?? {});
  return parsed.success ? (parsed.data as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const systemRead = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

/** The run a previous attempt of this request admitted, if any. */
async function existingRunId(orgId: string, requestId: string): Promise<string | null> {
  const [row] = await systemRead(() => db
    .select({ id: aiAgentRuns.id })
    .from(aiAgentRuns)
    .where(and(eq(aiAgentRuns.orgId, orgId), eq(aiAgentRuns.dedupeKey, specialistDedupeKey(requestId))))
    .limit(1));
  return row?.id ?? null;
}

type RunAdmission = Parameters<typeof createAndEnqueueAgentRun>[0];

/**
 * Admit one grant-bearing run. Admission opens its own context and enqueues
 * after commit (#1105), so it runs outside any caller context. A `duplicate`
 * on this request's key is the idempotent replay; a depth-guard throw is a
 * coordinator bug and refuses.
 */
async function admitRun(ctx: LaunchContext, input: RunAdmission): Promise<LaunchResult> {
  const prior = await existingRunId(ctx.orgId, ctx.requestId);
  if (prior) return { admitted: true, runId: prior };
  let result: Awaited<ReturnType<typeof createAndEnqueueAgentRun>>;
  try {
    result = await runOutsideDbContext(() => createAndEnqueueAgentRun(input));
  } catch (err) {
    if (err instanceof GrantDepthExceededError) return { refused: 'depth_exceeded' };
    throw err;
  }
  if (result.created) return { admitted: true, runId: result.run.id };
  if (result.skipped === 'duplicate') {
    const raced = await existingRunId(ctx.orgId, ctx.requestId);
    if (raced) return { admitted: true, runId: raced };
  }
  return { refused: 'admission_skipped', detail: result.skipped };
}

function triggerRefFor(ctx: LaunchContext, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'wisp_specialist',
    requestId: ctx.requestId,
    requestedByUserId: ctx.grantorUserId,
    requestedByRunId: ctx.grant.requestedByRunId,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Launchers
// ---------------------------------------------------------------------------

/**
 * A one-off occurrence of the partner's enabled sweep baseline, restricted to
 * this org and carrying the grant. Going through the sweep queue keeps the
 * system-collected evidence step a sweep run depends on. The run itself is
 * admitted by `processSweepOccurrence` (dedupe
 * `sweep-<scheduleId>-<orgId>-wisp-<requestId>`), so no run id comes back.
 */
export async function launchSweep(ctx: LaunchContext): Promise<LaunchResult> {
  const params = sweepParamsSchema.parse(ctx.params);
  const entries = await resolveEffectiveSchedulesForPartner(ctx.partnerId);
  const entry = entries.find((e) => {
    if (e.baseline.kind !== 'sweep' || !e.baseline.enabled) return false;
    const eff = effectiveSchedule(
      { enabled: e.baseline.enabled, sweepKinds: e.baseline.sweepKinds },
      e.overridesByOrg.get(ctx.orgId) ?? null,
    );
    if (!eff.enabled || eff.sweepKinds.length === 0) return false;
    // A requested kind set must overlap what the org's schedule may sweep;
    // the occurrence intersects, never widens.
    return !params.sweepKinds || params.sweepKinds.some((k) => eff.sweepKinds.includes(k));
  });
  if (!entry) return { refused: 'no_sweep_schedule' };

  const scheduleId = entry.baseline.id;
  const occurrenceKey = `wisp-${ctx.requestId}`;
  // Deterministic job id: a re-add of the same request is a BullMQ no-op.
  await getAiAgentSweepQueue().add('occurrence', {
    scheduleId,
    occurrenceKey,
    orgIds: [ctx.orgId],
    grant: { ...ctx.grant },
    ...(params.sweepKinds ? { sweepKinds: params.sweepKinds } : {}),
  }, {
    jobId: getSweepOccurrenceJobId(scheduleId, occurrenceKey),
    removeOnComplete: true,
    removeOnFail: 100,
  });
  return { admitted: true };
}

/** A sandbox analysis run (`launch_analysis` — the coordinator-only path, w00). */
export async function launchAnalysis(ctx: LaunchContext): Promise<LaunchResult> {
  const params = analysisParamsSchema.parse(ctx.params);
  const prior = await existingRunId(ctx.orgId, ctx.requestId);
  if (prior) return { admitted: true, runId: prior };
  const result = await runOutsideDbContext(() => admitAnalysisRun({
    orgId: ctx.orgId,
    requestedByUserId: ctx.grantorUserId,
    sessionId: null,
    goal: params.goal,
    deviceIds: params.deviceIds ?? [],
    siteId: params.siteId ?? null,
    stagedHandles: [],
    dedupeKey: specialistDedupeKey(ctx.requestId),
    grant: { ...ctx.grant },
  }));
  if (result.created) return { admitted: true, runId: result.runId };
  if (result.refusal === 'grant_refused') return { refused: 'admission_skipped', detail: 'grant_refused' };
  // `duplicate` collapses into `analysis_rate`; resolve a raced replay first.
  const raced = await existingRunId(ctx.orgId, ctx.requestId);
  if (raced) return { admitted: true, runId: raced };
  return { refused: 'admission_skipped', detail: result.refusal };
}

/** An AI Operator task for a released recipe, requested by the grantor. */
export async function launchOperatorRecipe(ctx: LaunchContext): Promise<LaunchResult> {
  const params = operatorRecipeParamsSchema.parse(ctx.params);
  const recipe = getRecipe(params.workflowKey, params.workflowVersion);
  if (!recipe) return { refused: 'invalid_params', detail: 'unknown_recipe' };
  const agentKind = Object.hasOwn(RECIPE_AGENT_KINDS, recipe.key) ? RECIPE_AGENT_KINDS[recipe.key] : undefined;
  if (!agentKind) return { refused: 'no_effective_agent' };
  const resolved = await resolveEffectiveAgentSystem(ctx.orgId, agentKind);
  if (!resolved || !resolved.effective.enabled) return { refused: 'no_effective_agent' };

  let result: Awaited<ReturnType<typeof admitTask>>;
  try {
    result = await runOutsideDbContext(() => admitTask({
      orgId: ctx.orgId,
      agentId: resolved.agentId,
      objective: params.objective,
      originKind: 'chat',
      requesterUserId: ctx.grantorUserId,
      workflowKey: recipe.key,
      workflowVersion: recipe.version,
      recipeInput: params.recipeInput,
      // Unique per org: a replay returns the first task (`replayed: true`).
      clientIdempotencyKey: specialistDedupeKey(ctx.requestId),
      grant: { ...ctx.grant },
    }));
  } catch (err) {
    if (err instanceof GrantDepthExceededError) return { refused: 'depth_exceeded' };
    throw err;
  }
  if (result.ok) return { admitted: true, taskId: result.taskId };
  if (result.refusal === 'invalid_input' || result.refusal === 'unknown_recipe' || result.refusal === 'recipe_version_mismatch') {
    return { refused: 'invalid_params', detail: result.refusal };
  }
  return { refused: 'admission_skipped', detail: result.refusal };
}

/** A device-less patch-plan run (same shape as `routes/patchPlan.ts`). */
export async function launchPatchPlan(ctx: LaunchContext): Promise<LaunchResult> {
  patchPlanParamsSchema.parse(ctx.params);
  const resolved = await resolveEffectiveAgentSystem(ctx.orgId, 'patch');
  if (!resolved) return { refused: 'no_effective_agent' };
  return admitRun(ctx, {
    orgId: ctx.orgId,
    kind: 'patch',
    triggerKind: 'manual',
    deviceId: null,
    profile: 'patch',
    dedupeKey: specialistDedupeKey(ctx.requestId),
    triggerRef: triggerRefFor(ctx, { agentId: resolved.agentId }),
    grant: { ...ctx.grant },
  });
}

/** Remediation research on one device of the org. */
export async function launchRemediationResearch(ctx: LaunchContext): Promise<LaunchResult> {
  const params = researchParamsSchema.parse(ctx.params);
  const [device] = await systemRead(() => db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.id, params.deviceId), eq(devices.orgId, ctx.orgId)))
    .limit(1));
  if (!device) return { refused: 'device_not_in_org' };
  // The research policy does not exist until the partner baseline does
  // (fixMemory/research.ts). Opens and commits its own system transaction.
  await runOutsideDbContext(() => ensureResearchAgent(ctx.partnerId));
  const resolved = await resolveEffectiveAgentSystem(ctx.orgId, 'research');
  if (!resolved) return { refused: 'no_effective_agent' };
  return admitRun(ctx, {
    orgId: ctx.orgId,
    kind: 'research',
    triggerKind: 'manual',
    deviceId: params.deviceId,
    alertId: params.alertId,
    profile: 'remediation_research',
    dedupeKey: specialistDedupeKey(ctx.requestId),
    triggerRef: triggerRefFor(ctx),
    grant: { ...ctx.grant },
  });
}

/**
 * The pinned bulk ticket reply (w00 A30). Deterministic, no agent: it runs at
 * the moment of launch under the ACTING HUMAN (the chat user, or the approver
 * of the card) and the grant ceiling. The auto-admit run path never reaches
 * here — the kind is not auto-admitted, so a run raises a card instead.
 */
export async function launchBulkTicketReply(ctx: LaunchContext): Promise<LaunchResult> {
  if (!ctx.actorAuth || !ctx.pinnedDigest) return { refused: 'invalid_params', detail: 'actor_required' };
  const result = await executeBulkTicketReply({
    executionId: ctx.requestId,
    ceiling: ctx.ceiling,
    actorAuth: ctx.actorAuth,
    params: ctx.params,
    pinnedDigest: ctx.pinnedDigest,
  });
  if (!result.ok) return { refused: 'invalid_params', detail: result.refused };
  return { admitted: true, report: result.report };
}

export const SPECIALIST_LAUNCHERS: Readonly<Record<SpecialistKind, (ctx: LaunchContext) => Promise<LaunchResult>>> = Object.freeze({
  sweep: launchSweep,
  analysis: launchAnalysis,
  operator_recipe: launchOperatorRecipe,
  patch_plan: launchPatchPlan,
  remediation_research: launchRemediationResearch,
  bulk_ticket_reply: launchBulkTicketReply,
});
