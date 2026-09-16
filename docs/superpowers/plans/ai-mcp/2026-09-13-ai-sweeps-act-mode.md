---
tracking_issue: LanternOps/breeze#5751
wave_issues: W01 LanternOps/breeze#5752, W02 LanternOps/breeze#5753, W03 LanternOps/breeze#5754, W04 LanternOps/breeze#5755, W05 LanternOps/breeze#5756
branch: feature/5751-ai-sweeps-act-mode/wave-<sub-issue>
---

# AI sweeps — act mode, certificate evidence and fix-by-trigger provenance — Plan Hub

> **For agentic workers:** this file is the ROADMAP. Each wave has its own plan file, listed below; open the one for the wave you are executing and follow it task-by-task with `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Do not implement from this hub.

**Goal:** Make a scheduled sweep able to *fix* what it finds — safely — by first giving every remediation a recorded cause (W01), making "verified" mean something for a sweep-minted intent (W02), adding the missing certificate evidence source (W03), and only then opening the act-mode gate (W04) and its fan-out/budget/graduation controls (W05).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-13-ai-sweeps-act-mode-and-evidence-design.md` — **Gate A approved 2026-09-13, all six Open Decisions resolved to option A.** Do not reopen OD-1…OD-6; if implementation contradicts one, stop and raise it, do not silently re-decide.

**Issues:** #4442 (anchor — act mode), #4230 (`expiring_certs` evidence), #5744 (fix-by-trigger tagging).

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL 16 (text + CHECK columns, RLS shape 1 and dual-owner), zod in `packages/shared`, Go 1.x agent (`agent/internal/heartbeat`), React/Astro web with i18n across 8 locales, Vitest (unit with Drizzle mocks; integration against real Postgres via `apps/api/src/__tests__/integration/setup`).

## Wave files

