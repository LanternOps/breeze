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
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  createOperatorTaskSchema,
  deviceTargetedTaskFieldsSchema,
  operatorTaskDraftSchema,
  operatorTaskListQuerySchema,
  selfInheritanceField,
  SELF_INHERITANCE_MESSAGE,
  type CreateOperatorTaskInput,
  type IdentityOffboardingInput,
  type IdentityOnboardingInput,
  type AiOperatorIdentityTaskDraftDto,
  type AiOperatorIdentityOnboardingTaskDraftDto,
  type AiOperatorOnboardingDraftEffectDto,
  type AiOperatorWorkflowDto,
} from '@breeze/shared';
import { formatZodError, zValidator } from '../lib/validation';
import { db } from '../db';
import { contacts, devices, sites } from '../db/schema';
import { authMiddleware, hasSatisfiedMfa, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS, hasPermission, type UserPermissions } from '../services/permissions';
import { aiOperatorServiceRecoveryEnabled, aiOperatorTasksEnabled } from '../config/env';
import { admitServiceRecoveryTask, admitTask, recipeEnabled } from '../services/aiOperator/taskService';
import { canMutateOrgWideGovernance } from '../services/siteCeilingAccess';
import {
  RECIPE_AGENT_KINDS,
  computeRecipeReadiness,
  listWorkflowReadiness,
  toWorkflowDto,
  type RecipeReadiness,
} from '../services/aiOperator/recipeReadiness';
import {
  IDENTITY_OFFBOARDING_EFFECT_TOOLS,
  IDENTITY_OFFBOARDING_WORKFLOW_KEY,
  buildIdentityOffboardingManualWork,
} from '../services/aiOperator/recipes/identityOffboarding';
import {
  IDENTITY_ONBOARDING_WORKFLOW_KEY,
  buildIdentityOnboardingCreatePlan,
  buildIdentityOnboardingManualWork,
  buildIdentityOnboardingProvisionPlan,
  buildManualCreateGoogleItem,
  capOnboardingManualWork,
  type IdentityOnboardingCreateFacts,
} from '../services/aiOperator/recipes/identityOnboarding';
import { readOnboardingDraftFacts } from '../services/aiOperator/identityProvisioning';
import { normalizeContactEmail } from '../services/contacts/crud';
import type { AnyRecipeDefinition, PlannedEffect } from '../services/aiOperator/recipes/types';
import { RECIPE_KEYS, resolveAdmissionRecipe } from '../services/aiOperator/recipes';
import { resolveEffectiveAgent } from '../services/aiAgents/effectivePolicy';
import { listOperatorTasks, loadOperatorTaskDetail } from '../services/aiOperator/taskReadQueries';

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

    // R2a: `identity_onboarding` sends no device and its own inputs. It takes
    // its own path after the org check, before the shipped device-field parse.
    if (body.recipeKey === IDENTITY_ONBOARDING_WORKFLOW_KEY) {
      if (!auth.canAccessOrg(body.orgId)) return c.json({ error: 'Organization not found' }, 404);
      return admitIdentityOnboardingFromRoute(c, body);
    }

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

    const result = await listOperatorTasks(auth, { cursorToken, limit, deviceId, state });
    if (!result.ok) return c.json({ error: 'Invalid or malformed cursor' }, 400);
    return c.json({ data: result.data, nextCursor: result.nextCursor });
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
  const data = await loadOperatorTaskDetail(auth, taskId);
  if (!data) return c.json({ error: 'Task not found' }, 404);
  return c.json({ data });
});

