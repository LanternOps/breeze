/**
 * Service-recovery task admission as ONE shared operation (full-control W16
 * PR A, #6786 Task 1).
 *
 * `POST /ai/operator/tasks` (device path) and the `create_operator_task` AI
 * tool both call this, so the tool cannot ask for less than the route: the
 * checks below moved here verbatim from the route, in the route's order.
 *
 *  1. Org access (non-enumerating NOT_FOUND). The input names an explicit
 *     `orgId`; a caller without access learns nothing about whether it exists.
 *  2. Device resolution + site access (non-enumerating NOT_FOUND), read in the
 *     CALLER's db context (RLS-scoped), unlike admission, which runs as system,
 *     so the device must be visible to the caller before any system-scoped
 *     work happens on their behalf. Same posture as the W07 task read routes.
 *  3. Readiness, recomputed now (spec §12: "Recompute readiness on launch...
 *     A cached catalog or draft is never authority"). Admission re-checks the
 *     flags; this check exists to give an actionable reason.
 *  4. The SERVER picks the agent: the org's EFFECTIVE triage agent (#7015).
 *  5. Admission, idempotent on `clientIdempotencyKey`, which enforces the
 *     task-wide ceilings including the pending cap.
 *
 * The result is a code, not an HTTP status: the route maps each code to the
 * status and body it has always returned; the tool maps it to an `error`
 * envelope. `detail` is the person-facing sentence.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { aiOperatorServiceRecoveryEnabled, aiOperatorTasksEnabled } from '../../config/env';
import { resolveEffectiveAgent } from '../aiAgents/effectivePolicy';
import { admitServiceRecoveryTask } from './taskService';
import { RECIPE_KEYS, resolveAdmissionRecipe } from './recipes';

/**
 * The agent kind an operator task is delegated to. The effective agent is
 * resolved per (org, kind), so admission has to name one: task runs are later
 * admitted against the task's frozen `agentKind` (`taskCoordinator`) on the
 * default full profile. The service-recovery recipe is an investigate-and-
 * remediate workflow, which is the triage agent's lane; a `designer` never
 * runs on the full profile (`ownership_mismatch`). Before #7015 the route
 * took any enabled row regardless of kind.
 */
export const OPERATOR_TASK_AGENT_KIND = 'triage' as const;

export interface ServiceRecoveryLaunchInput {
  orgId: string;
  recipeKey: string;
  recipeVersion: number;
  deviceId: string;
  serviceName: string;
  sourceKind?: 'alert';
  sourceId?: string;
  clientIdempotencyKey: string;
}

export type ServiceRecoveryLaunchResult =
  | { ok: true; taskId: string; replayed: boolean }
  | { ok: false; code: string; detail?: string; supportedRecipeKeys?: string[] };

const NOT_FOUND = { ok: false, code: 'NOT_FOUND' } as const;

