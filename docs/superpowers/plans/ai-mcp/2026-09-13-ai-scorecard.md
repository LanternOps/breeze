---
tracking_issue: LanternOps/breeze#5757
wave_issues: W01 LanternOps/breeze#5758, W02 LanternOps/breeze#5759, W03 LanternOps/breeze#5760, W04 LanternOps/breeze#5761
branch: feature/5757-ai-scorecard/wave-<sub-issue>
---

# AI Scorecard — attribution, narrative email, measured impact (plan hub)

> **For agentic workers:** this file is the **hub**. It carries the goal, the shared
> architecture, the constraints every wave inherits, and the wave index. The
> executable task lists live in the four per-wave files linked below. REQUIRED
> SUB-SKILL for each wave file: `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans`.

**Goal:** Make AI-initiated device work visible, deliverable and measurable — attribute every AI-dispatched script and command at the source (#5022), email the weekly AI org narrative to recipients whose live authority actually covers the whole org (#4248), and put a *measured* impact band beside the estimated one on `/ai-agents/impact` (#4182).

**Architecture:** One typed attribution tuple (`ai_initiator_kind` enum + `ai_session_id` + `ai_agent_run_id`) lands on the two tables that record device work — `script_executions` and `device_commands` — plus `action_intents` so the tuple survives the approval boundary. It is carried in-process on `AuthContext.aiOrigin` (minted once per AI surface), conducted to the five insert chokepoints through an explicit `aiOrigin` field on their options bags, and *enforced* by a mandatory-origin adapter (`services/aiDispatch.ts`) plus two source-scan contract tests that forbid AI tool files from importing un-attributed dispatch and forbid raw `db.insert`/`tx.insert` into either table outside the chokepoints. W02 renders that data on the device page behind an authorized origin-summary endpoint. W03 and W04 are independent of W01 and of each other: W03 extracts report emailing into `services/reportDelivery.ts`, gates the narrative on `resolveLiveReportAuthority(…, 'export')` + `unrestricted`, and makes delivery crash-recoverable with a per-recipient `report_run_deliveries` table; W04 adds a read-time `services/aiAgents/impactMeasured.ts` whose cohorts are formed by **exposure time**, not by linkage.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, PostgreSQL 16 (enums, partial indexes, forced RLS, parent-FK-join policies), Zod in `packages/shared`, BullMQ, Vitest (unit with Drizzle mocks; integration against real Postgres via `apps/api/src/__tests__/integration/setup`), React + Astro + react-i18next (8 locales), jsPDF via `@breeze/shared/reportPdf`.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-13-ai-scorecard-attribution-and-impact-design.md` (currently on `origin/docs/feature-pipeline-2026-09-13-specs-plans`, not yet on `main`). Gate A approved 2026-09-13: **OD-1 A + dispatch adapter, OD-2 A, OD-3 B, OD-4 A, OD-5 A, OD-6 A, OD-7 B, OD-8 B, OD-9 A, OD-10 A.** Every one of those ten decisions is settled — no wave reopens one.

**Tracking:** feature issue TBD (register with `feature-lifecycle` `register_feature` after Gate B, then replace `tracking_issue:` in **all five** files and `wave_issue:` in the four wave files). Anchor issue [#5022](https://github.com/LanternOps/breeze/issues/5022); also covers [#4248](https://github.com/LanternOps/breeze/issues/4248) and [#4182](https://github.com/LanternOps/breeze/issues/4182).

---

## Wave index

| Wave | File | Issue | Depends on |
|---|---|---|---|
| **W01 — Attribution at the source** | [`2026-09-13-ai-scorecard-01-attribution.md`](./2026-09-13-ai-scorecard-01-attribution.md) | #5022 | — |
| **W02 — Device page surfaces** | [`2026-09-13-ai-scorecard-02-device-surfaces.md`](./2026-09-13-ai-scorecard-02-device-surfaces.md) | #5022 | **W01 (hard)** — W02 renders W01's columns |
| **W03 — Narrative email delivery** | [`2026-09-13-ai-scorecard-03-narrative-email.md`](./2026-09-13-ai-scorecard-03-narrative-email.md) | #4248 | — (independent of W01/W02/W04) |
| **W04 — Measured impact** | [`2026-09-13-ai-scorecard-04-measured-impact.md`](./2026-09-13-ai-scorecard-04-measured-impact.md) | #4182 | — (independent of W01/W02/W03) |

W01 → W02 is the only hard ordering. W03 and W04 may run in parallel with each other and with W01/W02.

---

## Global Constraints (every wave inherits this section)

### Migration slots — reserved, in this order

| Wave | Filename | Contents |
|---|---|---|
| W01 | `apps/api/migrations/2026-10-16-181700-ai-origin-attribution.sql` | `ai_initiator_kind` enum; 3 columns × `script_executions`, `device_commands`, `action_intents`; 3 partial indexes; `breeze_cascade_device_org_id()` replace |
| W03 | `apps/api/migrations/2026-10-16-181710-report-run-deliveries.sql` | `report_run_deliveries` table + parent-FK-join RLS + indexes |
| W04 | `apps/api/migrations/2026-10-16-181720-impact-measured-indexes.sql` | cohort indexes on `alerts`, `tickets`, `ai_agent_runs` |

- The newest **committed** migration on `origin/main` at planning time is `2026-10-16-180200-monitor-definitions-builtin-key.sql`. Slots `180300`, `180500`, `180700`, `180900`, `181100`, `181300`, `181500`–`181520` are taken by in-flight PRs. **Re-check at PR time** — `git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -3` must sort *before* your filename under `localeCompare`; if not, bump the `HHMMSS` and rename (the file is unmerged, so renaming is legal — but sweep every `readFileSync('.../<file>.sql')` reference in integration suites in the same commit, or Integration Tests dies on `ENOENT` minutes in; `autoMigrate.test.ts` moves that failure into the unit job).
- **Never name a migration for today's real date.** The shipped naming ratchet runs ~2 weeks ahead of the calendar; a file named `2026-09-13-…` would replay before the entire 2026-10 block.
- `2026-08-06` is a **CLOSED** date block. Do not add `-g-` or later to it.
- Every migration: idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP POLICY IF EXISTS` then `CREATE POLICY`, `DO $$ … EXCEPTION WHEN duplicate_object THEN NULL; END $$` around `CREATE TYPE`). **No inner `BEGIN;`/`COMMIT;`** — `autoMigrate` wraps each file in `client.begin(...)`. Explicit `ON DELETE` on every FK. **Never edit a shipped migration** — fix forward.
- **None of the three migrations contains DML.** They therefore need **no** `SELECT set_config('breeze.scope','system',true);` and must **never** be added to the frozen 122-offender baseline in `apps/api/src/db/migrationRlsScope.test.ts`. Each wave's migration task asserts this stays true.

