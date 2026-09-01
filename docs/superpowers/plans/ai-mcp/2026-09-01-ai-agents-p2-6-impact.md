---
tracking_issue: LanternOps/breeze#4187
wave: W06 (#4193) — P2-6 Value accounting (PR A API + shared, PR B web)
---

# AI Agents Phase 2 — Wave P2-6: Value Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MSP can answer "what did the AI agents actually do for me, and what did it cost?" A new Shape-1 org table `ai_agent_impact_daily` holds ten immutable per-(org, UTC-day) counters plus `llm_cents`, rebuilt idempotently by a nightly `metricRollups`-shaped worker that discovers work from EVERY source timestamp (runs `queued_at`/`finished_at`, verdicts `created_at`, intents `created_at`/`executed_at`, watches `evaluated_at`, drafts `consumed_at`) and upserts a zero-emitting `generate_series` day grid, so a reclassified or removed fact cannot leave a stale nonzero bucket. `est_seconds_saved` is deliberately **NOT stored**: it is computed at read time from the counters × the partner's effective weights (`partners.ai_impact_weights`, partial overrides merged onto frozen defaults), so re-pricing a weight re-prices history instead of forking it. `GET /ai/agents/impact?window=7|30|90` returns a versioned DTO (totals, daily series, per-org top-50 for partner scope, live positive-feedback rate, effective weights); `POST /ai/agents/impact/rebuild` enqueues a deterministic 90-day per-org job; `PUT/DELETE /ai/agents/impact/weights` is a full-partner-admin mutation. The web page `/ai-agents/impact` renders stat tiles (always the word **"Estimated"** beside the actual **LLM spend**), a disjoint daily stacked bar, the per-org table, a Refresh that polls until `rebuiltAt` advances, a weights drawer, and a branded PDF export through the existing generic `buildReportPdf` path.

**Architecture:** Persistence mirrors `metricRollups` end-to-end, not `reliabilityWorker`: one `INSERT … SELECT … ON CONFLICT DO UPDATE` per (org, range) over a `generate_series` bucket grid (`services/metricRollups.ts:214-272`), each statement inside its own short-lived labeled system context preceded by `runOutsideDbContext` (`services/metricRollups.ts:140-180`), and a `scan-orgs` → per-org fan-out with deterministic range job ids (`jobs/metricRollups.ts:43-112`). Fix classification uses a **frozen POSITIVE registry** `IMPACT_FIX_TOOLS`, pinned by a contract test to the union of `ACT_ELIGIBLE_TOOL_NAMES` (`services/aiAgents/actManifest.ts:279-281`) and every `POLICY_DECIDABLE_TIER3` `toolName` — never a negative exclusion, which would silently classify a future unrelated tool as a fix. `fixes_proposed`/`fixes_executed` are each a UNION ALL of an intent-backed arm and an outcome-jsonb arm, kept disjoint by `item->>'intentId' IS NULL` (Tier-2 proposals never mint intents — `runLoop.ts:798-860`). Weights live on a dedicated `partners.ai_impact_weights jsonb NULL` column (the schema's stated preference over `partners.settings` sub-objects, `db/schema/orgs.ts:38-41`), read through `readWithPartnerAxisVisibility` (`db/partnerAxisRead.ts:8-25`) because an org-scoped RLS context sees ZERO partner rows, and written only behind `canManagePartnerWidePolicies` (`services/partnerWideAccess.ts:18-32`).

**Tech Stack:** TypeScript, Hono, Drizzle, BullMQ, PostgreSQL (RLS), Zod, Vitest, React + Astro + recharts 3.x + react-i18next (8 locales), jsPDF via `@breeze/shared/reportPdf`.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-08-28-ai-agents-phase2-intelligence-layer-design.md` §4.6 (lines 164-170), §5 rows 190-191, §7 line 214. **This plan amends the spec (Task A0)** per the arbitrated advisor quorum (Fable + Codex `gpt-5.6-sol` xhigh, read-only, 2026-09-01; all eight ranked amendments adopted): `est_seconds_saved` is read-time, not a stored column; a tenth counter `narratives_delivered` exists (the spec priced a narrative but counted none); `fixes_held`/`fixes_recurred` are renamed `fix_watches_held`/`fix_watches_recurred` because `ai_agent_fix_watches.run_id` is UNIQUE (`db/schema/aiAgentFixWatches.ts:52`) so the unit is WATCHES, not operations; fixes are a frozen positive registry; weights live on `partners.ai_impact_weights`, NOT `ai_agents.impactWeights`; every bucket is an explicit UTC calendar day and `through` is the last COMPLETE UTC day; a bootstrap org rebuilds 90 days, not 7; and `promoteEligibleCount` is deferred to a P2-6b follow-up because P2-5 has not landed.

## Global Constraints

- Tests: `cd apps/api && npx vitest run <path>`; shared: `cd packages/shared && npx vitest run <path>`; web: `cd apps/web && npx vitest run <path>` + `src/lib/i18n/localeParity.test.ts` + `src/lib/i18n/translationCoverage.test.ts` + `src/lib/__tests__/no-silent-mutations.test.ts`. Add `--pool=threads --maxWorkers=2` when a dev stack is running; **a 0-test run is a stall, not green** — always check the reported file/test count. Never write `pnpm --filter <pkg> test -- --run <path>` (the `--` makes vitest run the WHOLE suite in watch mode). Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`; same command in `packages/shared`; web `cd apps/web && npx astro check`. `pnpm lint` in every touched package.
- **One migration in PR A**: `apps/api/migrations/2026-09-30-ai-agents-impact.sql` — must sort (by `String.prototype.localeCompare`) strictly after the newest COMMITTED migration, which is `2026-09-28-quickbooks-entity-mappings.sql` as of 2026-09-01. The naming ratchet runs ahead of real time, so **today's date is not guaranteed to sort last** — re-check `git ls-tree --name-only origin/main apps/api/migrations/` at PR time and rename if a newer file landed (`scripts/check-migration-naming.sh` rule 3 enforces this at commit time). `2026-08-06` is a CLOSED date block; do not go near it. Idempotent throughout (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP POLICY IF EXISTS` then `CREATE POLICY`); **no inner `BEGIN;`/`COMMIT;`** (`autoMigrate` wraps each file); explicit `ON DELETE` on every FK; never edit a shipped migration.
- Branch `feature/4187-ai-agents-p2/wave-4193` targets **main**. PR A body `Part of #4193`; PR B (`feature/4187-ai-agents-p2/wave-4193-b`, based on **main** after PR A merges) body `Closes #4193`. A PR based on a sibling branch runs NO CI — if PR B is ever opened before PR A merges, dispatch `gh workflow run CI --ref feature/4187-ai-agents-p2/wave-4193-b` by hand before merging.
- **Registries for the new table** (these contract tests fail only under the **Integration Tests** CI job, never under **Test API** — a stale base can go green then redden main): `ai_agent_impact_daily` → `CORE_ORG_CASCADE_DELETE_ORDER` in `services/tenantCascade.ts` (alphabetical by `localeCompare`, verified: between `'ai_agent_fix_watches'` and `'ai_agent_runs'`), `CORE_TENANT_EXPORT_POLICY` in `services/tenantExportPolicyRegistry.ts` (every column `included` — no jsonb, no `SUSPICIOUS_NAME_PARTS` match), `orgMergeRegistry.ts` as `{ kind: 'leave-for-erasure', note: … }`. It has no `device_id`, so the two device lists (`CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES` in `routes/devices/core.ts`) get NO entry; it is not append-only, so `AUDIT_ADMIN_REQUIRED_TABLES` gets no entry. Shape 1 is auto-discovered by `rls-coverage.integration.test.ts` — **no allowlist entry** in any of `ORG_ID_KEYED_TENANT_TABLES` / `PARTNER_TENANT_TABLES` / `DUAL_AXIS_TENANT_TABLES` / `DEVICE_ID_JOIN_POLICY_TABLES` / `USER_ID_SCOPED_TABLES`.
- **`partners.ai_impact_weights` needs NO export-policy amendment** — verified: `CORE_TENANT_EXPORT_POLICY` has no `partners` entry at all (it ends at `"organizations"`, `tenantExportPolicyRegistry.ts:417`), because the registry covers the ORG cascade set and `partners` is the partner axis. It is also deliberately **not** added to `partnerPublicColumns()` (`routes/orgs.ts:410-441`) — the weights are served by `GET /ai/agents/impact`, and that projection is the partner list's public surface.
- **Tenancy invariants:** every read path passes `auth.orgCondition(aiAgentImpactDaily.orgId)` (and `auth.orgCondition(aiAlertVerdicts.orgId)` for the live feedback query) even though RLS enforces — partner scope means ACCESSIBLE orgs, not automatically every org under the partner. The rollup writes under `withSystemDbAccessContext` and pins `org_id` explicitly in every statement. Every partner-axis READ goes through `readWithPartnerAxisVisibility` with an id that came from the verified auth context (`auth.partnerId`, or the org row's `partner_id` resolved under the caller's own context) — never a client-supplied id. The weights WRITE runs under the caller's own request context (partner scope passes `breeze_has_partner_access`), never through the system escape.
- **UTC everywhere.** Never `date_trunc('day', <timestamptz>)` — it depends on the session timezone. Bucket with `(<column> AT TIME ZONE 'UTC')::date` and bound half-open `>= (<from>::date)::timestamp AT TIME ZONE 'UTC'` / `< (<to>::date + 1)::timestamp AT TIME ZONE 'UTC'` (the `::timestamp` is LOAD-BEARING — without it a bare `date` makes `AT TIME ZONE` pick the `timestamptz` overload and the bound shifts by twice the session offset; verified in Task 9). `through` is always the last COMPLETE UTC day (today−1); the current UTC day is never in a window.
- **Do not build the bounds as a CTE.** A `bounds` CTE referenced by nine sibling CTEs is materialized, and the range predicates stop being constant-folded, which loses the index range scans this wave adds. Inline the two cast expressions in every predicate.
- **No new env flag** (spec §7 line 214): the routes are mounted unconditionally like the rest of `routes/aiAgents.ts`, and the WORKER's producer re-reads `envFlag('BREEZE_AI_AGENTS_ENABLED', false)` at call time — never a module-scope const — exactly as `processSweepTick` does (`jobs/aiAgentSweepScheduler.ts:252`). No policy-snapshot bump, no `AiAgentLimits` change, no new permission (`ai_agents:read` / `ai_agents:write` throughout).
- **Honest labelling:** the UI string is always "Estimated time saved", never "time saved"; the feedback metric is "positive feedback rate", never "precision" or "accuracy"; LLM spend is the only actual-measured number on the page and must be visually adjacent to the estimate.
- **Leak rules:** the DTO carries counters, org ids/names, weights and dates only — never a run summary, verdict rationale, ticket text, intent `reason`, or tool arguments. Nothing model-authored reaches this surface.
- Commit after every task with trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Run `get_feature_status LanternOps/breeze#4187` before starting and `start_wave` for #4193.
- **Parallel-wave rebase (P2-5, #4192).** Both branches edit `jobs/scheduleRegistry.ts`, `services/workerRegistry.ts`, `db/schema/index.ts`, `routes/aiAgents.ts` (+ `routes/aiAgents.test.ts`), `services/tenantCascade.ts`, `services/tenantExportPolicyRegistry.ts`, `services/orgMergeRegistry.ts`, the shared type/validator barrels, the 8 locale files, and `db/schema/aiAgentFixWatches.ts` (P2-6 adds an index; P2-5 adds `op_keys`). Keep every P2-6 edit to those files **additive and in place** (append an entry, insert one alphabetical line — never reorder, never reformat) so whoever merges second rebases trivially. After any rebase, re-run `scheduleRegistry.contract.test.ts`, `tenantCascade.integration.test.ts` and `tenant-export-policy.integration.test.ts` before pushing.

## File Structure

### PR A — API + shared

| File | Responsibility |
|---|---|
| spec §4.6 / §5 rows 190-191 (modify) | Amendments (A0). |
| `packages/shared/src/types/aiAgentImpact.ts` (new), `validators/aiAgentImpact.ts` (new), `types/index.ts` + `validators/index.ts` barrels, `reportPdf/reportPdf.ts` (modify) | Counter keys, weights + defaults + resolver, DTO, Zod schemas, `ai_agent_impact` PDF label (A1). |
| `apps/api/migrations/2026-09-30-ai-agents-impact.sql` (new) | Table + RLS + `partners.ai_impact_weights` + eight source indexes (A2). |
| `apps/api/src/db/schema/aiAgentImpactDaily.ts` (new), `db/schema/orgs.ts`, `db/schema/index.ts`, `services/tenantCascade.ts`, `services/tenantExportPolicyRegistry.ts`, `services/orgMergeRegistry.ts` (modify) | Drizzle + the three registries (A2). |
| `apps/api/src/services/aiAgents/impactFixTools.ts` (new) + `.contract.test.ts` (new) | Frozen positive fix registry pinned to `ACT_ELIGIBLE_TOOL_NAMES` ∪ `POLICY_DECIDABLE_TIER3` (A3). |
| `apps/api/src/services/aiAgents/impactRollup.ts` (new) + `.test.ts` (new) | `rebuildOrgImpactRange`, `findImpactSourceOrgIds`, day helpers (A4). |
| `apps/api/src/jobs/aiAgentImpactRollup.ts` (new) + `.test.ts` (new), `jobs/scheduleRegistry.ts`, `services/workerRegistry.ts` (modify) | Scan → fan-out worker, daily slot, registry entry (A5). |
| `apps/api/src/services/aiAgents/impactWeights.ts` (new) + `.test.ts` (new) | Partner-axis weights read/write behind `canManagePartnerWidePolicies` (A6). |
| `apps/api/src/services/aiAgents/impactQuery.ts` (new) + `.test.ts` (new) | Window resolution, aggregates, top-50 byOrg, live feedback, DTO assembly (A7). |
| `apps/api/src/routes/aiAgents.ts` (modify, insert BEFORE `GET /:id` at :716), `routes/aiAgents.test.ts` (modify) | `GET /impact`, `POST /impact/rebuild`, `PUT`/`DELETE /impact/weights` (A8). |
| `apps/api/src/__tests__/integration/aiAgentImpact.integration.test.ts` (new) | Live-Postgres proof of every counter, zero grid, idempotency, RLS forge, erasure, merge, partner-axis weights (A9). |

### PR B — web

| File | Responsibility |
|---|---|
| `apps/web/src/pages/ai-agents/impact.astro` (new), `components/aiAgents/ImpactPage.tsx` (new) + `.test.tsx` (new) | Page shell, window selector, tiles, chart, per-org table, Refresh + poll (B1). |
| `apps/web/src/lib/routeScope.ts`, `components/layout/Sidebar.tsx`, `components/layout/Sidebar.nav.test.tsx`, `lib/__tests__/no-silent-mutations.test.ts`, `locales/*/common.json` (modify) | `org-or-all` registration, "AI Impact" nav entry, guard registration (B1). |
| `apps/web/src/components/aiAgents/ImpactWeightsDrawer.tsx` (new) + `.test.tsx` (new), `ImpactPage.tsx` (modify), `locales/*/settings.json` (modify) | Weights editor (partner admins only) + PDF export + 8 locales (B2). |

---

## PR A — API + shared

### Task 0 (A0): Spec amendments

**Files:** Modify `docs/superpowers/specs/ai-mcp/2026-08-28-ai-agents-phase2-intelligence-layer-design.md` §4.6 (lines 164-170) and the two §5 P2-6 rows (lines 190-191).

**Interfaces:** none (documentation only).

- [ ] **Step 1:** Append a new paragraph immediately after line 170 (the `**UI.**` paragraph of §4.6), before the `## 5. Data model` heading:
```markdown
**Amendment (P2-6 plan, 2026-09-01, quorum):** (1) **`est_seconds_saved` is NOT a stored column.** It is computed at READ time from the stored counters × the partner's effective weights, so changing a weight re-prices all history instead of forking it into "rows written before the change" and "rows written after". (2) A tenth counter **`narratives_delivered`** exists — the estimate model priced a narrative at 1800 s while the column list counted none. It counts runs with `profile='narrative' AND status='completed' AND report_run_id IS NOT NULL`; `report_run_id` is stamped only by a successful `persistNarrativeReport` (`narrativeReport.ts:345`), so a `narrative_no_schedule` or persistence-failure run correctly earns nothing. (3) **`fixes_held`/`fixes_recurred` are renamed `fix_watches_held`/`fix_watches_recurred`.** `ai_agent_fix_watches.run_id` is UNIQUE (`ai_agent_fix_watches_run_id_uq`), so one row is one REMEDIATION RUN — which may have executed several actions — not one operation; the old names claimed a unit the table cannot express. (4) **Fix classification is a frozen POSITIVE registry** `IMPACT_FIX_TOOLS` = `ACT_ELIGIBLE_TOOL_NAMES` ∪ every `POLICY_DECIDABLE_TIER3` `toolName`, pinned by a contract test. A negative exclusion list would silently classify every future unrelated tool as a "fix". (5) **Weights live on a dedicated `partners.ai_impact_weights jsonb NULL` column, NOT `ai_agents.impactWeights`.** Ownership is the partner (one estimate model per MSP, not per agent policy), and the schema explicitly prefers dedicated columns over `partners.settings` sub-objects because settings cards replace sub-objects wholesale (`db/schema/orgs.ts:38-41`). Stored value is PARTIAL overrides merged onto frozen defaults; `null` means "defaults". There is no `partners` entry in `CORE_TENANT_EXPORT_POLICY`, so no export-policy line changes. (6) **UTC and complete-day semantics are explicit.** Every bucket is `(<source timestamp> AT TIME ZONE 'UTC')::date`; ranges are half-open `[from, to)`; the DTO's `through` is the last COMPLETE UTC day, and the current partial UTC day is never included. Cost is attributed by `ai_agent_runs.queued_at` (immutable, indexed, and the same column the daily agent-budget check uses at `runService.ts:983-993`), not `finished_at`. (7) **Bootstrap is 90 days, not 7.** The nightly pass rebuilds a trailing 7 complete days, but an org with no bucket at `through − 89` rebuilds the full 90 instead — otherwise the 30/90-day views stay permanently incomplete for any org that started producing work before the wave shipped. (8) **`promoteEligibleCount` is deferred to P2-6b.** It reads P2-5's `ai_agent_graduation`, which has not landed; the DTO carries the field as `null` from day one so adding it later is additive. "Verdict precision" is surfaced as **`positiveFeedback` — a positive feedback RATE over live (`superseded_by IS NULL`) verdicts with `feedback_at` in the window — and is never labelled precision or accuracy**: a thumbs-up is a supervision signal, not ground truth.
```
- [ ] **Step 2:** Replace the §5 row at line 190 with:
```markdown
| `ai_agent_impact_daily` | `id, org_id, day date, ten counters int NOT NULL DEFAULT 0 CHECK (>= 0), llm_cents int, rebuilt_at timestamptz NOT NULL`; unique `(org_id, day)` + index `(day, org_id)`; **no `est_seconds_saved` column** (read-time) | shape 1 | P2-6 — Amendment: counters renamed `fix_watches_held`/`fix_watches_recurred`; `narratives_delivered` added; export all `included`; org-merge `leave-for-erasure`. |
```
- [ ] **Step 3:** Replace the §5 row at line 191 with:
```markdown
| `partners.ai_impact_weights jsonb NULL` | column add → no export-policy entry (`partners` is not in `CORE_TENANT_EXPORT_POLICY`) | existing | P2-6 — Amendment: moved off `ai_agents.impactWeights`; partial overrides merged onto frozen defaults; write gated on `canManagePartnerWidePolicies`. |
```
- [ ] **Step 4:** Commit:
```bash
git add docs/superpowers/specs/ai-mcp/2026-08-28-ai-agents-phase2-intelligence-layer-design.md
git commit -m "docs(spec): P2-6 quorum amendments — read-time estimate, narratives counter, watch units, positive fix registry, partner weights column (#4193)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 1 (A1): Shared types, validators, PDF label

**Files:**
- Create: `packages/shared/src/types/aiAgentImpact.ts`, `packages/shared/src/validators/aiAgentImpact.ts`, `packages/shared/src/validators/aiAgentImpact.test.ts`, `packages/shared/src/types/aiAgentImpact.test.ts`
- Modify: `packages/shared/src/types/index.ts` (append `export * from './aiAgentImpact';` after line 786's `export * from './ticketTriage';`), `packages/shared/src/validators/index.ts` (same append pattern), `packages/shared/src/reportPdf/reportPdf.ts` (`REPORT_TYPE_LABELS`, lines 83-87)

**Interfaces (produced):**
```ts
// packages/shared/src/types/aiAgentImpact.ts
export const AI_AGENT_IMPACT_WINDOWS = [7, 30, 90] as const;
export type AiAgentImpactWindow = (typeof AI_AGENT_IMPACT_WINDOWS)[number];

/** Camel-case DTO keys, in the column order of `ai_agent_impact_daily`. */
export const AI_AGENT_IMPACT_COUNTER_KEYS = [
  'alertsJudged', 'noiseFlagged', 'suppressionsApplied', 'ticketsTriaged', 'draftsSent',
  'fixesProposed', 'fixesExecuted', 'fixWatchesHeld', 'fixWatchesRecurred', 'narrativesDelivered',
] as const;
export type AiAgentImpactCounterKey = (typeof AI_AGENT_IMPACT_COUNTER_KEYS)[number];
export type AiAgentImpactCounters = Record<AiAgentImpactCounterKey, number>;

/** Seconds of human time one outcome is credited with. Six priced outcomes; the
 *  other four counters (suppressions, proposals, both watch states) are reported
 *  but deliberately unpriced — they are funnel/quality signal, not saved time. */
export interface ImpactWeights {
  alertJudged: number;
  noiseFlagged: number;
  ticketTriaged: number;
  draftSent: number;
  fixExecuted: number;
  narrativeDelivered: number;
}
export type ImpactWeightOverrides = Partial<ImpactWeights>;
export const IMPACT_WEIGHT_KEYS = [
  'alertJudged', 'noiseFlagged', 'ticketTriaged', 'draftSent', 'fixExecuted', 'narrativeDelivered',
] as const;
export const IMPACT_WEIGHT_MAX_SECONDS = 86_400;
export const DEFAULT_IMPACT_WEIGHTS: Readonly<ImpactWeights> = Object.freeze({
  alertJudged: 90, noiseFlagged: 240, ticketTriaged: 360, draftSent: 300,
  fixExecuted: 900, narrativeDelivered: 1800,
});

/** Merge a stored partial override object onto the frozen defaults. Tolerates
 *  null/undefined/garbage (an operator-editable jsonb column): any key that is
 *  not a finite integer in [0, IMPACT_WEIGHT_MAX_SECONDS] falls back to its default. */
export function resolveImpactWeights(stored: unknown): ImpactWeights;

/** The stored overrides, normalized: unknown keys dropped, out-of-range dropped.
 *  Returns null when nothing valid survives (equivalent to "no overrides"). */
export function normalizeImpactWeightOverrides(stored: unknown): ImpactWeightOverrides | null;

/** Read-time estimate. Only the six priced counters contribute. */
export function estimateSecondsSaved(counters: AiAgentImpactCounters, weights: ImpactWeights): number;

export const AI_AGENT_IMPACT_DTO_SCHEMA_VERSION = 1 as const;
export const AI_AGENT_IMPACT_BY_ORG_LIMIT = 50;
export const AI_AGENT_IMPACT_REBUILD_MAX_ORGS = 200;
export const AI_AGENT_IMPACT_REBUILD_DAYS = 90;

export interface AiAgentImpactTotalsDto extends AiAgentImpactCounters {
  estSecondsSaved: number;
  llmCents: number;
}
export interface AiAgentImpactBucketDto extends AiAgentImpactTotalsDto {
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
}
export interface AiAgentImpactOrgRowDto extends AiAgentImpactTotalsDto {
  orgId: string;
  orgName: string;
}
export interface AiAgentImpactDto {
  schemaVersion: typeof AI_AGENT_IMPACT_DTO_SCHEMA_VERSION;
  window: AiAgentImpactWindow;
  /** Last COMPLETE UTC day covered, `YYYY-MM-DD`. Never the current UTC day. */
  through: string;
  /** MIN(rebuilt_at) over the included buckets — the conservative freshness
   *  answer. ISO-8601, or null when the window holds no rows at all. */
  rebuiltAt: string | null;
  totals: AiAgentImpactTotalsDto;
  series: AiAgentImpactBucketDto[];
  /** Partner scope only; empty for organization and system scope. Top
   *  AI_AGENT_IMPACT_BY_ORG_LIMIT rows by estSecondsSaved, descending. */
  byOrg: AiAgentImpactOrgRowDto[];
  byOrgTruncated: boolean;
  /** LIVE verdict rows (`superseded_by IS NULL`) whose `feedback_at` falls in
   *  the window. `rate = up / (up + down)`, null when both are zero. Labelled
   *  "positive feedback rate" in every surface — never "precision". */
  positiveFeedback: { up: number; down: number; rate: number | null };
  /** P2-6b, after P2-5's ai_agent_graduation lands. Always null in P2-6. */
  promoteEligibleCount: number | null;
  weights: { effective: ImpactWeights; overrides: ImpactWeightOverrides | null };
  canEditWeights: boolean;
}
```
```ts
// packages/shared/src/validators/aiAgentImpact.ts
import { z } from 'zod';
/** Partial overrides. Strict: an unknown key is a client bug, not a silent no-op. */
export const impactWeightsSchema: z.ZodType<ImpactWeightOverrides>;   // z.object({ alertJudged: z.number().int().min(0).max(86400).optional(), … }).strict()
/** Query for GET /ai/agents/impact. `orgId` is optional because fetchWithAuth
 *  auto-injects `?orgId=` whenever the web org switcher has one org selected. */
export const impactQuerySchema: z.ZodType<{ window: AiAgentImpactWindow; orgId?: string }>;
/** Query for POST /ai/agents/impact/rebuild — same optional orgId, no window. */
export const impactRebuildQuerySchema: z.ZodType<{ orgId?: string }>;
```

- [ ] **Step 1:** Write the failing tests.
```ts
// packages/shared/src/types/aiAgentImpact.test.ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMPACT_WEIGHTS, AI_AGENT_IMPACT_COUNTER_KEYS,
  resolveImpactWeights, normalizeImpactWeightOverrides, estimateSecondsSaved,
  type AiAgentImpactCounters,
} from './aiAgentImpact';

const zeroCounters = (): AiAgentImpactCounters =>
  Object.fromEntries(AI_AGENT_IMPACT_COUNTER_KEYS.map((k) => [k, 0])) as AiAgentImpactCounters;

describe('resolveImpactWeights', () => {
  it('returns the defaults for null, undefined and a non-object', () => {
    for (const stored of [null, undefined, 42, 'x', []]) {
      expect(resolveImpactWeights(stored)).toEqual(DEFAULT_IMPACT_WEIGHTS);
    }
  });
  it('merges a PARTIAL override onto the defaults', () => {
    expect(resolveImpactWeights({ fixExecuted: 1200 })).toEqual({
      ...DEFAULT_IMPACT_WEIGHTS, fixExecuted: 1200,
    });
  });
  it('accepts an explicit 0 (a partner may price an outcome at nothing)', () => {
    expect(resolveImpactWeights({ noiseFlagged: 0 }).noiseFlagged).toBe(0);
  });
  it('drops out-of-range, non-integer, negative and unknown keys', () => {
    expect(resolveImpactWeights({
      alertJudged: -1, noiseFlagged: 86_401, ticketTriaged: 1.5, bogus: 10,
    })).toEqual(DEFAULT_IMPACT_WEIGHTS);
  });
});

describe('normalizeImpactWeightOverrides', () => {
  it('returns null when nothing valid survives', () => {
    expect(normalizeImpactWeightOverrides({ bogus: 1 })).toBeNull();
    expect(normalizeImpactWeightOverrides(null)).toBeNull();
  });
  it('keeps only the valid subset', () => {
    expect(normalizeImpactWeightOverrides({ draftSent: 120, bogus: 1, fixExecuted: -3 }))
      .toEqual({ draftSent: 120 });
  });
});

describe('estimateSecondsSaved', () => {
  it('prices exactly the six priced counters and ignores the other four', () => {
    // Non-uniform on purpose: a wrong-counter bug must change the total.
    const counters: AiAgentImpactCounters = {
      ...zeroCounters(),
      alertsJudged: 2, noiseFlagged: 3, ticketsTriaged: 5, draftsSent: 7,
      fixesExecuted: 11, narrativesDelivered: 13,
      suppressionsApplied: 1000, fixesProposed: 1000,
      fixWatchesHeld: 1000, fixWatchesRecurred: 1000,
    };
    expect(estimateSecondsSaved(counters, DEFAULT_IMPACT_WEIGHTS)).toBe(
      2 * 90 + 3 * 240 + 5 * 360 + 7 * 300 + 11 * 900 + 13 * 1800,
    );
  });
  it('is 0 for an all-zero day', () => {
    expect(estimateSecondsSaved(zeroCounters(), DEFAULT_IMPACT_WEIGHTS)).toBe(0);
  });
});
```
```ts
// packages/shared/src/validators/aiAgentImpact.test.ts — assertions:
//  - impactWeightsSchema accepts {} and { fixExecuted: 900 }
//  - rejects { fixExecuted: 86401 }, { fixExecuted: -1 }, { fixExecuted: 1.5 }, { bogus: 1 } (strict)
//  - impactQuerySchema coerces window '7'|'30'|'90' to the numbers 7|30|90 and defaults to 30
//  - impactQuerySchema rejects window '1' and window '365'
//  - impactQuerySchema accepts a uuid orgId and rejects 'not-a-uuid'
```
- [ ] **Step 2:** Run: `cd packages/shared && npx vitest run src/types/aiAgentImpact.test.ts src/validators/aiAgentImpact.test.ts` — FAIL (modules missing).
- [ ] **Step 3:** Implement `types/aiAgentImpact.ts` and `validators/aiAgentImpact.ts` exactly as the Interfaces block above; append both barrel exports; add `ai_agent_impact: 'AI Agent Impact'` to `REPORT_TYPE_LABELS` in `packages/shared/src/reportPdf/reportPdf.ts` (the map at lines 83-87 — `reportTypeLabel()` at :89 is what the generic renderer titles the page with).
- [ ] **Step 4:** Run: `cd packages/shared && npx vitest run src/types/aiAgentImpact.test.ts src/validators/aiAgentImpact.test.ts` — PASS (check the reported test count is 15+, not 0). Then `cd packages/shared && npx tsc --noEmit -p tsconfig.json` and `pnpm lint`.
- [ ] **Step 5:** Commit:
```bash
git add packages/shared/src/types/aiAgentImpact.ts packages/shared/src/types/aiAgentImpact.test.ts packages/shared/src/validators/aiAgentImpact.ts packages/shared/src/validators/aiAgentImpact.test.ts packages/shared/src/types/index.ts packages/shared/src/validators/index.ts packages/shared/src/reportPdf/reportPdf.ts
git commit -m "feat(shared): P2-6 impact types — counters, weights defaults + resolver, read-time estimate, DTO v1 (#4193)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 2 (A2): Migration, Drizzle schema, three registries

**Files:**
- Create: `apps/api/migrations/2026-09-30-ai-agents-impact.sql`, `apps/api/src/db/schema/aiAgentImpactDaily.ts`
- Modify: `apps/api/src/db/schema/orgs.ts` (add `aiImpactWeights` to `partners`, after `autoEmailInvoiceOnQuoteAccept` at line 41), `apps/api/src/db/schema/index.ts` (append `export * from './aiAgentImpactDaily';` beside the other `aiAgent*` exports at lines 57-62), `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`), `apps/api/src/services/tenantExportPolicyRegistry.ts` (`CORE_TENANT_EXPORT_POLICY`), `apps/api/src/services/orgMergeRegistry.ts`

**Interfaces (produced):**
```ts
// apps/api/src/db/schema/aiAgentImpactDaily.ts
export const aiAgentImpactDaily = pgTable('ai_agent_impact_daily', { … });
export type AiAgentImpactDailyRow = typeof aiAgentImpactDaily.$inferSelect;
export type NewAiAgentImpactDailyRow = typeof aiAgentImpactDaily.$inferInsert;
// apps/api/src/db/schema/orgs.ts
//   partners.aiImpactWeights: jsonb('ai_impact_weights').$type<ImpactWeightOverrides | null>()
```

**Migration contents** (idempotent, in this order):
```sql
-- Phase 2 wave P2-6 (#4187 / #4193): AI agent value accounting.
--   1. ai_agent_impact_daily (Shape 1, forced RLS): ten per-(org, UTC-day)
--      counters + llm_cents, rebuilt idempotently by aiAgentImpactRollup.
--      est_seconds_saved is deliberately NOT a column — it is computed at read
--      time from these counters and the partner's effective weights, so
--      re-pricing a weight re-prices history instead of forking it.
--   2. partners.ai_impact_weights: PARTIAL overrides onto the frozen defaults
--      in @breeze/shared (DEFAULT_IMPACT_WEIGHTS); NULL means "defaults".
--      A dedicated column rather than a partners.settings sub-object, per the
--      schema's own preference note (db/schema/orgs.ts:38-41) — settings cards
--      replace sub-objects wholesale and would silently drop the weights.
--   3. Source indexes for the eight bounded scans the rollup performs.
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file).

-- 1. ai_agent_impact_daily --------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_agent_impact_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- UTC calendar day. Every writer buckets with
  -- `(<source timestamp> AT TIME ZONE 'UTC')::date`; never date_trunc, which
  -- follows the session timezone a self-hoster can change.
  day date NOT NULL,
  alerts_judged        integer NOT NULL DEFAULT 0 CONSTRAINT ai_agent_impact_daily_alerts_judged_chk        CHECK (alerts_judged >= 0),
  noise_flagged        integer NOT NULL DEFAULT 0 CONSTRAINT ai_agent_impact_daily_noise_flagged_chk        CHECK (noise_flagged >= 0),
  suppressions_applied integer NOT NULL DEFAULT 0 CONSTRAINT ai_agent_impact_daily_suppressions_chk         CHECK (suppressions_applied >= 0),
  tickets_triaged      integer NOT NULL DEFAULT 0 CONSTRAINT ai_agent_impact_daily_tickets_triaged_chk      CHECK (tickets_triaged >= 0),
  drafts_sent          integer NOT NULL DEFAULT 0 CONSTRAINT ai_agent_impact_daily_drafts_sent_chk          CHECK (drafts_sent >= 0),
  fixes_proposed       integer NOT NULL DEFAULT 0 CONSTRAINT ai_agent_impact_daily_fixes_proposed_chk       CHECK (fixes_proposed >= 0),
  fixes_executed       integer NOT NULL DEFAULT 0 CONSTRAINT ai_agent_impact_daily_fixes_executed_chk       CHECK (fixes_executed >= 0),
  fix_watches_held     integer NOT NULL DEFAULT 0 CONSTRAINT ai_agent_impact_daily_watches_held_chk         CHECK (fix_watches_held >= 0),
  fix_watches_recurred integer NOT NULL DEFAULT 0 CONSTRAINT ai_agent_impact_daily_watches_recurred_chk     CHECK (fix_watches_recurred >= 0),
  narratives_delivered integer NOT NULL DEFAULT 0 CONSTRAINT ai_agent_impact_daily_narratives_chk           CHECK (narratives_delivered >= 0),
  llm_cents            integer NOT NULL DEFAULT 0 CONSTRAINT ai_agent_impact_daily_llm_cents_chk            CHECK (llm_cents >= 0),
  rebuilt_at timestamptz NOT NULL DEFAULT now()
);

-- ON CONFLICT (org_id, day) target for the rollup's single UPSERT.
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_impact_daily_org_day_uq
  ON ai_agent_impact_daily (org_id, day);
-- Partner-window scan: a 90-day partner read filters on `day` FIRST and then
-- intersects with the caller's accessible org list. Leading with org_id (the
-- unique above) makes that an N-org index scan; leading with day makes it one
-- range. Both are kept — verify with EXPLAIN (ANALYZE, BUFFERS) on a seeded DB.
CREATE INDEX IF NOT EXISTS ai_agent_impact_daily_day_org_idx
  ON ai_agent_impact_daily (day, org_id);

ALTER TABLE ai_agent_impact_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_impact_daily FORCE ROW LEVEL SECURITY;

-- RLS: direct NOT NULL org_id (Shape 1) — the canonical single-clause idiom.
-- breeze_has_org_access() already returns TRUE for system scope internally
-- (public.breeze_has_org_access, 0001-baseline.sql), so no separate system
-- branch is needed. Same shape as ticket_drafts
-- (2026-09-25-ai-agents-ticket-triage.sql) and action_intents.
DROP POLICY IF EXISTS breeze_org_isolation_select ON ai_agent_impact_daily;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ai_agent_impact_daily;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ai_agent_impact_daily;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ai_agent_impact_daily;

CREATE POLICY breeze_org_isolation_select ON ai_agent_impact_daily
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ai_agent_impact_daily
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ai_agent_impact_daily
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ai_agent_impact_daily
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_agent_impact_daily TO breeze_app;

-- 2. partners.ai_impact_weights ---------------------------------------------
ALTER TABLE partners ADD COLUMN IF NOT EXISTS ai_impact_weights jsonb;
COMMENT ON COLUMN partners.ai_impact_weights IS
  'P2-6 (#4193). PARTIAL overrides of DEFAULT_IMPACT_WEIGHTS (@breeze/shared); NULL = defaults. Six keys, each an integer 0..86400 seconds. Never read directly — always through resolveImpactWeights().';

-- 3. Source indexes ---------------------------------------------------------
-- Every one of these bounds a rollup scan to (org, time-range). Each was
-- checked against the live schema first: ai_agent_runs already has
-- ai_agent_runs_org_queued_idx (org_id, queued_at DESC), which serves the
-- llm_cents pass, so no queued_at index is added here.

-- runs: serves tickets_triaged (profile='triage'), narratives_delivered
-- (profile='narrative') AND the two jsonb lateral arms (profile='full'). One
-- (org_id, profile, finished_at) index covers all four; a profile='full'-only
-- partial would leave triage and narrative unindexed.
CREATE INDEX IF NOT EXISTS ai_agent_runs_org_profile_finished_idx
  ON ai_agent_runs (org_id, profile, finished_at)
  WHERE finished_at IS NOT NULL;

-- verdicts: ai_alert_verdicts_latest_idx is PARTIAL on superseded_by IS NULL,
-- so it cannot serve the "every persisted verdict" count.
CREATE INDEX IF NOT EXISTS ai_alert_verdicts_org_created_idx
  ON ai_alert_verdicts (org_id, created_at);
CREATE INDEX IF NOT EXISTS ai_alert_verdicts_org_feedback_idx
  ON ai_alert_verdicts (org_id, feedback_at)
  WHERE feedback_at IS NOT NULL;

-- intents: action_intents_org_status_idx is (org_id, status, expires_at) —
-- neither created_at nor executed_at is covered.
CREATE INDEX IF NOT EXISTS action_intents_org_created_idx
  ON action_intents (org_id, created_at);
CREATE INDEX IF NOT EXISTS action_intents_org_executed_idx
  ON action_intents (org_id, executed_at)
  WHERE executed_at IS NOT NULL;

-- fix watches: existing indexes are (org_id, created_at DESC) and (state, due_at).
CREATE INDEX IF NOT EXISTS ai_agent_fix_watches_org_evaluated_idx
  ON ai_agent_fix_watches (org_id, evaluated_at)
  WHERE evaluated_at IS NOT NULL;

-- ticket drafts: existing indexes are (org_id), (ticket_id) and the active
-- partial unique.
CREATE INDEX IF NOT EXISTS ticket_drafts_org_consumed_idx
  ON ticket_drafts (org_id, consumed_at)
  WHERE consumed_at IS NOT NULL;
```

**Registry edits (mechanical — `grep -rn 'ai_agent_impact_daily' apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts` must return three hits when done):**
- `tenantCascade.ts` `CORE_ORG_CASCADE_DELETE_ORDER`: insert `'ai_agent_impact_daily',` between `'ai_agent_fix_watches',` and `'ai_agent_runs',` (verified `localeCompare` position). Add the one-line comment: *"P2-6 (#4193): derived daily rollup. Its ONLY FK is org_id → organizations ON DELETE CASCADE, so it has no child-before-parent constraint of its own and `topologicalCascadeOrder()`'s runtime pg_constraint read orders the real DELETE."*
- `tenantExportPolicyRegistry.ts`: add, in the same alphabetical position, `"ai_agent_impact_daily": tablePolicy("org_id", {"included":["id","org_id","day","alerts_judged","noise_flagged","suppressions_applied","tickets_triaged","drafts_sent","fixes_proposed","fixes_executed","fix_watches_held","fix_watches_recurred","narratives_delivered","llm_cents","rebuilt_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),` — every column is a counter, an id or a date; no jsonb/bytea, no `SUSPICIOUS_NAME_PARTS` hit.
- `orgMergeRegistry.ts`: `ai_agent_impact_daily: { kind: 'leave-for-erasure', note: 'derived per-org daily rollup of runs/verdicts/watches that all themselves stay with the loser org (ai_agent_runs disposition) — repointing would double-count the survivor and nothing can regenerate under it; rows die with the loser shell' },` placed beside `ai_agent_fix_watches`.

- [ ] **Step 1:** Write the failing schema test `apps/api/src/db/schema/aiAgentImpactDaily.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { AI_AGENT_IMPACT_COUNTER_KEYS } from '@breeze/shared';
import { aiAgentImpactDaily } from './aiAgentImpactDaily';

describe('ai_agent_impact_daily schema', () => {
  const cfg = getTableConfig(aiAgentImpactDaily);
  it('is named ai_agent_impact_daily with a NOT NULL org_id and day', () => {
    expect(cfg.name).toBe('ai_agent_impact_daily');
    for (const name of ['org_id', 'day', 'rebuilt_at']) {
      expect(cfg.columns.find((c) => c.name === name)?.notNull, name).toBe(true);
    }
  });
  it('carries exactly the ten shared counter keys plus llm_cents, and NO est_seconds_saved', () => {
    const snake = (k: string) => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
    const columnNames = new Set(cfg.columns.map((c) => c.name));
    for (const key of AI_AGENT_IMPACT_COUNTER_KEYS) {
      expect(columnNames.has(snake(key)), key).toBe(true);
    }
    expect(columnNames.has('llm_cents')).toBe(true);
    expect(columnNames.has('est_seconds_saved')).toBe(false); // read-time, never stored
  });
});
```
- [ ] **Step 2:** Run: `cd apps/api && npx vitest run src/db/schema/aiAgentImpactDaily.test.ts` — FAIL (module missing).
- [ ] **Step 3:** Write the migration, the Drizzle table (`id/orgId/day/<ten integer counters>/llmCents/rebuiltAt`, `unique('ai_agent_impact_daily_org_day_uq').on(t.orgId, t.day)` + `index('ai_agent_impact_daily_day_org_idx').on(t.day, t.orgId)`), add `aiImpactWeights: jsonb('ai_impact_weights').$type<ImpactWeightOverrides | null>()` to `partners`, append the schema barrel export, and make the three registry edits.
- [ ] **Step 4:** Run: `cd apps/api && npx vitest run src/db/schema/aiAgentImpactDaily.test.ts src/db/autoMigrate.test.ts` — PASS. Apply the migration twice against a local DB and confirm the second run is a clean no-op:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && psql "$DATABASE_URL" -f apps/api/migrations/2026-09-30-ai-agents-impact.sql && pnpm db:check-drift
```
- [ ] **Step 5:** Commit:
```bash
git add apps/api/migrations/2026-09-30-ai-agents-impact.sql apps/api/src/db/schema/aiAgentImpactDaily.ts apps/api/src/db/schema/aiAgentImpactDaily.test.ts apps/api/src/db/schema/orgs.ts apps/api/src/db/schema/index.ts apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts
git commit -m "feat(api): P2-6 ai_agent_impact_daily + partners.ai_impact_weights + source indexes, cascade/export/merge registered (#4193)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 3 (A3): `IMPACT_FIX_TOOLS` frozen positive registry

**Files:**
- Create: `apps/api/src/services/aiAgents/impactFixTools.ts`, `apps/api/src/services/aiAgents/impactFixTools.contract.test.ts`

**Interfaces:**
- Consumes: `ACT_ELIGIBLE_TOOL_NAMES` from `apps/api/src/services/aiAgents/actManifest.ts:279-281`; `POLICY_DECIDABLE_TIER3` from `apps/api/src/services/actionIntents/policyDecidable.ts:84`.
- Produces:
```ts
/** FROZEN LITERAL, sorted. The set of MCP tool names whose agent-originated
 *  intents / proposals count as a "fix" in the impact rollup. Positive by
 *  construction: a negative exclusion list would classify every future
 *  unrelated tool as a fix the day it is added. Pinned by
 *  impactFixTools.contract.test.ts to ACT_ELIGIBLE_TOOL_NAMES ∪ every
 *  POLICY_DECIDABLE_TIER3 toolName — grow it only when that union grows. */
export const IMPACT_FIX_TOOLS: readonly string[];
/** The same value as a Postgres text[] literal parameter for the rollup SQL. */
export function impactFixToolsArray(): string[];
```
Value (verified against both sources at plan time, 7 entries):
```ts
export const IMPACT_FIX_TOOLS: readonly string[] = Object.freeze([
  'disk_cleanup',
  'execute_playbook',
  'manage_scheduled_tasks',
  'manage_services',
  'manage_startup_items',
  'run_script',
  'security_scan',
]);
```

- [ ] **Step 1:** Write the failing contract test:
```ts
import { describe, expect, it } from 'vitest';
import { ACT_ELIGIBLE_TOOL_NAMES } from './actManifest';
import { POLICY_DECIDABLE_TIER3 } from '../actionIntents/policyDecidable';
import { IMPACT_FIX_TOOLS } from './impactFixTools';

describe('IMPACT_FIX_TOOLS is the pinned union of the two closed registries', () => {
  const derived = [...new Set([
    ...ACT_ELIGIBLE_TOOL_NAMES,
    ...POLICY_DECIDABLE_TIER3.map((e) => e.toolName),
  ])].sort();

  it('equals ACT_ELIGIBLE_TOOL_NAMES union POLICY_DECIDABLE_TIER3 tool names', () => {
    expect(
      [...IMPACT_FIX_TOOLS],
      'A manifest or policy-decidable tool changed. Update the IMPACT_FIX_TOOLS '
      + 'literal deliberately — a new remediation tool must be a conscious '
      + 'addition to what counts as customer value, not a silent one.',
    ).toEqual(derived);
  });

  it('excludes the remediation_suggestion sentinel (never a real dispatched tool name)', () => {
    expect(IMPACT_FIX_TOOLS).not.toContain('remediation_suggestion');
  });

  it('excludes the non-remediation agent tools, so a suppression is never a fix', () => {
    for (const tool of ['manage_alerts', 'manage_tickets', 'manage_ai_agents']) {
      expect(IMPACT_FIX_TOOLS, tool).not.toContain(tool);
    }
  });

  it('is frozen and sorted', () => {
    expect(Object.isFrozen(IMPACT_FIX_TOOLS)).toBe(true);
    expect([...IMPACT_FIX_TOOLS]).toEqual([...IMPACT_FIX_TOOLS].sort());
  });
});
```
- [ ] **Step 2:** Run: `cd apps/api && npx vitest run src/services/aiAgents/impactFixTools.contract.test.ts` — FAIL (module missing).
- [ ] **Step 3:** Implement `impactFixTools.ts` with the frozen literal above and `impactFixToolsArray()` returning `[...IMPACT_FIX_TOOLS]`. The module docstring must state why `remediation_suggestion` is absent: `ACT_ELIGIBLE_TOOL_NAMES` already filters the sentinel (`actManifest.ts:269-281`), it is never a registered MCP tool, so it can never appear as an `action_intents.action_name` or an `outcome.proposedActions[].tool`.
- [ ] **Step 4:** Run: `cd apps/api && npx vitest run src/services/aiAgents/impactFixTools.contract.test.ts` — PASS (4 tests).
- [ ] **Step 5:** Commit:
```bash
git add apps/api/src/services/aiAgents/impactFixTools.ts apps/api/src/services/aiAgents/impactFixTools.contract.test.ts
git commit -m "feat(api): P2-6 IMPACT_FIX_TOOLS frozen positive registry pinned to act manifest + policy-decidable union (#4193)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 4 (A4): `impactRollup.ts` — the rebuild service

**Files:**
- Create: `apps/api/src/services/aiAgents/impactRollup.ts`, `apps/api/src/services/aiAgents/impactRollup.test.ts`

**Interfaces:**
- Consumes: `db`, `runOutsideDbContext`, `withSystemDbAccessContext` from `apps/api/src/db/index.ts`; `IMPACT_FIX_TOOLS` (A3); `AI_AGENT_IMPACT_REBUILD_DAYS` from `@breeze/shared` (A1).
- Produces:
```ts
/** `YYYY-MM-DD` for a UTC calendar day. */
export type UtcDay = string;
/** The last COMPLETE UTC day (today − 1). Never returns the current UTC day. */
export function lastCompleteUtcDay(now?: Date): UtcDay;
/** `day` shifted by `deltaDays` in the UTC calendar. */
export function shiftUtcDay(day: UtcDay, deltaDays: number): UtcDay;
/** Inclusive day count between two UtcDays. */
export function utcDaySpan(fromDay: UtcDay, toDay: UtcDay): number;

export interface ImpactRebuildResult { orgId: string; fromDay: UtcDay; toDay: UtcDay; days: number }

/**
 * ONE idempotent `INSERT … SELECT … ON CONFLICT DO UPDATE` over a
 * generate_series day grid for [fromDay, toDay] inclusive. Emits a ZERO row for
 * every day with no source facts, so a removed or reclassified fact cannot
 * leave a stale nonzero bucket behind.
 *
 * Runs in its own short-lived labeled system context preceded by
 * `runOutsideDbContext` (services/metricRollups.ts:140-180 pattern). Callers
 * MUST NOT wrap this in their own context — the escape defeats an outer wrap
 * and merely pins a second idle-in-transaction connection.
 */
export function rebuildOrgImpactRange(orgId: string, fromDay: UtcDay, toDay: UtcDay): Promise<ImpactRebuildResult>;

/**
 * Orgs with ANY impact-relevant fact in [fromDay, toDay]. Unions EVERY source
 * timestamp — runs.queued_at, runs.finished_at, verdicts.created_at,
 * intents.created_at, intents.executed_at, watches.evaluated_at,
 * drafts.consumed_at — because an org whose only activity in the window was a
 * consumed draft or an executed intent has no run row in it at all.
 */
export function findImpactSourceOrgIds(fromDay: UtcDay, toDay: UtcDay): Promise<string[]>;

/** True when the org has no bucket at `through − (AI_AGENT_IMPACT_REBUILD_DAYS - 1)`. */
export function needsImpactBootstrap(orgId: string, through: UtcDay): Promise<boolean>;
```

**The rebuild statement** (write it verbatim; `${orgId}`, `${fromDay}`, `${toDay}`, `${fixTools}` are Drizzle `sql` parameters — note there is deliberately NO `bounds` CTE, see Global Constraints):
```sql
WITH days AS (
  SELECT d::date AS day
  FROM generate_series(${fromDay}::date, ${toDay}::date, interval '1 day') AS d
),
verdicts AS (
  SELECT (v.created_at AT TIME ZONE 'UTC')::date AS day,
         count(*)::int AS alerts_judged,
         count(*) FILTER (WHERE v.classification IN
           ('transient_self_healed', 'recurring_pattern', 'duplicate_of_group'))::int AS noise_flagged
  FROM ai_alert_verdicts v
  WHERE v.org_id = ${orgId}::uuid
    AND v.created_at >= (${fromDay}::date) AT TIME ZONE 'UTC'
    AND v.created_at <  (${toDay}::date + 1) AT TIME ZONE 'UTC'
  GROUP BY 1
),
suppressions AS (
  SELECT (i.executed_at AT TIME ZONE 'UTC')::date AS day, count(*)::int AS suppressions_applied
  FROM action_intents i
  WHERE i.org_id = ${orgId}::uuid
    AND i.origin_principal_kind = 'ai_agent'
    AND i.action_name = 'manage_alerts'
    AND i.arguments->>'action' = 'suppress'
    AND i.status = 'completed'
    AND i.executed_at >= (${fromDay}::date) AT TIME ZONE 'UTC'
    AND i.executed_at <  (${toDay}::date + 1) AT TIME ZONE 'UTC'
  GROUP BY 1
),
triage AS (
  SELECT (r.finished_at AT TIME ZONE 'UTC')::date AS day, count(*)::int AS tickets_triaged
  FROM ai_agent_runs r
  WHERE r.org_id = ${orgId}::uuid
    AND r.profile = 'triage'
    AND r.status IN ('completed', 'awaiting_approval')
    AND r.error_code IS NULL
    AND r.outcome ? 'ticketProposal'
    AND r.finished_at >= (${fromDay}::date) AT TIME ZONE 'UTC'
    AND r.finished_at <  (${toDay}::date + 1) AT TIME ZONE 'UTC'
  GROUP BY 1
),
drafts AS (
  SELECT (d.consumed_at AT TIME ZONE 'UTC')::date AS day, count(*)::int AS drafts_sent
  FROM ticket_drafts d
  WHERE d.org_id = ${orgId}::uuid
    AND d.state = 'consumed'
    AND d.consumed_at >= (${fromDay}::date) AT TIME ZONE 'UTC'
    AND d.consumed_at <  (${toDay}::date + 1) AT TIME ZONE 'UTC'
  GROUP BY 1
),
proposed AS (
  SELECT day, count(*)::int AS fixes_proposed FROM (
    -- Arm (a): Tier-3 proposals, which DO mint an intent.
    SELECT (i.created_at AT TIME ZONE 'UTC')::date AS day
    FROM action_intents i
    WHERE i.org_id = ${orgId}::uuid
      AND i.origin_principal_kind = 'ai_agent'
      AND i.action_name = ANY(${fixTools}::text[])
      AND i.created_at >= (${fromDay}::date) AT TIME ZONE 'UTC'
      AND i.created_at <  (${toDay}::date + 1) AT TIME ZONE 'UTC'
    UNION ALL
    -- Arm (b): ordinary Tier-2 proposals, which exist ONLY in the run outcome
    -- (runLoop.ts:798-860 — recordProposal creates an intent for tier 3 only).
    -- `intentId IS NULL` is what keeps the two arms disjoint.
    SELECT (r.finished_at AT TIME ZONE 'UTC')::date AS day
    FROM ai_agent_runs r
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(r.outcome->'proposedActions') = 'array'
           THEN r.outcome->'proposedActions' ELSE '[]'::jsonb END
    ) AS p(item)
    WHERE r.org_id = ${orgId}::uuid
      AND r.profile = 'full'
      AND r.finished_at >= (${fromDay}::date) AT TIME ZONE 'UTC'
      AND r.finished_at <  (${toDay}::date + 1) AT TIME ZONE 'UTC'
      AND p.item->>'intentId' IS NULL
      AND p.item->>'tool' = ANY(${fixTools}::text[])
  ) s GROUP BY 1
),
executed AS (
  SELECT day, count(*)::int AS fixes_executed FROM (
    -- Arm (a): released intents.
    SELECT (i.executed_at AT TIME ZONE 'UTC')::date AS day
    FROM action_intents i
    WHERE i.org_id = ${orgId}::uuid
      AND i.origin_principal_kind = 'ai_agent'
      AND i.action_name = ANY(${fixTools}::text[])
      AND i.status = 'completed'
      AND i.executed_at >= (${fromDay}::date) AT TIME ZONE 'UTC'
      AND i.executed_at <  (${toDay}::date + 1) AT TIME ZONE 'UTC'
    UNION ALL
    -- Arm (b): act-mode direct executions (a separate execution path — no
    -- intent is ever created for these). A verify-FAILED execution earns no
    -- value: computeRunVerdict (runLoop.ts:1299-1312) only treats
    -- succeeded+passed as clean, and this predicate is the accounting mirror
    -- of that rule.
    SELECT (r.finished_at AT TIME ZONE 'UTC')::date AS day
    FROM ai_agent_runs r
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(r.outcome->'executedActions') = 'array'
           THEN r.outcome->'executedActions' ELSE '[]'::jsonb END
    ) AS a(item)
    WHERE r.org_id = ${orgId}::uuid
      AND r.profile = 'full'
      AND r.mode_at_start = 'act'
      AND r.finished_at >= (${fromDay}::date) AT TIME ZONE 'UTC'
      AND r.finished_at <  (${toDay}::date + 1) AT TIME ZONE 'UTC'
      AND a.item->>'actOpKey' IS NOT NULL
      AND a.item->>'execution' = 'succeeded'
      AND COALESCE(a.item->>'verification', 'skipped') <> 'failed'
  ) s GROUP BY 1
),
watches AS (
  SELECT (w.evaluated_at AT TIME ZONE 'UTC')::date AS day,
         count(*) FILTER (WHERE w.state = 'held_qualified')::int AS fix_watches_held,
         count(*) FILTER (WHERE w.state = 'recurred')::int      AS fix_watches_recurred
  FROM ai_agent_fix_watches w
  WHERE w.org_id = ${orgId}::uuid
    AND w.evaluated_at >= (${fromDay}::date) AT TIME ZONE 'UTC'
    AND w.evaluated_at <  (${toDay}::date + 1) AT TIME ZONE 'UTC'
  GROUP BY 1
),
narratives AS (
  SELECT (r.finished_at AT TIME ZONE 'UTC')::date AS day, count(*)::int AS narratives_delivered
  FROM ai_agent_runs r
  WHERE r.org_id = ${orgId}::uuid
    AND r.profile = 'narrative'
    AND r.status = 'completed'
    AND r.report_run_id IS NOT NULL
    AND r.finished_at >= (${fromDay}::date) AT TIME ZONE 'UTC'
    AND r.finished_at <  (${toDay}::date + 1) AT TIME ZONE 'UTC'
  GROUP BY 1
),
cost AS (
  -- ALL profiles and statuses, attributed by the immutable queued_at (the same
  -- column runService.ts:983-993 uses for the daily agent budget).
  SELECT (r.queued_at AT TIME ZONE 'UTC')::date AS day,
         COALESCE(SUM(r.cost_cents), 0)::int AS llm_cents
  FROM ai_agent_runs r
  WHERE r.org_id = ${orgId}::uuid
    AND r.queued_at >= (${fromDay}::date) AT TIME ZONE 'UTC'
    AND r.queued_at <  (${toDay}::date + 1) AT TIME ZONE 'UTC'
  GROUP BY 1
)
INSERT INTO ai_agent_impact_daily (
  org_id, day, alerts_judged, noise_flagged, suppressions_applied, tickets_triaged,
  drafts_sent, fixes_proposed, fixes_executed, fix_watches_held, fix_watches_recurred,
  narratives_delivered, llm_cents, rebuilt_at
)
SELECT
  ${orgId}::uuid, days.day,
  COALESCE(v.alerts_judged, 0), COALESCE(v.noise_flagged, 0),
  COALESCE(s.suppressions_applied, 0), COALESCE(t.tickets_triaged, 0),
  COALESCE(dr.drafts_sent, 0), COALESCE(p.fixes_proposed, 0),
  COALESCE(e.fixes_executed, 0), COALESCE(w.fix_watches_held, 0),
  COALESCE(w.fix_watches_recurred, 0), COALESCE(n.narratives_delivered, 0),
  COALESCE(c.llm_cents, 0), now()
