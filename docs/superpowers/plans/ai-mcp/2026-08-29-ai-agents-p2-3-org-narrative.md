---
tracking_issue: LanternOps/breeze#4187
wave: W03 (#4190) — P2-3 Weekly org narrative (PR A API + renderer, PR B web)
---

# AI Agents Phase 2 — Wave P2-3: Weekly Org Narrative Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A partner adds a **narrative schedule** (weekly-only cron, default `0 7 * * 1`) to its partner-wide triage agent; every occurrence fans out one `profile: 'narrative'` run per live org; the system assembles a bounded, numbers-and-labels context for the previous 7 days (`narrativeContext.ts`, 16 KiB over the whole serialized context), the model calls `submit_narrative` exactly once (eight fixed sections, bullets only — titles and markdown are server-owned), and the system stores the result in ONE transaction as a **system-authored `reports` definition + `report_runs` artifact** (`type: 'ai_org_narrative'`, `schedule: 'weekly'`, `format: 'pdf'`, execution scope `unrestricted` with a new `principal_kind = 'system'`), links `ai_agent_runs.report_run_id`, notifies the agent's recipients in-app, and renders the artifact with the existing branded jsPDF renderer. **No email in v1** (recipients are not verified for `reports:export` + unrestricted site authority — follow-up roadmap item).

**Architecture:** Reuses every P2-2 foundation without new safety machinery: `ai_agent_schedules` gains a `kind` column (`sweep | narrative`, org rows inherit the baseline's kind through a composite self-FK) so a narrative schedule is its own row and the occurrence job admits exactly one run per org (summary invariant intact); a fourth run profile `narrative` (own counters — limits v7, empty tool floor + one outcome tool, circuit-neutral on success, notifies, no fix-watch). `finalizeNarrative` mirrors `finalizeSweep` (outside the ambient DB context, `isRunStillRunning` re-read) and writes the report rows under a system context with every statement org-pinned and a CAS on `ai_agent_runs.report_run_id IS NULL` so a finalizer retry cannot mint a second artifact. The report site-scope contract gains a **system principal** (`execution_scope_principal_kind`, `user_id NULL`) instead of forging attribution to a human. The report worker never touches narrative definitions (`findDueReports` AND `processRunScheduledReport` exclude the type; `generateReport('ai_org_narrative')` throws a typed `StoredArtifactOnlyReportError`; create/ad-hoc schemas reject the type). Rendering draws `sections[]` with existing jsPDF primitives — no markdown parser, no new dependency.

**Tech Stack:** TypeScript, Hono, Drizzle, BullMQ, Claude Agent SDK MCP tools, Zod, jsPDF (`packages/shared/reportPdf`), Vitest, React + Astro + react-i18next (8 locales).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-08-28-ai-agents-phase2-intelligence-layer-design.md` §4.3, §5 rows for P2-3, §7, §8. **This plan amends the spec (Task A0):** the narrative run is `profile: 'narrative'` (not `'full'` — a full-profile run cannot reach an outcome tool); the trigger is a schedule **kind**, not an `AiSweepKind` (every sweep kind must own an evidence loader); the run links `report_run_id` (the artifact) rather than `report_id`; three inputs are structurally weaker than §4.3 assumes (no `suppressed_at`, no device status history, `patch_compliance_snapshots` has no writer → posture score) and are reported as "not measured" rather than invented; email delivery is deferred. Advisor quorum (Codex `gpt-5.6-sol` xhigh, read-only, 2026-08-29): D1 defect (XOR CHECK rejected valid org overrides) adopted; D2 agreed; D3 three defects adopted (system principal, single-transaction CAS finalizer, typed schedule identity) except the `report_runs.org_id` retrofit (pre-existing, filed as a roadmap item); D4 email deferred, rendering agreed, model-authored `markdown` dropped; D5 typed error + double exclusion + schema rejection adopted; D6 tenancy invariants adopted verbatim.

## Global Constraints

- Tests: `cd apps/api && npx vitest run <path>`; shared: `cd packages/shared && npx vitest run <path>`; web: `cd apps/web && npx vitest run <path>` + `src/lib/i18n/localeParity.test.ts` + `src/lib/i18n/translationCoverage.test.ts` + `src/lib/__tests__/no-silent-mutations.test.ts`. Add `--pool=threads --maxWorkers=2` when a dev stack is running. Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`; web `npx astro check`. `pnpm lint` in every touched package.
- **Two migrations in PR A**, both idempotent, named to sort after `2026-09-23-ai-agents-scheduled-sweeps.sql` (the newest on this stacked branch): `2026-09-24-a-report-type-ai-org-narrative.sql` containing ONLY `ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'ai_org_narrative';` (the enum label is uncommitted until the file commits — precedent `2026-06-29-a-report-type-security-compliance.sql`), then `2026-09-24-b-ai-agents-org-narrative.sql` for everything else. No inner `BEGIN;`/`COMMIT;`. Explicit `ON DELETE` on every FK. Never edit a shipped migration; the P2-2 migration is unmerged but treated as shipped (do not edit it — add DROP/ADD CONSTRAINT statements in the new file). The site-scope CHECKs from `2026-08-06-a-report-site-scope.sql` are re-defined (DROP IF EXISTS + ADD) in the new file, never edited in place.
- Branch `feature/4187-ai-agents-p2/wave-4190` is **stacked on P2-2's B branch** (`wave-4189-b`, head `948158db7`) because P2-2 is not merged. PR A targets `wave-4189-b`; PR B (`wave-4190-b`) targets PR A's branch. Merge order after P2-2 lands: rebase `--onto origin/main`, retarget with `gh pr edit --base main`, never `--delete-branch` on a parent while a child is open. Stacked PRs get no CI — dispatch `gh workflow run CI --ref <branch>`.
- Column adds on org-cascade tables fire the export-policy contract: `ai_agent_schedules.kind` → `included`; `ai_agent_runs.report_run_id` → `included`; `reports.source_ai_agent_schedule_id` → `included`; `reports.execution_scope_principal_kind` → `included`. `report_runs` has no `org_id` (FK-child RLS backstop) and is deliberately absent from the cascade/export/merge registries — **do not add it in this wave** (its `org_id` retrofit is a pre-existing gap, filed as roadmap follow-up by A10); its new `execution_scope_principal_kind` column needs no policy entry. The `aiAgentNarrative` integration test MUST prove an org erasure succeeds after a narrative persisted (covers `report_runs` → `reports` NO ACTION FK).
- Policy snapshot `AI_AGENT_POLICY_SNAPSHOT_VERSION` 6 → 7 (`maxConcurrentNarrativeRuns`, `maxNarrativeRunsPerHour`, `narrativeBudgetCentsPerRun`, `narrativeMaxTurns`); every read site tolerates 1–7 via `?? AI_AGENT_LIMIT_DEFAULTS.x`; every new limit listed in the `runService.ts:38-96` enforcement inventory.
- No `'narrative'`/`isNarrativeProfile`/`NARRATIVE_` literal inside `aiGuardrails.ts`, `executionLedger.ts`, `policyDecide.ts`, `actRevalidation.ts` (`verdictProfile.contract.test.ts` extended). `classifyTerminal` has NO compile-time guard — Task A4 must add the branch by hand and test it.
- Narrative runs are device-less and read-only; the tool floor is **empty** (the context is system-built; no drill-down — it would bypass the reproducible 16-KiB boundary); `maxActionsPerRun` is 0; no intents, no fix-watch. Success is circuit-neutral; genuine runner failures still increment (sweep semantics).
- **Tenancy invariants for every context loader (D6):** every statement predicates its primary AND joined tenant-bearing tables by `orgId` (system context bypasses RLS); `getSecurityPostureTrend` is always called with `{ orgId, days: 14 }` (omitting both org filters returns fleet-wide data — `securityPosture.ts:1077`); alerts pinned by `alerts.org_id`, a rule owner admitted only when `alert_rules.org_id = $org OR (alert_rules.org_id IS NULL AND alert_rules.partner_id = <org's partner>)`; ticket categories joined on `category_id` AND `partner_id`; per-loader failure isolation (`Promise.allSettled` / local catch) — "zero measured" and `unavailable` are distinct; the 16-KiB ceiling is enforced over the entire UTF-8 serialized context (byte-based trimming like `anomalyContext.ts:164`), not per array.
- **Never project** sweep title/detail/evidence, intent arguments/reason/result, ticket subject/body, backup error logs, reliability raw JSON, alert messages, verdict rationales. Counts, closed enums, and sanitized operator-authored names (≤ 256 chars, `\p{C}` stripped via the `sanitizeSweepText` idiom) only. Every jsonb read uses a closed whitelist (`AI_SWEEP_KINDS`, `AI_SWEEP_SEVERITIES`, `SweepProposalDisposition`, `AgentRunVerdict`, fix-watch states). Model-authored output is sanitized at capture (Zod) AND at render (jsPDF arm); keys matching `AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS` are dropped from projections; the narrative context and tool-hook keys are never serialized into the run trace or notifications.
- Report rows written by the system stamp an **`unrestricted` execution scope with `execution_scope_principal_kind = 'system'` and `execution_scope_user_id = NULL`** (Task A3 extends the site-scope contract); never attribute a system artifact to a human user. The download route re-verifies the REQUESTER's live authority (`getReportRunWithOrgCheck` → stored scope ⊆ requester scope), so a site-restricted requester gets 404 — tested.
- Model output contract: `submit_narrative` takes `{ headline, sections: [{ key, bullets }] }` with **all eight `NARRATIVE_SECTION_KEYS` exactly once**; section titles come from the server-owned `NARRATIVE_SECTION_TITLES`; `markdown` is DERIVED by `renderNarrativeMarkdown` from the sanitized sections after validation — the model never authors a second representation.
- DTO rule (wave 6.1): additive nullable fields (`AiAgentRunDetailDto.narrative`, `reportRunId`) → no `AI_AGENT_RUN_DTO_SCHEMA_VERSION` bump.
- Commit after every task with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. PR A body `Part of #4190`; PR B body `Closes #4190`. `get_feature_status LanternOps/breeze#4187` before starting.

## File Structure

### PR A — API + renderer

| File | Responsibility |
|---|---|
| spec §4.3/§5/§9 (modify) | Amendments (A0). |
| `packages/shared/src/types/aiAgentSchedules.ts`, `validators/aiAgentSchedules.ts`, `types/aiAgents.ts`, `validators/aiAgents.ts`, `types/aiAgentRuns.ts`, `types/orgNarrativeReport.ts` (new), barrels | Schedule kind, narrative outcome schema, section titles + markdown renderer, limits v7, profile, DTOs, report payload type (A1). |
| `apps/api/migrations/2026-09-24-a-report-type-ai-org-narrative.sql`, `…-b-ai-agents-org-narrative.sql` (new) | Enum add; `ai_agent_schedules.kind` + CHECKs + composite self-FK; `ai_agent_runs.report_run_id`; profile CHECK; `reports.source_ai_agent_schedule_id` + partial unique; `execution_scope_principal_kind` on `reports`/`report_runs` + re-defined shape CHECKs (A2). |
| `apps/api/src/db/schema/reports.ts`, `aiAgentSchedules.ts`, `aiAgents.ts` (modify); `tenantExportPolicyRegistry.ts` (modify) | Drizzle + export policy (A2). |
| `apps/api/src/services/siteScope.ts` (modify) | System report principal: `SystemReportExecutionAuthority`, `systemReportAuthority`, `persistedSystemSiteScopeValues`, decode + projections (A3). |
| `apps/api/src/services/aiAgents/narrativeProfile.ts` (new), `runService.ts`, `agentCircuit.ts`, `verdictProfile.contract.test.ts` (modify) | Profile + admission + circuit + contract (A4). |
| `apps/api/src/services/aiAgents/narrativeContext.ts` (new) | Bounded 7-day context (loaders + pure assembler) (A5). |
| `apps/api/src/services/aiAgents/outcomeTools.ts`, `runLoop.ts`, `runnerPrompt.ts` (modify) | `submit_narrative`, context load, prompt, finish gating, `finalizeNarrative` seam (A6). |
| `apps/api/src/services/aiAgents/narrativeReport.ts` (new) | `persistNarrativeReport` (one transaction: lock run, find-or-create definition, insert artifact, CAS link), `projectNarrative` (A7). |
| `apps/api/src/services/reportGenerationService.ts`, `routes/reports/schemas.ts`, `jobs/reportScheduleWorker.ts` (modify) | `StoredArtifactOnlyReportError`; `reportTypeSchema` rejects the internal type; `findDueReports` + `processRunScheduledReport` exclude it (A7). |
| `apps/api/src/services/aiAgents/runTrace.ts`, `runFinishedNotify.ts`, `routes/aiAgents.ts` (modify) | Projection; notification title/link (A7). |
| `apps/api/src/services/aiAgents/scheduleService.ts`, `routes/aiAgentSchedules.ts`, `jobs/aiAgentSweepScheduler.ts` (modify) | `kind` on schedules; narrative fan-out branch (A8). |
| `packages/shared/src/reportPdf/reportPdf.ts` (modify) | `ai_org_narrative` render arm + label (A9). |
| Integration: `aiAgentSchedulesPartnerRls.integration.test.ts` (extend), `report-site-scope` suite (extend), `aiAgentNarrative.integration.test.ts` (new) | CHECK/enum equality; system principal round-trip; fan-out → run → report rows → download authority → erasure. |

### PR B — web

| File | Responsibility |
|---|---|
| `apps/web/src/components/reports/ReportsList.tsx`, `ReportBuilder.tsx` (modify), `locales/*/reports.json` | Type union, labels (3 paths × 8 locales), builder map entry; system-managed rows: "Open latest" instead of Generate/Edit, "Managed by AI schedule" instead of the computed next occurrence (B1). |
| `apps/web/src/components/aiAgents/RunDetailPage.tsx`, `RunsListPage.tsx`, `locales/*/settings.json` | Narrative section + report link; badge (B2). |
| `apps/web/src/components/settings/AiAgentSchedulesSection.tsx`, `locales/*/settings.json` | Kind selector; narrative hides kinds; weekly default; org override shows `enabled` only (B2). |

---

## PR A — API + renderer

### Task 0 (A0): Spec amendments

**Files:** Modify `docs/superpowers/specs/ai-mcp/2026-08-28-ai-agents-phase2-intelligence-layer-design.md` §4.3 (lines 108-116), §5 rows (`ai_agent_runs`, `ai_agent_schedules`, `reports.report_type`), §9 quorum table.

- [ ] **Step 1: Append to §4.3 "Trigger"**:
```markdown
**Amendment (P2-3 plan, 2026-08-29):** `narrative` is a schedule **kind** (`ai_agent_schedules.kind IN ('sweep','narrative')`; a narrative schedule is its own row with `sweep_kinds = '{}'`; org rows inherit the baseline's kind via a composite self-FK and expose only `enabled`; weekly default `0 7 * * 1`; **the cron must be weekly** — minute/hour literal, day-of-month and month `*`, a single day-of-week — so the report definition's `schedule = 'weekly'` is truthful), not an `AiSweepKind` — every sweep kind must own an evidence loader. The occurrence job admits one `profile: 'narrative'` run per live org (`dedupeKey narrative-<schedule>-<org>-<occurrence>`).
```
- [ ] **Step 2: Append to §4.3 "Inputs"**:
```markdown
**Amendment (P2-3 plan):** three inputs are reported as "not measured" rather than derived: alerts *suppressed in the window* (no `suppressed_at`; only a current-state count exists), the device *online/offline delta* (no status history; current state + enrolled-in-window + mean `uptime_7d` instead), and the patch-compliance delta (taken from `security_posture_org_snapshots.patch_compliance_score` day-buckets over 14 days; `patch_compliance_snapshots` has no writer). Every context field carries an explicit availability flag the prompt renders honestly; the 16-KiB ceiling applies to the whole serialized context.
```
- [ ] **Step 3: Replace §4.3 "Outcome"'s first sentence** with:
```markdown
**Outcome.** The run is `profile: 'narrative'` (a `full`-profile run cannot reach an outcome tool) with an EMPTY tool floor + `submit_narrative`; the model submits `{ headline, sections: [{ key ∈ NARRATIVE_SECTION_KEYS (all eight, exactly once), bullets }] }` — titles and markdown are server-owned. Stored in one transaction as a system-authored `reports` DEFINITION row per (org, schedule) (`type 'ai_org_narrative'`, `schedule 'weekly'`, `format 'pdf'`, `source_ai_agent_schedule_id` = the schedule, execution scope `unrestricted` with `execution_scope_principal_kind = 'system'` and no user) plus one `report_runs` row per narrative carrying `result.summary.narrative`; `ai_agent_runs.report_run_id` links the artifact (CAS on `IS NULL`). The report worker never runs the AI type (`findDueReports` and `processRunScheduledReport` exclude it; `generateReport('ai_org_narrative')` throws `StoredArtifactOnlyReportError`; create/ad-hoc schemas reject the type). Rendered from `sections[]` by the jsPDF renderer (no markdown-to-PDF). Delivery v1 = in-app notification to the agent's recipients + the protected download route; email is deferred until recipients can be filtered through `resolveLiveReportAuthority(userId, orgId, 'export')` requiring `unrestricted`.
```
- [ ] **Step 4: §5** — `ai_agent_runs` row: replace `report_id uuid NULL FK reports SET NULL` with `report_run_id uuid NULL FK report_runs SET NULL (P2-3)`; `ai_agent_schedules` row: append `; kind text NOT NULL DEFAULT 'sweep' CHECK IN ('sweep','narrative'); CHECK ((kind='narrative' AND cardinality(sweep_kinds)=0) OR (kind='sweep' AND (org_id IS NOT NULL OR cardinality(sweep_kinds)>0))); FK (baseline_schedule_id, kind) → (id, kind)`; add rows `reports: + source_ai_agent_schedule_id uuid NULL FK ai_agent_schedules SET NULL, partial UNIQUE (org_id, source_ai_agent_schedule_id); + execution_scope_principal_kind text NULL CHECK IN ('user','system') (P2-3)` and `report_runs: + execution_scope_principal_kind (same) (P2-3)`; keep the `reports.report_type` row.
- [ ] **Step 5: §9** — append these rows (same column shape as the P2-2 rows):
  - `P2-3 D1 schedule shape` — Fable: `kind` column + XOR-with-empty-kinds CHECK. Codex: DISAGREE — the XOR rejects valid sweep org overrides holding `'{}'`; use the two-arm CHECK, composite self-FK on `(baseline_schedule_id, kind)`, weekly-only narrative cron. **Adopted.**
  - `P2-3 D2 narrative profile` — both: `profile:'narrative'`, empty floor, limits v7, circuit-neutral success, notify after persistence, no watch. **Agreed.**
  - `P2-3 D3 storage + linkage` — Fable: `unrestricted` scope stamped from `ai_agents.created_by`; app-level find-or-create. Codex: DISAGREE — forged attribution; add a system principal (`principal_kind`); `report_runs` lacks `org_id`; find-or-create races. **Adopted** system principal, typed `reports.source_ai_agent_schedule_id` + partial unique, single-transaction CAS finalizer; the `report_runs.org_id` retrofit is pre-existing and filed as a roadmap item (not this wave). Only `report_run_id` stored on the run.
  - `P2-3 D4 rendering + delivery` — rendering AGREED (jsPDF arm, server-owned titles/order, derived markdown). Delivery: Codex DISAGREE — `resolveRecipientUserIds` does not verify `reports:export` or unrestricted site authority; email attaches full-org data. **Adopted:** v1 = in-app notification + protected download; email deferred (roadmap).
  - `P2-3 D5 report-worker interplay` — Fable: `generateReport` re-serves the latest snapshot. Codex: DISAGREE — the Generate route inserts a new `report_runs` row and advances `last_generated_at` (false provenance); exclude the type in `findDueReports` AND `processRunScheduledReport`, throw `StoredArtifactOnlyReportError`, reject the type in create/ad-hoc schemas, UI shows "Open latest". **Adopted.**
  - `P2-3 D6 context` — AGREED with the tenancy invariants now in the plan's Global Constraints (org pin on every joined table, posture trend `{orgId}`, rule owner admission rule, category join on `partner_id`, per-loader isolation, whole-context byte ceiling).
- [ ] **Step 6: Commit** — `docs(spec): P2-3 amendments — narrative schedule kind, narrative profile, system report principal, report_run_id linkage, worker exclusion (#4190)`.

---

### Task 1 (A1): Shared — schedule kind, narrative outcome, section titles + markdown, limits v7, profile, DTOs, report payload

**Files:** `packages/shared/src/types/aiAgentSchedules.ts`, `validators/aiAgentSchedules.ts`, `types/aiAgents.ts`, `validators/aiAgents.ts`, `types/aiAgentRuns.ts`, `types/orgNarrativeReport.ts` (new), `validators/orgNarrative.ts` (new), barrels; tests `validators/aiAgentSchedules.test.ts`, `types/aiAgents.test.ts`, `validators/orgNarrative.test.ts` (new).

**Interfaces — Produces:**
```ts
export const AI_AGENT_SCHEDULE_KINDS = ['sweep', 'narrative'] as const;
export type AiAgentScheduleKind = (typeof AI_AGENT_SCHEDULE_KINDS)[number];
export const NARRATIVE_SECTION_KEYS = ['overview','alerts','sweeps_and_fixes','tickets','patching_and_security','backups','fleet','recommendations'] as const;
export type NarrativeSectionKey = (typeof NARRATIVE_SECTION_KEYS)[number];
export const NARRATIVE_SECTION_TITLES: Record<NarrativeSectionKey, string>; // 'Overview','Alerts','Sweeps & fixes','Tickets','Patching & security','Backups','Fleet','Recommendations'
export const NARRATIVE_BULLET_MAX_CHARS = 240; export const NARRATIVE_BULLETS_PER_SECTION_MAX = 8; export const NARRATIVE_HEADLINE_MAX_CHARS = 160; export const NARRATIVE_MARKDOWN_MAX_CHARS = 12288;
export interface NarrativeSubmission { headline: string; sections: Array<{ key: NarrativeSectionKey; bullets: string[] }> }   // what the MODEL submits
export const narrativeSubmissionSchema: z.ZodType<NarrativeSubmission>; // .strict(); headline 1–160; sections EXACTLY 8, every key present once (superRefine); bullets 1–8 × 1–240; every string refined: no \p{C}; transform trims + collapses whitespace
export interface NarrativeSection { key: NarrativeSectionKey; title: string; bullets: string[] }   // stored/rendered shape (title from NARRATIVE_SECTION_TITLES)
export interface NarrativeOutcome { version: 1; headline: string; sections: NarrativeSection[]; markdown: string }   // AgentRunOutcome.narrative — server-built from a submission
export function narrativeOutcomeFromSubmission(s: NarrativeSubmission): NarrativeOutcome;  // canonical key order, titles attached, markdown = renderNarrativeMarkdown(...)
export function renderNarrativeMarkdown(headline: string, sections: NarrativeSection[]): string; // `# ${headline}\n\n## ${title}\n- bullet\n…`; bullets containing '\n' or leading '-'/'#' are flattened; result ≤ NARRATIVE_MARKDOWN_MAX_CHARS (truncate on a line boundary)
export interface OrgNarrativeReportSummary {   // report_runs.result.summary.narrative — ALL optional (legacy snapshots must render)
  narrative?: { version?: number; headline?: string; sections?: NarrativeSection[]; markdown?: string; orgName?: string; partnerName?: string; periodStart?: string; periodEnd?: string; generatedAt?: string; runId?: string; agentName?: string; contextTruncated?: boolean };
}
export interface AiAgentRunNarrativeDto { headline: string; sections: NarrativeSection[]; reportRunId: string | null; reportId: string | null; downloadPath: string | null; periodStart: string | null; periodEnd: string | null; contextTruncated: boolean }
// AiAgentRunDetailDto: narrative: AiAgentRunNarrativeDto | null; reportRunId: string | null (additive, no version bump)
// AiAgentRunProfile adds 'narrative'; AI_AGENT_POLICY_SNAPSHOT_VERSION = 7; limits: maxConcurrentNarrativeRuns (1, 1–5), maxNarrativeRunsPerHour (5, 1–50), narrativeBudgetCentsPerRun (20, 5–100), narrativeMaxTurns (3, 2–8)
// AiAgentScheduleDto/EffectiveDto gain kind: AiAgentScheduleKind
// createAiAgentScheduleSchema partner branch: kind (default 'sweep'); when kind === 'narrative' → sweepKinds must be [] (or omitted) and cron must satisfy isWeeklyLiteralCron; when 'sweep' → existing rules
// org override branch: unchanged (kinds [] allowed; kind is never accepted — it is inherited)
// updateAiAgentScheduleSchema: never admits kind; for narrative baselines the service additionally rejects sweepKinds changes (A8)
export function isWeeklyLiteralCron(cron: string): boolean; // 5 fields; minute int 0–59; hour int 0–23; dom '*'; month '*'; dow single int 0–6
```

- [ ] **Step 1: Failing tests** — `validators/aiAgentSchedules.test.ts`: narrative partner create accepts `{ ownerScope:'partner', kind:'narrative', agentId, cron:'0 7 * * 1', timezone:'UTC', enabled:true }`; rejects narrative with `sweepKinds:['disk_pressure']`; rejects narrative crons `0 * * * *`, `0 7 * * *`, `0 7,19 * * 1`, `0 7 1 * *`, `0 7 * * 1,3`; accepts `30 18 * * 5`; sweep create unchanged; update rejects `kind`; org override rejects `kind`. `validators/orgNarrative.test.ts`: happy path (8 sections) → `narrativeOutcomeFromSubmission` yields canonical order + titles + markdown starting `# `; 7 sections rejected; duplicate key rejected; unknown key rejected; bullet 241 chars rejected; 9 bullets rejected; control char (``) rejected; `renderNarrativeMarkdown` flattens `"a\n- b"` to one bullet line and caps at 12288 on a line boundary. `types/aiAgents.test.ts`: version 7, four defaults + ranges, profiles `['full','verdict','sweep','narrative']`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** per Interfaces (v7 docstring line; `isWeeklyLiteralCron` beside `isHourlyFloorCron`; `.max(6)` literals unchanged).
- [ ] **Step 4: Run** → PASS; `cd packages/shared && npx tsc --noEmit -p tsconfig.json` (3 pre-existing `quotes.test.ts` errors only).
- [ ] **Step 5: Commit** — `feat(shared): P2-3 types — schedule kind, narrative submission/outcome, section titles + markdown renderer, limits v7, narrative profile, DTOs (#4190)`.

---

### Task 2 (A2): Migrations + Drizzle + export policy + contract tests

**Files:**
- Create: `apps/api/migrations/2026-09-24-a-report-type-ai-org-narrative.sql`, `apps/api/migrations/2026-09-24-b-ai-agents-org-narrative.sql`
- Modify: `apps/api/src/db/schema/reports.ts` (enum; `sourceAiAgentScheduleId`, `executionScopePrincipalKind` on `reports`; `executionScopePrincipalKind` on `reportRuns`), `apps/api/src/db/schema/aiAgentSchedules.ts` (`kind`), `apps/api/src/db/schema/aiAgents.ts:~96-103` (`reportRunId` after `scheduleId`), `apps/api/src/services/tenantExportPolicyRegistry.ts` (four column adds), `apps/api/src/__tests__/integration/aiAgentSchedulesPartnerRls.integration.test.ts` (profile CHECK equality now includes `narrative`; kind CHECK cases; enum label present; composite self-FK)
- Test: `apps/api/src/db/schema/aiAgentNarrative.test.ts`

**Interfaces:** Produces `aiAgentSchedules.kind: AiAgentScheduleKind`, `aiAgentRuns.reportRunId: uuid | null`, `reports.sourceAiAgentScheduleId: uuid | null`, `reports.executionScopePrincipalKind` / `reportRuns.executionScopePrincipalKind: 'user' | 'system' | null`, `reportTypeEnum` incl. `'ai_org_narrative'`.

- [ ] **Step 1: Failing schema test**
```ts
// apps/api/src/db/schema/aiAgentNarrative.test.ts
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { aiAgentSchedules } from './aiAgentSchedules';
import { aiAgentRuns } from './aiAgents';
import { reportRuns, reports, reportTypeEnum } from './reports';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';

describe('P2-3 schema', () => {
  it('adds the P2-3 columns', () => {
    expect(getTableColumns(aiAgentSchedules).kind).toBeDefined();
    expect(getTableColumns(aiAgentRuns).reportRunId).toBeDefined();
    expect(getTableColumns(reports).sourceAiAgentScheduleId).toBeDefined();
    expect(getTableColumns(reports).executionScopePrincipalKind).toBeDefined();
    expect(getTableColumns(reportRuns).executionScopePrincipalKind).toBeDefined();
  });
  it('report_type enum carries ai_org_narrative', () => {
    expect(reportTypeEnum.enumValues).toContain('ai_org_narrative');
  });
  it('export policy classifies the new org-cascade columns', () => {
    // mirror the exact accessor shape used in aiAgentSchedules.test.ts
    expect(CORE_TENANT_EXPORT_POLICY.ai_agent_schedules.columns.kind).toBeDefined();
    expect(CORE_TENANT_EXPORT_POLICY.ai_agent_runs.columns.report_run_id).toBeDefined();
    expect(CORE_TENANT_EXPORT_POLICY.reports.columns.source_ai_agent_schedule_id).toBeDefined();
    expect(CORE_TENANT_EXPORT_POLICY.reports.columns.execution_scope_principal_kind).toBeDefined();
  });
});
```

- [ ] **Step 2: Run** — `cd apps/api && npx vitest run src/db/schema/aiAgentNarrative.test.ts` → FAIL.

- [ ] **Step 3: Migrations**
```sql
-- apps/api/migrations/2026-09-24-a-report-type-ai-org-narrative.sql
-- Phase 2 wave P2-3 (#4187 / #4190): AI weekly org narrative report type.
-- ALTER TYPE ... ADD VALUE is the ONLY statement in this file (see
-- 2026-06-29-a-report-type-security-compliance.sql for why). IF NOT EXISTS
-- makes re-application a no-op.
ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'ai_org_narrative';
```
```sql
-- apps/api/migrations/2026-09-24-b-ai-agents-org-narrative.sql
-- Phase 2 wave P2-3 (#4187 / #4190): weekly org narrative.
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file).

-- 1. ai_agent_schedules.kind — a narrative schedule is its own row; org rows inherit
--    the baseline's kind through a composite self-FK.
ALTER TABLE ai_agent_schedules ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'sweep';
ALTER TABLE ai_agent_schedules DROP CONSTRAINT IF EXISTS ai_agent_schedules_kind_chk;
ALTER TABLE ai_agent_schedules ADD CONSTRAINT ai_agent_schedules_kind_chk CHECK (kind IN ('sweep', 'narrative'));
-- Sweep org overrides may legitimately hold '{}' (= disabled, P2-2), so the empty-kinds
-- rule is per arm, not an XOR.
ALTER TABLE ai_agent_schedules DROP CONSTRAINT IF EXISTS ai_agent_schedules_kind_kinds_chk;
ALTER TABLE ai_agent_schedules ADD CONSTRAINT ai_agent_schedules_kind_kinds_chk CHECK (
  (kind = 'narrative' AND cardinality(sweep_kinds) = 0)
  OR (kind = 'sweep' AND (org_id IS NOT NULL OR cardinality(sweep_kinds) > 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_schedules_id_kind_uniq ON ai_agent_schedules (id, kind);
-- ON DELETE must match the existing baseline_schedule_id FK from 2026-09-23 (verify: CASCADE).
ALTER TABLE ai_agent_schedules DROP CONSTRAINT IF EXISTS ai_agent_schedules_baseline_kind_fk;
ALTER TABLE ai_agent_schedules ADD CONSTRAINT ai_agent_schedules_baseline_kind_fk
  FOREIGN KEY (baseline_schedule_id, kind) REFERENCES ai_agent_schedules (id, kind) ON DELETE CASCADE;

-- 2. ai_agent_runs.report_run_id — the narrative ARTIFACT this run produced.
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS report_run_id uuid NULL
  REFERENCES report_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ai_agent_runs_report_run_idx ON ai_agent_runs (report_run_id) WHERE report_run_id IS NOT NULL;

-- 3. profile CHECK admits 'narrative'.
ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_profile_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_profile_chk CHECK (profile IN ('full', 'verdict', 'sweep', 'narrative'));

-- 4. reports.source_ai_agent_schedule_id — typed identity of the schedule that owns a
--    system-managed definition; the partial unique makes find-or-create idempotent.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS source_ai_agent_schedule_id uuid NULL
  REFERENCES ai_agent_schedules(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reports_source_ai_agent_schedule_uniq
  ON reports (org_id, source_ai_agent_schedule_id) WHERE source_ai_agent_schedule_id IS NOT NULL;

-- 5. System report principal. NULL = legacy/user rows (unchanged semantics).
ALTER TABLE reports ADD COLUMN IF NOT EXISTS execution_scope_principal_kind text NULL;
ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS execution_scope_principal_kind text NULL;
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_execution_scope_principal_chk;
ALTER TABLE reports ADD CONSTRAINT reports_execution_scope_principal_chk CHECK (
  execution_scope_principal_kind IS NULL OR execution_scope_principal_kind IN ('user', 'system')
);
ALTER TABLE report_runs DROP CONSTRAINT IF EXISTS report_runs_execution_scope_principal_chk;
ALTER TABLE report_runs ADD CONSTRAINT report_runs_execution_scope_principal_chk CHECK (
  execution_scope_principal_kind IS NULL OR execution_scope_principal_kind IN ('user', 'system')
);
-- Re-define the shape CHECKs from 2026-08-06-a (never edit that file): the 'unrestricted'
-- arm now admits user_id NULL iff principal_kind = 'system'; 'system' is never 'restricted'.
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_execution_scope_shape_chk;
ALTER TABLE reports ADD CONSTRAINT reports_execution_scope_shape_chk CHECK ((
  (execution_scope_version IS NULL AND execution_scope_kind IS NULL AND execution_scope_site_ids IS NULL
   AND execution_scope_user_id IS NULL AND execution_scope_fingerprint IS NULL AND execution_scope_captured_at IS NULL
   AND execution_scope_principal_kind IS NULL)
  OR (
    execution_scope_version = 1 AND execution_scope_fingerprint IS NOT NULL AND execution_scope_captured_at IS NOT NULL
    AND (
      (execution_scope_kind = 'restricted' AND execution_scope_site_ids IS NOT NULL AND execution_scope_user_id IS NOT NULL
       AND execution_scope_principal_kind IS DISTINCT FROM 'system')
      OR (execution_scope_kind = 'unrestricted' AND execution_scope_site_ids IS NULL
          AND ((execution_scope_principal_kind = 'system' AND execution_scope_user_id IS NULL)
               OR (execution_scope_principal_kind IS DISTINCT FROM 'system' AND execution_scope_user_id IS NOT NULL)))
      OR (execution_scope_kind = 'legacy_unscoped' AND execution_scope_site_ids IS NULL
          AND execution_scope_principal_kind IS DISTINCT FROM 'system')
    )
  )
));
-- (copy the report_runs shape CHECK verbatim from 2026-08-06-a, then apply the identical
--  three-arm edit — the two tables must stay in lockstep.)
ALTER TABLE report_runs DROP CONSTRAINT IF EXISTS report_runs_execution_scope_shape_chk;
ALTER TABLE report_runs ADD CONSTRAINT report_runs_execution_scope_shape_chk CHECK (( /* same body as reports */ ));
```
Read the original `legacy_unscoped` arm in `2026-08-06-a-report-site-scope.sql` before writing it — reproduce its exact user-id rule (it allows NULL or NOT NULL) and only add the `principal_kind` clause.

- [ ] **Step 4: Drizzle** — `reports.ts` enum add; `reports.sourceAiAgentScheduleId: uuid('source_ai_agent_schedule_id').references(() => aiAgentSchedules.id, { onDelete: 'set null' })` (import cycle check: if `aiAgentSchedules.ts` imports `reports.ts`, declare the FK with a `sql` reference comment instead of `.references`), `executionScopePrincipalKind: text('execution_scope_principal_kind').$type<'user' | 'system'>()` on both tables; `aiAgentSchedules.ts` `kind: text('kind').$type<AiAgentScheduleKind>().notNull().default('sweep')`; `aiAgents.ts` `reportRunId: uuid('report_run_id').references(() => reportRuns.id, { onDelete: 'set null' })` with a comment: "the narrative ARTIFACT (`report_runs`), not the definition — the trace links to something downloadable; the definition is `report_runs.report_id`". Export policy: `ai_agent_schedules` `included` += `kind`; `ai_agent_runs` `included` += `report_run_id`; `reports` `included` += `source_ai_agent_schedule_id`, `execution_scope_principal_kind`.
- [ ] **Step 5: Integration** — extend `aiAgentSchedulesPartnerRls.integration.test.ts`: profile-CHECK equality (now 4 values) still passes against `AI_AGENT_RUN_PROFILES`; kind-CHECK equality against `AI_AGENT_SCHEDULE_KINDS`; `describe('ai_agent_schedules_kind_kinds_chk')`: partner narrative row with `'{}'` inserts; partner narrative row with kinds → 23514; partner sweep row with `'{}'` → 23514; sweep org override with `'{}'` inserts (P2-2 behaviour preserved); org override with `kind='sweep'` on a narrative baseline → 23503 (composite FK); `SELECT unnest(enum_range(NULL::report_type))` contains `ai_org_narrative`; `profile='narrative'` insert succeeds; `reports` with `principal_kind='system'` + `user_id NULL` + `unrestricted` inserts, same with `user_id NOT NULL` → 23514, `restricted` + `system` → 23514, second definition for the same `(org, schedule)` → 23505.
- [ ] **Step 6: Run** — schema test + `npx vitest run src/db/autoMigrate.test.ts` (naming/ordering) + the integration file against the test DB (non-zero counts).
- [ ] **Step 7: Commit** — `feat(api): P2-3 migrations — report_type ai_org_narrative, schedule kind + composite self-FK, runs.report_run_id, system report principal, typed report schedule identity (#4190)`.

---

### Task 3 (A3): System report principal in the site-scope contract

**Files:** `apps/api/src/services/siteScope.ts` (modify), `apps/api/src/routes/reports/helpers.ts` (`reportRunMetadataProjection` + any other projection feeding `decodeSiteScope`), `apps/api/src/routes/reports/runs.ts` (download select), `apps/api/src/routes/reports/core.ts`, `apps/api/src/jobs/reportScheduleWorker.ts` (its projection), tests `siteScope.test.ts`, `routes/reports/runs.test.ts`, integration `report-site-scope` suite (extend).

**Interfaces — Produces:**
```ts
export interface PersistedSiteScopeColumns { …existing; executionScopePrincipalKind: 'user' | 'system' | null }
export interface SystemReportExecutionAuthority { principalKind: 'system'; scope: { version: 1; kind: 'unrestricted'; orgId: string }; fingerprint: string; capturedAt: Date }
export function systemReportAuthority(orgId: string, capturedAt?: Date): SystemReportExecutionAuthority;
export function persistedSystemSiteScopeValues(a: SystemReportExecutionAuthority): PersistedSiteScopeColumns; // version 1, kind 'unrestricted', siteIds null, userId null, principalKind 'system'
// persistedSiteScopeValues (user path) now emits executionScopePrincipalKind: 'user'
// decodeSiteScope: 'unrestricted' arm accepts executionScopeUserId === null iff executionScopePrincipalKind === 'system'; any other kind with principalKind 'system' throws
```
- [ ] **Step 1: Failing tests** — `siteScope.test.ts`: `persistedSystemSiteScopeValues` shape; `decodeSiteScope` on a system row → `{kind:'unrestricted'}`; a system row with a userId throws; a `restricted` row with principal `system` throws; a legacy all-null row still decodes `legacy_unscoped`; a user row missing `principalKind` (NULL — pre-migration rows) still decodes (backwards compatible). Grep every `executionScopeCapturedAt:` projection in `apps/api/src` (routes/reports/*, jobs/reportScheduleWorker.ts, services/*) and add `executionScopePrincipalKind` to each — a projection that omits it makes `decodeSiteScope` see `userId NULL` + `principalKind undefined` and throws → download 404. Test in `runs.test.ts`: download of a system-authored run by an unrestricted requester → 200; by a site-restricted requester → 404; the download select includes the new column (assert the projection object has the key).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Also `reportScheduleWorker.processRunScheduledReport`: a definition whose `executionScopePrincipalKind === 'system'` is skipped with a logged reason (`system_principal_definition`) before any authority resolution (defence in depth; A7 adds the type exclusion).
- [ ] **Step 4: Run** unit + `report-site-scope` integration (add: insert a system-principal definition + run as `breeze_app`, decode via the route helper, cross-org forge → 42501). **Step 5: Commit** — `feat(api): system report principal — execution_scope_principal_kind in the site-scope contract (#4190)`.

---

### Task 4 (A4): `narrative` profile — admission, circuit, contract

**Files:** `apps/api/src/services/aiAgents/narrativeProfile.ts` (new + test), `runService.ts` (`profileCaps` arm, skip reasons `max_concurrent_narrative_runs | narrative_rate`, inventory), `agentCircuit.ts:146-161` (`completed`/`awaiting_approval` → `neutral` for `'narrative'`, docstring), `verdictProfile.contract.test.ts` (narrative literals + "narrative floor is empty"), tests `runService.test.ts`, `agentCircuit.test.ts`.

**Interfaces — Produces:** `NARRATIVE_TOOL_ALLOWLIST = [] as const`; `isNarrativeProfile(run)`; `narrativeLimits(limits)` (turns = `narrativeMaxTurns`, budget = `narrativeBudgetCentsPerRun`, `maxActionsPerRun: 0`); `narrativeToolAllowlist(_)` = `OUTCOME_TOOL_NAMES.filter(n => n === 'submit_narrative')`.

- [ ] Tests first (mirror `sweepProfile.test.ts`; `agentCircuit.test.ts` rows for narrative → neutral on `completed`/`awaiting_approval`, increment on allowlisted failure; `classifyTerminal('narrative', …)` explicitly — no compile guard; `runService.test.ts` counters isolated from sweep/full, no cooldown). Implement. Run. Commit `feat(api): narrative run profile — empty floor, v7 limits, own counters, circuit-neutral (#4190)`.

---

### Task 5 (A5): `narrativeContext.ts` — bounded 7-day context

**Files:** `apps/api/src/services/aiAgents/narrativeContext.ts` (new), test `narrativeContext.test.ts`.

**Interfaces — Produces:**
```ts
export const NARRATIVE_CONTEXT_HARD_LIMIT_BYTES = 16 * 1024;
export const NARRATIVE_TOP_N = 10;
export interface NarrativeContext {
  org: { name: string; partnerName: string; timezone: string; deviceCount: number; siteCount: number };
  period: { start: string; end: string };   // ISO, partner timezone week boundaries
  alerts: { available: boolean; created: number; resolved: number; autoResolved: number; critical: number; currentlySuppressed: number; topRules: Array<{ name: string; count: number; highOrCritical: number }>; topRulesTruncated: boolean; verdicts: Record<AiAlertVerdictClassification, number>; feedbackUp: number; feedbackDown: number; groupsCreated: number };
  sweeps: { available: boolean; runs: number; completed: number; failed: number; findingsByKind: Record<AiSweepKind, number>; findingsBySeverity: Record<AiSweepSeverity, number>; proposals: Record<SweepProposalDisposition, number>; evidenceTruncatedRuns: number };
  fixes: { available: boolean; runVerdicts: Record<AgentRunVerdict, number>; intentsByStatus: Record<string, number>; watches: { heldQualified: number; recurred: number; inconclusive: number; watching: number } };
  tickets: { available: boolean; opened: number; closed: number; openedHigh: number; byCategory: Array<{ name: string; opened: number; closed: number }>; byCategoryTruncated: boolean };
  patching: { available: boolean; patchScoreThisWeek: number | null; patchScorePriorWeek: number | null; overallScoreThisWeek: number | null; pendingPatches: number; devicesPending: number; installed7d: number };
  backups: { available: boolean; ok: number; failed: number; partial: number; terminal: number; successRatePct: number | null; devicesFailed: number };
  fleet: { available: boolean; total: number; online: number; offline: number; decommissioned: number; enrolled7d: number; stale: number; avgUptime7dPct: number | null; deltaAvailable: false };
  unavailable: string[];   // fixed: 'alerts.suppressedInWindow','fleet.onlineOfflineDelta'; plus '<block>' for every loader that rejected
  truncated: boolean;
}
export function assembleNarrativeContext(raw: RawNarrativeInputs): NarrativeContext;   // pure: clamps names ≤ 256 via sanitize, caps topRules/byCategory at NARRATIVE_TOP_N (loaders fetch N+1), then the WHOLE-context byte ceiling (Buffer.byteLength(JSON.stringify(ctx))): drops byCategory tail, then topRules tail, one entry at a time, sets truncated
export async function loadNarrativeContext(orgId: string): Promise<NarrativeContext>;  // caller holds a system context; Promise.allSettled over the nine loaders — a rejected loader yields available:false + an `unavailable` entry, never throws; every statement org-pinned on the primary AND joined tables; late-bound db accessor
```
Statements (org-pinned; from the recon + D6): alerts lifecycle on `alerts.org_id` (`resolved_by IS NULL` = auto); top rules `LEFT JOIN alert_rules r ON r.id = a.rule_id AND (r.org_id = $org OR (r.org_id IS NULL AND r.partner_id = $partner))` `LIMIT 11`; verdict histogram (`superseded_by IS NULL`, pinned by the alert's org); groups created; sweeps via `jsonb_array_elements` guarded by `jsonb_typeof(...) = 'array'` on `profile='sweep'` runs with `org_id = $org` (window `queued_at`); fixes: `outcome->>'runVerdict'` histogram, `action_intents` by status for `source='ai_agent' AND org_id = $org`, `ai_agent_fix_watches.state` pinned by org; tickets on `tickets.org_id` by `ticket_categories.name` (`JOIN ticket_categories c ON c.id = t.category_id AND c.partner_id = $partner`, `c.deleted_at IS NULL`, `LIMIT 11`); patching via `getSecurityPostureTrend({ orgId, days: 14 })` day buckets + `device_patches` joined to `devices` on `org_id = $org` with `OUTSTANDING_DEVICE_PATCH_STATUSES`; backups terminal states joined to devices by org; fleet current state + `enrolled_at` + `device_reliability.uptime_7d` avg (joined by org); header from `organizations`/`partners`/`sites`.

- [ ] **Step 1: Failing assembler tests** (pure, fixtures): passes small input untouched with `truncated:false`; caps topRules at 10 and sets `topRulesTruncated` when 11 given; the byte ceiling (measured on the whole serialized context) drops category tail first and never a partial entry; names containing `\n`/control chars are flattened; `patching.available=false` when both snapshots null; `unavailable` lists the two fixed keys + any block whose loader rejected; a rejected loader leaves the other blocks intact (`allSettled`). **Compiled-SQL tests** per loader: org pin count on each statement (primary + joined table) and bound params (the P2-2 `sqlText`/`boundParams` idiom), `partner_id` in the category join, the rule-owner admission clause, `LIMIT 11` on the two top-N statements, `jsonb_typeof` guard present, `deleted_at is null` on categories, `superseded_by is null` on verdicts; `getSecurityPostureTrend` called with `{ orgId, days: 14 }` (spy).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Commit** — `feat(api): narrativeContext — bounded 7-day org context (16 KiB), honest availability flags, org-pinned loaders (#4190)`.

---

### Task 6 (A6): `submit_narrative`, run loop, prompt

**Files:** `outcomeTools.ts` (`OUTCOME_TOOL_NAMES` + `'submit_narrative'`, MCP name, `outcomeToolsForProfile('narrative')`, `validateOutcomeToolInput` overload → `narrativeSubmissionSchema`, `SUBMIT_NARRATIVE_SHAPE` with `.describe()` on every field incl. the closed section-key enum and "all eight keys exactly once"), `runLoop.ts` (`AgentRunOutcome.narrative?: NarrativeOutcome` built via `narrativeOutcomeFromSubmission` in the post-hook; `RunContext.narrative: { scheduleId; occurrenceKey; context: NarrativeContext } | null` loaded in `loadRunContext` when `isNarrativeProfile`; profile branch adds the narrative arm for `runLimits`/`profileAllowlist`; `producedSomething || outcome.narrative !== undefined`; `finishRun`: `watches` gains `&& !isNarrativeProfile`; a comment seam `// Task A7: finalizeNarrative`), `runnerPrompt.ts` (`AgentRunNarrativePromptContext`; system-prompt `## Mode: narrative` before shadow/act; `buildNarrativeTaskPrompt` — complete replacement: period, org header, each input block as `label: number` lines, `(not measured)` for unavailable keys, the eight section keys with one-line guidance each, "write for the customer's IT decision-maker; no raw identifiers; never invent numbers; every section must have at least one bullet", ends `Call submit_narrative exactly once, then stop.`), tests `outcomeTools.test.ts`, `runnerPrompt.test.ts`, `runLoop.narrative.test.ts`.

- [ ] Tests first: outcome tool registered only for `narrative`; a narrative run's `onlyTools` is empty and `extraTools` is exactly `submit_narrative`; sweep/verdict/full runs deny it; post-hook captures `outcome.narrative` with titles + markdown derived; a submission with 7 sections is rejected at the tool boundary with a message naming the missing key; context loaded only for narrative runs (system scope, `loadNarrativeContext(run.orgId)`); prompt renders `(not measured)` for unavailable inputs and never contains `"sections"`/JSON dumps/raw ids; recursive `.describe()` walk incl. the section-key enum; the run trace/tool-hook serialization never includes `context` (tripwire test in `runTrace.test.ts` — extend `AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS` coverage with `narrativeContext`). Implement (`verdictToolAllowlist`/`sweepToolAllowlist` unchanged; exposure contract test in `outcomeTools.test.ts` extends the `Record<AiAgentRunProfile,…>`). Run. Commit `feat(api): submit_narrative outcome tool, narrative run-loop exposure + prompt (#4190)`.

---

### Task 7 (A7): Persist the report in one transaction; link the run; project; notify; worker interplay

**Files:** `apps/api/src/services/aiAgents/narrativeReport.ts` (new + test), `runLoop.ts` (`finalizeNarrative`, `verdictErrorCode ?? sweepErrorCode ?? narrativeErrorCode`), `runTrace.ts` (+ `narrative`, `reportRunId`), `routes/aiAgents.ts` (select `reportRunId`), `runFinishedNotify.ts` (narrative title `Weekly narrative ready — <org name>`, message = headline, link `/reports` — record the deviation from the unconditional run link in a comment; metadata `{ narrative: { reportRunId, reportId } }` only — no sections/context), `reportGenerationService.ts` (`ReportType` union; `export class StoredArtifactOnlyReportError extends Error { code = 'stored_artifact_only' }`; the `ai_org_narrative` branch of BOTH exhaustive switches throws it; `zeroSafeReport` branch throws it too), `routes/reports/schemas.ts` (`reportTypeSchema` keeps the union for reads but `createReportSchema`/ad-hoc generate schemas `.refine(t => t !== 'ai_org_narrative', 'internal report type')`; the generate route maps the error to `409 { error: 'stored_artifact_only' }`), `jobs/reportScheduleWorker.ts` (`findDueReports`: `ne(reports.type, 'ai_org_narrative')`; `processRunScheduledReport`: early return with a logged skip when `type === 'ai_org_narrative'` — a stale queued job must not double-run it).

**Interfaces — Produces:**
```ts
export interface NarrativePersistInput { run: { id: string; orgId: string; agentId: string; scheduleId: string }; agent: { id: string; name: string }; occurrenceKey: string | null; context: NarrativeContext; outcome: NarrativeOutcome }
export class NarrativePersistConflictError extends Error {}  // CAS lost / run no longer running
export async function persistNarrativeReport(input: NarrativePersistInput): Promise<{ reportId: string; reportRunId: string; downloadPath: string }>;
// ONE transaction under withSystemDbAccessContext (precedent: persistSweepFindings), every statement org-pinned:
//  1. SELECT id, status, report_run_id FROM ai_agent_runs WHERE id=$run AND org_id=$org FOR UPDATE → status must be 'running' and report_run_id IS NULL else NarrativePersistConflictError
//  2. definition: INSERT reports { orgId, name:'Weekly AI operations narrative', type:'ai_org_narrative', schedule:'weekly', format:'pdf', config:{ source:'ai_agent', agentId, scheduleId }, createdBy: null, sourceAiAgentScheduleId: scheduleId, ...persistedSystemSiteScopeValues(systemReportAuthority(orgId)) } ON CONFLICT (org_id, source_ai_agent_schedule_id) WHERE source_ai_agent_schedule_id IS NOT NULL DO NOTHING; then SELECT id FROM reports WHERE org_id=$org AND source_ai_agent_schedule_id=$schedule (the winner)
//  3. INSERT report_runs { reportId, status:'completed', startedAt, completedAt, rowCount:0, result:{ rows:[], rowCount:0, summary:{ narrative: <OrgNarrativeReportSummary.narrative incl. titles + derived markdown + orgName/partnerName/period/generatedAt/runId/agentName/contextTruncated> } }, ...persistedSystemSiteScopeValues(...) } RETURNING id; UPDATE report_runs SET output_url = `/api/reports/runs/${id}/download`
//  4. UPDATE reports SET last_generated_at = now() WHERE id=$report AND org_id=$org
//  5. UPDATE ai_agent_runs SET report_run_id=$id WHERE id=$run AND org_id=$org AND report_run_id IS NULL → 0 rows ⇒ throw NarrativePersistConflictError (rolls back the artifact)
export function projectNarrative(run: { reportRunId: string | null }, outcome: { narrative?: NarrativeOutcome }, report: { reportId: string | null; periodStart: string | null; periodEnd: string | null; contextTruncated: boolean } | null): AiAgentRunNarrativeDto | null;  // drops tripwire-named keys; sanitizes strings
```
`finalizeNarrative(ctx, result)` in `runLoop.ts`: `if (!isNarrativeProfile) return null; if (!outcome.narrative) return 'narrative_missing' (a narrative run that produced nothing IS an error — unlike a sweep); if (!ctx.narrative?.scheduleId) return 'narrative_no_schedule'; isRunStillRunning re-read; persistNarrativeReport(...) → NarrativePersistConflictError ⇒ 'narrative_persist_conflict', other ⇒ 'narrative_persist_failed'; sets outcome.narrativeReport = { reportId, reportRunId }`. Notification is emitted by `finishRun` AFTER the artifact persisted (never before).

- [ ] Tests first (`narrativeReport.test.ts` with the `alertVerdicts.test.ts` mock shape + compiled-SQL assertions): definition INSERT carries `ON CONFLICT … DO NOTHING` on the partial-unique target and the system scope columns (`executionScopePrincipalKind:'system'`, `executionScopeUserId:null`, fingerprint = `siteScopeFingerprint({version:1,kind:'unrestricted',orgId})`); report_runs insert carries `result.summary.narrative.sections[*].title` and `markdown` ≤ cap; `last_generated_at` updated; run UPDATE pinned by `org_id` AND `report_run_id IS NULL`; 0-row CAS ⇒ `NarrativePersistConflictError` and the tx rejects; run not running ⇒ conflict before any insert; `projectNarrative` drops a section titled `toolOutput` (tripwire) and returns null without an outcome. `runLoop.narrative.test.ts`: `finalizeNarrative` runs before the terminal decision; `narrative_missing` when no outcome; conflict maps to `narrative_persist_conflict`; notification fires only after persist resolved. `runFinishedNotify.test.ts`: title/link/metadata (no sections). `reportGenerationService.test.ts`: both switches throw `StoredArtifactOnlyReportError`. `routes/reports` tests: create with the type → 400; generate → 409. `reportScheduleWorker.test.ts`: `findDueReports` never returns an `ai_org_narrative` definition; `processRunScheduledReport` skips one.
- [ ] Implement; run; commit `feat(api): persist the weekly narrative as a system-authored reports definition + artifact in one transaction, link the run, notify, worker exclusion (#4190)`.

---

### Task 8 (A8): Schedules `kind` + narrative fan-out

**Files:** `scheduleService.ts` (create: `kind` on partner rows; narrative rows enforce `sweepKinds: []` and `isWeeklyLiteralCron`; `kinds_empty` only for `kind='sweep'`; org override INSERT copies `kind` from the baseline (composite FK backs it); update on a narrative baseline rejects `sweepKinds` and non-weekly cron; `effectiveSchedule` unchanged (narrative rows: `sweepKinds []` both sides → enabled only); `toScheduleDto` emits `kind`; `resolveEffectiveSchedulesForPartner` returns `kind`), `routes/aiAgentSchedules.ts` (schema already carries kind), `jobs/aiAgentSweepScheduler.ts` (occurrence loop: `if (baseline.kind === 'narrative')` → skip the empty-kinds guard, admit `createAndEnqueueAgentRun({ orgId, kind:'triage', triggerKind:'schedule', deviceId:null, profile:'narrative', scheduleId, triggerRef:{ scheduleId, occurrenceKey, kind:'narrative' }, dedupeKey:`narrative-${scheduleId}-${orgId}-${occurrenceKey}` })`; summary invariant unchanged; `override_disabled` when the org override disables), tests `scheduleService.test.ts`, `aiAgentSweepScheduler.test.ts`, integration `aiAgentNarrative.integration.test.ts` (new: partner with 2 orgs + a narrative baseline → one `profile='narrative'` run per org with the dedupe key; override disabled → skip; second occurrence re-run → duplicate no-op; a sweep baseline still admits sweep runs untouched; then simulate `persistNarrativeReport` for one run → `reports`/`report_runs` rows exist with `principal_kind='system'`; a second `persistNarrativeReport` for the same run → conflict, still one artifact; cross-org forge as `breeze_app` of `ai_agent_runs.report_run_id` pointing at another org's artifact → the service's org-pinned UPDATE affects 0 rows; **org erasure via `tenantCascade` succeeds afterwards** and leaves no `reports`/`report_runs`/`ai_agent_runs` rows for that org).

- [ ] TDD; run unit + integration; commit `feat(api): narrative schedule kind — service/routes + one narrative run per org per occurrence (#4190)`.

---

### Task 9 (A9): jsPDF render arm for `ai_org_narrative`

**Files:** `packages/shared/src/reportPdf/reportPdf.ts` (`REPORT_TYPE_LABELS.ai_org_narrative = 'Weekly AI Operations Narrative'`; widen `BuildOpts.summary` to accept `OrgNarrativeReportSummary`; new arm in `buildReportPdf` when `opts.reportType === 'ai_org_narrative'` and `opts.summary` has `narrative`: title block (org, period, generated, agent), headline paragraph, one heading per section in `NARRATIVE_SECTION_KEYS` order using `NARRATIVE_SECTION_TITLES` (ignore stored titles/unknown keys) with wrapped bullets (`doc.splitTextToSize`, page-break aware), footer note "Generated by an AI agent from the previous 7 days of Breeze data; numbers are as recorded, narrative is model-authored"; every string sanitized (`\p{C}` stripped, ≤ 240) at render; `markdown` never rendered), `packages/shared/src/reportPdf/index.ts` (export unchanged), `apps/web/src/components/reports/reportExport.ts` (type widening for `summary` — PR A because it is a type-only touch that keeps `astro check` green; if it pulls web tests, move to PR B), test `reportPdf.narrative.test.ts` (builds a PDF from a fixture summary: no throw, `doc.getNumberOfPages() >= 1`; a fixture with an unknown key renders only the eight known keys; a bullet with `\n- injected` renders as one line; a bullet with hostile control characters (` `, `‮`, ``) renders stripped; missing `narrative` falls to the generic branch without throwing).

- [ ] TDD; commit `feat(shared): branded jsPDF renderer arm for the weekly AI narrative report (#4190)`.

---

### Task 10 (A10): PR A wrap

- [ ] Typecheck api + shared; `pnpm lint` api/shared; unit suites: `src/services/aiAgents src/services/siteScope src/jobs/aiAgentSweepScheduler src/jobs/reportScheduleWorker src/routes/aiAgents src/routes/aiAgentSchedules src/routes/reports src/services/reportGenerationService` (+ shared `src/validators src/types src/reportPdf`); `scheduleRegistry.contract.test.ts`, `workerEntrypointClosure.contract.test.ts` (no registry change expected), `verdictProfile.contract.test.ts`, `partner-wide-write-coverage.test.ts`.
- [ ] Integration (live DB): `aiAgentSchedulesPartnerRls`, `aiAgentNarrative`, `aiAgentRuns`, `report-site-scope`, `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgMergeRegistry`; `rls-coverage` under `vitest.config.rls-coverage.ts`.
- [ ] Manual (wt-stack): narrative schedule with a weekly cron whose next occurrence is within minutes (pick today's weekday + the next quarter hour) on the partner-wide triage agent (recipients = admin) → a `profile: narrative` run completes; `reports` list shows "Weekly AI operations narrative" for the org; `GET /api/reports/runs/<id>/download` returns the JSON snapshot with `summary.narrative.sections` for the admin and 404 for a site-restricted user; the run trace shows the narrative section + report link; a `user_notifications` row "Weekly narrative ready — <org>"; `POST /reports/<id>/generate` on the definition → 409. Record turns/cost.
- [ ] File the roadmap follow-ups via `add_roadmap_item`: (1) `report_runs.org_id` retrofit — backfill, composite `(report_id, org_id) → reports(id, org_id)`, direct RLS, cascade/export/merge registration; (2) narrative email delivery gated per recipient on `resolveLiveReportAuthority(userId, orgId, 'export')` requiring `unrestricted`, reusing `emailReportRun` extracted from `reportScheduleWorker`.
- [ ] Open PR A against `feature/4187-ai-agents-p2/wave-4189-b`: `feat(api,shared): P2-3a — weekly org narrative: narrative schedule kind + profile, bounded context, submit_narrative, system-authored report artifact, jsPDF arm`, body `Part of #4190`, spec amendments, deploy notes (no env; partner-wide triage agent with recipients; narrative schedule created via API until PR B; no email in v1). Dispatch CI by hand. **Stop at PR.**

---

## PR B — web

### Task 11 (B1): Reports UI type + labels + system-managed rows
`ReportsList.tsx:30` union + `reportTypes` labels in 3 paths × 8 locales; `ReportBuilder.tsx:153` `legacyToBuilderType` entry (a read-only `'ai_org_narrative'` tile — the builder cannot author AI narratives; the create form never offers it); `ReportsList`: for `type === 'ai_org_narrative'` rows, replace "Generate now"/"Edit" with "Open latest" (opens the latest completed run's download → `exportReport`) and show "Managed by AI schedule" where the computed next occurrence is shown for other rows (`ReportsList.tsx:430`); download path passes `summary` through `exportReport` (verify `handleDownload` forwards `payload.data.summary` — it does); i18n keys `reports.aiNarrative.openLatest`, `reports.aiNarrative.managedBySchedule` in 8 locales; tests: a list row of type `ai_org_narrative` renders the label, no Generate/Edit, "Open latest" triggers `exportReport` with `reportType:'ai_org_narrative'`; parity + coverage. Commit.

### Task 12 (B2): AI-agent surfaces
`RunDetailPage.tsx`: `narrative` section (`data-testid="ai-agent-run-narrative"`, headline, sections with bullets, "Open report" link → `/reports` and the download path if present, `contextTruncated` note); `RunsListPage.tsx` badge `narrative`; `AiAgentSchedulesSection.tsx`: kind selector on create (sweep|narrative, testid `ai-agent-schedule-kind`), narrative hides the kinds checkboxes and defaults cron `0 7 * * 1` with a weekly-only hint, lists show a kind badge, org overrides of a narrative baseline show only `enabled`; i18n `aiAgentsPage.schedules.kinds.{sweep,narrative}`, `aiAgentsPage.schedules.weeklyOnlyHint`, `aiAgentsPage.runs.narrative.*`, `aiAgentsPage.runs.profile.narrative` in 8 locales; tests (render, POST body with `kind:'narrative'` and no `sweepKinds`, badge, override form hides kinds). Commit.

### Task 13 (B3): PR B wrap
Typecheck/lint/web suites incl. parity/coverage/guard; manual on a stack: create a narrative schedule from the editor, see the run badge, open the run detail narrative, open Reports → "Open latest" → PDF renders in the browser (Playwright screenshot). Open PR B stacked on A, `Closes #4190`. **Stop at PR.**

---

## Self-review (done at plan time)
- **Spec §4.3:** trigger (schedule kind, weekly-only, one run per org ✔ A8); inputs (nine loaders, 16 KiB whole-context, numbers + short labels ✔ A5, with the three honest "not measured" amendments); outcome (`submit_narrative` ✔ A6, `reports` + `report_runs` in one transaction ✔ A7, system principal ✔ A3, branded PDF ✔ A9, `ai_agent_runs.report_run_id` ✔ A2/A7); UI (reports list ✔ B1, run trace link ✔ B2, exportable ✔ existing download; emailable → deferred, roadmap item filed by A10). §5 rows ✔ A2 (amended). §7 no new flags ✔; §8 outcome safe-projection ✔ A6/A7 tests; no profile bypass ✔ A4 contract.
- **Quorum coverage:** D1 CHECK + composite FK + weekly cron (A1/A2/A8); D2 (A4/A6); D3 system principal (A2/A3/A7), typed identity + partial unique (A2/A7), single-transaction CAS (A7), `report_runs.org_id` → roadmap (A10); D4 derived markdown + server titles (A1/A6/A9), no email (A7/A10); D5 all four bullets (A7/B1); D6 invariants (Global Constraints + A5 tests); additional: `last_generated_at` (A7), UI system-managed (B1), tripwire (A6/A7), test list — finalizer retry/race (A7/A8), cross-org FK forge (A8), restricted-site 404 (A3/A10), stale worker job (A7), hostile control chars in PDF (A9), cascade/export/merge roundtrip (A8/A10), eight-locale parity (B1/B2), `classifyTerminal('narrative')` (A4).
- **Placeholders:** none — each task names files, interfaces, tests and commands; B-tasks cite the exact P2-2 precedents.
- **Type consistency:** `AiAgentScheduleKind`/`NarrativeSubmission`/`NarrativeOutcome`/`NARRATIVE_SECTION_KEYS`/`NARRATIVE_SECTION_TITLES`/`narrativeOutcomeFromSubmission`/`renderNarrativeMarkdown`/`OrgNarrativeReportSummary` (A1) used by A2/A6/A7/A9/B1/B2; `persistedSystemSiteScopeValues`/`systemReportAuthority` (A3) by A7; `isNarrativeProfile`/`narrativeLimits` (A4) by A6; `NarrativeContext`/`loadNarrativeContext` (A5) by A6/A7; `persistNarrativeReport`/`projectNarrative`/`NarrativePersistConflictError` (A7) by A6's seam and `runTrace`; `isWeeklyLiteralCron` (A1) by A8; `kind` on `resolveEffectiveSchedulesForPartner` (A8) by the sweeper.
