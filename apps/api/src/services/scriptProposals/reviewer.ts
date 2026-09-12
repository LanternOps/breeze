// apps/api/src/services/scriptProposals/reviewer.ts
//
// The independent model review pass for an AI-authored script proposal
// (W02, #5612). See spec §4.4 for the full pipeline and this module's
// exported functions for the roadmap §3.4 contract this wave produces.
import type { RiskTier, ScriptReviewVerdict, ScriptScanResult, TouchClass } from '@breeze/shared';
import { riskTierRank } from '@breeze/shared';

export const SCRIPT_REVIEW_TIMEOUT_MS = 60_000;
export const SCRIPT_REVIEW_MAX_OUTPUT_TOKENS = 2_000;
export const REVIEWER_PROMPT_VERSION = '2026-09-11.1';

// spec §4.4 floors — raise only, applied AFTER the model, from the
// deterministic classifier, never from the model's own labels (D9).
const HIGH_FLOOR_TOUCH_CLASSES = new Set<TouchClass>(['credentials', 'security_tooling', 'boot', 'disk', 'shell_eval']);
const MEDIUM_FLOOR_TOUCH_CLASSES = new Set<TouchClass>(['users_groups', 'firewall', 'scheduled_tasks', 'registry']);

function higherTier(a: RiskTier, b: RiskTier): RiskTier {
  return riskTierRank(a) >= riskTierRank(b) ? a : b;
}

/**
 * Applies the spec §4.4 floors to a model-produced verdict. Pure and
 * deterministic: given the same verdict and scan input it always produces
 * the same output, and it can only RAISE `riskTier` or narrow
 * `recommendedAction` away from `approve` — it never lowers a risk tier the
 * model assigned, and never turns a `reject`/`changes` into `approve`.
 * The model's own `blastRadius` is never consulted (advisory only, D9).
 */
export function applyReviewFloors(
  verdict: ScriptReviewVerdict,
  scan: Pick<ScriptScanResult, 'strictHits' | 'touchClasses'>,
): ScriptReviewVerdict {
  let floor: RiskTier = 'low';
  if (scan.strictHits.length > 0) floor = higherTier(floor, 'medium');
  if (scan.touchClasses.some((c) => HIGH_FLOOR_TOUCH_CLASSES.has(c))) floor = higherTier(floor, 'high');
  if (scan.touchClasses.some((c) => MEDIUM_FLOOR_TOUCH_CLASSES.has(c))) floor = higherTier(floor, 'medium');

  const riskTier = higherTier(verdict.riskTier, floor);

  let recommendedAction = verdict.recommendedAction;
  if (verdict.goalMatch === 'no') recommendedAction = 'reject';
  if (verdict.verificationAdequate === false && recommendedAction === 'approve') recommendedAction = 'changes';

  return { ...verdict, riskTier, recommendedAction };
}
