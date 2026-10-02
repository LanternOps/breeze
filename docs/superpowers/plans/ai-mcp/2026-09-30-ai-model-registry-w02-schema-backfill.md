---
tracking_issue: LanternOps/breeze#7598
---

# AI Model Registry W02 — Schema, Backfill and `/ai/provider` Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Closes #7600

**Goal:** Ship the registry's tenant-scoped tables (connections, offerings, assignments, the invocation ledger, and offering columns on `ai_sessions` / `ai_agents`), fill them from every partner's **current effective behaviour**, move `/ai/provider` onto the new store with an unchanged contract, and shadow-write one ledger row next to every existing cost record — while every AI surface still routes, prices and bills through the legacy path.

**Architecture:** In W02 the legacy config (`partner_llm_configs` + env + policy columns) stays the routing authority, and the new store is maintained as a **projection** of it. Connections are kept exact at all times. Offerings, assignments and agent/session bindings are refreshed at every sync point, may lag other legacy writers between boots. W03 freezes them per partner with a durable, one-time cutover (W03 Task 6A), after which nothing re-projects that partner. One pure function, `buildDesiredRegistryState(legacySnapshot, env)`, defines that projection. One DB function, `reconcilePartnerFromLegacyInTx(partnerId)`, applies it under a per-partner advisory lock. It runs at three sync points: the migration's id-preserving connection copy, every API boot (detached), and every `/ai/provider` write (same transaction as the legacy write). A parity harness compares the projection, read back through registry semantics, against the **real** legacy resolution functions for every config shape. Legacy model choices that are more than "the partner default" are first extracted into named functions, so the oracle and the routes run the same code. The ledger is fed through a listener bridge. `aiCostTracker` emits a `LegacyCostEvent` after it computes the legacy cost. The ledger listener, registered only at process boot, prices the call with W01's `priceInvocation`. It writes an `ai_invocations` row (`ledger_mode='shadow'`) after the caller's transaction exits, and logs a structured diff when the two costs disagree.

**Tech Stack:** Hono, Drizzle ORM on PostgreSQL 16 (hand-written SQL migrations, forced RLS, composite FKs, plpgsql triggers), BullMQ, Vitest (unit + real-Postgres integration), `@breeze/shared` (zod).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-30-ai-model-registry-design.md` (v3; §5.2–§5.6, §10, §12 RLS; quorum #1, #3, #11, #12, #13 in §16). **Names:** `docs/superpowers/plans/ai-mcp/2026-09-30-ai-model-registry-index.md`. W01 is merged before this wave starts.

## Global Constraints

- **No routing change.** Every surface keeps resolving its model, destination, key, funding source and cost through the code it uses today: `resolveLlmConfig`, `resolveWireModel`, `getLlmBillingSourceForOrg`, `MODEL_PRICING` and the SDK-cost preference. Nothing in W02 reads the new store to make a routing, admission, budget or billing decision. The only routing-adjacent edits are behaviour-preserving extractions (Task 1), pinned by the touched files' existing tests, which stay unmodified.
- **Billing and budgets do not change.** `recordUsage`, `recordUsageFromSdkResult` and `recordSessionlessSdkUsage` compute and write exactly what they write today. The ledger write is a side effect that runs after the caller's DB context exits (`runAfterDbContextExit`). It never throws into the caller. With no listener registered, as in every existing unit test, the tracker does exactly what it did before.
- **Authority in W02:** the legacy tables + env are authoritative. The registry is a projection that only these write:
  - the migration's id-preserving copy and its `partner_llm_configs` UPDATE mirror trigger (Task 2);
  - `reconcilePartnerFromLegacyInTx` (Task 12), which the `/ai/provider` facade calls in the same transaction as its legacy write (Task 13).

  W02 ships no other writer of `partner_ai_models`, `ai_model_assignments`, `ai_agents.offering_id` or `ai_sessions.offering_id`.

  **Freshness is part of the contract:**
  - Connection rows are exact at all times. The migration copy and the facade's reconcile handle insert and delete. The mirror trigger handles every legacy UPDATE, including `markPartnerLlmError`'s runtime `status='error'` stamp, which needs no code change.
  - Everything else is refreshed at every API boot and every `/ai/provider` write. It can lag these legacy writers until the next boot:
    - agent policy edits (`aiAgents/agentService.ts`);
    - new sessions (`aiAgent.ts`, helper, client AI);
    - script/Office policy edits;
    - budget edits.

  Nothing in W02 reads those bindings. **W03 cuts each partner over exactly once** (W03 Task 6A). It calls `reconcilePartnerFromLegacyInTx(partnerId)` in one system transaction together with a durable per-partner cutover row. `resolveModel` gates on that row, and a leased, resumable sweep that starts after `serve()` covers the rest. W03 deletes W02's detached boot sweep (see "Handoff to W03").
- **Migrations:** exactly seven new files. Each must sort after the newest **committed** migration at commit time. W00's newest is `2026-11-12-110000-partner-llm-catalog-pin-default-model.sql`; W01 adds more. Before committing each file, run `git fetch origin && scripts/check-migration-naming.sh --against-ref origin/main` (it lists and compares with the runner's `localeCompare`; a shell `sort` does not). If it fails, move all seven to the day after the newest committed date and keep their relative order:
  - `apps/api/migrations/2026-11-14-100000-ai-model-registry-connections.sql`
  - `apps/api/migrations/2026-11-14-100100-ai-model-registry-offerings.sql`
  - `apps/api/migrations/2026-11-14-100200-ai-model-registry-assignments.sql`
  - `apps/api/migrations/2026-11-14-100300-ai-invocations.sql`
  - `apps/api/migrations/2026-11-14-100400-ai-model-registry-session-agent-columns.sql` (columns + `NOT VALID` constraints + guard trigger; short locks)
  - `apps/api/migrations/2026-11-14-100500-ai-model-registry-session-agent-validate.sql` (`VALIDATE CONSTRAINT`, SHARE UPDATE EXCLUSIVE)
  - `apps/api/migrations/2026-11-14-100600-ai-sessions-offering-idx.sql` (`-- @no-transaction`, `CREATE INDEX CONCURRENTLY`)
- **Migration rules:**
  - idempotent (`IF NOT EXISTS`, `DROP … IF EXISTS` then re-add, `pg_constraint` / `pg_policies` checks);
  - no inner `BEGIN`/`COMMIT`;
  - a file that writes rows (only `-100000`) runs `PERFORM set_config('breeze.scope', 'system', true);` as the first statement of its `DO` block, and logs its row count with `RAISE WARNING` when > 0, else `RAISE NOTICE`;
  - **no new policy carries a `TO breeze_app` clause.** A role-restricted policy does not apply to a NOBYPASSRLS migration owner, so `breeze.scope = 'system'` alone would read and write zero rows (measured in `2026-10-09-000600-rls-scoped-replay-v0110.sql`). The legacy `partner_llm_configs` policy IS role-restricted, so Task 2 adds a system-only policy before copying from it;
  - never edit a shipped migration.
- **Tenancy shapes** (CLAUDE.md, spec §12):
  - `partner_ai_connections`: shape 3. `PARTNER_TENANT_TABLES`; no org-token read path.
  - `partner_ai_models`: shape 3. `PARTNER_TENANT_TABLES`, plus a **separate** `FOR SELECT` policy `partner_ai_models_org_read_enabled USING (enabled AND partner_id = public.breeze_current_partner_id())`. Never appended to the `FOR ALL` policy.
  - `ai_model_assignments`: org_id XOR partner_id (`ai_model_assignments_one_owner_chk`). One `FOR ALL` dual-axis policy plus `ai_model_assignments_partner_wide_select`. Listed in `DUAL_AXIS_TENANT_TABLES` and `XOR_OWNERSHIP_DUAL_AXIS_TABLES`.
  - `ai_invocations`: shape 1, append-only. Auto-discovered.
- **Composite FKs** (quorum #1). Every FK that references `organizations(id, partner_id)` is `DEFERRABLE INITIALLY IMMEDIATE`. That covers `ai_model_assignments`, `ai_sessions` and `ai_agents`. The `orgLifecycleFoundations` merge contract does NOT check FKs whose parent columns are `(id, partner_id)` (verified), so Task 4 and Task 6 assert deferrability themselves.
- **Cascade registration**, each in the task that creates its table or column:
  - `CORE_ORG_CASCADE_DELETE_ORDER`: `ai_invocations` and `ai_model_assignments`, directly after `'ai_cost_usage',`.
  - `AUDIT_ADMIN_REQUIRED_TABLES`: `ai_invocations`.
  - `orgMergeRegistry`:
    - `ai_invocations` → `REPOINT_TABLES`. The immutability trigger admits an `org_id`-only change while the source org is `merging`.
    - `ai_model_assignments` → `SPECIAL` `{ kind: 'repoint-dedupe', key: ['surface', 'role'] }`.
  - `CORE_TENANT_EXPORT_POLICY`:
    - `ai_model_assignments`: `options` → `excludedOpen`.
    - `ai_invocations`: `options_sent`, `rate_snapshot` → `excludedOpen`.
    - New columns on `ai_sessions` (`options` → `excludedOpen`) and `ai_agents`.
  - `ensureAppRole.ts`: re-revoke `UPDATE, DELETE, TRUNCATE` on `ai_invocations`, then re-grant column-level `UPDATE (org_id)`.
  - Partner-axis tables have no `org_id`, so they need no org-cascade or export entry. `cascadeDeletePartner`'s `information_schema` `partner_id` sweep erases them, topologically ordered.
- **Encryption:** `partner_ai_connections.api_key_encrypted` is registered with `aadBinding: 'row'` and `aadTag: 'partner_llm_configs.api_key_encrypted'`. Connections copied from `partner_llm_configs` keep the **same id**, so stored ciphertext decrypts byte-for-byte. Keys are never returned and never exported.
- **DB contexts:**
  - Request reads use the ambient `db`.
  - Every registry WRITE (reconcile, facade, error mirror) runs inside `runOutsideDbContext(() => withSystemDbAccessContext(fn, '<label>'))`, matching the existing `savePartnerLlmKey` precedent. The route is the authorization gate (`BILLING_MANAGE` + `canManagePartnerWidePolicies`), and every statement pins `partner_id` / the partner's org ids explicitly.
  - Ledger writes run via `runAfterDbContextExit`.
- **`partner-wide-write-coverage.test.ts`:** every new service file that Drizzle-writes `partnerAiConnections`, `partnerAiModels` or `aiModelAssignments` gets an `ALLOWED_WITHOUT_CAPABILITY_CHECK` entry in the task that adds the write.
- **Public repo:** no IPs, hostnames, infrastructure details or unfixed-vulnerability descriptions in code, comments, commits or the PR.
- **Tests:**
  - Unit tests sit next to their source. Real-Postgres suites go in `apps/api/src/__tests__/integration/`.
  - Unit: `cd apps/api && npx vitest run <path>`. Never `pnpm --filter … test -- --run`.
  - Integration: `pnpm test-stack up` once, then `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`.
  - RLS coverage: `cd apps/api && DB_CONTEXTLESS_WRITE_STRICT=true pnpm test:rls-coverage`.
  - Check the reported file count on every filtered run.
- **Commits:** one per task, conventional message, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never on `main`. Branch: `feature/7598-ai-model-registry/wave-7600`.

## Cross-wave assumptions (W01 names this plan consumes)

These are checked against the W01 plan (`2026-09-30-ai-model-registry-w01-platform-catalog.md`, including its "Index additions"). Task 0 re-checks them against W01's MERGED code. If one differs, change only the import or column reference noted, and record the difference in the PR body.

| W02 uses | W01 shape |
|---|---|
| Drizzle `aiPlatformModels` (`apps/api/src/db/schema/aiPlatformModels.ts`, re-exported from the schema barrel) | `id`, `provider`, `modelId` (`model_id`, UNIQUE `ai_platform_models_model_id_uq`), `displayName` (NOT NULL, no default), `inputCentsPerM` / `outputCentsPerM` / `cacheReadCentsPerM` / `cacheWriteCentsPerM` (numeric, nullable), `optionRates`, `optionSupport` (NOT NULL, defaulted), `promptProfile` (defaulted), `platformOffered`, `isPlatformDefault`, `lifecycle` (defaulted), `lastSeenAt` (nullable) |
| W01 migrations `2026-11-13-100000-ai-platform-models.sql`, `2026-11-13-100100-ai-platform-models-seed.sql` | W02's `2026-11-14-*` files sort after them |
| `getPlatformModelByModelId(modelId): Promise<PlatformModel \| null>` (`services/aiModels/platformModels.ts`) | `PlatformModel` carries `rates: ModelRates \| null` and `optionRates` (not per-column prices) |
| `priceInvocation(rate, tokens, applied)`, `platformRateSnapshot(model: { rates; optionRates }): RateSnapshot \| null`, `type RateSnapshot`, `type TokenComponents` (`services/aiModels/pricing.ts`) | as the index + W01 additions state |
| `resolveTokenRate(model)` (module-private in `aiCostTracker.ts`, W01 Task 11) | `calculateCostCents` / `isPricedModel` read the platform snapshot first, `MODEL_PRICING` as bootstrap. Task 1's `getLegacyModelRates` is built on it, so backfilled prices equal what legacy charges |
| `AI_SURFACES`, `AI_SURFACE_ROLES`, `type AiSurface`, `offeringOptionsSchema`, `type OfferingOptions`, `EFFORT_LEVELS`, `type ModelRates`, `MODEL_LIFECYCLES`, `type ModelLifecycle` from `@breeze/shared` | re-exported from the package root |
| `apps/api/src/services/aiModels/index.ts` | thin re-export hub; W02 appends its exports |
| Discovery leaves rows no sync has seen untouched (W01 deviation 6) | W02's bootstrap rows for unknown legacy ids (`last_seen_at` NULL) are never marked `missing`/`retired` by discovery |

## Review Focus

These are the five input classes most likely to bite. Each has a pinning test in the task named.

1. **A partner whose legacy config is unusable at backfill time.** Covers status `error`, an undecryptable key, a delisted catalog entry, and a catalog revision that doesn't verify the partner default. The projection must keep the destination: surfaces point at the partner's connection, mirrored as `error`, never at platform offerings. Parity must report "unavailable" on both sides, not "platform". Pinned by Task 10 ("errored config keeps every surface on the connection"), Task 11 (fixtures `byok_errored`, `catalog_default_unverified`) and Task 12 ("reconcile of an errored config").
2. **Legacy model ids the registry doesn't know.** Examples: a self-host `ANTHROPIC_MODEL` pointing at a gateway id, a stale dated id in `ai_budgets.allowed_models` or an Office policy, a typo in `reviewer_model`.
   - On a connection they become `manual` offerings on that connection, priced at the exact legacy rate (`MODEL_PRICING` / `DEFAULT_PRICING`).
   - On the platform key they become a platform offering on a bootstrap `ai_platform_models` row, unpriced and `platform_offered=false`.
   - They are never re-pointed to another model or another funding source.

   Pinned by Task 1 (`getLegacyModelRates('constructor')`), Task 10 ("unknown ids stay on their connection") and Task 12 ("bootstrap platform row is created once").
3. **Concurrent sync points.** Two API replicas boot at once while an `/ai/provider` PATCH runs. Under the per-partner advisory lock and partial-unique upserts, the result must be one offering per `(connection, model)` / `(partner, platform model)`, one assignment per `(owner, surface, role)`, and a final state equal to the last legacy state. Pinned by Task 12 ("two concurrent reconciles converge").
4. **Rows carrying `offering_partner_id` that move tenants.**
   - A device-bound session whose device a system admin moves to another partner must lose its offering, not abort the move with 23503.
   - An org merge must re-point assignments (dedupe on `(surface, role)`) and ledger rows, but only while the source org is `merging`.

   Pinned by Task 6 ("cross-partner device move clears the session offering"), Task 4 (merge dedupe) and Task 5 ("org_id-only update allowed only while merging").
5. **The shadow ledger must never touch billing.** None of these may change what the tracker writes or returns, and none may throw into the caller: a ledger insert failure, a missing ledger context on a sessionless call, a rolled-back caller transaction, an unpriced model, or no listener at all. Pinned by Task 14 ("listener failure is swallowed and logged", "unpriced → NULL cost, diff reason `unpriced`") and Task 15 ("tracker writes are byte-identical with and without a listener").

---

## File Structure

**Create**

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-11-14-100000-ai-model-registry-connections.sql` | `partner_ai_connections`, RLS, id-preserving copy of `partner_llm_configs` |
| `apps/api/migrations/2026-11-14-100100-ai-model-registry-offerings.sql` | `partner_ai_models`, CHECKs, composite FKs, fallback trigger, org read branch |
| `apps/api/migrations/2026-11-14-100200-ai-model-registry-assignments.sql` | `ai_model_assignments`, ownership trigger, dual-axis RLS + partner-wide SELECT |
| `apps/api/migrations/2026-11-14-100300-ai-invocations.sql` | `ai_invocations`, append-only trigger, grants |
| `apps/api/migrations/2026-11-14-100400-ai-model-registry-session-agent-columns.sql` | `ai_sessions` + `ai_agents` offering columns, `NOT VALID` composite FKs/CHECKs, session partner guard (the stale `ai_sessions.model` default is NOT dropped — see Task 6 note) |
| `apps/api/migrations/2026-11-14-100500-ai-model-registry-session-agent-validate.sql` | `VALIDATE CONSTRAINT` for the `-100400` constraints |
| `apps/api/migrations/2026-11-14-100600-ai-sessions-offering-idx.sql` | `-- @no-transaction` `CREATE INDEX CONCURRENTLY ai_sessions_offering_idx` |
| `apps/api/src/db/schema/aiModelRegistry.ts` | Drizzle: `partnerAiConnections`, `partnerAiModels`, `aiModelAssignments` |
| `apps/api/src/db/schema/aiInvocations.ts` | Drizzle: `aiInvocations` |
| `apps/api/src/db/schema/aiModelRegistry.contract.test.ts` | Unit contract: SQL literals ↔ shared constants; every registration list |
| `apps/api/src/services/aiModels/legacySurfaceModels.ts` (+ `.test.ts`) | Extracted legacy per-surface model pickers (the oracle and the routes share them) |
| `apps/api/src/services/aiModels/connections.ts` (+ `.test.ts`) | Connections: list/get/create/decrypt, compat lookup, key spec |
| `apps/api/src/services/aiModels/offerings.ts` (+ `.test.ts`) | Offerings: list/get/enable, legacy-call lookup |
| `apps/api/src/services/aiModels/assignments.ts` (+ `.test.ts`) | Pure tighten-only merge + `getEffectiveAssignment` loader |
| `apps/api/src/services/aiModels/legacyProjection.ts` (+ `.test.ts`) | Pure: `LegacySnapshot` + env → `DesiredRegistryState` |
| `apps/api/src/services/aiModels/legacyReconcile.ts` (+ `.test.ts`) | DB: load snapshot, apply desired state, boot sweep |
| `apps/api/src/services/aiModels/legacyCostEvents.ts` (+ `.test.ts`) | Dependency-free listener bridge from `aiCostTracker` |
| `apps/api/src/services/aiModels/invocationLedger.ts` (+ `.test.ts`) | `recordInvocation`, shadow listener, rate snapshot, diff log |
| `apps/api/src/services/aiModels/parity/fixtures.ts` | `PARITY_FIXTURES`: every legacy config shape |
| `apps/api/src/services/aiModels/parity/legacyOracle.ts` | Legacy surface use, computed by the REAL legacy functions |
| `apps/api/src/services/aiModels/parity/storeProjection.ts` | Registry-semantics surface use over a store snapshot |
| `apps/api/src/services/aiModels/parity/harness.ts` | `runParity`, `EXPECTED_DIVERGENCES` (W03 reuses) |
| `apps/api/src/services/aiModels/parity/parity.test.ts` | The W02 parity suite |
| `apps/api/src/jobs/aiInvocationRetention.ts` (+ `.test.ts`) | Daily retention of `ai_invocations` as `breeze_audit_admin` |
| `apps/api/src/services/aiModels/ledgerShadowBoot.contract.test.ts` | Both entrypoints register the ledger listener; every sessionless cost call passes a ledger context |
| `apps/api/src/__tests__/integration/aiModelRegistryFixtures.ts` | Shared seed helpers + contexts for the registry suites (not a test file) |
| `apps/api/src/__tests__/integration/aiModelRegistryForgery.integration.test.ts` | Direct-SQL forgery as `breeze_app`: every composite FK, trigger and RLS path |
| `apps/api/src/__tests__/integration/aiModelRegistryServices.integration.test.ts` | Connections / offerings / assignments services under real RLS |
| `apps/api/src/routes/aiProvider.registry.test.ts` | GET /ai/provider served from the registry, contract shape pinned (the existing `aiProvider.test.ts` stays untouched) |
| `apps/api/src/config/env.reviewerDefault.test.ts` | Pins the extracted `resolveReviewerDefaultModel` |
| `apps/api/src/__tests__/integration/aiModelAssignmentsPartnerRls.integration.test.ts` | Dual-axis RLS suite named by the spec |
| `apps/api/src/__tests__/integration/aiInvocationsAppendOnly.integration.test.ts` | Append-only, merge repoint, erasure, retention |
| `apps/api/src/__tests__/integration/aiModelRegistryReconcile.integration.test.ts` | Fixture → DB → equals desired state; idempotency; concurrency; facade round trip |

**Modify**

| Path | Change |
|---|---|
| `apps/api/src/db/schema/index.ts` | Export the two new schema files |
| `apps/api/src/db/schema/ai.ts` | `aiSessions`: `offeringId`, `offeringPartnerId`, `options` |
| `apps/api/src/db/schema/aiAgents.ts` | `aiAgents`: `offeringId`, `offeringPartnerId` |
| `apps/api/src/services/encryptedColumnRegistry.ts` (+ test) | `partner_ai_connections.api_key_encrypted` entry |
| `apps/api/src/services/aiCostTracker.ts` (+ test) | `getLegacyModelRates`; emit `LegacyCostEvent`; optional trailing `ledger` arg on `recordUsage` / `recordSessionlessSdkUsage` |
| `apps/api/src/routes/clientAi/sessions.ts`, `services/extensionAi.ts`, `services/scriptProposals/reviewer.ts`, `services/aiAgents/runLoop.ts` | Call the extracted legacy pickers (Task 1); pass ledger context (Task 15) |
| `apps/api/src/routes/ai.ts`, `routes/officeAddin/tickets.ts`, `services/catalogEnrichmentService.ts`, `services/llm/openaiSessionManager.ts` | Pass ledger context / emit (Task 15) |
| `apps/api/src/services/partnerLlmConfig.ts` (+ test) | Facade: reads the registry, writes legacy + reconcile in one system transaction |
| `apps/api/src/services/tenantCascade.ts` | Cascade order + `AUDIT_ADMIN_REQUIRED_TABLES` |
| `apps/api/src/services/orgMergeRegistry.ts` | `REPOINT_TABLES` + `SPECIAL` entries |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | Two new policies + column additions to `ai_sessions`, `ai_agents` |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | `PARTNER_TENANT_TABLES` ×2, `DUAL_AXIS_TENANT_TABLES`, `XOR_OWNERSHIP_DUAL_AXIS_TABLES` |
| `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` | Allowlist entries for the new writers |
| `apps/api/src/db/ensureAppRole.ts` | Re-revoke + column grant for `ai_invocations` |
| `apps/api/src/index.ts`, `apps/api/src/worker.ts`, `apps/api/src/worker.boot.test.ts` | Register the ledger listener; detached boot reconcile (API only) |
| `apps/api/src/jobs/scheduleRegistry.ts`, `services/workerRegistry.ts`, `services/workerRegistry.test.ts`, `services/workerEntrypointClosure.contract.test.ts`, `jobs/workerReadinessManifest.ts`, `services/retentionMetrics.ts` | Register the retention worker |
| `apps/api/src/services/aiModels/index.ts` | Re-export the W02 modules |
| `apps/api/src/config/env.ts` | Extract `resolveReviewerDefaultModel` (behaviour-preserving; `AI_SCRIPT_REVIEWER_MODEL` unchanged) |
| `apps/api/src/services/aiAgentSdk.ts` | Export `SESSION_MAX_AGE_MS` / `SESSION_IDLE_TIMEOUT_MS` (values unchanged) |
| `apps/api/src/services/partnerLlmConfig.test.ts` | One added `vi.mock` for the reconcile + new facade tests; existing test bodies unchanged |
| `.env.example`, `apps/docs/src/content/docs/deploy/environment.mdx` | Document the ledger retention knobs |

---

## Task 0: Preflight — confirm the W01 contract and branch

**Files:** none (read-only checks).

**Interfaces:**
- Consumes: the W01 names in "Cross-wave assumptions".
- Produces: a recorded list of any name differences, used verbatim in later tasks' imports.

- [ ] **Step 1: Branch from fresh main**

```bash
git fetch origin
git switch -c feature/7598-ai-model-registry/wave-7600 origin/main
```

- [ ] **Step 2: Check every W01 name this plan imports**

```bash
git grep -n "export const aiPlatformModels" -- apps/api/src/db/schema
git grep -n "export \(async \)\?function getPlatformModelByModelId\|export function priceInvocation\|export type RateSnapshot\|export type TokenComponents\|export interface RateSnapshot\|export interface TokenComponents" -- apps/api/src/services/aiModels
git grep -n "AI_SURFACES\|AI_SURFACE_ROLES\|offeringOptionsSchema\|EFFORT_LEVELS\|ModelRates" -- packages/shared/src | head -20
git grep -n "model_id\|input_cents_per_m\|platform_offered\|lifecycle" -- 'apps/api/migrations/*platform-models*.sql' | head -20
ls apps/api/src/services/aiModels/
```

Expected: every symbol exists. The `ai_platform_models` migration has the spec §5.1 column names, and `model_id` is UNIQUE. If a name differs, write the difference into the PR description now. Every later task's import uses the real name.

- [ ] **Step 3: Record the newest committed migration**

Run: `git ls-tree --name-only origin/main apps/api/migrations/ | grep -E '^apps/api/migrations/[0-9]{4}-' | tail -5` to see the neighbourhood. The authoritative check runs with the first file in Task 2: `scripts/check-migration-naming.sh --against-ref origin/main`.
Expected: everything committed sorts before `2026-11-14-100000-…`. If not, rename this plan's seven files to the next free day (see Global Constraints) before Task 2.

No commit.

---
## Task 1: Extract the legacy per-surface model pickers, and expose legacy rates (unit; behaviour-preserving)

The parity harness (Task 11) is only discriminating if its oracle runs the code the routes run. Four surfaces choose their model with more than "the resolved partner default". This task moves each of those expressions into one named function and makes the route call it. The oracle then calls the same function. It also exposes the legacy per-model rates, so backfilled non-platform offerings are priced at exactly what they're billed today.

**Files:**
- Create: `apps/api/src/services/aiModels/legacySurfaceModels.ts`
- Create: `apps/api/src/services/aiModels/legacySurfaceModels.test.ts`
- Modify: `apps/api/src/routes/clientAi/sessions.ts` (~:302, `const model = policy.allowedModels[0] ?? resolved.model;`)
- Modify: `apps/api/src/services/extensionAi.ts` (:41 `EXTENSION_AI_DEFAULT_MODEL`, :130–132)
- Modify: `apps/api/src/services/scriptProposals/reviewer.ts` (`resolveReviewerModel` ~:146–148, `runScriptReview` ~:370)
- Modify: `apps/api/src/services/aiAgents/runLoop.ts` (~:1865, `const model = effective.model ?? llm.model;`)
- Modify: `apps/api/src/services/aiCostTracker.ts` (add `getLegacyModelRates` after `calculateCatalogCostCents`)
- Test: `apps/api/src/services/aiCostTracker.test.ts` (append)

**Interfaces:**
- Consumes: `ModelRates` from `@breeze/shared` (W01); `resolveTokenRate` (module-private in `aiCostTracker.ts`, W01 Task 11); `clearPlatformModelSnapshot` (W01 `platformModelSnapshot.ts`, tests only).
- Produces:
  - `legacyOfficeChatModel(allowedModels: readonly string[], resolvedModel: string): string`
  - `legacyExtensionModel(inputModel: string | undefined, env?: Readonly<Record<string, string | undefined>>): string`
  - `legacyReviewerModel(policyReviewerModel: string | null, envReviewerModel: string): string`
  - `legacyAgentModel(effectiveModel: string | null, resolvedModel: string): string`
  - `EXTENSION_AI_DEFAULT_MODEL: 'claude-haiku-4-5'`
  - `getLegacyModelRates(model: string): { rates: ModelRates; source: 'priced' | 'default_pricing' }` (in `aiCostTracker.ts`). It returns exactly the rate `calculateCostCents` charges: the registry snapshot, else `MODEL_PRICING`, else `DEFAULT_PRICING`. **Lifetime:** W03 moves it and its rate table to `legacySurfaceModels.ts`, because W03's per-partner cutover still runs this projection. W08 deletes it with the rest of the legacy projection.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/aiModels/legacySurfaceModels.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  EXTENSION_AI_DEFAULT_MODEL,
  legacyAgentModel,
  legacyExtensionModel,
  legacyOfficeChatModel,
  legacyReviewerModel,
} from './legacySurfaceModels';

describe('legacy surface model pickers (#7600 W02)', () => {
  it.each([
    [[], 'claude-sonnet-5-5', 'claude-sonnet-5-5'],
    [['claude-haiku-4-5'], 'claude-sonnet-5-5', 'claude-haiku-4-5'],
    [['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'], 'claude-sonnet-5-5', 'claude-sonnet-4-5-20250929'],
  ])('office chat: allowedModels %j over %s → %s', (allowed, resolved, expected) => {
    expect(legacyOfficeChatModel(allowed, resolved)).toBe(expected);
  });

  it('extension: caller model wins, then WORKSPACE_CONTENT_LLM_MODEL, then Haiku', () => {
    expect(legacyExtensionModel('claude-opus-5-5', { WORKSPACE_CONTENT_LLM_MODEL: 'x' })).toBe('claude-opus-5-5');
    expect(legacyExtensionModel(undefined, { WORKSPACE_CONTENT_LLM_MODEL: 'claude-sonnet-4-6' })).toBe('claude-sonnet-4-6');
    expect(legacyExtensionModel(undefined, {})).toBe(EXTENSION_AI_DEFAULT_MODEL);
    expect(EXTENSION_AI_DEFAULT_MODEL).toBe('claude-haiku-4-5');
  });

  it('extension: an empty env value is kept, exactly as the legacy `??` chain did', () => {
    // isPricedModel('') then rejects it at the call site — unchanged behaviour.
    expect(legacyExtensionModel(undefined, { WORKSPACE_CONTENT_LLM_MODEL: '' })).toBe('');
  });

  it('reviewer: the effective policy model wins over the env/platform reviewer default', () => {
    expect(legacyReviewerModel('claude-opus-5-5', 'claude-sonnet-5-5')).toBe('claude-opus-5-5');
    expect(legacyReviewerModel(null, 'claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
  });

  it('agents: the merged policy model wins over the resolved partner default', () => {
    expect(legacyAgentModel('claude-haiku-4-5', 'claude-sonnet-5-5')).toBe('claude-haiku-4-5');
    expect(legacyAgentModel(null, 'claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
  });
});
```

Append to `apps/api/src/services/aiCostTracker.test.ts` (inside the file's top-level scope; it already imports from `./aiCostTracker`):

```ts
import { calculateCostCents, getLegacyModelRates } from './aiCostTracker';
import { clearPlatformModelSnapshot } from './aiModels/platformModelSnapshot';

describe('getLegacyModelRates (#7600 W02)', () => {
  beforeEach(() => clearPlatformModelSnapshot()); // cold snapshot → W00 MODEL_PRICING bootstrap, deterministic

  it('returns the bootstrap MODEL_PRICING rates with the standard cache multipliers', () => {
    expect(getLegacyModelRates('claude-sonnet-5-5')).toEqual({
      source: 'priced',
      rates: { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 },
    });
  });

  it('honours a per-model cache-read override', () => {
    expect(getLegacyModelRates('claude-opus-5-5').rates.cacheReadCentsPerM).toBe(20);
    expect(getLegacyModelRates('claude-fable-5-1').rates.cacheReadCentsPerM).toBe(25);
  });

  it.each(['my-gateway-model', 'constructor', '__proto__', 'toString'])(
    'falls back to DEFAULT_PRICING for an unknown or prototype-named id (%s)',
    (model) => {
      expect(getLegacyModelRates(model)).toEqual({
        source: 'default_pricing',
        rates: { inputCentsPerM: 500, outputCentsPerM: 2500, cacheReadCentsPerM: 50, cacheWriteCentsPerM: 625 },
      });
    },
  );

  it.each(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5', 'my-gateway-model'])(
    'prices one million of each token class exactly as calculateCostCents does (%s), cold or warm snapshot',
    (model) => {
      const { rates } = getLegacyModelRates(model);
      const expected = rates.inputCentsPerM + rates.outputCentsPerM + rates.cacheReadCentsPerM + rates.cacheWriteCentsPerM;
      expect(calculateCostCents(model, 1_000_000, 1_000_000, 1_000_000, 1_000_000)).toBeCloseTo(expected, 2);
    },
  );
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/legacySurfaceModels.test.ts src/services/aiCostTracker.test.ts`
Expected: FAIL. `legacySurfaceModels.test.ts` can't resolve `./legacySurfaceModels`, and `getLegacyModelRates` is not exported.

- [ ] **Step 3: Implement**

`apps/api/src/services/aiModels/legacySurfaceModels.ts`:

```ts
/**
 * The pre-registry (legacy) model choice for every AI surface whose rule is
 * more than "the resolved partner default" (#7600, AI model registry W02).
 *
 * EXTRACTED, not re-implemented: each legacy call site calls the function
 * below, and the W02 parity oracle (parity/legacyOracle.ts) calls the same
 * function. A parity test is only discriminating when its oracle IS the
 * legacy path. It outlives the routing cutover: W03's per-partner cutover
 * still runs the W02 projection, which uses these pickers. W08 deletes it.
 */

/** Extension AI's built-in default (services/extensionAi.ts). */
export const EXTENSION_AI_DEFAULT_MODEL = 'claude-haiku-4-5';

/** Office chat (routes/clientAi/sessions.ts): the policy's first allowed model, else the resolved default. */
export function legacyOfficeChatModel(allowedModels: readonly string[], resolvedModel: string): string {
  return allowedModels[0] ?? resolvedModel;
}

/** Extension AI (services/extensionAi.ts): caller → WORKSPACE_CONTENT_LLM_MODEL → Haiku. */
export function legacyExtensionModel(
  inputModel: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return inputModel ?? env.WORKSPACE_CONTENT_LLM_MODEL ?? EXTENSION_AI_DEFAULT_MODEL;
}

/** Script reviewer: the effective ai_script_policies.reviewer_model, else the env/platform reviewer default. */
export function legacyReviewerModel(policyReviewerModel: string | null, envReviewerModel: string): string {
  return policyReviewerModel ?? envReviewerModel;
}

/** AI agents (aiAgents/runLoop.ts): the merged policy model, else the resolved partner default. */
export function legacyAgentModel(effectiveModel: string | null, resolvedModel: string): string {
  return effectiveModel ?? resolvedModel;
}
```

Rewire the four call sites. Each is a one-line swap plus an import:

```ts
// apps/api/src/routes/clientAi/sessions.ts
import { legacyOfficeChatModel } from '../../services/aiModels/legacySurfaceModels';
// …
  const model = legacyOfficeChatModel(policy.allowedModels, resolved.model);
```

```ts
// apps/api/src/services/extensionAi.ts — delete the local
// `const EXTENSION_AI_DEFAULT_MODEL = 'claude-haiku-4-5';` and import instead:
import { EXTENSION_AI_DEFAULT_MODEL, legacyExtensionModel } from './aiModels/legacySurfaceModels';
// …
      const model = legacyExtensionModel(input.model);
```

Keep the `EXTENSION_AI_DEFAULT_MODEL` import only if the file still references the constant elsewhere (`git grep -n EXTENSION_AI_DEFAULT_MODEL apps/api/src/services/extensionAi.ts`). Otherwise drop it from the import.

```ts
// apps/api/src/services/scriptProposals/reviewer.ts
import { legacyReviewerModel } from '../aiModels/legacySurfaceModels';
// in resolveReviewerModel():
  return legacyReviewerModel(effective.reviewerModel, AI_SCRIPT_REVIEWER_MODEL);
// in runScriptReview():
  const model = legacyReviewerModel(effectivePolicy.reviewerModel, AI_SCRIPT_REVIEWER_MODEL);
```

```ts
// apps/api/src/services/aiAgents/runLoop.ts
import { legacyAgentModel } from '../aiModels/legacySurfaceModels';
// …
  const model = legacyAgentModel(effective.model, llm.model);
```

`apps/api/src/services/aiCostTracker.ts`: add the import `import type { ModelRates } from '@breeze/shared';` (skip it if W01 already imports it), then this function directly after `calculateCostCents`. It sits next to W01's `resolveTokenRate`:

```ts
/**
 * The per-million rates calculateCostCents() charges for `model`, as a
 * registry ModelRates (#7600 W02): W01's resolveTokenRate (platform snapshot,
 * else bootstrap MODEL_PRICING), else DEFAULT_PRICING. Used ONLY to price
 * backfilled non-platform offerings at exactly what legacy bills, so the W02
 * shadow ledger and the W03 cutover agree with it. A prototype key
 * ('constructor', '__proto__') is never a model id; without the guard
 * MODEL_PRICING[...] would resolve through Object.prototype.
 * W03 moves this and its rate table to aiModels/legacySurfaceModels.ts (its
 * per-partner cutover still runs the projection); W08 deletes it.
 */
export function getLegacyModelRates(model: string): {
  rates: ModelRates;
  source: 'priced' | 'default_pricing';
} {
  const rate = model in Object.prototype ? null : resolveTokenRate(model);
  if (rate) return { source: 'priced', rates: { ...rate.standard } };
  return {
    source: 'default_pricing',
    rates: {
      inputCentsPerM: DEFAULT_PRICING.inputPerMillion,
      outputCentsPerM: DEFAULT_PRICING.outputPerMillion,
      cacheReadCentsPerM: DEFAULT_PRICING.inputPerMillion * CACHE_READ_INPUT_MULTIPLIER,
      cacheWriteCentsPerM: DEFAULT_PRICING.inputPerMillion * CACHE_WRITE_INPUT_MULTIPLIER,
    },
  };
}
```

`calculateCostCents` itself is NOT changed in W02, because W02 must not change billing. The prototype-name test runs against `getLegacyModelRates` only, and the `calculateCostCents` parity rows avoid prototype names. W01's own `legacyRateSnapshot` reads `MODEL_PRICING[model]` without `Object.hasOwn`. That is a latent W01 issue, reported to the orchestrator rather than patched here.

- [ ] **Step 4: Run the new tests plus every touched file's existing suite, unmodified**

```bash
cd apps/api && npx vitest run src/services/aiModels/legacySurfaceModels.test.ts src/services/aiCostTracker.test.ts \
  src/routes/clientAi src/services/extensionAi src/services/scriptProposals src/services/aiAgents/runLoop
```

Expected: PASS. The reported file count is > 6: the clientAi route tests, the extensionAi, reviewer and runScriptReview tests, and the runLoop tests all run. No existing test file is modified.

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/aiModels/legacySurfaceModels.ts apps/api/src/services/aiModels/legacySurfaceModels.test.ts \
  apps/api/src/routes/clientAi/sessions.ts apps/api/src/services/extensionAi.ts \
  apps/api/src/services/scriptProposals/reviewer.ts apps/api/src/services/aiAgents/runLoop.ts \
  apps/api/src/services/aiCostTracker.ts apps/api/src/services/aiCostTracker.test.ts
git commit -m "refactor(ai): extract legacy per-surface model pickers and legacy rates for the registry parity oracle

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: `partner_ai_connections` with an id-preserving copy of `partner_llm_configs` (migration + schema + encryption + RLS; unit + integration)

**Files:**
- Create: `apps/api/migrations/2026-11-14-100000-ai-model-registry-connections.sql`
- Create: `apps/api/src/db/schema/aiModelRegistry.ts`
- Create: `apps/api/src/db/schema/aiModelRegistry.contract.test.ts`
- Create: `apps/api/src/__tests__/integration/aiModelRegistryFixtures.ts` (shared seed helpers; no `.test.` in the name, so it is never collected as a suite)
- Create: `apps/api/src/__tests__/integration/aiModelRegistryForgery.integration.test.ts`
- Modify: `apps/api/src/db/schema/index.ts` (append `export * from './aiModelRegistry';`)
- Modify: `apps/api/src/services/encryptedColumnRegistry.ts` (directly after the `partner_llm_configs` entry, ~:128)
- Modify: `apps/api/src/services/encryptedColumnRegistry.test.ts` (new `describe` after `'moved column keeps its AAD tag (#6379)'`)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`PARTNER_TENANT_TABLES`, directly after `['partner_llm_configs', 'partner_id'],` ~:320)

**Interfaces:**
- Consumes: `partners`, `users`, `llmProviderCatalog` Drizzle tables.
- Produces:
  - table `partner_ai_connections` with `UNIQUE (id, partner_id)` (constraint `partner_ai_connections_id_partner_uq`), the composite-FK target for Tasks 3 and 6.
  - Drizzle `partnerAiConnections`, `type PartnerAiConnectionRow = typeof partnerAiConnections.$inferSelect`, `PARTNER_AI_CONNECTION_KINDS = ['anthropic_byok', 'catalog', 'openai_compatible'] as const`, `type PartnerAiConnectionKind`.
  - encrypted-column spec `{ table: 'partner_ai_connections', column: 'api_key_encrypted', aadBinding: 'row', aadTag: 'partner_llm_configs.api_key_encrypted' }`.
  - **Invariant:** for every `partner_llm_configs` row there is a connection with the same `id`, the same `api_key_encrypted` bytes, `kind = catalog_entry_id IS NULL ? 'anthropic_byok' : 'catalog'`, and `legacy_default_model = default_model`.
  - Trigger `partner_llm_configs_mirror_to_connection` (AFTER UPDATE on the legacy table) re-applies every mirrored column to the same-id connection. Any legacy UPDATE, such as the resolver's `markPartnerLlmError`, therefore reaches the registry in the same statement. Inserts and deletes are the reconcile's job (Task 12), because a delete must first re-point assignments.
  - **The trigger is W02-only scaffolding.** W03 Task 6B stops writing the legacy table and drops it in its own migration (`2026-11-19-100500-drop-partner-llm-configs-mirror-trigger.sql`).
  - **Temporary invariant (W02–W03):** at most one `anthropic_byok`/`catalog` connection per partner (`partner_ai_connections_compat_uq`). W04 drops this index when the multi-connection UI lands.

- [ ] **Step 1: Write the failing unit tests**

`apps/api/src/db/schema/aiModelRegistry.contract.test.ts` (Tasks 3–6 append `describe` blocks to it; put each task's new imports in this top import block, not mid-file):

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PARTNER_AI_CONNECTION_KINDS } from './aiModelRegistry';

export function readMigration(name: string): string {
  return readFileSync(join(__dirname, '../../../migrations', name), 'utf8');
}

/** The quoted literals inside the first `CHECK (<column> IN (...))` for `column`. */
export function checkLiterals(sqlText: string, column: string): string[] {
  const match = new RegExp(`CHECK \\(\\s*${column} IN \\(([^)]*)\\)`, 'i').exec(sqlText);
  if (!match) throw new Error(`no CHECK (${column} IN (...)) in migration`);
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('partner_ai_connections contract (#7600 W02)', () => {
  const sqlText = readMigration('2026-11-14-100000-ai-model-registry-connections.sql');

  it('the kind CHECK lists exactly the Drizzle kinds', () => {
    expect(checkLiterals(sqlText, 'kind')).toEqual([...PARTNER_AI_CONNECTION_KINDS]);
  });

  it('copies legacy rows with the same id and elects system scope first', () => {
    const doBlock = sqlText.slice(sqlText.indexOf('DO $copy$'));
    const firstStatement = doBlock.slice(doBlock.indexOf('BEGIN') + 'BEGIN'.length).trim().split(';')[0];
    expect(firstStatement).toBe("PERFORM set_config('breeze.scope', 'system', true)");
    expect(sqlText).toMatch(/INSERT INTO public\.partner_ai_connections \(\s*id,/);
    expect(sqlText).toMatch(/SELECT\s+c\.id,/);
    expect(sqlText).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
  });

  it('no policy is role-restricted, and the legacy source gains a system-only policy before the copy', () => {
    expect(sqlText).not.toMatch(/CREATE POLICY[^;]*\bTO breeze_app\b/);
    const systemOnly = sqlText.indexOf('CREATE POLICY partner_llm_configs_system_only');
    expect(systemOnly).toBeGreaterThan(-1);
    expect(systemOnly).toBeLessThan(sqlText.indexOf('DO $copy$'));
  });
});
```

Append to `apps/api/src/services/encryptedColumnRegistry.test.ts`, as a new `describe` block inside the top-level `describe('encryptedColumnRegistry', …)`:

```ts
  describe('partner AI connections keep the legacy partner_llm_configs AAD tag (#7600 W02)', () => {
    const legacySpec = () => encryptedColumnRegistry.find((s) => s.table === 'partner_llm_configs' && s.column === 'api_key_encrypted')!;
    const connectionSpec = () => encryptedColumnRegistry.find((s) => s.table === 'partner_ai_connections' && s.column === 'api_key_encrypted')!;
    const rowId = '22222222-2222-4222-8222-222222222222';

    it('is registered row-bound under the legacy tag', () => {
      expect(connectionSpec()).toMatchObject({ kind: 'text', aadBinding: 'row', aadTag: 'partner_llm_configs.api_key_encrypted' });
      expect(columnAad(connectionSpec(), rowId)).toBe(`partner_llm_configs.api_key_encrypted:${rowId}`);
      expect(columnAad(connectionSpec(), rowId)).toBe(columnAad(legacySpec(), rowId));
    });

    it('a legacy ciphertext decrypts under the connection spec for the same id, and only that id', () => {
      setEncryptionEnv({ APP_ENCRYPTION_KEY: 'current-key-material', APP_ENCRYPTION_KEY_ID: 'current' });
      const sealed = transformEncryptedColumnValue(legacySpec(), 'sk-ant-api03-legacy', rowId) as string;
      expect(decryptSecret(sealed, { aad: columnAad(connectionSpec(), rowId) })).toBe('sk-ant-api03-legacy');
      expect(() => decryptSecret(sealed, { aad: columnAad(connectionSpec(), '33333333-3333-4333-8333-333333333333') })).toThrow();
    });

    it('the rotation walker re-seals a connection key under the legacy tag + row id', async () => {
      setEncryptionEnv({ APP_ENCRYPTION_KEY: 'old-key-material', APP_ENCRYPTION_KEY_ID: 'old' });
      const sealedOld = transformEncryptedColumnValue(legacySpec(), 'sk-ant-api03-rotate', rowId) as string;
      setEncryptionEnv({
        APP_ENCRYPTION_KEY: 'current-key-material',
        APP_ENCRYPTION_KEY_ID: 'current',
        APP_ENCRYPTION_KEYRING: JSON.stringify({ old: 'old-key-material', current: 'current-key-material' }),
      });
      const executor = {
        execute: vi.fn(async () => {
          const call = executor.execute.mock.calls.length;
          if (call === 1) return [{ present: true }];
          if (call === 2) return [{ id: rowId, value: sealedOld }];
          return [];
        }),
      };
      const stats = await reencryptRegisteredSecrets({
        dryRun: false,
        executor,
        registry: [connectionSpec()],
        logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      expect(stats.errors).toEqual([]);
      expect(stats.updated).toBe(1);
      // Whatever the walker sealed decrypts under the connection spec for the same row.
      const resealed = transformEncryptedColumnValue(connectionSpec(), sealedOld, rowId) as string;
      expect(resealed).toMatch(/^enc:v3:current:/);
      expect(decryptSecret(resealed, { aad: columnAad(connectionSpec(), rowId) })).toBe('sk-ant-api03-rotate');
    });
  });
```

(The walker test asserts `stats.updated === 1` with no errors: a binding mismatch would throw inside `transformEncryptedColumnValue` and land in `stats.errors`. The round trip then proves the re-seal decrypts under the connection spec for the same row.)

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/db/schema/aiModelRegistry.contract.test.ts src/services/encryptedColumnRegistry.test.ts`
Expected: FAIL. `./aiModelRegistry` does not resolve, the migration file does not exist, and `connectionSpec()` is `undefined`.

- [ ] **Step 3: Write the migration**

`apps/api/migrations/2026-11-14-100000-ai-model-registry-connections.sql`:

```sql
-- AI model registry W02 (#7600, spec §5.2): partner_ai_connections.
--
-- How models are reached: one row per partner-owned connection. It fixes the
-- destination, the funding source (partner_key) and the inference geography.
-- The platform connection is implicit (connection_id NULL on an offering).
--
-- TENANCY: shape 3 (partner axis), exactly like partner_llm_configs. One
-- FOR ALL policy on breeze_has_partner_access(partner_id). There is
-- deliberately NO org-token read path — a connection carries key material
-- metadata (last4, fingerprint, status) that org users never see.
-- Listed in PARTNER_TENANT_TABLES. No org_id, so no org cascade / export entry;
-- cascadeDeletePartner's information_schema partner_id sweep erases it.
--
-- ID-PRESERVING COPY (quorum #13): every partner_llm_configs row is copied
-- with the SAME id and the SAME api_key_encrypted bytes. The column is
-- registered in encryptedColumnRegistry with
-- aadTag 'partner_llm_configs.api_key_encrypted' + aadBinding 'row', so the
-- copied ciphertext decrypts unchanged and a blob pasted into another
-- partner's row does not. The ciphertext never leaves Postgres.
--
-- W02 KEEPS partner_llm_configs AS THE ROUTING SOURCE. This table is kept an
-- projection of it by this copy, by the boot reconcile and by the
-- /ai/provider facade (services/aiModels/legacyReconcile.ts). W08 drops the
-- legacy table and legacy_default_model.
--
-- legacy_default_model is the compat projection of
-- partner_llm_configs.default_model for GET /ai/provider (NULL = "tracks the
-- deployment default"). Nothing routes on it.
--
-- partner_ai_connections_compat_uq is TEMPORARY: it guarantees the
-- /ai/provider compat facade addresses exactly one connection per partner.
-- W04 drops it when the multi-connection UI lands.
--
-- Idempotent: CREATE … IF NOT EXISTS, constraint checks against pg_constraint
-- (the id/partner UNIQUE is an FK target, so it is never dropped and
-- re-added), DROP POLICY IF EXISTS + CREATE, ON CONFLICT (id) DO NOTHING.
-- WRITES ROWS: system scope is elected first inside the DO block (FORCE RLS
-- binds the migration role). No BEGIN/COMMIT — autoMigrate wraps the file.

CREATE TABLE IF NOT EXISTS public.partner_ai_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  inference_geo text,
  provider_config jsonb,
  api_key_encrypted text,
  key_last4 text,
  key_fingerprint text,
  -- No ON DELETE: deleting a catalog entry a connection is pinned to must fail
  -- loud, the same as partner_llm_configs.catalog_entry_id.
  catalog_entry_id uuid REFERENCES public.llm_provider_catalog(id),
  base_url text,
  status text NOT NULL DEFAULT 'active',
  last_error text,
  verified_at timestamptz,
  config_version integer NOT NULL DEFAULT 1,
  connected_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  last_discovered_at timestamptz,
  discovery_error text,
  legacy_default_model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partner_ai_connections_id_partner_uq'
      AND conrelid = 'public.partner_ai_connections'::regclass
  ) THEN
    ALTER TABLE public.partner_ai_connections
      ADD CONSTRAINT partner_ai_connections_id_partner_uq UNIQUE (id, partner_id);
  END IF;
END $$;

ALTER TABLE public.partner_ai_connections DROP CONSTRAINT IF EXISTS partner_ai_connections_kind_chk;
ALTER TABLE public.partner_ai_connections ADD CONSTRAINT partner_ai_connections_kind_chk
  CHECK (kind IN ('anthropic_byok', 'catalog', 'openai_compatible'));

ALTER TABLE public.partner_ai_connections DROP CONSTRAINT IF EXISTS partner_ai_connections_status_chk;
ALTER TABLE public.partner_ai_connections ADD CONSTRAINT partner_ai_connections_status_chk
  CHECK (status IN ('active', 'error'));

ALTER TABLE public.partner_ai_connections DROP CONSTRAINT IF EXISTS partner_ai_connections_shape_chk;
ALTER TABLE public.partner_ai_connections ADD CONSTRAINT partner_ai_connections_shape_chk CHECK (
  -- catalog ⇔ a catalog entry
  (kind = 'catalog') = (catalog_entry_id IS NOT NULL)
  -- openai_compatible ⇔ a base URL (W06); Anthropic-dialect kinds never carry one
  AND (kind = 'openai_compatible') = (base_url IS NOT NULL)
  -- the Anthropic-dialect kinds always carry a key
  AND (kind NOT IN ('anthropic_byok', 'catalog') OR api_key_encrypted IS NOT NULL)
);

ALTER TABLE public.partner_ai_connections DROP CONSTRAINT IF EXISTS partner_ai_connections_key_triplet_chk;
ALTER TABLE public.partner_ai_connections ADD CONSTRAINT partner_ai_connections_key_triplet_chk
  CHECK (num_nulls(api_key_encrypted, key_last4, key_fingerprint) IN (0, 3));

ALTER TABLE public.partner_ai_connections DROP CONSTRAINT IF EXISTS partner_ai_connections_config_version_chk;
ALTER TABLE public.partner_ai_connections ADD CONSTRAINT partner_ai_connections_config_version_chk
  CHECK (config_version >= 1);

CREATE INDEX IF NOT EXISTS partner_ai_connections_partner_idx
  ON public.partner_ai_connections (partner_id);
CREATE UNIQUE INDEX IF NOT EXISTS partner_ai_connections_compat_uq
  ON public.partner_ai_connections (partner_id)
  WHERE kind IN ('anthropic_byok', 'catalog');

ALTER TABLE public.partner_ai_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_ai_connections FORCE ROW LEVEL SECURITY;

-- No TO clause (see the migration-owner note below): table privileges, not
-- the policy, are what restrict who can reach the table.
DROP POLICY IF EXISTS partner_ai_connections_partner_access ON public.partner_ai_connections;
CREATE POLICY partner_ai_connections_partner_access ON public.partner_ai_connections
  FOR ALL
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.partner_ai_connections TO breeze_app;

-- LEGACY UPDATE MIRROR. Every UPDATE of a partner_llm_configs row — the
-- /ai/provider facade's writes and the resolver's runtime
-- markPartnerLlmError (status='error', CAS on config_version) — is re-applied
-- to the same-id connection in the same statement, so GET /ai/provider (which
-- reads the registry) never shows a stale status/key/pin. Runs with the
-- writer's RLS (every legacy writer runs in system scope, or as the owning
-- partner, which may update its own connection). INSERT/DELETE are not
-- mirrored here: a delete must re-point assignments first, which only
-- services/aiModels/legacyReconcile.ts can do.
-- W02-ONLY SCAFFOLDING: W03 Task 6B stops all legacy writes and drops this
-- trigger (2026-11-19-100500-drop-partner-llm-configs-mirror-trigger.sql).
CREATE OR REPLACE FUNCTION public.partner_llm_configs_mirror_to_connection() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.partner_ai_connections AS c
     SET kind = CASE WHEN NEW.catalog_entry_id IS NULL THEN 'anthropic_byok' ELSE 'catalog' END,
         api_key_encrypted = NEW.api_key_encrypted,
         key_last4 = NEW.key_last4,
         key_fingerprint = NEW.key_fingerprint,
         catalog_entry_id = NEW.catalog_entry_id,
         status = NEW.status,
         last_error = NEW.last_error,
         verified_at = NEW.verified_at,
         config_version = NEW.config_version,
         connected_by = NEW.connected_by,
         legacy_default_model = NEW.default_model,
         updated_at = now()
   WHERE c.id = NEW.id;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS partner_llm_configs_mirror_to_connection ON public.partner_llm_configs;
CREATE TRIGGER partner_llm_configs_mirror_to_connection
  AFTER UPDATE ON public.partner_llm_configs
  FOR EACH ROW EXECUTE FUNCTION public.partner_llm_configs_mirror_to_connection();

-- MIGRATION-OWNER VISIBILITY. partner_llm_configs' only policy is
-- `... FOR ALL TO breeze_app` (2026-09-04). A role-restricted policy does not
-- apply to a NOBYPASSRLS migration owner, so under FORCE RLS the copy below
-- would SELECT zero rows even with breeze.scope = 'system' (measured on PG16
-- in 2026-10-09-000600-rls-scoped-replay-v0110.sql). This system-only policy
-- has no TO clause; it grants breeze_app nothing new (its own policy already
-- has the system branch) and confers no table privileges. Shape mirrors
-- ai_kill_state_system_only.
DROP POLICY IF EXISTS partner_llm_configs_system_only ON public.partner_llm_configs;
CREATE POLICY partner_llm_configs_system_only ON public.partner_llm_configs
  FOR ALL
  USING (public.breeze_current_scope() = 'system')
  WITH CHECK (public.breeze_current_scope() = 'system');

DO $copy$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  INSERT INTO public.partner_ai_connections (
    id, partner_id, kind, name,
    api_key_encrypted, key_last4, key_fingerprint,
    catalog_entry_id, status, last_error, verified_at, config_version,
    connected_by, legacy_default_model, created_at, updated_at
  )
  SELECT c.id,
         c.partner_id,
         CASE WHEN c.catalog_entry_id IS NULL THEN 'anthropic_byok' ELSE 'catalog' END,
         COALESCE(e.name, 'Anthropic API key'),
         c.api_key_encrypted, c.key_last4, c.key_fingerprint,
         c.catalog_entry_id, c.status, c.last_error, c.verified_at, c.config_version,
         c.connected_by, c.default_model, c.created_at, c.updated_at
    FROM public.partner_llm_configs AS c
    LEFT JOIN public.llm_provider_catalog AS e ON e.id = c.catalog_entry_id
  ON CONFLICT (id) DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'partner_ai_connections: copied % partner_llm_configs row(s) with id-preserving ciphertext', n;
  ELSE
    RAISE NOTICE 'partner_ai_connections: copied % partner_llm_configs row(s) with id-preserving ciphertext', n;
  END IF;
END $copy$;
```

- [ ] **Step 4: Write the Drizzle schema**

`apps/api/src/db/schema/aiModelRegistry.ts` (Tasks 3 and 4 append to this file):

```ts
// AI model registry (#7598) — the partner-owned half of the registry. W02
// (#7600) ships the tables; W03 cuts routing over. ai_platform_models (W01)
// is the system-wide half and lives in its own schema file.
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { llmProviderCatalog } from './llmProviderCatalog';
import { partners } from './orgs';
import { users } from './users';

export const PARTNER_AI_CONNECTION_KINDS = ['anthropic_byok', 'catalog', 'openai_compatible'] as const;
export type PartnerAiConnectionKind = (typeof PARTNER_AI_CONNECTION_KINDS)[number];

/**
 * Shape 3 (partner axis). `api_key_encrypted` is registered row-bound under
 * the legacy `partner_llm_configs.api_key_encrypted` AAD tag (copied rows keep
 * their id). `legacy_default_model` is the /ai/provider compat projection of
 * `partner_llm_configs.default_model`; nothing routes on it; dropped in W08.
 */
export const partnerAiConnections = pgTable('partner_ai_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<PartnerAiConnectionKind>().notNull(),
  name: text('name').notNull(),
  inferenceGeo: text('inference_geo'),
  providerConfig: jsonb('provider_config').$type<Record<string, unknown>>(),
  apiKeyEncrypted: text('api_key_encrypted'),
  keyLast4: text('key_last4'),
  keyFingerprint: text('key_fingerprint'),
  catalogEntryId: uuid('catalog_entry_id').references(() => llmProviderCatalog.id),
  baseUrl: text('base_url'),
  status: text('status', { enum: ['active', 'error'] }).notNull().default('active'),
  lastError: text('last_error'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  configVersion: integer('config_version').notNull().default(1),
  connectedBy: uuid('connected_by').references(() => users.id, { onDelete: 'set null' }),
  lastDiscoveredAt: timestamp('last_discovered_at', { withTimezone: true }),
  discoveryError: text('discovery_error'),
  legacyDefaultModel: text('legacy_default_model'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('partner_ai_connections_id_partner_uq').on(t.id, t.partnerId),
  index('partner_ai_connections_partner_idx').on(t.partnerId),
  uniqueIndex('partner_ai_connections_compat_uq').on(t.partnerId)
    .where(sql`${t.kind} IN ('anthropic_byok', 'catalog')`),
  check('partner_ai_connections_kind_chk', sql`${t.kind} IN ('anthropic_byok', 'catalog', 'openai_compatible')`),
  check('partner_ai_connections_status_chk', sql`${t.status} IN ('active', 'error')`),
  check('partner_ai_connections_shape_chk', sql`(${t.kind} = 'catalog') = (${t.catalogEntryId} IS NOT NULL) AND (${t.kind} = 'openai_compatible') = (${t.baseUrl} IS NOT NULL) AND (${t.kind} NOT IN ('anthropic_byok', 'catalog') OR ${t.apiKeyEncrypted} IS NOT NULL)`),
  check('partner_ai_connections_key_triplet_chk', sql`num_nulls(${t.apiKeyEncrypted}, ${t.keyLast4}, ${t.keyFingerprint}) IN (0, 3)`),
  check('partner_ai_connections_config_version_chk', sql`${t.configVersion} >= 1`),
]);

export type PartnerAiConnectionRow = typeof partnerAiConnections.$inferSelect;
```

Append `export * from './aiModelRegistry';` to `apps/api/src/db/schema/index.ts`.

- [ ] **Step 5: Register the encrypted column**

`apps/api/src/services/encryptedColumnRegistry.ts`, directly after the `partner_llm_configs` entry:

```ts
  // AI model registry W02 (#7600, quorum #13): partner_llm_configs rows were
  // copied to partner_ai_connections with the SAME id, so the AAD tag stays the
  // legacy column's logical identity and every stored ciphertext decrypts
  // unchanged (the #6379 moved-column precedent). Row-bound: a blob pasted into
  // another partner's connection does not decrypt. Both entries stay until W08
  // drops the legacy table, so the rotation walker re-seals both copies.
  { table: 'partner_ai_connections', column: 'api_key_encrypted', kind: 'text', aadBinding: 'row', aadTag: 'partner_llm_configs.api_key_encrypted', description: 'Per-partner AI connection key (#7600) — legacy partner_llm_configs AAD tag (id-preserving copy), bound to the row id' },
```

The walker (`reencryptRegisteredSecrets`) iterates the registry and threads `row.id` into `columnAad`. That is the whole "rotation walker update". The unit test above proves it re-seals under the right binding.

- [ ] **Step 6: Register in RLS coverage**

`apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, in `PARTNER_TENANT_TABLES`, directly after `['partner_llm_configs', 'partner_id'],`:

```ts
  // AI model registry W02 (#7600): partner_ai_connections — partner axis like
  // partner_llm_configs (rows copied with the same id); no org_id, so no
  // org-cascade / export-policy entry. No org-token read branch by design.
  ['partner_ai_connections', 'partner_id'],
```

- [ ] **Step 7: Write the shared fixtures and the integration suite (forgery + id-preserving decrypt)**

`apps/api/src/__tests__/integration/aiModelRegistryFixtures.ts` (Tasks 3, 4, 6 and 12 extend it):

```ts
/**
 * Shared seeds for the AI model registry integration suites (#7600 W02).
 * Seeds go through a superuser client (bypasses RLS); code under test goes
 * through `db` from ../../db (the breeze_app pool, FORCE RLS applies).
 * Not a test file: nothing here registers a describe/it.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { DbAccessContext } from '../../db';
import { columnAad, encryptedColumnRegistry, type EncryptedColumnSpec } from '../../services/encryptedColumnRegistry';
import { encryptSecret } from '../../services/secretCrypto';

export const fixtureSql = postgres(process.env.DATABASE_URL ?? '', { max: 1 });
export async function closeRegistryFixtures(): Promise<void> {
  await fixtureSql.end({ timeout: 5 });
}

export function partnerContext(partnerId: string, orgIds: string[] = []): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], currentPartnerId: partnerId, userId: null };
}

export function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], currentPartnerId: partnerId, userId: null };
}

export function keySpec(table: 'partner_llm_configs' | 'partner_ai_connections'): EncryptedColumnSpec {
  const found = encryptedColumnRegistry.find((s) => s.table === table && s.column === 'api_key_encrypted');
  if (!found) throw new Error(`${table}.api_key_encrypted is not registered`);
  return found;
}

/** Seeds a BYOK connection directly (superuser) and returns its id. */
export async function seedByokConnection(partnerId: string, id: string = randomUUID()): Promise<string> {
  const sealed = encryptSecret('sk-ant-api03-forgery-fixture-0000', { aad: columnAad(keySpec('partner_ai_connections'), id) });
  await fixtureSql`
    INSERT INTO partner_ai_connections (id, partner_id, kind, name, api_key_encrypted, key_last4, key_fingerprint)
    VALUES (${id}, ${partnerId}, 'anthropic_byok', 'Fixture key', ${sealed!}, '0000', 'fp-fixture')`;
  return id;
}
```

`apps/api/src/__tests__/integration/aiModelRegistryForgery.integration.test.ts` (Tasks 3 and 6 append `describe` blocks):

```ts
/**
 * AI model registry W02 (#7600): direct-SQL forgery and RLS proofs for every
 * registry table, composite FK and trigger, run through the breeze_app pool
 * (`db` from ../../db) so FORCE RLS applies.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { columnAad } from '../../services/encryptedColumnRegistry';
import { decryptSecret, encryptSecret } from '../../services/secretCrypto';
import { createOrganization, createPartner } from './db-utils';
import {
  closeRegistryFixtures,
  fixtureSql as adminSql,
  keySpec,
  orgContext,
  partnerContext,
  seedByokConnection,
} from './aiModelRegistryFixtures';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

const CONNECTIONS_MIGRATION = readFileSync(
  join(__dirname, '../../../migrations', '2026-11-14-100000-ai-model-registry-connections.sql'),
  'utf8',
);

describe.skipIf(!RUN)('partner_ai_connections (#7600 W02)', () => {
  it('partner A cannot INSERT a connection for partner B (42501)', async () => {
    const [a, b] = [await createPartner(), await createPartner()];
    await expect(withDbAccessContext(partnerContext(a.id), () => db.execute(sql`
      INSERT INTO partner_ai_connections (partner_id, kind, name, api_key_encrypted, key_last4, key_fingerprint)
      VALUES (${b.id}, 'anthropic_byok', 'forged', 'enc:x', 'x', 'x')`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('partner A cannot SELECT partner B connections, and an org token cannot read any', async () => {
    const [a, b] = [await createPartner(), await createPartner()];
    const orgB = await createOrganization({ partnerId: b.id });
    const id = await seedByokConnection(b.id);
    const asA = await withDbAccessContext(partnerContext(a.id), () =>
      db.execute(sql`SELECT id FROM partner_ai_connections WHERE id = ${id}`));
    const asOrgB = await withDbAccessContext(orgContext(orgB.id, b.id), () =>
      db.execute(sql`SELECT id FROM partner_ai_connections WHERE id = ${id}`));
    expect([...asA]).toEqual([]);
    expect([...asOrgB]).toEqual([]);
  });

  it('rejects a catalog connection without a catalog entry (23514)', async () => {
    const p = await createPartner();
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO partner_ai_connections (partner_id, kind, name, api_key_encrypted, key_last4, key_fingerprint)
      VALUES (${p.id}, 'catalog', 'no entry', 'enc:x', 'x', 'x')`)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('copies a legacy config with the same id and byte-identical ciphertext that still decrypts (quorum #13)', async () => {
    const partner = await createPartner();
    const legacyId = randomUUID();
    const plaintext = 'sk-ant-api03-pre-migration-key-4242';
    const sealed = encryptSecret(plaintext, { aad: columnAad(keySpec('partner_llm_configs'), legacyId) });
    expect(sealed).toBeTruthy();
    await adminSql`
      INSERT INTO partner_llm_configs (id, partner_id, api_key_encrypted, key_last4, key_fingerprint, default_model)
      VALUES (${legacyId}, ${partner.id}, ${sealed!}, '4242', 'fp-legacy', NULL)`;

    await adminSql.unsafe(CONNECTIONS_MIGRATION);

    const [row] = await adminSql`SELECT * FROM partner_ai_connections WHERE id = ${legacyId}`;
    expect(row).toMatchObject({
      partner_id: partner.id,
      kind: 'anthropic_byok',
      api_key_encrypted: sealed,
      key_last4: '4242',
      legacy_default_model: null,
      status: 'active',
    });
    expect(decryptSecret(String(row!.api_key_encrypted), { aad: columnAad(keySpec('partner_ai_connections'), legacyId) }))
      .toBe(plaintext);
    expect(() => decryptSecret(String(row!.api_key_encrypted), { aad: columnAad(keySpec('partner_ai_connections'), randomUUID()) }))
      .toThrow();

    // Re-applying is a no-op.
    await adminSql.unsafe(CONNECTIONS_MIGRATION);
    const [count] = await adminSql`SELECT count(*)::int AS n FROM partner_ai_connections WHERE partner_id = ${partner.id}`;
    expect(count!.n).toBe(1);
  });

  it('enforces one compat (anthropic_byok|catalog) connection per partner during W02–W03 (23505)', async () => {
    const p = await createPartner();
    await seedByokConnection(p.id);
    await expect(seedByokConnection(p.id)).rejects.toMatchObject({ code: '23505' });
  });

  it('a legacy UPDATE (e.g. markPartnerLlmError) is mirrored onto the same-id connection in the same statement', async () => {
    const partner = await createPartner();
    const legacyId = randomUUID();
    const sealed = encryptSecret('sk-ant-api03-mirror-5151', { aad: columnAad(keySpec('partner_llm_configs'), legacyId) })!;
    await adminSql`INSERT INTO partner_llm_configs (id, partner_id, api_key_encrypted, key_last4, key_fingerprint)
                   VALUES (${legacyId}, ${partner.id}, ${sealed}, '5151', 'fp')`;
    await adminSql.unsafe(CONNECTIONS_MIGRATION);
    await withSystemDbAccessContext(() => db.execute(sql`
      UPDATE partner_llm_configs SET status = 'error', last_error = 'auth_rejected' WHERE id = ${legacyId} AND config_version = 1`));
    const [row] = await adminSql`SELECT status, last_error FROM partner_ai_connections WHERE id = ${legacyId}`;
    expect(row).toEqual({ status: 'error', last_error: 'auth_rejected' });
  });

  it('the copy works for a NOSUPERUSER NOBYPASSRLS role under system scope (no role-restricted-policy blind spot)', async () => {
    // A non-owner, non-breeze_app role is always subject to RLS, so it proves
    // what a NOBYPASSRLS migration owner would see: only policies without a
    // TO clause apply to it.
    const partner = await createPartner();
    const legacyId = randomUUID();
    const sealed = encryptSecret('sk-ant-api03-probe-role-7777', { aad: columnAad(keySpec('partner_llm_configs'), legacyId) })!;
    await adminSql`
      INSERT INTO partner_llm_configs (id, partner_id, api_key_encrypted, key_last4, key_fingerprint)
      VALUES (${legacyId}, ${partner.id}, ${sealed}, '7777', 'fp-probe')`;
    const copyBlock = CONNECTIONS_MIGRATION.slice(CONNECTIONS_MIGRATION.indexOf('DO $copy$'));
    await adminSql.begin(async (tx) => {
      await tx.unsafe(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'w02_rls_probe') THEN
          CREATE ROLE w02_rls_probe NOLOGIN NOSUPERUSER NOBYPASSRLS;
        END IF; END $$`);
      await tx.unsafe('GRANT SELECT ON partner_llm_configs, llm_provider_catalog TO w02_rls_probe');
      await tx.unsafe('GRANT SELECT, INSERT ON partner_ai_connections TO w02_rls_probe');
      await tx.unsafe('SET LOCAL ROLE w02_rls_probe');
      await tx.unsafe(copyBlock);
    });
    const [row] = await adminSql`SELECT api_key_encrypted FROM partner_ai_connections WHERE id = ${legacyId}`;
    expect(row?.api_key_encrypted).toBe(sealed);
  });
});
```

(`seedByokConnection` uses the superuser client directly, so its error is the bare postgres.js error: `code` sits on the error, not on `.cause`.)

- [ ] **Step 8: Run unit + integration + RLS coverage**

```bash
cd apps/api && npx vitest run src/db/schema/aiModelRegistry.contract.test.ts src/services/encryptedColumnRegistry.test.ts
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelRegistryForgery.integration.test.ts
cd apps/api && DB_CONTEXTLESS_WRITE_STRICT=true pnpm test:rls-coverage
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

Expected:
- unit and integration: PASS (5 integration tests);
- rls-coverage: PASS, with `partner_ai_connections` classified as a partner table whose four commands are covered by `breeze_has_partner_access`;
- tsc: clean.

- [ ] **Step 9: Commit**

```bash
git add apps/api/migrations/2026-11-14-100000-ai-model-registry-connections.sql apps/api/src/db/schema/aiModelRegistry.ts \
  apps/api/src/db/schema/aiModelRegistry.contract.test.ts apps/api/src/db/schema/index.ts \
  apps/api/src/services/encryptedColumnRegistry.ts apps/api/src/services/encryptedColumnRegistry.test.ts \
  apps/api/src/__tests__/integration/rls-coverage.integration.test.ts \
  apps/api/src/__tests__/integration/aiModelRegistryFixtures.ts \
  apps/api/src/__tests__/integration/aiModelRegistryForgery.integration.test.ts
git commit -m "feat(ai): partner_ai_connections with an id-preserving copy of partner_llm_configs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: `partner_ai_models` — offerings, platform-shape CHECKs, composite FKs, org read branch (migration + schema; unit + integration)

**Files:**
- Create: `apps/api/migrations/2026-11-14-100100-ai-model-registry-offerings.sql`
- Modify: `apps/api/src/db/schema/aiModelRegistry.ts` (append)
- Modify: `apps/api/src/db/schema/aiModelRegistry.contract.test.ts` (append)
- Modify: `apps/api/src/__tests__/integration/aiModelRegistryFixtures.ts` (append `seedPlatformModel`, `seedOffering`)
- Modify: `apps/api/src/__tests__/integration/aiModelRegistryForgery.integration.test.ts` (append)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`PARTNER_TENANT_TABLES`, after the Task 2 entry)

**Interfaces:**
- Consumes:
  - `partner_ai_connections_id_partner_uq` (Task 2);
  - `ai_platform_models(id)` (W01).
- Produces:
  - table `partner_ai_models` with `UNIQUE (id, partner_id)` (`partner_ai_models_id_partner_uq`), the composite target for Tasks 4 and 6;
  - Drizzle `partnerAiModels`, `type PartnerAiModelRow`, `PARTNER_AI_MODEL_SOURCES = ['platform', 'discovered', 'manual', 'catalog'] as const`. Lifecycle reuses W01's shared `MODEL_LIFECYCLES` / `ModelLifecycle`;
  - partial unique indexes:
    - `partner_ai_models_platform_uq (partner_id, platform_model_id) WHERE connection_id IS NULL`
    - `partner_ai_models_connection_model_uq (connection_id, model_id) WHERE connection_id IS NOT NULL`

    Task 12's upserts target exactly these, with `targetWhere`.
  - **Invariants:**
    - `id`, `partner_id` and `connection_id` are immutable after insert (the assignment arrays reference offerings without an FK, so an ownership move must be impossible, not merely FK-checked).
    - A refusal fallback is an EXISTING offering of the same partner on the same connection (both NULL counts as the same connection), and never the offering itself. A fallback that doesn't exist yet is rejected, so a multi-row INSERT can't forward-reference a row the BEFORE trigger can't see; link fallbacks after both offerings exist.

- [ ] **Step 1: Write the failing contract test**

Append to `apps/api/src/db/schema/aiModelRegistry.contract.test.ts`:

```ts
import { MODEL_LIFECYCLES } from '@breeze/shared';
import { PARTNER_AI_MODEL_SOURCES } from './aiModelRegistry';

describe('partner_ai_models contract (#7600 W02)', () => {
  const sqlText = readMigration('2026-11-14-100100-ai-model-registry-offerings.sql');

  it('source and lifecycle CHECKs list exactly the Drizzle literals', () => {
    expect(checkLiterals(sqlText, 'source')).toEqual([...PARTNER_AI_MODEL_SOURCES]);
    expect(checkLiterals(sqlText, 'lifecycle')).toEqual([...MODEL_LIFECYCLES]);
  });

  it('the org-token branch is a separate FOR SELECT policy on enabled rows of the caller partner', () => {
    expect(sqlText).toMatch(
      /CREATE POLICY partner_ai_models_org_read_enabled\s+ON public\.partner_ai_models\s+FOR SELECT\s+USING \(enabled AND partner_id = public\.breeze_current_partner_id\(\)\);/,
    );
    // Never appended to the FOR ALL policy.
    const forAll = sqlText.slice(sqlText.indexOf('CREATE POLICY partner_ai_models_partner_access'));
    expect(forAll.slice(0, forAll.indexOf(');') + 2)).not.toMatch(/breeze_current_partner_id/);
  });

  it('the connection FK is composite and cascades', () => {
    expect(sqlText).toMatch(/FOREIGN KEY \(connection_id, partner_id\)\s+REFERENCES public\.partner_ai_connections \(id, partner_id\) ON DELETE CASCADE/);
    expect(sqlText).toMatch(/FOREIGN KEY \(refusal_fallback_offering_id, partner_id\)\s+REFERENCES public\.partner_ai_models \(id, partner_id\)/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/db/schema/aiModelRegistry.contract.test.ts`
Expected: FAIL. `PARTNER_AI_MODEL_SOURCES` is undefined and the migration file is missing.

- [ ] **Step 3: Write the migration**

`apps/api/migrations/2026-11-14-100100-ai-model-registry-offerings.sql`:

```sql
-- AI model registry W02 (#7600, spec §5.3): partner_ai_models — the models a
-- partner can use, each through exactly one connection.
--
-- TENANCY: shape 3 (partner axis). FOR ALL on breeze_has_partner_access, plus
-- ONE separate, additive FOR SELECT policy for org tokens (quorum #12): the
-- chat picker runs under org tokens, which never pass breeze_has_partner_access.
-- The branch reads ENABLED rows of the caller's own partner only, through
-- breeze_current_partner_id() (populated for every scope, including agent
-- tokens — a device can therefore read its partner's enabled offerings: model
-- ids, display names, prices, permission keys; no secrets). It is never
-- appended to the FOR ALL policy: Postgres never consults FOR SELECT policies
-- when computing UPDATE/DELETE targets, so org tokens cannot modify offerings.
-- Listed in PARTNER_TENANT_TABLES.
--
-- PLATFORM IDENTITY IS DERIVED (quorum #2): a platform offering
-- (connection_id NULL) carries ONLY platform_model_id. Wire id, capabilities
-- and price are always read from ai_platform_models, never copied.
-- A catalog offering carries only its logical model_id; endpoint, wire id,
-- price and verification resolve live from the connection's current authorized
-- catalog revision (quorum #7), so it copies no price or capabilities either.
--
-- CROSS-TENANT REFERENCES ARE COMPOSITE FKs (quorum #1):
--   (connection_id, partner_id) -> partner_ai_connections(id, partner_id) CASCADE
--   (refusal_fallback_offering_id, partner_id) -> partner_ai_models(id, partner_id)
-- partner_ai_models_integrity_guard additionally keeps id / partner_id /
-- connection_id immutable (assignment arrays reference offerings without an FK)
-- and requires the refusal fallback to EXIST, fail-closed, on the SAME
-- connection (same destination + funding). Fail-closed matters: a BEFORE
-- trigger can't see a row inserted later in the same multi-row statement,
-- while the (immediate, end-of-statement) FK can.
-- Fallback eligibility (enabled, priced) is checked by the app at write and by
-- the resolver at dispatch (W03).
--
-- Idempotent. Writes no rows (no breeze.scope elevation needed).

CREATE TABLE IF NOT EXISTS public.partner_ai_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  connection_id uuid,
  platform_model_id uuid REFERENCES public.ai_platform_models(id),
  model_id text,
  source text NOT NULL,
  display_name text,
  capabilities jsonb,
  price_input_cents_per_m numeric(20, 6),
  price_output_cents_per_m numeric(20, 6),
  price_cache_read_cents_per_m numeric(20, 6),
  price_cache_write_cents_per_m numeric(20, 6),
  enabled boolean NOT NULL DEFAULT false,
  default_options jsonb,
  allowed_options jsonb,
  required_permission text,
  refusal_fallback_offering_id uuid,
  lifecycle text NOT NULL DEFAULT 'available',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partner_ai_models_id_partner_uq'
      AND conrelid = 'public.partner_ai_models'::regclass
  ) THEN
    ALTER TABLE public.partner_ai_models
      ADD CONSTRAINT partner_ai_models_id_partner_uq UNIQUE (id, partner_id);
  END IF;
END $$;

ALTER TABLE public.partner_ai_models DROP CONSTRAINT IF EXISTS partner_ai_models_connection_fk;
ALTER TABLE public.partner_ai_models ADD CONSTRAINT partner_ai_models_connection_fk
  FOREIGN KEY (connection_id, partner_id)
  REFERENCES public.partner_ai_connections (id, partner_id) ON DELETE CASCADE;

ALTER TABLE public.partner_ai_models DROP CONSTRAINT IF EXISTS partner_ai_models_refusal_fallback_fk;
ALTER TABLE public.partner_ai_models ADD CONSTRAINT partner_ai_models_refusal_fallback_fk
  FOREIGN KEY (refusal_fallback_offering_id, partner_id)
  REFERENCES public.partner_ai_models (id, partner_id);

ALTER TABLE public.partner_ai_models DROP CONSTRAINT IF EXISTS partner_ai_models_source_chk;
ALTER TABLE public.partner_ai_models ADD CONSTRAINT partner_ai_models_source_chk
  CHECK (source IN ('platform', 'discovered', 'manual', 'catalog'));

ALTER TABLE public.partner_ai_models DROP CONSTRAINT IF EXISTS partner_ai_models_lifecycle_chk;
ALTER TABLE public.partner_ai_models ADD CONSTRAINT partner_ai_models_lifecycle_chk
  CHECK (lifecycle IN ('available', 'missing', 'retired'));

ALTER TABLE public.partner_ai_models DROP CONSTRAINT IF EXISTS partner_ai_models_platform_shape_chk;
ALTER TABLE public.partner_ai_models ADD CONSTRAINT partner_ai_models_platform_shape_chk CHECK (
  -- platform offering ⇔ no connection ⇔ source 'platform'
  (source = 'platform') = (connection_id IS NULL)
  -- a platform offering carries nothing but the platform row (quorum #2)
  AND (source <> 'platform' OR (
        platform_model_id IS NOT NULL
        AND model_id IS NULL
        AND capabilities IS NULL
        AND num_nonnulls(price_input_cents_per_m, price_output_cents_per_m,
                         price_cache_read_cents_per_m, price_cache_write_cents_per_m) = 0))
  -- every connection offering names its wire / logical id
  AND (source = 'platform' OR model_id IS NOT NULL)
);

ALTER TABLE public.partner_ai_models DROP CONSTRAINT IF EXISTS partner_ai_models_catalog_shape_chk;
ALTER TABLE public.partner_ai_models ADD CONSTRAINT partner_ai_models_catalog_shape_chk CHECK (
  source <> 'catalog' OR (
    platform_model_id IS NULL
    AND capabilities IS NULL
    AND num_nonnulls(price_input_cents_per_m, price_output_cents_per_m,
                     price_cache_read_cents_per_m, price_cache_write_cents_per_m) = 0)
);

ALTER TABLE public.partner_ai_models DROP CONSTRAINT IF EXISTS partner_ai_models_price_chk;
ALTER TABLE public.partner_ai_models ADD CONSTRAINT partner_ai_models_price_chk CHECK (
  num_nulls(price_input_cents_per_m, price_output_cents_per_m,
            price_cache_read_cents_per_m, price_cache_write_cents_per_m) IN (0, 4)
  AND COALESCE(price_input_cents_per_m, 0) >= 0
  AND COALESCE(price_output_cents_per_m, 0) >= 0
  AND COALESCE(price_cache_read_cents_per_m, 0) >= 0
  AND COALESCE(price_cache_write_cents_per_m, 0) >= 0
);

ALTER TABLE public.partner_ai_models DROP CONSTRAINT IF EXISTS partner_ai_models_options_shape_chk;
ALTER TABLE public.partner_ai_models ADD CONSTRAINT partner_ai_models_options_shape_chk CHECK (
  (default_options IS NULL OR jsonb_typeof(default_options) = 'object')
  AND (allowed_options IS NULL OR jsonb_typeof(allowed_options) = 'object')
  AND (required_permission IS NULL OR required_permission ~ '^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$')
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_ai_models_platform_uq
  ON public.partner_ai_models (partner_id, platform_model_id)
  WHERE connection_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS partner_ai_models_connection_model_uq
  ON public.partner_ai_models (connection_id, model_id)
  WHERE connection_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS partner_ai_models_partner_idx ON public.partner_ai_models (partner_id);
CREATE INDEX IF NOT EXISTS partner_ai_models_platform_model_idx
  ON public.partner_ai_models (platform_model_id) WHERE platform_model_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS partner_ai_models_refusal_fallback_idx
  ON public.partner_ai_models (refusal_fallback_offering_id) WHERE refusal_fallback_offering_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.partner_ai_models_integrity_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  fb_connection uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND (
       NEW.id IS DISTINCT FROM OLD.id
       OR NEW.partner_id IS DISTINCT FROM OLD.partner_id
       OR NEW.connection_id IS DISTINCT FROM OLD.connection_id) THEN
    RAISE EXCEPTION 'partner_ai_models id, partner_id and connection_id are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.refusal_fallback_offering_id IS NOT NULL THEN
    IF NEW.refusal_fallback_offering_id = NEW.id THEN
      RAISE EXCEPTION 'an offering cannot be its own refusal fallback' USING ERRCODE = '23514';
    END IF;
    -- Runs with the writer's RLS: a writer can only name a fallback it can see.
    -- FAIL CLOSED: a fallback that isn't visible yet (another partner's, or a
    -- row later in the same multi-row INSERT) is rejected here.
    SELECT m.connection_id INTO fb_connection
      FROM public.partner_ai_models AS m
     WHERE m.id = NEW.refusal_fallback_offering_id
       AND m.partner_id = NEW.partner_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'refusal fallback % is not an existing offering of this partner', NEW.refusal_fallback_offering_id
        USING ERRCODE = '23503';
    END IF;
    IF fb_connection IS DISTINCT FROM NEW.connection_id THEN
      RAISE EXCEPTION 'a refusal fallback must be on the same connection as its offering'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS partner_ai_models_integrity_guard ON public.partner_ai_models;
CREATE TRIGGER partner_ai_models_integrity_guard
  BEFORE INSERT OR UPDATE OF id, partner_id, connection_id, refusal_fallback_offering_id ON public.partner_ai_models
  FOR EACH ROW EXECUTE FUNCTION public.partner_ai_models_integrity_guard();

ALTER TABLE public.partner_ai_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_ai_models FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_ai_models_partner_access ON public.partner_ai_models;
CREATE POLICY partner_ai_models_partner_access ON public.partner_ai_models
  FOR ALL
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  );

DROP POLICY IF EXISTS partner_ai_models_org_read_enabled ON public.partner_ai_models;
CREATE POLICY partner_ai_models_org_read_enabled
  ON public.partner_ai_models
  FOR SELECT
  USING (enabled AND partner_id = public.breeze_current_partner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.partner_ai_models TO breeze_app;
```

- [ ] **Step 4: Append the Drizzle table**

Append to `apps/api/src/db/schema/aiModelRegistry.ts`. Extend the existing imports with `boolean`, `foreignKey`, `numeric`, and the W01 table `aiPlatformModels` from `./aiPlatformModels`. Use whatever file and export Task 0 confirmed.

```ts
import type { ModelLifecycle } from '@breeze/shared';
import { aiPlatformModels } from './aiPlatformModels';

export const PARTNER_AI_MODEL_SOURCES = ['platform', 'discovered', 'manual', 'catalog'] as const;
export type PartnerAiModelSource = (typeof PARTNER_AI_MODEL_SOURCES)[number];

const priceColumn = (name: string) => numeric(name, { precision: 20, scale: 6, mode: 'number' });

/**
 * Shape 3 (partner axis) + a SELECT-only org-token branch on enabled rows
 * (`partner_ai_models_org_read_enabled`). Platform offerings carry only
 * `platformModelId`; catalog offerings carry only `modelId` (spec §5.3).
 */
export const partnerAiModels = pgTable('partner_ai_models', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id'),
  platformModelId: uuid('platform_model_id').references(() => aiPlatformModels.id),
  modelId: text('model_id'),
  source: text('source').$type<PartnerAiModelSource>().notNull(),
  displayName: text('display_name'),
  capabilities: jsonb('capabilities').$type<Record<string, unknown>>(),
  priceInputCentsPerM: priceColumn('price_input_cents_per_m'),
  priceOutputCentsPerM: priceColumn('price_output_cents_per_m'),
  priceCacheReadCentsPerM: priceColumn('price_cache_read_cents_per_m'),
  priceCacheWriteCentsPerM: priceColumn('price_cache_write_cents_per_m'),
  enabled: boolean('enabled').notNull().default(false),
  defaultOptions: jsonb('default_options').$type<Record<string, unknown>>(),
  allowedOptions: jsonb('allowed_options').$type<Record<string, unknown>>(),
  requiredPermission: text('required_permission'),
  refusalFallbackOfferingId: uuid('refusal_fallback_offering_id'),
  lifecycle: text('lifecycle').$type<ModelLifecycle>().notNull().default('available'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('partner_ai_models_id_partner_uq').on(t.id, t.partnerId),
  foreignKey({
    columns: [t.connectionId, t.partnerId],
    foreignColumns: [partnerAiConnections.id, partnerAiConnections.partnerId],
    name: 'partner_ai_models_connection_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.refusalFallbackOfferingId, t.partnerId],
    foreignColumns: [t.id, t.partnerId],
    name: 'partner_ai_models_refusal_fallback_fk',
  }),
  uniqueIndex('partner_ai_models_platform_uq').on(t.partnerId, t.platformModelId).where(sql`${t.connectionId} IS NULL`),
  uniqueIndex('partner_ai_models_connection_model_uq').on(t.connectionId, t.modelId).where(sql`${t.connectionId} IS NOT NULL`),
  index('partner_ai_models_partner_idx').on(t.partnerId),
  index('partner_ai_models_platform_model_idx').on(t.platformModelId).where(sql`${t.platformModelId} IS NOT NULL`),
  index('partner_ai_models_refusal_fallback_idx').on(t.refusalFallbackOfferingId).where(sql`${t.refusalFallbackOfferingId} IS NOT NULL`),
  check('partner_ai_models_source_chk', sql`${t.source} IN ('platform', 'discovered', 'manual', 'catalog')`),
  check('partner_ai_models_lifecycle_chk', sql`${t.lifecycle} IN ('available', 'missing', 'retired')`),
]);

export type PartnerAiModelRow = typeof partnerAiModels.$inferSelect;
```

The remaining CHECKs (`platform_shape`, `catalog_shape`, `price`, `options_shape`) live in SQL only, matching how `partnerLlmConfigs` keeps some CHECKs SQL-only. `pnpm db:check-drift` (Task 17) is the arbiter. If drift reports them missing, add the same `check(...)` entries here, copying the SQL bodies verbatim.

- [ ] **Step 5: Register in RLS coverage**

In `PARTNER_TENANT_TABLES`, directly after the Task 2 entry:

```ts
  // partner_ai_models (#7600 W02): partner axis + a SEPARATE FOR SELECT
  // org-token branch partner_ai_models_org_read_enabled
  // (enabled AND partner_id = breeze_current_partner_id()). Forge proofs:
  // aiModelRegistryForgery.integration.test.ts.
  ['partner_ai_models', 'partner_id'],
```

- [ ] **Step 6: Extend the fixtures and append the forgery suite**

Append to `aiModelRegistryFixtures.ts`:

```ts
/** Seeds an ai_platform_models row with a per-test unique model id (W01 defaults fill the rest). */
export async function seedPlatformModel(modelId = `w02-test-${randomUUID()}`): Promise<string> {
  const [row] = await fixtureSql`
    INSERT INTO ai_platform_models (provider, model_id, display_name)
    VALUES ('anthropic', ${modelId}, ${modelId})
    RETURNING id`;
  return String(row!.id);
}

export async function seedOffering(input: {
  partnerId: string;
  connectionId?: string | null;
  platformModelId?: string | null;
  modelId?: string | null;
  source?: 'platform' | 'discovered' | 'manual' | 'catalog';
  enabled?: boolean;
}): Promise<string> {
  const [row] = await fixtureSql`
    INSERT INTO partner_ai_models (partner_id, connection_id, platform_model_id, model_id, source, enabled)
    VALUES (${input.partnerId}, ${input.connectionId ?? null}, ${input.platformModelId ?? null},
            ${input.modelId ?? null}, ${input.source ?? (input.connectionId ? 'manual' : 'platform')},
            ${input.enabled ?? true})
    RETURNING id`;
  return String(row!.id);
}
```

Append to `aiModelRegistryForgery.integration.test.ts` (and add `seedOffering`, `seedPlatformModel` to its fixtures import):

```ts
describe.skipIf(!RUN)('partner_ai_models (#7600 W02)', () => {
  it('an offering cannot point at another partner\'s connection (23503 composite FK)', async () => {
    const [a, b] = [await createPartner(), await createPartner()];
    const connB = await seedByokConnection(b.id);
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO partner_ai_models (partner_id, connection_id, model_id, source)
      VALUES (${a.id}, ${connB}, 'claude-sonnet-5-5', 'manual')`)))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'partner_ai_models_connection_fk' } });
  });

  it('partner A cannot INSERT an offering for partner B (42501)', async () => {
    const [a, b] = [await createPartner(), await createPartner()];
    const platformModelId = await seedPlatformModel();
    await expect(withDbAccessContext(partnerContext(a.id), () => db.execute(sql`
      INSERT INTO partner_ai_models (partner_id, platform_model_id, source)
      VALUES (${b.id}, ${platformModelId}, 'platform')`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it.each([
    ['a connection offering claiming source platform', (p: string, c: string, pm: string) => sql`
      INSERT INTO partner_ai_models (partner_id, connection_id, platform_model_id, source) VALUES (${p}, ${c}, ${pm}, 'platform')`],
    ['a platform offering with a copied price', (p: string, _c: string, pm: string) => sql`
      INSERT INTO partner_ai_models (partner_id, platform_model_id, source, price_input_cents_per_m, price_output_cents_per_m, price_cache_read_cents_per_m, price_cache_write_cents_per_m)
      VALUES (${p}, ${pm}, 'platform', 1, 1, 1, 1)`],
    ['a platform offering with a wire id', (p: string, _c: string, pm: string) => sql`
      INSERT INTO partner_ai_models (partner_id, platform_model_id, model_id, source) VALUES (${p}, ${pm}, 'claude-x', 'platform')`],
    ['a connection offering without a model id', (p: string, c: string) => sql`
      INSERT INTO partner_ai_models (partner_id, connection_id, source) VALUES (${p}, ${c}, 'manual')`],
    ['a partial price', (p: string, c: string) => sql`
      INSERT INTO partner_ai_models (partner_id, connection_id, model_id, source, price_input_cents_per_m) VALUES (${p}, ${c}, 'm', 'manual', 1)`],
    ['a catalog offering with a price', (p: string, c: string) => sql`
      INSERT INTO partner_ai_models (partner_id, connection_id, model_id, source, price_input_cents_per_m, price_output_cents_per_m, price_cache_read_cents_per_m, price_cache_write_cents_per_m)
      VALUES (${p}, ${c}, 'claude-x', 'catalog', 1, 1, 1, 1)`],
  ])('rejects %s (23514)', async (_label, statement) => {
    const p = await createPartner();
    const c = await seedByokConnection(p.id);
    const pm = await seedPlatformModel();
    await expect(withSystemDbAccessContext(() => db.execute(statement(p.id, c, pm))))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('a refusal fallback must belong to the same partner (23503) and sit on the same connection (23514)', async () => {
    const [a, b] = [await createPartner(), await createPartner()];
    const connA = await seedByokConnection(a.id);
    const byokA = await seedOffering({ partnerId: a.id, connectionId: connA, modelId: 'claude-opus-5-5' });
    const platformA = await seedOffering({ partnerId: a.id, platformModelId: await seedPlatformModel() });
    const platformB = await seedOffering({ partnerId: b.id, platformModelId: await seedPlatformModel() });

    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE partner_ai_models SET refusal_fallback_offering_id = ${platformB} WHERE id = ${byokA}`)))
      .rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE partner_ai_models SET refusal_fallback_offering_id = ${platformA} WHERE id = ${byokA}`)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE partner_ai_models SET refusal_fallback_offering_id = ${byokA} WHERE id = ${byokA}`)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('rejects a fallback forward-referenced within one multi-row INSERT (fail-closed, 23503)', async () => {
    const p = await createPartner();
    const conn = await seedByokConnection(p.id);
    const pm = await seedPlatformModel();
    const [byokId, platformId] = [randomUUID(), randomUUID()];
    // Row 1 (BYOK) names row 2 (platform) as its fallback: different connections.
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO partner_ai_models (id, partner_id, connection_id, model_id, source, refusal_fallback_offering_id, platform_model_id)
      VALUES (${byokId}, ${p.id}, ${conn}, 'claude-opus-5-5', 'manual', ${platformId}, NULL),
             (${platformId}, ${p.id}, NULL, NULL, 'platform', NULL, ${pm})`)))
      .rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('id and partner_id are immutable (23514), so an offering can never move partners under an assignment array', async () => {
    const [p, q] = [await createPartner(), await createPartner()];
    const off = await seedOffering({ partnerId: p.id, platformModelId: await seedPlatformModel() });
    await expect(withSystemDbAccessContext(() => db.execute(sql`UPDATE partner_ai_models SET partner_id = ${q.id} WHERE id = ${off}`)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(withSystemDbAccessContext(() => db.execute(sql`UPDATE partner_ai_models SET id = ${randomUUID()} WHERE id = ${off}`)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('connection_id is immutable (23514)', async () => {
    const p = await createPartner();
    const c = await seedByokConnection(p.id);
    const offering = await seedOffering({ partnerId: p.id, connectionId: c, modelId: 'claude-haiku-4-5' });
    const pm = await seedPlatformModel();
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE partner_ai_models SET connection_id = NULL, source = 'platform', model_id = NULL,
             platform_model_id = ${pm} WHERE id = ${offering}`)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('an org token reads only ENABLED offerings of its own partner and can modify none', async () => {
    const [p, q] = [await createPartner(), await createPartner()];
    const org = await createOrganization({ partnerId: p.id });
    const enabledP = await seedOffering({ partnerId: p.id, platformModelId: await seedPlatformModel(), enabled: true });
    await seedOffering({ partnerId: p.id, platformModelId: await seedPlatformModel(), enabled: false });
    await seedOffering({ partnerId: q.id, platformModelId: await seedPlatformModel(), enabled: true });

    const visible = await withDbAccessContext(orgContext(org.id, p.id), () =>
      db.execute(sql`SELECT id FROM partner_ai_models ORDER BY id`));
    expect([...visible].map((r) => (r as { id: string }).id)).toEqual([enabledP]);

    const updated = await withDbAccessContext(orgContext(org.id, p.id), () =>
      db.execute(sql`UPDATE partner_ai_models SET enabled = false WHERE id = ${enabledP} RETURNING id`));
    expect([...updated]).toEqual([]);
  });

  it('deleting a connection cascades its offerings', async () => {
    const p = await createPartner();
    const c = await seedByokConnection(p.id);
    await seedOffering({ partnerId: p.id, connectionId: c, modelId: 'claude-sonnet-5-5' });
    await adminSql`DELETE FROM partner_ai_connections WHERE id = ${c}`;
    const [left] = await adminSql`SELECT count(*)::int AS n FROM partner_ai_models WHERE connection_id = ${c}`;
    expect(left!.n).toBe(0);
  });
});
```

If W01's `ai_platform_models` has a NOT NULL column without a default beyond `provider`/`model_id`/`display_name`, add it to `seedPlatformModel`. Task 0 records which.

- [ ] **Step 7: Run unit + integration + RLS coverage**

```bash
cd apps/api && npx vitest run src/db/schema/aiModelRegistry.contract.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelRegistryForgery.integration.test.ts
cd apps/api && DB_CONTEXTLESS_WRITE_STRICT=true pnpm test:rls-coverage
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

Expected: PASS everywhere. The forgery file reports 5 + 12 tests (the `it.each` expands to 6).

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/2026-11-14-100100-ai-model-registry-offerings.sql apps/api/src/db/schema/aiModelRegistry.ts \
  apps/api/src/db/schema/aiModelRegistry.contract.test.ts \
  apps/api/src/__tests__/integration/aiModelRegistryFixtures.ts \
  apps/api/src/__tests__/integration/aiModelRegistryForgery.integration.test.ts \
  apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(ai): partner_ai_models offerings with composite FKs and an enabled-only org read branch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: `ai_model_assignments` — partner-wide first, ownership trigger, full registration (migration + schema; unit + integration)

**Files:**
- Create: `apps/api/migrations/2026-11-14-100200-ai-model-registry-assignments.sql`
- Create: `apps/api/src/__tests__/integration/aiModelAssignmentsPartnerRls.integration.test.ts`
- Modify: `apps/api/src/db/schema/aiModelRegistry.ts` (append)
- Modify: `apps/api/src/db/schema/aiModelRegistry.contract.test.ts` (append)
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`, directly after `'ai_cost_usage',` ~:293)
- Modify: `apps/api/src/services/orgMergeRegistry.ts` (`SPECIAL`, next to `ai_cost_usage` ~:522)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (directly after the `"ai_cost_usage"` entry ~:93)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`DUAL_AXIS_TENANT_TABLES` after `'ai_script_policies',` ~:466; `XOR_OWNERSHIP_DUAL_AXIS_TABLES` after `'ai_script_policies',` ~:809)

**Interfaces:**
- Consumes: `partner_ai_models_id_partner_uq` (Task 3); `organizations_id_partner_uq`; `AI_SURFACES`, `AI_SURFACE_ROLES` from `@breeze/shared`.
- Produces:
  - table `ai_model_assignments` (spec §5.4) with:
    - partial unique indexes `ai_model_assignments_partner_uq (partner_id, surface, role) WHERE org_id IS NULL` and `ai_model_assignments_org_uq (org_id, surface, role) WHERE org_id IS NOT NULL`;
    - constraint names `ai_model_assignments_org_partner_fk` (deferrable) and `ai_model_assignments_default_offering_fk`.
  - Drizzle `aiModelAssignments`, `type AiModelAssignmentRow`.
  - **Column semantics** (consumed by Task 9):
    - `default_offering_id` NULL = inherit (org row) / none (partner row).
    - `permitted_offering_ids` NULL = all enabled (partner row) / inherit (org row).
    - `allow_user_choice` NULL = inherit (org row) / true (partner row).
    - `fallback_may_cross_funding` NULL = inherit (org row) / false (partner row).
    - `options` NULL = inherit.

- [ ] **Step 1: Write the failing contract tests**

Append to `apps/api/src/db/schema/aiModelRegistry.contract.test.ts`:

```ts
import { AI_SURFACES, AI_SURFACE_ROLES } from '@breeze/shared';
import { getOrgCascadeDeleteOrder } from '../../services/tenantCascade';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';

describe('ai_model_assignments contract (#7600 W02)', () => {
  const sqlText = readMigration('2026-11-14-100200-ai-model-registry-assignments.sql');

  it('the surface CHECK lists exactly AI_SURFACES', () => {
    expect(checkLiterals(sqlText, 'surface')).toEqual([...AI_SURFACES]);
  });

  it('the role CHECK admits exactly AI_SURFACE_ROLES', () => {
    const nonDefault = Object.entries(AI_SURFACE_ROLES).flatMap(([surface, roles]) =>
      roles.filter((r) => r !== 'default').map((r) => `${surface}:${r}`));
    expect(nonDefault).toEqual(['ai_agents:triage', 'ai_agents:analysis', 'ai_agents:remediation']);
    expect(sqlText).toMatch(/role = 'default'\s+OR \(surface = 'ai_agents' AND role IN \('triage', 'analysis', 'remediation'\)\)/);
    for (const roles of Object.values(AI_SURFACE_ROLES)) expect(roles).toContain('default');
  });

  it('the org-side composite FK is DEFERRABLE INITIALLY IMMEDIATE', () => {
    expect(sqlText).toMatch(/ai_model_assignments_org_partner_fk\s+FOREIGN KEY \(org_id, offering_partner_id\)\s+REFERENCES public\.organizations \(id, partner_id\)\s+DEFERRABLE INITIALLY IMMEDIATE/);
  });

  it('is registered in the org cascade, merge (repoint-dedupe on surface+role) and export policy', () => {
    const order = getOrgCascadeDeleteOrder();
    expect(order.indexOf('ai_model_assignments')).toBeGreaterThan(order.indexOf('ai_cost_usage'));
    expect(getOrgMergePolicies()['ai_model_assignments']).toEqual({ kind: 'repoint-dedupe', key: ['surface', 'role'] });
    const policy = CORE_TENANT_EXPORT_POLICY['ai_model_assignments'];
    expect(policy?.organizationKey).toBe('org_id');
    expect(policy?.columns['options']).toMatchObject({ decision: 'exclude', openContainerReviewed: true });
    expect(policy?.columns['permitted_offering_ids']?.decision).toBe('include');
  });
});
```

Check the real export name of the merge-policy accessor first (`git grep -n "export function getOrgMergePolicies" apps/api/src/services/orgMergeRegistry.ts`). Agent research found `getOrgMergePolicies()` at ~:1118. If its return type is a `Map`, use `.get('ai_model_assignments')`.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/db/schema/aiModelRegistry.contract.test.ts`
Expected: FAIL. The migration is missing, `indexOf('ai_model_assignments')` is `-1`, and the export entry is undefined.

- [ ] **Step 3: Write the migration**

`apps/api/migrations/2026-11-14-100200-ai-model-registry-assignments.sql`:

```sql
-- AI model registry W02 (#7600, spec §5.4): ai_model_assignments — for one
-- (surface, role): the default offering, the permitted set, user choice,
-- options and (W09) ordered fallbacks. Partner-wide first (epic #2135): a row
-- is EITHER partner-wide (partner_id set, org_id NULL) or an org override
-- (org_id set), never both (ai_model_assignments_one_owner_chk).
--
-- OWNERSHIP (quorum #1). offering_partner_id is the partner that owns every
-- referenced offering, denormalized so the database can enforce it:
--   partner rows : CHECK partner_id = offering_partner_id
--   org rows     : (org_id, offering_partner_id) -> organizations(id, partner_id)
--                  DEFERRABLE INITIALLY IMMEDIATE (org merge runs
--                  SET CONSTRAINTS ALL DEFERRED; merges are same-partner)
--   default      : (default_offering_id, offering_partner_id)
--                  -> partner_ai_models(id, partner_id)
--   arrays       : permitted_offering_ids / fallback_offering_ids cannot carry
--                  FKs, so ai_model_assignments_offering_ownership_guard checks
--                  every element belongs to offering_partner_id, with no
--                  duplicates. It runs with the WRITER's RLS: a partner context
--                  sees all its offerings; an org context (W04 overrides) sees
--                  only ENABLED ones (partner_ai_models_org_read_enabled), so an
--                  org override can never reference a disabled offering.
-- Dangling ids after an offering is deleted are tolerated; the resolver
-- re-filters membership to enabled rows at use (spec §5.4).
--
-- TENANCY: dual-axis FOR ALL (system OR org access OR partner access) plus the
-- SELECT-only partner-wide branch from the template
-- 2026-10-05-110000-config-policy-partner-wide-select.sql, in this same file.
-- Registered: DUAL_AXIS_TENANT_TABLES, XOR_OWNERSHIP_DUAL_AXIS_TABLES,
-- CORE_ORG_CASCADE_DELETE_ORDER, orgMergeRegistry repoint-dedupe (surface, role),
-- CORE_TENANT_EXPORT_POLICY (options -> excludedOpen).
--
-- Uniqueness (owner, surface, role) is two partial unique indexes rather than
-- one COALESCE(org_id, partner_id) expression index: same semantics, and both
-- are ON CONFLICT targets for the W02 reconcile.
--
-- Idempotent. Writes no rows.

CREATE TABLE IF NOT EXISTS public.ai_model_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  partner_id uuid REFERENCES public.partners(id) ON DELETE CASCADE,
  offering_partner_id uuid NOT NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  surface text NOT NULL,
  role text NOT NULL DEFAULT 'default',
  default_offering_id uuid,
  options jsonb,
  fallback_offering_ids uuid[],
  fallback_may_cross_funding boolean,
  permitted_offering_ids uuid[],
  allow_user_choice boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_model_assignments DROP CONSTRAINT IF EXISTS ai_model_assignments_one_owner_chk;
ALTER TABLE public.ai_model_assignments ADD CONSTRAINT ai_model_assignments_one_owner_chk
  CHECK ((org_id IS NULL) <> (partner_id IS NULL));

ALTER TABLE public.ai_model_assignments DROP CONSTRAINT IF EXISTS ai_model_assignments_partner_owner_chk;
ALTER TABLE public.ai_model_assignments ADD CONSTRAINT ai_model_assignments_partner_owner_chk
  CHECK (partner_id IS NULL OR partner_id = offering_partner_id);

ALTER TABLE public.ai_model_assignments DROP CONSTRAINT IF EXISTS ai_model_assignments_org_partner_fk;
ALTER TABLE public.ai_model_assignments ADD CONSTRAINT ai_model_assignments_org_partner_fk
  FOREIGN KEY (org_id, offering_partner_id)
  REFERENCES public.organizations (id, partner_id)
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE public.ai_model_assignments DROP CONSTRAINT IF EXISTS ai_model_assignments_default_offering_fk;
ALTER TABLE public.ai_model_assignments ADD CONSTRAINT ai_model_assignments_default_offering_fk
  FOREIGN KEY (default_offering_id, offering_partner_id)
  REFERENCES public.partner_ai_models (id, partner_id);

ALTER TABLE public.ai_model_assignments DROP CONSTRAINT IF EXISTS ai_model_assignments_surface_chk;
ALTER TABLE public.ai_model_assignments ADD CONSTRAINT ai_model_assignments_surface_chk
  CHECK (surface IN ('chat', 'helper', 'script_builder', 'script_reviewer', 'office_chat',
                     'office_ticket', 'ai_agents', 'catalog_enrichment', 'extension_content', 'patch_test'));

ALTER TABLE public.ai_model_assignments DROP CONSTRAINT IF EXISTS ai_model_assignments_role_chk;
ALTER TABLE public.ai_model_assignments ADD CONSTRAINT ai_model_assignments_role_chk CHECK (
  role = 'default'
  OR (surface = 'ai_agents' AND role IN ('triage', 'analysis', 'remediation'))
);

ALTER TABLE public.ai_model_assignments DROP CONSTRAINT IF EXISTS ai_model_assignments_shape_chk;
ALTER TABLE public.ai_model_assignments ADD CONSTRAINT ai_model_assignments_shape_chk CHECK (
  (options IS NULL OR jsonb_typeof(options) = 'object')
  AND array_position(permitted_offering_ids, NULL) IS NULL
  AND array_position(fallback_offering_ids, NULL) IS NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_model_assignments_partner_uq
  ON public.ai_model_assignments (partner_id, surface, role) WHERE org_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_model_assignments_org_uq
  ON public.ai_model_assignments (org_id, surface, role) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_model_assignments_offering_partner_idx
  ON public.ai_model_assignments (offering_partner_id);
CREATE INDEX IF NOT EXISTS ai_model_assignments_default_offering_idx
  ON public.ai_model_assignments (default_offering_id) WHERE default_offering_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.ai_model_assignments_offering_ownership_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  foreign_id uuid;
BEGIN
  IF NEW.permitted_offering_ids IS NOT NULL
     AND cardinality(NEW.permitted_offering_ids)
         <> (SELECT count(DISTINCT x) FROM unnest(NEW.permitted_offering_ids) AS u(x)) THEN
    RAISE EXCEPTION 'permitted_offering_ids contains a duplicate' USING ERRCODE = '23514';
  END IF;
  IF NEW.fallback_offering_ids IS NOT NULL
     AND cardinality(NEW.fallback_offering_ids)
         <> (SELECT count(DISTINCT x) FROM unnest(NEW.fallback_offering_ids) AS u(x)) THEN
    RAISE EXCEPTION 'fallback_offering_ids contains a duplicate' USING ERRCODE = '23514';
  END IF;

  SELECT u.x INTO foreign_id
    FROM unnest(COALESCE(NEW.permitted_offering_ids, '{}'::uuid[])
                || COALESCE(NEW.fallback_offering_ids, '{}'::uuid[])) AS u(x)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.partner_ai_models AS m
      WHERE m.id = u.x AND m.partner_id = NEW.offering_partner_id
   )
   LIMIT 1;
  IF foreign_id IS NOT NULL THEN
    RAISE EXCEPTION 'offering % is not an offering of the assignment''s partner', foreign_id
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS ai_model_assignments_offering_ownership_guard ON public.ai_model_assignments;
CREATE TRIGGER ai_model_assignments_offering_ownership_guard
  BEFORE INSERT OR UPDATE OF permitted_offering_ids, fallback_offering_ids, offering_partner_id
  ON public.ai_model_assignments
  FOR EACH ROW EXECUTE FUNCTION public.ai_model_assignments_offering_ownership_guard();

ALTER TABLE public.ai_model_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_model_assignments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_model_assignments_isolation ON public.ai_model_assignments;
CREATE POLICY ai_model_assignments_isolation ON public.ai_model_assignments
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

-- Partner-wide READ branch (template: 2026-10-05-110000-config-policy-partner-wide-select.sql).
-- SELECT only: never widens UPDATE/DELETE targeting to partner-wide rows.
DROP POLICY IF EXISTS ai_model_assignments_partner_wide_select ON public.ai_model_assignments;
CREATE POLICY ai_model_assignments_partner_wide_select
  ON public.ai_model_assignments
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_model_assignments TO breeze_app;
```

- [ ] **Step 4: Append the Drizzle table**

Append to `apps/api/src/db/schema/aiModelRegistry.ts` (add `organizations` to the `./orgs` import):

```ts
import type { AiSurface } from '@breeze/shared';

/**
 * org_id XOR partner_id (dual-axis + partner-wide SELECT branch). See the
 * migration header for the NULL-means-inherit semantics of every column.
 */
export const aiModelAssignments = pgTable('ai_model_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
  offeringPartnerId: uuid('offering_partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  surface: text('surface').$type<AiSurface>().notNull(),
  role: text('role').notNull().default('default'),
  defaultOfferingId: uuid('default_offering_id'),
  options: jsonb('options').$type<Record<string, unknown>>(),
  fallbackOfferingIds: uuid('fallback_offering_ids').array(),
  fallbackMayCrossFunding: boolean('fallback_may_cross_funding'),
  permittedOfferingIds: uuid('permitted_offering_ids').array(),
  allowUserChoice: boolean('allow_user_choice'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({
    columns: [t.orgId, t.offeringPartnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'ai_model_assignments_org_partner_fk',
  }),
  foreignKey({
    columns: [t.defaultOfferingId, t.offeringPartnerId],
    foreignColumns: [partnerAiModels.id, partnerAiModels.partnerId],
    name: 'ai_model_assignments_default_offering_fk',
  }),
  uniqueIndex('ai_model_assignments_partner_uq').on(t.partnerId, t.surface, t.role).where(sql`${t.orgId} IS NULL`),
  uniqueIndex('ai_model_assignments_org_uq').on(t.orgId, t.surface, t.role).where(sql`${t.orgId} IS NOT NULL`),
  index('ai_model_assignments_offering_partner_idx').on(t.offeringPartnerId),
  index('ai_model_assignments_default_offering_idx').on(t.defaultOfferingId).where(sql`${t.defaultOfferingId} IS NOT NULL`),
  check('ai_model_assignments_one_owner_chk', sql`(${t.orgId} IS NULL) <> (${t.partnerId} IS NULL)`),
  check('ai_model_assignments_partner_owner_chk', sql`${t.partnerId} IS NULL OR ${t.partnerId} = ${t.offeringPartnerId}`),
]);

export type AiModelAssignmentRow = typeof aiModelAssignments.$inferSelect;
```

(Deferrability is SQL-only; Drizzle does not model it. Step 7 asserts it against `pg_constraint`.)

- [ ] **Step 5: Register everywhere**

`apps/api/src/services/tenantCascade.ts`, in `CORE_ORG_CASCADE_DELETE_ORDER`, directly after `'ai_cost_usage',`:

```ts
  // ai_model_assignments (AI model registry W02, #7600): org_id XOR partner_id.
  // Only ORG override rows are cascade participants; partner-wide rows have
  // org_id NULL and go with the partner. FKs out only: organizations
  // (cascade + a deferrable composite), partner_ai_models (partner axis, not in
  // this list), partners. Nothing references it.
  'ai_model_assignments',
```

`apps/api/src/services/orgMergeRegistry.ts`, in `SPECIAL`, directly after the `ai_cost_usage` entry:

```ts
  // AI model registry W02 (#7600, quorum #12): one org override per
  // (surface, role) — verified: ai_model_assignments_org_uq (org_id, surface,
  // role) WHERE org_id IS NOT NULL. Two merged orgs can't both keep one; the
  // survivor's wins. Partner-wide rows have org_id NULL and are not merge
  // participants. Merges are same-partner, so the deferrable
  // (org_id, offering_partner_id) composite FK holds after the repoint.
  ai_model_assignments: { kind: 'repoint-dedupe', key: ['surface', 'role'] },
```

`apps/api/src/services/tenantExportPolicyRegistry.ts`, directly after the `"ai_cost_usage"` entry:

```ts
  // AI model registry W02 (#7600): options is jsonb -> excludedOpen (CLAUDE.md).
  // The uuid[] columns hold offering ids (tenant identifiers, not json/jsonb/
  // bytea) -> included, precedent fix_memory.rebuild_pending_org_ids.
  "ai_model_assignments": tablePolicy("org_id", {"included":["id","org_id","partner_id","offering_partner_id","surface","role","default_offering_id","fallback_offering_ids","fallback_may_cross_funding","permitted_offering_ids","allow_user_choice","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["options"]}),
```

`apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`:
- `DUAL_AXIS_TENANT_TABLES`, directly after `'ai_script_policies',`:

```ts
  // ai_model_assignments (AI model registry W02, #7600): org override (org_id
  // set) OR partner-wide (partner_id set, org_id NULL). Created dual-axis from
  // day one in 2026-11-14-100200 with its partner-wide SELECT branch in the
  // same file. Functional forge proof: aiModelAssignmentsPartnerRls.integration.test.ts.
  'ai_model_assignments',
```

- `XOR_OWNERSHIP_DUAL_AXIS_TABLES`, directly after `'ai_script_policies',`:

```ts
  // ai_model_assignments_one_owner_chk, 2026-11-14-100200 (#7600 W02).
  'ai_model_assignments',
```

- [ ] **Step 6: Write the spec-named RLS suite**

`apps/api/src/__tests__/integration/aiModelAssignmentsPartnerRls.integration.test.ts`:

```ts
/**
 * ai_model_assignments (AI model registry W02, #7600): dual-axis RLS, XOR,
 * composite-FK and array-ownership-trigger proofs through the breeze_app pool.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { buildRepointDedupe } from '../../services/orgMergeExecutors';
import { createOrganization, createPartner } from './db-utils';
import {
  closeRegistryFixtures,
  fixtureSql as adminSql,
  orgContext,
  partnerContext,
  seedOffering,
  seedPlatformModel,
} from './aiModelRegistryFixtures';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

async function partnerWithOffering(enabled = true) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const offering = await seedOffering({ partnerId: partner.id, platformModelId: await seedPlatformModel(), enabled });
  return { partner, org, offering };
}

async function seedPartnerRow(partnerId: string, surface = 'chat', extra: Record<string, unknown> = {}): Promise<string> {
  const [row] = await adminSql`
    INSERT INTO ai_model_assignments ${adminSql({ partner_id: partnerId, offering_partner_id: partnerId, surface, ...extra })}
    RETURNING id`;
  return String(row!.id);
}

describe.skipIf(!RUN)('ai_model_assignments partner RLS (#7600 W02)', () => {
  it('partner B cannot forge a partner-A row (42501)', async () => {
    const a = await partnerWithOffering();
    const b = await createPartner();
    await expect(withDbAccessContext(partnerContext(b.id), () => db.execute(sql`
      INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface)
      VALUES (${a.partner.id}, ${a.partner.id}, 'chat')`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it.each([
    ['both axes', (p: string, o: string) => sql`INSERT INTO ai_model_assignments (org_id, partner_id, offering_partner_id, surface) VALUES (${o}, ${p}, ${p}, 'chat')`],
    ['neither axis', (p: string) => sql`INSERT INTO ai_model_assignments (offering_partner_id, surface) VALUES (${p}, 'chat')`],
    ['a partner row naming another offering partner', (p: string, _o: string, q: string) => sql`INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface) VALUES (${p}, ${q}, 'chat')`],
    ['a role on a surface without roles', (p: string) => sql`INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, role) VALUES (${p}, ${p}, 'chat', 'triage')`],
    ['an unknown surface', (p: string) => sql`INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface) VALUES (${p}, ${p}, 'telepathy')`],
  ])('rejects %s (23514)', async (_label, statement) => {
    const { partner, org } = await partnerWithOffering();
    const other = await createPartner();
    await expect(withSystemDbAccessContext(() => db.execute(statement(partner.id, org.id, other.id))))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('an org row cannot claim another partner as offering owner (23503 org_partner_fk)', async () => {
    const a = await partnerWithOffering();
    const b = await partnerWithOffering();
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, default_offering_id)
      VALUES (${a.org.id}, ${b.partner.id}, 'chat', ${b.offering})`)))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'ai_model_assignments_org_partner_fk' } });
  });

  it('a default cannot be another partner\'s offering (23503 default_offering_fk)', async () => {
    const a = await partnerWithOffering();
    const b = await partnerWithOffering();
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, default_offering_id)
      VALUES (${a.partner.id}, ${a.partner.id}, 'chat', ${b.offering})`)))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'ai_model_assignments_default_offering_fk' } });
  });

  it.each(['permitted_offering_ids', 'fallback_offering_ids'] as const)(
    'the %s trigger rejects another partner\'s offering (23503), duplicates (23514) and NULL elements (23514)',
    async (column) => {
      const a = await partnerWithOffering();
      const b = await partnerWithOffering();
      const col = sql.raw(column);
      await expect(withSystemDbAccessContext(() => db.execute(sql`
        INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, ${col})
        VALUES (${a.partner.id}, ${a.partner.id}, 'chat', ARRAY[${a.offering}, ${b.offering}]::uuid[])`)))
        .rejects.toMatchObject({ cause: { code: '23503' } });
      await expect(withSystemDbAccessContext(() => db.execute(sql`
        INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, ${col})
        VALUES (${a.partner.id}, ${a.partner.id}, 'helper', ARRAY[${a.offering}, ${a.offering}]::uuid[])`)))
        .rejects.toMatchObject({ cause: { code: '23514' } });
      await expect(withSystemDbAccessContext(() => db.execute(sql`
        INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, ${col})
        VALUES (${a.partner.id}, ${a.partner.id}, 'office_chat', ARRAY[${a.offering}, NULL]::uuid[])`)))
        .rejects.toMatchObject({ cause: { code: '23514' } });
    },
  );

  it('an org context can reference only ENABLED offerings of its partner (writer-RLS trigger rule)', async () => {
    const { partner, org, offering } = await partnerWithOffering(false);
    await expect(withDbAccessContext(orgContext(org.id, partner.id), () => db.execute(sql`
      INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, permitted_offering_ids)
      VALUES (${org.id}, ${partner.id}, 'chat', ARRAY[${offering}]::uuid[])`)))
      .rejects.toMatchObject({ cause: { code: '23503' } });
    await adminSql`UPDATE partner_ai_models SET enabled = true WHERE id = ${offering}`;
    await withDbAccessContext(orgContext(org.id, partner.id), () => db.execute(sql`
      INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, permitted_offering_ids)
      VALUES (${org.id}, ${partner.id}, 'chat', ARRAY[${offering}]::uuid[])`));
  });

  it('an org token reads its partner\'s partner-wide rows but cannot update or delete them', async () => {
    const { partner, org } = await partnerWithOffering();
    const rowId = await seedPartnerRow(partner.id);
    const read = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db.execute(sql`SELECT id FROM ai_model_assignments WHERE id = ${rowId}`));
    expect([...read]).toHaveLength(1);
    const upd = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db.execute(sql`UPDATE ai_model_assignments SET allow_user_choice = false WHERE id = ${rowId} RETURNING id`));
    const del = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db.execute(sql`DELETE FROM ai_model_assignments WHERE id = ${rowId} RETURNING id`));
    expect([...upd]).toEqual([]);
    expect([...del]).toEqual([]);
  });

  it('org A cannot see org B\'s override, and partner Q cannot see partner P\'s rows', async () => {
    const p = await partnerWithOffering();
    const orgB = await createOrganization({ partnerId: p.partner.id });
    await adminSql`INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface) VALUES (${orgB.id}, ${p.partner.id}, 'chat')`;
    const q = await createPartner();
    const fromOrgA = await withDbAccessContext(orgContext(p.org.id, p.partner.id), () =>
      db.execute(sql`SELECT id FROM ai_model_assignments WHERE org_id = ${orgB.id}`));
    const fromQ = await withDbAccessContext(partnerContext(q.id), () =>
      db.execute(sql`SELECT id FROM ai_model_assignments WHERE offering_partner_id = ${p.partner.id}`));
    expect([...fromOrgA]).toEqual([]);
    expect([...fromQ]).toEqual([]);
  });

  it('one row per (owner, surface, role) (23505)', async () => {
    const { partner } = await partnerWithOffering();
    await seedPartnerRow(partner.id, 'helper');
    await expect(seedPartnerRow(partner.id, 'helper')).rejects.toMatchObject({ code: '23505' });
  });

  it('the org-side composite FK is deferrable (merge contract)', async () => {
    const [row] = await adminSql`
      SELECT condeferrable, condeferred FROM pg_constraint WHERE conname = 'ai_model_assignments_org_partner_fk'`;
    expect(row).toMatchObject({ condeferrable: true, condeferred: false });
  });

  it('a merge keeps the survivor\'s override per (surface, role) and repoints the rest', async () => {
    const { partner, org: survivor, offering } = await partnerWithOffering();
    const loser = await createOrganization({ partnerId: partner.id });
    for (const [orgId, surface] of [[survivor.id, 'chat'], [loser.id, 'chat'], [loser.id, 'helper']] as const) {
      await adminSql`INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, default_offering_id)
                     VALUES (${orgId}, ${partner.id}, ${surface}, ${offering})`;
    }
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      for (const statement of buildRepointDedupe('ai_model_assignments', ['surface', 'role'], undefined, loser.id, survivor.id)) {
        await db.execute(statement);
      }
    });
    const rows = await adminSql`SELECT org_id, surface FROM ai_model_assignments WHERE offering_partner_id = ${partner.id} ORDER BY surface`;
    expect(rows.map((r) => [r.org_id, r.surface])).toEqual([[survivor.id, 'chat'], [survivor.id, 'helper']]);
  });

  it('a partner context manages its own partner row and its orgs\' override rows', async () => {
    const { partner, org, offering } = await partnerWithOffering();
    await withDbAccessContext(partnerContext(partner.id, [org.id]), async () => {
      await db.execute(sql`INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, default_offering_id)
                           VALUES (${partner.id}, ${partner.id}, 'chat', ${offering})`);
      await db.execute(sql`INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, permitted_offering_ids)
                           VALUES (${org.id}, ${partner.id}, 'chat', ARRAY[${offering}]::uuid[])`);
    });
    const [count] = await adminSql`SELECT count(*)::int AS n FROM ai_model_assignments WHERE offering_partner_id = ${partner.id}`;
    expect(count!.n).toBe(2);
  });
});
```

`seedPartnerRow` goes through the superuser client, so its rejection carries `code` directly, not on `.cause`.

- [ ] **Step 7: Run unit contracts, the suites, and the DB-backed registration contracts**

```bash
cd apps/api && npx vitest run src/db/schema/aiModelRegistry.contract.test.ts src/services/tenantCascade.test.ts src/services/orgMerge
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/aiModelAssignmentsPartnerRls.integration.test.ts \
  src/__tests__/integration/aiModelRegistryForgery.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
cd apps/api && DB_CONTEXTLESS_WRITE_STRICT=true pnpm test:rls-coverage
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

Expected: PASS. Check that `src/services/orgMerge` reports more than one file. In rls-coverage, `ai_model_assignments` passes both the dual-axis command check and the XOR partner-wide SELECT branch check, and is absent from `PARTNER_WIDE_SELECT_BRANCH_EXEMPT`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/2026-11-14-100200-ai-model-registry-assignments.sql apps/api/src/db/schema/aiModelRegistry.ts \
  apps/api/src/db/schema/aiModelRegistry.contract.test.ts apps/api/src/services/tenantCascade.ts \
  apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.ts \
  apps/api/src/__tests__/integration/rls-coverage.integration.test.ts \
  apps/api/src/__tests__/integration/aiModelAssignmentsPartnerRls.integration.test.ts
git commit -m "feat(ai): ai_model_assignments with tighten-only ownership, dual-axis RLS and full cascade registration

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5: `ai_invocations` — the append-only invocation ledger (migration + schema + registrations; unit + integration)

**Files:**
- Create: `apps/api/migrations/2026-11-14-100300-ai-invocations.sql`
- Create: `apps/api/src/db/schema/aiInvocations.ts`
- Create: `apps/api/src/__tests__/integration/aiInvocationsAppendOnly.integration.test.ts`
- Modify: `apps/api/src/db/schema/index.ts` (append `export * from './aiInvocations';`)
- Modify: `apps/api/src/db/schema/aiModelRegistry.contract.test.ts` (append)
- Modify: `apps/api/src/services/tenantCascade.ts`:
  - `CORE_ORG_CASCADE_DELETE_ORDER`: between `'ai_cost_usage',` and `'ai_model_assignments',`;
  - `AUDIT_ADMIN_REQUIRED_TABLES`: append.
- Modify: `apps/api/src/services/orgMergeRegistry.ts` (`REPOINT_TABLES`, between `"ai_action_plans",` and `"ai_screenshots",`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (between `"ai_cost_usage"` and `"ai_model_assignments"`)
- Modify: `apps/api/src/db/ensureAppRole.ts` (step-5 re-revoke block, after the `ai_operator_task_events` block ~:331)
- Modify: `apps/api/src/__tests__/integration/ensureAppRoleAppendOnlyPrivileges.integration.test.ts` (add `ai_invocations` to the full-set `it.each`)

**Interfaces:**
- Consumes: `organizations`; `AI_SURFACES` (shared).
- Produces:
  - table `ai_invocations` (spec §5.5) plus two W02 additions:
    - `ledger_mode` (`'shadow'` in W02, `'authoritative'` from W03). W03 can then derive session totals and rollups from authoritative rows only, and never re-bill history.
    - `legacy_cost_cents`, the legacy cost, so the W03 go/no-go can query the diff instead of reading logs.
  - Drizzle `aiInvocations`, `type AiInvocationRow`, `AI_INVOCATION_LEDGER_MODES = ['shadow', 'authoritative'] as const`.
  - **Privilege contract:**
    - `breeze_app`: `SELECT, INSERT, REFERENCES`, plus column-level `UPDATE (org_id)` only.
    - `breeze_audit_admin`: `SELECT, DELETE`.
    - The trigger rejects every UPDATE except an `org_id`-only change made **in system scope**, away from an org whose status is `merging`, to an org of the same partner. System scope matters: a partner caller can toggle an org's status itself, so the fence alone is forgeable.
    - It rejects every DELETE unless `current_user = 'breeze_audit_admin'` AND `breeze.allow_audit_retention = '1'`. The GUC alone is caller-settable. Nothing cascades into this table, so there is no trigger-depth exception.
  - **No FKs** on `user_id`, `session_id`, `agent_run_id`, `offering_id`, `connection_id`, `catalog_revision_id`. They are provenance snapshots. An `ON DELETE SET NULL` would be an UPDATE the trigger rejects, and deleting a session, device, offering or user must never be blocked by history (precedent: `ai_operator_task_events`).
  - **Insert-time ownership guard instead** (quorum #1). `ai_invocations_provenance_guard`, fail-closed, writer's RLS, checks:
    - `session_id` and `agent_run_id` belong to `org_id`;
    - `offering_id` belongs to the org's partner, and its platform-vs-connection shape matches `funding_source`;
    - `connection_id` equals the offering's connection, or (with no offering) belongs to the org's partner.

    It does not check `user_id`, which is attribution only and may be a partner-level user an org token cannot see. W02 inserts run in system scope. A W03 insert under an org token can name a `connection_id` only through an (enabled, org-visible) offering.

- [ ] **Step 1: Write the failing contract test**

Append to `apps/api/src/db/schema/aiModelRegistry.contract.test.ts`:

```ts
import { AI_INVOCATION_LEDGER_MODES } from './aiInvocations';
import { __testOnly as tenantCascadeTestOnly } from '../../services/tenantCascade';

describe('ai_invocations contract (#7600 W02)', () => {
  const sqlText = readMigration('2026-11-14-100300-ai-invocations.sql');

  it('surface CHECK = AI_SURFACES; ledger_mode CHECK = the Drizzle literals', () => {
    expect(checkLiterals(sqlText, 'surface')).toEqual([...AI_SURFACES]);
    expect(checkLiterals(sqlText, 'ledger_mode')).toEqual([...AI_INVOCATION_LEDGER_MODES]);
  });

  it('is append-only for breeze_app with a column-level org_id grant only', () => {
    expect(sqlText).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE ON public\.ai_invocations FROM breeze_app;/);
    expect(sqlText).toMatch(/GRANT UPDATE \(org_id\) ON public\.ai_invocations TO breeze_app;/);
    expect(sqlText).toMatch(/GRANT SELECT, DELETE ON public\.ai_invocations TO breeze_audit_admin;/);
  });

  it('is registered: cascade, audit-admin erasure, plain repoint merge, export policy', () => {
    const order = getOrgCascadeDeleteOrder();
    expect(order.indexOf('ai_invocations')).toBeGreaterThan(order.indexOf('ai_cost_usage'));
    expect(order.indexOf('ai_invocations')).toBeLessThan(order.indexOf('ai_model_assignments'));
    expect(tenantCascadeTestOnly.AUDIT_ADMIN_REQUIRED_TABLES.has('ai_invocations')).toBe(true);
    expect(getOrgMergePolicies()['ai_invocations']).toEqual({ kind: 'repoint' });
    const policy = CORE_TENANT_EXPORT_POLICY['ai_invocations'];
    expect(policy?.columns['rate_snapshot']).toMatchObject({ decision: 'exclude', openContainerReviewed: true });
    expect(policy?.columns['options_sent']).toMatchObject({ decision: 'exclude', openContainerReviewed: true });
    expect(policy?.columns['input_tokens']).toMatchObject({ decision: 'include', reviewedSensitiveName: true });
  });
});
```

Confirm the `__testOnly` export shape first: `git grep -n "__testOnly" apps/api/src/services/tenantCascade.ts`. Agent research found it at ~:2203 and that it exposes `AUDIT_ADMIN_REQUIRED_TABLES`.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/db/schema/aiModelRegistry.contract.test.ts`
Expected: FAIL. `./aiInvocations` does not resolve.

- [ ] **Step 3: Write the migration**

`apps/api/migrations/2026-11-14-100300-ai-invocations.sql`:

```sql
-- AI model registry W02 (#7600, spec §5.5, quorum #6): ai_invocations — one
-- immutable row per model call or turn, from every surface, including
-- sessionless agent runs. Shape 1 (org_id).
--
-- W02 writes SHADOW rows (ledger_mode = 'shadow') next to every legacy cost
-- record; billing and budgets still come from the legacy path. W03 writes
-- 'authoritative' rows and derives ai_sessions totals / ai_cost_usage from
-- those only. legacy_cost_cents carries the legacy cost on shadow rows so the
-- W03 go/no-go can query the price diff.
--
-- APPEND-ONLY (precedent ai_operator_task_events, 2026-10-26-160000):
--   * breeze_app: SELECT, INSERT, REFERENCES + column-level UPDATE (org_id).
--     ensureAppRole.ts re-revokes UPDATE/DELETE/TRUNCATE on every boot and
--     re-grants UPDATE (org_id) (a table-level REVOKE also drops column grants).
--   * breeze_audit_admin: SELECT, DELETE (erasure via AUDIT_ADMIN_REQUIRED_TABLES,
--     retention via jobs/aiInvocationRetention.ts), both with
--     breeze.allow_audit_retention = '1'.
--   * ai_invocations_append_only rejects every UPDATE except a SYSTEM-scope
--     org_id-only re-point away from an org fenced 'merging' to an org of the
--     SAME partner (org merge policy 'repoint'; spec §5.5), and every DELETE
--     not made as breeze_audit_admin with the retention GUC.
-- No FKs on user/session/run/offering/connection ids: they are provenance
-- snapshots, and ON DELETE SET NULL would be an UPDATE the trigger rejects.
-- ai_invocations_provenance_guard enforces their tenant ownership at INSERT,
-- fail-closed (quorum #1).
--
-- All four org policies exist because rls-coverage requires them on every
-- shape-1 table; the GRANTs are what make the table append-only.
--
-- Idempotent. Writes no rows.

CREATE TABLE IF NOT EXISTS public.ai_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  surface text NOT NULL,
  role text NOT NULL DEFAULT 'default',
  user_id uuid,
  session_id uuid,
  agent_run_id uuid,
  source_ref text,
  offering_id uuid,
  connection_id uuid,
  funding_source text NOT NULL,
  requested_model text NOT NULL,
  served_model text NOT NULL,
  options_sent jsonb NOT NULL DEFAULT '{}'::jsonb,
  thinking_mode_sent text,
  inference_geo_sent text,
  stop_reason text,
  refusal_category text,
  fallback_used boolean NOT NULL DEFAULT false,
  catalog_revision_id uuid,
  connection_config_version integer,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cache_read_tokens bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  rate_snapshot jsonb,
  cost_cents numeric(20, 6),
  chargeable boolean NOT NULL DEFAULT false,
  sdk_reported_cost_usd numeric(20, 6),
  ledger_mode text NOT NULL DEFAULT 'shadow',
  legacy_cost_cents numeric(20, 6),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_invocations DROP CONSTRAINT IF EXISTS ai_invocations_surface_chk;
ALTER TABLE public.ai_invocations ADD CONSTRAINT ai_invocations_surface_chk
  CHECK (surface IN ('chat', 'helper', 'script_builder', 'script_reviewer', 'office_chat',
                     'office_ticket', 'ai_agents', 'catalog_enrichment', 'extension_content', 'patch_test'));

ALTER TABLE public.ai_invocations DROP CONSTRAINT IF EXISTS ai_invocations_role_chk;
ALTER TABLE public.ai_invocations ADD CONSTRAINT ai_invocations_role_chk CHECK (
  role = 'default'
  OR (surface = 'ai_agents' AND role IN ('triage', 'analysis', 'remediation'))
);

ALTER TABLE public.ai_invocations DROP CONSTRAINT IF EXISTS ai_invocations_ledger_mode_chk;
ALTER TABLE public.ai_invocations ADD CONSTRAINT ai_invocations_ledger_mode_chk
  CHECK (ledger_mode IN ('shadow', 'authoritative'));

ALTER TABLE public.ai_invocations DROP CONSTRAINT IF EXISTS ai_invocations_shape_chk;
ALTER TABLE public.ai_invocations ADD CONSTRAINT ai_invocations_shape_chk CHECK (
  funding_source IN ('platform', 'partner_key')
  AND (thinking_mode_sent IS NULL OR thinking_mode_sent IN ('adaptive', 'budget', 'none', 'unknown'))
  AND input_tokens >= 0 AND output_tokens >= 0 AND cache_read_tokens >= 0 AND cache_write_tokens >= 0
  -- priced together or not at all (an unpriced shadow call records NULL/NULL)
  AND (rate_snapshot IS NULL) = (cost_cents IS NULL)
  AND (cost_cents IS NULL OR cost_cents >= 0)
  AND jsonb_typeof(options_sent) = 'object'
  -- legacy cost exists only on shadow rows
  AND (ledger_mode = 'shadow' OR legacy_cost_cents IS NULL)
);

CREATE INDEX IF NOT EXISTS ai_invocations_org_created_idx ON public.ai_invocations (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_invocations_created_idx ON public.ai_invocations (created_at);
CREATE INDEX IF NOT EXISTS ai_invocations_session_idx ON public.ai_invocations (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_invocations_agent_run_idx ON public.ai_invocations (agent_run_id) WHERE agent_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_invocations_offering_idx ON public.ai_invocations (offering_id, created_at) WHERE offering_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.ai_invocations_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The GUC alone is caller-settable; the role is what authenticates it.
    -- Nothing cascades into this table, so there is no trigger-depth exception.
    IF current_user = 'breeze_audit_admin'
       AND current_setting('breeze.allow_audit_retention', true) = '1' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'ai_invocations is append-only',
      HINT = 'Erasure and retention delete as breeze_audit_admin with breeze.allow_audit_retention=1.';
  END IF;

  -- UPDATE: nothing but org_id may change …
  IF (to_jsonb(NEW) - 'org_id') IS DISTINCT FROM (to_jsonb(OLD) - 'org_id') THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ai_invocations is append-only';
  END IF;
  -- … and only as the org-merge re-point: system scope (a partner caller can
  -- flip an org's status itself, so the fence alone is forgeable), source
  -- fenced 'merging', destination under the same partner.
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     AND public.breeze_current_scope() = 'system'
     AND EXISTS (
       SELECT 1
         FROM public.organizations AS src
         JOIN public.organizations AS dst ON dst.id = NEW.org_id
        WHERE src.id = OLD.org_id
          AND src.status::text = 'merging'
          AND dst.partner_id = src.partner_id
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'ai_invocations rows move only with an org merge';
END $$;

DROP TRIGGER IF EXISTS ai_invocations_block_update ON public.ai_invocations;
CREATE TRIGGER ai_invocations_block_update BEFORE UPDATE ON public.ai_invocations
  FOR EACH ROW EXECUTE FUNCTION public.ai_invocations_append_only();
DROP TRIGGER IF EXISTS ai_invocations_block_delete ON public.ai_invocations;
CREATE TRIGGER ai_invocations_block_delete BEFORE DELETE ON public.ai_invocations
  FOR EACH ROW EXECUTE FUNCTION public.ai_invocations_append_only();

-- Insert-time provenance ownership (quorum #1). The provenance ids carry no FK
-- (history must never block a session/run/offering delete), so the tenant
-- boundary is enforced here instead, FAIL-CLOSED, with the writer's RLS: an id
-- the writer can't see is rejected. user_id is attribution only and is not
-- checked (it may be a partner-level user an org token cannot read).
CREATE OR REPLACE FUNCTION public.ai_invocations_provenance_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  org_partner uuid;
  off_partner uuid;
  off_connection uuid;
  off_found boolean := false;
BEGIN
  SELECT o.partner_id INTO org_partner FROM public.organizations AS o WHERE o.id = NEW.org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_invocations.org_id % is not a visible organization', NEW.org_id USING ERRCODE = '23503';
  END IF;

  IF NEW.session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.ai_sessions AS s WHERE s.id = NEW.session_id AND s.org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'session % does not belong to org %', NEW.session_id, NEW.org_id USING ERRCODE = '23503';
  END IF;

  IF NEW.agent_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.ai_agent_runs AS r WHERE r.id = NEW.agent_run_id AND r.org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'agent run % does not belong to org %', NEW.agent_run_id, NEW.org_id USING ERRCODE = '23503';
  END IF;

  IF NEW.offering_id IS NOT NULL THEN
    SELECT true, m.partner_id, m.connection_id INTO off_found, off_partner, off_connection
      FROM public.partner_ai_models AS m WHERE m.id = NEW.offering_id;
    IF NOT FOUND OR off_partner IS DISTINCT FROM org_partner THEN
      RAISE EXCEPTION 'offering % is not an offering of org %''s partner', NEW.offering_id, NEW.org_id USING ERRCODE = '23503';
    END IF;
    IF (off_connection IS NULL) <> (NEW.funding_source = 'platform') THEN
      RAISE EXCEPTION 'funding_source % does not match offering %', NEW.funding_source, NEW.offering_id USING ERRCODE = '23514';
    END IF;
    IF NEW.connection_id IS DISTINCT FROM off_connection THEN
      RAISE EXCEPTION 'connection_id must be the offering''s connection' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.connection_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.partner_ai_connections AS c WHERE c.id = NEW.connection_id AND c.partner_id = org_partner
  ) THEN
    RAISE EXCEPTION 'connection % is not a connection of org %''s partner', NEW.connection_id, NEW.org_id USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS ai_invocations_provenance_guard ON public.ai_invocations;
CREATE TRIGGER ai_invocations_provenance_guard BEFORE INSERT ON public.ai_invocations
  FOR EACH ROW EXECUTE FUNCTION public.ai_invocations_provenance_guard();

ALTER TABLE public.ai_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_invocations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON public.ai_invocations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.ai_invocations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.ai_invocations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.ai_invocations;
CREATE POLICY breeze_org_isolation_select ON public.ai_invocations
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.ai_invocations
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.ai_invocations
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.ai_invocations
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, REFERENCES ON public.ai_invocations TO breeze_app;
REVOKE UPDATE, DELETE, TRUNCATE ON public.ai_invocations FROM breeze_app;
GRANT UPDATE (org_id) ON public.ai_invocations TO breeze_app;
GRANT SELECT, DELETE ON public.ai_invocations TO breeze_audit_admin;
REVOKE INSERT, UPDATE, TRUNCATE ON public.ai_invocations FROM breeze_audit_admin;
```

- [ ] **Step 4: Write the Drizzle schema**

`apps/api/src/db/schema/aiInvocations.ts`:

```ts
// AI model registry W02 (#7600, spec §5.5): the append-only invocation ledger.
// APPEND-ONLY: breeze_app holds SELECT/INSERT + column UPDATE (org_id) only;
// the trigger admits nothing but an org-merge re-point. Registered in
// AUDIT_ADMIN_REQUIRED_TABLES. No FKs on provenance ids (see the migration).
import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { AiSurface } from '@breeze/shared';
import { organizations } from './orgs';

export const AI_INVOCATION_LEDGER_MODES = ['shadow', 'authoritative'] as const;
export type AiInvocationLedgerMode = (typeof AI_INVOCATION_LEDGER_MODES)[number];

const cents = (name: string) => numeric(name, { precision: 20, scale: 6, mode: 'number' });
const tokens = (name: string) => bigint(name, { mode: 'number' }).notNull().default(0);

export const aiInvocations = pgTable('ai_invocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  surface: text('surface').$type<AiSurface>().notNull(),
  role: text('role').notNull().default('default'),
  userId: uuid('user_id'),
  sessionId: uuid('session_id'),
  agentRunId: uuid('agent_run_id'),
  sourceRef: text('source_ref'),
  offeringId: uuid('offering_id'),
  connectionId: uuid('connection_id'),
  fundingSource: text('funding_source', { enum: ['platform', 'partner_key'] }).notNull(),
  requestedModel: text('requested_model').notNull(),
  servedModel: text('served_model').notNull(),
  optionsSent: jsonb('options_sent').$type<Record<string, unknown>>().notNull().default({}),
  thinkingModeSent: text('thinking_mode_sent'),
  inferenceGeoSent: text('inference_geo_sent'),
  stopReason: text('stop_reason'),
  refusalCategory: text('refusal_category'),
  fallbackUsed: boolean('fallback_used').notNull().default(false),
  catalogRevisionId: uuid('catalog_revision_id'),
  connectionConfigVersion: integer('connection_config_version'),
  inputTokens: tokens('input_tokens'),
  outputTokens: tokens('output_tokens'),
  cacheReadTokens: tokens('cache_read_tokens'),
  cacheWriteTokens: tokens('cache_write_tokens'),
  rateSnapshot: jsonb('rate_snapshot').$type<Record<string, unknown>>(),
  costCents: cents('cost_cents'),
  chargeable: boolean('chargeable').notNull().default(false),
  sdkReportedCostUsd: cents('sdk_reported_cost_usd'),
  ledgerMode: text('ledger_mode').$type<AiInvocationLedgerMode>().notNull().default('shadow'),
  legacyCostCents: cents('legacy_cost_cents'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('ai_invocations_org_created_idx').on(t.orgId, t.createdAt.desc()),
  index('ai_invocations_created_idx').on(t.createdAt),
  index('ai_invocations_session_idx').on(t.sessionId).where(sql`${t.sessionId} IS NOT NULL`),
  index('ai_invocations_agent_run_idx').on(t.agentRunId).where(sql`${t.agentRunId} IS NOT NULL`),
  index('ai_invocations_offering_idx').on(t.offeringId, t.createdAt).where(sql`${t.offeringId} IS NOT NULL`),
]);

export type AiInvocationRow = typeof aiInvocations.$inferSelect;
```

Append `export * from './aiInvocations';` to `apps/api/src/db/schema/index.ts`.

- [ ] **Step 5: Register everywhere**

`tenantCascade.ts`, in `CORE_ORG_CASCADE_DELETE_ORDER`, between `'ai_cost_usage',` and the Task 4 `ai_model_assignments` block:

```ts
  // ai_invocations (AI model registry W02, #7600): shape 1, APPEND-ONLY
  // (REVOKE UPDATE/DELETE from breeze_app + ai_invocations_append_only), so it
  // is ALSO in AUDIT_ADMIN_REQUIRED_TABLES. Leaf: FK out to organizations only,
  // no FKs in (provenance ids are snapshots).
  'ai_invocations',
```

`tenantCascade.ts`, appended to `AUDIT_ADMIN_REQUIRED_TABLES`:

```ts
  // Append-only AI invocation ledger: REVOKE UPDATE/DELETE from breeze_app plus
  // ai_invocations_append_only() (2026-11-14-100300, #7600 W02), so erasure has
  // to run as breeze_audit_admin with breeze.allow_audit_retention=1.
  'ai_invocations',
```

`orgMergeRegistry.ts`, in `REPOINT_TABLES` (hand-maintained, alphabetical, comments allowed), between `"ai_action_plans",` and `"ai_screenshots",`:

```ts
  // ai_invocations (#7600 W02) is append-only, but its trigger admits exactly
  // the org_id-only UPDATE this policy issues while the loser org is fenced
  // 'merging' (same partner), and breeze_app holds a column-level UPDATE
  // (org_id) grant for it — so usage history follows the merged client
  // (spec §5.5; chargeback W10).
  "ai_invocations",
```

`tenantExportPolicyRegistry.ts`, between `"ai_cost_usage"` and `"ai_model_assignments"`:

```ts
  // AI model registry W02 (#7600): the invocation ledger. options_sent and
  // rate_snapshot are jsonb -> excludedOpen. The four *_tokens columns trip
  // SUSPICIOUS_NAME_PARTS ('token') but are counters -> reviewedIncluded
  // (precedent ai_cost_usage.input_tokens).
  "ai_invocations": tablePolicy("org_id", {"included":["id","org_id","surface","role","user_id","session_id","agent_run_id","source_ref","offering_id","connection_id","funding_source","requested_model","served_model","thinking_mode_sent","inference_geo_sent","stop_reason","refusal_category","fallback_used","catalog_revision_id","connection_config_version","cost_cents","chargeable","sdk_reported_cost_usd","ledger_mode","legacy_cost_cents","created_at"],"reviewedIncluded":["input_tokens","output_tokens","cache_read_tokens","cache_write_tokens"],"excludedSensitive":[],"excludedOpen":["options_sent","rate_snapshot"]}),
```

`apps/api/src/db/ensureAppRole.ts`, in step 5's `DO $$` block, after the `ai_operator_task_events` block:

```sql
        -- ai_invocations (AI model registry W02, #7600, 2026-11-14-100300):
        -- append-only invocation ledger. Org erasure and retention delete it as
        -- breeze_audit_admin with breeze.allow_audit_retention='1'. The
        -- table-level REVOKE also drops column privileges, so the column-level
        -- UPDATE (org_id) the org-merge repoint needs is re-granted right after.
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='ai_invocations') THEN
          REVOKE UPDATE, DELETE, TRUNCATE ON TABLE ai_invocations FROM breeze_app;
          GRANT UPDATE (org_id) ON TABLE ai_invocations TO breeze_app;
        END IF;
```

`ensureAppRoleAppendOnlyPrivileges.integration.test.ts`: add `'ai_invocations'` to the first `it.each([...])` (full UPDATE/DELETE/TRUNCATE set).

- [ ] **Step 6: Write the integration suite**

`apps/api/src/__tests__/integration/aiInvocationsAppendOnly.integration.test.ts`:

```ts
/**
 * ai_invocations (AI model registry W02, #7600): append-only privilege +
 * trigger contract, merge re-point, erasure path, and CHECKs, through the
 * breeze_app pool.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { createOrganization, createPartner } from './db-utils';
import {
  closeRegistryFixtures,
  fixtureSql as adminSql,
  orgContext,
  partnerContext,
  seedByokConnection,
  seedOffering,
  seedPlatformModel,
} from './aiModelRegistryFixtures';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

async function insertRow(orgId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const [row] = await adminSql`
    INSERT INTO ai_invocations ${adminSql({
      org_id: orgId, surface: 'chat', funding_source: 'platform',
      requested_model: 'claude-sonnet-5-5', served_model: 'claude-sonnet-5-5', ...extra,
    })} RETURNING id`;
  return String(row!.id);
}

describe.skipIf(!RUN)('ai_invocations append-only ledger (#7600 W02)', () => {
  it('breeze_app holds SELECT/INSERT and only a column-level UPDATE on org_id', async () => {
    const [p] = (await db.execute(sql`
      SELECT has_table_privilege('breeze_app', 'ai_invocations', 'INSERT') AS ins,
             has_table_privilege('breeze_app', 'ai_invocations', 'UPDATE') AS upd,
             has_table_privilege('breeze_app', 'ai_invocations', 'DELETE') AS del,
             has_column_privilege('breeze_app', 'ai_invocations', 'org_id', 'UPDATE') AS upd_org,
             has_column_privilege('breeze_app', 'ai_invocations', 'cost_cents', 'UPDATE') AS upd_cost`)) as unknown as Array<Record<string, boolean>>;
    expect(p).toEqual({ ins: true, upd: false, del: false, upd_org: true, upd_cost: false });
  });

  it('an org writes only its own rows (42501 cross-org)', async () => {
    const partner = await createPartner();
    const [orgA, orgB] = [await createOrganization({ partnerId: partner.id }), await createOrganization({ partnerId: partner.id })];
    await withDbAccessContext(orgContext(orgA.id, partner.id), () => db.execute(sql`
      INSERT INTO ai_invocations (org_id, surface, funding_source, requested_model, served_model)
      VALUES (${orgA.id}, 'chat', 'platform', 'm', 'm')`));
    await expect(withDbAccessContext(orgContext(orgA.id, partner.id), () => db.execute(sql`
      INSERT INTO ai_invocations (org_id, surface, funding_source, requested_model, served_model)
      VALUES (${orgB.id}, 'chat', 'platform', 'm', 'm')`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('no column but org_id can be updated (42501), and org_id only during a same-partner merge (55000 otherwise)', async () => {
    const partner = await createPartner();
    const [loser, survivor] = [await createOrganization({ partnerId: partner.id }), await createOrganization({ partnerId: partner.id })];
    const foreign = await createOrganization({ partnerId: (await createPartner()).id });
    const id = await insertRow(loser.id, { cost_cents: 1, rate_snapshot: { source: 'platform' } });

    await expect(withSystemDbAccessContext(() => db.execute(sql`UPDATE ai_invocations SET cost_cents = 0 WHERE id = ${id}`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(withSystemDbAccessContext(() => db.execute(sql`UPDATE ai_invocations SET org_id = ${survivor.id} WHERE id = ${id}`)))
      .rejects.toMatchObject({ cause: { code: '55000' } });

    await adminSql`UPDATE organizations SET status = 'merging' WHERE id = ${loser.id}`;
    await expect(withSystemDbAccessContext(() => db.execute(sql`UPDATE ai_invocations SET org_id = ${foreign.id} WHERE id = ${id}`)))
      .rejects.toMatchObject({ cause: { code: '55000' } });
    // A partner caller that forged the fence still can't move history: system scope is required.
    await expect(withDbAccessContext(partnerContext(partner.id, [loser.id, survivor.id]), () =>
      db.execute(sql`UPDATE ai_invocations SET org_id = ${survivor.id} WHERE id = ${id}`)))
      .rejects.toMatchObject({ cause: { code: '55000' } });
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE ai_invocations SET org_id = ${survivor.id} WHERE org_id = ${loser.id}`));
    const [row] = await adminSql`SELECT org_id FROM ai_invocations WHERE id = ${id}`;
    expect(row!.org_id).toBe(survivor.id);
  });

  it('the retention GUC set by breeze_app itself does not authorize a delete', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const id = await insertRow(org.id);
    // breeze_app lacks DELETE anyway (42501); the trigger's role check is the
    // second wall for the window in which a replica's boot re-grants it.
    await expect(withSystemDbAccessContext(async () => {
      await db.execute(sql`SET LOCAL breeze.allow_audit_retention = '1'`);
      await db.execute(sql`DELETE FROM ai_invocations WHERE id = ${id}`);
    })).rejects.toMatchObject({ cause: { code: expect.stringMatching(/^(42501|55000)$/) } });
  });

  it('provenance guard: cross-org session / agent run, foreign offering or connection, funding mismatch are rejected', async () => {
    const [p, q] = [await createPartner(), await createPartner()];
    const [orgA, orgB] = [await createOrganization({ partnerId: p.id }), await createOrganization({ partnerId: p.id })];
    const [sessionB] = await adminSql`INSERT INTO ai_sessions (org_id) VALUES (${orgB.id}) RETURNING id`;
    const platformOfferQ = await seedOffering({ partnerId: q.id, platformModelId: await seedPlatformModel() });
    const platformOfferP = await seedOffering({ partnerId: p.id, platformModelId: await seedPlatformModel() });
    const connQ = await seedByokConnection(q.id);
    const insert = (extra: Record<string, unknown>) => withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO ai_invocations (org_id, surface, funding_source, requested_model, served_model, session_id, offering_id, connection_id)
      VALUES (${orgA.id}, 'chat', ${(extra.funding as string) ?? 'platform'}, 'm', 'm',
              ${(extra.session as string) ?? null}, ${(extra.offering as string) ?? null}, ${(extra.connection as string) ?? null})`));
    await expect(insert({ session: String(sessionB!.id) })).rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(insert({ offering: platformOfferQ })).rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(insert({ connection: connQ, funding: 'partner_key' })).rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(insert({ offering: platformOfferP, funding: 'partner_key' })).rejects.toMatchObject({ cause: { code: '23514' } });
    await insert({ offering: platformOfferP, funding: 'platform' });
  });

  it('breeze_app cannot DELETE (42501); breeze_audit_admin deletes only with the retention GUC (55000 otherwise)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const id = await insertRow(org.id);
    await expect(withSystemDbAccessContext(() => db.execute(sql`DELETE FROM ai_invocations WHERE id = ${id}`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(withSystemDbAccessContext(async () => {
      await db.execute(sql`SET LOCAL ROLE breeze_audit_admin`);
      await db.execute(sql`DELETE FROM ai_invocations WHERE id = ${id}`);
    })).rejects.toMatchObject({ cause: { code: '55000' } });
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`SET LOCAL ROLE breeze_audit_admin`);
      await db.execute(sql`SET LOCAL breeze.allow_audit_retention = '1'`);
      await db.execute(sql`DELETE FROM ai_invocations WHERE id = ${id}`);
    });
    const left = await adminSql`SELECT 1 FROM ai_invocations WHERE id = ${id}`;
    expect(left).toHaveLength(0);
  });

  it.each([
    ['a price without a rate snapshot', { cost_cents: 1 }],
    ['an unknown surface', { surface: 'telepathy' }],
    ['an unknown funding source', { funding_source: 'gift_card' }],
    ['a role outside the surface', { role: 'triage' }],
    ['legacy cost on an authoritative row', { ledger_mode: 'authoritative', legacy_cost_cents: 1 }],
  ])('rejects %s (23514)', async (_label, extra) => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await expect(insertRow(org.id, extra)).rejects.toMatchObject({ code: '23514' });
  });
});
```

- [ ] **Step 7: Run unit contracts, the suites and the registration contracts**

```bash
cd apps/api && npx vitest run src/db/schema/aiModelRegistry.contract.test.ts src/db/ensureAppRole.appendOnlyCoverage.test.ts src/services/tenantCascade.test.ts src/services/orgMerge
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/aiInvocationsAppendOnly.integration.test.ts \
  src/__tests__/integration/ensureAppRoleAppendOnlyPrivileges.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts
cd apps/api && DB_CONTEXTLESS_WRITE_STRICT=true pnpm test:rls-coverage
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

Expected: PASS. `ensureAppRole.appendOnlyCoverage.test.ts` passes only because Step 5 added the re-revoke block. Remove it temporarily to watch that guard go red, then restore it.

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/2026-11-14-100300-ai-invocations.sql apps/api/src/db/schema/aiInvocations.ts \
  apps/api/src/db/schema/index.ts apps/api/src/db/schema/aiModelRegistry.contract.test.ts \
  apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts \
  apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/db/ensureAppRole.ts \
  apps/api/src/__tests__/integration/ensureAppRoleAppendOnlyPrivileges.integration.test.ts \
  apps/api/src/__tests__/integration/aiInvocationsAppendOnly.integration.test.ts
git commit -m "feat(ai): append-only ai_invocations ledger with merge re-point, erasure and export registration

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 6: Offering columns on `ai_sessions` and `ai_agents` (migration + schema + export; unit + integration)

**Files:**
- Create: `apps/api/migrations/2026-11-14-100400-ai-model-registry-session-agent-columns.sql`
- Create: `apps/api/migrations/2026-11-14-100500-ai-model-registry-session-agent-validate.sql`
- Create: `apps/api/migrations/2026-11-14-100600-ai-sessions-offering-idx.sql`
- Modify: `apps/api/src/db/schema/ai.ts` (`aiSessions`)
- Modify: `apps/api/src/db/schema/aiAgents.ts` (`aiAgents`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`"ai_sessions"` ~:124 and `"ai_agents"` ~:83 entries)
- Modify: `apps/api/src/db/schema/aiModelRegistry.contract.test.ts` (append)
- Modify: `apps/api/src/__tests__/integration/aiModelRegistryFixtures.ts` (append `seedAgent`)
- Modify: `apps/api/src/__tests__/integration/aiModelRegistryForgery.integration.test.ts` (append)

**Interfaces:**
- Consumes: `partner_ai_models_id_partner_uq` (Task 3), `organizations_id_partner_uq`.
- Produces:
  - `ai_sessions.offering_id`, `ai_sessions.offering_partner_id`, `ai_sessions.options` (an `OfferingOptions`, per the index correction to spec §5.6).
  - `ai_agents.offering_id`, `ai_agents.offering_partner_id`.
  - Drizzle `aiSessions.offeringId` / `.offeringPartnerId` / `.options`, and `aiAgents.offeringId` / `.offeringPartnerId`.
  - Constraint names: `ai_sessions_offering_fk`, `ai_sessions_offering_org_partner_fk`, `ai_agents_offering_fk`, `ai_agents_offering_org_partner_fk`.
  - **Invariants:**
    - The offering pair is NULL together.
    - An offering deletion nulls the pair (`ON DELETE SET NULL`). That never happens in W02, because offerings are only deleted with their connection.
    - On `ai_sessions`, a cross-partner `org_id` change (a system-scope device move) nulls the pair and `options` instead of aborting with 23503.
    - `ai_agents.model` and `ai_sessions.model` stay as they are and stay the legacy routing input until W03.

> **Deferred from spec §5.6 (deliberate):** the stale `ai_sessions.model` default (`'claude-sonnet-4-5-20250929'`) is NOT dropped in W02. Several existing suites insert `ai_sessions` rows with only `org_id`, and `ai-budget-reservations.integration.test.ts` is one of them. Dropping the default makes every such insert fail on `NOT NULL`, and makes `model` required in the Drizzle insert type. W03 owns session creation through `resolveModel` and drops it there. The same goes for write-time validation of agent policy models against the `ai_agents` assignment (spec §5.6, quorum #11): that changes admin behaviour, so it lands with W03's run-time check.

- [ ] **Step 1: Write the failing contract test**

Append to `apps/api/src/db/schema/aiModelRegistry.contract.test.ts`:

```ts
describe('ai_sessions / ai_agents offering columns (#7600 W02)', () => {
  const sqlText = readMigration('2026-11-14-100400-ai-model-registry-session-agent-columns.sql');

  it.each(['ai_sessions_offering_org_partner_fk', 'ai_agents_offering_org_partner_fk'])(
    '%s references organizations(id, partner_id) DEFERRABLE INITIALLY IMMEDIATE',
    (name) => {
      expect(sqlText).toMatch(new RegExp(`${name}\\s+FOREIGN KEY \\(org_id, offering_partner_id\\)\\s+REFERENCES public\\.organizations \\(id, partner_id\\)\\s+DEFERRABLE INITIALLY IMMEDIATE`));
    },
  );

  it('export policy classifies the new columns (options → excludedOpen)', () => {
    const sessions = CORE_TENANT_EXPORT_POLICY['ai_sessions']!;
    expect(sessions.columns['offering_id']?.decision).toBe('include');
    expect(sessions.columns['offering_partner_id']?.decision).toBe('include');
    expect(sessions.columns['options']).toMatchObject({ decision: 'exclude', openContainerReviewed: true });
    const agents = CORE_TENANT_EXPORT_POLICY['ai_agents']!;
    expect(agents.columns['offering_id']?.decision).toBe('include');
    expect(agents.columns['offering_partner_id']?.decision).toBe('include');
  });

  it('does not drop the ai_sessions.model default in W02 (deferred to W03)', () => {
    expect(sqlText).not.toMatch(/ALTER COLUMN model DROP DEFAULT/i);
  });

  it('adds the ai_sessions constraints NOT VALID, validates them in -100500 and builds the index CONCURRENTLY in -100600', () => {
    for (const name of ['ai_sessions_offering_shape_chk', 'ai_sessions_offering_fk', 'ai_sessions_offering_org_partner_fk']) {
      const at = sqlText.indexOf(`ADD CONSTRAINT ${name}`);
      expect(sqlText.slice(at, sqlText.indexOf(';', at))).toMatch(/NOT VALID$/);
      expect(readMigration('2026-11-14-100500-ai-model-registry-session-agent-validate.sql')).toContain(`VALIDATE CONSTRAINT ${name}`);
    }
    const idx = readMigration('2026-11-14-100600-ai-sessions-offering-idx.sql');
    expect(idx.startsWith('-- @no-transaction')).toBe(true);
    expect(idx).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_sessions_offering_idx/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/db/schema/aiModelRegistry.contract.test.ts`
Expected: FAIL. The migration file is missing, and `sessions.columns['offering_id']` is undefined.

- [ ] **Step 3: Write the migration**

`apps/api/migrations/2026-11-14-100400-ai-model-registry-session-agent-columns.sql`:

```sql
-- AI model registry W02 (#7600, spec §5.6): which offering a chat session and
-- an AI agent policy are bound to. Columns + constraints only; the W02 boot
-- reconcile backfills live sessions and every agent row from their legacy
-- `model` string. Routing keeps reading `model` until W03.
--
-- Composite FKs (quorum #1), both sides:
--   (offering_id, offering_partner_id) -> partner_ai_models(id, partner_id)
--       ON DELETE SET NULL (an offering removed with its connection unbinds the
--       session/policy; the legacy `model` provenance stays)
--   (org_id, offering_partner_id) -> organizations(id, partner_id)
--       DEFERRABLE INITIALLY IMMEDIATE (org merge contract; merges are
--       same-partner). On ai_agents, partner rows have org_id NULL, so only
--       org rows are checked; partner rows carry a CHECK instead.
--
-- ai_sessions is device-denormalized (CORE_DEVICE_ORG_DENORMALIZED_TABLES):
-- a system-scope CROSS-PARTNER device move re-stamps a device-bound session's
-- org_id, which would violate the org composite FK. The guard trigger clears
-- the offering pair (and options) on an org change into another partner, so the
-- move succeeds and the session falls back to the new partner's assignment —
-- same posture as the topology alert ownership guard (2026-11-06-210400).
--
-- LOCKS: ai_sessions is large and hot. ADD COLUMN (no default) is
-- metadata-only, but this whole file is one transaction, so its ACCESS
-- EXCLUSIVE lock would be held through any validation scan. The ai_sessions
-- constraints are therefore added NOT VALID (no scan) and validated by -100500
-- under SHARE UPDATE EXCLUSIVE; the index is built CONCURRENTLY by -100600.
-- Precedent: 2026-07-17-a-device-vulnerabilities-software-fk-set-null.sql.
-- ai_agents is small and is validated inline.
--
-- Constraints are added only when missing (never dropped and re-added), so a
-- replay can't turn a validated constraint back into NOT VALID.
-- The stale ai_sessions.model default is deliberately NOT dropped here (W03).
-- Idempotent. Writes no rows.

ALTER TABLE public.ai_sessions ADD COLUMN IF NOT EXISTS offering_id uuid;
ALTER TABLE public.ai_sessions ADD COLUMN IF NOT EXISTS offering_partner_id uuid;
ALTER TABLE public.ai_sessions ADD COLUMN IF NOT EXISTS options jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_sessions_offering_shape_chk' AND conrelid = 'public.ai_sessions'::regclass) THEN
    ALTER TABLE public.ai_sessions ADD CONSTRAINT ai_sessions_offering_shape_chk CHECK (
      (offering_id IS NULL) = (offering_partner_id IS NULL)
      AND (options IS NULL OR jsonb_typeof(options) = 'object')
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_sessions_offering_fk' AND conrelid = 'public.ai_sessions'::regclass) THEN
    ALTER TABLE public.ai_sessions ADD CONSTRAINT ai_sessions_offering_fk
      FOREIGN KEY (offering_id, offering_partner_id)
      REFERENCES public.partner_ai_models (id, partner_id) ON DELETE SET NULL
      NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_sessions_offering_org_partner_fk' AND conrelid = 'public.ai_sessions'::regclass) THEN
    ALTER TABLE public.ai_sessions ADD CONSTRAINT ai_sessions_offering_org_partner_fk
      FOREIGN KEY (org_id, offering_partner_id)
      REFERENCES public.organizations (id, partner_id)
      DEFERRABLE INITIALLY IMMEDIATE
      NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.breeze_ai_sessions_offering_partner_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.offering_partner_id IS NOT NULL
     AND NEW.org_id IS DISTINCT FROM OLD.org_id
     AND NOT EXISTS (
       SELECT 1 FROM public.organizations AS o
        WHERE o.id = NEW.org_id AND o.partner_id = NEW.offering_partner_id
     ) THEN
    NEW.offering_id := NULL;
    NEW.offering_partner_id := NULL;
    NEW.options := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS breeze_ai_sessions_offering_partner_guard ON public.ai_sessions;
CREATE TRIGGER breeze_ai_sessions_offering_partner_guard
  BEFORE UPDATE OF org_id ON public.ai_sessions
  FOR EACH ROW EXECUTE FUNCTION public.breeze_ai_sessions_offering_partner_guard();

ALTER TABLE public.ai_agents ADD COLUMN IF NOT EXISTS offering_id uuid;
ALTER TABLE public.ai_agents ADD COLUMN IF NOT EXISTS offering_partner_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agents_offering_shape_chk' AND conrelid = 'public.ai_agents'::regclass) THEN
    ALTER TABLE public.ai_agents ADD CONSTRAINT ai_agents_offering_shape_chk CHECK (
      (offering_id IS NULL) = (offering_partner_id IS NULL)
      -- a partner-wide policy may only bind its own partner's offering
      AND (partner_id IS NULL OR offering_partner_id IS NULL OR partner_id = offering_partner_id)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agents_offering_fk' AND conrelid = 'public.ai_agents'::regclass) THEN
    ALTER TABLE public.ai_agents ADD CONSTRAINT ai_agents_offering_fk
      FOREIGN KEY (offering_id, offering_partner_id)
      REFERENCES public.partner_ai_models (id, partner_id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_agents_offering_org_partner_fk' AND conrelid = 'public.ai_agents'::regclass) THEN
    ALTER TABLE public.ai_agents ADD CONSTRAINT ai_agents_offering_org_partner_fk
      FOREIGN KEY (org_id, offering_partner_id)
      REFERENCES public.organizations (id, partner_id)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ai_agents_offering_idx
  ON public.ai_agents (offering_id) WHERE offering_id IS NOT NULL;
```

`apps/api/migrations/2026-11-14-100500-ai-model-registry-session-agent-validate.sql`:

```sql
-- AI model registry W02 (#7600): validate the ai_sessions constraints -100400
-- added NOT VALID. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, so chat
-- reads and writes continue during the scan (the new columns are all NULL, so
-- every row passes). A no-op once validated. Writes no rows.
ALTER TABLE public.ai_sessions VALIDATE CONSTRAINT ai_sessions_offering_shape_chk;
ALTER TABLE public.ai_sessions VALIDATE CONSTRAINT ai_sessions_offering_fk;
ALTER TABLE public.ai_sessions VALIDATE CONSTRAINT ai_sessions_offering_org_partner_fk;
```

`apps/api/migrations/2026-11-14-100600-ai-sessions-offering-idx.sql`:

```sql
-- @no-transaction
-- AI model registry W02 (#7600): index for the ai_sessions offering FK
-- (ON DELETE SET NULL scans by offering_id) and W03's session-binding reads.
-- Built CONCURRENTLY so chat writes are never blocked. An interrupted
-- CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS would accept,
-- so the DO block fails loudly in that state.
-- Recovery: DROP INDEX CONCURRENTLY public.ai_sessions_offering_idx, then let
-- autoMigrate re-run this file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_sessions_offering_idx
  ON public.ai_sessions (offering_id) WHERE offering_id IS NOT NULL;

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.ai_sessions'::regclass
     AND c.relname = 'ai_sessions_offering_idx'
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ai_sessions offering index build left INVALID index: % — DROP INDEX CONCURRENTLY it and re-apply this migration', bad;
  END IF;
END $$;
```

- [ ] **Step 4: Update the Drizzle tables**

`apps/api/src/db/schema/ai.ts`: add the import `import { partnerAiModels } from './aiModelRegistry';` and `foreignKey` to the `drizzle-orm/pg-core` import. Add to the `aiSessions` column object, after `topologySiteId`:

```ts
  // AI model registry W02 (#7600): the offering this session is bound to
  // (backfilled for live sessions by the boot reconcile; routing reads `model`
  // until W03). Composite FKs + a cross-partner org-change guard in
  // 2026-11-14-100400.
  offeringId: uuid('offering_id'),
  offeringPartnerId: uuid('offering_partner_id'),
  options: jsonb('options').$type<Record<string, unknown>>(),
```

and to its extras object:

```ts
  offeringFk: foreignKey({
    columns: [table.offeringId, table.offeringPartnerId],
    foreignColumns: [partnerAiModels.id, partnerAiModels.partnerId],
    name: 'ai_sessions_offering_fk',
  }).onDelete('set null'),
  offeringOrgPartnerFk: foreignKey({
    columns: [table.orgId, table.offeringPartnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'ai_sessions_offering_org_partner_fk',
  }),
  offeringIdx: index('ai_sessions_offering_idx').on(table.offeringId).where(sql`${table.offeringId} IS NOT NULL`),
```

`apps/api/src/db/schema/aiAgents.ts`: after `model`, add:

```ts
  // AI model registry W02 (#7600): the offering this policy is bound to
  // (backfilled from `model` by the boot reconcile; runs read `model` until W03).
  offeringId: uuid('offering_id'),
  offeringPartnerId: uuid('offering_partner_id'),
```

and the matching `offeringFk` / `offeringOrgPartnerFk` / `offeringIdx` extras (names `ai_agents_offering_fk`, `ai_agents_offering_org_partner_fk`, `ai_agents_offering_idx`), mirroring the `aiSessions` ones above. Add `foreignKey` to its import and `import { partnerAiModels } from './aiModelRegistry';`. If importing `aiModelRegistry` creates a schema import cycle (`aiModelRegistry` → `orgs` → … → `ai`), express both FKs in SQL only and drop them from Drizzle. Deferrability is SQL-only anyway, and `db:check-drift` (Task 17) decides whether Drizzle must also declare them.

- [ ] **Step 5: Classify the new columns**

`apps/api/src/services/tenantExportPolicyRegistry.ts`:
- `"ai_sessions"`: append `"offering_id","offering_partner_id"` to `included`, and `"options"` to `excludedOpen` (it becomes `["context_snapshot","options"]`).
- `"ai_agents"`: append `"offering_id","offering_partner_id"` to `included`.

Put this comment above the `"ai_sessions"` line:

```ts
  // #7600 W02: offering_id / offering_partner_id are registry ids (included);
  // options is the jsonb OfferingOptions -> excludedOpen (CLAUDE.md).
```

- [ ] **Step 6: Append the forgery suite**

Append to `aiModelRegistryFixtures.ts`:

```ts
/** Seeds a live ai_agents row (kind 'triage') owned by a partner OR an org. */
export async function seedAgent(input: { partnerId?: string; orgId?: string; createdBy: string; model?: string | null }): Promise<string> {
  const [row] = await fixtureSql`
    INSERT INTO ai_agents (partner_id, org_id, kind, name, created_by, model)
    VALUES (${input.partnerId ?? null}, ${input.orgId ?? null}, 'triage', 'W02 fixture', ${input.createdBy}, ${input.model ?? null})
    RETURNING id`;
  return String(row!.id);
}
```

Append to `aiModelRegistryForgery.integration.test.ts` (add `createUser` to the `./db-utils` import and `seedAgent` to the fixtures import):

```ts
describe.skipIf(!RUN)('ai_sessions / ai_agents offering bindings (#7600 W02)', () => {
  async function twoPartners() {
    const [a, b] = [await createPartner(), await createPartner()];
    const [orgA, orgB] = [await createOrganization({ partnerId: a.id }), await createOrganization({ partnerId: b.id })];
    const offA = await seedOffering({ partnerId: a.id, platformModelId: await seedPlatformModel() });
    const offB = await seedOffering({ partnerId: b.id, platformModelId: await seedPlatformModel() });
    return { a, b, orgA, orgB, offA, offB };
  }
  async function seedSession(orgId: string): Promise<string> {
    const [row] = await adminSql`INSERT INTO ai_sessions (org_id) VALUES (${orgId}) RETURNING id`;
    return String(row!.id);
  }

  it('a session cannot bind another partner\'s offering (23503 on either composite FK)', async () => {
    const t = await twoPartners();
    const s = await seedSession(t.orgA.id);
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE ai_sessions SET offering_id = ${t.offB}, offering_partner_id = ${t.b.id} WHERE id = ${s}`)))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'ai_sessions_offering_org_partner_fk' } });
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE ai_sessions SET offering_id = ${t.offB}, offering_partner_id = ${t.a.id} WHERE id = ${s}`)))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'ai_sessions_offering_fk' } });
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE ai_sessions SET offering_id = ${t.offA} WHERE id = ${s}`)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('a cross-partner org change (device move) clears the session offering instead of aborting', async () => {
    const t = await twoPartners();
    const s = await seedSession(t.orgA.id);
    await adminSql`UPDATE ai_sessions SET offering_id = ${t.offA}, offering_partner_id = ${t.a.id}, options = '{"effort":"high"}' WHERE id = ${s}`;
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE ai_sessions SET org_id = ${t.orgB.id} WHERE id = ${s}`));
    const [row] = await adminSql`SELECT org_id, offering_id, offering_partner_id, options FROM ai_sessions WHERE id = ${s}`;
    expect(row).toMatchObject({ org_id: t.orgB.id, offering_id: null, offering_partner_id: null, options: null });
  });

  it('a same-partner org change keeps the binding', async () => {
    const t = await twoPartners();
    const orgA2 = await createOrganization({ partnerId: t.a.id });
    const s = await seedSession(t.orgA.id);
    await adminSql`UPDATE ai_sessions SET offering_id = ${t.offA}, offering_partner_id = ${t.a.id} WHERE id = ${s}`;
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE ai_sessions SET org_id = ${orgA2.id} WHERE id = ${s}`));
    const [row] = await adminSql`SELECT offering_id FROM ai_sessions WHERE id = ${s}`;
    expect(row!.offering_id).toBe(t.offA);
  });

  it('removing a connection unbinds sessions on its offerings (ON DELETE SET NULL)', async () => {
    const p = await createPartner();
    const org = await createOrganization({ partnerId: p.id });
    const conn = await seedByokConnection(p.id);
    const off = await seedOffering({ partnerId: p.id, connectionId: conn, modelId: 'claude-sonnet-5-5' });
    const s = await seedSession(org.id);
    await adminSql`UPDATE ai_sessions SET offering_id = ${off}, offering_partner_id = ${p.id} WHERE id = ${s}`;
    await adminSql`DELETE FROM partner_ai_connections WHERE id = ${conn}`;
    const [row] = await adminSql`SELECT offering_id, offering_partner_id FROM ai_sessions WHERE id = ${s}`;
    expect(row).toMatchObject({ offering_id: null, offering_partner_id: null });
  });

  it('an agent policy cannot bind another partner\'s offering (23514 partner row, 23503 org row)', async () => {
    const t = await twoPartners();
    const user = await createUser({ partnerId: t.a.id });
    const partnerAgent = await seedAgent({ partnerId: t.a.id, createdBy: user.id, model: 'claude-sonnet-5-5' });
    const orgAgent = await seedAgent({ orgId: t.orgA.id, createdBy: user.id, model: 'claude-haiku-4-5' });
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE ai_agents SET offering_id = ${t.offB}, offering_partner_id = ${t.b.id} WHERE id = ${partnerAgent}`)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE ai_agents SET offering_id = ${t.offB}, offering_partner_id = ${t.b.id} WHERE id = ${orgAgent}`)))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'ai_agents_offering_org_partner_fk' } });
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE ai_agents SET offering_id = ${t.offB}, offering_partner_id = ${t.a.id} WHERE id = ${orgAgent}`)))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'ai_agents_offering_fk' } });
    // The legitimate binding works and leaves the legacy model untouched.
    await withSystemDbAccessContext(() => db.execute(sql`
      UPDATE ai_agents SET offering_id = ${t.offA}, offering_partner_id = ${t.a.id} WHERE id = ${partnerAgent}`));
    const [row] = await adminSql`SELECT model FROM ai_agents WHERE id = ${partnerAgent}`;
    expect(row!.model).toBe('claude-sonnet-5-5');
  });

  it.each(['ai_sessions_offering_org_partner_fk', 'ai_agents_offering_org_partner_fk'])(
    '%s is deferrable (merge contract) and validated',
    async (name) => {
      const [row] = await adminSql`SELECT condeferrable, condeferred, convalidated FROM pg_constraint WHERE conname = ${name}`;
      expect(row).toMatchObject({ condeferrable: true, condeferred: false, convalidated: true });
    },
  );
});
```

- [ ] **Step 7: Run unit + integration + the registration contracts**

```bash
cd apps/api && npx vitest run src/db/schema/aiModelRegistry.contract.test.ts src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/aiModelRegistryForgery.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/ai-budget-reservations.integration.test.ts
cd apps/api && DB_CONTEXTLESS_WRITE_STRICT=true pnpm test:rls-coverage
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

Expected: PASS. `ai-budget-reservations.integration.test.ts` stays green unmodified, which proves the kept `model` default.

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/2026-11-14-100400-ai-model-registry-session-agent-columns.sql \
  apps/api/migrations/2026-11-14-100500-ai-model-registry-session-agent-validate.sql \
  apps/api/migrations/2026-11-14-100600-ai-sessions-offering-idx.sql apps/api/src/db/schema/ai.ts \
  apps/api/src/db/schema/aiAgents.ts apps/api/src/services/tenantExportPolicyRegistry.ts \
  apps/api/src/db/schema/aiModelRegistry.contract.test.ts \
  apps/api/src/__tests__/integration/aiModelRegistryFixtures.ts \
  apps/api/src/__tests__/integration/aiModelRegistryForgery.integration.test.ts
git commit -m "feat(ai): bind ai_sessions and ai_agents to offerings with composite FKs and a cross-partner move guard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 7: `services/aiModels/connections.ts` — list, get, create, decrypt (unit + integration)

**Files:**
- Create: `apps/api/src/services/aiModels/connections.ts`
- Create: `apps/api/src/services/aiModels/connections.test.ts`
- Create: `apps/api/src/__tests__/integration/aiModelRegistryServices.integration.test.ts` (Tasks 8 and 9 append)
- Modify: `apps/api/src/services/aiModels/index.ts` (append `export * from './connections';`)
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` (`ALLOWED_WITHOUT_CAPABILITY_CHECK`, keep keys sorted)

**Interfaces:**
- Consumes: `partnerAiConnections` (Task 2); the registry spec (Task 2); `encryptSecret`, `decryptSecret`, `hmacFingerprint` (`services/secretCrypto.ts`).
- Produces (index-bound names first):
  - `listConnections(partnerId: string): Promise<PartnerAiConnection[]>` (oldest first, no key material)
  - `getConnection(id: string): Promise<PartnerAiConnection | null>` (no key material)
  - `createConnection(input: CreateConnectionInput): Promise<PartnerAiConnection>`
  - `decryptConnectionKey(conn: { id: string; apiKeyEncrypted: string | null }): string`
  - `type PartnerAiConnection = Omit<PartnerAiConnectionRow, 'apiKeyEncrypted' | 'keyFingerprint'>`
  - `type CreateConnectionInput = { id?: string; partnerId: string; kind: 'anthropic_byok' | 'catalog'; name: string; apiKey: string; catalogEntryId?: string | null; inferenceGeo?: string | null; connectedBy: string | null; verifiedAt: Date | null }`
  - Index additions:
    - `PARTNER_AI_CONNECTION_KEY_SPEC: EncryptedColumnSpec`
    - `encryptConnectionKey(id: string, apiKey: string): string`
    - `getConnectionKeyMaterial(id: string): Promise<{ id: string; partnerId: string; apiKeyEncrypted: string | null } | null>` (W03's connection factory)
    - `getCompatConnection(partnerId: string): Promise<PartnerAiConnection | null>` (the one `anthropic_byok`/`catalog` connection `/ai/provider` addresses)
    - `class ConnectionKeyError extends Error { code: 'key_missing' | 'key_empty' | 'key_rejected' }`

- [ ] **Step 1: Write the failing unit tests**

`apps/api/src/services/aiModels/connections.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ inserted: [] as Array<Record<string, unknown>>, selected: [] as unknown[], returned: [] as unknown[][] }));

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        state.inserted.push(values);
        return { returning: vi.fn((fields: Record<string, unknown>) => {
          state.selected.push(fields);
          return Promise.resolve(state.returned.shift() ?? []);
        }) };
      }),
    })),
    select: vi.fn((fields: Record<string, unknown>) => {
      state.selected.push(fields);
      const chain = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => Promise.resolve(state.returned.shift() ?? [])),
        then: (resolve: (rows: unknown[]) => unknown) => resolve(state.returned.shift() ?? []),
      };
      return chain;
    }),
  },
}));

import { columnAad, encryptedColumnRegistry } from '../encryptedColumnRegistry';
import { decryptSecret, encryptSecret } from '../secretCrypto';
import {
  ConnectionKeyError,
  createConnection,
  decryptConnectionKey,
  encryptConnectionKey,
  getConnection,
  listConnections,
  PARTNER_AI_CONNECTION_KEY_SPEC,
} from './connections';

const ID = '44444444-4444-4444-8444-444444444444';
const PARTNER = '55555555-5555-4555-8555-555555555555';
const saved = { key: process.env.APP_ENCRYPTION_KEY, keyId: process.env.APP_ENCRYPTION_KEY_ID };

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = 'connections-unit-test-key-material';
  process.env.APP_ENCRYPTION_KEY_ID = 'connections-test';
  state.inserted.length = 0;
  state.selected.length = 0;
  state.returned.length = 0;
});
afterEach(() => {
  if (saved.key === undefined) delete process.env.APP_ENCRYPTION_KEY; else process.env.APP_ENCRYPTION_KEY = saved.key;
  if (saved.keyId === undefined) delete process.env.APP_ENCRYPTION_KEY_ID; else process.env.APP_ENCRYPTION_KEY_ID = saved.keyId;
});

describe('connections key material (#7600 W02)', () => {
  it('uses the registry spec: row-bound under the legacy partner_llm_configs tag', () => {
    const registered = encryptedColumnRegistry.find((s) => s.table === 'partner_ai_connections' && s.column === 'api_key_encrypted');
    expect(PARTNER_AI_CONNECTION_KEY_SPEC).toBe(registered);
    expect(columnAad(PARTNER_AI_CONNECTION_KEY_SPEC, ID)).toBe(`partner_llm_configs.api_key_encrypted:${ID}`);
  });

  it('decrypts a ciphertext sealed by the legacy partnerLlmConfig writer for the same id (quorum #13)', () => {
    const legacySpec = encryptedColumnRegistry.find((s) => s.table === 'partner_llm_configs' && s.column === 'api_key_encrypted')!;
    const legacyCiphertext = encryptSecret('sk-ant-api03-legacy-unit', { aad: columnAad(legacySpec, ID) })!;
    expect(decryptConnectionKey({ id: ID, apiKeyEncrypted: legacyCiphertext })).toBe('sk-ant-api03-legacy-unit');
  });

  it('round-trips its own ciphertext and refuses another row id', () => {
    const sealed = encryptConnectionKey(ID, 'sk-ant-api03-own');
    expect(decryptConnectionKey({ id: ID, apiKeyEncrypted: sealed })).toBe('sk-ant-api03-own');
    expect(() => decryptConnectionKey({ id: '66666666-6666-4666-8666-666666666666', apiKeyEncrypted: sealed })).toThrow();
  });

  it('a connection without a key raises ConnectionKeyError(key_missing)', () => {
    expect(() => decryptConnectionKey({ id: ID, apiKeyEncrypted: null })).toThrow(ConnectionKeyError);
    try { decryptConnectionKey({ id: ID, apiKeyEncrypted: null }); } catch (e) { expect((e as ConnectionKeyError).code).toBe('key_missing'); }
  });
});

describe('createConnection (#7600 W02)', () => {
  it('rejects an encrypted-envelope paste and a catalog kind without an entry, writing nothing', async () => {
    await expect(createConnection({ partnerId: PARTNER, kind: 'anthropic_byok', name: 'k', apiKey: 'enc:v3:x', connectedBy: null, verifiedAt: null }))
      .rejects.toMatchObject({ code: 'key_rejected' });
    await expect(createConnection({ partnerId: PARTNER, kind: 'catalog', name: 'k', apiKey: 'sk-ant-api03-x', connectedBy: null, verifiedAt: null }))
      .rejects.toThrow(/catalog entry/);
    expect(state.inserted).toEqual([]);
  });

  it('seals the trimmed key to the row id, stores last4 + fingerprint, and never returns key material', async () => {
    state.returned.push([{ id: ID, partnerId: PARTNER, kind: 'anthropic_byok', name: 'k', keyLast4: 'abcd' }]);
    const created = await createConnection({ id: ID, partnerId: PARTNER, kind: 'anthropic_byok', name: 'k', apiKey: '  sk-ant-api03-zzzzabcd  ', connectedBy: null, verifiedAt: null });
    const values = state.inserted[0]!;
    expect(values).toMatchObject({ id: ID, partnerId: PARTNER, kind: 'anthropic_byok', keyLast4: 'abcd', status: 'active', configVersion: 1 });
    expect(decryptSecret(String(values.apiKeyEncrypted), { aad: columnAad(PARTNER_AI_CONNECTION_KEY_SPEC, ID) })).toBe('sk-ant-api03-zzzzabcd');
    expect(String(values.keyFingerprint)).toMatch(/^fp1:/);
    expect(Object.keys(state.selected[0] as object)).not.toContain('apiKeyEncrypted');
    expect(created).not.toHaveProperty('apiKeyEncrypted');
  });
});

describe('connection reads never select key material (#7600 W02)', () => {
  it('listConnections and getConnection project the public columns only', async () => {
    state.returned.push([], []);
    await listConnections(PARTNER);
    await getConnection(ID);
    for (const fields of state.selected) {
      expect(Object.keys(fields as object)).not.toContain('apiKeyEncrypted');
      expect(Object.keys(fields as object)).not.toContain('keyFingerprint');
    }
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/connections.test.ts`
Expected: FAIL, because `./connections` does not resolve.

- [ ] **Step 3: Implement**

`apps/api/src/services/aiModels/connections.ts`:

```ts
/**
 * Partner AI connections (#7600 W02, spec §5.2): how a partner's models are
 * reached. Reads never select key material; only `getConnectionKeyMaterial`
 * (W03's connection factory) and `decryptConnectionKey` touch it.
 *
 * W02: the only production writer is the legacy reconcile (byte-copy of
 * partner_llm_configs) and the legacy-UPDATE mirror trigger (Task 2 migration);
 * `createConnection` is the W04 entry point, gated at its route.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { partnerAiConnections, type PartnerAiConnectionRow } from '../../db/schema';
import { columnAad, encryptedColumnRegistry, type EncryptedColumnSpec } from '../encryptedColumnRegistry';
import { decryptSecret, encryptSecret, hmacFingerprint } from '../secretCrypto';

export const PARTNER_AI_CONNECTION_KEY_SPEC: EncryptedColumnSpec = (() => {
  const spec = encryptedColumnRegistry.find(
    (entry) => entry.table === 'partner_ai_connections' && entry.column === 'api_key_encrypted',
  );
  if (!spec) throw new Error('partner_ai_connections.api_key_encrypted is missing from encryptedColumnRegistry');
  return spec;
})();

export type PartnerAiConnection = Omit<PartnerAiConnectionRow, 'apiKeyEncrypted' | 'keyFingerprint'>;

export class ConnectionKeyError extends Error {
  constructor(message: string, readonly code: 'key_missing' | 'key_empty' | 'key_rejected') {
    super(message);
    this.name = 'ConnectionKeyError';
  }
}

export interface CreateConnectionInput {
  id?: string;
  partnerId: string;
  kind: 'anthropic_byok' | 'catalog';
  name: string;
  apiKey: string;
  catalogEntryId?: string | null;
  inferenceGeo?: string | null;
  connectedBy: string | null;
  verifiedAt: Date | null;
}

const PUBLIC_COLUMNS = {
  id: partnerAiConnections.id,
  partnerId: partnerAiConnections.partnerId,
  kind: partnerAiConnections.kind,
  name: partnerAiConnections.name,
  inferenceGeo: partnerAiConnections.inferenceGeo,
  providerConfig: partnerAiConnections.providerConfig,
  keyLast4: partnerAiConnections.keyLast4,
  catalogEntryId: partnerAiConnections.catalogEntryId,
  baseUrl: partnerAiConnections.baseUrl,
  status: partnerAiConnections.status,
  lastError: partnerAiConnections.lastError,
  verifiedAt: partnerAiConnections.verifiedAt,
  configVersion: partnerAiConnections.configVersion,
  connectedBy: partnerAiConnections.connectedBy,
  lastDiscoveredAt: partnerAiConnections.lastDiscoveredAt,
  discoveryError: partnerAiConnections.discoveryError,
  legacyDefaultModel: partnerAiConnections.legacyDefaultModel,
  createdAt: partnerAiConnections.createdAt,
  updatedAt: partnerAiConnections.updatedAt,
} as const;

export function encryptConnectionKey(id: string, apiKey: string): string {
  const sealed = encryptSecret(apiKey, { aad: columnAad(PARTNER_AI_CONNECTION_KEY_SPEC, id) });
  if (!sealed) throw new ConnectionKeyError('Could not encrypt the connection key.', 'key_rejected');
  return sealed;
}

export function decryptConnectionKey(conn: { id: string; apiKeyEncrypted: string | null }): string {
  if (!conn.apiKeyEncrypted) throw new ConnectionKeyError('This connection has no stored key.', 'key_missing');
  const apiKey = decryptSecret(conn.apiKeyEncrypted, { aad: columnAad(PARTNER_AI_CONNECTION_KEY_SPEC, conn.id) });
  if (!apiKey) throw new ConnectionKeyError('The stored connection key decrypted to an empty value.', 'key_empty');
  return apiKey;
}

export async function listConnections(partnerId: string): Promise<PartnerAiConnection[]> {
  return db
    .select(PUBLIC_COLUMNS)
    .from(partnerAiConnections)
    .where(eq(partnerAiConnections.partnerId, partnerId))
    .orderBy(asc(partnerAiConnections.createdAt));
}

export async function getConnection(id: string): Promise<PartnerAiConnection | null> {
  const [row] = await db.select(PUBLIC_COLUMNS).from(partnerAiConnections).where(eq(partnerAiConnections.id, id)).limit(1);
  return row ?? null;
}

export async function getCompatConnection(partnerId: string): Promise<PartnerAiConnection | null> {
  // partner_ai_connections_compat_uq guarantees at most one such row (W02–W03).
  const [row] = await db
    .select(PUBLIC_COLUMNS)
    .from(partnerAiConnections)
    .where(and(
      eq(partnerAiConnections.partnerId, partnerId),
      inArray(partnerAiConnections.kind, ['anthropic_byok', 'catalog']),
    ))
    .limit(1);
  return row ?? null;
}

export async function getConnectionKeyMaterial(
  id: string,
): Promise<{ id: string; partnerId: string; apiKeyEncrypted: string | null } | null> {
  const [row] = await db
    .select({ id: partnerAiConnections.id, partnerId: partnerAiConnections.partnerId, apiKeyEncrypted: partnerAiConnections.apiKeyEncrypted })
    .from(partnerAiConnections)
    .where(eq(partnerAiConnections.id, id))
    .limit(1);
  return row ?? null;
}

export async function createConnection(input: CreateConnectionInput): Promise<PartnerAiConnection> {
  const apiKey = input.apiKey.trim();
  if (apiKey.startsWith('enc:')) {
    throw new ConnectionKeyError('Keys must not start with the encrypted-value prefix.', 'key_rejected');
  }
  if (input.kind === 'catalog' && !input.catalogEntryId) {
    throw new Error('A catalog connection needs a catalog entry.');
  }
  const id = input.id ?? randomUUID();
  const [created] = await db
    .insert(partnerAiConnections)
    .values({
      id,
      partnerId: input.partnerId,
      kind: input.kind,
      name: input.name,
      inferenceGeo: input.inferenceGeo ?? null,
      apiKeyEncrypted: encryptConnectionKey(id, apiKey),
      keyLast4: apiKey.slice(-4),
      keyFingerprint: hmacFingerprint(apiKey),
      catalogEntryId: input.kind === 'catalog' ? input.catalogEntryId! : null,
      status: 'active',
      configVersion: 1,
      verifiedAt: input.verifiedAt,
      connectedBy: input.connectedBy,
    })
    .returning(PUBLIC_COLUMNS);
  if (!created) throw new Error('Could not create the connection.');
  return created;
}
```

Append `export * from './connections';` to `apps/api/src/services/aiModels/index.ts`.

`apps/api/src/__tests__/partner-wide-write-coverage.test.ts`, in `ALLOWED_WITHOUT_CAPABILITY_CHECK` (sorted position):

```ts
  'services/aiModels/connections.ts': 'no W02 route calls createConnection; W04 gates it at routes/aiModels.ts (BILLING_MANAGE + canManagePartnerWidePolicies). Partner-axis only (no org_id), and the partner id is always the caller\'s own',
```

- [ ] **Step 4: Add the real-Postgres round trip**

`apps/api/src/__tests__/integration/aiModelRegistryServices.integration.test.ts`:

```ts
/**
 * AI model registry W02 (#7600): connections / offerings / assignments
 * services against real Postgres, under the caller contexts that will use them.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { withDbAccessContext } from '../../db';
import { createConnection, decryptConnectionKey, getConnectionKeyMaterial, listConnections } from '../../services/aiModels/connections';
import { createOrganization, createPartner } from './db-utils';
import { closeRegistryFixtures, orgContext, partnerContext } from './aiModelRegistryFixtures';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

describe.skipIf(!RUN)('connections service (#7600 W02)', () => {
  it('a partner creates, lists and decrypts its own connection; another partner and an org token see nothing', async () => {
    const [p, q] = [await createPartner(), await createPartner()];
    const org = await createOrganization({ partnerId: p.id });
    const created = await withDbAccessContext(partnerContext(p.id), () => createConnection({
      partnerId: p.id, kind: 'anthropic_byok', name: 'Anthropic API key',
      apiKey: 'sk-ant-api03-integration-9999', connectedBy: null, verifiedAt: new Date(),
    }));
    expect(created.keyLast4).toBe('9999');
    const material = await withDbAccessContext(partnerContext(p.id), () => getConnectionKeyMaterial(created.id));
    expect(decryptConnectionKey(material!)).toBe('sk-ant-api03-integration-9999');
    expect(await withDbAccessContext(partnerContext(q.id), () => listConnections(p.id))).toEqual([]);
    expect(await withDbAccessContext(orgContext(org.id, p.id), () => listConnections(p.id))).toEqual([]);
  });
});
```

- [ ] **Step 5: Run unit + integration + the coverage guard**

```bash
cd apps/api && npx vitest run src/services/aiModels/connections.test.ts src/__tests__/partner-wide-write-coverage.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelRegistryServices.integration.test.ts
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

Expected: PASS. Drop the allowlist entry temporarily to watch `partner-wide-write-coverage.test.ts` fail on `services/aiModels/connections.ts`, then restore it.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/aiModels/connections.ts apps/api/src/services/aiModels/connections.test.ts \
  apps/api/src/services/aiModels/index.ts apps/api/src/__tests__/partner-wide-write-coverage.test.ts \
  apps/api/src/__tests__/integration/aiModelRegistryServices.integration.test.ts
git commit -m "feat(ai): connections service with legacy-tag key decryption and key-free reads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 8: `services/aiModels/offerings.ts` — list, get, enable (price rule), legacy-call lookup (unit + integration)

**Files:**
- Create: `apps/api/src/services/aiModels/offerings.ts`
- Create: `apps/api/src/services/aiModels/offerings.test.ts`
- Modify: `apps/api/src/services/aiModels/index.ts` (append `export * from './offerings';`)
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts`
- Modify: `apps/api/src/__tests__/integration/aiModelRegistryServices.integration.test.ts` (append)

**Interfaces:**
- Consumes: `partnerAiModels`, `partnerAiConnections` (Tasks 2–3); `aiPlatformModels` (W01); `getListedProviderByEntryId` (`services/llmProviderCatalog.ts`).
- Produces:
  - `type Offering = PartnerAiModelRow`
  - `listOfferings(partnerId: string, opts?: { enabledOnly?: boolean; connectionId?: string | null }): Promise<Offering[]>`
  - `getOffering(id: string): Promise<Offering | null>`
  - `enableOffering(input: { partnerId: string; offeringId: string; enabled: boolean }): Promise<Offering>`
  - Index additions:
    - `type OfferingPriceSource = 'platform' | 'offering' | 'catalog' | 'linked_platform'`
    - `offeringPriceSource(o: Pick<Offering, 'source' | 'priceInputCentsPerM' | 'platformModelId'>, ctx: { platformRowPriced: boolean; catalogMapsAndVerifies: boolean }): OfferingPriceSource | null` (pure, spec §8 precedence)
    - `findOfferingIdForModel(input: { partnerId: string; connectionId: string | null; modelId: string }): Promise<string | null>`
    - `class OfferingWriteError extends Error { code: 'not_found' | 'unpriced' }`

- [ ] **Step 1: Write the failing unit test for the pure price rule**

`apps/api/src/services/aiModels/offerings.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ db: {} }));
vi.mock('../llmProviderCatalog', () => ({ getListedProviderByEntryId: vi.fn() }));

import { offeringPriceSource } from './offerings';

const priced = { priceInputCentsPerM: 100 };
const unpriced = { priceInputCentsPerM: null };

describe('offeringPriceSource — spec §8 precedence (#7600 W02)', () => {
  it.each([
    // [label, offering, ctx, expected]
    ['platform offering, priced platform row', { source: 'platform', platformModelId: 'pm', ...unpriced }, { platformRowPriced: true, catalogMapsAndVerifies: false }, 'platform'],
    ['platform offering, UNPRICED platform row', { source: 'platform', platformModelId: 'pm', ...unpriced }, { platformRowPriced: false, catalogMapsAndVerifies: false }, null],
    ['byok with its own price wins over a linked row', { source: 'discovered', platformModelId: 'pm', ...priced }, { platformRowPriced: true, catalogMapsAndVerifies: false }, 'offering'],
    ['byok linked to a priced platform row', { source: 'discovered', platformModelId: 'pm', ...unpriced }, { platformRowPriced: true, catalogMapsAndVerifies: false }, 'linked_platform'],
    ['byok linked to an unpriced platform row', { source: 'discovered', platformModelId: 'pm', ...unpriced }, { platformRowPriced: false, catalogMapsAndVerifies: false }, null],
    ['manual with a price', { source: 'manual', platformModelId: null, ...priced }, { platformRowPriced: false, catalogMapsAndVerifies: false }, 'offering'],
    ['manual without a price', { source: 'manual', platformModelId: null, ...unpriced }, { platformRowPriced: false, catalogMapsAndVerifies: false }, null],
    ['catalog mapped + verified', { source: 'catalog', platformModelId: null, ...unpriced }, { platformRowPriced: false, catalogMapsAndVerifies: true }, 'catalog'],
    ['catalog not in the revision', { source: 'catalog', platformModelId: null, ...unpriced }, { platformRowPriced: false, catalogMapsAndVerifies: false }, null],
  ] as const)('%s', (_label, offering, ctx, expected) => {
    expect(offeringPriceSource(offering as never, ctx)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/offerings.test.ts`
Expected: FAIL, because `./offerings` does not resolve.

- [ ] **Step 3: Implement**

`apps/api/src/services/aiModels/offerings.ts`:

```ts
/**
 * Partner offerings (#7600 W02, spec §5.3). W02 writers: the legacy reconcile
 * (Task 12) and enableOffering (no W02 route; W04 gates it at its route).
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { aiPlatformModels, partnerAiConnections, partnerAiModels, type PartnerAiModelRow } from '../../db/schema';
import { getListedProviderByEntryId } from '../llmProviderCatalog';

export type Offering = PartnerAiModelRow;
export type OfferingPriceSource = 'platform' | 'offering' | 'catalog' | 'linked_platform';

export class OfferingWriteError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'unpriced') {
    super(message);
    this.name = 'OfferingWriteError';
  }
}

/**
 * Spec §8: a platform offering is priced only by its platform row; a
 * connection offering by (1) its own price, (2) the catalog revision's mapped
 * + verified price, (3) its linked platform row; otherwise unpriced. The price
 * CHECK makes the four price columns all-or-none, so input is the witness.
 */
export function offeringPriceSource(
  o: Pick<Offering, 'source' | 'priceInputCentsPerM' | 'platformModelId'>,
  ctx: { platformRowPriced: boolean; catalogMapsAndVerifies: boolean },
): OfferingPriceSource | null {
  if (o.source === 'platform') return ctx.platformRowPriced ? 'platform' : null;
  if (o.priceInputCentsPerM !== null && o.priceInputCentsPerM !== undefined) return 'offering';
  if (o.source === 'catalog') return ctx.catalogMapsAndVerifies ? 'catalog' : null;
  if (o.platformModelId && ctx.platformRowPriced) return 'linked_platform';
  return null;
}

export async function listOfferings(
  partnerId: string,
  opts: { enabledOnly?: boolean; connectionId?: string | null } = {},
): Promise<Offering[]> {
  const conditions = [eq(partnerAiModels.partnerId, partnerId)];
  if (opts.enabledOnly) conditions.push(eq(partnerAiModels.enabled, true));
  if (opts.connectionId === null) conditions.push(isNull(partnerAiModels.connectionId));
  else if (opts.connectionId !== undefined) conditions.push(eq(partnerAiModels.connectionId, opts.connectionId));
  return db.select().from(partnerAiModels).where(and(...conditions)).orderBy(asc(partnerAiModels.createdAt));
}

export async function getOffering(id: string): Promise<Offering | null> {
  const [row] = await db.select().from(partnerAiModels).where(eq(partnerAiModels.id, id)).limit(1);
  return row ?? null;
}

async function platformRowPriced(platformModelId: string | null): Promise<boolean> {
  if (!platformModelId) return false;
  const [row] = await db
    .select({ input: aiPlatformModels.inputCentsPerM, output: aiPlatformModels.outputCentsPerM, read: aiPlatformModels.cacheReadCentsPerM, write: aiPlatformModels.cacheWriteCentsPerM })
    .from(aiPlatformModels)
    .where(eq(aiPlatformModels.id, platformModelId))
    .limit(1);
  return !!row && [row.input, row.output, row.read, row.write].every((v) => v !== null && v !== undefined);
}

async function catalogMapsAndVerifies(o: Offering): Promise<boolean> {
  if (o.source !== 'catalog' || !o.connectionId || !o.modelId) return false;
  const [conn] = await db
    .select({ catalogEntryId: partnerAiConnections.catalogEntryId })
    .from(partnerAiConnections)
    .where(eq(partnerAiConnections.id, o.connectionId))
    .limit(1);
  if (!conn?.catalogEntryId) return false;
  const provider = await getListedProviderByEntryId(conn.catalogEntryId);
  if (!provider) return false;
  return Object.hasOwn(provider.modelMap, o.modelId) && provider.verifiedModels.includes(o.modelId);
}

/** Spec §8: a non-platform offering with no resolvable price can't be enabled. Disabling is always allowed. */
export async function enableOffering(input: { partnerId: string; offeringId: string; enabled: boolean }): Promise<Offering> {
  const [offering] = await db
    .select()
    .from(partnerAiModels)
    .where(and(eq(partnerAiModels.id, input.offeringId), eq(partnerAiModels.partnerId, input.partnerId)))
    .limit(1);
  if (!offering) throw new OfferingWriteError('Offering not found.', 'not_found');
  if (input.enabled) {
    const source = offeringPriceSource(offering, {
      platformRowPriced: await platformRowPriced(offering.platformModelId),
      catalogMapsAndVerifies: await catalogMapsAndVerifies(offering),
    });
    if (!source) {
      throw new OfferingWriteError('Set a price for this model before enabling it (0 is valid for local models).', 'unpriced');
    }
  }
  const [updated] = await db
    .update(partnerAiModels)
    .set({ enabled: input.enabled, updatedAt: new Date() })
    .where(and(eq(partnerAiModels.id, input.offeringId), eq(partnerAiModels.partnerId, input.partnerId)))
    .returning();
  if (!updated) throw new OfferingWriteError('Offering not found.', 'not_found');
  return updated;
}

/** The offering a legacy call ran on: platform → (partner, platform row with this model id); connection → (connection, model id). */
export async function findOfferingIdForModel(input: { partnerId: string; connectionId: string | null; modelId: string }): Promise<string | null> {
  if (input.connectionId === null) {
    const [row] = await db
      .select({ id: partnerAiModels.id })
      .from(partnerAiModels)
      .innerJoin(aiPlatformModels, eq(aiPlatformModels.id, partnerAiModels.platformModelId))
      .where(and(
        eq(partnerAiModels.partnerId, input.partnerId),
        isNull(partnerAiModels.connectionId),
        eq(aiPlatformModels.modelId, input.modelId),
      ))
      .limit(1);
    return row?.id ?? null;
  }
  const [row] = await db
    .select({ id: partnerAiModels.id })
    .from(partnerAiModels)
    .where(and(
      eq(partnerAiModels.partnerId, input.partnerId),
      eq(partnerAiModels.connectionId, input.connectionId),
      eq(partnerAiModels.modelId, input.modelId),
    ))
    .limit(1);
  return row?.id ?? null;
}
```

Append `export * from './offerings';` to the aiModels `index.ts`, and add this allowlist entry:

```ts
  'services/aiModels/offerings.ts': 'enableOffering has no W02 route; W04 gates it at routes/aiModels.ts (BILLING_MANAGE + canManagePartnerWidePolicies). Partner-axis only, every write pinned to input.partnerId',
```

- [ ] **Step 4: Append the real-Postgres checks**

Append to `aiModelRegistryServices.integration.test.ts` (extend the imports with `enableOffering`, `findOfferingIdForModel`, `listOfferings` from `../../services/aiModels/offerings`, and `seedByokConnection`, `seedOffering`, `seedPlatformModel`, `fixtureSql` from the fixtures):

```ts
describe.skipIf(!RUN)('offerings service (#7600 W02)', () => {
  it('refuses to enable an unpriced manual offering, enables it once priced', async () => {
    const p = await createPartner();
    const conn = await seedByokConnection(p.id);
    const off = await seedOffering({ partnerId: p.id, connectionId: conn, modelId: 'my-gateway-model', source: 'manual', enabled: false });
    await expect(withDbAccessContext(partnerContext(p.id), () => enableOffering({ partnerId: p.id, offeringId: off, enabled: true })))
      .rejects.toMatchObject({ code: 'unpriced' });
    await fixtureSql`UPDATE partner_ai_models SET price_input_cents_per_m = 0, price_output_cents_per_m = 0,
                     price_cache_read_cents_per_m = 0, price_cache_write_cents_per_m = 0 WHERE id = ${off}`;
    const enabled = await withDbAccessContext(partnerContext(p.id), () => enableOffering({ partnerId: p.id, offeringId: off, enabled: true }));
    expect(enabled.enabled).toBe(true);
  });

  it('cannot enable another partner\'s offering (not_found under its own context)', async () => {
    const [p, q] = [await createPartner(), await createPartner()];
    const off = await seedOffering({ partnerId: q.id, platformModelId: await seedPlatformModel(), enabled: false });
    await expect(withDbAccessContext(partnerContext(p.id), () => enableOffering({ partnerId: p.id, offeringId: off, enabled: true })))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('finds the offering a legacy call ran on, for the platform and a connection', async () => {
    const p = await createPartner();
    const modelId = `w02-find-${Date.now()}`;
    const pm = await seedPlatformModel(modelId);
    const platformOffering = await seedOffering({ partnerId: p.id, platformModelId: pm });
    const conn = await seedByokConnection(p.id);
    const byok = await seedOffering({ partnerId: p.id, connectionId: conn, modelId });
    await withDbAccessContext(partnerContext(p.id), async () => {
      expect(await findOfferingIdForModel({ partnerId: p.id, connectionId: null, modelId })).toBe(platformOffering);
      expect(await findOfferingIdForModel({ partnerId: p.id, connectionId: conn, modelId })).toBe(byok);
      expect(await findOfferingIdForModel({ partnerId: p.id, connectionId: conn, modelId: 'nope' })).toBeNull();
      expect((await listOfferings(p.id, { connectionId: null })).map((o) => o.id)).toEqual([platformOffering]);
    });
  });
});
```

- [ ] **Step 5: Run unit + integration + guard + typecheck**

```bash
cd apps/api && npx vitest run src/services/aiModels/offerings.test.ts src/__tests__/partner-wide-write-coverage.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelRegistryServices.integration.test.ts
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

Expected: PASS (9 pure cases; 4 integration tests in the file so far).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/aiModels/offerings.ts apps/api/src/services/aiModels/offerings.test.ts \
  apps/api/src/services/aiModels/index.ts apps/api/src/__tests__/partner-wide-write-coverage.test.ts \
  apps/api/src/__tests__/integration/aiModelRegistryServices.integration.test.ts
git commit -m "feat(ai): offerings service with the spec §8 price rule and legacy-call lookup

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 9: `services/aiModels/assignments.ts` — the tighten-only merge and `getEffectiveAssignment` (exhaustive unit + integration)

**Files:**
- Create: `apps/api/src/services/aiModels/assignments.ts`
- Create: `apps/api/src/services/aiModels/assignments.test.ts`
- Modify: `apps/api/src/services/aiModels/index.ts` (append `export * from './assignments';`)
- Modify: `apps/api/src/__tests__/integration/aiModelRegistryServices.integration.test.ts` (append)

**Interfaces:**
- Consumes: `aiModelAssignments` (Task 4); `AI_SURFACE_ROLES`, `EFFORT_LEVELS`, `offeringOptionsSchema`, `type OfferingOptions`, `type AiSurface` (W01 shared).
- Produces:
  - `getEffectiveAssignment(input: { partnerId: string; orgId: string | null; surface: AiSurface; role?: string }): Promise<EffectiveAssignment>`. The index writes the return type without `Promise`; it reads the DB, so it is async.
  - `type EffectiveAssignment` (below)
  - Index additions:
    - `mergeEffectiveAssignment(input: { surface: AiSurface; role: string; partner: AssignmentRowInput | null; org: AssignmentRowInput | null }): EffectiveAssignment` (pure; W03's resolver step 1 and Task 11's projection call it)
    - `type PermittedSet = { kind: 'all' } | { kind: 'list'; offeringIds: readonly string[] }`
    - `isPermitted(set: PermittedSet, offeringId: string): boolean`
    - `clampOrgOptions(partner: OfferingOptions, org: OfferingOptions | null): { options: OfferingOptions; warnings: AssignmentMergeWarning[] }`
    - `type AssignmentRowInput`, `type AssignmentMergeWarning`

**The merge, fixed here (spec §5.4, quorum #11; `effectivePolicy.ts:212` semantics):**

| Field | Partner row (NULL means) | Org row (NULL means) | Effective |
|---|---|---|---|
| permitted | all enabled offerings | inherit | partner ∩ org (org order kept). Disjoint ⇒ an empty list |
| default | none | inherit | org default if it is in the effective permitted set; otherwise the partner default (with a warning if the org named one). The partner default applies even when an org narrowing excludes it (spec, literal) |
| allow_user_choice | true | inherit | partner ∧ org |
| options.effort | provider default | inherit | `min(org, partner)` by `EFFORT_LEVELS` order when both are set; the org value when only the org sets it; the partner value when only the partner sets it |
| options.speed | provider default (standard) | inherit | `fast` only when both say `fast` (or the org is silent and the partner says `fast`); an org `fast` the partner did not opt into is dropped |
| options.thinkingDisplay | provider default | inherit | org ?? partner (no cost or safety axis) |
| fallbacks | none | inherit | the org list if every id is in the PARTNER's permitted set; otherwise the partner list (warning) |
| fallback_may_cross_funding | false | inherit | partner ∧ org |
| role | — | — | a missing `(surface, role)` row at either level falls back to that level's `(surface, 'default')` row |

- [ ] **Step 1: Write the failing, exhaustive unit tests**

`apps/api/src/services/aiModels/assignments.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ db: {} }));

import { EFFORT_LEVELS, type OfferingOptions } from '@breeze/shared';
import {
  clampOrgOptions,
  isPermitted,
  mergeEffectiveAssignment,
  type AssignmentRowInput,
} from './assignments';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'aaaaaaaa-0000-4000-8000-000000000002';
const C = 'aaaaaaaa-0000-4000-8000-000000000003';

function row(over: Partial<AssignmentRowInput> = {}): AssignmentRowInput {
  return {
    id: over.id ?? 'row',
    role: over.role ?? 'default',
    defaultOfferingId: over.defaultOfferingId ?? null,
    permittedOfferingIds: over.permittedOfferingIds ?? null,
    allowUserChoice: over.allowUserChoice ?? null,
    options: over.options ?? null,
    fallbackOfferingIds: over.fallbackOfferingIds ?? null,
    fallbackMayCrossFunding: over.fallbackMayCrossFunding ?? null,
  };
}
const merge = (partner: AssignmentRowInput | null, org: AssignmentRowInput | null) =>
  mergeEffectiveAssignment({ surface: 'chat', role: 'default', partner, org });

describe('permitted set: partner ∩ org, org can only narrow', () => {
  it.each([
    ['partner all, org inherit', null, null, { kind: 'all' }],
    ['partner all, org list', null, [B, A], { kind: 'list', offeringIds: [B, A] }],
    ['partner list, org inherit', [A, B], null, { kind: 'list', offeringIds: [A, B] }],
    ['partner list, org narrower', [A, B], [B], { kind: 'list', offeringIds: [B] }],
    ['partner list, org tries to widen', [A], [A, C], { kind: 'list', offeringIds: [A] }],
    ['disjoint ⇒ empty', [A], [C], { kind: 'list', offeringIds: [] }],
  ] as const)('%s', (_l, partnerIds, orgIds, expected) => {
    const eff = merge(row({ permittedOfferingIds: partnerIds as string[] | null }), orgIds === null ? row() : row({ permittedOfferingIds: orgIds as string[] }));
    expect(eff.permitted).toEqual(expected);
  });

  it('isPermitted honours both shapes', () => {
    expect(isPermitted({ kind: 'all' }, A)).toBe(true);
    expect(isPermitted({ kind: 'list', offeringIds: [A] }, A)).toBe(true);
    expect(isPermitted({ kind: 'list', offeringIds: [A] }, B)).toBe(false);
    expect(isPermitted({ kind: 'list', offeringIds: [] }, A)).toBe(false);
  });
});

describe('default: the org default only inside the effective permitted set', () => {
  it.each([
    ['org default permitted', { defaultOfferingId: A }, { defaultOfferingId: B }, B, 'org', []],
    ['org default outside partner permitted', { defaultOfferingId: A, permittedOfferingIds: [A] }, { defaultOfferingId: B }, A, 'partner', ['org_default_not_permitted']],
    ['org default outside its own narrowing', { defaultOfferingId: A }, { defaultOfferingId: B, permittedOfferingIds: [C] }, A, 'partner', ['org_default_not_permitted']],
    ['org silent', { defaultOfferingId: A }, {}, A, 'partner', []],
    ['nobody sets one', {}, {}, null, 'none', []],
    ['partner default survives an org narrowing that excludes it (spec, literal)', { defaultOfferingId: A }, { permittedOfferingIds: [B] }, A, 'partner', []],
  ] as const)('%s', (_l, partner, org, expectedDefault, source, warnings) => {
    const eff = merge(row(partner as Partial<AssignmentRowInput>), row(org as Partial<AssignmentRowInput>));
    expect(eff.defaultOfferingId).toBe(expectedDefault);
    expect(eff.defaultSource).toBe(source);
    expect(eff.warnings).toEqual(warnings);
  });
});

describe('allow_user_choice = partner ∧ org (NULL partner = true, NULL org = inherit)', () => {
  const values = [true, false, null] as const;
  it.each(values.flatMap((p) => values.map((o) => [p, o] as const)))('partner %s, org %s', (p, o) => {
    const eff = merge(row({ allowUserChoice: p }), row({ allowUserChoice: o }));
    expect(eff.allowUserChoice).toBe((p ?? true) && (o ?? true));
  });
});

describe('options clamp: an org can only lower cost', () => {
  const levels = [undefined, ...EFFORT_LEVELS] as const;
  it.each(levels.flatMap((p) => levels.map((o) => [p, o] as const)))('effort partner=%s org=%s', (p, o) => {
    const { options, warnings } = clampOrgOptions(p ? { effort: p } : {}, o ? { effort: o } : null);
    const idx = (e: string) => EFFORT_LEVELS.indexOf(e as (typeof EFFORT_LEVELS)[number]);
    const expected = o === undefined ? p : p === undefined ? o : (idx(o) <= idx(p) ? o : p);
    expect(options.effort).toBe(expected);
    expect(warnings.includes('org_effort_clamped')).toBe(!!(o && p && idx(o) > idx(p)));
  });

  const speeds = [undefined, 'standard', 'fast'] as const;
  it.each(speeds.flatMap((p) => speeds.map((o) => [p, o] as const)))('speed partner=%s org=%s', (p, o) => {
    const { options, warnings } = clampOrgOptions(p ? { speed: p } : {}, o ? { speed: o } : null);
    const expected = o === undefined ? p : o === 'fast' ? (p === 'fast' ? 'fast' : (p ?? undefined)) : 'standard';
    expect(options.speed).toBe(expected);
    expect(warnings.includes('org_speed_clamped')).toBe(o === 'fast' && p !== 'fast');
  });

  it('thinkingDisplay: org ?? partner', () => {
    expect(clampOrgOptions({ thinkingDisplay: 'summarized' }, { thinkingDisplay: 'updates' }).options.thinkingDisplay).toBe('updates');
    expect(clampOrgOptions({ thinkingDisplay: 'summarized' }, {}).options.thinkingDisplay).toBe('summarized');
    expect(clampOrgOptions({}, null).options).toEqual({});
  });

  it('an invalid stored options object is ignored with a warning, never thrown', () => {
    const eff = merge(row({ options: { effort: 'ludicrous' } as unknown as Record<string, unknown> }), row({ options: { speed: 'warp' } as unknown as Record<string, unknown> }));
    expect(eff.options).toEqual({});
    expect(eff.warnings).toEqual(expect.arrayContaining(['invalid_partner_options', 'invalid_org_options']));
  });
});

describe('fallbacks: the org list only when it is a subset of the PARTNER permitted set', () => {
  it.each([
    ['org subset of partner list', { permittedOfferingIds: [A, B], fallbackOfferingIds: [A] }, { fallbackOfferingIds: [B, A] }, [B, A], []],
    ['org outside partner list', { permittedOfferingIds: [A], fallbackOfferingIds: [A] }, { fallbackOfferingIds: [C] }, [A], ['org_fallbacks_not_permitted']],
    ['partner permits all', { fallbackOfferingIds: [A] }, { fallbackOfferingIds: [C] }, [C], []],
    ['org inherits', { fallbackOfferingIds: [A] }, {}, [A], []],
    ['nobody sets any', {}, {}, [], []],
  ] as const)('%s', (_l, partner, org, expected, warnings) => {
    const eff = merge(row(partner as Partial<AssignmentRowInput>), row(org as Partial<AssignmentRowInput>));
    expect(eff.fallbackOfferingIds).toEqual(expected);
    expect(eff.warnings).toEqual(warnings);
  });

  const flags = [true, false, null] as const;
  it.each(flags.flatMap((p) => flags.map((o) => [p, o] as const)))('cross-funding partner %s org %s', (p, o) => {
    const eff = merge(row({ fallbackMayCrossFunding: p }), row({ fallbackMayCrossFunding: o }));
    expect(eff.fallbackMayCrossFunding).toBe((p ?? false) && (o ?? true));
  });
});

describe('missing rows', () => {
  it('no partner row: permissive partner, org choices stand inside it', () => {
    const eff = merge(null, row({ defaultOfferingId: A, permittedOfferingIds: [A] }));
    expect(eff).toMatchObject({ defaultOfferingId: A, defaultSource: 'org', permitted: { kind: 'list', offeringIds: [A] }, allowUserChoice: true });
  });
  it('no rows at all: nothing chosen, everything enabled permitted', () => {
    expect(merge(null, null)).toMatchObject({ defaultOfferingId: null, defaultSource: 'none', permitted: { kind: 'all' }, allowUserChoice: true, fallbackOfferingIds: [], fallbackMayCrossFunding: false, options: {} });
  });
});

describe('tighten-only property: no org row can widen any partner choice', () => {
  const ids = [[A], [A, B], null] as const;
  const choice = [true, false, null] as const;
  const efforts = [undefined, 'low', 'max'] as const;
  const cases = ids.flatMap((pp) => ids.flatMap((op) => choice.flatMap((pc) => choice.flatMap((oc) => efforts.flatMap((pe) => efforts.map((oe) => [pp, op, pc, oc, pe, oe] as const))))));
  it.each(cases)('partner %j / org %j / choice %s,%s / effort %s,%s', (pp, op, pc, oc, pe, oe) => {
    const partner = row({ permittedOfferingIds: pp as string[] | null, allowUserChoice: pc, options: pe ? { effort: pe } : null, defaultOfferingId: A });
    const org = row({ permittedOfferingIds: op as string[] | null, allowUserChoice: oc, options: oe ? { effort: oe } : null, defaultOfferingId: B });
    const eff = merge(partner, org);
    if (pp !== null && eff.permitted.kind === 'list') for (const id of eff.permitted.offeringIds) expect(pp).toContain(id);
    if (pp !== null) expect(eff.permitted.kind).toBe('list');
    if ((pc ?? true) === false) expect(eff.allowUserChoice).toBe(false);
    if (pe && eff.options.effort) expect(EFFORT_LEVELS.indexOf(eff.options.effort)).toBeLessThanOrEqual(EFFORT_LEVELS.indexOf(pe));
    if (eff.defaultSource === 'org') expect(isPermitted(eff.permitted, eff.defaultOfferingId!)).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/assignments.test.ts`
Expected: FAIL, because `./assignments` does not resolve.

- [ ] **Step 3: Implement**

`apps/api/src/services/aiModels/assignments.ts`:

```ts
/**
 * Effective model assignment for one (surface, role): the partner-wide row
 * with the org override applied TIGHTEN-ONLY (spec §5.4, quorum #11). The
 * merge is pure and total: an invalid stored options object is ignored with a
 * warning, never thrown, so a bad row can't take a surface down.
 */
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  AI_SURFACE_ROLES,
  EFFORT_LEVELS,
  offeringOptionsSchema,
  type AiSurface,
  type OfferingOptions,
} from '@breeze/shared';
import { db } from '../../db';
import { aiModelAssignments, type AiModelAssignmentRow } from '../../db/schema';

export type AssignmentRowInput = Pick<
  AiModelAssignmentRow,
  'id' | 'role' | 'defaultOfferingId' | 'permittedOfferingIds' | 'allowUserChoice' | 'options' | 'fallbackOfferingIds' | 'fallbackMayCrossFunding'
>;

export type PermittedSet = { kind: 'all' } | { kind: 'list'; offeringIds: readonly string[] };

export type AssignmentMergeWarning =
  | 'org_default_not_permitted'
  | 'org_fallbacks_not_permitted'
  | 'org_effort_clamped'
  | 'org_speed_clamped'
  | 'invalid_partner_options'
  | 'invalid_org_options';

export interface EffectiveAssignment {
  surface: AiSurface;
  role: string;
  defaultOfferingId: string | null;
  defaultSource: 'org' | 'partner' | 'none';
  permitted: PermittedSet;
  allowUserChoice: boolean;
  options: OfferingOptions;
  fallbackOfferingIds: readonly string[];
  fallbackMayCrossFunding: boolean;
  sources: { partnerRowId: string | null; partnerRole: string | null; orgRowId: string | null; orgRole: string | null };
  warnings: readonly AssignmentMergeWarning[];
}

export function isPermitted(set: PermittedSet, offeringId: string): boolean {
  return set.kind === 'all' || set.offeringIds.includes(offeringId);
}

function toSet(ids: readonly string[] | null | undefined): PermittedSet | null {
  return ids === null || ids === undefined ? null : { kind: 'list', offeringIds: [...ids] };
}

function intersect(partner: PermittedSet, org: PermittedSet | null): PermittedSet {
  if (org === null || org.kind === 'all') return partner;
  if (partner.kind === 'all') return org;
  return { kind: 'list', offeringIds: org.offeringIds.filter((id) => partner.offeringIds.includes(id)) };
}

function parseOptions(raw: unknown): OfferingOptions | null {
  if (raw === null || raw === undefined) return {};
  const parsed = offeringOptionsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const effortIndex = (e: string) => EFFORT_LEVELS.indexOf(e as (typeof EFFORT_LEVELS)[number]);

export function clampOrgOptions(
  partner: OfferingOptions,
  org: OfferingOptions | null,
): { options: OfferingOptions; warnings: AssignmentMergeWarning[] } {
  const warnings: AssignmentMergeWarning[] = [];
  const out: OfferingOptions = {};
  const o = org ?? {};

  const effort = o.effort === undefined
    ? partner.effort
    : partner.effort === undefined
      ? o.effort
      : effortIndex(o.effort) <= effortIndex(partner.effort) ? o.effort : (warnings.push('org_effort_clamped'), partner.effort);
  if (effort !== undefined) out.effort = effort;

  let speed = partner.speed;
  if (o.speed === 'standard') speed = 'standard';
  else if (o.speed === 'fast') {
    if (partner.speed !== 'fast') warnings.push('org_speed_clamped');
    // speed stays the partner's choice (undefined = provider default)
  }
  if (speed !== undefined) out.speed = speed;

  const thinkingDisplay = o.thinkingDisplay ?? partner.thinkingDisplay;
  if (thinkingDisplay !== undefined) out.thinkingDisplay = thinkingDisplay;

  return { options: out, warnings };
}

export function mergeEffectiveAssignment(input: {
  surface: AiSurface;
  role: string;
  partner: AssignmentRowInput | null;
  org: AssignmentRowInput | null;
}): EffectiveAssignment {
  const { partner, org } = input;
  const warnings: AssignmentMergeWarning[] = [];

  const partnerSet: PermittedSet = toSet(partner?.permittedOfferingIds) ?? { kind: 'all' };
  const permitted = intersect(partnerSet, toSet(org?.permittedOfferingIds));

  let defaultOfferingId: string | null = partner?.defaultOfferingId ?? null;
  let defaultSource: EffectiveAssignment['defaultSource'] = defaultOfferingId ? 'partner' : 'none';
  if (org?.defaultOfferingId) {
    if (isPermitted(permitted, org.defaultOfferingId)) {
      defaultOfferingId = org.defaultOfferingId;
      defaultSource = 'org';
    } else {
      warnings.push('org_default_not_permitted');
    }
  }

  const partnerOptions = parseOptions(partner?.options);
  if (partnerOptions === null) warnings.push('invalid_partner_options');
  const orgOptions = org ? parseOptions(org.options) : {};
  if (orgOptions === null) warnings.push('invalid_org_options');
  const clamped = clampOrgOptions(partnerOptions ?? {}, org && org.options !== null ? orgOptions ?? {} : null);
  warnings.push(...clamped.warnings);

  const partnerFallbacks = partner?.fallbackOfferingIds ?? [];
  let fallbackOfferingIds: readonly string[] = partnerFallbacks;
  if (org?.fallbackOfferingIds) {
    if (org.fallbackOfferingIds.every((id) => isPermitted(partnerSet, id))) fallbackOfferingIds = [...org.fallbackOfferingIds];
    else warnings.push('org_fallbacks_not_permitted');
  }

  return {
    surface: input.surface,
    role: input.role,
    defaultOfferingId,
    defaultSource,
    permitted,
    allowUserChoice: (partner?.allowUserChoice ?? true) && (org?.allowUserChoice ?? true),
    options: clamped.options,
    fallbackOfferingIds,
    fallbackMayCrossFunding: (partner?.fallbackMayCrossFunding ?? false) && (org?.fallbackMayCrossFunding ?? true),
    sources: {
      partnerRowId: partner?.id ?? null,
      partnerRole: partner?.role ?? null,
      orgRowId: org?.id ?? null,
      orgRole: org?.role ?? null,
    },
    warnings,
  };
}

function pickForRole<T extends { role: string }>(rows: T[], role: string): T | null {
  return rows.find((r) => r.role === role) ?? rows.find((r) => r.role === 'default') ?? null;
}

export async function getEffectiveAssignment(input: {
  partnerId: string;
  orgId: string | null;
  surface: AiSurface;
  role?: string;
}): Promise<EffectiveAssignment> {
  const role = input.role ?? 'default';
  if (!AI_SURFACE_ROLES[input.surface].includes(role)) {
    throw new Error(`Role "${role}" is not defined for surface "${input.surface}".`);
  }
  const owner = input.orgId
    ? or(
        and(isNull(aiModelAssignments.orgId), eq(aiModelAssignments.partnerId, input.partnerId)),
        and(eq(aiModelAssignments.orgId, input.orgId), eq(aiModelAssignments.offeringPartnerId, input.partnerId)),
      )
    : and(isNull(aiModelAssignments.orgId), eq(aiModelAssignments.partnerId, input.partnerId));
  const rows = await db
    .select()
    .from(aiModelAssignments)
    .where(and(
      eq(aiModelAssignments.surface, input.surface),
      inArray(aiModelAssignments.role, role === 'default' ? ['default'] : [role, 'default']),
      owner,
    ));
  return mergeEffectiveAssignment({
    surface: input.surface,
    role,
    partner: pickForRole(rows.filter((r) => r.orgId === null), role),
    org: pickForRole(rows.filter((r) => r.orgId !== null), role),
  });
}
```

One semantic the tests pin: an org row whose `options` column is NULL inherits the partner's options untouched. `clampOrgOptions(partner, null)` returns the partner options with no warnings.

Append `export * from './assignments';` to the aiModels `index.ts`.

- [ ] **Step 4: Append the real-Postgres loader checks**

Append to `aiModelRegistryServices.integration.test.ts` (import `getEffectiveAssignment`):

```ts
describe.skipIf(!RUN)('getEffectiveAssignment (#7600 W02)', () => {
  it('merges the partner row with the org override under an org token, and falls back to the default role', async () => {
    const p = await createPartner();
    const org = await createOrganization({ partnerId: p.id });
    const [a, b] = [
      await seedOffering({ partnerId: p.id, platformModelId: await seedPlatformModel() }),
      await seedOffering({ partnerId: p.id, platformModelId: await seedPlatformModel() }),
    ];
    await fixtureSql`INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, default_offering_id, allow_user_choice)
                     VALUES (${p.id}, ${p.id}, 'ai_agents', ${a}, true)`;
    await fixtureSql`INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, default_offering_id, permitted_offering_ids, allow_user_choice)
                     VALUES (${org.id}, ${p.id}, 'ai_agents', ${b}, ARRAY[${b}]::uuid[], false)`;
    const eff = await withDbAccessContext(orgContext(org.id, p.id), () =>
      getEffectiveAssignment({ partnerId: p.id, orgId: org.id, surface: 'ai_agents', role: 'triage' }));
    expect(eff).toMatchObject({ defaultOfferingId: b, defaultSource: 'org', allowUserChoice: false, permitted: { kind: 'list', offeringIds: [b] } });
    expect(eff.sources.partnerRole).toBe('default');
  });

  it('another org\'s override is ignored even in system scope', async () => {
    const p = await createPartner();
    const [orgA, orgB] = [await createOrganization({ partnerId: p.id }), await createOrganization({ partnerId: p.id })];
    const off = await seedOffering({ partnerId: p.id, platformModelId: await seedPlatformModel() });
    await fixtureSql`INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, default_offering_id)
                     VALUES (${orgB.id}, ${p.id}, 'chat', ${off})`;
    const eff = await withSystemDbAccessContext(() => getEffectiveAssignment({ partnerId: p.id, orgId: orgA.id, surface: 'chat' }));
    expect(eff.defaultSource).toBe('none');
  });
});
```

(Add `withSystemDbAccessContext` to the `../../db` import.)

- [ ] **Step 5: Run unit + integration + typecheck**

```bash
cd apps/api && npx vitest run src/services/aiModels/assignments.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelRegistryServices.integration.test.ts
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

Expected: PASS. The tighten-only property block expands to 3·3·3·3·3·3 = 729 cases.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/aiModels/assignments.ts apps/api/src/services/aiModels/assignments.test.ts \
  apps/api/src/services/aiModels/index.ts apps/api/src/__tests__/integration/aiModelRegistryServices.integration.test.ts
git commit -m "feat(ai): tighten-only effective model assignment merge with exhaustive tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 10: `legacyProjection.ts` — the pure legacy → registry projection (spec §10; unit)

This is the single definition of "what the registry must say so every surface keeps today's destination, funding source and model". The reconcile (Task 12) applies it, and the parity harness (Task 11) checks it against the real legacy code.

**SQL in migrations vs this TS projection.** The split is deliberate:
- **SQL (Task 2 migration):** only the id-preserving connection copy. It is env-independent. It must be atomic with the table's creation, so no instant exists where a legacy row has no connection and `GET /ai/provider` (which reads the registry) would report "not configured". It keeps ciphertext inside Postgres.
- **TS (this projection + Task 12):** everything else. Three facts make SQL the wrong home:
  1. Surface models depend on runtime values that SQL can't see: `resolveDefaultModel()` / `ANTHROPIC_MODEL`, `AI_SCRIPT_REVIEWER_MODEL` (evaluated at module load), `WORKSPACE_CONTENT_LLM_MODEL`.
  2. The rules must have ONE implementation shared with the parity harness. A SQL copy would be a second, untested oracle.
  3. Legacy rates (`MODEL_PRICING`) and catalog semantics live in TS.

  The env only changes at a restart, so a reconcile at every boot keeps "tracks the deployment default" partners exact.

**Files:**
- Create: `apps/api/src/services/aiModels/legacyProjection.ts`
- Create: `apps/api/src/services/aiModels/legacyProjection.test.ts`

**Interfaces:**
- Consumes: `AI_SURFACES`, `ModelRates` (shared); `legacyOfficeChatModel`, `legacyReviewerModel`, `legacyAgentModel` (Task 1); `aiBudgets` Drizzle column default.
- Produces (all index additions):
  - `type LegacySnapshot`, `type LegacyPartnerConfig`, `type LegacyPlatformModel`, `type LegacyAgentRow`, `type LegacySession` (below)
  - `type LegacyProjectionEnv = { defaultModel: string; reviewerModel: string; extensionModel: string; legacyRates: (model: string) => ModelRates }`
  - `type OfferingKey = string` (`platform:<modelId>` | `conn:<connectionId>:<modelId>`)
  - `type DesiredOffering`, `type DesiredAssignment`, `type DesiredRegistryState`
  - `buildDesiredRegistryState(snapshot: LegacySnapshot, env: LegacyProjectionEnv): DesiredRegistryState`
  - `legacyBudgetAllowlist(raw: unknown): string[] | null` (mirrors `effectivePolicy.ts:523`)
  - `LEGACY_BUDGET_ALLOWED_MODELS_DEFAULT: readonly string[]` (read from the `aiBudgets.allowedModels` column default; not a literal)

**Projection rules** (P = the partner default: `config ? config.defaultModel ?? env.defaultModel : env.defaultModel`; "the partner destination" = the compat connection when a legacy config exists, even an errored one, else the platform):

| Surface | Partner row default | Destination | `allow_user_choice` |
|---|---|---|---|
| chat, helper, script_builder, office_chat, office_ticket, ai_agents, catalog_enrichment | P | partner | `true` for chat (legacy accepts a client model), `false` otherwise |
| script_reviewer | `legacyReviewerModel(partnerReviewerModel, env.reviewerModel)` | partner | false |
| extension_content | `env.extensionModel` | partner | false |
| patch_test | `env.defaultModel` | **platform always** (legacy `new Anthropic()` bypasses BYOK) | false |

Org rows, only where legacy has an org-level effect:
- `script_reviewer`, when the org's `reviewer_model` is non-null: default = that model on the partner destination.
- `office_chat`, when the org's `allowed_models` is non-empty: default = `allowedModels[0]`, permitted = the de-duplicated list.
- `ai_agents`, when the org's budget `allowed_models` is an array AND differs from the column default (an explicit customization). Permitted = allowlist ∪ E_org, where E_org = every model the org's agent runs resolve to today plus P. This keeps every running model permitted, so W03's run-time policy check (spec §5.6) holds. An org still on the column default gets no org row: there the allowlist only rejected org overrides, and an org row would silently narrow every future partner model change.

Offerings: one per (destination, model).
- Platform: the platform row when it exists. Otherwise `needsBootstrapPlatformRow` (Task 12 inserts an unpriced, non-offered row). Platform offerings are never priced (CHECK).
- BYOK: `discovered`, linked to the platform row when one exists. Priced at `env.legacyRates(model)` unless the linked row is priced. An unknown id becomes `manual` at legacy rates.
- Catalog: `catalog` with no price (live from the revision).

Agents and sessions:
- Partner agent rows bind `model`'s offering (NULL `model` → no binding = follow the assignment).
- Org agent rows bind only when the legacy merge admits them (`model ∈ budget allowlist`).
- Live sessions bind `model` on the partner's CURRENT destination. Legacy re-resolves the config each turn, and helper sessions never set `billing_source`.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/aiModels/legacyProjection.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ db: {} }));

import type { ModelRates } from '@breeze/shared';
import {
  buildDesiredRegistryState,
  LEGACY_BUDGET_ALLOWED_MODELS_DEFAULT,
  legacyBudgetAllowlist,
  type LegacyProjectionEnv,
  type LegacySnapshot,
} from './legacyProjection';

const P = '10000000-0000-4000-8000-000000000001';
const CONN = '20000000-0000-4000-8000-000000000001';
const ORG_A = '30000000-0000-4000-8000-00000000000a';
const ORG_B = '30000000-0000-4000-8000-00000000000b';
const RATES: ModelRates = { inputCentsPerM: 500, outputCentsPerM: 2500, cacheReadCentsPerM: 50, cacheWriteCentsPerM: 625 };

const env: LegacyProjectionEnv = {
  defaultModel: 'claude-sonnet-5-5',
  reviewerModel: 'claude-sonnet-5-5',
  extensionModel: 'claude-haiku-4-5',
  legacyRates: () => RATES,
};

const platformModels = [
  { id: 'pm-sonnet55', modelId: 'claude-sonnet-5-5', priced: true },
  { id: 'pm-opus55', modelId: 'claude-opus-5-5', priced: true },
  { id: 'pm-haiku45', modelId: 'claude-haiku-4-5', priced: true },
  { id: 'pm-legacy', modelId: 'claude-sonnet-4-5-20250929', priced: false },
];

function snapshot(over: Partial<LegacySnapshot> = {}): LegacySnapshot {
  return {
    partnerId: P, orgIds: [ORG_A, ORG_B], config: null, platformModels,
    partnerReviewerModel: null, orgReviewerModels: {}, officeAllowedModels: {},
    agents: [], budgetAllowedModels: {}, liveSessions: [], ...over,
  };
}
const partnerRow = (state: ReturnType<typeof buildDesiredRegistryState>, surface: string) =>
  state.assignments.find((a) => a.orgId === null && a.surface === surface)!;
const offering = (state: ReturnType<typeof buildDesiredRegistryState>, key: string) =>
  state.offerings.find((o) => o.key === key)!;

describe('buildDesiredRegistryState (#7600 W02, spec §10)', () => {
  it('no config: every surface on the platform, patch_test included; extension and reviewer keep their own models', () => {
    const s = buildDesiredRegistryState(snapshot(), env);
    expect(s.connectionId).toBeNull();
    expect(s.assignments.filter((a) => a.orgId === null).map((a) => [a.surface, a.defaultOfferingKey])).toEqual([
      ['chat', 'platform:claude-sonnet-5-5'], ['helper', 'platform:claude-sonnet-5-5'],
      ['script_builder', 'platform:claude-sonnet-5-5'], ['script_reviewer', 'platform:claude-sonnet-5-5'],
      ['office_chat', 'platform:claude-sonnet-5-5'], ['office_ticket', 'platform:claude-sonnet-5-5'],
      ['ai_agents', 'platform:claude-sonnet-5-5'], ['catalog_enrichment', 'platform:claude-sonnet-5-5'],
      ['extension_content', 'platform:claude-haiku-4-5'], ['patch_test', 'platform:claude-sonnet-5-5'],
    ]);
    expect(partnerRow(s, 'chat').allowUserChoice).toBe(true);
    expect(partnerRow(s, 'helper').allowUserChoice).toBe(false);
    expect(offering(s, 'platform:claude-sonnet-5-5')).toMatchObject({ connectionId: null, source: 'platform', platformModelId: 'pm-sonnet55', needsBootstrapPlatformRow: false, price: null });
  });

  it('BYOK pinned: partner-destination surfaces move to the connection; patch_test stays on the platform', () => {
    const s = buildDesiredRegistryState(snapshot({ config: { id: CONN, status: 'active', defaultModel: 'claude-opus-5-5', catalogEntryId: null } }), env);
    expect(s.connectionId).toBe(CONN);
    expect(partnerRow(s, 'chat').defaultOfferingKey).toBe(`conn:${CONN}:claude-opus-5-5`);
    expect(partnerRow(s, 'extension_content').defaultOfferingKey).toBe(`conn:${CONN}:claude-haiku-4-5`);
    expect(partnerRow(s, 'patch_test').defaultOfferingKey).toBe('platform:claude-sonnet-5-5');
    expect(offering(s, `conn:${CONN}:claude-opus-5-5`)).toMatchObject({ source: 'discovered', platformModelId: 'pm-opus55', price: null });
  });

  it('BYOK tracking the deployment default resolves P from env at projection time', () => {
    const s = buildDesiredRegistryState(snapshot({ config: { id: CONN, status: 'active', defaultModel: null, catalogEntryId: null } }), { ...env, defaultModel: 'claude-opus-5-5' });
    expect(partnerRow(s, 'chat').defaultOfferingKey).toBe(`conn:${CONN}:claude-opus-5-5`);
  });

  it('an errored config keeps every partner-destination surface on its connection (never re-pointed to the platform)', () => {
    const s = buildDesiredRegistryState(snapshot({ config: { id: CONN, status: 'error', defaultModel: null, catalogEntryId: null } }), env);
    for (const a of s.assignments.filter((x) => x.orgId === null && x.surface !== 'patch_test')) {
      expect(a.defaultOfferingKey).toMatch(new RegExp(`^conn:${CONN}:`));
    }
  });

  it('catalog: catalog offerings carry no price and no platform link', () => {
    const s = buildDesiredRegistryState(snapshot({ config: { id: CONN, status: 'active', defaultModel: 'claude-sonnet-4-6', catalogEntryId: 'entry-1' } }), env);
    expect(offering(s, `conn:${CONN}:claude-sonnet-4-6`)).toMatchObject({ source: 'catalog', platformModelId: null, price: null });
  });

  it('unknown ids stay on their destination: manual at legacy rates on a key, bootstrap row on the platform', () => {
    const byok = buildDesiredRegistryState(snapshot({ config: { id: CONN, status: 'active', defaultModel: 'my-gateway-model', catalogEntryId: null } }), env);
    expect(offering(byok, `conn:${CONN}:my-gateway-model`)).toMatchObject({ source: 'manual', platformModelId: null, price: RATES });
    const platform = buildDesiredRegistryState(snapshot(), { ...env, defaultModel: 'my-gateway-model' });
    expect(offering(platform, 'platform:my-gateway-model')).toMatchObject({ source: 'platform', platformModelId: null, needsBootstrapPlatformRow: true, price: null });
  });

  it('a BYOK offering linked to an UNPRICED platform row is priced at the legacy rate (never left unpriced)', () => {
    const s = buildDesiredRegistryState(snapshot({ config: { id: CONN, status: 'active', defaultModel: 'claude-sonnet-4-5-20250929', catalogEntryId: null } }), env);
    expect(offering(s, `conn:${CONN}:claude-sonnet-4-5-20250929`)).toMatchObject({ source: 'discovered', platformModelId: 'pm-legacy', price: RATES });
  });

  it('script reviewer: partner reviewer_model, org override row, env default otherwise', () => {
    const s = buildDesiredRegistryState(snapshot({ partnerReviewerModel: 'claude-opus-5-5', orgReviewerModels: { [ORG_A]: 'claude-haiku-4-5', [ORG_B]: null } }), env);
    expect(partnerRow(s, 'script_reviewer').defaultOfferingKey).toBe('platform:claude-opus-5-5');
    const orgRows = s.assignments.filter((a) => a.surface === 'script_reviewer' && a.orgId !== null);
    expect(orgRows).toEqual([expect.objectContaining({ orgId: ORG_A, defaultOfferingKey: 'platform:claude-haiku-4-5', permittedOfferingKeys: null })]);
    const none = buildDesiredRegistryState(snapshot(), { ...env, reviewerModel: 'claude-haiku-4-5' });
    expect(partnerRow(none, 'script_reviewer').defaultOfferingKey).toBe('platform:claude-haiku-4-5');
  });

  it('office allowedModels → office_chat org row (first = default, list = permitted, de-duplicated); [] → no row', () => {
    const s = buildDesiredRegistryState(snapshot({ officeAllowedModels: { [ORG_A]: ['claude-haiku-4-5', 'claude-opus-5-5', 'claude-haiku-4-5'], [ORG_B]: [] } }), env);
    const rows = s.assignments.filter((a) => a.surface === 'office_chat' && a.orgId !== null);
    expect(rows).toEqual([expect.objectContaining({
      orgId: ORG_A,
      defaultOfferingKey: 'platform:claude-haiku-4-5',
      permittedOfferingKeys: ['platform:claude-haiku-4-5', 'platform:claude-opus-5-5'],
    })]);
  });

  describe('AI agents + ai_budgets.allowed_models', () => {
    const agents = [
      { id: 'agent-partner-triage', kind: 'triage', orgId: null, model: 'claude-opus-5-5' },
      { id: 'agent-partner-patch', kind: 'patch', orgId: null, model: null },
      { id: 'agent-orgA-triage', kind: 'triage', orgId: ORG_A, model: 'claude-haiku-4-5' },
      { id: 'agent-orgB-triage', kind: 'triage', orgId: ORG_B, model: 'claude-haiku-4-5' },
    ];

    it('binds partner rows; binds an org override only when the legacy merge admits it', () => {
      const s = buildDesiredRegistryState(snapshot({
        agents,
        budgetAllowedModels: { [ORG_A]: ['claude-haiku-4-5'], [ORG_B]: [...LEGACY_BUDGET_ALLOWED_MODELS_DEFAULT] },
      }), env);
      expect(s.agentOfferingKeys).toEqual({
        'agent-partner-triage': 'platform:claude-opus-5-5',
        'agent-partner-patch': null,
        'agent-orgA-triage': 'platform:claude-haiku-4-5',
        'agent-orgB-triage': null,
      });
    });

    it('a customized allowlist becomes an org ai_agents row permitting allowlist ∪ every model the org runs today', () => {
      const s = buildDesiredRegistryState(snapshot({ agents, budgetAllowedModels: { [ORG_A]: ['claude-haiku-4-5', 'claude-sonnet-4-5-20250929'] } }), env);
      const row = s.assignments.find((a) => a.surface === 'ai_agents' && a.orgId === ORG_A)!;
      expect(row.defaultOfferingKey).toBeNull();
      expect([...row.permittedOfferingKeys!].sort()).toEqual([
        'platform:claude-haiku-4-5',            // allowlist + admitted org override (triage)
        'platform:claude-sonnet-4-5-20250929',  // allowlist
        'platform:claude-sonnet-5-5',           // P: the patch agent (model NULL) and the surface default
      ].sort());
    });

    it('an org still on the column-default allowlist gets NO narrowing org row', () => {
      const s = buildDesiredRegistryState(snapshot({ agents, budgetAllowedModels: { [ORG_B]: [...LEGACY_BUDGET_ALLOWED_MODELS_DEFAULT] } }), env);
      expect(s.assignments.find((a) => a.surface === 'ai_agents' && a.orgId === ORG_B)).toBeUndefined();
    });

    it('legacyBudgetAllowlist mirrors effectivePolicy: arrays pass, anything else is null', () => {
      expect(legacyBudgetAllowlist(['a'])).toEqual(['a']);
      expect(legacyBudgetAllowlist(null)).toBeNull();
      expect(legacyBudgetAllowlist({ a: 1 })).toBeNull();
      expect(legacyBudgetAllowlist('a')).toBeNull();
    });
  });

  it('live sessions bind on the partner\'s CURRENT destination', () => {
    const s = buildDesiredRegistryState(snapshot({
      config: { id: CONN, status: 'active', defaultModel: null, catalogEntryId: null },
      liveSessions: [{ id: 'sess-1', orgId: ORG_A, model: 'claude-opus-5-5' }],
    }), env);
    expect(s.sessionOfferingKeys).toEqual({ 'sess-1': `conn:${CONN}:claude-opus-5-5` });
  });

  it('is deterministic and de-duplicates offerings', () => {
    const input = snapshot({ officeAllowedModels: { [ORG_A]: ['claude-sonnet-5-5'] }, liveSessions: [{ id: 's', orgId: ORG_A, model: 'claude-sonnet-5-5' }] });
    const a = buildDesiredRegistryState(input, env);
    expect(buildDesiredRegistryState(input, env)).toEqual(a);
    expect(new Set(a.offerings.map((o) => o.key)).size).toBe(a.offerings.length);
  });

  it('reads the budget column default from the schema, not a literal', () => {
    expect(LEGACY_BUDGET_ALLOWED_MODELS_DEFAULT).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/legacyProjection.test.ts`
Expected: FAIL, because `./legacyProjection` does not resolve.

- [ ] **Step 3: Implement**

`apps/api/src/services/aiModels/legacyProjection.ts`:

```ts
/**
 * The W02 projection: legacy config + env → the registry state that makes
 * every AI surface keep today's destination, funding source and model
 * (spec §10, quorum #3). Pure. Applied by legacyReconcile.ts; checked against
 * the REAL legacy code by parity/parity.test.ts. Deleted in W08 with the
 * legacy tables.
 */
import { AI_SURFACES, type AiSurface, type ModelRates } from '@breeze/shared';
import { aiBudgets } from '../../db/schema/ai';
import { legacyAgentModel, legacyOfficeChatModel, legacyReviewerModel } from './legacySurfaceModels';

export interface LegacyPartnerConfig {
  id: string;
  status: 'active' | 'error';
  defaultModel: string | null;
  catalogEntryId: string | null;
}
export interface LegacyPlatformModel { id: string; modelId: string; priced: boolean }
export interface LegacyAgentRow { id: string; kind: string; orgId: string | null; model: string | null }
export interface LegacySession { id: string; orgId: string; model: string }

export interface LegacySnapshot {
  partnerId: string;
  orgIds: readonly string[];
  config: LegacyPartnerConfig | null;
  platformModels: readonly LegacyPlatformModel[];
  partnerReviewerModel: string | null;
  orgReviewerModels: Readonly<Record<string, string | null>>;
  officeAllowedModels: Readonly<Record<string, readonly string[]>>;
  /** Live rows only (disabled_at IS NULL). */
  agents: readonly LegacyAgentRow[];
  /** Raw ai_budgets.allowed_models per org that HAS a budget row. */
  budgetAllowedModels: Readonly<Record<string, unknown>>;
  liveSessions: readonly LegacySession[];
}

export interface LegacyProjectionEnv {
  defaultModel: string;
  reviewerModel: string;
  extensionModel: string;
  legacyRates: (model: string) => ModelRates;
}

export type OfferingKey = string;

export interface DesiredOffering {
  key: OfferingKey;
  connectionId: string | null;
  modelId: string;
  source: 'platform' | 'discovered' | 'manual' | 'catalog';
  platformModelId: string | null;
  needsBootstrapPlatformRow: boolean;
  price: ModelRates | null;
}

export interface DesiredAssignment {
  orgId: string | null;
  surface: AiSurface;
  role: 'default';
  defaultOfferingKey: OfferingKey | null;
  permittedOfferingKeys: readonly OfferingKey[] | null;
  allowUserChoice: boolean | null;
  fallbackMayCrossFunding: boolean | null;
}

export interface DesiredRegistryState {
  partnerId: string;
  connectionId: string | null;
  offerings: readonly DesiredOffering[];
  assignments: readonly DesiredAssignment[];
  agentOfferingKeys: Readonly<Record<string, OfferingKey | null>>;
  sessionOfferingKeys: Readonly<Record<string, OfferingKey>>;
}

/** The ai_budgets.allowed_models column default, read from the schema (an org on it never customized its allowlist). */
export const LEGACY_BUDGET_ALLOWED_MODELS_DEFAULT: readonly string[] = Object.freeze(
  [...((aiBudgets.allowedModels.default as string[] | undefined) ?? [])],
);

/** effectivePolicy.ts: `Array.isArray(budget?.allowedModels) ? … : null`. */
export function legacyBudgetAllowlist(raw: unknown): string[] | null {
  return Array.isArray(raw) ? (raw.filter((m): m is string => typeof m === 'string')) : null;
}

function isCustomizedAllowlist(list: readonly string[] | null): list is readonly string[] {
  if (list === null) return false;
  return !(list.length === LEGACY_BUDGET_ALLOWED_MODELS_DEFAULT.length
    && list.every((m, i) => m === LEGACY_BUDGET_ALLOWED_MODELS_DEFAULT[i]));
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

export function buildDesiredRegistryState(s: LegacySnapshot, env: LegacyProjectionEnv): DesiredRegistryState {
  const conn = s.config ? { id: s.config.id, catalog: s.config.catalogEntryId !== null } : null;
  const platformByModel = new Map(s.platformModels.map((m) => [m.modelId, m]));
  const offerings = new Map<OfferingKey, DesiredOffering>();

  const onPlatform = (modelId: string): OfferingKey => {
    const key = `platform:${modelId}`;
    if (!offerings.has(key)) {
      const row = platformByModel.get(modelId);
      offerings.set(key, {
        key, connectionId: null, modelId, source: 'platform',
        platformModelId: row?.id ?? null, needsBootstrapPlatformRow: !row, price: null,
      });
    }
    return key;
  };

  const onConnection = (connectionId: string, catalog: boolean, modelId: string): OfferingKey => {
    const key = `conn:${connectionId}:${modelId}`;
    if (!offerings.has(key)) {
      if (catalog) {
        offerings.set(key, { key, connectionId, modelId, source: 'catalog', platformModelId: null, needsBootstrapPlatformRow: false, price: null });
      } else {
        const row = platformByModel.get(modelId);
        offerings.set(key, {
          key, connectionId, modelId,
          source: row ? 'discovered' : 'manual',
          platformModelId: row?.id ?? null,
          needsBootstrapPlatformRow: false,
          price: row?.priced ? null : env.legacyRates(modelId),
        });
      }
    }
    return key;
  };

  const onPartnerDestination = (modelId: string): OfferingKey =>
    conn ? onConnection(conn.id, conn.catalog, modelId) : onPlatform(modelId);

  const P = s.config ? (s.config.defaultModel ?? env.defaultModel) : env.defaultModel;

  const partnerModel: Record<AiSurface, { key: () => OfferingKey; allowUserChoice: boolean }> = {
    chat: { key: () => onPartnerDestination(P), allowUserChoice: true },
    helper: { key: () => onPartnerDestination(P), allowUserChoice: false },
    script_builder: { key: () => onPartnerDestination(P), allowUserChoice: false },
    script_reviewer: { key: () => onPartnerDestination(legacyReviewerModel(s.partnerReviewerModel, env.reviewerModel)), allowUserChoice: false },
    office_chat: { key: () => onPartnerDestination(P), allowUserChoice: false },
    office_ticket: { key: () => onPartnerDestination(P), allowUserChoice: false },
    ai_agents: { key: () => onPartnerDestination(P), allowUserChoice: false },
    catalog_enrichment: { key: () => onPartnerDestination(P), allowUserChoice: false },
    extension_content: { key: () => onPartnerDestination(env.extensionModel), allowUserChoice: false },
    patch_test: { key: () => onPlatform(env.defaultModel), allowUserChoice: false },
  };

  const assignments: DesiredAssignment[] = AI_SURFACES.map((surface) => ({
    orgId: null,
    surface,
    role: 'default' as const,
    defaultOfferingKey: partnerModel[surface].key(),
    permittedOfferingKeys: null,
    allowUserChoice: partnerModel[surface].allowUserChoice,
    fallbackMayCrossFunding: false,
  }));

  // --- agents -------------------------------------------------------------
  const partnerAgents = s.agents.filter((a) => a.orgId === null);
  const agentOfferingKeys: Record<string, OfferingKey | null> = {};
  for (const a of partnerAgents) agentOfferingKeys[a.id] = a.model ? onPartnerDestination(a.model) : null;

  const orgIds = [...s.orgIds].sort();
  for (const orgId of orgIds) {
    const allowlist = Object.hasOwn(s.budgetAllowedModels, orgId) ? legacyBudgetAllowlist(s.budgetAllowedModels[orgId]) : null;
    const orgAgents = s.agents.filter((a) => a.orgId === orgId);
    const admitted = (model: string | null) => model !== null && allowlist !== null && allowlist.includes(model);
    for (const a of orgAgents) agentOfferingKeys[a.id] = admitted(a.model) ? onPartnerDestination(a.model!) : null;

    // script reviewer override
    const reviewer = Object.hasOwn(s.orgReviewerModels, orgId) ? s.orgReviewerModels[orgId] : null;
    if (reviewer) {
      assignments.push({ orgId, surface: 'script_reviewer', role: 'default', defaultOfferingKey: onPartnerDestination(reviewer), permittedOfferingKeys: null, allowUserChoice: null, fallbackMayCrossFunding: null });
    }

    // office chat policy
    const office = Object.hasOwn(s.officeAllowedModels, orgId) ? s.officeAllowedModels[orgId]! : [];
    if (office.length > 0) {
      assignments.push({
        orgId, surface: 'office_chat', role: 'default',
        defaultOfferingKey: onPartnerDestination(legacyOfficeChatModel(office, P)),
        permittedOfferingKeys: unique(office).map(onPartnerDestination),
        allowUserChoice: null, fallbackMayCrossFunding: null,
      });
    }

    // ai_budgets.allowed_models → ai_agents permitted set (customized orgs only)
    if (isCustomizedAllowlist(allowlist)) {
      const running = partnerAgents.map((partner) => {
        const override = orgAgents.find((a) => a.kind === partner.kind);
        const effective = override && admitted(override.model) ? override.model : partner.model;
        return legacyAgentModel(effective, P);
      });
      assignments.push({
        orgId, surface: 'ai_agents', role: 'default', defaultOfferingKey: null,
        permittedOfferingKeys: unique([...allowlist, ...running, P]).map(onPartnerDestination),
        allowUserChoice: null, fallbackMayCrossFunding: null,
      });
    }
  }

  // --- live sessions --------------------------------------------------------
  const sessionOfferingKeys: Record<string, OfferingKey> = {};
  for (const session of s.liveSessions) sessionOfferingKeys[session.id] = onPartnerDestination(session.model);

  return {
    partnerId: s.partnerId,
    connectionId: conn?.id ?? null,
    offerings: [...offerings.values()],
    assignments,
    agentOfferingKeys,
    sessionOfferingKeys,
  };
}
```

If `aiBudgets.allowedModels.default` is not exposed by the Drizzle version in use, the `toHaveLength(1)` test fails. In that case read the default with `getTableColumns(aiBudgets).allowedModels.default` from `drizzle-orm`. Never inline the literal.

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npx vitest run src/services/aiModels/legacyProjection.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/legacyProjection.ts apps/api/src/services/aiModels/legacyProjection.test.ts
git commit -m "feat(ai): pure legacy-to-registry projection for the W02 backfill

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 11: Parity harness — the registry projection against the REAL legacy code, for every config shape (unit; W03 reuses it)

**Files:**
- Create: `apps/api/src/services/aiModels/parity/harness.ts`
- Create: `apps/api/src/services/aiModels/parity/fixtures.ts`
- Create: `apps/api/src/services/aiModels/parity/legacyOracle.ts`
- Create: `apps/api/src/services/aiModels/parity/storeProjection.ts`
- Create: `apps/api/src/services/aiModels/parity/legacyFixtureMocks.ts` (dependency-free mock state + `vi.mock` module factories)
- Create: `apps/api/src/services/aiModels/parity/bindLegacyFixture.ts` (the per-fixture legacy mock binder)
- Create: `apps/api/src/services/aiModels/parity/projectionEnv.ts` (`projectionEnvFor`)
- Create: `apps/api/src/services/aiModels/parity/parity.test.ts`
- Modify: `apps/api/src/config/env.ts` (~:254, extract `resolveReviewerDefaultModel`; behaviour-preserving)

**Interfaces:**
- Consumes:
  - the legacy functions, called for real: `resolveLlmConfig`, `resolveWireModel`, `getLlmBillingSourceForOrg`, `LlmUnavailableError` (`services/llm/llmConfigResolver.ts`);
  - `mergeAgentPolicies`, `normalizeAgentPolicy` (`services/aiAgents/effectivePolicy.ts`), `mergeScriptPolicies` (`services/scriptProposals/policy.ts`), `isPricedModel`, `getLegacyModelRates` (`services/aiCostTracker.ts`), `resolveDefaultModel` (`services/aiModel.ts`);
  - Task 1's pickers; Task 9's `mergeEffectiveAssignment` / `isPermitted`; Task 10's `buildDesiredRegistryState`.
- Produces (index additions; W03 imports these):
  - `type SurfaceUse = { outcome: 'ok'; destination: 'platform' | { connectionId: string }; funding: 'platform' | 'partner_key'; logicalModel: string; wireModel: string } | { outcome: 'unavailable'; reason: string }`
  - `type ParityQuery = { kind: 'surface'; surface: Exclude<AiSurface, 'ai_agents'>; orgId: string } | { kind: 'agent'; agentKind: string; orgId: string } | { kind: 'session'; sessionId: string }`
  - `type ParityFixture = { name: string; env: Readonly<Record<string, string | undefined>>; snapshot: LegacySnapshot; legacyApiKey: string | null; catalogProvider: ListedProvider | null }`
  - `PARITY_FIXTURES: readonly ParityFixture[]`
  - `parityQueries(fixture: ParityFixture): ParityQuery[]`
  - `legacySurfaceUse(fixture: ParityFixture, query: ParityQuery): Promise<SurfaceUse>` (requires the caller to mock the DB reads, see the test)
  - `type RegistrySnapshot` + `materializeDesiredState(desired: DesiredRegistryState, fixture: ParityFixture): RegistrySnapshot`
  - `projectSurfaceUse(store: RegistrySnapshot, query: ParityQuery): SurfaceUse` (registry semantics: assignment merge, W03's permitted check for policy models, connection status, catalog binding)
  - `EXPECTED_DIVERGENCES`, `runParity(fixture, queries, legacySide, registrySide): Promise<ParityRow[]>`, `type ParityRow`, `sameUse`
  - R6 (W03 Tasks 1 and 7 import these, so they reproduce exactly W02's binding):
    - `projectionEnvFor(fixture: ParityFixture): LegacyProjectionEnv` (`parity/projectionEnv.ts`). It is computed from `fixture.env` only and never reads `process.env`.
    - `bindLegacyFixture(fixture: ParityFixture): void` (`parity/bindLegacyFixture.ts`). It routes the legacy functions' DB and catalog reads to this fixture: seals the BYOK key under the legacy AAD and fills `legacyFixtureState`.
    - `legacyFixtureState`, `legacyDbMockModule()`, `legacyCatalogMockModule()` (`parity/legacyFixtureMocks.ts`, no imports). A test wires them with `vi.mock('<path>/db', async () => (await import('<path>/parity/legacyFixtureMocks')).legacyDbMockModule())`, and the same for `services/llmProviderCatalog`.
    - `materializeDesiredState` / `projectSurfaceUse` stay exported from `storeProjection.ts`.
  - `resolveReviewerDefaultModel(env?: NodeJS.ProcessEnv): string` (config/env.ts)

**Comparison rule:**
- Two `ok` results must agree on destination, funding, logical model and wire model.
- Two `unavailable` results agree. Their reason vocabularies differ (legacy `model_unverified` vs registry `model_unverified` / `key_error`), and both fail closed.
- `ok` vs `unavailable` is a mismatch unless an `EXPECTED_DIVERGENCES` entry explains it. W02 declares exactly two, both deliberate W03 fixes from spec §9:
  1. `catalog_refused_surfaces`: legacy refuses a catalog partner on `ai_agents` (no `resolveWireModel`, no egress proxy) and `extension_content` (`buildAnthropicClient`). The registry resolves the catalog offering.
  2. `catalog_partner_default_unverified`: legacy disables EVERY surface when the partner default isn't verified on the catalog revision, because `resolveLlmConfig` returns `unavailable`. The registry resolves each surface's own offering, so a surface whose model IS verified works.

  The harness asserts every divergence it finds is one of these, and that each declared divergence actually occurs in some fixture. A stale allowlist fails too.

- [ ] **Step 1: Extract the reviewer default (failing test first)**

Add to `apps/api/src/config/env.ts`'s existing test file if one exists (`git ls-files apps/api/src/config | grep env`). Otherwise create `apps/api/src/config/env.reviewerDefault.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveReviewerDefaultModel } from './env';

describe('resolveReviewerDefaultModel (#7600 W02 extraction)', () => {
  it('BREEZE_AI_SCRIPT_REVIEWER_MODEL (trimmed) wins, else the platform default (ANTHROPIC_MODEL honoured)', () => {
    expect(resolveReviewerDefaultModel({ BREEZE_AI_SCRIPT_REVIEWER_MODEL: ' claude-opus-5-5 ' })).toBe('claude-opus-5-5');
    expect(resolveReviewerDefaultModel({ BREEZE_AI_SCRIPT_REVIEWER_MODEL: '  ', ANTHROPIC_MODEL: 'claude-haiku-4-5' })).toBe('claude-haiku-4-5');
  });
});
```

Run: `cd apps/api && npx vitest run src/config/env.reviewerDefault.test.ts`. It FAILS (no export). Then, in `apps/api/src/config/env.ts`, replace:

```ts
export const AI_SCRIPT_REVIEWER_MODEL =
  process.env.BREEZE_AI_SCRIPT_REVIEWER_MODEL?.trim() || resolveDefaultModel();
```

with:

```ts
/** The reviewer's platform default from an env (extracted for the #7600 parity oracle). */
export function resolveReviewerDefaultModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.BREEZE_AI_SCRIPT_REVIEWER_MODEL?.trim() || resolveDefaultModel(env);
}
export const AI_SCRIPT_REVIEWER_MODEL = resolveReviewerDefaultModel();
```

Re-run: PASS. Then run `cd apps/api && npx vitest run src/config/env.aiScriptReviewerModel.test.ts`. That existing test stays green unmodified.

- [ ] **Step 2: Write the harness core (types, comparison, divergences)**

`apps/api/src/services/aiModels/parity/harness.ts`:

```ts
/**
 * AI model registry parity harness (#7600 W02; reused by W03 with
 * resolveModel as the registry side). The legacy side is computed by the REAL
 * legacy functions (legacyOracle.ts); the registry side by whatever the
 * caller passes (W02: projectSurfaceUse over the materialized projection).
 */
import type { AiSurface } from '@breeze/shared';
import type { ListedProvider } from '../../llmProviderCatalog';
import type { LegacySnapshot } from '../legacyProjection';

export type SurfaceUse =
  | { outcome: 'ok'; destination: 'platform' | { connectionId: string }; funding: 'platform' | 'partner_key'; logicalModel: string; wireModel: string }
  | { outcome: 'unavailable'; reason: string };

export type ParityQuery =
  | { kind: 'surface'; surface: Exclude<AiSurface, 'ai_agents'>; orgId: string }
  | { kind: 'agent'; agentKind: string; orgId: string }
  | { kind: 'session'; sessionId: string };

export interface ParityFixture {
  name: string;
  env: Readonly<Record<string, string | undefined>>;
  snapshot: LegacySnapshot;
  /** Plaintext BYOK key; the test seals it under the legacy AAD for snapshot.config.id. */
  legacyApiKey: string | null;
  catalogProvider: ListedProvider | null;
}

export interface ParityRow {
  fixture: string;
  query: ParityQuery;
  legacy: SurfaceUse;
  registry: SurfaceUse;
  divergence: string | null;
}

export function sameUse(a: SurfaceUse, b: SurfaceUse): boolean {
  if (a.outcome === 'unavailable' || b.outcome === 'unavailable') return a.outcome === b.outcome;
  const dest = (d: SurfaceUse & { outcome: 'ok' }) => (d.destination === 'platform' ? 'platform' : d.destination.connectionId);
  return dest(a) === dest(b) && a.funding === b.funding && a.logicalModel === b.logicalModel && a.wireModel === b.wireModel;
}

export interface ExpectedDivergence {
  id: string;
  why: string;
  applies(fixture: ParityFixture, query: ParityQuery, legacy: SurfaceUse, registry: SurfaceUse): boolean;
}

const isCatalog = (f: ParityFixture) => f.snapshot.config?.catalogEntryId != null;

export const EXPECTED_DIVERGENCES: readonly ExpectedDivergence[] = [
  {
    id: 'catalog_refused_surfaces',
    why: 'Legacy refuses catalog partners on ai_agents (no resolveWireModel / egress proxy) and extension_content (buildAnthropicClient). Spec §9: every surface resolves the catalog offering from W03.',
    applies: (f, q, legacy, registry) =>
      isCatalog(f)
      && legacy.outcome === 'unavailable' && legacy.reason === 'catalog_refused'
      && registry.outcome === 'ok'
      && (q.kind === 'agent' || (q.kind === 'surface' && q.surface === 'extension_content')),
  },
  {
    id: 'catalog_partner_default_unverified',
    why: 'Legacy resolveLlmConfig disables every surface when the partner DEFAULT is not verified on the catalog revision; the registry resolves each surface\'s own offering (spec §9 eligibility is per offering).',
    applies: (f, _q, legacy, registry) =>
      isCatalog(f)
      && legacy.outcome === 'unavailable' && legacy.reason === 'model_unverified'
      && registry.outcome === 'ok',
  },
];

export async function runParity(
  fixture: ParityFixture,
  queries: readonly ParityQuery[],
  legacySide: (f: ParityFixture, q: ParityQuery) => Promise<SurfaceUse>,
  registrySide: (f: ParityFixture, q: ParityQuery) => Promise<SurfaceUse> | SurfaceUse,
): Promise<ParityRow[]> {
  const rows: ParityRow[] = [];
  for (const query of queries) {
    const legacy = await legacySide(fixture, query);
    const registry = await registrySide(fixture, query);
    const divergence = sameUse(legacy, registry)
      ? null
      : EXPECTED_DIVERGENCES.find((d) => d.applies(fixture, query, legacy, registry))?.id ?? 'UNEXPECTED';
    rows.push({ fixture: fixture.name, query, legacy, registry, divergence });
  }
  return rows;
}

export function parityQueries(fixture: ParityFixture): ParityQuery[] {
  const surfaces = ['chat', 'helper', 'script_builder', 'script_reviewer', 'office_chat', 'office_ticket',
    'catalog_enrichment', 'extension_content', 'patch_test'] as const;
  const queries: ParityQuery[] = [];
  for (const orgId of fixture.snapshot.orgIds) {
    for (const surface of surfaces) queries.push({ kind: 'surface', surface, orgId });
    for (const agent of fixture.snapshot.agents.filter((a) => a.orgId === null)) {
      queries.push({ kind: 'agent', agentKind: agent.kind, orgId });
    }
  }
  for (const session of fixture.snapshot.liveSessions) queries.push({ kind: 'session', sessionId: session.id });
  return queries;
}
```

- [ ] **Step 3: Write the legacy oracle (real legacy functions only)**

`apps/api/src/services/aiModels/parity/legacyOracle.ts`:

```ts
/**
 * What the LEGACY code path resolves for one surface — computed by calling the
 * legacy functions themselves (no re-implementation): resolveLlmConfig,
 * resolveWireModel, getLlmBillingSourceForOrg, mergeScriptPolicies,
 * mergeAgentPolicies/normalizeAgentPolicy, the Task 1 pickers,
 * resolveDefaultModel, resolveReviewerDefaultModel, isPricedModel.
 *
 * The CALLER must route the DB reads those functions make to the fixture
 * (see parity.test.ts) and set process.env via withFixtureEnv.
 */
import { resolveReviewerDefaultModel } from '../../../config/env';
import { mergeAgentPolicies, normalizeAgentPolicy } from '../../aiAgents/effectivePolicy';
import { isPricedModel } from '../../aiCostTracker';
import { resolveDefaultModel } from '../../aiModel';
import {
  getLlmBillingSourceForOrg,
  LlmUnavailableError,
  resolveLlmConfig,
  resolveWireModel,
  type ResolvedLlmConfig,
} from '../../llm/llmConfigResolver';
import { mergeScriptPolicies, type ScriptPolicyMergeInput } from '../../scriptProposals/policy';
import { legacyAgentModel, legacyExtensionModel, legacyOfficeChatModel, legacyReviewerModel } from '../legacySurfaceModels';
import type { LegacyAgentRow } from '../legacyProjection';
import type { ParityFixture, ParityQuery, SurfaceUse } from './harness';

export async function withFixtureEnv<T>(env: ParityFixture['env'], fn: () => Promise<T>): Promise<T> {
  const keys = ['ANTHROPIC_MODEL', 'BREEZE_AI_SCRIPT_REVIEWER_MODEL', 'WORKSPACE_CONTENT_LLM_MODEL'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const unavailable = (reason: string): SurfaceUse => ({ outcome: 'unavailable', reason });

function scriptPolicyRow(id: string, orgId: string | null, reviewerModel: string | null): ScriptPolicyMergeInput {
  return {
    id, orgId, proposingEnabled: true, unattendedAllowed: false, unattendedEnabled: false,
    maxUnattendedRiskTier: null, unattendedAllowedClasses: null, maxUnattendedPerHour: null,
    protectedResources: null, reviewerModel,
  } as unknown as ScriptPolicyMergeInput;
}

function agentPolicyRow(row: LegacyAgentRow) {
  return normalizeAgentPolicy({
    enabled: true, mode: 'shadow', model: row.model, toolAllowlist: [], protectedResources: {},
    limits: {}, triggers: {}, recipients: {}, actAssets: {}, instructions: null, cooldownSeconds: 900,
  } as Parameters<typeof normalizeAgentPolicy>[0]);
}

function use(
  resolved: Exclude<ResolvedLlmConfig, { source: 'unavailable' }>,
  model: string,
  opts: { refuseCatalog?: boolean; funding?: 'platform' | 'partner_key' } = {},
): SurfaceUse {
  if (opts.refuseCatalog && resolved.source === 'partner' && resolved.endpoint.kind === 'catalog') {
    return unavailable('catalog_refused');
  }
  try {
    const wire = resolveWireModel(resolved, model);
    return {
      outcome: 'ok',
      destination: resolved.source === 'partner' ? { connectionId: resolved.configId } : 'platform',
      funding: opts.funding ?? (resolved.source === 'partner' ? 'partner_key' : 'platform'),
      logicalModel: model,
      wireModel: wire.model,
    };
  } catch (error) {
    if (error instanceof LlmUnavailableError) return unavailable('model_unverified');
    throw error;
  }
}

export async function legacySurfaceUse(fixture: ParityFixture, query: ParityQuery): Promise<SurfaceUse> {
  const s = fixture.snapshot;
  if (query.kind === 'surface' && query.surface === 'patch_test') {
    const model = resolveDefaultModel(); // aiPatchTestRunner: new Anthropic() on the ambient platform key
    return { outcome: 'ok', destination: 'platform', funding: 'platform', logicalModel: model, wireModel: model };
  }
  const resolved = await resolveLlmConfig(s.partnerId);
  if (resolved.source === 'unavailable') return unavailable(resolved.reason);

  if (query.kind === 'session') {
    const session = s.liveSessions.find((x) => x.id === query.sessionId)!;
    return use(resolved, session.model);
  }

  if (query.kind === 'agent') {
    const partnerRow = s.agents.find((a) => a.orgId === null && a.kind === query.agentKind)!;
    const orgRow = s.agents.find((a) => a.orgId === query.orgId && a.kind === query.agentKind) ?? null;
    const raw = Object.hasOwn(s.budgetAllowedModels, query.orgId) ? s.budgetAllowedModels[query.orgId] : undefined;
    // Load step copied from effectivePolicy.ts:523 (the merge itself is called for real).
    const allowedModels = Array.isArray(raw) ? (raw as string[]) : null;
    const merged = mergeAgentPolicies(agentPolicyRow(partnerRow), orgRow ? agentPolicyRow(orgRow) : null, { allowedModels });
    return use(resolved, legacyAgentModel(merged.effective.model, resolved.model), { refuseCatalog: true });
  }

  switch (query.surface) {
    case 'chat':
    case 'helper':
    case 'script_builder':
    case 'office_ticket':
    case 'catalog_enrichment':
      return use(resolved, resolved.model);
    case 'office_chat':
      return use(resolved, legacyOfficeChatModel(s.officeAllowedModels[query.orgId] ?? [], resolved.model));
    case 'script_reviewer': {
      const partner = s.partnerReviewerModel !== null ? scriptPolicyRow('partner-policy', null, s.partnerReviewerModel) : null;
      const orgModel = Object.hasOwn(s.orgReviewerModels, query.orgId) ? s.orgReviewerModels[query.orgId] : undefined;
      const org = orgModel !== undefined ? scriptPolicyRow('org-policy', query.orgId, orgModel) : null;
      const policy = mergeScriptPolicies(partner, org);
      const funding = await getLlmBillingSourceForOrg(query.orgId);
      return use(resolved, legacyReviewerModel(policy.reviewerModel, resolveReviewerDefaultModel(process.env)), { funding });
    }
    case 'extension_content': {
      const model = legacyExtensionModel(undefined, process.env);
      if (!isPricedModel(model)) return unavailable('unpriced_model');
      return use(resolved, model, { refuseCatalog: true });
    }
  }
}
```

- [ ] **Step 4: Write the registry-side projection**

`apps/api/src/services/aiModels/parity/storeProjection.ts`:

```ts
/**
 * Registry semantics for one surface, over a store snapshot: effective
 * assignment (tighten-only merge), the stored binding (agent policy / session),
 * W03's permitted check for explicit policy models (spec §5.6), connection
 * status, and catalog binding. Pure. W02 feeds it the materialized projection;
 * W03 swaps in resolveModel.
 */
import type { ListedProvider } from '../../llmProviderCatalog';
import { mergeEffectiveAssignment, isPermitted, type AssignmentRowInput } from '../assignments';
import type { DesiredRegistryState } from '../legacyProjection';
import type { ParityFixture, ParityQuery, SurfaceUse } from './harness';

export interface RegistrySnapshot {
  partnerId: string;
  connections: ReadonlyArray<{ id: string; kind: 'anthropic_byok' | 'catalog'; status: 'active' | 'error' }>;
  offerings: ReadonlyArray<{ id: string; connectionId: string | null; modelId: string | null; platformModelId: string | null; enabled: boolean }>;
  platformModels: ReadonlyArray<{ id: string; modelId: string }>;
  assignments: ReadonlyArray<AssignmentRowInput & { orgId: string | null; surface: string }>;
  agents: ReadonlyArray<{ id: string; kind: string; orgId: string | null; offeringId: string | null }>;
  sessions: ReadonlyArray<{ id: string; offeringId: string | null }>;
  catalogProvider: ListedProvider | null;
}

const unavailable = (reason: string): SurfaceUse => ({ outcome: 'unavailable', reason });

/** Desired state → a snapshot shaped like the DB (ids = offering keys; bootstrap platform rows get synthetic ids). */
export function materializeDesiredState(desired: DesiredRegistryState, fixture: ParityFixture): RegistrySnapshot {
  const config = fixture.snapshot.config;
  const platformModels = [
    ...fixture.snapshot.platformModels.map((m) => ({ id: m.id, modelId: m.modelId })),
    ...desired.offerings.filter((o) => o.needsBootstrapPlatformRow).map((o) => ({ id: `bootstrap:${o.modelId}`, modelId: o.modelId })),
  ];
  return {
    partnerId: desired.partnerId,
    connections: config ? [{ id: config.id, kind: config.catalogEntryId ? 'catalog' : 'anthropic_byok', status: config.status }] : [],
    offerings: desired.offerings.map((o) => ({
      id: o.key,
      connectionId: o.connectionId,
      modelId: o.connectionId ? o.modelId : null,
      platformModelId: o.connectionId ? o.platformModelId : (o.platformModelId ?? `bootstrap:${o.modelId}`),
      enabled: true,
    })),
    platformModels,
    assignments: desired.assignments.map((a, i) => ({
      id: `assignment-${i}`, role: a.role, orgId: a.orgId, surface: a.surface,
      defaultOfferingId: a.defaultOfferingKey, permittedOfferingIds: a.permittedOfferingKeys ? [...a.permittedOfferingKeys] : null,
      allowUserChoice: a.allowUserChoice, options: null, fallbackOfferingIds: null, fallbackMayCrossFunding: a.fallbackMayCrossFunding,
    })),
    agents: fixture.snapshot.agents.map((a) => ({ id: a.id, kind: a.kind, orgId: a.orgId, offeringId: desired.agentOfferingKeys[a.id] ?? null })),
    sessions: fixture.snapshot.liveSessions.map((x) => ({ id: x.id, offeringId: desired.sessionOfferingKeys[x.id] ?? null })),
    catalogProvider: fixture.catalogProvider,
  };
}

function resolveOffering(store: RegistrySnapshot, offeringId: string | null): SurfaceUse {
  if (!offeringId) return unavailable('no_default');
  const offering = store.offerings.find((o) => o.id === offeringId);
  if (!offering || !offering.enabled) return unavailable('offering_unavailable');
  if (offering.connectionId === null) {
    const platform = store.platformModels.find((m) => m.id === offering.platformModelId);
    if (!platform) return unavailable('platform_model_missing');
    return { outcome: 'ok', destination: 'platform', funding: 'platform', logicalModel: platform.modelId, wireModel: platform.modelId };
  }
  const connection = store.connections.find((c) => c.id === offering.connectionId);
  if (!connection || connection.status !== 'active') return unavailable('key_error');
  const model = offering.modelId!;
  let wireModel = model;
  if (connection.kind === 'catalog') {
    const p = store.catalogProvider;
    if (!p || !Object.hasOwn(p.modelMap, model) || !p.verifiedModels.includes(model)) return unavailable('model_unverified');
    wireModel = p.modelMap[model]!.providerModel;
  }
  return { outcome: 'ok', destination: { connectionId: connection.id }, funding: 'partner_key', logicalModel: model, wireModel };
}

export function projectSurfaceUse(store: RegistrySnapshot, query: ParityQuery): SurfaceUse {
  if (query.kind === 'session') {
    return resolveOffering(store, store.sessions.find((x) => x.id === query.sessionId)?.offeringId ?? null);
  }
  const surface = query.kind === 'agent' ? 'ai_agents' : query.surface;
  const effective = mergeEffectiveAssignment({
    surface,
    role: 'default',
    partner: store.assignments.find((a) => a.orgId === null && a.surface === surface) ?? null,
    org: store.assignments.find((a) => a.orgId === query.orgId && a.surface === surface) ?? null,
  });
  if (query.kind === 'agent') {
    const partnerAgent = store.agents.find((a) => a.orgId === null && a.kind === query.agentKind);
    const orgAgent = store.agents.find((a) => a.orgId === query.orgId && a.kind === query.agentKind);
    const offeringId = orgAgent?.offeringId ?? partnerAgent?.offeringId ?? effective.defaultOfferingId;
    if (offeringId && !isPermitted(effective.permitted, offeringId)) return unavailable('not_permitted');
    return resolveOffering(store, offeringId);
  }
  return resolveOffering(store, effective.defaultOfferingId);
}
```

- [ ] **Step 5: Write the fixtures (every legacy config shape)**

`apps/api/src/services/aiModels/parity/fixtures.ts`:

```ts
/**
 * Every legacy configuration shape the W02 projection must preserve
 * (spec §10 parity). Test-fixture data: model id literals are allowed here.
 */
import type { ListedProvider } from '../../llmProviderCatalog';
import type { LegacySnapshot } from '../legacyProjection';
import type { ParityFixture } from './harness';

const PARTNER = '70000000-0000-4000-8000-000000000001';
const CONN = '70000000-0000-4000-8000-0000000000c1';
const ORG_A = '70000000-0000-4000-8000-0000000000a1';
const ORG_B = '70000000-0000-4000-8000-0000000000b1';
const KEY = 'sk-ant-api03-parity-fixture-key-0001';

const platformModels: LegacySnapshot['platformModels'] = [
  { id: 'pm-sonnet55', modelId: 'claude-sonnet-5-5', priced: true },
  { id: 'pm-opus55', modelId: 'claude-opus-5-5', priced: true },
  { id: 'pm-sonnet46', modelId: 'claude-sonnet-4-6', priced: true },
  { id: 'pm-haiku45', modelId: 'claude-haiku-4-5', priced: true },
  { id: 'pm-sonnet45d', modelId: 'claude-sonnet-4-5-20250929', priced: true },
];

const base = (over: Partial<LegacySnapshot> = {}): LegacySnapshot => ({
  partnerId: PARTNER, orgIds: [ORG_A, ORG_B], config: null, platformModels,
  partnerReviewerModel: null, orgReviewerModels: {}, officeAllowedModels: {},
  agents: [], budgetAllowedModels: {}, liveSessions: [], ...over,
});

const catalog = (verified: string[]): ListedProvider => ({
  entryId: '70000000-0000-4000-8000-0000000000e1', slug: 'gateway', name: 'Gateway', revisionId: '70000000-0000-4000-8000-0000000000e2',
  revision: 1, baseUrl: 'https://llm-gateway.example.com', authMode: 'x-api-key', dataNote: null,
  modelMap: {
    'claude-sonnet-4-6': { providerModel: 'vendor/claude-sonnet-4-6', inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 },
    'claude-haiku-4-5': { providerModel: 'vendor/claude-haiku-4-5', inputCentsPerM: 100, outputCentsPerM: 500, cacheReadCentsPerM: 10, cacheWriteCentsPerM: 125 },
  },
  verifiedModels: verified,
});

const agents = [
  { id: 'ag-p-triage', kind: 'triage', orgId: null, model: 'claude-opus-5-5' },
  { id: 'ag-p-patch', kind: 'patch', orgId: null, model: null },
  { id: 'ag-a-triage', kind: 'triage', orgId: ORG_A, model: 'claude-haiku-4-5' },
];

const byok = (over: Partial<NonNullable<LegacySnapshot['config']>> = {}) =>
  ({ id: CONN, status: 'active' as const, defaultModel: null, catalogEntryId: null, ...over });

export const PARITY_FIXTURES: readonly ParityFixture[] = [
  { name: 'no_config', env: {}, snapshot: base(), legacyApiKey: null, catalogProvider: null },
  {
    name: 'no_config_env_overrides',
    env: { ANTHROPIC_MODEL: 'claude-opus-5-5', BREEZE_AI_SCRIPT_REVIEWER_MODEL: 'claude-haiku-4-5', WORKSPACE_CONTENT_LLM_MODEL: 'claude-sonnet-4-6' },
    snapshot: base(), legacyApiKey: null, catalogProvider: null,
  },
  { name: 'self_host_gateway_model', env: { ANTHROPIC_MODEL: 'my-gateway-model' }, snapshot: base(), legacyApiKey: null, catalogProvider: null },
  { name: 'byok_direct_pinned', env: {}, snapshot: base({ config: byok({ defaultModel: 'claude-opus-5-5' }) }), legacyApiKey: KEY, catalogProvider: null },
  { name: 'byok_direct_tracking_env', env: { ANTHROPIC_MODEL: 'claude-sonnet-4-6' }, snapshot: base({ config: byok() }), legacyApiKey: KEY, catalogProvider: null },
  { name: 'byok_errored', env: {}, snapshot: base({ config: byok({ status: 'error' }) }), legacyApiKey: KEY, catalogProvider: null },
  { name: 'byok_unknown_model', env: {}, snapshot: base({ config: byok({ defaultModel: 'my-gateway-model' }) }), legacyApiKey: KEY, catalogProvider: null },
  {
    name: 'byok_catalog_verified', env: {},
    snapshot: base({ config: byok({ defaultModel: 'claude-sonnet-4-6', catalogEntryId: '70000000-0000-4000-8000-0000000000e1' }), agents, budgetAllowedModels: { [ORG_A]: ['claude-haiku-4-5'] } }),
    legacyApiKey: KEY, catalogProvider: catalog(['claude-sonnet-4-6', 'claude-haiku-4-5']),
  },
  {
    name: 'catalog_default_unverified', env: {},
    snapshot: base({ config: byok({ defaultModel: 'claude-opus-5-5', catalogEntryId: '70000000-0000-4000-8000-0000000000e1' }), partnerReviewerModel: 'claude-haiku-4-5' }),
    legacyApiKey: KEY, catalogProvider: catalog(['claude-sonnet-4-6', 'claude-haiku-4-5']),
  },
  {
    name: 'agent_org_override_inside_allowlist', env: {},
    snapshot: base({ agents, budgetAllowedModels: { [ORG_A]: ['claude-haiku-4-5'] } }),
    legacyApiKey: null, catalogProvider: null,
  },
  {
    name: 'agent_org_override_outside_default_allowlist', env: {},
    snapshot: base({ agents, budgetAllowedModels: { [ORG_A]: ['claude-sonnet-4-5-20250929'] } }),
    legacyApiKey: null, catalogProvider: null,
  },
  { name: 'agent_org_override_no_budget_row', env: {}, snapshot: base({ agents }), legacyApiKey: null, catalogProvider: null },
  {
    name: 'byok_agents_customized_allowlist', env: {},
    snapshot: base({ config: byok({ defaultModel: 'claude-sonnet-5-5' }), agents, budgetAllowedModels: { [ORG_A]: ['claude-haiku-4-5', 'claude-sonnet-4-5-20250929'] } }),
    legacyApiKey: KEY, catalogProvider: null,
  },
  {
    name: 'office_and_reviewer_overrides', env: { BREEZE_AI_SCRIPT_REVIEWER_MODEL: 'claude-sonnet-4-6' },
    snapshot: base({
      config: byok({ defaultModel: 'claude-sonnet-5-5' }),
      partnerReviewerModel: 'claude-opus-5-5',
      orgReviewerModels: { [ORG_A]: 'claude-haiku-4-5', [ORG_B]: null },
      officeAllowedModels: { [ORG_A]: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929'], [ORG_B]: [] },
    }),
    legacyApiKey: KEY, catalogProvider: null,
  },
  {
    name: 'live_sessions', env: {},
    snapshot: base({
      config: byok({ defaultModel: 'claude-sonnet-5-5' }),
      liveSessions: [
        { id: '70000000-0000-4000-8000-0000000005a1', orgId: ORG_A, model: 'claude-opus-5-5' },
        { id: '70000000-0000-4000-8000-0000000005a2', orgId: ORG_B, model: 'claude-sonnet-5-5' },
      ],
    }),
    legacyApiKey: KEY, catalogProvider: null,
  },
];
```

(`claude-haiku-4-5-20251001` is deliberately absent from `platformModels` in `office_and_reviewer_overrides`. It is a dated id on a BYOK connection, so it becomes a `manual` offering at its `MODEL_PRICING` rate, which exercises Review Focus 2.)

- [ ] **Step 6: Write the exported binding helpers (R6), then the parity suite (failing first)**

`apps/api/src/services/aiModels/parity/legacyFixtureMocks.ts` has **no imports**, so a `vi.mock` factory can load it without a cycle (`encryptedColumnRegistry.ts` itself imports `../db`):

```ts
/**
 * Mock state + vi.mock module factories that route the LEGACY functions' DB
 * and catalog reads to one parity fixture (#7600 W02; W03 Tasks 1/7 reuse).
 * Dependency-free on purpose: vi.mock factories import it.
 * Every read the oracle triggers is a single-row lookup for the fixture's one
 * partner, keyed by the Drizzle table object passed to .from().
 */
export const legacyFixtureState: { rows: Map<unknown, unknown[]>; catalogProvider: unknown } = {
  rows: new Map(),
  catalogProvider: null,
};

export function legacyDbMockModule() {
  const select = () => ({
    from: (table: unknown) => {
      const rows = legacyFixtureState.rows.get(table) ?? [];
      const chain: Record<string, unknown> = {};
      chain.where = () => chain;
      chain.limit = () => Promise.resolve(rows);
      chain.then = (resolve: (r: unknown[]) => unknown) => resolve(rows);
      return chain;
    },
  });
  return {
    db: { select, update: () => { throw new Error('parity oracle must not write'); } },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    getCurrentDbAccessContext: () => undefined,
  };
}

export function legacyCatalogMockModule() {
  return { getListedProviderByEntryId: async () => legacyFixtureState.catalogProvider };
}
```

`apps/api/src/services/aiModels/parity/bindLegacyFixture.ts`:

```ts
/** Bind one parity fixture to the legacy mocks (#7600 W02; W03 Task 1 imports it). */
import { organizations, partnerLlmConfigs } from '../../../db/schema';
import { columnAad, encryptedColumnRegistry } from '../../encryptedColumnRegistry';
import { encryptSecret } from '../../secretCrypto';
import type { ParityFixture } from './harness';
import { legacyFixtureState } from './legacyFixtureMocks';

export function bindLegacyFixture(fixture: ParityFixture): void {
  const legacySpec = encryptedColumnRegistry.find((s) => s.table === 'partner_llm_configs' && s.column === 'api_key_encrypted')!;
  const config = fixture.snapshot.config;
  legacyFixtureState.rows = new Map<unknown, unknown[]>([
    [organizations, [{ partnerId: fixture.snapshot.partnerId }]],
    [partnerLlmConfigs, config ? [{
      id: config.id, partnerId: fixture.snapshot.partnerId,
      apiKeyEncrypted: encryptSecret(fixture.legacyApiKey!, { aad: columnAad(legacySpec, config.id) }),
      defaultModel: config.defaultModel, catalogEntryId: config.catalogEntryId,
      status: config.status, configVersion: 1,
    }] : []],
  ]);
  legacyFixtureState.catalogProvider = fixture.catalogProvider;
}
```

`apps/api/src/services/aiModels/parity/projectionEnv.ts`:

```ts
/** The LegacyProjectionEnv a fixture's env implies (#7600 W02; W03 Tasks 1/7 import it). Reads fixture.env, never process.env. */
import { resolveReviewerDefaultModel } from '../../../config/env';
import { getLegacyModelRates } from '../../aiCostTracker';
import { resolveDefaultModel } from '../../aiModel';
import type { LegacyProjectionEnv } from '../legacyProjection';
import { legacyExtensionModel } from '../legacySurfaceModels';
import type { ParityFixture } from './harness';

export function projectionEnvFor(fixture: ParityFixture): LegacyProjectionEnv {
  const env = fixture.env as NodeJS.ProcessEnv;
  return {
    defaultModel: resolveDefaultModel(env),
    reviewerModel: resolveReviewerDefaultModel(env),
    extensionModel: legacyExtensionModel(undefined, env),
    legacyRates: (model) => getLegacyModelRates(model).rates,
  };
}
```

(When W03 moves `getLegacyModelRates` to `legacySurfaceModels.ts` (R4), this one import moves with it.)

`apps/api/src/services/aiModels/parity/parity.test.ts`:

```ts
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../../db', async () => (await import('./legacyFixtureMocks')).legacyDbMockModule());
vi.mock('../../llmProviderCatalog', async () => (await import('./legacyFixtureMocks')).legacyCatalogMockModule());
vi.mock('../../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: vi.fn() }));
vi.mock('../../sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { buildDesiredRegistryState } from '../legacyProjection';
import { bindLegacyFixture } from './bindLegacyFixture';
import { PARITY_FIXTURES } from './fixtures';
import { EXPECTED_DIVERGENCES, parityQueries, runParity, type ParityFixture, type ParityRow } from './harness';
import { legacySurfaceUse, withFixtureEnv } from './legacyOracle';
import { projectionEnvFor } from './projectionEnv';
import { materializeDesiredState, projectSurfaceUse } from './storeProjection';

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = 'parity-unit-test-key-material';
  process.env.APP_ENCRYPTION_KEY_ID = 'parity-test';
  process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
});

async function parityFor(f: ParityFixture, snapshotOverride?: ParityFixture['snapshot']): Promise<ParityRow[]> {
  bindLegacyFixture(f);
  const projected: ParityFixture = snapshotOverride ? { ...f, snapshot: snapshotOverride } : f;
  const store = materializeDesiredState(buildDesiredRegistryState(projected.snapshot, projectionEnvFor(f)), projected);
  return withFixtureEnv(f.env, () =>
    runParity(f, parityQueries(f), legacySurfaceUse, (_f, q) => projectSurfaceUse(store, q)));
}

describe('AI model registry parity: projection vs the real legacy path (#7600 W02, spec §10)', () => {
  it.each(PARITY_FIXTURES.map((f) => [f.name, f] as const))('%s: every surface keeps destination, funding and model', async (_name, f) => {
    const rows = await parityFor(f);
    expect(rows.length).toBeGreaterThan(0);
    const unexpected = rows.filter((r) => r.divergence === 'UNEXPECTED');
    expect(unexpected, JSON.stringify(unexpected, null, 2)).toEqual([]);
  });

  it('every declared divergence actually occurs (no stale allowlist)', async () => {
    const seen = new Set<string>();
    for (const f of PARITY_FIXTURES) for (const r of await parityFor(f)) if (r.divergence) seen.add(r.divergence);
    expect([...seen].sort()).toEqual(EXPECTED_DIVERGENCES.map((d) => d.id).sort());
  });

  it('is discriminating: a projection that moves BYOK chat to the platform key is caught', async () => {
    const f = PARITY_FIXTURES.find((x) => x.name === 'byok_direct_pinned')!;
    const rows = await parityFor(f, { ...f.snapshot, config: null });
    expect(rows.some((r) => r.divergence === 'UNEXPECTED')).toBe(true);
  });

  it('projectionEnvFor reads the fixture env, never process.env (W03 reuses it)', () => {
    const saved = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_MODEL = 'process-env-must-not-leak';
    try {
      const f = PARITY_FIXTURES.find((x) => x.name === 'no_config_env_overrides')!;
      expect(projectionEnvFor(f)).toMatchObject({ defaultModel: 'claude-opus-5-5', reviewerModel: 'claude-haiku-4-5', extensionModel: 'claude-sonnet-4-6' });
      expect(projectionEnvFor(PARITY_FIXTURES.find((x) => x.name === 'no_config')!).defaultModel).not.toBe('process-env-must-not-leak');
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_MODEL; else process.env.ANTHROPIC_MODEL = saved;
    }
  });
});
```

The third test is the control. It proves the suite can go red: projecting a snapshot with the config stripped must produce UNEXPECTED rows, because chat moves from the connection to the platform key.

- [ ] **Step 7: Run it; fix only the projection, never the oracle**

Run: `cd apps/api && npx vitest run src/services/aiModels/parity/parity.test.ts`

Expected: PASS for all 15 fixtures plus the three meta tests. A failing fixture means a bug in `legacyProjection.ts` (Task 10) or `storeProjection.ts`. Fix it there and add a matching case to `legacyProjection.test.ts`. The oracle may only change if it fails to call a legacy function faithfully. For example, if `mergeScriptPolicies` or `normalizeAgentPolicy` rejects a fixture row shape, fill in the missing field. Never change what the oracle computes.

Two assertions guard the oracle's own correctness and should be checked when it fails:
- `legacySurfaceUse` returns `{ outcome: 'unavailable', reason: 'key_error' }` for `byok_errored` on every non-patch surface.
- It returns `catalog_refused` for `byok_catalog_verified` agents.

- [ ] **Step 8: Typecheck and commit**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
git add apps/api/src/services/aiModels/parity apps/api/src/config/env.ts apps/api/src/config/env.reviewerDefault.test.ts
git commit -m "test(ai): registry parity harness against the real legacy resolution for every config shape

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 12: `legacyReconcile.ts` — apply the projection to the DB, at boot and on demand (unit + integration)

**Files:**
- Create: `apps/api/src/services/aiModels/legacyReconcile.ts`
- Create: `apps/api/src/services/aiModels/legacyReconcile.test.ts`
- Create: `apps/api/src/__tests__/integration/aiModelRegistryReconcile.integration.test.ts`
- Modify: `apps/api/src/services/aiAgentSdk.ts` (:85–86, `export` the two session-timeout constants)
- Modify: `apps/api/src/index.ts` (detached boot sweep after `serve()`, next to `sealUnsealedSettingsSecrets` ~:1833)
- Modify: `apps/api/src/services/aiModels/index.ts` (append exports)
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` (allowlist)

**Interfaces:**
- Consumes: Task 10 (`buildDesiredRegistryState`, types); Task 1 (`legacyExtensionModel`, `getLegacyModelRates`); `resolveDefaultModel`; `AI_SCRIPT_REVIEWER_MODEL`; `SESSION_MAX_AGE_MS`, `SESSION_IDLE_TIMEOUT_MS`.
- Produces (index additions):
  - `readLegacyProjectionEnv(): LegacyProjectionEnv`
  - `loadLegacySnapshot(partnerId: string): Promise<LegacySnapshot>`. It must run inside a held system context.
  - `reconcilePartnerFromLegacyInTx(partnerId: string, env?: LegacyProjectionEnv): Promise<ReconcileReport>`. It must run inside a held system context; it takes the partner's advisory lock and joins the caller's transaction.
    - **It throws on any failure and never returns a partial report.** No `try/catch` inside it swallows an error.
    - It never opens, commits or rolls back a transaction of its own (no `db.transaction`, no savepoint).
    - A failure therefore aborts the CALLER's transaction. W03's cutover inserts its cutover row in that same transaction, so a half-projected partner can never be marked cut over.
    - Only `reconcileAllPartnersFromLegacy` (the W02 boot sweep) catches, and only per partner, around a fresh transaction.
  - `reconcilePartnerFromLegacy(partnerId: string, env?: LegacyProjectionEnv): Promise<ReconcileReport>`, which opens its own fresh system context.
  - `reconcileAllPartnersFromLegacy(opts?: { env?: LegacyProjectionEnv }): Promise<{ partners: number; failures: Array<{ partnerId: string; error: string }> }>`
  - `type ReconcileReport = { partnerId: string; connection: 'created' | 'updated' | 'unchanged' | 'removed' | 'none'; offeringsUpserted: number; assignmentsUpserted: number; assignmentsDeleted: number; agentsRebound: number; sessionsRebound: number; bootstrapPlatformModels: string[] }`
  - `ensureLegacyPlatformModel(modelId: string): Promise<string>`, which inserts an unpriced, non-offered `ai_platform_models` row once (`ON CONFLICT (model_id) DO NOTHING`) and returns its id.
- **Ownership in W02:** the reconcile owns every `ai_model_assignments` row of the partner (partner rows and its orgs' rows). It deletes rows the projection doesn't produce. Nothing else writes assignments in W02.
  - From W03 on, each partner is projected exactly once, at its durable cutover (W03 Task 6A), and never again. W03 deletes the detached boot sweep and replaces the `/ai/provider` re-projection with registry-native remaps (W03 Task 6B). Re-projecting a cut-over partner would revert registry-native edits.
- **"Live" sessions:** `status = 'active' AND created_at > now() − SESSION_MAX_AGE_MS AND last_activity_at > now() − SESSION_IDLE_TIMEOUT_MS`. Those are exactly the sessions `aiAgentSdk` would still serve. Lazily-expired rows that still say `active` are left unbound on purpose, because there can be very many of them.

**Apply order** (one transaction per partner, under `pg_advisory_xact_lock(hashtextextended('ai_model_registry_reconcile:' || partner_id, 0))`):
1. Mirror the legacy connection by id, comparing in TS so an unchanged row is never rewritten.
2. Build the desired state.
3. Bootstrap missing platform rows.
4. Upsert offerings on the partial unique indexes. This includes in-place `source`/price changes on a BYOK↔catalog switch, so offering ids survive.
5. Upsert assignments, then delete assignment rows that aren't desired.
6. Rebind agents and live sessions (`IS DISTINCT FROM` guards).
7. Delete orphan compat connections, i.e. ids with no legacy row. This runs last, after every assignment that referenced their offerings has been re-pointed. Their offerings cascade, and bound sessions/agents SET NULL.

- [ ] **Step 1: Write the failing unit test (env + context guard)**

`apps/api/src/services/aiModels/legacyReconcile.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({ scope: undefined as string | undefined }));
vi.mock('../../db', () => ({
  db: {},
  getCurrentDbAccessContext: () => (ctx.scope ? { scope: ctx.scope } : undefined),
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../../config/env', () => ({ AI_SCRIPT_REVIEWER_MODEL: 'claude-reviewer-env' }));
vi.mock('../aiModel', () => ({ resolveDefaultModel: () => 'claude-default-env' }));

import { readLegacyProjectionEnv, reconcilePartnerFromLegacyInTx } from './legacyReconcile';

describe('legacyReconcile guards (#7600 W02)', () => {
  it('reads the same env values the legacy call sites use', () => {
    const saved = process.env.WORKSPACE_CONTENT_LLM_MODEL;
    process.env.WORKSPACE_CONTENT_LLM_MODEL = 'claude-ext-env';
    try {
      const env = readLegacyProjectionEnv();
      expect(env).toMatchObject({ defaultModel: 'claude-default-env', reviewerModel: 'claude-reviewer-env', extensionModel: 'claude-ext-env' });
      expect(env.legacyRates('claude-sonnet-5-5').inputCentsPerM).toBe(200);
    } finally {
      if (saved === undefined) delete process.env.WORKSPACE_CONTENT_LLM_MODEL; else process.env.WORKSPACE_CONTENT_LLM_MODEL = saved;
    }
  });

  it('refuses to run outside a held system context (it would silently see a tenant slice)', async () => {
    ctx.scope = 'partner';
    await expect(reconcilePartnerFromLegacyInTx('p')).rejects.toThrow(/system DB context/);
    ctx.scope = undefined;
    await expect(reconcilePartnerFromLegacyInTx('p')).rejects.toThrow(/system DB context/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/legacyReconcile.test.ts`
Expected: FAIL, because `./legacyReconcile` does not resolve.

- [ ] **Step 3: Implement**

In `apps/api/src/services/aiAgentSdk.ts`, change lines 85–86 to `export const SESSION_MAX_AGE_MS …` and `export const SESSION_IDLE_TIMEOUT_MS …` (values unchanged).

`apps/api/src/services/aiModels/legacyReconcile.ts`:

```ts
/**
 * W02 sync point: make the registry the projection of the legacy config for
 * one partner (spec §10). Idempotent; serialized per partner by a
 * transaction-scoped advisory lock, so concurrent boots and /ai/provider writes
 * converge. Runs only in a held SYSTEM context: it reads and writes every org
 * of the partner, and must never see a tenant slice.
 *
 * W03 (Task 6A) calls reconcilePartnerFromLegacyInTx ONCE per partner, in the
 * same transaction as a durable per-partner cutover row (gated in resolveModel,
 * plus a leased post-serve() sweep), deletes the boot sweep below, and never
 * re-projects a cut-over partner.
 */
import { and, eq, gt, inArray, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { AI_SCRIPT_REVIEWER_MODEL } from '../../config/env';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  aiAgents,
  aiBudgets,
  aiModelAssignments,
  aiPlatformModels,
  aiScriptPolicies,
  aiSessions,
  clientAiOrgPolicies,
  llmProviderCatalog,
  organizations,
  partnerAiConnections,
  partnerAiModels,
  partnerLlmConfigs,
  partners,
} from '../../db/schema';
import { SESSION_IDLE_TIMEOUT_MS, SESSION_MAX_AGE_MS } from '../aiAgentSdk';
import { getLegacyModelRates } from '../aiCostTracker';
import { resolveDefaultModel } from '../aiModel';
import {
  buildDesiredRegistryState,
  type DesiredRegistryState,
  type LegacyProjectionEnv,
  type LegacySnapshot,
  type OfferingKey,
} from './legacyProjection';
import { legacyExtensionModel } from './legacySurfaceModels';

export interface ReconcileReport {
  partnerId: string;
  connection: 'created' | 'updated' | 'unchanged' | 'removed' | 'none';
  offeringsUpserted: number;
  assignmentsUpserted: number;
  assignmentsDeleted: number;
  agentsRebound: number;
  sessionsRebound: number;
  bootstrapPlatformModels: string[];
}

export function readLegacyProjectionEnv(): LegacyProjectionEnv {
  return {
    defaultModel: resolveDefaultModel(),
    reviewerModel: AI_SCRIPT_REVIEWER_MODEL,
    extensionModel: legacyExtensionModel(undefined),
    legacyRates: (model) => getLegacyModelRates(model).rates,
  };
}

function assertSystemContext(): void {
  if (getCurrentDbAccessContext()?.scope !== 'system') {
    throw new Error('legacyReconcile requires a held system DB context');
  }
}

const priced = (row: { input: unknown; output: unknown; read: unknown; write: unknown }) =>
  [row.input, row.output, row.read, row.write].every((v) => v !== null && v !== undefined);

export async function loadLegacySnapshot(partnerId: string): Promise<LegacySnapshot> {
  assertSystemContext();
  const orgRows = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.partnerId, partnerId));
  const orgIds = orgRows.map((o) => o.id);
  const inOrgs = (column: AnyPgColumn) => (orgIds.length ? inArray(column, orgIds) : sql`false`);

  const [config] = await db
    .select({ id: partnerLlmConfigs.id, status: partnerLlmConfigs.status, defaultModel: partnerLlmConfigs.defaultModel, catalogEntryId: partnerLlmConfigs.catalogEntryId })
    .from(partnerLlmConfigs).where(eq(partnerLlmConfigs.partnerId, partnerId)).limit(1);

  const platformRows = await db
    .select({ id: aiPlatformModels.id, modelId: aiPlatformModels.modelId, input: aiPlatformModels.inputCentsPerM, output: aiPlatformModels.outputCentsPerM, read: aiPlatformModels.cacheReadCentsPerM, write: aiPlatformModels.cacheWriteCentsPerM })
    .from(aiPlatformModels);

  const scriptRows = await db
    .select({ orgId: aiScriptPolicies.orgId, partnerId: aiScriptPolicies.partnerId, reviewerModel: aiScriptPolicies.reviewerModel })
    .from(aiScriptPolicies)
    .where(or(and(isNull(aiScriptPolicies.orgId), eq(aiScriptPolicies.partnerId, partnerId)), inOrgs(aiScriptPolicies.orgId)));

  const officeRows = await db
    .select({ orgId: clientAiOrgPolicies.orgId, allowedModels: clientAiOrgPolicies.allowedModels })
    .from(clientAiOrgPolicies).where(inOrgs(clientAiOrgPolicies.orgId));

  const agentRows = await db
    .select({ id: aiAgents.id, kind: aiAgents.kind, orgId: aiAgents.orgId, model: aiAgents.model })
    .from(aiAgents)
    .where(and(isNull(aiAgents.disabledAt), or(and(isNull(aiAgents.orgId), eq(aiAgents.partnerId, partnerId)), inOrgs(aiAgents.orgId))));

  const budgetRows = await db
    .select({ orgId: aiBudgets.orgId, allowedModels: aiBudgets.allowedModels })
    .from(aiBudgets).where(inOrgs(aiBudgets.orgId));

  const now = Date.now();
  const sessionRows = await db
    .select({ id: aiSessions.id, orgId: aiSessions.orgId, model: aiSessions.model })
    .from(aiSessions)
    .where(and(
      inOrgs(aiSessions.orgId),
      eq(aiSessions.status, 'active'),
      gt(aiSessions.createdAt, new Date(now - SESSION_MAX_AGE_MS)),
      gt(aiSessions.lastActivityAt, new Date(now - SESSION_IDLE_TIMEOUT_MS)),
    ));

  return {
    partnerId,
    orgIds,
    config: config ? { id: config.id, status: config.status, defaultModel: config.defaultModel, catalogEntryId: config.catalogEntryId } : null,
    platformModels: platformRows.map((r) => ({ id: r.id, modelId: r.modelId, priced: priced(r) })),
    partnerReviewerModel: scriptRows.find((r) => r.orgId === null)?.reviewerModel ?? null,
    orgReviewerModels: Object.fromEntries(scriptRows.filter((r) => r.orgId !== null).map((r) => [r.orgId!, r.reviewerModel])),
    officeAllowedModels: Object.fromEntries(officeRows.map((r) => [
      r.orgId,
      Array.isArray(r.allowedModels) ? (r.allowedModels as unknown[]).filter((m): m is string => typeof m === 'string') : [],
    ])),
    agents: agentRows.map((a) => ({ id: a.id, kind: a.kind, orgId: a.orgId, model: a.model })),
    budgetAllowedModels: Object.fromEntries(budgetRows.map((r) => [r.orgId, r.allowedModels])),
    liveSessions: sessionRows.map((s) => ({ id: s.id, orgId: s.orgId, model: s.model })),
  };
}

export async function ensureLegacyPlatformModel(modelId: string): Promise<string> {
  assertSystemContext();
  await db.execute(sql`
    INSERT INTO ai_platform_models (provider, model_id, display_name, platform_offered, is_platform_default, lifecycle)
    VALUES ('anthropic', ${modelId}, ${modelId}, false, false, 'available')
    ON CONFLICT (model_id) DO NOTHING`);
  const [row] = await db.select({ id: aiPlatformModels.id }).from(aiPlatformModels).where(eq(aiPlatformModels.modelId, modelId)).limit(1);
  if (!row) throw new Error(`could not bootstrap ai_platform_models row for ${modelId}`);
  return row.id;
}

async function mirrorConnection(snapshot: LegacySnapshot): Promise<ReconcileReport['connection']> {
  if (!snapshot.config) return 'none';
  const [legacy] = await db.select().from(partnerLlmConfigs).where(eq(partnerLlmConfigs.id, snapshot.config.id)).limit(1);
  if (!legacy) return 'none';
  const kind = legacy.catalogEntryId ? 'catalog' as const : 'anthropic_byok' as const;
  const mirrored = {
    kind,
    apiKeyEncrypted: legacy.apiKeyEncrypted,   // byte copy: same id + legacy AAD tag
    keyLast4: legacy.keyLast4,
    keyFingerprint: legacy.keyFingerprint,
    catalogEntryId: legacy.catalogEntryId,
    status: legacy.status,
    lastError: legacy.lastError,
    verifiedAt: legacy.verifiedAt,
    configVersion: legacy.configVersion,
    connectedBy: legacy.connectedBy,
    legacyDefaultModel: legacy.defaultModel,
  };
  const [existing] = await db.select().from(partnerAiConnections).where(eq(partnerAiConnections.id, legacy.id)).limit(1);
  if (!existing) {
    let name = 'Anthropic API key';
    if (legacy.catalogEntryId) {
      const [entry] = await db.select({ name: llmProviderCatalog.name }).from(llmProviderCatalog).where(eq(llmProviderCatalog.id, legacy.catalogEntryId)).limit(1);
      name = entry?.name ?? 'Catalog endpoint';
    }
    // Any previous compat connection was an orphan and has already been removed
    // by reconcilePartnerFromLegacyInTx, so partner_ai_connections_compat_uq is free.
    await db.insert(partnerAiConnections).values({ id: legacy.id, partnerId: legacy.partnerId, name, ...mirrored, createdAt: legacy.createdAt, updatedAt: legacy.updatedAt });
    return 'created';
  }
  const changed = (Object.keys(mirrored) as Array<keyof typeof mirrored>).some((k) => {
    const a = existing[k]; const b = mirrored[k];
    return a instanceof Date || b instanceof Date ? (a as Date | null)?.getTime() !== (b as Date | null)?.getTime() : a !== b;
  });
  if (!changed) return 'unchanged';
  await db.update(partnerAiConnections).set({ ...mirrored, updatedAt: new Date() }).where(eq(partnerAiConnections.id, legacy.id));
  return 'updated';
}

async function upsertOfferings(desired: DesiredRegistryState, partnerId: string, report: ReconcileReport): Promise<Map<OfferingKey, string>> {
  const ids = new Map<OfferingKey, string>();
  for (const o of desired.offerings) {
    if (o.connectionId === null) {
      let platformModelId = o.platformModelId;
      if (!platformModelId) {
        platformModelId = await ensureLegacyPlatformModel(o.modelId);
        report.bootstrapPlatformModels.push(o.modelId);
      }
      const [row] = await db.insert(partnerAiModels)
        .values({ partnerId, platformModelId, source: 'platform', enabled: true })
        .onConflictDoUpdate({
          target: [partnerAiModels.partnerId, partnerAiModels.platformModelId],
          targetWhere: sql`connection_id IS NULL`,
          set: { enabled: true, updatedAt: new Date() },
        })
        .returning({ id: partnerAiModels.id });
      ids.set(o.key, row!.id);
    } else {
      const price = o.price
        ? { priceInputCentsPerM: o.price.inputCentsPerM, priceOutputCentsPerM: o.price.outputCentsPerM, priceCacheReadCentsPerM: o.price.cacheReadCentsPerM, priceCacheWriteCentsPerM: o.price.cacheWriteCentsPerM }
        : { priceInputCentsPerM: null, priceOutputCentsPerM: null, priceCacheReadCentsPerM: null, priceCacheWriteCentsPerM: null };
      const [row] = await db.insert(partnerAiModels)
        .values({ partnerId, connectionId: o.connectionId, modelId: o.modelId, source: o.source, platformModelId: o.platformModelId, enabled: true, ...price })
        .onConflictDoUpdate({
          target: [partnerAiModels.connectionId, partnerAiModels.modelId],
          targetWhere: sql`connection_id IS NOT NULL`,
          set: { source: o.source, platformModelId: o.platformModelId, enabled: true, ...price, updatedAt: new Date() },
        })
        .returning({ id: partnerAiModels.id });
      ids.set(o.key, row!.id);
    }
    report.offeringsUpserted += 1;
  }
  return ids;
}

async function applyAssignments(desired: DesiredRegistryState, partnerId: string, orgIds: readonly string[], ids: Map<OfferingKey, string>, report: ReconcileReport): Promise<void> {
  const resolve = (key: OfferingKey | null) => (key === null ? null : ids.get(key)!);
  const keep = new Set<string>();
  for (const a of desired.assignments) {
    const values = {
      offeringPartnerId: partnerId,
      surface: a.surface,
      role: a.role,
      defaultOfferingId: resolve(a.defaultOfferingKey),
      permittedOfferingIds: a.permittedOfferingKeys ? a.permittedOfferingKeys.map((k) => ids.get(k)!) : null,
      allowUserChoice: a.allowUserChoice,
      fallbackMayCrossFunding: a.fallbackMayCrossFunding,
      options: null,
      fallbackOfferingIds: null,
      updatedAt: new Date(),
    };
    const [row] = a.orgId === null
      ? await db.insert(aiModelAssignments).values({ ...values, partnerId, orgId: null })
          .onConflictDoUpdate({ target: [aiModelAssignments.partnerId, aiModelAssignments.surface, aiModelAssignments.role], targetWhere: sql`org_id IS NULL`, set: values })
          .returning({ id: aiModelAssignments.id })
      : await db.insert(aiModelAssignments).values({ ...values, orgId: a.orgId, partnerId: null })
          .onConflictDoUpdate({ target: [aiModelAssignments.orgId, aiModelAssignments.surface, aiModelAssignments.role], targetWhere: sql`org_id IS NOT NULL`, set: values })
          .returning({ id: aiModelAssignments.id });
    keep.add(row!.id);
    report.assignmentsUpserted += 1;
  }
  const owned = or(
    and(isNull(aiModelAssignments.orgId), eq(aiModelAssignments.partnerId, partnerId)),
    orgIds.length ? inArray(aiModelAssignments.orgId, [...orgIds]) : sql`false`,
  );
  const deleted = await db.delete(aiModelAssignments)
    .where(keep.size ? and(owned, notInArray(aiModelAssignments.id, [...keep])) : owned)
    .returning({ id: aiModelAssignments.id });
  report.assignmentsDeleted = deleted.length;
}

async function rebind(desired: DesiredRegistryState, partnerId: string, ids: Map<OfferingKey, string>, report: ReconcileReport): Promise<void> {
  for (const [agentId, key] of Object.entries(desired.agentOfferingKeys)) {
    const offeringId = key === null ? null : ids.get(key)!;
    const updated = await db.update(aiAgents)
      .set({ offeringId, offeringPartnerId: offeringId ? partnerId : null })
      .where(and(eq(aiAgents.id, agentId), sql`${aiAgents.offeringId} IS DISTINCT FROM ${offeringId}::uuid`))
      .returning({ id: aiAgents.id });
    report.agentsRebound += updated.length;
  }
  for (const [sessionId, key] of Object.entries(desired.sessionOfferingKeys)) {
    const offeringId = ids.get(key)!;
    const updated = await db.update(aiSessions)
      .set({ offeringId, offeringPartnerId: partnerId })
      .where(and(eq(aiSessions.id, sessionId), sql`${aiSessions.offeringId} IS DISTINCT FROM ${offeringId}::uuid`))
      .returning({ id: aiSessions.id });
    report.sessionsRebound += updated.length;
  }
}

export async function reconcilePartnerFromLegacyInTx(partnerId: string, env: LegacyProjectionEnv = readLegacyProjectionEnv()): Promise<ReconcileReport> {
  assertSystemContext();
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ai_model_registry_reconcile:${partnerId}`}, 0))`);
  const report: ReconcileReport = { partnerId, connection: 'none', offeringsUpserted: 0, assignmentsUpserted: 0, assignmentsDeleted: 0, agentsRebound: 0, sessionsRebound: 0, bootstrapPlatformModels: [] };

  const snapshot = await loadLegacySnapshot(partnerId);
  // A compat connection whose id has no legacy row is an orphan (the legacy
  // config was deleted or replaced). It must leave BEFORE a replacement is
  // inserted (compat unique index) and AFTER nothing references its
  // offerings — so: re-point first using a projection without it, then delete.
  const orphans = await db.select({ id: partnerAiConnections.id }).from(partnerAiConnections)
    .where(and(
      eq(partnerAiConnections.partnerId, partnerId),
      inArray(partnerAiConnections.kind, ['anthropic_byok', 'catalog']),
      snapshot.config ? ne(partnerAiConnections.id, snapshot.config.id) : sql`true`,
    ));

  const desired = buildDesiredRegistryState(snapshot, env);
  if (orphans.length > 0) {
    // Re-point everything away from the orphan's offerings, then remove it.
    const platformOnly = buildDesiredRegistryState({ ...snapshot, config: null }, env);
    const interimIds = await upsertOfferings(platformOnly, partnerId, { ...report, bootstrapPlatformModels: [] });
    await applyAssignments(platformOnly, partnerId, snapshot.orgIds, interimIds, { ...report });
    await db.delete(partnerAiConnections).where(inArray(partnerAiConnections.id, orphans.map((o) => o.id)));
    if (!snapshot.config) report.connection = 'removed';
  }
  if (snapshot.config) report.connection = await mirrorConnection(snapshot);

  const ids = await upsertOfferings(desired, partnerId, report);
  await applyAssignments(desired, partnerId, snapshot.orgIds, ids, report);
  await rebind(desired, partnerId, ids, report);
  return report;
}

export function reconcilePartnerFromLegacy(partnerId: string, env?: LegacyProjectionEnv): Promise<ReconcileReport> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() => reconcilePartnerFromLegacyInTx(partnerId, env), 'aiModelRegistry.reconcilePartner'));
}

export async function reconcileAllPartnersFromLegacy(opts: { env?: LegacyProjectionEnv } = {}): Promise<{ partners: number; failures: Array<{ partnerId: string; error: string }> }> {
  const env = opts.env ?? readLegacyProjectionEnv();
  const partnerIds = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => db.select({ id: partners.id }).from(partners), 'aiModelRegistry.reconcileAll.list'));
  const failures: Array<{ partnerId: string; error: string }> = [];
  for (const { id } of partnerIds) {
    try {
      await reconcilePartnerFromLegacy(id, env);
    } catch (error) {
      failures.push({ partnerId: id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { partners: partnerIds.length, failures };
}
```

Wire the boot sweep in `apps/api/src/index.ts`, directly after the `sealUnsealedSettingsSecrets` block:

```ts
  // AI model registry W02 (#7600): keep the registry a projection of the legacy
  // AI config (connections, offerings, assignments, agent/session bindings).
  // Detached: nothing in W02 routes on it, and GET /ai/provider reads only
  // connection rows, which the migration and the facade keep exact. Env changes
  // need a restart, so a per-boot sweep tracks ANTHROPIC_MODEL-style defaults.
  // W03 (Task 6A) deletes this block: each partner is projected exactly once,
  // durably, at its cutover (gated in resolveModel, plus a leased sweep after serve()).
  void reconcileAllPartnersFromLegacy()
    .then((result) => {
      console.log(`[startup] AI model registry reconciled for ${result.partners} partner(s); ${result.failures.length} failed`);
      for (const failure of result.failures) {
        captureException(new Error(failure.error), undefined, { area: 'ai_model_registry_reconcile', partnerId: failure.partnerId });
      }
    })
    .catch((err) => {
      console.error('[startup] AI model registry reconcile failed:', err);
      captureException(err, undefined, { area: 'ai_model_registry_reconcile' });
    });
```

Add the import `import { reconcileAllPartnersFromLegacy } from './services/aiModels/legacyReconcile';` next to the `sealUnsealedSettingsSecrets` import.

Append to the aiModels `index.ts`: `export * from './legacyProjection'; export * from './legacyReconcile';`. Add this allowlist entry:

```ts
  'services/aiModels/legacyReconcile.ts': 'W02 projection of the legacy AI config: every write is pinned to one partner id (system context, never caller-chosen) and reproduces what partner_llm_configs + policy columns already say; runs at boot and inside /ai/provider writes, which are gated by canManagePartnerWidePolicies in routes/aiProvider.ts',
```

- [ ] **Step 4: Write the integration suite**

`apps/api/src/__tests__/integration/aiModelRegistryReconcile.integration.test.ts`:

```ts
/**
 * W02 reconcile against real Postgres (#7600): the DB state it writes is
 * semantically the projection (every parity query resolves identically over
 * the DB and over the pure desired state), it is idempotent, concurrent runs
 * converge, and deletion / kind-switch / errored / unknown-model shapes hold.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withSystemDbAccessContext } from '../../db';
import { columnAad } from '../../services/encryptedColumnRegistry';
import { encryptSecret } from '../../services/secretCrypto';
import { buildDesiredRegistryState, type LegacyProjectionEnv } from '../../services/aiModels/legacyProjection';
import { loadLegacySnapshot, reconcilePartnerFromLegacy, reconcilePartnerFromLegacyInTx } from '../../services/aiModels/legacyReconcile';
import { parityQueries, type ParityFixture } from '../../services/aiModels/parity/harness';
import { materializeDesiredState, projectSurfaceUse, type RegistrySnapshot } from '../../services/aiModels/parity/storeProjection';
import { getLegacyModelRates } from '../../services/aiCostTracker';
import { createOrganization, createPartner, createUser } from './db-utils';
import { closeRegistryFixtures, fixtureSql as adminSql, keySpec, seedAgent } from './aiModelRegistryFixtures';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

const env: LegacyProjectionEnv = {
  defaultModel: 'claude-sonnet-5-5',
  reviewerModel: 'claude-sonnet-5-5',
  extensionModel: 'claude-haiku-4-5',
  legacyRates: (m) => getLegacyModelRates(m).rates,
};

async function seedLegacyConfig(partnerId: string, over: { defaultModel?: string | null; status?: 'active' | 'error' } = {}): Promise<string> {
  const id = randomUUID();
  const sealed = encryptSecret('sk-ant-api03-reconcile-0042', { aad: columnAad(keySpec('partner_llm_configs'), id) })!;
  await adminSql`INSERT INTO partner_llm_configs (id, partner_id, api_key_encrypted, key_last4, key_fingerprint, default_model, status)
                 VALUES (${id}, ${partnerId}, ${sealed}, '0042', 'fp', ${over.defaultModel ?? null}, ${over.status ?? 'active'})`;
  return id;
}

/** Read the registry back from the DB in the storeProjection shape. */
async function registryFromDb(partnerId: string): Promise<RegistrySnapshot> {
  const [connections, offerings, platformModels, assignments, agents, sessions] = await Promise.all([
    adminSql`SELECT id, kind, status FROM partner_ai_connections WHERE partner_id = ${partnerId}`,
    adminSql`SELECT id, connection_id, model_id, platform_model_id, enabled FROM partner_ai_models WHERE partner_id = ${partnerId}`,
    adminSql`SELECT id, model_id FROM ai_platform_models`,
    adminSql`SELECT * FROM ai_model_assignments WHERE offering_partner_id = ${partnerId}`,
    adminSql`SELECT a.id, a.kind, a.org_id, a.offering_id FROM ai_agents a LEFT JOIN organizations o ON o.id = a.org_id
             WHERE a.partner_id = ${partnerId} OR o.partner_id = ${partnerId}`,
    adminSql`SELECT s.id, s.offering_id FROM ai_sessions s JOIN organizations o ON o.id = s.org_id WHERE o.partner_id = ${partnerId}`,
  ]);
  return {
    partnerId,
    connections: connections.map((c) => ({ id: c.id, kind: c.kind, status: c.status })),
    offerings: offerings.map((o) => ({ id: o.id, connectionId: o.connection_id, modelId: o.model_id, platformModelId: o.platform_model_id, enabled: o.enabled })),
    platformModels: platformModels.map((m) => ({ id: m.id, modelId: m.model_id })),
    assignments: assignments.map((a) => ({
      id: a.id, role: a.role, orgId: a.org_id, surface: a.surface, defaultOfferingId: a.default_offering_id,
      permittedOfferingIds: a.permitted_offering_ids, allowUserChoice: a.allow_user_choice, options: a.options,
      fallbackOfferingIds: a.fallback_offering_ids, fallbackMayCrossFunding: a.fallback_may_cross_funding,
    })),
    agents: agents.map((a) => ({ id: a.id, kind: a.kind, orgId: a.org_id, offeringId: a.offering_id })),
    sessions: sessions.map((s) => ({ id: s.id, offeringId: s.offering_id })),
    catalogProvider: null,
  };
}

async function seedRichPartner() {
  const partner = await createPartner();
  const [orgA, orgB] = [await createOrganization({ partnerId: partner.id }), await createOrganization({ partnerId: partner.id })];
  const user = await createUser({ partnerId: partner.id });
  const configId = await seedLegacyConfig(partner.id, { defaultModel: 'claude-opus-5-5' });
  await adminSql`INSERT INTO ai_script_policies (partner_id, reviewer_model) VALUES (${partner.id}, 'claude-haiku-4-5')`;
  await adminSql`INSERT INTO client_ai_org_policies (org_id, allowed_models) VALUES (${orgA.id}, '["claude-haiku-4-5-20251001"]'::jsonb)`;
  await adminSql`INSERT INTO ai_budgets (org_id, allowed_models) VALUES (${orgA.id}, '["claude-haiku-4-5"]'::jsonb)`;
  await seedAgent({ partnerId: partner.id, createdBy: user.id, model: 'claude-opus-5-5' });
  await seedAgent({ orgId: orgA.id, createdBy: user.id, model: 'claude-haiku-4-5' });
  const [live] = await adminSql`INSERT INTO ai_sessions (org_id, model, status) VALUES (${orgB.id}, 'claude-sonnet-5-5', 'active') RETURNING id`;
  const [stale] = await adminSql`INSERT INTO ai_sessions (org_id, model, status, created_at, last_activity_at)
                                VALUES (${orgB.id}, 'claude-sonnet-5-5', 'active', now() - interval '3 days', now() - interval '3 days') RETURNING id`;
  return { partner, orgA, orgB, configId, liveSessionId: String(live!.id), staleSessionId: String(stale!.id) };
}

describe.skipIf(!RUN)('legacy reconcile (#7600 W02)', () => {
  it('the DB state resolves every parity query exactly like the pure projection', async () => {
    const t = await seedRichPartner();
    await reconcilePartnerFromLegacy(t.partner.id, env);
    const snapshot = await withSystemDbAccessContext(() => loadLegacySnapshot(t.partner.id));
    const fixture: ParityFixture = { name: 'db', env: {}, snapshot, legacyApiKey: null, catalogProvider: null };
    const fromProjection = materializeDesiredState(buildDesiredRegistryState(snapshot, env), fixture);
    const fromDb = await registryFromDb(t.partner.id);
    // Offering ids differ (keys vs uuids) but SurfaceUse carries none: destination
    // (platform | connection id), funding and models must match exactly.
    for (const q of parityQueries(fixture)) {
      expect(projectSurfaceUse(fromDb, q)).toEqual(projectSurfaceUse(fromProjection, q));
    }
    const [live] = await adminSql`SELECT offering_id FROM ai_sessions WHERE id = ${t.liveSessionId}`;
    const [stale] = await adminSql`SELECT offering_id FROM ai_sessions WHERE id = ${t.staleSessionId}`;
    expect(live!.offering_id).not.toBeNull();
    expect(stale!.offering_id).toBeNull();
  });

  it('a failure mid-reconcile throws and leaves nothing behind in the caller\'s transaction (never a partial report)', async () => {
    const t = await seedRichPartner();
    // Fail the assignment step for THIS partner only, after offerings were upserted.
    await adminSql.unsafe(`
      CREATE OR REPLACE FUNCTION w02_test_fail_assignments() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW.offering_partner_id = '${t.partner.id}' THEN RAISE EXCEPTION 'injected reconcile failure'; END IF;
        RETURN NEW;
      END $f$;
      DROP TRIGGER IF EXISTS w02_test_fail_assignments ON ai_model_assignments;
      CREATE TRIGGER w02_test_fail_assignments BEFORE INSERT ON ai_model_assignments
        FOR EACH ROW EXECUTE FUNCTION w02_test_fail_assignments();`);
    try {
      let report: unknown = 'not-returned';
      await expect(withSystemDbAccessContext(async () => {
        report = await reconcilePartnerFromLegacyInTx(t.partner.id, env);
      })).rejects.toThrow(/injected reconcile failure/);
      expect(report).toBe('not-returned');
      expect(await adminSql`SELECT 1 FROM partner_ai_connections WHERE partner_id = ${t.partner.id}`).toHaveLength(0);
      expect(await adminSql`SELECT 1 FROM partner_ai_models WHERE partner_id = ${t.partner.id}`).toHaveLength(0);
      expect(await adminSql`SELECT 1 FROM ai_model_assignments WHERE offering_partner_id = ${t.partner.id}`).toHaveLength(0);
      const [bound] = await adminSql`SELECT offering_id FROM ai_sessions WHERE id = ${t.liveSessionId}`;
      expect(bound!.offering_id).toBeNull();
    } finally {
      await adminSql.unsafe(`DROP TRIGGER IF EXISTS w02_test_fail_assignments ON ai_model_assignments;
                             DROP FUNCTION IF EXISTS w02_test_fail_assignments();`);
    }
  });

  it('is idempotent: a second run changes nothing', async () => {
    const t = await seedRichPartner();
    await reconcilePartnerFromLegacy(t.partner.id, env);
    const before = await adminSql`SELECT updated_at FROM partner_ai_connections WHERE id = ${t.configId}`;
    const counts = async () => (await adminSql`
      SELECT (SELECT count(*) FROM partner_ai_models WHERE partner_id = ${t.partner.id})::int AS offerings,
             (SELECT count(*) FROM ai_model_assignments WHERE offering_partner_id = ${t.partner.id})::int AS assignments`)[0];
    const first = await counts();
    const report = await reconcilePartnerFromLegacy(t.partner.id, env);
    expect(report).toMatchObject({ connection: 'unchanged', assignmentsDeleted: 0, agentsRebound: 0, sessionsRebound: 0 });
    expect(await counts()).toEqual(first);
    const after = await adminSql`SELECT updated_at FROM partner_ai_connections WHERE id = ${t.configId}`;
    expect(after[0]!.updated_at).toEqual(before[0]!.updated_at);
  });

  it('two concurrent reconciles converge (advisory lock + partial-unique upserts)', async () => {
    const t = await seedRichPartner();
    const results = await Promise.allSettled([reconcilePartnerFromLegacy(t.partner.id, env), reconcilePartnerFromLegacy(t.partner.id, env)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const [dupes] = await adminSql`
      SELECT count(*)::int AS n FROM (SELECT connection_id, model_id, platform_model_id FROM partner_ai_models
       WHERE partner_id = ${t.partner.id} GROUP BY 1, 2, 3 HAVING count(*) > 1) d`;
    expect(dupes!.n).toBe(0);
  });

  it('an errored config keeps every partner-destination surface on its (errored) connection', async () => {
    const partner = await createPartner();
    await createOrganization({ partnerId: partner.id });
    const configId = await seedLegacyConfig(partner.id, { status: 'error' });
    await reconcilePartnerFromLegacy(partner.id, env);
    const [conn] = await adminSql`SELECT status FROM partner_ai_connections WHERE id = ${configId}`;
    expect(conn!.status).toBe('error');
    const rows = await adminSql`
      SELECT a.surface, m.connection_id FROM ai_model_assignments a JOIN partner_ai_models m ON m.id = a.default_offering_id
       WHERE a.partner_id = ${partner.id} AND a.org_id IS NULL`;
    for (const r of rows) expect(r.connection_id).toBe(r.surface === 'patch_test' ? null : configId);
  });

  it('an unknown platform default bootstraps one unpriced platform row, reused by every partner', async () => {
    const modelId = `w02-gateway-${randomUUID()}`;
    const [p, q] = [await createPartner(), await createPartner()];
    const r1 = await reconcilePartnerFromLegacy(p.id, { ...env, defaultModel: modelId });
    const r2 = await reconcilePartnerFromLegacy(q.id, { ...env, defaultModel: modelId });
    expect(r1.bootstrapPlatformModels).toEqual([modelId]);
    expect(r2.bootstrapPlatformModels).toEqual([]);
    const rows = await adminSql`SELECT platform_offered, input_cents_per_m FROM ai_platform_models WHERE model_id = ${modelId}`;
    expect(rows).toEqual([{ platform_offered: false, input_cents_per_m: null }]);
  });

  it('deleting the legacy config moves every surface and binding back to the platform and removes the connection', async () => {
    const t = await seedRichPartner();
    await reconcilePartnerFromLegacy(t.partner.id, env);
    await adminSql`DELETE FROM partner_llm_configs WHERE id = ${t.configId}`;
    const report = await reconcilePartnerFromLegacy(t.partner.id, env);
    expect(report.connection).toBe('removed');
    expect(await adminSql`SELECT 1 FROM partner_ai_connections WHERE partner_id = ${t.partner.id}`).toHaveLength(0);
    const onConnection = await adminSql`SELECT 1 FROM partner_ai_models WHERE partner_id = ${t.partner.id} AND connection_id IS NOT NULL`;
    expect(onConnection).toHaveLength(0);
    const [live] = await adminSql`SELECT offering_id FROM ai_sessions WHERE id = ${t.liveSessionId}`;
    expect(live!.offering_id).not.toBeNull();
  });

  it('a BYOK→catalog switch updates offerings in place (same ids)', async () => {
    const partner = await createPartner();
    await createOrganization({ partnerId: partner.id });
    const configId = await seedLegacyConfig(partner.id, { defaultModel: 'claude-sonnet-4-6' });
    await reconcilePartnerFromLegacy(partner.id, env);
    const [before] = await adminSql`SELECT id FROM partner_ai_models WHERE connection_id = ${configId} AND model_id = 'claude-sonnet-4-6'`;
    const [entry] = await adminSql`INSERT INTO llm_provider_catalog (slug, name, status) VALUES (${`w02-${randomUUID()}`}, 'Gateway', 'listed') RETURNING id`;
    await adminSql`UPDATE partner_llm_configs SET catalog_entry_id = ${entry!.id}, config_version = config_version + 1 WHERE id = ${configId}`;
    await reconcilePartnerFromLegacy(partner.id, env);
    const [after] = await adminSql`SELECT id, source, price_input_cents_per_m FROM partner_ai_models WHERE connection_id = ${configId} AND model_id = 'claude-sonnet-4-6'`;
    expect(after).toEqual({ id: before!.id, source: 'catalog', price_input_cents_per_m: null });
    const [conn] = await adminSql`SELECT kind, catalog_entry_id FROM partner_ai_connections WHERE id = ${configId}`;
    expect(conn).toEqual({ kind: 'catalog', catalog_entry_id: entry!.id });
  });
});
```

- [ ] **Step 5: Run unit + integration + guards**

```bash
cd apps/api && npx vitest run src/services/aiModels/legacyReconcile.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/index
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelRegistryReconcile.integration.test.ts
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

Expected: PASS. `src/index` covers the `index.*.test.ts` boot suites, which must stay green. If one of them mocks every service `index.ts` imports, add `vi.mock('./services/aiModels/legacyReconcile', () => ({ reconcileAllPartnersFromLegacy: vi.fn(async () => ({ partners: 0, failures: [] })) }))` to that file.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/aiModels/legacyReconcile.ts apps/api/src/services/aiModels/legacyReconcile.test.ts \
  apps/api/src/services/aiModels/index.ts apps/api/src/services/aiAgentSdk.ts apps/api/src/index.ts \
  apps/api/src/__tests__/partner-wide-write-coverage.test.ts \
  apps/api/src/__tests__/integration/aiModelRegistryReconcile.integration.test.ts
git commit -m "feat(ai): reconcile the model registry from legacy AI config at boot (W02 backfill)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 13: `/ai/provider` on the registry — same contract, reads the registry, writes legacy + registry atomically (unit + integration)

> **W02-only scaffolding (W03 Task 6B removes it).** The "legacy write + re-projection" write path below exists only while legacy is the routing source.
> - W03 replaces every facade write with **registry-native id remaps** (connect / disconnect / rotate / change default model, gated by the partner's cutover) and stops writing `partner_llm_configs`.
> - It drops the Task 2 mirror trigger.
> - It rewrites this task's integration cases that assert the legacy-row or trigger round trip.
>
> Re-running the projection after the flip would revert registry-native edits, so nothing here may be reused as the W03 write path. The read path (`getPartnerLlmStatus` from the registry) and the unchanged route contract carry forward.

`routes/aiProvider.ts` does not change. It keeps importing `savePartnerLlmKey`, `getPartnerLlmStatus`, `updatePartnerLlmConfig`, `updatePartnerLlmEndpoint` and `deletePartnerLlmConfig` from `services/partnerLlmConfig.ts`. `routes/aiProvider.test.ts` mocks exactly those, so it stays green **unmodified**. The service underneath becomes the facade:
- **Reads:** `getPartnerLlmStatus` reads the partner's compat connection in `partner_ai_connections`. `defaultModel` comes from `legacy_default_model`, so `null` ("tracks the deployment default") survives exactly. The route still derives `effectiveDefaultModel` from `resolveDefaultModel()`.
- **Writes:** every mutation runs its legacy write and `reconcilePartnerFromLegacyInTx(partnerId)` in ONE `runOutsideDbContext(() => withSystemDbAccessContext(…))` transaction. That makes legacy (still the routing source in W02) and registry commit or roll back together.
  - `savePartnerLlmKey` already used that shape.
  - `updatePartnerLlmConfig`, `updatePartnerLlmEndpoint` and `deletePartnerLlmConfig` move into it from the request context. They keep pinning every statement to the route-supplied `partnerId` (`BILLING_MANAGE` + `canManagePartnerWidePolicies` gate it at the route). The second-pooled-connection cost is the same as POST /key's today, on low-concurrency admin-only routes.
  - Probes still run outside any transaction.

**Files:**
- Modify: `apps/api/src/services/partnerLlmConfig.ts`
- Modify: `apps/api/src/services/partnerLlmConfig.test.ts` (add one `vi.mock` for the reconcile, plus new tests; existing test bodies unchanged)
- Create: `apps/api/src/routes/aiProvider.registry.test.ts` (new route-level tests; `aiProvider.test.ts` untouched)
- Modify: `apps/api/src/__tests__/integration/aiModelRegistryReconcile.integration.test.ts` (append the facade round trip)

**Interfaces:**
- Consumes: `partnerAiConnections` (Task 2); `reconcilePartnerFromLegacyInTx` (Task 12).
- Produces: no new exports. Contract invariants:
  - `getPartnerLlmStatus(partnerId)` returns the same `PartnerLlmStatus` shape, sourced from the registry.
  - After any successful facade write, GET reflects it immediately, and the registry equals the projection of the new legacy state.
  - A failed probe or validation writes nothing to either store.

- [ ] **Step 1: Write the failing unit tests**

In `apps/api/src/services/partnerLlmConfig.test.ts`, add next to the other `vi.mock` calls:

```ts
const reconcileState = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('./aiModels/legacyReconcile', () => ({
  reconcilePartnerFromLegacyInTx: vi.fn(async (partnerId: string) => {
    reconcileState.calls.push(partnerId);
    return { partnerId };
  }),
}));
```

and in the existing `beforeEach`, add `reconcileState.calls.length = 0;`. Then append:

```ts
describe('registry facade (#7600 W02)', () => {
  it('getPartnerLlmStatus reads the registry connection, not partner_llm_configs', async () => {
    const { db } = await import('../db');
    const fromTables: unknown[] = [];
    vi.mocked(db.select).mockImplementationOnce(() => ({
      from: vi.fn((table: unknown) => {
        fromTables.push(table);
        return { where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([{ keyLast4: '1234', defaultModel: null, status: 'active', verifiedAt: null, lastError: null, catalogEntryId: null }])) })) };
      }),
    }) as never);
    const { partnerAiConnections } = await import('../db/schema');
    await expect(getPartnerLlmStatus(PARTNER_ID)).resolves.toMatchObject({ configured: true, keyLast4: '1234', defaultModel: null });
    expect(fromTables).toEqual([partnerAiConnections]);
  });

  it('every successful write reconciles the partner inside the write transaction', async () => {
    dbState.insertResults.push([{ id: CONFIG_ID, configVersion: 1 }]);
    dbState.selectResults.push([]); // resolveProbeEndpointForPartner: no catalog pin
    await savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID });
    dbState.updateResults.push([{ configVersion: 2 }]);
    await updatePartnerLlmConfig({ partnerId: PARTNER_ID, defaultModel: 'claude-haiku-4-5' });
    dbState.deleteResults.push([{ id: CONFIG_ID }]);
    await deletePartnerLlmConfig(PARTNER_ID);
    expect(reconcileState.calls).toEqual([PARTNER_ID, PARTNER_ID, PARTNER_ID]);
  });

  it('a rejected probe or validation reconciles nothing', async () => {
    anthropicState.create.mockRejectedValueOnce(new anthropicState.apiErrorClass('bad key', 401));
    dbState.selectResults.push([]);
    await expect(savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID })).rejects.toMatchObject({ status: 400 });
    await expect(updatePartnerLlmConfig({ partnerId: PARTNER_ID, defaultModel: 'claude-made-up-model' })).rejects.toMatchObject({ status: 400 });
    expect(reconcileState.calls).toEqual([]);
  });
});
```

Adapt the `savePartnerLlmKey` queue pushes to the existing happy-path test in the same file (`'probes first and persists a row-bound ciphertext…'`). Copy its exact `insertResults` / `selectResults` setup rather than inventing one.

`apps/api/src/routes/aiProvider.registry.test.ts` pins that the route contract is served from the registry end-to-end with a mocked DB. It mounts the real route and the real service, with `db`, the probe and the reconcile mocked:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { user: { id: '11111111-1111-4111-8111-111111111111' }, scope: 'partner', partnerId: '22222222-2222-4222-8222-222222222222', partnerOrgAccess: 'all' });
    await next();
  },
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));
vi.mock('../services/permissions', () => ({ PERMISSIONS: { BILLING_MANAGE: { resource: 'billing', action: 'manage' } } }));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/llmProviderCatalog', () => ({ getListedProviders: vi.fn(async () => []), getListedProviderByEntryId: vi.fn() }));
vi.mock('../services/aiModels/legacyReconcile', () => ({ reconcilePartnerFromLegacyInTx: vi.fn(async () => ({})) }));
const registryRow = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => (registryRow.value ? [registryRow.value] : [])) })) })) })),
  },
}));

import { aiProviderRoutes } from './aiProvider';

describe('GET /ai/provider served from the registry (#7600 W02)', () => {
  beforeEach(() => { registryRow.value = null; });

  it('keeps the exact contract, including a null pin that tracks the deployment default', async () => {
    registryRow.value = { keyLast4: '4242', defaultModel: null, status: 'active', verifiedAt: new Date('2026-11-01T00:00:00Z'), lastError: null, catalogEntryId: null };
    const res = await aiProviderRoutes.request('/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ configured: true, provider: 'anthropic', keyLast4: '4242', defaultModel: null, status: 'active', lastError: null, catalogEntryId: null });
    expect(typeof body.effectiveDefaultModel).toBe('string');
    expect(Object.keys(body).sort()).toEqual(['catalog', 'catalogEntryId', 'configured', 'defaultModel', 'effectiveDefaultModel', 'keyLast4', 'lastError', 'provider', 'status', 'supportedModels', 'verifiedAt']);
  });

  it('reports the platform when the partner has no connection', async () => {
    const body = await (await aiProviderRoutes.request('/')).json();
    expect(body).toMatchObject({ configured: false, status: 'platform', keyLast4: null, defaultModel: null });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/partnerLlmConfig.test.ts src/routes/aiProvider.registry.test.ts`
Expected: FAIL. `fromTables` is `[partnerLlmConfigs]`, and `reconcileState.calls` is `[]`.

- [ ] **Step 3: Implement the facade**

`apps/api/src/services/partnerLlmConfig.ts`:

1. Imports. Add `inArray` to the drizzle import, `partnerAiConnections` to the schema import, and:

```ts
import { reconcilePartnerFromLegacyInTx } from './aiModels/legacyReconcile';
```

2. A local helper, right after `PartnerLlmError`:

```ts
/**
 * #7600 W02 SCAFFOLDING: the legacy table stays the routing source until W03,
 * and the registry is its projection. Every /ai/provider mutation runs its
 * legacy write and the reconcile in ONE system transaction, so both stores
 * commit or roll back together. W03 Task 6B replaces this with registry-native
 * remaps and must NOT keep calling the reconcile (it would revert native edits). Partner pinning comes from the route (BILLING_MANAGE +
 * canManagePartnerWidePolicies); every statement below filters on partnerId.
 */
function inRegistryWrite<T>(partnerId: string, write: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const result = await write();
      await reconcilePartnerFromLegacyInTx(partnerId);
      return result;
    }, 'aiProvider.registryWrite'));
}
```

3. `savePartnerLlmKey`: inside the existing `withSystemDbAccessContext(async () => { … })` callback, after the insert-or-update has produced the value it returns, call `await reconcilePartnerFromLegacyInTx(input.partnerId);` before `return`. Both return paths get the call: the `inserted` branch and the update branch.

4. `getPartnerLlmStatus`: replace the select with:

```ts
  // #7600 W02: read the registry. legacy_default_model is the exact compat
  // projection of partner_llm_configs.default_model (null = tracks the
  // deployment default); partner_ai_connections_compat_uq guarantees one row.
  const [row] = await db
    .select({
      keyLast4: partnerAiConnections.keyLast4,
      defaultModel: partnerAiConnections.legacyDefaultModel,
      status: partnerAiConnections.status,
      verifiedAt: partnerAiConnections.verifiedAt,
      lastError: partnerAiConnections.lastError,
      catalogEntryId: partnerAiConnections.catalogEntryId,
    })
    .from(partnerAiConnections)
    .where(and(
      eq(partnerAiConnections.partnerId, partnerId),
      inArray(partnerAiConnections.kind, ['anthropic_byok', 'catalog']),
    ))
    .limit(1);
```

The rest of the function is unchanged. `keyLast4` is `string | null` in both stores.

5. `updatePartnerLlmConfig`: keep the validation as is, and wrap the update:

```ts
  const updated = await inRegistryWrite(input.partnerId, async () => {
    const [row] = await db
      .update(partnerLlmConfigs)
      .set({
        defaultModel: input.defaultModel,
        configVersion: sql`${partnerLlmConfigs.configVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(partnerLlmConfigs.partnerId, input.partnerId))
      .returning({ configVersion: partnerLlmConfigs.configVersion });
    if (!row) {
      throw new PartnerLlmError('Connect an Anthropic API key before selecting a model.', 409);
    }
    return row;
  });
```

The throw inside the transaction rolls it back, so a 409 still writes nothing. The function then returns `{ defaultModel: input.defaultModel, configVersion: updated.configVersion }` exactly as before.

6. `updatePartnerLlmEndpoint`: wrap each of its two `db.update(partnerLlmConfigs)…returning(…)` blocks (the `catalogEntryId === null` branch and the final selection) in `inRegistryWrite(input.partnerId, async () => { … })`, with the same throw-inside pattern. The initial `existing` read, consent check, snapshot build and probe stay OUTSIDE (no transaction is held across the network probe).

7. `deletePartnerLlmConfig`:

```ts
export async function deletePartnerLlmConfig(partnerId: string): Promise<boolean> {
  return inRegistryWrite(partnerId, async () => {
    const [deleted] = await db
      .delete(partnerLlmConfigs)
      .where(eq(partnerLlmConfigs.partnerId, partnerId))
      .returning({ id: partnerLlmConfigs.id });
    return deleted !== undefined;
  });
}
```

The reconcile then sees no legacy row. It re-points every surface to platform offerings, rebinds agents and live sessions, and removes the connection (Task 12, "deleting the legacy config…").

- [ ] **Step 4: Append the real-Postgres facade round trip**

Append to `aiModelRegistryReconcile.integration.test.ts` (import `deletePartnerLlmConfig`, `getPartnerLlmStatus`, `updatePartnerLlmConfig` from `../../services/partnerLlmConfig`, and `markPartnerLlmError` from `../../services/llm/llmConfigResolver`):

```ts
describe.skipIf(!RUN)('/ai/provider facade on the registry (#7600 W02)', () => {
  it('PATCH → GET reflects the new pin from the registry, and every partner-default surface moves with it', async () => {
    const partner = await createPartner();
    await createOrganization({ partnerId: partner.id });
    const configId = await seedLegacyConfig(partner.id);
    await reconcilePartnerFromLegacy(partner.id);
    expect(await withSystemDbAccessContext(() => getPartnerLlmStatus(partner.id))).toMatchObject({ configured: true, defaultModel: null });

    await updatePartnerLlmConfig({ partnerId: partner.id, defaultModel: 'claude-haiku-4-5' });
    expect(await withSystemDbAccessContext(() => getPartnerLlmStatus(partner.id))).toMatchObject({ defaultModel: 'claude-haiku-4-5' });
    const [chat] = await adminSql`
      SELECT m.model_id, m.connection_id FROM ai_model_assignments a JOIN partner_ai_models m ON m.id = a.default_offering_id
       WHERE a.partner_id = ${partner.id} AND a.org_id IS NULL AND a.surface = 'chat'`;
    expect(chat).toEqual({ model_id: 'claude-haiku-4-5', connection_id: configId });

    await updatePartnerLlmConfig({ partnerId: partner.id, defaultModel: null });
    expect(await withSystemDbAccessContext(() => getPartnerLlmStatus(partner.id))).toMatchObject({ defaultModel: null });
  });

  it('GET reads the registry (a registry-only change is what GET returns)', async () => {
    const partner = await createPartner();
    const configId = await seedLegacyConfig(partner.id);
    await reconcilePartnerFromLegacy(partner.id);
    await adminSql`UPDATE partner_ai_connections SET key_last4 = 'zzzz' WHERE id = ${configId}`;
    expect((await withSystemDbAccessContext(() => getPartnerLlmStatus(partner.id))).keyLast4).toBe('zzzz');
  });

  it('a runtime credential failure (markPartnerLlmError) shows as error on GET through the mirror trigger', async () => {
    const partner = await createPartner();
    const configId = await seedLegacyConfig(partner.id);
    await reconcilePartnerFromLegacy(partner.id);
    expect(await markPartnerLlmError({ configId, configVersion: 1, reason: 'auth_rejected' })).toBe(true);
    expect(await withSystemDbAccessContext(() => getPartnerLlmStatus(partner.id))).toMatchObject({ status: 'error', lastError: 'auth_rejected' });
  });

  it('DELETE → GET reports the platform and the registry holds no connection', async () => {
    const partner = await createPartner();
    await createOrganization({ partnerId: partner.id });
    await seedLegacyConfig(partner.id);
    await reconcilePartnerFromLegacy(partner.id);
    expect(await deletePartnerLlmConfig(partner.id)).toBe(true);
    expect(await withSystemDbAccessContext(() => getPartnerLlmStatus(partner.id))).toMatchObject({ configured: false, status: 'platform' });
    expect(await adminSql`SELECT 1 FROM partner_ai_connections WHERE partner_id = ${partner.id}`).toHaveLength(0);
  });

  it('a 409 (no key yet) writes nothing to either store', async () => {
    const partner = await createPartner();
    await expect(updatePartnerLlmConfig({ partnerId: partner.id, defaultModel: 'claude-haiku-4-5' })).rejects.toMatchObject({ status: 409 });
    expect(await adminSql`SELECT 1 FROM ai_model_assignments WHERE offering_partner_id = ${partner.id}`).toHaveLength(0);
  });
});
```

- [ ] **Step 5: Run everything that touches the provider path, with the route test unmodified**

```bash
cd apps/api && git diff --stat -- src/routes/aiProvider.test.ts   # must print nothing
cd apps/api && npx vitest run src/routes/aiProvider.test.ts src/routes/aiProvider.registry.test.ts src/services/partnerLlmConfig.test.ts src/services/llm/llmConfigResolver.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/aiModelRegistryReconcile.integration.test.ts \
  src/__tests__/integration/llmCatalogSelection.integration.test.ts \
  src/__tests__/integration/partnerLlmConfigsPartnerRls.integration.test.ts \
  src/__tests__/integration/partnerLlmByokBilling.integration.test.ts
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

Expected:
- The diff is empty for `aiProvider.test.ts`, and that suite passes unmodified.
- The existing legacy-routing integration suites pass. They seed `partner_llm_configs` directly and route through the unchanged resolver. Their legacy UPDATEs now also fire the mirror trigger, which finds no connection row unless one was reconciled, and that is harmless.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/partnerLlmConfig.ts apps/api/src/services/partnerLlmConfig.test.ts \
  apps/api/src/routes/aiProvider.registry.test.ts \
  apps/api/src/__tests__/integration/aiModelRegistryReconcile.integration.test.ts
git commit -m "feat(ai): serve /ai/provider from the model registry with atomic legacy + registry writes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 14: `invocationLedger.ts` + the `legacyCostEvents` bridge — `recordInvocation`, shadow pricing, diff log, boot registration (unit + integration)

**Files:**
- Create: `apps/api/src/services/aiModels/legacyCostEvents.ts`
- Create: `apps/api/src/services/aiModels/legacyCostEvents.test.ts`
- Create: `apps/api/src/services/aiModels/invocationLedger.ts`
- Create: `apps/api/src/services/aiModels/invocationLedger.test.ts`
- Create: `apps/api/src/services/aiModels/ledgerShadowBoot.contract.test.ts`
- Modify: `apps/api/src/index.ts` (call `registerInvocationLedgerShadow()` in `bootstrap()` before `serve()`)
- Modify: `apps/api/src/worker.ts` (dynamic import + call in `main()`), `apps/api/src/worker.boot.test.ts` (mock + assertion)
- Modify: `apps/api/src/services/aiModels/index.ts` (append exports)
- Modify: `apps/api/src/__tests__/integration/aiInvocationsAppendOnly.integration.test.ts` (append)

**Interfaces:**
- Consumes:
  - `priceInvocation`, `RateSnapshot`, `TokenComponents` (W01 `pricing.ts`); `getPlatformModelByModelId`, `PlatformModel` (W01 `platformModels.ts`);
  - `getCompatConnection` (Task 7), `findOfferingIdForModel`, `getOffering` (Task 8);
  - `aiInvocations` (Task 5); `runAfterDbContextExit`, `runOutsideDbContext`, `withSystemDbAccessContext` (`db/index.ts`).
- Produces:
  - `recordInvocation(row: NewInvocation): Promise<string>` (index-bound; inserts in the caller's context)
  - `type NewInvocation` (spec §5.5 fields + `ledgerMode` + `legacyCostCents`)
  - Index additions:
    - `type InvocationLedgerContext = { surface: AiSurface; role?: string; userId?: string | null; agentRunId?: string | null; sourceRef?: string | null }`
    - `type LegacyCostEvent` (below)
    - `onLegacyCostRecorded(listener): () => void`, `emitLegacyCostRecorded(event): void` (never throws)
    - `registerInvocationLedgerShadow(): void` (idempotent)
    - `recordShadowInvocation(event: LegacyCostEvent): Promise<'written' | 'skipped_no_context' | 'skipped_zero'>` (needs a held system context)
    - `surfaceFromSession(row: { type: string; clientUserId: string | null; contextSnapshot: unknown }): AiSurface`
    - `buildShadowRateSnapshot(input): RateSnapshot | null`
    - `shadowCostDiff(ledgerCents: number | null, legacyTokenCents: number): { differs: boolean; reason: 'unpriced' | 'price_mismatch' | null; deltaCents: number | null }`
- **Ledger semantics in W02 (shadow):**
  - `funding_source` is the LEGACY billing source of the call.
  - `offering_id` / `connection_id` are the registry rows that legacy destination + model map to. They are NULL when none exists yet: a session created after the last reconcile, or the env OpenAI-compatible path that W06 replaces.
  - `cost_cents` is the registry price via `priceInvocation`, and NULL/NULL when unpriced.
  - `legacy_cost_cents` is the token part of what legacy charged. Additional costs, such as web-search fees, are excluded and logged separately.
  - A call that spent no tokens and cost nothing (a reservation settle-at-zero) is not an invocation and is skipped.

- [ ] **Step 1: Write the failing unit tests**

`apps/api/src/services/aiModels/legacyCostEvents.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetLegacyCostListenersForTests, emitLegacyCostRecorded, onLegacyCostRecorded, type LegacyCostEvent } from './legacyCostEvents';

const event: LegacyCostEvent = {
  orgId: 'org', sessionId: null, model: 'claude-sonnet-5-5', billingSource: 'platform', catalogPricing: null,
  tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, legacyCostCents: 0.007, legacyAdditionalCostCents: 0,
  legacyCostSource: 'model_pricing', sdkReportedCostUsd: null, ledger: { surface: 'catalog_enrichment' },
};

afterEach(() => __resetLegacyCostListenersForTests());

describe('legacyCostEvents (#7600 W02)', () => {
  it('is a no-op with no listener (every existing tracker unit test runs this way)', () => {
    expect(() => emitLegacyCostRecorded(event)).not.toThrow();
  });

  it('delivers to listeners and supports unsubscribe', () => {
    const seen: LegacyCostEvent[] = [];
    const off = onLegacyCostRecorded((e) => seen.push(e));
    emitLegacyCostRecorded(event);
    off();
    emitLegacyCostRecorded(event);
    expect(seen).toEqual([event]);
  });

  it('never throws into the caller, even when a listener does', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    onLegacyCostRecorded(() => { throw new Error('boom'); });
    expect(() => emitLegacyCostRecorded(event)).not.toThrow();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
```

`apps/api/src/services/aiModels/invocationLedger.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
  session: null as null | Record<string, unknown>,
  partnerId: 'partner-1' as string | null,
  compat: null as null | { id: string; configVersion: number },
  offeringId: null as string | null,
  offering: null as null | Record<string, unknown>,
  platform: null as null | Record<string, unknown>,
  scope: 'system' as string | undefined,
  afterExit: [] as Array<{ label: string; work: () => unknown }>,
}));

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn(() => ({ values: vi.fn((v: Record<string, unknown>) => { state.inserted.push(v); return { returning: vi.fn(async () => [{ id: 'inv-1' }]) }; }) })),
    select: vi.fn(() => ({ from: vi.fn((table: { [k: symbol]: unknown }) => ({ where: vi.fn(() => ({ limit: vi.fn(async () => {
      const name = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')] ?? '');
      if (name === 'ai_sessions') return state.session ? [state.session] : [];
      if (name === 'organizations') return state.partnerId ? [{ partnerId: state.partnerId }] : [];
      return [];
    }) })) })) })),
  },
  getCurrentDbAccessContext: () => (state.scope ? { scope: state.scope } : undefined),
  runAfterDbContextExit: (label: string, work: () => unknown) => { state.afterExit.push({ label, work }); },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./connections', () => ({ getCompatConnection: vi.fn(async () => state.compat) }));
vi.mock('./offerings', () => ({
  findOfferingIdForModel: vi.fn(async () => state.offeringId),
  getOffering: vi.fn(async () => state.offering),
}));
vi.mock('./platformModels', () => ({ getPlatformModelByModelId: vi.fn(async () => state.platform) }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { __resetLegacyCostListenersForTests, emitLegacyCostRecorded, type LegacyCostEvent } from './legacyCostEvents';
import {
  buildShadowRateSnapshot,
  recordShadowInvocation,
  registerInvocationLedgerShadow,
  shadowCostDiff,
  surfaceFromSession,
} from './invocationLedger';

const rates = { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 };
const platformRow = { id: 'pm', modelId: 'claude-sonnet-5-5', rates, optionRates: null };

function event(over: Partial<LegacyCostEvent> = {}): LegacyCostEvent {
  return {
    orgId: 'org-1', sessionId: null, model: 'claude-sonnet-5-5', billingSource: 'platform', catalogPricing: null,
    tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, legacyCostCents: 200, legacyAdditionalCostCents: 0,
    legacyCostSource: 'model_pricing', sdkReportedCostUsd: null, ledger: { surface: 'catalog_enrichment' }, ...over,
  };
}

beforeEach(() => {
  state.inserted.length = 0; state.afterExit.length = 0;
  state.session = null; state.partnerId = 'partner-1'; state.compat = null; state.offeringId = null;
  state.offering = null; state.platform = platformRow; state.scope = 'system';
  __resetLegacyCostListenersForTests();
});

describe('surfaceFromSession', () => {
  it.each([
    [{ type: 'script_builder', clientUserId: null, contextSnapshot: null }, 'script_builder'],
    [{ type: 'general', clientUserId: 'cu', contextSnapshot: null }, 'office_chat'],
    [{ type: 'excel_client', clientUserId: null, contextSnapshot: null }, 'office_chat'],
    [{ type: 'general', clientUserId: null, contextSnapshot: { source: 'helper' } }, 'helper'],
    [{ type: 'agent', clientUserId: null, contextSnapshot: null }, 'ai_agents'],
    [{ type: 'topology', clientUserId: null, contextSnapshot: null }, 'chat'],
    [{ type: 'general', clientUserId: null, contextSnapshot: null }, 'chat'],
  ] as const)('%j → %s', (row, surface) => {
    expect(surfaceFromSession(row)).toBe(surface);
  });
});

describe('buildShadowRateSnapshot — never prices platform traffic from a non-platform rate', () => {
  it('catalog traffic uses the revision snapshot', () => {
    expect(buildShadowRateSnapshot({
      funding: 'partner_key',
      catalogPricing: { catalogEntryId: 'e', revisionId: 'r', ...rates },
      platformModel: null, offering: null, linkedPlatformModel: null,
    })).toEqual({ source: 'catalog', standard: rates });
  });
  it('platform traffic uses the platform row, or nothing when it is unpriced', () => {
    expect(buildShadowRateSnapshot({ funding: 'platform', catalogPricing: null, platformModel: platformRow as never, offering: null, linkedPlatformModel: null }))
      .toEqual({ source: 'platform', standard: rates });
    expect(buildShadowRateSnapshot({ funding: 'platform', catalogPricing: null, platformModel: { ...platformRow, rates: null } as never, offering: null, linkedPlatformModel: null }))
      .toBeNull();
  });
  it('partner-key traffic: offering price, then the linked platform row, then nothing', () => {
    const priced = { priceInputCentsPerM: 1, priceOutputCentsPerM: 2, priceCacheReadCentsPerM: 3, priceCacheWriteCentsPerM: 4, platformModelId: 'pm' };
    expect(buildShadowRateSnapshot({ funding: 'partner_key', catalogPricing: null, platformModel: null, offering: priced as never, linkedPlatformModel: platformRow as never }))
      .toEqual({ source: 'offering', standard: { inputCentsPerM: 1, outputCentsPerM: 2, cacheReadCentsPerM: 3, cacheWriteCentsPerM: 4 } });
    const linked = { priceInputCentsPerM: null, priceOutputCentsPerM: null, priceCacheReadCentsPerM: null, priceCacheWriteCentsPerM: null, platformModelId: 'pm' };
    expect(buildShadowRateSnapshot({ funding: 'partner_key', catalogPricing: null, platformModel: null, offering: linked as never, linkedPlatformModel: platformRow as never }))
      .toEqual({ source: 'linked_platform', standard: rates });
    expect(buildShadowRateSnapshot({ funding: 'partner_key', catalogPricing: null, platformModel: platformRow as never, offering: null, linkedPlatformModel: null }))
      .toBeNull();
  });
});

describe('shadowCostDiff', () => {
  it.each([
    [200, 200, false, null],
    [200.004, 200, false, null],
    [200.02, 200, true, 'price_mismatch'],
    [null, 200, true, 'unpriced'],
  ] as const)('ledger %s vs legacy %s', (ledger, legacy, differs, reason) => {
    expect(shadowCostDiff(ledger, legacy)).toMatchObject({ differs, reason });
  });
});

describe('recordShadowInvocation', () => {
  it('writes a shadow row priced by the registry, carrying the legacy cost', async () => {
    state.offeringId = 'off-1';
    await expect(recordShadowInvocation(event())).resolves.toBe('written');
    expect(state.inserted[0]).toMatchObject({
      orgId: 'org-1', surface: 'catalog_enrichment', fundingSource: 'platform', offeringId: 'off-1', connectionId: null,
      requestedModel: 'claude-sonnet-5-5', servedModel: 'claude-sonnet-5-5', ledgerMode: 'shadow', legacyCostCents: 200,
      inputTokens: 1_000_000, rateSnapshot: { source: 'platform', standard: rates },
    });
    expect(Number(state.inserted[0]!.costCents)).toBeCloseTo(200, 6);
  });

  it('derives surface and user from the session row for session-bound calls', async () => {
    state.session = { type: 'script_builder', clientUserId: null, contextSnapshot: null, userId: 'user-9', model: 'claude-sonnet-5-5' };
    await recordShadowInvocation(event({ sessionId: 'sess-1', ledger: null }));
    expect(state.inserted[0]).toMatchObject({ surface: 'script_builder', userId: 'user-9', sessionId: 'sess-1' });
  });

  it('a sessionless call without a ledger context is skipped and warned once, never guessed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(recordShadowInvocation(event({ ledger: null }))).resolves.toBe('skipped_no_context');
    expect(state.inserted).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ai_invocation_ledger_context_missing'));
    warn.mockRestore();
  });

  it('skips a zero-token, zero-cost settle (not an invocation)', async () => {
    await expect(recordShadowInvocation(event({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, legacyCostCents: 0 }))).resolves.toBe('skipped_zero');
  });

  it('logs a structured diff when the registry price disagrees, and records NULL cost when unpriced', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    state.platform = { ...platformRow, rates: null };
    await recordShadowInvocation(event());
    expect(state.inserted[0]).toMatchObject({ costCents: null, rateSnapshot: null, legacyCostCents: 200 });
    const logged = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('ai_invocation_shadow_cost_diff'));
    expect(JSON.parse(logged!)).toMatchObject({ event: 'ai_invocation_shadow_cost_diff', reason: 'unpriced', surface: 'catalog_enrichment', legacyCents: 200 });
    warn.mockRestore();
  });

  it('refuses to run outside a system context', async () => {
    state.scope = 'organization';
    await expect(recordShadowInvocation(event())).rejects.toThrow(/system DB context/);
  });
});

describe('registerInvocationLedgerShadow', () => {
  it('defers the write until the caller\'s DB context exits, and is idempotent', async () => {
    registerInvocationLedgerShadow();
    registerInvocationLedgerShadow();
    emitLegacyCostRecorded(event());
    expect(state.afterExit.map((t) => t.label)).toEqual(['aiInvocationLedger.shadow']);
    expect(state.inserted).toEqual([]);
    await state.afterExit[0]!.work();
    expect(state.inserted).toHaveLength(1);
  });

  it('a failing shadow write is swallowed and logged — billing callers never see it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerInvocationLedgerShadow();
    state.partnerId = null; // org lookup fails → the write throws inside the deferred task
    emitLegacyCostRecorded(event());
    await expect(Promise.resolve(state.afterExit[0]!.work())).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('ai_invocation_shadow_failed'), expect.anything());
    error.mockRestore();
  });
});
```

(`vi.mock('./platformModels', …)` targets W01's module. If W01's lookup lives elsewhere, Task 0 recorded where; adjust that one specifier.)

`apps/api/src/services/aiModels/ledgerShadowBoot.contract.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (rel: string) => readFileSync(join(__dirname, '../..', rel), 'utf8');

describe('invocation ledger shadow is registered in every process that records AI cost (#7600 W02)', () => {
  it.each(['index.ts', 'worker.ts'])('%s registers the listener', (file) => {
    expect(src(file)).toMatch(/registerInvocationLedgerShadow\(\)/);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/legacyCostEvents.test.ts src/services/aiModels/invocationLedger.test.ts src/services/aiModels/ledgerShadowBoot.contract.test.ts`
Expected: FAIL (modules missing; neither entrypoint registers).

- [ ] **Step 3: Implement the bridge**

`apps/api/src/services/aiModels/legacyCostEvents.ts`:

```ts
/**
 * Dependency-free bridge from the legacy cost tracker to the invocation
 * ledger (#7600 W02). aiCostTracker emits AFTER it has computed the legacy
 * cost; listeners are registered only at process boot
 * (registerInvocationLedgerShadow), so every unit test that exercises the
 * tracker without booting sees exactly today's behaviour. emit never throws.
 * W03 deletes this file when the ledger becomes the cost path.
 */
import type { AiSurface } from '@breeze/shared';
import type { AiBillingSource, CatalogPricingSnapshot } from '../aiCostTracker';

export interface InvocationLedgerContext {
  surface: AiSurface;
  role?: string;
  userId?: string | null;
  agentRunId?: string | null;
  sourceRef?: string | null;
}

export interface LegacyCostEvent {
  orgId: string;
  sessionId: string | null;
  /** null when the tracker priced from the SDK and never needed the id; the listener reads the session's model. */
  model: string | null;
  billingSource: AiBillingSource;
  catalogPricing: CatalogPricingSnapshot | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** The token part of the legacy cost, in cents. */
  legacyCostCents: number;
  /** Non-token legacy cost on the same record (e.g. web-search fees), cents. */
  legacyAdditionalCostCents: number;
  legacyCostSource: 'sdk' | 'model_pricing' | 'catalog' | 'precomputed' | 'openai_env';
  sdkReportedCostUsd: number | null;
  ledger: InvocationLedgerContext | null;
}

type Listener = (event: LegacyCostEvent) => void;
const listeners = new Set<Listener>();

export function onLegacyCostRecorded(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitLegacyCostRecorded(event: LegacyCostEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error('[ai-ledger] legacy cost listener threw (ignored; billing unaffected):', error);
    }
  }
}

export function __resetLegacyCostListenersForTests(): void {
  listeners.clear();
}
```

- [ ] **Step 4: Implement the ledger**

`apps/api/src/services/aiModels/invocationLedger.ts`:

```ts
/**
 * The invocation ledger (#7600, spec §5.5). recordInvocation inserts one
 * append-only row in the caller's context. In W02 the only producer is the
 * SHADOW listener below: it re-prices every legacy cost record with the
 * registry (priceInvocation) and logs a structured diff — it never feeds
 * billing, budgets or credits. W03 makes recordInvocation the cost path.
 */
import { eq } from 'drizzle-orm';
import type { AiSurface, ModelRates, OfferingOptions } from '@breeze/shared';
import { db, getCurrentDbAccessContext, runAfterDbContextExit, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiInvocations, aiSessions, organizations } from '../../db/schema';
import { captureException } from '../sentry';
import { getCompatConnection } from './connections';
import { onLegacyCostRecorded, type LegacyCostEvent } from './legacyCostEvents';
import { findOfferingIdForModel, getOffering, type Offering } from './offerings';
import { getPlatformModelByModelId, type PlatformModel } from './platformModels';
import { platformRateSnapshot, priceInvocation, type RateSnapshot, type TokenComponents } from './pricing';

export interface NewInvocation {
  orgId: string;
  surface: AiSurface;
  role?: string;
  userId?: string | null;
  sessionId?: string | null;
  agentRunId?: string | null;
  sourceRef?: string | null;
  offeringId?: string | null;
  connectionId?: string | null;
  fundingSource: 'platform' | 'partner_key';
  requestedModel: string;
  servedModel: string;
  optionsSent?: OfferingOptions;
  thinkingModeSent?: 'adaptive' | 'budget' | 'none' | 'unknown' | null;
  inferenceGeoSent?: string | null;
  stopReason?: string | null;
  refusalCategory?: string | null;
  fallbackUsed?: boolean;
  catalogRevisionId?: string | null;
  connectionConfigVersion?: number | null;
  tokens: TokenComponents;
  rateSnapshot: RateSnapshot | null;
  costCents: number | null;
  chargeable?: boolean;
  sdkReportedCostUsd?: number | null;
  ledgerMode: 'shadow' | 'authoritative';
  legacyCostCents?: number | null;
}

export async function recordInvocation(row: NewInvocation): Promise<string> {
  const [inserted] = await db.insert(aiInvocations).values({
    orgId: row.orgId,
    surface: row.surface,
    role: row.role ?? 'default',
    userId: row.userId ?? null,
    sessionId: row.sessionId ?? null,
    agentRunId: row.agentRunId ?? null,
    sourceRef: row.sourceRef ?? null,
    offeringId: row.offeringId ?? null,
    connectionId: row.connectionId ?? null,
    fundingSource: row.fundingSource,
    requestedModel: row.requestedModel,
    servedModel: row.servedModel,
    optionsSent: (row.optionsSent ?? {}) as Record<string, unknown>,
    thinkingModeSent: row.thinkingModeSent ?? null,
    inferenceGeoSent: row.inferenceGeoSent ?? null,
    stopReason: row.stopReason ?? null,
    refusalCategory: row.refusalCategory ?? null,
    fallbackUsed: row.fallbackUsed ?? false,
    catalogRevisionId: row.catalogRevisionId ?? null,
    connectionConfigVersion: row.connectionConfigVersion ?? null,
    inputTokens: row.tokens.input,
    outputTokens: row.tokens.output,
    cacheReadTokens: row.tokens.cacheRead,
    cacheWriteTokens: row.tokens.cacheWrite,
    rateSnapshot: row.rateSnapshot as unknown as Record<string, unknown> | null,
    costCents: row.costCents,
    chargeable: row.chargeable ?? false,
    sdkReportedCostUsd: row.sdkReportedCostUsd ?? null,
    ledgerMode: row.ledgerMode,
    legacyCostCents: row.ledgerMode === 'shadow' ? row.legacyCostCents ?? null : null,
  }).returning({ id: aiInvocations.id });
  return inserted!.id;
}

export function surfaceFromSession(row: { type: string; clientUserId: string | null; contextSnapshot: unknown }): AiSurface {
  if (row.type === 'script_builder') return 'script_builder';
  if (row.clientUserId !== null || row.type.endsWith('_client')) return 'office_chat';
  if (row.type === 'agent') return 'ai_agents';
  const snapshot = row.contextSnapshot as { source?: unknown } | null;
  if (snapshot && snapshot.source === 'helper') return 'helper';
  return 'chat';
}

const ownRates = (o: Pick<Offering, 'priceInputCentsPerM' | 'priceOutputCentsPerM' | 'priceCacheReadCentsPerM' | 'priceCacheWriteCentsPerM'>): ModelRates | null =>
  [o.priceInputCentsPerM, o.priceOutputCentsPerM, o.priceCacheReadCentsPerM, o.priceCacheWriteCentsPerM].every((v) => v !== null && v !== undefined)
    ? { inputCentsPerM: Number(o.priceInputCentsPerM), outputCentsPerM: Number(o.priceOutputCentsPerM), cacheReadCentsPerM: Number(o.priceCacheReadCentsPerM), cacheWriteCentsPerM: Number(o.priceCacheWriteCentsPerM) }
    : null;

/** Spec §8 precedence. Platform traffic is priced ONLY from the platform row (invariant 5). */
export function buildShadowRateSnapshot(input: {
  funding: 'platform' | 'partner_key';
  catalogPricing: LegacyCostEvent['catalogPricing'];
  platformModel: Pick<PlatformModel, 'rates' | 'optionRates'> | null;
  offering: Pick<Offering, 'priceInputCentsPerM' | 'priceOutputCentsPerM' | 'priceCacheReadCentsPerM' | 'priceCacheWriteCentsPerM' | 'platformModelId'> | null;
  linkedPlatformModel: Pick<PlatformModel, 'rates' | 'optionRates'> | null;
}): RateSnapshot | null {
  if (input.catalogPricing) {
    const { inputCentsPerM, outputCentsPerM, cacheReadCentsPerM, cacheWriteCentsPerM } = input.catalogPricing;
    return { source: 'catalog', standard: { inputCentsPerM, outputCentsPerM, cacheReadCentsPerM, cacheWriteCentsPerM } };
  }
  if (input.funding === 'platform') {
    return input.platformModel ? platformRateSnapshot(input.platformModel) : null;
  }
  if (input.offering) {
    const own = ownRates(input.offering);
    if (own) return { source: 'offering', standard: own };
    const linked = input.linkedPlatformModel ? platformRateSnapshot(input.linkedPlatformModel) : null;
    if (linked) return { ...linked, source: 'linked_platform' };
  }
  return null;
}

export function shadowCostDiff(ledgerCents: number | null, legacyTokenCents: number): { differs: boolean; reason: 'unpriced' | 'price_mismatch' | null; deltaCents: number | null } {
  if (ledgerCents === null) return { differs: true, reason: 'unpriced', deltaCents: null };
  const delta = Math.round((ledgerCents - legacyTokenCents) * 100) / 100;
  return Math.abs(delta) >= 0.01 ? { differs: true, reason: 'price_mismatch', deltaCents: delta } : { differs: false, reason: null, deltaCents: delta };
}

const warnedMissingContext = new Set<string>();

export async function recordShadowInvocation(event: LegacyCostEvent): Promise<'written' | 'skipped_no_context' | 'skipped_zero'> {
  if (getCurrentDbAccessContext()?.scope !== 'system') throw new Error('recordShadowInvocation requires a held system DB context');
  const t = event.tokens;
  if (t.input + t.output + t.cacheRead + t.cacheWrite === 0 && event.legacyCostCents === 0) return 'skipped_zero';

  let surface = event.ledger?.surface ?? null;
  let userId = event.ledger?.userId ?? null;
  let model = event.model;
  if (event.sessionId) {
    const [session] = await db
      .select({ type: aiSessions.type, clientUserId: aiSessions.clientUserId, contextSnapshot: aiSessions.contextSnapshot, userId: aiSessions.userId, model: aiSessions.model })
      .from(aiSessions).where(eq(aiSessions.id, event.sessionId)).limit(1);
    if (session) {
      surface ??= surfaceFromSession(session);
      userId ??= session.userId ?? null;
      model ??= session.model;
    }
  }
  if (!surface || !model) {
    const key = `${surface ?? 'no-surface'}:${event.legacyCostSource}`;
    if (!warnedMissingContext.has(key)) {
      warnedMissingContext.add(key);
      console.warn(`[ai-ledger] ai_invocation_ledger_context_missing ${JSON.stringify({ orgId: event.orgId, source: event.legacyCostSource })}`);
    }
    return 'skipped_no_context';
  }

  const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, event.orgId)).limit(1);
  if (!org?.partnerId) throw new Error(`organization ${event.orgId} has no partner`);

  const connection = event.billingSource === 'partner_key' ? await getCompatConnection(org.partnerId) : null;
  const offeringId = event.billingSource === 'platform' || connection
    ? await findOfferingIdForModel({ partnerId: org.partnerId, connectionId: connection?.id ?? null, modelId: model })
    : null;
  const offering = offeringId && event.billingSource === 'partner_key' ? await getOffering(offeringId) : null;
  const platformModel = event.billingSource === 'platform' ? await getPlatformModelByModelId(model) : null;
  const linkedPlatformModel = offering?.platformModelId ? await getPlatformModelByModelId(model) : null;

  const rateSnapshot = buildShadowRateSnapshot({ funding: event.billingSource, catalogPricing: event.catalogPricing, platformModel, offering, linkedPlatformModel });
  const costCents = rateSnapshot ? priceInvocation(rateSnapshot, t, {}) : null;

  await recordInvocation({
    orgId: event.orgId,
    surface,
    role: event.ledger?.role,
    userId,
    sessionId: event.sessionId,
    agentRunId: event.ledger?.agentRunId ?? null,
    sourceRef: event.ledger?.sourceRef ?? null,
    offeringId,
    connectionId: connection?.id ?? null,
    fundingSource: event.billingSource,
    requestedModel: model,
    servedModel: model,
    catalogRevisionId: event.catalogPricing?.revisionId ?? null,
    connectionConfigVersion: connection?.configVersion ?? null,
    tokens: t,
    rateSnapshot,
    costCents,
    sdkReportedCostUsd: event.sdkReportedCostUsd,
    ledgerMode: 'shadow',
    legacyCostCents: event.legacyCostCents,
  });

  const diff = shadowCostDiff(costCents, event.legacyCostCents);
  // The env OpenAI-compatible path (MCP_LLM_*) has no registry offering until
  // W06, so every one of its rows is unpriced by design: record it, don't log it.
  if (diff.differs && event.legacyCostSource !== 'openai_env') {
    console.warn(JSON.stringify({
      event: 'ai_invocation_shadow_cost_diff',
      reason: diff.reason,
      surface,
      orgId: event.orgId,
      model,
      fundingSource: event.billingSource,
      offeringId,
      rateSource: rateSnapshot?.source ?? null,
      legacySource: event.legacyCostSource,
      legacyCents: event.legacyCostCents,
      legacyAdditionalCents: event.legacyAdditionalCostCents,
      ledgerCents: costCents,
      deltaCents: diff.deltaCents,
    }));
  }
  return 'written';
}

let registered = false;

/** Call once per process at boot (API index.ts, worker.ts). Idempotent. */
export function registerInvocationLedgerShadow(): void {
  if (registered) return;
  registered = true;
  onLegacyCostRecorded((event) => {
    runAfterDbContextExit('aiInvocationLedger.shadow', async () => {
      try {
        await runOutsideDbContext(() => withSystemDbAccessContext(() => recordShadowInvocation(event), 'aiInvocationLedger.shadow'));
      } catch (error) {
        console.error('[ai-ledger] ai_invocation_shadow_failed (billing unaffected)', { orgId: event.orgId, error: error instanceof Error ? error.message : String(error) });
        captureException(error, undefined, { area: 'ai_invocation_shadow' });
      }
    });
  });
}

export function __resetInvocationLedgerShadowForTests(): void {
  registered = false;
}
```

Notes for the implementer:
- `getPlatformModelByModelId(model)` for `linkedPlatformModel` assumes the BYOK model id equals the linked platform row's `model_id`. Task 10 links only on an exact match, so it does. If W01's lookup is by row id instead, call that.
- In the test's `beforeEach`, also call `__resetInvocationLedgerShadowForTests()` (import it from `./invocationLedger`) so the idempotency test starts clean.

Append to the aiModels `index.ts`:

```ts
export * from './legacyCostEvents';
export { recordInvocation, registerInvocationLedgerShadow, recordShadowInvocation, surfaceFromSession, buildShadowRateSnapshot, shadowCostDiff, type NewInvocation } from './invocationLedger';
```

- [ ] **Step 5: Register at boot in both entrypoints**

`apps/api/src/index.ts`: import `registerInvocationLedgerShadow` from `./services/aiModels/invocationLedger`, and call it in `bootstrap()` before `serve()`, next to the other synchronous wiring:

```ts
  // AI model registry W02 (#7600): shadow every legacy AI cost record into the
  // invocation ledger (after the caller's transaction exits; never affects billing).
  registerInvocationLedgerShadow();
```

`apps/api/src/worker.ts`: in `main()`'s dynamic-import block, add:

```ts
  // AI model registry W02 (#7600): agents and the script reviewer record AI
  // cost in this process; shadow those records into the invocation ledger.
  const { registerInvocationLedgerShadow } = await import('./services/aiModels/invocationLedger');
  registerInvocationLedgerShadow();
```

`apps/api/src/worker.boot.test.ts`: add a `vi.mock('./services/aiModels/invocationLedger', () => ({ registerInvocationLedgerShadow: mocks.registerInvocationLedgerShadow }))` with a hoisted `vi.fn()` in the file's `mocks` object. In the existing successful-boot test, assert `expect(mocks.registerInvocationLedgerShadow).toHaveBeenCalledTimes(1)`.

- [ ] **Step 6: Append the real-Postgres check**

Append to `aiInvocationsAppendOnly.integration.test.ts` (import `recordShadowInvocation` and `reconcilePartnerFromLegacy`):

```ts
describe.skipIf(!RUN)('shadow ledger write (#7600 W02)', () => {
  it('records a platform call against the reconciled platform offering and passes the provenance guard', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await reconcilePartnerFromLegacy(partner.id, {
      defaultModel: 'claude-sonnet-5-5', reviewerModel: 'claude-sonnet-5-5', extensionModel: 'claude-haiku-4-5',
      legacyRates: () => ({ inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 }),
    });
    const outcome = await withSystemDbAccessContext(() => recordShadowInvocation({
      orgId: org.id, sessionId: null, model: 'claude-sonnet-5-5', billingSource: 'platform', catalogPricing: null,
      tokens: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 }, legacyCostCents: 0.3, legacyAdditionalCostCents: 0,
      legacyCostSource: 'model_pricing', sdkReportedCostUsd: null, ledger: { surface: 'catalog_enrichment' },
    }));
    expect(outcome).toBe('written');
    const [row] = await adminSql`SELECT surface, funding_source, offering_id, ledger_mode, legacy_cost_cents FROM ai_invocations WHERE org_id = ${org.id}`;
    expect(row).toMatchObject({ surface: 'catalog_enrichment', funding_source: 'platform', ledger_mode: 'shadow' });
    expect(row!.offering_id).not.toBeNull();
  });
});
```

(The W01 seed must contain `claude-sonnet-5-5`. If Task 0 found otherwise, use any model id the seed has.)

- [ ] **Step 7: Run unit + boot + closure contracts + integration**

```bash
cd apps/api && npx vitest run src/services/aiModels/legacyCostEvents.test.ts src/services/aiModels/invocationLedger.test.ts \
  src/services/aiModels/ledgerShadowBoot.contract.test.ts src/worker.boot.test.ts src/services/workerEntrypointClosure.contract.test.ts src/index
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiInvocationsAppendOnly.integration.test.ts
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

Expected: PASS. If `workerEntrypointClosure.contract.test.ts` reports a new `routes/` reach through the ledger's imports, move `invocationLedger.ts`'s static imports of `./offerings` / `./connections` into dynamic imports inside `recordShadowInvocation`. Do not allowlist the reach.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/aiModels/legacyCostEvents.ts apps/api/src/services/aiModels/legacyCostEvents.test.ts \
  apps/api/src/services/aiModels/invocationLedger.ts apps/api/src/services/aiModels/invocationLedger.test.ts \
  apps/api/src/services/aiModels/ledgerShadowBoot.contract.test.ts apps/api/src/services/aiModels/index.ts \
  apps/api/src/index.ts apps/api/src/worker.ts apps/api/src/worker.boot.test.ts \
  apps/api/src/__tests__/integration/aiInvocationsAppendOnly.integration.test.ts
git commit -m "feat(ai): invocation ledger with a shadow listener that re-prices legacy cost records

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 15: Emit a legacy cost event from every cost-recording path, with a ledger context at every sessionless caller (unit + contract)

Every existing cost record now also feeds the shadow ledger. The tracker computes and writes exactly what it did before. The emit is a synchronous, never-throwing call placed after the cost is known.

| Path | Emitted from | Ledger context |
|---|---|---|
| chat, helper, script builder, office chat, topology (Agent SDK sessions) | `recordUsageFromSdkResult` (`streamingSessionManager.ts` ×3 call sites unchanged) | none: surface and user derive from the session row |
| ticket draft (`routes/ai.ts` ×2) | `recordUsage(sessionId, …)` | `{ surface: 'chat', sourceRef: 'ticket_draft', userId }` |
| script reviewer (`scriptProposals/reviewer.ts` ×3 + `settleAtZero`) | `recordUsage(null, …)` | `{ surface: 'script_reviewer' }` (settle-at-zero is skipped as zero) |
| office ticket (`routes/officeAddin/tickets.ts` `recordDraftUsage`) | `recordUsage(null, …)` | `{ surface: 'office_ticket', userId }` |
| catalog enrichment / polish (`catalogEnrichmentService.ts` ×3) | `recordUsage(null, …)` | `{ surface: 'catalog_enrichment', userId }` |
| extension AI (`extensionAi.ts`) | `recordUsage(null, …)` | `{ surface: 'extension_content' }` |
| AI agents (`aiAgents/runLoop.ts`) | `recordSessionlessSdkUsage` | `{ surface: 'ai_agents', agentRunId: run.id }` |
| env OpenAI-compatible chat (`llm/openaiSessionManager.ts` settle) | direct `emitLegacyCostRecorded` | none (session-derived); `legacyCostSource: 'openai_env'` |
| patch test runner | — | **no cost record exists** ("DELIBERATELY UNMETERED", #5557, `aiPatchTestRunner.ts`), so there is nothing to shadow. It stays unmetered after W03 too: it has no `org_id`, so no ledger row is possible |

`recordOpenAIUsage` has no callers (dead code) and is left alone. `recordClientUsage` (the per-client-user Office ledger) is not a model call of its own: the same turn is already recorded by `recordUsageFromSdkResult`, so it gets no emit.

**Files:**
- Modify: `apps/api/src/services/aiCostTracker.ts` (`recordUsage`, `recordUsageFromSdkResult`, `recordSessionlessSdkUsage`)
- Modify: `apps/api/src/services/aiCostTracker.test.ts` (append)
- Modify: `apps/api/src/routes/ai.ts`, `apps/api/src/routes/officeAddin/tickets.ts`, `apps/api/src/services/scriptProposals/reviewer.ts`, `apps/api/src/services/catalogEnrichmentService.ts`, `apps/api/src/services/extensionAi.ts`, `apps/api/src/services/aiAgents/runLoop.ts`, `apps/api/src/services/llm/openaiSessionManager.ts`
- Modify: `apps/api/src/services/aiModels/ledgerShadowBoot.contract.test.ts` (append the call-site contract)

**Interfaces:**
- Consumes: `emitLegacyCostRecorded`, `type InvocationLedgerContext`, `type LegacyCostEvent` (Task 14).
- Produces: new optional trailing parameters. Existing callers compile unchanged; the contract test makes the new argument mandatory in practice.
  - `recordUsage(sessionId, orgId, model, inputTokens, outputTokens, isToolExecution, billingSource, catalogPricing?, budgetReservationId?, additionalCostCents = 0, ledger?: InvocationLedgerContext)`
  - `recordSessionlessSdkUsage(orgId, result, billingSource, budgetReservationId?, ledger?: InvocationLedgerContext)`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/aiCostTracker.test.ts` (reusing its `setupDbMocks` helper and the module mocks already at the top):

```ts
import { afterEach as afterEachW02 } from 'vitest';
import { __resetLegacyCostListenersForTests, onLegacyCostRecorded, type LegacyCostEvent } from './aiModels/legacyCostEvents';

const withoutClock = (value: unknown) =>
  JSON.parse(JSON.stringify(value, (key, v) => (key === 'updatedAt' || key === 'lastActivityAt' ? undefined : v)));

describe('legacy cost events (#7600 W02) — billing is byte-identical with or without the ledger listener', () => {
  afterEachW02(() => __resetLegacyCostListenersForTests());

  it('recordUsage: same writes with a listener; one event carrying the token cost and the ledger context', async () => {
    const call = () => recordUsage('sess-1', 'org-1', 'claude-sonnet-4-6', 1_000_000, 0, false, 'platform', undefined, undefined, 5, { surface: 'chat', sourceRef: 'ticket_draft' });
    const without = setupDbMocks(null);
    await call();
    const events: LegacyCostEvent[] = [];
    onLegacyCostRecorded((e) => events.push(e));
    const withListener = setupDbMocks(null);
    await call();
    expect(withoutClock(withListener)).toEqual(withoutClock(without));
    expect(events).toEqual([expect.objectContaining({
      orgId: 'org-1', sessionId: 'sess-1', model: 'claude-sonnet-4-6', billingSource: 'platform',
      legacyCostCents: 300, legacyAdditionalCostCents: 5, legacyCostSource: 'model_pricing',
      tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      ledger: { surface: 'chat', sourceRef: 'ticket_draft' },
    })]);
  });

  it('a throwing listener cannot fail or alter recordUsage', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    onLegacyCostRecorded(() => { throw new Error('ledger down'); });
    const captured = setupDbMocks(null);
    await expect(recordUsage('sess-2', 'org-1', 'claude-sonnet-4-6', 1_000_000, 1_000_000, false, 'platform')).resolves.toBeUndefined();
    expect(recordedCostCents(captured.sessionSet)).toBe(1800);
    error.mockRestore();
  });

  it.each([
    ['sdk', { total_cost_usd: 0.02, model: 'claude-sonnet-4-6' }, undefined, 'sdk', 2],
    ['model_pricing fallback', { total_cost_usd: 0, model: 'claude-sonnet-4-6' }, undefined, 'model_pricing', 300],
    ['catalog', { total_cost_usd: 0.02, model: 'claude-sonnet-4-6' }, { catalogEntryId: 'c', revisionId: 'r', inputCentsPerM: 100, outputCentsPerM: 100, cacheReadCentsPerM: 10, cacheWriteCentsPerM: 125 }, 'catalog', 100],
  ] as const)('recordUsageFromSdkResult reports its legacy cost source: %s', async (_l, sdk, catalogPricing, source, cents) => {
    const events: LegacyCostEvent[] = [];
    onLegacyCostRecorded((e) => events.push(e));
    setupDbMocks(null);
    await recordUsageFromSdkResult('sess-3', 'org-1', {
      total_cost_usd: sdk.total_cost_usd, model: sdk.model, num_turns: 1,
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    }, 'platform', catalogPricing as never);
    expect(events[0]).toMatchObject({ legacyCostSource: source, legacyCostCents: cents, sdkReportedCostUsd: sdk.total_cost_usd, ledger: null });
  });

  it('recordSessionlessSdkUsage forwards the agent ledger context', async () => {
    const events: LegacyCostEvent[] = [];
    onLegacyCostRecorded((e) => events.push(e));
    setupDbMocks(null);
    await recordSessionlessSdkUsage('org-1', {
      costCents: 12, usage: { input_tokens: 10, output_tokens: 10 }, numTurns: 1, model: 'claude-sonnet-4-6',
    }, 'platform', undefined, { surface: 'ai_agents', agentRunId: 'run-1' });
    expect(events[0]).toMatchObject({ legacyCostSource: 'precomputed', legacyCostCents: 12, ledger: { surface: 'ai_agents', agentRunId: 'run-1' } });
  });
});
```

If `setupDbMocks` returns a fresh capture object per call (as its use above implies), comparing two captures is a straight `toEqual`. If it accumulates into module state, reset that state between the two runs the way the file's own `beforeEach` does. Check whether `recordUsageFromSdkResult` / `recordSessionlessSdkUsage` call `deductBillingCredits` (HTTP); use the file's `enableBillingService()` stub where its other tests of those functions do.

Append to `apps/api/src/services/aiModels/ledgerShadowBoot.contract.test.ts`:

```ts
import { readdirSync, statSync } from 'node:fs';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });
}

/** Top-level argument count of the call starting at `open` (index of its '('). */
function argCount(text: string, open: number): number {
  let depth = 0; let args = 1; let sawToken = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) { depth--; if (depth === 0) return sawToken ? args : 0; }
    else if (ch === ',' && depth === 1) args++;
    else if (depth >= 1 && !/\s/.test(ch)) sawToken = true;
  }
  throw new Error('unbalanced call');
}

describe('every AI cost record carries an invocation-ledger context (#7600 W02)', () => {
  const root = join(__dirname, '../..');
  const files = sourceFiles(root).filter((f) => !f.endsWith('services/aiCostTracker.ts'));

  it.each([
    ['recordUsage(', 11],
    ['recordSessionlessSdkUsage(', 5],
  ] as const)('every %s call passes the ledger argument', (callee, required) => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      let at = text.indexOf(callee);
      while (at !== -1) {
        const isDefinition = /function\s+$/.test(text.slice(Math.max(0, at - 20), at));
        const isMember = /[.\w]$/.test(text.slice(at - 1, at)) && !/\s$/.test(text.slice(at - 1, at));
        if (!isDefinition && !isMember && argCount(text, at + callee.length - 1) < required) {
          offenders.push(`${file.slice(root.length + 1)}:${text.slice(0, at).split('\n').length}`);
        }
        at = text.indexOf(callee, at + callee.length);
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

(`isMember` skips `foo.recordUsage(` and identifiers ending in `recordUsage(`, such as `recordDraftUsage(`. Only bare calls of the tracker functions count.)

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/aiCostTracker.test.ts src/services/aiModels/ledgerShadowBoot.contract.test.ts`
Expected: FAIL. No events are emitted, and the contract lists every call site in the table above.

- [ ] **Step 3: Emit from the tracker**

`apps/api/src/services/aiCostTracker.ts`: import

```ts
import { emitLegacyCostRecorded, type InvocationLedgerContext, type LegacyCostEvent } from './aiModels/legacyCostEvents';
```

`recordUsage`: add the trailing parameter `ledger?: InvocationLedgerContext`, and directly after `const costCents = tokenCostCents + additionalCostCents;`:

```ts
  // #7600 W02 shadow ledger: report what legacy charged; never affects the writes below.
  emitLegacyCostRecorded({
    orgId, sessionId, model, billingSource,
    catalogPricing: catalogPricing ?? null,
    tokens: { input: inputTokens, output: outputTokens, cacheRead: 0, cacheWrite: 0 },
    legacyCostCents: tokenCostCents,
    legacyAdditionalCostCents: additionalCostCents,
    legacyCostSource: catalogPricing ? 'catalog' : 'model_pricing',
    sdkReportedCostUsd: null,
    ledger: ledger ?? null,
  });
```

`recordUsageFromSdkResult`: declare `let legacyCostSource: LegacyCostEvent['legacyCostSource'] = catalogPricing ? 'catalog' : 'sdk';` before the `if (catalogPricing)` block. Set `legacyCostSource = 'model_pricing';` inside the branch where `calculateCostCents` replaces the SDK cost. Then, right after the whole `if/else` (before `const now = new Date();`):

```ts
  emitLegacyCostRecorded({
    orgId, sessionId, model: result.model ?? null, billingSource,
    catalogPricing: catalogPricing ?? null,
    tokens: { input: inputTokens, output: outputTokens, cacheRead: cacheReadTokens, cacheWrite: cacheCreationTokens },
    legacyCostCents: costCents,
    legacyAdditionalCostCents: 0,
    legacyCostSource,
    sdkReportedCostUsd: result.total_cost_usd,
    ledger: null,
  });
```

`recordSessionlessSdkUsage`: add the trailing parameter `ledger?: InvocationLedgerContext`. Track `let legacyCostSource: LegacyCostEvent['legacyCostSource'] = 'precomputed';` and set it to `'model_pricing'` inside the re-pricing `if`. Then, after that `if`:

```ts
  emitLegacyCostRecorded({
    orgId, sessionId: null, model: result.model ?? null, billingSource,
    catalogPricing: null,
    tokens: { input: inputTokens, output: outputTokens, cacheRead: cacheReadTokens, cacheWrite: cacheCreationTokens },
    legacyCostCents: Math.max(0, costCents),
    legacyAdditionalCostCents: 0,
    legacyCostSource,
    sdkReportedCostUsd: null,
    ledger: ledger ?? null,
  });
```

- [ ] **Step 4: Pass a ledger context at every caller**

These are one-argument additions. When a call stops short of `additionalCostCents`, pass `0` for it first so the ledger lands in the 11th slot.

- `routes/ai.ts` ticket draft (both `recordUsage(sessionId, …, reservationId)` calls): append `, 0, { surface: 'chat', sourceRef: 'ticket_draft', userId: auth.user.id }`. Use the `auth` variable already in scope in that handler.
- `routes/officeAddin/tickets.ts` `recordDraftUsage`: add a `userId: string | null` field to its input and pass `auth.user.id` from each of its four callers. The inner `recordUsage(null, …, reservationId)` gets `, 0, { surface: 'office_ticket', userId: input.userId }`.
- `services/scriptProposals/reviewer.ts`: define once, near the top of `runScriptReview`, `const ledger = { surface: 'script_reviewer' } as const;`. Append `, 0, ledger` to the three `recordUsage(null, …, reservationId)` calls and to `settleAtZero`'s.
- `services/catalogEnrichmentService.ts`: the two enrich calls already pass `additionalCostCents`, so append `, { surface: 'catalog_enrichment', userId: actor.userId ?? null }`. The polish call appends `, 0, { surface: 'catalog_enrichment', userId: actor.userId ?? null }`. Use the actor's real user field name: `git grep -n "actor\." apps/api/src/services/catalogEnrichmentService.ts | head`.
- `services/extensionAi.ts`: append `, 0, { surface: 'extension_content' }`.
- `services/aiAgents/runLoop.ts`: append `, { surface: 'ai_agents', agentRunId: run.id }` to `recordSessionlessSdkUsage(…)`.
- `services/llm/openaiSessionManager.ts`: directly after it computes the settled `costCents` (~:368), before `settleAiBudgetReservationDurably`:

```ts
    // #7600 W02 shadow ledger. The env OpenAI-compatible path has no registry
    // offering until W06; the row is recorded unpriced and not diff-logged.
    emitLegacyCostRecorded({
      orgId, sessionId, model: providerModel, billingSource: 'platform', catalogPricing: null,
      tokens: { input: inputTokens, output: outputTokens, cacheRead: 0, cacheWrite: 0 },
      legacyCostCents: costCents, legacyAdditionalCostCents: 0, legacyCostSource: 'openai_env',
      sdkReportedCostUsd: null, ledger: null,
    });
```

Use the local variable names that function actually has (`git show HEAD:apps/api/src/services/llm/openaiSessionManager.ts | sed -n 340,380p`).

- [ ] **Step 5: Run every touched suite**

```bash
cd apps/api && npx vitest run src/services/aiCostTracker.test.ts src/services/aiModels/ledgerShadowBoot.contract.test.ts \
  src/routes/ai src/routes/officeAddin src/services/scriptProposals src/services/catalogEnrichmentService \
  src/services/extensionAi src/services/aiAgents/runLoop src/services/llm/openaiSessionManager src/services/streamingSessionManager
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

Expected: PASS, and the file counts cover every caller's suite. Existing assertions on `recordUsage` / `recordSessionlessSdkUsage` call arguments (`toHaveBeenCalledWith(...)` with an exact argument list) will now see the extra trailing argument. Update exactly those expectations, append the ledger object to the expected list, and change nothing else in them. List each such edit in the commit body. They are the only permitted test edits in this task.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/aiCostTracker.ts apps/api/src/services/aiCostTracker.test.ts \
  apps/api/src/services/aiModels/ledgerShadowBoot.contract.test.ts apps/api/src/routes/ai.ts \
  apps/api/src/routes/officeAddin/tickets.ts apps/api/src/services/scriptProposals/reviewer.ts \
  apps/api/src/services/catalogEnrichmentService.ts apps/api/src/services/extensionAi.ts \
  apps/api/src/services/aiAgents/runLoop.ts apps/api/src/services/llm/openaiSessionManager.ts
git add -u apps/api/src   # caller test files whose exact-argument expectations gained the ledger argument
git commit -m "feat(ai): shadow every legacy AI cost record into the invocation ledger

Billing, budgets and credits are unchanged; the tracker emits after computing
the legacy cost and the ledger writes after the caller's transaction exits.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 16: `ai_invocations` retention worker (unit + integration)

The spec assigns retention to "the existing AI-usage retention job". **None exists on main**: nothing prunes `ai_cost_usage` or `ai_sessions`. This task adds a dedicated worker. It copies `jobs/aiUnattendedExposureRetention.ts`'s shape, deletes in `ctid` batches (`jobs/retentionBatch.ts` rationale) as `breeze_audit_admin` with the retention GUC, and is registered in the same places. The window defaults to **400 days**, a bit over a year so a full year of usage stays comparable, and can be set with `AI_INVOCATIONS_RETENTION_DAYS` (capped at 3650). Chargeback (W10) must aggregate before rows age out (spec §5.5). The default is an open question for Todd (see the end of the plan).

**Files:**
- Create: `apps/api/src/jobs/aiInvocationRetention.ts`
- Create: `apps/api/src/jobs/aiInvocationRetention.test.ts`
- Modify: `apps/api/src/jobs/scheduleRegistry.ts` (`'ai-invocation-retention': '13 18 * * *'`, daily lane ≡ 3 mod 5)
- Modify: `apps/api/src/services/workerRegistry.ts` (entry after `aiUnattendedExposureRetention`), `apps/api/src/services/workerRegistry.test.ts` and `apps/api/src/services/workerEntrypointClosure.contract.test.ts` (their worker-name lists)
- Modify: `apps/api/src/jobs/workerReadinessManifest.ts` (`consumers('aiInvocationRetention')`)
- Modify: `apps/api/src/services/retentionMetrics.ts` (`RETENTION_JOB_NAMES`, sorted: `'ai_invocation_retention'` before `'ai_unattended_exposure_retention'`)
- Modify: `.env.example`, `apps/docs/src/content/docs/deploy/environment.mdx` (document the three knobs)
- Modify: `apps/api/src/__tests__/integration/aiInvocationsAppendOnly.integration.test.ts` (append)

**Interfaces:**
- Consumes: `resolveRetentionDays`, `parsePositiveIntEnv` (`jobs/retentionBatch.ts`); `recordRetentionRun`; `jobSchedule`; `attachWorkerObservability`.
- Produces (index additions):
  - `pruneAiInvocations(opts?: { retentionDays?: number; batchSize?: number; maxBatches?: number }): Promise<{ deleted: number; batches: number; hasMore: boolean; retentionDays: number }>`
  - `initializeAiInvocationRetention()`, `shutdownAiInvocationRetention()`
  - `AI_INVOCATION_RETENTION_DEFAULT_DAYS = 400`
  - env `AI_INVOCATIONS_RETENTION_DAYS`, `AI_INVOCATIONS_RETENTION_BATCH_SIZE` (5000), `AI_INVOCATIONS_RETENTION_MAX_BATCHES` (200)

- [ ] **Step 1: Write the failing unit test**

`apps/api/src/jobs/aiInvocationRetention.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ statements: [] as string[], batches: [] as number[] }));
vi.mock('../db', () => ({
  db: {
    execute: vi.fn(async (q: { queryChunks?: unknown[] }) => {
      const text = JSON.stringify(q);
      state.statements.push(text);
      if (text.includes('DELETE FROM ai_invocations')) return { count: state.batches.shift() ?? 0 };
      return [];
    }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../services/retentionMetrics', () => ({ recordRetentionRun: vi.fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));

import { AI_INVOCATION_RETENTION_DEFAULT_DAYS, pruneAiInvocations } from './aiInvocationRetention';
import { recordRetentionRun } from '../services/retentionMetrics';

beforeEach(() => { state.statements.length = 0; state.batches.length = 0; delete process.env.AI_INVOCATIONS_RETENTION_DAYS; });

describe('pruneAiInvocations (#7600 W02)', () => {
  it('deletes in batches as breeze_audit_admin with the retention GUC, stopping on a short batch', async () => {
    state.batches.push(3, 3, 1);
    const result = await pruneAiInvocations({ retentionDays: 30, batchSize: 3, maxBatches: 10 });
    expect(result).toEqual({ deleted: 7, batches: 3, hasMore: false, retentionDays: 30 });
    const perBatch = state.statements.filter((s) => s.includes('SET LOCAL ROLE breeze_audit_admin')).length;
    expect(perBatch).toBe(3);
    expect(state.statements.filter((s) => s.includes("breeze.allow_audit_retention = '1'")).length).toBe(3);
    expect(recordRetentionRun).toHaveBeenCalledWith('ai_invocation_retention', { rowsDeleted: 7 });
  });

  it('reports a backlog when the batch cap stops a full batch', async () => {
    state.batches.push(3, 3);
    expect(await pruneAiInvocations({ retentionDays: 30, batchSize: 3, maxBatches: 2 })).toMatchObject({ batches: 2, hasMore: true });
  });

  it('falls back to the default window on a nonsense env value', async () => {
    process.env.AI_INVOCATIONS_RETENTION_DAYS = 'forever';
    expect((await pruneAiInvocations({ batchSize: 3, maxBatches: 1 })).retentionDays).toBe(AI_INVOCATION_RETENTION_DEFAULT_DAYS);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/jobs/aiInvocationRetention.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`apps/api/src/jobs/aiInvocationRetention.ts`:

```ts
/**
 * AI invocation ledger retention (#7600 W02). ai_invocations is APPEND-ONLY:
 * breeze_app holds no DELETE, and ai_invocations_append_only admits a delete
 * only as breeze_audit_admin with breeze.allow_audit_retention = '1'. Each
 * batch therefore runs in its own fresh system context that SET LOCALs both
 * (same pair as tenantCascade's erasure walk and jobs/auditRetention.ts), and
 * commits on its own (lock-duration rationale: jobs/retentionBatch.ts).
 *
 * Window: AI_INVOCATIONS_RETENTION_DAYS (default 400, cap 3650). Chargeback
 * (W10) aggregates BEFORE rows age out; it never mutates them.
 */
import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { extractRowCount } from '../db/rowCount';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';
import { parsePositiveIntEnv, resolveRetentionDays } from './retentionBatch';

const LOG = '[AiInvocationRetention]';
const QUEUE_NAME = 'ai-invocation-retention';
const JOB_NAME = 'ai-invocation-retention';
const REPEAT_JOB_ID = 'ai-invocation-retention';

export const AI_INVOCATION_RETENTION_DEFAULT_DAYS = 400;
const MAX_RETENTION_DAYS = 3650;

export async function pruneAiInvocations(opts: { retentionDays?: number; batchSize?: number; maxBatches?: number } = {}): Promise<{
  deleted: number; batches: number; hasMore: boolean; retentionDays: number;
}> {
  const retentionDays = resolveRetentionDays(
    opts.retentionDays ?? process.env.AI_INVOCATIONS_RETENTION_DAYS,
    AI_INVOCATION_RETENTION_DEFAULT_DAYS, MAX_RETENTION_DAYS, LOG,
  );
  const batchSize = opts.batchSize ?? parsePositiveIntEnv(LOG, 'AI_INVOCATIONS_RETENTION_BATCH_SIZE', 5000);
  const maxBatches = opts.maxBatches ?? parsePositiveIntEnv(LOG, 'AI_INVOCATIONS_RETENTION_MAX_BATCHES', 200);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  let deleted = 0;
  let batches = 0;
  let last = 0;
  while (batches < maxBatches) {
    last = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      await db.execute(sql`SET LOCAL ROLE breeze_audit_admin`);
      await db.execute(sql`SET LOCAL breeze.allow_audit_retention = '1'`);
      const result = await db.execute(sql`
        DELETE FROM ai_invocations
        WHERE ctid IN (
          SELECT ctid FROM ai_invocations
          WHERE created_at < ${cutoff}::timestamptz
          LIMIT ${batchSize}
        )`);
      return extractRowCount(result);
    }, 'aiInvocationRetention.batch'));
    deleted += last;
    batches += 1;
    if (last < batchSize) break;
  }
  recordRetentionRun('ai_invocation_retention', { rowsDeleted: deleted });
  console.log(`${LOG} Pruned ${deleted} ledger row(s) older than ${retentionDays}d in ${batches} batch(es)`);
  return { deleted, batches, hasMore: batches >= maxBatches && last >= batchSize, retentionDays };
}

let queue: Queue | null = null;
let worker: Worker | null = null;

function getQueue(): Queue {
  if (!queue) queue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  return queue;
}

export async function initializeAiInvocationRetention(): Promise<void> {
  worker = new Worker(QUEUE_NAME, async (_job: Job) => pruneAiInvocations(), { connection: getBullMQConnection(), concurrency: 1 });
  attachWorkerObservability(worker, 'aiInvocationRetention');
  const q = getQueue();
  for (const job of await q.getRepeatableJobs()) await q.removeRepeatableByKey(job.key);
  await q.add(JOB_NAME, {}, {
    jobId: REPEAT_JOB_ID,
    repeat: { pattern: jobSchedule('ai-invocation-retention') },
    removeOnComplete: { count: 5 },
    removeOnFail: { count: 10 },
  });
  console.log(`${LOG} Retention worker initialized`);
}

export async function shutdownAiInvocationRetention(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  if (queue) { await queue.close(); queue = null; }
}
```

Registrations. Copy the neighbouring `aiUnattendedExposureRetention` entries exactly, with the new names:
- `jobs/scheduleRegistry.ts`: `'ai-invocation-retention': '13 18 * * *',`. If `scheduleRegistry.contract.test.ts` reports a collision, take the next free `≡ 3 (mod 5)` minute.
- `services/workerRegistry.ts`: a `{ name: 'aiInvocationRetention', placement: 'global', load: async () => { const m = await import('../jobs/aiInvocationRetention'); return { init: m.initializeAiInvocationRetention, shutdown: m.shutdownAiInvocationRetention }; } }` entry, with a one-line `#7600 W02` comment. Add `'aiInvocationRetention'` to the name lists in `workerRegistry.test.ts` and `workerEntrypointClosure.contract.test.ts`.
- `jobs/workerReadinessManifest.ts`: `consumers('aiInvocationRetention'),` after `consumers('aiUnattendedExposureRetention'),`.
- `services/retentionMetrics.ts`: `'ai_invocation_retention',` before `'ai_unattended_exposure_retention',`.
- `.env.example` and `apps/docs/src/content/docs/deploy/environment.mdx`: document `AI_INVOCATIONS_RETENTION_DAYS` (default 400), `AI_INVOCATIONS_RETENTION_BATCH_SIZE` (5000) and `AI_INVOCATIONS_RETENTION_MAX_BATCHES` (200), each in the shape of the neighbouring retention knobs. If an env-registry test enumerates documented variables (`git grep -n "RETENTION_DAYS" apps/api/src/config`), register them there too.

- [ ] **Step 4: Append the real-Postgres check**

Append to `aiInvocationsAppendOnly.integration.test.ts` (import `pruneAiInvocations` from `../../jobs/aiInvocationRetention`):

```ts
describe.skipIf(!RUN)('ai_invocations retention (#7600 W02)', () => {
  it('prunes only rows older than the window, through the audit-admin path', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const old = await insertRow(org.id, { created_at: new Date(Date.now() - 60 * 86_400_000).toISOString() });
    const fresh = await insertRow(org.id);
    const result = await pruneAiInvocations({ retentionDays: 30, batchSize: 1000, maxBatches: 5 });
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await adminSql`SELECT 1 FROM ai_invocations WHERE id = ${old}`).toHaveLength(0);
    expect(await adminSql`SELECT 1 FROM ai_invocations WHERE id = ${fresh}`).toHaveLength(1);
  });
});
```

- [ ] **Step 5: Run unit + registry contracts + integration**

```bash
cd apps/api && npx vitest run src/jobs/aiInvocationRetention.test.ts src/jobs/scheduleRegistry src/services/workerRegistry.test.ts \
  src/services/workerEntrypointClosure.contract.test.ts src/jobs/workerReadinessManifest src/services/retentionMetrics
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiInvocationsAppendOnly.integration.test.ts
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/jobs/aiInvocationRetention.ts apps/api/src/jobs/aiInvocationRetention.test.ts \
  apps/api/src/jobs/scheduleRegistry.ts apps/api/src/services/workerRegistry.ts apps/api/src/services/workerRegistry.test.ts \
  apps/api/src/services/workerEntrypointClosure.contract.test.ts apps/api/src/jobs/workerReadinessManifest.ts \
  apps/api/src/services/retentionMetrics.ts .env.example apps/docs/src/content/docs/deploy/environment.mdx \
  apps/api/src/__tests__/integration/aiInvocationsAppendOnly.integration.test.ts
git commit -m "feat(ai): daily retention for the append-only invocation ledger

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 17: Full contract sweep before the PR (drift + full unit + integration + RLS coverage)

**Files:** none new. Fix-forward only.

- [ ] **Step 1: Migration naming against main**

Run: `git fetch origin && scripts/check-migration-naming.sh --against-ref origin/main`
Expected: PASS. If it fails, rename all seven W02 migrations to the day after the newest committed date, keeping their order. Sweep every reference to the old names: integration suites read `2026-11-14-100000-…` and the contract test reads all seven. Use `git grep -n "2026-11-14-1004\|2026-11-14-1000\|2026-11-14-1001\|2026-11-14-1002\|2026-11-14-1003\|2026-11-14-1005\|2026-11-14-1006"`. Then re-run `cd apps/api && npx vitest run src/db/autoMigrate.test.ts`.

- [ ] **Step 2: Schema drift (real Postgres)**

```bash
pnpm test-stack up
export DATABASE_URL="$(grep '^DATABASE_URL=' .env.test | cut -d= -f2-)"
pnpm db:migrate && pnpm db:check-drift
```

Expected: no drift. If drift lists the SQL-only CHECKs from Tasks 3–6, add matching `check(...)` entries to the Drizzle tables, copying the SQL verbatim. If it lists the composite FKs, add matching `foreignKey(...)` entries. Deferrability and `NOT VALID` stay SQL-only.

- [ ] **Step 3: The FULL API unit suite (not a filtered run)**

Run: `cd apps/api && npx vitest run`
Expected: PASS. This is the run where a missing `orgMergeRegistry` policy or a stale exact-argument expectation surfaces. CLAUDE.md: `orgMerge.test.ts` reds only in the full run.

- [ ] **Step 4: Every DB-backed contract and the W02 suites**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/aiModelRegistryForgery.integration.test.ts \
  src/__tests__/integration/aiModelAssignmentsPartnerRls.integration.test.ts \
  src/__tests__/integration/aiInvocationsAppendOnly.integration.test.ts \
  src/__tests__/integration/aiModelRegistryServices.integration.test.ts \
  src/__tests__/integration/aiModelRegistryReconcile.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/ensureAppRoleAppendOnlyPrivileges.integration.test.ts \
  src/__tests__/integration/llmCatalogSelection.integration.test.ts \
  src/__tests__/integration/partnerLlmConfigsPartnerRls.integration.test.ts \
  src/__tests__/integration/partnerLlmByokBilling.integration.test.ts \
  src/__tests__/integration/ai-budget-reservations.integration.test.ts \
  src/__tests__/integration/workspaceEnrichmentByok.integration.test.ts
cd apps/api && DB_CONTEXTLESS_WRITE_STRICT=true pnpm test:rls-coverage
```

Expected: PASS everywhere. Then run the whole integration config once (`pnpm --filter=@breeze/api test:integration`) because the cascade and export contracts walk every table.

- [ ] **Step 5: Typecheck + lint across touched packages**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
pnpm lint
```

- [ ] **Step 6: Tear down and open the PR**

```bash
pnpm test-stack down
git push -u origin feature/7598-ai-model-registry/wave-7600
```

PR title: `feat(ai): model registry schema, legacy backfill and /ai/provider on the registry (W02)`. The body states:
- `Closes #7600`;
- the W02 authority/freshness contract;
- the Handoff to W03 list below;
- that `routes/aiProvider.test.ts` is unmodified;
- the exact-argument test edits from Task 15;
- the retention default awaiting a decision.

Then run one `/pr-review-toolkit:review-pr` round. Tenancy and billing-adjacent, so a Sonnet or Opus reviewer.

---

## Handoff to W03 (binding)

W03's plan, "Required W02 plan changes" R1–R6, is authoritative where it is more specific.

1. **Per-partner, durable, one-time cutover. No boot barrier.**
   - W03 Task 6A calls `reconcilePartnerFromLegacyInTx(partnerId)` exactly once per partner. The call runs in one system transaction together with a durable per-partner cutover row, so both commit or neither does. R2: the reconcile throws on any failure and never returns a partial report.
   - `resolveModel` refuses a partner (`registry_unavailable`, recoverable) until it is cut over, and cuts it over on demand.
   - A coordinator-leased, resumable sweep starts after `serve()` (and after `startRegisteredWorkers` in `worker.ts`). Its completion is monotonic.
   - W03 deletes W02's detached `reconcileAllPartnersFromLegacy()` boot block in `index.ts`. Nothing re-projects a cut-over partner.
   - Between W02 boots, bindings can lag agent-policy edits, new sessions and script/Office/budget policy edits. The cutover projection captures the legacy state at that partner's cutover moment.
2. **Authority flip (W03 Task 6B).**
   - The Task 13 facade's "legacy write + re-projection" path and the Task 2 mirror trigger are W02-only scaffolding.
   - W03 replaces facade writes with registry-native id remaps (connect / disconnect / rotate / change default model, gated by the cutover), stops writing `partner_llm_configs`, and drops the trigger in `2026-11-19-100500-drop-partner-llm-configs-mirror-trigger.sql`.
   - W03 rewrites Task 13's integration cases that assert the legacy-row or trigger round trip.
   - Legacy readers (`resolveLlmConfig`, `llmUnusableCodeForOrgInSystemContext`, `markPartnerLlmError`) move to `getCompatConnection` / `getConnectionKeyMaterial`.
   - W08 drops the table and `legacy_default_model`. W08 also drops `partner_ai_connections_compat_uq`, unless W04 drops it first when multi-connection lands.
3. **Ledger.**
   - Switch `recordInvocation` to `ledgerMode: 'authoritative'`.
   - Derive session totals and `ai_cost_usage` only from authoritative rows. W02 shadow rows were never billed.
   - Delete `legacyCostEvents.ts` and the emits.
   - Use the `legacy_cost_cents` vs `cost_cents` diff (`SELECT … FROM ai_invocations WHERE ledger_mode = 'shadow'`) as the pricing go/no-go.
   - R4: `getLegacyModelRates` and its rate table are **not** deleted in W03. They move to `legacySurfaceModels.ts`, because the per-partner cutover of a not-yet-cut-over partner still runs W02's projection, which prices manual offerings with them. W08 deletes them, together with `legacyProjection.ts`, `legacyReconcile.ts` and the pickers.
4. **Parity.** Reuse `parity/` with `resolveModel` as the registry side.
   - `EXPECTED_DIVERGENCES` lists the only two allowed behaviour changes: catalog on agents/extension, and per-offering catalog eligibility.
   - A third divergence must be added deliberately, with a spec reference.
   - R6: `projectionEnvFor(fixture)` and `bindLegacyFixture(fixture)` are exported (Task 11) so W03's goldens and `registrySnapshotDeps.ts` reproduce exactly W02's binding.
5. **Deferred from §5.6:**
   - drop the stale `ai_sessions.model` default once session creation goes through `resolveModel`;
   - validate explicit agent policy models against the `ai_agents` effective permitted set at write time.
6. **Ledger insert contexts.** The provenance guard runs with the writer's RLS. An insert under an org token can name `connection_id` only through an enabled, org-visible offering. Keep ledger writes in system scope (`runAfterDbContextExit`), or insert with `offering_id` set.
7. **Patch test runner** (R5). W03 routes `patch_test` through `resolveModel` and the connection factory. It stays **unmetered** by design (#5557): it has no `org_id`, so no ledger row is possible.

## Index additions

Names this plan introduces that the index does not list. All are W02 unless noted.

- **Schema files:** `apps/api/src/db/schema/aiModelRegistry.ts` (`partnerAiConnections`, `partnerAiModels`, `aiModelAssignments`, `PARTNER_AI_CONNECTION_KINDS`, `PARTNER_AI_MODEL_SOURCES`, row types; lifecycle reuses W01's `MODEL_LIFECYCLES`) and `apps/api/src/db/schema/aiInvocations.ts` (`aiInvocations`, `AI_INVOCATION_LEDGER_MODES`).
- **Columns beyond spec §5:**
  - `partner_ai_connections.legacy_default_model` (compat, W02–W08);
  - `ai_invocations.ledger_mode`, `ai_invocations.legacy_cost_cents`.
- **Index:** `partner_ai_connections_compat_uq` (temporary, W02–W04).
- **Triggers:**
  - `partner_llm_configs_mirror_to_connection` (W02-only scaffolding; dropped by W03 Task 6B);
  - `partner_ai_models_integrity_guard`;
  - `ai_model_assignments_offering_ownership_guard`;
  - `ai_invocations_append_only`, `ai_invocations_provenance_guard`;
  - `breeze_ai_sessions_offering_partner_guard`.
- **Policies:**
  - `partner_llm_configs_system_only`;
  - `partner_ai_models_org_read_enabled`;
  - `ai_model_assignments_isolation`, `ai_model_assignments_partner_wide_select`.
- **`connections.ts`:** `PARTNER_AI_CONNECTION_KEY_SPEC`, `encryptConnectionKey`, `getCompatConnection`, `getConnectionKeyMaterial`, `ConnectionKeyError`, `CreateConnectionInput`, `PartnerAiConnection`.
- **`offerings.ts`:** `offeringPriceSource`, `OfferingPriceSource`, `findOfferingIdForModel`, `OfferingWriteError`.
- **`assignments.ts`:** `mergeEffectiveAssignment`, `clampOrgOptions`, `isPermitted`, `PermittedSet`, `AssignmentRowInput`, `AssignmentMergeWarning`. `getEffectiveAssignment` returns a `Promise` and takes an optional `role` (default `'default'`).
- **`legacySurfaceModels.ts`:** `legacyOfficeChatModel`, `legacyExtensionModel`, `legacyReviewerModel`, `legacyAgentModel`, `EXTENSION_AI_DEFAULT_MODEL`.
- **`legacyProjection.ts`:** `buildDesiredRegistryState`, `LegacySnapshot` (+ parts), `LegacyProjectionEnv`, `DesiredRegistryState`, `DesiredOffering`, `DesiredAssignment`, `OfferingKey`, `legacyBudgetAllowlist`, `LEGACY_BUDGET_ALLOWED_MODELS_DEFAULT`.
- **`legacyReconcile.ts`:** `reconcilePartnerFromLegacyInTx`, `reconcilePartnerFromLegacy`, `reconcileAllPartnersFromLegacy`, `loadLegacySnapshot`, `readLegacyProjectionEnv`, `ensureLegacyPlatformModel`, `ReconcileReport`.
- **`legacyCostEvents.ts`:** `InvocationLedgerContext`, `LegacyCostEvent`, `onLegacyCostRecorded`, `emitLegacyCostRecorded`.
- **`invocationLedger.ts`:** `registerInvocationLedgerShadow`, `recordShadowInvocation`, `surfaceFromSession`, `buildShadowRateSnapshot`, `shadowCostDiff`.
- **`parity/`:** `SurfaceUse`, `ParityQuery`, `ParityFixture`, `ParityRow`, `PARITY_FIXTURES`, `parityQueries`, `legacySurfaceUse`, `withFixtureEnv`, `RegistrySnapshot`, `materializeDesiredState`, `projectSurfaceUse`, `EXPECTED_DIVERGENCES`, `runParity`, `sameUse`; R6: `projectionEnvFor` (`projectionEnv.ts`), `bindLegacyFixture` (`bindLegacyFixture.ts`), `legacyFixtureState` / `legacyDbMockModule` / `legacyCatalogMockModule` (`legacyFixtureMocks.ts`).
- **Retention:** `jobs/aiInvocationRetention.ts` (`pruneAiInvocations`, `AI_INVOCATION_RETENTION_DEFAULT_DAYS`); queue `ai-invocation-retention`; worker `aiInvocationRetention`; env `AI_INVOCATIONS_RETENTION_DAYS` / `_BATCH_SIZE` / `_MAX_BATCHES`.
- **Elsewhere:**
  - `aiCostTracker.ts`: `getLegacyModelRates` (built on W01's private `resolveTokenRate`; W03 moves it to `legacySurfaceModels.ts`; W08 deletes it);
  - `config/env.ts`: `resolveReviewerDefaultModel`;
  - `aiAgentSdk.ts`: `SESSION_MAX_AGE_MS` / `SESSION_IDLE_TIMEOUT_MS` become exported.

## Open questions for Todd (none block Tasks 0–15)

1. **`ai_invocations` retention window.** The spec names an "existing AI-usage retention job" that does not exist. Task 16 ships 400 days (env-tunable). Is a year-plus right for the W10 chargeback and W11 quality views?
2. **Agent allowlist backfill.** For orgs whose `ai_budgets.allowed_models` is still the column default, Task 10 creates no org `ai_agents` assignment, because one would silently block future partner model changes for that org. Customized orgs get permitted = allowlist ∪ models already running. One consequence: after W03, an org override may pick another agent's partner model that wasn't in its allowlist. Accept?

## Self-review

- **Spec coverage:**

  | Spec item | Task |
  |---|---|
  | §5.2 connections, id-preserving, AAD, rotation walker, pre-migration decrypt test | 2, 7 |
  | §5.3 offerings, platform-shape CHECKs, composite FKs, partial uniques, org read branch | 3 |
  | §5.4 assignments: XOR, `offering_partner_id`, deferrable org FK, array trigger, role, options, fallback columns, template branch, cascade/merge/export/RLS, named suite | 4 |
  | §5.4 tighten-only merge | 9 |
  | §5.5 ledger: columns, append-only, registrations, retention | 5, 16 |
  | §5.5 shadow ledger next to every cost path, with diff | 14, 15 |
  | §5.6 session/agent columns | 6 |
  | §10 backfill of every surface/partner, legacy ids → manual, live sessions, budgets/reviewer/office | 10, 12 |
  | §10 parity | 11 |
  | §10 `/ai/provider` compatibility | 13 |
  | §12 forgery tests for every composite FK and trigger | 2–6 |

  Deliberately deferred (see the Task 6 note and Handoff): dropping the `ai_sessions.model` default, and write-time agent model validation.
- **Placeholder scan:** no TBD or "similar to". Where W01's real name may differ, the step names the exact assumed symbol and Task 0 records the real one.
- **Type consistency:**
  - `OfferingKey` / `DesiredRegistryState` (Task 10) are used verbatim by Tasks 11–12.
  - `AssignmentRowInput` (Task 9) is the shape `storeProjection` and the reconcile read-back produce.
  - `LegacyCostEvent` (Task 14) has the same fields Task 15 emits.
  - `getEffectiveAssignment` is async everywhere.
- **Review Focus:** each of the five lines has a named pinning test (header).
