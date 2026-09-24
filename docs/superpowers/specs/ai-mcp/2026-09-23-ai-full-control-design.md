---
status: draft (quorum: Opus 5.5, 2026-09-23, AGREE WITH CHANGES — all 5 blocking findings folded in)
date: 2026-09-23
tracking_issue: LanternOps/breeze#6754
related: "#3300, #6141, #2605, #6096, #6110, feature #6147"
---

# In-product AI full control — design

## Problem

The goal is that Breeze's own AI can do anything a technician could do through the product UI. That covers web chat, the Helper, and headless AI agents, which all run on the Agent SDK over the `aiTools` registry. The only exclusions are capabilities deliberately kept for humans. MCP is a secondary consumer of the same registry.

Today (measured on `origin/main` `d1cbf4fe27`, 2026-09-23) that is far from true. The model can fail to reach a capability at three different layers:

| Layer | Symptom | Count |
|---|---|---|
| **L1: registered, no `TOOL_TIERS` entry** | On the chat and agent SDK surface, `createSessionPreToolUse` rejects the call as "Unknown tool", and `BREEZE_MCP_TOOL_NAMES` never advertises it. The model tells the user the feature doesn't exist. The external MCP server lists registry tools separately, so many of these tools are reachable over MCP today. | **88** (the frozen `KNOWN_MISSING_TOOL_TIERS`) |
| **L2: tiered, missing from the main chat/agent SDK server** | The model on that surface is never shown a schema, so it can never make the call. | **4** (`list_scripts`, `get_script_details`, `list_script_templates`, `get_script_execution_history`). They are declared only on the script-builder server (`scriptBuilderTools.ts`). `agentToolCatalog.listAgentReachableTools` still lists them as agent-reachable, which is wrong. |
| **L3: product capability with no tool at all** | A REST route module has no tool. | **158** `{ gap }` entries in `mcpCoverage.ts`, frozen in `FROZEN_GAPS` |

Facts that shape the design:
- **RBAC isn't the blocker.** All 225 registered tools already have a `TOOL_PERMISSIONS` entry.
- **The tier source of truth exists.** Every registered tool declares `getToolTier(name)`, and the parity contract already asserts `TOOL_TIERS[name] === getToolTier(name)` for every shared name.
- **Approval classification exists for most dangerous tools.** 41 of the 88 L1 tools already appear in `TIER2_ACTIONS`, `TIER3_ACTIONS`, `TIER3_FOUR_EYES_*`, `TIER3_SUPERVISED_*` or the rate-limit maps. Every restore, DR execute, remote session, elevation request and Hyper-V power action is already four-eyes or supervised.
- **Inputs.** 37 of the 88 have no `toolInputSchemas` entry, so their input shape exists only in the registry JSON schema.
- **Features are still shipping mute.** Built after #3300's contract existed, `manage_quotes` (16 actions), `query_custom_fields`, the PAM elevation tools and the sensitive-data tools all shipped without a tier. The contract freezes the list, but nothing forces the list down to zero.

## Goals

