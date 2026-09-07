---
title: AI agent builder — capability picker and guided create flow
date: 2026-09-06
status: approved (Todd, 2026-09-06, option A)
scope: apps/api (tool catalog, policy merge, agent writes), apps/web (Settings → AI agents create/edit), packages/shared
mockup: https://claude.ai/code/artifact/4f5b8312-74b1-4492-ad62-610dcb6dd15f
---

# AI agent builder: capability picker and guided create flow

## 1. Problem

Settings → AI agents → New agent (`apps/web/src/components/settings/AiAgentForm.tsx`, one 768px drawer, ~10 sections) asks the operator to fill in a **tool allowlist** as a newline-separated free-text textarea. The "Add a known tool" type-ahead beside it is a `<datalist>` seeded from `GET /ai/agents/policy-decidable-keys`, which returns the 11 policy-decidable keys (4 tools), not a tool catalog. The real registry has 185 headless tools with snake_case names and no user-facing grouping. Operators cannot discover which tools exist, what they do, which matter for the agent kind they picked, or what selecting one actually causes in the chosen mode. There are no presets and no summary of what the agent will be allowed to do.

## 2. Verified facts the design rests on (origin/main `cf9420572`)

| Fact | Where |
|---|---|
| `toolAllowlist` entries are `tool` or `tool:action` (`TOOL_REF`), max 300; read-only tools bypass the allowlist | `packages/shared/src/validators/aiAgents.ts:11`; `aiGuardrails.ts:1729-1748` |
| Read-only = tier 1, or tier 2 with `readOnly` action / `TIER2_READONLY_TOOLS` | `aiGuardrails.ts:1729` |
| Registry: 185 headless tools (113 tier-1, 39 tier-2, 38 tier-3 base tier); 30 session-only M365/Google tools never run headless | `aiTools.ts`, `aiToolsM365.ts`, `aiToolsGoogle.ts` |
| **86 registered tools are absent from `TOOL_TIERS` and therefore unreachable by agent runs** (SDK `allowedTools` + `createSessionPreToolUse` gate) | `aiAgentSdkTools.registryParity.contract.test.ts` (#3300) |
| `manage_ai_agents` is `AGENT_HUMAN_ONLY_TOOLS` | `aiGuardrails.ts:417` |
| Per-operation tier precedence: TIER1 override → TIER3 → TIER2 → base; discriminator is `action`, except `execute_command` uses `commandType` | `aiGuardrails.ts:33-41, 1346` (`checkGuardrails`) |
| Shadow mode: tier-3 proposals create an action intent (approval); **tier-2 proposals are recorded in the run outcome and stop there** (no approval object, never executed) | `aiAgents/runLoop.ts` ~528 |
| Unattended execution = `ACT_MANIFEST` (4 real tools + virtual `remediation_suggestion`) in act mode, plus policy-decide for `POLICY_DECIDABLE_TIER3` keys, plus ticket autonomy | `aiAgents/actManifest.ts`, `actionIntents/policyDecide.ts`, `runLoop.ts` ~1073 |
| Effective org policy = **exact-string** `intersect(partner, org)` for `toolAllowlist` and `supervisedActionKeys` | `aiAgents/effectivePolicy.ts:66, 230, 293` |
| `createAgent` / `updateAgent` accept `actAssets.supervisedActionKeys` on ORG rows after validity checks only; the four-eyes grant executor is the intended sole writer | `aiAgents/agentService.ts:528, 619`; `supervisedKeyGrant.ts` |
| Org sessions cannot load the partner-wide row; the list response exposes only `partnerBaselineKinds` | `routes/aiAgents.ts:322-360`, `agentService.ts:390` |
| No `capability`/domain field on `AiTool`; `TOOL_PERMISSIONS` maps tool/action → RBAC `{resource, action}` | `aiTools.ts:94-134`, `aiGuardrails.ts:558-1121` |

## 3. Goals and non-goals

Goals:
- An operator can build a correct agent without knowing a single tool name.
- Every operation shown is one the agent can actually reach, with its true outcome in the chosen mode.
- What the operator selects is exactly what is stored and enforced; no silent widening or narrowing.
- The create flow explains itself: purpose → what it does → safety → plain-English review.

Non-goals (explicitly deferred):
- Fixing the 86-tool reachability gap (#3300) — the catalog **excludes** those tools and the contract test **reports** them; widening reachability is a separate decision.
- Saved templates as DB rows; "describe what you want" LLM-assisted setup.
- Changing the `ai_agents` schema. Storage stays `toolAllowlist: string[]` of `tool` / `tool:action`.
- Redesigning the graduation panel or the approvals inbox.

## 4. Design

### 4.1 Tool catalog as a contract (API)

New module `apps/api/src/services/aiAgents/agentToolCatalog.ts` (not `aiToolCatalog.ts`: `aiToolsCatalog.ts` is the product-catalog tool module).

**Universe.** `listAgentReachableTools()` = tools registered in `aiTools` ∩ keys of `TOOL_TIERS` − session-only tools (`m365ToolTiers`, `googleToolTiers`) − `AGENT_HUMAN_ONLY_TOOLS`. Roughly 104 today. A tool outside this set is never shown, never suggested, and is flagged as "not reachable" if it appears in a saved allowlist.

**Capabilities.** `AGENT_CAPABILITIES: readonly AgentCapability[]`, each `{ id, tone: 'standard' | 'high' }` (labels and descriptions live in web i18n, keyed by `id`). Initial set, in display order for the picker's default sort:

| id | Groups (representative reachable tools) |
|---|---|
| `alerts_monitoring` | manage_alerts, manage_alert_rules, manage_monitors, manage_service_monitors |
| `services_startup` | manage_services, manage_startup_items |
| `files_disk` | file_operations, disk_cleanup, analyze_disk_usage (read) |
| `scripts_commands` | run_script, execute_command, execute_playbook, cancel_script_execution, manage_processes*, manage_scheduled_tasks*, registry_operations* |
| `tickets` | manage_tickets* |
| `patching_software` | manage_patches, manage_deployments, manage_update_rings, manage_software_policies, remediate_software_violation, remediate_vulnerability |
| `security_response` (tone high) | security_scan, s1_isolate_device, s1_threat_action, execute_containment*, apply_cis_remediation, remediate_sensitive_data* |
| `backup_recovery` (tone high) | trigger_backup*, restore_snapshot*, restore_*_vm*, trigger_*_backup*, execute_dr_plan* |
| `config_policies` | apply_configuration_policy, remove_configuration_policy_assignment, manage_configuration_policy, manage_policy_feature_link, manage_dns_policy, manage_browser_policy* |
| `network` | network_discovery, acknowledge_network_device*, configure_network_baseline* |
| `remote_access` | take_screenshot, analyze_screen, computer_control, create_remote_session* |
| `endpoint_agent` | trigger_agent_upgrade*, trigger_agent_restart*, set_agent_log_level, capture_agent_pprof |
| `automations_reports` | manage_automations, generate_report, manage_groups, manage_tags*, manage_saved_filters* |
| `business` | manage_quotes*, manage_invoices, manage_contracts, manage_catalog* |
| `tenancy` (tone high) | manage_organizations, delete_tenant, test_webhook*, sync_huntress_data |

`*` = currently unreachable (not in `TOOL_TIERS`); mapped anyway so the map is complete against the registry, but hidden from the picker. The exact per-tool assignment is `TOOL_CAPABILITY: Record<string, AgentCapabilityId>` and is enforced, not documented: the implementer maps every registered headless tool, and the contract test fails on any registered tool without an entry or any entry naming an unregistered tool or unknown capability.

**Operations.** For each reachable tool, `actions` are derived, never hand-tiered: the discriminator enum from the tool's `input_schema` (`action`, or `commandType` for `execute_command`) unioned with the Zod validator's enum where one exists (same rule as `aiGuardrails.approvalScope.contract.test.ts`), each resolved through `checkGuardrails(toolName, { [discriminator]: action })` to get `tier` and `readOnly`. Tools without a discriminator are single operations. Per operation the catalog also carries `policyDecidable` (key ∈ `POLICY_DECIDABLE_TIER3`) and `actEligible` (key ∈ `ACT_MANIFEST`, action-level: `manage_services:restart` is eligible, `:start`/`:stop` are not).

**Labels and descriptions.** Web i18n under `aiAgentsPage.catalog.capabilities.<id>.{label,description}`, `aiAgentsPage.catalog.tools.<tool>.{label,description}`, `aiAgentsPage.catalog.actions.<tool>.<action>` (extends the existing `policyKeys.tools/actions` pattern). Fallback: sentence-cased token. Model-facing `definition.description` is **not** used in the UI.

**Presets.** `AGENT_KIND_PRESETS: Record<AiAgentKind, readonly string[]>` of `tool:action` / `tool` entries restricted to reachable operations (a preset entry naming an unreachable operation fails the contract test). Initial values: triage → `manage_alerts:acknowledge`, `manage_alerts:resolve`, `manage_services:restart`, `manage_startup_items:disable`, `disk_cleanup:execute`, `run_script`; patch → `manage_patches:approve`, `manage_patches:install`, `manage_deployments:start`, `manage_services:restart`; helpdesk → `manage_services:restart`, `disk_cleanup:execute`, `run_script`. Ticket operations join the helpdesk/triage presets when `manage_tickets` becomes reachable.

### 4.2 Endpoints

`GET /ai/agents/tool-catalog` — `scopes` + `requireAiRead` (`ai_agents:read`), registered before `/:id`, mirrors `/policy-decidable-keys`. Static per process; `Cache-Control: private, max-age=300`. Response:

```ts
{ data: {
  capabilities: Array<{ id: string; tone: 'standard' | 'high' }>;
  tools: Array<{
    name: string; capability: string; tier: 1|2|3; readOnly: boolean;
    operations: Array<{ key: string; action: string | null; tier: 1|2|3; readOnly: boolean; policyDecidable: boolean; actEligible: boolean }>;
  }>;
  presets: Record<'triage'|'patch'|'helpdesk', string[]>;
}}
```

`GET /ai/agents/ceiling?kind=<kind>` — same gates; for a partner-scope session returns `{ data: null }`; for an org-scope session returns `{ data: { toolAllowlist: string[], supervisedActionKeys: string[] } | null }` for the live partner-wide row of that kind, read through `readWithPartnerAxisVisibility` exactly like `loadPartnerBaselineKinds` (`effectivePolicy.ts:335`). Nothing else from the partner row is projected; no link to the partner agent is offered to org sessions.

### 4.3 Allowlist semantics and the merge fix

- **Persistence rule (web).** For a tool with operations, the picker always stores `tool:action` entries, one per selected operation, even when every current operation is selected. A bare `tool` entry is stored only for single-operation tools. Rationale: bare means "every action, including ones added later"; compacting would widen authority silently.
- **Merge fix (API).** `effectivePolicy.ts` `intersect` for `toolAllowlist` and `supervisedActionKeys` becomes wildcard-aware: an entry `t:a` in one list survives if the other list contains `t:a` **or** bare `t`; a bare `t` survives only if the other list also contains bare `t` (otherwise it narrows to the scoped entries the other side lists). Property test: for all partner/org lists, every operation admitted by the merged list is admitted by both inputs under `isToolAllowlisted`.
- **Saved entries the picker cannot represent** (unknown tool, unreachable tool, bare entry on a multi-operation tool typed by hand or via API) are shown in an "Unrecognised or unreachable entries" list with a remove action and a one-line reason. They are never silently dropped or rewritten on save.

### 4.4 API hardening: supervised keys on org rows

`createAgent`/`updateAgent` reject any `actAssets.supervisedActionKeys` on an **org-owned** row that adds a key not already present on that row (422 `supervised_keys_grant_only`, per-key reasons like the existing `invalid_supervised_action_keys`). Removals remain allowed (auto-demotion and manual revoke stay possible). Partner rows keep direct edit: their keys are the ceiling. The grant executor (`authorizeSupervisedKey`) is the only additive writer and is unaffected. The current org-row checkbox UI is removed in the same wave.

### 4.5 Web: the capability picker (replaces the Permissions textarea + datalist)

Component `apps/web/src/components/settings/aiAgents/CapabilityPicker.tsx` (own directory; `AiAgentForm.tsx` is already 1,643 lines).

- Fetches the catalog once per drawer open (`fetchWithAuth('/ai/agents/tool-catalog')`) and, for org-scoped rows, the ceiling.
- **Mode-aware header line**: "Shadow mode: nothing below runs on its own. Approval requests go to a technician; low-risk changes are logged as proposals and never executed." / act-mode variant naming the manifest-eligible operations / off-mode variant.
- **Recommended for {kind}** banner with "Use recommended" (applies the preset additively) and an "Applied" state.
- **Search** over capability label, tool label, operation label and literal names.
- **Always on: read-only tools (N)** collapsed disclosure listing read-only tools by capability.
- **Capability rows** in a bordered `divide-y` list: tri-state checkbox (all / some / none of reachable mutating operations), label, description, tone badge (`High impact` for `tone: 'high'`), "x of y operations". Rows expand to tools; tools with operations expand to operation rows: checkbox, label, literal key (mono, shown only with the **Show tool names** switch), outcome badge (`Approval request` for tier 3, `Logged proposal` for tier 2), green dot + tooltip when `policyDecidable`.
- **Ordering**: capabilities that the kind's preset touches first; the rest under a collapsed "More capabilities (n)".
- **Ceiling**: on org rows, operations absent from the ceiling render disabled with `Not in partner baseline`; a capability with no available operation shows the badge on the row.
- **Summary line** under the list, always visible: "reads device, alert and fleet data, may propose N operations across M capabilities (a approval requests, b logged proposals), and executes nothing unattended" (act mode: lists the manifest-eligible ones it will execute).
- Accessibility: tri-state via `aria-checked="mixed"`, expand/collapse via `aria-expanded`, keyboard-operable rows; matches the existing radiogroup's focus ring (`focus-visible:ring-2 focus-visible:ring-ring`).
- The three protected-resource textareas stay where they are.

### 4.6 Web: the guided create flow

Create becomes a 4-step flow on the AI agents page (full width, `SetupStepper` visual pattern; the stepper's hard-wired setup i18n label is generalised first). Edit keeps the current drawer, with the picker in Permissions and the review card at the top.

1. **Purpose and posture** — Mode radiogroup first (unchanged control and copy), then Kind as cards (what it does, when it runs, what will be recommended), owner scope, name, model, instructions. Footer states the agent is created disabled.
2. **What it does** — triggers ("Runs when": severities for triage, maintenance windows, helpdesk ticket writes) above the capability picker.
3. **Safety and oversight** — protected resources, the six exposed limits with plain-language defaults, recipient roles; on partner rows the unattended-ceiling keys (existing control); on org rows graduation status read-only (no checkboxes, per 4.4).
4. **Review and create** — a summary card rendered from `GET /ai/agents/preview` (POST body = the draft; the server evaluates it with the same helpers the run loop uses, so the card cannot drift from enforcement): runs when · can read · may propose (chips with outcome tone) · executes unattended · never touches · limits · asks approval from. "Start enabled" switch, then Create. Each row links back to its step.

Wording rules: never "can read everything" (profiles have read floors and `file_operations:read` is tier 3); never "auto, audited" for tier 2 in agent context.

### 4.7 Testing

- `agentToolCatalog.contract.test.ts`: every registered headless tool has a capability; every capability id used exists; presets only name reachable operations; the unreachable list is asserted as a pinned snapshot with a comment pointing at #3300 (so a change in reachability is a deliberate edit).
- `effectivePolicy.test.ts`: wildcard-aware intersection, including the `manage_services` vs `manage_services:restart` case, plus the property above.
- `agentService.test.ts`: org-row additive supervised key → 422; removal ok; partner row unchanged; grant executor path unchanged (`supervisedKeyGrant` tests still green).
- Route tests for `/tool-catalog`, `/ceiling`, `/preview` (scope gating: org token gets its own ceiling only; partner token gets `null` ceiling).
- Web: `CapabilityPicker.test.tsx` (tri-state, persistence rule, ceiling disabling, unrecognised entries, summary counts); `AiAgentForm` tests updated; stepper flow test; `no-silent-mutations` unaffected (all writes already go through `runAction`).
- RLS/cascade: no new tables, no new columns; nothing to register.

### 4.8 Waves

| Wave | Contents | Blast radius |
|---|---|---|
| W1 (API) | catalog module + contract test, `/tool-catalog`, `/ceiling`, wildcard merge fix, supervised-key hardening, `/preview` | high (auth/permissions) — full rigor |
| W2 (web) | `CapabilityPicker` inside the existing drawer; unrecognised-entries list; org-row checkbox removal; i18n catalog strings; docs page refresh | medium |
| W3 (web) | 4-step create flow, review card (create + agent page header), stepper generalisation | medium |

W2 and W3 depend on W1; W3 depends on W2.

## 5. Decisions and advisor record

Codex (`gpt-5.6-sol`, xhigh, read-only) reviewed the draft on 2026-09-06: verdict "agree with changes". All six changes adopted: separate map (not a field on `AiTool`); derive operations via `checkGuardrails`; catalog universe = agent-reachable set; scoped persistence + wildcard merge; truthful outcome copy; mode first with four steps. Todd approved option A (all three waves) the same day.

Deliberate deviations from the previous form: Kind becomes cards (was a `<select>`); the org-row supervised-key checkboxes are removed (they contradicted the grant-only invariant); the create flow leaves the drawer.