// ---------------------------------------------------------------------------
// W06 R1b (G2): the plan a task proposed, read-only
// ---------------------------------------------------------------------------

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
 * The person leaving named as their own inheritor, once the person is a
 * resolved contact (#10076). The input validator catches an inheritor equal to
 * the named `contactId`; only a resolved row shows a hint that resolves to the
 * inheritor, or a `forwardTo` that is the person's own address. Same 400 shape
 * as the validator's, with the reason as the error so the form can show it.
 */
function selfInheritanceRefusal(input: IdentityOffboardingInput, person: ContactRow) {
  const field = selfInheritanceField(input, { contactId: person.id, email: person.email });
  return field
    ? { error: SELF_INHERITANCE_MESSAGE, code: 'INVALID_INPUT', issues: [{ path: field, message: SELF_INHERITANCE_MESSAGE }] }
    : null;
}

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
    const selfInheritance = selfInheritanceRefusal(input, row);
    if (selfInheritance) return c.json(selfInheritance, 400);
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
    if (recipe.key === IDENTITY_ONBOARDING_WORKFLOW_KEY) {
      return draftIdentityOnboardingFromRoute(c, {
        orgId: body.orgId, recipe, input: parsed.data as IdentityOnboardingInput, readiness, workflow,
      });
    }
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
    const selfInheritance = person.resolved ? selfInheritanceRefusal(input, person.resolved) : null;
    if (selfInheritance) return c.json(selfInheritance, 400);
    const degraded = new Set(readiness.degradedEffects);
    const plannedEffectTools = (Object.keys(IDENTITY_TOGGLE_TOOLS) as Array<keyof typeof IDENTITY_TOGGLE_TOOLS>)
      .filter((toggle) => input.effects[toggle])
      .flatMap((toggle) => IDENTITY_TOGGLE_TOOLS[toggle])
      .filter((tool) => !(tool === 'm365_remove_license' && input.keepMailbox))
      .filter((tool) => IDENTITY_OFFBOARDING_EFFECT_TOOLS.includes(tool as never));
    const label = person.resolved?.name ?? person.resolved?.email ?? input.personHint ?? 'the departing person';
    // Device items name the host, not the id (QA sweep 2026-10-24): the same
    // org-scoped lookup POST /tasks uses, read-only, unknown ids fall back to the id.
    const deviceLabels: Record<string, string> = {};
    if (input.deviceIds.length > 0) {
      const rows = await db.select({ id: devices.id, hostname: devices.hostname, siteId: devices.siteId }).from(devices)
        .where(and(eq(devices.orgId, body.orgId), inArray(devices.id, input.deviceIds)));
      for (const d of rows) {
        if (auth.canAccessSite && !auth.canAccessSite(d.siteId)) continue;
        if (d.hostname) deviceLabels[d.id] = d.hostname;
      }
    }
    const manualWork = buildIdentityOffboardingManualWork(input, {
      google: { present: readiness.capabilityReadiness['google.workspace.connection'] === true },
      m365: { present: readiness.capabilityReadiness['m365.connection'] === true },
      targets: { contactTargetId: 'draft', contactLabel: label, deviceLabels },
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
      } satisfies AiOperatorIdentityTaskDraftDto,
    });
  },
);

// ---------------------------------------------------------------------------
// W07 R2a (Task 14; Amendment G6, G7, G9): identity_onboarding through the
// shipped routes. Appended — nothing above changes behaviour for another key.
// ---------------------------------------------------------------------------

/** Never leaves the server: the draft's facts need a contact target id, and there is no contact. */
const DRAFT_CONTACT_TARGET_ID = '00000000-0000-0000-0000-000000000000';
/**
 * Never leaves the server either: the account a stage-1 create would produce
 * has no id yet. M365 accounts are addressed by an Entra object id (a GUID),
 * so the placeholder is the nil GUID; the preview hides `userIdentifier`.
 */
const DRAFT_PENDING_M365_ACCOUNT_ID = '00000000-0000-0000-0000-000000000000';
const DRAFT_PENDING_GOOGLE_ACCOUNT_ID = 'pending-account';
/** Arguments that name the account or audit the call; the preview states the account through `principalLabel`. */
const DRAFT_HIDDEN_ARGUMENTS: ReadonlySet<string> = new Set(['userIdentifier', 'userEmail', 'reason']);

function draftEffect(effect: PlannedEffect, input: IdentityOnboardingInput): AiOperatorOnboardingDraftEffectDto {
  const provider = effect.provider === 'google' ? 'google' : 'm365';
  const principalLabel = provider === 'google' ? input.google?.primaryEmail ?? '' : input.m365?.userPrincipalName ?? '';
  return {
    ordinal: effect.ordinal,
    toolName: effect.toolName,
    provider,
    principalLabel,
    arguments: Object.fromEntries(Object.entries(effect.canonicalArguments).filter(([k]) => !DRAFT_HIDDEN_ARGUMENTS.has(k))),
  };
}

/**
 * `POST /task-drafts` for `identity_onboarding` (G7). After the SAME two gates
 * as offboarding (org-wide governance, recipe flag), and only then, it runs
 * `readOnboardingDraftFacts`: at most one `m365.user.get`, one
 * `m365.org.skus.list` and one Google `users.get`, every failure a flag. It
 * resolves no contact and writes nothing.
 *
 * Both previews come from the recipe's OWN builders over draft facts, so the
 * draft cannot preview what `discover` would refuse on the same reads. The
 * draft reads no group, so each requested group is described as unknown
 * (planned, as an unknown-role group is at discover), and the provision
 * preview says it is provisional in its name. A provider whose name is not
 * strictly free gets no account and so no provisioning, as at stage 2.
 */
