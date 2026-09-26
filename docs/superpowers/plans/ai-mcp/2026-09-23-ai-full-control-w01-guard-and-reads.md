---
tracking_issue: LanternOps/breeze#6754
wave: W01 (#6755)
spec: docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md
branch: feature/6754-ai-full-control/wave-6755
---
# AI full control W01: guard contracts + read-only wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the "the AI says it has no such tool" backlog from growing, and wire registered read-only tools into chat and headless agents.

**Architecture:**
- Three new mechanical contracts in the **Test API** job, each written red first:
  - (a) every `TOOL_TIERS` name is declared on the main chat and agent SDK server;
  - (b) every action of a registry-tier-1 multiplexer is classified as a read or escalated;
  - (c) every registered tool is tiered, listed in `HUMAN_ONLY_TOOLS` with a reason, or still in the frozen `KNOWN_MISSING_TOOL_TIERS`.
- One new agent deny registry (`AGENT_DENIED_READ_TOOLS`). Tier-1 reads skip the agent allowlist, so this registry is how a read is kept from headless agents.
- Wiring itself is mechanical. Each tool gets:
  - a `TOOL_TIERS` entry;
  - a literal `tool()` declaration whose Zod shape is derived from `toolInputSchemas`;
  - removal from the frozen list.

**Tech stack:** TypeScript (Hono API), Zod, Vitest, `@anthropic-ai/claude-agent-sdk` `tool()`, Astro docs, web `tierConfig.ts`.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md`. Relevant sections: W01 row, Tier semantics, Wiring checklist, D4, D5, Contracts.

**Tracking:**
1. Run `get_feature_status LanternOps/breeze#6754` first.
2. Cut branch `feature/6754-ai-full-control/wave-6755` from `origin/main`.
3. Run `start_wave` on #6755.
4. Open one PR with `Closes #6755`.

Line numbers drift, so re-grep before editing.

---

## Measured starting state

| Fact | Value | How |
|---|---|---|
| `TOOL_TIERS` entries | 170 | `Object.keys(TOOL_TIERS)` on `origin/main` `5345f00202` |
| Declared on `buildBreezeSdkTools` with all env flags on | 166 | probe with `M365_ENABLED/GOOGLE_WORKSPACE_ENABLED/BREEZE_AI_SCRIPT_AUTHORING_ENABLED=true` |
| `TOOL_TIERS` minus main-declared | exactly `list_scripts, get_script_details, list_script_templates, get_script_execution_history` | same probe |
| `KNOWN_MISSING_TOOL_TIERS` | 88 | `aiAgentSdkTools.registryParity.contract.test.ts` |
| W01 candidates whose `toolInputSchemas` entry is not a plain `z.object` | 0 | probe. Every shape can be derived, not hand-mirrored. |
| Registry tier of every W01 candidate | 1 | probe; each also carries `domain` and `searchHint` (A-W02) |

## Global constraints

- **Test-first in every task.** Write the assertion, run it, see it fail for the stated reason, then implement.
- **Commands.**
  - Single file: `cd apps/api && npx vitest run <path>`. The filter is a substring match, so check the printed file count.
  - Never `pnpm --filter <pkg> test -- --run <path>`.
  - API typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"`. **Do not pipe tsc into `tail`**, because a heap OOM then reads as green. Exit code must be 0.
  - Web: `cd apps/web && npx vitest run <path>` and `cd apps/web && pnpm exec astro check`.
- **No new tiers (spec D1).** Every wired tool is registry tier 1, and `TOOL_TIERS[name] = 1`.
- **No tool renames, no action removals, no new env vars, no migrations.** No pagination retrofit: output shaping is #6745. The derived SDK shape carries every page param the registry already has, and `aiTools.outputBudget.contract.test.ts` checks that.
- **Helper allowlist unchanged** (`helperToolFilter.ts`); spec checklist item 9.
- **Commit after every task.** End every commit message with:

  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

---

## Decisions this plan makes (W01-D1 … W01-D8)

W01-D1, W01-D4 and W01-D5 are consequential: they add cross-module registries. An independent review (Opus stand-in for the Codex quorum) was held on 2026-09-23; its amendments are folded in below.

- **W01-D1: one small data module for exposure registries.** New file `apps/api/src/services/aiToolExposure.ts` holds `HUMAN_ONLY_TOOLS` and `AGENT_DENIED_READ_TOOLS`:
  - both are `ReadonlyMap<string, string>`, mapping tool name to reason;
  - the module has no imports;
  - `aiGuardrails.ts` imports from it. Guardrails must stay free of registry and schema imports (`aiToolActions.ts:1-10`), and a data-only module keeps that rule.
- **W01-D2: declare the script-library reads on the main server, not in the catalog.** Declare the four script reads on `buildBreezeSdkTools`.
  - Why: `run_script` is on the main surface and in agent presets (`agentToolCatalog.ts` `AGENT_KIND_PRESETS`), and it requires a library `scriptId`. Without a main-surface tool that lists library scripts, a chat or agent told to "run the X script" has no way to find it.
  - Script-builder's own declarations stay as they are: separate descriptions, and that server has its own tier map.
  - Contract (a) is strict — `TOOL_TIERS ⊆ buildBreezeSdkTools(all flags on)` — not a union across SDK servers, because `TOOL_TIERS` is what `BREEZE_MCP_TOOL_NAMES` hands to the main chat and agent server as `allowedTools`, and script-builder has its own map (`SCRIPT_BUILDER_TOOL_TIERS`).
- **W01-D3: tier-1 write-action contract via an explicit read allowlist.**
  - New export `TIER1_READ_ACTIONS: Record<string, readonly string[]>` in `aiGuardrails.ts`, marked "exported for contract tests only", same as `TIER2_ACTIONS`.
  - Every action of a registry-tier-1 multiplexer must appear in `TIER1_READ_ACTIONS`, `TIER2_ACTIONS` or `TIER3_ACTIONS`, unless the tool is in `TIER1_NON_READONLY_TOOLS`.
  - So a new enum member **defaults to unclassified and fails CI** rather than defaulting to read.
  - Handler-disabled writes that are still in a Zod enum (`manage_maintenance_windows` create/update/delete, `manage_automations` create/update/delete) go into `TIER3_ACTIONS` plus `TIER3_SUPERVISED_ACTIONS`. Precedent: `manage_patches:setup_auto_approval` ("so re-enabling the handler cannot silently reopen the hole"). `manage_monitors` create/update/delete are retired on main (they return guidance before any DB access and map to `devices:read`), so they classify as reads.
  - Recorded judgment: `disk_cleanup:preview` goes in `TIER1_READ_ACTIONS`. It reads the latest snapshot and inserts a `device_filesystem_cleanup_runs` bookkeeping row; it changes no device state. Reclassifying it is W04's call.
- **W01-D4: `HUMAN_ONLY_TOOLS` starts empty.** None of the 88 is a standing exclusion. The contract is live from W01 so W02–W04 can use it. The spec's `KNOWN_MISSING` rule becomes `registry ⊆ TOOL_TIERS ∪ HUMAN_ONLY_TOOLS ∪ KNOWN_MISSING_TOOL_TIERS`, and `KNOWN_MISSING` is deleted at the end of W04.
- **W01-D5: sensitive reads are denied to headless agents via `AGENT_DENIED_READ_TOOLS`, not `AGENT_HUMAN_ONLY_TOOLS`.**
  - `AGENT_HUMAN_ONLY_TOOLS` stays reserved for self-granted authority (spec D4, question 4).
  - Enforcement follows `AGENT_HUMAN_ONLY_TOOLS` exactly: an unconditional deny in `checkAgentGuardrails`, above the allowlist, plus exclusion in `listAgentReachableTools`. It can therefore never depend on `isReadOnlyResolution`.
  - Chat still gets these tools. The human asking holds the RBAC permission and sees the same data in the UI.
  - Opt-in per agent (allowlist-gated reads) was rejected for W01: it needs a new carve-out in `checkAgentGuardrails`, a larger change to agent-shipped behavior. The deny is fail-closed and one registry line to reverse.
- **W01-D6: read-path correctness fixes land before wiring** (spec D2 applied to reads), each with a red test:
  - `get_user_risk_detail` no longer inserts a default `user_risk_policies` row on read (`readUserRiskPolicy`, `userRiskScoring.ts`); write paths keep `getOrCreateUserRiskPolicy`.
  - `get_network_changes`' `limit` description matches its handler clamp (default 50, max 200).
- **W01-D7: SDK shape derived, declaration literal.**
  - `inputShape(name)` returns `(toolInputSchemas[name] as z.ZodObject).shape` and throws for a non-object.
  - Declarations stay literal `tool('name', …)` calls. `aiAgentSdkTools.mcpCoverage.test.ts` greps the source text, and a `.map()` loop would silently empty the static scan.
- **W01-D8: the prompt budget is recorded, not gated (spec D5).** Measure with the A-W01 harness (Task 12) and record the delta. Do not block on it.

---

## Quorum amendments (Opus 5.5 stand-in, 2026-09-23)

Verdict: no decision rejected. Every agent dispatch path runs through `checkAgentGuardrails`.

- **WQ1 (D5).** `m365_query_users` (org-wide identities) and `m365_query_signins` (org-wide sign-in history) are tier 1, not device-bounded, and not in `m365ToolTiers`. **Decision: add both to `AGENT_DENIED_READ_TOOLS`.** No agent preset uses them; they appear only in the `TOOL_CAPABILITY` map. This changes behavior for shipped agents, so call it out in the PR body.
- **WQ2 (D5).** `query_c2c_jobs` returns `errorLog`, and Graph errors can carry user principal names and item names. **Decision: add it to `AGENT_DENIED_READ_TOOLS`.**
- **WQ3 (D5).** Full-profile agent runs sent every name in `BREEZE_MCP_TOOL_NAMES` (`runLoop.ts`), so denied tools reached the model as schemas and failed only when called. Filter the full-profile exposure through `isNeverAgentTool`. This also helps the D8 prompt budget.
- **WQ4 (D1).** Move `AGENT_HUMAN_ONLY_TOOLS` into `aiToolExposure.ts` and re-export it from `aiGuardrails.ts`, so the two deny registries live in one file. Add one exported predicate, `isNeverAgentTool(name)`, and use it in both `checkAgentGuardrails` and `listAgentReachableTools`, replacing the two hand-duplicated filter chains.
- **WQ5 (D4).** Rule for W02–W04: the wave that wires a tool must classify it as agent-reachable, agent-human-only or agent-denied **in the same PR**. Known entries:
  - `request_elevation` → `AGENT_HUMAN_ONLY_TOOLS` in W04 (an auto-approve rule grants privilege with no human in the loop).
  - `manage_automations` create/update → `AGENT_HUMAN_ONLY` when that handler is re-enabled (it arms standing unattended execution).
- **WQ6 (D3).** The contract must also assert that every `TOOL_ACTION_INPUT_KEYS` tool has a non-null `toolActionEnum()`, so a tool that switches on a free-string action can't escape it.
- **WQ7 (D3, text fix).** `disk_cleanup:preview` does not dispatch a scan. It reads the latest snapshot and inserts a `cleanup_runs` bookkeeping row. The classification is unchanged; only the stated reason was corrected.

---

## W01 tool list (30 wired: 26 L1 reads + 4 L2 script reads)

"Agent" is whether headless agents get the tool (W01-D5). Every tool is read-only and registry tier 1.

### Backup, Hyper-V, MSSQL, vault, SLA and C2C (13)

| Tool | Agent |
|---|---|
| `get_backup_status` | expose |
| `browse_snapshots` | expose (snapshot rows, not file contents; an agent needs it to propose a restore) |
| `get_vm_restore_estimate` | expose |
| `query_mssql_instances` | expose |
| `get_mssql_backup_status` | expose |
| `query_hyperv_vms` | expose |
| `get_hyperv_vm_details` | expose |
| `get_vault_status` | expose |
| `query_backup_sla` | expose |
| `get_sla_breaches` | expose |
| `get_sla_compliance_report` | expose |
| `query_c2c_jobs` | **deny** (WQ2) |
| `search_c2c_items` | **deny**: personal data plus text authored by external senders |

### Security and compliance (6)

| Tool | Agent |
|---|---|
| `get_software_compliance` | expose |
| `query_compliance_policies` | expose |
| `get_elevation_history` | expose |
| `get_peripheral_activity` | expose |
| `get_user_risk_scores` | **deny**: names and emails of every scored user, no device axis |
| `get_user_risk_detail` | **deny**: personal data plus free-text event descriptions |

### Monitoring, analytics and network (3)

| Tool | Agent |
|---|---|
| `query_analytics` | expose |
| `get_ip_history` | expose |
| `get_network_changes` | expose |

### Devices, integrations and scripts (8, including the 4 L2 tools)

| Tool | Agent |
|---|---|
| `list_remote_sessions` | expose |
| `query_agent_versions` | expose |
| `query_webhooks` | expose |
| `search_script_library` | expose |
| `list_scripts` (L2) | expose |
| `get_script_details` (L2) | expose |
| `list_script_templates` (L2) | expose |
| `get_script_execution_history` (L2) | expose |

**Held for a follow-up PR:** 16 further read-only candidates, including `list_monitors` and `get_monitor`. They stay in `KNOWN_MISSING_TOOL_TIERS` until then; `get_sensitive_data_overview` is already listed in `AGENT_DENIED_READ_TOOLS`, so it is agent-denied from the moment it is wired.

**Totals.**
- Wired: 30. That is 26 newly tiered (`TOOL_TIERS` 170 → 196, `KNOWN_MISSING_TOOL_TIERS` 88 → 62) plus 4 newly declared (main-declared 166 → 196 with all flags on).
- `AGENT_DENIED_READ_TOOLS`: 7 (`search_c2c_items`, `query_c2c_jobs`, `get_sensitive_data_overview`, `get_user_risk_scores`, `get_user_risk_detail`, `m365_query_users`, `m365_query_signins`).
- Candidates excluded from W01: `collect_evidence` (tier 2, dispatches a device command) and `registry_operations` (`read_key`/`get_value` are deliberately tier 2). Both move to W04. All tier-1 `manage_*` multiplexers are left untouched: their read actions become reachable when the whole tool is wired in W02–W04.

**Headless-agent note on text.** Hostnames, event logs and ticket text already reach agents. Attacker-controlled text alone is not grounds for denial. The deny rule: **personal data about people who are not the device's operator, or a sensitive-data location map, with no device axis bounding the run, or no operational need.**

---

## Task 0: Branch and lifecycle

- [ ] `get_feature_status LanternOps/breeze#6754`. Confirm W01 (#6755) is not started and no open PR touches `aiAgentSdkTools.ts` TOOL_TIERS.
- [ ] `git fetch origin && git switch -c feature/6754-ai-full-control/wave-6755 origin/main`, then `start_wave` for #6755.
- [ ] Baseline run: `cd apps/api && npx vitest run src/services/aiAgentSdkTools.registryParity.contract.test.ts src/services/aiAgentSdkTools.mcpCoverage.test.ts src/services/aiAgents/agentToolCatalog src/services/aiGuardrails src/services/llm/toolEval/goldenPrompts.test.ts`. Expected: all green on main.

## Task 1: `HUMAN_ONLY_TOOLS` registry and the registry-coverage rule

**Files:** create `apps/api/src/services/aiToolExposure.ts`; modify `aiAgentSdkTools.registryParity.contract.test.ts`.

- [ ] **Red.** Replace the registry ⊆ `TOOL_TIERS` test with "every registered tool is tiered, human-only with a reason, or a known pre-existing gap", plus "`HUMAN_ONLY_TOOLS` entries are registered, untiered, not also KNOWN_MISSING, and carry a reason". The stale-entry test's filter becomes `name in TOOL_TIERS || HUMAN_ONLY_TOOLS.has(name) || !registered.has(name)`. Expected: FAIL, cannot resolve `./aiToolExposure`.
- [ ] **Green.** Create `aiToolExposure.ts` (no imports) with an empty `HUMAN_ONLY_TOOLS` map.
- [ ] Extract a pure `humanOnlyProblems(map, registered, tiers, missing)` and assert it flags a fixture `new Map([['query_devices', 'x']])` twice (tiered, short reason), so the rule is not vacuous while the map is empty.

## Task 2: Contract (a), every `TOOL_TIERS` name declared on the main server

- [ ] **Red.** In the registryParity test add `declaredOnMainServer()` / `declaredToolsByName()` (all env flags stubbed on) and two tests: every tiered tool is declared on `buildBreezeSdkTools`; every `listAgentReachableTools()` name is declared there. Expected: FAIL with exactly the four script reads.
- [ ] Commit the red test together with Task 5's fix.

## Task 3: Tier-1 write-action contract

**Files:** modify `aiGuardrails.ts`; create `aiGuardrails.tier1WriteActions.contract.test.ts`.

- [ ] **Red.** The contract (no `vi.mock`, real registry): every action of each tier-1 multiplexer is in `TIER1_READ_ACTIONS`, `TIER2_ACTIONS` or `TIER3_ACTIONS`; a declared read is never also escalated and names a real enum action of a real tier-1 tool; `isReadOnlyResolution` agrees with the classification; every `TOOL_ACTION_INPUT_KEYS` tool has a non-null `toolActionEnum()` (WQ6). Expected: FAIL, `TIER1_READ_ACTIONS` not exported; then, with an empty export, FAIL listing the handler-disabled writes (the control that proves the contract discriminates).
- [ ] **Green.** Fill `TIER1_READ_ACTIONS` from the probe; escalate the handler-disabled writes (W01-D3) into `TIER3_ACTIONS` and `TIER3_SUPERVISED_ACTIONS`. Update `aiGuardrails.test.ts` and the empty-allowlist admission snapshot in `aiGuardrails.agentPrincipal.contract.test.ts` for the newly escalated tools.

## Task 4: `AGENT_DENIED_READ_TOOLS` and `isNeverAgentTool`

**Files:** `aiToolExposure.ts`, `aiGuardrails.ts` (`checkAgentGuardrails`), `aiAgents/agentToolCatalog.ts` (`listAgentReachableTools`), `aiAgents/runLoop.ts`, plus `aiGuardrails.agentPrincipal.contract.test.ts` and `aiAgents/agentToolCatalog.contract.test.ts`.

- [ ] **Red.** Pin the exact `AGENT_DENIED_READ_TOOLS` set (each registered, reason ≥ 20 chars, disjoint from `AGENT_HUMAN_ONLY_TOOLS`); each name denied by `checkAgentGuardrails` even as the only allowlist entry; each still allowed on the chat path (`checkGuardrails`); each excluded from `listAgentReachableTools()`; control: `query_devices` is allowed for an agent.
- [ ] **Green.** Add the map (W01-D5, WQ1, WQ2), move `AGENT_HUMAN_ONLY_TOOLS` into the module and re-export both from `aiGuardrails.ts` (WQ4), add `isNeverAgentTool` and use it in `checkAgentGuardrails` and `listAgentReachableTools`, and derive the full-profile run exposure in `runLoop.ts` from `TOOL_TIERS` filtered by `isNeverAgentTool` (WQ3). The runLoop test mocks gain a `TOOL_TIERS` export.

## Task 5: Declare the four L2 script reads on the main server

- [ ] Add `inputShape(toolName)` next to `registryDescription` (W01-D7).
- [ ] Declare `list_scripts`, `get_script_details`, `list_script_templates` and `get_script_execution_history` next to `get_script_execution`, each as a literal `tool('<name>', registryDescription('<name>'), inputShape('<name>'), makeHandler(...))`.
- [ ] Delete `NOT_IN_BREEZE_MCP_SERVER` and its stale-entry test from `aiAgentSdkTools.mcpCoverage.test.ts`.
- [ ] Commit (Task 2's red plus this fix).

## Task 6: Read-path correctness fixes (W01-D6)

- [ ] **Red then green**, `userRiskScoring.ts`: reading a user's risk detail with no policy row must not insert one. Add `readUserRiskPolicy` and use it on the read path only.
- [ ] **Red then green**, `aiToolsNetwork.ts`: `get_network_changes`' `limit` description matches its clamp.

## Task 7: Wire the 26 L1 reads

- [ ] **Red.** Add the pinned `W01_READ_TOOLS` list (26 names) to the registryParity test: each is tier 1 in both maps, declared, and its SDK shape keys equal `toolInputSchemas`.
- [ ] **Green.** Per family: add `name: 1` to `TOOL_TIERS` under a `// Spec 2026-09-23 W01 (#6755): read-only, previously registered but untiered` comment; add literal `tool()` declarations; delete the names from `KNOWN_MISSING_TOOL_TIERS` (88 → 62; update its docstring). Drop newly-declared tools from the golden-prompt `BASELINE_UNDECLARED_TOOLS` in the same change.
- [ ] tsc exit 0.

## Task 8: Agent catalog surfaces

- [ ] Run `agentToolCatalog.contract.test.ts`; the unreachable-set snapshot diff must be exactly the newly wired, not-denied names. **Read the diff before `-u`.**
- [ ] Pin that each denied read stays unreachable and that `browse_snapshots`, `list_scripts` and `query_backup_sla` are reachable.
- [ ] Update the empty-allowlist admission list in `aiGuardrails.agentPrincipal.contract.test.ts` for the newly wired tier-1 reads.

## Task 9: Web `tierConfig.ts` and category parity

- [ ] **Red.** Remove the newly wired names from `TOOL_CAPABILITY_NOT_YET_IN_TIER_CONFIG`. Expected: FAIL, "not represented in tierConfig.ts".
- [ ] **Green.** Add Tier-1 entries to `tierConfig.ts` under the matching `ToolCategory`. Widen `CATEGORY_CAPABILITY_PAIRS` only with a one-line reason (`Security & Compliance` gains `config_policies` for `get_peripheral_activity`).
- [ ] `cd apps/web && npx vitest run src/components/ai-risk && pnpm exec astro check`.

## Task 10: AI docs page

- [ ] **Red.** `aiGuardrailsAiDocs.parity.test.ts`: every name in `W01_DOCUMENTED_TOOLS` has a `| Tool | Tier | Description |` row.
- [ ] **Green.** Extend `## Backup AI Tools`; add `## Security, Compliance & Operations AI Tools`; note which reads are chat-only; correct the stale `Ticketing & Billing` MCP-only sentence.

## Task 11: Golden prompts, one per newly reachable domain

- [ ] **Red.** Count assertion 60 → 67. **Green.** Append g61–g67 (Hyper-V, MSSQL, vault, C2C jobs, PAM elevation, user risk, remote sessions), each listing the W01 tool first. Update the structurally-unwinnable set.

## Task 12: Prompt-size measurement (W01-D8)

- [ ] With `ANTHROPIC_API_KEY`, run the A-W01 `tool-capture.ts` harness on main and the branch. Without it, record the offline proxy (JSON bytes of the SDK declarations) and write `not measured: ANTHROPIC_API_KEY absent` for token rows.
- [ ] Append `## Full-control W01 (#6755) delta` to `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-baseline.md`. If the by-domain tool index outgrows its 5 KB test budget, raise the budget with a comment citing the measurement.

## Task 13: Final verification and PR

- [ ] Full API unit suite (`cd apps/api && npx vitest run`); the contract set by name; tsc exit 0; web `ai-risk` tests and `astro check`; `apps/docs` `astro check`.
- [ ] One review round (`/pr-review-toolkit:review-pr`).
- [ ] Follow-up: script tools cannot see partner-wide/system scripts (`aiToolsScripts.ts` vs `routes/scripts.ts`).
- [ ] PR body: summary, tool totals, the agent-denied reads (and the WQ1 behavior change for shipped agents), the prompt delta, `Closes #6755`.

---

## Self-review checklist

- [ ] `AGENT_DENIED_READ_TOOLS` matches the tool list's agent column plus WQ1.
- [ ] `KNOWN_MISSING_TOOL_TIERS` = 62, `TOOL_TIERS` = 196, and main-declared with all flags on = 196.
- [ ] No test in this PR was written after the code it tests.
- [ ] No existing baseline or allowlist was widened. The only additions are `TIER1_READ_ACTIONS` (a classification, not an exemption) and `HUMAN_ONLY_TOOLS` (empty).
