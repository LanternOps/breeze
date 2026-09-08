/**
 * The Operator task HTTP surface for #5205.
 *
 * W07 (P3-1e) shipped the read side — `GET /ai/operator/tasks` (org-scoped
 * keyset list) and `GET /ai/operator/tasks/:id` (detail).
 *
 * W08 (P3-1f, #5246) adds the ONE write: `POST /ai/operator/tasks`, the only
 * door through which a human creates a task. Answers, pause/resume/cancel and
 * retry are still later waves (P3-5).
 *
 * Mounted at `/api/v1/ai/operator` — a separate route module from the
 * already-large `aiAgentsRoutes`, per spec §12 ("Add routes under
 * /api/v1/ai/operator, separate from the already large aiAgents route
 * module").
 *
 * Auth/DTO posture is deliberately copied from the existing
 * `GET /ai/agents/runs` and `GET /ai/agents/runs/:runId` routes
 * (`routes/aiAgents.ts`) rather than invented fresh:
 *  - same `requireScope('organization', 'partner', 'system')` + existing
 *    `ai_agents:read` permission (spec §5.1 — "Use existing ai_agents:read
 *    for task inspection"), no new permission minted.
 *  - same `auth.orgCondition(...)` scoping and non-enumerating 404 for a
 *    cross-org id.
 *  - same keyset cursor shape (see `operatorTasksListCursor.ts`).
 *
 * Site visibility (spec §11's user-facing site restriction) is genuinely NEW
 * behaviour here — `GET /runs` has no site gate at all (baseline §9.5). A
 * task with a device target outside the caller's `auth.allowedSiteIds`
 * allowlist is treated as not found: 404 on detail, omitted from the list.
 * This is intentionally 404, not 403 — the existing devices routes use 403
 * for an explicit site-scoped operation, but a task detail/list is a read
 * surface where confirming "this task exists, you just can't see it" would
 * leak the task's existence to a caller with no access to it at all.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  createOperatorTaskSchema,
  operatorTaskListQuerySchema,
  type AiOperatorTaskDto,
  type AiOperatorTaskListItemDto,
} from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { db } from '../db';
import { aiAgents, aiAgentRuns, aiOperatorOperations, aiOperatorTasks, devices } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { aiOperatorServiceRecoveryEnabled, aiOperatorTasksEnabled } from '../config/env';
import { admitServiceRecoveryTask } from '../services/aiOperator/taskService';
import {
  SERVICE_RECOVERY_WORKFLOW_KEY,
  SERVICE_RECOVERY_WORKFLOW_VERSION,
} from '../services/aiOperator/recipes/serviceRecovery';
import { TERMINAL_TASK_STATES } from '../services/aiOperator/taskTransitions';
import {
  mapOperatorTask,
  mapOperatorTaskListItem,
  type OperatorOperationRowInput,
  type OperatorRunLinkRowInput,
  type OperatorTaskRowInput,
} from '../services/aiOperator/taskReadService';
import {
  buildOperatorTasksKeysetPredicate,
  decodeOperatorTasksCursor,
  encodeOperatorTasksCursor,
  operatorTasksCursorFromRow,
} from '../services/aiOperator/operatorTasksListCursor';

export const aiOperatorTasksRoutes = new Hono();
aiOperatorTasksRoutes.use('*', authMiddleware);

// Same capability as task inspection everywhere else in the AI surface (spec
// §5.1) — no new permission minted for a read-only view.
const requireAiRead = requirePermission(PERMISSIONS.AI_AGENTS_READ.resource, PERMISSIONS.AI_AGENTS_READ.action);
// W08: launching a task is a WRITE — spec §5.1, "ai_agents:write plus MFA for
// interactive launch". Same pair `POST /ai/agents/:id/runs` carries, because
// delegating a task is at least as consequential as triggering a single run.
const requireAiWrite = requirePermission(PERMISSIONS.AI_AGENTS_WRITE.resource, PERMISSIONS.AI_AGENTS_WRITE.action);
const scopes = requireScope('organization', 'partner', 'system');

const UUID = z.string().guid();

/** Same trap as `routes/aiAgents.ts`'s `uuidParam`: a non-uuid path id must
 *  never reach a query — Postgres 22P02s inside the request's single
 *  transaction and that poisons the COMMIT into a 500 on what is really a
 *  404. */
function uuidParam(c: Context, name: string): string | null {
  const parsed = UUID.safeParse(c.req.param(name));
  return parsed.success ? parsed.data : null;
}

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

/**
 * Spec §7.2: "Proposed pending cap is 100 per org; admission returns a visible
 * capacity result when full." Pending = every non-terminal state, because a
 * `paused` or `waiting` task still holds a deadline, a device target and a
 * reconciler obligation — it is exactly the resource the cap bounds. A
 * terminal task holds none of those.
 */
const OPERATOR_PENDING_TASK_CAP_PER_ORG = 100;

