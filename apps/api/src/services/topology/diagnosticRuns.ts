import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';

import { canonicalizeArguments, computeArgumentDigest } from '@breeze/shared/canonicalize';
import {
  createTopologyDiagnosticSchema,
  topologyDiagnosticRunSchema,
  type CreateTopologyDiagnosticRequest,
  type TopologyDiagnosticPlan,
  type TopologyDiagnosticRun,
  type TopologyDiagnosticStep,
} from '@breeze/shared';

import { db } from '../../db';
import {
  topologyChangeOutbox,
  topologyDiagnosticRuns,
  topologyDiagnosticSteps,
} from '../../db/schema';
import { hasSatisfiedMfa } from '../../middleware/auth';
import { requireTopologySiteAccess, type TopologyRequestContext } from './access';
import {
  TOPOLOGY_DIAGNOSTIC_INTENT_EVENT,
  type TopologyDiagnosticIntent,
} from './diagnosticIntent';
import type { DiagnosticPlanningRepository } from './diagnosticTypes';

export {
  TOPOLOGY_DIAGNOSTIC_INTENT_EVENT,
  type TopologyDiagnosticIntent,
  type TopologyDiagnosticIntentState,
} from './diagnosticIntent';

import { planTopologyDiagnostic } from './diagnosticPlanner';
import { loadTopologyFlags } from './flags';
import { freezeTopologyTraceRequester } from './diagnosticTraceAuthority';
import { recordTopologyDiagnosticDispatch, type TopologyDispatchStatus, type TopologyMetricRecipe } from './metrics';
import { TopologyOperationError } from './operationErrors';

/** Fixed on-demand budgets from the operations spec (§9). */
export const TOPOLOGY_DIAGNOSTIC_QUOTAS = {
  activeRunsPerAgent: 2,
  activeRunsPerSite: 4,
  activeRunsPerOrg: 20,
  startsPerUserPerMinute: 10,
  startsPerSitePerMinute: 30,
  startsPerOrgPerMinute: 120,
} as const;

export type TopologyDiagnosticQuotas = typeof TOPOLOGY_DIAGNOSTIC_QUOTAS;

export type TopologyDiagnosticUsage = {
  activeForAgent: number;
  activeForSite: number;
  activeForOrg: number;
  startsForUser: number;
  startsForSite: number;
  startsForOrg: number;
};

export type TopologyDiagnosticQuotaRefusal = {
  reason: string;
  retryAfterSeconds: number;
};

/** An active run frees its slot within one absolute lifetime; a start rate within a minute. */
const RUN_LIFETIME_SECONDS = 120;
const START_WINDOW_SECONDS = 60;

/**
 * Narrowest budget first, so the message names the thing the caller can
 * actually act on (their own agent) before the tenant-wide ceiling.
 */
export function exceededTopologyDiagnosticQuota(
  usage: TopologyDiagnosticUsage,
  quotas: TopologyDiagnosticQuotas = TOPOLOGY_DIAGNOSTIC_QUOTAS,
): TopologyDiagnosticQuotaRefusal | null {
  const checks: Array<[number, number, string, number]> = [
    [usage.activeForAgent, quotas.activeRunsPerAgent, 'agent_concurrency', RUN_LIFETIME_SECONDS],
    [usage.activeForSite, quotas.activeRunsPerSite, 'site_concurrency', RUN_LIFETIME_SECONDS],
    [usage.activeForOrg, quotas.activeRunsPerOrg, 'organization_concurrency', RUN_LIFETIME_SECONDS],
    [usage.startsForUser, quotas.startsPerUserPerMinute, 'user_start_rate', START_WINDOW_SECONDS],
    [usage.startsForSite, quotas.startsPerSitePerMinute, 'site_start_rate', START_WINDOW_SECONDS],
    [usage.startsForOrg, quotas.startsPerOrgPerMinute, 'organization_start_rate', START_WINDOW_SECONDS],
  ];
  for (const [used, ceiling, reason, retryAfterSeconds] of checks) {
    if (used >= ceiling) return { reason, retryAfterSeconds };
  }
  return null;
}

