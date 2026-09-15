/**
 * `workspace_launch_analysis` — the chat door to the execution plane
 * (execution-plane spec §5.5).
 *
 * A technician asks for cross-device analysis; this tool admits an `analysis`
 * run owned by them, stamps the chat session on it, and returns the run id
 * IMMEDIATELY. The chat process never touches a sandbox (decision D-E): all
 * agent execution runs on the worker role, and a sandbox lifecycle cannot live
 * in a request pinned to one API process.
 *
 * Tier 1 because it executes nothing on the fleet — it queues work whose every
 * fleet-touching step goes back through the tier gate, intents and approvals.
 * It is nonetheless in `AGENT_HUMAN_ONLY_TOOLS`: an `ai_agent` principal that
 * could launch runs could launch runs that launch runs, and the compute
 * reservation is the only thing bounding that. A human asks; the agent does not.
 *
 * Refusals are TYPED (`{ error, message }`), never thrown: the model has to be
 * able to read why it cannot proceed and say so, and a thrown error would be
 * sanitized into prose it cannot act on.
 *
 * SESSION BINDING. This is a session-bound tool, registered with
 * `makeSessionAwareHandler` exactly like the M365 and Google helpdesk tools.
 * That factory hands the handler `(args, auth, session.breezeSessionId)` — the
 * `ai_sessions.id` of the live chat session — and fails closed with
 * `no_active_session` before any enforcement when there is none. Nothing is read
 * off `ToolExecutionContext`: that type carries per-invocation execution inputs,
 * not caller identity, and its docstring says so.
 */
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../../middleware/auth';
import { aiWorkspaceEnabled } from '../../config/env';
import { resolveArtifact } from '../artifacts/artifactService';
// Import the union; never restate it. A local copy compiles and then silently
// stops covering a refusal W04 adds.
import { admitAnalysisRun, type AnalysisAdmissionRefusal } from '../aiAgents/analysisAdmission';
import { streamingSessionManager } from '../streamingSessionManager';
import { watchRunForSession } from './chatRunBridge';
// The name, tier table and input bounds live in a zero-import leaf so the
// registries that need them (aiTools, aiToolSchemas, aiAgentSdkTools) do not
// drag this module's runtime graph in behind them. Re-exported here so callers
// and tests have one obvious place to look.
import {
  WORKSPACE_LAUNCH_MAX_GOAL_CHARS,
  WORKSPACE_LAUNCH_MAX_INPUT_HANDLES,
  WORKSPACE_LAUNCH_TOOL_NAME,
} from './workspaceLaunchLimits';

export {
  WORKSPACE_LAUNCH_MAX_GOAL_CHARS,
  WORKSPACE_LAUNCH_MAX_INPUT_DEVICES,
  WORKSPACE_LAUNCH_MAX_INPUT_HANDLES,
  WORKSPACE_LAUNCH_TOOL_NAME,
  workspaceLaunchToolTiers,
} from './workspaceLaunchLimits';

export interface WorkspaceLaunchInput {
  goal: string;
  deviceIds?: string[];
  siteId?: string;
  inputHandles?: string[];
}

/**
 * One sentence per refusal, written for the TECHNICIAN reading the chat — the
 * model relays these verbatim. Never leaks whether a handle exists in another
 * org (`artifact_forbidden` is phrased as availability, not existence), which
 * is the same rule `resolveArtifact` follows by returning null for both
 * not-found and forbidden.
 *
 * Typed `Record<AnalysisAdmissionRefusal, string>`, so a refusal W04 adds later
 * is a compile error here rather than an `undefined` in front of a technician.
 */
const REFUSAL_MESSAGES: Record<AnalysisAdmissionRefusal, string> = {
  analysis_not_available: 'Sandboxed analysis runs are not available on this deployment.',
  external_processing_disabled:
    'This organization has not enabled external processing, so analysis runs are turned off. '
    + 'An administrator can enable it under Settings → Organization → Security.',
  workspace_capability_missing:
    "This organization's AI policy does not include the workspace capability, so analysis runs cannot be started.",
  analysis_region_unavailable:
    "Analysis runs are not available in this organization's region yet. Data never leaves its region, "
    + 'so a run cannot be moved to another one.',
  compute_budget_exceeded:
    'The organization has reached its daily analysis compute budget. Try again tomorrow or raise the budget.',
  org_budget_exceeded: 'The organization has reached its AI spend budget for the period.',
  max_concurrent_analysis_runs: 'Another analysis run is already in flight for this organization.',
  analysis_rate: 'Too many analysis runs have been started for this organization in the last hour.',
  too_many_input_devices:
    'Too many devices were named for one analysis run — narrow the device set and try again.',
  device_not_in_org: 'One of the devices named for this run is not in this organization.',
  artifact_forbidden: 'One of the supplied artifact handles is not available to this organization.',
  enqueue_failed:
    'The analysis run could not be queued. This is a platform fault, not a policy refusal.',
};