/**
 * `POST /api/v1/ai/operator/tasks` — the only door that creates a task
 * (#5205 W08, #5246; spec §12's `POST /tasks` row).
 *
 * ORDER OF CHECKS IS THE CONTRACT, not a style choice:
 *
 *  1. `.strict()` body (400). Spec §12: "Requests cannot supply a principal,
 *     effective policy, approval result, or trusted continuation token." A
 *     body carrying `task`, `policySnapshot` or `approval` is rejected here,
 *     before anything reads it.
 *  2. Org access (non-enumerating 404). The body names an explicit `orgId`;
 *     a caller without access to it learns nothing about whether it exists.
 *  3. Device resolution + site access (non-enumerating 404) — the SAME
 *     posture the W07 read routes take, so delegating cannot be used to probe
 *     for devices a read cannot see.
 *  4. Readiness recompute (422). Spec §12: "Recompute readiness on launch...
 *     A cached catalog or draft is never authority." Flags and recipe version
 *     are re-read here even though `admitServiceRecoveryTask` checks the flags
 *     again — the second check is the one that actually gates the insert; this
 *     one exists to produce an ACTIONABLE reason instead of a bare refusal.
 *  5. Pending cap (429).
 *  6. Admission, which is idempotent on `clientIdempotencyKey`.
 *
 * Returns 202 (not 201): admission commits a `queued` task with
 * `next_wake_at = now`, and the coordinator's `queued_past_wake` scan — not
 * Redis — is what picks it up, so the acceptance is durable the instant the
 * row commits even with Redis down. That is spec §12's "once task + outbox
 * commit, 202 is truthful", satisfied by a stronger mechanism than an outbox
 * row: W06 deliberately writes NO outbox row at admission, because a queued
 * task has no authoritative source row to re-derive a wake from.
 */
aiOperatorTasksRoutes.post(
  '/tasks',
  scopes,
  requireAiWrite,
  requireMfa(),
  zValidator('json', createOperatorTaskSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    // (2) Explicit org from the body. `canAccessOrg` is the same closure the
    // org-scoping predicate is built from, so this cannot drift from what a
    // read would allow. 404 rather than 403: confirming the org exists is
    // itself a cross-tenant disclosure.
    if (!auth.canAccessOrg(body.orgId)) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // (3) Resolve the target under the caller's own visibility. Note this
    // read runs in the REQUEST's db context (RLS-scoped), unlike admission,
    // which runs as system — so the device must be visible to the caller
    // before any system-scoped work happens on their behalf.
    const [device] = await db
      .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId, hostname: devices.hostname })
      .from(devices)
      .where(and(eq(devices.id, body.deviceId), eq(devices.orgId, body.orgId)))
      .limit(1);
    // A site-restricted caller may not delegate against a device outside their
    // sites. Same non-enumerating 404 as the W07 detail route.
    if (!device || (auth.canAccessSite && !auth.canAccessSite(device.siteId))) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // (4) Readiness, recomputed now.
    if (!aiOperatorTasksEnabled()) {
      return c.json({
        error: 'AI Operator tasks are not enabled for this deployment',
        code: 'OPERATOR_TASKS_DISABLED',
      }, 422);
    }
    if (!aiOperatorServiceRecoveryEnabled()) {
      return c.json({
        error: 'The service recovery workflow is not enabled for this deployment',
        code: 'OPERATOR_RECIPE_DISABLED',
      }, 422);
    }
    if (body.recipeVersion !== SERVICE_RECOVERY_WORKFLOW_VERSION) {
      return c.json({
        error: `Workflow ${SERVICE_RECOVERY_WORKFLOW_KEY} is at version ${SERVICE_RECOVERY_WORKFLOW_VERSION}; `
          + `this request reviewed version ${body.recipeVersion}. Reload and review the current workflow.`,
        code: 'OPERATOR_RECIPE_VERSION_MISMATCH',
      }, 422);
    }

    // The SERVER picks the agent (spec §5.1 — the request cannot name a
    // principal). Enabled agents visible to this org, org-owned preferred over
    // partner-wide, then oldest first so the choice is deterministic and a
    // replay resolves the same way.
    const [agent] = await db
      .select({ id: aiAgents.id })
      .from(aiAgents)
      .where(
        and(
          eq(aiAgents.enabled, true),
          or(eq(aiAgents.orgId, body.orgId), isNull(aiAgents.orgId)),
        ),
      )
      .orderBy(sql`${aiAgents.orgId} IS NULL`, aiAgents.createdAt, aiAgents.id)
      .limit(1);
    if (!agent) {
      return c.json({
        error: 'No enabled AI agent is available for this organization. '
          + 'Enable an agent in Settings → AI Agents before delegating a task.',
        code: 'OPERATOR_NO_AGENT',
      }, 422);
    }

    // (5) Capacity. Counted over non-terminal states for this ONE org (not the
    // caller's whole accessible set) — the cap is a per-tenant resource bound,
    // so a partner-scope caller must not be able to exhaust one org's quota
    // faster because they can see many.
    const [pending] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(aiOperatorTasks)
      .where(
        and(
          eq(aiOperatorTasks.orgId, body.orgId),
          sql`${aiOperatorTasks.state} NOT IN ${TERMINAL_TASK_STATES}`,
        ),
      );
    if ((pending?.count ?? 0) >= OPERATOR_PENDING_TASK_CAP_PER_ORG) {
      return c.json({
        error: `This organization already has ${OPERATOR_PENDING_TASK_CAP_PER_ORG} unfinished Operator tasks. `
          + 'Wait for tasks to finish, or stop ones that are no longer needed, before delegating more.',
        code: 'OPERATOR_PENDING_CAP_REACHED',
      }, 429);
    }

    // (6) Admit. The requester's authorized ceiling is what was just checked
    // above (org + site + write permission + MFA); `requesterUserId` records
    // WHOSE ceiling it is, which is what spec §5.1's "loss of that access
    // pauses delegated execution" is later evaluated against.
    const result = await admitServiceRecoveryTask({
      orgId: body.orgId,
      agentId: agent.id,
      objective: `Restore the ${body.inputs.serviceName} service on ${device.hostname ?? body.deviceId}`,
      // Provenance, not authority (spec §5.1: origins are explicit and never
      // silently converted). A delegate from alert detail is origin 'alert';
      // everything else through this route is a manual delegation.
      originKind: body.sourceKind === 'alert' ? 'alert' : 'manual',
      requesterUserId: auth.user?.id ?? null,
      recipeInput: {
        deviceId: body.deviceId,
        serviceName: body.inputs.serviceName,
        // The alert is the recurrence signal the verification criterion needs
        // (W06: with no alertId the best achievable outcome is
        // `investigation_complete`, never `verified_resolved`).
        triggeringAlertId: body.sourceKind === 'alert' ? body.sourceId ?? null : null,
      },
      clientIdempotencyKey: body.clientIdempotencyKey,
    });

    if (!result.ok) {
      // Every refusal here is a readiness/scope problem, not a client format
      // error: 422 per spec §12 ("422 for unsupported workflow/criteria/
      // setup"), except the two target refusals, which stay non-enumerating.
      if (result.refusal === 'device_not_in_org') {
        return c.json({ error: 'Device not found' }, 404);
      }
      return c.json({ error: result.detail, code: result.refusal.toUpperCase() }, 422);
    }

    // A replay is a success, not a conflict: the caller asked for a task with
    // this key and there is one. Same 202 and the SAME id — the client cannot
    // tell the two apart, which is the whole point of idempotency.
    return c.json({ taskId: result.taskId, replayed: result.replayed }, 202);
  },
);