/**
 * Digest of the NORMALIZED request, so a replay that only reorders keys or
 * drops an absent optional field is the same request, while any meaningful
 * change is a conflict rather than a silent second run.
 */
export function topologyDiagnosticBodyHash(request: CreateTopologyDiagnosticRequest): string {
  const normalized = createTopologyDiagnosticSchema.parse(request);
  return computeArgumentDigest(canonicalizeArguments({ value: normalized }));
}

type RunRow = typeof topologyDiagnosticRuns.$inferSelect;
type StepRow = typeof topologyDiagnosticSteps.$inferSelect;

const iso = (value: Date | null) => (value === null ? null : value.toISOString());

/** Re-order persisted step evidence into the accepted plan's own order. */
export function topologyDiagnosticRunView(row: RunRow, steps: StepRow[]): TopologyDiagnosticRun {
  const plan = row.plan as TopologyDiagnosticPlan;
  const byStepId = new Map(steps.map((step) => [step.stepId, step.result as TopologyDiagnosticStep]));
  const ordered = plan.steps
    .map((step) => byStepId.get(step.id))
    .filter((step): step is TopologyDiagnosticStep => step !== undefined);

  return topologyDiagnosticRunSchema.parse({
    id: row.id,
    attemptId: row.attemptId,
    commandId: row.commandId,
    state: row.state,
    plan,
    assessment: row.assessment,
    coverage: row.coverage,
    reasons: row.reasons,
    steps: ordered,
    queuedAt: row.queuedAt.toISOString(),
    startedAt: iso(row.startedAt),
    deadline: row.deadline.toISOString(),
    finishedAt: iso(row.finishedAt),
    cancelRequestedAt: iso(row.cancelRequestedAt),
    failureReason: row.failureReason,
  });
}

const hiddenRun = () =>
  new TopologyOperationError('diagnostic_run_not_found', 404, 'Diagnostic run not found');

async function loadRunInScope(ctx: TopologyRequestContext, runId: string): Promise<RunRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return null;
  const [row] = await db
    .select()
    .from(topologyDiagnosticRuns)
    .where(
      and(
        eq(topologyDiagnosticRuns.id, runId),
        eq(topologyDiagnosticRuns.orgId, ctx.scope.orgId),
        eq(topologyDiagnosticRuns.siteId, ctx.scope.siteId),
      ),
    )
    .limit(1);
  return row ?? null;
}

function stepsForRun(runId: string) {
  return db
    .select()
    .from(topologyDiagnosticSteps)
    .where(eq(topologyDiagnosticSteps.runId, runId))
    .orderBy(asc(topologyDiagnosticSteps.createdAt), asc(topologyDiagnosticSteps.id));
}

/**
 * Re-derive the requester's CURRENT authority. Called before an acceptance and
 * before returning an idempotent replay: a preexisting idempotency record must
 * never disclose a run the caller has since lost access to.
 */
async function requireDiagnosticAuthority(ctx: TopologyRequestContext): Promise<void> {
  const current = await requireTopologySiteAccess(
    ctx.auth,
    ctx.permissions,
    ctx.scope.siteId,
    'execute',
  );
  if (current.scope.orgId !== ctx.scope.orgId) {
    throw new TopologyOperationError('topology_site_not_found', 404);
  }
  if (!hasSatisfiedMfa(ctx.auth) || ctx.auth.principal?.kind === 'ai_agent') {
    throw new TopologyOperationError('mfa_required', 403);
  }
  const flags = await loadTopologyFlags(ctx);
  if (!flags.materialization || !flags.diagnostics) {
    throw new TopologyOperationError('diagnostics_disabled', 409);
  }
}

