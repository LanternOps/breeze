---
tracking_issue: LanternOps/breeze#6008
---
# Backup Provider Integration W01: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the whole provider-neutral backup-integration substrate — four tables with their RLS, composite tenant FKs and *nine* registration lists; the shared normalized status enum and `deriveBackupHealth`; the Cove adapter (columns, JSON-RPC client, adapter) against recorded fixtures; and the partner-scoped connection + customer-mapping routes — so W02 (sync) and W03 (read model + web) build on fixed names and a database that already refuses every cross-tenant shape.

**Architecture:** One idempotent DDL-only migration creates the enum `external_backup_status` and `backup_provider_connections` (partner-axis, RLS shape 3), `backup_provider_customers` (partner-axis with a denormalized nullable `org_id`, shape 3), `backup_provider_devices` and `backup_provider_device_history` (org-axis, shape 1), with every composite FK that references an `org_id` column declared `DEFERRABLE INITIALLY IMMEDIATE` and the device link expressed as `(breeze_device_id, org_id) → devices(id, org_id) ON DELETE SET NULL (breeze_device_id)`. Pure health derivation lives in `packages/shared` so web, portal and API share one rule. The vendor boundary is `apps/api/src/services/backupProviders/` — a `BackupProviderAdapter` interface, a registry, row-bound credential crypto, and a Cove implementation split into pure column normalizers, a JSON-RPC client with visa chaining and pagination, and the adapter itself. Routes are a hub (`routes/backup/providers.ts`) mounting three thin sub-routers; the three that make a real Cove HTTP call are registered in `SELF_MANAGED_DB_CONTEXT_ROUTES` so they never pin a pooled connection across the network round-trip.

**Tech Stack:** PostgreSQL + hand-written SQL migrations, Drizzle ORM, Hono + Zod (zod v4), BullMQ (queue-add only in this wave), Vitest (API unit with Drizzle mocks; shared-package pure units; API integration on real Postgres).

**Spec:** `docs/superpowers/specs/integrations/2026-09-15-backup-provider-integration-cove-design.md` (approved 2026-09-15). This wave ships: **Data model** in full, **Normalized status and health** in full, **Provider adapter** in full, **Security** in full, the W01 bullets of **Testing**, the W01 row of the **Wave outline**, and every `/backup/providers/*` row of the **Routes** table (everything except `GET /backup/health`, which is W03). Where this plan is more specific than the spec — exact SQL, the route-file split, the self-managed-DB-context registration, the savepoint around FK-violation mapping, the JSON-RPC envelope shape — **the plan wins**, and every such point is marked **DECISION** inline.

**Cross-wave names (from the plan index — do not rename):**
- Pg enum `external_backup_status` / Drizzle `externalBackupStatusEnum`; tables `backup_provider_connections` / `backup_provider_customers` / `backup_provider_devices` / `backup_provider_device_history`; Drizzle exports `backupProviderConnections`, `backupProviderCustomers`, `backupProviderDevices`, `backupProviderDeviceHistory`; the device pointer is **`breeze_device_id`**, never `device_id`.
- Shared: `EXTERNAL_BACKUP_STATUSES`, `ExternalBackupStatus`, `BackupHealth`, `BackupRecency`, `BACKUP_WARNING_AFTER_HOURS = 24`, `BACKUP_CRITICAL_AFTER_HOURS = 48`, `deriveBackupHealth`, `EXTERNAL_BACKUP_STATUS_SEVERITY`, `worstBackupStatus`, `mapBackupJobStatus`, `BackupHealthRow`, `BackupHealthSummary`, `BackupProviderAlertCondition`.
- Adapter: `BackupProviderAdapter`, `VendorCustomer`, `VendorDevice`, `ProviderRequestError`, `ProviderTestResult`, `BACKUP_PROVIDER_KEYS`, `BackupProviderKey`, `getBackupProvider`, `encryptProviderCredentials`, `decryptProviderCredentials`, `COVE_STATISTIC_COLUMNS`, `parseCoveSettings`, `mapCoveSessionStatus`, `mapCoveOsType`, `mapCoveAccountType`, `parseCoveDataSources`, `coveRowToVendorDevice`, `CoveJsonRpcClient`, `coveCredentialsSchema`, `coveAdapter`.
- Sync (W01 ships only the enqueue half): queue `backup-provider-sync`, job name `sync-connection`, `jobId = backup-provider-sync-${connectionId}`, `enqueueBackupProviderSync(connectionId)`.
- Mapping: `remapCustomer` in `apps/api/src/services/backupProviders/mapping.ts`.
- Alerts: `BACKUP_PROVIDER_ALERT_SOURCE = 'backup_provider'`.
- Routes: `apps/api/src/routes/backup/providers.ts` — `GET/POST /backup/providers/connections`, `PATCH/DELETE /backup/providers/connections/:id`, `POST /backup/providers/connections/:id/test`, `POST /backup/providers/connections/:id/sync`, `GET /backup/providers/connections/:id/customers`, `PUT /backup/providers/customers/:id/mapping`, `GET /backup/providers/devices`, `PUT /backup/providers/devices/:id/link`.

---

## Global Constraints

- **Migration filename is reserved by the plan index: `apps/api/migrations/2026-10-17-120000-backup-provider-integration.sql`.** Newest committed migration as of 2026-09-15 is `2026-10-17-094100-m365-signin-events.sql`; the network-device-page-truth plans reserved `2026-10-17-110000`…`110300`, which `120000` sorts after. Re-check with `ls apps/api/migrations | grep '\.sql$' | sort | tail -1` before **every** commit and rename upward if `main` moved past it. Pre-push additionally runs `scripts/check-migration-naming.sh --against-ref origin/main`, which compares against `origin/main` — fetch first.
- The migration is **idempotent** (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`, `pg_type` / `pg_constraint` / `pg_policies` existence checks) and carries **no inner `BEGIN;`/`COMMIT;`** — `autoMigrate` wraps each file in `client.begin(...)`.
- The migration **writes no rows**. It therefore needs **no** `SELECT set_config('breeze.scope','system',true);` preamble and **must NOT** be added to the frozen baseline in `apps/api/src/db/migrationRlsScope.test.ts` (#4518 — raising that baseline is never the fix). If a later edit adds an `UPDATE`/`INSERT`/`DELETE`, the `set_config` call goes first in the file.
- **Never edit a shipped migration.** Fix forward. Renaming an unmerged migration is fine; renaming a merged one is not.
- **Every composite FK whose REFERENCED columns include `org_id` is `DEFERRABLE INITIALLY IMMEDIATE`** (`orgLifecycleFoundations.integration.test.ts:39` reads `pg_constraint.confkey` on `confrelid`). That is the three FKs `(customer_id, org_id) → backup_provider_customers(id, org_id)`, `(breeze_device_id, org_id) → devices(id, org_id)` and `(provider_device_id, org_id) → backup_provider_devices(id, org_id)`; the spec also asks for `(org_id, partner_id) → organizations(id, partner_id)` to be deferrable, and this plan honours that.
- **The device link FK uses the PG15+ column-list form `ON DELETE SET NULL (breeze_device_id)`.** A bare composite `SET NULL` nulls every referencing column, `org_id` included, and `org_id` is `NOT NULL` — a device hard-delete would raise 23502 mid-way through GDPR org erasure (#4100). Precedent: `2026-10-16-170200-m365-tenant-sync-foundation.sql:314-319`.
- **Nine registration lists.** A new tenant table is not done until each that applies is updated, in the same PR:
  1. `PARTNER_TENANT_TABLES` — `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:186` (connections, customers).
  2. `ORG_AXIS_POLICY_EXCLUDED_TABLES` — same file, `:124` (customers only; it carries `org_id` but is partner-axis).
  3. `CORE_ORG_CASCADE_DELETE_ORDER` — `apps/api/src/services/tenantCascade.ts:229` (the three `org_id` tables, alphabetised by `localeCompare`).
  4. `CORE_TENANT_EXPORT_POLICY` — `apps/api/src/services/tenantExportPolicyRegistry.ts` (the same three; **every column** classified; `vendor_raw` is `jsonb` → `excludedOpen`).
  5. `REPOINT_TABLES` — `apps/api/src/services/orgMergeRegistry.ts:638` (the same three).
  6. `encryptedColumnRegistry` — `apps/api/src/services/encryptedColumnRegistry.ts:74` (`backup_provider_connections.credentials_encrypted`, `aadBinding: 'row'`).
  7. `apps/api/src/routes/devices/cascadeDelete.test.ts` — a `backup_provider_devices` column-name case mirroring the `m365_intune_devices` one at `:244`.
  8. `apps/api/src/routes/devices/moveOrg.ts` — the synchronous link detach beside the Intune one at `:367-371`, plus the statement-order assertion in `moveOrg.test.ts:1279`.
  9. `SELF_MANAGED_DB_CONTEXT_ROUTES` — `apps/api/src/middleware/selfManagedDbContextRoutes.ts:30-256`, for the three routes that make a real Cove HTTP call, plus `selfManagedDbContextRoutes.test.ts`.
  **Not** needed, each verified: `CORE_DEVICE_CASCADE_DELETE_TABLES` / `CORE_DEVICE_ORG_DENORMALIZED_TABLES` / `DEVICE_DETACH_DEVICE_ID_TABLES` / `DEVICE_LINKED_DEVICE_ID_TABLES` (all discover by a column literally named `device_id` or `linked_device_id`); `AUDIT_ADMIN_REQUIRED_TABLES` (nothing here is append-only); `DEVICE_ID_JOIN_POLICY_TABLES` / `DUAL_AXIS_TENANT_TABLES` / `USER_ID_SCOPED_TABLES` / `ORG_ID_KEYED_TENANT_TABLES` (wrong shapes); `ORG_CASCADE_FK_UNSAFE` / `ORG_CASCADE_FK_PRE_CLEARED` in `orgCascadeFkOnDeleteAllowlist.ts` (every FK this wave adds classifies safe — see Task 1 Step 8); the partner purge (`cascadeDeletePartner`) auto-discovers `partner_id` columns from `information_schema`, so it needs no list entry, only the `GRANT … DELETE` the migration issues.
- **Every route runs inside the request `withDbAccessContext` transaction opened by `authMiddleware`** — except the three registered in `SELF_MANAGED_DB_CONTEXT_ROUTES`, which get **no** ambient context and must open their own short ones with `withAuthDbAccessContext(auth, fn)` (`apps/api/src/middleware/auth.ts:516`). Never call `runOutsideDbContext(() => withSystemDbAccessContext(...))` from a route handler.
- **A caught Postgres error poisons the ambient request transaction.** Mapping 23503 → 422 (device link, customer mapping) only works if the offending write is wrapped in a nested `db.transaction(async (tx) => …)` (a savepoint); otherwise the handler returns 422 and the commit then rethrows as a raw 500. Pre-check with a SELECT *and* keep the savepointed catch as the concurrent-writer backstop, and prove it with a live-DB route test, not Drizzle mocks.
- **Credentials are row-bound.** `encryptProviderCredentials(connectionId, creds)` seals under AAD `backup_provider_connections.credentials_encrypted:<row id>`, so the route **must generate the row id before encrypting** (`crypto.randomUUID()`), exactly as `services/toolSources/secrets.ts` does. No route ever returns `credentials_encrypted`; the wire shape carries `hasCredentials: boolean` instead. The client never logs credentials or visas.
- **Run one test file as `cd apps/api && npx vitest run <path>`** — never `pnpm --filter @breeze/api test -- --run <path>`: pnpm forwards the literal `--`, vitest stops flag parsing there, `--run` is swallowed as a positional filter, and the whole 1,470-file suite runs in watch mode. The vitest path filter is a plain substring match, not a glob: `npx vitest run src/routes/backup/providers` matches `providers.ts`'s siblings too — check the reported file count.
- **Integration suites need a live stack:** `pnpm test-stack up` once for the wave, `pnpm test-stack down` at the end (nothing reaps it for you), and run as `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`. This wave adds tables to the org cascade, so `rls-coverage`, `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgMergeRegistry`, `orgCascadeFkOnDelete` and `orgLifecycleFoundations` all run before the PR, always.
- Branch `feature/6008-backup-provider-integration/wave-6009`; PR body contains `Closes #6009`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Keep files under ~500 lines.** `routes/backup/providers.ts` is a hub that mounts sub-routers; per-resource route files sit beside it. `routes/backup/` is already 24,817 lines across 57 files — do not grow any existing file.
- No web work in this wave, so the `runAction` rule and the locale-parity requirement do not bite here; W03 owns both. (Stated because the wave brief's checklist includes them: there is deliberately **zero** `apps/web` change in W01.)
- Stacked branches get **no** `pull_request` CI run. This wave targets `main`, so its PR does get one; W02/W03 stacked on it must `gh workflow run CI --ref <branch>` before enqueueing.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-17-120000-backup-provider-integration.sql` | enum + four tables + indexes + composite FKs + RLS enable/force/policies + grants (DDL only) |
| `apps/api/src/db/schema/backupProviders.ts` | Drizzle definitions for all four tables and the enum |
| `apps/api/src/db/schema/index.ts` | export the new schema module from the barrel |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | `PARTNER_TENANT_TABLES` + `ORG_AXIS_POLICY_EXCLUDED_TABLES` entries |
| `apps/api/src/services/tenantCascade.ts` | three `CORE_ORG_CASCADE_DELETE_ORDER` entries |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | three `CORE_TENANT_EXPORT_POLICY` entries, every column classified |
| `apps/api/src/services/orgMergeRegistry.ts` | three `REPOINT_TABLES` entries |
| `apps/api/src/services/encryptedColumnRegistry.ts` | `backup_provider_connections.credentials_encrypted`, `aadBinding: 'row'` |
| `apps/api/src/routes/devices/cascadeDelete.test.ts` | `backup_provider_devices` link-column contract case |
| `apps/api/src/routes/devices/moveOrg.ts` | synchronous `breeze_device_id` detach before the org flip |
| `apps/api/src/routes/devices/moveOrg.test.ts` | statement-order assertion extended for the new detach |
| `apps/api/src/middleware/selfManagedDbContextRoutes.ts` (+ `.test.ts`) | the three Cove-HTTP routes opt out of the ambient request transaction |
| `packages/shared/src/types/backupHealth.ts` | `ExternalBackupStatus`, `BackupHealth`, `BackupRecency`, `BackupHealthRow`, `BackupHealthSummary`, `BackupProviderAlertCondition` |
| `packages/shared/src/utils/backupHealth.ts` (+ `.test.ts`) | `deriveBackupHealth`, `worstBackupStatus`, `mapBackupJobStatus`, severity table, thresholds, the overview status buckets (`BACKUP_STATUS_BUCKET_IDS` / `_MEMBERS` / `bucketForBackupStatus`) |
| `packages/shared/src/types/index.ts`, `packages/shared/src/utils/index.ts` | barrel exports |
| `apps/api/src/services/backupProviders/types.ts` | `BackupProviderAdapter`, `VendorCustomer`, `VendorDevice`, `ProviderRequestError`, `ProviderTestResult` |
| `apps/api/src/services/backupProviders/registry.ts` (+ `.test.ts`) | `BACKUP_PROVIDER_KEYS`, `getBackupProvider` |
| `apps/api/src/services/backupProviders/credentials.ts` (+ `.test.ts`) | row-bound encrypt/decrypt of the credential blob |
| `apps/api/src/services/backupProviders/cove/columns.ts` (+ `.test.ts`) | column codes, `Settings[]` parser, `F00`/`I32`/`I59`/`I78` normalizers, `coveRowToVendorDevice` |
| `apps/api/src/services/backupProviders/cove/client.ts` (+ `.test.ts`) | `CoveJsonRpcClient` — visa chaining, one re-login, pagination, abort-on-page-failure |
| `apps/api/src/services/backupProviders/cove/adapter.ts` (+ `.test.ts`) | `coveCredentialsSchema`, `coveAdapter` |
| `apps/api/src/services/backupProviders/cove/__fixtures__/*.json` | seven recorded Cove responses (login, partner tree, statistics page, M365 row, missing-`D09F00` row, visa-expired, rejected login) |
| `apps/api/src/jobs/backupProviderSync.ts` (+ `.test.ts`) | queue handle + `enqueueBackupProviderSync` (W02 adds the worker to this file) |
| `apps/api/src/services/backupProviders/alertsResolve.ts` (+ `.test.ts`) | `BACKUP_PROVIDER_ALERT_SOURCE`, `resolveProviderAlertsForConnection`, `resolveProviderAlertsForCustomer` |
| `apps/api/src/services/backupProviders/mapping.ts` (+ `.test.ts`) | `remapCustomer` — atomic unmap/remap |
| `apps/api/src/routes/backup/providerAccess.ts` (+ `.test.ts`) | partner-scope gate + row serializers shared by the three route files |
| `apps/api/src/routes/backup/providers.ts` (+ `.test.ts`) | hub + connection CRUD / test / sync-now |
| `apps/api/src/routes/backup/providerCustomers.ts` (+ `.test.ts`) | customer listing + `PUT /customers/:id/mapping` |
| `apps/api/src/routes/backup/providerDevices.ts` (+ `.test.ts`) | device listing + `PUT /devices/:id/link` |
| `apps/api/src/routes/backup/index.ts` | mount `backupProviderRoutes` |
| `apps/api/src/__tests__/integration/backupProviderRls.integration.test.ts` | schema invariants, cross-tenant forge, cascade, erasure, merge, device org move, remap, HTTP-level 422 |

---

### Task 1: Migration — enum, four tables, composite tenant FKs, RLS

**Files:**
- Create: `apps/api/migrations/2026-10-17-120000-backup-provider-integration.sql`
- Read first (do not modify): `apps/api/migrations/2026-06-12-a-huntress-partner-mapping.sql` (the `huntress_integrations` partner-isolation block at its end, and the `huntress_org_mappings` block with the `EXISTS` parent re-check), `apps/api/migrations/0049-huntress-integration.sql:82-96` (the `huntress_agents` org-isolation block), `apps/api/migrations/2026-10-16-170200-m365-tenant-sync-foundation.sql:289-360` (the composite-FK + RLS + GRANT shape), `apps/api/migrations/2026-10-16-193500-tool-sources.sql` (enum guard + CHECK guard idioms)

**Interfaces:**
- Produces Postgres type `external_backup_status` with labels, in order: `completed, completed_with_errors, failed, in_progress, interrupted, over_quota, no_selection, not_started, no_backups, unknown`.
- Produces tables `backup_provider_connections`, `backup_provider_customers`, `backup_provider_devices`, `backup_provider_device_history` with exactly the columns in the spec's Data model section.
- Produces constraint names later tasks and tests pin verbatim: `backup_provider_connections_status_chk`, `backup_provider_connections_last_sync_status_chk`, `backup_provider_connections_base_url_chk`, `backup_provider_connections_sync_interval_chk`, `backup_provider_customers_mapping_source_chk`, `backup_provider_customers_connection_partner_fk`, `backup_provider_customers_org_partner_fk`, `backup_provider_devices_connection_partner_fk`, `backup_provider_devices_customer_connection_fk`, `backup_provider_devices_customer_org_fk`, `backup_provider_devices_breeze_device_org_fk`, `backup_provider_devices_os_type_chk`, `backup_provider_devices_account_type_chk`, `backup_provider_devices_match_source_chk`, `backup_provider_device_history_device_org_fk`.
- Produces index names: `backup_provider_connections_id_partner_uniq`, `backup_provider_connections_partner_provider_name_uniq`, `backup_provider_connections_partner_idx`, `backup_provider_customers_connection_vendor_uniq`, `backup_provider_customers_id_connection_uniq`, `backup_provider_customers_id_org_uniq`, `backup_provider_customers_org_idx`, `backup_provider_customers_partner_idx`, `backup_provider_customers_connection_idx`, `backup_provider_devices_connection_vendor_uniq`, `backup_provider_devices_id_org_uniq`, `backup_provider_devices_breeze_device_uniq`, `backup_provider_devices_org_status_idx`, `backup_provider_devices_partner_status_idx`, `backup_provider_devices_org_breeze_device_idx`, `backup_provider_devices_customer_idx`, `backup_provider_devices_last_success_idx`, `backup_provider_device_history_device_day_uniq`, `backup_provider_device_history_org_day_idx`.
- Produces policies: `backup_provider_connections_{select,insert,update,delete}` and `backup_provider_customers_{select,insert,update,delete}` (partner-axis, four per-command policies — the Huntress shape), `backup_provider_devices_org_access` and `backup_provider_device_history_org_access` (one `FOR ALL` org-access policy each — the m365 shape; `pg_policies` reports `cmd = 'ALL'` and both rls-coverage assertions expand that to all four commands, `src/db/rlsPolicyShape.ts:128-144`).

- [ ] **Step 1: Confirm the filename still sorts last, and the FK targets exist**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration
ls apps/api/migrations | grep '\.sql$' | sort | tail -1
grep -rn 'devices_id_org_id_uniq\|organizations_id_partner' apps/api/migrations/*.sql | head -5
```
Expected: the newest committed migration sorts before `2026-10-17-120000-backup-provider-integration.sql` (as of 2026-09-15 it is `2026-10-17-094100-m365-signin-events.sql`). `devices_id_org_id_uniq` exists (`2026-07-23-partner-export-material-state-hardening.sql:38`) and `organizations_id_partner_uq` / `organizations_id_partner_id_unique` exist (`2026-04-11-users-rls.sql:77`, `2026-05-03-tenant-rls-force-and-invites.sql:7`) — the two composite FK targets this migration needs from other tables. If the newest committed migration sorts **after** the reserved name, rename upward (`2026-10-18-090000-…`) and use the new name everywhere below.

- [ ] **Step 2: Write the migration**

```sql
-- Backup Provider Integration W01 (feature #6008, wave #6009).
-- Spec: docs/superpowers/specs/integrations/2026-09-15-backup-provider-integration-cove-design.md
--       (Data model, Normalized status and health, Security).
--
-- Four tables behind a provider-neutral model for third-party backup status
-- (Cove Data Protection first). Shapes, per CLAUDE.md "Six tenancy shapes":
--
--   backup_provider_connections     shape 3 (partner axis). An MSP registers
--                                   one Cove console login once; there is no
--                                   org axis at all. Credentials live here.
--   backup_provider_customers       shape 3 (partner axis) WITH a denormalized
--                                   nullable org_id. org_id is the MAPPING
--                                   TARGET, not the tenancy axis — an
--                                   unmapped customer has org_id NULL and must
--                                   still be visible to the partner admin who
--                                   has to map it. Hence the
--                                   ORG_AXIS_POLICY_EXCLUDED_TABLES entry,
--                                   exactly as huntress_org_mappings.
--   backup_provider_devices         shape 1 (direct org_id, NOT NULL). Only
--                                   devices under a MAPPED customer are stored
--                                   (spec D8), so org_id is always known.
--                                   partner_id is denormalized for the
--                                   partner-wide overview scan and for the
--                                   composite FK to the connection; it is NOT
--                                   the tenancy axis.
--   backup_provider_device_history  shape 1. One observed-health row per
--                                   provider device per UTC day (spec D10).
--
-- The tenant chain is enforced in the DATABASE, not the app layer:
--   customer -> org of the SAME partner        (org_id, partner_id)   -> organizations(id, partner_id)
--   device   -> customer of the same connection (customer_id, connection_id) -> backup_provider_customers(id, connection_id)
--   device   -> customer of the same org        (customer_id, org_id)  -> backup_provider_customers(id, org_id)
--   ledger   -> device of the same org          (provider_device_id, org_id) -> backup_provider_devices(id, org_id)
--   link     -> Breeze device of the same org   (breeze_device_id, org_id)   -> devices(id, org_id)
--
-- Every composite FK whose REFERENCED columns include org_id is DEFERRABLE
-- INITIALLY IMMEDIATE: org merge runs SET CONSTRAINTS ALL DEFERRED and
-- re-points parent and child org_id in separate statements, so a
-- non-deferrable one aborts the merge with 23503
-- (orgLifecycleFoundations.integration.test.ts, "merge contract").
--
-- The Breeze device pointer is named breeze_device_id, NEVER device_id. A
-- column named device_id would enrol this table in
-- breeze_device_child_orgid_tables() (the generic `SET org_id` re-stamp loop
-- fired by the devices org-move trigger) and in cascadeDelete.test.ts's
-- device_id contract — both wrong for a LINK whose org_id derives from the
-- customer mapping, not from the device. Precedent and rationale:
-- m365_intune_devices (2026-10-16-170200-m365-tenant-sync-foundation.sql).
--
-- The link FK uses the PG15+ COLUMN-LIST form `ON DELETE SET NULL
-- (breeze_device_id)`. A bare SET NULL on a composite FK nulls EVERY
-- referencing column, org_id included — and org_id is NOT NULL, so deleting a
-- linked device would raise 23502 and abort GDPR org erasure part-way through
-- (#4100). orgCascadeFkOnDelete.integration.test.ts reads
-- pg_constraint.confdelsetcols and fails any set-null-onto-not-null edge.
--
-- backup_provider_connections.created_by is ON DELETE SET NULL on purpose:
-- `users` IS in the org-erasure protected set, this table is NOT (no org_id),
-- so a NO ACTION edge would be a latent erasure blocker requiring an
-- ORG_CASCADE_FK_UNSAFE ledger entry. SET NULL onto a nullable column is safe
-- by classifier branch (b) and needs no ledger line.
--
-- `backup_provider` (an existing enum, 0001-baseline.sql:224) names the
-- STORAGE DESTINATION of first-party backups (local|s3|azure_blob|...). It is
-- unrelated to these tables and is deliberately not reused; the new status
-- type is `external_backup_status`.
--
-- Idempotent throughout (IF NOT EXISTS / DO $$ guards / DROP POLICY IF EXISTS
-- + CREATE); re-applying is a no-op. No inner BEGIN/COMMIT — autoMigrate wraps
-- each file in a transaction.
--
-- DDL ONLY: no INSERT/UPDATE/DELETE anywhere in this file, so there is
-- deliberately NO `SELECT set_config('breeze.scope','system',true)` preamble
-- and this file must NOT be added to the frozen baseline in
-- apps/api/src/db/migrationRlsScope.test.ts (#4518).
--
-- The GRANTs are unguarded on purpose (repo default). A pg_roles existence
-- guard would turn a missing breeze_app role into a SILENT success; bare, it
-- aborts the run loudly with 42704.
--
-- Rollback: a new migration dropping the four tables and the enum. Nothing
-- reads them before this wave's code.

-- ---------------------------------------------------------------------------
-- 1. Normalized status enum
-- ---------------------------------------------------------------------------
--
-- Label ORDER is part of the contract: packages/shared exports
-- EXTERNAL_BACKUP_STATUSES in this exact order and an integration test compares
-- the two. ALTER TYPE ... ADD VALUE appends, so a future vendor's extra status
-- lands at the end and the tuple must be extended the same way.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'external_backup_status') THEN
    CREATE TYPE external_backup_status AS ENUM (
      'completed',
      'completed_with_errors',
      'failed',
      'in_progress',
      'interrupted',
      'over_quota',
      'no_selection',
      'not_started',
      'no_backups',
      'unknown'
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. backup_provider_connections — one MSP-level vendor connection (shape 3)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backup_provider_connections (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id                   uuid NOT NULL REFERENCES partners(id),
  -- Open string, not an enum: the adapter registry validates it
  -- (services/backupProviders/registry.ts). A second vendor must not need a
  -- migration to add its key.
  provider                     varchar(30) NOT NULL,
  name                         varchar(200) NOT NULL,
  base_url                     varchar(300) NOT NULL DEFAULT 'https://api.backup.management/jsonapi',
  -- encryptSecret(JSON.stringify(creds)) with AAD bound to THIS row's id
  -- (encryptedColumnRegistry aadBinding: 'row'), so a ciphertext pasted into
  -- another partner's row does not decrypt.
  credentials_encrypted        text NOT NULL,
  vendor_root_id               varchar(120),
  vendor_root_name             varchar(255),
  is_active                    boolean NOT NULL DEFAULT true,
  status                       varchar(20) NOT NULL DEFAULT 'connected',
  sync_interval_minutes        integer NOT NULL DEFAULT 30,
  show_provider_name_in_portal boolean NOT NULL DEFAULT false,
  last_sync_at                 timestamptz,
  last_sync_status             varchar(20),
  last_sync_error              text,
  last_sync_customers          integer,
  last_sync_unmapped_customers integer,
  last_sync_devices            integer,
  last_sync_unmapped_devices   integer,
  last_sync_linked_devices     integer,
  last_sync_ambiguous_devices  integer,
  -- SET NULL, not NO ACTION: see the header note on org erasure.
  created_by                   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backup_provider_connections_status_chk' AND conrelid = 'backup_provider_connections'::regclass) THEN
    ALTER TABLE backup_provider_connections ADD CONSTRAINT backup_provider_connections_status_chk
      CHECK (status IN ('connected', 'error', 'reauth_required'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backup_provider_connections_last_sync_status_chk' AND conrelid = 'backup_provider_connections'::regclass) THEN
    ALTER TABLE backup_provider_connections ADD CONSTRAINT backup_provider_connections_last_sync_status_chk
      CHECK (last_sync_status IS NULL OR last_sync_status IN ('running', 'success', 'partial', 'error'));
  END IF;
  -- Outbound calls only to base_url, and an override must be https (spec,
  -- Security). The route validates the URL properly; this is the structural
  -- backstop against a plaintext endpoint reaching the sync worker.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backup_provider_connections_base_url_chk' AND conrelid = 'backup_provider_connections'::regclass) THEN
    ALTER TABLE backup_provider_connections ADD CONSTRAINT backup_provider_connections_base_url_chk
      CHECK (base_url LIKE 'https://%');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backup_provider_connections_sync_interval_chk' AND conrelid = 'backup_provider_connections'::regclass) THEN
    ALTER TABLE backup_provider_connections ADD CONSTRAINT backup_provider_connections_sync_interval_chk
      CHECK (sync_interval_minutes BETWEEN 5 AND 1440);
  END IF;
END $$;

-- (id, partner_id) is the composite FK target children use to pin themselves
-- to the SAME partner as their connection.
CREATE UNIQUE INDEX IF NOT EXISTS backup_provider_connections_id_partner_uniq
  ON backup_provider_connections (id, partner_id);
-- Several connections per provider are allowed (acquisitions), distinguished
-- by name.
CREATE UNIQUE INDEX IF NOT EXISTS backup_provider_connections_partner_provider_name_uniq
  ON backup_provider_connections (partner_id, provider, name);
CREATE INDEX IF NOT EXISTS backup_provider_connections_partner_idx
  ON backup_provider_connections (partner_id);

-- ---------------------------------------------------------------------------
-- 3. backup_provider_customers — discovered vendor customers + org mapping
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backup_provider_customers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id        uuid NOT NULL,
  partner_id           uuid NOT NULL REFERENCES partners(id),
  vendor_customer_id   varchar(128) NOT NULL,
  vendor_customer_name varchar(255) NOT NULL,
  vendor_parent_id     varchar(128),
  vendor_level         varchar(40),
  vendor_external_code varchar(255),
  -- NULL = discovered but not yet mapped. Its devices are counted, never
  -- stored (spec D8).
  org_id               uuid REFERENCES organizations(id) ON DELETE SET NULL,
  -- manual | auto_name | auto_external_code | manual_unmapped | NULL
  mapping_source       varchar(20),
  device_count         integer NOT NULL DEFAULT 0,
  last_seen_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backup_provider_customers_mapping_source_chk' AND conrelid = 'backup_provider_customers'::regclass) THEN
    ALTER TABLE backup_provider_customers ADD CONSTRAINT backup_provider_customers_mapping_source_chk
      CHECK (mapping_source IS NULL OR mapping_source IN ('manual', 'auto_name', 'auto_external_code', 'manual_unmapped'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS backup_provider_customers_connection_vendor_uniq
  ON backup_provider_customers (connection_id, vendor_customer_id);
-- Two composite FK targets for backup_provider_devices: one pins the device to
-- its customer's CONNECTION, the other to its customer's ORG.
CREATE UNIQUE INDEX IF NOT EXISTS backup_provider_customers_id_connection_uniq
  ON backup_provider_customers (id, connection_id);
CREATE UNIQUE INDEX IF NOT EXISTS backup_provider_customers_id_org_uniq
  ON backup_provider_customers (id, org_id);
CREATE INDEX IF NOT EXISTS backup_provider_customers_org_idx
  ON backup_provider_customers (org_id);
CREATE INDEX IF NOT EXISTS backup_provider_customers_partner_idx
  ON backup_provider_customers (partner_id);
CREATE INDEX IF NOT EXISTS backup_provider_customers_connection_idx
  ON backup_provider_customers (connection_id);

DO $$ BEGIN
  ALTER TABLE backup_provider_customers
    ADD CONSTRAINT backup_provider_customers_connection_partner_fk
    FOREIGN KEY (connection_id, partner_id)
    REFERENCES backup_provider_connections(id, partner_id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A customer may only map to an organization of the SAME partner. Deferrable
-- because the REFERENCED side is (id, partner_id) on organizations and the
-- spec pins it; the merge executor's SET CONSTRAINTS ALL DEFERRED then covers
-- it for free alongside the org_id-referencing FKs below.
DO $$ BEGIN
  ALTER TABLE backup_provider_customers
    ADD CONSTRAINT backup_provider_customers_org_partner_fk
    FOREIGN KEY (org_id, partner_id)
    REFERENCES organizations(id, partner_id)
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 4. backup_provider_devices — one vendor device under a MAPPED customer
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backup_provider_devices (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id             uuid NOT NULL,
  partner_id                uuid NOT NULL REFERENCES partners(id),
  org_id                    uuid NOT NULL REFERENCES organizations(id),
  customer_id               uuid NOT NULL,
  -- Denormalized from the connection so an ORG-scoped reader (the client
  -- portal) can label the row without reading the partner-axis connection
  -- table it has no RLS access to.
  provider                  varchar(30) NOT NULL,
  portal_show_provider_name boolean NOT NULL DEFAULT false,
  vendor_device_id          varchar(128) NOT NULL,
  vendor_device_name        varchar(255) NOT NULL,
  computer_name             varchar(255),
  os_type                   varchar(20) NOT NULL DEFAULT 'unknown',
  os_version                varchar(255),
  client_version            varchar(64),
  -- lower-case colon-separated, normalized by the adapter.
  mac_addresses             text[] NOT NULL DEFAULT '{}',
  account_type              varchar(20) NOT NULL DEFAULT 'unknown',
  data_sources              text[] NOT NULL DEFAULT '{}',
  status                    external_backup_status NOT NULL DEFAULT 'unknown',
  vendor_status_code        integer,
  last_session_at           timestamptz,
  last_success_at           timestamptz,
  last_completed_at         timestamptz,
  selected_bytes            bigint,
  used_bytes                bigint,
  errors_count              integer NOT NULL DEFAULT 0,
  -- LINK, not ownership. Never rename to device_id (see the header).
  breeze_device_id          uuid,
  device_match_source       varchar(20),
  -- The alert condition observed on the PREVIOUS sync, for W02's two-poll
  -- hysteresis. Written by the sync worker only.
  pending_condition         varchar(30),
  vendor_created_at         timestamptz,
  vendor_expires_at         timestamptz,
  first_seen_at             timestamptz NOT NULL DEFAULT now(),
  last_seen_at              timestamptz NOT NULL DEFAULT now(),
  -- Full vendor Settings map for debugging and future columns. jsonb, so it is
  -- excludedOpen in the tenant export policy by the container rule.
  vendor_raw                jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backup_provider_devices_os_type_chk' AND conrelid = 'backup_provider_devices'::regclass) THEN
    ALTER TABLE backup_provider_devices ADD CONSTRAINT backup_provider_devices_os_type_chk
      CHECK (os_type IN ('workstation', 'server', 'unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backup_provider_devices_account_type_chk' AND conrelid = 'backup_provider_devices'::regclass) THEN
    ALTER TABLE backup_provider_devices ADD CONSTRAINT backup_provider_devices_account_type_chk
      CHECK (account_type IN ('backup_manager', 'm365', 'unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backup_provider_devices_match_source_chk' AND conrelid = 'backup_provider_devices'::regclass) THEN
    ALTER TABLE backup_provider_devices ADD CONSTRAINT backup_provider_devices_match_source_chk
      CHECK (device_match_source IS NULL OR device_match_source IN ('auto_hostname', 'auto_mac', 'manual'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS backup_provider_devices_connection_vendor_uniq
  ON backup_provider_devices (connection_id, vendor_device_id);
-- Composite FK target for the daily ledger.
CREATE UNIQUE INDEX IF NOT EXISTS backup_provider_devices_id_org_uniq
  ON backup_provider_devices (id, org_id);
-- One provider row per Breeze device. A device backed up by two connections
-- (post-acquisition) links to the first; the second stays unlinked and is
-- counted in last_sync_ambiguous_devices. Relaxing this later is a one-line
-- index change.
CREATE UNIQUE INDEX IF NOT EXISTS backup_provider_devices_breeze_device_uniq
  ON backup_provider_devices (breeze_device_id)
  WHERE breeze_device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS backup_provider_devices_org_status_idx
  ON backup_provider_devices (org_id, status);
CREATE INDEX IF NOT EXISTS backup_provider_devices_partner_status_idx
  ON backup_provider_devices (partner_id, status);
CREATE INDEX IF NOT EXISTS backup_provider_devices_org_breeze_device_idx
  ON backup_provider_devices (org_id, breeze_device_id);
CREATE INDEX IF NOT EXISTS backup_provider_devices_customer_idx
  ON backup_provider_devices (customer_id);
CREATE INDEX IF NOT EXISTS backup_provider_devices_last_success_idx
  ON backup_provider_devices (last_success_at);

DO $$ BEGIN
  ALTER TABLE backup_provider_devices
    ADD CONSTRAINT backup_provider_devices_connection_partner_fk
    FOREIGN KEY (connection_id, partner_id)
    REFERENCES backup_provider_connections(id, partner_id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE backup_provider_devices
    ADD CONSTRAINT backup_provider_devices_customer_connection_fk
    FOREIGN KEY (customer_id, connection_id)
    REFERENCES backup_provider_customers(id, connection_id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The row's org MUST equal its customer's mapped org. Deferrable: the
-- REFERENCED columns include org_id.
DO $$ BEGIN
  ALTER TABLE backup_provider_devices
    ADD CONSTRAINT backup_provider_devices_customer_org_fk
    FOREIGN KEY (customer_id, org_id)
    REFERENCES backup_provider_customers(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- COLUMN-LIST form on purpose (PG15+; precedent
-- 2026-10-16-170200-m365-tenant-sync-foundation.sql:314). A bare SET NULL on
-- this composite FK would null org_id too, which is NOT NULL -> 23502 mid-way
-- through org erasure.
DO $$ BEGIN
  ALTER TABLE backup_provider_devices
    ADD CONSTRAINT backup_provider_devices_breeze_device_org_fk
    FOREIGN KEY (breeze_device_id, org_id)
    REFERENCES devices(id, org_id)
    ON DELETE SET NULL (breeze_device_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 5. backup_provider_device_history — observed daily health (28-day bar)
-- ---------------------------------------------------------------------------
--
-- OBSERVED health, not session history: a day with no poll is a GAP (rendered
-- grey), and a failed session seen by 40 polls is ONE failed day, not 40
-- failures. Nothing downstream may count these rows as jobs.
CREATE TABLE IF NOT EXISTS backup_provider_device_history (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_device_id uuid NOT NULL,
  org_id             uuid NOT NULL REFERENCES organizations(id),
  day                date NOT NULL,
  status             external_backup_status NOT NULL,
  last_success_at    timestamptz,
  errors_count       integer NOT NULL DEFAULT 0,
  observations       integer NOT NULL DEFAULT 1,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS backup_provider_device_history_device_day_uniq
  ON backup_provider_device_history (provider_device_id, day);
CREATE INDEX IF NOT EXISTS backup_provider_device_history_org_day_idx
  ON backup_provider_device_history (org_id, day);

DO $$ BEGIN
  ALTER TABLE backup_provider_device_history
    ADD CONSTRAINT backup_provider_device_history_device_org_fk
    FOREIGN KEY (provider_device_id, org_id)
    REFERENCES backup_provider_devices(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 6. RLS — partner axis on the two MSP-level tables
-- ---------------------------------------------------------------------------
--
-- Four per-command policies, copied from the huntress_integrations /
-- huntress_org_mappings blocks (2026-06-12-a-huntress-partner-mapping.sql).
-- The customers INSERT/UPDATE WITH CHECK additionally re-checks that the
-- parent connection really belongs to the claimed partner, so a forged
-- (connection_id of partner A, partner_id of partner B) row is rejected by the
-- policy as well as by the composite FK.
ALTER TABLE backup_provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_provider_connections FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS backup_provider_connections_select ON backup_provider_connections;
DROP POLICY IF EXISTS backup_provider_connections_insert ON backup_provider_connections;
DROP POLICY IF EXISTS backup_provider_connections_update ON backup_provider_connections;
DROP POLICY IF EXISTS backup_provider_connections_delete ON backup_provider_connections;

CREATE POLICY backup_provider_connections_select ON backup_provider_connections
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY backup_provider_connections_insert ON backup_provider_connections
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY backup_provider_connections_update ON backup_provider_connections
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY backup_provider_connections_delete ON backup_provider_connections
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON backup_provider_connections TO breeze_app;

ALTER TABLE backup_provider_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_provider_customers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS backup_provider_customers_select ON backup_provider_customers;
DROP POLICY IF EXISTS backup_provider_customers_insert ON backup_provider_customers;
DROP POLICY IF EXISTS backup_provider_customers_update ON backup_provider_customers;
DROP POLICY IF EXISTS backup_provider_customers_delete ON backup_provider_customers;

CREATE POLICY backup_provider_customers_select ON backup_provider_customers
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY backup_provider_customers_insert ON backup_provider_customers
  FOR INSERT WITH CHECK (
    public.breeze_has_partner_access(partner_id)
    AND EXISTS (
      SELECT 1
      FROM backup_provider_connections c
      WHERE c.id = backup_provider_customers.connection_id
        AND c.partner_id = backup_provider_customers.partner_id
    )
  );
CREATE POLICY backup_provider_customers_update ON backup_provider_customers
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (
    public.breeze_has_partner_access(partner_id)
    AND EXISTS (
      SELECT 1
      FROM backup_provider_connections c
      WHERE c.id = backup_provider_customers.connection_id
        AND c.partner_id = backup_provider_customers.partner_id
    )
  );
CREATE POLICY backup_provider_customers_delete ON backup_provider_customers
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON backup_provider_customers TO breeze_app;

-- ---------------------------------------------------------------------------
-- 7. RLS — org axis on the two device-level tables
-- ---------------------------------------------------------------------------
--
-- ONE FOR ALL policy per table rather than four per-command ones: pg_policies
-- reports cmd = 'ALL', and both rls-coverage assertions expand that to all
-- four DML commands (src/db/rlsPolicyShape.ts:128-144). Same shape as the
-- m365 sync tables.
--
-- NOTE the axis: these rows are readable by an ORG token (the device tab, the
-- client portal) and by a PARTNER token through breeze_has_org_access's
-- accessible-org set. partner_id on the row is denormalization for the
-- overview scan and the composite FK, NEVER a second read branch — adding one
-- would let a partner-scoped token with restricted org access read every org's
-- rows.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['backup_provider_devices', 'backup_provider_device_history'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = t
        AND policyname = t || '_org_access'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL '
        || 'USING (public.breeze_has_org_access(org_id)) '
        || 'WITH CHECK (public.breeze_has_org_access(org_id))',
        t || '_org_access', t);
    END IF;

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.%I TO breeze_app', t);
  END LOOP;
END $$;
```

- [ ] **Step 3: Run the naming guard and the RLS-scope guard**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration
scripts/check-migration-naming.sh
git add apps/api/migrations/2026-10-17-120000-backup-provider-integration.sql
scripts/check-migration-naming.sh --staged
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```
Expected: `check-migration-naming: OK` twice, and both vitest files PASS (2 files). `migrationRlsScope.test.ts` passes **without** a baseline entry because the file contains no DML — if it fails with "new unscoped DML offender", you accidentally wrote a row-writing statement; remove it rather than adding a baseline line.

- [ ] **Step 4: Bring up the worktree test stack and apply the migration twice**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration
pnpm test-stack up          # once for the whole wave
export DATABASE_URL="$(grep '^DATABASE_URL=' .env.test | cut -d= -f2-)"
cd apps/api && pnpm db:migrate && pnpm db:migrate
```
Expected: the first run applies `2026-10-17-120000-backup-provider-integration.sql`; the second prints no error and applies nothing (idempotent). Any `duplicate_object` / `already exists` error on the second pass is a missing guard.

- [ ] **Step 5: Verify the enum, the deferrability and the SET NULL column list**

Run:
```bash
docker exec -i "$(docker ps --format '{{.Names}}' | grep -m1 postgres)" psql -U breeze -d breeze -c "
SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typname = 'external_backup_status' ORDER BY e.enumsortorder;"
docker exec -i "$(docker ps --format '{{.Names}}' | grep -m1 postgres)" psql -U breeze -d breeze -c "
SELECT conname, condeferrable, confdeltype,
       (SELECT array_agg(a.attname) FROM unnest(con.confdelsetcols) c(attnum)
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = c.attnum) AS setcols
FROM pg_constraint con
WHERE conname LIKE 'backup_provider%fk' ORDER BY conname;"
```
Expected: ten enum labels in the order written above. Five FK rows; `backup_provider_devices_breeze_device_org_fk` has `condeferrable = t`, `confdeltype = n`, `setcols = {breeze_device_id}`; `backup_provider_devices_customer_org_fk`, `backup_provider_device_history_device_org_fk` and `backup_provider_customers_org_partner_fk` all have `condeferrable = t`.

- [ ] **Step 6: Forge a cross-tenant insert as `breeze_app`**

Run:
```bash
docker exec -i "$(docker ps --format '{{.Names}}' | grep -m1 postgres)" psql -U breeze_app -d breeze -c "
INSERT INTO backup_provider_connections (partner_id, provider, name, credentials_encrypted)
VALUES (gen_random_uuid(), 'cove', 'forged', 'x');"
docker exec -i "$(docker ps --format '{{.Names}}' | grep -m1 postgres)" psql -U breeze_app -d breeze -c "
INSERT INTO backup_provider_devices (connection_id, partner_id, org_id, customer_id, provider, vendor_device_id, vendor_device_name)
VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'cove', 'v1', 'forged');"
```
Expected: both fail. `new row violates row-level security policy for table "backup_provider_connections"` / `... "backup_provider_devices"` is the pass (a foreign-key violation would mean RLS let it through and the FK caught it — re-run with real in-tenant parents to see RLS specifically).

- [ ] **Step 7: Prove the org-erasure FK classifier is satisfied with no ledger entry**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
```
Expected: both PASS with **no** edit to `orgCascadeFkOnDeleteAllowlist.ts`. Why each of the seven new edges classifies safe:
- `backup_provider_connections.created_by → users` — `SET NULL` onto a nullable column, branch (b).
- `backup_provider_customers.org_id → organizations` (simple, `SET NULL`) — branch (b).
- `backup_provider_customers (org_id, partner_id) → organizations` — both ends in the cascade set, branch (d).
- `backup_provider_devices.org_id → organizations` and `backup_provider_device_history.org_id → organizations` — branch (d).
- `backup_provider_devices (customer_id, org_id)` / `(customer_id, connection_id)` and `backup_provider_device_history (provider_device_id, org_id)` — `CASCADE`, branch (a).
- `backup_provider_devices (breeze_device_id, org_id) → devices` — `SET NULL` with `confdelsetcols = {breeze_device_id}`, nullable, branch (b).
The edges into `partners` and into `backup_provider_connections` are not audited at all: neither parent is in the org-erasure protected set.
If `orgCascadeFkOnDelete` reports an unpinned FK, **fix the FK's ON DELETE** — do not add a ledger line.

- [ ] **Step 8: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration
git add apps/api/migrations/2026-10-17-120000-backup-provider-integration.sql
git commit -m "$(cat <<'EOF'
feat(integrations): backup provider tables, enum, composite tenant FKs and RLS (#6008 W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Drizzle schema + barrel export

**Files:**
- Create: `apps/api/src/db/schema/backupProviders.ts`
- Modify: `apps/api/src/db/schema/index.ts` (append after `export * from './toolSources';`, currently the last line at `:167`)
- Read first: `apps/api/src/db/schema/huntress.ts` (style, `foreignKey()` composite declarations), `apps/api/src/db/schema/m365Sync.ts:156-172` (the `breezeDeviceId` rationale comment to adapt)

**Interfaces:**
- Produces `externalBackupStatusEnum`, `EXTERNAL_BACKUP_STATUS_ENUM_VALUES`, `backupProviderConnections`, `backupProviderCustomers`, `backupProviderDevices`, `backupProviderDeviceHistory`, and the four `typeof …$inferSelect` aliases `BackupProviderConnectionRow`, `BackupProviderCustomerRow`, `BackupProviderDeviceRow`, `BackupProviderDeviceHistoryRow`.
- Consumes `organizations`, `partners` (`./orgs`), `users` (`./users`), `devices` (`./devices`), and `ExternalBackupStatus` from `@breeze/shared` (Task 5) — **so Task 5 must land before this file typechecks**; see the ordering note below.

> **Ordering note.** Task 5 (shared types) ships before this task in the commit sequence used here, because `backupProviders.ts` imports `ExternalBackupStatus` for its `$type<>()` annotations. Execute Task 5 first if you are running tasks strictly in order; the numbering below keeps schema-first reading order for humans, and the commit list at the end of Task 5 notes the dependency.

- [ ] **Step 1: Write the failing test**

There is no co-located unit test for a Drizzle schema file in this repo; the schema's contract is asserted by `apps/api/src/routes/devices/cascadeDelete.test.ts` (Task 4) and the integration suite (Task 14). The *failing* check for this task is the typecheck of the consumers. Write it as a one-line probe first:

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
node -e "const s=require('fs').readFileSync('src/db/schema/index.ts','utf8'); process.exit(s.includes('./backupProviders') ? 0 : 1)" || echo "NOT EXPORTED (expected at this point)"
```

- [ ] **Step 2: Run it to verify it fails**

Run the command above.
Expected: prints `NOT EXPORTED (expected at this point)`.

- [ ] **Step 3: Write `apps/api/src/db/schema/backupProviders.ts`**

```ts
import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  jsonb,
  date,
  index,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { ExternalBackupStatus } from '@breeze/shared';
import { organizations, partners } from './orgs';
import { users } from './users';
import { devices } from './devices';

/**
 * Normalized, vendor-neutral outcome of the most recent backup session.
 *
 * Label order is the contract: `EXTERNAL_BACKUP_STATUSES` in
 * `packages/shared/src/types/backupHealth.ts` carries the same tuple in the
 * same order, and `backupProviderRls.integration.test.ts` compares the two
 * against live `pg_enum`. `ALTER TYPE ... ADD VALUE` appends, so a future
 * vendor's extra status lands at the end of both.
 *
 * NOT to be confused with `backupProviderEnum` (`backup_provider`) in
 * `./backup`, which names the STORAGE DESTINATION of a FIRST-PARTY backup
 * (local | s3 | azure_blob | ...). Nothing here reuses it.
 */
export const EXTERNAL_BACKUP_STATUS_ENUM_VALUES = [
  'completed',
  'completed_with_errors',
  'failed',
  'in_progress',
  'interrupted',
  'over_quota',
  'no_selection',
  'not_started',
  'no_backups',
  'unknown',
] as const;

export const externalBackupStatusEnum = pgEnum(
  'external_backup_status',
  EXTERNAL_BACKUP_STATUS_ENUM_VALUES,
);

/**
 * One MSP-level connection to an external backup vendor (RLS shape 3 —
 * partner axis, no org axis at all). Credentials are a console login, sealed
 * with an AAD bound to THIS row's id (`encryptedColumnRegistry`,
 * `aadBinding: 'row'`), so a ciphertext moved into another partner's row does
 * not decrypt. No route ever returns `credentialsEncrypted`.
 */
export const backupProviderConnections = pgTable('backup_provider_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  /** Adapter key, validated by `getBackupProvider` — an open string so a second vendor needs no migration. */
  provider: varchar('provider', { length: 30 }).notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  baseUrl: varchar('base_url', { length: 300 })
    .notNull()
    .default('https://api.backup.management/jsonapi'),
  credentialsEncrypted: text('credentials_encrypted').notNull(),
  vendorRootId: varchar('vendor_root_id', { length: 120 }),
  vendorRootName: varchar('vendor_root_name', { length: 255 }),
  isActive: boolean('is_active').notNull().default(true),
  status: varchar('status', { length: 20 })
    .notNull()
    .default('connected')
    .$type<'connected' | 'error' | 'reauth_required'>(),
  syncIntervalMinutes: integer('sync_interval_minutes').notNull().default(30),
  /** D5 — reveal the vendor name in the client portal instead of the generic label. */
  showProviderNameInPortal: boolean('show_provider_name_in_portal').notNull().default(false),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastSyncStatus: varchar('last_sync_status', { length: 20 })
    .$type<'running' | 'success' | 'partial' | 'error'>(),
  lastSyncError: text('last_sync_error'),
  lastSyncCustomers: integer('last_sync_customers'),
  lastSyncUnmappedCustomers: integer('last_sync_unmapped_customers'),
  lastSyncDevices: integer('last_sync_devices'),
  lastSyncUnmappedDevices: integer('last_sync_unmapped_devices'),
  lastSyncLinkedDevices: integer('last_sync_linked_devices'),
  lastSyncAmbiguousDevices: integer('last_sync_ambiguous_devices'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idPartnerUniq: uniqueIndex('backup_provider_connections_id_partner_uniq').on(table.id, table.partnerId),
  partnerProviderNameUniq: uniqueIndex('backup_provider_connections_partner_provider_name_uniq')
    .on(table.partnerId, table.provider, table.name),
  partnerIdx: index('backup_provider_connections_partner_idx').on(table.partnerId),
}));

/**
 * A customer discovered in the vendor console, and the Breeze organization it
 * maps to (RLS shape 3 — partner axis). `orgId` is the mapping TARGET and may
 * be NULL: an unmapped customer must stay visible to the partner admin who has
 * to map it, which is why this table is in `ORG_AXIS_POLICY_EXCLUDED_TABLES`
 * even though it carries an `org_id` column — the same treatment as
 * `huntress_org_mappings`.
 */
export const backupProviderCustomers = pgTable('backup_provider_customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  vendorCustomerId: varchar('vendor_customer_id', { length: 128 }).notNull(),
  vendorCustomerName: varchar('vendor_customer_name', { length: 255 }).notNull(),
  vendorParentId: varchar('vendor_parent_id', { length: 128 }),
  vendorLevel: varchar('vendor_level', { length: 40 }),
  vendorExternalCode: varchar('vendor_external_code', { length: 255 }),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'set null' }),
  /** NULL = never mapped. `manual`/`manual_unmapped` are never touched by auto-mapping. */
  mappingSource: varchar('mapping_source', { length: 20 })
    .$type<'manual' | 'auto_name' | 'auto_external_code' | 'manual_unmapped'>(),
  deviceCount: integer('device_count').notNull().default(0),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  connectionVendorUniq: uniqueIndex('backup_provider_customers_connection_vendor_uniq')
    .on(table.connectionId, table.vendorCustomerId),
  idConnectionUniq: uniqueIndex('backup_provider_customers_id_connection_uniq').on(table.id, table.connectionId),
  idOrgUniq: uniqueIndex('backup_provider_customers_id_org_uniq').on(table.id, table.orgId),
  orgIdx: index('backup_provider_customers_org_idx').on(table.orgId),
  partnerIdx: index('backup_provider_customers_partner_idx').on(table.partnerId),
  connectionIdx: index('backup_provider_customers_connection_idx').on(table.connectionId),
  connectionPartnerFk: foreignKey({
    columns: [table.connectionId, table.partnerId],
    foreignColumns: [backupProviderConnections.id, backupProviderConnections.partnerId],
    name: 'backup_provider_customers_connection_partner_fk',
  }).onDelete('cascade'),
  // Declared DEFERRABLE INITIALLY IMMEDIATE in SQL (drizzle-kit cannot express
  // deferrability); the migration is authoritative.
  orgPartnerFk: foreignKey({
    columns: [table.orgId, table.partnerId],
    foreignColumns: [organizations.id, organizations.partnerId],
    name: 'backup_provider_customers_org_partner_fk',
  }),
}));

/**
 * One vendor device under a MAPPED customer (RLS shape 1 — direct `org_id`,
 * NOT NULL). Devices under an unmapped customer are counted, never stored
 * (spec D8), so `org_id` is always known at write time.
 *
 * `partnerId` is denormalized for the partner-wide overview scan and for the
 * composite FK back to the connection. It is NOT a second RLS read branch:
 * adding one would let a partner token with restricted org access read every
 * org's rows.
 */
export const backupProviderDevices = pgTable('backup_provider_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  customerId: uuid('customer_id').notNull(),
  /** Denormalized from the connection so an ORG token (the portal) can label the row. */
  provider: varchar('provider', { length: 30 }).notNull(),
  portalShowProviderName: boolean('portal_show_provider_name').notNull().default(false),
  vendorDeviceId: varchar('vendor_device_id', { length: 128 }).notNull(),
  vendorDeviceName: varchar('vendor_device_name', { length: 255 }).notNull(),
  computerName: varchar('computer_name', { length: 255 }),
  osType: varchar('os_type', { length: 20 })
    .notNull()
    .default('unknown')
    .$type<'workstation' | 'server' | 'unknown'>(),
  osVersion: varchar('os_version', { length: 255 }),
  clientVersion: varchar('client_version', { length: 64 }),
  /** Lower-case, colon-separated; normalized by the adapter. */
  macAddresses: text('mac_addresses').array().notNull().default(sql`'{}'::text[]`),
  accountType: varchar('account_type', { length: 20 })
    .notNull()
    .default('unknown')
    .$type<'backup_manager' | 'm365' | 'unknown'>(),
  dataSources: text('data_sources').array().notNull().default(sql`'{}'::text[]`),
  status: externalBackupStatusEnum('status').notNull().default('unknown').$type<ExternalBackupStatus>(),
  vendorStatusCode: integer('vendor_status_code'),
  lastSessionAt: timestamp('last_session_at', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastCompletedAt: timestamp('last_completed_at', { withTimezone: true }),
  selectedBytes: bigint('selected_bytes', { mode: 'number' }),
  usedBytes: bigint('used_bytes', { mode: 'number' }),
  errorsCount: integer('errors_count').notNull().default(0),
  /**
   * Link, not ownership. Named `breeze_device_id` on purpose: `device_id`
   * would enrol the table in `breeze_device_child_orgid_tables()` (the generic
   * `SET org_id` re-stamp loop the devices org-move trigger fires) and in
   * `cascadeDelete.test.ts`'s `device_id` contract — both wrong for a link
   * whose `org_id` comes from the CUSTOMER MAPPING, not from the device, and
   * whose FK is `ON DELETE SET NULL (breeze_device_id)`. The rename is blocked
   * by a contract case in `routes/devices/cascadeDelete.test.ts`; the org-move
   * detach it forces lives in `routes/devices/moveOrg.ts`.
   */
  breezeDeviceId: uuid('breeze_device_id'),
  deviceMatchSource: varchar('device_match_source', { length: 20 })
    .$type<'auto_hostname' | 'auto_mac' | 'manual'>(),
  /** W02 two-poll hysteresis: the alert condition seen on the PREVIOUS sync. */
  pendingCondition: varchar('pending_condition', { length: 30 }),
  vendorCreatedAt: timestamp('vendor_created_at', { withTimezone: true }),
  vendorExpiresAt: timestamp('vendor_expires_at', { withTimezone: true }),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  /** Full vendor Settings map, for debugging and future columns. `excludedOpen` in the export policy. */
  vendorRaw: jsonb('vendor_raw').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  connectionVendorUniq: uniqueIndex('backup_provider_devices_connection_vendor_uniq')
    .on(table.connectionId, table.vendorDeviceId),
  idOrgUniq: uniqueIndex('backup_provider_devices_id_org_uniq').on(table.id, table.orgId),
  breezeDeviceUniq: uniqueIndex('backup_provider_devices_breeze_device_uniq')
    .on(table.breezeDeviceId)
    .where(sql`${table.breezeDeviceId} IS NOT NULL`),
  orgStatusIdx: index('backup_provider_devices_org_status_idx').on(table.orgId, table.status),
  partnerStatusIdx: index('backup_provider_devices_partner_status_idx').on(table.partnerId, table.status),
  orgBreezeDeviceIdx: index('backup_provider_devices_org_breeze_device_idx').on(table.orgId, table.breezeDeviceId),
  customerIdx: index('backup_provider_devices_customer_idx').on(table.customerId),
  lastSuccessIdx: index('backup_provider_devices_last_success_idx').on(table.lastSuccessAt),
  connectionPartnerFk: foreignKey({
    columns: [table.connectionId, table.partnerId],
    foreignColumns: [backupProviderConnections.id, backupProviderConnections.partnerId],
    name: 'backup_provider_devices_connection_partner_fk',
  }).onDelete('cascade'),
  customerConnectionFk: foreignKey({
    columns: [table.customerId, table.connectionId],
    foreignColumns: [backupProviderCustomers.id, backupProviderCustomers.connectionId],
    name: 'backup_provider_devices_customer_connection_fk',
  }).onDelete('cascade'),
  customerOrgFk: foreignKey({
    columns: [table.customerId, table.orgId],
    foreignColumns: [backupProviderCustomers.id, backupProviderCustomers.orgId],
    name: 'backup_provider_devices_customer_org_fk',
  }).onDelete('cascade'),
  // `ON DELETE SET NULL (breeze_device_id)` — the PG15 COLUMN-LIST form —
  // cannot be expressed in Drizzle; the migration is authoritative and
  // `backupProviderRls.integration.test.ts` pins `confdelsetcols`. Declaring
  // it here without the column list would make drizzle-kit propose a bare SET
  // NULL, so it is deliberately NOT declared in this file at all (same as
  // m365_intune_devices, which also omits it).
}));

/**
 * Observed daily health for the 28-day bar (spec D10). One row per provider
 * device per UTC day, upserted by every sync: `status` = worse of (existing,
 * observed), `errorsCount` = max, `observations` + 1.
 *
 * These are OBSERVATIONS, not sessions. A day with no poll is a gap; a failed
 * session seen by 40 polls is one failed day. Nothing downstream may count
 * these rows as jobs ("N backups succeeded" is never derivable from here).
 */
export const backupProviderDeviceHistory = pgTable('backup_provider_device_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerDeviceId: uuid('provider_device_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  day: date('day').notNull(),
  status: externalBackupStatusEnum('status').notNull().$type<ExternalBackupStatus>(),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  errorsCount: integer('errors_count').notNull().default(0),
  observations: integer('observations').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  deviceDayUniq: uniqueIndex('backup_provider_device_history_device_day_uniq')
    .on(table.providerDeviceId, table.day),
  orgDayIdx: index('backup_provider_device_history_org_day_idx').on(table.orgId, table.day),
  deviceOrgFk: foreignKey({
    columns: [table.providerDeviceId, table.orgId],
    foreignColumns: [backupProviderDevices.id, backupProviderDevices.orgId],
    name: 'backup_provider_device_history_device_org_fk',
  }).onDelete('cascade'),
}));

export type BackupProviderConnectionRow = typeof backupProviderConnections.$inferSelect;
export type BackupProviderCustomerRow = typeof backupProviderCustomers.$inferSelect;
export type BackupProviderDeviceRow = typeof backupProviderDevices.$inferSelect;
export type BackupProviderDeviceHistoryRow = typeof backupProviderDeviceHistory.$inferSelect;
```

- [ ] **Step 4: Export from the schema barrel**

In `apps/api/src/db/schema/index.ts`, append after the final line `export * from './toolSources';`:

```ts
export * from './backupProviders';
```

- [ ] **Step 5: Typecheck and re-run the probe**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx tsc --noEmit -p tsconfig.json
node -e "const s=require('fs').readFileSync('src/db/schema/index.ts','utf8'); process.exit(s.includes('./backupProviders') ? 0 : 1)" && echo EXPORTED
```
Expected: `tsc` reports no errors and the probe prints `EXPORTED`. If `tsc` cannot resolve `ExternalBackupStatus` from `@breeze/shared`, Task 5 has not landed yet — do Task 5 first.

- [ ] **Step 6: Check for schema drift against the migration**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration
export DATABASE_URL="$(grep '^DATABASE_URL=' .env.test | cut -d= -f2-)"
pnpm db:check-drift
```
Expected: no drift reported for the four new tables. If drift names `backup_provider_devices_breeze_device_org_fk`, that is the deliberately-undeclared column-list FK — confirm it is the ONLY difference and leave it (m365 has the same shape); anything else is a real mismatch between the Drizzle file and the migration and must be fixed in the Drizzle file, never by editing the shipped migration.

- [ ] **Step 7: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration
git add apps/api/src/db/schema/backupProviders.ts apps/api/src/db/schema/index.ts
git commit -m "$(cat <<'EOF'
feat(integrations): drizzle schema for the backup provider tables (#6008 W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The five registry/allowlist registrations

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`ORG_AXIS_POLICY_EXCLUDED_TABLES` ends at `:175` with `'ticket_form_org_links',` then `]);` at `:176`; `PARTNER_TENANT_TABLES` ends at `:318` with `['org_merge_events', 'partner_id'],` then `]);`)
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER` at `:229`; `'backup_profiles',` is `:363` and `'backup_sla_configs',` is `:364`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`"backup_profiles"` is `:147`, `"backup_sla_configs"` is `:148`)
- Modify: `apps/api/src/services/orgMergeRegistry.ts` (`REPOINT_TABLES` at `:638`; `"backup_profiles",` is `:664`, `"backup_sla_configs",` is `:665`)
- Modify: `apps/api/src/services/encryptedColumnRegistry.ts` (append after the `tool_sources` entry at `:118`, before the closing `];` at `:119`)

**Interfaces:**
- Consumes the table names produced by Task 1.
- Produces no new symbols; it makes six contract suites go green.

**Ordering facts verified for this task**
- `localeCompare` places the three names exactly between `backup_profiles` and `backup_sla_configs`, in the order `backup_provider_customers` < `backup_provider_device_history` < `backup_provider_devices` (`'_'` sorts before `'s'` in ICU, so `device_history` precedes `devices`). Verified: `node -e "console.log(['backup_profiles','backup_provider_customers','backup_provider_device_history','backup_provider_devices','backup_sla_configs'].slice().sort((a,b)=>a.localeCompare(b)).join(' '))"`.
- `backup_provider_connections` has **no** `org_id`, so it goes in **none** of the org-cascade / export-policy / org-merge lists. It is instead covered by the `partner_id` sweep in `cascadeDeletePartner` (`tenantCascade.ts:1763-1790`), which enumerates `information_schema.columns` for `partner_id` at runtime — no list entry, only the `GRANT … DELETE` the migration issues.
- `tenantCascade.integration.test.ts:115` orders the actual DELETE from a live `pg_constraint` read (`topologicalCascadeOrder()`), so the alphabetical list order does not have to be children-first — but the FK direction is still asserted, and our CASCADE edges satisfy it.
- No column on the three `org_id` tables matches `SUSPICIOUS_NAME_PARTS` (`apps/api/src/services/tenantExportPolicy.ts:35-55`: password, hash, mfa, totp, recovery, token, secret, private_key, credential, authorization, cookie, webhook, encryption_key, provision, bootstrap, invite, refresh, access_key, client_key). `provider` / `portal_show_provider_name` contain "provider", not "provision"; `client_version` is not "client_key". So `reviewedIncluded` stays empty on all three. `credentials_encrypted` **would** match, but it lives on `backup_provider_connections`, which has no `org_id` and therefore no export-policy entry at all.
- `vendor_raw` is `jsonb`, so `isOpenContainer` (`tenantExportPolicy.ts:94`) fires on it and the runtime plan builder demands `openContainerReviewed: true` — which is exactly what the `excludedOpen` bucket sets. `mac_addresses` and `data_sources` are `text[]` (`udt_name = _text`, `data_type = ARRAY`): **not** in `OPEN_CONTAINER_TYPES` (`json`, `jsonb`, `bytea`) and not in `OPEN_CONTAINER_NAMES` (which is an exact-name set — `data_sources` is not `data`), so both are plain `included`.

- [ ] **Step 1: Write the failing test — run the six contract suites first**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts
```

- [ ] **Step 2: Verify they fail**

Expected failures, all three, naming the new tables:
- `tenantCascade.integration.test.ts` → "every org_id-columned public table is in getOrgCascadeDeleteOrder()" fails listing `backup_provider_customers`, `backup_provider_device_history`, `backup_provider_devices`.
- `tenant-export-policy.integration.test.ts` → "classifies every live cascade table column exactly" fails; once the cascade list is added it reports `backup_provider_devices.vendor_raw: unclassified` and siblings.
- `orgMergeRegistry.integration.test.ts` → "every required table has exactly one policy" fails with the same three names in its `missing` array.

(`rls-coverage.integration.test.ts` has its own runner — `vitest.config.rls.ts`; run it in Step 6.)

- [ ] **Step 3: Add the cascade entries**

In `apps/api/src/services/tenantCascade.ts`, between `'backup_profiles',` and `'backup_sla_configs',`:

```ts
  'backup_profiles',
  // Backup Provider Integration W01 (#6008). Three org_id tables; the fourth
  // (backup_provider_connections) is partner-axis with no org_id and is erased
  // by cascadeDeletePartner's information_schema partner_id sweep instead.
  // Alphabetical by localeCompare puts device_history before devices ('_' <
  // 's'), which also happens to be children-before-parents — but the real
  // DELETE order comes from topologicalCascadeOrder()'s live pg_constraint
  // read, and every FK among these three carries an explicit ON DELETE
  // CASCADE, so position here is determinism, not correctness.
  'backup_provider_customers',
  'backup_provider_device_history',
  'backup_provider_devices',
  'backup_sla_configs',
```

- [ ] **Step 4: Add the export-policy entries**

In `apps/api/src/services/tenantExportPolicyRegistry.ts`, between the `"backup_profiles"` line and the `"backup_sla_configs"` line:

```ts
  // Backup Provider Integration W01 (#6008, spec "Data model" + "Security").
  //
  // Customer rows are vendor-side directory data plus the Breeze org they were
  // mapped to — identifiers, names, a closed-set mapping_source, a count and
  // timestamps. Nothing matches SUSPICIOUS_NAME_PARTS and nothing is an open
  // container. The CREDENTIAL lives on backup_provider_connections, which has
  // no org_id and therefore no entry in this registry at all.
  "backup_provider_customers": tablePolicy("org_id", {"included":["id","connection_id","partner_id","vendor_customer_id","vendor_customer_name","vendor_parent_id","vendor_level","vendor_external_code","org_id","mapping_source","device_count","last_seen_at","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
  // Observed daily health for the 28-day bar. Plain scalars only.
  "backup_provider_device_history": tablePolicy("org_id", {"included":["id","provider_device_id","org_id","day","status","last_success_at","errors_count","observations","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
  // vendor_raw is jsonb -> excludedOpen by the container rule, even though
  // nothing in it is a secret TODAY: an open container may embed credentials
  // or capabilities, and Cove's Settings map is whatever the vendor decides to
  // return. mac_addresses / data_sources are text[] (udt_name `_text`), which
  // is NOT an open-container type, and `data_sources` is not the exact name
  // `data` — so both stay plain `included`. `provider` and
  // `portal_show_provider_name` contain "provider", not "provision", and
  // `client_version` is not "client_key": no reviewedIncluded entries needed.
  "backup_provider_devices": tablePolicy("org_id", {"included":["id","connection_id","partner_id","org_id","customer_id","provider","portal_show_provider_name","vendor_device_id","vendor_device_name","computer_name","os_type","os_version","client_version","mac_addresses","account_type","data_sources","status","vendor_status_code","last_session_at","last_success_at","last_completed_at","selected_bytes","used_bytes","errors_count","breeze_device_id","device_match_source","pending_condition","vendor_created_at","vendor_expires_at","first_seen_at","last_seen_at","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["vendor_raw"]}),
```

- [ ] **Step 5: Add the org-merge repoint entries**

In `apps/api/src/services/orgMergeRegistry.ts`, inside `REPOINT_TABLES`, between `"backup_profiles",` and `"backup_sla_configs",`:

```ts
  "backup_profiles",
  // Backup Provider Integration W01 (#6008). Plain org_id repoints, NOT the
  // resolve-phase DELETE that m365_intune_devices uses.
  //
  // The reason m365 deletes is that its rows are a re-derivable Graph snapshot
  // whose (breeze_device_id, org_id) FK would be violated at COMMIT if they
  // were LEFT BEHIND under the dead loser org. Repointing them would also have
  // worked; deleting was chosen because the next sync rebuilds them. Here the
  // rows are cheap to move and moving them is strictly better: the customer
  // mapping, the device link and the 28-day ledger all survive the merge
  // instead of going blank until the next 30-minute poll.
  //
  // Every composite FK among these three (and onto devices and organizations)
  // is DEFERRABLE INITIALLY IMMEDIATE, so the merge's SET CONSTRAINTS ALL
  // DEFERRED lets parent and child org_id move in separate statements and the
  // whole set is consistent at COMMIT. No unique key on any of the three is
  // org-scoped — (connection_id, vendor_customer_id), (connection_id,
  // vendor_device_id), (provider_device_id, day) and the partial
  // breeze_device_id index are all org-independent — so a plain repoint can
  // never raise 23505 and none of them needs repoint-dedupe. As with
  // huntress_org_mappings, after a merge the survivor simply holds BOTH orgs'
  // customer mappings; duplicates are tolerated by design and are silent.
  "backup_provider_customers",
  "backup_provider_device_history",
  "backup_provider_devices",
  "backup_sla_configs",
```

- [ ] **Step 6: Add the RLS allowlist entries**

In `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, append to `ORG_AXIS_POLICY_EXCLUDED_TABLES` after `'ticket_form_org_links',`:

```ts
  'ticket_form_org_links',
  // backup_provider_customers (#6008 W01): partner-axis (Shape 3) carrying a
  // denormalized NULLABLE org_id — the MAPPING TARGET, not the tenancy axis.
  // An unmapped customer has org_id NULL and must stay visible to the partner
  // admin who has to map it, so breeze_has_org_access(org_id) is the wrong
  // predicate here. Identical treatment to huntress_org_mappings /
  // s1_org_mappings. Its sibling backup_provider_devices IS direct-org_id
  // (Shape 1) and is deliberately NOT excluded — it is auto-discovered and
  // must carry breeze_has_org_access(org_id) on all four commands.
  'backup_provider_customers',
]);
```

and append to `PARTNER_TENANT_TABLES` after `['org_merge_events', 'partner_id'],`:

```ts
  ['org_merge_events', 'partner_id'],
  // Backup Provider Integration (#6008 W01): the MSP registers one external
  // backup vendor connection (Cove) and maps its discovered customers to
  // Breeze orgs. Both tables are partner-axis (Shape 3), four per-command
  // breeze_has_partner_access policies each, the customers table additionally
  // re-checking its parent connection's partner_id in INSERT/UPDATE WITH
  // CHECK. backup_provider_customers is ALSO in
  // ORG_AXIS_POLICY_EXCLUDED_TABLES (dual-list trap — it has an org_id column
  // that is not its tenancy axis). backup_provider_devices and
  // backup_provider_device_history carry a NOT NULL org_id and are ordinary
  // Shape 1 tables, auto-discovered — not listed here, and their denormalized
  // partner_id is deliberately NOT a second RLS read branch.
  // Functional cross-partner forge proof:
  // backupProviderRls.integration.test.ts.
  ['backup_provider_connections', 'partner_id'],
  ['backup_provider_customers', 'partner_id'],
]);
```

- [ ] **Step 7: Add the encrypted-column registry entry**

In `apps/api/src/services/encryptedColumnRegistry.ts`, after the `tool_sources` entry (`:118`):

```ts
  { table: 'tool_sources', column: 'auth_config_encrypted', kind: 'text', aadBinding: 'row', description: 'external tool source credential JSON (#5216, spec 2026-09-07 §5.2) — AAD bound to the row id' },
  { table: 'backup_provider_connections', column: 'credentials_encrypted', kind: 'text', aadBinding: 'row', description: 'external backup provider console credentials JSON (#6008 W01) — AAD bound to the row id, so a blob pasted into another partner\'s connection does not decrypt' },
];
```

- [ ] **Step 8: Re-run all four contract suites**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts
npx vitest run --config vitest.config.rls.ts
```
Expected: all PASS. If `tenant-export-policy` still reports `vendor_raw`, the bucket is wrong — it must be `excludedOpen`, not `included`, or the runtime plan builder throws `open container "backup_provider_devices.vendor_raw" requires openContainerReviewed: true`.

- [ ] **Step 9: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration
git add apps/api/src/services/tenantCascade.ts \
        apps/api/src/services/tenantExportPolicyRegistry.ts \
        apps/api/src/services/orgMergeRegistry.ts \
        apps/api/src/services/encryptedColumnRegistry.ts \
        apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(integrations): register backup provider tables in cascade, export, merge and RLS contracts (#6008 W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Device-link contracts — cascade column-name case, org-move detach

**Files:**
- Modify (test first): `apps/api/src/routes/devices/cascadeDelete.test.ts` (add a case after the `m365_intune_devices` one at `:244-264`, inside the `describe('device hard-delete table coverage contract')` block whose final `});` is at `:265`)
- Modify: `apps/api/src/routes/devices/moveOrg.ts` (insert after the `m365_intune_devices` detach, `:367-371`, and before the `// Flip the device row first` comment at `:373`)
- Modify (test): `apps/api/src/routes/devices/moveOrg.test.ts` (the statement-order assertion at `:1279-1344`; `statements[7]` is the Intune detach and `statements[8]` is `'UPDATE devices'` today)

**Interfaces:**
- Consumes `backupProviderDevices` (Task 2) via the Drizzle schema barrel, and `getTableName` / `PgTable` already imported at `cascadeDelete.test.ts:3-4`.
- Consumes `deviceId` and `sourceOrgId`, both already in scope in the `moveOrg.ts` transaction body (they are used by the `manual_assets` and `m365_intune_devices` statements immediately above).
- Produces the SQL statement `UPDATE backup_provider_devices SET breeze_device_id = NULL, device_match_source = NULL WHERE breeze_device_id = $1 AND org_id = $2`, which the sync worker (W02) relies on having already run.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/devices/cascadeDelete.test.ts`, immediately after the `m365_intune_devices` case (i.e. as the last `it` inside `describe('device hard-delete table coverage contract')`):

```ts
  it('backup_provider_devices needs no device-cascade entry — its link column is breeze_device_id', () => {
    // #6008 W01. Identical reasoning to the m365_intune_devices case above:
    // the two membership contracts discover tables by COLUMN NAME (`device_id`
    // at :151, `linked_device_id` at :200), not by FK target.
    // backup_provider_devices LINKS rather than belongs — its org_id comes from
    // the CUSTOMER MAPPING, not from the Breeze device — and its
    // (breeze_device_id, org_id) -> devices(id, org_id) FK is
    // ON DELETE SET NULL (breeze_device_id), so the database clears the link on
    // a device hard-delete and no list entry is required.
    //
    // Renaming the column to device_id would silently enrol the table in the
    // generic `DELETE ... WHERE device_id = ...` cascade (destroying a
    // customer's whole provider backup history when one device is deleted) AND
    // in breeze_device_child_orgid_tables()'s `SET org_id` re-stamp loop
    // (re-homing a provider row to an org its customer is NOT mapped to, which
    // the (customer_id, org_id) composite FK would then reject). This test is
    // what stops that rename.
    const table = allSchemaTables().find((t) => getTableName(t) === 'backup_provider_devices');
    expect(table, 'backup_provider_devices missing from the Drizzle schema barrel').toBeDefined();
    const names = getTableColumns(table!).map((col) => col.name);
    expect(names).toContain('breeze_device_id');
    expect(names).not.toContain('device_id');
    expect(names).not.toContain('linked_device_id');

    expect(DEVICE_CASCADE_DELETE_TABLES).not.toContain('backup_provider_devices');
    expect(DEVICE_DETACH_DEVICE_ID_TABLES).not.toContain('backup_provider_devices');
    expect(DEVICE_LINKED_DEVICE_ID_TABLES).not.toContain('backup_provider_devices');
  });
```

In `apps/api/src/routes/devices/moveOrg.test.ts`, inside the `it('runs after both organization SHARE locks and before the device update', …)` at `:1279`, replace the tail of the assertion block (from the `const intuneDetach = collapseStmt(statements[7]!);` line through `expect(statements[8]).toBe('UPDATE devices');`) with:

```ts
      const intuneDetach = collapseStmt(statements[7]!);
      expect(intuneDetach).toContain(
        'UPDATE m365_intune_devices SET breeze_device_id = NULL',
      );
      // Scoped to the SOURCE org, not just the device id.
      expect(intuneDetach).toMatch(/AND org_id =/);
      // #6008 W01 — the external-backup link detach sits immediately after the
      // Intune one and before the device UPDATE, for exactly the same reason:
      // backup_provider_devices_breeze_device_org_fk ((breeze_device_id,
      // org_id) -> devices(id, org_id)) is DEFERRABLE INITIALLY IMMEDIATE, so
      // its check fires at the end of the org flip below. There is no
      // trigger-side mirror — breeze_device_child_orgid_tables() discovers by a
      // column literally named `device_id` and this one is `breeze_device_id`
      // — so this statement is the ONLY thing standing between a
      // Cove-linked device and a 23503 on every cross-org move.
      const providerDetach = collapseStmt(statements[8]!);
      expect(providerDetach).toContain(
        'UPDATE backup_provider_devices SET breeze_device_id = NULL',
      );
      // The provenance column is cleared WITH the link (#3952 class): leaving
      // device_match_source = 'auto_hostname' on a row with no link would make
      // W02's re-validation treat it as a manual link and never re-match it.
      expect(providerDetach).toContain('device_match_source = NULL');
      expect(providerDetach).toMatch(/AND org_id =/);
      expect(statements[9]).toBe('UPDATE devices');
```

- [ ] **Step 2: Run both to verify they fail**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.test.ts
```
Expected: two failures.
- `cascadeDelete.test.ts` → `backup_provider_devices missing from the Drizzle schema barrel` **only if Task 2 has not landed**; with Task 2 landed this case PASSES immediately (it is a pinning test, not a red-first one) — that is expected and fine, note it and move on.
- `moveOrg.test.ts` → `expected undefined to contain 'UPDATE backup_provider_devices SET breeze_device_id = NULL'` (statement index 8 does not exist yet) and `expected 'UPDATE devices' at statements[9]`.

- [ ] **Step 3: Add the detach to `moveOrg.ts`**

In `apps/api/src/routes/devices/moveOrg.ts`, immediately after the `m365_intune_devices` `tx.execute(...)` that ends at `:371` and before the `// Flip the device row first` comment:

```ts
        // #6008 W01 (Backup Provider Integration, spec "Data model" D11) —
        // backup_provider_devices links a Breeze device to its external backup
        // vendor record via the composite FK (breeze_device_id, org_id) ->
        // devices(id, org_id). Once the device leaves the org that link is not
        // merely stale but unrepresentable, so null it. The ROW survives: it is
        // the SOURCE org's provider inventory, its org_id comes from the
        // CUSTOMER MAPPING (not from this device), and the 28-day health ledger
        // hanging off it is evidence nobody should lose because a device moved.
        // The next provider sync re-links the device in the NEW org if that
        // org's customer mapping covers it.
        //
        // device_match_source is cleared WITH the link: a row carrying
        // 'auto_hostname' with no breeze_device_id would read as an unmatched
        // auto link, but leaving 'manual' behind would make W02's matcher skip
        // the row forever (manual links are never re-matched).
        //
        // Placement is load-bearing, exactly as for manual_assets and
        // m365_intune_devices above: the FK is DEFERRABLE INITIALLY IMMEDIATE,
        // so its check fires at the end of the `UPDATE devices SET org_id`
        // statement immediately below, and there is no trigger-side mirror —
        // breeze_device_child_orgid_tables() requires a column literally named
        // `device_id` and this one is `breeze_device_id`. This statement is the
        // only detach on any path.
        //
        // Scoped to the SOURCE org as well as the device. An org MERGE never
        // reaches this route: it re-points backup_provider_devices wholesale
        // (services/orgMergeRegistry.ts REPOINT_TABLES) under SET CONSTRAINTS
        // ALL DEFERRED, keeping the link valid inside the survivor org.
        await tx.execute(
          sql`UPDATE backup_provider_devices
              SET breeze_device_id = NULL, device_match_source = NULL
              WHERE breeze_device_id = ${deviceId}::uuid
                AND org_id = ${sourceOrgId}::uuid`,
        );
```

- [ ] **Step 4: Run both tests to verify they pass**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.test.ts src/routes/devices/moveOrg.coverage.test.ts
```
Expected: 3 files, all PASS. `moveOrg.coverage.test.ts` must stay green **without** an entry: its "includes every device-managed table that also has an org_id column" assertion (`:106`) only considers tables in `getDeviceCascadeDeleteTables() ∪ DEVICE_DETACH_DEVICE_ID_TABLES`, and `backup_provider_devices` is in neither because it has no `device_id` column.

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration
git add apps/api/src/routes/devices/cascadeDelete.test.ts \
        apps/api/src/routes/devices/moveOrg.ts \
        apps/api/src/routes/devices/moveOrg.test.ts
git commit -m "$(cat <<'EOF'
feat(devices): detach backup provider device links on cross-org move (#6008 W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Shared backup-health types and derivation

**Files:**
- Create: `packages/shared/src/types/backupHealth.ts`
- Create: `packages/shared/src/utils/backupHealth.ts`
- Test: `packages/shared/src/utils/backupHealth.test.ts`
- Modify: `packages/shared/src/types/index.ts` (append after `export * from './scriptProposals';`, `:10`)
- Modify: `packages/shared/src/utils/index.ts` (append after `export * from './hardwareLifecycle';`, the final line)

**Interfaces:**
- Consumes nothing — both files are pure, no imports outside `type`-only self-references.
- Produces, verbatim (consumed by Tasks 2, 7, 9, and by W02–W05):

```ts
export const EXTERNAL_BACKUP_STATUSES: readonly ExternalBackupStatus[];
export type ExternalBackupStatus =
  | 'completed' | 'completed_with_errors' | 'failed' | 'in_progress' | 'interrupted'
  | 'over_quota' | 'no_selection' | 'not_started' | 'no_backups' | 'unknown';
export type BackupHealth = 'healthy' | 'warning' | 'critical' | 'unknown';
export type BackupRecency = 'under_24h' | 'under_48h' | 'over_48h' | 'never';
export type BackupProviderAlertCondition =
  | 'failed' | 'over_quota' | 'no_selection' | 'no_backups' | 'completed_with_errors' | 'stale';
export interface BackupHealthRow { /* spec "Unified read model" */ }
export interface BackupHealthSummary { /* spec "Unified read model" */ }

export const BACKUP_WARNING_AFTER_HOURS = 24;
export const BACKUP_CRITICAL_AFTER_HOURS = 48;
export const EXTERNAL_BACKUP_STATUS_SEVERITY: Record<ExternalBackupStatus, number>;
export function deriveBackupHealth(input: {
  status: ExternalBackupStatus;
  lastSuccessAt: Date | string | null;
  errorsCount: number;
  now?: Date;
}): { health: BackupHealth; recency: BackupRecency; covered: boolean };
export function worstBackupStatus(a: ExternalBackupStatus, b: ExternalBackupStatus): ExternalBackupStatus;
export function mapBackupJobStatus(
  jobStatus: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'partial' | null,
): ExternalBackupStatus;

export const BACKUP_STATUS_BUCKET_IDS: readonly BackupStatusBucketId[];
export type BackupStatusBucketId =
  'no_backups' | 'completed' | 'completed_with_errors' | 'in_progress' | 'unsuccessful' | 'other';
export const BACKUP_STATUS_BUCKET_MEMBERS: Record<BackupStatusBucketId, readonly ExternalBackupStatus[]>;
export function bucketForBackupStatus(status: ExternalBackupStatus): BackupStatusBucketId;
```

> **DECISION (the status buckets live here, not in the web layer):** the spec's overview and the W05 backup-status report both render the Cove email's **Status** group — No backups / Completed / Completed with errors / In process / Unsuccessful — where "Unsuccessful" is defined as `failed + over_quota + no_selection + interrupted`. That definition is a product rule, and a copy of it in `BackupHealthOverview.tsx` and a second copy in the report renderer is exactly how two surfaces come to disagree about how many devices are failing. `BACKUP_STATUS_BUCKET_MEMBERS` is the one definition; `bucketForBackupStatus` is the one lookup. A sixth bucket `other` collects `not_started` and `unknown` so the mapping is TOTAL over the enum — a status with no bucket would silently vanish from a chart whose percentages still summed to 100%. UIs render `other` only when its count is non-zero, which is what keeps the five-bar Cove layout intact in the normal case.

> **DECISION:** `BackupHealthRow` / `BackupHealthSummary` ship in W01 even though only W03 populates them. The plan index lists them under the W01 "Shared" heading, and defining them now is what stops W03 and W04 inventing two near-identical DTOs (the portal already has one). They are pure type declarations with no runtime cost.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/utils/backupHealth.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  BACKUP_CRITICAL_AFTER_HOURS,
  BACKUP_STATUS_BUCKET_IDS,
  BACKUP_STATUS_BUCKET_MEMBERS,
  BACKUP_WARNING_AFTER_HOURS,
  EXTERNAL_BACKUP_STATUS_SEVERITY,
  bucketForBackupStatus,
  deriveBackupHealth,
  mapBackupJobStatus,
  worstBackupStatus,
} from './backupHealth';
import { EXTERNAL_BACKUP_STATUSES, type ExternalBackupStatus } from '../types/backupHealth';

const NOW = new Date('2026-09-15T12:00:00.000Z');
/** `hours` ago relative to NOW, as an ISO string (the shape the API serves). */
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

describe('EXTERNAL_BACKUP_STATUSES', () => {
  it('carries exactly the ten pg enum labels, in the enum order', () => {
    // The order is the contract with the `external_backup_status` pg type
    // (migration 2026-10-17-120000). backupProviderRls.integration.test.ts
    // compares this tuple against live pg_enum; keep them in step.
    expect(EXTERNAL_BACKUP_STATUSES).toEqual([
      'completed',
      'completed_with_errors',
      'failed',
      'in_progress',
      'interrupted',
      'over_quota',
      'no_selection',
      'not_started',
      'no_backups',
      'unknown',
    ]);
  });

  it('assigns every status a severity, with no ties', () => {
    const severities = EXTERNAL_BACKUP_STATUSES.map((s) => EXTERNAL_BACKUP_STATUS_SEVERITY[s]);
    expect(severities.every((n) => Number.isInteger(n))).toBe(true);
    expect(new Set(severities).size).toBe(EXTERNAL_BACKUP_STATUSES.length);
  });
});

describe('worstBackupStatus', () => {
  it('orders failed > over_quota > no_selection > no_backups > interrupted > completed_with_errors > not_started > unknown > in_progress > completed', () => {
    const descending: ExternalBackupStatus[] = [
      'failed', 'over_quota', 'no_selection', 'no_backups', 'interrupted',
      'completed_with_errors', 'not_started', 'unknown', 'in_progress', 'completed',
    ];
    for (let i = 0; i < descending.length - 1; i++) {
      const worse = descending[i]!;
      const better = descending[i + 1]!;
      expect(worstBackupStatus(worse, better)).toBe(worse);
      expect(worstBackupStatus(better, worse)).toBe(worse);
    }
  });

  it('is idempotent and total over the whole enum', () => {
    for (const a of EXTERNAL_BACKUP_STATUSES) {
      expect(worstBackupStatus(a, a)).toBe(a);
      for (const b of EXTERNAL_BACKUP_STATUSES) {
        expect(EXTERNAL_BACKUP_STATUSES).toContain(worstBackupStatus(a, b));
      }
    }
  });
});

describe('BACKUP_STATUS_BUCKET_MEMBERS', () => {
  it('declares the six bucket ids in the order the Cove-email layout renders them', () => {
    expect(BACKUP_STATUS_BUCKET_IDS).toEqual([
      'no_backups', 'completed', 'completed_with_errors', 'in_progress', 'unsuccessful', 'other',
    ]);
    expect(Object.keys(BACKUP_STATUS_BUCKET_MEMBERS)).toEqual([...BACKUP_STATUS_BUCKET_IDS]);
  });

  it('defines Unsuccessful as failed + over_quota + no_selection + interrupted', () => {
    // The product rule the spec names. A second copy of it in the web overview
    // and a third in the W05 report is how two surfaces come to disagree about
    // how many devices are failing.
    expect([...BACKUP_STATUS_BUCKET_MEMBERS.unsuccessful].sort()).toEqual(
      ['failed', 'interrupted', 'no_selection', 'over_quota'],
    );
  });

  it('puts every ExternalBackupStatus in EXACTLY ONE bucket', () => {
    for (const status of EXTERNAL_BACKUP_STATUSES) {
      const owning = BACKUP_STATUS_BUCKET_IDS.filter(
        (bucket) => BACKUP_STATUS_BUCKET_MEMBERS[bucket].includes(status),
      );
      expect(owning, `${status} is in ${owning.length} buckets`).toHaveLength(1);
    }
  });

  it('covers the enum exactly — no extra member, no missing one', () => {
    // A status with no bucket would silently vanish from a chart whose
    // percentages still summed to 100%; a member that is not a live enum label
    // would be a bucket nothing can ever land in.
    const members = BACKUP_STATUS_BUCKET_IDS.flatMap((b) => [...BACKUP_STATUS_BUCKET_MEMBERS[b]]);
    expect(new Set(members)).toEqual(new Set(EXTERNAL_BACKUP_STATUSES));
    expect(members).toHaveLength(EXTERNAL_BACKUP_STATUSES.length);
  });

  it('collects not_started and unknown into `other`', () => {
    expect([...BACKUP_STATUS_BUCKET_MEMBERS.other].sort()).toEqual(['not_started', 'unknown']);
  });
});

describe('bucketForBackupStatus', () => {
  it('round-trips every status against its members list', () => {
    for (const bucket of BACKUP_STATUS_BUCKET_IDS) {
      for (const status of BACKUP_STATUS_BUCKET_MEMBERS[bucket]) {
        expect(bucketForBackupStatus(status), `${status} -> ${bucket}`).toBe(bucket);
      }
    }
  });

  it('is total over the enum and never returns undefined', () => {
    for (const status of EXTERNAL_BACKUP_STATUSES) {
      expect(BACKUP_STATUS_BUCKET_IDS).toContain(bucketForBackupStatus(status));
    }
  });

  it.each([
    ['failed', 'unsuccessful'],
    ['over_quota', 'unsuccessful'],
    ['no_selection', 'unsuccessful'],
    ['interrupted', 'unsuccessful'],
    ['completed', 'completed'],
    ['completed_with_errors', 'completed_with_errors'],
    ['in_progress', 'in_progress'],
    ['no_backups', 'no_backups'],
    ['not_started', 'other'],
    ['unknown', 'other'],
  ] as const)('maps %s to the %s bucket', (status, bucket) => {
    expect(bucketForBackupStatus(status)).toBe(bucket);
  });

  it('falls back to `other` for a label outside the enum instead of throwing', () => {
    // A future ALTER TYPE ... ADD VALUE reaches the read model before this file
    // is updated; a throw there would 500 the whole overview.
    expect(bucketForBackupStatus('brand_new_vendor_status' as ExternalBackupStatus)).toBe('other');
  });
});

describe('mapBackupJobStatus', () => {
  it.each([
    ['completed', 'completed'],
    ['partial', 'completed_with_errors'],
    ['failed', 'failed'],
    ['running', 'in_progress'],
    ['pending', 'in_progress'],
    ['cancelled', 'interrupted'],
    [null, 'no_backups'],
  ] as const)('maps backup_jobs.status %s to %s', (jobStatus, expected) => {
    expect(mapBackupJobStatus(jobStatus)).toBe(expected);
  });

  it('maps partial to completed_with_errors, never to failed', () => {
    // RESTORABLE_BACKUP_JOB_STATUSES (apps/api/src/db/schema/backup.ts:82)
    // counts `partial` as a usable restore point; mapping it to `failed` would
    // contradict the SLA worker and make a device with a real snapshot read as
    // never backed up.
    expect(mapBackupJobStatus('partial')).toBe('completed_with_errors');
  });
});

describe('deriveBackupHealth — status-driven verdicts', () => {
  it.each(['failed', 'over_quota', 'no_selection', 'no_backups'] as const)(
    '%s is critical regardless of recency',
    (status) => {
      for (const lastSuccessAt of [null, ago(1), ago(30), ago(100)]) {
        expect(deriveBackupHealth({ status, lastSuccessAt, errorsCount: 0, now: NOW }).health)
          .toBe('critical');
      }
    },
  );

  it.each(['completed_with_errors', 'interrupted'] as const)(
    '%s is warning regardless of recency',
    (status) => {
      for (const lastSuccessAt of [null, ago(1), ago(30), ago(100)]) {
        expect(deriveBackupHealth({ status, lastSuccessAt, errorsCount: 0, now: NOW }).health)
          .toBe('warning');
      }
    },
  );

  it('unknown is unknown regardless of recency or errors', () => {
    for (const lastSuccessAt of [null, ago(1), ago(100)]) {
      expect(deriveBackupHealth({ status: 'unknown', lastSuccessAt, errorsCount: 7, now: NOW }).health)
        .toBe('unknown');
    }
  });

  it('in_progress with errorsCount > 0 is warning, not recency-driven', () => {
    // A run that is still going but already reporting faults (Cove F00 = 9)
    // must not read as healthy just because yesterday's run succeeded.
    expect(deriveBackupHealth({ status: 'in_progress', lastSuccessAt: ago(1), errorsCount: 3, now: NOW }).health)
      .toBe('warning');
    expect(deriveBackupHealth({ status: 'in_progress', lastSuccessAt: null, errorsCount: 3, now: NOW }).health)
      .toBe('warning');
  });

  it('errorsCount > 0 does NOT change the verdict for any other status', () => {
    expect(deriveBackupHealth({ status: 'completed', lastSuccessAt: ago(1), errorsCount: 9, now: NOW }).health)
      .toBe('healthy');
    expect(deriveBackupHealth({ status: 'failed', lastSuccessAt: ago(1), errorsCount: 0, now: NOW }).health)
      .toBe('critical');
  });
});

describe('deriveBackupHealth — recency-driven verdicts', () => {
  const RECENCY_DRIVEN = ['completed', 'in_progress', 'not_started'] as const;

  it.each(RECENCY_DRIVEN)('%s: a success under 24h is healthy/under_24h/covered', (status) => {
    const r = deriveBackupHealth({ status, lastSuccessAt: ago(23), errorsCount: 0, now: NOW });
    expect(r).toEqual({ health: 'healthy', recency: 'under_24h', covered: true });
  });

  it.each(RECENCY_DRIVEN)('%s: a success between 24h and 48h is warning/under_48h/covered', (status) => {
    const r = deriveBackupHealth({ status, lastSuccessAt: ago(30), errorsCount: 0, now: NOW });
    expect(r).toEqual({ health: 'warning', recency: 'under_48h', covered: true });
  });

  it.each(RECENCY_DRIVEN)('%s: a success older than 48h is critical/over_48h/uncovered', (status) => {
    const r = deriveBackupHealth({ status, lastSuccessAt: ago(49), errorsCount: 0, now: NOW });
    expect(r).toEqual({ health: 'critical', recency: 'over_48h', covered: false });
  });

  it.each(RECENCY_DRIVEN)('%s: no success ever is critical/never/uncovered', (status) => {
    const r = deriveBackupHealth({ status, lastSuccessAt: null, errorsCount: 0, now: NOW });
    expect(r).toEqual({ health: 'critical', recency: 'never', covered: false });
  });

  it('boundaries are inclusive at exactly 24h and 48h', () => {
    expect(deriveBackupHealth({ status: 'completed', lastSuccessAt: ago(BACKUP_WARNING_AFTER_HOURS), errorsCount: 0, now: NOW }).recency)
      .toBe('under_48h');
    expect(deriveBackupHealth({ status: 'completed', lastSuccessAt: ago(BACKUP_CRITICAL_AFTER_HOURS), errorsCount: 0, now: NOW }).recency)
      .toBe('over_48h');
  });

  it('a future lastSuccessAt (vendor clock skew) is treated as under_24h, never negative', () => {
    const future = new Date(NOW.getTime() + 3_600_000).toISOString();
    expect(deriveBackupHealth({ status: 'completed', lastSuccessAt: future, errorsCount: 0, now: NOW }).recency)
      .toBe('under_24h');
  });

  it('accepts a Date as well as an ISO string, and ignores an unparseable one', () => {
    expect(deriveBackupHealth({ status: 'completed', lastSuccessAt: new Date(ago(2)), errorsCount: 0, now: NOW }).recency)
      .toBe('under_24h');
    expect(deriveBackupHealth({ status: 'completed', lastSuccessAt: 'not-a-date', errorsCount: 0, now: NOW }))
      .toEqual({ health: 'critical', recency: 'never', covered: false });
  });
});

describe('deriveBackupHealth — covered semantics (D4)', () => {
  it('covered is positive, fresh success evidence and is independent of health', () => {
    // The refined D4: a device whose last run FAILED but which has a 20-hour-old
    // restore point is covered AND critical. Coverage says "it has a backup";
    // health says "look at it". The posture report reads `covered`; the alert
    // center reads `health`.
    const r = deriveBackupHealth({ status: 'failed', lastSuccessAt: ago(20), errorsCount: 2, now: NOW });
    expect(r).toEqual({ health: 'critical', recency: 'under_24h', covered: true });
  });

  it('covered is true for exactly {under_24h, under_48h} across every status', () => {
    for (const status of EXTERNAL_BACKUP_STATUSES) {
      expect(deriveBackupHealth({ status, lastSuccessAt: ago(1), errorsCount: 0, now: NOW }).covered).toBe(true);
      expect(deriveBackupHealth({ status, lastSuccessAt: ago(40), errorsCount: 0, now: NOW }).covered).toBe(true);
      expect(deriveBackupHealth({ status, lastSuccessAt: ago(72), errorsCount: 0, now: NOW }).covered).toBe(false);
      expect(deriveBackupHealth({ status, lastSuccessAt: null, errorsCount: 0, now: NOW }).covered).toBe(false);
    }
  });

  it('an unknown status with a fresh success is still covered but never healthy', () => {
    const r = deriveBackupHealth({ status: 'unknown', lastSuccessAt: ago(2), errorsCount: 0, now: NOW });
    expect(r).toEqual({ health: 'unknown', recency: 'under_24h', covered: true });
  });
});

describe('deriveBackupHealth — exhaustive status x recency matrix', () => {
  const RECENCIES = [
    ['under_24h', ago(2)],
    ['under_48h', ago(36)],
    ['over_48h', ago(72)],
    ['never', null],
  ] as const;

  it('produces the documented health for all 40 cells', () => {
    const CRITICAL_STATUSES = new Set(['failed', 'over_quota', 'no_selection', 'no_backups']);
    const WARNING_STATUSES = new Set(['completed_with_errors', 'interrupted']);
    const RECENCY_STATUSES = new Set(['completed', 'in_progress', 'not_started']);

    for (const status of EXTERNAL_BACKUP_STATUSES) {
      for (const [recency, lastSuccessAt] of RECENCIES) {
        const r = deriveBackupHealth({ status, lastSuccessAt, errorsCount: 0, now: NOW });
        expect(r.recency, `${status} @ ${recency}`).toBe(recency);
        const expected =
          CRITICAL_STATUSES.has(status) ? 'critical'
          : WARNING_STATUSES.has(status) ? 'warning'
          : status === 'unknown' ? 'unknown'
          : RECENCY_STATUSES.has(status)
            ? (recency === 'under_24h' ? 'healthy' : recency === 'under_48h' ? 'warning' : 'critical')
            : (() => { throw new Error(`unclassified status ${status}`); })();
        expect(r.health, `${status} @ ${recency}`).toBe(expected);
        expect(r.covered, `${status} @ ${recency}`).toBe(recency === 'under_24h' || recency === 'under_48h');
      }
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/packages/shared
npx vitest run src/utils/backupHealth.test.ts
```
Expected: `Error: Failed to load url ./backupHealth` / `Cannot find module '../types/backupHealth'` — the modules do not exist yet.

- [ ] **Step 3: Write `packages/shared/src/types/backupHealth.ts`**

```ts
/**
 * Provider-neutral backup status, health and read-model types (#6008).
 *
 * Shared, not API-local, because four surfaces derive from the same rule: the
 * `/backup` overview, the device Backup tab, the client portal Backups page
 * and the posture report. A second copy of this vocabulary is how "this device
 * is protected" came to mean three different things.
 */

/**
 * The normalized outcome of a device's most recent backup session, for BOTH
 * first-party Breeze backups (via `mapBackupJobStatus`) and external vendors
 * (via each adapter's own mapper).
 *
 * The tuple order mirrors the `external_backup_status` Postgres enum created by
 * `apps/api/migrations/2026-10-17-120000-backup-provider-integration.sql` and
 * is asserted against live `pg_enum` by
 * `backupProviderRls.integration.test.ts`. `ALTER TYPE ... ADD VALUE` appends,
 * so any future label goes on the END of both.
 *
 * `no_backups` means "we looked and there is no session at all" — a real,
 * actionable state. `unknown` means "the vendor reported something we do not
 * recognise", which is a gap in OUR mapping and must never be rendered as
 * either healthy or failed.
 */
export const EXTERNAL_BACKUP_STATUSES = [
  'completed',
  'completed_with_errors',
  'failed',
  'in_progress',
  'interrupted',
  'over_quota',
  'no_selection',
  'not_started',
  'no_backups',
  'unknown',
] as const;

export type ExternalBackupStatus = (typeof EXTERNAL_BACKUP_STATUSES)[number];

/** The user-facing verdict. `unknown` is a fourth state, never a synonym for healthy. */
export type BackupHealth = 'healthy' | 'warning' | 'critical' | 'unknown';

/** Age of the newest SUCCESSFUL backup. `never` when there has not been one. */
export type BackupRecency = 'under_24h' | 'under_48h' | 'over_48h' | 'never';

/** The conditions W02's alert evaluator can raise for a linked provider device. */
export type BackupProviderAlertCondition =
  | 'failed'
  | 'over_quota'
  | 'no_selection'
  | 'no_backups'
  | 'completed_with_errors'
  | 'stale';

/**
 * One row of the unified backup read model (W03,
 * `apps/api/src/services/backupHealthReadModel.ts`). Declared here in W01 so
 * the API, the web overview and the portal all consume ONE shape.
 *
 * Invariants the producer must hold (spec "Unified read model"):
 * - EVERY active Breeze device in scope yields a row (`source: 'breeze'`,
 *   `status: 'no_backups'` when it has no jobs) — the unprotected population
 *   must never drop out of a jobs/provider union.
 * - A device that is both first-party-backed-up AND provider-linked yields
 *   TWO rows; consumers group by `deviceId`.
 * - Verification, test-restore, SLA-breach and readiness stay first-party and
 *   are NOT on this row: a provider success proves none of them.
 */
export interface BackupHealthRow {
  /** `'breeze:<device id>'` | `'provider:<row id>'` — stable across pages. */
  key: string;
  source: 'breeze' | 'provider';
  /** Adapter key (`'cove'`), or null for a first-party row. */
  providerKey: string | null;
  /**
   * The label to SHOW. The generic "Managed cloud backup" unless the row's
   * connection has `showProviderNameInPortal` and the caller is allowed the
   * vendor name (spec D5). Null for a first-party row.
   */
  providerLabel: string | null;
  orgId: string;
  orgName: string;
  siteId: string | null;
  /** The linked Breeze device; always set when `source === 'breeze'`. */
  deviceId: string | null;
  name: string;
  computerName: string | null;
  osType: 'workstation' | 'server' | 'unknown';
  /** `m365` rows are vendor cloud-mailbox accounts and are never linked to a device. */
  accountType: 'endpoint' | 'm365';
  status: ExternalBackupStatus;
  health: BackupHealth;
  recency: BackupRecency;
  covered: boolean;
  /** The connection is inactive or its sync is stale; `covered` is forced false. */
  stale: boolean;
  lastSuccessAt: string | null;
  lastSessionAt: string | null;
  selectedBytes: number | null;
  usedBytes: number | null;
  errorsCount: number;
  dataSources: string[];
  /** 28 entries, oldest first. `status: null` = no observation that day (grey). */
  history28d: Array<{ day: string; status: ExternalBackupStatus | null }>;
  /** `devices.status` when linked — "backup stale but the device is offline" context. */
  agentOnline: boolean | null;
}

/**
 * Bucket counts for the overview (W03). `endpoints` counts DISTINCT Breeze
 * devices; provider-only endpoints and M365 accounts have their own
 * denominators so a partner-wide view can never imply complete vendor coverage.
 */
export interface BackupHealthSummary {
  endpoints: { total: number; covered: number; uncovered: number };
  providerOnly: number;
  m365Accounts: number;
  byStatus: Record<ExternalBackupStatus, number>;
  byHealth: Record<BackupHealth, number>;
  byRecency: Record<BackupRecency, number>;
}
```

- [ ] **Step 4: Write `packages/shared/src/utils/backupHealth.ts`**

```ts
import {
  EXTERNAL_BACKUP_STATUSES,
  type BackupHealth,
  type BackupRecency,
  type ExternalBackupStatus,
} from '../types/backupHealth';

/** A success newer than this many hours is `healthy` (given a clean status). */
export const BACKUP_WARNING_AFTER_HOURS = 24;
/** A success older than this many hours is `critical` and no longer `covered`. */
export const BACKUP_CRITICAL_AFTER_HOURS = 48;

/**
 * Severity for "worst status observed today" in the daily health ledger.
 * Higher is worse. Order per the spec:
 *
 *   failed > over_quota > no_selection > no_backups > interrupted >
 *   completed_with_errors > not_started > unknown > in_progress > completed
 *
 * `in_progress` sits BELOW `completed` deliberately... no: it sits just above
 * it, because a day whose only observation is "a run is going" is marginally
 * less informative than "a run finished cleanly", and the bar should not show
 * green for a day we never saw finish. `unknown` outranks both because an
 * unmapped vendor code is a gap in OUR code, and the bar should make it
 * visible rather than average it away.
 */
export const EXTERNAL_BACKUP_STATUS_SEVERITY: Record<ExternalBackupStatus, number> = {
  failed: 90,
  over_quota: 80,
  no_selection: 70,
  no_backups: 60,
  interrupted: 50,
  completed_with_errors: 40,
  not_started: 30,
  unknown: 20,
  in_progress: 10,
  completed: 0,
};

/** The worse of two statuses, by `EXTERNAL_BACKUP_STATUS_SEVERITY`. Total and idempotent. */
export function worstBackupStatus(
  a: ExternalBackupStatus,
  b: ExternalBackupStatus,
): ExternalBackupStatus {
  return EXTERNAL_BACKUP_STATUS_SEVERITY[a] >= EXTERNAL_BACKUP_STATUS_SEVERITY[b] ? a : b;
}

/**
 * Project a first-party `backup_jobs.status` onto the shared enum so the read
 * model can derive health identically for both sources.
 *
 * `partial` becomes `completed_with_errors`, NOT `failed`: it is in
 * `RESTORABLE_BACKUP_JOB_STATUSES` (`apps/api/src/db/schema/backup.ts:82`) —
 * a partial run lost a disproportionate share of its data but DID produce a
 * real snapshot. Calling it `failed` would contradict the SLA worker and make
 * a device with a demonstrable restore point read as never backed up.
 *
 * `null` (the device has no jobs at all) becomes `no_backups`, which is what
 * keeps the unprotected population in the read model rather than dropping out
 * of the union.
 */
export function mapBackupJobStatus(
  jobStatus: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'partial' | null,
): ExternalBackupStatus {
  switch (jobStatus) {
    case 'completed':
      return 'completed';
    case 'partial':
      return 'completed_with_errors';
    case 'failed':
      return 'failed';
    case 'running':
    case 'pending':
      return 'in_progress';
    case 'cancelled':
      return 'interrupted';
    case null:
    default:
      return 'no_backups';
  }
}

/**
 * The overview's **Status** bar groups — the Cove daily-email layout, which the
 * `/backup` overview (W03) and the backup status report (W05) both render.
 *
 * Declared ONCE, here, because "Unsuccessful" is a product rule
 * (`failed + over_quota + no_selection + interrupted`), not a rendering detail:
 * a copy in the web component and a second copy in the report renderer is
 * exactly how two surfaces come to disagree about how many of a customer's
 * devices are failing.
 *
 * Order is render order. `other` is the sixth bucket and exists to make the
 * mapping TOTAL over `EXTERNAL_BACKUP_STATUSES` — a status belonging to no
 * bucket would silently vanish from a chart whose percentages still summed to
 * 100%. It collects `not_started` (the vendor knows the device but no run has
 * been scheduled) and `unknown` (a vendor code we do not map), and UIs render
 * it only when its count is non-zero, which keeps the familiar five-bar layout
 * in the normal case.
 */
export const BACKUP_STATUS_BUCKET_IDS = [
  'no_backups',
  'completed',
  'completed_with_errors',
  'in_progress',
  'unsuccessful',
  'other',
] as const;

export type BackupStatusBucketId = (typeof BACKUP_STATUS_BUCKET_IDS)[number];

/** Every `ExternalBackupStatus` lands in exactly one bucket; asserted in `backupHealth.test.ts`. */
export const BACKUP_STATUS_BUCKET_MEMBERS: Record<BackupStatusBucketId, readonly ExternalBackupStatus[]> = {
  no_backups: ['no_backups'],
  completed: ['completed'],
  completed_with_errors: ['completed_with_errors'],
  in_progress: ['in_progress'],
  unsuccessful: ['failed', 'over_quota', 'no_selection', 'interrupted'],
  other: ['not_started', 'unknown'],
};

/** Reverse index, built once from the members table so the two can never drift. */
const BUCKET_BY_STATUS: ReadonlyMap<ExternalBackupStatus, BackupStatusBucketId> = new Map(
  BACKUP_STATUS_BUCKET_IDS.flatMap((bucket) =>
    BACKUP_STATUS_BUCKET_MEMBERS[bucket].map((status) => [status, bucket] as const),
  ),
);

/**
 * The bucket one status renders in.
 *
 * Falls back to `other` rather than throwing: a future `ALTER TYPE ... ADD
 * VALUE` reaches the read model before this file is updated, and a throw there
 * would 500 the whole overview instead of showing one device in a catch-all
 * bar.
 */
export function bucketForBackupStatus(status: ExternalBackupStatus): BackupStatusBucketId {
  return BUCKET_BY_STATUS.get(status) ?? 'other';
}

/** Statuses whose verdict is fixed by the status alone. */
const CRITICAL_STATUSES: ReadonlySet<ExternalBackupStatus> = new Set([
  'failed',
  'over_quota',
  'no_selection',
  'no_backups',
]);
const WARNING_STATUSES: ReadonlySet<ExternalBackupStatus> = new Set([
  'completed_with_errors',
  'interrupted',
]);
/** Statuses whose verdict comes from how fresh the last SUCCESS is. */
const RECENCY_DRIVEN_STATUSES: ReadonlySet<ExternalBackupStatus> = new Set([
  'completed',
  'in_progress',
  'not_started',
]);

function toEpochMs(value: Date | string | null): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function recencyOf(lastSuccessAt: Date | string | null, now: Date): BackupRecency {
  const ms = toEpochMs(lastSuccessAt);
  if (ms === null) return 'never';
  // Clamp at zero: vendor clocks run ahead, and a negative age must read as
  // "just now", never wrap into `over_48h`.
  const hours = Math.max(0, (now.getTime() - ms) / 3_600_000);
  if (hours < BACKUP_WARNING_AFTER_HOURS) return 'under_24h';
  if (hours < BACKUP_CRITICAL_AFTER_HOURS) return 'under_48h';
  return 'over_48h';
}

/**
 * THE backup verdict — one pure function, applied identically to first-party
 * and provider rows (spec "Normalized status and health").
 *
 * `health` answers "should a technician look at this?" and `covered` answers
 * "does this endpoint have a recent restore point?". They are deliberately
 * INDEPENDENT (spec D4, refined on review): a device whose last run failed but
 * which has a 20-hour-old restore point is `covered` AND `critical`. Coverage
 * feeds the devices-needing-backup panel and the posture report; health feeds
 * the alert center and the overview buckets. Collapsing the two is how a
 * fresh-but-failing device came to be reported as unprotected.
 *
 * `errorsCount` only matters for `in_progress` (Cove F00 = 9, "in progress
 * with faults"): a run that is still going but already reporting faults must
 * not read as healthy off yesterday's success. For every other status the
 * status itself already carries the verdict.
 *
 * The 24h/48h thresholds are constants in phase 1; per-connection overrides are
 * an explicit phase-2 item.
 */
export function deriveBackupHealth(input: {
  status: ExternalBackupStatus;
  lastSuccessAt: Date | string | null;
  errorsCount: number;
  now?: Date;
}): { health: BackupHealth; recency: BackupRecency; covered: boolean } {
  const now = input.now ?? new Date();
  const recency = recencyOf(input.lastSuccessAt, now);
  const covered = recency === 'under_24h' || recency === 'under_48h';

  let health: BackupHealth;
  if (CRITICAL_STATUSES.has(input.status)) {
    health = 'critical';
  } else if (WARNING_STATUSES.has(input.status)) {
    health = 'warning';
  } else if (input.status === 'unknown') {
    health = 'unknown';
  } else if (input.status === 'in_progress' && input.errorsCount > 0) {
    health = 'warning';
  } else if (RECENCY_DRIVEN_STATUSES.has(input.status)) {
    health =
      recency === 'under_24h' ? 'healthy'
      : recency === 'under_48h' ? 'warning'
      : 'critical';
  } else {
    // Unreachable while EXTERNAL_BACKUP_STATUSES and the sets above agree; a
    // new label added to the enum without a branch here lands as `unknown`
    // rather than silently reading as healthy.
    health = 'unknown';
  }

  return { health, recency, covered };
}

/** Re-exported so consumers can iterate the enum without a second import. */
export { EXTERNAL_BACKUP_STATUSES };
```

- [ ] **Step 5: Export from both shared barrels**

`packages/shared/src/types/index.ts` — append after `export * from './scriptProposals';`:

```ts
export * from './backupHealth';
```

`packages/shared/src/utils/index.ts` — append after `export * from './hardwareLifecycle';`:

```ts
export * from './backupHealth';
```

That one line carries **every** runtime export of the utils module, including the bucket group — `BACKUP_STATUS_BUCKET_IDS`, `BACKUP_STATUS_BUCKET_MEMBERS` and `bucketForBackupStatus` — so W03's overview and W05's report import them from `@breeze/shared` exactly like `deriveBackupHealth`. `BackupStatusBucketId` is a type declared in the same module and rides the same star export. Verify with the probe in Step 6 rather than assuming: this barrel is `export *`-per-module and the file already carries a hand-written exception (`backupExclusionGlob`), so a future author narrowing it would silently drop the buckets.

> Both barrels re-export `EXTERNAL_BACKUP_STATUSES` (the types module declares it; the utils module re-exports it). `export *` from two modules exporting the SAME binding is an ambiguous star export and TypeScript/bundlers drop it silently. **Remove the `export { EXTERNAL_BACKUP_STATUSES };` line at the bottom of `utils/backupHealth.ts` if `npx tsc --noEmit` in `packages/shared` reports TS2308 or a consumer suddenly cannot import it**; the utils module can always be imported by path. **DECISION:** keep the re-export only if the typecheck in Step 6 is clean; the canonical home is `types/backupHealth.ts`.

- [ ] **Step 6: Run the test and the typecheck**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/packages/shared
npx vitest run src/utils/backupHealth.test.ts
npx tsc --noEmit -p tsconfig.json
node -e "const m=require('fs').readFileSync('src/utils/index.ts','utf8'); if(!m.includes(\"'./backupHealth'\")) { console.error('utils barrel does not export backupHealth'); process.exit(1); } console.log('BARREL OK');"
```
Expected: 1 test file, all cases PASS (the 40-cell matrix plus the bucket totality and round-trip cases); `tsc` clean; the probe prints `BARREL OK`. If `tsc` reports TS2308 ("Module ... has already exported a member named 'EXTERNAL_BACKUP_STATUSES'"), apply the DECISION in Step 5.

- [ ] **Step 7: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration
git add packages/shared/src/types/backupHealth.ts \
        packages/shared/src/utils/backupHealth.ts \
        packages/shared/src/utils/backupHealth.test.ts \
        packages/shared/src/types/index.ts \
        packages/shared/src/utils/index.ts
git commit -m "$(cat <<'EOF'
feat(shared): normalized external backup status and deriveBackupHealth (#6008 W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Adapter boundary — types, registry, row-bound credentials

**Files:**
- Create: `apps/api/src/services/backupProviders/types.ts`
- Create: `apps/api/src/services/backupProviders/registry.ts`
- Test: `apps/api/src/services/backupProviders/registry.test.ts`
- Create: `apps/api/src/services/backupProviders/credentials.ts`
- Test: `apps/api/src/services/backupProviders/credentials.test.ts`
- Read first: `apps/api/src/services/toolSources/secrets.ts:37-101` (the row-bound spec lookup and encrypt/decrypt pair to mirror), `apps/api/src/services/encryptedColumnRegistry.ts:43-50` (`columnAad`), `apps/api/src/services/secretCrypto.ts:388,421` (`encryptSecret` / `decryptSecret` and their `{ aad }` option)

**Interfaces:**
- Consumes `ExternalBackupStatus` from `@breeze/shared` (Task 5); `columnAad`, `encryptedColumnRegistry`, `type EncryptedColumnSpec` from `../encryptedColumnRegistry`; `encryptSecret`, `decryptSecret` from `../secretCrypto`; `z` from `zod`.
- Produces `BackupProviderAdapter`, `VendorCustomer`, `VendorDevice`, `ProviderRequestError`, `ProviderTestResult`, `BACKUP_PROVIDER_KEYS`, `BackupProviderKey`, `isBackupProviderKey`, `getBackupProvider`, `listBackupProviders`, `encryptProviderCredentials`, `decryptProviderCredentials`.

> **DECISION:** `registry.ts` imports `coveAdapter` from `./cove/adapter` (Task 9), so `registry.ts` does not typecheck until Task 9 lands. The registry is written in this task with the import in place and its test skipped-by-construction until then — in practice, execute Tasks 7→9 before running `registry.test.ts`. The alternative (a lazy `require`) trades a real compile-time guarantee for nothing.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/backupProviders/registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { BACKUP_PROVIDER_KEYS, getBackupProvider, isBackupProviderKey, listBackupProviders } from './registry';

describe('backup provider registry', () => {
  it('exposes exactly the shipped provider keys', () => {
    expect(BACKUP_PROVIDER_KEYS).toEqual(['cove']);
  });

  it('returns a fully-formed adapter for a known key', () => {
    const adapter = getBackupProvider('cove');
    expect(adapter.key).toBe('cove');
    expect(adapter.label).toBe('Cove Data Protection');
    expect(typeof adapter.testConnection).toBe('function');
    expect(typeof adapter.listCustomers).toBe('function');
    expect(typeof adapter.listDevices).toBe('function');
    // The schema must actually validate — a bare z.any() here would let a
    // malformed blob reach the vendor client.
    expect(adapter.credentialsSchema.safeParse({}).success).toBe(false);
  });

  it('throws, naming the known keys, for an unknown provider', () => {
    expect(() => getBackupProvider('veeam')).toThrow(/veeam/);
    expect(() => getBackupProvider('veeam')).toThrow(/cove/);
  });

  it('throws for a non-string-shaped key rather than returning undefined', () => {
    // A route reads `provider` off the row; a NULL or a stale value must fail
    // loudly in the sync worker, not produce `undefined.listDevices`.
    expect(() => getBackupProvider('')).toThrow();
    expect(() => getBackupProvider('__proto__')).toThrow();
  });

  it('isBackupProviderKey narrows without throwing', () => {
    expect(isBackupProviderKey('cove')).toBe(true);
    expect(isBackupProviderKey('veeam')).toBe(false);
    expect(isBackupProviderKey('__proto__')).toBe(false);
  });

  it('every registered adapter keys itself consistently', () => {
    for (const adapter of listBackupProviders()) {
      expect(BACKUP_PROVIDER_KEYS).toContain(adapter.key);
      expect(getBackupProvider(adapter.key)).toBe(adapter);
    }
  });
});
```

`apps/api/src/services/backupProviders/credentials.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { decryptProviderCredentials, encryptProviderCredentials } from './credentials';

describe('backup provider credential crypto', () => {
  const creds = { partnerName: 'OliveTech', username: 'api@olivetech.example', password: 'sup3r-s3cret' };

  it('round-trips a credential blob through the SAME row id', () => {
    const rowId = randomUUID();
    const sealed = encryptProviderCredentials(rowId, creds);
    expect(sealed).not.toContain('sup3r-s3cret');
    expect(decryptProviderCredentials(rowId, sealed)).toEqual(creds);
  });

  it('refuses to decrypt under a DIFFERENT row id (row-bound AAD)', () => {
    // The whole point of aadBinding: 'row'. Without it, someone with DB write
    // access could paste another partner's ciphertext into their own
    // connection row and have the application decrypt it back to them.
    const sealed = encryptProviderCredentials(randomUUID(), creds);
    expect(() => decryptProviderCredentials(randomUUID(), sealed)).toThrow();
  });

  it('refuses an empty row id rather than sealing under a guessable AAD', () => {
    expect(() => encryptProviderCredentials('', creds)).toThrow(/row id/i);
    expect(() => decryptProviderCredentials('', 'anything')).toThrow(/row id/i);
  });

  it('throws a typed error, not a raw JSON parse error, on a corrupt blob', () => {
    const rowId = randomUUID();
    expect(() => decryptProviderCredentials(rowId, '')).toThrow();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx vitest run src/services/backupProviders/credentials.test.ts
```
Expected: `Failed to load url ./credentials` — the module does not exist. (Hold `registry.test.ts` until Task 9; running it now fails on `./cove/adapter`.)

- [ ] **Step 3: Write `types.ts`**

```ts
import type { z } from 'zod';
import type { ExternalBackupStatus } from '@breeze/shared';

/**
 * A customer/tenant discovered in the vendor console, flattened out of
 * whatever tree shape the vendor uses.
 */
export interface VendorCustomer {
  vendorCustomerId: string;
  name: string;
  parentId: string | null;
  /** The vendor's own level/tier string, stored as-is for display. */
  level: string | null;
  /** The vendor's free-text external reference; auto-mapping tries to read a Breeze org id out of it. */
  externalCode: string | null;
}

/**
 * One device/endpoint as the vendor reports it. Deliberately flat and
 * vendor-neutral: every field either maps onto a `backup_provider_devices`
 * column or is dropped. `raw` carries the vendor's own payload for debugging
 * and for columns we have not promoted yet.
 */
export interface VendorDevice {
  vendorDeviceId: string;
  vendorCustomerId: string;
  name: string;
  computerName: string | null;
  osType: 'workstation' | 'server' | 'unknown';
  osVersion: string | null;
  clientVersion: string | null;
  /** Lower-case, colon-separated, de-duplicated. */
  macAddresses: string[];
  accountType: 'backup_manager' | 'm365' | 'unknown';
  /** Normalized source names: files, system_state, mssql, hyperv, vmware, m365_*, bare_metal, … */
  dataSources: string[];
  status: ExternalBackupStatus;
  /** The vendor's own status code, kept so an `unknown` mapping can be diagnosed. */
  vendorStatusCode: number | null;
  lastSessionAt: Date | null;
  lastSuccessAt: Date | null;
  lastCompletedAt: Date | null;
  selectedBytes: number | null;
  usedBytes: number | null;
  errorsCount: number;
  vendorCreatedAt: Date | null;
  vendorExpiresAt: Date | null;
  raw: Record<string, unknown>;
}

/**
 * A vendor API call failed.
 *
 * `reauth` is the load-bearing field: it separates "this credential is dead or
 * lacks permission" (stop retrying, mark the connection `reauth_required`, make
 * the MSP re-enter it) from "this call failed" (retry with backoff). Conflating
 * them either spams a dead connection forever or disables a healthy one on a
 * transient 500 — so an adapter must set it from the vendor's OWN signal (which
 * call failed, and its error code), never from a message substring alone.
 */
export class ProviderRequestError extends Error {
  readonly code: string;
  readonly reauth: boolean;

  constructor(message: string, options: { code: string; reauth: boolean; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ProviderRequestError';
    this.code = options.code;
    this.reauth = options.reauth;
  }
}

export type ProviderTestResult =
  | { ok: true; rootId: string; rootName: string; customerCount: number }
  | { ok: false; error: string; reauth: boolean };

/**
 * The whole vendor boundary. A second vendor is a new file implementing this
 * and one line in `registry.ts` — nothing above this interface knows Cove
 * exists.
 *
 * `listDevices` must be ALL-OR-NOTHING: it returns only when every page
 * succeeded, and throws `ProviderRequestError` otherwise. The sync job deletes
 * rows whose vendor device vanished, so a partial enumeration that looked like
 * a success would silently delete a customer's whole backup inventory.
 */
export interface BackupProviderAdapter {
  readonly key: string;
  readonly label: string;
  /** Validates the credential blob BEFORE it is encrypted and stored. */
  readonly credentialsSchema: z.ZodTypeAny;
  testConnection(creds: unknown, baseUrl: string): Promise<ProviderTestResult>;
  /** The whole subtree under `rootId`, flattened. */
  listCustomers(creds: unknown, baseUrl: string, rootId: string): Promise<VendorCustomer[]>;
  /** The whole subtree under `rootId`. Throws `ProviderRequestError` if ANY page fails. */
  listDevices(creds: unknown, baseUrl: string, rootId: string): Promise<VendorDevice[]>;
}
```

- [ ] **Step 4: Write `registry.ts`**

```ts
import { coveAdapter } from './cove/adapter';
import type { BackupProviderAdapter } from './types';

/**
 * Every backup vendor Breeze can talk to. `backup_provider_connections.provider`
 * is a plain varchar rather than a pg enum precisely so this list — not a
 * migration — is the single place a vendor is added.
 */
export const BACKUP_PROVIDER_KEYS = ['cove'] as const;

export type BackupProviderKey = (typeof BACKUP_PROVIDER_KEYS)[number];

const ADAPTERS: Record<BackupProviderKey, BackupProviderAdapter> = {
  cove: coveAdapter,
};

export function isBackupProviderKey(key: string): key is BackupProviderKey {
  return (BACKUP_PROVIDER_KEYS as readonly string[]).includes(key);
}

/**
 * The adapter for `key`, or a loud throw.
 *
 * Throwing rather than returning undefined is deliberate: the caller is either
 * a route validating operator input (which turns this into a 400) or the sync
 * worker reading a stored `provider` value (where a silent undefined becomes
 * `undefined.listDevices is not a function` three frames deeper, after the
 * connection has already been marked `running`).
 *
 * The membership test goes through `isBackupProviderKey`, not a bare
 * `ADAPTERS[key]`, so an inherited key like `__proto__` or `constructor` can
 * never resolve to something callable.
 */
export function getBackupProvider(key: string): BackupProviderAdapter {
  if (!isBackupProviderKey(key)) {
    throw new Error(
      `Unknown backup provider "${key}" (registered: ${BACKUP_PROVIDER_KEYS.join(', ')})`,
    );
  }
  return ADAPTERS[key];
}

export function listBackupProviders(): BackupProviderAdapter[] {
  return BACKUP_PROVIDER_KEYS.map((key) => ADAPTERS[key]);
}
```

- [ ] **Step 5: Write `credentials.ts`**

```ts
import {
  columnAad,
  encryptedColumnRegistry,
  type EncryptedColumnSpec,
} from '../encryptedColumnRegistry';
import { decryptSecret, encryptSecret } from '../secretCrypto';

/**
 * `backup_provider_connections.credentials_encrypted` is registered with
 * `aadBinding: 'row'` (see `encryptedColumnRegistry.ts`), exactly like
 * `tool_sources.auth_config_encrypted` and `partner_llm_configs.api_key_encrypted`.
 *
 * A backup-vendor console password is a live capability one MSP supplied for
 * ONE console tenant. A plain `table.column` AAD only stops a blob moving
 * between COLUMNS — someone with DB write access could paste partner A's
 * ciphertext into partner B's connection row and have the application decrypt
 * it back to B. Binding the AAD to the row id is what stops that swap, and is
 * why every function here demands the row id up front instead of accepting it
 * as an optional hint. The create route therefore GENERATES the row id
 * (`crypto.randomUUID()`) before encrypting, rather than letting the database
 * default it.
 */
const PROVIDER_CREDENTIALS_SPEC: EncryptedColumnSpec = (() => {
  const spec = encryptedColumnRegistry.find(
    (entry) => entry.table === 'backup_provider_connections' && entry.column === 'credentials_encrypted',
  );
  if (!spec) {
    throw new Error('backup_provider_connections.credentials_encrypted is missing from encryptedColumnRegistry');
  }
  return spec;
})();

function assertRowId(rowId: string): void {
  if (!rowId) {
    throw new Error('backup provider credentials are row-bound: a row id is required to derive their AAD');
  }
}

/**
 * Seal a credential blob for storage. The plaintext never leaves this module
 * except through `decryptProviderCredentials`, and is never logged.
 */
export function encryptProviderCredentials(connectionId: string, creds: unknown): string {
  assertRowId(connectionId);
  const sealed = encryptSecret(JSON.stringify(creds), {
    aad: columnAad(PROVIDER_CREDENTIALS_SPEC, connectionId),
  });
  if (!sealed) {
    throw new Error(`Could not encrypt backup provider credentials for connection ${connectionId}`);
  }
  return sealed;
}

/**
 * Open a credential blob. MUST be called with the SAME connection id the blob
 * was sealed under — a different id fails the AAD check inside `decryptSecret`
 * and throws, by design.
 */
export function decryptProviderCredentials(connectionId: string, ciphertext: string): unknown {
  assertRowId(connectionId);
  const plaintext = decryptSecret(ciphertext, {
    aad: columnAad(PROVIDER_CREDENTIALS_SPEC, connectionId),
  });
  if (!plaintext) {
    throw new Error(`Backup provider connection ${connectionId} has no usable credentials`);
  }
  try {
    return JSON.parse(plaintext);
  } catch (error) {
    // Never echo the plaintext into the message.
    throw new Error(
      `Backup provider connection ${connectionId} credentials are not valid JSON`,
      { cause: error },
    );
  }
}
```

- [ ] **Step 6: Run the credential test**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx vitest run src/services/backupProviders/credentials.test.ts
```
Expected: 1 file, all cases PASS. If "refuses to decrypt under a DIFFERENT row id" fails, the environment has no `APP_ENCRYPTION_KEY_ID` and `encryptSecret` fell back to v1 (which ignores AAD) — `apps/api/src/__tests__/setup.ts` sets the test key; confirm it is loaded rather than weakening the assertion.

- [ ] **Step 7: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration
git add apps/api/src/services/backupProviders/types.ts \
        apps/api/src/services/backupProviders/registry.ts \
        apps/api/src/services/backupProviders/registry.test.ts \
        apps/api/src/services/backupProviders/credentials.ts \
        apps/api/src/services/backupProviders/credentials.test.ts
git commit -m "$(cat <<'EOF'
feat(integrations): backup provider adapter boundary, registry and row-bound credential crypto (#6008 W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Cove column normalizers (pure)

**Files:**
- Create: `apps/api/src/services/backupProviders/cove/columns.ts`
- Test: `apps/api/src/services/backupProviders/cove/columns.test.ts`

**Interfaces:**
- Consumes `ExternalBackupStatus` from `@breeze/shared`, `VendorDevice` from `../types`.
- Produces `COVE_STATISTIC_COLUMNS`, `COVE_COLUMN`, `CoveStatisticsRow`, `parseCoveSettings`, `mapCoveSessionStatus`, `mapCoveOsType`, `mapCoveAccountType`, `parseCoveDataSources`, `parseCoveMacAddresses`, `coveUnixToDate`, `coveRowToVendorDevice`.
- Pure: no I/O, no clock, no imports beyond the two type-only ones above.

> **DECISION (data-source codes):** the spec's verified API-facts table names ten `I78` codes (`D01` files, `D02` system state, `D10` MsSql, `D14` Hyper-V, `D08` VMware, `D19`/`D20`/`D05`/`D23` M365 Exchange/OneDrive/SharePoint/Teams, `D17` bare metal). The normalized vocabulary in the spec's Data model also lists `network_shares`, `oracle` and `mysql`, but no verified Cove code for them. Rather than guess a code, this wave maps exactly the ten documented ones and sends every other `Dnn` to `other`, keeping the unmapped code in `vendor_raw` so the gap is diagnosable. Adding a verified code later is a one-line map entry and needs no migration.

> **DECISION (`vendor_created_at` / `vendor_expires_at`):** the spec's verified `EnumerateAccountStatistics` column table names no code for account creation or expiry, so `coveRowToVendorDevice` leaves both `null` in W01. The columns exist because phase 2 manages expiry through `ModifyAccount`; populating them from a guessed code would put unverified data in a tenant export.

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/backupProviders/cove/columns.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  COVE_STATISTIC_COLUMNS,
  coveRowToVendorDevice,
  coveUnixToDate,
  mapCoveAccountType,
  mapCoveOsType,
  mapCoveSessionStatus,
  parseCoveDataSources,
  parseCoveMacAddresses,
  parseCoveSettings,
} from './columns';

describe('COVE_STATISTIC_COLUMNS', () => {
  it('requests exactly the 18 documented codes, with no duplicates', () => {
    expect(COVE_STATISTIC_COLUMNS).toEqual([
      'I0', 'I1', 'I8', 'I14', 'I16', 'I17', 'I18', 'I21', 'I32', 'I59', 'I78',
      'D09F00', 'D09F06', 'D09F07', 'D09F08', 'D09F09', 'D09F15', 'D09F18',
    ]);
    expect(new Set(COVE_STATISTIC_COLUMNS).size).toBe(COVE_STATISTIC_COLUMNS.length);
  });
});

describe('parseCoveSettings', () => {
  it('flattens the array of single-key objects into one map', () => {
    expect(parseCoveSettings([{ I0: '1001' }, { I1: 'SRV-FS01' }, { D09F00: '5' }]))
      .toEqual({ I0: '1001', I1: 'SRV-FS01', D09F00: '5' });
  });

  it('tolerates multi-key entries, nulls and non-objects without throwing', () => {
    expect(parseCoveSettings([{ I0: '1', I1: 'a' }, null as never, 'x' as never, { I8: 'Acme' }]))
      .toEqual({ I0: '1', I1: 'a', I8: 'Acme' });
  });

  it('returns an empty map for an absent or empty Settings array', () => {
    expect(parseCoveSettings([])).toEqual({});
    expect(parseCoveSettings(undefined as never)).toEqual({});
  });

  it('lets a later duplicate key win, so a re-sent column is not silently the old value', () => {
    expect(parseCoveSettings([{ I1: 'old' }, { I1: 'new' }])).toEqual({ I1: 'new' });
  });
});

describe('mapCoveSessionStatus', () => {
  it.each([
    [1, 'in_progress'],   // InProcess
    [2, 'failed'],        // Failed
    [3, 'interrupted'],   // Aborted
    [5, 'completed'],     // Completed
    [6, 'interrupted'],   // Interrupted
    [7, 'not_started'],   // NotStarted
    [8, 'completed_with_errors'], // CompletedWithErrors
    [9, 'in_progress'],   // InProgressWithFaults — faults ride on errorsCount
    [10, 'over_quota'],   // OverQuota
    [11, 'no_selection'], // NoSelection
    [12, 'in_progress'],  // Restarted
  ] as const)('maps F00 code %i to %s', (code, expected) => {
    expect(mapCoveSessionStatus(code)).toBe(expected);
  });

  it('treats an ABSENT D09F00 as no_backups, not unknown', () => {
    // A device Cove knows about that has never run is a real, actionable state
    // ("no backups recorded"), not a gap in our mapping.
    expect(mapCoveSessionStatus(undefined)).toBe('no_backups');
    expect(mapCoveSessionStatus(null)).toBe('no_backups');
  });

  it('treats an UNRECOGNISED code as unknown, not as a failure', () => {
    // A new vendor code must never be rendered as green or as red; `unknown`
    // is what makes the gap visible.
    expect(mapCoveSessionStatus(4)).toBe('unknown');
    expect(mapCoveSessionStatus(13)).toBe('unknown');
    expect(mapCoveSessionStatus(0)).toBe('unknown');
    expect(mapCoveSessionStatus(Number.NaN)).toBe('unknown');
  });

  it('covers every code the spec documents', () => {
    const documented = [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12];
    for (const code of documented) expect(mapCoveSessionStatus(code)).not.toBe('unknown');
  });
});

describe('mapCoveOsType / mapCoveAccountType', () => {
  it.each([
    ['1', 'workstation'], [1, 'workstation'],
    ['2', 'server'], [2, 'server'],
    ['0', 'unknown'], [0, 'unknown'],
    [undefined, 'unknown'], [null, 'unknown'], ['', 'unknown'], ['x', 'unknown'], [99, 'unknown'],
  ] as const)('mapCoveOsType(%p) -> %s', (input, expected) => {
    expect(mapCoveOsType(input)).toBe(expected);
  });

  it.each([
    ['1', 'backup_manager'], [1, 'backup_manager'],
    ['2', 'm365'], [2, 'm365'],
    ['0', 'unknown'], [undefined, 'unknown'], [null, 'unknown'], ['x', 'unknown'], [7, 'unknown'],
  ] as const)('mapCoveAccountType(%p) -> %s', (input, expected) => {
    expect(mapCoveAccountType(input)).toBe(expected);
  });
});

describe('parseCoveDataSources', () => {
  it('splits the concatenated 3-char codes and normalizes each one', () => {
    expect(parseCoveDataSources('D01D02D10')).toEqual(['files', 'system_state', 'mssql']);
  });

  it('maps every documented code', () => {
    expect(parseCoveDataSources('D01')).toEqual(['files']);
    expect(parseCoveDataSources('D02')).toEqual(['system_state']);
    expect(parseCoveDataSources('D05')).toEqual(['m365_sharepoint']);
    expect(parseCoveDataSources('D08')).toEqual(['vmware']);
    expect(parseCoveDataSources('D10')).toEqual(['mssql']);
    expect(parseCoveDataSources('D14')).toEqual(['hyperv']);
    expect(parseCoveDataSources('D17')).toEqual(['bare_metal']);
    expect(parseCoveDataSources('D19')).toEqual(['m365_exchange']);
    expect(parseCoveDataSources('D20')).toEqual(['m365_onedrive']);
    expect(parseCoveDataSources('D23')).toEqual(['m365_teams']);
  });

  it('normalizes an UNDOCUMENTED code to `other` exactly once, never dropping the row', () => {
    expect(parseCoveDataSources('D01D99D98')).toEqual(['files', 'other']);
  });

  it('is empty for null, undefined, empty and a ragged tail', () => {
    expect(parseCoveDataSources(null)).toEqual([]);
    expect(parseCoveDataSources(undefined)).toEqual([]);
    expect(parseCoveDataSources('')).toEqual([]);
    // A trailing partial chunk is dropped rather than mis-decoded.
    expect(parseCoveDataSources('D01D')).toEqual(['files']);
  });

  it('de-duplicates and preserves first-seen order', () => {
    expect(parseCoveDataSources('D01D02D01')).toEqual(['files', 'system_state']);
  });

  it('is case-insensitive on the code letter', () => {
    expect(parseCoveDataSources('d01d02')).toEqual(['files', 'system_state']);
  });
});

describe('parseCoveMacAddresses', () => {
  it('lower-cases and colon-separates, accepting hyphen and dot forms', () => {
    expect(parseCoveMacAddresses('00-11-22-AA-BB-CC')).toEqual(['00:11:22:aa:bb:cc']);
    expect(parseCoveMacAddresses('0011.22AA.BBCC')).toEqual(['00:11:22:aa:bb:cc']);
    expect(parseCoveMacAddresses('00:11:22:aa:bb:cc')).toEqual(['00:11:22:aa:bb:cc']);
  });

  it('splits a multi-NIC value on comma, semicolon and whitespace, de-duplicating', () => {
    expect(parseCoveMacAddresses('00-11-22-AA-BB-CC, 00:11:22:aa:bb:cc; DE-AD-BE-EF-00-01'))
      .toEqual(['00:11:22:aa:bb:cc', 'de:ad:be:ef:00:01']);
  });

  it('drops the all-zero placeholder and anything that is not a MAC', () => {
    // A Cove agent on a host with no resolvable NIC reports 00:00:00:00:00:00;
    // matching devices on it would link every such host to the same Breeze
    // device.
    expect(parseCoveMacAddresses('00-00-00-00-00-00')).toEqual([]);
    expect(parseCoveMacAddresses('not-a-mac')).toEqual([]);
    expect(parseCoveMacAddresses(null)).toEqual([]);
    expect(parseCoveMacAddresses('')).toEqual([]);
  });
});

describe('coveUnixToDate', () => {
  it('converts Unix SECONDS (number or string) to a Date', () => {
    expect(coveUnixToDate(1_789_000_000)?.toISOString()).toBe(new Date(1_789_000_000_000).toISOString());
    expect(coveUnixToDate('1789000000')?.toISOString()).toBe(new Date(1_789_000_000_000).toISOString());
  });

  it('treats 0, negative, empty, null and non-numeric as "never"', () => {
    // Cove sends 0 for "no such session"; a naive conversion would claim a
    // backup succeeded in 1970 and make the device read as merely stale.
    expect(coveUnixToDate(0)).toBeNull();
    expect(coveUnixToDate('0')).toBeNull();
    expect(coveUnixToDate(-1)).toBeNull();
    expect(coveUnixToDate('')).toBeNull();
    expect(coveUnixToDate(null)).toBeNull();
    expect(coveUnixToDate(undefined)).toBeNull();
    expect(coveUnixToDate('later')).toBeNull();
  });
});

describe('coveRowToVendorDevice', () => {
  const row = {
    AccountId: 1001,
    PartnerId: 2001,
    Settings: [
      { I0: '1001' },
      { I1: 'SRV-FS01' },
      { I8: 'Acme Corp' },
      { I14: '128849018880' },
      { I16: 'Windows Server 2022' },
      { I17: '23.5.0.1' },
      { I18: 'srv-fs01' },
      { I21: '00-11-22-AA-BB-CC' },
      { I32: '2' },
      { I59: '1' },
      { I78: 'D01D02D10' },
      { D09F00: '5' },
      { D09F06: '0' },
      { D09F07: '107374182400' },
      { D09F08: 'opaque-colour-bar' },
      { D09F09: '1789000000' },
      { D09F15: '1789003600' },
      { D09F18: '1789003600' },
    ],
  };

  it('projects a complete row onto VendorDevice', () => {
    const device = coveRowToVendorDevice(row);
    expect(device).toMatchObject({
      vendorDeviceId: '1001',
      vendorCustomerId: '2001',
      name: 'SRV-FS01',
      computerName: 'srv-fs01',
      osType: 'server',
      osVersion: 'Windows Server 2022',
      clientVersion: '23.5.0.1',
      macAddresses: ['00:11:22:aa:bb:cc'],
      accountType: 'backup_manager',
      dataSources: ['files', 'system_state', 'mssql'],
      status: 'completed',
      vendorStatusCode: 5,
      selectedBytes: 107_374_182_400,
      usedBytes: 128_849_018_880,
      errorsCount: 0,
    });
    expect(device.lastSuccessAt?.toISOString()).toBe(new Date(1_789_000_000_000).toISOString());
    expect(device.lastSessionAt?.toISOString()).toBe(new Date(1_789_003_600_000).toISOString());
    expect(device.lastCompletedAt?.toISOString()).toBe(new Date(1_789_003_600_000).toISOString());
    // Not derivable from any documented column in this call — see the DECISION.
    expect(device.vendorCreatedAt).toBeNull();
    expect(device.vendorExpiresAt).toBeNull();
  });

  it('keeps the whole parsed Settings map in `raw`, including the opaque colour bar', () => {
    const device = coveRowToVendorDevice(row);
    expect(device.raw).toMatchObject({ D09F08: 'opaque-colour-bar', I8: 'Acme Corp' });
  });

  it('reports no_backups with a null vendorStatusCode when D09F00 is absent', () => {
    const device = coveRowToVendorDevice({
      AccountId: 1002, PartnerId: 2001,
      Settings: [{ I1: 'NEW-LAPTOP' }, { I59: '1' }],
    });
    expect(device.status).toBe('no_backups');
    expect(device.vendorStatusCode).toBeNull();
    expect(device.lastSuccessAt).toBeNull();
    expect(device.errorsCount).toBe(0);
  });

  it('carries faults on errorsCount for an in-progress-with-faults row', () => {
    const device = coveRowToVendorDevice({
      AccountId: 1003, PartnerId: 2001,
      Settings: [{ I1: 'WKS-04' }, { D09F00: '9' }, { D09F06: '4' }],
    });
    expect(device.status).toBe('in_progress');
    expect(device.errorsCount).toBe(4);
  });

  it('marks an M365 account and gives it no computer identity to match on', () => {
    const device = coveRowToVendorDevice({
      AccountId: 1004, PartnerId: 2001,
      Settings: [{ I1: 'acme.onmicrosoft.com' }, { I59: '2' }, { I78: 'D19D20' }, { D09F00: '5' }],
    });
    expect(device.accountType).toBe('m365');
    expect(device.computerName).toBeNull();
    expect(device.macAddresses).toEqual([]);
    expect(device.dataSources).toEqual(['m365_exchange', 'm365_onedrive']);
  });

  it('falls back to I0 for the id and to the id for the name when I1 is absent', () => {
    const device = coveRowToVendorDevice({ AccountId: null, PartnerId: 2001, Settings: [{ I0: '1005' }] });
    expect(device.vendorDeviceId).toBe('1005');
    expect(device.name).toBe('1005');
  });

  it('throws rather than emitting a row with no identity', () => {
    // A row we cannot key would upsert under a blank vendor_device_id and
    // collide with every other identity-less row on
    // (connection_id, vendor_device_id).
    expect(() => coveRowToVendorDevice({ AccountId: null, PartnerId: 2001, Settings: [] }))
      .toThrow(/AccountId/);
    expect(() => coveRowToVendorDevice({ AccountId: 1006, PartnerId: null, Settings: [] }))
      .toThrow(/PartnerId/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx vitest run src/services/backupProviders/cove/columns.test.ts
```
Expected: `Failed to load url ./columns`.

- [ ] **Step 3: Write `cove/columns.ts`**

```ts
import type { ExternalBackupStatus } from '@breeze/shared';
import type { VendorDevice } from '../types';

/**
 * Cove column codes, from the vendor's `EnumerateAccountStatistics` catalog.
 * Unknown codes are silently ignored by the API, so over-requesting is safe and
 * under-requesting is silent — hence the named constants.
 */
export const COVE_COLUMN = {
  ACCOUNT_ID: 'I0',
  NAME: 'I1',
  CUSTOMER_NAME: 'I8',
  USED_STORAGE_BYTES: 'I14',
  OS_VERSION: 'I16',
  CLIENT_VERSION: 'I17',
  COMPUTER_NAME: 'I18',
  MAC_ADDRESSES: 'I21',
  OS_TYPE: 'I32',
  ACCOUNT_TYPE: 'I59',
  DATA_SOURCES: 'I78',
  /** D09Fnn = totals across ALL data sources. */
  LAST_SESSION_STATUS: 'D09F00',
  ERRORS: 'D09F06',
  SELECTED_BYTES: 'D09F07',
  /** Cove's opaque 28-day colour bar. Requested and stored raw, never decoded — the ledger is ours. */
  COLOUR_BAR: 'D09F08',
  LAST_SUCCESS_TS: 'D09F09',
  LAST_SESSION_TS: 'D09F15',
  LAST_COMPLETED_TS: 'D09F18',
} as const;

/** The exact `Columns` array sent with every statistics page. */
export const COVE_STATISTIC_COLUMNS: readonly string[] = [
  COVE_COLUMN.ACCOUNT_ID,
  COVE_COLUMN.NAME,
  COVE_COLUMN.CUSTOMER_NAME,
  COVE_COLUMN.USED_STORAGE_BYTES,
  COVE_COLUMN.OS_VERSION,
  COVE_COLUMN.CLIENT_VERSION,
  COVE_COLUMN.COMPUTER_NAME,
  COVE_COLUMN.MAC_ADDRESSES,
  COVE_COLUMN.OS_TYPE,
  COVE_COLUMN.ACCOUNT_TYPE,
  COVE_COLUMN.DATA_SOURCES,
  COVE_COLUMN.LAST_SESSION_STATUS,
  COVE_COLUMN.ERRORS,
  COVE_COLUMN.SELECTED_BYTES,
  COVE_COLUMN.COLOUR_BAR,
  COVE_COLUMN.LAST_SUCCESS_TS,
  COVE_COLUMN.LAST_SESSION_TS,
  COVE_COLUMN.LAST_COMPLETED_TS,
];

/** One row as `EnumerateAccountStatistics` returns it. */
export interface CoveStatisticsRow {
  AccountId: number | string | null;
  PartnerId: number | string | null;
  Flags?: unknown;
  Settings?: Array<Record<string, unknown>>;
}

/**
 * Cove returns `Settings` as an ARRAY of single-key objects, not a map. Flatten
 * it, tolerating multi-key entries and junk rather than throwing: a single
 * malformed entry must not cost us the whole device inventory.
 *
 * A duplicated key lets the LATER value win — if the vendor ever re-sends a
 * column, the freshest value is the one that means something.
 */
export function parseCoveSettings(settings: Array<Record<string, unknown>> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(settings)) return out;
  for (const entry of settings) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    for (const [key, value] of Object.entries(entry)) out[key] = value;
  }
  return out;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

/**
 * Cove timestamps are Unix SECONDS, and `0` means "no such session". Treating 0
 * as an epoch Date would claim a 1970 backup — the device would read as merely
 * stale instead of never-backed-up, which is the difference between a warning
 * and "this customer has no protection".
 */
export function coveUnixToDate(value: unknown): Date | null {
  const seconds = toNumber(value);
  if (seconds === null || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

/**
 * `D09F00` -> the shared status enum (spec "Normalized status and health").
 *
 *   1 InProcess, 12 Restarted        -> in_progress
 *   9 InProgressWithFaults           -> in_progress (the faults ride on errorsCount)
 *   2 Failed                         -> failed
 *   3 Aborted, 6 Interrupted         -> interrupted
 *   5 Completed                      -> completed
 *   7 NotStarted                     -> not_started
 *   8 CompletedWithErrors            -> completed_with_errors
 *   10 OverQuota                     -> over_quota
 *   11 NoSelection                   -> no_selection
 *
 * ABSENT (the column is missing from `Settings` entirely) is `no_backups` — a
 * real, actionable state — while an UNRECOGNISED code is `unknown`, a gap in
 * OUR mapping that must be visible rather than rendered green or red. The
 * client logs an unrecognised code once per sync with its value, and
 * `vendor_status_code` keeps it on the row.
 */
export function mapCoveSessionStatus(code: number | null | undefined): ExternalBackupStatus {
  if (code === null || code === undefined) return 'no_backups';
  switch (code) {
    case 1:
    case 9:
    case 12:
      return 'in_progress';
    case 2:
      return 'failed';
    case 3:
    case 6:
      return 'interrupted';
    case 5:
      return 'completed';
    case 7:
      return 'not_started';
    case 8:
      return 'completed_with_errors';
    case 10:
      return 'over_quota';
    case 11:
      return 'no_selection';
    default:
      return 'unknown';
  }
}

/** `I32`: 1 workstation, 2 server, 0/absent/anything else undefined. */
export function mapCoveOsType(value: unknown): 'workstation' | 'server' | 'unknown' {
  switch (toNumber(value)) {
    case 1: return 'workstation';
    case 2: return 'server';
    default: return 'unknown';
  }
}

/** `I59`: 1 Backup Manager (an endpoint), 2 M365 (a cloud mailbox account), 0/else unknown. */
export function mapCoveAccountType(value: unknown): 'backup_manager' | 'm365' | 'unknown' {
  switch (toNumber(value)) {
    case 1: return 'backup_manager';
    case 2: return 'm365';
    default: return 'unknown';
  }
}

/**
 * `I78` is the active data sources as CONCATENATED three-character codes
 * ("D01D02D10"), not a delimited list.
 *
 * Only the ten codes the spec verifies are mapped; every other `Dnn` becomes
 * `other` (once), and the raw `I78` string stays in `vendor_raw` so an
 * unmapped code is diagnosable without a redeploy. A ragged trailing chunk is
 * dropped rather than mis-decoded.
 */
const COVE_DATA_SOURCE_BY_CODE: Readonly<Record<string, string>> = {
  D01: 'files',
  D02: 'system_state',
  D05: 'm365_sharepoint',
  D08: 'vmware',
  D10: 'mssql',
  D14: 'hyperv',
  D17: 'bare_metal',
  D19: 'm365_exchange',
  D20: 'm365_onedrive',
  D23: 'm365_teams',
};

export function parseCoveDataSources(i78: string | null | undefined): string[] {
  const raw = toText(i78);
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 3 <= raw.length; i += 3) {
    const code = raw.slice(i, i + 3).toUpperCase();
    const name = COVE_DATA_SOURCE_BY_CODE[code] ?? 'other';
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * `I21` may hold one MAC or several, separated by comma, semicolon or
 * whitespace, in colon, hyphen or Cisco dot form. Normalize to lower-case
 * colon-separated so W02's MAC tiebreaker can compare against Breeze's own
 * interface records without re-deriving the rule.
 *
 * The all-zero MAC is dropped: a Cove agent on a host with no resolvable NIC
 * reports `00:00:00:00:00:00`, and matching on it would link every such host to
 * the same Breeze device.
 */
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

export function parseCoveMacAddresses(value: unknown): string[] {
  const raw = toText(value);
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of raw.split(/[,;\s]+/)) {
    const compact = token.replace(/[.:-]/g, '').toLowerCase();
    if (compact.length !== 12 || !/^[0-9a-f]{12}$/.test(compact)) continue;
    const mac = compact.match(/.{2}/g)!.join(':');
    if (!MAC_RE.test(mac)) continue;
    if (mac === '00:00:00:00:00:00') continue;
    if (seen.has(mac)) continue;
    seen.add(mac);
    out.push(mac);
  }
  return out;
}

/**
 * Project one `EnumerateAccountStatistics` row onto the vendor-neutral
 * `VendorDevice`. Pure — the sync job does all the tenancy work.
 *
 * Throws when the row has no `AccountId`/`I0` or no `PartnerId`: a row we
 * cannot key would upsert under a blank `vendor_device_id` and collide with
 * every other identity-less row on `(connection_id, vendor_device_id)`,
 * silently overwriting one device's status with another's.
 */
export function coveRowToVendorDevice(row: CoveStatisticsRow): VendorDevice {
  const settings = parseCoveSettings(row.Settings);

  const vendorDeviceId = toText(row.AccountId) ?? toText(settings[COVE_COLUMN.ACCOUNT_ID]);
  if (!vendorDeviceId) {
    throw new Error('Cove statistics row has no AccountId (and no I0) — cannot key the device');
  }
  const vendorCustomerId = toText(row.PartnerId);
  if (!vendorCustomerId) {
    throw new Error(`Cove statistics row ${vendorDeviceId} has no PartnerId — cannot attribute the device`);
  }

  const accountType = mapCoveAccountType(settings[COVE_COLUMN.ACCOUNT_TYPE]);
  const isEndpoint = accountType !== 'm365';
  const statusCode = settings[COVE_COLUMN.LAST_SESSION_STATUS] === undefined
    ? null
    : toNumber(settings[COVE_COLUMN.LAST_SESSION_STATUS]);

  return {
    vendorDeviceId,
    vendorCustomerId,
    name: toText(settings[COVE_COLUMN.NAME]) ?? vendorDeviceId,
    // An M365 account has no computer identity, and inventing one from the
    // tenant domain would let the device matcher link a mailbox to a server.
    computerName: isEndpoint ? toText(settings[COVE_COLUMN.COMPUTER_NAME]) : null,
    osType: mapCoveOsType(settings[COVE_COLUMN.OS_TYPE]),
    osVersion: toText(settings[COVE_COLUMN.OS_VERSION]),
    clientVersion: toText(settings[COVE_COLUMN.CLIENT_VERSION]),
    macAddresses: isEndpoint ? parseCoveMacAddresses(settings[COVE_COLUMN.MAC_ADDRESSES]) : [],
    accountType,
    dataSources: parseCoveDataSources(toText(settings[COVE_COLUMN.DATA_SOURCES])),
    // `settings[D09F00] === undefined` (never ran) is `no_backups`; a present
    // but unrecognised value is `unknown`.
    status: settings[COVE_COLUMN.LAST_SESSION_STATUS] === undefined
      ? 'no_backups'
      : mapCoveSessionStatus(statusCode ?? Number.NaN),
    vendorStatusCode: statusCode,
    lastSessionAt: coveUnixToDate(settings[COVE_COLUMN.LAST_SESSION_TS]),
    lastSuccessAt: coveUnixToDate(settings[COVE_COLUMN.LAST_SUCCESS_TS]),
    lastCompletedAt: coveUnixToDate(settings[COVE_COLUMN.LAST_COMPLETED_TS]),
    selectedBytes: toNumber(settings[COVE_COLUMN.SELECTED_BYTES]),
    usedBytes: toNumber(settings[COVE_COLUMN.USED_STORAGE_BYTES]),
    errorsCount: toNumber(settings[COVE_COLUMN.ERRORS]) ?? 0,
    // No documented column in this call carries account creation or expiry;
    // phase 2 reads them through ModifyAccount. Populating them from a guessed
    // code would put unverified data into a tenant export.
    vendorCreatedAt: null,
    vendorExpiresAt: null,
    raw: settings,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx vitest run src/services/backupProviders/cove/columns.test.ts
```
Expected: 1 file, all cases PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration
git add apps/api/src/services/backupProviders/cove/columns.ts \
        apps/api/src/services/backupProviders/cove/columns.test.ts
git commit -m "$(cat <<'EOF'
feat(integrations): Cove column normalizers (F00/I32/I59/I78, MACs, timestamps) (#6008 W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Cove JSON-RPC client + recorded fixtures

**Files:**
- Create: `apps/api/src/services/backupProviders/cove/client.ts`
- Test: `apps/api/src/services/backupProviders/cove/client.test.ts`
- Create fixtures: `apps/api/src/services/backupProviders/cove/__fixtures__/login-success.json`, `login-rejected.json`, `visa-expired.json`, `enumerate-partners.json`, `statistics-page-all-statuses.json`, `statistics-page-m365.json`, `statistics-page-missing-status.json`
- Read first: `apps/api/src/services/huntressClient.ts:400-462` (the `safeFetch` + retry + non-2xx handling shape), `apps/api/src/services/urlSafety.ts:352-362,543-554` (`SafeFetchInit`, the `assertOutsideHeldDbContext` tripwire)

**Interfaces:**
- Consumes `COVE_STATISTIC_COLUMNS`, `coveRowToVendorDevice`, `type CoveStatisticsRow` from `./columns`; `ProviderRequestError`, `type VendorCustomer`, `type VendorDevice` from `../types`; `safeFetch` from `../../urlSafety`.
- Produces `CoveCredentials`, `CoveFetchImpl`, `CoveJsonRpcClientOptions`, `CoveJsonRpcClient` with `login(creds)`, `call<T>(method, params)`, `enumeratePartners(rootId)`, `enumerateAccountStatisticsAll(rootId)`, plus `COVE_PAGE_SIZE`, `COVE_MAX_PAGES`, `COVE_DEFAULT_BASE_URL`.

> **DECISION (JSON-RPC envelope):** the spec's verified facts table names the endpoint, the methods and the `visa` field but not the response envelope. This plan pins it as `{ id, visa?, result?: { result?: T }, error?: { code?: number, message?: string } }` and unwraps `result.result` when present, falling back to `result` — the shape the vendor's own docs use for every method here. A mismatch surfaces as a `ProviderRequestError { code: 'malformed_response' }` on the very first real call, not as silently-empty inventory, because `enumerateAccountStatisticsAll` refuses a non-array payload.

> **DECISION (`fields` on `EnumeratePartners`):** the spec names the fields by label (`Name`, `Level`, `ParentId`, `ExternalCode`, `State`) but the API takes numeric field ids the spec does not verify. `enumeratePartners` therefore omits `fields` and takes the default record, which already carries `Id`/`Name`/`Level`/`ParentId`/`ExternalCode`. Sending a guessed numeric array risks silently narrowing the response.

> **DECISION (default `fetchImpl` is `safeFetch`, not global `fetch`):** `base_url` is operator-supplied and therefore tenant-controlled. `safeFetch` (`services/urlSafety.ts:543`) pins DNS to a validated public IP, never follows redirects, enforces its own timeout, and carries the `assertOutsideHeldDbContext` tripwire that fails CI if the call is ever made inside a held request transaction — which is exactly the mistake the `SELF_MANAGED_DB_CONTEXT_ROUTES` registration in Task 12 exists to prevent. `AbortSignal.timeout(timeoutMs)` is passed as well, so an injected test `fetchImpl` sees a real signal.

> **DECISION (visa-expired vs rejected credentials):** the discriminator is primarily **which call failed** — a failing `Login` is always `reauth: true`, a failing non-`Login` call is only `reauth: true` when the vendor signals a permission problem. The secondary signals are a small code set and a message regex, both named constants in the file so they can be widened from a real tenant without touching the control flow. The spec's requirement that the two are "never conflated" is met by the call-identity rule, which needs no vendor-code catalog at all.

- [ ] **Step 1: Write the seven fixtures**

`__fixtures__/login-success.json`:
```json
{
  "id": "jsonrpc",
  "visa": "visa-after-login",
  "result": {
    "result": {
      "Id": 4242,
      "PartnerId": 1000,
      "PartnerName": "OliveTech",
      "Flags": ["Login"]
    }
  }
}
```

`__fixtures__/login-rejected.json`:
```json
{
  "id": "jsonrpc",
  "error": {
    "code": -32000,
    "message": "Authentication failed: invalid username or password"
  }
}
```

`__fixtures__/visa-expired.json`:
```json
{
  "id": "jsonrpc",
  "error": {
    "code": -32001,
    "message": "Visa expired"
  }
}
```

`__fixtures__/enumerate-partners.json`:
```json
{
  "id": "jsonrpc",
  "visa": "visa-2",
  "result": {
    "result": [
      { "Id": 1000, "Name": "OliveTech", "Level": "Distributor", "ParentId": 0, "ExternalCode": "", "State": "InProduction" },
      { "Id": 2001, "Name": "Acme Corp", "Level": "EndCustomer", "ParentId": 1000, "ExternalCode": "3f1d9b2a-0c44-4a1e-9d31-2b6a5f0c7e88", "State": "InProduction" },
      { "Id": 2002, "Name": "Beta Industries", "Level": "EndCustomer", "ParentId": 1000, "ExternalCode": null, "State": "InProduction" },
      { "Id": 2003, "Name": "Gamma Holdings", "Level": "Reseller", "ParentId": 1000, "ExternalCode": "GAMMA-01", "State": "InTrial" }
    ]
  }
}
```

`__fixtures__/statistics-page-all-statuses.json` — one row per documented `F00` code (11 rows) plus one unrecognised code, so a single page exercises the whole mapper:
```json
{
  "id": "jsonrpc",
  "visa": "visa-3",
  "result": {
    "result": [
      { "AccountId": 1001, "PartnerId": 2001, "Flags": [], "Settings": [ { "I0": "1001" }, { "I1": "SRV-FS01" }, { "I8": "Acme Corp" }, { "I14": "128849018880" }, { "I16": "Windows Server 2022" }, { "I17": "23.5.0.1" }, { "I18": "srv-fs01" }, { "I21": "00-11-22-AA-BB-CC" }, { "I32": "2" }, { "I59": "1" }, { "I78": "D01D02D10" }, { "D09F00": "5" }, { "D09F06": "0" }, { "D09F07": "107374182400" }, { "D09F08": "AAABBBCCC" }, { "D09F09": "1789000000" }, { "D09F15": "1789003600" }, { "D09F18": "1789003600" } ] },
      { "AccountId": 1002, "PartnerId": 2001, "Flags": [], "Settings": [ { "I1": "SRV-DB01" }, { "I18": "srv-db01" }, { "I32": "2" }, { "I59": "1" }, { "I78": "D01D10" }, { "D09F00": "8" }, { "D09F06": "12" }, { "D09F09": "1788990000" }, { "D09F15": "1789003600" } ] },
      { "AccountId": 1003, "PartnerId": 2001, "Flags": [], "Settings": [ { "I1": "WKS-01" }, { "I18": "wks-01" }, { "I32": "1" }, { "I59": "1" }, { "I78": "D01" }, { "D09F00": "2" }, { "D09F06": "3" }, { "D09F09": "1788900000" }, { "D09F15": "1789003600" } ] },
      { "AccountId": 1004, "PartnerId": 2001, "Flags": [], "Settings": [ { "I1": "WKS-02" }, { "I18": "wks-02" }, { "I32": "1" }, { "I59": "1" }, { "D09F00": "3" }, { "D09F09": "1788800000" } ] },
      { "AccountId": 1005, "PartnerId": 2002, "Flags": [], "Settings": [ { "I1": "WKS-03" }, { "I18": "wks-03" }, { "I32": "1" }, { "I59": "1" }, { "D09F00": "6" }, { "D09F09": "1788700000" } ] },
      { "AccountId": 1006, "PartnerId": 2002, "Flags": [], "Settings": [ { "I1": "WKS-04" }, { "I18": "wks-04" }, { "I32": "1" }, { "I59": "1" }, { "D09F00": "1" }, { "D09F09": "1789000000" } ] },
      { "AccountId": 1007, "PartnerId": 2002, "Flags": [], "Settings": [ { "I1": "WKS-05" }, { "I18": "wks-05" }, { "I32": "1" }, { "I59": "1" }, { "D09F00": "12" }, { "D09F09": "1789000000" } ] },
      { "AccountId": 1008, "PartnerId": 2002, "Flags": [], "Settings": [ { "I1": "WKS-06" }, { "I18": "wks-06" }, { "I32": "1" }, { "I59": "1" }, { "D09F00": "9" }, { "D09F06": "4" }, { "D09F09": "1789000000" } ] },
      { "AccountId": 1009, "PartnerId": 2002, "Flags": [], "Settings": [ { "I1": "SRV-VM01" }, { "I18": "srv-vm01" }, { "I32": "2" }, { "I59": "1" }, { "I78": "D08D14" }, { "D09F00": "10" }, { "D09F09": "1788000000" } ] },
      { "AccountId": 1010, "PartnerId": 2002, "Flags": [], "Settings": [ { "I1": "WKS-07" }, { "I18": "wks-07" }, { "I32": "1" }, { "I59": "1" }, { "D09F00": "11" } ] },
      { "AccountId": 1011, "PartnerId": 2003, "Flags": [], "Settings": [ { "I1": "WKS-08" }, { "I18": "wks-08" }, { "I32": "1" }, { "I59": "1" }, { "D09F00": "7" } ] },
      { "AccountId": 1012, "PartnerId": 2003, "Flags": [], "Settings": [ { "I1": "WKS-09" }, { "I18": "wks-09" }, { "I32": "1" }, { "I59": "1" }, { "D09F00": "77" }, { "D09F09": "1789000000" } ] }
    ]
  }
}
```

`__fixtures__/statistics-page-m365.json`:
```json
{
  "id": "jsonrpc",
  "visa": "visa-4",
  "result": {
    "result": [
      { "AccountId": 1101, "PartnerId": 2001, "Flags": [], "Settings": [ { "I1": "acme.onmicrosoft.com" }, { "I8": "Acme Corp" }, { "I14": "5368709120" }, { "I59": "2" }, { "I78": "D19D20D05D23" }, { "D09F00": "5" }, { "D09F06": "0" }, { "D09F07": "4294967296" }, { "D09F09": "1789000000" }, { "D09F15": "1789000000" } ] }
    ]
  }
}
```

`__fixtures__/statistics-page-missing-status.json`:
```json
{
  "id": "jsonrpc",
  "visa": "visa-5",
  "result": {
    "result": [
      { "AccountId": 1201, "PartnerId": 2001, "Flags": [], "Settings": [ { "I1": "NEW-LAPTOP" }, { "I18": "new-laptop" }, { "I32": "1" }, { "I59": "1" }, { "I78": "D01" } ] }
    ]
  }
}
```

- [ ] **Step 2: Write the failing test**

`apps/api/src/services/backupProviders/cove/client.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  COVE_PAGE_SIZE,
  CoveJsonRpcClient,
  type CoveFetchImpl,
} from './client';
import { ProviderRequestError } from '../types';
import loginSuccess from './__fixtures__/login-success.json';
import loginRejected from './__fixtures__/login-rejected.json';
import visaExpired from './__fixtures__/visa-expired.json';
import enumeratePartners from './__fixtures__/enumerate-partners.json';
import statisticsAll from './__fixtures__/statistics-page-all-statuses.json';
import statisticsM365 from './__fixtures__/statistics-page-m365.json';
import statisticsMissing from './__fixtures__/statistics-page-missing-status.json';

const CREDS = { partnerName: 'OliveTech', username: 'api@olivetech.example', password: 'sup3r-s3cret' };
const BASE_URL = 'https://api.backup.management/jsonapi';

/** A fetch stub that replays the given bodies in order and records every request. */
function stubFetch(bodies: Array<unknown | { httpStatus: number; body?: unknown } | Error>) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  let i = 0;
  const impl: CoveFetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const next = bodies[i++];
    if (next === undefined) throw new Error(`stubFetch: unexpected call #${i} to ${url}`);
    if (next instanceof Error) throw next;
    if (next && typeof next === 'object' && 'httpStatus' in (next as any)) {
      const spec = next as { httpStatus: number; body?: unknown };
      return {
        ok: spec.httpStatus >= 200 && spec.httpStatus < 300,
        status: spec.httpStatus,
        text: async () => JSON.stringify(spec.body ?? {}),
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(next) };
  });
  return { impl, calls };
}

function makeClient(bodies: Parameters<typeof stubFetch>[0]) {
  const { impl, calls } = stubFetch(bodies);
  // delayMs: 0 — the real 200ms inter-call spacing would make this suite
  // minutes long; the spacing itself is asserted separately below.
  return { client: new CoveJsonRpcClient({ baseUrl: BASE_URL, fetchImpl: impl, delayMs: 0 }), calls, impl };
}

/** A page of exactly COVE_PAGE_SIZE synthetic rows, to drive pagination. */
function fullPage(startId: number) {
  return {
    visa: `visa-page-${startId}`,
    result: {
      result: Array.from({ length: COVE_PAGE_SIZE }, (_, n) => ({
        AccountId: startId + n,
        PartnerId: 2001,
        Flags: [],
        Settings: [{ I1: `HOST-${startId + n}` }, { I59: '1' }, { D09F00: '5' }, { D09F09: '1789000000' }],
      })),
    },
  };
}

describe('CoveJsonRpcClient.login', () => {
  it('posts Login to the base URL and returns the visa and root partner', async () => {
    const { client, calls } = makeClient([loginSuccess]);
    const result = await client.login(CREDS);

    expect(result).toEqual({ visa: 'visa-after-login', partnerId: '1000', partnerName: 'OliveTech' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(BASE_URL);
    expect(calls[0]!.body).toMatchObject({
      jsonrpc: '2.0',
      method: 'Login',
      params: { partner: CREDS.partnerName, username: CREDS.username, password: CREDS.password },
    });
    // No visa on the very first call — there is none yet.
    expect(calls[0]!.body.params.visa).toBeUndefined();
  });

  it('raises reauth on a rejected login', async () => {
    const { client } = makeClient([loginRejected]);
    await expect(client.login(CREDS)).rejects.toMatchObject({
      name: 'ProviderRequestError',
      code: 'login_rejected',
      reauth: true,
    });
  });

  it('never puts the password or the visa in the error message', async () => {
    const { client } = makeClient([loginRejected]);
    const error = await client.login(CREDS).catch((e) => e as ProviderRequestError);
    expect(error.message).not.toContain(CREDS.password);
    expect(error.message).not.toContain('visa-after-login');
  });

  it('falls back to the supplied partner name when the vendor omits PartnerName', async () => {
    const { client } = makeClient([{ visa: 'v', result: { result: { PartnerId: 1000 } } }]);
    await expect(client.login(CREDS)).resolves.toEqual({ visa: 'v', partnerId: '1000', partnerName: 'OliveTech' });
  });

  it('raises malformed_response when the envelope carries neither result nor error', async () => {
    const { client } = makeClient([{ id: 'jsonrpc' }]);
    await expect(client.login(CREDS)).rejects.toMatchObject({ code: 'malformed_response' });
  });
});

describe('CoveJsonRpcClient.call — visa chaining', () => {
  it('sends the login visa on the next call and adopts each response visa', async () => {
    const { client, calls } = makeClient([loginSuccess, enumeratePartners, statisticsMissing]);
    await client.login(CREDS);
    await client.call('EnumeratePartners', { parentPartnerId: 1000 });
    await client.call('EnumerateAccountStatistics', { query: {} });

    expect(calls[1]!.body.params.visa).toBe('visa-after-login');   // from Login
    expect(calls[2]!.body.params.visa).toBe('visa-2');             // from EnumeratePartners
  });

  it('refuses a call before login rather than sending a visa-less request', async () => {
    const { client, impl } = makeClient([]);
    await expect(client.call('EnumeratePartners', {})).rejects.toMatchObject({ code: 'not_authenticated' });
    expect(impl).not.toHaveBeenCalled();
  });
});

describe('CoveJsonRpcClient.call — one re-login on an expired visa', () => {
  it('re-logs in exactly once and retries the SAME call', async () => {
    const { client, calls } = makeClient([
      loginSuccess,        // 1. initial login
      visaExpired,         // 2. the call fails
      { ...loginSuccess, visa: 'visa-after-relogin' }, // 3. re-login
      enumeratePartners,   // 4. the retry succeeds
    ]);
    await client.login(CREDS);
    const partners = await client.call<unknown[]>('EnumeratePartners', { parentPartnerId: 1000 });

    expect(Array.isArray(partners)).toBe(true);
    expect(calls.map((c) => c.body.method)).toEqual([
      'Login', 'EnumeratePartners', 'Login', 'EnumeratePartners',
    ]);
    expect(calls[3]!.body.params.visa).toBe('visa-after-relogin');
  });

  it('gives up after ONE re-login — a second expiry is not retried again', async () => {
    const { client, calls } = makeClient([loginSuccess, visaExpired, loginSuccess, visaExpired]);
    await client.login(CREDS);
    await expect(client.call('EnumeratePartners', {})).rejects.toMatchObject({
      code: 'visa_expired',
      reauth: false,
    });
    expect(calls).toHaveLength(4);
  });

  it('a re-login that is itself REJECTED surfaces as reauth, not as a transient failure', async () => {
    const { client } = makeClient([loginSuccess, visaExpired, loginRejected]);
    await client.login(CREDS);
    await expect(client.call('EnumeratePartners', {})).rejects.toMatchObject({
      code: 'login_rejected',
      reauth: true,
    });
  });

  it('a PERMISSION error on a non-Login call is reauth, and is NOT retried', async () => {
    const { client, calls } = makeClient([
      loginSuccess,
      { id: 'jsonrpc', error: { code: -32003, message: 'Permission denied for this operation' } },
    ]);
    await client.login(CREDS);
    await expect(client.call('EnumerateAccountStatistics', {})).rejects.toMatchObject({
      code: 'permission_denied',
      reauth: true,
    });
    expect(calls).toHaveLength(2);
  });

  it('an ordinary vendor error is neither reauth nor retried', async () => {
    const { client, calls } = makeClient([
      loginSuccess,
      { id: 'jsonrpc', error: { code: -32602, message: 'Invalid params' } },
    ]);
    await client.login(CREDS);
    await expect(client.call('EnumeratePartners', {})).rejects.toMatchObject({
      code: 'vendor_error',
      reauth: false,
    });
    expect(calls).toHaveLength(2);
  });
});

describe('CoveJsonRpcClient.call — transport failures', () => {
  it('retries a 5xx up to three times, then raises a non-reauth error', async () => {
    const { client, calls } = makeClient([
      loginSuccess,
      { httpStatus: 503 }, { httpStatus: 503 }, { httpStatus: 503 }, { httpStatus: 503 },
    ]);
    await client.login(CREDS);
    await expect(client.call('EnumeratePartners', {})).rejects.toMatchObject({
      code: 'http_503',
      reauth: false,
    });
    expect(calls).toHaveLength(5); // login + 1 attempt + 3 retries
  });

  it('succeeds when a retry recovers', async () => {
    const { client } = makeClient([loginSuccess, { httpStatus: 500 }, enumeratePartners]);
    await client.login(CREDS);
    await expect(client.call('EnumeratePartners', {})).resolves.toBeDefined();
  });

  it('treats 401/403 as reauth and does NOT retry them', async () => {
    const { client, calls } = makeClient([loginSuccess, { httpStatus: 401 }]);
    await client.login(CREDS);
    await expect(client.call('EnumeratePartners', {})).rejects.toMatchObject({
      code: 'http_401',
      reauth: true,
    });
    expect(calls).toHaveLength(2);
  });

  it('wraps a network throw as a non-reauth error after its retries', async () => {
    const { client } = makeClient([
      loginSuccess,
      new Error('ECONNRESET'), new Error('ECONNRESET'), new Error('ECONNRESET'), new Error('ECONNRESET'),
    ]);
    await client.login(CREDS);
    await expect(client.call('EnumeratePartners', {})).rejects.toMatchObject({
      code: 'network',
      reauth: false,
    });
  });

  it('raises malformed_response, not a JSON parse error, on a non-JSON body', async () => {
    const { impl } = stubFetch([loginSuccess]);
    const fetchImpl: CoveFetchImpl = vi.fn(async (url, init) => {
      if (JSON.parse(init.body).method === 'Login') return impl(url, init);
      return { ok: true, status: 200, text: async () => '<html>maintenance</html>' };
    });
    const client = new CoveJsonRpcClient({ baseUrl: BASE_URL, fetchImpl, delayMs: 0 });
    await client.login(CREDS);
    await expect(client.call('EnumeratePartners', {})).rejects.toMatchObject({ code: 'malformed_response' });
  });

  it('passes an abort signal and the timeout to the fetch impl', async () => {
    const { client, impl } = makeClient([loginSuccess]);
    await client.login(CREDS);
    const init = vi.mocked(impl).mock.calls[0]![1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.timeoutMs).toBe(30_000);
    expect(init.headers['Content-Type']).toBe('application/json');
  });
});

describe('CoveJsonRpcClient.enumeratePartners', () => {
  it('flattens the subtree into VendorCustomer, excluding the root itself', async () => {
    const { client, calls } = makeClient([loginSuccess, enumeratePartners]);
    await client.login(CREDS);
    const customers = await client.enumeratePartners('1000');

    expect(calls[1]!.body.method).toBe('EnumeratePartners');
    expect(calls[1]!.body.params).toMatchObject({ parentPartnerId: 1000, fetchRecursively: true });
    expect(customers).toEqual([
      { vendorCustomerId: '2001', name: 'Acme Corp', parentId: '1000', level: 'EndCustomer', externalCode: '3f1d9b2a-0c44-4a1e-9d31-2b6a5f0c7e88' },
      { vendorCustomerId: '2002', name: 'Beta Industries', parentId: '1000', level: 'EndCustomer', externalCode: null },
      { vendorCustomerId: '2003', name: 'Gamma Holdings', parentId: '1000', level: 'Reseller', externalCode: 'GAMMA-01' },
    ]);
  });

  it('raises malformed_response when the payload is not an array', async () => {
    const { client } = makeClient([loginSuccess, { visa: 'v', result: { result: { Id: 1 } } }]);
    await client.login(CREDS);
    await expect(client.enumeratePartners('1000')).rejects.toMatchObject({ code: 'malformed_response' });
  });
});

describe('CoveJsonRpcClient.enumerateAccountStatisticsAll', () => {
  it('requests the documented column set at the root partner', async () => {
    const { client, calls } = makeClient([loginSuccess, statisticsMissing]);
    await client.login(CREDS);
    await client.enumerateAccountStatisticsAll('1000');

    const query = calls[1]!.body.params.query;
    expect(calls[1]!.body.method).toBe('EnumerateAccountStatistics');
    expect(query).toMatchObject({
      PartnerId: 1000,
      SelectionMode: 'Merged',
      StartRecordNumber: 0,
      RecordsCount: COVE_PAGE_SIZE,
    });
    expect(query.Columns).toContain('D09F00');
    expect(query.Columns).toContain('I78');
    expect(query.Columns).toHaveLength(18);
  });

  it('maps a full page, including the M365 row and the never-run row', async () => {
    const { client } = makeClient([loginSuccess, statisticsAll, statisticsM365, statisticsMissing]);
    await client.login(CREDS);
    // Three consecutive SHORT pages would stop after the first; drive them one
    // call at a time to assert the mapping, and test pagination separately.
    const devices = await client.enumerateAccountStatisticsAll('1000');

    expect(devices).toHaveLength(12);
    expect(devices.map((d) => d.status)).toEqual([
      'completed', 'completed_with_errors', 'failed', 'interrupted', 'interrupted',
      'in_progress', 'in_progress', 'in_progress', 'over_quota', 'no_selection',
      'not_started', 'unknown',
    ]);
    expect(devices[0]!.macAddresses).toEqual(['00:11:22:aa:bb:cc']);
    expect(devices[7]!.errorsCount).toBe(4);
    expect(devices[11]!.vendorStatusCode).toBe(77);
  });

  it('pages until a SHORT page and concatenates in order', async () => {
    const { client, calls } = makeClient([
      loginSuccess,
      fullPage(1),                    // exactly COVE_PAGE_SIZE -> keep going
      { visa: 'v', result: { result: [{ AccountId: 9001, PartnerId: 2001, Settings: [{ I1: 'LAST' }, { D09F00: '5' }] }] } },
    ]);
    await client.login(CREDS);
    const devices = await client.enumerateAccountStatisticsAll('1000');

    expect(devices).toHaveLength(COVE_PAGE_SIZE + 1);
    expect(devices.at(-1)!.name).toBe('LAST');
    expect(calls[1]!.body.params.query.StartRecordNumber).toBe(0);
    expect(calls[2]!.body.params.query.StartRecordNumber).toBe(COVE_PAGE_SIZE);
  });

  it('stops immediately on an EMPTY first page', async () => {
    const { client, calls } = makeClient([loginSuccess, { visa: 'v', result: { result: [] } }]);
    await client.login(CREDS);
    await expect(client.enumerateAccountStatisticsAll('1000')).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('ABORTS the whole enumeration when any page fails — never returns a partial list', async () => {
    // This is the single most consequential behaviour in the file: the sync job
    // DELETES rows whose vendor device vanished, so a partial enumeration that
    // looked like a success would wipe a customer's whole backup inventory.
    const { client } = makeClient([
      loginSuccess,
      fullPage(1),
      { httpStatus: 500 }, { httpStatus: 500 }, { httpStatus: 500 }, { httpStatus: 500 },
    ]);
    await client.login(CREDS);
    await expect(client.enumerateAccountStatisticsAll('1000')).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it('refuses to page forever, raising too_many_pages past the cap', async () => {
    const bodies: unknown[] = [loginSuccess];
    for (let i = 0; i <= 200; i++) bodies.push(fullPage(i * COVE_PAGE_SIZE + 1));
    const { client } = makeClient(bodies);
    await client.login(CREDS);
    await expect(client.enumerateAccountStatisticsAll('1000')).rejects.toMatchObject({ code: 'too_many_pages' });
  });

  it('skips an identity-less row instead of failing the whole page', async () => {
    const { client } = makeClient([
      loginSuccess,
      { visa: 'v', result: { result: [
        { AccountId: null, PartnerId: 2001, Settings: [] },
        { AccountId: 1301, PartnerId: 2001, Settings: [{ I1: 'GOOD' }, { D09F00: '5' }] },
      ] } },
    ]);
    await client.login(CREDS);
    const devices = await client.enumerateAccountStatisticsAll('1000');
    expect(devices.map((d) => d.name)).toEqual(['GOOD']);
  });
});

describe('CoveJsonRpcClient — call spacing', () => {
  it('waits delayMs between calls, and not before the first', async () => {
    const waits: number[] = [];
    const { impl } = stubFetch([loginSuccess, enumeratePartners]);
    const client = new CoveJsonRpcClient({
      baseUrl: BASE_URL,
      fetchImpl: impl,
      delayMs: 200,
      sleepImpl: async (ms: number) => { waits.push(ms); },
    });
    await client.login(CREDS);
    await client.call('EnumeratePartners', {});
    expect(waits).toEqual([200]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx vitest run src/services/backupProviders/cove/client.test.ts
```
Expected: `Failed to load url ./client`.

- [ ] **Step 4: Write `cove/client.ts`**

```ts
import { safeFetch } from '../../urlSafety';
import { ProviderRequestError, type VendorCustomer, type VendorDevice } from '../types';
import { COVE_STATISTIC_COLUMNS, coveRowToVendorDevice, type CoveStatisticsRow } from './columns';

export const COVE_DEFAULT_BASE_URL = 'https://api.backup.management/jsonapi';
/** Cove's documented page size for EnumerateAccountStatistics. */
export const COVE_PAGE_SIZE = 1000;
/**
 * Hard stop on pagination. 200 pages = 200,000 devices, an order of magnitude
 * past the largest realistic MSP. Without it, a vendor bug that ignores
 * `StartRecordNumber` turns one sync into an unbounded loop holding a worker
 * slot forever.
 */
export const COVE_MAX_PAGES = 200;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_DELAY_MS = 200;
const MAX_TRANSPORT_RETRIES = 3;

export interface CoveCredentials {
  partnerName: string;
  username: string;
  password: string;
}

/** The subset of a fetch response this client needs; keeps the test stub tiny. */
export interface CoveFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type CoveFetchImpl = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
    timeoutMs: number;
  },
) => Promise<CoveFetchResponse>;

export interface CoveJsonRpcClientOptions {
  baseUrl: string;
  /**
   * Defaults to `safeFetch`: `base_url` is operator-supplied and therefore
   * tenant-controlled, so the request must go through the SSRF guard (DNS
   * pinned to a validated public IP, redirects never followed) AND through its
   * `assertOutsideHeldDbContext` tripwire, which fails CI if this is ever
   * called inside a held request transaction.
   */
  fetchImpl?: CoveFetchImpl;
  /** Spacing between consecutive calls. 0 in tests. */
  delayMs?: number;
  timeoutMs?: number;
  /** Injectable for tests; defaults to a real timer. */
  sleepImpl?: (ms: number) => Promise<void>;
  logger?: Pick<Console, 'warn' | 'error'>;
}

interface CoveRpcEnvelope {
  id?: unknown;
  visa?: unknown;
  result?: { result?: unknown } | unknown;
  error?: { code?: number; message?: string } | null;
}

/**
 * Vendor error codes we recognise. Best-effort: the message regexes below are
 * the real discriminators, and the CALL IDENTITY (Login vs not) is what decides
 * `reauth`. Widen these from a real tenant's logs without touching the control
 * flow.
 */
const VISA_EXPIRED_CODES = new Set([-32001]);
const VISA_EXPIRED_MESSAGE = /\bvisa\b|session (?:has )?expired|not authenticated/i;
const PERMISSION_DENIED_CODES = new Set([-32003]);
const PERMISSION_DENIED_MESSAGE = /permission|not authori[sz]ed|access denied|forbidden/i;

const defaultFetchImpl: CoveFetchImpl = (url, init) =>
  safeFetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    timeoutMs: init.timeoutMs,
  });

function unwrapResult(env: CoveRpcEnvelope): unknown {
  const outer = env.result;
  if (outer && typeof outer === 'object' && 'result' in (outer as Record<string, unknown>)) {
    return (outer as { result: unknown }).result;
  }
  return outer;
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

/**
 * A JSON-RPC client for Cove Data Protection.
 *
 * Auth is a 15-minute `visa`, not a static key: `Login` mints one, every
 * response carries a fresh one, and the client always sends the newest it has
 * seen. An expired visa mid-sync triggers EXACTLY ONE re-login and one retry of
 * the same call — more would turn a genuinely revoked credential into an
 * unbounded login loop against the vendor.
 *
 * Nothing in this class ever logs the password or a visa.
 */
export class CoveJsonRpcClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: CoveFetchImpl;
  private readonly delayMs: number;
  private readonly timeoutMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly logger: Pick<Console, 'warn' | 'error'>;

  private visa: string | null = null;
  private credentials: CoveCredentials | null = null;
  private calledAtLeastOnce = false;
  /** Codes already reported this run, so one sync logs each unknown code once. */
  private readonly reportedUnknownCodes = new Set<number>();

  constructor(options: CoveJsonRpcClientOptions) {
    this.baseUrl = options.baseUrl || COVE_DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? defaultFetchImpl;
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.logger = options.logger ?? console;
  }

  /** Authenticate and remember the visa + credentials for the one permitted re-login. */
  async login(creds: CoveCredentials): Promise<{ visa: string; partnerId: string; partnerName: string }> {
    this.credentials = creds;
    const payload = await this.rpc('Login', {
      partner: creds.partnerName,
      username: creds.username,
      password: creds.password,
    }, { isLogin: true });

    const record = (payload ?? {}) as Record<string, unknown>;
    const partnerId = asText(record.PartnerId) ?? asText(record.Id);
    if (!this.visa || !partnerId) {
      throw new ProviderRequestError('Cove Login returned no visa or partner id', {
        code: 'malformed_response',
        reauth: false,
      });
    }
    return {
      visa: this.visa,
      partnerId,
      // Cove echoes the console partner name; fall back to what the operator
      // typed so the connection card is never blank.
      partnerName: asText(record.PartnerName) ?? creds.partnerName,
    };
  }

  /**
   * One authenticated RPC, with the visa attached and one re-login retry on an
   * expired visa.
   */
  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.visa) {
      throw new ProviderRequestError(`Cove ${method} attempted before login`, {
        code: 'not_authenticated',
        reauth: false,
      });
    }
    try {
      return (await this.rpc(method, params, { isLogin: false })) as T;
    } catch (error) {
      if (!(error instanceof ProviderRequestError) || error.code !== 'visa_expired') throw error;
      if (!this.credentials) throw error;
      // Exactly one re-login. A rejected re-login surfaces as `login_rejected`
      // (reauth: true) from `rpc`, which is what marks the connection dead.
      await this.rpc('Login', {
        partner: this.credentials.partnerName,
        username: this.credentials.username,
        password: this.credentials.password,
      }, { isLogin: true });
      return (await this.rpc(method, params, { isLogin: false, noVisaRetry: true })) as T;
    }
  }

  /** Every customer under `rootId`, flattened, excluding the root itself. */
  async enumeratePartners(rootId: string): Promise<VendorCustomer[]> {
    // `fields` is deliberately omitted: the API takes numeric field ids we have
    // not verified, and the default record already carries
    // Id/Name/Level/ParentId/ExternalCode.
    const payload = await this.call<unknown>('EnumeratePartners', {
      parentPartnerId: Number(rootId),
      fetchRecursively: true,
    });
    if (!Array.isArray(payload)) {
      throw new ProviderRequestError('Cove EnumeratePartners did not return a list', {
        code: 'malformed_response',
        reauth: false,
      });
    }
    const out: VendorCustomer[] = [];
    for (const raw of payload) {
      if (!raw || typeof raw !== 'object') continue;
      const record = raw as Record<string, unknown>;
      const vendorCustomerId = asText(record.Id);
      if (!vendorCustomerId || vendorCustomerId === String(rootId)) continue;
      out.push({
        vendorCustomerId,
        name: asText(record.Name) ?? vendorCustomerId,
        parentId: asText(record.ParentId),
        level: asText(record.Level),
        externalCode: asText(record.ExternalCode),
      });
    }
    return out;
  }

  /**
   * Every device across every customer under `rootId`.
   *
   * ALL-OR-NOTHING. The sync job deletes rows whose vendor device vanished, so
   * a partial enumeration returned as a success would delete a customer's whole
   * backup inventory. Any page failure propagates as a `ProviderRequestError`
   * and nothing is written.
   */
  async enumerateAccountStatisticsAll(rootId: string): Promise<VendorDevice[]> {
    const devices: VendorDevice[] = [];
    let startRecordNumber = 0;

    for (let page = 0; page < COVE_MAX_PAGES; page++) {
      const payload = await this.call<unknown>('EnumerateAccountStatistics', {
        query: {
          PartnerId: Number(rootId),
          Filter: '',
          Columns: [...COVE_STATISTIC_COLUMNS],
          SelectionMode: 'Merged',
          StartRecordNumber: startRecordNumber,
          RecordsCount: COVE_PAGE_SIZE,
          OrderBy: 'I0 ASC',
        },
      });
      if (!Array.isArray(payload)) {
        throw new ProviderRequestError('Cove EnumerateAccountStatistics did not return a list', {
          code: 'malformed_response',
          reauth: false,
        });
      }

      for (const raw of payload) {
        try {
          const device = coveRowToVendorDevice(raw as CoveStatisticsRow);
          if (device.vendorStatusCode !== null && device.status === 'unknown'
              && !this.reportedUnknownCodes.has(device.vendorStatusCode)) {
            this.reportedUnknownCodes.add(device.vendorStatusCode);
            this.logger.warn(`[cove] unmapped session status code ${device.vendorStatusCode}`);
          }
          devices.push(device);
        } catch (error) {
          // One unusable row must not cost the whole inventory — but it is
          // logged, because a systematic identity problem would otherwise be
          // invisible. NOT counted as a page failure.
          this.logger.warn(
            `[cove] skipping an unusable statistics row: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (payload.length < COVE_PAGE_SIZE) return devices;
      startRecordNumber += COVE_PAGE_SIZE;
    }

    throw new ProviderRequestError(
      `Cove EnumerateAccountStatistics exceeded ${COVE_MAX_PAGES} pages — refusing to page further`,
      { code: 'too_many_pages', reauth: false },
    );
  }

  // -------------------------------------------------------------------------

  private async rpc(
    method: string,
    params: Record<string, unknown>,
    opts: { isLogin: boolean; noVisaRetry?: boolean },
  ): Promise<unknown> {
    let lastTransportError: ProviderRequestError | null = null;

    for (let attempt = 0; attempt <= MAX_TRANSPORT_RETRIES; attempt++) {
      if (this.calledAtLeastOnce && this.delayMs > 0) await this.sleepImpl(this.delayMs);
      this.calledAtLeastOnce = true;

      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 'jsonrpc',
        method,
        params: this.visa && !opts.isLogin ? { ...params, visa: this.visa } : params,
      });

      let response: CoveFetchResponse;
      try {
        response = await this.fetchImpl(this.baseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
          timeoutMs: this.timeoutMs,
        });
      } catch (error) {
        lastTransportError = new ProviderRequestError(
          `Cove ${method} request failed: ${error instanceof Error ? error.message : String(error)}`,
          { code: 'network', reauth: false, cause: error },
        );
        continue;
      }

      if (!response.ok) {
        // 401/403 is a credential/permission problem: retrying cannot help and
        // would hammer the vendor with a dead credential.
        const reauth = response.status === 401 || response.status === 403;
        const err = new ProviderRequestError(
          `Cove ${method} returned HTTP ${response.status}`,
          { code: `http_${response.status}`, reauth },
        );
        if (reauth || response.status < 500) throw err;
        lastTransportError = err;
        continue;
      }

      const text = await response.text();
      let envelope: CoveRpcEnvelope;
      try {
        envelope = JSON.parse(text) as CoveRpcEnvelope;
      } catch {
        // No body preview in the message: a vendor error page can echo back
        // request material.
        throw new ProviderRequestError(`Cove ${method} returned a non-JSON response`, {
          code: 'malformed_response',
          reauth: false,
        });
      }

      // Every response carries a fresh visa; adopt it even on an error envelope.
      const freshVisa = asText(envelope.visa);
      if (freshVisa) this.visa = freshVisa;

      if (envelope.error) {
        throw this.classifyVendorError(method, envelope.error, opts);
      }
      if (!('result' in envelope) || envelope.result === undefined || envelope.result === null) {
        throw new ProviderRequestError(`Cove ${method} returned neither a result nor an error`, {
          code: 'malformed_response',
          reauth: false,
        });
      }
      return unwrapResult(envelope);
    }

    throw lastTransportError ?? new ProviderRequestError(`Cove ${method} failed`, {
      code: 'network',
      reauth: false,
    });
  }

  /**
   * The one place "the credential is dead" and "the visa aged out" are told
   * apart, and they are NEVER conflated:
   *
   *   - a failing `Login` is ALWAYS `login_rejected` / reauth — the operator
   *     must re-enter the credential;
   *   - a non-Login call whose error looks like a permission problem is
   *     `permission_denied` / reauth — the console user's role was narrowed;
   *   - a non-Login call whose error looks like an aged visa is `visa_expired`
   *     / NOT reauth — `call()` re-logs in once and retries;
   *   - anything else is `vendor_error` / NOT reauth.
   */
  private classifyVendorError(
    method: string,
    error: { code?: number; message?: string },
    opts: { isLogin: boolean; noVisaRetry?: boolean },
  ): ProviderRequestError {
    const message = error.message ?? 'unknown error';
    const code = typeof error.code === 'number' ? error.code : null;

    if (opts.isLogin) {
      return new ProviderRequestError(`Cove login was rejected: ${message}`, {
        code: 'login_rejected',
        reauth: true,
      });
    }
    if ((code !== null && PERMISSION_DENIED_CODES.has(code)) || PERMISSION_DENIED_MESSAGE.test(message)) {
      return new ProviderRequestError(`Cove ${method} was denied: ${message}`, {
        code: 'permission_denied',
        reauth: true,
      });
    }
    if ((code !== null && VISA_EXPIRED_CODES.has(code)) || VISA_EXPIRED_MESSAGE.test(message)) {
      return new ProviderRequestError(`Cove ${method} failed on an expired visa: ${message}`, {
        code: 'visa_expired',
        // Not reauth: `call()` handles this by re-logging in once. Only if that
        // re-login is itself rejected does the connection become reauth.
        reauth: false,
      });
    }
    return new ProviderRequestError(`Cove ${method} failed: ${message}`, {
      code: 'vendor_error',
      reauth: false,
    });
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx vitest run src/services/backupProviders/cove/client.test.ts
```
Expected: 1 file, all cases PASS. If the JSON fixture imports fail with "Cannot find module ... .json", confirm `resolveJsonModule` is on (`apps/api/src/services/nvdClient.test.ts:4` already imports a fixture this way, so it is).

- [ ] **Step 6: Prove the client never logs a credential**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration
grep -n 'password\|visa' apps/api/src/services/backupProviders/cove/client.ts | grep -i 'log\|console\|warn\|error('
```
Expected: no line where a `password` or `visa` VALUE reaches a logger. The only `logger.warn` calls carry an unmapped status code and a row-identity message; the only `password` references are the two `params` literals.

- [ ] **Step 7: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration
git add apps/api/src/services/backupProviders/cove/client.ts \
        apps/api/src/services/backupProviders/cove/client.test.ts \
        apps/api/src/services/backupProviders/cove/__fixtures__
git commit -m "$(cat <<'EOF'
feat(integrations): Cove JSON-RPC client with visa chaining, pagination and fixtures (#6008 W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Cove adapter + registry wiring

**Files:**
- Create: `apps/api/src/services/backupProviders/cove/adapter.ts`
- Test: `apps/api/src/services/backupProviders/cove/adapter.test.ts`
- Run (now unblocked): `apps/api/src/services/backupProviders/registry.test.ts` from Task 6

**Interfaces:**
- Consumes `CoveJsonRpcClient`, `COVE_DEFAULT_BASE_URL`, `type CoveCredentials`, `type CoveFetchImpl` from `./client`; `ProviderRequestError`, `type BackupProviderAdapter`, `type ProviderTestResult`, `type VendorCustomer`, `type VendorDevice` from `../types`; `z` from `zod`.
- Produces `coveCredentialsSchema`, `COVE_PROVIDER_KEY`, `COVE_PROVIDER_LABEL`, `coveAdapter`, and `__setCoveClientFactoryForTests` (a seam so the adapter test drives a stub client without a real socket).

> **DECISION (client injection seam):** `coveAdapter` builds its own `CoveJsonRpcClient`, so the adapter test needs a seam. Rather than threading a factory through the `BackupProviderAdapter` interface (which every future vendor would then have to carry), the module exports `__setCoveClientFactoryForTests`, mirroring the repo's existing test-seam convention for vendor clients. It is a no-op in production.

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/backupProviders/cove/adapter.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { coveAdapter, coveCredentialsSchema, __setCoveClientFactoryForTests } from './adapter';
import { ProviderRequestError } from '../types';

const CREDS = { partnerName: 'OliveTech', username: 'api@olivetech.example', password: 'sup3r-s3cret' };
const BASE_URL = 'https://api.backup.management/jsonapi';

function stubClient(overrides: Partial<{
  login: () => Promise<{ visa: string; partnerId: string; partnerName: string }>;
  enumeratePartners: (rootId: string) => Promise<unknown[]>;
  enumerateAccountStatisticsAll: (rootId: string) => Promise<unknown[]>;
}> = {}) {
  const client = {
    login: overrides.login ?? vi.fn(async () => ({ visa: 'v', partnerId: '1000', partnerName: 'OliveTech' })),
    enumeratePartners: overrides.enumeratePartners ?? vi.fn(async () => []),
    enumerateAccountStatisticsAll: overrides.enumerateAccountStatisticsAll ?? vi.fn(async () => []),
  };
  __setCoveClientFactoryForTests(() => client as never);
  return client;
}

afterEach(() => __setCoveClientFactoryForTests(null));

describe('coveCredentialsSchema', () => {
  it('accepts a complete blob and strips unknown keys', () => {
    const parsed = coveCredentialsSchema.parse({ ...CREDS, extra: 'nope' });
    expect(parsed).toEqual(CREDS);
  });

  it.each(['partnerName', 'username', 'password'] as const)('rejects a missing %s', (field) => {
    const bad: Record<string, unknown> = { ...CREDS };
    delete bad[field];
    expect(coveCredentialsSchema.safeParse(bad).success).toBe(false);
  });

  it.each(['partnerName', 'username', 'password'] as const)('rejects a blank %s', (field) => {
    expect(coveCredentialsSchema.safeParse({ ...CREDS, [field]: '   ' }).success).toBe(false);
  });

  it('trims surrounding whitespace on the identity fields but not on the password', () => {
    // A pasted username picks up a trailing space; a password may legitimately
    // end in one, and silently trimming it turns a working credential into an
    // unexplained auth failure.
    const parsed = coveCredentialsSchema.parse({ partnerName: ' OliveTech ', username: ' api@x ', password: ' p ' });
    expect(parsed).toEqual({ partnerName: 'OliveTech', username: 'api@x', password: ' p ' });
  });

  it('rejects an oversized field rather than sending it to the vendor', () => {
    expect(coveCredentialsSchema.safeParse({ ...CREDS, password: 'x'.repeat(5001) }).success).toBe(false);
  });
});

describe('coveAdapter identity', () => {
  it('exposes the contracted key and label', () => {
    expect(coveAdapter.key).toBe('cove');
    expect(coveAdapter.label).toBe('Cove Data Protection');
  });
});

describe('coveAdapter.testConnection', () => {
  it('returns the root partner and the customer count on success', async () => {
    stubClient({
      enumeratePartners: vi.fn(async () => [{ vendorCustomerId: '2001' }, { vendorCustomerId: '2002' }]),
    });
    await expect(coveAdapter.testConnection(CREDS, BASE_URL)).resolves.toEqual({
      ok: true, rootId: '1000', rootName: 'OliveTech', customerCount: 2,
    });
  });

  it('returns ok:false with reauth:true when the login is rejected', async () => {
    stubClient({
      login: vi.fn(async () => {
        throw new ProviderRequestError('Cove login was rejected: bad password', { code: 'login_rejected', reauth: true });
      }),
    });
    const result = await coveAdapter.testConnection(CREDS, BASE_URL);
    expect(result).toMatchObject({ ok: false, reauth: true });
    // The message is shown to the operator — it must carry the vendor's reason
    // and none of the credential.
    expect((result as { error: string }).error).toContain('rejected');
    expect((result as { error: string }).error).not.toContain(CREDS.password);
  });

  it('returns ok:false with reauth:false for a transient failure', async () => {
    stubClient({
      enumeratePartners: vi.fn(async () => {
        throw new ProviderRequestError('Cove EnumeratePartners returned HTTP 503', { code: 'http_503', reauth: false });
      }),
    });
    await expect(coveAdapter.testConnection(CREDS, BASE_URL)).resolves.toMatchObject({ ok: false, reauth: false });
  });

  it('never throws — an unexpected error still comes back as ok:false', async () => {
    // The route turns this into a 200 `{success:false}` body; a throw would
    // surface as a 500 and the web card could not explain anything.
    stubClient({ login: vi.fn(async () => { throw new TypeError('boom'); }) });
    await expect(coveAdapter.testConnection(CREDS, BASE_URL)).resolves.toMatchObject({ ok: false, reauth: false });
  });

  it('rejects a credential blob that fails the schema, without calling the vendor', async () => {
    const client = stubClient();
    const result = await coveAdapter.testConnection({ username: 'x' }, BASE_URL);
    expect(result).toMatchObject({ ok: false, reauth: true });
    expect(client.login).not.toHaveBeenCalled();
  });
});

describe('coveAdapter.listCustomers / listDevices', () => {
  it('logs in once and delegates to the client', async () => {
    const client = stubClient({
      enumeratePartners: vi.fn(async () => [{ vendorCustomerId: '2001', name: 'Acme', parentId: '1000', level: 'EndCustomer', externalCode: null }]),
    });
    const customers = await coveAdapter.listCustomers(CREDS, BASE_URL, '1000');
    expect(client.login).toHaveBeenCalledTimes(1);
    expect(client.enumeratePartners).toHaveBeenCalledWith('1000');
    expect(customers).toHaveLength(1);
  });

  it('propagates a ProviderRequestError from listDevices unchanged (all-or-nothing)', async () => {
    stubClient({
      enumerateAccountStatisticsAll: vi.fn(async () => {
        throw new ProviderRequestError('page 3 failed', { code: 'http_500', reauth: false });
      }),
    });
    // NOT swallowed into an empty array: the sync job deletes vanished devices,
    // so an empty list from a failed enumeration would wipe the inventory.
    await expect(coveAdapter.listDevices(CREDS, BASE_URL, '1000'))
      .rejects.toBeInstanceOf(ProviderRequestError);
  });

  it('wraps a schema failure as a reauth ProviderRequestError', async () => {
    const client = stubClient();
    await expect(coveAdapter.listDevices({ username: 'x' }, BASE_URL, '1000'))
      .rejects.toMatchObject({ code: 'invalid_credentials', reauth: true });
    expect(client.login).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx vitest run src/services/backupProviders/cove/adapter.test.ts
```
Expected: `Failed to load url ./adapter`.

- [ ] **Step 3: Write `cove/adapter.ts`**

```ts
import { z } from 'zod';
import {
  COVE_DEFAULT_BASE_URL,
  CoveJsonRpcClient,
  type CoveCredentials,
} from './client';
import {
  ProviderRequestError,
  type BackupProviderAdapter,
  type ProviderTestResult,
  type VendorCustomer,
  type VendorDevice,
} from '../types';

export const COVE_PROVIDER_KEY = 'cove';
export const COVE_PROVIDER_LABEL = 'Cove Data Protection';

/**
 * The credential blob stored (encrypted, row-bound) in
 * `backup_provider_connections.credentials_encrypted`.
 *
 * Cove has no static API key: this is a real console login. The UI tells the
 * MSP to create a dedicated user with a read-only role, a unique password and
 * NO 2FA, and the password is never returned by any route.
 *
 * Identity fields are trimmed (a pasted username reliably picks up a trailing
 * space); the password deliberately is NOT — a password may legitimately end
 * in whitespace, and silently trimming it turns a working credential into an
 * unexplained auth failure the operator cannot debug.
 */
export const coveCredentialsSchema = z.object({
  partnerName: z.string().trim().min(1).max(200),
  username: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(5000),
}).strip();

type CoveClientLike = Pick<
  CoveJsonRpcClient,
  'login' | 'enumeratePartners' | 'enumerateAccountStatisticsAll'
>;

type CoveClientFactory = (baseUrl: string) => CoveClientLike;

const productionFactory: CoveClientFactory = (baseUrl) =>
  new CoveJsonRpcClient({ baseUrl: baseUrl || COVE_DEFAULT_BASE_URL });

let clientFactory: CoveClientFactory = productionFactory;

/**
 * Test seam. Pass `null` to restore the production factory. Kept out of the
 * `BackupProviderAdapter` interface on purpose: a factory parameter there would
 * be dead weight on every future vendor.
 */
export function __setCoveClientFactoryForTests(factory: CoveClientFactory | null): void {
  clientFactory = factory ?? productionFactory;
}

function parseCredentials(creds: unknown): CoveCredentials {
  const parsed = coveCredentialsSchema.safeParse(creds);
  if (!parsed.success) {
    // `reauth: true` on purpose: a stored blob that no longer satisfies the
    // schema is a credential problem the operator must fix by re-entering it,
    // not something a retry can resolve.
    throw new ProviderRequestError(
      'Cove credentials are incomplete (partner name, username and password are all required)',
      { code: 'invalid_credentials', reauth: true },
    );
  }
  return parsed.data;
}

async function connect(creds: unknown, baseUrl: string): Promise<{
  client: CoveClientLike;
  root: { visa: string; partnerId: string; partnerName: string };
}> {
  const parsed = parseCredentials(creds);
  const client = clientFactory(baseUrl);
  const root = await client.login(parsed);
  return { client, root };
}

export const coveAdapter: BackupProviderAdapter = {
  key: COVE_PROVIDER_KEY,
  label: COVE_PROVIDER_LABEL,
  credentialsSchema: coveCredentialsSchema,

  /**
   * Never throws. The create/PATCH/test routes render this straight into a
   * 200 `{ success: false, error }` body (the PSA `testResult` shape) so the
   * web card can explain the failure; a throw would become an opaque 500.
   */
  async testConnection(creds: unknown, baseUrl: string): Promise<ProviderTestResult> {
    try {
      const { client, root } = await connect(creds, baseUrl);
      const customers = await client.enumeratePartners(root.partnerId);
      return {
        ok: true,
        rootId: root.partnerId,
        rootName: root.partnerName,
        customerCount: customers.length,
      };
    } catch (error) {
      if (error instanceof ProviderRequestError) {
        return { ok: false, error: error.message, reauth: error.reauth };
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Cove connection test failed',
        reauth: false,
      };
    }
  },

  async listCustomers(creds: unknown, baseUrl: string, rootId: string): Promise<VendorCustomer[]> {
    const { client } = await connect(creds, baseUrl);
    return client.enumeratePartners(rootId);
  },

  /**
   * Throws `ProviderRequestError` if ANY page fails — deliberately NOT
   * degraded to a partial list. The sync job deletes rows whose vendor device
   * vanished, so a truncated enumeration reported as success would delete a
   * customer's whole backup inventory.
   */
  async listDevices(creds: unknown, baseUrl: string, rootId: string): Promise<VendorDevice[]> {
    const { client } = await connect(creds, baseUrl);
    return client.enumerateAccountStatisticsAll(rootId);
  },
};
```

- [ ] **Step 4: Run the adapter and registry tests**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx vitest run src/services/backupProviders/cove/adapter.test.ts src/services/backupProviders/registry.test.ts
```
Expected: 2 files, all cases PASS — `registry.test.ts` (written in Task 6) now resolves `./cove/adapter`.

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration
git add apps/api/src/services/backupProviders/cove/adapter.ts \
        apps/api/src/services/backupProviders/cove/adapter.test.ts
git commit -m "$(cat <<'EOF'
feat(integrations): Cove adapter with credential schema and test-connection (#6008 W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `enqueueBackupProviderSync` — the queue half of the sync job

**Files:**
- Create: `apps/api/src/jobs/backupProviderSync.ts`
- Test: `apps/api/src/jobs/backupProviderSync.test.ts`
- Read first: `apps/api/src/jobs/huntressSync.ts:35,45-51,123-150,1010-1029` (queue name, job options, the unique-job pattern, `scheduleHuntressSync`), `apps/api/src/services/bullmqUtils.ts:7-15,43-64` (`isReusableState`, `enqueueOrReplaceStale`), `apps/api/src/services/bullmqQueue.ts:41-75` (`createInstrumentedQueue`)

**Interfaces:**
- Consumes `createInstrumentedQueue` from `../services/bullmqQueue`, `enqueueOrReplaceStale` from `../services/bullmqUtils`, `type JobsOptions` / `type Queue` from `bullmq`.
- Produces `BACKUP_PROVIDER_SYNC_QUEUE = 'backup-provider-sync'`, `BACKUP_PROVIDER_SYNC_JOB_OPTS`, `type BackupProviderSyncJobData`, `getBackupProviderSyncQueue()`, `backupProviderSyncJobId(connectionId)`, `enqueueBackupProviderSync(connectionId): Promise<string>`, `shutdownBackupProviderSyncQueue()`.

> **DECISION (`enqueueOrReplaceStale`, not a private `addUniqueJob`):** the brief points at `huntressSync.ts:127-150`, but that private helper has since been lifted into `services/bullmqUtils.ts` as `enqueueOrReplaceStale` and is used by `enqueueOrgMerge` / `enqueueTenantErasure`. Using the shared helper gets the "a FAILED job record silently swallows every later `add` under the same jobId" fix for free instead of re-implementing it.

> **DECISION (return type):** the plan index types `enqueueBackupProviderSync(connectionId: string): Promise<void>`. It returns the job id instead (`Promise<string>`), because the create and sync-now routes echo it to the UI exactly as the Huntress route does with `syncJobId`. A `Promise<string>` satisfies every `await`-only caller a `Promise<void>` would have.

> **DECISION (`createInstrumentedQueue`, and `runOutsideDbContext` at every call site):** the queue is built with `createInstrumentedQueue` (`services/bullmqQueue.ts:41`), not a bare `new Queue`. That wrapper calls `assertOutsideHeldDbContext('bullmq.add(backup-provider-sync)')` before each enqueue — warn-only in production, **throwing under `DB_CONTEXT_TRIPWIRE_STRICT` in CI**. Consequence for Task 12: `enqueueBackupProviderSync` must never be awaited inside a held `withDbAccessContext`. The sync-now route and the create route therefore wrap it as `runOutsideDbContext(() => enqueueBackupProviderSync(id))` (`db/index.ts:801` exits BOTH ALS stores, so `hasDbAccessContext()` is false inside). `routes/huntress.ts:467` does **not** do this — it predates the instrumented queue and uses a bare `new Queue` — so do not copy that call site.

> **DECISION (file ownership):** W02 adds `initializeBackupProviderSyncJob`, `shutdownBackupProviderSyncJob`, `syncConnectionById` and the `Worker` to **this same file**. W01 ships only the queue handle and the enqueue, so nothing in W01 starts a worker or a repeatable job — enqueued jobs simply wait in Redis until W02 lands. That is deliberate: a route that pretends to sync is worse than one whose job is visibly queued.

- [ ] **Step 1: Write the failing test**

`apps/api/src/jobs/backupProviderSync.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queueState } = vi.hoisted(() => ({
  queueState: {
    getJob: vi.fn(async (_id: string) => null as null | { id: string; getState: () => Promise<string>; remove: () => Promise<void> }),
    add: vi.fn(async (_name: string, _data: unknown, opts: { jobId: string }) => ({ id: opts.jobId })),
    close: vi.fn(async () => {}),
  },
}));

vi.mock('../services/bullmqQueue', () => ({
  createInstrumentedQueue: vi.fn(() => queueState),
}));

import { createInstrumentedQueue } from '../services/bullmqQueue';
import {
  BACKUP_PROVIDER_SYNC_QUEUE,
  backupProviderSyncJobId,
  enqueueBackupProviderSync,
  getBackupProviderSyncQueue,
  shutdownBackupProviderSyncQueue,
} from './backupProviderSync';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';

describe('backup provider sync queue', () => {
  beforeEach(async () => {
    await shutdownBackupProviderSyncQueue();
    vi.clearAllMocks();
    queueState.getJob.mockResolvedValue(null);
  });

  it('uses the contracted queue name, through the instrumented factory', () => {
    // createInstrumentedQueue, not `new Queue`: it is what carries the #1105
    // assertOutsideHeldDbContext tripwire onto every enqueue.
    getBackupProviderSyncQueue();
    expect(createInstrumentedQueue).toHaveBeenCalledWith('backup-provider-sync');
    expect(BACKUP_PROVIDER_SYNC_QUEUE).toBe('backup-provider-sync');
  });

  it('reuses one Queue instance across calls', () => {
    getBackupProviderSyncQueue();
    getBackupProviderSyncQueue();
    expect(createInstrumentedQueue).toHaveBeenCalledTimes(1);
  });

  it('builds the contracted per-connection job id', () => {
    expect(backupProviderSyncJobId(CONNECTION_ID)).toBe(`backup-provider-sync-${CONNECTION_ID}`);
  });

  it('enqueues sync-connection under that job id, with retries', async () => {
    const id = await enqueueBackupProviderSync(CONNECTION_ID);
    expect(id).toBe(`backup-provider-sync-${CONNECTION_ID}`);
    expect(queueState.add).toHaveBeenCalledWith(
      'sync-connection',
      { type: 'sync-connection', connectionId: CONNECTION_ID },
      expect.objectContaining({
        jobId: `backup-provider-sync-${CONNECTION_ID}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      }),
    );
  });

  it('COALESCES with an in-flight job instead of queueing a second one', async () => {
    // "Sync now" while a scheduled sync is already running must not start a
    // second enumeration of the same connection — the sync holds a per-
    // connection advisory lock in W02 and the second would just block a worker.
    queueState.getJob.mockResolvedValue({
      id: `backup-provider-sync-${CONNECTION_ID}`,
      getState: async () => 'active',
      remove: vi.fn(async () => {}),
    });
    const id = await enqueueBackupProviderSync(CONNECTION_ID);
    expect(id).toBe(`backup-provider-sync-${CONNECTION_ID}`);
    expect(queueState.add).not.toHaveBeenCalled();
  });

  it('REPLACES a spent (failed) job record so "Sync now" is never a silent no-op', async () => {
    // BullMQ's jobId dedup keys on "a record with this id exists", and
    // removeOnFail keeps the last failures around — so a bare add() after a
    // failed sync is silently discarded and the operator's retry does nothing.
    const remove = vi.fn(async () => {});
    queueState.getJob.mockResolvedValue({
      id: `backup-provider-sync-${CONNECTION_ID}`,
      getState: async () => 'failed',
      remove,
    });
    await enqueueBackupProviderSync(CONNECTION_ID);
    expect(remove).toHaveBeenCalled();
    expect(queueState.add).toHaveBeenCalled();
  });

  it('rejects a blank connection id rather than queueing an unrunnable job', async () => {
    await expect(enqueueBackupProviderSync('')).rejects.toThrow(/connection id/i);
    expect(queueState.add).not.toHaveBeenCalled();
  });

  it('closes and forgets the queue on shutdown', async () => {
    getBackupProviderSyncQueue();
    await shutdownBackupProviderSyncQueue();
    expect(queueState.close).toHaveBeenCalled();
    getBackupProviderSyncQueue();
    expect(createInstrumentedQueue).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx vitest run src/jobs/backupProviderSync.test.ts
```
Expected: `Failed to load url ./backupProviderSync`.

- [ ] **Step 3: Write `apps/api/src/jobs/backupProviderSync.ts`**

```ts
import type { JobsOptions, Queue } from 'bullmq';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { enqueueOrReplaceStale } from '../services/bullmqUtils';

/**
 * External backup provider sync (#6008).
 *
 * W01 ships ONLY the queue handle and the enqueue helper — the connection
 * create route and "Sync now" both call `enqueueBackupProviderSync`, and the
 * job waits in Redis until W02 adds the worker, the repeatable `sync-all`
 * ticker and `syncConnectionById` to this same file. Shipping a route that
 * claims to sync with nothing behind it would be worse than a visibly queued
 * job.
 */
export const BACKUP_PROVIDER_SYNC_QUEUE = 'backup-provider-sync';

export interface SyncAllJobData { type: 'sync-all' }
export interface SyncConnectionJobData { type: 'sync-connection'; connectionId: string }
export type BackupProviderSyncJobData = SyncAllJobData | SyncConnectionJobData;

/**
 * Three attempts with exponential backoff, matching huntressSync: a
 * per-connection sync is one enumeration plus one idempotent upsert
 * transaction, so a transient managed-Postgres connection drop or a vendor 503
 * is worth retrying. W02's `reauth` failures throw `UnrecoverableError`, which
 * BullMQ does not retry regardless of this setting.
 */
export const BACKUP_PROVIDER_SYNC_JOB_OPTS: Omit<JobsOptions, 'jobId'> = {
  removeOnComplete: { count: 50 },
  removeOnFail: { count: 200 },
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
};

let queue: Queue<BackupProviderSyncJobData> | null = null;

/**
 * `createInstrumentedQueue`, not a bare `new Queue`: it wraps `add`/`addBulk`
 * in `assertOutsideHeldDbContext`, which throws in CI when an enqueue happens
 * inside a held request transaction (#1105). Every call site of
 * `enqueueBackupProviderSync` therefore runs it under `runOutsideDbContext`.
 */
export function getBackupProviderSyncQueue(): Queue<BackupProviderSyncJobData> {
  if (!queue) {
    queue = createInstrumentedQueue<BackupProviderSyncJobData>(BACKUP_PROVIDER_SYNC_QUEUE);
  }
  return queue;
}

/** The ONE job id for a connection, so a scheduled sync and "Sync now" coalesce. */
export function backupProviderSyncJobId(connectionId: string): string {
  return `backup-provider-sync-${connectionId}`;
}

/**
 * Queue a sync for one connection, returning the job id.
 *
 * Goes through `enqueueOrReplaceStale` rather than a bare `queue.add`: BullMQ's
 * jobId dedup keys on "a record with this id EXISTS", and `removeOnFail`
 * deliberately keeps recent failures around — so after a failed sync every
 * later `add` under the same id is silently discarded and the operator's "Sync
 * now" does nothing, forever. The helper reuses a genuinely in-flight job
 * (active/waiting/delayed/prioritized) and replaces a spent record.
 */
export async function enqueueBackupProviderSync(connectionId: string): Promise<string> {
  if (!connectionId) {
    throw new Error('enqueueBackupProviderSync requires a connection id');
  }
  const { id } = await enqueueOrReplaceStale(
    getBackupProviderSyncQueue(),
    'sync-connection',
    backupProviderSyncJobId(connectionId),
    { type: 'sync-connection', connectionId } satisfies SyncConnectionJobData,
    BACKUP_PROVIDER_SYNC_JOB_OPTS,
    '[BackupProviderSync]',
  );
  return id;
}

/** Close the queue connection (tests, and W02's `shutdownBackupProviderSyncJob`). */
export async function shutdownBackupProviderSyncQueue(): Promise<void> {
  if (!queue) return;
  await queue.close();
  queue = null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx vitest run src/jobs/backupProviderSync.test.ts
```
Expected: 1 file, all cases PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration
git add apps/api/src/jobs/backupProviderSync.ts apps/api/src/jobs/backupProviderSync.test.ts
git commit -m "$(cat <<'EOF'
feat(integrations): backup-provider-sync queue and enqueue helper (#6008 W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Provider alert resolution + the atomic customer remap

**Files:**
- Create: `apps/api/src/services/backupProviders/alertsResolve.ts`
- Test: `apps/api/src/services/backupProviders/alertsResolve.test.ts`
- Create: `apps/api/src/services/backupProviders/mapping.ts`
- Test: `apps/api/src/services/backupProviders/mapping.test.ts`
- Read first: `apps/api/src/services/alertService.ts:513` (`RESOLVABLE_ALERT_STATUSES`), `:699-703` (`resolveAlert(alertId, resolutionNote?, resolvedBy?): Promise<boolean>`), `apps/api/src/jobs/monitorWorker.ts:452-476` (the `context->>'source'` dedupe/resolve query shape to copy)

**Interfaces:**
- Consumes `db`, `runOutsideDbContext` from `../../db`; `alerts`, `backupProviderCustomers`, `backupProviderDevices`, `organizations` from `../../db/schema`; `RESOLVABLE_ALERT_STATUSES`, `resolveAlert` from `../alertService`; `enqueueBackupProviderSync` from `../../jobs/backupProviderSync`.
- Produces from `alertsResolve.ts`: `BACKUP_PROVIDER_ALERT_SOURCE = 'backup_provider'`, `BACKUP_PROVIDER_ALERT_PUBLISHER = 'backup-provider-sync'`, `resolveProviderAlertsForConnection(connectionId, note?): Promise<number>`, `resolveProviderAlertsForCustomer(customerId, note?): Promise<number>`, `resolveProviderAlertsForProviderDevices(providerDeviceIds, note?): Promise<number>`.
- Produces from `mapping.ts`: `RemapCustomerActor`, `RemapCustomerResult`, `RemapCustomerError`, `remapCustomer(customerId, orgId, actor): Promise<RemapCustomerResult>`.

> **DECISION (`remapCustomer` return type):** the plan index types it `Promise<void>`. It returns `RemapCustomerResult` (`{ customerId, connectionId, orgId, mappingSource, deletedDevices, deletedHistory, resolvedAlerts, syncJobId }`) instead, because the route echoes the new mapping state and the "N device rows removed" count into the UI and the audit row. A richer return is source-compatible with every `await`-only caller a `Promise<void>` would have had.

> **DECISION (alert resolution runs BEFORE the inventory transaction, not inside it):** the spec describes the remap as "one transaction: resolve alerts, delete device and ledger rows, update the mapping, enqueue a sync". `resolveAlert` publishes `alert.resolved` on the event bus — webhooks and automations act on it — so running it inside a transaction that can still roll back would announce a resolution that did not happen. The order here is: (1) resolve alerts, (2) one transaction deleting rows and updating the mapping, (3) `runOutsideDbContext(() => enqueueBackupProviderSync(...))` after commit. If step 2 rolls back, the alerts are resolved early and W02's two-poll hysteresis re-raises them within one sync — strictly better than a false `alert.resolved` reaching a customer's webhook. The user-visible guarantee the spec actually asks for — "nothing stays visible to the old org until the next poll" — is what step 2's transaction provides.

> **DECISION (the enqueue is outside every DB context):** see Task 10. `enqueueBackupProviderSync` is instrumented with `assertOutsideHeldDbContext`, so `remapCustomer` calls it through `runOutsideDbContext` after the transaction commits.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/backupProviders/alertsResolve.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { dbState, resolveAlertMock } = vi.hoisted(() => ({
  dbState: { rows: [] as Array<{ id: string }>, capturedWhere: [] as unknown[] },
  resolveAlertMock: vi.fn(async (_id: string, _note?: string) => true),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async (cond: unknown) => {
          dbState.capturedWhere.push(cond);
          return dbState.rows;
        }),
        innerJoin: vi.fn(() => ({
          where: vi.fn(async (cond: unknown) => {
            dbState.capturedWhere.push(cond);
            return dbState.rows;
          }),
        })),
      })),
    })),
  },
}));

vi.mock('../../db/schema', () => ({
  alerts: { id: 'alerts.id', status: 'alerts.status', context: 'alerts.context' },
  backupProviderDevices: { id: 'bpd.id', customerId: 'bpd.customer_id' },
}));

vi.mock('../alertService', () => ({
  RESOLVABLE_ALERT_STATUSES: ['active', 'acknowledged', 'suppressed'],
  resolveAlert: resolveAlertMock,
}));

import {
  BACKUP_PROVIDER_ALERT_SOURCE,
  resolveProviderAlertsForConnection,
  resolveProviderAlertsForProviderDevices,
} from './alertsResolve';

describe('resolveProviderAlertsForConnection', () => {
  beforeEach(() => {
    dbState.rows = [];
    dbState.capturedWhere = [];
    resolveAlertMock.mockReset().mockResolvedValue(true);
  });

  it('uses the contracted source discriminator', () => {
    expect(BACKUP_PROVIDER_ALERT_SOURCE).toBe('backup_provider');
  });

  it('resolves every open provider alert for the connection, with a stated note', async () => {
    dbState.rows = [{ id: 'a1' }, { id: 'a2' }];
    const resolved = await resolveProviderAlertsForConnection('conn-1');
    expect(resolved).toBe(2);
    expect(resolveAlertMock).toHaveBeenCalledTimes(2);
    const [, note] = resolveAlertMock.mock.calls[0]!;
    // A resolution note that says WHY is what stops the next technician
    // re-opening it: the row is gone, not fixed.
    expect(String(note)).toMatch(/backup provider connection/i);
  });

  it('counts only the alerts whose compare-and-swap it actually won', async () => {
    // resolveAlert returns false when another writer got there first; counting
    // it would over-report in the audit row.
    dbState.rows = [{ id: 'a1' }, { id: 'a2' }];
    resolveAlertMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(resolveProviderAlertsForConnection('conn-1')).resolves.toBe(1);
  });

  it('is a no-op when nothing is open', async () => {
    dbState.rows = [];
    await expect(resolveProviderAlertsForConnection('conn-1')).resolves.toBe(0);
    expect(resolveAlertMock).not.toHaveBeenCalled();
  });

  it('short-circuits an empty provider-device list without touching the database', async () => {
    await expect(resolveProviderAlertsForProviderDevices([])).resolves.toBe(0);
    expect(dbState.capturedWhere).toHaveLength(0);
  });

  it('keeps going when one resolve throws, so one bad alert cannot block a connection delete', async () => {
    dbState.rows = [{ id: 'a1' }, { id: 'a2' }];
    resolveAlertMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(true);
    await expect(resolveProviderAlertsForConnection('conn-1')).resolves.toBe(1);
  });
});
```

`apps/api/src/services/backupProviders/mapping.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    customer: null as null | Record<string, unknown>,
    org: null as null | { id: string; partnerId: string },
    deletedDevices: 0,
    deletedHistory: 0,
    statements: [] as string[],
    outsideContext: [] as string[],
  },
}));

vi.mock('../../db', () => ({
  db: {
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(txStub())),
    select: vi.fn(() => selectStub()),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => {
    state.outsideContext.push('enter');
    return fn();
  }),
}));

function selectStub() {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn(async () => (state.org ? [state.org] : [])) })),
    })),
  };
}

function txStub() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          for: vi.fn(() => ({ limit: vi.fn(async () => (state.customer ? [state.customer] : [])) })),
          limit: vi.fn(async () => (state.customer ? [state.customer] : [])),
        })),
      })),
    })),
    delete: vi.fn((table: unknown) => {
      state.statements.push(`DELETE ${String(table)}`);
      return { where: vi.fn(async () => ({ count: 1 })) };
    }),
    update: vi.fn((table: unknown) => {
      state.statements.push(`UPDATE ${String(table)}`);
      return {
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 'cust-1', orgId: state.org?.id ?? null }]) })),
        })),
      };
    }),
    execute: vi.fn(async (q: unknown) => {
      state.statements.push(String(q));
      return [];
    }),
  };
}

vi.mock('../../db/schema', () => ({
  backupProviderCustomers: { id: 'backup_provider_customers', orgId: 'org_id', partnerId: 'partner_id' },
  backupProviderDevices: { id: 'backup_provider_devices', customerId: 'customer_id' },
  backupProviderDeviceHistory: { providerDeviceId: 'backup_provider_device_history' },
  organizations: { id: 'organizations', partnerId: 'partner_id' },
}));

const resolveForCustomer = vi.fn(async () => 2);
vi.mock('./alertsResolve', () => ({
  resolveProviderAlertsForCustomer: resolveForCustomer,
  BACKUP_PROVIDER_ALERT_SOURCE: 'backup_provider',
}));

const enqueue = vi.fn(async () => 'job-1');
vi.mock('../../jobs/backupProviderSync', () => ({ enqueueBackupProviderSync: enqueue }));

import { remapCustomer, RemapCustomerError } from './mapping';

const ACTOR = { userId: 'user-1', partnerId: 'partner-1' };

describe('remapCustomer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.customer = { id: 'cust-1', connectionId: 'conn-1', partnerId: 'partner-1', orgId: null, mappingSource: null };
    state.org = { id: 'org-1', partnerId: 'partner-1' };
    state.statements = [];
    state.outsideContext = [];
    resolveForCustomer.mockResolvedValue(2);
    enqueue.mockResolvedValue('job-1');
  });

  it('maps an unmapped customer, stamping mapping_source = manual', async () => {
    const result = await remapCustomer('cust-1', 'org-1', ACTOR);
    expect(result).toMatchObject({
      customerId: 'cust-1',
      connectionId: 'conn-1',
      orgId: 'org-1',
      mappingSource: 'manual',
      resolvedAlerts: 2,
      syncJobId: 'job-1',
    });
  });

  it('stamps manual_unmapped when the target org is null', async () => {
    const result = await remapCustomer('cust-1', null, ACTOR);
    expect(result.mappingSource).toBe('manual_unmapped');
    expect(result.orgId).toBeNull();
  });

  it('resolves the customer alerts BEFORE deleting its rows', async () => {
    await remapCustomer('cust-1', 'org-1', ACTOR);
    // resolveAlert publishes on the event bus; doing it inside a transaction
    // that can roll back would announce a resolution that did not happen.
    expect(resolveForCustomer).toHaveBeenCalledWith('cust-1', expect.stringMatching(/remap/i));
    expect(resolveForCustomer.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(enqueue).mock.invocationCallOrder[0]!);
  });

  it('deletes the ledger before the device rows', async () => {
    await remapCustomer('cust-1', 'org-1', ACTOR);
    const history = state.statements.findIndex((s) => s.includes('backup_provider_device_history'));
    const devices = state.statements.findIndex((s) => s.includes('backup_provider_devices'));
    expect(history).toBeGreaterThanOrEqual(0);
    expect(history).toBeLessThan(devices);
  });

  it('enqueues a sync AFTER the transaction, outside any DB context', async () => {
    await remapCustomer('cust-1', 'org-1', ACTOR);
    expect(enqueue).toHaveBeenCalledWith('conn-1');
    // The instrumented queue throws in CI if an enqueue happens inside a held
    // withDbAccessContext.
    expect(state.outsideContext).toContain('enter');
  });

  it('refuses a customer belonging to another partner', async () => {
    state.customer = { ...state.customer!, partnerId: 'partner-2' };
    await expect(remapCustomer('cust-1', 'org-1', ACTOR))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a target org belonging to another partner, before writing anything', async () => {
    state.org = { id: 'org-1', partnerId: 'partner-2' };
    await expect(remapCustomer('cust-1', 'org-1', ACTOR))
      .rejects.toMatchObject({ code: 'ORG_NOT_IN_PARTNER' });
    expect(state.statements).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('refuses a target org that does not exist', async () => {
    state.org = null;
    await expect(remapCustomer('cust-1', 'org-1', ACTOR))
      .rejects.toMatchObject({ code: 'ORG_NOT_IN_PARTNER' });
  });

  it('refuses an unknown customer', async () => {
    state.customer = null;
    await expect(remapCustomer('cust-1', 'org-1', ACTOR))
      .rejects.toBeInstanceOf(RemapCustomerError);
  });

  it('does not fail the remap when the post-commit enqueue fails', async () => {
    // The mapping HAS changed and the rows ARE gone; a Redis hiccup must not
    // make the operator think the remap was rejected. The next scheduled sync
    // picks it up.
    enqueue.mockRejectedValue(new Error('redis down'));
    const result = await remapCustomer('cust-1', 'org-1', ACTOR);
    expect(result.syncJobId).toBeNull();
  });
});
```

- [ ] **Step 2: Run both to verify they fail**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx vitest run src/services/backupProviders/alertsResolve.test.ts src/services/backupProviders/mapping.test.ts
```
Expected: two `Failed to load url` errors.

- [ ] **Step 3: Write `alertsResolve.ts`**

```ts
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import { alerts, backupProviderDevices } from '../../db/schema';
import { RESOLVABLE_ALERT_STATUSES, resolveAlert } from '../alertService';

/**
 * The `alerts.context.source` discriminator every backup-provider alert
 * carries. W02's evaluator writes it; this module is the only thing that
 * closes them outside the sync.
 */
export const BACKUP_PROVIDER_ALERT_SOURCE = 'backup_provider';

/** The `publisher` label on the event-bus side (W02). Declared here so both waves agree. */
export const BACKUP_PROVIDER_ALERT_PUBLISHER = 'backup-provider-sync';

/**
 * Close a set of alerts, one compare-and-swap at a time.
 *
 * `resolveAlert` returns false when it LOSES the CAS (someone else already
 * resolved or dismissed the row); those are not counted, so the number the
 * route puts in its audit entry is the number of transitions this call actually
 * made.
 *
 * A throw on one alert is logged and skipped rather than propagated: these
 * calls stand between an operator and a connection delete or a customer remap,
 * and one wedged alert must not block either.
 */
async function resolveEach(alertIds: string[], note: string): Promise<number> {
  let resolved = 0;
  for (const alertId of alertIds) {
    try {
      if (await resolveAlert(alertId, note)) resolved += 1;
    } catch (error) {
      console.error(
        `[backupProvider] failed to resolve alert ${alertId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return resolved;
}

/** Open provider alerts (`active | acknowledged | suppressed`) matching a jsonb context predicate. */
async function openProviderAlertIds(extra: ReturnType<typeof sql>): Promise<string[]> {
  const rows = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(
      inArray(alerts.status, [...RESOLVABLE_ALERT_STATUSES]),
      sql`${alerts.context}->>'source' = ${BACKUP_PROVIDER_ALERT_SOURCE}`,
      extra,
    ));
  return rows.map((row) => row.id);
}

/**
 * Every open alert raised for any device under `connectionId`.
 *
 * Called by `DELETE /backup/providers/connections/:id` BEFORE the delete: the
 * rows the alerts describe are about to cascade away, and an alert pointing at
 * a deleted provider device can never auto-resolve — it would sit in the alert
 * center forever with a device name nobody can find.
 */
export async function resolveProviderAlertsForConnection(
  connectionId: string,
  note = 'Backup provider connection removed from Breeze',
): Promise<number> {
  const ids = await openProviderAlertIds(sql`${alerts.context}->>'connectionId' = ${connectionId}`);
  return resolveEach(ids, note);
}

/** Every open alert raised for one of the given provider device rows. */
export async function resolveProviderAlertsForProviderDevices(
  providerDeviceIds: string[],
  note = 'Backup provider device row removed',
): Promise<number> {
  if (providerDeviceIds.length === 0) return 0;
  const ids = await openProviderAlertIds(
    sql`${alerts.context}->>'providerDeviceId' = ANY(${providerDeviceIds})`,
  );
  return resolveEach(ids, note);
}

/**
 * Every open alert raised for a device under one vendor customer. Used by the
 * atomic remap, whose whole point is that nothing about the old org survives
 * the mapping change.
 */
export async function resolveProviderAlertsForCustomer(
  customerId: string,
  note = 'Backup provider customer remapped to a different organization',
): Promise<number> {
  const rows = await db
    .select({ id: backupProviderDevices.id })
    .from(backupProviderDevices)
    .where(eq(backupProviderDevices.customerId, customerId));
  return resolveProviderAlertsForProviderDevices(rows.map((row) => row.id), note);
}
```

- [ ] **Step 4: Write `mapping.ts`**

```ts
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, runOutsideDbContext } from '../../db';
import {
  backupProviderCustomers,
  backupProviderDeviceHistory,
  backupProviderDevices,
  organizations,
} from '../../db/schema';
import { enqueueBackupProviderSync } from '../../jobs/backupProviderSync';
import { resolveProviderAlertsForCustomer } from './alertsResolve';

export interface RemapCustomerActor {
  userId: string | null;
  partnerId: string;
}

export interface RemapCustomerResult {
  customerId: string;
  connectionId: string;
  orgId: string | null;
  mappingSource: 'manual' | 'manual_unmapped';
  deletedDevices: number;
  deletedHistory: number;
  resolvedAlerts: number;
  /** Null when the post-commit enqueue failed; the next scheduled sync still picks it up. */
  syncJobId: string | null;
}

export type RemapCustomerErrorCode = 'NOT_FOUND' | 'ORG_NOT_IN_PARTNER';

export class RemapCustomerError extends Error {
  readonly code: RemapCustomerErrorCode;
  constructor(code: RemapCustomerErrorCode, message: string) {
    super(message);
    this.name = 'RemapCustomerError';
    this.code = code;
  }
}

/**
 * Map, re-map or un-map one vendor customer — atomically, so nothing about the
 * OLD organization outlives the change.
 *
 * Order, and why:
 *   1. Resolve the customer's open provider alerts. OUTSIDE the transaction on
 *      purpose: `resolveAlert` publishes `alert.resolved` on the event bus, and
 *      announcing a resolution from inside a transaction that can still roll
 *      back would have webhooks and automations act on something that did not
 *      happen. If the transaction does roll back, W02's two-poll hysteresis
 *      re-raises the condition on the next sync.
 *   2. ONE transaction: delete the ledger rows, then the device rows, then
 *      update `org_id` / `mapping_source`. This is the guarantee that matters —
 *      nothing stays visible to the old org for even a moment.
 *   3. Enqueue a sync AFTER the commit and OUTSIDE any DB context, so the rows
 *      reappear under the new org within seconds. The queue is instrumented
 *      with `assertOutsideHeldDbContext`, which throws in CI if this runs
 *      inside a held transaction.
 *
 * `manual` and `manual_unmapped` are both terminal for auto-mapping: W02's
 * `autoMapCustomers` only ever touches rows whose `mapping_source IS NULL`, so
 * an operator's decision to leave a customer unmapped is never silently undone.
 */
export async function remapCustomer(
  customerId: string,
  orgId: string | null,
  actor: RemapCustomerActor,
): Promise<RemapCustomerResult> {
  // Validate the target org BEFORE anything is written or resolved. The
  // composite FK (org_id, partner_id) -> organizations(id, partner_id) would
  // also refuse a foreign org, but as a 23503 inside the request transaction —
  // which poisons it, so the friendly 422 would become a 500 at COMMIT.
  if (orgId !== null) {
    const [org] = await db
      .select({ id: organizations.id, partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org || org.partnerId !== actor.partnerId) {
      throw new RemapCustomerError(
        'ORG_NOT_IN_PARTNER',
        'The target organization does not belong to this partner',
      );
    }
  }

  const resolvedAlerts = await resolveProviderAlertsForCustomer(
    customerId,
    'Resolved by a backup provider customer remap',
  );

  const mappingSource: 'manual' | 'manual_unmapped' = orgId === null ? 'manual_unmapped' : 'manual';

  const outcome = await db.transaction(async (tx) => {
    const [customer] = await tx
      .select({
        id: backupProviderCustomers.id,
        connectionId: backupProviderCustomers.connectionId,
        partnerId: backupProviderCustomers.partnerId,
      })
      .from(backupProviderCustomers)
      .where(eq(backupProviderCustomers.id, customerId))
      .for('update')
      .limit(1);

    // RLS already hides another partner's row, so this is normally
    // belt-and-braces — but a system-context caller (a future admin tool) sees
    // every row, and this check is what stops one partner's mapping being
    // rewritten through such a path.
    if (!customer || customer.partnerId !== actor.partnerId) {
      throw new RemapCustomerError('NOT_FOUND', 'Backup provider customer not found');
    }

    const deviceRows = await tx
      .select({ id: backupProviderDevices.id })
      .from(backupProviderDevices)
      .where(eq(backupProviderDevices.customerId, customerId));
    const deviceIds = deviceRows.map((row) => row.id);

    // Ledger before devices. The FK is ON DELETE CASCADE, so Postgres would do
    // it either way — but doing it explicitly keeps the deleted-row counts
    // honest for the audit entry, and keeps the statement order legible when
    // the cascade contract is next reviewed.
    let deletedHistory = 0;
    if (deviceIds.length > 0) {
      const historyResult = await tx
        .delete(backupProviderDeviceHistory)
        .where(inArray(backupProviderDeviceHistory.providerDeviceId, deviceIds))
        .returning({ id: backupProviderDeviceHistory.id });
      deletedHistory = historyResult.length;
    }

    const deletedDeviceRows = deviceIds.length === 0 ? [] : await tx
      .delete(backupProviderDevices)
      .where(eq(backupProviderDevices.customerId, customerId))
      .returning({ id: backupProviderDevices.id });

    const [updated] = await tx
      .update(backupProviderCustomers)
      .set({ orgId, mappingSource, deviceCount: 0, updatedAt: new Date() })
      .where(eq(backupProviderCustomers.id, customerId))
      .returning({
        id: backupProviderCustomers.id,
        orgId: backupProviderCustomers.orgId,
      });
    if (!updated) {
      throw new RemapCustomerError('NOT_FOUND', 'Backup provider customer not found');
    }

    return {
      connectionId: customer.connectionId,
      deletedDevices: deletedDeviceRows.length,
      deletedHistory,
    };
  });

  // After COMMIT, outside every DB context (#1105 / the instrumented queue's
  // tripwire). A failure here is NOT a failure of the remap: the mapping has
  // changed and the rows are gone, and the scheduled sync will refill them.
  let syncJobId: string | null = null;
  try {
    syncJobId = await runOutsideDbContext(() => enqueueBackupProviderSync(outcome.connectionId));
  } catch (error) {
    console.error(
      `[backupProvider] remap of customer ${customerId} committed, but the follow-up sync could not be queued:`,
      error instanceof Error ? error.message : error,
    );
  }

  return {
    customerId,
    connectionId: outcome.connectionId,
    orgId,
    mappingSource,
    deletedDevices: outcome.deletedDevices,
    deletedHistory: outcome.deletedHistory,
    resolvedAlerts,
    syncJobId,
  };
}
```

- [ ] **Step 5: Run both tests to verify they pass**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx vitest run src/services/backupProviders/alertsResolve.test.ts src/services/backupProviders/mapping.test.ts
```
Expected: 2 files, all cases PASS. The mocked `tx` stub in `mapping.test.ts` must expose `.returning()` on both `delete` chains — if a case fails with `returning is not a function`, extend the stub rather than dropping the `.returning()` from the implementation: the counts are what the audit row reports.

- [ ] **Step 6: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration
git add apps/api/src/services/backupProviders/alertsResolve.ts \
        apps/api/src/services/backupProviders/alertsResolve.test.ts \
        apps/api/src/services/backupProviders/mapping.ts \
        apps/api/src/services/backupProviders/mapping.test.ts
git commit -m "$(cat <<'EOF'
feat(integrations): provider alert resolution and the atomic customer remap (#6008 W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Connection routes + the hub + the self-managed-DB-context registration

**Files:**
- Create: `apps/api/src/routes/backup/providerAccess.ts`
- Create: `apps/api/src/routes/backup/providers.ts`
- Test: `apps/api/src/routes/backup/providers.test.ts`
- Modify: `apps/api/src/routes/backup/index.ts` (append a `backupRoutes.route('/', backupProviderRoutes);` line after `backupRoutes.route('/vault', vaultRoutes);` at `:49`)
- Modify: `apps/api/src/middleware/selfManagedDbContextRoutes.ts` (append three entries after the `tool-sources` entry at `:255`, before the closing `];` at `:256`)
- Modify: `apps/api/src/middleware/selfManagedDbContextRoutes.test.ts` (add to `MATCH` and `NO_MATCH`)
- Read first: `apps/api/src/routes/huntress.ts:99-108,354-490` (the partner gate and the credential-write shape), `apps/api/src/routes/psa.ts:858-960` (the self-managed test route and its `testResult` body), `apps/api/src/routes/backup/index.ts` (mount order, the existing `requireScope` at `:31`), `apps/api/src/routes/huntress.test.ts:1-160` (mock patterns)

**Interfaces:**
- Consumes `authMiddleware` is already applied by `backup/index.ts:30`; `requireScope`, `requirePermission`, `requireMfa`, `withAuthDbAccessContext`, `type AuthContext` from `../../middleware/auth`; `PERMISSIONS` from `../../services/permissions`; `canManagePartnerWidePolicies`, `PARTNER_WIDE_WRITE_DENIED_MESSAGE` from `../../services/partnerWideAccess`; `getBackupProvider`, `BACKUP_PROVIDER_KEYS` from `../../services/backupProviders/registry`; `encryptProviderCredentials`, `decryptProviderCredentials` from `../../services/backupProviders/credentials`; `resolveProviderAlertsForConnection` from `../../services/backupProviders/alertsResolve`; `enqueueBackupProviderSync` from `../../jobs/backupProviderSync`; `writeRouteAudit` from `../../services/auditEvents`; `db`, `runOutsideDbContext` from `../../db`.
- Produces `backupProviderRoutes` (the hub), and from `providerAccess.ts`: `type ProviderRouteAuth`, `resolveProviderPartnerId`, `requireProviderPartnerAdmin`, `CONNECTION_PUBLIC_SELECT`, `type ConnectionPublicRow`, `assertHttpsBaseUrl`.

> **DECISION (permission gates):** reads use `PERMISSIONS.BACKUP_READ` (`backup:read`, the spec's own wording). Writes use `PERMISSIONS.ORGS_WRITE` + `requireMfa()` + `canManagePartnerWidePolicies(auth)` — the exact gate `routes/huntress.ts:354-358` puts on its integration upsert and `:610-614` on its org mapping, which the spec names as the reference ("same permission as Huntress connection writes"). There is no `backup:manage_providers` permission and inventing one would need a seeded permission row, a migration and a role grant for zero added safety: these are partner-level vendor credentials, which is what `organizations:write` + full partner org access already gates everywhere else. `PUT /devices/:id/link` is the one exception — see Task 13.

> **DECISION (route-file split):** the plan index names `apps/api/src/routes/backup/providers.ts` for all eight routes. That file is the **hub**: it declares the five connection routes and mounts `providerCustomers.ts` and `providerDevices.ts` under the same `/providers` prefix, so the index's path contract and mount point are unchanged while no file approaches 500 lines (`routes/backup/` is already 24,817 lines across 57 files). Shared gating and serialization live in `providerAccess.ts`.

> **DECISION (create refuses with 422, `/test` answers 200):** `POST /connections` whose `testConnection` fails returns **HTTP 422** with `{ success: false, error, reauth }` — nothing was created, so a 2xx would be a lie, and `runAction` treats a non-2xx as a failure already. `POST /connections/:id/test` returns **HTTP 200** with `{ success: false, error }` (the PSA shape, `routes/psa.ts:950-956`) because the test operation itself succeeded; `runAction` treats an HTTP-200 `{success:false}` body as a failure too, so the web card shows an error either way.

> **DECISION (three routes are self-managed):** `POST /connections`, `PATCH /connections/:id` and `POST /connections/:id/test` each make a real Cove HTTP call (login + `EnumeratePartners`, against an operator-supplied host, 30 s timeout). Held inside the auth middleware's request transaction that pins a pooled connection idle-in-transaction for the whole round trip — the #1105 pool-poison class — and `safeFetch`'s own `assertOutsideHeldDbContext` throws in CI when it happens. They are registered in `SELF_MANAGED_DB_CONTEXT_ROUTES` and each opens its own short `withAuthDbAccessContext` blocks around the network call. `POST /connections/:id/sync` and `DELETE /connections/:id` make no outbound call and keep the ambient transaction.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/routes/backup/providers.test.ts` (mirrors `huntress.test.ts`'s hoisted-state mock shape):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authState, gates, adapterState, dbState } = vi.hoisted(() => ({
  authState: {
    scope: 'partner' as 'organization' | 'partner' | 'system',
    orgId: null as string | null,
    partnerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as string | null,
    partnerOrgAccess: 'all' as 'all' | 'selected' | 'none' | null,
    accessibleOrgIds: [] as string[],
  },
  gates: { permission: false, mfa: false },
  adapterState: {
    test: { ok: true, rootId: '1000', rootName: 'OliveTech', customerCount: 3 } as Record<string, unknown>,
  },
  dbState: {
    connections: [] as Array<Record<string, unknown>>,
    inserted: [] as Array<Record<string, unknown>>,
    updated: [] as Array<Record<string, unknown>>,
    deleted: 0,
    executed: [] as string[],
  },
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((..._a: unknown[]) => {
          const rows = dbState.connections;
          const chain = { limit: vi.fn(async () => rows), orderBy: vi.fn(async () => rows) };
          return Object.assign(Promise.resolve(rows), chain);
        }),
        orderBy: vi.fn(async () => dbState.connections),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        dbState.inserted.push(v);
        return { returning: vi.fn(async () => [{ ...v }]) };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: Record<string, unknown>) => {
        dbState.updated.push(v);
        return { where: vi.fn(() => ({ returning: vi.fn(async () => [{ id: CONNECTION_ID, ...v }]) })) };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => { dbState.deleted += 1; return []; }),
    })),
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({
      update: vi.fn(() => ({
        set: vi.fn((v: Record<string, unknown>) => {
          dbState.updated.push(v);
          return { where: vi.fn(() => ({ returning: vi.fn(async () => [{ id: CONNECTION_ID, ...v }]) })) };
        }),
      })),
      execute: vi.fn(async (q: unknown) => { dbState.executed.push(String(q)); return []; }),
      delete: vi.fn(() => ({ where: vi.fn(async () => { dbState.deleted += 1; return []; }) })),
    })),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../../db/schema', () => ({
  backupProviderConnections: {
    id: 'id', partnerId: 'partner_id', provider: 'provider', name: 'name', baseUrl: 'base_url',
    credentialsEncrypted: 'credentials_encrypted', vendorRootId: 'vendor_root_id',
    vendorRootName: 'vendor_root_name', isActive: 'is_active', status: 'status',
    syncIntervalMinutes: 'sync_interval_minutes', showProviderNameInPortal: 'show_provider_name_in_portal',
    lastSyncAt: 'last_sync_at', lastSyncStatus: 'last_sync_status', lastSyncError: 'last_sync_error',
    lastSyncCustomers: 'last_sync_customers', lastSyncUnmappedCustomers: 'last_sync_unmapped_customers',
    lastSyncDevices: 'last_sync_devices', lastSyncUnmappedDevices: 'last_sync_unmapped_devices',
    lastSyncLinkedDevices: 'last_sync_linked_devices', lastSyncAmbiguousDevices: 'last_sync_ambiguous_devices',
    createdBy: 'created_by', createdAt: 'created_at', updatedAt: 'updated_at',
  },
  backupProviderCustomers: { id: 'id', connectionId: 'connection_id', partnerId: 'partner_id', orgId: 'org_id' },
  backupProviderDevices: { id: 'id', connectionId: 'connection_id', orgId: 'org_id', portalShowProviderName: 'portal_show_provider_name' },
  organizations: { id: 'id', name: 'name', partnerId: 'partner_id' },
  devices: { id: 'id', orgId: 'org_id', hostname: 'hostname', displayName: 'display_name', siteId: 'site_id', status: 'status' },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: authState.scope,
      orgId: authState.orgId,
      partnerId: authState.partnerId,
      partnerOrgAccess: authState.partnerOrgAccess,
      accessibleOrgIds: authState.accessibleOrgIds,
      canAccessOrg: (orgId: string) => authState.accessibleOrgIds.includes(orgId),
      orgCondition: vi.fn(() => undefined),
      user: { id: '99999999-9999-4999-8999-999999999999', email: 'tech@example.com' },
      token: { mfa: true },
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (gates.permission) return c.json({ error: 'Forbidden' }, 403);
    c.set('permissions', undefined);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) =>
    gates.mfa ? c.json({ error: 'MFA required' }, 403) : next()),
  withAuthDbAccessContext: vi.fn(async (_auth: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    BACKUP_READ: { resource: 'backup', action: 'read' },
    BACKUP_WRITE: { resource: 'backup', action: 'write' },
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
  },
  canAccessSite: () => true,
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

vi.mock('../../services/backupProviders/registry', () => ({
  BACKUP_PROVIDER_KEYS: ['cove'],
  getBackupProvider: vi.fn((key: string) => {
    if (key !== 'cove') throw new Error(`Unknown backup provider "${key}" (registered: cove)`);
    return {
      key: 'cove',
      label: 'Cove Data Protection',
      credentialsSchema: {
        safeParse: (v: unknown) => {
          const ok = !!v && typeof v === 'object'
            && typeof (v as any).partnerName === 'string'
            && typeof (v as any).username === 'string'
            && typeof (v as any).password === 'string';
          return ok ? { success: true, data: v } : { success: false, error: { message: 'bad creds' } };
        },
      },
      testConnection: vi.fn(async () => adapterState.test),
      listCustomers: vi.fn(async () => []),
      listDevices: vi.fn(async () => []),
    };
  }),
}));

const encryptMock = vi.fn((id: string) => `enc:${id}`);
vi.mock('../../services/backupProviders/credentials', () => ({
  encryptProviderCredentials: (id: string, creds: unknown) => encryptMock(id, creds as never),
  decryptProviderCredentials: vi.fn(() => ({ partnerName: 'p', username: 'u', password: 'x' })),
}));

const resolveAlertsMock = vi.fn(async () => 3);
vi.mock('../../services/backupProviders/alertsResolve', () => ({
  resolveProviderAlertsForConnection: resolveAlertsMock,
  BACKUP_PROVIDER_ALERT_SOURCE: 'backup_provider',
}));

const enqueueMock = vi.fn(async () => 'job-1');
vi.mock('../../jobs/backupProviderSync', () => ({ enqueueBackupProviderSync: enqueueMock }));

vi.mock('../../services/backupProviders/mapping', () => ({
  remapCustomer: vi.fn(async () => ({
    customerId: 'c1', connectionId: 'conn-1', orgId: null, mappingSource: 'manual_unmapped',
    deletedDevices: 0, deletedHistory: 0, resolvedAlerts: 0, syncJobId: 'job-1',
  })),
  RemapCustomerError: class RemapCustomerError extends Error { code = 'NOT_FOUND'; },
}));

import { backupProviderRoutes } from './providers';

const CONNECTION_ID = '33333333-3333-4333-8333-333333333333';
const PARTNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CREDS = { partnerName: 'OliveTech', username: 'api@olivetech.example', password: 'sup3r-s3cret' };

function connectionRow(over: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID, partnerId: PARTNER_ID, provider: 'cove', name: 'OliveTech Cove',
    baseUrl: 'https://api.backup.management/jsonapi', credentialsEncrypted: 'enc:x',
    vendorRootId: '1000', vendorRootName: 'OliveTech', isActive: true, status: 'connected',
    syncIntervalMinutes: 30, showProviderNameInPortal: false, lastSyncAt: null,
    lastSyncStatus: null, lastSyncError: null, createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
}

describe('backup provider connection routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    gates.permission = false;
    gates.mfa = false;
    authState.scope = 'partner';
    authState.orgId = null;
    authState.partnerId = PARTNER_ID;
    authState.partnerOrgAccess = 'all';
    authState.accessibleOrgIds = [];
    adapterState.test = { ok: true, rootId: '1000', rootName: 'OliveTech', customerCount: 3 };
    dbState.connections = [];
    dbState.inserted = [];
    dbState.updated = [];
    dbState.deleted = 0;
    dbState.executed = [];
    enqueueMock.mockResolvedValue('job-1');
    resolveAlertsMock.mockResolvedValue(3);
    app = new Hono();
    app.route('/backup', backupProviderRoutes);
  });

  describe('GET /backup/providers/connections', () => {
    it('lists the partner connections and NEVER returns the ciphertext', async () => {
      dbState.connections = [connectionRow()];
      const res = await app.request('/backup/providers/connections');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({ id: CONNECTION_ID, provider: 'cove', hasCredentials: true });
      expect(JSON.stringify(body)).not.toContain('credentialsEncrypted');
      expect(JSON.stringify(body)).not.toContain('enc:');
    });

    it('refuses an org-scoped caller', async () => {
      authState.scope = 'organization';
      authState.orgId = '11111111-1111-4111-8111-111111111111';
      const res = await app.request('/backup/providers/connections');
      expect(res.status).toBe(403);
    });

    it('refuses a partner caller with restricted org access', async () => {
      authState.partnerOrgAccess = 'selected';
      const res = await app.request('/backup/providers/connections');
      expect(res.status).toBe(403);
    });
  });

  describe('POST /backup/providers/connections', () => {
    const body = { provider: 'cove', name: 'OliveTech Cove', credentials: CREDS };

    it('tests the connection, stores the ciphertext under the PRE-GENERATED row id, and enqueues a sync', async () => {
      const res = await app.request('/backup/providers/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(res.status).toBe(201);
      const created = dbState.inserted[0]!;
      // Row-bound AAD: the id must exist BEFORE the encryption, not be defaulted
      // by the database afterwards.
      expect(typeof created.id).toBe('string');
      expect(encryptMock).toHaveBeenCalledWith(created.id, CREDS);
      expect(created.credentialsEncrypted).toBe(`enc:${created.id}`);
      expect(created.vendorRootId).toBe('1000');
      expect(created.status).toBe('connected');
      expect(enqueueMock).toHaveBeenCalledWith(created.id);
      const payload = await res.json();
      expect(payload.data.hasCredentials).toBe(true);
      expect(JSON.stringify(payload)).not.toContain(CREDS.password);
    });

    it('refuses with 422 and does NOT store anything when the vendor test fails', async () => {
      adapterState.test = { ok: false, error: 'Cove login was rejected', reauth: true };
      const res = await app.request('/backup/providers/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ success: false, reauth: true });
      expect(dbState.inserted).toHaveLength(0);
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('rejects an unknown provider with 400 before any vendor call', async () => {
      const res = await app.request('/backup/providers/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, provider: 'veeam' }),
      });
      expect(res.status).toBe(400);
      expect(dbState.inserted).toHaveLength(0);
    });

    it('rejects a credential blob the adapter schema refuses', async () => {
      const res = await app.request('/backup/providers/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, credentials: { username: 'u' } }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects a non-HTTPS baseUrl override', async () => {
      const res = await app.request('/backup/providers/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, baseUrl: 'http://api.backup.management/jsonapi' }),
      });
      expect(res.status).toBe(400);
    });

    it('is gated on the write permission and on MFA', async () => {
      gates.permission = true;
      let res = await app.request('/backup/providers/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);

      gates.permission = false;
      gates.mfa = true;
      res = await app.request('/backup/providers/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
    });

    it('refuses a partner caller with restricted org access', async () => {
      authState.partnerOrgAccess = 'selected';
      const res = await app.request('/backup/providers/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
      expect(dbState.inserted).toHaveLength(0);
    });

    it('still creates the connection when the initial sync cannot be queued', async () => {
      enqueueMock.mockRejectedValue(new Error('redis down'));
      const res = await app.request('/backup/providers/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(res.status).toBe(201);
      expect((await res.json()).syncWarning).toBeTruthy();
    });
  });

  describe('PATCH /backup/providers/connections/:id', () => {
    beforeEach(() => { dbState.connections = [connectionRow()]; });

    it('renames without touching the credential or calling the vendor', async () => {
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });
      expect(res.status).toBe(200);
      expect(dbState.updated[0]).toMatchObject({ name: 'Renamed' });
      expect(dbState.updated[0]!.credentialsEncrypted).toBeUndefined();
      expect(encryptMock).not.toHaveBeenCalled();
    });

    it('re-tests and re-seals new credentials under the EXISTING row id, resetting status', async () => {
      dbState.connections = [connectionRow({ status: 'reauth_required', lastSyncError: 'dead' })];
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credentials: CREDS }),
      });
      expect(res.status).toBe(200);
      expect(encryptMock).toHaveBeenCalledWith(CONNECTION_ID, CREDS);
      expect(dbState.updated[0]).toMatchObject({
        credentialsEncrypted: `enc:${CONNECTION_ID}`,
        status: 'connected',
        lastSyncError: null,
      });
    });

    it('refuses with 422 when the new credentials fail the vendor test, leaving the old ones in place', async () => {
      adapterState.test = { ok: false, error: 'rejected', reauth: true };
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credentials: CREDS }),
      });
      expect(res.status).toBe(422);
      expect(dbState.updated).toHaveLength(0);
    });

    it('rewrites the denormalized portal flag on the device rows IN THE SAME transaction', async () => {
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ showProviderNameInPortal: true }),
      });
      expect(res.status).toBe(200);
      // The portal reads the label off backup_provider_devices (it cannot read
      // the partner-axis connection table at all), so a flag left un-mirrored
      // silently keeps showing the generic label — or the vendor name after the
      // MSP turned it off.
      const mirrored = dbState.executed.join(' ');
      expect(mirrored).toContain('backup_provider_devices');
      expect(mirrored).toContain('portal_show_provider_name');
    });

    it('does not rewrite the device rows when the flag is not part of the patch', async () => {
      await app.request(`/backup/providers/connections/${CONNECTION_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });
      expect(dbState.executed).toHaveLength(0);
    });

    it('404s for a connection outside the caller partner', async () => {
      dbState.connections = [];
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });
      expect(res.status).toBe(404);
    });

    it('rejects an empty patch rather than writing an empty UPDATE', async () => {
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /backup/providers/connections/:id/test', () => {
    beforeEach(() => { dbState.connections = [connectionRow()]; });

    it('returns the PSA testResult shape on success', async () => {
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}/test`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        success: true, rootName: 'OliveTech', customerCount: 3,
      });
    });

    it('answers HTTP 200 with success:false on a vendor failure, and persists reauth_required', async () => {
      adapterState.test = { ok: false, error: 'Cove login was rejected', reauth: true };
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}/test`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: false, error: expect.stringContaining('rejected') });
      expect(dbState.updated[0]).toMatchObject({ status: 'reauth_required' });
    });

    it('does NOT flip the connection to reauth_required on a transient failure', async () => {
      adapterState.test = { ok: false, error: 'HTTP 503', reauth: false };
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}/test`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(dbState.updated[0]?.status).not.toBe('reauth_required');
    });
  });

  describe('POST /backup/providers/connections/:id/sync', () => {
    beforeEach(() => { dbState.connections = [connectionRow()]; });

    it('enqueues outside the ambient DB context and echoes the job id', async () => {
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}/sync`, { method: 'POST' });
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ syncJobId: 'job-1' });
      expect(enqueueMock).toHaveBeenCalledWith(CONNECTION_ID);
      const { runOutsideDbContext } = await import('../../db');
      expect(runOutsideDbContext).toHaveBeenCalled();
    });

    it('refuses to sync an inactive connection', async () => {
      dbState.connections = [connectionRow({ isActive: false })];
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}/sync`, { method: 'POST' });
      expect(res.status).toBe(409);
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('DOES allow a reauth_required connection to be retried after a credential PATCH', async () => {
      // "Sync now" is the only way a reauth_required connection is retried, and
      // the credential PATCH is what resets its status — so the route must not
      // refuse on status alone.
      dbState.connections = [connectionRow({ status: 'reauth_required' })];
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}/sync`, { method: 'POST' });
      expect(res.status).toBe(202);
    });
  });

  describe('DELETE /backup/providers/connections/:id', () => {
    beforeEach(() => { dbState.connections = [connectionRow()]; });

    it('resolves the open provider alerts BEFORE deleting', async () => {
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(resolveAlertsMock).toHaveBeenCalledWith(CONNECTION_ID);
      expect(resolveAlertsMock.mock.invocationCallOrder[0]!).toBeLessThan(
        vi.mocked((await import('../../db')).db.delete).mock.invocationCallOrder[0]!,
      );
      expect(dbState.deleted).toBe(1);
    });

    it('404s for a connection outside the caller partner and deletes nothing', async () => {
      dbState.connections = [];
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}`, { method: 'DELETE' });
      expect(res.status).toBe(404);
      expect(dbState.deleted).toBe(0);
      expect(resolveAlertsMock).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx vitest run src/routes/backup/providers.test.ts
```
Expected: `Failed to load url ./providers`.

- [ ] **Step 3: Write `providerAccess.ts`**

```ts
import { sql } from 'drizzle-orm';
import type { AuthContext } from '../../middleware/auth';
import { backupProviderConnections } from '../../db/schema';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../../services/partnerWideAccess';

/** Just enough of `AuthContext` for the provider routes, so tests can build one by hand. */
export type ProviderRouteAuth = Pick<
  AuthContext,
  'scope' | 'partnerId' | 'partnerOrgAccess' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'
>;

export type GateFailure = { error: string; status: 400 | 403 };

/**
 * READ gate for the partner-level surfaces (connections, customer mappings).
 *
 * An org-scoped token is refused outright rather than filtered: these rows are
 * the MSP's own vendor credentials and its customer directory, and an org user
 * has no business knowing which other customers exist. RLS enforces the same
 * thing one layer down — `breeze_has_partner_access` is false for an org
 * token — so this gate produces an honest 403 instead of an empty list.
 */
export function resolveProviderPartnerId(auth: ProviderRouteAuth): { partnerId: string } | GateFailure {
  if (auth.scope === 'organization') {
    return { error: 'Backup provider connections are managed at partner scope', status: 403 };
  }
  if (!auth.partnerId) {
    return { error: 'Partner context required', status: 403 };
  }
  return { partnerId: auth.partnerId };
}

/**
 * WRITE gate. Adds `canManagePartnerWidePolicies` — a partner user with
 * `org_access = 'selected'` may see the connection card but must not rotate the
 * credential or re-map a customer, because both take effect for EVERY org under
 * the partner including ones that user cannot see. Same gate as
 * `routes/huntress.ts`'s integration upsert and org mapping.
 */
export function requireProviderPartnerAdmin(auth: ProviderRouteAuth): { partnerId: string } | GateFailure {
  const read = resolveProviderPartnerId(auth);
  if ('error' in read) return read;
  if (!canManagePartnerWidePolicies(auth)) {
    return { error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, status: 403 };
  }
  return read;
}

export function isGateFailure(value: unknown): value is GateFailure {
  return !!value && typeof value === 'object' && 'error' in (value as Record<string, unknown>);
}

/**
 * The ONLY column set any route selects from `backup_provider_connections`.
 *
 * `credentials_encrypted` is deliberately absent and replaced by a computed
 * `hasCredentials`: a route cannot leak a ciphertext it never loaded, and the
 * UI only ever needs to know whether one is present. This is the mechanical
 * half of "the password is never returned by any route".
 */
export const CONNECTION_PUBLIC_SELECT = {
  id: backupProviderConnections.id,
  partnerId: backupProviderConnections.partnerId,
  provider: backupProviderConnections.provider,
  name: backupProviderConnections.name,
  baseUrl: backupProviderConnections.baseUrl,
  vendorRootId: backupProviderConnections.vendorRootId,
  vendorRootName: backupProviderConnections.vendorRootName,
  isActive: backupProviderConnections.isActive,
  status: backupProviderConnections.status,
  syncIntervalMinutes: backupProviderConnections.syncIntervalMinutes,
  showProviderNameInPortal: backupProviderConnections.showProviderNameInPortal,
  lastSyncAt: backupProviderConnections.lastSyncAt,
  lastSyncStatus: backupProviderConnections.lastSyncStatus,
  lastSyncError: backupProviderConnections.lastSyncError,
  lastSyncCustomers: backupProviderConnections.lastSyncCustomers,
  lastSyncUnmappedCustomers: backupProviderConnections.lastSyncUnmappedCustomers,
  lastSyncDevices: backupProviderConnections.lastSyncDevices,
  lastSyncUnmappedDevices: backupProviderConnections.lastSyncUnmappedDevices,
  lastSyncLinkedDevices: backupProviderConnections.lastSyncLinkedDevices,
  lastSyncAmbiguousDevices: backupProviderConnections.lastSyncAmbiguousDevices,
  createdAt: backupProviderConnections.createdAt,
  updatedAt: backupProviderConnections.updatedAt,
  hasCredentials: sql<boolean>`(${backupProviderConnections.credentialsEncrypted} IS NOT NULL AND ${backupProviderConnections.credentialsEncrypted} <> '')`,
} as const;

export type ConnectionPublicRow = {
  [K in keyof typeof CONNECTION_PUBLIC_SELECT]: unknown;
};

/**
 * The default endpoint is pinned; an override must be HTTPS (spec, Security).
 * The database CHECK `backup_provider_connections_base_url_chk` is the
 * structural backstop — this is the friendly 400.
 */
export function assertHttpsBaseUrl(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:') return 'baseUrl must use https://';
    return null;
  } catch {
    return 'baseUrl must be a valid URL';
  }
}
```

- [ ] **Step 4: Write `providers.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { db, runOutsideDbContext } from '../../db';
import { backupProviderConnections, backupProviderDevices } from '../../db/schema';
import {
  requireMfa,
  requirePermission,
  requireScope,
  withAuthDbAccessContext,
} from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { captureException } from '../../services/sentry';
import { BACKUP_PROVIDER_KEYS, getBackupProvider } from '../../services/backupProviders/registry';
import { encryptProviderCredentials, decryptProviderCredentials } from '../../services/backupProviders/credentials';
import { resolveProviderAlertsForConnection } from '../../services/backupProviders/alertsResolve';
import { enqueueBackupProviderSync } from '../../jobs/backupProviderSync';
import {
  assertHttpsBaseUrl,
  CONNECTION_PUBLIC_SELECT,
  isGateFailure,
  requireProviderPartnerAdmin,
  resolveProviderPartnerId,
} from './providerAccess';
import { backupProviderCustomerRoutes } from './providerCustomers';
import { backupProviderDeviceRoutes } from './providerDevices';

const connectionRoutes = new Hono();

const idParamSchema = z.object({ id: z.string().guid() });

const createConnectionSchema = z.object({
  provider: z.string().min(1).max(30),
  name: z.string().trim().min(1).max(200),
  baseUrl: z.string().url().max(300).optional(),
  /** Shape is owned by the adapter's own schema, validated after the registry lookup. */
  credentials: z.record(z.string(), z.unknown()),
  showProviderNameInPortal: z.boolean().optional(),
  syncIntervalMinutes: z.number().int().min(5).max(1440).optional(),
});

const patchConnectionSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
  syncIntervalMinutes: z.number().int().min(5).max(1440).optional(),
  showProviderNameInPortal: z.boolean().optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be supplied' });

/** One connection the caller's partner owns, without the ciphertext. */
async function loadConnection(id: string, partnerId: string) {
  const [row] = await db
    .select(CONNECTION_PUBLIC_SELECT)
    .from(backupProviderConnections)
    .where(and(eq(backupProviderConnections.id, id), eq(backupProviderConnections.partnerId, partnerId)))
    .limit(1);
  return row ?? null;
}

/** The ciphertext, loaded ONLY where a vendor call needs it. */
async function loadCredentials(id: string, partnerId: string) {
  const [row] = await db
    .select({
      id: backupProviderConnections.id,
      provider: backupProviderConnections.provider,
      baseUrl: backupProviderConnections.baseUrl,
      credentialsEncrypted: backupProviderConnections.credentialsEncrypted,
    })
    .from(backupProviderConnections)
    .where(and(eq(backupProviderConnections.id, id), eq(backupProviderConnections.partnerId, partnerId)))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// GET /backup/providers/connections
// ---------------------------------------------------------------------------
connectionRoutes.get(
  '/connections',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  async (c) => {
    const gate = resolveProviderPartnerId(c.get('auth'));
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    const rows = await db
      .select(CONNECTION_PUBLIC_SELECT)
      .from(backupProviderConnections)
      .where(eq(backupProviderConnections.partnerId, gate.partnerId))
      .orderBy(backupProviderConnections.name);

    return c.json({ data: rows, providers: [...BACKUP_PROVIDER_KEYS] });
  },
);

// ---------------------------------------------------------------------------
// POST /backup/providers/connections
//
// Registered in SELF_MANAGED_DB_CONTEXT_ROUTES: `testConnection` is a real
// Cove round-trip against an operator-supplied host, and holding the request
// transaction across it pins a pooled connection idle-in-transaction (#1105).
// Every DB touch below therefore opens its own short context.
// ---------------------------------------------------------------------------
connectionRoutes.post(
  '/connections',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', createConnectionSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const gate = requireProviderPartnerAdmin(auth);
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    let adapter;
    try {
      adapter = getBackupProvider(body.provider);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Unknown backup provider' }, 400);
    }

    const creds = adapter.credentialsSchema.safeParse(body.credentials);
    if (!creds.success) {
      return c.json({ error: `Invalid ${adapter.label} credentials` }, 400);
    }

    const baseUrl = body.baseUrl ?? 'https://api.backup.management/jsonapi';
    const urlError = assertHttpsBaseUrl(baseUrl);
    if (urlError) return c.json({ error: urlError }, 400);

    // The row id is generated HERE, not defaulted by the database: the
    // credential blob is sealed with an AAD bound to it (aadBinding: 'row'), so
    // the id has to exist before the encryption.
    const connectionId = randomUUID();

    // Outside any DB context — this route holds none.
    const test = await adapter.testConnection(creds.data, baseUrl);
    if (!test.ok) {
      // 422, not a 200 `{success:false}`: nothing was created, so a 2xx would
      // be a lie. runAction surfaces a non-2xx as a failure already.
      return c.json({ success: false, error: test.error, reauth: test.reauth }, 422);
    }

    const created = await withAuthDbAccessContext(auth, async () => {
      const [row] = await db
        .insert(backupProviderConnections)
        .values({
          id: connectionId,
          partnerId: gate.partnerId,
          provider: adapter.key,
          name: body.name,
          baseUrl,
          credentialsEncrypted: encryptProviderCredentials(connectionId, creds.data),
          vendorRootId: test.rootId,
          vendorRootName: test.rootName,
          isActive: true,
          status: 'connected',
          syncIntervalMinutes: body.syncIntervalMinutes ?? 30,
          showProviderNameInPortal: body.showProviderNameInPortal ?? false,
          createdBy: auth.user?.id ?? null,
        })
        .returning({ id: backupProviderConnections.id });
      if (!row) return null;
      return loadConnection(row.id, gate.partnerId);
    });

    if (!created) {
      return c.json({ error: 'Failed to store the backup provider connection' }, 500);
    }

    // After the write, outside every DB context: the queue is instrumented with
    // assertOutsideHeldDbContext, which throws in CI otherwise.
    let syncJobId: string | null = null;
    let syncWarning: string | null = null;
    try {
      syncJobId = await runOutsideDbContext(() => enqueueBackupProviderSync(connectionId));
    } catch (error) {
      console.error('[backupProvider] failed to queue the first sync:', error);
      captureException(error instanceof Error ? error : new Error(String(error)));
      syncWarning = 'Initial sync could not be queued. Data will sync on the next scheduled cycle.';
    }

    writeRouteAudit(c, {
      orgId: null,
      action: 'backup_provider.connection.create',
      resourceType: 'backup_provider_connection',
      resourceId: connectionId,
      resourceName: body.name,
      details: { provider: adapter.key, partnerId: gate.partnerId, customerCount: test.customerCount },
    });

    return c.json({
      data: created,
      customerCount: test.customerCount,
      syncJobId,
      ...(syncWarning ? { syncWarning } : {}),
    }, 201);
  },
);

// ---------------------------------------------------------------------------
// PATCH /backup/providers/connections/:id  (also self-managed — may re-test)
// ---------------------------------------------------------------------------
connectionRoutes.patch(
  '/connections/:id',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', patchConnectionSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const gate = requireProviderPartnerAdmin(auth);
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    const existing = await withAuthDbAccessContext(auth, () => loadCredentials(id, gate.partnerId));
    if (!existing) return c.json({ error: 'Backup provider connection not found' }, 404);

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.isActive !== undefined) updates.isActive = body.isActive;
    if (body.syncIntervalMinutes !== undefined) updates.syncIntervalMinutes = body.syncIntervalMinutes;
    if (body.showProviderNameInPortal !== undefined) {
      updates.showProviderNameInPortal = body.showProviderNameInPortal;
    }

    if (body.credentials !== undefined) {
      let adapter;
      try {
        adapter = getBackupProvider(existing.provider);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Unknown backup provider' }, 400);
      }
      const creds = adapter.credentialsSchema.safeParse(body.credentials);
      if (!creds.success) return c.json({ error: `Invalid ${adapter.label} credentials` }, 400);

      const test = await adapter.testConnection(creds.data, existing.baseUrl);
      if (!test.ok) {
        // The stored credential is untouched — a failed rotation must never
        // leave the connection with no working credential at all.
        return c.json({ success: false, error: test.error, reauth: test.reauth }, 422);
      }
      // Re-sealed under the EXISTING row id: the AAD is bound to it.
      updates.credentialsEncrypted = encryptProviderCredentials(existing.id, creds.data);
      updates.vendorRootId = test.rootId;
      updates.vendorRootName = test.rootName;
      // A successful credential rotation is the ONLY thing that clears
      // reauth_required — the sync worker will not retry such a connection
      // until it does.
      updates.status = 'connected';
      updates.lastSyncError = null;
    }

    const updated = await withAuthDbAccessContext(auth, () => db.transaction(async (tx) => {
      const [row] = await tx
        .update(backupProviderConnections)
        .set(updates)
        .where(and(
          eq(backupProviderConnections.id, id),
          eq(backupProviderConnections.partnerId, gate.partnerId),
        ))
        .returning({ id: backupProviderConnections.id });
      if (!row) return null;

      // The portal reads its label off the DENORMALIZED column on the device
      // rows (an org token cannot read the partner-axis connection table at
      // all), so the flag has to be mirrored in the SAME transaction — a
      // half-applied toggle would keep showing the vendor name to a customer
      // after the MSP turned it off.
      if (body.showProviderNameInPortal !== undefined) {
        await tx.execute(sql`
          UPDATE backup_provider_devices
          SET portal_show_provider_name = ${body.showProviderNameInPortal}, updated_at = now()
          WHERE connection_id = ${id}::uuid
        `);
      }
      return loadConnection(id, gate.partnerId);
    }));

    if (!updated) return c.json({ error: 'Backup provider connection not found' }, 404);

    writeRouteAudit(c, {
      orgId: null,
      action: 'backup_provider.connection.update',
      resourceType: 'backup_provider_connection',
      resourceId: id,
      details: {
        partnerId: gate.partnerId,
        fields: Object.keys(body),
        credentialsRotated: body.credentials !== undefined,
      },
    });

    return c.json({ data: updated });
  },
);

// ---------------------------------------------------------------------------
// DELETE /backup/providers/connections/:id  (no outbound call — ambient tx)
// ---------------------------------------------------------------------------
connectionRoutes.delete(
  '/connections/:id',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const gate = requireProviderPartnerAdmin(auth);
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    const existing = await loadConnection(id, gate.partnerId);
    if (!existing) return c.json({ error: 'Backup provider connection not found' }, 404);

    // BEFORE the delete: the customers, devices and ledger rows cascade away,
    // and an alert pointing at a deleted provider device can never auto-resolve
    // — it would sit in the alert center forever naming a device nobody can
    // find.
    const resolvedAlerts = await resolveProviderAlertsForConnection(id);

    await db
      .delete(backupProviderConnections)
      .where(and(
        eq(backupProviderConnections.id, id),
        eq(backupProviderConnections.partnerId, gate.partnerId),
      ));

    writeRouteAudit(c, {
      orgId: null,
      action: 'backup_provider.connection.delete',
      resourceType: 'backup_provider_connection',
      resourceId: id,
      resourceName: String(existing.name ?? ''),
      details: { partnerId: gate.partnerId, resolvedAlerts },
    });

    return c.json({ success: true, resolvedAlerts });
  },
);

// ---------------------------------------------------------------------------
// POST /backup/providers/connections/:id/test  (self-managed)
// ---------------------------------------------------------------------------
connectionRoutes.post(
  '/connections/:id/test',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const gate = requireProviderPartnerAdmin(auth);
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    const existing = await withAuthDbAccessContext(auth, () => loadCredentials(id, gate.partnerId));
    if (!existing) return c.json({ error: 'Backup provider connection not found' }, 404);

    let adapter;
    try {
      adapter = getBackupProvider(existing.provider);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Unknown backup provider' }, 400);
    }

    let creds: unknown;
    try {
      creds = decryptProviderCredentials(existing.id, existing.credentialsEncrypted);
    } catch {
      // Never echo the decryption failure detail — it can describe key state.
      return c.json({ success: false, error: 'Stored credentials could not be read' }, 200);
    }

    const result = await adapter.testConnection(creds, existing.baseUrl);

    // Persist the outcome best-effort in a second short context. Only a REAUTH
    // failure changes `status`: a 503 must not disable a healthy connection.
    await withAuthDbAccessContext(auth, async () => {
      await db
        .update(backupProviderConnections)
        .set(result.ok
          ? { status: 'connected', vendorRootId: result.rootId, vendorRootName: result.rootName, lastSyncError: null, updatedAt: new Date() }
          : result.reauth
            ? { status: 'reauth_required', lastSyncError: result.error.slice(0, 2000), updatedAt: new Date() }
            : { lastSyncError: result.error.slice(0, 2000), updatedAt: new Date() })
        .where(and(
          eq(backupProviderConnections.id, id),
          eq(backupProviderConnections.partnerId, gate.partnerId),
        ));
    }).catch((error) => {
      console.error('[backupProvider] failed to persist a connection test outcome:', error);
    });

    writeRouteAudit(c, {
      orgId: null,
      action: 'backup_provider.connection.test',
      resourceType: 'backup_provider_connection',
      resourceId: id,
      details: { partnerId: gate.partnerId, success: result.ok },
      result: result.ok ? 'success' : 'failure',
    });

    // PSA `testResult` shape: HTTP 200 either way, `success:false` in the body.
    // runAction treats an HTTP-200 {success:false} as a failure.
    if (!result.ok) {
      return c.json({ success: false, error: result.error, reauth: result.reauth });
    }
    return c.json({
      success: true,
      message: `Connected to ${result.rootName}`,
      rootName: result.rootName,
      customerCount: result.customerCount,
    });
  },
);

// ---------------------------------------------------------------------------
// POST /backup/providers/connections/:id/sync  (no outbound call — ambient tx)
// ---------------------------------------------------------------------------
connectionRoutes.post(
  '/connections/:id/sync',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const gate = requireProviderPartnerAdmin(c.get('auth'));
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    const existing = await loadConnection(id, gate.partnerId);
    if (!existing) return c.json({ error: 'Backup provider connection not found' }, 404);
    if (existing.isActive === false) {
      return c.json({ error: 'This connection is disabled. Re-enable it before syncing.' }, 409);
    }
    // A `reauth_required` connection is DELIBERATELY allowed here: "Sync now"
    // is the only way such a connection is retried, after a credential PATCH
    // reset its status.

    let syncJobId: string;
    try {
      // Outside the ambient request transaction — see the instrumented queue.
      syncJobId = await runOutsideDbContext(() => enqueueBackupProviderSync(id));
    } catch (error) {
      console.error('[backupProvider] failed to queue a manual sync:', error);
      captureException(error instanceof Error ? error : new Error(String(error)));
      return c.json({ success: false, error: 'Could not queue the sync. Try again shortly.' }, 503);
    }

    writeRouteAudit(c, {
      orgId: null,
      action: 'backup_provider.connection.sync',
      resourceType: 'backup_provider_connection',
      resourceId: id,
      details: { partnerId: gate.partnerId, syncJobId },
    });

    return c.json({ success: true, syncJobId }, 202);
  },
);

/**
 * The `/backup/providers/*` hub. Mounted once by `routes/backup/index.ts`;
 * `authMiddleware` and the outer `requireScope` are already applied there.
 */
export const backupProviderRoutes = new Hono();
backupProviderRoutes.route('/providers', connectionRoutes);
backupProviderRoutes.route('/providers', backupProviderCustomerRoutes);
backupProviderRoutes.route('/providers', backupProviderDeviceRoutes);
```

- [ ] **Step 5: Mount the hub**

In `apps/api/src/routes/backup/index.ts`, add the import beside the others and the mount after `backupRoutes.route('/vault', vaultRoutes);`:

```ts
import { backupProviderRoutes } from './providers';
```
```ts
backupRoutes.route('/vault', vaultRoutes);
// #6008 W01 — /backup/providers/*. Mounted at '/' because the sub-router
// carries its own '/providers' prefix, like configsRoutes and dashboardRoutes.
backupRoutes.route('/', backupProviderRoutes);
```

- [ ] **Step 6: Register the three self-managed routes**

In `apps/api/src/middleware/selfManagedDbContextRoutes.ts`, before the closing `];`:

```ts
  // #6008 W01 — the three backup-provider routes that make a REAL Cove
  // JSON-RPC call inside the handler (Login + EnumeratePartners, 30s timeout,
  // against an OPERATOR-SUPPLIED host). Held inside the request transaction
  // that pins a pooled connection idle-in-transaction for the whole round trip
  // (#1105), and `safeFetch`'s own `assertOutsideHeldDbContext` tripwire throws
  // in CI when it happens. Each handler wraps its reads and writes in short
  // `withAuthDbAccessContext` blocks with the network call between them.
  //
  // `/connections/:id/sync` and DELETE `/connections/:id` are deliberately
  // ABSENT: neither makes an outbound call (sync only enqueues), so both keep
  // the ambient transaction — the same call as `push-bulk` above.
  { method: 'POST', pattern: /^\/api\/v1\/backup\/providers\/connections\/?$/ },
  { method: 'PATCH', pattern: /^\/api\/v1\/backup\/providers\/connections\/[^/]+\/?$/ },
  { method: 'POST', pattern: /^\/api\/v1\/backup\/providers\/connections\/[^/]+\/test\/?$/ },
```

In `apps/api/src/middleware/selfManagedDbContextRoutes.test.ts`, add to `MATCH`:

```ts
    // #6008 W01 — the three backup-provider routes that call Cove inside the handler.
    ['POST', '/api/v1/backup/providers/connections'],
    ['POST', '/api/v1/backup/providers/connections/'],
    ['PATCH', '/api/v1/backup/providers/connections/conn-1'],
    ['PATCH', '/api/v1/backup/providers/connections/conn-1/'],
    ['POST', '/api/v1/backup/providers/connections/conn-1/test'],
    ['POST', '/api/v1/backup/providers/connections/conn-1/test/'],
    ['post', '/api/v1/backup/providers/connections/conn-1/test'], // method is case-insensitive
```

and to `NO_MATCH`:

```ts
    // The provider routes that do only DB work MUST keep the ambient tx —
    // losing it would put their writes on the bare pool with no RLS GUC, where
    // forced RLS silently affects 0 rows (#1375).
    ['GET', '/api/v1/backup/providers/connections', 'listing is DB-only'],
    ['POST', '/api/v1/backup/providers/connections/conn-1/sync', 'sync only enqueues'],
    ['DELETE', '/api/v1/backup/providers/connections/conn-1', 'delete makes no outbound call'],
    ['PUT', '/api/v1/backup/providers/customers/cust-1/mapping', 'remap is DB-only'],
    ['PUT', '/api/v1/backup/providers/devices/dev-1/link', 'manual link is DB-only'],
    ['POST', '/api/v1/backup/providers/connections//test', 'empty connection id must not match'],
    ['POST', '/api/v1/backup/providers/connections/conn-1/test/extra', 'extra segment must not match'],
    ['GET', '/api/v1/backup/providers/connections/conn-1/test', 'test is POST-only'],
```

- [ ] **Step 7: Run the route and middleware tests**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx vitest run src/routes/backup/providers.test.ts src/middleware/selfManagedDbContextRoutes.test.ts
```
Expected: 2 files, all cases PASS. `providers.test.ts` will not resolve `./providerCustomers` / `./providerDevices` until Task 13 — run Task 13 first if you are executing strictly in order, or stub the two imports temporarily and delete the stubs in Task 13 (prefer doing Task 13 first).

- [ ] **Step 8: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration
git add apps/api/src/routes/backup/providerAccess.ts \
        apps/api/src/routes/backup/providers.ts \
        apps/api/src/routes/backup/providers.test.ts \
        apps/api/src/routes/backup/index.ts \
        apps/api/src/middleware/selfManagedDbContextRoutes.ts \
        apps/api/src/middleware/selfManagedDbContextRoutes.test.ts
git commit -m "$(cat <<'EOF'
feat(integrations): backup provider connection routes, hub and self-managed DB context (#6008 W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Customer-mapping and device-link routes

**Files:**
- Create: `apps/api/src/routes/backup/providerCustomers.ts`
- Test: `apps/api/src/routes/backup/providerCustomers.test.ts`
- Create: `apps/api/src/routes/backup/providerDevices.ts`
- Test: `apps/api/src/routes/backup/providerDevices.test.ts`
- Read first: `apps/api/src/routes/huntress.ts:564-682` (the mapping list + map shapes), `apps/api/src/middleware/auth.ts:139-147` (`orgCondition(column) => SQL | undefined`, `canAccessOrg`)

**Interfaces:**
- Consumes `remapCustomer`, `RemapCustomerError` from `../../services/backupProviders/mapping`; `requireProviderPartnerAdmin`, `resolveProviderPartnerId`, `isGateFailure` from `./providerAccess`; `resolveScopedOrgId` is **not** used (see the DECISION below).
- Produces `backupProviderCustomerRoutes`, `backupProviderDeviceRoutes` (both mounted by `providers.ts` under `/providers`).

> **DECISION (`orgCondition`, not `resolveScopedOrgId`):** the brief points at `resolveScopedOrgId` (`routes/backup/helpers.ts:328`), which resolves ONE org and returns `null` when a partner caller has several — every existing `/backup` route then 400s. `GET /backup/providers/devices` must support the all-orgs case (it feeds W03's partner-wide overview), so it uses `auth.orgCondition(column)` (`middleware/auth.ts:141`), which is `undefined` for system scope, an equality for one org and an `IN` list otherwise — the devices-list pattern the spec names for `GET /backup/health`. An explicit `?orgId=` is still validated through `auth.canAccessOrg`.

> **DECISION (`PUT /devices/:id/link` uses `BACKUP_WRITE`, not `ORGS_WRITE` + MFA):** linking a provider row to a Breeze device is an org-level data-quality action a technician performs from the device page, not a partner-credential change. It is gated on `backup:write` and org-or-partner scope. It deliberately has **no** `requireMfa()`, which also keeps it reachable from the HTTP-level integration test in Task 14 (fixture tokens are minted with `mfa: false`, `__tests__/integration/db-utils.ts:520`).

> **DECISION (savepoint around the link write):** the composite FK `(breeze_device_id, org_id) → devices(id, org_id)` is what makes a cross-org link unrepresentable, and the route turns its 23503 into a 422. A caught Postgres error leaves the ambient request transaction ABORTED, so the 422 would be rethrown as a raw 500 at COMMIT. The write therefore runs inside a nested `db.transaction` (a savepoint) **and** is preceded by an explicit SELECT pre-check; the savepointed catch is the concurrent-writer backstop. The partial unique index on `breeze_device_id` gets the same treatment for its 23505.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/routes/backup/providerCustomers.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authState, gates, dbState, remapState } = vi.hoisted(() => ({
  authState: {
    scope: 'partner' as 'organization' | 'partner' | 'system',
    partnerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as string | null,
    partnerOrgAccess: 'all' as 'all' | 'selected' | 'none' | null,
    orgId: null as string | null,
    accessibleOrgIds: [] as string[],
  },
  gates: { permission: false, mfa: false },
  dbState: { connections: [] as unknown[], customers: [] as unknown[] },
  remapState: { result: null as unknown, error: null as null | { code: string; message: string } },
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => dbState.connections),
          orderBy: vi.fn(async () => dbState.customers),
        })),
        leftJoin: vi.fn(() => ({
          where: vi.fn(() => ({ orderBy: vi.fn(async () => dbState.customers) })),
        })),
      })),
    })),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../../db/schema', () => ({
  backupProviderConnections: { id: 'id', partnerId: 'partner_id', name: 'name' },
  backupProviderCustomers: {
    id: 'id', connectionId: 'connection_id', partnerId: 'partner_id', orgId: 'org_id',
    vendorCustomerId: 'vendor_customer_id', vendorCustomerName: 'vendor_customer_name',
    vendorLevel: 'vendor_level', vendorExternalCode: 'vendor_external_code',
    mappingSource: 'mapping_source', deviceCount: 'device_count', lastSeenAt: 'last_seen_at',
  },
  organizations: { id: 'id', name: 'name', partnerId: 'partner_id' },
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) =>
    gates.permission ? c.json({ error: 'Forbidden' }, 403) : next()),
  requireMfa: vi.fn(() => async (c: any, next: any) =>
    gates.mfa ? c.json({ error: 'MFA required' }, 403) : next()),
  withAuthDbAccessContext: vi.fn(async (_a: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    BACKUP_READ: { resource: 'backup', action: 'read' },
    BACKUP_WRITE: { resource: 'backup', action: 'write' },
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
  },
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

class FakeRemapError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'RemapCustomerError'; }
}
const remapMock = vi.fn(async () => {
  if (remapState.error) throw new FakeRemapError(remapState.error.code, remapState.error.message);
  return remapState.result;
});
vi.mock('../../services/backupProviders/mapping', () => ({
  remapCustomer: remapMock,
  RemapCustomerError: FakeRemapError,
}));

import { backupProviderCustomerRoutes } from './providerCustomers';

const CONNECTION_ID = '33333333-3333-4333-8333-333333333333';
const CUSTOMER_ID = '44444444-4444-4444-8444-444444444444';
const ORG_ID = '11111111-1111-4111-8111-111111111111';

describe('backup provider customer routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    gates.permission = false;
    gates.mfa = false;
    authState.scope = 'partner';
    authState.partnerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    authState.partnerOrgAccess = 'all';
    dbState.connections = [{ id: CONNECTION_ID, partnerId: authState.partnerId, name: 'OliveTech Cove' }];
    dbState.customers = [];
    remapState.error = null;
    remapState.result = {
      customerId: CUSTOMER_ID, connectionId: CONNECTION_ID, orgId: ORG_ID,
      mappingSource: 'manual', deletedDevices: 4, deletedHistory: 9, resolvedAlerts: 1, syncJobId: 'job-1',
    };
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        scope: authState.scope,
        partnerId: authState.partnerId,
        partnerOrgAccess: authState.partnerOrgAccess,
        orgId: authState.orgId,
        accessibleOrgIds: authState.accessibleOrgIds,
        canAccessOrg: (id: string) => authState.accessibleOrgIds.includes(id),
        user: { id: '99999999-9999-4999-8999-999999999999', email: 't@example.com' },
      });
      await next();
    });
    app.route('/backup/providers', backupProviderCustomerRoutes);
  });

  describe('GET /connections/:id/customers', () => {
    it('returns rows plus an unmapped summary', async () => {
      dbState.customers = [
        { id: CUSTOMER_ID, vendorCustomerId: '2001', vendorCustomerName: 'Acme Corp', vendorLevel: 'EndCustomer', vendorExternalCode: null, orgId: ORG_ID, orgName: 'Acme', mappingSource: 'auto_name', deviceCount: 12, lastSeenAt: null },
        { id: '55555555-5555-4555-8555-555555555555', vendorCustomerId: '2002', vendorCustomerName: 'Beta', vendorLevel: 'EndCustomer', vendorExternalCode: null, orgId: null, orgName: null, mappingSource: null, deviceCount: 7, lastSeenAt: null },
      ];
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}/customers`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      // The unmapped summary is what stops a partner-wide view implying complete
      // vendor coverage (spec, Non-goals).
      expect(body.summary).toEqual({ customers: 2, unmappedCustomers: 1, unmappedDeviceCount: 7 });
    });

    it('404s for a connection outside the caller partner', async () => {
      dbState.connections = [];
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}/customers`);
      expect(res.status).toBe(404);
    });

    it('refuses an org-scoped caller', async () => {
      authState.scope = 'organization';
      authState.orgId = ORG_ID;
      const res = await app.request(`/backup/providers/connections/${CONNECTION_ID}/customers`);
      expect(res.status).toBe(403);
    });
  });

  describe('PUT /customers/:id/mapping', () => {
    it('maps a customer through remapCustomer and reports what was removed', async () => {
      const res = await app.request(`/backup/providers/customers/${CUSTOMER_ID}/mapping`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: ORG_ID }),
      });
      expect(res.status).toBe(200);
      expect(remapMock).toHaveBeenCalledWith(CUSTOMER_ID, ORG_ID, expect.objectContaining({ partnerId: authState.partnerId }));
      expect(await res.json()).toMatchObject({
        data: { mappingSource: 'manual', deletedDevices: 4, syncJobId: 'job-1' },
      });
    });

    it('accepts an explicit null to un-map', async () => {
      remapState.result = { ...(remapState.result as object), orgId: null, mappingSource: 'manual_unmapped' };
      const res = await app.request(`/backup/providers/customers/${CUSTOMER_ID}/mapping`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: null }),
      });
      expect(res.status).toBe(200);
      expect(remapMock).toHaveBeenCalledWith(CUSTOMER_ID, null, expect.anything());
    });

    it('rejects a missing orgId key rather than silently un-mapping', async () => {
      // `{}` and `{orgId: null}` must not mean the same thing: one is a
      // malformed request, the other a deliberate un-map.
      const res = await app.request(`/backup/providers/customers/${CUSTOMER_ID}/mapping`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(remapMock).not.toHaveBeenCalled();
    });

    it('maps ORG_NOT_IN_PARTNER to 422 and NOT_FOUND to 404', async () => {
      remapState.error = { code: 'ORG_NOT_IN_PARTNER', message: 'nope' };
      let res = await app.request(`/backup/providers/customers/${CUSTOMER_ID}/mapping`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: ORG_ID }),
      });
      expect(res.status).toBe(422);

      remapState.error = { code: 'NOT_FOUND', message: 'gone' };
      res = await app.request(`/backup/providers/customers/${CUSTOMER_ID}/mapping`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: ORG_ID }),
      });
      expect(res.status).toBe(404);
    });

    it('is gated on the write permission, MFA and full partner org access', async () => {
      gates.permission = true;
      let res = await app.request(`/backup/providers/customers/${CUSTOMER_ID}/mapping`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId: null }),
      });
      expect(res.status).toBe(403);

      gates.permission = false;
      gates.mfa = true;
      res = await app.request(`/backup/providers/customers/${CUSTOMER_ID}/mapping`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId: null }),
      });
      expect(res.status).toBe(403);

      gates.mfa = false;
      authState.partnerOrgAccess = 'selected';
      res = await app.request(`/backup/providers/customers/${CUSTOMER_ID}/mapping`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId: null }),
      });
      expect(res.status).toBe(403);
      expect(remapMock).not.toHaveBeenCalled();
    });
  });
});
```

`apps/api/src/routes/backup/providerDevices.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authState, gates, dbState } = vi.hoisted(() => ({
  authState: {
    scope: 'partner' as 'organization' | 'partner' | 'system',
    orgId: null as string | null,
    partnerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as string | null,
    accessibleOrgIds: ['11111111-1111-4111-8111-111111111111'],
  },
  gates: { permission: false },
  dbState: {
    rows: [] as Array<Record<string, unknown>>,
    device: null as null | Record<string, unknown>,
    providerRow: null as null | Record<string, unknown>,
    updated: [] as Array<Record<string, unknown>>,
    orgConditions: [] as unknown[],
    throwOnUpdate: null as null | { code: string },
  },
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn((cols?: Record<string, unknown>) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () =>
            cols && 'hostname' in cols ? (dbState.device ? [dbState.device] : [])
            : (dbState.providerRow ? [dbState.providerRow] : [])),
          orderBy: vi.fn(async () => dbState.rows),
        })),
        leftJoin: vi.fn(() => ({
          where: vi.fn(() => ({ orderBy: vi.fn(async () => dbState.rows) })),
        })),
      })),
    })),
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({
      update: vi.fn(() => ({
        set: vi.fn((v: Record<string, unknown>) => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => {
              if (dbState.throwOnUpdate) {
                const err = new Error('violates foreign key constraint');
                (err as unknown as { cause: unknown }).cause = { code: dbState.throwOnUpdate.code };
                throw err;
              }
              dbState.updated.push(v);
              return [{ id: PROVIDER_ROW_ID, ...v }];
            }),
          })),
        })),
      })),
    })),
  },
}));

vi.mock('../../db/schema', () => ({
  backupProviderDevices: {
    id: 'id', orgId: 'org_id', connectionId: 'connection_id', customerId: 'customer_id',
    provider: 'provider', vendorDeviceId: 'vendor_device_id', vendorDeviceName: 'vendor_device_name',
    computerName: 'computer_name', osType: 'os_type', accountType: 'account_type',
    status: 'status', lastSuccessAt: 'last_success_at', lastSessionAt: 'last_session_at',
    selectedBytes: 'selected_bytes', usedBytes: 'used_bytes', errorsCount: 'errors_count',
    dataSources: 'data_sources', breezeDeviceId: 'breeze_device_id',
    deviceMatchSource: 'device_match_source', updatedAt: 'updated_at',
  },
  backupProviderCustomers: { id: 'id', vendorCustomerName: 'vendor_customer_name' },
  devices: { id: 'id', orgId: 'org_id', hostname: 'hostname', displayName: 'display_name' },
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) =>
    gates.permission ? c.json({ error: 'Forbidden' }, 403) : next()),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    BACKUP_READ: { resource: 'backup', action: 'read' },
    BACKUP_WRITE: { resource: 'backup', action: 'write' },
  },
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { backupProviderDeviceRoutes } from './providerDevices';

const PROVIDER_ROW_ID = '66666666-6666-4666-8666-666666666666';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '77777777-7777-4777-8777-777777777777';

describe('backup provider device routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    gates.permission = false;
    authState.scope = 'partner';
    authState.orgId = null;
    authState.accessibleOrgIds = [ORG_ID];
    dbState.rows = [];
    dbState.device = { id: DEVICE_ID, orgId: ORG_ID, hostname: 'srv-fs01' };
    dbState.providerRow = { id: PROVIDER_ROW_ID, orgId: ORG_ID, breezeDeviceId: null };
    dbState.updated = [];
    dbState.orgConditions = [];
    dbState.throwOnUpdate = null;
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        scope: authState.scope,
        orgId: authState.orgId,
        partnerId: authState.partnerId,
        accessibleOrgIds: authState.accessibleOrgIds,
        canAccessOrg: (id: string) => authState.accessibleOrgIds.includes(id),
        orgCondition: vi.fn((col: unknown) => { dbState.orgConditions.push(col); return undefined; }),
        user: { id: '99999999-9999-4999-8999-999999999999', email: 't@example.com' },
      });
      await next();
    });
    app.route('/backup/providers', backupProviderDeviceRoutes);
  });

  describe('GET /devices', () => {
    it('scopes by auth.orgCondition when no orgId is given (all accessible orgs)', async () => {
      const res = await app.request('/backup/providers/devices');
      expect(res.status).toBe(200);
      expect(dbState.orgConditions).toHaveLength(1);
    });

    it('honours an explicit accessible ?orgId', async () => {
      const res = await app.request(`/backup/providers/devices?orgId=${ORG_ID}`);
      expect(res.status).toBe(200);
    });

    it('refuses an ?orgId the caller cannot access', async () => {
      const res = await app.request(`/backup/providers/devices?orgId=${OTHER_ORG_ID}`);
      expect(res.status).toBe(403);
    });

    it('rejects a malformed ?orgId', async () => {
      const res = await app.request('/backup/providers/devices?orgId=not-a-uuid');
      expect(res.status).toBe(400);
    });

    it('rejects a malformed ?linked value instead of silently ignoring it', async () => {
      const res = await app.request('/backup/providers/devices?linked=maybe');
      expect(res.status).toBe(400);
    });

    it('is gated on backup:read', async () => {
      gates.permission = true;
      const res = await app.request('/backup/providers/devices');
      expect(res.status).toBe(403);
    });
  });

  describe('PUT /devices/:id/link', () => {
    it('links a device in the SAME org', async () => {
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      });
      expect(res.status).toBe(200);
      expect(dbState.updated[0]).toMatchObject({ breezeDeviceId: DEVICE_ID, deviceMatchSource: 'manual' });
    });

    it('unlinks on an explicit null, clearing the provenance column too', async () => {
      dbState.providerRow = { id: PROVIDER_ROW_ID, orgId: ORG_ID, breezeDeviceId: DEVICE_ID };
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: null }),
      });
      expect(res.status).toBe(200);
      // Leaving device_match_source = 'manual' behind would make W02's matcher
      // skip the row forever (manual links are never re-matched).
      expect(dbState.updated[0]).toMatchObject({ breezeDeviceId: null, deviceMatchSource: null });
    });

    it('PRE-CHECKS a cross-org device and refuses with 422 before touching the row', async () => {
      dbState.device = { id: DEVICE_ID, orgId: OTHER_ORG_ID, hostname: 'srv-other' };
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      });
      expect(res.status).toBe(422);
      expect(dbState.updated).toHaveLength(0);
    });

    it('maps a racing 23503 from the composite FK to 422, not a 500', async () => {
      dbState.throwOnUpdate = { code: '23503' };
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      });
      expect(res.status).toBe(422);
    });

    it('maps a 23505 from the one-row-per-device index to 409', async () => {
      dbState.throwOnUpdate = { code: '23505' };
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      });
      expect(res.status).toBe(409);
    });

    it('runs the write inside a nested transaction (savepoint) so the caught error does not poison the request', async () => {
      const { db } = await import('../../db');
      await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      });
      expect(db.transaction).toHaveBeenCalled();
    });

    it('404s for a provider row the caller cannot see', async () => {
      dbState.providerRow = null;
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      });
      expect(res.status).toBe(404);
    });

    it('404s when the target device does not exist', async () => {
      dbState.device = null;
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: DEVICE_ID }),
      });
      expect(res.status).toBe(404);
    });

    it('rejects a missing deviceId key rather than silently unlinking', async () => {
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('is gated on backup:write', async () => {
      gates.permission = true;
      const res = await app.request(`/backup/providers/devices/${PROVIDER_ROW_ID}/link`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: null }),
      });
      expect(res.status).toBe(403);
    });
  });
});
```

- [ ] **Step 2: Run both to verify they fail**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx vitest run src/routes/backup/providerCustomers.test.ts src/routes/backup/providerDevices.test.ts
```
Expected: two `Failed to load url` errors.

- [ ] **Step 3: Write `providerCustomers.ts`**

```ts
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { backupProviderConnections, backupProviderCustomers, organizations } from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { RemapCustomerError, remapCustomer } from '../../services/backupProviders/mapping';
import { isGateFailure, requireProviderPartnerAdmin, resolveProviderPartnerId } from './providerAccess';

export const backupProviderCustomerRoutes = new Hono();

const connectionIdParamSchema = z.object({ id: z.string().guid() });
const customerIdParamSchema = z.object({ id: z.string().guid() });

/**
 * `orgId` is REQUIRED as a key and nullable as a value. `{}` and
 * `{ orgId: null }` must not mean the same thing: the first is a malformed
 * request, the second a deliberate "leave this customer unmapped", which stamps
 * `manual_unmapped` and is never undone by auto-mapping.
 */
const mappingSchema = z.object({ orgId: z.string().guid().nullable() });

// ---------------------------------------------------------------------------
// GET /backup/providers/connections/:id/customers
// ---------------------------------------------------------------------------
backupProviderCustomerRoutes.get(
  '/connections/:id/customers',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('param', connectionIdParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const gate = resolveProviderPartnerId(c.get('auth'));
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    const [connection] = await db
      .select({ id: backupProviderConnections.id })
      .from(backupProviderConnections)
      .where(and(
        eq(backupProviderConnections.id, id),
        eq(backupProviderConnections.partnerId, gate.partnerId),
      ))
      .limit(1);
    if (!connection) return c.json({ error: 'Backup provider connection not found' }, 404);

    const rows = await db
      .select({
        id: backupProviderCustomers.id,
        vendorCustomerId: backupProviderCustomers.vendorCustomerId,
        vendorCustomerName: backupProviderCustomers.vendorCustomerName,
        vendorLevel: backupProviderCustomers.vendorLevel,
        vendorExternalCode: backupProviderCustomers.vendorExternalCode,
        orgId: backupProviderCustomers.orgId,
        orgName: organizations.name,
        mappingSource: backupProviderCustomers.mappingSource,
        deviceCount: backupProviderCustomers.deviceCount,
        lastSeenAt: backupProviderCustomers.lastSeenAt,
      })
      .from(backupProviderCustomers)
      .leftJoin(organizations, eq(backupProviderCustomers.orgId, organizations.id))
      .where(eq(backupProviderCustomers.connectionId, id))
      .orderBy(backupProviderCustomers.vendorCustomerName);

    // The unmapped summary is load-bearing, not decoration: devices under an
    // unmapped customer are NOT stored (spec D8), so without this a
    // partner-wide view silently implies complete vendor coverage.
    const unmapped = rows.filter((row) => row.orgId === null);
    return c.json({
      data: rows,
      summary: {
        customers: rows.length,
        unmappedCustomers: unmapped.length,
        unmappedDeviceCount: unmapped.reduce((sum, row) => sum + (row.deviceCount ?? 0), 0),
      },
    });
  },
);

// ---------------------------------------------------------------------------
// PUT /backup/providers/customers/:id/mapping
// ---------------------------------------------------------------------------
backupProviderCustomerRoutes.put(
  '/customers/:id/mapping',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', customerIdParamSchema),
  zValidator('json', mappingSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const { orgId } = c.req.valid('json');
    const gate = requireProviderPartnerAdmin(auth);
    if (isGateFailure(gate)) return c.json({ error: gate.error }, gate.status);

    try {
      // Atomic: resolve the customer's alerts, delete its device + ledger rows,
      // update the mapping, enqueue a sync. Nothing stays visible to the old
      // org until the next poll.
      const result = await remapCustomer(id, orgId, {
        userId: auth.user?.id ?? null,
        partnerId: gate.partnerId,
      });

      writeRouteAudit(c, {
        orgId,
        action: orgId ? 'backup_provider.customer.map' : 'backup_provider.customer.unmap',
        resourceType: 'backup_provider_customer',
        resourceId: id,
        details: {
          partnerId: gate.partnerId,
          connectionId: result.connectionId,
          mappingSource: result.mappingSource,
          deletedDevices: result.deletedDevices,
          resolvedAlerts: result.resolvedAlerts,
        },
      });

      return c.json({ data: result });
    } catch (error) {
      if (error instanceof RemapCustomerError) {
        return c.json({ error: error.message }, error.code === 'NOT_FOUND' ? 404 : 422);
      }
      throw error;
    }
  },
);
```

- [ ] **Step 4: Write `providerDevices.ts`**

```ts
import { Hono } from 'hono';
import { and, eq, isNotNull, isNull, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { backupProviderCustomers, backupProviderDevices, devices } from '../../db/schema';
import { requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';

export const backupProviderDeviceRoutes = new Hono();

const listQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  deviceId: z.string().guid().optional(),
  connectionId: z.string().guid().optional(),
  // A malformed value is a 400, never a silently-ignored filter — "show me the
  // unlinked rows" returning every row is how an operator concludes everything
  // is linked.
  linked: z.enum(['true', 'false']).optional(),
});

const rowIdParamSchema = z.object({ id: z.string().guid() });
/** `deviceId` is a required KEY with a nullable VALUE — `{}` must not unlink. */
const linkSchema = z.object({ deviceId: z.string().guid().nullable() });

/** The Postgres error code of a caught driver error, however postgres.js wrapped it. */
function pgErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === 'string' ? cause.code : null;
}

// ---------------------------------------------------------------------------
// GET /backup/providers/devices
// ---------------------------------------------------------------------------
backupProviderDeviceRoutes.get(
  '/devices',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('query', listQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const conditions: SQL[] = [];
    if (query.orgId) {
      if (!auth.canAccessOrg(query.orgId)) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      conditions.push(eq(backupProviderDevices.orgId, query.orgId));
    } else {
      // No orgId = every accessible org (the devices-list pattern). `undefined`
      // for system scope, an equality for one org, an IN list otherwise.
      const scoped = auth.orgCondition(backupProviderDevices.orgId);
      if (scoped) conditions.push(scoped);
    }
    if (query.deviceId) conditions.push(eq(backupProviderDevices.breezeDeviceId, query.deviceId));
    if (query.connectionId) conditions.push(eq(backupProviderDevices.connectionId, query.connectionId));
    if (query.linked === 'true') conditions.push(isNotNull(backupProviderDevices.breezeDeviceId));
    if (query.linked === 'false') conditions.push(isNull(backupProviderDevices.breezeDeviceId));

    const rows = await db
      .select({
        id: backupProviderDevices.id,
        orgId: backupProviderDevices.orgId,
        connectionId: backupProviderDevices.connectionId,
        provider: backupProviderDevices.provider,
        customerId: backupProviderDevices.customerId,
        customerName: backupProviderCustomers.vendorCustomerName,
        vendorDeviceId: backupProviderDevices.vendorDeviceId,
        vendorDeviceName: backupProviderDevices.vendorDeviceName,
        computerName: backupProviderDevices.computerName,
        osType: backupProviderDevices.osType,
        accountType: backupProviderDevices.accountType,
        dataSources: backupProviderDevices.dataSources,
        status: backupProviderDevices.status,
        lastSessionAt: backupProviderDevices.lastSessionAt,
        lastSuccessAt: backupProviderDevices.lastSuccessAt,
        selectedBytes: backupProviderDevices.selectedBytes,
        usedBytes: backupProviderDevices.usedBytes,
        errorsCount: backupProviderDevices.errorsCount,
        breezeDeviceId: backupProviderDevices.breezeDeviceId,
        deviceMatchSource: backupProviderDevices.deviceMatchSource,
      })
      .from(backupProviderDevices)
      .leftJoin(backupProviderCustomers, eq(backupProviderDevices.customerId, backupProviderCustomers.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(backupProviderDevices.vendorDeviceName);

    // Health is DERIVED, never stored: W03's read model applies
    // `deriveBackupHealth` over these rows. This endpoint is the raw view (the
    // device-tab card and diagnostics).
    return c.json({ data: rows });
  },
);

// ---------------------------------------------------------------------------
// PUT /backup/providers/devices/:id/link
// ---------------------------------------------------------------------------
backupProviderDeviceRoutes.put(
  '/devices/:id/link',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  zValidator('param', rowIdParamSchema),
  zValidator('json', linkSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const { deviceId } = c.req.valid('json');

    // RLS already hides another org's provider row, so an empty result here is
    // "not visible to you", which is exactly a 404.
    const [providerRow] = await db
      .select({
        id: backupProviderDevices.id,
        orgId: backupProviderDevices.orgId,
        breezeDeviceId: backupProviderDevices.breezeDeviceId,
      })
      .from(backupProviderDevices)
      .where(eq(backupProviderDevices.id, id))
      .limit(1);
    if (!providerRow) return c.json({ error: 'Backup provider device not found' }, 404);

    if (deviceId !== null) {
      // PRE-CHECK, because the composite FK's 23503 would otherwise abort the
      // ambient request transaction and turn the friendly 422 into a raw 500 at
      // COMMIT. The savepointed catch below is the concurrent-writer backstop,
      // not the primary control.
      const [device] = await db
        .select({ id: devices.id, orgId: devices.orgId, hostname: devices.hostname })
        .from(devices)
        .where(eq(devices.id, deviceId))
        .limit(1);
      if (!device) return c.json({ error: 'Device not found' }, 404);
      if (device.orgId !== providerRow.orgId) {
        return c.json({
          error: 'That device belongs to a different organization than this provider row',
          code: 'DEVICE_ORG_MISMATCH',
        }, 422);
      }
    }

    try {
      // A nested db.transaction is a SAVEPOINT: a Postgres error raised inside
      // it rolls back only to the savepoint, leaving the ambient request
      // transaction usable so the mapped 4xx actually reaches the client.
      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(backupProviderDevices)
          .set({
            breezeDeviceId: deviceId,
            // The provenance column is cleared WITH the link and set WITH it:
            // a row carrying 'manual' but no link would be skipped forever by
            // W02's matcher, which never re-matches a manual link.
            deviceMatchSource: deviceId === null ? null : 'manual',
            updatedAt: new Date(),
          })
          .where(eq(backupProviderDevices.id, id))
          .returning({
            id: backupProviderDevices.id,
            breezeDeviceId: backupProviderDevices.breezeDeviceId,
            deviceMatchSource: backupProviderDevices.deviceMatchSource,
          });
        return row ?? null;
      });
      if (!updated) return c.json({ error: 'Backup provider device not found' }, 404);

      writeRouteAudit(c, {
        orgId: providerRow.orgId,
        action: deviceId ? 'backup_provider.device.link' : 'backup_provider.device.unlink',
        resourceType: 'backup_provider_device',
        resourceId: id,
        details: { deviceId, previousDeviceId: providerRow.breezeDeviceId },
      });

      return c.json({ data: updated });
    } catch (error) {
      const code = pgErrorCode(error);
      if (code === '23503') {
        return c.json({
          error: 'That device belongs to a different organization than this provider row',
          code: 'DEVICE_ORG_MISMATCH',
        }, 422);
      }
      if (code === '23505') {
        // The partial unique index on breeze_device_id: one provider row per
        // Breeze device. Post-acquisition, a device backed up by two
        // connections links to the first.
        return c.json({
          error: 'That device is already linked to another backup provider row',
          code: 'DEVICE_ALREADY_LINKED',
        }, 409);
      }
      throw error;
    }
  },
);
```

- [ ] **Step 5: Run all three route suites to verify they pass**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx vitest run src/routes/backup/providerCustomers.test.ts src/routes/backup/providerDevices.test.ts src/routes/backup/providers.test.ts
```
Expected: 3 files, all cases PASS (`providers.test.ts` now resolves both sub-routers).

- [ ] **Step 6: Typecheck the API package**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api && npx tsc --noEmit -p tsconfig.json
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration
git add apps/api/src/routes/backup/providerCustomers.ts \
        apps/api/src/routes/backup/providerCustomers.test.ts \
        apps/api/src/routes/backup/providerDevices.ts \
        apps/api/src/routes/backup/providerDevices.test.ts
git commit -m "$(cat <<'EOF'
feat(integrations): customer-mapping and device-link routes for backup providers (#6008 W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: `backupProviderRls.integration.test.ts` — the live-database contract

**Files:**
- Create: `apps/api/src/__tests__/integration/backupProviderRls.integration.test.ts`
- Read first: `apps/api/src/__tests__/integration/m365TenantSyncRls.integration.test.ts` (the whole harness — `seedOrg`, the `runDb` gate, the `getTestDb()` admin handle, the forge/merge/move blocks), `apps/api/src/__tests__/integration/db-utils.ts:129-316,470-592` (`createPartner`, `createOrganization`, `createSite`, `createUser`, `createIntegrationTestClient`)

**Interfaces:**
- Consumes `db`, `withDbAccessContext`, `withSystemDbAccessContext`, `type DbAccessContext` from `../../db`; the four Drizzle tables plus `devices`, `alerts` from `../../db/schema`; `createOrganization`, `createPartner`, `createSite`, `createUser`, `createIntegrationTestClient` from `./db-utils`; `getTestDb` from `./setup`; `executeOrgMerge` from `../../services/orgMerge`; `cascadeDeleteOrg` from `../../services/tenantCascade`; `EXTERNAL_BACKUP_STATUSES` from `@breeze/shared`.
- Produces nothing; it is the proof.

> **DECISION (the HTTP-level 422 case lives here):** a route that maps a Postgres error code to an HTTP status cannot be proved by Drizzle mocks — the mocked suite is green while the real request 500s at COMMIT. `PUT /devices/:id/link` is exactly that shape, so this file drives it through the real router with `createIntegrationTestClient`. The fixture token is minted with `mfa: false`, which is why that route carries no `requireMfa()` (Task 13 DECISION).

> Note on the `execSync` shape: this file is covered by `vitest.integration.config.ts`'s `src/__tests__/integration/**/*.test.ts` glob, so it needs no config change. It inherits `setup.ts`'s per-test `TRUNCATE CASCADE`, so every block seeds its own fixture.

- [ ] **Step 1: Write the test**

```ts
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { EXTERNAL_BACKUP_STATUSES } from '@breeze/shared';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  backupProviderConnections,
  backupProviderCustomers,
  backupProviderDeviceHistory,
  backupProviderDevices,
  devices,
} from '../../db/schema';
import { createIntegrationTestClient, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';
import { executeOrgMerge } from '../../services/orgMerge';
import { cascadeDeleteOrg } from '../../services/tenantCascade';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const PROVIDER_TABLES = [
  'backup_provider_connections',
  'backup_provider_customers',
  'backup_provider_devices',
  'backup_provider_device_history',
] as const;

/** A partner with one org, one site, one device, one connection, one mapped customer. */
async function seedTenant(label: string, existingPartnerId?: string) {
  const partner = existingPartnerId ? { id: existingPartnerId } : await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `backup-provider-${label}-${randomUUID()}@example.com`,
  });
  // Admin handle for `devices`: its partner-export insert trigger takes partner
  // locks that refuse inside an app-role seed transaction (same reason as
  // m365TenantSyncRls's seedOrg).
  const [device] = await (getTestDb() as typeof db).insert(devices).values({
    orgId: org.id,
    siteId: site!.id,
    agentId: randomUUID(),
    hostname: `bp-${label}-${randomUUID().slice(0, 8)}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'online',
  }).returning({ id: devices.id, hostname: devices.hostname });

  const [connection] = await db.insert(backupProviderConnections).values({
    partnerId: partner.id,
    provider: 'cove',
    name: `Cove ${label}`,
    credentialsEncrypted: 'enc:test',
    vendorRootId: '1000',
    vendorRootName: 'RootPartner',
  }).returning({ id: backupProviderConnections.id });

  const [customer] = await db.insert(backupProviderCustomers).values({
    connectionId: connection!.id,
    partnerId: partner.id,
    vendorCustomerId: `vendor-${label}`,
    vendorCustomerName: `Customer ${label}`,
    orgId: org.id,
    mappingSource: 'manual',
  }).returning({ id: backupProviderCustomers.id });

  const orgContext: DbAccessContext = {
    scope: 'organization',
    orgId: org.id,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [],
    userId: user.id,
  };
  const partnerContext: DbAccessContext = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [partner.id],
    userId: user.id,
  };

  return { partner, org, site: site!, user, device: device!, connection: connection!, customer: customer!, orgContext, partnerContext };
}

async function seedFixture() {
  return withSystemDbAccessContext(async () => ({ a: await seedTenant('a'), b: await seedTenant('b') }));
}

async function insertProviderDevice(
  tenant: Awaited<ReturnType<typeof seedTenant>>,
  over: Record<string, unknown> = {},
) {
  const [row] = await db.insert(backupProviderDevices).values({
    connectionId: tenant.connection.id,
    partnerId: tenant.partner.id,
    orgId: tenant.org.id,
    customerId: tenant.customer.id,
    provider: 'cove',
    vendorDeviceId: `vd-${randomUUID().slice(0, 8)}`,
    vendorDeviceName: 'SRV-FS01',
    ...over,
  }).returning({ id: backupProviderDevices.id });
  return row!;
}

// ---------------------------------------------------------------------------

describe('backup provider — schema invariants (live catalog)', () => {
  runDb('all four tables have RLS enabled AND forced', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND relname = ANY(${sql.raw(
        `ARRAY[${PROVIDER_TABLES.map((t) => `'${t}'`).join(',')}]::text[]`,
      )})
      ORDER BY relname
    `)) as unknown as Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(rows).toHaveLength(PROVIDER_TABLES.length);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} RLS not enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} RLS not forced`).toBe(true);
    }
  });

  runDb('the partner-axis tables carry four breeze_has_partner_access policies each', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT tablename, cmd, qual, with_check FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('backup_provider_connections', 'backup_provider_customers')
      ORDER BY tablename, cmd
    `)) as unknown as Array<{ tablename: string; cmd: string; qual: string | null; with_check: string | null }>;
    for (const table of ['backup_provider_connections', 'backup_provider_customers']) {
      const forTable = rows.filter((r) => r.tablename === table);
      expect(forTable.map((r) => r.cmd).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      for (const policy of forTable) {
        expect(`${policy.qual ?? ''}${policy.with_check ?? ''}`).toContain('breeze_has_partner_access');
      }
    }
    // The customers INSERT/UPDATE WITH CHECK additionally re-checks the parent
    // connection's partner_id, so a row whose connection belongs to another
    // partner is refused by the POLICY as well as by the composite FK.
    const customerWrites = rows.filter(
      (r) => r.tablename === 'backup_provider_customers' && (r.cmd === 'INSERT' || r.cmd === 'UPDATE'),
    );
    expect(customerWrites).toHaveLength(2);
    for (const policy of customerWrites) {
      expect(policy.with_check ?? '').toContain('backup_provider_connections');
    }
  });

  runDb('the org-axis tables carry one FOR ALL breeze_has_org_access policy each', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('backup_provider_devices', 'backup_provider_device_history')
      ORDER BY tablename
    `)) as unknown as Array<{ tablename: string; policyname: string; cmd: string; qual: string; with_check: string }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.policyname).toBe(`${row.tablename}_org_access`);
      expect(row.cmd).toBe('ALL');
      expect(row.qual).toContain('breeze_has_org_access');
      expect(row.with_check).toContain('breeze_has_org_access');
      // partner_id on backup_provider_devices is denormalization, NEVER a
      // second read branch — a partner-access leg here would let a
      // restricted-org partner user read every org's rows.
      expect(row.qual).not.toContain('breeze_has_partner_access');
    }
  });

  runDb('every composite FK referencing an org_id column is deferrable, and the device link sets ONE column', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT conname, condeferrable, confdeltype,
             (SELECT array_agg(a.attname ORDER BY a.attname)
                FROM unnest(con.confdelsetcols) AS c(attnum)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = c.attnum) AS setcols
      FROM pg_constraint con
      WHERE conname IN (
        'backup_provider_customers_org_partner_fk',
        'backup_provider_devices_customer_org_fk',
        'backup_provider_devices_breeze_device_org_fk',
        'backup_provider_device_history_device_org_fk'
      )
      ORDER BY conname
    `)) as unknown as Array<{ conname: string; condeferrable: boolean; confdeltype: string; setcols: string[] | null }>;
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.condeferrable, `${row.conname} not deferrable`).toBe(true);
    const link = rows.find((r) => r.conname === 'backup_provider_devices_breeze_device_org_fk')!;
    expect(link.confdeltype).toBe('n');                 // SET NULL
    expect(link.setcols).toEqual(['breeze_device_id']); // ...on that column ONLY
  });

  runDb('the external_backup_status enum matches EXTERNAL_BACKUP_STATUSES exactly, in order', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'external_backup_status' ORDER BY e.enumsortorder
    `)) as unknown as Array<{ enumlabel: string }>;
    expect(rows.map((r) => r.enumlabel)).toEqual([...EXTERNAL_BACKUP_STATUSES]);
  });

  runDb('the one-provider-row-per-device index is partial and the FK targets exist', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN (
        'backup_provider_devices_breeze_device_uniq',
        'backup_provider_customers_id_org_uniq',
        'backup_provider_devices_id_org_uniq',
        'backup_provider_connections_id_partner_uniq'
      ) ORDER BY indexname
    `)) as unknown as Array<{ indexname: string; indexdef: string }>;
    expect(rows).toHaveLength(4);
    const partial = rows.find((r) => r.indexname === 'backup_provider_devices_breeze_device_uniq')!;
    expect(partial.indexdef).toContain('UNIQUE');
    expect(partial.indexdef).toContain('WHERE');
  });
});

describe('backup provider — cross-tenant isolation as breeze_app', () => {
  runDb('runs code-under-test as breeze_app without BYPASSRLS', async () => {
    const fx = await seedFixture();
    const rows = await withDbAccessContext(fx.a.partnerContext, () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
    expect((rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0])
      .toEqual({ who: 'breeze_app', rolbypassrls: false });
  });

  runDb('refuses a forged cross-partner connection insert with 42501', async () => {
    const fx = await seedFixture();
    await expect(withDbAccessContext(fx.a.partnerContext, () =>
      db.insert(backupProviderConnections).values({
        partnerId: fx.b.partner.id, provider: 'cove', name: 'forged', credentialsEncrypted: 'enc:x',
      }))).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('refuses a forged cross-partner customer insert with 42501', async () => {
    const fx = await seedFixture();
    await expect(withDbAccessContext(fx.a.partnerContext, () =>
      db.insert(backupProviderCustomers).values({
        connectionId: fx.b.connection.id, partnerId: fx.b.partner.id,
        vendorCustomerId: 'forged', vendorCustomerName: 'forged',
      }))).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('hides another partner connection from a SELECT', async () => {
    const fx = await seedFixture();
    const visible = await withDbAccessContext(fx.a.partnerContext, () =>
      db.select({ id: backupProviderConnections.id }).from(backupProviderConnections)
        .where(sql`${backupProviderConnections.id} = ${fx.b.connection.id}::uuid`));
    expect(visible).toEqual([]);
  });

  runDb('an ORG token cannot read the partner-axis tables at all', async () => {
    // This is what forces `provider` and `portal_show_provider_name` to be
    // DENORMALIZED onto the device rows: the client portal runs under an org
    // token and could otherwise never label a provider row.
    const fx = await seedFixture();
    const conns = await withDbAccessContext(fx.a.orgContext, () =>
      db.select({ id: backupProviderConnections.id }).from(backupProviderConnections));
    expect(conns).toEqual([]);
    const customers = await withDbAccessContext(fx.a.orgContext, () =>
      db.select({ id: backupProviderCustomers.id }).from(backupProviderCustomers));
    expect(customers).toEqual([]);
  });

  runDb('a customer mapped to a FOREIGN-partner org is rejected with 23503', async () => {
    const fx = await seedFixture();
    await expect(withSystemDbAccessContext(() =>
      db.insert(backupProviderCustomers).values({
        connectionId: fx.a.connection.id,
        partnerId: fx.a.partner.id,
        vendorCustomerId: 'cross',
        vendorCustomerName: 'cross',
        // Partner A's connection mapped to partner B's org — representable
        // only if the (org_id, partner_id) composite FK is missing.
        orgId: fx.b.org.id,
        mappingSource: 'manual',
      }))).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  runDb('an org token cannot read ANOTHER org device rows, and its own partner token reads them all', async () => {
    const fx = await seedFixture();
    await withSystemDbAccessContext(() => insertProviderDevice(fx.b));
    const foreign = await withDbAccessContext(fx.a.orgContext, () =>
      db.select({ id: backupProviderDevices.id }).from(backupProviderDevices)
        .where(sql`${backupProviderDevices.orgId} = ${fx.b.org.id}::uuid`));
    expect(foreign).toEqual([]);

    await withSystemDbAccessContext(() => insertProviderDevice(fx.a));
    const own = await withDbAccessContext(fx.a.partnerContext, () =>
      db.select({ id: backupProviderDevices.id }).from(backupProviderDevices));
    expect(own).toHaveLength(1);
  });

  runDb('refuses a device row whose customer belongs to another org with 23503', async () => {
    const fx = await seedFixture();
    await expect(withSystemDbAccessContext(() =>
      db.insert(backupProviderDevices).values({
        connectionId: fx.a.connection.id,
        partnerId: fx.a.partner.id,
        orgId: fx.a.org.id,
        customerId: fx.b.customer.id, // another org's customer
        provider: 'cove',
        vendorDeviceId: 'x',
        vendorDeviceName: 'x',
      }))).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  runDb('refuses linking to a device in ANOTHER org with 23503', async () => {
    const fx = await seedFixture();
    await expect(withSystemDbAccessContext(() =>
      insertProviderDevice(fx.a, { breezeDeviceId: fx.b.device.id })))
      .rejects.toMatchObject({ cause: { code: '23503' } });
  });

  runDb('refuses a SECOND provider row linked to the same Breeze device with 23505', async () => {
    const fx = await seedFixture();
    await withSystemDbAccessContext(() => insertProviderDevice(fx.a, { breezeDeviceId: fx.a.device.id }));
    await expect(withSystemDbAccessContext(() =>
      insertProviderDevice(fx.a, { breezeDeviceId: fx.a.device.id })))
      .rejects.toMatchObject({ cause: { code: '23505' } });
  });

  runDb('refuses a ledger row whose device belongs to another org with 23503', async () => {
    const fx = await seedFixture();
    const row = await withSystemDbAccessContext(() => insertProviderDevice(fx.b));
    await expect(withSystemDbAccessContext(() =>
      db.insert(backupProviderDeviceHistory).values({
        providerDeviceId: row.id, orgId: fx.a.org.id, day: '2026-09-15', status: 'completed',
      }))).rejects.toMatchObject({ cause: { code: '23503' } });
  });
});

describe('backup provider — lifecycle against real Postgres', () => {
  runDb('deleting a device clears ONLY breeze_device_id, keeping the provider row and its org', async () => {
    const fx = await seedFixture();
    const row = await withSystemDbAccessContext(() =>
      insertProviderDevice(fx.a, { breezeDeviceId: fx.a.device.id, deviceMatchSource: 'manual' }));
    await withSystemDbAccessContext(() =>
      db.execute(sql`DELETE FROM devices WHERE id = ${fx.a.device.id}::uuid`));
    const [after] = (await getTestDb().execute(sql`
      SELECT org_id, breeze_device_id, vendor_device_name
      FROM backup_provider_devices WHERE id = ${row.id}::uuid
    `)) as unknown as Array<{ org_id: string; breeze_device_id: string | null; vendor_device_name: string }>;
    expect(after, 'the ON DELETE SET NULL nulled the whole row instead of the link column').toBeDefined();
    expect(after!.breeze_device_id).toBeNull();
    expect(after!.org_id).toBe(fx.a.org.id);
  });

  runDb('deleting a connection cascades customers, devices and the ledger away', async () => {
    const fx = await seedFixture();
    const row = await withSystemDbAccessContext(() => insertProviderDevice(fx.a));
    await withSystemDbAccessContext(() => db.insert(backupProviderDeviceHistory).values({
      providerDeviceId: row.id, orgId: fx.a.org.id, day: '2026-09-15', status: 'completed',
    }));

    await withSystemDbAccessContext(() =>
      db.execute(sql`DELETE FROM backup_provider_connections WHERE id = ${fx.a.connection.id}::uuid`));

    const admin = getTestDb() as typeof db;
    for (const table of ['backup_provider_customers', 'backup_provider_devices', 'backup_provider_device_history']) {
      const [count] = (await admin.execute(sql`
        SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${fx.a.org.id}::uuid
      `)) as unknown as Array<{ n: number }>;
      expect(count!.n, `${table} survived the connection delete`).toBe(0);
    }
  });

  runDb('a device org flip with a live provider link fails on the link FK unless it is detached first', async () => {
    // Proves the PREMISE behind the moveOrg.ts detach (Task 4): the FK is
    // checked at the END of the device org flip, and nothing but an explicit
    // detach before the flip clears it. The mocked route test pins the
    // statement ORDER; only a live database shows that order is load-bearing.
    const fx = await withSystemDbAccessContext(async () => {
      const a = await seedTenant('move-src');
      const target = await createOrganization({ partnerId: a.partner.id });
      const targetSite = await createSite({ orgId: target.id });
      return { a, target, targetSite: targetSite! };
    });
    const row = await withSystemDbAccessContext(() =>
      insertProviderDevice(fx.a, { breezeDeviceId: fx.a.device.id, deviceMatchSource: 'auto_hostname' }));

    const admin = getTestDb() as typeof db;
    const flip = (tx: typeof db) => tx.execute(sql`
      UPDATE devices SET org_id = ${fx.target.id}::uuid, site_id = ${fx.targetSite.id}::uuid
      WHERE id = ${fx.a.device.id}::uuid`);

    // Negative control: no detach -> the composite FK refuses the flip.
    await expect(admin.transaction(async (tx) => { await flip(tx as unknown as typeof db); }))
      .rejects.toMatchObject({
        cause: { code: '23503', constraint_name: 'backup_provider_devices_breeze_device_org_fk' },
      });

    // The route's statement, then the flip: succeeds, and the SOURCE org's
    // provider row survives with only its link and provenance cleared.
    await admin.transaction(async (tx) => {
      await tx.execute(sql`UPDATE backup_provider_devices
        SET breeze_device_id = NULL, device_match_source = NULL
        WHERE breeze_device_id = ${fx.a.device.id}::uuid AND org_id = ${fx.a.org.id}::uuid`);
      await flip(tx as unknown as typeof db);
    });
    const rows = (await admin.execute(sql`
      SELECT org_id, breeze_device_id, device_match_source
      FROM backup_provider_devices WHERE id = ${row.id}::uuid
    `)) as unknown as Array<{ org_id: string; breeze_device_id: string | null; device_match_source: string | null }>;
    // NOT re-homed: the row stays with its customer's org.
    expect(rows).toEqual([{ org_id: fx.a.org.id, breeze_device_id: null, device_match_source: null }]);
  });

  runDb('org erasure removes every provider row for the target org and leaves the other org intact', async () => {
    const fx = await seedFixture();
    const row = await withSystemDbAccessContext(() => insertProviderDevice(fx.a, { breezeDeviceId: fx.a.device.id }));
    await withSystemDbAccessContext(() => db.insert(backupProviderDeviceHistory).values({
      providerDeviceId: row.id, orgId: fx.a.org.id, day: '2026-09-15', status: 'failed',
    }));
    await withSystemDbAccessContext(() => insertProviderDevice(fx.b));

    await cascadeDeleteOrg(fx.a.org.id, fx.a.user.id, fx.a.user.email);

    const admin = getTestDb() as typeof db;
    for (const table of ['backup_provider_customers', 'backup_provider_devices', 'backup_provider_device_history']) {
      const [gone] = (await admin.execute(sql`
        SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${fx.a.org.id}::uuid
      `)) as unknown as Array<{ n: number }>;
      expect(gone!.n, `${table} left rows under the erased org`).toBe(0);
    }
    const [survivor] = (await admin.execute(sql`
      SELECT count(*)::int AS n FROM backup_provider_devices WHERE org_id = ${fx.b.org.id}::uuid
    `)) as unknown as Array<{ n: number }>;
    expect(survivor!.n).toBe(1);
    // The PARTNER-axis connection is untouched by an ORG erasure — it has no
    // org_id and belongs to the MSP, not the customer.
    const [connection] = (await admin.execute(sql`
      SELECT count(*)::int AS n FROM backup_provider_connections WHERE id = ${fx.a.connection.id}::uuid
    `)) as unknown as Array<{ n: number }>;
    expect(connection!.n).toBe(1);
  });

  runDb('an org merge re-points the customer, its devices and its ledger to the survivor', async () => {
    const prior = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
    try {
      const fx = await withSystemDbAccessContext(async () => {
        const loser = await seedTenant('merge-loser');
        const survivor = await createOrganization({ partnerId: loser.partner.id });
        const actor = await createUser({
          partnerId: loser.partner.id,
          email: `backup-provider-merge-${randomUUID()}@example.com`,
        });
        return { loser, survivor, actor };
      });
      const row = await withSystemDbAccessContext(() =>
        insertProviderDevice(fx.loser, { breezeDeviceId: fx.loser.device.id }));
      await withSystemDbAccessContext(() => db.insert(backupProviderDeviceHistory).values({
        providerDeviceId: row.id, orgId: fx.loser.org.id, day: '2026-09-15', status: 'completed',
      }));

      const result = await executeOrgMerge({
        loserOrgId: fx.loser.org.id,
        survivorOrgId: fx.survivor.id,
        partnerId: fx.loser.partner.id,
        performedBy: fx.actor.id,
        performedByEmail: fx.actor.email,
      });
      // Plain repoint, not a resolve-phase delete: the mapping, the link and
      // the 28-day ledger all survive the merge.
      expect(result.tables.backup_provider_customers).toEqual({ moved: 1, dropped: 0 });
      expect(result.tables.backup_provider_devices).toEqual({ moved: 1, dropped: 0 });
      expect(result.tables.backup_provider_device_history).toEqual({ moved: 1, dropped: 0 });

      const admin = getTestDb() as typeof db;
      const [moved] = (await admin.execute(sql`
        SELECT org_id, breeze_device_id FROM backup_provider_devices WHERE id = ${row.id}::uuid
      `)) as unknown as Array<{ org_id: string; breeze_device_id: string | null }>;
      expect(moved!.org_id).toBe(fx.survivor.id);
      // The device repointed too, so the composite link FK still holds.
      expect(moved!.breeze_device_id).toBe(fx.loser.device.id);
    } finally {
      if (prior === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
      else process.env.ORG_MERGE_FENCE_DRAIN_MS = prior;
    }
  });

  runDb('remapCustomer deletes the old org rows and re-homes the mapping atomically', async () => {
    const { remapCustomer } = await import('../../services/backupProviders/mapping');
    const fx = await withSystemDbAccessContext(async () => {
      const tenant = await seedTenant('remap');
      const target = await createOrganization({ partnerId: tenant.partner.id });
      return { tenant, target };
    });
    const row = await withSystemDbAccessContext(() => insertProviderDevice(fx.tenant));
    await withSystemDbAccessContext(() => db.insert(backupProviderDeviceHistory).values({
      providerDeviceId: row.id, orgId: fx.tenant.org.id, day: '2026-09-15', status: 'completed',
    }));

    const result = await withSystemDbAccessContext(() => remapCustomer(
      fx.tenant.customer.id,
      fx.target.id,
      { userId: fx.tenant.user.id, partnerId: fx.tenant.partner.id },
    ));
    expect(result).toMatchObject({ orgId: fx.target.id, mappingSource: 'manual', deletedDevices: 1, deletedHistory: 1 });

    const admin = getTestDb() as typeof db;
    const [devicesLeft] = (await admin.execute(sql`
      SELECT count(*)::int AS n FROM backup_provider_devices WHERE customer_id = ${fx.tenant.customer.id}::uuid
    `)) as unknown as Array<{ n: number }>;
    // Nothing stays visible to the OLD org: the rows are gone, and the next
    // sync re-creates them under the new one.
    expect(devicesLeft!.n).toBe(0);
    const [customer] = (await admin.execute(sql`
      SELECT org_id, mapping_source FROM backup_provider_customers WHERE id = ${fx.tenant.customer.id}::uuid
    `)) as unknown as Array<{ org_id: string; mapping_source: string }>;
    expect(customer).toEqual({ org_id: fx.target.id, mapping_source: 'manual' });
  });

  runDb('un-mapping stamps manual_unmapped so auto-mapping never silently re-maps it', async () => {
    const { remapCustomer } = await import('../../services/backupProviders/mapping');
    const fx = await withSystemDbAccessContext(() => seedTenant('unmap'));
    await withSystemDbAccessContext(() => remapCustomer(
      fx.customer.id, null, { userId: fx.user.id, partnerId: fx.partner.id },
    ));
    const [row] = (await (getTestDb() as typeof db).execute(sql`
      SELECT org_id, mapping_source FROM backup_provider_customers WHERE id = ${fx.customer.id}::uuid
    `)) as unknown as Array<{ org_id: string | null; mapping_source: string }>;
    expect(row).toEqual({ org_id: null, mapping_source: 'manual_unmapped' });
  });

  runDb('remapCustomer refuses a target org under a different partner, writing nothing', async () => {
    const { remapCustomer, RemapCustomerError } = await import('../../services/backupProviders/mapping');
    const fx = await seedFixture();
    await expect(withSystemDbAccessContext(() => remapCustomer(
      fx.a.customer.id, fx.b.org.id, { userId: fx.a.user.id, partnerId: fx.a.partner.id },
    ))).rejects.toBeInstanceOf(RemapCustomerError);
    const [row] = (await (getTestDb() as typeof db).execute(sql`
      SELECT org_id FROM backup_provider_customers WHERE id = ${fx.a.customer.id}::uuid
    `)) as unknown as Array<{ org_id: string }>;
    expect(row!.org_id).toBe(fx.a.org.id);
  });
});

describe('backup provider — HTTP-level FK mapping through the real router', () => {
  runDb('PUT /backup/providers/devices/:id/link answers 422, not 500, for a cross-org device', async () => {
    // A caught 23503 inside the ambient request transaction poisons it, and the
    // mapped 422 is then rethrown as a raw Internal Server Error at COMMIT.
    // Drizzle mocks cannot see that; only a real request can.
    const { Hono } = await import('hono');
    const { backupRoutes } = await import('../../routes/backup');

    const app = new Hono();
    app.route('/api/v1/backup', backupRoutes);
    const client = await createIntegrationTestClient(app, { scope: 'partner' });

    const fixture = await withSystemDbAccessContext(async () => {
      const otherOrg = await createOrganization({ partnerId: client.env.partner.id });
      const otherSite = await createSite({ orgId: otherOrg.id });
      const [otherDevice] = await (getTestDb() as typeof db).insert(devices).values({
        orgId: otherOrg.id,
        siteId: otherSite!.id,
        agentId: randomUUID(),
        hostname: `bp-other-${randomUUID().slice(0, 8)}`,
        osType: 'windows', osVersion: '11', architecture: 'x86_64',
        agentVersion: '0.0.0-test', status: 'online',
      }).returning({ id: devices.id });

      const [connection] = await db.insert(backupProviderConnections).values({
        partnerId: client.env.partner.id, provider: 'cove', name: 'Cove HTTP',
        credentialsEncrypted: 'enc:test',
      }).returning({ id: backupProviderConnections.id });
      const [customer] = await db.insert(backupProviderCustomers).values({
        connectionId: connection!.id, partnerId: client.env.partner.id,
        vendorCustomerId: 'http-1', vendorCustomerName: 'HTTP Customer',
        orgId: client.env.organization.id, mappingSource: 'manual',
      }).returning({ id: backupProviderCustomers.id });
      const [providerRow] = await db.insert(backupProviderDevices).values({
        connectionId: connection!.id, partnerId: client.env.partner.id,
        orgId: client.env.organization.id, customerId: customer!.id,
        provider: 'cove', vendorDeviceId: 'http-vd-1', vendorDeviceName: 'HTTP-SRV',
      }).returning({ id: backupProviderDevices.id });

      return { otherDevice: otherDevice!, providerRow: providerRow! };
    });

    const res = await client.put(
      `/api/v1/backup/providers/devices/${fixture.providerRow.id}/link`,
      { deviceId: fixture.otherDevice.id },
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'DEVICE_ORG_MISMATCH' });
  });
});
```

- [ ] **Step 2: Run it**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration
pnpm test-stack up   # if not already up from Task 1
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/backupProviderRls.integration.test.ts
```
Expected: 1 file, every case PASS. Two likely first-run failures and their meaning:
- `constraint_name` missing from the 23503 `cause` — postgres.js exposes it as `constraint_name`; if the driver in use spells it `constraint`, widen the matcher, do not drop the constraint-name assertion (it is what proves WHICH FK fired).
- The merge case reporting `{ moved: 0, dropped: 1 }` — the tables landed in `SPECIAL` rather than `REPOINT_TABLES` in Task 3. Fix the registry, not the expectation.

- [ ] **Step 3: Run every contract suite this wave touches, together**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration/apps/api
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/backupProviderRls.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
npx vitest run --config vitest.config.rls.ts
```
Expected: all PASS.

- [ ] **Step 4: Run the whole unit suite for the touched packages**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration
pnpm --filter @breeze/shared test --run
pnpm --filter @breeze/api test --run
```
Expected: both green. (Note the missing `--`: `pnpm --filter <pkg> test -- --run` forwards the literal `--`, vitest swallows `--run` as a positional filter, and the whole suite runs in watch mode.)

- [ ] **Step 5: Tear the stack down**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration && pnpm test-stack down
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```
Expected: the worktree's test stack is gone and the listing shows nothing this wave left behind.

- [ ] **Step 6: Commit and open the PR**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/backup-integration
git add apps/api/src/__tests__/integration/backupProviderRls.integration.test.ts
git commit -m "$(cat <<'EOF'
test(integrations): live-DB RLS, cascade, merge and org-move contract for backup providers (#6008 W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
git push -u origin feature/6008-backup-provider-integration/wave-6009
gh pr create --base main --title "feat(integrations): backup provider foundation — schema, Cove adapter, connection routes (#6008 W01)" --body "$(cat <<'EOF'
W01 of the Backup Provider Integration (Cove, phase 1).

Plan: `docs/superpowers/plans/integrations/2026-09-15-backup-provider-integration-w01-foundation.md`
Spec: `docs/superpowers/specs/integrations/2026-09-15-backup-provider-integration-cove-design.md`

Closes #6009

## What lands
- One DDL-only migration: the `external_backup_status` enum and four tables
  (`backup_provider_connections`, `_customers`, `_devices`, `_device_history`)
  with RLS enabled + forced, per-command partner-axis policies on the two
  MSP-level tables, a `FOR ALL` org-access policy on the two device-level ones,
  and every composite FK that references an `org_id` column declared
  `DEFERRABLE INITIALLY IMMEDIATE`. The device link is `(breeze_device_id,
  org_id) -> devices(id, org_id) ON DELETE SET NULL (breeze_device_id)`.
- Nine registrations: `PARTNER_TENANT_TABLES`, `ORG_AXIS_POLICY_EXCLUDED_TABLES`,
  `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY`, `REPOINT_TABLES`,
  `encryptedColumnRegistry` (row-bound AAD), the `cascadeDelete.test.ts`
  column-name contract, the `moveOrg.ts` synchronous detach, and three entries in
  `SELF_MANAGED_DB_CONTEXT_ROUTES`.
- `packages/shared`: `ExternalBackupStatus`, `deriveBackupHealth`,
  `worstBackupStatus`, `mapBackupJobStatus`, the read-model DTOs.
- `services/backupProviders/`: the adapter interface + registry, row-bound
  credential crypto, and a Cove implementation (pure column normalizers, a
  JSON-RPC client with visa chaining and all-or-nothing pagination, the adapter)
  tested against seven recorded fixtures — no live calls in CI.
- `/backup/providers/*`: connection CRUD/test/sync-now, customer listing and the
  atomic remap, provider-device listing and the manual link.

## Risk notes
- No worker runs yet: W02 adds `syncConnectionById` and the BullMQ worker to
  `jobs/backupProviderSync.ts`. Jobs enqueued by these routes wait in Redis.
- No `apps/web` change in this wave.
- Manual check before merge: one real Cove tenant end-to-end against a wt-stack
  (credentials from the owner, never committed).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Task order and dependencies

Execute in this order; each commit leaves `tsc --noEmit` green.

| # | Task | Depends on |
|---|---|---|
| 1 | Migration | — |
| 5 | Shared types + `deriveBackupHealth` | — (do this before Task 2: `backupProviders.ts` imports `ExternalBackupStatus`) |
| 2 | Drizzle schema + barrel | 1, 5 |
| 3 | The five registry/allowlist registrations | 1, 2 |
| 4 | cascadeDelete contract + moveOrg detach | 2 |
| 7 | Cove column normalizers | 5 |
| 6 | Adapter types + registry + credentials (registry test runs after 9) | 3, 5, 7 |
| 8 | Cove JSON-RPC client + fixtures | 6, 7 |
| 9 | Cove adapter; run the registry test | 6, 8 |
| 10 | `enqueueBackupProviderSync` | — |
| 11 | `alertsResolve` + `remapCustomer` | 2, 10 |
| 13 | `providerCustomers.ts` + `providerDevices.ts` | 2, 11 |
| 12 | `providerAccess.ts` + `providers.ts` + hub + self-managed registration | 2, 6, 9, 10, 11, 13 |
| 14 | `backupProviderRls.integration.test.ts` | everything |

The plan's numbering is reading order (schema → shared → vendor → routes → proof); the table is execution order. The two differ in exactly two places, both noted inline: Task 5 before Task 2, and Task 13 before Task 12.

---

## Self-review

### 1. Spec coverage — every requirement of this wave's sections maps to a task

**Data model (in full)**
- Migration named to sort after the newest committed file, idempotent, RLS in the same migration, no inner `BEGIN`/`COMMIT`, deferrable composite FKs → **Task 1** (Steps 1-5).
- `backup_provider_connections`: every column, `UNIQUE (id, partner_id)`, `UNIQUE (partner_id, provider, name)`, `INDEX (partner_id)`, the four `breeze_partner_isolation`-shaped policies → **Task 1** §2, §6; `PARTNER_TENANT_TABLES` + `encryptedColumnRegistry` (`aadBinding: 'row'`) → **Task 3**; "no `org_id`, so no org-cascade / org-merge / export-policy entry" → **Task 3** ordering facts.
- Cove credentials blob `{ partnerName, username, password }` owned by the adapter, password never returned → **Task 9** (`coveCredentialsSchema`), **Task 12** (`CONNECTION_PUBLIC_SELECT` / `hasCredentials`).
- `backup_provider_customers`: every column, all three unique indexes, three plain indexes, both composite FKs, the `huntress_org_mappings` policy block **including the `EXISTS` parent re-check** → **Task 1** §3, §6; `PARTNER_TENANT_TABLES` + `ORG_AXIS_POLICY_EXCLUDED_TABLES` + `CORE_ORG_CASCADE_DELETE_ORDER` + `CORE_TENANT_EXPORT_POLICY` + `REPOINT_TABLES` → **Task 3**.
- Atomic remap (`resolve alerts → delete devices+ledger → update mapping → enqueue sync`) → **Task 11** (`remapCustomer`), route in **Task 13**, live proof in **Task 14**.
- Auto-mapping rules are **W02** by the wave outline; W01 only guarantees `manual` / `manual_unmapped` are terminal, which **Task 11**'s comment and **Task 14**'s un-map case pin.
- `backup_provider_devices`: every column, all five indexes plus the two unique and one partial unique, all four composite FKs, the `huntress_agents` org-isolation shape → **Task 1** §4, §7. The three `breeze_device_id` consequences — the `moveOrg` detach, no device-cascade entry, the ambiguity note on the partial unique index → **Task 4** and **Task 1** §4 comments.
- `backup_provider_device_history`: every column, the unique and the org/day index, the deferrable cascade FK, "observed, not sessions" → **Task 1** §5 and **Task 2**'s docstring.
- Volume/pruning (60 days) is **W02** (the sync writes and prunes); the schema that carries it lands here.

**Normalized status and health (in full)**
- The ten-label pg enum, in order → **Task 1** §1; the matching shared tuple and the live-catalog comparison → **Task 5**, **Task 14**.
- Cove `F00` → status for every documented code, absent → `no_backups`, unrecognised → `unknown` → **Task 7**.
- Severity order for "worst of the day" → **Task 5** (`EXTERNAL_BACKUP_STATUS_SEVERITY`, `worstBackupStatus`), exhaustively tested.
- The overview's **Status** bar groups (No backups / Completed / Completed with errors / In process / Unsuccessful, where Unsuccessful = `failed + over_quota + no_selection + interrupted`) are a spec *Web UI* requirement rendered by W03 and re-rendered by W05 — but the GROUPING ITSELF is defined once here (`BACKUP_STATUS_BUCKET_IDS` / `BACKUP_STATUS_BUCKET_MEMBERS` / `bucketForBackupStatus`, **Task 5**) so the two surfaces cannot drift. Totality over the enum is asserted, so no status can vanish from a chart that still sums to 100%.
- `deriveBackupHealth` table, `recency`, `covered` (D4), the 24/48 constants → **Task 5**, with a 40-cell matrix test.
- The read model forcing `covered = false` / `health = 'unknown'` for a stale connection is **W03** (it is a read-model rule, not a property of the pure function); `BackupHealthRow.stale` is declared here so W03 has the field.
- First-party `backup_jobs.status` projection incl. `partial → completed_with_errors` → **Task 5** (`mapBackupJobStatus`).

**Provider adapter (in full)**
- The five-file layout, the `BackupProviderAdapter` / `VendorDevice` shapes → **Tasks 6-9**.
- Login once per sync, visa chaining, exactly one re-login on visa-expired, `reauth` classification never conflated → **Task 8** (`call`, `classifyVendorError`) with six dedicated cases.
- `listCustomers` = recursive `EnumeratePartners`; `listDevices` = `EnumerateAccountStatistics` at the root with the 18 columns, `RecordsCount: 1000`, looping `StartRecordNumber` until a short page, returned only when every page succeeded → **Task 8**.
- 200 ms spacing, 30 s timeout, ≤3 retries on 5xx/network, never logs credentials or visas → **Task 8** (Steps 4, 6).
- Fixture-driven tests, no live calls in CI → **Task 8** Step 1 (seven fixtures).

**Security (in full)**
- Dedicated read-only no-2FA Cove user: UI copy is **W03**; the schema comment and `coveCredentialsSchema` doc carry the contract here.
- One row-bound encrypted blob, decrypted only in the sync job and the test route, never logged, never returned → **Task 6** (`credentials.ts`), **Task 12** (`CONNECTION_PUBLIC_SELECT`, the `/test` route's decrypt).
- Partner-scope gate on every connection/customer route → **Task 12** (`providerAccess.ts`), **Task 13**.
- Org tokens see device rows through RLS only → **Task 1** §7, proved in **Task 14** ("an ORG token cannot read the partner-axis tables at all").
- Site-restricted visibility is a **W03** read-model rule (`BackupHealthRow.siteId` + the `siteIds` argument); nothing in W01 returns rows to a site-restricted surface.
- The full tenant chain enforced in the database → **Task 1** §3-§5, each leg proved in **Task 14**.
- `vendor_raw` is `excludedOpen` → **Task 3**.
- Outbound calls only to `base_url`, override must be `https://` → **Task 1** (`..._base_url_chk`), **Task 12** (`assertHttpsBaseUrl`), **Task 8** (`safeFetch` as the default `fetchImpl`).

**Routes table — every `/backup/providers/*` row**
| Spec row | Task |
|---|---|
| `GET /backup/providers/connections` | 12 |
| `POST /backup/providers/connections` | 12 |
| `PATCH /backup/providers/connections/:id` (incl. the denormalized-flag rewrite) | 12 |
| `DELETE /backup/providers/connections/:id` (resolves alerts first) | 12 |
| `POST /backup/providers/connections/:id/test` (PSA `testResult` shape) | 12 |
| `POST /backup/providers/connections/:id/sync` | 12 |
| `GET /backup/providers/connections/:id/customers` (+ unmapped counts) | 13 |
| `PUT /backup/providers/customers/:id/mapping` (atomic remap) | 13 |
| `GET /backup/providers/devices` (org or all-orgs) | 13 |
| `PUT /backup/providers/devices/:id/link` (23503 → 422) | 13 |
| `GET /backup/health` | **W03 — deliberately out of scope**, per the wave brief |

**Testing (the W01 bullets)**
- `cove/columns.ts` normalizers, every `F00` code, `I78` splitting, `I32`/`I59`, missing columns → **Task 7**.
- `deriveBackupHealth` all status × recency cells incl. `covered`; worst-of-day ordering → **Task 5**.
- Visa-expired vs rejected-credential classification; the Cove client against fixtures (pagination, visa chaining, partial-page abort) → **Task 8**.
- Route tests with Drizzle mocks for CRUD, the partner-scope gate, credential never returned, the test-connection shape, the atomic remap → **Tasks 12, 13**.
- `cascadeDelete.test.ts` Intune-style column-name case → **Task 4**.
- `migrationRlsScope.test.ts`, `autoMigrate.test.ts` → **Task 1** Step 3.
- `backupProviderRls.integration.test.ts` (cross-partner forge 42501, composite-FK 23503s, org isolation, connection-delete cascade, org erasure, org merge, device org move detaching rather than re-homing, remap) → **Task 14**.
- `rls-coverage`, `tenantCascade`, `tenant-export-policy` green → **Task 3** Step 8, **Task 14** Step 3.
- Auto-mapping rules, matching rules, alert hysteresis/dedupe, the stubbed-adapter end-to-end sync test and `eventBus.types.test.ts` are **W02** items in the spec's own Testing list (they test code W02 ships) and are deliberately not in this wave.
- "Manual before PR: one real Cove tenant end-to-end against a wt-stack" → **Task 14** Step 6 (called out in the PR body).

**Wave-outline W01 row** — schema + migration + RLS + composite FKs + all registrations (org cascade, export policy, org-merge repoint, encrypted column, RLS allowlists, cascadeDelete column-name test, moveOrg detach) ✔ Tasks 1-4; shared status enum + `deriveBackupHealth` ✔ Task 5; adapter interface + registry ✔ Task 6; Cove client/adapter/columns with fixtures ✔ Tasks 7-9; connection CRUD/test/sync-now routes ✔ Task 12; customer mapping routes with atomic remap ✔ Tasks 11, 13.

### 2. Placeholder scan

No occurrence of "TBD", "TODO", "implement later", "add appropriate error handling", "add validation", "write tests for the above", or "similar to Task N". Every code step contains the complete file or the complete inserted block, including every SQL statement, every Zod schema, every Hono handler and every fixture body. The only forward references are to **W02**, and each names the exact symbol W02 adds and the file it adds it to.

### 3. Type consistency

- Every name in the plan index's "Cross-wave names that must not drift" appears with its index spelling: the four tables and their Drizzle exports, `externalBackupStatusEnum`, the ten enum labels, `EXTERNAL_BACKUP_STATUSES`, `ExternalBackupStatus`, `BackupHealth`, `BackupRecency`, `BACKUP_WARNING_AFTER_HOURS`, `BACKUP_CRITICAL_AFTER_HOURS`, `deriveBackupHealth`, `EXTERNAL_BACKUP_STATUS_SEVERITY`, `worstBackupStatus`, `mapBackupJobStatus`, `BackupHealthRow`, `BackupHealthSummary`, `BackupProviderAlertCondition`, `BackupProviderAdapter`, `VendorCustomer`, `VendorDevice`, `ProviderRequestError`, `ProviderTestResult`, `BACKUP_PROVIDER_KEYS`, `BackupProviderKey`, `getBackupProvider`, `encryptProviderCredentials`, `decryptProviderCredentials`, `COVE_STATISTIC_COLUMNS`, `parseCoveSettings`, `mapCoveSessionStatus`, `mapCoveOsType`, `mapCoveAccountType`, `parseCoveDataSources`, `coveRowToVendorDevice`, `CoveJsonRpcClient` (with `login` / `call` / `enumeratePartners` / `enumerateAccountStatisticsAll`), `coveCredentialsSchema`, `coveAdapter`, `enqueueBackupProviderSync`, `remapCustomer`, `BACKUP_PROVIDER_ALERT_SOURCE`, the queue name `backup-provider-sync`, the job name `sync-connection`, the job id `backup-provider-sync-${connectionId}`, and all eight route paths.
- Four names are **additions beyond** the plan index, not drift from it: `BACKUP_STATUS_BUCKET_IDS`, `BackupStatusBucketId`, `BACKUP_STATUS_BUCKET_MEMBERS` and `bucketForBackupStatus` (Task 5). They define the spec's overview Status grouping once, in `packages/shared`, so W03's `BackupHealthOverview.tsx` and W05's report renderer consume the same "Unsuccessful = failed + over_quota + no_selection + interrupted" rule instead of each carrying a copy. W03 and W05 must import them rather than re-deriving; the index's "Shared" heading should gain them when it is next touched.
- Two index signatures are widened, both marked **DECISION** and both source-compatible: `enqueueBackupProviderSync` returns `Promise<string>` (Task 10) and `remapCustomer` returns `Promise<RemapCustomerResult>` (Task 11).
- The column-name contract holds end to end: `breeze_device_id` in the migration, the Drizzle field `breezeDeviceId`, the `cascadeDelete.test.ts` assertion, the `moveOrg.ts` statement, the `providerDevices.ts` route and the integration test all spell it the same way, and two tests fail if it is ever renamed to `device_id`.
- Every function a step calls is defined by an earlier task, listed in the plan index, or cited at a `path:line` verified by reading the file.
