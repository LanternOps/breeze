---
tracking_issue: LanternOps/breeze#7598
---

# AI Model Registry W08: legacy removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Closes #7606

**Goal:** remove every legacy AI-model configuration path that the registry (W01–W04) replaced, then drop the legacy storage. The legacy surface is:
- the `/ai/provider` API and its facade service (`services/partnerLlmConfig.ts`);
- the `partner_llm_configs` table, `partner_ai_connections.legacy_default_model` and `partner_ai_connections_compat_uq`;
- `ai_budgets.allowed_models`, `ai_script_policies.reviewer_model`, `client_ai_org_policies.allowed_models`, and the AI agent policy `model` string (`ai_agents.model`);
- the W02 projection (`legacyProjection.ts`, `legacyReconcile.ts`, `legacySurfaceModels.ts` incl. `getLegacyModelRates` / `LEGACY_MODEL_RATES`), the W02/W03 parity harness (`services/aiModels/parity/`), and the W03 cutover sweep;
- the W02 shadow-ledger bridge (`legacyCostEvents.ts` and the `invocationLedger.ts` shadow listener);
- the legacy half of `llmConfigResolver.ts` (`resolveLlmConfig`, `resolveLlmConfigForOrg`, `llmUnusableCodeForOrgInSystemContext`);
- the deprecated env vars `BREEZE_AI_SCRIPT_REVIEWER_MODEL` and `WORKSPACE_CONTENT_LLM_MODEL`.

**Architecture:** two PRs, shipped in two consecutive releases, so every destructive statement lands one release after the last code that reads it (the #6472 / #6863 rule: code first, drop later, N-1 rollback window).
- **W08a (code only, release R1).** It replaces the two legacy paths that still *do* something with registry-native equivalents: the per-partner cutover becomes a registry-native **bootstrap** (no legacy reads), and the Anthropic connection writes become **id-keyed** (no singular "compat connection", no `legacy_default_model`). Then it deletes everything above, retires the API endpoints and request fields with an actionable 4xx and a `breaking-changes.json` entry, and removes the legacy columns from the Drizzle schema so that no R1 code names them. No migration.
- **W08b (DDL, release R2 ≥ R1 + 1).** One idempotent migration archives every legacy value into a new partner-axis table `ai_model_registry_legacy_archive`, then drops the legacy table, columns, index and the cutover-sweep singleton. It never refuses to boot (#6472). Then it lets a partner hold more than one Anthropic-dialect connection (`compat_uq` gone).

**Tech Stack:** Hono, Drizzle ORM on PostgreSQL (RLS), zod in `packages/shared`, Astro + React islands, `react-i18next` (8 locales), Vitest (unit + real-Postgres integration), Playwright (`data-testid` only).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-30-ai-model-registry-design.md` (v3):
- §5.2 (connections generalize `partner_llm_configs`), §5.6 (`ai_budgets.allowed_models` "dropped in W08"; `ai_sessions.model` "stays as a provenance snapshot"; agent `model` → `offering_id`);
- §8 ("never billed at a guessed rate"; `MODEL_PRICING` / `DEFAULT_PRICING` gone), §9 ("`resolveLlmConfig` becomes the connection half"), §10 (backfill, compatibility until W04), §11 ("env vars remain only as bootstrap for the platform default on a fresh self-host"), §12 (permissions), §13 (W08 row, rigor low), §15 #3.

**Names** come from `docs/superpowers/plans/ai-mcp/2026-09-30-ai-model-registry-index.md` and every merged plan's "Index additions" table (W01–W07, W09, W10), which are binding. This plan's own names are in "Index additions" at the end.

**Out of scope:**
- **`ai_sessions.model`.** Spec §5.6 keeps it as the session's provenance snapshot. Six writers set it at insert, displays read it, and it is `NOT NULL`. W05's plan lists "dropping `ai_sessions.model`" as a W08 item (W05 L51); the spec wins (Decision D4, Open question 4).
- **`ai_invocations.ledger_mode` and `legacy_cost_cents`.** The ledger is append-only and audit-required; W02 shadow rows stay as history. W10 filters on `ledger_mode = 'authoritative'` and keeps the `recordInvocation` authoritative guard (W10 L234). W08 deletes only the code that *writes* shadow rows.
- **`aiModel.ts` W00 bootstrap rules** (`legacyWireProfile`, `legacyThinksWhenOmitted`, `BREEZE_FALLBACK_MODEL`). W03 resolves unknown Anthropic capability trees through them (W01 D4); deleting them changes wire parameters, not cleanup.
- **`findOfferingIdByModel`.** The extension AI API's explicit `model` input still maps through it (W03, `extensionAi.ts:138`). It is an input path, not legacy.
- **`MCP_LLM_*` env vars.** W06 keeps them as the env bootstrap for an `openai_compatible` connection (W06 D6).
- **`markPartnerLlmError`.** Already registry-native (it stamps `partner_ai_connections` by id + `config_version`); W08 only corrects its doc comment.

---

## Releases and gates

| Release | Contains | Gate before the merge | Gate after the deploy |
|---|---|---|---|
| **R0** (assumed `0.121.0`) | W03 + W04 (and W05 if ready) | — (W03/W04 gates) | the W03 cutover sweep completes on EU and US |
| **R1** (assumed `0.122.0`) | **W08a** (+ W05, W06 if not in R0) | **G1** (Task 1): the read-only preflight on EU and US, against R0, shows zero blocking rows | AI chat, a BYOK partner and the connection drawer work on both regions (Task 11 Step 7) |
| **R2** (assumed `0.123.0`) | **W08b** | **G2** (Task 12): the preflight on EU and US against R1; Todd approves the drop; a fresh DO backup / PITR point exists | **G3** (Task 15): archive counts equal the G2 counts; AI works on both regions |

The version numbers are assumptions made on 2026-10-02 (v0.120.0 is the newest tag). **Task 1 Step 1 re-derives them**; every literal version in this plan (the `breaking-changes.json` entries, the shared rejection message, the docs) uses the derived values. W08a and W08b must not ship in the same release.

---

## Preconditions

Real code wins over this table. Before Task 1 the executor checks each row against `origin/main` (W03, W04 merged), and against the W05 / W06 merge commits. If a row differs, adapt only the step named in the right-hand column and record the difference in the PR body.

| # | What W08 consumes | Source | Status 2026-10-02 | If it differs, adapt only |
|---|---|---|---|---|
| P1 | W03 as built (head `2910feaac0`, PR #7700): `registryCutover.ts` (`ensurePartnerCutover(partnerId): Promise<boolean>`, `cutoverPartner`, `isPartnerCutOver`, `runRegistryCutoverSweep*`, `reportableCutoverError`), `registryCutoverStore.ts` (`withPartnerCutoverTx`, `hasCutoverRow`, lease functions, `nextUncutPartners`, `disableUnproducedOfferings`), boot calls in `index.ts` ~L1878 and `worker.ts` ~L691 | W03 Task 6A | built, PR open (HOLD) | Task 2 |
| P2 | W03 `compatRemap.ts` (`connectCompat`, `disconnectCompat`, `changeCompatDefaultModel`, `rotateCompatKey`, `setCompatCatalogEntry`, `bumpCompatConfigVersion`, `switchCompatKind`, `lockCompatConnection`, `remapPartnerOfferings`, `ensureSameModelOfferings`, `disableUnreferencedOfferings`, `PLATFORM_PINNED_SURFACES`, `DEFAULT_FOLLOWING_SURFACES`, `RegistryNotCutOverError`, `CompatConnectionMissingError`) and the facade `partnerLlmConfig.ts` (`savePartnerLlmKey`, `getPartnerLlmStatus`, `updatePartnerLlmConfig`, `updatePartnerLlmEndpoint`, `deletePartnerLlmConfig`, `PartnerLlmError`) | W03 Task 6B | built | Tasks 3, 4 |
| P3 | W04 as built (head `e6e759d676`, PR #7701, stacked on W03): `routes/aiModels/connections.ts` (`ownConnectionId`, `POST /` `switch (body.kind)`, `/:id/key`, `/:id/endpoint`, `PATCH /:id`, `DELETE /:id`, `/:id/refresh`), `routes/aiModels/shared.ts` (`registryWrite`, `partnerWrite`, `requirePartnerWide`, `idParamSchema`), `registryWriteLock.ts` (`tryLockPartnerRegistryWrite`), `registryWriteErrors.ts` (`RegistryWriteError(message, code, status, details?)`) | W04 | built, PR open | Task 4 |
| P4 | **W05 merged and shipped in a release before R1** (R0 or an earlier R1 candidate). W05 adds `bindAgentOffering(owner, offeringId, writer)` in `services/aiAgents/agentOfferingBinding.ts` returning `{ model, offeringId, offeringPartnerId }`, keeps `bindAgentModel` as a model-string lookup in front of it, adds `offeringId` to `aiAgentPolicyFieldsSchema` / `updateAiAgentSchema` / `AiAgentDto`, the web `AgentModelSelect`, and removes `model` from `createAiSessionSchema` and `legacyModel` from `chooseSessionModel` (W05 plan L462, L615, L5069–5165). | W05 plan | plan only | Task 9 (agent model). If W05 ships in the same release as W08a, **move Task 9 to a W08c PR in the following release** and keep both `ai_agents.model` and `ai_budgets.allowed_models` out of W08b's drop (Task 9 also removes the budget column's only reader): a retired input needs one shipped release that translates it. If W05 has not removed `legacyModel` from `chooseSessionModel`, Task 6 removes it (grep `legacyModel` in `services/aiModels/sessionModel.ts`). |
| P5 | **W06 merged.** W06 Task 16 deletes `services/llm/openaiSessionManager.ts`, `openaiCompatibleProvider.ts`, `isOpenAICompatibleProvider`, `PreFlightResult.openaiCompatible`, the `legacyCostSource: 'openai_env'` exclusion, and the env branches in `aiAgent.ts` / `aiAgentSdk.ts` that call `resolveLlmConfigForOrg` (W06 plan L5714–5760). W06 does **not** delete `legacyCostEvents.ts` or `registerInvocationLedgerShadow` (its plan never names them), so after W06 the bridge has no emitter. W06 Task 13 adds `ownConnection(partnerId, id): Promise<PartnerAiConnection>` to `routes/aiModels/shared.ts`, `isGatewayConnectionKind(kind)`, and routes `DELETE /:id` by kind (`deleteGatewayConnection` for gateway kinds, `deletePartnerLlmConfig` otherwise). W06 Task 14 adds the "Add connection" kind chooser with "Anthropic API key … disabled with *Already connected* when a compat connection exists". W06 Task 15 adds `envOpenAiBootstrap.ts`, which calls `ensurePartnerCutover(partnerId)` for every partner before re-pointing `chat`. | W06 plan | plan only | Tasks 4, 5, 6, 14. If `legacyCostEvents.ts` is already gone at the W06 merge commit, skip Task 5's deletions and keep only its grep step. |
| P6 | W07 (if merged first) adds `bedrock` / `vertex` / `foundry` arms to `connectionCreateSchema`, `routes/aiModels/connections.ts` and the web kind chooser, leaves `compat_uq` untouched (W07 L416–449), and relies on the AAD tag `'partner_llm_configs.api_key_encrypted'` for `partner_ai_connections.api_key_encrypted` (W07 L50, L513). | W07 plan | plan only | Tasks 4, 14 add arms only to the Anthropic branch. **No task renames or reseals the AAD tag.** |
| P7 | W09 (if merged first) extends `assignmentWrites.ts`, `FeatureDefaultsCard`, `partnerAssignmentsPutSchema`; W09's integration test expects W02-era `fallback_offering_ids = NULL` rows (W09 L725). W08's bootstrap writes `fallback_offering_ids = NULL` too. | W09 plan | plan only | Task 2 |
| P8 | W10 (if merged first) adds `NewInvocation.charge` and the authoritative-only guard in `recordInvocation` (`invocationLedgerWrite.ts`), and filters billing queries on `ledger_mode = 'authoritative'` (W10 L57, L234, L1617–1646). | W10 plan | plan only | Task 5 keeps `ledgerMode` and the guard. |
| P9 | `ai_model_registry_partner_cutover` (partner axis, `PARTNER_TENANT_TABLES`) and `ai_model_registry_state` (system singleton, `INTENTIONAL_UNSCOPED`) from `2026-11-19-100400-ai-model-registry-cutover.sql` | W03 Task 6A | built | Tasks 2, 13 |
| P10 | `breaking-changes.json` + `RECORDED_ENTRY_IDS` ratchet in `upgrade/breakingChangesManifest.test.ts`; the `z.never({ error }).optional()` retired-field idiom in `packages/shared/src/validators/retiredLabourPricing.ts` | #6605, #6604 | merged | Tasks 3, 6–9 |

---

## Global Constraints

- **Rigor: medium overall (spec §13 says low; raised because Task 2 and Task 4 move routing and funding code, and Task 13 is destructive DDL), with high-rigor carve-outs for Tasks 2, 4 and 13.** Every task is TDD: write the assertion, watch it fail for the stated reason, then implement. A deletion task's "red" is the grep or contract test that names the deleted symbol.
- **Code first, drop later.** W08a has **no migration**. W08b's migration ships in a later release than W08a. No W08a code may name a table, column or index W08b drops; Task 11 greps for it.
- **No boot refusal (#6472).** W08b's migration never raises on tenant data. It archives first, drops second, and reports counts with `RAISE WARNING`. The only `RAISE EXCEPTION` is the final "prove it" block, which can fire only if a `DROP` silently failed.
- **Never move funding implicitly (spec §9.1, §10).** The new bootstrap keeps a partner on its own Anthropic-dialect connection if it has exactly one; it never moves a partner with a connection onto the platform key. Pinned by Task 2.
- **Never bill at a guessed rate on hosted (spec §8, §15 #3).** The only rate constant left (`ENV_DEFAULT_MODEL_BOOTSTRAP_RATES`, the documented self-host rate for an unlisted `ANTHROPIC_MODEL`) is applied only when `isHosted()` is false. Pinned by Task 2.
- **Retired API input is rejected, never ignored (#6472).** A retired request field is declared `z.never({ error: <actionable message> }).optional()` so the request fails with 400 naming the field and its replacement, before any part is applied. Every retirement gets a `breaking-changes.json` entry and an id in `RECORDED_ENTRY_IDS`.
- **Migration slot (W08b):** `apps/api/migrations/2026-11-28-100000-ai-model-registry-legacy-drop.sql`. At commit time run `bash scripts/check-migration-naming.sh --against-ref origin/main` and `git ls-tree --name-only origin/main apps/api/migrations/ | grep -E '/[0-9]{4}-' | sort | tail -1`; if anything sorts after `2026-11-28-100000`, rename to sort last (keep the `-ai-model-registry-legacy-drop` slug) and update every reference (Task 13 fixture, test, docs). It must sort after W10's `2026-11-26-100400-…` and W09's `2026-11-25-100000-…`. The migration writes rows (the archive), so system scope is elected first, both at file level and inside each `DO` block.
- **New `org_id` table (W08b):** `ai_model_registry_legacy_archive` is shape 3 (partner axis, like `legacy_labour_pricing_archive`) with `org_id` as metadata. Registrations in the same task: `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry` (`repoint`), `CORE_TENANT_EXPORT_POLICY`, and in `rls-coverage.integration.test.ts` both `ORG_AXIS_POLICY_EXCLUDED_TABLES` and `PARTNER_TENANT_TABLES`. The composite `(org_id, partner_id) → organizations(id, partner_id)` FK is `ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE` (cascade: rollback safety for R1, which does not list the table). Its policy has **no `TO` clause** (a role-scoped policy would refuse the non-BYPASSRLS migration owner under FORCE RLS).
- **Export policy follows the live schema, across both releases.** `buildTenantExportPlan` compares policy columns with live columns and throws on a mismatch. W08a therefore moves each soon-dropped column into a new `retiring` group (excluded, allowed to be absent), so R1 works before and after W08b's drop; W08b then deletes the `retiring` entries.
- **Gates (spec §12) are unchanged.** Connection writes keep `BILLING_MANAGE` + `requireMfa()` + `canManagePartnerWidePolicies`, through W04's `partnerWrite` / `requirePartnerWide` / `registryWrite`.
- **Public repo.** No IPs, hostnames, infrastructure detail, prod row counts or partner names in code, comments, commits, the PR body or this plan. Preflight output goes to Todd, not into the PR.
- **Tests.** Tests sit alongside source; real-Postgres suites go under `apps/api/src/__tests__/integration/`.
  - API unit: `cd apps/api && npx vitest run <path>`. Never `pnpm --filter … test -- --run`.
  - Web unit: `cd apps/web && npx vitest run <path>`.
  - Shared: `cd packages/shared && npx vitest run <path>`.
  - Integration: `pnpm test-stack up` once, then `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`; `pnpm test-stack down` when finished.
  - RLS coverage: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`.
  - Typecheck: `cd apps/api && npx tsc --noEmit -p tsconfig.json`, `cd apps/web && npx tsc --noEmit`, `cd packages/shared && npx tsc --noEmit`.
  - Vitest path filters are substrings: check the reported file count.
- **Commits.** One per task; conventional message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Call `start_wave` (feature-lifecycle) for #7606 before Task 1. W08a branch: `feature/7598-ai-model-registry/wave-7606`. W08b branch: `feature/7598-ai-model-registry/wave-7606-drop`, cut from `main` after W08a merged.

## Review Focus

Each item is pinned by the named test.

1. **A partner whose legacy config was never projected** (only possible on a deployment that upgraded from before R0 straight to R1+, or if G1 was skipped). The bootstrap must keep it on its own Anthropic connection when it has exactly one, never on the platform key, and must report it. Pinned by Task 2 `registryBootstrap.test.ts` "a partner with one copied Anthropic connection is bootstrapped onto it, never onto the platform" and Task 2 integration "bootstrap of a W02-copied BYOK connection routes chat through the connection".
2. **Disconnecting one of several Anthropic connections** (possible after W08b). Only the references on *that* connection move back to the platform; references on the other connection are untouched; nothing is deleted except the disconnected connection and its offerings. Pinned by Task 4 integration "disconnect moves only that connection's references" and Task 14 integration "two Anthropic connections; deleting one leaves the other's assignments".
3. **A stale client still sending a retired field** (`reviewerModel`, Office `allowedModels`, agent `model`, or calling `/ai/provider`). It must get a 4xx naming the field and its replacement, and nothing in the request is applied, never a 200 that silently drops the value. Pinned by Task 3 "every /ai/provider route is 404 and the manifest names its replacement", Task 7 / Task 8 / Task 9 "PUT with <field> → 400 naming <replacement>; no column written", and the manifest enforcement tests.
4. **The drop migration on a database where something was never cut over or was half-dropped by hand.** It must archive every legacy value that still exists, drop what exists, report counts, and never raise on data; a re-apply is a no-op. Pinned by Task 13 "archives every legacy value, then drops", "re-apply is a no-op", "a partial legacy column set is archived column by column, never refused", and "the archive insert sees rows under FORCE RLS only because it elects system scope".
5. **Topology AI readiness for an org whose `chat` default is on a connection.** The readiness gate must report unavailable when that connection is errored, its key is undecryptable, or its catalog revision no longer maps the offering's model, and ready otherwise, without opening a second pooled connection. Pinned by Task 6 `readiness.test.ts` table and the integration case "readiness reads on the caller's held system connection".

## Decisions taken in this plan

| # | Decision | Why | Reversible? |
|---|---|---|---|
| D1 | **Two PRs, two releases** (W08a code, W08b DDL). | #6472 decision: column drops ship one release after the code stops reading them (N-1 rollback window); #6863 precedent. | Yes until R2 ships. |
| D2 | **The cutover becomes a registry-native bootstrap behind the same gate** (`ensurePartnerCutover` keeps its name and contract; `ai_model_registry_partner_cutover` keeps its name and now means "this partner's registry rows exist"). | The W02 projection is also W03's **new-partner** bootstrap (every partner created after the sweep is cut over on demand through `reconcilePartnerFromLegacyInTx`). Deleting it without a replacement would leave new partners with no assignments (`no_eligible_model`). Renaming the gate would touch files owned by W04, W05, W06 (`envOpenAiBootstrap.ts`) and W09 for no behaviour change. | Yes. |
| D3 | **Bootstrap = every surface on the platform default model, on the partner's single Anthropic-dialect connection if it has exactly one, else on the platform; with several (unreachable through the app) no defaults at all (fail closed).** `chat` allows user choice; other surfaces do not (W02 projection values). `patch_test` stays on the platform. The default model is, on self-host, `ANTHROPIC_MODEL` when set; otherwise (and always on hosted) the `is_platform_default` row, else `BREEZE_FALLBACK_MODEL`. | Spec §11: env vars are only the bootstrap for the platform default. Preserves destination and funding for a skipped-upgrade deployment whose W02 migration copied a BYOK key (Review Focus 1). New partners lose the env-driven `script_reviewer` / `extension_content` defaults (Open question 2). | Yes. |
| D4 | **`ai_sessions.model` stays.** | Spec §5.6 ("stays as a provenance snapshot") outranks W05's non-goal line; it is `NOT NULL` with six writers and several displays. | — |
| D5 | **The shadow ledger's rows and columns stay; only its writer goes.** | `ai_invocations` is append-only and audit-required; W10 keeps the authoritative guard. | — |
| D6 | **Connection writes are id-keyed and keep W03/W04's connect/disconnect semantics:** connecting the partner's first Anthropic key moves every platform reference (except `patch_test`) onto it; disconnecting moves that connection's references back to the same models on the platform. **A BYOK ↔ catalog switch is now in place** (same id, same key, references untouched, offerings converted). The partner "pinned default model" is gone; endpoint validation uses the model of the partner's `chat` default. | A cleanup wave changes no UX. W03's disconnect-then-reconnect switch would strand a connection's features on platform funding whenever a second connection exists (R2, or a rollback from it). The pin only existed for `PATCH /ai/provider`'s default model, which W04's "Defaults by feature" replaced. Open question 5 records W06's different (refuse-in-use) delete semantics. | Yes. |
| D7 | **Probe failures keep their exact messages and statuses** through a renamed error class (`ConnectionCheckError`, mapped in `registryWrite` the way `PartnerLlmError` was), so the Connections drawer shows the same server text. | No web or i18n change for an internal rename. | Yes. |
| D8 | **`partner_llm_configs` ciphertext is not archived.** The archive keeps the non-secret columns only. | After W03 the legacy table is a frozen snapshot; a partner who disconnected in the registry still has its old key there. Destroying it is the point. Live keys are in `partner_ai_connections` (same id, same AAD tag). | No (by design). |
| D9 | **Env vars retired without a manifest entry.** `breaking-changes.json` surfaces must be `METHOD /path`; neither env var has an endpoint. Both have been runtime no-ops since R0. They are documented in `deploy/upgrades.mdx` for R1 instead. | Extending the manifest schema is out of scope. | Yes. |
| D10 | **The parity harness is deleted, not ported.** | It materializes registry state *through the projection*; with the projection gone it has no registry side. `resolveModel.test.ts`'s table and the per-surface tests remain the regression net. | — |
| D11 | **A `retiring` export-policy group** (excluded, may be absent) carries every soon-dropped column through R1. | `buildTenantExportPlan` throws on a policy column the live table lacks; without it an R2 → R1 rollback breaks organization export. Reusable for any later column drop. | Yes. |
| D12 | **The archive's org FK is `ON DELETE CASCADE`** as well as cascade-registered. | R1 does not list the archive (it does not exist in R1's CI); after a rollback an org erasure must not abort on it. | Yes. |

## File structure

### W08a (PR 1)

| Path | Action | Task |
|---|---|---|
| `apps/api/migrations/preflight/2026-11-28-100000-ai-model-registry-legacy-drop-preflight.sql` | create | 1 |
| `apps/api/src/__tests__/integration/aiModelRegistryLegacyPreflight.integration.test.ts` | create | 1 |
| `apps/api/src/services/aiModels/registryBootstrap.ts` (+ `.test.ts`) | create | 2 |
| `apps/api/src/services/aiModels/registryCutover.ts` (+ `.test.ts`) | modify (W03) | 2 |
| `apps/api/src/services/aiModels/registryCutoverStore.ts` | modify (W03) | 2 |
| `apps/api/src/services/aiModels/registryWriteLock.ts` (+ `.test.ts`) | modify (W04) | 2 |
| `apps/api/src/services/aiModels/registryCutoverBoot.contract.test.ts` | delete | 2 |
| `apps/api/src/services/sentryEventCodes.ts` | modify (`ai_registry_bootstrap_existing_connection`) | 2 |
| `apps/api/src/__tests__/integration/aiModelRegistryFixtures.ts` | modify (`seedPricedPlatformModel`; `seedAgent` loses `model`) | 2, 7, 9 |
| `apps/api/src/index.ts`, `apps/api/src/worker.ts`, `apps/api/src/worker.boot.test.ts` | modify | 2, 5 |
| `apps/api/src/__tests__/integration/aiModelRegistryCutover.integration.test.ts` | delete → `aiModelRegistryBootstrap.integration.test.ts` (create) | 2 |
| `apps/api/src/routes/aiProvider.ts`, `aiProvider.test.ts`, `aiProvider.registry.test.ts` | delete | 3 |
| `apps/api/src/services/mcpCoverage.ts` | modify (remove `aiProvider.ts`) | 3 |
| `apps/api/src/upgrade/breaking-changes.json`, `breakingChangesManifest.test.ts` | modify | 3, 7, 8, 9 |
| `apps/api/src/services/aiModels/compatRemap.ts` → `connectionRemap.ts` (+ test) | rename + rewrite | 4 |
| `apps/api/src/services/aiModels/connectionProbe.ts` (+ `.test.ts`) | create | 4 |
| `apps/api/src/services/aiModels/anthropicConnectionWrites.ts` (+ `.test.ts`) | create | 4 |
| `apps/api/src/services/partnerLlmConfig.ts` (+ `.test.ts`) | delete | 4 |
| `apps/api/src/routes/aiModels/connections.ts`, `shared.ts` (+ `partnerRoutes.test.ts`) | modify (W04/W06) | 4 |
| `apps/api/src/__tests__/integration/aiProviderAuthority.integration.test.ts` | delete → `aiModelConnectionLifecycle.integration.test.ts` (create) | 4 |
| `apps/api/src/__tests__/integration/llmCatalogSelection.integration.test.ts` | modify | 4 |
| `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` | modify | 4, 7 |
| `apps/api/src/services/aiModels/legacyCostEvents.ts` (+ test), `ledgerShadowBoot.contract.test.ts` | delete | 5 |
| `apps/api/src/services/aiModels/invocationLedger.ts` (+ test), `index.ts` | modify | 5, 7 |
| `apps/api/src/__tests__/integration/aiInvocationsAppendOnly.integration.test.ts` | modify | 5 |
| `apps/api/src/services/aiModels/readiness.ts` (+ `.test.ts`) | create | 6 |
| `apps/api/src/__tests__/integration/aiModelReadiness.integration.test.ts` | create | 6 |
| `apps/api/src/services/llm/llmConfigResolver.ts` (+ test), `llmAvailability.ts` (+ test) | modify | 6 |
| `apps/api/src/services/topology/aiToolGate.ts` (+ test) | modify | 6 |
| `apps/api/src/services/llm/__scripts__/tool-capture.ts`, `tool-eval.ts` | modify | 6 |
| `apps/api/src/services/aiModels/connections.ts` (+ test) | modify (W02/W06) | 6, 7 |
| `apps/api/src/services/aiModels/legacyProjection.ts`, `legacyReconcile.ts`, `legacySurfaceModels.ts` (+ tests), `parity/**` | delete | 7 |
| `apps/api/src/__tests__/integration/aiModelRegistryReconcile.integration.test.ts`, `partnerLlmConfigsPartnerRls.integration.test.ts` | delete | 7 |
| `apps/api/src/__tests__/integration/aiModelRegistryFixtures.ts`, `aiModelRegistryForgery.integration.test.ts`, `workspaceEnrichmentByok.integration.test.ts` | modify | 7 |
| `apps/api/src/db/schema/partnerLlmConfigs.ts` | delete | 7 |
| `apps/api/src/db/schema/index.ts`, `aiModelRegistry.ts` (+ `aiModelRegistry.contract.test.ts`) | modify | 7 |
| `apps/api/src/services/encryptedColumnRegistry.ts` (+ test) | modify | 7 |
| `apps/api/src/config/env.ts`, `env.reviewerDefault.test.ts`, `env.aiScriptReviewerModel.test.ts` | modify / delete | 7 |
| `apps/api/src/system/connections/registry.ts` (+ test), `internalEnvVars.ts` | modify | 7 |
| `apps/api/src/config/envReadComposeCoverage.baseline.ts` | modify | 7 |
| `docker-compose.yml`, `.env.example` | modify | 7, 10 |
| `apps/api/src/services/aiModels/aiModelRegistry.contract.test.ts` | modify (W03/W06/W07) | 7, 9 |
| `packages/shared/src/validators/retiredAiModelFields.ts` (+ `.test.ts`), `validators/index.ts` | create / modify | 8 |
| `apps/api/src/routes/ai/scriptPolicy.ts`, `routes/partnerAiScriptPolicy.ts`, `services/scriptProposals/policy.ts` (+ tests) | modify | 8 |
| `apps/api/src/services/mfaStepUpGrant.ts`, `routes/auth/schemas.ts` (+ tests) | modify | 8 |
| `apps/api/src/routes/clientAi/schemas.ts`, `services/clientAiPolicy.ts` (+ tests) | modify | 8 |
| `apps/api/src/services/tenantExportPolicy.ts` (+ test), `services/tenantExportPolicyRegistry.ts` | modify (`retiring` group) | 8, 9 |
| `apps/api/src/db/schema/aiScriptPolicies.ts`, `clientAi.ts` | modify | 8 |
| `packages/shared/src/types/scriptProposals.ts` | modify | 8 |
| `apps/web/src/components/settings/ScriptAuthoringPage.test.tsx`, `clientAi/PolicyEditor.test.tsx` | modify | 8 |
| `apps/api/src/services/aiAgents/agentModelBinding.ts` (+ test), `agentService.ts`, `agentOfferingBinding.ts` (W05), `effectivePolicy.ts`, `supervisedKeyGrant.ts`, `graduationService.ts`, `supervisedKeyDemote.ts`, `runService.ts` (+ tests) | modify | 9 |
| `apps/api/src/routes/aiAgents.ts` (+ test) | modify | 9 |
| `packages/shared/src/validators/aiAgents.ts`, `types/aiAgents.ts` (+ tests) | modify | 9 |
| `apps/api/src/db/schema/aiAgents.ts`, `ai.ts` | modify | 9 |
| `apps/web/src/components/settings/aiAgents/**/*.test.tsx` fixtures | modify | 9 |
| `apps/docs/src/content/docs/features/bring-your-own-llm-key.mdx`, `deploy/environment.mdx`, `deploy/upgrades.mdx`, `security/overview.mdx`, `README.md` | modify | 10 |

### W08b (PR 2)

| Path | Action | Task |
|---|---|---|
| `apps/api/migrations/2026-11-28-100000-ai-model-registry-legacy-drop.sql` | create | 13 |
| `apps/api/src/db/schema/aiModelRegistryLegacyArchive.ts`, `db/schema/index.ts` | create / modify | 13 |
| `apps/api/src/__tests__/integration/fixtures/aiModelRegistryLegacyConfig.ts` | create | 13 |
| `apps/api/src/__tests__/integration/aiModelRegistryLegacyDrop.integration.test.ts` | create | 13 |
| `apps/api/src/services/tenantCascade.ts`, `orgMergeRegistry.ts`, `tenantExportPolicyRegistry.ts` | modify | 13 |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | modify | 13 |
| `apps/api/src/__tests__/integration/aiModelRegistryForgery.integration.test.ts` | modify | 13 |
| `apps/api/src/db/schema/aiModelRegistry.ts` (+ `aiModelRegistry.contract.test.ts`) | modify (drop the `compat_uq` declaration) | 14 |
| `apps/api/src/routes/aiModels/connections.ts` (+ test) | modify | 14 |
| `apps/web/src/components/settings/aiModels/connectionForms/connectionKinds.ts`, `ConnectionsCard.tsx`, `ConnectionDrawer.tsx` (+ tests) | modify (W06 files) | 14 |
| `e2e-tests/tests/ai-providers-models.spec.ts`, `e2e-tests/pages/PartnerAiModelsPage.ts` | modify | 14 |
| `apps/docs/src/content/docs/deploy/upgrades.mdx`, `features/bring-your-own-llm-key.mdx` | modify | 15 |
| `docs/superpowers/plans/ai-mcp/2026-09-30-ai-model-registry-index.md` | modify (W08 row → shipped) | 15 |

### File ownership vs. other waves

| Wave | Files W08 also touches | Shared extension point | Collision rule |
|---|---|---|---|
| W03 (#7601) | `registryCutover.ts`, `registryCutoverStore.ts`, `compatRemap.ts`, `invocationLedger.ts`, `llmConfigResolver.ts`, `aiModelRegistry.contract.test.ts`, `index.ts` / `worker.ts` boot blocks | `ensurePartnerCutover` (contract unchanged), `settleInvocation` (untouched), `resolveModel` steps (untouched) | W08 starts after W03 merged. It edits W03 files only to delete legacy paths; `resolveModel`, `settleInvocation`, `candidateLoader`, `eligibility`, `transport`, `turnBinding`, `connectionFactory`, `refusals`, `invocationUsage` are not modified. |
| W04 (#7602) | `routes/aiModels/connections.ts`, `routes/aiModels/shared.ts`, `registryWriteLock.ts`, `services/aiModels/index.ts`, `ScriptAuthoringPage.test.tsx`, `PolicyEditor.test.tsx` | the Connections card `switch (kind)`, `connectionCreateSchema` union arms, `registryWrite` | W08 edits only the `anthropic_byok` arm, `/:id/key`, `/:id/endpoint` and the compat branch of `DELETE /:id`. `assignmentWrites.ts`, `offeringWrites.ts`, `FeatureDefaultsCard` are untouched. |
| W05 (#7603) | `agentModelBinding.ts`, `agentOfferingBinding.ts`, `agentService.ts`, `sessionModel.ts` (verify only), `validators/aiAgents.ts`, `types/aiAgents.ts`, `routes/aiAgents.ts` | `bindAgentOffering`'s return shape | W08 Task 9 removes `model` from `bindAgentOffering`'s return and deletes `bindAgentModel`; W05 must be merged first (P4). |
| W06 (#7604) | `routes/aiModels/connections.ts` (`switch` arms, `DELETE` by kind), `routes/aiModels/shared.ts` (`ownConnection`), `index.ts` (env bootstrap call next to the cutover sweep), `invocationLedger.ts`, `llmAvailability.ts`, `aiModelRegistry.contract.test.ts`, web `connectionForms/connectionKinds.ts`, `ConnectionsCard.tsx`, `ConnectionDrawer.tsx` | `connectionCreateSchema` arms, `ADDABLE_CONNECTION_KINDS`, `ensurePartnerCutover` (consumed by `envOpenAiBootstrap.ts`) | W08 starts after W06 merged (P5). W08 removes the cutover sweep block in `index.ts` without moving W06's env-bootstrap call. Task 14 only removes the "Already connected" disable from the Anthropic kind. |
| W07 (#7605) | `routes/aiModels/connections.ts` (cloud arms), `aiModelRegistry.ts` schema (kind CHECK), `aiModelRegistry.contract.test.ts`, web kind chooser | same as W06 | W08 never edits a cloud arm. Task 14 drops only the `compat_uq` declaration line in `aiModelRegistry.ts`. If W07 lands after W08b, its migration comment "W08 drops it" is already true and its integration case `'compat_uq predicate is unchanged'` must be deleted by W07 (record in W07's PR). |
| W09 (#7607) | none directly. W08's bootstrap writes assignment rows that W09's failover columns default on. | `assignmentWrites`, `FeatureDefaultsCard` (untouched) | No collision. W08's migration sorts after `2026-11-25-100000`. |
| W10 (#7608) | `invocationLedger.ts` (shadow removal), `tenantExportPolicyRegistry.ts`, `tenantCascade.ts`, `orgMergeRegistry.ts` (archive entries) | `recordInvocation`'s `ledgerMode === 'authoritative'` guard (kept) | Additive list entries; alphabetical order. W08's migration sorts after `2026-11-26-100400`. |
| W11 (#7609) | none | `resolveModel` prompt-profile hook (untouched) | — |

---

# Part A — W08a: legacy code removal (PR 1, release R1)

### Task 1: Versions, the read-only prod preflight, and gate G1

**Files:**
- Create: `apps/api/migrations/preflight/2026-11-28-100000-ai-model-registry-legacy-drop-preflight.sql`
- Create: `apps/api/src/__tests__/integration/aiModelRegistryLegacyPreflight.integration.test.ts`

**Interfaces:**
- Consumes: the live schema at R0 (`partner_llm_configs`, `partner_ai_connections`, `ai_model_registry_partner_cutover`, `ai_model_registry_state`, `ai_budgets`, `ai_script_policies`, `client_ai_org_policies`, `ai_agents`, `ai_sessions`, `partner_ai_models`, `ai_platform_models`, `ai_invocations`).
- Produces: one SQL file, never applied by `autoMigrate` (the runner reads only the top level of `migrations/` and keeps `^\d{4}-.*\.sql$`, so `migrations/preflight/` is skipped, like the two existing preflights there). Each query is preceded by a `-- @query <name>` line so the integration test can run it alone. Query names: `sanity`, `sweep_state`, `blocking_uncut_with_legacy`, `counts`, `unrepresented_models`.

- [ ] **Step 1: Derive R0 / R1 / R2 and confirm the preconditions**

Run:

```bash
git fetch origin --tags
git tag --sort=-v:refname | head -5
W03_MERGE=$(git log origin/main --format=%H --grep='(#7601)' | tail -1)
W05_MERGE=$(git log origin/main --format=%H --grep='(#7603)' | tail -1)
W06_MERGE=$(git log origin/main --format=%H --grep='(#7604)' | tail -1)
echo "R0 = $(git tag --contains "$W03_MERGE" | sort -V | head -1)"
echo "W05 first release = $(git tag --contains "$W05_MERGE" | sort -V | head -1)"
echo "W06 merged at $W06_MERGE"
```

Expected: R0 is a tag (W03+W04 shipped). W05 has a release tag that is ≤ the release W08a will ship in minus one (P4); otherwise move Task 9 to a W08c PR (P4). W06 is merged (P5). R1 = the next minor after the newest tag; R2 = the minor after R1. If R1 is not `0.122.0`, replace `0.122.0` / `0.122` / `0.123.0` / `0.121.0` everywhere this plan writes them (the manifest entries in Tasks 3, 8, 9; `AI_MODEL_FIELDS_RETIRED_IN` in Task 8; the docs in Tasks 10 and 15). Record the four values at the top of the W08a PR body.

Then check every row of the Preconditions table against `origin/main` and record differences in the PR body.

- [ ] **Step 2: Write the failing integration test**

```ts
// apps/api/src/__tests__/integration/aiModelRegistryLegacyPreflight.integration.test.ts
/**
 * AI model registry W08 (#7606): the read-only preflight that gates W08a (G1)
 * and W08b (G2). Each query is run alone, in system scope, against seeded
 * legacy data, so the operator's output can be trusted:
 *  - `blocking_uncut_with_legacy` lists exactly the partners that hold legacy
 *    AI model config and have no ai_model_registry_partner_cutover row;
 *  - a cut-over partner and a partner with no legacy config are not listed;
 *  - `sanity` proves the run is not RLS-blind;
 *  - `unrepresented_models` lists a legacy model id the partner has no
 *    offering for.
 * Deleted by W08b Task 13, together with the legacy objects it reads.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';

const PREFLIGHT = '2026-11-28-100000-ai-model-registry-legacy-drop-preflight.sql';

async function query(name: string): Promise<string> {
  const file = await readFile(new URL(`../../../migrations/preflight/${PREFLIGHT}`, import.meta.url), 'utf8');
  const marker = `-- @query ${name}\n`;
  const start = file.indexOf(marker);
  if (start < 0) throw new Error(`preflight query ${name} not found`);
  const body = file.slice(start + marker.length);
  return body.slice(0, body.indexOf(';\n'));
}

const run = async (name: string) => withSystemDbAccessContext(async () =>
  [...(await db.execute(sql.raw(await query(name))))] as Array<Record<string, unknown>>);

const ids = { uncut: randomUUID(), cut: randomUUID(), clean: randomUUID(), org: randomUUID() };

beforeEach(async () => {
  await withSystemDbAccessContext(async () => {
    for (const [key, id] of Object.entries({ uncut: ids.uncut, cut: ids.cut, clean: ids.clean })) {
      await db.execute(sql`INSERT INTO partners (id, name, slug, currency_code)
        VALUES (${id}, ${`W08 preflight ${key}`}, ${`w08-pf-${key}-${id}`}, 'USD')`);
    }
    await db.execute(sql`INSERT INTO organizations (id, partner_id, name, slug, currency_code)
      VALUES (${ids.org}, ${ids.cut}, 'W08 preflight org', ${`w08-pf-org-${ids.org}`}, 'USD')`);
    // Un-cut partner with a legacy BYOK row (any ciphertext: the preflight never decrypts).
    await db.execute(sql`INSERT INTO partner_llm_configs (partner_id, api_key_encrypted, key_last4, key_fingerprint, default_model)
      VALUES (${ids.uncut}, 'enc:v1:test', 'abcd', 'fp-test', 'claude-legacy-only-model')`);
    // Cut-over partner with an org reviewer model it has no offering for.
    await db.execute(sql`INSERT INTO ai_model_registry_partner_cutover (partner_id) VALUES (${ids.cut})`);
    await db.execute(sql`INSERT INTO ai_script_policies (org_id, reviewer_model) VALUES (${ids.org}, 'claude-reviewer-legacy')`);
  });
});

describe('AI model registry legacy preflight (W08 G1/G2)', () => {
  it('sanity proves the run is in system scope and sees partners', async () => {
    const [row] = await run('sanity');
    expect(row).toMatchObject({ effective_scope: 'system' });
    expect(Number(row!.partners)).toBeGreaterThanOrEqual(3);
  });

  it('blocking_uncut_with_legacy lists only the un-cut partner that holds legacy config', async () => {
    const rows = await run('blocking_uncut_with_legacy');
    const partnerIds = rows.map((r) => r.partner_id);
    expect(partnerIds).toContain(ids.uncut);
    expect(partnerIds).not.toContain(ids.cut);
    expect(partnerIds).not.toContain(ids.clean);
    expect(rows.find((r) => r.partner_id === ids.uncut)).toMatchObject({ legacy_sources: ['partner_llm_configs'] });
  });

  it('unrepresented_models names a legacy model id the partner has no offering for', async () => {
    const rows = await run('unrepresented_models');
    expect(rows).toContainEqual(expect.objectContaining({
      source: 'ai_script_policies.reviewer_model', model_id: 'claude-reviewer-legacy',
    }));
  });

  it('counts reports every legacy population by name', async () => {
    const items = (await run('counts')).map((r) => r.item);
    for (const item of [
      'partner_llm_configs rows',
      'partner_llm_configs rows with no same-id connection',
      'partner_ai_connections.legacy_default_model set',
      'partners with more than one anthropic_byok/catalog connection',
      'ai_budgets.allowed_models customized',
      'ai_script_policies.reviewer_model set',
      'client_ai_org_policies.allowed_models non-empty',
      'ai_agents.model set',
      'ai_agents.model set, live and unbound',
      'ai_invocations shadow rows',
      'partners without a cutover row',
    ]) expect(items).toContain(item);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm test-stack up && cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelRegistryLegacyPreflight.integration.test.ts`
Expected: FAIL — `ENOENT … 2026-11-28-100000-ai-model-registry-legacy-drop-preflight.sql`.

- [ ] **Step 4: Write the preflight**

```sql
-- READ-ONLY preflight for the AI model registry legacy removal (#7606):
--   gate G1 — before W08a (code removal) merges, run against release R0;
--   gate G2 — before W08b (2026-11-28-100000-ai-model-registry-legacy-drop.sql)
--             merges, run against release R1.
-- Run on EACH prod region. Send the output to Todd; never paste it into a PR
-- (it names partner ids).
--
-- PASS = query `blocking_uncut_with_legacy` returns ZERO rows on both regions.
-- A row there is a partner whose legacy AI model settings were never projected
-- into the registry; after W08a nothing projects them any more. Stop and
-- escalate: the fix is to let R0's cutover run for that partner (its first AI
-- request, or an R0 restart), not to edit rows by hand.
--
-- Everything else is informational, and is exactly what W08b archives into
-- ai_model_registry_legacy_archive before it drops the legacy storage.
--
-- This file lives under migrations/preflight/ and is NEVER applied by the
-- runner: autoMigrate reads the migrations root non-recursively and keeps only
-- /^\d{4}-.*\.sql$/, so this directory is skipped (same as optional/).
--
-- ============================ READ THIS FIRST ============================
-- THE SCOPE ELEVATION BELOW IS LOAD-BEARING. Every table read here is FORCE
-- ROW LEVEL SECURITY, which binds the table owner too; breeze_current_scope()
-- defaults to 'none', under which every tenant policy is false. Unelevated,
-- every query returns ZERO ROWS WHILE BLIND, which reads as "clean". Query
-- `sanity` makes blindness visible: if `partners` is 0 on a region that has
-- partners, fix the connection and do NOT report "clean".
--
-- BEGIN READ ONLY / ROLLBACK keeps the elevation transaction-local and makes
-- any write impossible. The migration "no BEGIN/COMMIT" rule does not apply:
-- autoMigrate never runs this file.
-- =========================================================================

BEGIN READ ONLY;

SELECT set_config('breeze.scope', 'system', true);

-- @query sanity
SELECT public.breeze_current_scope() AS effective_scope,
       (SELECT count(*) FROM public.partners) AS partners,
       (SELECT count(*) FROM public.partner_ai_connections) AS connections,
       (SELECT count(*) FROM public.ai_model_registry_partner_cutover) AS cutover_rows;

-- @query sweep_state
SELECT cutover_completed_at, lease_owner IS NOT NULL AS lease_held, lease_expires_at
  FROM public.ai_model_registry_state;

-- @query blocking_uncut_with_legacy
WITH legacy AS (
  SELECT c.partner_id, 'partner_llm_configs' AS source
    FROM public.partner_llm_configs c
  UNION ALL
  SELECT k.partner_id, 'partner_ai_connections'
    FROM public.partner_ai_connections k WHERE k.kind IN ('anthropic_byok', 'catalog')
  UNION ALL
  SELECT COALESCE(sp.partner_id, o.partner_id), 'ai_script_policies.reviewer_model'
    FROM public.ai_script_policies sp LEFT JOIN public.organizations o ON o.id = sp.org_id
   WHERE sp.reviewer_model IS NOT NULL
  UNION ALL
  SELECT o.partner_id, 'client_ai_org_policies.allowed_models'
    FROM public.client_ai_org_policies p JOIN public.organizations o ON o.id = p.org_id
   WHERE p.allowed_models IS NOT NULL AND p.allowed_models <> '[]'::jsonb
  UNION ALL
  -- The column default ('["claude-sonnet-4-5-20250929"]', 0001-baseline.sql)
  -- is not a customization: the W02 projection ignored it too.
  SELECT o.partner_id, 'ai_budgets.allowed_models'
    FROM public.ai_budgets b JOIN public.organizations o ON o.id = b.org_id
   WHERE b.allowed_models IS NOT NULL AND b.allowed_models <> '["claude-sonnet-4-5-20250929"]'::jsonb
  UNION ALL
  SELECT COALESCE(a.partner_id, o.partner_id), 'ai_agents.model'
    FROM public.ai_agents a LEFT JOIN public.organizations o ON o.id = a.org_id
   WHERE a.model IS NOT NULL
  UNION ALL
  SELECT o.partner_id, 'ai_sessions (active, unbound)'
    FROM public.ai_sessions s JOIN public.organizations o ON o.id = s.org_id
   WHERE s.status = 'active' AND s.offering_id IS NULL
)
SELECT l.partner_id, array_agg(DISTINCT l.source ORDER BY l.source) AS legacy_sources
  FROM legacy l
 WHERE l.partner_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.ai_model_registry_partner_cutover c WHERE c.partner_id = l.partner_id)
 GROUP BY l.partner_id
 ORDER BY l.partner_id;

-- @query counts
SELECT 'partner_llm_configs rows' AS item, count(*) AS n FROM public.partner_llm_configs
UNION ALL SELECT 'partner_llm_configs rows with no same-id connection', count(*)
  FROM public.partner_llm_configs c WHERE NOT EXISTS (SELECT 1 FROM public.partner_ai_connections k WHERE k.id = c.id)
UNION ALL SELECT 'partner_llm_configs.default_model set', count(*) FROM public.partner_llm_configs WHERE default_model IS NOT NULL
UNION ALL SELECT 'partner_ai_connections.legacy_default_model set', count(*) FROM public.partner_ai_connections WHERE legacy_default_model IS NOT NULL
UNION ALL SELECT 'partners with more than one anthropic_byok/catalog connection', count(*) FROM (
  SELECT partner_id FROM public.partner_ai_connections WHERE kind IN ('anthropic_byok', 'catalog')
   GROUP BY partner_id HAVING count(*) > 1) x
UNION ALL SELECT 'ai_budgets rows', count(*) FROM public.ai_budgets
UNION ALL SELECT 'ai_budgets.allowed_models customized', count(*) FROM public.ai_budgets
  WHERE allowed_models IS NOT NULL AND allowed_models <> '["claude-sonnet-4-5-20250929"]'::jsonb
UNION ALL SELECT 'ai_script_policies.reviewer_model set', count(*) FROM public.ai_script_policies WHERE reviewer_model IS NOT NULL
UNION ALL SELECT 'client_ai_org_policies.allowed_models non-empty', count(*) FROM public.client_ai_org_policies
  WHERE allowed_models IS NOT NULL AND allowed_models <> '[]'::jsonb
UNION ALL SELECT 'ai_agents.model set', count(*) FROM public.ai_agents WHERE model IS NOT NULL
UNION ALL SELECT 'ai_agents.model set, live and unbound', count(*) FROM public.ai_agents
  WHERE model IS NOT NULL AND offering_id IS NULL AND disabled_at IS NULL
UNION ALL SELECT 'ai_invocations shadow rows', count(*) FROM public.ai_invocations WHERE ledger_mode = 'shadow'
UNION ALL SELECT 'partners without a cutover row', count(*) FROM public.partners p
  WHERE NOT EXISTS (SELECT 1 FROM public.ai_model_registry_partner_cutover c WHERE c.partner_id = p.id);

-- @query unrepresented_models
WITH offered AS (
  SELECT m.partner_id, COALESCE(m.model_id, pm.model_id) AS model_id
    FROM public.partner_ai_models m LEFT JOIN public.ai_platform_models pm ON pm.id = m.platform_model_id
), legacy_models AS (
  SELECT c.partner_id, 'partner_llm_configs.default_model' AS source, c.default_model AS model_id
    FROM public.partner_llm_configs c WHERE c.default_model IS NOT NULL
  UNION ALL
  SELECT k.partner_id, 'partner_ai_connections.legacy_default_model', k.legacy_default_model
    FROM public.partner_ai_connections k WHERE k.legacy_default_model IS NOT NULL
  UNION ALL
  SELECT COALESCE(sp.partner_id, o.partner_id), 'ai_script_policies.reviewer_model', sp.reviewer_model
    FROM public.ai_script_policies sp LEFT JOIN public.organizations o ON o.id = sp.org_id
   WHERE sp.reviewer_model IS NOT NULL
  UNION ALL
  SELECT o.partner_id, 'client_ai_org_policies.allowed_models', jsonb_array_elements_text(p.allowed_models)
    FROM public.client_ai_org_policies p JOIN public.organizations o ON o.id = p.org_id
   WHERE jsonb_typeof(p.allowed_models) = 'array'
  UNION ALL
  SELECT o.partner_id, 'ai_budgets.allowed_models', jsonb_array_elements_text(b.allowed_models)
    FROM public.ai_budgets b JOIN public.organizations o ON o.id = b.org_id
   WHERE jsonb_typeof(b.allowed_models) = 'array'
     AND b.allowed_models <> '["claude-sonnet-4-5-20250929"]'::jsonb
  UNION ALL
  SELECT COALESCE(a.partner_id, o.partner_id), 'ai_agents.model', a.model
    FROM public.ai_agents a LEFT JOIN public.organizations o ON o.id = a.org_id
   WHERE a.model IS NOT NULL
)
SELECT l.source, l.model_id, count(*) AS references, count(DISTINCT l.partner_id) AS partners
  FROM legacy_models l
 WHERE NOT EXISTS (SELECT 1 FROM offered f WHERE f.partner_id = l.partner_id AND f.model_id = l.model_id)
 GROUP BY l.source, l.model_id
 ORDER BY l.source, count(*) DESC;

ROLLBACK;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelRegistryLegacyPreflight.integration.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/preflight/2026-11-28-100000-ai-model-registry-legacy-drop-preflight.sql \
  apps/api/src/__tests__/integration/aiModelRegistryLegacyPreflight.integration.test.ts
git commit -m "test(ai): read-only preflight for the AI model registry legacy removal (#7606)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: TODD GATE G1 — run the preflight on EU and US (R0 deployed)**

Todd runs the file with `psql` against each region's database, the same way the `2026-10-10-100300` custom-field preflight was run, e.g. `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/api/migrations/preflight/2026-11-28-100000-ai-model-registry-legacy-drop-preflight.sql`.

PASS when, on both regions:
- `sanity.effective_scope = 'system'` and `partners` is non-zero;
- `sweep_state.cutover_completed_at` is set (R0's sweep finished), or `blocking_uncut_with_legacy` is empty anyway;
- **`blocking_uncut_with_legacy` returns zero rows.**

The PR body records only "G1 passed on EU and US at <UTC time>" — never counts or ids. Do not merge W08a before G1 passes. The rest of W08a may be implemented in parallel.

---

### Task 2: Registry-native partner bootstrap behind `ensurePartnerCutover`; the boot sweep goes

**Files:**
- Create: `apps/api/src/services/aiModels/registryBootstrap.ts`, `registryBootstrap.test.ts`
- Modify: `apps/api/src/services/aiModels/registryCutover.ts`, `registryCutover.test.ts`
- Modify: `apps/api/src/services/aiModels/registryCutoverStore.ts`
- Modify: `apps/api/src/services/aiModels/registryWriteLock.ts`, `registryWriteLock.test.ts` (create if absent)
- Modify: `apps/api/src/services/aiModels/legacyReconcile.ts` (lock helpers delegate; the file itself goes in Task 7)
- Modify: `packages/shared/src/constants/aiConnectionKinds.ts` (+ test) — W06's file
- Modify: `apps/api/src/index.ts`, `apps/api/src/worker.ts`, `apps/api/src/worker.boot.test.ts`
- Modify: the schema file that declares `aiModelRegistryState` (`grep -rln "aiModelRegistryState = pgTable" apps/api/src/db/schema`) and its `db/schema/index.ts` export
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts`
- Delete: `apps/api/src/services/aiModels/registryCutoverBoot.contract.test.ts`, `apps/api/src/__tests__/integration/aiModelRegistryCutover.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/aiModelRegistryBootstrap.integration.test.ts`

**Interfaces:**
- Consumes: `withPartnerCutoverTx(partnerId, fn: (exists: boolean) => Promise<void>)`, `hasCutoverRow(partnerId)` (W03 store); `AI_SURFACES` (shared); `resolveDefaultModel(env)` (`services/aiModel.ts`); `isHosted()` (`config/env.ts`); W06 `aiConnectionKinds.ts`.
- Produces (binding for Tasks 4 and 6 and for W09–W11):
  - `packages/shared/src/constants/aiConnectionKinds.ts`: `ANTHROPIC_API_CONNECTION_KINDS = ['anthropic_byok', 'catalog'] as const`, `type AnthropicApiConnectionKind`, `isAnthropicApiConnectionKind(kind: string): kind is AnthropicApiConnectionKind`.
  - `registryBootstrap.ts`: `ENV_DEFAULT_MODEL_BOOTSTRAP_RATES: Readonly<ModelRates>`; `mayCreateEnvPlatformModel(modelId: string, opts: { hosted: boolean; env: NodeJS.ProcessEnv }): boolean`; `pickBootstrapDefaultModelId({ hosted, env, platformDefaultModelId }): string` (pure); `resolveBootstrapDefaultModelId(opts?: { hosted?; env? }): Promise<string>`; `ensurePlatformModelRow(modelId, opts?): Promise<{ id: string; created: boolean } | null>`; `planBootstrap(input: BootstrapPlanInput): BootstrapPlan`; `bootstrapPartnerRegistryInTx(partnerId, deps?): Promise<BootstrapReport>`; types `BootstrapPlanInput`, `BootstrapPlan`, `BootstrapReport`.
  - `registryCutover.ts`: `cutoverPartner(partnerId, deps?: { bootstrapInTx?: typeof bootstrapPartnerRegistryInTx }): Promise<'done' | 'already'>`; `ensurePartnerCutover` and `isPartnerCutOver` unchanged. **Removed:** `runRegistryCutoverSweep`, `runRegistryCutoverSweepWithRetry`, `REGISTRY_CUTOVER_RETRY_DELAYS_MS`, `RegistryCutoverSweepResult`.
  - `registryCutoverStore.ts`: keeps `withPartnerCutoverTx`, `hasCutoverRow`. **Removed:** `takeLease`, `renewLease`, `nextUncutPartners`, `markComplete`, `releaseLease`, `disableUnproducedOfferings`.
  - `registryWriteLock.ts`: `partnerRegistryLockKey(partnerId): string` (text unchanged: `ai_model_registry_reconcile:<id>`), `lockPartnerRegistry(partnerId): Promise<void>` (blocking, transaction-scoped, system context only), `tryLockPartnerRegistryWrite` unchanged.

- [ ] **Step 1: Write the failing unit tests**

```ts
// packages/shared/src/constants/aiConnectionKinds.test.ts — append
import { ANTHROPIC_API_CONNECTION_KINDS, isAnthropicApiConnectionKind } from './aiConnectionKinds';

describe('Anthropic API connection kinds (W08)', () => {
  it('are the two kinds that carry a stored Anthropic key: direct BYOK and a catalog gateway', () => {
    expect([...ANTHROPIC_API_CONNECTION_KINDS]).toEqual(['anthropic_byok', 'catalog']);
    expect(isAnthropicApiConnectionKind('catalog')).toBe(true);
    expect(isAnthropicApiConnectionKind('openai_compatible')).toBe(false);
    expect(isAnthropicApiConnectionKind('bedrock')).toBe(false);
  });
});
```

```ts
// apps/api/src/services/aiModels/registryBootstrap.test.ts
import { AI_SURFACES } from '@breeze/shared';
import { describe, expect, it } from 'vitest';
import { BREEZE_FALLBACK_MODEL } from '../aiModel';
import { ENV_DEFAULT_MODEL_BOOTSTRAP_RATES, mayCreateEnvPlatformModel, pickBootstrapDefaultModelId, planBootstrap } from './registryBootstrap';

describe('planBootstrap', () => {
  const platformRow = { id: 'pm-1', created: false };

  it('a partner with no connection: every surface on the platform offering; only chat allows user choice', () => {
    const plan = planBootstrap({ modelId: 'model-a', platformRow, connections: [] });
    expect(plan.destination).toBe('platform');
    expect(plan.connectionOffering).toBeNull();
    expect(plan.assignments.map((a) => a.surface)).toEqual([...AI_SURFACES]);
    expect(plan.assignments.every((a) => a.target === 'platform')).toBe(true);
    expect(plan.assignments.filter((a) => a.allowUserChoice).map((a) => a.surface)).toEqual(['chat']);
  });

  it('a partner with one copied Anthropic connection is bootstrapped onto it, never onto the platform', () => {
    const plan = planBootstrap({ modelId: 'model-a', platformRow, connections: [{ id: 'conn-1', kind: 'anthropic_byok' }] });
    expect(plan.destination).toBe('connection');
    expect(plan.connectionOffering).toEqual({ connectionId: 'conn-1', source: 'discovered', platformModelId: 'pm-1', enabled: true });
    for (const a of plan.assignments) {
      expect(a.target).toBe(a.surface === 'patch_test' ? 'platform' : 'connection');
    }
  });

  it('a catalog connection gets a catalog offering of the default model (resolved live from the revision)', () => {
    const plan = planBootstrap({ modelId: 'model-a', platformRow, connections: [{ id: 'conn-2', kind: 'catalog' }] });
    expect(plan.connectionOffering).toEqual({ connectionId: 'conn-2', source: 'catalog', platformModelId: null, enabled: true });
  });

  it('a BYOK connection whose model has no platform row gets a disabled, unpriced manual offering (never a guessed rate)', () => {
    const plan = planBootstrap({ modelId: 'vllm-x', platformRow: null, connections: [{ id: 'conn-3', kind: 'anthropic_byok' }] });
    expect(plan.connectionOffering).toEqual({ connectionId: 'conn-3', source: 'manual', platformModelId: null, enabled: false });
    expect(plan.assignments.find((a) => a.surface === 'patch_test')!.target).toBeNull();
  });

  it('more than one Anthropic connection fails closed: no default, neither a guessed connection nor platform funding', () => {
    const plan = planBootstrap({
      modelId: 'model-a', platformRow,
      connections: [{ id: 'c1', kind: 'anthropic_byok' }, { id: 'c2', kind: 'catalog' }],
    });
    expect(plan.destination).toBe('ambiguous');
    for (const a of plan.assignments) expect(a.target).toBe(a.surface === 'patch_test' ? 'platform' : null);
  });

  it('no platform row and no connection: assignments are created with no default (resolver says no_eligible_model)', () => {
    const plan = planBootstrap({ modelId: 'model-a', platformRow: null, connections: [] });
    expect(plan.assignments.every((a) => a.target === null)).toBe(true);
  });
});

describe('pickBootstrapDefaultModelId', () => {
  it('self-host: ANTHROPIC_MODEL wins (the backend may serve nothing else)', () => {
    expect(pickBootstrapDefaultModelId({ hosted: false, env: { ANTHROPIC_MODEL: 'vllm-x' }, platformDefaultModelId: 'model-a' })).toBe('vllm-x');
  });
  it('hosted: the operator default wins; the env never overrides it', () => {
    expect(pickBootstrapDefaultModelId({ hosted: true, env: { ANTHROPIC_MODEL: 'vllm-x' }, platformDefaultModelId: 'model-a' })).toBe('model-a');
  });
  it('no env and no default row: the code fallback', () => {
    expect(pickBootstrapDefaultModelId({ hosted: true, env: {}, platformDefaultModelId: null })).toBe(BREEZE_FALLBACK_MODEL);
  });
});

describe('mayCreateEnvPlatformModel', () => {
  it('only the self-hosted ANTHROPIC_MODEL id may create a global platform row', () => {
    expect(mayCreateEnvPlatformModel('vllm-x', { hosted: false, env: { ANTHROPIC_MODEL: 'vllm-x' } })).toBe(true);
    expect(mayCreateEnvPlatformModel('vllm-x', { hosted: true, env: { ANTHROPIC_MODEL: 'vllm-x' } })).toBe(false);
    expect(mayCreateEnvPlatformModel('vllm-x', { hosted: false, env: {} })).toBe(false);
    expect(mayCreateEnvPlatformModel('tenant-typed', { hosted: false, env: { ANTHROPIC_MODEL: 'vllm-x' } })).toBe(false);
  });

  it('the bootstrap rate is the documented Opus-tier over-estimate, never zero', () => {
    expect(ENV_DEFAULT_MODEL_BOOTSTRAP_RATES).toEqual({
      inputCentsPerM: 500, outputCentsPerM: 2500, cacheReadCentsPerM: 50, cacheWriteCentsPerM: 625,
    });
  });
});
```

```ts
// apps/api/src/services/aiModels/registryCutover.test.ts — REPLACE the file
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ rows: new Set<string>(), fail: false }));
vi.mock('./registryCutoverStore', () => ({
  hasCutoverRow: vi.fn(async (id: string) => store.rows.has(id)),
  withPartnerCutoverTx: vi.fn(async (id: string, fn: (exists: boolean) => Promise<void>) => {
    const exists = store.rows.has(id);
    await fn(exists);
    if (!exists) store.rows.add(id);
  }),
}));
vi.mock('../sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./registryBootstrap', () => ({ bootstrapPartnerRegistryInTx: vi.fn() }));

import { __resetRegistryCutoverMemoForTests, cutoverPartner, ensurePartnerCutover } from './registryCutover';
import * as registryCutoverModule from './registryCutover';
import { captureException, captureMessage } from '../sentry';

const report = (over: Record<string, unknown> = {}) => ({
  destination: 'platform', connectionId: null, defaultModelId: 'model-a', offeringId: 'off-1',
  platformOfferingId: 'off-1', assignmentsCreated: 10, createdPlatformRow: false, ...over,
});

beforeEach(() => {
  store.rows.clear();
  __resetRegistryCutoverMemoForTests();
  vi.clearAllMocks();
});

describe('registry gate (W08: bootstrap, no legacy projection)', () => {
  it('bootstraps a partner with no cutover row exactly once', async () => {
    const bootstrapInTx = vi.fn(async () => report());
    expect(await cutoverPartner('p1', { bootstrapInTx: bootstrapInTx as never })).toBe('done');
    expect(await cutoverPartner('p1', { bootstrapInTx: bootstrapInTx as never })).toBe('already');
    expect(bootstrapInTx).toHaveBeenCalledTimes(1);
  });

  it('reports a partner that was bootstrapped onto an existing connection (its legacy settings were never projected)', async () => {
    const bootstrapInTx = vi.fn(async () => report({ destination: 'connection', connectionId: 'c1' }));
    await cutoverPartner('p2', { bootstrapInTx: bootstrapInTx as never });
    expect(captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('bootstrapped onto its existing AI connection'),
      expect.objectContaining({ eventCode: 'ai_registry_bootstrap_existing_connection' }),
    );
  });

  it('ensurePartnerCutover resolves false (never throws) and reports when the bootstrap fails', async () => {
    const { bootstrapPartnerRegistryInTx } = await import('./registryBootstrap');
    vi.mocked(bootstrapPartnerRegistryInTx).mockRejectedValueOnce(new Error('boom'));
    expect(await ensurePartnerCutover('p3')).toBe(false);
    expect(captureException).toHaveBeenCalled();
    expect(store.rows.has('p3')).toBe(false);
  });

  it('the W03 boot sweep is gone', () => {
    expect('runRegistryCutoverSweep' in registryCutoverModule).toBe(false);
    expect('runRegistryCutoverSweepWithRetry' in registryCutoverModule).toBe(false);
  });
});
```

```ts
// apps/api/src/services/aiModels/registryWriteLock.test.ts — append (create the file if W04 did not)
import { describe, expect, it } from 'vitest';
import { partnerRegistryLockKey } from './registryWriteLock';

describe('per-partner registry lock key', () => {
  it('keeps the W03 key text so a mixed-version deploy still serialises', () => {
    expect(partnerRegistryLockKey('p1')).toBe('ai_model_registry_reconcile:p1');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run:
```bash
cd packages/shared && npx vitest run src/constants/aiConnectionKinds.test.ts; cd ../..
cd apps/api && npx vitest run src/services/aiModels/registryBootstrap.test.ts src/services/aiModels/registryCutover.test.ts src/services/aiModels/registryWriteLock.test.ts
```
Expected: FAIL — `ANTHROPIC_API_CONNECTION_KINDS` / `planBootstrap` / `partnerRegistryLockKey` not exported; `runRegistryCutoverSweep` still in the module.

- [ ] **Step 3: Implement**

`packages/shared/src/constants/aiConnectionKinds.ts` — append:

```ts
/**
 * Connection kinds reached with a stored Anthropic API key through the Messages
 * API dialect: a direct BYOK key, or the same key through a platform-catalog
 * gateway (AI model registry W08, #7606). These are the kinds the Anthropic
 * connection writes (services/aiModels/anthropicConnectionWrites.ts) own; cloud
 * kinds (W07) and gateway kinds (W06) have their own write services.
 */
export const ANTHROPIC_API_CONNECTION_KINDS = ['anthropic_byok', 'catalog'] as const;
export type AnthropicApiConnectionKind = (typeof ANTHROPIC_API_CONNECTION_KINDS)[number];
export function isAnthropicApiConnectionKind(kind: string): kind is AnthropicApiConnectionKind {
  return (ANTHROPIC_API_CONNECTION_KINDS as readonly string[]).includes(kind);
}
```

`apps/api/src/services/aiModels/registryWriteLock.ts` — replace the file:

```ts
/**
 * The per-partner AI model registry lock (W03 cutover, W04 writes, W08).
 *
 * One transaction-scoped advisory lock per partner serialises every registry
 * writer: the bootstrap (registryCutover.ts), the Anthropic connection writes
 * (anthropicConnectionWrites.ts) and W04's /ai/models writes. W03/W08 writers
 * BLOCK on it; W04 writes TRY it and answer 503 registry_busy, because a W04
 * write already holds the request connection and blocking there could park
 * pooled connections behind a holder that needs another one.
 *
 * The key text predates W08 (`ai_model_registry_reconcile:<partnerId>`) and is
 * kept so processes of two releases serialise on the same lock during a deploy.
 */
import { sql } from 'drizzle-orm';
import { db, getCurrentDbAccessContext } from '../../db';

export function partnerRegistryLockKey(partnerId: string): string {
  return `ai_model_registry_reconcile:${partnerId}`;
}

/** Blocking; releases at commit/rollback. The caller must hold a system DB context. */
export async function lockPartnerRegistry(partnerId: string): Promise<void> {
  if (getCurrentDbAccessContext()?.scope !== 'system') {
    throw new Error('lockPartnerRegistry requires a held system DB context');
  }
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${partnerRegistryLockKey(partnerId)}, 0))`);
}

/** Must run inside the write's system transaction; the lock releases at commit/rollback. */
export async function tryLockPartnerRegistryWrite(partnerId: string): Promise<boolean> {
  const [row] = await db.execute<{ acquired: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${partnerRegistryLockKey(partnerId)}, 0)) AS acquired`,
  );
  return row?.acquired === true;
}
```

`apps/api/src/services/aiModels/legacyReconcile.ts` — delete the two old function declarations; import the new ones for the file's own use and re-export them under the old names so its remaining importers (`partnerLlmConfig.ts`, until Task 4) keep compiling and every writer shares one implementation. A bare `export { … } from` creates no local binding, and `reconcilePartnerFromLegacyInTx` still calls the lock (~L385), so:

```ts
import { lockPartnerRegistry, partnerRegistryLockKey } from './registryWriteLock';
export { partnerRegistryLockKey as partnerRegistryReconcileLockKey, lockPartnerRegistry as lockPartnerRegistryReconcile };
```

and change the internal call to `await lockPartnerRegistry(partnerId);`. Remove imports only the deleted declarations needed.

`apps/api/src/services/sentryEventCodes.ts`: add `'ai_registry_bootstrap_existing_connection'` to `SENTRY_EVENT_CODES` (next to `'ai_partner_key_error_stamp_stale'`). `captureMessage` takes only a code from that closed union, so without this `tsc` fails.

`apps/api/src/__tests__/integration/aiModelRegistryFixtures.ts` — add a priced platform model fixture (W02's `seedPlatformModel(modelId?)` inserts an unpriced, un-offered row and returns only the id):

```ts
/** A priced, offered platform model (optionally the platform default). Clears any other default first (partial unique index). */
export async function seedPricedPlatformModel(input: { modelId?: string; isPlatformDefault?: boolean } = {}): Promise<{ id: string; modelId: string }> {
  const modelId = input.modelId ?? `w08-model-${randomUUID()}`;
  if (input.isPlatformDefault) await fixtureSql`UPDATE ai_platform_models SET is_platform_default = false WHERE is_platform_default`;
  const [row] = await fixtureSql`
    INSERT INTO ai_platform_models (provider, model_id, display_name, platform_offered, is_platform_default, lifecycle,
                                    input_cents_per_m, output_cents_per_m, cache_read_cents_per_m, cache_write_cents_per_m)
    VALUES ('anthropic', ${modelId}, ${modelId}, true, ${input.isPlatformDefault ?? false}, 'available', 300, 1500, 30, 375)
    RETURNING id`;
  return { id: String(row!.id), modelId };
}
```

(If `fixtureSql` runs without system scope and the insert is refused by RLS, wrap it the way the file's other writers do.)

`apps/api/src/services/aiModels/registryBootstrap.ts` — create:

```ts
/**
 * Registry-native partner bootstrap (AI model registry W08, #7606).
 *
 * Replaces the W02 legacy projection behind W03's per-partner gate
 * (registryCutover.ts → ensurePartnerCutover). A partner gets its registry rows
 * exactly once, in the same transaction that inserts its
 * ai_model_registry_partner_cutover row: one offering of the platform default
 * model and a partner-level `default` assignment for every surface. Nothing
 * here reads a legacy table or column.
 *
 * Destination (spec §9.1, §10 — funding never moves implicitly): a partner that
 * already owns exactly one anthropic_byok/catalog connection is bootstrapped
 * onto it. That happens only on a deployment whose W02 migration copied a
 * legacy key but which never ran W03's cutover (it upgraded straight past R0);
 * the caller reports it. More than one such connection fails closed (no
 * defaults). Everyone else starts on the platform. patch_test always stays on
 * the platform key (#5557).
 *
 * Default model (spec §11): on self-host ANTHROPIC_MODEL when set; otherwise
 * the operator's is_platform_default row, else the code fallback. A missing
 * platform row is created ONLY for the self-hosted ANTHROPIC_MODEL id, at the
 * documented conservative rate — never on hosted (spec §15 #3: no guessed rate).
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  AI_SURFACES,
  ANTHROPIC_API_CONNECTION_KINDS,
  type AiSurface,
  type AnthropicApiConnectionKind,
  type ModelRates,
} from '@breeze/shared';
import { db, getCurrentDbAccessContext } from '../../db';
import { aiModelAssignments, aiPlatformModels, partnerAiConnections, partnerAiModels } from '../../db/schema';
import { isHosted } from '../../config/env';
import { resolveDefaultModel } from '../aiModel';

/** Documented self-host rate for an ANTHROPIC_MODEL the registry does not list (deploy/environment.mdx): Opus-tier $5/$25 per MTok, an over-estimate, never $0. */
export const ENV_DEFAULT_MODEL_BOOTSTRAP_RATES: Readonly<ModelRates> = Object.freeze({
  inputCentsPerM: 500,
  outputCentsPerM: 2500,
  cacheReadCentsPerM: 50,
  cacheWriteCentsPerM: 625,
});

/** Surfaces whose techs may pick among permitted models from day one (W02 projection values). */
const USER_CHOICE_SURFACES: ReadonlySet<AiSurface> = new Set<AiSurface>(['chat']);
/** Never moved onto a partner connection (legacy: patch tests always use the platform key, #5557). */
const PLATFORM_PINNED: ReadonlySet<AiSurface> = new Set<AiSurface>(['patch_test']);

export interface BootstrapPlanInput {
  modelId: string;
  platformRow: { id: string; created: boolean } | null;
  connections: ReadonlyArray<{ id: string; kind: AnthropicApiConnectionKind }>;
}

export interface BootstrapPlan {
  /** 'ambiguous': more than one Anthropic connection and no registry row yet — fail closed, never pick one, never fall back to platform funding. */
  destination: 'platform' | 'connection' | 'ambiguous';
  connectionOffering: null | {
    connectionId: string;
    source: 'discovered' | 'manual' | 'catalog';
    platformModelId: string | null;
    enabled: boolean;
  };
  assignments: Array<{ surface: AiSurface; target: 'platform' | 'connection' | null; allowUserChoice: boolean }>;
}

export interface BootstrapReport {
  destination: 'platform' | 'connection' | 'ambiguous';
  connectionId: string | null;
  defaultModelId: string;
  /** The offering the non-pinned surfaces point at; null when nothing could be offered. */
  offeringId: string | null;
  platformOfferingId: string | null;
  assignmentsCreated: number;
  createdPlatformRow: boolean;
}

/** Pure: what the bootstrap writes for a partner. */
export function planBootstrap(input: BootstrapPlanInput): BootstrapPlan {
  if (input.connections.length > 1) {
    // Unreachable through the app (connections are created only after the gate),
    // but if it happens, choosing one connection or the platform would both move
    // funding implicitly. Every non-pinned surface gets no default instead.
    return {
      destination: 'ambiguous',
      connectionOffering: null,
      assignments: AI_SURFACES.map((surface) => ({
        surface,
        target: PLATFORM_PINNED.has(surface) && input.platformRow ? 'platform' as const : null,
        allowUserChoice: USER_CHOICE_SURFACES.has(surface),
      })),
    };
  }
  const connection = input.connections.length === 1 ? input.connections[0]! : null;
  const connectionOffering = connection === null ? null : connection.kind === 'catalog'
    ? { connectionId: connection.id, source: 'catalog' as const, platformModelId: null, enabled: true }
    : input.platformRow
      ? { connectionId: connection.id, source: 'discovered' as const, platformModelId: input.platformRow.id, enabled: true }
      // No platform row to inherit a price from, and no guessed rate: the admin prices and enables it.
      : { connectionId: connection.id, source: 'manual' as const, platformModelId: null, enabled: false };
  const platformTarget = input.platformRow ? 'platform' as const : null;
  return {
    destination: connection ? 'connection' : 'platform',
    connectionOffering,
    assignments: AI_SURFACES.map((surface) => ({
      surface,
      target: connection && !PLATFORM_PINNED.has(surface) ? 'connection' as const : platformTarget,
      allowUserChoice: USER_CHOICE_SURFACES.has(surface),
    })),
  };
}

/** Pure: may `modelId` create a GLOBAL ai_platform_models row? Only the self-hosted deployment's own ANTHROPIC_MODEL. */
export function mayCreateEnvPlatformModel(modelId: string, opts: { hosted: boolean; env: NodeJS.ProcessEnv }): boolean {
  const envModel = opts.env.ANTHROPIC_MODEL?.trim();
  return !opts.hosted && Boolean(envModel) && modelId === envModel;
}

function assertSystemContext(): void {
  if (getCurrentDbAccessContext()?.scope !== 'system') {
    throw new Error('registryBootstrap requires a held system DB context');
  }
}

/**
 * Pure. Self-host: ANTHROPIC_MODEL when set (the operator's backend may serve
 * nothing else, #1412). Hosted: never the env — the operator's /admin/ai-models
 * default is the authority (spec §11: env vars are only a fresh-self-host
 * bootstrap). Then the is_platform_default row, then the code fallback.
 */
export function pickBootstrapDefaultModelId(input: {
  hosted: boolean; env: NodeJS.ProcessEnv; platformDefaultModelId: string | null;
}): string {
  const override = input.env.ANTHROPIC_MODEL?.trim();
  if (!input.hosted && override) return override;
  return input.platformDefaultModelId ?? resolveDefaultModel(input.hosted ? {} : input.env);
}

/** Reads the is_platform_default row on the ambient connection. */
export async function resolveBootstrapDefaultModelId(
  opts: { hosted?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const [row] = await db.select({ modelId: aiPlatformModels.modelId }).from(aiPlatformModels)
    .where(eq(aiPlatformModels.isPlatformDefault, true)).limit(1);
  return pickBootstrapDefaultModelId({
    hosted: opts.hosted ?? isHosted(), env: opts.env ?? process.env, platformDefaultModelId: row?.modelId ?? null,
  });
}

/**
 * The platform row for `modelId`. Creates it (offered, at the bootstrap rate)
 * only when mayCreateEnvPlatformModel allows; an existing row is never touched
 * (ON CONFLICT DO NOTHING), so seeded and operator-edited rows win.
 */
export async function ensurePlatformModelRow(
  modelId: string,
  opts: { hosted?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<{ id: string; created: boolean } | null> {
  const find = async () => (await db.select({ id: aiPlatformModels.id }).from(aiPlatformModels)
    .where(eq(aiPlatformModels.modelId, modelId)).limit(1))[0];
  const existing = await find();
  if (existing) return { id: existing.id, created: false };
  if (!mayCreateEnvPlatformModel(modelId, { hosted: opts.hosted ?? isHosted(), env: opts.env ?? process.env })) return null;
  const r = ENV_DEFAULT_MODEL_BOOTSTRAP_RATES;
  await db.execute(sql`
    INSERT INTO ai_platform_models (provider, model_id, display_name, platform_offered, is_platform_default, lifecycle,
                                    input_cents_per_m, output_cents_per_m, cache_read_cents_per_m, cache_write_cents_per_m)
    VALUES ('anthropic', ${modelId}, ${modelId}, true, false, 'available',
            ${r.inputCentsPerM}, ${r.outputCentsPerM}, ${r.cacheReadCentsPerM}, ${r.cacheWriteCentsPerM})
    ON CONFLICT (model_id) DO NOTHING`);
  const created = await find();
  if (!created) throw new Error('registryBootstrap: could not create the env default platform model row');
  return { id: created.id, created: true };
}

/**
 * Writes the partner's registry rows. Runs inside withPartnerCutoverTx's system
 * transaction (it never opens, commits or rolls back one), so a throw leaves the
 * partner un-rowed and the next request retries. Existing rows are never
 * overwritten: offerings are enabled if present, assignments are insert-if-absent.
 */
export async function bootstrapPartnerRegistryInTx(
  partnerId: string,
  deps: { defaultModelId?: string; hosted?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<BootstrapReport> {
  assertSystemContext();
  const env = deps.env ?? process.env;
  const modelId = deps.defaultModelId ?? await resolveBootstrapDefaultModelId({ hosted: deps.hosted, env });
  const platformRow = await ensurePlatformModelRow(modelId, { hosted: deps.hosted, env });
  const connections = await db.select({ id: partnerAiConnections.id, kind: partnerAiConnections.kind })
    .from(partnerAiConnections)
    .where(and(
      eq(partnerAiConnections.partnerId, partnerId),
      inArray(partnerAiConnections.kind, [...ANTHROPIC_API_CONNECTION_KINDS]),
    ))
    .orderBy(asc(partnerAiConnections.createdAt)) as Array<{ id: string; kind: AnthropicApiConnectionKind }>;
  const plan = planBootstrap({ modelId, platformRow, connections });

  let platformOfferingId: string | null = null;
  if (platformRow) {
    const [row] = await db.insert(partnerAiModels)
      .values({ partnerId, platformModelId: platformRow.id, source: 'platform', enabled: true })
      .onConflictDoUpdate({
        target: [partnerAiModels.partnerId, partnerAiModels.platformModelId],
        targetWhere: sql`connection_id IS NULL`,
        set: { enabled: true, updatedAt: new Date() },
      })
      .returning({ id: partnerAiModels.id });
    platformOfferingId = row!.id;
  }

  let connectionOfferingId: string | null = null;
  if (plan.connectionOffering) {
    const o = plan.connectionOffering;
    const [row] = await db.insert(partnerAiModels)
      .values({
        partnerId, connectionId: o.connectionId, modelId, source: o.source,
        platformModelId: o.platformModelId, enabled: o.enabled,
      })
      .onConflictDoUpdate({
        target: [partnerAiModels.connectionId, partnerAiModels.modelId],
        targetWhere: sql`connection_id IS NOT NULL`,
        set: { enabled: o.enabled, updatedAt: new Date() },
      })
      .returning({ id: partnerAiModels.id });
    connectionOfferingId = row!.id;
  }

  let assignmentsCreated = 0;
  for (const a of plan.assignments) {
    const defaultOfferingId = a.target === 'connection' ? connectionOfferingId : a.target === 'platform' ? platformOfferingId : null;
    const inserted = await db.insert(aiModelAssignments)
      .values({
        partnerId, orgId: null, offeringPartnerId: partnerId, surface: a.surface, role: 'default',
        defaultOfferingId, permittedOfferingIds: null, allowUserChoice: a.allowUserChoice,
        options: null, fallbackOfferingIds: null, fallbackMayCrossFunding: false,
      })
      .onConflictDoNothing({
        target: [aiModelAssignments.partnerId, aiModelAssignments.surface, aiModelAssignments.role],
        where: sql`org_id IS NULL`,
      })
      .returning({ id: aiModelAssignments.id });
    assignmentsCreated += inserted.length;
  }

  return {
    destination: plan.destination,
    connectionId: plan.connectionOffering?.connectionId ?? null,
    defaultModelId: modelId,
    offeringId: plan.destination === 'connection' ? connectionOfferingId : plan.destination === 'platform' ? platformOfferingId : null,
    platformOfferingId,
    assignmentsCreated,
    createdPlatformRow: platformRow?.created ?? false,
  };
}
```

`apps/api/src/services/aiModels/registryCutover.ts` — replace the file:

```ts
/**
 * Per-partner AI model registry gate (W03 #7601 Task 6A; W08 #7606).
 *
 * W03 projected each partner from legacy config once. W08 deleted the
 * projection: a partner without its ai_model_registry_partner_cutover row now
 * gets a registry-native bootstrap (registryBootstrap.ts) in the same
 * transaction as the row, and the row means "this partner's registry rows
 * exist". Every entrypoint — the resolver, every registry write, agent model
 * binding, session creation, W06's env bootstrap — calls ensurePartnerCutover
 * first, so no boot sweep is needed and /health is never involved.
 */
import { captureException, captureMessage } from '../sentry';
import { bootstrapPartnerRegistryInTx, type BootstrapReport } from './registryBootstrap';
import { hasCutoverRow, withPartnerCutoverTx } from './registryCutoverStore';
import { carriesQueryValues, safeErrorMessage } from './safeDbError';

export type PartnerCutoverResult = 'done' | 'already';

/** A Drizzle/postgres error carries the statement's bound values: report only its safe fields. */
export function reportableCutoverError(error: unknown): unknown {
  return carriesQueryValues(error) ? new Error(`AI model registry bootstrap failed: ${safeErrorMessage(error)}`) : error;
}

function report(error: unknown, partnerId?: string): void {
  captureException(reportableCutoverError(error), undefined, {
    area: 'ai_model_registry_cutover',
    ...(partnerId ? { partnerId } : {}),
  });
}

function noteBootstrap(partnerId: string, r: BootstrapReport): void {
  if (r.destination === 'ambiguous') {
    captureException(new Error('AI registry: partner has several AI connections and no registry row; bootstrapped with no defaults (fail closed)'), undefined, {
      area: 'ai_model_registry_cutover', partnerId,
    });
    return;
  }
  if (r.destination === 'connection') {
    // Only a deployment that skipped the W03 cutover release gets here (its W02
    // migration copied a legacy key). Funding is kept; model choices made in the
    // legacy settings are not (W08b archives them).
    captureMessage('AI registry: partner bootstrapped onto its existing AI connection; legacy model settings were never migrated', {
      eventCode: 'ai_registry_bootstrap_existing_connection',
      tags: { partner_id: partnerId },
    });
  }
  if (r.offeringId === null) {
    console.warn(`[aiModels] partner ${partnerId} bootstrapped with no usable default model (${r.defaultModelId} has no platform row); an operator must price it on /admin/ai-models`);
  }
}

export async function cutoverPartner(
  partnerId: string,
  deps: { bootstrapInTx?: typeof bootstrapPartnerRegistryInTx } = {},
): Promise<PartnerCutoverResult> {
  // A holder object, not a `let`: TS does not track assignments made inside the callback.
  const outcome: { result: PartnerCutoverResult; report: BootstrapReport | null } = { result: 'already', report: null };
  await withPartnerCutoverTx(partnerId, async (exists) => {
    if (exists) return;
    outcome.report = await (deps.bootstrapInTx ?? bootstrapPartnerRegistryInTx)(partnerId);
    outcome.result = 'done';
  });
  // Reported after commit, so a rolled-back bootstrap never reports.
  if (outcome.report) noteBootstrap(partnerId, outcome.report);
  return outcome.result;
}

/** Partners known bootstrapped in this process. A row is never removed, so the memo cannot go stale. */
const cutOver = new Set<string>();

export function __resetRegistryCutoverMemoForTests(): void {
  cutOver.clear();
}

export async function isPartnerCutOver(partnerId: string): Promise<boolean> {
  if (cutOver.has(partnerId)) return true;
  if (await hasCutoverRow(partnerId)) {
    cutOver.add(partnerId);
    return true;
  }
  return false;
}

/** The registry gate. false = the partner could not be bootstrapped now; the caller refuses (recoverable). */
export async function ensurePartnerCutover(partnerId: string): Promise<boolean> {
  try {
    if (await isPartnerCutOver(partnerId)) return true;
    await cutoverPartner(partnerId);
    cutOver.add(partnerId);
    return true;
  } catch (error) {
    report(error, partnerId);
    return false;
  }
}
```

(`captureMessage` is exported by `services/sentry.ts`; `extensionAi.ts` already imports it. If the signature differs, adapt the call only.)

`apps/api/src/services/aiModels/registryCutoverStore.ts` — keep the header (reworded: "The SQL behind the per-partner registry gate"), `sys`, `withPartnerCutoverTx` and `hasCutoverRow`; change the lock import to `import { lockPartnerRegistry } from './registryWriteLock';` and call `await lockPartnerRegistry(partnerId);` inside `withPartnerCutoverTx`; delete `leaseSecs`, `takeLease`, `renewLease`, `nextUncutPartners`, `markComplete`, `releaseLease`, `disableUnproducedOfferings`, and the now-unused imports (`aiModelRegistryState`, `partnerAiModels`, `partners`, `asc`, `gt`, `inArray`, `not`, `notExists`).

Remove the Drizzle declaration of `aiModelRegistryState` (and its `db/schema/index.ts` export). The table stays in the database until W08b; no R1 code may name it.

`apps/api/src/index.ts`: delete the import of `reportableCutoverError, runRegistryCutoverSweepWithRetry` and the whole `void runRegistryCutoverSweepWithRetry() … .catch(…)` block with its comment (W03 ~L1872–1887). If W06's env bootstrap call sits after that block, leave it where it is. `apps/api/src/worker.ts`: delete `runRegistryCutoverSweepWithRetry, reportableCutoverError` from the lazy import and the `void runRegistryCutoverSweepWithRetry() …` block (~L686–700). `apps/api/src/worker.boot.test.ts`: delete the expectations that the sweep is started.

Delete `apps/api/src/services/aiModels/registryCutoverBoot.contract.test.ts` (it asserts the sweep is started at boot).

`apps/api/src/__tests__/partner-wide-write-coverage.test.ts`: replace the `services/aiModels/registryCutoverStore.ts` reason with `'per-partner registry gate (W03 Task 6A, W08 #7606): system-context write of the partner\'s own cutover row only, for the one partner id the resolver or a registry writer supplies — never request input'`, and add:

```ts
  'services/aiModels/registryBootstrap.ts': 'W08 (#7606) registry bootstrap: system-context writes pinned to the one partner id the per-partner gate (ensurePartnerCutover) supplies, never request input — creates that partner\'s own offering(s) and partner-level default assignments once, inside the cutover-row transaction; never overwrites an existing row',
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run:
```bash
cd packages/shared && npx vitest run src/constants/aiConnectionKinds.test.ts; cd ../..
cd apps/api && npx vitest run src/services/aiModels/registryBootstrap.test.ts src/services/aiModels/registryCutover.test.ts \
  src/services/aiModels/registryWriteLock.test.ts src/worker.boot.test.ts src/__tests__/partner-wide-write-coverage.test.ts
```
Expected: PASS.

- [ ] **Step 5: Write the real-Postgres bootstrap suite (replaces `aiModelRegistryCutover.integration.test.ts`)**

```ts
// apps/api/src/__tests__/integration/aiModelRegistryBootstrap.integration.test.ts
/**
 * AI model registry W08 (#7606): the registry-native bootstrap behind
 * ensurePartnerCutover, against real Postgres.
 *  - a new partner gets one platform offering and ten partner assignments,
 *    exactly once (cutover row in the same transaction);
 *  - a partner with one W02-copied BYOK connection routes every surface but
 *    patch_test through that connection (funding is kept);
 *  - rows that already exist are never overwritten;
 *  - on self-host an unlisted ANTHROPIC_MODEL gets a platform row at the
 *    bootstrap rate; on hosted nothing is created and nothing is defaulted;
 *  - two concurrent gates bootstrap once.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { aiModelAssignments, aiPlatformModels, partnerAiModels } from '../../db/schema';
import { createConnection } from '../../services/aiModels/connections';
import { __resetRegistryCutoverMemoForTests, ensurePartnerCutover } from '../../services/aiModels/registryCutover';
import { bootstrapPartnerRegistryInTx } from '../../services/aiModels/registryBootstrap';
import { withPartnerCutoverTx } from '../../services/aiModels/registryCutoverStore';
import { seedPricedPlatformModel } from './aiModelRegistryFixtures';

const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

async function newPartner(): Promise<string> {
  const id = randomUUID();
  await sys(() => db.execute(sql`INSERT INTO partners (id, name, slug, currency_code)
    VALUES (${id}, ${`W08 bootstrap ${id}`}, ${`w08-bs-${id}`}, 'USD')`));
  return id;
}

const partnerAssignments = (partnerId: string) => sys(() => db.select().from(aiModelAssignments)
  .where(and(eq(aiModelAssignments.partnerId, partnerId), isNull(aiModelAssignments.orgId))));

const savedEnv = { model: process.env.ANTHROPIC_MODEL, hosted: process.env.IS_HOSTED };

beforeEach(() => { __resetRegistryCutoverMemoForTests(); });
afterEach(() => {
  process.env.ANTHROPIC_MODEL = savedEnv.model;
  process.env.IS_HOSTED = savedEnv.hosted;
});

describe('registry bootstrap (W08)', () => {
  it('a new partner: one platform offering of the default model, ten partner assignments, once', async () => {
    delete process.env.ANTHROPIC_MODEL;
    const platform = await seedPricedPlatformModel({ modelId: `w08-default-${randomUUID()}`, isPlatformDefault: true });
    const partnerId = await newPartner();

    expect(await ensurePartnerCutover(partnerId)).toBe(true);
    expect(await ensurePartnerCutover(partnerId)).toBe(true);

    const offerings = await sys(() => db.select().from(partnerAiModels).where(eq(partnerAiModels.partnerId, partnerId)));
    expect(offerings).toHaveLength(1);
    expect(offerings[0]).toMatchObject({ connectionId: null, platformModelId: platform.id, source: 'platform', enabled: true });
    const rows = await partnerAssignments(partnerId);
    expect(rows).toHaveLength(10);
    expect(new Set(rows.map((r) => r.defaultOfferingId))).toEqual(new Set([offerings[0]!.id]));
    expect(rows.filter((r) => r.allowUserChoice).map((r) => r.surface)).toEqual(['chat']);
    expect(rows.every((r) => r.fallbackOfferingIds === null && r.fallbackMayCrossFunding === false)).toBe(true);
  });

  it('bootstrap of a W02-copied BYOK connection routes chat through the connection; patch_test stays on the platform', async () => {
    delete process.env.ANTHROPIC_MODEL;
    const platform = await seedPricedPlatformModel({ modelId: `w08-default-${randomUUID()}`, isPlatformDefault: true });
    const partnerId = await newPartner();
    const conn = await sys(() => createConnection({
      partnerId, kind: 'anthropic_byok', name: 'Anthropic API key', apiKey: 'sk-ant-test-0000000000', connectedBy: null, verifiedAt: null,
    }));

    expect(await ensurePartnerCutover(partnerId)).toBe(true);

    const rows = await partnerAssignments(partnerId);
    const byoK = await sys(() => db.select().from(partnerAiModels).where(eq(partnerAiModels.connectionId, conn.id)));
    expect(byoK).toHaveLength(1);
    expect(byoK[0]).toMatchObject({ source: 'discovered', platformModelId: platform.id, enabled: true });
    for (const r of rows) {
      if (r.surface === 'patch_test') expect(r.defaultOfferingId).not.toBe(byoK[0]!.id);
      else expect(r.defaultOfferingId).toBe(byoK[0]!.id);
    }
  });

  it('never overwrites an assignment that already exists', async () => {
    const platform = await seedPricedPlatformModel({ modelId: `w08-default-${randomUUID()}`, isPlatformDefault: true });
    const partnerId = await newPartner();
    await sys(() => db.insert(aiModelAssignments).values({
      partnerId, orgId: null, offeringPartnerId: partnerId, surface: 'chat', role: 'default',
      defaultOfferingId: null, permittedOfferingIds: null, allowUserChoice: false, options: null, fallbackOfferingIds: null, fallbackMayCrossFunding: false,
    }));
    await sys(() => withPartnerCutoverTx(partnerId, async (exists) => {
      if (!exists) await bootstrapPartnerRegistryInTx(partnerId, { defaultModelId: platform.modelId });
    }));
    const chat = (await partnerAssignments(partnerId)).find((r) => r.surface === 'chat')!;
    expect(chat).toMatchObject({ defaultOfferingId: null, allowUserChoice: false });
  });

  it('self-host: an unlisted ANTHROPIC_MODEL gets a platform row at the bootstrap rate; hosted creates nothing', async () => {
    const selfHosted = `w08-vllm-${randomUUID()}`;
    process.env.ANTHROPIC_MODEL = selfHosted;
    const p1 = await newPartner();
    await sys(() => withPartnerCutoverTx(p1, async () => { await bootstrapPartnerRegistryInTx(p1, { hosted: false }); }));
    const [row] = await sys(() => db.select().from(aiPlatformModels).where(eq(aiPlatformModels.modelId, selfHosted)));
    expect(row).toMatchObject({ platformOffered: true });
    expect(Number(row!.inputCentsPerM)).toBe(500);
    expect(Number(row!.outputCentsPerM)).toBe(2500);

    // Hosted: the env never overrides the operator default and never creates a row.
    const hostedDefault = await seedPricedPlatformModel({ isPlatformDefault: true });
    const hostedModel = `w08-hosted-${randomUUID()}`;
    process.env.ANTHROPIC_MODEL = hostedModel;
    const p2 = await newPartner();
    await sys(() => withPartnerCutoverTx(p2, async () => { await bootstrapPartnerRegistryInTx(p2, { hosted: true }); }));
    expect(await sys(() => db.select().from(aiPlatformModels).where(eq(aiPlatformModels.modelId, hostedModel)))).toHaveLength(0);
    const [hostedOffering] = await sys(() => db.select().from(partnerAiModels).where(eq(partnerAiModels.partnerId, p2)));
    expect(hostedOffering).toMatchObject({ platformModelId: hostedDefault.id });
  });

  it('two concurrent gates bootstrap once', async () => {
    await seedPricedPlatformModel({ modelId: `w08-default-${randomUUID()}`, isPlatformDefault: true });
    const partnerId = await newPartner();
    const [a, b] = await Promise.all([ensurePartnerCutover(partnerId), ensurePartnerCutover(partnerId)]);
    expect(a && b).toBe(true);
    expect(await partnerAssignments(partnerId)).toHaveLength(10);
  });
});
```

`seedPricedPlatformModel` is the fixture added in Step 3 (it clears any other platform default first).

Delete `apps/api/src/__tests__/integration/aiModelRegistryCutover.integration.test.ts` (it asserts the projection-based cutover and the sweep lease).

- [ ] **Step 6: Run the integration suite**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelRegistryBootstrap.integration.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Typecheck and commit**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json && cd ../../packages/shared && npx tsc --noEmit`
Expected: 0 errors.

```bash
git add -A apps/api/src/services/aiModels apps/api/src/index.ts apps/api/src/worker.ts apps/api/src/worker.boot.test.ts \
  apps/api/src/db/schema apps/api/src/__tests__ packages/shared/src/constants
git commit -m "feat(ai): registry-native partner bootstrap replaces the legacy projection; cutover sweep removed (#7606)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Retire the `/ai/provider` API

**Files:**
- Delete: `apps/api/src/routes/aiProvider.ts`, `aiProvider.test.ts`, `aiProvider.registry.test.ts`
- Modify: `apps/api/src/index.ts` (import + `api.route('/ai/provider', …)`)
- Modify: `apps/api/src/services/mcpCoverage.ts` (remove the `'aiProvider.ts'` exemption)
- Modify: `apps/api/src/services/partnerLlmConfig.ts` (+ `.test.ts`): delete `getPartnerLlmStatus`, `updatePartnerLlmConfig`, `PartnerLlmStatus`
- Modify: `apps/api/src/services/aiModels/compatRemap.ts` (+ `.test.ts`): delete `changeCompatDefaultModel` (its only caller was `updatePartnerLlmConfig`)
- Modify: `apps/api/src/__tests__/integration/aiProviderAuthority.integration.test.ts`: delete the default-model and status cases (the file goes in Task 4)
- Modify: `apps/api/src/upgrade/breaking-changes.json`, `breakingChangesManifest.test.ts`
- Modify: comments that name `routes/aiProvider.ts` as a gate reference: `routes/aiModels/shared.ts`, `routes/aiModels/connections.ts` (wording only)

**Interfaces:**
- Consumes: P10 manifest schema (`kind: 'api-endpoint'`, surfaces `METHOD /api/v1/path`, `fields: []` for a whole endpoint).
- Produces: manifest entry id `ai-provider-endpoints` (added to `RECORDED_ENTRY_IDS`).

- [ ] **Step 1: Prove there is no remaining caller**

Run:
```bash
grep -rn "ai/provider" apps/web/src apps/portal/src apps/helper/src packages e2e-tests apps/docs/src --include='*.ts' --include='*.tsx' --include='*.astro' --include='*.mdx' | grep -v "#ai-provider"
grep -rn "aiProviderRoutes\|routes/aiProvider" apps/api/src | grep -v "routes/aiProvider\(\.registry\)\?\(\.test\)\?\.ts:"
```
Expected: the first prints nothing (the partner tab hash `#ai-provider` is W04's retained tab key and is excluded). The second prints only `apps/api/src/index.ts` (import + mount) and comments in `routes/aiModels/*.ts`. Anything else is a caller to migrate first.

- [ ] **Step 2: Write the failing manifest test**

In `apps/api/src/upgrade/breakingChangesManifest.test.ts`, add `'ai-provider-endpoints'` to `RECORDED_ENTRY_IDS`, then append:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('ai-provider-endpoints (#7606)', () => {
  const entry = () => BREAKING_CHANGES_MANIFEST.entries.find((e) => e.id === 'ai-provider-endpoints')!;

  it('the route file and its mount are gone', () => {
    expect(existsSync(join(__dirname, '..', 'routes', 'aiProvider.ts'))).toBe(false);
    expect(readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')).not.toMatch(/['"]\/ai\/provider['"]/);
  });

  it('retires every /ai/provider endpoint and names its /ai/models replacement', () => {
    expect(entry().kind).toBe('api-endpoint');
    expect(entry().surfaces.map((s) => s.endpoint).sort()).toEqual([
      'DELETE /api/v1/ai/provider',
      'GET /api/v1/ai/provider',
      'PATCH /api/v1/ai/provider',
      'POST /api/v1/ai/provider/endpoint',
      'POST /api/v1/ai/provider/key',
    ]);
    expect(entry().replacement).toContain('/api/v1/ai/models/connections');
    expect(entry().replacement).toContain('PUT /api/v1/ai/models/assignments');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/upgrade/breakingChangesManifest.test.ts`
Expected: FAIL — the recorded id has no entry, and `routes/aiProvider.ts` exists.

- [ ] **Step 4: Implement**

Delete the three route files. In `apps/api/src/index.ts` delete `import { aiProviderRoutes } from './routes/aiProvider';` and `api.route('/ai/provider', aiProviderRoutes);`. In `services/mcpCoverage.ts` delete the `'aiProvider.ts'` entry.

In `services/partnerLlmConfig.ts` delete `PartnerLlmStatus`, `getPartnerLlmStatus`, `updatePartnerLlmConfig` and the imports only they used (`isOfferablePlatformModel`, `changeCompatDefaultModel`, `and`, `inArray`, `partnerAiConnections` if now unused). In `services/aiModels/compatRemap.ts` delete `changeCompatDefaultModel`. Delete their cases from `partnerLlmConfig.test.ts`, `compatRemap.test.ts` and `aiProviderAuthority.integration.test.ts`.

Append to `apps/api/src/upgrade/breaking-changes.json` `entries` (R0 / R1 from Task 1 Step 1; `earliestRemovalDate` is the R0 tag date, `git log -1 --format=%cs v<R0>`):

```json
    {
      "id": "ai-provider-endpoints",
      "title": "The /ai/provider API (one partner AI key and one default model) retired",
      "kind": "api-endpoint",
      "surfaces": [
        { "endpoint": "GET /api/v1/ai/provider", "fields": [] },
        { "endpoint": "PATCH /api/v1/ai/provider", "fields": [] },
        { "endpoint": "POST /api/v1/ai/provider/key", "fields": [] },
        { "endpoint": "POST /api/v1/ai/provider/endpoint", "fields": [] },
        { "endpoint": "DELETE /api/v1/ai/provider", "fields": [] }
      ],
      "replacement": "The AI model registry API. Read connections, models and per-feature defaults with GET /api/v1/ai/models. Connect an Anthropic key with POST /api/v1/ai/models/connections, rotate it with POST /api/v1/ai/models/connections/:id/key, choose or clear a catalog endpoint with POST /api/v1/ai/models/connections/:id/endpoint, and disconnect with DELETE /api/v1/ai/models/connections/:id. The single partner default model is replaced by per-feature defaults: PUT /api/v1/ai/models/assignments.",
      "deprecatedIn": "0.121.0",
      "deprecationBehaviour": "Kept working against the AI model registry as an API-only compatibility surface; the web app stopped calling it in the same release.",
      "earliestRemovalDate": "<the R0 tag date printed by: git log -1 --format=%cs v0.121.0>",
      "removedIn": "0.122.0",
      "removalBehaviour": "Every /api/v1/ai/provider request returns HTTP 404. Nothing is read or changed.",
      "references": ["#7598", "#7602", "#7606"]
    }
```

Replace the `earliestRemovalDate` value with the printed date (`YYYY-MM-DD`); the manifest schema rejects anything else, so the test fails loudly if it is left as text.

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
cd apps/api && npx vitest run src/upgrade/ src/services/mcpCoverage src/services/partnerLlmConfig.test.ts src/services/aiModels/compatRemap.test.ts
npx tsc --noEmit -p tsconfig.json
```
Expected: PASS; 0 type errors (the `mcpCoverage` suite asserts every route file has exactly one entry, so a stale `aiProvider.ts` entry fails it).

- [ ] **Step 6: Commit**

```bash
git add -A apps/api/src/routes apps/api/src/index.ts apps/api/src/services/mcpCoverage.ts apps/api/src/services/partnerLlmConfig.ts \
  apps/api/src/services/partnerLlmConfig.test.ts apps/api/src/services/aiModels/compatRemap.ts apps/api/src/services/aiModels/compatRemap.test.ts \
  apps/api/src/__tests__/integration/aiProviderAuthority.integration.test.ts apps/api/src/upgrade
git commit -m "feat(ai)!: retire the /ai/provider API; /ai/models is its replacement (#7606)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Id-keyed Anthropic connection writes replace the facade

**Files:**
- Rename + rewrite: `apps/api/src/services/aiModels/compatRemap.ts` → `connectionRemap.ts` (`git mv`); delete `compatRemap.test.ts`
- Create: `apps/api/src/services/aiModels/connectionProbe.ts`, `connectionProbe.test.ts`
- Create: `apps/api/src/services/aiModels/anthropicConnectionWrites.ts`, `anthropicConnectionWrites.test.ts`
- Delete: `apps/api/src/services/partnerLlmConfig.ts`, `partnerLlmConfig.test.ts`
- Modify: `apps/api/src/routes/aiModels/connections.ts`, `routes/aiModels/shared.ts`, `routes/aiModels/partnerRoutes.test.ts`, `orgAndUsageRoutes.test.ts` (mocks)
- Delete: `apps/api/src/__tests__/integration/aiProviderAuthority.integration.test.ts`, `aiModelRegistryReconcile.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/aiModelConnectionLifecycle.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/llmCatalogSelection.integration.test.ts`
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` (`services/aiModels/connections.ts` reason)
- Modify (comments only): `services/aiModels/offeringWrites.ts`, `registryWriteLock.ts`, `safeDbError.ts`, `apps/web/src/components/settings/aiModels/ConnectionDrawer.tsx`

**Interfaces:**
- Consumes: Task 2 `ANTHROPIC_API_CONNECTION_KINDS`, `isAnthropicApiConnectionKind`, `lockPartnerRegistry`, `resolveBootstrapDefaultModelId`, `ensurePlatformModelRow`; W02 `createConnection`, `encryptConnectionKey`, `decryptConnectionKey`, `getConnection`, `getConnectionKeyMaterial`, `ConnectionKeyError`; W04 `RegistryWriteError`, `toRegistryWriteError`, `updateConnectionSettings`, `registryWrite`; W06 `ownConnection`, `isGatewayConnectionKind`, `deleteGatewayConnection`; `createAnthropicClient` (W03 connection factory), `buildCatalogEndpointSnapshot`, `isLlmProviderCatalogEnabled`, `getListedProviderByEntryId`, `LlmEgressViolationError`.
- Produces:
  - `connectionProbe.ts`: `class ConnectionCheckError(message, status: 400 | 409 | 500 | 503)`; `probeAnthropicKey(apiKey: string, endpoint?: ResolvedLlmEndpoint): Promise<void>`; `resolveCatalogEndpointForSelection(catalogEntryId: string, model: string): Promise<ResolvedLlmEndpoint>`.
  - `connectionRemap.ts`: `PLATFORM_PINNED_SURFACES`; `RegistryNotCutOverError`; `AnthropicConnectionMissingError`; `assertPartnerCutOverInTx`; `remapPartnerOfferings`; `ensureSameModelOfferings`; `disableUnreferencedOfferings`; `type LockedAnthropicConnection = { id; kind: AnthropicApiConnectionKind; catalogEntryId; configVersion; connectedBy; verifiedAt }`; `lockAnthropicConnection(partnerId, connectionId)`; `lockAnthropicConnectionIds(partnerId): Promise<string[]>`; `connectAnthropicConnection(partnerId, { kind, apiKey, catalogEntryId, connectedBy, verifiedAt?, movePlatformReferences })`; `disconnectAnthropicConnection(partnerId, connectionId): Promise<boolean>`; `rotateAnthropicConnectionKey(partnerId, connectionId, { apiKey, connectedBy, verifiedAt })`; `setAnthropicConnectionCatalogEntry(partnerId, connectionId, { catalogEntryId })`; `bumpConnectionConfigVersion(partnerId, connectionId)`; `switchAnthropicConnectionKind(partnerId, connectionId, { kind, catalogEntryId }): Promise<{ connectionId /* unchanged */; configVersion }>` (in place); `partnerChatDefaultModelId(partnerId): Promise<string>`.
  - `anthropicConnectionWrites.ts`: `MAX_ANTHROPIC_API_CONNECTIONS_PER_PARTNER = 1` (removed in Task 14); `hasAnthropicConnection(partnerId): Promise<boolean>`; `createAnthropicKeyConnection({ partnerId, apiKey, userId }): Promise<{ connectionId; last4; configVersion }>`; `rotateAnthropicKey({ partnerId, connectionId, apiKey, userId }): Promise<{ last4; configVersion }>`; `changeAnthropicEndpoint({ partnerId, connectionId, catalogEntryId, acknowledgeDataNote, userId }): Promise<{ connectionId; catalogEntryId; configVersion; slug; revision }>`; `deleteAnthropicConnection({ partnerId, connectionId }): Promise<boolean>`.
- **Removed:** `partnerLlmConfig.ts` (`savePartnerLlmKey`, `updatePartnerLlmEndpoint`, `deletePartnerLlmConfig`, `PartnerLlmError`), `compatRemap.ts` compat exports (`lockCompatConnection`, `connectCompat`, `disconnectCompat`, `rotateCompatKey`, `setCompatCatalogEntry`, `bumpCompatConfigVersion`, `switchCompatKind`, `CompatConnectionMissingError`, `LockedCompatConnection`, `DEFAULT_FOLLOWING_SURFACES`), and W04's `ownConnectionId`.

Semantics kept from W03/W04 (Decision D6): connecting the partner's **first** Anthropic API connection moves every platform reference except `patch_test` onto the same models on it; disconnecting moves that connection's references back to the same models on the platform. Changed: a kind switch (BYOK ↔ catalog) now happens **in place** — same connection id, same key ciphertext, every reference untouched, the connection's offerings converted to the new kind's shape, `config_version + 1` — instead of W03's disconnect + reconnect under a new id (Codex review finding 3: the old order would strand a switched connection's features on platform funding whenever a second connection exists, e.g. after a rollback from R2); no `legacy_default_model` is read or written; endpoint validation and the catalog-rotation probe use the model of the partner-level `chat` default (`partnerChatDefaultModelId`); a model with no platform row falls back to the bootstrap default model, never to a legacy rate.

- [ ] **Step 1: Write the failing unit tests**

`apps/api/src/services/aiModels/connectionProbe.test.ts` — the probe cases move here from `partnerLlmConfig.test.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const create = vi.hoisted(() => vi.fn());
vi.mock('./connectionFactory', () => ({ createAnthropicClient: vi.fn(() => ({ messages: { create } })) }));
vi.mock('../../db', () => ({ runOutsideDbContext: (fn: () => unknown) => fn() }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
vi.mock('../aiModel', () => ({ resolveDefaultModel: () => 'model-default' }));
vi.mock('../llmProviderCatalog', () => ({ getListedProviderByEntryId: vi.fn() }));

import { LlmEgressViolationError } from '../llm/guardedLlmFetch';
import { ConnectionCheckError, probeAnthropicKey } from './connectionProbe';

const apiError = (status: number) => new Anthropic.APIError(status, {}, 'x', new Headers());

beforeEach(() => create.mockReset());

describe('probeAnthropicKey', () => {
  it.each([
    [401, 400, 'That Anthropic API key was rejected'],
    [403, 409, 'Anthropic denied access'],
    [404, 400, 'Anthropic rejected the verification request (HTTP 404)'],
    [429, 503, 'could not verify the API key right now'],
    [500, 503, 'could not verify the API key right now'],
  ])('maps an Anthropic %s to ConnectionCheckError %s', async (status, mapped, text) => {
    create.mockRejectedValueOnce(apiError(status));
    const err = await probeAnthropicKey('sk-ant-x').catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionCheckError);
    expect(err.status).toBe(mapped);
    expect(err.message).toContain(text);
  });

  it('a blocked egress is a transient 503, not a key rejection', async () => {
    create.mockRejectedValueOnce(new LlmEgressViolationError('blocked'));
    await expect(probeAnthropicKey('sk-ant-x')).rejects.toMatchObject({ status: 503 });
  });

  it('a programming error is rethrown unwrapped', async () => {
    create.mockRejectedValueOnce(new TypeError('bug'));
    await expect(probeAnthropicKey('sk-ant-x')).rejects.toBeInstanceOf(TypeError);
  });

  it('probes direct Anthropic with the deployment default model and max_tokens 1', async () => {
    create.mockResolvedValueOnce({});
    await probeAnthropicKey('sk-ant-x');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'model-default', max_tokens: 1 }));
  });
});
```

(`LlmEgressViolationError`'s constructor arguments: copy them from an existing `guardedLlmFetch` test if it takes more than a message.)

`apps/api/src/services/aiModels/anthropicConnectionWrites.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const remap = vi.hoisted(() => ({
  lockAnthropicConnection: vi.fn(),
  lockAnthropicConnectionIds: vi.fn(),
  connectAnthropicConnection: vi.fn(),
  disconnectAnthropicConnection: vi.fn(),
  rotateAnthropicConnectionKey: vi.fn(),
  setAnthropicConnectionCatalogEntry: vi.fn(),
  bumpConnectionConfigVersion: vi.fn(),
  switchAnthropicConnectionKind: vi.fn(),
  partnerChatDefaultModelId: vi.fn(),
}));
const order = vi.hoisted(() => [] as string[]);

vi.mock('./connectionRemap', async (orig) => ({
  ...(await orig<typeof import('./connectionRemap')>()),
  ...remap,
}));
vi.mock('./connectionProbe', async (orig) => ({
  ...(await orig<typeof import('./connectionProbe')>()),
  probeAnthropicKey: vi.fn(async () => { order.push('probe'); }),
  resolveCatalogEndpointForSelection: vi.fn(async () => ({ kind: 'catalog' })),
}));
vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => unknown) => { order.push('tx'); return fn(); },
}));
vi.mock('./registryWriteLock', () => ({ lockPartnerRegistry: vi.fn(async () => { order.push('lock'); }) }));
vi.mock('./registryCutover', () => ({ ensurePartnerCutover: vi.fn(async () => true) }));
vi.mock('./connections', async (orig) => ({
  ...(await orig<typeof import('./connections')>()),
  getConnection: vi.fn(),
  getConnectionKeyMaterial: vi.fn(async () => ({ id: 'c1', partnerId: 'p1', apiKeyEncrypted: 'enc' })),
  decryptConnectionKey: vi.fn(() => 'sk-ant-stored'),
}));
vi.mock('../llm/llmConfigResolver', () => ({
  isLlmProviderCatalogEnabled: vi.fn(() => true),
  buildCatalogEndpointSnapshot: vi.fn(() => ({ kind: 'catalog', baseUrl: 'https://gw.example', authMode: 'bearer' })),
}));
vi.mock('../llmProviderCatalog', () => ({ getListedProviderByEntryId: vi.fn(async () => ({ entryId: 'e1', slug: 'gw', revision: 3, dataNote: null })) }));
vi.mock('../../jobs/aiModelDiscoveryWorker', () => ({ enqueueConnectionSync: vi.fn(async () => undefined) }));

import { buildCatalogEndpointSnapshot } from '../llm/llmConfigResolver';
import { getConnection } from './connections';
import { probeAnthropicKey } from './connectionProbe';
import { AnthropicConnectionMissingError, RegistryNotCutOverError } from './connectionRemap';
import { changeAnthropicEndpoint, createAnthropicKeyConnection, deleteAnthropicConnection, rotateAnthropicKey } from './anthropicConnectionWrites';

const byok = { id: 'c1', partnerId: 'p1', kind: 'anthropic_byok', catalogEntryId: null, configVersion: 4 };

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  vi.mocked(getConnection).mockResolvedValue(byok as never);
  remap.lockAnthropicConnection.mockResolvedValue({ ...byok, connectedBy: null, verifiedAt: null });
  remap.lockAnthropicConnectionIds.mockResolvedValue([]);
  remap.connectAnthropicConnection.mockResolvedValue('c-new');
  remap.rotateAnthropicConnectionKey.mockResolvedValue({ configVersion: 5 });
  remap.partnerChatDefaultModelId.mockResolvedValue('model-chat');
});

describe('createAnthropicKeyConnection', () => {
  it('refuses an encrypted-value prefix before probing anything', async () => {
    await expect(createAnthropicKeyConnection({ partnerId: 'p1', apiKey: 'enc:v1:x', userId: 'u1' }))
      .rejects.toMatchObject({ status: 400 });
    expect(probeAnthropicKey).not.toHaveBeenCalled();
  });

  it('probes outside the transaction, then connects the first connection with platform references moved', async () => {
    const out = await createAnthropicKeyConnection({ partnerId: 'p1', apiKey: ' sk-ant-1234 ', userId: 'u1' });
    expect(order).toEqual(['probe', 'tx', 'lock']);
    expect(remap.connectAnthropicConnection).toHaveBeenCalledWith('p1', expect.objectContaining({
      kind: 'anthropic_byok', apiKey: 'sk-ant-1234', movePlatformReferences: true,
    }));
    expect(out).toEqual({ connectionId: 'c-new', last4: '1234', configVersion: 1 });
  });

  it('refuses a second Anthropic connection under the lock (R1 cap)', async () => {
    remap.lockAnthropicConnectionIds.mockResolvedValue(['c1']);
    await expect(createAnthropicKeyConnection({ partnerId: 'p1', apiKey: 'sk-ant-1234', userId: 'u1' }))
      .rejects.toMatchObject({ status: 409 });
    expect(remap.connectAnthropicConnection).not.toHaveBeenCalled();
  });

  it('maps a partner without registry rows to the recoverable 503', async () => {
    remap.connectAnthropicConnection.mockRejectedValueOnce(new RegistryNotCutOverError('p1'));
    await expect(createAnthropicKeyConnection({ partnerId: 'p1', apiKey: 'sk-ant-1234', userId: 'u1' }))
      .rejects.toMatchObject({ status: 503 });
  });
});

describe('rotateAnthropicKey', () => {
  it('rotates the named connection after re-checking it under the lock', async () => {
    const out = await rotateAnthropicKey({ partnerId: 'p1', connectionId: 'c1', apiKey: 'sk-ant-9999', userId: 'u1' });
    expect(remap.rotateAnthropicConnectionKey).toHaveBeenCalledWith('p1', 'c1', expect.objectContaining({ apiKey: 'sk-ant-9999' }));
    expect(out).toEqual({ last4: '9999', configVersion: 5 });
  });

  it('a connection of another partner is a 409 and writes nothing', async () => {
    vi.mocked(getConnection).mockResolvedValue({ ...byok, partnerId: 'p2' } as never);
    await expect(rotateAnthropicKey({ partnerId: 'p1', connectionId: 'c1', apiKey: 'sk-ant-9999', userId: 'u1' }))
      .rejects.toMatchObject({ status: 409 });
    expect(remap.rotateAnthropicConnectionKey).not.toHaveBeenCalled();
  });

  it('a kind switch between the probe and the write is "configuration changed"', async () => {
    remap.lockAnthropicConnection.mockResolvedValue({ ...byok, kind: 'catalog', catalogEntryId: 'e1' });
    await expect(rotateAnthropicKey({ partnerId: 'p1', connectionId: 'c1', apiKey: 'sk-ant-9999', userId: 'u1' }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('configuration changed') });
  });
});

describe('changeAnthropicEndpoint', () => {
  it('validates the endpoint against the partner chat default model, probes the stored key, switches in place', async () => {
    remap.switchAnthropicConnectionKind.mockResolvedValue({ connectionId: 'c1', configVersion: 5 });
    const out = await changeAnthropicEndpoint({ partnerId: 'p1', connectionId: 'c1', catalogEntryId: 'e1', acknowledgeDataNote: false, userId: 'u1' });
    expect(buildCatalogEndpointSnapshot).toHaveBeenCalledWith(expect.anything(), 'model-chat');
    expect(probeAnthropicKey).toHaveBeenCalledWith('sk-ant-stored', expect.objectContaining({ kind: 'catalog' }));
    expect(remap.switchAnthropicConnectionKind).toHaveBeenCalledWith('p1', 'c1', { kind: 'catalog', catalogEntryId: 'e1' });
    expect(out).toMatchObject({ connectionId: 'c1', catalogEntryId: 'e1', configVersion: 5 });
  });

  it('clearing the endpoint on a direct connection only bumps config_version', async () => {
    remap.bumpConnectionConfigVersion.mockResolvedValue({ configVersion: 5 });
    const out = await changeAnthropicEndpoint({ partnerId: 'p1', connectionId: 'c1', catalogEntryId: null, acknowledgeDataNote: false, userId: 'u1' });
    expect(out).toMatchObject({ connectionId: 'c1', catalogEntryId: null, configVersion: 5 });
    expect(remap.switchAnthropicConnectionKind).not.toHaveBeenCalled();
  });
});

describe('deleteAnthropicConnection', () => {
  it('disconnects the named connection; a vanished connection is "configuration changed"', async () => {
    remap.disconnectAnthropicConnection.mockResolvedValueOnce(true);
    expect(await deleteAnthropicConnection({ partnerId: 'p1', connectionId: 'c1' })).toBe(true);
    expect(remap.disconnectAnthropicConnection).toHaveBeenCalledWith('p1', 'c1');
    remap.disconnectAnthropicConnection.mockRejectedValueOnce(new AnthropicConnectionMissingError());
    await expect(deleteAnthropicConnection({ partnerId: 'p1', connectionId: 'c1' })).rejects.toMatchObject({ status: 409 });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/connectionProbe.test.ts src/services/aiModels/anthropicConnectionWrites.test.ts`
Expected: FAIL — `Cannot find module './connectionProbe'` / `'./anthropicConnectionWrites'`.

- [ ] **Step 3: Create `connectionProbe.ts`**

Move `mapProbeError`, `probeAnthropicKey`, `buildProbeEgressRecorder` and `resolveCatalogEndpointForSelection` out of `services/partnerLlmConfig.ts` **verbatim**, with exactly three edits: every `PartnerLlmError` becomes `ConnectionCheckError`; the Sentry tag `service: 'partnerLlmConfig'` becomes `service: 'aiModels.connectionProbe'`; the console prefix `[partnerLlmConfig]` becomes `[aiModels]`. Add at the top:

```ts
/**
 * Live verification of an Anthropic API key against the endpoint it will be
 * used with (moved from the retired /ai/provider facade, W08 #7606). Probes run
 * outside any transaction; callers hold no lock while they wait on the network.
 */
import Anthropic from '@anthropic-ai/sdk';
import { runOutsideDbContext } from '../../db';
import { resolveDefaultModel } from '../aiModel';
import { LlmEgressViolationError } from '../llm/guardedLlmFetch';
import { buildCatalogEndpointSnapshot, isLlmProviderCatalogEnabled, type ResolvedLlmEndpoint } from '../llm/llmConfigResolver';
import { getListedProviderByEntryId } from '../llmProviderCatalog';
import { captureException } from '../sentry';
import { createAnthropicClient } from './connectionFactory';

/**
 * A connection write the caller should see verbatim: its message and status
 * are the response (routes/aiModels/shared.ts registryWrite), exactly as the
 * retired facade error was, so the Connections drawer shows the same text.
 */
export class ConnectionCheckError extends Error {
  constructor(message: string, public readonly status: 400 | 409 | 500 | 503) {
    super(message);
    this.name = 'ConnectionCheckError';
  }
}
```

Export `probeAnthropicKey` and `resolveCatalogEndpointForSelection`; keep the other two module-private.

- [ ] **Step 4: Rewrite `compatRemap.ts` as `connectionRemap.ts`**

Run `git mv apps/api/src/services/aiModels/compatRemap.ts apps/api/src/services/aiModels/connectionRemap.ts && git rm apps/api/src/services/aiModels/compatRemap.test.ts`, then replace the file with:

```ts
/**
 * Registry-native Anthropic API connection remaps (W03 #7601 Task 6B as
 * compatRemap.ts; W08 #7606: id-keyed).
 *
 * Connecting, disconnecting and switching an anthropic_byok / catalog
 * connection are OFFERING-ID REMAPS over rows that already exist — never a
 * re-projection, which would reset options and fallbacks. Every export runs
 * inside the CALLER's held system transaction (anthropicConnectionWrites.ts,
 * which takes the per-partner registry lock first), refuses a partner without
 * its registry rows, and pins the partner id in every statement.
 *
 * Kept from W03:
 * - patch_test runs on the platform key whatever the partner connects (#5557);
 * - stale-offering rule: an offering a remap moves every reference away from is
 *   disabled (enabled = false, never deleted) once nothing references it.
 * Changed in W08:
 * - every operation names its connection (no singular "compat connection");
 * - no partner "pinned default model" (the per-connection legacy default): per-feature
 *   defaults (W04) replaced the /ai/provider default model it served;
 * - a model with no platform row falls back to the bootstrap default model,
 *   and a BYOK offering never gets a legacy rate (spec §8: no guessed price).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { AiSurface, AnthropicApiConnectionKind } from '@breeze/shared';
import { db, getCurrentDbAccessContext } from '../../db';
import { hmacFingerprint } from '../secretCrypto';
import { createConnection, encryptConnectionKey } from './connections';
import { ensurePlatformModelRow, resolveBootstrapDefaultModelId } from './registryBootstrap';
import { RegistryWriteError } from './registryWriteErrors';

/** Never moved onto a partner connection (legacy: patch tests always use the platform key, #5557). */
export const PLATFORM_PINNED_SURFACES = ['patch_test'] as const satisfies readonly AiSurface[];

export class RegistryNotCutOverError extends Error {
  constructor(readonly partnerId: string) {
    super('The AI model registry has not been set up for this partner yet.');
    this.name = 'RegistryNotCutOverError';
  }
}

export class AnthropicConnectionMissingError extends Error {
  constructor() {
    super('The AI connection no longer exists.');
    this.name = 'AnthropicConnectionMissingError';
  }
}

export interface LockedAnthropicConnection {
  id: string;
  kind: AnthropicApiConnectionKind;
  catalogEntryId: string | null;
  configVersion: number;
  connectedBy: string | null;
  verifiedAt: Date | null;
}

type Target = { connectionId: null } | { connectionId: string; kind: AnthropicApiConnectionKind };

function assertSystemContext(): void {
  if (getCurrentDbAccessContext()?.scope !== 'system') {
    throw new Error('connectionRemap requires a held system DB context');
  }
}

async function rows<T>(query: SQL): Promise<T[]> {
  return [...(await db.execute(query))] as T[];
}

const list = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

/** The gate, on the caller's transaction: a native write needs the partner's registry (cutover) row. */
export async function assertPartnerCutOverInTx(partnerId: string): Promise<void> {
  const found = await rows(sql`SELECT 1 AS ok FROM ai_model_registry_partner_cutover WHERE partner_id = ${partnerId}::uuid`);
  if (found.length === 0) throw new RegistryNotCutOverError(partnerId);
}
```

Then copy **unchanged** from the old file: `refsCte`, `remapPartnerOfferings`, `ensureSameModelOfferings`, `disableUnreferencedOfferings`, `connectionName`. Change `loadTarget`'s row type to `{ kind: AnthropicApiConnectionKind }`. Delete `findOffering`, `repointPartnerDefault`, `DEFAULT_FOLLOWING_SURFACES`, `CompatConnectionMissingError`, `LockedCompatConnection`, `lockCompatConnection`, `ConnectCompatInput`, `connectCompat`, `disconnectCompat`, `rotateCompatKey`, `setCompatCatalogEntry`, `bumpCompatConfigVersion`, `switchCompatKind`, and the imports of `getLegacyModelRates`, `resolveDefaultModel`, `ensureLegacyPlatformModel`. Replace `ensureOffering` and add the id-keyed operations:

```ts
/** The platform row for `modelId`; a model with none falls back to the bootstrap default (a tenant id never creates a global row). */
async function platformRowFor(modelId: string): Promise<string> {
  const [row] = await rows<{ id: string }>(sql`SELECT id FROM ai_platform_models WHERE model_id = ${modelId}`);
  if (row) return row.id;
  const fallback = await ensurePlatformModelRow(await resolveBootstrapDefaultModelId());
  if (!fallback) {
    throw new RegistryWriteError(
      'No platform AI model is available to move these features to. Ask an operator to price the platform default model on Admin → AI models, then try again.',
      'conflict', 409,
    );
  }
  return fallback.id;
}

/** Find-or-create the offering for `modelId` on `target`. A BYOK model with no platform row is created disabled: it has no resolvable price (spec §8). */
async function ensureOffering(partnerId: string, target: Target, modelId: string): Promise<string> {
  if (target.connectionId === null) {
    const platformModelId = await platformRowFor(modelId);
    const [row] = await rows<{ id: string }>(sql`INSERT INTO partner_ai_models (partner_id, platform_model_id, source, enabled)
      VALUES (${partnerId}::uuid, ${platformModelId}::uuid, 'platform', true)
      ON CONFLICT (partner_id, platform_model_id) WHERE connection_id IS NULL DO UPDATE SET enabled = true, updated_at = now()
      RETURNING id`);
    return row!.id;
  }
  let source: 'discovered' | 'manual' | 'catalog' = 'catalog';
  let platformModelId: string | null = null;
  let enabled = true;
  if (target.kind === 'anthropic_byok') {
    const [platform] = await rows<{ id: string }>(sql`SELECT id FROM ai_platform_models WHERE model_id = ${modelId}`);
    source = platform ? 'discovered' : 'manual';
    platformModelId = platform?.id ?? null;
    enabled = Boolean(platform);
  }
  const [row] = await rows<{ id: string }>(sql`INSERT INTO partner_ai_models
      (partner_id, connection_id, model_id, source, platform_model_id, enabled)
    VALUES (${partnerId}::uuid, ${target.connectionId}::uuid, ${modelId}, ${source}, ${platformModelId}::uuid, ${enabled})
    ON CONFLICT (connection_id, model_id) WHERE connection_id IS NOT NULL
      DO UPDATE SET enabled = partner_ai_models.enabled OR EXCLUDED.enabled, updated_at = now()
    RETURNING id`);
  return row!.id;
}

const LOCKED_COLUMNS = sql`id, kind, catalog_entry_id, config_version, connected_by, verified_at`;
type LockedRow = {
  id: string; kind: AnthropicApiConnectionKind; catalog_entry_id: string | null; config_version: number;
  connected_by: string | null; verified_at: Date | string | null;
};
const toLocked = (r: LockedRow): LockedAnthropicConnection => ({
  id: r.id, kind: r.kind, catalogEntryId: r.catalog_entry_id, configVersion: Number(r.config_version),
  connectedBy: r.connected_by, verifiedAt: r.verified_at === null ? null : new Date(r.verified_at),
});

/** One Anthropic API connection of this partner, row-locked for the transaction; null when it is gone or belongs elsewhere. */
export async function lockAnthropicConnection(partnerId: string, connectionId: string): Promise<LockedAnthropicConnection | null> {
  assertSystemContext();
  const [row] = await rows<LockedRow>(sql`SELECT ${LOCKED_COLUMNS} FROM partner_ai_connections
    WHERE id = ${connectionId}::uuid AND partner_id = ${partnerId}::uuid AND kind IN ('anthropic_byok', 'catalog')
    FOR UPDATE`);
  return row ? toLocked(row) : null;
}

/** Every Anthropic API connection id of the partner, row-locked (the create cap and "first connection" check). */
export async function lockAnthropicConnectionIds(partnerId: string): Promise<string[]> {
  assertSystemContext();
  return (await rows<{ id: string }>(sql`SELECT id FROM partner_ai_connections
    WHERE partner_id = ${partnerId}::uuid AND kind IN ('anthropic_byok', 'catalog')
    ORDER BY created_at FOR UPDATE`)).map((r) => r.id);
}

export interface ConnectAnthropicInput {
  kind: AnthropicApiConnectionKind;
  apiKey: string;
  catalogEntryId: string | null;
  connectedBy: string | null;
  verifiedAt?: Date | null;
  /** True for the partner's first Anthropic API connection: its platform traffic moves onto the key (W03 semantics). */
  movePlatformReferences: boolean;
}

export async function connectAnthropicConnection(partnerId: string, input: ConnectAnthropicInput): Promise<string> {
  assertSystemContext();
  await assertPartnerCutOverInTx(partnerId);
  const conn = await createConnection({
    partnerId,
    kind: input.kind,
    name: await connectionName(input.kind, input.catalogEntryId),
    apiKey: input.apiKey,
    catalogEntryId: input.catalogEntryId,
    connectedBy: input.connectedBy,
    verifiedAt: input.verifiedAt ?? new Date(),
  });
  if (input.movePlatformReferences) {
    const skipSurfaces = PLATFORM_PINNED_SURFACES;
    const mapping = await ensureSameModelOfferings(partnerId, { connectionId: null }, { connectionId: conn.id }, { skipSurfaces });
    await remapPartnerOfferings(partnerId, mapping, { skipSurfaces });
    await disableUnreferencedOfferings(partnerId, [...mapping.keys()]);
  }
  return conn.id;
}

/** References on this connection go back to the same models on the platform; then the connection (and its offerings) is deleted. */
export async function disconnectAnthropicConnection(partnerId: string, connectionId: string): Promise<boolean> {
  assertSystemContext();
  await assertPartnerCutOverInTx(partnerId);
  const conn = await lockAnthropicConnection(partnerId, connectionId);
  if (!conn) return false;
  const mapping = await ensureSameModelOfferings(partnerId, { connectionId: conn.id }, { connectionId: null });
  await remapPartnerOfferings(partnerId, mapping);
  // partner_ai_models_refusal_fallback_fk has no ON DELETE: nothing may still point into the doomed offerings.
  await db.execute(sql`UPDATE partner_ai_models SET refusal_fallback_offering_id = NULL, updated_at = now()
    WHERE partner_id = ${partnerId}::uuid AND refusal_fallback_offering_id IN (
      SELECT id FROM partner_ai_models WHERE partner_id = ${partnerId}::uuid AND connection_id = ${conn.id}::uuid)`);
  await db.execute(sql`DELETE FROM partner_ai_connections WHERE id = ${conn.id}::uuid AND partner_id = ${partnerId}::uuid`);
  return true;
}

export async function rotateAnthropicConnectionKey(
  partnerId: string,
  connectionId: string,
  input: { apiKey: string; connectedBy: string | null; verifiedAt: Date },
): Promise<{ configVersion: number }> {
  assertSystemContext();
  await assertPartnerCutOverInTx(partnerId);
  const conn = await lockAnthropicConnection(partnerId, connectionId);
  if (!conn) throw new AnthropicConnectionMissingError();
  const apiKey = input.apiKey.trim();
  const [updated] = await rows<{ config_version: number }>(sql`UPDATE partner_ai_connections SET
      api_key_encrypted = ${encryptConnectionKey(conn.id, apiKey)},
      key_last4 = ${apiKey.slice(-4)},
      key_fingerprint = ${hmacFingerprint(apiKey)},
      status = 'active', last_error = NULL,
      verified_at = ${input.verifiedAt.toISOString()}::timestamptz,
      connected_by = ${input.connectedBy}::uuid,
      config_version = config_version + 1, updated_at = now()
    WHERE id = ${conn.id}::uuid AND partner_id = ${partnerId}::uuid RETURNING config_version`);
  return { configVersion: Number(updated!.config_version) };
}

/** Same-kind catalog change, in place. */
export async function setAnthropicConnectionCatalogEntry(
  partnerId: string,
  connectionId: string,
  input: { catalogEntryId: string },
): Promise<{ configVersion: number }> {
  assertSystemContext();
  await assertPartnerCutOverInTx(partnerId);
  const conn = await lockAnthropicConnection(partnerId, connectionId);
  if (!conn || conn.kind !== 'catalog') throw new AnthropicConnectionMissingError();
  const [updated] = await rows<{ config_version: number }>(sql`UPDATE partner_ai_connections SET
      catalog_entry_id = ${input.catalogEntryId}::uuid, status = 'active', last_error = NULL,
      config_version = config_version + 1, updated_at = now()
    WHERE id = ${conn.id}::uuid AND partner_id = ${partnerId}::uuid RETURNING config_version`);
  return { configVersion: Number(updated!.config_version) };
}

/** A no-op edit that still advances config_version (clearing the endpoint of an already-direct connection). */
export async function bumpConnectionConfigVersion(partnerId: string, connectionId: string): Promise<{ configVersion: number }> {
  assertSystemContext();
  await assertPartnerCutOverInTx(partnerId);
  const conn = await lockAnthropicConnection(partnerId, connectionId);
  if (!conn) throw new AnthropicConnectionMissingError();
  const [updated] = await rows<{ config_version: number }>(sql`UPDATE partner_ai_connections
    SET config_version = config_version + 1, updated_at = now()
    WHERE id = ${conn.id}::uuid AND partner_id = ${partnerId}::uuid RETURNING config_version`);
  return { configVersion: Number(updated!.config_version) };
}

/**
 * BYOK ↔ catalog with the same key, IN PLACE (W08; W03 disconnected and
 * reconnected under a new id). The connection keeps its id, key ciphertext
 * (the AAD is bound to the row id) and every reference to its offerings, so
 * nothing routed anywhere else moves — correct with one connection or several,
 * and in every release combination (no second row ever coexists, so
 * partner_ai_connections_compat_uq never matters). The offerings on it are
 * converted to the new kind's shape (partner_ai_models_catalog_shape_chk:
 * catalog rows carry no platform link, capabilities or price); discovery
 * state is reset because the other kind's sync history does not apply.
 * config_version + 1 invalidates any live SDK query bound to the old shape
 * (spec §9.2). The caller queues discovery after commit.
 */
export async function switchAnthropicConnectionKind(
  partnerId: string,
  connectionId: string,
  input: { kind: AnthropicApiConnectionKind; catalogEntryId: string | null },
): Promise<{ connectionId: string; configVersion: number }> {
  assertSystemContext();
  await assertPartnerCutOverInTx(partnerId);
  const previous = await lockAnthropicConnection(partnerId, connectionId);
  if (!previous) throw new AnthropicConnectionMissingError();
  if (previous.kind === input.kind) throw new AnthropicConnectionMissingError();
  if (input.kind === 'catalog') {
    if (!input.catalogEntryId) throw new Error('switchAnthropicConnectionKind: a catalog connection needs a catalog entry');
    await db.execute(sql`UPDATE partner_ai_models SET
        source = 'catalog', platform_model_id = NULL, capabilities = NULL,
        price_input_cents_per_m = NULL, price_output_cents_per_m = NULL,
        price_cache_read_cents_per_m = NULL, price_cache_write_cents_per_m = NULL,
        missed_sync_count = 0, updated_at = now()
      WHERE partner_id = ${partnerId}::uuid AND connection_id = ${previous.id}::uuid`);
  } else {
    // Back to direct Anthropic: link each model to its platform row (price and
    // capabilities inherit from it, spec §8); a model with no platform row has
    // no resolvable price, so it is disabled until the admin prices it.
    await db.execute(sql`UPDATE partner_ai_models m SET
        source = CASE WHEN pm.id IS NULL THEN 'manual' ELSE 'discovered' END,
        platform_model_id = pm.id,
        enabled = m.enabled AND pm.id IS NOT NULL,
        missed_sync_count = 0, updated_at = now()
      FROM partner_ai_models m2 LEFT JOIN ai_platform_models pm ON pm.model_id = m2.model_id
      WHERE m.id = m2.id AND m.partner_id = ${partnerId}::uuid AND m.connection_id = ${previous.id}::uuid`);
  }
  const [updated] = await rows<{ config_version: number }>(sql`UPDATE partner_ai_connections SET
      kind = ${input.kind},
      catalog_entry_id = ${input.kind === 'catalog' ? input.catalogEntryId : null}::uuid,
      name = ${await connectionName(input.kind, input.catalogEntryId)},
      status = 'active', last_error = NULL, discovery_error = NULL, last_discovered_at = NULL,
      config_version = config_version + 1, updated_at = now()
    WHERE id = ${previous.id}::uuid AND partner_id = ${partnerId}::uuid RETURNING config_version`);
  return { connectionId: previous.id, configVersion: Number(updated!.config_version) };
}

/** The model of the partner-level `chat` default offering, else the bootstrap default (endpoint validation and the catalog-rotation probe). */
export async function partnerChatDefaultModelId(partnerId: string): Promise<string> {
  const [row] = await rows<{ model_id: string | null }>(sql`SELECT COALESCE(m.model_id, pm.model_id) AS model_id
      FROM ai_model_assignments a
      JOIN partner_ai_models m ON m.id = a.default_offering_id AND m.partner_id = ${partnerId}::uuid
      LEFT JOIN ai_platform_models pm ON pm.id = m.platform_model_id
     WHERE a.partner_id = ${partnerId}::uuid AND a.org_id IS NULL AND a.surface = 'chat' AND a.role = 'default'`);
  return row?.model_id ?? resolveBootstrapDefaultModelId();
}
```

- [ ] **Step 5: Create `anthropicConnectionWrites.ts`**

```ts
/**
 * Anthropic API connection writes (W08 #7606): the id-keyed successor of the
 * retired /ai/provider facade (services/partnerLlmConfig.ts, W03 Task 6B).
 *
 * The probe runs OUTSIDE any transaction (connectionProbe.ts); the write then
 * runs in ONE system transaction behind the blocking per-partner registry lock
 * and re-checks, under that lock, that the connection it probed is still the
 * one it writes. Routes (routes/aiModels/connections.ts) own the gates:
 * BILLING_MANAGE + MFA + canManagePartnerWidePolicies, the partner id from auth,
 * and registryWrite's registry gate. Discovery is queued only after commit.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { ANTHROPIC_API_CONNECTION_KINDS, isAnthropicApiConnectionKind } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { partnerAiConnections } from '../../db/schema';
import { buildCatalogEndpointSnapshot, isLlmProviderCatalogEnabled, type ResolvedLlmEndpoint } from '../llm/llmConfigResolver';
import { getListedProviderByEntryId } from '../llmProviderCatalog';
import {
  AnthropicConnectionMissingError,
  bumpConnectionConfigVersion,
  connectAnthropicConnection,
  disconnectAnthropicConnection,
  lockAnthropicConnection,
  lockAnthropicConnectionIds,
  partnerChatDefaultModelId,
  RegistryNotCutOverError,
  rotateAnthropicConnectionKey,
  setAnthropicConnectionCatalogEntry,
  switchAnthropicConnectionKind,
} from './connectionRemap';
import { ConnectionCheckError, probeAnthropicKey, resolveCatalogEndpointForSelection } from './connectionProbe';
import { ConnectionKeyError, decryptConnectionKey, getConnection, getConnectionKeyMaterial, type PartnerAiConnection } from './connections';
import { ensurePartnerCutover } from './registryCutover';
import { RegistryWriteError, toRegistryWriteError } from './registryWriteErrors';
import { lockPartnerRegistry } from './registryWriteLock';
import { safeErrorMessage } from './safeDbError';

/** R1 cap: one Anthropic API connection per partner while partner_ai_connections_compat_uq exists. W08b Task 14 removes it with the index. */
export const MAX_ANTHROPIC_API_CONNECTIONS_PER_PARTNER = 1;

const notCutOver = () => new ConnectionCheckError('AI configuration is being upgraded. Try again in a moment.', 503);
const configChanged = () => new ConnectionCheckError('The AI provider configuration changed. Reload and try again.', 409);

function fromRegistryWriteError(error: RegistryWriteError): ConnectionCheckError {
  const mapped = error.code === 'conflict' || error.code === 'stale_write'
    ? (error.status === 409 && error.message.startsWith('No platform AI model') ? new ConnectionCheckError(error.message, 409) : configChanged())
    : new ConnectionCheckError('Could not save the AI provider configuration.', 500);
  mapped.cause = error.cause;
  return mapped;
}

async function inRegistryWrite<T>(partnerId: string, write: () => Promise<T>): Promise<T> {
  try {
    return await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        await lockPartnerRegistry(partnerId);
        return write();
      }, 'aiModels.anthropicConnectionWrite'));
  } catch (error) {
    if (error instanceof ConnectionCheckError) throw error;
    if (error instanceof RegistryNotCutOverError) throw notCutOver();
    if (error instanceof AnthropicConnectionMissingError) throw configChanged();
    if (error instanceof ConnectionKeyError) throw new ConnectionCheckError('Could not store the API key.', 500);
    // Registry errors and errors that carry SQL values are rewritten; anything
    // else (an invariant, a TypeError) is rethrown untouched for Sentry.
    try {
      toRegistryWriteError(error, 'Could not save the AI provider configuration.');
    } catch (mapped) {
      if (mapped instanceof RegistryWriteError) throw fromRegistryWriteError(mapped);
      throw mapped;
    }
    throw error;
  }
}

/** Spec §6: a new connection, or a key/endpoint change, gets a discovery run. After commit, never awaited (a Redis outage must not fail a committed save). */
function scheduleConnectionDiscovery(connectionId: string): void {
  void runOutsideDbContext(async () => {
    const { enqueueConnectionSync } = await import('../../jobs/aiModelDiscoveryWorker');
    await enqueueConnectionSync(connectionId);
  }).catch((error: unknown) => {
    console.error(`[aiModels] model discovery enqueue failed for connection ${connectionId} (non-fatal): ${safeErrorMessage(error)}`);
  });
}

const systemRead = <T>(fn: () => Promise<T>, label: string) =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

async function readAnthropicConnection(partnerId: string, connectionId: string): Promise<PartnerAiConnection> {
  const conn = await systemRead(() => getConnection(connectionId), 'aiModels.readAnthropicConnection');
  if (!conn || conn.partnerId !== partnerId || !isAnthropicApiConnectionKind(conn.kind)) throw configChanged();
  return conn;
}

async function readConnectionKey(connectionId: string): Promise<string> {
  const material = await systemRead(() => getConnectionKeyMaterial(connectionId), 'aiModels.readConnectionKey');
  if (!material) throw configChanged();
  return decryptConnectionKey(material);
}

const chatDefaultModel = (partnerId: string) =>
  systemRead(() => partnerChatDefaultModelId(partnerId), 'aiModels.chatDefaultModel');

async function gate(partnerId: string): Promise<void> {
  if (!(await ensurePartnerCutover(partnerId))) throw notCutOver();
}

function cleanKey(apiKey: string): string {
  const key = apiKey.trim();
  if (key.startsWith('enc:')) throw new ConnectionCheckError('Anthropic API keys must not start with the encrypted-value prefix.', 400);
  return key;
}

/** Route-level pre-check (outside any transaction) for the friendly 409; the cap is re-checked under the lock. */
export async function hasAnthropicConnection(partnerId: string): Promise<boolean> {
  const [row] = await systemRead(() => db.select({ id: partnerAiConnections.id }).from(partnerAiConnections)
    .where(and(eq(partnerAiConnections.partnerId, partnerId), inArray(partnerAiConnections.kind, [...ANTHROPIC_API_CONNECTION_KINDS])))
    .limit(1), 'aiModels.hasAnthropicConnection');
  return Boolean(row);
}

export async function createAnthropicKeyConnection(input: {
  partnerId: string; apiKey: string; userId: string;
}): Promise<{ connectionId: string; last4: string; configVersion: number }> {
  const apiKey = cleanKey(input.apiKey);
  await gate(input.partnerId);
  await probeAnthropicKey(apiKey, { kind: 'anthropic' });
  const verifiedAt = new Date();
  const connectionId = await inRegistryWrite(input.partnerId, async () => {
    const existing = await lockAnthropicConnectionIds(input.partnerId);
    if (existing.length >= MAX_ANTHROPIC_API_CONNECTIONS_PER_PARTNER) {
      throw new ConnectionCheckError('This partner already has an Anthropic connection. Rotate its key instead.', 409);
    }
    return connectAnthropicConnection(input.partnerId, {
      kind: 'anthropic_byok', apiKey, catalogEntryId: null, connectedBy: input.userId, verifiedAt,
      movePlatformReferences: existing.length === 0,
    });
  });
  scheduleConnectionDiscovery(connectionId);
  return { connectionId, last4: apiKey.slice(-4), configVersion: 1 };
}

export async function rotateAnthropicKey(input: {
  partnerId: string; connectionId: string; apiKey: string; userId: string;
}): Promise<{ last4: string; configVersion: number }> {
  const apiKey = cleanKey(input.apiKey);
  await gate(input.partnerId);
  const conn = await readAnthropicConnection(input.partnerId, input.connectionId);
  // Probe against the endpoint the key will be used with.
  const endpoint: ResolvedLlmEndpoint = conn.kind === 'catalog' && conn.catalogEntryId
    ? await resolveCatalogEndpointForSelection(conn.catalogEntryId, await chatDefaultModel(input.partnerId))
    : { kind: 'anthropic' };
  await probeAnthropicKey(apiKey, endpoint);
  const verifiedAt = new Date();
  const rotated = await inRegistryWrite(input.partnerId, async () => {
    const current = await lockAnthropicConnection(input.partnerId, input.connectionId);
    // The probe targeted the endpoint read above; a concurrent kind or endpoint switch makes it stale.
    if (!current || current.kind !== conn.kind || (current.catalogEntryId ?? null) !== (conn.catalogEntryId ?? null)) throw configChanged();
    return rotateAnthropicConnectionKey(input.partnerId, input.connectionId, { apiKey, connectedBy: input.userId, verifiedAt });
  });
  scheduleConnectionDiscovery(input.connectionId);
  return { last4: apiKey.slice(-4), configVersion: rotated.configVersion };
}

/**
 * Select (or clear) the platform-catalog endpoint a connection routes through
 * (#3922 W3). Clearing reverts to direct Anthropic without a probe. A selection
 * is verified end to end before anything is written: listed with an active
 * revision, the data note acknowledged, the partner's chat default model mapped
 * AND verified on the entry, then a live probe with the stored key. A same-kind
 * change edits the connection in place; a kind switch is a new connection id.
 */
export async function changeAnthropicEndpoint(input: {
  partnerId: string; connectionId: string; catalogEntryId: string | null; acknowledgeDataNote: boolean; userId: string;
}): Promise<{ connectionId: string; catalogEntryId: string | null; configVersion: number; slug: string | null; revision: number | null }> {
  await gate(input.partnerId);
  const existing = await readAnthropicConnection(input.partnerId, input.connectionId);
  const assertUnchanged = async () => {
    const current = await lockAnthropicConnection(input.partnerId, existing.id);
    if (!current) throw configChanged();
    return current;
  };

  if (input.catalogEntryId === null) {
    const switched = { value: false };
    const updated = await inRegistryWrite(input.partnerId, async (): Promise<{ connectionId: string; configVersion: number }> => {
      const current = await assertUnchanged();
      if (current.kind === 'anthropic_byok') return { connectionId: current.id, ...(await bumpConnectionConfigVersion(input.partnerId, current.id)) };
      switched.value = true;
      return switchAnthropicConnectionKind(input.partnerId, current.id, { kind: 'anthropic_byok', catalogEntryId: null });
    });
    // A kind switch changes the destination: rediscover. A bare version bump does not.
    if (switched.value) scheduleConnectionDiscovery(updated.connectionId);
    return { connectionId: updated.connectionId, catalogEntryId: null, configVersion: updated.configVersion, slug: null, revision: null };
  }

  if (!isLlmProviderCatalogEnabled()) {
    throw new ConnectionCheckError('Catalog endpoint selection is currently disabled on this deployment.', 409);
  }
  const provider = await getListedProviderByEntryId(input.catalogEntryId);
  if (!provider) throw new ConnectionCheckError('That endpoint was delisted and is no longer available for selection.', 409);
  // Consent is for the ENDPOINT, independent of the model.
  if (provider.dataNote && !input.acknowledgeDataNote) {
    throw new ConnectionCheckError('You must acknowledge the data-handling note for this endpoint before selecting it.', 400);
  }
  const model = await chatDefaultModel(input.partnerId);
  const endpoint = buildCatalogEndpointSnapshot(provider, model);
  if (!endpoint) {
    throw new ConnectionCheckError(
      'That endpoint does not currently support your configured AI model. Choose a different model or endpoint.', 409,
    );
  }
  const apiKey = await readConnectionKey(existing.id);
  await probeAnthropicKey(apiKey, endpoint);

  const updated = await inRegistryWrite(input.partnerId, async (): Promise<{ connectionId: string; configVersion: number }> => {
    const current = await assertUnchanged();
    if (current.kind === 'catalog') {
      return { connectionId: current.id, ...(await setAnthropicConnectionCatalogEntry(input.partnerId, current.id, { catalogEntryId: provider.entryId })) };
    }
    return switchAnthropicConnectionKind(input.partnerId, current.id, { kind: 'catalog', catalogEntryId: provider.entryId });
  });
  scheduleConnectionDiscovery(updated.connectionId);
  return { connectionId: updated.connectionId, catalogEntryId: provider.entryId, configVersion: updated.configVersion, slug: provider.slug, revision: provider.revision };
}

/** Disconnect: the connection's references go back to the same models on the platform, and the connection is removed, in one transaction. */
export async function deleteAnthropicConnection(input: { partnerId: string; connectionId: string }): Promise<boolean> {
  await gate(input.partnerId);
  return inRegistryWrite(input.partnerId, () => disconnectAnthropicConnection(input.partnerId, input.connectionId));
}
```

Delete `apps/api/src/services/partnerLlmConfig.ts` and `partnerLlmConfig.test.ts`.

- [ ] **Step 6: Point the routes at it**

`apps/api/src/routes/aiModels/shared.ts`: replace `import { PartnerLlmError } from '../../services/partnerLlmConfig';` with `import { ConnectionCheckError } from '../../services/aiModels/connectionProbe';`, and in `registryWrite` replace the `PartnerLlmError` branch with:

```ts
    if (error instanceof ConnectionCheckError) {
      if (error.status >= 500) captureException(error, undefined, { service: 'aiModels' });
      return c.json({ error: error.message }, error.status);
    }
```

Reword the comments that cite `routes/aiProvider.ts` as "the gate the retired /ai/provider API used".

`apps/api/src/routes/aiModels/connections.ts`: delete `ownConnectionId` and the imports of `getCompatConnection` and `services/partnerLlmConfig`; import `isAnthropicApiConnectionKind` from `@breeze/shared` and `changeAnthropicEndpoint, createAnthropicKeyConnection, deleteAnthropicConnection, hasAnthropicConnection, rotateAnthropicKey` from `../../services/aiModels/anthropicConnectionWrites`. Then:

```ts
      case 'anthropic_byok': {
        if (await hasAnthropicConnection(partnerId)) {
          return c.json({ error: 'This partner already has an Anthropic connection. Rotate its key instead.', code: 'conflict' }, 409);
        }
        const result = await createAnthropicKeyConnection({ partnerId, apiKey: body.apiKey, userId });
        // Two writes, not one: the key save probes outside any transaction. If the
        // settings write fails, the connection still works with its defaults.
        if (body.name !== undefined || body.inferenceGeo !== undefined) {
          await updateConnectionSettings({ partnerId, connectionId: result.connectionId, patch: { name: body.name, inferenceGeo: body.inferenceGeo } });
        }
        audit(c, partnerId, 'created', { kind: body.kind, connectionId: result.connectionId, last4: result.last4, configVersion: result.configVersion });
        return c.json({ id: result.connectionId }, 201);
      }
```

```ts
aiModelConnectionRoutes.post('/:id/key', ...partnerWrite, zValidator('param', idParamSchema), zValidator('json', connectionRotateKeySchema), async (c) => {
  const { partnerId, userId } = requirePartnerWide(c);
  return registryWrite(c, partnerId, async () => {
    const conn = await ownConnection(partnerId, c.req.valid('param').id);
    if (!isAnthropicApiConnectionKind(conn.kind)) throw new HTTPException(404, { message: 'Connection not found.' });
    const result = await rotateAnthropicKey({ partnerId, connectionId: conn.id, apiKey: c.req.valid('json').apiKey, userId });
    audit(c, partnerId, 'key_rotated', { connectionId: conn.id, last4: result.last4, configVersion: result.configVersion });
    return c.json({ id: conn.id, keyLast4: result.last4, configVersion: result.configVersion });
  });
});

aiModelConnectionRoutes.post('/:id/endpoint', ...partnerWrite, zValidator('param', idParamSchema), zValidator('json', connectionEndpointSchema), async (c) => {
  const { partnerId, userId } = requirePartnerWide(c);
  const { catalogEntryId, acknowledgeDataNote } = c.req.valid('json');
  // The flag gates SELECTING an endpoint, never clearing one.
  if (catalogEntryId !== null && !isLlmProviderCatalogEnabled()) {
    throw new HTTPException(404, { message: 'Catalog endpoint selection is not available on this deployment.' });
  }
  return registryWrite(c, partnerId, async () => {
    const conn = await ownConnection(partnerId, c.req.valid('param').id);
    if (!isAnthropicApiConnectionKind(conn.kind)) throw new HTTPException(404, { message: 'Connection not found.' });
    const result = await changeAnthropicEndpoint({ partnerId, connectionId: conn.id, catalogEntryId, acknowledgeDataNote, userId });
    audit(c, partnerId, 'endpoint_changed', {
      connectionId: conn.id, newConnectionId: result.connectionId, catalogEntryId: result.catalogEntryId,
      slug: result.slug, revision: result.revision, configVersion: result.configVersion,
    });
    return c.json({ id: result.connectionId, catalogEntryId: result.catalogEntryId, configVersion: result.configVersion });
  });
});
```

In `DELETE /:id` replace `deletePartnerLlmConfig(partnerId)` with `deleteAnthropicConnection({ partnerId, connectionId: conn.id })` (W06 already resolves `conn` with `ownConnection` and dispatches gateway kinds; if W07 added cloud kinds to that dispatch, leave their branch untouched). Every `ownConnection` call stays **inside** the `registryWrite` callback, so a partner without registry rows gets the recoverable 503, not a 404.

Update `routes/aiModels/partnerRoutes.test.ts` and `orgAndUsageRoutes.test.ts`: replace the `vi.mock('../../services/partnerLlmConfig', …)` block with a mock of `'../../services/aiModels/anthropicConnectionWrites'` exposing the five functions, and `getCompatConnection` mocks with W06's `ownConnection` / `getConnection` mocks. Add these route cases to `partnerRoutes.test.ts`:

```ts
  it('POST /connections/:id/key on a gateway connection is 404 and rotates nothing', async () => {
    mockOwnConnection({ id: CONN, partnerId: PARTNER, kind: 'openai_compatible' });
    const res = await app.request(`/ai/models/connections/${CONN}/key`, post({ apiKey: 'sk-ant-1234567890' }));
    expect(res.status).toBe(404);
    expect(writes.rotateAnthropicKey).not.toHaveBeenCalled();
  });

  it('POST /connections/:id/endpoint keeps the connection id across a kind switch', async () => {
    mockOwnConnection({ id: CONN, partnerId: PARTNER, kind: 'anthropic_byok' });
    writes.changeAnthropicEndpoint.mockResolvedValueOnce({ connectionId: CONN, catalogEntryId: 'e1', configVersion: 5, slug: 'gw', revision: 3 });
    const res = await app.request(`/ai/models/connections/${CONN}/endpoint`, post({ catalogEntryId: 'e1', acknowledgeDataNote: true }));
    expect(await res.json()).toEqual({ id: CONN, catalogEntryId: 'e1', configVersion: 5 });
  });

  it('a ConnectionCheckError keeps its message and status (no code), like the retired facade', async () => {
    mockOwnConnection({ id: CONN, partnerId: PARTNER, kind: 'anthropic_byok' });
    writes.rotateAnthropicKey.mockRejectedValueOnce(new ConnectionCheckError('That Anthropic API key was rejected. Check the key and try again.', 400));
    const res = await app.request(`/ai/models/connections/${CONN}/key`, post({ apiKey: 'sk-ant-1234567890' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'That Anthropic API key was rejected. Check the key and try again.' });
  });
```

(`mockOwnConnection`, `post`, `writes`, `CONN`, `PARTNER` follow the helpers the file already has; name them after the existing ones.)

`apps/api/src/__tests__/partner-wide-write-coverage.test.ts`: in the `services/aiModels/connections.ts` reason, replace `partnerLlmConfig/compatRemap, called from routes/aiProvider.ts and routes/aiModels/connections.ts` with `connectionRemap.ts (from anthropicConnectionWrites.ts, called only by routes/aiModels/connections.ts, which gates canManagePartnerWidePolicies)`. Keep any W06/W07 additions to that reason.

Comment-only edits: `offeringWrites.ts`, `registryWriteLock.ts`, `safeDbError.ts`, `ConnectionDrawer.tsx` — replace `partnerLlmConfig` / `compatRemap` / `lockPartnerRegistryReconcile` with `anthropicConnectionWrites` / `connectionRemap` / `lockPartnerRegistry`.

- [ ] **Step 7: Run the unit tests**

Run:
```bash
cd apps/api && npx vitest run src/services/aiModels/connectionProbe.test.ts src/services/aiModels/anthropicConnectionWrites.test.ts \
  src/routes/aiModels/ src/__tests__/partner-wide-write-coverage.test.ts
grep -rn "partnerLlmConfig\|compatRemap\|PartnerLlmError\|getCompatConnection\|ownConnectionId\|lockCompatConnection" apps/api/src apps/web/src --include='*.ts' --include='*.tsx'
```
Expected: PASS. The grep prints only `services/aiModels/connections.ts` (`getCompatConnection` — removed in Task 6), `services/aiModels/invocationLedger.ts` (its shadow listener — removed in Task 5) and `services/aiModels/legacyReconcile.ts` (removed in Task 7).

- [ ] **Step 8: Write the real-Postgres lifecycle suite (replaces `aiProviderAuthority.integration.test.ts`)**

```ts
// apps/api/src/__tests__/integration/aiModelConnectionLifecycle.integration.test.ts
/**
 * W08 (#7606): id-keyed Anthropic connection writes against real Postgres.
 * The probe and the discovery queue are stubbed; everything else is real.
 *  - connect moves every platform reference except patch_test onto the key,
 *    and disables the platform offerings left routing nothing;
 *  - rotate is in place by id; assignments do not move;
 *  - a connection id of another partner is refused and writes nothing;
 *  - disconnect moves only that connection's references back to the platform,
 *    nulls refusal fallbacks into it, and deletes it with its offerings;
 *  - an org override pointing at the platform is untouched by connect.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/aiModels/connectionProbe', async (orig) => ({
  ...(await orig<typeof import('../../services/aiModels/connectionProbe')>()),
  probeAnthropicKey: vi.fn(async () => undefined),
}));
vi.mock('../../jobs/aiModelDiscoveryWorker', () => ({ enqueueConnectionSync: vi.fn(async () => undefined) }));

import { db, withSystemDbAccessContext } from '../../db';
import { aiModelAssignments, partnerAiConnections, partnerAiModels } from '../../db/schema';
import {
  createAnthropicKeyConnection, deleteAnthropicConnection, rotateAnthropicKey,
} from '../../services/aiModels/anthropicConnectionWrites';
import { __resetRegistryCutoverMemoForTests, ensurePartnerCutover } from '../../services/aiModels/registryCutover';
import { seedPricedPlatformModel } from './aiModelRegistryFixtures';
import { createUser } from './db-utils';

const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

async function bootstrappedPartner(): Promise<{ partnerId: string; orgId: string; userId: string }> {
  const partnerId = randomUUID();
  const orgId = randomUUID();
  await sys(async () => {
    await db.execute(sql`INSERT INTO partners (id, name, slug, currency_code) VALUES (${partnerId}, 'W08 conn', ${`w08-conn-${partnerId}`}, 'USD')`);
    await db.execute(sql`INSERT INTO organizations (id, partner_id, name, slug, currency_code) VALUES (${orgId}, ${partnerId}, 'W08 conn org', ${`w08-conn-org-${orgId}`}, 'USD')`);
  });
  expect(await ensurePartnerCutover(partnerId)).toBe(true);
  // connected_by is a users FK: a real user, never a random id.
  const user = await createUser({ partnerId });
  return { partnerId, orgId, userId: user.id };
}

const partnerRows = (partnerId: string) => sys(() => db.select().from(aiModelAssignments)
  .where(and(eq(aiModelAssignments.partnerId, partnerId), isNull(aiModelAssignments.orgId))));
const offering = (id: string | null) => sys(async () => id
  ? (await db.select().from(partnerAiModels).where(eq(partnerAiModels.id, id)))[0] : undefined);

beforeEach(async () => {
  __resetRegistryCutoverMemoForTests();
  await seedPricedPlatformModel({ modelId: `w08-conn-default-${randomUUID()}`, isPlatformDefault: true });
});

describe('Anthropic connection lifecycle (W08)', () => {
  it('connect moves platform references except patch_test onto the key; rotate is in place', async () => {
    const { partnerId, userId } = await bootstrappedPartner();
    const before = await partnerRows(partnerId);
    const platformOffering = before.find((r) => r.surface === 'chat')!.defaultOfferingId;

    const { connectionId } = await createAnthropicKeyConnection({ partnerId, apiKey: 'sk-ant-test-1111111111', userId });
    const after = await partnerRows(partnerId);
    for (const r of after) {
      const o = await offering(r.defaultOfferingId);
      if (r.surface === 'patch_test') expect(o!.connectionId).toBeNull();
      else expect(o!.connectionId).toBe(connectionId);
    }
    // The platform offering still serves patch_test, so it stays enabled.
    expect((await offering(platformOffering))!.enabled).toBe(true);

    const rotated = await rotateAnthropicKey({ partnerId, connectionId, apiKey: 'sk-ant-test-2222222222', userId });
    expect(rotated).toEqual({ last4: '2222', configVersion: 2 });
    expect((await partnerRows(partnerId)).map((r) => r.defaultOfferingId)).toEqual(after.map((r) => r.defaultOfferingId));
  });

  it("a connection id of another partner is refused and writes nothing", async () => {
    const a = await bootstrappedPartner();
    const b = await bootstrappedPartner();
    const { connectionId } = await createAnthropicKeyConnection({ partnerId: b.partnerId, apiKey: 'sk-ant-test-3333333333', userId: b.userId });
    await expect(rotateAnthropicKey({ partnerId: a.partnerId, connectionId, apiKey: 'sk-ant-test-4444444444', userId: a.userId }))
      .rejects.toMatchObject({ status: 409 });
    await expect(deleteAnthropicConnection({ partnerId: a.partnerId, connectionId })).resolves.toBe(false);
    const [row] = await sys(() => db.select().from(partnerAiConnections).where(eq(partnerAiConnections.id, connectionId)));
    expect(row).toMatchObject({ partnerId: b.partnerId, keyLast4: '3333', configVersion: 1 });
  });

  it('disconnect moves only that connection\'s references back, and deletes it with its offerings', async () => {
    const { partnerId, orgId, userId } = await bootstrappedPartner();
    const platformChat = (await partnerRows(partnerId)).find((r) => r.surface === 'chat')!.defaultOfferingId!;
    // An org override that deliberately stays on the platform.
    await sys(() => db.insert(aiModelAssignments).values({
      orgId, partnerId: null, offeringPartnerId: partnerId, surface: 'helper', role: 'default',
      defaultOfferingId: platformChat, permittedOfferingIds: null, allowUserChoice: null, options: null, fallbackOfferingIds: null, fallbackMayCrossFunding: null,
    }));
    const { connectionId } = await createAnthropicKeyConnection({ partnerId, apiKey: 'sk-ant-test-5555555555', userId });
    const [orgRow] = await sys(() => db.select().from(aiModelAssignments).where(eq(aiModelAssignments.orgId, orgId)));
    // W03 semantics: connect moves every platform reference (org rows too) except patch_test.
    expect((await offering(orgRow!.defaultOfferingId))!.connectionId).toBe(connectionId);

    expect(await deleteAnthropicConnection({ partnerId, connectionId })).toBe(true);
    for (const r of await partnerRows(partnerId)) expect((await offering(r.defaultOfferingId))!.connectionId).toBeNull();
    expect(await sys(() => db.select().from(partnerAiModels).where(eq(partnerAiModels.connectionId, connectionId)))).toHaveLength(0);
    expect(await sys(() => db.select().from(partnerAiConnections).where(eq(partnerAiConnections.id, connectionId)))).toHaveLength(0);
  });

  it('a second Anthropic connection is refused while the R1 cap and compat_uq exist', async () => {
    const { partnerId, userId } = await bootstrappedPartner();
    await createAnthropicKeyConnection({ partnerId, apiKey: 'sk-ant-test-6666666666', userId });
    await expect(createAnthropicKeyConnection({ partnerId, apiKey: 'sk-ant-test-7777777777', userId }))
      .rejects.toMatchObject({ status: 409 });
  });
});
```

The `createConnection` key encryption needs the test stack's secret material (the same env W02's connection suites use); if the suite reports `ConnectionKeyError`, copy the env setup from `aiModelRegistryForgery.integration.test.ts`.

`apps/api/src/__tests__/integration/llmCatalogSelection.integration.test.ts`: replace calls to `updatePartnerLlmEndpoint` / `savePartnerLlmKey` / `deletePartnerLlmConfig` with `changeAnthropicEndpoint` / `createAnthropicKeyConnection` + `rotateAnthropicKey` / `deleteAnthropicConnection` (passing the connection id the create returned), delete every assertion on `legacy_default_model` / `defaultModel`, and add three cases against the file's existing catalog fixtures:
- "a catalog switch validates the partner's chat default model: with the chat default set to a model the revision does not map, the switch is 409 and writes nothing";
- "a BYOK → catalog switch is in place: the connection id, its key ciphertext and every assignment default are unchanged; its offerings become `source = 'catalog'` with no platform link and no price; `config_version` + 1";
- "catalog → direct relinks each offering to its platform row (`source = 'discovered'`), and disables an offering whose model has no platform row".

Delete `apps/api/src/__tests__/integration/aiProviderAuthority.integration.test.ts` and `aiModelRegistryReconcile.integration.test.ts` (it imports the deleted facade's functions, so the commit would not compile with it; it tested the projection Task 7 deletes anyway). Run `grep -rln "services/partnerLlmConfig" apps/api/src` — any other test importing the facade is rewritten onto `anthropicConnectionWrites` here.

- [ ] **Step 9: Run the integration suites and the typecheck**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/aiModelConnectionLifecycle.integration.test.ts \
  src/__tests__/integration/llmCatalogSelection.integration.test.ts \
  src/__tests__/integration/aiModelsRoutes.integration.test.ts
npx tsc --noEmit -p tsconfig.json && cd ../web && npx tsc --noEmit
```
Expected: PASS; 0 new type errors (web: only the pre-existing zod-resolver errors W04 recorded).

- [ ] **Step 10: Commit**

```bash
git add -A apps/api/src apps/web/src/components/settings/aiModels/ConnectionDrawer.tsx
git commit -m "refactor(ai): id-keyed Anthropic connection writes replace the /ai/provider facade (#7606)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Delete the shadow-ledger bridge

**Files:**
- Delete: `apps/api/src/services/aiModels/legacyCostEvents.ts`, `legacyCostEvents.test.ts`, `ledgerShadowBoot.contract.test.ts`
- Modify: `apps/api/src/services/aiModels/invocationLedger.ts`, `invocationLedger.test.ts`, `index.ts`
- Modify: `apps/api/src/index.ts`, `apps/api/src/worker.ts`, `apps/api/src/worker.boot.test.ts`
- Modify: `apps/api/src/__tests__/integration/aiInvocationsAppendOnly.integration.test.ts`
- Modify (comments): `services/aiModels/safeDbError.ts`, `services/aiCostTracker.ts`, `services/aiAgentSdk.ts`, `services/streamingSessionManager.ts` where they mention the shadow ledger or `openaiSessionManager`

**Interfaces:**
- Consumes: W03 `invocationLedgerWrite.ts` (`recordInvocation(row: NewInvocation)`, `NewInvocation` incl. `ledgerMode: 'shadow' | 'authoritative'`, `legacyCostCents`); W10's authoritative-only guard if merged (P8).
- Produces: `invocationLedger.ts` exports exactly `recordInvocation` and `type NewInvocation` (index binding name kept). **Removed:** `legacyCostEvents.ts` (`InvocationLedgerContext`, `LegacyCostEvent`, `onLegacyCostRecorded`, `emitLegacyCostRecorded`, `__resetLegacyCostListenersForTests`), `registerInvocationLedgerShadow`, `recordShadowInvocation`, `surfaceFromSession`, `buildShadowRateSnapshot`, `shadowCostDiff`, `getInvocationLedgerShadowCounters`, `__resetInvocationLedgerShadowForTests`. **Kept (D5):** `NewInvocation.ledgerMode` (both values), `legacyCostCents`, the `ai_invocations.ledger_mode` / `legacy_cost_cents` columns, W10's guard.

- [ ] **Step 1: Prove the bridge has no emitter (P5)**

Run:
```bash
grep -rn "emitLegacyCostRecorded\|openaiSessionManager\|OpenAISessionManager" apps/api/src ee --include='*.ts' | grep -v "aiModels/legacyCostEvents\(\.test\)\?\.ts:"
```
Expected: no output (W06 deleted the env OpenAI chat path, the last emitter). If W06 already deleted `legacyCostEvents.ts`, this task reduces to Steps 4–6 for whatever remains; record that in the PR body.

- [ ] **Step 2: Write the failing test**

Replace `apps/api/src/services/aiModels/invocationLedger.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';

describe('invocationLedger (W08: the W02 shadow bridge is gone)', () => {
  it('exports only the ledger write', async () => {
    const mod = await import('./invocationLedger');
    expect(Object.keys(mod).sort()).toEqual(['recordInvocation']);
  });

  it('no module imports the deleted bridge', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = __dirname;
    const offenders = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => /legacyCostEvents|registerInvocationLedgerShadow|recordShadowInvocation/.test(readFileSync(join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
```

(The ledger insert's own tests stay in `invocationLedgerWrite.test.ts` / `settleInvocation.test.ts`.)

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiModels/invocationLedger.test.ts`
Expected: FAIL — the module exports `registerInvocationLedgerShadow`, `recordShadowInvocation`, … and `legacyCostEvents.ts` exists.

- [ ] **Step 4: Implement**

Replace `apps/api/src/services/aiModels/invocationLedger.ts` with:

```ts
/**
 * The invocation ledger entry point (#7598 index: `recordInvocation` lives in
 * invocationLedger.ts). The insert itself is invocationLedgerWrite.ts.
 *
 * W02's shadow bridge (legacy cost events → ledger_mode = 'shadow' rows) was
 * deleted in W08 (#7606) once its last emitter, the env-only OpenAI chat path,
 * was gone (W06). The shadow rows it wrote stay in the append-only ledger;
 * every billing and report query filters ledger_mode = 'authoritative'.
 */
export { recordInvocation, type NewInvocation } from './invocationLedgerWrite';
```

Delete `legacyCostEvents.ts`, `legacyCostEvents.test.ts`, `ledgerShadowBoot.contract.test.ts`. In `services/aiModels/index.ts` delete `export * from './legacyCostEvents';` and change the `invocationLedger` export line to `export { recordInvocation, type NewInvocation } from './invocationLedger';`. In `apps/api/src/index.ts` delete the `registerInvocationLedgerShadow` import and its call with the comment above it (~L1789–1791). In `apps/api/src/worker.ts` delete it from the lazy import (~L443) and the call (~L608). In `worker.boot.test.ts` delete its expectation.

`aiInvocationsAppendOnly.integration.test.ts`: where it creates a shadow row through `recordShadowInvocation`, insert it with `recordInvocation({ ...<the authoritative fixture the file already builds>, ledgerMode: 'shadow', legacyCostCents: 0 })` (if W10's guard demands `charge` only for authoritative rows, a shadow row needs none). Its assertions (append-only trigger, provenance guard) do not change.

Run `grep -rn "getInvocationLedgerShadowCounters\|surfaceFromSession\|shadowCostDiff\|buildShadowRateSnapshot" apps/api/src` — any non-test hit outside `invocationLedger.ts` (for example a metrics route) is deleted with its test in this step.

- [ ] **Step 5: Run the tests**

Run:
```bash
cd apps/api && npx vitest run src/services/aiModels/ src/worker.boot.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiInvocationsAppendOnly.integration.test.ts src/__tests__/integration/aiInvocationSettlement.integration.test.ts
npx tsc --noEmit -p tsconfig.json
```
Expected: PASS; 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add -A apps/api/src
git commit -m "refactor(ai): delete the W02 shadow-ledger bridge; shadow rows stay as history (#7606)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The legacy resolver half goes; topology readiness reads the registry

**Files:**
- Create: `apps/api/src/services/aiModels/readiness.ts`, `readiness.test.ts`
- Create: `apps/api/src/__tests__/integration/aiModelReadiness.integration.test.ts`
- Modify: `apps/api/src/services/llm/llmConfigResolver.ts`, `llmConfigResolver.test.ts`
- Modify: `apps/api/src/services/llm/llmAvailability.ts`, `llmAvailability.test.ts`
- Modify: `apps/api/src/services/topology/aiToolGate.ts` (+ its test's mock)
- Modify: `apps/api/src/services/llm/__scripts__/tool-capture.ts`, `tool-eval.ts`
- Modify: `apps/api/src/services/aiModels/connections.ts` (delete `getCompatConnection`), `connections.test.ts`
- Modify: `apps/api/src/services/extensionAi.ts` (doc comment only)

**Interfaces:**
- Consumes: `getEffectiveAssignment({ partnerId, orgId, surface })` (W02, ambient `db`), `decryptConnectionKey` (W02), `isPlatformLlmConfigured` and `LlmUnusableCode` (`llmAvailability.ts`), `getCurrentDbAccessContext` (`db`), `aiModelRegistryPartnerCutover`, `partnerAiModels`, `partnerAiConnections`, `organizations` (schema).
- Produces:
  - `readiness.ts`: `type ChatReadinessFacts`; `chatReadinessCode(facts: ChatReadinessFacts): LlmUnusableCode | null` (pure); `chatReadinessInSystemContext(orgId: string, deps?: { platformConfigured?: () => boolean }): Promise<LlmUnusableCode | null>` (reads on the caller's held SYSTEM connection; throws if none is held).
  - `llmConfigResolver.ts`: `resolveCatalogEndpoint(catalogEntryId, model)` becomes exported; new `platformLlmConfig(): UsableLlmConfig`. **Removed:** `resolveLlmConfig`, `resolveLlmConfigForOrg`, `llmUnusableCodeForOrgInSystemContext`, `readPartnerLlmConfig`, `compatConnectionOf`, `compatConfigColumns`, `readOrganizationPartnerId` and `LlmOrgResolutionError` (if no caller remains). **Kept:** the `ResolvedLlmConfig` / `UsableLlmConfig` / `ResolvedLlmEndpoint` / `CatalogModelBinding` types (the connection half spec §9 names, used by `candidateLoader`, `connectionFactory`, `streamingSessionManager`, `extensionAi`), `isLlmProviderCatalogEnabled`, `buildCatalogEndpointSnapshot`, `markPartnerLlmError`, `LlmClientCallerContext`.
  - `llmAvailability.ts`: **removed** `llmUnusableCode` (its last caller was W06's deleted env branch); `LlmUnusableCode`, `isPlatformLlmConfigured`, `LlmNotConfiguredError` stay.
  - `connections.ts`: **removed** `getCompatConnection`.

- [ ] **Step 1: Prove the legacy resolver has no runtime caller left (P5)**

Run:
```bash
grep -rn "resolveLlmConfigForOrg\|resolveLlmConfig(\|llmUnusableCode(\|llmUnusableCodeForOrgInSystemContext\|getCompatConnection" apps/api/src ee --include='*.ts' | grep -v "\.test\.ts:"
```
Expected (after W06 and Tasks 4–5): only the definitions in `llmConfigResolver.ts` / `llmAvailability.ts` / `connections.ts`, `topology/aiToolGate.ts` (`llmUnusableCodeForOrgInSystemContext`), and the two `__scripts__` dev tools (`resolveLlmConfig(null)`). Anything else is migrated in this task before deleting.

- [ ] **Step 2: Write the failing tests**

```ts
// apps/api/src/services/aiModels/readiness.test.ts
import { describe, expect, it } from 'vitest';
import { chatReadinessCode, type ChatReadinessFacts } from './readiness';

const base: ChatReadinessFacts = {
  orgFound: true, partnerId: 'p1', bootstrapped: true, platformConfigured: true,
  defaultOffering: { enabled: true, connection: null },
};
const conn = (over: Partial<NonNullable<NonNullable<ChatReadinessFacts['defaultOffering']>['connection']>> = {}) => ({
  ...base, defaultOffering: { enabled: true, connection: { kind: 'anthropic_byok', status: 'active' as const, keyUsable: true, catalog: 'n/a' as const, ...over } },
});

describe('chatReadinessCode', () => {
  it.each<[string, ChatReadinessFacts, ReturnType<typeof chatReadinessCode>]>([
    ['unknown org', { ...base, orgFound: false }, 'ai_unavailable'],
    ['platform default, platform key present', base, null],
    ['platform default, no platform key', { ...base, platformConfigured: false }, 'ai_not_configured'],
    ['not bootstrapped yet: the first request starts on the platform', { ...base, bootstrapped: false, defaultOffering: null }, null],
    ['no default for chat', { ...base, defaultOffering: null }, 'ai_unavailable'],
    ['default offering disabled', { ...base, defaultOffering: { enabled: false, connection: null } }, 'ai_unavailable'],
    ['connection active, key usable', conn(), null],
    ['connection errored', conn({ status: 'error' }), 'ai_unavailable'],
    ['connection key undecryptable', conn({ keyUsable: false }), 'ai_unavailable'],
    ['catalog revision no longer maps the offering model', conn({ kind: 'catalog', catalog: 'unusable' }), 'ai_unavailable'],
    ['catalog mapped and verified', conn({ kind: 'catalog', catalog: 'ok' }), null],
  ])('%s', (_name, facts, expected) => {
    expect(chatReadinessCode(facts)).toBe(expected);
  });
});
```

```ts
// apps/api/src/__tests__/integration/aiModelReadiness.integration.test.ts
/**
 * W08 (#7606): topology AI readiness reads the registry on the caller's HELD
 * system connection (the #6671 pool shape) instead of the retired compat
 * connection + legacy_default_model.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { partnerAiConnections } from '../../db/schema';
import { chatReadinessInSystemContext } from '../../services/aiModels/readiness';
import { connectAnthropicConnection } from '../../services/aiModels/connectionRemap';
import { ensurePartnerCutover } from '../../services/aiModels/registryCutover';
import { lockPartnerRegistry } from '../../services/aiModels/registryWriteLock';
import { seedPricedPlatformModel } from './aiModelRegistryFixtures';

async function partnerWithOrg() {
  const partnerId = randomUUID();
  const orgId = randomUUID();
  await withSystemDbAccessContext(async () => {
    await db.execute(sql`INSERT INTO partners (id, name, slug, currency_code) VALUES (${partnerId}, 'W08 ready', ${`w08-ready-${partnerId}`}, 'USD')`);
    await db.execute(sql`INSERT INTO organizations (id, partner_id, name, slug, currency_code) VALUES (${orgId}, ${partnerId}, 'W08 ready org', ${`w08-ready-org-${orgId}`}, 'USD')`);
  });
  await seedPricedPlatformModel({ modelId: `w08-ready-${randomUUID()}`, isPlatformDefault: true });
  return { partnerId, orgId };
}

describe('chatReadinessInSystemContext (W08)', () => {
  it('refuses to run outside a held system context', async () => {
    await expect(chatReadinessInSystemContext(randomUUID())).rejects.toThrow(/held system DB context/);
  });

  it('a connection-backed chat default: ready while active, unavailable once errored', async () => {
    const { partnerId, orgId } = await partnerWithOrg();
    expect(await ensurePartnerCutover(partnerId)).toBe(true);
    const connectionId = await withSystemDbAccessContext(async () => {
      await lockPartnerRegistry(partnerId);
      return connectAnthropicConnection(partnerId, {
        kind: 'anthropic_byok', apiKey: 'sk-ant-test-8888888888', catalogEntryId: null, connectedBy: null, movePlatformReferences: true,
      });
    });
    const ready = () => withSystemDbAccessContext(() => chatReadinessInSystemContext(orgId, { platformConfigured: () => false }));
    expect(await ready()).toBeNull();
    await withSystemDbAccessContext(() => db.update(partnerAiConnections).set({ status: 'error' }).where(eq(partnerAiConnections.id, connectionId)));
    expect(await ready()).toBe('ai_unavailable');
  });

  it('a platform-backed chat default is ready when the platform key is configured', async () => {
    const { partnerId, orgId } = await partnerWithOrg();
    expect(await ensurePartnerCutover(partnerId)).toBe(true);
    expect(await withSystemDbAccessContext(() => chatReadinessInSystemContext(orgId, { platformConfigured: () => true }))).toBeNull();
    expect(await withSystemDbAccessContext(() => chatReadinessInSystemContext(orgId, { platformConfigured: () => false }))).toBe('ai_not_configured');
  });
});
```

Trim the integration file's imports to what it uses (`randomUUID`, `eq`, `sql`, `describe`, `expect`, `it`, `db`, `withSystemDbAccessContext`, `partnerAiConnections`, `chatReadinessInSystemContext`, `connectAnthropicConnection`, `ensurePartnerCutover`, `lockPartnerRegistry`, `seedPricedPlatformModel`). The "no second pooled connection" property is pinned textually in `readiness.test.ts` (an ESM namespace spy cannot observe a direct import):

```ts
// apps/api/src/services/aiModels/readiness.test.ts — append
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

it('never escapes the held connection (#6671): no runOutsideDbContext / withSystemDbAccessContext in readiness.ts', () => {
  const src = readFileSync(join(__dirname, 'readiness.ts'), 'utf8');
  expect(src).not.toMatch(/runOutsideDbContext|withSystemDbAccessContext/);
});
```

Append to `apps/api/src/services/llm/llmConfigResolver.test.ts` (and delete its `resolveLlmConfig` / `resolveLlmConfigForOrg` / `llmUnusableCodeForOrgInSystemContext` describe blocks):

```ts
describe('the legacy resolver half is gone (W08)', () => {
  it('exports only the connection half', async () => {
    const mod = await import('./llmConfigResolver');
    for (const removed of ['resolveLlmConfig', 'resolveLlmConfigForOrg', 'llmUnusableCodeForOrgInSystemContext']) {
      expect(removed in mod, removed).toBe(false);
    }
    expect(typeof mod.platformLlmConfig).toBe('function');
    expect(typeof mod.resolveCatalogEndpoint).toBe('function');
  });

  it('platformLlmConfig is the deployment key with the deployment default model', async () => {
    const { platformLlmConfig } = await import('./llmConfigResolver');
    expect(platformLlmConfig()).toMatchObject({ source: 'platform' });
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/readiness.test.ts src/services/llm/llmConfigResolver.test.ts`
Expected: FAIL — `./readiness` missing; `resolveLlmConfig` still exported; `platformLlmConfig` missing.

- [ ] **Step 4: Implement `readiness.ts`**

```ts
/**
 * Advisory AI readiness for an org's `chat` surface, read from the registry on
 * the CALLER's held system connection (W08 #7606; replaces
 * the legacy in-context readiness check in llmConfigResolver.ts, which read
 * the retired single-connection view and its pinned default model).
 *
 * Topology's AI tool gate resolves its preconditions inside a held
 * transaction; escaping to a second pooled connection there is the #6671
 * pool-exhaustion shape, so every read here uses the ambient connection
 * (readiness.test.ts pins it). It is a gate, not the decision: resolveModel
 * decides before any model call.
 */
import { and, eq } from 'drizzle-orm';
import { db, getCurrentDbAccessContext } from '../../db';
import { aiModelRegistryPartnerCutover, organizations, partnerAiConnections, partnerAiModels } from '../../db/schema';
import { isPlatformLlmConfigured, type LlmUnusableCode } from '../llm/llmAvailability';
import { resolveCatalogEndpoint } from '../llm/llmConfigResolver';
import { getEffectiveAssignment } from './assignments';
import { decryptConnectionKey } from './connections';

export interface ChatReadinessFacts {
  orgFound: boolean;
  partnerId: string | null;
  bootstrapped: boolean;
  platformConfigured: boolean;
  defaultOffering: null | {
    enabled: boolean;
    connection: null | { kind: string; status: 'active' | 'error'; keyUsable: boolean; catalog: 'n/a' | 'ok' | 'unusable' };
  };
}

export function chatReadinessCode(f: ChatReadinessFacts): LlmUnusableCode | null {
  if (!f.orgFound) return 'ai_unavailable';
  const platform: LlmUnusableCode | null = f.platformConfigured ? null : 'ai_not_configured';
  // Not bootstrapped yet: its first AI request bootstraps it onto the platform.
  if (!f.partnerId || !f.bootstrapped) return platform;
  if (!f.defaultOffering || !f.defaultOffering.enabled) return 'ai_unavailable';
  const c = f.defaultOffering.connection;
  if (!c) return platform;
  if (c.status === 'error' || !c.keyUsable || c.catalog === 'unusable') return 'ai_unavailable';
  return null;
}

async function loadChatReadinessFacts(orgId: string, platformConfigured: boolean): Promise<ChatReadinessFacts> {
  const base = { orgFound: true, partnerId: null, bootstrapped: false, platformConfigured, defaultOffering: null };
  const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) return { ...base, orgFound: false };
  if (!org.partnerId) return base;
  const partnerId = org.partnerId;
  const [cut] = await db.select({ id: aiModelRegistryPartnerCutover.partnerId }).from(aiModelRegistryPartnerCutover)
    .where(eq(aiModelRegistryPartnerCutover.partnerId, partnerId)).limit(1);
  if (!cut) return { ...base, partnerId };
  const assignment = await getEffectiveAssignment({ partnerId, orgId, surface: 'chat' });
  const ready = { ...base, partnerId, bootstrapped: true };
  if (!assignment.defaultOfferingId) return ready;
  const [offering] = await db.select({ enabled: partnerAiModels.enabled, connectionId: partnerAiModels.connectionId, modelId: partnerAiModels.modelId })
    .from(partnerAiModels)
    .where(and(eq(partnerAiModels.id, assignment.defaultOfferingId), eq(partnerAiModels.partnerId, partnerId))).limit(1);
  if (!offering) return ready;
  if (!offering.connectionId) return { ...ready, defaultOffering: { enabled: offering.enabled, connection: null } };
  const [conn] = await db.select({
    id: partnerAiConnections.id, kind: partnerAiConnections.kind, status: partnerAiConnections.status,
    apiKeyEncrypted: partnerAiConnections.apiKeyEncrypted, catalogEntryId: partnerAiConnections.catalogEntryId,
  }).from(partnerAiConnections)
    .where(and(eq(partnerAiConnections.id, offering.connectionId), eq(partnerAiConnections.partnerId, partnerId))).limit(1);
  if (!conn) {
    return { ...ready, defaultOffering: { enabled: offering.enabled, connection: { kind: 'missing', status: 'error', keyUsable: false, catalog: 'n/a' } } };
  }
  let keyUsable = conn.apiKeyEncrypted !== null || (conn.kind !== 'anthropic_byok' && conn.kind !== 'catalog');
  if (conn.apiKeyEncrypted !== null) {
    try {
      decryptConnectionKey({ id: conn.id, apiKeyEncrypted: conn.apiKeyEncrypted });
    } catch {
      keyUsable = false;
    }
  }
  let catalog: 'n/a' | 'ok' | 'unusable' = 'n/a';
  if (conn.kind === 'catalog') {
    const resolved = conn.catalogEntryId && offering.modelId
      ? await resolveCatalogEndpoint(conn.catalogEntryId, offering.modelId)
      : { ok: false as const };
    catalog = resolved.ok ? 'ok' : 'unusable';
  }
  return {
    ...ready,
    defaultOffering: { enabled: offering.enabled, connection: { kind: conn.kind, status: conn.status as 'active' | 'error', keyUsable, catalog } },
  };
}

export async function chatReadinessInSystemContext(
  orgId: string,
  deps: { platformConfigured?: () => boolean } = {},
): Promise<LlmUnusableCode | null> {
  if (getCurrentDbAccessContext()?.scope !== 'system') {
    throw new Error('chatReadinessInSystemContext requires a held system DB context');
  }
  return chatReadinessCode(await loadChatReadinessFacts(orgId, (deps.platformConfigured ?? (() => isPlatformLlmConfigured()))()));
}
```

`apps/api/src/services/topology/aiToolGate.ts`: replace the import of `llmUnusableCodeForOrgInSystemContext` with `import { chatReadinessInSystemContext } from '../aiModels/readiness';` and the call `llmUnusableCodeForOrgInSystemContext(orgId)` with `chatReadinessInSystemContext(orgId)`. Update its test's `vi.mock` target the same way.

`apps/api/src/services/llm/llmConfigResolver.ts`: export `resolveCatalogEndpoint`; delete `compatConnectionOf`, `compatConfigColumns`, `readPartnerLlmConfig`, `resolveLlmConfig`, `resolveLlmConfigForOrg`, `llmUnusableCodeForOrgInSystemContext`, and — if `grep` finds no other caller — `readOrganizationPartnerId` and `LlmOrgResolutionError`; add:

```ts
/** The deployment's own key and default model (dev scripts; the connection half for the platform). */
export function platformLlmConfig(): UsableLlmConfig {
  return { source: 'platform', apiKey: process.env.ANTHROPIC_API_KEY, model: resolveDefaultModel() };
}
```

Change `markPartnerLlmError`'s doc comment from "`configId` is the compat connection id (Task 6B)" to "`configId` is the partner_ai_connections id". Delete the now-unused imports (`partnerAiConnections` only if no remaining user, `inArray`, `organizations`, `SecretKeyMaterialError`, `captureAtMostHourly`, `getCurrentDbAccessContext`, …) — let `tsc` list them.

`apps/api/src/services/llm/llmAvailability.ts`: delete `llmUnusableCode` and its test cases (Step 1 proved no caller).

`apps/api/src/services/llm/__scripts__/tool-capture.ts` and `tool-eval.ts`: replace `await resolveLlmConfig(null)` with `platformLlmConfig()` and fix the import.

`apps/api/src/services/aiModels/connections.ts`: delete `getCompatConnection` (and its cases in `connections.test.ts`).

- [ ] **Step 5: Run the tests**

Run:
```bash
cd apps/api && npx vitest run src/services/aiModels/readiness.test.ts src/services/llm/ src/services/topology/aiToolGate src/services/aiModels/connections.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelReadiness.integration.test.ts
npx tsc --noEmit -p tsconfig.json
grep -rn "resolveLlmConfigForOrg\|resolveLlmConfig(\|llmUnusableCodeForOrgInSystemContext\|getCompatConnection\|compatConfigColumns" apps/api/src ee
```
Expected: PASS; 0 type errors; the grep prints nothing.

- [ ] **Step 6: Commit**

```bash
git add -A apps/api/src
git commit -m "refactor(ai): topology AI readiness reads the registry; the legacy resolver half is deleted (#7606)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Delete the projection, the parity harness, the legacy rates and env vars; `partner_llm_configs` and `legacy_default_model` leave the schema

**Files:**
- Create: `apps/api/src/services/aiModels/legacyRemoval.contract.test.ts`
- Delete: `apps/api/src/services/aiModels/legacyProjection.ts`, `legacyProjection.test.ts`, `legacyReconcile.ts`, `legacyReconcile.test.ts`, `legacySurfaceModels.ts`, `legacySurfaceModels.test.ts`, the whole `services/aiModels/parity/` directory
- Delete: `apps/api/src/db/schema/partnerLlmConfigs.ts`; `apps/api/src/config/env.reviewerDefault.test.ts`, `env.aiScriptReviewerModel.test.ts`
- Delete: `apps/api/src/__tests__/integration/partnerLlmConfigsPartnerRls.integration.test.ts` (`aiModelRegistryReconcile.integration.test.ts` went in Task 4)
- Modify: `apps/api/src/services/aiModels/index.ts`, `connections.ts` (+ test), `registryView.test.ts`, `aiModelRegistry.contract.test.ts` (AST)
- Modify: `apps/api/src/db/schema/index.ts`, `db/schema/aiModelRegistry.ts`, `db/schema/aiModelRegistry.contract.test.ts`
- Modify: `apps/api/src/services/encryptedColumnRegistry.ts` (+ test)
- Modify: `apps/api/src/config/env.ts`, `config/validate.ts` (comment), `config/envReadComposeCoverage.baseline.ts`
- Modify: `apps/api/src/system/connections/registry.ts` (+ test), `system/connections/internalEnvVars.ts`
- Modify: `docker-compose.yml`, `.env.example`
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts`
- Modify: `apps/api/src/__tests__/integration/aiModelRegistryFixtures.ts`, `aiModelRegistryForgery.integration.test.ts`, `workspaceEnrichmentByok.integration.test.ts`, `aiInvocationsAppendOnly.integration.test.ts` (if it still imports `legacyReconcile`)
- Modify: `apps/api/src/services/aiAgent.sessionModel.test.ts` (schema mock), comments in `services/toolSources/secrets.ts`, `services/backupProviders/credentials.ts`

**Interfaces:**
- Consumes: nothing new. Precondition: after Tasks 2–6 nothing outside the deleted files imports them.
- Produces: `legacyRemoval.contract.test.ts` with `DELETED_PATHS` and `RETIRED_IDENTIFIERS` (Tasks 8 and 9 append). **Removed:** every export listed in W02's Index additions under `legacySurfaceModels.ts`, `legacyProjection.ts`, `legacyReconcile.ts` and `parity/`; `getLegacyModelRates`, `LEGACY_MODEL_RATES`; `resolveReviewerDefaultModel`, `AI_SCRIPT_REVIEWER_MODEL`; the Drizzle `partnerLlmConfigs` table and `partnerAiConnections.legacyDefaultModel`; `PartnerAiConnection.legacyDefaultModel`. **Kept:** `encryptedColumnRegistry`'s `partner_ai_connections` entry with `aadTag: 'partner_llm_configs.api_key_encrypted'` (W07 relies on it; renaming would break every stored key).

- [ ] **Step 1: Write the failing ratchet**

```ts
// apps/api/src/services/aiModels/legacyRemoval.contract.test.ts
/**
 * AI model registry W08 (#7606) ratchet: the legacy AI model configuration path
 * stays deleted. DELETED_PATHS must not exist; RETIRED_IDENTIFIERS must not
 * appear in non-test source under the scanned roots. Migrations, docs and the
 * W08 preflight are history and are not scanned. The one legacy string that
 * must survive is the AAD tag 'partner_llm_configs.api_key_encrypted', which
 * seals every stored connection key (encryptedColumnRegistry.ts).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..', '..');
const ROOTS = ['apps/api/src', 'apps/web/src', 'packages/shared/src', 'ee'];
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '.astro', '__tests__', '__fixtures__']);
/** Files whose job is to NAME the legacy objects (archive metadata), never to read them. */
const ALLOWED_FILES = new Set(['apps/api/src/db/schema/aiModelRegistryLegacyArchive.ts']);

export const DELETED_PATHS: readonly string[] = [
  'apps/api/src/routes/aiProvider.ts',
  'apps/api/src/services/partnerLlmConfig.ts',
  'apps/api/src/services/aiModels/compatRemap.ts',
  'apps/api/src/services/aiModels/legacyCostEvents.ts',
  'apps/api/src/services/aiModels/legacyProjection.ts',
  'apps/api/src/services/aiModels/legacyReconcile.ts',
  'apps/api/src/services/aiModels/legacySurfaceModels.ts',
  'apps/api/src/services/aiModels/parity',
  'apps/api/src/db/schema/partnerLlmConfigs.ts',
];

/** [identifier, pattern]: the pattern lets an allowed superstring through. */
export const RETIRED_IDENTIFIERS: ReadonlyArray<readonly [string, RegExp]> = [
  ['partnerLlmConfigs', /\bpartnerLlmConfigs\b/],
  ['partner_llm_configs', /partner_llm_configs(?!\.api_key_encrypted)/],
  ['legacyDefaultModel', /\blegacyDefaultModel\b/],
  ['legacy_default_model', /\blegacy_default_model\b/],
  ['getLegacyModelRates', /\bgetLegacyModelRates\b/],
  ['LEGACY_MODEL_RATES', /\bLEGACY_MODEL_RATES\b/],
  ['reconcilePartnerFromLegacy', /\breconcilePartnerFromLegacy/],
  ['buildDesiredRegistryState', /\bbuildDesiredRegistryState\b/],
  ['resolveReviewerDefaultModel', /\bresolveReviewerDefaultModel\b/],
  ['AI_SCRIPT_REVIEWER_MODEL', /(?<!BREEZE_)\bAI_SCRIPT_REVIEWER_MODEL\b/],
  ['BREEZE_AI_SCRIPT_REVIEWER_MODEL', /\bBREEZE_AI_SCRIPT_REVIEWER_MODEL\b/],
  ['WORKSPACE_CONTENT_LLM_MODEL', /\bWORKSPACE_CONTENT_LLM_MODEL\b/],
  ['registerInvocationLedgerShadow', /\bregisterInvocationLedgerShadow\b/],
  ['emitLegacyCostRecorded', /\bemitLegacyCostRecorded\b/],
  ['getCompatConnection', /\bgetCompatConnection\b/],
  ['PartnerLlmError', /\bPartnerLlmError\b/],
];

function walk(dir: string, out: string[]): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('AI model registry legacy removal (W08 ratchet)', () => {
  it('every deleted path stays deleted', () => {
    expect(DELETED_PATHS.filter((p) => existsSync(join(REPO, p)))).toEqual([]);
  });

  it('no retired identifier appears in non-test source', () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(join(REPO, root), [])) {
        if (ALLOWED_FILES.has(relative(REPO, file).split(sep).join('/'))) continue;
        const src = readFileSync(file, 'utf8');
        for (const [name, pattern] of RETIRED_IDENTIFIERS) {
          if (pattern.test(src)) hits.push(`${relative(REPO, file).split(sep).join('/')}: ${name}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('the scanner fires (control)', () => {
    const [, pattern] = RETIRED_IDENTIFIERS.find(([n]) => n === 'partner_llm_configs')!;
    expect(pattern.test('FROM partner_llm_configs')).toBe(true);
    expect(pattern.test("aadTag: 'partner_llm_configs.api_key_encrypted'")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiModels/legacyRemoval.contract.test.ts`
Expected: FAIL — `legacyProjection.ts`, `legacyReconcile.ts`, `legacySurfaceModels.ts`, `parity`, `partnerLlmConfigs.ts` still exist, and the identifier scan lists them plus `config/env.ts`, `system/connections/*.ts`, `connections.ts`, `aiModelRegistry.ts`, comments in `toolSources/secrets.ts` / `backupProviders/credentials.ts` / `config/validate.ts`.

- [ ] **Step 3: Delete and edit**

1. Precondition check:
   ```bash
   grep -rln "legacyProjection\|legacyReconcile\|legacySurfaceModels\|aiModels/parity" apps/api/src ee --include='*.ts' \
     | grep -v -E "services/aiModels/(legacyProjection|legacyReconcile|legacySurfaceModels)(\.test)?\.ts|services/aiModels/parity/|services/topology/"
   ```
   Expected: only `services/aiModels/index.ts`, `services/aiModels/aiModelRegistry.contract.test.ts` and integration tests (topology's own `legacyProjection` is an unrelated module and is excluded). Anything else stops the task.
2. Delete the files in **Files → Delete**. In `services/aiModels/index.ts` delete `export * from './legacyProjection';` and `export * from './legacyReconcile';`.
3. `config/env.ts`: delete the `DEPRECATED (#7601 W03)` comment block, `resolveReviewerDefaultModel` and `AI_SCRIPT_REVIEWER_MODEL` (~L262–273).
4. Env-var mappings:
   - `docker-compose.yml`: delete the `BREEZE_AI_SCRIPT_REVIEWER_MODEL: ${BREEZE_AI_SCRIPT_REVIEWER_MODEL:-}` line and its comment (~L319–320). `ANTHROPIC_MODEL` stays.
   - `.env.example`: delete the reviewer-model block (~L1353–1355). In the `LLM_PROVIDER_CATALOG_ENABLED` comment (~L1386–1391) replace `partner_llm_configs.catalog_entry_id` with `a connection's catalog endpoint`.
   - `system/connections/registry.ts`: delete the `BREEZE_AI_SCRIPT_REVIEWER_MODEL` entry (~L232) and its expectation in `registry.test.ts`.
   - `system/connections/internalEnvVars.ts`: delete the `WORKSPACE_CONTENT_LLM_MODEL` entry (~L498).
   - `config/envReadComposeCoverage.baseline.ts`: delete `WORKSPACE_CONTENT_LLM_MODEL` from `COMPOSE_INTENTIONALLY_UNMAPPED` (`root` and `prod`) and `BREEZE_AI_SCRIPT_REVIEWER_MODEL` from the `prod` baseline list. The coverage suite fails on a stale baseline entry, so this edit is required, not cosmetic.
   - `config/validate.ts` (~L981): reword the comment's `partner_llm_configs.catalog_entry_id` to `partner_ai_connections.catalog_entry_id`.
5. Schema: delete `db/schema/partnerLlmConfigs.ts` and its `export * from './partnerLlmConfigs';` in `db/schema/index.ts`. In `db/schema/aiModelRegistry.ts` delete the `legacyDefaultModel: text('legacy_default_model'),` column and reword the header comment to "Rows copied from the retired legacy table keep their id, so the AAD tag 'partner_llm_configs.api_key_encrypted' still opens every stored key". Keep the `partner_ai_connections_compat_uq` declaration (dropped in Task 14). In `db/schema/aiModelRegistry.contract.test.ts` delete the `legacy_default_model` / `partner_llm_configs` expectations. The column and table stay in the database until W08b; no R1 code names them.
6. `services/aiModels/connections.ts`: delete `legacyDefaultModel` from `PUBLIC_COLUMNS` and reword the header ("Writers: the registry bootstrap (registryBootstrap.ts) never writes connections; connectionRemap.ts and W06/W07's gateway services do"). Delete `legacyDefaultModel` from fixtures in `connections.test.ts` and `registryView.test.ts`.
7. `services/encryptedColumnRegistry.ts`: delete the `partner_llm_configs` row (~L128) and the "Both entries stay until W08" sentence of the comment above the `partner_ai_connections` row; keep that row exactly (incl. `aadTag: 'partner_llm_configs.api_key_encrypted'`, `aadBinding: 'row'`). In `encryptedColumnRegistry.test.ts` drop `legacySpec` and keep the assertion that the connection spec's AAD for row `r` is `partner_llm_configs.api_key_encrypted:<r>`. The rotation walker therefore stops re-sealing the stale legacy copies; they are destroyed by W08b and are never archived (D8).
8. `services/aiModels/aiModelRegistry.contract.test.ts` (AST): delete the `legacySurfaceModels.ts` entry from `MODEL_LITERAL_ALLOWLIST` and the `parity/` entry from `MODEL_LITERAL_ALLOWLIST_PREFIXES` (the suite's "every exemption is still needed" check would fail on them anyway). The `db/schema/ai.ts` entry stays until Task 9.
9. `__tests__/partner-wide-write-coverage.test.ts`: delete the `services/aiModels/legacyReconcile.ts` entry.
10. Integration tests: delete the file listed. `aiModelRegistryFixtures.ts`: delete the helpers that insert `partner_llm_configs` rows. `aiModelRegistryForgery.integration.test.ts`: delete the `partner_llm_configs` and `legacy_default_model` cases (the table's RLS stays proven by `rls-coverage` until W08b drops it). `workspaceEnrichmentByok.integration.test.ts`: seed the partner's key with `createConnection({ partnerId, kind: 'anthropic_byok', … })` and then `ensurePartnerCutover(partnerId)`, which bootstraps every surface but `patch_test` onto that connection (Task 2) — the suite's assertion that enrichment runs on the partner key is unchanged. Any remaining `reconcilePartnerFromLegacy…` call in an integration file becomes `ensurePartnerCutover(partnerId)`.
11. `services/aiAgent.sessionModel.test.ts`: delete `partnerLlmConfigs` from its schema mock. `services/toolSources/secrets.ts` (~L28) and `services/backupProviders/credentials.ts` (~L11): reword the precedent comment to name `partner_ai_connections.api_key_encrypted`. `services/aiModels/connectionKeys.ts` (~L5) and the comment above the connection row in `services/encryptedColumnRegistry.ts` (~L129–134): reword so they name the AAD tag only as `'partner_llm_configs.api_key_encrypted'` (the allowed string) and not the table. Then run the ratchet and reword **every other comment it flags** — it prints `file: identifier`; a comment that only explains history should say "the retired legacy table" instead of naming it. Do not weaken a pattern to make a hit go away.

- [ ] **Step 4: Run the tests**

Run:
```bash
cd apps/api && npx vitest run src/services/aiModels/ src/config/ src/system/connections/ src/services/encryptedColumnRegistry.test.ts \
  src/db/schema/aiModelRegistry.contract.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/services/aiAgent.sessionModel.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelRegistryForgery.integration.test.ts \
  src/__tests__/integration/workspaceEnrichmentByok.integration.test.ts src/__tests__/integration/aiInvocationsAppendOnly.integration.test.ts
npx tsc --noEmit -p tsconfig.json
cd ../../ee/workspace && npx vitest run src/services/enrichmentService.test.ts
```
Expected: PASS, including `legacyRemoval.contract.test.ts`, `envReadComposeCoverage`, `envComposeParity`, `envInventory`; 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add -A apps/api ee docker-compose.yml .env.example
git commit -m "refactor(ai)!: delete the legacy projection, parity harness, legacy rates and reviewer/extension env vars (#7606)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Retire `reviewerModel` and Office `allowedModels` (reject, don't ignore)

**Files:**
- Create: `packages/shared/src/validators/retiredAiModelFields.ts`, `retiredAiModelFields.test.ts`; modify `packages/shared/src/validators/index.ts`
- Modify: `apps/api/src/routes/ai/scriptPolicy.ts`, `routes/partnerAiScriptPolicy.ts`, `services/scriptProposals/policy.ts` (+ their tests)
- Modify: `apps/api/src/services/mfaStepUpGrant.ts`, `routes/auth/schemas.ts` (+ tests)
- Modify: `apps/api/src/routes/clientAi/schemas.ts`, `routes/clientAi/admin.ts`, `services/clientAiPolicy.ts` (+ tests)
- Modify: `apps/api/src/db/schema/aiScriptPolicies.ts`, `db/schema/clientAi.ts`
- Modify: `packages/shared/src/types/scriptProposals.ts` (L218 only; L246 is a review record's model and stays)
- Modify: `apps/web/src/components/settings/ScriptAuthoringPage.test.tsx`, `apps/web/src/components/clientAi/PolicyEditor.test.tsx` (fixtures)
- Modify: `apps/api/src/upgrade/breaking-changes.json`, `breakingChangesManifest.test.ts`
- Modify: `apps/api/src/services/tenantExportPolicy.ts` (+ `tenantExportPolicy.test.ts`), `services/tenantExportPolicyRegistry.ts`, `__tests__/integration/tenant-export-policy.integration.test.ts` (only if it computes its own missing/extra lists)

**Interfaces:**
- Consumes: the `z.never({ error }).optional()` idiom (`retiredLabourPricing.ts`, P10).
- Produces:
  - `packages/shared/src/validators/retiredAiModelFields.ts`: `AI_MODEL_FIELDS_RETIRED_IN = '0.122'` (R1 `major.minor`); `RETIRED_AI_MODEL_FIELDS: Record<'reviewerModel' | 'allowedModels' | 'model', string>` (replacement text); `type RetiredAiModelField`; `retiredAiModelFieldMessage(field): string`; `retiredAiModelField(field)` → `z.never(...).optional()`.
  - Manifest ids `ai-script-policy-reviewer-model`, `client-ai-policy-allowed-models`.
  - Export policy: `ExportColumnDecision.mayBeAbsent?: true` and a `retiring` group in `tablePolicy`'s `ColumnGroups` (decision `exclude`, may be absent from the live schema). This is what lets R1 run against R2's schema: `buildTenantExportPlan` throws on any policy column the live table lacks, so without it an R2 → R1 rollback breaks organization export (Codex review finding 7).
  - **Removed:** `ScriptPolicyDto.reviewerModel`, `EffectiveScriptPolicy.reviewerModel` / its DTO, `ScriptLaneWideningDelta.reviewerModel` (and the field in `scriptLaneWideningResource`), `ClientAiOrgPolicy.allowedModels`, Drizzle `aiScriptPolicies.reviewerModel`, `clientAiOrgPolicies.allowedModels`.

The `ScriptAuthoringPage` "Reviewer model" row stays: since W04 it is a pointer (`ModelDefaultsLink surface="script_reviewer"`), not the column, so the `scriptAuthoringPage.fields.reviewerModel` locale key stays too.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/src/validators/retiredAiModelFields.test.ts
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { AI_MODEL_FIELDS_RETIRED_IN, retiredAiModelField, retiredAiModelFieldMessage } from './retiredAiModelFields';

describe('retired AI model fields (W08)', () => {
  const schema = z.object({ name: z.string().optional(), reviewerModel: retiredAiModelField('reviewerModel') }).strict();

  it('rejects the field with any value, including null, naming the replacement', () => {
    for (const value of ['claude-x', null, '']) {
      const r = schema.safeParse({ reviewerModel: value });
      expect(r.success).toBe(false);
      expect(r.error!.issues[0]!.message).toBe(retiredAiModelFieldMessage('reviewerModel'));
    }
  });

  it('accepts a body without it, and the parsed type has no such key', () => {
    expect(schema.parse({ name: 'x' })).toEqual({ name: 'x' });
  });

  it('names the version and the /ai/models replacement', () => {
    expect(retiredAiModelFieldMessage('reviewerModel')).toContain(`retired in v${AI_MODEL_FIELDS_RETIRED_IN}`);
    expect(retiredAiModelFieldMessage('reviewerModel')).toContain('script_reviewer');
    expect(retiredAiModelFieldMessage('allowedModels')).toContain('office_chat');
    expect(retiredAiModelFieldMessage('model')).toContain('offeringId');
  });
});
```

Route tests (flip W04's "strips" cases):

```ts
// apps/api/src/routes/ai/scriptPolicy.test.ts — replace W04's "PUT script policy strips reviewerModel" case
  it('PUT /ai/script-policy with reviewerModel → 400 naming the replacement; nothing is written', async () => {
    const res = await putPolicy({ proposingEnabled: true, reviewerModel: 'claude-x' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('script_reviewer');
    expect(dbInsertSpy).not.toHaveBeenCalled();
  });

  it('GET /ai/script-policy no longer returns reviewerModel', async () => {
    const body = await (await getPolicy()).json();
    expect(body.policy ?? body).not.toHaveProperty('reviewerModel');
  });
```

Same two cases in `routes/partnerAiScriptPolicy.test.ts` (`PUT /partner/ai/script-policy`) and, for `allowedModels`, in `routes/clientAi/admin.test.ts` (`PUT /client-ai/admin/orgs/:orgId/policy` → 400 naming `office_chat`; GET has no `allowedModels`). Use each file's existing request helpers and DB mocks (`putPolicy`, `getPolicy`, `dbInsertSpy` stand for them).

```ts
// apps/api/src/services/mfaStepUpGrant.test.ts — append
  it('the script-lane widening digest no longer binds reviewerModel (W08)', () => {
    const widening = { maxUnattendedRiskTier: 'low', unattendedAllowedClasses: [], maxUnattendedPerHour: 1, protectedResourcesEmptied: false, proposingEnabled: true };
    expect(scriptLanePolicyResourceDigest({ orgId: ORG, unattendedEnabled: true, widening }))
      .toBe(scriptLanePolicyResourceDigest({ orgId: ORG, unattendedEnabled: true, widening: { ...widening } }));
    expect(Object.keys(widening)).not.toContain('reviewerModel');
  });
```

(`ORG` is the file's org fixture; if it has none, use a literal uuid.)

`apps/api/src/services/tenantExportPolicy.test.ts` — append, using the file's existing `information_schema` mock (`mockLiveColumns(table, columns)` stands for whatever helper it has):

```ts
describe('retiring columns (#7606)', () => {
  const policy = () => ({
    ai_script_policies: tablePolicy('org_id', {
      included: ['id', 'org_id'], reviewedIncluded: [], excludedSensitive: [], excludedOpen: [], retiring: ['reviewer_model'],
    }),
  });

  it('a retiring column may be absent from the live schema (after the drop)', async () => {
    mockLiveColumns('ai_script_policies', ['id', 'org_id']);
    const [plan] = await buildTenantExportPlan(['ai_script_policies'], policy());
    expect(plan!.includedColumns).toEqual(['id', 'org_id']);
  });

  it('a retiring column that is still present is never exported (before the drop)', async () => {
    mockLiveColumns('ai_script_policies', ['id', 'org_id', 'reviewer_model']);
    const [plan] = await buildTenantExportPlan(['ai_script_policies'], policy());
    expect(plan!.includedColumns).not.toContain('reviewer_model');
  });

  it('an ordinary policy column missing from the live schema still throws', async () => {
    mockLiveColumns('ai_script_policies', ['id']);
    await expect(buildTenantExportPlan(['ai_script_policies'], policy())).rejects.toThrow(/org_id/);
  });
});
```

In `breakingChangesManifest.test.ts` add `'ai-script-policy-reviewer-model'` and `'client-ai-policy-allowed-models'` to `RECORDED_ENTRY_IDS` and:

```ts
describe('retired AI model fields match their message (#7606)', () => {
  it.each([
    ['ai-script-policy-reviewer-model', 'reviewerModel'],
    ['client-ai-policy-allowed-models', 'allowedModels'],
  ] as const)('%s', (id, field) => {
    const entry = BREAKING_CHANGES_MANIFEST.entries.find((e) => e.id === id)!;
    const removed = semver.parse(entry.removedIn!)!;
    expect(retiredAiModelFieldMessage(field)).toContain(`retired in v${removed.major}.${removed.minor}`);
    for (const surface of entry.surfaces) expect(surface.fields).toEqual([field]);
  });
});
```

(import `retiredAiModelFieldMessage` from `@breeze/shared`.)

- [ ] **Step 2: Run them to verify they fail**

Run:
```bash
cd packages/shared && npx vitest run src/validators/retiredAiModelFields.test.ts; cd ../..
cd apps/api && npx vitest run src/routes/ai/scriptPolicy.test.ts src/routes/partnerAiScriptPolicy.test.ts src/routes/clientAi/admin.test.ts \
  src/services/mfaStepUpGrant.test.ts src/upgrade/breakingChangesManifest.test.ts
```
Expected: FAIL — module missing; PUTs return 200 (accepted-and-ignored); GETs still carry the fields; manifest ids missing.

- [ ] **Step 3: Implement**

```ts
// packages/shared/src/validators/retiredAiModelFields.ts
import { z } from 'zod';

/**
 * Request fields retired by the AI model registry cleanup (W08, #7606), per the
 * #6472 policy: a retired meaningful write is REJECTED with an actionable
 * message naming its replacement, never accepted and silently ignored. Each one
 * has a `breaking-changes.json` entry whose removedIn matches this version
 * (pinned by apps/api/src/upgrade/breakingChangesManifest.test.ts).
 */
export const AI_MODEL_FIELDS_RETIRED_IN = '0.122';

export const RETIRED_AI_MODEL_FIELDS = {
  reviewerModel:
    "set the script reviewer's model under Settings → AI Providers & Models → Defaults by feature (PUT /api/v1/ai/models/assignments, feature script_reviewer).",
  allowedModels:
    'set the models AI for Office may use under Settings → AI Providers & Models → Defaults by feature (feature office_chat), or narrow them for one organization with PUT /api/v1/ai/models/orgs/:orgId/assignments.',
  model:
    'send offeringId instead: an enabled model from GET /api/v1/ai/models (the AI agents feature); offeringId null follows the AI agents default.',
} as const;

export type RetiredAiModelField = keyof typeof RETIRED_AI_MODEL_FIELDS;

export function retiredAiModelFieldMessage(field: RetiredAiModelField): string {
  return `${field} was retired in v${AI_MODEL_FIELDS_RETIRED_IN}: ${RETIRED_AI_MODEL_FIELDS[field]}`;
}

/**
 * Declared (so zod's default unknown-key stripping cannot turn it into a silent
 * no-op) and rejected whenever present, with any value including null.
 */
export function retiredAiModelField(field: RetiredAiModelField) {
  return z.never({ error: retiredAiModelFieldMessage(field) }).optional();
}
```

Add `export * from './retiredAiModelFields';` to `packages/shared/src/validators/index.ts`.

`routes/ai/scriptPolicy.ts`: in `orgUpdateSchema` replace the `reviewerModel` line and its comment with `reviewerModel: retiredAiModelField('reviewerModel'),`; delete `reviewerModel` from `toScriptPolicyDto`, `GRANT_SCHEMA_DEFAULTS`, `effectiveGrantValues` and `computeWidening`; change `const { stepUpGrant: _grant, reviewerModel: _ignoredReviewerModel, ...columns } = body;` to `const { stepUpGrant: _grant, ...columns } = body;`; update the header comment's "reviewerModel/proposingEnabled" lists. Same edits in `routes/partnerAiScriptPolicy.ts` (`partnerUpdateSchema`, the defaults at ~L74/L96/L130, the destructure at ~L203). If the API's `zod` instance differs from `packages/shared`'s (a `tsc` or runtime "not a zod schema" error), declare the field locally as `z.never({ error: retiredAiModelFieldMessage('reviewerModel') }).optional()` with the shared message.

`services/scriptProposals/policy.ts`: delete `reviewerModel` from `EffectiveScriptPolicy` (~L44), the picked-keys union (~L62) and the merge (~L102). `packages/shared/src/types/scriptProposals.ts`: delete `reviewerModel: string | null;` at L218 only.

`services/mfaStepUpGrant.ts`: delete `reviewerModel` from `ScriptLaneWideningDelta` and from the canonical object `scriptLanePolicyResourceDigest` hashes; update the two comments that list it. `routes/auth/schemas.ts`: delete `reviewerModel: z.string().nullable(),` from `scriptLaneWideningResource` (a non-strict object: a cached client that still sends it has the key stripped, and the digest is computed server-side on both sides). A step-up grant minted before the deploy and redeemed after it fails once and the user repeats the passkey prompt; say so in the PR body.

`routes/clientAi/schemas.ts`: replace the `allowedModels` line and comment in `putPolicySchema` with `allowedModels: retiredAiModelField('allowedModels'),`. `services/clientAiPolicy.ts`: delete `allowedModels` from `ClientAiOrgPolicy`, its default and `asStringArray(row.allowedModels, …)`. `routes/clientAi/admin.ts`: nothing writes it (W04); delete any remaining mention.

Schema: delete `reviewerModel` from `db/schema/aiScriptPolicies.ts` (~L38) and `allowedModels` from `db/schema/clientAi.ts` (~L50). The columns stay in the database (nullable / `NOT NULL DEFAULT '[]'`, so inserts that omit them succeed) until W08b.

Web fixtures: delete `reviewerModel: null` from `ScriptAuthoringPage.test.tsx` and `allowedModels: []` from `PolicyEditor.test.tsx`.

Export policy — `services/tenantExportPolicy.ts`: add `mayBeAbsent?: true` to `ExportColumnDecision` (doc: "A retiring column: excluded from the export and allowed to be absent from the live schema, because a later migration drops it (#7606)"), and in `buildTenantExportPlan` change

```ts
    const extra = policyColumnNames.filter((name) => !liveColumnSet.has(name));
```

to

```ts
    const extra = policyColumnNames.filter((name) => !liveColumnSet.has(name) && policy.columns[name]!.mayBeAbsent !== true);
```

`services/tenantExportPolicyRegistry.ts`: add `retiring?: readonly string[];` to `ColumnGroups`, a decision

```ts
const RETIRING: ExportColumnDecision = {
  decision: 'exclude',
  rationale: 'Retired column scheduled to be dropped; never exported, and may already be absent from the live schema (AI model registry W08, #7606).',
  mayBeAbsent: true,
  openContainerReviewed: true,
};
```

and `for (const column of groups.retiring ?? []) assign(column, RETIRING);` in `tablePolicy`. Then move `"reviewer_model"` from `ai_script_policies`' `included` into `"retiring": ["reviewer_model"]`, and `"allowed_models"` from `client_ai_org_policies`' `excludedOpen` into `"retiring": ["allowed_models"]`. (R1 therefore stops exporting `reviewer_model`, a field with no meaning since W03.) If `tenant-export-policy.integration.test.ts` re-derives missing/extra columns itself instead of calling `buildTenantExportPlan`, give it the same `mayBeAbsent` exemption.

Manifest — append (R0 / R1 from Task 1; `earliestRemovalDate` = the R0 tag date):

```json
    {
      "id": "ai-script-policy-reviewer-model",
      "title": "reviewerModel on the script policy retired",
      "kind": "api-request-field",
      "surfaces": [
        { "endpoint": "PUT /api/v1/ai/script-policy", "fields": ["reviewerModel"] },
        { "endpoint": "PUT /api/v1/partner/ai/script-policy", "fields": ["reviewerModel"] }
      ],
      "replacement": "The script reviewer's model is the script_reviewer feature default: Settings -> AI Providers & Models -> Defaults by feature, or PUT /api/v1/ai/models/assignments (approvals:decide required). The GET responses of both endpoints no longer include reviewerModel.",
      "deprecatedIn": "0.121.0",
      "deprecationBehaviour": "Accepted and ignored: the value was not stored and had no effect on which model reviewed scripts.",
      "earliestRemovalDate": "<the R0 tag date>",
      "removedIn": "0.122.0",
      "removalBehaviour": "A request that includes reviewerModel is rejected with HTTP 400 naming the field and its replacement. Nothing else in the request is applied.",
      "references": ["#7598", "#7601", "#7602", "#7606"]
    },
    {
      "id": "client-ai-policy-allowed-models",
      "title": "allowedModels on the AI for Office organization policy retired",
      "kind": "api-request-field",
      "surfaces": [
        { "endpoint": "PUT /api/v1/client-ai/admin/orgs/:orgId/policy", "fields": ["allowedModels"] }
      ],
      "replacement": "The models AI for Office may use are the office_chat feature's permitted models: Settings -> AI Providers & Models -> Defaults by feature, or narrow them for one organization with PUT /api/v1/ai/models/orgs/:orgId/assignments. The GET response no longer includes allowedModels.",
      "deprecatedIn": "0.121.0",
      "deprecationBehaviour": "Accepted and ignored: the value was not stored and had no effect on which model AI for Office used.",
      "earliestRemovalDate": "<the R0 tag date>",
      "removedIn": "0.122.0",
      "removalBehaviour": "A request that includes allowedModels is rejected with HTTP 400 naming the field and its replacement. Nothing else in the request is applied.",
      "references": ["#7598", "#7601", "#7602", "#7606"]
    }
```

Append to `legacyRemoval.contract.test.ts`'s `RETIRED_IDENTIFIERS`: `['_ignoredReviewerModel', /_ignoredReviewerModel/]`.

- [ ] **Step 4: Run the tests**

Run:
```bash
cd packages/shared && npx vitest run src/validators/retiredAiModelFields.test.ts && npx tsc --noEmit; cd ../..
cd apps/api && npx vitest run src/routes/ai/ src/routes/partnerAiScriptPolicy.test.ts src/routes/clientAi/ src/services/clientAiPolicy.test.ts \
  src/services/scriptProposals/ src/services/mfaStepUpGrant.test.ts src/routes/auth/ src/upgrade/ src/services/aiModels/legacyRemoval.contract.test.ts \
  src/services/tenantExportPolicy
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
npx tsc --noEmit -p tsconfig.json
cd ../web && npx vitest run src/components/settings/ScriptAuthoringPage.test.tsx src/components/clientAi/PolicyEditor.test.tsx && npx tsc --noEmit
```
Expected: PASS; 0 new type errors.

- [ ] **Step 5: Commit**

```bash
git add -A packages/shared apps/api apps/web/src/components
git commit -m "feat(ai)!: reject the retired reviewerModel and Office allowedModels fields with their replacement (#7606)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Retire the AI agent policy `model` string

Skip this task if Task 1 Step 1 showed W05 ships in the same release as W08a (P4); it then becomes W08c, and W08b leaves **both** `ai_agents.model` and `ai_budgets.allowed_models` in place (this task removes the only reader of the budget column too — `effectivePolicy.ts`'s allowlist merge), so W08c's own later migration drops both.

**Files:**
- Modify: `packages/shared/src/validators/aiAgents.ts`, `packages/shared/src/types/aiAgents.ts` (+ tests)
- Modify: `apps/api/src/services/aiAgents/agentModelBinding.ts`, `agentOfferingBinding.ts` (W05), `agentService.ts`, `effectivePolicy.ts`, `supervisedKeyGrant.ts`, `graduationService.ts`, `supervisedKeyDemote.ts`, `runService.ts` (+ their tests, incl. `effectivePolicy.ceiling.contract.test.ts`)
- Modify: `apps/api/src/services/fleetDesign/designerSetup.ts` (only if it passes `model`)
- Modify: `apps/api/src/routes/aiAgents.ts` (+ test)
- Modify: `apps/api/src/db/schema/aiAgents.ts`, `db/schema/ai.ts`
- Modify: `apps/api/src/services/aiModels/aiModelRegistry.contract.test.ts` (delete the `db/schema/ai.ts` literal exemption)
- Modify: `apps/web/src/components/settings/aiAgents/**/*.test.tsx` fixtures with `model:`
- Modify: `apps/api/src/upgrade/breaking-changes.json`, `breakingChangesManifest.test.ts`, `services/aiModels/legacyRemoval.contract.test.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`ai_agents.model`, `ai_budgets.allowed_models` → `retiring`)
- Modify: `apps/api/src/__tests__/integration/aiModelRegistryFixtures.ts` (`seedAgent` loses `model`) and its callers (`aiModelRegistryForgery.integration.test.ts` ~L353, any other)

**Interfaces:**
- Consumes: Task 8 `retiredAiModelField('model')` and the export `retiring` group; W05 `bindAgentOffering(owner, offeringId, writer)`.
- Produces:
  - `bindAgentOffering(owner, offeringId, writer): Promise<{ offeringId: string | null; offeringPartnerId: string | null }>` (no `model`).
  - `type AgentModelBinding = { offeringId: string | null; offeringPartnerId: string | null }`.
  - `mergeAgentPolicies(partner: AiAgentPolicy, org: AiAgentPolicy | null)` — the third `{ allowedModels }` argument is gone.
  - `AiAgentPolicy` and `AiAgentDto` without `model`; `AiAgentPolicyProvenance` without `model`.
  - Manifest id `ai-agent-policy-model`.
  - **Removed:** `bindAgentModel`, the `ai_budgets.allowed_models` read in `effectivePolicy.ts`, Drizzle `aiAgents.model` and `aiBudgets.allowedModels`.

Behaviour: an agent's model is its `offeringId` (W05 picker), else the `ai_agents` assignment default — exactly what runs route on since W03 (`runLoop.ts` resolves `run.admittedOfferingId ?? effective.offeringId`). The `effective.model` string only fed two snapshots: admission's `resolvedModel` (task-linked runs; `runLoop` overwrites it with the model actually used) now starts `null`, and the supervised-key clone no longer copies a string the run never read.

- [ ] **Step 1: Prove no client still sends `model`**

Run:
```bash
grep -rn "bindAgentModel" apps/api/src --include='*.ts' | grep -v "\.test\.ts:"
grep -rn -E "\bmodel:" apps/web/src/components/settings/aiAgents apps/web/src/lib --include='*.ts' --include='*.tsx' | grep -v "\.test\."
grep -n "model" apps/api/src/services/fleetDesign/designerSetup.ts apps/api/src/services/aiAgents/managedAutomation.ts
```
Expected: `bindAgentModel` only in `agentModelBinding.ts` and `agentService.ts`; no web create/update payload sets `model` (W05's `AgentModelSelect` sends `offeringId`); the fleet designer and managed automation create agents without `model`. Anything else is migrated to `offeringId` in this task.

- [ ] **Step 2: Write the failing tests**

```ts
// packages/shared/src/validators/aiAgents.test.ts — append
describe('agent policy model string is retired (W08)', () => {
  it.each([
    ['create', () => createAiAgentSchema.safeParse({ kind: 'triage', name: 'T', model: 'claude-x' })],
    ['create (null)', () => createAiAgentSchema.safeParse({ kind: 'triage', name: 'T', model: null })],
    ['update', () => updateAiAgentSchema.safeParse({ model: 'claude-x' })],
  ])('%s with model → rejected naming offeringId', (_n, parse) => {
    const r = parse();
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error!.issues)).toContain('offeringId');
  });

  it('create without model still parses and has no model key', () => {
    const r = createAiAgentSchema.parse({ kind: 'triage', name: 'T' });
    expect(r).not.toHaveProperty('model');
  });
});
```

```ts
// apps/api/src/services/aiAgents/effectivePolicy.test.ts — replace every allowedModels case with:
  it('the merge has no model string and no allowlist: the org offering wins, else the partner one (W08)', () => {
    const partner = normalizeAgentPolicy({ ...PARTNER_ROW, offeringId: 'off-p' });
    const org = normalizeAgentPolicy({ ...ORG_ROW, offeringId: 'off-o' });
    expect(mergeAgentPolicies(partner, org).effective.offeringId).toBe('off-o');
    expect(mergeAgentPolicies(partner, { ...org, offeringId: null }).effective.offeringId).toBe('off-p');
    expect(mergeAgentPolicies(partner, org).effective).not.toHaveProperty('model');
  });

  it('resolving the effective policy reads no ai_budgets row (W08)', async () => {
    await resolveEffectiveAgentPolicy(ORG_ID, 'triage');
    expect(selectedTables()).not.toContain('ai_budgets');
  });
```

(`PARTNER_ROW`, `ORG_ROW`, `ORG_ID`, `resolveEffectiveAgentPolicy` and `selectedTables` stand for the file's existing fixtures, loader and Drizzle mock recorder; name them after what it has.)

```ts
// apps/api/src/services/aiAgents/supervisedKeyGrant.test.ts — append
  it('the org clone copies no model string and leaves the offering to follow the partner (W08)', () => {
    const values = cloneValuesFromEffectiveForTests(ORG_ID, 'triage', PARTNER_ROW, USER_ID);
    expect(values).not.toHaveProperty('model');
    expect(values.offeringId ?? null).toBeNull();
  });
```

(If `cloneValuesFromEffective` is module-private, export it as `cloneValuesFromEffectiveForTests` or assert through the insert mock the file already uses.)

`routes/aiAgents.test.ts`: `POST /ai/agents` with `model` → 400 whose body names `offeringId`; the agent DTO has no `model`.

`breakingChangesManifest.test.ts`: add `'ai-agent-policy-model'` to `RECORDED_ENTRY_IDS` and `['ai-agent-policy-model', 'model']` to the Task 8 `it.each`.

`legacyRemoval.contract.test.ts`: append `['bindAgentModel', /\bbindAgentModel\b/]` to `RETIRED_IDENTIFIERS`.

- [ ] **Step 3: Run them to verify they fail**

Run:
```bash
cd packages/shared && npx vitest run src/validators/aiAgents.test.ts; cd ../..
cd apps/api && npx vitest run src/services/aiAgents/effectivePolicy.test.ts src/services/aiAgents/supervisedKeyGrant.test.ts \
  src/routes/aiAgents.test.ts src/upgrade/ src/services/aiModels/legacyRemoval.contract.test.ts
```
Expected: FAIL — `model` accepted; merge still takes `allowedModels` and returns `model`; clone copies `model`; `bindAgentModel` present.

- [ ] **Step 4: Implement**

`packages/shared/src/validators/aiAgents.ts`: in `aiAgentPolicyFieldsSchema` replace `model: z.string().trim().min(1).max(100).nullable().default(null),` with `model: retiredAiModelField('model'),`; in `updateAiAgentSchema` replace its `model` line the same way. `previewAiAgentSchema` inherits it. `packages/shared/src/types/aiAgents.ts`: delete `model` from `AiAgentPolicy` (~L559) and `AiAgentDto` (~L790), and from `AiAgentPolicyProvenance` if declared there.

`services/aiAgents/agentModelBinding.ts`: delete `bindAgentModel`; `AgentModelBinding` becomes `{ offeringId: string | null; offeringPartnerId: string | null }`; keep `AgentModelOwner` and the `AgentModelNotAllowedError` re-export. `agentOfferingBinding.ts` (W05): return `{ offeringId, offeringPartnerId }` (drop `model: candidate.logicalModel`) and `{ offeringId: null, offeringPartnerId: null }` for a null offering.

`services/aiAgents/agentService.ts`: delete `bindPolicyModel`, `modelNeedsBinding` and the `model` column from `bindingColumns`; at both binding sites call only `bindAgentOffering` when `input.offeringId !== undefined` (W05's code path) and spread `{ offeringId, offeringPartnerId }`. The `'Send offeringId or model, not both.'` check goes (the validator rejects `model`).

`services/aiAgents/effectivePolicy.ts`: delete `'model'` from `PolicyRowFields`' pick, `model: row.model ?? null` from `normalizeAgentPolicy`, the `opts` parameter and `orgModelAllowed` from `mergeAgentPolicies`, the `model: pick('model', …)` line and the comment block above `orgModelAllowed`, `model` from `partnerProvenance()`, and the `aiBudgets` select + `allowedModels` computation in the loader (~L530–541) so it calls `mergeAgentPolicies(normalizeAgentPolicy(partnerRow), orgRow ? normalizeAgentPolicy(orgRow) : null)`. The `offeringId` pick stays as is. Drop the third argument at every caller: `graduationService.ts` (~L410, ~L455), `supervisedKeyDemote.ts` (~L434), `supervisedKeyGrant.ts` (~L205).

`services/aiAgents/supervisedKeyGrant.ts`: delete `model: effective.model,` from `cloneValuesFromEffective` and the sentence about `allowedModels` in its doc comment. Do **not** copy `offeringId`: the org clone keeps following the partner baseline's binding, which is what routed the agent before (the clone's string was never read for routing).

`services/aiAgents/runService.ts` (~L1690–1697): replace the comment and `resolvedModel: input.task ? (resolved.effective.model ?? null) : null,` with:

```ts
        // Stamped by runLoop.ts with the model the run actually used, once
        // resolveModel has bound the offering (spec §6.2). Admission knows only
        // the offering, not a model string (W08: the policy model string is gone).
        resolvedModel: null,
```

`routes/aiAgents.ts`: delete `model: row.model` from the DTO mapper (~L168). Schema: delete `model` from `db/schema/aiAgents.ts` (~L55) and `allowedModels` from `aiBudgets` in `db/schema/ai.ts` (~L217). In `services/aiModels/aiModelRegistry.contract.test.ts` delete the `'apps/api/src/db/schema/ai.ts'` entry from `MODEL_LITERAL_ALLOWLIST` (its only literal was that default).

Delete `model:` from web agent fixtures (`AiAgentForm.test.tsx` and any `aiAgents/**` test the grep finds) and from API test fixtures that `tsc` flags. `__tests__/integration/aiModelRegistryFixtures.ts`: `seedAgent` loses its `model` parameter and the `model` column in its raw `INSERT` (it is raw SQL, so `tsc` will not flag it, and after W08b's drop it would fail); update its callers.

`services/tenantExportPolicyRegistry.ts`: move `"model"` out of `ai_agents`' `included` into `"retiring": ["model"]`, and `"allowed_models"` out of `ai_budgets`' `excludedOpen` into `"retiring": ["allowed_models"]` (Task 8 added the group).

Manifest — append (`deprecatedIn` = W05's first release from Task 1 Step 1; `earliestRemovalDate` = that release's tag date):

```json
    {
      "id": "ai-agent-policy-model",
      "title": "The model string on AI agent policies retired",
      "kind": "api-request-field",
      "surfaces": [
        { "endpoint": "POST /api/v1/ai/agents", "fields": ["model"] },
        { "endpoint": "PATCH /api/v1/ai/agents/:id", "fields": ["model"] },
        { "endpoint": "POST /api/v1/ai/agents/preview", "fields": ["model"] }
      ],
      "replacement": "Send offeringId: the id of an enabled model from GET /api/v1/ai/models, permitted for the AI agents feature; null follows the AI agents default. Agent responses carry offeringId and no longer include model.",
      "deprecatedIn": "<W05's first release>",
      "deprecationBehaviour": "Translated: a model string was looked up and stored as the matching offering.",
      "earliestRemovalDate": "<that release's tag date>",
      "removedIn": "0.122.0",
      "removalBehaviour": "A request that includes model (any value, including null) is rejected with HTTP 400 naming offeringId. Nothing else in the request is applied.",
      "references": ["#7598", "#7603", "#7606"]
    }
```

- [ ] **Step 5: Run the tests**

Run:
```bash
cd packages/shared && npx vitest run src/validators/ src/types/ && npx tsc --noEmit; cd ../..
cd apps/api && npx vitest run src/services/aiAgents/ src/routes/aiAgents.test.ts src/services/fleetDesign/ src/upgrade/ src/services/aiModels/
npx tsc --noEmit -p tsconfig.json
cd ../web && npx vitest run src/components/settings/aiAgents && npx tsc --noEmit
```
Expected: PASS, including every `runLoop*.test.ts` and `effectivePolicy.ceiling.contract.test.ts`; 0 new type errors.

- [ ] **Step 6: Commit**

```bash
git add -A packages/shared apps/api apps/web/src/components/settings/aiAgents
git commit -m "feat(ai)!: retire the AI agent policy model string; agents bind by offeringId only (#7606)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docs and upgrade notes for R1

**Files:**
- Modify: `apps/docs/src/content/docs/features/bring-your-own-llm-key.mdx` (sections "Hosted: use your own Anthropic key", "Route your key through a platform-vetted endpoint", the self-hosted intro sentence and the precedence `Aside`; W06/W07 own the OpenAI-compatible and cloud sections of the same page — do not edit them)
- Modify: `apps/docs/src/content/docs/deploy/environment.mdx` (AI table)
- Modify: `apps/docs/src/content/docs/deploy/upgrades.mdx` (new "Next release" section under "Version-specific notes"; historical release sections are not edited)
- Modify: `apps/docs/src/content/docs/security/overview.mdx` (~L316), `README.md` (~L133, ~L367, ~L498)

**Interfaces:** none (docs). Use the `update-breeze-docs` skill's conventions; keep the page slug `features/bring-your-own-llm-key` (links point at it).

- [ ] **Step 1: Write the failing docs check**

Run:
```bash
grep -n -E "Optionally select a default model|Anthropic \(direct\)|Provider precedence is \*\*partner BYOK|BREEZE_AI_SCRIPT_REVIEWER_MODEL|WORKSPACE_CONTENT_LLM_MODEL|for AI assistant \(BYOK\)" \
  apps/docs/src/content/docs/features/bring-your-own-llm-key.mdx apps/docs/src/content/docs/deploy/environment.mdx
```
Expected: matches (the stale text this task replaces). Step 3's re-run must print nothing.

- [ ] **Step 2: Edit**

`features/bring-your-own-llm-key.mdx`:
- Front-matter `description`: "Connect a partner-owned Anthropic API key (directly or through a platform-vetted endpoint), choose which models each AI feature uses, or configure an instance-wide backend on a self-hosted deployment."
- Replace the intro bullet list and the sentence "If both are configured, a partner's BYOK configuration takes precedence…" with: "A partner's connections and per-feature defaults decide where each AI request goes. Instance environment variables seed the platform connection on a self-hosted deployment; they never override a partner's connection."
- Replace "### Connect a key" steps with:

```mdx
<Steps>

1. Open **Partner Settings → AI Providers & Models** and click **Add connection** in the **Connections** card.

2. Choose **Anthropic API key**, give the connection a name, and paste the key into the write-only field.

3. Click **Save** and complete MFA. Breeze verifies the key with Anthropic before storing it.

</Steps>

Your first Anthropic connection takes over every AI feature that was using the Breeze platform key (patch testing stays on the platform key). Pick a different model for any feature under **Defaults by feature**.
```

- Replace "To rotate the key, paste the replacement and save it…" and the Disconnect paragraph with: "To rotate a key, open the connection's drawer, paste the replacement and save; Breeze verifies it before replacing the stored key, so a failed verification leaves the working key in place. **Disconnect** (with MFA) moves the features that used this connection back to the same models on the Breeze platform key and removes the connection. Breeze never switches back on its own."
- In "### Route your key through a platform-vetted endpoint", replace step 1 with: "Open the connection's drawer in the **Connections** card and choose an **Endpoint**: Anthropic (direct) or one of the vetted endpoints. Breeze checks that the endpoint serves the model your **chat** feature uses before switching." Keep steps 2–4 and the cautions; replace "the endpoint card" wording with "the connection drawer" throughout the section.
- Self-hosted intro: replace "These settings apply across the instance, except for partners that have their own BYOK configuration." with "These settings configure the platform connection: the default model for new partners and the backend platform-key traffic goes to. A partner's own connection is never overridden by them."
- Replace the precedence `Aside` text with: "A partner's own connection always wins: features assigned to it never use the instance settings. The instance settings apply to features on the platform connection."

`deploy/environment.mdx` (AI table):
- `ANTHROPIC_API_KEY`: "The platform Anthropic API key (hosted: Breeze's key; self-hosted: yours). Partners can add their own key under AI Providers & Models."
- `ANTHROPIC_MODEL`: append "On a self-hosted deployment it is also the default model new partners start with; if the registry does not list it, Breeze adds it once at the documented conservative rate (see below)."
- Delete the `BREEZE_AI_SCRIPT_REVIEWER_MODEL` and `WORKSPACE_CONTENT_LLM_MODEL` rows.

`deploy/upgrades.mdx` — add at the top of "## Version-specific notes" (the release process renames "Next release" to the version):

```mdx
### Next release — legacy AI model settings removed

The AI model registry (AI Providers & Models) has been the only source of AI model decisions since the previous release. This release deletes what it replaced.

- **`/api/v1/ai/provider` is gone.** Use `/api/v1/ai/models`: `GET /ai/models`, `POST /ai/models/connections`, `POST /ai/models/connections/:id/key`, `POST /ai/models/connections/:id/endpoint`, `DELETE /ai/models/connections/:id`, and `PUT /ai/models/assignments` for per-feature defaults. Requests to the old paths return 404.
- **Retired request fields are rejected with HTTP 400** that names the field and its replacement: `reviewerModel` on both script-policy endpoints, `allowedModels` on the AI for Office organization policy, and `model` on AI agent create/update/preview (send `offeringId`). They were already ignored; a client that kept sending them now gets an error instead of a silent no-op. The GET responses no longer include them.
- **`BREEZE_AI_SCRIPT_REVIEWER_MODEL` and `WORKSPACE_CONTENT_LLM_MODEL` are no longer read.** Remove them from your `.env`. New partners start every feature on the platform default model (`ANTHROPIC_MODEL`, else the default set on Admin → AI models); change any feature under AI Providers & Models.
- **Skipping releases:** the one-time conversion of legacy AI settings into the registry ran only in the previous release. If you upgrade straight from an older release, each partner is set up from the platform default instead; a partner that had its own Anthropic key keeps using that key, but its legacy per-feature choices (script reviewer, AI for Office, AI agent allowlists) are not carried over. Set them again under AI Providers & Models. The next release archives the old values before it drops them (see the next section when it ships).
- **Database:** no schema change in this release. The legacy table and columns are dropped in the following release, after their values are archived.
```

`security/overview.mdx` (~L316): replace "BYOK mode: your API key, your data, your infrastructure" wording with "Your own provider connection: AI requests for the features you assign to it use your key and your provider account".

`README.md` (~L133, ~L367, ~L498): replace "BYOK" with "your own provider key" in those three sentences; do not change `CHANGELOG.md`.

- [ ] **Step 3: Verify**

Run:
```bash
grep -n -E "Optionally select a default model|Anthropic \(direct\)\*\* plus|Provider precedence is \*\*partner BYOK|BREEZE_AI_SCRIPT_REVIEWER_MODEL|WORKSPACE_CONTENT_LLM_MODEL|for AI assistant \(BYOK\)" \
  apps/docs/src/content/docs/features/bring-your-own-llm-key.mdx apps/docs/src/content/docs/deploy/environment.mdx
cd apps/docs && pnpm astro check && pnpm build
```
Expected: the grep prints nothing; `astro check` 0 errors; the build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/docs README.md
git commit -m "docs(ai): legacy AI model settings removed — connections, retired fields and env vars (#7606)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: W08a verification, review round and PR

**Files:** none new.

- [ ] **Step 1: The repo-wide reader sweep (must be empty)**

Run:
```bash
grep -rn -E "partner_llm_configs|partnerLlmConfigs|legacy_default_model|legacyDefaultModel|compat_uq|getCompatConnection|ownConnectionId" \
  apps/api/src apps/web/src apps/portal/src packages ee agent e2e-tests --include='*.ts' --include='*.tsx' --include='*.go' \
  | grep -v -E "\.test\.tsx?:|/__tests__/|partner_llm_configs\.api_key_encrypted|partner_ai_connections_compat_uq"
grep -rn -E "allowed_models|reviewer_model" apps/api/src --include='*.ts' | grep -v -E "\.test\.ts:|/__tests__/"
grep -rn "ai_model_registry_state\|aiModelRegistryState" apps/api/src --include='*.ts' | grep -v -E "\.test\.ts:|/__tests__/"
```
Expected: the first prints only `db/schema/aiModelRegistry.ts`'s `partner_ai_connections_compat_uq` declaration (Task 14) and comments that name the AAD tag; the second prints only the four `retiring` entries in `services/tenantExportPolicyRegistry.ts` (Tasks 8–9; they tolerate the column's absence); the third prints nothing. The Go agent never read any of these (it receives a resolved model per command), so `agent/` must be empty too.

- [ ] **Step 2: Full API unit suite, in batches**

Run (one at a time, generous timeout):
```bash
cd apps/api && npx vitest run src/services/aiModels src/services/aiAgents src/services/llm src/routes/aiModels src/routes/ai src/routes/clientAi
npx vitest run src/services src/routes src/upgrade src/config src/system src/db src/jobs src/__tests__
npx tsc --noEmit -p tsconfig.json && npx tsc --build tsconfig.tests.json
```
Expected: PASS (incl. `orgMerge`, `cascadeDelete`, `moveOrg.coverage`, `partner-wide-write-coverage`, `mcpCoverage`, `aiModelRegistry.contract`, `legacyRemoval.contract`, `envReadComposeCoverage`); 0 type errors.

- [ ] **Step 3: Web, shared, ee, docs**

Run:
```bash
cd apps/web && npx vitest run src/components/settings src/components/clientAi src/lib src/locales && npx tsc --noEmit
cd ../../packages/shared && npx vitest run && npx tsc --noEmit
cd ../../ee/workspace && npx vitest run
cd ../../apps/docs && pnpm astro check
```
Expected: PASS; web `tsc` shows only the pre-existing zod-resolver errors.

- [ ] **Step 4: Integration and RLS contracts**

Run:
```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/aiModel src/__tests__/integration/aiInvocation src/__tests__/integration/llmCatalogSelection \
  src/__tests__/integration/workspaceEnrichmentByok src/__tests__/integration/officeAddinAiAccounting \
  src/__tests__/integration/tenant-export-policy src/__tests__/integration/tenantCascade src/__tests__/integration/orgMergeRegistry
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm test-stack down
```
Expected: PASS. The export-policy and RLS suites still list the legacy columns and tables, because they still exist in the database (Code first, drop later).

- [ ] **Step 5: Review round**

Run one `/pr-review-toolkit:review-pr` round with a Sonnet or Opus reviewer (routing and funding code: Tasks 2 and 4). Ask it to check specifically: Review Focus 1–3 and 5; that no R1 code names a W08b drop target (Step 1); that every retired request field is rejected, not stripped; and that `ensurePartnerCutover`'s contract is unchanged for W05/W06 callers. Fix confirmed, consequential findings only; re-review only if a fix touched Task 2 or Task 4 code.

- [ ] **Step 6: Open the PR**

Branch `feature/7598-ai-model-registry/wave-7606`, target `main`. Title: `feat(ai)!: model registry W08a — legacy AI model configuration removed (#7606)`. Body:
- `Part of #7606` (not `Closes`: W08b closes the wave) and `Part of #7598`;
- the derived R0/R1/R2 and W05 release (Task 1 Step 1), and every Preconditions difference;
- "G1 passed on EU and US at <UTC>" (no counts) — **do not enqueue before G1**;
- the retired surfaces and their manifest ids; the bootstrap decision (D2, D3) and the skipped-upgrade behaviour; the step-up note from Task 8;
- the test evidence from Steps 2–4 and the review outcome.

Do not merge; Todd enqueues it.

- [ ] **Step 7: After R1 is deployed (Todd)**

On EU and US: open AI chat as a platform-funded partner and as a BYOK partner; open Partner Settings → AI Providers & Models and rotate a test connection's key on a lab partner; confirm `/api/v1/ai/provider` returns 404; confirm the API logs show no `ai_registry_bootstrap_existing_connection` event (hosted partners were all cut over in R0, so any such event means G1 missed one). Record the result on #7606.

---

# Part B — W08b: archive and drop (PR 2, release R2 ≥ R1 + 1)

Start only after R1 is deployed on both regions. Cut `feature/7598-ai-model-registry/wave-7606-drop` from `main` (which contains W08a).

### Task 12: Gate G2 and the migration slot

**Files:** none (operator gate).

- [ ] **Step 1: TODD GATE G2 — run the preflight against R1 on EU and US**

Same command as Task 1 Step 7. PASS when `blocking_uncut_with_legacy` is empty on both regions. Record privately: every `counts` row and the `unrepresented_models` rows — Task 15 Step 3 compares the archive against them. Todd approves the destructive drop on #7606 ("G2 approved") and confirms a fresh managed-database backup / point-in-time-restore window covers the deploy.

- [ ] **Step 2: Confirm the migration name sorts last**

Run:
```bash
git fetch origin main
git ls-tree --name-only origin/main apps/api/migrations/ | grep -E '/[0-9]{4}-' | sort | tail -3
```
Expected: nothing sorts after `2026-11-28-100000`. If something does, use a later `YYYY-MM-DD-HHMMSS` that sorts after it (slug unchanged) everywhere Tasks 13–15 name the file.

---

### Task 13: Archive, then drop — the migration and its registrations

**Files:**
- Create: `apps/api/migrations/2026-11-28-100000-ai-model-registry-legacy-drop.sql`
- Create: `apps/api/src/db/schema/aiModelRegistryLegacyArchive.ts`; modify `db/schema/index.ts`
- Create: `apps/api/src/__tests__/integration/fixtures/aiModelRegistryLegacyConfig.ts`
- Create: `apps/api/src/__tests__/integration/aiModelRegistryLegacyDrop.integration.test.ts`
- Delete: `apps/api/src/__tests__/integration/aiModelRegistryLegacyPreflight.integration.test.ts` (it reads objects this migration drops; the SQL file stays as history)
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`), `services/orgMergeRegistry.ts`, `services/tenantExportPolicyRegistry.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/aiModelRegistryForgery.integration.test.ts` (any remaining case naming a dropped object)

**Interfaces:**
- Produces: table `ai_model_registry_legacy_archive` (shape 3; columns below); Drizzle `aiModelRegistryLegacyArchive`; test fixture `RESTORE_AI_MODEL_LEGACY_CONFIG_SQL`.
- Drops: table `partner_llm_configs` (and its policy `partner_llm_configs_system_only`), table `ai_model_registry_state`, column `partner_ai_connections.legacy_default_model`, columns `ai_script_policies.reviewer_model`, `client_ai_org_policies.allowed_models`, `ai_budgets.allowed_models` and `ai_agents.model` (omit these two if Task 9 moved to W08c), index `partner_ai_connections_compat_uq`.

Archive shape (one row per legacy value; `value` holds the raw value, never key material):

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `partner_id` | uuid NOT NULL → `partners(id)` | RLS axis |
| `org_id` | uuid NULL | org rows only; composite FK `(org_id, partner_id) → organizations(id, partner_id)` ON DELETE CASCADE, DEFERRABLE INITIALLY IMMEDIATE |
| `source_table` | text CHECK in (`partner_llm_configs`, `partner_ai_connections`, `ai_budgets`, `ai_script_policies`, `client_ai_org_policies`, `ai_agents`) | |
| `source_id` | uuid NOT NULL | the source row's id |
| `source_column` | text NOT NULL | `row` (non-secret snapshot of a `partner_llm_configs` row), else the dropped column's name |
| `value` | jsonb NOT NULL | export `excludedOpen` |
| `had_cutover` | boolean NOT NULL | whether the partner had its registry row at archive time (false = its legacy value was never projected) |
| `archived_at` | timestamptz NOT NULL default now() | |
| | UNIQUE (`source_table`, `source_id`, `source_column`) | idempotent re-apply |

- [ ] **Step 1: Write the fixture that restores the legacy objects inside a rolled-back transaction**

```ts
// apps/api/src/__tests__/integration/fixtures/aiModelRegistryLegacyConfig.ts
/**
 * Recreates, inside a test transaction that is rolled back, exactly the legacy
 * objects 2026-11-28-100000-ai-model-registry-legacy-drop.sql drops, so the
 * migration can be exercised against seeded legacy data. Column shapes follow
 * the shipped migrations that created them (2026-09-04-partner-llm-configs.sql,
 * 2026-11-14-100000-ai-model-registry-connections.sql, 0001-baseline.sql,
 * 2026-10-16-120200-ai-script-policies.sql, 2026-06-12-b-client-ai-foundation.sql,
 * 2026-09-02-ai-agents.sql, 2026-11-19-100400-ai-model-registry-cutover.sql).
 */
export const RESTORE_AI_MODEL_LEGACY_CONFIG_SQL = `
CREATE TABLE IF NOT EXISTS public.partner_llm_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'anthropic',
  api_key_encrypted text NOT NULL,
  key_last4 text NOT NULL,
  key_fingerprint text NOT NULL,
  base_url text,
  default_model text,
  catalog_entry_id uuid,
  status text NOT NULL DEFAULT 'active',
  config_version integer NOT NULL DEFAULT 1,
  last_error text,
  verified_at timestamptz,
  connected_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Same posture as production (2026-11-14-100000: one system-only policy, FORCE RLS),
-- so the scope-election test runs as breeze_app against the real shape.
ALTER TABLE public.partner_llm_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_llm_configs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS partner_llm_configs_system_only ON public.partner_llm_configs;
CREATE POLICY partner_llm_configs_system_only ON public.partner_llm_configs
  FOR ALL USING (public.breeze_current_scope() = 'system') WITH CHECK (public.breeze_current_scope() = 'system');
GRANT SELECT, INSERT, UPDATE, DELETE ON public.partner_llm_configs TO breeze_app;
ALTER TABLE public.partner_ai_connections ADD COLUMN IF NOT EXISTS legacy_default_model text;
CREATE UNIQUE INDEX IF NOT EXISTS partner_ai_connections_compat_uq
  ON public.partner_ai_connections (partner_id) WHERE kind IN ('anthropic_byok', 'catalog');
ALTER TABLE public.ai_budgets ADD COLUMN IF NOT EXISTS allowed_models jsonb DEFAULT '["claude-sonnet-4-5-20250929"]'::jsonb;
ALTER TABLE public.ai_script_policies ADD COLUMN IF NOT EXISTS reviewer_model varchar(200);
ALTER TABLE public.client_ai_org_policies ADD COLUMN IF NOT EXISTS allowed_models jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.ai_agents ADD COLUMN IF NOT EXISTS model varchar(100);
CREATE TABLE IF NOT EXISTS public.ai_model_registry_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cutover_completed_at timestamptz NULL,
  lease_owner text NULL,
  lease_expires_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_model_registry_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_model_registry_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_model_registry_state_system_only ON public.ai_model_registry_state;
CREATE POLICY ai_model_registry_state_system_only ON public.ai_model_registry_state
  FOR ALL USING (public.breeze_current_scope() = 'system') WITH CHECK (public.breeze_current_scope() = 'system');
GRANT SELECT, UPDATE ON public.ai_model_registry_state TO breeze_app;
INSERT INTO public.ai_model_registry_state (id, cutover_completed_at) VALUES (1, now()) ON CONFLICT (id) DO NOTHING;
`;
```

Check each column type against the shipped migration named in the header before relying on it (for example `reviewer_model`'s length); the restore must match what a production database has.

- [ ] **Step 2: Write the failing integration test**

```ts
// apps/api/src/__tests__/integration/aiModelRegistryLegacyDrop.integration.test.ts
/**
 * AI model registry W08b (#7606): archive, then drop, the legacy AI model config.
 * Every migration case runs inside ONE postgres.js transaction that is rolled
 * back (same harness as legacyLabourPricingDrop.integration.test.ts).
 *  - every legacy value that exists is archived (never key material), then the
 *    objects are dropped; counts are reported; a re-apply is a no-op;
 *  - a partial set (a column already gone) is archived column by column and
 *    never refused (#6472: no boot refusal);
 *  - the archive insert sees rows under FORCE RLS only because it elects
 *    system scope;
 *  - the archive is partner-axis: a partner sees only its rows, an org token
 *    none, and a cross-partner forge fails 42501.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { createOrganization, createPartner, createUser } from './db-utils';
import { RESTORE_AI_MODEL_LEGACY_CONFIG_SQL } from './fixtures/aiModelRegistryLegacyConfig';

const MIGRATION = '2026-11-28-100000-ai-model-registry-legacy-drop.sql';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
type Tx = postgres.TransactionSql<Record<string, unknown>>;
class Rollback extends Error { constructor() { super('intentional rollback'); } }

const loadMigration = () => readFile(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), 'utf8');

async function inRolledBackTx(body: (tx: Tx, notices: string[]) => Promise<void>): Promise<void> {
  const notices: string[] = [];
  const client = postgres(DATABASE_URL, { max: 1, onnotice: (n) => { notices.push(n.message ?? ''); } });
  try {
    await client.begin(async (tx) => { await body(tx as unknown as Tx, notices); throw new Rollback(); });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  } finally {
    await client.end({ timeout: 1 });
  }
}

const legacyObjects = async (tx: Tx) => (await tx`SELECT
    to_regclass('public.partner_llm_configs') IS NOT NULL AS llm_configs,
    to_regclass('public.ai_model_registry_state') IS NOT NULL AS state,
    to_regclass('public.partner_ai_connections_compat_uq') IS NOT NULL AS compat_uq,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'public' AND (
      (table_name = 'partner_ai_connections' AND column_name = 'legacy_default_model') OR
      (table_name = 'ai_budgets' AND column_name = 'allowed_models') OR
      (table_name = 'ai_script_policies' AND column_name = 'reviewer_model') OR
      (table_name = 'client_ai_org_policies' AND column_name = 'allowed_models') OR
      (table_name = 'ai_agents' AND column_name = 'model'))) AS columns`)[0]!;

/** Committed tenant (the archive rows reference it; the shared setup truncates partners between tests). */
async function committedTenant(): Promise<{ partnerId: string; orgId: string; userId: string }> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id });
  return { partnerId: partner.id, orgId: org.id, userId: user.id };
}

/** Legacy values, written inside the rolled-back transaction. */
async function seed(tx: Tx, t: { partnerId: string; orgId: string; userId: string }) {
  const legacyId = randomUUID();
  const agentId = randomUUID();
  await tx`INSERT INTO partner_llm_configs (id, partner_id, api_key_encrypted, key_last4, key_fingerprint, default_model)
    VALUES (${legacyId}, ${t.partnerId}, 'enc:v1:SECRET-CIPHERTEXT', 'abcd', 'FINGERPRINT', 'claude-legacy-default')`;
  await tx`INSERT INTO ai_budgets (org_id, allowed_models) VALUES (${t.orgId}, '["claude-a","claude-b"]'::jsonb)`;
  await tx`INSERT INTO ai_script_policies (org_id, reviewer_model, created_by) VALUES (${t.orgId}, 'claude-reviewer', ${t.userId})`;
  await tx`INSERT INTO client_ai_org_policies (org_id, allowed_models) VALUES (${t.orgId}, '["claude-office"]'::jsonb)`;
  await tx`INSERT INTO ai_agents (id, partner_id, kind, name, model, created_by, last_updated_by)
    VALUES (${agentId}, ${t.partnerId}, 'triage', 'Triage', 'claude-agent', ${t.userId}, ${t.userId})`;
  return { ...t, legacyId, agentId };
}

describe('archive then drop the legacy AI model config (#7606 W08b)', () => {
  it('archives every legacy value (never key material), then drops the objects', async () => {
    const migration = await loadMigration();
    const tenant = await committedTenant();
    await inRolledBackTx(async (tx, notices) => {
      await tx`SELECT set_config('breeze.scope', 'system', true)`;
      await tx.unsafe(RESTORE_AI_MODEL_LEGACY_CONFIG_SQL);
      const s = await seed(tx, tenant);
      await tx.unsafe(migration);

      expect(await legacyObjects(tx)).toEqual({ llm_configs: false, state: false, compat_uq: false, columns: 0 });
      const rows = await tx`SELECT source_table, source_column, org_id, value, had_cutover
        FROM ai_model_registry_legacy_archive WHERE partner_id = ${s.partnerId} ORDER BY source_table, source_column`;
      expect(rows.map((r) => `${r.source_table}.${r.source_column}`)).toEqual([
        'ai_agents.model', 'ai_budgets.allowed_models', 'ai_script_policies.reviewer_model',
        'client_ai_org_policies.allowed_models', 'partner_llm_configs.row',
      ]);
      const llm = rows.find((r) => r.source_table === 'partner_llm_configs')!;
      expect(llm.value).toMatchObject({ default_model: 'claude-legacy-default', key_last4: 'abcd', in_registry: false });
      expect(JSON.stringify(llm.value)).not.toMatch(/SECRET-CIPHERTEXT|FINGERPRINT/);
      expect(rows.find((r) => r.source_table === 'ai_budgets')).toMatchObject({ org_id: s.orgId, value: ['claude-a', 'claude-b'], had_cutover: false });
      expect(notices).toContainEqual(expect.stringContaining('archived 1 partner_llm_configs row(s)'));
      expect(notices).toContainEqual(expect.stringContaining('partner(s) held legacy AI model config without a registry row'));
      expect(notices).toContainEqual(expect.stringContaining('legacy AI model config dropped'));

      notices.length = 0;
      await tx.unsafe(migration);
      const [again] = await tx`SELECT count(*)::int AS n FROM ai_model_registry_legacy_archive WHERE partner_id = ${s.partnerId}`;
      expect(again!.n).toBe(5);
      expect(notices).toContainEqual(expect.stringContaining('partner_llm_configs already dropped'));
    });
  });

  it('a column already dropped by hand is skipped, the rest archived — never refused', async () => {
    const migration = await loadMigration();
    const tenant = await committedTenant();
    await inRolledBackTx(async (tx) => {
      await tx`SELECT set_config('breeze.scope', 'system', true)`;
      await tx.unsafe(RESTORE_AI_MODEL_LEGACY_CONFIG_SQL);
      const s = await seed(tx, tenant);
      await tx.unsafe('ALTER TABLE ai_script_policies DROP COLUMN reviewer_model');
      await expect(tx.unsafe(migration)).resolves.toBeDefined();
      const [n] = await tx`SELECT count(*)::int AS n FROM ai_model_registry_legacy_archive WHERE partner_id = ${s.partnerId}`;
      expect(n!.n).toBe(4);
      expect(await legacyObjects(tx)).toMatchObject({ columns: 0 });
    });
  });

  it('the archive insert sees rows under FORCE RLS only because it elects system scope', async () => {
    const migration = await loadMigration();
    const tenant = await committedTenant();
    const block = migration.match(/-- 3\) Archive[\s\S]*?END \$\$;/)?.[0];
    expect(block, 'archive block not found').toBeDefined();
    const election = "PERFORM set_config('breeze.scope', 'system', true);";
    expect(block).toContain(election);
    const archiveDdl = migration.match(/-- 2\) The archive table[\s\S]*?-- 3\) Archive/)?.[0]?.replace('-- 3) Archive', '');
    // Without the election, breeze_app archives nothing (fail-open the election closes).
    await inRolledBackTx(async (tx) => {
      await tx`SELECT set_config('breeze.scope', 'system', true)`;
      await tx.unsafe(RESTORE_AI_MODEL_LEGACY_CONFIG_SQL);
      await tx.unsafe(archiveDdl!);
      const s = await seed(tx, tenant);
      await tx.unsafe('SET LOCAL ROLE breeze_app');
      await tx`SELECT set_config('breeze.scope', 'none', true)`;
      await tx.unsafe(block!.replace(election, ''));
      await tx`SELECT set_config('breeze.scope', 'system', true)`;
      const [none] = await tx`SELECT count(*)::int AS n FROM ai_model_registry_legacy_archive WHERE partner_id = ${s.partnerId}`;
      expect(none!.n).toBe(0);
    });
    await inRolledBackTx(async (tx) => {
      await tx`SELECT set_config('breeze.scope', 'system', true)`;
      await tx.unsafe(RESTORE_AI_MODEL_LEGACY_CONFIG_SQL);
      await tx.unsafe(archiveDdl!);
      const s = await seed(tx, tenant);
      await tx.unsafe('SET LOCAL ROLE breeze_app');
      await tx`SELECT set_config('breeze.scope', 'none', true)`;
      await tx.unsafe(block!);
      await tx`SELECT set_config('breeze.scope', 'system', true)`;
      const [some] = await tx`SELECT count(*)::int AS n FROM ai_model_registry_legacy_archive WHERE partner_id = ${s.partnerId}`;
      expect(some!.n).toBe(5);
    });
  });
});

describe('ai_model_registry_legacy_archive — partner-axis RLS', () => {
  const partnerA = randomUUID();
  const partnerB = randomUUID();
  const orgA = randomUUID();
  const partnerContext = (partnerId: string): DbAccessContext => ({
    scope: 'partner', orgId: null, accessibleOrgIds: [orgA], accessiblePartnerIds: [partnerId], currentPartnerId: partnerId, userId: null,
  });
  const orgContext: DbAccessContext = {
    scope: 'organization', orgId: orgA, accessibleOrgIds: [orgA], accessiblePartnerIds: [], currentPartnerId: partnerA, userId: null,
  };

  beforeEach(async () => {
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`INSERT INTO partners (id, name, slug, currency_code) VALUES
        (${partnerA}, 'Archive A', ${`w08b-a-${partnerA}`}, 'USD'), (${partnerB}, 'Archive B', ${`w08b-b-${partnerB}`}, 'USD')`);
      await db.execute(sql`INSERT INTO organizations (id, partner_id, name, slug, currency_code) VALUES (${orgA}, ${partnerA}, 'Archive org', ${`w08b-org-${orgA}`}, 'USD')`);
      await db.execute(sql`INSERT INTO ai_model_registry_legacy_archive (partner_id, org_id, source_table, source_id, source_column, value, had_cutover) VALUES
        (${partnerA}, NULL, 'partner_llm_configs', ${randomUUID()}, 'row', '{}'::jsonb, true),
        (${partnerA}, ${orgA}, 'ai_budgets', ${randomUUID()}, 'allowed_models', '[]'::jsonb, true)`);
    });
  });

  afterAll(async () => {
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`DELETE FROM ai_model_registry_legacy_archive WHERE partner_id IN (${partnerA}, ${partnerB})`);
      await db.execute(sql`DELETE FROM organizations WHERE partner_id IN (${partnerA}, ${partnerB})`);
      await db.execute(sql`DELETE FROM partners WHERE id IN (${partnerA}, ${partnerB})`);
    });
  });

  const visible = (ctx: DbAccessContext) => withDbAccessContext(ctx, async () =>
    ((await db.execute(sql`SELECT count(*)::int AS n FROM ai_model_registry_legacy_archive
      WHERE partner_id IN (${partnerA}, ${partnerB})`)) as unknown as Array<{ n: number }>)[0]!.n);

  it('partner A sees its rows; partner B and an org token see none', async () => {
    expect(await visible(partnerContext(partnerA))).toBe(2);
    expect(await visible(partnerContext(partnerB))).toBe(0);
    expect(await visible(orgContext)).toBe(0);
  });

  it("partner B cannot forge a row into partner A's archive (42501)", async () => {
    await expect(withDbAccessContext(partnerContext(partnerB), () => db.execute(sql`
      INSERT INTO ai_model_registry_legacy_archive (partner_id, source_table, source_id, source_column, value, had_cutover)
      VALUES (${partnerA}, 'ai_agents', ${randomUUID()}, 'model', '"x"'::jsonb, true)`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
```

(If the live `ai_agents` / `ai_budgets` / `ai_script_policies` / `client_ai_org_policies` tables need more NOT NULL columns than `seed` supplies, add them from the table's Drizzle definition; do not loosen the migration.)

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm test-stack up && cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelRegistryLegacyDrop.integration.test.ts`
Expected: FAIL — `ENOENT … 2026-11-28-100000-ai-model-registry-legacy-drop.sql`.

- [ ] **Step 4: Write the migration**

```sql
-- AI model registry W08b (#7606): archive, then drop, the legacy AI model
-- configuration. One release after W08a deleted every reader (#6472: code
-- first, drop later — an N-1 rollback window).
--
-- Drops: partner_llm_configs (table), ai_model_registry_state (W03 sweep
-- singleton), partner_ai_connections.legacy_default_model,
-- partner_ai_connections_compat_uq, ai_budgets.allowed_models,
-- ai_script_policies.reviewer_model, client_ai_org_policies.allowed_models,
-- ai_agents.model.
--
-- ARCHIVE BEFORE DROP, NEVER REFUSE. Every legacy value that still exists is
-- copied into ai_model_registry_legacy_archive first (a full snapshot, not only
-- values the registry lacks), keyed (source_table, source_id, source_column),
-- so a re-apply is a no-op. Per #6472 nothing here raises on tenant data:
-- partners that held legacy config without a registry row are COUNTED in a
-- warning (their values are in the archive), and a column already dropped by
-- hand is skipped, not refused. The only RAISE EXCEPTION is the final proof.
--
-- partner_llm_configs.api_key_encrypted and key_fingerprint are NOT archived
-- (W08 D8): live keys are in partner_ai_connections (same id, same AAD tag);
-- what remains in the legacy table is a frozen copy, including keys partners
-- have since disconnected, and destroying it is the point.
--
-- The archive is partner-axis (shape 3) like legacy_labour_pricing_archive:
-- org_id is metadata on org-level rows, for the cascade / merge / export
-- contracts. Registered in CORE_ORG_CASCADE_DELETE_ORDER, orgMergeRegistry
-- (repoint), CORE_TENANT_EXPORT_POLICY (value → excludedOpen) and, in
-- rls-coverage, ORG_AXIS_POLICY_EXCLUDED_TABLES + PARTNER_TENANT_TABLES.
--
-- WRITES ROWS (the archive): system scope is elected first, at file level and
-- inside each DO block. FORCE RLS binds the migration role too; without it the
-- archive inserts match zero rows and the counts read 0 (fail-open).
--
-- No named constraint is touched with ALTER ... CONSTRAINT on an existing
-- table: replayMigration re-runs later migrations that touch a constraint name
-- a replayed file touches. DROP COLUMN / DROP INDEX / DROP TABLE are not in
-- that closure. autoMigrate wraps this file in a transaction — no BEGIN/COMMIT.
SELECT set_config('breeze.scope', 'system', true);

-- 1) Report partners whose legacy config was never projected (never refuse).
DO $$
DECLARE uncut integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  IF to_regclass('public.partner_llm_configs') IS NULL THEN
    RAISE WARNING 'AI model registry W08b: legacy objects already dropped; nothing to report';
    RETURN;
  END IF;
  SELECT count(DISTINCT c.partner_id) INTO uncut
    FROM public.partner_llm_configs c
   WHERE NOT EXISTS (SELECT 1 FROM public.ai_model_registry_partner_cutover k WHERE k.partner_id = c.partner_id);
  RAISE WARNING 'AI model registry W08b: % partner(s) held legacy AI model config without a registry row (values archived below)', uncut;
END $$;

-- 2) The archive table (partner axis, RLS in the same migration).
CREATE TABLE IF NOT EXISTS public.ai_model_registry_legacy_archive (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.partners(id),
  org_id uuid,
  source_table text NOT NULL,
  source_id uuid NOT NULL,
  source_column text NOT NULL,
  value jsonb NOT NULL,
  had_cutover boolean NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_model_registry_legacy_archive_source_table_chk CHECK (source_table IN (
    'partner_llm_configs', 'partner_ai_connections', 'ai_budgets', 'ai_script_policies', 'client_ai_org_policies', 'ai_agents')),
  CONSTRAINT ai_model_registry_legacy_archive_source_uniq UNIQUE (source_table, source_id, source_column)
);

-- ON DELETE CASCADE as well as the cascade-list registration (Step 5): R1 code
-- does not know this table, so after an R2 -> R1 rollback an org erasure on the
-- R1 image must not abort on it (Codex review finding 2). Deferrable for the
-- org-merge contract (SET CONSTRAINTS ALL DEFERRED).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_model_registry_legacy_archive_org_partner_fk') THEN
    ALTER TABLE public.ai_model_registry_legacy_archive ADD CONSTRAINT ai_model_registry_legacy_archive_org_partner_fk
      FOREIGN KEY (org_id, partner_id) REFERENCES public.organizations (id, partner_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ai_model_registry_legacy_archive_partner_idx ON public.ai_model_registry_legacy_archive (partner_id);
CREATE INDEX IF NOT EXISTS ai_model_registry_legacy_archive_org_idx ON public.ai_model_registry_legacy_archive (org_id) WHERE org_id IS NOT NULL;

ALTER TABLE public.ai_model_registry_legacy_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_model_registry_legacy_archive FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public'
      AND tablename = 'ai_model_registry_legacy_archive' AND policyname = 'ai_model_registry_legacy_archive_partner_access'
  ) THEN
    -- No TO clause (as partner_ai_connections, 2026-11-14-100000): a role-scoped
    -- policy leaves a non-BYPASSRLS migration owner with NO applicable policy
    -- under FORCE RLS, so even with system scope elected the archive insert
    -- below would be refused. Table GRANTs restrict who reaches the table.
    CREATE POLICY ai_model_registry_legacy_archive_partner_access ON public.ai_model_registry_legacy_archive
      FOR ALL
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_model_registry_legacy_archive TO breeze_app;

-- 3) Archive every legacy value that still exists. Each source is guarded on
--    its own table/column, so a partial set is archived column by column.
--    Dynamic SQL (EXECUTE) because a branch's static SQL would fail to plan
--    when its column is already gone.
DO $$
DECLARE n bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  IF to_regclass('public.partner_llm_configs') IS NOT NULL THEN
    EXECUTE $q$
      INSERT INTO public.ai_model_registry_legacy_archive (partner_id, org_id, source_table, source_id, source_column, value, had_cutover)
      SELECT c.partner_id, NULL, 'partner_llm_configs', c.id, 'row',
             jsonb_build_object(
               'provider', c.provider, 'key_last4', c.key_last4, 'default_model', c.default_model,
               'catalog_entry_id', c.catalog_entry_id, 'status', c.status, 'config_version', c.config_version,
               'last_error', c.last_error, 'verified_at', c.verified_at, 'connected_by', c.connected_by,
               'created_at', c.created_at, 'updated_at', c.updated_at,
               'in_registry', EXISTS (SELECT 1 FROM public.partner_ai_connections k WHERE k.id = c.id)),
             EXISTS (SELECT 1 FROM public.ai_model_registry_partner_cutover u WHERE u.partner_id = c.partner_id)
        FROM public.partner_llm_configs c
      ON CONFLICT (source_table, source_id, source_column) DO NOTHING $q$;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE WARNING 'AI model registry W08b: archived % partner_llm_configs row(s)', n;
  ELSE
    RAISE WARNING 'AI model registry W08b: partner_llm_configs already dropped; archived 0';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'partner_ai_connections' AND column_name = 'legacy_default_model') THEN
    EXECUTE $q$
      INSERT INTO public.ai_model_registry_legacy_archive (partner_id, org_id, source_table, source_id, source_column, value, had_cutover)
      SELECT k.partner_id, NULL, 'partner_ai_connections', k.id, 'legacy_default_model', to_jsonb(k.legacy_default_model),
             EXISTS (SELECT 1 FROM public.ai_model_registry_partner_cutover u WHERE u.partner_id = k.partner_id)
        FROM public.partner_ai_connections k WHERE k.legacy_default_model IS NOT NULL
      ON CONFLICT (source_table, source_id, source_column) DO NOTHING $q$;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE WARNING 'AI model registry W08b: archived % partner_ai_connections.legacy_default_model value(s)', n;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'ai_budgets' AND column_name = 'allowed_models') THEN
    EXECUTE $q$
      INSERT INTO public.ai_model_registry_legacy_archive (partner_id, org_id, source_table, source_id, source_column, value, had_cutover)
      SELECT o.partner_id, b.org_id, 'ai_budgets', b.id, 'allowed_models', b.allowed_models,
             EXISTS (SELECT 1 FROM public.ai_model_registry_partner_cutover u WHERE u.partner_id = o.partner_id)
        FROM public.ai_budgets b JOIN public.organizations o ON o.id = b.org_id
       WHERE b.allowed_models IS NOT NULL
      ON CONFLICT (source_table, source_id, source_column) DO NOTHING $q$;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE WARNING 'AI model registry W08b: archived % ai_budgets.allowed_models value(s)', n;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'ai_script_policies' AND column_name = 'reviewer_model') THEN
    EXECUTE $q$
      INSERT INTO public.ai_model_registry_legacy_archive (partner_id, org_id, source_table, source_id, source_column, value, had_cutover)
      SELECT COALESCE(sp.partner_id, o.partner_id), sp.org_id, 'ai_script_policies', sp.id, 'reviewer_model', to_jsonb(sp.reviewer_model),
             EXISTS (SELECT 1 FROM public.ai_model_registry_partner_cutover u WHERE u.partner_id = COALESCE(sp.partner_id, o.partner_id))
        FROM public.ai_script_policies sp LEFT JOIN public.organizations o ON o.id = sp.org_id
       WHERE sp.reviewer_model IS NOT NULL AND COALESCE(sp.partner_id, o.partner_id) IS NOT NULL
      ON CONFLICT (source_table, source_id, source_column) DO NOTHING $q$;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE WARNING 'AI model registry W08b: archived % ai_script_policies.reviewer_model value(s)', n;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'client_ai_org_policies' AND column_name = 'allowed_models') THEN
    EXECUTE $q$
      INSERT INTO public.ai_model_registry_legacy_archive (partner_id, org_id, source_table, source_id, source_column, value, had_cutover)
      SELECT o.partner_id, p.org_id, 'client_ai_org_policies', p.id, 'allowed_models', p.allowed_models,
             EXISTS (SELECT 1 FROM public.ai_model_registry_partner_cutover u WHERE u.partner_id = o.partner_id)
        FROM public.client_ai_org_policies p JOIN public.organizations o ON o.id = p.org_id
       WHERE p.allowed_models IS NOT NULL AND p.allowed_models <> '[]'::jsonb
      ON CONFLICT (source_table, source_id, source_column) DO NOTHING $q$;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE WARNING 'AI model registry W08b: archived % client_ai_org_policies.allowed_models value(s)', n;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'ai_agents' AND column_name = 'model') THEN
    EXECUTE $q$
      INSERT INTO public.ai_model_registry_legacy_archive (partner_id, org_id, source_table, source_id, source_column, value, had_cutover)
      SELECT COALESCE(a.partner_id, o.partner_id), a.org_id, 'ai_agents', a.id, 'model',
             jsonb_build_object('model', a.model, 'offering_id', a.offering_id, 'disabled_at', a.disabled_at),
             EXISTS (SELECT 1 FROM public.ai_model_registry_partner_cutover u WHERE u.partner_id = COALESCE(a.partner_id, o.partner_id))
        FROM public.ai_agents a LEFT JOIN public.organizations o ON o.id = a.org_id
       WHERE a.model IS NOT NULL AND COALESCE(a.partner_id, o.partner_id) IS NOT NULL
      ON CONFLICT (source_table, source_id, source_column) DO NOTHING $q$;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE WARNING 'AI model registry W08b: archived % ai_agents.model value(s)', n;
  END IF;
END $$;

-- 4) Record the W03 sweep's completion stamp, then drop everything.
DO $$
DECLARE stamp timestamptz;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  IF to_regclass('public.ai_model_registry_state') IS NOT NULL THEN
    EXECUTE 'SELECT cutover_completed_at FROM public.ai_model_registry_state WHERE id = 1' INTO stamp;
    RAISE WARNING 'AI model registry W08b: dropping ai_model_registry_state (cutover_completed_at = %)', stamp;
  END IF;
END $$;

DROP INDEX IF EXISTS public.partner_ai_connections_compat_uq;
ALTER TABLE public.partner_ai_connections DROP COLUMN IF EXISTS legacy_default_model;
ALTER TABLE public.ai_budgets DROP COLUMN IF EXISTS allowed_models;
ALTER TABLE public.ai_script_policies DROP COLUMN IF EXISTS reviewer_model;
ALTER TABLE public.client_ai_org_policies DROP COLUMN IF EXISTS allowed_models;
ALTER TABLE public.ai_agents DROP COLUMN IF EXISTS model;
DROP TABLE IF EXISTS public.partner_llm_configs;
DROP TABLE IF EXISTS public.ai_model_registry_state;

-- 5) Prove it.
DO $$
DECLARE remaining integer;
BEGIN
  SELECT count(*) INTO remaining FROM information_schema.columns WHERE table_schema = 'public' AND (
    (table_name = 'partner_ai_connections' AND column_name = 'legacy_default_model') OR
    (table_name = 'ai_budgets' AND column_name = 'allowed_models') OR
    (table_name = 'ai_script_policies' AND column_name = 'reviewer_model') OR
    (table_name = 'client_ai_org_policies' AND column_name = 'allowed_models') OR
    (table_name = 'ai_agents' AND column_name = 'model'));
  IF remaining <> 0
     OR to_regclass('public.partner_llm_configs') IS NOT NULL
     OR to_regclass('public.ai_model_registry_state') IS NOT NULL
     OR to_regclass('public.partner_ai_connections_compat_uq') IS NOT NULL THEN
    RAISE EXCEPTION 'AI model registry W08b: a legacy object survived the drop (% column(s))', remaining;
  END IF;
  RAISE WARNING 'AI model registry W08b: legacy AI model config dropped';
END $$;
```

If Task 9 moved to W08c, delete the `ai_agents` and `ai_budgets` archive branches, both `DROP COLUMN` lines (`ai_agents.model`, `ai_budgets.allowed_models`) and their clauses in the proof (W08c's own migration archives and drops them later), and the two rows from the test's expected list.

- [ ] **Step 5: Drizzle schema and registrations**

```ts
// apps/api/src/db/schema/aiModelRegistryLegacyArchive.ts
import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { partners } from './orgs';

/**
 * Snapshot of the legacy AI model configuration dropped by AI model registry
 * W08b (#7606). Partner axis (shape 3); org_id is metadata on org-level rows.
 * Never holds key material. Read-only history: nothing in the app writes it.
 */
export const aiModelRegistryLegacyArchive = pgTable('ai_model_registry_legacy_archive', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id'),
  sourceTable: text('source_table').notNull(),
  sourceId: uuid('source_id').notNull(),
  sourceColumn: text('source_column').notNull(),
  value: jsonb('value').notNull(),
  hadCutover: boolean('had_cutover').notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('ai_model_registry_legacy_archive_source_uniq').on(t.sourceTable, t.sourceId, t.sourceColumn),
  check('ai_model_registry_legacy_archive_source_table_chk', sql`${t.sourceTable} IN ('partner_llm_configs', 'partner_ai_connections', 'ai_budgets', 'ai_script_policies', 'client_ai_org_policies', 'ai_agents')`),
  index('ai_model_registry_legacy_archive_partner_idx').on(t.partnerId),
  index('ai_model_registry_legacy_archive_org_idx').on(t.orgId).where(sql`${t.orgId} IS NOT NULL`),
]);
```

Export it from `db/schema/index.ts`.

Registrations (same commit):
- `services/tenantCascade.ts` `CORE_ORG_CASCADE_DELETE_ORDER`: insert `'ai_model_registry_legacy_archive'` in alphabetical position (`localeCompare`), before `organizations` (its composite FK references `organizations`, so children-before-parents holds).
- `services/orgMergeRegistry.ts`: add `"ai_model_registry_legacy_archive"` to the plain `repoint` list, alphabetically.
- `services/tenantExportPolicyRegistry.ts`: add
  ```ts
  "ai_model_registry_legacy_archive": tablePolicy("org_id", {"included":["id","partner_id","org_id","source_table","source_id","source_column","had_cutover","archived_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["value"]}),
  ```
  and delete the `retiring` lists Tasks 8 and 9 added to `ai_budgets`, `client_ai_org_policies`, `ai_script_policies` and `ai_agents` (the columns are gone; `mayBeAbsent` made them safe to keep, so this is tidying, not a correctness requirement — keep the `retiring` mechanism for the next drop).
- `__tests__/integration/rls-coverage.integration.test.ts`: add `'ai_model_registry_legacy_archive'` to `ORG_AXIS_POLICY_EXCLUDED_TABLES` (with the comment "W08b (#7606): snapshot of the dropped legacy AI model config; partner-axis like legacy_labour_pricing_archive, org_id is metadata") and `['ai_model_registry_legacy_archive', 'partner_id']` to `PARTNER_TENANT_TABLES`; delete `['partner_llm_configs', 'partner_id']` from `PARTNER_TENANT_TABLES` and `ai_model_registry_state` from `INTENTIONAL_UNSCOPED`.
- `aiModelRegistryForgery.integration.test.ts`: delete any case that still names a dropped object.
- Delete `aiModelRegistryLegacyPreflight.integration.test.ts`.

- [ ] **Step 6: Run the tests**

Run:
```bash
bash scripts/check-migration-naming.sh --against-ref origin/main
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/services/orgMerge src/routes/devices
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/aiModelRegistryLegacyDrop.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/aiModel
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test pnpm db:check-drift
npx tsc --noEmit -p tsconfig.json
```
Expected: PASS everywhere (the migration-RLS-scope guard accepts the file because it elects system scope before its first write; `orgLifecycleFoundations` proves the composite FK is deferrable under merge); drift check applies the full set cleanly.

- [ ] **Step 7: Commit**

```bash
git add -A apps/api/migrations/2026-11-28-100000-ai-model-registry-legacy-drop.sql apps/api/src
git commit -m "feat(ai)!: archive then drop the legacy AI model configuration (#7606)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: More than one Anthropic connection per partner

Implements Open question 1's recommendation. If Todd declines, skip this task and change Task 13: keep `partner_ai_connections_compat_uq` (delete its `DROP INDEX` line and its clause in the proof and the test), and keep `MAX_ANTHROPIC_API_CONNECTIONS_PER_PARTNER = 1`.

**Files:**
- Modify: `apps/api/src/db/schema/aiModelRegistry.ts` (delete the `partner_ai_connections_compat_uq` declaration), `aiModelRegistry.contract.test.ts` (schema)
- Modify: `apps/api/src/services/aiModels/anthropicConnectionWrites.ts` (+ test)
- Modify: `apps/api/src/routes/aiModels/connections.ts` (+ `partnerRoutes.test.ts`)
- Modify: `apps/web/src/components/settings/aiModels/connectionForms/connectionKinds.ts`, `ConnectionsCard.tsx` / `ConnectionDrawer.tsx` (W06's kind chooser) (+ tests), `PartnerAiModelsTab.test.tsx`
- Modify: `e2e-tests/tests/ai-providers-models.spec.ts`, `e2e-tests/pages/PartnerAiModelsPage.ts`
- Modify: `apps/api/src/__tests__/integration/aiModelConnectionLifecycle.integration.test.ts`, `aiModelRegistryBootstrap.integration.test.ts`

**Interfaces:**
- Produces: `MAX_ANTHROPIC_API_CONNECTIONS_PER_PARTNER` and `hasAnthropicConnection` are **removed**. Connecting a **second** Anthropic connection moves nothing (`movePlatformReferences: false`): its discovered models arrive disabled and the admin assigns them (spec §6). `switchAnthropicConnectionKind` needs no change: it is in place since Task 4, so it never touches another connection's references.

- [ ] **Step 1: Write the failing tests**

Append to `aiModelConnectionLifecycle.integration.test.ts` (replace its "second Anthropic connection is refused" case):

```ts
  it('two Anthropic connections; the second moves nothing; deleting one leaves the other\'s assignments', async () => {
    const { partnerId, userId } = await bootstrappedPartner();
    const first = await createAnthropicKeyConnection({ partnerId, apiKey: 'sk-ant-test-1010101010', userId });
    const onFirst = (await partnerRows(partnerId)).map((r) => r.defaultOfferingId);
    const second = await createAnthropicKeyConnection({ partnerId, apiKey: 'sk-ant-test-2020202020', userId });
    expect((await partnerRows(partnerId)).map((r) => r.defaultOfferingId)).toEqual(onFirst);

    expect(await deleteAnthropicConnection({ partnerId, connectionId: second.connectionId })).toBe(true);
    expect((await partnerRows(partnerId)).map((r) => r.defaultOfferingId)).toEqual(onFirst);
    expect(await deleteAnthropicConnection({ partnerId, connectionId: first.connectionId })).toBe(true);
    for (const r of await partnerRows(partnerId)) expect((await offering(r.defaultOfferingId))!.connectionId).toBeNull();
  });
```

Append to `aiModelRegistryBootstrap.integration.test.ts` (reachable only now that the index is gone):

```ts
  it('several Anthropic connections and no registry row: no defaults (fail closed), never platform funding', async () => {
    await seedPricedPlatformModel({ isPlatformDefault: true });
    const partnerId = await newPartner();
    for (const key of ['sk-ant-test-aaaaaaaaaa', 'sk-ant-test-bbbbbbbbbb']) {
      await sys(() => createConnection({ partnerId, kind: 'anthropic_byok', name: 'k', apiKey: key, connectedBy: null, verifiedAt: null }));
    }
    expect(await ensurePartnerCutover(partnerId)).toBe(true);
    for (const r of await partnerAssignments(partnerId)) {
      if (r.surface !== 'patch_test') expect(r.defaultOfferingId).toBeNull();
    }
  });
```

In `partnerRoutes.test.ts` replace the "already has an Anthropic connection → 409" case with "a second `anthropic_byok` create is 201". In `PartnerAiModelsTab.test.tsx` / W06's kind-chooser test replace `expect(screen.queryByTestId('ai-connection-add')).toBeNull(); // one Anthropic connection max (compat_uq)` and the "Already connected" assertion with: the Anthropic kind option (`ai-connection-add-kind-anthropic`) is enabled when an Anthropic connection exists.

- [ ] **Step 2: Run them to verify they fail**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelConnectionLifecycle.integration.test.ts
npx vitest run src/routes/aiModels/partnerRoutes.test.ts
cd ../web && npx vitest run src/components/settings/aiModels
```
Expected: FAIL — the second create is refused (409 cap / route pre-check); the web disables the Anthropic option. (The bootstrap case passes already — Task 2's planner fails closed — and stays as the real-Postgres proof.)

- [ ] **Step 3: Implement**

`anthropicConnectionWrites.ts`: delete `MAX_ANTHROPIC_API_CONNECTIONS_PER_PARTNER`, `hasAnthropicConnection` and the cap check; the create keeps `movePlatformReferences: existing.length === 0`.

`routes/aiModels/connections.ts`: delete the `hasAnthropicConnection` pre-check and its import from the `anthropic_byok` arm.

`db/schema/aiModelRegistry.ts`: delete the `uniqueIndex('partner_ai_connections_compat_uq')…` declaration; update the schema contract test.

Web (W06's files): in `connectionForms/connectionKinds.ts` / the kind chooser, delete the rule that disables the Anthropic option with "Already connected" when a compat connection exists, and its locale key if now unused (all 8 locales + `humanizedKeyBaseline.json`). `e2e-tests/tests/ai-providers-models.spec.ts`: replace any assertion that "Add connection" is hidden once a connection exists with one that the Anthropic option stays enabled.

- [ ] **Step 4: Run the tests**

Run:
```bash
cd apps/api && npx vitest run src/services/aiModels src/routes/aiModels src/db/schema/aiModelRegistry.contract.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelConnectionLifecycle.integration.test.ts \
  src/__tests__/integration/aiModelRegistryBootstrap.integration.test.ts src/__tests__/integration/aiModelsRoutes.integration.test.ts
npx tsc --noEmit -p tsconfig.json
cd ../web && npx vitest run src/components/settings/aiModels src/lib src/locales && npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/api/src apps/web/src e2e-tests
git commit -m "feat(ai): a partner may hold more than one Anthropic connection (#7606)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: R2 docs, verification and PR

**Files:**
- Modify: `apps/docs/src/content/docs/deploy/upgrades.mdx`, `features/bring-your-own-llm-key.mdx`
- Modify: `docs/superpowers/plans/ai-mcp/2026-09-30-ai-model-registry-index.md` (W08 row status → "shipped (W08a R1, W08b R2)")

- [ ] **Step 1: Docs**

`deploy/upgrades.mdx` — add under "Version-specific notes" (outer fence is `~~~` because the block contains a code fence):

~~~mdx
### Next release — legacy AI model columns archived and dropped

This release drops the storage behind the AI settings retired in the previous release: the `partner_llm_configs` table, the per-policy model fields (`ai_budgets.allowed_models`, `ai_script_policies.reviewer_model`, `client_ai_org_policies.allowed_models`, `ai_agents.model`), the per-connection legacy default model, and the cutover-sweep bookkeeping table.

- **Archived first.** The migration copies every value it drops into `ai_model_registry_legacy_archive` and logs the counts as warnings. API keys are not archived: live keys are in the registry's connections, and the legacy table's copies (including keys partners had disconnected) are destroyed.
- **A partner can now hold more than one Anthropic connection** (for example a second key for another region). Only the first one takes over the features that were on the platform key; models discovered on another connection arrive disabled until you assign them.
- **Rolling back** to the previous release after this migration is supported.

To see what was archived for your deployment:

```sql
BEGIN READ ONLY;
SELECT set_config('breeze.scope', 'system', true);
SELECT source_table, source_column, count(*) AS rows, count(*) FILTER (WHERE NOT had_cutover) AS never_migrated
  FROM ai_model_registry_legacy_archive GROUP BY 1, 2 ORDER BY 1, 2;
ROLLBACK;
```
~~~

`features/bring-your-own-llm-key.mdx`: in the Connections paragraph, add "You can add more than one Anthropic connection; only the first takes over features from the platform key."

- [ ] **Step 2: Verify**

Run the W08a Task 11 Steps 2–4 commands on this branch (unit batches, web/shared, integration incl. Task 13's suites, `test:rls-coverage`, `db:check-drift`), then `cd apps/docs && pnpm astro check && pnpm build`.
Expected: PASS.

- [ ] **Step 3: Review round and PR**

One `/pr-review-toolkit:review-pr` round (Sonnet or Opus: destructive DDL + tenancy). Ask it to check the migration against Review Focus 4, the registrations in CLAUDE.md's cascade table, and that the archive never contains key material.

PR: branch `feature/7598-ai-model-registry/wave-7606-drop` → `main`. Title: `feat(ai)!: model registry W08b — archive then drop the legacy AI model config (#7606)`. Body: `Closes #7606`, `Part of #7598`; "G2 approved by Todd on #7606 at <UTC>"; the migration summary (drops, archive, no refusal), the registrations, the rollback note, Task 14's decision. **Do not enqueue before G2 approval.** Do not merge; Todd enqueues it.

Update the index's W08 row in the same PR.

- [ ] **Step 4: TODD GATE G3 — after R2 is deployed**

On EU and US run the archive query from Step 1 and compare with the G2 `counts`: `partner_llm_configs.row` = "partner_llm_configs rows"; `ai_budgets.allowed_models` = "ai_budgets rows" whose value was non-null; `ai_script_policies.reviewer_model` = "reviewer_model set"; `client_ai_org_policies.allowed_models` = "allowed_models non-empty"; `ai_agents.model` = "ai_agents.model set"; `partner_ai_connections.legacy_default_model` = "legacy_default_model set" (minus rows changed between G2 and the deploy, which should be none: nothing writes them in R1). Confirm AI chat works for a platform partner and a BYOK partner on both regions. Then call `complete_wave` for #7606 (feature-lifecycle).

---

## Lab and Todd gates (summary)

| Gate | When | Who | What CI cannot prove |
|---|---|---|---|
| **G1** | before W08a merges (R0 deployed) | Todd | that every prod partner with legacy AI config was cut over by R0 on EU and US (`blocking_uncut_with_legacy` empty) |
| **R1 smoke** | after R1 deploys | Todd | AI chat on a platform and a BYOK partner; a key rotation on a lab partner; `/ai/provider` 404; no `ai_registry_bootstrap_existing_connection` event on hosted |
| **G2** | before W08b merges (R1 deployed) | Todd | the destructive drop is approved; row counts recorded; a backup / PITR window covers the deploy |
| **G3** | after R2 deploys | Todd | archive counts match G2; AI still works on both regions |
| **L1 (lab, optional)** | before R1 ships | executor + Todd's lab | a self-hosted install of a pre-R0 release with a BYOK `partner_llm_configs` row, upgraded straight to the R1 image: the partner's chat routes through its key (destination-preserving bootstrap) and the `ai_registry_bootstrap_existing_connection` event fires. Real Anthropic key needed for an end-to-end turn; the integration suite proves the routing rows only. |

No real cloud credentials are needed (W08 touches no Bedrock / Vertex / Foundry path).

## Rollback

- **R1 → R0 (W08a).** No schema changed in R1. R0 code reads the legacy columns, which still exist and were not written in R1 (so they are stale, exactly as R0 left them — R0 routes on the registry, not on them). Partners bootstrapped in R1 have cutover rows, so R0 never projects them. At most one Anthropic connection exists per partner (the R1 cap + `compat_uq`), which R0's single-connection facade requires. Safe.
- **R2 → R1 (W08b).** R1 code names no dropped object (Task 11 Step 1), so the API and workers run. R1's export policy lists the dropped columns only as `retiring` (allowed to be absent), so organization export works. R1's cascade and merge lists do not know the archive table, so its composite FK is `ON DELETE CASCADE`: an org erasure on the R1 image deletes that org's archive rows instead of aborting, and an org merge on the R1 image drops the merged-away org's archive rows (history only). If a partner created a second Anthropic connection in R2, R1 keeps working id-keyed: it refuses to create a third, and its kind switch is in place (Task 4), so it never moves another connection's references.
- **Data.** The archive keeps every dropped value except key material. Restoring the legacy table itself means a managed-database point-in-time restore taken before the R2 deploy (G2 confirms one exists); there is no in-app reverse migration, by design.

## Open questions for Todd

1. **More than one Anthropic connection per partner after `compat_uq` drops (Task 14).**
   - **A — allow it**: pro, matches the list-shaped Connections card (spec §11) and enables a second key per region or cost centre; con, two connections of the same kind can confuse which one a feature uses (the UI names the connection on every model).
   - **B — keep one**: pro, no UX change; con, keeps a single-row constraint the registry never needed, and the "drop compat_uq" item stays open.

   **Recommend A** — the registry is connection-keyed everywhere since W03; only the retired facade needed one row.
2. **New-partner defaults (Task 2, D3).** New partners start every surface — including `script_reviewer` and `extension_content` — on the platform default model, because the env vars that seeded those two (`BREEZE_AI_SCRIPT_REVIEWER_MODEL`, `WORKSPACE_CONTENT_LLM_MODEL` → Haiku) are retired. On hosted that moves new partners' extension/enrichment content from Haiku-tier to Sonnet-tier pricing until they change it.
   - **A — platform default for every surface**: pro, one place configured (spec §11), no model id in code; con, higher default cost for extension content.
   - **B — keep a per-surface platform default** (a new `/admin/ai-models` setting): pro, cheap defaults for bulk surfaces; con, a new setting and table column — scope for a later wave, not cleanup.

   **Recommend A now**, with B filed as a follow-up if extension-content volume on hosted makes the difference material.
3. **Removal timing for `/ai/provider` and the retired fields.** The manifest records `deprecatedIn = R0`, `removedIn = R1`: one release of notice, no external caller known (the endpoints are MFA-gated partner-admin credential operations, exempt from MCP). **Recommend** accepting one release; if you want a calendar window instead, set `earliestRemovalDate` and hold W08a until it passes.
4. **`ai_sessions.model`.** W05's plan lists dropping it as a W08 item; spec §5.6 keeps it as the session's provenance snapshot. **Recommend keep** (D4) — six writers, several displays, `NOT NULL`, and it costs nothing.
5. **Deleting an in-use Anthropic connection.** W08 keeps W03/W04's behaviour (its features move back to the same models on the platform key, now funded by Breeze credits). W06 chose "refuse while in use" for OpenAI-compatible connections. **Recommend** keeping the Anthropic behaviour in W08 (no UX change in a cleanup wave) and deciding on one rule for every kind in a later UX pass.

## Self-review

- **Spec / task coverage:**

  | Scope item | Task |
  |---|---|
  | Drop `partner_llm_configs` (trigger already dropped by W03) | 7 (code), 13 (DDL) |
  | Drop `ai_budgets.allowed_models` | 9 (reader), 13 |
  | Drop `partner_ai_connections_compat_uq` | 4 (no singular reads), 13, 14 |
  | Delete the `/ai/provider` facade, routes, tests | 3, 4 |
  | Delete the agent `model` string path and column (W05 note) | 9, 13 |
  | Delete `getLegacyModelRates` / `LEGACY_MODEL_RATES` (W03 R4) | 7 |
  | Delete the legacy-cost shadow bridge (W06 does not) | 5 |
  | Delete W02 parity/projection code; keep what un-cut partners need until proven | 1 (G1 proof), 2 (bootstrap replaces the projection), 7 |
  | Docs: dropped config and env vars, `apps/docs` | 10, 15 |
  | Prod preflight both regions: row counts, un-cut partners, unrepresented values | 1 (G1), 12 (G2) |
  | Archive before drop (`legacy_labour_pricing_archive` pattern) | 13 |
  | Idempotent drops ordered after code removal | Global Constraints, 13 |
  | Rollback stated | Rollback |
  | Every reader grepped repo-wide (API, web, agent, docs, e2e, seeds) | 3 Step 1, 6 Step 1, 7 Step 3.1, 9 Step 1, 11 Step 1 |
  | W04's `reviewer_model` / Office `allowed_models` drops and accept-and-ignore removal | 8, 13 |
  | Legacy resolver half (`resolveLlmConfigForOrg`, W06 P8 leftover) | 6 |
  | Env vars `BREEZE_AI_SCRIPT_REVIEWER_MODEL`, `WORKSPACE_CONTENT_LLM_MODEL` | 7, 10 |

- **Placeholder scan:** the only deferred values are release versions and tag dates, which Task 1 Step 1 derives with exact commands; the manifest schema rejects a non-date, so a forgotten substitution fails CI. No "TBD" / "similar to".
- **Type consistency:** `ensurePartnerCutover(partnerId): Promise<boolean>` is unchanged for every caller; `bootstrapPartnerRegistryInTx` returns `BootstrapReport` (used by `cutoverPartner`); `ConnectionCheckError(message, status)` is the one error the routes map without a code; `AnthropicApiConnectionKind` is the kind type across `connectionRemap.ts`, `anthropicConnectionWrites.ts`, `registryBootstrap.ts`; `lockPartnerRegistry` replaces `lockPartnerRegistryReconcile` everywhere.
- **Review Focus:** each of the five lines has a named pinning test (header).

## Review

Independent review: Codex `gpt-6-astra`, reasoning `high`, read-only, against the W03+W04 branch head (`e6e759d676`), the spec, the index and the W05/W06 plans (2026-10-02). 14 findings; **all 14 adopted, 3 of them modified**; 0 rejected. Each was re-checked against the code before adoption.

| # | Sev | Finding | Outcome |
|---|---|---|---|
| 1 | High | The archive policy `FOR ALL TO breeze_app` leaves a non-BYPASSRLS migration owner with no policy under FORCE RLS, so the archive insert fails even with system scope (the W02 connections migration omits `TO` for exactly this, L113). | **Adopted.** No `TO` clause; comment in the migration; Global Constraints. |
| 2 | High | After an R2 → R1 rollback, R1's cascade does not know the archive, so an org erasure aborts on its FK. | **Adopted, modified.** Registering the table in R1 is impossible (the cascade contract rejects a list entry for a table that does not exist yet), so the archive's composite FK is `ON DELETE CASCADE` (D12); Rollback section updated. |
| 3 | High | W03's kind switch (disconnect, then reconnect only when no other connection exists) strands the switched connection's features on platform funding whenever a second connection exists (R2, or a rollback from it). | **Adopted, modified.** The switch is now **in place** (same id, key, references; offerings converted), correct in every release combination (D6); Task 14's switch rewrite removed. |
| 4 | High | Deferring Task 9 (P4) left `effectivePolicy.ts` reading `ai_budgets.allowed_models` while W08b dropped it. | **Adopted.** Deferral now keeps both `ai_agents.model` and `ai_budgets.allowed_models` (P4, Task 9, Task 13). |
| 5 | Med | `ANTHROPIC_MODEL` overrode the operator's registry default forever, on hosted too (spec §11: env only bootstraps a fresh self-host). | **Adopted, modified.** Hosted ignores the env (`pickBootstrapDefaultModelId`); self-host keeps it, because a vLLM backend may serve nothing else (#1412) and W03 behaved that way. |
| 6 | Med | Several Anthropic connections without a registry row fell back to platform funding. | **Adopted.** Fails closed (`destination: 'ambiguous'`, no defaults) with a Sentry report; unit test in Task 2, real-Postgres test in Task 14. |
| 7 | Med | R1's export policy names columns R2 drops; `buildTenantExportPlan` throws on absent columns, so export breaks after a rollback (and the Task 11 sweep could not pass). | **Adopted.** `retiring` export group with `mayBeAbsent` (D11, Tasks 8–9, 13); Task 11 expectation updated. |
| 8 | Med | A bare `export { … } from` re-export gives `legacyReconcile.ts` no local binding for its own lock call. | **Adopted.** Import + re-export, internal call switched (Task 2). |
| 9 | Med | `captureMessage` takes only codes from the closed `SENTRY_EVENT_CODES` union. | **Adopted.** Task 2 registers `ai_registry_bootstrap_existing_connection`. |
| 10 | Med | `aiModelRegistryReconcile.integration.test.ts` imports facade functions Task 4 deletes, so Task 4's commit would not compile. | **Adopted.** Deleted in Task 4 (not Task 7). |
| 11 | Med | W02's `seedPlatformModel` takes a string and returns an id; it cannot seed a priced default. | **Adopted.** New `seedPricedPlatformModel` fixture (Task 2); every W08 suite uses it. |
| 12 | Med | Tests passed random ids into `connected_by` / omitted `ai_agents.created_by` (both users FKs). | **Adopted.** Suites create real users (`createUser`); the W08b suite seeds a committed tenant. |
| 13 | Med | `seedAgent` writes `ai_agents.model` in raw SQL, so `tsc` cannot flag it and the post-drop suite fails. | **Adopted.** Task 9 removes it and updates callers. |
| 14 | Med | The ratchets matched test files and history comments (Task 5 scanned other tests; Task 7 flagged retained comments and the archive schema's metadata literals). | **Adopted.** Test files excluded; flagged comments reworded (incl. this plan's own new comments); `ALLOWED_FILES` for the archive schema. |

## Index additions

| Name | Kind | File | Wave |
|---|---|---|---|
| `ANTHROPIC_API_CONNECTION_KINDS`, `AnthropicApiConnectionKind`, `isAnthropicApiConnectionKind` | shared constants | `packages/shared/src/constants/aiConnectionKinds.ts` | W08a |
| `AI_MODEL_FIELDS_RETIRED_IN`, `RETIRED_AI_MODEL_FIELDS`, `RetiredAiModelField`, `retiredAiModelFieldMessage`, `retiredAiModelField` | shared validators | `packages/shared/src/validators/retiredAiModelFields.ts` | W08a |
| `ENV_DEFAULT_MODEL_BOOTSTRAP_RATES`, `mayCreateEnvPlatformModel`, `pickBootstrapDefaultModelId`, `resolveBootstrapDefaultModelId`, `ensurePlatformModelRow`, `planBootstrap`, `bootstrapPartnerRegistryInTx`, `BootstrapPlanInput`, `BootstrapPlan`, `BootstrapReport` | service | `services/aiModels/registryBootstrap.ts` | W08a |
| `partnerRegistryLockKey`, `lockPartnerRegistry` | service | `services/aiModels/registryWriteLock.ts` | W08a |
| `connectionRemap.ts` (renamed from `compatRemap.ts`): `lockAnthropicConnection`, `lockAnthropicConnectionIds`, `connectAnthropicConnection`, `disconnectAnthropicConnection`, `rotateAnthropicConnectionKey`, `setAnthropicConnectionCatalogEntry`, `bumpConnectionConfigVersion`, `switchAnthropicConnectionKind`, `partnerChatDefaultModelId`, `AnthropicConnectionMissingError`, `LockedAnthropicConnection`, `ConnectAnthropicInput` | service | `services/aiModels/connectionRemap.ts` | W08a |
| `ConnectionCheckError`, `probeAnthropicKey`, `resolveCatalogEndpointForSelection` | service | `services/aiModels/connectionProbe.ts` | W08a |
| `createAnthropicKeyConnection`, `rotateAnthropicKey`, `changeAnthropicEndpoint`, `deleteAnthropicConnection` (+ `hasAnthropicConnection`, `MAX_ANTHROPIC_API_CONNECTIONS_PER_PARTNER` until W08b Task 14) | service | `services/aiModels/anthropicConnectionWrites.ts` | W08a |
| `chatReadinessInSystemContext`, `chatReadinessCode`, `ChatReadinessFacts` | service | `services/aiModels/readiness.ts` | W08a |
| `platformLlmConfig`; `resolveCatalogEndpoint` (now exported) | service | `services/llm/llmConfigResolver.ts` | W08a |
| `DELETED_PATHS`, `RETIRED_IDENTIFIERS` | contract test | `services/aiModels/legacyRemoval.contract.test.ts` | W08a |
| `ExportColumnDecision.mayBeAbsent`; `ColumnGroups.retiring` (`tablePolicy`) | export policy | `services/tenantExportPolicy.ts`, `services/tenantExportPolicyRegistry.ts` | W08a |
| `seedPricedPlatformModel` | test fixture | `__tests__/integration/aiModelRegistryFixtures.ts` | W08a |
| `ai-provider-endpoints`, `ai-script-policy-reviewer-model`, `client-ai-policy-allowed-models`, `ai-agent-policy-model` | manifest ids | `upgrade/breaking-changes.json` | W08a |
| Sentry event `ai_registry_bootstrap_existing_connection` | telemetry | `registryCutover.ts` | W08a |
| `migrations/preflight/2026-11-28-100000-ai-model-registry-legacy-drop-preflight.sql` (queries `sanity`, `sweep_state`, `blocking_uncut_with_legacy`, `counts`, `unrepresented_models`) | operator SQL | — | W08a |
| `ai_model_registry_legacy_archive` (shape 3) / `aiModelRegistryLegacyArchive` | table / Drizzle | `migrations/2026-11-28-100000-ai-model-registry-legacy-drop.sql`, `db/schema/aiModelRegistryLegacyArchive.ts` | W08b |
| `RESTORE_AI_MODEL_LEGACY_CONFIG_SQL` | test fixture | `__tests__/integration/fixtures/aiModelRegistryLegacyConfig.ts` | W08b |

**Removed names** (later waves must not use them): `partnerLlmConfig.ts` and everything in it; `compatRemap.ts`'s compat exports; `ownConnectionId`; `getCompatConnection`; `legacyProjection.ts`, `legacyReconcile.ts`, `legacySurfaceModels.ts`, `parity/*`; `legacyCostEvents.ts`; `registerInvocationLedgerShadow`, `recordShadowInvocation`, `surfaceFromSession`, `buildShadowRateSnapshot`, `shadowCostDiff`; `runRegistryCutoverSweep*`, `REGISTRY_CUTOVER_RETRY_DELAYS_MS`, the lease functions, `disableUnproducedOfferings`, `nextUncutPartners`; `resolveLlmConfig`, `resolveLlmConfigForOrg`, `llmUnusableCodeForOrgInSystemContext`, `llmUnusableCode`; `resolveReviewerDefaultModel`, `AI_SCRIPT_REVIEWER_MODEL`; `bindAgentModel`; `mergeAgentPolicies`' third argument; `AiAgentPolicy.model`, `AiAgentDto.model`, `ScriptPolicyDto.reviewerModel`, `ClientAiOrgPolicy.allowedModels`; tables `partner_llm_configs`, `ai_model_registry_state`; index `partner_ai_connections_compat_uq`.

