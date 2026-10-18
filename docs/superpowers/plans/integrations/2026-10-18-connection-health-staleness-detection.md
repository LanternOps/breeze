---
tracking_issue: LanternOps/breeze#9127
parent_feature: LanternOps/breeze#8844 (W4 #8848, shipped as #9045)
---

# Connection Health — Staleness Detection for the D3-Deferred Kinds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** EDR, accounting, DNS filtering, Microsoft 365 tenant sync, ticket mailboxes and the TD SYNNEX SFTP price feed open a **Sync stalled** incident when they stop syncing without recording a failure. This is the W4 `sync_stale` condition, extended to the kinds W4 decision D3 deferred.

**Architecture:**
- No new job, table or column.
- Each existing row source gains a stale arm, `OR`ed onto the broken query it already runs inside the existing reconciler tick. This is the W4 pattern (`staleArm` in `sources/observeRows.ts`).
- The two org-axis sources (`dns_filter`, `m365_sync`) use a stale-at **expression index**, so the arm never reads the healthy set (spec §1.3). Those indexes are one migration.
- `td_synnex_sftp` becomes a new partner-axis kind. It is the only TD SYNNEX feed with a schedule. The other two stay exempt (D6).

**Tech Stack:** Hono, Drizzle (queries only), hand-written SQL migration, Vitest (unit + `vitest.integration.config.ts`).

**Spec:** `docs/superpowers/specs/integrations/2026-10-15-connection-health-notifications-design.md` (§1.2, §1.3, §3 and its W4 amendments). Prior plans: `2026-10-15-connection-health-w4-signals-nudges.md` (D1–D3 are the contract this plan extends), `…-w1-core-oauth.md`, `…-w2-sources-panel.md`, `2026-10-15-connection-health-notifications.md`.

**Out of scope:**
- #9126 (Google Workspace 24 h escalation). Only the seam is recorded below.
- #9128 (`webhook_deliveries` retention, PR #9193). Do not touch `jobs/webhookDeliveryRetention.ts`, `jobs/scheduleRegistry.ts`, `jobs/workerReadinessManifest.ts`, `services/workerRegistry.ts` or `system/connections/internalEnvVars.ts`.
- #9129 (authorization-code replay detection).

## Global Constraints

- **No new table, no new column.**
  - Nothing reaches `CORE_TENANT_EXPORT_POLICY`, `CORE_ORG_CASCADE_DELETE_ORDER` or `orgMergeRegistry.ts`.
  - If a task finds it needs a column, stop and re-plan. A column on an org-cascade table needs an export-policy classification (timestamps → `included`, json/jsonb → `excludedOpen`), and both suites need a live DB.
