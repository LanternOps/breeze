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
  deviceTargetedTaskFieldsSchema,
  operatorTaskDraftSchema,
  operatorTaskListQuerySchema,
  type CreateOperatorTaskInput,
  type IdentityOffboardingInput,
  type AiOperatorTaskDto,
  type AiOperatorTaskListItemDto,
} from '@breeze/shared';
import { formatZodError, zValidator } from '../lib/validation';
import { db } from '../db';
import {
  aiAgentRuns,
  aiOperatorOperations,
  aiOperatorTaskEvents,
  aiOperatorTaskSteps,
  aiOperatorTaskTargetAccounts,
  aiOperatorTaskTargets,
  aiOperatorTasks,
  contacts,
  devices,
} from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS, hasPermission, type UserPermissions } from '../services/permissions';
import { aiOperatorServiceRecoveryEnabled, aiOperatorTasksEnabled } from '../config/env';
import { admitServiceRecoveryTask, admitTask, recipeEnabled } from '../services/aiOperator/taskService';
import { canMutateOrgWideGovernance } from '../services/siteCeilingAccess';
import {
  RECIPE_AGENT_KINDS,
  computeRecipeReadiness,
  listWorkflowReadiness,
  toWorkflowDto,
} from '../services/aiOperator/recipeReadiness';
import {
  IDENTITY_OFFBOARDING_EFFECT_TOOLS,
  IDENTITY_OFFBOARDING_WORKFLOW_KEY,
  buildIdentityOffboardingManualWork,
} from '../services/aiOperator/recipes/identityOffboarding';
import { RECIPE_KEYS, resolveAdmissionRecipe } from '../services/aiOperator/recipes';
import { resolveEffectiveAgent } from '../services/aiAgents/effectivePolicy';
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
} from '../services/aiOperator/taskReadService';
import {
  buildOperatorTasksKeysetPredicate,
  decodeOperatorTasksCursor,
  encodeOperatorTasksCursor,
  operatorTasksCursorFromRow,
} from '../services/aiOperator/operatorTasksListCursor';
import { runSiteScopeCondition } from '../services/aiAgentRunSiteScope';

/**
 * The agent kind an operator task is delegated to. The effective agent is
 * resolved per (org, kind), so admission has to name one: task runs are later
 * admitted against the task's frozen `agentKind` (`taskCoordinator`) on the
 * default full profile. The service-recovery recipe is an investigate-and-
 * remediate workflow, which is the triage agent's lane; a `designer` never
 * runs on the full profile (`ownership_mismatch`). Before #7015 the route
 * took any enabled row regardless of kind.
 */
