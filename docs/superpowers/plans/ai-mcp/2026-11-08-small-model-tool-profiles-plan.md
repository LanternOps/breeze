---
tracking_issue: LanternOps/breeze#11393
wave_issues: W01 #11394 · W03 #11395 · W02 #11396 · W04 #11397 · W05 #11398
source_issues: "#9596, #11111, #9770"
spec: docs/superpowers/specs/ai-mcp/2026-11-06-small-model-tool-profiles-spec.md
covers: "#9596, #11111, #9770"
waves: W01 model record + resolver (dark) · W03 constrained prompt, compaction, provenance, measured prefixes · W02 context window (`auto` goes live) · W04 per-surface verify + refused-batch measurement · W05 drawer, locales, docs
depends_on: "W01 → W03 → W02 → W04 → W05. `auto` activation (W02) is gated on W03's compact prompt, measured PROFILE_PREFIX_TOKENS and ledger provenance. W05 consumes the W02 window DTO (T7) and the W04 readiness DTO (T11). Each wave is one PR off `main`, never stacked."
branch_pattern: feature/11393-small-model-tool-profiles/wave-<subissue#>
---
# Tool profiles and a constrained prompt for small-context models — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a partner can give a self-hosted model a small tool set and a short prompt (`minimal` / `standard` / `custom`), or let `auto` pick from a known context window; verify proves a real tool round-trip per surface; invalid tool-call batches are measured.

**Architecture:** one pure resolver (`aiModels/toolExposure.ts`) that only removes names, fed by seven new columns on `partner_ai_models`; three consumers (prompt index, `createBreezeMcpServer({ onlyTools })` + filtered `extraTools`, `query({ allowedTools })`) read the same finalized exposure, which is computed once per surface entry **before** the live-query key, the prompt, the registration and the gateway grant. The window is learned (discovery, observation) and overridden; the gateway caps `max_tokens` from it up front. Nothing touches authority: RBAC, approvals, guardrails, the Wisp gate and `guardrailPolicy.toolAllowlist` are unchanged.

**Verified against** `origin/main` `127bb8b543` (2026-11-08). Paths are under `apps/api/src/` unless stated. Spec refs were written at `bef484ca8b`; the ones that moved are re-stated here. Line numbers drift, so re-grep.

## Global Constraints (from the spec)

- **Profiles:** `auto | full | standard | minimal | custom`. `auto` with an unknown window is `full` (today's behaviour, byte-identical registration, prompt and `liveQueryKey`). `minimal` is the floor `auto` can pick. `custom` = `{ domains: AiToolDomain[], tools: string[] }`, validated at write against the **merged stored state**, intersected at runtime.
- **The resolver only removes.** `names` is always a subset of the surface's existing set (chat registry, helper level list or client-declared list, `resolveRunToolExposure` list, script builder's own bare names, office client tool names). `null` = unchanged. Extra tools are filtered too; the run's outcome tools (`outcomeToolsForRun`, incl. `submit_task_step`), `set_device_context` (chat) and `propose_action_plan` (when approval mode needs it) always survive. Never feeds `guardrailPolicy.toolAllowlist`.
- **`minimal` is read-only, literally (spec §3.1):** every curated `minimal` tool has base tier 1 **and no action in `TIER2_ACTIONS` or `TIER3_ACTIONS`**. Mixed-action tools (`manage_alerts`, `manage_tickets`, …) belong to `standard`. The only tier-2 name a `minimal` chat session carries is `set_device_context`, kept by spec rule 2, outside the curated list.
- **Fingerprint** = sha256 of sorted resolved names + sorted kept extra names + `compactSchemas` + `promptMode`, independent of page context. It joins `liveQueryKey` (`turnBinding.ts:135`) and `ai_invocations.tool_exposure_fingerprint`; `full` + unknown window keeps the key byte-identical to today's (the segment is appended only when `profile !== 'full'`).
- **Window precedence:** override → min(discovered, fresh observed) → unknown. Observed is fresh for `CONTEXT_WINDOW_MEMO_TTL_MS` (1 h), keyed to connection `config_version` **and the requested wire model**; stale = hint only. Override range CHECK 1024..100 000 000. On a warm process an override beats the memo; a memo beats a discovered value only when smaller.
- **Budget numbers:** `AUTO_FIT_FRACTION = 0.75`; reserve = `CONTEXT_MIN_OUTPUT_TOKENS` (1024) + 2 × `resultCharBudget`/3 + a page/device-context allowance (2,000 tokens); `resultCharBudget`: `minimal` 2,000, `standard` 4,000, `full`/`custom` 8,000 (`MAX_TOOL_RESULT_CHARS`). `PROFILE_PREFIX_TOKENS[surface][profile]` is measured from the **actual advertised upstream request** (translated, compacted when the exposure says so, retained dynamic extras included), bytes/3 (`adapter.ts:34`); drift ≤ 10 %.
- **Description limits:** `compactDescription` ≤ 200 chars for every curated `minimal`/`standard` tool; `AI_SYSTEM_PROMPT_COMPACT` ≤ 2,048 B; tool descriptions ≤ 300 / params ≤ 160 unchanged (`aiTools.descriptionBudget`).
- **Schemas:** `z.undefined()` is banned. Compaction strips only `maxLength minLength maximum minimum pattern format examples default` from the *advertised* upstream `parameters`. `matchesToolSchema` (`translateResponse.ts:125-183`, which checks `$ref/type/enum/required/additionalProperties` only) validates the original schema and must return the same verdict either way; Zod validation in handlers is untouched.
- **Tool-index budget for `full` is unchanged:** always-on < 2,560 B (pinned at 2,551 B, `aiToolIndex.test.ts:431`), per domain < 2,048 B, worst page turn < 7,040 B, hard cap 7,680 B. No AI tool is added in this feature. A byte-identical `full` prompt baseline snapshot is committed in W01 before any change.
- **Web:** new copy in all 8 locales (`en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`), mutations through `runAction`, no nav change (`settingsPageRegistry.test.ts` untouched; re-run it). Settings rule 9 table and the rule 3 exception copy ("set by the partner on the model; organizations cannot override it") in the W05 PR body and the drawer.
- **Migrations:** hand-written, idempotent, no `BEGIN/COMMIT`, guarded CHECKs. Slot rule: **the next free name that `localeCompare`-sorts after the newest committed file on `origin/main` at PR time** (never a lower `2101xx` slot). Neither migration writes rows, so no `breeze.scope` election. `pnpm db:check-drift` after each.
- **Tenancy:** `partner_ai_models` is partner-axis (shape 3), not in `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts:342` comment) nor `CORE_TENANT_EXPORT_POLICY` (grep verified): no registration for its new columns, but real-Postgres RLS tests for the new fields (T1b). `ai_invocations` **is** registered (`tenantExportPolicyRegistry.ts:154`): both new text columns go in `included` in the same PR (W03); the suite fails only under Integration Tests.

## Review Focus