- **One migration (PR B):** `apps/api/migrations/2026-12-31-233000-connection-health-stale-indexes.sql`.
  - At rebase, re-check that it still sorts after the newest committed migration (today `2026-12-31-170000-m365-consent-sessions-v2-only.sql`). Check with `ls apps/api/migrations/*.sql | sort | tail -1`; a bare `ls` ends in `optional/`, `preflight/` and `README.md`.
  - If `scripts/check-migration-naming.sh` rejects the slot, take the next free `HHMMSS`.
  - Shape: `-- @no-transaction` first line, `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, and the INVALID-index `DO` guard copied from `2026-12-30-120100-connection-health-w4-indexes.sql`.
  - No row writes, so no `set_config('breeze.scope', …)`.
  - Idempotent, no `BEGIN`/`COMMIT`.
- **Index-matched SQL.** A stale-at expression must compile to exactly the expression in the migration. Constants go in as literals (`sql.raw`), never bind parameters, or the planner cannot match the index (the W2 rule).
- **Threshold rule (spec §3, W4 D2):** `max(3 × sync interval, 60 min)` since the last successful sync, or since `created_at` when the row never succeeded. Use `staleAfterMinutes()` in `services/integrationStates.ts`, or its SQL mirror.
- **Precedence (W4 D2):** retired → permanent breaks → `sync_failed` and the kind's existing transient codes → `sync_stale` → healthy → unknown.
- **Condition:** reuse `sync_stale` (transient), and `sync_failed` for the new kind. No new condition codes, so no new `KNOWN_CONDITIONS`, `DIGEST_CONDITION_LABELS` or locale keys. All 8 locale folders already carry `connectionHealthPanel.condition.sync_stale`.
- **Detail:**
  - A stale observation reports `detail: null`, because the last error may be old.
  - Two exceptions: accounting reports its current reconcile error, a `RECONCILE_RUN_ERROR_PREFIX` message with counts only (Task 2), and `m365_sync` reports the stalled domain names (a fixed enum).
  - Every detail goes through `sanitizeHealthDetail`.
- **No other wire changes:**
  - no agent wire change, so no `MIN_AGENT_VERSION_*`;
  - no new env var (`internalEnvVars.ts` untouched);
  - no route (`mcp-coverage` untouched);
  - no job (`workerReadinessCoverage.test.ts`, `workerEntrypointClosure.contract.test.ts` and `parkedFanout.contract.test.ts` do not fire);
  - no mutation UI (`no-silent-mutations` does not fire).
- Public repo: no customer, host or infrastructure names.

## Decisions

Quorum: my position plus `codex exec` (read-only, xhigh). The outcome is recorded under **Quorum** at the end.

| # | Decision | Why |
|---|---|---|
| D1 | **Last success per kind.** Columns and gates are in the Sources table below; no new column anywhere. **edr:** each stream's `last_*_sync_at` is stamped only in its success transaction, `success` or `partial` (`jobs/edrProviderSync.ts`, the inventory and detections success writes). Stale = either stream. **accounting:** `last_reconcile_at` is stamped only after a CDC run in which no item failed, or by the pull-off freeze branch (`stampReconcileRunAt` / `advanceReconcileCursor`, `services/accounting/accountingConnectionService.ts`). `last_sync_at` is never written by non-test code and is unusable. A provider with a **daily call budget** (Xero today, `limits.rate.dailyPerConnection`) intentionally skips background reconcile while under 20% of budget (`shouldDeferBackgroundWork`, `jobs/accountingReconcileWorker.ts` sweep pass 1). The budget window is one fixed 24 h key (`services/accounting/accountingRateLimit.ts`, `DAY_MS`), so the longest legitimate pause is 24 h plus a sweep: **threshold 1500 min for daily-budget providers, 60 min otherwise.** **dns_filter:** `last_sync` advances only with `last_sync_status = 'success'` (`jobs/dnsSyncJob.ts`); the error path writes status and error only. It is a successful *slice checkpoint* (window end), so a slow catch-up after an outage also reads stale until it is within the threshold: data lag, which is a true "sync stalled". **m365_sync:** per domain `last_success_at`, stamped for `success`/`partial` only (`services/m365Sync/run.ts`). **ticket_mailbox:** `last_polled_at` is written whenever a poll persists a cursor: the M365 delta/resume link, or a truthy Gmail history id, even an unchanged one (`jobs/ticketMailboxPollWorker.ts`). An idle inbox therefore stays fresh, and transient failures leave it behind. **td_synnex_sftp:** `last_sync_at` is stamped on success *and* failure (`services/tdSynnexSftpSync.ts`), which is the Pax8 shape W4 shipped: the arm reads "no attempt finished", and a finished failure is already `sync_failed`. | Every kind has a success-only stamp (or the Pax8 attempt semantics), so a derived "latest successful run" read is never needed. None of these kinds has a `*_sync_runs` table. |
| D2 | **Thresholds are constants in each source; no setting.** The interval feeding `3 ×` is the row's own where the operator can set one: DNS `config.syncInterval`, EDR `effective_*_interval_minutes` (already derived from the operator's override and the vendor budget), M365 `interval_seconds` (adaptive). Elsewhere it is the scheduler's fixed cadence: accounting reconcile sweep 15 min, mailbox sweep 90 s, SFTP nightly. `connectionHealthSettings.ts` is untouched. | A threshold setting would be a second knob for the same concept: the operator already tunes the interval itself. Settings rule 9: places this is configured, before = 0, after = 0. |
| D3 | **State machine reuse.** `sync_stale` stays transient, one incident per connection, opened on the second consecutive observation (§1.2), with the reopen window, 2-healthy recovery and onboarding grace (`applyGrace`, 2 h) all unchanged. `applyGrace` makes **any** transient break on a connection younger than 2 h `unknown`. The arm counts from `created_at` when the stamp is NULL, so a never-synced row opens only after `max(threshold, 2 h)` plus one more observation. Rows that are not yet live are never read: each arm is gated on the kind's live status (`connected`, `enabled`, `next_sync_at IS NOT NULL`). That excludes accounting `pending_tenant`, mailbox `pending_consent` and unscheduled M365 domains. No nudge: staleness has no write point. | Spec [R]: one incident per connection. The pending exclusions match the shipped UniFi arm (`status = 'connected' AND stale`). |
| D4 | **Evaluation path.** The stale arm is an `OR` on each source's existing broken query, inside the existing 15-minute reconciler, at the source's existing `intervalMinutes`. No new job, so no `WORKER_REGISTRY` or worker-readiness entry and no schedule slot. | W4 D1. Zero extra queries; the cadence follows the signal (§1.3). |
| D5 | **Org-axis indexes are expression indexes on the stale-at instant, not a new column.** `dns_filter_integrations` and `m365_sync_state` are on `PER_ORG_TABLES`, and their per-row interval defeats a plain range index. Verified on Postgres 16 before planning: (a) `timestamp + make_interval(…)` over the DNS clamp `CASE` is accepted as immutable; (b) `timestamptz + interval` is **rejected** (not immutable), so the M365 expression converts with `AT TIME ZONE 'UTC'` first, which is accepted; (c) with `enable_seqscan = off`, an OR-of-ANDs predicate `(is_active AND last_sync_status = 'error') OR (is_active AND stale_at < $now)` plans as `BitmapOr` with an `Index Cond` on the stale index, whereas the AND-of-OR shape `is_active AND (… OR …)` used the stale index only as an `is_active` filter, reading every active row. The index contract therefore also asserts `Index Cond` on the stale index. Today it fails only on `Seq Scan`. **One definition:** each stale-at expression is built by a function exported from its table's schema file (`dnsFilterStaleAt(t)` in `db/schema/dnsSecurity.ts`, `m365SyncStaleAt(t)` in `db/schema/m365Sync.ts`). The schema's index declaration (`index(…).on(<builder>(table)).where(…)`, as `yara.ts` does with `.on(sql…)`) and the source both call it. The migration writes the same text, and the EXPLAIN contract proves the match. The existing `staleArm` (`COALESCE(…) < now − interval`) cannot match an expression index, so the org sources use a new `staleAtBefore(staleAt, now)` instead. | A column (`sync_interval_minutes`, or a writer-maintained `stale_after_at`) would need export-policy work and a writer at every sync path, and could drift from the scheduler. The expression is derived from the columns the scheduler itself reads. |
| D6 | **TD SYNNEX.** EC Express has no sync columns and no schedule (`last_test_*` only, from a manual test). Digital Bridge has no schedule: `last_sync_at` moves only after a user-initiated search (`services/tdSynnexDigitalBridge.ts`). Both **stay exempt and are dropped from scope**; their existing `SOURCE_COVERAGE_EXEMPTIONS` reasons already say so. **SFTP** runs nightly (`jobs/scheduleRegistry.ts` `'tdsynnex-sftp-sync': '38 5 * * *'`, `enabled = true` rows) and becomes a **new kind `td_synnex_sftp`** with `sync_failed` + `sync_stale`. That replaces its exemption. Its own PR (C). | A stale arm needs a failure arm beside it (precedence). SFTP has no source today, so the new kind is the smallest correct unit. As a new kind, the first observe seeds incidents silently (§1.2). |
| D7 | **M365 flag lifecycle.**<br>(a) The stale arm is compiled only when `isM365TenantSyncEnabled()` is true (`config/env.ts`, default off; read per `observe()`, not at module load).<br>(b) **Flag off → every `m365_sync` observation is `retired`.** A tracked incident closes with no "restored" notice instead of resolving from old success timestamps, and none opens. A connection's consent state stays covered by `m365_connection`.<br>(c) Domain staleness also requires the parent connection's `tenant_id IS NOT NULL`, mirroring the claim's eligibility (`services/m365Sync/claim.ts`). The parent-not-`active` → unknown rule is kept.<br>(d) **Re-enable backlog: accepted, not warmed up.** Rows are seeded only while the flag is on (`onConnectionConsented` and `reconcileEligibleConnections` both return early when it is off), so the first enable has no backlog. A re-enable keeps old `last_success_at` values, and re-armed domains are due at once. A domain still unsynced at the second hourly observation opens `sync_stale`. Operators re-enabling on a large fleet count first (D9). | With the flag off no domain ever syncs. Without (a) every M365 org would go stale; without (b) turning the flag off would announce false recoveries. A warm-up (a Redis "enabled since" key written by the ticker and read by the reconciler) was rejected: it adds a cross-module contract for a rare, deliberate operator action, and a missing key would silently disable detection. |
| D8 | **Copy and fix links.** No new copy: `sync_stale` → "Sync stalled" already exists in the panel, digest and 8 locales (W4 Task 8). Fix links are each source's existing `FIX_HREF`. The new kind uses `/integrations#tdsynnex-sftp`: `IntegrationsPage.tsx` routes distributor sub-tab hashes, and `fixLinks.contract.test.ts` checks the quoted id. Its display name is `TD SYNNEX price file`, an API string like the other display names. `apps/docs/src/content/docs/features/notifications.mdx` "Stalled syncs" lists the new kinds. | W4 D1–D2; the conditions contract already enforces labels. |
| D9 | **Deploy backlog.** The five existing kinds are already seeded, so any connection that is stale **today** opens an incident *with* a notice on the first two observations after deploy (first-run silence is only for new kinds). This is accepted: each one is a connection that really stopped syncing. Each PR body carries a read-only query that counts the **distinct connections** matching its new arm, split by whether an open incident already tracks them (those only change condition). Todd runs it per region before the deploy that includes the PR. `td_synnex_sftp` seeds silently. | Re-seeding existing kinds would also swallow genuine `sync_failed` breaks that land in the same window. |

