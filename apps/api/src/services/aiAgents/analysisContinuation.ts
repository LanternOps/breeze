/**
 * Wisp analysis sessions W03 (#11847) — continuing an analysis run.
 *
 * A technician can launch an analysis run that continues a settled earlier
 * one (`continueFromRunId`). The new run inherits, re-validated, every file
 * its chain exported or collected, and gets a fenced seed of the prior result.
 * The chain is bounded in depth, run count and reserved spend at admission
 * (`runService.ts` step 4d, under the org-wide analysis lock, using
 * `chainCommittedCents`).
 *
 * The thread rule (spec §4.2): a continuation requires the SAME LIVE GRANT,
 * and nothing else. There is no session-ancestry check: a second chat session
 * under the same grant may continue a run another session launched. A run with
 * no grant can never be continued.
 *
 * Every read here is pinned to the caller's org, so another org's run reads
 * exactly as a missing one. The launcher-side reads run in short system
 * contexts (the launcher is outside any request transaction); the manifest
 * loader runs inside the caller's context (`loadRunContext`'s system block).
 *
 * The pure renderers (seed, manifest, trigger-ref re-validation) live in
 * `analysisProfile.ts`, beside the other prompt text.
 */
import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { analysisOutcomeSchema } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  aiAgentRuns,
  type AiAgentRunStagedInputs,
  type AiRunExportGrants,
} from '../../db/schema/aiAgents';
import { aiRunArtifacts } from '../../db/schema/aiWorkspace';
import { AI_AGENT_LIMIT_DEFAULTS } from '@breeze/shared';
import {
  renderAnalysisContinuationSeed,
  type AnalysisManifestEntry,
  type ChainHandleDrop,
  type ChainHandleDropReason,
} from './analysisProfile';

export type { ChainHandleDropReason } from './analysisProfile';

/** At most this many inherited handles are carried into a continuation (newest first). */
export const ANALYSIS_CHAIN_HANDLE_CAP = 200;
/** A prior run may be continued only once it has settled. */
export const ANALYSIS_SETTLED_STATUSES = ['completed', 'failed', 'cancelled'] as const;
/** The seed lists at most this many of the prior run's findings. */
const SEED_FINDINGS_LIMIT = 20;

export type AnalysisChainPrior = {
  id: string;
  orgId: string;
  grantId: string;
  chainRootRunId: string | null;
  chainDepth: number;
  stagedInputs: AiAgentRunStagedInputs | null;
  goal: string;
  /** Display and lineage only; never compared (thread rule). */
  originSessionId: string | null;
};

export type AnalysisContinuationRefusal =
  | 'analysis_continuation_not_found'
  | 'analysis_continuation_wrong_kind'
  | 'analysis_continuation_other_grant'
  | 'analysis_continuation_not_settled';

const UUID = z.string().guid();
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.safeParse(v).success;
const SETTLED: ReadonlySet<string> = new Set(ANALYSIS_SETTLED_STATUSES);

const systemRead = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

/**
 * The chain root of a NEW continuation of `prior`: the prior itself at depth
 * 0, otherwise its recorded root. Null means the root was deleted (the FK's
 * SET NULL) — the chain's bounds can no longer be counted, so callers refuse
 * (`analysis_chain_too_long`) rather than treat the prior as a new root.
 */
export function chainRootOf(prior: Pick<AnalysisChainPrior, 'id' | 'chainRootRunId' | 'chainDepth'>): string | null {
  return prior.chainDepth === 0 ? prior.id : prior.chainRootRunId;
}

/** May a continuation stage this artifact? Outputs and dataset exports, unexpired. */
export function isChainStageableArtifact(
  a: { kind: string; createdByTool: string; expiresAt: Date },
  now: Date,
): boolean {
  return isChainStageableKind(a) && a.expiresAt.getTime() > now.getTime();
}

function isChainStageableKind(a: { kind: string; createdByTool: string }): boolean {
  return a.kind === 'output' || (a.kind === 'input_capture' && a.createdByTool === 'export_dataset');
}