/**
 * Advisory-lock salt for topology diagnostic starts. Paired with the org id it
 * keeps this lock from colliding with any other feature's org-keyed lock.
 */
const TOPOLOGY_DIAGNOSTIC_START_LOCK_SALT = 0x746f7064; // "topd"

/** Anything that can run the usage count — the pool, or an open transaction. */
type DiagnosticQuotaExecutor = Pick<typeof db, 'execute'>;

async function readUsage(
  executor: DiagnosticQuotaExecutor,
  ctx: TopologyRequestContext,
  deviceId: string,
): Promise<TopologyDiagnosticUsage> {
  const active = sql`state IN ('queued','running')`;
  const recent = sql`queued_at > now() - interval '${sql.raw(String(START_WINDOW_SECONDS))} seconds'`;
  const [row] = await executor.execute<{
    active_agent: string;
    active_site: string;
    active_org: string;
    starts_user: string;
    starts_site: string;
    starts_org: string;
  }>(sql`
    SELECT
      count(*) FILTER (WHERE ${active} AND origin_snapshot->>'deviceId' = ${deviceId}) AS active_agent,
      count(*) FILTER (WHERE ${active} AND site_id = ${ctx.scope.siteId}::uuid) AS active_site,
      count(*) FILTER (WHERE ${active}) AS active_org,
      count(*) FILTER (WHERE ${recent} AND requester_id = ${ctx.auth.user.id}::uuid AND policy_id IS NULL) AS starts_user,
      count(*) FILTER (WHERE ${recent} AND site_id = ${ctx.scope.siteId}::uuid) AS starts_site,
      count(*) FILTER (WHERE ${recent}) AS starts_org
    FROM topology_diagnostic_runs
    WHERE org_id = ${ctx.scope.orgId}::uuid
  `);
  return {
    activeForAgent: Number(row?.active_agent ?? 0),
    activeForSite: Number(row?.active_site ?? 0),
    activeForOrg: Number(row?.active_org ?? 0),
    startsForUser: Number(row?.starts_user ?? 0),
    startsForSite: Number(row?.starts_site ?? 0),
    startsForOrg: Number(row?.starts_org ?? 0),
  };
}

function subjectColumns(subject: CreateTopologyDiagnosticRequest['subject']) {
  return {
    subjectNodeId: subject.kind === 'node' ? subject.id : null,
    subjectRelationshipId: subject.kind === 'relationship' ? subject.id : null,
    subjectTargetId: subject.kind === 'destination' ? subject.id : null,
  };
}

/**
 * One claimed scheduled slot (M3 Task 7 / M3-D11). The occurrence key is the
 * run's idempotency key AND the unique (policy, context, family, slot) claim,
 * so a replica that lost the race replays instead of creating a second run.
 */
export type TopologyScheduledOccurrence = {
  policyId: string;
  policyRevision: string;
  contextKey: string;
  family: 'ipv4' | 'ipv6';
  scheduledFor: Date;
  occurrenceKey: string;
  continuityKey: string;
};

export type CreateTopologyDiagnosticRunOptions = {
  /** Task 14 planning seam; tests and M3 scheduling supply their own. */
  repository?: DiagnosticPlanningRepository;
  /** Present only for a scheduled policy occurrence; on-demand runs omit it. */
  scheduledOccurrence?: TopologyScheduledOccurrence;
  /**
   * The requester's permission authority version, already witnessed by the
   * caller OUTSIDE any lock-holding transaction (the scheduler takes it from
   * the live re-derivation). When present the freeze does not read Redis —
   * the scheduler calls this under the policy row lock (T4).
   */
  requesterPermissionVersion?: string;
};

/**
 * Accept one on-demand run: authority, budget, compiled plan, persisted run and
 * a durable dispatch intent, all in one transaction. Nothing here touches the
 * network — delivery is the worker's job, strictly after this commits.
 */