## Sources (this plan)

| Kind | Axis | Last-success read | Stale arm (gated) | Threshold | Index |
|---|---|---|---|---|---|
| `edr` | partner | `last_inventory_sync_at`, `last_detection_sync_at` (timestamptz) | `is_active AND status = 'connected' AND (inv stale OR det stale)` | per stream `GREATEST(3 * COALESCE(effective_<stream>_interval_minutes, 60), 60)` min | none (partner axis) |
| `accounting` | partner | `last_reconcile_at` (timestamptz) | `status = 'connected' AND (pull_payments OR push_payments) AND provider IN (<paymentPull providers>)` | 60 min (15-min sweep); 1500 min for daily-budget providers (`xero`) | none |
| `ticket_mailbox` | partner | `last_polled_at` (timestamptz) | `status = 'connected'` | 60 min (90 s sweep) | none |
| `dns_filter` | **org** | `last_sync` (timestamp) | `is_active` | `GREATEST(3 * clamp(config.syncInterval, 5..1440; absent → 15; unparseable → 1440), 60)` min | `dns_filter_integrations_stale_idx` (expression, `WHERE is_active`) |
| `m365_sync` | **org** | per domain `last_success_at` (timestamptz) | `next_sync_at IS NOT NULL`, parent `tenant_id IS NOT NULL`, flag on (D7) | `GREATEST(3 * interval_seconds, 3600)` s | `m365_sync_state_stale_idx` (expression, `WHERE next_sync_at IS NOT NULL`) |
| `td_synnex_sftp` (new) | partner | `last_sync_at` (timestamp, attempt-stamped) | `enabled` | 4320 min (nightly) | none |

**DNS interval parity.** The job computes `Number(syncInterval)` → `Math.round` → clamp, with a non-finite value → 15. SQL cannot reproduce JS `Number()` coercion of strings, so the SQL `CASE` takes this shape:
- absent / JSON null → 15;
- matches `^-?[0-9]+(\.[0-9]+)?$` → `round` + clamp (identical to the job);
- anything else (a string such as `" 30 "`, a boolean, an object) → **1440**, which is never earlier than the job's threshold.

