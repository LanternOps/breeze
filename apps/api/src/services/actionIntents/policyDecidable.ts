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
import { isSecretBearingTool } from './secretBearingTools';

export interface PolicyDecidableEntry {
  /** `toolName` for a bare-tool entry, or `toolName:action` for a multiplexed one. */
  key: string;
  toolName: string;
  action: string | null;
  /**
   * Verified by reading the tool's execution path (see the file/line comment
   * on each entry below), not inferred from tier tables. A tool that needs a
   * live interactive session (M365/Google helpdesk tools, computer_control,
   * create_remote_session) can never be headless-compatible and must never
   * appear here with `true`.
   */
  headlessCompatible: boolean;
  /**
   * v1 entries are all single-device, single-target actions (one service,
   * one scheduled task, one threat). A wider-cardinality action (e.g. a
   * bulk operation) is a different — and not yet designed — policy-decision
   * shape, so the type pins this to the literal `1` rather than `number`.
   */
  maxTargetCardinality: 1;
  /**
   * True when the action's target (service name, task path, threat id) must
   * be pinned into the effect digest for a policy decision to be meaningful
   * — a policy that authorizes "restart a service" only makes sense bound to
   * a specific named service, not a wildcard. Every v1 entry takes such a
   * named target, so this is `true` throughout; the field exists so a future
   * entry that authorizes a whole-device action with no sub-target (were one
   * ever added) can correctly declare `false`.
   */
  requiresEffectPin: boolean;
  note: string;
}

/**
 * Ordering here is the source of truth for `key`'s docs above: a `tool:action`
 * entry always names the multiplexed action explicitly. Every entry's
 * `headlessCompatible: true` was verified by reading the tool's registration
 * in aiToolsScripts.ts / aiToolsSecurity.ts / aiToolsPerformance.ts — each
 * dispatches through the agent command queue (`executeCommand`), the same
 * headless RPC path as every other agent-side tool, with no interactive
 * session dependency. This is also confirmed structurally: none of these
 * tools appear in `requiresLiveSession` (they are registered in the headless
 * `aiTools` map, not the M365/Google session-aware maps) — pinned by the
 * "headlessCompatible matches requiresLiveSession" test below.
 */
