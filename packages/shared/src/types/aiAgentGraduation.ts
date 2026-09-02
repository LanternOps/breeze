// Phase 2 wave P2-5 (#4192) — evidence ledger + graduation types.
//
// Every terminal outcome an agent produces (a released action intent, an
// act-mode manifest execution, a fix-watch verdict, a 👍/👎 on an alert
// verdict) writes exactly ONE immutable row into `ai_agent_op_evidence`,
// keyed by `(source_kind, source_id, metric)` so BullMQ redelivery can never
// double-count. `graduationService` (A2) reads that ledger over a trailing
// window and moves an `(org, agent, op_key)` tuple through
// `tracking → eligible → promoted → demoted → tracking`.
//
// See spec §4.5 (amended 2026-09-01, quorum) for the full design.

/**
 * Evidence namespace. `policy_key` / `act_op` cover outcome evidence from
 * released intents, watches, and act executions; `alert_verdict` covers
 * 👍/👎 feedback on an agent's alert-verdict submissions.
 */
export const AI_AGENT_EVIDENCE_NAMESPACES = ['policy_key', 'act_op', 'alert_verdict'] as const;
export type AiAgentEvidenceNamespace = (typeof AI_AGENT_EVIDENCE_NAMESPACES)[number];

/** What kind of terminal event produced an evidence row. */
export const AI_AGENT_EVIDENCE_SOURCE_KINDS = ['intent', 'watch', 'act_execution', 'verdict_feedback'] as const;
export type AiAgentEvidenceSourceKind = (typeof AI_AGENT_EVIDENCE_SOURCE_KINDS)[number];

/**
 * Six metrics, not "success/failure". `executed`, `verified`, `failed`,
 * `recurred` cover the `policy_key` / `act_op` namespaces (`failed` counts
 * ATTEMPTED failures only — the terminal write stamps `executed_at`;
 * revalidation refusals and pre-execution digest stops are NOT failures).
 * `feedback_up` / `feedback_down` cover the `alert_verdict` namespace,
 * written by `recordVerdictFeedback`'s 👍/👎.
 */
export const AI_AGENT_EVIDENCE_METRICS = [
  'executed', 'verified', 'failed', 'recurred', 'feedback_up', 'feedback_down',
] as const;
export type AiAgentEvidenceMetric = (typeof AI_AGENT_EVIDENCE_METRICS)[number];

/** `ai_agent_graduation.state` — the fourth state `tracking` covers a key with no evidence yet. */
export const AI_AGENT_GRADUATION_STATES = ['tracking', 'eligible', 'promoted', 'demoted'] as const;
export type AiAgentGraduationState = (typeof AI_AGENT_GRADUATION_STATES)[number];

/** Why a `tracking`/`demoted` key isn't `eligible` yet. */
export const AI_AGENT_GRADUATION_BLOCKED_REASONS = [
  'needs_partner_baseline', 'below_threshold', 'too_recent', 'has_failures', 'not_policy_decidable',
] as const;
export type AiAgentGraduationBlockedReason = (typeof AI_AGENT_GRADUATION_BLOCKED_REASONS)[number];

/** Literal `op_key` every `alert_verdict`-namespace evidence row carries. */
export const AI_AGENT_ALERT_VERDICT_OP_KEY = 'alert_verdict';

/** Trailing evidence window, in days, `graduationService` reads over. */
export const AI_AGENT_GRADUATION_WINDOW_DAYS = 30;

/** Minimum age of the window's first `verified` row before a key can graduate. */
export const AI_AGENT_GRADUATION_MIN_AGE_DAYS = 14;

/** Evidence retention — bounded by executions/watches/verdicts per day, so no rollup is needed. */
export const AI_AGENT_EVIDENCE_RETENTION_DAYS = 400;

export interface AiAgentGraduationWindow {
  executed: number;
  verified: number;
  failed: number;
  recurred: number;
  /** ISO timestamp of the window's earliest `verified` row, or null if none. */
  firstVerifiedAt: string | null;
}

export interface AiAgentGraduationRowDto {
  opKey: string;
  namespace: AiAgentEvidenceNamespace;
  state: AiAgentGraduationState;
  window: AiAgentGraduationWindow;
  blockedReason: AiAgentGraduationBlockedReason | null;
  promotedAt: string | null;
  demotedAt: string | null;
  demoteReason: string | null;
}

export interface AiAgentActOpReliabilityDto {
  opKey: string;
  executed: number;
  verified: number;
  failed: number;
  recurred: number;
}

export interface AiAgentGraduationDto {
  version: 1;
  agentId: string;
  ownerScope: 'partner' | 'organization';
  rows: AiAgentGraduationRowDto[];
  actOpReliability: AiAgentActOpReliabilityDto[];
  promoteThreshold: number;
  policyDecideEnabled: boolean;
}

export interface AiAgentGraduationByOrgDto {
  version: 1;
  promoteThreshold: number;
  policyDecideEnabled: boolean;
  byOrg: Array<{
    orgId: string;
    orgName: string;
    agentId: string;
    rows: AiAgentGraduationRowDto[];
    actOpReliability: AiAgentActOpReliabilityDto[];
  }>;
}