The route's Zod schema (`z.number().int().min(5).max(1440)`) makes that branch unreachable for new rows. Its only effect is that a corrupt legacy value is detected late, never falsely. Every input whose job interval is ≤ 20 min shares the 60-minute floor, so it cannot diverge at all.

**EDR fallback.** `effective_*` is NULL only before the first inventory success, which is when it is first written. A row in that state is due immediately (a NULL stamp is due), so the 60-minute fallback only bounds "never synced". The longest planned interval is 7 days (`scheduler.ts` `MAX_INTERVAL_MINUTES`), which gives a 21-day threshold.

## #9126 seam (documented, not planned)

A Google Workspace connection stuck in `unavailable` would escalate through the same seam. `last_verified_at` moves on every `ok` probe (W4 D6), so it is a success-only stamp. The extension would be:
- a `stale` input on `googleWorkspaceHealth` (`last_probe_status = 'unavailable' AND staleArm(last_verified_at, created_at, now, 1440)`);
- an `OR` arm on `google_workspace_connections`, which is org-axis, so it needs its own index proven in the same EXPLAIN contract;
- reuse of the 2-observation debounce.

It would need either a new condition code (a new label in all 8 locales) or reuse of `verification_failed`. That choice belongs to #9126.

**Capacity caveat for #9126.** The probe claims at most 16 connections per 30-minute run (`PROBE_BATCH`, `googleProbe.ts`), about 768 a day. A fixed "24 h since `last_verified_at`" rule would therefore flag healthy connections that were simply not probed once the fleet passes that size. The arm must measure from the last *probe attempt* that returned `unavailable` (`last_probe_status = 'unavailable'` continuously since `last_verified_at`, with `last_probe_at` recent), not from wall time alone.

## Review Focus

1. **A DNS integration set to sync daily (`syncInterval: 1440`) that synced 20 hours ago.** Expect it not to be read at all. Its stale-at is 72 h out, so the index range excludes it. Test: Task 5 integration parity table, plus the EXPLAIN `Index Cond` assertion.
2. **M365 tenant sync is switched off (the default).** Expect no `m365_sync` stale incident anywhere, and no stale rows read. Test: Task 6 integration "flag off".
3. **A connected M365 mailbox whose tenant ownership row is missing, or a Gmail row whose org/partner diverge.** The sweep never lists it (`listConnectedMailboxes` inner-joins ownership; the Gmail list drops divergent rows), so mail never flows. Expect `sync_stale` after the threshold: a real break that was silent before. Test: Task 3 integration "connected, never polled".
4. **An accounting connection with both payment switches off.** No sweep runs for it. Expect it never stale, however old `last_reconcile_at` is. Test: Task 2 integration.
5. **A Xero connection that spent 80% of its daily call budget by noon.** Background reconcile pauses for the rest of the budget window. Expect no `sync_stale` for up to 25 h, and `sync_stale` past that. Test: Task 2 integration.

The EDR "detections hung in `running`" case is pinned by the Task 1 verdict rows and integration case.

---

## File Structure

| File | Responsibility | PR |
|---|---|---|
| `apps/api/src/services/integrationStates.ts` (+ `.test.ts`) | `stale` input on `edrHealth`, `accountingHealth`, `ticketMailboxHealth` (A), `dnsFilterHealth`, `m365SyncHealth` (B); new `tdSynnexSftpHealth` (C) | A, B, C |
| `apps/api/src/services/connectionHealth/sources/{edr,accounting,ticketMailbox}.ts` | stale arm + `stale` column | A |
| `apps/api/src/services/connectionHealth/sources/observeRows.ts` | `staleAtBefore(staleAt, now)` helper | B |
| `apps/api/src/services/dnsFilterSyncInterval.ts` (new, + test) | `syncIntervalMinutesFromConfig`, moved out of `jobs/dnsSyncJob.ts` so tests and the job share it without importing BullMQ | B |
| `apps/api/src/services/connectionHealth/sources/{dnsFilter,m365Sync}.ts` | arm via `staleAtBefore`, `stale` column / per-domain flag, M365 flag lifecycle | B |
| `apps/api/migrations/2026-12-31-233000-connection-health-stale-indexes.sql` | two expression indexes + INVALID guard | B |
| `apps/api/src/db/schema/{dnsSecurity,m365Sync}.ts` | `DNS_SYNC_INTERVAL_MINUTES`; stale-at builders `dnsFilterStaleAt` / `m365SyncStaleAt`; the expression index declarations (single definition, D5) | B |
| `apps/api/src/services/connectionHealth/sources/tdSynnexSftp.ts` (new); `apps/api/src/services/connectionHealth/types.ts`; `sources/index.ts` | new kind, registration, exemption removed | C |
| `apps/api/src/services/connectionHealth/sources/sources.test.ts` | per-source fixture rows | A, B, C |
| `apps/api/src/__tests__/integration/connectionHealthStaleness.integration.test.ts` (new) | real-DB stale / fresh / never-synced / pending per kind; one `describe` per kind, so the PRs append | A, B, C |
| `apps/api/src/__tests__/integration/connectionHealthSourceIndexes.integration.test.ts` | stale indexes named + `Index Cond`; `td_synnex_sftp_integrations` on `PARTNER_AXIS_TABLES` | B, C |
| `docs/superpowers/specs/integrations/2026-10-15-connection-health-notifications-design.md` §3 | "#9127 amendments" bullet: the kinds and D5–D7 | A |
| `apps/docs/src/content/docs/features/notifications.mdx` | "Stalled syncs" list | A, B, C |

