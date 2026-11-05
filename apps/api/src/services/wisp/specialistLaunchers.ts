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
import { AI_SWEEP_KINDS, bulkTicketReplyParamsSchema, type AiAgentKind } from '@breeze/shared';
import { envFlag } from '../../config/env';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents } from '../../db/schema/aiAgents';
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
import { agentOffMessage, type AgentOffReason } from './specialistRefusalMessages';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export type SpecialistRefusal =
  | 'wisp_disabled' | 'not_entitled' | 'grant_inactive' | 'org_out_of_ceiling' | 'depth_exceeded'
  | 'budget_exhausted' | 'permission_missing' | 'workspace_execute_required' | 'unknown_kind'
  | 'invalid_params' | 'device_not_in_org' | 'no_sweep_schedule' | 'no_effective_agent'
  // #10193: the effective agent exists but cannot accept a run (switched off,
  // mode Off, or the server's agent kill switch); detail is the AgentOffReason.
  | 'agent_disabled'
  | 'admission_skipped' | 'too_many_requests'
  // bulk_ticket_reply: the batch stopped part-way, or sent nothing at all —
  // never reported as a success (the report travels with the refusal).
  | 'bulk_reply_incomplete';

export type LaunchResult =
  | { admitted: true; runId?: string; taskId?: string; report?: BulkTicketReplyReport }
  | { refused: SpecialistRefusal; detail?: string; message?: string; report?: BulkTicketReplyReport };

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

/**
 * Why `params` do not fit `kind`, for the model to correct its call (#10144);
 * null when they parse. Zod's messages name the offending keys (the model's
 * own input) and the expected shape; capped at 300 chars.
 */