FROM days
LEFT JOIN verdicts     v  ON v.day  = days.day
LEFT JOIN suppressions s  ON s.day  = days.day
LEFT JOIN triage       t  ON t.day  = days.day
LEFT JOIN drafts       dr ON dr.day = days.day
LEFT JOIN proposed     p  ON p.day  = days.day
LEFT JOIN executed     e  ON e.day  = days.day
LEFT JOIN watches      w  ON w.day  = days.day
LEFT JOIN narratives   n  ON n.day  = days.day
LEFT JOIN cost         c  ON c.day  = days.day
ON CONFLICT (org_id, day) DO UPDATE SET
  alerts_judged        = EXCLUDED.alerts_judged,
  noise_flagged        = EXCLUDED.noise_flagged,
  suppressions_applied = EXCLUDED.suppressions_applied,
  tickets_triaged      = EXCLUDED.tickets_triaged,
  drafts_sent          = EXCLUDED.drafts_sent,
  fixes_proposed       = EXCLUDED.fixes_proposed,
  fixes_executed       = EXCLUDED.fixes_executed,
  fix_watches_held     = EXCLUDED.fix_watches_held,
  fix_watches_recurred = EXCLUDED.fix_watches_recurred,
  narratives_delivered = EXCLUDED.narratives_delivered,
  llm_cents            = EXCLUDED.llm_cents,
  rebuilt_at           = now()
