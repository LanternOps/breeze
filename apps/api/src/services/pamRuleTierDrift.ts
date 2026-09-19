/**
 * PAM rule risk-tier drift detection (#3128).
 *
 * A tool-action PAM rule selects invocations by `matchToolName` and/or
 * `matchRiskTier`, and `pamRuleEngine` matches the tier by EXACT equality.
 * Tool tiers, however, are static code that ships with the API: #3105 moved
 * three read-only `execute_command` commandTypes from Tier 3 to Tier 2, and
 * every rule written against the old classification quietly stopped covering
 * them. The no-match default is `pending`, so the failure direction is safe —
 * but it is invisible, which is the actual complaint in #3128.
 *
 * The match semantics are deliberately NOT changed here (a "tier or higher"
 * comparison would move auto-approval boundaries on every existing rule, which
 * is a policy change, not a bug fix). Instead this module answers one question:
 *
 *   "Can the tool selector this rule uses still resolve to this tier at all?"
 *
 * A rule whose tier is unreachable is dead — it can never match again — and
 * that IS actionable, at write time (400), at boot (operator warning), and in
 * the rule list (UI badge).
 *
 * LIMITATION, on purpose: this does not flag a rule that merely NARROWED, such
 * as the #3128 rule itself (`execute_command` + tier 3 still covers file_read
 * and kill_process). 32 of the ~219 registered tools legitimately span several
 * tiers, so flagging every partial selector would be pure noise and would train
 * operators to ignore the warning.
 *
 * The reachable set is DERIVED by probing `checkGuardrails` — the same resolver
 * the PAM candidate's tier comes from (aiAgentSdk -> decideHelperToolAction) —
 * rather than by re-reading the TIER*_ACTIONS tables. Duplicating those lookups
 * is exactly the hand-maintained-mirror failure this issue is about.
 */
import {
  checkGuardrails,
  TIER1_ACTIONS,
  TIER2_ACTIONS,
  TIER3_ACTIONS,
  TOOL_ACTION_INPUT_KEYS,
} from './aiGuardrails';
import { getAllRegisteredToolNames, getToolTier } from './aiTools';

export interface PamRuleTierSelector {
  matchToolName?: string | null;
  matchRiskTier?: number | null;
  /**
   * Criterion keys the engine INVERTS (pamRuleEngine's `satisfied()`), which
   * changes what "reachable" means — see describePamRuleTierDrift.
   */
  matchNegate?: readonly string[] | null;
}

export interface PamRuleTierDrift {
  /** The stored tier that can no longer be produced. */
  matchRiskTier: number;
  /** The rule's tool selector, or null when the rule matches any tool. */
  matchToolName: string | null;
  /** Tiers the selector CAN currently resolve to, ascending. */
  validTiers: number[];
  /** Operator-facing explanation; also used as the API 400 message. */
  message: string;
}

/** Machine-readable code on the write-path 400. */
export const PAM_RULE_TIER_UNREACHABLE_CODE = 'pam_rule_risk_tier_unreachable';

/**
 * Canonical registered tool names keyed by lowercase name. `pamRuleEngine`
 * compares `matchToolName` case-insensitively (eqCi), so resolving
 * case-sensitively here would silently skip validation for a rule stored as
 * e.g. 'Manage_Services' — which the engine does match.
 *
 * Built once: getAllRegisteredToolNames() is the static core registry, fully
 * populated by import time and never mutated afterwards. Extension tools are
 * deliberately excluded from it (they are per-tenant and dynamic), so they
 * fall through to the exact getToolTier() lookup below.
 */
let lowercaseToolIndex: Map<string, string> | null = null;

function canonicalToolName(toolName: string): string | null {
  lowercaseToolIndex ??= new Map(getAllRegisteredToolNames().map((n) => [n.toLowerCase(), n]));
  return lowercaseToolIndex.get(toolName.toLowerCase()) ?? null;
}

/** Every sub-operation the tier tables enumerate for a tool. */
function enumeratedActions(toolName: string): string[] {
  return [
    ...new Set([
      ...(TIER1_ACTIONS[toolName] ?? []),
      ...(TIER2_ACTIONS[toolName] ?? []),
      ...(TIER3_ACTIONS[toolName] ?? []),
    ]),
  ];
}

