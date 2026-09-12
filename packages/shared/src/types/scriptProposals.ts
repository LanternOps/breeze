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

// ---------------------------------------------------------------------------
// W03 (#5612): the detail DTO every approval surface renders.
// ---------------------------------------------------------------------------

export interface ScriptProposalExecutionDto {
  id: string;
  deviceId: string;
  deviceHostname: string | null;
  status: string;
  exitCode: number | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ScriptProposalVerificationDto {
  outcome: 'pending' | 'verified' | 'verification_failed' | 'unknown';
  verifiedAt: string | null;
  attempts: number;
  /** Human-readable, already-safe explanation; never raw device output. */
  detail: string | null;
}

export interface ScriptProposalReviewFindingDto {
  severity: 'info' | 'warning' | 'blocking';
  text: string;
  lineRef?: number;
}

/** The one shape every approval surface renders. Dates are ISO strings —
 *  this crosses an HTTP boundary and is consumed by React Native too. */
export interface ScriptProposalDetailDto {
  proposal: {
    id: string;
    status: ScriptProposalStatus;
    language: string;
    content: string;
    contentDigest: string;
    goal: string;
    expectedEffect: string;
    rollbackNote: string | null;
    verification: unknown;
    runAs: string;
    timeoutSeconds: number;
    targetDeviceIds: string[];
    basicHits: string[];
    strictHits: string[];
    touchClasses: string[];
    riskTier: string | null;
    revision: number;
    acknowledgedPatterns: string[];
    intentId: string | null;
    createdAt: string;
    expiresAt: string;
    promotedScriptId: string | null;
  };
  review: {
    id: string;
    summary: string | null;
    riskTier: string | null;
    goalMatch: string | null;
    reversible: boolean | null;
    verificationAdequate: boolean | null;
    recommendedAction: string | null;
    findings: ScriptProposalReviewFindingDto[];
    blastRadius: string[];
    model: string | null;
    createdAt: string;
  } | null;
  devices: Array<{ id: string; hostname: string; osType: string | null; status: string }>;
  executions: ScriptProposalExecutionDto[];
  verification: ScriptProposalVerificationDto;
  /** Live-derived for THIS caller — never cached, never trusted from the client. */
  viewer: { canDecide: boolean; canAcknowledge: boolean; canPromote: boolean };
}