```

**`findImpactSourceOrgIds` statement:**
```sql
SELECT DISTINCT org_id FROM (
  SELECT org_id FROM ai_agent_runs
   WHERE queued_at   >= (${fromDay}::date) AT TIME ZONE 'UTC' AND queued_at   < (${toDay}::date + 1) AT TIME ZONE 'UTC'
  UNION SELECT org_id FROM ai_agent_runs
   WHERE finished_at >= (${fromDay}::date) AT TIME ZONE 'UTC' AND finished_at < (${toDay}::date + 1) AT TIME ZONE 'UTC'
  UNION SELECT org_id FROM ai_alert_verdicts
   WHERE created_at  >= (${fromDay}::date) AT TIME ZONE 'UTC' AND created_at  < (${toDay}::date + 1) AT TIME ZONE 'UTC'
  UNION SELECT org_id FROM action_intents
   WHERE origin_principal_kind = 'ai_agent'
     AND created_at  >= (${fromDay}::date) AT TIME ZONE 'UTC' AND created_at  < (${toDay}::date + 1) AT TIME ZONE 'UTC'
  UNION SELECT org_id FROM action_intents
   WHERE origin_principal_kind = 'ai_agent'
     AND executed_at >= (${fromDay}::date) AT TIME ZONE 'UTC' AND executed_at < (${toDay}::date + 1) AT TIME ZONE 'UTC'
  UNION SELECT org_id FROM ai_agent_fix_watches
   WHERE evaluated_at >= (${fromDay}::date) AT TIME ZONE 'UTC' AND evaluated_at < (${toDay}::date + 1) AT TIME ZONE 'UTC'
  UNION SELECT org_id FROM ticket_drafts
   WHERE state = 'consumed'
     AND consumed_at >= (${fromDay}::date) AT TIME ZONE 'UTC' AND consumed_at < (${toDay}::date + 1) AT TIME ZONE 'UTC'
) src
```

- [ ] **Step 1:** Write failing unit tests in `impactRollup.test.ts` (mocked `db` — this file's real SQL is proven in A9 against live Postgres; the unit level proves the day math and the compiled statement's invariants):
  - `lastCompleteUtcDay(new Date('2026-09-01T00:05:00Z'))` → `'2026-08-31'`; `lastCompleteUtcDay(new Date('2026-01-01T23:59:59Z'))` → `'2025-12-31'` (year boundary); `lastCompleteUtcDay(new Date('2026-03-01T12:00:00Z'))` → `'2026-02-28'` (non-leap month boundary).
  - `shiftUtcDay('2026-03-01', -1)` → `'2026-02-28'`; `shiftUtcDay('2026-08-31', 1)` → `'2026-09-01'`.
  - `utcDaySpan('2026-08-25', '2026-08-31')` → `7`.
  - `rebuildOrgImpactRange` calls `runOutsideDbContext` and then `withSystemDbAccessContext` with a low-cardinality label (assert the label is the constant `'aiAgentImpactRollup.rebuild'`, NOT a per-org string).
  - The compiled statement (inspect `db.execute`'s captured `SQL` via `db.dialect.sqlToQuery` or the mock's recorded `queryChunks`) contains `generate_series`, `ON CONFLICT (org_id, day) DO UPDATE`, `AT TIME ZONE 'UTC'`, and does **not** contain the token `date_trunc`.
  - `rebuildOrgImpactRange` rejects an inverted range (`fromDay > toDay`) with a thrown `Error`, mirroring `normalizeRange` (`services/metricRollups.ts:130-138`).
- [ ] **Step 2:** Run: `cd apps/api && npx vitest run src/services/aiAgents/impactRollup.test.ts` — FAIL.
- [ ] **Step 3:** Implement `impactRollup.ts` with the two statements above, the day helpers, and the `inRollupDbContext(label, fn) = runOutsideDbContext(() => withSystemDbAccessContext(fn, label))` wrapper copied from `services/metricRollups.ts:174-181` (label REQUIRED, one per pass, never per org). Add the same module-header warning: callers must not wrap this function in their own DB context.
- [ ] **Step 4:** Run: `cd apps/api && npx vitest run src/services/aiAgents/impactRollup.test.ts` — PASS.
- [ ] **Step 5:** Commit:
```bash
git add apps/api/src/services/aiAgents/impactRollup.ts apps/api/src/services/aiAgents/impactRollup.test.ts
git commit -m "feat(api): P2-6 impact rollup service — zero-emitting UTC day grid upsert, all-source org discovery (#4193)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 5 (A5): The rollup worker, schedule slot, worker registry