**PR split.** Serial, each off fresh `main` after the previous one merges, not stacked. A stacked PR runs no CI.
- **PR A:** edr + accounting + ticket_mailbox (Tasks 0–3). No migration.
- **PR B:** dns_filter + m365_sync + migration (Tasks 4–6).
- **PR C:** td_synnex_sftp (Task 7).

Bodies: `Refs #9127`, `Refs #8844`. Only the last PR carries `Closes #9127`.

---

### Task 0: Spec amendment (PR A)
- [ ] Add a "**#9127 amendments**" bullet under spec §3 "W4 amendments":
  - `sync_stale` now covers edr, accounting, ticket_mailbox, dns_filter, m365_sync and the new `td_synnex_sftp`;
  - EC Express and Digital Bridge stay exempt (no schedule);
  - org-axis arms ride on expression indexes (D5);
  - daily-budget accounting providers use a 1500-minute threshold (D1);
  - the M365 arm is gated on its flag, and flag off retires `m365_sync` (D7).
- [ ] Commit with Task 1.

### Task 1: EDR stale arm (PR A)
**Files:** `integrationStates.ts` (+ test), `sources/edr.ts`, `sources.test.ts`, new `connectionHealthStaleness.integration.test.ts`.
**Interfaces:** `edrHealth(row: { isActive; status; lastInventorySyncStatus; lastDetectionSyncStatus; stale?: boolean }): HealthVerdict`; `EdrRow.stale: boolean`.
- [ ] **Red (verdict):**
  - `stale` → transient `sync_stale`;
  - `stale` + a stream `running` → `sync_stale`;
  - `stale` + a stream `error` → `sync_failed`;
  - `stale` + `reauth_required` → permanent `reauth_required`;
  - inactive + `stale` → retired;
  - not stale + `running` → unknown (unchanged).
- [ ] **Red (fixture):** a stale row → `{ condition: 'sync_stale', detail: null }`, even with an old `lastInventorySyncError`.
- [ ] **Red (integration, `describe('edr')`):**
  - `effective_detection_interval_minutes = 10`, detections success 70 min ago, inventory fresh → broken `sync_stale`;
  - detections 50 min ago → not returned;
  - never synced, `created_at` 3 h ago → `sync_stale`; `created_at` 30 min ago → not returned;
  - `effective_inventory_interval_minutes = 1440`, inventory 2 days ago → not stale, 4 days → stale;
  - `status = 'reauth_required'` → permanent, not `sync_stale`.
- [ ] Run `cd apps/api && npx vitest run src/services/integrationStates src/services/connectionHealth/sources`. Expect FAIL on the new rows.
- [ ] **Implement** in `sources/edr.ts`:
  - `const EDR_UNPLANNED_INTERVAL_MINUTES = 60`;
  - per stream, `staleArm({ lastOk, createdAt: t.createdAt, now, minutes: sql\`GREATEST(3 * COALESCE(${effective}, ${sql.raw('60')}), 60)\`, withTimezone: true })`;
  - `stale = (status = 'connected' AND (inv OR det))` selected as a column;
  - `brokenWhere: (now) =>` the W2 predicate `OR (is_active AND stale)`;
  - in `edrHealth`, the `stale` check goes after the `sync_failed` line and before `running`.
- [ ] Green, then commit `feat(connection-health): EDR sync staleness (#9127)`.

### Task 2: Accounting stale arm (PR A)
**Files:** `integrationStates.ts` (+ test), `sources/accounting.ts`, `sources.test.ts`, integration file.
**Interfaces:**
- `accountingHealth(row: { status: string; stale?: boolean }): HealthVerdict`;
- `export const RECONCILED_PROVIDERS: readonly AccountingProviderId[] = ['quickbooks', 'xero']` and `export const DAILY_BUDGET_PROVIDERS: readonly AccountingProviderId[] = ['xero']` in `sources/accounting.ts`;
- `ACCOUNTING_STALE_MINUTES = staleAfterMinutes(15)` (60) and `DAILY_BUDGET_STALE_MINUTES = 24 * 60 + 60` (1500);
- `AccountingRow.stale: boolean`.
- [ ] **Red (verdict):**
  - `connected` + `stale` → transient `sync_stale`;
  - `pending_tenant` + `stale` → unknown;
  - `reauth_required` + `stale` → permanent `reauth_required`;
  - `connected`, not stale → healthy.
- [ ] **Red (unit):** the test imports the registry; the source does not, which keeps provider modules out of the reconciler's import graph.
  - `RECONCILED_PROVIDERS` equals the providers for which `providerSupports(p, 'paymentPull')` (from `services/accounting/providerRegistry.ts`).
  - `DAILY_BUDGET_PROVIDERS` equals the providers whose `findAccountingProvider(p).limits.rate.dailyPerConnection` is non-null.
  - Both are vacuous today (every provider qualifies, and only Xero has a daily budget). They guard against a third provider.
- [ ] **Red (fixture):** detail is `lastError` when it starts with `RECONCILE_RUN_ERROR_PREFIX` (`services/accounting/accountingConnectionService.ts`), otherwise `null`.
- [ ] **Red (integration, `describe('accounting')`):**
  - QuickBooks `connected`, pull on, `last_reconcile_at` 70 min ago → `sync_stale`;
  - QuickBooks, 40 min ago → absent;
  - Xero, 20 h ago → absent; Xero, 26 h ago → `sync_stale` (Review Focus 5);
  - pull and push off, `last_reconcile_at` 30 days ago → absent;
  - `pending_tenant`, old → absent;
  - never reconciled, `created_at` 3 h ago → `sync_stale`.
