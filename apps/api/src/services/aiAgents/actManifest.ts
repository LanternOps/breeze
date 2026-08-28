/**
 * Wave 4 Part B — the act-mode manifest.
 *
 * `ACT_MANIFEST` is the closed, hard-enumerated set of rule-equivalent
 * operations an act-mode agent may execute unattended. It is a FROZEN
 * LITERAL: growing it is a quorum decision (docs/superpowers/plans/ai-mcp/
 * 2026-08-27-ai-agents-wave4-b-act-mode.md), not a routine code change —
 * `actManifest.test.ts` pins the exact key set so an accidental addition
 * (or a silent removal) fails CI, not review.
 *
 * `resolveActOperation` is PURE and does NO I/O: it is called synchronously
 * from `checkAgentGuardrails` on every tool dispatch, so it can only decide
 * from the tool name + the input the model already sent. Anything that needs
 * a database round trip — is this playbookId actually a built-in row, does
 * this scriptId's digest still match, does a preview plan exist for this
 * device — is NOT decided here. It is decided by `revalidateActExecution`
 * (actRevalidation.ts, Task 3), which runs AFTER this resolver, with I/O,
 * against LIVE state, before anything executes. A `resolveActOperation` match
 * is necessary but never sufficient for execution.
 */

/** Op-specific identity extracted (purely, from input + the run's device) by `normalizeTarget`. */
export type ActTarget =
  | { kind: 'service'; serviceName: string }
  /**
   * `paths` only. The preview PLAN this execution is pinned to is DB state
   * (the latest `analyze_disk_usage`/`disk_cleanup:preview` snapshot for the
   * device) — normalizeTarget has no I/O, so it cannot resolve or carry a
   * planId. actRevalidation.ts resolves the plan and stamps it onto the
   * `ActAssetPin`, not onto this target.
   */
  | { kind: 'disk_cleanup'; paths: string[] }
  /**
   * NOT currently reachable via `ACT_MANIFEST` (deferred out of v1, #3826
   * scoped re-review — see the removed `manageProcessesKill` entry's former
   * location below for why). `processName` alongside `pid` is required
   * shape, but that is only a presence check done here, purely, from the
   * model's own input — there is no dispatch-time re-read of the live
   * process list to confirm the pid still names that process. Do not read
   * this as "a stale-pid kill is rejected"; no such revalidation exists yet.
   */
  | { kind: 'process'; pid: string; processName: string }
  /** Content digest is resolved (I/O) and pinned by actRevalidation.ts, not carried here. */
  | { kind: 'script'; scriptId: string }
  | { kind: 'playbook'; playbookId: string }
  | { kind: 'suggestion'; suggestionId: string };

/**
 * How Task 4 (actVerify.ts) reads back the op's own postcondition. `kind`
 * names the read-back family; the concrete comparison (target service name,
 * target pid, byte/percent thresholds) is derived from the `ActTarget` at
 * verify time, not stored redundantly here.
 */
export interface ActVerifySpec {
  kind:
    | 'service_running'
    | 'disk_usage_improved'
    | 'process_absent'
    | 'script_exit_code'
    /** execute_playbook's aggregate is computed by playbookActExecutor.ts's own per-step verifies. */
    | 'playbook_aggregate'
    /** remediation_suggestion is virtual — it resolves to `run_script`'s spec, never its own. */
    | 'none';
}

export interface ActOperation {
  /** Stable, frozen key. Also what `ACT_MANIFEST` is enumerated by in tests. */
  key: string;
  /**
   * The MCP tool name this op is dispatched through. `remediation_suggestion`
   * uses a sentinel that is never a real registered tool name — see the
   * manifest entry below for why that is load-bearing, not incidental.
   */
  toolName: string;
  /** Pure. Decides whether THIS call is the rule-equivalent shape the op covers. */
  matches(input: Record<string, unknown>): boolean;
  /**
   * Pure, no I/O. Extracts the op's target identity from input, rejecting a
   * call whose device argument(s) do not match the run's own device — an
   * act-mode agent is single-device (Global Constraints), so any mismatch
   * here is fail-closed, never "pick one".
   */
  normalizeTarget(
    input: Record<string, unknown>,
    runDeviceId: string,
  ): { ok: true; target: ActTarget } | { ok: false; reason: string; deviceMismatch?: boolean };
  verifySpec: ActVerifySpec;
}

function readString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function deviceMatches(input: Record<string, unknown>, key: string, runDeviceId: string): boolean {
  return readString(input, key) === runDeviceId;
}

