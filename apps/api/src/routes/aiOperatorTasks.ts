/**
 * Wave W07 of #5205 (P3-1e, read side) — `GET /ai/operator/tasks` (org-scoped
 * keyset list) and `GET /ai/operator/tasks/:id` (detail). Read-only: no
 * POST/PUT/PATCH/DELETE here — admission, answers, pause/resume/cancel, and
 * the delegate action are later waves (W06/W08).
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
  operatorTaskListQuerySchema,
  type AiOperatorTaskDto,
  type AiOperatorTaskListItemDto,
} from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { db } from '../db';
import { aiAgentRuns, aiOperatorOperations, aiOperatorTasks, devices } from '../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
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