**Files:**
- Create: `apps/api/src/jobs/aiAgentImpactRollup.ts`, `apps/api/src/jobs/aiAgentImpactRollup.test.ts`
- Modify: `apps/api/src/jobs/scheduleRegistry.ts` (`JOB_SCHEDULES` daily tier), `apps/api/src/services/workerRegistry.ts` (append one entry at the end of `WORKER_REGISTRY`, beside `aiAgentSweepScheduler`)

**Interfaces:**
- Consumes: `rebuildOrgImpactRange`, `findImpactSourceOrgIds`, `needsImpactBootstrap`, `lastCompleteUtcDay`, `shiftUtcDay` (A4); `AI_AGENT_IMPACT_REBUILD_DAYS` (A1); `getBullMQConnection` (`services/redis.ts`), `attachWorkerObservability` (`jobs/workerObservability.ts`), `jobSchedule` (`jobs/scheduleRegistry.ts`), `envFlag` (`config/env.ts`).
- Produces:
```ts
export const AI_AGENT_IMPACT_ROLLUP_QUEUE = 'ai-agent-impact-rollup';
/** Trailing complete-day window rebuilt every night for an already-bootstrapped org. */
export const IMPACT_NIGHTLY_TRAILING_DAYS = 7;

export type ImpactRollupJobData =
  | { type: 'scan'; queuedAt?: string }
  | { type: 'rebuild-org-range'; orgId: string; fromDay: string; toDay: string; queuedAt: string };

/** Deterministic — a second enqueue of the same (org, range) is a natural no-op
 *  while the first is waiting/delayed/active, which is what makes the manual
 *  Refresh safe to spam. */
export function buildImpactRollupJobId(orgId: string, fromDay: string, toDay: string): string; // `impact:${orgId}:${fromDay}:${toDay}`

export function getAiAgentImpactRollupQueue(): Queue<ImpactRollupJobData>;
export function processImpactScan(now?: Date): Promise<{ scanned: number; enqueued: number }>;
/** Used by POST /ai/agents/impact/rebuild. Returns how many jobs were added. */
export function enqueueImpactRollupForOrgs(orgIds: readonly string[], fromDay: string, toDay: string): Promise<number>;
export function createAiAgentImpactRollupWorker(): Worker<ImpactRollupJobData>;
export function initializeAiAgentImpactRollupWorker(): Promise<void>;
export function shutdownAiAgentImpactRollupWorker(): Promise<void>;
```

