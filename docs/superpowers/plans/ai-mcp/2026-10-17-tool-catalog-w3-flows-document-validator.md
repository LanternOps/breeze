---
tracking_issue: LanternOps/breeze#5215
wave: W03 (#5218) — Flow document, expression grammar, validator, `flows` table, draft/validate/get/list tools, Flow card, read-only Flows UI (PR A shared + API, PR B web)
---

# Tool Catalog — Wave 3: Flow Document, Validator, Read UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tech describes a workflow in chat; the AI emits a flow document that the catalog-aware validator accepts; it is saved as a `draft` flow the tech can read in chat (Flow card) and on a read-only Flows page. Nothing runs yet.

**Architecture:** The document schema, built-in step registry, expression grammar, template renderer, and structural rule check are pure, browser-safe modules in `packages/shared/src/flows/` + `packages/shared/src/validators/flows.ts`, so the web renders and checks the same document the API stores. The API adds one dual-owned `flows` table (org XOR partner, dual-axis RLS + partner-wide SELECT branch, same migration), a catalog-aware `services/flowValidator.ts` that resolves step tools against the **owner's** catalog (core tools the flow principal could reach + the owner's tenant tools from the W1 resolver), a `services/flows/service.ts` CRUD core, four core AI tools behind `FLOWS_ENABLED`, and two read routes. The web adds a flag-gated nav entry beside Jobs, `/flows` + `/flows/:id` read-only pages, and a chat card for `draft_flow` / `get_flow` results.

