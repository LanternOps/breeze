/**
 * Shared vocabulary for AI-authored scripts (spec
 * docs/superpowers/specs/ai-mcp/2026-09-11-ai-script-authoring-and-review-design.md).
 *
 * W01a creates this file with the two enums `script_versions` needs. W01b
 * extends it with the proposal DTOs (`ScriptProposal`, `ScriptProposalReview`,
 * `ScriptProposalStatus`) — do not move these two out when that lands.
 */

/** Birth record of a script version row. Mirrors the `script_origin` pg enum. */
export const SCRIPT_ORIGINS = ['human', 'ai_proposal', 'imported', 'system'] as const;
export type ScriptOrigin = (typeof SCRIPT_ORIGINS)[number];

/** How a run of this content was authorised. Stored as text, not a pg enum,
 *  because W03/W04 add values and a text column avoids an enum migration. */
export const SCRIPT_APPROVAL_METHODS = [
  'supervised_self',
  'four_eyes',
  'unattended_reviewer_gated',
  'direct_ui',
  'automation',
] as const;
export type ScriptApprovalMethod = (typeof SCRIPT_APPROVAL_METHODS)[number];

// ---------------------------------------------------------------------------
// Proposal DTOs (W01b, spec §4.1). The API returns these; web, mobile and
// helper read them.
// ---------------------------------------------------------------------------

export type ScriptProposalStatus =
  | 'proposed' | 'scan_rejected' | 'review_failed' | 'reviewed'
  | 'approved' | 'rejected' | 'changes_requested' | 'expired' | 'superseded'
  | 'executed' | 'verified' | 'verification_failed' | 'promoted';

export type ScriptProposalAuthorKind = 'chat_session' | 'agent_run';
export type ScriptProposalReviewerKind = 'static_scan' | 'model';
export type ScriptProposalReviewStatus = 'completed' | 'failed' | 'timeout';

export interface ScriptProposal {
  id: string;
  orgId: string;
  authorKind: ScriptProposalAuthorKind;
  sessionId: string | null;
  agentRunId: string | null;
  language: string;
  content: string;
  contentDigest: string;
  timeoutSeconds: number;
  runAs: 'system' | 'user';
  goal: string;
  expectedEffect: string;
  verification: unknown;
  rollbackNote: string | null;
  targetDeviceIds: string[];
  scannerVersion: string;
  basicHits: string[];
  strictHits: string[];
  touchClasses: string[];
  status: ScriptProposalStatus;
  revision: number;
  supersedesId: string | null;
  riskTier: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  intentId: string | null;
  verifiedAt: string | null;
  verificationResult: unknown;
  promotedScriptId: string | null;
  promotedVersionId: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface ScriptProposalReview {
  id: string;
  orgId: string;
  proposalId: string;
  reviewerKind: ScriptProposalReviewerKind;
  model: string | null;
  reviewerPromptVersion: string | null;
  status: ScriptProposalReviewStatus;
  summary: string | null;
  riskTier: string | null;
  goalMatch: 'yes' | 'partial' | 'no' | null;
  reversible: boolean | null;
  verificationAdequate: boolean | null;
  recommendedAction: 'approve' | 'changes' | 'reject' | null;
  verdict: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  costCents: string | null;
  createdAt: string;
}
