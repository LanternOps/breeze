/**
 * #10193 — a sentence and a next step for every `launch_specialist` refusal.
 *
 * The tool result keeps the machine code in `error` (and `detail`); `message`
 * is what the model reads back to the person. Before this, a refusal was a
 * bare code (`no_effective_agent`, `admission_skipped`), and the model could
 * only say that "the error doesn't explain itself".
 *
 * Leaf module: type-only imports, so the chat gate (aiAgentSdk) can load it
 * without pulling in the coordinator's graph.
 */
import type { SpecialistRefusal } from './specialistLaunchers';

export const AI_AGENTS_SETTINGS_HREF = '/settings/ai-agents';

const AGENTS_SETTINGS = `Settings → AI Agents (${AI_AGENTS_SETTINGS_HREF})`;

/** Why an agent cannot accept a run although it exists (`agent_disabled` detail). */
export type AgentOffReason = 'disabled' | 'mode_off' | 'kill_switch_off';

/**
 * The sentence for an agent that exists but cannot accept a run. `agentName`
 * is the configured name ("QA Patching agent"); null when it could not be read.
 */
export function agentOffMessage(reason: AgentOffReason, agentName: string | null): string {
  const agent = agentName ? `The agent "${agentName}"` : 'The agent this specialist needs';
  switch (reason) {
    case 'kill_switch_off':
      return 'AI agents are turned off on this server (BREEZE_AI_AGENTS_ENABLED), so no specialist can run. An administrator has to turn them on.';
    case 'mode_off':
      return `${agent} is set to mode Off. Set it to Shadow or Act under ${AGENTS_SETTINGS}, then ask again.`;
    case 'disabled':
      return `${agent} is switched off. Turn it on under ${AGENTS_SETTINGS}, then ask again.`;
  }
}

// One entry per refusal code: a new code without a sentence is a type error.
const MESSAGES: Readonly<Record<SpecialistRefusal, string>> = Object.freeze({
  wisp_disabled: 'Wisp is turned off on this server. An administrator has to turn it on.',
  not_entitled: "This partner's plan does not include Wisp.",
  grant_inactive: 'This Wisp grant is paused, revoked or expired. Turn Wisp back on for this scope, then ask again.',
  org_out_of_ceiling: 'That organization is outside what this Wisp grant covers.',
  depth_exceeded: 'A specialist cannot launch another specialist.',
  budget_exhausted: "This Wisp grant has used today's AI budget. Try again tomorrow, or raise the grant's daily budget on its thread page.",
  permission_missing: 'This specialist needs a permission that the Wisp grant or the person asking does not hold.',
  workspace_execute_required: 'Sandbox analysis needs the ai_workspace:execute permission, in the Wisp grant and for the person asking.',
  unknown_kind: 'That is not a specialist kind. Use sweep, analysis, operator_recipe, patch_plan, remediation_research, bulk_ticket_reply, device_troubleshooting or assessment.',
  invalid_params: 'The params do not fit this specialist kind (see detail). Correct the call and try again.',
  device_not_in_org: 'That device is not in this organization.',
  no_sweep_schedule: `No enabled health-sweep schedule covers this organization. Turn one on under ${AGENTS_SETTINGS}, then ask again.`,
  no_effective_agent: `This organization has no agent of the kind this specialist needs. Create one under ${AGENTS_SETTINGS}, then ask again.`,
  agent_disabled: agentOffMessage('disabled', null),
  admission_skipped: 'The agent did not accept the run (see detail): a limit, cooldown, maintenance window or budget stopped it. Try again later.',
  too_many_requests: 'An assessment can request only a few specialists at a time.',
  bulk_reply_incomplete: 'The bulk reply stopped part-way or sent nothing. Check the report before sending again.',
  continuation_refused: 'That earlier run cannot be continued from here (see detail). Start a new run instead.',
});

