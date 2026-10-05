/**
 * AI model registry W09 (#7607, #7570): which `ai_agents` assignment role a
 * run resolves its model from. Escalation is policy-driven per agent STAGE
 * (spec §14: never model-chosen inside a run):
 *   triage       a cheap first look — alert verdicts, ticket triage, shadow sweeps;
 *   analysis     investigation and planning — full shadow runs, analysis,
 *                narrative, design and patch-planning runs;
 *   remediation  runs that may change customer machines — act-mode full and
 *                act-mode sweep runs.
 * A role with no assignment row of its own inherits the `ai_agents` default
 * (assignments.ts), so a partner that configures nothing sees no change. An
 * agent policy's explicit offering pin still wins (W09 D3).
 */
import type { AiAgentEscalationRole, AiAgentRunProfile } from '@breeze/shared';

export const AGENT_PROFILE_ROLE = {
  verdict: 'triage',
  triage: 'triage',
  sweep: 'triage',
  full: 'analysis',
  analysis: 'analysis',
  narrative: 'analysis',
  design: 'analysis',
  patch: 'analysis',
  // AI Suggested Fixes W2 — read-only research reasoning, never act-mode.
  remediation_research: 'analysis',
} as const satisfies Record<AiAgentRunProfile, AiAgentEscalationRole>;

/** Profiles whose act mode executes actions on devices. */
export const ACT_MODE_REMEDIATION_PROFILES: ReadonlySet<AiAgentRunProfile> = new Set<AiAgentRunProfile>(['full', 'sweep']);

export function agentRunModelRole(run: { profile?: AiAgentRunProfile | null; modeAtStart?: string | null }): AiAgentEscalationRole {
  const profile: AiAgentRunProfile = run.profile ?? 'full';
  if (run.modeAtStart === 'act' && ACT_MODE_REMEDIATION_PROFILES.has(profile)) return 'remediation';
  return AGENT_PROFILE_ROLE[profile];
}
