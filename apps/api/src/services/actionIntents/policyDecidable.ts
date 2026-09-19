/**
 * POLICY_DECIDABLE_TIER3 — the registry of Tier-3 (tool, action) pairs that
 * Part B's `attemptPolicyDecision` is eventually allowed to authorize without
 * human fanout, when a matching policy exists and the org's unattended-
 * exposure blast cap has room.
 *
 * THIS MODULE HAS NO RUNTIME CONSUMER IN THIS PR. `resolvePolicyDecisionState`
 * (intentService.ts) is a PR-A stub that always returns `'human_required'`
 * regardless of this registry's contents — see the Part-B pointer comment
 * there. This file exists so the data and its validators can be reviewed,
 * tested, and locked down ahead of the decision logic that will read it.
 *
 * v1 is deliberately conservative: every entry is a single-target,
 * agent-dispatched (headless, no live interactive session), non-financial,
 * non-identity mutation whose worst case is reversible on the same device.
 * Membership here is NOT a claim that the action is safe to auto-approve —
 * it only says the action is a CANDIDATE for policy decision; Part B still
 * gates on an actual policy match, the exposure ledger, and the kill state.
 *
 * Explicitly EXCLUDED from v1 (see inline comments below for the per-item
 * rationale): run_script, execute_playbook, execute_command,
 * manage_processes:kill, file_operations, registry_operations, and every
 * tool/action already classified `four_eyes` in aiGuardrails.ts.
 */
import {
  BLOCKED_TOOLS,
  TIER1_ACTIONS,
  TIER2_ACTIONS,
  TIER3_ACTIONS,
  TIER3_FOUR_EYES_ACTIONS,
  TIER3_FOUR_EYES_TOOLS,
  TIER3_SUPERVISED_ACTIONS,
  TOOL_ACTION_INPUT_KEYS,
} from '../aiGuardrails';
import { getToolTier, requiresLiveSession } from '../aiTools';
import {
  POLICY_DECIDABLE_TIER3,
  isPolicyDecidableKey,
  type PolicyDecidableEntry,
} from './policyDecidableKeys';
import { isSecretBearingTool } from './secretBearingTools';

// Re-exported unchanged for every existing caller of this module — the
// registry itself and `isPolicyDecidableKey` now live in `policyDecidableKeys.ts`
// (a leaf module with no `aiGuardrails.ts`/`aiTools.ts` dependency) so that
// `graduationService.ts` can import `isPolicyDecidableKey` WITHOUT dragging
// `aiTools.ts` — and, transitively, `routes/agentWs.ts` /
// `services/agentCommandAwait.ts` — into the `global`-placement graduation
// worker's closure. See `policyDecidableKeys.ts`'s header for the full story.
export { POLICY_DECIDABLE_TIER3, POLICY_DECIDABLE_TIER3_VERSION, isPolicyDecidableKey } from './policyDecidableKeys';
export type { PolicyDecidableEntry } from './policyDecidableKeys';

const BY_KEY: ReadonlyMap<string, PolicyDecidableEntry> = new Map(
  POLICY_DECIDABLE_TIER3.map((entry) => [entry.key, entry]),
);

export interface RejectedAuthorizationKey {
  key: string;
  reason: string;
}

/**
 * True iff `toolName` multiplexes sub-operations by input key — i.e. a
 * bare-tool authorization key for it would be ambiguous about which
 * operation(s) it covers. Checked against every tier table a tool's actions
 * can appear in, plus the explicit commandType-keyed override
 * (TOOL_ACTION_INPUT_KEYS), so this stays true even for a tool whose actions
 * are all Tier 1/2 today but could gain a Tier 3 entry later.
 */
function isActionMultiplexedTool(toolName: string): boolean {
  return (
    toolName in TOOL_ACTION_INPUT_KEYS
    || toolName in TIER1_ACTIONS
    || toolName in TIER2_ACTIONS
    || toolName in TIER3_ACTIONS
    || toolName in TIER3_FOUR_EYES_ACTIONS
    || toolName in TIER3_SUPERVISED_ACTIONS
  );
}

/**
 * Defense-in-depth re-classification, independent of registry membership:
 * even for a key already IN POLICY_DECIDABLE_TIER3, re-derive its live
 * approval scope from aiGuardrails' tables and reject if it no longer reads
 * `supervised` (four_eyes escalation, tier-4 block, or secret-bearing
 * status), or if it is a bare-tool key for a tool that has since become
 * action-multiplexed. This is what keeps a future registry-vs-guardrails
 * drift from silently reopening a four_eyes action to policy decision.
 */
// Exported (not module-private) solely so tests can exercise it directly
// against a synthetic entry — every REAL entry in the frozen
// POLICY_DECIDABLE_TIER3 registry already satisfies every one of these
// checks (pinned by the module-header assertions in policyDecidable.test.ts),
// so `validateAuthorizationKeys` alone can never hit some of these branches
// (the `headlessCompatible` one, in particular) through the public API today.
export function rejectionReasonFor(entry: PolicyDecidableEntry): string | null {
  const { toolName, action } = entry;

  if (BLOCKED_TOOLS.has(toolName) || getToolTier(toolName) === 4) {
    return 'tool is Tier 4 / blocked';
  }
  if (isSecretBearingTool(toolName)) {
    return 'tool is secret-bearing';
  }
  // Review fix (#3827): structural enforcement of the module-header claim
  // ("every entry claims headlessCompatible: true") — previously only
  // asserted by policyDecidable.test.ts, never enforced by
  // `validateAuthorizationKeys` itself. `attemptPolicyDecision` runs fully
  // unattended with no live interactive session, so an entry that ever
  // regressed to `headlessCompatible: false` (e.g. a copy-paste of an
  // M365/Google/computer-control entry) must be rejected here directly, not
  // rely solely on `requiresLiveSession` below staying in sync with it.
  if (!entry.headlessCompatible) {
    return 'not headless-compatible';
  }
  if (action === null && isActionMultiplexedTool(toolName)) {
    return 'bare-tool key for an action-multiplexed tool';
  }
  if (action && TIER3_FOUR_EYES_ACTIONS[toolName]?.includes(action)) {
    return 'tool:action is classified four_eyes';
  }
  if (action === null && TIER3_FOUR_EYES_TOOLS.has(toolName)) {
    return 'tool is classified four_eyes';
  }
  if (requiresLiveSession(toolName)) {
    return 'tool requires a live interactive session';
  }

  return null;
}

export function validateAuthorizationKeys(
  keys: string[],
): { ok: string[]; rejected: RejectedAuthorizationKey[] } {
  const ok: string[] = [];
  const rejected: RejectedAuthorizationKey[] = [];

  for (const key of keys) {
    const entry = BY_KEY.get(key);
    if (!entry) {
      rejected.push({ key, reason: 'not registered in POLICY_DECIDABLE_TIER3' });
      continue;
    }

    const reason = rejectionReasonFor(entry);
    if (reason) {
      rejected.push({ key, reason });
      continue;
    }

    ok.push(key);
  }

  return { ok, rejected };
}
