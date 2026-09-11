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
