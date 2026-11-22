/**
 * The W16 PR A launch tools (full-control W16, #6786): chat's door to the two
 * "Run now" buttons that start AI work, over the SAME operations the routes
 * call, so neither tool can ask for less than its route.
 *
 *   run_patch_plan        POST /ai/patch-plan/runs (aiAgents/patchPlanLaunch.ts)
 *   create_operator_task  POST /ai/operator/tasks, service_recovery only
 *                         (aiOperator/serviceRecoveryLaunch.ts)
 *
 * Classes (aiGuardrails.ts; W16 plan class review, Decision 1): both are Tier 3
 * SUPERVISED, a recorded exception to the class rule that would make an
 * irreversible launch that reaches people four-eyes. What each launches is
 * findings or per-effect approvals: a patch run executes nothing (`patchLimits`
 * pins its run loop's `maxActionsPerRun` to 0; the installs it proposes are
 * minted afterwards as `manage_patches:install` cards), and an operator task
 * asks for approval of every change it makes. Per-org caps bound the credit
 * spend. REST is one person + MFA.
 *
 * Exposure: both are in `AGENT_HUMAN_ONLY_TOOLS` (an agent that could call
 * them launches runs that launch runs), which also puts them in the Wisp grant
 * ceiling floor (`isNeverDelegableTool`); `launch_specialist` stays the Wisp
 * door. Each handler refuses an `ai_agent` principal as well, as defence
 * beside the registry.
 *
 * Gates beyond the shared operation:
 *  - both are MFA-gated as a whole (`MFA_GATED_TOOL_ACTIONS`), like REST;
 *  - `run_patch_plan` refuses a site- or device-restricted session outright
 *    (Decision 6, stricter than REST): the run reads scope a site-restricted
 *    session to runs on its devices, which a device-less patch run never matches,
 *    so such a caller could start a run whose result it cannot read;
 *  - `create_operator_task` runs only as the release of its own approved
 *    intent: its idempotency key is `ai-tool:<intentId>`, so a retried release
 *    replays the first task and a second approved card is a second task. The
 *    intent's arguments are immutable, so the key binds the device, service and
 *    alert the approver saw. A named alert must be on that device.
 *
 * A business failure is an `error` envelope (no `success`, `data` or
 * `configured` key), so the release worker records a refused launch as failed.
 */
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import type { ToolExecutionContext } from './toolExecutionContext';
import { aiAgentLaunchToolSchemas } from './aiToolSchemasAiAgentLaunch';
import { mfaGatedToolError } from './aiToolMfaGate';
import { canMutateOrgWideGovernance } from './siteCeilingAccess';
import { auditToolWrite, json, jsonError, thrown } from './aiToolsSecurityPolicyShared';
import { agentRefusal, isAgentPrincipal } from './aiToolsTicketOpsShared';
import { orgAdminInputSchema, parseInput } from './aiToolsOrgAdminShared';

const PATCH_TOOL = 'run_patch_plan';
const OPERATOR_TOOL = 'create_operator_task';

/** Where a refused launch's audit row lands: the target org only when the caller can reach it. */
function auditOrg(auth: AuthContext, orgId: string): { orgId: string | null; partnerId: string | null } {
  return auth.canAccessOrg(orgId)
    ? { orgId, partnerId: null }
    : { orgId: auth.orgId ?? null, partnerId: auth.partnerId ?? null };
}

// ---------------------------------------------------------------------------
// run_patch_plan
// ---------------------------------------------------------------------------