### Registration lists — the mechanical checklist, resolved

Resolved against the live contracts on `origin/main` in this planning session. **Do not re-derive; do not skip.** Cite the row, do the grep, move on.

| Change | `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`) | `CORE_DEVICE_CASCADE_DELETE_TABLES` / `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`routes/devices/core.ts`) | `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`) | org merge (`services/orgMergeRegistry.ts`) | RLS allowlists (`rls-coverage.integration.test.ts`) |
|---|---|---|---|---|---|
| **W01** `script_executions` +3 columns | already at `:638` — **no change** | already at `core.ts:521` / `core.ts:295` — **no change** | **3 new `included` strings** on the `"script_executions"` entry at `tenantExportPolicyRegistry.ts:487` | changes `repoint` → **`custom`** (detach-on-merge, see W01 Task 8) | Shape 1, auto-discovered — **no change** |
| **W01** `device_commands` +3 columns | absent by design (`ASSOCIATED_SYSTEM_SCOPED_TABLES`, `tenantCascade.ts:801`) — no change | already at `core.ts:497`; **not** in the denormalized list (no `org_id`) — no change | **no entry exists** (no `org_id`) — nothing to add | `follows-parent` via `FOLLOWS_PARENT_NOTES.device_commands` (`orgMergeRegistry.ts:65`) — no change | `INTENTIONAL_UNSCOPED` — no change |
| **W01** `action_intents` +3 columns | already present — no change | n/a | **3 new `included` strings** on the `"action_intents"` entry at `tenantExportPolicyRegistry.ts:44` | `leave-for-erasure` — no change | Shape 1 — no change |
| **W03** `report_run_deliveries` (**new table**, no `org_id`, no `partner_id`, no `device_id`) | **NO.** `deleteOrgRows()` (`tenantCascade.ts:1413-1425`) issues an unconditional `DELETE FROM <table> WHERE org_id = …` for every entry — adding it would raise 42703 at erasure time, and *no static test catches that*. Its discovery query (`tenantCascade.integration.test.ts:57-71`) only sees `org_id` tables, so it can never demand the entry either. | n/a (no `device_id`) | **NO.** `buildTenantExportPlan` is only ever called with `getOrgCascadeDeleteOrder()` (`services/tenantExport.ts:70-73`), so a table outside that list is never classified. Same reasoning the registry already records for `report_runs` at `tenantExportPolicyRegistry.ts:465-470`. | **NO.** `buildFollowsParentEntries()` (`orgMergeRegistry.ts:103-119`) iterates only `ASSOCIATED_SYSTEM_SCOPED_TABLES`, and the merge walk only reaches `topologicalCascadeOrder() ⊆ getOrgCascadeDeleteOrder()`. Rows travel free with their parent `report_runs` row, exactly as `report_runs` travels with `reports`. | **YES — `PARENT_FK_JOIN_POLICY_TABLES` (`rls-coverage.integration.test.ts:732`), mapped to `['reports']`.** See the trap below. |
| **W04** (indexes only) | — | — | — | — | — |

**`report_run_deliveries` also does NOT need an `ASSOCIATED_SYSTEM_SCOPED_TABLES` entry** — *conditional on the FK being `ON DELETE CASCADE`*. `report_runs` needed one only because `report_runs_report_id_reports_id_fk` is declared with no `ON DELETE` (NO ACTION), which would 23503 the `DELETE FROM reports`. With `report_run_id … ON DELETE CASCADE`, Postgres clears the deliveries the instant the existing `report_runs` pre-clear (`tenantCascade.ts:949-954`) fires. **If W03 ever weakens that FK, the `ASSOCIATED_SYSTEM_SCOPED_TABLES` entry becomes mandatory and `FOLLOWS_PARENT_NOTES` gains a required entry with it** (`buildFollowsParentEntries` throws at module load otherwise).

**TRAP — declare `['reports']`, not `['report_runs']`.** There are two assertions over `PARENT_FK_JOIN_POLICY_TABLES`. The loose one (`rls-coverage.integration.test.ts:1824`) only needs `LIKE '%FROM <parent>%'`. The strict one (`:1904`, "command-specific USING/WITH CHECK coverage on the declared parent alias") runs `predicateCoversParent` (`apps/api/src/db/rlsPolicyShape.ts:92-97`), which requires `FROM <parent> <alias>` **and** `breeze_has_(org|partner)_access(<alias>.org_id|partner_id)` on *that* alias. `report_runs` has **no `org_id` column**, so declaring it as the parent fails the strict assertion. Declare the org-bearing grandparent `reports` and write the policy so `reports` is the table in the `EXISTS … FROM` — the established shape for a 2-hop child (`config_policy_monitoring_watches` → `configuration_policies`, `apps/api/migrations/2026-06-23-sec-review-1-fk-child-rls-backstop.sql:108-112`).

**7th list — trigger classification.** `orgMergeRegistry.integration.test.ts` (Integration shard 3) fails on **any new `BEFORE UPDATE` row trigger on an `org_id` table** until it is classified in `ORG_ID_BLOCKING_TRIGGERS` / `ORG_ID_BENIGN_TRIGGERS` / `ORG_ID_CONDITIONALLY_BLOCKING_TRIGGERS` (and in `CUSTOM_EXECUTORS_THAT_NEVER_WRITE_ORG_ID` when the table's merge policy is `custom`). **No wave here adds such a trigger** — W01 only does `CREATE OR REPLACE FUNCTION public.breeze_cascade_device_org_id()`, replacing the body of a function behind an existing, already-classified `AFTER UPDATE OF org_id` trigger on `devices`. W01 **does** flip `script_executions` from `repoint` to `custom`, which requires the `CUSTOM_EXECUTORS_THAT_NEVER_WRITE_ORG_ID` question to be answered explicitly (it writes `org_id`, so it must **not** be listed there) — see W01 Task 8.

### CI traps to repeat in every wave

- **The export-policy, cascade, merge and RLS contract suites run ONLY in the `integration-test` job**, never under `pnpm test`. A unit-green PR on a stale base can go green and then redden `main`. Before opening any PR that touches a registration list, run the live-DB suites listed in that wave's final task.
- **A PR based on a sibling branch runs no CI at all** (`ci.yml` triggers on `pull_request: branches: [main]`), and `gh pr checks` reads green. If a wave is stacked, `gh workflow run CI --ref <branch>` before merging. Waves here target `main`, so this should not arise — verify with `gh pr view <N> --json baseRefName`.
- **Never write `pnpm --filter <pkg> test -- --run <path>`** — pnpm forwards the literal `--`, vitest swallows `--run` as a positional, and the *entire* suite runs in watch mode. Use `cd apps/api && npx vitest run <path>`.
- **`vitest run <path>` is a plain substring filter**, not a glob and not a directory prefix. `vitest run src/routes/devices/` silently skips `src/routes/devices.test.ts`. List dotted siblings explicitly and **always check the reported file/test count — a 0-test run is a stall, not a pass.**
- Local live-DB stack: `pnpm test-stack up` / `pnpm test-stack down` (per-worktree; nothing reaps it for you — tear it down before ending the session).
- Merge via the queue: `gh pr merge <N>` with no strategy flag. **Never `--admin`.**

### Standing commands

```bash
# API unit tests (one file)
cd apps/api && npx vitest run <path>
# API typecheck
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
# Shared
cd packages/shared && npx vitest run <path>
cd packages/shared && npx tsc --noEmit
# Web
cd apps/web && npx vitest run <path>
cd apps/web && npx astro check
# Integration (needs pnpm test-stack up)
cd apps/api && npx vitest run --config vitest.integration.config.ts <path>
# Lint in every touched package
pnpm lint
```

Add `--pool=threads --maxWorkers=2` to any vitest command while a dev stack is running (the forks pool hangs under `wt-stack`).

### Cross-wave semantic rules (copied from the spec; do not restate them differently)

1. **`ai_initiator_kind` NULL means "AI initiation not recorded" — never "a human did this".** No backfill, no `NOT NULL`, no default. Every historical AI-run library script carries `trigger_type='manual'` and the invoker's user id, so pre-deploy AI work is indistinguishable from human work. The UI renders NULL as *absence of a marker*.
2. **Three-way separation.** *Authorship* (who wrote the script), *initiation* (who decided to run it now) and *authenticated principal* (who the request was) are three fields. `actor_type`/`actor_id` on an audit row derive from the **principal**, always consistent with each other. Authorship lives in `details`.
3. **Audit emission is best-effort, and the copy says so** (OD-10 A). `createAuditLogAsync` failures are caught (`commandQueue.ts:1192-1223`, `scriptDispatch.ts:783-804`). Never write UI or release-note copy that implies a completeness guarantee.
4. **W01 ships direct-dispatch attribution only** (OD-3 B). Patch jobs, deployments, automation runs, playbook executions, elevation requests and backup remain unattributed, as does SentinelOne provider-API device mutation. The release notes and the device page must **state the incompleteness**. The indirect-lane follow-up issue is filed before W01 merges.
5. **A provenance pointer is not permission to disclose its target** (OD-9 A). Transcripts are owner-bound (`services/aiAgent.ts:229`). The chip's default affordance is an authorized *summary*; the DTO **omits** the id when the viewer cannot resolve it.
6. **Never call the measured band "before/after"** and never call it causal. It is "AI-touched vs untouched in one window", labelled correlational, with the selection bias named.
7. New user-facing strings get **real translations in all 8 locales** (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`) — `apps/web/src/lib/i18n/localeParity.test.ts` and `translationCoverage.test.ts` enforce it.
8. Web mutation handlers wrap in `runAction`. None of these waves adds a device-page mutation; W02's endpoints are reads.
9. **No new env flag, no new permission, no policy-snapshot bump, anywhere in these four waves.** Attribution is on for every AI surface the moment W01 deploys — a marker a partner can disable is a marker a tech cannot trust — so there is deliberately no "AI attribution enabled" toggle. The device surfaces use the existing `devices:read`; the impact page uses the existing `ai_agents:read`; W04's technician-minutes arm uses the *existing* time-entry permission and omits itself when the caller lacks it (it does not mint a new one). If a task tempts you to add `BREEZE_*_ENABLED`, re-read spec §2 and §7 first.
10. **Two different column-name mappers exist and must not be confused.** `aiOriginColumns(origin)` (W01 Task 5, local to `commandQueue.ts`) produces `{ aiInitiatorKind, aiSessionId, aiAgentRunId }` for `script_executions` / `device_commands`. `serializeAiOrigin(origin)` (W01 Task 3, in `packages/shared`) produces `{ aiOriginKind, aiOriginSessionId, aiOriginAgentRunId }` for `action_intents`, whose columns are prefixed `ai_origin_*` to avoid colliding with its existing `origin_principal_kind` / `origin_principal_id` pair. Same `AiOriginRef` in, different column names out.