function toolError(error: string, message: string): string {
  return JSON.stringify({ error, message });
}

/**
 * Which org owns this run. `auth.orgId` first; if the caller's auth carries none
 * — a partner-scope login — fall back to the ACTIVE SESSION's org, which
 * `ActiveSession.orgId` documents as "captured at creation time from the
 * aiSessions DB row … always set, even for system/partner-scoped users".
 *
 * `accessibleOrgIds` is deliberately NOT consulted. A partner technician's
 * accessible set spans every customer; picking one out of it would be guessing
 * whose compute budget to spend and whose data to stage. The session already
 * knows, or nobody does.
 */
function resolveRunOrgId(auth: AuthContext, sessionId: string): string | null {
  if (auth.orgId) return auth.orgId;
  return streamingSessionManager.get(sessionId)?.orgId ?? null;
}

export async function launchAnalysisFromChat(
  input: WorkspaceLaunchInput,
  auth: AuthContext,
  sessionId: string | null,
): Promise<string> {
  if (!aiWorkspaceEnabled()) {
    return toolError('analysis_not_available', REFUSAL_MESSAGES.analysis_not_available);
  }

  // No session, no run. `makeSessionAwareHandler` already refuses with
  // `no_active_session` on the MCP path, so this guards every other caller: a
  // run admitted with `sessionId: null` has no conversation to deliver into and
  // no `ai_sessions.id` to record, and would finish into nowhere.
  if (!sessionId) {
    return toolError(
      'chat_session_required',
      'Analysis runs can only be started from a chat session.',
    );
  }

  const orgId = resolveRunOrgId(auth, sessionId);
  if (!orgId) {
    return toolError(
      'org_context_required',
      'Pick a single organization before starting an analysis run — a run belongs to exactly one customer.',
    );
  }

  const goal = (input.goal ?? '').trim();
  if (!goal) {
    return toolError('invalid_input', 'A goal is required: say what the analysis should find out.');
  }
  if (goal.length > WORKSPACE_LAUNCH_MAX_GOAL_CHARS) {
    return toolError(
      'invalid_input',
      `The goal must be ${WORKSPACE_LAUNCH_MAX_GOAL_CHARS} characters or fewer.`,
    );
  }

  const inputHandles = input.inputHandles ?? [];
  if (inputHandles.length > WORKSPACE_LAUNCH_MAX_INPUT_HANDLES) {
    return toolError(
      'invalid_input',
      `At most ${WORKSPACE_LAUNCH_MAX_INPUT_HANDLES} input handles can be staged into one run.`,
    );
  }

  // Every handle is resolved HERE, in the caller's org, before admission —
  // `staged_inputs` is the run's frozen allowlist (spec §8 data minimisation),
  // and a handle that only gets checked inside the run would mean the run's own
  // allowlist was built from unvalidated model output.
  for (const handle of inputHandles) {
    const record = await resolveArtifact(handle, { orgId });
    if (!record) {
      return toolError(
        'artifact_forbidden',
        `No artifact with handle ${handle} is available to this organization.`,
      );
    }
  }

  const result = await admitAnalysisRun({
    orgId,
    requestedByUserId: auth.user.id,
    sessionId,
    goal,
    deviceIds: input.deviceIds ?? [],
    siteId: input.siteId ?? null,
    stagedHandles: inputHandles,
    // A technician asking twice means twice. Dedupe keys collapse repeated
    // event-driven delivery, not distinct explicit instructions — same rule the
    // manual-trigger route follows.
    dedupeKey: `chat:${randomUUID()}`,
  });

  if (!result.created) {
    // `detail` (when W04 supplies one) names the specific device or cap. It is
    // APPENDED, never substituted: the sentence is written for a technician and
    // the detail is machine-shaped context underneath it.
    const message = result.detail
      ? `${REFUSAL_MESSAGES[result.refusal]} (${result.detail})`
      : REFUSAL_MESSAGES[result.refusal];
    return toolError(result.refusal, message);
  }

  // Watch BEFORE returning, so a run that finishes in the seconds between
  // admission and the model's next token still finds a subscriber. A watch whose
  // session is later evicted is harmless (the bridge drops the delivery and
  // unwatches); `sessionId` is non-null by the guard above.
  watchRunForSession({ runId: result.runId, sessionId, orgId });

  return JSON.stringify({ runId: result.runId, status: result.status });
}

/**
 * The body `makeSessionAwareHandler` wraps. This is the ONLY entry point: there
 * is no `aiTools` map entry, so `executeTool` never reaches this tool and
 * neither `ExecuteToolOptions` nor `ToolExecutionContext` appears anywhere on
 * its path. `requiresLiveSession(WORKSPACE_LAUNCH_TOOL_NAME)` is therefore true
 * for free, which is what makes the durable release worker answer
 * `session_required` instead of `Unknown tool`.
 */
export async function workspaceLaunchAnalysisHandler(
  args: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  return launchAnalysisFromChat(args as unknown as WorkspaceLaunchInput, auth, sessionId);
}
