---
tracking_issue: LanternOps/breeze#11269
---

# Backup provider: Axcient x360Recover (design)

**Status:** APPROVED 2026-11-06 (Todd, defaults taken). Decision 1 (live account) is still owed and blocks W03 only.
**Date:** 2026-11-06
**Builds on:** `2026-09-15-backup-provider-integration-cove-design.md` (feature #6008, Cove phase 1) and `2026-10-27-backup-provider-dropsuite-design.md` (second adapter, feature #10598). The provider model, sync job, customer mapping, device matching, alerting, read model and portal surfaces all apply unchanged unless this document says otherwise.
**Scope:** Phase 1 only. Breeze reads x360Recover's per-device backup health for every client under the MSP and shows it everywhere Cove status already appears. Breeze writes nothing to Axcient.

## Problem

Axcient x360Recover is the BDR product a large share of US MSPs run: an on-site appliance per customer, or Direct-to-Cloud (D2C) agents with no appliance, replicating to an Axcient cloud vault. The Cove spec named the written order after Cove as "Veeam / Datto / Axcient later", and the 2026-09-12 reprioritisation brief records that the largest prospect in the pipeline keeps Axcient. An MSP running Breeze with x360Recover sees every Axcient-protected server as "unprotected" in `/backup`, on the device Backup tab, in the portal and in the posture report, and a failed Axcient backup never raises a Breeze alert. Technicians watch the x360Recover Manager or its health-status emails instead.

This is the third adapter on the backup-provider framework. Cove is the endpoint reference, Dropsuite the SaaS reference. Axcient is an endpoint provider like Cove, so it inherits device matching, device-level alerts and the "Protected devices" count directly.

## Is the API good enough?

**Yes for read-only status monitoring. Yes for a per-device "verified bootable" signal. No for retention evidence, webhooks or writes we would want.**

Source: the live OpenAPI document the Axcient developer portal loads, `https://developer.axcient.com/specs/x360Recover.yaml` (`info.version` 0.3.1, fetched 2026-11-06; Axcient never bumps the version field, so dated changes come from the x360Recover Manager release notes). Every claim below is from that document unless marked *inferred* or *not checked*.

| Need | Supported? | How |
|---|---|---|
| Authenticate | Yes | One static header, `X-Api-Key`. Keys are self-served by any administrator in x360Portal → Settings → API Keys, shown once, no documented expiry. Scope is per product checkbox (x360Recover, x360Cloud, x360Sync, Billing), not read/write. |
| Base URL | Yes | `https://axapi.axcient.com/x360recover`. One production host; no EU or regional host is documented. *Not checked:* whether EU-hosted partners use the same host. A WireMock mock server exists for fixture capture. |
| Partner root | Yes | `GET /organization` returns `id`, `name`, `active`. |
| List customers | Yes | `GET /client` returns `id`, `name`, `client_code`, `active`, `health_status` (`NORMAL`, `WARNED`, `TROUBLED`, `UNPROTECTED`, `PARKED`) and `devices_counters { appliance_based, d2c, cloud_archive }`. |
| Devices per customer | Yes | `GET /client/{client_id}/device`. Fields that matter: `id`, `name` (hostname), `type` (`SERVER`, `WORKSTATION`, `NAS`, `ARCHIVE`), `os { os_type, os_name }`, `agent_version`, `mac_address`, `ip_address`, `local_ps_id` (machine UUID), `d2c`, `current_health_status { status, reason, timestamp }`, `latest_local_rp`, `latest_vault_rp`, `latest_cloud_rp`, `local_usage`, `vault_usage`, `cloud_usage`, `vaults[]`, `jobs[]`, `latest_autoverify_details`, `device_details_page_url`. |
| Fleet list | Yes | `GET /device?limit&offset`, capped at 500 per request since Manager 7.00 (Dec 2025). Not used in phase 1; per-customer calls give per-customer failure isolation. |
| Job history | Partly | `GET /client/{c}/device/{d}/job/{j}/history` with `status`, `start_time`, `end_time`, `rp`, `error_msg`, `bytes_delta`. Community reports it "occasionally nonfunctional". Not load-bearing in phase 1. |
| Verified bootable | Yes | `latest_autoverify_details { status: success/failure, is_healthy, rp, screenshot_url, check_disk, heartbeat, start_vss, system_boot }` (per-check results since Manager 7.07, May 2026). `status` means the check ran; `is_healthy` means it passed. |
| Appliances and vaults | Yes | `GET /appliance`, `GET /vault` with `tunnel_status` (`UP`/`DOWN`), `storage_details`, `health_status`, `health_status_reason`. Phase 2 (see below). |
| Retention | **No** | No retention field or endpoint. |
| Deep link | Partly | `device_details_page_url` is a plain Manager URL (`<manager-host>/home/device/{id}`); it needs a logged-in Manager session, mints nothing. No per-client link, no SSO handoff. |
| Writes | Effectively none | Only `POST /vault/{id}/threshold/connectivity` and `POST …/d2c_agent` (mints a D2C install token). Both are excluded; the adapter only ever issues GET. |
| Webhooks or push | **No** | Polling only. Backup Radar, Rewst and Liongard all poll. |
| Rate limits | **Not documented** | Must be learned on a live account. The client backs off on 429 and `Retry-After` regardless. |
| Pagination | Offset | `limit`/`offset`, bare arrays, no envelope and no total. Page until a short page. |
| Error shapes | Inconsistent | Bad key → `401 {"message":"Unauthorized"}`. Unknown route or a non-numeric path id → also `401 {"code":401,"msg":"Unauthorized"}`, not the documented 400. 403 → `{"type":"ForbiddenException", …}` when the key lacks a product scope. 404 is `application/problem+json`. |
| Spec bugs | Known | The OpenAPI declares `/client`, `/appliance` and `/vault` as single objects; the live API returns arrays. Fixtures use the live shape. |

Related, out of scope: **x360Cloud** (Microsoft 365 / Google Workspace) has its own API at `/x360cloud` on the same host with the same key, with `backup_status` per client (`Successful`, `Failed`, `Partial`, `InProgress`, `Unavailable`, `Onboarding`) and a different client id space. It is a SaaS adapter in the Dropsuite shape and gets its own spec. x360Sync has only the legacy Anchor API and is not planned.

### Live verification: not yet done

We hold no Axcient partner account. Fixtures for W01 are built from the OpenAPI examples and the WireMock mock server, then replaced with scrubbed captures once an account exists (a trial, or a design partner's read-only key; see Decision 1). The traps the Dropsuite run taught (envelope shape changed by a query parameter, id field renamed per workload) argue for a live smoke before W02, not after.

## Goals

- An Axcient partner connection on Integrations → Backup, with one API key, that syncs every client and device under the MSP on the existing 30-minute default.
- Axcient devices appear as endpoint rows: matched to Breeze devices by hostname and MAC, counted as protected, alerting on the device when health degrades or the last recovery point goes stale.
- Posture and backup reports show Axcient evidence the same way they show Cove evidence, plus a "verified bootable" column where AutoVerify data exists.
- A key with the wrong product scope fails setup with a message that says which checkbox to tick.

## Non-goals

- Writes of any kind, including vault thresholds and D2C install tokens.
- x360Cloud, x360Sync, appliance and vault inventory as first-class rows (phase 2).
- Job-level history or per-job rows. The device is the unit, as with Cove.
- Restore, screenshot display, or opening the Manager from Breeze (phase 2).

## Design

### Connection and credentials

- Provider key `axcient`, label **"Axcient x360Recover"**, `inventoryKind` omitted (endpoint), `defaultSyncIntervalMinutes: 30`, `rootContinuity: 'root_id'`.
- `credentialsSchema = z.object({ apiKey: z.string().trim().min(1) }).strip()`. Stored through the existing row-bound encryption.
- `defaultBaseUrl = 'https://axapi.axcient.com/x360recover'`; `validateBaseUrl` requires https and a host under `axcient.com` so a future regional host is a form change, not a code change. The form does not show the base URL field for Axcient (same as Cove).
- `testConnection` calls `GET /organization` then `GET /client`. Success returns `rootId = organization.id`, `rootName = organization.name`, `customerCount = clients.length`. 401 → `{ ok: false, reauth: true, error: "Axcient rejected the API key." }`. 403 with `ForbiddenException` → `{ ok: false, reauth: true, error: "This key is missing a product scope. Edit it in x360Portal → Settings → API Keys and enable x360Recover and Billing." }` (Liongard reports x360Recover calls 403 unless Billing is also ticked; the message names both until live verification says otherwise.)
- Every request goes through `safeFetch`, as the other clients do. The client sends no body on any request.

### Customers

`GET /client` → one `VendorCustomer` per client: `vendorCustomerId = String(id)`, `name`, `parentId = null`, `level = 0`, `externalCode = client_code`. `client_code` is an Axcient short code, not a UUID, so the existing `auto_external_code` rule never fires and mapping is manual with name suggestions, as for Dropsuite. Inactive clients (`active: false`) are still listed so a technician can see and deliberately unmap them; their devices are fetched like any other.

### Devices

`GET /client/{id}/device` per mapped and unmapped customer, concurrency 2, each customer isolated: a per-customer failure lands in `failedCustomerIds` and the customer's stored rows are kept. A 401 on any call is `reauth` and fails the whole run. If every customer fails the run throws `all_customers_failed`, as Dropsuite does.

| `VendorDevice` field | Source |
|---|---|
| `vendorDeviceId` | `String(id)` |
| `vendorCustomerId` | `String(client_id)` |
| `name`, `computerName` | `name` |
| `osType` | `type`: `SERVER` → `server`, `WORKSTATION` → `workstation`, `NAS`/`ARCHIVE`/other → `unknown` |
| `osVersion` | `os.os_name` |
| `clientVersion` | `agent_version` |
| `macAddresses` | `[mac_address]` normalised (lower-case, colon-separated), empty when absent |
| `accountType` | `backup_manager` |
| `dataSources` | `['image']` (x360Recover is image-level; the contract's vocabulary describes what is backed up, not where). New locale key `backupHealth.dataSource.image` in all eight locales. D2C versus appliance and vault membership live in `raw` |
| `status`, `vendorStatusCode` | see [Status mapping](#status-mapping); `vendorStatusCode = null` (health is a string) |
| `verifiedBootable` (new, optional) | `{ at: latest_autoverify_details.end_timestamp, healthy: is_healthy, failedChecks: [...] }` when the device has an AutoVerify result; see [Verified-bootable evidence](#verified-bootable-evidence) |
| `lastSuccessAt` | max of `latest_local_rp`, `latest_vault_rp`, `latest_cloud_rp` (ISO 8601 `Z`) |
| `lastSessionAt`, `lastCompletedAt` | same value as `lastSuccessAt`; Axcient exposes no session concept at device level, and job history is unreliable |
| `selectedBytes` | `local_total` when present, else null |
| `usedBytes` | `d2c` ? `cloud_usage` : `local_usage` |
| `errorsCount` | 0 when `current_health_status.status` is `NORMAL`, else 1 |
| `vendorCreatedAt`, `vendorExpiresAt` | null |
| `raw` | the device object minus `jobs[]`, `volumes[]`, `excluded_volumes[]`, `vaults[]` (bulk), keeping `current_health_status`, `previous_health_status`, `thresholds`, `latest_autoverify_details` (minus screenshot URLs, which are signed), `device_details_page_url`, `local_ps_id`, `local_cache_details` |

Nothing in an x360Recover response is a credential, but `screenshot_url` and `screenshot_thumbnail_url` are presigned links and are dropped before persistence.

### Status mapping

Axcient reports a health verdict per device, not a last-job result. The map is verdict first, then reason, then recency:

| `current_health_status.status` | reason | canonical status |
|---|---|---|
| `NORMAL` | any | `completed` |
| `WARNED` | any | `completed_with_errors` |
| `TROUBLED` | `OFFSITE_NEVER_RUN`, or all three `latest_*_rp` null | `no_backups` |
| `TROUBLED` | `SCHEDULE_DISABLED` | `no_selection` |
| `TROUBLED` | anything else | `failed` |
| `PARKED` | any | `paused` (new canonical value, see below) |
| `UNPROTECTED` | any | `no_backups` |
| missing or unrecognised | any | `unknown` |

**`paused` is a new canonical status.** Cove maps its `NotStarted` session code and Dropsuite maps disabled or empty customers to `not_started`, and both should keep alerting when that state persists, because for them it means a backup that never ran. Axcient `PARKED` means an operator deliberately stopped protecting the device, which is a different fact. Overloading `not_started` would force a global alert exclusion that silences Cove and Dropsuite, so instead the `external_backup_status` enum and `EXTERNAL_BACKUP_STATUSES` gain `paused` (severity 25, between `unknown` and `not_started`; health derives as `warning` regardless of recency; bucketed with `not_started` and `unknown` in the "other" group; never raises an alert). The enum value is added with `ALTER TYPE … ADD VALUE IF NOT EXISTS` in its own migration, separate from the column migration, because a new enum value cannot be used in the transaction that adds it (house precedent: `2026-10-26-170000-ticket-checklist-operator-task-source.sql`, no `@no-transaction` directive).

Reasons are strings and the documented list is not closed (the spec example says `APPLIANCE_OFFLINE`, the help centre says `APPLIANCE_OFFLINED`), so the map treats an unrecognised reason as "anything else" and never throws. AutoVerify does **not** change `status` in phase 1: a device whose backups run but whose last boot check failed stays `completed`, and the failed check is surfaced as evidence (below) rather than as a backup failure. That keeps the Axcient health light and the Breeze status in agreement, which is what a technician checking both consoles expects.

Staleness uses the existing 48-hour rule on `lastSuccessAt`. Axcient's own `thresholds.*_rp_threshold` per device is stored in `raw` and not used; one rule across providers is simpler to explain, and phase 2 can honour the vendor threshold if partners ask.

### Verified-bootable evidence

This is the one place Axcient adds a concept Cove lacks. `vendor_raw` is `excludedOpen` in the export policy and is not selected by the device route, so the signal is not read from raw at render time. Instead:

- `VendorDevice` gains an optional `verifiedBootable: { at, healthy, failedChecks }`; `backup_provider_devices` gains three nullable columns (`verified_bootable_at timestamptz`, `verified_bootable boolean`, `verified_bootable_failed_checks text[]`) via one migration, with export-policy classification `open`. Cove and Dropsuite leave them null.
- `/backup/providers/devices` and the shared `ProviderDeviceRow` type carry the three fields; the device Backup tab external card shows "Last boot check: passed 2026-11-05 03:12 UTC" / "failed (system_boot)" / "never run".
- `BackupHealthRow` carries them too, so `/backup` and the backup status report show a "Verified bootable" column that renders "n/a" for providers that do not supply it.
- The posture report is **not** changed in phase 1. Its backup evidence is an aggregate per product (`securityComplianceReportBackupProviders.ts`), and its `backups_verified` control counts only first-party verifications. Feeding AutoVerify into that control changes a customer-facing control's meaning and is Decision 7.

### Sync, matching, alerts

Device matching is the existing hostname-then-MAC path, on the assumption that `name` is the agent hostname (the OpenAPI describes it only as "Name of the device"; third-party integrators treat it as hostname, *inferred*). If W03 shows `name` is an operator-editable label, matching on `local_ps_id` against the agent-reported machine UUID moves from phase 2 into W03. `local_ps_id` is kept in `raw` either way.

Alerts are device-level through the existing conditions; `failed`, `no_backups`, `no_selection`, `completed_with_errors` and `stale` all arise from the table above. One evaluator change: **`paused` raises no condition, including `stale`.** A parked server still renders as uncovered in `/backup` and in the portal; it just does not page anyone. Cove and Dropsuite behaviour is unchanged. The alert label comes from the adapter label.

### Surfaces

All exist for Cove. Work is limited to:

- **Integrations → Backup:** a third `<option>`, a one-field credential form (API key) with help text pointing at x360Portal → Settings → API Keys and the two checkboxes. The hard-coded `provider === "dropsuite"` ternaries in `BackupProvidersIntegration.tsx` **and** the rotate-credentials form in `BackupProviderConnectionCard.tsx` (which today posts Cove's three fields for any non-Dropsuite provider, so an Axcient key could never be rotated) become one per-provider form descriptor shared by both, so the fourth adapter is a data change. The customer-mapping table's existing ternaries fall through correctly for an endpoint provider and are untouched.
- **Device tab external card and `/backup`:** the boot-check fields above (route, shared type, card, health row, backup status report).
- **Docs:** `apps/docs/src/content/docs/backup/backup-providers.mdx` gains "Connecting Axcient x360Recover"; sidebar label becomes "Backup Providers (Cove, Dropsuite, Axcient)".
- **Locales:** every new key in all eight locales.

### Tenancy

No new tables. `provider` is a varchar and `account_type = 'backup_manager'` already exists. Two migrations, named to sort after the newest shipped migration: one file adding the `paused` enum value, and one adding the three nullable `verified_bootable*` columns to `backup_provider_devices`, with the export-policy entries in the same PR; then `pnpm db:check-drift`. The RLS integration test that compares `EXTERNAL_BACKUP_STATUSES` with `pg_enum` pins the order. RLS, cascade and export registration from #6008 cover every row.

## Testing

- Adapter unit tests from fixtures: the status map including every documented reason and `PARKED` → `paused`, unrecognised reason and missing health; `osType` for all four `type` values; `lastSuccessAt` as max-of-three with nulls; D2C versus appliance `dataSources`; screenshot-URL scrub; array-not-object responses for `/client`.
- Error classification: 401 → `reauth`; 403 `ForbiddenException` → `reauth` with the scope message; per-customer 5xx → `failedCustomerIds`, rows kept; 429 → retry; the "401 for a non-numeric id" quirk never classifies as reauth when the id came from our own data (ids are numeric by construction, asserted in a test).
- `registry.test.ts` and `routes/backup/providers.test.ts` provider-key lists gain `axcient`.
- Client unit tests against a fake Axcient HTTP server (the Dropsuite `client.test.ts` pattern): pagination to a short page, the array-not-object shapes, the error bodies above.
- Integration: the `backupProviderSync.integration.test.ts` pattern (adapter stubbed) with an Axcient-shaped adapter stub, asserting that a matched server flips a Breeze device to protected, that a `TROUBLED` device raises a device alert on the second poll, and that a `PARKED` device raises nothing; RLS check extended with the new key; export-policy contract for the new columns.
- Read model: the verified-bootable fields are null for Cove rows and set for an Axcient row with `is_healthy: true`.
- Web: the per-provider form descriptor renders the right fields for all three keys; locale coverage test.

## Rollout

1. **W01, adapter + client + registry + credentials + migrations:** fixtures from the OpenAPI examples and WireMock, status map, scope-error message, per-customer isolation, the `paused` status and the `verified_bootable*` columns with persist, the `paused` evaluator exclusion. API-only.
2. **W02, surfaces:** form descriptor refactor (create + rotate) and Axcient form, boot-check fields on the device route, card, health row and backup status report, docs, locales.
3. **W03, live verification** against a real account: rate-limit discovery, the 403/Billing-scope claim, real `device_details_page_url` host, timestamp timezone, and the `/device` 500 cap; replace fixtures with scrubbed captures; release notes.

W03 is blocked until Decision 1 is resolved. W01 and W02 are not.

## Decisions

All resolved as the defaults below on 2026-11-06, except decision 1, which is owed before W03.

1. **Live account.** Options: (a) an Axcient partner trial under OliveTech; (b) a read-only key from the prospect that keeps Axcient, as a design-partner arrangement; (c) ship on fixtures and verify with the first real partner connection. **Recommend (a), fall back to (b).** Shipping unverified repeats the Cove visa mistake, where the integration never worked against the real API until a customer hit it.
2. **Inactive clients are listed** (`active: false`), not filtered. Resolved as the default: hiding them silently would make a parked customer look like a sync bug.
3. **AutoVerify does not affect `status`**; it is evidence only. Resolved as the default (reasoning above). Revisit if partners want "backups succeed but won't boot" to alert.
4. **Vendor per-device thresholds are ignored** in favour of the global 48-hour stale rule. Resolved as the default.
5. **Both product scopes named in the 403 message** (x360Recover and Billing) until W03 proves whether Billing is really required.
6. **The form refactor (per-provider descriptor) happens in W02**, not as a separate PR, and covers both the create form and the connection card's rotate form. Posted bodies are unchanged and covered by the existing route tests.
7. **Posture `backups_verified` control stays first-party only in phase 1.** Counting Axcient AutoVerify passes there would change what a customer-facing control means. Default: not in phase 1; the backup status report column is where the evidence shows. **Todd's call** whether to widen the control.
8. **Parked devices get a new `paused` status and do not alert.** They still show as uncovered. Chosen over excluding `not_started` from `stale`, which would have silenced Cove `NotStarted` and Dropsuite disabled customers too.
9. **Hostname matching ships on the `name` = hostname assumption**; `local_ps_id` matching is pulled into W03 only if live verification disproves it.

## Phase 2

- **Appliance and vault health** as org-scoped rows: `tunnel_status: DOWN`, `FULL_80_PERCENT`/`FULL_90_PERCENT`, `OUTDATED_SOFTWARE`. Needs the org-level alert record that the Dropsuite follow-up already owes (`createSourcedAlert` requires a device today).
- **"Open in x360Recover Manager"** from the device card, using `device_details_page_url`. It is a plain URL, so a permission gate is enough; no step-up, no audit entry.
- **x360Cloud adapter** (SaaS) as its own spec, with the x360Cloud client-id space mapped separately.
- **Honour vendor RP thresholds** per device for staleness.
- **Match on `local_ps_id`** against the agent's reported machine UUID when hostname matching is ambiguous.
- Job-level history for a "last 7 runs" sparkline, once the history endpoint is reliable.