### Facts corrected during planning (the spec's file:line references drifted — use these)

| Spec said | Actually on `main` |
|---|---|
| `db/schema/deviceCommands.ts` | **`apps/api/src/db/schema/devices.ts:559-586`** (no such file as `deviceCommands.ts`) |
| `db/schema/auditLogs.ts` | **`apps/api/src/db/schema/audit.ts:16-35`** |
| `scriptDispatch.ts:514-531` "mirrored `resolveCommandCreatedBy`" | an **inline, unnamed** users-FK probe at `:514-531`; there is no second function by that name |
| `scriptDispatch.ts:644` `db.insert(deviceCommands)` | `:644` is `await queueCommand(...)`; `scriptDispatch.ts` never inserts into `device_commands` itself |
| `moveOrg.ts:463` re-stamp | the `ai_agent_runs` detach is `:475`; the generic denormalized re-stamp loop is **`:695-703`** |
| `alertVerdictSubscriber.ts:388` "deliberate wait" | **`apps/api/src/jobs/alertVerdictScheduler.ts:79`**, `UNGROUPED_VERDICT_DELAY_MINUTES = 10` |
| `ai_agent_runs.created_at` | no such column — `queued_at` / `started_at` / `finished_at`, all `timestamptz` |
| "ten activity counters" | **eleven** (`AI_AGENT_IMPACT_COUNTER_KEYS`, `packages/shared/src/types/aiAgentImpact.ts:15-19`) |
| `services/reports/*` | **the directory does not exist**; report services are flat files under `apps/api/src/services/`. W03's extraction target is therefore `apps/api/src/services/reportDelivery.ts` |
| `routes/reports/recipients.ts:188` | `POST /:id/recipients` is at **`:75-105`**; `POST /:id/recipients/convert` is at `:136-233` |
| `persistNarrativeReport` at `narrativeReport.ts:124` | **`:202-363`** |
| `resolveLiveReportAuthority` `unverifiable_scope` "at `:1039`" | it is a `LiveReportAuthorityResult.reason` value at **`services/siteScope.ts:108`**; `SiteScopeV1.kind` (`:31-34`) is a *different* union — do not conflate them |
| `impactQuery` accepts `from`/`through`/`orgIds` | `impactQuerySchema` (`packages/shared/src/validators/aiAgentImpact.ts:35-38`) accepts only `window` (7\|30\|90) and a singular optional `orgId`; `through` is always server-computed via `lastCompleteUtcDay()` |
| `WORKER_EXCLUDED_REPORT_TYPES` contains one type | it contains **two**: `['ai_org_narrative', 'ai_fleet_design']` (`reportScheduleWorker.ts:155`) |