async function draftIdentityOnboardingFromRoute(c: Context, args: {
  orgId: string;
  recipe: Pick<AnyRecipeDefinition, 'key' | 'version'>;
  input: IdentityOnboardingInput;
  readiness: RecipeReadiness;
  workflow: AiOperatorWorkflowDto;
}) {
  const auth = c.get('auth');
  const { orgId, recipe, input, readiness, workflow } = args;
  // The shared draft route only requires organizations:read, but this branch
  // does live directory lookups by a caller-supplied name: admission's own
  // gates (organizations:write + MFA) apply before any provider read.
  const perms = c.get('permissions') as UserPermissions | undefined;
  if (!perms || !hasPermission(perms, PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action)) {
    return c.json({ error: 'Permission denied', code: 'PERMISSION_DENIED' }, 403);
  }
  if (!hasSatisfiedMfa(auth)) {
    return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
  }
  if (!canMutateOrgWideGovernance(auth)) {
    return c.json({
      error: 'Onboarding creates organization-wide identity accounts; site-restricted users cannot start it.',
      code: 'SITE_RESTRICTED',
    }, 403);
  }
  if (!recipeEnabled(recipe.key)) {
    return c.json({ error: 'The onboarding workflow is not enabled for this deployment', code: 'OPERATOR_RECIPE_DISABLED' }, 422);
  }

  const reads = await readOnboardingDraftFacts({ orgId, input });
  const facts: IdentityOnboardingCreateFacts = {
    stage: 'create',
    targets: { contactTargetId: DRAFT_CONTACT_TARGET_ID, contactLabel: input.displayName.slice(0, 512) },
    collisions: reads.collisions,
    seats: reads.seats,
    groups: {
      m365: (input.m365?.groupIds ?? []).map((id) => ({ id, name: null, dynamic: null, roleAssignable: null })),
      google: (input.google?.groupEmails ?? []).map((email) => ({ email, name: null, modelAfterRole: null })),
    },
    modelAfter: null,
    degradedTools: [...readiness.degradedEffects],
    capabilityReadiness: { ...readiness.capabilityReadiness },
    flags: reads.flags.map((f) => ({ code: f.code, subject: f.subject, detail: f.detail })),
    truncated: [],
  };
  const m365Free = reads.collisions.m365?.upnTaken === false;
  const googleFree = reads.collisions.google?.emailTaken === false;
  const provisionFacts = {
    ...facts,
    stage: 'provision' as const,
    accounts: {
      m365: m365Free && input.m365 ? { externalId: DRAFT_PENDING_M365_ACCOUNT_ID, principalLabel: input.m365.userPrincipalName } : null,
      google: googleFree && input.google ? { externalId: DRAFT_PENDING_GOOGLE_ACCOUNT_ID, principalLabel: input.google.primaryEmail } : null,
    },
  };

  // A collision is a fact the reads found, not a read failure: a flag, never an error.
  const flags = reads.flags.map((f) => ({ code: f.code, subject: f.subject, detail: f.detail }));
  if (input.m365 && reads.collisions.m365?.upnTaken === true) {
    flags.push({ code: 'upn_collision', subject: input.m365.userPrincipalName,
      detail: 'A Microsoft 365 account already holds this sign-in name, so Breeze would not create one.' });
  }
  if (input.google && reads.collisions.google?.emailTaken === true) {
    flags.push({ code: 'email_collision', subject: input.google.primaryEmail,
      detail: 'A Google Workspace user already holds this address, so Breeze would not provision Google.' });
  }

  const googleItem = buildManualCreateGoogleItem(input, facts);
  const manualWork = capOnboardingManualWork([
    ...(googleItem ? [googleItem] : []),
    ...buildIdentityOnboardingManualWork(input, facts, readiness.capabilityReadiness, []),
  ]).map((i) => ({ key: i.key, label: i.label, detail: i.detail, origin: i.origin }));

  return c.json({
    data: {
      recipeKey: recipe.key,
      recipeVersion: recipe.version,
      input,
      workflow,
      createPlanPreview: buildIdentityOnboardingCreatePlan(input, facts).map((e) => draftEffect(e, input)),
      provisionPlanPreview: buildIdentityOnboardingProvisionPlan(input, provisionFacts).map((e) => draftEffect(e, input)),
      flags,
      manualWork,
    } satisfies AiOperatorIdentityOnboardingTaskDraftDto,
  });
}

/**
 * `POST /tasks` for `identity_onboarding`, with the offboarding path's
 * posture: organizations:write, org-wide governance, no device or source
 * citation, readiness re-read, every referenced contact and site visible to
 * the caller in their own db context, the SERVER picks the agent, admission
 * idempotent. Admission CREATES the contact (Task 10), so a person who
 * already has one is a conflict for a human: 409 naming the existing contact.
 */
