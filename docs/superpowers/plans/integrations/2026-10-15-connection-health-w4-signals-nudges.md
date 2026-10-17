---
tracking_issue: LanternOps/breeze#8844
wave: W04 (#8848)
---

# Connection Health W4 — Missing Signals and Reconcile Nudges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connections that fail without writing a failure now open incidents: outbound webhooks whose deliveries die, syncs that silently stop running, and Google Workspace connections whose delegation was revoked. An OAuth grant incident says whether the app is still hammering the token endpoint. Shared failure write points nudge the reconciler so detection takes about a minute, not a poll. Ops can see on `/admin/system` whether the reconciler and the digest are alive.

**Architecture:**
- Two new `HealthSource` kinds: `webhook` (terminal delivery failures, index-backed on `webhook_deliveries`) and `google_workspace` (a stored verification-probe result, index-backed). The Google probe runs in a new optional `HealthSource.prepare()` step, outside the kind's transaction.
- Sync staleness is **folded into the existing row sources** as a new transient condition `sync_stale`, not a separate kind, so a connection keeps one incident (spec [R]).
- The OAuth source decorates broken grants' `detail` from a Redis per-client daily counter fed by the `grant.error` logger.
- `services/connectionHealth/nudge.ts` enqueues a delayed, deduplicated `reconcile-kind` job on the existing reconciler queue; `oauth/grantStatus.ts` and `jobs/syncAttempt.ts` call it fire-and-forget.
- Heartbeats (reconciler, new digest heartbeat, per-kind last success and failure streaks) are read by a new platform-admin route and shown on `/admin/system`.

**Tech Stack:** Hono, Drizzle (queries only), hand-written SQL migrations, BullMQ, ioredis, googleapis (`@googleapis/admin`), Vitest, React + react-i18next.

**Spec:** `docs/superpowers/specs/integrations/2026-10-15-connection-health-notifications-design.md` (§1.1–§1.3, §3, §7, §8). Prior waves: `2026-10-15-connection-health-w{1-core-oauth,2-sources-panel,3-digest}.md`.

## Global Constraints

- **No new table.** Two migrations, both re-checked to sort last at rebase:
  - `apps/api/migrations/2026-12-29-240000-google-workspace-probe-columns.sql`: three nullable columns on `google_workspace_connections` plus a CHECK. Idempotent, no row writes.
  - `apps/api/migrations/2026-12-29-250000-connection-health-w4-indexes.sql`: `-- @no-transaction`, `CREATE INDEX CONCURRENTLY IF NOT EXISTS` (both `webhook_deliveries` indexes are on a live, append-only table with no retention), followed by the INVALID-index guard from `2026-12-23-100000-tier1-sweep-indexes.sql`.
- **Export policy** (`CORE_TENANT_EXPORT_POLICY`): `google_workspace_connections.last_probe_at` and `last_probe_status` → `included`; `last_probe_error` (provider text) → `excludedOpen`. No cascade/merge change (no new table, no new org_id).
- Partial-index predicates are stated with literal constants (`sql.raw`), as in W1/W2.
- `detail` is `sanitizeHealthDetail(raw)` or `null`. Google credentials, decrypted keys and token hashes never reach a log line, a detail, or Redis.
- Nudges never throw, never await on the caller's path, never touch the caller's DB transaction, and carry no policy (the poll stays the source of truth).
- New `en` locale keys go to all 8 locale folders with real translations.
- Public repo: no customer, host or infrastructure names.

## Decisions (and spec amendments, folded into the spec in the plan commit)

| # | Decision | Why |
|---|---|---|
| D1 | **Staleness is a condition (`sync_stale`, transient) on the existing row sources**, not its own kind. The spec's "staleness checks run every 360 minutes" is superseded: the stale arm is an `OR` on queries the source already runs at its own cadence, so it costs no extra query. | Spec [R]: one incident per connection. A separate kind would open a second incident beside `sync_failed` for the same connection, and could not close cleanly when the connection moved from stale to failed. |
| D2 | Stale threshold = `max(3 × sync interval, 60 min)`, measured from the last **successful** sync, or from `created_at` when it never succeeded. Precedence: retired → `sync_failed`/`reauth_required` → `sync_stale` → healthy → unknown. | The floor keeps a 15-minute sync from flagging on one slow run; transient also needs two consecutive observations (§1.2), so the effective bound is about 75 minutes. A stuck `running` row (worker died mid-sync) was `unknown` forever before this. |
| D3 | Staleness ships for **huntress, sentinelone, pax8, unifi, backup_provider**. Deferred, with reasons in the result file: **edr** (effective interval falls back to adapter defaults in code, not SQL), **accounting** (no success column; `last_reconcile_at` only advances when pull/push is on), **dns_filter** (per-row interval in jsonb; org-axis so the stale arm needs an index the per-row interval defeats), **m365_sync** (adaptive per-domain interval, flag-gated scheduler), **ticket_mailbox** (90 s poller, and the failure counter already covers it), **td_synnex_*** (catalog feeds, manual or nightly). | Each shipped kind has an unambiguous success timestamp and an interval SQL can state. Pax8 and UniFi stamp `last_sync_at` on every attempt, so for them the arm reads "no completed attempt", and a completed failure is already `sync_failed`. |
| D4 | **Webhook terminal failure** = a `webhook_deliveries` row with `status = 'failed'`, `attempts >= retry budget` (`retry_policy.maxRetries`, default 5, at least 1), and an `error_message` not starting `superseded_by_edit:`. Broken when one such row was created in the last hour; recovered only when `webhooks.last_success_at` is after the latest one. Transient, `delivery_failed`. | The worker writes `failed` after **every** failed attempt (the retry is a Redis job), so `failed` alone is not terminal. Superseded rows were never attempted. Recovery-sweep rows (`attempts = 0`) are Breeze-side failures, not the endpoint's. Affirmative recovery (§1.2 [Q]): a webhook with a dead endpoint and no further events stays open until a delivery succeeds or it is disabled (retired). |
| D5 | Two partial indexes on `webhook_deliveries`: `(created_at) WHERE status = 'failed'` (broken range scan) and `(webhook_id, created_at) WHERE status = 'failed'` (tracked latest-failure lateral). | Both tables grow with orgs. Failed rows are a small fraction of deliveries, but the table has no retention, so the indexes grow with failures, not with traffic. Noted for the W5/retention follow-up. |
| D6 | **Google probe** stores its result on the connection: `last_probe_at`, `last_probe_status` (`ok` / `failed` / `unavailable`), `last_probe_error` (sanitized, ≤ 300). `last_verified_at` moves on every `ok`. The source is a plain row source on `last_probe_status = 'failed'` (partial index), permanent `verification_failed`. `unavailable` (429, 5xx, network, timeout) is `unknown`: a Google outage must not open an incident in every org. | A probe result in a column is durable and EXPLAIN-able; Redis would make the broken set disappear on eviction. |
| D7 | The probe runs in `HealthSource.prepare(now)`, called by the reconciler **before** the kind's transaction and outside any DB context. Rate limits: each connection at most once per 6 hours, at most 16 probes per run, 4 in parallel, 8 s each; the kind runs every 30 minutes. Due rows are claimed with `UPDATE … SET last_probe_at = now WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`, so overlapping runs never probe the same connection; results are written with a CAS on `updated_at`, so a probe that raced an admin's key replacement cannot overwrite the fresh result. Saving the connection (the route already verifies inline) writes `last_probe_status = 'ok'`, so a fix clears the incident on the next two observations. | No network call inside a DB transaction; bounded worst case (16 / 4 × 8 s = 32 s). Scales to about 140 connected orgs at a 6-hour cadence; beyond that the cadence stretches (oldest first), which is acceptable for a permanent-only signal. Recorded as a follow-up if Google adoption grows. |
| D8 | **OAuth "still retrying"**: the `grant.error` logger calls an injected hook for `invalid_grant` / `refresh token not found` on a **resolved** client only; the hook `INCR`s `connection-health:oauth-retry:<clientId>:<UTC date>` (TTL 2 days). The OAuth source reads today's counts for its broken pairs (one `MGET`, 1 s timeout, failure → no decoration) and sets `detail` to "The app keeps retrying its revoked token (N failed refreshes today, UTC)." | Per client, because the logger has no account; the wording says "the app". Unresolved client ids are attacker-controlled and are never counted. The `MGET` runs inside the kind's transaction; it is one bounded call, and a Redis failure degrades to a null detail, never a failed kind. |
| D9 | **Nudge**: `nudgeConnectionHealth(kind)` adds job `reconcile-kind` with `jobId: reconcile-kind-<kind>`, `delay: 60_000`, `removeOnComplete/removeOnFail: true` to `connection-health-reconcile`. The worker runs only that kind, ignoring cadence, then the notice outbox; no retention, no heartbeat. Spec amendment: the jobId uses `-`, because BullMQ 5 rejects `:` in custom ids. | A delayed job with a fixed id is the debounce: while it waits, every further add is a no-op, so a burst becomes one run. Removing it on completion re-arms the debounce. The heartbeat stays tied to the schedule so nudges cannot hide a dead repeatable. |
| D10 | Nudge call sites: `revokeGrantsDurablyInCurrentDbContext` (every durable revocation → `oauth_grant`), and a new `reportTerminalSyncFailure(kind)` in `jobs/syncAttempt.ts`, called where the backup, Huntress, EDR and M365 workers record a final-attempt failure. | The two shared write points named in §1.3. Deliberate revocations nudge too: they retire tracked incidents sooner, and the debounce bounds the cost. |
| D11 | **Heartbeats on `/admin/system`**: `GET /api/v1/admin/system/connection-health` (platform admin, GET only, Redis only) returns the reconciler heartbeat, a new digest heartbeat (`connection-health:digest:heartbeat`, written after each digest run, TTL 3 h), and per-kind last success and failure streak. Each is `ok` / `stale` / `missing`; Redis down → `unavailable`, never 500. A card on the Connections tab renders it. | Closes the W1→W2→W4 deferral and adds the digest dead-man the W3 result asked for. |

## Sources (as built)

| Kind | Table(s) | Broken predicate | Index | Severity / condition | Healthy | Unknown | Retired | Interval | Fix href | View / repair |
|---|---|---|---|---|---|---|---|---|---|---|
| `webhook` | `webhooks`, `webhook_deliveries` | terminal, non-superseded failed delivery created in the last hour, webhook `active` | `webhook_deliveries_failed_recent_idx` | transient `delivery_failed` | no terminal failure, or success after it | young (< 2 h) failing | not `active`, deleted | 15 | `/integrations#webhooks` | `webhooks:read` / `organizations:write` |
| `google_workspace` | `google_workspace_connections` | `last_probe_status = 'failed'` | `google_workspace_connections_probe_failed_idx` | permanent `verification_failed` | `ok`, or never probed | `unavailable` | deleted | 30 | `/integrations#google` | `organizations:read` / `organizations:write` |
| huntress, sentinelone | (W2) | W2 predicate `OR` (`is_active` and last success older than 60 min) | partner axis | + transient `sync_stale` | | | | | | |
| pax8 | (W2) | `OR` (`is_active` and last attempt older than 72 h) | partner axis | + `sync_stale` | | | | | | |
| unifi | (W2) | `OR` (`is_active`, not reauth, last attempt older than 90 min) | partner axis | + `sync_stale` | | | | | | |
| backup_provider | (W2) | `OR` (`is_active`, not reauth, last success older than `max(3 × sync_interval_minutes, 60)` min) | partner axis | + `sync_stale` | | | | | | |

## Review Focus

1. **A webhook edited mid-retry.** The queued delivery is superseded (`superseded_by_edit:`). Expect no incident. Test: Task 2 integration "superseded failure is ignored".
2. **A webhook whose 2nd of 5 attempts failed.** The row reads `failed` with `attempts = 2`. Expect no incident. Test: Task 2 "non-terminal failed row is ignored".
3. **Google is down for an hour.** Every probe returns 503. Expect `unavailable` → unknown, no incidents, open ones untouched. Test: Task 4 classification + Task 4 integration.
4. **A Huntress worker dies mid-sync** (`running` forever). Expect `sync_stale` after the threshold, and recovery on the next success. Test: Task 3 verdict rows + integration case.
5. **A burst of 500 refresh-token-reuse revocations.** Expect one delayed job per kind, the hot path never awaiting Redis, and a Redis outage never failing the revocation. Test: Task 6 nudge unit tests (debounce options, sync throw swallowed, rejected add swallowed) and the grantStatus call-site test.
6. **An admin replaces the Google key while a probe is in flight.** Expect the probe's stale failure to be discarded (CAS on `updated_at`). Test: Task 4 integration.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/services/integrationStates.ts` (+ test) | `webhookHealth`, `googleWorkspaceHealth`; `stale` input on the five sync verdicts; `staleAfterMinutes()` |
| `apps/api/src/services/connectionHealth/types.ts` | kinds `webhook`, `google_workspace`; optional `HealthSource.prepare` |
| `apps/api/src/services/connectionHealth/sources/observeRows.ts` | `defineRowSource` takes `now` in `select`/`brokenWhere` |
| `apps/api/src/services/connectionHealth/sources/{partnerSync,unifi,backupProvider}.ts` | stale arm + `stale` column |
| `apps/api/src/services/connectionHealth/sources/webhook.ts` (+ test) | webhook source |
| `apps/api/src/services/connectionHealth/sources/googleWorkspace.ts` (+ test), `services/connectionHealth/googleProbe.ts` (+ test) | Google source; probe claim/run/record |
| `apps/api/src/services/connectionHealth/sources/oauthGrant.ts`, `services/connectionHealth/oauthRetryCounter.ts` (+ test), `oauth/grantErrorLog.ts`, `oauth/provider.ts` | still-retrying counter |
| `apps/api/src/services/connectionHealth/nudge.ts` (+ test), `jobs/syncAttempt.ts`, `oauth/grantStatus.ts`, `jobs/{backupProviderSync,huntressSync,edrProviderSync,m365SyncWorker}.ts` | nudges |
| `apps/api/src/services/connectionHealth/reconcile.ts`, `jobs/connectionHealthReconcile.ts` | `prepare`, nudge mode |
| `apps/api/src/services/connectionHealth/heartbeat.ts` (+ test), `jobs/connectionHealthDigest.ts`, `routes/admin/systemConnectionHealth.ts` (+ test), `routes/admin/index.ts` | heartbeats |
| `apps/api/src/services/connectionHealth/digestEmail.ts`, `apps/web/src/components/integrations/ConnectionHealthPanel.tsx`, `apps/web/src/locales/*/integrations.json` | labels `delivery_failed`, `sync_stale`, `verification_failed` |
| `apps/web/src/components/admin/system/ConnectionHealthJobsCard.tsx` (+ test), `ConnectionsTab.tsx`, `apps/web/src/locales/*/admin.json` | heartbeat card |
| `apps/api/src/db/schema/{google,integrations}.ts`, `services/tenantExportPolicyRegistry.ts`, `routes/google.ts` | columns, indexes, export policy, probe reset on save |
| `apps/api/src/__tests__/integration/connectionHealth{Sources,SourceIndexes}.integration.test.ts` | real-DB contracts |

---

### Task 0: Wave plan and spec amendments
- [ ] Commit this plan plus the spec amendments (D1, D2, D3, D6, D7, D9) and the W2 exemption reasons that named W4.

### Task 1: Verdicts (pure)
**Files:** `services/integrationStates.ts`, `integrationStates.test.ts`.
- [ ] **Red:** table rows for `webhookHealth` (terminal no success → `delivery_failed`; success after → healthy; none → healthy; disabled / `error` status → retired); `googleWorkspaceHealth({ probeStatus })` (`failed` → permanent `verification_failed`; `ok`/null → healthy; `unavailable` → unknown); for each of huntress, s1, pax8, unifi, backup: `stale: true` → `sync_stale`, `stale` + error → `sync_failed`, `stale` + reauth → `reauth_required`, `stale` + `running` → `sync_stale`, inactive + stale → retired; `staleAfterMinutes(15) === 60`, `(30) === 90`, `(1440) === 4320`.
- [ ] **Green**, commit.

### Task 2: Webhook source + indexes
**Files:** `sources/webhook.ts` (+ test), registry, `db/schema/integrations.ts`, migration 250000, integration tests.
- [ ] **Red (unit):** mapper → full observation with sanitized detail (URL → host), `HTTP <status>` fallback, grace, retired; broken SQL carries literal `status = 'failed'` and the superseded `NOT LIKE`.
- [ ] **Red (integration, `connectionHealthSources`):** terminal failure in window → broken; non-terminal (`attempts` 2 of 5) → absent; superseded → absent; recovery-sweep row (`attempts` 0) → absent; failure older than the window untracked → absent; tracked with a later success → healthy; tracked with an old failure and no success → still broken; disabled → retired; deleted → absent; custom `retry_policy.maxRetries = 2` → terminal at 2.
- [ ] **Red (EXPLAIN):** `webhook` uses `webhook_deliveries_failed_recent_idx`; `webhooks`, `webhook_deliveries` join `PER_ORG_TABLES`.
- [ ] Green, `pnpm db:check-drift`, commit.

### Task 3: Sync staleness on five row sources
**Files:** `observeRows.ts` (`select(where, now)`, `brokenWhere: SQL | (now) => SQL`), `partnerSync.ts`, `unifi.ts`, `backupProvider.ts`, `sources.test.ts`, integration tests.
- [ ] **Red:** fixtures (stale success row → `sync_stale`; stale young row → unknown via grace); integration: a Huntress row `running` with `last_sync_at` 2 h old is observed `sync_stale`; a fresh one is not returned; a backup row with `sync_interval_minutes = 60` and a 2.5 h old success is not stale, 3.5 h is.
- [ ] Green, commit.

### Task 4: Google verification probe + source
**Files:** migration 240000, `db/schema/google.ts`, `tenantExportPolicyRegistry.ts`, `services/connectionHealth/googleProbe.ts` (+ test), `sources/googleWorkspace.ts` (+ test), `types.ts` (`prepare`), `reconcile.ts` (call `prepare` before the transaction), `routes/google.ts` (save resets probe columns), registry (drop the exemption), migration-index for the partial index.
- [ ] **Red (unit):** `classifyProbeError`: 401/403/404/400/`invalid_service_account`/decrypt failure → `failed`; 429, 5xx, network code, our timeout → `unavailable`; the recorded error never contains the key, the private key, or a token (hostile fixture). `runGoogleProbes` caps at 16, runs ≤ 4 at once, times out at 8 s, and one probe's throw never stops the others. `reconcile` calls `prepare` outside the DB context, before `runKind`, and a `prepare` throw fails the kind like an `observe` throw.
- [ ] **Red (integration):** claim picks never-probed then oldest, skips rows probed under 6 h ago, and two concurrent claims return disjoint rows; a result whose `updated_at` changed is discarded; source reads `failed` → broken, `unavailable` → unknown.
- [ ] Green, commit.

### Task 5: OAuth still-retrying counter
**Files:** `services/connectionHealth/oauthRetryCounter.ts` (+ test), `oauth/grantErrorLog.ts` (+ test: hook called only for resolved `refresh token not found`, counted even when the log line is suppressed, a throwing hook never escapes), `oauth/provider.ts`, `sources/oauthGrant.ts` (+ test: broken observation gets the detail; count 0 or Redis failure → null).
- [ ] Red, green, commit.

### Task 6: Nudges
**Files:** `services/connectionHealth/nudge.ts` (+ test), `jobs/syncAttempt.ts` (+ test), `oauth/grantStatus.ts` (+ test), the four sync workers, `jobs/connectionHealthReconcile.ts` (+ test: `reconcile-kind` runs one kind, forced due, no retention, no heartbeat; unknown kind → no-op), `reconcile.ts` (`mode: 'nudge'`).
- [ ] **Red:** add called with `{ jobId: 'reconcile-kind-oauth_grant', delay: 60000, removeOnComplete: true, removeOnFail: true }`; returns `void` synchronously; a throwing `getBullMQConnection` and a rejected `add` are swallowed and logged once per kind per minute; `revokeGrantsDurablyInCurrentDbContext` nudges `oauth_grant` after its writes and not for an empty id list; `reportTerminalSyncFailure('huntress')` nudges `huntress`.
- [ ] Green, commit.

### Task 7: Heartbeats on `/admin/system`
**Files:** `services/connectionHealth/heartbeat.ts` (+ test), `reconcile.ts` (use it), `jobs/connectionHealthDigest.ts` (write after `runDigest`), `routes/admin/systemConnectionHealth.ts` (+ test), `routes/admin/index.ts`, web `ConnectionHealthJobsCard.tsx` (+ test), `ConnectionsTab.tsx`, `admin.json` ×8.
- [ ] **Red (API):** `ok` within the window, `stale` past it, `missing` without a key, `unavailable` when Redis throws (200, not 500); non-GET 404; every kind in `HEALTH_SOURCES` listed.
- [ ] **Red (web):** renders the three states with `data-testid`s; a failed fetch shows a one-line error, not a crash; 403 renders nothing.
- [ ] Green, commit.

### Task 8: Labels and docs
- [ ] `delivery_failed`, `sync_stale`, `verification_failed` in `KNOWN_CONDITIONS`, `DIGEST_CONDITION_LABELS`, and `connectionHealthPanel.condition.*` ×8 locales (the conditions contract test enforces all three).
- [ ] Docs: `apps/docs` connection-health section lists the new sources.

### Task 9: Verification
- API unit: `npx vitest run src/services/connectionHealth src/services/integrationStates src/oauth/grantErrorLog src/oauth/grantStatus src/jobs/syncAttempt src/jobs/connectionHealthReconcile src/routes/admin/systemConnectionHealth src/routes/google` (check file counts), migration guards.
- Integration (per-worktree test stack): every `connectionHealth*.integration.test.ts`, plus the export-policy and rls-coverage suites (a column was added to an org-cascade table).
- `pnpm db:check-drift`; API and web `tsc --noEmit` (12 GB heap, exit code read).
- Web: card, panel, `lib/i18n`.