- [ ] **Implement:**
  - `stale = (status = 'connected' AND (pull_payments OR push_payments) AND provider IN (<RECONCILED_PROVIDERS literals>) AND staleArm(last_reconcile_at, created_at, now, sql\`CASE WHEN provider IN (<DAILY_BUDGET_PROVIDERS literals>) THEN 1500 ELSE 60 END\`, tz))`;
  - `brokenWhere` becomes `status IN (…) OR <stale>`.
- [ ] Green, then commit.

### Task 3: Ticket mailbox stale arm (PR A)
**Files:** `integrationStates.ts` (+ test), `sources/ticketMailbox.ts`, `sources.test.ts`, integration file, `notifications.mdx`.
**Interfaces:** `ticketMailboxHealth(row: { status; consecutiveTransientFailures; stale?: boolean }): HealthVerdict`; `TicketMailboxRow.stale: boolean`.
- [ ] **Red (verdict):**
  - `connected` + `stale` → transient `sync_stale`;
  - `connected` + failures ≥ 5 + `stale` → `poll_failing`;
  - `reauth_required` + `stale` → permanent;
  - `disabled` + `stale` → retired;
  - `pending_consent` + `stale` → unknown.
- [ ] **Red (integration, `describe('ticket_mailbox')`):**
  - Gmail `connected`, `last_polled_at` 70 min ago, 0 failures → `sync_stale`, `detail: null`;
  - M365 polled 5 min ago → absent;
  - `connected`, never polled, `created_at` 3 h ago → `sync_stale` (Review Focus 3);
  - `pending_consent`, old → absent.
- [ ] **Implement:**
  - `const POLL_SWEEP_MINUTES = 1.5` (mirrors `SWEEP_INTERVAL_MS` in `jobs/ticketMailboxPollWorker.ts`; comment, do not import the worker);
  - `staleArm(last_polled_at, created_at, now, staleAfterMinutes(POLL_SWEEP_MINUTES), tz)`;
  - `brokenWhere` adds `OR (status = 'connected' AND stale)`.
- [ ] Docs: "Stalled syncs" bullet names EDR, accounting (QuickBooks/Xero payment reconcile) and ticket mailboxes.
- [ ] Green, then run the **PR A exit checklist**, open PR A.

### Task 4: Stale-at helper and DNS interval constants (PR B)
**Files:** `sources/observeRows.ts`, `db/schema/dnsSecurity.ts`, new `services/dnsFilterSyncInterval.ts` (+ test), `jobs/dnsSyncJob.ts`.
**Interfaces:**
- `staleAtBefore(staleAt: SQL, now: Date): SQL` → `(<staleAt> < '<iso>'::timestamp)`. `staleAt` is always a `timestamp` (UTC wall time).
- `export const DNS_SYNC_INTERVAL_MINUTES = { DEFAULT: 15, MIN: 5, MAX: 1440 } as const` in `db/schema/dnsSecurity.ts`, beside `DnsIntegrationConfig`. It sits there so the schema's index builder can use it without importing a service.
- `syncIntervalMinutesFromConfig(config: DnsIntegrationConfig): number`, moved unchanged from `jobs/dnsSyncJob.ts` (today module-private, signature kept) into `services/dnsFilterSyncInterval.ts`, which is import-free apart from the schema type and constants.
- [ ] **Red (unit):** `syncIntervalMinutesFromConfig` on `15 → 15`, `3 → 5`, `2000 → 1440`, `30.6 → 31`, `'abc' → 15`, `undefined → 15`. `staleAtBefore` renders a `::timestamp` cast with the ISO instant as a bind parameter.
- [ ] **Implement:** move the constants and function; `dnsSyncJob.ts` imports them (behaviour unchanged; its existing tests stay green).
- [ ] Green, then commit.

### Task 5: DNS filter stale arm + index (PR B)
**Files:** `sources/dnsFilter.ts`, `integrationStates.ts` (+ test), `sources.test.ts`, migration, `db/schema/dnsSecurity.ts` (builder + index declaration), integration file, `connectionHealthSourceIndexes.integration.test.ts`.
**Interfaces:**
- `export function dnsFilterStaleAt(t: typeof dnsFilterIntegrations): SQL` in `db/schema/dnsSecurity.ts`, used by the index declaration `staleIdx: index('dns_filter_integrations_stale_idx').on(dnsFilterStaleAt(table)).where(sql\`${table.isActive}\`)` and by the source;
- `dnsFilterHealth(row: { isActive; lastSyncStatus; stale?: boolean })`;
- `DnsFilterRow.stale: boolean`.

The expression, with `DNS_SYNC_INTERVAL_MINUTES` and the `3` / `60` of the threshold rule as `sql.raw` literals. This text was proven on Postgres 16 to be accepted as an index expression and to plan as `BitmapOr` + `Index Cond`; the migration writes the same text.
```sql
(COALESCE(last_sync, created_at) + make_interval(mins => GREATEST(3 * (CASE
  WHEN config->>'syncInterval' IS NULL THEN 15
  WHEN config->>'syncInterval' ~ '^-?[0-9]+(\.[0-9]+)?$'
    THEN LEAST(1440, GREATEST(5, round((config->>'syncInterval')::numeric)))::int
  ELSE 1440 END), 60)))
```
- [ ] **Red (verdict):**
  - active + `stale` → transient `sync_stale`;
  - `error` + `stale` → `sync_failed`;
  - inactive → retired;
  - never synced (`lastSyncStatus` null), not stale → unknown.
