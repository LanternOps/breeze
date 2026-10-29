# Backup provider: Dropsuite / NinjaOne SaaS Backup (design)

**Status:** DRAFT, not yet approved. Open decisions are in [Open decisions](#open-decisions).
**Date:** 2026-10-27
**Builds on:** `2026-09-15-backup-provider-integration-cove-design.md` (feature #6008, Cove phase 1). That spec's provider model, sync job, mapping, alerting and portal surfaces all apply here unchanged unless this document says otherwise.
**Scope:** Phase 1 only. Breeze reads Dropsuite's SaaS backup status for each customer and shows it everywhere Cove status already appears. Breeze writes nothing to Dropsuite.

## Problem

NinjaOne bought Dropsuite in 2025 and sells it as **NinjaOne SaaS Backup**. It backs up Microsoft 365 and Google Workspace: mail, OneDrive, SharePoint, Teams/Groups, Google Drive and shared drives. MSPs use it alongside, or instead of, the RMM they run. An MSP running Breeze with Dropsuite cannot see in Breeze whether a customer's mailboxes are being backed up. The customer posture report has the same gap (`docs/superpowers/specs/reports/2026-07-14-posture-backup-evidence-design.md`), and that spec names "a real Cove/Dropsuite integration" as one way to close it.

## Is the API good enough?

**Yes for read-only status monitoring. No for anything beyond that.**

Source: the Dropsuite help article "API Settings" (help.dropsuite.com, article 20422080552855, updated 2026-05-15) and the attached PDF, *REST API — for subreseller v1.00* (2024, 58 pages). The PDF is downloadable without logging in. Every claim below comes from that PDF unless it is marked *inferred* or *not checked*.

| Need | Supported? | How |
|---|---|---|
| Authenticate | Yes | Two static headers: `X-Reseller-Token` (partner-wide) and `X-Access-Token`. API URL and tokens are on the partner portal's API Settings page. The host is regional (`*.dropmyemail.com/api/`). |
| List customers | Yes | `GET /users` with the reseller **admin** token returns every tenant organization: `id`, `email`, `organization_id`, `external_id`, seats, storage, `customer_deactivated`, `flg_suspended`, and that organization's own `authentication_token`. |
| Customer name | Partly | `organization_name` appears only in the `GET /users/{id}` sample, not in the `GET /users` list sample. *Not checked:* whether the list returns it too. |
| Status per mailbox | Yes | `GET /accounts` returns `last_backup`, `current_backup_status`, `errors`, `deactivated_since`, `storage`, `msg_count`. `/deactivated_accounts` and `/deleted_accounts` cover the inactive buckets (`/connection_failures` is forbidden for sub-resellers; see below). |
| Status for OneDrive, SharePoint, Teams, shared drives, Google Drive | Yes | `/onedrives`, `/sharepoints/domains` → `/{id}/sites`, `/teams_and_groups/domains` → `/{id}/teams`, `/shareddrives/domains` → `/{id}/drives`, `/googledrives`. Each item has `last_backup` and `errors`, and most have `current_backup_status`. |
| Tenant domains | Yes | `GET /users/{id}/tenants` returns `domain`, `type` (`m365`/`gws`), `total_users` and a numeric `status`. |
| Retention | Yes | `GET /users/{id}/retention_policies`. |
| Deep link into the vendor console | Yes | `GET /users/{id}/generate_sso_link` mints a single-use login URL that expires after 30 minutes. |
| Health check | Yes | `GET /status` with the reseller token returns `"OK"`. |
| Writes (provision, licensing, restore) | **No** | The article says sub-partners and resellers get GET calls only. Write calls need a Direct Partner or Distributor account. Phase 1 needs no writes. |
| Webhooks or push | **No** | Polling only. |
| Rate limits | **Not documented** | Must be learned on a live account. The adapter backs off on 429 and `Retry-After` anyway. |
| Status vocabulary | **Not documented** | The samples show only `Completed`, `Running` and `Preparing Backup`. Shared drives and tenants use undocumented integer codes. The `backup_status` filter parameter exists but its accepted values are not listed. |
| Pagination | Inconsistent | Most lists return 25 items per `page`. The `/users/{id}/…` endpoints take `per_page` (maximum 100) and return a `pagination` envelope. *Not checked:* whether `/accounts` pages at all. |

Third parties already integrate on this API in read-only mode: Rewst, Backup Radar, SuperOps, and an MSPbots MCP server. That suggests the surface is stable enough to build on (*inferred*).

### Live verification (2026-10-27, our Pax8 sub-reseller account, GET only)

We ran every endpoint the adapter needs against our own partner account: 13 customers, about 140 seats, 143 requests in 72 s sequentially (about 0.5 s per request). **The 2024 PDF is accurate for every endpoint we use.** It is wrong or silent on the points below, and the live behaviour overrides it:

| Finding | Detail | Consequence |
|---|---|---|
| Per-customer token works | The `authentication_token` on each `GET /users` row works as that customer's `X-Access-Token`. | **Verified.** The design holds. |
| Admin token cannot read workloads | With the admin token, `/accounts` returns `[]` and `/users/{id}/tenants` returns 401. | Every workload call and every tenants call **must** use the customer's own token. |
| Two response shapes | With no `page` param the endpoints return a bare array. With `page` they return `{result_set, pagination:{current_page, per_page:100, total_entries, total_pages}}`. | The client always sends `page` and reads `result_set`, so it never silently treats the envelope as "zero items". That mistake produced a false "all empty" result in our first run. |
| `page` ignored on some endpoints | `/accounts/deactivated_accounts` and `/googledrives` return the same list for every page. | Fetch them once with no `page`. If the first item repeats across pages, stop and use what was fetched. |
| `/accounts/connection_failures` is forbidden | It returns 400 "not authorized" for a sub-reseller. | Do not use it. Connection failure is read from `current_backup_status`. |
| `/accounts` includes deactivated items | 108 of 300 mailboxes had `deactivated_since` set. **Every** failing or stale item in our data was a deactivated one. | Filtering out deactivated items is **load-bearing**. Without it our own fleet would show about 240 false failures. |
| Status vocabulary | Mail: `Completed`, `Connection Failed`, `Authentication Error`. OneDrive: `Completed`, `Unknown`, `System Error`, `Authentication Error`. SharePoint: `Completed`, `Preparing Backup`, `Connecting`. Teams: `Completed`, `Connecting`. Google Drive has **no** `current_backup_status`; it has an integer `status` (`7`, `10`). | See the status mapping below. |
| `errors` shape varies | It is an object on `/accounts` (`{}` when empty, `{"host": "…"}` when set) and a string elsewhere. On Google Drive it is a free-text string, sometimes JSON-encoded, often containing vendor-internal details. | Normalise all three shapes. Never show Google Drive `errors` text to customers; keep it only in `raw` for the MSP. |
| Teams freshness | 17 of 105 active teams had `Completed` but a `last_backup` older than 48 h. | Teams appear to back up only when something changes (*inferred*). They get a longer staleness threshold, or none. |
| Tenants | `type` is `m365` or `gws`. `status` was `7` for 12 tenants and `0` for 1. | `7` probably means active (*inferred*). The adapter treats tenant `status` as informational only. |
| Rate limits | No rate-limit headers were returned and nothing was throttled at about 2 requests per second. | Back off on 429 anyway. |
| `backup_summary` | `null` for every customer. | Ignore it. |
| Third secret token | The portal now issues an extra "secret" token. Every endpoint we use works without it, and sending it changes nothing. | Not collected. If a later API version requires it, it becomes an optional credential field. |

## Goals / Non-goals

**Goals (phase 1)**
- Add a `dropsuite` adapter behind the existing `BackupProviderAdapter` interface, plus one line in `registry.ts`.
- Map Dropsuite customers to Breeze orgs using the existing mapping flow (auto by `external_id`, manual otherwise, name match suggested only).
- Show each mapped org's SaaS backup status, split by workload (mail, OneDrive, SharePoint, Teams/Groups, Google Drive, shared drives), in every place Cove status shows today: Integrations → Backup tab, the org backup view, the portal, the backup status report, and the posture report's backup evidence.
- Alert through the existing two-poll hysteresis when a workload fails, goes stale or loses its connection. Publish the existing `backup.provider_device_unhealthy` / `_recovered` events.
- Keep SaaS protection **out of endpoint counts**. A protected mailbox must never count as a protected device.

**Non-goals (phase 1)**
- No writes: no provisioning, seat or licence changes, retention edits or restore triggers. Our access tier cannot make them anyway.
- No matching of SaaS items to Breeze devices. `breeze_device_id` stays null for every Dropsuite row.
- No Archiver or journaling features (`/journals`, `/ndr_journals`).
- No SSO "Open in Dropsuite" button. That is phase 2; see [Phase 2](#phase-2).
- No change to Breeze's own C2C backup (`c2c.ts`). Dropsuite is a third-party product reported next to it.

## Design

### Connection and credentials

A Dropsuite connection is one row in `backup_provider_connections` (`provider = 'dropsuite'`, partner axis, RLS shape 3), the same as Cove.

```ts
credentialsSchema = z.object({
  resellerToken: z.string().uuid(),
  adminAuthToken: z.string().min(16),   // reseller "Admin Token"
});
baseUrl: required, chosen from a fixed list of regional hosts, validated against an allowlist (no free-text URL → no SSRF)
```

- Credentials are sealed with the existing row-bound AAD (`backupProviderConfigSealing`). They are never logged and never returned.
- **Per-customer tokens are never persisted.** Each sync calls `GET /users` with the admin token, holds each organization's `authentication_token` in memory for that run only, and drops it afterwards.
- **`vendor_raw` scrubbing is mandatory.** `GET /users` and `GET /accounts` both embed `authentication_token` and `reseller_token` in their responses, nested under `user` on accounts. The adapter must delete every key matching `/token/i` at any depth before building `raw`. A unit test feeds a fixture that contains tokens and asserts that no persisted value contains any token string. Without this, every customer's Dropsuite login token lands in a jsonb column readable by the partner, and from there in exports.
- `testConnection` calls `GET /status` to check reachability, then `GET /users` to prove the admin token works. It returns `rootId` = the reseller identity (from `reseller_token`; *inferred*, confirm live), `rootName` = the connection name, and `customerCount`. A 401 or 403 sets `reauth: true`. 5xx responses and timeouts set `reauth: false`.

### Customers

`listCustomers` → `GET /users` (admin token), one `VendorCustomer` per tenant organization:

| VendorCustomer | Dropsuite |
|---|---|
| `vendorCustomerId` | `id` (string, for example `"26561-14"`) |
| `name` | `organization_name`, else `email` (see the gap above) |
| `parentId` | `null`, because Dropsuite's tree is flat below the reseller |
| `level` | `"business"` / `"personal"` from `is_business` |
| `externalCode` | `external_id`, which the existing auto-mapper reads a Breeze org id from |

Deactivated or suspended customers (`customer_deactivated`, `flg_suspended`) are still listed so that mapping survives. Their workloads report `not_started` and raise no alert.

**Optional auto-map suggestion (decide in review):** match tenant domains from `GET /users/{id}/tenants` against `sso_verified_domains`, and against Breeze's own M365/C2C tenant domains where they exist. This would only *suggest* a mapping, never write one. The mapper's rule already says a name match is never auto-written, and the same reasoning applies to a domain match.

### Protected items: granularity (key decision)

The `backup_provider_devices` model is device-shaped. Cove fits it naturally because one Cove M365 domain is one row. Dropsuite reports **per item**: per mailbox, per OneDrive, per site, per team. A 300-seat customer has about 700 items, so a partner with 50 such customers has about 35k items.

**Recommended: one row per (customer, workload)**, which is about 6 rows per customer.

| VendorDevice field | Value |
|---|---|
| `vendorDeviceId` | `${vendorCustomerId}:${workload}`, for example `26561-14:m365_mail` |
| `name` | for example "Microsoft 365 mail (412 mailboxes)" |
| `accountType` | `m365` or `gws` (**new value `gws`**; the column is varchar, so this is a TS union widening plus the shared type, with no migration) |
| `dataSources` | `[workload]`: one of `m365_mail`, `m365_onedrive`, `m365_sharepoint`, `m365_teams`, `gws_mail`, `gws_drive`, `gws_shared_drive` |
| `status` | the worst item status under `EXTERNAL_BACKUP_STATUS_SEVERITY` |
| `lastSuccessAt` | the **oldest** `last_backup` among active, non-deactivated items. The workload is only as fresh as its stalest mailbox. |
| `lastSessionAt` | the newest `last_backup` |
| `usedBytes` | the sum of `storage` |
| `errorsCount` | the number of items with non-empty `errors`, plus connection failures |
| `osType` / `macAddresses` / `computerName` | `unknown` / `[]` / `null` |
| `raw` | (scrubbed) counts by status, plus **up to 50 failing or stale items** (name, email, status, `last_backup`, error text), so the UI can say *which* mailbox is failing |

Why rollup rather than per-item rows:
1. **Alert noise.** A revoked admin consent fails every mailbox at once. Per-item rows would raise 412 alerts and 412 webhook events. Per-workload rows raise one.
2. **Row volume and sync cost.** About 6 rows per customer instead of about 700 keeps the upsert and delete-vanished transaction the same size as Cove's.
3. **It fits the existing UI.** Every surface already renders "a protected thing with a status". A per-mailbox grid is a new UI, and the MSP fixes mailboxes in Dropsuite anyway.

The cost: per-mailbox history and a per-mailbox alert are not available in Breeze. The capped failing-item list in `raw` covers the "which one?" question. If that proves insufficient, a child table for items is a phase 2 option. It would be a new tenant table needing RLS and cascade/export registration, so it is not worth paying for speculatively.

*Alternative considered:* per-item rows. They give exact fidelity but carry the noise and volume above, and every item would also count in "protected" totals.

### Status mapping

This vocabulary comes from the live capture; anything not listed maps to `unknown` and is kept rather than guessed. **Items with `deactivated_since` set are filtered out first**, before any mapping:

| Dropsuite signal (active items only) | `ExternalBackupStatus` |
|---|---|
| `Completed` with empty `errors` | `completed` |
| `Completed` with non-empty `errors` | `completed_with_errors` |
| `Running`, `Preparing Backup`, `Connecting` | `in_progress` |
| `Connection Failed`, `Authentication Error`, `System Error` | `failed` |
| `last_backup` null and `added_on` older than 24 h | `no_backups` |
| Google Drive (no status string): `last_backup` within the threshold | `completed`, otherwise left to staleness |
| `Unknown` or any other string | `unknown`, with the raw string kept in `raw.vendorStatuses` |
| `deactivated_since` set | excluded from the rollup and counted in `raw.deactivatedCount` |

Staleness uses the existing health computation on `lastSuccessAt`. Thresholds are 48 h for mail, OneDrive, SharePoint and Google Drive. Teams/Groups get 7 days, because our live data shows healthy teams with no backup for days (see the verification table). Rollup `lastSuccessAt` for Teams is therefore informational.

Fixtures are captured from our account and anonymised: names, emails, domains, ids and vendor error text are replaced.

### Sync

The existing `backupProviderSync` job and its three-phase transaction apply unchanged. The adapter's `listDevices` makes the HTTP calls outside the DB context.

- For each customer, **using that customer's token**: `/accounts`, `/onedrives`, `/sharepoints/domains` → `sites`, `/teams_and_groups/domains` → `teams`, `/googledrives`, `/shareddrives/domains` → `drives`. A workload whose top-level list is empty produces no row. It does not produce a `no_backups` row.
- **All or nothing**, as the interface requires. Any failed page throws `ProviderRequestError`, and the job writes nothing, because the delete-vanished step would otherwise wipe inventory.
- Bounded concurrency (2 customers at a time to start), 429/`Retry-After` backoff, and a per-sync request budget that aborts cleanly when exceeded rather than half-finishing.
- Measured on our account: 11 requests per customer at about 0.5 s each with `per_page` 100. Large customers add one request per 100 items per workload. A 50-customer partner is roughly 600–1,000 requests, about 2–4 minutes at concurrency 2. **The default `syncIntervalMinutes` for Dropsuite is 60, not 30.**
- A `401`/`403` on a **per-customer** token (one organization revoked or deactivated) must **not** mark the whole connection `reauth_required`. It marks that customer's rows `unknown` with a reason. Only an admin-token failure on `GET /users` is `reauth: true`. This needs a small extension to the adapter contract: `listDevices` may return per-customer failures alongside rows without failing the whole run, and those customers' existing rows are **kept, not deleted**. That changes "all or nothing" to "all or nothing per customer". The Cove adapter keeps its current behaviour.

### Surfaces

All of these already exist for Cove. The work is to make sure SaaS rows render correctly in each:
- **Integrations → Backup:** connection card with a region select and two token fields; the customer mapping table is reused as is.
- **Org backup view and device page:** SaaS rows appear in a "SaaS backup" group, not in the device list. They never link to a device.
- **Portal:** customer-visible "Microsoft 365 / Google Workspace backup" status per workload. The **"Protected devices" count excludes `accountType in ('m365','gws')`**. That is a fix to the existing count, because Cove's M365 rows have the same problem.
- **Backup status report and posture report:** endpoint and SaaS evidence are reported separately. This closes the `Boolean(backup || c2c)` collapse noted in the posture-evidence spec, for any org with a mapped provider.
- **AI tools:** if `query_backups` / `get_backup_status` surface provider rows, they include SaaS rows labelled by workload. *Not checked:* whether they read provider rows today.

### Tenancy

No new tables. `backup_provider_*` already has RLS, cascade and export registration from #6008. `accountType` gains a value and `dataSources` gains strings, so there is **no migration** unless review moves item detail out of `vendor_raw` (see Open decisions).

## Testing

- Adapter unit tests with recorded fixtures (synthetic data, built from the PDF samples first and replaced with scrubbed live captures in wave 1): status mapping including unknown strings, rollup worst-of and oldest-of, the 50-item cap, `errors` as both `""` and `{}`, and pagination across all three styles.
- **Token-scrub test:** no persisted field contains any token from the fixture.
- Error classification: admin 401 → `reauth`; per-customer 401 → customer-level failure, no deletion; 429 → retry; 5xx → retryable `ProviderRequestError`.
- Integration: a sync against a fake Dropsuite server, using the existing `backupProviderSync.integration.test.ts` pattern; an RLS check that partner B cannot read partner A's Dropsuite rows (already covered generically, so extend it with the new provider key).
- Portal count test: SaaS rows do not change "Protected devices".

## Rollout

Live discovery is done (see [Live verification](#live-verification-2026-10-27-our-pax8-sub-reseller-account-get-only)). It confirmed per-customer tokens, the status vocabulary, the two pagination shapes and that `organization_name` is on the list.

1. **W01, adapter + registry + credentials + sync defaults**, with the token scrub, deactivated filtering, per-customer failure handling, and anonymised fixtures from our account.
2. **W02, surfaces:** SaaS grouping, the portal count fix, and report and posture evidence.
3. **W03, live verification** on our account, then release notes and docs (`apps/docs` integration page with setup steps: partner portal → Settings → API Settings; works for Pax8 and other sub-reseller accounts).

## Decisions

Items 2–5 were defaulted on 2026-10-29 when implementation was dispatched; any of them can still be revisited in review.

1. **Live account: resolved.** Our own account is a Pax8 sub-reseller. That means GET calls only, which is all phase 1 needs, and phase 2 writes are off the table unless we become a Direct Partner.
2. **Granularity: one rollup row per customer and workload.** The capped `failingItems` list answers which mailbox is failing.
3. **Per-customer failures are isolated.** `listDevices` returns `{ devices, failedCustomerIds }`. A failed customer's existing rows are kept, and an admin-token failure still fails the whole run. Cove returns no failed customers, so its behaviour is unchanged.
4. **The domain-based mapping suggestion is deferred** to after W03.
5. **UI name: "NinjaOne SaaS Backup (Dropsuite)".** The API host and docs still say Dropsuite, and the product page says NinjaOne.

## Phase 2

- "Open in Dropsuite" uses `GET /users/{id}/generate_sso_link`. It is a GET, but it **mints a login into the customer's backup console**, so it needs a dedicated permission, an audit log entry, and a step-up check. It must never be available in the portal.
- Retention policy evidence (`/users/{id}/retention_policies`) for the posture and compliance reports.
- Seat reconciliation: Dropsuite `seats_used` against M365 licensed users, to find unprotected mailboxes.
- Writes (provisioning, licensing) only if we hold a Direct Partner account.