`processImpactScan(now)` logic, in order:
1. Producer gate: `if (!envFlag('BREEZE_AI_AGENTS_ENABLED', false)) return { scanned: 0, enqueued: 0 };` — read at CALL time, never a module-scope const (`jobs/aiAgentSweepScheduler.ts:247-252`).
2. `const through = lastCompleteUtcDay(now); const nightlyFrom = shiftUtcDay(through, -(IMPACT_NIGHTLY_TRAILING_DAYS - 1));`
3. `const orgIds = await findImpactSourceOrgIds(nightlyFrom, through);`
4. For each org: `const from = (await needsImpactBootstrap(orgId, through)) ? shiftUtcDay(through, -(AI_AGENT_IMPACT_REBUILD_DAYS - 1)) : nightlyFrom;`
5. `queue.addBulk` one `rebuild-org-range` job per org with `jobId: buildImpactRollupJobId(orgId, from, through)`, `removeOnComplete: { count: 100 }`, `removeOnFail: { count: 200 }`.
6. Enqueue OUTSIDE any DB context (a BullMQ add is a Redis round trip; holding a pooled Postgres connection across it is the pool-exhaustion trap `runService.ts` step 10 and `aiAgentSweepScheduler.ts` both call out).

Worker body: `if (job.data.type === 'scan') return processImpactScan();` else `return runOutsideDbContext(() => rebuildOrgImpactRange(data.orgId, data.fromDay, data.toDay));` — **no worker-level system context**, exactly like `jobs/metricRollups.ts:120-130`, because the service owns its own per-statement context and an outer wrap would only pin a second idle connection. `concurrency: 2`, `lockDuration: 300_000`.

Registration: `scheduleMetricRollupsScan`-shaped `scheduleImpactScan()` that removes any pre-existing `scan` repeatable by key first, then `queue.add('scan', { type: 'scan' }, { jobId: 'ai-agent-impact-rollup-scan', repeat: { pattern: jobSchedule('ai-agent-impact-rollup') }, … })`.

**Schedule slot:** add to the **daily tier** block of `JOB_SCHEDULES` (minutes ≡ 3 mod 5), in fire-time order beside `'ai-unattended-exposure-retention': '8 18 * * *'`:
```ts
  // P2-6 (#4193): nightly value-accounting rollup. Daily lane; hour 18 held
  // only minute 8 before this. Runs well after the day it summarises closed.
  'ai-agent-impact-rollup': '33 18 * * *',
```
(Verified free: no other coarse schedule fires at minute 33 of any hour, and no hourly job occupies minute 33.)

**Worker registry entry** (append at the very end of `WORKER_REGISTRY`, after `aiAgentSweepScheduler`, so the P2-5 rebase is a clean append):
```ts
  {
    // Phase 2 wave P2-6 (value accounting), task A5: nightly scan + per-org
    // impact rollup fan-out.
    //
    // `global`: its runtime import closure is `services/aiAgents/impactRollup.ts`
    // (db + schema + the frozen IMPACT_FIX_TOOLS literal) — it never reaches
    // `runService.createAndEnqueueAgentRun`, `routes/agentWs.ts` or
    // `services/agentCommandAwait.ts`. Do NOT copy this value by analogy:
    // `workerEntrypointClosure.contract.test.ts` is the mechanical authority
    // and must be run for this entry (see CLAUDE.md — never relitigate
    // placement by guessing).
    name: 'aiAgentImpactRollup',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/aiAgentImpactRollup');
      return { init: m.initializeAiAgentImpactRollupWorker, shutdown: m.shutdownAiAgentImpactRollupWorker };
    },
  },
```

- [ ] **Step 1:** Write failing tests in `aiAgentImpactRollup.test.ts` (mock `../services/aiAgents/impactRollup`, `../services/redis`, `bullmq`):
  - the producer gate: with `BREEZE_AI_AGENTS_ENABLED` unset, `processImpactScan()` returns `{ scanned: 0, enqueued: 0 }` and `findImpactSourceOrgIds` is never called; with it set to `'true'` the scan proceeds (assert the flag is read per call by flipping `process.env` between two invocations of the SAME imported function).
  - an already-bootstrapped org (mock `needsImpactBootstrap` → false) gets `fromDay = through − 6`; a bootstrap org (→ true) gets `fromDay = through − 89`. Use two orgs in ONE scan with different bootstrap answers so a uniform-fixture bug cannot pass.
  - job ids are `impact:<orgId>:<from>:<to>` and differ between the two orgs.
  - `enqueueImpactRollupForOrgs` adds one job per org id with the same deterministic id and returns the count.
  - the worker body dispatches `scan` vs `rebuild-org-range` and calls `rebuildOrgImpactRange` with the job's exact `(orgId, fromDay, toDay)`.
  - `initializeAiAgentImpactRollupWorker` registers the repeatable with `jobSchedule('ai-agent-impact-rollup')` (assert the pattern string reaching `queue.add`, not a hardcoded cron) and removes any pre-existing `scan` repeatable by key first. The internal `scheduleImpactScan` helper is NOT exported — drive it through the initializer.
- [ ] **Step 2:** Run: `cd apps/api && npx vitest run src/jobs/aiAgentImpactRollup.test.ts` — FAIL.
- [ ] **Step 3:** Implement the worker module, add the `JOB_SCHEDULES` slot, append the `WORKER_REGISTRY` entry.
- [ ] **Step 4:** Run:
```bash
cd apps/api && npx vitest run src/jobs/aiAgentImpactRollup.test.ts src/jobs/scheduleRegistry.contract.test.ts src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts
```
— all PASS. If `workerEntrypointClosure.contract.test.ts` reports the entry as `socket-owner`, change `placement` to what the test says and record why in the entry comment; the test is the authority.
- [ ] **Step 5:** Commit:
```bash
git add apps/api/src/jobs/aiAgentImpactRollup.ts apps/api/src/jobs/aiAgentImpactRollup.test.ts apps/api/src/jobs/scheduleRegistry.ts apps/api/src/services/workerRegistry.ts
git commit -m "feat(api): P2-6 impact rollup worker — nightly scan + 90-day bootstrap fan-out, daily slot 18:33 UTC (#4193)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 6 (A6): Partner impact weights service

**Files:**
- Create: `apps/api/src/services/aiAgents/impactWeights.ts`, `apps/api/src/services/aiAgents/impactWeights.test.ts`

**Interfaces:**
- Consumes: `readWithPartnerAxisVisibility` (`db/partnerAxisRead.ts:8-25`), `canManagePartnerWidePolicies` + `PartnerWideWriteDeniedError` (`services/partnerWideAccess.ts:18-40`), `partners` / `organizations` (`db/schema`), `resolveImpactWeights` / `normalizeImpactWeightOverrides` / `ImpactWeights` / `ImpactWeightOverrides` (A1), `AuthContext` (`middleware/auth.ts`).
- Produces:
```ts
export interface ResolvedImpactWeights {
  partnerId: string;
  effective: ImpactWeights;
  overrides: ImpactWeightOverrides | null;
}

/**
 * The partner whose weights price this request. `auth.partnerId` for
 * organization and partner scope (an org token carries a partnerId even though
 * it can never pass breeze_has_partner_access); for system scope the caller
 * MUST pass an orgId and the partner is read off that org row under the
 * caller's own context. Throws ImpactPartnerUnresolvedError when neither
 * yields one — a system-wide estimate cannot use one weight set across
 * multiple partners.
 */
export function resolveImpactPartnerId(auth: AuthContext, orgId?: string): Promise<string>;

/** Reads partners.ai_impact_weights through readWithPartnerAxisVisibility.
 *  An org-scoped RLS context has accessible_partner_ids = [] and would read
 *  ZERO ROWS (not an error) without the escape — #2822. */
export function loadImpactWeights(partnerId: string): Promise<ResolvedImpactWeights>;

/** Writes under the CALLER's own context (partner scope passes
 *  breeze_has_partner_access) — never the system escape. `overrides: null`
 *  resets to defaults. Throws PartnerWideWriteDeniedError when
 *  canManagePartnerWidePolicies(auth) is false. Returns before/after for the
 *  route's audit row. */
export function saveImpactWeights(
  auth: AuthContext,
  partnerId: string,
  overrides: ImpactWeightOverrides | null,
): Promise<{ before: ImpactWeightOverrides | null; after: ImpactWeightOverrides | null; effective: ImpactWeights }>;

