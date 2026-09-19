---
tracking_issue: LanternOps/breeze#6008
---
# Backup Provider Integration — Phase 1: Cove Data Protection status everywhere

**Date:** 2026-09-15
**Status:** Design — awaiting spec review
**Branch:** `spec/backup-provider-integration`
**Scope:** Phase 1 only — read-only ingestion of third-party backup status and its display in every place Breeze shows its own backups. Phase 2 (provisioning and managing Cove devices from Breeze) is described under [Phase 2](#phase-2-management-out-of-scope) and is explicitly out of scope.
**Review:** advisor quorum 2026-09-15 (Fable position + Codex `xhigh` read-only review). Codex agreed on the model and corrected three points, all adopted: link column semantics on device org move (§ devices), "protected" requires positive success evidence (§ health), and provider events do not reach notification channels (§ alerts).

## Problem

Breeze ships its own agent-run backup, but most MSPs already run a third-party backup product across their customers — N-able Cove first, Veeam / Datto / Axcient later. Today those devices are invisible in Breeze: the `/backup` overview, the device Backup tab, the client portal Backups page and the posture report all read only `backup_jobs`, so a customer whose servers are protected by Cove shows as "unprotected" and a failed Cove backup never raises a Breeze alert. Technicians watch the Cove console or its daily "Backup & Recovery: All devices" email instead.

Cove exposes a JSON-RPC API that returns exactly what that email shows — per-device last-session status, last successful backup time, selected and used storage, error counts, active data sources — for every customer under the MSP in one paginated call. This spec wires that into Breeze as the first **backup provider**, behind a provider-neutral model so the second vendor is an adapter, not a rebuild.

### Cove API facts (verified 2026-09-15 against N-able primary docs unless marked)

| Area | Fact |
|---|---|
| Endpoint | `POST https://api.backup.management/jsonapi`, JSON-RPC 2.0. Methods and params are case-sensitive. Timestamps are Unix seconds, sizes are bytes. |
| Auth | `Login(partner, username, password)` → `visa`, valid **15 minutes**, every response carries a fresh visa. No static API key. The user must be a dedicated console user **without 2FA** (API-only users exist — UNVERIFIED). No documented rate limit. |
| Hierarchy | `EnumeratePartners(parentPartnerId, fetchRecursively, fields)` / `GetPartnerTree(partnerId)` return the customer tree: `Id`, `Name`, `Level`, `ParentId`, `ExternalCode`. `GetPartnerInfo` (by name) is deprecated because names collide — always use ids. |
| Devices | `EnumerateAccountStatistics({ query: { PartnerId, Filter, Columns[], SelectionMode:'Merged', StartRecordNumber, RecordsCount, OrderBy } })` at the **root** partner returns every device across all customers. Rows are `{ AccountId, PartnerId, Flags, Settings: [{ code: value }, …] }`. Unknown column codes are silently ignored. |
| Columns | `I0` id, `I1` name, `I8` customer name, `I14` used storage bytes, `I16` OS version, `I17` client version, `I18` computer name, `I21` MAC, `I32` OS type (1 workstation, 2 server, 0 undefined), `I59` account type (1 Backup Manager, 2 M365, 0 unknown), `I78` active data sources as concatenated 3-char codes (`D01` files, `D02` system state, `D10` MsSql, `D14` Hyper-V, `D08` VMware, `D19`/`D20`/`D05`/`D23` M365 Exchange/OneDrive/SharePoint/Teams, `D17` bare metal, …), `I36` storage status, `I37` LSV status. |
| Statistics | `D09Fnn` = totals across all data sources: `F00` last session status, `F06` errors, `F07` protected (selected) size, `F08` 28-day colour bar (opaque `ColourBar` type, encoding undocumented), `F09` last successful session timestamp, `F15` last session timestamp, `F16` last successful status, `F17`/`F18` last completed status/timestamp. |
| `F00` codes | 1 InProcess, 2 Failed, 3 Aborted, 5 Completed, 6 Interrupted, 7 NotStarted, 8 CompletedWithErrors, 9 InProgressWithFaults, 10 OverQuota, 11 NoSelection, 12 Restarted. |
| History | Per-device session list only via `QuerySessions(accountId, query, range)` — community-documented, not in the formal index (UNVERIFIED). |
| Management | `AddAccount` (returns install `Token`), `ModifyAccount`, `RemoveAccount`, partner and user CRUD. **No run-backup-now, no restore** (restore is console or local `ClientTool` only). Webhooks announced, not shipped. |

Consequence for phase 2: "manage" realistically means provisioning a device (create the Cove account, hand the install token to the Breeze agent) and rename/expire/remove — never "trigger a backup" or "restore".

## Goals / Non-goals

**Goals**
- One or more **partner-level** Cove connections: credentials validated, stored encrypted, synced every 30 minutes.
- **Map** Cove customers to Breeze organizations — automatically by exact name or `ExternalCode`, manually otherwise.
- **Sync** every device of every mapped customer into a provider-neutral device table with a normalized status, last successful backup, sizes, error count, data sources, and a provider-neutral 28-day observed-health ledger.
- **Link** provider devices to Breeze devices by computer name (MAC tiebreaker, manual override) so alerts, the device tab and coverage attach to the right endpoint; unlinked rows still show everywhere else.
- **Display** in the same places as first-party backups: `/backup` overview (now with an **All organizations** mode showing status buckets, recency buckets and a device table like the Cove email), the device Backup tab, the client portal Backups page and dashboard tile, the posture report and the org narrative report.
- **Alert** through the Breeze alert center for linked devices; publish event-bus events for every device so webhooks and automations reach unlinked ones.
- **Coverage**: a device with fresh successful provider backup evidence is no longer "needing backup" and counts as backup-configured in the posture report.
- Strict tenant isolation per the RLS contract: partner-axis on connections and customer mappings, org-axis on device and history rows, with composite FKs enforcing the tenant chain.

**Non-goals (phase 1)**
- No write operations against Cove (no provisioning, rename, expiry, removal, user management) — phase 2.
- No per-session history via `QuerySessions` and no decoding of Cove's `F08` colour bar — the 28-day bar is derived from our own polls.
- No participation in the Breeze SLA worker (`backupSlaWorker.ts`) or the recovery-readiness score — those stay first-party. Provider rows show status and recency, not an RPO/RTO verdict. `resolveAllBackupAssignedDevices` (drives first-party execution) is untouched.
- No storage of devices under **unmapped** customers — they are counted and surfaced as "N customers / M devices unmapped" on the connection card and the All-organizations overview until mapped (Huntress pattern), so a partner-wide view never implies complete vendor coverage.
- No M365 backup accounts (`I59 = 2`) in endpoint coverage — they are ingested as rows with `account_type = 'm365'`, shown in the provider device table under their own denominator, never linked to a Breeze device.
- No email/Slack notification for failures on **unlinked** provider devices (the notification dispatcher subscribes to alert lifecycle events only, and alerts require a device). They reach people through the overview attention panel, the connection card, webhooks and automations on the new events. Closing this gap is a phase-2 decision (nullable alert device vs. a notification subscriber for `backup.provider_*`).
- No second vendor in this phase; the adapter boundary is designed for it, not exercised.

## Decisions (approved 2026-09-15)

| # | Decision | Choice |
|---|---|---|
| D1 | Data model | Provider-neutral tables + per-vendor adapter (not Cove-specific tables). |
| D2 | Partner-wide dashboard | Extend the `/backup` overview with an All-organizations mode; no new page. |
| D3 | Alerts on unlinked provider devices | Breeze alerts only for provider devices linked to a Breeze device (alerts require a device). Unlinked failures appear in the attention panel and as event-bus events. Alert `device_id` stays NOT NULL. |
| D4 | Coverage | A provider backup with **fresh successful evidence** (last success within 48 h, connection active, sync not stale) makes the device "protected" for the devices-needing-backup panel and the posture report. Not for the SLA worker or readiness score. (Refined from "health ≠ critical" on Codex review: warning/unknown health without a recent success must not count as protected.) |
| D5 | Portal labelling | Generic "Managed cloud backup" label by default; per-connection toggle `show_provider_name_in_portal` reveals "Cove". |
| D6 | Reports | Phase 1 = posture report product entry + org narrative section. A dedicated "Backup status" report (the Cove email layout) is the final, detachable wave. |
| D7 | Device match | Computer name within the mapped org (case-insensitive against `devices.hostname` and `devices.displayName`), MAC address as tiebreaker, manual link/unlink override. |
| D8 | Unmapped customers | Devices under unmapped customers are not stored (`org_id NOT NULL`, RLS shape 1). |
| D9 | Credentials | One encrypted JSON blob per connection, **row-bound** AAD (`tool_sources.auth_config_encrypted` precedent); each adapter owns a Zod schema for its blob. |
| D10 | 28-day history | An observed-daily-health ledger written by our sync (one row per provider device per UTC day), not Cove's opaque colour bar and not per-device session calls. |
| D11 | Device link column | `breeze_device_id` with a composite `(breeze_device_id, org_id) → devices(id, org_id)` FK, `ON DELETE SET NULL`, detached synchronously by the device org-move route — the Intune `m365_intune_devices` pattern, so the table never enrols in the generic `device_id` cascade or org-restamp machinery. |

## Architecture

Four new tables, one migration, one adapter package with a Cove implementation, one BullMQ sync job, one route file, one unified read model, one web integrations card, changes to four display surfaces. Mirrors the **Huntress** integration shape (partner-level connector + encrypted credential + discovered-org mapping table + org-scoped synced child rows + split-phase sync) — see `apps/api/src/db/schema/huntress.ts`, `apps/api/src/jobs/huntressSync.ts`, `apps/api/src/routes/huntress.ts`, `apps/api/migrations/2026-06-12-a-huntress-partner-mapping.sql` — and the **Intune device link** shape for the Breeze device pointer (`apps/api/src/db/schema/m365Sync.ts` `breezeDeviceId`, `apps/api/src/routes/devices/moveOrg.ts` detach block, `apps/api/src/routes/devices/cascadeDelete.test.ts` "needs no device-cascade entry" test).

```
Cove JSON-RPC ──► CoveAdapter (services/backupProviders/cove) ──► VendorCustomer[] / VendorDevice[]
                                                                        │
      backupProviderSync (BullMQ, every 30 min per connection) ─────────┘
        ├─ tx 1: upsert backup_provider_customers (+ auto-map), upsert/delete backup_provider_devices
        │         (mapped customers only, org_id from mapping), link to devices, write daily ledger
        └─ step 2 (after commit): evaluate alerts (createSourcedAlert / resolveAlert) + publish backup.provider_* events

backupHealthReadModel ──► merges every in-scope Breeze device (+ backup_jobs) with backup_provider_devices
        ├─ GET /backup/health            → web overview (org or all-orgs), device table
        ├─ portal backupReadModel        → portal Backups page + dashboard tile
        ├─ securityComplianceReport      → posture "backup" product + backupConfigured
        └─ narrativeContext.loadBackups  → org narrative "Backups" section
```

### Naming collision to avoid

`backup_configs.provider` (`backupProviderEnum`: `local | s3 | azure_blob | google_cloud | backblaze`) names the **storage destination** of first-party backups, not a vendor. Nothing in this design reuses that column or enum; "provider" below always means the external backup product.

## Data model

All in one migration `apps/api/migrations/<date>-<time>-backup-provider-integration.sql`, named at implementation time to sort **after the newest committed migration** (`ls apps/api/migrations | tail` — filenames run ahead of real time, so today's date is not enough; the pre-push guard rejects a file that sorts too early). Idempotent (`IF NOT EXISTS`, `DO $$` guards, `pg_policies` checks), RLS enabled + forced + policies in the same migration, no inner `BEGIN`/`COMMIT`. Every composite FK that references an `org_id` column is `DEFERRABLE INITIALLY IMMEDIATE` (org-merge contract). Drizzle schema in a new `apps/api/src/db/schema/backupProviders.ts`.

### `backup_provider_connections` — partner-scoped connector (RLS shape 3)

```
id                              uuid PK default gen_random_uuid()
partner_id                      uuid NOT NULL REFERENCES partners(id)
provider                        varchar(30) NOT NULL              -- 'cove' (open string; the adapter registry validates)
name                            varchar(200) NOT NULL             -- human label, e.g. "OliveTech Cove"
base_url                        varchar(300) NOT NULL DEFAULT 'https://api.backup.management/jsonapi'
credentials_encrypted           text NOT NULL                     -- encryptSecret(JSON), aadBinding 'row'
vendor_root_id                  varchar(120)                      -- Cove root PartnerId learned at test/login
vendor_root_name                varchar(255)
is_active                       boolean NOT NULL DEFAULT true
status                          varchar(20) NOT NULL DEFAULT 'connected'   -- connected | error | reauth_required
sync_interval_minutes           integer NOT NULL DEFAULT 30
show_provider_name_in_portal    boolean NOT NULL DEFAULT false    -- D5
last_sync_at                    timestamptz
last_sync_status                varchar(20)                       -- running | success | partial | error
last_sync_error                 text                              -- truncated to 2000 chars
last_sync_customers             integer
last_sync_unmapped_customers    integer
last_sync_devices               integer
last_sync_unmapped_devices      integer
last_sync_linked_devices        integer
last_sync_ambiguous_devices     integer
created_by                      uuid REFERENCES users(id)
created_at / updated_at         timestamptz NOT NULL DEFAULT now()

UNIQUE (id, partner_id)                          -- composite FK target for children
UNIQUE (partner_id, provider, name)              -- several connections per provider allowed (acquisitions)
INDEX (partner_id)
```

Policies: `breeze_partner_isolation_{select,insert,update,delete}` using `public.breeze_has_partner_access(partner_id)` — copy the `huntress_integrations` block verbatim. Registrations: `PARTNER_TENANT_TABLES` (`rls-coverage.integration.test.ts`); `encryptedColumnRegistry.ts` entry `{ table: 'backup_provider_connections', column: 'credentials_encrypted', kind: 'text', aadBinding: 'row' }` so the blob decrypts only against its own row id and key rotation walks it (the route generates the row id before encrypting, as `services/toolSources/secrets.ts` does). No `org_id`, so no org-cascade, org-merge or export-policy entry.

Cove credentials blob (Zod, owned by the adapter): `{ partnerName: string, username: string, password: string }`. UI copy tells the MSP to create a dedicated Cove user with a read-only role, a unique password and no 2FA; the password is never returned by any route (only `hasCredentials: true`).

### `backup_provider_customers` — discovered vendor customers + org mapping (RLS shape 3, partner-axis)

```
id                      uuid PK
connection_id           uuid NOT NULL
partner_id              uuid NOT NULL REFERENCES partners(id)
vendor_customer_id      varchar(128) NOT NULL          -- Cove partner Id
vendor_customer_name    varchar(255) NOT NULL
vendor_parent_id        varchar(128)
vendor_level            varchar(40)                    -- Cove Level string as-is
vendor_external_code    varchar(255)
org_id                  uuid REFERENCES organizations(id) ON DELETE SET NULL
mapping_source          varchar(20)                    -- manual | auto_name | auto_external_code | manual_unmapped | NULL (never mapped)
device_count            integer NOT NULL DEFAULT 0     -- devices seen under this customer at last sync (mapped or not)
last_seen_at            timestamptz
created_at / updated_at timestamptz NOT NULL DEFAULT now()

UNIQUE (connection_id, vendor_customer_id)
UNIQUE (id, connection_id), UNIQUE (id, org_id)        -- composite FK targets for devices
INDEX (org_id), INDEX (partner_id), INDEX (connection_id)
FK (connection_id, partner_id) → backup_provider_connections(id, partner_id) ON DELETE CASCADE
FK (org_id, partner_id)        → organizations(id, partner_id) DEFERRABLE INITIALLY IMMEDIATE   -- a customer can only map to an org of the same partner
```

Policies: copy the `huntress_org_mappings` block — partner-axis on all four commands, with the `EXISTS` re-check of the parent connection's `partner_id` on INSERT/UPDATE `WITH CHECK`. Registrations: `PARTNER_TENANT_TABLES`; `ORG_AXIS_POLICY_EXCLUDED_TABLES` (has `org_id` but is partner-axis — same comment as Huntress); `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical); `CORE_TENANT_EXPORT_POLICY` (all columns `included`); `orgMergeRegistry.ts` `REPOINT_TABLES` (plain repoint, like `huntress_org_mappings` — after a merge the survivor holds both mappings, duplicates are tolerated by design).

Auto-mapping runs at every sync for rows with `mapping_source IS NULL` only: `vendor_external_code` parsing as the UUID of an organization under the partner → `auto_external_code`; else exactly one organization under the partner with `lower(name) = lower(vendor_customer_name)` → `auto_name`; otherwise stay unmapped. `manual` and `manual_unmapped` are never touched by auto-mapping.

**Remap / unmap is atomic** (`PUT /backup/providers/customers/:id/mapping`): in one transaction, resolve the customer's open provider alerts, delete its device and ledger rows, update `org_id`/`mapping_source`, then enqueue a sync so the rows reappear under the new org within seconds. Nothing stays visible to the old org until the next poll.

Customers that disappear from the vendor are deleted at sync (only after a complete, validated enumeration — see Sync); their device and ledger rows cascade.

### `backup_provider_devices` — one row per vendor device under a mapped customer (RLS shape 1)

```
id                          uuid PK
connection_id               uuid NOT NULL
partner_id                  uuid NOT NULL REFERENCES partners(id)      -- denormalized for partner-wide scans
org_id                      uuid NOT NULL REFERENCES organizations(id) -- from the customer mapping at sync time
customer_id                 uuid NOT NULL
provider                    varchar(30) NOT NULL                       -- denormalized from the connection (org-safe projection)
portal_show_provider_name   boolean NOT NULL DEFAULT false             -- denormalized from the connection, kept in step on PATCH
vendor_device_id            varchar(128) NOT NULL          -- Cove AccountId / I0
vendor_device_name          varchar(255) NOT NULL          -- I1
computer_name               varchar(255)                   -- I18
os_type                     varchar(20) NOT NULL DEFAULT 'unknown'   -- workstation | server | unknown (I32)
os_version                  varchar(255)                   -- I16
client_version              varchar(64)                    -- I17
mac_addresses               text[] NOT NULL DEFAULT '{}'   -- I21, normalized lower-case colon-separated
account_type                varchar(20) NOT NULL DEFAULT 'unknown'   -- backup_manager | m365 | unknown (I59)
data_sources                text[] NOT NULL DEFAULT '{}'   -- normalized from I78 (files, system_state, mssql, hyperv, vmware, m365_exchange, m365_onedrive, m365_sharepoint, m365_teams, bare_metal, network_shares, oracle, mysql, other)
status                      external_backup_status NOT NULL DEFAULT 'unknown'
vendor_status_code          integer                        -- raw D09F00
last_session_at             timestamptz                    -- D09F15
last_success_at             timestamptz                    -- D09F09
last_completed_at           timestamptz                    -- D09F18
selected_bytes              bigint                         -- D09F07
used_bytes                  bigint                         -- I14
errors_count                integer NOT NULL DEFAULT 0     -- D09F06
breeze_device_id            uuid                           -- LINK, not ownership (D11)
device_match_source         varchar(20)                    -- auto_hostname | auto_mac | manual | NULL
pending_condition           varchar(30)                    -- alert condition seen on the previous sync, for two-poll hysteresis
vendor_created_at           timestamptz
vendor_expires_at           timestamptz
first_seen_at               timestamptz NOT NULL DEFAULT now()
last_seen_at                timestamptz NOT NULL DEFAULT now()
vendor_raw                  jsonb                          -- full Settings map incl. F08, for debugging/future
created_at / updated_at     timestamptz NOT NULL DEFAULT now()

UNIQUE (connection_id, vendor_device_id)
UNIQUE (id, org_id)                                                    -- composite FK target for the ledger
UNIQUE (breeze_device_id) WHERE breeze_device_id IS NOT NULL            -- one provider row per Breeze device
INDEX (org_id, status), INDEX (partner_id, status), INDEX (org_id, breeze_device_id), INDEX (customer_id), INDEX (last_success_at)
FK (connection_id, partner_id)  → backup_provider_connections(id, partner_id) ON DELETE CASCADE
FK (customer_id, connection_id) → backup_provider_customers(id, connection_id) ON DELETE CASCADE
FK (customer_id, org_id)        → backup_provider_customers(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE   -- row org == customer's mapped org
FK (breeze_device_id, org_id)   → devices(id, org_id) ON DELETE SET NULL (breeze_device_id) DEFERRABLE INITIALLY IMMEDIATE   -- linked device is in the same org
```

The column is **`breeze_device_id`, never `device_id`**: a `device_id` column would enrol the table in `breeze_device_child_orgid_tables()` (the generic `SET org_id` re-stamp loop on device org move) and in `cascadeDelete.test.ts`'s `device_id` contract, both wrong for a link whose `org_id` derives from the customer mapping. Consequences, copied from Intune:
- `apps/api/src/routes/devices/moveOrg.ts` gains a synchronous detach next to the `m365_intune_devices` one: `UPDATE backup_provider_devices SET breeze_device_id = NULL, device_match_source = NULL WHERE breeze_device_id = $deviceId` **before** `UPDATE devices SET org_id`. The provider row stays with its customer's org and re-links at the next sync if the customer mapping points at the device's new org.
- Device hard-delete clears the link through the FK. No entry in `CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`, `DEVICE_DETACH_DEVICE_ID_TABLES` or `DEVICE_LINKED_DEVICE_ID_TABLES`; add a `cascadeDelete.test.ts` case mirroring the Intune one that asserts the column is `breeze_device_id` and not `device_id`/`linked_device_id`.
- The one-row-per-device partial unique index means a Breeze device backed up by two connections (post-acquisition) links to the first; the second stays unlinked and is counted in `last_sync_ambiguous_devices`. Relaxing this later is a one-line index change.

Policies: `breeze_org_isolation_*` via `public.breeze_has_org_access(org_id)` — copy the `huntress_agents` block. Registrations: auto-discovered shape 1; `CORE_ORG_CASCADE_DELETE_ORDER`; `CORE_TENANT_EXPORT_POLICY` (`vendor_raw` → `excludedOpen`, everything else `included`); `orgMergeRegistry.ts` `REPOINT_TABLES`.

### `backup_provider_device_history` — observed daily health for the 28-day bar (RLS shape 1)

```
id                  uuid PK
provider_device_id  uuid NOT NULL
org_id              uuid NOT NULL REFERENCES organizations(id)      -- denormalized from the device row
day                 date NOT NULL                                    -- UTC
status              external_backup_status NOT NULL                  -- worst status observed that day (severity order below)
last_success_at     timestamptz
errors_count        integer NOT NULL DEFAULT 0
observations        integer NOT NULL DEFAULT 1                       -- polls that contributed
updated_at          timestamptz NOT NULL DEFAULT now()

UNIQUE (provider_device_id, day)
INDEX (org_id, day)
FK (provider_device_id, org_id) → backup_provider_devices(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
```

This is **observed** health, not session history: a day with no poll is a gap (rendered grey), and a failed session observed by 40 polls is one failed day, not 40 failures. Nothing downstream may count ledger rows as jobs — the narrative and reports describe devices by health, never "N backups succeeded". Every sync upserts today's row per device in one batched statement: `status` = worse of (existing, observed), `errors_count` = max, `observations + 1`. Rows older than 60 days are pruned per connection. Volume: 10,000 devices × 60 days = 600k rows; 48 polls/day/device are upserts onto the same row, so write amplification is one row per device per poll. History is deleted with its device row (a device removed from the vendor has no restore points to reason about).

Why not Cove's `F08`: undocumented, vendor-specific, and the second vendor will not have it. Why not `QuerySessions`: one call per device per sync for detail that belongs on the device tab on demand in phase 2.

### Normalized status and health

Postgres enum `external_backup_status`:

```
completed | completed_with_errors | failed | in_progress | interrupted | over_quota | no_selection | not_started | no_backups | unknown
```

Cove `F00` → status: `5 → completed`, `8 → completed_with_errors`, `2 → failed`, `3 | 6 → interrupted`, `1 | 12 → in_progress`, `9 → in_progress` (faults carried by `errors_count`), `10 → over_quota`, `11 → no_selection`, `7 → not_started`, absent (`D09F00` missing from `Settings`) → `no_backups`, any other code → `unknown` (logged once per sync with the code).

Severity order for "worst of the day": `failed > over_quota > no_selection > no_backups > interrupted > completed_with_errors > not_started > unknown > in_progress > completed`.

**Derived, never stored** — one pure function in `packages/shared/src/utils/backupHealth.ts`, applied identically to first-party and provider rows:

```ts
type BackupHealth  = 'healthy' | 'warning' | 'critical' | 'unknown';
type BackupRecency = 'under_24h' | 'under_48h' | 'over_48h' | 'never';

deriveBackupHealth({ status, lastSuccessAt, errorsCount, now }): { health, recency, covered }
```

| Input | health |
|---|---|
| `failed`, `over_quota`, `no_selection`, `no_backups` | critical |
| `completed_with_errors`, `interrupted`; `in_progress` with `errorsCount > 0` | warning |
| `completed`, `in_progress`, `not_started` | by recency: success within 24 h → healthy, within 48 h → warning, older or null → critical |
| `unknown` | unknown |

`recency` is the age of `lastSuccessAt` (never when null). **`covered`** (D4) = `recency ∈ {under_24h, under_48h}` — positive, fresh success evidence regardless of the latest session's outcome (a device whose last run failed but which has a 20-hour-old restore point is covered *and* critical: coverage says "it has a backup", health says "look at it"). The read model additionally forces `covered = false` and `health = 'unknown'` for rows whose connection is inactive or whose sync is stale (`last_sync_at` older than 2 × `sync_interval_minutes`), and surfaces `stale: true` so the UI shows a "data as of" banner. Thresholds are constants in phase 1.

First-party rows map `backup_jobs.status` into the same enum before derivation: `completed → completed`, `partial → completed_with_errors` (still a usable, degraded restore point — `RESTORABLE_BACKUP_JOB_STATUSES` is preserved), `failed → failed`, `running | pending → in_progress`, `cancelled → interrupted`, no jobs → `no_backups`; `lastSuccessAt` = newest restorable job by `compareBackupRunRecency`.

## Provider adapter

`apps/api/src/services/backupProviders/`:

```
types.ts        — BackupProviderAdapter, VendorCustomer, VendorDevice, ProviderRequestError
registry.ts     — BACKUP_PROVIDERS: Record<'cove', BackupProviderAdapter>; getBackupProvider(key)
cove/client.ts  — CoveJsonRpcClient: login(), call(method, params) with visa chaining, pagination helper
cove/adapter.ts — CoveAdapter implements BackupProviderAdapter
cove/columns.ts — column code constants, Settings[] → map parser, F00/I32/I59/I78 normalizers (pure, unit-tested)
```

```ts
interface BackupProviderAdapter {
  readonly key: string;                       // 'cove'
  readonly label: string;                     // 'Cove Data Protection'
  readonly credentialsSchema: z.ZodTypeAny;   // validates the JSON blob before encryption
  testConnection(creds, baseUrl): Promise<{ ok: true; rootId: string; rootName: string; customerCount: number } | { ok: false; error: string; reauth: boolean }>;
  listCustomers(creds, baseUrl, rootId): Promise<VendorCustomer[]>;   // whole subtree, flattened
  listDevices(creds, baseUrl, rootId): Promise<VendorDevice[]>;       // whole subtree; throws ProviderRequestError if any page fails
}

interface VendorDevice {
  vendorDeviceId: string; vendorCustomerId: string; name: string; computerName: string | null;
  osType: 'workstation' | 'server' | 'unknown'; osVersion: string | null; clientVersion: string | null;
  macAddresses: string[]; accountType: 'backup_manager' | 'm365' | 'unknown'; dataSources: string[];
  status: ExternalBackupStatus; vendorStatusCode: number | null;
  lastSessionAt: Date | null; lastSuccessAt: Date | null; lastCompletedAt: Date | null;
  selectedBytes: number | null; usedBytes: number | null; errorsCount: number;
  vendorCreatedAt: Date | null; vendorExpiresAt: Date | null; raw: Record<string, unknown>;
}
```

Cove adapter specifics: `Login` once per sync; every response's `visa` replaces the current one. A JSON-RPC error meaning *visa expired* triggers exactly one re-login and retry; an error meaning *credentials rejected* (`Login` itself failing, or a permission error) raises `ProviderRequestError { reauth: true }` — the two are distinguished by which call failed and the vendor error code, never conflated. `listCustomers` = `EnumeratePartners(rootId, fetchRecursively: true, fields: [Name, Level, ParentId, ExternalCode, State])`. `listDevices` = `EnumerateAccountStatistics` at `rootId` with `Columns: ['I0','I1','I8','I14','I16','I17','I18','I21','I32','I59','I78','D09F00','D09F06','D09F07','D09F08','D09F09','D09F15','D09F18']`, `RecordsCount: 1000`, looping `StartRecordNumber` until a short page; the result is only returned when every page succeeded, so a partial enumeration can never be mistaken for "devices vanished". 200 ms spacing between calls, 30 s request timeout, at most 3 retries on 5xx/network. The client never logs credentials or visas.

The client is tested against recorded fixtures (`__fixtures__/cove/*.json`: login, partner tree, a statistics page with every status code, an M365 row, a row missing `D09F00`, a visa-expired error, a rejected-login error) — no live calls in CI.

## Sync job

`apps/api/src/jobs/backupProviderSync.ts`, copied from `huntressSync.ts`:

- Queue `backup-provider-sync`. Repeatable `sync-all` every 5 minutes: inside `withSystemDbAccessContext`, select connections with `is_active AND status <> 'reauth_required' AND (last_sync_at IS NULL OR last_sync_at < now() - sync_interval_minutes)`, enqueue `sync-connection` per row via `addUniqueJob` with `jobId = backup-provider-sync-${connectionId}` (`attempts: 3`, exponential backoff). "Sync now" from the UI enqueues the same job id (so it coalesces with a scheduled one) and is the only way a `reauth_required` connection is retried — after a credentials PATCH resets `status` to `connected`.
- `syncConnectionById(id)`: **Phase 1** load + decrypt the connection in a short system context, set `last_sync_status = 'running'`. **Phase 2** `runOutsideDbContext(() => adapter.listCustomers(); adapter.listDevices())` — no pooled connection held across HTTP; any failure aborts before any write. **Phase 3** one system transaction, holding `pg_advisory_xact_lock(hashtext('backup_provider:' || connectionId))`:
  1. Re-read the connection (`FOR UPDATE`) — abort if it was deleted/deactivated or its credentials changed since phase 1 (`updated_at` mismatch).
  2. Upsert customers (`onConflictDoUpdate` on `(connection_id, vendor_customer_id)`), delete vanished ones, run auto-mapping, recompute `device_count`. Mappings are read after the upsert inside this transaction, so a remap that landed during phase 2 wins.
  3. For devices whose customer is mapped: upsert on `(connection_id, vendor_device_id)` with `org_id` = the mapping's org; delete rows whose vendor device vanished or whose customer is no longer mapped. Devices under unmapped customers are counted into `last_sync_unmapped_devices` and skipped.
  4. Device matching (below) for rows with `device_match_source IS DISTINCT FROM 'manual'`.
  5. Ledger upsert for today, prune > 60 days.
  6. Write `last_sync_*` counters, `status = 'connected'`, `last_sync_status = 'success'` (or `'partial'` if any per-row failure was caught and logged).
- **Step 4 (after commit)**: alert and event evaluation against the committed rows (below). It is idempotent, so if it fails the connection is marked `last_sync_status = 'partial'` with the error and the next sync redoes it — `createSourcedAlert` publishes immediately and must never run inside the inventory transaction.
- Failure handling: `reauth` errors → `UnrecoverableError`, `status = 'reauth_required'`, `last_sync_status = 'error'`, Sentry suppressed, no scheduled retries; other errors → `last_sync_status = 'error'`, `last_sync_error` (2000 chars), BullMQ retry. Sync failures are surfaced on the connection card and the overview banner, not as an event (events require an `orgId`, and a failed connection may have none).
- Worker: concurrency 4, `lockDuration` 300 s, registered in `workerRegistry.ts` as `backupProviderSyncWorker` (`placement: 'global'`) next to the Huntress entry.

Deleting a connection resolves its open provider alerts (route-level, before the delete), then cascades to customers → devices → ledger.

## Device matching

For each provider row with `account_type = 'backup_manager'` and no manual link, within the row's `org_id` only:

1. Candidates = active (non-deleted) `devices` where `lower(hostname)` or `lower(display_name)` equals `lower(computer_name)` (fallback `vendor_device_name` when `computer_name` is null).
2. Exactly one candidate → link (`auto_hostname`). More than one → intersect with devices whose recorded network interfaces carry any of `mac_addresses` (the plan identifies the column used by network-discovery correlation); exactly one → link (`auto_mac`); else unlinked and counted in `last_sync_ambiguous_devices`.
3. An auto link is re-validated every sync: if the linked device no longer matches (renamed, deleted) the link is cleared and step 1 reruns. Manual links are validated for existence only. Org moves are detached synchronously by the move route (D11), never discovered late by polling.
4. Never link two provider rows to one device (partial unique index); the second stays unlinked.

Manual override: `PUT /backup/providers/devices/:id/link { deviceId | null }` — the composite FK rejects a device outside the row's `org_id`; the route turns that into a 422.

## Alerts and events

Evaluated after the inventory commit, serialized per connection by the unique job id and the advisory lock, for **linked** rows only (D3), using `createSourcedAlert` (`services/alertService.ts`) with `context = { source: 'backup_provider', connectionId, providerKey, providerDeviceId, vendorDeviceId, condition }`, `publisher: 'backup-provider-sync'`:

| Condition | When | Severity | Title |
|---|---|---|---|
| `failed` | status `failed` | high | Backup failed on {name} |
| `over_quota` | status `over_quota` | high | Backup over quota on {name} |
| `no_selection` | status `no_selection` | medium | Backup has nothing selected on {name} |
| `no_backups` | status `no_backups` | high | No backups recorded for {name} |
| `completed_with_errors` | status `completed_with_errors` or `interrupted` | medium | Backup completed with errors on {name} |
| `stale` | recency `over_48h` or `never` while none of the above holds | high | No successful backup in 48 hours on {name} |

- **Hysteresis**: a condition raises an alert only when observed on **two consecutive syncs** (the previous row's `status`/`recency` is compared before overwrite, recorded as `pending_condition` on the row); it clears on the first sync where it no longer holds. Thirty-minute polling makes the Redis flap window (`alertCooldown.ts`, 10-minute window) useless here, so consecutive-poll hysteresis replaces it. A nightly backup that fails one night and succeeds the next is two real incidents.
- **Dedupe**: before creating, query open alerts (`active | acknowledged | suppressed`, as the warranty evaluator does) whose `context->>'source' = 'backup_provider'`, `providerDeviceId` and `condition` match — reuse, never duplicate. The advisory lock makes SELECT-then-INSERT safe within a connection; a partial unique index on `alerts` is not added in phase 1 (shared table, one source).
- **Resolve** through `resolveAlert`'s compare-and-swap with the note "Condition cleared by provider sync". A device that vanishes from the vendor, is unlinked, or whose connection is deleted/deactivated resolves all its provider alerts. Indefinite mutes are respected (a `suppressed` alert is reused, never re-raised).
- **Events** (`eventBus.ts` union + constant map + both catalogs in `eventBus.types.test.ts`): `backup.provider_device_unhealthy` (payload: connectionId, providerKey, providerDeviceId, orgId, deviceId | null, vendorDeviceName, status, health, condition) and `backup.provider_device_recovered`. Published **on transitions only** (condition newly raised / newly cleared), for linked and unlinked rows, with `orgId` = the row's org. Webhooks (`webhooks.events` is a free `text[]`) and automations can subscribe; the notification dispatcher does not (see Non-goals).

## Unified read model

`apps/api/src/services/backupHealthReadModel.ts`:

```ts
interface BackupHealthRow {
  key: string;                          // 'breeze:<device id>' | 'provider:<row id>' — stable across pages
  source: 'breeze' | 'provider';
  providerKey: string | null; providerLabel: string | null;   // adapter label, or the generic label when the row's portal_show_provider_name is false and the caller is the portal
  orgId: string; orgName: string; siteId: string | null;
  deviceId: string | null;              // linked Breeze device (always set for source='breeze')
  name: string;                         // device display name or vendor device name
  computerName: string | null; osType: 'workstation' | 'server' | 'unknown';
  accountType: 'endpoint' | 'm365';
  status: ExternalBackupStatus; health: BackupHealth; recency: BackupRecency; covered: boolean; stale: boolean;
  lastSuccessAt: string | null; lastSessionAt: string | null;
  selectedBytes: number | null; usedBytes: number | null; errorsCount: number;
  dataSources: string[]; history28d: Array<{ day: string; status: ExternalBackupStatus | null }>;   // null = no observation
  agentOnline: boolean | null;          // devices.status when linked — "backup stale but device offline" context
}

listBackupHealthRows(scope: { orgIds: string[]; siteIds?: string[] }, opts: { sources?: ('breeze'|'provider')[]; onlyWithBackup?: boolean; filter?: {...}; page: { limit; cursor } })
summarizeBackupHealth(scope, opts): { endpoints: { total, covered, uncovered }, providerOnly: number, m365Accounts: number, byStatus, byHealth, byRecency }
```

Contracts preserved from the portal read model and confirmed on review:
- **Every active Breeze device in scope is a row** (`source: 'breeze'`, `status: 'no_backups'` when it has no jobs) — the unprotected population must never drop out of a jobs/provider union. The overview's default filter is `onlyWithBackup: true` (rows with any backup evidence, like the Cove email) with a toggle "Include devices without any backup"; the buckets follow the filter. The "devices needing backup" panel is `covered = false` over first-party-assigned devices, with a linked provider row's `covered` OR-ed in.
- A Breeze device that is both first-party-backed-up and provider-linked yields **two** rows; the overview groups them by `deviceId`. Coverage counts **distinct** Breeze devices (`endpoints.covered`), with provider-only endpoints and M365 accounts under their own denominators.
- Verification, test-restore, SLA-breach and readiness fields stay first-party and independently sourced; provider success proves none of them.
- **Site authority**: org RLS does not enforce site restrictions. Rows are filtered by the caller's site scope through the linked device's `site_id`; unlinked provider rows have no site and are returned only to callers without a site restriction. The `siteIds` argument carries the caller's restriction from the route.

First-party rows reuse the existing ordering and restorable-status helpers; `history28d` for them is derived from `backup_jobs` per UTC day, for provider rows from the ledger.

### Routes (`apps/api/src/routes/backup/providers.ts`, mounted under the existing `/backup` router)

| Method + path | Scope / permission | Purpose |
|---|---|---|
| `GET /backup/health/devices?orgId=&source=&health=&status=&withBackup=&search=&cursor=` (`GET /backup/health` is already the verification summary) | `backup:read`; `orgId` optional — omitted = all accessible orgs (`auth.orgCondition`, the devices-list pattern) | rows + summary for the overview |
| `GET /backup/providers/connections` | partner scope, `backup:read` | list (never returns credentials) |
| `POST /backup/providers/connections` | partner scope, same permission as Huntress connection writes | `{ provider, name, baseUrl?, credentials, showProviderNameInPortal? }` — validates via adapter schema, runs `testConnection`, stores encrypted, enqueues first sync |
| `PATCH /backup/providers/connections/:id` | partner scope, write | name, isActive, syncIntervalMinutes, showProviderNameInPortal (also rewrites the denormalized flag on its device rows), credentials (re-tested when present; resets `status` to `connected`) |
| `DELETE /backup/providers/connections/:id` | partner scope, write | resolves open provider alerts, deletes (cascade) |
| `POST /backup/providers/connections/:id/test` | partner scope, write | returns `{ success, message, rootName, customerCount }` (PSA `testResult` shape) |
| `POST /backup/providers/connections/:id/sync` | partner scope, write | enqueue now |
| `GET /backup/providers/connections/:id/customers` | partner scope, read | rows with mapping + `unmappedDeviceCount` |
| `PUT /backup/providers/customers/:id/mapping` | partner scope, write | `{ orgId: string | null }` → `manual` / `manual_unmapped`; atomic remap as described |
| `GET /backup/providers/devices?orgId=&deviceId=&connectionId=&linked=` | `backup:read`; org or all-orgs | raw provider rows (device tab card, diagnostics) |
| `PUT /backup/providers/devices/:id/link` | write | `{ deviceId | null }`, manual |

Existing `GET /backup/dashboard` keeps its org-only contract; its overdue "devices needing backup" computation uses the read model's `covered`, and `attentionItems` gains provider rows with health `critical` (linked or not) — `id: provider:<row id>`, description naming the vendor device and customer.

## Web UI (`apps/web`)

- **Integrations hub** (`components/integrations/IntegrationsPage.tsx`): new top-level tab `backup` (label "Backup", icon `HardDrive`) rendering `components/integrations/BackupProvidersIntegration.tsx`: connection list (one card per connection: provider badge, name, `syncStatusBadge` on `last_sync_status`, last sync time, counters incl. unmapped and ambiguous, `last_sync_error` box, "Re-enter credentials" call-to-action when `reauth_required`), "Add connection" form (provider select — Cove only — name, Cove partner name, username, password with show/hide, portal-label toggle, help text about the dedicated read-only user without 2FA), Test / Save / Sync now via `runAction`, and per connection a **customer mapping grid** (vendor customer, level, device count, Breeze org `<select>` with an "auto" badge for `auto_*`, "Unmapped (kept)" state for `manual_unmapped`, "N unmapped customers · M devices" summary). Add `apps/web/src/pages/settings/integrations/backup.astro` as a 301 to `/integrations#backup` for a stable link. All strings through i18n with real translations in every locale (the locale-parity test fails on placeholders).
- **Backup overview** (`components/backup/BackupOverviewContent.tsx` + `BackupDashboard.tsx`): when the org scope is `all`, do not call `/backup/dashboard` (it 400s) and hoist the branch above `OrgRequiredGate`; render the health view only. The health view (both scopes) adds, above the existing tiles: a "data as of" banner when any connection is stale, an "N devices under unmapped customers" notice, two horizontal bar groups exactly like the Cove email — **Status** (No backups / Completed / Completed with errors / In process / Unsuccessful, where Unsuccessful = failed + over_quota + no_selection + interrupted, plus a sixth **Other** bucket for `not_started` + `unknown` shown only when non-zero so the bars always sum to 100 %; the grouping is one shared constant used by the overview and the report) and **Last successful backup** (never / < 24 h / < 48 h / > 48 h), each with count and percentage — and a **device table** (health dot, name, computer name, organization, source badge "Breeze" / "Cove", type, data sources, selected size, used storage, 28-day bar with grey gaps, status, errors, agent online) with filters (health, source, org search, include-without-backup toggle) and a link to the device page when linked. Bars reuse the existing overview chart styling.
- **Device page** (`components/backup/DeviceBackupTab.tsx`): when `GET /backup/providers/devices?deviceId=` returns a row, render an "External backup — Cove Data Protection" card above the first-party sections: status pill, health, last successful / last session, selected and used storage, data sources, errors, 28-day bar, customer name, "Unlink" (manual) action. When no provider row and no first-party config, the existing empty state adds "Also check third-party backup connections".
- **Nav**: unchanged (`Backup → Device Backup` already exists).

## Client portal (`apps/portal` + `apps/api/src/services/portal/backupReadModel.ts`)

`backupOverview(orgId)` and `backupDevicesPage(orgId)` consume `listBackupHealthRows({ orgIds: [orgId] })` for the coverage and per-device pieces (verification, test-restore and SLA fields keep their current queries and stay `null` for provider rows). The portal runs under an org token, which cannot read the partner-axis connection table; the label and visibility come from the **denormalized `provider` and `portal_show_provider_name` columns on the device rows**, so no partner-axis read is needed. DTO additions in `packages/shared/src/types/portalVisibility.ts` (additive, nullable):

```ts
BackupDeviceRow += { source: 'breeze' | 'external'; providerLabel: string | null; status: ExternalBackupStatus; health: BackupHealth; lastSuccessAt: string | null; }
BackupOverviewDto += { byHealth: Record<BackupHealth, number>; externalProviders: string[] }   // labels shown, per D5
```

Provider rows use `id = provider:<row id>` when unlinked (the portal never navigates by id today). `providerLabel` is "Managed cloud backup" unless `portal_show_provider_name` is true, in which case it is the adapter label. The dashboard tile (`services/portal/dashboard.ts` → `backupTile`) is called unconditionally today; provider data enters the tile only when the org's `enableBackups` branding flag is on, the same gate as the page.

## Reports

- **Posture report** (`services/securityComplianceReport.ts`): build the provider entries through the existing `buildSecurityProductInventory` / `SecurityProductEvidence` path (`securityComplianceReportProducts.ts`), which already deduplicates device ids and separates inventoried from active coverage: `{ product: <label per D5>, category: 'backup', active: true, lastSyncStatus, deviceCoverage: linked provider rows / org endpoints, activeDeviceCoverage: linked rows with covered = true / org endpoints }`; `backupConfigured = Boolean(backup || c2c || coveredProviderRows > 0)`. `buildPostureBackupMetric` (`packages/shared/src/reportPdf/reportPdf.ts`) lists every `backup`-category product instead of a single Yes/No, and the product-inventory wording "with real-time protection on" (reportPdf.ts ~:1611) becomes category-aware ("with a successful backup in the period" for backup products).
- **Org narrative** (`services/aiAgents/narrativeContext.ts` `loadBackups`): add a provider block — devices by health, critical devices by name, unmapped counts, last sync age — described as device health, never as job counts (ledger rows are observations).
- **Backup status report** (final wave, detachable): new report type `backup_status` registered in the existing report dispatcher, org-scoped, as-of snapshot plus the 28-day ledger: status buckets, recency buckets, device table — the Cove email layout over both sources. When the deliverables waves want it as managed evidence it is added to `MANAGED_EVIDENCE_REGISTRY` and `MANAGED_EVIDENCE_REPORT_TYPES` together (pinned by `managedEvidenceRegistry.test.ts`), with period baselines and delivery-gated portal visibility — that registration is a deliverables-track task, not part of this spec.

## Security

- Credentials are a console password, not an API key. UI copy and docs instruct: dedicated Cove user, read-only role, no 2FA, unique password. Stored as one row-bound encrypted blob; decrypted only inside the sync job and the test route; never logged, never returned. Phase 2 write operations will need a higher Cove role — a separate connection setting, not a silent upgrade.
- Partner-scope gate on every connection/customer route (`auth.scope === 'partner'`); org tokens see provider device rows through RLS only, and site-restricted users only see rows attributable to their sites.
- Tenant chain enforced in the database: customer → org of the same partner; device → customer of the same connection and the same org; ledger → device of the same org; link → device of the same org.
- Portal exposure is label-controlled (D5) and gated by `enableBackups`.
- `vendor_raw` is `excludedOpen` in the export policy; nothing in it is a secret today, but the container rule applies.
- Outbound calls only to `base_url`; the default is pinned and an override must be `https://`.

## Testing

- **Pure units** (Test API job): `cove/columns.ts` normalizers (every `F00` code, `I78` splitting, `I32`/`I59`, missing columns), `deriveBackupHealth` (all status × recency cells incl. `covered`), worst-of-day ordering, auto-mapping rules, matching rules (unique / ambiguous / MAC tiebreak / manual precedence), alert hysteresis and dedupe key, visa-expired vs rejected-credential classification. Cove client against fixtures (pagination, visa chaining, partial-page abort). Route tests with Drizzle mocks for CRUD, partner-scope gate, credential never returned, test-connection `testResult` shape, atomic remap. `cascadeDelete.test.ts` Intune-style column-name case; `eventBus.types.test.ts` catalogs; `migrationRlsScope.test.ts`; `autoMigrate.test.ts`.
- **Integration** (live DB): `backupProviderRls.integration.test.ts` — cross-partner forge on connections and customers → 42501, org token cannot read another org's device rows, partner token reads all its orgs' rows, composite-FK rejections (customer→foreign-partner org, link→device in another org), connection delete cascade, org erasure through `tenantCascade`, org merge through `orgMergeRegistry`, device org move detaches the link (not re-homes); `rls-coverage`, `tenantCascade`, `tenant-export-policy` contract suites green; a sync end-to-end test with a stubbed adapter proving customers → mapping → devices → ledger → (two polls) alert create → auto-resolve, and that a failed enumeration deletes nothing.
- **Web** (vitest + jsdom): integrations card (add / test / save / mapping select via `runAction`, error toast on `{success:false}`), overview buckets and table under `scope: 'all'` and `scope: 'org'`, stale banner, device tab external card. `no-silent-mutations` guard passes; locale parity passes.
- **Portal**: DTO mapping for external rows; label toggle; tile gating.
- **Manual before PR**: one real Cove tenant end-to-end against a wt-stack (credentials from the owner, never committed).

## Phase 2: management (out of scope)

- Provision: "Deploy Cove to this device" → `AddAccount` under the mapped customer → install token → Breeze agent runs the vendor installer with the token; row links itself on first sync.
- `ModifyAccount` (rename, expiry), `RemoveAccount` (with confirmation), customer creation for a new Breeze org.
- Per-device session history on the device tab via `QuerySessions` (on demand, cached).
- Notification reach for unlinked devices (nullable alert device, or a `backup.provider_*` notification subscriber).
- Webhook ingestion when N-able ships it; M365 backup account surfacing in the Cloud Backup area.
- Per-connection stale thresholds; participation in SLA/readiness.

## Wave outline (input to writing-plans)

1. **W01 Foundation** — schema + migration + RLS + composite FKs + all registrations (org cascade, export policy, org-merge repoint, encrypted column, RLS allowlists, cascadeDelete column-name test, moveOrg detach), shared status enum + `deriveBackupHealth`, adapter interface + registry, Cove client/adapter/columns with fixtures, connection CRUD/test/sync-now routes, customer mapping routes with atomic remap.
2. **W02 Sync** — BullMQ job, worker registry, customers/devices/ledger persistence with complete-enumeration guard, auto-mapping, device matching + manual link route, post-commit alert/event evaluation with hysteresis, sync-failure and reauth handling.
3. **W03 Read model + web** — `backupHealthReadModel` (all-devices contract, site authority, cursor pagination), `GET /backup/health`, dashboard coverage + attention items, Integrations Backup tab + Cove card + mapping grid, overview buckets/table with all-orgs mode and stale banner, device tab card.
4. **W04 Portal + reports** — portal read model on the unified model, DTO additions, label via denormalized columns, tile gating, posture report through the product-inventory path + wording fix, narrative block.
5. **W05 Backup status report** — detachable.