export async function runPatchPlanHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  context?: ToolExecutionContext,
): Promise<string> {
  if (isAgentPrincipal(auth)) return agentRefusal(PATCH_TOOL);
  const parsed = parseInput(aiAgentLaunchToolSchemas.run_patch_plan, input);
  if (!parsed.ok) return parsed.error;
  // Decision 6: before any lookup.
  if (!canMutateOrgWideGovernance(auth)) {
    return jsonError('A patch run covers the whole organization; a site- or device-restricted session cannot start one', 'ACCESS_DENIED');
  }
  const mfa = mfaGatedToolError(PATCH_TOOL, undefined, auth);
  if (mfa) return mfa;
  const { orgId } = parsed.value;

  // A retried release of one intent is one run; a second approved card is a
  // second run. With no intent (a direct call) every call is its own run, as
  // every "Run now" press is.
  const intentId = context?.actionIntentId;
  const dedupeKey = `patch-ai-tool-${intentId ?? randomUUID()}`;
  try {
    const { launchPatchPlanRun } = await import('./aiAgents/patchPlanLaunch');
    const result = await launchPatchPlanRun(auth, orgId, dedupeKey, { replay: Boolean(intentId) });

    const queued = result.ok && !result.enqueueFailed;
    const skipped = result.ok ? (result.enqueueFailed ? 'enqueue_failed' : undefined) : result.code === 'SKIPPED' ? result.skipped : undefined;
    // Every outcome writes one row, as the route's does (same action).
    auditToolWrite(auth, {
      ...auditOrg(auth, orgId),
      action: 'ai_patch_plan.run.manual_trigger',
      resourceType: 'ai_agent',
      ...('agentId' in result ? { resourceId: result.agentId } : {}),
      details: {
        via: 'ai_tool',
        ...(result.ok ? { runId: result.runId, ...(result.replayed ? { replayed: true } : {}) } : {}),
        ...(skipped ? { skipped } : {}),
        ...(!result.ok && result.code !== 'SKIPPED' ? { refused: result.code, requestedOrgId: orgId } : {}),
      },
      result: queued ? 'success' : 'failure',
    });

    if (!result.ok && result.code === 'NOT_FOUND') return jsonError('Organization not found or access denied', 'NOT_FOUND');
    if (!result.ok && result.code === 'NO_PATCH_AGENT') {
      return jsonError('This organization has no patch agent. Set one up in Settings → AI Agents.', 'NO_PATCH_AGENT');
    }
    if (!result.ok || result.enqueueFailed) {
      return JSON.stringify({ error: 'The patch run was not started', code: 'RUN_SKIPPED', skipped });
    }
    return json({ queued: true, runId: result.runId, ...(result.replayed ? { replayed: true } : {}) });
  } catch (error) {
    auditToolWrite(auth, {
      ...auditOrg(auth, orgId),
      action: 'ai_patch_plan.run.manual_trigger',
      resourceType: 'ai_agent',
      details: { via: 'ai_tool', refused: 'THROWN', requestedOrgId: orgId },
      result: 'failure',
    });
    return thrown(PATCH_TOOL, error);
  }
}

// ---------------------------------------------------------------------------
// create_operator_task
// ---------------------------------------------------------------------------

