import { z } from 'zod';
import { SCRIPT_LANGUAGES } from '../constants';
import type { RiskTier } from '../utils/assuranceLevel';

/**
 * `RiskTier` is the SAME type the assurance-floor module already exports (the
 * root barrel re-exports both, so they must be one declaration, not two
 * identical ones). The runtime vocabulary lives here.
 */
export type { RiskTier } from '../utils/assuranceLevel';
export const RISK_TIERS = ['low', 'medium', 'high', 'critical'] as const satisfies readonly RiskTier[];

/** low 0 … critical 3. Comparisons against a ceiling use this, never string order. */
export function riskTierRank(tier: RiskTier): number {
  return RISK_TIERS.indexOf(tier);
}

export const SCRIPT_PROPOSAL_STATUSES = [
  'proposed', 'scan_rejected', 'review_failed', 'reviewed',
  'approved', 'rejected', 'changes_requested', 'expired', 'superseded',
  'executed', 'verified', 'verification_failed', 'promoted',
] as const;

/**
 * v1 verification claims (spec §4.9). `exit_code` and `output_matches` are
 * EXECUTION evidence, not independent observation — the reviewer must mark
 * `verificationAdequate: false` when one of them is the only claim behind a
 * service, disk or application goal.
 */
export const scriptVerificationClaimSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exit_code'), equals: z.number().int().min(-2147483648).max(2147483647).default(0) }),
  z.object({ kind: z.literal('service_running'), name: z.string().min(1).max(255) }),
  z.object({ kind: z.literal('process_absent'), name: z.string().min(1).max(255) }),
  z.object({ kind: z.literal('file_exists'), path: z.string().min(1).max(1024) }),
  z.object({
    kind: z.literal('output_matches'),
    // Compiled here so an uncompilable claim is rejected at authoring time
    // rather than throwing inside the verification worker three minutes later.
    regex: z.string().min(1).max(512).refine((value) => {
      try { new RegExp(value); return true; } catch { return false; }
    }, { message: 'regex must compile' }),
  }),
]);
export type ScriptVerificationClaim = z.infer<typeof scriptVerificationClaimSchema>;

export const proposeScriptInputSchema = z.object({
  language: z.enum(SCRIPT_LANGUAGES),
  content: z.string().min(1).max(65536),
  goal: z.string().min(1).max(2000),
  expectedEffect: z.string().min(1).max(2000),
  verification: scriptVerificationClaimSchema,
  rollbackNote: z.string().max(2000).optional(),
  deviceIds: z.array(z.string().uuid()).min(1).max(10),
  // 'elevated' is deliberately absent: the elevation ceremony has its own
  // approval path and a proposal must not be able to reach it (spec §4.1).
  runAs: z.enum(['system', 'user']).default('system'),
  timeoutSeconds: z.number().int().min(1).max(3600).default(300),
  supersedesProposalId: z.string().uuid().optional(),
});
export type ProposeScriptInput = z.infer<typeof proposeScriptInputSchema>;

const scriptReviewFindingSchema = z.object({
  severity: z.enum(['info', 'warning', 'blocking']),
  text: z.string().min(1),
  lineRef: z.number().int().min(1).optional(),
});

/** The reviewer model's structured verdict (spec §4.4). W02 (#5612). */
export const scriptReviewVerdictSchema = z.object({
  summary: z.string().min(1).max(600),
  goalMatch: z.enum(['yes', 'partial', 'no']),
  riskTier: z.enum(RISK_TIERS),
  // Advisory only — spec §4.4: "no enforcement reads it" (D9). Stored and
  // shown to the human, never consulted by applyReviewFloors or the W04 lane.
  blastRadius: z.array(z.string()).default([]),
  reversible: z.boolean(),
  verificationAdequate: z.boolean(),
  findings: z.array(scriptReviewFindingSchema),
  recommendedAction: z.enum(['approve', 'changes', 'reject']),
});
export type ScriptReviewVerdict = z.infer<typeof scriptReviewVerdictSchema>;

// ---------------------------------------------------------------------------
// W03 (#5612): human-loop route schemas.
// ---------------------------------------------------------------------------

/** Well above the STRICT vocabulary size; mirrors MAX_ACKNOWLEDGED_SECURITY_PATTERNS
 *  in apps/api/src/services/scriptSecurityAcknowledgement.ts. */
export const MAX_ACKNOWLEDGED_PATTERNS = 64;

export const acknowledgedPatternsSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(MAX_ACKNOWLEDGED_PATTERNS)
  .default([]);

export const scriptProposalRequestChangesSchema = z.object({
  note: z.string().trim().min(1).max(2000),
});

export const scriptProposalPromoteSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).optional(),
  ownerScope: z.enum(['organization', 'partner']),
});

export type ScriptProposalRequestChangesInput = z.infer<typeof scriptProposalRequestChangesSchema>;
export type ScriptProposalPromoteInput = z.infer<typeof scriptProposalPromoteSchema>;