function stagedInputsOf(value: unknown): AiAgentRunStagedInputs | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { handles?: unknown; deviceIds?: unknown };
  if (!Array.isArray(v.handles) || !v.handles.every((x) => typeof x === 'string')) return null;
  if (!Array.isArray(v.deviceIds) || !v.deviceIds.every((x) => typeof x === 'string')) return null;
  return value as AiAgentRunStagedInputs;
}

function triggerRefField(triggerRef: unknown, key: string): unknown {
  return triggerRef && typeof triggerRef === 'object' ? (triggerRef as Record<string, unknown>)[key] : undefined;
}

/**
 * May `runId` be continued by a new analysis run in `orgId` under `grantId`?
 * Checks, in spec order: found (in this org) → an analysis run → under a
 * grant, and the same one → settled. `grantId` is absent only on the advisory
 * precheck, which skips the comparison but still refuses a grant-less prior.
 */
export async function analysisContinuationOf(input: {
  orgId: string;
  runId: string;
  grantId?: string;
}): Promise<{ ok: true; prior: AnalysisChainPrior } | { ok: false; refusal: AnalysisContinuationRefusal }> {
  if (!isUuid(input.runId) || !isUuid(input.orgId)) return { ok: false, refusal: 'analysis_continuation_not_found' };
  const [row] = await systemRead(() => db
    .select({
      id: aiAgentRuns.id,
      orgId: aiAgentRuns.orgId,
      profile: aiAgentRuns.profile,
      grantId: aiAgentRuns.grantId,
      status: aiAgentRuns.status,
      chainRootRunId: aiAgentRuns.chainRootRunId,
      chainDepth: aiAgentRuns.chainDepth,
      stagedInputs: aiAgentRuns.stagedInputs,
      triggerRef: aiAgentRuns.triggerRef,
    })
    .from(aiAgentRuns)
    .where(and(eq(aiAgentRuns.id, input.runId), eq(aiAgentRuns.orgId, input.orgId)))
    .limit(1));
  if (!row) return { ok: false, refusal: 'analysis_continuation_not_found' };
  if (row.profile !== 'analysis') return { ok: false, refusal: 'analysis_continuation_wrong_kind' };
  if (!row.grantId || (input.grantId !== undefined && row.grantId !== input.grantId)) {
    return { ok: false, refusal: 'analysis_continuation_other_grant' };
  }
  if (!SETTLED.has(row.status)) return { ok: false, refusal: 'analysis_continuation_not_settled' };
  const goal = triggerRefField(row.triggerRef, 'goal');
  const originSessionId = triggerRefField(row.triggerRef, 'originSessionId');
  return {
    ok: true,
    prior: {
      id: row.id,
      orgId: row.orgId,
      grantId: row.grantId,
      chainRootRunId: row.chainRootRunId ?? null,
      chainDepth: row.chainDepth ?? 0,
      stagedInputs: stagedInputsOf(row.stagedInputs),
      goal: typeof goal === 'string' ? goal : '',
      originSessionId: typeof originSessionId === 'string' ? originSessionId : null,
    },
  };
}

type Candidate = {
  id: string;
  kind: string;
  createdByTool: string;
  dataset: string | null;
  expiresAt: Date;
  createdAt: Date;
  producerId: string | null;
  producerGrantId: string | null;
  producerChainRootRunId: string | null;
};