**Tech Stack:** TypeScript, Zod 4, Hono, Drizzle (queries only), hand-written SQL migration, Postgres forced RLS, Ajv 8 (tenant tool schemas, via the W1 resolver's compile options), Vitest, React + Astro + react-i18next (8 locales).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md` — §6.1 (document), §6.2 (templating and expressions), §6.3 (validation), §6.4 (`flows` table only), §6.6 (naming only), §6.8 (authoring tools, Flow card, Flows UI), §8 (obligations), §9 (testing). Roadmap row W03: `2026-09-07-tool-catalog-flows-roadmap.md`. **Task A0 amends the spec** with the as-built findings and the decisions below (Open Decisions 1–6), each marked **Amendment (W3 plan, 2026-10-17)**.

**Dependencies:** W1 (#5216) merged — this plan uses `resolveTenantTools` and its Ajv compile options (`apps/api/src/services/toolSources/resolver.ts`). **W2 (#5217, PR #9106, open): none.** W3 reads `TenantToolDescriptor` fields that exist for both kinds; when W2 merges, OpenAPI tools flow through the same resolver with no W3 change. **MCP B-W02 (PR #9135, open): soft.** It reuses the A-W02 `domain` field (`getToolDomain`) as the per-grant MCP domain; W3's tools declare `domain: 'scripts'` (label "Scripts & automation"), which satisfies both. Both PRs touch `tenantExportPolicyRegistry.ts` / `aiToolNames.ts`; whichever lands second rebases (additive, no semantic overlap).

## Global Constraints

- **Rigor: high** (new tenant table, partner-wide writes, AI write tool). Red test first in every task; a test written after its code does not count.
- **Tests:** API `cd apps/api && npx vitest run <file>` (exact file paths; never `pnpm --filter … test -- --run <path>`, and remember vitest path filters are substring matches); shared `cd packages/shared && npx vitest run <file>`; web `cd apps/web && npx vitest run <file>`. A run reporting 0 tests is a stall, not green. Add `--pool=threads --maxWorkers=2` on a loaded host.
- **Typecheck:** `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"` — read the exit code; never pipe tsc to `tail` (OOM masquerades as green). Shared: `cd packages/shared && npx tsc --noEmit`. Web: `cd apps/web && npx astro check`.
- **Integration suites** (fail only under the CI "Integration Tests" job, never "Test API"): run on a per-worktree stack (`pnpm wt-stack`; copy root `.env`, blank AI keys, `BREEZE_WORKSPACE_ENABLED=false`, free `BREEZE_DOCKER_SUBNET=172.31.N.0/24`), then `cd apps/api && npx vitest run --config vitest.integration.config.ts <file>` per file. Tear the stack down afterwards and say so.
- **Migration:** exactly one, `apps/api/migrations/2026-12-31-120000-flows.sql`. Newest on main at authoring is `2026-12-30-140000-repair-discovery-demoted-server-roles.sql`; re-check `ls apps/api/migrations | sort | tail -1` before committing and keep the `2026-12-31-120000` prefix unless `scripts/check-migration-naming.sh` rejects it (then take the next free `HHMMSS` the same day). Idempotent (`IF NOT EXISTS`, guarded `DO $$`, `DROP POLICY IF EXISTS` + `CREATE POLICY`); no inner `BEGIN;`/`COMMIT;`; explicit `ON DELETE` on every FK; **no DML** (so no `set_config` line is required, and `migrationRlsScope.test.ts` stays green); policies in the same file as the table; then `pnpm db:check-drift`.
- **Registries (grep, don't judge):** `flows` → `DUAL_AXIS_TENANT_TABLES` **and** `XOR_OWNERSHIP_DUAL_AXIS_TABLES` (`apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` ~L498 / ~L895), `CORE_ORG_CASCADE_DELETE_ORDER` (`apps/api/src/services/tenantCascade.ts` ~L255: after `'fleet_remediation_runs'`, before `'google_workspace_connections'`), `CORE_TENANT_EXPORT_POLICY` (`apps/api/src/services/tenantExportPolicyRegistry.ts`, every column classified), `orgMergeRegistry.ts` (`custom`). Not device- or ticket-scoped: no device/ticket list entries. No encrypted column in W3 (Open Decision 4), so no `encryptedColumnRegistry.ts` entry.
- **Names:** flow slug `^[a-z][a-z0-9_]{1,47}$` and never containing `__`; step id `^[a-z][a-z0-9_]{0,31}$`; input name `^[a-zA-Z][a-zA-Z0-9_]{0,31}$`. Tool references in `steps[].tool`: core names (no `__`), tenant names `<slug>__<name>`, built-ins `wait` / `set`. Core tool names added: `draft_flow`, `validate_flow`, `get_flow`, `list_flows` (single underscores; `aiToolsRegistryParity.test.ts` asserts no core name contains `__`).
- **Limits (spec §6.1/§6.2/§6.5, verbatim):** 50 steps; `forEach.maxItems ≤ 500`, `concurrency ≤ 10`; `timeoutSec` default 300, max 3600; `wait.minutes ≤ 1440`; expression AST depth 32; 10,000 evaluation nodes per expression; rendered value 256 KB.
- **Feature flag:** `FLOWS_ENABLED` (env, default `false`). Off ⇒ `/api/v1/flows*` 404; flow tools are not declared to chat; Breeze's MCP server omits them from `tools/list` and refuses them in `tools/call` (MCP enumerates the registry directly, `routes/mcpServer.ts` ~L1313, so the chat factory alone does not gate it — quorum P3); every handler returns `{"error":"flows_disabled"}` as the last line of defence; `/api/v1/config` reports `features.flows: false`; the nav entry is hidden. Wire it exactly like `TOOL_SOURCES_ENABLED`: `config/env.ts` (`flowsEnabled()`), `config/validate.ts` (~L717 schema field + ~L2167 boolean check), `routes/config.ts`, `docker-compose.yml` (~L397), `deploy/docker-compose.prod.yml` (~L367), `.env.example` (~L1747), `deploy/.env.example` (~L433).
- **Permissions:** reuse `automations.read` (list/get/validate, routes) and `automations.write` (`draft_flow`). No new permission rows ⇒ no migration DML. Partner-wide writes additionally require `canManagePartnerWidePolicies(auth)` (`services/partnerWideAccess.ts:25`); `services/flows/service.ts` must name it (`__tests__/partner-wide-write-coverage.test.ts` walks `services/**`).
- **Public repo:** no customer names, hostnames, or IPs in code, fixtures, or PR text.
- **Branches / PRs:** branch `feature/5215-tool-catalog-flows/wave-5218` off fresh `origin/main`. PR A (Tasks A0–A11) targets main → normal CI; body `Part of #5218`. PR B (Tasks B1–B4) stacks on PR A and gets **no CI** — `gh workflow run CI --ref <branch>` before merge; body `Closes #5218`. Merge with bare `gh pr merge <N>` (merge queue; never `--admin`). Feature-lifecycle: `start_wave` before Task A0, `complete_wave` after PR B merges.

## Open Decisions

Each records the options, the author's recommendation, and the Codex quorum position (§ Quorum). The plan is written to the recommendation; Todd may overrule any of them before execution — the task each one affects is named.

1. **`flow.<slug>` vs the W1 `__` separator (spec §6.6).** W1 replaced the dot with `__` because the Anthropic tool-name grammar `^[a-zA-Z0-9_-]{1,64}$` rejects dots, and reserved the source slug `flow` (`RESERVED_TOOL_SOURCE_SLUGS`, `packages/shared/src/validators/toolSources.ts:6`).
   - **(a) `flow__<slug>`** — reuses the tenant-name shape: `splitQualifiedToolName` yields `{ slug: 'flow', name: <flowSlug> }`; `flow` can never be a source slug, so no collision. Flow slug ≤ 47 chars keeps the name ≤ 53 ≤ 64; forbidding `__` inside the flow slug keeps every later `__`-split unambiguous.
   - (b) a separate prefix such as `flows_<slug>` — collides with the core namespace (core names are single-underscore words) and would need its own reservation predicate.
   - **Recommend (a).** W3 fixes only the slug rule (it lives in the table CHECK); registering `flow__<slug>` in the resolver is W05. Affects Tasks A0, A1, A4.
2. **Where built-in step tools (`wait`, `set`) register.** Spec §6.1 says "registered in core, Tier 1".
   - (a) Register in the `aiTools` map — they would then be subject to every registry contract (`toolInputSchemas`, `TOOL_PERMISSIONS`, `TOOL_TIERS`, the `tool()` declaration grep in `aiAgentSdkTools.mcpCoverage.test.ts`, the index budget, MCP `tools/list`, the agent catalog), and each would need an explicit carve-out to stay out of chat and MCP.
   - **(b) A shared `FLOW_BUILTIN_STEPS` registry** (`packages/shared/src/flows/builtins.ts`: name → Zod input schema + tier 1 + description), consulted by the validator before the catalog; the W04 runner dispatches them in-process. They never enter `aiTools`, so chat, MCP, parity, and the index never see them. A contract test asserts the built-in names (and the reserved later ones: `notify`, `ai`, `http_request`) are disjoint from every registered core tool name and contain no `__`.
   - **Recommend (b).** W3 ships `wait` and `set` only; `notify` / `ai` / `http_request` are rejected with `builtin_not_available` until their wave (W04 / W05). Affects Tasks A0, A1, A7.
3. **Which §6.3 rules run at save in W3.** As-built finding: rule 4's example is unsatisfiable — `run_script` is explicitly **excluded** from `POLICY_DECIDABLE_TIER3` ("one lane per asset class"; `services/actionIntents/policyDecidableKeys.ts` ~L185, "do not add without a fresh quorum"), and no `assetArgs` concept exists on `AiTool` (`services/aiTools.ts:119`). The policy-decidable entries that do exist (e.g. `security_scan:restore`) carry `requiresEffectPin` and `maxTargetCardinality`, not asset ids.
   - **Adopted (quorum):** at save (W3) run rule 1 (tool exists/enabled in the owner's catalog **and** is flow-eligible), rule 2 (input vs schema with template-aware partial validation), rule 3 (structure + whole-document bounds), rule 5 (effective tier as an upper bound), and rule 6 as an **ownership-reference check independent of approval mode** (literal `run_script.scriptId` / `run_script.groupId` ownership; literal `deviceArgs` belong to the owner org and never appear in a partner-wide flow). **Every `approval: 'pre_approved'` is an error in W3** (`pre_approval_not_available`): the intersection the spec describes is empty on main, so a stored draft must not carry a promise no lane can keep. The tech sets pre-approval on the detail page at enable time (spec §6.8), so the AI loses nothing. **W04** owns rule 4 end to end — it must first choose between the act-mode `actAssets` lane (script asset + content digest, what spec §2 "mirroring `ai_agents.actAssets`" describes) and the policy-decidable effect-pin lane, explicitly and without widening `POLICY_DECIDABLE_TIER3` incidentally — plus rule 7 (enabler permissions) and the event-dispatch-mode prerequisite, all at enable.
   - Author's original position: accept `pre_approved` as a warning (`pre_approval_decided_at_enable`) and error only on tenant / four-eyes steps. Codex disagreed (empty intersection ⇒ the field is a dead promise); resolved on the merits in Codex's favour because spec §6.8 puts the toggle in the enable UI, not in the AI's document.
   - Other alternative: (c) invent `assetArgs` in W3 (designs W04's binding without the runner that consumes it). Rejected.
   - Affects Tasks A0, A7.
4. **Whether `enabled_by_*` and webhook columns ship now unused.**
   - **Recommend: ship `enabled_by_user_id`, `enabled_at`, `paused_reason` now; defer `webhook_secret_encrypted` / `webhook_token_fingerprint` to W05.** The status CHECK already names `enabled`/`paused`, and W04 writes these columns in its first PR; they are plain, non-secret, and classify trivially. A secret column with no writer would still need an `encryptedColumnRegistry.ts` entry, an AAD domain, a rotation story, and an export classification — W05 adds the secret, its encryptor, rotation, and `excludedSensitive` / `reviewedIncluded` classification together.
   - Alternative: ship all columns now (one fewer migration later; an encrypted column nobody can write or rotate in the meantime).
   - Affects Tasks A4, A5.
5. **How the `aiToolIndex` 6656-byte budget is paid** (`apps/api/src/services/aiToolIndex.test.ts` ~L131: `< 6.5 * 1024`). Measured at authoring on main: **6649 bytes** (7 B headroom). The four names on the "Scripts & automation" line add `, draft_flow, get_flow, list_flows, validate_flow` = **49 B** → 6698 when `FLOWS_ENABLED=true`. With the flag off (the default and the test env) the tools are not declared to chat, so the default index is byte-identical.
   - (a) Trim `DOMAIN_NOTES` by ≥ 43 B — both notes (`patching`, `scripts`) have already been trimmed four times (#8167, #8742, Trust Center W02i); more cuts start removing guidance.
   - (b) Ship three tools: fold `validate_flow` into `draft_flow` (`dryRun: true`) — saves 15 B, still needs a 28 B trim, and a read-only (`automations.read`) user loses document validation.
   - **(c) Prompt-size review: raise the ceiling to 6.75 KB (6912 B)**, recorded in `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-baseline.md` as "Tool Catalog W3 delta: +49 B with FLOWS_ENABLED, 0 B default", and add a second budget assertion measured with `FLOWS_ENABLED=true` so the flag-on prompt is gated too.
   - **Recommend (c)** — the test comment itself says further growth "needs a prompt-size review, not a bump"; this is that review, and it adds the missing flag-on measurement. Needs Todd's sign-off; if refused, fall back to (a) with the trims reviewed in the PR. Affects Task A9.
6. **`draft_flow` tier** (spec §6.8: "all Tier 1 except `run_flow` … `enable_flow`").
   - **Recommend Tier 2 for `draft_flow`** (writes a row): Tier 1 is treated as read-only by headless agents (`isReadOnlyResolution`, listed "always on" in the capability picker) and is reachable with an MCP `ai:read` key; Tier 2 maps to `ai:write` and gets the Tier-2 audit-ledger row. Plus `AGENT_HUMAN_ONLY_TOOLS` (`services/aiToolExposure.ts:40`) in W3 — an operator agent authoring flows needs the `managed_by_agent_id` story, not a side door. `validate_flow`, `get_flow`, `list_flows` stay Tier 1.
   - Alternative: Tier 1 per spec + `TIER1_NON_READONLY_TOOLS` carve-out (that set is reserved for the workspace tools today and is pinned by `aiGuardrails.workspace.contract.test.ts`).
   - Affects Tasks A0, A9.

## Quorum

Codex `xhigh` (gpt-6-astra, read-only, 2026-10-17) on the table shape (P1), the validator split (P2), and the tool tiers + gating (P3). Every citation was re-read in source before acceptance. Recorded again in Task A0's §11 row and the PR body.

| # | Author position | Codex | Outcome |
|---|---|---|---|
| P1 | One `flows` table, text+CHECK status, `enabled_by_*` now, webhook columns in W05, slug rule without `__`, `custom` merge with `_m<n>` | **Agree**, with fixes: enforce the org/partner slug-shadow rule in **both** directions (a later partner-wide create can collide with existing org slugs) and serialize it; merge suffix must be length-aware, strip trailing `_`, and retry; `ai_session_id` should be a real FK `ON DELETE SET NULL` (precedent `db/schema/scripts.ts:317`); register in both RLS sets; cascade ordering is FK-derived (`tenantCascade.ts:1421`), so verify, don't assume alphabetical | All adopted (Tasks A4, A5, A8). |
| P2 | Shared/API split; reject invalid drafts; live re-validation on read; built-ins outside `aiTools`; mask schema issues under templated pointers; `pre_approved` mostly a warning | **Disagree as written.** Agrees with the split, built-ins, reject-invalid, live re-validation. Corrections: (1) pre-approval intersection is empty (`policyDecidableKeys.ts:183`) ⇒ reject in W3; (2) tenant tiers must come from `guardrailCheckForTenantTool(descriptor)` — `checkGuardrails` returns tier 4 for unknown names (`aiGuardrails.ts:2062`); (3) blanket masking hides definite errors (the `run_script` XOR refinement reports at `scriptId`, `aiToolSchemas.ts:1104`) and tenant `validate` returns no paths (`resolver.ts:212`) ⇒ partial validation that masks only value-level issues; (4) tier also depends on live-read flags (`aiLiveDeviceReads.ts:17`) and proposal context (`aiGuardrails.ts:2072`) ⇒ centralize all deciding inputs, require literal subtrees, reject `proposalId` in flows; (5) ownership checks are separate from pre-approval and cover ordinary steps; authorize the real caller before any system-scoped owner resolution (`resolver.ts:274`) | All adopted (Decision 3, Task A7, Task A8 `resolveFlowOwnerForCaller`). |
| P3 | `draft_flow` Tier 2 + agent human-only; reads Tier 1; `automations.read/write`; partner-wide gate; `FLOWS_ENABLED` via a chat factory | **Agree** on tiers/permissions/gate. Adds: factory gating is chat-only — MCP enumerates the registry directly (`mcpServer.ts:1313`), so gate MCP list/call and handlers too; `AGENT_HUMAN_ONLY_TOOLS` blocks agents only, not every non-human principal | Adopted: MCP list/call gate (Task A9). MCP API keys with `ai:write` may author drafts by design (a draft executes nothing; `created_by_user_id` is the key's creator). |
| Risks | — | (1) org merge renames colliding loser tool sources (`orgMergeCustomExecutors.ts:1753`), so a moved flow's `hudu__x` would silently resolve to the survivor's different integration; (2) catalog membership ≠ headless eligibility (session-only tools); (3) whole-document resource bounds | (1) merge rewrites moved flows' tenant-tool references (Task A5); (2) eligibility = `listAgentReachableTools()` minus flow tools, session-only test added (Task A7); (3) document bytes / input depth / template count limits (Tasks A1, A3). |

## Review Focus

- **Templated values meeting strict schemas:** `"deviceIds": ["{{trigger.device.id}}"]` against `z.array(uuid)` must not fail validation, while a missing required field, an unknown key, or a cross-field refinement (both `scriptId` and `proposalId` set, one of them templated) next to it still must. (Task A7 tests `templated leaves are unknown, missing required keys still fail`, `refinement issues are never masked`.)
- **A partner-wide flow referencing one org's asset:** a literal org-owned `scriptId` or any literal device id in a partner-wide flow is refused with the same message whether the id is foreign or nonexistent (no existence oracle). (Task A7 tests `partner flow refuses org script`, `foreign and missing script ids give the same issue`.)
- **Hostile paths in expressions/templates:** `steps.a.output.__proto__`, `constructor`, `prototype`, and inherited properties must never resolve; deep nesting and long `||` chains must hit the depth/node budget, never the JS stack. (Task A2 tests.)
- **Org token reading partner-wide flows:** an org-scoped user sees its partner's partner-wide flows on `/flows` and via `get_flow`, but cannot update them through `draft_flow { flowId }` (the FOR SELECT branch grants read only). (Task A8 test, Task A11 forge test.)
- **Catalog drift after save:** a draft referencing a tenant tool that is later disabled shows a `tool_not_found` issue on `get_flow` and on the detail page rather than an error page. (Task A8 test `get re-validates live`.)

---

## File Structure

**packages/shared**
- Create `src/validators/flows.ts` (+ `flows.test.ts`) — document v1 Zod schema, limits, name regexes, `slugifyFlowName`, DTO + issue types; export from `src/validators/index.ts`.
- Create `src/flows/expr.ts` (+ `expr.test.ts`) — expression tokenizer/parser/evaluator.
- Create `src/flows/templates.ts` (+ `templates.test.ts`) — `{{ path }}` extraction and rendering.
- Create `src/flows/builtins.ts` (+ `builtins.test.ts`) — `FLOW_BUILTIN_STEPS`.
- Create `src/flows/structure.ts` (+ `structure.test.ts`) — rule 3 and parse-level issues.
- Create `src/flows/index.ts`; modify `src/index.ts` (`export * from './flows'`). Everything here stays free of Node builtins (`src/browserSafeBarrel.test.ts`).

**apps/api — data + registries**
- Create `migrations/2026-12-31-120000-flows.sql`; `src/db/schema/flows.ts`; modify `src/db/schema/index.ts`.
- Modify `src/__tests__/integration/rls-coverage.integration.test.ts`, `src/services/tenantCascade.ts`, `src/services/tenantExportPolicyRegistry.ts`, `src/services/orgMergeRegistry.ts`, `src/services/orgMergeCustomExecutors.ts`.
- Create `src/__tests__/integration/flowsPartnerRls.integration.test.ts`.

**apps/api — services**
- Create `src/services/flowValidator.ts` (+ test) — catalog-aware validation (rules 1, 2, 4-subset, 5, 6).
- Create `src/services/flows/catalog.ts` (+ test) — owner catalog: flow-eligible core tools, tenant tools for the owner, built-ins; `FLOW_OWNED_REFERENCE_FIELDS`.
- Create `src/services/flows/owner.ts` (+ test) — `resolveFlowOwnerForCaller` (caller authorization before any system-scoped read).
- Create `src/services/flows/service.ts` (+ test) — `saveDraftFlow`, `listFlows`, `getFlow`, `assertFlowSlugAvailable`.
- Create `src/services/aiToolsFlows.ts` (+ test) — the four AI tools; `src/services/aiToolEnvGates.ts` — `isToolEnvGatedOff` for the MCP surface.
- Modify `src/services/toolSources/resolver.ts` — export `resolveTenantToolsForOwner(owner)` and `compileTenantInputSchema(schema)` (factored from the existing compile).
- Modify `src/services/aiGuardrails.ts` — `TIER_DECIDING_INPUT_KEYS`; `TOOL_PERMISSIONS` entries.
- Modify `src/services/automationReferenceAuthorization.ts` — export `scriptOwnershipCondition`.
- Modify registry seams: `src/services/aiTools.ts` (register), `src/services/aiToolSchemas.ts`, `src/services/aiAgentSdkTools.ts` (`TOOL_TIERS` + gated `flowToolDefinitions`), `src/services/aiToolExposure.ts` (`AGENT_HUMAN_ONLY_TOOLS`), `src/services/aiAgents/agentToolCatalog.ts`, `src/services/aiGuardrails.agentPrincipal.contract.test.ts`, `src/services/aiTools.descriptionBudget.contract.test.ts`, `src/services/aiToolIndex.test.ts`, `src/services/mcpCoverage.ts`.
- Modify `src/config/env.ts`, `src/config/validate.ts`, `src/routes/config.ts`; compose + `.env.example` files listed in Global Constraints.

**apps/api — routes**
- Create `src/routes/flows.ts` (+ `flows.test.ts`); modify `src/index.ts` (mount `/flows`).

**apps/web**
- Modify `src/stores/featuresStore.ts` (`features.flows`, `useFlowsGate`), `src/lib/navGates.ts` (`requiresFlows`), `src/components/layout/Sidebar.tsx` (primary nav after Jobs), `src/lib/routeScope.ts` (`/flows`).
- Create `src/pages/flows/index.astro`, `src/pages/flows/[id].astro`; `src/components/flows/{api.ts, FlowsPage.tsx, FlowDetailPage.tsx, FlowStepList.tsx, FlowIssuesPanel.tsx, FlowDraftCard.tsx}` + tests.
- Modify `src/components/ai/AiChatMessages.tsx` (card branch).
- Create `src/locales/<8>/flows.json`; modify `src/locales/<8>/common.json` (`nav.flows`), `src/locales/<8>/pages.json` (`titles.flows`, `titles.flowDetail`), `src/lib/i18n/translationCoverage.test.ts` (reviewed cognate counts only if needed).

---

## PR A — Shared grammar + API

### Task A0: Spec amendments

**Files:**
- Modify: `docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md` (§6.1 built-ins + example tool name, §6.3 rule 4/6/7 timing, §6.4 webhook columns, §6.6 naming, §6.8 `draft_flow` tier, §11 new row)

- [ ] **Step 1: Add one Amendment (W3 plan, 2026-10-17) call-out per decision as finally adopted** — §6.1: built-ins live in `FLOW_BUILTIN_STEPS`, not `aiTools`; W3 ships `wait`/`set`; the example's `halo.create_ticket` reads `halo__create_ticket`. §6.3: which rules run at save vs enable (Decision 3); `pre_approved` is refused in W3 because `run_script` is excluded from `POLICY_DECIDABLE_TIER3`, so rule 4 as written has no satisfiable case and W04 must pick the pre-approval lane; rule 2 masks only value-level issues under templated leaves; rule 6 is an ownership check for every step, not a pre-approval sub-rule; flows reference library scripts only (no `proposalId`). §6.4: webhook columns move to W05. §6.6: `flow.<slug>` → `flow__<slug>`, slug `^[a-z][a-z0-9_]{1,47}$` without `__`. §6.8: `draft_flow` is Tier 2 and agent human-only. §11: a "Plan amendments (W3)" row naming the quorum outcome.
- [ ] **Step 2: Commit** — `git commit -m "docs(specs): W3 as-built amendments — flow__ naming, shared built-ins, save-time rule split"`

### Task A1: Document schema, built-ins, shared types

**Files:**
- Create: `packages/shared/src/validators/flows.ts`, `packages/shared/src/validators/flows.test.ts`, `packages/shared/src/flows/builtins.ts`, `packages/shared/src/flows/builtins.test.ts`, `packages/shared/src/flows/index.ts`
- Modify: `packages/shared/src/validators/index.ts`, `packages/shared/src/index.ts`

**Interfaces (Produces):**
```ts
// validators/flows.ts
export const FLOW_DOCUMENT_VERSION = 1;
export const FLOW_LIMITS = { maxSteps: 50, maxInputs: 20, maxForEachItems: 500, maxConcurrency: 10,
  defaultTimeoutSec: 300, maxTimeoutSec: 3600, maxExprLength: 2048, maxDocumentBytes: 262_144,
  maxInputDepth: 16, maxTemplates: 500 } as const;   // last three: quorum risk 3 (whole-document bounds)
export const FLOW_SLUG_RE: RegExp;        // /^[a-z][a-z0-9_]{1,47}$/ — plus isValidFlowSlug() rejects '__'
export const FLOW_STEP_ID_RE: RegExp;     // /^[a-z][a-z0-9_]{0,31}$/
export const FLOW_INPUT_NAME_RE: RegExp;  // /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/
export function isValidFlowSlug(s: string): boolean;
export function slugifyFlowName(name: string): string;   // lower, [^a-z0-9]+ → '_', trim '_', prefix 'f_' if not a letter first, ≤ 48, never '__'
export const flowTriggerSchema;   // discriminatedUnion('type'): schedule{cron,timezone} | event{event,filter} | webhook{} | manual{}
export const flowInputDeclSchema; // { name, type: 'string'|'number'|'boolean'|'uuid', required (default false), description? ≤ 500 }
export const flowStepSchema;      // { id, tool (1..64), input (record, default {}), when?, forEach?{items,as,maxItems(1..500, default 100),concurrency(1..10, default 1)}, approval ('default'|'pre_approved', default 'default'), onFailure ('stop'|'continue', default 'stop'), timeoutSec (1..3600, default 300) } .strict()
export const flowDocumentV1Schema; // { version: literal(1), name (1..120), description? ≤ 2000, trigger, inputs (≤ 20, default []), steps (1..50) } .strict()
export type FlowDocumentV1 = z.infer<typeof flowDocumentV1Schema>;
export type FlowStatus = 'draft' | 'enabled' | 'paused' | 'disabled';
export type FlowIssueCode = 'schema' | 'duplicate_step_id' | 'unknown_step_reference' | 'forward_reference'
  | 'item_outside_foreach' | 'unknown_root' | 'undeclared_input' | 'expr_parse_error' | 'template_parse_error'
  | 'tool_not_found' | 'tool_not_allowed' | 'builtin_not_available' | 'trigger_not_available' | 'input_invalid'
  | 'input_not_supported' | 'action_not_literal' | 'tier_input_not_literal' | 'tool_blocked'
  | 'pre_approval_not_available' | 'reference_not_owned' | 'device_not_owned' | 'device_in_partner_flow'
  | 'event_unknown' | 'document_too_large' | 'input_too_deep' | 'too_many_templates';
export interface FlowIssue { code: FlowIssueCode; severity: 'error' | 'warning'; message: string; stepId?: string; pointer?: string }
export interface FlowStepSummary { id: string; tool: string; source: 'core' | 'tenant' | 'builtin'; tier: 1 | 2 | 3 | null; approval: 'default' | 'pre_approved' }
export interface FlowValidationResult { valid: boolean; effectiveTier: 1 | 2 | 3 | null; steps: FlowStepSummary[]; issues: FlowIssue[] }
export interface FlowSummaryDto { id: string; slug: string; name: string; ownerScope: 'organization' | 'partner'; orgId: string | null; partnerId: string | null; status: FlowStatus; effectiveTier: 1 | 2 | 3; triggerType: string; definitionVersion: number; updatedAt: string }
export interface FlowDetailDto extends FlowSummaryDto { description: string | null; definition: FlowDocumentV1; createdByUserId: string | null; aiSessionId: string | null; createdAt: string }
// flows/builtins.ts
export const FLOW_BUILTIN_STEPS: { wait: { tier: 1; inputSchema: z.ZodType; description: string }; set: { … } };
export type FlowBuiltinName = keyof typeof FLOW_BUILTIN_STEPS;
export const FLOW_LATER_BUILTINS: readonly ['notify', 'ai', 'http_request'];
export function isFlowBuiltin(name: string): name is FlowBuiltinName;
```
Trigger details: `schedule.cron` refined with `isStructurallyValidCron` (`packages/shared/src/utils/cron.ts:57`), `timezone` 1..64 (IANA validity checked on the API with `Intl.DateTimeFormat`); `event.event` 1..64 (membership checked on the API against `EVENT_TYPES`, `services/eventBus.ts:596`); `event.filter` is `record<string, string|number|boolean|null>` with ≤ 20 keys whose names match `^[a-zA-Z][a-zA-Z0-9_.]{0,127}$`. `wait.input` = `{ minutes: int 1..1440 }.strict()`; `set.input` = `{ values: record<FLOW_INPUT_NAME_RE, unknown> (1..20 keys) }.strict()`.

- [ ] **Step 1: Failing tests** (`flows.test.ts`, `builtins.test.ts`):
  - the spec §6.1 example (with `halo__create_ticket`, built-in `wait`) parses; defaults applied: `approval:'default'`, `onFailure:'stop'`, `timeoutSec:300`.
  - rejects: 51 steps; `forEach.maxItems: 501`; `concurrency: 11`; `timeoutSec: 3601`; step id `Cleanup` and `1x`; unknown top-level key `foo` (strict); `version: 2`; cron `"61 * * * *"`.
  - `isValidFlowSlug('disk_cleanup') === true`, `('a__b') === false`, `('a') === false`, 49-char slug false.
  - `slugifyFlowName('Disk Cleanup — Escalation!') === 'disk_cleanup_escalation'`, `('42 things') === 'f_42_things'`, `('a__b')` contains no `__`.
  - `FLOW_BUILTIN_STEPS.wait.inputSchema` rejects `{ minutes: 1441 }`; `isFlowBuiltin('notify') === false`; no built-in or later built-in contains `__`.
  Run `cd packages/shared && npx vitest run src/validators/flows.test.ts src/flows/builtins.test.ts` → FAIL (modules missing).
- [ ] **Step 2: Implement** the modules above; export from the barrels.
- [ ] **Step 3: Run** the two files + `src/browserSafeBarrel.test.ts` → PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(shared): flow document v1 schema and built-in step registry (#5218)"`

### Task A2: Expression grammar

**Files:**
- Create: `packages/shared/src/flows/expr.ts`, `packages/shared/src/flows/expr.test.ts`

**Interfaces (Produces):**
```ts
export type FlowValue = null | boolean | number | string | FlowValue[] | { [k: string]: FlowValue };
export type FlowRoot = 'trigger' | 'inputs' | 'steps' | 'item' | 'flow' | 'now';
export interface FlowPath { root: FlowRoot; segments: Array<string | number> }   // steps.<id>.output.x → root 'steps', ['<id>','output','x']
export type ExprNode =
  | { kind: 'lit'; value: null | boolean | number | string }
  | { kind: 'path'; path: FlowPath }
  | { kind: 'not'; arg: ExprNode }
  | { kind: 'bin'; op: '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||' | 'in'; left: ExprNode; right: ExprNode }
  | { kind: 'call'; fn: 'length' | 'exists' | 'lower'; arg: ExprNode };
export const EXPR_LIMITS = { maxDepth: 32, maxEvalNodes: 10_000, maxSourceLength: 2048 } as const;
export type ExprParseResult = { ok: true; ast: ExprNode; paths: FlowPath[] } | { ok: false; error: string; offset: number };
export function parseExpr(src: string): ExprParseResult;
export function parsePath(src: string): { ok: true; path: FlowPath } | { ok: false; error: string };   // shared with templates.ts
export type FlowScope = Partial<Record<FlowRoot, FlowValue>>;
export type ExprEvalResult = { ok: true; value: FlowValue } | { ok: false; error: 'budget_exceeded' };
export function evaluateExpr(ast: ExprNode, scope: FlowScope): ExprEvalResult;
export function isTruthy(v: FlowValue): boolean;   // v === true
```
Grammar (precedence low→high): `||`, `&&`, `== !=`, `< <= > >= in`, unary `!`, primary (literal | path | `fn(arg)` | `( expr )`). Literals: `null`, `true`, `false`, decimal numbers `-?\d+(\.\d+)?`, single- or double-quoted strings with `\\ \' \" \n \t` escapes. Paths: identifier `[A-Za-z_][A-Za-z0-9_]*` then `.ident` or `[n]` (non-negative integer); first segment must be a `FlowRoot`; segment names `__proto__`, `prototype`, `constructor` are a parse error. `exists` requires a path argument (parse error otherwise).

Semantics (spec §6.2, fixed here): missing path and explicit `null` both evaluate to `null`; resolution uses own-property lookup only (`Object.hasOwn`) on plain objects/arrays; `==`/`!=` strict (`Object.is`-free: `===` on primitives, `false` for any array/object operand); `< <= > >=` only number-vs-number or string-vs-string (code-unit order), otherwise `false`, and `false` whenever an operand is `null`; `in` is array membership by `===` on primitives (right side not an array ⇒ `false`); `&&`/`||`/`!` use `isTruthy` (only `true` is true) and return booleans; `length(x)` = `Array.from(string).length` for strings, `.length` for arrays, else `null`; `lower(s)` = `s.toLowerCase()` for strings, else `null`; `exists(p)` = the path resolves to an own property (even if its value is `null`). Evaluation counts nodes; exceeding 10,000 returns `{ ok: false, error: 'budget_exceeded' }`. Never throws.

- [ ] **Step 1: Failing tests** (`expr.test.ts`), one `describe` per concern:
  - every operator with a truth table row each; precedence `a || b && c`; parentheses.
  - null semantics: `steps.x.output.missing == null` → true; `null < 1` → false; `exists(inputs.a)` true when `inputs.a` is `null`, false when absent; `steps.s.status == 'skipped'` on a scope where `s` is skipped.
  - strictness: `1 == '1'` → false; `[1] == [1]` → false; `'b' in ['a','b']` → true; `'ab' in 'abc'` → false.
  - prototype safety: parsing `steps.a.output.__proto__` / `.constructor` / `.prototype` fails; a scope `{ trigger: Object.create({ inherited: 1 }) }` gives `trigger.inherited == null` → true.
  - bounds: 33 nested parens → parse error mentioning depth; a 2,049-char source → parse error; a parse of `a || a || …` (5,001 terms) → `budget_exceeded` or a parse error, never a thrown `RangeError`.
  - functions: `length('héllo') == 5`; `lower(1) == null`; `exists(1)` → parse error; unknown function `upper(x)` → parse error.
  - `paths` lists every referenced path once per occurrence (used by rule 3).
  Run `cd packages/shared && npx vitest run src/flows/expr.test.ts` → FAIL.
- [ ] **Step 2: Implement** a hand-written tokenizer + recursive-descent parser carrying a depth counter (parse error past 32) and an iterative-or-bounded evaluator with a node counter. No `eval`, no `Function`, no regex-built code.
- [ ] **Step 3: Run** → PASS. **Step 4: Commit** — `git commit -m "feat(shared): flow expression grammar with fixed null/strictness semantics (#5218)"`

### Task A3: Templates and structural checks (rule 3)

**Files:**
- Create: `packages/shared/src/flows/templates.ts`, `templates.test.ts`, `structure.ts`, `structure.test.ts`

**Interfaces:**
- Consumes: `parsePath`, `FlowPath`, `FlowScope`, `FlowValue` (Task A2); `FlowDocumentV1`, `FlowIssue`, `FLOW_LIMITS` (Task A1).
- Produces:
```ts
// templates.ts
export const TEMPLATE_RE: RegExp;   // /\{\{\s*([^{}]*?)\s*\}\}/g
export interface TemplateRef { pointer: string; path: FlowPath; exact: boolean }   // pointer = JSON Pointer of the containing leaf, e.g. '/deviceIds/0'
export function extractTemplates(value: unknown): { refs: TemplateRef[]; errors: Array<{ pointer: string; error: string }> };
export function templatedPointers(value: unknown): Set<string>;   // pointers of every string leaf containing '{{'
export function renderTemplates(value: unknown, scope: FlowScope): { ok: true; value: FlowValue } | { ok: false; error: 'render_too_large' | 'template_parse_error'; pointer?: string };
// structure.ts
export function checkFlowStructure(doc: FlowDocumentV1): FlowIssue[];
```
Rendering: a string that is exactly one template yields the referenced value with its type preserved (missing ⇒ `null`); otherwise each template is replaced by its stringified value (`null` ⇒ `''`, objects/arrays ⇒ `JSON.stringify`); the rendered result above 262,144 bytes (UTF-8 of `JSON.stringify`) ⇒ `render_too_large`. Template bodies are paths only (spec §6.2), not expressions.

`checkFlowStructure` (all `severity: 'error'`): `duplicate_step_id`; every `steps.<id>` reference in `input` templates, `when`, and `forEach.items` names a step that appears **earlier** (`forward_reference`; self-reference counts as forward) and exists (`unknown_step_reference`); `item` root only inside a step with `forEach` (`item_outside_foreach`); `inputs.<name>` must be declared in `doc.inputs` (`undeclared_input`); a `forEach.as` other than `item` is rejected by the schema (keep `as` but require `'item'` in v1 — one less name to resolve); `when`/`forEach.items` that fail `parseExpr` ⇒ `expr_parse_error` with the parser offset; template parse failures ⇒ `template_parse_error` with `pointer`. Paths under `steps.<id>` may only continue with `output` or `status` (`unknown_root` otherwise). Whole-document bounds (quorum risk 3; checked first, and the remaining checks are skipped when one trips): UTF-8 byte length of `JSON.stringify(doc)` (via `TextEncoder`, browser-safe) > `maxDocumentBytes` ⇒ `document_too_large`; any step `input` nested deeper than `maxInputDepth` ⇒ `input_too_deep`; more than `maxTemplates` templates across the document ⇒ `too_many_templates`. The API validator also applies the byte check to the raw tool input before Zod parsing so an oversized document never reaches the schema.

- [ ] **Step 1: Failing tests**: exact template keeps a number type; interpolated template stringifies; nested objects/arrays render recursively; missing path renders `null`/`''`; 300 KB render fails `render_too_large`; a 300 KB document ⇒ only `document_too_large`; a step input nested 17 deep ⇒ `input_too_deep`; 501 templates ⇒ `too_many_templates`; `templatedPointers({ a: ['{{x}}', 'y'] })` equals `Set{'/a/0'}`; structure: the spec example passes with zero issues; a step referencing a later step ⇒ `forward_reference`; `item.x` outside forEach ⇒ `item_outside_foreach`; `inputs.board` undeclared ⇒ `undeclared_input`; `steps.a.result` ⇒ `unknown_root`; duplicate ids ⇒ one `duplicate_step_id` per duplicate. Run → FAIL.
- [ ] **Step 2: Implement. Step 3: Run** `npx vitest run src/flows/templates.test.ts src/flows/structure.test.ts src/browserSafeBarrel.test.ts` → PASS. **Step 4: Commit** — `git commit -m "feat(shared): flow templates renderer and structural rule checks (#5218)"`

### Task A4: Migration + Drizzle schema

**Files:**
- Create: `apps/api/migrations/2026-12-31-120000-flows.sql`, `apps/api/src/db/schema/flows.ts`, `apps/api/src/db/schema/flows.test.ts`
- Modify: `apps/api/src/db/schema/index.ts`

**Interfaces (Produces):** Drizzle `flows` table with camelCase columns `id, orgId, partnerId, slug, name, description, definition, definitionVersion, effectiveTier, status, pausedReason, enabledByUserId, enabledAt, createdByUserId, aiSessionId, managedByAgentId, createdAt, updatedAt`.

- [ ] **Step 1: Failing schema test** — `getTableName(flows) === 'flows'`, every column above present, and **no** `webhookSecretEncrypted` column (Decision 4). Run `cd apps/api && npx vitest run src/db/schema/flows.test.ts` → FAIL.
- [ ] **Step 2: Write the migration**, modelled on `migrations/2026-10-16-193500-tool-sources.sql` §4 (RLS):
  - Table: `id uuid pk default gen_random_uuid()`; `org_id uuid REFERENCES organizations(id) ON DELETE CASCADE`; `partner_id uuid REFERENCES partners(id) ON DELETE CASCADE`; `slug varchar(48) NOT NULL`; `name varchar(120) NOT NULL`; `description text`; `definition jsonb NOT NULL`; `definition_version integer NOT NULL DEFAULT 1`; `effective_tier smallint NOT NULL`; `status text NOT NULL DEFAULT 'draft'`; `paused_reason text`; `enabled_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL`; `enabled_at timestamptz`; `created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL`; `ai_session_id uuid REFERENCES ai_sessions(id) ON DELETE SET NULL` (precedent `db/schema/scripts.ts:317`: erasing a session nulls provenance instead of blocking; populated only from the authenticated chat context, never from tool input); `managed_by_agent_id uuid REFERENCES ai_agents(id) ON DELETE SET NULL`; `created_at`/`updated_at timestamptz NOT NULL DEFAULT now()`.
  - Guarded CHECKs: `flows_one_owner_chk ((org_id IS NULL) <> (partner_id IS NULL))`; `flows_slug_chk (slug ~ '^[a-z][a-z0-9_]{1,47}$' AND position('__' in slug) = 0)`; `flows_status_chk (status IN ('draft','enabled','paused','disabled'))`; `flows_paused_reason_chk ((status = 'paused') = (paused_reason IS NOT NULL))`; `flows_effective_tier_chk (effective_tier BETWEEN 1 AND 3)`; `flows_definition_version_chk (definition_version >= 1)`; `flows_definition_object_chk (jsonb_typeof(definition) = 'object')`.
  - Indexes: `flows_org_slug_uq UNIQUE (org_id, slug) WHERE org_id IS NOT NULL`; `flows_partner_slug_uq UNIQUE (partner_id, slug) WHERE org_id IS NULL`; `flows_org_status_idx (org_id, status)`; `flows_partner_wide_idx (partner_id) WHERE org_id IS NULL`.
  - RLS: `ENABLE` + `FORCE`; `flows_isolation` FOR ALL USING/WITH CHECK `breeze_current_scope() = 'system' OR (org_id IS NOT NULL AND breeze_has_org_access(org_id)) OR (partner_id IS NOT NULL AND breeze_has_partner_access(partner_id))`; `flows_partner_wide_select` FOR SELECT USING `(org_id IS NULL AND partner_id = public.breeze_current_partner_id())`; `GRANT SELECT, INSERT, UPDATE, DELETE ON flows TO breeze_app`.
  - No DML. Status is `text` + CHECK (not a pg enum) so W04/W05 widen it with a guarded CHECK swap instead of `ALTER TYPE … ADD VALUE`.
- [ ] **Step 3: Write `db/schema/flows.ts`** in the `toolSources.ts` style (partial unique indexes via the `(table) => ({ … })` form; XOR CHECK documented in a comment, enforced in SQL); export from `db/schema/index.ts`.
- [ ] **Step 4: Run** the schema test → PASS; `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/services/migrationRlsScope.test.ts` → PASS; on the wt-stack `pnpm db:migrate` twice (idempotency) then `pnpm db:check-drift` → clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): flows table with dual-axis RLS and partner-wide read (#5218)"`

### Task A5: Cascade, export, org-merge, RLS-coverage registrations

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts`, `apps/api/src/services/orgMergeRegistry.ts`, `apps/api/src/services/orgMergeCustomExecutors.ts`, `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Test: `apps/api/src/services/orgMergeExecutors.test.ts` (extend), the four contract suites (integration).

- [ ] **Step 1: Failing unit tests** in `orgMergeExecutors.test.ts`, following the existing `tool_sources` custom-executor case (`mergeToolSources`, `orgMergeCustomExecutors.ts` ~L1753):
  - loser org flow `disk_cleanup`, survivor org flow `disk_cleanup` ⇒ the loser's row is repointed as `disk_cleanup_m1`; a survivor that already has `disk_cleanup_m1` too ⇒ `disk_cleanup_m2` (retry until free); a 48-char base is cut so the result is ≤ 48, trailing `_` stripped before `_m<n>`, never containing `__`; a non-colliding loser flow is repointed unchanged; no row deleted; partner-wide rows untouched.
  - **reference rewrite (quorum risk 1):** loser source `hudu` collides and `mergeToolSources` renames it (`left(slug,20) || 'm' || <3 hex of loser id>`); a loser flow whose step `tool` is `hudu__get_asset` ends with that step reading `<renamed>__get_asset` and `definition_version` + 1; a step naming a partner-wide or non-colliding source is unchanged. Without this the moved draft would silently resolve to the survivor's different integration.
  Run → FAIL.
- [ ] **Step 2: Red the contract suites first** — with the migration applied and no registry edit, run `rls-coverage`, `tenantCascade`, `tenant-export-policy` integration files and record the `flows` failures (this is the evidence the PR body cites).
- [ ] **Step 3: Register**
  - `tenantCascade.ts`: `'flows',` between `'fleet_remediation_runs'` and `'google_workspace_connections'`; then confirm the FK-derived order check (`tenantCascade.ts` ~L1421) accepts it — `flows` references `ai_sessions` and `ai_agents` with `ON DELETE SET NULL`, so it imposes no parent-before-child constraint, but verify rather than assume (quorum P1).
  - `tenantExportPolicyRegistry.ts` (alphabetical): `"flows": tablePolicy("org_id", {"included":["id","org_id","partner_id","slug","name","description","definition_version","effective_tier","status","paused_reason","enabled_by_user_id","enabled_at","created_by_user_id","ai_session_id","managed_by_agent_id","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["definition"]})`.
  - `orgMergeRegistry.ts`: `flows: { kind: 'custom', note: 'repoint org_id; a loser flow whose slug collides with a survivor flow is renamed <slug>_m<n> first so no flow is silently dropped (flows_org_slug_uq); moved flows that name a renamed loser tool source have their step tool references rewritten' }`; implement `mergeFlows` in `orgMergeCustomExecutors.ts` beside `mergeToolSources`. The rename map comes from `mergeToolSources` itself: change its rename `UPDATE` to `RETURNING` the old and new slug, and in the same executor rewrite the loser org's `flows.definition` step `tool` prefixes (`<old>__` → `<new>__`, string-prefix match on the first `__` only) in TypeScript, bumping `definition_version`, before the repoint — so the rewrite cannot depend on executor ordering.
  - `rls-coverage.integration.test.ts`: `'flows'` in `DUAL_AXIS_TENANT_TABLES` and `XOR_OWNERSHIP_DUAL_AXIS_TABLES`, comment citing the migration file and `flowsPartnerRls.integration.test.ts`.
- [ ] **Step 4: Run** `npx vitest run src/services/orgMergeExecutors.test.ts src/services/tenantCascade.test.ts` → PASS; integration: `rls-coverage.integration.test.ts`, `tenantCascade.integration.test.ts`, `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`, the org-merge integration suite → PASS, each reporting > 0 tests.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): register flows in cascade, export policy, org merge, RLS coverage (#5218)"`

### Task A6: `FLOWS_ENABLED` flag

**Files:**
- Modify: `apps/api/src/config/env.ts`, `apps/api/src/config/validate.ts`, `apps/api/src/config/validate.test.ts`, `apps/api/src/routes/config.ts`, `apps/api/src/routes/config.test.ts`, `docker-compose.yml`, `deploy/docker-compose.prod.yml`, `.env.example`, `deploy/.env.example`

**Interfaces (Produces):** `export function flowsEnabled(): boolean` (`envFlag('FLOWS_ENABLED', false)`, read at call time); `/api/v1/config` → `features.flows: boolean`.

- [ ] **Step 1: Failing tests**: `config.test.ts` — `features.flows` is `false` by default and `true` with `FLOWS_ENABLED=true`; `validate.test.ts` — `FLOWS_ENABLED=maybe` is rejected with the same message shape as `TOOL_SOURCES_ENABLED`. Run → FAIL.
- [ ] **Step 2: Implement** mirroring every `TOOL_SOURCES_ENABLED` site listed in Global Constraints (`${FLOWS_ENABLED:-false}` in both compose files; `FLOWS_ENABLED=false` with a one-line comment in both `.env.example` files). Run `scripts/security/check-supply-chain-hardening.sh` is unaffected; `composeBindMounts.test.ts` unaffected (no mounts).
- [ ] **Step 3: Run → PASS. Step 4: Commit** — `git commit -m "feat(api): FLOWS_ENABLED kill switch and /config feature bit (#5218)"`

### Task A7: Owner catalog + catalog-aware validator

**Files:**
- Create: `apps/api/src/services/flows/catalog.ts`, `catalog.test.ts`, `apps/api/src/services/flows/owner.ts`, `owner.test.ts`, `apps/api/src/services/flowValidator.ts`, `flowValidator.test.ts`
- Modify: `apps/api/src/services/toolSources/resolver.ts` (+ `resolver.test.ts`), `apps/api/src/services/aiGuardrails.ts`, `apps/api/src/services/automationReferenceAuthorization.ts`
- Test (contract): `apps/api/src/services/flows/builtinNames.contract.test.ts`, `apps/api/src/services/flows/referenceFields.contract.test.ts`, `apps/api/src/services/aiGuardrails.tierDecidingKeys.contract.test.ts`

**Interfaces:**
- Consumes: Tasks A1–A3 shared modules; `resolveTenantTools` internals (`buildResolveTenantToolsQuery`, owner predicate) in `resolver.ts`; `listAgentReachableTools()` (`services/aiAgents/agentToolCatalog.ts:451`); `toolInputSchemas` (`services/aiToolSchemas.ts:188`); `checkGuardrails`, `resolveActionForTool`, `TOOL_ACTION_INPUT_KEYS`, `TIER3_INPUT_AWARE_TOOLS` (`services/aiGuardrails.ts`); `aiTools` map for `deviceArgs`; `EVENT_TYPES` (`services/eventBus.ts:596`).
- Produces:
```ts
// resolver.ts (additive; W1 behaviour unchanged)
export interface ToolOwnerRef { orgId: string | null; partnerId: string }
export async function resolveTenantToolsForOwner(owner: ToolOwnerRef): Promise<TenantToolDescriptor[]>;
//   [] when TOOL_SOURCES_ENABLED is off. Org owner: the org's enabled tools + partner-wide tools of the org's
//   partner re-derived live from organizations (never trusting owner.partnerId). Partner owner: partner-wide only.
export function compileTenantInputSchema(schema: Record<string, unknown>): ValidateFunction | null;  // the existing Ajv options; null when uncompilable
// aiGuardrails.ts
export const TIER_DECIDING_INPUT_KEYS: Readonly<Record<string, readonly string[]>>;
//   every non-action input isInputAwareTier3 / TIER3_INPUT_AWARE_TOOLS reads, e.g. manage_tickets: ['isPublic'],
//   manage_policy_feature_link: ['featureType', 'inlineSettings'], s1_isolate_device: ['isolate'].
//   The implementer reads each branch and lists the field it keys on.
export function tierDecidingInputKeys(toolName: string): string[];
//   = [TOOL_ACTION_INPUT_KEYS[name] ?? 'action', ...(TIER_DECIDING_INPUT_KEYS[name] ?? []),
//      ...(LIVE_READ_INPUT_FLAGS[name] ? [LIVE_READ_INPUT_FLAGS[name]] : [])]   (aiLiveDeviceReads.ts:17)
// automationReferenceAuthorization.ts
export function scriptOwnershipCondition(owner: AutomationReferenceOwner): SQL;   // now exported, body unchanged
// flows/catalog.ts
export type FlowCatalogEntry =
  | { source: 'core'; name: string; deviceArgs: readonly string[] }
  | { source: 'tenant'; name: string; descriptor: TenantToolDescriptor; validate: ValidateFunction }
  | { source: 'builtin'; name: FlowBuiltinName };
export const FLOW_EXCLUDED_CORE_TOOLS: ReadonlySet<string>;   // draft_flow, validate_flow, get_flow, list_flows
export async function loadFlowCatalog(owner: ToolOwnerRef): Promise<Map<string, FlowCatalogEntry>>;
//   core = listAgentReachableTools() minus FLOW_EXCLUDED_CORE_TOOLS — the flow principal is agent-like (spec §6.5 D4):
//   human-only, secret-bearing, session-only (M365/Google), denied-read and blocked tools are not flow-eligible.
export const FLOW_OWNED_REFERENCE_FIELDS: Readonly<Record<string, Readonly<Record<string, 'script' | 'device_group'>>>>;
//   = { run_script: { scriptId: 'script', groupId: 'device_group' } } at authoring. No core tool input on main names a
//   software-catalog or notification-channel id (the billing `catalogItemId` fields are a different table), so those
//   arrive with `notify` (W04) and the deploy step (W06). Pinned by the snapshot test in Step 1.
// flows/owner.ts
export async function resolveFlowOwnerForCaller(auth: AuthContext,
  req: { ownerScope?: 'organization' | 'partner'; orgId?: string }, mode: 'read' | 'write'): Promise<{ owner: ToolOwnerRef } | { error: string }>;
//   Authorizes the REAL caller before any system-scoped catalog read (quorum P2.5). organization: resolveWritableToolOrgId
//   (write) or auth.canAccessOrg (read), partnerId read from organizations. partner: auth.scope === 'partner' and
//   auth.partnerId; write additionally canManagePartnerWidePolicies(auth). system scope must name the owner explicitly.
// flowValidator.ts
export interface FlowValidationContext { owner: ToolOwnerRef }   // only ever produced by resolveFlowOwnerForCaller or a stored row
export async function validateFlowDocument(doc: unknown, ctx: FlowValidationContext): Promise<FlowValidationResult & { document?: FlowDocumentV1 }>;
```

Validator algorithm (order fixed; every issue carries `stepId` and a JSON pointer where applicable):
1. `flowDocumentV1Schema.safeParse(doc)` — failures ⇒ one `schema` issue per Zod issue; stop.
2. `checkFlowStructure(doc)`.
3. Trigger: `webhook` ⇒ `trigger_not_available` (W05); `event` with `event ∉ Object.values(EVENT_TYPES)` ⇒ `event_unknown`; `event` when `eventDispatchMode() === 'off'` ⇒ warning `trigger_not_available` ("event delivery is off on this deployment; enabling will be refused"); `schedule.timezone` not accepted by `new Intl.DateTimeFormat('en-US', { timeZone })` ⇒ `schema`.
4. Per step, resolve `tool` in `loadFlowCatalog(owner)`: built-in ⇒ schema check with `FLOW_BUILTIN_STEPS[name].inputSchema`; a `FLOW_LATER_BUILTINS` name ⇒ `builtin_not_available`; a registered core tool that is not flow-eligible (see `loadFlowCatalog`) ⇒ `tool_not_allowed`; anything else missing ⇒ `tool_not_found` (same text for "not enabled", "other tenant's", and "nonexistent"). `run_script` with a `proposalId` key ⇒ `input_not_supported` (proposal-backed runs need a chat session's reviewed proposal context, `aiGuardrails.ts` ~L2072; flows reference library scripts only).
5. Rule 2 — **template-aware partial validation** (quorum P2.3). Core ⇒ `toolInputSchemas[name].safeParse(input)`; tenant ⇒ `entry.validate(input)` from `compileTenantInputSchema` (Ajv `allErrors`, so errors carry `instancePath` + `keyword`; the descriptor's flattened `validate` string is not used). An issue is **masked** only when (a) its path (Zod `issue.path` as a JSON Pointer; Ajv `instancePath`) equals or descends from a pointer in `templatedPointers(input)`, **and** (b) it is a value-level issue: Zod 4 codes `invalid_type`, `invalid_format`, `invalid_value`, `invalid_union`, `too_small`, `too_big`, `not_multiple_of` (a missing required key is `invalid_type` at a path that cannot be templated, so condition (a) already keeps it); Ajv keywords `type`, `format`, `pattern`, `enum`, `const`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `multipleOf`, `anyOf`, `oneOf`. Never masked: Zod `custom` (refinements such as `run_script`'s exactly-one-of rules), `unrecognized_keys`, a missing required key; Ajv `required`, `additionalProperties`, `dependentRequired`, `propertyNames`, `minProperties`, `maxProperties`, `not`. Unmasked ⇒ `input_invalid`. Masked checks are re-run on the rendered input at run time (W04).
6. Rule 5. Core ⇒ every key in `tierDecidingInputKeys(name)` present in `input` must be **literal as a whole subtree** (no `{{` anywhere under it — `inlineSettings` is an object), else `action_not_literal` (the action key) / `tier_input_not_literal`; then `checkGuardrails(name, inputWithTemplatedLeavesRemoved)`: `allowed === false` or tier 4 ⇒ `tool_blocked`; step tier = `.tier`, approval scope = `.approvalScope`. Tenant ⇒ `guardrailCheckForTenantTool(entry.descriptor)` (`services/toolSources/guardrails.ts` — `checkGuardrails` returns tier 4 for any non-registry name, `aiGuardrails.ts` ~L2062). Built-in ⇒ 1. `effectiveTier` = max step tier (`null` when any step is unresolved).
7. Rule 4 (Decision 3): any `approval: 'pre_approved'` ⇒ `pre_approval_not_available` (error), message "Pre-approval is set on the Flows page when the flow is enabled."
8. Rule 6 — ownership references, independent of approval mode. Collect literal values (string or string[] leaves without `{{`) of `FLOW_OWNED_REFERENCE_FIELDS[name]` and of the tool's `deviceArgs`. Scripts: one system-context query `scripts.id IN (…) AND scriptOwnershipCondition(owner)`. Device groups: org owner ⇒ `device_groups.id IN (…) AND org_id = owner.orgId`; partner owner ⇒ any literal group id ⇒ `device_in_partner_flow`. Devices: partner owner ⇒ any literal device id ⇒ `device_in_partner_flow`; org owner ⇒ `devices.id IN (…) AND devices.org_id = owner.orgId`. Any id not returned ⇒ `reference_not_owned` / `device_not_owned`. Messages never distinguish foreign from nonexistent (no existence oracle). Templated values are checked at run time (W04).
9. `valid = issues.every(i => i.severity !== 'error')`.

All DB reads in steps 4 and 8 run via `runOutsideDbContext(() => withSystemDbAccessContext(…))` with explicit owner predicates — the validator is called from inside request/chat contexts whose RLS may not see partner-wide tool sources (W1 amendment 3).

- [ ] **Step 1: Failing tests**
  - `resolver.test.ts`: `resolveTenantToolsForOwner({ orgId: A, partnerId: P })` returns org A's tools + P's partner-wide tools and **ignores** a forged `partnerId` (re-derived); partner owner gets partner-wide only; flag off ⇒ `[]`.
  - `catalog.test.ts`: built-ins present as `builtin`; `manage_ai_agents` (agent human-only) absent; a session-only M365 helpdesk tool absent; `draft_flow` absent; a registered reachable core tool present with its `deviceArgs`.
  - `builtinNames.contract.test.ts`: `[...Object.keys(FLOW_BUILTIN_STEPS), ...FLOW_LATER_BUILTINS]` ∩ `aiTools.keys()` = ∅.
  - `aiGuardrails.tierDecidingKeys.contract.test.ts`: every name in `TIER3_INPUT_AWARE_TOOLS`, plus `manage_tickets` and `manage_policy_feature_link`, has a `TIER_DECIDING_INPUT_KEYS` entry; every `LIVE_READ_INPUT_FLAGS` tool's flag is in `tierDecidingInputKeys(name)`.
  - `flows/referenceFields.contract.test.ts`: for every flow-eligible core tool, list the top-level input keys whose Zod type is a uuid or uuid array and that are in neither `deviceArgs` nor `FLOW_OWNED_REFERENCE_FIELDS`; pin that list as an inline snapshot (shrink-only, like `FROZEN_GAPS`) so a new id-typed field forces a classification decision.
  - `owner.test.ts` (`flows/owner.ts`): an org user naming another org ⇒ error; a partner user with `partnerOrgAccess: 'selected'` asking for a partner owner in `write` mode ⇒ `PARTNER_WIDE_WRITE_DENIED_MESSAGE`, in `read` mode ⇒ allowed; an org user asking for `ownerScope: 'partner'` ⇒ error. No resolver/DB call happens on any error path (assert the mocks were not called).
  - `flowValidator.test.ts` (resolver and DB mocked at the module boundary, `vi.mock('./toolSources/resolver')`, `vi.mock('../db')` per `breeze-testing`):
    - `templated leaves are unknown, missing required keys still fail` — `run_script { deviceIds: ['{{trigger.device.id}}'] }` without `scriptId` reports the exactly-one-of refinement but no uuid issue at `/deviceIds/0`.
    - `refinement issues are never masked` — `run_script { scriptId: '{{inputs.s}}', proposalId: '<uuid>', deviceIds: [...] }` keeps the exactly-one-of issue (and `input_not_supported` for `proposalId`); an unknown key next to a templated leaf keeps `unrecognized_keys`; a tenant tool whose Ajv `required` key is missing keeps the issue while a templated `format: uuid` leaf is masked.
    - `unknown tool and disabled tenant tool give the same tool_not_found text`.
    - `manage_ai_agents is tool_not_allowed`; `notify is builtin_not_available`; `webhook trigger is trigger_not_available`; `unknown event is event_unknown`.
    - `templated action selector is action_not_literal` (`execute_command { commandType: '{{inputs.kind}}' }`); `templated live-read flag is tier_input_not_literal` (`analyze_disk_usage { refresh: '{{inputs.r}}' }`); `inlineSettings with one templated nested leaf is tier_input_not_literal`.
    - `tenant tier comes from the tenant adapter` — a tier-3 tenant tool yields step tier 3, never `tool_blocked`.
    - `effective tier is the max step tier` (a tier-1 read + a tier-3 core step ⇒ 3); `any pre_approved is pre_approval_not_available`.
    - `partner flow refuses org script`; `foreign and missing script ids give the same issue`; `literal device in partner flow is refused`; `literal groupId in partner flow is refused`; `org flow with another org's device is device_not_owned`.
    - `the spec §6.1 example validates` (with `halo__create_ticket` mocked as an enabled tier-3 tenant tool, `get_device_metrics` replaced by a registered reachable read, and `approval: 'pre_approved'` removed) ⇒ `valid: true`, `effectiveTier: 3`.
  Run each file → FAIL.
- [ ] **Step 2: Implement** in the order: resolver exports, guardrails constant + `tierDecidingInputKeys`, `scriptOwnershipCondition` export, `owner.ts`, catalog, validator.
- [ ] **Step 3: Run** all eight files + `src/services/toolSources/resolver.test.ts` + `src/services/aiGuardrails.agentPrincipal.contract.test.ts` → PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(api): catalog-aware flow validator against the owner's catalog (#5218)"`

### Task A8: Flows service

**Files:**
- Create: `apps/api/src/services/flows/service.ts`, `service.test.ts`

**Interfaces:**
- Consumes: `validateFlowDocument`, `ToolOwnerRef` (Task A7); `flows` (Task A4); `resolveWritableToolOrgId` (`services/aiToolWriteOrg.ts:34`); `canManagePartnerWidePolicies`, `PARTNER_WIDE_WRITE_DENIED_MESSAGE` (`services/partnerWideAccess.ts`); `slugifyFlowName`, `isValidFlowSlug`.
- Produces:
```ts
export interface SaveDraftFlowInput { document: unknown; flowId?: string; expectedVersion?: number; ownerScope?: 'organization' | 'partner'; orgId?: string; slug?: string; aiSessionId?: string | null }
export type SaveDraftFlowResult =
  | { saved: true; flow: FlowDetailDto; validation: FlowValidationResult }
  | { saved: false; error?: string; validation?: FlowValidationResult };
export async function saveDraftFlow(auth: AuthContext, input: SaveDraftFlowInput): Promise<SaveDraftFlowResult>;
export interface ListFlowsFilter { orgId?: string; status?: FlowStatus; limit?: number; offset?: number }
export async function listFlows(auth: AuthContext, f: ListFlowsFilter): Promise<{ flows: FlowSummaryDto[]; total: number }>;
export async function getFlow(auth: AuthContext, flowId: string): Promise<{ flow: FlowDetailDto; validation: FlowValidationResult } | null>;
```
Rules: runs in the caller's DB context (RLS enforces reach; no system context for writes). Owner on create: `resolveFlowOwnerForCaller(auth, input, 'write')` (Task A7) — partner owner requires `canManagePartnerWidePolicies(auth)` (name it in this file too, for `partner-wide-write-coverage.test.ts`), org owner goes through `resolveWritableToolOrgId`. Validate against that owner; any error-severity issue ⇒ `{ saved:false, validation }`, nothing written (quorum-agreed: invalid drafts are not stored; `get_flow` re-validates live). Slug: `input.slug ?? slugifyFlowName(doc.name)`, must pass `isValidFlowSlug`. **Shadow rule in both directions** (quorum P1; W05 resolves `flow__<slug>` and an org must never shadow — or be shadowed by — its partner's flow): an org slug may not equal any partner-wide flow slug of its partner, and a partner-wide slug may not equal any org flow slug under that partner. On create, any collision ⇒ suffix `_2`, `_3`, … (≤ 48, trailing `_` stripped first). Serialize the check-and-insert with `SELECT pg_advisory_xact_lock(hashtextextended('flows_slug:' || <partnerId>, 0))` inside the insert transaction (one lock per partner covers both directions); the cross-owner lookup runs in system context with explicit `partner_id` / `organizations.partner_id` predicates because org tokens cannot see sibling orgs' rows. W04's enable path and any future owner change must call the same helper (`assertFlowSlugAvailable(tx, owner, slug)`, exported). Update (`flowId`): row must be visible and writable in the caller's context (an org token's update of a partner-wide row matches 0 rows under FOR ALL ⇒ `{ saved:false, error:'flow_not_found' }`), `status === 'draft'` (else `flow_not_draft`), `expectedVersion` (when given) must equal `definition_version` (else `version_conflict`), validate against the row's owner, then `definition`, `name`, `description` from the document, `effective_tier`, `definition_version = definition_version + 1`, `updated_at = now()` in one `UPDATE … WHERE id = $1 AND definition_version = $2`. Provenance: `created_by_user_id = auth.user.id` (null for `principal !== 'user'` callers is not needed: draft is agent-denied), `ai_session_id = input.aiSessionId ?? null`. Audit: `writeAuditEvent(… action: 'flow.draft.save', resourceType: 'flow', resourceId, details: { definitionVersion, effectiveTier, stepCount, ownerScope } )` — never the definition.
`listFlows`: caller context; `orgId` filter ⇒ `org_id = :orgId OR (org_id IS NULL AND partner_id = <that org's partner>)`; ordered `updated_at desc`; `limit` default 50, max 100. `getFlow`: caller context row (else `null`), then `validateFlowDocument(row.definition, { owner })`.

- [ ] **Step 1: Failing tests** (`service.test.ts`, DB mocked): partner-wide create denied without `canManagePartnerWidePolicies`; org create uses `resolveWritableToolOrgId`'s org; invalid document ⇒ `saved:false` and **no insert called**; slug collision ⇒ `_2`; org slug equal to a partner-wide slug ⇒ suffixed; partner-wide slug equal to an existing org flow slug under the partner ⇒ suffixed; the advisory lock is taken before the collision lookup; update with stale `expectedVersion` ⇒ `version_conflict`; update of a non-draft ⇒ `flow_not_draft`; update matching 0 rows ⇒ `flow_not_found`; `get re-validates live` (validator mock returns a `tool_not_found` issue for a stored row ⇒ returned in `validation`); audit details contain no `definition` key. Run → FAIL.
- [ ] **Step 2: Implement. Step 3: Run** `service.test.ts` + `src/__tests__/partner-wide-write-coverage.test.ts` → PASS. **Step 4: Commit** — `git commit -m "feat(api): flows draft/list/get service (#5218)"`

### Task A9: Four core AI tools + registry contracts

**Files:**
- Create: `apps/api/src/services/aiToolsFlows.ts`, `apps/api/src/services/aiToolsFlows.test.ts`, `apps/api/src/services/aiToolEnvGates.ts`, `apps/api/src/routes/mcpServer.flowsGate.test.ts`
- Modify: `apps/api/src/routes/mcpServer.ts` (`tools/list` filter + `tools/call` refusal via `isToolEnvGatedOff`), `apps/api/src/services/aiTools.ts` (import + `registerFlowTools(aiTools)` after `registerTrustPageTools`), `apps/api/src/services/aiToolSchemas.ts`, `apps/api/src/services/aiGuardrails.ts` (`TOOL_PERMISSIONS`), `apps/api/src/services/aiAgentSdkTools.ts` (`TOOL_TIERS`, `flowToolDefinitions`, spread into `buildBreezeSdkTools`), `apps/api/src/services/aiToolExposure.ts` (`AGENT_HUMAN_ONLY_TOOLS` += `draft_flow`), `apps/api/src/services/aiAgents/agentToolCatalog.ts` (`TOOL_CAPABILITY`), `apps/api/src/services/aiGuardrails.agentPrincipal.contract.test.ts` (Tier-1 list += the three reads), `apps/api/src/services/aiAgents/agentToolCatalog.contract.test.ts` (pinned unreachable set += `draft_flow`), `apps/api/src/services/aiTools.descriptionBudget.contract.test.ts` (configurations + `gated` list), `apps/api/src/services/aiToolIndex.test.ts` (budget, Decision 5), `apps/web/src/components/ai-risk/tierConfig.ts` (tier list + permission map, as `get_trust_page_status` did), `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-baseline.md` (Decision 5 record)

**Interfaces:**
- Consumes: Task A8 service; Task A7 validator; `flowsEnabled()` (Task A6).
- Produces: `export function registerFlowTools(aiTools: Map<string, AiTool>): void`; `export const FLOW_TOOL_NAMES = ['draft_flow', 'validate_flow', 'get_flow', 'list_flows'] as const`; `export function flowToolDefinitions(getAuth, getActiveSession, onPreToolUse?, onPostToolUse?)` in `aiAgentSdkTools.ts` returning `[]` when `!flowsEnabled()` (same shape as `scriptProposalToolDefinitions`, `aiAgentSdkTools.ts:1154`), declarations as literal `tool('draft_flow', registryDescription('draft_flow'), inputShape('draft_flow'), makeHandler(…))` so the source-grep coverage test sees each name.

| tool | tier | domain | permission (`TOOL_PERMISSIONS`) | capability | input (`toolInputSchemas`) | output (JSON string) |
|---|---|---|---|---|---|---|
| `draft_flow` | 2 | `scripts` | `{ resource: 'automations', action: 'write' }` | `automations_reports` | `{ document: flowDocumentV1Schema, flowId?: uuid, expectedVersion?: int ≥ 1, ownerScope?: 'organization'\|'partner', orgId?: uuid, slug?: string }` | `SaveDraftFlowResult` + `reviewPath: '/flows/<id>'` when saved |
| `validate_flow` | 1 | `scripts` | `automations.read` | `automations_reports` | `{ document: z.record(z.string(), z.unknown()), ownerScope?, orgId? }` | `FlowValidationResult` |
| `get_flow` | 1 | `scripts` | `automations.read` | `automations_reports` | `{ flowId: uuid }` | `{ flow, validation }` or `{ error: 'flow_not_found' }` |
| `list_flows` | 1 | `scripts` | `automations.read` | `automations_reports` | `{ orgId?: uuid, status?: FlowStatus, limit?: 1..100 }` | `{ flows, total }` |

`validate_flow` takes the document as an open record so a structurally broken document still reaches the validator and returns issues instead of a chat-level Zod rejection; it resolves its owner with `resolveFlowOwnerForCaller(auth, input, 'read')` before validating, so it can never be used as an oracle over another tenant's tools, scripts, or devices. Handlers: `if (!flowsEnabled()) return JSON.stringify({ error: 'flows_disabled' })` first; `draft_flow` passes `aiSessionId` from the authenticated tool execution context only (never from input).

MCP gate (quorum P3): create `apps/api/src/services/aiToolEnvGates.ts` (leaf module) exporting `isToolEnvGatedOff(name: string): boolean` — true for `FLOW_TOOL_NAMES` when `!flowsEnabled()`. In `routes/mcpServer.ts`, filter it out of `tools/list` and answer `tools/call` for a gated-off name exactly as for an unknown tool (same error, no existence oracle). With the flag off the unrestricted `tools/list` is byte-identical to today (PR #9135 pins a golden of it — rebase onto it if it lands first and keep that golden green). `searchHint` ≤ `AI_TOOL_SEARCH_HINT_MAX_CHARS`, one line, no tool names; descriptions ≤ 300 chars, parameter descriptions ≤ 160, no JSON examples or "first call / then call" prose (`aiTools.descriptionBudget.contract.test.ts` `WORKFLOW_PROSE`). `draft_flow`'s description says, in prose, that the document is validated against the caller's enabled tools, that invalid documents are not saved, and that the tech reviews it on the Flows page. No `alwaysLoad`. `deviceArgs: []` on all four (the document's device ids are validated by the validator, not by `mcpExecutionOrg`).

- [ ] **Step 1: Failing tests**
  - `routes/mcpServer.flowsGate.test.ts` (copy the harness of an existing `mcpServer.*.test.ts`): flag off ⇒ `tools/list` omits the four names and `tools/call draft_flow` returns the unknown-tool error; flag on ⇒ listed.
  - `aiToolsFlows.test.ts`: each handler returns `flows_disabled` with the flag off; `validate_flow` naming an inaccessible org returns the owner error and never calls the validator; `draft_flow` maps service results (saved / validation failure / partner-wide denial) to output JSON with `reviewPath`; `get_flow` of an invisible id ⇒ `flow_not_found`; `validate_flow` on `{ steps: 'x' }` returns `schema` issues rather than throwing.
  - Run the existing contract suites **before** wiring and record which fail once `registerFlowTools` alone is added (expected: `aiToolsRegistryParity.test.ts`, `aiTools.domainMetadata.contract.test.ts`, `agentToolCatalog.contract.test.ts`, `aiGuardrails.agentPrincipal.contract.test.ts`, `aiAgentSdkTools.mcpCoverage.test.ts`, `aiAgentSdkTools.registryParity.contract.test.ts`, `aiToolIndex.test.ts` env-gating test). That red list is the checklist for Step 2.
  - `aiToolIndex.test.ts`: new assertion `with FLOWS_ENABLED=true the index stays under the ceiling` (set the env in the test, re-render via `listChatSurfaceToolNames()`); with Decision 5(c) the ceiling constant becomes `6.75 * 1024` and the comment records "Tool Catalog W3 (#5218): +49 B flag-on, 0 B default; prompt-size review in the efficiency baseline doc".
  - `aiTools.descriptionBudget.contract.test.ts`: add `FLOWS_ENABLED` to each `configurations` entry (`'false'`, `'true'`, `'false'`) and the four names to `gated`.
- [ ] **Step 2: Implement** the tool file and every seam in **Files** until the red list is green.
- [ ] **Step 3: Run** `npx vitest run src/services/aiToolsFlows.test.ts src/services/aiToolsRegistryParity.test.ts src/services/aiTools.domainMetadata.contract.test.ts src/services/aiTools.descriptionBudget.contract.test.ts src/services/aiToolIndex.test.ts src/services/aiAgentSdkTools.mcpCoverage.test.ts src/services/aiAgentSdkTools.registryParity.contract.test.ts src/services/aiAgentSdkTools.handlerCoverage.contract.test.ts src/services/aiAgents/agentToolCatalog.contract.test.ts src/services/aiGuardrails.agentPrincipal.contract.test.ts src/services/aiTools.deviceWaitContext.contract.test.ts` (batches of 3–4 on a loaded host) → PASS; `cd apps/web && npx vitest run src/components/ai-risk` → PASS (tierConfig parity).
- [ ] **Step 4: Commit** — `git commit -m "feat(api): draft/validate/get/list flow AI tools behind FLOWS_ENABLED (#5218)"`

### Task A10: Read routes `/api/v1/flows`

**Files:**
- Create: `apps/api/src/routes/flows.ts`, `apps/api/src/routes/flows.test.ts`
- Modify: `apps/api/src/index.ts` (`api.route('/flows', flowsRoutes)` beside the tool-sources mount), `apps/api/src/services/mcpCoverage.ts`

**Interfaces:** `export const flowsRoutes: Hono`. `GET /` (query `orgId?`, `status?`, `limit?`, `offset?` via `zValidator`) → `listFlows`; `GET /:id` → `getFlow` or 404. Middleware in order: flag 404 (`if (!flowsEnabled())`), `authMiddleware`, `requireScope('organization','partner','system')`, `requirePermission('automations','read')`, `withAuthDbAccessContext` (copy the `toolSources.ts` header, L54–61). `mcpCoverage.ts`: `'flows.ts': { tools: ['list_flows', 'get_flow'] }`.

- [ ] **Step 1: Failing route tests** (Drizzle/service mocked per `breeze-testing`): 404 with flag off; 403 without `automations.read`; list passes `orgId`/`status`; detail 404 for `null`; detail returns `validation`. `__tests__/mcp-coverage.test.ts` fails until the `mcpCoverage` entry exists. Run → FAIL.
- [ ] **Step 2: Implement. Step 3: Run** `npx vitest run src/routes/flows.test.ts src/__tests__/mcp-coverage.test.ts` → PASS. **Step 4: Commit** — `git commit -m "feat(api): read-only /api/v1/flows routes (#5218)"`

### Task A11: Integration RLS suite and PR A wrap-up

**Files:**
- Create: `apps/api/src/__tests__/integration/flowsPartnerRls.integration.test.ts`

- [ ] **Step 1: Write the suite** using `toolSourcesPartnerRls.integration.test.ts` setup verbatim (`partnerContext`, org-scope helper, `SYSTEM_CTX`). Cases: partner B inserting a row with partner A's `partner_id` ⇒ 42501; org B inserting with org A's `org_id` ⇒ 42501; both owners / neither owner ⇒ 23514; slug `a__b` ⇒ 23514; `status='paused'` without `paused_reason` ⇒ 23514; org token SELECTs its partner's partner-wide flow (1 row) but UPDATE of it affects 0 rows; org token never sees another partner's partner-wide flow; partner token sees its orgs' flows and its partner-wide flows; `saveDraftFlow` with an org auth on a partner-wide `flowId` ⇒ `flow_not_found` (real DB).
- [ ] **Step 2: Run on the wt-stack** — this file plus the five suites from Task A5 → PASS, each with > 0 tests; paste the forge output into the PR body.
- [ ] **Step 3: Full PR A checks** — API tsc (12 GB heap, read `exit=`), shared tsc, `pnpm lint` in `apps/api` and `packages/shared`, and every unit file touched in A1–A10 (batches).
- [ ] **Step 4: Open PR A** — title `feat(ai): Tool Catalog W03 PR A — flow document, validator, flows table, AI tools (#5218)`; body: summary, `Part of #5218`, spec + plan paths, tenancy table (new table, RLS, cascade, export, merge, registrations, red-first evidence), migration name, Decision outcomes, flag default off. One review round (`pr-review-toolkit:review-pr`, Sonnet reviewers; tenancy/RLS and the validator get Opus-level attention); fix confirmed findings; post the review summary.

---

## PR B — Web: Flows read UI and chat card

### Task B1: Feature bit, nav, route scope, locales

**Files:**
- Modify: `apps/web/src/stores/featuresStore.ts` (`Features.flows`, `DEFAULT_FEATURES.flows = false`, mapping, `useFlowsGate()` beside `useToolSourcesGate`), `apps/web/src/lib/navGates.ts` (`requiresFlows`, `NavGateContext.flowsEnabled`), `apps/web/src/components/layout/Sidebar.tsx` (primary nav, directly after Jobs: `{ name: 'Flows', labelKey: 'nav.flows', href: '/flows', icon: Workflow, requiresFlows: true, requiredPermission: { resource: 'automations', action: 'read' } }` — there is no "Automation" section; Jobs is automations' nav home, #5288), `apps/web/src/lib/routeScope.ts` (`{ pattern: /^\/flows(\/.*)?$/, kind: 'org-or-all' }` after the `/jobs` entry)
- Create: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/flows.json`; modify each locale's `common.json` (`nav.flows`) and `pages.json` (`titles.flows`, `titles.flowDetail`)
- Test: `apps/web/src/lib/navGates.test.ts`, `apps/web/src/components/layout/Sidebar.flows.test.tsx` (copy `Sidebar.toolSources.test.tsx`), `apps/web/src/lib/routeScope.test.ts`, `src/lib/i18n/localeParity.test.ts`, `src/lib/i18n/translationCoverage.test.ts`

`flows.json` keys (namespace `flows`): `title`, `subtitle`, `previewNotice` ("Flows are read-only in this release. Draft them in AI chat; enabling and runs arrive in a later release."), `empty.title`, `empty.body`, `list.name`, `list.owner`, `list.allOrgs`, `list.status`, `list.tier`, `list.trigger`, `list.updated`, `status.draft|enabled|paused|disabled`, `trigger.schedule|event|webhook|manual`, `detail.back`, `detail.trigger`, `detail.inputs`, `detail.steps`, `detail.version`, `detail.createdInChat`, `step.tool`, `step.tier`, `step.approval`, `step.approvalDefault`, `step.approvalPreApproved`, `step.when`, `step.forEach`, `step.onFailure`, `step.timeout`, `step.input`, `step.source.core|tenant|builtin`, `issues.title`, `issues.none`, `issues.error`, `issues.warning`, `card.title`, `card.review`, `card.steps`, `errors.loadFailed`, `errors.notFound`. Real translations in all 8 locales (not English copies — `translationCoverage.test.ts` counts identical strings); raise that file's per-namespace allowance only for reviewed cognates, with a comment.

- [ ] **Step 1: Failing tests**: Sidebar renders Flows after Jobs when `/config` reports `features.flows: true` and hides it on `false`; `isNavGateVisible({ requiresFlows: true }, { flowsEnabled: false, … })` is false; `routeScope.test.ts` fails for the new `.astro` files until the pattern exists; locale parity fails until all 8 `flows.json` exist. Run → FAIL.
- [ ] **Step 2: Implement. Step 3: Run** the five test files → PASS. **Step 4: Commit** — `git commit -m "feat(web): Flows feature gate, nav entry, route scope, locales (#5218)"`

### Task B2: Flows list and detail pages (read-only)

**Files:**
- Create: `apps/web/src/pages/flows/index.astro`, `apps/web/src/pages/flows/[id].astro` (shells like `pages/ai-agents/fix-memory.astro`; `titleKey="titles.flows"` / `"titles.flowDetail"`; detail passes `flowId={Astro.params.id}`)
- Create: `apps/web/src/components/flows/api.ts`, `FlowsPage.tsx`, `FlowDetailPage.tsx`, `FlowStepList.tsx`, `FlowIssuesPanel.tsx`, tests `FlowsPage.test.tsx`, `FlowDetailPage.test.tsx`

**Interfaces:** `api.ts`: `listFlows(params): Promise<{ flows: FlowSummaryDto[]; total: number }>`, `getFlow(id): Promise<{ flow: FlowDetailDto; validation: FlowValidationResult }>` over `fetchWithAuth` (GET only — no `runAction`; the page has no mutations). `FlowStepList({ steps, summaries }: { steps: FlowDocumentV1['steps']; summaries: FlowStepSummary[] })` is reused by the chat card (Task B3).

Behaviour: list in `ResponsiveTable` (name → `/flows/<id>`, owner badge "All orgs" for partner-wide via the existing `ScopeBadge`, status chip, tier badge, trigger type, updated), empty state, `previewNotice` banner, gate: `useFlowsGate()` not enabled ⇒ the not-found state. Detail: header (name, slug, status, version, owner), trigger panel (read-only summary: cron + timezone, event + filter pairs, manual inputs table), `FlowStepList` (ordered; per step id, tool with source label, tier badge, approval mode, `when`, `forEach`, `onFailure`, `timeoutSec`, collapsible `<pre>` input JSON), `FlowIssuesPanel` (errors then warnings, linked to their step anchors). Selected step in `window.location.hash` (`#step-<id>`), per the URL-state rule. `data-testid` prefix `flow-`. No edit, enable, or delete controls.

- [ ] **Step 1: Failing tests**: list renders rows and the "All orgs" badge for `ownerScope:'partner'`; empty state; detail renders steps in order with tier badges and a `tool_not_found` issue from `validation`; clicking a step sets `#step-<id>`; no element with role `button` named enable/delete exists. Run → FAIL.
- [ ] **Step 2: Implement. Step 3: Run** + `npx astro check` + `src/lib/__tests__/no-silent-mutations.test.ts` → PASS. **Step 4: Commit** — `git commit -m "feat(web): read-only Flows list and detail pages (#5218)"`

### Task B3: Chat Flow card

**Files:**
- Create: `apps/web/src/components/flows/FlowDraftCard.tsx`, `FlowDraftCard.test.tsx`
- Modify: `apps/web/src/components/ai/AiChatMessages.tsx` (branch before the default `AiToolCallCard` return, ~L383), `apps/web/src/components/ai/AiChatMessages.test.tsx`

Behaviour: for `msg.role === 'tool_result'` and `toolName ∈ { 'draft_flow', 'get_flow' }`, parse `output`; when it is a saved draft (`saved: true`) or a `get_flow` result with `flow`, render `FlowDraftCard` — name, trigger summary, `FlowStepList` in compact mode (tool + tier + approval), issue counts, and a "Review" link to `/flows/<id>` built only when `id` is a UUID (same guard as `scriptProposalHref`, L88). Anything else (validation failure, error, unparsable output) falls through to the default `AiToolCallCard`, so errors stay visible.

- [ ] **Step 1: Failing tests**: a `draft_flow` saved output renders the card with 3 steps and a `/flows/<uuid>` link; a non-UUID id renders no link; `saved:false` renders the default tool card; malformed JSON renders the default card. Run → FAIL.
- [ ] **Step 2: Implement. Step 3: Run** → PASS. **Step 4: Commit** — `git commit -m "feat(web): Flow card for draft_flow and get_flow results in AI chat (#5218)"`

### Task B4: PR B wrap-up and live check

- [ ] Run `cd apps/web && npx vitest run src/components/flows src/components/ai/AiChatMessages.test.tsx src/components/layout src/lib/navGates.test.ts src/lib/routeScope.test.ts src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts` (batches) && `npx astro check` && `pnpm lint`.
- [ ] Boot the wt-stack with `FLOWS_ENABLED=true` (and `TOOL_SOURCES_ENABLED=true` if a fake MCP source is available to the stack). In chat, ask for "a flow that runs every night at 2am and lists offline devices" and confirm: `draft_flow` saves, the Flow card renders, the Review link opens `/flows/<id>` with the steps and zero errors; edit the draft via chat (`flowId` + `expectedVersion`) and confirm the version bump; disable the tool source (if used) and confirm the detail page shows `tool_not_found`. Screenshots in the PR. Tear the stack down.
- [ ] Open PR B (title `feat(web): Tool Catalog W03 PR B — Flows read UI and chat card (#5218)`, body `Closes #5218`, stacked on PR A) → `gh workflow run CI --ref <branch>`; one review round; summary comment. Merge order A → B with bare `gh pr merge`.

---

## Exit checklist (wave done when every box is true)

- [ ] Migration `2026-12-31-120000-flows.sql` sorts last at merge time, re-runs cleanly, `pnpm db:check-drift` clean.
- [ ] `flows` in `DUAL_AXIS_TENANT_TABLES`, `XOR_OWNERSHIP_DUAL_AXIS_TABLES`, `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY` (every column), `orgMergeRegistry` — and the five contract suites passed against a real DB with red-first evidence in the PR.
- [ ] `flowsPartnerRls.integration.test.ts` green on the stack and in CI's Integration Tests job.
- [ ] Four tools registered with tier, `domain: 'scripts'`, `searchHint`, schema, permission, capability, agent exposure, `mcpCoverage` entry; all registry contract tests green; index budget handled per Decision 5 with the flag-on assertion.
- [ ] `FLOWS_ENABLED` default false everywhere (env, validate, compose ×2, `.env.example` ×2, `/config`, web gate).
- [ ] Shared modules browser-safe; grammar tests cover every operator, null semantics, prototype paths, and bounds.
- [ ] Web: nav after Jobs, `/flows` route scope, 8 translated locales, chat card, read-only pages; `astro check` clean.
- [ ] Spec amended (Task A0) with the adopted decisions and quorum row.
- [ ] `FLOWS_ENABLED=false` hides the tools from Breeze's MCP `tools/list` and refuses `tools/call` (not just from chat).
- [ ] Deferred to W04, handed to the orchestrator for #5219 (this wave does not comment on issues): rule 4 lane choice (`actAssets` vs policy-decidable effect pin) + effect binding + the pre-approval toggle, rule 7, event-dispatch prerequisite at enable, **runs must snapshot the definition** (or add `flow_versions`) because `flows.definition` is overwritten on save, runtime re-validation of masked (templated) inputs and ownership of templated script/group/device ids, `assertFlowSlugAvailable` on enable. Deferred to W05 (#5220): webhook columns + secret registry, `flow__<slug>` resolver registration (tier must be `max(recorded, recomputed)`).

## CI traps

- Contract suites (RLS coverage, cascade, export, erasure, org-merge) run only in the 16-shard **Integration Tests** job; "Test API" passing proves nothing about them.
- PR B is stacked ⇒ no automatic CI; dispatch `gh workflow run CI --ref <branch>` and wait for the run keyed on branch + head SHA (not `gh run list --commit`).
- `aiAgentSdkTools.mcpCoverage.test.ts` greps source for literal `tool('<name>'` — a `.map()` over `FLOW_TOOL_NAMES` silently empties the scan.
- `aiToolIndex.test.ts` and `aiTools.descriptionBudget.contract.test.ts` read env at call time; a test that sets `FLOWS_ENABLED` must restore it (`vi.stubEnv` + `vi.unstubAllEnvs`).
- `tsc` OOM under a pipe reads as green — always `echo "exit=$?"`.
- Locale parity lives in `src/lib/i18n/`, not `src/locales/`; translation coverage fails on untranslated English copies.
- `check-migration-naming.sh` runs pre-commit/pre-push; if `2026-12-31-120000` is taken by then, take the next free `HHMMSS` and say so in the PR.
- PR #9135 / #9106 both edit `tenantExportPolicyRegistry.ts` / `aiToolNames.ts`; rebase, don't merge-resolve by hand-picking sides.

## Self-review (done at authoring)

- **Spec coverage (W03 row + §6.1–6.4, §6.6, §6.8, §8, §9):** document (A1), built-ins (A1, Decision 2), grammar + renderer (A2, A3), rule 3 (A3), `flows` table + RLS + registrations (A4, A5, A11), validator rules 1/2/5/6 + rule-4 subset (A7, Decision 3), draft/validate/get/list tools (A9), service (A8), routes (A10), flag (A6), Flow card (B3), read-only Flows UI (B1, B2), naming (Decision 1, A0). Not in W03 by design: `flow_runs`/`flow_run_steps`/`action_intents` (W04), enable/pause and rules 4-binding/7 (W04), webhook columns and `flow__<slug>` registration (W05), `notify`/`ai`/`http_request` (W04/W05), `suggest_tools_to_enable` (later), docs page (W04, when a flow can run).
- **Placeholders:** none; the two implementer judgment points are named with their source (`TIER_DECIDING_INPUT_KEYS` — read each `isInputAwareTier3`/`TIER3_INPUT_AWARE_TOOLS` branch; translations — real text per locale).
- **Type consistency:** `FlowDocumentV1`, `FlowIssue`, `FlowValidationResult`, `FlowStepSummary`, `FlowSummaryDto`, `FlowDetailDto`, `ToolOwnerRef`, `resolveTenantToolsForOwner`, `compileTenantInputSchema`, `tierDecidingInputKeys`, `FLOW_OWNED_REFERENCE_FIELDS`, `loadFlowCatalog`, `resolveFlowOwnerForCaller`, `validateFlowDocument`, `saveDraftFlow`, `assertFlowSlugAvailable`, `listFlows`, `getFlow`, `registerFlowTools`, `flowToolDefinitions`, `FLOW_TOOL_NAMES`, `isToolEnvGatedOff`, `flowsEnabled`, `useFlowsGate` are used with the same names in every task.
- **Proportion:** the plan pins names, signatures, values, issue codes, and test assertions; bodies appear only for the migration DDL list and the validator's masking rule, which the signatures do not determine.
