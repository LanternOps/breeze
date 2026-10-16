---
tracking_issue: LanternOps/breeze#8844
wave: W02 (#8846)
---

# Connection Health W2 — Integration Sources + Connection Health Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every integration that already records a failure (Huntress, SentinelOne, Pax8, UniFi, backup providers, EDR, accounting, DNS filtering, M365 connection, M365 sync, ticket mailboxes) opens a connection health incident and notifies its admins; the `/integrations` hub shows one Connection Health panel listing open and recently resolved incidents with fix links.

**Architecture:**
- Each kind is a `HealthSource` in `services/connectionHealth/sources/`, built on one helper (`observeRows`) that runs the source's index-backed broken query plus a primary-key lookup of the tracked ids, and maps each row through a **pure health function**.
- The pure health functions live in `services/integrationStates.ts`, next to the readiness-board state functions they reuse (moved out of `orgAccountReadinessIntegrations.ts`, which re-exports them), so the board and the reconciler read one truth.
- Provider text reaches `detail` only through `sanitizeHealthDetail()`.
- The W1 reconciler gains flap debounce, fair budget order, silent reseed rules and a zero-recipient metric; the read route filters before it limits.
- The web hub renders `ConnectionHealthPanel` from `GET /connection-health/incidents`; the mock `ConnectorStatusPanel.tsx` is deleted.

**Tech Stack:** Hono, Drizzle (queries only), hand-written SQL migration (indexes only), BullMQ reconciler from W1, prom-client, Vitest, React + react-i18next.

**Spec:** `docs/superpowers/specs/integrations/2026-10-15-connection-health-notifications-design.md` (§1.1–§1.3, §3, §7, §8, §10). W1 plan: `2026-10-15-connection-health-w1-core-oauth.md`.

## Global Constraints

- **No new table.** Indexes only. Migration slot: `apps/api/migrations/2026-12-29-190000-connection-health-source-indexes.sql` (idempotent `CREATE INDEX IF NOT EXISTS`, no `CONCURRENTLY`, no inner `BEGIN/COMMIT`, starts with `SELECT set_config('breeze.scope', 'system', true);`). Re-check it still sorts last before committing.
- Every source query runs in the reconciler's system context; `observe()` throws on failure and never returns a partial set (§1.1).
- Untracked rows are reported only when `broken`; tracked ids are always reported, and a tracked id that no longer exists is simply absent (the reconciler retires it).
- Partial-index predicates are matched only by literal constants: write them with `sql.raw` (W1 precedent, `sources/oauthGrant.ts`).
- `detail` is `sanitizeHealthDetail(raw)` or `null`; never raw provider text. Ticket mailbox `last_error` is never surfaced (it holds raw Graph text by design, #6192): its detail is always `null`.
- User-chosen names (`name`, `display_name`) pass through `cleanDisplayName()` (W1, 80 code points).
- `intervalMinutes` is a multiple of 15.
- Onboarding grace (§1.2): a **transient** broken state on a connection created less than 2 hours ago is reported `unknown`.
- Fix hrefs are relative, same-origin, and every href a source can emit is listed in its `fixHrefs` and resolves to a web route (fix-link test).
- New en locale keys go to all 8 locale folders (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`); keys removed with the mock panel are removed from all of them and from `humanizedKeyBaseline.json`.
- Public repo: no customer, host or infrastructure names.

## Sources (spec §3, as built)

| Kind | Table(s) | Broken predicate (index or exemption) | Severity / condition | Healthy | Unknown | Retired | Interval | Fix href | View / repair |
|---|---|---|---|---|---|---|---|---|---|
| `huntress` | `huntress_integrations` | `is_active AND last_sync_status = 'error'` (partner axis) | transient `sync_failed` | `success` | `running`, null | inactive, deleted | 15 | `/integrations#huntress` | `organizations:read` / `organizations:write` |
| `sentinelone` | `s1_integrations` | `is_active AND last_sync_status = 'error'` (partner axis) | transient `sync_failed` | `success`, `partial` | `running`, null | inactive | 15 | `/integrations#sentinelone` | orgs |
| `pax8` | `pax8_integrations` | `is_active AND last_sync_status = 'failed'` (partner axis) | transient `sync_failed` | `success` | `running`, null | inactive | 60 (nightly sync) | `/integrations#pax8` | orgs |
| `unifi` | `unifi_integrations` | `is_active AND (status IN ('reauth_required','error') OR last_sync_status = 'failed')` (partner axis) | reauth → permanent `reauth_required`; else transient `sync_failed` | `connected` + `success`/`partial` | `pending`, never synced | inactive, deleted (disconnect deletes) | 30 | `/integrations#unifi` | orgs |
| `backup_provider` | `backup_provider_connections` | `is_active AND (status IN ('reauth_required','error') OR last_sync_status = 'error')` (partner axis) | reauth → permanent; else transient `sync_failed` | `success`, `partial` (partial = alert evaluation only, see amendments) | `running` (retry clears the error: §3 backup trap), null | inactive, deleted | 15 | `/integrations#backup` | `backup:read` / `backup:write` |
| `edr` | `edr_connections` | `is_active AND (status IN ('reauth_required','error') OR last_inventory_sync_status = 'error' OR last_detection_sync_status = 'error')` (partner axis) | reauth → permanent; else transient `sync_failed` | a stream `success`/`partial`, none `error` | a stream `running` with none `error`; both null | inactive, deleted | 15 | `/integrations#edr` | orgs |
| `accounting` | `accounting_connections` | `status IN ('reauth_required','disconnected','error')` (partner axis, one row per partner) | reauth / disconnected → permanent; `error` → transient | `connected` | `pending_tenant` (connect in progress; abandoned rows are deleted) | deleted | 15 | `/integrations#quickbooks` / `#xero` | `accounting:read` / `billing:manage` |
| `dns_filter` | `dns_filter_integrations` (org) | `is_active AND last_sync_status = 'error'` → **index** `dns_filter_integrations_sync_error_idx` | transient `sync_failed` | `success` | null | inactive, deleted | 15 | `/dns-security` | orgs |
| `m365_connection` | `m365_connections` (org axis only) | `org_id IS NOT NULL AND status IN ('degraded','suspended')` → **index** `m365_connections_unhealthy_idx` | `suspended`, and `degraded` with a consent code (`grant_missing`, `grant_unexpected`, `manifest_stale`, `application_token_invalid`, `tenant_mismatch`) → permanent; other `degraded` → transient. Condition = `last_error_code ?? status` | `active` | `pending-consent`, `verifying` | `revoked` (written only by disconnect), deleted, user-axis rows | 15 | `/integrations#m365` | orgs |
| `m365_sync` | `m365_sync_state` (org; one observation per **connection**) | `last_status IN ('needs_consent','error')` → **index** `m365_sync_state_unhealthy_idx (connection_id)` | any domain `needs_consent` → permanent `needs_consent`; else any `error` → transient `sync_failed` | every domain with a status `success`/`partial`/`throttled`, at least one `success`/`partial` | parent connection not `active` (its own incident covers it); no decisive domain | no rows (disconnect deletes them) | 60 | `/integrations#m365` | orgs |
| `ticket_mailbox` | `ticket_mailbox_connections` | `status IN ('reauth_required','error') OR (status = 'connected' AND consecutive_transient_failures >= 5)` (partner axis) | reauth → permanent `reauth_required`; `error` → transient `mailbox_error`; counter → transient `poll_failing` | `connected`, counter < 5 | `pending_consent` | `disabled`, deleted | 15 | `/settings/ticketing#email` | orgs |

Partner-axis tables grow with partners, not orgs (§1.3), so they are listed in the EXPLAIN test's exemption list instead of being indexed. Org-scoped sources (`dns_filter`, `m365_connection`, `m365_sync`) get `orgId` from their row and `partnerId` from `organizations`; all other W2 sources are partner-wide (`orgId: null`).

## Spec amendments made by this plan (fold into the spec in the plan commit)

- §3 `m365_connection`: `revoked` is written only by a deliberate disconnect, so it is `retired`, not broken. `suspended` has no writer today but stays broken/permanent. User-axis rows (`communications-delegated`) have no writer and are excluded.
- §3 `m365_sync`: one observation per connection (worst domain), and `unknown` while the parent connection is not `active`, so a degraded connection produces one incident, not one per domain.
- §3 backup: `partial` counts as healthy. It is written only when alert evaluation fails after a successful vendor sync, so the connection itself works.
- §3 accounting: `pending_tenant` is `unknown` (connect in progress); `disconnected` is never stored (a disconnect deletes the row), so in practice the source sees `reauth_required` and `error`.
- §3 ticket mailbox: `detail` is always null; `last_error` holds raw upstream text that the API deliberately never exposes.
- §1.2 reopen: a reopen inside the window is the **same episode**: it keeps `opened_at` and sends no new notice unless the severity escalates (goal 3). The window is `max(60 min, 2 × intervalMinutes)` so an hourly source's flap is still a reopen.
- §1.2 seeding: a kind seeds only when it has no incident rows; Redis decides only whether to *check* (key present → never seed). Redis unavailable → check rows (a first deploy during a Redis outage must not storm). Retention always keeps each kind's newest resolved row, so retention alone never empties a kind.
- §3 wording: "a disabled client is always retired" (not only when E exists).
- W1 plan Goal line: automatic revocation is refresh-token reuse only (code replay is W4).

## Carry-forwards from the W1 review

| # | Item | Disposition |
|---|---|---|
| 1 | Reopen sends a fresh notice on every flap | **Task 9**: same-episode reopen, no notice unless escalated; interval-scaled window |
| 2 | §1.1 source-coverage contract test | **Task 3** |
| 3 | Zero-recipient daily count (§8) | **Task 9**: Prometheus counter `breeze_connection_health_zero_recipient_incidents_total{source_kind}` (daily count = `increase(...[24h])`) plus `zeroRecipients` in the run summary log |
| 4 | Read route applies `LIMIT 500` before the permission filter | **Task 10**: permitted `view_permission` values go into the WHERE, then LIMIT; response carries `truncated` |
| 5 | Budget starvation | **Task 9**: due kinds run oldest `last-ok` first (never-run first), registry order breaking ties |
| 6 | Retention-emptied kind / lost Redis `seeded` key | **Task 9**: seed only with zero rows; retention keeps each kind's newest resolved row; Redis-down + zero rows seeds silently |
| 7 | Doc wording (disabled client, "code replay") | **Task 0** (this commit) |
| — | W1 deferred the `/admin/system` heartbeat display to W2 | **Deferred to W4** (missing signals / ops visibility); the heartbeat key is already written |

## Review Focus

1. **A connection flaps** (broken → healthy ×2 → broken within the window). Expect one notice for the whole episode. Test: Task 9 "reopen inside the window keeps opened_at and queues no notice".
2. **A hostile provider error** (URL with `?token=`, `Authorization: Bearer …`, a JWT, an email, 5 KB of HTML, control characters) lands in `last_sync_error`. Expect a ≤ 300-char detail with none of those. Test: Task 1 hostile fixtures.
3. **Backup retry clears the error** (`last_sync_status = 'running'`) on an open incident. Expect no healthy tick. Test: Task 2 `backupProviderHealth` running → unknown, and Task 5 integration case.
4. **A partner user with `selected` org access** opens the panel. Expect only covered orgs' incidents plus partner-wide ones they hold the view permission for, and a full page even when 500+ rows they cannot see exist. Test: Task 10 "limit applies after the permission filter".
5. **A new integration table is added without a source.** Expect the coverage contract to fail. Test: Task 3 coverage test lists an unknown table name in its failure message.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/services/connectionHealth/sanitize.ts` | `sanitizeHealthDetail()` |
| `apps/api/src/services/integrationStates.ts` | pure state functions: readiness-board functions (moved) + per-kind health functions |
| `apps/api/src/services/orgAccountReadinessIntegrations.ts` | re-exports the moved functions; loaders unchanged |
| `apps/api/src/services/connectionHealth/types.ts` | kinds appended; `HealthSource` gains `tables`, `fixHrefs`, `brokenQuery` |
| `apps/api/src/services/connectionHealth/sources/observeRows.ts` | shared broken ∪ tracked lookup, grace, observation builder |
| `apps/api/src/services/connectionHealth/sources/{huntress,sentinelOne,pax8,unifi,backupProvider,edr,accounting,dnsFilter,m365Connection,m365Sync,ticketMailbox}.ts` | one source each |
| `apps/api/src/services/connectionHealth/sources/index.ts` | registry + `SOURCE_COVERAGE_EXEMPTIONS` |
| `apps/api/src/services/connectionHealth/{transitions,store,reconcile,notifier}.ts` | Task 9 changes |
| `apps/api/src/services/connectionHealth/metrics.ts` | settable recorder + `registerConnectionHealthMetrics` |
| `apps/api/src/routes/connectionHealth.ts` | Task 10 |
| `apps/api/migrations/2026-12-29-190000-connection-health-source-indexes.sql` + `db/schema/{dnsSecurity,m365,m365Sync}.ts` | three partial indexes |
| `apps/web/src/components/integrations/ConnectionHealthPanel.tsx` (+ test) | the panel |
| `apps/web/src/components/integrations/IntegrationsPage.tsx`, `index.ts`, `ConnectorStatusPanel.tsx` (deleted), `locales/*/integrations.json` | mount, delete mock, strings |

---

### Task 0: Wave plan and doc corrections

- [ ] Commit this plan, plus spec §3 / §1.2 amendments above and the W1 plan Goal-line fix (`docs(connection-health): W2 wave plan …`).

### Task 1: `sanitizeHealthDetail()`

**Files:** Create `services/connectionHealth/sanitize.ts`; Test `services/connectionHealth/sanitize.test.ts`.

**Interfaces:** Produces `sanitizeHealthDetail(raw: unknown): string | null` and `HEALTH_DETAIL_MAX = 300`.

- [ ] **Step 1: failing tests** — `null`/`undefined`/non-string/whitespace-only → `null`; `https://api.example.com/v1/x?token=abc#f` → `https://api.example.com`; `Authorization: Bearer abc.def` and bare `Bearer abc123` → no `abc`; `api_key=SECRET1234`, `client_secret: "s3cr3t"` → no secret; a JWT `eyJhbGciOi….eyJzdWIi….sig` → absent; `ops@example.com` → `[email]`; control chars and newlines collapse to single spaces; a 5 KB string → length ≤ 300 and does not split a surrogate pair; idempotent (`s(s(x)) === s(x)`).
- [ ] **Step 2:** run, expect FAIL (module missing).
- [ ] **Step 3: implement** — order: strip C0/C1/bidi/zero-width (reuse the W1 character classes), URLs → `scheme://host`, `redactLogMessage` then `redactSecretsFromOutput` (logRedaction / secretRedaction), emails → `[email]`, collapse whitespace, trim, cap at 300 code points, empty → `null`.
- [ ] **Step 4:** PASS. **Step 5:** commit.

### Task 2: Shared integration state functions

**Files:** Create `services/integrationStates.ts` (+ `integrationStates.test.ts`); modify `services/orgAccountReadinessIntegrations.ts` (move pure functions `accountingConnectorState`, `activeRowConnectorState`, `parentMappingState`, `m365State`, `dnsState`, `pax8MappingState`, `worstState` and their types; re-export them so existing importers and `orgAccountReadinessIntegrations.test.ts` are untouched).

**Interfaces:** Produces
```ts
export type HealthVerdict =
  | { state: 'healthy' | 'unknown' | 'retired' }
  | { state: 'broken'; severity: 'permanent' | 'transient'; condition: string };
export function huntressHealth(r: { isActive: boolean; lastSyncStatus: string | null }): HealthVerdict;
export function sentinelOneHealth(r: { isActive: boolean; lastSyncStatus: string | null }): HealthVerdict;
export function pax8Health(r: { isActive: boolean; lastSyncStatus: string | null }): HealthVerdict;
export function unifiHealth(r: { isActive: boolean; status: string; lastSyncStatus: string | null }): HealthVerdict;
export function backupProviderHealth(r: { isActive: boolean; status: string; lastSyncStatus: string | null }): HealthVerdict;
export function edrHealth(r: { isActive: boolean; status: string; lastInventorySyncStatus: string | null; lastDetectionSyncStatus: string | null }): HealthVerdict;
export function accountingHealth(r: { status: string }): HealthVerdict;
export function dnsFilterHealth(r: { isActive: boolean; lastSyncStatus: string | null }): HealthVerdict;
export function m365ConnectionHealth(r: { status: string; lastErrorCode: string | null }): HealthVerdict;
export function m365SyncHealth(connectionStatus: string | null, domainStatuses: readonly (string | null)[]): HealthVerdict;
export function ticketMailboxHealth(r: { status: string; consecutiveTransientFailures: number }): HealthVerdict;
export const MAILBOX_TRANSIENT_FAILURE_THRESHOLD = 5;
```
Huntress/S1/Pax8 derive from `activeRowConnectorState([row], failedValue)` plus the running/null → unknown rule; accounting from `accountingConnectorState`; DNS from `dnsState`. Every table cell in "Sources (as built)" is one table-driven test row.

- [ ] Steps 1–5 (red: every row of the Sources table; green; commit).

### Task 3: Source contract, shared observer, coverage and fix-link contracts

**Files:** Modify `services/connectionHealth/types.ts`, `sources/oauthGrant.ts`, `sources/index.ts`; create `sources/observeRows.ts`; tests `sources/coverage.contract.test.ts`, `sources/fixLinks.contract.test.ts`, `sources/observeRows.test.ts`.

**Interfaces:**
```ts
// types.ts
export const CONNECTION_SOURCE_KINDS = ['oauth_grant','huntress','sentinelone','pax8','unifi','backup_provider','edr','accounting','dns_filter','m365_connection','m365_sync','ticket_mailbox'] as const;
export interface HealthSource {
  kind: ConnectionSourceKind;
  intervalMinutes: number;
  /** Connection tables this source covers (coverage contract, §1.1). */
  tables: readonly string[];
  /** Every fixHref / ownerFixHref this source can emit (fix-link contract). */
  fixHrefs: readonly string[];
  /** The broken-set query observe() runs; EXPLAINed by the index contract (§1.3). */
  brokenQuery(now: Date): SQL;
  observe(now: Date, trackedSourceIds: readonly string[]): Promise<HealthObservation[]>;
}
// observeRows.ts
export const ONBOARDING_GRACE_MS = 2 * 60 * 60 * 1000;
export function validUuids(ids: readonly string[]): string[];
export function applyGrace(v: HealthVerdict, createdAt: Date | null, now: Date): HealthVerdict;
export async function observeRows<Row>(opts: {
  now: Date; trackedSourceIds: readonly string[];
  broken: SQL | SQLWrapper; tracked: (ids: string[]) => SQL | SQLWrapper;
  sourceIdOf: (r: Row) => string;
  toObservation: (r: Row, now: Date) => HealthObservation;
}): Promise<HealthObservation[]>;
// sources/index.ts
export const SOURCE_COVERAGE_EXEMPTIONS: Readonly<Record<string, string>>; // table → reason
```
`observeRows` runs both queries via `db.execute`/builder, de-duplicates by source id, keeps broken or tracked observations only, and never swallows errors.

- [ ] **Step 1: failing tests**
  - coverage: enumerate every Drizzle table exported from `db/schema` whose name matches `/_(integrations|connections)$/`; each is in exactly one source's `tables` or in `SOURCE_COVERAGE_EXEMPTIONS` with a non-empty reason; no exemption names a table that does not exist or is also covered. Exemptions: `psa_connections` (no worker writes status), `partner_ai_connections` (AI gateway; W4 candidate), `td_synnex_*_integrations` ×3 (catalog feeds; W4 staleness), `google_workspace_connections` (W4 probe), `delegant_m365_connections` / `c2c_connections` (no failure column), `device_connections` (not an integration).
  - fix links: every `fixHrefs` entry starts with `/`, not `//`; its path resolves to `apps/web/src/pages/<path>.astro` or `<path>/index.astro`; its hash (if any) appears as a quoted literal in the page's hash owner (`/integrations` → `components/integrations/IntegrationsPage.tsx` or `lib/accountingProviders.ts`; `/settings/ticketing` → `components/settings/TicketingSettingsTabs.tsx`).
  - observeRows: drops healthy untracked rows, keeps healthy tracked rows, dedupes a row returned by both queries, skips the tracked query for an empty/non-UUID id list, rethrows a query error; `applyGrace` turns transient broken into unknown under 2h and leaves permanent alone.
- [ ] **Step 2:** FAIL. **Step 3:** implement; oauth gets `tables: ['oauth_grants']`, `fixHrefs: ['/settings/connected-apps','/account/connected-apps']`, `brokenQuery: brokenCandidatesQuery`. Update `connectionHealthOauthSource.integration.test.ts`'s registry assertion to `toContain`. **Step 4:** PASS. **Step 5:** commit.

### Task 4: Partner sync sources — Huntress, SentinelOne, Pax8

**Files:** `sources/huntress.ts`, `sources/sentinelOne.ts`, `sources/pax8.ts`, registry; test `sources/partnerSyncSources.test.ts` (row → observation fixtures with mocked `observeRows`/db).

Each source: `brokenQuery` = select `id, partner_id, name, is_active, last_sync_status, last_sync_error, created_at` with the Sources-table predicate; `toObservation` = `{Kind}Health` → `applyGrace` → observation with display name ("Huntress", "SentinelOne", "Pax8"), `detail = sanitizeHealthDetail(last_sync_error)` only when broken.

- [ ] Steps 1–5 (fixtures: broken row → full observation incl. hrefs/permissions; `running` → unknown; inactive → retired; new row (< 2h) failing → unknown).

### Task 5: UniFi, backup provider, EDR

Same shape as Task 4 (`sources/unifi.ts`, `sources/backupProvider.ts`, `sources/edr.ts`; test `sources/vendorSources.test.ts`). Backup/EDR display name is `cleanDisplayName(name, '<Vendor> backup' / edrProviderLabel(provider))`; EDR detail prefers the errored stream's text. Fixtures include the backup retry trap (`running` → unknown) and EDR reauth beating a stream error.

### Task 6: Accounting and ticket mailbox

`sources/accounting.ts` (fixHref by provider: `xero` → `#xero`, else `#quickbooks`; display "QuickBooks"/"Xero"; detail = sanitized `last_error`), `sources/ticketMailbox.ts` (display `Ticket mailbox <address>` capped by `cleanDisplayName`; detail always null; `orgId: null`). Test `sources/accountingMailboxSources.test.ts`.

### Task 7: Org sources + indexes — DNS, M365 connection, M365 sync

**Files:** `sources/dnsFilter.ts`, `sources/m365Connection.ts`, `sources/m365Sync.ts`; migration slot; schema files `db/schema/dnsSecurity.ts`, `m365.ts`, `m365Sync.ts` (matching `index(...).where(...)` so drift stays clean); test `sources/orgSources.test.ts`.

Indexes:
```sql
CREATE INDEX IF NOT EXISTS dns_filter_integrations_sync_error_idx
  ON public.dns_filter_integrations (id) WHERE is_active AND last_sync_status = 'error';
CREATE INDEX IF NOT EXISTS m365_connections_unhealthy_idx
  ON public.m365_connections (id) WHERE org_id IS NOT NULL AND status IN ('degraded','suspended');
CREATE INDEX IF NOT EXISTS m365_sync_state_unhealthy_idx
  ON public.m365_sync_state (connection_id) WHERE last_status IN ('needs_consent','error');
```
`m365_sync` aggregates per `connection_id`: the broken query selects distinct connection ids from the index, then one query loads all domain rows + the parent connection status + org/partner for those ids ∪ tracked ids. Detail = the broken domains' names plus the first sanitized `last_error`.

- [ ] Steps 1–5, then `pnpm db:check-drift` clean.

### Task 8: Real-DB contracts — EXPLAIN and per-source integration

**Files:** `__tests__/integration/connectionHealthSourceIndexes.integration.test.ts`, `__tests__/integration/connectionHealthSources.integration.test.ts`.

- EXPLAIN: for every source in `HEALTH_SOURCES`, inside a transaction with `SET LOCAL enable_seqscan = off`, `EXPLAIN` its `brokenQuery(now)`; fail if the plan has `Seq Scan on <t>` for any `<t>` in `PER_ORG_TABLES = ['oauth_grants','dns_filter_integrations','m365_connections','m365_sync_state']`; every table the plan scans sequentially must be in `PARTNER_AXIS_TABLES` (huntress, s1, pax8, unifi, backup, edr, accounting, ticket mailbox) — anything else fails, forcing classification.
- Per source, seed real rows and assert: broken row observed with the right `partnerId`/`orgId`; healthy untracked row not observed; tracked healthy row observed `healthy`; tracked deleted row absent; backup `running` → unknown; m365 sync with a degraded parent → unknown; one m365 sync observation per connection.

### Task 9: Reconciler — flap debounce, fair order, reseed, zero-recipient metric

**Files:** `transitions.ts`, `store.ts`, `reconcile.ts`, `notifier.ts`, new `metrics.ts`, `routes/metrics.ts` (register); tests `transitions.test.ts`, `reconcile.test.ts`, `metrics.test.ts`, `__tests__/integration/connectionHealthStore.integration.test.ts`, `connectionHealthNotifier.integration.test.ts`.

**Interfaces:**
- `TransitionAction` `reopen` gains `escalated: boolean`.
- `export function reopenWindowMs(intervalMinutes: number): number` = `max(REOPEN_WINDOW_MS, 2 * intervalMinutes * 60_000 + 5 * 60_000)` (types.ts).
- `planTransitions({ …, reopenWindowMs?: number })`; `loadTracked(kind, now, windowMs = REOPEN_WINDOW_MS)`.
- `deliverPendingNotices` returns `{ delivered, failed, zeroRecipients }`.
- `metrics.ts`: `setConnectionHealthMetricsRecorder`, `recordZeroRecipientIncident(kind: string)`, `registerConnectionHealthMetrics(registry)`.

- [ ] **Step 1: failing tests**
  - transitions: reopen of a transient incident with a permanent observation → `{ type:'reopen', escalated:true }`; a resolve 90 min ago with `reopenWindowMs: reopenWindowMs(60)` → reopen; default window still 60 min.
  - store (integration): "reopen inside the window keeps opened_at and queues no notice" (`openedAt` unchanged, `flapCount` 1, `pendingNotice` null, `notifiedUserIds` untouched); escalated reopen → `pendingNotice 'escalated'`; reopen while `pendingNotice='resolved'` → null (the episode's notices stay unread); `deleteExpiredResolved` keeps each kind's newest resolved row even when older than 90 days.
  - reconcile (unit): budget order — kinds with older last-ok (and never-run) run first; Redis `null` → seed candidate true (row check still decides); Redis key present → seed false; zero-recipient count appears in the summary.
  - notifier (integration): a zero-recipient incident increments the recorder once.
- [ ] **Step 2:** FAIL. **Step 3:** implement; `runKindInSystemScope` passes `reopenWindowMs(source.intervalMinutes)` to both `loadTracked` and `planTransitions`. **Step 4:** PASS (unit + the two integration files). **Step 5:** commit.

### Task 10: Read route filters before it limits

**Files:** `routes/connectionHealth.ts`, `routes/connectionHealth.test.ts`.

- [ ] **Step 1: failing tests** — the select's WHERE includes the permitted `view_permission` list (assert via the mocked query chain); a caller holding no permitted value gets `{ data: [], truncated: false }` without the row query; `truncated: true` when exactly 500 rows come back; system scope skips the permission filter.
- [ ] **Step 3:** first `selectDistinct({ p: view_permission })` under the same status WHERE (RLS-narrowed), keep those `hasPermission` grants, then `inArray(view_permission, allowed)` + order + `LIMIT 500`.

### Task 11: Connection Health panel; delete the mock

**Files:** Create `apps/web/src/components/integrations/ConnectionHealthPanel.tsx` + `.test.tsx`; modify `IntegrationsPage.tsx` (render above the tabs), `components/integrations/index.ts` (swap export); delete `ConnectorStatusPanel.tsx`; locales ×8 (`connectionHealthPanel.*` added, `connectorStatusPanel.*` removed), `humanizedKeyBaseline.json`.

Behavior: fetch `/connection-health/incidents?status=open` and `?status=recent` with `fetchWithAuth`; 401/403 → render nothing; other failure → a one-line error with Retry; open incidents listed (name, condition label with fallback, sanitized detail, "since <relative>", "Fix" link to `fixHref`, severity tone); recent resolutions in a collapsed section with count; empty → "All connections are healthy". `data-testid`s: `connection-health-panel`, `connection-health-open-row`, `connection-health-recent-toggle`, `connection-health-empty`.

- [ ] Tests (red first): renders rows + fix link; empty state; hidden on 403; error + retry; recent toggle; the mock file no longer exists (`import.meta.glob`). Then `npx vitest run src/components/integrations/ConnectionHealthPanel.test.tsx src/components/integrations/IntegrationsPage.test.tsx src/lib/i18n` and web `tsc`.

### Task 12: Verification

- API unit: `cd apps/api && npx vitest run src/services/connectionHealth src/services/integrationStates src/services/orgAccountReadinessIntegrations src/routes/connectionHealth src/jobs/connectionHealthReconcile` (check file counts).
- Integration (`pnpm test-stack up` … `down`): every `connectionHealth*.integration.test.ts`.
- `pnpm db:check-drift`; API and web `tsc --noEmit` (12 GB heap, check exit code).