/**
 * Review fix (#3826 final-review): a device-arg mismatch and a missing/
 * malformed identity field are NOT the same failure and must not collapse to
 * the same `actRevalidation.ts` outcome. A device mismatch means the model
 * targeted (or drifted onto) a device this run is not pinned to — that is a
 * genuine safety boundary, fail-closed, hard `deny`, never softened into a
 * proposal. A missing identity field (no `serviceName`, no `processName`
 * alongside a pid, empty `paths`, …) is a malformed-but-legitimate call for
 * an op the manifest DOES cover — denying it outright would give act mode a
 * NARROWER human-approval surface than shadow mode has for the exact same
 * call, which is backwards (shadow always records a reviewable proposal).
 * `deviceMismatch: true` is the discriminator `revalidateActExecution`'s
 * step 3 branches on to decide deny vs. downgrade-to-propose.
 */
function deviceMismatch(reason: string): { ok: false; reason: string; deviceMismatch: true } {
  return { ok: false, reason, deviceMismatch: true };
}

const manageServicesRestart: ActOperation = {
  key: 'manage_services.restart',
  toolName: 'manage_services',
  // start/stop/list are explicitly NOT act-eligible (quorum: only restart is
  // rule-equivalent — start/stop change desired state, restart does not).
  matches: (input) => input.action === 'restart',
  normalizeTarget: (input, runDeviceId) => {
    if (!deviceMatches(input, 'deviceId', runDeviceId)) {
      return deviceMismatch('deviceId does not match the run device');
    }
    const serviceName = readString(input, 'serviceName');
    if (!serviceName) return { ok: false, reason: 'serviceName is required' };
    return { ok: true, target: { kind: 'service', serviceName } };
  },
  verifySpec: { kind: 'service_running' },
};

const diskCleanupExecute: ActOperation = {
  key: 'disk_cleanup.execute',
  toolName: 'disk_cleanup',
  matches: (input) => input.action === 'execute',
  normalizeTarget: (input, runDeviceId) => {
    if (!deviceMatches(input, 'deviceId', runDeviceId)) {
      return deviceMismatch('deviceId does not match the run device');
    }
    const rawPaths = input.paths;
    if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
      return { ok: false, reason: 'paths is required and must be non-empty' };
    }
    const paths = rawPaths.filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (paths.length !== rawPaths.length) {
      return { ok: false, reason: 'paths must be an array of non-empty strings' };
    }
    return { ok: true, target: { kind: 'disk_cleanup', paths } };
  },
  verifySpec: { kind: 'disk_usage_improved' },
};

/**
 * `manage_processes.kill` is DEFERRED out of act-manifest v1 (#3826 scoped
 * re-review of eb7d0e637) — it was unreachable to begin with:
 * `manage_processes` was never registered in `TOOL_TIERS`
 * (aiAgentSdkTools.ts), i.e. never a real agent-SDK tool, so no dispatch
 * could ever reach a `resolveActOperation('manage_processes', ...)` match in
 * production. The pid→name identity pin the quorum required for an
 * unattended kill (the same real, dispatch-time revalidation
 * `pinDiskCleanup` does for disk-cleanup paths) was also never implemented —
 * only asserted in comments. Under act mode a `manage_processes` kill call
 * now falls through to the ordinary unmatched-mutation path, exactly like
 * shadow mode: no capability regression, since nothing could execute it
 * before either.
 *
 * Re-admitting this op requires BOTH, together, before it returns:
 *   (a) `manage_processes` tiered and registered in the agent SDK tool set —
 *       today it sits in `KNOWN_MISSING_TOOL_TIERS`
 *       (aiAgentSdkTools.registryParity.contract.test.ts), a frozen list that
 *       may only ever SHRINK, never grow to paper over this gap, and
 *   (b) a real dispatch-time pid→name identity pin added to
 *       `actRevalidation.ts`'s `pinAsset` (an `executeCommand list_processes`
 *       read + name match immediately before the kill dispatches, mirroring
 *       `pinDiskCleanup`'s preview-plan re-read) — not a presence check on
 *       the model's own input.
 * Follow-up issue reference to be added at PR time.
 */

const runScript: ActOperation = {
  key: 'run_script',
  toolName: 'run_script',
  // The tool's own input_schema has no inline-content path (scriptId is
  // `required`), so "matches" is a shape check: a saved script is the only
  // shape run_script can ever be called with.
  matches: (input) => readString(input, 'scriptId') !== null,
  normalizeTarget: (input, runDeviceId) => {
    const scriptId = readString(input, 'scriptId');
    if (!scriptId) return { ok: false, reason: 'scriptId is required' };
    const deviceIds = input.deviceIds;
    if (!Array.isArray(deviceIds) || deviceIds.length !== 1 || deviceIds[0] !== runDeviceId) {
      // Targeting (or drifting onto) a different/additional device is the
      // device-mismatch safety boundary, not a missing-identity-field
      // shape problem — this is the explicit "sibling-device arg → deny"
      // case (Task 3 contract), so it keeps deny even after the review fix
      // that softens other normalizeTarget failures to a proposal.
      return deviceMismatch('deviceIds must equal exactly [runDeviceId] under act mode');
    }
    return { ok: true, target: { kind: 'script', scriptId } };
  },
  verifySpec: { kind: 'script_exit_code' },
};