/**
 * Org-wide keyset-paginated task list — every task the caller's accessible
 * orgs admitted, newest-created first. Optional `deviceId`/`state` filters
 * per spec §12's `GET /tasks` contract.
 *
 * Sorted by `created_at`, not `updated_at` (review fix, PR #5254) — see
 * `operatorTasksListCursor.ts`'s header for why a keyset needs an immutable
 * sort column, and `aiOperatorIndexes.integration.test.ts`'s "device-page
 * task feed" case for the query shape this now matches.
 */
aiOperatorTasksRoutes.get(
  '/tasks',
  scopes,
  requireAiRead,
  zValidator('query', operatorTaskListQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { cursor: cursorToken, limit, deviceId, state } = c.req.valid('query');

    const cursor = decodeOperatorTasksCursor(cursorToken);
    if (cursorToken && !cursor) {
      return c.json({ error: 'Invalid or malformed cursor' }, 400);
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
    return c.json({ data, nextCursor });
  },
);

/**
 * Task detail: the row's display-safe fields plus safely-projected
 * operations and linked runs. Registered AFTER `/tasks` (a literal `tasks`
 * path segment must never fall into `:id` — mirrors `routes/aiAgents.ts`'s
 * `/runs` vs `/:id` ordering note) — Hono resolves the more specific literal
 * route ahead of the param route regardless of registration order, but the
 * ordering is kept explicit here for the same readability reason aiAgents.ts
 * gives.
 */
aiOperatorTasksRoutes.get('/tasks/:id', scopes, requireAiRead, async (c) => {
  const taskId = uuidParam(c, 'id');
  if (!taskId) return c.json({ error: 'Task not found' }, 404);

  const auth = c.get('auth');
  const [task] = await db
    .select(TASK_ROW_COLUMNS)
    .from(aiOperatorTasks)
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
  if (!task) return c.json({ error: 'Task not found' }, 404);

  const [operationRows, runRows] = await Promise.all([
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
      .where(and(eq(aiAgentRuns.taskId, task.id), eq(aiAgentRuns.orgId, task.orgId)))
      .orderBy(desc(aiAgentRuns.queuedAt))
      .limit(500),
  ]);

  const dto: AiOperatorTaskDto = mapOperatorTask(
    task as OperatorTaskRowInput,
    operationRows as OperatorOperationRowInput[],
    runRows as OperatorRunLinkRowInput[],
  );
  return c.json({ data: dto });
});