export const POLICY_DECIDABLE_TIER3: readonly PolicyDecidableEntry[] = Object.freeze([
  // manage_services (aiToolsScripts.ts) — start/stop/restart dispatch via
  // executeCommand(deviceId, 'start_service' | 'stop_service' | 'restart_service', …).
  {
    key: 'manage_services:start',
    toolName: 'manage_services',
    action: 'start',
    headlessCompatible: true,
    maxTargetCardinality: 1,
    requiresEffectPin: true,
    note: 'Starts one named service on one device via the agent command queue.',
  },
  {
    key: 'manage_services:stop',
    toolName: 'manage_services',
    action: 'stop',
    headlessCompatible: true,
    maxTargetCardinality: 1,
    requiresEffectPin: true,
    note: 'Stops one named service on one device via the agent command queue.',
  },
  {
    key: 'manage_services:restart',
    toolName: 'manage_services',
    action: 'restart',
    headlessCompatible: true,
    maxTargetCardinality: 1,
    requiresEffectPin: true,
    note: 'Restarts one named service on one device via the agent command queue.',
  },
  // manage_startup_items (aiToolsPerformance.ts) — disable/enable dispatch via
  // executeCommand after resolving the item against the latest boot record.
  {
    key: 'manage_startup_items:disable',
    toolName: 'manage_startup_items',
    action: 'disable',
    headlessCompatible: true,
    maxTargetCardinality: 1,
    requiresEffectPin: true,
    note: 'Disables one named startup item on one device via the agent command queue.',
  },
  {
    key: 'manage_startup_items:enable',
    toolName: 'manage_startup_items',
    action: 'enable',
    headlessCompatible: true,
    maxTargetCardinality: 1,
    requiresEffectPin: true,
    note: 'Enables one named startup item on one device via the agent command queue.',
  },
  // manage_scheduled_tasks (aiToolsScripts.ts) — run/disable/enable dispatch
  // via executeCommand(deviceId, CommandTypes.TASK_RUN | TASK_DISABLE | TASK_ENABLE, …).
  {
    key: 'manage_scheduled_tasks:run',
    toolName: 'manage_scheduled_tasks',
    action: 'run',
    headlessCompatible: true,
    maxTargetCardinality: 1,
    requiresEffectPin: true,
    note: 'Runs one named scheduled task on one device via the agent command queue.',
  },
  {
    key: 'manage_scheduled_tasks:disable',
    toolName: 'manage_scheduled_tasks',
    action: 'disable',
    headlessCompatible: true,
    maxTargetCardinality: 1,
    requiresEffectPin: true,
    note: 'Disables one named scheduled task on one device via the agent command queue.',
  },
  {
    key: 'manage_scheduled_tasks:enable',
    toolName: 'manage_scheduled_tasks',
    action: 'enable',
    headlessCompatible: true,
    maxTargetCardinality: 1,
    requiresEffectPin: true,
    note: 'Enables one named scheduled task on one device via the agent command queue.',
  },
  // security_scan (aiToolsSecurity.ts) — quarantine/remove/restore dispatch via
  // executeCommand(deviceId, 'security_threat_quarantine' | '_remove' | '_restore', { threatId }).
  {
    key: 'security_scan:quarantine',
    toolName: 'security_scan',
    action: 'quarantine',
    headlessCompatible: true,
    maxTargetCardinality: 1,
    requiresEffectPin: true,
    note: 'Quarantines one named threat on one device via the agent command queue.',
  },
  {
    key: 'security_scan:remove',
    toolName: 'security_scan',
    action: 'remove',
    headlessCompatible: true,
    maxTargetCardinality: 1,
    requiresEffectPin: true,
    note: 'Removes one named threat on one device via the agent command queue.',
  },
  {
    key: 'security_scan:restore',
    toolName: 'security_scan',
    action: 'restore',
    headlessCompatible: true,
    maxTargetCardinality: 1,
    requiresEffectPin: true,
    note: 'Restores one named threat on one device via the agent command queue.',
  },
  // --- Explicitly EXCLUDED from v1 (do not add without a fresh quorum) ---
  //
  // run_script / execute_playbook: the act-mode `actAssets` lane (wave 4 part
  // B) already owns script/playbook authorization end to end — one lane per
  // asset class, not two competing authorization paths for the same tool.
  //
  // execute_command: program-locked exclusion. Its sub-operation is keyed on
  // `commandType`, not `action` (see TOOL_ACTION_INPUT_KEYS), and its
  // TIER3_SUPERVISED_TOOLS membership is a whole-tool catch-all covering an
  // open-ended, free-form command surface — no fixed, reviewable action list
  // to scope a policy decision to.
  //
  // manage_processes:kill: the tool is currently unregistered from dispatch
  // (#4149) — nothing to authorize yet.
  //
  // file_operations / registry_operations: unbounded target surface (any
  // path / any registry key). Each needs its own per-entry target pin design
  // before it can be policy-decidable — deferred to a future quorum, not a
  // v1 gap.
  //
  // Everything in TIER3_FOUR_EYES_TOOLS / TIER3_FOUR_EYES_ACTIONS: four_eyes
  // by definition requires a SECOND human — policy is a mechanism, not a
  // principal, and cannot stand in for that second reviewer (quorum,
  // 2026-08-28).
]);

const BY_KEY: ReadonlyMap<string, PolicyDecidableEntry> = new Map(
  POLICY_DECIDABLE_TIER3.map((entry) => [entry.key, entry]),
);

/**
 * Version of the POLICY_DECIDABLE_TIER3 registry that produced a given
 * policy decision, stamped into `action_intents.policy_classification_version`
 * (Part B, policyDecide.ts) the same way `intentService.ts`'s
 * `CLASSIFICATION_VERSION` pins the tier3-supervised-four-eyes ruleset. Bump
 * when the registry's membership or its `rejectionReasonFor` re-classification
 * logic changes in a materially observable way — a decision made under v1
 * must stay distinguishable from one made under a future, differently-scoped
 * v2 (e.g. if `maxTargetCardinality` ever admits >1 or a new tool joins).
 */
export const POLICY_DECIDABLE_TIER3_VERSION = 1;

export function isPolicyDecidableKey(key: string): boolean {
  return BY_KEY.has(key);
}

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