- [ ] **Red (integration, `describe('dns_filter')`):**
  - parity table, for `syncInterval` in absent, `null`, `15`, `30`, `1440`, `3`, `-5`, `2000`, `30.6`, `99999999999999999999`:
    - expected threshold = `staleAfterMinutes(syncIntervalMinutesFromConfig(config))`;
    - a row at `threshold + 5 min` is `stale` and a row at `threshold − 5 min` is not.
  - for `"abc"`, `" 30 "`, `true`: the row is *not* stale at the job's threshold + 5 min, and is stale at 4325 min. This is the conservative 1440 branch (see "DNS interval parity").
  - Seed the tz-less columns as UTC wall time, as W4's UniFi case does.
  - never synced, `created_at` 3 h ago → `sync_stale`;
  - inactive, old → absent.
- [ ] **Red (EXPLAIN):**
  - add `['dns_filter', 'dns_filter_integrations_stale_idx']` to the `uses` table;
  - new case: the line after `Bitmap Index Scan on dns_filter_integrations_stale_idx` contains `Index Cond` (D5c);
  - `dns_filter_integrations_sync_error_idx` is still used.
- [ ] **Implement:**
  - the source's `brokenWhere` is the OR-of-ANDs form `(is_active AND last_sync_status = 'error') OR (is_active AND staleAtBefore(dnsFilterStaleAt(), now))`;
  - the select carries `stale`;
  - the migration creates `dns_filter_integrations_stale_idx ON public.dns_filter_integrations (<expr>) WHERE is_active`, plus the guard row.
- [ ] `pnpm db:check-drift`, green, then commit.

### Task 6: M365 sync stale arm + index (PR B)
**Files:** `sources/m365Sync.ts`, `integrationStates.ts` (+ test), `sources.test.ts`, migration (second index + guard row), `db/schema/m365Sync.ts` (builder + index declaration), integration files, `notifications.mdx`.
**Interfaces:**
- `export function m365SyncStaleAt(t: typeof m365SyncState): SQL` in `db/schema/m365Sync.ts` = `((COALESCE(last_success_at, created_at) AT TIME ZONE 'UTC') + make_interval(secs => GREATEST(3 * interval_seconds, 3600)))`. The index is declared with `.on(m365SyncStaleAt(table)).where(sql\`${table.nextSyncAt} IS NOT NULL\`)`.
- `M365SyncDomain.stale: boolean`.
- `m365SyncHealth(connectionStatus, domainStatuses, opts: { anyStale?: boolean; syncEnabled?: boolean } = {})`. `syncEnabled` defaults to `true` so existing callers keep their behaviour; the source passes `isM365TenantSyncEnabled()`.
- `brokenConnectionsQuery(now: Date, syncEnabled: boolean)`.
- [ ] **Red (verdict):**
  - `syncEnabled: false` → retired, whatever the statuses (D7b);
  - no domains → retired;
  - parent not `active` + `anyStale` → unknown;
  - `needs_consent` + stale → permanent;
  - `error` + stale → `sync_failed`;
  - all `success` + `anyStale` → transient `sync_stale`.
- [ ] **Red (fixture):** a stale observation's detail is `Stalled: <domain, …>` (stale domains only, sorted).
- [ ] **Red (integration, `describe('m365_sync')`, flag on via `vi.stubEnv('M365_TENANT_SYNC_ENABLED', 'true')` or the env helper `isM365TenantSyncEnabled` reads):
  - `users` domain, `interval_seconds 21600`, success 19 h ago → `sync_stale`;
  - 17 h ago → absent;
  - `next_sync_at` NULL, success 30 days ago → absent;
  - never succeeded, `created_at` 2 days ago → `sync_stale`;
  - parent connection with `tenant_id` NULL, success 30 days ago → not `sync_stale` (D7c).
- [ ] **Red (integration, flag off):** the same 19 h row → absent untracked; tracked (an open `sync_stale` incident id passed in) → `retired`, never `healthy` (Review Focus 2, D7b).
- [ ] **Red (EXPLAIN):** `m365_sync` uses both `m365_sync_state_unhealthy_idx` and `m365_sync_state_stale_idx`, with `Index Cond` on the latter. Flag on for this case.
- [ ] **Implement:**
  - `brokenConnectionsQuery(now, syncEnabled)` selects distinct `connection_id` where `last_status IN (…)` OR (flag on) `(next_sync_at IS NOT NULL AND staleAtBefore(m365SyncStaleAt(s), now))`;
  - `loadConnections(ids, now, syncEnabled)` selects a per-domain `stale` = `next_sync_at IS NOT NULL AND m365_connections.tenant_id IS NOT NULL AND staleAtBefore(…)` (literal `false` when the flag is off);
  - `brokenQuery: (now) => brokenConnectionsQuery(now)`;
  - the migration creates `m365_sync_state_stale_idx ON public.m365_sync_state (<expr>) WHERE next_sync_at IS NOT NULL`.
- [ ] Docs: the bullet names DNS filtering and Microsoft 365 tenant sync (when enabled).
- [ ] Green, `pnpm db:check-drift`, then run the **PR B exit checklist**, open PR B.