/** The first reason `c` cannot be carried into the continuation, or null. */
function dropReason(
  c: Candidate,
  root: string | null,
  grantId: string,
  permitted: ReadonlySet<string>,
  now: Date,
): ChainHandleDropReason | null {
  if (root === null || c.producerId === null) return 'outside_chain';
  if (c.producerId !== root && c.producerChainRootRunId !== root) return 'outside_chain';
  if (c.producerGrantId !== grantId) return 'other_grant';
  if (!isChainStageableKind(c)) return 'kind';
  if (c.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (c.createdByTool === 'export_dataset' && (c.dataset === null || !permitted.has(c.dataset))) {
    return 'dataset_not_permitted';
  }
  return null;
}

/**
 * The handles a continuation of `prior` may stage: what the prior itself was
 * allowed to stage (its chain's earlier files) plus the outputs and dataset
 * exports the prior produced, each re-validated against the chain, the grant,
 * its kind, its expiry and THIS launch's frozen export grants. Never extends
 * an artifact's lifetime. A handle the chat model named is never an input:
 * everything here is derived server-side from the prior run.
 */
export async function deriveChainHandles(input: {
  orgId: string;
  prior: AnalysisChainPrior;
  grantId: string;
  exportGrants: AiRunExportGrants;
}): Promise<{ handles: string[]; dropped: ChainHandleDrop[] }> {
  const { orgId, prior, grantId } = input;
  const priorHandles = [...new Set(prior.stagedInputs?.handles ?? [])];
  const queryable = priorHandles.filter(isUuid);
  const producedByPrior = and(
    eq(aiRunArtifacts.runId, prior.id),
    or(
      eq(aiRunArtifacts.kind, 'output'),
      and(eq(aiRunArtifacts.kind, 'input_capture'), eq(aiRunArtifacts.createdByTool, 'export_dataset')),
    ),
  );
  const rows: Candidate[] = await systemRead(() => db
    .select({
      id: aiRunArtifacts.id,
      kind: aiRunArtifacts.kind,
      createdByTool: aiRunArtifacts.createdByTool,
      dataset: aiRunArtifacts.dataset,
      expiresAt: aiRunArtifacts.expiresAt,
      createdAt: aiRunArtifacts.createdAt,
      producerId: aiAgentRuns.id,
      producerGrantId: aiAgentRuns.grantId,
      producerChainRootRunId: aiAgentRuns.chainRootRunId,
    })
    .from(aiRunArtifacts)
    .leftJoin(aiAgentRuns, and(eq(aiAgentRuns.id, aiRunArtifacts.runId), eq(aiAgentRuns.orgId, aiRunArtifacts.orgId)))
    .where(and(
      eq(aiRunArtifacts.orgId, orgId),
      queryable.length > 0 ? or(inArray(aiRunArtifacts.id, queryable), producedByPrior) : producedByPrior,
    )));

  const root = chainRootOf(prior);
  const permitted = new Set(input.exportGrants.datasets);
  const now = new Date();
  const dropped: ChainHandleDrop[] = [];
  const kept: Candidate[] = [];
  const seen = new Set<string>();
  for (const c of rows) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const reason = dropReason(c, root, grantId, permitted, now);
    if (reason) dropped.push({ handle: c.id, reason });
    else kept.push(c);
  }
  // A prior handle with no row at all was swept: it expired.
  for (const handle of priorHandles) {
    if (!seen.has(handle)) dropped.push({ handle, reason: 'expired' });
  }
  kept.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : 1));
  for (const c of kept.slice(ANALYSIS_CHAIN_HANDLE_CAP)) dropped.push({ handle: c.id, reason: 'over_cap' });
  return { handles: kept.slice(0, ANALYSIS_CHAIN_HANDLE_CAP).map((c) => c.id), dropped };
}

/** A snapshotted numeric limit, or the default when absent or not a number (never a cast error). */
function snapshotLimit(field: 'analysisMaxBudgetCentsPerRun' | 'analysisMaxComputeCentsPerRun'): SQL {
  const path = `{effective,limits,${field}}`;
  return sql`(CASE WHEN jsonb_typeof(policy_snapshot #> ${sql.raw(`'${path}'`)}) = 'number'
    THEN LEAST(GREATEST((policy_snapshot #>> ${sql.raw(`'${path}'`)})::numeric, 0), 1000000)::bigint
    ELSE ${sql.raw(String(AI_AGENT_LIMIT_DEFAULTS[field]))}::bigint END)`;
}

/**
 * What a chain has committed, for the chain bounds at admission. Called inside
 * the admission transaction, under the (agent, org) and analysis-compute
 * locks, so two concurrent continuations of one chain serialise here.
 *
 * Every run of the chain (root and members) counts, except a skipped one and
 * an admission whose enqueue failed (no worker will ever run it; its row may
 * be reclaimed). A settled run counts what it actually spent: model cost plus
 * settled compute (or its reservation, if settlement never landed). An
 * unsettled run counts at least its full per-run allowance from its OWN
 * policy snapshot, so a queued sibling cannot be under-counted at zero.
 */
