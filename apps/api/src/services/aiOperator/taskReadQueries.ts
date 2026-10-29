/**
 * The Operator task READ queries (list, detail, plan), moved verbatim out of
 * `routes/aiOperatorTasks.ts` (full-control W10, #6780) so the REST routes and
 * the `list_operator_tasks` / `get_operator_task` tools share one copy of the
 * rules. Nothing here is new behaviour: every predicate, cap and mapper is the
 * route's own. The tool-specific redaction lives in `aiToolsOperatorTasksRead`.
 *
 * Runs on the CALLER's db context (RLS applies) with the explicit org
 * predicate (`auth.orgCondition`) beside it.
 */
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type {
  AiOperatorPlanApprovalDto,
  AiOperatorPlanEffectDto,
  AiOperatorTaskState,
  AiOperatorTaskDto,
  AiOperatorTaskListItemDto,
  CreatedAccountView,
} from '@breeze/shared';
import { db } from '../../db';
import {
  aiAgentRuns,
  aiOperatorOperations,
  aiOperatorPlanApprovalEffects,
  aiOperatorPlanApprovals,
  aiOperatorTaskEvents,
  aiOperatorTaskSteps,
  aiOperatorTaskTargetAccounts,
  aiOperatorTaskTargets,
  aiOperatorTasks,
  devices,
  users,
  wispGrants,
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { runSiteScopeCondition } from '../aiAgentRunSiteScope';
import { listCreatedAccountsForTask } from './credentialHandover';
import { IDENTITY_ONBOARDING_WORKFLOW_KEY } from './recipes/identityOnboarding';
import { planEffectOperationKey } from './planApproval';
import {
  mapOperatorTask,
  mapOperatorTaskListItem,
  type OperatorEventRowInput,
  type OperatorOperationRowInput,
  type OperatorRunLinkRowInput,
  type OperatorStepRowInput,
  type OperatorTargetAccountRowInput,
  type OperatorTargetRowInput,
  type OperatorTaskRowInput,
} from './taskReadService';
import {
  buildOperatorTasksKeysetPredicate,
  decodeOperatorTasksCursor,
  encodeOperatorTasksCursor,
  operatorTasksCursorFromRow,
} from './operatorTasksListCursor';

const TASK_ROW_COLUMNS = {
  id: aiOperatorTasks.id,
  orgId: aiOperatorTasks.orgId,
  agentId: aiOperatorTasks.agentId,
  // Frozen at admission (spec §11.3) — NOT a live join to `ai_agents`. See
  // `AiOperatorTaskDto.agent`'s docstring in `@breeze/shared` for why these
  // two columns live directly on `ai_operator_tasks` and are never null.
  agentKind: aiOperatorTasks.agentKind,
  agentName: aiOperatorTasks.agentName,
  workflowKey: aiOperatorTasks.workflowKey,
  workflowVersion: aiOperatorTasks.workflowVersion,
  mode: aiOperatorTasks.mode,
  originKind: aiOperatorTasks.originKind,
  objective: aiOperatorTasks.objective,
  deviceId: aiOperatorTasks.deviceId,
  targetLabel: aiOperatorTasks.targetLabel,
  targetDetachedAt: aiOperatorTasks.targetDetachedAt,
  targetDetachedReason: aiOperatorTasks.targetDetachedReason,
  state: aiOperatorTasks.state,
  phase: aiOperatorTasks.phase,
  waitReason: aiOperatorTasks.waitReason,
  waitDependencyKind: aiOperatorTasks.waitDependencyKind,
  waitDependencyId: aiOperatorTasks.waitDependencyId,
  revision: aiOperatorTasks.revision,
  attemptOrdinal: aiOperatorTasks.attemptOrdinal,
  currentStepKey: aiOperatorTasks.currentStepKey,
  deadlineAt: aiOperatorTasks.deadlineAt,
  nextWakeAt: aiOperatorTasks.nextWakeAt,
  outcome: aiOperatorTasks.outcome,
  outcomeDetail: aiOperatorTasks.outcomeDetail,
  handoffSummary: aiOperatorTasks.handoffSummary,
  accountingRootTaskId: aiOperatorTasks.accountingRootTaskId,
  successorOfTaskId: aiOperatorTasks.successorOfTaskId,
  createdAt: aiOperatorTasks.createdAt,
  updatedAt: aiOperatorTasks.updatedAt,
  // W07 "Wisp for <user>" provenance — joined under the request db context;
  // an RLS-hidden grant row yields a null grantorUserId and `wisp: null`.
  grantId: aiOperatorTasks.grantId,
  requestedByRunId: aiOperatorTasks.requestedByRunId,
  depth: aiOperatorTasks.depth,
  grantorUserId: wispGrants.grantorUserId,
  grantorName: users.name,
} as const;

/**
 * Site-restriction predicate shared by list and detail: a task with no
 * device target is never site-gated (there is nothing to check); a task with
 * a device target is visible only when that device's site is in the caller's
 * allowlist. `undefined` allowlist means unrestricted (org/partner/system
 * scope, or an organization-scope caller with no site restriction) — mirrors
 * `auth.canAccessSite`'s own `if (!allowedSiteIds) return true` contract
 * (`middleware/auth.ts`'s `siteAccessCheck`).
 */
function siteVisibilityCondition(allowedSiteIds: string[] | undefined): SQL | undefined {
  if (!allowedSiteIds) return undefined;
  return or(
    isNull(aiOperatorTasks.deviceId),
    allowedSiteIds.length > 0 ? inArray(devices.siteId, allowedSiteIds) : sql`false`,
  );
}

export interface OperatorTaskListQuery {
  cursorToken?: string;
  limit: number;
  deviceId?: string;
  state?: AiOperatorTaskState;
}

export type OperatorTaskListResult =
  | { ok: false; error: 'invalid_cursor' }
  | { ok: true; data: AiOperatorTaskListItemDto[]; nextCursor: string | null };

/** `GET /ai/operator/tasks`: the org-wide keyset-paginated list (newest-created first). */
export async function listOperatorTasks(auth: AuthContext, params: OperatorTaskListQuery): Promise<OperatorTaskListResult> {
  const { cursorToken, limit, deviceId, state } = params;

  const cursor = decodeOperatorTasksCursor(cursorToken);
  if (cursorToken && !cursor) {
    return { ok: false, error: 'invalid_cursor' };
  }

  const conditions: (SQL | undefined)[] = [
    auth.orgCondition(aiOperatorTasks.orgId),
    siteVisibilityCondition(auth.allowedSiteIds),
  ];
  if (deviceId) conditions.push(eq(aiOperatorTasks.deviceId, deviceId));
  if (state) conditions.push(eq(aiOperatorTasks.state, state));
  if (cursor) conditions.push(buildOperatorTasksKeysetPredicate(cursor));

  // Peek one extra row past `limit` to detect "is there a next page" —
  // mirrors `GET /ai/agents/runs`'s cursor-mode convention.
  let query = db
    .select({
      ...TASK_ROW_COLUMNS,
      // Full microsecond-precision text of createdAt, for the cursor only —
      // see OperatorTasksCursor.c's docstring for why a JS Date must never
      // seed this.
      createdAtRaw: sql<string>`to_char(${aiOperatorTasks.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(aiOperatorTasks)
    .leftJoin(wispGrants, eq(aiOperatorTasks.grantId, wispGrants.id))
    .leftJoin(users, eq(wispGrants.grantorUserId, users.id))
    .$dynamic();

  // LEFT-join `devices` only when the caller is actually site-restricted
  // (review fix, PR #5254) — an unrestricted caller's `siteVisibilityCondition`
  // is `undefined` and contributes no predicate, so forcing the join into
  // every plan regardless bought nothing but a second FORCE-RLS table in
  // every unrestricted list query.
  if (auth.allowedSiteIds !== undefined) {
    query = query.leftJoin(devices, eq(aiOperatorTasks.deviceId, devices.id));
  }

  const rows = await query
    .where(and(...conditions))
    .orderBy(desc(aiOperatorTasks.createdAt), desc(aiOperatorTasks.id))
    .limit(limit + 1);

  let nextCursor: string | null = null;
  let pageRows = rows;
  if (rows.length > limit) {
    pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    if (last) nextCursor = encodeOperatorTasksCursor(operatorTasksCursorFromRow(last));
  }

  const data: AiOperatorTaskListItemDto[] = pageRows.map((row) =>
    mapOperatorTaskListItem(row as OperatorTaskRowInput),
  );
  return { ok: true, data, nextCursor };
}

export type OperatorTaskDetail = AiOperatorTaskDto & {
  plan: AiOperatorPlanApprovalDto[];
  accounts?: CreatedAccountView[];
};

/**
 * The task's id, org and state when the caller can see it — the same org and
 * site-visibility predicate as the detail — or null. For write routes that
 * need the task's org without loading the whole detail.
 */
export async function findVisibleTask(
  auth: AuthContext,
  taskId: string,
): Promise<{ id: string; orgId: string; state: string } | null> {
  const [task] = await db
    .select({ id: aiOperatorTasks.id, orgId: aiOperatorTasks.orgId, state: aiOperatorTasks.state })
    .from(aiOperatorTasks)
    .leftJoin(devices, eq(aiOperatorTasks.deviceId, devices.id))
    .where(and(
      eq(aiOperatorTasks.id, taskId),
      auth.orgCondition(aiOperatorTasks.orgId),
      siteVisibilityCondition(auth.allowedSiteIds),
    ))
    .limit(1);
  return task ?? null;
}

/** `GET /ai/operator/tasks/:id`: the detail, or null when absent / outside the caller's org or site visibility. */
export async function loadOperatorTaskDetail(auth: AuthContext, taskId: string): Promise<OperatorTaskDetail | null> {
  const [task] = await db
    .select(TASK_ROW_COLUMNS)
    .from(aiOperatorTasks)
    .leftJoin(wispGrants, eq(aiOperatorTasks.grantId, wispGrants.id))
    .leftJoin(users, eq(wispGrants.grantorUserId, users.id))
    // LEFT — present only to evaluate the site-visibility predicate below.
    .leftJoin(devices, eq(aiOperatorTasks.deviceId, devices.id))
    .where(
      and(
        eq(aiOperatorTasks.id, taskId),
        auth.orgCondition(aiOperatorTasks.orgId),
        siteVisibilityCondition(auth.allowedSiteIds),
      ),
    )
    .limit(1);
  if (!task) return null;

  const [operationRows, runRows, targetRows, accountRows, stepRows, eventRows] = await Promise.all([
    db
      .select({
        operationKey: aiOperatorOperations.operationKey,
        attemptOrdinal: aiOperatorOperations.attemptOrdinal,
        intentId: aiOperatorOperations.intentId,
        dispatchState: aiOperatorOperations.dispatchState,
        resultState: aiOperatorOperations.resultState,
        executionRefKind: aiOperatorOperations.executionRefKind,
        executionRefId: aiOperatorOperations.executionRefId,
        dispatchedAt: aiOperatorOperations.dispatchedAt,
        resultAt: aiOperatorOperations.resultAt,
      })
      .from(aiOperatorOperations)
      // org_id repeated in the predicate as defence-in-depth beside RLS,
      // matching `GET /runs/:runId`'s posture — RLS is the real boundary
      // (breeze_current_scope() defaults to 'none', so a contextless read
      // already returns nothing), but the unit-test path mocks the db with
      // no RLS at all.
      .where(and(eq(aiOperatorOperations.taskId, task.id), eq(aiOperatorOperations.orgId, task.orgId)))
      .orderBy(aiOperatorOperations.operationKey, aiOperatorOperations.attemptOrdinal)
      // Defence-in-depth cap (review fix, PR #5254): nothing produces real
      // volume yet (the coordinator is W08), but an unbounded array here
      // would be a real cost once a heavily-retried task exists.
      .limit(500),
    db
      .select({
        id: aiAgentRuns.id,
        status: aiAgentRuns.status,
        taskAttemptOrdinal: aiAgentRuns.taskAttemptOrdinal,
        promptVersion: aiAgentRuns.promptVersion,
        resolvedModel: aiAgentRuns.resolvedModel,
      })
      .from(aiAgentRuns)
      // A device-less task IS visible to a site-restricted caller (see
      // `siteVisibilityCondition`), but its linked runs carry their OWN
      // device target, which the task's null site says nothing about. Reuse
      // the run-scope predicate from `routes/aiAgents.ts` so this projection
      // can never disclose a run against a device outside the caller's sites.
      .where(and(
        eq(aiAgentRuns.taskId, task.id),
        eq(aiAgentRuns.orgId, task.orgId),
        runSiteScopeCondition(auth),
      ))
      .orderBy(desc(aiAgentRuns.queuedAt))
      .limit(500),
    // Wave E2 (#6167): the task graph. Every read repeats task_id AND org_id
    // beside RLS (same defence-in-depth posture as the two above) and carries
    // the same 500-row cap. Each projection NAMES its columns: a bare
    // `select()` would pull a step's `checkpoint` jsonb into the handler,
    // where only the mapper would stand between it and the response.
    db
      .select({
        id: aiOperatorTaskTargets.id,
        targetKind: aiOperatorTaskTargets.targetKind,
        deviceId: aiOperatorTaskTargets.deviceId,
        ticketId: aiOperatorTaskTargets.ticketId,
        contactId: aiOperatorTaskTargets.contactId,
        targetLabel: aiOperatorTaskTargets.targetLabel,
        targetOrdinal: aiOperatorTaskTargets.targetOrdinal,
        state: aiOperatorTaskTargets.state,
        detachedAt: aiOperatorTaskTargets.detachedAt,
        detachedReason: aiOperatorTaskTargets.detachedReason,
      })
      .from(aiOperatorTaskTargets)
      .where(and(eq(aiOperatorTaskTargets.taskId, task.id), eq(aiOperatorTaskTargets.orgId, task.orgId)))
      .orderBy(aiOperatorTaskTargets.targetOrdinal)
      .limit(500),
    db
      .select({
        targetId: aiOperatorTaskTargetAccounts.targetId,
        provider: aiOperatorTaskTargetAccounts.provider,
        m365ConnectionId: aiOperatorTaskTargetAccounts.m365ConnectionId,
        googleConnectionId: aiOperatorTaskTargetAccounts.googleConnectionId,
        externalId: aiOperatorTaskTargetAccounts.externalId,
        principalLabel: aiOperatorTaskTargetAccounts.principalLabel,
      })
      .from(aiOperatorTaskTargetAccounts)
      .where(and(
        eq(aiOperatorTaskTargetAccounts.taskId, task.id),
        eq(aiOperatorTaskTargetAccounts.orgId, task.orgId),
      ))
      .limit(500),
    db
      .select({
        id: aiOperatorTaskSteps.id,
        stepKey: aiOperatorTaskSteps.stepKey,
        stepKind: aiOperatorTaskSteps.stepKind,
        targetId: aiOperatorTaskSteps.targetId,
        attemptOrdinal: aiOperatorTaskSteps.attemptOrdinal,
        state: aiOperatorTaskSteps.state,
        planRevision: aiOperatorTaskSteps.planRevision,
        expectedCriterion: aiOperatorTaskSteps.expectedCriterion,
        dependencyKind: aiOperatorTaskSteps.dependencyKind,
        dependencyId: aiOperatorTaskSteps.dependencyId,
        detail: aiOperatorTaskSteps.detail,
        startedAt: aiOperatorTaskSteps.startedAt,
        settledAt: aiOperatorTaskSteps.settledAt,
        // NOT checkpoint — see the comment above.
      })
      .from(aiOperatorTaskSteps)
      .where(and(eq(aiOperatorTaskSteps.taskId, task.id), eq(aiOperatorTaskSteps.orgId, task.orgId)))
      .orderBy(aiOperatorTaskSteps.attemptOrdinal, aiOperatorTaskSteps.startedAt)
      .limit(500),
    db
      .select({
        id: aiOperatorTaskEvents.id,
        transitionSeq: aiOperatorTaskEvents.transitionSeq,
        eventType: aiOperatorTaskEvents.eventType,
        actorKind: aiOperatorTaskEvents.actorKind,
        actorUserId: aiOperatorTaskEvents.actorUserId,
        stepKey: aiOperatorTaskEvents.stepKey,
        targetId: aiOperatorTaskEvents.targetId,
        detail: aiOperatorTaskEvents.detail,
        createdAt: aiOperatorTaskEvents.createdAt,
      })
      .from(aiOperatorTaskEvents)
      .where(and(eq(aiOperatorTaskEvents.taskId, task.id), eq(aiOperatorTaskEvents.orgId, task.orgId)))
      // Newest first in SQL, re-sorted ascending by the mapper: the LIMIT has
      // to keep the MOST RECENT 500 events of a long-running task, not the
      // oldest 500 — a 14-day identity task can exceed 500 events, and
      // showing only its first ones would hide what it is doing now.
      .orderBy(desc(aiOperatorTaskEvents.transitionSeq))
      .limit(500),
  ]);

  const dto: AiOperatorTaskDto = mapOperatorTask(
    task as OperatorTaskRowInput,
    operationRows as OperatorOperationRowInput[],
    runRows as OperatorRunLinkRowInput[],
    targetRows as OperatorTargetRowInput[],
    accountRows as OperatorTargetAccountRowInput[],
    stepRows as OperatorStepRowInput[],
    eventRows as OperatorEventRowInput[],
  );
  // Appended AFTER every shipped field, so their bytes and order are unchanged.
  const plan = await readTaskPlan(task.id, task.orgId);
  // R2a (G6): an onboarding task appends `accounts` AFTER `plan`, read on this
  // request's own db context. Every other recipe's detail is left exactly as
  // it shipped (the R1b detail test pins `plan` as its last key).
  if (task.workflowKey === IDENTITY_ONBOARDING_WORKFLOW_KEY) {
    const accounts = (await listCreatedAccountsForTask(task.orgId, task.id)) satisfies CreatedAccountView[];
    return { ...dto, plan, accounts };
  }
  return { ...dto, plan };
}


/** Same cap as every sibling read on this route. */
const PLAN_READ_LIMIT = 500;

type PlanApprovalRow = {
  id: string; taskId: string; stepKey: string; planRevision: number; effectSetDigest: string; effectCount: number;
  intentId: string | null; state: AiOperatorPlanApprovalDto['state']; approvedByUserId: string | null;
  approvedAt: Date | null; supersededByRevision: number | null; createdAt: Date;
};
type PlanEffectRow = {
  approvalId: string; planRevision: number; ordinal: number; toolName: string;
  provider: AiOperatorPlanEffectDto['provider']; targetId: string | null; targetLabel: string;
  principalLabel: string | null; rendering: string; idempotencyClass: AiOperatorPlanEffectDto['idempotencyClass'];
};
type PlanOperationLinkRow = {
  operationKey: string; taskStepKey: string; planRevision: number | null;
  resultState: NonNullable<AiOperatorPlanEffectDto['operationState']>; noop: boolean;
};

/**
 * Every plan revision of one task, `superseded` included, on the REQUEST's db
 * context (RLS applies) with explicit `task_id` + `org_id` predicates on both
 * plan tables and on the operation link read, each capped like its siblings.
 *
 * An effect's `operationState` / `noop` come only from the operation row the
 * walk keyed to it: `planEffectOperationKey` over the approval's step and the
 * effect's revision, tool, target and ordinal (the key the walk itself
 * reserves under), AND that row's own `task_step_key` and `plan_revision`
 * agreeing. Anything else is `null` / `false` — never a guess. The raw
 * `result` jsonb never leaves SQL: only its `noop` flag is compared there.
 */
async function readTaskPlan(taskId: string, orgId: string): Promise<AiOperatorPlanApprovalDto[]> {
  const approvals = await db
    .select({
      id: aiOperatorPlanApprovals.id,
      taskId: aiOperatorPlanApprovals.taskId,
      stepKey: aiOperatorPlanApprovals.stepKey,
      planRevision: aiOperatorPlanApprovals.planRevision,
      effectSetDigest: aiOperatorPlanApprovals.effectSetDigest,
      effectCount: aiOperatorPlanApprovals.effectCount,
      intentId: aiOperatorPlanApprovals.intentId,
      state: aiOperatorPlanApprovals.state,
      approvedByUserId: aiOperatorPlanApprovals.approvedByUserId,
      approvedAt: aiOperatorPlanApprovals.approvedAt,
      supersededByRevision: aiOperatorPlanApprovals.supersededByRevision,
      createdAt: aiOperatorPlanApprovals.createdAt,
    })
    .from(aiOperatorPlanApprovals)
    .where(and(eq(aiOperatorPlanApprovals.taskId, taskId), eq(aiOperatorPlanApprovals.orgId, orgId)))
    // NEWEST first under the cap, so a long re-plan history drops the OLDEST
    // revisions, never the current one; re-sorted ascending below.
    .orderBy(desc(aiOperatorPlanApprovals.planRevision))
    .limit(PLAN_READ_LIMIT) as PlanApprovalRow[];
  if (approvals.length === 0) return [];
  approvals.sort((a, b) => a.planRevision - b.planRevision);

  const effects = await db
    .select({
      approvalId: aiOperatorPlanApprovalEffects.approvalId,
      planRevision: aiOperatorPlanApprovalEffects.planRevision,
      ordinal: aiOperatorPlanApprovalEffects.ordinal,
      toolName: aiOperatorPlanApprovalEffects.toolName,
      provider: aiOperatorPlanApprovalEffects.provider,
      targetId: aiOperatorPlanApprovalEffects.targetId,
      targetLabel: aiOperatorPlanApprovalEffects.targetLabel,
      principalLabel: aiOperatorPlanApprovalEffects.principalLabel,
      rendering: aiOperatorPlanApprovalEffects.rendering,
      idempotencyClass: aiOperatorPlanApprovalEffects.idempotencyClass,
    })
    .from(aiOperatorPlanApprovalEffects)
    .where(and(eq(aiOperatorPlanApprovalEffects.taskId, taskId), eq(aiOperatorPlanApprovalEffects.orgId, orgId)))
    // Same rule: the newest revisions' effects survive the cap.
    .orderBy(desc(aiOperatorPlanApprovalEffects.planRevision), aiOperatorPlanApprovalEffects.ordinal)
    .limit(PLAN_READ_LIMIT) as PlanEffectRow[];

  const approvalById = new Map(approvals.map((a) => [a.id, a]));
  const keyed = effects.flatMap((e) => {
    const approval = approvalById.get(e.approvalId);
    // An effect whose approval is not in this task's read is dropped, not re-homed.
    if (!approval || approval.planRevision !== e.planRevision) return [];
    let key: string | null = null;
    try {
      key = planEffectOperationKey({
        stepKey: approval.stepKey, planRevision: e.planRevision, toolName: e.toolName, targetId: e.targetId, ordinal: e.ordinal,
      });
    } catch {
      key = null; // an over-long key cannot be the walk's: no link
    }
    return [{ effect: e, approval, key }];
  });

  const keys = [...new Set(keyed.map((k) => k.key).filter((k): k is string => k !== null))];
  const ops = keys.length === 0 ? [] : await db
    .select({
      operationKey: aiOperatorOperations.operationKey,
      taskStepKey: aiOperatorOperations.taskStepKey,
      planRevision: aiOperatorOperations.planRevision,
      resultState: aiOperatorOperations.resultState,
      noop: sql<boolean>`coalesce((${aiOperatorOperations.result} ->> 'noop') = 'true', false)`,
    })
    .from(aiOperatorOperations)
    .where(and(
      eq(aiOperatorOperations.taskId, taskId),
      eq(aiOperatorOperations.orgId, orgId),
      inArray(aiOperatorOperations.operationKey, keys),
    ))
    .limit(PLAN_READ_LIMIT) as PlanOperationLinkRow[];
  const opsByKey = new Map<string, PlanOperationLinkRow[]>();
  for (const op of ops) opsByKey.set(op.operationKey, [...(opsByKey.get(op.operationKey) ?? []), op]);

  const effectsByApproval = new Map<string, AiOperatorPlanEffectDto[]>();
  for (const { effect, approval, key } of keyed) {
    const candidates = key ? opsByKey.get(key) ?? [] : [];
    const op = candidates.length === 1
      && candidates[0]!.taskStepKey === approval.stepKey
      && candidates[0]!.planRevision === effect.planRevision
      ? candidates[0]!
      : null;
    const list = effectsByApproval.get(approval.id) ?? [];
    list.push({
      ordinal: effect.ordinal,
      toolName: effect.toolName,
      provider: effect.provider,
      targetLabel: effect.targetLabel,
      principalLabel: effect.principalLabel,
      rendering: effect.rendering,
      idempotencyClass: effect.idempotencyClass,
      operationState: op ? op.resultState : null,
      noop: op ? op.noop === true : false,
    });
    effectsByApproval.set(approval.id, list);
  }

  return approvals.map((a) => ({
    id: a.id,
    taskId: a.taskId,
    planRevision: a.planRevision,
    effectSetDigest: a.effectSetDigest,
    effectCount: a.effectCount,
    intentId: a.intentId,
    state: a.state,
    approvedByUserId: a.approvedByUserId,
    approvedAt: a.approvedAt ? a.approvedAt.toISOString() : null,
    supersededByRevision: a.supersededByRevision,
    createdAt: a.createdAt.toISOString(),
    effects: (effectsByApproval.get(a.id) ?? []).sort((x, y) => x.ordinal - y.ordinal),
  }));
}