const OPERATOR_TASK_AGENT_KIND = 'triage' as const;

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
 *  5. Admission, which is idempotent on `clientIdempotencyKey` and enforces
 *     the task-wide policy ceilings (#6590) — including the pending cap,
 *     which it answers as `pending_cap_reached` and this route turns into
 *     spec §12's visible 429. The cap lives in admission, not here, because
 *     it is the effective agent policy's `taskMaxPendingPerOrg` (not a
 *     constant), it must hold for every admission caller, and the count has
 *     to sit under the same per-org lock as the insert to be a real bound.
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

    // `deviceId` and `inputs` are loose on the wire since R1a (a contact-
    // targeted recipe sends no device and its own inputs). Every other key
    // gets the shipped shapes back, with the shipped 400 body, and before the
    // org check — the order the shipped validator middleware ran them in.
    const isContactTargeted = body.recipeKey === IDENTITY_OFFBOARDING_WORKFLOW_KEY;
    const deviceFields = isContactTargeted
      ? null
      : deviceTargetedTaskFieldsSchema.safeParse({ deviceId: body.deviceId, inputs: body.inputs });
    if (deviceFields && !deviceFields.success) {
      return c.json(formatZodError(deviceFields.error), 400);
    }

    // (2) Explicit org from the body. `canAccessOrg` is the same closure the
    // org-scoping predicate is built from, so this cannot drift from what a
    // read would allow. 404 rather than 403: confirming the org exists is
    // itself a cross-tenant disclosure.
    if (!auth.canAccessOrg(body.orgId)) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // A contact-targeted recipe (R1a) takes its own path; every other key —
    // service_recovery and an unknown one alike — continues exactly as before.
    if (isContactTargeted || !deviceFields) {
      return admitIdentityOffboardingFromRoute(c, body);
    }
    const deviceId = deviceFields.data.deviceId;
    const serviceName = deviceFields.data.inputs.serviceName;


    // (3) Resolve the target under the caller's own visibility. Note this
    // read runs in the REQUEST's db context (RLS-scoped), unlike admission,
    // which runs as system — so the device must be visible to the caller
    // before any system-scoped work happens on their behalf.
    const [device] = await db
      .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId, hostname: devices.hostname })
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.orgId, body.orgId)))
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
    // Two different answers to the caller (Recipe Library spec §6.1):
    //  - an unknown key is a malformed request — no such workflow exists at
    //    any version, so the response names the ones that do (400);
    //  - a known key at an unreleased version is a stale client that reviewed
    //    a workflow this deployment has moved past (422 — spec §12's
    //    "422 for unsupported workflow/criteria/setup", and the shipped
    //    behaviour this route already had).
    const resolution = resolveAdmissionRecipe(body.recipeKey, body.recipeVersion);
    if (!resolution.ok && resolution.reason === 'unknown_recipe') {
      return c.json({
        error: resolution.detail,
        code: 'OPERATOR_UNKNOWN_RECIPE',
        supportedRecipeKeys: [...RECIPE_KEYS],
      }, 400);
    }
    if (!resolution.ok) {
      return c.json({
        error: resolution.detail,
        code: 'OPERATOR_RECIPE_VERSION_MISMATCH',
      }, 422);
    }
    const recipe = resolution.recipe;

    // The SERVER picks the agent (spec §5.1 — the request cannot name a
    // principal): the org's EFFECTIVE agent of the operator kind, resolved
    // the same way run admission resolves it (#7015). That is always the
    // partner baseline's id; an org-owned row of the kind is an override
    // merged onto the baseline's policy, never an agent of its own. Pinning
    // the override made every run of the task skip `ownership_mismatch`
    // (`runService`: `task.agentId !== resolved.agentId`) and made admission
    // ignore the org's tightened task limits. No baseline, or an effective
    // agent that is disabled (by the partner, the org override, or the AI
    // agents kill switch), means no run could ever be admitted — refuse now
    // rather than admit a task that can only stall.
    const effectiveAgent = await resolveEffectiveAgent(auth, body.orgId, OPERATOR_TASK_AGENT_KIND);
    const agent = effectiveAgent?.effective.enabled ? { id: effectiveAgent.agentId } : null;
    if (!agent) {
      return c.json({
        error: 'No enabled AI agent is available for this organization. '
          + 'Enable an agent in Settings → AI Agents before delegating a task.',
        code: 'OPERATOR_NO_AGENT',
      }, 422);
    }

    // (5) Admit. The requester's authorized ceiling is what was just checked
    // above (org + site + write permission + MFA); `requesterUserId` records
    // WHOSE ceiling it is, which is what spec §5.1's "loss of that access
    // pauses delegated execution" is later evaluated against.
    const result = await admitServiceRecoveryTask({
      orgId: body.orgId,
      agentId: agent.id,
      // The RESOLVED pair. Admission re-resolves it — the two checks are not
      // redundant: this route is not the only admission caller, and admission
      // is the layer that writes the row.
      workflowKey: recipe.key,
      workflowVersion: recipe.version,
      objective: `Restore the ${serviceName} service on ${device.hostname ?? deviceId}`,
      // Provenance, not authority (spec §5.1: origins are explicit and never
      // silently converted). A delegate from alert detail is origin 'alert';
      // everything else through this route is a manual delegation.
      originKind: body.sourceKind === 'alert' ? 'alert' : 'manual',
      requesterUserId: auth.user?.id ?? null,
      recipeInput: {
        deviceId,
        serviceName,
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
      if (result.refusal === 'pending_cap_reached') {
        return c.json({
          error: `${result.detail}. Wait for tasks to finish, or stop ones that are no longer needed, `
            + 'before delegating more.',
          code: 'OPERATOR_PENDING_CAP_REACHED',
        }, 429);
      }
      if (result.refusal === 'unknown_recipe') {
        return c.json({
          error: result.detail,
          code: 'OPERATOR_UNKNOWN_RECIPE',
          supportedRecipeKeys: [...RECIPE_KEYS],
        }, 400);
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
  return c.json({ data: dto });
});

// ---------------------------------------------------------------------------
// Recipe Library (W06 R1a): the Library, drafts, and contact-targeted admission
// ---------------------------------------------------------------------------

/** Effect tools each offboarding toggle can produce — the draft's outline, never a plan. */
const IDENTITY_TOGGLE_TOOLS: Readonly<Record<keyof IdentityOffboardingInput['effects'], readonly string[]>> = Object.freeze({
  autoReply: ['google_set_vacation', 'm365_set_auto_reply'],
  forwarding: ['google_set_forwarding'],
  mailDelegate: ['google_add_mail_delegate'],
  removeGroups: ['google_remove_from_group', 'm365_remove_from_group'],
  removeLicenses: ['google_remove_license', 'm365_remove_license'],
  wipeMobile: ['google_account_wipe_mobile_device', 'm365_retire_intune_device'],
  revokeSessions: ['google_signout', 'm365_revoke_sessions'],
  disableAccount: ['google_suspend_user', 'm365_disable_user'],
});

type ContactRow = { id: string; name: string | null; email: string | null };

/**
 * Who the caller means, READ-ONLY, in the caller's own (RLS-scoped) db
 * context, org-predicated. A substring name match is fine HERE: it only
 * produces candidates for a human to pick from. Admission itself resolves
 * exactly or refuses.
 */
async function draftPerson(orgId: string, input: IdentityOffboardingInput): Promise<{ resolved: ContactRow | null; candidates: ContactRow[] }> {
  const cols = { id: contacts.id, name: contacts.name, email: contacts.email };
  if (input.contactId) {
    const [row] = await db.select(cols).from(contacts)
      .where(and(eq(contacts.orgId, orgId), eq(contacts.id, input.contactId))).limit(1);
    return { resolved: row ?? null, candidates: [] };
  }
  const hint = (input.personHint ?? '').trim();
  const asEmail = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(hint) ? hint.toLowerCase() : null;
  const rows = asEmail
    ? await db.select(cols).from(contacts).where(and(eq(contacts.orgId, orgId), sql`lower(${contacts.email}) = ${asEmail}`)).limit(10)
    : await db.select(cols).from(contacts)
      .where(and(eq(contacts.orgId, orgId), sql`${contacts.name} ILIKE ${`%${hint.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`}`))
      .limit(10);
  // The candidate list is a substring search, but "resolved" uses the SAME
  // rule admission does (`identifyTaskPerson`): a unique email match, or a
  // unique exact (trimmed, case-insensitive) full-name match. Anything looser
  // would preview a person that POST /tasks then refuses as ambiguous.
  const exact = asEmail ? rows : rows.filter((r) => (r.name ?? '').trim().toLowerCase() === hint.toLowerCase());
  return { resolved: exact.length === 1 ? exact[0]! : null, candidates: rows };
}

/**
 * `POST /tasks` for `identity_offboarding` — same posture as the device path:
 * `.strict()` body, org access (non-enumerating 404), readiness recomputed,
 * the SERVER picks the agent, admission is idempotent.
 *
 * Extra gates for a contact-targeted recipe:
 *  - a site-restricted caller is refused: a directory account has no per-site
 *    slice, so this is org-wide governance (the requester gate would pause
 *    the task at its first effect anyway — refuse now, not after approval);
 *  - the named contact and every selected device must be visible to the
 *    caller in their own db context before system-scoped admission runs.
 */
async function admitIdentityOffboardingFromRoute(c: Context, body: CreateOperatorTaskInput) {
  const auth = c.get('auth');
  // Offboarding changes a person's directory accounts: on top of
  // ai_agents:write it needs the organization write permission the contact
  // routes use. The permissions were resolved by requireAiWrite above.
  const perms = c.get('permissions') as UserPermissions | undefined;
  if (!perms || !hasPermission(perms, PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action)) {
    return c.json({ error: 'Permission denied', code: 'PERMISSION_DENIED' }, 403);
  }
  if (!canMutateOrgWideGovernance(auth)) {
    return c.json({
      error: 'Offboarding acts on organization-wide identity accounts; site-restricted users cannot start it.',
      code: 'SITE_RESTRICTED',
    }, 403);
  }
  if (body.deviceId !== undefined || body.sourceKind !== undefined) {
    return c.json({
      error: 'This workflow takes its devices in inputs.deviceIds and accepts no deviceId or source citation.',
      code: 'INVALID_INPUT',
    }, 400);
  }
  if (!aiOperatorTasksEnabled()) {
    return c.json({ error: 'AI Operator tasks are not enabled for this deployment', code: 'OPERATOR_TASKS_DISABLED' }, 422);
  }
  if (!recipeEnabled(body.recipeKey)) {
    return c.json({ error: 'The offboarding workflow is not enabled for this deployment', code: 'OPERATOR_RECIPE_DISABLED' }, 422);
  }
  const resolution = resolveAdmissionRecipe(body.recipeKey, body.recipeVersion);
  if (!resolution.ok) {
    return c.json({ error: resolution.detail, code: 'OPERATOR_RECIPE_VERSION_MISMATCH' }, 422);
  }
  const recipe = resolution.recipe;
  const parsed = recipe.inputSchema.safeParse(body.inputs);
  if (!parsed.success) {
    return c.json({
      error: 'Invalid workflow inputs',
      code: 'INVALID_INPUT',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, 400);
  }
  const input = parsed.data as IdentityOffboardingInput;

  let label = input.personHint ?? 'a departing person';
  if (input.contactId) {
    const [row] = await db.select({ id: contacts.id, name: contacts.name, email: contacts.email }).from(contacts)
      .where(and(eq(contacts.orgId, body.orgId), eq(contacts.id, input.contactId))).limit(1);
    // Non-enumerating: the same answer whether it exists elsewhere or nowhere.
    if (!row) return c.json({ error: 'Contact not found' }, 404);
    label = row.name ?? row.email ?? label;
  }
  if (input.deviceIds.length > 0) {
    const rows = await db.select({ id: devices.id, siteId: devices.siteId }).from(devices)
      .where(and(eq(devices.orgId, body.orgId), inArray(devices.id, input.deviceIds)));
    const visible = rows.filter((d) => !auth.canAccessSite || auth.canAccessSite(d.siteId));
    if (visible.length !== new Set(input.deviceIds).size) return c.json({ error: 'Device not found' }, 404);
  }

  const kind = RECIPE_AGENT_KINDS[recipe.key];
  const effectiveAgent = kind ? await resolveEffectiveAgent(auth, body.orgId, kind) : null;
  const agent = effectiveAgent?.effective.enabled ? { id: effectiveAgent.agentId } : null;
  if (!agent) {
    return c.json({
      error: 'No enabled helpdesk AI agent is available for this organization. '
        + 'Enable one in Settings → AI Agents before starting an offboarding.',
      code: 'OPERATOR_NO_AGENT',
    }, 422);
  }

  const result = await admitTask({
    orgId: body.orgId,
    agentId: agent.id,
    workflowKey: recipe.key,
    workflowVersion: recipe.version,
    objective: `Offboard ${label}`.slice(0, 4000),
    originKind: 'manual',
    requesterUserId: auth.user?.id ?? null,
    recipeInput: input,
    clientIdempotencyKey: body.clientIdempotencyKey,
  });
  if (!result.ok) {
    switch (result.refusal) {
      case 'contact_not_in_org': return c.json({ error: 'Contact not found' }, 404);
      case 'device_not_in_org': return c.json({ error: 'Device not found' }, 404);
      case 'duplicate_live_task':
        return c.json({
          error: 'An offboarding task is already running for this person.',
          code: 'OPERATOR_DUPLICATE_LIVE_TASK',
          taskId: result.existingTaskId ?? null,
        }, 409);
      case 'pending_cap_reached':
        return c.json({ error: result.detail, code: 'OPERATOR_PENDING_CAP_REACHED' }, 429);
      case 'unknown_recipe':
        return c.json({ error: result.detail, code: 'OPERATOR_UNKNOWN_RECIPE', supportedRecipeKeys: [...RECIPE_KEYS] }, 400);
      default:
        return c.json({ error: result.detail, code: result.refusal.toUpperCase() }, 422);
    }
  }
  return c.json({ taskId: result.taskId, replayed: result.replayed }, 202);
}

/**
 * `GET /api/v1/ai/operator/workflows` — the Library (spec §4.1, §12).
 *
 * Readiness is computed from ROWS on every call. Spec §12: "Recompute
 * readiness on launch and before dispatch. A cached catalog or draft is never
 * authority." There is deliberately no ETag and no cache header.
 */
aiOperatorTasksRoutes.get(
  '/workflows',
  scopes,
  requireAiRead,
  zValidator('query', z.object({ orgId: z.string().guid() }).strict()),
  async (c) => {
    const auth = c.get('auth');
    const { orgId } = c.req.valid('query');
    if (!auth.canAccessOrg(orgId)) return c.json({ error: 'Organization not found' }, 404);
    const readiness = await listWorkflowReadiness(orgId, auth);
    return c.json({ data: readiness.map(toWorkflowDto) });
  },
);

/**
 * `POST /api/v1/ai/operator/task-drafts` — interpret and validate, execute
 * nothing (spec §12: "returns typed reviewed proposal, no operational
 * execution"). It resolves the recipe, parses the inputs, resolves the person
 * READ-ONLY (it never creates a contact — a draft that created customer
 * records would not be a draft), recomputes readiness, and returns the effect
 * tools the plan WOULD use and the human-work items it would generate. It
 * writes nothing. The plan itself is built at `discover`, from live provider
 * reads, after a person confirms the identity.
 */
aiOperatorTasksRoutes.post(
  '/task-drafts',
  scopes,
  requireAiWrite,
  // A draft can return contact names and addresses: the same read permission
  // the contact routes require.
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('json', operatorTaskDraftSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    if (!auth.canAccessOrg(body.orgId)) return c.json({ error: 'Organization not found' }, 404);
    const resolution = resolveAdmissionRecipe(body.recipeKey, body.recipeVersion);
    if (!resolution.ok && resolution.reason === 'unknown_recipe') {
      return c.json({ error: resolution.detail, code: 'OPERATOR_UNKNOWN_RECIPE', supportedRecipeKeys: [...RECIPE_KEYS] }, 400);
    }
    if (!resolution.ok) return c.json({ error: resolution.detail, code: 'OPERATOR_RECIPE_VERSION_MISMATCH' }, 422);
    const recipe = resolution.recipe;

    const rawInput = body.deviceId !== undefined ? { ...body.inputs, deviceId: body.deviceId } : body.inputs;
    const parsed = recipe.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return c.json({
        error: 'Invalid workflow inputs',
        code: 'INVALID_INPUT',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      }, 400);
    }

    const all = await listWorkflowReadiness(body.orgId, auth);
    const readiness = all.find((r) => r.recipeKey === recipe.key)
      ?? computeRecipeReadiness(recipe, { orgId: body.orgId, m365: null, google: null, agent: null, flagEnabled: false });
    const workflow = toWorkflowDto(readiness);
    if (recipe.key !== IDENTITY_OFFBOARDING_WORKFLOW_KEY) {
      return c.json({ data: { recipeKey: recipe.key, recipeVersion: recipe.version, input: parsed.data, workflow } });
    }

    // Same gates as admission, BEFORE any contact is read: offboarding is
    // org-wide identity governance, and a disabled recipe drafts nothing.
    if (!canMutateOrgWideGovernance(auth)) {
      return c.json({
        error: 'Offboarding acts on organization-wide identity accounts; site-restricted users cannot start it.',
        code: 'SITE_RESTRICTED',
      }, 403);
    }
    if (!recipeEnabled(recipe.key)) {
      return c.json({ error: 'The offboarding workflow is not enabled for this deployment', code: 'OPERATOR_RECIPE_DISABLED' }, 422);
    }
    const input = parsed.data as IdentityOffboardingInput;
    if (!input.contactId && (input.personHint ?? '').trim().length < 2) {
      return c.json({ error: 'Name the person with at least two characters, or choose a contact.', code: 'INVALID_INPUT' }, 400);
    }
    const person = await draftPerson(body.orgId, input);
    const degraded = new Set(readiness.degradedEffects);
    const plannedEffectTools = (Object.keys(IDENTITY_TOGGLE_TOOLS) as Array<keyof typeof IDENTITY_TOGGLE_TOOLS>)
      .filter((toggle) => input.effects[toggle])
      .flatMap((toggle) => IDENTITY_TOGGLE_TOOLS[toggle])
      .filter((tool) => !(tool === 'm365_remove_license' && input.keepMailbox))
      .filter((tool) => IDENTITY_OFFBOARDING_EFFECT_TOOLS.includes(tool as never));
    const label = person.resolved?.name ?? person.resolved?.email ?? input.personHint ?? 'the departing person';
    const manualWork = buildIdentityOffboardingManualWork(input, {
      google: { present: readiness.capabilityReadiness['google.workspace.connection'] === true },
      m365: { present: readiness.capabilityReadiness['m365.connection'] === true },
      targets: { contactTargetId: 'draft', contactLabel: label },
      degradedTools: [...degraded],
    }, readiness.capabilityReadiness, []).map((i) => ({ key: i.key, label: i.label, detail: i.detail, origin: i.origin }));

    return c.json({
      data: {
        recipeKey: recipe.key,
        recipeVersion: recipe.version,
        input,
        workflow,
        person: {
          resolved: person.resolved,
          // Candidates for a human to pick from, never a resolution.
          candidates: person.resolved ? [] : person.candidates,
        },
        plannedEffectTools: plannedEffectTools.filter((t) => !degraded.has(t)),
        degradedEffectTools: plannedEffectTools.filter((t) => degraded.has(t)),
        manualWork,
      },
    });
  },
);
