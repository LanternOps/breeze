---
tracking_issue: LanternOps/breeze#4342
---

# High-Volume Table Retention Windows (#4342) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Rigor: HIGH for every wave.** Every job here deletes or rewrites tenant history and cannot be undone. TDD, one independent review per wave, and integration tests against real Postgres for every guard.

**Goal:** Give the ~25 still-unbounded tables from #4342 a bounded, terminal-rows-only retention window. Make `client_ai_org_policies.retention_days` do what its UI promises, and add a technician transcript window. Every job ships report-only, and nothing deletes in production until Todd turns it on.

**Architecture:** W0 adds one shared runner, `runRetentionTarget`. It evaluates a single eligibility predicate in one of two modes. `report` counts the eligible rows (bounded) and publishes the count. `enforce` deletes or scrubs them in `ctid` batches, one system transaction per batch. Each later wave is a set of declarative targets (table, predicate builder, knobs) behind its own `<NAME>_RETENTION_ENFORCE` flag, which defaults to `false`. W4 cannot use the delete runner: it turns AI sessions into scrubbed stubs with a multi-statement batch, under the same report/enforce switch.

**Tech Stack:** TypeScript (Hono API, BullMQ workers), Drizzle (queries only) + hand-written SQL migrations, PostgreSQL, Vitest (unit + `vitest.integration.config.ts`), React (Astro islands) for the W4 settings cards and viewers.