1. **A `custom` profile drops a surface-required tool** (script builder's `execute_script_on_device`, a run's outcome tool, the troubleshoot profile's `execute_command`/`run_script`) → T3 `script_builder custom without execute_script_on_device refuses with SURFACE_REQUIRED message`, `outcome tools incl. submit_task_step survive any profile`, `troubleshoot profile fails coverage under minimal`.
2. **A fresh observed window smaller than the discovered one must win; a stale, re-versioned, or fallback-model observation must not touch the primary** → T5 `fresh 8192 observed beats 262144 discovered`, `observed at config_version 3 ignored under 4`, `older than TTL is a hint`; T6 `a refusal-fallback model's rejection writes to the fallback offering, never the primary`.
3. **Replica inconsistency** → T6 integration `UPDATE with a stale config_version matches zero rows (real predicate)`, `a thrown write is logged, never rethrown`; T7 `fresh process caps from the stored window`, `changed override on a warm process beats the memo`.
4. **A verify stub leaks into production exposure or executes** → T10 `stubs invoked with production deps trapped (db/executeTool mocked to throw) never throw`, `stub names + JSON schemas equal the surface's production declarations`.
5. **Exposure computed after the reuse key / prompt / grant, or page-context churn** → T4 `finalizeToolExposure runs before liveQueryKey and the grant (call-order spy)`, `resolveToolExposure never receives a page-context key (call-site spy)`; T8 `constrained device-page prompt equals the no-page prompt's tool lines`.

## Premises

| # | Check | Result |
|---|---|---|
| 0.1 | `partner_ai_models` has no tool/window columns | yes: `db/schema/aiModelRegistry.ts:82-125` |
| 0.2 | Chat registers everything; reuse key computed before extras are resolved | yes: `streamingSessionManager.ts:998-999` (key), `:1162/:1179` (tenant/flow descriptors), `:1271` (no `onlyTools`), `:1417` |
| 0.3 | `onlyTools` unknown-name throw outside production | yes: `aiAgentSdkTools.ts:6092-6112` |
| 0.4 | `limits` hardcoded null for gateway offerings | yes: `gatewayCandidate.ts:212-213` |
| 0.5 | Window memo per process, 1 h, memo preferred when present | yes: `contextWindow.ts:18,137-160` |
| 0.6 | Discovery reads only `id` + display name | yes: `gateway/openai/discovery.ts:68-81`; `DiscoveredConnectionModel` (`gateway/types.ts:21`) |
| 0.7 | Verify = harness only; record in `capabilities.breeze_verification` | yes: `offeringVerification.ts:110-235`, `gatewayCapabilities.ts:71-90` |
| 0.8 | Eligibility refuses tools per surface list | yes: `eligibility.ts:88`, `TOOL_REQUIRING_SURFACES` (`packages/shared/src/constants/aiSurfaces.ts:41`) |
| 0.9 | Refused batch → fixed note, no code | yes: `translateResponse.ts:196-262`, `translateStream.ts:184,211-218`; `GatewayFailureCode` only `'context_window_exceeded'` (`failureNotes.ts:17`) |
| 0.10 | Prompt = BASE + index + TAIL + DIAGNOSIS | yes: `aiToolIndex.ts:184-187`; `aiAgentSystemPrompt.ts:73,123`, `aiAgentDiagnosisPrompt.ts:146` |
| 0.11 | Extra tools carry no domain; result budget hardcoded | yes: `toolSources/sdkBridge.ts:89`, `flows/sdkFlowTools.ts`; `compactToolResultForChat(name, text)` default 8,000 at `aiAgentSdkTools.ts:888,1247,1309,1416,1480,1509,2342` |
| 0.12 | Office/client surface has its own prompt, names and factory | yes: `routes/clientAi/sessions.ts:234-238`; `streamingSessionManager.ts:1265` bypasses Breeze registration via `mcpServerFactory`; helper client tools via `clientDeclaredToolMcpNames` (`routes/helper/index.ts:248`) |
| 0.13 | Grant record copies fields explicitly | yes: `gateway/grants.ts:56-66`; one grant may carry primary + refusal-fallback wire models (`connectionFactory.ts:279-282`) |
| 0.14 | `breezeToolTemplate` is private, registry-only; `validateToolInput` rejects unknown names | yes: `aiAgentSdkTools.ts:1643`, `aiToolSchemas.ts:2774-2782` |
| 0.15 | Newest committed migration | `2027-01-22-210300-device-watchdog-edition.sql` |

## Decisions surfaced while planning

1. **Where schema compaction runs.** Gateway: `translateMessagesRequest(parsed, model, { compactSchemas })` strips the eight keywords from the upstream `parameters`; `ToolNameMap.schemas` keeps the originals. The flag rides on the grant (`grants.ts:56` record gains `compactSchemas`). **Non-gateway transports (platform, Anthropic BYO, catalog) under a constrained profile:** the resolver sets `compactSchemas: false` for them (full schemas go to Anthropic, which handles them), while names, `compactDescription`, the compact prompt, `resultCharBudget` and `promptMode: 'constrained'` still apply. Stated here because the spec (§2, §3.4) does not say.
2. **Where `surfaceReadiness` lives.** In `partner_ai_models.capabilities` as `breeze_surface_readiness: Record<AiSurface, SurfaceReadinessRecord>`, a sibling of `breeze_verification`, written through `writeOfferingVerification`'s locked, superseded-checked path (extended with a merge). No eighth column.
3. **Two migrations, not one.** Spec §4 says one; the waves are independent PRs, so W01 adds the offering columns and W03 the two `ai_invocations` columns.
4. **Domain taxonomy for dynamic extras (explicit v1 rule).** Tenant (BYO MCP) tools count as `integrations`, flow tools as `scripts`. The `aiTools.ts:661` `SESSION_AWARE_DOMAIN` precedent classifies only the core M365/Google tools; this is a new, stated rule, not an extension of it. Retained extras' schemas count toward `PROFILE_PREFIX_TOKENS` (measured with `--tenant-tools a`).
5. **`minimal` keeps the spec's literal read-only contract** (quorum overturned the earlier relaxation): base tier 1 and no `TIER2_ACTIONS`/`TIER3_ACTIONS` entry. `manage_alerts` (acknowledge/resolve/suppress run without approval under `TIER2_ACTIONS`, `aiGuardrails.ts:95,3438`) and `resolve_device_context` (tier 2) move to `standard`. Chat `minimal` (12): `query_devices, get_device_details, get_device_health, get_device_hardware_health, get_fleet_health, get_alert_correlations, search_logs, analyze_metrics, query_audit_log, search_documentation, list_organizations, get_org_summary`, plus `set_device_context` by rule 2.
6. **Observation identity is per requested wire model.** The grant carries `observers: Record<wireModel, { offeringId; partnerId }>` (primary and refusal fallback, `connectionFactory.ts:279`); the adapter writes under the model it actually sent, so a fallback rejection never overwrites the primary's window. The window key already includes `model`.
7. **Chat prompt rebuild.** `aiAgentSdk.ts:747` reuses `session.systemPrompt` without page context. A constrained exposure always rebuilds; switching back to `full` restores the stored/full prompt (T8 test full → minimal → full).
8. **Explicit exposure handoff in `getOrCreate`.** `ResolvedModel` carries only facts (`toolProfileFacts: { toolProfile, toolAllowlist, effectiveWindow, transport }`), never the exposure, because it lacks surface declarations, extras and run context. Each surface entry calls `finalizeToolExposure(facts, surfaceInput)` once; in chat this happens **after** tenant/flow descriptors are resolved and **before** `liveQueryKey` (`:998`), the prompt, `createBreezeMcpServer` and `openGatewayGrant`. Descriptor resolution moves above the key computation.

## Quorum (codex `exec`, read-only, xhigh)

Codex exec read-only xhigh 2026-11-08: **AGREE WITH CHANGES — folded in.**
- Wave order W01 → W03 → W02 → W04 → W05 with `auto` gated on measured prefixes; W05 depends on W02 and W04 DTOs.
- Exposure finalized before the reuse key / prompt / registration / grant; result budgets, office/client and helper client-tool surfaces, `too_small`, dropped-name warning and readiness rendering added as tasks.
- Factual fixes: no-loosening proven via `matchesToolSchema` verdict equality + Zod, not `maxLength`; grant fields added in `grants.ts`; prefix tokens measured on the advertised request; memo-vs-override precedence specified; per-surface declaration/validation adapters; qualified script-builder names; `outcomeToolsForRun`; merged-state PATCH validation; migration slot rule.
- D5 overturned (`minimal` literal read-only; `manage_alerts` out); D6 observations per wire model; D1/D4 reworded with explicit non-gateway behaviour and taxonomy provenance.
- Vacuous tests replaced: exact-set E2E assertion, `ai:tool-capture --offering/--profile`, trapped-deps stub execution, call-order and call-site spies, byte-identical `full` baseline, troubleshoot-profile coverage failure.

## Wiring

| Map / file | Change | Wave |
|---|---|---|
| `db/schema/aiModelRegistry.ts` `partnerAiModels` | 7 columns + 4 CHECKs (`tool_profile_chk`, `tool_allowlist_chk`, `context_window_override_chk`, `context_window_observed_chk`) | W01 |
| `packages/shared` `types/aiModelRegistry.ts`, `validators/aiModelRegistryApi.ts` | `AiToolProfile`, `AiToolAllowlist`, DTO + patch fields; `contextWindow` DTO block; `AI_QUALITY_GROUP_BYS += 'tool_profile'` | W01 / W02 / W04 |
| `aiModels/toolExposure.ts`, `toolProfiles.ts`, `surfaceRequiredTools.ts`, `surfaceDeclarations.ts` (new) | resolver, lists, floors, per-surface declaration + validation adapters | W01 (W04 uses adapters) |
| `aiAgentSdkTools.ts` `createBreezeMcpServer` | options `extraToolFilter`, `compactDescriptions`, `resultCharBudget` threaded to every `compactToolResultForChat` call; `listBreezeDeclarations()` export | W01 / W03 |
| `streamingSessionManager.getOrCreate`, `routes/helper/index.ts:123-130,248`, `routes/aiTopologyTurn.ts:114`, `aiAgents/runLoop.ts:2299`, `routes/scriptAi.ts:308`, `routes/clientAi/sessions.ts:234` | one `finalizeToolExposure` per surface entry; chat reorders descriptor resolution above the key | W01 |
| `aiToolSearchPolicy.ts` | `ToolSearchReason += 'profile_static'`; `profileSearch` input | W01 |
| `turnBinding.ts` | `toolExposureFingerprint: string | null`; `liveQueryKey` suffix | W01 |
| `aiAgentSystemPrompt.ts`, `aiToolIndex.ts`, `aiTools.ts` | `AI_SYSTEM_PROMPT_COMPACT`, `composeConstrainedSystemPrompt`, `compactDescription?` | W03 |
| `gateway/openai/translateRequest.ts`, `gateway/openai/schemaCompaction.ts` (new), `gateway/grants.ts:56`, `gateway/types.ts`, `connectionFactory.ts openGatewayGrant` | compaction on upstream params; grant `compactSchemas`, `contextWindow`, `windowSource`, `observers` | W03 (window fields W02) |
| `db/schema/aiInvocations.ts`, `invocationLedgerWrite.ts`, `tenantExportPolicyRegistry.ts:154` | `tool_profile`, `tool_exposure_fingerprint` (`included`) | W03 |
| `llm/__scripts__/tool-capture.ts:34`, `llm/toolCapture/runSurface.ts:139,173`, `surfaces.ts` | `--offering <id>` / `--profile <p>` → exposure-aware capture | W03 |
| `gateway/openai/discovery.ts`, `gateway/types.ts:21`, `aiModels/discovery.ts syncConnectionModels` | `contextLength` read + `context_window_discovered` write | W02 |
| `gateway/openai/contextWindow.ts:137`, `adapter.ts:112-114`, `gatewayCandidate.ts:213`, `aiModels/contextWindowFacts.ts`, `contextWindowObservation.ts` (new) | known window + precedence into `planRequest`; `limits.maxInputTokens`; persisted observation | W02 |
| `llm/surfaceTurnHarness.ts`, `surfaceTurnStubs.ts` (new), `offeringVerification.ts`, `offeringVerificationStore.ts`, `gatewayCapabilities.ts`, `eligibility.ts:88`, `registryView.ts` | `surface_turn` stage, readiness record, per-surface refusal | W04 |
| `gateway/failureNotes.ts`, `translateResponse.ts`, `translateStream.ts`, `streamingSessionManager.ts:2378`, `qualityQueries.ts`, `apps/web/.../AiQualityTable.tsx:20-26`, `AiUsageBreakdown.tsx:33` | `refused_tool_batch` code, user message, quality column + grouping UI | W04 |
| `apps/web/.../OfferingDrawer.tsx`, 8 × `locales/*/settings.json`, `apps/docs/.../bring-your-own-llm-key.mdx:152`, `deploy/environment.mdx:1164` | "Tools and context" section, readiness per surface, dropped-name warning, copy, docs | W05 |

## Budget

`full` is untouched: no new tool, no vocabulary change; `aiToolIndex.test.ts:431` (2,551 B), the `w15/w16/w16b/w18` suites and the new byte-identical baseline snapshot (T4) stay green unchanged. Constrained prefixes get their own pins, measured in W03 T9 with the exposure-aware `pnpm ai:tool-capture --surface <id> --profile <p> [--tenant-tools a]` on the **translated upstream request** (bytes/3), stored in `PROFILE_PREFIX_TOKENS[surface][profile]`:

| Surface × profile | Target (tokens) | Pin test |
|---|---|---|
| chat `minimal` | ≤ 3,500 | `toolProfiles.prefix.contract.test.ts` |
| chat `standard` | ≤ 12,000 | same |
| helper-basic / helper-standard / script-builder / agent-full-remediation / agent-analysis × `minimal`, `standard` | measured, pinned ± 10 %, no upper target in v1 | same |
| chat `full` (informational) | measured, `toBeGreaterThan(0)` | same |
| `AI_SYSTEM_PROMPT_COMPACT` | ≤ 2,048 B | `aiAgentSystemPrompt.compact.test.ts` |

Worked `auto` example the thresholds must reproduce (spec §3.3): window 8,192 → `minimal`; 32,768 → `standard`; 131,072 → `full`; 4,096 → `too_small`.

## Execution split

- **W01** (Opus, serial): T1 → T1b → T2 → T3 → T4 → T4b. T2/T3 after T1 in one agent.
- **W03** (after W01): T8 prompt + descriptions ∥ T9 compaction, capture, ledger, prefix pins.
- **W02** (after W03): T5 pure ∥ T6 observation, then T7 plumbing (+ `too_small` session-start message).
- **W04** (after W02): T10 harness + stub contracts, T11 gating/storage, T12 refused batch + web grouping (Sonnet-eligible), T13 lab + PR.
- **W05** (after W04): T14 API write validation, T15 drawer + locales (Sonnet-eligible), T16 docs + E2E.

Test commands: from `apps/api`, `npx vitest run <file>` (or `pnpm exec vitest run <file>`). Never `pnpm --filter <pkg> test -- --run <path>`. Integration suites: `pnpm test-stack up` → `npx vitest run -c vitest.integration.config.ts <file>` → `pnpm test-stack down`. TS: `tsc --build tsconfig.tests.json`, check the exit code, not `| tail`.

---

## W01 — model record, resolver, floors (ships dark)

Migration slot: **`2027-01-22-210400-partner-ai-models-tool-profile.sql`**, after `2027-01-22-210300-device-watchdog-edition.sql` (newest committed 2026-11-08). Before committing: `git fetch origin main && ls apps/api/migrations | tail -3`; if overtaken, take the next free name that `localeCompare`-sorts after the newest.

### Task 1: columns, migration, shared types

**Files:** Create the migration. Modify `db/schema/aiModelRegistry.ts:82-125`, `db/schema/aiModelRegistry.contract.test.ts`, `packages/shared/src/types/aiModelRegistry.ts:46-80`, `packages/shared/src/validators/aiModelRegistryApi.ts:129-138` + test.

**Interfaces — Produces:**
- `AI_TOOL_PROFILES = ['auto','full','standard','minimal','custom'] as const`; `aiToolAllowlistSchema = z.object({ domains: z.array(z.enum(AI_TOOL_DOMAINS)).max(14), tools: z.array(z.string().regex(/^[a-z0-9_]{1,64}$/)).max(200) }).strict()`.
- `offeringDetailsPatchSchema` += `toolProfile?`, `toolAllowlist?: AiToolAllowlist | null`, `contextWindowOverride?: number | null` (int 1024..100_000_000). The shape-level rule is only "both may be absent"; the `custom ⇔ allowlist` coupling is checked server-side on **stored + patch merged** (T14), and the drawer always sends the two together when either changes.
- Drizzle: `toolProfile text default 'auto' not null`, `toolAllowlist jsonb`, `contextWindowOverride integer`, `contextWindowDiscovered integer`, `contextWindowObserved integer`, `contextWindowObservedAt timestamptz`, `contextWindowObservedConfigVersion integer`.

- [ ] Step 1: failing tests: `tool_profile CHECK lists exactly AI_TOOL_PROFILES`; `tool_allowlist CHECK: (tool_profile = 'custom') = (tool_allowlist IS NOT NULL)`; `context_window_override CHECK 1024..100000000`; `observed_at and observed_config_version NULL iff observed NULL`; `migration adds every Drizzle column with IF NOT EXISTS and guards each CHECK via pg_constraint`; `migration has no INSERT|UPDATE|DELETE|MERGE`. Shared: `accepts { toolProfile: 'custom', toolAllowlist: { domains: ['devices'], tools: [] } }`, `rejects contextWindowOverride 1023`, `accepts contextWindowOverride null`, `rejects an unknown domain`.
- [ ] Step 2: `cd apps/api && npx vitest run src/db/schema/aiModelRegistry.contract.test.ts`; `cd packages/shared && npx vitest run src/validators/aiModelRegistryApi.test.ts`. FAIL.
- [ ] Step 3: write the migration (`ADD COLUMN IF NOT EXISTS` × 7; `DO $$ … IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = …) THEN ALTER TABLE … ADD CONSTRAINT … END IF …$$` × 4), Drizzle mirrors, shared types.
- [ ] Step 4: PASS. `pnpm db:migrate && pnpm db:check-drift` on a test stack. Commit `feat(ai-models): tool profile and context window columns on partner_ai_models (#9596)`.

### Task 1b: RLS integration tests for the new fields

**Files:** Create `__tests__/integration/partnerAiModelsToolProfileRls.integration.test.ts` (pattern: `aiModelAssignmentsPartnerRls.integration.test.ts`).

- [ ] Step 1: cases as `breeze_app`: `an org token reads tool_profile/tool_allowlist/context_window_* on enabled rows of its partner only`; `an org token sees no disabled row`; `partner B cannot read or update partner A's row`; `an org token's UPDATE of tool_profile matches zero rows`; `a partner token's UPDATE through inPartnerRegistryWrite succeeds`. Controls: each denial case has a sibling that lifts the predicate (system scope) and reads the row.
- [ ] Step 2: `pnpm test-stack up`, run; expect the new-field reads to FAIL until T1's columns exist in the stack, then PASS. `pnpm test-stack down`. Commit.

### Task 2: the pure resolver and curated lists

**Files:** Create `services/aiModels/toolExposure.ts`, `toolExposure.test.ts`, `services/aiModels/toolProfiles.ts` (curated lists; `PROFILE_PREFIX_TOKENS` placeholder filled by W03), `toolProfiles.contract.test.ts`.

**Interfaces — Produces:**
```ts
export interface ToolProfileFacts { toolProfile: AiToolProfile; toolAllowlist: AiToolAllowlist | null; effectiveWindow: number | null; transport: 'gateway' | 'anthropic' }
export interface ToolExposureInput {
  surface: AiSurface; runProfile?: AiAgentRunProfile; facts: ToolProfileFacts;
  surfaceBaseSet: readonly string[];            // bare names the surface registers today
  extraTools: ReadonlyArray<{ name: string; domain: AiToolDomain; alwaysKeep?: boolean }>;
  approvalMode?: AiApprovalMode;
}
export interface ToolExposure {
  profile: Exclude<AiToolProfile, 'auto'>; names: string[] | null; extraToolNames: string[];
  promptMode: 'standard' | 'constrained'; toolSearchAllowed: boolean; compactSchemas: boolean;
  resultCharBudget: number; fingerprint: string; droppedCustomNames: string[]; tooSmall: boolean;
}
export function resolveToolExposure(input: ToolExposureInput): ToolExposure;
export function pickAutoProfile(window: number, surface: AiSurface): Exclude<AiToolProfile,'auto'|'custom'> | 'too_small';
export const AUTO_FIT_FRACTION = 0.75; export const FULL_IDENTITY_FINGERPRINT: string;
export const RESULT_CHAR_BUDGET = { minimal: 2000, standard: 4000, full: 8000, custom: 8000 } as const;
```
`toolProfiles.ts`: `CURATED_PROFILES: Record<'chat'|'helper'|'script_builder'|'ai_agents'|'office_chat', { minimal: readonly string[]; standard: readonly string[] }>`. Chat `minimal` = Decision 5's 12 names. Chat `standard` = minimal + `resolve_device_context, manage_alerts, manage_alert_rules, manage_tickets, list_scripts, get_script_details, run_script, manage_services, manage_patches, get_security_posture, get_vulnerability_report, browse_device_event_log, manage_delivery, analyze_disk_usage, get_active_users` + the implementer's remaining helpdesk picks to 35–45. Helper lists are intersections with `getHelperAllowedTools(level)`; `script_builder` lists are bare `SCRIPT_BUILDER_TOOL_TIERS` keys; `ai_agents` lists are per run profile; `office_chat` lists are subsets of `clientMcpToolNamesForWriteMode` bare names.

- [ ] Step 1: failing tests (`toolExposure.test.ts`):
  - `full + unknown window + gateway: names null, promptMode standard, toolSearchAllowed true, compactSchemas false, resultCharBudget 8000, fingerprint === FULL_IDENTITY_FINGERPRINT`;
  - `minimal + anthropic transport: compactSchemas false, promptMode constrained` (Decision 1); `minimal + gateway: compactSchemas true`;
  - `names ⊂ surfaceBaseSet; custom execute_command on helper basic is dropped`;
  - `extraTools: outcome tool kept under minimal; tenant tool (integrations) dropped under minimal, kept under custom { domains: ['integrations'] }`;
  - `set_device_context always kept for chat; propose_action_plan kept for action_plan/hybrid_plan`;
  - `auto: 8192 → minimal, 32768 → standard, 131072 → full, 4096 → too_small (tooSmall true)` using fixture `PROFILE_PREFIX_TOKENS` chat 3,000 / 11,000 / 68,000;
  - `unknown custom names → droppedCustomNames, never names`;
  - `fingerprint: changes on one custom name; unchanged by extraTools order; ToolExposureInput has no page key` (runtime: `Object.keys(input)` equals the documented set — the call-site spy is T4).
  - `toolProfiles.contract.test.ts`: `every curated name is declared (TOOL_TIERS ∪ SCRIPT_BUILDER_TOOL_TIERS ∪ office names) and classified in WISP_TOOL_SUBJECTS ∪ WISP_NON_FOCAL_TOOLS`; `every minimal tool has base tier 1 and no TIER2_ACTIONS/TIER3_ACTIONS/MFA_GATED_TOOL_ACTIONS entry` (`manage_alerts` would fail it — the test includes that negative control); `chat minimal is exactly the 12 names of Decision 5`; `chat standard has 35..45`; `minimal ⊂ standard per surface`.
- [ ] Step 2: `npx vitest run src/services/aiModels/toolExposure.test.ts src/services/aiModels/toolProfiles.contract.test.ts`. FAIL.
- [ ] Step 3: implement. Fingerprint: `sha256(JSON.stringify({ n: sorted names, x: sorted extras, c: compactSchemas, p: promptMode })).slice(0, 16)`.
- [ ] Step 4: PASS. Commit `feat(ai-models): resolveToolExposure and curated tool profiles (#9596)`.

### Task 3: `SURFACE_REQUIRED_TOOLS`, floors, per-surface declaration adapters

**Files:** Create `services/aiModels/surfaceRequiredTools.ts` + contract test, `services/aiModels/surfaceDeclarations.ts` + test. Modify `assignmentWrites.ts:46-62` (warning), `refusals.ts`, `aiAgentSdkTools.ts` (export `listBreezeDeclarations(): readonly SdkTool[]` over the private template).

**Interfaces — Produces:**
- `SURFACE_REQUIRED_TOOLS`: `chat: ['set_device_context']`, `office_chat: []`, `helper: []`, `script_builder: ['execute_script_on_device','apply_script_code']`, `ai_agents: (run) => [...outcomeToolsForRun(run), ...REQUIRED_BY_RUN_PROFILE[run.profile]]` where the troubleshoot profile requires `execute_command, run_script` (`troubleshootProfile.ts:6-9`).
- `checkSurfaceCoverage(surface, exposure, run?)`: `{ ok: true } | { ok: false; missing: string[] }`.
- `SURFACE_UNDERPOWERED_MESSAGE(surfaceLabel)` = "This model's tool profile does not include what the {surface} needs. Assign a larger model to this surface, or widen the profile."; agent failure reason `tool_profile_underpowered`.
- `surfaceDeclarations(surface, run?)`: `{ declarations: readonly SdkTool[]; validate(name, input): { success: boolean; error?: string }; mcpName(bare): string }` — breeze registry (`listBreezeDeclarations` + `validateToolInput`, `mcp__breeze__`), script builder (`buildScriptBuilderTools` declarations + their own Zod, `scriptBuilderMcpToolName`), agent (`breeze` + `buildOutcomeSdkTools`, `validateOutcomeToolInput`), office (`clientAi` tool declarations + schema).

- [ ] Step 1: failing tests: `SURFACE_REQUIRED_TOOLS names only tools its surface declares`; `script_builder custom without execute_script_on_device refuses with SURFACE_REQUIRED message`; `outcome tools incl. submit_task_step (taskId set) survive any profile`; `troubleshoot profile fails coverage under minimal (missing execute_command, run_script)`; `analysis/read-only profiles pass coverage under minimal`; `chat minimal passes`; `putPartnerAssignments emits warning tool_profile_underpowered, not a throw`; `surfaceDeclarations('script_builder').mcpName('execute_script_on_device') === 'mcp__script_builder__execute_script_on_device'`; `validate rejects an unknown name per surface`.
- [ ] Step 2: run; FAIL. Step 3: implement. Step 4: PASS. Commit `feat(ai-models): SURFACE_REQUIRED_TOOLS floors and surface declaration adapters (#9596)`.

### Task 4: finalize exposure at every surface entry; tool search reason; live key; `full` baseline

**Files:** Modify `aiAgentSdkTools.ts:6039-6130` (`extraToolFilter`, `compactDescriptions` options), `streamingSessionManager.ts:935-1000,1158-1185,1240,1271,1400,1417` (move descriptor resolution above `:998`; `finalizeToolExposure` → `binding.toolExposureFingerprint` → key → prompt → registration → `openGatewayGrant`), `routes/helper/index.ts:123-130,248` (client-declared tools intersected too), `routes/aiTopologyTurn.ts:114`, `aiAgents/runLoop.ts:2299-2370` (+ coverage refusal before any provider call), `routes/scriptAi.ts:308` (+ 409 refusal), `routes/clientAi/sessions.ts:234-238` (resolver over `clientMcpToolNamesForWriteMode` bare names; office factory registers the filtered set), `aiToolSearchPolicy.ts:30-92`, `turnBinding.ts:32-45,95-145,164`, `resolveModel.ts:84-110,280-305` (`toolProfileFacts`), `aiAgent.ts:954-980` (`buildSystemPrompt(auth, page, mode, ceiling, exposure?)`), `aiAgentSdk.ts:735-749`, `aiAgent.toolIndexPrompt.test.ts` (+ `toMatchFileSnapshot` baseline committed on `main`'s output **before** any change in this task).

- [ ] Step 0: add the `full` byte-identical baseline snapshot test and commit it first (`test(ai): pin the full chat prompt byte-for-byte (#9596)`); it must pass on unchanged code.
- [ ] Step 1: failing tests: `streamingSessionManager.toolExposure.test.ts` — `full + unknown window: createBreezeMcpServer called without onlyTools, allowedTools equals today's list (snapshot), liveQueryKey byte-identical to the pre-change key`; `finalizeToolExposure runs before liveQueryKey and before openGatewayGrant (call-order spy)`; `resolveToolExposure receives exactly the documented input keys (call-site spy; no page key)`; `minimal: onlyTools = curated set, allowedTools = its mcp names + kept extras, tenant tool absent from both, tool search reason profile_static`; `clientAi` — `office_chat minimal registers only the filtered client names`; `helper` — `client-declared tools are intersected with the profile`; `runLoop` — `troubleshoot run under minimal fails with tool_profile_underpowered before any provider call`; `aiToolSearchPolicy.test.ts` — `profile_static when profileSearch false, before host checks`; `turnBinding.test.ts` — `v1 rows without the field parse to null`; `aiAgent.toolIndexPrompt.test.ts` — `exposure.names filters the index; full snapshot unchanged`.
- [ ] Step 2: run; FAIL. Step 3: implement. Step 4: PASS + `aiAgentSdkTools.registryParity.contract`, `aiToolIndex.test`, all `aiToolIndex.w*-budget.test`, `turnBinding.test`, streaming suites. Commit `feat(ai): finalize one tool exposure per surface entry (#9596)`.

### Task 4b: `resultCharBudget` into every result path; PR

**Files:** Modify `aiAgentSdkTools.ts:888,1247,1309,1416,1480,1509,2342` (`compactToolResultForChat(name, text, session.resultCharBudget)` via `getActiveSession`), `toolSources/sdkBridge.ts:89`, `flows/sdkFlowTools.ts` (same), `streamingSessionManager.ts` (`session.resultCharBudget` from the exposure).

- [ ] Step 1: failing tests: `a 6,000-char result under minimal is compacted to ≤ 2,000 chars and the artifact capture envelope survives`; `full keeps 8,000`; `tenant and flow tool results honour the budget`.
- [ ] Step 2: run; FAIL. Step 3: implement. Step 4: PASS. TS check. PR `W01`: `Part of #9596`; Merge Danger: nullable/defaulted columns only; `auto` + unknown window is a no-op; `full` prompt and key proven byte-identical.

---

## W03 — constrained prompt, compaction, capture, provenance

Migration slot: **`2027-01-22-210500-ai-invocations-tool-profile.sql`** — re-check with the slot rule; if taken, the next free name that sorts after the newest on `origin/main`.

### Task 8: compact prompt and `compactDescription`

**Files:** Modify `aiAgentSystemPrompt.ts` (`AI_SYSTEM_PROMPT_COMPACT`), `aiToolIndex.ts:184-187` (`composeConstrainedSystemPrompt(exposure)`), `aiTools.ts:192-200` (`compactDescription?`), `aiAgentSdkTools.ts:1653` (`templateWithRegistryMeta` swaps description when `compactDescriptions`), `aiAgent.ts:954-980`, `aiAgentSdk.ts:735-749` (rebuild rule, Decision 7), every `aiTools*.ts` declaring a curated tool. Create `aiAgentSystemPrompt.compact.test.ts`, `toolProfiles.compactDescription.contract.test.ts`.

- [ ] Step 1: failing tests: `AI_SYSTEM_PROMPT_COMPACT ≤ 2048 bytes and names approvals, "never claim", tenant boundary, "cannot"`; `every curated minimal/standard tool has compactDescription ≤ 200`; `custom tool without one falls back to the first sentence`; `constrained device-page prompt equals the no-page prompt's tool lines`; `constrained prompt has no DIAGNOSIS heading and no vocabulary for absent domains`; `full → minimal → full: the third prompt equals the first byte-for-byte`; the T4 `full` snapshot unchanged.
- [ ] Step 2: run; FAIL. Step 3: implement. Step 4: PASS + `aiToolIndex*`, `aiTools.descriptionBudget`. Commit.

### Task 9: gateway compaction, exposure-aware capture, prefix pins, ledger provenance

**Files:** Create the migration, `gateway/openai/schemaCompaction.ts` + test, `toolProfiles.prefix.contract.test.ts`. Modify `translateRequest.ts:97-120`, `gateway/types.ts`, `gateway/grants.ts:56-66` (copy `compactSchemas`), `connectionFactory.ts openGatewayGrant`, `adapter.ts:111-112` (`translateMessagesRequest(parsed, model, { compactSchemas: grant.compactSchemas })`; `promptTokensEstimate = estimateInputTokens(translated.body)` so the estimate is of what is sent), `db/schema/aiInvocations.ts:81-84`, `invocationLedgerWrite.ts:16-60,112`, the settle path filling `promptProfile`, `tenantExportPolicyRegistry.ts:154`, `llm/__scripts__/tool-capture.ts:34` (`--offering <id>` or `--profile <p>` → exposure), `llm/toolCapture/surfaces.ts`, `runSurface.ts:139,173` (`getCaptureSystemPrompt(surface, exposure)`, `onlyTools`/extras from the exposure, records the translated request bytes), `toolProfiles.ts PROFILE_PREFIX_TOKENS`.

- [ ] Step 1: failing tests: `compactInputSchema removes only the eight keywords; keeps required/enum/type/properties/additionalProperties`; `translateRequest: compactSchemas → upstream parameters compacted, tools.schemas unchanged`; **no-loosening:** `for every curated chat tool and a 50-input fuzz corpus (valid, missing-required, wrong-type, extra-key), matchesToolSchema(input, original) === matchesToolSchema(input, compacted)` and `validateToolInput still rejects a maxLength/pattern violation after compaction`; `adapter estimates the translated body, not the SDK payload`; `migration adds two nullable text columns with IF NOT EXISTS, no writes`; `recordInvocation persists toolProfile and toolExposureFingerprint`; `runSurface with --profile minimal registers exactly the curated set`; `PROFILE_PREFIX_TOKENS within 10 % of a fresh measurement for every surface × profile in the table`; `chat minimal ≤ 3500`.
- [ ] Step 2: run; FAIL. Step 3: implement; measure every Budget-table row with the exposure-aware capture (chat also with `--tenant-tools a`) and set the constants.
- [ ] Step 4: PASS; `pnpm test-stack up` → `tenant-export-policy.integration.test.ts`, `aiInvocationsAppendOnly.integration.test.ts`, `aiInvocationsPromptProvenance.integration.test.ts` → down. `pnpm db:check-drift`. TS check. PR `W03`: Merge Danger — compaction for constrained gateway grants only; `full` byte-identical (snapshot + pins).

---

## W02 — knowing the context window (`auto` goes live)

### Task 5: `resolveEffectiveContextWindow`

**Files:** Create `services/aiModels/contextWindowFacts.ts` + test. Modify `gateway/openai/contextWindow.ts` to export `MIN_PLAUSIBLE_WINDOW`, `MAX_PLAUSIBLE_TOKENS`.

**Interfaces — Produces:** `resolveEffectiveContextWindow(f: { override; discovered; observed; observedAt; observedConfigVersion }, currentConfigVersion, now?) → { value: number|null; source: 'override'|'discovered'|'observed'|'unknown'; observedFresh: boolean }`.

- [ ] Step 1: failing tests: `override 16384 wins over discovered 131072 and observed 8192`; `fresh 8192 observed beats 262144 discovered`; `observed at config_version 3 ignored under 4 (source discovered)`; `older than TTL is a hint (value = discovered, observedFresh false)`; `all null → unknown`; `discovered below MIN_PLAUSIBLE_WINDOW ignored`.
- [ ] Step 2: run; FAIL. Step 3: implement. Step 4: PASS. Commit.

### Task 6: persisted observation, per wire model, best-effort

**Files:** Create `services/aiModels/contextWindowObservation.ts` + unit test + `__tests__/integration/contextWindowObservation.integration.test.ts`. Modify `gateway/types.ts`, `gateway/grants.ts:56-66` (copy `observers`, `contextWindow`, `windowSource`), `connectionFactory.ts:268-295` (`observers` keyed by each wire model from `resolved.offering.id` and the refusal fallback's offering), `adapter.ts:128,139`.

**Interfaces — Produces:** `recordObservedContextWindow({ offeringId, partnerId, configVersion, contextWindow }): void` — fire-and-forget, deduped per `(offeringId, configVersion, contextWindow)` for the TTL, `runOutsideDbContext(() => withSystemDbAccessContext(…))`, `UPDATE partner_ai_models SET … WHERE id = $id AND partner_id = $p AND EXISTS (SELECT 1 FROM partner_ai_connections c WHERE c.id = partner_ai_models.connection_id AND c.config_version = $cv)`; throws are logged + `captureException`, never rethrown.

- [ ] Step 1: failing tests: unit — `a thrown write is logged, never rethrown; adapter result unchanged`; `same observation written once per TTL`; `verification grant (no observers) writes nothing`; `adapter writes under the wire model it sent: a refusal-fallback rejection targets the fallback offering, never the primary`. Integration — `UPDATE with a stale config_version matches zero rows against real Postgres; a current one writes observed/at/config_version`.
- [ ] Step 2: run; FAIL. Step 3: implement. Step 4: PASS (+ test-stack run). Commit.

### Task 7: discovered window, grant-seeded planning, `resolveModel` limits, `too_small`

**Files:** Modify `gateway/openai/discovery.ts:68-81` (`contextLength` = `context_length | max_model_len | min(max_context_length, loaded_context_length)`, numbers only, plausibility-bounded), `gateway/types.ts:21`, `aiModels/discovery.ts:283-340,454-580` (`FoundModel.contextLength`; sync writes `contextWindowDiscovered`), `contextWindow.ts:137` (`planRequest(key, max, est, known?: { window: number; source })`: **override always wins over the memo; otherwise min(memo, known)**), `adapter.ts:113-114`, `gatewayCandidate.ts:212-213` (`limits.maxInputTokens` from the effective window; `toolProfileFacts.effectiveWindow`), `registryView.ts` (DTO `contextWindow` block), `streamingSessionManager.ts` / `routes/ai.ts` (`exposure.tooSmall` → session start refuses with "This model's {n}-token window is too small for Breeze chat tools." before any provider call; helper/office equivalents; agents record `tool_profile_underpowered`), `aiModelConnectionDiscovery.integration.test.ts`.

- [ ] Step 1: failing tests: `discovery.test.ts` — `context_length 131072`, `max_model_len 32768`, `max_context_length 262144 + loaded_context_length 8192 → 8192`, `"8k" → null`, `70 → null`; `contextWindow.test.ts` — `fresh process caps from the known window (no memo)`; `changed override on a warm process beats a larger memo`; `memo 8192 beats known discovered 131072`; `over the known window is refused before send`; `gatewayCandidate.test.ts` — `limits.maxInputTokens = effective window; null when unknown`; `resolveModel.test.ts` — `auto resolves minimal for observed 8192 fresh`; `streamingSessionManager` — `tooSmall refuses at session start with the window number, no SDK query created`; integration — `sync writes context_window_discovered and leaves observed/override untouched`.
- [ ] Step 2: run; FAIL. Step 3: implement. Step 4: PASS + test-stack run. TS check. PR `W02`: Merge Danger — first visible change: gateway offerings with a known window can now be narrowed by `auto` (release note); `too_small` sessions refuse up front.

---

## W04 — per-surface verify and refused-batch measurement

### Task 10: `surface_turn` harness, schema-identical stubs, isolation contracts

**Files:** Create `services/llm/surfaceTurnHarness.ts` + test, `services/llm/surfaceTurnStubs.ts` + `surfaceTurnStubs.contract.test.ts`. Consumes `surfaceDeclarations(surface, run)` (T3): stubs are built from the surface's declarations filtered by the exposure; the handler runs the surface's `validate` and returns `{ ok: true, sentinel }` on success or `{ ok: false, error }` (a real validation error, as production).

**Interfaces — Produces:** `SURFACE_TURN_VERSION = '1'`; `runSurfaceTurn({ surface, run?, exposure, systemPrompt, wireModel, childEnv, deadlineMs }) → { passed, detail, promptTokens, cachedTokens, calledTool, zodValid, sentinelSeen }`.

- [ ] Step 1: failing tests (fake SDK as `providerFidelityHarness.test.ts`): `passes only with a valid call plus the sentinel in the final text`; `invalid input → zodValid false, passed false`; `valid call, no sentinel → fails 'did not contain the sentinel'`; `prompt and cached tokens read from usage`. Contract: `stub names + JSON schemas deep-equal the surface's production declarations for the exposure (chat, script_builder, agent-analysis)`; `invoking every stub with db/index, aiAgentSdkTools handler bindings and executeTool mocked to throw never throws and touches no mock`; `surface_turn grants are org-less (orgId null)`.
- [ ] Step 2: run; FAIL (harness and stubs modules missing). Step 3: implement over `sdk.query` + `createSdkMcpServer({ tools: stubs })`, `allowedTools` from the exposure via the surface's `mcpName`, `maxTurns: 4`, shared deadline. Step 4: PASS. Commit.

### Task 11: gating, storage, readiness DTO

**Files:** Modify `offeringVerification.ts:110-235` (after both stages pass: `surface_turn` per `TOOL_REQUIRING_SURFACES` surface the offering is assigned to or permitted on — `listOfferingDefaultUses` + permitted rows — chat first; superseded on connection or exposure change), `offeringVerificationStore.ts:30-50,97-160` (`surfaceReadiness` merge), `gatewayCapabilities.ts:20-32,71-110` (`readSurfaceReadiness`; record `{ passed, exposureFingerprint, endpointFingerprint, version, at, promptTokens, cachedTokens, summary ≤ 200 }`), `eligibility.ts:49-66,88` (`CandidateFacts.surfaceReadiness`; `tools_unverified_surface` when the entry for `ctx.surface` matches the current fingerprint + version and `passed === false`), `gatewayCandidate.ts:150-200`, `registryView.ts:77-85` + shared `AiOfferingVerificationDto.surfaces: Record<AiSurface, { state: 'passed'|'failed'|'stale'|'absent'; at; promptTokens; cachedTokens; summary }>`, `refusals.ts`.

- [ ] Step 1: failing tests: `surface_turn runs once per assigned tool surface, chat first`; `superseded when config_version changes mid-run`; `superseded when the exposure fingerprint changes mid-run`; `FIDELITY_HARNESS_VERSION is still '1'`; `a failed chat readiness refuses chat only, not helper or script builder`; `absent or stale entry stays eligible`; `failed entry for an older fingerprint stays eligible`; `DTO shows per-surface state, "absent" for grandfathered records`.
- [ ] Step 2: run; FAIL. Step 3: implement. Step 4: PASS. Commit `feat(ai-models): per-surface verify with schema-identical stubs (#9596)`.

### Task 12: `refused_tool_batch` measurement, API + web

**Files:** Modify `gateway/failureNotes.ts:17`, `translateResponse.ts:262`, `translateStream.ts:211-218` (note `refused_tool_batch` with `describeRefusedToolCalls`), `streamingSessionManager.ts:2378-2380` (`refusalObservation.refusedToolBatch`; failure detail with the log-safe names; constrained profiles show "This model produced a tool call Breeze could not use. Try again, or ask a narrower question."), ledger failure code, `qualityQueries.ts:152,221,238-266` (`refused_tool_batches`, rate; group by `tool_profile`), shared `AI_QUALITY_GROUP_BYS += 'tool_profile'` + `AiQualityMetricsDto.refusedToolBatchRate`, `apps/web/src/components/settings/aiModels/AiQualityTable.tsx:20-26` (`GROUP_HEADER_KEYS.tool_profile`, new column), `AiUsageBreakdown.tsx:33` (`QUALITY_GROUP_LABEL_KEYS.tool_profile`), 8 × `locales/*/settings.json` (`aiModels.quality.groupBy.tool_profile`, `columns.refusedToolBatches`, `help.refusedToolBatches`).

- [ ] Step 1: failing tests: `translateResponse/translateStream: a refused batch notes refused_tool_batch with the names`; `constrained profile swaps the user message; full keeps the generic note`; `qualityQueries: group by tool_profile emits the column and rate`; web `AiQualityTable renders the tool_profile group and refused-batch column`; `localeParity`/`translationCoverage`.
- [ ] Step 2: run; FAIL. Step 3: implement. Step 4: PASS. Commit.

### Task 13: lab leg and PR

- [ ] Step 1: wt-stack lab: LM Studio 3–4B at 8k (#9596 shape) and a 131k model (#9770 shape). Per profile: prompt tokens (from `surface_turn` and the quality view), round-trip pass, refused-batch rate. Table in the PR body; it decides the OD-7 repair follow-up.
- [ ] Step 2: TS check, full `aiModels` + gateway suites, PR `W04`: Merge Danger — eligibility can refuse one surface for an offering whose `surface_turn` failed on it; records without one are unchanged. `pnpm wt-stack down`.

---

## W05 — drawer, locales, docs, E2E

### Task 14: API write validation over merged state

**Files:** Modify `offeringWrites.ts:294-370` (`updateOfferingDetails`: merge stored + patch, then enforce `custom ⇔ allowlist`, validate `toolAllowlist.tools` against `listBreezeDeclarations()` names → 422 `{ field: 'toolAllowlist', unknownTools }`; the DTO carries `droppedCustomNames` from a dry `resolveToolExposure` for chat), `routes/aiModels/offerings.ts:62-75`, `registryView.ts:110-170`.

- [ ] Step 1: failing tests: `patch { toolProfile: 'custom' } alone against a stored null allowlist → 422`; `patch { toolAllowlist } alone against stored 'standard' → 422`; `both together succeed`; `undeclared custom name → 422 unknownTools`; `clearing contextWindowOverride restores the discovered/observed value in the DTO`; route `PATCH accepts toolProfile standard`.
- [ ] Step 2: run; FAIL. Step 3: implement. Step 4: PASS. Commit.

### Task 15: "Tools and context" section, readiness, warnings, 8 locales

**Files:** Modify `OfferingDrawer.tsx` (fieldset after allowed options: profile select `ai-offering-tool-profile`; custom domains `ai-offering-tool-domain-<domain>`; custom tools `ai-offering-tool-list`; override `ai-offering-context-window`; facts `ai-offering-context-facts` — "Auto: minimal (window 8,192, observed 12 min ago)" / "Capacity unknown — nothing is constrained"; suggestion when an explicit profile cannot fit; `ai-offering-dropped-tools` warning listing `droppedCustomNames`; per-surface readiness rows `ai-offering-readiness-<surface>` with "Verified (basic). Re-verify to check a real tool round-trip on Chat." for `absent`; rule-3 copy "Set by the partner on the model. Organizations choose models; they cannot override this."), `OfferingDrawer.test.tsx`, 8 × `locales/*/settings.json` under `aiModels.offering.tools.*`.

- [ ] Step 1: failing tests: `capacity unknown when no window facts`; `auto shows the resolved profile and source`; `custom reveals domains and tools; switching to standard sends toolProfile and toolAllowlist: null together`; `dropped custom names render a warning`; `per-surface readiness renders passed/failed/absent copy`; `rule-3 copy present`; `save goes through runAction`; `localeParity`, `translationCoverage`, `settingsPageRegistry` green.
- [ ] Step 2: `cd apps/web && npx vitest run src/components/settings/aiModels/OfferingDrawer.test.tsx src/lib/i18n/localeParity.test.ts src/lib/__tests__/translationCoverage.test.ts src/lib/__tests__/settingsPageRegistry.test.ts`; FAIL on the new cases.
- [ ] Step 3: implement; translate (no English duplicates). Step 4: PASS. Commit `feat(web): tool profile and context window in the AI model drawer (#9596)`.

### Task 16: docs, E2E, PR

**Files:** Modify `apps/docs/.../features/bring-your-own-llm-key.mdx:152`, `apps/docs/.../deploy/environment.mdx:1164` (an OpenAI-compatible connection is not a Messages-API proxy; removal plan under #7429), `docs/release-notes/next-release-draft.md`, `e2e-tests/tests/byo-openai-compatible.spec.ts`, `e2e-tests/pages/PartnerAiModelsPage.ts`.

- [ ] Step 1: E2E (`data-testid` only, mock-llm stack): `set profile standard and override 32768, reload, values persist`; `auto shows capacity unknown before verify and the resolution after the mock reports a window`; `a chat turn on a minimal offering: the mock-llm's recorded request tools[] names equal exactly the curated chat minimal set ∪ { set_device_context } (set equality, non-empty) and include every SURFACE_REQUIRED_TOOLS.chat name`.
- [ ] Step 2: run against a wt-stack; FAIL before T15 is in the stack, PASS after.
- [ ] Step 3: PR `W05` with the **settings rule 9 table** (home: model drawer; level: partner, no org override — rule 3 exception stated in the UI; resolvers: `resolveToolExposure`, `resolveEffectiveContextWindow`; tool exposure 0 UI + 2 env → 1 UI + 2 env; context window 0 → 1), `Closes #9770`, `Part of #9596`. `pnpm wt-stack down`.

## Golden prompts / eval hooks

- `llm/toolEval/goldenPrompts.ts`: no new cases (no new tools). W03 T9's capture run also scores the existing chat golden set under `--profile minimal` and `--profile standard`; hit rates go in the PR body as the baseline (informational, no pin). Note `resolve_device_context` is outside `minimal`, so device-lookup goldens are expected to miss it there.
- `refused_tool_batch`: W04 T13 lab table (per profile: prompt tokens, round-trip pass, refused-batch rate); the quality view grouped by `tool_profile` is the ongoing measurement. Follow-up trigger: refused rate > 10 % on `minimal` after two weeks of self-hoster traffic → file the OD-7 single-repair issue.

## Follow-ups (not filed)

- OD-6 B: expand a constrained profile with `pageContextToolDomains` per session (fingerprint cost measured first).
- OD-7: one in-request repair attempt before any streamed text, if W04's numbers call for it.
- #7429: per-connection tool-search capability replacing `AI_TOOL_SEARCH`.
- Lower session `maxTurns` for constrained profiles if the quality view shows long sessions failing (spec §5).
- An alert-level read-only tool for `minimal` if `get_alert_correlations` proves too narrow for "what alerts are open".