async function admitIdentityOnboardingFromRoute(c: Context, body: CreateOperatorTaskInput) {
  const auth = c.get('auth');
  const perms = c.get('permissions') as UserPermissions | undefined;
  if (!perms || !hasPermission(perms, PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action)) {
    return c.json({ error: 'Permission denied', code: 'PERMISSION_DENIED' }, 403);
  }
  if (!canMutateOrgWideGovernance(auth)) {
    return c.json({
      error: 'Onboarding creates organization-wide identity accounts; site-restricted users cannot start it.',
      code: 'SITE_RESTRICTED',
    }, 403);
  }
  if (body.deviceId !== undefined || body.sourceKind !== undefined) {
    return c.json({ error: 'This workflow takes no deviceId and no source citation.', code: 'INVALID_INPUT' }, 400);
  }
  if (!aiOperatorTasksEnabled()) {
    return c.json({ error: 'AI Operator tasks are not enabled for this deployment', code: 'OPERATOR_TASKS_DISABLED' }, 422);
  }
  if (!recipeEnabled(body.recipeKey)) {
    return c.json({ error: 'The onboarding workflow is not enabled for this deployment', code: 'OPERATOR_RECIPE_DISABLED' }, 422);
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
  const input = parsed.data as IdentityOnboardingInput;

  // Non-enumerating: the same 404 whether a referenced row is another org's or nobody's.
  for (const contactId of [input.managerContactId, input.modelAfterContactId]) {
    if (contactId === null) continue;
    const [row] = await db.select({ id: contacts.id }).from(contacts)
      .where(and(eq(contacts.orgId, body.orgId), eq(contacts.id, contactId))).limit(1);
    if (!row) return c.json({ error: 'Contact not found' }, 404);
  }
  if (input.siteId !== null) {
    const [site] = await db.select({ id: sites.id }).from(sites)
      .where(and(eq(sites.orgId, body.orgId), eq(sites.id, input.siteId))).limit(1);
    if (!site || (auth.canAccessSite && !auth.canAccessSite(site.id))) return c.json({ error: 'Site not found' }, 404);
  }

  const kind = RECIPE_AGENT_KINDS[recipe.key];
  const effectiveAgent = kind ? await resolveEffectiveAgent(auth, body.orgId, kind) : null;
  const agent = effectiveAgent?.effective.enabled ? { id: effectiveAgent.agentId } : null;
  if (!agent) {
    return c.json({
      error: 'No enabled helpdesk AI agent is available for this organization. '
        + 'Enable one in Settings → AI Agents before starting an onboarding.',
      code: 'OPERATOR_NO_AGENT',
    }, 422);
  }

  const result = await admitTask({
    orgId: body.orgId,
    agentId: agent.id,
    workflowKey: recipe.key,
    workflowVersion: recipe.version,
    objective: `Onboard ${input.displayName}`.slice(0, 4000),
    originKind: 'manual',
    requesterUserId: auth.user?.id ?? null,
    recipeInput: input,
    clientIdempotencyKey: body.clientIdempotencyKey,
  });
  if (!result.ok) {
    switch (result.refusal) {
      case 'contact_already_exists': {
        // Admission's refusal carries no id; re-read it on the CALLER's
        // context with admission's rule (one match; none for a shared
        // mailbox), so the body can only name a contact the caller can see.
        const email = normalizeContactEmail(input.m365?.userPrincipalName ?? input.google?.primaryEmail ?? null);
        const rows = email === null ? [] : await db.select({ id: contacts.id }).from(contacts)
          .where(and(eq(contacts.orgId, body.orgId), sql`lower(${contacts.email}) = ${email}`)).limit(2);
        return c.json({
          error: 'A contact already uses this person\'s address: this onboarding may already be started, '
            + 'or the address belongs to someone else.',
          code: 'OPERATOR_CONTACT_ALREADY_EXISTS',
          existingContactId: rows.length === 1 ? rows[0]!.id : null,
        }, 409);
      }
      case 'start_at_beyond_deadline': {
        const deadlineDays = Math.floor(recipe.bounds.deadlineMs / (24 * 60 * 60 * 1000));
        return c.json({
          error: `The start date is after this task's ${deadlineDays}-day deadline. `
            + `Pick a start date within ${deadlineDays} days, or start the onboarding nearer to it.`,
          code: 'START_AT_BEYOND_DEADLINE',
          deadlineDays,
        }, 422);
      }
      case 'contact_not_in_org': return c.json({ error: 'Contact not found' }, 404);
      case 'duplicate_live_task':
        return c.json({
          error: 'An onboarding task is already running for this person.',
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
