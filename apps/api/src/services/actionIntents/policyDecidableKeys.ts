/**
 * `POLICY_DECIDABLE_TIER3`'s frozen key registry and `isPolicyDecidableKey`,
 * split out of `policyDecidable.ts` (P2-5, #4192, Task A2-3) into a leaf
 * module with NO imports — the registry array is a literal data table (every
 * field a plain string/boolean, no reference to `aiGuardrails.ts` or
 * `aiTools.ts`), so it never needed `policyDecidable.ts`'s two runtime
 * dependencies in the first place. `rejectionReasonFor`/
 * `validateAuthorizationKeys` (which DO need `getToolTier`/
 * `requiresLiveSession` from `aiTools.ts`) stay in `policyDecidable.ts`,
 * which re-exports everything below unchanged for its existing callers.
 *
 * Why this exists: `services/aiAgents/graduationService.ts`'s
 * `evaluateEligibility` calls `isPolicyDecidableKey` as the FIRST rung of the
 * eligibility ladder, and the daily graduation sweep
 * (`jobs/aiAgentGraduationWorker.ts`) runs that ladder from a `global`
 * -placement BullMQ worker (`workerRegistry.ts`, `aiAgentGraduation`) that
 * MUST NOT reach socket-local dispatch (`workerEntrypointClosure.contract.test.ts`).
 * Importing `isPolicyDecidableKey` from `policyDecidable.ts` directly would
 * drag `aiTools.ts` in for `rejectionReasonFor`'s sake alone — and `aiTools.ts`
 * transitively reaches `routes/agentWs.ts` /
 * `services/agentCommandAwait.ts` via `aiToolsAgentLogs.ts` ->
 * `commandQueue.ts`, exactly the graph bloat `workerRegistry.ts`'s own
 * `aiAgentGraduation` entry comment warns against. This module is the fix:
 * `graduationService.ts` imports `isPolicyDecidableKey` from HERE, not from
 * `policyDecidable.ts`, so the worker's closure never touches `aiTools.ts`.
 * Same pattern as `canonicalPolicyKey.ts` (Deviation #2) — one leaf
 * definition, no graph bloat, the richer module imports the leaf back in.
 */

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
