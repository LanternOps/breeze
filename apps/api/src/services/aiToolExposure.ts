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
 *
 * W15 PR A (#6785): Pax8 credential save (POST /pax8/integration), connection
 * test (POST /pax8/integration/test) and company mapping (POST /pax8/companies/map)
 * are human-only routes with NO tool action. Do not add them to these lists:
 * registryParity requires HUMAN_ONLY_TOOLS entries to name registered tools.
 * Pax8 reads are reachable and PR A writes require explicit grants; the
 * partner-scope, partner-wide and device-bound handler gates also apply.
 */
export const HUMAN_ONLY_TOOLS: ReadonlyMap<string, string> = new Map<string, string>([
  // Empty at W01 (spec 2026-09-23 W01-D4) until the AI Operator plan approval.
  ['operator_plan', 'Plan-approval carrier minted only by the AI Operator coordinator under the task requester; releasing it executes nothing but marks the approved plan, so it must never be declared to chat, Helper or agents (Recipe Library spec 6.4).'],
  // Wisp W03 (spec §8.3, §14 — Todd's sign-off for these two entries).
  ['confirm_memory', 'A person confirms or retracts memory; Wisp never does (spec §8.3). Reached through the memory page routes, never declared to chat, Helper or agents.'],
  ['retract_memory', 'A person confirms or retracts memory; Wisp never does (spec §8.3). Reached through the memory page routes, never declared to chat, Helper or agents.'],
  // Wisp W07 (spec §7.5 — the sign-off for this entry).
  ['wisp_specialist_request', 'Approval carrier minted only by the Wisp coordinator under an assessment run; releasing it admits one specialist under the approver\'s authority, so it is never declared to chat, Helper or agents (Wisp spec §7.5).'],
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
  // Tool Catalog W03 (#5218, Decision 6): an operator agent authoring flows
  // needs the managed_by_agent_id story first, not a side door.
  'draft_flow',
  // W04 (#5219): starting or cancelling a flow run is a human decision (run_flow
  // is Tier 3 chat-only; a flow must not be started by an agent before W05).
  'run_flow',
  'cancel_flow_run',
  // Endpoint messaging (#8742 W02): text shown to end users under the MSP's
  // brand is authored in a human chat session and approved card by card; an
  // operator agent never proposes one.
  'send_endpoint_message',
  // Full-control W07 (#6777, quorum QW3): acknowledging / resolving a correlation GROUP spans devices,
  // and a supervised release rebuilds the approver's auth, which drops the originating run's exact-device
  // ceiling. An operator agent reads correlations (get_alert_correlations) and acts per alert through
  // manage_alerts, whose alert id is gated against that ceiling when the proposal is minted.
  'manage_alert_correlations',
  // Full-control W08 (#6778, W08-D1): every topology tool resolves its caller through
  // requireTopologySiteAccess / the template library, both of which read the caller's USER permissions
  // (getUserPermissions). An ai_agent principal's id is not a user, so each call would be refused; the
  // topology template and diagnostic services also refuse an ai_agent principal by name. An agent keeps the
  // pinned-session investigation reads (topology/aiToolGate.ts). Follow-up: a principal-aware resolver.
  'get_topology_graph',
  'run_topology_diagnostic',
  'manage_topology_manual',
  'manage_topology_monitoring',
  'manage_topology_templates',
  'apply_topology_template',
  // Full-control W09 (#6779): partner-wide state. The routes are gated on canManagePartnerWidePolicies, which reads
  // partnerOrgAccess; an agent / helper / MCP-key context never carries one, so these would be offered and refused every time.
  'manage_known_guests',
  'get_unifi_status',
  'trigger_unifi_sync',
  // Full-control W11 (#6781), explicit D4 exceptions recorded in the W11 plan (quorum QW8):
  // access reviews are identity governance (they decide which people keep access to the tenant; the reads are
  // every member's email, role and permission map with no device axis); PAM rules decide who gets local admin and,
  // through tool-action rules, govern the Helper's own approvals (Q4), and their reads are the elevation policy map.
  'manage_access_reviews',
  'manage_pam_rules',
  // Full-control W12 (#6782): installs a package manager as the console admin with no uninstall path; no autonomous
  // workflow needs it (W12 plan, agent exposure).
  'bootstrap_homebrew',
  // Full-control W12 (#6782, quorum QW6): custom-field values select dynamic-group members (filterEngine custom.<key>),
  // which feed an agent's run scope through triggers.deviceGroupIds, and are substituted into installer command lines;
  // definition edits (scriptWrite, deviceTypes, validation) decide which value writes are admitted. The manage_tags
  // precedent, applied to the whole tool.
  'manage_custom_fields',
  // Recipe Library spec §6.2: the model never proposes an effect buildPlan did
  // not produce and never edits plan arguments. A model that could raise an
  // operator_plan intent could author the set a human then approves in one
  // click (the §11 four-eyes bypass). The COORDINATOR raises it, under the
  // task's human requester.
  'operator_plan',
  // #6263 W05 Gate B 10 (#6268): fleet IOC sweeps and IOC rule imports are
  // started from a human chat or MCP session; no operator agent mints them.
  'ioc_hunt',
  // Wisp W03 (spec §8.3): a person confirms or retracts memory; Wisp never does.
  // Also in HUMAN_ONLY_TOOLS; listed here so the ai_agent principal is denied
  // above any allowlist and assertWithinCeiling refuses them for every grant.
  'confirm_memory',
  'retract_memory',
  // Diagnostic read grants are bound to a human session or an MCP credential
  // (services/diagnosticAccess/grants.ts beneficiaryOf); an operator agent can
  // never request, hold, use or revoke one.
  'request_diagnostic_access',
  'list_diagnostic_access_grants',
  'revoke_diagnostic_access',
  'diagnostic_list_directory',
  'diagnostic_read_file',
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
  // Wisp W07 (spec §7.5 — the sign-off for this entry): a human chat turn under
  // a grant hands work to a specialist; an agent never does. Wisp's own
  // assessment requests specialists through its `request_specialist` outcome
  // tool, which the deterministic coordinator admits after the run — so a
  // specialist can never launch a specialist (depth one).
  'launch_specialist',
]);

/**
 * Wisp W07 — approval CARRIERS the Wisp coordinator mints under an assessment
 * run's own `ai_agent` principal (plan Task 4). `checkAgentGuardrails`
 * accepts these from a device-less run without an allowlist entry — and ONLY
 * these: a carrier executes nothing org-wide by itself; its release re-runs
 * every coordinator gate under the APPROVER's rebuilt authority. Every entry
 * MUST also be in HUMAN_ONLY_TOOLS (never declared to any model), so no model
 * can raise one — pinned by aiToolsWisp.registration.test.ts.
 */
export const AGENT_COORDINATOR_CARRIER_TOOLS: ReadonlySet<string> = new Set<string>([
  'wisp_specialist_request',
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
  // W10 (#6780, quorum QW5): objective, handoffSummary, outcomeDetail and step / event text are free text written by humans and by
  // other agent runs, with no device axis to bound an autonomous run.
  ['list_operator_tasks', 'Operator task objectives, hand-off summaries and outcome text are free text authored by humans and other agent runs, org-wide with no device axis: a prompt-injection channel into a run that can act.'],
  ['get_operator_task', 'Task steps, events, plan renderings and hand-off text are free text authored by humans and other agent runs, org-wide with no device axis: a prompt-injection channel into a run that can act.'],
]);

/**
 * Single ACTIONS of an otherwise agent-reachable tool that a headless agent may
 * never call, whatever its allowlist says (spec 2026-09-23 D4, action level —
 * class-review question 4; W02-D2 + quorum QV2, #6756). Keyed `tool:action`.
 *
 * Enforced in `checkAgentGuardrails` directly after the `isNeverAgentTool`
 * deny, and filtered out of the capability picker's operations
 * (`agentToolCatalog.ts`), so the UI can never write one to an allowlist
 * either. Entries are added only with Todd's sign-off.
 */
export const AGENT_HUMAN_ONLY_ACTIONS: ReadonlyMap<string, string> = new Map<string, string>([
  // Full-control W04 (#6758, W04-D8 — the W02 Task 16 follow-up): the group
  // analogue of manage_tags. Membership is a live read at run admission and
  // before tool use (runResourceScope.ts), so these are the same self-scope path.
  ['manage_groups:add_devices', 'Group membership feeds agent run scope (triggers.deviceGroupIds, a live read in runResourceScope.ts): an allowlisted tier-2 add would let an agent put devices inside its own or another agent\'s future reach unattended.'],
  ['manage_groups:remove_devices', 'Removing a device from a group changes which group-scoped agents, config-policy assignments and peripheral policies reach it; the same run-scope path as manage_tags:remove.'],
  ['manage_tags:add', 'Device tags feed the agent\'s own run scope (triggers.deviceTags, runResourceScope.ts) and dynamic-group membership (triggers.deviceGroupIds): an allowlisted tier-2 add would let an agent widen its future reach unattended.'],
  ['manage_tags:remove', 'Removing a tag can ADMIT a device to a dynamic group whose rule is negative (isEmpty / notContains, filterEngine.ts); membership is re-evaluated on every tag change and feeds the agent\'s run scope through triggers.deviceGroupIds.'],
  // Full-control W11 (#6781, W11-D8, quorum QW5/QW9): both write auth.user.id into a users FK, and a user-owned
  // release would run them as the approving human, dropping the requesting run's site ceiling.
  ['manage_audit_baselines:create', 'An active audit baseline replaces the org\'s active one and enrols every device of that OS in the daily audit-policy collection; a user-owned release would run it as the approving human and lose the run\'s site ceiling.'],
  // Full-control W12 (#6782, W12 plan agent exposure).
  ['manage_device_software:uninstall', 'Removing an application from a customer machine is irreversible (no undo, no dry run); a person decides it.'],
  // Full-control W13 (#6783, W13 plan agent exposure; the W02-D2 manage_tags precedent).
  ['manage_device_function:set', 'A device function is an allowed execution-targeting filter: it selects dynamic-group members, which feed an agent run\'s own scope (triggers.deviceGroupIds), so a run must not set it.'],
  // Full-control W13 PR B (#6783): an agent that can run scripts must not also edit the values those scripts receive.
  ['manage_tenant_variables:create', 'Tenant-variable values are substituted into every script dispatched to the org\'s devices; an agent that runs scripts must not also choose their inputs.'],
  ['manage_tenant_variables:update', 'Tenant-variable values are substituted into every script dispatched to the org\'s devices; an agent that runs scripts must not also choose their inputs.'],
  ['manage_tenant_variables:delete', 'Deleting a tenant variable changes what every script referencing it receives on the org\'s devices; a person decides it.'],
  // Full-control W14 (#6784, W14 plan agent exposure): the legal documents customers sign, and their executed records.
  ['manage_contract_templates:create', 'Agreement templates are the legal documents customers sign; a person authors them (the human_only_legal_evidence reasoning).'],
  ['manage_contract_templates:update', 'Agreement templates are the legal documents customers sign; a person authors them (the human_only_legal_evidence reasoning).'],
  ['manage_contract_templates:create_version', 'Agreement templates are the legal documents customers sign; a person authors them (the human_only_legal_evidence reasoning).'],
  ['manage_contract_templates:publish', 'Agreement templates are the legal documents customers sign; a person authors them (the human_only_legal_evidence reasoning).'],
  ['manage_contract_templates:archive', 'Agreement templates are the legal documents customers sign; a person authors them (the human_only_legal_evidence reasoning).'],
  ['manage_contract_documents:link', 'Filing a signed agreement under a contract is an irreversible change to an executed legal record; a person decides it.'],
  // Full-control W14 PR B (#6784, W14 plan agent exposure): money and data that leave the tenant.
  ['manage_contracts:generate_invoice', 'Generating a contract invoice bills the customer and may issue and email it; a person asks for it and two people approve it.'],
  ['manage_accounting_sync:push', 'Pushing an invoice writes it into the partner\'s accounting books outside Breeze; a person asks for it and two people approve it.'],
  ['manage_accounting_sync:push_bulk', 'Pushing invoices writes them into the partner\'s accounting books outside Breeze; a person asks for it and two people approve it.'],
  ['manage_accounting_sync:link_mapping', 'Linking a mapping overwrites the accounting provider\'s customer or item with Breeze\'s values; a person decides it.'],
  ['manage_accounting_sync:unlink_mapping', 'Accounting mappings decide which books record each customer and item; a person decides them.'],
  ['manage_accounting_sync:sync_mapping', 'A sync overwrites the accounting provider\'s customer or item with Breeze\'s values; a person decides it.'],
  ['manage_audit_baselines:request_apply', 'An apply request is the input to a second person\'s approval that pushes audit policy to up to 500 devices; its requester must be a person, who then cannot approve it.'],
]);