const executePlaybook: ActOperation = {
  key: 'execute_playbook',
  toolName: 'execute_playbook',
  // Shape-only: whether playbookId actually names a BUILT-IN row (vs. a
  // custom, org-authored one) requires a DB read, which this pure resolver
  // cannot perform. The built-in/custom distinction is enforced downstream,
  // with I/O, before anything executes:
  //   - actRevalidation.ts's per-op asset pin (digest match against the
  //     built-in definition), and
  //   - playbookActExecutor.ts (Task 5), which is the only consumer that
  //     actually runs a playbook and refuses anything not built-in.
  // A custom playbook therefore still reaches the 'act' disposition at THIS
  // layer; it is turned into a proposal (or denied) once I/O is available,
  // never executed. See Task 5's plan section for the intended fuller
  // manifest-level exclusion — deferred here to keep this resolver pure.
  matches: (input) => readString(input, 'playbookId') !== null && readString(input, 'deviceId') !== null,
  normalizeTarget: (input, runDeviceId) => {
    if (!deviceMatches(input, 'deviceId', runDeviceId)) {
      return deviceMismatch('deviceId does not match the run device');
    }
    const playbookId = readString(input, 'playbookId');
    if (!playbookId) return { ok: false, reason: 'playbookId is required' };
    return { ok: true, target: { kind: 'playbook', playbookId } };
  },
  verifySpec: { kind: 'playbook_aggregate' },
};

/**
 * Virtual op. There is no real MCP tool named `remediation_suggestion`, so
 * `resolveActOperation`'s toolName-keyed lookup below can NEVER reach this
 * entry from a raw model tool call — that is deliberate, not an oversight.
 * The Task 7 resolver (`remediationActResolver.ts`) matches a suggestion
 * directly and resolves it to the `run_script` op's target + verifySpec; this
 * entry exists only so the key is part of the frozen manifest surface and so
 * other code can reference `ACT_MANIFEST` to find it by key without a
 * separate registry.
 */
const remediationSuggestion: ActOperation = {
  key: 'remediation_suggestion',
  toolName: 'remediation_suggestion',
  matches: () => false,
  normalizeTarget: () => ({
    ok: false,
    reason: 'remediation_suggestion is virtual; resolved via remediationActResolver, not normalizeTarget',
  }),
  verifySpec: { kind: 'none' },
};

/**
 * EXACT frozen key set. Do not add, remove, or reorder without a quorum
 * decision — `actManifest.test.ts` pins this array itself, so an edit here
 * that isn't mirrored in the test's expectation fails CI on purpose.
 * `manage_processes.kill` is deliberately absent — see the deferral comment
 * above `runScript` for why.
 */
export const ACT_MANIFEST: readonly ActOperation[] = [
  manageServicesRestart,
  diskCleanupExecute,
  runScript,
  executePlaybook,
  remediationSuggestion,
] as const;

/**
 * Real MCP tool names the manifest can ever admit for unattended execution —
 * derived, not a second hand-maintained list. Excludes `remediation_suggestion`'s
 * sentinel `toolName` (never a real registered tool; see that entry's own
 * docstring above): counting it here would make an operator's toolAllowlist
 * entry read as "act-eligible" for a name that can never actually be
 * dispatched. Consumed by Task 6's "act-eligible allowlisted tool" activation
 * prerequisite (agentService.ts) — kept in this module, rather than
 * hardcoded a second time there, so it always tracks ACT_MANIFEST.
 */
export const ACT_ELIGIBLE_TOOL_NAMES: readonly string[] = ACT_MANIFEST
  .map((op) => op.toolName)
  .filter((toolName) => toolName !== remediationSuggestion.toolName);

/**
 * Pure, no I/O (see the module docstring). Returns the first manifest entry
 * whose `toolName` matches AND whose `matches(input)` is true, or null.
 * `execute_command` has — and will only ever have via a quorum decision —
 * NO entry: it is the lower-level alias path around every other tool's
 * guardrails, so it is structurally excluded rather than filtered.
 */
export function resolveActOperation(
  toolName: string,
  input: Record<string, unknown>,
): ActOperation | null {
  for (const op of ACT_MANIFEST) {
    if (op.toolName === toolName && op.matches(input)) return op;
  }
  return null;
}
