/**
 * Execution plane W04 (cross-wave reconciliation R1) — the single entry point
 * W05's chat tool calls to launch an `analysis` run.
 *
 * It is a THIN wrapper, on purpose. `createAndEnqueueAgentRun` remains the
 * one admission function in the system — every gate, counter, advisory lock
 * and reservation lives there and is shared with the other six profiles. All
 * this adds is (a) a pre-check that every staged handle actually resolves in
 * the caller's org, and (b) a TOTAL translation from `AgentRunSkipReason`
 * onto a small refusal union W05 renders.
 *
 * WHY THE TRANSLATION EXISTS. `AgentRunSkipReason` is a shared union that
 * grows whenever any profile does — it already carries verdict, sweep,
 * narrative, triage, design and patch pairs W05 has no copy for. Exposing it
 * to a chat surface would make every future wave a W05 change. The map below
 * is declared `satisfies Record<AgentRunSkipReason, AnalysisAdmissionRefusal>`,
 * so adding a reason without deciding what a technician should be told is a
 * COMPILE ERROR here, not a blank toast in production.
 */
import { resolveArtifact } from '../artifacts/artifactService';
import { createAndEnqueueAgentRun, type AgentRunSkipReason } from './runService';

/**
 * What a technician can be told. Deliberately smaller than the skip union and
 * deliberately not a superset of it: several distinct internal reasons
 * collapse onto one message because the technician's next action is the same.
 *
 * `device_not_in_org` is carried SEPARATELY from `too_many_input_devices`
 * even though both are about the device selection — the first means "that is
 * not your device" and the second "you picked too many of yours", and a
 * surface that showed one for the other would either leak a tenancy signal or
 * send the technician looking for a permissions problem that is not there.
 * W05 MUST render `device_not_in_org`; it is not in the original R1 list.
 */
export type AnalysisAdmissionRefusal =
  | 'analysis_not_available'
  | 'external_processing_disabled'
  | 'workspace_capability_missing'
  | 'analysis_region_unavailable'
  | 'compute_budget_exceeded'
  | 'org_budget_exceeded'
  | 'max_concurrent_analysis_runs'
  | 'analysis_rate'
  | 'too_many_input_devices'
  | 'device_not_in_org'
  | 'artifact_forbidden'
  | 'enqueue_failed';

export interface AdmitAnalysisRunInput {
  orgId: string;
  requestedByUserId: string;
  /** The CHAT session the technician launched from, or null. */
  sessionId: string | null;
  goal: string;
  deviceIds: string[];
  siteId: string | null;
  stagedHandles: string[];
  dedupeKey: string;
}

export type AdmitAnalysisRunResult =
  | { created: true; runId: string; status: string }
  | { created: false; refusal: AnalysisAdmissionRefusal; detail?: string };

/**
 * TOTAL over `AgentRunSkipReason`. Exported so its own suite can assert the
 * runtime object matches the type-level `satisfies`.
 *
 * The collapses, and why each is the right thing to say:
 *   - every "there is no agent / it is off / the trigger did not match" reason
 *     becomes `analysis_not_available`: from the technician's side the feature
 *     is simply not available here, and naming the internal state would be
 *     both meaningless and a configuration disclosure.
 *   - `workspace_unavailable` (breaker open) also becomes
 *     `analysis_not_available` — W05's union has no provider-outage member, and
 *     the `detail` below carries the "try again shortly" nuance.
 *   - `cooldown` / `max_runs_per_hour` / `duplicate` become `analysis_rate`:
 *     all three mean "wait, then retry", which is the only action available.
 *   - both token-budget reasons become `org_budget_exceeded`; the COMPUTE ones
 *     stay separate as `compute_budget_exceeded`, because the thing to raise
 *     is a different setting.
 */
