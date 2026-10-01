---
tracking_issue: LanternOps/breeze#7598
---

# AI Model Registry W03: `resolveModel` cutover, per-offering funding, single cost function — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Closes #7601

**Goal:** Every AI surface picks its model, endpoint, key, funding source, thinking/effort/speed/geo parameters and price through one resolver, `resolveModel`. Every model call is billed by one cost function, `priceInvocation`, from the rate snapshot the resolver bound before admission. Each call writes `ai_invocations` rows, and the session totals and `ai_cost_usage` rollups are derived from those rows in the same transaction.

**Architecture:**
- `resolveModel` is a thin orchestrator over four parts:
  1. W02's `getEffectiveAssignment` (tighten-only merge);
  2. a single DB adapter, `candidateLoader.ts`. It loads an offering, its platform row, its connection and the live catalog revision, and is the only file that knows W01/W02 row shapes;
  3. a pure rule table, `eligibility.ts`;
  4. W01's `buildWireParams`.
- **Connection half.** The result's `connection.config` is the existing `UsableLlmConfig` union, so `buildClaudeSdkChildEnv` and the client factory keep consuming the shape they already trust.
- **Client factory.** `connectionFactory.ts` becomes the only place that constructs an Anthropic client.
- **Billing.**
  - `invocationUsage.ts` turns SDK results and Messages API responses into per-model token components plus a refusal outcome. It never reads `total_cost_usd` for billing.
  - `settleInvocation.ts` prices those components with `priceInvocation` and writes the ledger rows. It writes them inside `settleAiBudgetReservation`'s existing transaction, which also derives the session/`ai_cost_usage` increments from the inserted rows.
- **Turn binding.** A turn's binding (offering, options, rate snapshot, connection identity, wire model) is written onto the budget reservation row in the reservation transaction, which is the durable turn claim. A live SDK query is reused only when the binding's live-query key is unchanged.
- **Cutover order.** Surfaces cut over one task at a time, each with a parity test against frozen legacy goldens. The hard-coded lists, `getLlmBillingSourceForOrg` and the legacy cost recorders are deleted last, behind an AST contract test.
- **Registry authority.** Each partner is projected from legacy config exactly once, gated in the resolver and run by a leased background sweep (Task 6A). After that, `/ai/provider` and agent-policy writes edit the registry directly (Tasks 6B, 12). Nothing re-projects a cut-over partner.
- **Money moves once.** A platform debit happens only on a reservation's first transition to `settled`, under a stable idempotency key. A settlement deferred by lock contention persists its priced rows and is replayed by the sweep (Task 6).

**Tech Stack:** Hono, Drizzle ORM on PostgreSQL (hand-written SQL migrations, forced RLS), BullMQ + Redis, `@anthropic-ai/claude-agent-sdk` `^0.3.286` (`query()`, `fallbackModel`, `model_refusal_fallback` / `model_refusal_no_fallback` system messages), `@anthropic-ai/sdk` `^0.128.0` (`beta.messages.create` with `fallbacks` + `server-side-fallback-2026-07-01`, `usage.iterations`, `stop_details`), Vitest (unit + real-Postgres integration), TypeScript compiler API (contract test).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-30-ai-model-registry-design.md` (v3): §7 (options, inference geo, prompt profile), §8, §9, §9.1, §9.1a, and the first two bullets of §9.2. Quorum findings #2, #4, #5, #7, #9, #10 and #14. **Names** come from `docs/superpowers/plans/ai-mcp/2026-09-30-ai-model-registry-index.md`, which is binding.

**Out of scope:**
- the settings UI, the AI-usage page and the PolicyEditor / reviewer-field replacement (W04);
- the chat picker, option controls, thinking progress, switching and the agent-policy picker (W05);
- BYO OpenAI-compatible, including the existing deployment-wide env-only `MCP_LLM_PROVIDER=openai-compatible` chat path in `services/llm/openaiSessionManager.ts`, which W06 absorbs;
- failover walks and escalation roles (W09);
- chargeback (W10);
- per-profile prompt tuning (W11);
- dropping `partner_llm_configs` and `ai_budgets.allowed_models` (W08).

---

## Preconditions from W01 and W02

W01 (#7599) and W02 (#7600) are merged. Their plans were written in parallel with this one:
- `2026-09-30-ai-model-registry-w01-platform-catalog.md`
- `2026-09-30-ai-model-registry-w02-schema-backfill.md`

The rows below name what this plan consumes. Where a name comes from those plans rather than the index, the row says so.

**Before Task 1, the executor verifies each row against merged `main`.** If a name or shape differs, change only the adapter named in the right-hand column and record the difference in the PR body. No other task touches W01/W02 shapes directly.

| # | What W03 consumes | Source | If it differs, adapt only |
|---|---|---|---|
| P1 | `packages/shared/src/validators/aiModelOptions.ts`: `offeringOptionsSchema`, `OfferingOptions`, `EFFORT_LEVELS`, `EffortLevel`, `OptionSupport`, `OptionRates`, `ModelRates`, `PROMPT_PROFILES`, `PromptProfile`, `MODEL_LIFECYCLES` | index + W01 Task 2 | — |
| P2 | `packages/shared/src/constants/aiSurfaces.ts`: `AI_SURFACES`, `AiSurface`, `AI_SURFACE_ROLES`, `TOOL_REQUIRING_SURFACES` | index | — |
| P3 | `services/aiModels/capabilities.ts`: `ThinkingMode`, `deriveCapabilities(raw): DerivedCapabilities` | index | — |
| P4 | `services/aiModels/wireParams.ts`:<br>• `buildWireParams(input): WireParams` (index).<br>• The transport adapters `toAgentSdkOptions(wire)` and `toMessagesApiParams(wire, { thinksWhenOmitted })`. **Both throw `UnsupportedWireOptionError`** for `thinkingDisplay:'updates'`, `speed` and `inferenceGeo` until W01's spike decisions D1–D3 enable a transport for them.<br>• `services/aiModel.ts`: `legacyThinksWhenOmitted(modelId)`.<br>• `services/aiModels/modelWireOptions.ts`: W01's per-model-id helpers `agentSdkWireOptions(modelId)` / `messagesApiWireOptions(modelId, maxTokens)`, which the surfaces call today. | W01 Task 4–5 | `transport.ts` (`transportCarries`), `connectionFactory.ts` (`sdkModelOptions`, `messagesModelParams`) |
| P5 | `services/aiModels/platformModels.ts`:<br>• `getPlatformModelById(id)`, `getPlatformModelByModelId(id)`, `getPlatformDefaultModel()`, `listOfferableModelIds()`.<br>• `type PlatformModel` with `rates: ModelRates \| null` (all four or null), `optionRates`, `optionSupport`, `minPlan`, `promptProfile`, `platformOffered`, `lifecycle`, `maxOutputTokens`, `capabilities`.<br>W01 has **no** platform inference-geo setting (its D3 is open), so Task 2 adds `getPlatformInferenceGeo()`, reading env `AI_PLATFORM_INFERENCE_GEO`. | W01 Task 6 | `candidateLoader.ts` |
| P6 | `services/aiModels/pricing.ts`: `RateSnapshot`, `TokenComponents`, `priceInvocation(rate, tokens, applied)` → cents (6 dp) | index | — |
| P7 | `services/aiModels/connections.ts`:<br>• `getConnection(id)`, `getConnectionKeyMaterial(id)` → `{ id, partnerId, apiKeyEncrypted } \| null`, `decryptConnectionKey(material)`, `createConnection(input)`.<br>• `type PartnerAiConnection` (no key material): `{ id, partnerId, kind, name, inferenceGeo, catalogEntryId, baseUrl, status, configVersion, lastDiscoveredAt, discoveryError, … }`.<br>• Drizzle `partnerAiConnections`. | W02 Task 7 | `candidateLoader.ts`, `discovery.ts` (Task 16) |
| P8 | `services/aiModels/offerings.ts`: `getOffering(id)`, `listOfferings(partnerId, opts?)`, `type Offering = PartnerAiModelRow`. The fields are `id, partnerId, connectionId, platformModelId, modelId, source, displayName, capabilities, priceInputCentsPerM, priceOutputCentsPerM, priceCacheReadCentsPerM, priceCacheWriteCentsPerM, enabled, defaultOptions, allowedOptions, requiredPermission, refusalFallbackOfferingId, lifecycle`; the jsonb fields are typed `Record<string, unknown>`. | W02 Task 3, 8 | `candidateLoader.ts` |
| P9 | `services/aiModels/assignments.ts`: `getEffectiveAssignment({ partnerId, orgId, surface, role? }): Promise<EffectiveAssignment>`, **never null**. The type is `{ defaultOfferingId, defaultSource: 'org'\|'partner'\|'none', permitted: PermittedSet, allowUserChoice, options: OfferingOptions, fallbackOfferingIds, … }`. Also `PermittedSet = { kind:'all' } \| { kind:'list'; offeringIds }` and `isPermitted(set, id)`. | W02 Task 9 | `resolveModel.ts` |
| P10 | `services/aiModels/invocationLedger.ts`: `recordInvocation(row: NewInvocation): Promise<string>`, written through the **ambient** `db`, so it joins the settlement transaction. `NewInvocation` holds spec §5.5's fields in camelCase plus W02's `ledgerMode: 'shadow' \| 'authoritative'` and `legacyCostCents`. The W02 shadow bridge (`LegacyCostEvent` emitted by the legacy recorders) goes quiet as each surface stops calling those recorders, and Task 17 deletes it. | W02 Task 5 + index | `settleInvocation.ts` (`toNewInvocations`). If `recordInvocation` opens its own context, Task 6 adds an `{ executor }` option. |
| P11 | W02 columns `ai_sessions.offering_id`, `ai_sessions.offering_partner_id` and `ai_sessions.options`, and `ai_agents.offering_id` / `offering_partner_id`. The frozen `policySnapshot.effective` carries `offeringId`. W02 Task 6 defers three things to W03:<br>• run-time permitted-set checking of explicit policy offerings (Task 12 Step 5–6);<br>• write-time binding of `ai_agents.model` to `offering_id`, checked against the `ai_agents` permitted set (Task 12 Step 7A);<br>• dropping the stale `ai_sessions.model` default (Task 9 Step 5A).<br>Also consumed: W02 Task 8's connection-scoped `findOfferingIdForModel({ partnerId, connectionId, modelId })`, used by Task 2's `findOfferingIdByModel`. | W02 Task 6, 8 | Task 2, 9, 12 |
| P12 | **W02's legacy projection stays live through W03:**<br>• `legacyReconcile.ts`: `reconcileAllPartnersFromLegacy()`, `reconcilePartnerFromLegacy(partnerId)`, `readLegacyProjectionEnv()`.<br>• Its pickers in `legacySurfaceModels.ts` (`legacyExtensionModel`, `legacyReviewerModel`, `legacyOfficeChatModel`, `legacyAgentModel`, `EXTENSION_AI_DEFAULT_MODEL`).<br>• `config/env.ts` `resolveReviewerDefaultModel(env)`.<br>• `aiCostTracker.getLegacyModelRates`.<br>W02's handoff item 1 asks for `reconcileAllPartnersFromLegacy()` **blocking before `serve()`**. The Codex review (findings 7, 8, 10) showed that barrier is unsafe. Task 6A replaces it: `reconcilePartnerFromLegacyInTx(partnerId)` runs once per partner, durably, gated in the resolver, with a leased background sweep. W02's `reconcileAllPartnersFromLegacy` is no longer called, and its detached per-boot sweep in `index.ts` is deleted. | W02 Task 1, 11, 12 | Task 6A, Task 11, Task 13, Task 17 |
| P13 | The W02 parity harness in `services/aiModels/parity/`:<br>• `PARITY_FIXTURES`, `parityQueries(fixture)` and `legacySurfaceUse(fixture, query)` (the REAL legacy code; the caller mocks DB reads the way W02's `parity.test.ts` does).<br>• `SurfaceUse`, `ParityQuery` and `EXPECTED_DIVERGENCES` (two entries).<br>• `buildDesiredRegistryState`, `materializeDesiredState(desired, fixture): RegistrySnapshot` and `readLegacyProjectionEnv` from W02's projection.<br>• `mergeEffectiveAssignment` from `assignments.ts`. | W02 Task 10–11 | `parity/w03Parity.ts`, `parity/registrySnapshotDeps.ts` (Task 1) |
| P14 | Integration fixtures: `__tests__/integration/db-utils.ts` `createPartner()` / `createOrganization({ partnerId })`; W02's `__tests__/integration/aiModelRegistryFixtures.ts` `seedPlatformModel()`, `seedOffering({ partnerId, platformModelId, enabled })` and `fixtureSql`; every integration file starts with `import './setup'`. | repo + W02 Task 4 | `helpers/aiModelRegistrySeed.ts` (Task 2) |
| P15 | W01's discovery worker in `apps/api/src/jobs/aiModelDiscoveryWorker.ts` (not the index's `workers/` path; W01 followed the `jobs/` convention):<br>• `AiModelDiscoveryJobData = { type: 'sync-platform'; trigger }`, `processAiModelDiscoveryJob(job)` switching on `job.data.type`;<br>• `getAiModelDiscoveryQueue()`, `scheduleAiModelDiscoveryJobs()`;<br>• `discoverAnthropicModels(apiKey: string \| undefined)`. | W01 Task 7–8 | Task 16 |

## Required W02 plan changes

The Codex review of this plan (findings 7–10) changes three of W02's handoff items. This plan does **not** edit the W02 plan; the W02 owner applies these before W02 executes. Item numbers refer to W02's "Handoff to W03 (binding)" section.

| # | W02 location | Change | Why (W03 task) |
|---|---|---|---|
| R1 | Handoff item 1; Architecture paragraph ("made exact by W03's blocking cutover reconcile"); Task 12 "Ownership in W02" note ("W03 stops the boot sweep first") | Replace "run `reconcileAllPartnersFromLegacy()` blocking before `serve()` and fail the boot on failures" with this: W03 calls `reconcilePartnerFromLegacyInTx(partnerId)` **once per partner**, inside its own system transaction, together with a durable per-partner cutover row. It is gated in `resolveModel` and run by a leased background sweep. W03 deletes W02's detached boot sweep. | A blocking boot sweep exceeds the 40 s health grace (finding 10). It leaves the split worker ungated (`worker.ts`, finding 7), and replicas race on one marker (finding 8). See Task 6A. |
| R2 | Task 12 interface for `reconcilePartnerFromLegacyInTx` | State that it **throws** on any failure and never returns a partial report. It must not open, commit or roll back a transaction of its own (it already joins the caller's). | W03 inserts the cutover row in the same transaction. A swallowed failure would mark a half-projected partner as cut over (Task 6A). |
| R3 | Handoff item 2; Task 13 (facade) | "Writes move to the registry" becomes: W03 replaces the facade's legacy + reconcile write with **registry-native id remaps** (connect / disconnect / change default model), never a re-projection. It also drops the Task 2 mirror trigger. W02 Task 13's integration cases that assert the legacy row or trigger round trip are rewritten by W03. | Re-running the projection after the flip would revert registry-native edits (finding 9). See Task 6B. |
| R4 | Handoff item 3; Task 1 interface (`getLegacyModelRates` "Deleted with the legacy cost path in W03") | `getLegacyModelRates` and its rate table **move** to `legacySurfaceModels.ts` in W03. W08 deletes them, not W03. | Task 6A's cutover of a not-yet-cut-over partner still runs W02's projection (Task 10/12), which prices manual offerings with it. See Task 17. |
| R5 | Handoff item 7 | Replace "W03 meters it through `resolveModel`" with: W03 routes `patch_test` through `resolveModel` and the connection factory. It stays **unmetered** by design (#5557): it has no `org_id`, so no ledger row is possible. | Task 14. |
| R6 | Task 11 (parity harness) | Export two helpers instead of leaving them local to `parity.test.ts`: the per-fixture `LegacyProjectionEnv` builder (`projectionEnvFor(fixture)`) and the per-fixture legacy mock binder. Keep `materializeDesiredState` / `projectSurfaceUse` exported from `storeProjection.ts`. | W03's goldens test and `registrySnapshotDeps.ts` must reproduce exactly W02's binding (Tasks 1, 7). `projectSurfaceUse` is the exact expected tuple for declared divergences (finding 13). |

**Cross-repo (not W02):** the billing service's `ai-credits/deduct` endpoint must honour the `idempotencyKey` that Task 6 Step 8a sends. Until it does, a debit retried after a lost response can double-charge, so the billing change ships first.

## Global Constraints

- **Rigor: high.** This touches billing, funding, secrets and customer-visible cost. Every task is TDD: write the assertion, watch it fail for the stated reason, then implement.
- **Binding names** (index): `resolveModel(input: ResolveModelInput): Promise<ResolveModelResult>`; `priceInvocation`; `recordInvocation`; `syncConnectionModels(connectionId)`; queue `ai-model-discovery`. The index's job id `sync-connection:{id}` is realized as **job name `sync-connection` with BullMQ jobId `sync-connection-${connectionId}`**: BullMQ 5.81 throws `Custom Id cannot contain :` for any colon id that does not split into exactly 3 parts (`bullmq/dist/cjs/classes/job.js:1067-1077`).
- **No hard-coded models.** After Task 17, no `'claude-<family>-<n>'` string literal exists outside `services/aiModel.ts` (bootstrap fallback), `ai_platform_models` seed migrations and test files. No `new Anthropic(` exists outside `services/aiModels/connectionFactory.ts`. Task 17 adds the AST contract test.
- **One cost function.** `priceInvocation(rateSnapshot, tokens, appliedOptions)` is the only number billed. The SDK's `total_cost_usd` and `modelUsage[*].costUSD` are copied into `ai_invocations.sdk_reported_cost_usd` and nowhere else. After Task 17, a contract test rejects any `total_cost_usd` read outside `services/aiModels/invocationUsage.ts`.
- **Funding comes from the resolved offering, decided before admission.** Platform offering → `platform`; any connection offering → `partner_key`. `checkBudget` / `checkBudgetDetailed` / `checkBillingCredits` / `reserveAiBudget` / `settleComputeCents` receive `resolved.funding` (or the run's persisted `funding_source`). `getLlmBillingSourceForOrg` is deleted in Task 15.
- **Platform-key traffic is never priced from a non-platform rate, and an unpriced model is never dispatched** (index invariant 5). `resolveModel` returns `ok:false, reason:'unpriced'` rather than a result without a rate.
- **Nothing crosses a connection or a funding source implicitly.** The bounded fallback (§9.1) and the refusal fallback both require the same connection id and the same funding.
- **Migrations.** There are exactly seven new files, each named to sort after the newest **committed** migration at commit time. Check `git ls-tree --name-only origin/main apps/api/migrations | grep -E '/[0-9]{4}-' | sort | tail -1` before each commit and bump the date if W01/W02 or later work sorts after it. The names below assume nothing on `main` sorts after `2026-11-19`:
  - `apps/api/migrations/2026-11-19-100000-ai-budget-reservation-model-binding.sql` (Task 6: `model_binding`, `pending_settlement`, `credits_debited_at`)
  - `apps/api/migrations/2026-11-19-100100-ai-models-premium-permission.sql` (Task 2)
  - `apps/api/migrations/2026-11-19-100200-ai-agent-runs-blocked-funding.sql` (Task 12: `blocked`, `funding_source`, `admitted_offering_id`)
  - `apps/api/migrations/2026-11-19-100300-partner-ai-models-discovery-state.sql` (Task 16)
  - `apps/api/migrations/2026-11-19-100400-ai-model-registry-cutover.sql` (Task 6A)
  - `apps/api/migrations/2026-11-19-100500-drop-partner-llm-configs-mirror-trigger.sql` (Task 6B)
  - `apps/api/migrations/2026-11-19-100600-ai-sessions-model-drop-default.sql` (Task 9)

  All seven are idempotent (`IF NOT EXISTS`, `DROP … IF EXISTS` then re-add, existence-guarded inserts). None has an inner `BEGIN`/`COMMIT`. A file that writes rows elects `set_config('breeze.scope','system',true)` first. Only two write rows: the permission file and the cutover file's singleton insert.
- **Registry cutover (replaces W02 handoff item 1; see "Required W02 plan changes").**
  - Each partner is projected from legacy config **exactly once**, durably, inside one transaction with its `ai_model_registry_partner_cutover` row (Task 6A). It is never projected again.
  - The gate is in `resolveModel` (`registry_unavailable` until the partner is cut over) and in every registry-native write (the `/ai/provider` facade, agent model binding, the legacy session-model lookup). It is not a boot barrier, so the API, the split worker and any future consumer are all gated.
  - A coordinator-leased background sweep cuts every partner over after `serve()` / `startRegisteredWorkers`, resumable, with monotonic completion. `/health` is never blocked.
  - **Authority flip (Task 6B).** `/ai/provider` writes the registry natively (connect / disconnect / default-model remaps by offering id) and no longer writes `partner_llm_configs`. The mirror trigger is dropped. Nothing re-projects a cut-over partner.
  - **No task may break `legacyReconcile.ts` or its inputs** before W08 deletes them: the pickers, the reviewer default and the legacy rate table. The cutover of a partner that has not been cut over yet still needs them.
  - **Legacy policy fields stop routing at cutover.** `ai_script_policies.reviewer_model`, Office `allowedModels` and `ai_budgets.allowed_models` were projected once, and their editors stay live until W04 replaces them. An edit made between this wave's release and W04's has no routing effect. Agent `model` is the exception: Task 12 binds it at write time. Release W03 and W04 together, or treat the gap as known (Self-review).
- **Transport carriage.** W01's adapters refuse `speed`, `inferenceGeo` and `thinkingDisplay:'updates'` until its spike enables them. `resolveModel` therefore clamps option support to what the dispatch transport can carry (`transportCarries`, Task 4) **before** building wire params. A fast-mode rate is never bound to a turn that cannot send fast mode. Residency fails closed when the geography cannot be carried.
- **Export policy fires on new columns.** Each new column on an org-cascade table gets a `CORE_TENANT_EXPORT_POLICY` classification in the same task:
  - `ai_budget_reservations.model_binding` and `.pending_settlement` (jsonb → `excludedOpen`), `.credits_debited_at` (→ `included`), Task 6;
  - `ai_agent_runs.funding_source` and `.admitted_offering_id` (→ `included`), Task 12.

  `partner_ai_models` is partner-axis with no `org_id`, so its new columns need no export entry. There are two new tables, both in Task 6A:
  - `ai_model_registry_state` is a system singleton with no tenant column. It goes in the `rls-coverage` system-table allowlist (like `llm_provider_catalog`).
  - `ai_model_registry_partner_cutover` is partner-axis (shape 3, forced RLS). It goes in `PARTNER_TENANT_TABLES` and cascades from `partners` by FK.

  Neither has an `org_id`, so no org cascade, merge or export list applies.
- **DB contexts.** Request code uses the ambient request `db`. Reservation and settlement keep their own `runOutsideDbContext(() => withSystemDbAccessContext(...))` transaction, and the ledger insert happens **inside** it. The resolver's DB reads use `runOutsideDbContext(() => withSystemDbAccessContext(...))`, like `llmConfigResolver.ts` today, so they never hold a second pooled connection under a request transaction for longer than one read. Never call `resolveModel` while holding a row lock.
- **Permission gate.** It applies only to user-initiated calls, meaning `userId` is a Breeze `users.id`. Office client users (portal), helper (device), agents, the reviewer, system-initiated enrichment and patch tests pass no `userId`.
- **Public repo.** No IPs, hostnames or infrastructure detail, and no description of unfixed vulnerabilities, in code, comments, commits or the PR.
- **Tests.** Tests sit alongside source. Real-Postgres suites go under `apps/api/src/__tests__/integration/`.
  - Unit: `cd apps/api && npx vitest run <path>`. Never `pnpm --filter … test -- --run`.
  - Integration: `pnpm test-stack up` once, then `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`. Run `pnpm test-stack down` when finished.
  - RLS coverage: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`.
  - Typecheck: `cd apps/api && npx tsc --noEmit -p tsconfig.json`.
- **Commits.** One per task, conventional message, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on `feature/7598-ai-model-registry/wave-7601`, never on `main`. Call `start_wave` before Task 1.

## Review Focus

These are the five input classes most likely to bite. Each has a pinning test in the task named.

1. **A stored choice goes ineligible between turns.** The offering is disabled, the platform row un-offered or retired, the partner downgrades below `min_plan`, the BYOK key flips to `status='error'`, a catalog revision delists the model, or residency is switched on. The turn must take the bounded fallback only when it is the same connection and funding; otherwise it returns a recoverable `ok:false`. It never silently crosses to the platform key. Pinned by:
   - Task 3: `resolveModel` table, "stored session offering disabled → falls back to default on same connection"; "→ refuses when the default is on a different connection"; "→ refuses when the default changes funding".
   - Task 7: chat turn on a disabled offering streams the "no longer available" error and creates no reservation.
   - Task 12: agent run ends `blocked` / `model_unavailable` and notifies once per day.
   - Task 2: integration, "catalog revision rotated to drop the model → catalog unusable on the very next load" and "BYOK key flipped to status error → connection unusable on the very next load".
   - Task 3: integration, "hosted plan below the platform row's min_plan → plan_required" and "residency required with no geography → residency_unavailable".
2. **The SDK reports a cost that disagrees with the registry.**
   - A positive-but-wrong `total_cost_usd` must not leak into billing.
   - A zero `total_cost_usd` on a newly discovered model must not leak into billing.
   - A cumulative `modelUsage` on a resumed session must not leak into billing.

   All three bill the registry rate. Pinned by:
   - Task 5: `invocationUsage` table;
   - Task 6: "SDK says $9.99, registry says $0.012 → ledger + rollup + credits all $0.012" and "SDK says $0 on a model added by today's discovery → billed at its platform rate";
   - Task 7: the chat `result` case asserts `settleInvocation` gets no SDK cost field.

   The registry number must also be **debited exactly once** (review findings 1–2):
   - a repeated settlement must not debit twice;
   - a settlement deferred by lock contention must not be lost or debited early;
   - a failed debit call must not go unretried.

   Pinned by Task 6 Step 8a: "a repeated settlement of the same reservation debits once, with the reservation key", "a deferred settlement debits nothing now", "a rejected debit is not stamped", and the integration case "lock contention twice → rows persisted pending, not lost; the sweep replays ledger + rollups exactly once".
3. **Refusals.**
   - A refusal with no fallback configured.
   - A refusal where the fallback served the turn.
   - A fallback used because of overload rather than refusal.
   - A refusal category of `null`.

   Pinned by:
   - Task 5: SDK `model_refusal_fallback` / `model_refusal_no_fallback` messages and the Messages API `stop_reason:'refusal'` with and without `usage.iterations`;
   - Task 8: chat persists "The model declined this request (category: cyber)." plus alternatives, or "(category: unspecified)" for a `null` category, and never an empty answer;
   - Task 12: `blocked` / `model_refused` with the category in `outcome`.
4. **Concurrency around the turn claim.**
   - Two messages race on one session.
   - The connection's `config_version` bumps while a live Office query exists.
   - The reservation fails after `resolveModel` succeeded.

   The binding and the reservation must land together or not at all. A live query must never be reused across a rotation. Pinned by:
   - Task 6: integration, "binding is written in the reservation transaction; a forced failure after insert leaves neither";
   - Task 4: `liveQueryKey` differs on each of connection id / config_version / revision / wire model / wire fingerprint;
   - Task 7: idle Office session with a bumped `config_version` is recreated, and a processing one is left for the 409 path.
   - A stable-key retry (agent runs) whose binding changed must re-bind its unsettled reservation, never bill the old rate (finding 4). Pinned by Task 6 integration "a stable-key replay after a rate change re-binds the active reservation before dispatch". An agent run must dispatch on the offering and funding admission checked (finding 6). Pinned by Task 12 "re-resolves the ADMITTED offering".
   - Two replicas booting at once must cut each partner over exactly once (finding 8). Pinned by Task 6A's lease and partner-row integration cases.
5. **Cross-partner or forged offering ids.** A user can send another partner's offering id, a disabled offering, an offering outside the permitted set, or a premium offering without the permission. Each must give `not_permitted` / `permission_required` with no detail about the foreign offering, and nothing may be stored on the session. Pinned by:
   - Task 3: the table;
   - Task 2: integration, "an offering owned by partner B is invisible when resolving for partner A";
   - Task 3: integration, "a user cannot request another partner's offering";
   - Task 9: `POST /ai/sessions` 400 cases.

---

## File Structure

**Create**

| Path | Responsibility |
|---|---|
| `apps/api/src/services/aiModels/eligibility.ts` | Pure eligibility rule table (spec §9 step 2) + plan ordering |
| `apps/api/src/services/aiModels/eligibility.test.ts` | One table row per rule |
| `apps/api/src/services/aiModels/candidateLoader.ts` | The only adapter over W01/W02 rows. Loads an offering → `LoadedCandidate` with its connection resolved **live** (key, catalog revision), plus partner facts and the user-permission predicate |
| `apps/api/src/services/aiModels/candidateLoader.test.ts` | Mapping, rate precedence, catalog live resolution, key failure |
| `apps/api/src/services/aiModels/promptProfiles.ts` | `PROMPT_PROFILES`, `PromptProfile`, `applyPromptProfile` (v1 identity hook, §7) |
| `apps/api/src/services/aiModels/resolveModel.ts` | `resolveModel` (index), the bounded fallback, option resolution, the refusal fallback and the rate snapshot |
| `apps/api/src/services/aiModels/resolveModel.test.ts` | Table-driven resolver tests |
| `apps/api/src/services/aiModels/connectionFactory.ts` | Sole `new Anthropic(`, plus `anthropicClientFor`, `sdkModelOptions`, `messagesModelParams`, `describeDispatch` |
| `apps/api/src/services/aiModels/connectionFactory.test.ts` | Credential pinning, catalog guarded fetch, params, dispatch facts |
| `apps/api/src/services/aiModels/turnBinding.ts` | `TurnBinding`, `turnBindingFrom`, `liveQueryKey`, `parseTurnBinding` |
| `apps/api/src/services/aiModels/turnBinding.test.ts` | Key sensitivity + round-trip |
| `apps/api/src/services/aiModels/invocationUsage.ts` | Pure: SDK result / Messages API response → `BilledUsage[]` + `TurnOutcome` |
| `apps/api/src/services/aiModels/invocationUsage.test.ts` | Cost-disagreement + refusal table |
| `apps/api/src/services/aiModels/settleInvocation.ts` | `priceUsage`, `costEstimator`, `settleInvocation`: the single billing path |
| `apps/api/src/services/aiModels/settleInvocation.test.ts` | Pricing + settlement wiring |
| `apps/api/src/services/aiModels/refusals.ts` | §9.1a user-facing refusal text + alternatives + docs link |
| `apps/api/src/services/aiModels/refusals.test.ts` | Message shape, `null` category |
| `apps/api/src/services/aiModels/sessionModel.ts` | `resolveSessionTurn` (Task 7); `chooseSessionModel` for session creation (`requested` → `resolveModel`, legacy `model` → offering on the surface default's connection) and `InvalidSessionModelError`, moved from W00's `aiOfferableModels.ts` (Task 9) |
| `apps/api/src/services/aiModels/sessionModel.test.ts` | Validation table |
| `apps/api/src/services/aiModels/aiModelRegistry.contract.test.ts` | AST contract: model literals, `new Anthropic(`, `buildWireParams(`, `total_cost_usd` |
| `apps/api/src/services/aiAgents/modelBlocked.ts` | Blocked-run outcome + once-per-agent-per-day notification |
| `apps/api/src/services/aiAgents/modelBlocked.test.ts` | Dedupe key per day, outcome shape |
| `apps/api/src/services/aiModels/parity/w03Goldens.json` | Frozen `legacySurfaceUse` for every W02 fixture × query (Task 1) |
| `apps/api/src/services/aiModels/parity/w03Goldens.test.ts` | Proves goldens = live legacy before deletion (Task 1); retired in Task 15 |
| `apps/api/src/services/aiModels/parity/w03Parity.ts` | `queryKey`, `toSurfaceUse`, `assertSurfaceParity`: the REAL `resolveModel` vs frozen goldens under W02's comparison rule + `EXPECTED_DIVERGENCES` |
| `apps/api/src/services/aiModels/parity/registrySnapshotDeps.ts` | Backs the resolver's data adapters with W02's materialized `RegistrySnapshot` (the one coupling point to W02's snapshot shape) |
| `apps/api/src/services/aiModels/parity/w03Surfaces.parity.test.ts` | One `describe` per surface (Tasks 7, 10–14 append): chat/topology + sessions, helper, script_builder, office_chat, ticket draft, office_ticket, script_reviewer, ai_agents, catalog_enrichment, extension_content, patch_test; plus the mutation self-tests that must fail (finding 13) |
| `apps/api/src/__tests__/integration/helpers/aiModelRegistrySeed.ts` | `seedRegistryPartner(kind)`: a real partner/org/user + connection/offering/assignments/chat session for integration tests |
| `apps/api/src/services/aiModels/registryCutover.ts` (+ `.test.ts`), `registryCutoverStore.ts` | Task 6A: per-partner once-only cutover, the resolver/write gate, the leased resumable background sweep |
| `apps/api/src/db/schema/aiModelRegistryCutover.ts` | `aiModelRegistryState`, `aiModelRegistryPartnerCutover` |
| `apps/api/src/__tests__/integration/aiModelRegistryCutover.integration.test.ts` | Concurrent sweeps, resume after interruption, on-demand partner cutover, monotonic completion |
| `apps/api/migrations/2026-11-19-100400-ai-model-registry-cutover.sql` | `ai_model_registry_state` singleton (system table) + `ai_model_registry_partner_cutover` (partner-axis, forced RLS) |
| `apps/api/src/services/aiModels/compatRemap.ts` (+ `.test.ts`) | Task 6B: registry-native `/ai/provider` writes (connect / disconnect / default model) as offering-id remaps |
| `apps/api/src/__tests__/integration/aiProviderAuthority.integration.test.ts` | The facade edits the registry, never re-projects it; the legacy table is not written; the mirror trigger is gone |
| `apps/api/migrations/2026-11-19-100500-drop-partner-llm-configs-mirror-trigger.sql` | Drops W02's `partner_llm_configs_mirror_to_connection` (W02 handoff #2) |
| `apps/api/migrations/2026-11-19-100600-ai-sessions-model-drop-default.sql` | Drops the stale `ai_sessions.model` default (W02 handoff #5) |
| `apps/api/src/services/aiAgents/agentModelBinding.ts` (+ `.test.ts`) | Write-time agent policy model → offering, checked against the `ai_agents` permitted set (W02 handoff #5) |
| `apps/api/src/__tests__/integration/resolveModel.integration.test.ts` | Live catalog revision, forged ownership, plan/residency against real rows |
| `apps/api/src/__tests__/integration/aiInvocationSettlement.integration.test.ts` | Ledger ≡ rollups, binding atomicity, SDK-cost regression |
| `apps/api/src/__tests__/integration/aiModelConnectionDiscovery.integration.test.ts` | BYOK/catalog discovery lifecycle against real rows |
| `apps/api/src/services/aiModels/__fixtures__/resolvedModel.ts` | `makeResolvedModel(kind, over)` shared by the surface tests |
| `apps/api/src/services/__testUtils__/streamingSessionManagerHarness.ts` | `scriptedQuery`, `baseDbSession`, `baseAuth`, `insertedAssistantMessages` (factored out of the `.usage` suite) |
| `apps/api/src/services/streamingSessionManager.modelBinding.test.ts` | Manager seam: SDK options, live-query rotation, registry-priced settlement, refusals |
| `apps/api/src/routes/ai.modelResolution.test.ts` | Chat turn on an ineligible model: 409, no reservation; reservation carries funding + binding |
| `apps/api/migrations/2026-11-19-100000-ai-budget-reservation-model-binding.sql` | `ai_budget_reservations.model_binding jsonb` |
| `apps/api/migrations/2026-11-19-100100-ai-models-premium-permission.sql` | Seeds `ai_models:premium` (granted to no role) |
| `apps/api/migrations/2026-11-19-100200-ai-agent-runs-blocked-funding.sql` | `ai_agent_runs` `blocked` status + `funding_source` |
| `apps/api/migrations/2026-11-19-100300-partner-ai-models-discovery-state.sql` | `partner_ai_models.last_seen_at`, `missed_sync_count` |

**Modify** (by task)

| Path | Task | Change |
|---|---|---|
| `packages/shared/src/constants/permissions.ts`, `apps/api/src/db/seed.ts` (`DEFAULT_PERMISSIONS`) | 2 | `AI_MODELS_PREMIUM` |
| `packages/shared/src/types/index.ts` | 2 | `PartnerSettings.ai?: { residencyRequired?: boolean }` |
| `apps/api/src/services/partnerLlmConfig.ts` (or W02's connection probe), `apps/api/src/services/llm/providerFidelityHarness.ts`, W01 `discovery.ts` | 4 | Use `createAnthropicClient` |
| `apps/api/src/services/aiBudgetReservations.ts`, `apps/api/src/db/schema/ai.ts` | 6 | `binding` on reserve; `invocations` on settle; rollups derived from ledger rows |
| `apps/api/src/index.ts`, `apps/api/src/worker.ts`, `apps/api/src/db/schema/index.ts`, `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, `services/aiModels/resolveModel.ts`, `eligibility.ts` | 6A | Background cutover sweep after `serve()` / `startRegisteredWorkers` (W02's detached reconcile deleted); the two new tables in the RLS allowlists; the `registry_unavailable` gate |
| `apps/api/src/services/partnerLlmConfig.ts`, `apps/api/src/services/llm/llmConfigResolver.ts` | 6B | The `/ai/provider` facade writes the registry natively; the legacy resolver reads the compat connection |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | 6, 12 | Two column classifications |
| `apps/api/src/services/streamingSessionManager.ts` | 7, 8 | `getOrCreate(…, resolved: ResolvedModel …)`; live-query key; `result` → `settleInvocation`; refusal handling |
| `apps/api/src/services/aiAgentSdk.ts` | 7 | `runPreFlightChecks` resolves the session turn and checks the budget with `resolved.funding` |
| `apps/api/src/routes/ai.ts` | 7, 9, 10 | Chat/topology turn claim; session create; ticket draft |
| `apps/api/src/routes/helper/index.ts` | 7, 9 | `helper` turn + session create |
| `apps/api/src/routes/scriptAi.ts`, `apps/api/src/services/scriptBuilderService.ts` | 7, 9 | `script_builder` turn + session create |
| `apps/api/src/routes/clientAi/sessions.ts`, `apps/api/src/services/clientAiSessions.ts` | 7, 9 | `office_chat` turn + session create |
| `apps/api/src/services/aiAgent.ts`, `packages/shared/src/validators/ai.ts`, `packages/shared/src/types/ai.ts` | 8, 9 | `model_refusal` stream event; session create via `sessionModel.ts`; `offeringId` / `options` in body |
| `apps/api/src/routes/officeAddin/tickets.ts`, `apps/api/src/services/officeAddin/aiEmailDraft.ts`, `apps/api/src/services/aiTicketDraft.ts` | 10 | `office_ticket` + ticket draft |
| `apps/api/src/services/scriptProposals/reviewer.ts`, `scriptProposals/policy.ts`, `services/system/connections/registry.ts` | 11 | `script_reviewer` surface; the reviewer env var deprecated (no longer read at runtime; `config/env.ts` keeps it for W02's projection) |
| `apps/api/src/services/aiAgents/runLoop.ts`, `runService.ts`, `agentCircuit.ts`, `analysisAdmission.ts`, `agentService.ts`, `apps/api/src/routes/aiAgents.ts`, `packages/shared/src/types/aiAgents.ts`, web run-status maps + locales | 12 | `ai_agents` surface; admitted offering persisted on the run; write-time model binding |
| `apps/api/src/db/schema/ai.ts` (`aiSessions.model`), integration inserts that relied on its default | 9 | Default dropped |
| `apps/api/src/services/catalogEnrichmentService.ts`, `apps/api/src/services/extensionAi.ts`, `ee/workspace/src/services/enrichmentService.ts` | 13 | `catalog_enrichment`, `extension_content` |
| `apps/api/src/services/aiPatchTestRunner.ts` | 14 | `patch_test` via the factory |
| `apps/api/src/services/llm/llmConfigResolver.ts`, `apps/api/src/services/aiBudgetAlerts.ts`, `apps/api/src/services/aiCostTracker.ts` (`getUsageSummary`), W02 parity harness | 15 | `getLlmBillingSourceForOrg` deleted; funding labels from the resolver / ledger rollup; goldens test retired |
| W01 discovery + worker, W02 `connections.ts` | 16 | `syncConnectionModels`, `enqueueConnectionSync` |
| `apps/api/src/services/aiCostTracker.ts`, `aiOfferableModels.ts` (deleted), `llmConfigResolver.ts` (`resolveWireModel`, `getAnthropicClientForPartner`, `buildAnthropicClient` deleted), `routes/aiProvider.ts`, `llmProviderCatalog.ts`, `partnerLlmConfig.ts`, `apps/web/src/components/admin/LlmProviderCatalog.tsx`, `db/schema/ai.ts` | 17 | Delete the hard-coded lists and legacy recorders |
| `apps/docs/src/content/docs/features/ai.mdx`, `apps/docs/src/content/docs/deploy/environment.mdx` | 8, 11, 13 | Refusal docs section; removed env vars |

---

## Task 1: Freeze the legacy surface-use goldens from W02's parity oracle (unit, before anything changes)

The per-surface parity tests (Tasks 7–14) reuse W02's harness (P13). They compare the **real** `resolveModel` against what the legacy code did, for every W02 fixture shape and query. Two things make that hard once the cutover starts:
- W02's oracle `legacySurfaceUse(fixture, query)` calls the real legacy functions (`resolveLlmConfig`, `resolveWireModel`, `getLlmBillingSourceForOrg`, the pickers);
- Task 15 and Task 17 delete them.

So this task records the oracle's answers first, as a committed JSON golden, with a test proving the golden equals live legacy behaviour. Task 15 retires that test together with W02's `legacyOracle.ts`.

W02's `harness.ts` survives the deletion: `runParity` takes the legacy side as a parameter. W03 passes "look up the golden" as that side and keeps W02's `sameUse` and `EXPECTED_DIVERGENCES` unchanged.

**Files:**
- Create: `apps/api/src/services/aiModels/parity/w03Goldens.json` (starts as `{}`)
- Create: `apps/api/src/services/aiModels/parity/w03Goldens.test.ts`
- Create: `apps/api/src/services/aiModels/parity/w03Parity.ts` (goldens half; Task 7 appends the comparison half), `apps/api/src/services/aiModels/parity/w03Parity.test.ts`

**Interfaces:**
- Consumes (W02, P13): `PARITY_FIXTURES` (`parity/fixtures.ts`); `parityQueries`, `type SurfaceUse`, `type ParityQuery` (`parity/harness.ts`); `legacySurfaceUse` (`parity/legacyOracle.ts`).
- Produces:
  ```ts
  export const W03_GOLDENS_PATH: string;
  export type W03Goldens = Record<string /* fixture.name */, Record<string /* queryKey */, SurfaceUse>>;
  export function queryKey(q: ParityQuery): string;
  export function loadW03Goldens(): W03Goldens;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/aiModels/parity/w03Parity.test.ts
import { describe, expect, it } from 'vitest';
import { queryKey } from './w03Parity';

describe('w03Parity helpers', () => {
  it('query keys are stable and distinct per kind', () => {
    expect(queryKey({ kind: 'surface', surface: 'chat', orgId: 'o1' })).toBe('surface:chat:o1');
    expect(queryKey({ kind: 'agent', agentKind: 'triage', orgId: 'o1' })).toBe('agent:triage:o1');
    expect(queryKey({ kind: 'session', sessionId: 's1' })).toBe('session:s1');
  });
});
```

```ts
// apps/api/src/services/aiModels/parity/w03Goldens.test.ts
// Copy the hoisted vi.mock block from W02's parity/parity.test.ts VERBATIM here
// (it mocks the legacy oracle's DB reads per fixture). Then:
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PARITY_FIXTURES } from './fixtures';
import { parityQueries } from './harness';
import { legacySurfaceUse } from './legacyOracle';
import { W03_GOLDENS_PATH, loadW03Goldens, queryKey, type W03Goldens } from './w03Parity';

describe('W03 legacy goldens (frozen before the cutover deletes the legacy code)', () => {
  it('every W02 fixture × query matches the committed golden', async () => {
    const live: W03Goldens = {};
    for (const fixture of PARITY_FIXTURES) {
      // The same per-fixture DB-read binding W02's parity.test.ts performs.
      bindLegacyFixture(fixture);
      live[fixture.name] = {};
      for (const query of parityQueries(fixture)) {
        live[fixture.name]![queryKey(query)] = await legacySurfaceUse(fixture, query);
      }
    }
    if (process.env.UPDATE_W03_GOLDENS === '1') writeFileSync(W03_GOLDENS_PATH, `${JSON.stringify(live, null, 2)}\n`);
    expect(live).toEqual(loadW03Goldens());
  });
});
```

> `bindLegacyFixture` stands for W02's per-fixture mock setup in its `parity.test.ts`, whatever that test calls it. Import it if W02 exported it; otherwise copy it with the mock block.

Create `apps/api/src/services/aiModels/parity/w03Goldens.json` containing `{}`.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/parity/w03Parity.test.ts src/services/aiModels/parity/w03Goldens.test.ts`
Expected: FAIL. `./w03Parity` does not resolve.

- [ ] **Step 3: Implement the goldens half of `w03Parity.ts`**

```ts
// apps/api/src/services/aiModels/parity/w03Parity.ts
/**
 * W03 parity (#7601): the REAL resolveModel against the legacy routing frozen
 * by w03Goldens.test.ts, through W02's harness (#7600 Task 11) — same
 * fixtures, same queries, same comparison rule (`sameUse`), same declared
 * divergences. Only the legacy side changed: a golden lookup instead of the
 * legacy code, which W03 deletes. (Task 7 appends toSurfaceUse + assertSurfaceParity.)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ParityQuery, SurfaceUse } from './harness';

export const W03_GOLDENS_PATH = join(__dirname, 'w03Goldens.json');
export type W03Goldens = Record<string, Record<string, SurfaceUse>>;

export function queryKey(q: ParityQuery): string {
  switch (q.kind) {
    case 'surface': return `surface:${q.surface}:${q.orgId}`;
    case 'agent': return `agent:${q.agentKind}:${q.orgId}`;
    case 'session': return `session:${q.sessionId}`;
  }
}

export function loadW03Goldens(): W03Goldens {
  return JSON.parse(readFileSync(W03_GOLDENS_PATH, 'utf8')) as W03Goldens;
}
```

- [ ] **Step 4: Record the goldens from live legacy behaviour**

Run: `cd apps/api && UPDATE_W03_GOLDENS=1 npx vitest run src/services/aiModels/parity/w03Goldens.test.ts`

Inspect the JSON:
- every `PARITY_FIXTURES` name is present with all its queries;
- BYOK fixtures show `destination: { connectionId }` and `funding: 'partner_key'`;
- platform fixtures show `'platform'`;
- `byok_errored` / `catalog_default_unverified` show `unavailable`;
- catalog fixtures' agent and `extension_content` queries show `unavailable` / `catalog_refused`. These are W02's two declared divergences.

Anything else unexpected is a W02 harness question: stop and report it.

- [ ] **Step 5: Run both tests again**

Run: `cd apps/api && npx vitest run src/services/aiModels/parity/w03Parity.test.ts src/services/aiModels/parity/w03Goldens.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/aiModels/parity/w03Goldens.json apps/api/src/services/aiModels/parity/w03Goldens.test.ts \
  apps/api/src/services/aiModels/parity/w03Parity.ts apps/api/src/services/aiModels/parity/w03Parity.test.ts
git commit -m "test(ai): freeze legacy surface-use goldens from the W02 parity oracle (#7601)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: Eligibility rules, the candidate loader, the premium permission and the residency setting

This task implements spec §9 step 2 in two parts:
- **Eligibility** is a pure function over facts, so one table row can pin each rule.
- **The loader** turns an offering id into those facts **live**:
  - the key is decrypted per call;
  - the catalog revision is read through `getListedProviderByEntryId` per call, so a delisting or revocation takes effect on the next resolve (quorum #7);
  - the platform row is re-read, so `platform_offered` is re-checked at every dispatch (quorum #2).

This task also seeds the `ai_models:premium` permission (spec §5.3, §15 #7), granted to no role, and types `partners.settings.ai.residencyRequired`.

**Files:**
- Create: `apps/api/src/services/aiModels/eligibility.ts`, `apps/api/src/services/aiModels/eligibility.test.ts`
- Create: `apps/api/src/services/aiModels/candidateLoader.ts`, `apps/api/src/services/aiModels/candidateLoader.test.ts`
- Create: `apps/api/src/services/aiModels/promptProfiles.ts`
- Create: `apps/api/migrations/2026-11-19-100100-ai-models-premium-permission.sql`
- Create: `apps/api/src/__tests__/integration/helpers/aiModelRegistrySeed.ts` (`seedRegistryPartner`, used by every W03 integration suite)
- Create: `apps/api/src/__tests__/integration/resolveModel.integration.test.ts` (loader half; Task 3 appends the resolver half)
- Modify: `packages/shared/src/constants/permissions.ts` (add `AI_MODELS_PREMIUM` after `AI_AGENTS_WRITE`)
- Modify: `apps/api/src/db/seed.ts` (`DEFAULT_PERMISSIONS`, after the `ai_agents` rows ~L262)
- Modify: `packages/shared/src/types/index.ts` (`PartnerSettings`, ~L785)
- Modify: `apps/api/src/services/aiModels/platformModels.ts` (add `getPlatformInferenceGeo`), `apps/docs/src/content/docs/deploy/environment.mdx` (document `AI_PLATFORM_INFERENCE_GEO`)

**Interfaces:**
- Consumes: P2, P3, P5, P6, P7, P8. From `llmConfigResolver.ts`: `UsableLlmConfig`, `buildCatalogEndpointSnapshot`, `isLlmProviderCatalogEnabled`. From `llmProviderCatalog.ts`: `getListedProviderByEntryId(entryId): Promise<ListedProvider | null>`. From `llm/llmAvailability.ts`: `isPlatformLlmConfigured()`. From `permissions.ts`: `getUserPermissions(userId, ctx)`, `hasPermission(perms, resource, action)`. From `config/env.ts`: `isHosted()`.
- Produces:
  ```ts
  // eligibility.ts
  export const PARTNER_PLAN_ORDER: readonly ['free','starter','community','pro','enterprise','unlimited'];
  export type PartnerPlan = (typeof PARTNER_PLAN_ORDER)[number];
  export function planSatisfies(plan: PartnerPlan, minPlan: PartnerPlan | null): boolean;
  export type ResolveFailureReason =
    | 'no_eligible_model' | 'not_permitted' | 'permission_required' | 'plan_required'
    | 'residency_unavailable' | 'unpriced' | 'connection_unavailable'
    | 'model_unavailable' | 'tools_unsupported';
  export type ConnectionKind = 'platform' | 'anthropic_byok' | 'catalog' | 'openai_compatible';
  export interface CandidateFacts {
    ownerPartnerId: string | null;
    enabled: boolean;
    lifecycle: 'available' | 'missing' | 'retired';
    requiredPermission: string | null;
    /** Present ONLY for platform offerings (connection_id IS NULL). */
    platform: { platformOffered: boolean; lifecycle: 'available' | 'missing' | 'retired'; minPlan: PartnerPlan | null } | null;
    connection: { kind: ConnectionKind; status: string; keyUsable: boolean };
    /** Present only for catalog connections: mapped AND verified in the CURRENT listed revision. */
    catalog: { usable: boolean } | null;
    rate: RateSnapshot | null;
    supportsTools: boolean;
    inferenceGeo: string | null;
    supportedInferenceGeos: readonly string[];
  }
  export interface EligibilityContext {
    partnerId: string | null;
    surface: AiSurface;
    partnerPlan: PartnerPlan | null;
    hosted: boolean;
    residencyRequired: boolean;
    /** Can the dispatch transport send `inference_geo` at all (Task 4 `transportCarries`)? */
    geoCarriable: boolean;
    userInitiated: boolean;
    userHoldsPermission: (permissionKey: string) => boolean;
  }
  export function checkEligibility(c: CandidateFacts, ctx: EligibilityContext): ResolveFailureReason | null;

  // promptProfiles.ts (PROMPT_PROFILES / PromptProfile are W01's, re-exported)
  export function toPromptProfile(value: string | null | undefined): PromptProfile;
  export function applyPromptProfile(surface: AiSurface, profile: PromptProfile, systemPrompt: string): string; // v1: identity

  // candidateLoader.ts
  export interface ResolvedConnection { id: string | null; kind: Exclude<ConnectionKind, 'openai_compatible'>; config: UsableLlmConfig }
  export interface AllowedOptions { effort?: EffortLevel[]; thinkingDisplay?: OptionSupport['thinkingDisplay']; speed?: OptionSupport['speed'] }
  export interface LoadedCandidate {
    facts: CandidateFacts;
    offeringId: string | null;            // null only for the system platform-default candidate (patch_test)
    connectionId: string | null;          // the offering's connection_id (null = platform), set even when unusable
    displayName: string;
    logicalModel: string;                 // platform model_id, or the offering's model_id
    wireModel: string;                    // catalog providerModel, else logicalModel
    connection: ResolvedConnection | null;// null when the connection is unusable (facts say why)
    funding: AiBillingSource;             // connection_id IS NULL → 'platform', else 'partner_key'
    capabilities: DerivedCapabilities;
    optionSupport: OptionSupport;
    optionRates: OptionRates | null;
    defaultOptions: Partial<OfferingOptions> | null;
    allowedOptions: AllowedOptions | null;
    refusalFallbackOfferingId: string | null;
    promptProfile: PromptProfile;
    limits: { maxInputTokens: number | null; maxOutputTokens: number | null };
    catalogRevisionId?: string;
    configVersion?: number;
  }
  export async function loadOfferingCandidate(offeringId: string, partnerId: string): Promise<LoadedCandidate | null>; // null = missing OR foreign
  export async function loadPlatformDefaultCandidate(): Promise<LoadedCandidate | null>;
  export async function loadPartnerFacts(partnerId: string): Promise<{ plan: PartnerPlan; residencyRequired: boolean }>;
  export async function loadUserPermissionPredicate(userId: string, partnerId: string | null, orgId: string | null): Promise<(key: string) => boolean>;
  /** Finding 11: only within the surface's effective DEFAULT connection; never picks another destination. */
  export async function findOfferingIdByModel(input: { partnerId: string; orgId: string | null; surface: AiSurface; modelId: string }): Promise<string | null>;
  export async function readOrgPartnerId(orgId: string): Promise<string | null>;
  export async function readSessionModelRow(sessionId: string): Promise<{ orgId: string; offeringId: string | null; options: Partial<OfferingOptions> | null } | null>;
  export const EMPTY_OPTION_SUPPORT: OptionSupport;
  ```

- [ ] **Step 1: Write the failing eligibility table**

```ts
// apps/api/src/services/aiModels/eligibility.test.ts
import { describe, expect, it } from 'vitest';
import { planTypeEnum } from '../../db/schema/orgs';
import {
  PARTNER_PLAN_ORDER,
  checkEligibility,
  planSatisfies,
  type CandidateFacts,
  type EligibilityContext,
} from './eligibility';

const RATE = {
  source: 'platform' as const,
  standard: { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 },
};

function platformFacts(over: Partial<CandidateFacts> = {}): CandidateFacts {
  return {
    ownerPartnerId: 'p1',
    enabled: true,
    lifecycle: 'available',
    requiredPermission: null,
    platform: { platformOffered: true, lifecycle: 'available', minPlan: null },
    connection: { kind: 'platform', status: 'active', keyUsable: true },
    catalog: null,
    rate: RATE,
    supportsTools: true,
    inferenceGeo: null,
    supportedInferenceGeos: [],
    ...over,
  };
}

function byokFacts(over: Partial<CandidateFacts> = {}): CandidateFacts {
  return platformFacts({
    platform: null,
    connection: { kind: 'anthropic_byok', status: 'active', keyUsable: true },
    rate: { ...RATE, source: 'linked_platform' },
    ...over,
  });
}

const CTX: EligibilityContext = {
  partnerId: 'p1',
  surface: 'chat',
  partnerPlan: 'pro',
  hosted: true,
  residencyRequired: false,
  geoCarriable: true,
  userInitiated: true,
  userHoldsPermission: () => false,
};

describe('checkEligibility — one row per spec §9 step 2 rule', () => {
  it.each<[string, CandidateFacts, Partial<EligibilityContext>, string | null]>([
    ['eligible platform offering', platformFacts(), {}, null],
    ['eligible BYOK offering', byokFacts(), {}, null],
    ['owned by another partner', platformFacts({ ownerPartnerId: 'p2' }), {}, 'not_permitted'],
    ['disabled offering', platformFacts({ enabled: false }), {}, 'model_unavailable'],
    ['offering lifecycle missing', platformFacts({ lifecycle: 'missing' }), {}, 'model_unavailable'],
    ['platform row not platform_offered (re-checked per dispatch)',
      platformFacts({ platform: { platformOffered: false, lifecycle: 'available', minPlan: null } }), {}, 'model_unavailable'],
    ['platform row retired',
      platformFacts({ platform: { platformOffered: true, lifecycle: 'retired', minPlan: null } }), {}, 'model_unavailable'],
    ['platform key absent on this deployment',
      platformFacts({ connection: { kind: 'platform', status: 'unconfigured', keyUsable: false } }), {}, 'connection_unavailable'],
    ['connection in error', byokFacts({ connection: { kind: 'anthropic_byok', status: 'error', keyUsable: true } }), {}, 'connection_unavailable'],
    ['connection key undecryptable', byokFacts({ connection: { kind: 'anthropic_byok', status: 'active', keyUsable: false } }), {}, 'connection_unavailable'],
    ['openai_compatible is W06', byokFacts({ connection: { kind: 'openai_compatible', status: 'active', keyUsable: true } }), {}, 'connection_unavailable'],
    ['catalog model not mapped+verified in the current revision',
      byokFacts({ connection: { kind: 'catalog', status: 'active', keyUsable: true }, catalog: { usable: false } }), {}, 'model_unavailable'],
    ['catalog model usable', byokFacts({ connection: { kind: 'catalog', status: 'active', keyUsable: true }, catalog: { usable: true }, rate: { ...RATE, source: 'catalog' } }), {}, null],
    ['no resolvable rate', byokFacts({ rate: null }), {}, 'unpriced'],
    ['tool surface without verified tools', platformFacts({ supportsTools: false }), { surface: 'chat' }, 'tools_unsupported'],
    ['non-tool surface without tools is fine', platformFacts({ supportsTools: false }), { surface: 'catalog_enrichment' }, null],
    ['office_chat requires tools (quorum #10)', platformFacts({ supportsTools: false }), { surface: 'office_chat' }, 'tools_unsupported'],
    ['required permission, user lacks it', platformFacts({ requiredPermission: 'ai_models:premium' }), {}, 'permission_required'],
    ['required permission, user holds it', platformFacts({ requiredPermission: 'ai_models:premium' }), { userHoldsPermission: (k) => k === 'ai_models:premium' }, null],
    ['required permission skipped for system/agent calls', platformFacts({ requiredPermission: 'ai_models:premium' }), { userInitiated: false }, null],
    ['min_plan above partner plan (hosted)',
      platformFacts({ platform: { platformOffered: true, lifecycle: 'available', minPlan: 'enterprise' } }), {}, 'plan_required'],
    ['min_plan ignored on self-host',
      platformFacts({ platform: { platformOffered: true, lifecycle: 'available', minPlan: 'enterprise' } }), { hosted: false }, null],
    ['min_plan satisfied',
      platformFacts({ platform: { platformOffered: true, lifecycle: 'available', minPlan: 'community' } }), {}, null],
    ['residency required, no geography configured', platformFacts(), { residencyRequired: true }, 'residency_unavailable'],
    ['residency required, geography unsupported by model',
      platformFacts({ inferenceGeo: 'eu', supportedInferenceGeos: ['us'] }), { residencyRequired: true }, 'residency_unavailable'],
    ['residency required and honoured',
      platformFacts({ inferenceGeo: 'eu', supportedInferenceGeos: ['us', 'eu'] }), { residencyRequired: true }, null],
    ['residency required but the transport cannot carry a geography (W01 D3 open) → fails closed',
      platformFacts({ inferenceGeo: 'eu', supportedInferenceGeos: ['eu'] }), { residencyRequired: true, geoCarriable: false }, 'residency_unavailable'],
    ['system platform candidate (patch_test) has no owner',
      platformFacts({ ownerPartnerId: null }), { partnerId: null, surface: 'patch_test', userInitiated: false, partnerPlan: null }, null],
  ])('%s', (_name, facts, ctx, expected) => {
    expect(checkEligibility(facts, { ...CTX, ...ctx })).toBe(expected);
  });
});

describe('plan ordering', () => {
  it('mirrors planTypeEnum exactly (a new plan must be ranked deliberately)', () => {
    expect([...PARTNER_PLAN_ORDER]).toEqual([...planTypeEnum.enumValues]);
  });
  it('compares by rank', () => {
    expect(planSatisfies('pro', 'community')).toBe(true);
    expect(planSatisfies('starter', 'community')).toBe(false);
    expect(planSatisfies('free', null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/eligibility.test.ts`
Expected: FAIL with `Failed to resolve import "./eligibility"`.

- [ ] **Step 3: Implement `eligibility.ts` and `promptProfiles.ts`**

```ts
// apps/api/src/services/aiModels/eligibility.ts
/**
 * Spec §9 step 2 eligibility, as a pure function over facts the candidate
 * loader read LIVE. The first failing rule wins, in the order below, so the
 * reason a caller sees is deterministic. Ownership is checked first so a
 * foreign offering is never described by any other reason.
 */
import { TOOL_REQUIRING_SURFACES, type AiSurface } from '@breeze/shared';
import type { RateSnapshot } from './pricing';

/** Ascending. Pinned to planTypeEnum by eligibility.test.ts. */
export const PARTNER_PLAN_ORDER = ['free', 'starter', 'community', 'pro', 'enterprise', 'unlimited'] as const;
export type PartnerPlan = (typeof PARTNER_PLAN_ORDER)[number];

export function planSatisfies(plan: PartnerPlan, minPlan: PartnerPlan | null): boolean {
  if (minPlan === null) return true;
  return PARTNER_PLAN_ORDER.indexOf(plan) >= PARTNER_PLAN_ORDER.indexOf(minPlan);
}

export type ResolveFailureReason =
  | 'no_eligible_model'
  | 'not_permitted'
  | 'permission_required'
  | 'plan_required'
  | 'residency_unavailable'
  | 'unpriced'
  | 'connection_unavailable'
  | 'model_unavailable'
  | 'tools_unsupported';

export type ConnectionKind = 'platform' | 'anthropic_byok' | 'catalog' | 'openai_compatible';

/** v1 dispatches these. openai_compatible arrives in W06, cloud kinds in W07. */
const DISPATCHABLE_KINDS: ReadonlySet<ConnectionKind> = new Set(['platform', 'anthropic_byok', 'catalog']);

export interface CandidateFacts {
  ownerPartnerId: string | null;
  enabled: boolean;
  lifecycle: 'available' | 'missing' | 'retired';
  requiredPermission: string | null;
  platform: {
    platformOffered: boolean;
    lifecycle: 'available' | 'missing' | 'retired';
    minPlan: PartnerPlan | null;
  } | null;
  connection: { kind: ConnectionKind; status: string; keyUsable: boolean };
  catalog: { usable: boolean } | null;
  rate: RateSnapshot | null;
  supportsTools: boolean;
  inferenceGeo: string | null;
  supportedInferenceGeos: readonly string[];
}

export interface EligibilityContext {
  partnerId: string | null;
  surface: AiSurface;
  partnerPlan: PartnerPlan | null;
  hosted: boolean;
  residencyRequired: boolean;
  geoCarriable: boolean;
  userInitiated: boolean;
  userHoldsPermission: (permissionKey: string) => boolean;
}

export function checkEligibility(c: CandidateFacts, ctx: EligibilityContext): ResolveFailureReason | null {
  if (c.ownerPartnerId !== ctx.partnerId) return 'not_permitted';
  if (!c.enabled || c.lifecycle !== 'available') return 'model_unavailable';
  if (c.platform && (!c.platform.platformOffered || c.platform.lifecycle !== 'available')) {
    return 'model_unavailable';
  }
  if (!DISPATCHABLE_KINDS.has(c.connection.kind)) return 'connection_unavailable';
  if (c.connection.status !== 'active' || !c.connection.keyUsable) return 'connection_unavailable';
  if (c.connection.kind === 'catalog' && !c.catalog?.usable) return 'model_unavailable';
  if (c.rate === null) return 'unpriced';
  if ((TOOL_REQUIRING_SURFACES as readonly string[]).includes(ctx.surface) && !c.supportsTools) {
    return 'tools_unsupported';
  }
  if (ctx.userInitiated && c.requiredPermission && !ctx.userHoldsPermission(c.requiredPermission)) {
    return 'permission_required';
  }
  // Hosted plan gate on PLATFORM-funded models only: a BYOK partner pays the
  // provider directly, so a Breeze plan cannot gate their own key.
  if (ctx.hosted && c.platform && ctx.partnerPlan !== null && !planSatisfies(ctx.partnerPlan, c.platform.minPlan)) {
    return 'plan_required';
  }
  // Residency fails CLOSED: required + no geography, or a geography the model
  // cannot honour, is ineligible — never silently sent elsewhere (§7, §12).
  if (ctx.residencyRequired) {
    if (!ctx.geoCarriable || c.inferenceGeo === null || !c.supportedInferenceGeos.includes(c.inferenceGeo)) {
      return 'residency_unavailable';
    }
  }
  return null;
}
```

```ts
// apps/api/src/services/aiModels/promptProfiles.ts
/**
 * Prompt-profile hook (spec §7). resolveModel returns the model's profile and
 * system-prompt builders pass their prompt through applyPromptProfile. v1 ships
 * ONE prompt per surface, so this is the identity; W11 adds per-profile
 * variants, measured against the quality view. Keeping the call sites now
 * means W11 changes one file.
 */
import { PROMPT_PROFILES, type AiSurface, type PromptProfile } from '@breeze/shared';   // W01 (P1)

export { PROMPT_PROFILES, type PromptProfile };

export function toPromptProfile(value: string | null | undefined): PromptProfile {
  return (PROMPT_PROFILES as readonly string[]).includes(value ?? '') ? (value as PromptProfile) : 'generic';
}

export function applyPromptProfile(_surface: AiSurface, _profile: PromptProfile, systemPrompt: string): string {
  return systemPrompt;
}
```

- [ ] **Step 4: Run the eligibility tests**

Run: `cd apps/api && npx vitest run src/services/aiModels/eligibility.test.ts`
Expected: PASS (28 table rows + 2).

- [ ] **Step 5: Write the failing loader unit tests**

```ts
// apps/api/src/services/aiModels/candidateLoader.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getOffering: vi.fn(),
  getConnection: vi.fn(),
  getConnectionKeyMaterial: vi.fn(),
  decryptConnectionKey: vi.fn(),
  getPlatformModelById: vi.fn(),
  getPlatformModelByModelId: vi.fn(),
  getPlatformDefaultModel: vi.fn(),
  getPlatformInferenceGeo: vi.fn(),
  getListedProviderByEntryId: vi.fn(),
  isLlmProviderCatalogEnabled: vi.fn(() => true),
  isPlatformLlmConfigured: vi.fn(() => true),
  findOfferingIdForModel: vi.fn(),
  getEffectiveAssignment: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./offerings', () => ({ getOffering: m.getOffering, listOfferings: vi.fn(), findOfferingIdForModel: m.findOfferingIdForModel }));
vi.mock('./assignments', () => ({ getEffectiveAssignment: m.getEffectiveAssignment }));
vi.mock('./connections', () => ({
  getConnection: m.getConnection,
  getConnectionKeyMaterial: m.getConnectionKeyMaterial,
  decryptConnectionKey: m.decryptConnectionKey,
}));
vi.mock('./platformModels', () => ({
  getPlatformModelById: m.getPlatformModelById,
  getPlatformModelByModelId: m.getPlatformModelByModelId,
  getPlatformDefaultModel: m.getPlatformDefaultModel,
  getPlatformInferenceGeo: m.getPlatformInferenceGeo,
}));
vi.mock('../llmProviderCatalog', () => ({ getListedProviderByEntryId: m.getListedProviderByEntryId }));
vi.mock('../llm/llmAvailability', () => ({ isPlatformLlmConfigured: m.isPlatformLlmConfigured }));
vi.mock('../llm/llmConfigResolver', async (orig) => ({
  ...(await orig<typeof import('../llm/llmConfigResolver')>()),
  isLlmProviderCatalogEnabled: m.isLlmProviderCatalogEnabled,
}));
vi.mock('./capabilities', () => ({
  deriveCapabilities: (raw: { tools?: boolean } | null) => ({
    thinkingMode: raw ? 'adaptive' : 'unknown',
    effortLevels: raw ? ['low', 'medium', 'high'] : [],
    supportsTools: raw?.tools ?? false,
    supportsVision: false,
  }),
}));

import { findOfferingIdByModel, loadOfferingCandidate, loadPlatformDefaultCandidate } from './candidateLoader';

const PLATFORM_ROW = {
  id: 'pm-1', modelId: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5',
  maxInputTokens: 200000, maxOutputTokens: 64000, capabilities: { tools: true },
  rates: { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 },
  optionRates: null,
  optionSupport: { effort: ['low', 'medium', 'high'], thinkingDisplay: ['summarized'], speed: ['standard'], inferenceGeo: ['us'] },
  minPlan: null, promptProfile: 'claude-standard', platformOffered: true, isPlatformDefault: true, lifecycle: 'available',
};
const BASE_OFFERING = {
  id: 'off-1', partnerId: 'p1', connectionId: null, platformModelId: 'pm-1', modelId: null, source: 'platform',
  displayName: null, capabilities: null,
  priceInputCentsPerM: null, priceOutputCentsPerM: null, priceCacheReadCentsPerM: null, priceCacheWriteCentsPerM: null,
  enabled: true, defaultOptions: null, allowedOptions: null, requiredPermission: null,
  refusalFallbackOfferingId: null, lifecycle: 'available',
};
const BYOK_CONN = {
  id: 'conn-1', partnerId: 'p1', kind: 'anthropic_byok', name: 'Key', inferenceGeo: null,
  catalogEntryId: null, baseUrl: null, status: 'active', configVersion: 4, apiKeyEncrypted: 'enc',
};

beforeEach(() => {
  vi.clearAllMocks();
  m.getPlatformModelById.mockResolvedValue(PLATFORM_ROW);
  m.getPlatformModelByModelId.mockResolvedValue(PLATFORM_ROW);
  m.getPlatformInferenceGeo.mockResolvedValue(null);
  m.getConnectionKeyMaterial.mockImplementation(async (id: string) => ({ id, partnerId: 'p1', apiKeyEncrypted: 'enc' }));
  m.decryptConnectionKey.mockReturnValue('sk-partner');
  m.isPlatformLlmConfigured.mockReturnValue(true);
  m.isLlmProviderCatalogEnabled.mockReturnValue(true);
});

describe('loadOfferingCandidate', () => {
  it('returns null for an offering owned by another partner (no detail leaks)', async () => {
    m.getOffering.mockResolvedValue({ ...BASE_OFFERING, partnerId: 'p2' });
    await expect(loadOfferingCandidate('off-1', 'p1')).resolves.toBeNull();
  });

  it('platform offering: identity, price and capabilities come from the platform row, funding platform', async () => {
    m.getOffering.mockResolvedValue(BASE_OFFERING);
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.logicalModel).toBe('claude-sonnet-5-5');
    expect(c.wireModel).toBe('claude-sonnet-5-5');
    expect(c.funding).toBe('platform');
    expect(c.connection?.kind).toBe('platform');
    expect(c.facts.rate).toEqual({
      source: 'platform',
      standard: { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 },
    });
    expect(c.facts.platform).toEqual({ platformOffered: true, lifecycle: 'available', minPlan: null });
    expect(c.promptProfile).toBe('claude-standard');
  });

  it('re-reads platform_offered every call (quorum #2)', async () => {
    m.getOffering.mockResolvedValue(BASE_OFFERING);
    m.getPlatformModelById.mockResolvedValueOnce({ ...PLATFORM_ROW, platformOffered: false });
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.facts.platform?.platformOffered).toBe(false);
  });

  it('BYOK linked row: offering price beats linked platform price', async () => {
    m.getOffering.mockResolvedValue({
      ...BASE_OFFERING, connectionId: 'conn-1', source: 'discovered', modelId: 'claude-sonnet-5-5',
      priceInputCentsPerM: 150, priceOutputCentsPerM: 900, priceCacheReadCentsPerM: 15, priceCacheWriteCentsPerM: 190,
    });
    m.getConnection.mockResolvedValue(BYOK_CONN);
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.funding).toBe('partner_key');
    expect(c.facts.rate?.source).toBe('offering');
    expect(c.facts.platform).toBeNull();
    expect(c.connection?.config).toMatchObject({
      source: 'partner', apiKey: 'sk-partner', configId: 'conn-1', configVersion: 4, endpoint: { kind: 'anthropic' },
    });
  });

  it('BYOK linked row without its own price falls back to the linked platform price', async () => {
    m.getOffering.mockResolvedValue({ ...BASE_OFFERING, connectionId: 'conn-1', source: 'discovered', modelId: 'claude-sonnet-5-5' });
    m.getConnection.mockResolvedValue(BYOK_CONN);
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.facts.rate?.source).toBe('linked_platform');
  });

  it('BYOK unlinked + unpriced → rate null (cannot be dispatched)', async () => {
    m.getOffering.mockResolvedValue({
      ...BASE_OFFERING, connectionId: 'conn-1', platformModelId: null, source: 'manual', modelId: 'my-local-model',
    });
    m.getConnection.mockResolvedValue(BYOK_CONN);
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.facts.rate).toBeNull();
    expect(c.capabilities.thinkingMode).toBe('unknown');
  });

  it('an undecryptable key yields keyUsable=false and no connection config', async () => {
    m.getOffering.mockResolvedValue({ ...BASE_OFFERING, connectionId: 'conn-1', source: 'discovered', modelId: 'claude-sonnet-5-5' });
    m.getConnection.mockResolvedValue(BYOK_CONN);
    m.decryptConnectionKey.mockImplementation(() => { throw new Error('bad tag'); });
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.facts.connection.keyUsable).toBe(false);
    expect(c.connection).toBeNull();
  });

  it('catalog: resolved LIVE from the current listed revision; unmapped → catalog.usable false', async () => {
    m.getOffering.mockResolvedValue({
      ...BASE_OFFERING, connectionId: 'conn-2', platformModelId: null, source: 'catalog', modelId: 'claude-sonnet-5-5',
    });
    m.getConnection.mockResolvedValue({ ...BYOK_CONN, id: 'conn-2', kind: 'catalog', catalogEntryId: 'cat-1' });
    m.getListedProviderByEntryId.mockResolvedValue({
      entryId: 'cat-1', slug: 'gw', name: 'GW', revisionId: 'rev-7', revision: 7, baseUrl: 'https://gw.example.com',
      authMode: 'bearer', dataNote: null, verifiedModels: ['claude-sonnet-5-5'],
      modelMap: { 'claude-sonnet-5-5': { providerModel: 'anthropic/claude-sonnet-5.5', inputCentsPerM: 210, outputCentsPerM: 1050, cacheReadCentsPerM: 21, cacheWriteCentsPerM: 260 } },
    });
    const ok = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(ok.wireModel).toBe('anthropic/claude-sonnet-5.5');
    expect(ok.catalogRevisionId).toBe('rev-7');
    expect(ok.facts.catalog).toEqual({ usable: true });
    expect(ok.facts.rate?.source).toBe('catalog');
    expect(ok.capabilities.thinkingMode).toBe('unknown');
    expect(ok.capabilities.supportsTools).toBe(true);

    m.getListedProviderByEntryId.mockResolvedValue(null); // delisted
    const gone = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(gone.facts.catalog).toEqual({ usable: false });
    expect(gone.connection).toBeNull();
  });

  it('catalog flag off → catalog unusable (fails closed, never reverts to api.anthropic.com)', async () => {
    m.getOffering.mockResolvedValue({
      ...BASE_OFFERING, connectionId: 'conn-2', platformModelId: null, source: 'catalog', modelId: 'claude-sonnet-5-5',
    });
    m.getConnection.mockResolvedValue({ ...BYOK_CONN, id: 'conn-2', kind: 'catalog', catalogEntryId: 'cat-1' });
    m.isLlmProviderCatalogEnabled.mockReturnValue(false);
    const c = (await loadOfferingCandidate('off-1', 'p1'))!;
    expect(c.facts.catalog).toEqual({ usable: false });
    expect(m.getListedProviderByEntryId).not.toHaveBeenCalled();
  });

  it('effective inference geo: connection value, else the platform setting', async () => {
    m.getOffering.mockResolvedValue({ ...BASE_OFFERING, connectionId: 'conn-1', source: 'discovered', modelId: 'claude-sonnet-5-5' });
    m.getConnection.mockResolvedValue({ ...BYOK_CONN, inferenceGeo: 'eu' });
    m.getPlatformInferenceGeo.mockResolvedValue('us');
    expect((await loadOfferingCandidate('off-1', 'p1'))!.facts.inferenceGeo).toBe('eu');
    m.getConnection.mockResolvedValue({ ...BYOK_CONN, inferenceGeo: null });
    expect((await loadOfferingCandidate('off-1', 'p1'))!.facts.inferenceGeo).toBe('us');
  });
});

describe('findOfferingIdByModel (finding 11: never crosses to another connection)', () => {
  // The same model id exists on the platform AND on a BYOK connection.
  const PLATFORM_SONNET = { ...BASE_OFFERING, id: 'plat-sonnet', partnerId: 'p1' };
  const BYOK_SONNET = { ...BASE_OFFERING, id: 'byok-sonnet', partnerId: 'p1', connectionId: 'conn-1', source: 'discovered', modelId: 'claude-sonnet-5-5' };
  const BYOK_OPUS_DISABLED = { ...BASE_OFFERING, id: 'byok-opus', partnerId: 'p1', connectionId: 'conn-1', enabled: false, modelId: 'claude-opus-5-5' };
  const rows = [PLATFORM_SONNET, BYOK_SONNET, BYOK_OPUS_DISABLED];
  beforeEach(() => {
    m.getOffering.mockImplementation(async (id: string) => rows.find((o) => o.id === id) ?? null);
    // A faithful stand-in for W02's connection-scoped lookup.
    m.findOfferingIdForModel.mockImplementation(async (q: { connectionId: string | null; modelId: string }) =>
      rows.find((o) => o.connectionId === q.connectionId && (o.modelId ?? 'claude-sonnet-5-5') === q.modelId)?.id ?? null);
  });
  const find = (modelId: string) => findOfferingIdByModel({ partnerId: 'p1', orgId: 'o1', surface: 'chat', modelId });

  it('the same model id on platform and BYOK → the one on the surface default\'s connection', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ defaultOfferingId: 'byok-sonnet', permitted: { kind: 'all' } });
    expect(await find('claude-sonnet-5-5')).toBe('byok-sonnet');
    expect(m.findOfferingIdForModel).toHaveBeenLastCalledWith({ partnerId: 'p1', connectionId: 'conn-1', modelId: 'claude-sonnet-5-5' });
    m.getEffectiveAssignment.mockResolvedValue({ defaultOfferingId: 'plat-sonnet', permitted: { kind: 'all' } });
    expect(await find('claude-sonnet-5-5')).toBe('plat-sonnet');
    expect(m.findOfferingIdForModel).toHaveBeenLastCalledWith({ partnerId: 'p1', connectionId: null, modelId: 'claude-sonnet-5-5' });
  });
  it('a disabled match, or a model only on ANOTHER connection, is null (never a destination change)', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ defaultOfferingId: 'byok-sonnet', permitted: { kind: 'all' } });
    expect(await find('claude-opus-5-5')).toBeNull();
    m.getEffectiveAssignment.mockResolvedValue({ defaultOfferingId: 'plat-sonnet', permitted: { kind: 'all' } });
    expect(await find('claude-opus-5-5')).toBeNull();
  });
  it('no surface default → null', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ defaultOfferingId: null, permitted: { kind: 'all' } });
    expect(await find('claude-sonnet-5-5')).toBeNull();
  });
});

describe('loadPlatformDefaultCandidate', () => {
  it('builds a partnerless platform candidate from the platform default row', async () => {
    m.getPlatformDefaultModel.mockResolvedValue(PLATFORM_ROW);
    const c = (await loadPlatformDefaultCandidate())!;
    expect(c.offeringId).toBeNull();
    expect(c.facts.ownerPartnerId).toBeNull();
    expect(c.funding).toBe('platform');
  });
});
```

- [ ] **Step 6: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/candidateLoader.test.ts`
Expected: FAIL with `Failed to resolve import "./candidateLoader"`.

- [ ] **Step 7: Implement `candidateLoader.ts`**

```ts
// apps/api/src/services/aiModels/candidateLoader.ts
/**
 * The ONE adapter between W01/W02 row shapes and the resolver. Everything is
 * read LIVE on every call: the key is decrypted, the catalog revision is
 * re-listed and the platform row is re-read, so a rotation, a delisting or an
 * un-offer takes effect on the very next dispatch (quorum #2, #7). No caching.
 * No writes. A foreign or missing offering is indistinguishable (null).
 */
import { and, eq } from 'drizzle-orm';
import type {
  EffortLevel,
  OfferingOptions,
  OptionRates,
  OptionSupport,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiSessions, organizations, partners } from '../../db/schema';
import { isPlatformLlmConfigured } from '../llm/llmAvailability';
import {
  buildCatalogEndpointSnapshot,
  isLlmProviderCatalogEnabled,
  type UsableLlmConfig,
} from '../llm/llmConfigResolver';
import { getListedProviderByEntryId } from '../llmProviderCatalog';
import { getUserPermissions, hasPermission } from '../permissions';
import { SecretKeyMaterialError } from '../secretCrypto';
import { captureException } from '../sentry';
import type { AiBillingSource } from '../aiCostTracker';
import { deriveCapabilities, type DerivedCapabilities } from './capabilities';
import {
  decryptConnectionKey,
  getConnection,
  getConnectionKeyMaterial,
  type PartnerAiConnection,
} from './connections';
import type { CandidateFacts, ConnectionKind, PartnerPlan } from './eligibility';
import { PARTNER_PLAN_ORDER } from './eligibility';
import { getOffering, listOfferings, type Offering } from './offerings';
import {
  getPlatformDefaultModel,
  getPlatformInferenceGeo,
  getPlatformModelById,
  getPlatformModelByModelId,
  type PlatformModel,
} from './platformModels';
import type { RateSnapshot } from './pricing';
import { toPromptProfile, type PromptProfile } from './promptProfiles';

export interface ResolvedConnection {
  id: string | null;
  kind: Exclude<ConnectionKind, 'openai_compatible'>;
  config: UsableLlmConfig;
}

export interface AllowedOptions {
  effort?: EffortLevel[];
  thinkingDisplay?: OptionSupport['thinkingDisplay'];
  speed?: OptionSupport['speed'];
}

export interface LoadedCandidate {
  facts: CandidateFacts;
  offeringId: string | null;
  connectionId: string | null;
  displayName: string;
  logicalModel: string;
  wireModel: string;
  connection: ResolvedConnection | null;
  funding: AiBillingSource;
  capabilities: DerivedCapabilities;
  optionSupport: OptionSupport;
  optionRates: OptionRates | null;
  defaultOptions: Partial<OfferingOptions> | null;
  allowedOptions: AllowedOptions | null;
  refusalFallbackOfferingId: string | null;
  promptProfile: PromptProfile;
  limits: { maxInputTokens: number | null; maxOutputTokens: number | null };
  catalogRevisionId?: string;
  configVersion?: number;
}

export const EMPTY_OPTION_SUPPORT: OptionSupport = Object.freeze({
  effort: [],
  thinkingDisplay: [],
  speed: [],
  inferenceGeo: [],
}) as unknown as OptionSupport;

const UNVERIFIED_CAPABILITIES: DerivedCapabilities = {
  thinkingMode: 'unknown',
  effortLevels: [],
  supportsTools: false,
  supportsVision: false,
};

function systemRead<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

function fourRates(
  i: number | null | undefined,
  o: number | null | undefined,
  cr: number | null | undefined,
  cw: number | null | undefined,
): RateSnapshot['standard'] | null {
  if (i == null || o == null || cr == null || cw == null) return null;
  return {
    inputCentsPerM: Number(i),
    outputCentsPerM: Number(o),
    cacheReadCentsPerM: Number(cr),
    cacheWriteCentsPerM: Number(cw),
  };
}

/** W01: `rates` is all four standard rates, or null when any is unset (unpriced). */
function platformRate(row: PlatformModel): RateSnapshot['standard'] | null {
  return row.rates ?? null;
}

function asPlan(value: string | null | undefined): PartnerPlan | null {
  return (PARTNER_PLAN_ORDER as readonly string[]).includes(value ?? '') ? (value as PartnerPlan) : null;
}

/** Platform offering, or the partnerless system candidate (patch_test). */
async function platformCandidate(
  row: PlatformModel,
  offering: Offering | null,
): Promise<LoadedCandidate> {
  const platformGeo = await systemRead(() => getPlatformInferenceGeo());
  // Anthropic credentials only ('agent_sdk' transport): the deployment-wide
  // env OpenAI-compatible chat path is NOT a platform offering (W06 absorbs it)
  // and must never make a platform Claude model look dispatchable.
  const configured = isPlatformLlmConfigured(process.env.ANTHROPIC_API_KEY, 'agent_sdk');
  const standard = platformRate(row);
  const config: UsableLlmConfig = { source: 'platform', apiKey: process.env.ANTHROPIC_API_KEY, model: row.modelId };
  const capabilities = deriveCapabilities(row.capabilities);
  return {
    facts: {
      ownerPartnerId: offering?.partnerId ?? null,
      enabled: offering ? offering.enabled : true,
      lifecycle: offering ? offering.lifecycle : 'available',
      requiredPermission: offering?.requiredPermission ?? null,
      platform: { platformOffered: row.platformOffered, lifecycle: row.lifecycle, minPlan: asPlan(row.minPlan) },
      connection: { kind: 'platform', status: configured ? 'active' : 'unconfigured', keyUsable: configured },
      catalog: null,
      rate: standard ? { source: 'platform', standard } : null,
      supportsTools: capabilities.supportsTools,
      inferenceGeo: platformGeo,
      supportedInferenceGeos: row.optionSupport.inferenceGeo,
    },
    offeringId: offering?.id ?? null,
    connectionId: null,
    displayName: offering?.displayName ?? row.displayName,
    logicalModel: row.modelId,
    wireModel: row.modelId,
    connection: configured ? { id: null, kind: 'platform', config } : null,
    funding: 'platform',
    capabilities,
    optionSupport: row.optionSupport,
    optionRates: row.optionRates ?? null,
    defaultOptions: (offering?.defaultOptions as Partial<OfferingOptions> | null) ?? null,
    allowedOptions: (offering?.allowedOptions as AllowedOptions | null) ?? null,
    refusalFallbackOfferingId: offering?.refusalFallbackOfferingId ?? null,
    promptProfile: toPromptProfile(row.promptProfile),
    limits: { maxInputTokens: row.maxInputTokens ?? null, maxOutputTokens: row.maxOutputTokens ?? null },
  };
}

async function connectionCandidate(offering: Offering, conn: PartnerAiConnection): Promise<LoadedCandidate> {
  const linked = offering.platformModelId
    ? await systemRead(() => getPlatformModelById(offering.platformModelId!))
    : null;
  const logicalModel = offering.modelId ?? linked?.modelId ?? '';
  const platformGeo = await systemRead(() => getPlatformInferenceGeo());
  const offeringRate = fourRates(
    offering.priceInputCentsPerM,
    offering.priceOutputCentsPerM,
    offering.priceCacheReadCentsPerM,
    offering.priceCacheWriteCentsPerM,
  );

  let apiKey: string | null = null;
  try {
    // PartnerAiConnection carries no key material (W02); fetch it separately.
    const material = await systemRead(() => getConnectionKeyMaterial(conn.id));
    apiKey = material ? decryptConnectionKey(material) : null;
  } catch (error) {
    if (error instanceof SecretKeyMaterialError) {
      captureException(error, undefined, { service: 'candidateLoader', connectionId: conn.id });
    }
    apiKey = null;
  }

  let catalogFacts: CandidateFacts['catalog'] = null;
  let config: UsableLlmConfig | null = null;
  let wireModel = logicalModel;
  let rate: RateSnapshot | null = offeringRate ? { source: 'offering', standard: offeringRate } : null;
  let capabilities: DerivedCapabilities;
  let optionSupport: OptionSupport;
  let optionRates: OptionRates | null = null;
  let promptProfile: PromptProfile;
  let catalogRevisionId: string | undefined;
  const limits = {
    maxInputTokens: linked?.maxInputTokens ?? null,
    maxOutputTokens: linked?.maxOutputTokens ?? null,
  };

  if (conn.kind === 'catalog') {
    const provider = isLlmProviderCatalogEnabled() && conn.catalogEntryId
      ? await getListedProviderByEntryId(conn.catalogEntryId)
      : null;
    const endpoint = provider ? buildCatalogEndpointSnapshot(provider, logicalModel) : null;
    catalogFacts = { usable: endpoint !== null };
    if (endpoint) {
      wireModel = endpoint.providerModel;
      catalogRevisionId = endpoint.revisionId;
      if (!rate) {
        rate = {
          source: 'catalog',
          standard: {
            inputCentsPerM: endpoint.pricing.inputCentsPerM,
            outputCentsPerM: endpoint.pricing.outputCentsPerM,
            cacheReadCentsPerM: endpoint.pricing.cacheReadCentsPerM,
            cacheWriteCentsPerM: endpoint.pricing.cacheWriteCentsPerM,
          },
        };
      }
      if (apiKey !== null) {
        config = {
          source: 'partner', partnerId: conn.partnerId, apiKey, model: logicalModel,
          configId: conn.id, configVersion: conn.configVersion, endpoint,
        };
      }
    }
    // A catalog revision's harness pass proves tool-call fidelity; thinking and
    // effort stay `unknown` (nothing sent) unless W01 recorded a probe pass.
    capabilities = { ...UNVERIFIED_CAPABILITIES, supportsTools: endpoint !== null };
    optionSupport = EMPTY_OPTION_SUPPORT;
    const sameIdRow = await systemRead(() => getPlatformModelByModelId(logicalModel));
    promptProfile = toPromptProfile(sameIdRow?.promptProfile);
  } else {
    // anthropic_byok (openai_compatible is filtered by eligibility; W06).
    if (!rate && linked) {
      const linkedStandard = platformRate(linked);
      if (linkedStandard) rate = { source: 'linked_platform', standard: linkedStandard };
    }
    capabilities = linked ? deriveCapabilities(linked.capabilities) : offering.capabilities
      ? deriveCapabilities(offering.capabilities)
      : UNVERIFIED_CAPABILITIES;
    optionSupport = linked ? linked.optionSupport : {
      ...EMPTY_OPTION_SUPPORT,
      effort: capabilities.effortLevels,
    };
    // Option rates only when the standard rate is the linked platform row's:
    // an admin-entered offering price has no fast-mode variant, so fast is not
    // selectable on it (§8 "a variant with no rate is not selectable").
    optionRates = rate?.source === 'linked_platform' ? linked?.optionRates ?? null : null;
    promptProfile = toPromptProfile(linked?.promptProfile);
    if (apiKey !== null && conn.kind === 'anthropic_byok') {
      config = {
        source: 'partner', partnerId: conn.partnerId, apiKey, model: logicalModel,
        configId: conn.id, configVersion: conn.configVersion, endpoint: { kind: 'anthropic' },
      };
    }
  }

  return {
    facts: {
      ownerPartnerId: offering.partnerId,
      enabled: offering.enabled,
      lifecycle: offering.lifecycle,
      requiredPermission: offering.requiredPermission,
      platform: null,
      connection: { kind: conn.kind as ConnectionKind, status: conn.status, keyUsable: apiKey !== null },
      catalog: catalogFacts,
      rate,
      supportsTools: capabilities.supportsTools,
      inferenceGeo: conn.inferenceGeo ?? platformGeo,
      supportedInferenceGeos: optionSupport.inferenceGeo,
    },
    offeringId: offering.id,
    connectionId: conn.id,
    displayName: offering.displayName ?? linked?.displayName ?? logicalModel,
    logicalModel,
    wireModel,
    connection: config ? { id: conn.id, kind: conn.kind as 'anthropic_byok' | 'catalog', config } : null,
    funding: 'partner_key',
    capabilities,
    optionSupport,
    optionRates,
    defaultOptions: offering.defaultOptions as Partial<OfferingOptions> | null,
    allowedOptions: offering.allowedOptions as AllowedOptions | null,
    refusalFallbackOfferingId: offering.refusalFallbackOfferingId,
    promptProfile,
    limits,
    catalogRevisionId,
    configVersion: conn.configVersion,
  };
}

export async function loadOfferingCandidate(offeringId: string, partnerId: string): Promise<LoadedCandidate | null> {
  const offering = await systemRead(() => getOffering(offeringId));
  if (!offering || offering.partnerId !== partnerId) return null;
  if (offering.connectionId === null) {
    if (!offering.platformModelId) return null;
    const row = await systemRead(() => getPlatformModelById(offering.platformModelId!));
    return row ? platformCandidate(row, offering) : null;
  }
  const conn = await systemRead(() => getConnection(offering.connectionId!));
  if (!conn || conn.partnerId !== partnerId) return null;
  return connectionCandidate(offering, conn);
}

export async function loadPlatformDefaultCandidate(): Promise<LoadedCandidate | null> {
  const row = await systemRead(() => getPlatformDefaultModel());
  return row ? platformCandidate(row, null) : null;
}

export async function loadPartnerFacts(partnerId: string): Promise<{ plan: PartnerPlan; residencyRequired: boolean }> {
  const [row] = await systemRead(() => db
    .select({ plan: partners.plan, settings: partners.settings })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1));
  const settings = (row?.settings ?? {}) as { ai?: { residencyRequired?: unknown } };
  return {
    plan: asPlan(row?.plan) ?? 'free',
    residencyRequired: settings.ai?.residencyRequired === true,
  };
}

export async function loadUserPermissionPredicate(
  userId: string,
  partnerId: string | null,
  orgId: string | null,
): Promise<(key: string) => boolean> {
  const perms = await getUserPermissions(userId, {
    ...(partnerId ? { partnerId } : {}),
    ...(orgId ? { orgId } : {}),
  });
  return (key: string) => {
    if (!perms) return false;
    const [resource, action, extra] = key.split(':');
    if (!resource || !action || extra !== undefined) return false;
    return hasPermission(perms, resource, action);
  };
}

/**
 * A legacy model string → the enabled offering with that model on the
 * surface's effective DEFAULT connection (review finding 11). The same id on
 * another connection (platform vs BYOK) would silently change destination and
 * funding, so it is never picked: no match → null (caller: invalid_model).
 * The lookup is W02's connection-scoped `findOfferingIdForModel` (W02 Task 8),
 * which W02's per-connection unique indexes make unambiguous.
 */
export async function findOfferingIdByModel(input: {
  partnerId: string; orgId: string | null; surface: AiSurface; modelId: string;
}): Promise<string | null> {
  const assignment = await getEffectiveAssignment({
    partnerId: input.partnerId, orgId: input.orgId, surface: input.surface, role: 'default',
  });
  if (!assignment.defaultOfferingId) return null;
  const def = await systemRead(() => getOffering(assignment.defaultOfferingId!));
  if (!def || def.partnerId !== input.partnerId) return null;
  const id = await systemRead(() => findOfferingIdForModel({
    partnerId: input.partnerId, connectionId: def.connectionId, modelId: input.modelId,
  }));
  if (!id) return null;
  const offering = await systemRead(() => getOffering(id));
  return offering?.enabled ? id : null;
}

export async function readOrgPartnerId(orgId: string): Promise<string | null> {
  const [row] = await systemRead(() => db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(and(eq(organizations.id, orgId)))
    .limit(1));
  return row?.partnerId ?? null;
}

/** The stored model choice of a session (W02 columns, P11); the only ai_sessions read the resolver makes. */
export async function readSessionModelRow(
  sessionId: string,
): Promise<{ orgId: string; offeringId: string | null; options: Partial<OfferingOptions> | null } | null> {
  const [row] = await systemRead(() => db
    .select({ orgId: aiSessions.orgId, offeringId: aiSessions.offeringId, options: aiSessions.options })
    .from(aiSessions)
    .where(eq(aiSessions.id, sessionId))
    .limit(1));
  return row ? { orgId: row.orgId, offeringId: row.offeringId ?? null, options: (row.options ?? null) as Partial<OfferingOptions> | null } : null;
}
```

Add the imports `getEffectiveAssignment` (`./assignments`), `findOfferingIdForModel` (`./offerings`) and `type AiSurface` (`@breeze/shared`).

W01 has no platform inference-geo setting (its spike decision D3 is open, P5), so add one to `platformModels.ts`. It is env-only until an `/admin/ai-models` field exists:

```ts
// apps/api/src/services/aiModels/platformModels.ts — append
/**
 * Platform inference geography (spec §7, §15 #5): sent where a model's
 * option_support.inferenceGeo includes it AND the transport can carry it.
 * Env-only until W01's D3 lands an /admin/ai-models field.
 */
export async function getPlatformInferenceGeo(): Promise<string | null> {
  return process.env.AI_PLATFORM_INFERENCE_GEO?.trim() || null;
}
```

Add a row for `AI_PLATFORM_INFERENCE_GEO` to `apps/docs/src/content/docs/deploy/environment.mdx`: "Optional. Inference geography sent to Claude for platform-key traffic where the model and transport support it (e.g. `eu`). Unset = provider default." 

- [ ] **Step 8: Run the loader tests**

Run: `cd apps/api && npx vitest run src/services/aiModels/candidateLoader.test.ts src/services/aiModels/eligibility.test.ts`
Expected: PASS.

- [ ] **Step 9: Seed `ai_models:premium` and type the residency setting**

```ts
// packages/shared/src/constants/permissions.ts — after AI_AGENTS_WRITE
  // AI model registry (#7598 W03, spec §5.3 / §15 #7): a partner grants this
  // deliberately to the techs who may use premium/fast offerings whose
  // `required_permission` names it. Seeded on NO role.
  AI_MODELS_PREMIUM: { resource: 'ai_models', action: 'premium' },
```

```ts
// apps/api/src/db/seed.ts — DEFAULT_PERMISSIONS, after the ai_agents rows
  { resource: 'ai_models', action: 'premium',
    description: 'Use AI model offerings that require the premium-model permission' },
```

```ts
// packages/shared/src/types/index.ts — inside PartnerSettings
  /** AI model registry (#7598). Residency fails closed in resolveModel. */
  ai?: {
    residencyRequired?: boolean;
  };
```

```sql
-- apps/api/migrations/2026-11-19-100100-ai-models-premium-permission.sql
-- ai_models:premium (#7598 W03, spec §5.3 / §15 #7). resolveModel checks an
-- offering's required_permission for user-initiated calls; this is the seeded
-- key a partner grants deliberately (premium / fast-mode models). Granted to
-- NO role: wildcard roles already match it, everyone else needs an explicit
-- role edit. Idempotent (existence-guarded); no inner transaction.
DO $$
DECLARE
  v_permission_id uuid;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  SELECT id INTO v_permission_id FROM permissions WHERE resource = 'ai_models' AND action = 'premium' LIMIT 1;
  IF v_permission_id IS NULL THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('ai_models', 'premium', 'Use AI model offerings that require the premium-model permission');
    RAISE WARNING 'seeded permission ai_models:premium';
  END IF;
END $$;
```

- [ ] **Step 10: Write the integration seed helper and the loader integration tests (real Postgres)**

```ts
// apps/api/src/__tests__/integration/helpers/aiModelRegistrySeed.ts
/**
 * W03 integration seed: ONE real partner wired end to end on the registry:
 * partner/org/user, a priced platform row, an offering on the requested kind
 * of connection, a partner assignment for every tenant surface, and a chat
 * session bound to the offering. Built from the same services the product
 * uses (W02 createConnection, the catalog admin services), not raw ciphertext.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { AI_SURFACES } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../../db';
import { createConnection } from '../../../services/aiModels/connections';
import {
  activateRevision,
  createCatalogEntry,
  createRevision,
  recordVerification,
  setEntryStatus,
} from '../../../services/llmProviderCatalog';
import { __setLookupForTests } from '../../../services/urlSafety';
import { seedOffering, seedPlatformModel } from '../aiModelRegistryFixtures';
import { createOrganization, createPartner, createUser } from '../db-utils';

export type RegistrySeedKind = 'platform' | 'byok' | 'catalog';

export interface SeededRegistryPartner {
  kind: RegistrySeedKind;
  partnerId: string;
  orgId: string;
  userId: string;
  connectionId: string | null;
  offeringId: string;
  platformModelId: string;
  modelId: string;
  catalogEntryId: string | null;
  chatSessionId: string;
}

const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

export async function seedRegistryPartner(kind: RegistrySeedKind): Promise<SeededRegistryPartner> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id });
  const platformModelId = await seedPlatformModel();                  // priced, platform_offered, available (W02 fixture)
  const [pm] = await sys(() => db.execute<{ model_id: string }>(sql`
    SELECT model_id FROM ai_platform_models WHERE id = ${platformModelId}::uuid`));
  const modelId = pm!.model_id;

  let connectionId: string | null = null;
  let catalogEntryId: string | null = null;
  let offeringId: string;
  if (kind === 'platform') {
    offeringId = await seedOffering({ partnerId: partner.id, platformModelId, enabled: true });
  } else {
    if (kind === 'catalog') {
      process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
      __setLookupForTests(async () => [{ address: '1.1.1.1', family: 4 }]);   // createRevision's SSRF check, no live DNS
      const { id: entryId } = await createCatalogEntry({ slug: `w03-${randomUUID()}`, name: 'W03 catalog (integration)' });
      const { id: revisionId } = await createRevision({
        entryId,
        baseUrl: 'https://gw.example.com/v1',
        authMode: 'x-api-key',
        modelMap: { [modelId]: { providerModel: `gw/${modelId}`, inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 } },
        createdBy: user.id,
      });
      await recordVerification({ revisionId, modelId, passed: true, verifiedBy: user.id });
      await activateRevision({ entryId, revisionId });
      await setEntryStatus({ entryId, status: 'listed' });
      catalogEntryId = entryId;
    }
    const conn = await sys(() => createConnection({
      partnerId: partner.id,
      kind: kind === 'byok' ? 'anthropic_byok' : 'catalog',
      name: `W03 ${kind}`,
      apiKey: `sk-w03-${randomUUID()}`,
      catalogEntryId,
      connectedBy: user.id,
      verifiedAt: new Date(),
    }));
    connectionId = conn.id;
    const [row] = await sys(() => db.execute<{ id: string }>(sql`
      INSERT INTO partner_ai_models (partner_id, connection_id, platform_model_id, model_id, source, enabled, lifecycle)
      VALUES (${partner.id}::uuid, ${conn.id}::uuid,
              ${kind === 'byok' ? platformModelId : null}::uuid, ${modelId},
              ${kind === 'byok' ? 'discovered' : 'catalog'}, true, 'available')
      RETURNING id`));
    offeringId = row!.id;
  }

  await sys(async () => {
    for (const surface of AI_SURFACES) {
      if (surface === 'patch_test') continue;   // platform-only, no assignment
      await db.execute(sql`
        INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, role, default_offering_id, allow_user_choice)
        VALUES (${partner.id}::uuid, ${partner.id}::uuid, ${surface}, 'default', ${offeringId}::uuid, true)`);
    }
  });

  const [session] = await sys(() => db.execute<{ id: string }>(sql`
    INSERT INTO ai_sessions (org_id, user_id, type, model, offering_id, offering_partner_id, billing_source)
    VALUES (${org.id}::uuid, ${user.id}::uuid, 'general', ${modelId}, ${offeringId}::uuid, ${partner.id}::uuid,
            ${kind === 'platform' ? 'platform' : 'partner_key'})
    RETURNING id`));

  return {
    kind, partnerId: partner.id, orgId: org.id, userId: user.id, connectionId, offeringId,
    platformModelId, modelId, catalogEntryId, chatSessionId: session!.id,
  };
}
```

> `createUser`'s argument shape is whatever `db-utils.ts` takes (see its use in `llmCatalogSelection.integration.test.ts`). `seedPlatformModel` / `seedOffering` are W02's fixtures (P14).

```ts
// apps/api/src/__tests__/integration/resolveModel.integration.test.ts
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { findOfferingIdByModel, loadOfferingCandidate } from '../../services/aiModels/candidateLoader';
import { activateRevision, createRevision } from '../../services/llmProviderCatalog';
import { seedOffering } from './aiModelRegistryFixtures';
import { seedRegistryPartner } from './helpers/aiModelRegistrySeed';

const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

describe('candidate loader against real rows', () => {
  it('an offering owned by partner B is invisible when resolving for partner A', async () => {
    const a = await seedRegistryPartner('platform');
    const b = await seedRegistryPartner('byok');
    const offeringOfB = await seedOffering({ partnerId: b.partnerId, platformModelId: a.platformModelId, enabled: true });
    await expect(loadOfferingCandidate(offeringOfB, a.partnerId)).resolves.toBeNull();
    await expect(loadOfferingCandidate(b.offeringId, a.partnerId)).resolves.toBeNull();
  });

  it('un-offering the platform row takes effect on the very next load (quorum #2)', async () => {
    const a = await seedRegistryPartner('platform');
    expect((await loadOfferingCandidate(a.offeringId, a.partnerId))!.facts.platform?.platformOffered).toBe(true);
    await sys(() => db.execute(sql`UPDATE ai_platform_models SET platform_offered = false WHERE id = ${a.platformModelId}::uuid`));
    expect((await loadOfferingCandidate(a.offeringId, a.partnerId))!.facts.platform?.platformOffered).toBe(false);
  });

  it('BYOK key flipped to status error → connection unusable on the very next load', async () => {
    const b = await seedRegistryPartner('byok');
    await sys(() => db.execute(sql`UPDATE partner_ai_connections SET status = 'error' WHERE id = ${b.connectionId}::uuid`));
    expect((await loadOfferingCandidate(b.offeringId, b.partnerId))!.facts.connection.status).toBe('error');
  });

  it('catalog revision rotated to drop the model → catalog unusable on the very next load (quorum #7)', async () => {
    const c = await seedRegistryPartner('catalog');
    expect((await loadOfferingCandidate(c.offeringId, c.partnerId))!.facts.catalog).toEqual({ usable: true });
    const { id: revisionId } = await createRevision({
      entryId: c.catalogEntryId!,
      baseUrl: 'https://gw.example.com/v1',
      authMode: 'x-api-key',
      modelMap: { [`other-${randomUUID().slice(0, 6)}`]: { providerModel: 'gw/other', inputCentsPerM: 1, outputCentsPerM: 1, cacheReadCentsPerM: 1, cacheWriteCentsPerM: 1 } },
      createdBy: c.userId,
    });
    await activateRevision({ entryId: c.catalogEntryId!, revisionId });
    expect((await loadOfferingCandidate(c.offeringId, c.partnerId))!.facts.catalog).toEqual({ usable: false });
  });

  it('a legacy model id present on BOTH platform and BYOK maps to the surface default\'s connection only (finding 11)', async () => {
    const b = await seedRegistryPartner('byok');            // BYOK offering for modelId is every surface's default
    const platformTwin = await seedOffering({ partnerId: b.partnerId, platformModelId: b.platformModelId, enabled: true });
    const find = () => findOfferingIdByModel({ partnerId: b.partnerId, orgId: b.orgId, surface: 'chat', modelId: b.modelId });
    expect(await find()).toBe(b.offeringId);
    await sys(() => db.execute(sql`
      UPDATE ai_model_assignments SET default_offering_id = ${platformTwin}::uuid
       WHERE partner_id = ${b.partnerId}::uuid AND org_id IS NULL AND surface = 'chat' AND role = 'default'`));
    expect(await find()).toBe(platformTwin);
    expect(await findOfferingIdByModel({ partnerId: b.partnerId, orgId: b.orgId, surface: 'chat', modelId: 'claude-not-offered' })).toBeNull();
  });
});
```

- [ ] **Step 11: Run the integration tests**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/resolveModel.integration.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 12: Typecheck and commit**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

```bash
git add apps/api/src/services/aiModels/eligibility.ts apps/api/src/services/aiModels/eligibility.test.ts \
  apps/api/src/services/aiModels/candidateLoader.ts apps/api/src/services/aiModels/candidateLoader.test.ts \
  apps/api/src/services/aiModels/promptProfiles.ts apps/api/migrations/2026-11-19-100100-ai-models-premium-permission.sql \
  apps/api/src/__tests__/integration/helpers/aiModelRegistrySeed.ts \
  apps/api/src/__tests__/integration/resolveModel.integration.test.ts packages/shared/src/constants/permissions.ts \
  apps/api/src/db/seed.ts packages/shared/src/types/index.ts apps/api/src/services/aiModels/platformModels.ts \
  apps/docs/src/content/docs/deploy/environment.mdx
git commit -m "feat(ai): offering eligibility rules and live candidate loader (#7601)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: `resolveModel` — assignment, candidate, bounded fallback, options, refusal fallback, rate

This task implements spec §9 in full:
- **Steps.** Effective assignment → candidate → eligibility → wire → rate.
- **Bounded fallback (§9.1).** When a stored choice (`origin: 'session' | 'policy'`) is ineligible, the resolver tries exactly one other candidate, the effective default. It uses it only if it is eligible **and** on the same connection id **and** the same funding. A fresh user request (`origin: 'user'`) never falls back: the caller shows the picker.
- **Options (§7).** Each key independently takes the first of request → assignment `options` → offering `default_options` → omitted. Support is clamped to `allowed_options ∩ model support`. `speed: fast` is supported only when the model has a `speed:fast` option rate.
- **Refusal fallback.** It is carried only when it is eligible and on the same connection and funding. Its own rate snapshot is included.

**Files:**
- Create: `apps/api/src/services/aiModels/transport.ts`, `apps/api/src/services/aiModels/transport.test.ts`
- Create: `apps/api/src/services/aiModels/resolveModel.ts`, `apps/api/src/services/aiModels/resolveModel.test.ts`
- Modify: `apps/api/src/services/aiModels/index.ts` (re-export `resolveModel` and its types; also re-export Task 2's `ResolveFailureReason`)
- Modify: `apps/api/src/__tests__/integration/resolveModel.integration.test.ts` (append the resolver half)

**Interfaces:**
- Consumes: Task 2 (`loadOfferingCandidate`, `loadPlatformDefaultCandidate`, `loadPartnerFacts`, `loadUserPermissionPredicate`, `checkEligibility`, `LoadedCandidate`, `ResolvedConnection`, `AllowedOptions`, `PromptProfile`). P9 `getEffectiveAssignment`, `isPermitted`. P4 `buildWireParams`, `WireParams`, `toAgentSdkOptions`, `toMessagesApiParams`, `UnsupportedWireOptionError`. P3 `ThinkingMode`, `DerivedCapabilities`. P6 `RateSnapshot`. `isHosted()` from `config/env.ts`.
- Produces (index name `resolveModel`; signature per spec §9, with additive fields listed under "Index additions"):
  ```ts
  // transport.ts
  export type DispatchTransport = 'agent_sdk' | 'messages_api';
  export interface TransportCarriage { speed: boolean; inferenceGeo: boolean; thinkingDisplayUpdates: boolean }
  export function defaultTransport(surface: AiSurface): DispatchTransport;   // TOOL_REQUIRING_SURFACES → agent_sdk
  export function transportCarries(transport: DispatchTransport): TransportCarriage;   // probed against W01's adapters

  export const PLATFORM_ONLY_SURFACES: readonly ['patch_test'];
  export type RequestOrigin = 'user' | 'session' | 'policy';
  export interface ResolveModelInput {
    partnerId: string | null;                // null only for PLATFORM_ONLY_SURFACES
    orgId: string | null;                    // null for patch_test and system-initiated catalog enrichment
    userId?: string | null;                  // set ⇒ user-initiated (required_permission applies)
    surface: AiSurface;
    role?: string;                           // default 'default'; v1 resolves only 'default'
    requested?: { offeringId?: string; options?: Partial<OfferingOptions>; origin?: RequestOrigin };
    maxTokens?: number;                      // the call's max_tokens, for the manual thinking budget
    transport?: DispatchTransport;           // default: defaultTransport(surface); ticket draft passes 'messages_api'
  }
  export interface ResolvedOffering { id: string | null; displayName: string }
  export interface ResolvedRefusalFallback {
    offeringId: string; displayName: string; wireModel: string;
    wireParams: WireParams; options: OfferingOptions; rateSnapshot: RateSnapshot;
  }
  export interface ResolvedModel {
    ok: true;
    surface: AiSurface; role: string; transport: DispatchTransport;
    partnerId: string | null; orgId: string | null;
    offering: ResolvedOffering;
    connection: ResolvedConnection;          // config: UsableLlmConfig — what the SDK env builder and client factory consume
    funding: AiBillingSource;
    logicalModel: string;
    wireModel: string;
    thinking: ThinkingMode;
    wireParams: WireParams;
    options: OfferingOptions;                // = wireParams.applied (what is actually sent)
    inferenceGeo: string | null;             // what is actually sent
    refusalFallback?: ResolvedRefusalFallback;
    promptProfile: PromptProfile;
    rateSnapshot: RateSnapshot;
    capabilities: DerivedCapabilities;
    limits: { maxInputTokens: number | null; maxOutputTokens: number | null };
    catalogRevisionId?: string;
    configVersion?: number;
    fellBack: boolean;                       // §9.1 bounded fallback served this resolve
  }
  export interface ModelUnavailable {
    ok: false; reason: ResolveFailureReason; recoverable: true;
    offeringId: string | null; message: string;
  }
  export type ResolveModelResult = ResolvedModel | ModelUnavailable;
  export function resolveModel(input: ResolveModelInput): Promise<ResolveModelResult>;
  export function unavailableMessage(reason: ResolveFailureReason, displayName?: string): string;
  ```

- [ ] **Step 1: Write the failing tests (transport carriage, then the resolver table)**

```ts
// apps/api/src/services/aiModels/transport.test.ts
import { describe, expect, it, vi } from 'vitest';

class UnsupportedWireOptionError extends Error {}
vi.mock('./wireParams', () => ({
  UnsupportedWireOptionError,
  // Stand-in for a W01 state where the SDK can carry thinking display + geo but not fast mode.
  toAgentSdkOptions: (w: { speed?: string }) => { if (w.speed) throw new UnsupportedWireOptionError('speed'); return {}; },
  toMessagesApiParams: (w: { speed?: string; inferenceGeo?: string; thinking?: { display?: string } }) => {
    if (w.speed || w.inferenceGeo || w.thinking?.display === 'updates') throw new UnsupportedWireOptionError('x');
    return {};
  },
}));

import { defaultTransport, transportCarries } from './transport';

describe('transport', () => {
  it('tool-requiring surfaces run the Agent SDK; one-shots the Messages API', () => {
    expect(defaultTransport('chat')).toBe('agent_sdk');
    expect(defaultTransport('ai_agents')).toBe('agent_sdk');
    expect(defaultTransport('script_reviewer')).toBe('messages_api');
    expect(defaultTransport('patch_test')).toBe('messages_api');
  });
  it('carriage is exactly what W01\'s adapter accepts, per transport', () => {
    expect(transportCarries('agent_sdk')).toEqual({ speed: false, inferenceGeo: true, thinkingDisplayUpdates: true });
    expect(transportCarries('messages_api')).toEqual({ speed: false, inferenceGeo: false, thinkingDisplayUpdates: false });
  });
});
```

```ts
// apps/api/src/services/aiModels/resolveModel.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedCandidate } from './candidateLoader';

const m = vi.hoisted(() => ({
  getEffectiveAssignment: vi.fn(),
  loadOfferingCandidate: vi.fn(),
  loadPlatformDefaultCandidate: vi.fn(),
  loadPartnerFacts: vi.fn(),
  loadUserPermissionPredicate: vi.fn(),
  isHosted: vi.fn(() => true),
  transportCarries: vi.fn(() => ({ speed: true, inferenceGeo: true, thinkingDisplayUpdates: true })),
}));
vi.mock('./assignments', () => ({
  getEffectiveAssignment: m.getEffectiveAssignment,
  isPermitted: (set: { kind: 'all' } | { kind: 'list'; offeringIds: string[] }, id: string) =>
    set.kind === 'all' || set.offeringIds.includes(id),
}));
vi.mock('./transport', () => ({
  defaultTransport: () => 'agent_sdk',
  transportCarries: m.transportCarries,
}));
vi.mock('./candidateLoader', () => ({
  loadOfferingCandidate: m.loadOfferingCandidate,
  loadPlatformDefaultCandidate: m.loadPlatformDefaultCandidate,
  loadPartnerFacts: m.loadPartnerFacts,
  loadUserPermissionPredicate: m.loadUserPermissionPredicate,
}));
vi.mock('../../config/env', () => ({ isHosted: m.isHosted }));
// A faithful stand-in for W01's buildWireParams: clamp each requested key to support.
vi.mock('./wireParams', () => ({
  buildWireParams: vi.fn((i: {
    thinkingMode: string;
    optionSupport: { effort: string[]; speed: string[]; thinkingDisplay: string[]; inferenceGeo: string[] };
    requested: { effort?: string; speed?: string; thinkingDisplay?: string };
    inferenceGeo?: string | null;
  }) => {
    const applied: Record<string, string> = {};
    if (i.requested.effort && i.optionSupport.effort.includes(i.requested.effort)) applied.effort = i.requested.effort;
    if (i.requested.speed && i.optionSupport.speed.includes(i.requested.speed)) applied.speed = i.requested.speed;
    if (i.requested.thinkingDisplay && i.optionSupport.thinkingDisplay.includes(i.requested.thinkingDisplay)) {
      applied.thinkingDisplay = i.requested.thinkingDisplay;
    }
    const geo = i.inferenceGeo && i.optionSupport.inferenceGeo.includes(i.inferenceGeo) ? i.inferenceGeo : undefined;
    return {
      ...(i.thinkingMode === 'adaptive' ? { thinking: { type: 'adaptive' } } : {}),
      ...(applied.effort ? { effort: applied.effort } : {}),
      ...(applied.speed === 'fast' ? { speed: 'fast' } : {}),
      ...(geo ? { inferenceGeo: geo } : {}),
      betas: applied.speed === 'fast' ? ['fast-mode-2026-02-01'] : [],
      applied,
    };
  }),
}));

import { resolveModel } from './resolveModel';

const STD = { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 };
const FAST = { inputCentsPerM: 400, outputCentsPerM: 2000, cacheReadCentsPerM: 40, cacheWriteCentsPerM: 500 };

function cand(id: string, over: Partial<LoadedCandidate> = {}, facts: Partial<LoadedCandidate['facts']> = {}): LoadedCandidate {
  const connectionId = over.connectionId ?? null;
  return {
    offeringId: id,
    connectionId,
    displayName: `Model ${id}`,
    logicalModel: `logical-${id}`,
    wireModel: `wire-${id}`,
    connection: connectionId === null
      ? { id: null, kind: 'platform', config: { source: 'platform', apiKey: 'k', model: `logical-${id}` } }
      : { id: connectionId, kind: 'anthropic_byok', config: {
          source: 'partner', partnerId: 'p1', apiKey: 'pk', model: `logical-${id}`,
          configId: connectionId, configVersion: 3, endpoint: { kind: 'anthropic' } } },
    funding: connectionId === null ? 'platform' : 'partner_key',
    capabilities: { thinkingMode: 'adaptive', effortLevels: ['low', 'medium', 'high', 'max'], supportsTools: true, supportsVision: false },
    optionSupport: { effort: ['low', 'medium', 'high', 'max'], thinkingDisplay: ['summarized', 'updates'], speed: ['standard', 'fast'], inferenceGeo: ['us', 'eu'] },
    optionRates: { 'speed:fast': FAST },
    defaultOptions: null,
    allowedOptions: null,
    refusalFallbackOfferingId: null,
    promptProfile: 'claude-standard',
    limits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
    ...over,
    facts: {
      ownerPartnerId: 'p1',
      enabled: true,
      lifecycle: 'available',
      requiredPermission: null,
      platform: connectionId === null ? { platformOffered: true, lifecycle: 'available', minPlan: null } : null,
      connection: { kind: connectionId === null ? 'platform' : 'anthropic_byok', status: 'active', keyUsable: true },
      catalog: null,
      rate: { source: connectionId === null ? 'platform' : 'linked_platform', standard: STD },
      supportsTools: true,
      inferenceGeo: null,
      supportedInferenceGeos: ['us', 'eu'],
      ...facts,
    },
  };
}

const ASSIGNMENT = {
  surface: 'chat', role: 'default', defaultOfferingId: 'def', defaultSource: 'partner',
  permitted: { kind: 'list', offeringIds: ['def', 'alt'] }, allowUserChoice: true, options: {},
  fallbackOfferingIds: [], fallbackMayCrossFunding: false, warnings: [],
};
const BASE = { partnerId: 'p1', orgId: 'o1', surface: 'chat' as const };

let candidates: Record<string, LoadedCandidate | null>;

beforeEach(() => {
  vi.clearAllMocks();
  candidates = { def: cand('def'), alt: cand('alt') };
  m.getEffectiveAssignment.mockResolvedValue(ASSIGNMENT);
  m.transportCarries.mockReturnValue({ speed: true, inferenceGeo: true, thinkingDisplayUpdates: true });
  m.loadOfferingCandidate.mockImplementation(async (id: string) => candidates[id] ?? null);
  m.loadPartnerFacts.mockResolvedValue({ plan: 'pro', residencyRequired: false });
  m.loadUserPermissionPredicate.mockResolvedValue(() => false);
});

describe('resolveModel — candidate selection', () => {
  it('uses the effective default when nothing is requested', async () => {
    const r = await resolveModel(BASE);
    expect(r).toMatchObject({ ok: true, wireModel: 'wire-def', funding: 'platform', fellBack: false, promptProfile: 'claude-standard' });
    expect(m.getEffectiveAssignment).toHaveBeenCalledWith({ partnerId: 'p1', orgId: 'o1', surface: 'chat', role: 'default' });
  });

  it('honours a user request inside the permitted set when user choice is allowed', async () => {
    const r = await resolveModel({ ...BASE, userId: 'u1', requested: { offeringId: 'alt' } });
    expect(r).toMatchObject({ ok: true, wireModel: 'wire-alt' });
  });

  it('refuses a user request when allow_user_choice is false (no fallback for a fresh choice)', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ ...ASSIGNMENT, allowUserChoice: false });
    const r = await resolveModel({ ...BASE, userId: 'u1', requested: { offeringId: 'alt', origin: 'user' } });
    expect(r).toMatchObject({ ok: false, reason: 'not_permitted', recoverable: true });
  });

  it('refuses a user request outside the permitted set', async () => {
    candidates.out = cand('out');
    const r = await resolveModel({ ...BASE, userId: 'u1', requested: { offeringId: 'out' } });
    expect(r).toMatchObject({ ok: false, reason: 'not_permitted' });
    expect(m.loadOfferingCandidate).not.toHaveBeenCalledWith('out', 'p1');
  });

  it('a foreign offering id is not_permitted and reveals nothing (loader returned null)', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ ...ASSIGNMENT, permitted: { kind: 'all' } });
    const r = await resolveModel({ ...BASE, userId: 'u1', requested: { offeringId: 'foreign' } });
    expect(r).toEqual({
      ok: false, reason: 'not_permitted', recoverable: true, offeringId: 'foreign',
      message: 'This AI model is not available here. Choose another model.',
    });
  });

  it('a policy choice ignores allow_user_choice but still needs the permitted set', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ ...ASSIGNMENT, allowUserChoice: false });
    expect(await resolveModel({ ...BASE, surface: 'ai_agents', requested: { offeringId: 'alt', origin: 'policy' } }))
      .toMatchObject({ ok: true, wireModel: 'wire-alt', fellBack: false });
  });

  it('returns no_eligible_model when the surface has no assignment', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ ...ASSIGNMENT, defaultOfferingId: null, defaultSource: 'none' });
    expect(await resolveModel(BASE)).toMatchObject({ ok: false, reason: 'no_eligible_model' });
  });

  it('rejects a role the surface does not define', async () => {
    await expect(resolveModel({ ...BASE, role: 'triage' })).rejects.toThrow(/not a role of chat/);
  });
});

describe('resolveModel — §9.1 bounded fallback for stored choices', () => {
  it('stored session offering disabled → falls back to the default on the same connection', async () => {
    candidates.alt = cand('alt', {}, { enabled: false });
    const r = await resolveModel({ ...BASE, requested: { offeringId: 'alt', origin: 'session' } });
    expect(r).toMatchObject({ ok: true, wireModel: 'wire-def', fellBack: true });
  });

  it('stored offering now outside the permitted set → falls back the same way', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ ...ASSIGNMENT, permitted: { kind: 'list', offeringIds: ['def'] } });
    const r = await resolveModel({ ...BASE, requested: { offeringId: 'alt', origin: 'session' } });
    expect(r).toMatchObject({ ok: true, wireModel: 'wire-def', fellBack: true });
  });

  it('refuses when the default is on a different connection', async () => {
    candidates.alt = cand('alt', { connectionId: 'conn-A' }, { enabled: false });
    candidates.def = cand('def', { connectionId: 'conn-B' });
    const r = await resolveModel({ ...BASE, requested: { offeringId: 'alt', origin: 'session' } });
    expect(r).toMatchObject({ ok: false, reason: 'model_unavailable', recoverable: true, offeringId: 'alt' });
    expect((r as { message: string }).message).toBe('Model Model alt is no longer available — choose another.');
  });

  it('refuses when the default changes funding (BYOK stored, platform default)', async () => {
    candidates.alt = cand('alt', { connectionId: 'conn-A' }, { enabled: false });
    const r = await resolveModel({ ...BASE, requested: { offeringId: 'alt', origin: 'session' } });
    expect(r).toMatchObject({ ok: false, reason: 'model_unavailable' });
  });

  it('refuses when the default itself is ineligible (exactly one candidate)', async () => {
    candidates.alt = cand('alt', {}, { enabled: false });
    candidates.def = cand('def', {}, { platform: { platformOffered: false, lifecycle: 'available', minPlan: null } });
    expect(await resolveModel({ ...BASE, requested: { offeringId: 'alt', origin: 'session' } }))
      .toMatchObject({ ok: false, reason: 'model_unavailable' });
    expect(m.loadOfferingCandidate).toHaveBeenCalledTimes(2);
  });

  it('a deleted stored offering cannot prove its connection, so it refuses', async () => {
    candidates.alt = null;
    expect(await resolveModel({ ...BASE, requested: { offeringId: 'alt', origin: 'session' } }))
      .toMatchObject({ ok: false, reason: 'not_permitted' });
  });

  it('plan downgrade below min_plan → plan_required on the stored platform model, same-connection default serves', async () => {
    candidates.alt = cand('alt', {}, { platform: { platformOffered: true, lifecycle: 'available', minPlan: 'enterprise' } });
    expect(await resolveModel({ ...BASE, requested: { offeringId: 'alt', origin: 'session' } }))
      .toMatchObject({ ok: true, wireModel: 'wire-def', fellBack: true });
  });
});

describe('resolveModel — gates that need request context', () => {
  it('loads the permission predicate only for user-initiated calls', async () => {
    candidates.def = cand('def', {}, { requiredPermission: 'ai_models:premium' });
    expect(await resolveModel({ ...BASE, userId: 'u1' })).toMatchObject({ ok: false, reason: 'permission_required' });
    expect(m.loadUserPermissionPredicate).toHaveBeenCalledWith('u1', 'p1', 'o1');
    m.loadUserPermissionPredicate.mockClear();
    expect(await resolveModel({ ...BASE, surface: 'ai_agents' })).toMatchObject({ ok: true });
    expect(m.loadUserPermissionPredicate).not.toHaveBeenCalled();
  });

  it('residency required: fails closed', async () => {
    m.loadPartnerFacts.mockResolvedValue({ plan: 'pro', residencyRequired: true });
    expect(await resolveModel(BASE)).toMatchObject({ ok: false, reason: 'residency_unavailable' });
    candidates.def = cand('def', {}, { inferenceGeo: 'eu' });
    expect(await resolveModel(BASE)).toMatchObject({ ok: true, inferenceGeo: 'eu' });
  });
});

describe('resolveModel — §7 options', () => {
  it('request beats assignment beats offering default, per key', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ ...ASSIGNMENT, options: { effort: 'low', thinkingDisplay: 'summarized' } });
    candidates.def = cand('def', { defaultOptions: { effort: 'high', thinkingDisplay: 'updates', speed: 'standard' } });
    const r = await resolveModel({ ...BASE, requested: { options: { effort: 'max' } } });
    expect(r).toMatchObject({ ok: true, options: { effort: 'max', thinkingDisplay: 'summarized', speed: 'standard' } });
  });

  it('allowed_options clamps support (a disallowed effort is omitted, never sent)', async () => {
    candidates.def = cand('def', { allowedOptions: { effort: ['low', 'medium'] } });
    const r = await resolveModel({ ...BASE, requested: { options: { effort: 'max' } } });
    expect(r).toMatchObject({ ok: true });
    expect((r as { options: object }).options).not.toHaveProperty('effort');
  });

  it('fast is selectable only with an option rate, and then the snapshot carries it', async () => {
    candidates.def = cand('def', { optionRates: null });
    const noRate = await resolveModel({ ...BASE, requested: { options: { speed: 'fast' } } });
    expect((noRate as { options: object }).options).not.toHaveProperty('speed');
    expect((noRate as { rateSnapshot: object }).rateSnapshot).not.toHaveProperty('option');

    candidates.def = cand('def');
    const withRate = await resolveModel({ ...BASE, requested: { options: { speed: 'fast' } } });
    expect(withRate).toMatchObject({
      ok: true,
      options: { speed: 'fast' },
      rateSnapshot: { source: 'platform', standard: STD, option: { key: 'speed:fast', rates: FAST } },
    });
  });
});

describe('resolveModel — transport carriage (W01 adapters refuse what they cannot send)', () => {
  it('fast and geo are never applied — or priced — on a transport that cannot carry them', async () => {
    m.transportCarries.mockReturnValue({ speed: false, inferenceGeo: false, thinkingDisplayUpdates: false });
    candidates.def = cand('def', {}, { inferenceGeo: 'eu' });
    const r = await resolveModel({ ...BASE, requested: { options: { speed: 'fast', thinkingDisplay: 'updates' } } });
    expect(r).toMatchObject({ ok: true, inferenceGeo: null, transport: 'agent_sdk' });
    expect((r as { options: object }).options).toEqual({});
    expect((r as { rateSnapshot: object }).rateSnapshot).not.toHaveProperty('option');
  });

  it('residency required on a transport that cannot carry a geography fails closed', async () => {
    m.transportCarries.mockReturnValue({ speed: true, inferenceGeo: false, thinkingDisplayUpdates: true });
    m.loadPartnerFacts.mockResolvedValue({ plan: 'pro', residencyRequired: true });
    candidates.def = cand('def', {}, { inferenceGeo: 'eu' });
    expect(await resolveModel(BASE)).toMatchObject({ ok: false, reason: 'residency_unavailable' });
  });
});

describe('resolveModel — refusal fallback', () => {
  it('Messages API: carries an eligible same-connection fallback with its own (different) rate', async () => {
    candidates.def = cand('def', { refusalFallbackOfferingId: 'fb' });
    candidates.fb = cand('fb', {}, { rate: { source: 'platform', standard: FAST } });
    const r = await resolveModel({ ...BASE, transport: 'messages_api' });
    expect(r).toMatchObject({
      ok: true,
      refusalFallback: { offeringId: 'fb', wireModel: 'wire-fb', rateSnapshot: { source: 'platform', standard: FAST } },
    });
  });

  it('Agent SDK: a differently priced fallback is dropped (overload fallback is unattributable, finding 3)', async () => {
    candidates.def = cand('def', { refusalFallbackOfferingId: 'fb' });
    candidates.fb = cand('fb', {}, { rate: { source: 'platform', standard: FAST } });
    expect(await resolveModel({ ...BASE, transport: 'agent_sdk' })).not.toHaveProperty('refusalFallback');
  });

  it('Agent SDK: an equally priced fallback is carried', async () => {
    candidates.def = cand('def', { refusalFallbackOfferingId: 'fb' });
    candidates.fb = cand('fb');
    expect(await resolveModel({ ...BASE, transport: 'agent_sdk' })).toMatchObject({ refusalFallback: { offeringId: 'fb' } });
  });

  it('drops a fallback on another connection', async () => {
    candidates.def = cand('def', { refusalFallbackOfferingId: 'fb' });
    candidates.fb = cand('fb', { connectionId: 'conn-X' });
    expect(await resolveModel(BASE)).not.toHaveProperty('refusalFallback');
  });

  it('drops an ineligible fallback', async () => {
    candidates.def = cand('def', { refusalFallbackOfferingId: 'fb' });
    candidates.fb = cand('fb', {}, { rate: null });
    expect(await resolveModel(BASE)).not.toHaveProperty('refusalFallback');
  });
});

describe('resolveModel — platform-only system surface', () => {
  it('patch_test resolves the platform default with no partner and no assignment', async () => {
    m.loadPlatformDefaultCandidate.mockResolvedValue(cand('sys', { offeringId: null }, { ownerPartnerId: null }));
    const r = await resolveModel({ partnerId: null, orgId: null, surface: 'patch_test' });
    expect(r).toMatchObject({ ok: true, funding: 'platform', offering: { id: null } });
    expect(m.getEffectiveAssignment).not.toHaveBeenCalled();
  });

  it('a partnerless call on a tenant surface is a programming error', async () => {
    await expect(resolveModel({ partnerId: null, orgId: null, surface: 'chat' })).rejects.toThrow(/requires a partner/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/transport.test.ts src/services/aiModels/resolveModel.test.ts`
Expected: FAIL with `Failed to resolve import "./transport"` / `"./resolveModel"`.

- [ ] **Step 3: Implement `transport.ts` and `resolveModel.ts`**

```ts
// apps/api/src/services/aiModels/transport.ts
/**
 * Which wire options a dispatch transport can carry TODAY. W01's adapters
 * throw UnsupportedWireOptionError for thinkingDisplay 'updates', speed and
 * inferenceGeo until its spike (D1–D3) enables them; probing the adapters
 * themselves keeps this in lockstep with what dispatch will actually send.
 */
import { TOOL_REQUIRING_SURFACES, type AiSurface } from '@breeze/shared';
import { UnsupportedWireOptionError, toAgentSdkOptions, toMessagesApiParams, type WireParams } from './wireParams';

export type DispatchTransport = 'agent_sdk' | 'messages_api';
export interface TransportCarriage { speed: boolean; inferenceGeo: boolean; thinkingDisplayUpdates: boolean }

export function defaultTransport(surface: AiSurface): DispatchTransport {
  return (TOOL_REQUIRING_SURFACES as readonly string[]).includes(surface) ? 'agent_sdk' : 'messages_api';
}

const carriageCache = new Map<DispatchTransport, TransportCarriage>();

export function transportCarries(transport: DispatchTransport): TransportCarriage {
  const cached = carriageCache.get(transport);
  if (cached) return cached;
  const accepts = (wire: Partial<WireParams>): boolean => {
    const probe = { betas: [], applied: {}, ...wire } as WireParams;
    try {
      if (transport === 'agent_sdk') toAgentSdkOptions(probe);
      else toMessagesApiParams(probe, { thinksWhenOmitted: true });
      return true;
    } catch (error) {
      if (error instanceof UnsupportedWireOptionError) return false;
      throw error;
    }
  };
  const carriage: TransportCarriage = {
    speed: accepts({ speed: 'fast' }),
    inferenceGeo: accepts({ inferenceGeo: 'probe' }),
    thinkingDisplayUpdates: accepts({ thinking: { type: 'adaptive', display: 'updates' } }),
  };
  carriageCache.set(transport, carriage);
  return carriage;
}
```

```ts
// apps/api/src/services/aiModels/resolveModel.ts
/**
 * The ONE place a model is chosen for a call (spec §9). Every surface calls
 * this before admission; funding, wire parameters and the rate snapshot it
 * returns are what admission, dispatch and settlement use. Nothing here
 * caches: every call re-reads assignment, offering, platform row, connection
 * and catalog revision (quorum #2, #7).
 */
import {
  AI_SURFACE_ROLES,
  type AiSurface,
  type OfferingOptions,
  type OptionSupport,
} from '@breeze/shared';
import { isHosted } from '../../config/env';
import type { AiBillingSource } from '../aiCostTracker';
import { getEffectiveAssignment, isPermitted } from './assignments';
import type { DerivedCapabilities, ThinkingMode } from './capabilities';
import {
  loadOfferingCandidate,
  loadPartnerFacts,
  loadPlatformDefaultCandidate,
  loadUserPermissionPredicate,
  type AllowedOptions,
  type LoadedCandidate,
  type ResolvedConnection,
} from './candidateLoader';
import { checkEligibility, type EligibilityContext, type ResolveFailureReason } from './eligibility';
import type { RateSnapshot } from './pricing';
import type { PromptProfile } from './promptProfiles';
import { defaultTransport, transportCarries, type DispatchTransport, type TransportCarriage } from './transport';
import { buildWireParams, type WireParams } from './wireParams';

export const PLATFORM_ONLY_SURFACES = ['patch_test'] as const satisfies readonly AiSurface[];
export type RequestOrigin = 'user' | 'session' | 'policy';

export interface ResolveModelInput {
  partnerId: string | null;
  orgId: string | null;
  userId?: string | null;
  surface: AiSurface;
  role?: string;
  requested?: { offeringId?: string; options?: Partial<OfferingOptions>; origin?: RequestOrigin };
  maxTokens?: number;
  transport?: DispatchTransport;
}

export interface ResolvedOffering { id: string | null; displayName: string }

export interface ResolvedRefusalFallback {
  offeringId: string;
  displayName: string;
  wireModel: string;
  wireParams: WireParams;
  options: OfferingOptions;
  rateSnapshot: RateSnapshot;
}

export interface ResolvedModel {
  ok: true;
  surface: AiSurface;
  role: string;
  transport: DispatchTransport;
  partnerId: string | null;
  orgId: string | null;
  offering: ResolvedOffering;
  connection: ResolvedConnection;
  funding: AiBillingSource;
  logicalModel: string;
  wireModel: string;
  thinking: ThinkingMode;
  wireParams: WireParams;
  options: OfferingOptions;
  inferenceGeo: string | null;
  refusalFallback?: ResolvedRefusalFallback;
  promptProfile: PromptProfile;
  rateSnapshot: RateSnapshot;
  capabilities: DerivedCapabilities;
  limits: { maxInputTokens: number | null; maxOutputTokens: number | null };
  catalogRevisionId?: string;
  configVersion?: number;
  fellBack: boolean;
}

export interface ModelUnavailable {
  ok: false;
  reason: ResolveFailureReason;
  recoverable: true;
  offeringId: string | null;
  message: string;
}

export type ResolveModelResult = ResolvedModel | ModelUnavailable;

/** Used when neither the caller nor the model states an output cap. */
const DEFAULT_MAX_TOKENS = 8192;

export function unavailableMessage(reason: ResolveFailureReason, displayName?: string): string {
  switch (reason) {
    case 'model_unavailable':
      return displayName
        ? `Model ${displayName} is no longer available — choose another.`
        : 'This AI model is no longer available. Choose another model.';
    case 'not_permitted': return 'This AI model is not available here. Choose another model.';
    case 'permission_required': return 'Your role does not allow this AI model. Choose another model.';
    case 'plan_required': return 'This AI model requires a higher plan.';
    case 'residency_unavailable': return 'No AI model is available that keeps data in the required region.';
    case 'unpriced': return 'This AI model has no price set and cannot be used yet.';
    case 'connection_unavailable':
      return 'The AI provider connection for this model is unavailable. Reconnect it under AI Providers & Models.';
    case 'tools_unsupported': return 'This AI model cannot use tools, which this feature needs.';
    case 'no_eligible_model': return 'No AI model is available for this feature. Ask an administrator to enable one.';
  }
}

function unavailable(reason: ResolveFailureReason, offeringId: string | null, displayName?: string): ModelUnavailable {
  return { ok: false, reason, recoverable: true, offeringId, message: unavailableMessage(reason, displayName) };
}

function intersect<T>(support: readonly T[], allowed: readonly T[] | undefined): T[] {
  return allowed === undefined ? [...support] : support.filter((v) => allowed.includes(v));
}

/**
 * §7: support clamped to allowed_options; fast only where it has a rate; and
 * nothing the dispatch transport cannot carry (W01's adapters throw on it), so
 * an option is never applied — or priced — unless it will actually be sent.
 */
function clampSupport(c: LoadedCandidate, carriage: TransportCarriage): OptionSupport {
  const allowed: AllowedOptions | null = c.allowedOptions;
  return {
    effort: intersect(c.optionSupport.effort, allowed?.effort),
    thinkingDisplay: intersect(c.optionSupport.thinkingDisplay, allowed?.thinkingDisplay)
      .filter((d) => d !== 'updates' || carriage.thinkingDisplayUpdates),
    speed: intersect(c.optionSupport.speed, allowed?.speed)
      .filter((s) => s !== 'fast' || (carriage.speed && Boolean(c.optionRates?.['speed:fast']))),
    inferenceGeo: carriage.inferenceGeo ? [...c.optionSupport.inferenceGeo] : [],
  };
}

/** §7: request → assignment → offering default → omitted, per key. */
function requestedOptions(
  c: LoadedCandidate,
  fromRequest: Partial<OfferingOptions> | undefined,
  fromAssignment: Partial<OfferingOptions> | undefined,
): OfferingOptions {
  const out: Record<string, unknown> = {};
  for (const key of ['effort', 'thinkingDisplay', 'speed'] as const) {
    const value = fromRequest?.[key] ?? fromAssignment?.[key] ?? c.defaultOptions?.[key];
    if (value !== undefined) out[key] = value;
  }
  return out as OfferingOptions;
}

function rateFor(c: LoadedCandidate, applied: OfferingOptions): RateSnapshot {
  const base = c.facts.rate!;
  const fast = applied.speed === 'fast' ? c.optionRates?.['speed:fast'] : undefined;
  return fast ? { ...base, option: { key: 'speed:fast', rates: fast } } : base;
}

function wireFor(
  c: LoadedCandidate,
  requested: OfferingOptions,
  maxTokens: number | undefined,
  carriage: TransportCarriage,
): WireParams {
  return buildWireParams({
    thinkingMode: c.capabilities.thinkingMode,
    optionSupport: clampSupport(c, carriage),
    requested,
    inferenceGeo: c.facts.inferenceGeo,
    maxTokens: maxTokens ?? c.limits.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
  });
}

function sameRates(a: RateSnapshot, b: RateSnapshot): boolean {
  return JSON.stringify([a.standard, a.option ?? null]) === JSON.stringify([b.standard, b.option ?? null]);
}

async function refusalFallbackFor(
  primary: LoadedCandidate,
  partnerId: string,
  ctx: EligibilityContext,
  maxTokens: number | undefined,
  carriage: TransportCarriage,
  transport: DispatchTransport,
  primaryRate: RateSnapshot,
): Promise<ResolvedRefusalFallback | undefined> {
  const id = primary.refusalFallbackOfferingId;
  if (!id) return undefined;
  const fb = await loadOfferingCandidate(id, partnerId);
  const sameRoute = fb !== null && fb.connectionId === primary.connectionId && fb.funding === primary.funding;
  if (!fb || !sameRoute || checkEligibility(fb.facts, ctx) !== null) {
    console.warn('[resolveModel] refusal fallback skipped (ineligible or crosses connection/funding)', {
      offeringId: primary.offeringId, fallbackOfferingId: id,
    });
    return undefined;
  }
  const wireParams = wireFor(fb, requestedOptions(fb, undefined, undefined), maxTokens, carriage);
  const fbRate = rateFor(fb, wireParams.applied);
  // Review finding 3: the Agent SDK's `fallbackModel` also fires on OVERLOAD,
  // and its per-turn usage cannot say which model served — so on the SDK
  // transport a fallback is only carried when it bills at the primary's
  // rates (then the attribution question cannot change the price). The
  // Messages API attributes per iteration/attempt, so it carries any.
  if (transport === 'agent_sdk' && !sameRates(fbRate, primaryRate)) {
    console.warn('[resolveModel] refusal fallback dropped on the Agent SDK transport: priced differently from the primary', {
      offeringId: primary.offeringId, fallbackOfferingId: id,
    });
    return undefined;
  }
  return {
    offeringId: id,
    displayName: fb.displayName,
    wireModel: fb.wireModel,
    wireParams,
    options: wireParams.applied,
    rateSnapshot: fbRate,
  };
}

async function finalize(
  c: LoadedCandidate,
  input: ResolveModelInput,
  role: string,
  assignmentOptions: Partial<OfferingOptions> | undefined,
  ctx: EligibilityContext,
  fellBack: boolean,
  transport: DispatchTransport,
): Promise<ResolveModelResult> {
  const carriage = transportCarries(transport);
  // Eligibility guarantees both; restated so the types narrow without `!`.
  if (!c.connection || !c.facts.rate) return unavailable('connection_unavailable', c.offeringId, c.displayName);
  // A stored choice's options survive a fallback: clamping to the fallback
  // model's support drops anything it cannot honour.
  const requested = requestedOptions(c, input.requested?.options, assignmentOptions);
  const wireParams = wireFor(c, requested, input.maxTokens, carriage);
  const primaryRate = rateFor(c, wireParams.applied);
  const refusalFallback = input.partnerId
    ? await refusalFallbackFor(c, input.partnerId, ctx, input.maxTokens, carriage, transport, primaryRate)
    : undefined;
  return {
    ok: true,
    surface: input.surface,
    role,
    transport,
    partnerId: input.partnerId,
    orgId: input.orgId,
    offering: { id: c.offeringId, displayName: c.displayName },
    connection: c.connection,
    funding: c.funding,
    logicalModel: c.logicalModel,
    wireModel: c.wireModel,
    thinking: c.capabilities.thinkingMode,
    wireParams,
    options: wireParams.applied,
    inferenceGeo: wireParams.inferenceGeo ?? null,
    ...(refusalFallback ? { refusalFallback } : {}),
    promptProfile: c.promptProfile,
    rateSnapshot: primaryRate,
    capabilities: c.capabilities,
    limits: c.limits,
    ...(c.catalogRevisionId ? { catalogRevisionId: c.catalogRevisionId } : {}),
    ...(c.configVersion !== undefined ? { configVersion: c.configVersion } : {}),
    fellBack,
  };
}

export async function resolveModel(input: ResolveModelInput): Promise<ResolveModelResult> {
  const role = input.role ?? 'default';
  if (!(AI_SURFACE_ROLES[input.surface] as readonly string[]).includes(role)) {
    throw new Error(`'${role}' is not a role of ${input.surface}`);
  }
  const transport = input.transport ?? defaultTransport(input.surface);
  const geoCarriable = transportCarries(transport).inferenceGeo;

  // Platform-only system surfaces: no partner, no assignment, platform default.
  if ((PLATFORM_ONLY_SURFACES as readonly string[]).includes(input.surface)) {
    const ctx: EligibilityContext = {
      partnerId: null, surface: input.surface, partnerPlan: null, hosted: isHosted(),
      residencyRequired: false, geoCarriable, userInitiated: false, userHoldsPermission: () => false,
    };
    const c = await loadPlatformDefaultCandidate();
    if (!c) return unavailable('no_eligible_model', null);
    const reason = checkEligibility(c.facts, ctx);
    if (reason) return unavailable(reason, null, c.displayName);
    return finalize(c, { ...input, partnerId: null }, role, undefined, ctx, false, transport);
  }
  if (!input.partnerId) throw new Error(`${input.surface} requires a partner to resolve a model`);
  const partnerId = input.partnerId;

  const assignment = await getEffectiveAssignment({ partnerId, orgId: input.orgId, surface: input.surface, role });

  const userInitiated = typeof input.userId === 'string' && input.userId.length > 0;
  const [partnerFacts, userHoldsPermission] = await Promise.all([
    loadPartnerFacts(partnerId),
    userInitiated
      ? loadUserPermissionPredicate(input.userId!, partnerId, input.orgId)
      : Promise.resolve((_key: string) => false),
  ]);
  const ctx: EligibilityContext = {
    partnerId,
    surface: input.surface,
    partnerPlan: partnerFacts.plan,
    hosted: isHosted(),
    residencyRequired: partnerFacts.residencyRequired,
    geoCarriable,
    userInitiated,
    userHoldsPermission,
  };

  const origin: RequestOrigin = input.requested?.origin ?? 'user';
  const requestedId = input.requested?.offeringId;
  const defaultId = assignment.defaultOfferingId;
  const permitted = (id: string) => isPermitted(assignment.permitted, id);

  const tryDefault = async (
    stored: LoadedCandidate | null,
    storedReason: ResolveFailureReason,
  ): Promise<ResolveModelResult> => {
    const storedName = stored?.displayName;
    // A missing stored offering cannot prove its connection: never guess.
    if (!stored || !defaultId || defaultId === requestedId) return unavailable(storedReason, requestedId ?? null, storedName);
    const fallback = await loadOfferingCandidate(defaultId, partnerId);
    const sameRoute = fallback !== null
      && fallback.connectionId === stored.connectionId
      && fallback.funding === stored.funding;
    if (!fallback || !sameRoute || checkEligibility(fallback.facts, ctx) !== null) {
      return unavailable(storedReason, requestedId ?? null, storedName);
    }
    return finalize(fallback, input, role, assignment.options, ctx, true, transport);
  };

  if (requestedId && requestedId !== defaultId) {
    const choiceAllowed = origin === 'policy' || assignment.allowUserChoice;
    if (!choiceAllowed || !permitted(requestedId)) {
      if (origin === 'user') return unavailable('not_permitted', requestedId);
      return tryDefault(await loadOfferingCandidate(requestedId, partnerId), 'not_permitted');
    }
  }

  const primaryId = requestedId ?? defaultId;
  if (!primaryId) return unavailable('no_eligible_model', null);
  const primary = await loadOfferingCandidate(primaryId, partnerId);
  const reason: ResolveFailureReason | null = primary ? checkEligibility(primary.facts, ctx) : 'not_permitted';
  if (primary && reason === null) return finalize(primary, input, role, assignment.options, ctx, false, transport);
  if (!requestedId || origin === 'user' || requestedId === defaultId) {
    return unavailable(reason!, primaryId, primary?.displayName);
  }
  return tryDefault(primary, reason!);
}
```

> The `'not_permitted'` message for the foreign-id case intentionally omits the display name: the loader returned `null`, so no name exists to leak.

- [ ] **Step 4: Run the resolver tests**

Run: `cd apps/api && npx vitest run src/services/aiModels/transport.test.ts src/services/aiModels/resolveModel.test.ts`
Expected: PASS (all cases). If "a foreign offering id…" fails on the `message` field, check that `unavailable('not_permitted', primaryId, undefined)` is reached through the `primary === null` branch.

- [ ] **Step 5: Append the resolver integration cases and run them**

```ts
// appended to apps/api/src/__tests__/integration/resolveModel.integration.test.ts
import { resolveModel } from '../../services/aiModels/resolveModel';

describe('resolveModel against real assignments, plans and settings', () => {
  it('a user cannot request another partner\'s offering', async () => {
    const a = await seedRegistryPartner('platform');
    const b = await seedRegistryPartner('byok');
    expect(await resolveModel({
      partnerId: a.partnerId, orgId: a.orgId, userId: a.userId, surface: 'chat',
      requested: { offeringId: b.offeringId, origin: 'user' },
    })).toMatchObject({ ok: false, reason: 'not_permitted' });
  });

  it('hosted plan below the platform row\'s min_plan → plan_required (real partners.plan)', async () => {
    const a = await seedRegistryPartner('platform');
    await sys(() => db.execute(sql`UPDATE ai_platform_models SET min_plan = 'enterprise' WHERE id = ${a.platformModelId}::uuid`));
    await sys(() => db.execute(sql`UPDATE partners SET plan = 'community' WHERE id = ${a.partnerId}::uuid`));
    const saved = process.env.IS_HOSTED;
    process.env.IS_HOSTED = 'true';
    try {
      expect(await resolveModel({ partnerId: a.partnerId, orgId: a.orgId, surface: 'chat' }))
        .toMatchObject({ ok: false, reason: 'plan_required' });
    } finally {
      if (saved === undefined) delete process.env.IS_HOSTED; else process.env.IS_HOSTED = saved;
    }
  });

  it('residency required with no geography → residency_unavailable (fails closed, real partners.settings)', async () => {
    const a = await seedRegistryPartner('platform');
    await sys(() => db.execute(sql`
      UPDATE partners SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{ai}', '{"residencyRequired": true}'::jsonb)
      WHERE id = ${a.partnerId}::uuid`));
    expect(await resolveModel({ partnerId: a.partnerId, orgId: a.orgId, surface: 'chat' }))
      .toMatchObject({ ok: false, reason: 'residency_unavailable' });
  });
});
```

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/resolveModel.integration.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Re-export, typecheck and commit**

```ts
// apps/api/src/services/aiModels/index.ts — add
export {
  resolveModel,
  unavailableMessage,
  PLATFORM_ONLY_SURFACES,
  type ResolveModelInput,
  type ResolveModelResult,
  type ResolvedModel,
  type ModelUnavailable,
  type ResolvedRefusalFallback,
  type RequestOrigin,
} from './resolveModel';
export type { ResolveFailureReason } from './eligibility';
```

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

```bash
git add apps/api/src/services/aiModels/transport.ts apps/api/src/services/aiModels/transport.test.ts \
  apps/api/src/services/aiModels/resolveModel.ts apps/api/src/services/aiModels/resolveModel.test.ts \
  apps/api/src/services/aiModels/index.ts apps/api/src/__tests__/integration/resolveModel.integration.test.ts
git commit -m "feat(ai): resolveModel with bounded fallback, option resolution and refusal fallback (#7601)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: Connection factory (sole `new Anthropic(`) and turn binding

The factory turns a `ResolvedModel` into what goes over the wire. It is the only file that constructs an Anthropic client, and the only file that shapes model params for the Agent SDK or the Messages API:
- **Credential pinning.** These invariants move unchanged from `llmConfigResolver.ts`:
  - platform: SDK defaults;
  - BYOK: pinned to `https://api.anthropic.com` with `authToken: null`;
  - catalog: guarded fetch, exactly one credential header, and an egress audit.
- **Refusal fallback on Claude API connections (platform, BYOK).** It is sent server-side as `fallbacks: [{ model }]` with beta `server-side-fallback-2026-07-01`, using the array form only (spec §14).
- **Refusal fallback on catalog connections.** It is client-side: exactly one retry on the same client.
- **Agent SDK surfaces.** They get `fallbackModel`.

The turn binding is the serialisable record of what a turn was dispatched with. It is written onto the budget reservation (Task 6) and compared for live-query reuse (Task 7).

This task also repoints the three non-surface client constructions to the factory: the key-verification probe, the fidelity harness and W01's discovery. The legacy `getAnthropicClientForPartner` / `buildAnthropicClient` stay until Task 17 deletes them, after their last surface caller is gone.

**Files:**
- Create: `apps/api/src/services/aiModels/connectionFactory.ts`, `apps/api/src/services/aiModels/connectionFactory.test.ts`
- Create: `apps/api/src/services/aiModels/turnBinding.ts`, `apps/api/src/services/aiModels/turnBinding.test.ts`
- Modify: `apps/api/src/services/partnerLlmConfig.ts` `probeAnthropicKey` (~L112), or wherever W02 moved the key probe
- Modify: `apps/api/src/services/llm/providerFidelityHarness.ts` local `buildAnthropicClient` (~L260)
- Modify: W01's `apps/api/src/services/aiModels/discovery.ts`, if it constructs a client

**Interfaces:**
- Consumes: Task 3 `ResolvedModel`, `ResolvedRefusalFallback`; P4 `toAgentSdkOptions`, `toMessagesApiParams`, `WireParams`, `legacyThinksWhenOmitted` (`services/aiModel.ts`); `buildGuardedLlmFetch`, `GuardedLlmFetchAttempt` (`llm/guardedLlmFetch.ts`); `recordLlmEgressEvent` (`llm/llmEgressRecorder.ts`); `LlmUnavailableError`, `LlmClientCallerContext`, `UsableLlmConfig` (`llm/llmConfigResolver.ts`).
- Produces:
  ```ts
  // connectionFactory.ts
  export const ANTHROPIC_PUBLIC_BASE_URL = 'https://api.anthropic.com';
  export const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
  export type AnthropicClientTarget =
    | { kind: 'platform' }
    | { kind: 'anthropic' }
    | { kind: 'endpoint'; baseUrl: string; authMode: 'x-api-key' | 'bearer'; recordEgress: (a: GuardedLlmFetchAttempt) => void };
  export function createAnthropicClient(spec: { apiKey: string; target: AnthropicClientTarget; timeout?: number; maxRetries?: number }): Anthropic;
  export function clientForConnection(config: UsableLlmConfig, caller: LlmClientCallerContext | null): Anthropic;
  export function anthropicClientFor(resolved: ResolvedModel, caller: LlmClientCallerContext | null): Anthropic;
  export function sdkModelOptions(resolved: ResolvedModel): Partial<Options>;
  export function messagesModelParams(resolved: Pick<ResolvedModel, 'wireModel' | 'wireParams'>): Record<string, unknown>;
  export type MessagesBody = Omit<Anthropic.MessageCreateParamsNonStreaming, 'model' | 'thinking' | 'output_config'>;
  export interface MessageAttempt { wireModel: string; message: Anthropic.Message }
  export interface MessageOutcome { message: Anthropic.Message; attempts: MessageAttempt[] }
  export function createMessage(client: Anthropic, resolved: ResolvedModel, body: MessagesBody): Promise<MessageOutcome>;
  export interface DispatchFacts {
    destinationKind: 'platform' | 'anthropic_byok' | 'catalog';
    baseUrl: string | null; connectionId: string | null;
    funding: AiBillingSource; wireModel: string;
  }
  export function describeDispatch(resolved: ResolvedModel): DispatchFacts;

  // turnBinding.ts
  export interface TurnBinding {
    v: 1;
    surface: AiSurface; role: string;
    partnerId: string | null; offeringId: string | null;
    connectionId: string | null; connectionKind: 'platform' | 'anthropic_byok' | 'catalog';
    configVersion: number | null; catalogRevisionId: string | null;
    funding: AiBillingSource;
    logicalModel: string; wireModel: string;
    options: OfferingOptions; thinkingMode: ThinkingMode; inferenceGeo: string | null;
    wireFingerprint: string;
    rateSnapshot: RateSnapshot;
    refusalFallback: { offeringId: string; wireModel: string; rateSnapshot: RateSnapshot } | null;
  }
  export function turnBindingFrom(resolved: ResolvedModel): TurnBinding;
  export function liveQueryKey(binding: TurnBinding): string;
  export function parseTurnBinding(raw: unknown): TurnBinding | null;
  export function rateForServedModel(binding: TurnBinding, servedWireModel: string): RateSnapshot;
  export function stableJson(value: unknown): string;
  ```

- [ ] **Step 1: Write the failing turn-binding tests**

```ts
// apps/api/src/services/aiModels/turnBinding.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedModel } from './resolveModel';
import { liveQueryKey, parseTurnBinding, rateForServedModel, turnBindingFrom } from './turnBinding';

const STD = { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 };
const FB = { inputCentsPerM: 100, outputCentsPerM: 500, cacheReadCentsPerM: 10, cacheWriteCentsPerM: 125 };

function resolved(over: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    ok: true, surface: 'chat', role: 'default', partnerId: 'p1', orgId: 'o1',
    offering: { id: 'off-1', displayName: 'Sonnet' },
    connection: { id: 'conn-1', kind: 'anthropic_byok', config: {
      source: 'partner', partnerId: 'p1', apiKey: 'k', model: 'claude-sonnet-5-5',
      configId: 'conn-1', configVersion: 3, endpoint: { kind: 'anthropic' } } },
    funding: 'partner_key', logicalModel: 'claude-sonnet-5-5', wireModel: 'claude-sonnet-5-5',
    thinking: 'adaptive',
    wireParams: { thinking: { type: 'adaptive' }, effort: 'medium', betas: [], applied: { effort: 'medium' } },
    options: { effort: 'medium' }, inferenceGeo: null,
    promptProfile: 'claude-standard',
    rateSnapshot: { source: 'linked_platform', standard: STD },
    capabilities: { thinkingMode: 'adaptive', effortLevels: ['medium'], supportsTools: true, supportsVision: false },
    limits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
    configVersion: 3, fellBack: false,
    ...over,
  } as ResolvedModel;
}

describe('liveQueryKey (spec §9.2: reuse only if nothing that shaped the subprocess moved)', () => {
  const base = liveQueryKey(turnBindingFrom(resolved()));
  it.each<[string, Partial<ResolvedModel>]>([
    ['connection id', { connection: { ...resolved().connection, id: 'conn-2' } }],
    ['config_version (key rotation)', { configVersion: 4 }],
    ['catalog revision', { catalogRevisionId: 'rev-9' }],
    ['wire model', { wireModel: 'claude-opus-5-5' }],
    ['effort (fixed at query creation)', {
      wireParams: { thinking: { type: 'adaptive' }, effort: 'high', betas: [], applied: { effort: 'high' } } }],
    ['refusal fallback model', { refusalFallback: {
      offeringId: 'fb', displayName: 'FB', wireModel: 'claude-haiku-4-5',
      wireParams: { betas: [], applied: {} }, options: {}, rateSnapshot: { source: 'linked_platform', standard: FB } } }],
  ])('changes when the %s changes', (_n, over) => {
    expect(liveQueryKey(turnBindingFrom(resolved(over)))).not.toBe(base);
  });

  it('does NOT change when only the price changes (settlement reads the new binding)', () => {
    expect(liveQueryKey(turnBindingFrom(resolved({ rateSnapshot: { source: 'offering', standard: FB } })))).toBe(base);
  });
});

describe('parseTurnBinding', () => {
  it('round-trips through jsonb', () => {
    const b = turnBindingFrom(resolved());
    expect(parseTurnBinding(JSON.parse(JSON.stringify(b)))).toEqual(b);
  });
  it('rejects anything else', () => {
    expect(parseTurnBinding(null)).toBeNull();
    expect(parseTurnBinding({ v: 2 })).toBeNull();
  });
});

describe('rateForServedModel', () => {
  const b = turnBindingFrom(resolved({ refusalFallback: {
    offeringId: 'fb', displayName: 'FB', wireModel: 'claude-haiku-4-5',
    wireParams: { betas: [], applied: {} }, options: {}, rateSnapshot: { source: 'linked_platform', standard: FB } } }));
  it('primary → primary rate; fallback → fallback rate', () => {
    expect(rateForServedModel(b, 'claude-sonnet-5-5').standard).toEqual(STD);
    expect(rateForServedModel(b, 'claude-haiku-4-5').standard).toEqual(FB);
  });
  it('an unexpected served model is priced at the primary rate and logged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(rateForServedModel(b, 'something-else').standard).toEqual(STD);
    expect(warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Write the failing factory tests**

```ts
// apps/api/src/services/aiModels/connectionFactory.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  ctor: vi.fn(),
  create: vi.fn(),
  betaCreate: vi.fn(),
  guarded: vi.fn(() => 'guarded-fetch'),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: m.create };
    beta = { messages: { create: m.betaCreate } };
    constructor(opts: unknown) { m.ctor(opts); }
  },
}));
vi.mock('../llm/guardedLlmFetch', () => ({ buildGuardedLlmFetch: m.guarded }));
vi.mock('../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: vi.fn() }));
vi.mock('./wireParams', () => ({
  toAgentSdkOptions: (w: { thinking?: unknown; effort?: string }) => ({
    ...(w.thinking ? { thinking: w.thinking } : {}), ...(w.effort ? { effort: w.effort } : {}),
  }),
  toMessagesApiParams: (w: { thinking?: unknown; effort?: string }, opts: { thinksWhenOmitted: boolean }) => (
    opts.thinksWhenOmitted
      ? { ...(w.thinking ? { thinking: w.thinking } : {}), ...(w.effort ? { output_config: { effort: w.effort } } : {}) }
      : {}),
}));
vi.mock('../aiModel', () => ({ legacyThinksWhenOmitted: () => true }));

import { LlmUnavailableError } from '../llm/llmConfigResolver';
import {
  ANTHROPIC_PUBLIC_BASE_URL,
  SERVER_SIDE_FALLBACK_BETA,
  clientForConnection,
  createMessage,
  describeDispatch,
  sdkModelOptions,
} from './connectionFactory';
import type { ResolvedModel } from './resolveModel';

const STD = { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 };
const catalogEndpoint = {
  kind: 'catalog' as const, catalogEntryId: 'cat-1', revisionId: 'rev-1', baseUrl: 'https://gw.example.com',
  authMode: 'bearer' as const, providerModel: 'anthropic/claude-sonnet-5.5',
  pricing: { catalogEntryId: 'cat-1', revisionId: 'rev-1', ...STD }, models: {},
};

function r(kind: 'platform' | 'anthropic_byok' | 'catalog', over: Partial<ResolvedModel> = {}): ResolvedModel {
  const config = kind === 'platform'
    ? { source: 'platform' as const, apiKey: 'sk-platform', model: 'claude-sonnet-5-5' }
    : { source: 'partner' as const, partnerId: 'p1', apiKey: 'sk-partner', model: 'claude-sonnet-5-5',
        configId: 'conn-1', configVersion: 2,
        endpoint: kind === 'catalog' ? catalogEndpoint : { kind: 'anthropic' as const } };
  return {
    ok: true, surface: 'chat', role: 'default', partnerId: 'p1', orgId: 'o1',
    offering: { id: 'off-1', displayName: 'Sonnet' },
    connection: { id: kind === 'platform' ? null : 'conn-1', kind, config },
    funding: kind === 'platform' ? 'platform' : 'partner_key',
    logicalModel: 'claude-sonnet-5-5',
    wireModel: kind === 'catalog' ? 'anthropic/claude-sonnet-5.5' : 'claude-sonnet-5-5',
    thinking: 'adaptive',
    wireParams: { thinking: { type: 'adaptive' }, effort: 'medium', betas: [], applied: { effort: 'medium' } },
    options: { effort: 'medium' }, inferenceGeo: null, promptProfile: 'claude-standard',
    rateSnapshot: { source: 'platform', standard: STD },
    capabilities: { thinkingMode: 'adaptive', effortLevels: ['medium'], supportsTools: true, supportsVision: false },
    limits: { maxInputTokens: null, maxOutputTokens: null }, fellBack: false,
    ...over,
  } as ResolvedModel;
}

const FALLBACK = {
  offeringId: 'fb', displayName: 'Haiku', wireModel: 'claude-haiku-4-5',
  wireParams: { betas: [], applied: {} }, options: {}, rateSnapshot: { source: 'platform' as const, standard: STD },
};

beforeEach(() => vi.clearAllMocks());

describe('clientForConnection — credential pinning moved verbatim from llmConfigResolver', () => {
  it('platform: SDK defaults, apiKey only', () => {
    clientForConnection(r('platform').connection.config, null);
    expect(m.ctor).toHaveBeenCalledWith({ apiKey: 'sk-platform' });
  });
  it('BYOK: pinned to the public API with ambient bearer cleared', () => {
    clientForConnection(r('anthropic_byok').connection.config, null);
    expect(m.ctor).toHaveBeenCalledWith({ apiKey: 'sk-partner', authToken: null, baseURL: ANTHROPIC_PUBLIC_BASE_URL });
  });
  it('catalog: exactly one credential header + guarded fetch pinned to the revision origin', () => {
    clientForConnection(r('catalog').connection.config, { surface: 'one_shot_ticket_draft', orgId: 'o1' });
    expect(m.ctor).toHaveBeenCalledWith({
      baseURL: 'https://gw.example.com', authToken: 'sk-partner', apiKey: null, fetch: 'guarded-fetch',
    });
    expect(m.guarded).toHaveBeenCalledWith(expect.objectContaining({ allowedOrigin: 'https://gw.example.com' }));
  });
  it('a blank platform key is LlmUnavailableError, never a keyless client', () => {
    expect(() => clientForConnection({ source: 'platform', apiKey: ' ', model: 'x' }, null)).toThrow(LlmUnavailableError);
  });
});

describe('sdkModelOptions', () => {
  it('wire model + W01 thinking/effort + fallbackModel for a refusal fallback', () => {
    expect(sdkModelOptions(r('platform', { refusalFallback: FALLBACK }))).toEqual({
      model: 'claude-sonnet-5-5', fallbackModel: 'claude-haiku-4-5',
      thinking: { type: 'adaptive' }, effort: 'medium',
    });
  });
});

describe('createMessage', () => {
  const reply = (stop: string) => ({ model: 'm', stop_reason: stop, content: [], usage: { input_tokens: 1, output_tokens: 1 } });

  it('plain call: messages.create with the wire model and W01 params', async () => {
    m.create.mockResolvedValue(reply('end_turn'));
    const out = await createMessage({ messages: { create: m.create } } as never, r('platform'),
      { max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    expect(m.create).toHaveBeenCalledWith({
      max_tokens: 100, messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-sonnet-5-5', thinking: { type: 'adaptive' }, output_config: { effort: 'medium' },
    });
    expect(out.attempts).toHaveLength(1);
  });

  it('clamps max_tokens to the model\'s max_output_tokens (§7)', async () => {
    m.create.mockResolvedValue(reply('end_turn'));
    await createMessage({ messages: { create: m.create } } as never,
      r('platform', { limits: { maxInputTokens: null, maxOutputTokens: 64 } }),
      { max_tokens: 4096, messages: [{ role: 'user', content: 'hi' }] });
    expect(m.create.mock.calls[0]![0]).toMatchObject({ max_tokens: 64 });
  });

  it('Claude API refusal fallback: server-side `fallbacks` array form + beta, one call', async () => {
    m.betaCreate.mockResolvedValue(reply('end_turn'));
    const client = { messages: { create: m.create }, beta: { messages: { create: m.betaCreate } } };
    await createMessage(client as never, r('anthropic_byok', { refusalFallback: FALLBACK }),
      { max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    expect(m.create).not.toHaveBeenCalled();
    expect(m.betaCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-sonnet-5-5',
      fallbacks: [{ model: 'claude-haiku-4-5' }],
      betas: [SERVER_SIDE_FALLBACK_BETA],
    }));
  });

  it('catalog refusal fallback: client-side, exactly one retry on the same client', async () => {
    m.create.mockResolvedValueOnce(reply('refusal')).mockResolvedValueOnce(reply('end_turn'));
    const fb = { ...FALLBACK, wireModel: 'anthropic/claude-haiku-4.5' };
    const out = await createMessage({ messages: { create: m.create } } as never, r('catalog', { refusalFallback: fb }),
      { max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    expect(m.create).toHaveBeenCalledTimes(2);
    expect(m.create.mock.calls[1]![0]).toMatchObject({ model: 'anthropic/claude-haiku-4.5' });
    expect(out.attempts.map((a) => a.wireModel)).toEqual(['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-4.5']);
  });
});

describe('describeDispatch', () => {
  it.each([
    ['platform', { destinationKind: 'platform', baseUrl: null, connectionId: null, funding: 'platform', wireModel: 'claude-sonnet-5-5' }],
    ['anthropic_byok', { destinationKind: 'anthropic_byok', baseUrl: ANTHROPIC_PUBLIC_BASE_URL, connectionId: 'conn-1', funding: 'partner_key', wireModel: 'claude-sonnet-5-5' }],
    ['catalog', { destinationKind: 'catalog', baseUrl: 'https://gw.example.com', connectionId: 'conn-1', funding: 'partner_key', wireModel: 'anthropic/claude-sonnet-5.5' }],
  ] as const)('%s', (kind, expected) => {
    expect(describeDispatch(r(kind))).toEqual(expected);
  });
});
```

- [ ] **Step 3: Run both and watch them fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/turnBinding.test.ts src/services/aiModels/connectionFactory.test.ts`
Expected: FAIL with `Failed to resolve import "./turnBinding"` and `"./connectionFactory"`.

- [ ] **Step 4: Implement `turnBinding.ts`**

```ts
// apps/api/src/services/aiModels/turnBinding.ts
/**
 * What a turn was dispatched with (spec §9.2). Persisted on the budget
 * reservation in the SAME transaction as the turn claim (Task 6), compared for
 * live-query reuse (Task 7), and the only source of the rate a settlement may
 * bill (Task 6 rejects a settlement whose rate is not one bound here).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AI_SURFACES, offeringOptionsSchema, type AiSurface, type OfferingOptions } from '@breeze/shared';
import type { AiBillingSource } from '../aiCostTracker';
import type { ThinkingMode } from './capabilities';
import type { RateSnapshot } from './pricing';
import type { ResolvedModel } from './resolveModel';
import type { WireParams } from './wireParams';

export interface TurnBinding {
  v: 1;
  surface: AiSurface;
  role: string;
  partnerId: string | null;
  offeringId: string | null;
  connectionId: string | null;
  connectionKind: 'platform' | 'anthropic_byok' | 'catalog';
  configVersion: number | null;
  catalogRevisionId: string | null;
  funding: AiBillingSource;
  logicalModel: string;
  wireModel: string;
  options: OfferingOptions;
  thinkingMode: ThinkingMode;
  inferenceGeo: string | null;
  wireFingerprint: string;
  rateSnapshot: RateSnapshot;
  refusalFallback: { offeringId: string; wireModel: string; rateSnapshot: RateSnapshot } | null;
}

/** Key-order-independent JSON, for fingerprints and rate comparisons. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Everything the SDK subprocess / request body is built from, minus the price. */
function wireFingerprint(w: WireParams, fallbackWireModel: string | null): string {
  const { applied: _applied, ...wire } = w;
  return createHash('sha256').update(stableJson({ wire, fallbackWireModel })).digest('hex').slice(0, 24);
}

export function turnBindingFrom(r: ResolvedModel): TurnBinding {
  return {
    v: 1,
    surface: r.surface,
    role: r.role,
    partnerId: r.partnerId,
    offeringId: r.offering.id,
    connectionId: r.connection.id,
    connectionKind: r.connection.kind,
    configVersion: r.configVersion ?? null,
    catalogRevisionId: r.catalogRevisionId ?? null,
    funding: r.funding,
    logicalModel: r.logicalModel,
    wireModel: r.wireModel,
    options: r.options,
    thinkingMode: r.thinking,
    inferenceGeo: r.inferenceGeo,
    wireFingerprint: wireFingerprint(r.wireParams, r.refusalFallback?.wireModel ?? null),
    rateSnapshot: r.rateSnapshot,
    refusalFallback: r.refusalFallback
      ? { offeringId: r.refusalFallback.offeringId, wireModel: r.refusalFallback.wireModel, rateSnapshot: r.refusalFallback.rateSnapshot }
      : null,
  };
}

/**
 * Spec §9.2: reuse a live SDK query only if connection id, config_version,
 * catalog revision and wire model are unchanged. The wire fingerprint is
 * stricter by design: effort/thinking/speed/geo/fallbackModel are fixed when
 * the SDK query is created, so a changed one must also recreate it.
 */
export function liveQueryKey(b: TurnBinding): string {
  return [
    b.connectionId ?? 'platform',
    b.configVersion ?? '-',
    b.catalogRevisionId ?? '-',
    b.wireModel,
    b.wireFingerprint,
  ].join('|');
}

const ratesSchema = z.object({
  inputCentsPerM: z.number().nonnegative(),
  outputCentsPerM: z.number().nonnegative(),
  cacheReadCentsPerM: z.number().nonnegative(),
  cacheWriteCentsPerM: z.number().nonnegative(),
});
const rateSnapshotSchema = z.object({
  source: z.enum(['platform', 'offering', 'catalog', 'linked_platform']),
  standard: ratesSchema,
  option: z.object({ key: z.literal('speed:fast'), rates: ratesSchema }).optional(),
});
const turnBindingSchema = z.object({
  v: z.literal(1),
  surface: z.enum(AI_SURFACES),
  role: z.string().min(1),
  partnerId: z.string().nullable(),
  offeringId: z.string().nullable(),
  connectionId: z.string().nullable(),
  connectionKind: z.enum(['platform', 'anthropic_byok', 'catalog']),
  configVersion: z.number().int().nullable(),
  catalogRevisionId: z.string().nullable(),
  funding: z.enum(['platform', 'partner_key']),
  logicalModel: z.string().min(1),
  wireModel: z.string().min(1),
  options: offeringOptionsSchema,
  thinkingMode: z.enum(['adaptive', 'budget', 'none', 'unknown']),
  inferenceGeo: z.string().nullable(),
  wireFingerprint: z.string().min(1),
  rateSnapshot: rateSnapshotSchema,
  refusalFallback: z.object({
    offeringId: z.string(), wireModel: z.string(), rateSnapshot: rateSnapshotSchema,
  }).nullable(),
});

export function parseTurnBinding(raw: unknown): TurnBinding | null {
  const parsed = turnBindingSchema.safeParse(raw);
  return parsed.success ? (parsed.data as TurnBinding) : null;
}

export function rateForServedModel(b: TurnBinding, servedWireModel: string): RateSnapshot {
  if (servedWireModel === b.wireModel) return b.rateSnapshot;
  if (b.refusalFallback && servedWireModel === b.refusalFallback.wireModel) return b.refusalFallback.rateSnapshot;
  // The SDK reported a model we did not bind (an internal helper call). Price
  // it at the primary rate — same connection, same funding, never a guess —
  // and make the mismatch visible.
  console.warn('[turnBinding] served model not in the binding; priced at the primary rate', {
    bound: b.wireModel, served: servedWireModel,
  });
  return b.rateSnapshot;
}
```

- [ ] **Step 5: Implement `connectionFactory.ts`**

```ts
// apps/api/src/services/aiModels/connectionFactory.ts
/**
 * The ONLY place an Anthropic client is constructed (aiModelRegistry.contract
 * .test.ts enforces it from Task 17). Credential pinning is a security control
 * and moved here verbatim from llmConfigResolver.ts:
 *   platform → SDK defaults (env-driven, #1412 self-host base URL)
 *   BYOK     → https://api.anthropic.com, ambient bearer cleared
 *   catalog  → guarded fetch pinned to the revision origin, exactly one
 *              credential header (the other nulled), egress audited
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { AiBillingSource } from '../aiCostTracker';
import { buildGuardedLlmFetch, type GuardedLlmFetchAttempt } from '../llm/guardedLlmFetch';
import {
  LlmUnavailableError,
  type LlmClientCallerContext,
  type UsableLlmConfig,
} from '../llm/llmConfigResolver';
import { legacyThinksWhenOmitted } from '../aiModel';
import { recordLlmEgressEvent } from '../llm/llmEgressRecorder';
import type { ResolvedModel } from './resolveModel';
import { toAgentSdkOptions, toMessagesApiParams } from './wireParams';

export const ANTHROPIC_PUBLIC_BASE_URL = 'https://api.anthropic.com';
export const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export type AnthropicClientTarget =
  | { kind: 'platform' }
  | { kind: 'anthropic' }
  | {
      kind: 'endpoint';
      baseUrl: string;
      authMode: 'x-api-key' | 'bearer';
      recordEgress: (attempt: GuardedLlmFetchAttempt) => void;
    };

export function createAnthropicClient(spec: {
  apiKey: string;
  target: AnthropicClientTarget;
  timeout?: number;
  maxRetries?: number;
}): Anthropic {
  const tuning = {
    ...(spec.timeout !== undefined ? { timeout: spec.timeout } : {}),
    ...(spec.maxRetries !== undefined ? { maxRetries: spec.maxRetries } : {}),
  };
  switch (spec.target.kind) {
    case 'platform':
      return new Anthropic({ apiKey: spec.apiKey, ...tuning });
    case 'anthropic':
      return new Anthropic({ apiKey: spec.apiKey, authToken: null, baseURL: ANTHROPIC_PUBLIC_BASE_URL, ...tuning });
    case 'endpoint': {
      const { baseUrl, authMode, recordEgress } = spec.target;
      return new Anthropic({
        baseURL: baseUrl,
        ...(authMode === 'x-api-key'
          ? { apiKey: spec.apiKey, authToken: null }
          : { authToken: spec.apiKey, apiKey: null }),
        fetch: buildGuardedLlmFetch({ allowedOrigin: new URL(baseUrl).origin, recordEgress }) as unknown as typeof fetch,
        ...tuning,
      });
    }
  }
}

/** Moved from llmConfigResolver.buildCatalogEgressRecorder (unchanged semantics). */
function catalogEgressRecorder(input: {
  caller: LlmClientCallerContext | null;
  partnerId: string;
  catalogEntryId: string;
  revisionId: string;
}): (attempt: GuardedLlmFetchAttempt) => void {
  let warned = false;
  return (attempt) => {
    if (!input.caller?.orgId) {
      if (!warned) {
        warned = true;
        console.warn('[connectionFactory] catalog LLM egress could not be audited: no organization in context '
          + `for partner ${input.partnerId} (surface ${input.caller?.surface ?? 'unknown'}).`);
      }
      return;
    }
    recordLlmEgressEvent({
      orgId: input.caller.orgId,
      partnerId: input.partnerId,
      surface: input.caller.surface,
      host: attempt.host,
      resolvedIp: attempt.resolvedIp,
      blocked: attempt.blocked,
      catalogEntryId: input.catalogEntryId,
      revisionId: input.revisionId,
    });
  };
}

export function clientForConnection(config: UsableLlmConfig, caller: LlmClientCallerContext | null): Anthropic {
  if (!config.apiKey?.trim()) throw new LlmUnavailableError('AI is not configured on this deployment.');
  if (config.source === 'partner' && config.endpoint.kind === 'catalog') {
    const ep = config.endpoint;
    return createAnthropicClient({
      apiKey: config.apiKey,
      target: {
        kind: 'endpoint',
        baseUrl: ep.baseUrl,
        authMode: ep.authMode,
        recordEgress: catalogEgressRecorder({
          caller, partnerId: config.partnerId, catalogEntryId: ep.catalogEntryId, revisionId: ep.revisionId,
        }),
      },
    });
  }
  return createAnthropicClient({
    apiKey: config.apiKey,
    target: config.source === 'partner' ? { kind: 'anthropic' } : { kind: 'platform' },
  });
}

export function anthropicClientFor(resolved: ResolvedModel, caller: LlmClientCallerContext | null): Anthropic {
  return clientForConnection(resolved.connection.config, caller);
}

/** Agent SDK `query()` model options. `fallbackModel` carries the refusal fallback. */
export function sdkModelOptions(resolved: ResolvedModel): Partial<Options> {
  return {
    model: resolved.wireModel,
    ...(resolved.refusalFallback ? { fallbackModel: resolved.refusalFallback.wireModel } : {}),
    ...toAgentSdkOptions(resolved.wireParams),
  };
}

/**
 * Messages API model params. W01's adapter only ever REDUCES thinking on a
 * one-shot: params are sent only for a model that thinks when they are
 * omitted (W01 keys that on the wire id, legacyThinksWhenOmitted).
 */
export function messagesModelParams(resolved: Pick<ResolvedModel, 'wireModel' | 'wireParams'>): Record<string, unknown> {
  return {
    model: resolved.wireModel,
    ...toMessagesApiParams(resolved.wireParams, { thinksWhenOmitted: legacyThinksWhenOmitted(resolved.wireModel) }),
  };
}

export type MessagesBody = Omit<Anthropic.MessageCreateParamsNonStreaming, 'model' | 'thinking' | 'output_config'>;
export interface MessageAttempt { wireModel: string; message: Anthropic.Message }
export interface MessageOutcome { message: Anthropic.Message; attempts: MessageAttempt[] }

/**
 * One Messages API call for a resolved model. A refusal fallback is sent
 * server-side (array form only — `fallbacks: "default"` could serve a model we
 * cannot price, spec §14) on Claude API connections, and as exactly one
 * client-side retry on the SAME client for catalog connections.
 */
export async function createMessage(
  client: Anthropic,
  resolved: ResolvedModel,
  body: MessagesBody,
): Promise<MessageOutcome> {
  const wireBetas = resolved.wireParams.betas;
  // §7: a call's max_tokens never exceeds the model's max_output_tokens.
  const cap = resolved.limits.maxOutputTokens;
  body = cap !== null && body.max_tokens > cap ? { ...body, max_tokens: cap } : body;
  const params = { ...body, ...messagesModelParams(resolved) };
  const fb = resolved.refusalFallback;
  const serverSide = fb !== undefined && resolved.connection.kind !== 'catalog';

  if (serverSide || wireBetas.length > 0) {
    const fbParams = fb ? messagesModelParams({ wireModel: fb.wireModel, wireParams: fb.wireParams }) : null;
    const message = await client.beta.messages.create({
      ...params,
      betas: [...wireBetas, ...(serverSide ? [SERVER_SIDE_FALLBACK_BETA] : [])],
      ...(serverSide && fbParams ? { fallbacks: [fbParams] } : {}),
    } as never) as unknown as Anthropic.Message;
    return { message, attempts: [{ wireModel: resolved.wireModel, message }] };
  }

  const first = await client.messages.create(params as never) as Anthropic.Message;
  if (fb && first.stop_reason === 'refusal') {
    const second = await client.messages.create({
      ...body,
      ...messagesModelParams({ wireModel: fb.wireModel, wireParams: fb.wireParams }),
    } as never) as Anthropic.Message;
    return {
      message: second,
      attempts: [{ wireModel: resolved.wireModel, message: first }, { wireModel: fb.wireModel, message: second }],
    };
  }
  return { message: first, attempts: [{ wireModel: resolved.wireModel, message: first }] };
}

export interface DispatchFacts {
  destinationKind: 'platform' | 'anthropic_byok' | 'catalog';
  baseUrl: string | null;
  connectionId: string | null;
  funding: AiBillingSource;
  wireModel: string;
}

export function describeDispatch(resolved: ResolvedModel): DispatchFacts {
  const cfg = resolved.connection.config;
  const baseUrl = cfg.source !== 'partner'
    ? null
    : cfg.endpoint.kind === 'catalog' ? cfg.endpoint.baseUrl : ANTHROPIC_PUBLIC_BASE_URL;
  return {
    destinationKind: resolved.connection.kind,
    baseUrl,
    connectionId: resolved.connection.id,
    funding: resolved.funding,
    wireModel: resolved.wireModel,
  };
}
```

> `fallbacks: [fbParams]`: `BetaFallbackParam` accepts only `model`, `max_tokens`, `thinking`, `output_config` and `speed` (SDK 0.128 `resources/beta/messages/messages.d.ts:2383`). `messagesModelParams` returns only `model`, `thinking` and `output_config` (W01's `toMessagesApiParams`), so it fits as is.

- [ ] **Step 6: Repoint the three non-surface constructions**

In `probeAnthropicKey` (`partnerLlmConfig.ts`, or W02's connection probe), replace the `new Anthropic(...)` ternary with:

```ts
  // Probe through the factory: a partner key is pinned to the public API
  // (previously `{ apiKey }`, which honoured an ambient ANTHROPIC_BASE_URL and
  // could send a partner key to a self-host gateway).
  const client = createAnthropicClient({
    apiKey,
    target: endpoint.kind === 'catalog'
      ? { kind: 'endpoint', baseUrl: endpoint.baseUrl, authMode: endpoint.authMode, recordEgress: buildProbeEgressRecorder() }
      : { kind: 'anthropic' },
  });
```

In `providerFidelityHarness.ts`, replace the body of its local `buildAnthropicClient(input)` with:

```ts
  return createAnthropicClient({
    apiKey: input.apiKey,
    target: { kind: 'endpoint', baseUrl: input.baseUrl, authMode: input.authMode, recordEgress: () => {} },
    timeout: DIRECT_REQUEST_TIMEOUT_MS,
    maxRetries: 1,
  });
```

In W01's `discovery.ts`, give `discoverAnthropicModels` an explicit target and build its client through the factory. Its W01 caller (`syncPlatformModels`) keeps the platform default; Task 16 passes `{ kind: 'anthropic' }` for BYOK keys, so a partner key is never sent through an ambient `ANTHROPIC_BASE_URL`:

```ts
export async function discoverAnthropicModels(
  apiKey: string | undefined,
  target: AnthropicClientTarget = { kind: 'platform' },
): Promise<AnthropicModelInfo[]> {
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
  // … W01's existing no-key handling, unchanged, runs here before any client is built …
  const client = createAnthropicClient({ apiKey: key!, target });
  // … W01's existing models.list() paging over `client`, unchanged …
}
```

Update the existing tests that asserted the old constructor shapes. `partnerLlmConfig.test.ts` expects `{ apiKey }` for the direct probe; change it to `{ apiKey, authToken: null, baseURL: 'https://api.anthropic.com' }` and keep the catalog case. `providerFidelityHarness.test.ts` keeps passing unchanged, because the option object is identical.

- [ ] **Step 7: Run everything touched**

Run: `cd apps/api && npx vitest run src/services/aiModels/turnBinding.test.ts src/services/aiModels/connectionFactory.test.ts src/services/partnerLlmConfig.test.ts src/services/llm/providerFidelityHarness.test.ts src/services/aiModels/discovery.test.ts`
Expected: PASS.

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/aiModels/connectionFactory.ts apps/api/src/services/aiModels/connectionFactory.test.ts \
  apps/api/src/services/aiModels/turnBinding.ts apps/api/src/services/aiModels/turnBinding.test.ts \
  apps/api/src/services/partnerLlmConfig.ts apps/api/src/services/partnerLlmConfig.test.ts \
  apps/api/src/services/llm/providerFidelityHarness.ts apps/api/src/services/aiModels/discovery.ts
git commit -m "feat(ai): connection factory and turn binding for resolved models (#7601)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5: Usage and refusal extraction (pure, no billing numbers from the provider)

This task turns whatever a surface got back into **per-model token components plus an outcome**. The output never contains a cost. The SDK's `total_cost_usd` becomes `sdkReportedCostUsd`, a telemetry field that settlement copies into `ai_invocations.sdk_reported_cost_usd` and nowhere else.

The SDK and Messages API facts this relies on (verified against `@anthropic-ai/claude-agent-sdk` 0.3.282 `sdk.d.ts:5352-5400` and `@anthropic-ai/sdk` 0.128 `beta/messages/messages.d.ts:2210-2440, 2999`):
- **SDK, fallback served.** `{ type:'system', subtype:'model_refusal_fallback', scope?: 'session'|'local', fallback_model, api_refusal_category? }`. Only `scope !== 'local'` swaps the main-loop model.
- **SDK, no fallback.** `{ type:'system', subtype:'model_refusal_no_fallback', api_refusal_category? }`.
- **SDK result.** `stop_reason` and `usage` describe the main loop per turn. `total_cost_usd` and `modelUsage` are cumulative estimates, and a resumed session carries its transcript's earlier totals. That is why **neither** is used for billing.
- **Messages API refusal.** `stop_reason:'refusal'` with `stop_details.category`. A server-side fallback adds a `{ type:'fallback', from, to, trigger:{ category } }` content block and per-model `usage.iterations[].model`.

**Files:**
- Create: `apps/api/src/services/aiModels/invocationUsage.ts`, `apps/api/src/services/aiModels/invocationUsage.test.ts`

**Interfaces:**
- Consumes: Task 4 `TurnBinding`; P6 `TokenComponents`.
- Produces:
  ```ts
  export interface BilledUsage { model: string; tokens: TokenComponents; webSearchRequests: number }
  export interface TurnOutcome {
    stopReason: string;              // 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'error' | provider value
    refused: boolean;                // the FINAL answer is a refusal (after any fallback)
    refusalCategory: string | null;
    fallbackUsed: boolean;
    servedModel: string;
    sdkReportedCostUsd: number | null;   // telemetry only
  }
  export interface SdkTurnObservation {
    refusalFallback: { fallbackModel: string; category: string | null } | null;
    refusalNoFallback: { category: string | null } | null;
  }
  export function newSdkTurnObservation(): SdkTurnObservation;
  export function observeSdkMessage(obs: SdkTurnObservation, message: unknown): void;
  export interface SdkResultLike { subtype: string; is_error?: boolean; stop_reason?: string | null; total_cost_usd?: number | null }
  export function sdkTurnUsage(input: {
    binding: TurnBinding; tokens: TokenComponents; webSearchRequests?: number;
    observation: SdkTurnObservation; result: SdkResultLike | null;   // null = abandoned turn
  }): { usage: BilledUsage[]; outcome: TurnOutcome };
  export interface MessageLike { /* minimal Anthropic.Message / BetaMessage shape, see code */ }
  export function messagesUsage(binding: TurnBinding, attempts: ReadonlyArray<{ wireModel: string; message: MessageLike }>): { usage: BilledUsage[]; outcome: TurnOutcome };
  ```

- [ ] **Step 1: Write the failing table**

```ts
// apps/api/src/services/aiModels/invocationUsage.test.ts
import { describe, expect, it } from 'vitest';
import {
  messagesUsage,
  newSdkTurnObservation,
  observeSdkMessage,
  sdkTurnUsage,
  type MessageLike,
} from './invocationUsage';
import type { TurnBinding } from './turnBinding';

const STD = { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 };
const B: TurnBinding = {
  v: 1, surface: 'chat', role: 'default', partnerId: 'p1', offeringId: 'off-1', connectionId: null,
  connectionKind: 'platform', configVersion: null, catalogRevisionId: null, funding: 'platform',
  logicalModel: 'claude-sonnet-5-5', wireModel: 'claude-sonnet-5-5', options: {}, thinkingMode: 'adaptive',
  inferenceGeo: null, wireFingerprint: 'f', rateSnapshot: { source: 'platform', standard: STD },
  refusalFallback: { offeringId: 'fb', wireModel: 'claude-haiku-4-5', rateSnapshot: { source: 'platform', standard: STD } },
};
const T = { input: 100, output: 50, cacheRead: 1000, cacheWrite: 10 };

describe('sdkTurnUsage — the provider never supplies a billing number', () => {
  it('a positive-but-wrong SDK cost is carried as telemetry only', () => {
    const out = sdkTurnUsage({ binding: B, tokens: T, observation: newSdkTurnObservation(),
      result: { subtype: 'success', stop_reason: 'end_turn', total_cost_usd: 9.99 } });
    expect(out.usage).toEqual([{ model: 'claude-sonnet-5-5', tokens: T, webSearchRequests: 0 }]);
    expect(out.outcome).toEqual({
      stopReason: 'end_turn', refused: false, refusalCategory: null, fallbackUsed: false,
      servedModel: 'claude-sonnet-5-5', sdkReportedCostUsd: 9.99,
    });
    expect(JSON.stringify(out)).not.toMatch(/cost(Cents|_cents)/i);
  });

  it('a zero SDK cost on a brand-new model still yields full token components', () => {
    const out = sdkTurnUsage({ binding: { ...B, wireModel: 'claude-new-6' }, tokens: T, observation: newSdkTurnObservation(),
      result: { subtype: 'success', total_cost_usd: 0 } });
    expect(out.usage[0]).toEqual({ model: 'claude-new-6', tokens: T, webSearchRequests: 0 });
    expect(out.outcome.sdkReportedCostUsd).toBe(0);
  });

  it('a session-scope refusal fallback: served by the fallback, category kept', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'system', subtype: 'model_refusal_fallback', scope: 'session',
      fallback_model: 'claude-haiku-4-5', api_refusal_category: 'cyber' });
    const out = sdkTurnUsage({ binding: B, tokens: T, observation: obs, result: { subtype: 'success', stop_reason: 'end_turn' } });
    expect(out.usage[0]!.model).toBe('claude-haiku-4-5');
    expect(out.outcome).toMatchObject({ fallbackUsed: true, refused: false, refusalCategory: 'cyber', servedModel: 'claude-haiku-4-5' });
  });

  it('a local-scope (subagent) fallback does not change the main-loop model', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'system', subtype: 'model_refusal_fallback', scope: 'local', fallback_model: 'claude-haiku-4-5' });
    expect(sdkTurnUsage({ binding: B, tokens: T, observation: obs, result: { subtype: 'success' } }).outcome.fallbackUsed).toBe(false);
  });

  it('no fallback configured: refused with category', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'system', subtype: 'model_refusal_no_fallback', api_refusal_category: 'cyber' });
    expect(sdkTurnUsage({ binding: B, tokens: T, observation: obs, result: { subtype: 'success', stop_reason: 'refusal' } }).outcome)
      .toMatchObject({ refused: true, stopReason: 'refusal', refusalCategory: 'cyber', fallbackUsed: false });
  });

  it('an older CLI with only stop_reason refusal: refused, category null', () => {
    expect(sdkTurnUsage({ binding: B, tokens: T, observation: newSdkTurnObservation(),
      result: { subtype: 'success', stop_reason: 'refusal' } }).outcome)
      .toMatchObject({ refused: true, refusalCategory: null });
  });

  it('the fallback also declined: refused, served by the fallback', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'system', subtype: 'model_refusal_fallback', fallback_model: 'claude-haiku-4-5', api_refusal_category: 'cyber' });
    expect(sdkTurnUsage({ binding: B, tokens: T, observation: obs, result: { subtype: 'success', stop_reason: 'refusal' } }).outcome)
      .toMatchObject({ refused: true, fallbackUsed: true, servedModel: 'claude-haiku-4-5', refusalCategory: 'cyber' });
  });

  it('an abandoned turn is an error at the primary model', () => {
    expect(sdkTurnUsage({ binding: B, tokens: T, observation: newSdkTurnObservation(), result: null }).outcome)
      .toMatchObject({ stopReason: 'error', servedModel: 'claude-sonnet-5-5', sdkReportedCostUsd: null });
  });

  it('an overload fallback (no refusal message) is invisible to main-loop usage → priced at the primary model', () => {
    // SDK `fallbackModel` also fires on overload, and the per-turn `usage` does
    // not say which model served. Review finding 3: resolveModel only sets an
    // SDK refusal fallback whose rate EQUALS the primary's (Task 3), so pricing
    // an unattributed turn at the primary rate is exact, not an approximation.
    expect(sdkTurnUsage({ binding: B, tokens: T, observation: newSdkTurnObservation(),
      result: { subtype: 'success', stop_reason: 'end_turn' } }).usage[0]!.model).toBe('claude-sonnet-5-5');
  });
});

function msg(over: Partial<MessageLike> = {}): MessageLike {
  return {
    model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_details: null, content: [{ type: 'text' }],
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 },
    ...over,
  };
}

describe('messagesUsage', () => {
  it('a plain response: one usage at the requested wire model', () => {
    const out = messagesUsage(B, [{ wireModel: 'claude-sonnet-5-5', message: msg() }]);
    expect(out.usage).toEqual([{ model: 'claude-sonnet-5-5', tokens: T, webSearchRequests: 0 }]);
    expect(out.outcome).toMatchObject({ stopReason: 'end_turn', refused: false, fallbackUsed: false, sdkReportedCostUsd: null });
  });

  it('server-side fallback: per-model iterations, category from the fallback block', () => {
    const out = messagesUsage(B, [{ wireModel: 'claude-sonnet-5-5', message: msg({
      content: [
        { type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'claude-haiku-4-5' }, trigger: { category: 'cyber' } },
        { type: 'text' },
      ],
      usage: { input_tokens: 300, output_tokens: 80, iterations: [
        { model: 'claude-sonnet-5-5', input_tokens: 100, output_tokens: 5 },
        { model: 'claude-haiku-4-5', input_tokens: 200, output_tokens: 75 },
      ] },
    }) }]);
    expect(out.usage.map((u) => [u.model, u.tokens.input, u.tokens.output])).toEqual([
      ['claude-sonnet-5-5', 100, 5], ['claude-haiku-4-5', 200, 75],
    ]);
    expect(out.outcome).toMatchObject({ fallbackUsed: true, refused: false, refusalCategory: 'cyber', servedModel: 'claude-haiku-4-5' });
  });

  it('refusal with no fallback: category from stop_details', () => {
    expect(messagesUsage(B, [{ wireModel: 'claude-sonnet-5-5',
      message: msg({ stop_reason: 'refusal', stop_details: { category: 'cyber' } }) }]).outcome)
      .toMatchObject({ refused: true, stopReason: 'refusal', refusalCategory: 'cyber' });
  });

  it('client-side (catalog) fallback: one usage per attempt at the model each attempt requested', () => {
    const out = messagesUsage(B, [
      { wireModel: 'claude-sonnet-5-5', message: msg({ stop_reason: 'refusal', stop_details: { category: 'bio' } }) },
      { wireModel: 'claude-haiku-4-5', message: msg({ model: 'provider/haiku' }) },
    ]);
    expect(out.usage.map((u) => u.model)).toEqual(['claude-sonnet-5-5', 'claude-haiku-4-5']);
    expect(out.outcome).toMatchObject({ fallbackUsed: true, refused: false, refusalCategory: 'bio', servedModel: 'claude-haiku-4-5' });
  });

  it('web search requests ride on the first usage of the attempt that made them', () => {
    const out = messagesUsage(B, [{ wireModel: 'claude-sonnet-5-5',
      message: msg({ usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 3 } } }) }]);
    expect(out.usage[0]!.webSearchRequests).toBe(3);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/invocationUsage.test.ts`
Expected: FAIL with `Failed to resolve import "./invocationUsage"`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/aiModels/invocationUsage.ts
/**
 * Provider output → per-model token components + outcome. Deliberately has NO
 * cost in its output: the only billing number is priceInvocation() over these
 * components (settleInvocation.ts). `sdkReportedCostUsd` is telemetry and the
 * ONLY reader of `total_cost_usd` in the codebase (contract-tested, Task 17).
 */
import type { TokenComponents } from './pricing';
import type { TurnBinding } from './turnBinding';

export interface BilledUsage { model: string; tokens: TokenComponents; webSearchRequests: number }

export interface TurnOutcome {
  stopReason: string;
  refused: boolean;
  refusalCategory: string | null;
  fallbackUsed: boolean;
  servedModel: string;
  sdkReportedCostUsd: number | null;
}

export interface SdkTurnObservation {
  refusalFallback: { fallbackModel: string; category: string | null } | null;
  refusalNoFallback: { category: string | null } | null;
}

export function newSdkTurnObservation(): SdkTurnObservation {
  return { refusalFallback: null, refusalNoFallback: null };
}

/** Feed EVERY SDK message of the turn through this (system messages are the only ones it reads). */
export function observeSdkMessage(obs: SdkTurnObservation, message: unknown): void {
  if (!message || typeof message !== 'object') return;
  const m = message as {
    type?: string; subtype?: string; scope?: string; fallback_model?: unknown; api_refusal_category?: unknown;
  };
  if (m.type !== 'system') return;
  const category = typeof m.api_refusal_category === 'string' ? m.api_refusal_category : null;
  if (m.subtype === 'model_refusal_fallback') {
    // 'local' = a subagent / side question fell back; the main loop did not.
    if (m.scope === 'local' || typeof m.fallback_model !== 'string') return;
    obs.refusalFallback = { fallbackModel: m.fallback_model, category };
  } else if (m.subtype === 'model_refusal_no_fallback') {
    obs.refusalNoFallback = { category };
  }
}

export interface SdkResultLike {
  subtype: string;
  is_error?: boolean;
  stop_reason?: string | null;
  total_cost_usd?: number | null;
}

export function sdkTurnUsage(input: {
  binding: TurnBinding;
  tokens: TokenComponents;
  webSearchRequests?: number;
  observation: SdkTurnObservation;
  result: SdkResultLike | null;
}): { usage: BilledUsage[]; outcome: TurnOutcome } {
  const { observation: obs, result } = input;
  const servedModel = obs.refusalFallback?.fallbackModel ?? input.binding.wireModel;
  const sdkStop = result?.stop_reason ?? null;
  const refused = obs.refusalNoFallback !== null || sdkStop === 'refusal';
  const stopReason = refused
    ? 'refusal'
    : sdkStop ?? (result && result.subtype === 'success' && !result.is_error ? 'end_turn' : 'error');
  const category = obs.refusalNoFallback?.category ?? obs.refusalFallback?.category ?? null;
  return {
    usage: [{ model: servedModel, tokens: input.tokens, webSearchRequests: input.webSearchRequests ?? 0 }],
    outcome: {
      stopReason,
      refused,
      refusalCategory: refused || obs.refusalFallback !== null ? category : null,
      fallbackUsed: obs.refusalFallback !== null,
      servedModel,
      sdkReportedCostUsd: typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null,
    },
  };
}

interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export interface MessageLike {
  model: string;
  stop_reason: string | null;
  stop_details?: { category?: string | null } | null;
  content: ReadonlyArray<{
    type: string;
    to?: { model?: string } | null;
    trigger?: { category?: string | null } | null;
    [k: string]: unknown;
  }>;
  usage: UsageLike & {
    server_tool_use?: { web_search_requests?: number | null } | null;
    iterations?: ReadonlyArray<UsageLike & { model?: string | null }> | null;
  };
}

function tokensOf(u: UsageLike): TokenComponents {
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
}

function addTokens(a: TokenComponents, b: TokenComponents): TokenComponents {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

export function messagesUsage(
  binding: TurnBinding,
  attempts: ReadonlyArray<{ wireModel: string; message: MessageLike }>,
): { usage: BilledUsage[]; outcome: TurnOutcome } {
  if (attempts.length === 0) throw new Error('messagesUsage needs at least one attempt');
  const usage: BilledUsage[] = [];
  for (const attempt of attempts) {
    const webSearches = attempt.message.usage.server_tool_use?.web_search_requests ?? 0;
    const iterations = (attempt.message.usage.iterations ?? []).filter((i) => typeof i.input_tokens === 'number');
    if (iterations.length === 0) {
      usage.push({ model: attempt.wireModel, tokens: tokensOf(attempt.message.usage), webSearchRequests: webSearches });
      continue;
    }
    // Iterations are the inclusive per-model split of the top-level total;
    // pricing them (and NOT the top level) avoids double counting.
    const byModel = new Map<string, TokenComponents>();
    for (const it of iterations) {
      const model = it.model ?? attempt.wireModel;
      byModel.set(model, addTokens(byModel.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tokensOf(it)));
    }
    let first = true;
    for (const [model, tokens] of byModel) {
      usage.push({ model, tokens, webSearchRequests: first ? webSearches : 0 });
      first = false;
    }
  }

  const last = attempts[attempts.length - 1]!;
  const fallbackBlock = last.message.content.find((b) => b.type === 'fallback');
  const clientSide = attempts.length > 1;
  const fallbackUsed = clientSide || fallbackBlock !== undefined;
  const refused = last.message.stop_reason === 'refusal';
  const fallbackCategory = clientSide
    ? attempts[0]!.message.stop_details?.category ?? null
    : fallbackBlock?.trigger?.category ?? null;
  const servedModel = clientSide
    ? last.wireModel
    : fallbackBlock?.to?.model ?? binding.wireModel;
  return {
    usage,
    outcome: {
      stopReason: last.message.stop_reason ?? 'end_turn',
      refused,
      refusalCategory: refused ? last.message.stop_details?.category ?? fallbackCategory : fallbackUsed ? fallbackCategory : null,
      fallbackUsed,
      servedModel,
      sdkReportedCostUsd: null,
    },
  };
}
```

- [ ] **Step 4: Run it**

Run: `cd apps/api && npx vitest run src/services/aiModels/invocationUsage.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/invocationUsage.ts apps/api/src/services/aiModels/invocationUsage.test.ts
git commit -m "feat(ai): provider usage and refusal extraction without provider cost (#7601)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 6: The single billing path — `settleInvocation`, ledger-derived rollups, binding on the reservation

This task makes `ai_invocations` the source of truth (spec §5.5, §8; quorum #5, #6):
- `settleInvocation` prices each `BilledUsage` with `priceInvocation` at the rate **bound to the turn**, then builds one ledger row per billed model.
- **Reservation path.** It hands the rows to `settleAiBudgetReservation`. That function inserts them inside its **existing** transaction, then derives the `ai_sessions` totals and the `ai_cost_usage` increments from the inserted rows, so the rollups cannot disagree with the ledger.
- **No-reservation path.** `recordInvocationsWithRollups` does the same in its own system transaction.
- **Exactly-once money (Step 8a).** Credits are debited once per reservation, keyed and stamped, and only by the call that settled it. A settlement deferred by lock contention is persisted and replayed by the sweep. A stable-key retry re-binds its still-active reservation before dispatch.
- **Turn binding.** `reserveAiBudget` takes the turn binding and writes it in the same transaction as the reservation insert (`model_binding`) and the session's `offering_id` / `offering_partner_id` / `options` / `model` (spec §9.2 bullet 1). Settlement then **rejects** any ledger row whose rate is not one the reservation bound. The billed price is provably the one fixed at the turn claim.

**Files:**
- Create: `apps/api/src/services/aiModels/settleInvocation.ts`, `apps/api/src/services/aiModels/settleInvocation.test.ts`
- Create: `apps/api/migrations/2026-11-19-100000-ai-budget-reservation-model-binding.sql`
- Create: `apps/api/src/__tests__/integration/aiInvocationSettlement.integration.test.ts`
- Modify: `apps/api/src/services/aiBudgetReservations.ts` (`ReserveAiBudgetInput` ~L97, the insert ~L597, `SettleAiBudgetReservationInput` ~L139, `settleAiBudgetReservation` ~L632, plus a new `recordInvocationsWithRollups`)
- Modify: `apps/api/src/db/schema/ai.ts` (`aiBudgetReservations` ~L220: `modelBinding`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`ai_budget_reservations` → `excludedOpen` gains `model_binding`)
- Modify (only if P10 fails): `apps/api/src/services/aiModels/invocationLedger.ts` (an `executor` option)

**Interfaces:**
- Consumes: Task 4 `TurnBinding`, `parseTurnBinding`, `rateForServedModel`; Task 5 `BilledUsage`, `TurnOutcome`; P6 `priceInvocation`; P10 `recordInvocation`, `NewInvocation`; `deductBillingCredits` (`aiCostTracker.ts`).
- Produces:
  ```ts
  // settleInvocation.ts
  export const WEB_SEARCH_COST_CENTS = 1;   // moved from catalogEnrichmentService.ts:139
  export interface PricedUsage extends BilledUsage { rate: RateSnapshot; costCents: number }
  export function priceUsage(binding: TurnBinding, usage: BilledUsage[]): PricedUsage[];
  export function sumCostCents(priced: ReadonlyArray<{ costCents: number }>): number;
  export function costEstimator(resolved: Pick<ResolvedModel, 'rateSnapshot' | 'options'>): (inputTokens: number, outputTokens: number) => number;
  export interface SettleInvocationInput {
    binding: TurnBinding; orgId: string;
    userId: string | null; sessionId: string | null; agentRunId: string | null; sourceRef: string | null;
    usage: BilledUsage[]; outcome: TurnOutcome;
    reservationId?: string;
    messageCount?: number; toolExecutionCount?: number; turnCount?: number;
  }
  export interface SettledInvocation { costCents: number; invocationIds: string[]; deferred: boolean }
  export function settleInvocation(input: SettleInvocationInput): Promise<SettledInvocation>;
  export function toNewInvocations(input: SettleInvocationInput, priced: PricedUsage[]): NewInvocation[];

  // aiBudgetReservations.ts (additions)
  interface ReserveAiBudgetInput { /* existing */ binding?: TurnBinding }
  interface SettleAiBudgetReservationInput {
    /* existing fields; actualCostCents/inputTokens/outputTokens become optional when invocations is set */
    invocations?: NewInvocation[];
  }
  type SettleAiBudgetReservationResult = { kind: 'settled' | 'already_settled'; reservationId: string; actualCostCents: number; invocationIds: string[] };
  export function recordInvocationsWithRollups(input: {
    orgId: string; invocations: NewInvocation[]; sessionId?: string | null;
    messageCount?: number; toolExecutionCount?: number; turnCount?: number; now?: Date;
  }): Promise<string[]>;
  ```

- [ ] **Step 1: Write the failing unit tests**

```ts
// apps/api/src/services/aiModels/settleInvocation.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  settleDurably: vi.fn(),
  recordWithRollups: vi.fn(),
  deduct: vi.fn(),
}));
vi.mock('../aiBudgetReservations', () => ({
  settleAiBudgetReservationDurably: m.settleDurably,
  recordInvocationsWithRollups: m.recordWithRollups,
}));
vi.mock('../aiCostTracker', () => ({ deductBillingCredits: m.deduct }));

import { priceInvocation } from './pricing';
import { WEB_SEARCH_COST_CENTS, costEstimator, priceUsage, settleInvocation } from './settleInvocation';
import type { TurnBinding } from './turnBinding';

const STD = { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 };
const FB = { inputCentsPerM: 100, outputCentsPerM: 500, cacheReadCentsPerM: 10, cacheWriteCentsPerM: 125 };
const B: TurnBinding = {
  v: 1, surface: 'chat', role: 'default', partnerId: 'p1', offeringId: 'off-1', connectionId: null,
  connectionKind: 'platform', configVersion: null, catalogRevisionId: null, funding: 'platform',
  logicalModel: 'claude-sonnet-5-5', wireModel: 'claude-sonnet-5-5', options: { effort: 'medium' },
  thinkingMode: 'adaptive', inferenceGeo: null, wireFingerprint: 'f',
  rateSnapshot: { source: 'platform', standard: STD },
  refusalFallback: { offeringId: 'fb', wireModel: 'claude-haiku-4-5', rateSnapshot: { source: 'platform', standard: FB } },
};
const T = { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 };
const OK = { stopReason: 'end_turn', refused: false, refusalCategory: null, fallbackUsed: false, servedModel: 'claude-sonnet-5-5', sdkReportedCostUsd: 9.99 };

beforeEach(() => {
  vi.clearAllMocks();
  m.settleDurably.mockResolvedValue({ kind: 'settled', reservationId: 'r1', actualCostCents: 0, invocationIds: ['i1'] });
  m.recordWithRollups.mockResolvedValue(['i1']);
});

describe('priceUsage', () => {
  it('prices from the bound snapshot with priceInvocation, never from the SDK', () => {
    const [p] = priceUsage(B, [{ model: 'claude-sonnet-5-5', tokens: T, webSearchRequests: 0 }]);
    expect(p!.costCents).toBe(priceInvocation({ source: 'platform', standard: STD }, T, {}));
    expect(p!.costCents).toBe(300);   // 1M in × 200 + 0.1M out × 1000
  });
  it('a fallback-served row is priced at the fallback rate', () => {
    expect(priceUsage(B, [{ model: 'claude-haiku-4-5', tokens: T, webSearchRequests: 0 }])[0]!.costCents).toBe(150);
  });
  it('web search requests add the server-tool fee', () => {
    expect(priceUsage(B, [{ model: 'claude-sonnet-5-5', tokens: T, webSearchRequests: 2 }])[0]!.costCents)
      .toBe(300 + 2 * WEB_SEARCH_COST_CENTS);
  });
  it('empty usage still yields one zero row at the primary model (the attempt is recorded)', () => {
    expect(priceUsage(B, [])).toEqual([expect.objectContaining({ model: 'claude-sonnet-5-5', costCents: 0 })]);
  });
});

describe('costEstimator', () => {
  it('estimates output caps from the resolved rate', () => {
    expect(costEstimator({ rateSnapshot: { source: 'platform', standard: STD }, options: {} })(1_000_000, 0)).toBe(200);
  });
});

describe('settleInvocation', () => {
  it('SDK says $9.99 → ledger and settlement get the registry price; SDK cost is telemetry only', async () => {
    const out = await settleInvocation({
      binding: B, orgId: 'o1', userId: 'u1', sessionId: 's1', agentRunId: null, sourceRef: null,
      usage: [{ model: 'claude-sonnet-5-5', tokens: T, webSearchRequests: 0 }], outcome: OK,
      reservationId: 'r1', toolExecutionCount: 2, turnCount: 3,
    });
    expect(out.costCents).toBe(300);
    const call = m.settleDurably.mock.calls[0]![0];
    expect(call).toMatchObject({ orgId: 'o1', reservationId: 'r1', toolExecutionCount: 2, session: { id: 's1', turnCount: 3 } });
    expect(call.invocations).toEqual([expect.objectContaining({
      costCents: 300, sdkReportedCostUsd: 9.99, fundingSource: 'platform', offeringId: 'off-1',
      requestedModel: 'claude-sonnet-5-5', servedModel: 'claude-sonnet-5-5', userId: 'u1',
      inputTokens: 1_000_000, outputTokens: 100_000, chargeable: false, fallbackUsed: false,
      rateSnapshot: { source: 'platform', standard: STD }, ledgerMode: 'authoritative',
    })]);
    expect(call).not.toHaveProperty('actualCostCents');
    expect(m.deduct).toHaveBeenCalledWith('o1', 300, { idempotencyKey: 'ai-settlement:r1' });
  });

  it('partner_key funding never touches platform credits', async () => {
    await settleInvocation({
      binding: { ...B, funding: 'partner_key', connectionId: 'c1', connectionKind: 'anthropic_byok' },
      orgId: 'o1', userId: null, sessionId: null, agentRunId: 'run-1', sourceRef: null,
      usage: [{ model: 'claude-sonnet-5-5', tokens: T, webSearchRequests: 0 }], outcome: OK, reservationId: 'r1',
    });
    expect(m.deduct).not.toHaveBeenCalled();
    expect(m.settleDurably.mock.calls[0]![0]).not.toHaveProperty('session');
  });

  it('server-side fallback: two rows, refused leg at the primary rate, served leg at the fallback rate', async () => {
    await settleInvocation({
      binding: B, orgId: 'o1', userId: null, sessionId: null, agentRunId: null, sourceRef: 'x',
      usage: [
        { model: 'claude-sonnet-5-5', tokens: T, webSearchRequests: 0 },
        { model: 'claude-haiku-4-5', tokens: T, webSearchRequests: 0 },
      ],
      outcome: { ...OK, fallbackUsed: true, refusalCategory: 'cyber', servedModel: 'claude-haiku-4-5', sdkReportedCostUsd: null },
      reservationId: 'r1',
    });
    const rows = m.settleDurably.mock.calls[0]![0].invocations;
    expect(rows.map((r: { servedModel: string; stopReason: string; fallbackUsed: boolean; costCents: number; refusalCategory: string | null }) =>
      [r.servedModel, r.stopReason, r.fallbackUsed, r.costCents, r.refusalCategory])).toEqual([
      ['claude-sonnet-5-5', 'refusal', false, 300, 'cyber'],
      ['claude-haiku-4-5', 'end_turn', true, 150, 'cyber'],
    ]);
  });

  it('without a reservation, rows + rollups go through recordInvocationsWithRollups', async () => {
    await settleInvocation({
      binding: B, orgId: 'o1', userId: null, sessionId: 's1', agentRunId: null, sourceRef: null,
      usage: [{ model: 'claude-sonnet-5-5', tokens: T, webSearchRequests: 0 }], outcome: OK,
    });
    expect(m.settleDurably).not.toHaveBeenCalled();
    expect(m.recordWithRollups).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'o1', sessionId: 's1' }));
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/settleInvocation.test.ts`
Expected: FAIL with `Failed to resolve import "./settleInvocation"`.

- [ ] **Step 3: Implement `settleInvocation.ts`**

```ts
// apps/api/src/services/aiModels/settleInvocation.ts
/**
 * THE billing path (spec §8, quorum #5). Every surface ends here:
 * priceInvocation over the bound rate snapshot → ai_invocations rows → the
 * reservation settlement derives session totals and ai_cost_usage from those
 * rows in ONE transaction → platform credits are drawn down by the same cents.
 * The provider's own cost is copied onto the ledger as telemetry, never billed.
 */
import type { AiSurface } from '@breeze/shared';
import { recordInvocationsWithRollups, settleAiBudgetReservationDurably } from '../aiBudgetReservations';
import { deductBillingCredits } from '../aiCostTracker';
import type { BilledUsage, TurnOutcome } from './invocationUsage';
import type { NewInvocation } from './invocationLedger';
import { priceInvocation, type RateSnapshot } from './pricing';
import type { ResolvedModel } from './resolveModel';
import { rateForServedModel, type TurnBinding } from './turnBinding';

/** Server-side web search fee per request (moved from catalogEnrichmentService.ts). */
export const WEB_SEARCH_COST_CENTS = 1;

export interface PricedUsage extends BilledUsage { rate: RateSnapshot; costCents: number }

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function sumCostCents(priced: ReadonlyArray<{ costCents: number }>): number {
  return round6(priced.reduce((sum, p) => sum + p.costCents, 0));
}

export function priceUsage(binding: TurnBinding, usage: BilledUsage[]): PricedUsage[] {
  const rows: BilledUsage[] = usage.length > 0 ? usage : [{ model: binding.wireModel, tokens: ZERO, webSearchRequests: 0 }];
  return rows.map((u) => {
    const rate = rateForServedModel(binding, u.model);
    // resolveModel attaches `option` to a snapshot only when fast was applied,
    // so its presence IS the applied speed for this row's model.
    const applied = rate.option ? { speed: 'fast' as const } : {};
    const costCents = round6(priceInvocation(rate, u.tokens, applied) + u.webSearchRequests * WEB_SEARCH_COST_CENTS);
    return { ...u, rate, costCents };
  });
}

export function costEstimator(
  resolved: Pick<ResolvedModel, 'rateSnapshot' | 'options'>,
): (inputTokens: number, outputTokens: number) => number {
  return (inputTokens, outputTokens) =>
    priceInvocation(resolved.rateSnapshot, { input: inputTokens, output: outputTokens, cacheRead: 0, cacheWrite: 0 }, resolved.options);
}

export interface SettleInvocationInput {
  binding: TurnBinding;
  orgId: string;
  userId: string | null;
  sessionId: string | null;
  agentRunId: string | null;
  sourceRef: string | null;
  usage: BilledUsage[];
  outcome: TurnOutcome;
  reservationId?: string;
  messageCount?: number;
  toolExecutionCount?: number;
  turnCount?: number;
}

export interface SettledInvocation { costCents: number; invocationIds: string[]; deferred: boolean }

export function toNewInvocations(input: SettleInvocationInput, priced: PricedUsage[]): NewInvocation[] {
  const b = input.binding;
  const multi = priced.length > 1;
  return priced.map((p, index) => {
    const servedByFallback = input.outcome.fallbackUsed && p.model !== b.wireModel;
    const refusedLeg = input.outcome.fallbackUsed && multi && p.model === b.wireModel;
    return {
      orgId: input.orgId,
      surface: b.surface as AiSurface,
      role: b.role,
      userId: input.userId,
      sessionId: input.sessionId,
      agentRunId: input.agentRunId,
      sourceRef: input.sourceRef,
      offeringId: b.offeringId,
      connectionId: b.connectionId,
      fundingSource: b.funding,
      requestedModel: b.wireModel,
      servedModel: p.model,
      optionsSent: b.options,
      thinkingModeSent: b.thinkingMode,
      inferenceGeoSent: b.inferenceGeo,
      stopReason: refusedLeg ? 'refusal' : input.outcome.stopReason,
      refusalCategory: refusedLeg || servedByFallback || input.outcome.refused ? input.outcome.refusalCategory : null,
      fallbackUsed: servedByFallback,
      catalogRevisionId: b.catalogRevisionId,
      connectionConfigVersion: b.configVersion,
      inputTokens: p.tokens.input,
      outputTokens: p.tokens.output,
      cacheReadTokens: p.tokens.cacheRead,
      cacheWriteTokens: p.tokens.cacheWrite,
      rateSnapshot: p.webSearchRequests > 0
        ? { ...p.rate, serverToolFees: { webSearchRequests: p.webSearchRequests, centsEach: WEB_SEARCH_COST_CENTS } }
        : p.rate,
      costCents: p.costCents,
      chargeable: false, // W10 sets the chargeback snapshot
      sdkReportedCostUsd: index === 0 ? input.outcome.sdkReportedCostUsd : null,
      // W02 wrote 'shadow' rows beside the legacy path; from W03 the ledger is the
      // billing record, and rollups are derived from these rows only (W02 Task 5).
      ledgerMode: 'authoritative',
      legacyCostCents: null,
    } as NewInvocation;
  });
}

export async function settleInvocation(input: SettleInvocationInput): Promise<SettledInvocation> {
  const priced = priceUsage(input.binding, input.usage);
  const rows = toNewInvocations(input, priced);
  const costCents = sumCostCents(priced);
  let invocationIds: string[] = [];
  let deferred = false;

  if (input.reservationId) {
    const result = await settleAiBudgetReservationDurably({
      orgId: input.orgId,
      reservationId: input.reservationId,
      invocations: rows,
      messageCount: input.messageCount ?? 1,
      toolExecutionCount: input.toolExecutionCount ?? 0,
      ...(input.sessionId ? { session: { id: input.sessionId, turnCount: input.turnCount ?? 1 } } : {}),
    });
    deferred = result.kind === 'deferred_indeterminate';
    invocationIds = 'invocationIds' in result ? result.invocationIds : [];
  } else {
    invocationIds = await recordInvocationsWithRollups({
      orgId: input.orgId,
      invocations: rows,
      sessionId: input.sessionId,
      messageCount: input.messageCount ?? 1,
      toolExecutionCount: input.toolExecutionCount ?? 0,
      turnCount: input.turnCount ?? 1,
    });
  }

  // Platform credits are drawn down by Step 8a's debitSettledCredits — once per
  // reservation, keyed, only when THIS call settled it (review finding 1).
  return { costCents, invocationIds, deferred };
}
```

- [ ] **Step 4: Run the unit tests**

Run: `cd apps/api && npx vitest run src/services/aiModels/settleInvocation.test.ts`
Expected: PASS (9 tests). The `priceInvocation` expectations assume W01's documented formula: cents/M × tokens / 1e6 per component, rounded to 6 dp. If W01 rounds differently, the `300` / `150` literals change accordingly; the `toBe(priceInvocation(...))` assertion is the authority.

- [ ] **Step 5: Write the migration, schema and export-policy change**

```sql
-- apps/api/migrations/2026-11-19-100000-ai-budget-reservation-model-binding.sql
-- AI model registry W03 (#7601, spec §9.2): the turn claim binds offering,
-- options, rate snapshot and reservation ATOMICALLY. The reservation row is the
-- durable turn claim, so the binding lives on it; settlement rejects any
-- ledger row whose rate is not one bound here. jsonb → CORE_TENANT_EXPORT_POLICY
-- excludedOpen. DDL only (no row writes, so no scope election). Idempotent.
ALTER TABLE ai_budget_reservations ADD COLUMN IF NOT EXISTS model_binding jsonb NULL;
```

```ts
// apps/api/src/db/schema/ai.ts — aiBudgetReservations columns
  /** AI model registry W03 (spec §9.2): the TurnBinding this reservation claimed. */
  modelBinding: jsonb('model_binding').$type<Record<string, unknown> | null>(),
```

```ts
// apps/api/src/services/tenantExportPolicyRegistry.ts — in the ai_budget_reservations entry
//   excludedOpen: [..., 'model_binding'],   // turn binding (rate snapshot + options), open container
```

- [ ] **Step 6: Change `aiBudgetReservations.ts`**

Make these four edits. The new imports are:

```ts
import { parseTurnBinding, stableJson, type TurnBinding } from './aiModels/turnBinding';
import { recordInvocation, type NewInvocation } from './aiModels/invocationLedger';
```

Neither module imports `aiBudgetReservations.ts`, so there is no cycle.

1. `ReserveAiBudgetInput` gains `binding?: TurnBinding` (import the type from `./aiModels/turnBinding`). The `INSERT INTO ai_budget_reservations` (~L597) adds the column, and in the **same** `inReservationTransaction` callback, right after the insert, stamp the session:

```ts
      INSERT INTO ai_budget_reservations (
        org_id, idempotency_key, session_id, billing_source, namespace,
        daily_period_key, monthly_period_key, uncapped, reserved_cost_cents, model_binding,
        expires_at
      ) VALUES (
        ${input.orgId}::uuid, ${input.idempotencyKey}, ${sessionId}::uuid, ${input.billingSource},
        ${namespace},
        ${keys.daily}, ${keys.monthly}, ${uncapped},
        ${moneyString(reservedCostCents, 'reservedCostCents')}::numeric,
        ${input.binding ? JSON.stringify(input.binding) : null}::jsonb,
        now() + make_interval(secs => ${activeTtlSeconds})
      )
```

```ts
    // Spec §9.2 bullet 1: the turn claim binds offering + options + rate +
    // reservation atomically. A failure here (e.g. the composite
    // (offering_id, offering_partner_id) FK) rolls the reservation back too.
    if (input.binding && sessionId && input.binding.offeringId) {
      if (input.binding.funding !== input.billingSource) {
        throw new Error('Reservation billing source does not match the turn binding');
      }
      const stamped = rows<{ id: string }>(await db.execute<{ id: string }>(sql`
        UPDATE ai_sessions
        SET offering_id = ${input.binding.offeringId}::uuid,
            offering_partner_id = ${input.binding.partnerId}::uuid,
            options = ${JSON.stringify(input.binding.options)}::jsonb,
            model = ${input.binding.logicalModel},
            billing_source = ${input.binding.funding},
            updated_at = now()
        WHERE id = ${sessionId}::uuid AND org_id = ${input.orgId}::uuid
        RETURNING id
      `))[0];
      if (!stamped) throw new Error('AI session not found in reservation organization');
    }
```

2. `SettleAiBudgetReservationInput` gains `invocations?: NewInvocation[]`, and `actualCostCents` / `inputTokens` / `outputTokens` become optional (they are required when `invocations` is absent). At the top of `settleAiBudgetReservation`, derive the totals from the rows:

```ts
  const derived = input.invocations
    ? {
        actualCostCents: input.invocations.reduce((s, r) => s + Number(r.costCents), 0),
        // Same semantics as sumInputTokens(): the *_input_tokens columns store all three input slices.
        inputTokens: input.invocations.reduce((s, r) => s + r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens, 0),
        outputTokens: input.invocations.reduce((s, r) => s + r.outputTokens, 0),
      }
    : null;
  if (!derived && (input.actualCostCents === undefined || input.inputTokens === undefined || input.outputTokens === undefined)) {
    throw new Error('settleAiBudgetReservation needs invocations or explicit totals');
  }
  const totals = derived ?? { actualCostCents: input.actualCostCents!, inputTokens: input.inputTokens!, outputTokens: input.outputTokens! };
  const cost = moneyString(totals.actualCostCents, 'actualCostCents');
  const inputTokens = nonNegativeInteger(totals.inputTokens, 'inputTokens');
  const outputTokens = nonNegativeInteger(totals.outputTokens, 'outputTokens');
```

Pass `totals` into `settlementFingerprint`. Change its first parameter to `{ ...input, ...totals }` so the fingerprint shape is unchanged.

3. Inside the transaction, after the `released` / session checks and **before** the session `UPDATE`, select `model_binding` (add it to both `SELECT` column lists and to `ReservationRow`), then:

```ts
    const binding = parseTurnBinding(reservation.model_binding);
    if (binding && input.invocations) assertInvocationsMatchBinding(binding, input.invocations);
    const invocationIds: string[] = [];
    for (const row of input.invocations ?? []) {
      // Ambient db = this transaction (P10): the ledger row commits or rolls
      // back with the rollups derived from it below.
      invocationIds.push(await recordInvocation(row));
    }
```

Return `invocationIds` from both result kinds (`[]` for `already_settled`). Add the module-private helper:

```ts
function stripFees(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const { serverToolFees: _fees, ...rest } = snapshot as Record<string, unknown>;
  return rest;
}

function sameJson(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);   // from ./aiModels/turnBinding
}

/** A settlement may only bill a rate the turn claim bound (spec §9.2, §8). */
function assertInvocationsMatchBinding(binding: TurnBinding, invocations: NewInvocation[]): void {
  for (const row of invocations) {
    const rate = stripFees(row.rateSnapshot);
    const boundRate = sameJson(rate, binding.rateSnapshot)
      || (binding.refusalFallback !== null && sameJson(rate, binding.refusalFallback.rateSnapshot));
    if (row.offeringId !== binding.offeringId || row.fundingSource !== binding.funding || !boundRate) {
      throw new Error('Settlement rate does not match the turn binding');
    }
  }
}
```

4. Extract the session `UPDATE` and the two `ai_cost_usage` upserts into a module-private `applyUsageRollups({ orgId, sessionId, billingSource, keys: { daily, monthly }, cost, inputTokens, outputTokens, messageCount, toolExecutionCount, turnCount, at })`. Call it from `settleAiBudgetReservation` (with `reservation.billing_source` and the reservation's period keys), then add the no-reservation entry point:

```ts
/**
 * Ledger rows + rollups derived from them, for a call with no reservation.
 * Same derivation as settlement; no organization lock (no hold to release).
 */
export async function recordInvocationsWithRollups(input: {
  orgId: string;
  invocations: NewInvocation[];
  sessionId?: string | null;
  messageCount?: number;
  toolExecutionCount?: number;
  turnCount?: number;
  now?: Date;
}): Promise<string[]> {
  const at = input.now ?? new Date();
  const keys = periodKeysFor(at);           // the same helper reserveAiBudget uses
  const funding = input.invocations[0]?.fundingSource ?? 'platform';
  return inReservationTransaction('aiBudgetReservations.recordInvocations', async () => {
    const ids: string[] = [];
    for (const row of input.invocations) ids.push(await recordInvocation(row));
    await applyUsageRollups({
      orgId: input.orgId,
      sessionId: input.sessionId ?? null,
      billingSource: funding,
      keys,
      cost: moneyString(input.invocations.reduce((s, r) => s + Number(r.costCents), 0), 'actualCostCents'),
      inputTokens: input.invocations.reduce((s, r) => s + r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens, 0),
      outputTokens: input.invocations.reduce((s, r) => s + r.outputTokens, 0),
      messageCount: input.messageCount ?? 1,
      toolExecutionCount: input.toolExecutionCount ?? 0,
      turnCount: input.turnCount ?? 1,
      at,
    });
    return ids;
  });
}
```

> If the module's period-key helper has another name, use it. It is the function that produces `keys.daily` / `keys.monthly` for `reserveAiBudget` (~L560).

- [ ] **Step 7: Write the integration tests**

```ts
// apps/api/src/__tests__/integration/aiInvocationSettlement.integration.test.ts
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { reserveAiBudget } from '../../services/aiBudgetReservations';
import { getPlatformModelById } from '../../services/aiModels/platformModels';
import { resolveModel, type ResolvedModel } from '../../services/aiModels/resolveModel';
import { priceInvocation } from '../../services/aiModels/pricing';
import { settleInvocation } from '../../services/aiModels/settleInvocation';
import { turnBindingFrom } from '../../services/aiModels/turnBinding';
import { seedPlatformModel } from './aiModelRegistryFixtures';
import { seedRegistryPartner, type SeededRegistryPartner } from './helpers/aiModelRegistrySeed';

const T = { input: 120_000, output: 40_000, cacheRead: 500_000, cacheWrite: 2_000 };
const OK = (sdk: number | null) => ({
  stopReason: 'end_turn', refused: false, refusalCategory: null, fallbackUsed: false,
  servedModel: '', sdkReportedCostUsd: sdk,
});

async function sys<T>(fn: () => Promise<T>): Promise<T> { return withSystemDbAccessContext(fn); }

describe('ai_invocations is the source of truth for every rollup', () => {
  let s: SeededRegistryPartner;
  let resolved: ResolvedModel;

  beforeAll(async () => {
    s = await seedRegistryPartner('platform');
    const r = await resolveModel({ partnerId: s.partnerId, orgId: s.orgId, userId: s.userId, surface: 'chat' });
    if (!r.ok) throw new Error(r.reason);
    resolved = r;
  });

  it('binds the turn atomically: reservation + session offering in one transaction', async () => {
    const binding = turnBindingFrom(resolved);
    const res = await reserveAiBudget({
      orgId: s.orgId, billingSource: binding.funding, sessionId: s.chatSessionId,
      idempotencyKey: `t:${randomUUID()}`, binding,
    });
    expect(res.kind).not.toBe('denied');
    const [row] = await sys(() => db.execute<{ model_binding: { offeringId: string }; offering_id: string }>(sql`
      SELECT r.model_binding, s.offering_id FROM ai_budget_reservations r
      JOIN ai_sessions s ON s.id = r.session_id
      WHERE r.id = ${(res as { reservationId: string }).reservationId}::uuid`));
    expect(row!.model_binding.offeringId).toBe(binding.offeringId);
    expect(row!.offering_id).toBe(binding.offeringId);
  });

  it('a binding that fails the session stamp leaves NO reservation behind', async () => {
    const other = await seedRegistryPartner('byok');
    const forged = { ...turnBindingFrom(resolved), partnerId: other.partnerId }; // composite FK must refuse
    const key = `t:${randomUUID()}`;
    await expect(reserveAiBudget({
      orgId: s.orgId, billingSource: forged.funding, sessionId: s.chatSessionId, idempotencyKey: key, binding: forged,
    })).rejects.toThrow();
    const left = await sys(() => db.execute(sql`
      SELECT 1 FROM ai_budget_reservations WHERE idempotency_key = ${key}`));
    expect(left).toHaveLength(0);
  });

  it('settled rollups equal the sum of the ledger rows, and the SDK\'s positive-but-wrong cost is never billed', async () => {
    const binding = turnBindingFrom(resolved);
    const before = await sys(() => db.execute<{ c: string }>(sql`
      SELECT total_cost_cents AS c FROM ai_sessions WHERE id = ${s.chatSessionId}::uuid`));
    const res = await reserveAiBudget({
      orgId: s.orgId, billingSource: binding.funding, sessionId: s.chatSessionId, idempotencyKey: `t:${randomUUID()}`, binding,
    }) as { reservationId: string };
    const out = await settleInvocation({
      binding, orgId: s.orgId, userId: s.userId, sessionId: s.chatSessionId, agentRunId: null, sourceRef: null,
      usage: [{ model: binding.wireModel, tokens: T, webSearchRequests: 0 }],
      outcome: { ...OK(99.99), servedModel: binding.wireModel }, reservationId: res.reservationId,
    });
    const expected = priceInvocation(binding.rateSnapshot, T, binding.options);
    expect(out.costCents).toBeCloseTo(expected, 6);
    const [ledger] = await sys(() => db.execute<{ cost_cents: string; sdk_reported_cost_usd: string }>(sql`
      SELECT cost_cents, sdk_reported_cost_usd FROM ai_invocations WHERE id = ${out.invocationIds[0]}::uuid`));
    expect(Number(ledger!.cost_cents)).toBeCloseTo(expected, 6);
    expect(Number(ledger!.sdk_reported_cost_usd)).toBe(99.99);
    const after = await sys(() => db.execute<{ c: string }>(sql`
      SELECT total_cost_cents AS c FROM ai_sessions WHERE id = ${s.chatSessionId}::uuid`));
    expect(Number(after[0]!.c) - Number(before[0]!.c)).toBeCloseTo(expected, 6);
    const [sums] = await sys(() => db.execute<{ ledger: string }>(sql`
      SELECT COALESCE(SUM(cost_cents), 0) AS ledger FROM ai_invocations WHERE session_id = ${s.chatSessionId}::uuid`));
    expect(Number(after[0]!.c)).toBeCloseTo(Number(sums!.ledger), 6);
  });

  it('a $0 SDK cost on a model added by today\'s discovery bills its platform rate', async () => {
    // A freshly seeded platform row stands in for one discovery added today:
    // the SDK's bundled price table cannot know it, so it reports $0.
    const pm = (await getPlatformModelById(await seedPlatformModel()))!;
    const binding = { ...turnBindingFrom(resolved), wireModel: pm.modelId, logicalModel: pm.modelId,
      rateSnapshot: { source: 'platform' as const, standard: pm.rates! } };
    const out = await settleInvocation({
      binding, orgId: s.orgId, userId: null, sessionId: null, agentRunId: null, sourceRef: 'test',
      usage: [{ model: pm.modelId, tokens: T, webSearchRequests: 0 }],
      outcome: { ...OK(0), servedModel: pm.modelId },
    });
    expect(out.costCents).toBeGreaterThan(0);
    expect(out.costCents).toBeCloseTo(priceInvocation(binding.rateSnapshot, T, {}), 6);
  });

  it('a settlement carrying a rate the turn did not bind is rejected and writes nothing', async () => {
    const binding = turnBindingFrom(resolved);
    const res = await reserveAiBudget({
      orgId: s.orgId, billingSource: binding.funding, sessionId: s.chatSessionId, idempotencyKey: `t:${randomUUID()}`, binding,
    }) as { reservationId: string };
    const tampered = { ...binding, rateSnapshot: { ...binding.rateSnapshot, standard: { ...binding.rateSnapshot.standard, inputCentsPerM: 1 } } };
    const countBefore = await sys(() => db.execute(sql`SELECT 1 FROM ai_invocations WHERE org_id = ${s.orgId}::uuid`));
    await expect(settleInvocation({
      binding: tampered, orgId: s.orgId, userId: null, sessionId: s.chatSessionId, agentRunId: null, sourceRef: null,
      usage: [{ model: binding.wireModel, tokens: T, webSearchRequests: 0 }],
      outcome: { ...OK(null), servedModel: binding.wireModel }, reservationId: res.reservationId,
    })).rejects.toThrow(/does not match the turn binding/);
    const countAfter = await sys(() => db.execute(sql`SELECT 1 FROM ai_invocations WHERE org_id = ${s.orgId}::uuid`));
    expect(countAfter.length).toBe(countBefore.length);
  });
});
```


- [ ] **Step 8: Run unit, integration and the export-policy contracts**

Run: `cd apps/api && npx vitest run src/services/aiModels/settleInvocation.test.ts src/services/aiBudgetReservations.test.ts`
Expected: PASS. The existing `aiBudgetReservations.test.ts` cases keep passing because the numeric-totals path is unchanged.

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiInvocationSettlement.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`
Expected: PASS. The export-policy suites fail if `model_binding` is unclassified, which proves the registry edit landed.

- [ ] **Step 8a: Exactly-once credits, durable deferred settlements, binding on replay (review findings 1, 2, 4)**

Three gaps a repeated or contended settlement would otherwise open:

- **Finding 1: an unkeyed debit.**
  - *Problem.* `deductBillingCredits` is an unkeyed HTTP POST, and the steps above call it after **every** settlement, including `already_settled` replays (`aiBudgetReservations.ts:658–662` dedupes only the rollups).
  - *Fix.* The debit now happens only when **this call** moved the reservation to `settled`. It carries an idempotency key, `ai-settlement:<reservationId>`. A durable `credits_debited_at` stamp on the reservation lets the sweep retry a debit whose HTTP call failed, under the same key.
- **Finding 2: lost deferred settlements.**
  - *Problem.* A settlement deferred by org-lock contention (`deferred_indeterminate`) persisted nothing, and expiry never replays usage.
  - *Fix.* The full settle input (the priced ledger rows) is written to `ai_budget_reservations.pending_settlement` under the **reservation row lock only**, with no org lock, so it cannot hit the same contention. The existing sweep job replays it through the same idempotent `settleAiBudgetReservation`, and the debit follows the first-transition rule above.
- **Finding 4: a reused reservation with a stale binding.**
  - *Problem.* A stable-key retry (`ai-agent-run:<runId>`, `script-review:<id>:<attempt>`) gets back the existing **active** reservation, whose binding may predate a rate or offering change. Settlement would then reject the new rows and leak the hold.
  - *Fix.* On a key replay of a reservation that is still `active` and never settled, `reserveAiBudget` **re-binds** it in the same transaction (new `model_binding`, session re-stamped) before anything is dispatched. A billing-source change already throws there (`aiBudgetReservations.ts:447–453`), and so does a replay onto a non-`active` reservation.
  - *Why re-bind rather than reuse the old binding or reject?* The unsettled reservation describes a dispatch that never completed (lease recovery, a job retry). Reusing its old binding would bill a model nobody is about to run, and rejecting would wedge the run forever on its stable key.

Extra files for this step:
- Modify: `apps/api/migrations/2026-11-19-100000-ai-budget-reservation-model-binding.sql` (two more columns; the file is not shipped yet)
- Modify: `apps/api/src/jobs/aiBudgetReservationSweep.ts` (replay pending settlements and retry missed debits before expiry)
- Modify: `apps/api/src/services/aiCostTracker.ts` (`deductBillingCredits(orgId, costCents, opts?: { idempotencyKey?: string }): Promise<boolean>` returns whether the billing service accepted it; the body gains `idempotencyKey`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`pending_settlement` → `excludedOpen`, `credits_debited_at` → `included`)

Interfaces added:

```ts
// aiBudgetReservations.ts
export class AiBudgetBindingConflictError extends Error { readonly code: 'binding_conflict' }
export function persistPendingSettlement(input: SettleAiBudgetReservationInput): Promise<'persisted' | 'already_settled'>;
export function replayPendingAiSettlements(limit?: number): Promise<Array<{ reservationId: string; orgId: string; kind: 'settled' | 'already_settled'; invocations: NewInvocation[] }>>;
export function markCreditsDebited(reservationId: string): Promise<void>;
export function listUndebitedPlatformSettlements(limit?: number): Promise<Array<{ reservationId: string; orgId: string; costCents: number }>>;
// settleInvocation.ts
export function debitSettledCredits(input: { orgId: string; reservationId: string | null; invocations: readonly NewInvocation[] }): Promise<void>;
```

Migration additions (append to the Task 6 file):

```sql
-- Review finding 2: a settlement deferred by org-lock contention persists its
-- priced ledger rows here (reservation row lock only) and the sweep replays
-- them idempotently. Review finding 1: credits are debited once per
-- reservation, keyed and stamped. pending_settlement is jsonb → excludedOpen.
ALTER TABLE ai_budget_reservations ADD COLUMN IF NOT EXISTS pending_settlement jsonb NULL;
ALTER TABLE ai_budget_reservations ADD COLUMN IF NOT EXISTS credits_debited_at timestamptz NULL;
CREATE INDEX IF NOT EXISTS ai_budget_reservations_pending_settlement_idx
  ON ai_budget_reservations (updated_at) WHERE pending_settlement IS NOT NULL;
```

Write the failing tests first:

```ts
// appended to settleInvocation.test.ts
describe('credits are debited exactly once per reservation (finding 1)', () => {
  it('a repeated settlement of the same reservation debits once, with the reservation key', async () => {
    m.settleDurably
      .mockResolvedValueOnce({ kind: 'settled', reservationId: 'r1', actualCostCents: 300, invocationIds: ['i1'] })
      .mockResolvedValueOnce({ kind: 'already_settled', reservationId: 'r1', actualCostCents: 300, invocationIds: [] });
    const input = {
      binding: B, orgId: 'o1', userId: null, sessionId: null, agentRunId: null, sourceRef: null,
      usage: [{ model: 'claude-sonnet-5-5', tokens: T, webSearchRequests: 0 }], outcome: OK, reservationId: 'r1',
    };
    await settleInvocation(input);
    await settleInvocation(input);
    expect(m.deduct).toHaveBeenCalledTimes(1);
    expect(m.deduct).toHaveBeenCalledWith('o1', 300, { idempotencyKey: 'ai-settlement:r1' });
    expect(m.markDebited).toHaveBeenCalledWith('r1');
  });

  it('a deferred settlement debits nothing now (the sweep replays and debits later)', async () => {
    m.settleDurably.mockResolvedValue({ kind: 'deferred_indeterminate', reservationId: 'r1' });
    const out = await settleInvocation({
      binding: B, orgId: 'o1', userId: null, sessionId: null, agentRunId: null, sourceRef: null,
      usage: [{ model: 'claude-sonnet-5-5', tokens: T, webSearchRequests: 0 }], outcome: OK, reservationId: 'r1',
    });
    expect(out.deferred).toBe(true);
    expect(m.deduct).not.toHaveBeenCalled();
  });

  it('a rejected debit is not stamped (the sweep retries it under the same key)', async () => {
    m.deduct.mockResolvedValue(false);
    await settleInvocation({
      binding: B, orgId: 'o1', userId: null, sessionId: null, agentRunId: null, sourceRef: null,
      usage: [{ model: 'claude-sonnet-5-5', tokens: T, webSearchRequests: 0 }], outcome: OK, reservationId: 'r1',
    });
    expect(m.markDebited).not.toHaveBeenCalled();
  });
});
```

Add `markDebited: vi.fn()` to the hoisted mocks, `markCreditsDebited: m.markDebited` to the `../aiBudgetReservations` mock, and `m.deduct.mockResolvedValue(true)` to `beforeEach`.

```ts
// appended to aiInvocationSettlement.integration.test.ts
describe('contended, replayed and retried settlements (findings 1, 2, 4)', () => {
  it('lock contention twice → rows persisted pending, not lost; the sweep replays ledger + rollups exactly once', async () => {
    const s = await seedRegistryPartner('platform');
    const r = await resolveModel({ partnerId: s.partnerId, orgId: s.orgId, surface: 'chat' });
    if (!r.ok) throw new Error(r.reason);
    const binding = turnBindingFrom(r);
    const res = await reserveAiBudget({ orgId: s.orgId, billingSource: binding.funding, sessionId: s.chatSessionId,
      idempotencyKey: `t:${randomUUID()}`, binding }) as { reservationId: string };
    // Hold the org row lock from another connection so both settle attempts time out.
    const blocker = await holdOrganizationLock(s.orgId);
    try {
      const out = await settleInvocation({
        binding, orgId: s.orgId, userId: null, sessionId: s.chatSessionId, agentRunId: null, sourceRef: null,
        usage: [{ model: binding.wireModel, tokens: T, webSearchRequests: 0 }],
        outcome: { ...OK(1.23), servedModel: binding.wireModel }, reservationId: res.reservationId,
      });
      expect(out.deferred).toBe(true);
    } finally {
      await blocker.release();
    }
    const [pending] = await sys(() => db.execute<{ pending_settlement: unknown }>(sql`
      SELECT pending_settlement FROM ai_budget_reservations WHERE id = ${res.reservationId}::uuid`));
    expect(pending!.pending_settlement).not.toBeNull();
    const first = await replayPendingAiSettlements();
    const second = await replayPendingAiSettlements();
    expect(first.map((x) => x.kind)).toEqual(['settled']);
    expect(second).toEqual([]);   // pending cleared in the settling transaction
    const rows = await sys(() => db.execute(sql`SELECT 1 FROM ai_invocations WHERE session_id = ${s.chatSessionId}::uuid`));
    expect(rows).toHaveLength(1);
  });

  it('a stable-key replay after a rate change re-binds the active reservation before dispatch (finding 4)', async () => {
    const s = await seedRegistryPartner('platform');
    const r = await resolveModel({ partnerId: s.partnerId, orgId: s.orgId, surface: 'ai_agents' });
    if (!r.ok) throw new Error(r.reason);
    const key = `ai-agent-run:${randomUUID()}`;
    const old = turnBindingFrom(r);
    const first = await reserveAiBudget({ orgId: s.orgId, billingSource: old.funding, idempotencyKey: key, binding: old }) as { reservationId: string };
    const repriced = { ...old, rateSnapshot: { ...old.rateSnapshot, standard: { ...old.rateSnapshot.standard, inputCentsPerM: 999 } } };
    const again = await reserveAiBudget({ orgId: s.orgId, billingSource: old.funding, idempotencyKey: key, binding: repriced }) as { reservationId: string };
    expect(again.reservationId).toBe(first.reservationId);
    await expect(settleInvocation({
      binding: old, orgId: s.orgId, userId: null, sessionId: null, agentRunId: null, sourceRef: null,
      usage: [{ model: old.wireModel, tokens: T, webSearchRequests: 0 }], outcome: { ...OK(null), servedModel: old.wireModel },
      reservationId: first.reservationId,
    })).rejects.toThrow(/does not match the turn binding/);
    await expect(settleInvocation({
      binding: repriced, orgId: s.orgId, userId: null, sessionId: null, agentRunId: null, sourceRef: null,
      usage: [{ model: old.wireModel, tokens: T, webSearchRequests: 0 }], outcome: { ...OK(null), servedModel: old.wireModel },
      reservationId: first.reservationId,
    })).resolves.toMatchObject({ deferred: false });
  });
});
```

> `holdOrganizationLock(orgId)` opens a dedicated superuser connection, runs `BEGIN; SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`, and returns `{ release }` (commit + close). Put it in `helpers/aiModelRegistrySeed.ts`. For the test, lower `AI_BUDGET_SETTLEMENT_LOCK_TIMEOUT_MS` through its existing env/test override; if there is none, add an optional `lockTimeoutMs` to `SettleAiBudgetReservationInput`, used only by tests.

Then implement:

1. `aiCostTracker.deductBillingCredits(orgId, costCents, opts?: { idempotencyKey?: string })` sends `{ costCents, idempotencyKey }` and returns `true` only on `res.ok`. The billing service must honour the key; see the cross-repo item at the end of this plan. Legacy callers that ignore the result are unaffected.
2. In `settleInvocation`, replace the unconditional debit with:

```ts
  if (input.reservationId) {
    // … settleAiBudgetReservationDurably as above …
    if (result.kind === 'settled') {
      await debitSettledCredits({ orgId: input.orgId, reservationId: input.reservationId, invocations: rows });
    }
    // 'already_settled' → another call settled and debited; 'deferred_indeterminate' → the sweep will.
  } else {
    invocationIds = await recordInvocationsWithRollups({ /* … */ });
    await debitSettledCredits({ orgId: input.orgId, reservationId: null, invocations: rows });
  }
```

```ts
/** Platform-funded spend leaves prepaid credits exactly once per reservation (finding 1). */
export async function debitSettledCredits(input: {
  orgId: string; reservationId: string | null; invocations: readonly NewInvocation[];
}): Promise<void> {
  const platformCents = sumCostCents(input.invocations.filter((r) => r.fundingSource === 'platform'));
  if (platformCents <= 0) return;
  const key = input.reservationId ? `ai-settlement:${input.reservationId}` : `ai-invocation:${input.invocations[0]!.sourceRef ?? randomUUID()}`;
  const accepted = await deductBillingCredits(input.orgId, platformCents, { idempotencyKey: key });
  if (accepted && input.reservationId) await markCreditsDebited(input.reservationId);
}
```

3. In `aiBudgetReservations.ts`:
   - `settleAiBudgetReservationDurably`: on the second lock timeout, **before** `markAiBudgetReservationIndeterminate`, call `persistPendingSettlement(input)`, and return `deferred_indeterminate` only if that call succeeded. If persisting also fails, keep today's capture and log path.
   - `persistPendingSettlement(input)`: `inReservationTransaction` **without** `lockOrganizationRow`:

```sql
UPDATE ai_budget_reservations SET pending_settlement = ${JSON.stringify(input)}::jsonb, updated_at = now()
WHERE id = ${input.reservationId}::uuid AND org_id = ${input.orgId}::uuid
  AND status IN ('active', 'indeterminate', 'expired') AND pending_settlement IS NULL
RETURNING id
```

     No row back means it is already settled or already pending.
   - The `settleAiBudgetReservation` final `UPDATE` also sets `pending_settlement = NULL`.
   - `replayPendingAiSettlements(limit = 100)`: select `id, org_id, pending_settlement` where it is not null and `status <> 'settled'`, ordered by `updated_at`. Re-run `settleAiBudgetReservation(stored)` for each; it is idempotent by fingerprint. Return each result with its invocations.
   - `markCreditsDebited(id)`: `UPDATE … SET credits_debited_at = now() WHERE id = $1 AND credits_debited_at IS NULL`.
   - `listUndebitedPlatformSettlements`: settled rows with `billing_source = 'platform'`, `actual_cost_cents > 0`, `credits_debited_at IS NULL` and `settled_at < now() - interval '2 minutes'`.
   - Finding 4, `reserveAiBudget`'s existing-key branch, after the conflict check:

```ts
    if (existing) {
      if (/* existing billing_source / session / namespace conflict */) throw new Error('AI budget reservation idempotency key conflicts with another dispatch');
      if (input.binding && stableJson(parseTurnBinding(existing.model_binding)) !== stableJson(input.binding)) {
        if (existing.status !== 'active' || existing.settlement_fingerprint !== null) {
          throw new AiBudgetBindingConflictError();   // never re-bind a reservation whose outcome is (or may be) recorded
        }
        await db.execute(sql`UPDATE ai_budget_reservations SET model_binding = ${JSON.stringify(input.binding)}::jsonb, updated_at = now()
                             WHERE id = ${existing.id}::uuid`);
        if (sessionId && input.binding.offeringId) await stampSessionBinding(sessionId, input.orgId, input.binding);   // the same UPDATE as a fresh claim
      }
      return existingResult(existing);
    }
```

   Add `model_binding` to the existing-row `SELECT`. Extract the session-stamp `UPDATE` from the fresh-claim path into `stampSessionBinding(sessionId, orgId, binding)` so both paths use it.
4. `jobs/aiBudgetReservationSweep.ts`, before `expireStaleAiBudgetReservations`:

```ts
  for (const settled of await replayPendingAiSettlements()) {
    if (settled.kind === 'settled') {
      await debitSettledCredits({ orgId: settled.orgId, reservationId: settled.reservationId, invocations: settled.invocations });
    }
  }
  for (const missed of await listUndebitedPlatformSettlements()) {
    // Same idempotency key as the first attempt: the billing service dedupes.
    if (await deductBillingCredits(missed.orgId, missed.costCents, { idempotencyKey: `ai-settlement:${missed.reservationId}` })) {
      await markCreditsDebited(missed.reservationId);
    }
  }
```

Run: `cd apps/api && npx vitest run src/services/aiModels/settleInvocation.test.ts src/services/aiBudgetReservations.test.ts src/jobs/aiBudgetReservationSweep.test.ts && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiInvocationSettlement.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts`
Expected: PASS. The export-policy suite fails until both new columns are classified.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/aiModels/settleInvocation.ts apps/api/src/services/aiModels/settleInvocation.test.ts \
  apps/api/migrations/2026-11-19-100000-ai-budget-reservation-model-binding.sql \
  apps/api/src/__tests__/integration/aiInvocationSettlement.integration.test.ts \
  apps/api/src/services/aiBudgetReservations.ts apps/api/src/db/schema/ai.ts \
  apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/aiCostTracker.ts \
  apps/api/src/jobs/aiBudgetReservationSweep.ts apps/api/src/jobs/aiBudgetReservationSweep.test.ts \
  apps/api/src/__tests__/integration/helpers/aiModelRegistrySeed.ts
git commit -m "feat(ai): single billing path — ledger rows settle with derived rollups and bound rates (#7601)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 6A: Registry cutover — per-partner, durable, coordinated, and never blocking liveness

W02 keeps the registry a **projection** of the legacy config. W03 makes the registry the authority, so each partner must be reconciled **exactly once, durably, before any registry-routed dispatch for that partner**, and never again: after the flip (Task 6B), re-running the projection would revert registry-native writes. The Codex review found three ways a boot-time global sweep fails that:
- **Finding 7: no barrier on partial failure.**
  - A partial failure still let registry routing proceed.
  - Partners with stale rows were never repaired.
  - The split worker entrypoint started its AI consumers without any barrier (`apps/api/src/worker.ts`: the migration-parity wait, then `startRegisteredWorkers`).
- **Finding 8: no single run.** Replicas raced on one marker, and a partial run could clear completion.
- **Finding 10: boot time.** An unbounded sweep before `serve()` exceeds prod's 40 s health grace (`deploy/docker-compose.prod.yml` `start_period: 40s` on `/health`).

**Design** (it replaces W02 handoff item 1; see "Required W02 plan changes"):
- **Per-partner durable record.** The table is `ai_model_registry_partner_cutover (partner_id PK → partners ON DELETE CASCADE, cutover_at)`, partner-axis (shape 3). `cutoverPartner(partnerId)` runs in ONE system transaction:
  1. take W02's per-partner reconcile advisory lock;
  2. if the row exists, return `already`;
  3. otherwise run `reconcilePartnerFromLegacyInTx(partnerId)` and insert the row, so both commit or neither does.
  
  A partner is reconciled at most once, ever, whoever gets there first.
- **The gate is in the resolver, not in boot.** `resolveModel` calls `ensurePartnerCutover(partnerId)` first (memoized per process).
  - No row → `cutoverPartner` now: one partner, bounded.
  - Failure → `resolveModel` returns `ok:false, reason:'registry_unavailable', recoverable:true`, so nothing dispatches on a stale registry.
  
  Every entrypoint (API, split worker, any future consumer) dispatches through `resolveModel`, so all of them are gated without a boot barrier.
- **Background sweep, single coordinator.** `runRegistryCutoverSweep()` starts **after** `serve()` in `index.ts` and after `startRegisteredWorkers` in `worker.ts`.
  - It takes a lease on the singleton `ai_model_registry_state` (`UPDATE … WHERE lease_expires_at < now() OR lease_owner = me RETURNING`). It renews the lease every partner and stops if the lease is lost.
  - It walks partners **without** a cutover row in id order, in batches, calling `cutoverPartner`. Crash or restart resumes naturally, because the anti-join *is* the cursor.
  - When no partner is left, it sets `cutover_completed_at = COALESCE(cutover_completed_at, now())`. Completion is monotonic, never cleared.
  - Failures stay unrowed, and the next sweep (or the partner's next request) retries them.
- Liveness (`/health`) is never blocked. Each AI request costs at most one partner's reconcile, once.

**Files:**
- Create: `apps/api/migrations/2026-11-19-100400-ai-model-registry-cutover.sql` (singleton state table + the partner table with its RLS)
- Create: `apps/api/src/db/schema/aiModelRegistryCutover.ts` (+ export from `db/schema/index.ts`)
- Create: `apps/api/src/services/aiModels/registryCutover.ts`, `apps/api/src/services/aiModels/registryCutover.test.ts`
- Create: `apps/api/src/__tests__/integration/aiModelRegistryCutover.integration.test.ts`
- Modify: `apps/api/src/index.ts` (delete W02's detached `reconcileAllPartnersFromLegacy()` block; start `runRegistryCutoverSweep()` detached **after** `serve()`)
- Modify: `apps/api/src/worker.ts` (start the same detached sweep after `startRegisteredWorkers`)
- Modify: `apps/api/src/services/aiModels/resolveModel.ts` (+ test) (the gate; `ResolveFailureReason` gains `'registry_unavailable'`)
- Modify: `apps/api/src/services/aiModels/eligibility.ts` (add `'registry_unavailable'` to `ResolveFailureReason`), `resolveModel.ts` `unavailableMessage`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (singleton → system allowlist; partner table → `PARTNER_TENANT_TABLES`)

**Interfaces:**
- Consumes: P12 `reconcilePartnerFromLegacyInTx(partnerId)` (needs a held system context; takes `pg_advisory_xact_lock(hashtextextended('ai_model_registry_reconcile:' || partner_id, 0))` and joins the caller's transaction).
- Produces:
  ```ts
  export type PartnerCutoverResult = 'done' | 'already';
  export function cutoverPartner(partnerId: string, deps?: { reconcileInTx?: typeof reconcilePartnerFromLegacyInTx }): Promise<PartnerCutoverResult>;
  export function ensurePartnerCutover(partnerId: string): Promise<boolean>;   // false = could not cut over (caller refuses)
  export function runRegistryCutoverSweep(opts?: { owner?: string; leaseMs?: number; batch?: number; deps?: { cutover?: typeof cutoverPartner } }):
    Promise<{ outcome: 'not_coordinator' | 'complete' | 'incomplete'; processed: number; failed: string[] }>;
  export function isPartnerCutOver(partnerId: string): Promise<boolean>;     // Task 6B's facade gate
  export function __resetRegistryCutoverMemoForTests(): void;
  // ResolveFailureReason gains 'registry_unavailable'
  ```

- [ ] **Step 1: Write the failing unit tests**

```ts
// apps/api/src/services/aiModels/registryCutover.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  rows: new Set<string>(),
  pending: [] as string[],
  lease: { owner: null as string | null, expired: true },
  completedAt: null as Date | null,
  reconcile: vi.fn(),
  capture: vi.fn(),
}));
// A tiny in-memory stand-in for the two tables; registryCutover.ts reaches them only
// through the helpers below, which it imports from './registryCutoverStore'.
vi.mock('./registryCutoverStore', () => ({
  withPartnerCutoverTx: async (partnerId: string, fn: (exists: boolean) => Promise<void>) => {
    const exists = m.rows.has(partnerId);
    await fn(exists);
    if (!exists) m.rows.add(partnerId);
  },
  hasCutoverRow: async (id: string) => m.rows.has(id),
  takeLease: async (owner: string) => {
    if (m.completedAt) return 'complete';
    if (m.lease.owner && m.lease.owner !== owner && !m.lease.expired) return 'held';
    m.lease = { owner, expired: false };
    return 'taken';
  },
  renewLease: async (owner: string) => m.lease.owner === owner,
  nextUncutPartners: async (after: string | null, limit: number) =>
    m.pending.filter((p) => !m.rows.has(p) && (after === null || p > after)).slice(0, limit),
  markComplete: async () => { m.completedAt ??= new Date(); },
  releaseLease: async () => { m.lease = { owner: null, expired: true }; },
}));
vi.mock('../sentry', () => ({ captureException: m.capture }));
vi.mock('./legacyReconcile', () => ({ reconcilePartnerFromLegacyInTx: m.reconcile }));

import { __resetRegistryCutoverMemoForTests, cutoverPartner, ensurePartnerCutover, runRegistryCutoverSweep } from './registryCutover';

beforeEach(() => {
  vi.clearAllMocks();
  m.rows = new Set(); m.pending = []; m.lease = { owner: null, expired: true }; m.completedAt = null;
  m.reconcile.mockResolvedValue({});
  __resetRegistryCutoverMemoForTests();
});

describe('cutoverPartner', () => {
  it('reconciles a partner exactly once, ever', async () => {
    expect(await cutoverPartner('p1')).toBe('done');
    expect(await cutoverPartner('p1')).toBe('already');
    expect(m.reconcile).toHaveBeenCalledTimes(1);
  });
});

describe('ensurePartnerCutover (the resolver gate)', () => {
  it('cuts an un-reconciled partner over on demand, then serves from memo', async () => {
    expect(await ensurePartnerCutover('p1')).toBe(true);
    expect(await ensurePartnerCutover('p1')).toBe(true);
    expect(m.reconcile).toHaveBeenCalledTimes(1);
  });
  it('a failing reconcile refuses (never routes on a stale registry) and is retried next time', async () => {
    m.reconcile.mockRejectedValueOnce(new Error('boom'));
    expect(await ensurePartnerCutover('p1')).toBe(false);
    expect(await ensurePartnerCutover('p1')).toBe(true);
  });
});

describe('runRegistryCutoverSweep', () => {
  it('a second concurrent sweep is not the coordinator', async () => {
    m.pending = ['a', 'b'];
    m.lease = { owner: 'other', expired: false };
    expect((await runRegistryCutoverSweep({ owner: 'me' })).outcome).toBe('not_coordinator');
    expect(m.reconcile).not.toHaveBeenCalled();
  });
  it('processes every un-cut partner, completes monotonically, and a later run is a no-op', async () => {
    m.pending = ['a', 'b', 'c'];
    m.rows.add('b');                                   // cut over on demand earlier
    const first = await runRegistryCutoverSweep({ owner: 'me', batch: 2 });
    expect(first).toMatchObject({ outcome: 'complete', processed: 2, failed: [] });
    const completedAt = m.completedAt;
    expect((await runRegistryCutoverSweep({ owner: 'me' })).outcome).toBe('complete');
    expect(m.completedAt).toBe(completedAt);
    expect(m.reconcile).toHaveBeenCalledTimes(2);
  });
  it('a failure leaves completion unset and the partner un-rowed for retry', async () => {
    m.pending = ['a', 'b'];
    m.reconcile.mockImplementation(async (id: string) => { if (id === 'b') throw new Error('x'); return {}; });
    expect(await runRegistryCutoverSweep({ owner: 'me' })).toMatchObject({ outcome: 'incomplete', failed: ['b'] });
    expect(m.completedAt).toBeNull();
    expect(m.rows.has('b')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/registryCutover.test.ts`
Expected: FAIL with `Failed to resolve import "./registryCutover"`.

- [ ] **Step 3: Migration, schema and RLS registrations**

```sql
-- apps/api/migrations/2026-11-19-100400-ai-model-registry-cutover.sql
-- AI model registry W03 (#7601): per-partner, durable legacy → registry
-- cutover. A partner is projected from legacy config EXACTLY ONCE (the row is
-- inserted in the same transaction as W02's reconcile); afterwards the
-- registry is the authority (Task 6B). The singleton holds the background
-- sweep's coordinator lease and monotonic completion stamp (system table,
-- no tenant column → no RLS, like llm_provider_catalog). The partner table is
-- partner-axis (shape 3): forced RLS, system OR breeze_has_partner_access.
-- The only row write elects system scope first. Idempotent.
CREATE TABLE IF NOT EXISTS ai_model_registry_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cutover_completed_at timestamptz NULL,
  lease_owner text NULL,
  lease_expires_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_model_registry_partner_cutover (
  partner_id uuid PRIMARY KEY REFERENCES partners(id) ON DELETE CASCADE,
  cutover_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ai_model_registry_partner_cutover ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_model_registry_partner_cutover FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_model_registry_partner_cutover'
                 AND policyname = 'ai_model_registry_partner_cutover_access') THEN
    CREATE POLICY ai_model_registry_partner_cutover_access ON ai_model_registry_partner_cutover
      FOR ALL
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system');
  END IF;
END $$;

DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  INSERT INTO ai_model_registry_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'created the ai_model_registry_state singleton'; END IF;
END $$;
```

> Copy the policy-helper names and the `GRANT` lines from an existing partner-axis migration (e.g. W02's `partner_ai_connections` migration), so `breeze_app` gets `SELECT, INSERT` here and `SELECT, UPDATE` on the singleton.

Drizzle tables go in `apps/api/src/db/schema/aiModelRegistryCutover.ts`:
- `aiModelRegistryState`, with columns `id`, `cutoverCompletedAt`, `leaseOwner`, `leaseExpiresAt`, `updatedAt`;
- `aiModelRegistryPartnerCutover`, with columns `partnerId` (FK to `partners.id`, `onDelete: 'cascade'`) and `cutoverAt`.

In `rls-coverage.integration.test.ts`:
- add `'ai_model_registry_state'` to the system-table allowlist, with comment `// W03 cutover coordinator: one row, no tenant column (#7601).`;
- add `'ai_model_registry_partner_cutover'` to `PARTNER_TENANT_TABLES`.

The partner table has no `org_id`, so no org cascade, merge or export list applies. Partner deletion cascades through the FK.

- [ ] **Step 4: Implement the store and `registryCutover.ts`**

`registryCutoverStore.ts` holds the SQL: one function per step the unit test mocks. `withPartnerCutoverTx` is the load-bearing one:

```ts
// apps/api/src/services/aiModels/registryCutoverStore.ts
import { and, asc, eq, gt, notExists, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiModelRegistryPartnerCutover, aiModelRegistryState, partners } from '../../db/schema';

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

/** One system transaction: W02's per-partner lock → existence check → fn → row insert. */
export async function withPartnerCutoverTx(partnerId: string, fn: (exists: boolean) => Promise<void>): Promise<void> {
  await sys(async () => {
    // Same key W02's reconcile takes; xact locks are re-entrant within the session.
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'ai_model_registry_reconcile:' + partnerId}, 0))`);
    const [row] = await db.select({ id: aiModelRegistryPartnerCutover.partnerId }).from(aiModelRegistryPartnerCutover)
      .where(eq(aiModelRegistryPartnerCutover.partnerId, partnerId)).limit(1);
    await fn(Boolean(row));
    if (!row) await db.insert(aiModelRegistryPartnerCutover).values({ partnerId }).onConflictDoNothing();
  });
}

export async function hasCutoverRow(partnerId: string): Promise<boolean> {
  const [row] = await sys(() => db.select({ id: aiModelRegistryPartnerCutover.partnerId }).from(aiModelRegistryPartnerCutover)
    .where(eq(aiModelRegistryPartnerCutover.partnerId, partnerId)).limit(1));
  return Boolean(row);
}

export async function takeLease(owner: string, leaseMs: number): Promise<'taken' | 'held' | 'complete'> {
  return sys(async () => {
    const [state] = await db.select().from(aiModelRegistryState).limit(1);
    if (state?.cutoverCompletedAt) return 'complete';
    const taken = await db.execute(sql`
      UPDATE ai_model_registry_state
      SET lease_owner = ${owner}, lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000}), updated_at = now()
      WHERE id = 1 AND cutover_completed_at IS NULL
        AND (lease_expires_at IS NULL OR lease_expires_at < now() OR lease_owner = ${owner})
      RETURNING id`);
    return taken.length > 0 ? 'taken' : 'held';
  });
}

export async function renewLease(owner: string, leaseMs: number): Promise<boolean> {
  const renewed = await sys(() => db.execute(sql`
    UPDATE ai_model_registry_state SET lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000}), updated_at = now()
    WHERE id = 1 AND lease_owner = ${owner} RETURNING id`));
  return renewed.length > 0;
}

export async function nextUncutPartners(after: string | null, limit: number): Promise<string[]> {
  const rows = await sys(() => db.select({ id: partners.id }).from(partners)
    .where(and(
      after ? gt(partners.id, after) : undefined,
      notExists(db.select({ x: sql`1` }).from(aiModelRegistryPartnerCutover)
        .where(eq(aiModelRegistryPartnerCutover.partnerId, partners.id))),
    ))
    .orderBy(asc(partners.id)).limit(limit));
  return rows.map((r) => r.id);
}

export async function markComplete(owner: string): Promise<void> {
  // Monotonic: COALESCE never moves or clears an existing stamp (finding 8).
  await sys(() => db.execute(sql`
    UPDATE ai_model_registry_state SET cutover_completed_at = COALESCE(cutover_completed_at, now()),
      lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE id = 1 AND lease_owner = ${owner}`));
}

export async function releaseLease(owner: string): Promise<void> {
  await sys(() => db.execute(sql`
    UPDATE ai_model_registry_state SET lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE id = 1 AND lease_owner = ${owner}`));
}
```

```ts
// apps/api/src/services/aiModels/registryCutover.ts
/**
 * Legacy → registry cutover (W02 handoff, revised per review findings 7–10).
 * A partner is projected from legacy config EXACTLY ONCE, durably, before any
 * registry-routed dispatch for it; the resolver gates on that, so every
 * entrypoint (API, split worker) is covered without blocking boot liveness.
 */
import { randomUUID } from 'node:crypto';
import { captureException } from '../sentry';
import { reconcilePartnerFromLegacyInTx } from './legacyReconcile';
import {
  hasCutoverRow, markComplete, nextUncutPartners, releaseLease, renewLease, takeLease, withPartnerCutoverTx,
} from './registryCutoverStore';

export type PartnerCutoverResult = 'done' | 'already';

export async function cutoverPartner(
  partnerId: string,
  deps: { reconcileInTx?: typeof reconcilePartnerFromLegacyInTx } = {},
): Promise<PartnerCutoverResult> {
  let result: PartnerCutoverResult = 'already';
  await withPartnerCutoverTx(partnerId, async (exists) => {
    if (exists) return;
    await (deps.reconcileInTx ?? reconcilePartnerFromLegacyInTx)(partnerId);
    result = 'done';
  });
  return result;
}

const cutOver = new Set<string>();

export function __resetRegistryCutoverMemoForTests(): void {
  cutOver.clear();
}

export async function isPartnerCutOver(partnerId: string): Promise<boolean> {
  if (cutOver.has(partnerId)) return true;
  if (await hasCutoverRow(partnerId)) { cutOver.add(partnerId); return true; }
  return false;
}

export async function ensurePartnerCutover(partnerId: string): Promise<boolean> {
  if (await isPartnerCutOver(partnerId)) return true;
  try {
    await cutoverPartner(partnerId);
    cutOver.add(partnerId);
    return true;
  } catch (error) {
    captureException(error, undefined, { area: 'ai_model_registry_cutover', partnerId });
    return false;
  }
}

export async function runRegistryCutoverSweep(opts: {
  owner?: string; leaseMs?: number; batch?: number; deps?: { cutover?: typeof cutoverPartner };
} = {}): Promise<{ outcome: 'not_coordinator' | 'complete' | 'incomplete'; processed: number; failed: string[] }> {
  const owner = opts.owner ?? `sweep-${randomUUID()}`;
  const leaseMs = opts.leaseMs ?? 5 * 60_000;
  const batch = opts.batch ?? 50;
  const cutover = opts.deps?.cutover ?? cutoverPartner;
  const lease = await takeLease(owner, leaseMs);
  if (lease === 'complete') return { outcome: 'complete', processed: 0, failed: [] };
  if (lease === 'held') return { outcome: 'not_coordinator', processed: 0, failed: [] };
  const failed: string[] = [];
  let processed = 0;
  let after: string | null = null;
  try {
    for (;;) {
      const ids = await nextUncutPartners(after, batch);
      if (ids.length === 0) break;
      for (const partnerId of ids) {
        try {
          if ((await cutover(partnerId)) === 'done') processed += 1;
          cutOver.add(partnerId);
        } catch (error) {
          failed.push(partnerId);
          captureException(error, undefined, { area: 'ai_model_registry_cutover', partnerId });
        }
        if (!(await renewLease(owner, leaseMs))) return { outcome: 'not_coordinator', processed, failed };
        after = partnerId;
      }
    }
    if (failed.length === 0) {
      await markComplete(owner);
      return { outcome: 'complete', processed, failed };
    }
    return { outcome: 'incomplete', processed, failed };
  } finally {
    if (failed.length > 0) await releaseLease(owner);
  }
}
```

In `resolveModel.ts`, right after the `if (!input.partnerId) throw …` line:

```ts
  // Task 6A: no registry-routed dispatch for a partner that has not been cut over.
  if (!(await ensurePartnerCutover(partnerId))) return unavailable('registry_unavailable', null);
```

Add `'registry_unavailable'` to `ResolveFailureReason` and to `unavailableMessage`: `'AI configuration is being upgraded. Try again in a moment.'`. In `resolveModel.test.ts`, mock `./registryCutover` → `{ ensurePartnerCutover: vi.fn(async () => true) }`, and add one case: when it resolves `false`, the result is `{ ok: false, reason: 'registry_unavailable' }` and the loader is never called.

`apps/api/src/index.ts`: delete W02's detached `void reconcileAllPartnersFromLegacy()…` block. **After** `serve(...)`, add:

```ts
  // AI model registry W03 (#7601): cut every partner over in the background.
  // Liveness is never blocked; resolveModel cuts a partner over on demand if
  // its first AI request beats the sweep (registryCutover.ts).
  void runRegistryCutoverSweep()
    .then((r) => console.log(`[startup] AI model registry cutover sweep: ${r.outcome}, ${r.processed} partner(s), ${r.failed.length} failed`))
    .catch((err) => { console.error('[startup] AI model registry cutover sweep failed', err); captureException(err); });
```

`apps/api/src/worker.ts`: add the same detached call right after `await startRegisteredWorkers('worker', …)`. The lease makes a second process a no-op, and the resolver gate covers any job that runs before the sweep reaches its partner.

- [ ] **Step 5: Write the integration test (real Postgres, real W02 reconcile)**

```ts
// apps/api/src/__tests__/integration/aiModelRegistryCutover.integration.test.ts
import './setup';
import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { resolveModel } from '../../services/aiModels/resolveModel';
import {
  __resetRegistryCutoverMemoForTests, cutoverPartner, runRegistryCutoverSweep,
} from '../../services/aiModels/registryCutover';
import { createOrganization, createPartner } from './db-utils';

const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);
const resetState = () => sys(() => db.execute(sql`
  UPDATE ai_model_registry_state SET cutover_completed_at = NULL, lease_owner = NULL, lease_expires_at = NULL WHERE id = 1`));

describe('registry cutover (findings 7, 8, 10)', () => {
  it('two concurrent sweeps: exactly one coordinates; every partner is cut over exactly once', async () => {
    await resetState();
    const ps = await Promise.all(Array.from({ length: 30 }, () => createPartner()));
    const spy = vi.fn(cutoverPartner);
    const [a, b] = await Promise.all([
      runRegistryCutoverSweep({ owner: 'A', deps: { cutover: spy } }),
      runRegistryCutoverSweep({ owner: 'B', deps: { cutover: spy } }),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(['complete', 'not_coordinator']);
    const rows = await sys(() => db.execute(sql`
      SELECT partner_id FROM ai_model_registry_partner_cutover WHERE partner_id = ANY(${ps.map((p) => p.id)}::uuid[])`));
    expect(rows).toHaveLength(30);
  });

  it('an interrupted sweep resumes where it stopped (the anti-join is the cursor)', async () => {
    await resetState();
    await Promise.all(Array.from({ length: 10 }, () => createPartner()));
    let calls = 0;
    const flaky = vi.fn(async (id: string) => { calls += 1; if (calls === 4) throw new Error('crash'); return cutoverPartner(id); });
    expect((await runRegistryCutoverSweep({ owner: 'A', deps: { cutover: flaky } })).outcome).toBe('incomplete');
    expect((await runRegistryCutoverSweep({ owner: 'B' })).outcome).toBe('complete');
    const [{ completed }] = await sys(() => db.execute<{ completed: Date | null }>(sql`
      SELECT cutover_completed_at AS completed FROM ai_model_registry_state WHERE id = 1`));
    expect(completed).not.toBeNull();
  });

  it('a request for a partner the sweep has not reached cuts it over on demand, then resolves', async () => {
    __resetRegistryCutoverMemoForTests();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    expect(await resolveModel({ partnerId: partner.id, orgId: org.id, surface: 'chat' })).toMatchObject({ ok: true });
    const rows = await sys(() => db.execute(sql`SELECT 1 FROM ai_model_registry_partner_cutover WHERE partner_id = ${partner.id}::uuid`));
    expect(rows).toHaveLength(1);
  });

  it('completion is monotonic: a later incomplete sweep never clears it', async () => {
    await resetState();
    await runRegistryCutoverSweep({ owner: 'A' });
    const before = await sys(() => db.execute<{ c: Date }>(sql`SELECT cutover_completed_at AS c FROM ai_model_registry_state`));
    await runRegistryCutoverSweep({ owner: 'B', deps: { cutover: async () => { throw new Error('x'); } } });
    const after = await sys(() => db.execute<{ c: Date }>(sql`SELECT cutover_completed_at AS c FROM ai_model_registry_state`));
    expect(after[0]!.c).toEqual(before[0]!.c);
  });
});
```

> The fleet-size case (30 partners, two coordinators) is the representative concurrency check. The per-request bound is one partner's reconcile. Boot never waits on either.

- [ ] **Step 6: Run and commit**

Run: `cd apps/api && npx vitest run src/services/aiModels/registryCutover.test.ts src/services/aiModels/resolveModel.test.ts`
Expected: PASS.

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelRegistryCutover.integration.test.ts && DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage && pnpm db:check-drift`
Expected: PASS. RLS coverage fails until both tables are registered, which proves the registration landed.

```bash
git add apps/api/migrations/2026-11-19-100400-ai-model-registry-cutover.sql apps/api/src/db/schema/aiModelRegistryCutover.ts \
  apps/api/src/db/schema/index.ts apps/api/src/services/aiModels/registryCutover.ts apps/api/src/services/aiModels/registryCutoverStore.ts \
  apps/api/src/services/aiModels/registryCutover.test.ts apps/api/src/services/aiModels/resolveModel.ts \
  apps/api/src/services/aiModels/resolveModel.test.ts apps/api/src/services/aiModels/eligibility.ts \
  apps/api/src/index.ts apps/api/src/worker.ts \
  apps/api/src/__tests__/integration/aiModelRegistryCutover.integration.test.ts \
  apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(ai): per-partner durable registry cutover gated in the resolver; background coordinated sweep (#7601)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 6B: Authority flip — `/ai/provider` writes the registry; legacy mirror and re-projection removed

W02's binding handoff item 2, and review finding 9.
- **What breaks today.** After cutover, re-running W02's projection on a provider edit would:
  - reset assignment options and fallbacks;
  - delete assignment rows the projection doesn't produce;
  - rebind sessions from legacy model strings.
  
  That overwrites registry choices, e.g. a session a user created on an explicit offering (Task 9).
- **The flip.** The facade (`services/partnerLlmConfig.ts`, W02 Task 13) stops writing `partner_llm_configs` and performs **registry-native** edits. They express the same legacy semantics as id remaps, never as a re-projection.
  - **Gate first.** Every facade write calls `ensurePartnerCutover(partnerId)` (Task 6A), so a partner is never edited natively before its one projection.
  - **Connect** (first compat connection, BYOK or catalog):
    - create the connection;
    - for every model the partner's registry references through **platform** offerings (assignment defaults, permitted and fallback arrays, agent policy offerings, live session offerings), ensure a same-model offering on the new connection. BYOK offerings link the platform row; catalog offerings fail closed through eligibility if unmapped, which is legacy's behaviour;
    - remap those ids everywhere.
    
    Options, `allow_user_choice` and rows are untouched, and nothing is deleted.
  - **Rotate key / change catalog entry** (same kind): update the connection in place (`api_key_encrypted`, `key_last4`, `key_fingerprint`, `catalog_entry_id`, `config_version + 1`, `status 'active'`, `last_error NULL`), then enqueue discovery (Task 16 adds that call). No remap.
  - **Switch kind** (BYOK ↔ catalog): disconnect, then connect.
  - **Disconnect:** remap the connection's offering ids back to same-model platform offerings, creating them enabled if missing. Then delete the connection; its offerings cascade, and stale session pointers `SET NULL` and resolve to the default next turn.
  - **Change default model** (`legacy_default_model`): re-point only the **partner-level** assignment rows whose `default_offering_id` is the previous default's offering, to the new model's offering on the same connection (created if missing). Org rows are untouched; they are deliberate overrides.
- **Mirror trigger.** `partner_llm_configs_mirror_to_connection` is dropped in the same change: nothing writes the legacy table any more.
- **Legacy-table readers move to the compat connection.** `resolveLlmConfig`'s `readPartnerLlmConfig` and `llmUnusableCodeForOrgInSystemContext` read through W02's `getCompatConnection` / `getConnectionKeyMaterial` (both still serve the env-OpenAI and readiness paths). `markPartnerLlmError` updates the connection (`status='error'`, `last_error`, matching `id` + `config_version`).

**Files:**
- Create: `apps/api/migrations/2026-11-19-100500-drop-partner-llm-configs-mirror-trigger.sql`
- Create: `apps/api/src/services/aiModels/compatRemap.ts`, `apps/api/src/services/aiModels/compatRemap.test.ts`
- Modify: `apps/api/src/services/partnerLlmConfig.ts` (+ `partnerLlmConfig.test.ts`) (facade writes)
- Modify: `apps/api/src/services/llm/llmConfigResolver.ts` (+ test) (`readPartnerLlmConfig`, `llmUnusableCodeForOrgInSystemContext`, `markPartnerLlmError`)
- Create: `apps/api/src/__tests__/integration/aiProviderAuthority.integration.test.ts`

**Interfaces:**
- Consumes: Task 6A `ensurePartnerCutover`; P7 `createConnection`, `getCompatConnection`, `getConnectionKeyMaterial`, `encryptConnectionKey`.
- Produces:
  ```ts
  // compatRemap.ts (all inside a held system transaction)
  export async function remapPartnerOfferings(partnerId: string, mapping: ReadonlyMap<string, string>): Promise<{ assignments: number; agents: number; sessions: number; offerings: number }>;
  export async function ensureSameModelOfferings(partnerId: string, from: { connectionId: string | null }, to: { connectionId: string | null }): Promise<Map<string, string>>;
  export async function connectCompat(partnerId: string, input: { kind: 'anthropic_byok' | 'catalog'; apiKey: string; catalogEntryId: string | null; connectedBy: string | null; defaultModel: string | null }): Promise<string>;
  export async function disconnectCompat(partnerId: string): Promise<void>;
  export async function changeCompatDefaultModel(partnerId: string, modelId: string | null): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/__tests__/integration/aiProviderAuthority.integration.test.ts
import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { deletePartnerLlmConfig, savePartnerLlmKey } from '../../services/partnerLlmConfig';
import { seedRegistryPartner } from './helpers/aiModelRegistrySeed';

const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

describe('authority flip (finding 9): /ai/provider edits the registry, never re-projects it', () => {
  it('connecting a BYOK key moves platform references to the key but keeps options, rows and explicit choices', async () => {
    const s = await seedRegistryPartner('platform');
    await sys(() => db.execute(sql`UPDATE ai_model_assignments SET options = '{"effort":"low"}'::jsonb
      WHERE partner_id = ${s.partnerId}::uuid AND surface = 'catalog_enrichment'`));
    const before = await sys(() => db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ai_model_assignments WHERE partner_id = ${s.partnerId}::uuid`));
    await savePartnerLlmKey(s.partnerId, 'sk-ant-test', { probe: false });   // the facade's probe is stubbed in this suite
    const [row] = await sys(() => db.execute<{ options: unknown; conn: string | null }>(sql`
      SELECT a.options, o.connection_id AS conn FROM ai_model_assignments a
      JOIN partner_ai_models o ON o.id = a.default_offering_id
      WHERE a.partner_id = ${s.partnerId}::uuid AND a.surface = 'catalog_enrichment'`));
    expect(row!.options).toEqual({ effort: 'low' });
    expect(row!.conn).not.toBeNull();
    const after = await sys(() => db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ai_model_assignments WHERE partner_id = ${s.partnerId}::uuid`));
    expect(after[0]!.n).toBe(before[0]!.n);
    const legacy = await sys(() => db.execute(sql`SELECT 1 FROM partner_llm_configs WHERE partner_id = ${s.partnerId}::uuid`));
    expect(legacy).toHaveLength(0);   // the legacy table is no longer written
  });

  it('disconnecting returns references to platform offerings and deletes the connection', async () => {
    const s = await seedRegistryPartner('byok');
    await deletePartnerLlmConfig(s.partnerId);
    const conns = await sys(() => db.execute(sql`SELECT 1 FROM partner_ai_connections WHERE partner_id = ${s.partnerId}::uuid`));
    expect(conns).toHaveLength(0);
    const [d] = await sys(() => db.execute<{ conn: string | null }>(sql`
      SELECT o.connection_id AS conn FROM ai_model_assignments a JOIN partner_ai_models o ON o.id = a.default_offering_id
      WHERE a.partner_id = ${s.partnerId}::uuid AND a.surface = 'chat'`));
    expect(d!.conn).toBeNull();
  });

  it('the legacy mirror trigger is gone', async () => {
    const t = await sys(() => db.execute(sql`SELECT 1 FROM pg_trigger WHERE tgname = 'partner_llm_configs_mirror_to_connection'`));
    expect(t).toHaveLength(0);
  });
});
```

> `savePartnerLlmKey`'s real signature and probe seam come from W02 Task 13. Stub the probe exactly the way W02's `aiModelRegistryReconcile.integration.test.ts` does.

`compatRemap.test.ts` (unit, mocked `db.execute`) pins the remap SQL touches exactly:
- `ai_model_assignments.default_offering_id`, `permitted_offering_ids` and `fallback_offering_ids` (`array_replace`);
- `ai_agents.offering_id`;
- `ai_sessions.offering_id` (status `active` only);
- `partner_ai_models.refusal_fallback_offering_id`.

It also asserts the remap **never** issues a `DELETE` on assignments or touches `options` / `allow_user_choice`.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/compatRemap.test.ts && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiProviderAuthority.integration.test.ts`
Expected: FAIL. `./compatRemap` is missing, and the facade still writes `partner_llm_configs` and re-projects.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/aiModels/compatRemap.ts — the remap core (callers hold a system transaction)
import { sql } from 'drizzle-orm';
import { db } from '../../db';

export async function remapPartnerOfferings(
  partnerId: string,
  mapping: ReadonlyMap<string, string>,
): Promise<{ assignments: number; agents: number; sessions: number; offerings: number }> {
  let assignments = 0, agents = 0, sessions = 0, offerings = 0;
  for (const [from, to] of mapping) {
    assignments += (await db.execute(sql`
      UPDATE ai_model_assignments SET
        default_offering_id = CASE WHEN default_offering_id = ${from}::uuid THEN ${to}::uuid ELSE default_offering_id END,
        permitted_offering_ids = array_replace(permitted_offering_ids, ${from}::uuid, ${to}::uuid),
        fallback_offering_ids = array_replace(fallback_offering_ids, ${from}::uuid, ${to}::uuid),
        updated_at = now()
      WHERE offering_partner_id = ${partnerId}::uuid
        AND (default_offering_id = ${from}::uuid OR ${from}::uuid = ANY(permitted_offering_ids) OR ${from}::uuid = ANY(fallback_offering_ids))
      RETURNING id`)).length;
    agents += (await db.execute(sql`
      UPDATE ai_agents SET offering_id = ${to}::uuid, updated_at = now()
      WHERE offering_partner_id = ${partnerId}::uuid AND offering_id = ${from}::uuid RETURNING id`)).length;
    sessions += (await db.execute(sql`
      UPDATE ai_sessions SET offering_id = ${to}::uuid, updated_at = now()
      WHERE offering_partner_id = ${partnerId}::uuid AND offering_id = ${from}::uuid AND status = 'active' RETURNING id`)).length;
    offerings += (await db.execute(sql`
      UPDATE partner_ai_models SET refusal_fallback_offering_id = ${to}::uuid
      WHERE partner_id = ${partnerId}::uuid AND refusal_fallback_offering_id = ${from}::uuid RETURNING id`)).length;
  }
  return { assignments, agents, sessions, offerings };
}
```

`ensureSameModelOfferings(partnerId, from, to)`:
- selects every offering on `from` that is referenced (assignment default/permitted/fallback, agent offering, active session offering);
- for each, finds or creates the offering with the same logical model on `to`, created **enabled**:
  - to platform: `source 'platform'`, `platform_model_id` by model id;
  - to BYOK: `source 'discovered'`, linked `platform_model_id`, `model_id`;
  - to catalog: `source 'catalog'`, `model_id`;
- returns the `from → to` id map.

The three entry points compose these inside one `runOutsideDbContext(() => withSystemDbAccessContext(…))` transaction:
- `connectCompat`: `createConnection` → `ensureSameModelOfferings(partner, { connectionId: null }, { connectionId })` → `remapPartnerOfferings`. If `defaultModel` is set, also `changeCompatDefaultModel`.
- `disconnectCompat`: `ensureSameModelOfferings(partner, { connectionId }, { connectionId: null })` → `remapPartnerOfferings` → `DELETE FROM partner_ai_connections WHERE id = $connectionId`.
- `changeCompatDefaultModel`: updates `legacy_default_model`, then re-points the partner-level rows (`org_id IS NULL`) whose `default_offering_id` is the old default's offering.

The facade (`partnerLlmConfig.ts`) keeps its exported names and route contract, and every write becomes:

```ts
  if (!(await ensurePartnerCutover(partnerId))) throw new PartnerLlmError('AI configuration is being upgraded. Try again in a moment.', 503);
  // probe exactly as today (outside any transaction), then ONE of:
  //   no compat connection → connectCompat(...)
  //   same kind            → rotate in place (W02 connections service) + enqueueConnectionSync
  //   different kind       → disconnectCompat + connectCompat
  //   default-model edit   → changeCompatDefaultModel
  //   delete               → disconnectCompat
  // and NO partner_llm_configs write, NO reconcilePartnerFromLegacyInTx call.
```

`llmConfigResolver.ts`:
- `readPartnerLlmConfig(partnerId)` reads `getCompatConnection(partnerId)` + `getConnectionKeyMaterial(id)` and maps them to the old row shape (`{ id, partnerId, apiKeyEncrypted, defaultModel: legacyDefaultModel, catalogEntryId, status, configVersion }`). `decryptPartnerLlmApiKey` becomes `decryptConnectionKey` (same AAD tag, W02 P7).
- `llmUnusableCodeForOrgInSystemContext` does the same.
- `markPartnerLlmError` updates `partner_ai_connections` (`status='error'`, `last_error`, `updated_at`) `WHERE id = configId AND config_version = configVersion`.

```sql
-- apps/api/migrations/2026-11-19-100500-drop-partner-llm-configs-mirror-trigger.sql
-- AI model registry W03 (#7601), W02 handoff item 2: the /ai/provider facade
-- now writes the registry directly and nothing writes partner_llm_configs, so
-- the legacy → connection mirror is removed. The table itself stays (read by
-- nothing in W03) and is dropped in W08. DDL only. Idempotent.
DROP TRIGGER IF EXISTS partner_llm_configs_mirror_to_connection ON public.partner_llm_configs;
DROP FUNCTION IF EXISTS public.partner_llm_configs_mirror_to_connection();
```

- [ ] **Step 4: Run and commit**

Run: `cd apps/api && npx vitest run src/services/aiModels/compatRemap.test.ts src/services/partnerLlmConfig.test.ts src/services/llm/llmConfigResolver.test.ts src/routes/aiProvider`
Expected: PASS. `routes/aiProvider.test.ts` mocks the facade and stays green unmodified.

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiProviderAuthority.integration.test.ts src/__tests__/integration/aiModelRegistryReconcile.integration.test.ts src/__tests__/integration/llmCatalogSelection.integration.test.ts`
Expected: PASS. Update W02's reconcile suite's facade round-trip case to the registry-native expectations: no legacy row, references remapped. Point `llmCatalogSelection`'s seeding at `createConnection` instead of `partner_llm_configs`.

```bash
git add apps/api/migrations/2026-11-19-100500-drop-partner-llm-configs-mirror-trigger.sql \
  apps/api/src/services/aiModels/compatRemap.ts apps/api/src/services/aiModels/compatRemap.test.ts \
  apps/api/src/services/partnerLlmConfig.ts apps/api/src/services/partnerLlmConfig.test.ts \
  apps/api/src/services/llm/llmConfigResolver.ts apps/api/src/services/llm/llmConfigResolver.test.ts \
  apps/api/src/__tests__/integration/aiProviderAuthority.integration.test.ts \
  apps/api/src/__tests__/integration/aiModelRegistryReconcile.integration.test.ts \
  apps/api/src/__tests__/integration/llmCatalogSelection.integration.test.ts
git commit -m "feat(ai): authority flip — /ai/provider edits the registry natively; legacy mirror removed (#7601)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 7: Agent SDK session surfaces — chat, topology, helper, script builder, Office chat — dispatch through `resolveModel`

These five surfaces share one seam: `streamingSessionManager.getOrCreate` → `query()` → the `result` case. That makes them a tight group, because changing the seam's input type would break all five callers in the same commit. This task:
- **Turn resolution.** Every turn resolves `resolveSessionTurn` (spec §9: re-checked at every dispatch). The stored `ai_sessions.offering_id` / `options` are the `session`-origin request, so the bounded fallback applies.
- **Admission.** Budget checks and the reservation take `resolved.funding` and the turn binding (Task 6) **before** dispatch.
- **Seam input.** `getOrCreate` receives the `ResolvedModel`:
  - the SDK child env is built from `resolved.connection.config`;
  - the model params come from `sdkModelOptions`;
  - the system prompt passes through `applyPromptProfile`;
  - a live query is reused only on an equal `liveQueryKey` (§9.2 bullet 2).
- **The `result` case** settles through `settleInvocation`. The Office per-user hook (`recordExtraUsage`) and the `done` event's `usage.costCents` read the **registry** price. This removes the Office SDK-cost path (`streamingSessionManager.ts` ~:1916, quorum #5).
- **Deletions.** `resolveWireModel`, `llmConfigSnapshot`, `catalogPricing` and the SDK-preferred cost leave the manager entirely.

Session **creation** for these surfaces is Task 9. Refusal **surfacing** is Task 8; this task already records refusal fields on the ledger.

The deployment-wide env `MCP_LLM_PROVIDER=openai-compatible` chat path stays on its legacy resolution, unchanged (W06 absorbs it). It is the only `resolveLlmConfigForOrg` caller left in these routes.

**Files:**
- Create: `apps/api/src/services/aiModels/sessionModel.ts` (turn half; Task 9 adds the create half), `apps/api/src/services/aiModels/sessionModel.test.ts`
- Create: `apps/api/src/services/aiModels/__fixtures__/resolvedModel.ts` (shared test builder for Tasks 7–14)
- Create: `apps/api/src/services/streamingSessionManager.modelBinding.test.ts`
- Create: `apps/api/src/routes/ai.modelResolution.test.ts`
- Create: `apps/api/src/services/aiModels/parity/registrySnapshotDeps.ts`, `apps/api/src/services/aiModels/parity/w03Surfaces.parity.test.ts`
- Modify: `apps/api/src/services/aiModels/parity/w03Parity.ts` (append `toSurfaceUse`, `assertSurfaceParity`)
- Modify: `apps/api/src/services/streamingSessionManager.ts` (`ActiveSession` ~L495, `tryTransitionToProcessing` ~L842, `getOrCreate` ~L875–1330, `system` case ~L1575, `result` case ~L1830–2016, abandoned-turn `finally` ~L2040–2125)
- Modify: `apps/api/src/services/aiAgentSdk.ts` (`runPreFlightChecks` ~L384, `PreFlightResult` ~L365)
- Modify: `apps/api/src/routes/ai.ts` (`topologyProviderRevision` ~L135, the preflight destructure ~L752, the OpenAI branch guard ~L796, the SDK branch ~L956–1020)
- Modify: `apps/api/src/routes/helper/index.ts` (`runHelperPreFlight` ~L160–200, message route ~L405–460)
- Modify: `apps/api/src/routes/scriptAi.ts` (message route ~L250–320)
- Modify: `apps/api/src/routes/clientAi/sessions.ts` (`runClientPreflight` ~L153, `ensureActiveClientSession` ~L177, message route ~L604–725)
- Modify: the existing manager/route tests that construct `UsableLlmConfig` literals or mock `recordUsageFromSdkResult` (listed in Step 9)

**Interfaces:**
- Consumes: Task 3 `resolveModel`, `ResolvedModel`; Task 4 `sdkModelOptions`, `turnBindingFrom`, `liveQueryKey`, `TurnBinding`, `describeDispatch`; Task 5 `sdkTurnUsage`, `observeSdkMessage`, `newSdkTurnObservation`, `SdkTurnObservation`; Task 6 `settleInvocation`, `priceUsage`, `sumCostCents`, `reserveAiBudget({ binding })`; Task 2 `readOrgPartnerId`, `applyPromptProfile`.
- Produces:
  ```ts
  // sessionModel.ts
  export async function resolveSessionTurn(input: {
    sessionId: string; surface: AiSurface; userId: string | null; maxTokens?: number; transport?: DispatchTransport;
  }): Promise<ResolveModelResult>;

  // streamingSessionManager.ts
  getOrCreate(
    breezeSessionId: string,
    dbSession: { orgId; sdkSessionId; maxTurns; turnCount; systemPrompt; deviceId?; writeDefaultOrgId? },  // `model` removed
    auth: AuthContext,
    requestContext: RequestLike | undefined,
    systemPrompt: string,
    maxBudgetUsd: number | undefined,
    resolved: ResolvedModel,                       // was UsableLlmConfig
    allowedTools?: string[],
    mcpServerFactory?: …,
    options?: { injectApprovalModeInstructions?; budgetReservationId?; topologyInvestigation?; toolSearch?;
                ledgerUserId?: string | null },      // NEW: the Breeze users.id the ledger attributes turns to
  ): Promise<ActiveSession>;
  tryTransitionToProcessing(session, budgetReservationId?, turn?: { topologyInvestigation?; turnBinding?: TurnBinding }): boolean;
  interface ActiveSession { /* model, llmConfigSnapshot, catalogPricing REMOVED */
    readonly liveKey: string; turnBinding: TurnBinding; readonly ledgerUserId: string | null;
    refusalObservation: SdkTurnObservation; forceRecreate: boolean; }

  // aiAgentSdk.ts
  type PreFlightResult =
    | { ok: true; session; sanitizedContent; systemPrompt; maxBudgetUsd;
        model: ResolvedModel | null;               // null only on the env OpenAI-compatible path
        openaiCompatible: boolean }
    | { ok: false; error: string; status?: number; code?: ResolveFailureReason };

  // __fixtures__/resolvedModel.ts
  export const FIXTURE_STD_RATES: ModelRates;
  export function makeResolvedModel(kind?: 'platform' | 'anthropic_byok' | 'catalog', over?: Partial<ResolvedModel>): ResolvedModel;
  ```

- [ ] **Step 1: Create the shared fixture and the `resolveSessionTurn` test**

```ts
// apps/api/src/services/aiModels/__fixtures__/resolvedModel.ts
import type { ModelRates } from '@breeze/shared';
import type { ResolvedModel } from '../resolveModel';

export const FIXTURE_STD_RATES: ModelRates = {
  inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250,
};

/** One ResolvedModel per connection kind, for surface tests (Tasks 7–14). */
export function makeResolvedModel(
  kind: 'platform' | 'anthropic_byok' | 'catalog' = 'platform',
  over: Partial<ResolvedModel> = {},
): ResolvedModel {
  const config = kind === 'platform'
    ? { source: 'platform' as const, apiKey: 'sk-platform', model: 'claude-sonnet-5-5' }
    : {
        source: 'partner' as const, partnerId: 'partner-1', apiKey: 'sk-partner', model: 'claude-sonnet-5-5',
        configId: 'conn-1', configVersion: 2,
        endpoint: kind === 'catalog'
          ? {
              kind: 'catalog' as const, catalogEntryId: 'cat-1', revisionId: 'rev-1', baseUrl: 'https://gw.example.com',
              authMode: 'bearer' as const, providerModel: 'anthropic/claude-sonnet-5.5',
              pricing: { catalogEntryId: 'cat-1', revisionId: 'rev-1', ...FIXTURE_STD_RATES }, models: {},
            }
          : { kind: 'anthropic' as const },
      };
  return {
    ok: true, surface: 'chat', role: 'default', transport: 'agent_sdk', partnerId: 'partner-1', orgId: 'org-1',
    offering: { id: 'off-1', displayName: 'Sonnet 5.5' },
    connection: { id: kind === 'platform' ? null : 'conn-1', kind, config },
    funding: kind === 'platform' ? 'platform' : 'partner_key',
    logicalModel: 'claude-sonnet-5-5',
    wireModel: kind === 'catalog' ? 'anthropic/claude-sonnet-5.5' : 'claude-sonnet-5-5',
    thinking: 'adaptive',
    wireParams: { thinking: { type: 'adaptive' }, effort: 'medium', betas: [], applied: { effort: 'medium' } },
    options: { effort: 'medium' }, inferenceGeo: null, promptProfile: 'claude-standard',
    rateSnapshot: { source: kind === 'platform' ? 'platform' : kind === 'catalog' ? 'catalog' : 'linked_platform', standard: FIXTURE_STD_RATES },
    capabilities: { thinkingMode: 'adaptive', effortLevels: ['low', 'medium', 'high'], supportsTools: true, supportsVision: false },
    limits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
    ...(kind === 'platform' ? {} : { configVersion: 2 }),
    ...(kind === 'catalog' ? { catalogRevisionId: 'rev-1' } : {}),
    fellBack: false,
    ...over,
  } as ResolvedModel;
}
```

```ts
// apps/api/src/services/aiModels/sessionModel.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ resolveModel: vi.fn(), readOrgPartnerId: vi.fn(), readSessionModelRow: vi.fn() }));
vi.mock('./resolveModel', async (orig) => ({ ...(await orig<typeof import('./resolveModel')>()), resolveModel: m.resolveModel }));
vi.mock('./candidateLoader', () => ({ readOrgPartnerId: m.readOrgPartnerId, readSessionModelRow: m.readSessionModelRow }));

import { resolveSessionTurn } from './sessionModel';

beforeEach(() => {
  vi.clearAllMocks();
  m.readOrgPartnerId.mockResolvedValue('partner-1');
  m.resolveModel.mockResolvedValue({ ok: true });
});

describe('resolveSessionTurn', () => {
  it('re-resolves the stored offering + options as a session-origin request (bounded fallback applies)', async () => {
    m.readSessionModelRow.mockResolvedValue({ orgId: 'org-1', offeringId: 'off-9', options: { effort: 'high' } });
    await resolveSessionTurn({ sessionId: 's1', surface: 'chat', userId: 'u1' });
    expect(m.resolveModel).toHaveBeenCalledWith({
      partnerId: 'partner-1', orgId: 'org-1', userId: 'u1', surface: 'chat',
      requested: { offeringId: 'off-9', options: { effort: 'high' }, origin: 'session' },
    });
  });

  it('a session with no stored offering resolves the effective default', async () => {
    m.readSessionModelRow.mockResolvedValue({ orgId: 'org-1', offeringId: null, options: null });
    await resolveSessionTurn({ sessionId: 's1', surface: 'helper', userId: null });
    expect(m.resolveModel).toHaveBeenCalledWith({
      partnerId: 'partner-1', orgId: 'org-1', userId: null, surface: 'helper',
    });
  });

  it('an org with no partner has no assignment to resolve', async () => {
    m.readSessionModelRow.mockResolvedValue({ orgId: 'org-1', offeringId: null, options: null });
    m.readOrgPartnerId.mockResolvedValue(null);
    expect(await resolveSessionTurn({ sessionId: 's1', surface: 'chat', userId: 'u1' }))
      .toMatchObject({ ok: false, reason: 'no_eligible_model', recoverable: true });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/sessionModel.test.ts`
Expected: FAIL with `Failed to resolve import "./sessionModel"`.

- [ ] **Step 3: Implement the turn half of `sessionModel.ts`**

```ts
// apps/api/src/services/aiModels/sessionModel.ts
/**
 * Session ⇄ model registry. A session stores the offering + options it was
 * created (or last dispatched) with; every turn re-resolves them through
 * resolveModel as a SESSION-origin request, so an offering that went
 * ineligible takes the §9.1 bounded fallback or comes back recoverable.
 */
import type { AiSurface } from '@breeze/shared';
import { readOrgPartnerId, readSessionModelRow } from './candidateLoader';
import { resolveModel, unavailableMessage, type ResolveModelResult } from './resolveModel';
import type { DispatchTransport } from './transport';

export async function resolveSessionTurn(input: {
  sessionId: string;
  surface: AiSurface;
  userId: string | null;
  maxTokens?: number;
  transport?: DispatchTransport;
}): Promise<ResolveModelResult> {
  const row = await readSessionModelRow(input.sessionId);
  if (!row) throw new Error(`AI session ${input.sessionId} not found`);
  const partnerId = await readOrgPartnerId(row.orgId);
  if (!partnerId) {
    return { ok: false, reason: 'no_eligible_model', recoverable: true, offeringId: null, message: unavailableMessage('no_eligible_model') };
  }
  const options = row.options;
  const requested = row.offeringId || options
    ? {
        ...(row.offeringId ? { offeringId: row.offeringId } : {}),
        ...(options ? { options } : {}),
        origin: 'session' as const,
      }
    : undefined;
  return resolveModel({
    partnerId,
    orgId: row.orgId,
    userId: input.userId,
    surface: input.surface,
    ...(requested ? { requested } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.transport ? { transport: input.transport } : {}),
  });
}
```

Run: `cd apps/api && npx vitest run src/services/aiModels/sessionModel.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 4: Write the failing manager tests**

```ts
// apps/api/src/services/streamingSessionManager.modelBinding.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';

const m = vi.hoisted(() => ({
  query: vi.fn(),
  settleInvocation: vi.fn(),
  lastOptions: null as null | Record<string, unknown>,
}));
vi.mock('@anthropic-ai/claude-agent-sdk', async (orig) => ({
  ...(await orig<object>()),
  query: (args: { options: Record<string, unknown> }) => { m.lastOptions = args.options; return m.query(args); },
}));
vi.mock('./aiModels/settleInvocation', async (orig) => ({
  ...(await orig<typeof import('./aiModels/settleInvocation')>()),
  settleInvocation: m.settleInvocation,
}));
vi.mock('./aiModels/connectionFactory', async (orig) => ({ ...(await orig<object>()) }));
vi.mock('./aiModels/wireParams', () => ({
  toAgentSdkOptions: () => ({ thinking: { type: 'adaptive' }, effort: 'medium' }),
  toMessagesApiParams: () => ({}),
}));
// Reuse the manager suites' standard DB / auth / tool mocks (copy the vi.mock
// block from streamingSessionManager.usage.test.ts: '../db', './aiAgent',
// './aiAgentSdk', './aiBudgetReservations', './aiCostTracker' (sumInputTokens real)).

import { StreamingSessionManager } from './streamingSessionManager';
import { liveQueryKey, turnBindingFrom } from './aiModels/turnBinding';
import { scriptedQuery, baseDbSession, baseAuth } from './__testUtils__/streamingSessionManagerHarness';

beforeEach(() => {
  vi.clearAllMocks();
  m.settleInvocation.mockResolvedValue({ costCents: 0.012, invocationIds: ['i1'], deferred: false });
});

describe('getOrCreate with a ResolvedModel', () => {
  it('builds the SDK call from the resolved model: wire model, W01 params, fallbackModel, connection env', async () => {
    m.query.mockReturnValue(scriptedQuery([]));
    const mgr = new StreamingSessionManager();
    const resolved = makeResolvedModel('anthropic_byok', {
      refusalFallback: { offeringId: 'fb', displayName: 'Haiku', wireModel: 'claude-haiku-4-5',
        wireParams: { betas: [], applied: {} }, options: {}, rateSnapshot: makeResolvedModel().rateSnapshot },
    });
    await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1, resolved, undefined, undefined, { ledgerUserId: 'u1' });
    expect(m.lastOptions).toMatchObject({
      model: 'claude-sonnet-5-5', fallbackModel: 'claude-haiku-4-5', thinking: { type: 'adaptive' }, effort: 'medium',
    });
    expect((m.lastOptions!.env as Record<string, string>).ANTHROPIC_API_KEY).toBe('sk-partner');
  });

  it('an idle live query is rotated when the live-query key moves (config_version bump)', async () => {
    m.query.mockReturnValue(scriptedQuery([]));
    const mgr = new StreamingSessionManager();
    const first = await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1, makeResolvedModel('anthropic_byok'));
    first.state = 'idle';
    const second = await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1,
      makeResolvedModel('anthropic_byok', { configVersion: 3 }));
    expect(second).not.toBe(first);
    expect(second.liveKey).toBe(liveQueryKey(turnBindingFrom(makeResolvedModel('anthropic_byok', { configVersion: 3 }))));
  });

  it('a processing live query is left alone (the route answers 409)', async () => {
    m.query.mockReturnValue(scriptedQuery([]));
    const mgr = new StreamingSessionManager();
    const first = await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1, makeResolvedModel('anthropic_byok'));
    first.state = 'processing';
    const again = await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1,
      makeResolvedModel('anthropic_byok', { configVersion: 3 }));
    expect(again).toBe(first);
  });
});

describe('result → settleInvocation (registry price only)', () => {
  it('SDK reports $9.99: settlement receives token usage and the binding, the done event quotes the registry price', async () => {
    const resolved = makeResolvedModel();
    m.query.mockReturnValue(scriptedQuery([
      { type: 'result', subtype: 'success', stop_reason: 'end_turn', total_cost_usd: 9.99, num_turns: 1,
        usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ]));
    const mgr = new StreamingSessionManager();
    const session = await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1, resolved, undefined, undefined,
      { budgetReservationId: 'r1', ledgerUserId: 'u1' });
    const events: Array<{ type: string; usage?: { costCents: number } }> = [];
    session.eventBus.subscribe((e) => events.push(e as never));
    mgr.tryTransitionToProcessing(session, 'r1', { turnBinding: turnBindingFrom(resolved) });
    await session.processorPromise;
    expect(m.settleInvocation).toHaveBeenCalledWith(expect.objectContaining({
      binding: turnBindingFrom(resolved), orgId: baseDbSession.orgId, userId: 'u1', sessionId: 's1', reservationId: 'r1',
      usage: [{ model: 'claude-sonnet-5-5', tokens: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 }, webSearchRequests: 0 }],
      outcome: expect.objectContaining({ sdkReportedCostUsd: 9.99 }),
    }));
    const done = events.find((e) => e.type === 'done' && e.usage);
    expect(done!.usage!.costCents).toBeCloseTo(0.3, 6);  // 1000×200/1e6 + 100×1000/1e6
  });

  it('Office per-user usage hook gets the registry price even when the SDK reports $0', async () => {
    const resolved = makeResolvedModel();
    m.query.mockReturnValue(scriptedQuery([
      { type: 'result', subtype: 'success', total_cost_usd: 0, num_turns: 1,
        usage: { input_tokens: 1000, output_tokens: 100 } },
    ]));
    const mgr = new StreamingSessionManager();
    const session = await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1, resolved);
    const extra = vi.fn();
    session.recordExtraUsage = extra;
    mgr.tryTransitionToProcessing(session, undefined, { turnBinding: turnBindingFrom(resolved) });
    await session.processorPromise;
    expect(extra).toHaveBeenCalledWith(expect.objectContaining({ costCents: expect.closeTo(0.3, 6) }));
  });

  it('a session-scope refusal fallback marks the live query for recreation and is billed at the fallback', async () => {
    const resolved = makeResolvedModel('platform', {
      refusalFallback: { offeringId: 'fb', displayName: 'Haiku', wireModel: 'claude-haiku-4-5',
        wireParams: { betas: [], applied: {} }, options: {}, rateSnapshot: makeResolvedModel().rateSnapshot },
    });
    m.query.mockReturnValue(scriptedQuery([
      { type: 'system', subtype: 'model_refusal_fallback', scope: 'session', fallback_model: 'claude-haiku-4-5', api_refusal_category: 'cyber' },
      { type: 'result', subtype: 'success', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1, usage: { input_tokens: 10, output_tokens: 1 } },
    ]));
    const mgr = new StreamingSessionManager();
    const session = await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1, resolved);
    mgr.tryTransitionToProcessing(session, undefined, { turnBinding: turnBindingFrom(resolved) });
    await session.processorPromise;
    expect(session.forceRecreate).toBe(true);
    expect(m.settleInvocation.mock.calls[0]![0].usage[0].model).toBe('claude-haiku-4-5');
    expect(m.settleInvocation.mock.calls[0]![0].outcome).toMatchObject({ fallbackUsed: true, refusalCategory: 'cyber' });
  });
});
```

> `__testUtils__/streamingSessionManagerHarness.ts` holds the `scriptedQuery(messages)` async-iterable fake plus `baseDbSession` / `baseAuth`, factored out of `streamingSessionManager.usage.test.ts`. If that suite already has an equivalent local helper, move it to this shared file in this step and import it from both suites.

- [ ] **Step 5: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/streamingSessionManager.modelBinding.test.ts`
Expected: FAIL. TypeScript/runtime errors show `getOrCreate` still expecting `UsableLlmConfig` (`resolved.source` is undefined on a `ResolvedModel`), and `settleInvocation` is never called.

- [ ] **Step 6: Change the manager**

`ActiveSession`: remove `model`, `llmConfigSnapshot` and `catalogPricing`, and add:

```ts
  /** Live-query identity this SDK subprocess was built with (spec §9.2). */
  readonly liveKey: string;
  /** The CURRENT turn's binding; replaced by tryTransitionToProcessing each turn. */
  turnBinding: TurnBinding;
  /** The Breeze users.id the ledger attributes turns to; null for helper / Office / system. */
  readonly ledgerUserId: string | null;
  /** Refusal events seen during the current turn (Task 5). */
  refusalObservation: SdkTurnObservation;
  /** A session-scope refusal fallback swapped this live query's model; rebuild before the next turn. */
  forceRecreate: boolean;
```

Delete `LlmConfigSnapshot`, `llmConfigSnapshot()` and `llmConfigSnapshotsMatch()`. Keep `catalogEndpointOf()` and `buildClaudeSdkChildEnv()`; they still take `UsableLlmConfig`, which is now `resolved.connection.config`.

`tryTransitionToProcessing`: widen `turn` to `{ topologyInvestigation?: TopologyTurnRuntime; turnBinding?: TurnBinding }`, and inside the success path add:

```ts
    if (turn?.turnBinding) {
      // Claim-then-attach (PR #7147 F1): only the winner binds its turn.
      session.turnBinding = turn.turnBinding;
      session.refusalObservation = newSdkTurnObservation();
    }
```

`getOrCreate`: change the `resolved` parameter type to `ResolvedModel`, drop `model` from `dbSession`, and add `ledgerUserId?: string | null` to `options`. Replace the reuse check:

```ts
    const binding = turnBindingFrom(resolved);
    const key = liveQueryKey(binding);
    const existing = this.sessions.get(breezeSessionId);
    if (existing && existing.state !== 'closed') {
      if (existing.liveKey !== key || existing.forceRecreate) {
        if (existing.state === 'processing') {
          // Rotation applies on the next turn; the route answers this message 409.
        } else if (existing.state === 'idle') {
          console.info('[StreamingSessionManager] rotating idle AI session after model/provider change', {
            breezeSessionId, from: existing.liveKey, to: key,
          });
          existing.eventBus.publish({
            type: 'error',
            message: 'AI provider configuration changed — please resend your message',
          });
          existing.eventBus.publish({ type: 'done' });
          this.remove(breezeSessionId);
        }
      }
      // … the existing `reusable` refresh block is unchanged …
```

Replace the creation block (`effectiveModel` … `const session: ActiveSession = {`):

```ts
    const session: ActiveSession = {
      breezeSessionId,
      orgId: dbSession.orgId,
      deviceId,
      liveKey: key,
      turnBinding: binding,
      ledgerUserId: options?.ledgerUserId ?? null,
      refusalObservation: newSdkTurnObservation(),
      forceRecreate: false,
      budgetReservationId: options?.budgetReservationId,
      // … every other field unchanged …
```

Every `catalogEndpointOf(resolved)` / `resolved.source === 'partner'` read in the egress-grant and provenance-stamp code (~L1194–1263) becomes `catalogEndpointOf(resolved.connection.config)` / `resolved.connection.config.source === 'partner'`.

In the `query()` call:

```ts
        const childEnv = buildClaudeSdkChildEnv(resolved.connection.config, process.env, { egressProxyUrl });
        // …
        const sdkQuery = query({
          prompt: inputController.getInputStream(),
          options: {
            systemPrompt: applyPromptProfile(binding.surface, resolved.promptProfile, effectiveSystemPrompt),
            // model, fallbackModel (refusal fallback), thinking/effort/speed — all from the resolver.
            ...sdkModelOptions(resolved),
            maxTurns,
            maxBudgetUsd,
            // … tools, allowedTools, mcpServers, includePartialMessages, abortController, env,
            //   resume, persistSession, settingSources, stderr — unchanged …
          },
        });
```

Delete W01's `...agentSdkWireOptions(wire.model)` spread (it replaced W00's `resolveModelThinking`); `sdkModelOptions` now carries those params.

In the `system` case, before the `init` branch:

```ts
            observeSdkMessage(session.refusalObservation, message);
            if (session.refusalObservation.refusalFallback) {
              // The SDK swaps a live query's model for the rest of the session on a
              // session-scope refusal fallback; our binding says otherwise. Rebuild
              // before the next turn instead of billing a model nobody bound.
              session.forceRecreate = true;
            }
```

In the `result` case, replace everything from `const usageData = {` through the two `recordUsageFromSdkResult` calls with:

```ts
            const turnToolExecutionCount = session.pendingTurnToolExecutionCount;
            session.pendingTurnToolExecutionCount = 0;
            const { usage, outcome } = sdkTurnUsage({
              binding: session.turnBinding,
              tokens: {
                input: effectiveUsage.inputTokens,
                output: effectiveUsage.outputTokens,
                cacheRead: effectiveUsage.cacheReadInputTokens,
                cacheWrite: effectiveUsage.cacheCreationInputTokens,
              },
              observation: session.refusalObservation,
              result: resultMsg,
            });
            session.refusalObservation = newSdkTurnObservation();
            // ONE cost, from the registry rate bound to this turn (quorum #5). The
            // Office per-user ledger, the `done` event and the org settlement all
            // read this number; the SDK's total_cost_usd only reaches the ledger
            // as telemetry.
            const turnCostCents = sumCostCents(priceUsage(session.turnBinding, usage));
            const turnInputTokens = effectiveUsage.inputTokens + effectiveUsage.cacheReadInputTokens
              + effectiveUsage.cacheCreationInputTokens;
            if (session.recordExtraUsage) {
              try {
                await session.recordExtraUsage({ inputTokens: turnInputTokens, outputTokens: effectiveUsage.outputTokens, costCents: turnCostCents });
              } catch (err) {
                captureException(err);
                console.error('[StreamingSessionManager] recordExtraUsage failed:', err);
              }
            }
            try {
              // Self-contexted (reservation/system transaction) — no request context needed.
              await settleInvocation({
                binding: session.turnBinding,
                orgId,
                userId: session.ledgerUserId,
                sessionId: session.breezeSessionId,
                agentRunId: null,
                sourceRef: null,
                usage,
                outcome,
                reservationId: session.budgetReservationId,
                toolExecutionCount: turnToolExecutionCount,
                turnCount: resultMsg.num_turns ?? 1,
              });
            } catch (err) {
              captureException(err);
              console.error('[StreamingSessionManager] Failed to settle turn usage:', err);
            } finally {
              session.budgetReservationId = undefined;
            }
```

Keep the existing `subtype` branching for the `error` / `done` events after this block. The `done` event's `usage.costCents` becomes `turnCostCents`.

In the abandoned-turn `finally` (~L2040–2125), replace the `recordUsageFromSdkResult(... total_cost_usd: 0 ...)` call with:

```ts
        const { usage, outcome } = sdkTurnUsage({
          binding: session.turnBinding,
          tokens: {
            input: pending.inputTokens, output: pending.outputTokens,
            cacheRead: pending.cacheReadInputTokens, cacheWrite: pending.cacheCreationInputTokens,
          },
          observation: session.refusalObservation,
          result: null,
        });
        await settleInvocation({
          binding: session.turnBinding, orgId: session.orgId, userId: session.ledgerUserId,
          sessionId: session.breezeSessionId, agentRunId: null, sourceRef: 'abandoned_turn',
          usage, outcome, reservationId: session.budgetReservationId,
        });
```

Replace the abandoned Office `calculateCostCents(session.model, …)` with `sumCostCents(priceUsage(session.turnBinding, usage))`.

New imports: `turnBindingFrom`, `liveQueryKey`, `type TurnBinding` (`./aiModels/turnBinding`); `sdkModelOptions` (`./aiModels/connectionFactory`); `sdkTurnUsage`, `observeSdkMessage`, `newSdkTurnObservation`, `type SdkTurnObservation` (`./aiModels/invocationUsage`); `settleInvocation`, `priceUsage`, `sumCostCents` (`./aiModels/settleInvocation`); `applyPromptProfile` (`./aiModels/promptProfiles`); `type ResolvedModel` (`./aiModels/resolveModel`). Remove the imports of `resolveWireModel`, `calculateCatalogCostCents`, `calculateCostCents`, `recordUsageFromSdkResult` and `CatalogPricingSnapshot`.

- [ ] **Step 7: Change `runPreFlightChecks` (chat + script builder turns)**

```ts
// apps/api/src/services/aiAgentSdk.ts — replaces the resolveLlmConfigForOrg block and the budget block
  const surface: AiSurface = session.type === 'script_builder' ? 'script_builder' : 'chat';
  let model: ResolvedModel | null = null;
  const openaiCompatible = surface === 'chat' && isOpenAICompatibleProvider();
  if (openaiCompatible) {
    // Deployment-wide env OpenAI-compatible chat (W06 replaces it). Legacy
    // resolution, unchanged: a partner config is refused here exactly as the
    // route used to refuse it.
    let legacy;
    try {
      legacy = await resolveLlmConfigForOrg(orgId);
    } catch (error) {
      captureException(error, undefined, { service: 'aiAgentSdk', orgId });
      return { ok: false, error: 'AI configuration could not be loaded. Try again.', status: 503 };
    }
    if (legacy.source !== 'platform') return { ok: false, error: 'ai_unavailable', status: 503 };
  } else {
    let turn;
    try {
      turn = await resolveSessionTurn({ sessionId, surface, userId: auth.user.id });
    } catch (error) {
      captureException(error, undefined, { service: 'aiAgentSdk', orgId });
      return { ok: false, error: 'AI configuration could not be loaded. Try again.', status: 503 };
    }
    if (!turn.ok) return { ok: false, error: turn.message, status: 409, code: turn.reason };
    model = turn;
  }
  // … rate limits unchanged …
  try {
    // Funding from the RESOLVED offering, decided before admission (quorum #4).
    // The env OpenAI-compatible path is platform-funded by construction.
    const budgetError = await checkBudget(orgId, model?.funding ?? 'platform');
    if (budgetError) return { ok: false, error: budgetError };
  } catch (err) {
    console.error('[AI-SDK] Budget check failed:', err);
    return { ok: false, error: 'Unable to verify budget. Please try again.' };
  }
```

The result is `{ ok: true, session, sanitizedContent, systemPrompt, maxBudgetUsd, model, openaiCompatible }`.

- [ ] **Step 8: Change the five routes**

**`routes/ai.ts` (chat + topology).** Replace `topologyProviderRevision`:

```ts
/** Topology answer cache key (M4 Task 3): moves whenever the dispatch identity moves. */
function topologyProviderRevision(model: ResolvedModel | null): string {
  return model ? liveQueryKey(turnBindingFrom(model)) : 'openai-compatible:chat-only';
}
```

Then make these edits:
- Destructure `const { session: dbSession, sanitizedContent, systemPrompt, model: resolvedModel, openaiCompatible } = preflight;`.
- Map `preflight.code` first in the error ladder: `if (preflight.code) return c.json({ error: err, code: preflight.code, recoverable: true }, 409);`.
- Replace the OpenAI guard `useOpenAICompatibleProvider && resolved.source === 'partner'` with `if (openaiCompatible) {` (the refusal moved into preflight). Its `billingSource` becomes the literal `'platform'`.

In the SDK branch:

```ts
    const model = resolvedModel!;            // non-null off the OpenAI path
    const binding = turnBindingFrom(model);
    let reservation;
    try {
      reservation = await reserveAiBudget({
        orgId: dbSession.orgId,
        billingSource: model.funding,
        sessionId,
        idempotencyKey: `chat:${sessionId}:${crypto.randomUUID()}`,
        binding,                              // spec §9.2: bound in the reservation transaction
      });
    } catch (err) { /* unchanged */ }
    // …
        activeSession = await streamingSessionManager.getOrCreate(
          sessionId,
          { orgId: dbSession.orgId, sdkSessionId: dbSession.sdkSessionId, maxTurns: dbSession.maxTurns,
            turnCount: dbSession.turnCount, systemPrompt: dbSession.systemPrompt, deviceId: dbSession.deviceId,
            writeDefaultOrgId: pageContextWriteDefaultOrgId(dbSession) },
          auth, c, topology ? topology.systemPrompt : systemPrompt, budgetDispatch.maxBudgetUsd,
          model,
          topology ? topology.allowedMcpTools : undefined,
          topology && topologyTurn ? topologyTurn.topologyMcpServerFactory : undefined,
          topology
            ? { budgetReservationId: budgetDispatch.reservationId, injectApprovalModeInstructions: false, ledgerUserId: auth.user.id }
            : { budgetReservationId: budgetDispatch.reservationId, toolSearch: true, ledgerUserId: auth.user.id },
        );
    // …
      if (!streamingSessionManager.tryTransitionToProcessing(activeSession, budgetDispatch.reservationId,
        { topologyInvestigation: topology?.runtime, turnBinding: binding })) {
```

**`routes/helper/index.ts`.** In `runHelperPreFlight`, replace the `resolveLlmConfig(partnerId)` block with the following, and make the budget check use `checkBudget(device.orgId, model.funding)`. Return `model` in place of `resolved`.

```ts
  let model: ResolvedModel;
  try {
    const turn = await resolveSessionTurn({ sessionId, surface: 'helper', userId: null });
    if (!turn.ok) return { ok: false, error: turn.message, status: 409 };
    model = turn;
  } catch (error) {
    captureException(error, undefined, { service: 'helperRoutes', orgId: device.orgId });
    return { ok: false, error: 'AI configuration could not be loaded. Try again.', status: 503 };
  }
```

In the message route: `reserveAiBudget({ …, billingSource: model.funding, binding: turnBindingFrom(model) })`; `getOrCreate(…, model, allowedTools, factory, { budgetReservationId, ledgerUserId: null })` with `model` removed from the `dbSession` literal; `tryTransitionToProcessing(activeSession, budgetReservationId, { turnBinding: turnBindingFrom(model) })`.

**`routes/scriptAi.ts`.** It already uses `runPreFlightChecks`. Read `preflight.model!`, and apply the same three changes as chat: reservation `billingSource: model.funding` + `binding`, `getOrCreate(..., model, ..., { budgetReservationId, ledgerUserId: auth.user.id })`, and the transition with `turnBinding`.

**`routes/clientAi/sessions.ts` (Office chat).**
- `runClientPreflight(c, auth, policy, model: ResolvedModel)` calls `checkBillingCredits(auth.orgId, model.funding)`.
- In the message route, replace `resolveClientLlmConfig(auth.orgId)` + the `unavailable` check with the following. Carry `model` in place of `resolved` through `prepared`.

```ts
      const turn = await resolveSessionTurn({ sessionId, surface: 'office_chat', userId: null });
      if (!turn.ok) return respond(c.json({ error: turn.message, code: turn.reason, recoverable: true }, 409));
```

- The reservation gets `billingSource: model.funding, binding: turnBindingFrom(model)`.
- `ensureActiveClientSession(c, sessionRow, auth, policy, model?: ResolvedModel, turnBudget?)` resolves its own turn when `model` is absent (the `/events` reattach path):

```ts
  const resolved = model ?? await (async () => {
    const turn = await resolveSessionTurn({ sessionId: sessionRow.id, surface: 'office_chat', userId: null });
    if (!turn.ok) throw new LlmUnavailableError(turn.message);
    return turn;
  })();
```

It passes `resolved` to `getOrCreate` (no `model` in the `dbSession` literal) with `{ injectApprovalModeInstructions: false, ledgerUserId: null }`, and the message route's `tryTransitionToProcessing(active, turnBudget.reservationId, { turnBinding: turnBindingFrom(model) })`.

Office is the one surface that **keeps** a live query across turns, so its reuse goes through the `liveKey` check above.

- [ ] **Step 9: Update the existing suites to the new seam**

Make these mechanical changes:
- **Manager suites.** These are `streamingSessionManager.{approvalMode,catalog,clientLoop,deviceBoundAuth,droppedToolResult,eviction,reservation,tenantTools,textSeparator,toolSearch,toolUseInput,topologyOutput,usage}.test.ts`.
  - Replace each `resolved` `UsableLlmConfig` literal with `makeResolvedModel(kind)`: platform → `'platform'`, a partner direct key → `'anthropic_byok'`, a catalog endpoint → `'catalog'`.
  - Drop `model:` from `dbSession` literals.
  - Replace `recordUsageFromSdkResult` mocks/expectations with `settleInvocation` (mock `./aiModels/settleInvocation` as in Step 4).
  - `.catalog` tests that asserted "SDK cost ignored, catalog pricing used" now assert `settleInvocation` received `binding.rateSnapshot.source === 'catalog'`.
  - `.usage` tests asserting `calculateCostCents` fallback on `total_cost_usd: 0` now assert the same registry cost for 0 and for non-zero SDK costs.
- **Route suites.** These are `routes/ai_sessions_actions.test.ts`, `ai_sessions_use_permission.test.ts`, `ai_sessions_crud.test.ts`, `helper/index.test.ts`, `scriptAi_messages_approve.test.ts` and `clientAi/sessions.messages.test.ts`.
  - `runPreFlightChecks` / resolver mocks return `{ ok: true, …, model: makeResolvedModel(), openaiCompatible: false }`.
  - Helper and Office mock `../../services/aiModels/sessionModel` → `resolveSessionTurn`.

Write the route test that pins Review Focus #1:

```ts
// apps/api/src/routes/ai.modelResolution.test.ts
// Copy the hoisted mock block from ai_sessions_actions.test.ts, then:
it('a turn whose model went ineligible returns 409 with the recoverable message and takes NO reservation', async () => {
  runPreFlightChecksMock.mockResolvedValue({
    ok: false, error: 'Model Opus 5.5 is no longer available — choose another.', status: 409, code: 'model_unavailable',
  });
  const res = await app.request(`/ai/sessions/${SESSION_ID}/messages`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ content: 'hi' }) });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: 'Model Opus 5.5 is no longer available — choose another.', code: 'model_unavailable', recoverable: true,
  });
  expect(reserveAiBudgetMock).not.toHaveBeenCalled();
});

it('the reservation carries the resolved funding and the turn binding', async () => {
  const model = makeResolvedModel('anthropic_byok');
  runPreFlightChecksMock.mockResolvedValue({ ok: true, session: dbSessionFixture, sanitizedContent: 'hi', systemPrompt: 's',
    maxBudgetUsd: undefined, model, openaiCompatible: false });
  await app.request(`/ai/sessions/${SESSION_ID}/messages`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ content: 'hi' }) });
  expect(reserveAiBudgetMock).toHaveBeenCalledWith(expect.objectContaining({
    billingSource: 'partner_key', binding: turnBindingFrom(model),
  }));
});
```

- [ ] **Step 10: Build the W03 parity harness on W02's, and write the four SDK-surface parity suites**

The registry side is the **real** `resolveModel` and `resolveSessionTurn`. Their data adapters are W01/W02 services plus `candidateLoader.ts`'s own reads, and here they are backed by W02's materialized `RegistrySnapshot` for each fixture (P13), not a database. `registrySnapshotDeps.ts` is the only file that knows that snapshot's shape. It fills in the fields the snapshot doesn't carry, using values that cannot change routing:
- platform rows are offered, available and priced at `getLegacyModelRates`;
- capabilities are tool-capable.

Every surface's parity suite lives in **one** file, `w03Surfaces.parity.test.ts`, as one `describe` per surface. That way the hoisted mock block is written once, and later tasks append their `describe`.

Append to `w03Parity.ts`:

```ts
// apps/api/src/services/aiModels/parity/w03Parity.ts — append
import { expect } from 'vitest';
import type { ResolveModelResult } from '../resolveModel';
import { PARITY_FIXTURES } from './fixtures';
import { parityQueries, runParity, sameUse, type ParityFixture } from './harness';
import { projectSurfaceUse, type RegistrySnapshot } from './storeProjection';

export function toSurfaceUse(r: ResolveModelResult): SurfaceUse {
  if (!r.ok) return { outcome: 'unavailable', reason: r.reason };
  return {
    outcome: 'ok',
    destination: r.connection.id === null ? 'platform' : { connectionId: r.connection.id },
    funding: r.funding,
    logicalModel: r.logicalModel,
    wireModel: r.wireModel,
  };
}

/**
 * W02's runParity with the frozen goldens as the legacy side. Fails on any
 * UNEXPECTED divergence, AND (review finding 13) on a DECLARED divergence whose
 * registry answer is not exactly W02's projected registry answer for that query.
 * W02's `applies()` accepts any `ok`; that alone would pass a catalog surface
 * resolved to the platform, or to the wrong model.
 */
export async function assertSurfaceParity(opts: {
  select: (q: ParityQuery) => boolean;
  /** Binds the resolver's data adapters to this fixture and returns the snapshot they read. */
  bind: (fixture: ParityFixture) => RegistrySnapshot | Promise<RegistrySnapshot>;
  registrySide: (fixture: ParityFixture, q: ParityQuery) => Promise<SurfaceUse>;
  /** Mutation self-tests only: override the frozen legacy side. */
  legacySide?: (fixture: ParityFixture, q: ParityQuery) => SurfaceUse;
}): Promise<void> {
  const goldens = loadW03Goldens();
  const failures: string[] = [];
  let compared = 0;
  for (const fixture of PARITY_FIXTURES) {
    const store = await opts.bind(fixture);
    const rows = await runParity(
      fixture,
      parityQueries(fixture).filter(opts.select),
      async (f, q) => {
        if (opts.legacySide) return opts.legacySide(f, q);
        const golden = goldens[f.name]?.[queryKey(q)];
        if (!golden) throw new Error(`no W03 golden for ${f.name} ${queryKey(q)}`);
        return golden;
      },
      opts.registrySide,
    );
    compared += rows.length;
    for (const row of rows) {
      const at = `${row.fixture} ${queryKey(row.query)}`;
      if (row.divergence === 'UNEXPECTED') {
        failures.push(`${at}: legacy ${JSON.stringify(row.legacy)} vs registry ${JSON.stringify(row.registry)}`);
      } else if (row.divergence !== null) {
        // Declared divergence: the registry answer must be the EXACT projected tuple
        // (destination, funding, logical model, wire model), not merely `ok`.
        const projected = projectSurfaceUse(store, row.query);
        if (!sameUse(row.registry, projected)) {
          failures.push(`${at} [${row.divergence}]: registry ${JSON.stringify(row.registry)} vs projected ${JSON.stringify(projected)}`);
        }
      }
    }
  }
  expect(compared, 'the selector matched no parity query').toBeGreaterThan(0);
  expect(failures).toEqual([]);
}
```

```ts
// apps/api/src/services/aiModels/parity/registrySnapshotDeps.ts
/**
 * Backs resolveModel's data adapters with W02's materialized RegistrySnapshot
 * for one parity fixture. The ONE file coupled to the snapshot's shape (P13).
 * Fields the snapshot does not carry are filled with values that cannot change
 * routing: platform rows offered/available/priced, tool-capable.
 */
import { resolveDefaultModel } from '../../aiModel';
import { getLegacyModelRates } from '../../aiCostTracker';   // Task 17 moves it to ../legacySurfaceModels
import { mergeEffectiveAssignment } from '../assignments';
import { EMPTY_OPTION_SUPPORT } from '../candidateLoader';
import { buildDesiredRegistryState } from '../legacyProjection';
import type { ParityFixture } from './harness';
import { materializeDesiredState, type RegistrySnapshot } from './storeProjection';

export type SnapshotDeps = Record<string, (...args: never[]) => unknown>;

/** The same projection W02's parity.test.ts materializes for this fixture. */
export function storeFor(fixture: ParityFixture): RegistrySnapshot {
  // W02 builds the projection env from fixture.env; reuse its helper if exported, else mirror it here.
  return materializeDesiredState(buildDesiredRegistryState(fixture.snapshot, projectionEnvFor(fixture)), fixture);
}

function platformRow(pm: { id: string; modelId: string }) {
  return {
    id: pm.id, provider: 'anthropic' as const, modelId: pm.modelId, displayName: pm.modelId,
    maxInputTokens: null, maxOutputTokens: null, capabilities: {},
    rates: getLegacyModelRates(pm.modelId).rates, optionRates: null, optionSupport: EMPTY_OPTION_SUPPORT,
    minPlan: null, promptProfile: 'generic' as const, platformOffered: true, isPlatformDefault: false,
    lifecycle: 'available' as const,
  };
}

export function snapshotDeps(store: RegistrySnapshot, fixture: ParityFixture): SnapshotDeps {
  const conn = (id: string | null) => store.connections.find((c) => c.id === id) ?? null;
  const offering = (o: RegistrySnapshot['offerings'][number]) => {
    const c = conn(o.connectionId);
    const manual = c !== null && c.kind !== 'catalog' && o.platformModelId === null;
    const rates = manual && o.modelId ? getLegacyModelRates(o.modelId).rates : null;
    return {
      id: o.id, partnerId: store.partnerId, connectionId: o.connectionId, platformModelId: o.platformModelId, modelId: o.modelId,
      source: c === null ? 'platform' : c.kind === 'catalog' ? 'catalog' : o.platformModelId ? 'discovered' : 'manual',
      displayName: null, capabilities: null,
      priceInputCentsPerM: rates?.inputCentsPerM ?? null, priceOutputCentsPerM: rates?.outputCentsPerM ?? null,
      priceCacheReadCentsPerM: rates?.cacheReadCentsPerM ?? null, priceCacheWriteCentsPerM: rates?.cacheWriteCentsPerM ?? null,
      enabled: o.enabled, defaultOptions: null, allowedOptions: null, requiredPermission: null,
      refusalFallbackOfferingId: null, lifecycle: 'available',
    };
  };
  const assignmentRow = (orgId: string | null, surface: string) =>
    store.assignments.find((a) => a.orgId === orgId && a.surface === surface) ?? null;
  return {
    getOffering: async (id: string) => { const o = store.offerings.find((x) => x.id === id); return o ? offering(o) : null; },
    listOfferings: async () => store.offerings.map(offering),
    getConnection: async (id: string) => {
      const c = conn(id);
      return c ? {
        id: c.id, partnerId: store.partnerId, kind: c.kind, name: c.kind, inferenceGeo: null,
        catalogEntryId: c.kind === 'catalog' ? fixture.catalogProvider?.entryId ?? null : null,
        baseUrl: null, status: c.status, configVersion: 1,
      } : null;
    },
    getConnectionKeyMaterial: async (id: string) => (conn(id) ? { id, partnerId: store.partnerId, apiKeyEncrypted: 'sealed' } : null),
    decryptConnectionKey: () => { if (!fixture.legacyApiKey) throw new Error('no key in fixture'); return fixture.legacyApiKey; },
    getPlatformModelById: async (id: string) => { const pm = store.platformModels.find((p) => p.id === id); return pm ? platformRow(pm) : null; },
    getPlatformModelByModelId: async (modelId: string) => { const pm = store.platformModels.find((p) => p.modelId === modelId); return pm ? platformRow(pm) : null; },
    getPlatformDefaultModel: async () => platformRow({ id: 'platform-default', modelId: resolveDefaultModel(fixture.env as NodeJS.ProcessEnv) }),
    getListedProviderByEntryId: async (entryId: string) => (fixture.catalogProvider?.entryId === entryId ? fixture.catalogProvider : null),
    getEffectiveAssignment: async (input: { orgId: string | null; surface: string; role?: string }) => mergeEffectiveAssignment({
      surface: input.surface as never, role: input.role ?? 'default',
      partner: assignmentRow(null, input.surface), org: input.orgId ? assignmentRow(input.orgId, input.surface) : null,
    }),
    loadPartnerFacts: async () => ({ plan: 'unlimited', residencyRequired: false }),
    readOrgPartnerId: async () => store.partnerId,
    readSessionModelRow: async (id: string) => {
      const s = store.sessions.find((x) => x.id === id);
      const live = fixture.snapshot.liveSessions.find((x) => x.id === id);
      return s && live ? { orgId: live.orgId, offeringId: s.offeringId, options: null } : null;
    },
  };
}
```

> `projectionEnvFor(fixture)` is the `LegacyProjectionEnv` W02's `parity.test.ts` builds from `fixture.env`. Import it if W02 exported it; otherwise copy its few lines into this file. `storeProjection.ts` / `legacyProjection.ts` are W02's module names for `materializeDesiredState` / `buildDesiredRegistryState`; adjust the import paths to W02's actual files.

```ts
// apps/api/src/services/aiModels/parity/w03Surfaces.parity.test.ts
/**
 * W03 per-surface parity (#7601, quorum #14): for every W02 fixture shape and
 * query, the REAL resolver's destination, funding, logical model and wire model
 * equal the frozen legacy route, except W02's two declared divergences.
 * One describe per surface; Tasks 10–14 append theirs.
 */
import { beforeAll, describe, it, vi } from 'vitest';

// ── hoisted mock block: written ONCE for every surface in this file ──
const h = vi.hoisted(() => {
  const state: { deps: Record<string, (...a: unknown[]) => unknown> | null } = { deps: null };
  const call = (k: string) => (...a: unknown[]) => state.deps![k]!(...a);
  return { state, call };
});
vi.mock('../../../db', () => ({
  db: {}, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../offerings', () => ({ getOffering: h.call('getOffering'), listOfferings: h.call('listOfferings') }));
vi.mock('../connections', () => ({
  getConnection: h.call('getConnection'), getConnectionKeyMaterial: h.call('getConnectionKeyMaterial'),
  decryptConnectionKey: h.call('decryptConnectionKey'),
}));
vi.mock('../platformModels', () => ({
  getPlatformModelById: h.call('getPlatformModelById'), getPlatformModelByModelId: h.call('getPlatformModelByModelId'),
  getPlatformDefaultModel: h.call('getPlatformDefaultModel'), getPlatformInferenceGeo: async () => null,
}));
vi.mock('../../llmProviderCatalog', () => ({ getListedProviderByEntryId: h.call('getListedProviderByEntryId') }));
vi.mock('../assignments', async (orig) => ({
  ...(await orig<typeof import('../assignments')>()), getEffectiveAssignment: h.call('getEffectiveAssignment'),
}));
vi.mock('../candidateLoader', async (orig) => ({
  ...(await orig<typeof import('../candidateLoader')>()),
  loadPartnerFacts: h.call('loadPartnerFacts'), readOrgPartnerId: h.call('readOrgPartnerId'),
  readSessionModelRow: h.call('readSessionModelRow'), loadUserPermissionPredicate: async () => () => true,
}));
vi.mock('../capabilities', () => ({
  deriveCapabilities: () => ({ thinkingMode: 'none', effortLevels: [], supportsTools: true, supportsVision: false }),
}));
vi.mock('../../llm/llmAvailability', async (orig) => ({
  ...(await orig<typeof import('../../llm/llmAvailability')>()), isPlatformLlmConfigured: () => true,
}));
// ──────────────────────────────────────────────────────────────────────

import type { AiSurface } from '@breeze/shared';
import { resolveModel } from '../resolveModel';
import { resolveSessionTurn } from '../sessionModel';
import type { ParityFixture, ParityQuery } from './harness';
import { snapshotDeps, storeFor } from './registrySnapshotDeps';
import { assertSurfaceParity, toSurfaceUse } from './w03Parity';

beforeAll(() => { process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true'; });

const bind = (fixture: ParityFixture) => {
  const store = storeFor(fixture);
  h.state.deps = snapshotDeps(store, fixture) as never;
  return store;
};
const partnerOf = (fixture: ParityFixture) => storeFor(fixture).partnerId;
const surfaceQuery = (surface: AiSurface) => (q: ParityQuery) => q.kind === 'surface' && q.surface === surface;
const viaAssignment = (surface: AiSurface, userInitiated: boolean) => async (fixture: ParityFixture, q: ParityQuery) =>
  toSurfaceUse(await resolveModel({
    partnerId: partnerOf(fixture), orgId: (q as { orgId: string }).orgId, surface,
    ...(userInitiated ? { userId: 'parity-user' } : {}),
  }));

describe('W03 parity: chat + topology (assignment route and stored sessions)', () => {
  it('surface queries', async () => {
    await assertSurfaceParity({ select: surfaceQuery('chat'), bind, registrySide: viaAssignment('chat', true) });
  });
  it('session queries (a stored session re-resolved per turn)', async () => {
    await assertSurfaceParity({
      select: (q) => q.kind === 'session',
      bind,
      registrySide: async (_f, q) => toSurfaceUse(await resolveSessionTurn({
        sessionId: (q as { sessionId: string }).sessionId, surface: 'chat', userId: 'parity-user',
      })),
    });
  });
});

describe('W03 parity: helper', () => {
  it('surface queries', async () => {
    await assertSurfaceParity({ select: surfaceQuery('helper'), bind, registrySide: viaAssignment('helper', false) });
  });
});

describe('W03 parity: script_builder', () => {
  it('surface queries', async () => {
    await assertSurfaceParity({ select: surfaceQuery('script_builder'), bind, registrySide: viaAssignment('script_builder', true) });
  });
});

describe('W03 parity: office_chat', () => {
  it('surface queries', async () => {
    await assertSurfaceParity({ select: surfaceQuery('office_chat'), bind, registrySide: viaAssignment('office_chat', false) });
  });
});
```

**Mutation self-tests (review finding 13).** A parity suite that cannot fail proves nothing. Append to `w03Surfaces.parity.test.ts` (it has the hoisted adapters):

```ts
describe('W03 parity harness discriminates (mutations that MUST fail)', () => {
  const chatSide = viaAssignment('chat', true);

  it('a registry side that forces platform funding fails', async () => {
    await expect(assertSurfaceParity({
      select: surfaceQuery('chat'), bind,
      registrySide: async (f, q) => {
        const u = await chatSide(f, q);
        return u.outcome === 'ok' ? { ...u, destination: 'platform', funding: 'platform' } : u;
      },
    })).rejects.toThrow();
  });

  it('an entrypoint that resolves the WRONG surface fails (chat answered as patch_test: BYOK chat vs platform patch_test)', async () => {
    await expect(assertSurfaceParity({
      select: surfaceQuery('chat'), bind,
      registrySide: async (f, q) => {
        const goldens = loadW03Goldens();
        return goldens[f.name]![queryKey({ kind: 'surface', surface: 'patch_test', orgId: (q as { orgId: string }).orgId })]!;
      },
    })).rejects.toThrow();
  });

  it('a declared catalog divergence resolved to the wrong destination fails (any-ok is not enough)', async () => {
    await expect(assertSurfaceParity({
      select: surfaceQuery('extension_content'), bind,
      registrySide: async (f, q) => {
        const u = await viaAssignment('extension_content', false)(f, q);
        return u.outcome === 'ok' ? { ...u, destination: 'platform', funding: 'platform' } : u;
      },
    })).rejects.toThrow();
  });
});
```

Add `loadW03Goldens` and `queryKey` to the `./w03Parity` import. The third case needs at least one catalog fixture whose `extension_content` golden is `catalog_refused`. W02's fixture list has one (P13, `catalog_*`). If it is missing, the case fails, which is correct: the declared divergence would then be untested.

**Entry-point assertions (review finding 13).** The parity suite calls the resolvers. The entrypoints are proven separately, by composition: after W03 an entrypoint has no routing logic of its own. It passes ONE surface string to the resolver, then forwards the `ResolvedModel` unchanged to dispatch and to the reservation. Each SDK entrypoint's route or service test pins three things, using `makeResolvedModel('anthropic_byok')`, whose `partner_key` funding differs from every platform default:
1. the **exact** resolver call: `toHaveBeenCalledWith({ sessionId, surface: '<surface>', userId })`;
2. the dispatch received **the same object**: `streamingSessionManager.getOrCreate` gets `toBe(model)` as its model argument;
3. the reservation: `reserveAiBudget` receives `expect.objectContaining({ billingSource: 'partner_key', binding: turnBindingFrom(model) })`.

| Entrypoint | Test file | Surface |
|---|---|---|
| `runPreFlightChecks` (chat/topology turns) | `services/aiAgentSdk.test.ts` | `'chat'`; `checkBudget(orgId, 'partner_key')` instead of the reservation |
| `runPreFlightChecks` (script builder turns) | `services/aiAgentSdk.test.ts` | `'script_builder'` |
| `POST /ai/sessions/:id/messages` | `routes/ai.modelResolution.test.ts` (above) | consumes the preflight `model` → 2 + 3 |
| helper messages | `routes/helper/index.test.ts` | `'helper'` |
| script builder messages | `routes/scriptAi_messages_approve.test.ts` | consumes the preflight `model` → 2 + 3 |
| Office chat messages | `routes/clientAi/sessions.messages.test.ts` | `'office_chat'` |

The helper case, as the template for the others:

```ts
// apps/api/src/routes/helper/index.test.ts — new case
it('dispatches and reserves exactly the model resolved for the helper surface (finding 13)', async () => {
  const model = makeResolvedModel('anthropic_byok');
  resolveSessionTurnMock.mockResolvedValue(model);
  await app.request(`/helper/chat/sessions/${SESSION_ID}/messages`, { method: 'POST', headers: helperHeaders, body: JSON.stringify({ content: 'hi' }) });
  expect(resolveSessionTurnMock).toHaveBeenCalledWith({ sessionId: SESSION_ID, surface: 'helper', userId: null });
  expect(getOrCreateMock.mock.calls[0]![3]).toBe(model);   // the model argument position in getOrCreate
  expect(reserveAiBudgetMock).toHaveBeenCalledWith(expect.objectContaining({
    billingSource: 'partner_key', binding: turnBindingFrom(model),
  }));
});
```

Use the route path and the `getOrCreate` argument index the file already uses. Tasks 10–13 follow the same three-assertion rule for their Messages API entrypoints, and each task's test list names the case.

**Env OpenAI-compatible execution (review finding 12).** Add two `runPreFlightChecks` cases to `services/aiAgentSdk.test.ts`. Both run with `MCP_LLM_PROVIDER=openai-compatible` through the config mock and with **no** `ANTHROPIC_API_KEY` or other platform credential env var:
- a `chat` session row with `offering_id NULL` and a legacy resolver returning `{ source: 'platform', model: 'gpt-4o-mini' }` → `{ ok: true, model: null, openaiCompatible: true }`, `resolveSessionTurn` never called, and `checkBudget(orgId, 'platform')`;
- the legacy resolver returning `{ source: 'partner', … }` → `{ ok: false, error: 'ai_unavailable', status: 503 }`.

Task 9 pins the creation half.

**Not adopted from finding 13: running every parity fixture through every HTTP entrypoint.** Each route needs 30–40 hoisted mocks (`helper/index.test.ts` on `origin/main`), and fixtures × queries × routes would repeat the resolver matrix through code with no routing of its own. Composition gives the same guarantee: exact tuples per fixture at the resolver, plus the surface string and pass-through at each entrypoint. The surface-swap mutation above proves that a wrong surface string would be caught.

- [ ] **Step 11: Run everything touched**

Run: `cd apps/api && npx vitest run src/services/aiModels src/services/streamingSessionManager src/services/aiAgentSdk src/routes/ai src/routes/helper src/routes/scriptAi src/routes/clientAi`
Expected: PASS. Check the reported file count includes every `streamingSessionManager.*.test.ts`: the substring filter matches them all.

Run: `cd apps/api && npx vitest run src/services/aiModels/parity/w03Surfaces.parity.test.ts`
Expected: PASS (8 tests: 5 parity plus 3 mutations that must reject). A failure lists `fixture query: legacy … vs registry …`. It is either a resolver bug or a W02 projection gap: fix the resolver, or stop and report the projection gap. **Never** add an `EXPECTED_DIVERGENCES` entry to make it pass.

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/topologyAiFailureAccounting.integration.test.ts`
Expected: PASS.

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/services/aiModels/sessionModel.ts apps/api/src/services/aiModels/sessionModel.test.ts \
  apps/api/src/services/aiModels/__fixtures__/resolvedModel.ts apps/api/src/services/streamingSessionManager.ts \
  apps/api/src/services/streamingSessionManager.*.test.ts apps/api/src/services/__testUtils__/streamingSessionManagerHarness.ts \
  apps/api/src/services/aiAgentSdk.ts apps/api/src/routes/ai.ts apps/api/src/routes/ai.modelResolution.test.ts \
  apps/api/src/routes/ai_sessions_*.test.ts apps/api/src/routes/helper apps/api/src/routes/scriptAi.ts \
  apps/api/src/routes/scriptAi_*.test.ts apps/api/src/routes/clientAi \
  apps/api/src/services/aiModels/parity/w03Parity.ts apps/api/src/services/aiModels/parity/registrySnapshotDeps.ts \
  apps/api/src/services/aiModels/parity/w03Surfaces.parity.test.ts
git commit -m "feat(ai): SDK session surfaces dispatch, admit and settle through resolveModel (#7601)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 8: Refusals in chat (§9.1a) — recorded, explained, never a silent empty answer

When a turn's final answer is a refusal (after any refusal fallback also declined), Task 7 already writes `stop_reason`, `refusal_category` and `fallback_used` to the ledger. This task makes it visible to the user:
- **Persisted message.** An assistant message is stored: "The model declined this request (category: cyber)." It names the other permitted offerings the user may switch to, and links to the admin docs on configuring a refusal fallback.
- **Live stream.** The same text streams as ordinary `message_start` / `content_delta` / `message_end` events, so today's chat renders it with no UI change.
- **Structured event.** A `model_refusal` stream event carries the category, the alternatives and the docs URL for W05's picker.

Topology turns are excluded: their output gate never streams model text, and a refused topology turn already fails through `finishTopologyTurn`'s validation. The ledger still records the refusal.

**Files:**
- Create: `apps/api/src/services/aiModels/refusals.ts`, `apps/api/src/services/aiModels/refusals.test.ts`
- Modify: `apps/api/src/services/streamingSessionManager.ts` (the `result` case, after settlement)
- Modify: `apps/api/src/services/streamingSessionManager.modelBinding.test.ts` (refusal cases)
- Modify: `packages/shared/src/types/ai.ts` (`AiStreamEvent` ~L212)
- Modify: `apps/docs/src/content/docs/features/ai.mdx` (new `## Model refusals` section)

**Interfaces:**
- Consumes: Task 3 `resolveModel`; P9 `getEffectiveAssignment`; P8 `listOfferings`; Task 5 `TurnOutcome`.
- Produces:
  ```ts
  export const REFUSAL_DOCS_URL = 'https://docs.breezermm.com/features/ai/#model-refusals';
  export interface RefusalAlternative { offeringId: string; displayName: string }
  export function refusalHeadline(category: string | null): string;
  export function refusalMessageText(category: string | null, alternatives: RefusalAlternative[]): string;
  export function listRefusalAlternatives(input: {
    partnerId: string; orgId: string; userId: string | null; surface: AiSurface;
    excludeOfferingId: string | null; limit?: number;
  }): Promise<RefusalAlternative[]>;
  // packages/shared AiStreamEvent gains:
  | { type: 'model_refusal'; category: string | null; alternatives: Array<{ offeringId: string; displayName: string }>; docsUrl: string }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/aiModels/refusals.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ getEffectiveAssignment: vi.fn(), resolveModel: vi.fn(), listOfferings: vi.fn() }));
vi.mock('./assignments', () => ({ getEffectiveAssignment: m.getEffectiveAssignment }));
vi.mock('./resolveModel', () => ({ resolveModel: m.resolveModel }));
vi.mock('./offerings', () => ({ listOfferings: m.listOfferings }));

import { REFUSAL_DOCS_URL, listRefusalAlternatives, refusalHeadline, refusalMessageText } from './refusals';

beforeEach(() => vi.clearAllMocks());

describe('refusal text', () => {
  it('names the category', () => {
    expect(refusalHeadline('cyber')).toBe('The model declined this request (category: cyber).');
  });
  it('a null category reads "unspecified", never blank', () => {
    expect(refusalHeadline(null)).toBe('The model declined this request (category: unspecified).');
  });
  it('lists alternatives and always links the admin docs', () => {
    expect(refusalMessageText('cyber', [{ offeringId: 'a', displayName: 'Opus 5.5' }, { offeringId: 'b', displayName: 'Haiku 4.5' }]))
      .toBe([
        'The model declined this request (category: cyber).',
        'You can retry with another model: Opus 5.5, Haiku 4.5.',
        `An administrator can configure a refusal fallback model: ${REFUSAL_DOCS_URL}`,
      ].join('\n\n'));
    expect(refusalMessageText(null, [])).toContain(REFUSAL_DOCS_URL);
  });
});

describe('listRefusalAlternatives', () => {
  it('offers only eligible permitted offerings, excluding the one that refused', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ defaultOfferingId: 'a', defaultSource: 'partner', permitted: { kind: 'list', offeringIds: ['a', 'b', 'c'] }, allowUserChoice: true, options: {} });
    m.resolveModel.mockImplementation(async ({ requested }: { requested: { offeringId: string } }) =>
      requested.offeringId === 'c'
        ? { ok: false, reason: 'permission_required' }
        : { ok: true, offering: { id: requested.offeringId, displayName: `M-${requested.offeringId}` } });
    expect(await listRefusalAlternatives({ partnerId: 'p', orgId: 'o', userId: 'u', surface: 'chat', excludeOfferingId: 'a' }))
      .toEqual([{ offeringId: 'b', displayName: 'M-b' }]);
    expect(m.resolveModel).toHaveBeenCalledWith(expect.objectContaining({ requested: { offeringId: 'b', origin: 'user' } }));
  });

  it('offers nothing when the user may not choose', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ defaultOfferingId: 'a', defaultSource: 'partner', permitted: { kind: 'all' }, allowUserChoice: false, options: {} });
    expect(await listRefusalAlternatives({ partnerId: 'p', orgId: 'o', userId: 'u', surface: 'chat', excludeOfferingId: 'a' })).toEqual([]);
    expect(m.resolveModel).not.toHaveBeenCalled();
  });
});
```

Add to `streamingSessionManager.modelBinding.test.ts`:

```ts
describe('refused turn', () => {
  it('persists and streams the refusal text plus a structured model_refusal event — never an empty answer', async () => {
    vi.mocked(listRefusalAlternativesMock).mockResolvedValue([{ offeringId: 'b', displayName: 'Opus 5.5' }]);
    const resolved = makeResolvedModel();
    m.query.mockReturnValue(scriptedQuery([
      { type: 'system', subtype: 'model_refusal_no_fallback', api_refusal_category: 'cyber' },
      { type: 'result', subtype: 'success', stop_reason: 'refusal', total_cost_usd: 0, num_turns: 1, usage: { input_tokens: 10, output_tokens: 0 } },
    ]));
    const mgr = new StreamingSessionManager();
    const session = await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1, resolved, undefined, undefined, { ledgerUserId: 'u1' });
    const events: Array<Record<string, unknown>> = [];
    session.eventBus.subscribe((e) => events.push(e as never));
    mgr.tryTransitionToProcessing(session, undefined, { turnBinding: turnBindingFrom(resolved) });
    await session.processorPromise;

    const text = events.filter((e) => e.type === 'content_delta').map((e) => e.delta).join('');
    expect(text).toContain('The model declined this request (category: cyber).');
    expect(text).toContain('Opus 5.5');
    expect(events).toContainEqual({ type: 'model_refusal', category: 'cyber',
      alternatives: [{ offeringId: 'b', displayName: 'Opus 5.5' }], docsUrl: REFUSAL_DOCS_URL });
    expect(insertedAssistantMessages().at(-1)).toMatchObject({ role: 'assistant', content: expect.stringContaining('category: cyber') });
    expect(m.settleInvocation.mock.calls[0]![0].outcome).toMatchObject({ refused: true, refusalCategory: 'cyber' });
  });
});
```

Mock `./aiModels/refusals` partially in that file (keep the real text helpers, stub `listRefusalAlternatives` as `listRefusalAlternativesMock`). `insertedAssistantMessages()` is the harness accessor over the mocked `db.insert(aiMessages).values` calls; add it to `__testUtils__/streamingSessionManagerHarness.ts` if missing.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/refusals.test.ts src/services/streamingSessionManager.modelBinding.test.ts`
Expected: FAIL. `./refusals` is missing, and the manager publishes no `content_delta` for a refused turn.

- [ ] **Step 3: Implement `refusals.ts`**

```ts
// apps/api/src/services/aiModels/refusals.ts
/**
 * §9.1a: a refusal is recorded, explained, and never a silent empty answer.
 * Sonnet 5.5 / Opus 5.5 refuse in a `cyber` category, and RMM work (malware
 * triage, suspicious scripts, persistence checks) will hit it.
 */
import type { AiSurface } from '@breeze/shared';
import { getEffectiveAssignment } from './assignments';
import { listOfferings } from './offerings';
import { resolveModel } from './resolveModel';

export const REFUSAL_DOCS_URL = 'https://docs.breezermm.com/features/ai/#model-refusals';

export interface RefusalAlternative { offeringId: string; displayName: string }

export function refusalHeadline(category: string | null): string {
  return `The model declined this request (category: ${category ?? 'unspecified'}).`;
}

export function refusalMessageText(category: string | null, alternatives: RefusalAlternative[]): string {
  const parts = [refusalHeadline(category)];
  if (alternatives.length > 0) {
    parts.push(`You can retry with another model: ${alternatives.map((a) => a.displayName).join(', ')}.`);
  }
  parts.push(`An administrator can configure a refusal fallback model: ${REFUSAL_DOCS_URL}`);
  return parts.join('\n\n');
}

/** Eligible, permitted offerings this user could switch to (only when user choice is allowed). */
export async function listRefusalAlternatives(input: {
  partnerId: string;
  orgId: string;
  userId: string | null;
  surface: AiSurface;
  excludeOfferingId: string | null;
  limit?: number;
}): Promise<RefusalAlternative[]> {
  const assignment = await getEffectiveAssignment({
    partnerId: input.partnerId, orgId: input.orgId, surface: input.surface, role: 'default',
  });
  if (!assignment.allowUserChoice) return [];
  const ids = assignment.permitted.kind === 'list'
    ? assignment.permitted.offeringIds
    : (await listOfferings(input.partnerId)).filter((o) => o.enabled).map((o) => o.id);
  const limit = input.limit ?? 5;
  const out: RefusalAlternative[] = [];
  for (const id of ids) {
    if (id === input.excludeOfferingId) continue;
    const r = await resolveModel({
      partnerId: input.partnerId, orgId: input.orgId, userId: input.userId, surface: input.surface,
      requested: { offeringId: id, origin: 'user' },
    });
    if (r.ok && r.offering.id) out.push({ offeringId: r.offering.id, displayName: r.offering.displayName });
    if (out.length >= limit) break;
  }
  return out;
}
```

- [ ] **Step 4: Surface it from the manager and type the event**

```ts
// packages/shared/src/types/ai.ts — add to AiStreamEvent
  /**
   * §9.1a (#7598): the turn's final answer was a model refusal. The same text
   * also streams as ordinary content so every client renders it; this event
   * carries the structure W05's picker uses to offer a switch.
   */
  | { type: 'model_refusal'; category: string | null; alternatives: Array<{ offeringId: string; displayName: string }>; docsUrl: string }
```

```ts
// streamingSessionManager.ts — new private method
  private async publishRefusal(session: ActiveSession, category: string | null): Promise<void> {
    const b = session.turnBinding;
    let alternatives: RefusalAlternative[] = [];
    if (b.partnerId) {
      try {
        alternatives = await listRefusalAlternatives({
          partnerId: b.partnerId, orgId: session.orgId, userId: session.ledgerUserId,
          surface: b.surface, excludeOfferingId: b.offeringId,
        });
      } catch (err) {
        captureException(err);   // alternatives are a convenience; the message is not
      }
    }
    const text = refusalMessageText(category, alternatives);
    try {
      await withDbAccessContext(
        { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
        () => db.insert(aiMessages).values({
          sessionId: session.breezeSessionId,
          role: 'assistant',
          content: text,
          contentBlocks: [{ type: 'model_refusal', category, alternatives, docsUrl: REFUSAL_DOCS_URL }] as unknown as Record<string, unknown>[],
        }),
      );
    } catch (err) {
      captureException(err);
      console.error('[StreamingSessionManager] Failed to save refusal message:', err);
    }
    const messageId = crypto.randomUUID();
    session.eventBus.publish({ type: 'message_start', messageId });
    session.eventBus.publish({ type: 'content_delta', delta: text });
    // Same shape the `message_delta` branch publishes (~L1672).
    session.eventBus.publish({ type: 'message_end', messageId, outputTokens: 0 } as never);
    session.eventBus.publish({ type: 'model_refusal', category, alternatives, docsUrl: REFUSAL_DOCS_URL });
  }
```

In the `result` case, right after the `settleInvocation` block from Task 7 and before the `done` publish:

```ts
            if (outcome.refused && !session.topologyInvestigation) {
              await this.publishRefusal(session, outcome.refusalCategory);
            }
```

> Match `message_end`'s fields exactly to the existing publish at ~L1672. The `as never` above only stands in for whatever that shape is.

- [ ] **Step 5: Document refusals**

Append to `apps/docs/src/content/docs/features/ai.mdx`:

```mdx
## Model refusals

Some Claude models decline requests that resemble harmful work. The category is reported with the refusal, for example `cyber` for malware analysis or exploit-like scripts. Security triage in an RMM can trigger this even when the work is legitimate.

When a model declines, Breeze:

- records the refusal and its category against the model in AI usage;
- shows the technician "The model declined this request (category: …)", lists the other models they are allowed to switch to, and links here;
- ends an AI agent run as **Blocked — model refused**, with the category in the run outcome.

### Configuring a refusal fallback

An administrator can give a model a **refusal fallback** under **Partner Settings → AI Providers & Models**. The fallback must be another enabled model on the **same connection**, so it never changes who pays for the request. On the Claude API, Breeze asks Anthropic to retry the turn on the fallback model in the same request. On a catalog provider, Breeze retries once itself. The turn is billed at the rate of the model that served it.
```

- [ ] **Step 6: Run the tests and the docs build**

Run: `cd apps/api && npx vitest run src/services/aiModels/refusals.test.ts src/services/streamingSessionManager.modelBinding.test.ts`
Expected: PASS.

Run: `cd packages/shared && npx tsc --noEmit -p tsconfig.json && cd ../../apps/docs && pnpm build`
Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/aiModels/refusals.ts apps/api/src/services/aiModels/refusals.test.ts \
  apps/api/src/services/streamingSessionManager.ts apps/api/src/services/streamingSessionManager.modelBinding.test.ts \
  apps/api/src/services/__testUtils__/streamingSessionManagerHarness.ts packages/shared/src/types/ai.ts \
  apps/docs/src/content/docs/features/ai.mdx
git commit -m "feat(ai): surface model refusals in chat with category, alternatives and fallback docs (#7601)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 9: Session creation picks an offering through `resolveModel` (replaces W00's interim validation)

This task deletes the free-form session-model path. Every session-creating route resolves its surface through `resolveModel`:
- `POST /ai/sessions`, which covers chat and topology;
- script builder create;
- helper create;
- Office create.

A route stores the resolved `offering_id`, `offering_partner_id` and `options`, the logical `model` as a provenance snapshot, and the `billing_source`. Validation outcomes:
- A **requested** offering (`origin: 'user'`) that is ineligible or not permitted is a 400 with the resolver's reason. No fallback applies and nothing is stored.
- The legacy `model` string in the request body is accepted for one more wave as a lookup key. It maps to the partner's enabled offering with that model id, then goes through the same resolution; an unknown id is `invalid_model`.
- No request and no eligible default keeps today's 503 (`ai_unavailable`, or `ai_not_configured` when the deployment has no platform credential).
- **A deployment on the env OpenAI-compatible chat path (`MCP_LLM_PROVIDER=openai-compatible`) keeps its legacy creation branch until W06** (review finding 12). Such a deployment can have no Anthropic credential at all (`isPlatformLlmConfigured(…, 'chat')` is true on the env flag alone, `services/llm/llmAvailability.ts:89` on `origin/main`). The registry would find no eligible platform offering and refuse every new chat. `createSession` therefore branches on `isOpenAICompatibleProvider()` first, exactly where `origin/main` `aiAgent.ts:210–214` resolves today. The session is stored with `offering_id = NULL`. Task 7's `runPreFlightChecks` already routes `chat` turns on this flag to the legacy path, so execution needs no new code.

W00's `assertSessionModelAllowed`, its `OFFERABLE_AI_MODELS` check and the `InvalidSessionModelError` in `aiOfferableModels.ts` are replaced. The error class moves to `sessionModel.ts`.

**Files:**
- Modify: `apps/api/src/services/aiModels/sessionModel.ts` (create half), `apps/api/src/services/aiModels/sessionModel.test.ts`
- Modify: `apps/api/src/services/aiAgent.ts` (`createSession` ~L117–280; delete `assertSessionModelAllowed` ~L53–65 and the `InvalidSessionModelError` re-export ~L37)
- Modify: `apps/api/src/services/aiOfferableModels.ts` (remove `InvalidSessionModelError`; the file keeps only `OFFERABLE_AI_MODELS` until Task 17)
- Modify: `apps/api/src/routes/ai.ts` (`POST /ai/sessions` ~L247–282 error mapping)
- Modify: `packages/shared/src/validators/ai.ts` (`createAiSessionSchema` ~L60)
- Modify: `apps/api/src/routes/scriptAi.ts` (create ~L98–114), `apps/api/src/services/scriptBuilderService.ts` (~L40)
- Modify: `apps/api/src/routes/helper/index.ts` (create ~L255–320)
- Modify: `apps/api/src/routes/clientAi/sessions.ts` (create ~L296–325)
- Modify: `apps/api/src/services/aiAgent.sessionModel.test.ts` (W00), `apps/api/src/routes/ai_sessions_crud.test.ts`, `helper/index.test.ts`, `scriptAi_sessions.test.ts`, `clientAi/sessions.create.test.ts`
- Create: `apps/api/migrations/2026-11-19-100600-ai-sessions-model-drop-default.sql` (W02 handoff #5)
- Modify: `apps/api/src/db/schema/ai.ts` (`aiSessions.model` ~L38 loses `.default(…)`), plus every `ai_sessions` insert that omitted `model` (Step 5A)

**Interfaces:**
- Consumes: Task 3 `resolveModel`, `ResolvedModel`; Task 2 `findOfferingIdByModel`, `readOrgPartnerId`; `isPlatformLlmConfigured`; `LlmUnavailableError`, `LlmNotConfiguredError` (the class `aiAgent.ts` already throws).
- Produces:
  ```ts
  export class InvalidSessionModelError extends Error {
    readonly status: 400; readonly code: 'invalid_model' | ResolveFailureReason;
    constructor(message: string, code: 'invalid_model' | ResolveFailureReason);
  }
  export interface SessionModelChoice {
    resolved: ResolvedModel;
    offeringId: string | null; offeringPartnerId: string;
    options: Partial<OfferingOptions> | null;   // what the USER asked for (null = follow the assignment)
    model: string;                              // provenance snapshot = resolved.logicalModel
    billingSource: AiBillingSource;
  }
  export function chooseSessionModel(input: {
    partnerId: string; orgId: string; userId: string | null; surface: AiSurface;
    offeringId?: string; options?: Partial<OfferingOptions>; legacyModel?: string;
  }): Promise<SessionModelChoice>;
  // packages/shared createAiSessionSchema gains: offeringId?: uuid; options?: Partial<OfferingOptions>
  ```

- [ ] **Step 1: Write the failing table**

```ts
// appended to apps/api/src/services/aiModels/sessionModel.test.ts
import { makeResolvedModel } from './__fixtures__/resolvedModel';
import { chooseSessionModel, InvalidSessionModelError } from './sessionModel';
import { LlmNotConfiguredError } from '../llm/llmAvailability';
import { LlmUnavailableError } from '../llm/llmConfigResolver';

const extra = vi.hoisted(() => ({ findOfferingIdByModel: vi.fn(), isPlatformLlmConfigured: vi.fn(() => true) }));
vi.mock('../llm/llmAvailability', async (orig) => ({
  ...(await orig<typeof import('../llm/llmAvailability')>()),
  isPlatformLlmConfigured: extra.isPlatformLlmConfigured,
}));
// extend the './candidateLoader' mock above with: findOfferingIdByModel: extra.findOfferingIdByModel
vi.mock('./registryCutover', () => ({ ensurePartnerCutover: vi.fn(async () => true) }));

describe('chooseSessionModel', () => {
  const base = { partnerId: 'partner-1', orgId: 'org-1', userId: 'u1', surface: 'chat' as const };

  it('a permitted requested offering is stored with the user options and its funding', async () => {
    m.resolveModel.mockResolvedValue(makeResolvedModel('anthropic_byok', { offering: { id: 'off-2', displayName: 'Opus' } }));
    const c = await chooseSessionModel({ ...base, offeringId: 'off-2', options: { effort: 'high' } });
    expect(m.resolveModel).toHaveBeenCalledWith({ ...base, requested: { offeringId: 'off-2', options: { effort: 'high' }, origin: 'user' } });
    expect(c).toMatchObject({ offeringId: 'off-2', offeringPartnerId: 'partner-1', options: { effort: 'high' },
      model: 'claude-sonnet-5-5', billingSource: 'partner_key' });
  });

  it('a not-permitted / foreign offering is a 400 with the resolver reason (no fallback for a fresh choice)', async () => {
    m.resolveModel.mockResolvedValue({ ok: false, reason: 'not_permitted', recoverable: true, offeringId: 'x',
      message: 'This AI model is not available here. Choose another model.' });
    await expect(chooseSessionModel({ ...base, offeringId: 'x' })).rejects.toMatchObject({
      name: 'InvalidSessionModelError', status: 400, code: 'not_permitted',
    });
  });

  it('a premium offering without the permission is a 400 permission_required', async () => {
    m.resolveModel.mockResolvedValue({ ok: false, reason: 'permission_required', recoverable: true, offeringId: 'p', message: 'm' });
    await expect(chooseSessionModel({ ...base, offeringId: 'p' })).rejects.toMatchObject({ code: 'permission_required' });
  });

  it('the legacy `model` string maps to the matching enabled offering', async () => {
    extra.findOfferingIdByModel.mockResolvedValue('off-7');
    m.resolveModel.mockResolvedValue(makeResolvedModel());
    await chooseSessionModel({ ...base, legacyModel: 'claude-opus-5-5' });
    expect(extra.findOfferingIdByModel).toHaveBeenCalledWith({ partnerId: 'partner-1', orgId: 'org-1', surface: 'chat', modelId: 'claude-opus-5-5' });
    expect(m.resolveModel).toHaveBeenCalledWith(expect.objectContaining({ requested: { offeringId: 'off-7', origin: 'user' } }));
  });

  it('an unknown legacy model id is invalid_model and never stored', async () => {
    extra.findOfferingIdByModel.mockResolvedValue(null);
    await expect(chooseSessionModel({ ...base, legacyModel: 'gpt-free-form' })).rejects.toMatchObject({
      code: 'invalid_model', message: 'Model "gpt-free-form" is not available for AI sessions.',
    });
    expect(m.resolveModel).not.toHaveBeenCalled();
  });

  it('nothing requested and nothing eligible keeps the legacy 503 shapes', async () => {
    m.resolveModel.mockResolvedValue({ ok: false, reason: 'model_unavailable', recoverable: true, offeringId: null, message: 'm' });
    await expect(chooseSessionModel(base)).rejects.toBeInstanceOf(LlmUnavailableError);
    m.resolveModel.mockResolvedValue({ ok: false, reason: 'connection_unavailable', recoverable: true, offeringId: null, message: 'm' });
    extra.isPlatformLlmConfigured.mockReturnValue(false);
    await expect(chooseSessionModel(base)).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/sessionModel.test.ts`
Expected: FAIL with `chooseSessionModel is not a function`.

- [ ] **Step 3: Implement the create half**

```ts
// apps/api/src/services/aiModels/sessionModel.ts — append
export class InvalidSessionModelError extends Error {
  readonly status = 400 as const;
  readonly code: 'invalid_model' | ResolveFailureReason;

  constructor(message: string, code: 'invalid_model' | ResolveFailureReason) {
    super(message);
    this.name = 'InvalidSessionModelError';
    this.code = code;
  }
}

export interface SessionModelChoice {
  resolved: ResolvedModel;
  offeringId: string | null;
  offeringPartnerId: string;
  options: Partial<OfferingOptions> | null;
  model: string;
  billingSource: AiBillingSource;
}

/**
 * Session creation (spec §12 "Cost abuse": replaces the free-form session
 * model). A requested offering is a fresh USER choice: strict, no fallback.
 */
export async function chooseSessionModel(input: {
  partnerId: string;
  orgId: string;
  userId: string | null;
  surface: AiSurface;
  offeringId?: string;
  options?: Partial<OfferingOptions>;
  legacyModel?: string;
}): Promise<SessionModelChoice> {
  let offeringId = input.offeringId;
  if (!offeringId && input.legacyModel) {
    // The lookup reads assignments: never against a partner not yet cut over (Task 6A).
    if (!(await ensurePartnerCutover(input.partnerId))) {
      throw new LlmUnavailableError('AI configuration is being upgraded. Try again in a moment.');
    }
    offeringId = (await findOfferingIdByModel({
      partnerId: input.partnerId, orgId: input.orgId, surface: input.surface, modelId: input.legacyModel,
    })) ?? undefined;
    if (!offeringId) {
      throw new InvalidSessionModelError(`Model "${input.legacyModel}" is not available for AI sessions.`, 'invalid_model');
    }
  }
  const requested = offeringId || input.options
    ? { ...(offeringId ? { offeringId } : {}), ...(input.options ? { options: input.options } : {}), origin: 'user' as const }
    : undefined;
  const r = await resolveModel({
    partnerId: input.partnerId, orgId: input.orgId, userId: input.userId, surface: input.surface,
    ...(requested ? { requested } : {}),
  });
  if (!r.ok) {
    if (requested) throw new InvalidSessionModelError(r.message, r.reason);
    if (r.reason === 'connection_unavailable' && !isPlatformLlmConfigured(process.env.ANTHROPIC_API_KEY, 'agent_sdk')) {
      throw new LlmNotConfiguredError();
    }
    throw new LlmUnavailableError(r.message);
  }
  return {
    resolved: r,
    offeringId: r.offering.id,
    offeringPartnerId: input.partnerId,
    options: input.options ?? null,
    model: r.logicalModel,
    billingSource: r.funding,
  };
}
```

Add the imports: `findOfferingIdByModel` (`./candidateLoader`), `ensurePartnerCutover` (`./registryCutover`), `isPlatformLlmConfigured` and `LlmNotConfiguredError` (`../llm/llmAvailability`), `LlmUnavailableError` (`../llm/llmConfigResolver`), `type AiBillingSource` (`../aiCostTracker`), `type ResolvedModel` (`./resolveModel`) and `type ResolveFailureReason` (`./eligibility`).

- [ ] **Step 4: Wire every create route**

**`createSession` (`aiAgent.ts`).** Replace `resolveLlmConfigForOrg(orgId)` → `assertSessionModelAllowed` → `billingSource` with:

```ts
  let choice: Pick<SessionModelChoice, 'offeringId' | 'options' | 'model' | 'billingSource'> & { offeringPartnerId: string | null };
  if (isOpenAICompatibleProvider()) {
    // Env OpenAI-compatible chat (review finding 12): legacy resolution, no
    // offering, until W06 absorbs this path. Byte-for-byte today's checks.
    const resolved = await resolveLlmConfigForOrg(orgId);
    if (llmUnusableCode(resolved) === 'ai_not_configured') throw new LlmNotConfiguredError();
    if (resolved.source === 'unavailable') throw new LlmUnavailableError();
    if (options.offeringId || options.options || (options.model && options.model !== resolved.model)) {
      throw new InvalidSessionModelError('Model selection is not available on this deployment.', 'invalid_model');
    }
    choice = {
      offeringId: null, offeringPartnerId: null, options: null, model: resolved.model,
      billingSource: resolved.source === 'partner' ? 'partner_key' : 'platform',
    };
  } else {
    const partnerId = await readOrgPartnerId(orgId);
    if (!partnerId) throw new LlmUnavailableError();
    choice = await chooseSessionModel({
      partnerId, orgId, userId: auth.user.id, surface: 'chat',
      ...(options.offeringId ? { offeringId: options.offeringId } : {}),
      ...(options.options ? { options: options.options } : {}),
      ...(options.model ? { legacyModel: options.model } : {}),
    });
  }
```

The insert sets `model: choice.model, offeringId: choice.offeringId, offeringPartnerId: choice.offeringPartnerId, options: choice.options, billingSource: choice.billingSource`. Delete `assertSessionModelAllowed`. Keep the `resolveLlmConfigForOrg` and `llmUnusableCode` imports, which now serve only the env branch. Task 17's contract allows `resolveLlmConfigForOrg` until W06. Topology sessions use this same function, so `surface: 'chat'` is right for both (spec §4).

The script-builder, helper and Office creates do **not** take this branch. On `origin/main` the env path serves `chat` only (`isPlatformLlmConfigured(…, 'chat')`), so those surfaces already needed an Anthropic credential.

**`packages/shared/src/validators/ai.ts`.**

```ts
export const createAiSessionSchema = z.object({
  // … existing fields …
  /** Registry offering to run this session on (#7598). */
  offeringId: z.string().uuid().optional(),
  options: offeringOptionsSchema.partial().optional(),
  /** @deprecated W03: a model id is mapped to the partner's offering for it; W05 removes it. */
  model: z.string().max(100).optional(),
});
```

**`POST /ai/sessions` error mapping.** The `InvalidSessionModelError` branch returns:

```ts
    if (err instanceof InvalidSessionModelError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
```

**Script builder** (`routes/scriptAi.ts` + `createScriptBuilderSession`): resolve `chooseSessionModel({ partnerId, orgId, userId: auth.user.id, surface: 'script_builder' })`. Pass the choice into `createScriptBuilderSession(auth, body, choice)`, which inserts the same five columns.

**Helper** (`routes/helper/index.ts` create): `chooseSessionModel({ partnerId: auth.helperDevicePartnerId!, orgId: device.orgId, userId: null, surface: 'helper' })`, then insert the five columns. A missing `helperDevicePartnerId` is the existing 503.

**Office** (`routes/clientAi/sessions.ts` create): `chooseSessionModel({ partnerId, orgId: auth.orgId, userId: null, surface: 'office_chat' })`. Get `partnerId` from `readOrgPartnerId(auth.orgId)`. `runClientPreflight(c, auth, policy, choice.resolved)` runs before the insert. **`policy.allowedModels` is no longer read** (delete the `legacyOfficeChatModel` call W02 introduced here). W02 backfilled it into the `office_chat` assignment (P12), and W04 replaces its editor. Add a one-line comment saying so where `allowedModels[0]` was.

- [ ] **Step 5: Rewrite W00's session-model tests and the route tests**

- `aiAgent.sessionModel.test.ts` (W00): replace the `assertSessionModelAllowed` cases with assertions that `createSession` inserts `offeringId` / `offeringPartnerId` / `options` / `model` / `billingSource` from a mocked `chooseSessionModel`, and propagates `InvalidSessionModelError`.
- `aiAgent.sessionModel.test.ts`, new `describe('env OpenAI-compatible deployment (finding 12)')`. Set `MCP_LLM_PROVIDER=openai-compatible` through the config mock, **delete `ANTHROPIC_API_KEY` and every `PLATFORM_LLM_CREDENTIAL_ENV_KEYS` var**, and leave `chooseSessionModel` and `resolveModel` unmocked so a call fails loudly. The legacy resolver mock returns `{ source: 'platform', model: 'gpt-4o-mini' }`. Cases:
  1. `createSession(auth, {})` resolves, `chooseSessionModel` is never called, and the insert carries `{ offeringId: null, offeringPartnerId: null, options: null, model: 'gpt-4o-mini', billingSource: 'platform' }`.
  2. `{ offeringId: <uuid> }` and `{ model: 'claude-opus-5-5' }` each reject `InvalidSessionModelError` with code `invalid_model`, and nothing is inserted.
  3. The legacy resolver returning `{ source: 'unavailable' }` rejects `LlmUnavailableError`.
- The **execution** half of finding 12 is pinned in Task 7 Step 10's `runPreFlightChecks` cases (`services/aiAgentSdk.test.ts`).
- `ai_sessions_crud.test.ts`: `POST /ai/sessions` with `{ offeringId: <foreign uuid> }` → mocked `createSession` rejects `new InvalidSessionModelError('This AI model is not available here. Choose another model.', 'not_permitted')` → expect `400` and `{ error, code: 'not_permitted' }`.
- `helper/index.test.ts`, `scriptAi_sessions.test.ts`, `clientAi/sessions.create.test.ts`: mock `chooseSessionModel` to return `{ resolved: makeResolvedModel(), offeringId: 'off-1', offeringPartnerId: 'partner-1', options: null, model: 'claude-sonnet-5-5', billingSource: 'platform' }`, and assert the insert values carry those five fields. In the Office test, also assert the insert's `model` no longer equals `policy.allowedModels[0]` when they differ.

- [ ] **Step 5A: Drop the stale `ai_sessions.model` default (W02 handoff #5)**

On `origin/main` the column is `model varchar(100) NOT NULL DEFAULT 'claude-sonnet-4-5-20250929'` (`db/schema/ai.ts:38`). W02 Task 6 deferred dropping the default because several suites insert sessions with no model. Every production insert now names its model:
- `createSession`, script builder, helper and Office write `choice.model`;
- `executionLedger.createAgentRunSession` writes `args.model`;
- `mcpToolExecutionLedger` writes `'external-mcp'`.

A row with no model must therefore fail loudly instead of carrying a retired id.

First, the failing assertion. Append it to the Task 2 integration file, which already replays real migrations:

```ts
// apps/api/src/__tests__/integration/resolveModel.integration.test.ts — append
it('ai_sessions.model has no default: an insert without a model fails (W02 handoff #5)', async () => {
  const s = await seedRegistryPartner('platform');
  await expect(sys(() => db.execute(sql`INSERT INTO ai_sessions (org_id, user_id, type) VALUES (${s.orgId}::uuid, ${s.userId}::uuid, 'general')`)))
    .rejects.toMatchObject({ cause: expect.objectContaining({ code: '23502' }) });
});
```

Run it (`npx vitest run --config vitest.integration.config.ts src/__tests__/integration/resolveModel.integration.test.ts`). It FAILS: the insert succeeds on the default. Then:

```sql
-- apps/api/migrations/2026-11-19-100600-ai-sessions-model-drop-default.sql
-- AI model registry W03 (#7601), W02 handoff #5 / spec §5.6: every session is
-- created on a resolved offering, which names its model. The stale default
-- named a retired model id. DROP DEFAULT is idempotent; no rows are written.
ALTER TABLE public.ai_sessions ALTER COLUMN model DROP DEFAULT;
```

In `db/schema/ai.ts`, change `model: varchar('model', { length: 100 }).notNull().default('claude-sonnet-4-5-20250929'),` to `model: varchar('model', { length: 100 }).notNull(),`. Remove the `apps/api/src/db/schema/ai.ts` `ai_sessions.model` mention from Task 17's literal allowlist reason. The `ai_budgets.allowed_models` default stays until W08.

Sweep the inserts that relied on the default:
- `npx tsc --noEmit -p tsconfig.json` now flags every Drizzle `insert(aiSessions).values({…})` without `model`, because it is a required insert field. This covers `__tests__/integration/agentRunLineageFixtures.ts:166` on `origin/main`. Add `model: 'claude-sonnet-5-5'`; test files may use literals.
- Raw SQL inserts are invisible to tsc. Run `git grep -n "INSERT INTO ai_sessions" -- apps/api/src ee` and add `model` to every column list that lacks it. On `origin/main` that includes `topologyAiReadScope.integration.test.ts:214–219`. Those three statements assert `23503` / `23514`, and Postgres checks `NOT NULL` first, so without a `model` they would fail with `23502`.
- W02's note names `ai-budget-reservations.integration.test.ts`. It inserts through a helper; fix the helper.

Run `pnpm db:check-drift` (expected clean), then the integration files touched by the sweep.

- [ ] **Step 6: Run and commit**

Run: `cd apps/api && npx vitest run src/services/aiModels/sessionModel.test.ts src/services/aiAgent src/routes/ai_sessions src/routes/helper src/routes/scriptAi src/routes/clientAi src/services/scriptBuilderService.test.ts`
Expected: PASS.

Run: `cd packages/shared && npx vitest run src/validators/ai && cd ../../apps/api && npx tsc --noEmit -p tsconfig.json`
Expected: PASS / no errors.

```bash
git add apps/api/migrations/2026-11-19-100600-ai-sessions-model-drop-default.sql apps/api/src/db/schema/ai.ts \
  apps/api/src/__tests__/integration \
  apps/api/src/services/aiModels/sessionModel.ts apps/api/src/services/aiModels/sessionModel.test.ts \
  apps/api/src/services/aiAgent.ts apps/api/src/services/aiAgent.sessionModel.test.ts apps/api/src/services/aiOfferableModels.ts \
  apps/api/src/routes/ai.ts apps/api/src/routes/ai_sessions_crud.test.ts packages/shared/src/validators/ai.ts \
  apps/api/src/routes/scriptAi.ts apps/api/src/services/scriptBuilderService.ts apps/api/src/routes/scriptAi_sessions.test.ts \
  apps/api/src/routes/helper apps/api/src/routes/clientAi
git commit -m "feat(ai): sessions are created on a resolved offering; free-form session model removed (#7601)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 10: Messages API one-shots on a session or a technician — ticket draft (inherits chat) and Office ticket

These two one-shots now share one shape:
1. resolve;
2. admit with `resolved.funding`;
3. reserve with the binding;
4. `anthropicClientFor`;
5. `createMessage`;
6. `messagesUsage` over **every** attempt (both drafts retry once on a parse failure);
7. `settleInvocation`.

The services stop resolving clients themselves: the `getAnthropicClientForPartner` fallback inside them is deleted. They take the `ResolvedModel` and a client, and return the `MessageAttempt[]` they made, so the route bills them. Cache tokens are now priced too; the legacy `recordUsage` dropped them.

- **Ticket draft** is not its own surface (spec §4: it inherits the chat session's offering). It resolves `resolveSessionTurn({ surface: 'chat' })` and writes ledger rows with `surface: 'chat'`, `source_ref: 'ticket_draft'`.
- **Office ticket** resolves the `office_ticket` surface for the technician (`auth.userId`). Its route-level `deductBillingCredits` disappears, because `settleInvocation` does it.

**Files:**
- Modify: `apps/api/src/services/aiTicketDraft.ts` (`DraftInput`, `DraftResult`, `TicketDraftFailedError`, `draftTicketFromTranscript` ~L84–175)
- Modify: `apps/api/src/routes/ai.ts` (ticket-draft route ~L490–621)
- Modify: `apps/api/src/services/officeAddin/aiEmailDraft.ts` (`EmailDraftInput`, `EmailDraftResult`, `EmailDraftFailedError`, `draftTicketFromEmail` ~L99–175)
- Modify: `apps/api/src/routes/officeAddin/tickets.ts` (`recordDraftUsage` ~L296–335, `POST /draft` ~L382–540)
- Modify tests: `apps/api/src/services/aiTicketDraft.test.ts`, `apps/api/src/routes/ai.ticket.test.ts`, `apps/api/src/services/officeAddin/aiEmailDraft.test.ts`, `apps/api/src/routes/officeAddin/tickets.test.ts`
- Modify: `apps/api/src/services/aiModels/parity/w03Surfaces.parity.test.ts` (append two `describe` blocks)

**Interfaces:**
- Consumes: Task 3/4/5/6/7 (`resolveModel`, `resolveSessionTurn`, `anthropicClientFor`, `createMessage`, `MessageAttempt`, `messagesUsage`, `settleInvocation`, `costEstimator`, `turnBindingFrom`).
- Produces:
  ```ts
  // aiTicketDraft.ts
  interface DraftInput { messages; contextSnapshot; elapsedMinutes; resolved: ResolvedModel; client: Anthropic; budgetCents?: number }
  interface DraftResult { subject; problemSummary; resolutionSummary; wasFixed; suggestedTimeMinutes; attempts: MessageAttempt[] }
  class TicketDraftFailedError extends Error { readonly attempts: MessageAttempt[]; readonly providerOutcomeUnknown: boolean }
  // aiEmailDraft.ts — the same three changes:
  interface EmailDraftInput { /* … */ resolved: ResolvedModel; client: Anthropic; budgetCents?: number }
  interface EmailDraftResult { subject; summary; suggestedTimeMinutes; attempts: MessageAttempt[] }
  class EmailDraftFailedError extends Error { readonly attempts: MessageAttempt[]; readonly providerOutcomeUnknown: boolean }
  ```

- [ ] **Step 1: Write the failing service tests**

Replace the `getAnthropicClientForPartner` / `resolveWireModel` mocks in `aiTicketDraft.test.ts` (and the same pair in `aiEmailDraft.test.ts`) with a fake client passed in, and add:

```ts
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';

it('calls through createMessage with the resolved wire model and returns every attempt for billing', async () => {
  const create = vi.fn()
    .mockResolvedValueOnce({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }],
      usage: { input_tokens: 100, output_tokens: 10 } })
    .mockResolvedValueOnce({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ subject: 's', problemSummary: 'p', resolutionSummary: 'r', wasFixed: true, suggestedTimeMinutes: 5 }) }],
      usage: { input_tokens: 120, output_tokens: 30 } });
  const out = await draftTicketFromTranscript({
    messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }],
    contextSnapshot: null, elapsedMinutes: 10,
    resolved: makeResolvedModel('catalog'), client: { messages: { create } } as never,
  });
  expect(create.mock.calls[0]![0]).toMatchObject({ model: 'anthropic/claude-sonnet-5.5', max_tokens: 1024 });
  expect(out.attempts).toHaveLength(2);
});

it('a provider throw carries the attempts made so far and marks the outcome unknown', async () => {
  const create = vi.fn().mockRejectedValue(new Error('socket'));
  await expect(draftTicketFromTranscript({
    messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }],
    contextSnapshot: null, elapsedMinutes: 10, resolved: makeResolvedModel(), client: { messages: { create } } as never,
  })).rejects.toMatchObject({ name: 'TicketDraftFailedError', attempts: [], providerOutcomeUnknown: true });
});
```

Add to `ai.ticket.test.ts` (mock `../services/aiModels/sessionModel`, `../services/aiModels/connectionFactory` → `anthropicClientFor`, and `../services/aiModels/settleInvocation`):

```ts
it('ticket draft inherits the chat session offering, reserves with its funding + binding, and settles every attempt', async () => {
  const model = makeResolvedModel('anthropic_byok');
  resolveSessionTurnMock.mockResolvedValue(model);
  draftTicketFromTranscriptMock.mockResolvedValue({ subject: 's', problemSummary: 'p', resolutionSummary: '', wasFixed: false,
    suggestedTimeMinutes: 3, attempts: [{ wireModel: 'claude-sonnet-5-5', message: msgFixture }] });
  await app.request(`/ai/sessions/${SESSION_ID}/ticket-draft`, { method: 'POST', headers: authHeaders });
  expect(resolveSessionTurnMock).toHaveBeenCalledWith({ sessionId: SESSION_ID, surface: 'chat', userId: USER_ID, maxTokens: 1024, transport: 'messages_api' });
  expect(reserveAiBudgetMock).toHaveBeenCalledWith(expect.objectContaining({ billingSource: 'partner_key', binding: turnBindingFrom(model) }));
  expect(settleInvocationMock).toHaveBeenCalledWith(expect.objectContaining({
    binding: turnBindingFrom(model), sourceRef: 'ticket_draft', userId: USER_ID, sessionId: null,
  }));
});
```

Add to `ai.ticket.test.ts` (finding 5):

```ts
it('exhausted platform credits refuse the ticket draft before any reservation or provider call', async () => {
  resolveSessionTurnMock.mockResolvedValue(makeResolvedModel('platform'));
  checkBudgetDetailedMock.mockResolvedValue({ message: 'You are out of AI credits.', reason: 'credits_exhausted', permanent: false });
  const res = await app.request(`/ai/sessions/${SESSION_ID}/ticket-draft`, { method: 'POST', headers: authHeaders });
  expect(res.status).toBe(402);
  expect(checkBudgetDetailedMock).toHaveBeenCalledWith(ORG_ID, 'platform');
  expect(reserveAiBudgetMock).not.toHaveBeenCalled();
  expect(draftTicketFromTranscriptMock).not.toHaveBeenCalled();
});
```

Add the equivalent to `tickets.test.ts`:
- `resolveModel` is called with `{ partnerId, orgId, userId, surface: 'office_ticket', maxTokens: 1024 }`;
- `checkBudgetDetailed` is called with `resolved.funding`;
- `settleInvocation` gets `sourceRef: 'office_email_draft'`;
- `deductBillingCredits` is **not** called by the route.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/aiTicketDraft.test.ts src/routes/ai.ticket.test.ts src/services/officeAddin/aiEmailDraft.test.ts src/routes/officeAddin/tickets.test.ts`
Expected: FAIL. `resolved` is not in the input type, `attempts` is undefined, and the routes still call `getAnthropicClientForPartner`.

- [ ] **Step 3: Change the services**

```ts
// apps/api/src/services/aiTicketDraft.ts — the attempt loop
export async function draftTicketFromTranscript(input: DraftInput): Promise<DraftResult> {
  const hasAssistant = input.messages.some((m) => m.role === 'assistant' && m.content && m.content.trim().length > 0);
  if (!hasAssistant) throw new ThinTranscriptError();
  const userContent = buildUserContent(input);
  const maxTokens = input.budgetCents === undefined
    ? 1024
    : maxOutputTokensForAiBudget({
      prompt: `${SYSTEM_PROMPT}\n${userContent}`,
      requestedMaxOutputTokens: 1024,
      budgetCents: input.budgetCents / 2,                 // either attempt may use its full ceiling
      calculateCostCents: costEstimator(input.resolved),  // registry rate, never a model-id table
    });
  if (maxTokens === null) throw new TicketDraftFailedError('Ticket draft prompt exceeds the reserved budget', [], false);

  const attempts: MessageAttempt[] = [];
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    let outcome;
    try {
      outcome = await createMessage(input.client, input.resolved, {
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      });
    } catch (error) {
      throw new TicketDraftFailedError('Ticket draft provider outcome is unknown', attempts, true, { cause: error });
    }
    attempts.push(...outcome.attempts);
    const text = lastTextBlock(outcome.message.content);
    if (text) {
      try {
        const parsed = llmSchema.parse(JSON.parse(text));
        return {
          subject: parsed.subject,
          problemSummary: parsed.problemSummary,
          resolutionSummary: parsed.wasFixed ? parsed.resolutionSummary : '',
          wasFixed: parsed.wasFixed,
          suggestedTimeMinutes: Math.min(parsed.suggestedTimeMinutes, Math.max(0, Math.round(input.elapsedMinutes))),
          attempts,
        };
      } catch (err) { lastErr = err; }
    }
  }
  throw new TicketDraftFailedError(`Failed to draft ticket from transcript: ${String(lastErr)}`, attempts, false);
}

export class TicketDraftFailedError extends Error {
  constructor(
    message: string,
    public readonly attempts: MessageAttempt[],
    public readonly providerOutcomeUnknown = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TicketDraftFailedError';
  }
}
```

Make the same change to `draftTicketFromEmail` in `aiEmailDraft.ts`. `EmailDraftFailedError(message, attempts, providerOutcomeUnknown, options)`; `fail` passes `attempts`; the result returns `attempts`. Delete both services' `getAnthropicClientForPartner` / `resolveWireModel` fallback blocks and their `...messagesApiWireOptions(wireModel, maxTokens)` spreads (W01, P4). Also remove `partnerId`, `orgId` and `model` from the input types.

- [ ] **Step 4: Change the two routes**

```ts
// routes/ai.ts — ticket-draft route, replacing getAnthropicClientForPartner … resolveWireModel … recordUsage
    // The ticket draft inherits the chat session's offering (spec §4) but is a
    // Messages API one-shot, so it resolves for that transport's carriage.
    const turn = await resolveSessionTurn({ sessionId, surface: 'chat', userId: auth.user.id, maxTokens: 1024, transport: 'messages_api' });
    if (!turn.ok) return c.json({ error: turn.message, code: turn.reason, recoverable: true }, 409);
    let client;
    try {
      client = anthropicClientFor(turn, { surface: 'one_shot_ticket_draft', orgId: session.orgId });
    } catch (err) {
      if (err instanceof LlmUnavailableError) return c.json({ error: 'ai_unavailable' }, 503);
      throw err;
    }
    // Review finding 5: reserveAiBudget enforces caps, NOT prepaid credits or
    // the plan gate — check them with the resolved funding before reserving.
    const denial = await checkBudgetDetailed(session.orgId, turn.funding);
    if (denial) return c.json({ error: denial.message }, 402);
    const binding = turnBindingFrom(turn);
    const reservation = await reserveAiBudget({
      orgId: session.orgId,
      idempotencyKey: `ticket-draft:${sessionId}:${crypto.randomUUID()}`,
      billingSource: turn.funding,
      binding,
    });
    if (reservation.kind === 'denied') return c.json({ error: reservation.message }, 429);
    const settle = (attempts: MessageAttempt[]) => {
      const { usage, outcome } = attempts.length > 0
        ? messagesUsage(binding, attempts)
        : { usage: [], outcome: { stopReason: 'error', refused: false, refusalCategory: null, fallbackUsed: false, servedModel: binding.wireModel, sdkReportedCostUsd: null } };
      return settleInvocation({
        binding, orgId: session.orgId, userId: auth.user.id, sessionId: null, agentRunId: null,
        sourceRef: 'ticket_draft', usage, outcome, reservationId: reservation.reservationId,
      });
    };
    try {
      const draft = await draftTicketFromTranscript({
        messages, contextSnapshot, elapsedMinutes, resolved: turn, client,
        ...(reservation.kind === 'reserved' ? { budgetCents: reservation.reservedCostCents } : {}),
      });
      await settle(draft.attempts);
      // … existing response building, unchanged …
    } catch (err) {
      if (err instanceof TicketDraftFailedError) {
        if (err.providerOutcomeUnknown && err.attempts.length === 0) {
          await markAiBudgetReservationIndeterminate({ orgId: session.orgId, reservationId: reservation.reservationId })
            .catch((e) => captureException(e));
        } else {
          await settle(err.attempts).catch((e) => captureException(e));
        }
      } else {
        await releaseUnusedAiBudgetReservation({ orgId: session.orgId, reservationId: reservation.reservationId })
          .catch((e) => captureException(e));
      }
      throw err;   // existing error → response mapping below is unchanged
    }
```

> `session.model ?? resolveDefaultModel()` goes away: the session's stored offering is the request. Ledger rows carry `sessionId: null` deliberately. A ticket draft is not a chat turn, and putting its cost into the chat session's `total_cost_cents` would double-attribute it in the session list. The ledger keeps it as `surface: 'chat', source_ref: 'ticket_draft'`.

**`routes/officeAddin/tickets.ts`.** Delete `recordDraftUsage`. In `POST /draft`:
- Replace `getAnthropicClientForPartner` + `llmConfig.model` + `resolveWireModel` + the injected `calculateCostCents` with:

```ts
    const resolved = await resolveModel({
      partnerId: auth.partnerId, orgId: input.orgId, userId: auth.userId, surface: 'office_ticket', maxTokens: 1024,
    });
    if (!resolved.ok) return c.json({ error: resolved.message, code: resolved.reason, recoverable: true }, 409);
    const client = anthropicClientFor(resolved, { surface: 'one_shot_email_draft', orgId: input.orgId });
```

- `checkBudgetDetailed(input.orgId, resolved.funding)`.
- `reserveAiBudget({ …, billingSource: resolved.funding, binding: turnBindingFrom(resolved) })`.
- `draftTicketFromEmail({ …, resolved, client, budgetCents })`.
- Settle with `settleInvocation({ …, userId: auth.userId, sessionId: null, sourceRef: 'office_email_draft', usage, outcome, reservationId })`, using the same `settle(attempts)` / indeterminate / release split as the ticket-draft route above.
- Keep `partnerAiEnabled(auth.partnerId)` as the entitlement gate it is today.

- [ ] **Step 5: Append the two parity suites**

Append to `apps/api/src/services/aiModels/parity/w03Surfaces.parity.test.ts` (its mock block and helpers come from Task 7):

```ts
describe('W03 parity: ticket draft (inherits the chat session offering; Messages API transport)', () => {
  it('session queries', async () => {
    // The legacy ticket draft dispatched session.model through the chat session's
    // resolved config, so its golden IS the session golden.
    await assertSurfaceParity({
      select: (q) => q.kind === 'session',
      bind,
      registrySide: async (_f, q) => toSurfaceUse(await resolveSessionTurn({
        sessionId: (q as { sessionId: string }).sessionId, surface: 'chat', userId: 'parity-user',
        maxTokens: 1024, transport: 'messages_api',
      })),
    });
  });
});

describe('W03 parity: office_ticket', () => {
  it('surface queries', async () => {
    await assertSurfaceParity({ select: surfaceQuery('office_ticket'), bind, registrySide: viaAssignment('office_ticket', true) });
  });
});
```

- [ ] **Step 6: Run and commit**

Run: `cd apps/api && npx vitest run src/services/aiTicketDraft.test.ts src/routes/ai.ticket.test.ts src/services/officeAddin src/routes/officeAddin/tickets.test.ts`
Expected: PASS.

Run: `cd apps/api && npx vitest run src/services/aiModels/parity/w03Surfaces.parity.test.ts && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/topologyAiFailureAccounting.integration.test.ts`
Expected: PASS.

```bash
git add apps/api/src/services/aiTicketDraft.ts apps/api/src/services/aiTicketDraft.test.ts apps/api/src/routes/ai.ts \
  apps/api/src/routes/ai.ticket.test.ts apps/api/src/services/officeAddin apps/api/src/routes/officeAddin \
  apps/api/src/services/aiModels/parity/w03Surfaces.parity.test.ts
git commit -m "feat(ai): ticket draft and Office ticket resolve, admit and settle through the registry (#7601)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 11: Script reviewer — the `script_reviewer` assignment replaces `reviewer_model` and the env var at runtime

This task fixes two defects at once:
- The reviewer's funding came from `getLlmBillingSourceForOrg`, independent of the client it actually used (quorum #4).
- Its reservation was taken **before** the model was chosen.

Now the order is: resolve `script_reviewer` (a system call, so no permission gate) → if ineligible, `failReview` with the resolver's message and **no** reservation → reserve with `resolved.funding` + binding → `createMessage` → `settleInvocation`.
- **`ai_script_policies.reviewer_model`.** It is no longer read at runtime. The column stays until W08, and W04 replaces its free-text field. W02 backfilled its value into the assignment (P12).
- **`BREEZE_AI_SCRIPT_REVIEWER_MODEL`.** The reviewer stops reading it. The variable and its config constant **stay**, because W02's projection (P12) still reads them through `resolveReviewerDefaultModel` / `AI_SCRIPT_REVIEWER_MODEL` for the cutover run and for partners bootstrapped after it (Task 6A). The docs mark it deprecated, and W08 removes it with the projection.

**Files:**
- Modify: `apps/api/src/services/scriptProposals/reviewer.ts` (delete `resolveReviewerModel` ~L140–150; the job body ~L350–520)
- Delete: `apps/api/src/services/scriptProposals/reviewer.resolveModel.test.ts`
- Modify: `apps/api/src/services/system/connections/registry.ts` (~L231: mark the entry deprecated), `apps/docs/src/content/docs/deploy/environment.mdx` (the reviewer-model row)
- Modify: `apps/api/src/services/scriptProposals/policy.ts` (~L100: keep merging `reviewerModel` for the read API, with a comment that the runtime ignores it)
- Modify: `apps/api/src/services/scriptProposals/runScriptReview.test.ts`
- Modify: `apps/api/src/services/aiModels/parity/w03Surfaces.parity.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: Tasks 2–6 (`readOrgPartnerId`, `resolveModel`, `anthropicClientFor`, `createMessage`, `messagesUsage`, `settleInvocation`, `turnBindingFrom`).
- Produces: no new exports. `resolveReviewerModel` is removed. `AI_SCRIPT_REVIEWER_MODEL` / `resolveReviewerDefaultModel` stay for W02's projection.

- [ ] **Step 1: Write the failing reviewer tests**

In `runScriptReview.test.ts`, replace the `../llm/llmConfigResolver` mock (`getLlmBillingSourceForOrg`, `getAnthropicClientForPartner`, `resolveWireModel`) and the `../aiCostTracker` `recordUsage` mock (keep a `checkBudgetDetailed: shared.checkBudgetDetailed` mock there, default `null`) with mocks of `../aiModels/resolveModel` (`resolveModel`), `../aiModels/candidateLoader` (`readOrgPartnerId`), `../aiModels/connectionFactory` (`anthropicClientFor` → fake client, plus the real `createMessage`) and `../aiModels/settleInvocation` (`settleInvocation`). Then add:

```ts
it('resolves the script_reviewer assignment BEFORE reserving, and reserves with its funding + binding', async () => {
  const model = makeResolvedModel('anthropic_byok', { surface: 'script_reviewer' });
  shared.resolveModel.mockResolvedValue(model);
  await runScriptReview(JOB);
  expect(shared.resolveModel).toHaveBeenCalledWith({ partnerId: 'partner-1', orgId: JOB.orgId, surface: 'script_reviewer', maxTokens: 2000 });
  expect(shared.resolveModel.mock.invocationCallOrder[0]).toBeLessThan(shared.reserveAiBudget.mock.invocationCallOrder[0]!);
  expect(shared.reserveAiBudget).toHaveBeenCalledWith(expect.objectContaining({ billingSource: 'partner_key', binding: turnBindingFrom(model) }));
  expect(shared.settleInvocation).toHaveBeenCalledWith(expect.objectContaining({ sourceRef: `script-review:${JOB.proposalId}`, userId: null }));
});

it('an ineligible reviewer model fails the review with the resolver message and takes no reservation', async () => {
  shared.resolveModel.mockResolvedValue({ ok: false, reason: 'unpriced', recoverable: true, offeringId: 'o', message: 'This AI model has no price set and cannot be used yet.' });
  await runScriptReview(JOB);
  expect(shared.reserveAiBudget).not.toHaveBeenCalled();
  expect(shared.failReview).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('no price set'));
});

it('exhausted platform credits fail the review before any reservation or provider call (finding 5)', async () => {
  shared.resolveModel.mockResolvedValue(makeResolvedModel('platform', { surface: 'script_reviewer' }));
  shared.checkBudgetDetailed.mockResolvedValue({ message: 'You are out of AI credits.', reason: 'credits_exhausted', permanent: false });
  await runScriptReview(JOB);
  expect(shared.reserveAiBudget).not.toHaveBeenCalled();
  expect(shared.createCalls).toHaveLength(0);
  expect(shared.failReview).toHaveBeenCalledWith(expect.anything(), 'You are out of AI credits.');
});

it('a stored reviewer_model is ignored at runtime (the assignment is authoritative)', async () => {
  shared.effectivePolicy.mockResolvedValue({ reviewerModel: 'claude-opus-4-8' });
  shared.resolveModel.mockResolvedValue(makeResolvedModel());
  await runScriptReview(JOB);
  expect(shared.createCalls[0]).toMatchObject({ model: 'claude-sonnet-5-5' });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/runScriptReview.test.ts`
Expected: FAIL. `resolveModel` is never called, and the reservation still uses `getLlmBillingSourceForOrg`.

- [ ] **Step 3: Rewrite the reviewer's dispatch**

Replace the block from `const billingSource = await getLlmBillingSourceForOrg(job.orgId)` through the `client.messages.create(...)` call with:

```ts
  const partnerId = await readOrgPartnerId(job.orgId);
  const resolved = partnerId
    ? await resolveModel({ partnerId, orgId: job.orgId, surface: 'script_reviewer', maxTokens: 2000 })
    : null;
  if (!resolved?.ok) {
    // Resolved BEFORE admission (quorum #4): an unusable reviewer model never
    // holds budget, and the proposal fails with a reason an admin can act on.
    return failReview(job, resolved ? resolved.message : 'No AI model is available for script review.');
  }
  // Review finding 5: credits + plan gate with the resolved funding, BEFORE the
  // reservation (reserveAiBudget only enforces caps).
  const denial = await checkBudgetDetailed(job.orgId, resolved.funding);
  if (denial) return failReview(job, denial.message);
  const binding = turnBindingFrom(resolved);
  const reservation = await reserveAiBudget({
    orgId: job.orgId,
    idempotencyKey: `script-review:${job.proposalId}:${job.attempt}`,
    billingSource: resolved.funding,
    binding,
  });
  if (reservation.kind === 'denied') return failReview(job, reservation.message);
  const settle = (attempts: MessageAttempt[]) => settleInvocation({
    binding, orgId: job.orgId, userId: null, sessionId: null, agentRunId: null,
    sourceRef: `script-review:${job.proposalId}`,
    ...(attempts.length > 0
      ? messagesUsage(binding, attempts)
      : { usage: [], outcome: { stopReason: 'error', refused: false, refusalCategory: null, fallbackUsed: false, servedModel: binding.wireModel, sdkReportedCostUsd: null } }),
    reservationId: reservation.reservationId,
  });
  const client = anthropicClientFor(resolved, { surface: 'script_review_verdict', orgId: job.orgId });
  const outcome = await createMessage(client, resolved, {
    max_tokens: 2000,
    system: REVIEWER_SYSTEM_PROMPT,
    messages: reviewerMessages,
  });
```

`REVIEWER_SYSTEM_PROMPT` and `reviewerMessages` stand for the `system` and `messages` values the current `client.messages.create` call passes (~L417–423). Carry them over unchanged; only `model`, `max_tokens` and the thinking spread move into `createMessage`.

Every later `recordUsage(null, orgId, model, in, out, false, billingSource, catalogPricing, reservationId)` (~L449, ~L499, ~L515) becomes `await settle(outcome.attempts)`. The early zero-cost settle at ~L374 ran before anything was dispatched, so it becomes `releaseUnusedAiBudgetReservation({ orgId: job.orgId, reservationId: reservation.reservationId })`.

A refusal from the reviewer (`outcome.message.stop_reason === 'refusal'`) fails the review with `refusalHeadline(category)` (Task 8), so the proposal shows why. Delete `resolveReviewerModel`, the `AI_SCRIPT_REVIEWER_MODEL` / `legacyReviewerModel` imports and W01's `...messagesApiWireOptions(wireModel, SCRIPT_REVIEW_MAX_OUTPUT_TOKENS)` spread.

Leave `config/env.ts` alone: W02's `legacyReconcile.ts` imports `AI_SCRIPT_REVIEWER_MODEL` and `resolveReviewerDefaultModel` (P12). In `services/system/connections/registry.ts`, mark the `BREEZE_AI_SCRIPT_REVIEWER_MODEL` row's description deprecated. In `deploy/environment.mdx`, change that variable's row to: "Deprecated: the script reviewer's model is set under AI Providers & Models → Defaults by feature, and your value was migrated there. Until that page ships, new partners still inherit this value."

- [ ] **Step 4: Append the parity suite**

```ts
// appended to apps/api/src/services/aiModels/parity/w03Surfaces.parity.test.ts
describe('W03 parity: script_reviewer', () => {
  it('surface queries (legacy reviewer_model / env route and its funding)', async () => {
    await assertSurfaceParity({ select: surfaceQuery('script_reviewer'), bind, registrySide: viaAssignment('script_reviewer', false) });
  });
});
```

- [ ] **Step 5: Run and commit**

Run: `cd apps/api && npx vitest run src/services/scriptProposals src/config`
Expected: PASS. `git grep -n "AI_SCRIPT_REVIEWER_MODEL\|legacyReviewerModel" -- apps/api/src/services/scriptProposals` must print nothing: the reviewer no longer reads either.

Run: `cd apps/api && npx vitest run src/services/aiModels/parity/w03Surfaces.parity.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS / no errors.

```bash
git add -A apps/api/src/services/scriptProposals apps/api/src/config apps/api/src/services/system/connections/registry.ts \
  apps/docs/src/content/docs/deploy/environment.mdx apps/api/src/services/aiModels/parity/w03Surfaces.parity.test.ts
git commit -m "feat(ai): script reviewer resolves its assignment before admission; reviewer env model removed (#7601)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 12: AI agents — resolve at admission and at run, wire translation, per-offering funding, `blocked` runs

Agents were the worst-drifted surface. They sent the **logical** model id with no wire translation, and a catalog partner's run threw building an unproxied SDK env. Funding came from `getLlmBillingSourceForOrg` in four places: admission, compute settlement ×2 and the run loop's compute leg. This task fixes all of it:
- **Admission** (`createAndEnqueueAgentRun`, step 7) resolves `ai_agents` for the policy's explicit offering (`origin: 'policy'`):
  - The offering must be in the `ai_agents` effective permitted set at run time (quorum #11). The bounded fallback applies.
  - `checkBudget`, `checkComputeCredits` and `reserveComputeCents` take `resolved.funding`.
  - The run row persists `funding_source`, so compute settlement never re-derives funding.
  - An unavailable model is the new skip reason `model_unavailable`, and notifies once per agent per day.
- **The run loop** re-resolves at dispatch (re-checked per dispatch) and reserves with the binding. It then:
  - takes a CONNECT-proxy egress grant for catalog connections (moved from the session manager into the factory);
  - dispatches with `sdkModelOptions`;
  - runs the mid-stream budget guard on the **registry** price;
  - settles through `settleInvocation` (`agent_run_id`, `user_id NULL`).
- **New terminal status `blocked`.** A run ends `blocked` with `error_code` `model_unavailable` (re-resolve failed) or `model_refused` (§9.1a), and the category goes in `outcome`. `blocked` is **neutral** for the circuit breaker: an admin's model choice is not an agent fault.
- **Write-time binding of the policy model (W02 handoff #5, deferred from spec §5.6 by W02 Task 6).** Until W03, W02's per-boot projection mapped `ai_agents.model` to `ai_agents.offering_id`. Task 6A runs that projection once per partner and never again, so after cutover nothing would map an edited `model`. Agent create/update would then be silently ignored at run time. `createAgent` / `updateAgent` therefore bind the model when they write it:
  - `bindAgentModel(owner, model)` runs the cutover gate first.
  - It maps the string to an offering on the `ai_agents` default's connection (`findOfferingIdByModel`, Task 2).
  - It checks the offering against the owner's `ai_agents` effective permitted set (partner-wide agent: the partner assignment; org agent: the merged one).
  - It writes `model`, `offering_id` and `offering_partner_id` together.
  - An unknown model id, or one outside the permitted set, is a **400** with code `invalid_model` / `not_permitted`. Nothing is written.
  - `model: null` clears both columns, so the agent follows the assignment.
  - The run-time check above stays, because the permitted set can narrow after the write.

**Files:**
- Create: `apps/api/migrations/2026-11-19-100200-ai-agent-runs-blocked-funding.sql`
- Create: `apps/api/src/services/aiAgents/modelBlocked.ts`, `apps/api/src/services/aiAgents/modelBlocked.test.ts`
- Create: `apps/api/src/services/aiAgents/agentModelBinding.ts`, `apps/api/src/services/aiAgents/agentModelBinding.test.ts`
- Modify: `apps/api/src/services/aiAgents/agentService.ts` (`scalarPolicyColumns` ~L262–278, `createAgent` ~L631, `updateAgent` ~L720) and `apps/api/src/routes/aiAgents.ts` (`mapError` ~L226)
- Modify tests: `agentService.test.ts`, `routes/aiAgents.test.ts` (the hoisted `agentService` mock gains `AgentModelNotAllowedError`)
- Modify: `apps/api/src/services/aiModels/parity/w03Surfaces.parity.test.ts` (append a `describe`)
- Modify: `packages/shared/src/types/aiAgents.ts` (`AI_AGENT_RUN_STATUSES` ~L25)
- Modify: `apps/api/src/db/schema/aiAgents.ts` (`aiAgentRuns.fundingSource`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`ai_agent_runs` → `included` gains `funding_source`)
- Modify: `apps/api/src/services/aiAgents/runService.ts` (`AgentRunSkipReason` ~L360, admission step 7 ~L1428–1480, the run insert ~L1574–1620, compute settles ~L1761 and ~L1920)
- Modify: `apps/api/src/services/aiAgents/analysisAdmission.ts` (skip-reason mapping)
- Modify: `apps/api/src/services/aiAgents/runLoop.ts` (`driveSdkLoop` ~L1783–2260, `resultCostCents` ~L1411 deleted, the catch ~L2516, compute settle ~L2629)
- Modify: `apps/api/src/services/aiAgents/agentCircuit.ts` (`classifyTerminal`: `blocked` → `neutral`)
- Modify: `apps/api/src/services/aiModels/connectionFactory.ts` (`grantCatalogSdkEgress`), `apps/api/src/services/streamingSessionManager.ts` (use it in place of its inline grant ~L1192–1232)
- Modify: `apps/api/src/services/aiToolsAiAgentGovernance.ts` (~L146 status description string)
- Modify: web exhaustive status maps (`apps/web/src/components/ai/AiRunCard.tsx` `TERMINAL_BY_STATUS`, plus every other `Record<AiAgentRunStatus, …>` the compiler flags) and `apps/web/src/locales/*/common.json` (8 locales)
- Modify tests: `runLoop*.test.ts`, `runService.test.ts`, `analysisProfile.admission.test.ts`, `agentCircuit.test.ts`

**Interfaces:**
- Consumes: Tasks 2–7 (`readOrgPartnerId`, `resolveModel`, `sdkModelOptions`, `turnBindingFrom`, `observeSdkMessage`, `newSdkTurnObservation`, `sdkTurnUsage`, `priceUsage`, `sumCostCents`, `settleInvocation`, `applyPromptProfile`, `refusalHeadline`); `resolveRecipientUserIds` (`aiAgents/recipients.ts`); `inSystemDbContext` (`services/outcomeProbes.ts`); `createNotification` (`services/userNotifications.ts`); `getLlmEgressProxy`, `recordLlmEgressEvent`.
- Produces:
  ```ts
  // modelBlocked.ts
  export type ModelBlockedReason = 'model_unavailable' | 'model_refused';
  export function blockedOutcome(reason: ModelBlockedReason, detail: {
    message: string; refusalCategory?: string | null; offeringId?: string | null; requestedModel?: string | null;
  }): Record<string, unknown>;
  export function modelBlockedDedupeKey(orgId: string, agentId: string, reason: ModelBlockedReason, now: Date): string;
  export function notifyModelBlocked(input: {
    orgId: string; agentId: string; agentName: string;
    agent: { orgId: string | null; partnerId: string | null; recipients: Partial<AiAgentRecipients> };
    reason: ModelBlockedReason; message: string; now?: Date;
  }): Promise<void>;
  export class AgentRunBlockedError extends Error { readonly errorCode: ModelBlockedReason; readonly outcome: Record<string, unknown> }
  // agentModelBinding.ts (W02 handoff #5)
  export class AgentModelNotAllowedError extends Error { readonly status: 400 | 503; readonly code: 'invalid_model' | 'not_permitted' | 'registry_unavailable' }
  export function bindAgentModel(owner: AgentOwner, model: string | null): Promise<{
    model: string | null; offeringId: string | null; offeringPartnerId: string | null;
  }>;
  // connectionFactory.ts
  export function grantCatalogSdkEgress(resolved: ResolvedModel, input: {
    key: string; orgId: string; aiSessionId: string | null;
  }): Promise<{ proxyUrl: string; revoke: () => void } | null>;   // null for non-catalog connections
  // AI_AGENT_RUN_STATUSES gains 'blocked'; AgentRunSkipReason gains 'model_unavailable'
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/aiAgents/modelBlocked.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ recipients: vi.fn(), createNotification: vi.fn() }));
vi.mock('./recipients', () => ({ resolveRecipientUserIds: m.recipients }));
vi.mock('../userNotifications', () => ({ createNotification: m.createNotification }));
vi.mock('../outcomeProbes', () => ({ inSystemDbContext: (fn: () => unknown) => fn() }));

import { blockedOutcome, modelBlockedDedupeKey, notifyModelBlocked } from './modelBlocked';

beforeEach(() => vi.clearAllMocks());

describe('modelBlocked', () => {
  it('the dedupe key is per org, agent, reason and UTC day (once per policy per day, spec §9.1)', () => {
    const k1 = modelBlockedDedupeKey('o', 'a', 'model_unavailable', new Date('2026-11-20T23:59:00Z'));
    const k2 = modelBlockedDedupeKey('o', 'a', 'model_unavailable', new Date('2026-11-20T00:01:00Z'));
    const k3 = modelBlockedDedupeKey('o', 'a', 'model_unavailable', new Date('2026-11-21T00:01:00Z'));
    expect(k1).toBe('ai-model-blocked-o-a-model_unavailable-2026-11-20');
    expect(k1).toBe(k2);
    expect(k3).not.toBe(k1);
    expect(modelBlockedDedupeKey('o', 'a', 'model_refused', new Date('2026-11-20T00:00:00Z'))).not.toBe(k1);
  });

  it('carries the refusal category in the run outcome', () => {
    expect(blockedOutcome('model_refused', { message: 'm', refusalCategory: 'cyber', offeringId: 'o1', requestedModel: 'claude-opus-5-5' }))
      .toEqual({ blockedReason: 'model_refused', message: 'm', refusalCategory: 'cyber', offeringId: 'o1', requestedModel: 'claude-opus-5-5' });
  });

  it('notifies every recipient with the day-scoped dedupe key', async () => {
    m.recipients.mockResolvedValue(['u1', 'u2']);
    await notifyModelBlocked({
      orgId: 'o', agentId: 'a', agentName: 'Triage', agent: { orgId: null, partnerId: 'p', recipients: {} },
      reason: 'model_unavailable', message: 'Model X is no longer available — choose another.',
      now: new Date('2026-11-20T12:00:00Z'),
    });
    expect(m.createNotification).toHaveBeenCalledTimes(2);
    expect(m.createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', orgId: 'o', type: 'ai', priority: 'high',
      dedupeKey: 'ai-model-blocked-o-a-model_unavailable-2026-11-20',
      link: '/ai-agents/runs#agent=a',
    }));
  });
});
```

Add to `runLoop.test.ts` (replace the `../llm/llmConfigResolver` mock with mocks of `../aiModels/candidateLoader` → `readOrgPartnerId`, `../aiModels/resolveModel` → `resolveModel`, `../aiModels/settleInvocation` → `{ settleInvocation, priceUsage: real, sumCostCents: real }`, and `../aiModels/connectionFactory` → `{ sdkModelOptions: real, grantCatalogSdkEgress }`):

```ts
it('catalog agent runs send the TRANSLATED wire model through a proxied env (legacy sent the logical id)', async () => {
  resolveModel.mockResolvedValue(makeResolvedModel('catalog', { surface: 'ai_agents' }));
  grantCatalogSdkEgress.mockResolvedValue({ proxyUrl: 'http://127.0.0.1:9999', revoke: vi.fn() });
  await runAgent(runFixture());
  expect(lastQueryOptions().model).toBe('anthropic/claude-sonnet-5.5');
  expect(lastQueryOptions().env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://gw.example.com', HTTPS_PROXY: 'http://127.0.0.1:9999' });
});

it('the policy offering is requested with origin policy', async () => {
  resolveModel.mockResolvedValue(makeResolvedModel('platform', { surface: 'ai_agents' }));
  await runAgent(runFixture({ effective: { offeringId: 'off-77' } }));
  expect(resolveModel).toHaveBeenCalledWith(expect.objectContaining({
    surface: 'ai_agents', requested: { offeringId: 'off-77', origin: 'policy' },
  }));
});

it('an inflated SDK cost does not trip the per-run budget guard; the registry price does', async () => {
  resolveModel.mockResolvedValue(makeResolvedModel('platform', { surface: 'ai_agents' }));
  queryEmits([{ type: 'result', subtype: 'success', total_cost_usd: 500, num_turns: 1,
    usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }]);
  const outcome = await runAgent(runFixture({ limits: { maxBudgetCentsPerRun: 10 } }));
  expect(outcome.status).not.toBe('budget_exceeded');
  expect(settleInvocation).toHaveBeenCalledWith(expect.objectContaining({ agentRunId: RUN_ID, userId: null, sessionId: null }));
});

it('re-resolves the ADMITTED offering, and never dispatches on a funding source admission did not check (finding 6)', async () => {
  resolveModel.mockResolvedValue(makeResolvedModel('platform', { surface: 'ai_agents' }));
  await runAgent(runFixture({ admittedOfferingId: 'off-admitted', fundingSource: 'partner_key' }));
  expect(resolveModel).toHaveBeenCalledWith(expect.objectContaining({ requested: { offeringId: 'off-admitted', origin: 'policy' } }));
  expect(queryMock).not.toHaveBeenCalled();
  expect(transitionRunStatus).toHaveBeenCalledWith(RUN_ID, 'running', 'blocked', expect.objectContaining({ errorCode: 'model_unavailable' }));
});

it('an unavailable model ends the run blocked/model_unavailable and notifies', async () => {
  resolveModel.mockResolvedValue({ ok: false, reason: 'model_unavailable', recoverable: true, offeringId: 'o', message: 'Model X is no longer available — choose another.' });
  await runAgent(runFixture());
  expect(transitionRunStatus).toHaveBeenCalledWith(RUN_ID, 'running', 'blocked', expect.objectContaining({
    errorCode: 'model_unavailable', outcome: expect.objectContaining({ blockedReason: 'model_unavailable' }),
  }));
  expect(notifyModelBlocked).toHaveBeenCalledWith(expect.objectContaining({ reason: 'model_unavailable' }));
  expect(reserveAiBudget).not.toHaveBeenCalled();
});

it('a refusal ends the run blocked/model_refused with the category in its outcome', async () => {
  resolveModel.mockResolvedValue(makeResolvedModel('platform', { surface: 'ai_agents' }));
  queryEmits([
    { type: 'system', subtype: 'model_refusal_no_fallback', api_refusal_category: 'cyber' },
    { type: 'result', subtype: 'success', stop_reason: 'refusal', total_cost_usd: 0, num_turns: 1, usage: { input_tokens: 10, output_tokens: 0 } },
  ]);
  await runAgent(runFixture());
  expect(transitionRunStatus).toHaveBeenCalledWith(RUN_ID, 'running', 'blocked', expect.objectContaining({
    errorCode: 'model_refused', outcome: expect.objectContaining({ refusalCategory: 'cyber' }),
  }));
  expect(settleInvocation.mock.calls[0]![0].outcome).toMatchObject({ refused: true, refusalCategory: 'cyber' });
});
```

`runLoop.test.ts` already has a harness for scripted SDK messages and `lastQueryOptions` (agent report: `:351–368`, `:1755`, `:2289`). `runAgent`, `runFixture`, `queryEmits` and `lastQueryOptions` above stand for that harness; use its real names. Delete the W00 `it.each` thinking table (~L1771); `sdkModelOptions` is covered in Task 4. Change `:2289` / `:2312` (`recordSessionlessSdkUsage` args) to assert `settleInvocation` instead.

Add to `runService.test.ts` (mock `../aiModels/resolveModel`, `../aiModels/candidateLoader`, `./modelBlocked`):

```ts
it('admission resolves the agent model first: funding feeds checkBudget and the run row', async () => {
  resolveModel.mockResolvedValue(makeResolvedModel('anthropic_byok', { surface: 'ai_agents' }));
  await createAndEnqueueAgentRun(admissionInput());
  expect(checkBudget).toHaveBeenCalledWith(ORG_ID, 'partner_key');
  expect(insertedRunValues()).toMatchObject({ fundingSource: 'partner_key', admittedOfferingId: 'off-1' });
});

it('an unavailable agent model skips with model_unavailable and notifies once per day', async () => {
  resolveModel.mockResolvedValue({ ok: false, reason: 'not_permitted', recoverable: true, offeringId: 'x', message: 'm' });
  expect(await createAndEnqueueAgentRun(admissionInput())).toMatchObject({ skipped: true, reason: 'model_unavailable' });
  expect(notifyModelBlocked).toHaveBeenCalledWith(expect.objectContaining({ reason: 'model_unavailable' }));
  expect(checkBudget).not.toHaveBeenCalled();
});
```

Add to `agentCircuit.test.ts`: `expect(classifyTerminal({ ...ctx, to: 'blocked', errorCode: 'model_refused' })).toBe('neutral')`. Match `classifyTerminal`'s real argument shape.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/aiAgents/modelBlocked.test.ts src/services/aiAgents/runLoop.test.ts src/services/aiAgents/runService.test.ts src/services/aiAgents/agentCircuit.test.ts`
Expected: FAIL. `./modelBlocked` is missing, `'blocked'` is not an `AiAgentRunStatus`, and the run loop still calls `resolveLlmConfigForOrg`.

- [ ] **Step 3: Migration, schema, shared status, export policy**

```sql
-- apps/api/migrations/2026-11-19-100200-ai-agent-runs-blocked-funding.sql
-- AI model registry W03 (#7601):
--  * `blocked` terminal status — a run whose model is unavailable at dispatch
--    (§9.1) or that the model refused (§9.1a); the reason is error_code
--    model_unavailable | model_refused, the category lives in `outcome`.
--  * funding_source — decided from the RESOLVED offering at admission
--    (quorum #4) so compute settlement never re-derives it per org.
--    NULL only on runs admitted before this migration (settled as 'platform',
--    the previous fail-safe). Export policy: `included`.
-- DDL only. Idempotent.
ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_status_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_status_chk CHECK (status IN (
  'queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'expired', 'skipped', 'blocked'
));
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS funding_source text NULL;
-- Review finding 6: the offering admission resolved (and checked credits for).
-- The run loop re-resolves THIS offering (bounded fallback keeps connection +
-- funding), so a queued run can never move funding after admission. Provenance
-- id (no FK, like ai_invocations): resolveModel re-validates ownership.
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS admitted_offering_id uuid NULL;
ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_funding_source_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_funding_source_chk
  CHECK (funding_source IS NULL OR funding_source IN ('platform', 'partner_key'));
```

```ts
// packages/shared/src/types/aiAgents.ts
export const AI_AGENT_RUN_STATUSES = [
  'queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'expired', 'skipped', 'blocked',
] as const;

// apps/api/src/db/schema/aiAgents.ts — aiAgentRuns
  /** AI model registry W03: funding of the offering resolved at admission. NULL = pre-W03 run. */
  fundingSource: text('funding_source').$type<'platform' | 'partner_key' | null>(),
  /** W03 (finding 6): the offering admission resolved; the run dispatches this one or is blocked. */
  admittedOfferingId: uuid('admitted_offering_id'),
```

Add `'funding_source'` and `'admitted_offering_id'` to the `ai_agent_runs` entry's `included` list in `tenantExportPolicyRegistry.ts`.

Run `cd apps/web && npx tsc --noEmit` and fix every `Record<AiAgentRunStatus, …>` it flags. `AiRunCard.tsx` `TERMINAL_BY_STATUS` gets `blocked: true`. Every status → label/colour map gets a `blocked` entry styled like `skipped`, labelled "Blocked". Find each status label key with `git grep -n '"skipped"' apps/web/src/locales/en/common.json`, then add `"blocked": "Blocked"` beside it in **all 8** locale files: English for now, and state in the PR that non-English strings are machine-drafted. Update the status list in the `aiToolsAiAgentGovernance.ts` description string to include `blocked`.

- [ ] **Step 4: Implement `modelBlocked.ts`**

```ts
// apps/api/src/services/aiAgents/modelBlocked.ts
/**
 * Agent runs blocked by the model registry (spec §9.1, §9.1a). Notifications
 * are deduped per (org, agent, reason, UTC day) through
 * user_notifications_user_dedupe_key_uq, i.e. at most once per policy per day.
 */
import type { AiAgentRecipients } from '@breeze/shared';
import { inSystemDbContext } from '../outcomeProbes';
import { createNotification } from '../userNotifications';
import { resolveRecipientUserIds } from './recipients';

export type ModelBlockedReason = 'model_unavailable' | 'model_refused';

export class AgentRunBlockedError extends Error {
  constructor(
    public readonly errorCode: ModelBlockedReason,
    public readonly outcome: Record<string, unknown>,
    message: string,
  ) {
    super(message);
    this.name = 'AgentRunBlockedError';
  }
}

export function blockedOutcome(reason: ModelBlockedReason, detail: {
  message: string; refusalCategory?: string | null; offeringId?: string | null; requestedModel?: string | null;
}): Record<string, unknown> {
  return {
    blockedReason: reason,
    message: detail.message,
    ...(detail.refusalCategory !== undefined ? { refusalCategory: detail.refusalCategory } : {}),
    ...(detail.offeringId !== undefined ? { offeringId: detail.offeringId } : {}),
    ...(detail.requestedModel !== undefined ? { requestedModel: detail.requestedModel } : {}),
  };
}

export function modelBlockedDedupeKey(orgId: string, agentId: string, reason: ModelBlockedReason, now: Date): string {
  return `ai-model-blocked-${orgId}-${agentId}-${reason}-${now.toISOString().slice(0, 10)}`;
}

export async function notifyModelBlocked(input: {
  orgId: string;
  agentId: string;
  agentName: string;
  agent: { orgId: string | null; partnerId: string | null; recipients: Partial<AiAgentRecipients> };
  reason: ModelBlockedReason;
  message: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const userIds = await resolveRecipientUserIds(input.agent, input.orgId);
  if (userIds.length === 0) return;
  const title = input.reason === 'model_refused'
    ? `${input.agentName}: the AI model declined a run`
    : `${input.agentName}: its AI model is unavailable`;
  await inSystemDbContext(async () => {
    for (const userId of userIds) {
      await createNotification({
        userId,
        orgId: input.orgId,
        type: 'ai',
        title,
        message: input.message,
        link: `/ai-agents/runs#agent=${input.agentId}`,
        priority: 'high',
        metadata: { agentId: input.agentId, reason: input.reason },
        dedupeKey: modelBlockedDedupeKey(input.orgId, input.agentId, input.reason, now),
      });
    }
  });
}
```

- [ ] **Step 5: Admission (`runService.ts`)**

Add `'model_unavailable'` to `AgentRunSkipReason`. Map it in `analysisAdmission.ts`'s `satisfies Record<AgentRunSkipReason, …>` table the same way `org_budget_exceeded` is mapped. Replace step 7's `const billingSource = await getLlmBillingSourceForOrg(orgId);` with:

```ts
    // 7. The agent's model (spec §9: decided BEFORE admission; quorum #4 funding).
    const partnerId = await readOrgPartnerId(orgId);
    const agentModel = partnerId
      ? await resolveModel({
          partnerId, orgId, surface: 'ai_agents',
          ...(resolved.effective.offeringId
            ? { requested: { offeringId: resolved.effective.offeringId, origin: 'policy' as const } }
            : {}),
        })
      : null;
    if (agentModel && !agentModel.ok && agentModel.reason === 'registry_unavailable') {
      // Transient cutover failure (Task 6A): skip this admission, never tell an admin the model is gone.
      return skip('model_unavailable');
    }
    if (!agentModel?.ok) {
      await notifyModelBlocked({
        orgId, agentId: resolved.agentId, agentName: resolved.agentName,
        agent: { orgId: resolved.agentOrgId, partnerId, recipients: resolved.effective.recipients },
        reason: 'model_unavailable',
        message: agentModel?.message ?? 'No AI model is available for AI agents.',
      }).catch((err) => console.error('[runService] model-blocked notify failed (non-fatal)', err));
      return skip('model_unavailable');
    }
    const billingSource = agentModel.funding;
    if (await checkBudget(orgId, billingSource)) return skip('org_budget_exceeded');
```

> `resolved.agentId`, `resolved.agentName`, `resolved.agentOrgId` and `resolved.effective.recipients` stand for whatever fields `ResolvedAgent` / `AiAgentPolicySnapshot` actually carries for the agent's id, name, owning org and recipients. Use the names the circuit-open notifier reads (`agentCircuit.ts` ~L515).

The rest of step 7b already uses `billingSource`, so `checkComputeCredits(orgId, billingSource, …)` is unchanged. The run insert adds `fundingSource: billingSource, admittedOfferingId: agentModel.offering.id`. Both compute-settle sites (~L1761, ~L1920) replace `await getLlmBillingSourceForOrg(orgId)` with the run's stored value. Select `fundingSource` with the row they already load:

```ts
      const fundingSource = run.fundingSource ?? 'platform';   // NULL = admitted before W03; previous fail-safe
```

- [ ] **Step 6: The run loop (`runLoop.ts`)**

In `driveSdkLoop`, replace the `resolveLlmConfigForOrg` block (~L1859–1865) with:

```ts
    const partnerId = await readOrgPartnerId(run.orgId);
    // Finding 6: dispatch the offering ADMISSION resolved and checked credits for
    // (bounded fallback can only keep its connection + funding). Runs admitted
    // before W03 carry no admitted offering and fall back to the policy/default.
    const requestedOfferingId = run.admittedOfferingId ?? effective.offeringId ?? null;
    const agentModel = partnerId
      ? await resolveModel({
          partnerId, orgId: run.orgId, surface: 'ai_agents',
          ...(requestedOfferingId ? { requested: { offeringId: requestedOfferingId, origin: 'policy' as const } } : {}),
        })
      : null;
    if (!agentModel?.ok) {
      const message = agentModel?.message ?? 'No AI model is available for AI agents.';
      throw new AgentRunBlockedError('model_unavailable',
        blockedOutcome('model_unavailable', { message, offeringId: requestedOfferingId }), message);
    }
    if (run.fundingSource && agentModel.funding !== run.fundingSource) {
      // Never dispatch on a funding source admission did not check (credits,
      // compute ceiling) — re-queue to re-admit instead.
      const message = 'The agent\'s model changed funding source after the run was admitted. Re-run it.';
      throw new AgentRunBlockedError('model_unavailable',
        blockedOutcome('model_unavailable', { message, offeringId: agentModel.offering.id }), message);
    }
    const binding = turnBindingFrom(agentModel);
    const billingSource = agentModel.funding;
    const model = agentModel.logicalModel;   // provenance (resolved_model, execution-ledger session)
```

- The reservation (~L2071) adds `binding`.
- Delete `resultCostCents`.
- Before `query()`, take the egress grant and keep its `revoke` for the existing `finally`:

```ts
    const egress = await grantCatalogSdkEgress(agentModel, {
      key: `agent-run:${run.id}`, orgId: run.orgId, aiSessionId: executionSessionId ?? null,
    });
```

  `executionSessionId` is the id `createAgentRunSession` returns (~L1987).

In the `query()` options (~L2114), replace `model,` / `env: buildClaudeSdkChildEnv(usableLlm),` / W01's `...agentSdkWireOptions(model)` spread with the following. Also delete the `legacyAgentModel` picker call (W02) at ~L1865.

```ts
        ...sdkModelOptions(agentModel),
        systemPrompt: applyPromptProfile('ai_agents', agentModel.promptProfile, systemPrompt),
        env: buildClaudeSdkChildEnv(agentModel.connection.config, process.env,
          egress ? { egressProxyUrl: egress.proxyUrl } : {}),
```

In the message loop, feed every message through `observeSdkMessage(observation, message)`, where `const observation = newSdkTurnObservation();` is declared before the loop. On each `result`, replace `costCents += resultCostCents(...)` with:

```ts
        const messageTokens = {
          input: messageUsage.input_tokens ?? 0, output: messageUsage.output_tokens ?? 0,
          cacheRead: messageUsage.cache_read_input_tokens ?? 0, cacheWrite: messageUsage.cache_creation_input_tokens ?? 0,
        };
        costCents += sumCostCents(priceUsage(binding,
          sdkTurnUsage({ binding, tokens: messageTokens, observation, result: message }).usage));
        lastResult = message;
```

Replace the `recordSessionlessSdkUsage(...)` call (~L2235) with:

```ts
    const { usage: billed, outcome: turnOutcome } = sdkTurnUsage({
      binding,
      tokens: { input: usage.input_tokens, output: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0 },
      observation,
      result: lastResult,
    });
    if (receivedResult) {
      await settleInvocation({
        binding, orgId: run.orgId, userId: null, sessionId: null, agentRunId: run.id, sourceRef: null,
        usage: billed, outcome: turnOutcome, reservationId,
        messageCount: turnCount > 0 ? turnCount : 1, toolExecutionCount: outcome.toolExecutionCount,
      });
    } else {
      await markAiBudgetReservationIndeterminate({ orgId: run.orgId, reservationId });
    }
    if (turnOutcome.refused) {
      const message = refusalHeadline(turnOutcome.refusalCategory);
      throw new AgentRunBlockedError('model_refused', blockedOutcome('model_refused', {
        message, refusalCategory: turnOutcome.refusalCategory,
        offeringId: binding.offeringId, requestedModel: binding.wireModel,
      }), message);
    }
```

In the run's catch (~L2516), before the generic `AgentRunError` handling:

```ts
      if (err instanceof AgentRunBlockedError) {
        await transitionRunStatus(runId, 'running', 'blocked', {
          errorCode: err.errorCode, outcome: err.outcome, finishedAt: new Date(),
        });
        await notifyModelBlocked({
          orgId: run.orgId, agentId: run.agentId, agentName: agentRow.name,
          agent: { orgId: agentRow.orgId, partnerId: agentRow.partnerId, recipients: agentRow.recipients },
          reason: err.errorCode, message: err.message,
        }).catch((e) => console.error('[runLoop] model-blocked notify failed (non-fatal)', e));
        return;
      }
```

> If `AgentRunStatusPatch` lacks `outcome`, add `outcome?: Record<string, unknown>` to it. `transitionRunStatus` already returns `outcome` from the row. `agentRow` is the loaded agent record this function already holds for recipients; use its local name.

The compute settle at ~L2629 uses `ctx.run.fundingSource ?? 'platform'` instead of `getLlmBillingSourceForOrg`.

`agentCircuit.ts` `classifyTerminal`: return `'neutral'` for `to === 'blocked'`, ahead of the failure classification, with a comment: "an admin's model choice / a provider refusal is not an agent fault".

- [ ] **Step 7: Move the egress grant into the factory**

```ts
// apps/api/src/services/aiModels/connectionFactory.ts — append
/**
 * CONNECT-proxy grant for an Agent SDK child talking to a catalog endpoint
 * (moved from streamingSessionManager.getOrCreate). Every CONNECT is audited
 * as `sdk_proxy_connect`; one `sdk_session_create` row records the target.
 */
export async function grantCatalogSdkEgress(
  resolved: ResolvedModel,
  input: { key: string; orgId: string; aiSessionId: string | null },
): Promise<{ proxyUrl: string; revoke: () => void } | null> {
  const cfg = resolved.connection.config;
  if (cfg.source !== 'partner' || cfg.endpoint.kind !== 'catalog') return null;
  const endpoint = cfg.endpoint;
  const host = new URL(endpoint.baseUrl).hostname;
  const provenance = {
    orgId: input.orgId, partnerId: cfg.partnerId,
    catalogEntryId: endpoint.catalogEntryId, revisionId: endpoint.revisionId, aiSessionId: input.aiSessionId,
  };
  const proxy = await getLlmEgressProxy();
  const proxyUrl = proxy.grant(input.key, { host, port: 443 }, (attempt) => {
    recordLlmEgressEvent({ ...provenance, surface: 'sdk_proxy_connect', host: attempt.host, resolvedIp: attempt.resolvedIp, blocked: attempt.blocked });
  }).proxyUrl;
  recordLlmEgressEvent({ ...provenance, surface: 'sdk_session_create', host, resolvedIp: null, blocked: false });
  return { proxyUrl, revoke: () => proxy.revoke(input.key) };
}
```

In `streamingSessionManager.getOrCreate`, replace the inline grant block (~L1192–1232) with:

```ts
    const egress = await grantCatalogSdkEgress(resolved, { key: breezeSessionId, orgId: dbSession.orgId, aiSessionId: breezeSessionId });
    const egressProxyUrl = egress?.proxyUrl;
    if (egress) session.revokeEgressGrant = egress.revoke;
```

`streamingSessionManager.catalog.test.ts` must still pass unchanged in behaviour. Re-run it.

- [ ] **Step 7A: Bind the policy model at write time (W02 handoff #5)**

Write the failing test first:

```ts
// apps/api/src/services/aiAgents/agentModelBinding.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  ensurePartnerCutover: vi.fn(async () => true),
  readOrgPartnerId: vi.fn(async () => 'p1'),
  findOfferingIdByModel: vi.fn(),
  getEffectiveAssignment: vi.fn(),
}));
vi.mock('../aiModels/registryCutover', () => ({ ensurePartnerCutover: m.ensurePartnerCutover }));
vi.mock('../aiModels/candidateLoader', () => ({ readOrgPartnerId: m.readOrgPartnerId, findOfferingIdByModel: m.findOfferingIdByModel }));
vi.mock('../aiModels/assignments', async (orig) => ({
  ...(await orig<typeof import('../aiModels/assignments')>()), getEffectiveAssignment: m.getEffectiveAssignment,
}));

import { AgentModelNotAllowedError, bindAgentModel } from './agentModelBinding';

beforeEach(() => {
  vi.clearAllMocks();
  m.getEffectiveAssignment.mockResolvedValue({ defaultOfferingId: 'off-1', permitted: { kind: 'list', offeringIds: ['off-1', 'off-2'] } });
});

describe('bindAgentModel', () => {
  it('maps a permitted model to its offering on the ai_agents default connection (org agent: merged assignment)', async () => {
    m.findOfferingIdByModel.mockResolvedValue('off-2');
    await expect(bindAgentModel({ orgId: 'o1', partnerId: null }, 'claude-opus-5-5'))
      .resolves.toEqual({ model: 'claude-opus-5-5', offeringId: 'off-2', offeringPartnerId: 'p1' });
    expect(m.findOfferingIdByModel).toHaveBeenCalledWith({ partnerId: 'p1', orgId: 'o1', surface: 'ai_agents', modelId: 'claude-opus-5-5' });
    expect(m.getEffectiveAssignment).toHaveBeenCalledWith({ partnerId: 'p1', orgId: 'o1', surface: 'ai_agents' });
  });

  it('a partner-wide agent checks the PARTNER assignment (orgId null)', async () => {
    m.findOfferingIdByModel.mockResolvedValue('off-1');
    await bindAgentModel({ orgId: null, partnerId: 'p1' }, 'claude-sonnet-5-5');
    expect(m.readOrgPartnerId).not.toHaveBeenCalled();
    expect(m.getEffectiveAssignment).toHaveBeenCalledWith({ partnerId: 'p1', orgId: null, surface: 'ai_agents' });
  });

  it('an unknown model is 400 invalid_model; a model outside the permitted set is 400 not_permitted', async () => {
    m.findOfferingIdByModel.mockResolvedValue(null);
    await expect(bindAgentModel({ orgId: 'o1', partnerId: null }, 'gpt-free-form')).rejects.toMatchObject({ status: 400, code: 'invalid_model' });
    m.findOfferingIdByModel.mockResolvedValue('off-9');
    await expect(bindAgentModel({ orgId: 'o1', partnerId: null }, 'claude-haiku-4-5')).rejects.toMatchObject({ status: 400, code: 'not_permitted' });
  });

  it('null clears the binding without touching the registry', async () => {
    await expect(bindAgentModel({ orgId: 'o1', partnerId: null }, null)).resolves.toEqual({ model: null, offeringId: null, offeringPartnerId: null });
    expect(m.ensurePartnerCutover).not.toHaveBeenCalled();
  });

  it('a partner whose cutover failed is 503, never a guess on a stale registry', async () => {
    m.ensurePartnerCutover.mockResolvedValueOnce(false);
    await expect(bindAgentModel({ orgId: 'o1', partnerId: null }, 'claude-opus-5-5'))
      .rejects.toBeInstanceOf(AgentModelNotAllowedError);
    expect(m.findOfferingIdByModel).not.toHaveBeenCalled();
  });
});
```

Run: `cd apps/api && npx vitest run src/services/aiAgents/agentModelBinding.test.ts`. It FAILS: `./agentModelBinding` does not resolve. Then implement:

```ts
// apps/api/src/services/aiAgents/agentModelBinding.ts
/**
 * Agent policy model → registry offering, at WRITE time (W02 handoff #5,
 * spec §5.6, quorum #11). After the W03 cutover nothing re-projects
 * ai_agents.model, so the write path owns ai_agents.offering_id.
 */
import { getEffectiveAssignment, isPermitted } from '../aiModels/assignments';
import { findOfferingIdByModel, readOrgPartnerId } from '../aiModels/candidateLoader';
import { ensurePartnerCutover } from '../aiModels/registryCutover';
import type { AgentOwner } from './agentService';

export class AgentModelNotAllowedError extends Error {
  readonly status: 400 | 503;
  readonly code: 'invalid_model' | 'not_permitted' | 'registry_unavailable';

  constructor(message: string, code: AgentModelNotAllowedError['code']) {
    super(message);
    this.name = 'AgentModelNotAllowedError';
    this.code = code;
    this.status = code === 'registry_unavailable' ? 503 : 400;
  }
}

export async function bindAgentModel(owner: AgentOwner, model: string | null): Promise<{
  model: string | null; offeringId: string | null; offeringPartnerId: string | null;
}> {
  if (model === null) return { model: null, offeringId: null, offeringPartnerId: null };
  const partnerId = owner.partnerId ?? (owner.orgId ? await readOrgPartnerId(owner.orgId) : null);
  if (!partnerId) throw new AgentModelNotAllowedError(`Model "${model}" is not available for AI agents.`, 'invalid_model');
  if (!(await ensurePartnerCutover(partnerId))) {
    throw new AgentModelNotAllowedError('AI configuration is being upgraded. Try again in a moment.', 'registry_unavailable');
  }
  const offeringId = await findOfferingIdByModel({ partnerId, orgId: owner.orgId, surface: 'ai_agents', modelId: model });
  if (!offeringId) throw new AgentModelNotAllowedError(`Model "${model}" is not available for AI agents.`, 'invalid_model');
  const assignment = await getEffectiveAssignment({ partnerId, orgId: owner.orgId, surface: 'ai_agents' });
  if (!isPermitted(assignment.permitted, offeringId)) {
    throw new AgentModelNotAllowedError('This AI model is not permitted for AI agents here. Choose another model.', 'not_permitted');
  }
  return { model, offeringId, offeringPartnerId: partnerId };
}
```

Wire it into `agentService.ts`:
- Remove `if (input.model !== undefined) out.model = input.model;` from `scalarPolicyColumns`.
- In `createAgent`, after `validateAgentRecipients` and before the insert, compute `const binding = await bindAgentModel(owner, input.model ?? null);`. Spread `{ model: binding.model, offeringId: binding.offeringId, offeringPartnerId: binding.offeringPartnerId }` into the inserted values.
- In `updateAgent`, inside the `withAgentRowLocked` callback and only when `input.model !== undefined`, compute the same binding with the row's `owner`. Spread it into the update set.
- `bindAgentModel` reads only registry tables and never takes a lock, so calling it under the agent row lock cannot deadlock. The row lock is on `ai_agents`, and the cutover's advisory lock is per partner.

In `routes/aiAgents.ts` `mapError`, add before the `AgentInvariantError` line:

```ts
  if (err instanceof AgentModelNotAllowedError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
```

Tests to add:
- `agentService.test.ts`: create with `model: 'claude-opus-5-5'` inserts `offeringId` / `offeringPartnerId` from a mocked `bindAgentModel`. Update without `model` never calls it. A rejected binding writes nothing.
- `routes/aiAgents.test.ts`: `PATCH` with a model the mocked service rejects as `not_permitted` returns `400 { error, code: 'not_permitted' }`.

- [ ] **Step 8: Append the parity suite**

```ts
// appended to apps/api/src/services/aiModels/parity/w03Surfaces.parity.test.ts
describe('W03 parity: ai_agents (policy offering, permitted set re-checked at run)', () => {
  it('agent queries — matches legacy except the declared catalog wire-translation fix', async () => {
    await assertSurfaceParity({
      select: (q) => q.kind === 'agent',
      bind,
      registrySide: async (fixture, q) => {
        const { agentKind, orgId } = q as { agentKind: string; orgId: string };
        const store = storeFor(fixture);
        const policy = store.agents.find((a) => a.kind === agentKind && a.orgId === orgId)
          ?? store.agents.find((a) => a.kind === agentKind && a.orgId === null);
        return toSurfaceUse(await resolveModel({
          partnerId: store.partnerId, orgId, surface: 'ai_agents',
          ...(policy?.offeringId ? { requested: { offeringId: policy.offeringId, origin: 'policy' as const } } : {}),
        }));
      },
    });
  });
});
```

- [ ] **Step 9: Run everything touched**

Run: `cd apps/api && npx vitest run src/services/aiAgents src/routes/aiAgents src/services/streamingSessionManager src/services/aiModels/connectionFactory.test.ts src/services/aiToolsAiAgentGovernance`
Expected: PASS. Check the file count covers every `runLoop*.test.ts` and `runService*.test.ts`.

Run: `cd apps/api && npx vitest run src/services/aiModels/parity/w03Surfaces.parity.test.ts && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts`
Expected: PASS.

Run: `cd apps/web && npx tsc --noEmit && npx vitest run src/lib/__tests__ src/components/ai src/components/aiAgents`
Expected: PASS. The locale-parity test fails if any of the 8 locales lacks `blocked`.

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json`

- [ ] **Step 10: Commit**

```bash
git add apps/api/migrations/2026-11-19-100200-ai-agent-runs-blocked-funding.sql \
  apps/api/src/services/aiAgents apps/api/src/services/aiModels/connectionFactory.ts \
  apps/api/src/services/streamingSessionManager.ts apps/api/src/db/schema/aiAgents.ts \
  apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/aiToolsAiAgentGovernance.ts \
  packages/shared/src/types/aiAgents.ts apps/web/src/components apps/web/src/locales \
  apps/api/src/services/aiModels/parity/w03Surfaces.parity.test.ts apps/api/src/routes/aiAgents.ts apps/api/src/routes/aiAgents.test.ts
git commit -m "feat(ai): agent runs resolve, translate, fund and settle through the registry; blocked runs (#7601)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 13: Catalog enrichment, extension AI and workspace enrichment

These are the remaining one-shot surfaces:
- **`catalog_enrichment`**: a multi-turn web-search loop. It is user-initiated unless `systemInitiated`.
- **`extension_content`**: the host side of `ExtensionAiContext.invoke`, used by the Workspace extension.

Each follows the Task 10 shape (resolve → admit with `resolved.funding` → reserve with the binding → `createMessage` → settle every attempt).

Changes specific to these surfaces:
- **Web-search fees.** They are priced as ledger server-tool fees (`WEB_SEARCH_COST_CENTS`, now exported from `settleInvocation.ts`).
- **Extension model choice.** `extensionAi.ts` stops reading `WORKSPACE_CONTENT_LLM_MODEL` (via W02's `legacyExtensionModel`) and drops the `isPricedModel` gate. The `extension_content` assignment (W02 projected it from the env/default, P12) decides, and an explicit `input.model` maps to an offering as a `policy`-origin request. W02's `legacyExtensionModel` / `EXTENSION_AI_DEFAULT_MODEL` stay in `legacySurfaceModels.ts` for the projection (Task 6A) until W08.
- **Catalog partners now work on extensions.** `buildAnthropicClient` refused them; this is the second intended parity delta in Task 1.
- **Workspace model label.** `ee/workspace` records the model the host **actually served** (`result.model`) instead of re-deriving the env label.

**Files:**
- Modify: `apps/api/src/services/catalogEnrichmentService.ts` (`resolveEnrichmentClient` ~L111, `aiEnrichmentProvider.enrich` ~L262–400, polish ~L760–915, `WEB_SEARCH_COST_CENTS` ~L139 → import)
- Modify: `apps/api/src/services/extensionAi.ts` (~L41, `buildExtensionAiContext` ~L128–290)
- Modify: `packages/extension-sdk/src/server.ts` (the doc comment on `ExtensionAiInvokeInput.model`)
- Modify: `ee/workspace/src/services/enrichmentService.ts` (`DEFAULT_MODEL` ~L61, `model` ~L137, `classifyOne` ~L139–160, the insert ~L257–271)
- Modify: `apps/api/src/services/system/connections/internalEnvVars.ts` (~L491) and `registry.ts` (mark the `WORKSPACE_CONTENT_LLM_MODEL` rows deprecated), `apps/docs/src/content/docs/deploy/environment.mdx`
- Modify tests: `catalogEnrichmentService.test.ts`, `extensionAi.test.ts`, `ee/workspace/src/services/enrichmentService.test.ts`, `__tests__/integration/workspaceEnrichmentByok.integration.test.ts`
- Modify: `apps/api/src/services/aiModels/parity/w03Surfaces.parity.test.ts` (append two `describe` blocks)

**Interfaces:**
- Consumes: Tasks 2–6, 10 (`readOrgPartnerId`, `findOfferingIdByModel`, `resolveModel`, `anthropicClientFor`, `createMessage`, `messagesUsage`, `priceUsage`, `sumCostCents`, `costEstimator`, `settleInvocation`, `turnBindingFrom`, `WEB_SEARCH_COST_CENTS`).
- Produces:
  ```ts
  // catalogEnrichmentService.ts
  async function resolveEnrichmentModel(actor: EnrichmentActor): Promise<{ resolved: ResolvedModel; client: Anthropic }>;
  // ee/workspace enrichmentService: classifyOne(...) → Promise<(EnrichmentResult & { model: string }) | null>
  ```

- [ ] **Step 1: Write the failing tests**

`catalogEnrichmentService.test.ts`: replace the `./llm/llmConfigResolver` + `./aiAgent` mocks with `./aiModels/resolveModel`, `./aiModels/candidateLoader` (`readOrgPartnerId`), `./aiModels/connectionFactory` (`anthropicClientFor` → the existing `{ messages: { create } }` fake, real `createMessage`) and `./aiModels/settleInvocation` (real `priceUsage`/`sumCostCents`/`costEstimator`, mocked `settleInvocation`). Add:

```ts
it('resolves catalog_enrichment for the acting user, admits with its funding, settles every turn incl. web-search fees', async () => {
  const model = makeResolvedModel('anthropic_byok', { surface: 'catalog_enrichment' });
  resolveModel.mockResolvedValue(model);
  create
    .mockResolvedValueOnce({ model: 'claude-sonnet-5-5', stop_reason: 'pause_turn', content: [{ type: 'text', text: '' }],
      usage: { input_tokens: 500, output_tokens: 20, server_tool_use: { web_search_requests: 2 } } })
    .mockResolvedValueOnce({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: VALID_JSON }],
      usage: { input_tokens: 900, output_tokens: 200 } });
  await aiEnrichmentProvider.enrich('Contoso Widget', 'software', ACTOR);
  expect(resolveModel).toHaveBeenCalledWith(expect.objectContaining({
    partnerId: ACTOR.partnerId, orgId: ACTOR.orgId, userId: ACTOR.userId, surface: 'catalog_enrichment',
  }));
  expect(checkBudget).toHaveBeenCalledWith(ACTOR.orgId, 'partner_key');
  const settled = settleInvocation.mock.calls[0]![0];
  expect(settled.usage).toHaveLength(2);
  expect(settled.usage[0].webSearchRequests).toBe(2);
  expect(settled.sourceRef).toBe('catalog_enrich');
});

it('a system-initiated enrichment is not user-initiated (no permission gate)', async () => {
  resolveModel.mockResolvedValue(makeResolvedModel('platform', { surface: 'catalog_enrichment' }));
  await aiEnrichmentProvider.enrich('x', 'software', { ...ACTOR, systemInitiated: true });
  expect(resolveModel).toHaveBeenCalledWith(expect.objectContaining({ userId: null }));
});
```

`extensionAi.test.ts`: drop the `isPricedModel` allowlist mock and the `buildAnthropicClient` mock, then add:

```ts
it('uses the extension_content assignment and returns the SERVED model', async () => {
  resolveModel.mockResolvedValue(makeResolvedModel('platform', { surface: 'extension_content', wireModel: 'claude-haiku-4-5', logicalModel: 'claude-haiku-4-5' }));
  const out = await buildExtensionAiContext().invoke(INVOKE);
  expect(resolveModel).toHaveBeenCalledWith(expect.objectContaining({ surface: 'extension_content', orgId: INVOKE.orgId }));
  expect(out).toMatchObject({ model: 'claude-haiku-4-5', billingSource: 'platform' });
  expect(settleInvocation).toHaveBeenCalledWith(expect.objectContaining({ sourceRef: 'extension:workspace_enrichment' }));
});

it('an explicit input.model must map to a permitted offering, else permanent ai_unavailable', async () => {
  findOfferingIdByModel.mockResolvedValue(null);
  await expect(buildExtensionAiContext().invoke({ ...INVOKE, model: 'claude-nope-1' }))
    .rejects.toMatchObject({ code: 'ai_unavailable', permanent: true });
});

it('a catalog partner is now served (legacy refused catalog endpoints)', async () => {
  resolveModel.mockResolvedValue(makeResolvedModel('catalog', { surface: 'extension_content' }));
  await expect(buildExtensionAiContext().invoke(INVOKE)).resolves.toMatchObject({ billingSource: 'partner_key' });
});
```

`ee/workspace/src/services/enrichmentService.test.ts`:

```ts
it('records the model the host served, not an env-derived label', async () => {
  const invoke = vi.fn().mockResolvedValue({ text: VALID_JSON, model: 'claude-served-model', billingSource: 'platform', usage: { inputTokens: 1, outputTokens: 1 } });
  const svc = createEnrichmentService(fakeDb, { invoke });
  await svc.run(ORG_ID, 1);
  expect(insertedEnrichmentRows()[0]).toMatchObject({ model: 'claude-served-model' });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/catalogEnrichmentService.test.ts src/services/extensionAi.test.ts && cd ../../ee/workspace && npx vitest run src/services/enrichmentService.test.ts`
Expected: FAIL. `resolveModel` is never called, and the workspace row's model is `'claude-haiku-4-5'`.

- [ ] **Step 3: Catalog enrichment**

```ts
// catalogEnrichmentService.ts — replaces resolveEnrichmentClient
async function resolveEnrichmentModel(actor: EnrichmentActor): Promise<{ resolved: ResolvedModel; client: Anthropic }> {
  const partnerId = actor.partnerId ?? (actor.orgId ? await readOrgPartnerId(actor.orgId) : null);
  if (!partnerId) throw new EnrichmentError('AI is unavailable for this catalog.', 'AI_UNAVAILABLE', 503);
  const resolved = await resolveModel({
    partnerId,
    orgId: actor.orgId,
    userId: actor.systemInitiated ? null : actor.userId,
    surface: 'catalog_enrichment',
    maxTokens: 1024,
  });
  if (!resolved.ok) throw new EnrichmentError(resolved.message, 'AI_UNAVAILABLE', 503);
  try {
    return { resolved, client: anthropicClientFor(resolved, { surface: 'one_shot_catalog_enrichment', orgId: actor.orgId }) };
  } catch (error) {
    if (error instanceof LlmUnavailableError) throw new EnrichmentError('AI is unavailable.', 'AI_UNAVAILABLE', 503);
    throw error;
  }
}
```

In `enrich` (and the polish path, identically):
- `checkBudget(actor.orgId, resolved.funding)`;
- `reserveAiBudget({ …, billingSource: resolved.funding, binding })` with `const binding = turnBindingFrom(resolved)`;
- `const attempts: MessageAttempt[] = []`.

Each loop turn becomes:

```ts
        const spentCents = attempts.length > 0 ? sumCostCents(priceUsage(binding, messagesUsage(binding, attempts).usage)) : 0;
        const maxTokens = maxOutputTokensForAiBudget({
          prompt: JSON.stringify({ system: withStyleOverride(SYSTEM_PROMPT, styleOverride), tools, messages }),
          requestedMaxOutputTokens: 1024,
          budgetCents: reservedCostCents === undefined
            ? undefined
            : Math.max(0, reservedCostCents - spentCents - (WEB_SEARCH_MAX_USES * WEB_SEARCH_COST_CENTS)),
          calculateCostCents: costEstimator(resolved),
        });
        if (maxTokens === null) throw new EnrichmentBudgetStopError();
        const outcome = await createMessage(client, resolved, {
          max_tokens: maxTokens, system: withStyleOverride(SYSTEM_PROMPT, styleOverride), tools, messages,
        });
        attempts.push(...outcome.attempts);
        const resp = outcome.message;
        lastStopReason = resp.stop_reason ?? null;
        if (resp.stop_reason === 'pause_turn' || resp.stop_reason === 'tool_use') {
          messages.push({ role: 'assistant', content: resp.content });
          continue;
        }
        finalText = lastTextBlock(resp.content as Array<{ type: string; text?: string }>);
        break;
```

Both `recordUsage(null, actor.orgId, model, totalIn, totalOut, true, billingSource, wire.catalogPricing, reservationId, totalWebSearches * WEB_SEARCH_COST_CENTS)` calls (the budget-stop path and the normal path), and the polish path's, become:

```ts
          await settleInvocation({
            binding, orgId: actor.orgId, userId: actor.systemInitiated ? null : actor.userId,
            sessionId: null, agentRunId: null, sourceRef: 'catalog_enrich',
            ...messagesUsage(binding, attempts),
            reservationId, toolExecutionCount: 1,
          });
```

Use `sourceRef: 'catalog_polish'` on the polish path. `totalIn` / `totalOut` / `totalWebSearches` and the local `WEB_SEARCH_COST_CENTS` constant are deleted; import the constant from `./aiModels/settleInvocation`. Keep the org-less `systemInitiated` branch as today: no org means no reservation and no ledger row, because the ledger is `org_id NOT NULL`. Its console warning stays.

- [ ] **Step 4: Extension AI and the Workspace label**

In `buildExtensionAiContext().invoke`, replace everything from `const model = input.model ?? …` through `const wire = resolveWireModel(usable, model)` / `calculateWireCostCents`, and the `buildAnthropicClient` / `client.messages.create` / `recordUsage` / `deductBillingCredits` tail, with:

```ts
      const partnerId = await readOrgPartnerId(input.orgId);
      if (!partnerId) throw new ExtensionAiError('ai_unavailable', 'AI is unavailable for this organization.');
      let offeringId: string | undefined;
      if (input.model) {
        // The lookup reads assignments: never against a partner not yet cut over (Task 6A). Transient.
        if (!(await ensurePartnerCutover(partnerId))) {
          throw new ExtensionAiError('ai_unavailable', 'AI configuration is being upgraded. Try again in a moment.');
        }
        offeringId = (await findOfferingIdByModel({
          partnerId, orgId: input.orgId, surface: 'extension_content', modelId: input.model,
        })) ?? undefined;
        if (!offeringId) {
          // PERMANENT: a model id the partner has not enabled; every retry reproduces it.
          throw new ExtensionAiError('ai_unavailable', `AI model "${input.model}" is not available for extension use.`, { permanent: true });
        }
      }
      const resolved = await resolveModel({
        partnerId, orgId: input.orgId,
        userId: input.principal.type === 'user' ? input.principal.id : null,
        surface: 'extension_content',
        maxTokens: input.maxTokens,
        ...(offeringId ? { requested: { offeringId, origin: 'policy' as const } } : {}),
      });
      if (!resolved.ok) {
        throw new ExtensionAiError(
          resolved.reason === 'connection_unavailable' ? 'not_configured' : 'ai_unavailable',
          resolved.message,
          // registry_unavailable (Task 6A) is a transient cutover failure: retryable.
          { permanent: resolved.reason !== 'connection_unavailable' && resolved.reason !== 'registry_unavailable' },
        );
      }
      const billingSource = resolved.funding;
      // … rate limit + checkBudgetDetailed(input.orgId, billingSource) unchanged …
      const binding = turnBindingFrom(resolved);
      const reservation = await reserveAiBudget({
        orgId: input.orgId, idempotencyKey: `extension-ai:${crypto.randomUUID()}`, billingSource, binding,
      });
      // … denial handling unchanged …
      const maxTokens = maxOutputTokensForAiBudget({
        prompt: JSON.stringify({ system: input.system, messages: input.messages }),
        requestedMaxOutputTokens: input.maxTokens,
        budgetCents: reservation.kind === 'reserved' ? reservation.reservedCostCents : undefined,
        calculateCostCents: costEstimator(resolved),
      });
      // … null → release + budget_exceeded, unchanged …
      const client = anthropicClientFor(resolved, { surface: 'workspace_enrichment', orgId: input.orgId });
      let outcome: MessageOutcome;
      try {
        outcome = await createMessage(client, resolved, { max_tokens: maxTokens, system: input.system, messages: input.messages });
      } catch (error) {
        await markAiBudgetReservationIndeterminate({ orgId: input.orgId, reservationId }).catch((e) => captureException(e));
        throw await classifyProviderFailure(error, resolved.connection.config);
      }
      const text = outcome.message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      const billed = messagesUsage(binding, outcome.attempts);
      try {
        await settleInvocation({
          binding, orgId: input.orgId, userId: input.principal.type === 'user' ? input.principal.id : null,
          sessionId: null, agentRunId: null, sourceRef: `extension:${input.surface}`,
          ...billed, reservationId, toolExecutionCount: 1,
        });
      } catch (error) {
        await markAiBudgetReservationIndeterminate({ orgId: input.orgId, reservationId }).catch((e) => captureException(e));
        throw error;
      }
      return {
        text,
        model: billed.outcome.servedModel,
        billingSource,
        usage: {
          inputTokens: billed.usage.reduce((s, u) => s + u.tokens.input + u.tokens.cacheRead + u.tokens.cacheWrite, 0),
          outputTokens: billed.usage.reduce((s, u) => s + u.tokens.output, 0),
        },
      };
```

> `classifyProviderFailure(error, usable)` keeps its body. It only reads `source` / `partnerId` / `configId` / `configVersion` off the connection config, which `resolved.connection.config` still carries. `settleInvocation` draws down platform credits, so the explicit `deductBillingCredits` is deleted. Delete the `legacyExtensionModel` call and the `isPricedModel`, `resolveLlmConfigForOrg`, `resolveWireModel` and `buildAnthropicClient` imports from this file. Import `ensurePartnerCutover` from `./aiModels/registryCutover`. Mock it to `true` in `extensionAi.test.ts`, and add one case: when it resolves `false`, an explicit `input.model` throws a **non-permanent** `ai_unavailable`.

`packages/extension-sdk/src/server.ts`: change the `model?` doc comment to "Optional: a model id the partner has enabled for extension use; the host maps it to that offering. Omit to use the partner's `extension_content` default."

`ee/workspace/src/services/enrichmentService.ts`:
- delete `DEFAULT_MODEL` and the `const model = process.env.WORKSPACE_CONTENT_LLM_MODEL ?? DEFAULT_MODEL` label;
- `classifyOne` returns `{ ...resultSchema.parse(extractJson(result.text, 'workspace-enrich')), model: result.model }`;
- the insert writes `${result ? result.model : null}` where it wrote `${result ? model : null}`;
- update the module comments that describe the env-var label.

Mark the `WORKSPACE_CONTENT_LLM_MODEL` rows deprecated in `internalEnvVars.ts` and `registry.ts`. In `environment.mdx`, change its row to: "Deprecated: the extension/workspace model is set under AI Providers & Models → Defaults by feature, and your value was migrated there. Until that page ships, new partners still inherit this value."

- [ ] **Step 5: Append the two parity suites**

```ts
// appended to apps/api/src/services/aiModels/parity/w03Surfaces.parity.test.ts
describe('W03 parity: catalog_enrichment', () => {
  it('surface queries', async () => {
    await assertSurfaceParity({ select: surfaceQuery('catalog_enrichment'), bind, registrySide: viaAssignment('catalog_enrichment', true) });
  });
});

describe('W03 parity: extension_content', () => {
  it('surface queries — matches legacy except the declared catalog fix (legacy refused catalog partners)', async () => {
    await assertSurfaceParity({ select: surfaceQuery('extension_content'), bind, registrySide: viaAssignment('extension_content', false) });
  });
});
```

- [ ] **Step 6: Run and commit**

Run: `cd apps/api && npx vitest run src/services/catalogEnrichmentService.test.ts src/services/extensionAi.test.ts src/routes/catalog src/services/pax8CatalogService.test.ts`
Expected: PASS.

Run: `cd ee/workspace && npx vitest run && cd ../../apps/api && npx vitest run src/services/aiModels/parity/w03Surfaces.parity.test.ts && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/workspaceEnrichmentByok.integration.test.ts`
Expected: PASS. `workspaceEnrichmentByok` asserted BYOK funding before the cutover and must still hold.

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json`

```bash
git add apps/api/src/services/catalogEnrichmentService.ts apps/api/src/services/catalogEnrichmentService.test.ts \
  apps/api/src/services/extensionAi.ts apps/api/src/services/extensionAi.test.ts packages/extension-sdk/src/server.ts \
  ee/workspace/src/services apps/api/src/services/system/connections apps/docs/src/content/docs/deploy/environment.mdx \
  apps/api/src/services/aiModels/parity/w03Surfaces.parity.test.ts \
  apps/api/src/__tests__/integration/workspaceEnrichmentByok.integration.test.ts
git commit -m "feat(ai): catalog enrichment and extension AI resolve and settle through the registry (#7601)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 14: Patch test runner — platform-only system surface via the factory

The winget release-test analyst runs from a worker with no tenant. It is deliberately unmetered (#5557), and it stays unmetered: no ledger row is possible without an `org_id`. It now resolves `patch_test` through `resolveModel`, which takes the partnerless platform path (Task 3). It is therefore subject to the same `platform_offered` / `available` / priced re-check, and its client comes from the factory: it was the last `new Anthropic(` outside it.

**Files:**
- Modify: `apps/api/src/services/aiPatchTestRunner.ts` (`analyzeWithClaude` ~L104–140)
- Modify: `apps/api/src/services/aiPatchTestRunner.test.ts`
- Modify: `apps/api/src/services/aiModels/parity/w03Surfaces.parity.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: Task 3 `resolveModel` (partnerless), Task 4 `anthropicClientFor`, `createMessage`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

```ts
// aiPatchTestRunner.test.ts — replace the './aiAgent' resolveDefaultModel mock and the '@anthropic-ai/sdk' class mock
const m = vi.hoisted(() => ({ resolveModel: vi.fn(), anthropicClientFor: vi.fn(), create: vi.fn() }));
vi.mock('./aiModels/resolveModel', () => ({ resolveModel: m.resolveModel }));
vi.mock('./aiModels/connectionFactory', async (orig) => ({
  ...(await orig<typeof import('./aiModels/connectionFactory')>()),
  anthropicClientFor: m.anthropicClientFor,
}));

it('resolves the platform-only patch_test surface and calls through the factory', async () => {
  m.resolveModel.mockResolvedValue(makeResolvedModel('platform', { surface: 'patch_test', partnerId: null, orgId: null }));
  m.anthropicClientFor.mockReturnValue({ messages: { create: m.create } });
  m.create.mockResolvedValue({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn',
    content: [{ type: 'text', text: '{"result":"pass","notes":"ok"}' }], usage: { input_tokens: 1, output_tokens: 1 } });
  await expect(runPatchTest(ARGS)).resolves.toMatchObject({ result: 'pass' });
  expect(m.resolveModel).toHaveBeenCalledWith({ partnerId: null, orgId: null, surface: 'patch_test', maxTokens: 512 });
  expect(m.anthropicClientFor).toHaveBeenCalledWith(expect.objectContaining({ surface: 'patch_test' }), null);
  expect(m.create.mock.calls[0]![0]).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 512 });
});

it('no eligible platform model → inconclusive, never a guessed model', async () => {
  m.resolveModel.mockResolvedValue({ ok: false, reason: 'unpriced', recoverable: true, offeringId: null, message: 'm' });
  await expect(runPatchTest(ARGS)).resolves.toMatchObject({ result: 'inconclusive' });
  expect(m.anthropicClientFor).not.toHaveBeenCalled();
});
```

`runPatchTest` / `ARGS` stand for the suite's existing entry point and fixture.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/aiPatchTestRunner.test.ts`
Expected: FAIL (`resolveModel` not called).

- [ ] **Step 3: Implement**

```ts
// aiPatchTestRunner.ts — analyzeWithClaude, replacing the dynamic `new Anthropic()` + resolveDefaultModel()
  // Dynamic import keeps the SDK out of the cold path when AI testing is disabled.
  const { resolveModel } = await import('./aiModels/resolveModel');
  const { anthropicClientFor, createMessage } = await import('./aiModels/connectionFactory');
  const resolved = await resolveModel({ partnerId: null, orgId: null, surface: 'patch_test', maxTokens: 512 });
  if (!resolved.ok) return { result: 'inconclusive', notes: `AI analysis unavailable: ${resolved.message}` };
  const { message: resp } = await createMessage(anthropicClientFor(resolved, null), resolved, {
    max_tokens: 512,
    system: [
      {
        type: 'text' as const,
        text:
          'You are a release-test analyst. Given a winget upgrade log, decide if the upgrade succeeded. ' +
          'Respond ONLY with valid JSON of the shape {"result":"pass"|"fail"|"inconclusive","notes":string}. ' +
          'No prose outside the JSON.',
        cache_control: { type: 'ephemeral' as const },
      },
    ],
    messages: [
      {
        role: 'user' as const,
        content: `Package: ${input.packageId}\nVersion: ${input.version}\nCommands run:\n${input.commands.join(
          '\n'
        )}\n\nOutput:\n${input.output.slice(0, 8000)}`,
      },
    ],
  });
```

The response handling below it (`resp.content.find((b) => b.type === 'text')` …) is unchanged.

Delete the `resolveDefaultModel` import and W01's `...messagesApiWireOptions(model, PATCH_ANALYSIS_MAX_TOKENS)` spread; `createMessage` now supplies those params.

- [ ] **Step 4: Append the parity suite**

```ts
// appended to apps/api/src/services/aiModels/parity/w03Surfaces.parity.test.ts
describe('W03 parity: patch_test (platform-only)', () => {
  it('is the platform default on the platform key for every fixture', async () => {
    await assertSurfaceParity({
      select: surfaceQuery('patch_test'),
      bind,
      registrySide: async () => toSurfaceUse(await resolveModel({ partnerId: null, orgId: null, surface: 'patch_test', maxTokens: 512 })),
    });
  });
});
```

- [ ] **Step 5: Run and commit**

Run: `cd apps/api && npx vitest run src/services/aiPatchTestRunner.test.ts src/jobs/wingetReleaseTestWorker.test.ts src/services/aiModels/parity/w03Surfaces.parity.test.ts`
Expected: PASS.

```bash
git add apps/api/src/services/aiPatchTestRunner.ts apps/api/src/services/aiPatchTestRunner.test.ts \
  apps/api/src/services/aiModels/parity/w03Surfaces.parity.test.ts
git commit -m "feat(ai): patch test runner resolves the platform-only surface via the connection factory (#7601)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 15: Delete `getLlmBillingSourceForOrg`; funding labels come from the resolver and the ledger rollup; retire the goldens test

After Tasks 7–14, every admission, reservation and settlement takes funding from a resolved offering. Two readers still label an org with one funding source:
- **`aiBudgetAlerts.ts`** labels the alert event with the funding of the spend it is alerting on. That is the `billing_source` already on the `ai_cost_usage` row it reads, now derived from `ai_invocations`.
- **`getUsageSummary.billedTo`** answers "what will a chat here bill to?" It reads `resolveModel({ surface: 'chat' }).funding`, falling back to the monthly rollup's label, then `'platform'`.

The legacy surface-use goldens were frozen in Task 1, so three files that run the legacy code live are retired here, all of which import the code being deleted:
- `w03Goldens.test.ts`;
- W02's oracle `parity/legacyOracle.ts`;
- W02's own `parity/parity.test.ts`.

W02's `harness.ts` stays (it takes the legacy side as a parameter), and so do `w03Goldens.json` and the W03 per-surface suite that reads it.

**Files:**
- Modify: `apps/api/src/services/llm/llmConfigResolver.ts` (delete `getLlmBillingSourceForOrg` ~L421 and `partnerLlmConfigExists`)
- Modify: `apps/api/src/services/aiBudgetAlerts.ts` (~L85)
- Modify: `apps/api/src/services/aiCostTracker.ts` (`getUsageSummary` ~L1690; drop the import)
- Modify: `apps/api/src/services/llm/llmConfigResolver.test.ts`, `apps/api/src/services/aiBudgetAlerts.test.ts`, `apps/api/src/services/aiCostTracker.test.ts`, and any remaining `getLlmBillingSourceForOrg` test mocks (`analysisProfile.admission.test.ts`, `runLoop.analysis.test.ts`, `runService.test.ts`, `runScriptReview.test.ts`)
- Delete: `apps/api/src/services/aiModels/parity/w03Goldens.test.ts`, W02's `apps/api/src/services/aiModels/parity/legacyOracle.ts` and `apps/api/src/services/aiModels/parity/parity.test.ts`

**Interfaces:**
- Consumes: Task 3 `resolveModel`, Task 2 `readOrgPartnerId`.
- Produces: none. `getLlmBillingSourceForOrg` is removed.

- [ ] **Step 1: Write the failing tests**

```ts
// aiBudgetAlerts.test.ts — replace the getLlmBillingSourceForOrg mock
it('labels the alert with the billing source of the rollup row it evaluated', async () => {
  usageRows.mockReturnValue([{ total_cost_cents: 900, billing_source: 'partner_key' }]);
  await evaluateAiBudgetThresholds(ORG_ID, NOW);
  expect(insertedAlert()).toMatchObject({ billing_source: 'partner_key' });
});
```

```ts
// aiCostTracker.test.ts — getUsageSummary
it('billedTo is the funding a chat in this org would use', async () => {
  resolveModel.mockResolvedValue(makeResolvedModel('anthropic_byok'));
  expect((await getUsageSummary(ORG_ID)).billedTo).toBe('partner_key');
});
it('billedTo falls back to the monthly rollup label when chat cannot resolve', async () => {
  resolveModel.mockResolvedValue({ ok: false, reason: 'no_eligible_model', recoverable: true, offeringId: null, message: 'm' });
  monthlyRow.mockReturnValue({ billingSource: 'partner_key' });
  expect((await getUsageSummary(ORG_ID)).billedTo).toBe('partner_key');
});
```

Add a check that the function is gone:

```ts
// llmConfigResolver.test.ts
it('per-org funding inference no longer exists (quorum #4)', async () => {
  const mod = await import('./llmConfigResolver');
  expect('getLlmBillingSourceForOrg' in mod).toBe(false);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/aiBudgetAlerts.test.ts src/services/aiCostTracker.test.ts src/services/llm/llmConfigResolver.test.ts`
Expected: FAIL. The alert label still comes from the mocked `getLlmBillingSourceForOrg`, and the export still exists.

- [ ] **Step 3: Implement**

```ts
// aiBudgetAlerts.ts — inside the per-period loop; delete the getLlmBillingSourceForOrg call above it
      const usage = await db.execute<{ total_cost_cents: number; billing_source: string | null }>(sql`
        SELECT total_cost_cents, billing_source FROM ai_cost_usage
        WHERE org_id = ${orgId}::uuid AND period = ${period} AND period_key = ${key}
        LIMIT 1
      `);
      const used = Number(usage[0]?.total_cost_cents ?? 0);
      // The funding of the spend being alerted on — derived from ai_invocations
      // by the settlement that wrote this row (spec §5.5), not inferred per org.
      const billingSource = usage[0]?.billing_source === 'partner_key' ? 'partner_key' : 'platform';
```

```ts
// aiCostTracker.ts — getUsageSummary, replacing `const billedTo = await getLlmBillingSourceForOrg(orgId);`
  const partnerId = await readOrgPartnerId(orgId);
  const chat = partnerId ? await resolveModel({ partnerId, orgId, surface: 'chat' }) : null;
  const billedTo: AiBillingSource = chat?.ok
    ? chat.funding
    : (monthly?.billingSource === 'partner_key' ? 'partner_key' : 'platform');
```

`monthly` is the monthly `ai_cost_usage` row this function already reads; select `billingSource` with it if it is not selected yet.

Delete `getLlmBillingSourceForOrg` and its now-unused helper `partnerLlmConfigExists` from `llmConfigResolver.ts`. Remove every test mock entry for it; `git grep -n getLlmBillingSourceForOrg -- apps ee packages` must be empty.

Delete `parity/w03Goldens.test.ts`, `parity/legacyOracle.ts` and `parity/parity.test.ts`. Check with `git grep -n "legacyOracle\|legacySurfaceUse" -- apps/api/src`, which must print nothing. `fixtures.ts`, `harness.ts`, the projection modules and `w03Goldens.json` stay: the W03 per-surface suite runs on them.

- [ ] **Step 4: Run and commit**

Run: `cd apps/api && npx vitest run src/services/aiBudgetAlerts.test.ts src/services/aiCostTracker.test.ts src/services/llm src/services/aiAgents src/services/scriptProposals && npx tsc --noEmit -p tsconfig.json`
Expected: PASS / no errors.

Run: `cd apps/api && npx vitest run src/services/aiModels/parity/w03Surfaces.parity.test.ts`
Expected: PASS. Every surface's `describe` runs against the frozen goldens: 12 tests once Tasks 7–14 have all appended theirs.

```bash
git add -A apps/api/src/services/llm/llmConfigResolver.ts apps/api/src/services/llm/llmConfigResolver.test.ts \
  apps/api/src/services/aiBudgetAlerts.ts apps/api/src/services/aiBudgetAlerts.test.ts \
  apps/api/src/services/aiCostTracker.ts apps/api/src/services/aiCostTracker.test.ts apps/api/src/services/aiAgents \
  apps/api/src/services/scriptProposals apps/api/src/__tests__/integration
git commit -m "refactor(ai): funding is per offering everywhere; delete getLlmBillingSourceForOrg (#7601)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 16: BYOK and catalog discovery — `syncConnectionModels` on the `ai-model-discovery` queue

This task implements spec §6 for connections, using W01's queue and worker:
- **Anthropic BYOK.** `models.list()` runs on the partner's key, pinned to the public API through the factory. New ids land as offerings with `source:'discovered'` and **`enabled = false`**, linked to the platform row when the ids match (capability inheritance, price precedence 3).
- **Catalog.** The connection's current listed revision is mirrored: only models both mapped **and** verified, as `source:'catalog'` and disabled.
- **Lifecycle.** A model absent from 3 consecutive **successful** syncs goes `missing`; absent 14 days, it goes `retired`. A failed sync records `discovery_error` and changes no lifecycle.
- **Never.** Discovery never enables, never touches an assignment and never deletes.
- **Triggers.** A sync runs on connection create, on key rotation (a `config_version` bump), daily for every connection, and on demand through `enqueueConnectionSync(id)`, which W04's "Refresh models" calls.
- **Job identity.** The index's `sync-connection:{id}` is realised as job **name** `sync-connection` with BullMQ **jobId** `sync-connection-${id}`. BullMQ rejects 2-part colon ids.

**Files:**
- Create: `apps/api/migrations/2026-11-19-100300-partner-ai-models-discovery-state.sql`
- Modify: `apps/api/src/services/aiModels/discovery.ts` (add `syncConnectionModels`, `MISSING_AFTER_SUCCESSFUL_SYNCS`, `RETIRED_AFTER_DAYS`)
- Modify: W01's `apps/api/src/jobs/aiModelDiscoveryWorker.ts` (+ `.test.ts`): widen `AiModelDiscoveryJobData`, add the `sync-connection` / `sync-all-connections` cases to `processAiModelDiscoveryJob`, add the daily repeatable to `scheduleAiModelDiscoveryJobs`, add `enqueueConnectionSync` / `aiModelConnectionSyncJobId`
- Modify: W02's `apps/api/src/services/aiModels/connections.ts` (enqueue after create and after a key rotation commits)
- Modify: W02's schema file for `partner_ai_models` (`lastSeenAt`, `missedSyncCount`)
- Create: `apps/api/src/__tests__/integration/aiModelConnectionDiscovery.integration.test.ts`
- Modify: the worker's unit test (job id, switch cases); `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` only if it flags `discovery.ts` (see Step 5)

**Interfaces:**
- Consumes: P7 `getConnection`, `getConnectionKeyMaterial`, `decryptConnectionKey`; P5 `getPlatformModelByModelId`; P15 `discoverAnthropicModels(apiKey, target)` (target added in Task 4), `processAiModelDiscoveryJob`, `scheduleAiModelDiscoveryJobs`, `getAiModelDiscoveryQueue`; `getListedProviderByEntryId`, `isLlmProviderCatalogEnabled`; `enqueueOrReplaceStale` (`services/bullmqUtils.ts`).
- Produces:
  ```ts
  // discovery.ts (index name syncConnectionModels)
  export const MISSING_AFTER_SUCCESSFUL_SYNCS = 3;
  export const RETIRED_AFTER_DAYS = 14;
  export interface ConnectionSyncReport {
    connectionId: string; status: 'ok' | 'failed' | 'skipped';
    discovered: number; added: number; markedMissing: number; markedRetired: number; error?: string;
  }
  export function syncConnectionModels(connectionId: string, now?: Date): Promise<ConnectionSyncReport>;
  // worker module
  export function aiModelConnectionSyncJobId(connectionId: string): string;   // `sync-connection-${id}`
  export function enqueueConnectionSync(connectionId: string): Promise<void>;
  ```

- [ ] **Step 1: Migration and schema**

```sql
-- apps/api/migrations/2026-11-19-100300-partner-ai-models-discovery-state.sql
-- AI model registry W03 (#7601, spec §6): per-offering discovery state for
-- connection offerings. A model absent from 3 consecutive SUCCESSFUL syncs is
-- `missing`; absent 14 days it is `retired`. partner_ai_models is partner-axis
-- (no org_id) so no export-policy entry applies. Idempotent.
ALTER TABLE partner_ai_models ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NULL;
ALTER TABLE partner_ai_models ADD COLUMN IF NOT EXISTS missed_sync_count integer NOT NULL DEFAULT 0;

-- Existing connection offerings start their 14-day clock now, so a model the
-- backfill created but no sync has seen yet is never retired on day one.
DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  UPDATE partner_ai_models SET last_seen_at = now()
  WHERE connection_id IS NOT NULL AND last_seen_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'initialised last_seen_at on % connection offering(s)', n; END IF;
END $$;
```

Add to the Drizzle `partnerAiModels` table: `lastSeenAt: timestamp('last_seen_at', { withTimezone: true })` and `missedSyncCount: integer('missed_sync_count').notNull().default(0)`.

- [ ] **Step 2: Write the failing integration test**

```ts
// apps/api/src/__tests__/integration/aiModelConnectionDiscovery.integration.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import './setup';
import { db, withSystemDbAccessContext } from '../../db';
import { syncConnectionModels as realSync } from '../../services/aiModels/discovery';
import { seedRegistryPartner } from './helpers/aiModelRegistrySeed';

// The provider listing is injected (third parameter), so no module mocking:
// everything else — SQL, lifecycle rules, connection bookkeeping — is real.
const m = { discover: vi.fn() };
const syncConnectionModels = (id: string, now?: Date) =>
  realSync(id, now ?? new Date(), { discoverAnthropicModels: m.discover });

const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);
const DAY = 86_400_000;

async function offerings(connectionId: string) {
  return sys(() => db.execute<{ model_id: string; enabled: boolean; lifecycle: string; source: string; platform_model_id: string | null; missed_sync_count: number }>(sql`
    SELECT model_id, enabled, lifecycle, source, platform_model_id, missed_sync_count
    FROM partner_ai_models WHERE connection_id = ${connectionId}::uuid ORDER BY model_id`));
}

describe('syncConnectionModels (BYOK)', () => {
  let connectionId: string;
  beforeEach(async () => {
    const s = await seedRegistryPartner('byok');
    connectionId = s.connectionId!;
    m.discover.mockReset();
  });

  it('new models arrive DISABLED, linked to the platform row when ids match; enabled rows stay enabled', async () => {
    const before = await offerings(connectionId);
    const known = before.find((o) => o.enabled)!;
    const platformId = (await sys(() => db.execute<{ model_id: string }>(sql`
      SELECT model_id FROM ai_platform_models WHERE lifecycle = 'available' LIMIT 1`)))[0]!.model_id;
    m.discover.mockResolvedValue([
      { id: known.model_id, display_name: 'Known', max_input_tokens: 1, max_output_tokens: 1, capabilities: {} },
      { id: platformId, display_name: 'Linked', max_input_tokens: 1, max_output_tokens: 1, capabilities: {} },
      { id: 'claude-brand-new-9', display_name: 'New', max_input_tokens: 1, max_output_tokens: 1, capabilities: {} },
    ]);
    const report = await syncConnectionModels(connectionId);
    expect(report.status).toBe('ok');
    const after = await offerings(connectionId);
    expect(after.find((o) => o.model_id === known.model_id)!.enabled).toBe(true);
    expect(after.find((o) => o.model_id === 'claude-brand-new-9')).toMatchObject({ enabled: false, source: 'discovered', lifecycle: 'available', platform_model_id: null });
    expect(after.find((o) => o.model_id === platformId)!.platform_model_id).not.toBeNull();
  });

  it('absent from 3 successful syncs → missing; absent 14 days → retired; nothing deleted', async () => {
    m.discover.mockResolvedValue([{ id: 'claude-keeper-1', display_name: 'K', max_input_tokens: 1, max_output_tokens: 1, capabilities: {} }]);
    await syncConnectionModels(connectionId);
    m.discover.mockResolvedValue([]);
    const t0 = new Date();
    await syncConnectionModels(connectionId, t0);
    await syncConnectionModels(connectionId, t0);
    expect((await offerings(connectionId)).find((o) => o.model_id === 'claude-keeper-1')!.lifecycle).toBe('available');
    await syncConnectionModels(connectionId, t0);
    expect((await offerings(connectionId)).find((o) => o.model_id === 'claude-keeper-1')!.lifecycle).toBe('missing');
    await syncConnectionModels(connectionId, new Date(t0.getTime() + 15 * DAY));
    expect((await offerings(connectionId)).find((o) => o.model_id === 'claude-keeper-1')!.lifecycle).toBe('retired');
  });

  it('a failed sync records discovery_error and changes no lifecycle', async () => {
    const before = await offerings(connectionId);
    m.discover.mockRejectedValue(new Error('HTTP 401'));
    expect((await syncConnectionModels(connectionId)).status).toBe('failed');
    expect(await offerings(connectionId)).toEqual(before);
    const [conn] = await sys(() => db.execute<{ discovery_error: string | null }>(sql`
      SELECT discovery_error FROM partner_ai_connections WHERE id = ${connectionId}::uuid`));
    expect(conn!.discovery_error).toContain('401');
  });

  it('discovery never changes an assignment', async () => {
    const snapshot = async () => sys(() => db.execute(sql`SELECT * FROM ai_model_assignments ORDER BY id`));
    const before = await snapshot();
    m.discover.mockResolvedValue([]);
    await syncConnectionModels(connectionId);
    expect(await snapshot()).toEqual(before);
  });
});

describe('syncConnectionModels (catalog)', () => {
  it('mirrors only mapped AND verified models of the listed revision, disabled', async () => {
    const s = await seedRegistryPartner('catalog');
    const report = await syncConnectionModels(s.connectionId!);
    expect(report.status).toBe('ok');
    const rows = await offerings(s.connectionId!);
    expect(rows.every((r) => r.source === 'catalog' || r.enabled)).toBe(true);
    expect(rows.filter((r) => !r.enabled).every((r) => r.source === 'catalog')).toBe(true);
  });
});
```

> The catalog case goes through the same wrapper. Catalog discovery never calls the injected Anthropic listing, so its stub is irrelevant there.

- [ ] **Step 3: Run it and watch it fail**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelConnectionDiscovery.integration.test.ts`
Expected: FAIL with `syncConnectionModels is not a function`.

- [ ] **Step 4: Implement `syncConnectionModels`**

```ts
// apps/api/src/services/aiModels/discovery.ts — append
export const MISSING_AFTER_SUCCESSFUL_SYNCS = 3;
export const RETIRED_AFTER_DAYS = 14;

export interface ConnectionSyncReport {
  connectionId: string;
  status: 'ok' | 'failed' | 'skipped';
  discovered: number;
  added: number;
  markedMissing: number;
  markedRetired: number;
  error?: string;
}

interface DiscoveredOffering { modelId: string; platformModelId: string | null; capabilities: unknown | null; source: 'discovered' | 'catalog' }

const sysTx = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

/**
 * Spec §6 for ONE connection. Never enables, never touches an assignment,
 * never deletes; a failed listing changes no lifecycle.
 */
export async function syncConnectionModels(
  connectionId: string,
  now: Date = new Date(),
  deps: { discoverAnthropicModels: typeof discoverAnthropicModels } = { discoverAnthropicModels },
): Promise<ConnectionSyncReport> {
  const base = { connectionId, discovered: 0, added: 0, markedMissing: 0, markedRetired: 0 };
  const conn = await sysTx(() => getConnection(connectionId));
  if (!conn) return { ...base, status: 'skipped', error: 'connection not found' };
  if (conn.kind !== 'anthropic_byok' && conn.kind !== 'catalog') {
    return { ...base, status: 'skipped', error: `${conn.kind} discovery arrives in a later wave` };
  }

  let found: DiscoveredOffering[];
  try {
    if (conn.kind === 'anthropic_byok') {
      const material = await sysTx(() => getConnectionKeyMaterial(conn.id));
      if (!material) throw new Error('The connection has no stored key.');
      const models = await deps.discoverAnthropicModels(decryptConnectionKey(material), { kind: 'anthropic' });
      found = [];
      for (const model of models) {
        const linked = await sysTx(() => getPlatformModelByModelId(model.id));
        found.push({ modelId: model.id, platformModelId: linked?.id ?? null, capabilities: model.capabilities ?? null, source: 'discovered' });
      }
    } else {
      const provider = isLlmProviderCatalogEnabled() && conn.catalogEntryId
        ? await getListedProviderByEntryId(conn.catalogEntryId)
        : null;
      if (!provider) throw new Error('The catalog provider for this connection is not listed.');
      found = provider.verifiedModels
        .filter((id) => Object.hasOwn(provider.modelMap, id))
        .map((id) => ({ modelId: id, platformModelId: null, capabilities: null, source: 'catalog' as const }));
    }
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    await sysTx(() => db.update(partnerAiConnections)
      .set({ discoveryError: message, updatedAt: now })
      .where(eq(partnerAiConnections.id, conn.id)));
    return { ...base, status: 'failed', error: message };
  }

  const seen = found.map((f) => f.modelId);
  const retireBefore = new Date(now.getTime() - RETIRED_AFTER_DAYS * 86_400_000);
  const counts = await sysTx(async () => {
    let added = 0;
    for (const f of found) {
      const rows = await db.execute<{ inserted: boolean }>(sql`
        INSERT INTO partner_ai_models (partner_id, connection_id, platform_model_id, model_id, source,
          capabilities, enabled, lifecycle, last_seen_at, missed_sync_count)
        VALUES (${conn.partnerId}::uuid, ${conn.id}::uuid, ${f.platformModelId}::uuid, ${f.modelId}, ${f.source},
          ${f.capabilities === null ? null : JSON.stringify(f.capabilities)}::jsonb, false, 'available', ${now.toISOString()}::timestamptz, 0)
        ON CONFLICT (connection_id, model_id) WHERE connection_id IS NOT NULL DO UPDATE SET
          lifecycle = 'available',
          last_seen_at = EXCLUDED.last_seen_at,
          missed_sync_count = 0,
          platform_model_id = COALESCE(partner_ai_models.platform_model_id, EXCLUDED.platform_model_id),
          capabilities = COALESCE(EXCLUDED.capabilities, partner_ai_models.capabilities)
          -- `enabled` is deliberately absent: discovery never enables (spec §6).
        RETURNING (xmax = 0) AS inserted`);
      if (rows[0]?.inserted) added += 1;
    }
    // Manual rows are the admin's; discovery never ages them.
    const missing = await db.execute(sql`
      UPDATE partner_ai_models
      SET missed_sync_count = missed_sync_count + 1,
          lifecycle = CASE WHEN lifecycle = 'available' AND missed_sync_count + 1 >= ${MISSING_AFTER_SUCCESSFUL_SYNCS}
                           THEN 'missing' ELSE lifecycle END
      WHERE connection_id = ${conn.id}::uuid
        AND source IN ('discovered', 'catalog')
        AND NOT (model_id = ANY(${seen}::text[]))
      RETURNING lifecycle`);
    const retired = await db.execute(sql`
      UPDATE partner_ai_models SET lifecycle = 'retired'
      WHERE connection_id = ${conn.id}::uuid
        AND source IN ('discovered', 'catalog')
        AND lifecycle = 'missing'
        AND last_seen_at < ${retireBefore.toISOString()}::timestamptz
      RETURNING id`);
    await db.update(partnerAiConnections)
      .set({ lastDiscoveredAt: now, discoveryError: null, updatedAt: now })
      .where(eq(partnerAiConnections.id, conn.id));
    return {
      added,
      markedMissing: (missing as Array<{ lifecycle: string }>).filter((r) => r.lifecycle === 'missing').length,
      markedRetired: retired.length,
    };
  });
  return { ...base, status: 'ok', discovered: found.length, ...counts };
}
```

Imports to add to `discovery.ts`: `and`, `eq`, `inArray`, `sql` (`drizzle-orm`); `db`, `runOutsideDbContext`, `withSystemDbAccessContext` (`../../db`); `partnerAiConnections` (W02 schema); `getConnection`, `getConnectionKeyMaterial`, `decryptConnectionKey` (`./connections`); `getPlatformModelByModelId` (`./platformModels`); `getListedProviderByEntryId` (`../llmProviderCatalog`); `isLlmProviderCatalogEnabled` (`../llm/llmConfigResolver`).

> `${seen}::text[]` binds a JS array. Memory note "Drizzle `${ids}::uuid[]` binding trap only caught by real-DB test" applies: if the driver serialises the array wrongly, build it with `sql.join(seen.map((id) => sql`${id}`), sql`, `)` inside `ARRAY[...]::text[]`, and keep the empty-array case (`ARRAY[]::text[]`). The integration test's "absent" cases catch both.

- [ ] **Step 5: Queue wiring and triggers**

In W01's `apps/api/src/jobs/aiModelDiscoveryWorker.ts`, widen the job data union (P15):

```ts
export type AiModelDiscoveryJobData =
  | { type: 'sync-platform'; trigger: 'schedule' | 'manual' | 'boot' }          // W01
  | { type: 'sync-connection'; connectionId: string }                            // W03
  | { type: 'sync-all-connections' };                                            // W03
```

and add:

```ts
export function aiModelConnectionSyncJobId(connectionId: string): string {
  // BullMQ rejects a custom id containing ':' unless it splits into exactly 3 parts.
  return `sync-connection-${connectionId}`;
}

export async function enqueueConnectionSync(connectionId: string): Promise<void> {
  await enqueueOrReplaceStale(
    getAiModelDiscoveryQueue(),
    'sync-connection',
    aiModelConnectionSyncJobId(connectionId),
    { type: 'sync-connection', connectionId },
    { attempts: 3, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: { count: 200 }, removeOnFail: { count: 200 } },
    '[ai-model-discovery]',
  );
}
```

In `processAiModelDiscoveryJob`, which switches on `job.data.type`, add the two cases. Widen its return type to `Promise<SyncReport | ConnectionSyncReport | { enqueued: number }>`:

```ts
      case 'sync-connection':
        return syncConnectionModels(job.data.connectionId);
      case 'sync-all-connections': {
        const ids = await withSystemDbAccessContext(async () => (await db
          .select({ id: partnerAiConnections.id })
          .from(partnerAiConnections)
          .where(and(
            inArray(partnerAiConnections.kind, ['anthropic_byok', 'catalog']),
            eq(partnerAiConnections.status, 'active'),
          ))).map((r) => r.id));
        for (const id of ids) await enqueueConnectionSync(id);
        return { enqueued: ids.length };
      }
```

In `scheduleAiModelDiscoveryJobs`, next to W01's daily `sync-platform` repeatable, register the daily connection fan-out. Use the same remove-then-add pattern W01 uses for its own repeatable (a stable repeat `jobId`, as in `jobs/exchangeRateSync.ts`):

```ts
  await queue.add('sync-all-connections', { type: 'sync-all-connections' }, { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: 'sync-all-connections' });
```

`enqueueOrReplaceStale` is `services/bullmqUtils.ts:43`. In W02's `connections.ts` after `createConnection`, and in Task 6B's facade after `connectCompat` and after the in-place key/catalog rotation, once each has **committed**:

```ts
    // Outside any held DB context: the instrumented queue asserts it (#3127).
    void runOutsideDbContext(() => enqueueConnectionSync(created.id))
      .catch((err) => console.error('[connections] discovery enqueue failed (non-fatal)', err));
```

Worker unit test additions:

```ts
it('connection sync job ids are colon-free and per connection', () => {
  expect(aiModelConnectionSyncJobId('5f0c…')).toBe('sync-connection-5f0c…');
  expect(aiModelConnectionSyncJobId('x')).not.toContain(':');
});
it('routes sync-connection to syncConnectionModels', async () => {
  await processAiModelDiscoveryJob({ data: { type: 'sync-connection', connectionId: 'c1' } });
  expect(syncConnectionModels).toHaveBeenCalledWith('c1');
});
```

Run `cd apps/api && npx vitest run src/__tests__/partner-wide-write-coverage.test.ts`. If it now lists `services/aiModels/discovery.ts`, add an `ALLOWED_WITHOUT_CAPABILITY_CHECK` entry: `'services/aiModels/discovery.ts': 'Worker-only system-context upsert of DISABLED connection offerings; never enables, never touches assignments (spec §6).'`.

- [ ] **Step 6: Run and commit**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelConnectionDiscovery.integration.test.ts`
Expected: PASS (5 tests).

Run: `cd apps/api && npx vitest run src/services/aiModels src/jobs/aiModelDiscoveryWorker.test.ts src/jobs/workerReadiness src/services/workerRegistry src/__tests__/partner-wide-write-coverage.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

Run: `pnpm db:check-drift`
Expected: no drift.

```bash
git add apps/api/migrations/2026-11-19-100300-partner-ai-models-discovery-state.sql \
  apps/api/src/services/aiModels/discovery.ts apps/api/src/services/aiModels/connections.ts apps/api/src/services/partnerLlmConfig.ts \
  apps/api/src/db/schema apps/api/src/jobs/aiModelDiscoveryWorker.ts apps/api/src/jobs/aiModelDiscoveryWorker.test.ts \
  apps/api/src/__tests__/integration/aiModelConnectionDiscovery.integration.test.ts \
  apps/api/src/__tests__/partner-wide-write-coverage.test.ts
git commit -m "feat(ai): BYOK and catalog connection discovery on the ai-model-discovery queue (#7601)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 17: Delete the hard-coded lists and legacy recorders; add the AST contract test

Every surface is cut over, so the legacy machinery has no callers left. This task deletes it and pins the invariants mechanically: contract tests caught 5/5 of the cascade misses, while review caught 0/5.

**Deleted:**
- In `aiCostTracker.ts`:
  - `MODEL_PRICING`, `isPricedModel`, `DEFAULT_PRICING` and the cache multipliers;
  - `calculateCostCents`, `calculateCatalogCostCents`, `getSessionModel`;
  - `recordUsage`, `recordUsageFromSdkResult`, `recordSessionlessSdkUsage`, the dead `recordOpenAIUsage`, and the `OFFERABLE_AI_MODELS` re-export;
  - W02's `LegacyCostEvent` emission and the recorders' optional `ledger` argument.
- `aiOfferableModels.ts` (the whole file).
- In `llmConfigResolver.ts`: `resolveWireModel`, `getAnthropicClientForPartner`, `buildAnthropicClient`, `buildCatalogEgressRecorder`.
- In W02's `invocationLedger.ts`: the shadow listener that consumed `LegacyCostEvent` (`recordInvocation` stays).

**Moved, not deleted:** `getLegacyModelRates` and a frozen copy of the legacy rate table move from `aiCostTracker.ts` into W02's `services/aiModels/legacySurfaceModels.ts` as `LEGACY_MODEL_RATES`. W02's projection prices backfilled non-platform offerings with them (P12), and the parity adapter uses them too. That use is projection only, never billing, and W08 deletes them with the projection.

**Kept, deliberately:**
- `resolveLlmConfig` / `resolveLlmConfigForOrg`, the env OpenAI-compatible path's only resolver (W06) and the readiness checks.
- The numeric-totals branch of `settleAiBudgetReservation`, used by `openaiSessionManager.ts` until W06.
- `CatalogPricingSnapshot`, still the catalog snapshot's pricing type.
- W02's projection modules (`legacyProjection.ts`, `legacyReconcile.ts`, `legacySurfaceModels.ts`), Task 6A's only inputs, until W08.

**Contract test** (index invariant #1, spec §9; the AST approach of `services/accounting/neutralCore.guard.test.ts`) flags:
1. a `'claude-<family>-<digit>…'` string literal outside the allowlist;
2. `new Anthropic(` outside `services/aiModels/connectionFactory.ts`;
3. a `buildWireParams(` call outside `services/aiModels/`, or a call to W01's per-model-id helpers (`agentSdkWireOptions(` / `messagesApiWireOptions(`) outside `services/aiModels/`, `services/llm/providerFidelityHarness.ts` and `services/llm/toolCapture/` (the platform-admin harness and the dev capture tool are the only legitimate model-id-keyed callers);
4. any `total_cost_usd` property read outside `services/aiModels/invocationUsage.ts`.

**Files:**
- Create: `apps/api/src/services/aiModels/aiModelRegistry.contract.test.ts`
- Delete: `apps/api/src/services/aiOfferableModels.ts`
- Modify: `apps/api/src/services/aiCostTracker.ts`, `apps/api/src/services/aiCostTracker.test.ts`
- Modify: `apps/api/src/services/llm/llmConfigResolver.ts`, `apps/api/src/services/llm/llmConfigResolver.test.ts`
- Modify: W02's `apps/api/src/services/aiModels/legacySurfaceModels.ts` (receives `getLegacyModelRates` + `LEGACY_MODEL_RATES`), W02's `legacyReconcile.ts` / `legacyProjection.ts` (import path), W02's `invocationLedger.ts` (delete the shadow listener), `apps/api/src/services/aiModels/parity/registrySnapshotDeps.ts` (import path)
- Modify (each only if still importing `OFFERABLE_AI_MODELS`; W01/W02 may have done it): `apps/api/src/routes/aiProvider.ts` (~L98), `apps/api/src/services/llmProviderCatalog.ts` (~L119), `apps/api/src/services/partnerLlmConfig.ts` (~L351), `apps/web/src/components/admin/LlmProviderCatalog.tsx` (~L26)
- Modify: `apps/api/src/services/llm/__scripts__/tool-eval.ts` (~L157), `tool-capture.ts` (~L87) if they use deleted symbols
- Modify: any file the new contract test flags (expected: the manager's `totalCostUsd` warn field from Task 7)

**Interfaces:**
- Consumes: everything above.
- Produces: the contract test (no runtime exports).

- [ ] **Step 1: Write the contract test (it fails until the deletions land)**

```ts
// apps/api/src/services/aiModels/aiModelRegistry.contract.test.ts
/**
 * AI model registry invariants (#7598 index "Invariants" #1, #2; spec §8, §9):
 *  1. no hard-coded Claude model id outside the bootstrap fallback;
 *  2. `new Anthropic(` only in the connection factory;
 *  3. `buildWireParams(` only inside services/aiModels/;
 *  4. the SDK's `total_cost_usd` read only by the telemetry extractor.
 * AST-based (comments never trip it), mirroring neutralCore.guard.test.ts.
 * Correctness is proven by the per-surface parity suites; this keeps the
 * hard-coded lists from growing back (quorum #14).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..', '..');
const ROOTS = ['apps/api/src', 'ee', 'packages/shared/src', 'packages/extension-sdk/src', 'apps/web/src'];
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '__tests__', '__fixtures__', 'migrations', '.astro']);
const MODEL_ID = /^claude-[a-z]+-\d/;

/** path (repo-relative, '/'-separated) → why it may contain a model literal. ≥ 20 chars each. */
const MODEL_LITERAL_ALLOWLIST: Record<string, string> = {
  'apps/api/src/services/aiModel.ts': 'Bootstrap fallback for a fresh self-host before the first platform sync (index invariant #1).',
  'apps/api/src/db/schema/ai.ts': 'Stale ai_budgets.allowed_models column default; W08 (#7606) drops it with the column. (The ai_sessions.model default is dropped in Task 9.)',
  'apps/web/src/components/clientAi/PolicyEditor.tsx': 'Dead Office allowedModels editor; W04 (#7602) replaces it with the office_chat assignment.',
  'apps/api/src/services/aiModels/legacySurfaceModels.ts': 'W02 legacy projection inputs (frozen legacy defaults + rates) for the cutover and post-cutover bootstrap; W08 deletes them.',
};
/** Directory prefixes whose files may carry model literals. */
const MODEL_LITERAL_ALLOWLIST_PREFIXES: Record<string, string> = {
  'apps/api/src/services/aiModels/parity/': 'W02/W03 parity fixtures are test-support data describing legacy configs; W08 deletes the harness.',
};
const ANTHROPIC_CTOR_ALLOWED = new Set(['apps/api/src/services/aiModels/connectionFactory.ts']);
const SDK_COST_ALLOWED = new Set(['apps/api/src/services/aiModels/invocationUsage.ts']);
const MODEL_ID_WIRE_HELPERS = new Set(['agentSdkWireOptions', 'messagesApiWireOptions']);
const MODEL_ID_WIRE_HELPER_ALLOWED_PREFIXES = [
  'apps/api/src/services/aiModels/',
  'apps/api/src/services/llm/providerFidelityHarness.ts',
  'apps/api/src/services/llm/toolCapture/',
];
const literalAllowed = (file: string) =>
  Boolean(MODEL_LITERAL_ALLOWLIST[file]) || Object.keys(MODEL_LITERAL_ALLOWLIST_PREFIXES).some((p) => file.startsWith(p));

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec|integration\.test)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

export interface Violation { file: string; rule: 1 | 2 | 3 | 4; line: number; text: string }

export function scanSource(file: string, source: string): Violation[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const v: Violation[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && MODEL_ID.test(n.text) && !literalAllowed(file)) {
      v.push({ file, rule: 1, line: at(n), text: n.text });
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Anthropic' && !ANTHROPIC_CTOR_ALLOWED.has(file)) {
      v.push({ file, rule: 2, line: at(n), text: 'new Anthropic(' });
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'buildWireParams'
      && !file.startsWith('apps/api/src/services/aiModels/')) {
      v.push({ file, rule: 3, line: at(n), text: 'buildWireParams(' });
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && MODEL_ID_WIRE_HELPERS.has(n.expression.text)
      && !MODEL_ID_WIRE_HELPER_ALLOWED_PREFIXES.some((p) => file.startsWith(p))) {
      v.push({ file, rule: 3, line: at(n), text: `${n.expression.text}(` });
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'total_cost_usd' && !SDK_COST_ALLOWED.has(file)) {
      v.push({ file, rule: 4, line: at(n), text: '.total_cost_usd' });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return v;
}

describe('AI model registry contract', () => {
  it('the scanner fires on each rule (control)', () => {
    const src = [
      "const a = 'claude-opus-5-5';",
      'const b = new Anthropic({ apiKey });',
      'const c = buildWireParams(x);',
      'const c2 = agentSdkWireOptions(model);',
      'const d = result.total_cost_usd;',
      "// 'claude-sonnet-4-6' in a comment is fine",
      "const e = 'claude-desktop';",
    ].join('\n');
    expect(scanSource('apps/api/src/services/someSurface.ts', src).map((x) => x.rule)).toEqual([1, 2, 3, 3, 4]);
  });

  it('every allowlist entry exists and carries a real reason', () => {
    for (const [file, reason] of Object.entries(MODEL_LITERAL_ALLOWLIST)) {
      expect(reason.length, file).toBeGreaterThanOrEqual(20);
      expect(() => statSync(join(REPO, file)), file).not.toThrow();
    }
  });

  it('no violations in the repo', () => {
    const files = ROOTS.flatMap((r) => walk(join(REPO, r), []));
    expect(files.length).toBeGreaterThan(500);   // proves the walk actually ran
    const violations = files.flatMap((full) => {
      const rel = relative(REPO, full).split(sep).join('/');
      return scanSource(rel, readFileSync(full, 'utf8'));
    });
    expect(violations).toEqual([]);
  }, 60_000);
});
```

- [ ] **Step 2: Run it and watch it fail on real violations**

Run: `cd apps/api && npx vitest run src/services/aiModels/aiModelRegistry.contract.test.ts`
Expected: the control and allowlist tests PASS. "no violations" FAILS, listing at least:
- rule 1 in `aiCostTracker.ts` (`MODEL_PRICING`), `aiOfferableModels.ts`, and `apps/web/src/components/admin/LlmProviderCatalog.tsx` (if W01 left it);
- rule 2 in `llmConfigResolver.ts`;
- rule 4 in `streamingSessionManager.ts` (the Task 7 `totalCostUsd:` warn field).

This proves the scanner sees the real tree.

- [ ] **Step 3: Delete and repoint**

1. `aiCostTracker.ts`: move `getLegacyModelRates` (with a frozen copy of the `MODEL_PRICING` rows and the `DEFAULT_PRICING` fallback it reads, as `LEGACY_MODEL_RATES`) into W02's `legacySurfaceModels.ts`, and repoint its importers: W02's projection, `parity/registrySnapshotDeps.ts` and its own test. Then delete the symbols listed above and the `aiCostTracker.test.ts` cases that covered them. Those behaviours are now pinned by `settleInvocation.test.ts` and `aiInvocationSettlement.integration.test.ts`. Also delete W02's shadow-ledger listener and the `LegacyCostEvent` type: with no legacy recorder left, nothing emits it.
2. Delete `aiOfferableModels.ts`, then fix each remaining importer:

```ts
// routes/aiProvider.ts — supportedModels
supportedModels: (await listPlatformModels())
  .filter((m) => m.platformOffered && m.lifecycle === 'available')
  .map((m) => m.modelId),
// llmProviderCatalog.ts / partnerLlmConfig.ts — "is this a model we know?"
if (!(await getPlatformModelByModelId(modelId))) throw /* the existing validation error */;
```

   In `apps/web/src/components/admin/LlmProviderCatalog.tsx`, replace the hand-mirrored array with the model ids from `GET /admin/ai-models` (W01's route), fetched where the component loads its catalog.
3. `llmConfigResolver.ts`: delete `resolveWireModel`, `getAnthropicClientForPartner`, `buildAnthropicClient`, `buildCatalogEgressRecorder` and the `Anthropic` / `buildGuardedLlmFetch` / `recordLlmEgressEvent` imports they used. Delete their test cases. The factory's equivalents are pinned in `connectionFactory.test.ts`.
4. `streamingSessionManager.ts`: the "no/empty usage" warn logs `sdkReportedCostUsd: outcome.sdkReportedCostUsd` instead of `resultMsg.total_cost_usd`. Fix any other rule-4 hit the same way.
5. `llm/__scripts__/tool-eval.ts` / `tool-capture.ts`: replace `calculateCostCents(model, …)` with:

```ts
const row = await getPlatformModelByModelId(model);
const cents = row?.rates
  ? priceInvocation({ source: 'platform', standard: row.rates }, { input: inTok, output: outTok, cacheRead: 0, cacheWrite: 0 }, {})
  : NaN; // dev script: an unpriced model prints NaN rather than a guess
```

   Change `buildClaudeSdkChildEnv(resolved)` there to take a `UsableLlmConfig` built for the script's target, as it does today (the type is unchanged).

- [ ] **Step 4: Run the contract and every affected suite**

Run: `cd apps/api && npx vitest run src/services/aiModels/aiModelRegistry.contract.test.ts`
Expected: PASS (3 tests).

Run: `cd apps/api && npx vitest run src/services/aiCostTracker.test.ts src/services/llm src/routes/aiProvider src/services/llmProviderCatalog src/services/partnerLlmConfig && npx tsc --noEmit -p tsconfig.json`
Expected: PASS / no errors.

Run: `cd apps/web && npx tsc --noEmit && npx vitest run src/components/admin`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/api/src/services/aiModels/aiModelRegistry.contract.test.ts apps/api/src/services/aiCostTracker.ts \
  apps/api/src/services/aiCostTracker.test.ts apps/api/src/services/aiOfferableModels.ts apps/api/src/services/llm \
  apps/api/src/routes/aiProvider.ts apps/api/src/services/llmProviderCatalog.ts apps/api/src/services/partnerLlmConfig.ts \
  apps/api/src/services/streamingSessionManager.ts apps/web/src/components/admin/LlmProviderCatalog.tsx
git commit -m "refactor(ai): delete hard-coded model lists and legacy cost paths; registry contract test (#7601)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 18: Whole-wave verification, review and PR

This task has no new code. It runs every suite this wave can affect, including the separate contract configs that `pnpm test` does not run. It then does one independent review round (high blast radius: billing and funding) and opens the PR.

- [ ] **Step 1: Full API unit suite**

Run: `cd apps/api && npx vitest run`
Expected: PASS. Two failure modes here are real bugs, not flakes, and only appear in a full run:
- `orgMerge.test.ts` ("no merge policy registered for …");
- `cascadeDelete.test.ts` / `moveOrg.coverage.test.ts`.

This wave adds no `org_id` or `device_id` table, so both should be untouched. Its two new tables are a system singleton and a partner-axis table.

- [ ] **Step 2: Contract suites with real Postgres**

Run: `pnpm test-stack up`, then:
- `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModel src/__tests__/integration/aiProviderAuthority src/__tests__/integration/resolveModel src/__tests__/integration/aiInvocationSettlement src/__tests__/integration/ai-budget-reservations src/__tests__/integration/topologyAiReadScope src/__tests__/integration/llmCatalogSelection src/__tests__/integration/workspaceEnrichmentByok src/__tests__/integration/topologyAiFailureAccounting src/__tests__/integration/tenant-export-policy src/__tests__/integration/tenantExportErasureRoundtrip src/__tests__/integration/tenantCascade src/__tests__/integration/orgLifecycleFoundations`
- The full integration suite once (`npx vitest run --config vitest.integration.config.ts`). Dropping the `ai_sessions.model` default (Task 9) can red any suite with a raw `INSERT INTO ai_sessions` that Task 9's grep missed.
- `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`
- `pnpm db:check-drift`

Expected: all PASS. The per-surface parity suite already ran in Step 1, because it is a unit suite (`services/aiModels/parity/w03Surfaces.parity.test.ts`, 12 parity tests plus 3 mutations that must reject). RLS coverage now includes the `ai_model_registry_state` system-table entry and `ai_model_registry_partner_cutover` in `PARTNER_TENANT_TABLES`. There is no drift.

- [ ] **Step 2A: Pricing go/no-go (W02 handoff #3)**

Before the PR, compare the W02 shadow ledger's legacy cost with the registry cost on a database that has W02 shadow rows. Use a staging copy, or the `pnpm test-stack` database after a scripted chat/agent/reviewer run under W02:

```sql
SELECT surface, funding_source, count(*) AS n,
       sum(legacy_cost_cents) AS legacy_cents, sum(cost_cents) AS registry_cents,
       max(abs(cost_cents - legacy_cost_cents)) AS worst_row_cents
FROM ai_invocations WHERE ledger_mode = 'shadow'
GROUP BY 1, 2 ORDER BY 1, 2;
```

Go if, for every `(surface, funding_source)` group, `registry_cents` is within 1% of `legacy_cents`. Two exceptions are expected and are not a no-go: catalog rows, which bill the revision rate, and SDK turns whose legacy number was the SDK's own cost. Any other gap is a pricing bug: stop and fix it before merging. Paste the table into the PR body.

- [ ] **Step 3: Other packages**

Run: `cd packages/shared && npx vitest run && cd ../extension-sdk && npx vitest run && cd ../../ee/workspace && npx vitest run && cd ../../apps/web && npx tsc --noEmit && npx vitest run && cd ../docs && pnpm build`
Expected: all PASS.

- [ ] **Step 4: Mechanical contract checks (grep the contract, CLAUDE.md)**

```bash
git grep -n "getLlmBillingSourceForOrg\|MODEL_PRICING\|OFFERABLE_AI_MODELS\|DEFAULT_PRICING\|isPricedModel\|recordUsageFromSdkResult\|recordSessionlessSdkUsage\|calculateCostCents\|resolveWireModel\|getAnthropicClientForPartner" -- apps ee packages
git grep -n "BREEZE_AI_SCRIPT_REVIEWER_MODEL\|WORKSPACE_CONTENT_LLM_MODEL\|AI_SCRIPT_REVIEWER_MODEL" -- apps/api/src/services apps/api/src/routes ee | grep -v "aiModels/legacy\|config/env\|system/connections"
git ls-tree --name-only origin/main apps/api/migrations | grep -E '/[0-9]{4}-' | sort | tail -1
ls apps/api/migrations | sort | tail -7
```

Expected:
- the first grep prints nothing;
- the second prints nothing outside W02's projection, `config/env.ts` and the env registry (all kept until W08);
- the seven `2026-11-19-…` migrations sort **after** the newest file on `origin/main`. If not, rename them to sort after it, keeping their relative order, and re-run `autoMigrate.test.ts`.

- [ ] **Step 5: One independent review round**

Run `/pr-review-toolkit:review-pr` on the branch, with the reviewer pointed at:
- the Review Focus list above;
- `settleAiBudgetReservation`'s binding assertion, and the keyed debit / pending-settlement replay (Task 6 Step 8a);
- `resolveModel`'s bounded-fallback same-connection/funding checks;
- the cutover gate and lease (Task 6A) and the registry-native facade remaps (Task 6B);
- the agent `blocked` transitions and the admitted-offering re-resolve.

Act only on confirmed, consequential findings. Re-review a fix only if it touched billing, funding or the resolver.

- [ ] **Step 6: Open the PR**

Push `feature/7598-ai-model-registry/wave-7601` and open the PR against `main`. The title is `feat(ai): model registry W03 — resolveModel cutover, per-offering funding, single cost function`. The body:
- includes `Closes #7601`;
- lists:
  - the seven migrations;
  - the cutover: after deploy, a background sweep projects each partner from legacy config once. A partner's AI requests answer "AI configuration is being upgraded" only if that partner's own projection fails. `/health` is unaffected;
  - the cross-repo dependency: the billing service must honour `idempotencyKey` on `ai-credits/deduct` (Task 6 Step 8a). Until it does, a retried debit can double-charge, so the billing change ships first;
  - the pricing go/no-go table (Step 2A);
  - the legacy policy fields that stop routing until W04 (Global Constraints);
  - the deprecated env vars (`BREEZE_AI_SCRIPT_REVIEWER_MODEL`, `WORKSPACE_CONTENT_LLM_MODEL`), with the "migrated by W02/W03" note for self-hosters;
  - the new `AI_PLATFORM_INFERENCE_GEO`;
  - the new `blocked` run status;
- links the Preconditions table with every adaptation the executor made;
- states that the non-English `blocked` labels are machine-drafted;
- ends with the `🤖 Generated with [Claude Code](https://claude.com/claude-code)` line.

Merge through the queue (`gh pr merge <N>`, never `--admin`). After merge, call `complete_wave` for #7601.

- [ ] **Step 7: Tear down**

Run: `pnpm test-stack down`

---

## Index additions

These names are introduced here and absent from the index. None renames an index name.

| Where | Name | Why |
|---|---|---|
| `services/aiModels/eligibility.ts` | `checkEligibility`, `CandidateFacts`, `EligibilityContext` (incl. `geoCarriable`), `ResolveFailureReason`, `PARTNER_PLAN_ORDER`, `PartnerPlan`, `planSatisfies`, `ConnectionKind` | Spec §9 step 2 as a pure, table-testable rule set |
| `services/aiModels/candidateLoader.ts` | `loadOfferingCandidate`, `loadPlatformDefaultCandidate`, `loadPartnerFacts`, `loadUserPermissionPredicate`, `findOfferingIdByModel({ partnerId, orgId, surface, modelId })` (scoped to the surface default's connection), `readOrgPartnerId`, `readSessionModelRow`, `LoadedCandidate`, `ResolvedConnection`, `AllowedOptions`, `EMPTY_OPTION_SUPPORT` | The single adapter over W01/W02 row shapes; live connection / catalog resolution |
| `services/aiModels/promptProfiles.ts` | `toPromptProfile`, `applyPromptProfile` (re-exports W01's `PROMPT_PROFILES` / `PromptProfile`) | §7 prompt-profile hook (identity in v1) |
| `services/aiModels/transport.ts` | `DispatchTransport`, `TransportCarriage`, `defaultTransport`, `transportCarries` | Never apply (or price) an option W01's adapters cannot send |
| `services/aiModels/resolveModel.ts` | `ResolveModelInput.requested.origin` (`'user' \| 'session' \| 'policy'`), `.maxTokens`, `.transport`; `ResolvedModel.{surface, role, transport, partnerId, orgId, logicalModel, wireParams, limits, fellBack}`; `ModelUnavailable.{offeringId, message}`; `PLATFORM_ONLY_SURFACES`, `unavailableMessage`, `RequestOrigin` | Additive to the §9 signature. `origin` encodes §9.1's stored-choice rule and the policy-vs-user `allow_user_choice` distinction. `partnerId: null` is allowed only for `patch_test` |
| `services/aiModels/connectionFactory.ts` | `createAnthropicClient`, `AnthropicClientTarget`, `clientForConnection`, `anthropicClientFor`, `sdkModelOptions`, `messagesModelParams`, `createMessage`, `MessagesBody`, `MessageAttempt`, `MessageOutcome`, `describeDispatch`, `DispatchFacts`, `grantCatalogSdkEgress`, `ANTHROPIC_PUBLIC_BASE_URL`, `SERVER_SIDE_FALLBACK_BETA` | The brief's "connection factory"; sole `new Anthropic(` |
| `services/aiModels/turnBinding.ts` | `TurnBinding`, `turnBindingFrom`, `liveQueryKey`, `parseTurnBinding`, `rateForServedModel`, `stableJson` | §9.2 turn-claim binding + live-query reuse |
| `services/aiModels/invocationUsage.ts` | `BilledUsage`, `TurnOutcome`, `SdkTurnObservation`, `newSdkTurnObservation`, `observeSdkMessage`, `sdkTurnUsage`, `SdkResultLike`, `MessageLike`, `messagesUsage` | Provider output → token components + refusal outcome, with no provider cost |
| `services/aiModels/settleInvocation.ts` | `settleInvocation`, `SettleInvocationInput`, `SettledInvocation`, `priceUsage`, `PricedUsage`, `sumCostCents`, `costEstimator`, `toNewInvocations`, `WEB_SEARCH_COST_CENTS` | The single billing path over `priceInvocation` + `recordInvocation` (`ledgerMode: 'authoritative'`) |
| `services/aiModels/refusals.ts` | `REFUSAL_DOCS_URL`, `RefusalAlternative`, `refusalHeadline`, `refusalMessageText`, `listRefusalAlternatives` | §9.1a |
| `services/aiModels/sessionModel.ts` | `resolveSessionTurn`, `chooseSessionModel`, `SessionModelChoice`, `InvalidSessionModelError` (moved from W00 `aiOfferableModels.ts`) | Session turn re-resolution + creation |
| `services/aiModels/registryCutover.ts`, `registryCutoverStore.ts` | `cutoverPartner`, `PartnerCutoverResult`, `ensurePartnerCutover`, `isPartnerCutOver`, `runRegistryCutoverSweep`, `__resetRegistryCutoverMemoForTests`; store: `withPartnerCutoverTx`, `hasCutoverRow`, `takeLease`, `renewLease`, `nextUncutPartners`, `markComplete`, `releaseLease` | Replaces W02 handoff item 1: once-only per-partner projection, resolver/write gate, leased resumable sweep |
| `services/aiModels/compatRemap.ts` | `remapPartnerOfferings`, `ensureSameModelOfferings`, `connectCompat`, `disconnectCompat`, `changeCompatDefaultModel` | W02 handoff item 2: `/ai/provider` writes the registry natively |
| `services/aiAgents/agentModelBinding.ts` | `bindAgentModel`, `AgentModelNotAllowedError` | W02 handoff item 5: agent policy model bound and permitted-checked at write |
| `services/aiModels/discovery.ts` | `MISSING_AFTER_SUCCESSFUL_SYNCS`, `RETIRED_AFTER_DAYS`, `ConnectionSyncReport`; `discoverAnthropicModels(apiKey, target)` gains `target` | §6 lifecycle constants; BYOK pinning |
| `jobs/aiModelDiscoveryWorker.ts` (W01) | `aiModelConnectionSyncJobId`, `enqueueConnectionSync`; `AiModelDiscoveryJobData` gains `sync-connection` (jobId `sync-connection-${id}`) and `sync-all-connections` | The index's `sync-connection:{id}` is not a legal BullMQ jobId |
| `services/aiModels/platformModels.ts` | `getPlatformInferenceGeo` (env `AI_PLATFORM_INFERENCE_GEO`) | §7 platform geo; W01's D3 left it open |
| `services/aiModels/legacySurfaceModels.ts` (W02) | `getLegacyModelRates`, `LEGACY_MODEL_RATES` (moved from `aiCostTracker.ts`) | Projection-only legacy rates once `MODEL_PRICING` leaves billing; W08 deletes |
| `services/aiAgents/modelBlocked.ts` | `ModelBlockedReason`, `AgentRunBlockedError`, `blockedOutcome`, `modelBlockedDedupeKey`, `notifyModelBlocked` | §9.1 / §9.1a agent outcomes |
| `services/aiBudgetReservations.ts` | `ReserveAiBudgetInput.binding`, `SettleAiBudgetReservationInput.invocations`, `SettleAiBudgetReservationResult.invocationIds`, `recordInvocationsWithRollups`, `persistPendingSettlement`, `replayPendingAiSettlements`, `markCreditsDebited`, `listUndebitedPlatformSettlements`, `stampSessionBinding`, `AiBudgetBindingConflictError` | Ledger-derived rollups, binding in the claim transaction, exactly-once debit and deferred-settlement replay |
| `services/aiModels/settleInvocation.ts` (cont.) | `debitSettledCredits`; `deductBillingCredits(orgId, cents, { idempotencyKey })` (`aiCostTracker.ts`) | Debit once per reservation, under a stable key |
| `services/streamingSessionManager.ts` | `ActiveSession.{liveKey, turnBinding, ledgerUserId, refusalObservation, forceRecreate}`; `getOrCreate(… resolved: ResolvedModel …, { ledgerUserId })` | §9.2 |
| `services/aiAgentSdk.ts` | `PreFlightResult.{model, openaiCompatible, code}` | Chat / script-builder turn resolution |
| DB | `ai_budget_reservations.model_binding`, `.pending_settlement` (jsonb), `.credits_debited_at`; `ai_agent_runs.funding_source`, `.admitted_offering_id` + status `blocked`; `partner_ai_models.last_seen_at`, `missed_sync_count`; `ai_model_registry_state` (system singleton); `ai_model_registry_partner_cutover` (partner-axis); `ai_sessions.model` loses its default; trigger `partner_llm_configs_mirror_to_connection` dropped | See the migrations |
| `packages/shared` | `PERMISSION_GRANTS.AI_MODELS_PREMIUM` (`ai_models:premium`); `PartnerSettings.ai.residencyRequired`; `AiStreamEvent` `model_refusal`; `AI_AGENT_RUN_STATUSES` + `'blocked'`; `createAiSessionSchema.{offeringId, options}` | Permission gate, residency, refusals, blocked runs, session create |
| tests | `services/aiModels/__fixtures__/resolvedModel.ts` (`makeResolvedModel`, `FIXTURE_STD_RATES`); `services/aiModels/parity/` `w03Goldens.json`, `w03Parity.ts` (`queryKey`, `loadW03Goldens`, `toSurfaceUse`, `assertSurfaceParity`), `registrySnapshotDeps.ts` (`storeFor`, `snapshotDeps`), `w03Surfaces.parity.test.ts`; `__tests__/integration/helpers/aiModelRegistrySeed.ts` (`seedRegistryPartner`) | Parity against frozen legacy routing through W02's harness; real-DB seeds |

---

## Self-review

**Spec coverage** (W03 scope, brief items 1–9):

| Requirement | Task |
|---|---|
| `resolveModel` with the §9 signature and full eligibility (enabled/available/owned, platform_offered per dispatch, connection active + priced, catalog live, tools, permission, min_plan, residency) | 2, 3 |
| Bounded fallback (exactly one candidate, same connection + funding, else recoverable) | 3 (table), 7 (chat 409), 12 (agent blocked) |
| Refusal fallback passthrough priced at the served rate | 3 (carried), 4 (wire), 5 (served model), 6 (priced per row) |
| `promptProfile` returned + hook | 2, 3, 7, 12 |
| Options / inference geo in the resolver (§7) | 3, clamped to W01 transport carriage |
| W02 handoff: once-only per-partner cutover (replacing the blocking boot reconcile), then registry authority; `/ai/provider` registry-native; mirror trigger dropped; `ai_sessions.model` default dropped; agent model bound at write | 6A, 6B, 9, 12 |
| Every surface on `resolveModel`, each with a parity check reusing W02's harness against frozen legacy goldens | 1 (goldens), 7 (chat/topology, helper, script builder, office chat), 10 (ticket draft, office ticket), 11 (reviewer), 12 (agents, incl. wire translation and the policy permitted check at run), 13 (catalog enrichment, extension/workspace), 14 (patch test via the factory) |
| Funding per offering through admission → reservation → credits → settlement → compute; delete `getLlmBillingSourceForOrg` | 6, 7, 10–14, 12 (compute + admission), 15 |
| One cost function; SDK cost is telemetry only; both the general and the Office paths; budgets/credits/ledgers/displayed cost read it; rollups derived from `ai_invocations`; positive-wrong and zero SDK cost tests | 5, 6 (unit + integration), 7 (Office hook + `done`), 17 (contract rule 4) |
| Turn-claim binding atomic in the reservation transaction; live query reused only on an unchanged key | 4, 6, 7 |
| Refusal handling: ledger, chat message with category + alternatives, agent `blocked: model_refused` | 5, 6, 8, 12 |
| BYOK discovery on `ai-model-discovery`, arriving disabled | 16 |
| Delete `MODEL_PRICING` / `OFFERABLE_AI_MODELS` / `DEFAULT_PRICING` / `isPricedModel` / the free-form session model; grep contract (literals, `new Anthropic(`) | 9, 17 |
| Session `requested` model validated through `resolveModel` (replaces W00) | 9 |

**Known limits, called out rather than hidden:**
- **SDK refusal fallback is equal-price only.** `fallbackModel` also fires on overload, and the SDK's per-turn usage does not say which model served. Review finding 3: Task 3 therefore sets an SDK fallback only when its rate equals the primary's. A differently priced fallback is dropped with a warning, so that partner's SDK surfaces get no refusal fallback, and the refusal is reported with alternatives (Task 8). Messages API surfaces keep any same-connection fallback, because they attribute each attempt.
- **Refused leg on SDK surfaces.** It is not metered separately. Messages API surfaces do meter it, from `usage.iterations` / attempts.
- **Deferred settlements are replayed, not lost** (findings 1–2). The priced rows persist on the reservation, and the sweep replays them idempotently. Credits are debited once, under `ai-settlement:<reservationId>`. **Cross-repo dependency:** the billing service must honour that idempotency key. Until it does, a debit retried after a lost HTTP response can double-charge, so that change ships first.
- **Legacy policy fields between W03 and W04.** `reviewer_model`, Office `allowedModels` and the budget allowlist were projected once. Their editors stay until W04, and edits made in between do not route (Global Constraints). Agent `model` is bound at write time (Task 12).
- **Env OpenAI-compatible chat path.** It keeps its own cost and settlement until W06, so it writes no `ai_invocations` rows.
- **Not yet carriable options.** Fast mode, `thinkingDisplay: updates` and inference geo stay off until W01's spike enables a transport for them (`transportCarries`). Until then, residency-required partners resolve nothing: fail closed, by design.

**Placeholders.** Every step that touches a W01/W02 name uses the index name, or one of the names W01/W02's plans define (P-rows), through a single adapter. In a few places a step refers to a local the plan cannot see: the reviewer's prompt variables, harness helper names, W02's `projectionEnvFor`, `db-utils` argument shapes. Each of those names the existing value to carry over; none leaves behaviour unspecified.

**Type consistency.** These names are spelled identically everywhere:
- `TurnBinding`, `turnBindingFrom`, `liveQueryKey`;
- `ResolvedModel.funding`, `.transport`, `.wireModel`, `.logicalModel`, `.offering.id`, `.connection.{id,kind,config}`, `.rateSnapshot`, `.refusalFallback.{offeringId,wireModel,wireParams,rateSnapshot}`;
- `settleInvocation({ binding, orgId, userId, sessionId, agentRunId, sourceRef, usage, outcome, reservationId, messageCount, toolExecutionCount, turnCount })`;
- `sdkTurnUsage({ binding, tokens, observation, result })`, `messagesUsage(binding, attempts)`;
- `createMessage(client, resolved, body)`, returning `{ message, attempts }`;
- `assertSurfaceParity({ select, bind, registrySide })`.

**Review Focus.** Each of the five lines names its pinning test and owning task above.