### "Not verified" items from the spec — resolved here

| Spec's open item | Resolution |
|---|---|
| "no RLS discovery rule keys off `_id` columns generally" (§4.1, flagged not-checked) | **Confirmed.** `rls-coverage.integration.test.ts:1259-1272` discovers by the literal column name `org_id` only; `tenantCascade.integration.test.ts:57-71` likewise. `ai_session_id` / `ai_agent_run_id` on `device_commands` are invisible to both — the system-scoped property the `devices.ts` comment protects is untouched. |
| "`report_run_deliveries` … must be confirmed against the live contracts, not assumed" (§4.1, OD-8) | **Resolved in the table above:** exactly one registration — `PARENT_FK_JOIN_POLICY_TABLES → ['reports']` — plus RLS enable/force + four policies in the creating migration. Nothing else, conditional on the `ON DELETE CASCADE` FK. |
| "`ai_tool_executions.command_id` has no writer (grep, not exhaustive)" | Not load-bearing — OD-1 C was rejected. No wave touches that column. |
| Whether `script_executions.ai_session_id` can go cross-tenant on **merge** | **Refined.** `ai_sessions` is itself in `REPOINT_TABLES` (`orgMergeRegistry.ts:593`) alongside `script_executions` (`:822`), so on a *merge* the session follows and only `ai_agent_run_id` (a `leave-for-erasure` table, `:214`) goes cross-tenant. On a **device move** both can strand, because only *device-bound* sessions are re-stamped (`ai_sessions` is in `CORE_DEVICE_ORG_DENORMALIZED_TABLES`, `core.ts:262`) and a device-less chat session is not. W01 detaches **both** columns on **both** events anyway — unconditional detach is simpler, matches the spec's "the fact survives, the pointer does not", and costs nothing. |

---

## Deliverable that is not code: the OD-3 indirect-lane follow-up issue

Per Gate A (OD-3 B), the indirect-lane gap is **filed as a tracked issue before W01 merges**, so it is a decision on the record rather than an omission. The drafted text is in W01, Task 14. It must be filed — not merely drafted — and its number referenced from the W01 PR body and from the W01 release note.