export async function createTopologyDiagnosticRun(
  ctx: TopologyRequestContext,
  input: CreateTopologyDiagnosticRequest,
  idempotencyKey: string,
  options: CreateTopologyDiagnosticRunOptions = {},
): Promise<TopologyDiagnosticRun> {
  const started = performance.now();
  const recipe = (input as { recipeId?: unknown } | null)?.recipeId;
  const observe = (status: TopologyDispatchStatus) =>
    recordTopologyDiagnosticDispatch(String(recipe) as TopologyMetricRecipe, status, (performance.now() - started) / 1000);
  try {
    const run = await acceptTopologyDiagnosticRun(ctx, input, idempotencyKey, options);
    observe(run.state as TopologyDispatchStatus);
    return run;
  } catch (error) {
    observe(error instanceof TopologyOperationError ? 'rejected' : 'error');
    throw error;
  }
}

async function acceptTopologyDiagnosticRun(
  ctx: TopologyRequestContext,
  input: CreateTopologyDiagnosticRequest,
  idempotencyKey: string,
  options: CreateTopologyDiagnosticRunOptions,
): Promise<TopologyDiagnosticRun> {
  const request = createTopologyDiagnosticSchema.parse(input);
  const occurrence = options.scheduledOccurrence;
  if (occurrence && (occurrence.occurrenceKey !== idempotencyKey || request.recipeId === 'trace_route'
    || request.contextKey !== occurrence.contextKey || request.family !== occurrence.family)) {
    throw new TopologyOperationError('occurrence_mismatch', 400, 'Scheduled occurrence does not match its request');
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 255) {
    throw new TopologyOperationError('idempotency_key_required', 400, 'An Idempotency-Key is required');
  }

  await requireDiagnosticAuthority(ctx);
  const bodyHash = topologyDiagnosticBodyHash(request);

  const existing = await findRunByIdempotencyKey(ctx, idempotencyKey);
  if (existing) return replayRun(existing, bodyHash);

  const plan = await planTopologyDiagnostic(ctx, request, options.repository);
  if (plan.scope.orgId !== ctx.scope.orgId || plan.scope.siteId !== ctx.scope.siteId) {
    throw new TopologyOperationError('topology_site_not_found', 404);
  }

  // M3-D13: a routed trace carries its requester authority so every later
  // boundary (enqueue, delivery, result publication) can re-derive it live.
  // A scheduled occurrence carries it too: its requester is the policy's
  // arming actor, re-derived at every later boundary (generalized M3-D13).
  const requesterAuthority = plan.recipeId === 'trace_route' || occurrence
    ? await freezeTopologyTraceRequester(ctx, options.requesterPermissionVersion !== undefined
      ? { permissionVersion: async () => options.requesterPermissionVersion! }
      : {})
    : null;

  const inserted = await db.transaction(async (tx) => {
    // The budget is a check-then-insert, so it only holds if nothing else can
    // insert between the two. Diagnostic starts are rare, so one advisory lock
    // per ORG — taken inside this transaction and released with it — is enough
    // to serialize them; without it N concurrent requests carrying distinct
    // Idempotency-Keys each counted zero active runs and were all accepted.
    await lockDiagnosticStarts(tx, ctx);
    return persistAcceptedRun(tx, ctx, plan, { idempotencyKey, bodyHash, requesterAuthority, occurrence });
  });

  if (!inserted) {
    // Lost the insert race against a concurrent replay of the same key.
    const raced = await findRunByIdempotencyKey(ctx, idempotencyKey);
    if (!raced) throw new TopologyOperationError('topology_dispatch_unavailable', 503);
    return replayRun(raced, bodyHash);
  }
  return topologyDiagnosticRunView(inserted, []);
}

type DiagnosticStartTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockDiagnosticStarts(tx: DiagnosticStartTx, ctx: TopologyRequestContext): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${TOPOLOGY_DIAGNOSTIC_START_LOCK_SALT}::int, hashtext(${ctx.scope.orgId})::int)`,
  );
}

/**
 * Budget check, run row and durable dispatch intent — on the caller's
 * transaction, strictly after `lockDiagnosticStarts`. Shared by the ordinary
 * start and the verified (approved AI proposal) start so both write the SAME
 * M1 run + outbox rows.
 */
async function persistAcceptedRun(
  tx: DiagnosticStartTx,
  ctx: TopologyRequestContext,
  plan: TopologyDiagnosticPlan,
  args: {
    idempotencyKey: string;
    bodyHash: string;
    requesterAuthority: Awaited<ReturnType<typeof freezeTopologyTraceRequester>> | null;
    occurrence?: TopologyScheduledOccurrence;
  },
): Promise<RunRow | null> {
  const { idempotencyKey, bodyHash, requesterAuthority, occurrence } = args;
  const runId = randomUUID();
  const attemptId = randomUUID();
  const intent: TopologyDiagnosticIntent = {
    version: 1,
    kind: TOPOLOGY_DIAGNOSTIC_INTENT_EVENT,
    runId,
    requesterId: ctx.auth.user.id,
    deviceId: plan.origin.deviceId,
    state: 'pending',
  };
  {
    // Counted on this same transaction/connection, behind the same lock as the
    // insert below.
    // Scheduled and on-demand runs share the concurrency semaphore; the
    // per-USER start rate is the human's budget and never counts a schedule.
    const usage = await readUsage(tx, ctx, plan.origin.deviceId);
    const refusal = exceededTopologyDiagnosticQuota(occurrence ? { ...usage, startsForUser: 0 } : usage);
    if (refusal) {
      throw new TopologyOperationError(
        'diagnostic_quota_exceeded',
        429,
        `Diagnostic budget exhausted (${refusal.reason})`,
        refusal.retryAfterSeconds,
      );
    }

    const [row] = await tx
      .insert(topologyDiagnosticRuns)
      .values({
        id: runId,
        orgId: ctx.scope.orgId,
        siteId: ctx.scope.siteId,
        recipeId: plan.recipeId,
        recipeVersion: plan.recipeVersion,
        requesterId: ctx.auth.user.id,
        requesterAuthority,
        ...subjectColumns(plan.subject),
        originNodeId: plan.origin.nodeId,
        originSnapshot: plan.origin,
        plan,
        planDigest: plan.digest,
        idempotencyKey,
        bodyHash,
        attemptId,
        queuedAt: new Date(plan.acceptedAt),
        queueDeadline: new Date(plan.queueDeadline),
        deadline: new Date(plan.deadline),
        ...(occurrence
          ? {
              policyId: occurrence.policyId,
              policyRevision: BigInt(occurrence.policyRevision),
              scheduledContextKey: occurrence.contextKey,
              scheduledFamily: occurrence.family,
              scheduledFor: occurrence.scheduledFor,
              occurrenceKey: occurrence.occurrenceKey,
              continuityKey: occurrence.continuityKey,
            }
          : {}),
      })
      .onConflictDoNothing({
        target: [
          topologyDiagnosticRuns.orgId,
          topologyDiagnosticRuns.siteId,
          topologyDiagnosticRuns.requesterId,
          topologyDiagnosticRuns.idempotencyKey,
        ],
      })
      .returning();
    if (!row) return null;

    // Same transaction as the run: a committed acceptance can never be left
    // without the intent that eventually dispatches it.
    await tx.insert(topologyChangeOutbox).values({
      orgId: ctx.scope.orgId,
      siteId: ctx.scope.siteId,
      eventKind: TOPOLOGY_DIAGNOSTIC_INTENT_EVENT,
      aggregateId: runId,
      sourceRevision: 0n,
      idempotencyKey: `diagnostic:${runId}`,
      payload: intent as unknown as Record<string, unknown>,
      deliveredAt: new Date(),
    });
    return row;
  }
}

/**
 * Topology M4 Task 4 (#6000): the start of an APPROVED AI proposal — an
 * explicitly typed internal entry point; the public diagnostic POST keeps
 * `createTopologyDiagnosticRun`.
 *
 * Differs from the ordinary start in exactly three ways:
 *   - the request's origin, context and family are REQUIRED (pinned by the
 *     approval); the compiler can never choose a different origin;
 *   - the session MFA claim is not authority: the caller's `authorize` proves
 *     the approval (fresh approver factor, intent/actor binding) instead, since
 *     a durable release's AuthContext synthesizes `mfa: true`;
 *   - the plan is resolved INSIDE the start transaction, after the org lock,
 *     by the caller's `resolvePlan` — which re-derives the pinned effect and
 *     binds the approval — so the final check and the persisted run share one
 *     short transaction.
 * The requester's authority is frozen on the run so every later boundary
 * (enqueue, both delivery transports, result publication) re-derives it live
 * (M3-D13 generalized). Everything else — idempotent replay, budgets, the run
 * row and its durable dispatch intent — is the same M1 path.
 */
export type VerifiedTopologyDiagnosticStart = {
  request: CreateTopologyDiagnosticRequest;
  authorize: (ctx: TopologyRequestContext) => Promise<void>;
  resolvePlan: (tx: DiagnosticStartTx) => Promise<TopologyDiagnosticPlan>;
};

export async function createVerifiedTopologyDiagnosticRun(
  ctx: TopologyRequestContext,
  start: VerifiedTopologyDiagnosticStart,
  idempotencyKey: string,
): Promise<TopologyDiagnosticRun> {
  const request = createTopologyDiagnosticSchema.parse(start.request);
  if (!request.originDeviceId || !request.contextKey || !request.family) {
    throw new TopologyOperationError('pinned_origin_required', 400, 'An approved diagnostic must pin its origin, context and family');
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 255) {
    throw new TopologyOperationError('idempotency_key_required', 400, 'An Idempotency-Key is required');
  }

  const current = await requireTopologySiteAccess(ctx.auth, ctx.permissions, ctx.scope.siteId, 'execute');
  if (current.scope.orgId !== ctx.scope.orgId) throw new TopologyOperationError('topology_site_not_found', 404);
  if (ctx.auth.principal?.kind === 'ai_agent') throw new TopologyOperationError('human_approval_required', 403);
  const flags = await loadTopologyFlags(ctx);
  if (!flags.materialization || !flags.diagnostics) throw new TopologyOperationError('diagnostics_disabled', 409);
  await start.authorize(ctx);

  const bodyHash = topologyDiagnosticBodyHash(request);
  const existing = await findRunByIdempotencyKey(ctx, idempotencyKey);
  if (existing) return replayRun(existing, bodyHash);

  const requesterAuthority = await freezeTopologyTraceRequester(ctx);
  const inserted = await db.transaction(async (tx) => {
    await lockDiagnosticStarts(tx, ctx);
    const plan = await start.resolvePlan(tx);
    if (
      plan.scope.orgId !== ctx.scope.orgId || plan.scope.siteId !== ctx.scope.siteId
      || plan.origin.deviceId !== request.originDeviceId || plan.origin.contextKey !== request.contextKey
      || plan.family !== request.family || plan.reasons.length > 0
    ) {
      throw new TopologyOperationError('content_changed', 409, 'The approved diagnostic no longer matches the site');
    }
    return persistAcceptedRun(tx, ctx, plan, { idempotencyKey, bodyHash, requesterAuthority });
  });

  if (!inserted) {
    const raced = await findRunByIdempotencyKey(ctx, idempotencyKey);
    if (!raced) throw new TopologyOperationError('topology_dispatch_unavailable', 503);
    return replayRun(raced, bodyHash);
  }
  return topologyDiagnosticRunView(inserted, []);
}

async function findRunByIdempotencyKey(
  ctx: TopologyRequestContext,
  idempotencyKey: string,
): Promise<RunRow | null> {
  const [row] = await db
    .select()
    .from(topologyDiagnosticRuns)
    .where(
      and(
        eq(topologyDiagnosticRuns.orgId, ctx.scope.orgId),
        eq(topologyDiagnosticRuns.siteId, ctx.scope.siteId),
        eq(topologyDiagnosticRuns.requesterId, ctx.auth.user.id),
        eq(topologyDiagnosticRuns.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function replayRun(row: RunRow, bodyHash: string): Promise<TopologyDiagnosticRun> {
  if (row.bodyHash !== bodyHash) {
    throw new TopologyOperationError(
      'idempotency_key_conflict',
      409,
      'Idempotency-Key was reused for a different request',
    );
  }
  return topologyDiagnosticRunView(row, await stepsForRun(row.id));
}

export async function getTopologyDiagnosticRun(
  ctx: TopologyRequestContext,
  runId: string,
): Promise<TopologyDiagnosticRun | null> {
  const current = await requireTopologySiteAccess(
    ctx.auth,
    ctx.permissions,
    ctx.scope.siteId,
    'read',
  );
  if (current.scope.orgId !== ctx.scope.orgId) return null;
  const row = await loadRunInScope(ctx, runId);
  return row ? topologyDiagnosticRunView(row, await stepsForRun(row.id)) : null;
}

/**
 * Persist the stop request first, then let the durable machinery act on it: an
 * undispatched run settles immediately, a dispatched one stays "stop requested"
 * while delivery revalidation refuses its command and the worker sends a
 * best-effort agent cancellation. Nothing here waits on a socket.
 */
export async function cancelTopologyDiagnosticRun(
  ctx: TopologyRequestContext,
  runId: string,
): Promise<TopologyDiagnosticRun> {
  await requireDiagnosticAuthority(ctx);
  const existing = await loadRunInScope(ctx, runId);
  if (!existing) throw hiddenRun();

  const terminal = ['completed', 'failed', 'cancelled', 'expired'];
  if (!terminal.includes(existing.state)) {
    const now = new Date();
    const undispatched = existing.commandId === null && existing.state === 'queued';
    await db
      .update(topologyDiagnosticRuns)
      .set({
        cancelRequestedAt: existing.cancelRequestedAt ?? now,
        updatedAt: now,
        ...(undispatched
          ? { state: 'cancelled', finishedAt: now, failureReason: 'cancelled_before_dispatch' }
          : {}),
      })
      .where(
        and(
          eq(topologyDiagnosticRuns.id, existing.id),
          eq(topologyDiagnosticRuns.orgId, ctx.scope.orgId),
          eq(topologyDiagnosticRuns.state, existing.state),
        ),
      );
    if (!undispatched) await markIntentCancelling(ctx, existing.id);
  }

  const row = await loadRunInScope(ctx, runId);
  if (!row) throw hiddenRun();
  return topologyDiagnosticRunView(row, await stepsForRun(row.id));
}

/** Hand the agent-facing stop to the dispatch worker, which owns delivery. */
async function markIntentCancelling(ctx: TopologyRequestContext, runId: string): Promise<void> {
  await db
    .update(topologyChangeOutbox)
    .set({
      payload: sql`jsonb_set(${topologyChangeOutbox.payload}, '{state}', '"cancelling"')`,
      nextAttemptAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(topologyChangeOutbox.orgId, ctx.scope.orgId),
        eq(topologyChangeOutbox.aggregateId, runId),
        eq(topologyChangeOutbox.eventKind, TOPOLOGY_DIAGNOSTIC_INTENT_EVENT),
        sql`${topologyChangeOutbox.payload}->>'state' = 'dispatched'`,
      ),
    );
}