### Task 7: `td_synnex_sftp` kind (PR C)
**Files:** new `sources/tdSynnexSftp.ts`, `apps/api/src/services/connectionHealth/types.ts`, `sources/index.ts`, `integrationStates.ts` (+ test), `sources.test.ts`, integration files, `notifications.mdx`.
**Interfaces:**
- `CONNECTION_SOURCE_KINDS` gains `'td_synnex_sftp'` under a `// #9127` comment;
- `tdSynnexSftpHealth(row: { enabled: boolean; lastSyncStatus: string | null; stale?: boolean }): HealthVerdict`;
- `tdSynnexSftpSource: HealthSource` with `intervalMinutes: 60`, `tables: ['td_synnex_sftp_integrations']`, `fixHrefs: ['/integrations#tdsynnex-sftp']`, view `PERMISSIONS.CATALOG_READ`, repair `PERMISSIONS.CATALOG_WRITE`, display name `TD SYNNEX price file`, `orgId: null`.
- [ ] **Red (verdict):**
  - `enabled: false` → retired;
  - `error` → transient `sync_failed`;
  - `stale` → `sync_stale`;
  - `stale` + `error` → `sync_failed`;
  - `ok` → healthy;
  - `running` or null → unknown.
- [ ] **Red (contracts, expected to fail first):** `coverage.contract.test.ts` "one source per declared kind" and the exemption checks, after the kind is added but before registration and exemption removal; `fixLinks.contract.test.ts` gains the new href.
- [ ] **Red (integration, `describe('td_synnex_sftp')`):**
  - `ok`, `last_sync_at` 80 h ago → `sync_stale`;
  - 20 h ago → absent;
  - `error` 1 h ago → `sync_failed` with sanitized detail;
  - `running`, last attempt 80 h ago → `sync_stale`;
  - `enabled = false` → absent untracked, retired when tracked;
  - never synced, `created_at` 4 days ago → `sync_stale`.
- [ ] **Red (EXPLAIN):** `td_synnex_sftp_integrations` joins `PARTNER_AXIS_TABLES` (one row per partner, unique `partner_id`).
- [ ] **Implement:**
  - `defineRowSource` in the `pax8.ts`/`unifi.ts` style;
  - `staleArm(last_sync_at, created_at, now, staleAfterMinutes(1440), withTimezone: false)`;
  - `brokenWhere` = `enabled AND (last_sync_status = 'error' OR stale)`;
  - register in `HEALTH_SOURCES` and delete the `td_synnex_sftp_integrations` exemption.
- [ ] Docs: the bullet adds the TD SYNNEX price file, and the reconciler section notes that EC Express and Digital Bridge are not watched (no schedule).
- [ ] Green, then run the **PR C exit checklist**, open PR C with `Closes #9127`.

---

## Exit checklist (each PR)

- **Unit:** `cd apps/api && npx vitest run src/services/integrationStates src/services/connectionHealth` (for PR B add `src/services/dnsFilterSyncInterval src/jobs/dnsSyncJob`). Report file and test counts from the real output.
- **Contracts that fire:**
  - `sources/coverage.contract.test.ts` (C: new kind, exemption removed);
  - `sources/fixLinks.contract.test.ts` (C);
  - `sources/conditions.contract.test.ts` (all PRs; it must stay green with no label change, since every emitted code already has a label);
  - `apps/api/src/i18n/localeParity.test.ts` and web `src/lib/i18n` parity (expected untouched; run once to prove it).
- **Integration** (needs real Postgres; `pnpm test` skips it): bring up a per-worktree stack (`pnpm test-stack up`, or `pnpm wt-stack` with the root `.env` copied, AI keys blanked, `BREEZE_WORKSPACE_ENABLED=false` and a free `BREEZE_DOCKER_SUBNET`). Run every `src/__tests__/integration/connectionHealth*.integration.test.ts` through `vitest.integration.config.ts` (see `docs/agents/testing.md`), then tear the stack down. PR B also runs the migration against the stack and re-runs the index contract.
- **Typecheck:** `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit; echo "exit=$?"`. Read the exit code; never pipe to `tail`.
- **Migration (PR B):** `pnpm db:check-drift`; the naming hook passes; `migrationRlsScope.test.ts` stays green (no row writes).
- **PR body:**
  - the per-kind pre-deploy count query (D9);
  - "no new column/table/job/env/route; no agent change";
  - Settings rule 9: 0 → 0.

## Quorum

Position first (D1–D9 as drafted), then `codex exec -s read-only` at `xhigh` on the same checkout.

- **Agreed:**
  - EDR, M365, mailbox and SFTP last-success reads;
  - threshold constants with no setting;
  - state-machine reuse;
  - the evaluation path;
  - copy reuse;
  - expression indexes over a column;
  - the PR split;
  - deploy acceptance.
- **Disagreed, resolved on the merits:**
  1. Accounting: Xero's daily-budget deferral would read as stale at 60 min. Adopted as a budget-aware 1500-min threshold (D1, Task 2).
  2. M365 flag lifecycle. Adopted: flag off must not manufacture recovery, and eligibility mirrors the claim's `tenant_id` rule (D7b, D7c). Codex offered `unknown` for flag-off. This plan uses `retired`, which also avoids a false recovery and does not leave incidents open indefinitely for a sync the operator turned off. For the re-enable backlog Codex allowed "accept and count, or warm up"; this plan accepts and counts (D7d), with the reason recorded there.
  3. The #9126 seam: Google probe capacity (about 768 a day) makes a wall-clock 24 h rule wrong at scale. Recorded under the seam.
- **Clarifications folded in:**
  - DNS `last_sync` is a slice checkpoint (D1);
  - exact `Number` → `round` → clamp parity, which led to the conservative 1440 branch;
  - `applyGrace` covers every young transient break (D3);
  - the Gmail stamp moves on any truthy history id (D1);
  - schema index declarations via shared builders (D5);
  - stale-index-specific `Index Cond` assertions (Tasks 5–6);
  - count distinct connections, split by already-tracked (D9).

Nothing is left to surface to Todd as a design disagreement.