/** Sentences for the `detail` a code carries, where the detail changes the next step. */
const DETAIL_MESSAGES: Readonly<Partial<Record<SpecialistRefusal, Readonly<Record<string, string>>>>> = Object.freeze({
  // #10406: a chat-only kind (assessment) asked for by an assessment or its card.
  unknown_kind: { chat_only: 'Only a person in chat can start a Wisp assessment; an assessment cannot start another one.' },
  wisp_disabled: { ai_kill_switch: 'AI actions are paused by the AI kill switch. An administrator has to lift it.' },
  org_out_of_ceiling: { site_restricted: 'This Wisp grant is limited to specific sites, and specialists work on a whole organization.' },
  invalid_params: {
    // W02 analysis sessions: a launch that names no scope.
    scope_required: 'Choose what the analysis covers: scope "org" for the whole organization, "site" with siteId, or "devices" with deviceIds.',
    unknown_recipe: 'That recipe (workflowKey and workflowVersion) is not a released Operator recipe.',
    actor_required: 'A bulk ticket reply needs a person to approve the exact tickets and message.',
  },
  // #11085: why a device_troubleshooting run cannot be continued.
  continuation_refused: {
    not_found: 'That earlier run was not found.',
    not_troubleshooting: 'Only a device troubleshooting run can be continued.',
    other_org: 'That earlier run belongs to another organization.',
    other_device: 'That earlier run worked on a different device. Continue it on the same device.',
    other_grant: 'That earlier run was started under a different Wisp grant.',
    not_settled: 'That earlier run is still running. Wait for it to finish, then continue it.',
    chain_limit: 'That run has already been continued as far as allowed. Start a new run instead.',
    // Wisp analysis sessions W03: why an analysis run cannot be continued.
    analysis_continuation_not_found: 'That earlier analysis run was not found. Start a new analysis instead.',
    analysis_continuation_wrong_kind: 'Only a sandbox analysis run can be continued as an analysis. Start a new analysis instead.',
    analysis_continuation_other_grant: 'That earlier analysis ran under a different Wisp grant. Start a new analysis under this one.',
    analysis_continuation_not_settled: 'That earlier analysis has not finished. Wait for it to finish, then continue it.',
  },
  // Admission skips (runService AgentRunSkipReason) that a person can act on.
  admission_skipped: {
    agent_disabled: agentOffMessage('disabled', null),
    mode_off: agentOffMessage('mode_off', null),
    kill_switch_off: agentOffMessage('kill_switch_off', null),
    no_effective_agent: `This organization has no agent of the kind this specialist needs. Create one under ${AGENTS_SETTINGS}, then ask again.`,
    analysis_not_available: 'Sandbox analysis is not available on this server.',
    enqueue_failed: 'The run could not be queued. Try again in a minute.',
    grant_refused: 'The Wisp grant no longer allows this run.',
    // W02 analysis sessions: the scope frame admission resolves.
    frame_too_large: 'That scope has more devices than one analysis may cover (the AI agent limit analysisMaxFrameDevices, default 1000). Scope the analysis to one site, or ask an administrator to raise the limit.',
    site_not_in_scope: 'That site is not in this organization, or this Wisp grant does not reach it.',
    frame_empty: 'There are no active devices in that scope, so the analysis would have nothing to read.',
    // W03 analysis sessions: the chain bounds, and the hourly analysis rate.
    analysis_chain_too_long: `This investigation has reached its length limit (analysisMaxChainDepth and analysisMaxChainRuns in the AI agent limits, ${AGENTS_SETTINGS}). The chain is finished: start a new analysis to keep going.`,
    analysis_chain_budget_exceeded: `This investigation has reached its spend limit (analysisMaxChainBudgetCents in the AI agent limits, ${AGENTS_SETTINGS}). The chain is finished: start a new analysis to keep going.`,
    analysis_rate: `This organization has started as many analyses as allowed this hour (analysisMaxRunsPerHour in the AI agent limits, ${AGENTS_SETTINGS}). Try again later.`,
    too_many_input_devices: 'That is more devices than one analysis may list (the AI agent limit analysisMaxInputDevicesPerRun, default 50). Use scope "site" or "org" instead of listing devices.',
    // #10406: the on-demand assessment launcher.
    no_open_alerts: 'No organization this Wisp grant can assess has open alerts, so there is nothing to go through.',
    no_assessable_orgs: 'This Wisp grant cannot assess that organization: it reaches it only through specific sites, or a needed permission is missing.',
    queue_unavailable: 'The assessments could not be queued. Try again in a minute.',
  },
});

/** The person-facing sentence for a refusal code and its optional detail. */
export function specialistRefusalMessage(refused: SpecialistRefusal, detail?: string): string {
  const byCode = DETAIL_MESSAGES[refused];
  // Own keys only: `detail` can carry model-supplied text (invalid_params).
  if (detail && byCode && Object.hasOwn(byCode, detail)) return byCode[detail]!;
  return MESSAGES[refused];
}