export async function chainCommittedCents(
  tx: Pick<typeof db, 'execute'>,
  input: { orgId: string; chainRootRunId: string },
): Promise<{ committedCents: number; runCount: number }> {
  const spent = sql`(cost_cents + COALESCE(compute_cents, compute_reserved_cents, 0))`;
  const allowance = sql`(${snapshotLimit('analysisMaxBudgetCentsPerRun')} + ${snapshotLimit('analysisMaxComputeCentsPerRun')})`;
  const rows = await tx.execute(sql`
    SELECT count(*)::int AS "runCount",
      COALESCE(sum(CASE WHEN status IN ('completed', 'failed', 'cancelled', 'expired', 'blocked')
        THEN ${spent}
        ELSE GREATEST(${allowance}, ${spent}) END), 0)::bigint AS "committedCents"
    FROM ai_agent_runs
    WHERE org_id = ${input.orgId}
      AND (id = ${input.chainRootRunId} OR chain_root_run_id = ${input.chainRootRunId})
      AND status <> 'skipped'
      AND NOT (status = 'failed' AND coalesce(error_code, '') = 'enqueue_failed')
  `);
  const row = (rows as unknown as Array<{ runCount?: unknown; committedCents?: unknown }>)[0];
  return { committedCents: Number(row?.committedCents ?? 0), runCount: Number(row?.runCount ?? 0) };
}

/**
 * The fenced seed for a continuation of `prior`, from its submitted outcome
 * (`outcome.analysis`: summary + the first findings), falling back to the
 * `summary` column when there is no readable outcome.
 */
export async function buildAnalysisContinuationSeed(input: { orgId: string; prior: AnalysisChainPrior }): Promise<string> {
  const [row] = await systemRead(() => db
    .select({ summary: aiAgentRuns.summary, outcome: aiAgentRuns.outcome })
    .from(aiAgentRuns)
    .where(and(eq(aiAgentRuns.id, input.prior.id), eq(aiAgentRuns.orgId, input.orgId)))
    .limit(1));
  const parsed = analysisOutcomeSchema.safeParse((row?.outcome as { analysis?: unknown } | null | undefined)?.analysis);
  const summary = parsed.success ? parsed.data.summary : (row?.summary ?? null);
  const findings = parsed.success
    ? parsed.data.findings.slice(0, SEED_FINDINGS_LIMIT).map((f) => ({ severity: f.severity, title: f.title }))
    : [];
  return renderAnalysisContinuationSeed({ fromRunId: input.prior.id, goal: input.prior.goal, summary, findings });
}

/**
 * Manifest entries for the run's frozen handles, newest first, with each
 * producer run's chain depth. Missing handles are omitted. Runs inside the
 * CALLER's DB context and opens none of its own.
 */
export async function loadHandleManifest(input: { orgId: string; handles: string[] }): Promise<AnalysisManifestEntry[]> {
  const handles = [...new Set(input.handles)].filter(isUuid);
  if (handles.length === 0) return [];
  const rows = await db
    .select({
      handle: aiRunArtifacts.id,
      name: aiRunArtifacts.name,
      bytes: aiRunArtifacts.bytes,
      contentType: aiRunArtifacts.contentType,
      kind: aiRunArtifacts.kind,
      producedByRunId: aiAgentRuns.id,
      producerChainDepth: aiAgentRuns.chainDepth,
    })
    .from(aiRunArtifacts)
    .leftJoin(aiAgentRuns, and(eq(aiAgentRuns.id, aiRunArtifacts.runId), eq(aiAgentRuns.orgId, aiRunArtifacts.orgId)))
    .where(and(eq(aiRunArtifacts.orgId, input.orgId), inArray(aiRunArtifacts.id, handles)))
    .orderBy(desc(aiRunArtifacts.createdAt));
  return rows.map((r) => ({
    handle: r.handle,
    name: r.name,
    bytes: Number(r.bytes),
    contentType: r.contentType,
    kind: r.kind,
    producedByRunId: r.producedByRunId ?? null,
    producerChainDepth: r.producedByRunId ? (r.producerChainDepth ?? null) : null,
  }));
}
