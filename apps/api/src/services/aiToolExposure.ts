/**
 * Data-only exposure registries for in-product AI (spec 2026-09-23,
 * W01-D1/D4/D5). This module has NO imports: `aiGuardrails.ts` must stay free
 * of registry and schema imports (see `aiToolActions.ts:1-10`), and a
 * data-only module keeps that rule while still letting guardrails enforce
 * these lists. It also splits hot-file ownership: lane C owns the maps here,
 * lane A owns their enforcement in `aiGuardrails.ts`.
 *
 * `HUMAN_ONLY_TOOLS` — never exposed to in-product AI (chat, Helper, agents).
 * Distinct from `AGENT_HUMAN_ONLY_TOOLS` (below), which is agents-only,
 * self-granted-authority denial; a tool can be human-only here while still
 * being tiered and chat-reachable is NOT allowed — see the registryParity
 * contract. Entries are added only with Todd's sign-off.
 */
export const HUMAN_ONLY_TOOLS: ReadonlyMap<string, string> = new Map<string, string>([
  // Empty at W01 (spec 2026-09-23 W01-D4): no registered tool is a standing
  // exclusion yet.
]);

/**
 * Tools the `ai_agent` principal may NEVER call, whatever its allowlist says.
 *
 * A third unconditional denial class alongside `BLOCKED_TOOLS` (tier 4) and
 * `isSecretBearingTool` (both `aiGuardrails.ts`) — and, like those, enforced
 * in `checkAgentGuardrails` ABOVE the allowlist and the multiplexed-action
 * resolution, so the deny cannot depend on a parseable `action` or on the
 * snapshot omitting the name.
 *
 * `manage_ai_agents` (P2-5, #4192) grants an agent a pre-authorized action
 * key: an agent able to call it could grant ITSELF new unattended authority,
 * which is the one escalation no approval scope can contain (the grant
 * outlives the run). Membership here is a registry, not a hard-coded string,
 * so aiGuardrails.agentPrincipal.contract.test.ts can treat the class as
 * unconditionally denied instead of duplicating the literal.
 *
 * Moved here from `aiGuardrails.ts` (W01 quorum amendment WQ4, #6755): the two
 * agent-denial registries now live in one file. `aiGuardrails.ts` re-exports
 * this so every existing importer keeps working unchanged.
 */
export const AGENT_HUMAN_ONLY_TOOLS = new Set<string>([
  'manage_ai_agents',
  // Execution plane (spec §5.5). FULLY DEREGISTERED as of #6086 — chat-to-agent
  // delegation is withdrawn until caller authorization can be preserved for the
  // length of a run, so no tier, schema, handler or MCP declaration remains.
  // Kept here anyway, and pinned by workspaceLaunchTool.registration.test.ts:
  // an agent that could launch analysis runs could launch runs that launch
  // runs, so if the name is ever re-wired this deny (unconditional, above the
  // allowlist in `checkAgentGuardrails`) must already be in place rather than
  // being something the re-wiring has to remember. A HUMAN asks for analysis.
  //
  // This entry is ALSO load-bearing for the workspace_stage/run/collect/cancel
  // permission mapping (2026-09-17 ROLE audit §2.7): those four are flat
  // `ai_agents:read`, which is only defensible while no chat caller can obtain
  // a run-bearing principal. Re-wiring launch without first raising them to an
  // execute-class permission hands arbitrary code execution to every
  // `ai_agents:read` holder. See the LANDMINE note at their TOOL_PERMISSIONS
  // entries, and aiGuardrails.workspaceToolSurface.contract.test.ts.
  'workspace_launch_analysis',
]);

/**
 * Tier-1 READS a headless agent may never call, whatever its allowlist says
 * (spec 2026-09-23 D4/D5, W01 quorum amendments WQ1/WQ2, #6755). Tier-1 reads
 * skip the agent allowlist entirely (`isReadOnlyResolution`), so a read that
 * must never reach an `ai_agent` principal needs this unconditional deny
 * instead — enforced in `checkAgentGuardrails` ABOVE the allowlist, exactly
 * like `AGENT_HUMAN_ONLY_TOOLS`. Distinct from that set: these are not
 * self-granted-authority tools, they are ordinary reads whose OUTPUT is
 * personal data, a sensitive-data location map, or an unbounded prompt-
 * injection channel with no device axis to bound an autonomous run. Chat and
 * Helper are unaffected — the human asking holds the RBAC permission and sees
 * the same data in the UI. Entries are added only with Todd's sign-off.
 */
export const AGENT_DENIED_READ_TOOLS: ReadonlyMap<string, string> = new Map<string, string>([
  ['search_c2c_items', 'Returns mailbox/file item subjects, paths and user emails authored by external senders: personal data plus a prompt-injection channel into a run that can act.'],
  ['get_sensitive_data_overview', 'A map of where cardholder and personal data lives on customer machines; no operational need for an autonomous run.'],
  ['get_user_risk_scores', 'Names and emails of every scored user with no device axis, so a device-bound run would read the whole org.'],
  ['get_user_risk_detail', 'Per-person risk history with free-text event descriptions; personal data with no device axis.'],
  // WQ1: both are tier 1, not device-bounded, and absent from m365ToolTiers,
  // so they are denied here explicitly rather than through the session-only
  // filter. No agent preset uses either today (TOOL_CAPABILITY only).
  ['m365_query_users', 'Org-wide M365 identities; not device-bounded and not session-only, so it is denied to headless agents explicitly.'],
  ['m365_query_signins', 'Org-wide M365 sign-in history; not device-bounded and not session-only, so it is denied to headless agents explicitly.'],
  // WQ2: errorLog can carry Graph error text naming user principal names and
  // item names sourced from the tenant's own directory/mail data.
  ['query_c2c_jobs', 'Returns job errorLog entries that can carry user principal names and item names from Graph error text.'],
]);