export class ImpactPartnerUnresolvedError extends Error {}
```

- [ ] **Step 1:** Write failing tests in `impactWeights.test.ts`. The `vi.mock('../../db')` factory MUST include `getCurrentDbAccessContext: vi.fn(() => undefined)`, `runOutsideDbContext: vi.fn((fn) => fn())`, `withSystemDbAccessContext: vi.fn(async (fn) => fn())` — omitting any of the three makes `readWithPartnerAxisVisibility` fail loudly rather than silently skipping the escape (its own docstring says so). Assertions:
  - `loadImpactWeights` calls `readWithPartnerAxisVisibility` (assert the escape helpers were invoked) and returns `{ effective: DEFAULT_IMPACT_WEIGHTS, overrides: null }` for a NULL column.
  - a stored `{ fixExecuted: 1200 }` yields `effective.fixExecuted === 1200` and every other key at its default.
  - a stored `{ fixExecuted: 1200, bogus: 5, draftSent: -1 }` yields `overrides === { fixExecuted: 1200 }` and defaults elsewhere.
  - `resolveImpactPartnerId` returns `auth.partnerId` for `scope: 'organization'` and `'partner'`; for `scope: 'system'` with no `orgId` it rejects with `ImpactPartnerUnresolvedError`; for `scope: 'system'` with an `orgId` it reads `organizations.partner_id` (assert the compiled WHERE pins `organizations.id = <orgId>`).
  - `saveImpactWeights` throws `PartnerWideWriteDeniedError` for `{ scope: 'partner', partnerOrgAccess: 'selected' }` and for `{ scope: 'organization' }`, and performs no UPDATE in either case.
  - `saveImpactWeights` with `{ scope: 'partner', partnerOrgAccess: 'all' }` issues exactly one UPDATE whose SET is `{ aiImpactWeights: <normalized> }` and whose WHERE pins `partners.id = <partnerId>` (assert the compiled SQL — not just the mock's call shape).
  - `saveImpactWeights(auth, id, null)` sets the column to `null`.
  - `saveImpactWeights` does NOT go through `readWithPartnerAxisVisibility` for the write (assert `withSystemDbAccessContext` was not called during the update path).
- [ ] **Step 2:** Run: `cd apps/api && npx vitest run src/services/aiAgents/impactWeights.test.ts` — FAIL.
- [ ] **Step 3:** Implement `impactWeights.ts`.
- [ ] **Step 4:** Run: `cd apps/api && npx vitest run src/services/aiAgents/impactWeights.test.ts` — PASS.
- [ ] **Step 5:** Commit:
```bash
git add apps/api/src/services/aiAgents/impactWeights.ts apps/api/src/services/aiAgents/impactWeights.test.ts
git commit -m "feat(api): P2-6 partner impact weights — partner-axis read escape, full-partner-admin write gate (#4193)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 7 (A7): `impactQuery.ts` — DTO assembly

**Files:**
- Create: `apps/api/src/services/aiAgents/impactQuery.ts`, `apps/api/src/services/aiAgents/impactQuery.test.ts`

**Interfaces:**
- Consumes: `aiAgentImpactDaily`, `aiAlertVerdicts`, `organizations` (`db/schema`); `lastCompleteUtcDay`, `shiftUtcDay` (A4); `loadImpactWeights`, `resolveImpactPartnerId` (A6); `estimateSecondsSaved`, `AI_AGENT_IMPACT_BY_ORG_LIMIT`, `AI_AGENT_IMPACT_DTO_SCHEMA_VERSION`, `AiAgentImpactDto` (A1); `canManagePartnerWidePolicies` (`services/partnerWideAccess.ts`).
- Produces:
```ts
export interface ImpactQueryInput { window: AiAgentImpactWindow; orgId?: string }
/** Thrown when `input.orgId` is not in the caller's accessible set. The route
 *  checks first and answers 403; this is the defensive second gate so a future
 *  non-route caller cannot skip it. */
export class ImpactOrgAccessDeniedError extends Error {}
/** Assembles the whole DTO. Runs under the CALLER's request DB context — every
 *  statement carries `auth.orgCondition(...)` on top of RLS, because partner
 *  scope means ACCESSIBLE orgs, not every org under the partner. */
export function loadImpactSummary(auth: AuthContext, input: ImpactQueryInput): Promise<AiAgentImpactDto>;
```

Implementation shape:
1. `const through = lastCompleteUtcDay(); const from = shiftUtcDay(through, -(window - 1));`
2. Org narrowing: if `input.orgId` is present, `if (!auth.canAccessOrg(input.orgId)) throw new ImpactOrgAccessDeniedError()` (the route maps it to 403) and add `eq(aiAgentImpactDaily.orgId, input.orgId)`. For `auth.scope === 'system'` an `orgId` is REQUIRED — the route enforces the 400 before calling in, and this service asserts it defensively.
3. **Series + totals** — ONE grouped statement (server-side aggregation; never fetch org-day rows into Node):
   `SELECT day, SUM(<each counter>)::int …, MIN(rebuilt_at) AS rebuilt_at FROM ai_agent_impact_daily WHERE <orgCondition> AND <orgFilter?> AND day >= from AND day <= through GROUP BY day ORDER BY day`.
   `estSecondsSaved` per bucket and for the totals is computed in TS with `estimateSecondsSaved` and the effective weights. `rebuiltAt` = the MIN over all returned buckets, ISO-8601, or `null` when zero rows.
   Fill missing days with an all-zero bucket so `series.length === window` always — the chart must not silently compress a gap.
