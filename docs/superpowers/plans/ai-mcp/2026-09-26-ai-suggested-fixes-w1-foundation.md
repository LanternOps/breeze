---
tracking_issue: LanternOps/breeze#7140
---

# AI Suggested Fixes W1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every executed remediation suggestion as an attempt, observe whether it objectively fixed the problem and stayed fixed, fold the result into a partner-wide (or org-private) fix memory, and hand proven fixes back automatically — on new alerts, in the Suggested Fixes panel, and to every AI surface through one tier-1 tool — with no LLM in the loop.

**Architecture:** Two new tables. `fix_outcomes` is org-owned (shape 1) and holds one row per attempt with all private detail. `fix_memory` is a derived aggregate with org_id XOR partner_id (dual-axis plus a SELECT-only partner branch), holding counts only. A pure signature module turns an alert, anomaly or correlation into a versioned structured key built only from structured fields. A pure state machine (`outcomeWatcher`) advances each attempt. It is driven by a 5-minute sweeper (authoritative) plus two fast paths: an inline hook on both script terminal-write paths (no public `script.*` events, decision D-a), and a durable subscriber on `alert.resolved` (which now carries a persisted `resolution_reason`) and `alert.triggered`. Every terminal transition wins a compare-and-swap. Every aggregate write recomputes one identity from `fix_outcomes` under that identity's transaction-scoped advisory lock, which rebuilds share. So a redelivered event, a racing sweeper and a concurrent rebuild all converge. Lookup runs under the caller's RLS context and also filters by owner explicitly. Proven hits become `remediation_suggestions` rows with `origin = 'memory'`.

**Tech Stack:** Hono, Drizzle ORM on PostgreSQL (hand-written SQL migrations, forced RLS), BullMQ + Redis, Vitest (unit + real-Postgres integration), React (Astro island) + `runAction`, `@breeze/shared` constants.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-26-ai-suggested-fixes-fix-memory-design.md` (W1 row of its Waves table only; W2 research agent and W3 consumers are out of scope).

## Global Constraints

- **Precondition:** PR #7124 (the #7118 matcher hotfix) must be merged, and this branch rebased on it, before Task 15. Tasks 1–14 do not depend on it.
- **No public script events (D-a):** W1 never publishes `script.completed` / `script.failed`. Customer automations and webhooks subscribe to them and have no loop guard. Wiring them with a guard is a separate follow-up issue, out of scope here.
- **One lock protocol for `fix_memory`:** every aggregate write (transition recompute, re-vote recount, rebuild) takes `pg_advisory_xact_lock` on the SAME per-identity key *before* reading contributions. Order is always outcome-row lock → identity lock(s) in sorted key order.
- **Migrations:** exactly three new files, all sorting after the newest committed migration (`2026-10-31-120000-network-checks-as-monitors.sql`). Re-check `ls apps/api/migrations | sort | tail -3` before committing each one.
  - `apps/api/migrations/2026-11-01-100000-fix-memory-tables.sql`
  - `apps/api/migrations/2026-11-01-100100-remediation-suggestion-origin.sql`
  - `apps/api/migrations/2026-11-01-100200-alert-resolution-reason.sql`
- **Migration rules:** idempotent (`IF NOT EXISTS`, `DROP ... IF EXISTS` then re-add, `pg_policies` checks); no inner `BEGIN`/`COMMIT`; DDL only, so no `set_config('breeze.scope', ...)` is needed; never edit a shipped migration.
- **Tenancy:** `fix_outcomes` is shape 1 (`org_id NOT NULL`, policy `system OR breeze_has_org_access(org_id)`). `fix_memory` is org XOR partner (`fix_memory_one_owner_chk`), with one FOR ALL dual-axis policy plus a separate `fix_memory_partner_wide_select` FOR SELECT policy on `breeze_current_partner_id()`. It must not appear in `PARTNER_WIDE_SELECT_BRANCH_EXEMPT`.
- **Composite FK:** `fix_outcomes (org_id, partner_id) → organizations(id, partner_id)` is `DEFERRABLE INITIALLY IMMEDIATE`.
- **Cascade registration** (CLAUDE.md table), all in Task 3:
  - `CORE_ORG_CASCADE_DELETE_ORDER` (both tables);
  - `CORE_DEVICE_CASCADE_DELETE_TABLES` (`fix_outcomes`);
  - `INTENTIONALLY_NO_ORG_ID` in `moveOrg.coverage.test.ts` (`fix_outcomes` — history stays with the source org, as with `ai_agent_fix_watches`);
  - `orgMergeRegistry` `leave-for-erasure` (both);
  - `CORE_TENANT_EXPORT_POLICY` (both, plus the new columns on `remediation_suggestions` and `alerts`);
  - `DUAL_AXIS_TENANT_TABLES` and `XOR_OWNERSHIP_DUAL_AXIS_TABLES` (`fix_memory`).
- **Contexts:** request code uses the ambient request `db`. Background code (sweeper, subscribers, erasure hook) uses `inSystemDbContext` from `services/outcomeProbes.ts`, which reuses an existing system context or opens one outside the caller's context. Never hold a request context while writing `fix_memory`. The inline script hook (Task 10) is the one exception to "background uses system scope": it runs in the caller's (possibly org-scoped) transaction, always inside a savepoint on it, including a caller-supplied executor, so its own SQL failure can never abort the caller. It writes only that org's `fix_outcomes` rows and defers the aggregate to the sweeper's recount pass.
- **Writes to `fix_memory`** happen only in `services/fixMemory/store.ts`. That file gets an `ALLOWED_WITHOUT_CAPABILITY_CHECK` entry in `partner-wide-write-coverage.test.ts`.
- **Feature flag:** memory attach, the `find_proven_fixes` tool and Generate all gate on `shouldProduceMlOutput(orgId, 'ml.remediation_suggestions.enabled')`. Outcome recording is not gated: it only exists for suggestions that were already produced under the flag.
- **Privacy:** `fix_memory` stores counts, hashes, ids and statuses only. No hostnames, alert text, script output, parameters, discriminator values or model prose. Tool output exposes the discriminator *kind*, never its value.
- **Web:** every new mutation goes through `runAction`. New strings go in `apps/web/src/locales/<locale>/common.json` for all 8 locales (parity is test-enforced). The pt-BR strings are machine-drafted pending native review; the PR body must say so.
- **Public repo:** no IPs, hostnames or infrastructure details, and no description of unfixed vulnerabilities, in code, comments, commits or the PR.
- **Tests:** placed alongside source. Real-Postgres suites go under `apps/api/src/__tests__/integration/` (auto-included by `vitest.integration.config.ts`).
  - Run a unit file with `cd apps/api && npx vitest run <path>`. Never use `pnpm --filter x test -- --run`.
  - Run an integration file with `pnpm test-stack up`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`.
- **Commits:** one per task, conventional message, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit on `main`.

## Review Focus

These are the five input classes most likely to bite. Each has a pinning test in the task named.

1. **Duplicate or out-of-order delivery, and concurrent writers.** `alert.resolved` / `alert.triggered` can be redelivered (queue mode). The inline script hook, the sweeper, re-votes and rebuilds can all race. A terminal transition and its aggregate must count exactly once, and no writer may overwrite a newer aggregate. Pinned by:
   - Task 10 (hook CAS; hook always in a savepoint, so its failure never aborts the caller);
   - Task 12 (aggregate from the CAS-returned row; lost signature CAS reloads; durable erasure rebuild request);
   - Task 13, "duplicate alert.resolved delivery transitions once";
   - Task 23:
     - "two terminal transitions from the SAME holding snapshot";
     - "a terminal transition from an unsigned snapshot still aggregates";
     - "an already-counted outcome never counts twice";
     - "a rebuild waits for an in-flight recompute";
     - "a re-vote during a recount is not lost";
     - "a SQL failure inside the hook…";
     - "erasure: a rebuild racing the cascade…".
2. **A human, cleanup or expiry resolve is not recovery.**
   - A tech clicking Resolve, `hardwareHealth/retire`, backup-connection removal, and an anomaly episode that expired offline must all end `inconclusive`, never `holding`/`verified`.
   - An alert that cleared *before* the fix was admitted is `inconclusive` (`cleared_before_fix`).
   - Pinned by Task 13 (`decideAwaitingRecovery` table) and Task 9 (`resolution_reason` per caller).
3. **Device offline or telemetry gap during the hold.** A quiet hold is not proof, because cooldown and dedupe can hide a recurrence. `verified` requires a fresh heartbeat plus ≥80% metric-bucket coverage over the hold window. Otherwise the result is `inconclusive`. Pinned by:
   - Task 8, `probeTelemetryFreshness` gap cases, including the metric family's own column being NULL;
   - Task 23, "offline device during hold → inconclusive" and "disk_read hold with only CPU/RAM samples → inconclusive";
   - Task 13 / Task 23, recurrence scanned in SQL order so a match after 25+ unrelated alerts is found.
4. **Org B must never read org A's private memory, and org tokens must still see partner memory.**
   - RLS: forge 42501, XOR 23514, org-token SELECT branch, and the headless agent-auth context. Pinned by Task 5.
   - App-layer defence in depth: `classifyMemoryRows` drops a foreign org row even if RLS let it through. Pinned by Task 16.
   - Output never carries another org's hostnames or text. Pinned by Task 20.
5. **Script edited, re-scoped or deleted after it was proven.**
   - Proof is pinned to `script_version_id`. A new head version drops the old entry out of "proven".
   - Any re-scope (org→partner, partner→org, org A→org B; `routes/scripts.ts:921-928` keeps the version, `:997-1038,1097`) is caught two ways. Lookup independently checks that the script's CURRENT owner is visible to the target org. Drift detection compares `org_id` and `partner_id` against the row's owner, then marks it stale and rebuilds.
   - Soft-delete hides the entry.
   - Pinned by Task 16 (`isDispatchable` + current-owner cases) and Task 23 (partner script re-scoped to org A is not attached to org B; org A→org B drift → rebuild).

---

## File Structure

**Create**

| Path | Responsibility |
|---|---|
| `packages/shared/src/constants/fixMemory.ts` | Literal sets (states, kinds, origins, resolution reasons) and proof/window/freshness tunables; leaf module |
| `packages/shared/src/constants/fixMemory.test.ts` | Pins defaults and set invariants |
| `apps/api/migrations/2026-11-01-100000-fix-memory-tables.sql` | `fix_outcomes`, `fix_memory`, RLS, indexes, device-move re-stamp exclusion |
| `apps/api/migrations/2026-11-01-100100-remediation-suggestion-origin.sql` | `remediation_suggestions.origin` + `manual_steps` target type |
| `apps/api/migrations/2026-11-01-100200-alert-resolution-reason.sql` | `alerts.resolution_reason` |
| `apps/api/src/db/schema/fixMemory.ts` | Drizzle definitions for both tables |
| `apps/api/src/db/schema/fixMemory.registry.test.ts` | Unit contract: CHECK literals ↔ shared, every registration list |
| `apps/api/src/__tests__/integration/fixMemoryPartnerRls.integration.test.ts` | Real-PG RLS proofs |
| `apps/api/src/services/fixMemory/signature.ts` | Pure: facets → canonical signature (key + broad key) |
| `apps/api/src/services/fixMemory/signature.test.ts` | Canonicalisation + per-condition field table |
| `apps/api/src/services/fixMemory/aggregate.ts` | Pure: effective result, replay, proof rule, owner and identity resolution |
| `apps/api/src/services/fixMemory/aggregate.test.ts` | Table-driven proof, demotion and lift math |
| `apps/api/src/services/outcomeProbes.ts` | Probes extracted from fixWatch plus the telemetry freshness probe |
| `apps/api/src/services/outcomeProbes.test.ts` | Probe unit tests |
| `apps/api/src/services/fixMemory/scriptTerminalHook.ts` | Inline, never-throwing fix-outcome advance from script terminal writes (no public events) |
| `apps/api/src/services/fixMemory/scriptTerminalHook.test.ts` | Hook unit tests |
| `apps/api/src/services/fixMemory/signatureLoader.ts` | DB: source row → signature (alert / anomaly / correlation) |
| `apps/api/src/services/fixMemory/signatureLoader.test.ts` | Loader unit tests |
| `apps/api/src/services/fixMemory/store.ts` | The only writer of `fix_memory`: transition CAS + recompute, rebuild, erasure stale-marking, owner drift |
| `apps/api/src/services/fixMemory/store.test.ts` | Store unit tests (grouping, CAS no-op) |
| `apps/api/src/services/fixMemory/outcomeWatcher.ts` | Pure deciders + `advanceOutcome` orchestration + event handlers |
| `apps/api/src/services/fixMemory/outcomeWatcher.test.ts` | Table-driven state-machine edges + handler idempotency |
| `apps/api/src/jobs/fixOutcomeWorker.ts` | 5-minute sweeper queue and worker |
| `apps/api/src/jobs/fixOutcomeWorker.test.ts` | Sweeper wrapper tests |
| `apps/api/src/services/fixMemory/catalog.ts` | Extracted OS-filtered candidate catalog, now including partner-wide scripts |
| `apps/api/src/services/fixMemory/catalog.test.ts` | Visibility SQL + OS filter tests |
| `apps/api/src/services/fixMemory/lookup.ts` | `lookupFixes` + pure `classifyMemoryRows` |
| `apps/api/src/services/fixMemory/lookup.test.ts` | Classification tests |
| `apps/api/src/services/fixMemory/attach.ts` | Proven hit → `remediation_suggestions` row (`origin='memory'`) + subscriber handler |
| `apps/api/src/services/fixMemory/attach.test.ts` | Attach tests |
| `apps/api/src/services/fixMemory/outcomeRecorder.ts` | Request-path writers: outcome on execute, Done, vote; list summaries |
| `apps/api/src/services/fixMemory/outcomeRecorder.test.ts` | Recorder tests |
| `apps/api/src/services/aiToolsFixMemory.ts` | `find_proven_fixes` handler |
| `apps/api/src/services/aiToolsFixMemory.test.ts` | Tool tests |
| `apps/api/src/__tests__/integration/fixMemoryCatalog.integration.test.ts` | Real-PG catalog visibility |
| `apps/api/src/__tests__/integration/fixOutcomeLifecycle.integration.test.ts` | Real-PG lifecycle, exactly-once, erasure + rebuild |

**Modify**

| Path | Change |
|---|---|
| `packages/shared/src/constants/index.ts` | `export * from './fixMemory'` |
| `apps/api/src/db/schema/index.ts` | `export * from './fixMemory'` |
| `apps/api/src/db/schema/remediationSuggestions.ts` | `origin` column |
| `apps/api/src/db/schema/alerts.ts` | `resolutionReason` column |
| `apps/api/src/services/tenantCascade.ts` | Cascade order entries |
| `apps/api/src/routes/devices/core.ts` | Device cascade entry + absence comment |
| `apps/api/src/routes/devices/moveOrg.coverage.test.ts` | `INTENTIONALLY_NO_ORG_ID` |
| `apps/api/src/services/orgMergeRegistry.ts` | Two `leave-for-erasure` entries |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | Two new policies + two column additions |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | Dual-axis + XOR sets |
| `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` | Allowlist `services/fixMemory/store.ts` |
| `apps/api/src/services/aiAgents/fixWatch.ts` | Use extracted probes; behaviour unchanged |
| `apps/api/src/services/alertService.ts` | `resolveAlert(..., resolutionReason)`; persisted + on payload; checkAutoResolve passes `condition_cleared` |
| `apps/api/src/services/policyAlertBridge.ts`, `jobs/monitorWorker.ts`, `services/scriptExitCodeAlerts.ts`, `services/alertSubjects.ts`, `services/metricAnomalyEpisodeAlerts.ts`, `services/metricAnomalyEpisodeActions.ts`, `services/hardwareHealth/retire.ts`, `services/backupProviders/alerts.ts`, `services/backupProviders/alertsResolve.ts` | Pass a resolution reason |
| `apps/api/src/jobs/monitorWorker.test.ts`, `apps/api/src/services/backupProviders/alerts.evaluate.test.ts` | Updated call expectations |
| `apps/api/src/services/commandResultHandlers.ts`, `apps/api/src/services/scriptExecutionTerminal.ts` | Call the inline outcome hook (`scriptExecutionTerminal` executor type gains `'transaction'` for the hook's savepoint) |
| `apps/api/src/services/commandCancelPropagation.ts` | Type only: `DbExecutor` gains `'transaction'` (it forwards the caller's tx to the hook) |
| `apps/api/src/services/scriptExecutionTerminal.test.ts`, `apps/api/src/services/commandResultHandlers.exitCodeAlerts.test.ts` | Hook wiring tests |
| `apps/api/src/services/eventSubscriberIds.ts`, `apps/api/src/services/eventSubscribers.ts` | Two durable subscribers |
| `apps/api/src/services/workerRegistry.ts`, `workerRegistry.test.ts`, `workerEntrypointClosure.contract.test.ts`, `apps/api/src/jobs/workerReadinessManifest.ts` | Register `fixOutcomeWorker` |
| `apps/api/src/services/remediationSuggestions.ts` (+ test) | Use `catalog.ts`; call `attachProvenFixes` in Generate |
| `apps/api/src/routes/remediationSuggestions.ts` (+ test) | Outcome on `/execute`; `POST /:id/vote`, `POST /:id/done`; `origin` + `outcome` on serialised rows |
| `apps/api/src/jobs/tenantErasure.ts` (+ test) | `eraseOrgWithFixMemory`: stale-mark before cascade, rebuild after |
| `apps/api/src/services/aiTools.ts`, `aiToolSchemas.ts`, `aiAgentSdkTools.ts`, `aiGuardrails.ts`, `aiAgents/agentToolCatalog.ts`, `mcpCoverage.ts`, `aiGuardrails.routeBinding.contract.test.ts`, `aiGuardrails.agentPrincipal.contract.test.ts` | Tool registration |
| `apps/web/src/components/ai-risk/tierConfig.ts` | Tier-1 entry |
| `apps/docs/src/content/docs/features/mcp-server.mdx`, `apps/docs/src/content/docs/features/ai.mdx` | Tool docs |
| `apps/web/src/components/remediation/RemediationSuggestionsPanel.tsx` (+ test), `apps/web/src/locales/*/common.json` | Proven badge, 👍/👎, Done |

---

## Task 1: Proof-rule and literal constants in `@breeze/shared` (unit)

**Files:**
- Create: `packages/shared/src/constants/fixMemory.ts`
- Create: `packages/shared/src/constants/fixMemory.test.ts`
- Modify: `packages/shared/src/constants/index.ts` (after the `./googleDwdScopes` export, ~L21)

**Interfaces:**
- Consumes: nothing (leaf module; the root barrel is bundled into the browser, so no Node imports).
- Produces:
  ```ts
  export const FIX_SIGNATURE_VERSION: 1;
  export const FIX_SIGNATURE_FAMILIES: readonly ['alert', 'anomaly', 'correlation'];
  export type FixSignatureFamily;
  export const FIX_DISCRIMINATOR_KINDS: readonly ['service', 'process', 'software', 'exit_code', 'kb', 'event_id'];
  export type FixDiscriminatorKind;
  export const FIX_KINDS: readonly ['system_script', 'partner_script', 'org_script', 'builtin_action', 'playbook', 'manual_steps'];
  export type FixKind;
  export const FIX_OUTCOME_STATES: readonly [...8];
  export type FixOutcomeState;
  export const FIX_OUTCOME_ACTIVE_STATES: readonly ['pending', 'awaiting_recovery', 'holding'];
  export const FIX_OUTCOME_TERMINAL_STATES: readonly ['verified', 'failed', 'recurred', 'inconclusive', 'cancelled'];
  export const FIX_COUNTED_RESULTS: readonly ['verified', 'failed', 'recurred'];
  export type FixCountedResult;
  export const FIX_MEMORY_STATUSES: readonly ['active', 'demoted', 'retired'];
  export type FixMemoryStatus;
  export const FIX_VOTES: readonly ['up', 'down'];
  export type FixVote;
  export const REMEDIATION_SUGGESTION_ORIGINS: readonly ['catalog_match', 'memory', 'ai_research'];
  export type RemediationSuggestionOrigin;
  export const ALERT_RESOLUTION_REASONS: readonly ['condition_cleared', 'source_retired', 'expired', 'manual'];
  export type AlertResolutionReason;
  export const FIX_PROOF_RULES: Readonly<{ minVerified: 3; minSuccessRate: 0.8; rollingWindow: 20; noRecurrenceInLast: 3; demoteAfterConsecutiveFailures: 2; liftDemotionAfterConsecutiveVerified: 3 }>;
  export const FIX_OUTCOME_WINDOWS: Readonly<{ pendingTimeoutHours: 24; recoveryTimeoutHours: 24; holdHours: 24 }>;
  export const FIX_TELEMETRY_FRESHNESS: Readonly<{ bucketMinutes: 30; minCoverage: 0.8; maxHeartbeatAgeMinutes: 30 }>;
  export function isFixOutcomeTerminal(state: FixOutcomeState): boolean;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/constants/fixMemory.test.ts
import { describe, expect, it } from 'vitest';
import {
  ALERT_RESOLUTION_REASONS,
  FIX_COUNTED_RESULTS,
  FIX_OUTCOME_ACTIVE_STATES,
  FIX_OUTCOME_STATES,
  FIX_OUTCOME_TERMINAL_STATES,
  FIX_OUTCOME_WINDOWS,
  FIX_PROOF_RULES,
  FIX_SIGNATURE_VERSION,
  FIX_TELEMETRY_FRESHNESS,
  REMEDIATION_SUGGESTION_ORIGINS,
  isFixOutcomeTerminal,
} from './index';

describe('fix memory constants', () => {
  it('pins the spec proof-rule defaults', () => {
    expect(FIX_PROOF_RULES).toEqual({
      minVerified: 3,
      minSuccessRate: 0.8,
      rollingWindow: 20,
      noRecurrenceInLast: 3,
      demoteAfterConsecutiveFailures: 2,
      liftDemotionAfterConsecutiveVerified: 3,
    });
    expect(Object.isFrozen(FIX_PROOF_RULES)).toBe(true);
  });

  it('pins the watch windows and the freshness probe', () => {
    expect(FIX_OUTCOME_WINDOWS).toEqual({ pendingTimeoutHours: 24, recoveryTimeoutHours: 24, holdHours: 24 });
    expect(FIX_TELEMETRY_FRESHNESS).toEqual({ bucketMinutes: 30, minCoverage: 0.8, maxHeartbeatAgeMinutes: 30 });
    expect(FIX_SIGNATURE_VERSION).toBe(1);
  });

  it('active and terminal states partition the state set exactly', () => {
    const union = [...FIX_OUTCOME_ACTIVE_STATES, ...FIX_OUTCOME_TERMINAL_STATES].sort();
    expect(union).toEqual([...FIX_OUTCOME_STATES].sort());
    for (const s of FIX_OUTCOME_ACTIVE_STATES) expect(isFixOutcomeTerminal(s)).toBe(false);
    for (const s of FIX_OUTCOME_TERMINAL_STATES) expect(isFixOutcomeTerminal(s)).toBe(true);
  });

  it('counted results are a subset of terminal states and exclude inconclusive/cancelled', () => {
    for (const r of FIX_COUNTED_RESULTS) expect(FIX_OUTCOME_TERMINAL_STATES).toContain(r);
    expect(FIX_COUNTED_RESULTS).not.toContain('inconclusive');
    expect(FIX_COUNTED_RESULTS).not.toContain('cancelled');
  });

  it('keeps catalog_match as an origin (the column default) and condition_cleared as a reason', () => {
    expect(REMEDIATION_SUGGESTION_ORIGINS).toContain('catalog_match');
    expect(ALERT_RESOLUTION_REASONS).toContain('condition_cleared');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/shared && npx vitest run src/constants/fixMemory.test.ts`
Expected: FAIL. The imports are `undefined` (`FIX_PROOF_RULES` is not exported from `./index`), so `toEqual` receives `undefined`.

- [ ] **Step 3: Implement**

```ts
// packages/shared/src/constants/fixMemory.ts
/**
 * Fix memory (AI Suggested Fixes W1). Every literal set below is mirrored 1:1
 * by a CHECK constraint in apps/api/migrations/2026-11-01-100000-fix-memory-tables.sql,
 * 2026-11-01-100100-remediation-suggestion-origin.sql or
 * 2026-11-01-100200-alert-resolution-reason.sql — edit both sides together;
 * apps/api/src/db/schema/fixMemory.registry.test.ts fails otherwise.
 *
 * Leaf module: no imports. The package root barrel is bundled into the browser.
 */
export const FIX_SIGNATURE_VERSION = 1 as const;

export const FIX_SIGNATURE_FAMILIES = ['alert', 'anomaly', 'correlation'] as const;
export type FixSignatureFamily = (typeof FIX_SIGNATURE_FAMILIES)[number];

/** Discriminators are extracted from STRUCTURED fields only, never free text. */
export const FIX_DISCRIMINATOR_KINDS = ['service', 'process', 'software', 'exit_code', 'kb', 'event_id'] as const;
export type FixDiscriminatorKind = (typeof FIX_DISCRIMINATOR_KINDS)[number];

export const FIX_KINDS = ['system_script', 'partner_script', 'org_script', 'builtin_action', 'playbook', 'manual_steps'] as const;
export type FixKind = (typeof FIX_KINDS)[number];

export const FIX_OUTCOME_STATES = [
  'pending', 'awaiting_recovery', 'holding',
  'verified', 'failed', 'recurred', 'inconclusive', 'cancelled',
] as const;
export type FixOutcomeState = (typeof FIX_OUTCOME_STATES)[number];

export const FIX_OUTCOME_ACTIVE_STATES = ['pending', 'awaiting_recovery', 'holding'] as const satisfies readonly FixOutcomeState[];
export const FIX_OUTCOME_TERMINAL_STATES = ['verified', 'failed', 'recurred', 'inconclusive', 'cancelled'] as const satisfies readonly FixOutcomeState[];

/** The only results that count as an attempt. inconclusive/cancelled never count. */
export const FIX_COUNTED_RESULTS = ['verified', 'failed', 'recurred'] as const;
export type FixCountedResult = (typeof FIX_COUNTED_RESULTS)[number];

export const FIX_MEMORY_STATUSES = ['active', 'demoted', 'retired'] as const;
export type FixMemoryStatus = (typeof FIX_MEMORY_STATUSES)[number];

export const FIX_VOTES = ['up', 'down'] as const;
export type FixVote = (typeof FIX_VOTES)[number];

export const REMEDIATION_SUGGESTION_ORIGINS = ['catalog_match', 'memory', 'ai_research'] as const;
export type RemediationSuggestionOrigin = (typeof REMEDIATION_SUGGESTION_ORIGINS)[number];

/**
 * Why an alert resolved. Only `condition_cleared` with `resolved_by IS NULL` is
 * objective recovery for the outcome watcher; NULL (unspecified) fails closed.
 */
export const ALERT_RESOLUTION_REASONS = ['condition_cleared', 'source_retired', 'expired', 'manual'] as const;
export type AlertResolutionReason = (typeof ALERT_RESOLUTION_REASONS)[number];

/** Spec "Proof rule" defaults. Tunables, not contracts — change here only. */
export const FIX_PROOF_RULES = Object.freeze({
  minVerified: 3,
  minSuccessRate: 0.8,
  rollingWindow: 20,
  noRecurrenceInLast: 3,
  demoteAfterConsecutiveFailures: 2,
  liftDemotionAfterConsecutiveVerified: 3,
} as const);

/** Spec "Outcome lifecycle" windows. */
export const FIX_OUTCOME_WINDOWS = Object.freeze({
  pendingTimeoutHours: 24,
  recoveryTimeoutHours: 24,
  holdHours: 24,
} as const);

/**
 * Telemetry freshness during the hold: the device heartbeat must be no older
 * than maxHeartbeatAgeMinutes at hold end, and at least minCoverage of the
 * bucketMinutes-wide buckets across the hold must contain a metric sample.
 */
export const FIX_TELEMETRY_FRESHNESS = Object.freeze({
  bucketMinutes: 30,
  minCoverage: 0.8,
  maxHeartbeatAgeMinutes: 30,
} as const);

export function isFixOutcomeTerminal(state: FixOutcomeState): boolean {
  return (FIX_OUTCOME_TERMINAL_STATES as readonly string[]).includes(state);
}
```

Append to `packages/shared/src/constants/index.ts`, right after the `export * from './googleDwdScopes';` line:

```ts
// Fix memory (AI Suggested Fixes W1): proof rule, outcome states, origins,
// alert resolution reasons. Leaf module, no imports.
export * from './fixMemory';
```

- [ ] **Step 4: Run it and watch it pass, then confirm the browser barrel stays clean**

Run: `cd packages/shared && npx vitest run src/constants/fixMemory.test.ts src/browserSafeBarrel.test.ts src/constants/index.test.ts`
Expected: PASS (all three files).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/constants/fixMemory.ts packages/shared/src/constants/fixMemory.test.ts packages/shared/src/constants/index.ts
git commit -m "feat(shared): fix-memory proof rule and outcome literals

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: `fix_outcomes` + `fix_memory` migration and Drizzle schema (unit contract; drift needs Postgres)

**Files:**
- Create: `apps/api/migrations/2026-11-01-100000-fix-memory-tables.sql`
- Create: `apps/api/src/db/schema/fixMemory.ts`
- Modify: `apps/api/src/db/schema/index.ts` (after `export * from './remediationSuggestions';`, ~L151)
- Test: `apps/api/src/db/schema/fixMemory.registry.test.ts` (created here, extended in Tasks 3–4)

**Interfaces:**
- Consumes: `FIX_KINDS`, `FIX_OUTCOME_STATES`, `FIX_MEMORY_STATUSES`, `FIX_VOTES` and their types (Task 1).
- Produces:
  - `fixOutcomes` and `fixMemory` Drizzle tables;
  - `type FixOutcomeRow = typeof fixOutcomes.$inferSelect`;
  - `type FixMemoryRow = typeof fixMemory.$inferSelect`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/db/schema/fixMemory.registry.test.ts
// AI Suggested Fixes W1 — mechanical contract for fix_outcomes + fix_memory.
// CLAUDE.md: registrations are caught by contract tests 5/5 and review 0/5,
// so the unit job pins them here rather than waiting for Integration Tests.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FIX_KINDS, FIX_MEMORY_STATUSES, FIX_OUTCOME_STATES, FIX_VOTES } from '@breeze/shared';
import { checkConstraintLiterals } from './checkConstraintTestHelpers';
import { fixMemory, fixOutcomes } from './fixMemory';

const TABLES_SQL = readFileSync(
  new URL('../../../migrations/2026-11-01-100000-fix-memory-tables.sql', import.meta.url),
  'utf8',
);

describe('fix memory schema contract', () => {
  describe('CHECK constraints match @breeze/shared literals exactly', () => {
    it('fix_outcomes_state_chk', () => {
      expect(checkConstraintLiterals(TABLES_SQL, 'fix_outcomes_state_chk', 'state').sort())
        .toEqual([...FIX_OUTCOME_STATES].sort());
    });
    it('fix_outcomes_fix_kind_chk and fix_memory_fix_kind_chk', () => {
      expect(checkConstraintLiterals(TABLES_SQL, 'fix_outcomes_fix_kind_chk', 'fix_kind').sort())
        .toEqual([...FIX_KINDS].sort());
      expect(checkConstraintLiterals(TABLES_SQL, 'fix_memory_fix_kind_chk', 'fix_kind').sort())
        .toEqual([...FIX_KINDS].sort());
    });
    it('fix_outcomes_human_vote_chk', () => {
      expect(checkConstraintLiterals(TABLES_SQL, 'fix_outcomes_human_vote_chk', 'human_vote').sort())
        .toEqual([...FIX_VOTES].sort());
    });
    it('fix_memory_status_chk', () => {
      expect(checkConstraintLiterals(TABLES_SQL, 'fix_memory_status_chk', 'status').sort())
        .toEqual([...FIX_MEMORY_STATUSES].sort());
    });
  });

  it('ships the XOR owner check, the partner-wide SELECT branch and the deferrable composite FK in the same migration', () => {
    expect(TABLES_SQL).toMatch(/fix_memory_one_owner_chk\s+CHECK\s*\(\s*\(org_id IS NULL\)\s*<>\s*\(partner_id IS NULL\)\s*\)/);
    expect(TABLES_SQL).toMatch(/CREATE POLICY fix_memory_partner_wide_select[\s\S]*FOR SELECT[\s\S]*org_id IS NULL AND partner_id = public\.breeze_current_partner_id\(\)/);
    expect(TABLES_SQL).toMatch(/fix_outcomes_org_partner_fk[\s\S]*REFERENCES organizations\(id, partner_id\)[\s\S]*DEFERRABLE INITIALLY IMMEDIATE/);
    expect(TABLES_SQL).toMatch(/'fix_outcomes'/); // excluded from breeze_device_child_orgid_tables()
  });

  it('Drizzle exposes every migration column', () => {
    for (const key of [
      'id', 'orgId', 'partnerId', 'deviceId', 'suggestionId', 'sourceType', 'sourceId', 'alertId',
      'anomalyEpisodeId', 'signatureVersion', 'signatureKey', 'broadKey', 'signatureFacets', 'osType',
      'fixKind', 'fixIdentity', 'scriptId', 'scriptVersionId', 'builtinAction', 'playbookId',
      'instructionsRef', 'scriptExecutionId', 'state', 'stateReason', 'humanVote', 'votedBy', 'votedAt',
      'recoveredAt', 'deadlineAt', 'holdingUntil', 'terminalAt', 'countedAt', 'recountRequestedAt',
      'createdAt', 'updatedAt',
    ]) expect(fixOutcomes, `fixOutcomes.${key}`).toHaveProperty(key);
    for (const key of [
      'id', 'orgId', 'partnerId', 'signatureVersion', 'signatureKey', 'broadKey', 'osType', 'fixKind',
      'fixIdentity', 'scriptId', 'scriptVersionId', 'builtinAction', 'playbookId', 'instructionsRef',
      'attempts', 'verifiedCount', 'failedCount', 'recurredCount', 'upVotes', 'downVotes',
      'rollingSuccessRate', 'consecutiveFailures', 'consecutiveVerified', 'recentOutcomes', 'status',
      'retiredBy', 'retiredAt', 'lastVerifiedAt', 'staleSince', 'rebuildPendingOrgIds', 'createdAt', 'updatedAt',
    ]) expect(fixMemory, `fixMemory.${key}`).toHaveProperty(key);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/db/schema/fixMemory.registry.test.ts`
Expected: FAIL. The suite cannot resolve `./fixMemory`, and `readFileSync` throws `ENOENT` for the migration path.

- [ ] **Step 3: Write the migration**

```sql
-- apps/api/migrations/2026-11-01-100000-fix-memory-tables.sql
-- AI Suggested Fixes W1 (Foundation): fix_outcomes + fix_memory.
-- Spec: docs/superpowers/specs/ai-mcp/2026-09-26-ai-suggested-fixes-fix-memory-design.md
--
-- fix_outcomes — tenancy shape 1 (direct org_id). One row per attempt; the only
--   place private detail (source ids, facets) lives. partner_id is denormalised
--   for partner-scoped rebuilds and pinned by a composite FK to
--   organizations(id, partner_id), DEFERRABLE INITIALLY IMMEDIATE per CLAUDE.md
--   (org merge runs SET CONSTRAINTS ALL DEFERRED). device_id carries NO FK:
--   outcome history is not re-stamped on a device move (same owner decision as
--   ai_agent_fix_watches) and is removed by the device cascade list on delete.
--   Excluded from breeze_device_child_orgid_tables() (section 4) so the
--   devices-UPDATE trigger never re-stamps it — a cross-partner device move
--   would otherwise violate fix_outcomes_org_partner_fk.
--
-- fix_memory — derived aggregate, org_id XOR partner_id (Partner-Wide First).
--   One FOR ALL dual-axis policy plus a SEPARATE FOR SELECT partner-wide branch
--   (template 2026-10-05-110000-config-policy-partner-wide-select.sql) so org
--   tokens and headless agent runs read their partner's shareable memory
--   without widening UPDATE/DELETE targeting.
--
-- Idempotent throughout. DDL only (no row writes, so no breeze.scope elevation).
-- No inner BEGIN/COMMIT — autoMigrate wraps this file in one transaction.

-- ---------------------------------------------------------------------------
-- 1. fix_outcomes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fix_outcomes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL,
  partner_id            uuid NOT NULL,
  device_id             uuid NOT NULL,
  suggestion_id         uuid REFERENCES remediation_suggestions(id) ON DELETE SET NULL,
  source_type           varchar(20) NOT NULL,
  source_id             varchar(255) NOT NULL,
  alert_id              uuid REFERENCES alerts(id) ON DELETE SET NULL,
  anomaly_episode_id    uuid REFERENCES metric_anomaly_episodes(id) ON DELETE SET NULL,
  signature_version     smallint,
  signature_key         char(64),
  broad_key             char(64),
  signature_facets      jsonb,
  os_type               varchar(20),
  fix_kind              varchar(30) NOT NULL,
  fix_identity          varchar(200),
  script_id             uuid REFERENCES scripts(id) ON DELETE SET NULL,
  script_version_id     uuid REFERENCES script_versions(id) ON DELETE SET NULL,
  builtin_action        varchar(60),
  playbook_id           uuid REFERENCES playbook_definitions(id) ON DELETE SET NULL,
  instructions_ref      varchar(120),
  script_execution_id   uuid REFERENCES script_executions(id) ON DELETE SET NULL,
  state                 varchar(30) NOT NULL DEFAULT 'pending',
  state_reason          varchar(80),
  human_vote            varchar(10),
  voted_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  voted_at              timestamptz,
  recovered_at          timestamptz,
  deadline_at           timestamptz NOT NULL,
  holding_until         timestamptz,
  terminal_at           timestamptz,
  counted_at            timestamptz,
  recount_requested_at  timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fix_outcomes_org_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fix_outcomes_state_chk CHECK (state IN ('pending', 'awaiting_recovery', 'holding', 'verified', 'failed', 'recurred', 'inconclusive', 'cancelled')),
  CONSTRAINT fix_outcomes_fix_kind_chk CHECK (fix_kind IN ('system_script', 'partner_script', 'org_script', 'builtin_action', 'playbook', 'manual_steps')),
  CONSTRAINT fix_outcomes_source_type_chk CHECK (source_type IN ('alert', 'anomaly', 'correlation', 'rca')),
  CONSTRAINT fix_outcomes_human_vote_chk CHECK (human_vote IN ('up', 'down')),
  CONSTRAINT fix_outcomes_terminal_shape_chk
    CHECK ((terminal_at IS NULL) = (state IN ('pending', 'awaiting_recovery', 'holding'))),
  CONSTRAINT fix_outcomes_counted_shape_chk CHECK (counted_at IS NULL OR terminal_at IS NOT NULL),
  CONSTRAINT fix_outcomes_signature_shape_chk
    CHECK ((signature_key IS NULL) = (signature_version IS NULL) AND (signature_key IS NULL) = (broad_key IS NULL))
);

-- One suggestion is one attempt (spec). Partial: suggestion_id is SET NULL by
-- ML output retention and must not collide then.
CREATE UNIQUE INDEX IF NOT EXISTS fix_outcomes_suggestion_uq
  ON fix_outcomes (suggestion_id) WHERE suggestion_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fix_outcomes_active_idx
  ON fix_outcomes (state, deadline_at) WHERE state IN ('pending', 'awaiting_recovery', 'holding');
CREATE INDEX IF NOT EXISTS fix_outcomes_org_created_idx ON fix_outcomes (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fix_outcomes_device_state_idx ON fix_outcomes (device_id, state);
CREATE INDEX IF NOT EXISTS fix_outcomes_execution_idx ON fix_outcomes (script_execution_id) WHERE script_execution_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fix_outcomes_alert_idx ON fix_outcomes (alert_id) WHERE alert_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fix_outcomes_identity_idx
  ON fix_outcomes (partner_id, signature_key, os_type, fix_identity) WHERE counted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS fix_outcomes_recount_idx
  ON fix_outcomes (recount_requested_at) WHERE recount_requested_at IS NOT NULL;

ALTER TABLE fix_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fix_outcomes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fix_outcomes_isolation ON fix_outcomes;
CREATE POLICY fix_outcomes_isolation ON fix_outcomes
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON fix_outcomes TO breeze_app;

-- ---------------------------------------------------------------------------
-- 2. fix_memory
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fix_memory (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id            uuid REFERENCES partners(id) ON DELETE CASCADE,
  signature_version     smallint NOT NULL,
  signature_key         char(64) NOT NULL,
  broad_key             char(64) NOT NULL,
  os_type               varchar(20) NOT NULL,
  fix_kind              varchar(30) NOT NULL,
  fix_identity          varchar(200) NOT NULL,
  script_id             uuid REFERENCES scripts(id) ON DELETE CASCADE,
  script_version_id     uuid REFERENCES script_versions(id) ON DELETE CASCADE,
  builtin_action        varchar(60),
  playbook_id           uuid REFERENCES playbook_definitions(id) ON DELETE CASCADE,
  instructions_ref      varchar(120),
  attempts              integer NOT NULL DEFAULT 0,
  verified_count        integer NOT NULL DEFAULT 0,
  failed_count          integer NOT NULL DEFAULT 0,
  recurred_count        integer NOT NULL DEFAULT 0,
  up_votes              integer NOT NULL DEFAULT 0,
  down_votes            integer NOT NULL DEFAULT 0,
  rolling_success_rate  double precision NOT NULL DEFAULT 0,
  consecutive_failures  integer NOT NULL DEFAULT 0,
  consecutive_verified  integer NOT NULL DEFAULT 0,
  recent_outcomes       text[] NOT NULL DEFAULT '{}'::text[],
  status                varchar(20) NOT NULL DEFAULT 'active',
  retired_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  retired_at            timestamptz,
  last_verified_at      timestamptz,
  stale_since           timestamptz,
  -- Durable org-erasure rebuild requests (Task 12 markFixMemoryStaleForOrgErasure).
  -- Each id is an org whose counted outcomes fed this partner row when its erasure
  -- started. A rebuild removes an id only once that org's organizations row is
  -- gone (the cascade deletes it LAST), checked BEFORE the rebuild reads
  -- contributions. stale_since is cleared only when this is empty, so a rebuild
  -- that races the cascade, or a failed post-cascade rebuild, can never
  -- un-stale a row that still counts erased contributions. No FK: the id must
  -- outlive the org. Partner rows only (org rows die in the org cascade).
  rebuild_pending_org_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fix_memory_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL)),
  CONSTRAINT fix_memory_status_chk CHECK (status IN ('active', 'demoted', 'retired')),
  CONSTRAINT fix_memory_fix_kind_chk CHECK (fix_kind IN ('system_script', 'partner_script', 'org_script', 'builtin_action', 'playbook', 'manual_steps')),
  CONSTRAINT fix_memory_rate_chk CHECK (rolling_success_rate >= 0 AND rolling_success_rate <= 1)
);

-- Owner identity. Two partials because org rows carry partner_id NULL (XOR).
CREATE UNIQUE INDEX IF NOT EXISTS fix_memory_org_identity_uq
  ON fix_memory (org_id, signature_version, signature_key, os_type, fix_identity) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fix_memory_partner_identity_uq
  ON fix_memory (partner_id, signature_version, signature_key, os_type, fix_identity) WHERE partner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fix_memory_partner_id_idx ON fix_memory (partner_id);
CREATE INDEX IF NOT EXISTS fix_memory_lookup_idx ON fix_memory (signature_version, os_type, signature_key);
CREATE INDEX IF NOT EXISTS fix_memory_broad_idx ON fix_memory (signature_version, os_type, broad_key);
CREATE INDEX IF NOT EXISTS fix_memory_script_idx ON fix_memory (script_id) WHERE script_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fix_memory_stale_idx ON fix_memory (stale_since) WHERE stale_since IS NOT NULL;
CREATE INDEX IF NOT EXISTS fix_memory_rebuild_pending_idx
  ON fix_memory (partner_id) WHERE cardinality(rebuild_pending_org_ids) > 0;

ALTER TABLE fix_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE fix_memory FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fix_memory_isolation ON fix_memory;
CREATE POLICY fix_memory_isolation ON fix_memory
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

-- SELECT-only, never appended to the FOR ALL policy above (that would widen
-- UPDATE/DELETE targeting to partner rows for org tokens). `=` not
-- IS NOT DISTINCT FROM: a NULL current partner must match nothing.
DROP POLICY IF EXISTS fix_memory_partner_wide_select ON fix_memory;
CREATE POLICY fix_memory_partner_wide_select
  ON fix_memory
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON fix_memory TO breeze_app;

-- ---------------------------------------------------------------------------
-- 3. (no data backfill — both tables start empty)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 4. breeze_device_child_orgid_tables(): exclude fix_outcomes
-- ---------------------------------------------------------------------------
-- The helper is DYNAMIC (every public table with uuid device_id + uuid org_id,
-- minus this list), so section 1 silently enrolled fix_outcomes in the
-- device-move re-stamp loop. Outcome history stays with the org the attempt ran
-- in, and re-stamping org_id alone would violate fix_outcomes_org_partner_fk on
-- a cross-partner device move. Body copied VERBATIM from the newest definition,
-- 2026-10-26-160000-ai-operator-task-graph.sql section 8 (verified: no later
-- migration redefines it — re-run
-- `grep -l breeze_device_child_orgid_tables apps/api/migrations/*` before
-- committing and re-copy from the newest hit if that changed), with
-- 'fix_outcomes' added to the NOT IN list.
CREATE OR REPLACE FUNCTION public.breeze_device_child_orgid_tables()
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  AS $$
  SELECT t.relname::text
  FROM pg_class t
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relkind = 'r'
    AND t.relname <> 'devices'
    -- ai_agent_runs: agent-run history stays with the SOURCE org on a device
    -- move (owner decision 2026-08-23); its org_id is trigger-immutable.
    -- PAM lifecycle and result evidence is likewise source-frozen, but unlike
    -- agent runs its existence blocks the device move entirely.
    -- invoice_line_devices: billing evidence stays in its INVOICE's org on a
    -- device move. The invoice and its lines do not move, so restamping the
    -- evidence row's org_id here trips invoice_line_devices_line_org_fk /
    -- invoice_line_devices_invoice_org_fk (DEFERRABLE INITIALLY IMMEDIATE) at
    -- the end of the trigger's own statement. moveOrg.ts detaches device_id
    -- instead, and that statement is LOAD-BEARING, not a mirror of this loop
    -- (#3205 W07).
    -- ai_operator_tasks: AI Operator task history stays with the SOURCE org
    -- (#5205 W03, #5208). org_id is immutable and anchors composite
    -- (x, org_id) FKs, so a re-stamp aborts the move as soon as the task has
    -- an operation, an outbox wake, a target, a step, an event, a linked run
    -- or a linked intent. moveOrg.ts and this trigger both detach device_id
    -- and fence the task instead.
    -- ai_operator_task_targets (recipe library E2): same rule one level down.
    -- The target's org_id is its TASK's org_id and anchors
    -- ai_operator_task_targets_task_org_fk, so re-stamping it to the
    -- destination org while the task stays behind aborts the move with 23503.
    -- Section 9 detaches device_id and stamps the reason instead.
    -- fix_outcomes (AI Suggested Fixes W1): attempt history stays with the org
    -- the attempt ran in; (org_id, partner_id) composite FK would 23503 on a
    -- cross-partner move. The outcome sweeper cancels in-flight rows whose
    -- device left the org.
    AND t.relname NOT IN (
      'ai_agent_runs',
      'ai_operator_tasks',
      'ai_operator_task_targets',
      'pam_actuations',
      'pam_actuation_results',
      'invoice_line_devices',
      'offline_transition_effects',
      'fix_outcomes'
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attname = 'device_id'
        AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attname = 'org_id'
        AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
    );
$$;
```

- [ ] **Step 4: Write the Drizzle schema**

```ts
// apps/api/src/db/schema/fixMemory.ts
import { sql } from 'drizzle-orm';
import {
  char, doublePrecision, index, integer, jsonb, pgTable, smallint, text, timestamp, uniqueIndex, uuid, varchar,
} from 'drizzle-orm/pg-core';
import type { FixKind, FixMemoryStatus, FixOutcomeState, FixVote } from '@breeze/shared';
import { alerts } from './alerts';
import { metricAnomalyEpisodes } from './metricAnomalyEpisodes';
import { organizations, partners } from './orgs';
import { playbookDefinitions } from './playbooks';
import { remediationSuggestions } from './remediationSuggestions';
import { scriptExecutions, scripts, scriptVersions } from './scripts';
import { users } from './users';

/**
 * One row per fix attempt (AI Suggested Fixes W1). Shape 1 RLS on org_id.
 * The composite (org_id, partner_id) → organizations(id, partner_id) FK
 * (DEFERRABLE) and the cross-column shape CHECKs live in the migration only —
 * same convention as aiAgentFixWatches. device_id deliberately has no FK and
 * is never re-stamped on a device move (history stays with the source org).
 */
export const fixOutcomes = pgTable('fix_outcomes', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  partnerId: uuid('partner_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  suggestionId: uuid('suggestion_id').references(() => remediationSuggestions.id, { onDelete: 'set null' }),
  sourceType: varchar('source_type', { length: 20 }).$type<'alert' | 'anomaly' | 'correlation' | 'rca'>().notNull(),
  sourceId: varchar('source_id', { length: 255 }).notNull(),
  alertId: uuid('alert_id').references(() => alerts.id, { onDelete: 'set null' }),
  anomalyEpisodeId: uuid('anomaly_episode_id').references(() => metricAnomalyEpisodes.id, { onDelete: 'set null' }),
  signatureVersion: smallint('signature_version'),
  signatureKey: char('signature_key', { length: 64 }),
  broadKey: char('broad_key', { length: 64 }),
  signatureFacets: jsonb('signature_facets'),
  osType: varchar('os_type', { length: 20 }),
  fixKind: varchar('fix_kind', { length: 30 }).$type<FixKind>().notNull(),
  fixIdentity: varchar('fix_identity', { length: 200 }),
  scriptId: uuid('script_id').references(() => scripts.id, { onDelete: 'set null' }),
  scriptVersionId: uuid('script_version_id').references(() => scriptVersions.id, { onDelete: 'set null' }),
  builtinAction: varchar('builtin_action', { length: 60 }),
  playbookId: uuid('playbook_id').references(() => playbookDefinitions.id, { onDelete: 'set null' }),
  instructionsRef: varchar('instructions_ref', { length: 120 }),
  scriptExecutionId: uuid('script_execution_id').references(() => scriptExecutions.id, { onDelete: 'set null' }),
  state: varchar('state', { length: 30 }).$type<FixOutcomeState>().notNull().default('pending'),
  stateReason: varchar('state_reason', { length: 80 }),
  humanVote: varchar('human_vote', { length: 10 }).$type<FixVote>(),
  votedBy: uuid('voted_by').references(() => users.id, { onDelete: 'set null' }),
  votedAt: timestamp('voted_at', { withTimezone: true }),
  recoveredAt: timestamp('recovered_at', { withTimezone: true }),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
  holdingUntil: timestamp('holding_until', { withTimezone: true }),
  terminalAt: timestamp('terminal_at', { withTimezone: true }),
  countedAt: timestamp('counted_at', { withTimezone: true }),
  recountRequestedAt: timestamp('recount_requested_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  suggestionUq: uniqueIndex('fix_outcomes_suggestion_uq').on(t.suggestionId).where(sql`suggestion_id IS NOT NULL`),
  activeIdx: index('fix_outcomes_active_idx').on(t.state, t.deadlineAt),
  orgCreatedIdx: index('fix_outcomes_org_created_idx').on(t.orgId, t.createdAt),
  deviceStateIdx: index('fix_outcomes_device_state_idx').on(t.deviceId, t.state),
}));

/**
 * Derived partner-wide / org-private aggregate. org_id XOR partner_id
 * (fix_memory_one_owner_chk). Written ONLY by services/fixMemory/store.ts.
 * Stores counts and ids — never hostnames, alert text, output or prose.
 */
export const fixMemory = pgTable('fix_memory', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
  signatureVersion: smallint('signature_version').notNull(),
  signatureKey: char('signature_key', { length: 64 }).notNull(),
  broadKey: char('broad_key', { length: 64 }).notNull(),
  osType: varchar('os_type', { length: 20 }).notNull(),
  fixKind: varchar('fix_kind', { length: 30 }).$type<FixKind>().notNull(),
  fixIdentity: varchar('fix_identity', { length: 200 }).notNull(),
  scriptId: uuid('script_id').references(() => scripts.id, { onDelete: 'cascade' }),
  scriptVersionId: uuid('script_version_id').references(() => scriptVersions.id, { onDelete: 'cascade' }),
  builtinAction: varchar('builtin_action', { length: 60 }),
  playbookId: uuid('playbook_id').references(() => playbookDefinitions.id, { onDelete: 'cascade' }),
  instructionsRef: varchar('instructions_ref', { length: 120 }),
  attempts: integer('attempts').notNull().default(0),
  verifiedCount: integer('verified_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  recurredCount: integer('recurred_count').notNull().default(0),
  upVotes: integer('up_votes').notNull().default(0),
  downVotes: integer('down_votes').notNull().default(0),
  rollingSuccessRate: doublePrecision('rolling_success_rate').notNull().default(0),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  consecutiveVerified: integer('consecutive_verified').notNull().default(0),
  recentOutcomes: text('recent_outcomes').array().notNull().default(sql`'{}'::text[]`),
  status: varchar('status', { length: 20 }).$type<FixMemoryStatus>().notNull().default('active'),
  retiredBy: uuid('retired_by').references(() => users.id, { onDelete: 'set null' }),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  staleSince: timestamp('stale_since', { withTimezone: true }),
  /** Durable org-erasure rebuild requests; stale_since cannot clear while non-empty (see migration). */
  rebuildPendingOrgIds: uuid('rebuild_pending_org_ids').array().notNull().default(sql`'{}'::uuid[]`),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  orgIdentityUq: uniqueIndex('fix_memory_org_identity_uq')
    .on(t.orgId, t.signatureVersion, t.signatureKey, t.osType, t.fixIdentity).where(sql`org_id IS NOT NULL`),
  partnerIdentityUq: uniqueIndex('fix_memory_partner_identity_uq')
    .on(t.partnerId, t.signatureVersion, t.signatureKey, t.osType, t.fixIdentity).where(sql`partner_id IS NOT NULL`),
  lookupIdx: index('fix_memory_lookup_idx').on(t.signatureVersion, t.osType, t.signatureKey),
  broadIdx: index('fix_memory_broad_idx').on(t.signatureVersion, t.osType, t.broadKey),
}));

export type FixOutcomeRow = typeof fixOutcomes.$inferSelect;
export type FixMemoryRow = typeof fixMemory.$inferSelect;
```

Add to `apps/api/src/db/schema/index.ts`, directly after `export * from './remediationSuggestions';`:

```ts
export * from './fixMemory';
```

- [ ] **Step 5: Run the test, the typecheck and the migration guards**

Run: `cd apps/api && npx vitest run src/db/schema/fixMemory.registry.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, and tsc exits 0.

Run: `bash scripts/check-migration-naming.sh --staged` (after `git add` of the migration).
Expected: no VIOLATION.

- [ ] **Step 6: Prove the migration applies on a fresh database (real Postgres)**

`db:check-drift` only verifies the `breeze_migrations` ledger (`apps/api/scripts/check-drift.ts` header), so apply the migrations first:

```bash
pnpm test-stack up
DB_URL=$(grep '^DATABASE_URL=' .env.test | cut -d= -f2-)
DATABASE_URL="$DB_URL" pnpm db:migrate
DATABASE_URL="$DB_URL" pnpm db:migrate   # second run must be a no-op (idempotency)
DATABASE_URL="$DB_URL" pnpm db:check-drift
```
Expected: both migrate runs exit 0, and the drift check passes with one ledger row per migration file, including `2026-11-01-100000-fix-memory-tables.sql`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-11-01-100000-fix-memory-tables.sql apps/api/src/db/schema/fixMemory.ts apps/api/src/db/schema/index.ts apps/api/src/db/schema/fixMemory.registry.test.ts
git commit -m "feat(api): fix_outcomes and fix_memory tables with RLS

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: Every cascade / merge / export / RLS registration (unit + integration contracts)

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts` (in `CORE_ORG_CASCADE_DELETE_ORDER`, after `'executive_summaries',` ~L522)
- Modify: `apps/api/src/routes/devices/core.ts`
  - `CORE_DEVICE_CASCADE_DELETE_TABLES`: after `'ai_agent_fix_watches',` ~L607
  - the comment block above `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (~L253–262)
- Modify: `apps/api/src/routes/devices/moveOrg.coverage.test.ts` (`INTENTIONALLY_NO_ORG_ID`, after `'ai_agent_fix_watches',` ~L66)
- Modify: `apps/api/src/services/orgMergeRegistry.ts` (`SPECIAL`, after the `ai_agent_op_evidence` entry ~L328)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (after the `"executive_summaries"` entry ~L333)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`DUAL_AXIS_TENANT_TABLES` ~L399, `XOR_OWNERSHIP_DUAL_AXIS_TABLES` ~L768)
- Test: `apps/api/src/db/schema/fixMemory.registry.test.ts` (extend)

**Interfaces:**
- Consumes: the Task 2 tables.
- Produces: no runtime API. Only registrations.

- [ ] **Step 1: Extend the registry test (failing)**

Append to `apps/api/src/db/schema/fixMemory.registry.test.ts`:

```ts
import { getOrgCascadeDeleteOrder } from '../../services/tenantCascade';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';
import { __testOnly as orgMergeRegistryTestOnly } from '../../services/orgMergeRegistry';

describe('fix memory registrations', () => {
  it('both tables are in the org cascade order, alphabetically between executive_summaries and fleet_design_applied_items', () => {
    const order = getOrgCascadeDeleteOrder();
    const at = (t: string) => order.indexOf(t);
    expect(at('fix_memory')).toBeGreaterThan(at('executive_summaries'));
    expect(at('fix_outcomes')).toBeGreaterThan(at('fix_memory'));
    expect(at('fleet_design_applied_items')).toBeGreaterThan(at('fix_outcomes'));
  });

  it('both tables are leave-for-erasure in the merge registry', () => {
    expect(orgMergeRegistryTestOnly.SPECIAL['fix_outcomes']?.kind).toBe('leave-for-erasure');
    expect(orgMergeRegistryTestOnly.SPECIAL['fix_memory']?.kind).toBe('leave-for-erasure');
  });

  it('export policy classifies signature_facets as an excluded open container and keys by org_id', () => {
    const outcomes = CORE_TENANT_EXPORT_POLICY['fix_outcomes'];
    const memory = CORE_TENANT_EXPORT_POLICY['fix_memory'];
    expect(outcomes).toBeDefined();
    expect(memory).toBeDefined();
    expect(outcomes!.columns['signature_facets']).toMatchObject({ decision: 'exclude', openContainerReviewed: true });
    expect(outcomes!.columns['signature_key']?.decision).toBe('include');
    expect(memory!.columns['recent_outcomes']?.decision).toBe('include');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/db/schema/fixMemory.registry.test.ts`
Expected: FAIL. `at('fix_memory')` is `-1`, `SPECIAL['fix_outcomes']` is `undefined`, and `CORE_TENANT_EXPORT_POLICY['fix_outcomes']` is `undefined`.

- [ ] **Step 3: Implement the registrations**

`apps/api/src/services/tenantCascade.ts`, inside `CORE_ORG_CASCADE_DELETE_ORDER`, directly after `'executive_summaries',`:

```ts
  // AI Suggested Fixes W1: fix_memory is dual-owner (org_id XOR partner_id).
  // Org rows cascade with the org; partner rows (org_id NULL) are untouched by
  // an org erasure and are rebuilt by jobs/tenantErasure.ts afterwards. FKs out
  // only (scripts/script_versions/playbooks CASCADE, users SET NULL).
  'fix_memory',
  // fix_outcomes: one row per attempt, leaf table (FKs out only, all with an
  // explicit ON DELETE). Cascades after nothing that references it.
  'fix_outcomes',
```

`apps/api/src/routes/devices/core.ts`, inside `CORE_DEVICE_CASCADE_DELETE_TABLES`, directly after `'ai_agent_fix_watches',`:

```ts
  // AI Suggested Fixes W1 — attempt history for a deleted device goes with it
  // (no device FK; leaf table). The org-cascade + rebuild keeps partner memory
  // consistent on the next rebuild.
  'fix_outcomes',
```

Also in `core.ts`, in the doc comment above `CORE_DEVICE_ORG_DENORMALIZED_TABLES`, add this paragraph after the `ai_agent_fix_watches` paragraph:

```ts
 * fix_outcomes is deliberately ABSENT too (AI Suggested Fixes W1): it has
 * org_id and device_id but is cascade-deleted, not moved — identical
 * reasoning to ai_agent_fix_watches: an attempt's proof belongs to the org it
 * ran in, and its (org_id, partner_id) composite FK would 23503 on a
 * cross-partner move. It is excluded from breeze_device_child_orgid_tables()
 * by 2026-11-01-100000-fix-memory-tables.sql and listed in
 * INTENTIONALLY_NO_ORG_ID in moveOrg.coverage.test.ts. The outcome sweeper
 * cancels in-flight rows whose device left the org.
```

`apps/api/src/routes/devices/moveOrg.coverage.test.ts`, inside `INTENTIONALLY_NO_ORG_ID`, directly after `'ai_agent_fix_watches',`:

```ts
  // Has org_id AND device_id, but org_id is intentionally NOT re-stamped on
  // move: fix-outcome history stays with the org the attempt ran in (AI
  // Suggested Fixes W1) — see the CORE_DEVICE_ORG_DENORMALIZED_TABLES comment
  // in core.ts.
  'fix_outcomes',
```

`apps/api/src/services/orgMergeRegistry.ts`, inside `SPECIAL`, directly after the `ai_agent_op_evidence` entry:

```ts
  // AI Suggested Fixes W1. fix_outcomes: each row is one historical attempt in
  // the org it ran in; restamping would double-count or re-attribute proof.
  // fix_memory: derived; org rows are recomputed from fix_outcomes, partner
  // rows (org_id NULL) are not merge participants. The loser's rows die with
  // the loser shell and jobs/tenantErasure.ts rebuilds the partner aggregate.
  fix_outcomes: { kind: 'leave-for-erasure', note: 'attempt history stays with the org it ran in; restamping would double-count proof. Rows die with the loser shell; tenantErasure rebuilds partner memory' },
  fix_memory: { kind: 'leave-for-erasure', note: 'derived aggregate: org rows are rebuilt from fix_outcomes (which stay with the loser); partner rows have org_id NULL and are not merge participants' },
```

`apps/api/src/services/tenantExportPolicyRegistry.ts`, directly after the `"executive_summaries"` entry:

```ts
  // AI Suggested Fixes W1. signature_facets is jsonb -> excludedOpen (CLAUDE.md).
  // signature_key / broad_key are sha256 hex of structured facets, not secrets
  // (neither matches SUSPICIOUS_NAME_PARTS). rebuild_pending_org_ids is a uuid[]
  // of tenant identifiers, not json/jsonb/bytea, so `included` (precedent:
  // ai_agent_runs.intent_ids).
  "fix_memory": tablePolicy("org_id", {"included":["id","org_id","partner_id","signature_version","signature_key","broad_key","os_type","fix_kind","fix_identity","script_id","script_version_id","builtin_action","playbook_id","instructions_ref","attempts","verified_count","failed_count","recurred_count","up_votes","down_votes","rolling_success_rate","consecutive_failures","consecutive_verified","recent_outcomes","status","retired_by","retired_at","last_verified_at","stale_since","rebuild_pending_org_ids","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
  "fix_outcomes": tablePolicy("org_id", {"included":["id","org_id","partner_id","device_id","suggestion_id","source_type","source_id","alert_id","anomaly_episode_id","signature_version","signature_key","broad_key","os_type","fix_kind","fix_identity","script_id","script_version_id","builtin_action","playbook_id","instructions_ref","script_execution_id","state","state_reason","human_vote","voted_by","voted_at","recovered_at","deadline_at","holding_until","terminal_at","counted_at","recount_requested_at","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["signature_facets"]}),
```

`apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`:
- Inside `DUAL_AXIS_TENANT_TABLES`, directly after `'caller_verification_policies',`:

```ts
  // fix_memory (AI Suggested Fixes W1): org XOR partner via
  // fix_memory_one_owner_chk; SELECT-only partner-wide branch
  // fix_memory_partner_wide_select ships in 2026-11-01-100000. Functional
  // forge proof: fixMemoryPartnerRls.integration.test.ts.
  'fix_memory',
```

- Inside `XOR_OWNERSHIP_DUAL_AXIS_TABLES`, directly after `'caller_verification_policies',`:

```ts
  // fix_memory_one_owner_chk, 2026-11-01-100000 (AI Suggested Fixes W1); its
  // partner-wide SELECT branch ships in the same migration.
  'fix_memory',
```

- [ ] **Step 4: Run the unit contracts**

Run: `cd apps/api && npx vitest run src/db/schema/fixMemory.registry.test.ts src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts src/services/orgMerge.test.ts`
Expected: PASS. `orgMerge.test.ts` only reds on a missing policy in the full run, so also run `cd apps/api && npx vitest run src/services/orgMerge` and check that the reported file count is >1.

- [ ] **Step 5: Run the DB-backed contracts (real Postgres)**

Run: `pnpm test-stack up`, then

```bash
(cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts
cd apps/api && DB_CONTEXTLESS_WRITE_STRICT=true pnpm test:rls-coverage
```

Expected: PASS on all of them. In rls-coverage, `fix_memory` passes the partner-wide SELECT branch assertion, and `fix_outcomes` is auto-discovered as a direct `org_id` table.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts apps/api/src/routes/devices/moveOrg.coverage.test.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/db/schema/fixMemory.registry.test.ts
git commit -m "feat(api): register fix memory tables in cascade, merge, export and RLS contracts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: `remediation_suggestions.origin` + `manual_steps`, and `alerts.resolution_reason` (unit contract + drift)

**Files:**
- Create: `apps/api/migrations/2026-11-01-100100-remediation-suggestion-origin.sql`
- Create: `apps/api/migrations/2026-11-01-100200-alert-resolution-reason.sql`
- Modify: `apps/api/src/db/schema/remediationSuggestions.ts` (after `expectedAction`, ~L41)
- Modify: `apps/api/src/db/schema/alerts.ts` (after `resolutionNote`, inside `alerts`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`"alerts"` ~L130 and `"remediation_suggestions"` ~L569 `included` arrays)
- Test: `apps/api/src/db/schema/fixMemory.registry.test.ts` (extend)

**Interfaces:**
- Produces:
  - `remediationSuggestions.origin: RemediationSuggestionOrigin` (default `'catalog_match'`);
  - `target_type` now also accepts `'manual_steps'`;
  - `alerts.resolutionReason: AlertResolutionReason | null`.

- [ ] **Step 1: Extend the registry test (failing)**

```ts
import { ALERT_RESOLUTION_REASONS, REMEDIATION_SUGGESTION_ORIGINS } from '@breeze/shared';
import { alerts } from './alerts';
import { remediationSuggestions } from './remediationSuggestions';

const ORIGIN_SQL = readFileSync(new URL('../../../migrations/2026-11-01-100100-remediation-suggestion-origin.sql', import.meta.url), 'utf8');
const REASON_SQL = readFileSync(new URL('../../../migrations/2026-11-01-100200-alert-resolution-reason.sql', import.meta.url), 'utf8');

describe('suggestion origin + alert resolution reason', () => {
  it('origin CHECK mirrors REMEDIATION_SUGGESTION_ORIGINS and defaults existing rows to catalog_match', () => {
    expect(checkConstraintLiterals(ORIGIN_SQL, 'remediation_suggestions_origin_check', 'origin').sort())
      .toEqual([...REMEDIATION_SUGGESTION_ORIGINS].sort());
    expect(ORIGIN_SQL).toMatch(/ADD COLUMN IF NOT EXISTS origin varchar\(20\) NOT NULL DEFAULT 'catalog_match'/);
    expect(checkConstraintLiterals(ORIGIN_SQL, 'remediation_suggestions_target_type_check', 'target_type'))
      .toContain('manual_steps');
  });

  it('resolution_reason CHECK mirrors ALERT_RESOLUTION_REASONS', () => {
    expect(checkConstraintLiterals(REASON_SQL, 'alerts_resolution_reason_check', 'resolution_reason').sort())
      .toEqual([...ALERT_RESOLUTION_REASONS].sort());
  });

  it('Drizzle exposes the new columns and export policy classifies them', () => {
    expect(remediationSuggestions).toHaveProperty('origin');
    expect(alerts).toHaveProperty('resolutionReason');
    expect(CORE_TENANT_EXPORT_POLICY['remediation_suggestions']!.columns['origin']?.decision).toBe('include');
    expect(CORE_TENANT_EXPORT_POLICY['alerts']!.columns['resolution_reason']?.decision).toBe('include');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/db/schema/fixMemory.registry.test.ts`
Expected: FAIL with `ENOENT` for `2026-11-01-100100-remediation-suggestion-origin.sql`.

- [ ] **Step 3: Write both migrations**

```sql
-- apps/api/migrations/2026-11-01-100100-remediation-suggestion-origin.sql
-- AI Suggested Fixes W1: where a suggestion came from, plus the manual-steps
-- target type the Done action records outcomes for (W2 produces those rows).
-- Existing rows are keyword-matcher output -> 'catalog_match' via the column
-- DEFAULT (DDL, not a row write). Idempotent; no inner BEGIN/COMMIT.

ALTER TABLE remediation_suggestions
  ADD COLUMN IF NOT EXISTS origin varchar(20) NOT NULL DEFAULT 'catalog_match';

ALTER TABLE remediation_suggestions DROP CONSTRAINT IF EXISTS remediation_suggestions_origin_check;
ALTER TABLE remediation_suggestions
  ADD CONSTRAINT remediation_suggestions_origin_check CHECK (origin IN ('catalog_match', 'memory', 'ai_research'));

ALTER TABLE remediation_suggestions DROP CONSTRAINT IF EXISTS remediation_suggestions_target_type_check;
ALTER TABLE remediation_suggestions
  ADD CONSTRAINT remediation_suggestions_target_type_check CHECK (target_type IN ('script', 'script_template', 'playbook', 'diagnostic', 'manual_steps'));

ALTER TABLE remediation_suggestions DROP CONSTRAINT IF EXISTS remediation_suggestions_target_check;
ALTER TABLE remediation_suggestions
  ADD CONSTRAINT remediation_suggestions_target_check CHECK (
    (target_type = 'script' AND script_id IS NOT NULL)
    OR (target_type = 'script_template' AND script_template_id IS NOT NULL)
    OR (target_type = 'playbook' AND playbook_id IS NOT NULL)
    OR (target_type = 'diagnostic')
    OR (target_type = 'manual_steps')
  );

CREATE INDEX IF NOT EXISTS remediation_suggestions_origin_idx
  ON remediation_suggestions (org_id, origin) WHERE origin <> 'catalog_match';
```

```sql
-- apps/api/migrations/2026-11-01-100200-alert-resolution-reason.sql
-- AI Suggested Fixes W1 (open item 5): WHY an alert resolved, persisted so the
-- outcome sweeper can distinguish an objective condition-clear from a human,
-- cleanup or expiry resolve after the fact. NULL = unspecified (pre-existing
-- rows and direct-UPDATE paths) and is treated as NOT a recovery (fail
-- closed). Nullable, no default: a metadata-only ALTER on a hot table.

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolution_reason varchar(40);

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_resolution_reason_check;
ALTER TABLE alerts
  ADD CONSTRAINT alerts_resolution_reason_check CHECK (resolution_reason IN ('condition_cleared', 'source_retired', 'expired', 'manual')) NOT VALID;
```

- [ ] **Step 4: Drizzle + export policy**

In `apps/api/src/db/schema/remediationSuggestions.ts`:
- Add `import type { RemediationSuggestionOrigin } from '@breeze/shared';` to the imports.
- Add this line after `expectedAction: text('expected_action').notNull(),`:

```ts
  origin: varchar('origin', { length: 20 }).$type<RemediationSuggestionOrigin>().notNull().default('catalog_match'),
```

In `apps/api/src/db/schema/alerts.ts`:
- Add `import type { AlertResolutionReason } from '@breeze/shared';` to the imports.
- Inside `alerts`, add this line after `resolutionNote: text('resolution_note'),`:

```ts
  resolutionReason: varchar('resolution_reason', { length: 40 }).$type<AlertResolutionReason>(),
```

In `tenantExportPolicyRegistry.ts`:
- Append `"resolution_reason"` to the `"alerts"` `included` array, after `"resolution_note"`.
- Append `"origin"` to the `"remediation_suggestions"` `included` array, after `"expected_action"`.

- [ ] **Step 5: Run the tests, typecheck and drift**

Run: `cd apps/api && npx vitest run src/db/schema/fixMemory.registry.test.ts src/db/autoMigrate.test.ts src/routes/remediationSuggestions.test.ts src/services/remediationSuggestions.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

Run:

```bash
DB_URL=$(grep '^DATABASE_URL=' .env.test | cut -d= -f2-)
DATABASE_URL="$DB_URL" pnpm db:migrate && DATABASE_URL="$DB_URL" pnpm db:check-drift
(cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts)
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-11-01-100100-remediation-suggestion-origin.sql apps/api/migrations/2026-11-01-100200-alert-resolution-reason.sql apps/api/src/db/schema/remediationSuggestions.ts apps/api/src/db/schema/alerts.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/db/schema/fixMemory.registry.test.ts
git commit -m "feat(api): suggestion origin, manual-steps target and alert resolution reason columns

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5: RLS proofs for `fix_memory` / `fix_outcomes` (real Postgres)

**Files:**
- Create: `apps/api/src/__tests__/integration/fixMemoryPartnerRls.integration.test.ts`

**Interfaces:**
- Consumes: `db`, `withDbAccessContext`, `DbAccessContext` (`db/index.ts`), `createPartner`, `createOrganization` (`./db-utils`), `pgErrorCode` (`../../utils/pgErrors`).

- [ ] **Step 1: Write the test (it must go red first — see Step 2)**

```ts
// apps/api/src/__tests__/integration/fixMemoryPartnerRls.integration.test.ts
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { fixMemory, fixOutcomes } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null };
const partnerContext = (partnerId: string, orgIds: string[]): DbAccessContext => ({
  scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null, currentPartnerId: partnerId,
});
const orgContext = (orgId: string, currentPartnerId: string | null): DbAccessContext => ({
  scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId,
});

async function expectSqlState(fn: () => Promise<unknown>, code: string) {
  let raised: unknown;
  try { await fn(); } catch (err) { raised = err; }
  expect(raised, `expected SQLSTATE ${code}`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
}

const KEY = 'a'.repeat(64);
const memoryRow = (owner: { orgId?: string | null; partnerId?: string | null }) => ({
  orgId: owner.orgId ?? null, partnerId: owner.partnerId ?? null,
  signatureVersion: 1, signatureKey: KEY, broadKey: KEY, osType: 'windows',
  fixKind: 'builtin_action' as const, fixIdentity: `builtin:reboot:${randomUUID()}`, builtinAction: 'reboot',
});
const outcomeRow = (orgId: string, partnerId: string) => ({
  orgId, partnerId, deviceId: randomUUID(), sourceType: 'alert' as const, sourceId: randomUUID(),
  fixKind: 'builtin_action' as const, deadlineAt: new Date(Date.now() + 3_600_000),
});

async function fixture() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA1 = await createOrganization({ partnerId: partnerA.id });
  const orgA2 = await createOrganization({ partnerId: partnerA.id });
  const orgB1 = await createOrganization({ partnerId: partnerB.id });
  return { partnerA: partnerA.id, partnerB: partnerB.id, orgA1: orgA1.id, orgA2: orgA2.id, orgB1: orgB1.id };
}

const createdMemory: string[] = [];
afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (createdMemory.length) await db.delete(fixMemory).where(inArray(fixMemory.id, createdMemory.splice(0)));
  });
});

async function seedMemory(owner: { orgId?: string | null; partnerId?: string | null }) {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(fixMemory).values(memoryRow(owner)).returning());
  createdMemory.push(row!.id);
  return row!;
}

describe('fix_memory / fix_outcomes RLS', () => {
  it('forbids forging another tenant’s rows (42501)', async () => {
    const f = await fixture();
    await expectSqlState(() => withDbAccessContext(orgContext(f.orgB1, f.partnerB), () =>
      db.insert(fixMemory).values(memoryRow({ orgId: f.orgA1 }))), '42501');
    await expectSqlState(() => withDbAccessContext(partnerContext(f.partnerB, [f.orgB1]), () =>
      db.insert(fixMemory).values(memoryRow({ partnerId: f.partnerA }))), '42501');
    await expectSqlState(() => withDbAccessContext(orgContext(f.orgB1, f.partnerB), () =>
      db.insert(fixOutcomes).values(outcomeRow(f.orgA1, f.partnerA))), '42501');
  });

  it('enforces the XOR owner check (23514)', async () => {
    const f = await fixture();
    for (const owner of [{ orgId: null, partnerId: null }, { orgId: f.orgA1, partnerId: f.partnerA }]) {
      await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () => db.insert(fixMemory).values(memoryRow(owner))), '23514');
    }
  });

  it('rejects an outcome whose partner does not own its org (23503)', async () => {
    const f = await fixture();
    await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(fixOutcomes).values(outcomeRow(f.orgA1, f.partnerB))), '23503');
  });

  it('org tokens read their partner’s rows through the SELECT branch but cannot write them', async () => {
    const f = await fixture();
    const row = await seedMemory({ partnerId: f.partnerA });
    await withDbAccessContext(orgContext(f.orgA1, f.partnerA), async () => {
      expect(await db.select().from(fixMemory).where(eq(fixMemory.id, row.id))).toHaveLength(1);
      expect(await db.update(fixMemory).set({ attempts: 99 }).where(eq(fixMemory.id, row.id)).returning()).toEqual([]);
      expect(await db.delete(fixMemory).where(eq(fixMemory.id, row.id)).returning()).toEqual([]);
    });
    await expectSqlState(() => withDbAccessContext(orgContext(f.orgA1, f.partnerA), () =>
      db.insert(fixMemory).values(memoryRow({ partnerId: f.partnerA }))), '42501');
  });

  it('never shows another partner’s rows or a sibling org’s private rows', async () => {
    const f = await fixture();
    const partnerRow = await seedMemory({ partnerId: f.partnerA });
    const privateRow = await seedMemory({ orgId: f.orgA1 });
    await withDbAccessContext(orgContext(f.orgB1, f.partnerB), async () => {
      expect(await db.select().from(fixMemory).where(inArray(fixMemory.id, [partnerRow.id, privateRow.id]))).toEqual([]);
    });
    await withDbAccessContext(orgContext(f.orgA2, f.partnerA), async () => {
      const ids = (await db.select({ id: fixMemory.id }).from(fixMemory)
        .where(inArray(fixMemory.id, [partnerRow.id, privateRow.id]))).map((r) => r.id);
      expect(ids).toEqual([partnerRow.id]);
    });
    await withDbAccessContext(orgContext(f.orgA1, f.partnerA), async () => {
      const ids = (await db.select({ id: fixMemory.id }).from(fixMemory)
        .where(inArray(fixMemory.id, [partnerRow.id, privateRow.id]))).map((r) => r.id).sort();
      expect(ids).toEqual([partnerRow.id, privateRow.id].sort());
    });
  });

  it('headless agent-auth context (org-scoped, no partner access, currentPartnerId set) reads partner memory; without currentPartnerId it does not', async () => {
    const f = await fixture();
    const row = await seedMemory({ partnerId: f.partnerA });
    await withDbAccessContext(orgContext(f.orgA1, f.partnerA), async () => {
      expect(await db.select().from(fixMemory).where(eq(fixMemory.id, row.id))).toHaveLength(1);
    });
    await withDbAccessContext(orgContext(f.orgA1, null), async () => {
      expect(await db.select().from(fixMemory).where(eq(fixMemory.id, row.id))).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Watch it fail against a control, then pass**

Mutation control, to prove the suite discriminates:
1. On a scratch database, run `DROP POLICY fix_memory_partner_wide_select ON fix_memory;`.
2. Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/fixMemoryPartnerRls.integration.test.ts`
   Expected: FAIL in "org tokens read their partner’s rows…" and "headless agent-auth…" (`toHaveLength(1)` receives 0).
3. Run `pnpm test-stack down && pnpm test-stack up` to restore the migrated schema.
4. Re-run the same command.
   Expected: PASS (6 tests).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/fixMemoryPartnerRls.integration.test.ts
git commit -m "test(api): RLS proofs for fix memory tables

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 6: Signature v1 — pure canonicalisation and per-source condition semantics (unit)

This task resolves spec open item 2 in code. The condition-semantics fields per source family are:

- **Rule-based alerts (`alerts.rule_id` set).** The condition comes from `alert_rules.override_settings.conditions`, falling back to `alert_templates.conditions` (the same precedence as `checkAutoResolve`, `alertService.ts:555-568`). Each leaf's `type` (`alertConditions/types.ts:188-205`) becomes a token, together with that type's org-independent enum fields:
  - metric + direction;
  - event_log category + level;
  - antivirus / backup_continuity `check`;
  - bandwidth / disk_io `direction`;
  - network_errors `errorType`;
  - hardware_health `componentTypes`;
  - software_presence `presence`.
  UUID-bearing fields are dropped: `script_monitor.monitorId` and `network_check.monitorId`. Groups become `and(...)` / `or(...)` over sorted tokens.
- **Rule-less sourced alerts.** The token is `alerts.context.source` plus that source's structured subtype:
  - `network_monitor.monitorType`;
  - `script_exit_code.scriptId`;
  - `patch-job-finalizer.category`;
  - `backup_provider.providerKey`/`condition`.
  Per-source keys are listed in `monitorWorker.ts:411-423`, `scriptExitCodeAlerts.ts:150-157`, `patchAlerts.ts:264-269`, `backupProviders/alerts.ts:364-371`. `monitor_recurrence` (a human escalation) gets no signature. `metric_anomaly` routes to the anomaly family.
- **Anomalies.** The condition is `anomaly:` + `episodeKeyFor(source_table, anomaly_type, metric_name).episodeKey` (`metricAnomalyEpisodeKeys.ts:74-90`), i.e. source_table + anomaly_type + metric family.
- **Correlation.** The condition is the root alert's (earliest-triggered, `alertCorrelationGroups.ts:38-43,81`) semantics, with family `correlation` and `rootInferred: true`.
- **Discriminator.** It is taken only from structured fields:
  - `service_stopped.serviceName` → `service`;
  - `process_*.processName` → `process`;
  - `software_presence.name` → `software`;
  - `script_exit_code.exitCode` → `exit_code`.
  It is set only when exactly one leaf yields one. No structured KB or event-id field exists on alerts today (`event_log` conditions carry only free-text patterns), so the `kb` / `event_id` kinds are reserved and unused in v1.

**Files:**
- Create: `apps/api/src/services/fixMemory/signature.ts`
- Test: `apps/api/src/services/fixMemory/signature.test.ts`

**Interfaces:**
- Consumes: `canonicalizeArguments` from `@breeze/shared/canonicalize`; `FIX_SIGNATURE_VERSION`, `FixDiscriminatorKind`, `FixSignatureFamily` from `@breeze/shared`.
- Produces:
  ```ts
  export type FixOsFamily = 'windows' | 'macos' | 'linux';
  export interface FixDiscriminator { kind: FixDiscriminatorKind; value: string }
  export interface SignatureFacets { family: FixSignatureFamily; condition: string; osFamily: FixOsFamily; discriminator: FixDiscriminator | null; rootInferred: boolean }
  export interface FixSignature { version: 1; key: string; broadKey: string; broad: boolean; facets: SignatureFacets }
  export interface ConditionFacets { condition: string; discriminator: FixDiscriminator | null }
  export function computeSignature(facets: SignatureFacets): FixSignature | null;
  export function ruleConditionFacets(root: unknown): ConditionFacets | null;
  export function sourcedAlertFacets(context: Record<string, unknown> | null): ConditionFacets | null;
  export function alertConditionFacets(input: { requiresHuman: boolean; context: Record<string, unknown> | null; ruleConditions: unknown | null }): ConditionFacets | null;
  export function anomalyConditionFacets(episodeKey: string): ConditionFacets;
  export function isFixOsFamily(value: unknown): value is FixOsFamily;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/fixMemory/signature.test.ts
import { describe, expect, it } from 'vitest';
import {
  alertConditionFacets, anomalyConditionFacets, computeSignature, ruleConditionFacets, sourcedAlertFacets,
  type SignatureFacets,
} from './signature';

const base: SignatureFacets = { family: 'alert', condition: 'rule:service_stopped', osFamily: 'windows', discriminator: { kind: 'service', value: 'spooler' }, rootInferred: false };

describe('computeSignature', () => {
  it('is stable across runs and 64 hex chars', () => {
    const a = computeSignature(base)!;
    const b = computeSignature({ ...base })!;
    expect(a.key).toBe(b.key);
    expect(a.key).toMatch(/^[0-9a-f]{64}$/);
    expect(a.version).toBe(1);
  });

  it('differs by OS, family, condition and discriminator', () => {
    const k = computeSignature(base)!.key;
    expect(computeSignature({ ...base, osFamily: 'linux' })!.key).not.toBe(k);
    expect(computeSignature({ ...base, family: 'correlation' })!.key).not.toBe(k);
    expect(computeSignature({ ...base, condition: 'rule:process_stopped' })!.key).not.toBe(k);
    expect(computeSignature({ ...base, discriminator: { kind: 'service', value: 'wuauserv' } })!.key).not.toBe(k);
  });

  it('broadKey ignores the discriminator and equals key when there is none', () => {
    const withD = computeSignature(base)!;
    const without = computeSignature({ ...base, discriminator: null })!;
    expect(withD.broadKey).toBe(without.key);
    expect(without.broad).toBe(true);
    expect(withD.broad).toBe(false);
    expect(without.key).toBe(without.broadKey);
  });

  it('rejects an empty or oversized condition', () => {
    expect(computeSignature({ ...base, condition: '' })).toBeNull();
    expect(computeSignature({ ...base, condition: 'x'.repeat(201) })).toBeNull();
  });
});

describe('ruleConditionFacets', () => {
  it.each([
    [{ type: 'threshold', metric: 'diskPercent', operator: 'gte', value: 90 }, 'rule:metric:diskPercent:high', null],
    [{ type: 'metric', metric: 'ramPercent', operator: 'lt', value: 5 }, 'rule:metric:ramPercent:low', null],
    [{ type: 'offline', durationMinutes: 10 }, 'rule:offline', null],
    [{ type: 'event_log', category: 'system', level: 'error', countThreshold: 1, windowMinutes: 5, messagePattern: 'host-17 failed' }, 'rule:event_log:system:error', null],
    [{ type: 'service_stopped', serviceName: '  Spooler ' }, 'rule:service_stopped', { kind: 'service', value: 'spooler' }],
    [{ type: 'process_memory_high', processName: 'Chrome.exe', operator: 'gt', value: 80 }, 'rule:process_memory_high', { kind: 'process', value: 'chrome.exe' }],
    [{ type: 'software_presence', name: 'Acme Agent', presence: 'not_installed' }, 'rule:software_presence:not_installed', { kind: 'software', value: 'acme agent' }],
    [{ type: 'antivirus', check: 'definitions_stale' }, 'rule:antivirus:definitions_stale', null],
    [{ type: 'script_monitor', monitorId: '11111111-1111-4111-8111-111111111111', intervalMinutes: 5, breachOnNonZeroExit: true }, 'rule:script_monitor', null],
    [{ type: 'hardware_health', componentTypes: ['virtual_disk', 'controller'], minHealth: 'warning', includePredictiveFailure: true, consecutiveSnapshots: 2 }, 'rule:hardware_health:controller+virtual_disk', null],
  ])('%o → %s', (cond, condition, discriminator) => {
    expect(ruleConditionFacets(cond)).toEqual({ condition, discriminator });
  });

  it('never embeds an org-local UUID', () => {
    const f = ruleConditionFacets({ type: 'network_check', monitorId: '22222222-2222-4222-8222-222222222222' })!;
    expect(f.condition).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('orders group members canonically and keeps logic', () => {
    const a = ruleConditionFacets({ logic: 'and', conditions: [{ type: 'offline' }, { type: 'service_stopped', serviceName: 'x' }] });
    const b = ruleConditionFacets({ logic: 'and', conditions: [{ type: 'service_stopped', serviceName: 'x' }, { type: 'offline' }] });
    expect(a).toEqual(b);
    expect(a!.condition).toBe('rule:and(offline,service_stopped)');
    expect(a!.discriminator).toEqual({ kind: 'service', value: 'x' });
  });

  it('drops the discriminator when two leaves each carry one', () => {
    const f = ruleConditionFacets([{ type: 'service_stopped', serviceName: 'a' }, { type: 'service_stopped', serviceName: 'b' }]);
    expect(f!.discriminator).toBeNull();
  });

  it('returns null for unknown or malformed conditions', () => {
    expect(ruleConditionFacets({ type: 'mystery' })).toBeNull();
    expect(ruleConditionFacets(null)).toBeNull();
    expect(ruleConditionFacets({ logic: 'and', conditions: [] })).toBeNull();
  });
});

describe('sourced + alert facets', () => {
  it('script_exit_code carries the exit code discriminator', () => {
    expect(sourcedAlertFacets({ source: 'script_exit_code', scriptId: 's-1', exitCode: 3, executionId: 'e' }))
      .toEqual({ condition: 'sourced:script_exit_code:s-1', discriminator: { kind: 'exit_code', value: '3' } });
  });
  it('network monitor uses the monitor type only (target host is private)', () => {
    expect(sourcedAlertFacets({ source: 'network_monitor', monitorType: 'http', target: 'intranet.example.com' }))
      .toEqual({ condition: 'sourced:network_monitor:http', discriminator: null });
  });
  it('human escalations and unknown sources get no signature', () => {
    expect(sourcedAlertFacets({ source: 'monitor_recurrence' })).toBeNull();
    expect(sourcedAlertFacets({ source: 'something_new' })).toBeNull();
    expect(alertConditionFacets({ requiresHuman: true, context: null, ruleConditions: { type: 'offline' } })).toBeNull();
  });
  it('prefers rule conditions, then falls back to the sourced context', () => {
    expect(alertConditionFacets({ requiresHuman: false, context: { source: 'policy-evaluation' }, ruleConditions: { type: 'offline' } })!.condition).toBe('rule:offline');
    expect(alertConditionFacets({ requiresHuman: false, context: { source: 'policy-evaluation' }, ruleConditions: { type: 'nope' } })!.condition).toBe('sourced:policy_violation');
  });
  it('anomaly facets are the episode key', () => {
    expect(anomalyConditionFacets('device_metrics:spike:cpu')).toEqual({ condition: 'anomaly:device_metrics:spike:cpu', discriminator: null });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/fixMemory/signature.test.ts`
Expected: FAIL. `Failed to resolve import "./signature"`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/fixMemory/signature.ts
/**
 * Fix-memory signature v1 (AI Suggested Fixes W1). PURE — no DB.
 *
 * A signature identifies a PROBLEM across orgs of one partner: source family,
 * condition semantics (never an org-local rule/monitor UUID), OS family and at
 * most one discriminator read from STRUCTURED fields only. A signature without
 * a discriminator is BROAD: it may appear under "Similar fixes" but is never
 * auto-attached as proven (spec "Broad signatures").
 */
import { createHash } from 'node:crypto';
import { canonicalizeArguments } from '@breeze/shared/canonicalize';
import { FIX_SIGNATURE_VERSION, type FixDiscriminatorKind, type FixSignatureFamily } from '@breeze/shared';

export type FixOsFamily = 'windows' | 'macos' | 'linux';
export interface FixDiscriminator { kind: FixDiscriminatorKind; value: string }
export interface SignatureFacets {
  family: FixSignatureFamily;
  condition: string;
  osFamily: FixOsFamily;
  discriminator: FixDiscriminator | null;
  /** Correlation only: the root is the earliest alert, not an established cause. */
  rootInferred: boolean;
}
export interface FixSignature {
  version: typeof FIX_SIGNATURE_VERSION;
  key: string;
  broadKey: string;
  broad: boolean;
  facets: SignatureFacets;
}
export interface ConditionFacets { condition: string; discriminator: FixDiscriminator | null }

const CONDITION_MAX = 200;
const DISCRIMINATOR_MAX = 120;
const MAX_GROUP_DEPTH = 4;

export function isFixOsFamily(value: unknown): value is FixOsFamily {
  return value === 'windows' || value === 'macos' || value === 'linux';
}

function digest(parts: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalizeArguments(parts), 'utf8').digest('hex');
}

export function computeSignature(facets: SignatureFacets): FixSignature | null {
  if (!facets.condition || facets.condition.length > CONDITION_MAX) return null;
  const base = { v: FIX_SIGNATURE_VERSION, family: facets.family, condition: facets.condition, os: facets.osFamily };
  const broadKey = digest({ ...base, d: null });
  const key = facets.discriminator
    ? digest({ ...base, d: [facets.discriminator.kind, facets.discriminator.value] })
    : broadKey;
  return { version: FIX_SIGNATURE_VERSION, key, broadKey, broad: facets.discriminator === null, facets };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function disc(kind: FixDiscriminatorKind, value: unknown): FixDiscriminator | null {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : str(value);
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(/\s+/g, ' ');
  return normalized.length > DISCRIMINATOR_MAX ? null : { kind, value: normalized };
}

function direction(operator: unknown): string {
  if (operator === 'gt' || operator === 'gte') return 'high';
  if (operator === 'lt' || operator === 'lte') return 'low';
  if (operator === 'eq' || operator === 'neq') return operator;
  return 'unknown';
}

interface Leaf { token: string; discriminator: FixDiscriminator | null }

function leafFor(c: Record<string, unknown>): Leaf | null {
  const type = str(c.type);
  switch (type) {
    case 'threshold':
    case 'metric': {
      const metric = str(c.metric);
      return metric ? { token: `metric:${metric}:${direction(c.operator)}`, discriminator: null } : null;
    }
    case 'offline':
    case 'patch_compliance':
    case 'cert_expiry':
    case 'script_monitor':
    case 'network_check':
      return { token: type, discriminator: null };
    case 'event_log': {
      const category = str(c.category);
      const level = str(c.level);
      return category && level ? { token: `event_log:${category}:${level}`, discriminator: null } : null;
    }
    case 'service_stopped':
      return { token: type, discriminator: disc('service', c.serviceName) };
    case 'process_stopped':
    case 'process_cpu_high':
    case 'process_memory_high':
      return { token: type, discriminator: disc('process', c.processName) };
    case 'bandwidth_high':
    case 'disk_io_high': {
      const dir = str(c.direction);
      return dir ? { token: `${type}:${dir}`, discriminator: null } : null;
    }
    case 'network_errors': {
      const errorType = str(c.errorType);
      return errorType ? { token: `network_errors:${errorType}`, discriminator: null } : null;
    }
    case 'antivirus':
    case 'backup_continuity': {
      const check = str(c.check);
      return check ? { token: `${type}:${check}`, discriminator: null } : null;
    }
    case 'software_presence': {
      const presence = str(c.presence);
      return presence ? { token: `software_presence:${presence}`, discriminator: disc('software', c.name) } : null;
    }
    case 'hardware_health': {
      const kinds = Array.isArray(c.componentTypes) ? c.componentTypes.filter((k): k is string => typeof k === 'string') : [];
      return kinds.length ? { token: `hardware_health:${[...kinds].sort().join('+')}`, discriminator: null } : null;
    }
    default:
      return null;
  }
}

function walk(node: unknown, leaves: Leaf[], depth: number): string | null {
  if (depth > MAX_GROUP_DEPTH || node === null || typeof node !== 'object') return null;
  const children = Array.isArray(node) ? node : Array.isArray((node as Record<string, unknown>).conditions) ? (node as { conditions: unknown[] }).conditions : null;
  if (children) {
    if (children.length === 0) return null;
    const tokens: string[] = [];
    for (const child of children) {
      const token = walk(child, leaves, depth + 1);
      if (!token) return null;
      tokens.push(token);
    }
    if (tokens.length === 1) return tokens[0]!;
    const logic = !Array.isArray(node) && (node as Record<string, unknown>).logic === 'or' ? 'or' : 'and';
    return `${logic}(${tokens.sort().join(',')})`;
  }
  const leaf = leafFor(node as Record<string, unknown>);
  if (!leaf) return null;
  leaves.push(leaf);
  return leaf.token;
}

export function ruleConditionFacets(root: unknown): ConditionFacets | null {
  const leaves: Leaf[] = [];
  const token = walk(root, leaves, 0);
  if (!token) return null;
  const discriminators = leaves.map((l) => l.discriminator).filter((d): d is FixDiscriminator => d !== null);
  return { condition: `rule:${token}`, discriminator: discriminators.length === 1 ? discriminators[0]! : null };
}

export function sourcedAlertFacets(context: Record<string, unknown> | null): ConditionFacets | null {
  switch (str(context?.source)) {
    case 'network_monitor': {
      const monitorType = str(context!.monitorType);
      return monitorType ? { condition: `sourced:network_monitor:${monitorType}`, discriminator: null } : null;
    }
    case 'script_exit_code': {
      const scriptId = str(context!.scriptId);
      const exit = disc('exit_code', context!.exitCode);
      return scriptId && exit ? { condition: `sourced:script_exit_code:${scriptId}`, discriminator: exit } : null;
    }
    case 'patch-job-finalizer':
      return { condition: `sourced:patch_failed:${str(context!.category) ?? 'any'}`, discriminator: null };
    case 'maintenance-reboot-sweep':
      return { condition: 'sourced:reboot_pending', discriminator: null };
    case 'warranty_evaluator':
      return { condition: 'sourced:warranty_expiry', discriminator: null };
    case 'backup_provider': {
      const providerKey = str(context!.providerKey);
      const condition = str(context!.condition);
      return providerKey && condition ? { condition: `sourced:backup_provider:${providerKey}:${condition}`, discriminator: null } : null;
    }
    case 'network_baseline':
      return { condition: 'sourced:network_baseline', discriminator: null };
    case 'policy-evaluation':
      return { condition: 'sourced:policy_violation', discriminator: null };
    default:
      // monitor_recurrence is a human escalation; metric_anomaly is routed to
      // the anomaly family by the loader; anything unknown gets no signature.
      return null;
  }
}

export function alertConditionFacets(input: {
  requiresHuman: boolean;
  context: Record<string, unknown> | null;
  ruleConditions: unknown | null;
}): ConditionFacets | null {
  if (input.requiresHuman) return null;
  const source = str(input.context?.source);
  if (source === 'monitor_recurrence' || source === 'metric_anomaly') return null;
  if (input.ruleConditions !== null && input.ruleConditions !== undefined) {
    const fromRule = ruleConditionFacets(input.ruleConditions);
    if (fromRule) return fromRule;
  }
  return sourcedAlertFacets(input.context);
}

export function anomalyConditionFacets(episodeKey: string): ConditionFacets {
  return { condition: `anomaly:${episodeKey}`, discriminator: null };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/api && npx vitest run src/services/fixMemory/signature.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/fixMemory/signature.ts apps/api/src/services/fixMemory/signature.test.ts
git commit -m "feat(api): fix-memory signature v1 from structured alert and anomaly fields

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 7: Aggregate math, proof rule, owner and identity (pure, unit)

**Files:**
- Create: `apps/api/src/services/fixMemory/aggregate.ts`
- Test: `apps/api/src/services/fixMemory/aggregate.test.ts`

**Interfaces:**
- Consumes: `FIX_PROOF_RULES`, `FixCountedResult`, `FixKind`, `FixMemoryStatus`, `FixOutcomeState`, `FixVote` (Task 1).
- Produces:
  ```ts
  export interface CountedAttempt { result: FixCountedResult; vote: FixVote | null; terminalAt: Date }
  export interface AggregateSnapshot { attempts: number; verifiedCount: number; failedCount: number; recurredCount: number; upVotes: number; downVotes: number; rollingSuccessRate: number; consecutiveFailures: number; consecutiveVerified: number; recentOutcomes: FixCountedResult[]; status: 'active' | 'demoted'; lastVerifiedAt: Date | null }
  export function effectiveResult(state: FixOutcomeState, vote: FixVote | null): FixCountedResult | null;
  export function replayAggregate(attempts: readonly CountedAttempt[]): AggregateSnapshot;
  export function isProven(s: { status: FixMemoryStatus; stale: boolean; verifiedCount: number; rollingSuccessRate: number; recentOutcomes: readonly string[] }): boolean;
  export type FixOwner = { orgId: string; partnerId: null } | { orgId: null; partnerId: string };
  export interface FixOwnerFacts { fixKind: FixKind; script: { isSystem: boolean; orgId: string | null; partnerId: string | null } | null; playbook: { isBuiltIn: boolean; orgId: string | null } | null; instructionsRef: string | null }
  export function resolveFixOwner(facts: FixOwnerFacts, attempt: { orgId: string; partnerId: string }): FixOwner | null;
  export function fixKindForScript(script: { isSystem: boolean; orgId: string | null; partnerId: string | null }): 'system_script' | 'partner_script' | 'org_script';
  export function fixIdentityFor(input: { fixKind: FixKind; scriptVersionId?: string | null; builtinAction?: string | null; playbookId?: string | null; instructionsRef?: string | null }): string | null;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/fixMemory/aggregate.test.ts
import { describe, expect, it } from 'vitest';
import type { FixCountedResult, FixVote } from '@breeze/shared';
import { effectiveResult, fixIdentityFor, fixKindForScript, isProven, replayAggregate, resolveFixOwner, type CountedAttempt } from './aggregate';

const seq = (...results: Array<FixCountedResult | [FixCountedResult, FixVote]>): CountedAttempt[] =>
  results.map((r, i) => ({
    result: Array.isArray(r) ? r[0] : r,
    vote: Array.isArray(r) ? r[1] : null,
    terminalAt: new Date(Date.UTC(2026, 10, 1, 0, i)),
  }));

describe('effectiveResult', () => {
  it.each([
    ['verified', null, 'verified'], ['verified', 'up', 'verified'], ['verified', 'down', 'failed'],
    ['failed', null, 'failed'], ['failed', 'up', 'failed'], ['recurred', null, 'recurred'],
    ['inconclusive', null, null], ['inconclusive', 'up', null], ['inconclusive', 'down', 'failed'],
    ['cancelled', 'down', null], ['pending', null, null], ['awaiting_recovery', 'down', null], ['holding', null, null],
  ] as const)('%s + %s → %s', (state, vote, expected) => {
    expect(effectiveResult(state, vote)).toBe(expected);
  });
});

describe('replayAggregate + isProven', () => {
  const proven = (s: ReturnType<typeof replayAggregate>) =>
    isProven({ status: s.status, stale: false, verifiedCount: s.verifiedCount, rollingSuccessRate: s.rollingSuccessRate, recentOutcomes: s.recentOutcomes });

  it('3 verified is proven; 2 is not', () => {
    expect(proven(replayAggregate(seq('verified', 'verified')))).toBe(false);
    const s = replayAggregate(seq('verified', 'verified', 'verified'));
    expect(s).toMatchObject({ attempts: 3, verifiedCount: 3, rollingSuccessRate: 1, status: 'active' });
    expect(proven(s)).toBe(true);
  });

  it('a 👍 alone never proves anything', () => {
    expect(proven(replayAggregate(seq(['verified', 'up'], ['verified', 'up'])))).toBe(false);
  });

  it('two consecutive failures demote; three verified in a row lift it', () => {
    const demoted = replayAggregate(seq('verified', 'verified', 'verified', 'failed', 'failed'));
    expect(demoted.status).toBe('demoted');
    expect(proven(demoted)).toBe(false);
    const lifted = replayAggregate(seq('verified', 'verified', 'verified', 'failed', 'failed', 'verified', 'verified', 'verified'));
    expect(lifted.status).toBe('active');
    expect(lifted.consecutiveVerified).toBe(3);
    expect(lifted.rollingSuccessRate).toBeCloseTo(6 / 8);
    expect(proven(lifted)).toBe(false); // 0.75 < 0.8
  });

  it('a recurrence demotes immediately and blocks proof while it is in the last 3', () => {
    const s = replayAggregate(seq('verified', 'verified', 'verified', 'verified', 'recurred'));
    expect(s.status).toBe('demoted');
    const after = replayAggregate(seq('verified', 'verified', 'verified', 'verified', 'recurred', 'verified', 'verified', 'verified'));
    expect(after.status).toBe('active');
    expect(after.recentOutcomes.slice(0, 3)).toEqual(['verified', 'verified', 'verified']);
    expect(proven(after)).toBe(true); // 7/8 = 0.875
  });

  it('rolling rate only considers the last 20 counted attempts', () => {
    const s = replayAggregate(seq(...Array(10).fill('failed'), ...Array(20).fill('verified')));
    expect(s.recentOutcomes).toHaveLength(20);
    expect(s.rollingSuccessRate).toBe(1);
    expect(s.attempts).toBe(30);
  });

  it('replay is order-independent of input order (sorted by terminalAt)', () => {
    const a = seq('verified', 'failed', 'failed');
    expect(replayAggregate([...a].reverse())).toEqual(replayAggregate(a));
  });

  it('stale or retired is never proven', () => {
    const s = replayAggregate(seq('verified', 'verified', 'verified'));
    expect(isProven({ ...s, stale: true })).toBe(false);
    expect(isProven({ ...s, status: 'retired', stale: false })).toBe(false);
  });
});

describe('owner + identity', () => {
  const attempt = { orgId: 'org-a', partnerId: 'p-1' };
  it.each([
    [{ isSystem: true, orgId: null, partnerId: null }, { orgId: null, partnerId: 'p-1' }],
    [{ isSystem: false, orgId: null, partnerId: 'p-1' }, { orgId: null, partnerId: 'p-1' }],
    [{ isSystem: false, orgId: 'org-a', partnerId: 'p-1' }, { orgId: 'org-a', partnerId: null }],
    [{ isSystem: false, orgId: 'org-b', partnerId: 'p-1' }, null],
    [{ isSystem: false, orgId: null, partnerId: 'p-2' }, null],
  ])('script %o → %o', (script, owner) => {
    expect(resolveFixOwner({ fixKind: fixKindForScript(script), script, playbook: null, instructionsRef: null }, attempt)).toEqual(owner);
  });

  it('manual steps only aggregate with a reviewed instructions ref', () => {
    expect(resolveFixOwner({ fixKind: 'manual_steps', script: null, playbook: null, instructionsRef: null }, attempt)).toBeNull();
    expect(resolveFixOwner({ fixKind: 'manual_steps', script: null, playbook: null, instructionsRef: 'generic/clear-spooler' }, attempt))
      .toEqual({ orgId: null, partnerId: 'p-1' });
  });

  it('identity pins the script VERSION', () => {
    expect(fixIdentityFor({ fixKind: 'org_script', scriptVersionId: 'v-9' })).toBe('script_version:v-9');
    expect(fixIdentityFor({ fixKind: 'org_script', scriptVersionId: null })).toBeNull();
    expect(fixIdentityFor({ fixKind: 'builtin_action', builtinAction: 'reboot' })).toBe('builtin:reboot');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/fixMemory/aggregate.test.ts`
Expected: FAIL. `Failed to resolve import "./aggregate"`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/fixMemory/aggregate.ts
/**
 * Pure aggregate math for fix memory (AI Suggested Fixes W1).
 *
 * fix_memory is DERIVED: every write replays the counted attempts of one
 * identity from fix_outcomes (store.ts), so this file is the single definition
 * of "counted", "proven", "demoted" and "who owns a fix".
 */
import {
  FIX_PROOF_RULES,
  type FixCountedResult, type FixKind, type FixMemoryStatus, type FixOutcomeState, type FixVote,
} from '@breeze/shared';

export interface CountedAttempt { result: FixCountedResult; vote: FixVote | null; terminalAt: Date }

export interface AggregateSnapshot {
  attempts: number;
  verifiedCount: number;
  failedCount: number;
  recurredCount: number;
  upVotes: number;
  downVotes: number;
  rollingSuccessRate: number;
  consecutiveFailures: number;
  consecutiveVerified: number;
  /** Newest first, capped at FIX_PROOF_RULES.rollingWindow. */
  recentOutcomes: FixCountedResult[];
  status: 'active' | 'demoted';
  lastVerifiedAt: Date | null;
}

/**
 * The counted result of one attempt. A 👎 turns any terminal non-cancelled
 * attempt into a failure (spec: "A 👎 counts as a failure"); a 👍 never
 * upgrades anything. inconclusive/cancelled never count on their own.
 */
export function effectiveResult(state: FixOutcomeState, vote: FixVote | null): FixCountedResult | null {
  switch (state) {
    case 'verified': return vote === 'down' ? 'failed' : 'verified';
    case 'failed': return 'failed';
    case 'recurred': return 'recurred';
    case 'inconclusive': return vote === 'down' ? 'failed' : null;
    default: return null; // cancelled, pending, awaiting_recovery, holding
  }
}

export function replayAggregate(attempts: readonly CountedAttempt[]): AggregateSnapshot {
  const ordered = [...attempts].sort((a, b) => a.terminalAt.getTime() - b.terminalAt.getTime());
  let status: 'active' | 'demoted' = 'active';
  let consecutiveFailures = 0;
  let consecutiveVerified = 0;
  let verifiedCount = 0;
  let failedCount = 0;
  let recurredCount = 0;
  let upVotes = 0;
  let downVotes = 0;
  let lastVerifiedAt: Date | null = null;
  const recent: FixCountedResult[] = [];

  for (const attempt of ordered) {
    if (attempt.vote === 'up') upVotes += 1;
    if (attempt.vote === 'down') downVotes += 1;
    recent.unshift(attempt.result);
    if (recent.length > FIX_PROOF_RULES.rollingWindow) recent.pop();

    if (attempt.result === 'verified') {
      verifiedCount += 1;
      lastVerifiedAt = attempt.terminalAt;
      consecutiveFailures = 0;
      consecutiveVerified += 1;
      if (status === 'demoted' && consecutiveVerified >= FIX_PROOF_RULES.liftDemotionAfterConsecutiveVerified) status = 'active';
    } else if (attempt.result === 'failed') {
      failedCount += 1;
      consecutiveVerified = 0;
      consecutiveFailures += 1;
      if (consecutiveFailures >= FIX_PROOF_RULES.demoteAfterConsecutiveFailures) status = 'demoted';
    } else {
      recurredCount += 1;
      consecutiveVerified = 0;
      consecutiveFailures = 0;
      status = 'demoted';
    }
  }

  const windowVerified = recent.filter((r) => r === 'verified').length;
  return {
    attempts: ordered.length,
    verifiedCount, failedCount, recurredCount, upVotes, downVotes,
    rollingSuccessRate: recent.length === 0 ? 0 : windowVerified / recent.length,
    consecutiveFailures, consecutiveVerified,
    recentOutcomes: recent,
    status,
    lastVerifiedAt,
  };
}

export function isProven(s: {
  status: FixMemoryStatus; stale: boolean; verifiedCount: number; rollingSuccessRate: number; recentOutcomes: readonly string[];
}): boolean {
  if (s.status !== 'active' || s.stale) return false;
  if (s.verifiedCount < FIX_PROOF_RULES.minVerified) return false;
  if (s.rollingSuccessRate < FIX_PROOF_RULES.minSuccessRate) return false;
  return !s.recentOutcomes.slice(0, FIX_PROOF_RULES.noRecurrenceInLast).includes('recurred');
}

export type FixOwner = { orgId: string; partnerId: null } | { orgId: null; partnerId: string };

export interface FixOwnerFacts {
  fixKind: FixKind;
  script: { isSystem: boolean; orgId: string | null; partnerId: string | null } | null;
  playbook: { isBuiltIn: boolean; orgId: string | null } | null;
  instructionsRef: string | null;
}

/**
 * Owner rule (spec "Owner rule"), evaluated against the fix's CURRENT
 * ownership — so an org→partner re-scope folds history into the partner row on
 * the next rebuild. null = this attempt contributes to no aggregate.
 */
export function resolveFixOwner(facts: FixOwnerFacts, attempt: { orgId: string; partnerId: string }): FixOwner | null {
  const partnerOwned: FixOwner = { orgId: null, partnerId: attempt.partnerId };
  const orgOwned: FixOwner = { orgId: attempt.orgId, partnerId: null };
  switch (facts.fixKind) {
    case 'system_script':
    case 'partner_script':
    case 'org_script': {
      const s = facts.script;
      if (!s) return null;
      if (s.isSystem) return partnerOwned;
      if (s.orgId === null && s.partnerId === attempt.partnerId) return partnerOwned;
      if (s.orgId === attempt.orgId) return orgOwned;
      return null;
    }
    case 'playbook': {
      const p = facts.playbook;
      if (!p) return null;
      if (p.isBuiltIn) return partnerOwned;
      return p.orgId === attempt.orgId ? orgOwned : null;
    }
    case 'builtin_action':
      return partnerOwned;
    case 'manual_steps':
      // Only REVIEWED generic steps are shareable; AI-written prose never is.
      return facts.instructionsRef ? partnerOwned : null;
  }
}

export function fixKindForScript(script: { isSystem: boolean; orgId: string | null; partnerId: string | null }): 'system_script' | 'partner_script' | 'org_script' {
  if (script.isSystem) return 'system_script';
  if (script.orgId === null && script.partnerId !== null) return 'partner_script';
  return 'org_script';
}

export function fixIdentityFor(input: {
  fixKind: FixKind;
  scriptVersionId?: string | null;
  builtinAction?: string | null;
  playbookId?: string | null;
  instructionsRef?: string | null;
}): string | null {
  switch (input.fixKind) {
    case 'system_script':
    case 'partner_script':
    case 'org_script':
      return input.scriptVersionId ? `script_version:${input.scriptVersionId}` : null;
    case 'builtin_action':
      return input.builtinAction ? `builtin:${input.builtinAction}` : null;
    case 'playbook':
      return input.playbookId ? `playbook:${input.playbookId}` : null;
    case 'manual_steps':
      return input.instructionsRef ? `instructions:${input.instructionsRef}` : null;
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/api && npx vitest run src/services/fixMemory/aggregate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/fixMemory/aggregate.ts apps/api/src/services/fixMemory/aggregate.test.ts
git commit -m "feat(api): fix-memory aggregate replay, proof rule and owner resolution

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 8: Extract probes from fixWatch + telemetry freshness probe (unit; fixWatch behaviour unchanged)

This task resolves spec open item 3 in code. Freshness over the hold window `[recovered_at, holding_until]` requires all of the following:

- The device row exists and is not `decommissioned`.
- `devices.last_seen_at` is within `maxHeartbeatAgeMinutes` (30) of `holding_until`. `devices.ts:112` is overwritten on every heartbeat.
- At least `minCoverage` (80%) of the 30-minute buckets across the window contain a **non-NULL sample of the signature's own measurement**. Any row in the table is not enough: disk-rate and bandwidth columns are nullable (`schema/devices.ts:443-450`) and are distinct families (`metricAnomalyEpisodeKeys.ts:57-60`). `telemetryProbeFor(condition)` maps each case to an allow-listed `(table, column)`:
  - `anomaly:device_metrics:<source>:<family>` → the family's column (`cpu`→`cpu_percent`, `disk_read`→`disk_read_bps`, `net_in`→`bandwidth_in_bps`, …);
  - `rule:metric:<metric>:…`, `rule:bandwidth_high:<dir>` and `rule:disk_io_high:<dir>` → that column;
  - process-family anomalies → `device_process_samples.top_processes`;
  - every other condition (service, event log, sourced) → the always-present `device_metrics.cpu_percent`, as a liveness signal;
  - an **unmapped** metric family → `null`, which fails closed as `metric_unmapped`.

The only pre-existing freshness logic was `SWEEP_PROBE_FRESHNESS_MS` inside `sweepSubjectProbe.ts:70` (service_down only), so there is no shared helper to reuse.

**Files:**
- Create: `apps/api/src/services/outcomeProbes.ts`
- Test: `apps/api/src/services/outcomeProbes.test.ts`
- Modify: `apps/api/src/services/aiAgents/fixWatch.ts`
  - remove local `inSystemDbContext` (~L57-60) and import it;
  - phase-1 alert read (~L564-572) → `readAlertRecovery`;
  - `giveUpIfTimedOut` age check (~L624-625) → `windowElapsed`.

**Interfaces:**
- Produces:
  ```ts
  export function inSystemDbContext<T>(fn: () => Promise<T>, label?: string): Promise<T>;
  export interface AlertRecoveryReading { status: 'active' | 'acknowledged' | 'resolved' | 'suppressed' | 'dismissed'; resolvedAt: Date | null; resolvedBy: string | null; resolutionReason: string | null }
  export async function readAlertRecovery(alertId: string): Promise<AlertRecoveryReading | null>;
  export function windowElapsed(startedAt: Date, hours: number, now?: Date): boolean;
  export interface TelemetryProbe { table: 'device_metrics' | 'device_process_samples'; column: string }
  export interface TelemetryFreshness { fresh: boolean; reason: 'ok' | 'device_missing' | 'device_decommissioned' | 'heartbeat_stale' | 'metric_gap' | 'metric_unmapped'; coverage: number }
  export function telemetryProbeFor(condition: string | null): TelemetryProbe | null;
  export async function probeTelemetryFreshness(input: { deviceId: string; from: Date; to: Date; probe: TelemetryProbe | null }): Promise<TelemetryFreshness>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/outcomeProbes.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rows, executeRows } = vi.hoisted(() => ({ rows: [] as unknown[][], executeRows: [] as unknown[][] }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(rows.shift() ?? []).then(r);
  (chain as { execute: unknown }).execute = vi.fn(async () => executeRows.shift() ?? []);
  return {
    db: chain,
    getCurrentDbAccessContext: vi.fn(() => undefined),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  };
});

import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../db';
import { probeTelemetryFreshness, telemetryProbeFor, windowElapsed } from './outcomeProbes';

const CPU = { table: 'device_metrics', column: 'cpu_percent' } as const;

const from = new Date('2026-11-01T00:00:00Z');
const to = new Date('2026-11-02T00:00:00Z'); // 48 half-hour buckets

describe('windowElapsed', () => {
  it('is false strictly before the window and true at/after it', () => {
    expect(windowElapsed(from, 24, new Date('2026-11-01T23:59:59Z'))).toBe(false);
    expect(windowElapsed(from, 24, to)).toBe(true);
  });
});

describe('probeTelemetryFreshness', () => {
  beforeEach(() => { rows.length = 0; executeRows.length = 0; });

  it('fresh when heartbeat is recent and >=80% of buckets have samples', async () => {
    rows.push([{ status: 'online', lastSeenAt: new Date('2026-11-01T23:50:00Z') }]);
    executeRows.push([{ buckets: 40 }]);
    await expect(probeTelemetryFreshness({ deviceId: 'd', from, to, probe: CPU }))
      .resolves.toEqual({ fresh: true, reason: 'ok', coverage: 40 / 48 });
  });

  it('metric gap (device reporting heartbeats but most buckets empty) is NOT fresh', async () => {
    rows.push([{ status: 'online', lastSeenAt: new Date('2026-11-01T23:50:00Z') }]);
    executeRows.push([{ buckets: 30 }]);
    await expect(probeTelemetryFreshness({ deviceId: 'd', from, to, probe: CPU }))
      .resolves.toMatchObject({ fresh: false, reason: 'metric_gap' });
  });

  it('offline at hold end is NOT fresh even with historical samples', async () => {
    rows.push([{ status: 'offline', lastSeenAt: new Date('2026-11-01T20:00:00Z') }]);
    await expect(probeTelemetryFreshness({ deviceId: 'd', from, to, probe: CPU }))
      .resolves.toMatchObject({ fresh: false, reason: 'heartbeat_stale' });
  });

  it('missing or decommissioned device is NOT fresh', async () => {
    rows.push([]);
    await expect(probeTelemetryFreshness({ deviceId: 'd', from, to, probe: CPU }))
      .resolves.toMatchObject({ fresh: false, reason: 'device_missing' });
    rows.push([{ status: 'decommissioned', lastSeenAt: to }]);
    await expect(probeTelemetryFreshness({ deviceId: 'd', from, to, probe: CPU }))
      .resolves.toMatchObject({ fresh: false, reason: 'device_decommissioned' });
  });
});

describe('telemetryProbeFor', () => {
  it.each([
    ['anomaly:device_metrics:spike:disk_read', { table: 'device_metrics', column: 'disk_read_bps' }],
    ['anomaly:device_metrics:network_egress:net_out', { table: 'device_metrics', column: 'bandwidth_out_bps' }],
    ['anomaly:device_metrics:memory_growth:ram_used', { table: 'device_metrics', column: 'ram_used_mb' }],
    ['anomaly:device_process_samples:process_runaway:process_cpu', { table: 'device_process_samples', column: 'top_processes' }],
    ['rule:metric:diskPercent:high', { table: 'device_metrics', column: 'disk_percent' }],
    ['rule:bandwidth_high:in', { table: 'device_metrics', column: 'bandwidth_in_bps' }],
    ['rule:disk_io_high:write', { table: 'device_metrics', column: 'disk_write_bps' }],
    ['rule:service_stopped', CPU],
    [null, CPU],
  ] as const)('%s → %o', (condition, probe) => {
    expect(telemetryProbeFor(condition)).toEqual(probe);
  });

  it('fails closed (null) for a metric family it cannot map', () => {
    expect(telemetryProbeFor('anomaly:device_metrics:spike:some_new_metric')).toBeNull();
    expect(telemetryProbeFor('rule:metric:gpuPercent:high')).toBeNull();
  });
});

describe('probeTelemetryFreshness counts only the measurement itself', () => {
  beforeEach(() => { rows.length = 0; executeRows.length = 0; vi.mocked(db.execute).mockClear(); });

  it('queries the family column with IS NOT NULL (a disk_read hold is not proven by CPU/RAM rows)', async () => {
    rows.push([{ status: 'online', lastSeenAt: new Date('2026-11-01T23:50:00Z') }]);
    executeRows.push([{ buckets: 0 }]);
    const out = await probeTelemetryFreshness({ deviceId: 'd', from, to, probe: { table: 'device_metrics', column: 'disk_read_bps' } });
    expect(out).toMatchObject({ fresh: false, reason: 'metric_gap' });
    const q = new PgDialect().sqlToQuery(vi.mocked(db.execute).mock.calls[0]![0] as never);
    expect(q.sql).toContain('"device_metrics"');
    expect(q.sql).toContain('"disk_read_bps" IS NOT NULL');
  });

  it('an unmapped family is metric_unmapped without touching the metrics tables', async () => {
    rows.push([{ status: 'online', lastSeenAt: new Date('2026-11-01T23:50:00Z') }]);
    await expect(probeTelemetryFreshness({ deviceId: 'd', from, to, probe: null }))
      .resolves.toEqual({ fresh: false, reason: 'metric_unmapped', coverage: 0 });
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('rejects a column outside the allowlist', async () => {
    rows.push([{ status: 'online', lastSeenAt: new Date('2026-11-01T23:50:00Z') }]);
    await expect(probeTelemetryFreshness({ deviceId: 'd', from, to, probe: { table: 'device_metrics', column: 'org_id; drop' } }))
      .rejects.toThrow(/not an allowed telemetry column/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/outcomeProbes.test.ts`
Expected: FAIL. `Failed to resolve import "./outcomeProbes"`.

- [ ] **Step 3: Implement the probes module**

```ts
// apps/api/src/services/outcomeProbes.ts
/**
 * Outcome probes shared by the AI-agent fix-held watch (aiAgents/fixWatch.ts)
 * and the suggestion outcome watcher (fixMemory/outcomeWatcher.ts). EXTRACTED
 * from fixWatch.ts (AI Suggested Fixes W1, quorum point 1): these functions
 * read and decide; they never write a watch, evidence or demotion — each
 * watcher keeps its own persistence adapters.
 */
import { eq, sql } from 'drizzle-orm';
import { FIX_TELEMETRY_FRESHNESS } from '@breeze/shared';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { alerts, devices } from '../db/schema';

/** Reuse an ambient system context, else open one outside the caller's. */
export function inSystemDbContext<T>(fn: () => Promise<T>, label?: string): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

export interface AlertRecoveryReading {
  status: 'active' | 'acknowledged' | 'resolved' | 'suppressed' | 'dismissed';
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionReason: string | null;
}

export async function readAlertRecovery(alertId: string): Promise<AlertRecoveryReading | null> {
  const [row] = await db
    .select({
      status: alerts.status,
      resolvedAt: alerts.resolvedAt,
      resolvedBy: alerts.resolvedBy,
      resolutionReason: alerts.resolutionReason,
    })
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);
  return (row as AlertRecoveryReading | undefined) ?? null;
}

export function windowElapsed(startedAt: Date, hours: number, now: Date = new Date()): boolean {
  return now.getTime() - startedAt.getTime() >= hours * 3_600_000;
}

export interface TelemetryProbe { table: 'device_metrics' | 'device_process_samples'; column: string }

export interface TelemetryFreshness {
  fresh: boolean;
  reason: 'ok' | 'device_missing' | 'device_decommissioned' | 'heartbeat_stale' | 'metric_gap' | 'metric_unmapped';
  coverage: number;
}

/** Episode metric family -> device_metrics column (metricAnomalyEpisodeKeys.ts EPISODE_METRIC_FAMILIES). */
const FAMILY_COLUMNS: Readonly<Record<string, string>> = {
  cpu: 'cpu_percent', ram: 'ram_percent', ram_used: 'ram_used_mb', disk: 'disk_percent', disk_used: 'disk_used_gb',
  disk_read: 'disk_read_bps', disk_write: 'disk_write_bps', net_in: 'bandwidth_in_bps', net_out: 'bandwidth_out_bps',
  process_count: 'process_count',
};
/** Alert threshold `metric` names (Drizzle property names per alertConditions/types.ts, or snake_case). */
const ALERT_METRIC_COLUMNS: Readonly<Record<string, string>> = {
  cpuPercent: 'cpu_percent', ramPercent: 'ram_percent', diskPercent: 'disk_percent', processCount: 'process_count',
  cpu_percent: 'cpu_percent', ram_percent: 'ram_percent', disk_percent: 'disk_percent', process_count: 'process_count',
};
const DIRECTION_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  bandwidth_high: { in: 'bandwidth_in_bps', out: 'bandwidth_out_bps', total: 'bandwidth_in_bps' },
  disk_io_high: { read: 'disk_read_bps', write: 'disk_write_bps', total: 'disk_read_bps' },
};
const LIVENESS: TelemetryProbe = { table: 'device_metrics', column: 'cpu_percent' };
const ALLOWED_COLUMNS: Readonly<Record<TelemetryProbe['table'], ReadonlySet<string>>> = {
  device_metrics: new Set([...Object.values(FAMILY_COLUMNS), 'cpu_percent']),
  device_process_samples: new Set(['top_processes']),
};

/** Which measurement must keep arriving for a hold on `condition` to prove anything. null = unmappable (fail closed). */
export function telemetryProbeFor(condition: string | null): TelemetryProbe | null {
  if (!condition) return LIVENESS;
  if (condition.startsWith('anomaly:device_process_samples:')) return { table: 'device_process_samples', column: 'top_processes' };
  if (condition.startsWith('anomaly:device_metrics:')) {
    const column = FAMILY_COLUMNS[condition.split(':')[3] ?? ''];
    return column ? { table: 'device_metrics', column } : null;
  }
  const metric = /^rule:metric:([A-Za-z_]+):/.exec(condition);
  if (metric) {
    const column = ALERT_METRIC_COLUMNS[metric[1]!];
    return column ? { table: 'device_metrics', column } : null;
  }
  const directional = /^rule:(bandwidth_high|disk_io_high):([a-z]+)$/.exec(condition);
  if (directional) {
    const column = DIRECTION_COLUMNS[directional[1]!]?.[directional[2]!];
    return column ? { table: 'device_metrics', column } : null;
  }
  return LIVENESS; // non-metric condition: the device's routine sample stream is the liveness signal
}

/**
 * Spec "Telemetry freshness": a quiet hold only proves anything if the device
 * kept reporting THE MEASUREMENT THE PROBLEM IS ABOUT. Heartbeat recency at hold
 * end AND >= minCoverage of bucketMinutes-wide buckets across [from, to) holding
 * a NON-NULL sample of probe.column.
 */
export async function probeTelemetryFreshness(input: {
  deviceId: string;
  from: Date;
  to: Date;
  probe: TelemetryProbe | null;
}): Promise<TelemetryFreshness> {
  const [device] = await db
    .select({ status: devices.status, lastSeenAt: devices.lastSeenAt })
    .from(devices)
    .where(eq(devices.id, input.deviceId))
    .limit(1);
  if (!device) return { fresh: false, reason: 'device_missing', coverage: 0 };
  if (device.status === 'decommissioned') return { fresh: false, reason: 'device_decommissioned', coverage: 0 };

  const maxAgeMs = FIX_TELEMETRY_FRESHNESS.maxHeartbeatAgeMinutes * 60_000;
  if (!device.lastSeenAt || device.lastSeenAt.getTime() < input.to.getTime() - maxAgeMs) {
    return { fresh: false, reason: 'heartbeat_stale', coverage: 0 };
  }

  if (!input.probe) return { fresh: false, reason: 'metric_unmapped', coverage: 0 };
  const { table, column } = input.probe;
  if (!ALLOWED_COLUMNS[table]?.has(column)) throw new Error(`${table}.${column} is not an allowed telemetry column`);

  const bucketSeconds = FIX_TELEMETRY_FRESHNESS.bucketMinutes * 60;
  const expected = Math.max(1, Math.floor((input.to.getTime() - input.from.getTime()) / (bucketSeconds * 1000)));
  const fromIso = input.from.toISOString();
  const toIso = input.to.toISOString();
  // Identifiers come only from the allowlist above, never from input text.
  const query = sql`SELECT count(DISTINCT floor(extract(epoch FROM "timestamp") / ${bucketSeconds}))::int AS buckets
    FROM ${sql.identifier(table)}
    WHERE device_id = ${input.deviceId}
      AND "timestamp" >= ${fromIso}::timestamptz AND "timestamp" < ${toIso}::timestamptz
      AND ${sql.identifier(column)} IS NOT NULL`;
  const result = await db.execute<{ buckets: number }>(query);
  const [row] = [...result];
  const coverage = Math.min(1, Number(row?.buckets ?? 0) / expected);
  return coverage >= FIX_TELEMETRY_FRESHNESS.minCoverage
    ? { fresh: true, reason: 'ok', coverage }
    : { fresh: false, reason: 'metric_gap', coverage };
}
```

- [ ] **Step 4: Rewire fixWatch onto the extracted probes (no behaviour change)**

In `apps/api/src/services/aiAgents/fixWatch.ts`:

1. Delete the local `inSystemDbContext` function (the "Same skip-if-already-system shape" block) and add an import:
   ```ts
   import { inSystemDbContext, readAlertRecovery, windowElapsed } from '../outcomeProbes';
   ```
   Keep `getCurrentDbAccessContext`, `runOutsideDbContext` and `withSystemDbAccessContext` imports only if other code in the file still uses them. Otherwise remove them to keep `tsc --noUnusedLocals` green.
2. In `checkFixWatchPhase1`, replace the block
   ```ts
    let alertStatus: string | null = null;
    if (watch.alertId) {
      const [alertRow] = await db
        .select({ status: alerts.status })
        .from(alerts)
        .where(eq(alerts.id, watch.alertId))
        .limit(1);
      alertStatus = alertRow?.status ?? null;
    }
   ```
   with
   ```ts
    // Extracted probe (outcomeProbes.ts). fixWatch keeps its historical rule:
    // ANY resolve counts as recovery here — only the suggestion watcher reads
    // resolutionReason.
    const reading = watch.alertId ? await readAlertRecovery(watch.alertId) : null;
    const alertStatus: string | null = reading?.status ?? null;
   ```
3. In `giveUpIfTimedOut`, replace
   ```ts
  const ageMs = Date.now() - watch.createdAt.getTime();
  if (ageMs < RECOVERY_TIMEOUT_HOURS * 60 * 60 * 1000) return { action: 'still_pending' };
   ```
   with
   ```ts
  if (!windowElapsed(watch.createdAt, RECOVERY_TIMEOUT_HOURS)) return { action: 'still_pending' };
   ```

- [ ] **Step 5: Run the new tests plus every fixWatch suite unchanged**

Run: `cd apps/api && npx vitest run src/services/outcomeProbes.test.ts src/services/aiAgents/fixWatch.test.ts src/services/aiAgents/fixWatch.sql.test.ts src/jobs/fixWatchWorker && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, with fixWatch suites green and unedited. If a fixWatch suite mocks `../../db/schema` without `alerts.resolvedAt` etc., the mocked `db` chain ignores column objects, so no edit should be needed. If one fails, add the missing column keys to that suite's schema mock and change nothing else.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/outcomeProbes.ts apps/api/src/services/outcomeProbes.test.ts apps/api/src/services/aiAgents/fixWatch.ts
git commit -m "refactor(api): extract outcome probes from fixWatch and add telemetry freshness probe

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 9: Persisted alert resolution reason on every resolve path (unit)

This task resolves spec open item 5 in code. Each path is classified below.

| Path | `resolution_reason` | Counts as objective recovery? |
|---|---|---|
| `checkAutoResolve` both branches (`alertService.ts:576,583`) | `condition_cleared` | yes |
| `policyAlertBridge.ts:145` (policy re-evaluated compliant) | `condition_cleared` | yes |
| `jobs/monitorWorker.ts:380` (monitor recovered) | `condition_cleared` | yes |
| `scriptExitCodeAlerts.ts:187` (a later run exited non-alerting) | `condition_cleared` | yes |
| `alertSubjects.ts:73` (subject `recovered`; drained by `subjectAlertOutbox.ts:97` with the staged payload) | `condition_cleared` | yes |
| `backupProviders/alerts.ts:333` (provider sync cleared) | `condition_cleared` | yes |
| `metricAnomalyEpisodeAlerts.ts:64` | `cleared` → `condition_cleared`; `expired_*`/`detection_off` → `expired` | only `cleared` |
| `hardwareHealth/retire.ts:28` (component gone) | `source_retired` | no |
| `backupProviders/alertsResolve.ts:32` (connection removed / remapped) | `source_retired` | no |
| `metricAnomalyEpisodeActions.ts:213` (user resolves episode) | `manual` | no |
| Any caller passing `resolvedBy` (default) | `manual` | no |
| Direct-UPDATE human paths (`routes/alerts/alerts.ts:790,1049`, `correlations.ts:678`, `mobile.ts:1218`, `aiToolsAlerts.ts:356`) and `warrantyAlertEvaluator.ts:265` | NULL (unchanged) | no (fail closed) |

**Files:**
- Modify: `apps/api/src/services/alertService.ts`
  - `resolveAlert` signature + `.set()` + both payloads (~L787-914);
  - `checkAutoResolve` calls (~L576, L583).
- Modify:
  - `apps/api/src/services/policyAlertBridge.ts:145`
  - `apps/api/src/jobs/monitorWorker.ts:380-383`
  - `apps/api/src/services/scriptExitCodeAlerts.ts:187`
  - `apps/api/src/services/alertSubjects.ts:73`
  - `apps/api/src/services/metricAnomalyEpisodeAlerts.ts:64`
  - `apps/api/src/services/metricAnomalyEpisodeActions.ts:213`
  - `apps/api/src/services/hardwareHealth/retire.ts:28`
  - `apps/api/src/services/backupProviders/alerts.ts:333`
  - `apps/api/src/services/backupProviders/alertsResolve.ts:32`
- Modify tests: `apps/api/src/jobs/monitorWorker.test.ts:510`, `apps/api/src/services/backupProviders/alerts.evaluate.test.ts:132,150`
- Create test: `apps/api/src/services/alertService.resolutionReason.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function resolveAlert(alertId: string, resolutionNote?: string, resolvedBy?: string, deferSubjectEffects?: boolean, resolutionReason?: AlertResolutionReason): Promise<boolean>;
  ```
  The `alert.resolved` payload gains `resolutionReason: AlertResolutionReason | null`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/alertService.resolutionReason.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, sets, updateReturnResults, publishEventMock } = vi.hoisted(() => {
  const sets: Record<string, unknown>[] = [];
  const updateReturnResults: unknown[][] = [];
  const dbMock = {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: () => ({ limit: () => Promise.resolve([]) }) })) })),
    update: vi.fn(() => ({
      set: (s: Record<string, unknown>) => { sets.push(s); return { where: () => ({ returning: () => Promise.resolve(updateReturnResults.shift() ?? []) }) }; },
    })),
  };
  return { dbMock, sets, updateReturnResults, publishEventMock: vi.fn(() => Promise.resolve('evt')) };
});

vi.mock('../db', () => ({ db: dbMock }));
vi.mock('../db/schema', () => ({
  alerts: { id: 'alerts.id', status: 'alerts.status', orgId: 'alerts.orgId' },
  alertRules: { id: 'alert_rules.id', templateId: 'alert_rules.templateId' },
  alertTemplates: { id: 'alert_templates.id' },
  alertCorrelations: {}, devices: {}, deviceGroups: {}, deviceGroupMemberships: {}, sites: {}, configPolicyAlertRules: {},
}));
vi.mock('./alertConditions', () => ({ evaluateConditions: vi.fn(), evaluateAutoResolveConditions: vi.fn(), interpolateTemplate: vi.fn((t: string) => t) }));
vi.mock('./alertCooldown', () => ({
  isCooldownActive: vi.fn(() => Promise.resolve(false)), setCooldown: vi.fn(() => Promise.resolve()),
  recordStateTransition: vi.fn(() => Promise.resolve()), isFlapping: vi.fn(() => Promise.resolve(false)),
}));
vi.mock('./eventBus', () => ({ publishEvent: publishEventMock }));
vi.mock('./alertCorrelationQueue', () => ({ enqueueAlertCorrelation: vi.fn() }));

import { resolveAlert } from './alertService';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'alert-1', orgId: 'org-1', ruleId: null, deviceId: 'device-1', subjectKey: null,
  triggeredAt: new Date('2026-11-01T00:00:00Z'), resolvedAt: new Date('2026-11-01T01:00:00Z'),
  resolvedBy: null, resolutionReason: null, ...over,
});

describe('resolveAlert resolution reason', () => {
  beforeEach(() => { sets.length = 0; updateReturnResults.length = 0; publishEventMock.mockClear(); });

  it('persists and publishes an explicit condition_cleared', async () => {
    updateReturnResults.push([row({ resolutionReason: 'condition_cleared' })]);
    await resolveAlert('alert-1', 'Auto-resolved: conditions cleared', undefined, false, 'condition_cleared');
    expect(sets[0]).toMatchObject({ status: 'resolved', resolutionReason: 'condition_cleared', resolvedBy: null });
    expect(publishEventMock).toHaveBeenCalledWith('alert.resolved', 'org-1',
      expect.objectContaining({ resolutionReason: 'condition_cleared', resolvedBy: null }), 'alert-service', expect.anything());
  });

  it('defaults to manual when a user resolves', async () => {
    updateReturnResults.push([row({ resolvedBy: 'user-1', resolutionReason: 'manual' })]);
    await resolveAlert('alert-1', 'fixed it', 'user-1');
    expect(sets[0]).toMatchObject({ resolvedBy: 'user-1', resolutionReason: 'manual' });
  });

  it('leaves the reason NULL (fail closed) when a system caller says nothing', async () => {
    updateReturnResults.push([row()]);
    await resolveAlert('alert-1', 'note');
    expect(sets[0]).toMatchObject({ resolutionReason: null });
    expect(publishEventMock).toHaveBeenCalledWith('alert.resolved', 'org-1', expect.objectContaining({ resolutionReason: null }), 'alert-service', expect.anything());
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/alertService.resolutionReason.test.ts`
Expected: FAIL. `sets[0]` has no `resolutionReason` key, and the payload lacks `resolutionReason`.

- [ ] **Step 3: Implement in `alertService.ts`**

Add `import type { AlertResolutionReason } from '@breeze/shared';` to the imports. Change the signature and the UPDATE:

```ts
export async function resolveAlert(
  alertId: string,
  resolutionNote?: string,
  resolvedBy?: string,
  deferSubjectEffects = false,
  // AI Suggested Fixes W1: WHY it resolved. A human resolve is 'manual'; a
  // system caller that does not say is NULL, which the outcome watcher treats
  // as NOT a recovery (fail closed). See ALERT_RESOLUTION_REASONS.
  resolutionReason?: AlertResolutionReason,
): Promise<boolean> {
  const reason: AlertResolutionReason | null = resolutionReason ?? (resolvedBy ? 'manual' : null);
  const [alert] = await db
    .update(alerts)
    .set({
      status: 'resolved',
      resolvedAt: new Date(),
      resolvedBy: resolvedBy ?? null,
      resolutionNote: resolutionNote ?? null,
      resolutionReason: reason,
    })
    .where(buildResolveAlertCas(alertId))
    .returning();
```

In the deferred-subject `pending.payload` object, add after `resolvedBy: alert.resolvedBy,`:

```ts
        resolutionReason: alert.resolutionReason ?? null,
```

In the final `publishEvent('alert.resolved', ...)` payload, add after `resolvedBy: alert.resolvedBy,`:

```ts
      resolutionReason: alert.resolutionReason ?? null,
```

In `checkAutoResolve`, change the two calls:

```ts
      return await resolveAlert(alertId, 'Auto-resolved: conditions cleared', undefined, false, 'condition_cleared');
```
```ts
      return await resolveAlert(alertId, `Auto-resolved: ${result.reason}`, undefined, false, 'condition_cleared');
```

- [ ] **Step 4: Pass a reason at every caller**

`services/policyAlertBridge.ts:145`:
```ts
    await resolveAlert(alert.id, 'Auto-resolved: policy returned to compliant state', undefined, false, 'condition_cleared');
```
`jobs/monitorWorker.ts:380`:
```ts
        await resolveAlert(
          existingAlert.id,
          `Auto-resolved after monitor ${monitor.name} recovered from ${rule.condition}`,
          undefined,
          false,
          'condition_cleared',
        );
```
`services/scriptExitCodeAlerts.ts:187`:
```ts
    await resolveAlert(candidate.id, `Auto-resolved: a later run exited ${exitCode}, which maps to no alert`, undefined, false, 'condition_cleared');
```
`services/alertSubjects.ts:73`:
```ts
        await resolveAlert(alert.id, `Auto-resolved: ${subject.description}`, undefined, true, 'condition_cleared');
```
`services/metricAnomalyEpisodeAlerts.ts:64`:
```ts
      if (await resolveAlert(row.alertId, autoResolveNoteFor(row.closeReason), undefined, false, row.closeReason === 'cleared' ? 'condition_cleared' : 'expired')) resolved += 1;
```
`services/metricAnomalyEpisodeActions.ts:213`:
```ts
  const resolved = await resolveAlert(episode.linkedAlertId, input.note ?? defaultNote, input.actorUserId, false, 'manual');
```
`services/hardwareHealth/retire.ts:28`:
```ts
      if (!await resolveAlert(alert.id, note, undefined, true, 'source_retired')) continue;
```
`services/backupProviders/alerts.ts:333`:
```ts
      if (await resolveAlert(alert.id, PROVIDER_ALERT_RESOLUTION_NOTE, undefined, false, 'condition_cleared')) resolved += 1;
```
`services/backupProviders/alertsResolve.ts:32`:
```ts
      if (await resolveAlert(alertId, note, undefined, false, 'source_retired')) resolved += 1;
```

Update the two existing expectations that pin the exact argument list:

- `jobs/monitorWorker.test.ts:510`:
  ```ts
    expect(vi.mocked(resolveAlert)).toHaveBeenCalledWith(
      'alert-1',
      expect.stringContaining('recovered from offline'),
      undefined,
      false,
      'condition_cleared',
    );
  ```
- `services/backupProviders/alerts.evaluate.test.ts:132` and `:150`:
  ```ts
    expect(resolveAlert).toHaveBeenCalledWith('a1', 'Condition cleared by provider sync', undefined, false, 'condition_cleared');
  ```

- [ ] **Step 5: Run every touched suite**

Run: `cd apps/api && npx vitest run src/services/alertService src/services/policyAlertBridge.test.ts src/jobs/monitorWorker.test.ts src/services/scriptExitCodeAlerts.test.ts src/services/alertSubjects.test.ts src/services/metricAnomalyEpisodeAlerts.test.ts src/services/metricAnomalyEpisodeActions.test.ts src/services/hardwareHealth/retire.test.ts src/services/backupProviders src/services/subjectAlertOutbox && npx tsc --noEmit -p tsconfig.json`
Expected: PASS. Confirm the reported file count covers every listed path. The `src/services/alertService` substring pulls in all `alertService.*.test.ts` siblings.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/alertService.ts apps/api/src/services/alertService.resolutionReason.test.ts apps/api/src/services/policyAlertBridge.ts apps/api/src/jobs/monitorWorker.ts apps/api/src/jobs/monitorWorker.test.ts apps/api/src/services/scriptExitCodeAlerts.ts apps/api/src/services/alertSubjects.ts apps/api/src/services/metricAnomalyEpisodeAlerts.ts apps/api/src/services/metricAnomalyEpisodeActions.ts apps/api/src/services/hardwareHealth/retire.ts apps/api/src/services/backupProviders/alerts.ts apps/api/src/services/backupProviders/alertsResolve.ts apps/api/src/services/backupProviders/alerts.evaluate.test.ts
git commit -m "feat(api): persist why an alert resolved and publish it on alert.resolved

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 10: Advance fix outcomes inline from both terminal-write paths — no public events (unit + real-PG in Task 23)

**Decision D-a (orchestrator).** W1 does **not** publish `script.completed` / `script.failed`. Both events are wired to customer automations (`AutomationForm.tsx:186`) and webhooks (`WebhookForm.tsx:73`) that have never fired, and automations have no script→script loop guard, so emitting them could start self-triggering loops. Instead, the outcome watcher is called **inline** from both terminal-write paths:

- the agent-result path, which already calls `applyAutomationActionTerminal` / `evaluateScriptExitCodeAlert` (`commandResultHandlers.ts:772-815`);
- `finalizeScriptExecutionTerminal` (`scriptExecutionTerminal.ts`), used by the reaper and cancel propagation.

The 5-minute sweeper stays authoritative. Wiring the public events, with a loop guard, is a **separate follow-up issue** and is not planned here.

**Why the hook writes only `fix_outcomes`, in the caller's transaction.**

- The agent-result path runs inside an org-scoped transaction (`agentWs.ts:2423` → `runWithAgentOrgDbAccess`). That context can update its own org's `fix_outcomes` rows (shape 1). It cannot write partner-owned `fix_memory` rows, and opening a second, system-scoped pooled connection from inside it is the #1105 double-hold hazard CLAUDE.md forbids.
- So the hook does one CAS UPDATE per verdict:
  - a successful run → `awaiting_recovery` (non-terminal, no aggregate);
  - a failed, timed-out or cancelled run → terminal with `counted_at` set **and** `recount_requested_at` set.
- The sweeper's recount pass (Task 12 `recomputeForOutcome`, Task 14) then recomputes the aggregate under system scope, within ≤5 minutes, under the single identity lock. Exactly-once still holds: the CAS on `state = 'pending' AND counted_at IS NULL` means a second path (hook vs sweeper) matches zero rows.

**Why the hook ALWAYS writes inside a savepoint, including on a caller-supplied executor.** A PostgreSQL error aborts the whole enclosing transaction even when the JS error is caught; every later statement then fails with 25P02 and the commit rolls back. `propagateCancelledDeviceCommand` (`commandCancelPropagation.ts:90-97`) hands its executor, which is the caller's open transaction for the user-cancel route (`routes/devices/commands.ts:1049`), org move, decommission and the heartbeat claim (`commandClaimEligibility.ts:421`), to `finalizeScriptExecutionTerminal`. That function forwards the executor to this hook. A bare `write(executor)` whose UPDATE failed would therefore silently abort a cancel the hook's `catch` claimed to have survived. So the supplied-executor branch runs `executor.transaction(...)`. That is Drizzle's nested transaction: a driver-owned SAVEPOINT on a tx handle, and on the ambient `db` inside a context, because the `db` proxy resolves `.transaction` to the context's tx (`db/index.ts` `proxiedDb`). It is the same mechanism `withDbTransaction` uses (`db/index.ts:972-976`), whose doc explains why a raw `SAVEPOINT` statement is not enough under postgres.js. The catch sits OUTSIDE the savepoint. `ScriptTerminalExecutor` (`scriptExecutionTerminal.ts`) and `DbExecutor` (`commandCancelPropagation.ts:31`) widen to include `'transaction'`. Every production caller already passes a Drizzle tx or the ambient `db`, and both have it.

**Files:**
- Create: `apps/api/src/services/fixMemory/scriptTerminalHook.ts`
- Test: `apps/api/src/services/fixMemory/scriptTerminalHook.test.ts`
- Modify: `apps/api/src/services/commandResultHandlers.ts` (inside `if (effectiveExecution) { ... }`, after the `evaluateScriptExitCodeAlert` block ~L803)
- Modify: `apps/api/src/services/scriptExecutionTerminal.ts` (before `return { terminalised: true };`; widen `ScriptTerminalExecutor` to `Pick<typeof db, 'update' | 'select' | 'transaction'>`)
- Modify: `apps/api/src/services/commandCancelPropagation.ts` (type only: `type DbExecutor = Pick<typeof db, 'update' | 'select' | 'insert' | 'transaction'>;` at L31)
- Modify test: `apps/api/src/services/scriptExecutionTerminal.test.ts` (new case)
- Modify test: `apps/api/src/services/commandResultHandlers.exitCodeAlerts.test.ts` (new case)

**Interfaces:**
- Consumes: `fixOutcomes` (Task 2); `FIX_OUTCOME_WINDOWS` (Task 1); `withDbTransaction`, `hasDbAccessContext` (`db/index.ts:942,972`).
- Produces:
  ```ts
  export type ScriptTerminalStatus = 'completed' | 'failed' | 'timeout' | 'cancelled';
  export type OutcomeUpdateExecutor = Pick<typeof db, 'update' | 'transaction'>;
  export function terminalVerdict(status: ScriptTerminalStatus): { state: 'awaiting_recovery' | 'failed' | 'cancelled'; reason: string };
  export async function advanceOutcomesForTerminalExecution(
    input: { executionId: string; status: ScriptTerminalStatus },
    executor?: OutcomeUpdateExecutor,
  ): Promise<number>; // rows advanced; never throws; never aborts the caller's transaction
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/fixMemory/scriptTerminalHook.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sets: [] as Record<string, unknown>[], returning: [] as unknown[][], savepoints: 0, throwOnUpdate: false }));
vi.mock('../../db', () => {
  const update = vi.fn(() => ({
    set: (s: Record<string, unknown>) => {
      h.sets.push(s);
      return { where: () => ({ returning: async () => { if (h.throwOnUpdate) throw new Error('boom'); return h.returning.shift() ?? []; } }) };
    },
  }));
  return {
    db: { update },
    hasDbAccessContext: () => true,
    withDbTransaction: async (fn: () => unknown) => { h.savepoints += 1; return fn(); },
  };
});

import { advanceOutcomesForTerminalExecution, terminalVerdict } from './scriptTerminalHook';

describe('terminalVerdict', () => {
  it.each([
    ['completed', 'awaiting_recovery', 'script_succeeded'],
    ['failed', 'failed', 'script_failed'],
    ['timeout', 'failed', 'script_timeout'],
    ['cancelled', 'cancelled', 'script_cancelled'],
  ] as const)('%s → %s', (status, state, reason) => {
    expect(terminalVerdict(status)).toEqual({ state, reason });
  });
});

describe('advanceOutcomesForTerminalExecution', () => {
  beforeEach(() => { h.sets.length = 0; h.returning.length = 0; h.savepoints = 0; h.throwOnUpdate = false; });

  it('a successful run moves pending → awaiting_recovery with a 24h recovery deadline, inside a savepoint', async () => {
    h.returning.push([{ id: 'o-1' }]);
    await expect(advanceOutcomesForTerminalExecution({ executionId: 'e-1', status: 'completed' })).resolves.toBe(1);
    expect(h.sets[0]).toMatchObject({ state: 'awaiting_recovery', stateReason: 'script_succeeded' });
    expect(h.sets[0]).not.toHaveProperty('countedAt');
    expect(((h.sets[0]!.deadlineAt as Date).getTime() - Date.now()) / 3_600_000).toBeGreaterThan(23.9);
    expect(h.savepoints).toBe(1);
  });

  it('a failed run is terminal + counted and requests a deferred aggregate recount (no fix_memory write here)', async () => {
    h.returning.push([{ id: 'o-1' }]);
    await advanceOutcomesForTerminalExecution({ executionId: 'e-1', status: 'timeout' });
    expect(h.sets[0]).toMatchObject({ state: 'failed', stateReason: 'script_timeout' });
    expect(h.sets[0]!.terminalAt).toBeInstanceOf(Date);
    expect(h.sets[0]!.countedAt).toBeInstanceOf(Date);
    expect(h.sets[0]!.recountRequestedAt).toBeInstanceOf(Date);
  });

  it('never throws: a failed update is logged and reported as 0 (ingestion is the durable record)', async () => {
    h.throwOnUpdate = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(advanceOutcomesForTerminalExecution({ executionId: 'e-1', status: 'failed' })).resolves.toBe(0);
    err.mockRestore();
  });

  /** A caller's open transaction: `transaction(fn)` is Drizzle's nested transaction (a SAVEPOINT) and hands `fn` the savepoint handle. */
  function callerTx(savepointUpdate: () => Promise<unknown[]>) {
    const savepoint = { update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: savepointUpdate }) }) })) };
    const tx = {
      update: vi.fn(() => { throw new Error('the hook must never write on the caller’s transaction directly'); }),
      transaction: vi.fn(async (fn: (sp: unknown) => Promise<unknown>) => fn(savepoint)),
    };
    return { tx, savepoint };
  }

  it('uses a caller-supplied executor (the reaper’s / cancel propagation’s transaction), inside a savepoint on it', async () => {
    const { tx, savepoint } = callerTx(async () => [{ id: 'o-9' }]);
    await expect(advanceOutcomesForTerminalExecution({ executionId: 'e-1', status: 'cancelled' }, tx as never)).resolves.toBe(1);
    expect(tx.transaction).toHaveBeenCalledTimes(1);
    expect(savepoint.update).toHaveBeenCalledTimes(1);
    expect(tx.update).not.toHaveBeenCalled();
    expect(h.savepoints).toBe(0); // the ambient-db path was not used
  });

  it('a SQL failure on a caller-supplied executor is confined to the savepoint and swallowed: the caller never sees a rejection', async () => {
    // commandCancelPropagation.ts:90-97 passes its open tx through finalizeScriptExecutionTerminal.
    // A bare write there would leave that tx aborted (25P02) even though the JS error was caught.
    const { tx, savepoint } = callerTx(async () => { throw Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' }); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(advanceOutcomesForTerminalExecution({ executionId: 'e-1', status: 'failed' }, tx as never)).resolves.toBe(0);
    err.mockRestore();
    expect(tx.transaction).toHaveBeenCalledTimes(1); // the failing statement ran on the savepoint handle...
    expect(savepoint.update).toHaveBeenCalledTimes(1);
    expect(tx.update).not.toHaveBeenCalled(); // ...never on the caller's transaction
  });
});
```

Add to `scriptExecutionTerminal.test.ts`:
- a hoisted `advanceMock = vi.fn(async () => 0)`;
- `vi.mock('./fixMemory/scriptTerminalHook', () => ({ advanceOutcomesForTerminalExecution: advanceMock }))`;
- this case:

```ts
  it('advances fix outcomes only for the call that won the CAS, through the caller’s executor', async () => {
    const won = executor({ execReturning: [{ id: EXEC }] });
    await finalizeScriptExecutionTerminal({ executionId: EXEC, outcome: 'timeout', errorMessage: 'timed out', completedAt: new Date(), executor: won.exec });
    expect(advanceMock).toHaveBeenCalledWith({ executionId: EXEC, status: 'timeout' }, won.exec);

    advanceMock.mockClear();
    const lost = executor({ execReturning: [] });
    await finalizeScriptExecutionTerminal({ executionId: EXEC, outcome: 'timeout', errorMessage: 'timed out', completedAt: new Date(), executor: lost.exec });
    expect(advanceMock).not.toHaveBeenCalled();
  });
```

Add to `commandResultHandlers.exitCodeAlerts.test.ts`:
- a hoisted `advanceMock = vi.fn().mockResolvedValue(1)`;
- `vi.mock('./fixMemory/scriptTerminalHook', () => ({ advanceOutcomesForTerminalExecution: (...a: unknown[]) => { callOrder.push('fix-outcome'); return advanceMock(...a); } }))`;
- this case:

```ts
  it('advances fix outcomes after the execution row is written, with the real outcome', async () => {
    updateMock
      .mockReturnValueOnce(updateReturning([]))
      .mockReturnValueOnce(updateReturning([executionRow]));
    await commandResultHandlers.script!(scriptInput({ status: 'completed', exitCode: 0 }));
    expect(advanceMock).toHaveBeenCalledWith({ executionId: EXECUTION_ID, status: 'completed' });
    expect(callOrder.indexOf('execution-update')).toBeLessThan(callOrder.indexOf('fix-outcome'));
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/fixMemory/scriptTerminalHook.test.ts src/services/scriptExecutionTerminal.test.ts src/services/commandResultHandlers.exitCodeAlerts.test.ts`
Expected: FAIL. `./scriptTerminalHook` does not resolve, and `advanceMock` is never called in the other two suites.

- [ ] **Step 3: Implement the hook**

```ts
// apps/api/src/services/fixMemory/scriptTerminalHook.ts
/**
 * Inline fix-outcome advance from the two script terminal-write paths (AI
 * Suggested Fixes W1, decision D-a). Deliberately NOT the public
 * script.completed/script.failed events: those feed customer automations and
 * webhooks with no loop guard (separate follow-up issue).
 *
 * Runs in the CALLER's transaction and touches only fix_outcomes (the org's own
 * rows): the agent-result path is org-scoped and must not open a second pooled
 * system connection (#1105) nor write partner fix_memory rows. A terminal
 * verdict sets recount_requested_at; the sweeper recomputes the aggregate under
 * system scope. The CAS (state = 'pending' AND counted_at IS NULL) makes this
 * path and the sweeper mutually exclusive — whichever lands second matches 0.
 * NEVER throws, and NEVER aborts the caller's transaction: every write runs in
 * a savepoint (see advanceOutcomesForTerminalExecution).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { FIX_OUTCOME_WINDOWS } from '@breeze/shared';
import { db, hasDbAccessContext, withDbTransaction } from '../../db';
import { fixOutcomes } from '../../db/schema';

export type ScriptTerminalStatus = 'completed' | 'failed' | 'timeout' | 'cancelled';
/** A caller's open transaction handle (or the ambient db). `transaction` is required: the hook opens its savepoint on it. */
export type OutcomeUpdateExecutor = Pick<typeof db, 'update' | 'transaction'>;
type OutcomeWriter = Pick<typeof db, 'update'>;

export function terminalVerdict(status: ScriptTerminalStatus): { state: 'awaiting_recovery' | 'failed' | 'cancelled'; reason: string } {
  switch (status) {
    case 'completed': return { state: 'awaiting_recovery', reason: 'script_succeeded' };
    case 'failed': return { state: 'failed', reason: 'script_failed' };
    case 'timeout': return { state: 'failed', reason: 'script_timeout' };
    case 'cancelled': return { state: 'cancelled', reason: 'script_cancelled' };
  }
}

export async function advanceOutcomesForTerminalExecution(
  input: { executionId: string; status: ScriptTerminalStatus },
  executor?: OutcomeUpdateExecutor,
): Promise<number> {
  const verdict = terminalVerdict(input.status);
  const now = new Date();
  const set: Partial<typeof fixOutcomes.$inferInsert> = verdict.state === 'awaiting_recovery'
    ? { state: verdict.state, stateReason: verdict.reason, updatedAt: now,
        deadlineAt: new Date(now.getTime() + FIX_OUTCOME_WINDOWS.recoveryTimeoutHours * 3_600_000) }
    : { state: verdict.state, stateReason: verdict.reason, updatedAt: now, terminalAt: now, countedAt: now, recountRequestedAt: now };
  const write = async (ex: OutcomeWriter) => {
    const rows = await ex.update(fixOutcomes).set(set).where(and(
      eq(fixOutcomes.scriptExecutionId, input.executionId),
      eq(fixOutcomes.state, 'pending'),
      isNull(fixOutcomes.countedAt),
    )).returning({ id: fixOutcomes.id });
    return rows.length;
  };
  // The catch is OUTSIDE the savepoint on purpose. A PostgreSQL error aborts the
  // whole enclosing transaction even when the JS error is caught (25P02 on every
  // later statement, rollback at commit). Only a driver-owned savepoint that
  // rolls back before we swallow the error keeps the caller's transaction usable.
  try {
    if (executor) {
      // Caller's open transaction (reaper, commandCancelPropagation.ts:90-97 via
      // finalizeScriptExecutionTerminal). Drizzle's nested `transaction` on a tx
      // handle, or on the ambient db inside a context, is a SAVEPOINT: the same
      // mechanism as withDbTransaction (db/index.ts). Never write on `executor` directly.
      return await executor.transaction((savepoint) => write(savepoint as unknown as OutcomeWriter));
    }
    // Ambient db inside the ingest transaction: a SAVEPOINT, as evaluateScriptExitCodeAlert does.
    return hasDbAccessContext() ? await withDbTransaction(() => write(db)) : await write(db);
  } catch (err) {
    console.error(`[fixMemory] inline outcome advance failed for execution ${input.executionId}; the sweeper will retry:`, err);
    return 0;
  }
}
```

In `commandResultHandlers.ts`:
- Add `import { advanceOutcomesForTerminalExecution } from './fixMemory/scriptTerminalHook';`.
- Directly after the closing brace of the `if (!cancelConfirmed && result.status === 'completed' && typeof result.exitCode === 'number') { ... }` block, insert:

```ts
        // AI Suggested Fixes W1 (D-a) — advance any fix attempt riding on this
        // execution. Inline, own savepoint, never throws; NOT a public event.
        await advanceOutcomesForTerminalExecution({
          executionId: effectiveExecution.id,
          status: cancelConfirmed ? 'cancelled' : scriptStatus,
        });
```

In `scriptExecutionTerminal.ts`:
- Add `import { advanceOutcomesForTerminalExecution } from './fixMemory/scriptTerminalHook';`.
- Directly before `return { terminalised: true };`, insert:

```ts
  // AI Suggested Fixes W1 (D-a): only the CAS winner advances the attempt, on
  // the caller's own executor so a reaper transaction stays one transaction.
  // The hook opens a SAVEPOINT on that executor and swallows its own failure, so
  // a fix-outcome error can never abort the cancel / reap it rides on.
  await advanceOutcomesForTerminalExecution({ executionId, status: outcome }, params.executor);
```

Also in `scriptExecutionTerminal.ts`, widen the executor type so the hook can open its savepoint:

```ts
type ScriptTerminalExecutor = Pick<typeof db, 'update' | 'select' | 'transaction'>;
```

In `commandCancelPropagation.ts` (L31), widen the type it forwards into `finalizeScriptExecutionTerminal` in the same way:

```ts
type DbExecutor = Pick<typeof db, 'update' | 'select' | 'insert' | 'transaction'>;
```

Every production caller already passes a Drizzle tx or the ambient `db` (`routes/devices/commands.ts:1049`, `routes/devices/core.ts:2049`, `routes/devices/moveOrg.ts:576`, `commandClaimEligibility.ts:421`, `jobs/staleCommandReaper.ts`), and both have `.transaction`. The existing unit tests cast their mock executors `as never`, so they still typecheck.

`params.executor` is `undefined` for ambient-db callers (the reaper). They get the `withDbTransaction` savepoint branch.

- [ ] **Step 4: Run them and watch them pass (plus both handler families)**

Run: `cd apps/api && npx vitest run src/services/fixMemory/scriptTerminalHook.test.ts src/services/scriptExecutionTerminal.test.ts src/services/commandResultHandlers src/jobs/staleCommandReaper src/services/commandCancelPropagation && npx tsc --noEmit -p tsconfig.json`
Expected: PASS. A suite that mocks `../db` with only `db.update` chains returning `[]` sees `advanceOutcomesForTerminalExecution` match 0 rows. If its mock lacks `hasDbAccessContext`/`withDbTransaction`, or its mock executor lacks `.transaction`, the hook's catch logs and returns 0. If that suite asserts `console.error` was not called, add `vi.mock('./fixMemory/scriptTerminalHook', () => ({ advanceOutcomesForTerminalExecution: vi.fn(async () => 0) }))` to it. The real-Postgres proof that a hook SQL error leaves the caller's transaction committable is in Task 23 ("a SQL failure inside the hook…").

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/fixMemory/scriptTerminalHook.ts apps/api/src/services/fixMemory/scriptTerminalHook.test.ts apps/api/src/services/commandResultHandlers.ts apps/api/src/services/scriptExecutionTerminal.ts apps/api/src/services/scriptExecutionTerminal.test.ts apps/api/src/services/commandCancelPropagation.ts apps/api/src/services/commandResultHandlers.exitCodeAlerts.test.ts
git commit -m "feat(api): advance fix outcomes inline from script terminal writes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 11: Signature loader — source row → signature (unit)

**Files:**
- Create: `apps/api/src/services/fixMemory/signatureLoader.ts`
- Test: `apps/api/src/services/fixMemory/signatureLoader.test.ts`

**Interfaces:**
- Consumes: `computeSignature`, `alertConditionFacets`, `anomalyConditionFacets`, `isFixOsFamily` (Task 6); `episodeKeyFor` (`services/metricAnomalyEpisodeKeys.ts`); schema `alerts`, `alertRules`, `alertTemplates`, `alertCorrelationGroups`, `devices`, `metricAnomalies`, `metricAnomalyEpisodes`.
- Produces:
  ```ts
  export type FixSourceRef =
    | { kind: 'alert'; alertId: string }
    | { kind: 'anomaly'; anomalyId?: string | null; anomalyEpisodeId?: string | null }
    | { kind: 'correlation'; correlationGroupId: string };
  export interface ResolvedFixSource { signature: FixSignature; deviceId: string; alertId: string | null; anomalyEpisodeId: string | null }
  export async function signatureForSource(ref: FixSourceRef): Promise<ResolvedFixSource | null>;
  export async function alertSignature(alertId: string, family?: 'alert' | 'correlation'): Promise<ResolvedFixSource | null>;
  export function sourceRefFor(row: { sourceType: string; sourceId: string; anomalyEpisodeId?: string | null }): FixSourceRef | null;
  ```
  It runs on the ambient `db`. The caller supplies the context (request RLS or system).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/fixMemory/signatureLoader.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rows } = vi.hoisted(() => ({ rows: [] as unknown[][] }));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(rows.shift() ?? []).then(r);
  return { db: chain };
});

import { computeSignature } from './signature';
import { alertSignature, signatureForSource, sourceRefFor } from './signatureLoader';

describe('signatureLoader', () => {
  beforeEach(() => { rows.length = 0; });

  it('rule alert: rule override conditions win over the template', async () => {
    rows.push(
      [{ id: 'a-1', deviceId: 'd-1', ruleId: 'r-1', context: {}, requiresHuman: false }],
      [{ osType: 'windows' }],
      [{ templateId: 't-1', overrideSettings: { conditions: { type: 'service_stopped', serviceName: 'Spooler' } } }],
    );
    const out = await alertSignature('a-1');
    const expected = computeSignature({ family: 'alert', condition: 'rule:service_stopped', osFamily: 'windows', discriminator: { kind: 'service', value: 'spooler' }, rootInferred: false })!;
    expect(out).toEqual({ signature: expected, deviceId: 'd-1', alertId: 'a-1', anomalyEpisodeId: null });
  });

  it('metric_anomaly alert maps to the anomaly family via the anomaly row', async () => {
    rows.push(
      [{ id: 'a-2', deviceId: 'd-1', ruleId: null, context: { source: 'metric_anomaly', anomalyId: 'm-1' }, requiresHuman: false }],
      [{ osType: 'linux' }],
      [{ sourceTable: 'device_metrics', anomalyType: 'spike', metricName: 'cpu_percent', episodeId: 'ep-1', deviceId: 'd-1' }],
    );
    const out = await alertSignature('a-2');
    expect(out!.signature.facets).toMatchObject({ family: 'anomaly', condition: 'anomaly:device_metrics:spike:cpu', osFamily: 'linux' });
    expect(out!.signature.broad).toBe(true);
  });

  it('correlation uses the root alert with family correlation', async () => {
    rows.push(
      [{ rootAlertId: 'a-9' }],
      [{ id: 'a-9', deviceId: 'd-2', ruleId: null, context: { source: 'network_monitor', monitorType: 'ping' }, requiresHuman: false }],
      [{ osType: 'macos' }],
    );
    const out = await signatureForSource({ kind: 'correlation', correlationGroupId: 'g-1' });
    expect(out!.signature.facets).toMatchObject({ family: 'correlation', rootInferred: true, condition: 'sourced:network_monitor:ping' });
    expect(out!.alertId).toBe('a-9');
  });

  it('returns null for a missing alert or an unknown OS', async () => {
    rows.push([]);
    expect(await alertSignature('nope')).toBeNull();
    rows.push([{ id: 'a-3', deviceId: 'd-3', ruleId: null, context: { source: 'network_monitor', monitorType: 'ping' }, requiresHuman: false }], [{ osType: 'solaris' }]);
    expect(await alertSignature('a-3')).toBeNull();
  });

  it('sourceRefFor maps suggestion sources and refuses rca', () => {
    expect(sourceRefFor({ sourceType: 'alert', sourceId: 'a' })).toEqual({ kind: 'alert', alertId: 'a' });
    expect(sourceRefFor({ sourceType: 'anomaly', sourceId: 'm', anomalyEpisodeId: 'ep' })).toEqual({ kind: 'anomaly', anomalyId: 'm', anomalyEpisodeId: 'ep' });
    expect(sourceRefFor({ sourceType: 'correlation', sourceId: 'g' })).toEqual({ kind: 'correlation', correlationGroupId: 'g' });
    expect(sourceRefFor({ sourceType: 'rca', sourceId: 'x' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/fixMemory/signatureLoader.test.ts`
Expected: FAIL. `Failed to resolve import "./signatureLoader"`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/fixMemory/signatureLoader.ts
/**
 * Source row -> fix-memory signature. Reads only; runs on the ambient db, so
 * the CALLER chooses the context. The outcome watcher and memory attach run it
 * under system context, so a partner-wide template invisible to an org token
 * never produces a different signature for the same alert.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  alertCorrelationGroups, alertRules, alertTemplates, alerts, devices, metricAnomalies, metricAnomalyEpisodes,
} from '../../db/schema';
import { episodeKeyFor } from '../metricAnomalyEpisodeKeys';
import {
  alertConditionFacets, anomalyConditionFacets, computeSignature, isFixOsFamily,
  type FixOsFamily, type FixSignature,
} from './signature';

export type FixSourceRef =
  | { kind: 'alert'; alertId: string }
  | { kind: 'anomaly'; anomalyId?: string | null; anomalyEpisodeId?: string | null }
  | { kind: 'correlation'; correlationGroupId: string };

export interface ResolvedFixSource {
  signature: FixSignature;
  deviceId: string;
  alertId: string | null;
  anomalyEpisodeId: string | null;
}

export function sourceRefFor(row: { sourceType: string; sourceId: string; anomalyEpisodeId?: string | null }): FixSourceRef | null {
  switch (row.sourceType) {
    case 'alert': return { kind: 'alert', alertId: row.sourceId };
    case 'anomaly': return { kind: 'anomaly', anomalyId: row.sourceId, anomalyEpisodeId: row.anomalyEpisodeId ?? null };
    case 'correlation': return { kind: 'correlation', correlationGroupId: row.sourceId };
    default: return null; // rca: no observable condition
  }
}

async function deviceOs(deviceId: string): Promise<FixOsFamily | null> {
  const [row] = await db.select({ osType: devices.osType }).from(devices).where(eq(devices.id, deviceId)).limit(1);
  return isFixOsFamily(row?.osType) ? row!.osType as FixOsFamily : null;
}

async function ruleConditionsFor(ruleId: string | null): Promise<unknown | null> {
  if (!ruleId) return null;
  const [rule] = await db
    .select({ templateId: alertRules.templateId, overrideSettings: alertRules.overrideSettings })
    .from(alertRules).where(eq(alertRules.id, ruleId)).limit(1);
  if (!rule) return null;
  const overrides = rule.overrideSettings as Record<string, unknown> | null;
  if (overrides && overrides.conditions !== undefined && overrides.conditions !== null) return overrides.conditions;
  const [template] = await db
    .select({ conditions: alertTemplates.conditions })
    .from(alertTemplates).where(eq(alertTemplates.id, rule.templateId)).limit(1);
  return template?.conditions ?? null;
}

async function anomalySource(ref: { anomalyId?: string | null; anomalyEpisodeId?: string | null }):
  Promise<{ episodeKey: string; deviceId: string; episodeId: string | null } | null> {
  if (ref.anomalyEpisodeId) {
    const [ep] = await db
      .select({ episodeKey: metricAnomalyEpisodes.episodeKey, deviceId: metricAnomalyEpisodes.deviceId })
      .from(metricAnomalyEpisodes).where(eq(metricAnomalyEpisodes.id, ref.anomalyEpisodeId)).limit(1);
    if (ep) return { episodeKey: ep.episodeKey, deviceId: ep.deviceId, episodeId: ref.anomalyEpisodeId };
  }
  if (!ref.anomalyId) return null;
  const [a] = await db
    .select({
      sourceTable: metricAnomalies.sourceTable, anomalyType: metricAnomalies.anomalyType,
      metricName: metricAnomalies.metricName, episodeId: metricAnomalies.episodeId, deviceId: metricAnomalies.deviceId,
    })
    .from(metricAnomalies).where(eq(metricAnomalies.id, ref.anomalyId)).limit(1);
  if (!a) return null;
  return { episodeKey: episodeKeyFor(a.sourceTable, a.anomalyType, a.metricName).episodeKey, deviceId: a.deviceId, episodeId: a.episodeId ?? null };
}

export async function alertSignature(alertId: string, family: 'alert' | 'correlation' = 'alert'): Promise<ResolvedFixSource | null> {
  const [alert] = await db
    .select({ id: alerts.id, deviceId: alerts.deviceId, ruleId: alerts.ruleId, context: alerts.context, requiresHuman: alerts.requiresHuman })
    .from(alerts).where(eq(alerts.id, alertId)).limit(1);
  if (!alert) return null;
  const os = await deviceOs(alert.deviceId);
  if (!os) return null;
  const context = (alert.context ?? null) as Record<string, unknown> | null;

  if (context?.source === 'metric_anomaly' && typeof context.anomalyId === 'string') {
    const anomaly = await anomalySource({ anomalyId: context.anomalyId });
    if (!anomaly) return null;
    const facets = anomalyConditionFacets(anomaly.episodeKey);
    const signature = computeSignature({ family: 'anomaly', condition: facets.condition, osFamily: os, discriminator: null, rootInferred: false });
    return signature ? { signature, deviceId: alert.deviceId, alertId: alert.id, anomalyEpisodeId: anomaly.episodeId } : null;
  }

  const facets = alertConditionFacets({
    requiresHuman: alert.requiresHuman,
    context,
    ruleConditions: await ruleConditionsFor(alert.ruleId),
  });
  if (!facets) return null;
  const signature = computeSignature({
    family, condition: facets.condition, osFamily: os, discriminator: facets.discriminator, rootInferred: family === 'correlation',
  });
  return signature ? { signature, deviceId: alert.deviceId, alertId: alert.id, anomalyEpisodeId: null } : null;
}

export async function signatureForSource(ref: FixSourceRef): Promise<ResolvedFixSource | null> {
  if (ref.kind === 'alert') return alertSignature(ref.alertId, 'alert');
  if (ref.kind === 'correlation') {
    const [group] = await db
      .select({ rootAlertId: alertCorrelationGroups.rootAlertId })
      .from(alertCorrelationGroups).where(eq(alertCorrelationGroups.id, ref.correlationGroupId)).limit(1);
    return group?.rootAlertId ? alertSignature(group.rootAlertId, 'correlation') : null;
  }
  const anomaly = await anomalySource(ref);
  if (!anomaly) return null;
  const os = await deviceOs(anomaly.deviceId);
  if (!os) return null;
  const facets = anomalyConditionFacets(anomaly.episodeKey);
  const signature = computeSignature({ family: 'anomaly', condition: facets.condition, osFamily: os, discriminator: null, rootInferred: false });
  return signature ? { signature, deviceId: anomaly.deviceId, alertId: null, anomalyEpisodeId: anomaly.episodeId } : null;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/api && npx vitest run src/services/fixMemory/signatureLoader.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/fixMemory/signatureLoader.ts apps/api/src/services/fixMemory/signatureLoader.test.ts
git commit -m "feat(api): load fix-memory signatures from alerts, anomalies and correlations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 12: Store — the only writer of `fix_memory` (unit; real-PG proof in Task 23)

**Files:**
- Create: `apps/api/src/services/fixMemory/store.ts`
- Test: `apps/api/src/services/fixMemory/store.test.ts`
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` (`ALLOWED_WITHOUT_CAPABILITY_CHECK`, ~L64)

**Interfaces:**
- Consumes: `replayAggregate`, `effectiveResult`, `resolveFixOwner`, `fixKindForScript` (Task 7); `signatureForSource`, `sourceRefFor` (Task 11); schema tables.
- **Locking protocol (the only one for `fix_memory`):**
  - Every aggregate write goes through `recomputeIdentity`. It takes `pg_advisory_xact_lock(hashtextextended('fix_memory:<partner>:<ver>:<key>:<os>:<identity>', 0))` **before** it reads contributions.
  - `rebuildFixMemory` enumerates its identities and calls `recomputeIdentity` for each in **sorted key order**, so a rebuild can never overwrite a newer aggregate.
  - Row-level order is always: `fix_outcomes` row lock (the transition's UPDATE, or the recount's `SELECT … FOR UPDATE`) → identity lock(s).
  - A re-vote's UPDATE on the outcome row therefore waits for any in-flight recount of that row, and re-requests one after it commits.
- **Snapshot rule.** The aggregate is always computed from the PERSISTED outcome row: the one the terminal UPDATE returns (`.returning()`), never the caller's pre-transition snapshot. `fillOutcomeSignature` also reloads the row when it loses its signature CAS, so a watcher never decides on an unsigned snapshot. A terminal row that still has no signature asks the sweeper's recount pass to sign and aggregate it (`recount_requested_at`).
- **Erasure request rule.** `markFixMemoryStaleForOrgErasure` sets `stale_since` and appends the org to `rebuild_pending_org_ids` on every partner row it contributed to. A rebuild (`recomputeIdentity(..., { clearStale: true })`) works in this order under the identity lock:
  1. It reads which pending orgs are already absent from `organizations`. The cascade deletes that row last, after the org's `fix_outcomes` deletions commit.
  2. Only then does it read contributions.
  3. It removes only the orgs found absent in step 1.
  4. It clears `stale_since` only where the pending array is empty.

  So a rebuild that races the cascade cannot un-stale the row, and a failed post-cascade rebuild leaves the request in place. `stalePartnerIds` selects pending rows, so the sweeper retries every 5 minutes until the rebuild succeeds.
- Produces (every function must run inside a transaction; background callers wrap them in `inSystemDbContext`):
  ```ts
  export type TerminalTransition = { to: 'verified' | 'failed' | 'recurred' | 'inconclusive' | 'cancelled'; reason: string };
  export type OutcomeTransition = TerminalTransition
    | { to: 'awaiting_recovery'; reason: string; deadlineAt: Date }
    | { to: 'holding'; reason: string; recoveredAt: Date; holdingUntil: Date };
  export interface ContributingRow { orgId: string; partnerId: string; signatureVersion: number; signatureKey: string; broadKey: string; osType: string; fixKind: FixKind; fixIdentity: string; scriptId: string | null; scriptVersionId: string | null; builtinAction: string | null; playbookId: string | null; instructionsRef: string | null; state: FixOutcomeState; humanVote: FixVote | null; terminalAt: Date; script: { isSystem: boolean; orgId: string | null; partnerId: string | null } | null; playbook: { isBuiltIn: boolean; orgId: string | null } | null }
  export interface AggregateGroup { key: string; owner: FixOwner; identity: {...}; attempts: CountedAttempt[] }
  export function groupContributions(rows: readonly ContributingRow[]): AggregateGroup[];         // pure
  export async function transitionOutcome(outcome: FixOutcomeRow, t: OutcomeTransition, now: Date): Promise<boolean>; // aggregates the RETURNED row
  export interface IdentityKey { partnerId: string; signatureVersion: number; signatureKey: string; osType: string; fixIdentity: string }
  export function identityLockKey(identity: IdentityKey): string;
  export async function fillOutcomeSignature(row: FixOutcomeRow, now: Date): Promise<FixOutcomeRow>; // persisted row, reloaded on a lost CAS
  export async function recomputeIdentity(identity: IdentityKey, now: Date, opts?: { clearStale?: boolean }): Promise<void>;
  export async function rebuildFixMemory(scope: { partnerId: string }, now?: Date): Promise<{ identities: number }>;
  export async function markFixMemoryStaleForOrgErasure(orgId: string, now?: Date): Promise<string | null>; // returns partnerId; persists the rebuild request
  export async function markOwnerDriftStale(now?: Date): Promise<number>;
  export async function stalePartnerIds(limit: number): Promise<string[]>; // stale OR pending erasure request
  export async function recountRequestedOutcomeIds(limit: number): Promise<string[]>;
  export async function recomputeForOutcome(outcomeId: string, now?: Date, hooks?: { afterRecompute?: () => Promise<void> }): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/fixMemory/store.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateReturning, selectRows, executeRows, calls, updates, insertMock, executeMock, sigMock } = vi.hoisted(() => {
  const calls: string[] = [];
  const executeRows: unknown[][] = [];
  return {
    updateReturning: [] as unknown[][],
    selectRows: [] as unknown[][],
    executeRows,
    calls,
    updates: [] as Array<{ set: Record<string, unknown>; where: unknown }>,
    insertMock: vi.fn(),
    executeMock: vi.fn(async (_q: unknown) => { calls.push('execute'); return executeRows.shift() ?? []; }),
    sigMock: { sourceRefFor: vi.fn(), signatureForSource: vi.fn() },
  };
});
vi.mock('../../db', () => {
  const update = vi.fn(() => ({
    set: (set: Record<string, unknown>) => ({
      where: (where: unknown) => {
        calls.push('update');
        updates.push({ set, where });
        // Awaitable as-is (bulk UPDATE) and via .returning() (CAS UPDATE).
        return Object.assign(Promise.resolve(undefined), { returning: async () => updateReturning.shift() ?? [] });
      },
    }),
  }));
  // Every select chain is thenable; rows are consumed only when awaited, so a
  // select built as a subquery (partnerScope) consumes nothing.
  const select = vi.fn(() => {
    calls.push('select');
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'leftJoin', 'where', 'orderBy', 'limit', 'for']) chain[m] = () => chain;
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(selectRows.shift() ?? []).then(res, rej);
    return chain;
  });
  return { db: { update, insert: insertMock, execute: executeMock, select, selectDistinct: select, delete: vi.fn() } };
});
vi.mock('./signatureLoader', () => sigMock);

import {
  fillOutcomeSignature, groupContributions, identityLockKey, recomputeIdentity, transitionOutcome, type ContributingRow,
} from './store';

/** Flattens a Drizzle SQL object without a dialect: literal text plus bound primitive params. */
function flatten(node: unknown, out = { text: '', params: [] as unknown[] }, seen = new Set<unknown>()): { text: string; params: unknown[] } {
  if (node === null || node === undefined) return out;
  if (typeof node !== 'object') { out.params.push(node); return out; }
  if (seen.has(node)) return out;
  seen.add(node);
  const n = node as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(n.queryChunks)) { for (const c of n.queryChunks) flatten(c, out, seen); return out; }
  if (Array.isArray(n.value) && n.value.every((v) => typeof v === 'string')) { out.text += n.value.join(''); return out; } // StringChunk
  if ('value' in n && !Array.isArray(n.value) && (typeof n.value !== 'object' || n.value === null)) { out.params.push(n.value); return out; } // Param
  return out; // column / table / builder
}

beforeEach(() => {
  updateReturning.length = 0; selectRows.length = 0; executeRows.length = 0; calls.length = 0; updates.length = 0;
  insertMock.mockReset(); executeMock.mockClear(); sigMock.sourceRefFor.mockReset(); sigMock.signatureForSource.mockReset();
});

const row = (over: Partial<ContributingRow> = {}): ContributingRow => ({
  orgId: 'org-a', partnerId: 'p-1', signatureVersion: 1, signatureKey: 'k'.repeat(64), broadKey: 'b'.repeat(64),
  osType: 'windows', fixKind: 'partner_script', fixIdentity: 'script_version:v1', scriptId: 's-1', scriptVersionId: 'v1',
  builtinAction: null, playbookId: null, instructionsRef: null, state: 'verified', humanVote: null,
  terminalAt: new Date('2026-11-01T00:00:00Z'), script: { isSystem: false, orgId: null, partnerId: 'p-1' }, playbook: null,
  ...over,
});

describe('groupContributions', () => {
  it('folds attempts from different orgs of one partner into ONE partner row for a partner-wide script', () => {
    const groups = groupContributions([row(), row({ orgId: 'org-b' }), row({ orgId: 'org-c', state: 'failed' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.owner).toEqual({ orgId: null, partnerId: 'p-1' });
    expect(groups[0]!.attempts.map((a) => a.result)).toEqual(['verified', 'verified', 'failed']);
  });

  it('keeps org scripts private per org and follows CURRENT ownership (re-scope fold)', () => {
    const orgScript = { isSystem: false, orgId: 'org-a', partnerId: 'p-1' };
    const groups = groupContributions([row({ fixKind: 'org_script', script: orgScript })]);
    expect(groups[0]!.owner).toEqual({ orgId: 'org-a', partnerId: null });
    // Same historical outcome, script since promoted partner-wide:
    const folded = groupContributions([row({ fixKind: 'org_script', script: { isSystem: false, orgId: null, partnerId: 'p-1' } })]);
    expect(folded[0]!.owner).toEqual({ orgId: null, partnerId: 'p-1' });
    expect(folded[0]!.identity.fixKind).toBe('partner_script');
  });

  it('drops uncounted attempts and attempts whose fix no longer belongs to this tenant', () => {
    expect(groupContributions([row({ state: 'inconclusive' }), row({ state: 'cancelled', humanVote: 'down' })])).toEqual([]);
    expect(groupContributions([row({ fixKind: 'org_script', script: { isSystem: false, orgId: 'org-z', partnerId: 'p-1' } })])).toEqual([]);
  });

  it('splits identities by script version', () => {
    const groups = groupContributions([row(), row({ fixIdentity: 'script_version:v2', scriptVersionId: 'v2' })]);
    expect(groups).toHaveLength(2);
  });
});

describe('transitionOutcome', () => {
  it('a lost compare-and-swap is a no-op: no aggregate write (exactly-once)', async () => {
    updateReturning.push([]);
    const won = await transitionOutcome(
      { id: 'o-1', state: 'awaiting_recovery', countedAt: null, partnerId: 'p-1', signatureVersion: 1, signatureKey: 'k'.repeat(64), osType: 'windows', fixIdentity: 'script_version:v1' } as never,
      { to: 'failed', reason: 'condition_persisted' }, new Date(),
    );
    expect(won).toBe(false);
    expect(executeMock).not.toHaveBeenCalled(); // no advisory lock, no recompute
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('a non-terminal transition never recomputes', async () => {
    updateReturning.push([{ id: 'o-1' }]);
    const won = await transitionOutcome(
      { id: 'o-1', state: 'pending', countedAt: null } as never,
      { to: 'awaiting_recovery', reason: 'script_succeeded', deadlineAt: new Date() }, new Date(),
    );
    expect(won).toBe(true);
    expect(executeMock).not.toHaveBeenCalled();
  });

  const identity = { partnerId: 'p-1', signatureVersion: 1, signatureKey: 'k'.repeat(64), osType: 'windows', fixIdentity: 'script_version:v1' };
  const unsignedHolding = {
    id: 'o-1', state: 'holding', countedAt: null, partnerId: 'p-1',
    signatureVersion: null, signatureKey: null, broadKey: null, osType: null, fixIdentity: 'script_version:v1',
  };

  it('aggregates from the PERSISTED row the CAS returned, not the caller’s unsigned snapshot', async () => {
    // The snapshot predates a concurrent signature fill; the row the UPDATE hit carries the signature.
    updateReturning.push([{ ...unsignedHolding, state: 'verified', countedAt: new Date(), signatureVersion: 1, signatureKey: 'k'.repeat(64), broadKey: 'b'.repeat(64), osType: 'windows' }]);
    const won = await transitionOutcome(unsignedHolding as never, { to: 'verified', reason: 'held_with_fresh_telemetry' }, new Date());
    expect(won).toBe(true);
    // recomputeIdentity ran for the persisted identity: its first statement is that identity's advisory lock.
    expect(flatten(executeMock.mock.calls[0]![0]).params).toContain(identityLockKey(identity));
  });

  it('a counted row that is still unsigned asks the sweeper to recount it instead of silently skipping the aggregate', async () => {
    updateReturning.push([{ ...unsignedHolding, state: 'verified', countedAt: new Date() }]);
    expect(await transitionOutcome(unsignedHolding as never, { to: 'verified', reason: 'held_with_fresh_telemetry' }, new Date())).toBe(true);
    expect(executeMock).not.toHaveBeenCalled(); // nothing to aggregate yet
    expect(updates.at(-1)!.set.recountRequestedAt).toBeInstanceOf(Date);
  });
});

describe('fillOutcomeSignature', () => {
  it('a lost signature CAS returns the PERSISTED (reloaded) row, never the unsigned snapshot', async () => {
    sigMock.sourceRefFor.mockReturnValue({ kind: 'alert', alertId: 'a-1' });
    sigMock.signatureForSource.mockResolvedValue({
      signature: { version: 1, key: 'k'.repeat(64), broadKey: 'b'.repeat(64), facets: { osFamily: 'windows' } },
      deviceId: 'd-1', alertId: 'a-1', anomalyEpisodeId: null,
    });
    updateReturning.push([]); // another writer stamped the signature first: our CAS matched 0 rows
    selectRows.push([{ id: 'o-1', state: 'holding', signatureVersion: 1, signatureKey: 'k'.repeat(64), broadKey: 'b'.repeat(64), osType: 'windows' }]);
    const row = await fillOutcomeSignature({ id: 'o-1', state: 'holding', sourceType: 'alert', sourceId: 'a-1', signatureKey: null, alertId: 'a-1', anomalyEpisodeId: null } as never, new Date());
    expect(row.signatureKey).toBe('k'.repeat(64));
    expect(calls).toEqual(['update', 'select']); // CAS, then reload
  });
});

describe('recomputeIdentity(clearStale) — the durable org-erasure rebuild request', () => {
  const identity = { partnerId: 'p-1', signatureVersion: 1, signatureKey: 'k'.repeat(64), osType: 'windows', fixIdentity: 'script_version:v1' };
  const memoryWrites = () => updates.filter((u) => 'staleSince' in u.set || 'rebuildPendingOrgIds' in u.set);

  it('reads which pending orgs are already gone BEFORE it reads contributions', async () => {
    executeRows.push([], []); // advisory lock, erased-org read
    await recomputeIdentity(identity, new Date(), { clearStale: true });
    expect(calls.slice(0, 3)).toEqual(['execute', 'execute', 'select']);
  });

  it('while the erased org still exists (cascade not finished) it keeps the request and clears stale only where none is pending', async () => {
    executeRows.push([], []); // nothing erased yet
    await recomputeIdentity(identity, new Date(), { clearStale: true });
    const writes = memoryWrites();
    expect(writes.map((u) => Object.keys(u.set).sort())).toEqual([['staleSince', 'updatedAt']]); // no request removal
    expect(flatten(writes[0]!.where).text).toContain('cardinality(');
  });

  it('once the org row is gone it removes exactly that org from the request, then clears stale', async () => {
    executeRows.push([], [{ org_id: 'org-gone' }]);
    await recomputeIdentity(identity, new Date(), { clearStale: true });
    const writes = memoryWrites();
    expect(writes).toHaveLength(2);
    expect(Object.keys(writes[0]!.set)).toContain('rebuildPendingOrgIds');
    expect(flatten(writes[0]!.set.rebuildPendingOrgIds).params).toEqual(['org-gone']);
    expect(writes[1]!.set).toMatchObject({ staleSince: null });
  });

  it('a plain recompute (no clearStale) never reads erasure requests or touches stale_since', async () => {
    executeRows.push([]);
    await recomputeIdentity(identity, new Date());
    expect(executeMock).toHaveBeenCalledTimes(1); // the identity lock only
    expect(memoryWrites()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/fixMemory/store.test.ts`
Expected: FAIL. `Failed to resolve import "./store"`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/fixMemory/store.ts
/**
 * The ONLY writer of fix_memory (AI Suggested Fixes W1).
 *
 * fix_memory is DERIVED from fix_outcomes. Every write RECOMPUTES the affected
 * identity from its counted attempts rather than applying a delta, so:
 *  - exactly-once is structural: a terminal transition wins a CAS on
 *    (state, counted_at IS NULL); a redelivered event loses it and writes
 *    nothing, and a recompute is idempotent anyway;
 *  - re-votes, erasure, merge and script re-scope converge on the same answer.
 * Concurrent recomputes of one identity serialise on a transaction-scoped
 * advisory lock, so a READ COMMITTED recompute that starts after another's
 * commit always sees its outcome.
 *
 * All functions assume an open transaction (callers use inSystemDbContext).
 */
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  FIX_OUTCOME_TERMINAL_STATES,
  type FixKind, type FixOutcomeState, type FixVote,
} from '@breeze/shared';
import { db } from '../../db';
import { fixMemory, fixOutcomes, organizations, playbookDefinitions, scripts, type FixOutcomeRow } from '../../db/schema';
import {
  effectiveResult, fixKindForScript, replayAggregate, resolveFixOwner,
  type CountedAttempt, type FixOwner,
} from './aggregate';
import { signatureForSource, sourceRefFor } from './signatureLoader';

export type TerminalTransition = { to: 'verified' | 'failed' | 'recurred' | 'inconclusive' | 'cancelled'; reason: string };
export type OutcomeTransition =
  | TerminalTransition
  | { to: 'awaiting_recovery'; reason: string; deadlineAt: Date }
  | { to: 'holding'; reason: string; recoveredAt: Date; holdingUntil: Date };

export interface ContributingRow {
  orgId: string;
  partnerId: string;
  signatureVersion: number;
  signatureKey: string;
  broadKey: string;
  osType: string;
  fixKind: FixKind;
  fixIdentity: string;
  scriptId: string | null;
  scriptVersionId: string | null;
  builtinAction: string | null;
  playbookId: string | null;
  instructionsRef: string | null;
  state: FixOutcomeState;
  humanVote: FixVote | null;
  terminalAt: Date;
  script: { isSystem: boolean; orgId: string | null; partnerId: string | null } | null;
  playbook: { isBuiltIn: boolean; orgId: string | null } | null;
}

export interface AggregateIdentity {
  signatureVersion: number;
  signatureKey: string;
  broadKey: string;
  osType: string;
  fixKind: FixKind;
  fixIdentity: string;
  scriptId: string | null;
  scriptVersionId: string | null;
  builtinAction: string | null;
  playbookId: string | null;
  instructionsRef: string | null;
}

export interface AggregateGroup { key: string; owner: FixOwner; identity: AggregateIdentity; attempts: CountedAttempt[] }

function ownerKey(owner: { orgId: string | null; partnerId: string | null }, id: { signatureVersion: number; signatureKey: string; osType: string; fixIdentity: string }): string {
  return [owner.orgId ?? '', owner.partnerId ?? '', id.signatureVersion, id.signatureKey, id.osType, id.fixIdentity].join('|');
}

export function groupContributions(rows: readonly ContributingRow[]): AggregateGroup[] {
  const groups = new Map<string, AggregateGroup>();
  for (const row of rows) {
    const result = effectiveResult(row.state, row.humanVote);
    if (!result) continue;
    const owner = resolveFixOwner(
      { fixKind: row.fixKind, script: row.script, playbook: row.playbook, instructionsRef: row.instructionsRef },
      { orgId: row.orgId, partnerId: row.partnerId },
    );
    if (!owner) continue;
    const identity: AggregateIdentity = {
      signatureVersion: row.signatureVersion, signatureKey: row.signatureKey, broadKey: row.broadKey, osType: row.osType,
      // Current ownership decides the kind (an org script promoted partner-wide
      // is now a partner_script), never the kind snapshotted at attempt time.
      fixKind: row.script ? fixKindForScript(row.script) : row.fixKind,
      fixIdentity: row.fixIdentity, scriptId: row.scriptId, scriptVersionId: row.scriptVersionId,
      builtinAction: row.builtinAction, playbookId: row.playbookId, instructionsRef: row.instructionsRef,
    };
    const key = ownerKey(owner, identity);
    const existing = groups.get(key);
    const attempt: CountedAttempt = { result, vote: row.humanVote, terminalAt: row.terminalAt };
    if (existing) existing.attempts.push(attempt);
    else groups.set(key, { key, owner, identity, attempts: [attempt] });
  }
  return [...groups.values()];
}

async function loadContributions(where: SQL): Promise<ContributingRow[]> {
  const rows = await db
    .select({
      orgId: fixOutcomes.orgId, partnerId: fixOutcomes.partnerId,
      signatureVersion: fixOutcomes.signatureVersion, signatureKey: fixOutcomes.signatureKey, broadKey: fixOutcomes.broadKey,
      osType: fixOutcomes.osType, fixKind: fixOutcomes.fixKind, fixIdentity: fixOutcomes.fixIdentity,
      scriptId: fixOutcomes.scriptId, scriptVersionId: fixOutcomes.scriptVersionId, builtinAction: fixOutcomes.builtinAction,
      playbookId: fixOutcomes.playbookId, instructionsRef: fixOutcomes.instructionsRef,
      state: fixOutcomes.state, humanVote: fixOutcomes.humanVote, terminalAt: fixOutcomes.terminalAt,
      scriptIsSystem: scripts.isSystem, scriptOrgId: scripts.orgId, scriptPartnerId: scripts.partnerId,
      playbookIsBuiltIn: playbookDefinitions.isBuiltIn, playbookOrgId: playbookDefinitions.orgId,
    })
    .from(fixOutcomes)
    .leftJoin(scripts, eq(scripts.id, fixOutcomes.scriptId))
    .leftJoin(playbookDefinitions, eq(playbookDefinitions.id, fixOutcomes.playbookId))
    .where(and(where, isNotNull(fixOutcomes.countedAt), isNotNull(fixOutcomes.signatureKey), isNotNull(fixOutcomes.fixIdentity)))
    .orderBy(asc(fixOutcomes.terminalAt), asc(fixOutcomes.id));
  return rows.flatMap((r) => {
    if (r.signatureVersion === null || r.signatureKey === null || r.broadKey === null || r.osType === null || r.fixIdentity === null || r.terminalAt === null) return [];
    return [{
      orgId: r.orgId, partnerId: r.partnerId,
      signatureVersion: r.signatureVersion, signatureKey: r.signatureKey, broadKey: r.broadKey, osType: r.osType,
      fixKind: r.fixKind, fixIdentity: r.fixIdentity, scriptId: r.scriptId, scriptVersionId: r.scriptVersionId,
      builtinAction: r.builtinAction, playbookId: r.playbookId, instructionsRef: r.instructionsRef,
      state: r.state, humanVote: r.humanVote ?? null, terminalAt: r.terminalAt,
      script: r.scriptIsSystem === null ? null : { isSystem: r.scriptIsSystem, orgId: r.scriptOrgId, partnerId: r.scriptPartnerId },
      playbook: r.playbookIsBuiltIn === null ? null : { isBuiltIn: r.playbookIsBuiltIn, orgId: r.playbookOrgId },
    }];
  });
}

async function upsertGroup(group: AggregateGroup, now: Date): Promise<void> {
  const s = replayAggregate(group.attempts);
  const counts = {
    attempts: s.attempts, verifiedCount: s.verifiedCount, failedCount: s.failedCount, recurredCount: s.recurredCount,
    upVotes: s.upVotes, downVotes: s.downVotes, rollingSuccessRate: s.rollingSuccessRate,
    consecutiveFailures: s.consecutiveFailures, consecutiveVerified: s.consecutiveVerified,
    recentOutcomes: s.recentOutcomes, lastVerifiedAt: s.lastVerifiedAt, fixKind: group.identity.fixKind,
    // staleSince is deliberately NOT here: only a rebuild (clearStale) may lift
    // it, so an erasure-marked row stays out of "proven" until the rebuild.
    broadKey: group.identity.broadKey, updatedAt: now,
  };
  const values = { orgId: group.owner.orgId, partnerId: group.owner.partnerId, ...group.identity, ...counts, status: s.status };
  // A retired entry stays retired (spec "Retired"); everything else is recomputed.
  const set = { ...counts, status: sql`CASE WHEN ${fixMemory.status} = 'retired' THEN 'retired' ELSE excluded.status END` };
  if (group.owner.orgId !== null) {
    await db.insert(fixMemory).values(values).onConflictDoUpdate({
      target: [fixMemory.orgId, fixMemory.signatureVersion, fixMemory.signatureKey, fixMemory.osType, fixMemory.fixIdentity],
      targetWhere: sql`org_id IS NOT NULL`,
      set,
    });
  } else {
    await db.insert(fixMemory).values(values).onConflictDoUpdate({
      target: [fixMemory.partnerId, fixMemory.signatureVersion, fixMemory.signatureKey, fixMemory.osType, fixMemory.fixIdentity],
      targetWhere: sql`partner_id IS NOT NULL`,
      set,
    });
  }
}

/** fix_memory rows owned by `partnerId` itself or by any org under it. */
function partnerScope(partnerId: string): SQL {
  return or(
    eq(fixMemory.partnerId, partnerId),
    inArray(fixMemory.orgId, db.select({ id: organizations.id }).from(organizations).where(eq(organizations.partnerId, partnerId))),
  )!;
}

async function deleteOrphans(scope: SQL, keep: ReadonlySet<string>): Promise<number> {
  const existing = await db
    .select({ id: fixMemory.id, orgId: fixMemory.orgId, partnerId: fixMemory.partnerId, signatureVersion: fixMemory.signatureVersion, signatureKey: fixMemory.signatureKey, osType: fixMemory.osType, fixIdentity: fixMemory.fixIdentity })
    .from(fixMemory)
    .where(and(scope, ne(fixMemory.status, 'retired')));
  const orphanIds = existing.filter((e) => !keep.has(ownerKey(e, e))).map((e) => e.id);
  if (orphanIds.length > 0) await db.delete(fixMemory).where(inArray(fixMemory.id, orphanIds));
  return orphanIds.length;
}

async function lock(key: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export interface IdentityKey { partnerId: string; signatureVersion: number; signatureKey: string; osType: string; fixIdentity: string }

/** THE lock key for one aggregate identity — shared by recompute, recount and rebuild. */
export function identityLockKey(i: IdentityKey): string {
  return `fix_memory:${i.partnerId}:${i.signatureVersion}:${i.signatureKey}:${i.osType}:${i.fixIdentity}`;
}

/**
 * Stamp the signature on an outcome that has none yet. Always returns the
 * PERSISTED row: when another writer won the fill CAS, the row is reloaded, because
 * the caller's snapshot is unsigned and deciding on it would count the attempt
 * (counted_at) while skipping its aggregate.
 */
export async function fillOutcomeSignature(row: FixOutcomeRow, now: Date): Promise<FixOutcomeRow> {
  if (row.signatureKey) return row;
  const ref = sourceRefFor(row);
  if (!ref) return row;
  const resolved = await signatureForSource(ref);
  if (!resolved) return row;
  const [updated] = await db.update(fixOutcomes).set({
    signatureVersion: resolved.signature.version,
    signatureKey: resolved.signature.key,
    broadKey: resolved.signature.broadKey,
    signatureFacets: resolved.signature.facets,
    osType: resolved.signature.facets.osFamily,
    alertId: row.alertId ?? resolved.alertId,
    anomalyEpisodeId: row.anomalyEpisodeId ?? resolved.anomalyEpisodeId,
    updatedAt: now,
  }).where(and(eq(fixOutcomes.id, row.id), isNull(fixOutcomes.signatureKey))).returning();
  if (updated) return updated;
  // Lost the fill CAS (a concurrent watcher / recount signed it first): reload.
  const [current] = await db.select().from(fixOutcomes).where(eq(fixOutcomes.id, row.id)).limit(1);
  return current ?? row;
}

/** stale_since may only be lifted from a row with no outstanding org-erasure rebuild request. */
const NO_PENDING_ERASURE_REQUEST = sql`cardinality(${fixMemory.rebuildPendingOrgIds}) = 0`;

/**
 * Pending erasure orgs on this identity's partner row whose organizations row is
 * already GONE. The tenant cascade deletes `organizations` last, after the org's
 * fix_outcomes deletions have committed. So an org found absent here has no
 * outcomes left in any snapshot taken after this statement, including the
 * contribution read that follows. Requests live on partner rows only (org rows
 * are deleted by the org cascade), so this needs no partnerScope subquery.
 * Table-qualified, unaliased: the Drizzle column references render as "fix_memory"."…".
 */
async function erasedPendingOrgIds(identity: IdentityKey): Promise<string[]> {
  const rows = await db.execute<{ org_id: string }>(sql`
    SELECT DISTINCT pending.org_id
    FROM fix_memory CROSS JOIN LATERAL unnest(fix_memory.rebuild_pending_org_ids) AS pending(org_id)
    WHERE ${fixMemory.partnerId} = ${identity.partnerId}
      AND ${fixMemory.signatureVersion} = ${identity.signatureVersion}
      AND ${fixMemory.signatureKey} = ${identity.signatureKey}
      AND ${fixMemory.osType} = ${identity.osType}
      AND ${fixMemory.fixIdentity} = ${identity.fixIdentity}
      AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = pending.org_id)`);
  return [...rows].map((r) => r.org_id).filter((id): id is string => typeof id === 'string');
}

export async function recomputeIdentity(identity: IdentityKey, now: Date, opts: { clearStale?: boolean } = {}): Promise<void> {
  // Lock BEFORE reading contributions: a READ COMMITTED read taken after the
  // lock sees every earlier holder's committed outcome, so no writer can
  // replace a newer aggregate with an older one.
  await lock(identityLockKey(identity));
  // A rebuild may satisfy only erasure requests whose org was ALREADY gone
  // before it read contributions. Read that set first; never re-check after.
  const satisfiedErasures = opts.clearStale ? await erasedPendingOrgIds(identity) : [];
  const rows = await loadContributions(and(
    eq(fixOutcomes.partnerId, identity.partnerId),
    eq(fixOutcomes.signatureVersion, identity.signatureVersion),
    eq(fixOutcomes.signatureKey, identity.signatureKey),
    eq(fixOutcomes.osType, identity.osType),
    eq(fixOutcomes.fixIdentity, identity.fixIdentity),
  )!);
  const groups = groupContributions(rows);
  for (const group of groups) await upsertGroup(group, now);
  const identityScope = and(
    partnerScope(identity.partnerId),
    eq(fixMemory.signatureVersion, identity.signatureVersion),
    eq(fixMemory.signatureKey, identity.signatureKey),
    eq(fixMemory.osType, identity.osType),
    eq(fixMemory.fixIdentity, identity.fixIdentity),
  )!;
  await deleteOrphans(identityScope, new Set(groups.map((g) => g.key)));
  if (opts.clearStale) {
    if (satisfiedErasures.length > 0) {
      // One element per bound param: Drizzle expands a bare JS array into a
      // parenthesised list, not a Postgres array, so never write ${ids}::uuid[].
      const gone = sql.join(satisfiedErasures.map((id) => sql`${id}::uuid`), sql`, `);
      await db.update(fixMemory).set({
        rebuildPendingOrgIds: sql`ARRAY(SELECT x FROM unnest(${fixMemory.rebuildPendingOrgIds}) AS x WHERE x <> ALL (ARRAY[${gone}]))`,
        updatedAt: now,
      }).where(and(identityScope, sql`cardinality(${fixMemory.rebuildPendingOrgIds}) > 0`));
    }
    // Only a row with no outstanding erasure request leaves "stale". A rebuild
    // that raced the cascade, or ran while it was still deleting, keeps it stale
    // and the sweeper retries (stalePartnerIds).
    await db.update(fixMemory).set({ staleSince: null, updatedAt: now })
      .where(and(identityScope, isNotNull(fixMemory.staleSince), NO_PENDING_ERASURE_REQUEST));
  }
}

const TERMINAL = new Set<string>(FIX_OUTCOME_TERMINAL_STATES);

/**
 * The CAS returns the PERSISTED row, and the aggregate identity comes from it,
 * never from the caller's snapshot. A snapshot taken before a concurrent
 * signature fill has no signature. Aggregating from it would set counted_at yet
 * skip the recompute, so the attempt would count and never aggregate.
 */
export async function transitionOutcome(outcome: FixOutcomeRow, t: OutcomeTransition, now: Date): Promise<boolean> {
  const terminal = TERMINAL.has(t.to);
  const set: Partial<typeof fixOutcomes.$inferInsert> = { state: t.to, stateReason: t.reason, updatedAt: now };
  if (terminal) {
    set.terminalAt = now;
    set.countedAt = now;
    set.recountRequestedAt = null;
  } else if (t.to === 'awaiting_recovery') {
    set.deadlineAt = t.deadlineAt;
  } else if (t.to === 'holding') {
    set.recoveredAt = t.recoveredAt;
    set.holdingUntil = t.holdingUntil;
    set.deadlineAt = t.holdingUntil;
  }
  const [won] = await db
    .update(fixOutcomes)
    .set(set)
    .where(and(eq(fixOutcomes.id, outcome.id), eq(fixOutcomes.state, outcome.state), isNull(fixOutcomes.countedAt)))
    .returning();
  if (!won) return false;
  if (!terminal) return true;
  if (won.signatureVersion !== null && won.signatureKey && won.osType && won.fixIdentity) {
    await recomputeIdentity({
      partnerId: won.partnerId, signatureVersion: won.signatureVersion, signatureKey: won.signatureKey,
      osType: won.osType, fixIdentity: won.fixIdentity,
    }, now);
  } else if (!won.signatureKey) {
    // Counted but not aggregatable yet (the signature loader had nothing when
    // this ran). Hand it to the sweeper's recount pass, which signs it
    // (fillOutcomeSignature) and recomputes, so the attempt is never counted-but-lost.
    await db.update(fixOutcomes).set({ recountRequestedAt: now }).where(eq(fixOutcomes.id, won.id));
  }
  return true;
}

/**
 * Rebuild = recomputeIdentity for every identity the partner has (from counted
 * outcomes AND from existing rows, so orphans are removed), under the SAME
 * per-identity lock, acquired in sorted key order. Two rebuilds of one partner
 * cannot deadlock, and a single-identity recompute (one lock) cannot form a
 * cycle with a rebuild.
 */
export async function rebuildFixMemory(scope: { partnerId: string }, now: Date = new Date()): Promise<{ identities: number }> {
  const identityColumns = (t: typeof fixOutcomes | typeof fixMemory) => ({
    signatureVersion: t.signatureVersion, signatureKey: t.signatureKey, osType: t.osType, fixIdentity: t.fixIdentity,
  });
  const fromOutcomes = await db.selectDistinct(identityColumns(fixOutcomes)).from(fixOutcomes)
    .where(and(eq(fixOutcomes.partnerId, scope.partnerId), isNotNull(fixOutcomes.countedAt)));
  const fromMemory = await db.selectDistinct(identityColumns(fixMemory)).from(fixMemory).where(partnerScope(scope.partnerId));
  const identities = new Map<string, IdentityKey>();
  for (const r of [...fromOutcomes, ...fromMemory]) {
    if (r.signatureVersion === null || !r.signatureKey || !r.osType || !r.fixIdentity) continue;
    const id: IdentityKey = { partnerId: scope.partnerId, signatureVersion: r.signatureVersion, signatureKey: r.signatureKey, osType: r.osType, fixIdentity: r.fixIdentity };
    identities.set(identityLockKey(id), id);
  }
  const keys = [...identities.keys()].sort();
  for (const key of keys) await recomputeIdentity(identities.get(key)!, now, { clearStale: true });
  return { identities: keys.length };
}

/**
 * GDPR erasure, step 1 (spec "Erasure"). Before the org's outcomes are deleted,
 * every partner row it contributed to gets two marks:
 *  - it goes stale, so it drops out of "proven" at once;
 *  - it gets a DURABLE rebuild request: the org id appended to
 *    rebuild_pending_org_ids.
 * stale_since alone is not a request. A concurrent sweeper rebuild that runs
 * before the cascade has deleted anything would clear it while the org's
 * outcomes still count. If the post-cascade rebuild then failed, nothing would
 * ever re-trigger it. The request survives both. Only a rebuild that saw the
 * org's organizations row already gone before reading contributions removes it
 * (recomputeIdentity). Rows that are already stale (e.g. owner drift) still get
 * the request, and a re-run never appends the same org twice.
 * Returns the org's partner.
 */
export async function markFixMemoryStaleForOrgErasure(orgId: string, now: Date = new Date()): Promise<string | null> {
  const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) return null;
  await db.update(fixMemory).set({
    staleSince: sql`COALESCE(${fixMemory.staleSince}, ${now.toISOString()}::timestamptz)`,
    rebuildPendingOrgIds: sql`array_append(${fixMemory.rebuildPendingOrgIds}, ${orgId}::uuid)`,
    updatedAt: now,
  }).where(and(
    isNull(fixMemory.orgId),
    eq(fixMemory.partnerId, org.partnerId),
    sql`NOT (${orgId}::uuid = ANY(fix_memory.rebuild_pending_org_ids))`,
    // Outer columns are written table-qualified on purpose: an unqualified
    // column inside this subquery would bind to fix_outcomes o and always match.
    sql`EXISTS (SELECT 1 FROM fix_outcomes o WHERE o.org_id = ${orgId} AND o.counted_at IS NOT NULL
         AND o.signature_key = fix_memory.signature_key AND o.os_type = fix_memory.os_type
         AND o.fix_identity = fix_memory.fix_identity)`,
  ));
  return org.partnerId;
}

/**
 * The script's CURRENT owner no longer matches the row's owner. routes/scripts.ts
 * re-scopes org→partner, partner→org and org A→org B (:921-928), keeping the
 * version for scope-only edits (:997-1038, :1097). The row is expected to be:
 *  - partner row: system script, or partner-wide script of THIS partner;
 *  - org row: non-system script owned by THIS org.
 * Anything else (including an org_id or partner_id change) is drift: mark stale
 * so lookup stops calling it proven and the next sweep rebuilds under the
 * current owner. Outer columns are table-qualified inside the subquery on purpose.
 */
export async function markOwnerDriftStale(now: Date = new Date()): Promise<number> {
  const rows = await db.update(fixMemory).set({ staleSince: now }).where(and(
    isNull(fixMemory.staleSince),
    isNotNull(fixMemory.scriptId),
    sql`EXISTS (SELECT 1 FROM scripts s WHERE s.id = fix_memory.script_id AND NOT (
          (fix_memory.org_id IS NULL AND (s.is_system OR (s.org_id IS NULL AND s.partner_id = fix_memory.partner_id)))
          OR (fix_memory.org_id IS NOT NULL AND NOT s.is_system AND s.org_id = fix_memory.org_id)))`,
  )).returning({ id: fixMemory.id });
  return rows.length;
}

/**
 * Partners the sweeper must rebuild: any stale row, or any row still carrying
 * an org-erasure rebuild request. The request is selected on its own, not
 * through stale_since, so a retry never depends on staleness surviving. This is
 * the retry for a post-cascade rebuild that failed or never ran (crash between
 * cascade and rebuild).
 */
export async function stalePartnerIds(limit: number): Promise<string[]> {
  const rows = await db.execute<{ partner_id: string }>(sql`
    SELECT DISTINCT COALESCE(m.partner_id, o.partner_id) AS partner_id
    FROM fix_memory m LEFT JOIN organizations o ON o.id = m.org_id
    WHERE m.stale_since IS NOT NULL OR cardinality(m.rebuild_pending_org_ids) > 0
    LIMIT ${limit}`);
  return [...rows].map((r) => r.partner_id).filter((id): id is string => typeof id === 'string');
}

/** Counted outcomes waiting for an aggregate recount (re-vote, or the inline script hook's terminal verdict). */
export async function recountRequestedOutcomeIds(limit: number): Promise<string[]> {
  // Active (uncounted) rows are excluded: transitionOutcome recomputes when they
  // go terminal, so selecting them would only spin every sweep.
  const rows = await db.select({ id: fixOutcomes.id }).from(fixOutcomes)
    .where(and(isNotNull(fixOutcomes.recountRequestedAt), isNotNull(fixOutcomes.countedAt)))
    .orderBy(asc(fixOutcomes.recountRequestedAt)).limit(limit);
  return rows.map((r) => r.id);
}

/**
 * Recount one counted outcome's identity. The outcome row is locked FIRST
 * (global order: outcome row -> identity lock), so a concurrent re-vote's
 * UPDATE waits until this recount commits and then re-requests another; the
 * unconditional clear below can therefore never swallow a vote that landed
 * after our read. `hooks.afterRecompute` exists only for the interleaving test.
 */
export async function recomputeForOutcome(
  outcomeId: string,
  now: Date = new Date(),
  hooks: { afterRecompute?: () => Promise<void> } = {},
): Promise<void> {
  const [locked] = await db.select().from(fixOutcomes).where(eq(fixOutcomes.id, outcomeId)).limit(1).for('update');
  if (!locked || !locked.countedAt) return;
  const o = await fillOutcomeSignature(locked, now);
  if (o.signatureVersion !== null && o.signatureKey && o.osType && o.fixIdentity) {
    await recomputeIdentity({ partnerId: o.partnerId, signatureVersion: o.signatureVersion, signatureKey: o.signatureKey, osType: o.osType, fixIdentity: o.fixIdentity }, now);
  }
  if (hooks.afterRecompute) await hooks.afterRecompute();
  await db.update(fixOutcomes).set({ recountRequestedAt: null, updatedAt: now }).where(eq(fixOutcomes.id, outcomeId));
}
```

In `apps/api/src/__tests__/partner-wide-write-coverage.test.ts`, add inside `ALLOWED_WITHOUT_CAPABILITY_CHECK`:

```ts
  // --- fix_memory (AI Suggested Fixes W1) -----------------------------------
  // Derived aggregate recomputed from fix_outcomes by background system-context
  // jobs (outcome watcher, sweeper, tenant-erasure rebuild). No caller chooses
  // an owner axis: owner is resolved from the fix's own current ownership.
  'services/fixMemory/store.ts': 'derived aggregate written only by background system-context recompute/rebuild from fix_outcomes; no caller-facing write and no caller-chosen owner axis',
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/api && npx vitest run src/services/fixMemory/store.test.ts src/__tests__/partner-wide-write-coverage.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/fixMemory/store.ts apps/api/src/services/fixMemory/store.test.ts apps/api/src/__tests__/partner-wide-write-coverage.test.ts
git commit -m "feat(api): fix-memory store with exactly-once transitions and rebuild

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 13: Outcome watcher — state machine + orchestration + event handler (unit)

**Files:**
- Create: `apps/api/src/services/fixMemory/outcomeWatcher.ts`
- Test: `apps/api/src/services/fixMemory/outcomeWatcher.test.ts`

**Interfaces:**
- Consumes:
  - `transitionOutcome`, `OutcomeTransition` (Task 12);
  - `alertSignature` (Task 11); `fillOutcomeSignature` (Task 12);
  - `inSystemDbContext`, `readAlertRecovery`, `probeTelemetryFreshness`, `telemetryProbeFor` (Task 8);
  - `FIX_OUTCOME_WINDOWS`, `isFixOutcomeTerminal`.
- Produces:
  ```ts
  export interface ScriptReading { status: string; exitCode: number | null }
  export interface EpisodeReading { status: string; closeReason: string | null; resolvedByUserId: string | null; resolvedAt: Date | null }
  export type RecoveryReading = { kind: 'still_active' } | { kind: 'unknown' } | { kind: 'no_observable_condition' } | { kind: 'source_missing' } | { kind: 'device_moved' } | { kind: 'recovered'; at: Date } | { kind: 'cleared_other'; reason: string };
  export function decidePending(i: { script: ScriptReading | null; deadlineAt: Date; now: Date }): OutcomeTransition | null;
  export function readingFromAlert(a: AlertRecoveryReading | null): RecoveryReading;
  export function readingFromEpisode(e: EpisodeReading | 'unassembled' | 'missing'): RecoveryReading;
  export function decideAwaitingRecovery(i: { reading: RecoveryReading; createdAt: Date; deadlineAt: Date; now: Date }): OutcomeTransition | null;
  export type Recurrence = 'recurred' | 'clear' | 'unscanned';
  export function recurrencePrefilter(condition: string | null): SQL | null;
  export function decideHolding(i: { recurrence: Recurrence; deviceMoved: boolean; holdingUntil: Date; now: Date; freshness: TelemetryFreshness | null }): OutcomeTransition | null;
  export async function advanceOutcome(outcomeId: string, opts?: { now?: Date; overrides?: { script?: ScriptReading; alert?: AlertRecoveryReading } }): Promise<FixOutcomeState | null>;
  export async function handleFixOutcomeEvent(event: BreezeEvent): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/fixMemory/outcomeWatcher.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rows, transitionMock } = vi.hoisted(() => ({ rows: [] as unknown[][], transitionMock: vi.fn() }));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'orderBy', 'update', 'set', 'returning']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(rows.shift() ?? []).then(r);
  return { db: chain };
});
vi.mock('../outcomeProbes', () => ({
  inSystemDbContext: (fn: () => unknown) => fn(),
  readAlertRecovery: vi.fn(async () => null),
  probeTelemetryFreshness: vi.fn(),
  telemetryProbeFor: () => ({ table: 'device_metrics', column: 'cpu_percent' }),
}));
vi.mock('./signatureLoader', () => ({ signatureForSource: vi.fn(async () => null), alertSignature: vi.fn(async () => null), sourceRefFor: vi.fn(() => null) }));
vi.mock('./store', () => ({ transitionOutcome: transitionMock, fillOutcomeSignature: async (row: unknown) => row }));

import { PgDialect } from 'drizzle-orm/pg-core';
import {
  decideAwaitingRecovery, decideHolding, decidePending, handleFixOutcomeEvent, readingFromAlert, readingFromEpisode,
  recurrencePrefilter,
} from './outcomeWatcher';

const T0 = new Date('2026-11-01T00:00:00Z');
const at = (h: number) => new Date(T0.getTime() + h * 3_600_000);

describe('decidePending', () => {
  it.each([
    [{ status: 'completed', exitCode: 0 }, 1, 'awaiting_recovery', 'script_succeeded'],
    [{ status: 'failed', exitCode: 1 }, 1, 'failed', 'script_failed'],
    [{ status: 'timeout', exitCode: null }, 1, 'failed', 'script_timeout'],
    [{ status: 'cancelled', exitCode: null }, 1, 'cancelled', 'script_cancelled'],
    [{ status: 'running', exitCode: null }, 25, 'inconclusive', 'script_never_finished'],
    [null, 25, 'inconclusive', 'script_execution_missing'],
  ] as const)('%o at +%ih → %s', (script, hours, to, reason) => {
    expect(decidePending({ script, deadlineAt: at(24), now: at(hours) })).toMatchObject({ to, reason });
  });
  it('waits while the script is still running before the deadline', () => {
    expect(decidePending({ script: { status: 'running', exitCode: null }, deadlineAt: at(24), now: at(1) })).toBeNull();
  });
});

describe('readingFromAlert (Review Focus 2)', () => {
  const base = { resolvedAt: at(2), resolvedBy: null, resolutionReason: 'condition_cleared' };
  it.each([
    [{ status: 'resolved', ...base }, { kind: 'recovered', at: at(2) }],
    [{ status: 'resolved', ...base, resolvedBy: 'user-1' }, { kind: 'cleared_other', reason: 'human_resolved' }],
    [{ status: 'resolved', ...base, resolutionReason: 'source_retired' }, { kind: 'cleared_other', reason: 'resolved_source_retired' }],
    [{ status: 'resolved', ...base, resolutionReason: 'expired' }, { kind: 'cleared_other', reason: 'resolved_expired' }],
    [{ status: 'resolved', ...base, resolutionReason: null }, { kind: 'cleared_other', reason: 'resolved_unspecified' }],
    [{ status: 'dismissed', ...base }, { kind: 'cleared_other', reason: 'alert_dismissed' }],
    [{ status: 'suppressed', ...base }, { kind: 'still_active' }],
    [{ status: 'active', ...base }, { kind: 'still_active' }],
    [null, { kind: 'source_missing' }],
  ] as const)('%o → %o', (reading, expected) => {
    expect(readingFromAlert(reading as never)).toEqual(expected);
  });
});

describe('readingFromEpisode', () => {
  const ep = { status: 'resolved', closeReason: 'cleared', resolvedByUserId: null, resolvedAt: at(3) };
  it('only a cleared, system-closed episode is recovery', () => {
    expect(readingFromEpisode(ep)).toEqual({ kind: 'recovered', at: at(3) });
    expect(readingFromEpisode({ ...ep, closeReason: 'expired_offline' })).toEqual({ kind: 'cleared_other', reason: 'episode_expired_offline' });
    expect(readingFromEpisode({ ...ep, resolvedByUserId: 'u' })).toEqual({ kind: 'cleared_other', reason: 'human_resolved' });
    expect(readingFromEpisode({ ...ep, status: 'open' })).toEqual({ kind: 'still_active' });
    expect(readingFromEpisode('unassembled')).toEqual({ kind: 'unknown' });
    expect(readingFromEpisode('missing')).toEqual({ kind: 'source_missing' });
  });
});

describe('decideAwaitingRecovery', () => {
  const common = { createdAt: at(0), deadlineAt: at(24) };
  it('objective recovery after the fix starts a 24h hold from the recovery time', () => {
    expect(decideAwaitingRecovery({ ...common, now: at(3), reading: { kind: 'recovered', at: at(2) } }))
      .toEqual({ to: 'holding', reason: 'condition_cleared', recoveredAt: at(2), holdingUntil: at(26) });
  });
  it('a condition that cleared before the fix was admitted is inconclusive', () => {
    expect(decideAwaitingRecovery({ ...common, now: at(1), reading: { kind: 'recovered', at: new Date(at(0).getTime() - 60_000) } }))
      .toEqual({ to: 'inconclusive', reason: 'cleared_before_fix' });
  });
  it.each([
    [{ kind: 'cleared_other', reason: 'human_resolved' }, 1, { to: 'inconclusive', reason: 'human_resolved' }],
    [{ kind: 'source_missing' }, 1, { to: 'inconclusive', reason: 'source_missing' }],
    [{ kind: 'no_observable_condition' }, 1, { to: 'inconclusive', reason: 'no_observable_condition' }],
    [{ kind: 'device_moved' }, 1, { to: 'cancelled', reason: 'device_moved' }],
    [{ kind: 'still_active' }, 23, null],
    [{ kind: 'still_active' }, 24, { to: 'failed', reason: 'condition_persisted' }],
    [{ kind: 'unknown' }, 24, { to: 'inconclusive', reason: 'recovery_unobservable' }],
  ] as const)('%o at +%ih → %o', (reading, hours, expected) => {
    expect(decideAwaitingRecovery({ ...common, now: at(hours), reading: reading as never })).toEqual(expected);
  });
});

describe('decideHolding (Review Focus 3)', () => {
  const fresh = { fresh: true, reason: 'ok', coverage: 0.9 } as const;
  it.each([
    [{ recurrence: 'recurred', deviceMoved: false, now: at(5), freshness: null }, { to: 'recurred', reason: 'same_signature_recurred' }],
    [{ recurrence: 'clear', deviceMoved: true, now: at(5), freshness: null }, { to: 'cancelled', reason: 'device_moved' }],
    [{ recurrence: 'clear', deviceMoved: false, now: at(5), freshness: null }, null],
    [{ recurrence: 'unscanned', deviceMoved: false, now: at(5), freshness: null }, null],
    [{ recurrence: 'unscanned', deviceMoved: false, now: at(27), freshness: fresh }, { to: 'inconclusive', reason: 'recurrence_scan_capped' }],
    [{ recurrence: 'clear', deviceMoved: false, now: at(27), freshness: fresh }, { to: 'verified', reason: 'held_with_fresh_telemetry' }],
    [{ recurrence: 'clear', deviceMoved: false, now: at(27), freshness: { fresh: false, reason: 'heartbeat_stale', coverage: 0 } }, { to: 'inconclusive', reason: 'telemetry_heartbeat_stale' }],
    [{ recurrence: 'clear', deviceMoved: false, now: at(27), freshness: { fresh: false, reason: 'metric_gap', coverage: 0.4 } }, { to: 'inconclusive', reason: 'telemetry_metric_gap' }],
    [{ recurrence: 'clear', deviceMoved: false, now: at(27), freshness: { fresh: false, reason: 'metric_unmapped', coverage: 0 } }, { to: 'inconclusive', reason: 'telemetry_metric_unmapped' }],
  ] as const)('%o → %o', (input, expected) => {
    expect(decideHolding({ ...input, holdingUntil: at(26) } as never)).toEqual(expected);
  });
});

describe('recurrencePrefilter (Review Focus 3 — recurrence must not hide behind unrelated alerts)', () => {
  const dialect = new PgDialect();
  it('only ever narrows to alerts whose signature could match', () => {
    expect(dialect.sqlToQuery(recurrencePrefilter('rule:service_stopped')!).sql).toContain('"rule_id" is not null');
    const sourced = dialect.sqlToQuery(recurrencePrefilter('sourced:script_exit_code:s-1')!);
    expect(sourced.sql).toContain(`->>'source' =`);
    expect(sourced.params).toEqual(['script_exit_code']);
    expect(dialect.sqlToQuery(recurrencePrefilter('sourced:patch_failed:any')!).params).toEqual(['patch-job-finalizer']);
    expect(dialect.sqlToQuery(recurrencePrefilter('anomaly:device_metrics:spike:cpu')!).sql).toContain(`'metric_anomaly'`);
    expect(recurrencePrefilter('sourced:unknown_thing')).toBeNull();
    expect(recurrencePrefilter(null)).toBeNull();
  });
});

describe('handleFixOutcomeEvent (Review Focus 1)', () => {
  beforeEach(() => { rows.length = 0; transitionMock.mockReset().mockResolvedValue(true); });

  const awaiting = {
    id: 'o-1', orgId: 'org-1', partnerId: 'p-1', deviceId: 'd-1', state: 'awaiting_recovery', countedAt: null,
    signatureKey: 'k'.repeat(64), sourceType: 'alert', sourceId: 'a-1', alertId: 'a-1',
    scriptExecutionId: 'e-1', deadlineAt: at(24), createdAt: at(0),
  };
  const evt = { id: 'ev', type: 'alert.resolved', orgId: 'org-1', source: 's', priority: 'normal',
    payload: { alertId: 'a-1', resolvedAt: at(2).toISOString(), resolvedBy: null, resolutionReason: 'condition_cleared' },
    metadata: { timestamp: '' } } as never;

  it('duplicate alert.resolved delivery transitions once', async () => {
    // delivery 1: lookup ids -> outcome row -> device org
    rows.push([{ id: 'o-1' }], [awaiting], [{ orgId: 'org-1' }]);
    await handleFixOutcomeEvent(evt);
    // delivery 2 raced the lookup: the row it re-reads has already left awaiting_recovery for good
    rows.push([{ id: 'o-1' }], [{ ...awaiting, state: 'verified', countedAt: at(30) }]);
    await handleFixOutcomeEvent(evt);
    // delivery 3 after the move: the state-filtered lookup finds nothing
    rows.push([]);
    await handleFixOutcomeEvent(evt);
    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(transitionMock.mock.calls[0]![1]).toEqual({ to: 'holding', reason: 'condition_cleared', recoveredAt: at(2), holdingUntil: at(26) });
  });

  it('ignores script.* (W1 never subscribes to them — decision D-a) and malformed payloads', async () => {
    await handleFixOutcomeEvent({ ...evt, type: 'script.failed', payload: { executionId: 'e-1', status: 'failed' } } as never);
    await handleFixOutcomeEvent({ ...evt, payload: { resolvedAt: at(2).toISOString() } } as never);
    expect(transitionMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/fixMemory/outcomeWatcher.test.ts`
Expected: FAIL. `Failed to resolve import "./outcomeWatcher"`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/fixMemory/outcomeWatcher.ts
/**
 * Fix-outcome state machine (AI Suggested Fixes W1, spec "Outcome lifecycle").
 *
 *   pending ─script failed/timeout─► failed      ─cancelled─► cancelled
 *      │ script ok
 *      ▼
 *   awaiting_recovery ─still active at deadline─► failed ("ran, didn't fix")
 *      │             ─human/cleanup/expiry/dismiss─► inconclusive
 *      │ objective condition clear (resolution_reason = condition_cleared,
 *      ▼                            resolved_by IS NULL, after the fix)
 *   holding ─same signature recurs on the device─► recurred
 *      │    ─telemetry gap / device offline────► inconclusive
 *      ▼
 *   verified
 *
 * The deciders are PURE. advanceOutcome reads, decides, and hands the
 * transition to store.transitionOutcome, whose CAS makes every path
 * (sweeper, event, redelivery) safe to run concurrently.
 */
import { and, asc, eq, gt, isNotNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { FIX_OUTCOME_WINDOWS, isFixOutcomeTerminal, type FixOutcomeState } from '@breeze/shared';
import { db } from '../../db';
import { alerts, devices, fixOutcomes, metricAnomalies, metricAnomalyEpisodes, scriptExecutions, type FixOutcomeRow } from '../../db/schema';
import type { BreezeEvent } from '../eventBus';
import {
  inSystemDbContext, probeTelemetryFreshness, readAlertRecovery, telemetryProbeFor,
  type AlertRecoveryReading, type TelemetryFreshness,
} from '../outcomeProbes';
import { alertSignature } from './signatureLoader';
import { fillOutcomeSignature, transitionOutcome, type OutcomeTransition } from './store';

const HOUR_MS = 3_600_000;
const EVENT_FANOUT_LIMIT = 50;
const RECURRENCE_PAGE = 50;
const RECURRENCE_MAX_PAGES = 20;

export interface ScriptReading { status: string; exitCode: number | null }
export interface EpisodeReading { status: string; closeReason: string | null; resolvedByUserId: string | null; resolvedAt: Date | null }
export type RecoveryReading =
  | { kind: 'still_active' }
  | { kind: 'unknown' }
  | { kind: 'no_observable_condition' }
  | { kind: 'source_missing' }
  | { kind: 'device_moved' }
  | { kind: 'recovered'; at: Date }
  | { kind: 'cleared_other'; reason: string };

export function decidePending(i: { script: ScriptReading | null; deadlineAt: Date; now: Date }): OutcomeTransition | null {
  const deadlinePassed = i.now.getTime() >= i.deadlineAt.getTime();
  if (!i.script) return deadlinePassed ? { to: 'inconclusive', reason: 'script_execution_missing' } : null;
  switch (i.script.status) {
    case 'completed':
      return {
        to: 'awaiting_recovery', reason: 'script_succeeded',
        deadlineAt: new Date(i.now.getTime() + FIX_OUTCOME_WINDOWS.recoveryTimeoutHours * HOUR_MS),
      };
    case 'failed': return { to: 'failed', reason: 'script_failed' };
    case 'timeout': return { to: 'failed', reason: 'script_timeout' };
    case 'cancelled': return { to: 'cancelled', reason: 'script_cancelled' };
    default: return deadlinePassed ? { to: 'inconclusive', reason: 'script_never_finished' } : null;
  }
}

export function readingFromAlert(a: AlertRecoveryReading | null): RecoveryReading {
  if (!a) return { kind: 'source_missing' };
  if (a.status === 'dismissed') return { kind: 'cleared_other', reason: 'alert_dismissed' };
  if (a.status !== 'resolved') return { kind: 'still_active' };
  if (a.resolvedBy) return { kind: 'cleared_other', reason: 'human_resolved' };
  if (a.resolutionReason === 'condition_cleared' && a.resolvedAt) return { kind: 'recovered', at: a.resolvedAt };
  return { kind: 'cleared_other', reason: `resolved_${a.resolutionReason ?? 'unspecified'}` };
}

export function readingFromEpisode(e: EpisodeReading | 'unassembled' | 'missing'): RecoveryReading {
  if (e === 'unassembled') return { kind: 'unknown' };
  if (e === 'missing') return { kind: 'source_missing' };
  if (e.status === 'dismissed') return { kind: 'cleared_other', reason: 'episode_dismissed' };
  if (e.status === 'open') return { kind: 'still_active' };
  if (e.resolvedByUserId) return { kind: 'cleared_other', reason: 'human_resolved' };
  if (e.closeReason === 'cleared' && e.resolvedAt) return { kind: 'recovered', at: e.resolvedAt };
  return { kind: 'cleared_other', reason: `episode_${e.closeReason ?? 'closed'}` };
}

export function decideAwaitingRecovery(i: { reading: RecoveryReading; createdAt: Date; deadlineAt: Date; now: Date }): OutcomeTransition | null {
  const deadlinePassed = i.now.getTime() >= i.deadlineAt.getTime();
  const r = i.reading;
  switch (r.kind) {
    case 'device_moved': return { to: 'cancelled', reason: 'device_moved' };
    case 'no_observable_condition': return { to: 'inconclusive', reason: 'no_observable_condition' };
    case 'source_missing': return { to: 'inconclusive', reason: 'source_missing' };
    case 'cleared_other': return { to: 'inconclusive', reason: r.reason };
    case 'recovered':
      if (r.at.getTime() < i.createdAt.getTime()) return { to: 'inconclusive', reason: 'cleared_before_fix' };
      return {
        to: 'holding', reason: 'condition_cleared', recoveredAt: r.at,
        holdingUntil: new Date(r.at.getTime() + FIX_OUTCOME_WINDOWS.holdHours * HOUR_MS),
      };
    case 'unknown': return deadlinePassed ? { to: 'inconclusive', reason: 'recovery_unobservable' } : null;
    case 'still_active': return deadlinePassed ? { to: 'failed', reason: 'condition_persisted' } : null;
  }
}

export type Recurrence = 'recurred' | 'clear' | 'unscanned';

export function decideHolding(i: {
  recurrence: Recurrence; deviceMoved: boolean; holdingUntil: Date; now: Date; freshness: TelemetryFreshness | null;
}): OutcomeTransition | null {
  if (i.deviceMoved) return { to: 'cancelled', reason: 'device_moved' };
  if (i.recurrence === 'recurred') return { to: 'recurred', reason: 'same_signature_recurred' };
  if (i.now.getTime() < i.holdingUntil.getTime()) return null;
  // Too many candidate alerts to rule a recurrence out: never call that "held".
  if (i.recurrence === 'unscanned') return { to: 'inconclusive', reason: 'recurrence_scan_capped' };
  if (!i.freshness) return null;
  return i.freshness.fresh
    ? { to: 'verified', reason: 'held_with_fresh_telemetry' }
    : { to: 'inconclusive', reason: `telemetry_${i.freshness.reason}` };
}

// ---------------------------------------------------------------- orchestration

async function deviceLeftOrg(row: FixOutcomeRow): Promise<boolean> {
  const [device] = await db.select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, row.deviceId)).limit(1);
  return !device || device.orgId !== row.orgId;
}

async function readScript(executionId: string | null): Promise<ScriptReading | null> {
  if (!executionId) return null;
  const [s] = await db.select({ status: scriptExecutions.status, exitCode: scriptExecutions.exitCode })
    .from(scriptExecutions).where(eq(scriptExecutions.id, executionId)).limit(1);
  return s ? { status: s.status, exitCode: s.exitCode ?? null } : null;
}

async function readRecovery(row: FixOutcomeRow, alertOverride?: AlertRecoveryReading): Promise<RecoveryReading> {
  if (row.alertId) return readingFromAlert(alertOverride ?? await readAlertRecovery(row.alertId));
  if (row.sourceType === 'anomaly') {
    let episodeId = row.anomalyEpisodeId;
    if (!episodeId) {
      const [a] = await db.select({ episodeId: metricAnomalies.episodeId }).from(metricAnomalies)
        .where(eq(metricAnomalies.id, row.sourceId)).limit(1);
      if (!a) return readingFromEpisode('missing');
      if (!a.episodeId) return readingFromEpisode('unassembled');
      episodeId = a.episodeId;
      await db.update(fixOutcomes).set({ anomalyEpisodeId: episodeId }).where(eq(fixOutcomes.id, row.id));
    }
    const [e] = await db.select({
      status: metricAnomalyEpisodes.status, closeReason: metricAnomalyEpisodes.closeReason,
      resolvedByUserId: metricAnomalyEpisodes.resolvedByUserId, resolvedAt: metricAnomalyEpisodes.resolvedAt,
    }).from(metricAnomalyEpisodes).where(eq(metricAnomalyEpisodes.id, episodeId)).limit(1);
    return readingFromEpisode(e ?? 'missing');
  }
  if (row.sourceType === 'alert' || row.sourceType === 'correlation') return { kind: 'source_missing' };
  return { kind: 'no_observable_condition' };
}

function conditionOf(row: FixOutcomeRow): { family: string | null; condition: string | null } {
  const facets = (row.signatureFacets ?? null) as { family?: unknown; condition?: unknown } | null;
  return {
    family: typeof facets?.family === 'string' ? facets.family : null,
    condition: typeof facets?.condition === 'string' ? facets.condition : null,
  };
}

const SOURCED_CONTEXT_SOURCES: Readonly<Record<string, string>> = {
  network_monitor: 'network_monitor', script_exit_code: 'script_exit_code', patch_failed: 'patch-job-finalizer',
  reboot_pending: 'maintenance-reboot-sweep', warranty_expiry: 'warranty_evaluator', backup_provider: 'backup_provider',
  network_baseline: 'network_baseline', policy_violation: 'policy-evaluation',
};

/**
 * A SQL prefilter that can only EXCLUDE alerts whose signature cannot equal
 * this condition's (mirrors signature.ts: rule:* needs a rule, sourced:* needs
 * that context.source, anomaly:* comes from a metric_anomaly alert). null = no
 * safe narrowing; every alert in the window is a candidate.
 */
export function recurrencePrefilter(condition: string | null): SQL | null {
  if (!condition) return null;
  if (condition.startsWith('rule:')) return isNotNull(alerts.ruleId);
  if (condition.startsWith('sourced:')) {
    const source = SOURCED_CONTEXT_SOURCES[condition.split(':')[1] ?? ''];
    return source ? sql`${alerts.context}->>'source' = ${source}` : null;
  }
  if (condition.startsWith('anomaly:')) return sql`${alerts.context}->>'source' = 'metric_anomaly'`;
  return null;
}

/**
 * Did the same signature come back on this device inside the hold window?
 * Candidates are filtered in SQL (device, (recovered_at, min(now, holding_until)],
 * prefilter), ordered by (triggered_at, id) and paged by keyset, so a real
 * recurrence can never be hidden behind an arbitrary unordered LIMIT.
 * 'unscanned' = page cap hit without an answer (fails closed as inconclusive).
 */
async function scanRecurrence(row: FixOutcomeRow, now: Date): Promise<Recurrence> {
  if (!row.signatureKey || !row.recoveredAt || !row.holdingUntil) return 'clear';
  const { family, condition } = conditionOf(row);
  const windowEnd = new Date(Math.min(now.getTime(), row.holdingUntil.getTime()));
  if (family === 'anomaly' && condition?.startsWith('anomaly:')) {
    const conds: SQL[] = [
      eq(metricAnomalyEpisodes.deviceId, row.deviceId),
      eq(metricAnomalyEpisodes.episodeKey, condition.slice('anomaly:'.length)),
      gt(metricAnomalyEpisodes.firstSeenAt, row.recoveredAt),
      lte(metricAnomalyEpisodes.firstSeenAt, windowEnd),
    ];
    if (row.anomalyEpisodeId) conds.push(ne(metricAnomalyEpisodes.id, row.anomalyEpisodeId));
    const [again] = await db.select({ id: metricAnomalyEpisodes.id }).from(metricAnomalyEpisodes).where(and(...conds)).limit(1);
    if (again) return 'recurred';
  }
  const base: SQL[] = [
    eq(alerts.deviceId, row.deviceId),
    gt(alerts.triggeredAt, row.recoveredAt),
    lte(alerts.triggeredAt, windowEnd),
    eq(alerts.requiresHuman, false),
  ];
  if (row.alertId) base.push(ne(alerts.id, row.alertId));
  const prefilter = recurrencePrefilter(condition);
  if (prefilter) base.push(prefilter);
  const alertFamily = family === 'correlation' ? 'correlation' : 'alert';
  let cursor: { triggeredAt: Date; id: string } | null = null;
  for (let page = 0; page < RECURRENCE_MAX_PAGES; page += 1) {
    const conds = [...base];
    if (cursor) {
      conds.push(or(gt(alerts.triggeredAt, cursor.triggeredAt), and(eq(alerts.triggeredAt, cursor.triggeredAt), gt(alerts.id, cursor.id)))!);
    }
    const batch = await db.select({ id: alerts.id, triggeredAt: alerts.triggeredAt }).from(alerts)
      .where(and(...conds)).orderBy(asc(alerts.triggeredAt), asc(alerts.id)).limit(RECURRENCE_PAGE);
    for (const candidate of batch) {
      const resolved = await alertSignature(candidate.id, alertFamily);
      if (resolved && resolved.signature.key === row.signatureKey) return 'recurred';
    }
    if (batch.length < RECURRENCE_PAGE) return 'clear';
    cursor = batch[batch.length - 1]!;
  }
  return 'unscanned';
}

async function decide(
  row: FixOutcomeRow, moved: boolean, now: Date,
  overrides: { script?: ScriptReading; alert?: AlertRecoveryReading },
): Promise<OutcomeTransition | null> {
  if (row.state === 'pending') {
    if (moved) return { to: 'cancelled', reason: 'device_moved' };
    return decidePending({ script: overrides.script ?? await readScript(row.scriptExecutionId), deadlineAt: row.deadlineAt, now });
  }
  if (row.state === 'awaiting_recovery') {
    const reading: RecoveryReading = moved ? { kind: 'device_moved' } : await readRecovery(row, overrides.alert);
    return decideAwaitingRecovery({ reading, createdAt: row.createdAt, deadlineAt: row.deadlineAt, now });
  }
  if (!row.holdingUntil || !row.recoveredAt) return { to: 'inconclusive', reason: 'hold_window_missing' };
  const recurrence: Recurrence = moved ? 'clear' : await scanRecurrence(row, now);
  const due = now.getTime() >= row.holdingUntil.getTime();
  const freshness = !moved && recurrence === 'clear' && due
    ? await probeTelemetryFreshness({
      deviceId: row.deviceId, from: row.recoveredAt, to: row.holdingUntil,
      probe: telemetryProbeFor(conditionOf(row).condition),
    })
    : null;
  return decideHolding({ recurrence, deviceMoved: moved, holdingUntil: row.holdingUntil, now, freshness });
}

export async function advanceOutcome(
  outcomeId: string,
  opts: { now?: Date; overrides?: { script?: ScriptReading; alert?: AlertRecoveryReading } } = {},
): Promise<FixOutcomeState | null> {
  const now = opts.now ?? new Date();
  return inSystemDbContext(async () => {
    const [loaded] = await db.select().from(fixOutcomes).where(eq(fixOutcomes.id, outcomeId)).limit(1);
    if (!loaded) return null;
    if (isFixOutcomeTerminal(loaded.state)) return loaded.state;
    // fillOutcomeSignature returns the PERSISTED row (reloaded if another writer
    // signed it first), so `decide` never sees an unsigned snapshot. The same
    // reload can reveal that a concurrent writer already finished the attempt.
    const row = await fillOutcomeSignature(loaded, now);
    if (isFixOutcomeTerminal(row.state)) return row.state;
    const transition = await decide(row, await deviceLeftOrg(row), now, opts.overrides ?? {});
    if (!transition) return row.state;
    // transitionOutcome aggregates from the row its CAS returns, not from `row`.
    const won = await transitionOutcome(row, transition, now);
    return won ? transition.to : row.state;
  }, 'fixOutcomeWatcher.advance');
}

async function outcomeIdsWhere(condition: SQL): Promise<string[]> {
  return inSystemDbContext(async () => {
    const found = await db.select({ id: fixOutcomes.id }).from(fixOutcomes).where(condition).limit(EVENT_FANOUT_LIMIT);
    return found.map((r) => r.id);
  }, 'fixOutcomeWatcher.lookup');
}

/**
 * Durable subscriber 'fix-outcome-watcher' on alert.resolved / alert.triggered
 * (fast path). The 5-minute sweeper
 * is authoritative; this only shortens latency. Gates on the PUBLISHED
 * payload (eventBus contract: publishers may publish before their commit), and
 * every write goes through the CAS, so redelivery is harmless. Throws on DB
 * failure so queue mode retries.
 */
export async function handleFixOutcomeEvent(event: BreezeEvent): Promise<void> {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const now = new Date();

  // Script terminal verdicts arrive through the inline hook (scriptTerminalHook.ts,
  // decision D-a), never as events.
  if (event.type === 'alert.resolved') {
    const alertId = typeof p.alertId === 'string' ? p.alertId : null;
    if (!alertId) return;
    const resolvedAt = typeof p.resolvedAt === 'string' ? new Date(p.resolvedAt) : null;
    // Without the C2 payload fields, fall back to reading the row (sweeper-safe).
    const alert: AlertRecoveryReading | undefined = resolvedAt && !Number.isNaN(resolvedAt.getTime())
      ? {
        status: 'resolved', resolvedAt,
        resolvedBy: typeof p.resolvedBy === 'string' ? p.resolvedBy : null,
        resolutionReason: typeof p.resolutionReason === 'string' ? p.resolutionReason : null,
      }
      : undefined;
    for (const id of await outcomeIdsWhere(and(eq(fixOutcomes.alertId, alertId), eq(fixOutcomes.state, 'awaiting_recovery'))!)) {
      await advanceOutcome(id, { now, overrides: { alert } });
    }
    return;
  }

  if (event.type === 'alert.triggered') {
    const deviceId = typeof p.deviceId === 'string' ? p.deviceId : null;
    if (!deviceId) return;
    for (const id of await outcomeIdsWhere(and(eq(fixOutcomes.deviceId, deviceId), eq(fixOutcomes.state, 'holding'))!)) {
      await advanceOutcome(id, { now });
    }
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/api && npx vitest run src/services/fixMemory/outcomeWatcher.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/fixMemory/outcomeWatcher.ts apps/api/src/services/fixMemory/outcomeWatcher.test.ts
git commit -m "feat(api): fix-outcome state machine with objective-recovery and fresh-telemetry gates

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 14: Sweeper worker + durable subscribers (unit + contract)

**Files:**
- Create: `apps/api/src/jobs/fixOutcomeWorker.ts`
- Test: `apps/api/src/jobs/fixOutcomeWorker.test.ts`
- Modify: `apps/api/src/services/eventSubscriberIds.ts` (after `'dns-threat-alerts',`)
- Modify: `apps/api/src/services/eventSubscribers.ts` (two `registerEventSubscriber` blocks before `notification-dispatcher`)
- Modify: `apps/api/src/services/workerRegistry.ts` (append after the `sendingDomainsWorker` entry, before `];` ~L1565)
- Modify: `apps/api/src/services/workerRegistry.test.ts` (append to `EXPECTED_WORKER_NAMES`)
- Modify: `apps/api/src/services/workerEntrypointClosure.contract.test.ts` (append to `EXPECTED_NAMES`)
- Modify: `apps/api/src/jobs/workerReadinessManifest.ts` (before the `sendingDomainsWorker` row ~L289)

**Interfaces:**
- Consumes:
  - `advanceOutcome`, `handleFixOutcomeEvent` (Task 13);
  - `rebuildFixMemory`, `markOwnerDriftStale`, `stalePartnerIds`, `recountRequestedOutcomeIds`, `recomputeForOutcome` (Task 12).
- Produces:
  ```ts
  export interface FixOutcomeSweepStats { scanned: number; errors: number; recounted: number; drifted: number; rebuilt: number }
  export async function runFixOutcomeSweep(now?: Date): Promise<FixOutcomeSweepStats>;
  export async function initializeFixOutcomeWorker(): Promise<void>;
  export async function shutdownFixOutcomeWorker(): Promise<void>;
  ```
  Queue `'fix-outcome-sweep'`, job `'sweep-fix-outcomes'`, `repeat: { every: 5 * 60_000 }`. It is sub-hourly, so it needs no `scheduleRegistry` slot.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/jobs/fixOutcomeWorker.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ids: [] as string[],
  advance: vi.fn(), rebuild: vi.fn(), drift: vi.fn(async () => 2), stale: vi.fn(async () => ['p-1']),
  recountIds: vi.fn(async () => ['o-9']), recompute: vi.fn(async () => undefined), captureException: vi.fn(),
}));
vi.mock('bullmq', () => ({
  Queue: class { add = vi.fn(); getRepeatableJobs = vi.fn(async () => []); removeRepeatableByKey = vi.fn(); close = vi.fn(); },
  Worker: class { on = vi.fn(); close = vi.fn(); },
}));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(h.ids.map((id) => ({ id }))).then(r);
  return { db: chain };
});
vi.mock('../services/outcomeProbes', () => ({ inSystemDbContext: (fn: () => unknown) => fn() }));
vi.mock('../services/fixMemory/outcomeWatcher', () => ({ advanceOutcome: h.advance }));
vi.mock('../services/fixMemory/store', () => ({
  rebuildFixMemory: h.rebuild, markOwnerDriftStale: h.drift, stalePartnerIds: h.stale,
  recountRequestedOutcomeIds: h.recountIds, recomputeForOutcome: h.recompute,
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/sentry', () => ({ captureException: h.captureException }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

import { runFixOutcomeSweep } from './fixOutcomeWorker';

describe('runFixOutcomeSweep', () => {
  beforeEach(() => { vi.clearAllMocks(); h.ids = ['o-1', 'o-2', 'o-3']; });

  it('advances every active outcome and keeps going past one that throws', async () => {
    h.advance.mockResolvedValueOnce('holding').mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('verified');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stats = await runFixOutcomeSweep(new Date('2026-11-02T00:00:00Z'));
    err.mockRestore();
    expect(h.advance).toHaveBeenCalledTimes(3);
    expect(stats).toEqual({ scanned: 3, errors: 1, recounted: 1, drifted: 2, rebuilt: 1 });
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });

  it('rebuilds stale partners (retry path for a failed erasure rebuild)', async () => {
    h.ids = [];
    await runFixOutcomeSweep();
    expect(h.rebuild).toHaveBeenCalledWith({ partnerId: 'p-1' }, expect.any(Date));
    expect(h.recompute).toHaveBeenCalledWith('o-9', expect.any(Date));
  });
});
```

First add the watcher id to `apps/api/src/services/eventSubscriberIds.ts`, directly after `'dns-threat-alerts',`. The `'fix-memory-attach'` id is added together with its registration in Task 17.

```ts
  // AI Suggested Fixes W1 — fast path for the fix-outcome state machine
  // (alert.resolved, alert.triggered). The sweeper is authoritative.
  'fix-outcome-watcher',
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/jobs/fixOutcomeWorker.test.ts src/services/eventSubscribers.contract.test.ts`
Expected: FAIL.
- The worker suite cannot resolve `./fixOutcomeWorker`.
- The contract suite reports `expected exactly one "id: 'fix-outcome-watcher'" in eventSubscribers.ts`.

- [ ] **Step 3: Implement the worker**

```ts
// apps/api/src/jobs/fixOutcomeWorker.ts
/**
 * fix-outcome sweeper (AI Suggested Fixes W1). Every 5 minutes:
 *   1. advance every active fix_outcomes row (authoritative path — event
 *      delivery defaults to in-process best-effort, EVENT_DISPATCH_MODE=off);
 *   2. recompute aggregates whose attempts were re-voted or terminalised by the
 *      inline script hook (scriptTerminalHook.ts sets recount_requested_at);
 *   3. mark owner drift (script re-scoped) stale;
 *   4. rebuild stale partners and partners with a pending org-erasure rebuild
 *      request (fix_memory.rebuild_pending_org_ids). This is the RETRY for a
 *      tenant-erasure rebuild that failed or never ran. The request is cleared
 *      only by a rebuild that saw the erased org's organizations row already
 *      gone, so a rebuild that races the cascade cannot satisfy it.
 * Each outcome advances in its OWN system transaction, so one bad row cannot
 * poison the batch. Sub-hourly repeat: no scheduleRegistry slot needed.
 */
import { Queue, Worker, type Job } from 'bullmq';
import { asc, inArray } from 'drizzle-orm';
import { FIX_OUTCOME_ACTIVE_STATES } from '@breeze/shared';
import { db } from '../db';
import { fixOutcomes } from '../db/schema';
import { inSystemDbContext } from '../services/outcomeProbes';
import { advanceOutcome } from '../services/fixMemory/outcomeWatcher';
import {
  markOwnerDriftStale, rebuildFixMemory, recomputeForOutcome, recountRequestedOutcomeIds, stalePartnerIds,
} from '../services/fixMemory/store';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'fix-outcome-sweep';
const JOB_NAME = 'sweep-fix-outcomes';
const INTERVAL_MS = 5 * 60_000;
const MAX_OUTCOMES_PER_RUN = 500;
const MAX_RECOUNTS_PER_RUN = 200;
const MAX_REBUILDS_PER_RUN = 20;

type SweepJobData = { type: typeof JOB_NAME; queuedAt: string };

export interface FixOutcomeSweepStats { scanned: number; errors: number; recounted: number; drifted: number; rebuilt: number }

let sweepQueue: Queue<SweepJobData> | null = null;
let sweepWorker: Worker<SweepJobData> | null = null;

function report(scope: string, id: string, err: unknown): void {
  console.error(`[FixOutcomeSweep] ${scope} failed for ${id}:`, err);
  captureException(err instanceof Error ? err : new Error(String(err)));
}

export async function runFixOutcomeSweep(now: Date = new Date()): Promise<FixOutcomeSweepStats> {
  const ids = await inSystemDbContext(async () => {
    const found = await db.select({ id: fixOutcomes.id }).from(fixOutcomes)
      .where(inArray(fixOutcomes.state, [...FIX_OUTCOME_ACTIVE_STATES]))
      .orderBy(asc(fixOutcomes.deadlineAt))
      .limit(MAX_OUTCOMES_PER_RUN);
    return found.map((r) => r.id);
  }, 'fixOutcomeSweep.select');

  let errors = 0;
  for (const id of ids) {
    try { await advanceOutcome(id, { now }); } catch (err) { errors += 1; report('advance', id, err); }
  }

  let recounted = 0;
  const recountIds = await inSystemDbContext(() => recountRequestedOutcomeIds(MAX_RECOUNTS_PER_RUN), 'fixOutcomeSweep.recountSelect');
  for (const id of recountIds) {
    try { await inSystemDbContext(() => recomputeForOutcome(id, now), 'fixOutcomeSweep.recount'); recounted += 1; } catch (err) { report('recount', id, err); }
  }

  const drifted = await inSystemDbContext(() => markOwnerDriftStale(now), 'fixOutcomeSweep.drift');

  let rebuilt = 0;
  const partners = await inSystemDbContext(() => stalePartnerIds(MAX_REBUILDS_PER_RUN), 'fixOutcomeSweep.staleSelect');
  for (const partnerId of partners) {
    try { await inSystemDbContext(() => rebuildFixMemory({ partnerId }, now), 'fixOutcomeSweep.rebuild'); rebuilt += 1; } catch (err) { report('rebuild', partnerId, err); }
  }

  if (ids.length === MAX_OUTCOMES_PER_RUN) console.warn(`[FixOutcomeSweep] hit the ${MAX_OUTCOMES_PER_RUN}-row cap — backlog may be growing`);
  return { scanned: ids.length, errors, recounted, drifted, rebuilt };
}

function getQueue(): Queue<SweepJobData> {
  if (!sweepQueue) sweepQueue = new Queue<SweepJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  return sweepQueue;
}

async function scheduleRepeatableJob(): Promise<void> {
  const queue = getQueue();
  for (const job of await queue.getRepeatableJobs()) {
    if (job.name === JOB_NAME) await queue.removeRepeatableByKey(job.key);
  }
  await queue.add(JOB_NAME, { type: JOB_NAME, queuedAt: new Date().toISOString() }, {
    jobId: QUEUE_NAME, repeat: { every: INTERVAL_MS },
    removeOnComplete: { count: 20 }, removeOnFail: { count: 200 },
  });
}

export async function initializeFixOutcomeWorker(): Promise<void> {
  if (sweepWorker) return;
  sweepWorker = new Worker<SweepJobData>(QUEUE_NAME, async (_job: Job<SweepJobData>) => runFixOutcomeSweep(), {
    connection: getBullMQConnection(), concurrency: 1,
  });
  attachWorkerObservability(sweepWorker, 'fixOutcomeWorker');
  sweepWorker.on('error', (error) => { console.error('[FixOutcomeSweep] Worker error:', error); captureException(error); });
  sweepWorker.on('failed', (job, error) => { console.error(`[FixOutcomeSweep] Job ${job?.id} failed:`, error); captureException(error); });
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await sweepWorker.close();
    sweepWorker = null;
    throw err;
  }
  console.log(`[FixOutcomeSweep] Initialized (every ${INTERVAL_MS / 60_000}m)`);
}

export async function shutdownFixOutcomeWorker(): Promise<void> {
  const worker = sweepWorker;
  const queue = sweepQueue;
  sweepWorker = null;
  sweepQueue = null;
  if (worker) { try { await worker.close(); } catch (err) { console.error('[FixOutcomeSweep] Error closing worker:', err); } }
  if (queue) { try { await queue.close(); } catch (err) { console.error('[FixOutcomeSweep] Error closing queue:', err); } }
}
```

- [ ] **Step 4: Register the watcher subscriber and the worker**

In `apps/api/src/services/eventSubscribers.ts`, insert before the `registerEventSubscriber({ id: 'notification-dispatcher', ...` block:

```ts
  registerEventSubscriber({
    id: 'fix-outcome-watcher',
    // AI Suggested Fixes W1 — fast path for fix_outcomes. Gates on the
    // published payload; every write is a CAS, so redelivery is a no-op.
    // Deliberately NOT script.* (decision D-a: inline hook instead).
    // Lazy for the same worker-closure reason as the subscribers above.
    eventTypes: ['alert.resolved', 'alert.triggered'],
    handler: async (event: BreezeEvent) => {
      const { handleFixOutcomeEvent } = await import('./fixMemory/outcomeWatcher');
      return handleFixOutcomeEvent(event);
    },
    retry: { attempts: 5, backoffMs: 10_000 },
  });
```

`apps/api/src/services/workerRegistry.ts`, append before the final `];`:

```ts
  {
    // AI Suggested Fixes W1 — 5-minute fix-outcome sweeper. `global`: its
    // closure is db + fixMemory services + outcomeProbes, never routes or
    // socket-local dispatch (workerEntrypointClosure.contract.test.ts).
    name: 'fixOutcomeWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/fixOutcomeWorker');
      return { init: m.initializeFixOutcomeWorker, shutdown: m.shutdownFixOutcomeWorker };
    },
  },
```

`apps/api/src/services/workerRegistry.test.ts`, append to `EXPECTED_WORKER_NAMES` after `'sendingDomainsWorker',`:

```ts
  // AI Suggested Fixes W1 — fix-outcome sweeper.
  'fixOutcomeWorker',
```

`apps/api/src/services/workerEntrypointClosure.contract.test.ts`, append to `EXPECTED_NAMES` after `'sendingDomainsWorker',`:

```ts
  // AI Suggested Fixes W1.
  'fixOutcomeWorker',
```

`apps/api/src/jobs/workerReadinessManifest.ts`, insert directly before the `consumers('sendingDomainsWorker', ...)` row:

```ts
  // AI Suggested Fixes W1 — attachWorkerObservability name == registry name.
  consumers('fixOutcomeWorker'),
```

- [ ] **Step 5: Run the worker suite and every registry contract**

Run: `cd apps/api && npx vitest run src/jobs/fixOutcomeWorker.test.ts src/services/eventSubscribers.contract.test.ts src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts src/jobs/workerReadinessCoverage.test.ts src/jobs/scheduleRegistry.contract.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/jobs/fixOutcomeWorker.ts apps/api/src/jobs/fixOutcomeWorker.test.ts apps/api/src/services/eventSubscriberIds.ts apps/api/src/services/eventSubscribers.ts apps/api/src/services/workerRegistry.ts apps/api/src/services/workerRegistry.test.ts apps/api/src/services/workerEntrypointClosure.contract.test.ts apps/api/src/jobs/workerReadinessManifest.ts
git commit -m "feat(api): fix-outcome sweeper worker and durable outcome subscriber

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 15: Extract the candidate catalog and include partner-wide scripts (unit + real-PG)

**Precondition:** #7124 is merged and this branch is rebased on it. Run `git log --oneline -1 --grep '7118' origin/main`. If it prints nothing, stop and rebase once it lands. This task edits the post-#7124 `listCandidates`.

**Files:**
- Create: `apps/api/src/services/fixMemory/catalog.ts`
- Test: `apps/api/src/services/fixMemory/catalog.test.ts`
- Create: `apps/api/src/__tests__/integration/fixMemoryCatalog.integration.test.ts`
- Modify: `apps/api/src/services/remediationSuggestions.ts` (the post-#7124 `TEMPLATE_LANGUAGES_BY_OS`, `NON_REMEDIATION_SYSTEM_SCRIPT_NAMES`, `resolveDeviceOs` and the query half of `listCandidates`)

**Interfaces:**
- Produces:
  ```ts
  export interface CatalogContext { orgId: string; partnerId: string | null; deviceOs: FixOsFamily | null }
  export const TEMPLATE_LANGUAGES_BY_OS: Readonly<Record<FixOsFamily, ReadonlySet<string>>>;
  export const NON_REMEDIATION_SYSTEM_SCRIPT_NAMES: readonly string[];
  export function scriptVisibilityCondition(ctx: CatalogContext): SQL;
  export async function listCatalogScripts(ctx: CatalogContext, limit?: number): Promise<Array<{ id: string; name: string; description: string | null; category: string | null; runAs: string; osTypes: string[]; isSystem: boolean }>>;
  export async function listCatalogTemplates(ctx: CatalogContext, limit?: number): Promise<Array<{ id: string; name: string; description: string | null; category: string | null; rating: unknown; language: string | null }>>;
  export async function listCatalogPlaybooks(ctx: CatalogContext, limit?: number): Promise<Array<{ id: string; name: string; description: string | null; category: string | null; isBuiltIn: boolean }>>;
  export async function resolveDeviceOs(deviceId: string | null): Promise<FixOsFamily | null>;
  export async function resolveOrgPartnerId(orgId: string): Promise<string | null>;
  ```
  The playbook projection is copied verbatim from the post-#7124 `listCandidates`. If it selects more columns than listed here, keep those too.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/fixMemory/catalog.test.ts
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { scriptVisibilityCondition } from './catalog';

const dialect = new PgDialect();
const compile = (ctx: Parameters<typeof scriptVisibilityCondition>[0]) => dialect.sqlToQuery(scriptVisibilityCondition(ctx));

describe('scriptVisibilityCondition', () => {
  it('includes the org’s partner-wide scripts (the pre-W1 matcher missed them)', () => {
    const q = compile({ orgId: 'org-1', partnerId: 'p-1', deviceOs: 'linux' });
    expect(q.sql).toContain('"scripts"."partner_id" = $');
    expect(q.params).toEqual(expect.arrayContaining(['org-1', 'p-1', 'linux']));
  });
  it('has no partner branch when the org’s partner is unknown', () => {
    const q = compile({ orgId: 'org-1', partnerId: null, deviceOs: null });
    expect(q.sql).not.toContain('"scripts"."partner_id"');
    expect(q.sql).not.toContain('@>');
  });
});
```

```ts
// apps/api/src/__tests__/integration/fixMemoryCatalog.integration.test.ts
import './setup';
import { describe, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { scripts } from '../../db/schema';
import { listCatalogScripts } from '../../services/fixMemory/catalog';
import { SYSTEM_LIBRARY_SCRIPTS } from '../../services/systemScriptLibrary';
import { createOrganization, createPartner } from './db-utils';

describe('fix memory catalog (real Postgres, system context = app-layer filter only)', () => {
  it('returns system + own-partner-wide + own-org scripts runnable on the OS, nothing else', async () => {
    const pA = await createPartner();
    const pB = await createPartner();
    const a1 = await createOrganization({ partnerId: pA.id });
    const a2 = await createOrganization({ partnerId: pA.id });
    const tag = `cat-${Date.now()}`;
    const s = (name: string, v: Partial<typeof scripts.$inferInsert>) =>
      ({ name: `${tag} ${name}`, language: 'bash' as const, content: 'echo ok', osTypes: ['linux'], ...v });
    await withSystemDbAccessContext(() => db.insert(scripts).values([
      s('system linux', { isSystem: true, osTypes: ['windows', 'linux'] }),
      s('partner A linux', { partnerId: pA.id }),
      s('partner A windows', { partnerId: pA.id, osTypes: ['windows'], language: 'powershell' }),
      s('org A1', { orgId: a1.id, partnerId: pA.id }),
      s('org A1 deleted', { orgId: a1.id, partnerId: pA.id, deletedAt: new Date() }),
      s('org A2', { orgId: a2.id, partnerId: pA.id }),
      s('partner B', { partnerId: pB.id }),
      { name: SYSTEM_LIBRARY_SCRIPTS[0]!.name, language: 'bash' as const, content: 'echo lifecycle', osTypes: ['linux'], isSystem: true },
    ]));
    const rows = await withSystemDbAccessContext(() =>
      listCatalogScripts({ orgId: a1.id, partnerId: pA.id, deviceOs: 'linux' }, 500));
    const mine = rows.map((r) => r.name).filter((n) => n.startsWith(tag)).sort();
    expect(mine).toEqual([`${tag} org A1`, `${tag} partner A linux`, `${tag} system linux`]);
    expect(rows.map((r) => r.name)).not.toContain(SYSTEM_LIBRARY_SCRIPTS[0]!.name);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/fixMemory/catalog.test.ts`
Expected: FAIL. `Failed to resolve import "./catalog"`.

- [ ] **Step 3: Implement `catalog.ts`**

```ts
// apps/api/src/services/fixMemory/catalog.ts
/**
 * Candidate catalog (extracted from remediationSuggestions.listCandidates,
 * AI Suggested Fixes W1). Everything a suggestion may reference: visible to the
 * org AND runnable on the device OS. W1 adds the org's PARTNER-WIDE scripts
 * (org_id NULL, partner_id = the org's partner), which the pre-W1 query
 * (`isSystem OR orgId = ctx.orgId`) never returned.
 *
 * Visibility is enforced here at the app layer too, so callers running under
 * system context (memory attach) never see another org's scripts.
 */
import { and, desc, eq, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { devices, organizations, playbookDefinitions, scripts, scriptTemplates } from '../../db/schema';
import { SYSTEM_LIBRARY_SCRIPTS } from '../systemScriptLibrary';
import { isFixOsFamily, type FixOsFamily } from './signature';

export interface CatalogContext { orgId: string; partnerId: string | null; deviceOs: FixOsFamily | null }

// Script languages a device OS can run. Templates carry a language but no OS
// list; python runs everywhere, and a null language is left unfiltered.
export const TEMPLATE_LANGUAGES_BY_OS: Readonly<Record<FixOsFamily, ReadonlySet<string>>> = {
  windows: new Set(['powershell', 'cmd', 'python']),
  linux: new Set(['bash', 'python']),
  macos: new Set(['bash', 'python']),
};

// The system script library holds agent-lifecycle tooling, not remediations
// (#7118) — never offered as a fix.
export const NON_REMEDIATION_SYSTEM_SCRIPT_NAMES: readonly string[] = SYSTEM_LIBRARY_SCRIPTS.map((def) => def.name);

export function scriptVisibilityCondition(ctx: CatalogContext): SQL {
  const owners: SQL[] = [eq(scripts.isSystem, true), eq(scripts.orgId, ctx.orgId)];
  if (ctx.partnerId) owners.push(and(isNull(scripts.orgId), eq(scripts.partnerId, ctx.partnerId))!);
  const conditions: SQL[] = [isNull(scripts.deletedAt), or(...owners)!];
  if (NON_REMEDIATION_SYSTEM_SCRIPT_NAMES.length > 0) {
    conditions.push(or(eq(scripts.isSystem, false), notInArray(scripts.name, [...NON_REMEDIATION_SYSTEM_SCRIPT_NAMES]))!);
  }
  if (ctx.deviceOs) conditions.push(sql`${scripts.osTypes} @> ARRAY[${ctx.deviceOs}]::text[]`);
  return and(...conditions)!;
}

export async function listCatalogScripts(ctx: CatalogContext, limit = 100) {
  return db.select({
    id: scripts.id, name: scripts.name, description: scripts.description, category: scripts.category,
    runAs: scripts.runAs, osTypes: scripts.osTypes, isSystem: scripts.isSystem,
  }).from(scripts).where(scriptVisibilityCondition(ctx)).orderBy(desc(scripts.updatedAt)).limit(limit);
}

export async function listCatalogTemplates(_ctx: CatalogContext, limit = 100) {
  return db.select({
    id: scriptTemplates.id, name: scriptTemplates.name, description: scriptTemplates.description,
    category: scriptTemplates.category, rating: scriptTemplates.rating, language: scriptTemplates.language,
  }).from(scriptTemplates).orderBy(desc(scriptTemplates.downloads)).limit(limit);
}

export async function listCatalogPlaybooks(ctx: CatalogContext, limit = 100) {
  return db.select({
    id: playbookDefinitions.id, name: playbookDefinitions.name, description: playbookDefinitions.description,
    category: playbookDefinitions.category, isBuiltIn: playbookDefinitions.isBuiltIn,
  }).from(playbookDefinitions)
    .where(and(eq(playbookDefinitions.isActive, true), or(eq(playbookDefinitions.isBuiltIn, true), eq(playbookDefinitions.orgId, ctx.orgId))!))
    .orderBy(playbookDefinitions.category, playbookDefinitions.name)
    .limit(limit);
}

export async function resolveDeviceOs(deviceId: string | null): Promise<FixOsFamily | null> {
  if (!deviceId) return null;
  const [row] = await db.select({ osType: devices.osType }).from(devices).where(eq(devices.id, deviceId)).limit(1);
  return isFixOsFamily(row?.osType) ? (row!.osType as FixOsFamily) : null;
}

export async function resolveOrgPartnerId(orgId: string): Promise<string | null> {
  const [row] = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return row?.partnerId ?? null;
}
```

- [ ] **Step 4: Point `listCandidates` at the catalog**

In `apps/api/src/services/remediationSuggestions.ts` (post-#7124):

1. Delete the local `DeviceOs` type, `TEMPLATE_LANGUAGES_BY_OS`, `NON_REMEDIATION_SYSTEM_SCRIPT_NAMES`, `resolveDeviceOs` and the `SYSTEM_LIBRARY_SCRIPTS` import. Add:
   ```ts
   import {
     listCatalogPlaybooks, listCatalogScripts, listCatalogTemplates, NON_REMEDIATION_SYSTEM_SCRIPT_NAMES,
     resolveDeviceOs, resolveOrgPartnerId, TEMPLATE_LANGUAGES_BY_OS,
   } from './fixMemory/catalog';
   ```
2. In `listCandidates`, replace everything from `const deviceOs = await resolveDeviceOs(ctx.deviceId);` through the closing `]);` of the `Promise.all([...])` with:
   ```ts
   const deviceOs = await resolveDeviceOs(ctx.deviceId);
   const catalogCtx = { orgId: ctx.orgId, partnerId: await resolveOrgPartnerId(ctx.orgId), deviceOs };
   const [scriptRows, templateRows, playbookRows] = await Promise.all([
     listCatalogScripts(catalogCtx),
     listCatalogTemplates(catalogCtx),
     listCatalogPlaybooks(catalogCtx),
   ]);
   ```
   The in-loop mirror filters (`NON_REMEDIATION_SYSTEM_SCRIPT_NAMES.includes(row.name)`, `row.osTypes.includes(deviceOs)`, `TEMPLATE_LANGUAGES_BY_OS[deviceOs]`) stay unchanged and now read the imported constants.
3. Remove any drizzle-orm imports that become unused (`isNull`, `notInArray`, `or`, `desc`, `sql`).

- [ ] **Step 5: Run unit, service and real-PG tests**

Run: `cd apps/api && npx vitest run src/services/fixMemory/catalog.test.ts src/services/remediationSuggestions.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS. The #7124 OS-filter and lifecycle-exclusion cases in `remediationSuggestions.test.ts` still pass unedited.

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/fixMemoryCatalog.integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/fixMemory/catalog.ts apps/api/src/services/fixMemory/catalog.test.ts apps/api/src/__tests__/integration/fixMemoryCatalog.integration.test.ts apps/api/src/services/remediationSuggestions.ts
git commit -m "refactor(api): extract the OS-filtered remediation catalog and include partner-wide scripts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 16: Lookup — proven vs similar, under the caller's RLS (unit)

**Files:**
- Create: `apps/api/src/services/fixMemory/lookup.ts`
- Test: `apps/api/src/services/fixMemory/lookup.test.ts`

**Interfaces:**
- Consumes: `isProven` (Task 7); `FixSignature` (Task 6).
- Produces:
  ```ts
  export interface FixTrackRecord { memoryId: string; scope: 'all_clients' | 'this_client'; fixKind: FixKind; scriptId: string | null; scriptVersionId: string | null; scriptName: string | null; builtinAction: string | null; playbookId: string | null; attempts: number; verified: number; failed: number; recurred: number; upVotes: number; downVotes: number; successRate: number; lastVerifiedAt: string | null; status: FixMemoryStatus }
  export interface FixLookupResult { signature: { version: number; broad: boolean; family: string; condition: string; osFamily: string; discriminatorKind: string | null }; proven: FixTrackRecord[]; similar: FixTrackRecord[] }
  export interface MemoryCandidateRow { id; orgId; partnerId; signatureKey; broadKey; osType; fixKind; scriptId; scriptVersionId; builtinAction; playbookId; attempts; verifiedCount; failedCount; recurredCount; upVotes; downVotes; rollingSuccessRate; recentOutcomes: string[]; status: FixMemoryStatus; staleSince: Date | null; lastVerifiedAt: Date | null; script: { name: string; deletedAt: Date | null; osTypes: string[]; headVersion: number; isSystem: boolean; orgId: string | null; partnerId: string | null } | null; scriptVersionNumber: number | null }
  export function classifyMemoryRows(rows: readonly MemoryCandidateRow[], ctx: { orgId: string; partnerId: string; signatureKey: string; broadKey: string; broad: boolean; osFamily: string }, limit: number): { proven: FixTrackRecord[]; similar: FixTrackRecord[] };
  export async function lookupFixes(input: { orgId: string; partnerId: string; signature: FixSignature; limit: number }): Promise<FixLookupResult>;
  ```
  The discriminator VALUE (e.g. a service name) is never returned; only its kind is.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/fixMemory/lookup.test.ts
import { describe, expect, it } from 'vitest';
import { classifyMemoryRows, type MemoryCandidateRow } from './lookup';

const K = 'k'.repeat(64);
const B = 'b'.repeat(64);
const ctx = { orgId: 'org-a', partnerId: 'p-1', signatureKey: K, broadKey: B, broad: false, osFamily: 'windows' };
const row = (over: Partial<MemoryCandidateRow> = {}): MemoryCandidateRow => ({
  id: 'm-1', orgId: null, partnerId: 'p-1', signatureKey: K, broadKey: B, osType: 'windows', fixKind: 'partner_script',
  scriptId: 's-1', scriptVersionId: 'v-1', builtinAction: null, playbookId: null,
  attempts: 4, verifiedCount: 4, failedCount: 0, recurredCount: 0, upVotes: 1, downVotes: 0,
  rollingSuccessRate: 1, recentOutcomes: ['verified', 'verified', 'verified', 'verified'], status: 'active',
  staleSince: null, lastVerifiedAt: new Date('2026-11-01T00:00:00Z'),
  script: { name: 'Restart spooler', deletedAt: null, osTypes: ['windows'], headVersion: 3, isSystem: false, orgId: null, partnerId: 'p-1' }, scriptVersionNumber: 3,
  ...over,
});

describe('classifyMemoryRows', () => {
  it('a proven partner row is proven with an "all clients" scope', () => {
    const { proven, similar } = classifyMemoryRows([row()], ctx, 5);
    expect(proven).toHaveLength(1);
    expect(proven[0]).toMatchObject({ scope: 'all_clients', verified: 4, attempts: 4, successRate: 1, scriptName: 'Restart spooler' });
    expect(similar).toEqual([]);
  });

  it('defence in depth: another org’s private row is dropped even if RLS let it through (Review Focus 4)', () => {
    expect(classifyMemoryRows([row({ orgId: 'org-b', partnerId: null })], ctx, 5)).toEqual({ proven: [], similar: [] });
    expect(classifyMemoryRows([row({ partnerId: 'p-2' })], ctx, 5)).toEqual({ proven: [], similar: [] });
  });

  it('script edited after proof: an old version is neither proven nor similar (Review Focus 5)', () => {
    expect(classifyMemoryRows([row({ scriptVersionNumber: 2 })], ctx, 5)).toEqual({ proven: [], similar: [] });
    const script = row().script!;
    expect(classifyMemoryRows([row({ script: { ...script, deletedAt: new Date() } })], ctx, 5).proven).toEqual([]);
    expect(classifyMemoryRows([row({ script: { ...script, osTypes: ['linux'] } })], ctx, 5).proven).toEqual([]);
    expect(classifyMemoryRows([row({ script: null })], ctx, 5).proven).toEqual([]);
  });

  it('a proven PARTNER entry whose script was re-scoped to org A is never offered to org B (Review Focus 5, system-scope attach)', () => {
    const rescoped = row({ script: { ...row().script!, orgId: 'org-a', partnerId: 'p-1' } });
    expect(classifyMemoryRows([rescoped], { ...ctx, orgId: 'org-b' }, 5)).toEqual({ proven: [], similar: [] });
    // Nor is the partner-wide track record presented to org A as "all clients" once the script is private to A.
    expect(classifyMemoryRows([rescoped], ctx, 5)).toEqual({ proven: [], similar: [] });
  });

  it('an org entry whose script moved org A → org B is hidden from both orgs', () => {
    const moved = row({ orgId: 'org-a', partnerId: null, fixKind: 'org_script', script: { ...row().script!, orgId: 'org-b', partnerId: 'p-1' } });
    expect(classifyMemoryRows([moved], ctx, 5)).toEqual({ proven: [], similar: [] });
    expect(classifyMemoryRows([moved], { ...ctx, orgId: 'org-b' }, 5)).toEqual({ proven: [], similar: [] });
  });

  it('system scripts stay shareable across the partner’s orgs', () => {
    const system = row({ fixKind: 'system_script', script: { ...row().script!, isSystem: true, partnerId: null } });
    expect(classifyMemoryRows([system], { ...ctx, orgId: 'org-z' }, 5).proven).toHaveLength(1);
  });

  it('demoted, stale or under-proven exact matches fall back to similar', () => {
    for (const over of [{ status: 'demoted' as const }, { staleSince: new Date() }, { verifiedCount: 2 }]) {
      const out = classifyMemoryRows([row(over)], ctx, 5);
      expect(out.proven).toEqual([]);
      expect(out.similar).toHaveLength(1);
    }
  });

  it('a broad signature never yields a proven fix', () => {
    const out = classifyMemoryRows([row({ signatureKey: B })], { ...ctx, signatureKey: B, broad: true }, 5);
    expect(out.proven).toEqual([]);
    expect(out.similar).toHaveLength(1);
  });

  it('org-private rows are labelled "this client"', () => {
    const own = row({ orgId: 'org-a', partnerId: null, fixKind: 'org_script', script: { ...row().script!, orgId: 'org-a' } });
    expect(classifyMemoryRows([own], ctx, 5).proven[0]!.scope).toBe('this_client');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/fixMemory/lookup.test.ts`
Expected: FAIL. `Failed to resolve import "./lookup"`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/fixMemory/lookup.ts
/**
 * Fix-memory lookup (AI Suggested Fixes W1). Runs on the AMBIENT db, so under
 * a request/tool context RLS bounds it; the explicit owner filter below also
 * holds under system context (memory attach). A row is only ever returned if
 * it is still dispatchable on this OS at its pinned script version.
 */
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import type { FixKind, FixMemoryStatus } from '@breeze/shared';
import { db } from '../../db';
import { fixMemory, scripts, scriptVersions } from '../../db/schema';
import { isProven } from './aggregate';
import type { FixSignature } from './signature';

export interface FixTrackRecord {
  memoryId: string;
  scope: 'all_clients' | 'this_client';
  fixKind: FixKind;
  scriptId: string | null;
  scriptVersionId: string | null;
  scriptName: string | null;
  builtinAction: string | null;
  playbookId: string | null;
  attempts: number;
  verified: number;
  failed: number;
  recurred: number;
  upVotes: number;
  downVotes: number;
  successRate: number;
  lastVerifiedAt: string | null;
  status: FixMemoryStatus;
}

export interface FixLookupResult {
  signature: { version: number; broad: boolean; family: string; condition: string; osFamily: string; discriminatorKind: string | null };
  proven: FixTrackRecord[];
  similar: FixTrackRecord[];
}

export interface MemoryCandidateRow {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  signatureKey: string;
  broadKey: string;
  osType: string;
  fixKind: FixKind;
  scriptId: string | null;
  scriptVersionId: string | null;
  builtinAction: string | null;
  playbookId: string | null;
  attempts: number;
  verifiedCount: number;
  failedCount: number;
  recurredCount: number;
  upVotes: number;
  downVotes: number;
  rollingSuccessRate: number;
  recentOutcomes: string[];
  status: FixMemoryStatus;
  staleSince: Date | null;
  lastVerifiedAt: Date | null;
  script: { name: string; deletedAt: Date | null; osTypes: string[]; headVersion: number; isSystem: boolean; orgId: string | null; partnerId: string | null } | null;
  scriptVersionNumber: number | null;
}

const SCRIPT_KINDS = new Set<FixKind>(['system_script', 'partner_script', 'org_script']);

/**
 * The script's CURRENT owner must match the row's owner AND be visible to the
 * target org — checked here, independently of ambient RLS, because memory
 * attach runs under system scope. routes/scripts.ts can re-scope a script
 * (partner→org, org A→org B) without cutting a version (:921-928, :997-1038),
 * and owner drift is only folded on the next sweep.
 */
function scriptOwnerVisible(row: MemoryCandidateRow, s: NonNullable<MemoryCandidateRow['script']>, ctx: { orgId: string; partnerId: string }): boolean {
  if (row.orgId === null) return s.isSystem || (s.orgId === null && s.partnerId === ctx.partnerId);
  return !s.isSystem && s.orgId === row.orgId && s.orgId === ctx.orgId;
}

function isDispatchable(row: MemoryCandidateRow, ctx: { orgId: string; partnerId: string; osFamily: string }): boolean {
  if (!SCRIPT_KINDS.has(row.fixKind)) return true;
  const s = row.script;
  return Boolean(
    s && s.deletedAt === null && s.osTypes.includes(ctx.osFamily)
    && row.scriptVersionNumber !== null && row.scriptVersionNumber === s.headVersion
    && scriptOwnerVisible(row, s, ctx),
  );
}

function track(row: MemoryCandidateRow): FixTrackRecord {
  return {
    memoryId: row.id,
    scope: row.orgId === null ? 'all_clients' : 'this_client',
    fixKind: row.fixKind, scriptId: row.scriptId, scriptVersionId: row.scriptVersionId,
    scriptName: row.script?.name ?? null, builtinAction: row.builtinAction, playbookId: row.playbookId,
    attempts: row.attempts, verified: row.verifiedCount, failed: row.failedCount, recurred: row.recurredCount,
    upVotes: row.upVotes, downVotes: row.downVotes,
    successRate: Math.round(row.rollingSuccessRate * 100) / 100,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    status: row.status,
  };
}

const byStrength = (a: FixTrackRecord, b: FixTrackRecord) => b.successRate - a.successRate || b.verified - a.verified;

export function classifyMemoryRows(
  rows: readonly MemoryCandidateRow[],
  ctx: { orgId: string; partnerId: string; signatureKey: string; broadKey: string; broad: boolean; osFamily: string },
  limit: number,
): { proven: FixTrackRecord[]; similar: FixTrackRecord[] } {
  const proven: FixTrackRecord[] = [];
  const similar: FixTrackRecord[] = [];
  for (const row of rows) {
    const visible = row.orgId !== null ? row.orgId === ctx.orgId : row.partnerId === ctx.partnerId;
    if (!visible || row.osType !== ctx.osFamily || row.status === 'retired') continue;
    if (!isDispatchable(row, ctx)) continue;
    const exact = row.signatureKey === ctx.signatureKey;
    const provenNow = exact && !ctx.broad && isProven({
      status: row.status, stale: row.staleSince !== null, verifiedCount: row.verifiedCount,
      rollingSuccessRate: row.rollingSuccessRate, recentOutcomes: row.recentOutcomes,
    });
    if (provenNow) proven.push(track(row));
    else if (row.broadKey === ctx.broadKey) similar.push(track(row));
  }
  return { proven: proven.sort(byStrength).slice(0, limit), similar: similar.sort(byStrength).slice(0, limit) };
}

export async function lookupFixes(input: { orgId: string; partnerId: string; signature: FixSignature; limit: number }): Promise<FixLookupResult> {
  const sig = input.signature;
  const rows = await db
    .select({
      id: fixMemory.id, orgId: fixMemory.orgId, partnerId: fixMemory.partnerId,
      signatureKey: fixMemory.signatureKey, broadKey: fixMemory.broadKey, osType: fixMemory.osType, fixKind: fixMemory.fixKind,
      scriptId: fixMemory.scriptId, scriptVersionId: fixMemory.scriptVersionId, builtinAction: fixMemory.builtinAction,
      playbookId: fixMemory.playbookId, attempts: fixMemory.attempts, verifiedCount: fixMemory.verifiedCount,
      failedCount: fixMemory.failedCount, recurredCount: fixMemory.recurredCount, upVotes: fixMemory.upVotes,
      downVotes: fixMemory.downVotes, rollingSuccessRate: fixMemory.rollingSuccessRate, recentOutcomes: fixMemory.recentOutcomes,
      status: fixMemory.status, staleSince: fixMemory.staleSince, lastVerifiedAt: fixMemory.lastVerifiedAt,
      scriptName: scripts.name, scriptDeletedAt: scripts.deletedAt, scriptOsTypes: scripts.osTypes, scriptHeadVersion: scripts.version,
      scriptIsSystem: scripts.isSystem, scriptOrgId: scripts.orgId, scriptPartnerId: scripts.partnerId,
      scriptVersionNumber: scriptVersions.version,
    })
    .from(fixMemory)
    .leftJoin(scripts, eq(scripts.id, fixMemory.scriptId))
    .leftJoin(scriptVersions, eq(scriptVersions.id, fixMemory.scriptVersionId))
    .where(and(
      eq(fixMemory.signatureVersion, sig.version),
      eq(fixMemory.osType, sig.facets.osFamily),
      or(eq(fixMemory.signatureKey, sig.key), eq(fixMemory.broadKey, sig.broadKey)),
      or(eq(fixMemory.orgId, input.orgId), and(isNull(fixMemory.orgId), eq(fixMemory.partnerId, input.partnerId))),
      ne(fixMemory.status, 'retired'),
    ))
    .limit(100);
  const candidates: MemoryCandidateRow[] = rows.map((r) => ({
    id: r.id, orgId: r.orgId, partnerId: r.partnerId, signatureKey: r.signatureKey, broadKey: r.broadKey,
    osType: r.osType, fixKind: r.fixKind, scriptId: r.scriptId, scriptVersionId: r.scriptVersionId,
    builtinAction: r.builtinAction, playbookId: r.playbookId, attempts: r.attempts, verifiedCount: r.verifiedCount,
    failedCount: r.failedCount, recurredCount: r.recurredCount, upVotes: r.upVotes, downVotes: r.downVotes,
    rollingSuccessRate: r.rollingSuccessRate, recentOutcomes: r.recentOutcomes, status: r.status,
    staleSince: r.staleSince, lastVerifiedAt: r.lastVerifiedAt,
    script: r.scriptName === null
      ? null
      : {
        name: r.scriptName, deletedAt: r.scriptDeletedAt, osTypes: r.scriptOsTypes ?? [], headVersion: r.scriptHeadVersion ?? -1,
        isSystem: r.scriptIsSystem ?? false, orgId: r.scriptOrgId ?? null, partnerId: r.scriptPartnerId ?? null,
      },
    scriptVersionNumber: r.scriptVersionNumber ?? null,
  }));
  const { proven, similar } = classifyMemoryRows(candidates, {
    orgId: input.orgId, partnerId: input.partnerId, signatureKey: sig.key, broadKey: sig.broadKey,
    broad: sig.broad, osFamily: sig.facets.osFamily,
  }, input.limit);
  return {
    signature: {
      version: sig.version, broad: sig.broad, family: sig.facets.family, condition: sig.facets.condition,
      osFamily: sig.facets.osFamily, discriminatorKind: sig.facets.discriminator?.kind ?? null,
    },
    proven,
    similar,
  };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/api && npx vitest run src/services/fixMemory/lookup.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/fixMemory/lookup.ts apps/api/src/services/fixMemory/lookup.test.ts
git commit -m "feat(api): fix-memory lookup with version-pinned proven and similar fixes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 17: Free memory attach on new alerts and on Generate (unit)

Attach runs under system scope, so it relies on `lookupFixes` to check each script's CURRENT owner against the target org (Task 16). A fix proven partner-wide whose script has since been re-scoped to another org is therefore never attached.

Memory attach runs in two places:
- on `alert.triggered` for every alert, including alerts promoted from anomalies;
- at the start of Generate, for every source type, including a bare anomaly episode.

Anomaly episodes publish no creation event (`metricAnomalyEpisodes.ts:395`), so an un-promoted episode gets its memory hit when the panel's Generate runs. That is still free: no LLM call.

**Files:**
- Create: `apps/api/src/services/fixMemory/attach.ts`
- Test: `apps/api/src/services/fixMemory/attach.test.ts`
- Modify: `apps/api/src/services/eventSubscriberIds.ts` and `apps/api/src/services/eventSubscribers.ts` (`fix-memory-attach` id and block)
- Modify: `apps/api/src/services/remediationSuggestions.ts` (`generateRemediationSuggestions`, after the flag check ~L339)
- Modify test: `apps/api/src/services/remediationSuggestions.test.ts` (mock `./fixMemory/attach`)

**Interfaces:**
- Consumes:
  - `shouldProduceMlOutput` (`services/mlFeatureFlags.ts:239`);
  - `sourceRefFor`, `signatureForSource` (Task 11);
  - `resolveOrgPartnerId` (Task 15);
  - `lookupFixes` (Task 16);
  - `inSystemDbContext` (Task 8).
- Produces:
  ```ts
  export async function attachProvenFixes(input: { sourceType: 'alert' | 'anomaly' | 'correlation' | 'rca'; sourceId: string; orgId: string }): Promise<number>;
  export function memoryRationale(fix: Pick<FixTrackRecord, 'verified' | 'attempts' | 'scope'>): string;
  export async function handleAlertTriggeredForFixMemory(event: BreezeEvent): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/fixMemory/attach.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  flag: vi.fn(async () => true), sig: vi.fn(), partner: vi.fn(async () => 'p-1'), lookup: vi.fn(),
  values: vi.fn(), onConflict: vi.fn(async () => undefined),
}));
vi.mock('../../db', () => ({
  db: { insert: vi.fn(() => ({ values: (v: unknown) => { h.values(v); return { onConflictDoUpdate: h.onConflict }; } })) },
}));
vi.mock('../mlFeatureFlags', () => ({ shouldProduceMlOutput: h.flag }));
vi.mock('./signatureLoader', () => ({
  sourceRefFor: (r: { sourceType: string; sourceId: string }) => (r.sourceType === 'rca' ? null : { kind: r.sourceType, alertId: r.sourceId }),
  signatureForSource: h.sig,
}));
vi.mock('./catalog', () => ({ resolveOrgPartnerId: h.partner }));
vi.mock('./lookup', () => ({ lookupFixes: h.lookup }));
vi.mock('../outcomeProbes', () => ({ inSystemDbContext: (fn: () => unknown) => fn() }));

import { attachProvenFixes, handleAlertTriggeredForFixMemory, memoryRationale } from './attach';

const proven = { memoryId: 'm-1', scope: 'all_clients', fixKind: 'partner_script', scriptId: 's-1', scriptName: 'Restart spooler', attempts: 8, verified: 7, successRate: 0.88, lastVerifiedAt: '2026-11-01T00:00:00.000Z' };
const signature = { version: 1, key: 'k', broadKey: 'b', broad: false, facets: { osFamily: 'windows' } };

describe('attachProvenFixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.sig.mockResolvedValue({ signature, deviceId: 'd-1', alertId: 'a-1', anomalyEpisodeId: null });
    h.lookup.mockResolvedValue({ proven: [proven], similar: [] });
  });

  it('writes a memory-origin suggestion for each proven script fix and upgrades an untouched catalog row', async () => {
    await expect(attachProvenFixes({ sourceType: 'alert', sourceId: 'a-1', orgId: 'org-1' })).resolves.toBe(1);
    expect(h.values).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'memory', targetType: 'script', scriptId: 's-1', deviceId: 'd-1', targetDeviceIds: ['d-1'],
      alertId: 'a-1', status: 'suggested', confidence: null,
      evidence: expect.objectContaining({ origin: 'memory', memoryId: 'm-1', attempts: 8, verifiedCount: 7 }),
    }));
    expect(h.onConflict).toHaveBeenCalledWith(expect.objectContaining({ set: expect.objectContaining({ origin: 'memory' }) }));
  });

  it('does nothing when the flag is off, the signature is broad, or the source has none', async () => {
    h.flag.mockResolvedValueOnce(false);
    expect(await attachProvenFixes({ sourceType: 'alert', sourceId: 'a-1', orgId: 'org-1' })).toBe(0);
    h.sig.mockResolvedValueOnce({ signature: { ...signature, broad: true }, deviceId: 'd-1', alertId: 'a-1', anomalyEpisodeId: null });
    expect(await attachProvenFixes({ sourceType: 'alert', sourceId: 'a-1', orgId: 'org-1' })).toBe(0);
    expect(await attachProvenFixes({ sourceType: 'rca', sourceId: 'x', orgId: 'org-1' })).toBe(0);
    expect(h.values).not.toHaveBeenCalled();
  });

  it('never writes private text into the rationale', () => {
    expect(memoryRationale({ verified: 7, attempts: 8, scope: 'all_clients' })).toBe('Proven fix: worked 7 of 8 times across your clients.');
    expect(memoryRationale({ verified: 3, attempts: 3, scope: 'this_client' })).toBe('Proven fix: worked 3 of 3 times for this client.');
  });

  it('the subscriber attaches for the event org and drops malformed payloads', async () => {
    await handleAlertTriggeredForFixMemory({ id: 'e', type: 'alert.triggered', orgId: 'org-1', source: 's', priority: 'normal', payload: { alertId: 'a-1' }, metadata: { timestamp: '' } } as never);
    expect(h.lookup).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1', partnerId: 'p-1', limit: 3 }));
    vi.clearAllMocks();
    await handleAlertTriggeredForFixMemory({ id: 'e', type: 'alert.triggered', orgId: 'org-1', source: 's', priority: 'normal', payload: {}, metadata: { timestamp: '' } } as never);
    expect(h.lookup).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/fixMemory/attach.test.ts`
Expected: FAIL. `Failed to resolve import "./attach"`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/fixMemory/attach.ts
/**
 * Free fix-memory attach (AI Suggested Fixes W1, spec P3): a PROVEN hit for a
 * new problem becomes a remediation_suggestions row with origin 'memory'. No
 * LLM, no cost. Broad signatures never auto-attach. W1 attaches script fixes
 * only (the only execution rail /execute has today). An existing untouched
 * ('suggested') keyword-matcher row for the same script is upgraded in place.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { remediationSuggestions } from '../../db/schema';
import type { BreezeEvent } from '../eventBus';
import { shouldProduceMlOutput } from '../mlFeatureFlags';
import { inSystemDbContext } from '../outcomeProbes';
import { resolveOrgPartnerId } from './catalog';
import { lookupFixes, type FixTrackRecord } from './lookup';
import { signatureForSource, sourceRefFor } from './signatureLoader';

const ATTACH_LIMIT = 3;

export function memoryRationale(fix: Pick<FixTrackRecord, 'verified' | 'attempts' | 'scope'>): string {
  const where = fix.scope === 'all_clients' ? 'across your clients' : 'for this client';
  return `Proven fix: worked ${fix.verified} of ${fix.attempts} times ${where}.`;
}

export async function attachProvenFixes(input: {
  sourceType: 'alert' | 'anomaly' | 'correlation' | 'rca';
  sourceId: string;
  orgId: string;
}): Promise<number> {
  if (!(await shouldProduceMlOutput(input.orgId, 'ml.remediation_suggestions.enabled'))) return 0;
  const ref = sourceRefFor({ sourceType: input.sourceType, sourceId: input.sourceId });
  if (!ref) return 0;
  const resolved = await signatureForSource(ref);
  if (!resolved || resolved.signature.broad) return 0;
  const partnerId = await resolveOrgPartnerId(input.orgId);
  if (!partnerId) return 0;

  const { proven } = await lookupFixes({ orgId: input.orgId, partnerId, signature: resolved.signature, limit: ATTACH_LIMIT });
  let attached = 0;
  for (const fix of proven) {
    if (!fix.scriptId || !fix.scriptName) continue;
    const rationale = memoryRationale(fix);
    const evidence = {
      origin: 'memory', memoryId: fix.memoryId, scope: fix.scope, attempts: fix.attempts, verifiedCount: fix.verified,
      successRate: fix.successRate, lastVerifiedAt: fix.lastVerifiedAt, signatureVersion: resolved.signature.version,
    };
    const now = new Date();
    await db.insert(remediationSuggestions).values({
      orgId: input.orgId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      deviceId: resolved.deviceId,
      alertId: input.sourceType === 'alert' ? input.sourceId : null,
      anomalyId: input.sourceType === 'anomaly' ? input.sourceId : null,
      correlationGroupId: input.sourceType === 'correlation' ? input.sourceId : null,
      targetType: 'script',
      scriptId: fix.scriptId,
      title: fix.scriptName.slice(0, 255),
      rationale,
      expectedAction: `Run script "${fix.scriptName}" through the existing script execution flow.`,
      riskTier: 'medium',
      status: 'suggested',
      confidence: null,
      evidence,
      parameters: {},
      targetDeviceIds: [resolved.deviceId],
      origin: 'memory',
    }).onConflictDoUpdate({
      target: [remediationSuggestions.orgId, remediationSuggestions.sourceType, remediationSuggestions.sourceId, remediationSuggestions.scriptId],
      targetWhere: sql`target_type = 'script'`,
      set: { origin: 'memory', evidence, rationale, updatedAt: now },
      setWhere: sql`${remediationSuggestions.status} = 'suggested'`,
    });
    attached += 1;
  }
  return attached;
}

/** Durable subscriber 'fix-memory-attach' on alert.triggered. */
export async function handleAlertTriggeredForFixMemory(event: BreezeEvent): Promise<void> {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const alertId = typeof payload.alertId === 'string' ? payload.alertId : null;
  if (!alertId || !event.orgId) return;
  await inSystemDbContext(
    () => attachProvenFixes({ sourceType: 'alert', sourceId: alertId, orgId: event.orgId }),
    'fixMemory.attach',
  );
}
```

- [ ] **Step 4: Wire the subscriber and Generate**

In `apps/api/src/services/eventSubscriberIds.ts`, directly after `'dns-threat-alerts',` (before `'fix-outcome-watcher'`):

```ts
  // AI Suggested Fixes W1 — attach proven fix memory to a newly triggered alert.
  'fix-memory-attach',
```

In `apps/api/src/services/eventSubscribers.ts`, insert directly before the `fix-outcome-watcher` block from Task 14:

```ts
  registerEventSubscriber({
    id: 'fix-memory-attach',
    // AI Suggested Fixes W1 — a proven fix for this alert's signature is
    // attached for free (no LLM). Idempotent: ON CONFLICT on the per-source
    // script unique index. Lazy for the worker-closure reason above.
    eventTypes: ['alert.triggered'],
    handler: async (event: BreezeEvent) => {
      const { handleAlertTriggeredForFixMemory } = await import('./fixMemory/attach');
      return handleAlertTriggeredForFixMemory(event);
    },
    retry: { attempts: 3, backoffMs: 30_000 },
  });
```

In `apps/api/src/services/remediationSuggestions.ts`:
- Add imports:
  ```ts
  import { attachProvenFixes } from './fixMemory/attach';
  ```
  Also add `inArray` to the drizzle import if it is absent.
- In `generateRemediationSuggestions`, immediately after the `shouldProduceMlOutput(...)` early return, insert:

```ts
  // AI Suggested Fixes W1 — proven memory first; free, and the catalog loop
  // below then reuses (never duplicates) a script memory already attached.
  const memoryAttached = await attachProvenFixes({ sourceType: input.sourceType, sourceId: input.sourceId, orgId: ctx.orgId });
```

- At the end of the function, where the result object is built, replace `suggestions` with the memory rows first:

```ts
  const memoryRows = memoryAttached > 0
    ? await db.select().from(remediationSuggestions).where(and(
      eq(remediationSuggestions.orgId, ctx.orgId),
      eq(remediationSuggestions.sourceType, input.sourceType),
      eq(remediationSuggestions.sourceId, input.sourceId),
      eq(remediationSuggestions.origin, 'memory'),
    ))
    : [];
  const memoryIds = new Set(memoryRows.map((r) => r.id));
  const merged = [...memoryRows, ...suggestions.filter((s) => !memoryIds.has(s.id))];
```

  Return `suggestions: merged` in place of `suggestions`.

In `apps/api/src/services/remediationSuggestions.test.ts`, add near the other mocks:

```ts
vi.mock('./fixMemory/attach', () => ({ attachProvenFixes: vi.fn(async () => 0) }));
```

- [ ] **Step 5: Run it and watch it pass**

Run: `cd apps/api && npx vitest run src/services/fixMemory/attach.test.ts src/services/remediationSuggestions.test.ts src/services/eventSubscribers.contract.test.ts src/services/eventSubscriberRegistry.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/fixMemory/attach.ts apps/api/src/services/fixMemory/attach.test.ts apps/api/src/services/eventSubscriberIds.ts apps/api/src/services/eventSubscribers.ts apps/api/src/services/remediationSuggestions.ts apps/api/src/services/remediationSuggestions.test.ts
git commit -m "feat(api): attach proven fix memory to new alerts and to Generate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 18: `/execute` records the attempt and returns it (unit)

**Files:**
- Create: `apps/api/src/services/fixMemory/outcomeRecorder.ts` (extended in Task 19)
- Test: `apps/api/src/services/fixMemory/outcomeRecorder.test.ts` (extended in Task 19)
- Modify: `apps/api/src/routes/remediationSuggestions.ts`
  - `serializeSuggestion` ~L247: add `origin` and `outcome`;
  - every `.map(serializeSuggestion)` call site;
  - `/:id/execute`, after `writeRouteAudit(...)` ~L957 and in its `return c.json(...)` ~L960.
- Modify test: `apps/api/src/routes/remediationSuggestions.test.ts` (hoisted mocks, `vi.mock('../services/fixMemory/outcomeRecorder')`, and assertions in the execute cases at ~L558 and ~L621)

**Why the response must carry the outcome.** The panel replaces its row with the `/execute` response (`RemediationSuggestionsPanel.tsx:270-271`). If that response said `outcome: null`, the 👍/👎 controls (Task 22) would not appear until a reload. The `fix_outcomes` row is created in this handler, so the handler returns it.

**Interfaces:**
- Consumes: `fixKindForScript`, `fixIdentityFor` (Task 7); `withDbTransaction` (`db/index.ts:972`); `FIX_OUTCOME_WINDOWS`.
- Produces:
  ```ts
  export interface OutcomeSummary { state: FixOutcomeState; stateReason: string | null; humanVote: FixVote | null }
  export async function recordExecutionOutcome(input: {
    suggestion: Pick<typeof remediationSuggestions.$inferSelect, 'id' | 'orgId' | 'sourceType' | 'sourceId' | 'alertId' | 'scriptId'>;
    deviceId: string;
    scriptExecutionId: string;
  }): Promise<OutcomeSummary | null>; // never throws
  ```
  - `serializeSuggestion(row, outcome: OutcomeSummary | null = null)` adds `origin` and `outcome`.
  - `/execute` responds `{ data: { ...suggestion, outcome }, execution }`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/fixMemory/outcomeRecorder.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as unknown[][],
  values: vi.fn(),
  insertResult: [] as unknown[],
  insertThrows: false,
}));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  // select/update chains share one thenable: every awaited chain yields the next queued `rows` entry.
  for (const m of ['select', 'from', 'where', 'limit', 'update', 'set', 'returning']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(h.rows.shift() ?? []).then(r);
  (chain as { insert: unknown }).insert = vi.fn(() => ({
    values: (v: unknown) => {
      h.values(v);
      return { onConflictDoNothing: () => ({ returning: async () => { if (h.insertThrows) throw new Error('23503'); return h.insertResult; } }) };
    },
  }));
  return { db: chain, withDbTransaction: (fn: () => unknown) => fn() };
});

import { recordExecutionOutcome } from './outcomeRecorder';

// ONE top-level reset of ALL shared mock state. Every describe in this file
// (including the ones Task 19 appends) starts clean — no test may inherit
// insertThrows / insertResult / queued rows from another.
beforeEach(() => {
  h.rows.length = 0;
  h.values.mockReset();
  h.insertResult = [{ state: 'pending', stateReason: null, humanVote: null }];
  h.insertThrows = false;
});

const suggestion = { id: 'sg-1', orgId: 'org-1', sourceType: 'alert', sourceId: 'a-1', alertId: 'a-1', scriptId: 's-1' };

describe('recordExecutionOutcome', () => {
  it('records a pending attempt pinned to the dispatched script version and returns its summary', async () => {
    h.rows.push([{ partnerId: 'p-1' }], [{ isSystem: false, orgId: null, partnerId: 'p-1' }], [{ scriptVersionId: 'v-7' }]);
    await expect(recordExecutionOutcome({ suggestion, deviceId: 'd-1', scriptExecutionId: 'e-1' }))
      .resolves.toEqual({ state: 'pending', stateReason: null, humanVote: null });
    expect(h.values).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1', partnerId: 'p-1', deviceId: 'd-1', suggestionId: 'sg-1', sourceType: 'alert', sourceId: 'a-1',
      alertId: 'a-1', fixKind: 'partner_script', fixIdentity: 'script_version:v-7', scriptVersionId: 'v-7',
      scriptExecutionId: 'e-1', state: 'pending',
    }));
    const deadline = (h.values.mock.calls[0]![0] as { deadlineAt: Date }).deadlineAt.getTime();
    expect(deadline - Date.now()).toBeGreaterThan(23 * 3_600_000);
  });

  it('never throws: a failed insert returns null and leaves the dispatched script alone', async () => {
    h.rows.push([{ partnerId: 'p-1' }], [{ isSystem: true, orgId: null, partnerId: null }], [{ scriptVersionId: null }]);
    h.insertThrows = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordExecutionOutcome({ suggestion, deviceId: 'd-1', scriptExecutionId: 'e-1' })).resolves.toBeNull();
    err.mockRestore();
  });
});
```

In `apps/api/src/routes/remediationSuggestions.test.ts`:
- Add this entry to the `vi.hoisted` `dbMocks` object:
  ```ts
  recordOutcomeMock: vi.fn(async () => ({ state: 'pending', stateReason: null, humanVote: null })),
  ```
- Add the mock:

```ts
vi.mock('../services/fixMemory/outcomeRecorder', () => ({
  recordExecutionOutcome: dbMocks.recordOutcomeMock,
}));
```

At the end of `it('executes accepted script suggestions through the server-side script rail', ...)`, add:

```ts
    expect(dbMocks.recordOutcomeMock).toHaveBeenCalledWith({
      suggestion: expect.objectContaining({ id: baseSuggestion.id, orgId: baseSuggestion.orgId }),
      deviceId: baseSuggestion.deviceId,
      scriptExecutionId,
    });
    // The panel swaps its row for this response, so the outcome must be on it.
    expect(body.data.outcome).toEqual({ state: 'pending', stateReason: null, humanVote: null });
```

At the end of `it('returns 422 for rejected admission without mutating or auditing the suggestion', ...)`, add:

```ts
    expect(dbMocks.recordOutcomeMock).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/fixMemory/outcomeRecorder.test.ts src/routes/remediationSuggestions.test.ts`
Expected: FAIL.
- The recorder suite cannot resolve `./outcomeRecorder`.
- In the route suite, `recordOutcomeMock` is called 0 times and `body.data.outcome` is `undefined`.

- [ ] **Step 3: Implement the recorder**

```ts
// apps/api/src/services/fixMemory/outcomeRecorder.ts
/**
 * Request-path writers for fix_outcomes (AI Suggested Fixes W1). Run under the
 * caller's request RLS context (fix_outcomes is shape 1, the org's own rows).
 * Recording an attempt sits in its own SAVEPOINT (withDbTransaction) and never
 * throws: it must never undo or block a dispatched script.
 */
import { eq, sql } from 'drizzle-orm';
import { FIX_OUTCOME_WINDOWS, type FixOutcomeState, type FixVote } from '@breeze/shared';
import { db, withDbTransaction } from '../../db';
import { fixOutcomes, organizations, remediationSuggestions, scriptExecutions, scripts } from '../../db/schema';
import { fixIdentityFor, fixKindForScript } from './aggregate';

type SourceType = 'alert' | 'anomaly' | 'correlation' | 'rca';
const HOUR_MS = 3_600_000;

export interface OutcomeSummary { state: FixOutcomeState; stateReason: string | null; humanVote: FixVote | null }

const summaryColumns = { state: fixOutcomes.state, stateReason: fixOutcomes.stateReason, humanVote: fixOutcomes.humanVote };

function toSummary(row: { state: FixOutcomeState; stateReason: string | null; humanVote: FixVote | null } | undefined): OutcomeSummary | null {
  return row ? { state: row.state, stateReason: row.stateReason ?? null, humanVote: row.humanVote ?? null } : null;
}

export async function recordExecutionOutcome(input: {
  suggestion: Pick<typeof remediationSuggestions.$inferSelect, 'id' | 'orgId' | 'sourceType' | 'sourceId' | 'alertId' | 'scriptId'>;
  deviceId: string;
  scriptExecutionId: string;
}): Promise<OutcomeSummary | null> {
  const { suggestion } = input;
  if (!suggestion.scriptId) return null;
  try {
    return await withDbTransaction(async () => {
      const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations)
        .where(eq(organizations.id, suggestion.orgId)).limit(1);
      const [script] = await db.select({ isSystem: scripts.isSystem, orgId: scripts.orgId, partnerId: scripts.partnerId })
        .from(scripts).where(eq(scripts.id, suggestion.scriptId!)).limit(1);
      if (!org || !script) return null;
      const [execution] = await db.select({ scriptVersionId: scriptExecutions.scriptVersionId }).from(scriptExecutions)
        .where(eq(scriptExecutions.id, input.scriptExecutionId)).limit(1);
      const scriptVersionId = execution?.scriptVersionId ?? null;
      const fixKind = fixKindForScript(script);
      const now = new Date();
      const [row] = await db.insert(fixOutcomes).values({
        orgId: suggestion.orgId,
        partnerId: org.partnerId,
        deviceId: input.deviceId,
        suggestionId: suggestion.id,
        sourceType: suggestion.sourceType as SourceType,
        sourceId: suggestion.sourceId,
        alertId: suggestion.alertId,
        fixKind,
        fixIdentity: fixIdentityFor({ fixKind, scriptVersionId }),
        scriptId: suggestion.scriptId,
        scriptVersionId,
        scriptExecutionId: input.scriptExecutionId,
        state: 'pending',
        deadlineAt: new Date(now.getTime() + FIX_OUTCOME_WINDOWS.pendingTimeoutHours * HOUR_MS),
      }).onConflictDoNothing({ target: fixOutcomes.suggestionId, where: sql`suggestion_id IS NOT NULL` })
        .returning(summaryColumns);
      return toSummary(row);
    });
  } catch (err) {
    console.error(`[fixMemory] could not record the attempt for suggestion ${suggestion.id}:`, err);
    return null;
  }
}
```

- [ ] **Step 4: Serialize `origin` + `outcome` and return the outcome from `/execute`**

In `apps/api/src/routes/remediationSuggestions.ts`:

1. Add `import { recordExecutionOutcome, type OutcomeSummary } from '../services/fixMemory/outcomeRecorder';`.
2. Change `serializeSuggestion` to take the outcome. Every existing field is unchanged; append the two new keys after `executedAt`:
   ```ts
   function serializeSuggestion(row: typeof remediationSuggestions.$inferSelect, outcome: OutcomeSummary | null = null) {
     return {
       // ...every existing field unchanged...
       executedAt: row.executedAt?.toISOString() ?? null,
       origin: row.origin,
       outcome,
     };
   }
   ```
3. Find every bare `.map(serializeSuggestion)` with `grep -n "map(serializeSuggestion)" apps/api/src/routes/remediationSuggestions.ts` and replace each with `.map((row) => serializeSuggestion(row))`, so `Array.prototype.map`'s index is never passed as `outcome`.
4. In the `/:id/execute` handler, directly after the `writeRouteAudit(c, { ... });` call, insert:
   ```ts
    // AI Suggested Fixes W1 — the attempt the outcome watcher follows. Own
    // savepoint, never throws: a recording failure must not undo a dispatch.
    const outcome = await recordExecutionOutcome({ suggestion: updated, deviceId, scriptExecutionId });
   ```
   Then change its return to:
   ```ts
    return c.json({
      data: serializeSuggestion(updated, outcome),
      execution: execution.admission,
    }, 201);
   ```

- [ ] **Step 5: Run them and watch them pass**

Run: `cd apps/api && npx vitest run src/services/fixMemory/outcomeRecorder.test.ts src/routes/remediationSuggestions.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS. Any pre-existing case that `toEqual`s a whole serialized suggestion now also sees `origin` and `outcome`. Fix it by adding `origin: 'catalog_match'` to that case's fixture row and `outcome: null` to its expectation, and nothing else.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/fixMemory/outcomeRecorder.ts apps/api/src/services/fixMemory/outcomeRecorder.test.ts apps/api/src/routes/remediationSuggestions.ts apps/api/src/routes/remediationSuggestions.test.ts
git commit -m "feat(api): record a fix attempt on execute and return it with the suggestion

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 19: 👍/👎 and Done endpoints, plus `outcome` on listed suggestions (unit)

**Files:**
- Modify: `apps/api/src/services/fixMemory/outcomeRecorder.ts` (+ test)
- Modify: `apps/api/src/routes/remediationSuggestions.ts`:
  - schemas near L46;
  - `GET /` ~L417-444;
  - new routes after `/:id/execute`.
- Modify test: `apps/api/src/routes/remediationSuggestions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function recordOutcomeVote(input: { suggestionId: string; orgId: string; vote: FixVote; userId: string }): Promise<OutcomeSummary | null>;
  export async function createManualStepsOutcome(input: { suggestion: Pick<typeof remediationSuggestions.$inferSelect, 'id' | 'orgId' | 'sourceType' | 'sourceId' | 'alertId'>; deviceId: string }): Promise<OutcomeSummary | null>; // null = already recorded
  export async function loadOutcomeSummaries(suggestionIds: readonly string[]): Promise<Map<string, OutcomeSummary>>;
  ```
- New routes:
  - `POST /remediation-suggestions/:id/vote` with body `{ vote: 'up' | 'down' }`. Returns 200 `{ data: { outcome } }`; 409 when no attempt was recorded; 404/403 as in `/execute`. Permission `SCRIPTS_EXECUTE`.
  - `POST /remediation-suggestions/:id/done`. Returns 201 `{ data: { outcome } }`; 400 unless `targetType === 'manual_steps'` and status is `accepted`/`edited` with exactly one target device; 409 if already recorded. Permission `SCRIPTS_EXECUTE`.
  - `GET /` hydrates `outcome` on each row.
- **Scope note (W1):** Done records and watches a manual-steps attempt, which can then be voted on, but it **never feeds `fix_memory`** in W1. Its `fix_identity` is NULL because no reviewed generic-instructions library exists yet, and AI-written prose must never reach memory. W1 also has no producer of `manual_steps` rows; W2's research finalizer adds one.

- [ ] **Step 1: Write the failing tests**

Append to `outcomeRecorder.test.ts`. The file-level `beforeEach` from Task 18 already resets all shared mock state, so these tests add no `beforeEach` of their own.

```ts
import { createManualStepsOutcome, loadOutcomeSummaries, recordOutcomeVote } from './outcomeRecorder';

describe('votes and Done', () => {
  it('a vote requests a recount and replaces any earlier vote', async () => {
    h.rows.push([{ state: 'verified', stateReason: 'held_with_fresh_telemetry', humanVote: 'down' }]);
    await expect(recordOutcomeVote({ suggestionId: 'sg-1', orgId: 'org-1', vote: 'down', userId: 'u-1' }))
      .resolves.toEqual({ state: 'verified', stateReason: 'held_with_fresh_telemetry', humanVote: 'down' });
  });

  it('a vote on a suggestion with no recorded attempt returns null', async () => {
    h.rows.push([]);
    await expect(recordOutcomeVote({ suggestionId: 'sg-x', orgId: 'org-1', vote: 'up', userId: 'u-1' })).resolves.toBeNull();
  });

  it('Done starts a manual-steps attempt in awaiting_recovery with no aggregatable identity', async () => {
    h.rows.push([{ partnerId: 'p-1' }]);
    h.insertResult = [{ state: 'awaiting_recovery', stateReason: 'manual_steps_done', humanVote: null }];
    await expect(createManualStepsOutcome({ suggestion: { id: 'sg-2', orgId: 'org-1', sourceType: 'alert', sourceId: 'a-1', alertId: 'a-1' }, deviceId: 'd-1' }))
      .resolves.toEqual({ state: 'awaiting_recovery', stateReason: 'manual_steps_done', humanVote: null });
    expect(h.values).toHaveBeenCalledWith(expect.objectContaining({
      fixKind: 'manual_steps', fixIdentity: null, state: 'awaiting_recovery', stateReason: 'manual_steps_done',
    }));
  });

  it('a second Done is reported as already recorded (null), not a new attempt', async () => {
    h.rows.push([{ partnerId: 'p-1' }]);
    h.insertResult = [];
    await expect(createManualStepsOutcome({ suggestion: { id: 'sg-2', orgId: 'org-1', sourceType: 'alert', sourceId: 'a-1', alertId: 'a-1' }, deviceId: 'd-1' }))
      .resolves.toBeNull();
  });

  it('summaries are keyed by suggestion id', async () => {
    h.rows.push([{ suggestionId: 'sg-1', state: 'holding', stateReason: 'condition_cleared', humanVote: null }]);
    const map = await loadOutcomeSummaries(['sg-1', 'sg-2']);
    expect(map.get('sg-1')).toEqual({ state: 'holding', stateReason: 'condition_cleared', humanVote: null });
    expect(map.has('sg-2')).toBe(false);
  });
});
```

In the route test, extend `dbMocks` with:
- `recordVoteMock: vi.fn()`
- `createDoneMock: vi.fn()`
- `loadSummariesMock: vi.fn(async () => new Map())`

and extend the recorder mock:

```ts
vi.mock('../services/fixMemory/outcomeRecorder', () => ({
  recordExecutionOutcome: dbMocks.recordOutcomeMock,
  recordOutcomeVote: dbMocks.recordVoteMock,
  createManualStepsOutcome: dbMocks.createDoneMock,
  loadOutcomeSummaries: dbMocks.loadSummariesMock,
}));
```

Add these cases inside `describe('remediation suggestion routes', ...)`:

```ts
  const json = (body: unknown) => ({ method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('records a 👎 on an executed suggestion and audits it', async () => {
    mockSuggestionLoad({ ...baseSuggestion, status: 'executed', scriptExecutionId: '66666666-6666-4666-8666-666666666666' });
    dbMocks.recordVoteMock.mockResolvedValueOnce({ state: 'verified', stateReason: 'held_with_fresh_telemetry', humanVote: 'down' });
    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/vote`, json({ vote: 'down' }));
    expect(res.status).toBe(200);
    expect(dbMocks.recordVoteMock).toHaveBeenCalledWith({ suggestionId: baseSuggestion.id, orgId: baseSuggestion.orgId, vote: 'down', userId: 'user-1' });
    expect((await res.json()).data.outcome.humanVote).toBe('down');
    expect(dbMocks.writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'ml.remediation_suggestion.vote' }));
  });

  it('409 when no attempt was recorded for the suggestion', async () => {
    mockSuggestionLoad({ ...baseSuggestion, status: 'accepted' });
    dbMocks.recordVoteMock.mockResolvedValueOnce(null);
    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/vote`, json({ vote: 'up' }));
    expect(res.status).toBe(409);
  });

  it('400 on an invalid vote and 404 on an invisible suggestion', async () => {
    expect((await app.request(`/remediation-suggestions/${baseSuggestion.id}/vote`, json({ vote: 'meh' }))).status).toBe(400);
    mockSelectOnce([]);
    expect((await app.request(`/remediation-suggestions/${baseSuggestion.id}/vote`, json({ vote: 'up' }))).status).toBe(404);
    expect(dbMocks.recordVoteMock).not.toHaveBeenCalled();
  });

  it('403 for a site-restricted user outside the device site', async () => {
    currentPermissions = { allowedSiteIds: ['88888888-8888-4888-8888-888888888888'] };
    mockSuggestionLoad({ ...baseSuggestion, status: 'executed' });
    mockDeviceLoad();
    const res = await app.request(`/remediation-suggestions/${baseSuggestion.id}/vote`, json({ vote: 'up' }));
    expect(res.status).toBe(403);
    expect(dbMocks.recordVoteMock).not.toHaveBeenCalled();
  });

  it('Done records manual steps once and rejects non-manual targets', async () => {
    const manual = { ...baseSuggestion, targetType: 'manual_steps', scriptId: null, status: 'accepted' };
    mockSuggestionLoad(manual);
    dbMocks.createDoneMock.mockResolvedValueOnce({ state: 'awaiting_recovery', stateReason: 'manual_steps_done', humanVote: null });
    expect((await app.request(`/remediation-suggestions/${baseSuggestion.id}/done`, json({}))).status).toBe(201);

    mockSuggestionLoad(manual);
    dbMocks.createDoneMock.mockResolvedValueOnce(null);
    expect((await app.request(`/remediation-suggestions/${baseSuggestion.id}/done`, json({}))).status).toBe(409);

    mockSuggestionLoad({ ...baseSuggestion, status: 'accepted' });
    expect((await app.request(`/remediation-suggestions/${baseSuggestion.id}/done`, json({}))).status).toBe(400);
  });

  it('lists suggestions with origin and their outcome', async () => {
    mockSelectOnce([{ ...baseSuggestion, origin: 'memory' }]);
    dbMocks.loadSummariesMock.mockResolvedValueOnce(new Map([[baseSuggestion.id, { state: 'holding', stateReason: 'condition_cleared', humanVote: null }]]));
    const res = await app.request('/remediation-suggestions?sourceType=alert&sourceId=a-1', { headers: { Authorization: 'Bearer token' } });
    const body = await res.json();
    expect(body.data[0]).toMatchObject({ origin: 'memory', outcome: { state: 'holding' } });
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/fixMemory/outcomeRecorder.test.ts src/routes/remediationSuggestions.test.ts`
Expected: FAIL.
- The recorder exports are missing.
- The vote and done routes return 404 (they do not exist).
- The list body's `outcome` is `null`.

- [ ] **Step 3: Implement the recorder functions**

Append to `outcomeRecorder.ts`, and add `and`, `inArray` to its `drizzle-orm` import:

```ts
/**
 * A re-vote replaces the earlier one (spec). recount_requested_at asks the
 * sweeper to recompute; if a recount of this row is in flight, this UPDATE
 * waits on its row lock (store.recomputeForOutcome) and re-requests after it.
 */
export async function recordOutcomeVote(input: { suggestionId: string; orgId: string; vote: FixVote; userId: string }): Promise<OutcomeSummary | null> {
  const now = new Date();
  const [row] = await db.update(fixOutcomes).set({
    humanVote: input.vote, votedBy: input.userId, votedAt: now, recountRequestedAt: now, updatedAt: now,
  }).where(and(eq(fixOutcomes.suggestionId, input.suggestionId), eq(fixOutcomes.orgId, input.orgId)))
    .returning(summaryColumns);
  return toSummary(row);
}

/**
 * Done on manual steps: the attempt starts at awaiting_recovery (spec). W1 has
 * no reviewed-instructions library, so fix_identity is NULL: the attempt is
 * watched and votable but never aggregated into shareable memory.
 */
export async function createManualStepsOutcome(input: {
  suggestion: Pick<typeof remediationSuggestions.$inferSelect, 'id' | 'orgId' | 'sourceType' | 'sourceId' | 'alertId'>;
  deviceId: string;
}): Promise<OutcomeSummary | null> {
  const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations)
    .where(eq(organizations.id, input.suggestion.orgId)).limit(1);
  if (!org) return null;
  const now = new Date();
  const [row] = await db.insert(fixOutcomes).values({
    orgId: input.suggestion.orgId,
    partnerId: org.partnerId,
    deviceId: input.deviceId,
    suggestionId: input.suggestion.id,
    sourceType: input.suggestion.sourceType as SourceType,
    sourceId: input.suggestion.sourceId,
    alertId: input.suggestion.alertId,
    fixKind: 'manual_steps',
    fixIdentity: null,
    state: 'awaiting_recovery',
    stateReason: 'manual_steps_done',
    deadlineAt: new Date(now.getTime() + FIX_OUTCOME_WINDOWS.recoveryTimeoutHours * HOUR_MS),
  }).onConflictDoNothing({ target: fixOutcomes.suggestionId, where: sql`suggestion_id IS NOT NULL` })
    .returning(summaryColumns);
  return toSummary(row);
}

export async function loadOutcomeSummaries(suggestionIds: readonly string[]): Promise<Map<string, OutcomeSummary>> {
  const map = new Map<string, OutcomeSummary>();
  if (suggestionIds.length === 0) return map;
  const rows = await db.select({ suggestionId: fixOutcomes.suggestionId, ...summaryColumns }).from(fixOutcomes)
    .where(inArray(fixOutcomes.suggestionId, [...suggestionIds]));
  for (const r of rows) {
    const summary = toSummary(r);
    if (r.suggestionId && summary) map.set(r.suggestionId, summary);
  }
  return map;
}
```

- [ ] **Step 4: Implement the routes**

In `apps/api/src/routes/remediationSuggestions.ts`:

1. Extend the recorder import to `import { createManualStepsOutcome, loadOutcomeSummaries, recordExecutionOutcome, recordOutcomeVote, type OutcomeSummary } from '../services/fixMemory/outcomeRecorder';`.
2. Add a schema after `updateBodySchema`:
   ```ts
   const voteBodySchema = z.object({ vote: z.enum(['up', 'down']) });
   ```
3. In `GET /`, replace `return c.json({ data: visible.map((row) => serializeSuggestion(row)) });` (the Task 18 form) with:
   ```ts
    const outcomes = await loadOutcomeSummaries(visible.map((row) => row.id));
    return c.json({ data: visible.map((row) => serializeSuggestion(row, outcomes.get(row.id) ?? null)) });
   ```
4. After the `/:id/execute` registration, add:

```ts
remediationSuggestionRoutes.post(
  '/:id/vote',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_EXECUTE.resource, PERMISSIONS.SCRIPTS_EXECUTE.action),
  zValidator('json', voteBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const id = c.req.param('id') ?? '';
    const { vote } = c.req.valid('json');
    const conditions: SQL[] = [eq(remediationSuggestions.id, id)];
    const orgCond = auth.orgCondition(remediationSuggestions.orgId);
    if (orgCond) conditions.push(orgCond);
    const [existing] = await db.select().from(remediationSuggestions).where(and(...conditions)).limit(1);
    if (!existing) return c.json({ error: 'Suggestion not found' }, 404);
    if (!(await siteAllowedForSuggestion(existing, perms))) {
      return c.json({ error: 'Suggestion not found or access denied' }, 403);
    }
    const outcome = await recordOutcomeVote({ suggestionId: existing.id, orgId: existing.orgId, vote, userId: auth.user.id });
    if (!outcome) return c.json({ error: 'No recorded fix attempt for this suggestion' }, 409);
    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'ml.remediation_suggestion.vote',
      resourceType: 'remediation_suggestion',
      resourceId: existing.id,
      resourceName: existing.title,
      details: { vote, outcomeState: outcome.state },
    });
    return c.json({ data: { outcome } });
  }
);

remediationSuggestionRoutes.post(
  '/:id/done',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_EXECUTE.resource, PERMISSIONS.SCRIPTS_EXECUTE.action),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const id = c.req.param('id') ?? '';
    const conditions: SQL[] = [eq(remediationSuggestions.id, id)];
    const orgCond = auth.orgCondition(remediationSuggestions.orgId);
    if (orgCond) conditions.push(orgCond);
    const [existing] = await db.select().from(remediationSuggestions).where(and(...conditions)).limit(1);
    if (!existing) return c.json({ error: 'Suggestion not found' }, 404);
    if (!(await siteAllowedForSuggestion(existing, perms))) {
      return c.json({ error: 'Suggestion not found or access denied' }, 403);
    }
    if (existing.targetType !== 'manual_steps') {
      return c.json({ error: 'Only manual-step suggestions can be marked done' }, 400);
    }
    if (existing.status !== 'accepted' && existing.status !== 'edited') {
      return c.json({ error: 'Suggestion must be accepted or edited before it can be marked done' }, 400);
    }
    const deviceId = singleTargetDeviceId(existing);
    if (!deviceId) return c.json({ error: 'Marking manual steps done requires exactly one target device' }, 400);
    const outcome = await createManualStepsOutcome({ suggestion: existing, deviceId });
    if (!outcome) return c.json({ error: 'This suggestion was already marked done' }, 409);
    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'ml.remediation_suggestion.done',
      resourceType: 'remediation_suggestion',
      resourceId: existing.id,
      resourceName: existing.title,
      details: { sourceType: existing.sourceType, sourceId: existing.sourceId },
    });
    return c.json({ data: { outcome } }, 201);
  }
);
```

- [ ] **Step 5: Run the suites**

Run: `cd apps/api && npx vitest run src/routes/remediationSuggestions.test.ts src/services/fixMemory/outcomeRecorder.test.ts src/services/aiGuardrails.routeParity.contract.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/fixMemory/outcomeRecorder.ts apps/api/src/services/fixMemory/outcomeRecorder.test.ts apps/api/src/routes/remediationSuggestions.ts apps/api/src/routes/remediationSuggestions.test.ts
git commit -m "feat(api): vote and Done endpoints for suggested fixes; list their outcomes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 20: `find_proven_fixes` tier-1 tool, fully registered (unit + contracts)

**Input scope (decision D-c):** the tool accepts `alertId | anomalyEpisodeId` only. The spec's `deviceId + problem` form is **deferred to W2 by spec amendment**. A free-text "problem" has no structured facets from which a signature can be computed, and signatures never use free text. The input schema below must not grow a `deviceId`/`problem` field in W1.

**Files:**
- Create: `apps/api/src/services/aiToolsFixMemory.ts`
- Test: `apps/api/src/services/aiToolsFixMemory.test.ts`
- Modify:
  - `apps/api/src/services/aiTools.ts` (import after L72; register after `registerRemediationTools(aiTools);` L314)
  - `apps/api/src/services/aiToolSchemas.ts` (after the `list_remediation_suggestions` entry ~L450)
  - `apps/api/src/services/aiAgentSdkTools.ts` (`TOOL_TIERS` after `list_remediation_suggestions: 1,` L311; `tool()` after the `list_remediation_suggestions` declaration ~L2746)
  - `apps/api/src/services/aiGuardrails.ts` (`TOOL_PERMISSIONS` after `list_remediation_suggestions` ~L912)
  - `apps/api/src/services/aiAgents/agentToolCatalog.ts` (`TOOL_CAPABILITY` after `list_remediation_suggestions` L100)
  - `apps/api/src/services/mcpCoverage.ts` (L483)
  - `apps/api/src/services/aiGuardrails.routeBinding.contract.test.ts` (row after `list_remediation_suggestions` ~L240)
  - `apps/api/src/services/aiGuardrails.agentPrincipal.contract.test.ts` (between `'export_dataset',` and `'get_active_users',` ~L183)
  - `apps/web/src/components/ai-risk/tierConfig.ts` (after the `list_remediation_suggestions` entry ~L90)
  - `apps/docs/src/content/docs/features/mcp-server.mdx` (alert-tools table after L244)
  - `apps/docs/src/content/docs/features/ai.mdx` (Tier 1 examples row, L35)

**Interfaces:**
- Consumes:
  - `findAlertWithAccess` (`aiToolsAlerts.ts:74`);
  - `deviceIdSiteDenied` (`aiToolsSiteScope.ts:232`);
  - `shouldProduceMlOutput`;
  - `signatureForSource`, `resolveOrgPartnerId`, `lookupFixes`.
- Produces:
  ```ts
  export const findProvenFixesInputSchema: z.ZodObject<{ alertId?: string; anomalyEpisodeId?: string; limit?: number }>;
  export function registerFixMemoryTools(tools: Map<string, AiTool>): void;
  ```
  Output is `FixLookupResult` JSON (Task 16), `{ disabled: true, proven: [], similar: [] }`, or `{ error }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiToolsFixMemory.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findAlert: vi.fn(), flag: vi.fn(async () => true), sig: vi.fn(), partner: vi.fn(async () => 'p-1'), lookup: vi.fn(),
  episodeRows: [] as unknown[],
}));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where']) chain[m] = vi.fn(() => chain);
  (chain as { limit: unknown }).limit = vi.fn(async () => h.episodeRows);
  return { db: chain };
});
vi.mock('./aiToolsAlerts', () => ({ findAlertWithAccess: h.findAlert }));
vi.mock('./aiToolsSiteScope', () => ({ deviceIdSiteDenied: vi.fn(async () => false) }));
vi.mock('./mlFeatureFlags', () => ({ shouldProduceMlOutput: h.flag }));
vi.mock('./fixMemory/signatureLoader', () => ({ signatureForSource: h.sig }));
vi.mock('./fixMemory/catalog', () => ({ resolveOrgPartnerId: h.partner }));
vi.mock('./fixMemory/lookup', () => ({ lookupFixes: h.lookup }));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerFixMemoryTools } from './aiToolsFixMemory';

const tools = new Map<string, AiTool>();
registerFixMemoryTools(tools);
const auth = { scope: 'organization', orgId: 'org-1', canAccessOrg: () => true, orgCondition: () => undefined } as unknown as AuthContext;
const run = async (input: Record<string, unknown>) => JSON.parse(await tools.get('find_proven_fixes')!.handler(input, auth));
const ALERT = '11111111-1111-4111-8111-111111111111';
const EPISODE = '22222222-2222-4222-8222-222222222222';

describe('find_proven_fixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findAlert.mockResolvedValue({ id: ALERT, orgId: 'org-1', deviceId: 'd-1', title: 'host-17 spooler down' });
    h.sig.mockResolvedValue({ signature: { version: 1 }, deviceId: 'd-1', alertId: ALERT, anomalyEpisodeId: null });
    h.lookup.mockResolvedValue({ signature: { version: 1, broad: false, family: 'alert', condition: 'rule:service_stopped', osFamily: 'windows', discriminatorKind: 'service' }, proven: [{ memoryId: 'm', scope: 'all_clients' }], similar: [] });
  });

  it('is registered as a tier-1 monitoring read', () => {
    const t = tools.get('find_proven_fixes')!;
    expect(t.tier).toBe(1);
    expect(t.domain).toBe('monitoring');
  });

  it('requires exactly one source', async () => {
    expect((await run({})).error).toMatch(/exactly one/);
    expect((await run({ alertId: ALERT, anomalyEpisodeId: EPISODE })).error).toMatch(/exactly one/);
  });

  it('looks memory up for the ALERT’s org and partner, never echoing alert text (Review Focus 4)', async () => {
    const out = await run({ alertId: ALERT });
    expect(h.lookup).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1', partnerId: 'p-1', limit: 5 }));
    expect(JSON.stringify(out)).not.toContain('host-17');
    expect(out.proven).toHaveLength(1);
  });

  it('denies an alert the caller cannot see (cross-org)', async () => {
    h.findAlert.mockResolvedValueOnce(null);
    expect((await run({ alertId: ALERT })).error).toBe('Alert not found or access denied');
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it('reports disabled when the org has suggestions off', async () => {
    h.flag.mockResolvedValueOnce(false);
    expect(await run({ alertId: ALERT })).toEqual({ disabled: true, proven: [], similar: [] });
  });

  it('resolves an anomaly episode through the caller org condition', async () => {
    h.episodeRows = [{ id: EPISODE, orgId: 'org-1', deviceId: 'd-1' }];
    await run({ anomalyEpisodeId: EPISODE });
    expect(h.sig).toHaveBeenCalledWith({ kind: 'anomaly', anomalyEpisodeId: EPISODE });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/aiToolsFixMemory.test.ts`
Expected: FAIL. `Failed to resolve import "./aiToolsFixMemory"`.

- [ ] **Step 3: Implement the handler**

```ts
// apps/api/src/services/aiToolsFixMemory.ts
/**
 * find_proven_fixes (AI Suggested Fixes W1): tier-1 read of fix memory for
 * chat, AI agents, Helper and MCP. Runs under the caller's RLS context (the
 * tool dispatcher's withDbAccessContext); lookupFixes additionally filters by
 * the SOURCE's org and that org's partner, so it never returns another org's
 * private rows. Output carries counts, ids and statuses only.
 */
import { and, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { metricAnomalyEpisodes } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { sanitizeThrownToolError } from './aiToolErrors';
import { findAlertWithAccess } from './aiToolsAlerts';
import { deviceIdSiteDenied } from './aiToolsSiteScope';
import { resolveOrgPartnerId } from './fixMemory/catalog';
import { lookupFixes } from './fixMemory/lookup';
import { signatureForSource, type FixSourceRef } from './fixMemory/signatureLoader';
import { shouldProduceMlOutput } from './mlFeatureFlags';

export const findProvenFixesInputSchema = z.object({
  alertId: z.string().guid().optional(),
  anomalyEpisodeId: z.string().guid().optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

async function findEpisodeWithAccess(episodeId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(metricAnomalyEpisodes.id, episodeId)];
  const orgCond = auth.orgCondition(metricAnomalyEpisodes.orgId);
  if (orgCond) conditions.push(orgCond);
  const [episode] = await db
    .select({ id: metricAnomalyEpisodes.id, orgId: metricAnomalyEpisodes.orgId, deviceId: metricAnomalyEpisodes.deviceId })
    .from(metricAnomalyEpisodes).where(and(...conditions)).limit(1);
  if (!episode) return null;
  if (auth.allowedDeviceIds && !auth.allowedDeviceIds.includes(episode.deviceId)) return null;
  if (await deviceIdSiteDenied(auth, episode.deviceId)) return null;
  return episode;
}

export function registerFixMemoryTools(tools: Map<string, AiTool>): void {
  tools.set('find_proven_fixes', {
    tier: 1,
    domain: 'monitoring',
    searchHint: 'fixes proven on this same alert or anomaly across your clients, with track records',
    definition: {
      name: 'find_proven_fixes',
      description: 'Find fixes proven by observed outcomes on this same problem (an alert or anomaly episode) across your clients, with their track records. Returns proven fixes and similar ones; never another client\'s private details.',
      input_schema: {
        type: 'object',
        properties: {
          alertId: { type: 'string', description: 'Alert UUID (give this or anomalyEpisodeId)' },
          anomalyEpisodeId: { type: 'string', description: 'Metric anomaly episode UUID (give this or alertId)' },
          limit: { type: 'number', description: 'Maximum fixes per group (default 5, max 20)' },
        },
        required: [],
      },
    },
    handler: async (input, auth) => {
      const parsed = findProvenFixesInputSchema.safeParse(input);
      if (!parsed.success) return JSON.stringify({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
      const { alertId, anomalyEpisodeId, limit = 5 } = parsed.data;
      if (Boolean(alertId) === Boolean(anomalyEpisodeId)) {
        return JSON.stringify({ error: 'Provide exactly one of alertId or anomalyEpisodeId' });
      }
      try {
        let orgId: string;
        let ref: FixSourceRef;
        if (alertId) {
          const alert = await findAlertWithAccess(alertId, auth);
          if (!alert) return JSON.stringify({ error: 'Alert not found or access denied' });
          orgId = alert.orgId;
          ref = { kind: 'alert', alertId: alert.id };
        } else {
          const episode = await findEpisodeWithAccess(anomalyEpisodeId!, auth);
          if (!episode) return JSON.stringify({ error: 'Anomaly episode not found or access denied' });
          orgId = episode.orgId;
          ref = { kind: 'anomaly', anomalyEpisodeId: episode.id };
        }
        if (!(await shouldProduceMlOutput(orgId, 'ml.remediation_suggestions.enabled'))) {
          return JSON.stringify({ disabled: true, proven: [], similar: [] });
        }
        const resolved = await signatureForSource(ref);
        if (!resolved) {
          return JSON.stringify({ signature: null, proven: [], similar: [], note: 'No structured signature for this problem; memory lookup skipped.' });
        }
        const partnerId = await resolveOrgPartnerId(orgId);
        if (!partnerId) return JSON.stringify({ error: 'Organization not found' });
        return JSON.stringify(await lookupFixes({ orgId, partnerId, signature: resolved.signature, limit }));
      } catch (error) {
        return JSON.stringify({ error: sanitizeThrownToolError('find_proven_fixes', error) });
      }
    },
  });
}
```

- [ ] **Step 4: Register it on every surface**

`aiTools.ts`:
- after L72 add `import { registerFixMemoryTools } from './aiToolsFixMemory';`
- after `registerRemediationTools(aiTools);` add `registerFixMemoryTools(aiTools);`

`aiToolSchemas.ts`, after the `list_remediation_suggestions` entry:

```ts
  find_proven_fixes: z.object({
    alertId: z.string().guid().optional(),
    anomalyEpisodeId: z.string().guid().optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
```

`aiAgentSdkTools.ts`:
- in `TOOL_TIERS`, after `list_remediation_suggestions: 1,`, add `  find_proven_fixes: 1,`
- after the `list_remediation_suggestions` `tool(...)` declaration, add:

```ts
    tool(
      'find_proven_fixes',
      registryDescription('find_proven_fixes'),
      {
        alertId: z.string().guid().optional(),
        anomalyEpisodeId: z.string().guid().optional(),
        limit: z.number().int().min(1).max(20).optional(),
      },
      makeHandler('find_proven_fixes', getAuth, onPreToolUse, onPostToolUse)
    ),
```

`aiGuardrails.ts`, in `TOOL_PERMISSIONS`, after `list_remediation_suggestions`:

```ts
  // GET remediationSuggestions.ts /: PERMISSIONS.DEVICES_READ — proven fixes are
  // the same class of read as the suggestions list they feed.
  find_proven_fixes: { resource: 'devices', action: 'read' },
```

`aiAgents/agentToolCatalog.ts`, in `TOOL_CAPABILITY`, after `list_remediation_suggestions`:

```ts
  find_proven_fixes: 'alerts_monitoring',
```

`mcpCoverage.ts`:

```ts
  'remediationSuggestions.ts': { tools: ['list_remediation_suggestions', 'find_proven_fixes'] },
```

`aiGuardrails.routeBinding.contract.test.ts`, after the `list_remediation_suggestions` row:

```ts
  {
    tool: 'find_proven_fixes', routeFile: 'remediationSuggestions.ts', method: 'get', path: '/',
    toolOnly: { extra: [], reason: 'Source alert/episode is resolved through the caller org condition, exact-device scope and site scope before any memory read; memory output is counts only.' },
  },
```

`aiGuardrails.agentPrincipal.contract.test.ts`, between `'export_dataset',` and `'get_active_users',`:

```ts
  'find_proven_fixes', // AI Suggested Fixes W1 Tier-1 read
```

`apps/web/src/components/ai-risk/tierConfig.ts`, after the `list_remediation_suggestions` entry:

```ts
      { name: 'find_proven_fixes', description: 'Find fixes proven on the same problem', category: 'Alerts & Notifications' },
```

`apps/docs/src/content/docs/features/mcp-server.mdx`, directly after the `list_remediation_suggestions` row:

```
| `find_proven_fixes` | 1 | Find fixes proven by observed outcomes on the same alert or anomaly episode across your clients, with track records (counts only — never another client's details). |
```

`apps/docs/src/content/docs/features/ai.mdx`: in the Tier 1 row of the "Tool tiers" table, insert `` `find_proven_fixes`, `` right after `` `get_vulnerability_report`, ``.

- [ ] **Step 5: Run the tool test and every tool-registry contract**

Run:

```bash
cd apps/api && npx vitest run src/services/aiToolsFixMemory.test.ts \
  src/services/aiAgentSdkTools.registryParity.contract.test.ts src/services/aiAgentSdkTools.handlerCoverage.contract.test.ts \
  src/services/aiAgentSdkTools.mcpCoverage.test.ts src/__tests__/mcp-coverage.test.ts \
  src/services/aiGuardrails.routeBinding.contract.test.ts src/services/aiGuardrails.routeParity.contract.test.ts \
  src/services/aiToolPermissionsCatalogParity.contract.test.ts src/services/aiTools.descriptionBudget.contract.test.ts \
  src/services/aiTools.outputBudget.contract.test.ts src/services/aiTools.domainMetadata.contract.test.ts \
  src/services/aiTools.deviceArgsCoverage.contract.test.ts src/services/aiGuardrails.agentPrincipal.contract.test.ts \
  src/services/aiAgents/agentToolCatalog.contract.test.ts src/services/aiAgents/agentToolCatalog.categoryParity.test.ts \
  src/services/aiAgents/agentToolCatalog.domainRelation.contract.test.ts src/services/mcpToolPresentation.guardrailParity.contract.test.ts \
  src/services/aiGuardrailsAiDocs.parity.test.ts src/services/aiGuardrailsTierConfig.parity.test.ts \
  src/services/aiToolIndex.test.ts src/services/mcpGuidancePromptTools.test.ts
npx tsc --noEmit -p tsconfig.json
```

Expected: PASS on all 21 files.
- If `aiTools.descriptionBudget` rejects a length, shorten the description. The tool description must stay ≤300 chars and each param ≤160.
- If `mcpGuidancePromptTools.test.ts` requires an `ai-tools.mdx` row for new tier-1 tools, add `` | `find_proven_fixes` | 1 | Find fixes proven on the same problem | `` to the table that test names.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/aiToolsFixMemory.ts apps/api/src/services/aiToolsFixMemory.test.ts apps/api/src/services/aiTools.ts apps/api/src/services/aiToolSchemas.ts apps/api/src/services/aiAgentSdkTools.ts apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiAgents/agentToolCatalog.ts apps/api/src/services/mcpCoverage.ts apps/api/src/services/aiGuardrails.routeBinding.contract.test.ts apps/api/src/services/aiGuardrails.agentPrincipal.contract.test.ts apps/web/src/components/ai-risk/tierConfig.ts apps/docs/src/content/docs/features/mcp-server.mdx apps/docs/src/content/docs/features/ai.mdx
git commit -m "feat(api): find_proven_fixes tier-1 tool for chat, agents, Helper and MCP

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 21: Erasure hook — stale before the cascade, rebuild after (unit)

Merge needs no extra hook. `orgMerge` enqueues a tenant erasure of the loser (`jobs/orgMerge.ts:164`), so the loser's `leave-for-erasure` outcomes are removed here and the partner aggregate is rebuilt without them. That is the documented "no double-count, no restamp" behaviour. The erasure sequence is extracted as an exported `eraseOrgWithFixMemory` so Task 23's real-Postgres merge case can run the exact code the worker runs.

**Files:**
- Modify: `apps/api/src/jobs/tenantErasure.ts` (inside the `try { const stats = await cascadeDeleteOrg(...)` block ~L189)
- Modify test: `apps/api/src/jobs/tenantErasure.test.ts`

**Interfaces:**
- Consumes: `markFixMemoryStaleForOrgErasure`, `rebuildFixMemory` (Task 12); `cascadeDeleteOrg`.
- Produces:
  ```ts
  export async function eraseOrgWithFixMemory(
    orgId: string, performedBy: string, performedByEmail?: string,
    hooks?: { rebuild?: typeof rebuildFixMemory }, // test seam only: Task 23 injects a failing post-cascade rebuild
  ): Promise<Awaited<ReturnType<typeof cascadeDeleteOrg>>>;
  ```
- Durability: the rebuild request is persisted by `markFixMemoryStaleForOrgErasure` (`fix_memory.rebuild_pending_org_ids`) BEFORE the cascade. So the post-cascade rebuild is an optimisation, not the only trigger. If it fails, or the process dies between cascade and rebuild, the sweeper still rebuilds the partner (Task 12 "Erasure request rule", Task 14).

- [ ] **Step 1: Write the failing test**

In `tenantErasure.test.ts`:
- Add `markStaleMock: vi.fn()` and `rebuildMock: vi.fn()` to the `vi.hoisted` object.
- Add the mock:

```ts
vi.mock('../services/fixMemory/store', () => ({
  markFixMemoryStaleForOrgErasure: (...a: unknown[]) => markStaleMock(...(a as [])),
  rebuildFixMemory: (...a: unknown[]) => rebuildMock(...(a as [])),
}));
```

Add these cases after `'worker processor invokes cascadeDeleteOrg with the job payload'`:

```ts
  it('marks partner fix memory stale BEFORE the cascade and rebuilds it after', async () => {
    markStaleMock.mockResolvedValue('partner-1');
    rebuildMock.mockResolvedValue({ identities: 1 });
    createTenantErasureWorker();
    await capturedWorkerProcessor.current!({ name: 'tenant-erasure', id: 'j', data: { orgId: 'org-xyz', performedBy: 'admin-1' } });
    expect(markStaleMock).toHaveBeenCalledWith('org-xyz');
    expect(markStaleMock.mock.invocationCallOrder[0]!).toBeLessThan(cascadeDeleteOrgMock.mock.invocationCallOrder[0]!);
    expect(rebuildMock).toHaveBeenCalledWith({ partnerId: 'partner-1' });
    expect(rebuildMock.mock.invocationCallOrder[0]!).toBeGreaterThan(cascadeDeleteOrgMock.mock.invocationCallOrder[0]!);
  });

  it('a failed rebuild does not fail the erasure (the request persisted by markStale keeps rows stale; the sweeper retries)', async () => {
    markStaleMock.mockResolvedValue('partner-1');
    rebuildMock.mockRejectedValue(new Error('lock timeout'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    createTenantErasureWorker();
    const result = await capturedWorkerProcessor.current!({ name: 'tenant-erasure', id: 'j', data: { orgId: 'org-xyz', performedBy: 'admin-1' } });
    err.mockRestore();
    expect(result).toMatchObject({ totalRowsDeleted: 2 });
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/jobs/tenantErasure.test.ts`
Expected: FAIL. `markStaleMock` was called 0 times.

- [ ] **Step 3: Implement**

In `apps/api/src/jobs/tenantErasure.ts`, add `import { markFixMemoryStaleForOrgErasure, rebuildFixMemory } from '../services/fixMemory/store';`. Then add this exported function above `createTenantErasureWorker`:

```ts
/**
 * AI Suggested Fixes W1 (spec "Erasure"). Three steps:
 *  1. BEFORE the org's outcomes are deleted, stale-mark the partner fix memory
 *     it contributed to AND persist a durable rebuild request (the org id in
 *     fix_memory.rebuild_pending_org_ids). The rows drop out of "proven" at once.
 *  2. Cascade.
 *  3. Rebuild.
 * A failure to mark aborts before any row is deleted. The request is removed
 * only by a rebuild that saw this org's organizations row already gone before
 * it read contributions, so a sweeper rebuild that races the cascade cannot
 * satisfy it. A failed step-3 rebuild does not fail the erasure: the rows stay
 * stale and requested, and jobs/fixOutcomeWorker.ts retries them every sweep.
 * Exported so the real-Postgres merge and erasure proofs run exactly this.
 * `hooks.rebuild` is a test seam only.
 */
export async function eraseOrgWithFixMemory(
  orgId: string,
  performedBy: string,
  performedByEmail?: string,
  hooks: { rebuild?: typeof rebuildFixMemory } = {},
) {
  const rebuild = hooks.rebuild ?? rebuildFixMemory;
  const fixMemoryPartnerId = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => markFixMemoryStaleForOrgErasure(orgId), 'tenantErasure.fixMemoryStale'));
  const stats = await cascadeDeleteOrg(orgId, performedBy, performedByEmail);
  if (fixMemoryPartnerId) {
    try {
      await runOutsideDbContext(() =>
        withSystemDbAccessContext(() => rebuild({ partnerId: fixMemoryPartnerId }), 'tenantErasure.fixMemoryRebuild'));
    } catch (rebuildErr) {
      console.error(`[TenantErasure] fix-memory rebuild failed for partner of org ${orgId}; the persisted rebuild request keeps it stale and the sweeper will retry`, rebuildErr);
      captureException(rebuildErr);
    }
  }
  return stats;
}
```

In the worker processor, replace

```ts
        const stats = await cascadeDeleteOrg(orgId, performedBy, performedByEmail);
        return { ...stats, jobId: job.id };
```

with

```ts
        const stats = await eraseOrgWithFixMemory(orgId, performedBy, performedByEmail);
        return { ...stats, jobId: job.id };
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/api && npx vitest run src/jobs/tenantErasure.test.ts src/jobs/orgMerge && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/tenantErasure.ts apps/api/src/jobs/tenantErasure.test.ts
git commit -m "feat(api): keep partner fix memory consistent across org erasure and merge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 22: Panel — proven badge, 👍/👎 and Done through `runAction` (web unit)

**Files:**
- Modify: `apps/web/src/components/remediation/RemediationSuggestionsPanel.tsx`
  - types L9-30;
  - handlers after `executeSuggestion` ~L278;
  - JSX after the status line ~L452 and in the action row before the request-approval button ~L535.
- Modify test: `apps/web/src/components/remediation/RemediationSuggestionsPanel.test.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/common.json` (under `longTail.remediation.RemediationSuggestionsPanel`)

**Interfaces:**
- Consumes:
  - `POST /remediation-suggestions/:id/vote` and `POST /remediation-suggestions/:id/done` (Task 19);
  - the `outcome` returned on the `/execute` response (Task 18). The panel already swaps its row for that response (`RemediationSuggestionsPanel.tsx:270-271`), so the 👍/👎 controls appear right after Execute;
  - the `origin`, `evidence` and `outcome` fields on listed suggestions;
  - `runAction` / `handleActionError` (`apps/web/src/lib/runAction.ts:79,197`).

- [ ] **Step 1: Write the failing tests**

Append inside `describe('RemediationSuggestionsPanel', ...)`:

```tsx
  const listUrl = '/remediation-suggestions?sourceType=anomaly&sourceId=anomaly-1&limit=5';
  const serve = (list: unknown[], extra?: (url: string, method: string, init?: RequestInit) => Response | undefined) =>
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(remediationFlags(true)));
      if (url === listUrl) return Promise.resolve(makeJsonResponse({ data: list }));
      const custom = extra?.(url, method, init as RequestInit | undefined);
      if (custom) return Promise.resolve(custom);
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

  it('labels a memory suggestion as a proven fix with its track record', async () => {
    serve([{ ...suggestion, origin: 'memory', confidence: null, evidence: { origin: 'memory', scope: 'all_clients', attempts: 8, verifiedCount: 7 }, outcome: null }]);
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    await screen.findByText('Disk Cleanup');
    expect(screen.getByText('Proven fix')).toBeTruthy();
    expect(screen.getByText(/Worked 7 of 8 times across your clients/)).toBeTruthy();
  });

  it('records 👎 after a run through runAction and shows it pressed', async () => {
    const executed = { ...suggestion, status: 'executed', scriptExecutionId: '33333333-3333-4333-8333-333333333333', outcome: { state: 'holding', stateReason: 'condition_cleared', humanVote: null } };
    serve([executed], (url, method) => (url === '/remediation-suggestions/suggestion-1/vote' && method === 'POST'
      ? makeJsonResponse({ data: { outcome: { state: 'holding', stateReason: 'condition_cleared', humanVote: 'down' } } })
      : undefined));
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    await screen.findByText(/recovered — confirming it stays fixed/);
    fireEvent.click(screen.getByRole('button', { name: /didn.t work/i }));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/remediation-suggestions/suggestion-1/vote',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ vote: 'down' }) }),
    ));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Feedback recorded' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /didn.t work/i }).getAttribute('aria-pressed')).toBe('true'));
  });

  it('surfaces a failed vote (never a silent no-op)', async () => {
    const executed = { ...suggestion, status: 'executed', outcome: { state: 'pending', stateReason: null, humanVote: null } };
    serve([executed], (url) => (url.endsWith('/vote') ? makeJsonResponse({ error: 'No recorded fix attempt for this suggestion' }, false, 409) : undefined));
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^worked$/i }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  });

  it('marks accepted manual steps done', async () => {
    const manual = { ...suggestion, targetType: 'manual_steps', scriptId: null, status: 'accepted', outcome: null };
    serve([manual], (url, method) => (url === '/remediation-suggestions/suggestion-1/done' && method === 'POST'
      ? makeJsonResponse({ data: { outcome: { state: 'awaiting_recovery', stateReason: 'manual_steps_done', humanVote: null } } }, true, 201)
      : undefined));
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^done$/i }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Marked done — watching for recovery' })));
    await screen.findByText(/watching for recovery/);
  });

  it('shows 👍/👎 immediately after Execute, because the response carries the new attempt', async () => {
    const accepted = { ...suggestion, status: 'accepted', outcome: null };
    serve([accepted], (url, method) => (url === '/remediation-suggestions/suggestion-1/execute' && method === 'POST'
      ? makeJsonResponse({
        data: { ...accepted, status: 'executed', scriptExecutionId: '33333333-3333-4333-8333-333333333333', outcome: { state: 'pending', stateReason: null, humanVote: null } },
        execution: { targets: [] },
      }, true, 201)
      : undefined));
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    await screen.findByText('Disk Cleanup');
    expect(screen.queryByRole('button', { name: /didn.t work/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /execute/i }));
    await screen.findByRole('button', { name: /didn.t work/i });
    expect(screen.getByRole('button', { name: /^worked$/i })).toBeTruthy();
    expect(screen.getByText('Outcome: running')).toBeTruthy();
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run src/components/remediation/RemediationSuggestionsPanel.test.tsx`
Expected: FAIL. `Unable to find an element with the text: Proven fix`, and no button named "Didn't work" or "Done" exists.

- [ ] **Step 3: Add the locale keys**

In `apps/web/src/locales/en/common.json`, inside `longTail.remediation.RemediationSuggestionsPanel`, add:

```json
"proven": {
  "badge": "Proven fix",
  "trackAllClients": "Worked {{verified}} of {{attempts}} times across your clients",
  "trackThisClient": "Worked {{verified}} of {{attempts}} times for this client"
},
"feedback": {
  "worked": "Worked",
  "didNotWork": "Didn't work",
  "recorded": "Feedback recorded",
  "failed": "Could not record feedback"
},
"done": {
  "button": "Done",
  "recorded": "Marked done — watching for recovery",
  "failed": "Could not mark done"
},
"outcome": {
  "label": "Outcome: {{state}}",
  "state": {
    "pending": "running",
    "awaitingRecovery": "watching for recovery",
    "holding": "recovered — confirming it stays fixed",
    "verified": "verified fixed",
    "failed": "did not fix it",
    "recurred": "came back",
    "inconclusive": "inconclusive",
    "cancelled": "cancelled"
  }
}
```

Add the same keys, translated, to the other seven locales. The pt-BR strings are machine-drafted pending native review, and the PR body must say so.

| key | de-DE | es-419 | fr-CA / fr-FR | it-IT | pt-BR | tr-TR |
|---|---|---|---|---|---|---|
| proven.badge | Bewährte Lösung | Solución comprobada | Correctif éprouvé | Correzione comprovata | Correção comprovada | Kanıtlanmış çözüm |
| proven.trackAllClients | Hat {{verified}} von {{attempts}} Mal bei Ihren Kunden funktioniert | Funcionó {{verified}} de {{attempts}} veces en sus clientes | A fonctionné {{verified}} fois sur {{attempts}} chez vos clients | Ha funzionato {{verified}} volte su {{attempts}} presso i tuoi clienti | Funcionou {{verified}} de {{attempts}} vezes nos seus clientes | Müşterilerinizde {{attempts}} denemenin {{verified}} tanesinde işe yaradı |
| proven.trackThisClient | Hat {{verified}} von {{attempts}} Mal bei diesem Kunden funktioniert | Funcionó {{verified}} de {{attempts}} veces en este cliente | A fonctionné {{verified}} fois sur {{attempts}} chez ce client | Ha funzionato {{verified}} volte su {{attempts}} presso questo cliente | Funcionou {{verified}} de {{attempts}} vezes neste cliente | Bu müşteride {{attempts}} denemenin {{verified}} tanesinde işe yaradı |
| feedback.worked | Hat funktioniert | Funcionó | A fonctionné | Ha funzionato | Funcionou | İşe yaradı |
| feedback.didNotWork | Hat nicht funktioniert | No funcionó | N'a pas fonctionné | Non ha funzionato | Não funcionou | İşe yaramadı |
| feedback.recorded | Rückmeldung gespeichert | Comentario registrado | Rétroaction enregistrée (fr-CA) / Retour enregistré (fr-FR) | Feedback registrato | Feedback registrado | Geri bildirim kaydedildi |
| feedback.failed | Rückmeldung konnte nicht gespeichert werden | No se pudo registrar el comentario | Impossible d'enregistrer la rétroaction (fr-CA) / Impossible d'enregistrer le retour (fr-FR) | Impossibile registrare il feedback | Não foi possível registrar o feedback | Geri bildirim kaydedilemedi |
| done.button | Erledigt | Hecho | Terminé | Fatto | Concluído | Tamamlandı |
| done.recorded | Als erledigt markiert — Wiederherstellung wird beobachtet | Marcado como hecho — observando la recuperación | Marqué comme terminé — surveillance du rétablissement | Segnato come fatto — in attesa del ripristino | Marcado como concluído — acompanhando a recuperação | Tamamlandı olarak işaretlendi — düzelme izleniyor |
| done.failed | Konnte nicht als erledigt markiert werden | No se pudo marcar como hecho | Impossible de marquer comme terminé | Impossibile segnare come fatto | Não foi possível marcar como concluído | Tamamlandı olarak işaretlenemedi |
| outcome.label | Ergebnis: {{state}} | Resultado: {{state}} | Résultat : {{state}} | Esito: {{state}} | Resultado: {{state}} | Sonuç: {{state}} |
| outcome.state.pending | läuft | en ejecución | en cours | in esecuzione | em execução | çalışıyor |
| outcome.state.awaitingRecovery | Wiederherstellung wird beobachtet | observando la recuperación | surveillance du rétablissement | in attesa del ripristino | acompanhando a recuperação | düzelme izleniyor |
| outcome.state.holding | behoben — Stabilität wird bestätigt | recuperado — confirmando que se mantiene | rétabli — confirmation de la stabilité | ripristinato — verifica della stabilità | recuperado — confirmando que se mantém | düzeldi — kalıcılığı doğrulanıyor |
| outcome.state.verified | Behebung bestätigt | corrección verificada | correction vérifiée | correzione verificata | correção verificada | düzeltme doğrulandı |
| outcome.state.failed | hat das Problem nicht behoben | no lo corrigió | n'a pas corrigé le problème | non ha risolto il problema | não corrigiu o problema | sorunu düzeltmedi |
| outcome.state.recurred | ist zurückgekehrt | volvió a ocurrir | est revenu | si è ripresentato | voltou a ocorrer | tekrarladı |
| outcome.state.inconclusive | nicht eindeutig | no concluyente | non concluant | non conclusivo | inconclusivo | belirsiz |
| outcome.state.cancelled | abgebrochen | cancelado | annulé | annullato | cancelado | iptal edildi |

- [ ] **Step 4: Implement the component changes**

Types (L9-30):
- widen `targetType` to `'script' | 'script_template' | 'playbook' | 'diagnostic' | 'manual_steps'`;
- add the new fields to `RemediationSuggestion`;
- add the outcome type and key map.

```tsx
type OutcomeState = 'pending' | 'awaiting_recovery' | 'holding' | 'verified' | 'failed' | 'recurred' | 'inconclusive' | 'cancelled';
type SuggestionOutcome = { state: OutcomeState; stateReason: string | null; humanVote: 'up' | 'down' | null };
```
Inside `RemediationSuggestion`:
```tsx
  origin?: 'catalog_match' | 'memory' | 'ai_research';
  evidence?: Record<string, unknown>;
  outcome?: SuggestionOutcome | null;
```
Module scope:
```tsx
const OUTCOME_STATE_KEYS: Record<OutcomeState, string> = {
  pending: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.pending',
  awaiting_recovery: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.awaitingRecovery',
  holding: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.holding',
  verified: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.verified',
  failed: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.failed',
  recurred: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.recurred',
  inconclusive: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.inconclusive',
  cancelled: 'longTail.remediation.RemediationSuggestionsPanel.outcome.state.cancelled',
};

function canMarkDone(s: RemediationSuggestion): boolean {
  return s.targetType === 'manual_steps' && (s.status === 'accepted' || s.status === 'edited') && !s.outcome;
}
```
Add `CheckCheck, ShieldCheck, ThumbsDown, ThumbsUp` to the `lucide-react` import.

Inside the component, next to the other `useState` hooks:
```tsx
  const [votingId, setVotingId] = useState<string | null>(null);
  const [markingDoneId, setMarkingDoneId] = useState<string | null>(null);

  function provenTrack(s: RemediationSuggestion): string | null {
    const e = s.evidence ?? {};
    const verified = typeof e.verifiedCount === 'number' ? e.verifiedCount : null;
    const attempts = typeof e.attempts === 'number' ? e.attempts : null;
    if (verified === null || attempts === null) return null;
    return e.scope === 'this_client'
      ? t('longTail.remediation.RemediationSuggestionsPanel.proven.trackThisClient', { verified, attempts })
      : t('longTail.remediation.RemediationSuggestionsPanel.proven.trackAllClients', { verified, attempts });
  }

  function applyOutcome(id: string, outcome: SuggestionOutcome | undefined) {
    if (!outcome) return;
    setSuggestions((current) => current.map((item) => (item.id === id ? { ...item, outcome } : item)));
  }

  async function voteOnSuggestion(suggestion: RemediationSuggestion, vote: 'up' | 'down') {
    setVotingId(suggestion.id);
    try {
      const result = await runAction<{ data?: { outcome?: SuggestionOutcome } }>({
        request: () => fetchWithAuth(`/remediation-suggestions/${suggestion.id}/vote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vote }),
        }),
        errorFallback: t('longTail.remediation.RemediationSuggestionsPanel.feedback.failed'),
        successMessage: t('longTail.remediation.RemediationSuggestionsPanel.feedback.recorded'),
      });
      applyOutcome(suggestion.id, result.data?.outcome);
    } catch (err) {
      handleActionError(err, t('longTail.remediation.RemediationSuggestionsPanel.feedback.failed'));
    } finally {
      setVotingId(null);
    }
  }

  async function markDone(suggestion: RemediationSuggestion) {
    if (!canMarkDone(suggestion)) return;
    setMarkingDoneId(suggestion.id);
    try {
      const result = await runAction<{ data?: { outcome?: SuggestionOutcome } }>({
        request: () => fetchWithAuth(`/remediation-suggestions/${suggestion.id}/done`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
        errorFallback: t('longTail.remediation.RemediationSuggestionsPanel.done.failed'),
        successMessage: t('longTail.remediation.RemediationSuggestionsPanel.done.recorded'),
      });
      applyOutcome(suggestion.id, result.data?.outcome);
    } catch (err) {
      handleActionError(err, t('longTail.remediation.RemediationSuggestionsPanel.done.failed'));
    } finally {
      setMarkingDoneId(null);
    }
  }
```

JSX, directly after the closing `)}` of the `{suggestion.status !== 'suggested' && ( ... statusLine ... )}` block:
```tsx
                      {suggestion.origin === 'memory' && (
                        <p className="mt-2 inline-flex items-center gap-1 rounded bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300" data-testid="remediation-proven-badge">
                          <ShieldCheck className="h-3.5 w-3.5" />
                          {t('longTail.remediation.RemediationSuggestionsPanel.proven.badge')}
                          {provenTrack(suggestion) && <span className="font-normal">· {provenTrack(suggestion)}</span>}
                        </p>
                      )}
                      {suggestion.outcome && (
                        <p className="mt-2 text-xs text-muted-foreground" data-testid="remediation-outcome">
                          {t('longTail.remediation.RemediationSuggestionsPanel.outcome.label', {
                            state: t(/* i18n-dynamic */ OUTCOME_STATE_KEYS[suggestion.outcome.state]),
                          })}
                        </p>
                      )}
```

JSX, in the action button row, directly before `{canQueueScriptSuggestion(suggestion) && requiresExecutionApproval(suggestion) && !suggestion.elevationRequestId && (`:
```tsx
                    {suggestion.outcome && (
                      <>
                        <button
                          type="button"
                          aria-pressed={suggestion.outcome.humanVote === 'up'}
                          disabled={votingId === suggestion.id}
                          onClick={() => void voteOnSuggestion(suggestion, 'up')}
                          className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 aria-pressed:bg-muted"
                          data-testid="remediation-vote-up"
                        >
                          <ThumbsUp className="h-4 w-4" />
                          {t('longTail.remediation.RemediationSuggestionsPanel.feedback.worked')}
                        </button>
                        <button
                          type="button"
                          aria-pressed={suggestion.outcome.humanVote === 'down'}
                          disabled={votingId === suggestion.id}
                          onClick={() => void voteOnSuggestion(suggestion, 'down')}
                          className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 aria-pressed:bg-muted"
                          data-testid="remediation-vote-down"
                        >
                          <ThumbsDown className="h-4 w-4" />
                          {t('longTail.remediation.RemediationSuggestionsPanel.feedback.didNotWork')}
                        </button>
                      </>
                    )}
                    {canMarkDone(suggestion) && (
                      <button
                        type="button"
                        disabled={markingDoneId === suggestion.id}
                        onClick={() => void markDone(suggestion)}
                        className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                        data-testid="remediation-mark-done"
                      >
                        <CheckCheck className="h-4 w-4" />
                        {t('longTail.remediation.RemediationSuggestionsPanel.done.button')}
                      </button>
                    )}
```

- [ ] **Step 5: Run the panel, locale-parity and silent-mutation guards**

Run: `cd apps/web && npx vitest run src/components/remediation/RemediationSuggestionsPanel.test.tsx src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n src/locales && npx tsc --noEmit`
Expected: PASS. The existing 16 panel cases still pass, and the locale parity and translation-coverage suites stay green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/remediation/RemediationSuggestionsPanel.tsx apps/web/src/components/remediation/RemediationSuggestionsPanel.test.tsx apps/web/src/locales
git commit -m "feat(web): proven-fix badge, feedback and Done on suggested fixes

pt-BR strings are machine-drafted pending native review

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 23: Real-Postgres lifecycle proof — exactly-once, locking, freshness, recurrence, re-scope, merge + erasure (integration)

**Files:**
- Create: `apps/api/src/__tests__/integration/fixOutcomeLifecycle.integration.test.ts`

**Interfaces:**
- Consumes:
  - `advanceOutcome`, `handleFixOutcomeEvent` (Task 13);
  - `transitionOutcome`, `fillOutcomeSignature`, `recomputeForOutcome`, `rebuildFixMemory`, `markFixMemoryStaleForOrgErasure`, `markOwnerDriftStale`, `stalePartnerIds` (Task 12);
  - `advanceOutcomesForTerminalExecution` (Task 10);
  - `probeTelemetryFreshness` (Task 8);
  - `lookupFixes` (Task 16);
  - `alertSignature` (Task 11);
  - `recordOutcomeVote` (Task 19);
  - `eraseOrgWithFixMemory` (Task 21; its `hooks.rebuild` seam injects the failing post-cascade rebuild);
  - `executeOrgMerge` (`services/orgMerge.ts:1001`);
  - `db` fixtures.

- [ ] **Step 1: Write the test**

```ts
// apps/api/src/__tests__/integration/fixOutcomeLifecycle.integration.test.ts
import './setup';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { alerts, deviceMetrics, devices, fixMemory, fixOutcomes, remediationSuggestions, scriptExecutions, scripts, scriptVersions } from '../../db/schema';
import { eraseOrgWithFixMemory } from '../../jobs/tenantErasure';
import { advanceOutcome, handleFixOutcomeEvent } from '../../services/fixMemory/outcomeWatcher';
import { lookupFixes } from '../../services/fixMemory/lookup';
import { recordOutcomeVote } from '../../services/fixMemory/outcomeRecorder';
import { advanceOutcomesForTerminalExecution } from '../../services/fixMemory/scriptTerminalHook';
import { alertSignature } from '../../services/fixMemory/signatureLoader';
import {
  fillOutcomeSignature, markFixMemoryStaleForOrgErasure, markOwnerDriftStale, rebuildFixMemory, recomputeForOutcome,
  stalePartnerIds, transitionOutcome,
} from '../../services/fixMemory/store';
import { executeOrgMerge } from '../../services/orgMerge';
import { probeTelemetryFreshness } from '../../services/outcomeProbes';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';

const H = 3_600_000;
const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

/** A promise the test opens by hand, to hold a transaction (and its locks) open. */
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait: () => wait, open: () => open() };
}

/** True when `p` is still unsettled after `ms` — i.e. it is blocked on a lock. */
async function stillPending(p: Promise<unknown>, ms = 400): Promise<boolean> {
  const marker = Symbol('pending');
  const winner = await Promise.race([p.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r(marker), ms))]);
  return winner === marker;
}

const outcomeRow = async (id: string) => (await sys(() => db.select().from(fixOutcomes).where(eq(fixOutcomes.id, id))))[0]!;
const partnerMemory = async (partnerId: string) => sys(() => db.select().from(fixMemory).where(eq(fixMemory.partnerId, partnerId)));

async function world() {
  const partner = await createPartner();
  const o1 = await createOrganization({ partnerId: partner.id });
  const o2 = await createOrganization({ partnerId: partner.id });
  const mkDevice = async (orgId: string) => {
    const site = await createSite({ orgId });
    const [d] = await sys(() => db.insert(devices).values({
      orgId, siteId: site.id, agentId: randomUUID(), hostname: `host-${randomUUID().slice(0, 6)}`,
      osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
    }).returning({ id: devices.id }));
    return d!.id;
  };
  const d1 = await mkDevice(o1.id);
  const d2 = await mkDevice(o2.id);
  const mkScript = async (owner: { orgId?: string; partnerId?: string }) => {
    const [s] = await sys(() => db.insert(scripts).values({
      name: `fix-${randomUUID().slice(0, 6)}`, language: 'powershell', content: 'Restart-Service Spooler',
      osTypes: ['windows'], orgId: owner.orgId ?? null, partnerId: owner.partnerId ?? null,
    }).returning({ id: scripts.id }));
    const [v] = await sys(() => db.insert(scriptVersions).values({
      scriptId: s!.id, version: 1, content: 'Restart-Service Spooler', language: 'powershell', timeoutSeconds: 300,
      runAs: 'system', contentDigest: createHash('sha256').update('Restart-Service Spooler').digest('hex'),
    }).returning({ id: scriptVersions.id }));
    return { scriptId: s!.id, versionId: v!.id };
  };
  const partnerScript = await mkScript({ partnerId: partner.id });
  return { partnerId: partner.id, o1: o1.id, o2: o2.id, d1, d2, partnerScript, mkScript };
}

/** One attempt: an exit-code alert (non-broad signature) + a completed run + a pending outcome created at `t0`. */
async function attempt(w: Awaited<ReturnType<typeof world>>, orgId: string, deviceId: string, fix: { scriptId: string; versionId: string }, t0: Date, fixKind: 'partner_script' | 'org_script' = 'partner_script') {
  const watchedScript = w.partnerScript.scriptId; // the MONITORED script whose exit code alerts
  const [alert] = await sys(() => db.insert(alerts).values({
    orgId, deviceId, severity: 'high', title: 'exit 3', triggeredAt: new Date(t0.getTime() - H),
    context: { source: 'script_exit_code', scriptId: watchedScript, exitCode: 3 },
  }).returning({ id: alerts.id }));
  const [exec] = await sys(() => db.insert(scriptExecutions).values({
    scriptId: fix.scriptId, deviceId, orgId, status: 'completed', exitCode: 0, scriptVersionId: fix.versionId,
    completedAt: new Date(t0.getTime() + 60_000),
  }).returning({ id: scriptExecutions.id }));
  const [o] = await sys(() => db.insert(fixOutcomes).values({
    orgId, partnerId: w.partnerId, deviceId, sourceType: 'alert', sourceId: alert!.id, alertId: alert!.id,
    fixKind, fixIdentity: `script_version:${fix.versionId}`, scriptId: fix.scriptId, scriptVersionId: fix.versionId,
    scriptExecutionId: exec!.id, state: 'pending', deadlineAt: new Date(t0.getTime() + 24 * H), createdAt: t0,
  }).returning());
  return { outcomeId: o!.id, alertId: alert!.id };
}

async function resolveByCondition(alertId: string, at: Date) {
  await sys(() => db.update(alerts).set({ status: 'resolved', resolvedAt: at, resolutionReason: 'condition_cleared' }).where(eq(alerts.id, alertId)));
}

async function reportTelemetry(orgId: string, deviceId: string, from: Date, to: Date) {
  const rows = [];
  for (let t = from.getTime(); t < to.getTime(); t += 30 * 60_000) {
    rows.push({ deviceId, orgId, timestamp: new Date(t), cpuPercent: 5, ramPercent: 40, ramUsedMb: 2048, diskPercent: 50, diskUsedGb: 100 });
  }
  await sys(() => db.insert(deviceMetrics).values(rows).onConflictDoNothing());
  await sys(() => db.update(devices).set({ lastSeenAt: new Date(to.getTime() - 5 * 60_000) }).where(eq(devices.id, deviceId)));
}

/** Drive one attempt to `verified` along the happy path. */
async function verify(w: Awaited<ReturnType<typeof world>>, orgId: string, deviceId: string, fix: { scriptId: string; versionId: string }, t0: Date, fixKind?: 'partner_script' | 'org_script') {
  const a = await attempt(w, orgId, deviceId, fix, t0, fixKind);
  expect(await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * 60_000) })).toBe('awaiting_recovery');
  await resolveByCondition(a.alertId, new Date(t0.getTime() + H));
  expect(await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * H) })).toBe('holding');
  await reportTelemetry(orgId, deviceId, new Date(t0.getTime() + H), new Date(t0.getTime() + 25 * H));
  expect(await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 25 * H + 60_000) })).toBe('verified');
  return a;
}

async function memoryFor(w: Awaited<ReturnType<typeof world>>, orgId: string, alertId: string) {
  const resolved = await sys(() => alertSignature(alertId));
  return sys(() => lookupFixes({ orgId, partnerId: w.partnerId, signature: resolved!.signature, limit: 5 }));
}

describe('fix outcome lifecycle (real Postgres)', () => {
  it('three verified attempts across two clients make a partner-wide proven fix', async () => {
    const w = await world();
    const base = Date.UTC(2026, 10, 1);
    await verify(w, w.o1, w.d1, w.partnerScript, new Date(base));
    await verify(w, w.o2, w.d2, w.partnerScript, new Date(base + 30 * H));
    const last = await verify(w, w.o1, w.d1, w.partnerScript, new Date(base + 60 * H));
    const out = await memoryFor(w, w.o2, last.alertId);
    expect(out.proven).toHaveLength(1);
    expect(out.proven[0]).toMatchObject({ scope: 'all_clients', attempts: 3, verified: 3 });
    const rows = await sys(() => db.select().from(fixMemory).where(eq(fixMemory.partnerId, w.partnerId)));
    expect(rows).toHaveLength(1); // one partner row, no per-org copies
  });

  it('two terminal transitions from the SAME holding snapshot: exactly one wins, and it counts once (Review Focus 1)', async () => {
    const w = await world();
    const t0 = new Date(Date.UTC(2026, 10, 5));
    const a = await attempt(w, w.o1, w.d1, w.partnerScript, t0);
    await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * 60_000) });
    const resolvedAt = new Date(t0.getTime() + H);
    await resolveByCondition(a.alertId, resolvedAt);
    const evt = { id: randomUUID(), type: 'alert.resolved', orgId: w.o1, source: 't', priority: 'normal',
      payload: { alertId: a.alertId, resolvedAt: resolvedAt.toISOString(), resolvedBy: null, resolutionReason: 'condition_cleared' },
      metadata: { timestamp: '' } } as never;
    await Promise.all([handleFixOutcomeEvent(evt), handleFixOutcomeEvent(evt)]); // redelivery
    const holding = await outcomeRow(a.outcomeId);
    expect(holding.state).toBe('holding');
    await reportTelemetry(w.o1, w.d1, resolvedAt, new Date(resolvedAt.getTime() + 24 * H));
    const end = new Date(resolvedAt.getTime() + 24 * H + 60_000);
    // Two writers (sweeper + event handler) holding the same pre-transition snapshot, each in its
    // own transaction. The loser blocks on the row lock, then re-evaluates the CAS on the committed
    // row. The aggregate alone cannot tell one winner from two (a replay reads one outcome row
    // either way), so the win count is the discriminating assertion.
    const wins = await Promise.all([
      sys(() => transitionOutcome(holding, { to: 'verified', reason: 'held_with_fresh_telemetry' }, end)),
      sys(() => transitionOutcome(holding, { to: 'verified', reason: 'held_with_fresh_telemetry' }, end)),
    ]);
    expect(wins.filter((won) => won)).toHaveLength(1);
    expect(wins.filter((won) => !won)).toHaveLength(1);
    expect(await advanceOutcome(a.outcomeId, { now: end })).toBe('verified'); // a late sweeper sees terminal and stops
    const [row] = await partnerMemory(w.partnerId);
    expect(row).toMatchObject({ attempts: 1, verifiedCount: 1 });
  });

  it('a terminal transition from an unsigned snapshot still aggregates: the CAS-returned row carries the signature (Review Focus 1)', async () => {
    const w = await world();
    const t0 = new Date(Date.UTC(2026, 10, 4));
    const a = await attempt(w, w.o1, w.d1, w.partnerScript, t0);
    await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * 60_000) }); // first advance signs the row
    await resolveByCondition(a.alertId, new Date(t0.getTime() + H));
    expect(await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * H) })).toBe('holding');
    const persisted = await outcomeRow(a.outcomeId);
    expect(persisted.signatureKey).not.toBeNull();
    // A watcher whose snapshot predates the signature fill.
    const unsigned = { ...persisted, signatureVersion: null, signatureKey: null, broadKey: null, osType: null };
    // Lost fill CAS -> the persisted (signed) row is reloaded, not the unsigned snapshot returned.
    expect((await sys(() => fillOutcomeSignature(unsigned, new Date()))).signatureKey).toBe(persisted.signatureKey);
    expect(await sys(() => transitionOutcome(unsigned, { to: 'verified', reason: 'held_with_fresh_telemetry' }, new Date()))).toBe(true);
    const [row] = await partnerMemory(w.partnerId);
    expect(row).toMatchObject({ attempts: 1, verifiedCount: 1 }); // counted AND aggregated, not counted-and-lost
  });

  it('a SQL failure inside the hook on a caller-supplied executor does not abort the caller’s transaction (savepoint, decision D-a)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // The caller's open transaction is the system context's tx; `db` resolves to it, as the
      // executor commandCancelPropagation.ts:90-97 forwards. 'not-a-uuid' makes Postgres raise
      // 22P02 inside the hook's UPDATE.
      const survived = await sys(async () => {
        expect(await advanceOutcomesForTerminalExecution({ executionId: 'not-a-uuid', status: 'failed' }, db)).toBe(0);
        // Without the savepoint this statement raises 25P02 (current transaction is aborted).
        const probe = await db.select({ id: fixOutcomes.id }).from(fixOutcomes).limit(1);
        return Array.isArray(probe);
      });
      expect(survived).toBe(true); // and the caller's transaction committed
      expect(err).toHaveBeenCalled(); // the hook logged its own failure
    } finally {
      err.mockRestore();
    }
  });

  it('a human resolve is inconclusive and never counted (Review Focus 2)', async () => {
    const w = await world();
    const t0 = new Date(Date.UTC(2026, 10, 8));
    const a = await attempt(w, w.o1, w.d1, w.partnerScript, t0);
    await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * 60_000) });
    const user = await createUser({ partnerId: w.partnerId, orgId: w.o1, email: `fix-${randomUUID()}@example.com` });
    await sys(() => db.update(alerts).set({ status: 'resolved', resolvedAt: new Date(t0.getTime() + H), resolvedBy: user.id, resolutionReason: 'manual' }).where(eq(alerts.id, a.alertId)));
    expect(await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * H) })).toBe('inconclusive');
    expect(await sys(() => db.select().from(fixMemory).where(eq(fixMemory.partnerId, w.partnerId)))).toEqual([]);
  });

  it('a device offline at hold end is inconclusive, not verified (Review Focus 3)', async () => {
    const w = await world();
    const t0 = new Date(Date.UTC(2026, 10, 10));
    const a = await attempt(w, w.o1, w.d1, w.partnerScript, t0);
    await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * 60_000) });
    await resolveByCondition(a.alertId, new Date(t0.getTime() + H));
    await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * H) });
    await sys(() => db.update(devices).set({ lastSeenAt: new Date(t0.getTime() + 2 * H), status: 'offline' }).where(eq(devices.id, w.d1)));
    expect(await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 25 * H + 60_000) })).toBe('inconclusive');
    const [o] = await sys(() => db.select().from(fixOutcomes).where(eq(fixOutcomes.id, a.outcomeId)));
    expect(o!.stateReason).toBe('telemetry_heartbeat_stale');
  });

  it('erasure: a rebuild racing the cascade cannot clear the request, and a failed post-cascade rebuild is retried by the sweeper', async () => {
    const w = await world();
    const base = Date.UTC(2026, 10, 12);
    await verify(w, w.o1, w.d1, w.partnerScript, new Date(base));
    await verify(w, w.o2, w.d2, w.partnerScript, new Date(base + 30 * H));
    const last = await verify(w, w.o1, w.d1, w.partnerScript, new Date(base + 60 * H));
    expect((await memoryFor(w, w.o1, last.alertId)).proven).toHaveLength(1);

    // Step 1 alone: stale + a durable request naming o2.
    expect(await sys(() => markFixMemoryStaleForOrgErasure(w.o2))).toBe(w.partnerId);
    expect((await memoryFor(w, w.o1, last.alertId)).proven).toEqual([]); // stale => excluded
    expect((await partnerMemory(w.partnerId))[0]).toMatchObject({ attempts: 3, rebuildPendingOrgIds: [w.o2] });

    // A sweeper rebuild that runs before the cascade has deleted anything. o2 still exists,
    // so it must neither un-stale the row nor drop the request, even though its recount is
    // "successful". (The bug: stale_since was the only marker and this rebuild cleared it.)
    await sys(() => rebuildFixMemory({ partnerId: w.partnerId }));
    const raced = (await partnerMemory(w.partnerId))[0]!;
    expect(raced).toMatchObject({ attempts: 3, rebuildPendingOrgIds: [w.o2] });
    expect(raced.staleSince).not.toBeNull();

    // The real erasure, with its post-cascade rebuild failing (swallowed by design).
    const actor = await createUser({ partnerId: w.partnerId, orgId: null, email: `erase-${randomUUID()}@example.com` });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await eraseOrgWithFixMemory(w.o2, actor.id, actor.email, { rebuild: async () => { throw new Error('injected rebuild failure'); } });
    } finally {
      err.mockRestore();
    }
    expect(await sys(() => db.select().from(fixOutcomes).where(eq(fixOutcomes.orgId, w.o2)))).toEqual([]);
    const stranded = (await partnerMemory(w.partnerId))[0]!;
    expect(stranded).toMatchObject({ attempts: 3, rebuildPendingOrgIds: [w.o2] }); // o2's attempt still counted...
    expect(stranded.staleSince).not.toBeNull(); // ...but out of "proven", and still requested (re-run of mark did not append twice)
    expect(await sys(() => stalePartnerIds(1000))).toContain(w.partnerId); // the sweeper selects it

    await sys(() => rebuildFixMemory({ partnerId: w.partnerId })); // what the sweeper's rebuild pass runs
    expect((await partnerMemory(w.partnerId))[0]).toMatchObject({ attempts: 2, verifiedCount: 2, staleSince: null, rebuildPendingOrgIds: [] });
    expect((await memoryFor(w, w.o1, last.alertId)).proven).toEqual([]); // 2 verified < the 3-attempt proof bar
  });

  it('script re-scope org→partner folds org history into the partner row (Review Focus 5)', async () => {
    const w = await world();
    const orgScript = await w.mkScript({ orgId: w.o1, partnerId: w.partnerId });
    const base = Date.UTC(2026, 10, 16);
    for (let i = 0; i < 3; i += 1) await verify(w, w.o1, w.d1, orgScript, new Date(base + i * 30 * H), 'org_script');
    expect(await sys(() => db.select().from(fixMemory).where(eq(fixMemory.orgId, w.o1)))).toHaveLength(1);
    await sys(() => db.update(scripts).set({ orgId: null }).where(eq(scripts.id, orgScript.scriptId)));
    expect(await sys(() => markOwnerDriftStale())).toBeGreaterThanOrEqual(1);
    await sys(() => rebuildFixMemory({ partnerId: w.partnerId }));
    expect(await sys(() => db.select().from(fixMemory).where(eq(fixMemory.orgId, w.o1)))).toEqual([]);
    const partnerRows = await sys(() => db.select().from(fixMemory).where(and(eq(fixMemory.partnerId, w.partnerId), isNull(fixMemory.orgId))));
    expect(partnerRows).toHaveLength(1);
    expect(partnerRows[0]).toMatchObject({ fixKind: 'partner_script', attempts: 3 });
  });

  it('a new script version drops the old proof out of "proven" (Review Focus 5)', async () => {
    const w = await world();
    const base = Date.UTC(2026, 10, 20);
    let last = await verify(w, w.o1, w.d1, w.partnerScript, new Date(base));
    last = await verify(w, w.o1, w.d1, w.partnerScript, new Date(base + 30 * H));
    last = await verify(w, w.o2, w.d2, w.partnerScript, new Date(base + 60 * H));
    expect((await memoryFor(w, w.o1, last.alertId)).proven).toHaveLength(1);
    await sys(() => db.insert(scriptVersions).values({
      scriptId: w.partnerScript.scriptId, version: 2, content: 'Restart-Service Spooler -Force', language: 'powershell',
      timeoutSeconds: 300, runAs: 'system', contentDigest: createHash('sha256').update('v2').digest('hex'),
    }));
    await sys(() => db.update(scripts).set({ version: 2 }).where(eq(scripts.id, w.partnerScript.scriptId)));
    const after = await memoryFor(w, w.o1, last.alertId);
    expect(after.proven).toEqual([]);
    expect(after.similar).toEqual([]); // undispatchable version is hidden everywhere
  });

  it('an already-counted outcome never counts twice, even when the state CAS would match (Review Focus 1)', async () => {
    const w = await world();
    const a = await verify(w, w.o1, w.d1, w.partnerScript, new Date(Date.UTC(2026, 10, 6)));
    const counted = await outcomeRow(a.outcomeId);
    expect(counted.state).toBe('verified');
    expect(counted.countedAt).not.toBeNull();
    // A stale writer whose snapshot's `state` still matches: only `counted_at IS NULL` stops it.
    expect(await sys(() => transitionOutcome(counted, { to: 'failed', reason: 'late_verdict' }, new Date()))).toBe(false);
    expect(await outcomeRow(a.outcomeId)).toMatchObject({ state: 'verified', stateReason: 'held_with_fresh_telemetry' });
    const [row] = await partnerMemory(w.partnerId);
    expect(row).toMatchObject({ attempts: 1, verifiedCount: 1, failedCount: 0 });
  });

  it('a rebuild waits for an in-flight recompute of the same identity and never overwrites it (one lock protocol)', async () => {
    const w = await world();
    const base = Date.UTC(2026, 10, 7);
    await verify(w, w.o1, w.d1, w.partnerScript, new Date(base));
    const t0 = new Date(base + 30 * H);
    const a = await attempt(w, w.o2, w.d2, w.partnerScript, t0);
    await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * 60_000) });
    await resolveByCondition(a.alertId, new Date(t0.getTime() + H));
    expect(await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * H) })).toBe('holding');
    const holding = await outcomeRow(a.outcomeId);
    const reached = gate();
    const release = gate();
    // T1: terminal transition + recompute, then keep the transaction (and the identity lock) open.
    const t1 = sys(async () => {
      expect(await transitionOutcome(holding, { to: 'verified', reason: 'held_with_fresh_telemetry' }, new Date())).toBe(true);
      reached.open();
      await release.wait();
    });
    await reached.wait();
    // T2: a rebuild of the same partner must wait on the identity lock BEFORE it reads contributions.
    const t2 = sys(() => rebuildFixMemory({ partnerId: w.partnerId }));
    expect(await stillPending(t2)).toBe(true);
    release.open();
    await t1;
    await t2;
    // Under a separate rebuild lock, T2 would have read 1 attempt and overwritten T1's 2 after T1 committed.
    const [row] = await partnerMemory(w.partnerId);
    expect(row).toMatchObject({ attempts: 2, verifiedCount: 2 });
  });

  it('a re-vote that arrives during a recount is not lost (Review Focus 1)', async () => {
    const w = await world();
    const a = await verify(w, w.o1, w.d1, w.partnerScript, new Date(Date.UTC(2026, 10, 9)));
    const voter = await createUser({ partnerId: w.partnerId, orgId: w.o1, email: `vote-${randomUUID()}@example.com` });
    const [suggestion] = await sys(() => db.insert(remediationSuggestions).values({
      orgId: w.o1, sourceType: 'alert', sourceId: a.alertId, alertId: a.alertId, deviceId: w.d1, targetType: 'script',
      scriptId: w.partnerScript.scriptId, title: 'Restart spooler', rationale: 'r', expectedAction: 'e', status: 'executed',
    }).returning({ id: remediationSuggestions.id }));
    await sys(() => db.update(fixOutcomes).set({ suggestionId: suggestion!.id }).where(eq(fixOutcomes.id, a.outcomeId)));
    await sys(() => recordOutcomeVote({ suggestionId: suggestion!.id, orgId: w.o1, vote: 'up', userId: voter.id }));

    const reached = gate();
    const release = gate();
    const t1 = sys(() => recomputeForOutcome(a.outcomeId, new Date(), {
      afterRecompute: async () => { reached.open(); await release.wait(); },
    }));
    await reached.wait();
    const t2 = sys(() => recordOutcomeVote({ suggestionId: suggestion!.id, orgId: w.o1, vote: 'down', userId: voter.id }));
    expect(await stillPending(t2)).toBe(true); // blocked on the recount's FOR UPDATE row lock
    release.open();
    await t1;
    await t2;
    expect((await outcomeRow(a.outcomeId)).recountRequestedAt).not.toBeNull(); // the 👎 re-requested after the clear
    await sys(() => recomputeForOutcome(a.outcomeId));
    const [row] = await partnerMemory(w.partnerId);
    expect(row).toMatchObject({ attempts: 1, verifiedCount: 0, failedCount: 1, downVotes: 1 });
  });

  it('a disk_read anomaly hold with only CPU/RAM samples is inconclusive, not verified (Review Focus 3)', async () => {
    const w = await world();
    const recoveredAt = new Date(Date.UTC(2026, 10, 11));
    const holdingUntil = new Date(recoveredAt.getTime() + 24 * H);
    const [o] = await sys(() => db.insert(fixOutcomes).values({
      orgId: w.o1, partnerId: w.partnerId, deviceId: w.d1, sourceType: 'anomaly', sourceId: randomUUID(),
      signatureVersion: 1, signatureKey: 'd'.repeat(64), broadKey: 'd'.repeat(64), osType: 'windows',
      signatureFacets: { family: 'anomaly', condition: 'anomaly:device_metrics:spike:disk_read', osFamily: 'windows', discriminator: null, rootInferred: false },
      fixKind: 'partner_script', fixIdentity: `script_version:${w.partnerScript.versionId}`,
      scriptId: w.partnerScript.scriptId, scriptVersionId: w.partnerScript.versionId,
      state: 'holding', recoveredAt, holdingUntil, deadlineAt: holdingUntil, createdAt: new Date(recoveredAt.getTime() - H),
    }).returning({ id: fixOutcomes.id }));
    await reportTelemetry(w.o1, w.d1, recoveredAt, holdingUntil); // cpu/ram rows only: disk_read_bps stays NULL
    // The device DID report — just not the measurement this problem is about.
    expect(await sys(() => probeTelemetryFreshness({ deviceId: w.d1, from: recoveredAt, to: holdingUntil, probe: { table: 'device_metrics', column: 'cpu_percent' } })))
      .toMatchObject({ fresh: true });
    expect(await advanceOutcome(o!.id, { now: new Date(holdingUntil.getTime() + 60_000) })).toBe('inconclusive');
    expect((await outcomeRow(o!.id)).stateReason).toBe('telemetry_metric_gap');
  });

  it('a real recurrence is found behind 60 unrelated alerts in the hold window (Review Focus 3)', async () => {
    const w = await world();
    const t0 = new Date(Date.UTC(2026, 10, 13));
    const a = await attempt(w, w.o1, w.d1, w.partnerScript, t0);
    await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * 60_000) });
    await resolveByCondition(a.alertId, new Date(t0.getTime() + H));
    expect(await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 2 * H) })).toBe('holding');
    // Same prefilter (script_exit_code), different signature (another monitored script): pure noise, sorted first.
    const other = await w.mkScript({ partnerId: w.partnerId });
    await sys(() => db.insert(alerts).values(Array.from({ length: 60 }, (_, i) => ({
      orgId: w.o1, deviceId: w.d1, severity: 'low' as const, title: `noise ${i}`,
      triggeredAt: new Date(t0.getTime() + 3 * H + i * 60_000),
      context: { source: 'script_exit_code', scriptId: other.scriptId, exitCode: 1 },
    }))));
    await sys(() => db.insert(alerts).values({
      orgId: w.o1, deviceId: w.d1, severity: 'high', title: 'exit 3 again', triggeredAt: new Date(t0.getTime() + 5 * H),
      context: { source: 'script_exit_code', scriptId: w.partnerScript.scriptId, exitCode: 3 },
    }));
    expect(await advanceOutcome(a.outcomeId, { now: new Date(t0.getTime() + 6 * H) })).toBe('recurred');
  });

  it('a proven partner fix whose script is re-scoped to org A is never offered to org B, even under system scope (Review Focus 5)', async () => {
    const w = await world();
    const base = Date.UTC(2026, 10, 15);
    await verify(w, w.o1, w.d1, w.partnerScript, new Date(base));
    await verify(w, w.o2, w.d2, w.partnerScript, new Date(base + 30 * H));
    const last = await verify(w, w.o2, w.d2, w.partnerScript, new Date(base + 60 * H));
    expect((await memoryFor(w, w.o2, last.alertId)).proven).toHaveLength(1);
    // Scope-only re-scope (routes/scripts.ts:921-928 keeps the version): partner-wide -> org A.
    await sys(() => db.update(scripts).set({ orgId: w.o1 }).where(eq(scripts.id, w.partnerScript.scriptId)));
    const forB = await memoryFor(w, w.o2, last.alertId); // memoryFor runs under SYSTEM scope: RLS cannot help here
    expect(forB.proven).toEqual([]);
    expect(forB.similar).toEqual([]);
    expect(await sys(() => markOwnerDriftStale())).toBeGreaterThanOrEqual(1);
    await sys(() => rebuildFixMemory({ partnerId: w.partnerId }));
    const rows = await sys(() => db.select().from(fixMemory).where(eq(fixMemory.scriptId, w.partnerScript.scriptId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: w.o1, partnerId: null, attempts: 1 }); // only org A's own attempt, privately
  });

  it('an org-private fix whose script moves org A -> org B is flagged as drift and dropped by the rebuild (Review Focus 5)', async () => {
    const w = await world();
    const orgScript = await w.mkScript({ orgId: w.o1, partnerId: w.partnerId });
    const base = Date.UTC(2026, 10, 18);
    for (let i = 0; i < 3; i += 1) await verify(w, w.o1, w.d1, orgScript, new Date(base + i * 30 * H), 'org_script');
    await sys(() => db.update(scripts).set({ orgId: w.o2 }).where(eq(scripts.id, orgScript.scriptId)));
    const byScript = () => sys(() => db.select().from(fixMemory).where(eq(fixMemory.scriptId, orgScript.scriptId)));
    expect((await byScript())[0]).toMatchObject({ orgId: w.o1, staleSince: null });
    expect(await sys(() => markOwnerDriftStale())).toBeGreaterThanOrEqual(1);
    expect((await byScript())[0]!.staleSince).not.toBeNull(); // an org_id change is drift, not just org<->partner
    await sys(() => rebuildFixMemory({ partnerId: w.partnerId }));
    expect(await byScript()).toEqual([]); // org A's attempts no longer belong to any owner org B could see
  });

  it('org merge: loser outcomes stay with the loser (leave-for-erasure); erasure + rebuild leave only the survivor’s proof', async () => {
    const prior = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
    try {
      const w = await world();
      const base = Date.UTC(2026, 10, 22);
      await verify(w, w.o1, w.d1, w.partnerScript, new Date(base)); // loser
      await verify(w, w.o2, w.d2, w.partnerScript, new Date(base + 30 * H)); // survivor
      await verify(w, w.o2, w.d2, w.partnerScript, new Date(base + 60 * H)); // survivor
      const actor = await createUser({ partnerId: w.partnerId, orgId: null, email: `merge-${randomUUID()}@example.com` });

      await executeOrgMerge({ loserOrgId: w.o1, survivorOrgId: w.o2, partnerId: w.partnerId, performedBy: actor.id, performedByEmail: actor.email });
      // leave-for-erasure: not re-pointed (no restamp, no double count), device moves notwithstanding.
      expect(await sys(() => db.select().from(fixOutcomes).where(eq(fixOutcomes.orgId, w.o1)))).toHaveLength(1);
      expect(await sys(() => db.select().from(fixOutcomes).where(eq(fixOutcomes.orgId, w.o2)))).toHaveLength(2);
      expect((await partnerMemory(w.partnerId))[0]).toMatchObject({ attempts: 3, verifiedCount: 3 });

      // jobs/orgMerge.ts:164 enqueues the loser's erasure; run exactly what that job runs.
      await eraseOrgWithFixMemory(w.o1, actor.id, actor.email);
      expect(await sys(() => db.select().from(fixOutcomes).where(eq(fixOutcomes.orgId, w.o1)))).toEqual([]);
      expect((await partnerMemory(w.partnerId))[0]).toMatchObject({ attempts: 2, verifiedCount: 2, staleSince: null, rebuildPendingOrgIds: [] });
    } finally {
      if (prior === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
      else process.env.ORG_MERGE_FENCE_DRAIN_MS = prior;
    }
  });

  it('the inline script hook fails the attempt once and the recount pass aggregates it (decision D-a)', async () => {
    const w = await world();
    const a = await attempt(w, w.o1, w.d1, w.partnerScript, new Date(Date.UTC(2026, 10, 24)));
    const executionId = (await outcomeRow(a.outcomeId)).scriptExecutionId!;
    expect(await sys(() => advanceOutcomesForTerminalExecution({ executionId, status: 'failed' }))).toBe(1);
    expect(await sys(() => advanceOutcomesForTerminalExecution({ executionId, status: 'failed' }))).toBe(0); // CAS: once
    const failed = await outcomeRow(a.outcomeId);
    expect(failed).toMatchObject({ state: 'failed', stateReason: 'script_failed' });
    expect(failed.recountRequestedAt).not.toBeNull();
    expect(await partnerMemory(w.partnerId)).toEqual([]); // the org-scoped hook never writes fix_memory
    await sys(() => recomputeForOutcome(a.outcomeId)); // what the sweeper's recount pass runs
    expect((await partnerMemory(w.partnerId))[0]).toMatchObject({ attempts: 1, failedCount: 1 });
    expect((await outcomeRow(a.outcomeId)).recountRequestedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — it must pass, and prove it discriminates**

Run: `pnpm test-stack up && cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/fixOutcomeLifecycle.integration.test.ts`
Expected: PASS (18 tests).

Controls: each mutation below is one line and must turn exactly the named case red. Revert after each. Before trusting a red, confirm the mutation landed (re-read the line) and that the failure is the named assertion, not an import or type error.

Concurrency and exactly-once cases:

1. **"two terminal transitions from the SAME holding snapshot…"**
   - Mutation: in `transitionOutcome`, replace `.where(and(eq(fixOutcomes.id, outcome.id), eq(fixOutcomes.state, outcome.state), isNull(fixOutcomes.countedAt)))` with `.where(eq(fixOutcomes.id, outcome.id))`.
   - Fails at: `wins.filter((won) => won)` has length 2. The loser re-evaluates the id-only WHERE on the committed row and also "wins".
   - The final `attempts: 1` still passes. That is why the win count, not the aggregate, is the discriminating assertion.
2. **"an already-counted outcome never counts twice…"**
   - Mutation: in `transitionOutcome`'s WHERE, delete `isNull(fixOutcomes.countedAt)`.
   - Fails at: the forged late verdict wins, so `failedCount` becomes 1.
   - The snapshot's `state` ('verified') still matches the row. The other terminal protections (state CAS, `advanceOutcome`'s terminal early return) cannot mask this, because the test calls `transitionOutcome` directly with a matching state.
3. **"a terminal transition from an unsigned snapshot still aggregates…"** Either mutation turns it red.
   - (a) In `transitionOutcome`, replace `.returning();` with `.returning({ id: fixOutcomes.id });`, the pre-fix shape. The returned row carries no signature, so the attempt is counted and never aggregated. Fails at: `partnerMemory` is `[]`.
   - (b) In `fillOutcomeSignature`, replace `if (updated) return updated;` with `return updated ?? row;`, the pre-fix shape. Fails at: the fill assertion returns the unsigned snapshot, so `signatureKey` is `null`.
4. **"a rebuild waits for an in-flight recompute…"**
   - Mutation: in `recomputeIdentity`, delete `await lock(identityLockKey(identity));`.
   - Fails at: the final count (`attempts` 1). T2 reads contributions before T1 commits, blocks only on the row lock of its `ON CONFLICT DO UPDATE`, then overwrites T1's 2 with its stale 1.
   - The pre-review shape fails at the same assertion: one partner-wide `fix_memory_rebuild:<partner>` lock plus a single `groupContributions` pass.
5. **"a re-vote that arrives during a recount…"**
   - Mutation: in `recomputeForOutcome`, delete `.for('update')`.
   - Fails at: `stillPending(t2)` is false, and `recountRequestedAt` ends NULL.
6. **"a SQL failure inside the hook on a caller-supplied executor…"**
   - Mutation: in `advanceOutcomesForTerminalExecution`, replace `return await executor.transaction((savepoint) => write(savepoint as unknown as OutcomeWriter));` with `return await write(executor);`.
   - Fails at: the probe `select` raises 25P02 (`current transaction is aborted`), so `sys` rejects.
7. **"erasure: a rebuild racing the cascade cannot clear the request…"** Either mutation turns it red.
   - (a) In `recomputeIdentity`'s stale clear, delete `NO_PENDING_ERASURE_REQUEST` from the `and(...)`. Fails at: `raced.staleSince` is null, which is the reported defect.
   - (b) In `erasedPendingOrgIds`, delete the line `AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = pending.org_id)`. The racing rebuild drops o2's request while o2's outcome still counts. Fails at: `raced` `rebuildPendingOrgIds: [w.o2]`.
8. **"the inline script hook fails the attempt once…"**
   - No single line reddens it. The hook's `eq(fixOutcomes.state, 'pending')` and `isNull(fixOutcomes.countedAt)` guards are redundant for a sequential redelivery.
   - Mutation: delete both lines. Fails at: the second call's `toBe(0)`, which becomes 1.
   - The single-guard property is pinned by control 2 on the watcher path.

Other cases:

9. In `telemetryProbeFor`, return `LIVENESS` for every `anomaly:device_metrics:` condition. "a disk_read anomaly hold…" fails: the result is `verified`.
10. In `scanRecurrence`, replace the paged loop with one unordered `.limit(25)` query. "a real recurrence is found behind 60…" fails: the result is `verified` or `holding`.
11. In `scriptOwnerVisible`, return `true`. "…re-scoped to org A is never offered to org B…" fails: org B gets a proven fix.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/fixOutcomeLifecycle.integration.test.ts
git commit -m "test(api): real-Postgres fix-outcome lifecycle, exactly-once, erasure and re-scope

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 24: Full contract sweep before the PR (unit + integration + drift)

**Files:** none (verification only). Run everything from the repo root with a fresh per-worktree stack.

- [ ] **Step 1: Bring up the stack and apply migrations from zero**

`db:check-drift` reads only the ledger, so run the migrations against the fresh stack first. Run the migrate command twice; the second run must be a no-op.

```bash
pnpm test-stack down; pnpm test-stack up
DB_URL=$(grep '^DATABASE_URL=' .env.test | cut -d= -f2-)
DATABASE_URL="$DB_URL" pnpm db:migrate
DATABASE_URL="$DB_URL" pnpm db:migrate
DATABASE_URL="$DB_URL" pnpm db:check-drift
```
Expected: both migrate runs exit 0, and the drift check passes with one ledger row per file, including the three `2026-11-01-*` migrations.

- [ ] **Step 2: RLS coverage contract (own config)**

```bash
(cd apps/api && DB_CONTEXTLESS_WRITE_STRICT=true pnpm test:rls-coverage)
```
Expected: PASS, including the `fix_memory` dual-axis, XOR and partner-wide SELECT assertions and `fix_outcomes` auto-discovery.

- [ ] **Step 3: Tenancy integration contracts + this wave's integration suites**

```bash
(cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/fixMemoryPartnerRls.integration.test.ts \
  src/__tests__/integration/fixMemoryCatalog.integration.test.ts \
  src/__tests__/integration/fixOutcomeLifecycle.integration.test.ts)
(cd apps/api && pnpm test:integration-suite-coverage)
```
Expected: PASS on all of them.

- [ ] **Step 4: Full API unit suite (orgMerge only reds in the full run) + web + shared**

```bash
(cd apps/api && npx vitest run)
(cd apps/web && npx vitest run)
(cd packages/shared && npx vitest run)
```
Expected: PASS. In particular, check that the reported API file count includes `cascadeDelete.test.ts`, `moveOrg.coverage.test.ts`, `orgMerge.test.ts`, `eventSubscribers.contract.test.ts`, `workerRegistry.test.ts`, `workerEntrypointClosure.contract.test.ts`, `partner-wide-write-coverage.test.ts`, `migrationRlsScope.test.ts`, `autoMigrate.test.ts` and the 20 tool-registry contracts from Task 20.

- [ ] **Step 5: Typecheck and lint**

```bash
pnpm lint
(cd apps/api && npx tsc --noEmit -p tsconfig.json)
(cd apps/web && npx tsc --noEmit)
```
Expected: exit 0.

- [ ] **Step 6: Tear down and open the PR**

```bash
pnpm test-stack down
git push -u origin HEAD
gh pr create --title "feat: AI Suggested Fixes W1 — fix outcomes and partner-wide fix memory" --body-file <(printf '%s\n' \
  'Closes #<W1 sub-issue>' '' \
  'Implements docs/superpowers/plans/ai-mcp/2026-09-26-ai-suggested-fixes-w1-foundation.md.' '' \
  'Settings: none added (Fix memory is data, gated by the existing ml.remediation_suggestions.enabled flag).' '' \
  'pt-BR strings are machine-drafted pending native review' '' \
  '🤖 Generated with [Claude Code](https://claude.com/claude-code)')
```

Before merging, run the one `/pr-review-toolkit:review-pr` round. This change is high blast radius (tenancy, RLS, migrations), so use a Sonnet or Opus reviewer.

---

## Self-review

### Spec coverage map (W1 row + every W1-applicable section)

| Spec requirement | Task(s) |
|---|---|
| `fix_outcomes` table (shape 1): columns, unique `(suggestion_id)`, deferrable composite FK, private detail stays here | 2 |
| `fix_memory` table (org XOR partner): dual-axis policy + SELECT-only partner branch, `DUAL_AXIS_TENANT_TABLES`, not exempt | 2, 3 |
| Registrations: org cascade, device cascade, merge `leave-for-erasure`, export policy (`signature_facets` excludedOpen), no `AUDIT_ADMIN_REQUIRED_TABLES` | 3, 4 |
| `fixMemoryPartnerRls.integration.test.ts`: forge 42501, XOR 23514, org-token SELECT branch, org B ≠ org A private, headless agent-auth | 5 |
| Proof-rule constants in `packages/shared` | 1 |
| Signature v1: family, condition semantics without org UUIDs, OS, one structured discriminator; broad = no discriminator | 6, 11 |
| Script terminal hooks on both terminal-write paths (spec: "emit `script.*`"; amended by D-a to an inline internal hook, no public events) | 10, 23 |
| `alert.resolved` subscription; only objective condition-clears count | 9, 13, 14, 23 |
| Anomaly: only `cleared` episodes count, not expiry | 13 (`readingFromEpisode`), 9 (`metricAnomalyEpisodeAlerts`) |
| Outcome state machine (every edge) + table-driven unit tests | 13 |
| Exactly-once: terminal transition guarded by `counted_at IS NULL`; aggregate recomputed under one per-identity lock shared by recompute, recount and rebuild; re-votes never lost | 10, 12, 13, 23 |
| Sweeper (5 min): timeouts, hold expiry, stranded rows; probes extracted from `fixWatch`; fixWatch behaviour unchanged | 8, 14 |
| Telemetry freshness during the hold: heartbeat + non-NULL samples of the signature's own measurement | 8, 13, 23 |
| Aggregate math: counted attempts, 👎 = failure, 👍 alone never proves, proven / demoted / lift, retired stays retired | 7, 12 |
| Version pin to `script_version_id`; old version leaves "proven" once undispatchable | 2, 7, 16, 23 |
| Owner rule; every re-scope (org→partner, partner→org, org A→org B) handled by current-owner lookup checks + org_id/partner_id drift + rebuild | 7, 12, 16, 23 |
| Candidate catalog extracted from `listCandidates`, OS-filtered, now including partner-wide scripts | 15 |
| Lookup `provenFixes`/`similarFixes` under the caller's RLS; never another org's private rows | 16 |
| Free memory attach on new alerts/anomalies as `remediation_suggestions` rows with `origin='memory'`; `origin` column defaulting to `catalog_match` | 4, 17 |
| `/execute` creates the `fix_outcomes` row and returns it (vote controls appear without reload) | 18, 22 |
| 👍/👎 and Done endpoints; panel controls via `runAction` | 19, 22 |
| `find_proven_fixes` tier-1 tool, fully registered (handler, aiTools, schemas, SDK + TOOL_TIERS, TOOL_PERMISSIONS, TOOL_CAPABILITY, mcpCoverage, tierConfig, docs) and its contracts | 20 |
| `rebuildFixMemory(scope)`; erasure: stale → delete → rebuild, retryable; merge `leave-for-erasure` proven end-to-end on real Postgres | 12, 21, 23 |
| Stale entries excluded from proven until a successful rebuild | 12, 16, 23 |
| Flag gating on `ml.remediation_suggestions.enabled` | 17, 20 |
| Contract suites (`rls-coverage`, `tenantCascade`, `tenant-export-policy`, `orgMergeRegistry`, `cascadeDelete`, `moveOrg.coverage`) | 3, 24 |

W2/W3 items are deliberately absent: the research agent/kind/profile, `submit_suggestions`, the panel redesign, the Fix memory list and Retire UI, the eval, retiring the keyword matcher, and triage/patch consumers.

### Resolved open items

- **Item 2 — condition semantics per source family.** Resolved in Task 6 (intro + code):
  - rule alerts: leaf `type` plus that type's enum fields from `alert_rules.override_settings.conditions ?? alert_templates.conditions`;
  - rule-less alerts: `context.source` plus its structured subtype;
  - anomalies: `source_table:anomaly_type:metric_family` via `episodeKeyFor`;
  - correlation: the root alert, marked `root_inferred`;
  - discriminators: service, process or software name, or exit code. There is no structured KB or event-id field on alerts today.
- **Item 3 — freshness probe.** Resolved in Task 8. The hold only verifies if both hold:
  - `devices.last_seen_at` is within 30 min of hold end (and the device is not decommissioned);
  - ≥80% of the 30-minute buckets across the hold contain a sample in `device_metrics`, or in `device_process_samples` for process-family anomalies.
- **Item 4 — cross-partner org transfer.** None exists:
  - `routes/orgs.ts:291` strips `partnerId` from the update schema;
  - `orgMerge.ts:294-295,343-344` is same-partner only;
  - `2026-10-12-100000-config-policy-inheritance.sql:165-167` says "No code path does this today".

  So it is a documented invariant, and the schema enforces it. `fix_outcomes_org_partner_fk (org_id, partner_id) → organizations(id, partner_id)` has no `ON UPDATE CASCADE`, so any future `UPDATE organizations SET partner_id` fails with 23503 until that workflow first calls `markFixMemoryStaleForOrgErasure`, deletes or archives the org's outcomes, and rebuilds the source partner. Contributions are never carried to the destination. Cross-partner *device* moves exist (system scope); `fix_outcomes` is excluded from the device-move re-stamp for exactly this reason.
- **Item 5 — which auto-resolves count.** Resolved in Task 9's table. Objective clears (`condition_cleared`):
  - `checkAutoResolve`;
  - `policyAlertBridge.ts:145`;
  - `monitorWorker.ts:380`;
  - `scriptExitCodeAlerts.ts:187`;
  - the subject outbox (`alertSubjects.ts:73`);
  - `backupProviders/alerts.ts:333`;
  - anomaly-episode `cleared`.

  Not counted:
  - `source_retired`: `hardwareHealth/retire.ts`, `backupProviders/alertsResolve.ts`;
  - `expired`: episode expiry or detection off;
  - `manual`: any `resolvedBy`, and episode actions;
  - NULL: direct-UPDATE human paths and warranty.

  The watcher distinguishes them with a new persisted `alerts.resolution_reason`, published on `alert.resolved`, and requires `resolved_by IS NULL`.

### Spec amendments (orchestrator decisions, 2026-09-26)

- **D-a: an internal hook instead of public events.** W1 does not emit `script.completed` / `script.failed`. Customer automations (`AutomationForm.tsx:186`) and webhooks (`WebhookForm.tsx:73`) subscribe to them, have never fired, and automations have no script→script loop guard. Both terminal-write paths instead call `advanceOutcomesForTerminalExecution` inline (Task 10); the sweeper stays authoritative. **Follow-up issue, not planned here:** wire the public events behind a loop guard.
- **D-c: deferral.** `find_proven_fixes` takes `alertId | anomalyEpisodeId` only; `deviceId + problem` moves to W2 (Task 20).
- **Anomalies are broad.** Anomaly signatures (and plain metric-threshold alerts) carry no structured discriminator, so they are broad. Broad signatures are never auto-attached as proven in W1; they appear only under "Similar". In W1, auto-attach therefore fires only for service, process, software and exit-code problems.
- **One attempt per source + script.** This keeps the existing `remediation_suggestions_source_script_uq` index and `/execute`'s 409 ("already has a linked script execution"). The spec's "a re-run creates a new suggestion row" is not implemented in W1.
- **Done records but does not feed memory in W1.** A manual-steps attempt is watched and votable, but `fix_identity` is NULL until a reviewed-instructions library exists, and no W1 code produces `manual_steps` rows.
- **Sweeper authoritative.** Event delivery defaults to in-process best-effort (`EVENT_DISPATCH_MODE=off`), so every fast path is an optimisation over the 5-minute sweep.

### Deviations from the spec text (each chosen for the stated reason; flagged for the owner)

1. **`fix_outcomes` is not in `CORE_DEVICE_ORG_DENORMALIZED_TABLES`.** The spec asks for it. The plan follows the `ai_agent_fix_watches` precedent instead:
   - `device_id` has no FK;
   - the table is listed in `INTENTIONALLY_NO_ORG_ID`;
   - it is excluded from `breeze_device_child_orgid_tables()`;
   - it is cascade-deleted on device delete.

   Reasons: the composite `(org_id, partner_id)` FK would abort a cross-partner device move with 23503; and an attempt's proof belongs to the org it ran in. The sweeper cancels in-flight rows whose device left the org.
2. **Extra columns** needed to make the aggregate a pure replay and to keep rebuilds cheap:
   - `fix_memory`: `broad_key`, `fix_identity`, `consecutive_verified`, `recent_outcomes`, `stale_since`, `rebuild_pending_org_ids` (durable org-erasure rebuild request, see Review findings 2026-09-26 re-check #4);
   - `fix_outcomes`: `broad_key`, `os_type`, `fix_identity`, `instructions_ref`, `recovered_at`, `deadline_at`, `recount_requested_at`;
   - `alerts`: `resolution_reason`.
3. **The script-failure aggregate is deferred by ≤5 minutes.** The spec says "a terminal transition and its aggregate delta commit in one transaction". That holds for every transition the watcher makes. For the inline script hook (D-a), the terminal CAS commits in the caller's org-scoped ingest transaction, and the aggregate follows on the sweeper's recount pass. The alternative, opening a second system-scoped pooled connection inside agent result ingestion, is the #1105 hazard. Exactly-once is unaffected (`counted_at` CAS), and the aggregate is derived by recompute, never by delta.
4. **Fail-closed extras beyond the spec's wording:**
   - a hold whose metric family cannot be mapped to a column is `inconclusive` (`metric_unmapped`);
   - a recurrence scan that exceeds 20 × 50 candidate alerts is `inconclusive` (`recurrence_scan_capped`);
   - neither is ever called verified.

### Review findings addressed (Codex, 2026-09-26)

| # | Finding | Fix | Pinning test |
|---|---|---|---|
| 1 | System-scope attach could surface a re-scoped script; drift missed org A→org B | `scriptOwnerVisible` in lookup; drift SQL compares `org_id` and `partner_id` against the row owner | Task 16 unit cases; Task 23 "re-scoped to org A…" and "org A → org B…" |
| 2 | Drift check never applied migrations | `pnpm db:migrate` (twice) before `db:check-drift`; subshell `cd`s | Tasks 2, 4, 24 |
| 3 | Shared mock state leaked between recorder tests | One file-level `beforeEach` resets every field | Task 18 |
| 4 | Negative control could not redden | Direct counted-marker test with a state-matching snapshot; controls list rewritten | Task 23 control 1 |
| 5 | Rebuild and recompute used unrelated locks | One per-identity lock, taken before reading; rebuild iterates identities in sorted order | Task 23 "a rebuild waits…" |
| 6 | Re-vote could lose its recount | `recomputeForOutcome` locks the outcome row first (`FOR UPDATE`) | Task 23 "a re-vote that arrives during a recount…" |
| 7 | Freshness counted any row | Per-family allow-listed column with `IS NOT NULL` | Task 8 unit; Task 23 "disk_read…" |
| 8 | Unordered `LIMIT 25` could hide a recurrence | SQL prefilter + window + keyset pages in `(triggered_at, id)` order | Task 13 unit; Task 23 "…behind 60 unrelated alerts" |
| 9 | Vote buttons absent until reload | `/execute` returns the recorded outcome | Task 18 route test; Task 22 web test |
| 10 | No real merge proof | Merge → `eraseOrgWithFixMemory` on real Postgres | Task 23 "org merge…" |

Also fixed while revising:
- `markFixMemoryStaleForOrgErasure`'s correlated subquery referenced outer columns through Drizzle column objects, which can render unqualified and bind to the inner `fix_outcomes o`. The outer columns are now written table-qualified.
- A normal recompute no longer clears `stale_since`; only a rebuild does.

### Review findings addressed (Codex concurrency re-check, 2026-09-26)

| # | Finding (verified against code) | Fix | Pinning tests (control #, Task 23) |
|---|---|---|---|
| 1 | With a caller-supplied executor, the Task 10 hook wrote directly on the caller's transaction. A PostgreSQL error there aborts that transaction even though the JS error is caught. Real caller: `commandCancelPropagation.ts:90-97` forwards its open tx through `finalizeScriptExecutionTerminal` (user cancel `routes/devices/commands.ts:1049`, heartbeat claim `commandClaimEligibility.ts:421`, org move, decommission). | The supplied-executor branch runs `executor.transaction(...)`, Drizzle's nested transaction, i.e. a driver-owned SAVEPOINT, the same mechanism as `withDbTransaction` (`db/index.ts:972`). The catch sits outside it. `ScriptTerminalExecutor` and `commandCancelPropagation`'s `DbExecutor` widen to include `'transaction'`. | Task 10 unit ("…confined to the savepoint and swallowed"); Task 23 "a SQL failure inside the hook…" (control 6) |
| 2 | "Concurrent advances … count once" was not discriminating. An id-only transition WHERE still passed, because the aggregate replay reads one outcome row either way. | The test now runs two `transitionOutcome` calls concurrently from the same holding snapshot and asserts exactly one `true` and one `false`, plus the aggregate. | Task 23 "two terminal transitions from the SAME holding snapshot" (control 1) |
| 3 | A lost signature-fill CAS returned the unsigned snapshot (`updated ?? row`). A watcher could then set `counted_at` and skip aggregation, because its snapshot had no signature while the persisted row had one. | `fillOutcomeSignature` reloads the row after a lost CAS. `transitionOutcome` uses `.returning()` and aggregates from the returned persisted row, never the snapshot; a still-unsigned counted row requests a recount. `advanceOutcome` re-checks terminal after the fill. | Task 12 unit (lost-CAS reload; aggregate from returned row; unsigned → recount); Task 23 "a terminal transition from an unsigned snapshot still aggregates" (control 3) |
| 4 | Erasure committed only a `stale_since` marker before the cascade. A concurrent rebuild could clear it while the org's outcomes still existed. If the post-cascade rebuild then failed (the error is swallowed), nothing re-triggered it, so the erased contributions stayed counted and were eligible for "proven" again. | New column `fix_memory.rebuild_pending_org_ids uuid[]` (Task 2 migration, Drizzle, export policy `included`). The mark appends the org. A rebuild removes an org id only if that org's `organizations` row was already gone BEFORE the rebuild read contributions; the cascade deletes it last. `stale_since` clears only when the array is empty, and `stalePartnerIds` selects pending rows, so the sweeper retries. It self-heals even if the process dies between cascade and rebuild; no post-cascade "arm" write is needed. | Task 12 unit (erased-org read precedes contributions; request kept while org exists; removal of exactly the gone org); Task 23 "erasure: a rebuild racing the cascade…" (control 7) and the merge case |

Known limit, unchanged in kind: an erasure whose cascade fails midway (`attempts: 1`, fails loudly for on-call) leaves the org row present. Its partner rows then stay stale and requested, and are re-attempted every sweep until on-call re-runs the erasure. That is fail-closed: never "proven" on partially erased data.