export async function createOperatorTaskHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  context?: ToolExecutionContext,
): Promise<string> {
  if (isAgentPrincipal(auth)) return agentRefusal(OPERATOR_TOOL);
  const parsed = parseInput(aiAgentLaunchToolSchemas.create_operator_task, input);
  if (!parsed.ok) return parsed.error;
  const mfa = mfaGatedToolError(OPERATOR_TOOL, undefined, auth);
  if (mfa) return mfa;
  // The key is the approved intent; without one there is nothing to bind a
  // retry to, so refuse rather than invent a key (a tier-3 tool always mints
  // one in chat).
  const intentId = context?.actionIntentId;
  if (!intentId) {
    return jsonError(`${OPERATOR_TOOL} runs only as the release of its own approved request`, 'APPROVAL_REQUIRED');
  }
  const { orgId, deviceId, serviceName, alertId } = parsed.value;

  // One row per outcome. REST writes none for this action, so the row has no twin.
  const audit = (outcome: Record<string, unknown>, ok: boolean, taskId?: string) => auditToolWrite(auth, {
    ...auditOrg(auth, orgId),
    action: 'ai_operator.task.create',
    resourceType: 'ai_operator_task',
    ...(taskId ? { resourceId: taskId } : {}),
    details: {
      via: 'ai_tool',
      recipeKey: 'service_recovery',
      deviceId,
      serviceName,
      ...(alertId ? { alertId } : {}),
      ...(ok ? {} : { requestedOrgId: orgId }),
      ...outcome,
    },
    result: ok ? 'success' : 'failure',
  });

  try {
    // The alert becomes the task's recurrence check, so it must be one the
    // caller can reach and must be about this device (stricter than REST,
    // which takes the citation as given). The ref lookup loads no alert text:
    // the message is never shown, so it is never read.
    if (alertId) {
      const { findAlertRefWithAccess } = await import('./aiToolsAlerts');
      const alert = await findAlertRefWithAccess(alertId, auth);
      if (!alert || alert.orgId !== orgId || alert.deviceId !== deviceId) {
        audit({ refused: 'ALERT_NOT_FOUND' }, false);
        return jsonError('Alert not found for this device, or access denied', 'NOT_FOUND');
      }
    }

    const [{ launchServiceRecoveryTask }, { SERVICE_RECOVERY_WORKFLOW_KEY, SERVICE_RECOVERY_WORKFLOW_VERSION }] = await Promise.all([
      import('./aiOperator/serviceRecoveryLaunch'),
      import('./aiOperator/recipes/serviceRecovery'),
    ]);
    const result = await launchServiceRecoveryTask(auth, {
      orgId,
      recipeKey: SERVICE_RECOVERY_WORKFLOW_KEY,
      recipeVersion: SERVICE_RECOVERY_WORKFLOW_VERSION,
      deviceId,
      serviceName,
      ...(alertId ? { sourceKind: 'alert' as const, sourceId: alertId } : {}),
      clientIdempotencyKey: `ai-tool:${intentId}`,
    });

    if (result.ok) audit({ replayed: result.replayed }, true, result.taskId);
    else audit({ refused: result.code }, false);

    if (!result.ok) {
      if (result.code === 'NOT_FOUND') return jsonError('Device not found or access denied', 'NOT_FOUND');
      return JSON.stringify({
        error: result.detail ?? 'The task was not started',
        code: result.code,
        ...(result.supportedRecipeKeys ? { supportedRecipeKeys: result.supportedRecipeKeys } : {}),
      });
    }
    return json({ taskId: result.taskId, replayed: result.replayed, deviceId, serviceName });
  } catch (error) {
    audit({ refused: 'THROWN' }, false);
    return thrown(OPERATOR_TOOL, error);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerAiAgentLaunchTools(aiTools: Map<string, AiTool>): void {
  aiTools.set(PATCH_TOOL, {
    tier: 3,
    domain: 'ai',
    deviceArgs: [],
    searchHint: 'run the patch agent now for an organization: a patch plan that proposes installs for approval',
    definition: {
      name: PATCH_TOOL,
      description:
        "Run an organization's patch agent now. It reviews missing patches and proposes installs, each its own approval; it installs nothing itself. Needs approval; uses AI credits and may notify people.",
      input_schema: orgAdminInputSchema(aiAgentLaunchToolSchemas.run_patch_plan),
    },
    // Declares `context` directly: a truncating wrapper would read it as undefined forever.
    handler: (input, auth, context) => runPatchPlanHandler(input, auth, context),
  });

  aiTools.set(OPERATOR_TOOL, {
    tier: 3,
    domain: 'ai',
    deviceArgs: ['deviceId'],
    searchHint: 'start an AI task to get a stopped service running again on a device (service recovery)',
    definition: {
      name: OPERATOR_TOOL,
      description:
        'Start an AI task that gets a stopped service running again on one device. It investigates, then asks approval for each change. Pass alertId when an alert reported it. Needs approval; uses AI credits.',
      input_schema: orgAdminInputSchema(aiAgentLaunchToolSchemas.create_operator_task),
    },
    handler: (input, auth, context) => createOperatorTaskHandler(input, auth, context),
  });
}