export const SKIP_REASON_REFUSALS = {
  kill_switch_off: 'analysis_not_available',
  no_effective_agent: 'analysis_not_available',
  agent_disabled: 'analysis_not_available',
  mode_off: 'analysis_not_available',
  circuit_open: 'analysis_not_available',
  trigger_filter_mismatch: 'analysis_not_available',
  maintenance_window: 'analysis_not_available',
  ownership_mismatch: 'analysis_not_available',
  cooldown: 'analysis_rate',
  duplicate: 'analysis_rate',
  max_runs_per_hour: 'analysis_rate',
  max_concurrent_runs: 'max_concurrent_analysis_runs',
  org_budget_exceeded: 'org_budget_exceeded',
  agent_daily_budget_exceeded: 'org_budget_exceeded',
  device_not_in_org: 'device_not_in_org',
  // Other profiles' volume guards. Unreachable from this path (the run is
  // admitted as `profile: 'analysis'`), but the map is total by construction.
  max_concurrent_verdict_runs: 'max_concurrent_analysis_runs',
  verdict_rate: 'analysis_rate',
  max_concurrent_sweep_runs: 'max_concurrent_analysis_runs',
  sweep_rate: 'analysis_rate',
  max_concurrent_narrative_runs: 'max_concurrent_analysis_runs',
  narrative_rate: 'analysis_rate',
  max_concurrent_triage_runs: 'max_concurrent_analysis_runs',
  triage_rate: 'analysis_rate',
  max_concurrent_design_runs: 'max_concurrent_analysis_runs',
  design_rate: 'analysis_rate',
  max_concurrent_patch_runs: 'max_concurrent_analysis_runs',
  patch_rate: 'analysis_rate',
  // This wave's own.
  analysis_not_available: 'analysis_not_available',
  external_processing_disabled: 'external_processing_disabled',
  workspace_capability_missing: 'workspace_capability_missing',
  analysis_region_unavailable: 'analysis_region_unavailable',
  max_concurrent_analysis_runs: 'max_concurrent_analysis_runs',
  analysis_rate: 'analysis_rate',
  compute_budget_exceeded: 'compute_budget_exceeded',
  compute_credits_exhausted: 'compute_budget_exceeded',
  too_many_input_devices: 'too_many_input_devices',
  workspace_unavailable: 'analysis_not_available',
} satisfies Record<AgentRunSkipReason, AnalysisAdmissionRefusal>;

/** Extra sentence for the reasons whose refusal alone would mislead. */
const SKIP_REASON_DETAILS: Partial<Record<AgentRunSkipReason, string>> = {
  compute_credits_exhausted: 'This organization has no AI credits left for sandbox compute.',
  workspace_unavailable: 'Compute workspaces are temporarily unavailable. Try again shortly.',
  duplicate: 'An identical analysis is already queued for this organization.',
};

export async function admitAnalysisRun(input: AdmitAnalysisRunInput): Promise<AdmitAnalysisRunResult> {
  // Handle pre-check. `resolveArtifact` returning null means "not found OR
  // another org's" and the two are NEVER distinguished (W01's contract), so
  // one refusal covers both without leaking which. Done here rather than in
  // `runService` because it is the only thing about this input that
  // `createAndEnqueueAgentRun` has no reason to know: the frozen handles are
  // W05's, and a bad one must not consume an admission slot.
  for (const handle of input.stagedHandles) {
    const record = await resolveArtifact(handle, { orgId: input.orgId });
    if (!record) return { created: false, refusal: 'artifact_forbidden' };
  }

  const result = await createAndEnqueueAgentRun({
    orgId: input.orgId,
    kind: 'triage',
    triggerKind: 'manual',
    deviceId: null,
    dedupeKey: input.dedupeKey,
    profile: 'analysis',
    // The chat session, the goal and the site live in `trigger_ref`, not in
    // dedicated columns: `ai_agent_runs.session_id` is the AGENT session the
    // run loop opens, a different thing from the chat session that launched
    // this, and conflating them would make the run page link to the wrong
    // conversation.
    triggerRef: {
      source: 'chat_analysis',
      goal: input.goal,
      chatSessionId: input.sessionId,
      siteId: input.siteId,
      requestedByUserId: input.requestedByUserId,
    },
    analysis: { deviceIds: input.deviceIds, inputHandles: input.stagedHandles },
  });

  if (!result.created) {
    const refusal = SKIP_REASON_REFUSALS[result.skipped];
    const detail = SKIP_REASON_DETAILS[result.skipped];
    return { created: false, refusal, ...(detail ? { detail } : {}) };
  }

  // `createAndEnqueueAgentRun` returns `created: true` even when the enqueue
  // failed — it hands back the row it just marked `failed`, so the HTTP
  // caller can report the status. For a chat surface that is a refusal: no
  // worker will ever pick the run up.
  if (result.run.status === 'failed' && result.run.errorCode === 'enqueue_failed') {
    return { created: false, refusal: 'enqueue_failed' };
  }
  return { created: true, runId: result.run.id, status: result.run.status };
}
