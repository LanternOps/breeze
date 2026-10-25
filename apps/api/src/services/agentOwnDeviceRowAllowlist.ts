/**
 * Allowlist for the own-device-row contract
 * (src/__tests__/agentOwnDeviceRowUpdates.contract.test.ts; #8318 §6.4).
 *
 * The contract: every `update(devices)` call and every raw `UPDATE devices`
 * statement in a file reachable through imports from an agent entry point
 * (`routes/agents/**`, `routes/agentWs.ts`, `routes/helper/**`,
 * `middleware/agentAuth.ts`) must be the helper's own statement
 * (services/agentOwnDeviceRow.ts) or carry a marker naming an entry here:
 *
 *     // own-device-row-allowlisted: <marker>
 *
 * placed inside the statement that issues the update (anywhere between the
 * start of that statement and the call). Two kinds of entry exist, and nothing
 * else qualifies:
 *
 *  - `non_agent_path`: the statement is not an agent writing its own row at
 *    all — an offline sweep, an org move, a user-session route, a worker, the
 *    enrollment fresh-row path, server-side certificate issuance. It only
 *    shares a file (or an import chain) with agent code.
 *  - `agent_path_inline_predicate`: an agent path that cannot take the helper
 *    (it has no auth context of the helper's shape) and therefore carries the
 *    `agent_id` predicate itself. Each one says which predicate it applies.
 *
 * Every entry must be referenced by at least one marker (a stale entry fails
 * the contract), and every marker must name an entry in its own file.
 */

export const OWN_DEVICE_ROW_ALLOWLIST_MARKER = 'own-device-row-allowlisted';

export type OwnDeviceRowAllowlistKind = 'non_agent_path' | 'agent_path_inline_predicate';

export interface OwnDeviceRowAllowlistEntry {
  /** Path relative to apps/api. */
  file: string;
  /** The marker text after `own-device-row-allowlisted:` at the site. */
  marker: string;
  kind: OwnDeviceRowAllowlistKind;
  reason: string;
}

export const AGENT_OWN_DEVICE_ROW_ALLOWLIST: readonly OwnDeviceRowAllowlistEntry[] = [
  // ── The two agent paths that cannot use the helper (spec §6.4) ──────────
  {
    file: 'src/jobs/offlineDetector.ts',
    marker: 'transition-device-offline-agent-id',
    kind: 'agent_path_inline_predicate',
    reason:
      'transitionDeviceOffline is shared by the WS close/error path and the offline sweep and has no auth ' +
      'context; its UPDATE carries `agent_id = <the agent_id the row was read by>` in place, plus the ' +
      'observed last_seen_at CAS.',
  },
  {
    file: 'src/routes/agents/enrollment.ts',
    marker: 'reenroll-matched-row-agent-id',
    kind: 'agent_path_inline_predicate',
    reason:
      'F3 token-authenticated re-enroll matched the row without a lock and is not on the agent auth context; ' +
      'its UPDATE carries `agent_id = <the matched row\'s agent_id>` and the handler refuses (no fresh row ' +
      'minted) when that matches 0 rows.',
  },

  // ── Non-agent paths in files an agent entry point reaches ───────────────
  {
    file: 'src/services/deviceReattach/confirm.ts',
    marker: 'reattach-confirm-target-identity',
    kind: 'non_agent_path',
    reason:
      'The reattach confirm (#8318 §6.4) hands the TARGET row to the new install. It is not the caller writing ' +
      'its own row: the caller authenticated with the confirm-only token, the row is locked FOR UPDATE and ' +
      'version-checked, and the UPDATE carries `agent_id = intent.target_agent_id` itself.',
  },
  {
    file: 'src/services/deviceReattach/confirm.ts',
    marker: 'reattach-confirm-source-credentials',
    kind: 'non_agent_path',
    reason:
      'The reattach confirm retires the SOURCE row (decommissioned in the same transaction) and clears every ' +
      'token hash of it, under its FOR UPDATE lock; the UPDATE carries `agent_id = intent.source_agent_id`.',
  },
  {
    file: 'src/jobs/offlineDetector.ts',
    marker: 'offline-sweep-mark-offline',
    kind: 'non_agent_path',
    reason: 'The scheduled offline sweep (processMarkOffline): a worker, not an agent credential.',
  },
  {
    file: 'src/jobs/offlineDetector.ts',
    marker: 'uninstall-intent-reaper',
    kind: 'non_agent_path',
    reason: 'The uninstall-intent reaper decommissions silent rows and clears replacement linkage: a worker.',
  },
  {
    file: 'src/routes/agents/enrollment.ts',
    marker: 'enroll-decom-bypass-rename',
    kind: 'non_agent_path',
    reason:
      'Enrollment fresh-row path: renames a prior DECOMMISSIONED row\'s hostname so the new INSERT can claim ' +
      'it. No agent credential is involved (the caller holds only an enrollment key).',
  },
  {
    file: 'src/routes/agents/mtls.ts',
    marker: 'quarantine-approve-user-route',
    kind: 'non_agent_path',
    reason: 'POST /:id/approve is a user-session (JWT + MFA) route that lifts a quarantine; not an agent write.',
  },
  {
    file: 'src/routes/agents/mtls.ts',
    marker: 'quarantine-deny-user-route',
    kind: 'non_agent_path',
    reason: 'POST /:id/deny is a user-session (JWT + MFA) route that decommissions a quarantined device.',
  },
  {
    file: 'src/services/aiToolsDevice.ts',
    marker: 'ai-tool-device-tags',
    kind: 'non_agent_path',
    reason: 'The AI assistant\'s add/remove device tag tools act for a user or an AI agent, never for the device\'s own credential.',
  },
  {
    file: 'src/services/tenantLifecycle.ts',
    marker: 'tenant-lifecycle-credentials',
    kind: 'non_agent_path',
    reason: 'Tenant offboarding/archive/restore severs or restores every device credential of an org set: platform lifecycle, not an agent.',
  },
  {
    file: 'src/services/warrantySync.ts',
    marker: 'warranty-vendor-ship-date',
    kind: 'non_agent_path',
    reason: 'The warranty worker records a vendor ship date from a lookup; the agent only triggered the sync.',
  },
  {
    file: 'src/jobs/discoveryWorker.ts',
    marker: 'discovery-role-propagation',
    kind: 'non_agent_path',
    reason: 'The discovery worker propagates an asset classification onto a matched device: a job, not the device\'s credential.',
  },
];