**Spec:** `docs/superpowers/specs/platform-ci/2026-11-08-high-volume-table-retention.md` (approved; merged in #11479). Section references (§) below are to the spec. Precedents to read before starting: `apps/api/src/jobs/retentionBatch.ts`, `jobs/webhookDeliveryRetention.ts` (+ test), `jobs/aiToolOutputRetention.ts` (+ `__tests__/integration/aiToolOutputRetention.integration.test.ts`), `jobs/aiTranscriptSweeper.ts`.

## Global Constraints

- **Report first, everywhere.** Each job reads `<NAME>_RETENTION_ENFORCE`. In the release that adds the job, the code default is `false`, so the job only counts. An unset, empty or unparseable value means report. That deliberately overrides the spec's "operational waves enforce on deploy" (§3.4, last paragraph). The dispatch brief requires a dry run and a Todd gate before any production deletion. See *Rollout gates* below.
- **Never set an `_ENFORCE` variable on a production deployment, and never merge a Part B (default-flip) PR, without Todd's explicit go.** Implementers stop at the open Part A PR.
- **Terminal rows only.** A row in a non-terminal state is never eligible, whatever its age. Status lists are written out explicitly. `device_commands.status` is an unconstrained varchar.
- **One predicate builder per target.** The report count and the enforce batch call the same `where(cutoffIso, nowIso)` function. No job builds its predicate twice.
- **Never wrap a sweep in a DB context.** `pruneInCtidBatches` / `updateInCtidBatches` / the W4 batch each open a fresh system context per batch (`retentionBatch.ts` header).
- **The outer table is referenced by its bare name.** `countEligibleRows`, `pruneInCtidBatches` and `updateInCtidBatches` select `FROM <table>` with no alias, so a correlated subquery writes `alerts.rule_id`, never `a.rule_id`. Inner subqueries alias their own table (`n`, `l`), as `webhookDeliveryRetention.ts` does. In the target tables below, `a.`/`r.`/`p.`/`e.`/`rr.` are shorthand for that bare name.
- **tz-less columns compare against UTC wall time.** Most predicate columns are `timestamp without time zone` holding UTC. Compare them with `utcWallTime(cutoffIso)` (W0 moves it into `retentionBatch.ts`), never a bare `::timestamp` cast. Compare `timestamptz` columns with `${cutoffIso}::timestamptz`.
- **Knob names are literals** so `system/connections/envScan.ts` sees them: `resolveRetentionDays(process.env.X_RETENTION_DAYS, …)`, `parsePositiveIntEnv(LOG, 'X_RETENTION_BATCH_SIZE', …)`, `retentionEnforceFromEnv(LOG, 'X_RETENTION_ENFORCE', false)`. Never build a name from a prefix.
- **Every new env var is registered in four places** (contract tests `envReadComposeCoverage.test.ts` / `envComposeParity.test.ts`): `apps/api/src/system/connections/internalEnvVars.ts`; the `x-api-env` anchor of **both** `docker-compose.yml` and `deploy/docker-compose.prod.yml` as `${VAR:-}`; and `apps/docs/src/content/docs/deploy/environment.mdx`. List the version's new mappings in `apps/docs/src/content/docs/deploy/upgrades.mdx`.
- **Every new worker is registered in five places:** a `JOB_SCHEDULES` slot (`jobs/scheduleRegistry.ts`, daily lane minute ≡ 3 mod 5); a `global`-placement entry in `services/workerRegistry.ts`; `consumers('<name>')` in `jobs/workerReadinessManifest.ts`; its metric name in `RETENTION_JOB_NAMES` (`services/retentionMetrics.ts`, kept sorted); and a `services/workerRegistry.<name>.test.ts` modelled on `workerRegistry.webhookDeliveryRetention.test.ts`.
- **Windows (OD 6, approved as listed):** see each wave's target table. Hard max 1095 unless noted. `DEVICE_COMMAND_RETENTION_DAYS` has a floor of 90, tied to `DEVICE_INSTALL_LOOKBACK_MS`.
- **Untouched:** `client_ai_usage`, `ai_cost_usage`, `unifi_device_telemetry`, and every window in the spec §1 "already fixed" table.
- **CPU budget (shared host):** vitest with `--pool=forks --poolOptions.forks.maxForks=4`, test files named explicitly (or `vitest --changed origin/main`). One `tsc` at a time with `NODE_OPTIONS=--max-old-space-size=20480`. Check the exit code; never pipe tsc to `tail`. No background CI pollers.
- **Public repo:** no hostnames, IPs, deployment names or customer names in code, docs, PR bodies or release notes. Say "each production deployment".

## Settled decisions (spec §6, all on the recommendation; no override comments on #4342)

| OD | Settled as | Lands in |
|---|---|---|
| 1 | Purge = **stub**: content goes, the session row's accounting and flag metadata stay | W4 |
| 2 | Flagged sessions are **held** while flagged | W4 |
| 3 | Stub + scrubbed tool rows are hard-deleted at the org's **audit-retention** window (default 365) | W4 |
| 4 | New `ai_data_policies.transcript_retention_days`, partner ceiling / org tighten-only, code default **365** | W4 |
| 5 | Operational tables: **operator env only** | W1–W3, W5 |
| 6 | Windows **as listed** in §3.2 | all |
| 7 | Keep the newest closed alert per key; keep ticket/PSA-linked alerts; two NO ACTION FKs → SET NULL | W3 |
| 8 | Skip evidence-backed `report_runs`; `file_transfers` cascade with their session (moot: the table is gone; correction 11) | W5 |
| 9 | Follow-ups only: drop `patch_compliance_snapshots`; `pg_repack` runbook | W6 |
| 10 | Preview release with counts, then enforce | W4 (and generalized to every wave as report-first) |

## Plan-time corrections to the spec (verified at `1c9ad32828`)

Each one changes a predicate. Executors follow this plan where the two differ.

1. **`scriptMonitor` keys on `(monitor_id, device_id)`, not `(device_id, script_id)`.** `services/alertConditions/handlers/scriptMonitor.ts:124-139` orders by `completed_at DESC NULLS LAST`, and `jobs/monitorScriptWorker.ts:152` takes the newest by `created_at` for the same key. `services/scriptLastRun.ts:62-66` reads `max(created_at)` per script with no window. W2 keeps the newest terminal row per `(monitor_id, device_id)` and per `script_id`.
2. **`script_execution_batches` never reaches a terminal status.** The only status write is `'queued'` (`services/scriptExecution.ts:470`), and nothing writes `completed_at`. W2 ages batches by `created_at` at the row window (365 d).
3. **Three `device_commands` readers take the newest row per device, with no window, and each uses its own filter and ordering.** W1 keeps exactly the row each reader would return (`KEEP_NEWEST_COMMAND_READERS`):
   - `routes/devices/patches.ts:375-395` — `patch_scan`, status in (completed, failed, timeout), newest by `COALESCE(completed_at, created_at)`.
   - `services/logsNotArriving.ts:60-76` — `set_log_level`, `completed_at IS NOT NULL`, newest by `completed_at`.
   - `services/deviceUninstallState.ts:72-90` — `self_uninstall` with `uninstall_reasons @> {device_remove}`, any status, newest by `created_at`.
4. **Alert links are three tables, not two.** `ticket_alert_links`, `psa_ticket_mappings` and `alert_external_refs` (partner-principal ticket refs) all CASCADE on alert delete. W3 exempts an alert linked by any of them.
5. **Keep-newest keys must be NULL-safe.** `alerts.device_id` is nullable (non-device owners), so the guard uses `IS NOT DISTINCT FROM`. Otherwise every NULL-keyed row counts as "newest" and is kept forever.
6. **Abandoned `active` AI sessions.** A session whose process died, or that never loaded into memory, stays `active` (`streamingSessionManager.ts:2620-2640` expires only evicted in-memory sessions). Under §3.3's "closed or expired" such a session would never be purged. W4 also treats `active` sessions idle past the window as eligible, and sets them `expired` when it stubs them.
7. **The session row has more content columns** than §3.3 lists: `system_prompt` and `context_snapshot` (`db/schema/ai.ts:48-49`). The technician detail route returns every column (`routes/ai.ts:338-355`). W4 nulls both, and also the free-text `ai_tool_executions.error_message`, which is not on §3.3's list of columns to keep. `options` is model configuration and stays.
8. **Screenshots are files, not rows.** Deleting an `ai_screenshots` row orphans `SCREENSHOT_DIR/…/<uuid>.jpg` (`services/screenshotStorage.ts:1-18`). W4 *expires* a session's screenshots (`expires_at = LEAST(expires_at, <now as UTC wall time>)`) so `helperScreenshotRetention` removes the file and then the row. The stub hard-delete waits until none remain.
9. **The topology audit filter fails open** on a missing session (`routes/ai.ts:123-140`, `NOT EXISTS (… hidden)`). W4 rewrites it to fail closed, as §3.3 asks.
10. **Existing partner `ai_data_policies` rows would read the new column as "keep forever".** A partner row present means "its value", and NULL means forever. W4's migration therefore backfills `transcript_retention_days = 365` on existing partner rows, inside the same guarded block that adds the column. The partner PUT also writes 365 on insert when the field is absent, mirroring `toolOutputRetentionDays` (`routes/partnerAiDataPolicy.ts:93`).
11. **`file_transfers` no longer exists.** `migrations/2026-07-12-drop-file-transfers.sql:23` dropped it, and `remote_sessions` has no inbound FK. OD 8's "cascade file transfers" half is therefore moot. W5 has no FK migration.
12. **`ai_agent_runs` has two RESTRICT children, and the first never ages out.**
    - `action_intents` (`actionIntents.ts:526-530`) is never deleted by any job; only org erasure removes it.
    - `ticket_drafts` (`ticketDrafts.ts:89-91`).
    - Two blob-backed CASCADE children: `ai_run_artifacts` and `ai_run_workspaces`, which have their own sweepers (`aiArtifactSweeper`, `workspaceReaper`).

    W5 excludes runs referenced by any of the four.
13. **`patch_job_results` has unwindowed readers.**
    - `services/patchInstallFailures.ts:199-240` reads the latest attempt per `(device_id, patch_id)`. `patch_id` is nullable (`db/schema/patches.ts:301`), so the key is compared with `IS NOT DISTINCT FROM`.
    - `services/patchAlerts.ts:323-340` takes `MIN(completed_at)` over completed `reboot_required` rows without consulting `rebooted_at`. Its caller runs only while `devices.pending_reboot` is true.

    W5 keeps the newest row per `(device_id, patch_id)`. It also keeps every `reboot_required` row of a device that is still pending a reboot. (`patchEvidence.ts` lives at `services/aiAgents/patchEvidence.ts` and reads 30 days.)
14. **Unread `approval` notifications are still actionable.** `services/actionIntents/intentService.ts:1290-1303` calls the notification the only channel a phoneless approver has. W5 exempts unread `approval` rows from the 365-day rule.
15. **Newest-per-key readers with no window:**
    - Device posture: `services/securityPosture.ts` `row_number() over (partition by device_id …)` at `:694`, `:988`, `:1114`, `:1181`.
    - Report runs: the per-report run list.

    W5 keeps the newest snapshot per device and the newest run per report, so a device or schedule that went quiet a year ago does not vanish from its screen. The maximum trend window is 90 days (`routes/security/compliance.ts:41`, `portal/securityReadModel.ts:181`), under the 365-day window.
16. **`network_change_events`' handler is dead code.** It uses the bare `db` and skips `profile_id IS NULL`. W5 replaces it with a target and deletes the unused `prune-change-events` type, case and handler (`jobs/networkBaselineWorker.ts:63`, `:96-97`, `:386-408`).
17. **The auth `sessions` table has a reader.** `services/userRiskScoring.ts:655-665` reads rows with `created_at >= now − 30 d`, and rows expire 7 days after creation (`services/session.ts:7`). W5 ages them by `created_at`, with a 30-day default and a 30-day floor, and requires `expires_at` to have passed.
18. **The `remote_sessions.recording_url` column is a link the user types in.** It is not stored media: `routes/remote/sessions.ts:1352` (`normalizeRecordingUrl`), and Breeze does not record sessions. Deleting the row orphans no file. The release note says the link goes with the session.
19. **One metric name per target.** `breeze_retention_backlog_incomplete` and the new `rows_eligible` gauge are `.set()` per `job_name`. Two targets sharing a name would overwrite each other's G1 evidence. W2 and W3 therefore register a name per target, as W5 does.

## Rollout gates (every wave)

Each wave ships as **two PRs**:

- **Part A — report-only.** Adds the job with `<NAME>_RETENTION_ENFORCE` defaulting to `false`, plus migrations, registrations, docs and tests. It can merge on green CI and a clean review. It deletes nothing.
- **Gate G1 — evidence (Todd).** After Part A reaches each production deployment, collect at least **three** nightly report runs: the `[<Job>] REPORT-ONLY` log line, and the `breeze_retention_rows_eligible{job_name}` gauge. Also run that wave's read-only **guard check SQL** (given per wave). Then confirm a current database backup exists. Todd reviews the counts and decides whether to set `<NAME>_RETENTION_ENFORCE=true` on that deployment. **That production change is Todd's, not the implementer's.**
- **Gate G2 — default flip (Todd).** After at least one week of clean enforcement in production (no new Sentry errors, and `breeze_retention_backlog_incomplete` trending to 0), open **Part B**. It changes the code default to `true` and adds a release-notes line saying the first run deletes history older than the window. Part B merges only on Todd's go. For W4, Part A is the spec's "preview release" and Part B its "enforcing release" (§3.4).

**Release notes:** never edit `docs/release-notes/next-release-draft.md` from a wave branch, because it is a merge-queue conflict hot spot. Put the release-notes text in the PR body under `## Release notes` for the release owner.

## Migrations

`apps/api/migrations/README.md` rules apply. Shipped names run into 2027; the newest on `main` at planning time is `2027-01-22-211200-invoice-payments-idempotency-key.sql`. **The `2027-01-22-2307xx` names below are placeholders.** At implementation time, re-check `ls apps/api/migrations | sort | tail -3`, and rename to sort after the newest file **before** opening the PR. Re-check again before enqueueing: a newer migration merged in between poisons the merge queue. Never rename a migration that has shipped. Run `pnpm db:check-drift` after each one.

| Wave | Placeholder | Kind | Content |
|---|---|---|---|
| W1 | `2027-01-22-230700-retention-w1-indexes.sql` | `-- @no-transaction` | 4 partial/composite indexes, CONCURRENTLY, plus an INVALID guard |
| W2 | `2027-01-22-230710-script-executions-output-purged-at.sql` | transactional | `ADD COLUMN IF NOT EXISTS output_purged_at timestamptz` |
| W2 | `2027-01-22-230711-script-executions-terminal-age-idx.sql` | `-- @no-transaction` | 1 partial index plus a guard |
| W3 | `2027-01-22-230720-alert-retention-fk-set-null.sql` | transactional | `log_correlations.alert_id`, `network_change_events.alert_id` → SET NULL |
| W3 | `2027-01-22-230721-alerts-closed-age-idx.sql` | `-- @no-transaction` | 1 partial index plus a guard |
| W4 | `2027-01-22-230730-ai-transcript-retention-columns.sql` | transactional, **writes rows** | 2 columns + CHECK + partner backfill (system scope first) + 2 FKs → CASCADE |
| W4 | `2027-01-22-230731-ai-sessions-retention-idx.sql` | `-- @no-transaction` | 1 partial index plus a guard |
| W5 | `2027-01-22-230740-history-retention-indexes.sql` | `-- @no-transaction` | 7 indexes listed in W5, plus a guard (no FK migration: correction 11) |

- **FK changes** use the idempotent "drop unless already correct, then add the canonical name" DO block from `migrations/2026-11-01-100000-discovery-history-fk-set-null.sql`. Canonical names are `<table>_<col>_<ref>_id_fk`, for example `log_correlations_alert_id_alerts_id_fk`. None of them names `org_id`, so the DEFERRABLE rule does not apply.
- **Index files** copy `migrations/2027-01-19-110300-alerts-rule-device-subject-closed-idx.sql`: `CREATE INDEX CONCURRENTLY IF NOT EXISTS …`, then one DO block that raises on any INVALID index the file names. Each index is declared in the Drizzle schema too, so drift stays clean.
- **The W4 backfill** is the only row write. It goes inside the same DO block as the guarded `ADD COLUMN`, behind `SELECT set_config('breeze.scope', 'system', true)` (`migrationRlsScope.test.ts`), and reports its count with `GET DIAGNOSTICS … RAISE WARNING`.

## Tenancy registrations

- **No new table.** No RLS policy changes. Jobs run in system scope.
- **Export policy, one line per new column** (`CORE_TENANT_EXPORT_POLICY` in `services/tenantExportPolicyRegistry.ts`, all `included`, none json):
  - `script_executions.output_purged_at` (W2)
  - `ai_sessions.transcript_purged_at` (W4)
  - `ai_data_policies.transcript_retention_days` (W4)
- These fail **only under Integration Tests** (`tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`), never under Test API. Run them locally before the PR (`pnpm test-stack up`).
- **The FK changes** (W3, W4) are checked by `__tests__/integration/orgCascadeFkOnDelete.integration.test.ts`. CASCADE and nullable SET NULL are both "safe" there, so no allowlist change is expected; run it anyway.
- **`CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`, and the device/ticket lists:** no change. No table is added or removed. W6's `patch_compliance_snapshots` drop is the exception, and it is its own follow-up PR.

## CI traps

- **No stacked PRs.** Every wave branches from fresh `origin/main` after W0 merges. A PR whose base is not `main` runs no CI (only the smoke-binary workflows, which read as green). If one is unavoidable, use `gh workflow run CI --ref <branch>`.
- **`pnpm test` does not run the integration or RLS suites.** Every guard in this plan has an integration test under `apps/api/src/__tests__/integration/`. Run it with `cd apps/api && npx vitest run --config vitest.integration.config.ts --pool=forks --poolOptions.forks.maxForks=4 src/__tests__/integration/<file>` against `pnpm test-stack up`. Run `pnpm test-stack down` when done.
- **Never `pnpm --filter @breeze/api test -- --run <path>`.** Vitest path filters are substring matches. Use `cd apps/api && npx vitest run <exact file> --pool=forks --poolOptions.forks.maxForks=4`.
- **Shared-file conflicts between parallel waves.** W1–W5 all append to `scheduleRegistry.ts`, `workerRegistry.ts`, `workerReadinessManifest.ts`, `retentionMetrics.ts`, `internalEnvVars.ts`, both compose files, `environment.mdx` and `upgrades.mdx`. The second wave to merge rebases. Resolve conflicts by keeping **both** sides; never drop another wave's lines. The slots below are pre-allocated per wave so that `scheduleRegistry.contract.test.ts` never sees a collision between waves.

| Wave | Schedule keys → pattern |
|---|---|
| W1 | `device-command-retention` `8 11 * * *`, `filesystem-snapshot-retention` `18 11 * * *`, `network-monitor-result-retention` `33 11 * * *`, `device-session-retention` `48 11 * * *` |
| W2 | `script-execution-retention` `8 12 * * *` |
| W3 | `alert-retention` `8 13 * * *` |
| W4 | `ai-transcript-retention` `8 15 * * *` |
| W5 | `history-retention` `8 16 * * *` (one worker, 12 targets) |

The contract test is authoritative. If it rejects a slot, take the next free ≡ 3 (mod 5) minute in the same hour, and say so in the PR.

## Review Focus

1. **Report and enforce drift.** If the count and the delete use different SQL, Gate G1 approves something other than what runs. Pinned in W0.T2: the rendered SQL of the count's `where` equals the rendered SQL of the prune's `where`, byte for byte.
2. **A malformed `_ENFORCE` value.** `ENFORCE=yes`, `ENFORCE=TRUE `, or an empty string from `${VAR:-}` in compose must never enable deletion by accident. Only `true`/`1` (case-insensitive, trimmed) enforce, and anything unrecognised logs a warning and reports. Pinned in W0.T1.
3. **NULL-keyed keep-newest guards.** Alerts with `device_id IS NULL`, and patch summary results with `patch_id IS NULL`, must still age out, except for the newest. A plain `=` silently keeps them all. Pinned in W3.T4 and W5.T8 (integration) with `IS NOT DISTINCT FROM`.
4. **Abandoned `active` AI sessions.** A transcript retention promise that skips sessions left `active` by a crashed process is false. Pinned in W4.T3 (integration): such a session is stubbed and set to `expired`.
5. **tz-less cutoffs.** A connection `TimeZone` other than UTC must not shift a cutoff by hours. Pinned in W0.T1: `utcWallTime` renders `AT TIME ZONE 'UTC'`. Every wave's unit test asserts its predicate uses it for `timestamp without time zone` columns.

---

## Wave overview

| Wave | Scope | Depends on | Migrations | Web | PRs |
|---|---|---|---|---|---|
| W0 | Report/enforce runner, `rows_eligible` metric, `utcWallTime` | — | none | no | 1 |
| W1 | `device_commands`, `device_filesystem_snapshots`, `network_monitor_results`, `device_sessions` | W0 | 1 | no | A + B |
| W2 | `script_executions` (scrub output, then delete), `script_execution_batches` | W0 | 2 | small (output-removed note) | A + B |
| W3 | Alerts family + 2 FK changes | W0 | 2 | no | A + B |
| W4 | AI transcripts: stub job, tech + client windows, previews, viewers, topology filter | W0 | 2 | yes (cards, viewers, 8 locales) | A + B |
| W5 | Tier 3 history (10 tables, 11 targets) + `network_change_events` | W0 | 1 | no | A + B |
| W6 | Follow-ups: drop `patch_compliance_snapshots`, `pg_repack` runbook, second-pass inventory | W1 (repack), none (others) | 1 (drop) | no | 2–3 |

**Cross-wave parallelism.** W0 is small and merges first. After that, **W1, W2, W3, W4 and W5 are independent** and can run as five parallel fixers, each in its own worktree off fresh `main`, subject to the CPU budget: at most two vitest processes at once host-wide. The API/web seam exists only in W2 (one component) and W4. W6's repack runbook waits for W1 to be enforced in production.

---

## W0 — Report/enforce runner

### Execution split and parallelism (W0)
- One branch `feature/4342-retention/w0`, one PR `feat(api): report-first retention runner (#4342 W0)`, body `Refs #4342`. No migrations, no web.
- Order **T1 → T3 → T2**, sequential: T2 consumes T1's primitives and T3's `rowsEligible` field. T1 and T2 → Opus (they are the safety gate for every later delete). T3 → Sonnet (metric plumbing to a given interface).
- One independent review over the branch (Opus).

### Task W0.T1: Batch primitives — count, scrub, enforce flag, UTC wall time

**Files:**
- Modify: `apps/api/src/jobs/retentionBatch.ts`
- Modify: `apps/api/src/jobs/aiToolOutputRetention.ts` (import `utcWallTime` from `retentionBatch` instead of its local copy at `:144`)
- Test: `apps/api/src/jobs/retentionBatch.test.ts`

**Interfaces — Produces:**
```ts
/** `(${iso}::timestamptz AT TIME ZONE 'UTC')` — compare a `timestamp without time zone` UTC column against an ISO cutoff. */
export function utcWallTime(iso: string): SQL;
/** `true`/`1` → true, `false`/`0` → false (trimmed, case-insensitive); unset or empty → codeDefault; anything else → console.warn + false. */
export function retentionEnforceFromEnv(logPrefix: string, name: string, codeDefault: boolean): boolean;
/** One fresh system context: SELECT count(*)::int FROM (SELECT 1 FROM <table> WHERE <where> LIMIT cap + 1) s. capped = n > cap; eligible = min(n, cap). */
export async function countEligibleRows(o: { table: string; where: SQL; cap: number; label: string }): Promise<{ eligible: number; capped: boolean }>;
/** pruneInCtidBatches' twin: UPDATE <table> SET <set> WHERE ctid IN (SELECT ctid FROM <table> WHERE <where> LIMIT n). `where` MUST exclude already-updated rows. */
export async function updateInCtidBatches(o: { table: string; set: SQL; where: SQL; batchSize: number; maxBatches: number; label: string }): Promise<BatchedPruneResult>;
```

- [ ] **Step 1: Write the failing tests** in `retentionBatch.test.ts`:
  - `retentionEnforceFromEnv`: a table-driven case list. `'true'`, `'TRUE'`, `' 1 '` → `true`. `'false'`, `'0'` → `false`. `undefined` and `''` → `codeDefault` (assert both `false` and `true` defaults). `'yes'`, `'enforce'`, `'2'` → `false`, plus `console.warn` called once naming the variable.
  - `utcWallTime('2026-01-01T00:00:00.000Z')`, rendered via `new PgDialect().sqlToQuery`: SQL contains `::timestamptz AT TIME ZONE 'UTC'`, and params equal `['2026-01-01T00:00:00.000Z']`.
  - `countEligibleRows`: the mocked `db.execute` receives one statement whose SQL contains `LIMIT` with param `cap + 1` and the table name. With a driver result of `[{ n: 11 }]` and `cap: 10`, it returns `{ eligible: 10, capped: true }`; `[{ n: 3 }]` returns `{ eligible: 3, capped: false }`. A missing row throws (never reads as 0). A non-identifier table (`'x; drop'`) throws before any query.
  - `updateInCtidBatches`: it stops on a short batch. `hasMore` is true only when the cap is hit on a full batch (mirror the existing `pruneInCtidBatches` tests). The SQL starts `UPDATE` and contains `SET` and `ctid IN (SELECT ctid`. The same identifier, `batchSize` and `maxBatches` guards apply.
- [ ] **Step 2: Run them and see them fail.** Run `cd apps/api && npx vitest run src/jobs/retentionBatch.test.ts --pool=forks --poolOptions.forks.maxForks=4`. Expected: FAIL, `retentionEnforceFromEnv is not a function` (and similar).
- [ ] **Step 3: Implement the four exports** in `retentionBatch.ts`. Reuse `BARE_IDENTIFIER`, `inFreshSystemContext` and `extractRowCount`. Add a header paragraph, "REPORT FIRST", explaining that `countEligibleRows` caps at `cap + 1` so a backlog never becomes a full-table count. Point `aiToolOutputRetention.ts` at the shared `utcWallTime`.
- [ ] **Step 4: Run the tests and see them pass.** Run the Step 2 command plus `src/jobs/aiToolOutputRetention.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(api): retention count/scrub primitives and enforce flag (#4342 W0)`.

### Task W0.T2: `runRetentionTarget` — one predicate, two modes

**Files:**
- Create: `apps/api/src/jobs/retentionTarget.ts`
- Test: `apps/api/src/jobs/retentionTarget.test.ts`

**Interfaces — Consumes:** W0.T1 exports; `pruneInCtidBatches`, `warnOnRetentionBacklog`; `recordRetentionRun` + the `rowsEligible` field from W0.T3 (which lands before this task).

**Interfaces — Produces:**
```ts
export type RetentionAction = { kind: 'delete' } | { kind: 'scrub'; set: SQL };
export interface RetentionTarget {
  metricName: RetentionJobName;          // a RETENTION_JOB_NAMES member
  table: string;                          // bare literal identifier
  action: RetentionAction;
  /** The ONLY predicate. Report and enforce both call it with the same cutoff and the same run instant (nowIso feeds per-row windows, W5). */
  where: (cutoffIso: string, nowIso: string) => SQL;
}
export interface RetentionKnobs { retentionDays: number; batchSize: number; maxBatches: number; enforce: boolean }
export type RetentionTargetResult =
  | { mode: 'report'; table: string; retentionDays: number; eligible: number; eligibleCapped: boolean; durationMs: number }
  | { mode: 'enforce'; table: string; retentionDays: number; affected: number; batches: number; hasMore: boolean; durationMs: number };
export async function runRetentionTarget(
  target: RetentionTarget, knobs: RetentionKnobs, o: { logPrefix: string; label: string; now?: Date },
): Promise<RetentionTargetResult>;
/** Runs targets sequentially; one target throwing is logged + captureException'd and does not stop the rest. Returns per-target results (or { table, error }) in input order. */
export async function runRetentionTargets(
  targets: ReadonlyArray<{ target: RetentionTarget; knobs: RetentionKnobs }>, o: { logPrefix: string; label: string; now?: Date },
): Promise<Array<RetentionTargetResult | { table: string; error: string }>>;
```

Behaviour:
- `cutoffIso = new Date(now - retentionDays * DAY_MS).toISOString()`.
- `nowIso = now.toISOString()`. Both modes call `target.where(cutoffIso, nowIso)` exactly once per run, and pass the result on unchanged.
- **report:** `countEligibleRows({ cap: batchSize * maxBatches })`. Log `${logPrefix} REPORT-ONLY: ${eligible}${capped ? '+' : ''} ${table} rows eligible (window ${retentionDays} d); set <enforce var> to delete`. Call `recordRetentionRun(metricName, { rowsEligible: eligible })`, with no `rowsDeleted` and no `incomplete`. Never call prune or update.
- **enforce:** `delete` → `pruneInCtidBatches`; `scrub` → `updateInCtidBatches`. Then `warnOnRetentionBacklog(logPrefix, table, result)` and `recordRetentionRun(metricName, { rowsDeleted: affected, incomplete: hasMore })`.

- [ ] **Step 1: Write the failing tests.** Mock `./retentionBatch` (keep the actual `utcWallTime`) and `../services/retentionMetrics`:
  - `report mode never writes`: `enforce: false` → `countEligibleRows` is called once with `cap: batchSize * maxBatches`. `pruneInCtidBatches` and `updateInCtidBatches` are never called. `recordRetentionRun` is called with `{ rowsEligible: 7 }` exactly, with no `rowsDeleted` key.
  - `report and enforce render the same predicate`: run the same target once per mode with a fixed `now`. `new PgDialect().sqlToQuery(countArgs.where)` deep-equals `sqlToQuery(pruneArgs.where)`, both `sql` and `params` (Review Focus 1).
  - `enforce delete`: prune is called with the target's table, the knobs' batchSize/maxBatches and the label. `recordRetentionRun` is called with `{ rowsDeleted: 40, incomplete: false }`. With `hasMore: true`, `warnOnRetentionBacklog` is called and `incomplete: true` is recorded.
  - `enforce scrub` routes to `updateInCtidBatches` with the target's `set`.
  - `cutoff`: the param bound into `where` is `now - retentionDays` days, to the millisecond, for a fixed `now`.
  - `runRetentionTargets isolates failures`: target 1 rejects and target 2 still runs. Results are `[{ table: 't1', error: … }, { mode: 'report', table: 't2', … }]`, and `captureException` is called once.
- [ ] **Step 2: Run them and see them fail** (`npx vitest run src/jobs/retentionTarget.test.ts …`). Expected: FAIL, module not found.
- [ ] **Step 3: Implement `retentionTarget.ts`** to the interface above. The module header states the report-first contract and the "one predicate" rule.
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit** — `feat(api): runRetentionTarget report/enforce runner (#4342 W0)`.

### Task W0.T3: `breeze_retention_rows_eligible` gauge + operator docs

**Files:**
- Modify: `apps/api/src/services/retentionMetrics.ts` (`RetentionRunOutcome.rowsEligible?: number`; gauge `breeze_retention_rows_eligible{job_name}` set when present; registered in `registerRetentionPrometheusMetrics`)
- Test: `apps/api/src/services/retentionMetrics.test.ts`
- Modify: `apps/docs/src/content/docs/deploy/environment.mdx` (a short "Report-only retention jobs" subsection: what `<NAME>_RETENTION_ENFORCE` does, its default, and that the gauge and the `REPORT-ONLY` log line are the evidence to read before enabling)

- [ ] **Step 1: Write the failing test.** After `registerRetentionPrometheusMetrics(registry)`, `recordRetentionRun('webhook_delivery_retention', { rowsEligible: 12 })` makes `registry.getSingleMetricAsString('breeze_retention_rows_eligible')` contain `job_name="webhook_delivery_retention"} 12`. A call without `rowsEligible` leaves the gauge untouched, and `rowsDeleted` is not incremented by a report run.
- [ ] **Step 2: Run it and see it fail.**
- [ ] **Step 3: Implement.** Use `safeCount`. Update the "six series" comment.
- [ ] **Step 4: Run** `src/services/retentionMetrics.test.ts src/jobs/retentionTarget.test.ts src/jobs/retentionBatch.test.ts`, then the one-tsc typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=20480 npx tsc --noEmit -p tsconfig.json; echo exit=$?`. Expected: PASS, `exit=0`.
- [ ] **Step 5: Commit** — `feat(api): retention rows-eligible gauge (#4342 W0)`.

---

## W1 — Device telemetry tables (biggest bytes, no FK work)

**Targets** (all `delete`; one file and one worker each; metric names in parentheses):

| Job file | Table | Eligible (all hold) | Default / max | Knob prefix |
|---|---|---|---|---|
| `deviceCommandRetention.ts` (`device_command_retention`) | `device_commands` | `status IN ('completed','failed','timeout','cancelled')` AND `COALESCE(completed_at, created_at) < utcWallTime(cutoff)` AND the row is not the one any `KEEP_NEWEST_COMMAND_READERS` entry would return for its device | 120 / 365, **floor 90** | `DEVICE_COMMAND_RETENTION_` |
| `filesystemSnapshotRetention.ts` (`filesystem_snapshot_retention`) | `device_filesystem_snapshots` | `captured_at < utcWallTime(cutoff)` AND EXISTS a newer row for the same `(device_id, scan_path)` | 7 / 365 | `FILESYSTEM_SNAPSHOT_RETENTION_` |
| `networkMonitorResultRetention.ts` (`network_monitor_result_retention`) | `network_monitor_results` | `"timestamp" < utcWallTime(cutoff)` AND EXISTS a newer row for the same `monitor_id` | 30 / 365 | `NETWORK_MONITOR_RESULT_RETENTION_` |
| `deviceSessionRetention.ts` (`device_session_retention`) | `device_sessions` | `is_active = false` AND `COALESCE(logout_at, updated_at) < utcWallTime(cutoff)` | 365 / 1095 | `DEVICE_SESSION_RETENTION_` |

- `KEEP_NEWEST_COMMAND_READERS: ReadonlyArray<{ type: string; filter: SQL; orderBy: SQL; reader: string }>` has one entry per reader in correction 3. Each entry uses the reader's exact filter and ordering, and `reader` names its file:line. The guard for an entry is `NOT (device_commands.type = <type> AND <filter on device_commands> AND NOT EXISTS (SELECT 1 FROM device_commands n WHERE n.device_id = device_commands.device_id AND n.type = <type> AND <filter on n> AND <n's order key> > <outer order key>))`.
  - Before writing the entries, read `services/oemUpdates/rebootSweep.ts:160-172` and `services/oemUpdates/releaseSweep.ts:96-108`. Any of them that reads the newest row of a type with no lower age bound gets its own entry, built the same way.
- **Floor.** The device-command floor is `DEVICE_INSTALL_LOOKBACK_DAYS`, a new export from `services/patchInstallFailures.ts` defined as `DEVICE_INSTALL_LOOKBACK_MS / DAY_MS` (90). That links the two constants (§3.2).
  - A configured value below the floor is raised to it with a `console.warn`.
  - The same clamp, floor included, applies to a BullMQ payload's `retentionDays`. The webhook precedent clamps only to the max.
- Batch defaults: 1000 × 100, except `device_filesystem_snapshots` at 100 × 50 (≈200 KB rows).
- All four are tz-less columns, so every predicate uses `utcWallTime`.
- The existing indexes already serve the snapshot keep-newest (`idx_device_filesystem_snapshots_device_path_captured`). That table holds only thousands of rows, so it needs no new index.

**W1 migration** `…230700-retention-w1-indexes.sql` (`-- @no-transaction`):
- `idx_device_commands_terminal_age ON device_commands ((COALESCE(completed_at, created_at))) WHERE status IN ('completed','failed','timeout','cancelled')`
- `idx_device_commands_keep_newest ON device_commands (device_id, type, created_at DESC) WHERE type IN (<the KEEP_NEWEST_COMMAND_READERS types>)`. The existing `idx_device_commands_set_log_level_device_completed` already serves the `completed_at` ordering.
- `network_monitor_results_monitor_ts_idx ON network_monitor_results (monitor_id, "timestamp" DESC)`
- `device_sessions_closed_age_idx ON device_sessions ((COALESCE(logout_at, updated_at))) WHERE is_active = false`
- Plus one DO block raising on any of the four that is INVALID. Declare all four in the Drizzle schema (`db/schema/devices.ts`, `monitors.ts`, `sessions.ts`).

**Guard check SQL (Gate G1):**
- `device_commands`: for each `KEEP_NEWEST_COMMAND_READERS` entry, count the devices whose newest terminal row is older than the window. That is the number of rows the guard retains, and it should equal the drop between `eligible` with the guard and without it.
- Monitors: `SELECT count(DISTINCT monitor_id) FROM network_monitor_results WHERE "timestamp" < cutoff AND monitor_id NOT IN (SELECT monitor_id FROM network_monitor_results WHERE "timestamp" >= cutoff)` gives the paused monitors whose last row must survive.

### Execution split and parallelism (W1)
- Branch `feature/4342-retention/w1` off `main` after W0 merges. **Part A** PR `feat(api): report-only retention for device telemetry tables (#4342 W1)`. **Part B** PR `feat(api): enforce device telemetry retention by default (#4342 W1)`, gated on G2.
- API only, no web seam.
- **PARALLEL GROUP A** (file-disjoint, after T1): T2, T3, T4, T5, one job file + test each. **T6 last**: registrations, compose, docs, all the shared files.
- T1 (migration + schema indexes) → Opus. T2 (device commands: floor + keep-newest) → Opus. T3–T5 → Sonnet, each given its row of the target table above. T6 → Sonnet (mechanical, from the Global Constraints checklists). T7 (integration) → Opus.
- One review (Opus) over the branch.

### Task W1.T1: Indexes

**Files:** Create `apps/api/migrations/2027-01-22-230700-retention-w1-indexes.sql`; Modify `apps/api/src/db/schema/devices.ts`, `monitors.ts`, `sessions.ts`.

- [ ] **Step 1:** Write the migration per the W1 migration block above, copying the structure of `2027-01-19-110300-alerts-rule-device-subject-closed-idx.sql`.
- [ ] **Step 2:** Add the four indexes to the Drizzle table callbacks, with names and predicates identical to the SQL.
- [ ] **Step 3: Verify.** `pnpm test-stack up`, then `cd apps/api && pnpm db:migrate && pnpm db:check-drift`. Expected: the migration applies, and drift reports no differences. Re-run `pnpm db:migrate`: a no-op.
- [ ] **Step 4: Commit** — `feat(db): retention indexes for device telemetry tables (#4342 W1)`.

### Task W1.T2: `device_commands` retention

**Files:** Create `apps/api/src/jobs/deviceCommandRetention.ts` + `.test.ts`. Modify `apps/api/src/services/patchInstallFailures.ts` (export `DEVICE_INSTALL_LOOKBACK_DAYS`). Update the four comments that claim `device_commands` already has retention (`db/schema/filesystem.ts:66`, `oemUpdates.ts:45`, `endpointConversations.ts:56`, `endpointMessages.ts:102`) to point at the new job. The wording differs at each site, so edit by meaning rather than by matching the quote.

**Interfaces — Produces** (the same shape for every W1–W3/W5 job file):
```ts
export const DEVICE_COMMAND_RETENTION_TARGET: RetentionTarget;          // exported for the integration test
export async function runDeviceCommandRetention(job?: { retentionDays?: number; batchSize?: number; maxBatches?: number; forceReport?: boolean }): Promise<RetentionTargetResult>;
export function createDeviceCommandRetentionWorker(): Worker;            // concurrency 1, no DB context wrapper
export async function initializeDeviceCommandRetention(): Promise<void>; // upsertJobScheduler(QUEUE, { pattern: jobSchedule('device-command-retention') }, …)
export async function shutdownDeviceCommandRetention(): Promise<void>;
export const __testOnly: { QUEUE_NAME: string; DEFAULT_RETENTION_DAYS: number; MAX_RETENTION_DAYS: number; MIN_RETENTION_DAYS: number; BATCH_SIZE: number; MAX_BATCHES: number; ENFORCE: boolean };
```
A job payload has no way to turn enforcement on. The only payload switch is `forceReport`: `effective = envEnforce && !job.forceReport`. Every W1–W5 job uses the same rule.

- [ ] **Step 1: Write the failing test**, following `webhookDeliveryRetention.test.ts` (mock `./retentionTarget`'s `runRetentionTarget`, capture the target, render `target.where(cutoff)` with `PgDialect`):
  - The rendered predicate contains `status IN ('completed', 'failed', 'timeout', 'cancelled')` and `COALESCE(completed_at, created_at) <`, and `AT TIME ZONE 'UTC'`. It does not match `/'pending'|'sent'/`.
  - For each `KEEP_NEWEST_COMMAND_READERS` entry, the rendered guard contains its type, its filter (`uninstall_reasons @>` for `self_uninstall`, `completed_at IS NOT NULL` for `set_log_level`, the status list for `patch_scan`) and its order key. A test also asserts that every entry's `reader` names an existing file.
  - `runDeviceCommandRetention({ retentionDays: 30 })` → `knobs.retentionDays === 90` (the payload is floored too).
  - Defaults: `DEFAULT_RETENTION_DAYS === 120`, `MAX_RETENTION_DAYS === 365`, `MIN_RETENTION_DAYS === DEVICE_INSTALL_LOOKBACK_DAYS === 90`, `ENFORCE === false`.
  - Floor: with `DEVICE_COMMAND_RETENTION_DAYS=30` set before a fresh `vi.resetModules()` import, `__testOnly.DEFAULT_RETENTION_DAYS === 90`, with a warning.
  - With env `DEVICE_COMMAND_RETENTION_ENFORCE` unset, `runDeviceCommandRetention()` → `runRetentionTarget` receives `knobs.enforce === false`. With it set to `true`, `runDeviceCommandRetention({ forceReport: true })` → `knobs.enforce === false`.
- [ ] **Step 2: Run it and see it fail.**
- [ ] **Step 3: Implement** with the `webhookDeliveryRetention.ts` shape, delegating the sweep to `runRetentionTarget`. The header comment names every reader the guard protects, and the 90-day floor.
- [ ] **Step 4: Run it and see it pass** (plus `src/services/patchInstallFailures.test.ts` if it exists).
- [ ] **Step 5: Commit** — `feat(api): report-first device_commands retention (#4342 W1)`.

### Tasks W1.T3–T5: snapshots, monitor results, device sessions (PARALLEL GROUP A)

**Files (one task each):** Create `apps/api/src/jobs/filesystemSnapshotRetention.ts`, `networkMonitorResultRetention.ts`, `deviceSessionRetention.ts`, each with a `.test.ts`. Same interface shape as W1.T2, without `MIN_RETENTION_DAYS`.

- [ ] **Step 1: Write the failing test** per job. It asserts that table's row from the W1 target table: the rendered predicate contains the age column with `AT TIME ZONE 'UTC'`. Snapshots and monitor results assert the `EXISTS (… newer …)` clause correlated on the key columns. Sessions assert `is_active = false`. Defaults (7/365, 30/365, 365/1095), `ENFORCE === false`, and `forceReport` turns enforcement off.
- [ ] **Step 2: Run and see it fail. Step 3: Implement. Step 4: Run and see it pass.**
- [ ] **Step 5: Commit** each — `feat(api): report-first <table> retention (#4342 W1)`.

### Task W1.T6: Registrations, compose, docs

**Files:** Modify `jobs/scheduleRegistry.ts` (4 W1 slots), `services/workerRegistry.ts` (4 entries, `placement: 'global'`), `jobs/workerReadinessManifest.ts` (4 `consumers(...)`), `services/retentionMetrics.ts` (4 names, sorted), `system/connections/internalEnvVars.ts` (16 names: `_DAYS`, `_BATCH_SIZE`, `_MAX_BATCHES`, `_ENFORCE` per job), `docker-compose.yml` + `deploy/docker-compose.prod.yml` (16 `${VAR:-}` lines in `x-api-env`), `apps/docs/.../deploy/environment.mdx` (a table row per variable: default, range, schedule, "report-only until `_ENFORCE=true`"), `apps/docs/.../deploy/upgrades.mdx` (the new-mappings row for this version). Create 4 `services/workerRegistry.<name>.test.ts` files.

- [ ] **Step 1: Write the four registry tests** (slot is a daily cron allocated once, `global` placement, readiness consumer, metric name). Run them. Expected: FAIL.
- [ ] **Step 2: Make the registrations.**
- [ ] **Step 3: Verify.** Run the 4 new tests plus `src/jobs/scheduleRegistry.contract.test.ts src/config/envReadComposeCoverage.test.ts src/config/envComposeParity.test.ts src/services/retentionMetrics.test.ts src/services/workerRegistry.test.ts`, then one tsc. Expected: PASS, `exit=0`.
- [ ] **Step 4: Commit** — `chore(api): register W1 retention workers, knobs and docs (#4342 W1)`.

### Task W1.T7: Integration — guards against real Postgres

**Files:** Create `apps/api/src/__tests__/integration/deviceTelemetryRetention.integration.test.ts`.

- [ ] **Step 1: Write the tests.** Seed through `getTestDb()`. Call each `run*Retention({ … })` with `ENFORCE=true` in `process.env` (set before import via `vi.stubEnv` + dynamic import), with a fixed small window:
  - `device_commands`: an old `completed` row is deleted. An old `pending` row survives. Old `patch_scan` rows on one device: all but the newest are deleted. Old `self_uninstall` rows: the newest with the `device_remove` reason survives even when a newer one without that reason exists, and `loadDeviceUninstallState`'s reader returns the same row before and after. An old `install_patches` row inside 90 days survives at window 90. A `backup_storage_sessions` row pointing at a deleted command is cascade-deleted.
  - Snapshots: three old rows for `(d, 'C:\\')` leave exactly the newest. A single old row for `(d, 'D:\\')` survives.
  - Monitor results: a paused monitor whose rows are all old keeps exactly its newest row.
  - Device sessions: an old inactive row is deleted. An old `is_active = true` row survives.
  - **Report mode:** the same seed with `ENFORCE` unset deletes nothing, and returns `eligible` equal to the enforce run's `affected`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run --config vitest.integration.config.ts --pool=forks --poolOptions.forks.maxForks=4 src/__tests__/integration/deviceTelemetryRetention.integration.test.ts`. Expected: PASS. (If one fails, fix the predicate, not the test.)
- [ ] **Step 3: Commit** — `test(api): integration guards for device telemetry retention (#4342 W1)`. Then open **Part A**. The PR body carries the Gate G1 guard-check SQL and a `## Release notes` section listing each table, window and variable, and stating that nothing is deleted until `_ENFORCE=true`. It also names the reader effects once enforced: the device command history list (`routes/devices/commands.ts:942-985`), patch history, and OEM run history page back only as far as the window, and the device sessions `total` (`routes/devices/sessions.ts:337-341`) counts retained rows. `userRiskScoring` reads only `is_active = true` sessions (`services/userRiskScoring.ts:1688-1696`) and is unaffected.

### Task W1.B: Default flip (Part B — after Gate G2 only)
- [ ] Flip each W1 job's `retentionEnforceFromEnv(..., false)` default to `true`. Update the four unit tests' `ENFORCE` expectations and the `environment.mdx` rows. The release-notes text says the first run deletes history older than each window, and how to opt out (`_ENFORCE=false`). One PR, `Refs #4342`. **Do not open it before Todd's go.**

---

## W2 — Script executions (scrub output, then delete rows)

**Targets.** One job file, `scriptExecutionRetention.ts`, with one worker. It runs three targets in order through `runRetentionTargets`. Each target has its own metric (correction 19): `script_execution_output_retention`, `script_execution_retention` and `script_execution_batch_retention`.

| # | Table | Action | Eligible | Default / max | Knobs |
|---|---|---|---|---|---|
| 1 | `script_executions` | **scrub**: `stdout = NULL, stderr = NULL, output_purged_at = now()` | terminal (`'completed','failed','timeout','cancelled'`) AND `output_purged_at IS NULL` AND (`stdout IS NOT NULL OR stderr IS NOT NULL`) AND `COALESCE(completed_at, created_at) < utcWallTime(outputCutoff)` | 90 / 1095 | `SCRIPT_EXECUTION_OUTPUT_RETENTION_DAYS` |
| 2 | `script_executions` | **delete** | terminal AND `COALESCE(completed_at, created_at) < utcWallTime(rowCutoff)` AND NOT newest-terminal per `(monitor_id, device_id)` when `monitor_id IS NOT NULL` AND NOT newest per `script_id` (by `created_at`) when `script_id IS NOT NULL` | 365 / 1095 | `SCRIPT_EXECUTION_RETENTION_DAYS` |
| 3 | `script_execution_batches` | **delete** | `created_at < utcWallTime(rowCutoff)` (correction 2) | follows #2 | — |

- Shared knobs: `SCRIPT_EXECUTION_RETENTION_BATCH_SIZE` (1000), `_MAX_BATCHES` (100), and one `SCRIPT_EXECUTION_RETENTION_ENFORCE` (default `false`) covering all three targets.
- The output window is clamped to ≤ the row window (warn if it is configured above).
- `cancelling` is not terminal.

**Migrations:** `…230710` adds `output_purged_at timestamptz NULL` (with a comment), declared in `db/schema/scripts.ts`. `…230711` (`-- @no-transaction`) adds `script_executions_terminal_age_idx ON script_executions ((COALESCE(completed_at, created_at))) WHERE status IN ('completed','failed','timeout','cancelled')`, plus the guard.

**Web:** where the device Scripts tab and the execution detail render stdout/stderr, show "Output removed after the retention window (<date>)" when `outputPurgedAt` is set. Both API routes that return executions (`routes/devices/scripts.ts:73`, `routes/scripts.ts` execution list/detail) add `outputPurgedAt` to their projection. New locale key in **all 8 locales** (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`).

**Guard check SQL (G1):** count the `(monitor_id, device_id)` pairs and the `script_id`s whose newest terminal execution is older than 365 d. Those rows are retained.

### Execution split and parallelism (W2)
- Branch `feature/4342-retention/w2`. Part A `feat(api): report-only script execution retention (#4342 W2)`. Part B is the default flip after G2.
- **API/web seam:** `outputPurgedAt: string | null` on the execution JSON. T4 (web) can start as soon as T1 lands the column, in parallel with T2/T3.
- **PARALLEL GROUPS:** {T2, T4} after T1; then T3 (registrations) after T2; T5 (integration) last.
- T1 migrations → Opus. T2 job → Opus (two guards, the scrub/delete ordering). T3 registrations, T4 web + 8 locales → Sonnet. T5 → Opus.

### Task W2.T1: Column + index
**Files:** Create both W2 migrations; Modify `apps/api/src/db/schema/scripts.ts`; Modify `apps/api/src/services/tenantExportPolicyRegistry.ts` (`script_executions` gains `output_purged_at` in `included`).
- [ ] **Step 1:** Write both migrations and the schema changes.
- [ ] **Step 2: Verify** `pnpm db:migrate && pnpm db:check-drift` (re-run is a no-op), then the export-policy suites: `npx vitest run --config vitest.integration.config.ts --pool=forks --poolOptions.forks.maxForks=4 src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`. Expected: PASS.
- [ ] **Step 3: Commit** — `feat(db): script_executions.output_purged_at and terminal-age index (#4342 W2)`.

### Task W2.T2: `scriptExecutionRetention.ts`
**Interfaces — Produces:** `SCRIPT_EXECUTION_OUTPUT_TARGET`, `SCRIPT_EXECUTION_ROW_TARGET`, `SCRIPT_EXECUTION_BATCH_TARGET: RetentionTarget`; `runScriptExecutionRetention(job?)` → `Array<RetentionTargetResult | { table; error }>`; worker/init/shutdown/`__testOnly` as in W1.T2.
- [ ] **Step 1: Write the failing test:**
  - Output target: `action.kind === 'scrub'`. The rendered `set` contains `stdout = NULL`, `stderr = NULL` and `output_purged_at = now()`. The predicate contains `output_purged_at IS NULL` (idempotence) and the terminal list without `'cancelling'`.
  - Row target: the predicate contains both keep-newest clauses: `monitor_id IS NOT NULL` correlation on `(monitor_id, device_id)` ordered by `completed_at`, and the `script_id` correlation by `created_at`.
  - Batch target: `created_at <` with `AT TIME ZONE 'UTC'`.
  - Order: the targets run output → rows → batches.
  - An output window configured above the row window is clamped, with a warning.
  - Defaults 90/365, `ENFORCE === false`.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Pass.**
- [ ] **Step 5: Commit** — `feat(api): report-first script execution retention (#4342 W2)`.

### Task W2.T3: Registrations, compose, docs
Same checklist as W1.T6, for 1 worker, 3 metric names, and 5 variables: `SCRIPT_EXECUTION_OUTPUT_RETENTION_DAYS`, `SCRIPT_EXECUTION_RETENTION_DAYS`, `SCRIPT_EXECUTION_RETENTION_BATCH_SIZE`, `SCRIPT_EXECUTION_RETENTION_MAX_BATCHES` and `SCRIPT_EXECUTION_RETENTION_ENFORCE`. The output and row windows share the batch knobs. Add one `workerRegistry.scriptExecutionRetention.test.ts`.
- [ ] Steps as W1.T6. Commit `chore(api): register script execution retention (#4342 W2)`.

### Task W2.T4: Output-removed note (web)
**Files:** the device Scripts tab and script execution detail components under `apps/web/src/components/` (find them by grepping for `stdout` renders); `apps/web/src/locales/*/` (one key, all 8); their existing tests.
- [ ] **Step 1: Write the failing test** in the component's test file. Given an execution with `stdout: null, stderr: null, outputPurgedAt: '2026-01-01T00:00:00Z'`, the rendered text includes the localized "Output removed after the retention window". Given `outputPurgedAt: null` and empty output, the existing "no output" copy renders unchanged.
- [ ] **Step 2: Fail. Step 3: Implement** (API projection additions + component + locales). **Step 4: Pass**, then `npx vitest run apps/web/src/lib/__tests__/no-silent-mutations.test.ts`. The locale-parity test is whichever test enforces locale key parity; run it.
- [ ] **Step 5: Commit** — `feat(web): show when script output was removed by retention (#4342 W2)`.

### Task W2.T5: Integration
**Files:** Create `apps/api/src/__tests__/integration/scriptExecutionRetention.integration.test.ts`.
- [ ] **Step 1: Write the tests:**
  - An old completed execution has its output nulled and `output_purged_at` set, and the row stays. A second run leaves `output_purged_at` unchanged (idempotent) and reports 0.
  - An execution older than the row window is deleted, except the newest terminal one per `(monitor_id, device_id)` and the newest per `script_id`.
  - A `running` row of any age is untouched.
  - A `fix_memory` / `remediation_suggestions` row referencing a deleted execution gets `script_execution_id = NULL`.
  - Report mode deletes nothing and its counts match.
- [ ] **Step 2: Run** it against the test stack. Expected: PASS. **Step 3: Commit**, then open Part A.

### Task W2.B: Default flip (after G2 only) — as W1.B.

---

## W3 — Alerts family

**Targets** (one job file `alertRetention.ts`, two targets in order, metrics `alert_retention` and `alert_correlation_group_retention`):

| # | Table | Eligible | Default / max | Knobs |
|---|---|---|---|---|
| 1 | `alerts` (`a.` = `alerts.`) | `a.status IN ('resolved','dismissed')` AND `COALESCE(a.resolved_at, a.dismissed_at) < utcWallTime(cutoff)` AND (`a.rule_id IS NULL` OR EXISTS a newer closed alert `n` with `n.rule_id = a.rule_id AND n.device_id IS NOT DISTINCT FROM a.device_id AND COALESCE(n.subject_key,'') = COALESCE(a.subject_key,'')`) AND NOT EXISTS in `ticket_alert_links`, `psa_ticket_mappings`, `alert_external_refs` for `a.id` | 365 / 1095 | `ALERT_RETENTION_` |
| 2 | `alert_correlation_groups` | `root_alert_id IS NULL` AND NOT EXISTS `alert_correlation_members` for the group AND `last_seen_at < utcWallTime(cutoff)` | follows #1 | — |

- "Newer" for alerts means a strictly greater `COALESCE(resolved_at, dismissed_at)`, the ordering `services/alertLifecycle/cursor.ts:37-69` reads (it has no tiebreak). Rows that tie on the newest timestamp are all kept, a safe superset.
- On delete, these cascade: `alert_notifications`, `alert_correlations`, `alert_correlation_members`, `alert_external_refs` (exempted above anyway) and `ai_alert_verdicts`. These SET NULL: `remediation_suggestions`, `metric_anomalies`, `metric_anomaly_episodes`, `ai_agent_runs`, `ai_agent_fix_watches`, `fix_outcomes`.
- After the W3 FK migration, `log_correlations` and `network_change_events` also SET NULL.
- `siteOwnedAlerts.ts:75-84` nulls those two FKs by hand. That code stays; it becomes redundant but is harmless.

**Migrations:**
- `…230720`: the discovery-history DO-block pattern, for `log_correlations.alert_id` → `log_correlations_alert_id_alerts_id_fk` and `network_change_events.alert_id` → `network_change_events_alert_id_alerts_id_fk`, both ON DELETE SET NULL. Update `onDelete: 'set null'` in `db/schema/eventLogs.ts:128` and `discovery.ts:345`.
- `…230721` (`-- @no-transaction`): `alerts_closed_age_idx ON alerts ((COALESCE(resolved_at, dismissed_at))) WHERE status IN ('resolved','dismissed')`, plus the guard.

**Docs:**
- `apps/docs` alerts page: closed alerts older than `ALERT_RETENTION_DAYS` are removed, and alerts linked to a ticket or PSA ticket are kept.
- Partner API alerts docs: the feed does not report deletions (`routes/partnerApi/alerts.ts:~40`), so feed consumers keep their own history (OD 7 note).
- Release notes: long-range alert reports and list views without a date filter shorten to the window. Those readers have no age cap (`routes/reports/data.ts:378`, `services/reportGenerationService.ts:573`).

**Guard check SQL (G1):** count the closed alerts past the window that are (a) the newest per key, and (b) linked by each of the three link tables. `eligible` should equal the total past the window minus those.

### Execution split and parallelism (W3)
- Branch `feature/4342-retention/w3`. Part A `feat(api): report-only closed-alert retention (#4342 W3)`. Part B after G2. API only.
- T1 (FK migration + index, Opus) and T2 (job, Opus) can run in parallel. T2's unit tests do not need the migration; T4 does. T3 registrations + docs → Sonnet, after T2. T4 integration → Opus, last.

### Task W3.T1: FK changes + index
**Files:** Create both W3 migrations; Modify `db/schema/eventLogs.ts`, `db/schema/discovery.ts`, `db/schema/alerts.ts` (declare the index; also fix the stale migration name in the comment at `alerts.ts:212`, which cites `2027-01-16-210000` but the file is `2027-01-19-110300`).
- [ ] **Step 1: Write the failing integration test** in `apps/api/src/__tests__/integration/alertRetentionFk.integration.test.ts`. Insert an alert, a `log_correlations` row and a `network_change_events` row referencing it. `DELETE FROM alerts WHERE id = $1` succeeds, and both children read `alert_id IS NULL`. Running the migration body a second time is a no-op (the constraint name and `confdeltype = 'n'` are unchanged).
- [ ] **Step 2: Run it** before the migration exists. Expected: FAIL, 23503 foreign key violation.
- [ ] **Step 3: Write the migrations and schema changes.**
- [ ] **Step 4: Run it** plus `src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts`, then `pnpm db:check-drift`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(db): alert FKs from log correlations and change events SET NULL (#4342 W3)`.

### Task W3.T2: `alertRetention.ts`
**Interfaces — Produces:** `ALERT_RETENTION_TARGET`, `ALERT_CORRELATION_GROUP_TARGET`; `runAlertRetention(job?)`; worker/init/shutdown/`__testOnly`.
- [ ] **Step 1: Write the failing unit test:**
  - The rendered alert predicate contains `status IN ('resolved', 'dismissed')`, `COALESCE(resolved_at, dismissed_at) <`, `AT TIME ZONE 'UTC'`, `IS NOT DISTINCT FROM`, and all three link-table names in `NOT EXISTS`. It does not match `/'active'|'acknowledged'|'suppressed'/`.
  - The group predicate contains `root_alert_id IS NULL` and `alert_correlation_members`.
  - Targets run in order: alerts, then groups.
  - Defaults 365/1095, `ENFORCE === false`.
- [ ] **Step 2: Fail. Step 3: Implement.** The header explains the cursor guard (#10538) and the link exemptions (OD 7, correction 4). **Step 4: Pass.**
- [ ] **Step 5: Commit** — `feat(api): report-first closed-alert retention (#4342 W3)`.

### Task W3.T3: Registrations, compose, docs
W1.T6 checklist for 1 worker, 2 metric names and 4 variables (`ALERT_RETENTION_DAYS`, `_BATCH_SIZE`, `_MAX_BATCHES`, `_ENFORCE`), plus the two docs notes above. Commit `chore(api): register alert retention (#4342 W3)`.

### Task W3.T4: Integration guards
**Files:** Create `apps/api/src/__tests__/integration/alertRetention.integration.test.ts`.
- [ ] **Step 1: Write the tests** (enforce on, small window):
  - Three closed alerts for `(rule R, device D, no subject)`: only the newest survives, and `readClosedCursors(D, [R])` still returns its cursor afterwards.
  - Two closed alerts for `(rule R, device NULL, subject 'x')`: the older is deleted (Review Focus 3).
  - A closed alert with a `ticket_alert_links` row, one with a `psa_ticket_mappings` row, and one with an `alert_external_refs` row all survive.
  - An `active` alert of any age survives.
  - A deleted alert's `alert_notifications` and `ai_alert_verdicts` rows are gone, and its `remediation_suggestions` row has `alert_id = NULL`.
  - An orphaned correlation group past the window is deleted. A group with a member is kept.
  - Report mode deletes nothing.
- [ ] **Step 2: Run. Expected PASS. Step 3: Commit**, then open Part A.

### Task W3.B: Default flip (after G2 only) — as W1.B.

---

## W4 — AI transcripts (tech + client), one job

**Read first:** `jobs/aiToolOutputRetention.ts` in full. W4 reuses its policy loader shape, its `LIVE_SESSION_QUIET_MS` / `LIVE_SESSION_MAX_DEFER_MS` rule, its tombstone, and `deleteSdkTranscript`. `jobs/aiTranscriptSweeper.ts` already removes transcript files that no row references any more, on every API container. So W4 only clears `sdk_session_id`, and deletes the local file best effort.

**Phases per org, in order, each batched (one fresh system transaction per batch, multiple statements):**

1. **Stub technician sessions.** `type NOT IN CLIENT_SESSION_TYPES` (`services/clientAiHosts.ts:20`), window = effective `transcriptRetentionDays` (`mergeAiDataPolicies`). NULL = skip the org.
2. **Stub client sessions.** `type IN CLIENT_SESSION_TYPES`, window = `client_ai_org_policies.retention_days`. NULL = skip. No partner fallback.
3. **Hard-delete stubs.** `transcript_purged_at IS NOT NULL`, `last_activity_at < now − audit window`, `flagged_at IS NULL`, and NOT EXISTS `ai_screenshots` for the session. Audit window = `audit_retention_policies.retention_days`, else `DEFAULT_RETENTION_DAYS` (365) from `services/auditRetentionPolicyService.ts:11`. The delete cascades `ai_tool_executions`, `ai_messages`, `wisp_thread_sessions`, and (after the W4 FK change) `ai_action_plans`. SET NULL children are listed in the spec's §3.3 and verified: `ai_agent_runs`, `ai_budget_reservations`, `ai_run_artifacts`, `script_proposals`, `script_executions.ai_session_id`, `flows`, `flow_runs`, `ai_memory_blocks`, and `continued_from_session_id`.

**Stub eligibility (phases 1–2; all hold):**
- `org_id = $org`, `transcript_purged_at IS NULL`, `flagged_at IS NULL` (OD 2).
- `last_activity_at < utcWallTime(cutoff)`.
- `status IN ('closed','expired')`, OR (`status = 'active'` AND `last_activity_at < utcWallTime(cutoff − LIVE_SESSION_MAX_DEFER_MS)`) (correction 6). An abandoned active session gets the same 24 h allowance past its window that `aiToolOutputRetention.ts:289` gives a live session.
- A stub can never gain new messages: `aiAgentSdk.ts:637-651` refuses any session that is not `active`, and nothing sets a session back to `active`. So `transcript_purged_at IS NULL` never leaves fresh content unpurged.
- NOT EXISTS an `ai_messages` row for the session with `created_at >= utcWallTime(now − LIVE_SESSION_QUIET_MS)`.

**Stub batch** (`stubSessionsBatch`, inside one `inFreshSystemContext`, statements in this order):
1. `SELECT id, sdk_session_id … LIMIT n FOR UPDATE SKIP LOCKED`.
2. `DELETE FROM ai_messages WHERE session_id = ANY($ids)`; `DELETE FROM ai_action_plans WHERE session_id = ANY($ids)`.
3. `UPDATE ai_screenshots SET expires_at = LEAST(expires_at, utcWallTime(nowIso)) WHERE session_id = ANY($ids)` (correction 8; `expires_at` is tz-less).
4. `UPDATE ai_tool_executions SET tool_input = $marker, tool_output = $marker, error_message = NULL WHERE session_id = ANY($ids)`. `$marker` is `tombstone(now)` from `aiToolOutputRetention.ts`; `tool_input` is NOT NULL, so it gets the marker, never NULL.
5. `UPDATE ai_sessions SET title = NULL, system_prompt = NULL, context_snapshot = NULL, workbook_name = NULL, flag_reason = NULL, sdk_session_id = NULL, transcript_purged_at = now(), status = CASE WHEN status = 'active' THEN 'expired' ELSE status END, updated_at = now() WHERE id = ANY($ids)`.
6. Return `{ stubbed, clearedSdkSessionIds }`. After commit, call `deleteSdkTranscript` per id, as in `runAiToolOutputRetention`.

**Report mode:** count the eligible sessions per phase per org with the same predicate builders, through `countEligibleRows` (`table: 'ai_sessions'`). Log per-org counts to stdout only (org ids never go to Sentry tags). `recordRetentionRun('ai_transcript_retention', { rowsEligible: total })`. Enforce flag: `AI_TRANSCRIPT_RETENTION_ENFORCE`, default `false` (§3.4 preview release).

**Columns and FKs** (migration `…230730`, transactional, writes rows):
- `ai_data_policies.transcript_retention_days integer NULL` with `CHECK (transcript_retention_days IS NULL OR transcript_retention_days >= 1)`. Add it inside `DO $$ BEGIN IF NOT EXISTS (column) THEN ALTER …; UPDATE ai_data_policies SET transcript_retention_days = 365 WHERE org_id IS NULL AND partner_id IS NOT NULL; GET DIAGNOSTICS …; RAISE WARNING …; END IF; END $$;`, behind the system-scope `set_config` (correction 10).
- `ai_sessions.transcript_purged_at timestamptz NULL`.
- `ai_action_plans.session_id` and `ai_screenshots.session_id` → ON DELETE CASCADE (discovery DO-block pattern; canonical names `ai_action_plans_session_id_ai_sessions_id_fk`, `ai_screenshots_session_id_ai_sessions_id_fk`).
- Index `…230731` (`-- @no-transaction`): `ai_sessions_retention_scan_idx ON ai_sessions (org_id, last_activity_at) WHERE flagged_at IS NULL`, plus the guard.

**Settings (Rule 9, `docs/agents/settings.md`)**, stated in the Part A PR body:

| Concept | Home | Level | Resolver | Places before → after |
|---|---|---|---|---|
| Client-AI transcript retention | `PolicyEditor.tsx` (existing field) | Org | new `resolveClientTranscriptRetention(orgId)` in `services/clientAiPolicy.ts` | 1 → 1 (starts being enforced) |
| Technician-AI transcript retention | `PartnerAiDataPolicyCard.tsx`, `OrgAiDataPolicyCard.tsx` | Partner default → org tighten-only | `mergeAiDataPolicies` (extended) | 0 → 1 |
| AI session stub lifetime | `OrgAuditRetentionSettings.tsx` (unchanged; help text gains one line) | Org | `audit_retention_policies` | 1 → 1 |

**Previews (§3.4).** Both endpoints run on the request path under `withDbAccessContext`, with no system escape. Their counts use the same predicate builders as the job.
- `GET /ai/data-policy/transcript-retention-preview?days=N` (org card) → `{ eligible: number, enforced: boolean }`. Counts the org's eligible technician sessions at window N.
- `GET /partner/ai/data-policy/transcript-retention-preview?days=N` (partner card) → the same shape. Counts the eligible technician sessions across the partner's orgs that have no tighter org row; the UI labels it "up to".
- `GET /client-ai/admin/policy/transcript-retention-preview?days=N` (client policy editor; mount it beside the existing admin policy route, `routes/clientAi/admin.ts`) → the same shape for client sessions.
- `enforced` mirrors `AI_TRANSCRIPT_RETENTION_ENFORCE`. The cards show "N conversations are older than this window and will be removed once retention is enforced" when it is false, and "… will be removed in the next nightly run" when it is true. That second string is also what the cards show after enforcement when an admin lowers the window (§3.4).

**Viewers.**
- Client admin: `apps/web/src/components/clientAi/SessionsTab.tsx:647-651`. When `session.transcriptPurgedAt` is set, render "Transcript removed by retention on <date>" instead of `sessionsTab.noMessages`. `routes/clientAi/adminSessions.ts` adds `transcriptPurgedAt` to its list and detail projections.
- Technician: `apps/web/src/components/ai/AiChatMessages.tsx` shows the same banner when the loaded session (`stores/aiStore.ts` `loadSession`) has `transcriptPurgedAt`. `services/aiAgent.ts` `listSessions` adds `transcriptPurgedAt` to its projection. `AiConversationList.tsx` and the admin list in `settings/AiUsagePage.tsx` show a "Removed by retention" label in place of a null title.
- Mobile: out of scope. The tool card already handles the tombstone (`toolIndicatorLogic.ts:118`).

**Topology audit filter (correction 9).** Change `topologyAuditSessionCondition` (`routes/ai.ts:123-140`). An `ai_session` audit row stays visible only if `resource_id IS NULL` or `EXISTS` a **visible** session: `topology_site_id IS NULL`, or (for `kind: 'some'`) the session's site is in `visibility.siteIds`. A missing session therefore hides the row.

**Copy (both AI cards).** Each field names its scope ("Technician AI conversations" vs "Client AI conversations") and links to the other. The technician card adds: "Audit log entries about a technician session, including tool inputs, follow the audit retention window, not this one" (§3.3 "What transcript retention does not reach"). Every new key goes in all 8 locales.

**Guard check SQL (G1):** per phase, the count of flagged sessions past their window (held), and the count of `active` sessions idle past the window (will be expired). The preview endpoints give the per-org view.

### Execution split and parallelism (W4)
- Branch `feature/4342-retention/w4`. Part A `feat(ai): report-only transcript retention with previews (#4342 W4)`, the preview release. Part B `feat(ai): enforce transcript retention (#4342 W4)`, the enforcing release, after G2 and **in the next release after Part A ships**. Both release notes name the two settings and the date (§3.4).
- **API/web seam** (frozen by T1 + T2):
  - `transcriptRetentionDays: number | null` on both AI data policy GET/PUT bodies and on `EffectiveAiDataPolicy` (with `source.transcriptRetentionDays`).
  - `transcriptPurgedAt: string | null` on the session JSON (tech detail/list, client admin list/detail).
  - The three preview endpoints' `{ eligible, enforced }`.
- **PARALLEL GROUPS** after T1:
  - API, file-disjoint: {T2 resolvers + routes + previews + shared predicates, T4 topology filter}. T3 (job + its integration tests) imports T2's predicate module, so it starts when T2's `aiTranscriptRetentionPredicates.ts` is committed.
  - Web: T5 (settings cards + locales), **then** T6 (viewers). Both edit `locales/*/ai.json` in all 8 locales, so they run in sequence; parallel edits across 8 files are how a locale gets silently dropped. They start once T1 fixes the seam, and use mocked fetches until T2 lands.
  - T7 (registrations + docs) after T3.
- T1, T2, T3, T4 → Opus (tenant-visible deletion, partner-ceiling semantics, audit visibility). T5, T6, T7 → Sonnet, each handed the seam above and its copy.
- Full rigor: TDD, one review (Opus) over the branch. Before the PR, take a browser pass of both cards and both viewers on a `worktree-stack` (screenshots in the PR).

### Task W4.T1: Migration, schema, export policy, seam types
**Files:** Create both W4 migrations; Modify `db/schema/aiDataPolicies.ts`, `db/schema/ai.ts` (column, index, the two FK `onDelete: 'cascade'`), `services/tenantExportPolicyRegistry.ts` (`ai_sessions` += `transcript_purged_at`, `ai_data_policies` += `transcript_retention_days`, both `included`), `services/aiDataPolicy.ts` (`AI_DATA_POLICY_DEFAULTS.transcriptRetentionDays = 365`; `EffectiveAiDataPolicy` field + source; `mergeAiDataPolicies` handles the new field with exactly the `toolOutputRetentionDays` semantics).
- [ ] **Step 1: Write the failing unit tests** in `services/aiDataPolicy.test.ts` for `mergeAiDataPolicies` on the new field:
  - no partner row → 365 `default`
  - partner 90 → 90 `partner`
  - partner NULL → null (forever)
  - partner 90 + org 30 → 30 `org`
  - partner 90 + org 200 → 90 (an org cannot loosen)
  - partner NULL + org 60 → 60 `org`
  - The `toolOutputRetentionDays` results are unchanged by the new column.
- [ ] **Step 2: Fail. Step 3: Implement** the merge, then the migrations and schema.
- [ ] **Step 4: Verify.** Unit tests pass. `pnpm db:migrate && pnpm db:check-drift` (re-run no-op). An integration assertion in `src/__tests__/integration/aiTranscriptRetentionMigration.integration.test.ts`: a partner `ai_data_policies` row inserted before the migration reads `transcript_retention_days = 365` after it, and an org row reads NULL. Then the export-policy suites and `orgCascadeFkOnDelete.integration.test.ts`.
- [ ] **Step 5: Commit** — `feat(db): transcript retention columns, stub FKs, scan index (#4342 W4)`.

### Task W4.T2: Resolvers, policy routes, preview endpoints
**Files:** Modify `services/clientAiPolicy.ts` (`resolveClientTranscriptRetention(orgId): Promise<number | null>`), `routes/partnerAiDataPolicy.ts` (body schema `transcriptRetentionDays: z.number().int().min(1).max(3650).nullable().optional()`; insert default 365 when absent; GET returns it), `routes/ai/dataPolicy.ts` (same field; 422 `above_partner_ceiling` with `field: 'transcriptRetentionDays'`), and the three preview routes. Create `services/aiTranscriptRetentionPredicates.ts`: the predicate builders shared by the job (T3) and the previews:
```ts
export function technicianStubPredicate(orgId: string, cutoffIso: string, now: Date): SQL;
export function clientStubPredicate(orgId: string, cutoffIso: string, now: Date): SQL;
export function stubDeletePredicate(orgId: string, auditCutoffIso: string): SQL;
```
Tests: `routes/partnerAiDataPolicy.test.ts`, `routes/ai/dataPolicy.test.ts`, `routes/clientAi/admin.test.ts` (or the preview route's own test file), `services/aiTranscriptRetentionPredicates.test.ts`.
- [ ] **Step 1: Write the failing tests:**
  - **Predicates:**
    - `technicianStubPredicate` renders `NOT IN` with the four client types.
    - `clientStubPredicate` renders `IN`.
    - Both render `flagged_at IS NULL`, `transcript_purged_at IS NULL`, the `status IN ('closed', 'expired') OR (status = 'active' AND …)` clause, the live-message `NOT EXISTS`, and `AT TIME ZONE 'UTC'`.
    - `stubDeletePredicate` renders `transcript_purged_at IS NOT NULL` and `NOT EXISTS (… ai_screenshots …)`.
  - **Routes:**
    - An org PUT above the partner ceiling → 422 with the field name.
    - A partner PUT without the field on insert writes 365.
    - A PUT with `null` stores NULL.
    - GETs return the field and its source.
  - **Previews:**
    - `days=0` and `days=abc` → 400.
    - A valid call returns `{ eligible, enforced: false }` with env unset.
    - An org-scoped caller cannot preview another org (403/404 per the route's existing access pattern).
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Pass.**
- [ ] **Step 5: Commit** — `feat(ai): transcript retention settings and previews (#4342 W4)`.

### Task W4.T3: `aiTranscriptRetention.ts`
**Files:** Create `apps/api/src/jobs/aiTranscriptRetention.ts` + `.test.ts`; Create `apps/api/src/__tests__/integration/aiTranscriptRetention.integration.test.ts`; Modify `apps/api/src/services/auditRetentionPolicyService.ts` (export `DEFAULT_RETENTION_DAYS`, today a module `const` at `:11`).
**Interfaces — Produces:**
```ts
export async function loadTranscriptWindowsByOrg(): Promise<Map<string, { technicianDays: number | null; clientDays: number | null; auditDays: number }>>; // ONE system read of orgs, ai_data_policies, client_ai_org_policies, audit_retention_policies
export async function stubSessionsBatch(kind: 'technician' | 'client', orgId: string, cutoffIso: string, now: Date, batchSize: number): Promise<{ stubbed: number; clearedSdkSessionIds: string[] }>;
export async function deleteStubsBatch(orgId: string, auditCutoffIso: string, batchSize: number): Promise<number>;
export interface TranscriptRetentionSummary { mode: 'report' | 'enforce'; orgsScanned: number; orgsFailed: number; eligible: { technician: number; client: number; stubDelete: number }; stubbed: { technician: number; client: number }; stubsDeleted: number; transcripts: { deleted: number; notFound: number; failed: number }; incomplete: boolean; durationMs: number }
export async function runAiTranscriptRetention(opts: { batchSize: number; maxBatches: number; enforce: boolean; now?: Date; deleteTranscript?: TranscriptDeleter }): Promise<TranscriptRetentionSummary>;
```
A per-org failure is logged and counted, and does not stop the others. One bounded Sentry event per run, carrying counts only (the `aiToolOutputRetention` pattern).
- [ ] **Step 1: Write the failing unit test** (mocked db/predicates):
  - Report mode never calls `stubSessionsBatch` or `deleteStubsBatch`, and records `rowsEligible`.
  - Enforce mode runs phases in order: technician stub → client stub → stub delete.
  - An org with both windows NULL is skipped for phases 1–2 but still runs phase 3.
  - The transcript deleter runs only after a batch resolves, and a throwing deleter counts as `failed` without failing the org.
- [ ] **Step 2: Write the failing integration tests** (real Postgres, `breeze_app` pool, enforce on, now fixed):
  - A closed technician session past 365 d becomes a stub. Its messages and plans are gone. Its tool executions remain with both columns equal to the tombstone. `title`, `system_prompt`, `context_snapshot`, `workbook_name`, `flag_reason` and `sdk_session_id` are NULL. `transcript_purged_at` is set. `total_cost_cents`, `turn_count`, `model`, `flagged_by` and `created_at` are unchanged.
  - **A flagged session past its window is untouched.** After an unflag, the next run stubs it.
  - An `active` session idle past the window is stubbed and becomes `expired` (Review Focus 4). An `active` session with a message 1 h ago is untouched.
  - A client session with `retention_days = 30` is stubbed at 31 d. With `retention_days = NULL`, it is kept. Its `client_ai_usage` rows are untouched (assert the count is unchanged).
  - A stub past the audit window with no screenshots is deleted, and its `ai_tool_executions` are gone. A stub that still has an `ai_screenshots` row is kept, and that row's `expires_at <= now()`.
  - A second run is a no-op (idempotent).
  - Report mode leaves everything in place, and its `eligible` counts equal the enforce run's counts.
- [ ] **Step 3: Run both and see them fail. Step 4: Implement. Step 5: Run both and see them pass** (integration via `vitest.integration.config.ts`).
- [ ] **Step 6: Commit** — `feat(ai): report-first transcript retention job (#4342 W4)`.

### Task W4.T4: Topology audit filter fails closed
**Files:** Modify `apps/api/src/routes/ai.ts:123-140`; Test: the existing test that covers the topology audit filter (grep `topologyAuditSessionCondition`), plus a case in `src/__tests__/integration/` if the existing coverage is integration.
- [ ] **Step 1: Write the failing test.** For a `kind: 'none'` viewer, an `ai_session` audit row whose session does not exist is **not** returned. A row for a non-topology session is returned. A row for a topology session is not. Repeat for a `kind: 'some'` viewer with the site in and out of `siteIds`.
- [ ] **Step 2: Fail** (the missing-session case is returned today). **Step 3: Implement** the `EXISTS (visible session)` form. **Step 4: Pass. Step 5: Commit** — `fix(ai): topology audit filter fails closed on a missing session (#4342 W4)`.

### Task W4.T5: Settings cards + previews (web)
**Files:** `apps/web/src/components/settings/OrgAiDataPolicyCard.tsx` (+ test), `PartnerAiDataPolicyCard.tsx` (+ test), `settings/partnerSettings/units/aiDataPolicyUnit.ts` (+ `saveUnits.test.ts`, `partnerSettingsDraftStore.test.ts`), `components/clientAi/PolicyEditor.tsx` (+ test), `apps/web/src/locales/*/settings.json` and `*/ai.json` (all 8).
- [ ] **Step 1: Write the failing tests:**
  - The org card renders a transcript field (`data-testid="org-ai-data-policy-transcript-retention"`) beside the tool-output field. Saving sends `transcriptRetentionDays`. A 422 `above_partner_ceiling` with that field shows the ceiling message on the right field.
  - The partner card renders a days/keep-forever radio group (`partner-ai-data-policy-transcript-days-mode`), and the draft unit patches the field.
  - All three editors fetch the preview on a debounced change and render the `enforced: false` copy, then the `enforced: true` copy.
  - Saving goes through `runAction`.
- [ ] **Step 2: Fail. Step 3: Implement** (the copy is in the W4 Copy paragraph). **Step 4: Pass**, plus the locale-parity test and `no-silent-mutations.test.ts`.
- [ ] **Step 5: Commit** — `feat(web): technician transcript retention field and retention previews (#4342 W4)`.

### Task W4.T6: Viewers (web)
**Files:** `apps/web/src/components/clientAi/SessionsTab.tsx`, `components/ai/AiChatMessages.tsx`, `components/ai/AiConversationList.tsx`, `components/settings/AiUsagePage.tsx`, their tests, and locales (all 8). API projections: `routes/clientAi/adminSessions.ts`, `services/aiAgent.ts` (`listSessions`).
- [ ] **Step 1: Write the failing tests.** With `transcriptPurgedAt` set, each viewer renders the localized "Transcript removed by retention on <date>" (detail) or "Removed by retention" (list). With it null, rendering is unchanged.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Pass. Step 5: Commit** — `feat(web): show transcripts removed by retention (#4342 W4)`.

### Task W4.T7: Registrations, compose, docs
W1.T6 checklist for 1 worker (`aiTranscriptRetention`, slot `ai-transcript-retention`, metric `ai_transcript_retention`) and 3 variables (`AI_TRANSCRIPT_RETENTION_BATCH_SIZE`, `_MAX_BATCHES`, `_ENFORCE`). The windows are tenant settings, not env. Docs:
- `apps/docs` AI data policy page: the technician field, the stub, and the audit carve-out.
- Client AI admin page: the client field is now enforced, and NULL keeps forever.
- `environment.mdx` rows.

Commit `chore(ai): register transcript retention (#4342 W4)`, then open Part A, with the Rule 9 table and both release-notes texts (Part A: preview; Part B: enforcement date) in the body.

### Task W4.B: Enforcing release (after G2, next release only)
- [ ] Flip `AI_TRANSCRIPT_RETENTION_ENFORCE`'s default to `true`, update the job's unit test, the `environment.mdx` row and the preview copy expectations. The release notes say client transcript retention is now enforced for orgs that set it, and that technician transcripts follow the 365-day default unless a partner changed it. **Todd's go only.**

---

## W5 — Tier 3 history + `network_change_events`

**One worker** (`jobs/historyRetention/index.ts`, slot `history-retention`), running every target sequentially through `runRetentionTargets`. A target that throws does not stop the others.
- Targets live in per-domain files under `jobs/historyRetention/`, so they can be written in parallel.
- **Each target has its own `_DAYS` and `_ENFORCE`**, so Gate G1 can approve table by table.
- Shared knobs: `HISTORY_RETENTION_BATCH_SIZE` (1000) and `HISTORY_RETENTION_MAX_BATCHES` (100).
- Each target's metric name is its row's first column, added to `RETENTION_JOB_NAMES`.

| Metric / file | Table (shorthand for the bare name) | Eligible (all hold) | Default / max | Knob prefix |
|---|---|---|---|---|
| `ai_agent_run_retention` / `aiAgentRuns.ts` | `ai_agent_runs` (r) | `status IN ('completed','failed','cancelled','expired','skipped','blocked')` AND `finished_at < cutoff::timestamptz` AND NOT EXISTS `action_intents` on `(requesting_agent_run_id, org_id)` AND NOT EXISTS `ticket_drafts` on its run FK columns (`ticketDrafts.ts:89-91`) AND NOT EXISTS `ai_run_artifacts` / `ai_run_workspaces` for the run (correction 12) | 400 / 1095 | `AI_AGENT_RUN_RETENTION_` |
| `patch_job_result_retention` / `patchAndPosture.ts` | `patch_job_results` (p) | `p.status IN ('completed','failed','skipped')` AND `p.created_at < utcWallTime` AND parent `patch_jobs.status IN ('completed','failed','cancelled')` AND NOT (`reboot_required` AND EXISTS `devices d` with `d.id = p.device_id AND d.pending_reboot`) AND EXISTS a newer row `n` with `n.device_id = p.device_id AND n.patch_id IS NOT DISTINCT FROM p.patch_id` (correction 13) | 365 / 1095 | `PATCH_JOB_RESULT_RETENTION_` |
| `security_posture_snapshot_retention` / `patchAndPosture.ts` | `security_posture_snapshots` | `captured_at < utcWallTime` AND EXISTS a newer row for the same `device_id` | 365 / 1095 | `SECURITY_POSTURE_SNAPSHOT_RETENTION_` |
| `cis_baseline_result_retention` / `patchAndPosture.ts` | `cis_baseline_results` | `checked_at < utcWallTime` AND EXISTS a newer row for the same `(org_id, device_id, baseline_id)` | 365 / 1095 | `CIS_BASELINE_RESULT_RETENTION_` |
| `automation_run_retention` / `runHistory.ts` | `automation_runs` | `status IN ('completed','failed','partial','cancelled')` AND `completed_at < utcWallTime` | 180 / 1095 | `AUTOMATION_RUN_RETENTION_` |
| `report_run_retention` / `runHistory.ts` | `report_runs` (rr) | `status IN ('completed','failed')` AND `COALESCE(completed_at, created_at) < utcWallTime` AND NOT EXISTS `service_deliverable_evidence` on `(report_run_id, report_id)` AND NOT EXISTS `fleet_design_applied_items.report_run_id` AND EXISTS a newer run for the same `report_id` | 365 / 1095 | `REPORT_RUN_RETENTION_` |
| `user_notification_read_retention` / `accessHistory.ts` | `user_notifications` | `read = true` AND `read_at < utcWallTime` | 90 / 365 | `USER_NOTIFICATION_READ_RETENTION_` |
| `user_notification_retention` / `accessHistory.ts` | `user_notifications` | `created_at < utcWallTime` AND NOT (`type = 'approval'` AND `read = false`) | 365 / 1095 | `USER_NOTIFICATION_RETENTION_` |
| `remote_session_retention` / `accessHistory.ts` | `remote_sessions` | `status IN ('disconnected','failed','denied')` AND `COALESCE(ended_at, created_at) < utcWallTime` | 365 / 1095 | `REMOTE_SESSION_RETENTION_` |
| `support_session_retention` / `accessHistory.ts` | `support_sessions` | `status IN ('ended','expired')` AND `COALESCE(ended_at, created_at) < cutoff::timestamptz` | 365 / 1095 | `SUPPORT_SESSION_RETENTION_` |
| `auth_session_retention` / `accessHistory.ts` | `sessions` | `created_at < utcWallTime(cutoff)` AND `expires_at < utcWallTime(nowIso)` (correction 17) | 30 / 365, **floor 30** | `AUTH_SESSION_RETENTION_` |
| `network_change_event_retention` / `networkChangeEvents.ts` | `network_change_events` (e) | `e.detected_at < (nowIso::timestamptz AT TIME ZONE 'UTC') - make_interval(days => <per-row days>)`. Per-row days = the profile's `alert_settings->>'changeRetentionDays'` when it matches `'^[0-9]{1,3}$'`, clamped 1..365; otherwise the env default. It also applies when `profile_id IS NULL` or the profile has alerts disabled. | 90 / 365 | `NETWORK_CHANGE_EVENT_RETENTION_` |

- **Cascades on delete, verified:**
  - `ai_agent_runs` → `ai_agent_fix_watches`, `ai_unattended_exposure`, `ai_alert_verdicts` (CASCADE); op evidence, operator tasks and ops, ticket comments, remediation suggestions, device function assessments (SET NULL).
  - `automation_runs` → `automation_run_device_results`, `automation_action_results`.
  - `report_runs` → `report_run_deliveries` (CASCADE); `ai_agent_runs.report_run_id`, `device_function_assessments.report_run_id` (SET NULL). Report output is `result` jsonb plus an API path, with no blob (`artifact_id` is SET NULL, and the artifact keeps its own TTL).
  - `support_sessions` → `enrollment_keys.support_session_id` (CASCADE). The quick-support reaper purges the device 6 h after the session ends, long before 365 d.
  - `user_notifications` → `wisp_thread_posts.notification_id` (SET NULL).
- **Sessions:** the auth `sessions` table is still written by SSO login (`services/session.ts:36`). `validateSession` has no caller. The one reader is `userRiskScoring`'s 30-day window (`services/userRiskScoring.ts:655-665`), so the floor is 30 days from creation. The floor is named `USER_RISK_SESSION_LOOKBACK_DAYS` and exported from `userRiskScoring.ts`, and the target imports it.
- **Remote sessions:** `recording_url` is a link the user typed in, not a stored file (correction 18). It goes with the row.

**W5 migration** `…230740-history-retention-indexes.sql` (`-- @no-transaction`). Each index is declared in its Drizzle schema:
- `ai_agent_runs_finished_idx ON ai_agent_runs (finished_at) WHERE finished_at IS NOT NULL`
- `patch_job_results_created_idx ON patch_job_results (created_at)`
- `automation_runs_terminal_completed_idx ON automation_runs (completed_at) WHERE status IN ('completed','failed','partial','cancelled')`
- `report_runs_terminal_age_idx ON report_runs ((COALESCE(completed_at, created_at))) WHERE status IN ('completed','failed')`
- `user_notifications_read_at_idx ON user_notifications (read_at) WHERE read = true`
- `remote_sessions_terminal_age_idx ON remote_sessions ((COALESCE(ended_at, created_at))) WHERE status IN ('disconnected','failed','denied')`
- `sessions_created_at_idx ON sessions (created_at)`

Existing indexes already serve the other predicates: posture `(device_id, captured_at)`, CIS `(org_id, device_id, checked_at)`, change events `detected_at`, patch results `(device_id, patch_id, created_at)`. `support_sessions` is small.

**Guard check SQL (G1).** For each target, count the rows past the window that each guard retains:
- agent runs blocked by intents, by drafts, and by artifacts/workspaces;
- the newest patch result per `(device, patch)`;
- reboot-pending results;
- the newest posture snapshot per device;
- the newest run per report;
- evidence-backed report runs;
- unread approvals.

**Release notes.**
- Automation and report run lists and totals shorten to their windows (`routes/automations.ts:1210-1225` counts every run).
- Change-event history now honours the profile setting, also for profiles with alerts disabled.
- A remote session's recording link is removed with the session after 365 days.

### Execution split and parallelism (W5)
- Branch `feature/4342-retention/w5`. Part A `feat(api): report-only retention for run and access history (#4342 W5)`. Part B after G2; it may flip only the targets Todd approved. API only.
- T1 (migration + schema indexes) → Opus. **PARALLEL GROUP A** after T1, file-disjoint, each with its own test file:
  - T2 `aiAgentRuns.ts` → Opus (four exclusion guards).
  - T3 `patchAndPosture.ts` → Sonnet.
  - T4 `runHistory.ts` → Sonnet.
  - T5 `accessHistory.ts` → Sonnet.
  - T6 `networkChangeEvents.ts` + dead-code removal → Opus (per-row window, tolerant parse).
- T7 (`index.ts` worker + registrations + compose + docs) → Sonnet, after group A. T8 integration → Opus, last.

### Task W5.T1: Indexes
**Files:** Create `apps/api/migrations/2027-01-22-230740-history-retention-indexes.sql`; Modify the Drizzle schema files for the seven tables (`aiAgents.ts`, `patches.ts`, `automations.ts`, `reports.ts`, `notifications.ts`, `remote.ts`, `users.ts`).
- [ ] Steps as W1.T1. Commit `feat(db): retention indexes for run and access history (#4342 W5)`.

### Tasks W5.T2–T6: Target modules (PARALLEL GROUP A)
**Files (one task each):** Create `apps/api/src/jobs/historyRetention/{aiAgentRuns,patchAndPosture,runHistory,accessHistory,networkChangeEvents}.ts`, each with a `.test.ts`. T5 also modifies `apps/api/src/services/userRiskScoring.ts`, to export `USER_RISK_SESSION_LOOKBACK_DAYS = 30` and use it in its own `since30d`. T6 also modifies `apps/api/src/jobs/networkBaselineWorker.ts`, removing the dead prune type, case and handler, and its test if one asserts the case.

**Interfaces — Produces** (each module):
```ts
export const <NAME>_TARGETS: ReadonlyArray<{ target: RetentionTarget; knobs: RetentionKnobs }>;  // knobs read from literal env names at module load; enforce default false
```
- [ ] **Step 1: Write the failing test** per module. For each target in the module, render `target.where(cutoffIso, nowIso)` with `PgDialect` and assert every clause in that target's table row:
  - the exact status list, and no non-terminal value;
  - each `NOT EXISTS` / `EXISTS` guard by table name and its correlation columns;
  - `AT TIME ZONE 'UTC'` on tz-less columns, `::timestamptz` on `ai_agent_runs.finished_at` and `support_sessions.ended_at`;
  - defaults and max, and `knobs.enforce === false`.
  - T6 additionally: the rendered SQL contains the `'^[0-9]{1,3}$'` guard and `make_interval`, and has no `alert_settings->>'enabled'` filter. `networkBaselineWorker` no longer exports or handles `prune-change-events`.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Pass.**
- [ ] **Step 5: Commit** each — `feat(api): report-first <domain> retention targets (#4342 W5)`.

### Task W5.T7: Worker, registrations, compose, docs
**Files:** Create `apps/api/src/jobs/historyRetention/index.ts`:
- `runHistoryRetention(job?: { batchSize?: number; maxBatches?: number; forceReport?: boolean })`, which concatenates the five `*_TARGETS` arrays and calls `runRetentionTargets`. `forceReport` can only turn enforcement off.
- `createHistoryRetentionWorker`, `initializeHistoryRetention`, `shutdownHistoryRetention`.

Also, per the W1.T6 checklist: 1 slot, 1 registry entry (`historyRetention`), 1 readiness consumer, 12 metric names, and 26 env names (12 × `_DAYS` + 12 × `_ENFORCE` + 2 shared) in `internalEnvVars.ts`, both compose files and `environment.mdx`, plus `upgrades.mdx`. Plus `workerRegistry.historyRetention.test.ts` and `jobs/historyRetention/index.test.ts`. The index test checks: all 12 targets are present, each with a distinct metric name; their order is fixed; and `forceReport` overrides every target's `enforce`.
- [ ] Steps as W1.T6. Commit `chore(api): register history retention (#4342 W5)`.

### Task W5.T8: Integration guards
**Files:** Create `apps/api/src/__tests__/integration/historyRetention.integration.test.ts`.
- [ ] **Step 1: Write the tests** (enforce on per target via `vi.stubEnv`, small windows):
  - **`ai_agent_runs`:**
    - A run referenced by an `action_intents` row survives. So does one referenced by a `ticket_drafts` row, and one with an `ai_run_artifacts` row.
    - An unreferenced old `completed` run is deleted, and its `ai_alert_verdicts` go with it.
    - An old `running` run survives.
  - **`patch_job_results`:**
    - Only the newest per `(device, patch)` survives, including for `patch_id IS NULL` summary rows (the older NULL row is deleted).
    - An old `reboot_required` row of a device with `pending_reboot = true` survives. `loadOldestRebootRequiredSince` returns the same date before and after. The same row on a device with no pending reboot is deleted.
    - A row under a `running` job survives.
  - **Posture and CIS:** the newest per key survives a long silence.
  - **`report_runs`:**
    - A run under `service_deliverable_evidence` survives.
    - So does the newest run of a dormant report.
    - Its `report_run_deliveries` go with a deleted run.
  - **Notifications:** an unread `approval` older than 365 d survives; a read one at 91 d is deleted.
  - **Auth sessions:** a row created 20 d ago, already expired, survives the 30-day floor. A row created 31 d ago is deleted.
  - **`network_change_events`:**
    - An event under a profile with `changeRetentionDays: 30` is deleted at 31 d.
    - An event with `profile_id IS NULL` at 91 d is deleted.
    - A profile with `changeRetentionDays: "abc"` falls back to 90 and does not throw.
  - **Report mode:** the same seed with every `_ENFORCE` unset deletes nothing, and the counts match.
- [ ] **Step 2: Run. Expected PASS. Step 3: Commit**, then open Part A.

### Task W5.B: Default flip (after G2 only)
- [ ] Flip the `_ENFORCE` default to `true` **only for the targets Todd approved at G2**. Document the rest as still report-only. Same release-notes shape as W1.B.

---

## W6 — Follow-ups (each its own small PR; none in the retention jobs)

- **W6.a — Drop `patch_compliance_snapshots`** (OD 9). Migration `DROP TABLE IF EXISTS` (slot after the newest at implementation time). De-register it from `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`, `CORE_TENANT_EXPORT_POLICY` and the schema index, and fix the `narrativeContext.ts:1058` comment. Grep, don't judge: `rg -n "patch_compliance_snapshots|patchComplianceSnapshots" apps packages`. Run the cascade, merge and export integration suites.
- **W6.b — `pg_repack` runbook** (OD 9). Add `docs/deploy/` (public, generic) operator steps for reclaiming `device_commands` and `device_filesystem_snapshots` disk after the first drain: prerequisites, `pg_repack --table`, the lock caveats, and a `VACUUM FULL` fallback in a maintenance window. Production execution is an operator task for Todd; it is not in code.
- **W6.c — Second-pass inventory** (spec §5). Plan-time grep, verified: none of these has an age-based prune. Each becomes a `jobs/historyRetention/` target (Part A/B like W5) or a follow-up issue under #4342.
  - **Add as expiry targets** (abandoned rows are never aged out): `sso_sessions` (`expires_at`, one row per SSO start), `c2c_consent_sessions` (`expires_at`).
  - **Add as history targets after reading their writers' status sets:** `audit_baseline_results` (a row per device × baseline evaluation; the likely heaviest), `deployment_results` (per device × deployment), `peripheral_policy_delivery_events`, `unifi_sync_runs` (every 30 min), `tunnel_sessions`, `fleet_remediation_runs`, `ticket_import_runs`, `topology_diagnostic_runs`, `ml_feedback_events`.
  - **Low volume, file and park:** `agent_rollback_events`, `recovery_key_access_events`, `ai_budget_alert_events`.
  - **No writer, drop candidate (like W6.a):** `mobile_sessions`.
  - **`action_intents` retention:** this is the root of correction 12. Intents are never deleted, so every agent run an intent points at is kept forever. File a follow-up. It needs its own design, because intents are audit-grade and carry a content-update trigger.

---

## Open Decisions for Todd

The spec's ten ODs are settled on their recommendations. These are new, raised by the plan:

1. **Report-first for operational waves too?** The dispatch brief requires a dry run and a Todd gate before any production deletion, which overrides the spec's "W1–W3/W5 enforce on deploy". The plan ships every job report-only, with a per-job `_ENFORCE` env and a later default-flip PR. **Recommend as planned.** Cost: one extra small PR per wave, and self-hosters stay unbounded until Part B ships.
2. **Partner rows backfilled to 365 for technician transcripts** (correction 10). Otherwise every partner who ever saved the tool-output setting silently gets "keep forever" for transcripts, while partners without a row get 365. **Recommend backfill.** W4 ships report-only, so partners see the preview count before anything is deleted.
3. **Abandoned `active` AI sessions are eligible** (correction 6). **Recommend yes.** The alternative leaves them unbounded and makes the client "Transcript retention" promise false for them.
4. **`script_executions.output_purged_at` column** rather than a sentinel string in `stdout`. **Recommend the column.** It gives an idempotent predicate, a truthful UI line and a clean export classification.
5. **Agent runs referenced by `action_intents` are kept indefinitely** (correction 12). Intents never age out today, so W5 can only prune runs no intent points at. **Recommend accepting that for W5** and filing `action_intents` retention as a separate follow-up (W6.c). Alternatives: (a) change the FK to SET NULL, which weakens the intent's provenance; (b) design intent retention first, which blocks W5.
6. **Per-target `_ENFORCE` in W5** (12 flags) rather than one flag for the whole job. **Recommend per-target.** Gate G1 can then approve, say, notifications and auth sessions on day one while agent runs stay in report mode. Cost: 12 more env vars to document.
