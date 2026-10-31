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
  budget_exhausted: "This Wisp grant has used today's AI budget. Try again tomorrow.",
  permission_missing: 'This specialist needs a permission that the Wisp grant or the person asking does not hold.',
  workspace_execute_required: 'Sandbox analysis needs the ai_workspace:execute permission, in the Wisp grant and for the person asking.',
  unknown_kind: 'That is not a specialist kind. Use sweep, analysis, operator_recipe, patch_plan, remediation_research or bulk_ticket_reply.',
  invalid_params: 'The params do not fit this specialist kind (see detail). Correct the call and try again.',
  device_not_in_org: 'That device is not in this organization.',
  no_sweep_schedule: `No enabled health-sweep schedule covers this organization. Turn one on under ${AGENTS_SETTINGS}, then ask again.`,
  no_effective_agent: `This organization has no agent of the kind this specialist needs. Create one under ${AGENTS_SETTINGS}, then ask again.`,
  agent_disabled: agentOffMessage('disabled', null),
  admission_skipped: 'The agent did not accept the run (see detail): a limit, cooldown, maintenance window or budget stopped it. Try again later.',
  too_many_requests: 'An assessment can request only a few specialists at a time.',
  bulk_reply_incomplete: 'The bulk reply stopped part-way or sent nothing. Check the report before sending again.',
});

/** Sentences for the `detail` a code carries, where the detail changes the next step. */
const DETAIL_MESSAGES: Readonly<Partial<Record<SpecialistRefusal, Readonly<Record<string, string>>>>> = Object.freeze({
  wisp_disabled: { ai_kill_switch: 'AI actions are paused by the AI kill switch. An administrator has to lift it.' },
  org_out_of_ceiling: { site_restricted: 'This Wisp grant is limited to specific sites, and specialists work on a whole organization.' },
  invalid_params: {
    unknown_recipe: 'That recipe (workflowKey and workflowVersion) is not a released Operator recipe.',
    actor_required: 'A bulk ticket reply needs a person to approve the exact tickets and message.',
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
  },
});

/** The person-facing sentence for a refusal code and its optional detail. */
export function specialistRefusalMessage(refused: SpecialistRefusal, detail?: string): string {
  const byCode = DETAIL_MESSAGES[refused];
  // Own keys only: `detail` can carry model-supplied text (invalid_params).
  if (detail && byCode && Object.hasOwn(byCode, detail)) return byCode[detail]!;
  return MESSAGES[refused];
}