| Wave | Plan file | Migration slot | Depends on |
|---|---|---|---|
| **W01 — trigger provenance** (#5744) | `2026-09-13-ai-sweeps-act-mode-01-trigger-provenance.md` | `2026-10-16-182900-remediation-trigger-provenance.sql` | — |
| **W02 — sweep-condition fix watches** | `2026-09-13-ai-sweeps-act-mode-02-sweep-fix-watches.md` | `2026-10-16-182300-sweep-condition-fix-watches.sql` | W01 (needs `action_intents.trigger_kind`) |
| **W03 — `expiring_certs`** (#4230) | `2026-09-13-ai-sweeps-act-mode-03-expiring-certs.md` | `2026-10-16-181510-network-monitor-tls-observation.sql` | **nothing** — fully independent, can ship in parallel with W01/W02 |
| **W04 — the act gate** (#4442) | `2026-09-13-ai-sweeps-act-mode-04-act-gate.md` | `2026-10-16-181520-ai-agent-schedules-act-mode.sql` | W01 **and** W02 |
| **W05 — fan-out, budget, graduation, visibility** | `2026-09-13-ai-sweeps-act-mode-05-fanout-graduation-ui.md` | none | W04 |

W01–W03 ship dark and are independently useful with act mode off. W04–W05 ship behind `BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED` (default off).

**W02 slot note (added post-W01 merge):** W01 actually shipped as `2026-10-16-182900-remediation-trigger-provenance.sql`, which sorts *after* the `181505` slot originally reserved for W02 above — a W02 migration filed at `181505` would replay before its own dependency (`action_intents.trigger_kind`) exists. The table above is corrected to `182300`, but re-verify at dispatch time per the "Migration slot block" rule below (`ls apps/api/migrations | sort | tail -1` against `origin/main`) rather than trusting this doc — more migrations may have landed in the block since.

## Migration slot block (read before renaming anything)

`2026-10-16-181500` is **reserved for this cluster** (recorded on `origin/docs/feature-pipeline-2026-09-13-specs-plans`, PR #5745). The whole `1815xx` block below belongs to these waves; nothing else claims it. Verified on `origin/main` at planning time:

- newest committed migration: `2026-10-16-180200-monitor-definitions-builtin-key.sql`;
- claimed by in-flight PRs and other reservations, do **not** reuse: `180300`, `180400`, `180500`, `180700`, `180900` (monitors W04), `181100`, `181200`, `181300`, `181400`, `181700`.

Before pushing any wave, re-run `ls apps/api/migrations | sort | tail -1` against `origin/main`; if a later file has landed, bump the `HHMMSS` **upward** only. **Never rename a wave migration for today's real date** — shipped names run more than two weeks ahead of the calendar and a today-named file replays before half the history.

## Ordering assumptions (read first)

1. **W04 and W05 must not start before W02 has merged.** Until W02 lands, `watchReleasedIntent` (`apps/api/src/jobs/intentReleaseWorker.ts:544-570`, **verified**) credits `verified` to every released intent whose run has no triggering alert — which is every sweep intent, because `createIntentFixWatchRow` requires `anchor.alertId` (`apps/api/src/services/aiAgents/fixWatch.ts:286-300`, **verified**). Turning act mode on before that fix would let P2-5's graduation ladder promote op keys on evidence that proves only that a button was pressed.
2. **W03 is order-independent of monitors W04** (`docs/superpowers/plans/monitoring/2026-09-13-monitoring-automation-unification-04-coverage.md`, on `origin/plan/5291-monitors-w04-coverage`, migration `2026-10-16-180900-monitor-coverage-kinds.sql`), which retenants `network_monitors` to `org_id` XOR `partner_id` (drops `org_id NOT NULL`, adds `partner_id`, replaces the RLS policy, adds a partner-wide `FOR SELECT` branch) and converts `network_monitor_results` to RLS shape 1. **Our W03 adds five plain columns and changes no ownership, no policy and no nullability, so it is correct in either merge order.** The one coupling is the sweep loader's tenancy predicate, and W03 resolves it by pinning `nm.org_id = $1` and declaring partner-wide network monitors explicitly out of scope for `expiring_certs` v1 (Task 5 files the follow-up). Both waves edit the `network_monitors` entry in `CORE_TENANT_EXPORT_POLICY` (`apps/api/src/services/tenantExportPolicyRegistry.ts:370`) — whichever merges second rebases and re-runs Integration Tests.
3. **W01 and monitors W04 both edit the `script_executions` export-policy entry** (`tenantExportPolicyRegistry.ts:487`; monitors W04 adds `script_executions.monitor_id`). Same rebase rule.
4. `script_executions` will carry **both** `trigger_type` (the shipped `pgEnum` `manual|scheduled|alert|policy|automation`, `apps/api/src/db/schema/scripts.ts:23`, **verified**) **and** the new `trigger_kind` text column. They are not the same thing and are allowed to disagree (`trigger_type = 'automation'` + `trigger_kind = 'sweep_finding'` is a legitimate row). W01 Task 2 requires a docstring on both saying so.

## Global constraints (apply to every wave)

- **Tenancy: no new tables in this entire feature.** Every change is a column on an already-registered table, so `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_DEVICE_CASCADE_DELETE_TABLES` and `CORE_DEVICE_ORG_DENORMALIZED_TABLES` are untouched — **verified**: `action_intents` (`tenantCascade.ts:231`), `ai_agent_fix_watches` (`:243`), `automation_action_results` (`:340`), `network_monitors` (`:545`), `script_executions` (`:638`) are all already registered. **`CORE_TENANT_EXPORT_POLICY` is the list that fires on a new COLUMN, and every wave that adds one must edit it in the same PR.**
- Every new column in this feature is a scalar (text / varchar / uuid / timestamptz / boolean) and classifies **`included`**. No wave adds a `json`/`jsonb`/`bytea` column; if one ever appears it is `excludedOpen`, no exceptions.
- Migrations: hand-written SQL in `apps/api/migrations`, idempotent (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` then re-add, `DO $$ … $$` guards, `pg_policies` existence checks), **no inner `BEGIN`/`COMMIT`**, never edit a shipped file. Any `UPDATE`/`DELETE`/`INSERT` must be preceded by `SELECT set_config('breeze.scope', 'system', true);` and report its row count via `GET DIAGNOSTICS` + `RAISE WARNING` — `apps/api/src/db/migrationRlsScope.test.ts` carries a frozen baseline of 122 pre-existing offenders and **no file from this feature may join it**. Three of the four migrations here are pure DDL and therefore trivially clean; only W04's is not, and it is written to avoid DML too.
- **The `action_intents` immutability trigger is a fifth registration list.** `action_intents_block_content_update()` is a **DENY-LIST** — a new column is mutable unless named (`apps/api/migrations/2026-10-16-120300-action-intents-script-reviewer.sql:17`, header comment, **verified**). Creation-time-only columns on `action_intents` must be added to a fresh `CREATE OR REPLACE` of that function **and** to the hand-written list in `apps/api/src/db/migration-action-intents.test.ts:184` **and** covered by `apps/api/src/__tests__/integration/actionIntentsImmutabilityTrigger.integration.test.ts`.
- **CI traps.** `pnpm test` runs neither the RLS config (`vitest.config.rls.ts`) nor the integration config (`vitest.integration.config.ts`) — local green is not CI green, and the export-policy and cascade suites live only in **Integration Tests**. Stand a live DB up with `pnpm test-stack up` and tear it down with `pnpm test-stack down` (nothing reaps it for you). A PR based on a sibling branch runs **no** CI at all (`ci.yml` triggers on `pull_request: branches: [main]`), which makes `gh pr checks` read green — dispatch per branch with `gh workflow run CI --ref <branch>` before merging a stacked PR.
- **`vitest run <path>` is a substring filter, not a glob.** `vitest run src/services/aiAgents/fixWatch` also matches `fixWatch.sql.test.ts`; `vitest run src/routes/foo/` silently skips the sibling `src/routes/foo.test.ts`. List dotted siblings explicitly and always check the reported file count. Never write `pnpm --filter <pkg> test -- --run <path>` — the literal `--` is forwarded into argv and vitest swallows `--run`, running the whole suite in watch mode. Use `cd apps/api && npx vitest run <paths>`.
- Every task: **red test first** (write the assertion, run it, see it fail for the right reason), then implement, then `pnpm --filter @breeze/api exec tsc --noEmit`, then the targeted suites, then one commit. The last task of every wave lists the live-DB suites.
- Web: mutations go through `runAction` (`apps/web/src/lib/runAction.ts`); UI state in `window.location.hash`; every new i18n key needs a **real translation** in all 8 locales (`apps/web/src/locales/{en,pt-BR,es-419,fr-FR,fr-CA,de-DE,it-IT,tr-TR}/`), enforced by `apps/web/src/lib/i18n/localeParity.test.ts` and `translationCoverage.test.ts`.
- AI-agent invariants that bind every wave: `hasScope → human_required` is the line W04 replaces and nothing before W04 may touch it; T3 never auto-executes without either a human or a *complete* policy authorization; the circuit breaker and budget in `runService.ts` are untouched; no `'sweep'` / `'verdict'` profile literal may enter `aiGuardrails.ts`, `executionLedger.ts`, `policyDecide.ts` or `actRevalidation.ts` (`verdictProfile.contract.test.ts` enforces it).

## Spec corrections resolved during planning (authoritative over the spec text)

These are the spec's "not verified" or slightly-off claims, re-read against `origin/main` and resolved here. Each wave file repeats the one that binds it.

1. **`ai_agent_fix_watches.alert_id` is already nullable.** `apps/api/migrations/2026-09-18-ai-agents-safety-controls.sql:50` declares `alert_id uuid REFERENCES alerts(id) ON DELETE SET NULL` and `apps/api/src/db/schema/aiAgentFixWatches.ts:66` has no `.notNull()` (**verified**). W02's migration therefore relaxes nothing; the "re-assert the one-watch-per-intent invariant" obligation reduces to leaving `ai_agent_fix_watches_intent_uq` alone and adding a test that proves it still holds for a sweep watch.
2. **No `subject_device_id` column.** `ai_agent_fix_watches.device_id` is already `NOT NULL` with no FK (`aiAgentFixWatches.ts:68`, migration `:57`, **verified**); a sweep watch sets it to the intent's `scope_device_id`. A parallel `subject_device_id` would give the table two device columns with no rule about which wins. W02 adds **`subject_kind` and `subject_key` only**.
3. **`tls_observed_host` and `tls_issuer` are NOT already collected.** The Go `http_check` handler emits exactly `monitorId, status, responseMs, statusCode, bodyMatch?, error?, sslExpiry?, sslDaysRemaining?` (`agent/internal/heartbeat/handlers_monitor.go:234-275`, **verified**); `resp.Request.URL` is never read and there is no `finalURL` anywhere in the file. So W03's agent change is ~10 lines, not ~2, and `tls_observed_host` **cannot** be recovered from historical `network_monitor_results.details`.
4. **`tls_state` must come from the agent, not be derived server-side.** A TLS failure returns before certificate extraction and the handler's early-exit paths (`:210`, `:223`) emit only `monitorId/status/responseMs/error` — the API cannot distinguish "not TLS" from "handshake failed" from "the check never ran". The agent emits an explicit `sslState`.
5. **Freshness cannot anchor on `run.finished_at`.** Sweep intents are minted inside `finalizeSweep`, which runs *before* `finishRun` writes `finished_at`, and `attemptPolicyDecision` fires from `createActionIntent`'s post-commit trigger — so `run.finished_at` is null at the only moment the gate would read it. W04 anchors freshness on `action_intents.created_at` and on the trusted subject's own `observedAt` instead.
6. **The graduation join needs two arms.** `intentEvidenceSourceId(intentId)` returns the bare intent id, but a watch row's source id is `` `${watchId}:${opKey}` `` (`apps/api/src/services/aiAgents/opEvidence.ts:129`, `:137`, **verified**) — and after W02 the sweep lane's `verified` rows are *watch* rows, not intent rows. W05's sweep counter joins both arms with a shape guard on the `::uuid` cast.
7. **`promoteThreshold`'s default is 20, not 10** (`packages/shared/src/types/aiAgents.ts:187`, **verified**). The new `sweepPromoteThreshold` default of 10 from the spec stands as its own field; do not "reconcile" the two.

## Post-merge

Register the feature with the `feature-lifecycle` MCP server after Gate B (`register_feature`, one `wave` sub-issue per wave), then replace `tracking_issue: TBD` in every wave file's frontmatter with `LanternOps/breeze#<parent>` and `wave_issue` / `branch` with the real numbers. Each wave PR body carries `Closes #<wave sub-issue>`.
