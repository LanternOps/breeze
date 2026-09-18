---
tracking_issue: LanternOps/breeze#6008
---
# Backup Provider Integration (Cove, phase 1) — Plan Index

**Spec:** `docs/superpowers/specs/integrations/2026-09-15-backup-provider-integration-cove-design.md` (approved 2026-09-15).

One plan document per wave. Each wave is one PR on its own branch
`feature/6008-backup-provider-integration/wave-<sub-issue#>` with `Closes #<sub-issue#>` in the PR
body. State lives on GitHub (feature-lifecycle); the wave issue is the source of truth for status,
never this index.

| Wave | Plan | Depends on |
|---|---|---|
| W01 (#6009) | [Foundation: schema, migration, RLS, registrations, health derivation, Cove adapter, connection + mapping routes](2026-09-15-backup-provider-integration-w01-foundation.md) | — |
| W02 (#6010) | [Sync: BullMQ job, customers/devices/ledger persistence, auto-mapping, device matching, alerts + events](2026-09-15-backup-provider-integration-w02-sync.md) | W01 |
| W03 (#6011) | [Read model + web: backupHealthReadModel, GET /backup/health, Integrations Backup tab, overview all-orgs mode, device tab card](2026-09-15-backup-provider-integration-w03-read-model-web.md) | W01 (W02 for live data; feature-complete without it) |
| W04 (#6012) | [Portal + reports: portal read model on the unified model, DTOs, label toggle, tile gating, posture report, narrative block](2026-09-15-backup-provider-integration-w04-portal-reports.md) | W03 |
| W05 (#6013) | [Backup status report (Cove email layout) — detachable](2026-09-15-backup-provider-integration-w05-backup-status-report.md) | W03 |

W02 and W03 run in parallel after W01 merges. W04 and W05 start once W03 has merged. Stacked
branches get no `pull_request` CI run: dispatch `gh workflow run CI --ref <branch>` before enqueueing.

## Migration slots reserved

| File | Wave |
|---|---|
| `2026-10-17-120000-backup-provider-integration.sql` (DDL only: four tables, enum, RLS, indexes, composite FKs; no row writes) | W01 |
| `2026-10-17-120100-backup-status-report-type.sql` (only if the report-type enum needs a value; otherwise unused) | W05 |

Every executor re-checks `ls apps/api/migrations | grep '\.sql$' | sort | tail -1` before committing
and renames upward if main has moved past these names (as of 2026-09-15 the newest committed is
`2026-10-17-094100-m365-signin-events.sql`; the network-device-page-truth plans have reserved
`2026-10-17-110000`…`110300`, which these sort after).

## Cross-wave names that must not drift

Defined in W01 and consumed verbatim by later waves:

### Database (`apps/api/src/db/schema/backupProviders.ts`)
- Enum `externalBackupStatusEnum` = pg enum `external_backup_status`:
  `completed | completed_with_errors | failed | in_progress | interrupted | over_quota | no_selection | not_started | no_backups | unknown`.
- Tables (Drizzle export → SQL name): `backupProviderConnections` → `backup_provider_connections`,
  `backupProviderCustomers` → `backup_provider_customers`, `backupProviderDevices` → `backup_provider_devices`,
  `backupProviderDeviceHistory` → `backup_provider_device_history`. Column names exactly as the spec's
  Data model section; the Breeze device pointer is **`breeze_device_id`** (never `device_id`).
- `backup_provider_connections.status` values `connected | error | reauth_required`; `last_sync_status`
  values `running | success | partial | error`; `backup_provider_customers.mapping_source` values
  `manual | auto_name | auto_external_code | manual_unmapped | NULL`; `backup_provider_devices.device_match_source`
  values `auto_hostname | auto_mac | manual | NULL`; `os_type` `workstation | server | unknown`;
  `account_type` `backup_manager | m365 | unknown`.

### Shared (`packages/shared/src/types/backupHealth.ts`, `packages/shared/src/utils/backupHealth.ts`)
- `EXTERNAL_BACKUP_STATUSES` (readonly tuple, same order as the enum), `type ExternalBackupStatus`.
- `type BackupHealth = 'healthy' | 'warning' | 'critical' | 'unknown'`,
  `type BackupRecency = 'under_24h' | 'under_48h' | 'over_48h' | 'never'`.
- `BACKUP_WARNING_AFTER_HOURS = 24`, `BACKUP_CRITICAL_AFTER_HOURS = 48`.
- `deriveBackupHealth(input: { status: ExternalBackupStatus; lastSuccessAt: Date | string | null; errorsCount: number; now?: Date }): { health: BackupHealth; recency: BackupRecency; covered: boolean }`.
- `EXTERNAL_BACKUP_STATUS_SEVERITY: Record<ExternalBackupStatus, number>` (higher = worse; order per spec) and
  `worstBackupStatus(a: ExternalBackupStatus, b: ExternalBackupStatus): ExternalBackupStatus`.
- `mapBackupJobStatus(jobStatus: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'partial' | null): ExternalBackupStatus`.
- `type BackupHealthRow` and `type BackupHealthSummary` exactly as the spec's Unified read model section
  (lives in shared so web and portal import it).
- `type BackupProviderAlertCondition = 'failed' | 'over_quota' | 'no_selection' | 'no_backups' | 'completed_with_errors' | 'stale'`.
- Status buckets (the Cove-email bars; one grouping for the overview AND the report): `BACKUP_STATUS_BUCKET_IDS = ['no_backups', 'completed', 'completed_with_errors', 'in_progress', 'unsuccessful', 'other'] as const`, `type BackupStatusBucketId`, `BACKUP_STATUS_BUCKET_MEMBERS: Record<BackupStatusBucketId, readonly ExternalBackupStatus[]>` (`unsuccessful = failed | over_quota | no_selection | interrupted`, `other = not_started | unknown`), `bucketForBackupStatus(status): BackupStatusBucketId`. UIs render `other` only when its count is non-zero.
- Everything under `packages/shared/src/utils/backupHealth.ts` is re-exported from `packages/shared/src/utils/index.ts` and imported by API code from the package root (`@breeze/shared`), never by deep path — deep paths are absent from the package `exports` map and break the integration runner.

### Provider adapter (`apps/api/src/services/backupProviders/`)
- `types.ts`: `interface BackupProviderAdapter { key; label; credentialsSchema; testConnection(creds, baseUrl); listCustomers(creds, baseUrl, rootId); listDevices(creds, baseUrl, rootId) }`,
  `interface VendorCustomer { vendorCustomerId: string; name: string; parentId: string | null; level: string | null; externalCode: string | null }`,
  `interface VendorDevice` (spec shape), `class ProviderRequestError extends Error { code: string; reauth: boolean }`,
  `type ProviderTestResult = { ok: true; rootId: string; rootName: string; customerCount: number } | { ok: false; error: string; reauth: boolean }`.
- `registry.ts`: `BACKUP_PROVIDER_KEYS = ['cove'] as const`, `type BackupProviderKey`, `getBackupProvider(key: string): BackupProviderAdapter` (throws on unknown).
- `credentials.ts`: `encryptProviderCredentials(connectionId: string, creds: unknown): string`,
  `decryptProviderCredentials(connectionId: string, ciphertext: string): unknown` — row-bound AAD through the
  `encryptedColumnRegistry` entry `{ table: 'backup_provider_connections', column: 'credentials_encrypted', kind: 'text', aadBinding: 'row' }`.
- `cove/columns.ts`: `COVE_STATISTIC_COLUMNS` (the 18-code list from the spec), `parseCoveSettings(settings: Array<Record<string, unknown>>): Record<string, unknown>`,
  `mapCoveSessionStatus(code: number | null | undefined): ExternalBackupStatus`, `mapCoveOsType(v): 'workstation' | 'server' | 'unknown'`,
  `mapCoveAccountType(v): 'backup_manager' | 'm365' | 'unknown'`, `parseCoveDataSources(i78: string | null | undefined): string[]`,
  `coveRowToVendorDevice(row: { AccountId; PartnerId; Settings }): VendorDevice`.
- `cove/client.ts`: `class CoveJsonRpcClient { constructor(opts: { baseUrl; fetchImpl?; delayMs?; timeoutMs? }); login(creds): Promise<{ visa; partnerId; partnerName }>; call<T>(method, params): Promise<T>; enumeratePartners(rootId): Promise<VendorCustomer[]>; enumerateAccountStatisticsAll(rootId): Promise<VendorDevice[]> }`.
- `cove/adapter.ts`: `coveCredentialsSchema` (zod `{ partnerName, username, password }`), `coveAdapter: BackupProviderAdapter`.

### Sync (W02, `apps/api/src/jobs/backupProviderSync.ts` + `apps/api/src/services/backupProviders/`)
- Queue `backup-provider-sync`; repeatable job `sync-all` (every 5 min); per-connection job name `sync-connection`, `jobId = backup-provider-sync-${connectionId}`.
- `initializeBackupProviderSyncJob()`, `shutdownBackupProviderSyncJob()`, `enqueueBackupProviderSync(connectionId: string): Promise<string>` (returns the BullMQ job id; W01's sync-now and create routes call this — W01 ships it as a stub that only enqueues via `enqueueOrReplaceStale` on a `createInstrumentedQueue`, every call site wrapped in `runOutsideDbContext`; W02 ships the worker), `syncConnectionById(connectionId: string): Promise<void>`.
- `persist.ts`: `persistVendorSnapshot(tx, connection, snapshot: { customers: VendorCustomer[]; devices: VendorDevice[] }): Promise<SyncCounters>`.
- `mapping.ts`: `autoMapCustomers(tx, connectionId, partnerId): Promise<number>`, `remapCustomer(customerId, orgId: string | null, actor): Promise<RemapCustomerResult>` (`{ deletedDevices: number; deletedHistory: number; resolvedAlerts: number; jobId: string }`; W01 ships it; alerts are resolved BEFORE the inventory transaction because `resolveAlert` publishes on the event bus).
- `deviceMatching.ts`: `matchProviderDevices(tx, connectionId): Promise<{ linked: number; ambiguous: number }>`.
- `alerts.ts`: `evaluateProviderAlerts(connectionId: string): Promise<{ raised: number; resolved: number }>`; `BACKUP_PROVIDER_ALERT_SOURCE = 'backup_provider'`, publisher `'backup-provider-sync'`.
- `alertsResolve.ts` (W01): `resolveProviderAlertsForConnection(connectionId: string): Promise<number>` and `resolveProviderAlertsForCustomer(customerId: string): Promise<number>` — resolve open alerts whose `context->>'source' = 'backup_provider'` and matching `connectionId` / customer's `providerDeviceId`s via `resolveAlert`; called by connection DELETE, `PATCH isActive:false`, and `remapCustomer`.
- Worker registry entry name `backupProviderSyncWorker` (`placement: 'global'`).

### Route registration lists (W01)
- Routes that call the vendor (`POST /backup/providers/connections`, `PATCH /backup/providers/connections/:id`, `POST /backup/providers/connections/:id/test`) are registered in `SELF_MANAGED_DB_CONTEXT_ROUTES` (`apps/api/src/middleware/selfManagedDbContextRoutes.ts`) so no pooled connection is held across the HTTP call (`safeFetch`'s `assertOutsideHeldDbContext` throws otherwise).
- Permissions: reads `BACKUP_READ`; connection/mapping writes `ORGS_WRITE` + `requireMfa()` + `canManagePartnerWidePolicies` (Huntress parity); `PUT /backup/providers/devices/:id/link` uses `BACKUP_WRITE` without MFA.

### Events (`apps/api/src/services/eventBus.ts`)
- `backup.provider_device_unhealthy` → `EVENT_TYPES.BACKUP_PROVIDER_DEVICE_UNHEALTHY`,
  `backup.provider_device_recovered` → `EVENT_TYPES.BACKUP_PROVIDER_DEVICE_RECOVERED`.
  Payload: `{ connectionId, providerKey, providerDeviceId, orgId, deviceId: string | null, vendorDeviceName, status, health, condition }`.

### Routes
- `apps/api/src/routes/backup/providers.ts` (W01): `GET/POST /backup/providers/connections`, `PATCH/DELETE /backup/providers/connections/:id`,
  `POST /backup/providers/connections/:id/test`, `POST /backup/providers/connections/:id/sync`,
  `GET /backup/providers/connections/:id/customers`, `PUT /backup/providers/customers/:id/mapping`,
  `GET /backup/providers/devices`, `PUT /backup/providers/devices/:id/link`.
- `apps/api/src/routes/backup/health.ts` (W03): `GET /backup/health/devices` → `{ data: { rows: BackupHealthRow[]; summary: BackupHealthSummary; nextCursor: string | null; stale: boolean; unmappedDevices: number } }`. (`GET /backup/health` already exists — `routes/backup/verification.ts:69`, the verification/readiness summary consumed by `BackupVerificationOverview.tsx` — so the device-health listing lives one segment deeper.)
- `apps/api/src/services/backupHealthReadModel.ts` (W03): `BackupHealthListOptions = { sources?: ('breeze' | 'provider')[]; onlyWithBackup?: boolean; labels?: 'vendor' | 'portal'; filter?: { health?: BackupHealth; status?: ExternalBackupStatus; search?: string }; page: { limit: number; cursor: string | null } }`; `listBackupHealthRows(scope: { orgIds: string[]; siteIds?: string[] }, opts: BackupHealthListOptions): Promise<{ rows: BackupHealthRow[]; nextCursor: string | null }>`,
  `summarizeBackupHealth(scope, opts): Promise<BackupHealthSummary>`, `getProviderCoverageForDevices(orgId, deviceIds: string[]): Promise<Map<string, { covered: boolean; health: BackupHealth }>>` (used by the dashboard overdue panel and the posture report).

### Web (W03, consumed by W04/W05)
- `apps/web/src/components/integrations/BackupProvidersIntegration.tsx` (tab id `backup`, label key `integrationsPage.backup`),
  `BackupProviderConnectionCard.tsx`, `BackupProviderCustomerMapping.tsx`; i18n namespace keys `backupProviders.*` in all locales.
- `apps/web/src/components/backup/BackupHealthOverview.tsx` (status + recency buckets, device table, stale banner, unmapped notice),
  `apps/web/src/components/backup/ExternalBackupCard.tsx` (device tab).
- `apps/web/src/pages/settings/integrations/backup.astro` → 301 to `/integrations#backup`.

### Portal DTO additions (W04, `packages/shared/src/types/portalVisibility.ts`)
- `BackupDeviceRow += { source: 'breeze' | 'external'; providerLabel: string | null; status: ExternalBackupStatus; health: BackupHealth; lastSuccessAt: string | null }`,
  `BackupOverviewDto += { byHealth: Record<BackupHealth, number>; externalProviders: string[] }`.
- Generic portal label literal: `"Managed cloud backup"` (i18n key `backups.managedCloudBackup`).

### Report (W05)
- Report type key `backup_status`.