/**
 * Tiers `checkGuardrails` can currently return for `toolName`, ascending.
 * Returns null when the tool is not recognised — an unrecognised name must
 * fail OPEN (extension tools are per-tenant and may not be resolvable in this
 * process), so callers treat null as "cannot judge", never as "invalid".
 */
export function reachableRiskTiersForTool(toolName: string): number[] | null {
  let canonical = canonicalToolName(toolName);
  if (canonical === null) {
    // Not in the core registry — it may still be an extension tool, which
    // getToolTier resolves through the extension contribution registry.
    // getToolTier throws on a core/extension name collision; a validator must
    // never turn that into a failed rule write.
    try {
      if (getToolTier(toolName) === undefined) return null;
    } catch {
      return null;
    }
    canonical = toolName;
  }

  const actionKey = TOOL_ACTION_INPUT_KEYS[canonical] ?? 'action';
  const tiers = new Set<number>();
  // The empty probe yields the base tier, which is always reachable: an action
  // absent from every TIER*_ACTIONS table falls through to it.
  const probes: Record<string, unknown>[] = [
    {},
    ...enumeratedActions(canonical).map((action) => ({ [actionKey]: action })),
  ];
  for (const probe of probes) {
    try {
      tiers.add(checkGuardrails(canonical, probe).tier);
    } catch {
      // A probe that throws tells us nothing about reachability; skip it
      // rather than narrowing the set and rejecting a legitimate rule.
    }
  }
  return tiers.size === 0 ? null : [...tiers].sort((a, b) => a - b);
}

/**
 * Union of the reachable tiers across every core registered tool, ascending.
 * Used for rules that pin a tier without naming a tool.
 */
let anyToolTiers: number[] | null = null;

export function reachableRiskTiersForAnyTool(): number[] {
  if (anyToolTiers) return anyToolTiers;
  const union = new Set<number>();
  for (const toolName of getAllRegisteredToolNames()) {
    for (const tier of reachableRiskTiersForTool(toolName) ?? []) union.add(tier);
  }
  anyToolTiers = [...union].sort((a, b) => a - b);
  return anyToolTiers;
}

/** Test seam: drop the memoised registry views. */
export function resetPamRuleTierDriftCaches(): void {
  lowercaseToolIndex = null;
  anyToolTiers = null;
}

/**
 * Describe why a rule's `matchRiskTier` can no longer match anything, or null
 * when the rule is fine (including every case where reachability is unknown).
 */
export function describePamRuleTierDrift(rule: PamRuleTierSelector): PamRuleTierDrift | null {
  const tier = rule.matchRiskTier;
  if (tier == null) return null;

  const negated = new Set(rule.matchNegate ?? []);

  // A NEGATED tier means "tier is NOT this". An unreachable value there simply
  // excludes nothing — the rule still matches everything else it selects, so it
  // is not dead and must not be rejected.
  if (negated.has('riskTier')) return null;

  // A negated tool name means "any tool EXCEPT this one", so the tier has to be
  // measured against the whole registry rather than the named tool's own set.
  const toolName = negated.has('toolName') ? null : rule.matchToolName || null;
  const validTiers = toolName === null
    ? reachableRiskTiersForAnyTool()
    : reachableRiskTiersForTool(toolName);

  // null => unrecognised tool: fail open, we cannot judge this rule.
  if (validTiers === null || validTiers.includes(tier)) return null;

  const tierList = validTiers.join(', ');
  const message = toolName === null
    ? `matchRiskTier ${tier} does not match any tool's current risk tier (tiers in use: ${tierList}). ` +
      'This rule can never match; pick one of the tiers in use.'
    : `matchRiskTier ${tier} does not match any current risk tier for tool "${toolName}" ` +
      `(it currently resolves to ${tierList}). This rule can never match; pick one of those tiers.`;

  return { matchRiskTier: tier, matchToolName: toolName, validTiers, message };
}