1. Every registered tool is callable by in-product AI, or listed in a new **`HUMAN_ONLY_TOOLS`** registry with a written reason. This registry is distinct from `AGENT_HUMAN_ONLY_TOOLS`, which only blocks headless agents. `KNOWN_MISSING_TOOL_TIERS` goes to **zero** and is deleted.
2. A new contract closes L2 permanently: **TOOL_TIERS ⊆ the union of every SDK server's declared set** (main, script-builder, M365, Google, script-authoring), built with every env-gated builder switched on so the result doesn't depend on flags. A second part checks that every tool the agent catalog calls reachable is declared on the agent server.
3. Every tool that changes things goes through a recorded approval review before it is exposed. Each tool, and each write action of a `manage_*` tool, gets a documented class: tier 1, tier 2 (user approves unless auto-approve), supervised, or four-eyes.
4. Every L3 gap is classified as **build**, **exempt** (with a reason) or **defer** (with an issue). `FROZEN_GAPS` only shrinks. **Build** items ship as tools that meet tool-never-weaker-than-route parity (#6096/#6110).
5. Guard against regrowth. A new registered tool, or a new route module, with no AI exposure fails the **Test API** CI job, the same mechanism as the cascade lists.

## Non-goals and standing exclusions

These are the exclusions from the #6141 audit, and they carry over. They move to `mcpCoverage` `exempt` entries or `HUMAN_ONLY_TOOLS`:
- identity and auth changes: API keys, SSO, role and user writes, service principals
- caller verification
- agent rollback
- bulk destructive billing operations
- the one-time migration and legal-evidence routes

Todd can pull any of these back in scope. Each is one registry entry plus a class decision.

Also out of scope:
- Output shaping for the newly exposed tools. That is covered by #6745 and the A-W05 pattern. New list tools in this program must still use `aiToolPagination.ts` from day one; see "Wiring checklist".
- Changes to the MCP protocol (feature B #6154).

## Tier semantics (existing and unchanged; verified in code 2026-09-23)

**Chat and Helper sessions** (`aiAgentSdk.ts` `canUseTool` path):
- **Tier 1:** runs without a prompt.
- **Tier 2:** asks the user for approval (`aiAgentSdk.ts:801`). There are two exceptions where it runs without a prompt:
  - the session is in `auto_approve` mode;
  - the call is read-only (`TIER2_READONLY_*`) and no plan is active (`:985-994`).

  So tier 2 means **"the user approves, unless they turned on auto-approve"**. It is not an audit-only tier.
- **Tier 3:** always needs approval, split into two classes:
  - **supervised** (`TIER3_SUPERVISED_*`): the requesting user approves.
  - **four-eyes** (`TIER3_FOUR_EYES_*`): a second person approves.

  An unclassified tier-3 tool falls back to four-eyes (`resolveApprovalScope`, `aiGuardrails.ts:726`). That fallback fails safe, so moving any such tool to supervised is a **loosening** and needs explicit sign-off in the PR.
- **Escalation maps:** `TIER2_ACTIONS` / `TIER3_ACTIONS` raise individual actions of a `manage_*` tool above the tool's registry tier. `TIER3_INPUT_AWARE_*` escalates based on the input values, for example a public comment compared with an internal one.

**Headless agents** (`checkAgentGuardrails`):
- `isReadOnlyResolution` treats **tier 1 as read-only** (`aiGuardrails.ts:1750`), except for `TIER1_NON_READONLY_TOOLS`. Read-only calls skip the agent's action allowlist and still run in shadow mode.
- **Consequence:** a registry-tier-1 `manage_*` tool with a write action missing from the escalation maps is an unallowlisted write for agents. Today the six tier-1 multiplexers in L1 are covered by hand only.
- Four-eyes keys can never be pre-authorised for an agent (`agentService.ts:85-92`), so an agent's four-eyes call becomes a proposal that a human approves.
- `AGENT_HUMAN_ONLY_TOOLS` is always denied to an agent. It is for tools that could let an agent grant itself authority.

**Decision D1.** The wiring waves do not invent new tiers. `TOOL_TIERS[name] = getToolTier(name)` stays enforced. Where review finds a tool's registry tier too low, the fix goes in the registry, so both maps move together, and the change is called out in the PR.

## Class review rule (applies to every tool that changes something)

A reviewer answers four questions for each tool, and for each write action of a `manage_*` tool:

1. **Reversible?** Can the user undo it in the product within a minute? Tagging and saved filters can be undone; a restore, containment, a customer-visible comment, sending a quote or a price change cannot.
2. **Leaves the tenant or reaches a person?** Does it email or notify a customer, publish a ticket comment to a customer, charge or bill money, call a vendor, move data to an external destination (webhooks, notification channels), or touch a customer machine?
3. **Blast radius:** one object, one device, one org, or partner-wide (every org)?
4. **Can an agent grant itself authority?** If so, it goes in `AGENT_HUMAN_ONLY_TOOLS`. The precedent is `manage_ai_agents`.

The answers map to a class:
- Irreversible **and** (leaves the tenant **or** partner-wide) → **four-eyes**.
- Irreversible, **or** leaves the tenant, **or** partner-wide, **or** touches a customer machine → **supervised**, at minimum.
- Reversible, tenant-internal and single-org → **tier 2**. **Nothing that leaves the tenant may be tier 2**, because `auto_approve` runs tier 2 with no prompt.
- Read-only → **tier 1**.

Where the answer depends on the input, escalate through `TIER3_INPUT_AWARE_*` instead of classing the whole tool at the worst case. Examples: a public ticket comment compared with an internal one, or a partner-wide backup profile compared with an org one.

The reviewer records the answers in a per-wave table in the plan. The class maps are then updated, and each class gets one contract-test row.

**Decision D2.** A tool whose review disagrees with its current classification is not exposed until the classification change lands in the same PR. A wrong class on `execute_containment` is worse than the tool being invisible (#3300).

### Classification concerns already found (quorum 2026-09-23; resolved in the owning wave)

| Tool / action | Today | Concern | Proposed |
|---|---|---|---|
| `manage_tickets:comment` | tier 2, `isPublic` defaults to true | A public comment is customer-visible: it sets `firstResponseAt` and writes a `ticket.commented` outbox row | Input-aware: a public comment is supervised, an internal note stays tier 2 (W02) |
| `manage_notification_channels:create`/`update` | tier 2 | Points alert data at any webhook, Slack, Teams or SMS destination: an exfiltration path under prompt injection, silent in `auto_approve` | supervised (W02) |
| `manage_catalog:set_price`/`set_org_price`/`set_bundle_components`/`archive_item` | tier 2, no class | Changes what gets billed; `archive_item` is harder to undo | supervised (W02) |
| `manage_backup_profiles:update`/`delete` | tier-1 tool, escalated to tier 2 | Partner-wide profiles change every org; a narrowed selection silently stops protecting data | Input-aware: supervised when partner-wide (W03) |
| `collect_evidence` | tier 2 | Its evidence enum includes `screenshot`, while `take_screenshot` is tier 3 because screenshots are sensitive | Input-aware: `screenshot` is supervised (W04) |
| `create_incident` | tier 2 | Publishes `incident.created`; check what subscribes (webhooks, playbooks) before calling it tenant-internal | Decided in W04 after reading the subscribers |
| `revoke_elevation` | tier 2, no class | Removes privilege and has full site and device checks | tier 2 is correct (W04) |
| tier-3 tools with no class (`instant_boot_vm`, `trigger_backup`, …) | fall back to four-eyes | Moving any of them to supervised loosens the gate | Each move needs sign-off in the PR (W03/W04) |

## Wiring checklist (every tool, every wave)

1. **`TOOL_TIERS` entry** equal to `getToolTier`.
2. **SDK `tool()` declaration** in `buildBreezeSdkTools`, or in the flag-gated builder for its domain. It uses `registryDescription(name)`, whose single description surface came from A-W03, plus a Zod schema derived from `toolInputSchemas`.
   - Add the `toolInputSchemas` entry if it is missing; 37 tools need one.
   - The three input-schema surfaces must agree. The existing parity test covers this.
3. **Guardrail classes** from the review above: `TIER2_ACTIONS` / `TIER3_ACTIONS` / `TIER3_FOUR_EYES_*` / `TIER3_SUPERVISED_*`, `TOOL_ACTION_INPUT_KEYS` for `manage_*` multiplexers, and `TOOL_RATE_LIMITS` for anything that touches a device or a vendor.
4. **Scope parity with the matching REST route:** the same permission, org-axis and site-axis checks (#6096/#6110). For a tool that already reaches MCP these checks exist; the wave verifies them with a site-restricted-caller test instead of assuming them.
5. **Output:** list-returning tools use `aiToolPagination.ts` and pass the `outputBudget` contract. The contract flags a no-limit list tool.
6. **Search metadata:** *verify* the registry registration carries `domain` and `searchHint` (A-W02), and that the tool is in the `TOOL_CAPABILITY` agent-builder map. The existing contract already requires every registered tool there.
7. **Paired surfaces with their own parity tests:**
   - the unreachable-set snapshot in `agentToolCatalog.contract.test.ts`
   - `apps/web/src/components/ai-risk/tierConfig.ts` (`aiGuardrailsTierConfig.parity.test.ts`)
   - the AI docs page (`aiGuardrailsAiDocs.parity.test.ts`)
8. **Agent exposure:** state for each tool whether headless agents get it (see D4). Tiering a tool makes it agent-reachable (`agentToolCatalog.ts:416`), and tier-1 reads skip the agent allowlist.
9. **Helper:** out of scope by default. The Helper whitelist (`helperToolFilter.ts`, `HELPER_TOOL_SCOPING`) is single-device by design; a tool joins it only by explicit decision.
10. **Removal from the frozen list:** `KNOWN_MISSING_TOOL_TIERS`, or `FROZEN_GAPS` for L3.
11. **Golden eval and prompt budget:** add one prompt per newly reachable domain to `goldenPrompts.ts`. Gates: no accuracy drop against main (the A-W05 precedent), **and** each wave's chat turn-1 prompt stays within its recorded budget (see Risks).

## Waves

The feature is registered in feature-lifecycle as one parent with one wave sub-issue per wave. Waves are ordered by risk. The mechanical guard lands first so the backlog can only shrink.

| Wave | Scope | Risk | Tools |
|---|---|---|---|
| **W01: guard + read-only wiring** | L2 contract (TOOL_TIERS ⊆ declared); `HUMAN_ONLY_TOOLS` registry + the "registry ⊆ tiered ∪ human-only" rule; wire the 4 L2 script reads; **new tier-1 write-action contract** (below); wire every read-only L1 tool (`get_`/`list_`/`query_`/`search_`/`browse_`, plus `generate_incident_report`, whose handler is read-only), with an **agent-exposure decision per read**: `search_c2c_items` (mailbox contents), `browse_snapshots`, `get_sensitive_data_overview` and `get_user_risk_detail` feed sensitive or attacker-controlled text into sessions that can make changes; fix the four script reads on the agent catalog | medium: reads only, but scope parity and agent exposure are decided per tool | ~48 |
| **W02: PSA + billing writes** | `manage_tickets`, `manage_quotes`, `manage_catalog` (+ D3 rename), `manage_saved_filters`, `manage_tags`, `manage_notification_channels`, `test_webhook` | high: customer-facing sends and money | 7 |
| **W03: backup, DR and virtualization** | `trigger_*` / `restore_*` / `instant_boot_vm` / `manage_hyperv_*` / `manage_dr_plan` / `execute_dr_plan` / `manage_backup_profiles` / `configure_backup_sla` / `configure_vault` / vault, C2C and MSSQL sync/verify | high: data loss if wrong | ~20 |
| **W04: security, incident and device operations** | `execute_containment`, `create_incident`, `collect_evidence`, PAM `request_`/`revoke_elevation`, `create_remote_session`, `manage_processes`, `manage_scheduled_tasks`, `registry_operations`, `trigger_agent_restart`/`upgrade`, software/browser/peripheral policies, `remediate_*`, `assign_security_training`, network baseline/acknowledge, `manage_monitor_definitions`. Note: wiring `manage_processes` does **not** re-admit `kill` to act mode; that needs the pid→name identity pin in `actManifest.ts` (#4149), a separate step | highest: runs on customer machines | ~20 |
| **W05: L3 triage** | Classify all 158 `{ gap }` route modules as build, exempt or defer; write the build list as W06+ wave plans grouped by domain; file defers | decision work, no code | — |
| **W06+: L3 builds** | One wave per domain from W05, starting with #6141's order: PSA (contacts CRUD, checklist templates) → alerts (escalation, routing) → network (topology, SNMP) → security policy (access reviews, audit baselines, PAM rules) → fleet findings actions + software catalog + custom-field CRUD → billing lifecycle → Pax8 → AI schedules/operator tasks | per domain | TBD |

Once W01–W04 land, `KNOWN_MISSING_TOOL_TIERS` is empty and deleted.

**D3: the `manage_catalog` name collision.** `manage_catalog` is the billing price book. #6141 found that operators read "catalog" as the deployable-software catalog.
- W02 renames it to `manage_billing_catalog` before it is first exposed to chat.
- The rename keeps `manage_catalog` as a deprecated MCP alias for one release. External MCP clients may use the name today because it is already reachable over MCP.
- The software catalog tool built in W06+ takes the name `manage_software_catalog`.

**D4: agent (headless) exposure.** Keep the existing gates as the agent default:
- an allowlist for writes
- supervised calls only through the agent's pre-authorised action keys
- four-eyes calls become proposals that a human approves; four-eyes keys can never be pre-authorised

This keeps the valuable "agent proposes a restore, a human approves it" path. `AGENT_HUMAN_ONLY_TOOLS` stays reserved for question 4 (self-granted authority). If a single action must be denied to agents, add an action-level `AGENT_HUMAN_ONLY_ACTIONS` rather than denying the whole tool; `manage_tickets:move_org` must not take ticket triage down with it. Tier-1 reads need their own decision, because they bypass the agent allowlist (see W01).

## Contracts added or changed (Test API unless noted)

- **`registryParity.contract.test.ts`:**
  - replace `KNOWN_MISSING_TOOL_TIERS` with `registry ⊆ TOOL_TIERS ∪ HUMAN_ONLY_TOOLS`
  - `HUMAN_ONLY_TOOLS` entries must carry a non-empty reason
  - **new:** `TOOL_TIERS ⊆ declaredSdkToolNames ∪ SESSION_ONLY_TIERS`
- **New tier-1 write-action contract** (the most important new guard): for every registered tool with registry tier 1, every write action in its input `action` enum must sit in an escalation map (`TIER2_ACTIONS`/`TIER3_ACTIONS`), or the tool must be in `TIER1_NON_READONLY_TOOLS`. Without it, adding a write action to a tier-1 multiplexer silently hands headless agents an unallowlisted write.
- **Class-coverage contract:** every tier-3 tool, and every tier-3 action, is in exactly one of four-eyes or supervised. The existing split test is extended to the newly wired tools, not duplicated.
- **Scope parity:** each wave adds site-restricted and cross-org denial tests for its tools, using the `aiToolsAuditDetailsSiteScope` integration pattern (**Integration Tests**).
- **`mcp-coverage.test.ts`:** `FROZEN_GAPS` only shrinks (existing). W05 also adds `defer` entries that must carry an issue number.

## Risks

- **Mis-classifying a tool that changes things.** Mitigated by D2, the per-wave review table, and one Opus quorum review of the W02–W04 tables before those waves build (Codex is unavailable until 09-26; Opus stands in, as agreed 09-22).
- **Prompt growth.** Adding about 90 tool schemas grows every chat and agent turn; A-W01 measured 117 tools as roughly 102k cached read tokens. A-W04 (`onlyTools` subsets per surface plus page-context domains) is the real lever. **Decision D5:** W01 may land before A-W04. W02–W04 each carry a hard budget of **+8k turn-1 prompt tokens** against main, measured with the A-W01 tool-capture harness. A wave that exceeds its budget waits for A-W04 instead of merging. That keeps A-W04 on the critical path without blocking the guard work.
- **Parity gaps on old tools.** Some L1 tools predate #6096/#6110 and have only been reachable over MCP with org-scoped keys, so the site axis was never exercised. W01's per-tool site-restricted test is the check.

## Success

- `KNOWN_MISSING_TOOL_TIERS` is deleted, and `FROZEN_GAPS` holds only `defer` items with issues.
- A newly registered tool, or a new route module, without AI exposure or an explicit exemption fails CI.
- Golden eval shows no drop, and each wave adds domain prompts that pass.
- The release sweep's "the AI says I don't have that tool" class (#3300, pass-2 sweep group 5) no longer reproduces for any registered tool.