export async function launchServiceRecoveryTask(
  auth: AuthContext,
  input: ServiceRecoveryLaunchInput,
): Promise<ServiceRecoveryLaunchResult> {
  // (1) `canAccessOrg` is the same closure the org-scoping predicate is built
  // from, so this cannot drift from what a read would allow.
  if (!auth.canAccessOrg(input.orgId)) return NOT_FOUND;

  // (2) A site-restricted caller may not delegate against a device outside
  // their sites: the same not-found as a missing device.
  const [device] = await db
    .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId, hostname: devices.hostname })
    .from(devices)
    .where(and(eq(devices.id, input.deviceId), eq(devices.orgId, input.orgId)))
    .limit(1);
  if (!device || (auth.canAccessSite && !auth.canAccessSite(device.siteId))) return NOT_FOUND;

  // (3) Readiness.
  if (!aiOperatorTasksEnabled()) {
    return { ok: false, code: 'OPERATOR_TASKS_DISABLED', detail: 'AI Operator tasks are not enabled for this deployment' };
  }
  if (!aiOperatorServiceRecoveryEnabled()) {
    return { ok: false, code: 'OPERATOR_RECIPE_DISABLED', detail: 'The service recovery workflow is not enabled for this deployment' };
  }
  // Two different answers (Recipe Library spec §6.1): an unknown key is a
  // malformed request, so the answer names the workflows that do exist; a
  // known key at an unreleased version is a stale client (spec §12's 422).
  const resolution = resolveAdmissionRecipe(input.recipeKey, input.recipeVersion);
  if (!resolution.ok && resolution.reason === 'unknown_recipe') {
    return { ok: false, code: 'OPERATOR_UNKNOWN_RECIPE', detail: resolution.detail, supportedRecipeKeys: [...RECIPE_KEYS] };
  }
  if (!resolution.ok) {
    return { ok: false, code: 'OPERATOR_RECIPE_VERSION_MISMATCH', detail: resolution.detail };
  }
  const recipe = resolution.recipe;

  // (4) The org's EFFECTIVE agent of the operator kind, resolved the way run
  // admission resolves it (#7015): always the partner baseline's id (an
  // org-owned row of the kind is an override merged onto it). Pinning the
  // override made every run of the task skip `ownership_mismatch`. No baseline,
  // or an effective agent that is disabled (partner, org override or the AI
  // agents kill switch), means no run could ever be admitted: refuse now
  // rather than admit a task that can only stall.
  const effectiveAgent = await resolveEffectiveAgent(auth, input.orgId, OPERATOR_TASK_AGENT_KIND);
  const agentId = effectiveAgent?.effective.enabled ? effectiveAgent.agentId : null;
  if (!agentId) {
    return {
      ok: false,
      code: 'OPERATOR_NO_AGENT',
      detail: 'No enabled AI agent is available for this organization. '
        + 'Enable an agent in Settings → AI Agents before delegating a task.',
    };
  }

  // (5) Admit. The requester's authorized ceiling is the org and site checked
  // above, plus the write permission and MFA each caller gates on (route
  // middleware; tool dispatch and handler). `requesterUserId` records WHOSE
  // ceiling it is, which spec §5.1's "loss of that access pauses delegated
  // execution" is later evaluated against.
  const result = await admitServiceRecoveryTask({
    orgId: input.orgId,
    agentId,
    // The RESOLVED pair. Admission re-resolves it: it is the layer that writes the row.
    workflowKey: recipe.key,
    workflowVersion: recipe.version,
    objective: `Restore the ${input.serviceName} service on ${device.hostname ?? input.deviceId}`,
    // Provenance, not authority (spec §5.1).
    originKind: input.sourceKind === 'alert' ? 'alert' : 'manual',
    requesterUserId: auth.user?.id ?? null,
    recipeInput: {
      deviceId: input.deviceId,
      serviceName: input.serviceName,
      // The recurrence signal the verification criterion needs (W06: with no
      // alertId the best achievable outcome is `investigation_complete`).
      triggeringAlertId: input.sourceKind === 'alert' ? input.sourceId ?? null : null,
    },
    clientIdempotencyKey: input.clientIdempotencyKey,
  });

  if (!result.ok) {
    if (result.refusal === 'device_not_in_org') return NOT_FOUND;
    if (result.refusal === 'pending_cap_reached') {
      return {
        ok: false,
        code: 'OPERATOR_PENDING_CAP_REACHED',
        detail: `${result.detail}. Wait for tasks to finish, or stop ones that are no longer needed, before delegating more.`,
      };
    }
    if (result.refusal === 'unknown_recipe') {
      return { ok: false, code: 'OPERATOR_UNKNOWN_RECIPE', detail: result.detail, supportedRecipeKeys: [...RECIPE_KEYS] };
    }
    return { ok: false, code: result.refusal.toUpperCase(), detail: result.detail };
  }
  // A replay is a success: the caller asked for a task with this key and there is one.
  return { ok: true, taskId: result.taskId, replayed: result.replayed };
}