4. **byOrg** (partner scope only): `SELECT o.id, o.name, SUM(<each counter>)::int … GROUP BY o.id, o.name` joined `organizations` on `aiAgentImpactDaily.orgId`. One row per org (bounded by the partner's org count, not org×day), sorted in TS by `estSecondsSaved` desc, sliced to `AI_AGENT_IMPACT_BY_ORG_LIMIT`; `byOrgTruncated = rows.length > AI_AGENT_IMPACT_BY_ORG_LIMIT`.
5. **positiveFeedback** — a LIVE query against the source table, not the rollup:
   `SELECT count(*) FILTER (WHERE feedback = 'up')::int AS up, count(*) FILTER (WHERE feedback = 'down')::int AS down FROM ai_alert_verdicts WHERE <auth.orgCondition(aiAlertVerdicts.orgId)> AND <orgFilter?> AND superseded_by IS NULL AND feedback_at >= (from::date) AT TIME ZONE 'UTC' AND feedback_at < (through::date + 1) AT TIME ZONE 'UTC'`. `rate = up + down === 0 ? null : up / (up + down)`.
6. **weights**: `const partnerId = await resolveImpactPartnerId(auth, input.orgId); const { effective, overrides } = await loadImpactWeights(partnerId);`
7. `canEditWeights = canManagePartnerWidePolicies(auth)`; `promoteEligibleCount = null` with an inline `// P2-6b (#4193 follow-up): reads P2-5's ai_agent_graduation, which has not landed.`

- [ ] **Step 1:** Write failing tests in `impactQuery.test.ts` (mocked db; a **non-uniform** fixture — every counter a distinct value on a distinct day so a wrong-column bug changes the result):
  - `through` is the last complete UTC day and `series.length === window` for each of 7/30/90, with zero-filled gap days present and in ascending `day` order.
  - `totals.estSecondsSaved` equals `estimateSecondsSaved(totals, effective)` with a partner override applied (assert it changes when the override changes — proving the estimate is read-time, not stored).
  - `rebuiltAt` is the MINIMUM `rebuilt_at` across buckets, not the max, and is `null` for an empty window.
  - every statement's compiled SQL contains the `auth.orgCondition` predicate (assert on compiled SQL, not on a `where` object identity).
  - `byOrg` is empty for `scope: 'organization'` and for `scope: 'system'`; populated and sorted desc by `estSecondsSaved` for `scope: 'partner'`; `byOrgTruncated` is true at 51 orgs and false at 50.
  - `positiveFeedback.rate` is `null` for `{up:0,down:0}`, `1` for `{up:3,down:0}`, `0.75` for `{up:3,down:1}`; the query filters `superseded_by IS NULL` and bounds on `feedback_at` (compiled-SQL assertion).
  - an inaccessible `orgId` throws (route → 403).
  - `promoteEligibleCount` is `null` and `schemaVersion` is `1`.
- [ ] **Step 2:** Run: `cd apps/api && npx vitest run src/services/aiAgents/impactQuery.test.ts` — FAIL.
- [ ] **Step 3:** Implement `impactQuery.ts`.
- [ ] **Step 4:** Run: `cd apps/api && npx vitest run src/services/aiAgents/impactQuery.test.ts` — PASS.
- [ ] **Step 5:** Commit:
```bash
git add apps/api/src/services/aiAgents/impactQuery.ts apps/api/src/services/aiAgents/impactQuery.test.ts
git commit -m "feat(api): P2-6 impact query — window aggregation, read-time estimate, top-50 byOrg, live positive-feedback rate (#4193)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 8 (A8): Routes

**Files:**
- Modify: `apps/api/src/routes/aiAgents.ts`, `apps/api/src/routes/aiAgents.test.ts`

**Interfaces:**
- Consumes: `loadImpactSummary` (A7), `loadImpactWeights` / `saveImpactWeights` / `resolveImpactPartnerId` / `ImpactPartnerUnresolvedError` (A6), `enqueueImpactRollupForOrgs` / `buildImpactRollupJobId` (A5), `lastCompleteUtcDay` / `shiftUtcDay` (A4), `impactQuerySchema` / `impactWeightsSchema` / `AI_AGENT_IMPACT_REBUILD_DAYS` / `AI_AGENT_IMPACT_REBUILD_MAX_ORGS` (A1), the existing `scopes` (`requireScope('organization','partner','system')`, `aiAgents.ts:63`), `requireAiRead` / `requireAiWrite` (`:61-62`), `writeRouteAudit`, `PartnerWideWriteDeniedError` / `PARTNER_WIDE_WRITE_DENIED_MESSAGE`.
- Produces: four routes, ALL registered **before** `aiAgentsRoutes.get('/:id', …)` at line 716 — a literal path segment must not fall into the `:id` param route (same reason as `/runs`, `/effective` and `/policy-decidable-keys` above it). Put them immediately after the verdict-feedback route block that ends at :714.

```ts
// GET /ai/agents/impact?window=7|30|90[&orgId]
aiAgentsRoutes.get('/impact', scopes, requireAiRead, zValidator('query', impactQuerySchema), async (c) => { … });
// POST /ai/agents/impact/rebuild[?orgId]
aiAgentsRoutes.post('/impact/rebuild', scopes, requireAiWrite, zValidator('query', impactRebuildQuerySchema), async (c) => { … });
// PUT /ai/agents/impact/weights   body: ImpactWeightOverrides
aiAgentsRoutes.put('/impact/weights', scopes, requireAiWrite, zValidator('json', impactWeightsSchema), async (c) => { … });
// DELETE /ai/agents/impact/weights
aiAgentsRoutes.delete('/impact/weights', scopes, requireAiWrite, async (c) => { … });
```

Behaviour:
- `GET /impact`: `auth.scope === 'system'` without `orgId` → `400 { error: 'org_id_required', message: 'A system-scoped impact query must name one organization — one weight set belongs to one partner.' }`. `orgId` present but `!auth.canAccessOrg(orgId)` → `403`. Otherwise `200 { data: <AiAgentImpactDto> }`. **No MFA.**
- `POST /impact/rebuild`: resolve the target org set — `orgId` when supplied (403 if inaccessible), else `auth.accessibleOrgIds` (`null` ⇒ system scope with no `orgId` ⇒ `400 org_id_required`). `> AI_AGENT_IMPACT_REBUILD_MAX_ORGS` → `409 { error: 'too_many_orgs', limit: 200, count: n }`. Otherwise compute `through = lastCompleteUtcDay()`, `from = shiftUtcDay(through, -(AI_AGENT_IMPACT_REBUILD_DAYS - 1))`, call `enqueueImpactRollupForOrgs(orgIds, from, through)` and return `202 { queued: n, from, through }`. Deterministic job ids make a repeated press a natural no-op. Audit `ai_agent_impact.rebuild_requested` with `{ orgCount, from, through }`.
- `PUT /impact/weights`: `requireAiWrite` **and** `canManagePartnerWidePolicies(auth)`; a `PartnerWideWriteDeniedError` (or a failed check) → `403 { error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }`. **No `requireMfa()`** — this is an estimate-model preference, not a credential or a destructive act; the surrounding `DELETE /:id` uses MFA because it removes an agent policy. Audit `ai_agent_impact_weights.updated` with `{ before, after }` and `orgId: null` (a partner-wide row has no org; `RouteAuditInput.orgId` is `string | null | undefined`). `200 { data: { effective, overrides } }`.
- `DELETE /impact/weights`: same gate, `saveImpactWeights(auth, partnerId, null)`, audit `ai_agent_impact_weights.updated` with `after: null`, `200 { data: { effective: DEFAULT_IMPACT_WEIGHTS, overrides: null } }`.

- [ ] **Step 1:** Write failing route tests in `apps/api/src/routes/aiAgents.test.ts` (follow the file's existing app-construction + auth-mock harness):
  - **route order**: `GET /ai/agents/impact` resolves the impact handler and NOT `GET /:id` (assert the impact payload comes back, and that a request for `GET /ai/agents/<uuid>` still hits the agent handler).
  - `GET /impact` default window is 30; `?window=90` passes 90 through to `loadImpactSummary`; `?window=1` → 400.
  - `GET /impact` with `scope: 'system'` and no `orgId` → 400 `org_id_required`; with an accessible `orgId` → 200.
  - `GET /impact` with an inaccessible `orgId` → 403.
  - `POST /impact/rebuild` with 201 accessible orgs → 409 `too_many_orgs`; with 3 → 202 `{ queued: 3 }` and `enqueueImpactRollupForOrgs` called with a 90-day range ending at the last complete UTC day.
  - `POST /impact/rebuild` with `?orgId=<inaccessible>` → 403.
  - `PUT /impact/weights` as `{ scope: 'partner', partnerOrgAccess: 'selected' }` → 403; as `{ scope: 'organization' }` → 403; as `{ scope: 'partner', partnerOrgAccess: 'all' }` → 200 and `writeRouteAudit` called with action `ai_agent_impact_weights.updated` carrying both `before` and `after`.
  - `PUT /impact/weights` with `{ fixExecuted: 86401 }` → 400 (validator); with `{ bogus: 1 }` → 400 (strict).
  - `DELETE /impact/weights` as a full-partner admin → 200 with `overrides: null`.
- [ ] **Step 2:** Run: `cd apps/api && npx vitest run src/routes/aiAgents.test.ts` — FAIL on the new cases.
- [ ] **Step 3:** Implement the four handlers in `routes/aiAgents.ts`, inserted before line 716's `GET /:id`, with a block comment stating the registration-order rule verbatim from the sibling routes.
- [ ] **Step 4:** Run: `cd apps/api && npx vitest run src/routes/aiAgents.test.ts src/__tests__/partner-wide-write-coverage.test.ts` — PASS. Then `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json` and `pnpm lint`.
- [ ] **Step 5:** Commit:
```bash
git add apps/api/src/routes/aiAgents.ts apps/api/src/routes/aiAgents.test.ts
git commit -m "feat(api): P2-6 impact routes — GET /impact, POST /impact/rebuild, PUT/DELETE /impact/weights (#4193)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 9 (A9): Live-Postgres integration proof + PR A

**Files:**
- Create: `apps/api/src/__tests__/integration/aiAgentImpact.integration.test.ts`

**Interfaces:** consumes everything from A2–A8; produces no new exports. It replays the wave migration by path — if the file is renamed at PR time (see Final verification), update the `readFileSync` path here too, or `autoMigrate.test.ts` will fail with an ENOENT reference.

The suite (one live database; model the harness on `ticketDraftsRls.integration.test.ts` and `aiAgentSchedulesPartnerRls.integration.test.ts`):
- **Every counter fires.** Seed ONE org with a deliberately NON-UNIFORM fixture — distinct counts per counter, spread over three distinct UTC days — covering: 3 verdicts of which 2 are noise classifications; 1 completed `manage_alerts:suppress` agent intent; 2 `profile='triage'` runs with `outcome ? 'ticketProposal'` plus 1 with `error_code` set (must NOT count) plus 1 without a `ticketProposal` (must NOT count); 2 consumed `ticket_drafts` plus 1 `active` (must NOT count); 1 Tier-3 fix intent AND 1 `profile='full'` run whose `outcome.proposedActions` holds one `intentId: null` fix-tool entry and one entry that already carries an `intentId` (must NOT double-count) and one `manage_alerts` entry (must NOT count); 1 completed fix intent AND 1 `mode_at_start='act'` run with one `executedActions` entry `{actOpKey, execution:'succeeded', verification:'passed'}` (counts), one `{execution:'succeeded', verification:'failed'}` (must NOT count), one `{execution:'failed'}` (must NOT count) and one with no `actOpKey` (must NOT count); 1 `held_qualified` and 1 `recurred` watch; 1 narrative run with `report_run_id` set and 1 without (must NOT count); runs with `cost_cents` summing to a known value by `queued_at`. Assert every one of the eleven stored columns exactly.
- **UTC bucketing.** Place one verdict at `23:59:59Z` and one at `00:00:01Z` the next day and assert they land in different buckets; run the whole suite once with `SET TIME ZONE 'America/New_York'` on the session and assert identical results (this is the `date_trunc` trap).
- **Zero-day grid.** A range spanning a day with no facts produces a row of all zeros for that day, and `rebuildOrgImpactRange` over a range that includes a day whose facts were then DELETED resets that day's counters to 0 (not "leaves them stale").
- **Idempotency.** Running `rebuildOrgImpactRange` twice over the same range yields identical counters and a strictly later `rebuilt_at`.
- **Org isolation.** A second org in the same partner with its own facts is untouched by the first org's rebuild, and its counters are computed independently.
- **RLS forge.** As `breeze_app` under org A's context, `SELECT` returns zero org-B rows, and an `INSERT` naming org B's `org_id` fails with `42501` (`new row violates row-level security policy`).
- **Erasure.** `cascadeDeleteOrg` (`services/tenantCascade.ts:771`) on an org holding impact rows completes without an FK violation and removes them (proves the `CORE_ORG_CASCADE_DELETE_ORDER` entry).
- **Org merge.** A merge with impact rows on the loser completes; the loser's rows are still present under the loser shell (the `leave-for-erasure` contract) and the survivor's rows are unchanged (no double-count).
- **Partner-axis weights from an ORG token.** Set `partners.ai_impact_weights` to `{ fixExecuted: 1200 }`, then call `loadImpactWeights` inside an ORGANIZATION-scoped DB context and assert `effective.fixExecuted === 1200`. Without `readWithPartnerAxisVisibility` this returns the defaults silently — a mocked-DB test cannot see it (#2822).
- **Read-time re-pricing.** `loadImpactSummary` over the same buckets returns a different `totals.estSecondsSaved` before and after a weight change, with no rollup re-run.

- [ ] **Step 1:** Write the integration suite first (it will fail against an un-migrated DB).
- [ ] **Step 2:** Bring up the wave's test database and run it:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/ai-agents-p2-6
pnpm test-stack up   # per-worktree pg+redis, writes .env.test (docker-compose.test.yml's service is `postgres-test`, NOT `postgres`)
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiAgentImpact.integration.test.ts
```
— PASS (confirm the reported test count, and that the shard log shows the file actually RAN).
- [ ] **Step 3:** Run the registry contract suites, which are the only guard on the four registration lists:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts
cd apps/api && npx vitest run --config vitest.config.rls-coverage.ts   # rls-coverage has its OWN runner; vitest.config.rls.ts does not include it
```
- [ ] **Step 4:** Full targeted API + shared suites, typecheck and lint:
```bash
cd apps/api && npx vitest run src/services/aiAgents src/jobs/aiAgentImpactRollup.test.ts src/jobs/scheduleRegistry.contract.test.ts src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts src/routes/aiAgents.test.ts src/db/schema/aiAgentImpactDaily.test.ts src/db/autoMigrate.test.ts src/config/composeBindMounts.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json && pnpm lint
cd packages/shared && npx vitest run src/types src/validators src/reportPdf && npx tsc --noEmit -p tsconfig.json && pnpm lint
```
- [ ] **Step 5:** Commit and open PR A:
```bash
git add apps/api/src/__tests__/integration/aiAgentImpact.integration.test.ts
git commit -m "test(api): P2-6 live-Postgres impact proof — every counter, UTC buckets, zero grid, RLS/erasure/merge, partner-axis weights (#4193)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
Open **PR A** targeting `main` with body `Part of #4193`, a summary, the spec-amendment list, the four registration-list entries, and the test evidence. **STOP at the open PR** — review comes through the wave process; do not merge.

---

## PR B — web (branch `feature/4187-ai-agents-p2/wave-4193-b`, based on **main** after PR A merges)

### Task 10 (B1): The impact page, route scope, sidebar, guard

**Files:**
- Create: `apps/web/src/pages/ai-agents/impact.astro`, `apps/web/src/components/aiAgents/ImpactPage.tsx`, `apps/web/src/components/aiAgents/ImpactPage.test.tsx`
- Modify: `apps/web/src/lib/routeScope.ts`, `apps/web/src/components/layout/Sidebar.tsx`, `apps/web/src/components/layout/Sidebar.nav.test.tsx`, `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`, `apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/common.json` and `.../settings.json`

**Interfaces:**
- Consumes: `AiAgentImpactDto`, `AI_AGENT_IMPACT_WINDOWS`, `AI_AGENT_IMPACT_COUNTER_KEYS`, `DEFAULT_IMPACT_WEIGHTS` from `@breeze/shared`; `fetchWithAuth` (`stores/auth`), `useOrgStore` (`stores/orgStore`), `runAction` + `ActionError` (`lib/runAction`), `formatCurrency` (`lib/i18n/format`), `formatDateTime` (`lib/dateTimeFormat`), `useTranslation('settings')`; recharts 3.x (`^3.9.2`, already a dependency).
- Produces: `export default function ImpactPage(): JSX.Element` in `components/aiAgents/ImpactPage.tsx`.

Page contents (mirror `RunsListPage.tsx`'s structure, i18n idiom and `data-testid` density — it has 14):
- Window selector `7 | 30 | 90`, `data-testid="ai-impact-window-7|30|90"`, default 30, persisted in `window.location.hash` (repo rule: hash, never a query param, for transient UI state).
- Fetch `GET /api/ai/agents/impact?window=<n>` via `fetchWithAuth` (it auto-injects `?orgId=` when the org switcher has one org selected — the route accepts it).
- Stat tiles, each with a `data-testid`: `ai-impact-tile-alerts-judged`, `-noise-flagged`, `-tickets-triaged`, `-drafts-sent`, `-fixes-executed`, `-est-seconds-saved`, `-llm-cents`. The estimate tile's label is the i18n key `aiAgentsPage.impact.tiles.estTimeSaved` = **"Estimated time saved"** with a `title`/tooltip listing the six effective weights; the spend tile shows `formatCurrency(llmCents / 100)` and is rendered immediately beside it.
- Daily stacked bar (recharts `ResponsiveContainer` + `BarChart` + three `Bar`s, `data-testid="ai-impact-chart"`) over **DISJOINT** series computed in TS from the DTO: `noiseFlagged`, `alertsJudged − noiseFlagged` (clamped at 0), `ticketsTriaged`, `fixesExecuted`. Never stack `alertsJudged` on `noiseFlagged` — noise is a subset and the bar would double-count it.
- Per-org table, rendered only when `dto.byOrg.length > 0` (`data-testid="ai-impact-by-org"`), with a "showing top 50" line when `dto.byOrgTruncated`.
- Freshness line: `Data through <through> (UTC) · rebuilt <rebuiltAt>` (`data-testid="ai-impact-freshness"`), and "never rebuilt" when `rebuiltAt` is null.
- Positive-feedback readout labelled with the key `aiAgentsPage.impact.positiveFeedbackRate` ("Positive feedback rate") — never "precision"; hidden when `rate === null`.
- **Refresh** button (`data-testid="ai-impact-refresh"`): `runAction({ request: () => fetchWithAuth('/api/ai/agents/impact/rebuild', { method: 'POST' }), errorFallback: t('aiAgentsPage.impact.errors.rebuild'), successMessage: t('aiAgentsPage.impact.toasts.rebuildQueued') })`, then poll `GET /impact` every 5 s until `rebuiltAt` advances past the value captured before the POST, giving up after 2 minutes with an informational toast. Catch pattern exactly as CLAUDE.md prescribes: `if (err instanceof ActionError && err.status === 401) return; if (!(err instanceof ActionError)) showToast({ type: 'error', … });`. Clear the interval on unmount.
- All copy through i18n keys under `aiAgentsPage.impact.*` in `settings.json` (the namespace `RunsListPage` already uses) across all 8 locales; `nav.aiImpact` in `common.json` across all 8. Never compare UI logic against `i18n.t(...)` output in tests (the tr-TR rule).

Registration edits:
- `routeScope.ts`: insert `{ pattern: /^\/ai-agents\/impact$/, kind: 'org-or-all' },` immediately after the existing `/^\/ai-agents\/runs(\/.*)?$/` entry (line 89), with a one-line comment: *"P2-6 (#4193): fleet value accounting — honours the org switcher (single org) and aggregates across accessible orgs in All-organizations view."*
- `Sidebar.tsx`: add to the `ai` section's `items`, immediately after the `AI Agent Runs` entry (line 211): `{ name: 'AI Impact', labelKey: 'nav.aiImpact', href: '/ai-agents/impact', icon: TrendingUp, requiredPermission: { resource: 'ai_agents', action: 'read' } },` (import `TrendingUp` from `lucide-react` alongside the existing icons).
- `Sidebar.nav.test.tsx` line 100: update the expected array to `['/fleet', '/workspace', '/settings/ai-agents', '/ai-agents/runs', '/ai-agents/impact', '/settings/ai-usage', '/ai-for-office']`.
- `no-silent-mutations.test.ts` `TARGET_GLOBS` (lines 30-69): add `'src/components/aiAgents/ImpactPage.tsx',` with the comment *"P2-6 (#4193): Refresh enqueues a fleet-wide 90-day rebuild and the weights drawer re-prices every estimate the MSP shows its customers — a silent failure here is invisible until someone quotes a wrong number."*

- [ ] **Step 1:** Write failing tests in `ImpactPage.test.tsx` (fixture DTO must be NON-UNIFORM — a distinct value per counter and per day, so a wrong-field render fails):
  - tiles render the DTO's values; the estimate tile's text contains the translated "Estimated" label and the spend tile renders `formatCurrency`.
  - changing the window selector refetches with `?window=90` and updates the hash.
  - the chart's data rows carry `alertsJudged − noiseFlagged` for the non-noise series (assert a fixture where `alertsJudged=10, noiseFlagged=4` produces `6`, never `10`).
  - `byOrg` table hidden for an empty array; shown with the truncation line when `byOrgTruncated`.
  - Refresh POSTs to `/api/ai/agents/impact/rebuild`, then polls and stops once `rebuiltAt` advances (drive with fake timers).
  - a failing Refresh surfaces an error toast (the runAction contract), and a 401 does not.
  - the freshness line renders `through` and the "never rebuilt" variant for `rebuiltAt: null`.
  - the positive-feedback readout is hidden for `rate: null`.
- [ ] **Step 2:** Run: `cd apps/web && npx vitest run src/components/aiAgents/ImpactPage.test.tsx --pool=threads --maxWorkers=2` — FAIL.
- [ ] **Step 3:** Implement the astro page, `ImpactPage.tsx`, the four registration edits and the 8-locale keys.
- [ ] **Step 4:** Run:
```bash
cd apps/web && npx vitest run src/components/aiAgents src/lib/routeScope.test.ts src/components/layout/Sidebar.nav.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/__tests__/no-silent-mutations.test.ts --pool=threads --maxWorkers=2
cd apps/web && npx astro check && pnpm lint
```
— PASS.
- [ ] **Step 5:** Commit:
```bash
git add apps/web/src/pages/ai-agents/impact.astro apps/web/src/components/aiAgents/ImpactPage.tsx apps/web/src/components/aiAgents/ImpactPage.test.tsx apps/web/src/lib/routeScope.ts apps/web/src/components/layout/Sidebar.tsx apps/web/src/components/layout/Sidebar.nav.test.tsx apps/web/src/lib/__tests__/no-silent-mutations.test.ts apps/web/src/locales
git commit -m "feat(web): P2-6 AI impact page — window selector, tiles, disjoint daily chart, per-org table, refresh poll, 8 locales (#4193)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 11 (B2): Weights drawer, PDF export, PR B

**Files:**
- Create: `apps/web/src/components/aiAgents/ImpactWeightsDrawer.tsx`, `apps/web/src/components/aiAgents/ImpactWeightsDrawer.test.tsx`
- Modify: `apps/web/src/components/aiAgents/ImpactPage.tsx` (+ its test), `apps/web/src/locales/*/settings.json`

**Interfaces:**
- Consumes: `ImpactWeights`, `ImpactWeightOverrides`, `DEFAULT_IMPACT_WEIGHTS`, `IMPACT_WEIGHT_KEYS`, `IMPACT_WEIGHT_MAX_SECONDS`, `AiAgentImpactDto` from `@breeze/shared`; `exportReport` from `apps/web/src/components/reports/reportExport.ts`; `runAction`, `fetchWithAuth`.
- Produces:
```tsx
export interface ImpactWeightsDrawerProps {
  open: boolean;
  effective: ImpactWeights;
  overrides: ImpactWeightOverrides | null;
  onClose: () => void;
  /** Called after a successful save/reset so the page can refetch the DTO. */
  onSaved: () => void;
}
export default function ImpactWeightsDrawer(props: ImpactWeightsDrawerProps): JSX.Element | null;

// exported from ImpactPage.tsx for its own test
export function buildImpactPdfRows(
  dto: AiAgentImpactDto,
  t: (key: string) => string,
): Array<{ metric: string; value: string }>;
```

Drawer: six number inputs (`data-testid="ai-impact-weight-<key>"` for each of `IMPACT_WEIGHT_KEYS`), each clamped `0..IMPACT_WEIGHT_MAX_SECONDS`; **Save** → `runAction` `PUT /api/ai/agents/impact/weights` with only the keys the user actually changed from the effective values (partial overrides, matching the server contract); **Reset to defaults** → `runAction` `DELETE /api/ai/agents/impact/weights`. Rendered from `ImpactPage` behind a button (`data-testid="ai-impact-edit-weights"`) that is present **only when `dto.canEditWeights`** — an org admin or a `selected`-access partner user never sees it, and the server 403 is the real gate.

PDF export from `ImpactPage` (`data-testid="ai-impact-export-pdf"`):
```ts
await exportReport(
  buildImpactPdfRows(dto, t),   // UNIFORM rows only — see below
  {
    format: 'pdf',
    reportType: 'ai_agent_impact',
    timezone: 'UTC',
  },
);
```
`buildImpactPdfRows` returns a **uniform** `Array<{ metric: string; value: string }>` — one row per counter, plus estimated time saved, LLM spend, the window, `through`, `rebuiltAt` and each of the six effective weights. Uniform is mandatory: `renderGenericReport` derives its columns solely from `Object.keys(rows[0])` (`packages/shared/src/reportPdf/reportPdf.ts:1405`), so a heterogeneous "summary header row" silently truncates every later row's extra fields. The page title comes from the `ai_agent_impact: 'AI Agent Impact'` label added to `REPORT_TYPE_LABELS` in Task A1. Timezone is pinned to `'UTC'`, not the browser zone, because every bucket is a UTC day.

- [ ] **Step 1:** Write failing tests:
  - `ImpactWeightsDrawer.test.tsx`: renders six inputs seeded from `effective`; Save PUTs only the CHANGED keys (edit one field, assert the request body has exactly that key); a value above `IMPACT_WEIGHT_MAX_SECONDS` is rejected client-side; Reset DELETEs; a failed save toasts (runAction contract); `onSaved` fires on success.
  - `ImpactPage.test.tsx` additions: the edit-weights button is absent for `canEditWeights: false` and present for `true`; the PDF export calls `exportReport` with `reportType: 'ai_agent_impact'`, `timezone: 'UTC'`, and rows whose every element has exactly the keys `['metric','value']` (assert on every row, not just the first — that is the bug the uniform rule prevents).
- [ ] **Step 2:** Run: `cd apps/web && npx vitest run src/components/aiAgents --pool=threads --maxWorkers=2` — FAIL.
- [ ] **Step 3:** Implement the drawer, the page wiring, `buildImpactPdfRows`, and the new 8-locale keys.
- [ ] **Step 4:** Run:
```bash
cd apps/web && npx vitest run src/components/aiAgents src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/__tests__/no-silent-mutations.test.ts --pool=threads --maxWorkers=2
cd apps/web && npx astro check && pnpm lint
```
— PASS.
- [ ] **Step 5:** Commit and open PR B:
```bash
git add apps/web/src/components/aiAgents apps/web/src/locales
git commit -m "feat(web): P2-6 impact weights drawer + uniform-row PDF export (#4193)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
Open **PR B** targeting `main` with body `Closes #4193`. **STOP at the open PR** — do not merge.

---

## Final verification (before each PR opens)

- [ ] **Migration name re-check (PR A only).** `git fetch origin main && git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -3`. If anything sorts at or after `2026-09-30-ai-agents-impact.sql` (the parallel P2-5 wave is the likely source), **rename the file** to sort strictly after the newest committed one and sweep every reference to the old path (`grep -rn '2026-09-30-ai-agents-impact' apps/api/src` — the integration suite replays it by path, and a missed reference is an ENOENT minutes into Integration Tests, not a compile error). Then re-run `npx vitest run src/db/autoMigrate.test.ts`, which asserts every such reference resolves. Renaming is only safe because the file is unmerged (`breeze_migrations` keys on filename).
- [ ] **Contract suites.** `rls-coverage` (under `vitest.config.rls-coverage.ts`), `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgMergeRegistry`, `orgMerge` (all under `vitest.integration.config.ts`); `workerEntrypointClosure.contract.test.ts`, `scheduleRegistry.contract.test.ts`, `composeBindMounts.test.ts`, `partner-wide-write-coverage.test.ts`, `autoMigrate.test.ts` (unit). Web: `localeParity`, `translationCoverage`, `no-silent-mutations`, `Sidebar.nav`, `routeScope`.
- [ ] **Mechanical registration grep** (code review has caught this class 0/5; the contract tests 5/5):
```bash
grep -rn 'ai_agent_impact_daily' apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts
```
— exactly three hits (one per file). Confirm there is **no** `partners` key in `CORE_TENANT_EXPORT_POLICY` (`grep -n '"partners"' apps/api/src/services/tenantExportPolicyRegistry.ts` returns nothing) — the new `partners.ai_impact_weights` column therefore needs no export-policy entry, and this grep is the proof, not an assumption.
- [ ] **Partner-window query plan.** On a database seeded with ≥90 days × ≥200 orgs of `ai_agent_impact_daily`, run the byOrg statement under `EXPLAIN (ANALYZE, BUFFERS)` and confirm it uses `ai_agent_impact_daily_day_org_idx` (an index/bitmap scan over the day range), NOT a sequential scan of the whole table, and that shared-buffer reads scale with the window rather than the table. At 10,000 orgs a 90-day partner read touches on the order of 900,000 rows — record the timing in the PR body. Repeat for the series statement.
- [ ] **Migration idempotency re-proven.** Apply the migration file a second time against an already-migrated DB; it must be a clean no-op. `pnpm db:check-drift` clean.
- [ ] `pnpm lint` in `apps/api`, `packages/shared` (PR A) and `apps/web` (PR B); typechecks green in all three.
- [ ] **Live smoke on a wt-stack** (worktree-stack skill): seed a few verdicts/runs/drafts → `POST /ai/agents/impact/rebuild` → `GET /ai/agents/impact?window=7` shows nonzero counters and a `rebuiltAt`; open `/ai-agents/impact`, press Refresh and watch `rebuiltAt` advance; edit a weight as a full-partner admin and confirm the estimate re-prices with no rollup re-run; confirm the edit button is absent for an org-scoped login; export the PDF and confirm the title reads "AI Agent Impact" and every row is `Metric | Value`. Screenshot evidence into the SDD ledger.
- [ ] **PR bodies.** PR A: `Part of #4193`, list the spec amendments, the four registration entries, the new schedule slot and the eight new indexes, plus the EXPLAIN timings. PR B: `Closes #4193`, list the route-scope/sidebar/guard registrations and the 8-locale key additions. Both: state that nothing is gated behind a new env flag and that no policy snapshot or limits version changed.
- [ ] **Parallel-wave rebase (P2-5, #4192).** Before merging either PR, `git fetch origin main && git rebase origin/main`; if P2-5 landed first, re-verify the ten collision files listed in Global Constraints (`scheduleRegistry.ts` minute collision, `workerRegistry.ts` entry order, `db/schema/index.ts`, `routes/aiAgents.ts` route ORDER relative to `GET /:id`, the three registries, the shared barrels, the locale files, `db/schema/aiAgentFixWatches.ts`) and re-run `scheduleRegistry.contract.test.ts`, `tenantCascade.integration.test.ts` and `tenant-export-policy.integration.test.ts`. A PR targeting `main` already gets the blocking `integration-test` job — do NOT hand-dispatch CI for it; only a stacked branch needs `gh workflow run CI --ref <branch>`.

---

## Self-review (done at plan time)

- **Contract coverage.** C1 → A2 (table, CHECKs, both indexes, three registries, no rls-coverage allowlist) + A0 (`narratives_delivered`, watch-unit rename, no stored estimate). C2 → A3 (positive registry + contract test) and A4 (every predicate verbatim, disjoint arms, `verification <> 'failed'`, `queued_at` cost) and A2 (all eight source indexes). C3 → A4 (generate_series UPSERT, per-statement short system context) + A5 (global placement, daily slot, all-source discovery, deterministic job ids, 7-day nightly / 90-day bootstrap) + A8 (`202`, 200-org cap, 409). C4 → A1 (defaults, Zod, resolver) + A2 (`partners.ai_impact_weights`) + A6 (partner-axis read escape, `canManagePartnerWidePolicies`, audit, DELETE reset) + Global Constraints (no `partners` export entry). C5 → A8 (route order before `:id`, scopes, system-scope 400) + A7 (DTO v1, `orgCondition`, MIN `rebuilt_at`, top-50 + truncation flag, positive-feedback rate, read-time estimate). C6 → B1 + B2 (all fourteen elements: window selector, seven tiles, disjoint chart, per-org table, refresh poll, weights drawer, uniform-row PDF + label, `org-or-all`, sidebar + nav test, no-silent-mutations, 8 locales, `data-testid`s). C7 → Global Constraints + A5 (call-time `envFlag`, no snapshot/limits/permission). C8 → PR split, the collision list, both PR-body strings, the rebase step.
- **Placeholders:** none. Every file path, line reference, SQL statement, exported signature, test assertion and command is concrete; no "TBD", no "similar to Task N".
- **Type consistency across tasks.** `AiAgentImpactCounterKey`/`AiAgentImpactCounters`/`ImpactWeights`/`ImpactWeightOverrides`/`DEFAULT_IMPACT_WEIGHTS`/`resolveImpactWeights`/`normalizeImpactWeightOverrides`/`estimateSecondsSaved`/`AiAgentImpactDto` (A1) are consumed by A2 (column names), A6, A7, A8, B1, B2. `UtcDay`/`lastCompleteUtcDay`/`shiftUtcDay`/`rebuildOrgImpactRange`/`findImpactSourceOrgIds`/`needsImpactBootstrap` (A4) by A5 and A8. `IMPACT_FIX_TOOLS`/`impactFixToolsArray` (A3) by A4. `ResolvedImpactWeights`/`resolveImpactPartnerId`/`loadImpactWeights`/`saveImpactWeights`/`ImpactPartnerUnresolvedError` (A6) by A7 and A8. `loadImpactSummary`/`ImpactQueryInput` (A7) by A8. `buildImpactRollupJobId`/`enqueueImpactRollupForOrgs`/`ImpactRollupJobData` (A5) by A8. `ImpactWeightsDrawerProps` (B2) by B1's page. Counter names are identical in three places by construction: the shared camelCase key list, the SQL column list, and the Drizzle table — pinned by A2's schema test.

---

## Deviations from the contract

Each of these follows the code, which was re-read in this worktree at plan time.

1. **`IMPACT_FIX_TOOLS` has SEVEN members, not the eight the contract's parenthetical implies — `remediation_suggestion` is excluded.** C2 lists the ACT_MANIFEST tool names as "`manage_services`, `disk_cleanup`, `run_script`, `execute_playbook`, `remediation_suggestion` — read the manifest". Reading it: `remediation_suggestion`'s `toolName` is an explicit **sentinel that is never a real registered tool name** (`actManifest.ts:233-252`), and the repo already ships a derived list that filters it — `ACT_ELIGIBLE_TOOL_NAMES` (`actManifest.ts:269-281`), whose docstring says counting the sentinel "would make an operator's toolAllowlist entry read as act-eligible for a name that can never actually be dispatched". It can never appear as an `action_intents.action_name` (set from `input.toolName`, `intentService.ts:1548`) nor as an `outcome.proposedActions[].tool` (set from the dispatched tool name, `runLoop.ts:809`). The plan therefore pins `IMPACT_FIX_TOOLS` to `ACT_ELIGIBLE_TOOL_NAMES ∪ POLICY_DECIDABLE_TIER3.toolName` = `['disk_cleanup','execute_playbook','manage_scheduled_tasks','manage_services','manage_startup_items','run_script','security_scan']`, with the contract test asserting exactly that union and additionally asserting the sentinel's absence.
2. **The cascade-list neighbours named in C1 do not exist yet.** C1 says `ai_agent_impact_daily` "sorts after `ai_agent_graduation`/`ai_agent_fix_watches` and before `ai_agent_op_evidence`/`ai_agent_runs`". `ai_agent_graduation` and `ai_agent_op_evidence` are P2-5 tables and are not on `main`. Verified with `localeCompare`: on today's list the insertion point is between `'ai_agent_fix_watches'` and `'ai_agent_runs'`. If P2-5 merges first the alphabetical position still holds (`ai_agent_fix_watches` < `ai_agent_graduation` < `ai_agent_impact_daily` < `ai_agent_op_stats_daily` < `ai_agent_runs`); re-run the cascade contract test after any rebase.
3. **One `(org_id, profile, finished_at)` runs index replaces C2's `profile = 'full'` partial.** C2 (following Codex Q2) specifies `ai_agent_runs (org_id, finished_at) WHERE finished_at IS NOT NULL AND profile='full'`. That serves only the two jsonb lateral arms and leaves `tickets_triaged` (`profile='triage'`) and `narratives_delivered` (`profile='narrative'`) unindexed, both of which scan the same table by `finished_at` in the same statement. `(org_id, profile, finished_at) WHERE finished_at IS NOT NULL` serves the `profile='full'` predicate identically (equality on the second column, range on the third) and covers all four passes with one index.
4. **`ai_agent_runs (org_id, queued_at)` is NOT added — it already exists.** C2 says "if absent". Verified present as `ai_agent_runs_org_queued_idx` on `(org_id, queued_at DESC)` (`db/schema/aiAgents.ts:163`), which serves the `llm_cents` range scan. Likewise `action_intents (org_id, created_at)` and the rest were each checked against the live schema before being included; the six that are genuinely new are in the migration and the two pre-existing ones are noted there.
5. **C4's MFA requirement on `PUT /impact/weights` is dropped (as C4 itself states, against the Codex verdict D4).** Codex's D4 asks for "MFA, audit, and `canManagePartnerWidePolicies`"; C4 arbitrates to "no MFA" and this plan implements C4. Recorded here because the underlying review text disagrees: the weights are an estimate-model preference, reversible with one more PUT, and carry no credential or destructive effect — `requireMfa()` in this router is reserved for `DELETE /:id` (removing an agent policy).
6. **No `bounds` CTE.** The verdict's Q1 snippets are written as standalone predicates; the natural transcription is a shared `bounds` CTE. A CTE referenced by nine siblings is materialized in PostgreSQL, which stops the range bounds being constant-folded into the index conditions and defeats the very indexes this wave adds. The plan inlines `(${fromDay}::date) AT TIME ZONE 'UTC'` / `(${toDay}::date + 1) AT TIME ZONE 'UTC'` in every predicate instead.
7. **"No new flag" is implemented as a WORKER-side gate only.** C7 says P2-6 "sits under the existing `BREEZE_AI_AGENTS_ENABLED` gate like the rest of `routes/aiAgents.ts`". Verified: `routes/aiAgents.ts` contains no reference to that flag at all — the router is mounted unconditionally (`index.ts:1020`) and the flag gates the run PRODUCER (`runService`, `aiAgentSweepScheduler.ts:252`). This plan therefore matches the sibling behaviour exactly: the impact routes are unconditional, and `processImpactScan` re-reads `envFlag('BREEZE_AI_AGENTS_ENABLED', false)` at call time. With the flag off, the rollup produces nothing and the page truthfully reads all-zero.
8. **`orgs.ts:39-42` is `orgs.ts:38-41`.** The schema comment C4 and Codex Q3 cite ("Dedicated column, not settings JSONB — the settings cards replace sub-objects wholesale (#3597), and a column keeps gate === read-back") sits at lines 38-41 above `autoEmailInvoiceOnQuoteAccept`. The substance is exactly as cited; only the line range differs.