export function specialistParamsError(kind: SpecialistKind, params: unknown): string | null {
  const parsed = PARAMS_SCHEMAS[kind].safeParse(params ?? {});
  if (parsed.success) return null;
  return parsed.error.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ')
    .slice(0, 300);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const systemRead = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

/**
 * The run a previous attempt of this request admitted, if any. A row left
 * `failed`/`enqueue_failed` is NOT a replay: no worker will ever pick it up,
 * and admission reclaims exactly that row as a new attempt.
 */
async function existingRunId(orgId: string, requestId: string): Promise<string | null> {
  const [row] = await systemRead(() => db
    .select({ id: aiAgentRuns.id, status: aiAgentRuns.status, errorCode: aiAgentRuns.errorCode })
    .from(aiAgentRuns)
    .where(and(eq(aiAgentRuns.orgId, orgId), eq(aiAgentRuns.dedupeKey, specialistDedupeKey(requestId))))
    .limit(1));
  if (!row || isEnqueueFailed(row)) return null;
  return row.id;
}

const isEnqueueFailed = (run: { status?: string | null; errorCode?: string | null }) =>
  run.status === 'failed' && run.errorCode === 'enqueue_failed';

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
  // `created` with an enqueue failure hands back a row already marked failed
  // (runService) — nothing will run it, so it is not an admission.
  if (result.created) {
    return isEnqueueFailed(result.run)
      ? { refused: 'admission_skipped', detail: 'enqueue_failed' }
      : { admitted: true, runId: result.run.id };
  }
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
// Prerequisites (#10144)
// ---------------------------------------------------------------------------

/**
 * `message`, when set, is the person-facing sentence for THIS refusal (it can
 * name the agent); otherwise the caller derives one from the code
 * (specialistRefusalMessages).
 */
export type PrerequisiteRefusal = { refused: SpecialistRefusal; detail?: string; message?: string };

export interface PrerequisiteArgs {
  orgId: string;
  partnerId: string;
  /** Parsed by `parseSpecialistParams` for this kind. */
  params: Record<string, unknown>;
}

/** The partner's enabled sweep baseline this org may run (narrowed to any requested kinds), or null. */
async function findSweepSchedule(partnerId: string, orgId: string, sweepKinds: z.infer<typeof sweepParamsSchema>['sweepKinds']) {
  const entries = await resolveEffectiveSchedulesForPartner(partnerId);
  return entries.find((e) => {
    if (e.baseline.kind !== 'sweep' || !e.baseline.enabled) return false;
    const eff = effectiveSchedule(
      { enabled: e.baseline.enabled, sweepKinds: e.baseline.sweepKinds },
      e.overridesByOrg.get(orgId) ?? null,
    );
    if (!eff.enabled || eff.sweepKinds.length === 0) return false;
    // A requested kind set must overlap what the org's schedule may sweep;
    // the occurrence intersects, never widens.
    return !sweepKinds || sweepKinds.some((k) => eff.sweepKinds.includes(k));
  }) ?? null;
}

type ResolvedAgent = NonNullable<Awaited<ReturnType<typeof resolveEffectiveAgentSystem>>>;

/**
 * Run admission rule 1 (runService): with the server's agent kill switch off,
 * every run is skipped `kill_switch_off` before any agent is resolved. Checked
 * first here too, so a missing agent reads as the server flag (not "create
 * one") and an agent provisioned at launch is not assumed to run.
 */
const KILL_SWITCH_REFUSAL: PrerequisiteRefusal = Object.freeze({
  refused: 'agent_disabled',
  detail: 'kill_switch_off',
  message: agentOffMessage('kill_switch_off', null),
});

function agentsKillSwitchOff(): boolean {
  return !envFlag('BREEZE_AI_AGENTS_ENABLED', false);
}

/**
 * Why an existing effective agent would be skipped at run admission (rule 2:
 * `agent_disabled`, `mode_off`), or null when it can accept a run. Reads the
 * merged effective policy, so an org override that switches the partner's
 * agent off counts. The resolver also folds the kill switch into
 * `enabled: false`; callers check the switch first.
 */
function agentOffReason(resolved: ResolvedAgent): AgentOffReason | null {
  if (!resolved.effective.enabled) return agentsKillSwitchOff() ? 'kill_switch_off' : 'disabled';
  return resolved.effective.mode === 'off' ? 'mode_off' : null;
}

/** The agent's configured name for the refusal sentence; null when it cannot be read (the sentence goes generic). */
async function agentName(agentId: string): Promise<string | null> {
  try {
    const [row] = await systemRead(() => db
      .select({ name: aiAgents.name })
      .from(aiAgents)
      .where(eq(aiAgents.id, agentId))
      .limit(1));
    return row?.name ?? null;
  } catch (err) {
    console.error('[wispSpecialistLaunchers] agent name lookup failed; refusing with a generic sentence', { agentId, err });
    return null;
  }
}

/**
 * #10193 — `agent_disabled` for an existing agent that cannot accept a run,
 * naming it and where to turn it on; null when it can. Every agent is created
 * disabled (the wizard says "Created disabled"), so "an effective agent
 * exists" is not "a run would be admitted".
 */
async function agentOffRefusal(resolved: ResolvedAgent): Promise<PrerequisiteRefusal | null> {
  const reason = agentOffReason(resolved);
  if (!reason) return null;
  if (reason === 'kill_switch_off') return { ...KILL_SWITCH_REFUSAL };
  return { refused: 'agent_disabled', detail: reason, message: agentOffMessage(reason, await agentName(resolved.agentId)) };
}

type LaunchableAgent = { ok: true; agentId: string } | { ok: false; refusal: PrerequisiteRefusal };

/** The org's effective agent of `kind`, if one exists AND would be admitted. */
async function resolveLaunchableAgent(orgId: string, kind: AiAgentKind): Promise<LaunchableAgent> {
  if (agentsKillSwitchOff()) return { ok: false, refusal: { ...KILL_SWITCH_REFUSAL } };
  const resolved = await resolveEffectiveAgentSystem(orgId, kind);
  if (!resolved) return { ok: false, refusal: { refused: 'no_effective_agent' } };
  const off = await agentOffRefusal(resolved);
  return off ? { ok: false, refusal: off } : { ok: true, agentId: resolved.agentId };
}

type ResolvedRecipeAgent =
  | { ok: true; recipe: NonNullable<ReturnType<typeof getRecipe>>; agentId: string }
  | { ok: false; refusal: PrerequisiteRefusal };

/** The released recipe and the org's enabled agent of the kind it needs. */
async function resolveRecipeAgent(orgId: string, params: z.infer<typeof operatorRecipeParamsSchema>): Promise<ResolvedRecipeAgent> {
  const recipe = getRecipe(params.workflowKey, params.workflowVersion);
  if (!recipe) return { ok: false, refusal: { refused: 'invalid_params', detail: 'unknown_recipe' } };
  const agentKind = Object.hasOwn(RECIPE_AGENT_KINDS, recipe.key) ? RECIPE_AGENT_KINDS[recipe.key] : undefined;
  if (!agentKind) return { ok: false, refusal: { refused: 'no_effective_agent' } };
  const agent = await resolveLaunchableAgent(orgId, agentKind);
  if (!agent.ok) return agent;
  return { ok: true, recipe, agentId: agent.agentId };
}

async function deviceInOrg(orgId: string, deviceId: string): Promise<boolean> {
  const [device] = await systemRead(() => db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .limit(1));
  return Boolean(device);
}

/**
 * The cheap, read-only prerequisite each kind needs before it could launch —
 * the same checks its launcher makes, without enqueueing, admitting or
 * provisioning anything. The chat gate runs these BEFORE raising an approval
 * card (`coordinator.precheckSpecialistRequest`) so a request that would be
 * refused deterministically never asks first. The launchers still re-check at
 * launch: state can change while the card waits.
 */
export const SPECIALIST_PREREQUISITES: Readonly<Record<SpecialistKind, (args: PrerequisiteArgs) => Promise<PrerequisiteRefusal | null>>> = Object.freeze({
  sweep: async ({ orgId, partnerId, params }) => {
    const { sweepKinds } = sweepParamsSchema.parse(params);
    return (await findSweepSchedule(partnerId, orgId, sweepKinds)) ? null : { refused: 'no_sweep_schedule' };
  },
  // The sandbox flag is the coordinator's gate (aiWorkspaceEnabled); admission owns the rest.
  analysis: async () => null,
  operator_recipe: async ({ orgId, params }) => {
    const resolved = await resolveRecipeAgent(orgId, operatorRecipeParamsSchema.parse(params));
    return resolved.ok ? null : resolved.refusal;
  },
  patch_plan: async ({ orgId }) => {
    const agent = await resolveLaunchableAgent(orgId, 'patch');
    return agent.ok ? null : agent.refusal;
  },
  // The research agent is provisioned at launch (ensureResearchAgent writes
  // it enabled), so a missing one passes; the kill switch, or an existing one
  // that is switched off, is doomed.
  remediation_research: async ({ orgId, params }) => {
    if (!(await deviceInOrg(orgId, researchParamsSchema.parse(params).deviceId))) return { refused: 'device_not_in_org' };
    if (agentsKillSwitchOff()) return { ...KILL_SWITCH_REFUSAL };
    const resolved = await resolveEffectiveAgentSystem(orgId, 'research');
    return resolved ? agentOffRefusal(resolved) : null;
  },
  // Deterministic and agent-less: it checks every ticket when it runs.
  bulk_ticket_reply: async () => null,
});

// ---------------------------------------------------------------------------
// Launchers
// ---------------------------------------------------------------------------

/**
 * A one-off occurrence of the partner's enabled sweep baseline, restricted to
 * this org and carrying the grant. `admitted` here means QUEUED: per-org
 * admission (budget, overrides, duplicate) happens in the occurrence job, and
 * its outcome lands on the sweep run, not on this result. Going through the sweep queue keeps the
 * system-collected evidence step a sweep run depends on. The run itself is
 * admitted by `processSweepOccurrence` (dedupe
 * `sweep-<scheduleId>-<orgId>-wisp-<requestId>`), so no run id comes back.
 */
export async function launchSweep(ctx: LaunchContext): Promise<LaunchResult> {
  const params = sweepParamsSchema.parse(ctx.params);
  const entry = await findSweepSchedule(ctx.partnerId, ctx.orgId, params.sweepKinds);
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
    // Removed on completion AND failure: a retained job would make a later
    // re-add under this deterministic id a silent BullMQ no-op.
    removeOnComplete: true,
    removeOnFail: true,
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
  const resolved = await resolveRecipeAgent(ctx.orgId, params);
  if (!resolved.ok) return resolved.refusal;
  const { recipe } = resolved;

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
  const agent = await resolveLaunchableAgent(ctx.orgId, 'patch');
  if (!agent.ok) return agent.refusal;
  return admitRun(ctx, {
    orgId: ctx.orgId,
    kind: 'patch',
    triggerKind: 'manual',
    deviceId: null,
    profile: 'patch',
    dedupeKey: specialistDedupeKey(ctx.requestId),
    triggerRef: triggerRefFor(ctx, { agentId: agent.agentId }),
    grant: { ...ctx.grant },
  });
}

/** Remediation research on one device of the org. */
export async function launchRemediationResearch(ctx: LaunchContext): Promise<LaunchResult> {
  const params = researchParamsSchema.parse(ctx.params);
  if (!(await deviceInOrg(ctx.orgId, params.deviceId))) return { refused: 'device_not_in_org' };
  // The research policy does not exist until the partner baseline does
  // (fixMemory/research.ts). Opens and commits its own system transaction.
  await runOutsideDbContext(() => ensureResearchAgent(ctx.partnerId));
  const agent = await resolveLaunchableAgent(ctx.orgId, 'research');
  if (!agent.ok) return agent.refusal;
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
  const { report } = result;
  // A batch that stopped part-way, or sent nothing, must not read as done: the
  // carrier release then terminalizes `failed` with the report stored, so a
  // person looks before anything else is sent. A redelivery that finds every
  // ticket already sent is a success.
  if (report.stoppedAt) {
    return { refused: 'bulk_reply_incomplete', detail: report.stoppedAt.error, report };
  }
  if (report.sent.length === 0 && report.alreadySent.length === 0) {
    return { refused: 'bulk_reply_incomplete', detail: 'nothing_sent', report };
  }
  // A ticket an earlier delivery may already have replied to: a person checks.
  if (report.skipped.some((s) => s.reason === 'uncertain')) {
    return { refused: 'bulk_reply_incomplete', detail: 'uncertain', report };
  }
  return { admitted: true, report };
}

export const SPECIALIST_LAUNCHERS: Readonly<Record<SpecialistKind, (ctx: LaunchContext) => Promise<LaunchResult>>> = Object.freeze({
  sweep: launchSweep,
  analysis: launchAnalysis,
  operator_recipe: launchOperatorRecipe,
  patch_plan: launchPatchPlan,
  remediation_research: launchRemediationResearch,
  bulk_ticket_reply: launchBulkTicketReply,
});
