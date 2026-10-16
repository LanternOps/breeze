---
tracking_issue: LanternOps/breeze#8164
---
# EDR W01 — Framework core + Bitdefender GravityZone read path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the five `edr_*` tables with every tenancy registration, the provider-neutral EDR
framework, the `edr-provider-sync` worker, the partner-admin `/edr` routes and the GravityZone
adapter read side, so an MSP can connect a GravityZone partner key, map companies to orgs, and
have endpoints linked to Breeze devices and detections persisted.

**Architecture:** A copy of the backup-provider framework's *shape* (#6008: open `provider`
varchar, adapter interface + registry, row-bound encrypted credentials, three-phase sync that holds
no DB connection across vendor HTTP), widened where EDR differs: per-tenant fetch isolation,
two sync streams (inventory, detections) under one vendor request budget, error scope
(`connection | tenant | operation`), D13 tombstones and the `breeze_device_id` link column.
Pure logic (mapping, device matching, normalization, scheduling) is extracted or written as pure
functions with unit tests; everything tenancy-shaped is proven against real Postgres.

**Tech Stack:** Hono, Drizzle (queries only), hand-written idempotent SQL migration, PostgreSQL
RLS, BullMQ + Redis, Vitest (unit + integration), `safeFetch` / `checkSsrfSafe`, GravityZone
JSON-RPC 2.0 over HTTPS.

**Spec:** `docs/superpowers/specs/integrations/2026-09-30-edr-provider-framework-spec.md`
(approved 2026-10-01; re-sequenced the same day: GravityZone is the first adapter). Read the
**index** first: `docs/superpowers/plans/integrations/2026-10-01-edr-provider-framework-index.md`
— its "Spec corrections" 1–5, 7–9, 11 and 12 are applied by this plan and override the spec where they differ.

**Reference implementation to mirror (read before starting each task that names it):**

| New file | Mirror |
|---|---|
| `migrations/<ts>-edr-provider-framework.sql` | `migrations/2026-10-26-120000-backup-provider-integration.sql` (header discipline, `DO $$` guards, FK forms, RLS blocks) |
| `db/schema/edrProviders.ts` | `db/schema/backupProviders.ts` (FK declarations; the column-list SET NULL FK is **not** declared) |
| `services/edrProviders/types.ts`, `registry.ts` | `services/backupProviders/types.ts`, `registry.ts` |
| `services/edrProviders/credentials.ts` | `services/backupProviders/credentials.ts` |
| `services/edrProviders/persist.ts` | `services/backupProviders/persist.ts` |
| `services/edrProviders/mapping.ts` | `services/backupProviders/mapping.ts` (`remapCustomer`, `autoMapCustomers`) |
| `services/edrProviders/deviceMatching.ts` | `services/backupProviders/deviceMatching.ts` (`matchProviderDevices`) |
| `services/edrProviders/bitdefender/client.ts` | `services/backupProviders/cove/client.ts` (JSON-RPC transport, error classification, page cap) |
| `jobs/edrProviderSync.ts` | `jobs/backupProviderSync.ts` (queue, enqueue helper, phases 1–3, reauth marker, worker) |
| `routes/edr/access.ts` | `routes/backup/providerAccess.ts` |
| `routes/edr/connections.ts` | `routes/backup/providers.ts` |
| `routes/edr/tenants.ts`, `endpoints.ts` | `routes/backup/providerCustomers.ts`, `providerDevices.ts` |
| `__tests__/integration/edrProviderRls.integration.test.ts` | `__tests__/integration/backupProviderRls.integration.test.ts` |
| `__tests__/integration/edrProviderSync.integration.test.ts` | `__tests__/integration/backupProviderSync.integration.test.ts` |

All paths below are relative to the repo root unless they start with `src/` (= `apps/api/src/`).

## Global Constraints

- Every tenant-scoped table: RLS **enabled + forced + policies in the same migration**; no app-layer-only fallback.
- Every composite FK whose referenced columns include `org_id` (or `(org_id, partner_id)` on `organizations`) is `DEFERRABLE INITIALLY IMMEDIATE`.
- The Breeze device link column is named `breeze_device_id`, never `device_id`; its FK is `ON DELETE SET NULL (breeze_device_id)` (PG15 column-list form), migration-only, not declared in Drizzle.
- Migration is idempotent (`IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`, `DROP POLICY IF EXISTS` + `CREATE`), no inner `BEGIN/COMMIT`, DDL only → **no** `set_config('breeze.scope','system',true)` and **not** added to the `migrationRlsScope.test.ts` baseline.
- Migration filename sorts after the newest migration **committed on `origin/main` at implementation time** (at plan time — after the 2026-10-01 rebase — the newest is `2026-11-13-100100-ai-platform-models-seed.sql`; a `2026-11-13-100000-edr-…` name would have sorted **between** `100000-ai-…` and `100100-…`, which is exactly the trap; open PR #7634 adds `2026-11-12-120000-…`). Planned name: `2026-11-14-100000-edr-provider-framework.sql`; re-check with `git fetch -q origin main && git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -3` before committing and again before pushing (the pre-push hook re-checks against `origin/main`).
- Normalized value sets are `CHECK` constraints on `varchar` (D12), mirrored by tuples in `packages/shared/src/types/edr.ts`; an unknown vendor value maps to `unknown`, never throws.
- No pooled DB connection is held across vendor HTTP (#1105/#1896): vendor calls run under `runOutsideDbContext`; writes run in a fresh `withSystemDbAccessContext` transaction. Enqueues from a request path run under `runOutsideDbContext`.
- Every vendor request goes through the adapter's host allowlist + `safeFetch` (`src/services/urlSafety.ts`). GravityZone allowlist: `['.gravityzone.bitdefender.com']`.
- Credentials and secrets are encrypted with **row-bound AAD** (`aadBinding: 'row'`); no route ever selects or returns a `*_encrypted` column.
- Partner-axis reads: org scope → 403 (`resolveEdrPartnerId`). **Every write** additionally requires `canManagePartnerWidePolicies` (`requireEdrPartnerAdmin`), plus `requireMfa()`.
- Unmapped tenants' endpoints are counted, never stored (D5). Detections of unmapped tenants are not fetched.
- Detections are never deleted by sync; a vendor tenant absent from `listTenants` is tombstoned (`vendor_missing_since`), never hard-deleted (D13). Its endpoints are deleted after 7 days missing.
- W01 builds only what GravityZone exercises (D1 caveat): no token cache (API-key auth), no serial tiebreak, no webhook route, no actions dispatch. Optional interface members for those exist as types only.
- Recorded fixtures only in CI; no live vendor HTTP in any test.

## Review Focus

1. **A partial vendor enumeration must never read as "gone".** A GravityZone page failure halfway through a company's endpoint list (or through the company list) must throw `EdrProviderRequestError` and leave that company's rows untouched — never delete the endpoints that were on the unfetched pages. Pinned in Task 11 (client: page 2 fails → throws) and Task 13 (persist: a tenant marked failed keeps its endpoints).
2. **Remap must not drag history into the new org.** After `PUT /edr/tenants/:id/mapping` moves a company from org A to org B, the next sync that re-fetches the same vendor detection must create a new row in org B and leave the tombstone in org A with `detached_at` set. Pinned in Task 14 (integration).
3. **One bad company must not disable the partner connection.** A JSON-RPC permission error on one company's call is `scope: 'tenant'`: that tenant's `last_*_sync_status = 'error'`, the connection stays `connected`, other companies sync. Only an auth failure on the key itself (HTTP 401 / auth error code) flips the connection to `reauth_required`. Pinned in Task 11 + Task 15.
4. **A vendor-supplied or operator-supplied host outside the allowlist is refused before any socket opens** — including `https://evil.example/?x=.gravityzone.bitdefender.com`, `https://cloud.gravityzone.bitdefender.com.evil.example`, an `http://` Access URL, and a host that resolves to a private IP. Pinned in Task 10.
5. **A selected-org partner technician cannot write.** A partner user with `org_access = 'selected'` gets 403 on every write route (create/patch/delete/test/sync connection, map/unmap tenant) even though they can read the connection card. Pinned in Tasks 16–17.

---

## File Structure

**W01a — tenancy foundation (PR 1)**

- Create `packages/shared/src/types/edr.ts` — normalized tuples + types (`EDR_SEVERITIES`, `EDR_DETECTION_STATUSES`, `EDR_ENDPOINT_HEALTH`, `EDR_ISOLATION_STATES`, `EDR_OS_PLATFORMS`, `EDR_ENDPOINT_TYPES`, `EDR_MAPPING_SOURCES`, `EDR_DEVICE_MATCH_SOURCES`, `EDR_ACTION_STATUSES`, `EDR_ACTION_REQUESTED_VIA`, `EDR_CONNECTION_STATUSES`, `EDR_SYNC_STATUSES`, `EDR_ACTIONS`, `EDR_VENDOR_KINDS`).
- Modify `packages/shared/src/types/index.ts` — `export * from './edr';`.
- Create `apps/api/migrations/2026-11-14-100000-edr-provider-framework.sql`.
- Create `src/db/schema/edrProviders.ts`; modify `src/db/schema/index.ts` (barrel export).
- Modify registrations: `src/services/tenantCascade.ts`, `src/services/orgMergeRegistry.ts`, `src/services/tenantExportPolicyRegistry.ts`, `src/services/encryptedColumnRegistry.ts`, `src/__tests__/integration/rls-coverage.integration.test.ts`, `src/routes/devices/cascadeDelete.test.ts`.
- Modify `src/services/deviceOrgMove/moveDeviceOrgInTransaction.ts` + `src/routes/devices/moveOrg.test.ts`.
- Create `src/__tests__/integration/edrProviderRls.integration.test.ts`.

**W01b — framework + adapter (PR 2, stacked on W01a until it merges)**

- Create `src/services/externalTenantMapping.ts` (+ `.test.ts`) — pure auto-map / name-suggestion functions moved out of `backupProviders/mapping.ts`.
- Create `src/services/externalDeviceMatching/resolve.ts` (+ `.test.ts`), `candidates.ts`, `index.ts` — pure matcher (+ FQDN short-name rule) and the shared candidate-device loader.
- Modify `src/services/backupProviders/mapping.ts`, `deviceMatching.ts` — import from the extracted modules (re-export the old names; no behaviour change).
- Create `src/services/edrProviders/{types,registry,normalize,credentials,guardedFetch,rateLimiter,scheduler,persist,mapping,deviceMatching}.ts` (+ tests).
- Create `src/services/edrProviders/bitdefender/{client,adapter,normalize}.ts` (+ tests) and `__fixtures__/*.json`.
- Create `src/jobs/edrProviderSync.ts` (+ `.test.ts`).
- Create `src/routes/edr/{index,access,providers,connections,tenants,endpoints}.ts` (+ tests); modify `src/index.ts` (mount `/edr`).
- Modify contract registrations: `src/services/workerRegistry.ts`, `src/services/workerRegistry.test.ts`, `src/services/workerEntrypointClosure.contract.test.ts`, `src/jobs/workerReadinessManifest.ts`, `src/services/mcpCoverage.ts`, `src/middleware/selfManagedDbContextRoutes.ts`, `src/__tests__/partner-wide-write-coverage.test.ts`, `src/__tests__/integrationOrgTargetHoldingOrg.contract.test.ts`, `src/__tests__/parkedFanoutModules.ts`, `src/__tests__/parkedFanout.contract.test.ts`, `src/services/logRedaction.test.ts`.
- Create `src/__tests__/integration/edrProviderSync.integration.test.ts`.

**Registration checklist (W01 touches every one of these — grep each before opening a PR):**

| # | List / file | Entry | Fails in |
|---|---|---|---|
| 1 | `CORE_ORG_CASCADE_DELETE_ORDER` (`src/services/tenantCascade.ts`) | `edr_actions`, `edr_detections`, `edr_endpoints`, `edr_tenants` (between `dr_plans` and `elevation_audit`) | Integration Tests |
| 2 | `REPOINT_TABLES` (`src/services/orgMergeRegistry.ts`) | same four, plain `repoint` | full Test API (`orgMerge.test.ts`) + Integration Tests |
| 3 | `CORE_TENANT_EXPORT_POLICY` (`src/services/tenantExportPolicyRegistry.ts`) | four `tablePolicy('org_id', …)` rows, every column bucketed | Integration Tests (×2 suites) |
| 4 | `PARTNER_TENANT_TABLES` (`rls-coverage.integration.test.ts`) | `['edr_connections','partner_id']`, `['edr_tenants','partner_id']` | `test:rls-coverage` |
| 5 | `ORG_AXIS_POLICY_EXCLUDED_TABLES` (same file) | `edr_tenants` (dual-list trap) | `test:rls-coverage` |
| 6 | `encryptedColumnRegistry` (`src/services/encryptedColumnRegistry.ts`) | `edr_connections.credentials_encrypted`, `edr_connections.webhook_secret_encrypted`, `edr_tenants.installer_secret_encrypted` — all `aadBinding: 'row'` | Test API |
| 7 | `cascadeDelete.test.ts` | contract case: the three org tables carry `breeze_device_id`, no `device_id`, and are in none of the device lists | Test API |
| 8 | `moveDeviceOrgInTransaction.ts` + `moveOrg.test.ts`; `deviceDeletion.ts` | three detach statements (indices 9–12 shift to 12–15); D14 snapshot before device hard delete | Test API |
| 9 | `WORKER_REGISTRY` (`src/services/workerRegistry.ts`) + `EXPECTED_WORKER_NAMES` (`workerRegistry.test.ts`, ordered + counted) + `EXPECTED_NAMES` (`workerEntrypointClosure.contract.test.ts`) + `consumers('edrProviderSyncWorker')` (`src/jobs/workerReadinessManifest.ts`) | `edrProviderSyncWorker`, `placement: 'global'`, right after `backupProviderSyncWorker` | Test API |
| 10 | `MCP_COVERAGE` (`src/services/mcpCoverage.ts`) | `edr/connections.ts`, `edr/tenants.ts`, `edr/endpoints.ts`, `edr/providers.ts` → `{ exempt: 'vendor_console_admin', note }`. **No** entry for `edr/index.ts`: the test only enumerates files that register routes (`.get('…`), and an entry for a hub that only calls `.route()` fails "entries for files that register no routes" | Test API (`mcp-coverage.test.ts`) |
| 11 | `SELF_MANAGED_DB_CONTEXT_ROUTES` (`src/middleware/selfManagedDbContextRoutes.ts`) | `POST /edr/connections`, `PATCH /edr/connections/:id`, `POST /edr/connections/:id/test` | Test API tripwire / runtime |
| 12 | `ALLOWED_WITHOUT_CAPABILITY_CHECK` (`partner-wide-write-coverage.test.ts`) | one reasoned entry per file the test reports as a partner-axis (`edr_connections` / `edr_tenants`) writer that does not itself mention `canManagePartnerWidePolicies` — expected: `routes/edr/connections.ts` (gate via `requireEdrPartnerAdmin`), `services/edrProviders/mapping.ts` (sole caller behind that gate), `services/edrProviders/persist.ts` (worker-only, connection's own `partner_id`). **No** entry for `routes/edr/tenants.ts` (it delegates to the service and mutates nothing itself; a non-mutating entry fails the stale-entry check) | Test API |
| 13 | `ORG_TARGET_WRITERS` (`integrationOrgTargetHoldingOrg.contract.test.ts`) | `services/edrProviders/mapping.ts` | Test API |
| 14 | `FANOUT_MODULES` (`src/__tests__/parkedFanoutModules.ts`) | `services/externalDeviceMatching/candidates.ts` `{ guards: 1 }` and `services/edrProviders/deviceMatching.ts` (guard count as the test reports); **remove** nothing — backup's `deviceMatching.ts` keeps its own loader | Test API |
| 15 | `VISIBILITY_MODULES` (`parkedFanout.contract.test.ts`) | `services/edrProviders/mapping.ts` (uses `notHiddenOrgType`) | Test API |
| 16 | `src/db/schema/index.ts` barrel | `export * from './edrProviders';` | tsc |
| 17 | `src/index.ts` | `api.route('/edr', edrRoutes);` | — |

**Not applicable — do not add** (spec §5.7): `CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (no `device_id`), `TICKET_ORG_DENORMALIZED_TABLES` / `CUSTOM_ORG_REWRITE_TABLES` (no `ticket_id`), `AUDIT_ADMIN_REQUIRED_TABLES` (not append-only), `DUAL_AXIS_TENANT_TABLES` / partner-wide SELECT branch (partner-only credentials, Cove precedent), `jobs/intentReleaseWorker.ts` (no `edr_actions` writer until W03).

---

## Task 1: Shared normalized tuples

**Files:**
- Create: `packages/shared/src/types/edr.ts`
- Create: `packages/shared/src/types/edr.test.ts`
- Modify: `packages/shared/src/types/index.ts`

**Interfaces:**
- Produces: the tuples below and their `(typeof X)[number]` types, imported as `@breeze/shared` by the API schema, migration test and adapters.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/types/edr.test.ts
import { describe, expect, it } from 'vitest';
import {
  EDR_ACTIONS, EDR_DETECTION_STATUSES, EDR_SEVERITIES, EDR_ENDPOINT_HEALTH,
  EDR_ISOLATION_STATES, EDR_MAPPING_SOURCES,
} from './edr';

describe('EDR normalized tuples', () => {
  it('every set that buckets vendor values carries an unknown bucket', () => {
    for (const set of [EDR_SEVERITIES, EDR_DETECTION_STATUSES, EDR_ENDPOINT_HEALTH, EDR_ISOLATION_STATES]) {
      expect(set).toContain('unknown');
    }
  });
  it('mapping sources never include an automatic name match (spec §4.5)', () => {
    expect(EDR_MAPPING_SOURCES).toEqual(['manual', 'auto_external_code', 'manual_unmapped']);
  });
  it('action keys are the spec §4.3 set, in order', () => {
    expect(EDR_ACTIONS).toEqual([
      'isolate', 'unisolate', 'scan', 'update_agent', 'kill_process', 'rollback',
      'resolve_detection', 'mark_false_positive', 'quarantine_restore', 'quarantine_delete',
    ]);
  });
  it('has no duplicates in any tuple', () => {
    for (const set of [EDR_SEVERITIES, EDR_DETECTION_STATUSES, EDR_ACTIONS]) {
      expect(new Set(set).size).toBe(set.length);
    }
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module not found)**

Run: `cd packages/shared && npx vitest run src/types/edr.test.ts`

- [ ] **Step 3: Implement**

```ts
// packages/shared/src/types/edr.ts
/** Normalized EDR value sets. Each is mirrored by a CHECK constraint in
 *  apps/api/migrations/<ts>-edr-provider-framework.sql; edrProviderRls.integration.test.ts
 *  compares the two. Extend both together (drop/re-add the CHECK in a new migration). */
export const EDR_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info', 'unknown'] as const;
export const EDR_DETECTION_STATUSES = [
  'open', 'in_progress', 'mitigated', 'resolved', 'false_positive', 'dismissed', 'unknown',
] as const;
/** Statuses that count as "still open" for denormalized-link rewrites and the feed. */
export const EDR_OPEN_DETECTION_STATUSES = ['open', 'in_progress', 'unknown'] as const;
export const EDR_ENDPOINT_HEALTH = ['healthy', 'degraded', 'unhealthy', 'unknown'] as const;
export const EDR_ISOLATION_STATES = ['isolated', 'not_isolated', 'pending', 'unknown'] as const;
export const EDR_OS_PLATFORMS = ['windows', 'macos', 'linux', 'other'] as const;
export const EDR_ENDPOINT_TYPES = ['workstation', 'server', 'mobile', 'unknown'] as const;
export const EDR_MAPPING_SOURCES = ['manual', 'auto_external_code', 'manual_unmapped'] as const;
export const EDR_DEVICE_MATCH_SOURCES = ['auto_hostname', 'auto_mac', 'auto_serial', 'manual'] as const;
export const EDR_CONNECTION_STATUSES = ['connected', 'error', 'reauth_required'] as const;
export const EDR_SYNC_STATUSES = ['running', 'success', 'partial', 'error'] as const;
export const EDR_ACTION_STATUSES = ['queued', 'submitted', 'succeeded', 'failed'] as const;
export const EDR_ACTION_REQUESTED_VIA = ['ui', 'ai', 'automation', 'api'] as const;
export const EDR_VENDOR_KINDS = ['alert', 'detection', 'threat', 'incident', 'quarantine_item'] as const;
export const EDR_ACTIONS = [
  'isolate', 'unisolate', 'scan', 'update_agent', 'kill_process', 'rollback',
  'resolve_detection', 'mark_false_positive', 'quarantine_restore', 'quarantine_delete',
] as const;

export type EdrSeverity = (typeof EDR_SEVERITIES)[number];
export type EdrDetectionStatus = (typeof EDR_DETECTION_STATUSES)[number];
export type EdrEndpointHealth = (typeof EDR_ENDPOINT_HEALTH)[number];
export type EdrIsolationState = (typeof EDR_ISOLATION_STATES)[number];
export type EdrOsPlatform = (typeof EDR_OS_PLATFORMS)[number];
export type EdrEndpointType = (typeof EDR_ENDPOINT_TYPES)[number];
export type EdrMappingSource = (typeof EDR_MAPPING_SOURCES)[number];
export type EdrDeviceMatchSource = (typeof EDR_DEVICE_MATCH_SOURCES)[number];
export type EdrConnectionStatus = (typeof EDR_CONNECTION_STATUSES)[number];
export type EdrSyncStatus = (typeof EDR_SYNC_STATUSES)[number];
export type EdrActionStatus = (typeof EDR_ACTION_STATUSES)[number];
export type EdrActionRequestedVia = (typeof EDR_ACTION_REQUESTED_VIA)[number];
export type EdrVendorKind = (typeof EDR_VENDOR_KINDS)[number];
export type EdrActionKey = (typeof EDR_ACTIONS)[number];
```

Add `export * from './edr';` to `packages/shared/src/types/index.ts` (next to `./backupHealth`).

- [ ] **Step 4: Run it — expect PASS**; then `pnpm --filter @breeze/shared build` (the API consumes the built package in some configs; check `tsc` resolves `@breeze/shared` from `apps/api`).

- [ ] **Step 5: Commit** — `git add packages/shared/src/types/edr.ts packages/shared/src/types/edr.test.ts packages/shared/src/types/index.ts && git commit -m "feat(shared): EDR normalized value tuples (#3136)"`

---

## Task 2: Migration — five tables, constraints, RLS

**Files:**
- Create: `apps/api/migrations/2026-11-14-100000-edr-provider-framework.sql` (name re-checked per Global Constraints)

**Interfaces:**
- Produces: tables `edr_connections`, `edr_tenants`, `edr_endpoints`, `edr_detections`, `edr_actions` with the exact column names used by Task 3's Drizzle schema and everything after.

- [ ] **Step 1: Write the failing test (naming/ordering guard)**

The repo's guards are the test here. Before writing SQL run:

```bash
git fetch -q origin main && git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -3
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```

Expected now: PASS (baseline). After creating an empty file with a wrong prefix (e.g. `2026-10-01-…`) `scripts/check-migration-naming.sh` must fail — confirm once, then use the correct name.

- [ ] **Step 2: Write the migration**

Header comment block: copy the structure of the backup migration header and state, for each table, its shape (spec §5 table), the tenant chain, the deferrable rule, the `breeze_device_id` rationale, the column-list SET NULL rationale (#4100), `created_by`/`requested_by` SET NULL rationale, "DDL ONLY — no set_config, not in the migrationRlsScope baseline", unguarded GRANTs, and **the two D13 corrections** (nullable `tenant_id` on detections/actions; partial unique index on `detached_at IS NULL`).

```sql
-- 1. edr_connections — shape 3 (partner axis), no org_id
CREATE TABLE IF NOT EXISTS edr_connections (
  id                                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id                           uuid NOT NULL REFERENCES partners(id),
  provider                             varchar(30) NOT NULL,          -- validated by the registry, not an enum
  name                                 varchar(200) NOT NULL,
  base_url                             varchar(300),                  -- GravityZone Access URL; per-adapter allowlist
  region                               varchar(40),
  credentials_encrypted                text NOT NULL,                 -- row-bound AAD
  webhook_secret_encrypted             text,                          -- row-bound AAD; unused until W03
  vendor_root_id                       varchar(128),
  vendor_root_name                     varchar(255),
  vendor_root_type                     varchar(40),                   -- index correction 4
  is_active                            boolean NOT NULL DEFAULT true,
  status                               varchar(20) NOT NULL DEFAULT 'connected',
  detection_interval_minutes           integer,                       -- NULL = adapter default
  inventory_interval_minutes           integer,
  effective_detection_interval_minutes integer,                       -- written by the scheduler
  effective_inventory_interval_minutes integer,
  last_inventory_sync_at               timestamptz,
  last_inventory_sync_status           varchar(20),
  last_inventory_sync_error            text,
  last_detection_sync_at               timestamptz,
  last_detection_sync_status           varchar(20),
  last_detection_sync_error            text,
  last_sync_tenants                    integer,
  last_sync_unmapped_tenants           integer,
  last_sync_failed_tenants             integer,
  last_sync_endpoints                  integer,
  last_sync_linked_endpoints           integer,
  last_sync_ambiguous_endpoints        integer,
  last_sync_open_detections            integer,
  capabilities_snapshot                text[] NOT NULL DEFAULT '{}',
  created_by                           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                           timestamptz NOT NULL DEFAULT now(),
  updated_at                           timestamptz NOT NULL DEFAULT now()
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_connections_status_chk' AND conrelid = 'edr_connections'::regclass) THEN
    ALTER TABLE edr_connections ADD CONSTRAINT edr_connections_status_chk
      CHECK (status IN ('connected', 'error', 'reauth_required'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_connections_sync_status_chk' AND conrelid = 'edr_connections'::regclass) THEN
    ALTER TABLE edr_connections ADD CONSTRAINT edr_connections_sync_status_chk CHECK (
      (last_inventory_sync_status IS NULL OR last_inventory_sync_status IN ('running','success','partial','error'))
      AND (last_detection_sync_status IS NULL OR last_detection_sync_status IN ('running','success','partial','error')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_connections_base_url_chk' AND conrelid = 'edr_connections'::regclass) THEN
    ALTER TABLE edr_connections ADD CONSTRAINT edr_connections_base_url_chk
      CHECK (base_url IS NULL OR base_url LIKE 'https://%');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_connections_intervals_chk' AND conrelid = 'edr_connections'::regclass) THEN
    ALTER TABLE edr_connections ADD CONSTRAINT edr_connections_intervals_chk CHECK (
      (detection_interval_minutes IS NULL OR detection_interval_minutes BETWEEN 5 AND 1440)
      AND (inventory_interval_minutes IS NULL OR inventory_interval_minutes BETWEEN 5 AND 1440));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS edr_connections_id_partner_uniq ON edr_connections (id, partner_id);
CREATE UNIQUE INDEX IF NOT EXISTS edr_connections_partner_provider_name_uniq ON edr_connections (partner_id, provider, name);
CREATE INDEX IF NOT EXISTS edr_connections_partner_idx ON edr_connections (partner_id);

-- 2. edr_tenants — shape 3 + nullable org_id mapping target
CREATE TABLE IF NOT EXISTS edr_tenants (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id               uuid NOT NULL,
  partner_id                  uuid NOT NULL REFERENCES partners(id),
  vendor_tenant_id            varchar(128) NOT NULL,
  vendor_tenant_name          varchar(255) NOT NULL,
  vendor_parent_id            varchar(128),
  vendor_tenant_type          varchar(40),
  vendor_external_code        varchar(255),
  api_host                    varchar(300),
  org_id                      uuid REFERENCES organizations(id) ON DELETE SET NULL,
  mapping_source              varchar(20),
  installer_secret_encrypted  text,
  endpoint_count              integer NOT NULL DEFAULT 0,
  open_detection_count        integer NOT NULL DEFAULT 0,
  last_seen_at                timestamptz,
  vendor_missing_since        timestamptz,
  last_inventory_sync_at      timestamptz,
  last_inventory_sync_status  varchar(20),
  last_inventory_sync_error   text,
  last_detection_sync_at      timestamptz,
  last_detection_sync_status  varchar(20),
  last_detection_sync_error   text,
  detection_cursor            text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_tenants_mapping_source_chk' AND conrelid = 'edr_tenants'::regclass) THEN
    ALTER TABLE edr_tenants ADD CONSTRAINT edr_tenants_mapping_source_chk
      CHECK (mapping_source IS NULL OR mapping_source IN ('manual', 'auto_external_code', 'manual_unmapped'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_tenants_sync_status_chk' AND conrelid = 'edr_tenants'::regclass) THEN
    ALTER TABLE edr_tenants ADD CONSTRAINT edr_tenants_sync_status_chk CHECK (
      (last_inventory_sync_status IS NULL OR last_inventory_sync_status IN ('running','success','partial','error'))
      AND (last_detection_sync_status IS NULL OR last_detection_sync_status IN ('running','success','partial','error')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edr_tenants_api_host_chk' AND conrelid = 'edr_tenants'::regclass) THEN
    ALTER TABLE edr_tenants ADD CONSTRAINT edr_tenants_api_host_chk CHECK (api_host IS NULL OR api_host LIKE 'https://%');
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS edr_tenants_connection_vendor_uniq ON edr_tenants (connection_id, vendor_tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS edr_tenants_id_connection_uniq ON edr_tenants (id, connection_id);
CREATE UNIQUE INDEX IF NOT EXISTS edr_tenants_id_org_uniq ON edr_tenants (id, org_id);
CREATE INDEX IF NOT EXISTS edr_tenants_org_idx ON edr_tenants (org_id);
CREATE INDEX IF NOT EXISTS edr_tenants_partner_idx ON edr_tenants (partner_id);
CREATE INDEX IF NOT EXISTS edr_tenants_connection_idx ON edr_tenants (connection_id);
DO $$ BEGIN
  ALTER TABLE edr_tenants ADD CONSTRAINT edr_tenants_connection_partner_fk
    FOREIGN KEY (connection_id, partner_id) REFERENCES edr_connections(id, partner_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE edr_tenants ADD CONSTRAINT edr_tenants_org_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. edr_endpoints — shape 1 (org_id NOT NULL); only under MAPPED tenants (D5)
CREATE TABLE IF NOT EXISTS edr_endpoints (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id        uuid NOT NULL,
  partner_id           uuid NOT NULL REFERENCES partners(id),
  org_id               uuid NOT NULL REFERENCES organizations(id),
  tenant_id            uuid NOT NULL,
  provider             varchar(30) NOT NULL,
  vendor_endpoint_id   varchar(128) NOT NULL,
  hostname             varchar(255),
  fqdn                 varchar(255),
  serial_number        varchar(128),
  mac_addresses        text[] NOT NULL DEFAULT '{}',
  ip_addresses         text[] NOT NULL DEFAULT '{}',
  os_platform          varchar(20) NOT NULL DEFAULT 'other',
  os_name              varchar(255),
  endpoint_type        varchar(20) NOT NULL DEFAULT 'unknown',
  agent_version        varchar(64),
  health               varchar(20) NOT NULL DEFAULT 'unknown',
  online               boolean,
  isolation_state      varchar(20) NOT NULL DEFAULT 'unknown',
  tamper_protection    boolean,
  policy_name          varchar(255),
  last_seen_at         timestamptz,
  vendor_detail_synced_at timestamptz,             -- per-endpoint detail enrichment (GravityZone getManagedEndpointDetails), oldest first
  breeze_device_id     uuid,                       -- LINK, never rename to device_id
  device_match_source  varchar(20),
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  vendor_raw           jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
-- CHECKs: os_platform, endpoint_type, health, isolation_state, device_match_source (values = Task 1 tuples),
-- written as individual IF NOT EXISTS blocks exactly like the ones above.
CREATE UNIQUE INDEX IF NOT EXISTS edr_endpoints_connection_vendor_uniq ON edr_endpoints (connection_id, vendor_endpoint_id);
CREATE UNIQUE INDEX IF NOT EXISTS edr_endpoints_id_org_uniq ON edr_endpoints (id, org_id);
-- Per CONNECTION, not global: a device may legitimately run two protection products (spec §4.2).
CREATE UNIQUE INDEX IF NOT EXISTS edr_endpoints_connection_breeze_device_uniq
  ON edr_endpoints (connection_id, breeze_device_id) WHERE breeze_device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS edr_endpoints_org_breeze_device_idx ON edr_endpoints (org_id, breeze_device_id);
CREATE INDEX IF NOT EXISTS edr_endpoints_tenant_idx ON edr_endpoints (tenant_id);
CREATE INDEX IF NOT EXISTS edr_endpoints_partner_health_idx ON edr_endpoints (partner_id, health);
-- FKs: (connection_id, partner_id) -> edr_connections ON DELETE CASCADE;
--      (tenant_id, connection_id) -> edr_tenants(id, connection_id) ON DELETE CASCADE;
--      (tenant_id, org_id) -> edr_tenants(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
--      (breeze_device_id, org_id) -> devices(id, org_id) ON DELETE SET NULL (breeze_device_id) DEFERRABLE INITIALLY IMMEDIATE;
--      (org_id, partner_id) -> organizations(id, partner_id) DEFERRABLE INITIALLY IMMEDIATE;
-- each in its own `DO $$ BEGIN ALTER TABLE … EXCEPTION WHEN duplicate_object THEN NULL; END $$;`
-- named edr_endpoints_connection_partner_fk / _tenant_connection_fk / _tenant_org_fk / _breeze_device_org_fk / _org_partner_fk.

-- 4. edr_detections — shape 1
CREATE TABLE IF NOT EXISTS edr_detections (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id          uuid NOT NULL,
  partner_id             uuid NOT NULL REFERENCES partners(id),
  org_id                 uuid NOT NULL REFERENCES organizations(id),
  tenant_id              uuid,                     -- NULL once tombstoned (index correction 1)
  endpoint_id            uuid,
  vendor_endpoint_id     varchar(128),             -- index correction 2
  breeze_device_id       uuid,
  provider               varchar(30) NOT NULL,
  vendor_detection_id    varchar(255) NOT NULL,
  vendor_kind            varchar(30) NOT NULL,
  severity               varchar(20) NOT NULL DEFAULT 'unknown',
  vendor_severity        varchar(64),
  status                 varchar(20) NOT NULL DEFAULT 'unknown',
  vendor_status          varchar(64),
  notified_severity      varchar(20),
  detached_at            timestamptz,              -- D13 tombstone
  device_detached_at     timestamptz,              -- D14
  last_site_id           uuid,                     -- D14 snapshot, no FK (historical)
  title                  varchar(500),
  category               varchar(128),
  threat_name            varchar(500),
  file_path              text,
  process_name           varchar(500),
  mitre_techniques       text[] NOT NULL DEFAULT '{}',
  detected_at            timestamptz,
  resolved_at            timestamptz,
  last_vendor_update_at  timestamptz,
  details                jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
-- CHECKs: severity / notified_severity (EDR_SEVERITIES), status (EDR_DETECTION_STATUSES), vendor_kind (EDR_VENDOR_KINDS).
-- Live-row identity only: a tombstone must not hold the key (index correction 1b).
CREATE UNIQUE INDEX IF NOT EXISTS edr_detections_live_vendor_uniq
  ON edr_detections (connection_id, vendor_kind, vendor_detection_id) WHERE detached_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS edr_detections_id_org_uniq ON edr_detections (id, org_id);
CREATE INDEX IF NOT EXISTS edr_detections_org_status_idx ON edr_detections (org_id, status);
CREATE INDEX IF NOT EXISTS edr_detections_org_severity_status_idx ON edr_detections (org_id, severity, status);
CREATE INDEX IF NOT EXISTS edr_detections_org_detected_open_idx ON edr_detections (org_id, detected_at DESC)
  WHERE status IN ('open', 'in_progress', 'unknown');
CREATE INDEX IF NOT EXISTS edr_detections_breeze_device_idx ON edr_detections (breeze_device_id);
CREATE INDEX IF NOT EXISTS edr_detections_tenant_idx ON edr_detections (tenant_id);
CREATE INDEX IF NOT EXISTS edr_detections_connection_vendor_endpoint_idx ON edr_detections (connection_id, vendor_endpoint_id);
-- FKs: (connection_id, partner_id) -> edr_connections ON DELETE CASCADE;
--      (tenant_id, connection_id) -> edr_tenants(id, connection_id) ON DELETE SET NULL (tenant_id);
--      (tenant_id, org_id) -> edr_tenants(id, org_id) ON DELETE SET NULL (tenant_id) DEFERRABLE INITIALLY IMMEDIATE;
--      (endpoint_id, org_id) -> edr_endpoints(id, org_id) ON DELETE SET NULL (endpoint_id) DEFERRABLE INITIALLY IMMEDIATE;
--      (breeze_device_id, org_id) -> devices(id, org_id) ON DELETE SET NULL (breeze_device_id) DEFERRABLE INITIALLY IMMEDIATE;
--      (org_id, partner_id) -> organizations(id, partner_id) DEFERRABLE INITIALLY IMMEDIATE   (edr_detections_org_partner_fk).
-- The org/partner FK is load-bearing HERE (Codex review 2026-10-01): tenant_id is nullable, so once a row is
-- tombstoned nothing else ties its org to its connection's partner; without it a row could carry org A and a
-- connection of another partner. Same FK on edr_actions and (uniformity) edr_endpoints.
-- Tenant FKs are SET NULL (tenant_id), not CASCADE: a tenant row deleted by org erasure must not be the
-- path that deletes detections (the org cascade does that explicitly), and a tombstone survives its tenant.

-- 5. edr_actions — shape 1, the generic s1_actions
CREATE TABLE IF NOT EXISTS edr_actions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id      uuid NOT NULL,
  partner_id         uuid NOT NULL REFERENCES partners(id),
  org_id             uuid NOT NULL REFERENCES organizations(id),
  tenant_id          uuid,
  endpoint_id        uuid,
  detection_id       uuid,
  breeze_device_id   uuid,
  provider           varchar(30) NOT NULL,
  action             varchar(40) NOT NULL,
  requested_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_via      varchar(20) NOT NULL,
  ai_session_id      uuid,
  approval_id        uuid,
  status             varchar(20) NOT NULL DEFAULT 'queued',
  vendor_action_id   varchar(255),
  payload            jsonb,
  error              text,
  detached_at        timestamptz,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  submitted_at       timestamptz,
  completed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- CHECKs: action (EDR_ACTIONS), status (EDR_ACTION_STATUSES), requested_via (EDR_ACTION_REQUESTED_VIA).
-- FKs: connection/partner CASCADE; tenant pair SET NULL (tenant_id) as detections;
--      (endpoint_id, org_id) -> edr_endpoints SET NULL (endpoint_id) DEFERRABLE INITIALLY IMMEDIATE;
--      (detection_id, org_id) -> edr_detections(id, org_id) SET NULL (detection_id) DEFERRABLE INITIALLY IMMEDIATE;
--      (breeze_device_id, org_id) -> devices SET NULL (breeze_device_id) DEFERRABLE INITIALLY IMMEDIATE;
--      (org_id, partner_id) -> organizations(id, partner_id) DEFERRABLE INITIALLY IMMEDIATE (edr_actions_org_partner_fk).
-- ai_session_id / approval_id: plain uuid, no FK in W01 (W03 decides; an FK onto an org-scoped
-- ai table must also be deferrable and cascade-ordered).
CREATE INDEX IF NOT EXISTS edr_actions_org_requested_idx ON edr_actions (org_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS edr_actions_open_status_idx ON edr_actions (connection_id, status) WHERE status IN ('queued','submitted');
CREATE INDEX IF NOT EXISTS edr_actions_breeze_device_idx ON edr_actions (breeze_device_id);

-- 6. RLS: partner axis — four per-command policies on edr_connections and edr_tenants,
--    copied from section 6 of the backup migration with table names swapped; the edr_tenants
--    INSERT/UPDATE WITH CHECK re-checks EXISTS (edr_connections c WHERE c.id = connection_id AND c.partner_id = partner_id).
-- 7. RLS: org axis — the FOREACH loop from section 7 of the backup migration over
--    ARRAY['edr_endpoints','edr_detections','edr_actions'] (one FOR ALL policy `<t>_org_access`,
--    USING/WITH CHECK breeze_has_org_access(org_id)); partner_id is NOT a second read branch.
-- GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON each table TO breeze_app (unguarded).
```

Every `ON DELETE SET NULL (col)` above is the PG15 column-list form; **never** a bare `SET NULL` on a composite FK whose other column is `org_id NOT NULL` (#4100 — `orgCascadeFkOnDelete.integration.test.ts` reads `confdelsetcols`).

- [ ] **Step 3: Apply it twice against the per-worktree stack**

```bash
pnpm test-stack up
set -a; . ./.env.test; set +a          # DATABASE_URL for the test stack
pnpm db:migrate                                                    # applies it once via the ledger
# The runner SKIPS ledgered filenames (src/db/autoMigrate.ts:785), so a second db:migrate proves nothing.
# Prove idempotency by replaying the raw file twice inside a transaction:
for i in 1 2; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f apps/api/migrations/2026-11-14-100000-edr-provider-framework.sql; done
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```

Expected: both replays succeed with no error (NOTICEs from `IF NOT EXISTS` are fine); both tests PASS.
Catalog shape (columns, CHECKs, FKs + `confdelsetcols` + deferrability, partial indexes, policies) is
asserted in Task 6 against `pg_catalog`, not by drift tooling.

- [ ] **Step 4: Commit** — `git add apps/api/migrations/2026-11-14-100000-edr-provider-framework.sql && git commit -m "feat(db): EDR provider framework tables with RLS (#3136)"`

---

## Task 3: Drizzle schema

**Files:**
- Create: `src/db/schema/edrProviders.ts`
- Modify: `src/db/schema/index.ts` (add `export * from './edrProviders';` after `./backupProviders`)
- Test: `src/db/schema/edrProviders.test.ts`

**Interfaces:**
- Produces: `edrConnections`, `edrTenants`, `edrEndpoints`, `edrDetections`, `edrActions` Drizzle tables (camelCase columns of Task 2), `$type<>` narrowed with the Task 1 types.

- [ ] **Step 1: Write the failing test**

```ts
// src/db/schema/edrProviders.test.ts
import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { edrActions, edrConnections, edrDetections, edrEndpoints, edrTenants } from './edrProviders';

describe('edr provider schema', () => {
  it('names the device link breeze_device_id, never device_id (spec D4)', () => {
    for (const table of [edrEndpoints, edrDetections, edrActions]) {
      const names = Object.values(getTableColumns(table)).map((c) => c.name);
      expect(names, getTableName(table)).toContain('breeze_device_id');
      expect(names, getTableName(table)).not.toContain('device_id');
    }
  });
  it('keeps partner-axis tables free of an org_id NOT NULL', () => {
    expect(Object.values(getTableColumns(edrConnections)).map((c) => c.name)).not.toContain('org_id');
    expect(getTableColumns(edrTenants).orgId.notNull).toBe(false);
  });
  it('tombstone-able children have a nullable tenant_id (index correction 1)', () => {
    expect(getTableColumns(edrDetections).tenantId.notNull).toBe(false);
    expect(getTableColumns(edrActions).tenantId.notNull).toBe(false);
  });
});
```

- [ ] **Step 2: Run — FAIL (module missing).** `cd apps/api && npx vitest run src/db/schema/edrProviders.test.ts`

- [ ] **Step 3: Implement** mirroring `db/schema/backupProviders.ts`: every column of Task 2 with the same SQL name; `uniqueIndex(...)` for each unique index (partial ones with `.where(sql\`…\`)`); declare every composite FK Drizzle can represent with `foreignKey({...})` (`.onDelete('cascade')` where the SQL says CASCADE), including the deferrable ones — with a comment that deferrability lives in SQL only, exactly as backup does for `orgPartnerFk` (`db/schema/backupProviders.ts:139-145`) and `customerOrgFk` (`:236-240`). Omit **only** the column-list `ON DELETE SET NULL (col)` FKs, which Drizzle cannot express (comment why, as backup does at `:241-246`). No pg enums — `varchar(...).$type<EdrSeverity>()` etc.

- [ ] **Step 4: Run test + typecheck**

```bash
cd apps/api && npx vitest run src/db/schema/edrProviders.test.ts && npx tsc --noEmit -p .
cd ../.. && pnpm db:check-drift   # sanity only: it does NOT compare schema to the live DB (scripts/check-drift.ts:17)
```

Expected: PASS. Schema-vs-DB correctness is proven by Task 6's catalog assertions and the integration suites.

- [ ] **Step 5: Commit** — `git commit -am "feat(db): Drizzle schema for EDR provider tables (#3136)"` (add the new files first).

---

## Task 4: Tenancy registrations (cascade, merge, export, encrypted columns, RLS allowlists, device contract)

**Files:**
- Modify: `src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`, after `'dr_plans',`)
- Modify: `src/services/orgMergeRegistry.ts` (`REPOINT_TABLES`, after the `dr_*` block, with a comment mirroring the backup one at ~line 740: every composite FK onto org_id is deferrable; no org-scoped unique key → plain repoint)
- Modify: `src/services/tenantExportPolicyRegistry.ts` (`CORE_TENANT_EXPORT_POLICY`)
- Modify: `src/services/encryptedColumnRegistry.ts`
- Modify: `src/__tests__/integration/rls-coverage.integration.test.ts` (`PARTNER_TENANT_TABLES`, `ORG_AXIS_POLICY_EXCLUDED_TABLES`)
- Modify: `src/routes/devices/cascadeDelete.test.ts`

**Interfaces:**
- Consumes: Task 2 column lists. Produces: `encryptedColumnRegistry` entries Task 10's credential helpers look up by `(table, column)`.

- [ ] **Step 1: Write the failing unit tests**

`cascadeDelete.test.ts` — add, next to the `backup_provider_devices` case (~line 270):

```ts
it.each(['edr_endpoints', 'edr_detections', 'edr_actions'])(
  '%s needs no device-cascade entry — its link column is breeze_device_id',
  (name) => {
    const table = allSchemaTables().find((t) => getTableName(t) === name);
    expect(table, `${name} missing from the Drizzle schema barrel`).toBeDefined();
    const names = Object.values(getTableColumns(table!)).map((c) => c.name);
    expect(names).toContain('breeze_device_id');
    expect(names).not.toContain('device_id');
    expect(DEVICE_CASCADE_DELETE_TABLES).not.toContain(name);
    expect(DEVICE_DETACH_DEVICE_ID_TABLES).not.toContain(name);
    expect(DEVICE_LINKED_DEVICE_ID_TABLES).not.toContain(name);
  },
);
```

`encryptedColumnRegistry.test.ts` — add a case asserting the three entries exist with `aadBinding: 'row'`.

- [ ] **Step 2: Run — FAIL** (`encryptedColumnRegistry` case). `cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/services/encryptedColumnRegistry.test.ts`

- [ ] **Step 3: Implement the registrations**

`tenantCascade.ts` (alphabetical by `localeCompare`; FK children before parents — actions → detections → endpoints → tenants holds alphabetically, and the intra-framework FKs are CASCADE / SET NULL(col) so order is determinism; `tenantCascade.integration.test.ts`'s `topologicalCascadeOrder()` assertion is the proof):

```ts
  'dr_plans',
  // EDR provider framework (#3136 W01). edr_connections is partner-axis with no
  // org_id and is erased by cascadeDeletePartner's partner_id sweep.
  'edr_actions',
  'edr_detections',
  'edr_endpoints',
  'edr_tenants',
  'elevation_audit',
```

`orgMergeRegistry.ts` `REPOINT_TABLES`: the same four, same position.

`tenantExportPolicyRegistry.ts` — four rows, **every** column of Task 2 bucketed:

```ts
  "edr_actions": tablePolicy("org_id", {"included":["id","connection_id","partner_id","org_id","tenant_id","endpoint_id","detection_id","breeze_device_id","provider","action","requested_by","requested_via","ai_session_id","approval_id","status","vendor_action_id","error","detached_at","requested_at","submitted_at","completed_at","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["payload"]}),
  "edr_detections": tablePolicy("org_id", {"included":["id","connection_id","partner_id","org_id","tenant_id","endpoint_id","vendor_endpoint_id","breeze_device_id","provider","vendor_detection_id","vendor_kind","severity","vendor_severity","status","vendor_status","notified_severity","detached_at","device_detached_at","last_site_id","title","category","threat_name","file_path","process_name","mitre_techniques","detected_at","resolved_at","last_vendor_update_at","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["details"]}),
  "edr_endpoints": tablePolicy("org_id", {"included":["id","connection_id","partner_id","org_id","tenant_id","provider","vendor_endpoint_id","hostname","fqdn","serial_number","mac_addresses","ip_addresses","os_platform","os_name","endpoint_type","agent_version","health","online","isolation_state","tamper_protection","policy_name","last_seen_at","vendor_detail_synced_at","breeze_device_id","device_match_source","first_seen_at","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["vendor_raw"]}),
  // edr_tenants: the per-tenant installer secret is credential material; the
  // partner console credential lives on edr_connections (no org_id, not exported).
  "edr_tenants": tablePolicy("org_id", {"included":["id","connection_id","partner_id","vendor_tenant_id","vendor_tenant_name","vendor_parent_id","vendor_tenant_type","vendor_external_code","api_host","org_id","mapping_source","endpoint_count","open_detection_count","last_seen_at","vendor_missing_since","last_inventory_sync_at","last_inventory_sync_status","last_inventory_sync_error","last_detection_sync_at","last_detection_sync_status","last_detection_sync_error","detection_cursor","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":["installer_secret_encrypted"],"excludedOpen":[]}),
```

(Check with `SUSPICIOUS_NAME_PARTS` in `src/services/tenantExportPolicy.ts`: none of the `included` names contains password/hash/token/secret/credential/authorization/webhook/… ; `payload` and `details` are jsonb → `excludedOpen`.)

`encryptedColumnRegistry.ts` (after the `backup_provider_connections` entry):

```ts
  { table: 'edr_connections', column: 'credentials_encrypted', kind: 'text', aadBinding: 'row', description: 'EDR vendor console credential JSON (#3136 W01) — AAD bound to the row id' },
  { table: 'edr_connections', column: 'webhook_secret_encrypted', kind: 'text', aadBinding: 'row', description: 'EDR push/webhook shared secret Breeze generates (#3136 W03) — AAD bound to the row id' },
  { table: 'edr_tenants', column: 'installer_secret_encrypted', kind: 'text', aadBinding: 'row', description: 'per-vendor-tenant installer token / link (#3136 W06) — AAD bound to the row id' },
```

`rls-coverage.integration.test.ts`: add `'edr_tenants'` to `ORG_AXIS_POLICY_EXCLUDED_TABLES` (comment mirroring the `backup_provider_customers` one at ~line 185) and `['edr_connections', 'partner_id'], ['edr_tenants', 'partner_id']` to `PARTNER_TENANT_TABLES` (comment mirroring ~line 375). The three shape-1 tables are auto-discovered — do not list them.

- [ ] **Step 4: Run the unit tests — PASS**, then the full API unit suite once (the merge registry only reds there):

```bash
cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/services/encryptedColumnRegistry.test.ts
cd apps/api && npx vitest run src/services/orgMerge.test.ts src/services/orgMergeRegistry.test.ts 2>/dev/null; pnpm --filter @breeze/api test --run
```

- [ ] **Step 5: Run the DB contract suites on the test stack (they only fail in CI's Integration Tests)**

```bash
cd apps/api
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts
cd ../.. && DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
```

Expected: all PASS. Check the reported file count equals 6 (a typo is "No test files found", which is not a pass).

- [ ] **Step 6: Commit** — `git commit -am "feat(tenancy): register EDR tables in cascade, merge, export, RLS and encrypted-column lists (#3136)"`

---

## Task 5: Device org-move detach (D4 + D14)

**Files:**
- Modify: `src/services/deviceOrgMove/moveDeviceOrgInTransaction.ts` (immediately after the `backup_provider_devices` detach, ~line 350)
- Modify: `src/routes/devices/moveOrg.test.ts` (~lines 1446–1462: new assertions; shift indices 9–12 → 12–15)
- Modify: `src/services/deviceDeletion.ts` (before `tx.delete(devices)` at ~line 354 — the only device hard-delete path; org erasure deletes the detections themselves) + its test

**Interfaces:**
- Produces: on a device org move, every EDR row linked to the device in the source org is detached; open detections remember the device's site.

- [ ] **Step 1: Write the failing test** — in `moveOrg.test.ts` after the `providerDetach` block:

```ts
      // #3136 W01 — EDR links detach for the same reason as backup_provider_devices:
      // (breeze_device_id, org_id) -> devices(id, org_id) is DEFERRABLE INITIALLY
      // IMMEDIATE and nothing trigger-side mirrors a breeze_device_id column.
      const edrEndpointDetach = collapseStmt(statements[9]!);
      expect(edrEndpointDetach).toContain('UPDATE edr_endpoints SET breeze_device_id = NULL, device_match_source = NULL');
      expect(edrEndpointDetach).toMatch(/AND org_id =/);
      const edrDetectionDetach = collapseStmt(statements[10]!);
      expect(edrDetectionDetach).toContain('UPDATE edr_detections SET breeze_device_id = NULL');
      // D14: detached findings keep the last device's site restriction.
      expect(edrDetectionDetach).toContain('device_detached_at = now()');
      expect(edrDetectionDetach).toMatch(/last_site_id = \(SELECT site_id FROM devices/);
      const edrActionDetach = collapseStmt(statements[11]!);
      expect(edrActionDetach).toContain('UPDATE edr_actions SET breeze_device_id = NULL');
```

and renumber the following `statements[9]`…`statements[12]` to `[12]`…`[15]`.

- [ ] **Step 2: Run — FAIL.** `cd apps/api && npx vitest run src/routes/devices/moveOrg.test.ts`

- [ ] **Step 3: Implement**

```ts
  // #3136 W01 (EDR provider framework, spec D4/D14) — same contract as the
  // backup_provider_devices detach above: the link is unrepresentable once the
  // device leaves the org; the ROWS stay (their org_id comes from the vendor
  // tenant mapping). Detections additionally snapshot the device's CURRENT site
  // (this runs before the devices UPDATE below, so site_id is still the source
  // site) so a site-restricted technician does not gain visibility of a finding
  // that turned into a null-device row (spec §4.7, D14).
  await tx.execute(sql`UPDATE edr_endpoints SET breeze_device_id = NULL, device_match_source = NULL
      WHERE breeze_device_id = ${deviceId}::uuid AND org_id = ${sourceOrgId}::uuid`);
  await tx.execute(sql`UPDATE edr_detections SET breeze_device_id = NULL, device_detached_at = now(),
        last_site_id = (SELECT site_id FROM devices WHERE id = ${deviceId}::uuid)
      WHERE breeze_device_id = ${deviceId}::uuid AND org_id = ${sourceOrgId}::uuid`);
  await tx.execute(sql`UPDATE edr_actions SET breeze_device_id = NULL
      WHERE breeze_device_id = ${deviceId}::uuid AND org_id = ${sourceOrgId}::uuid`);
```

(Collapse whitespace so the test's `collapseStmt` string matches; check how `collapseStmt` normalizes before choosing line breaks.)

- [ ] **Step 3b: Device hard-delete keeps the site restriction too (Codex review 2026-10-01).** The FK
  `ON DELETE SET NULL (breeze_device_id)` would otherwise turn a deleted device's findings into
  "never linked" null-device rows visible to every site in the org (spec §4.7 / D14 principle: never
  widen visibility as a side effect). Failing test first in the `deviceDeletion` test file (statement
  present, before the device delete), then:

  ```ts
  // #3136 W01 — D14 for hard delete: snapshot before the FK SET NULL clears the link.
  await tx.execute(sql`UPDATE edr_detections SET device_detached_at = COALESCE(device_detached_at, now()),
        last_site_id = (SELECT site_id FROM devices WHERE id = ${deviceId}::uuid)
      WHERE breeze_device_id = ${deviceId}::uuid`);
  ```

  `deviceDeletion.ts` is already classified by the parked-fanout / visibility scanners; re-run them.

- [ ] **Step 4: Run — PASS.** Also `npx vitest run src/routes/devices src/services/deviceDeletion src/__tests__/parkedFanout.contract.test.ts` (the move/cascade/delete family).

- [ ] **Step 5: Commit** — `git commit -am "feat(devices): detach EDR links on device org move (#3136)"`

---

## Task 6: `edrProviderRls.integration.test.ts` — tenancy proof, then open W01a

**Files:**
- Create: `src/__tests__/integration/edrProviderRls.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5. Produces: `seedEdrTenant(label, partnerId?)` fixture helper (local to this file; Task 18 copies it).

- [ ] **Step 1: Write the tests (they are the deliverable; each must be seen to fail first by temporarily breaking the thing it guards — e.g. drop a policy in a scratch DB — then restored).** Mirror `backupProviderRls.integration.test.ts` (seed with `getTestDb()` for `devices`, `withDbAccessContext` for app-role assertions). Cases:

```ts
const runDb = it.runIf(!!process.env.DATABASE_URL);
const EDR_TABLES = ['edr_connections','edr_tenants','edr_endpoints','edr_detections','edr_actions'] as const;

runDb('all five tables have RLS enabled and forced', …);                         // pg_class relrowsecurity/relforcerowsecurity
runDb('partner tables carry four per-command partner policies; tenants WITH CHECK re-checks the connection', …);
runDb('org tables carry one FOR ALL breeze_has_org_access(org_id) policy and no partner branch', …);
runDb('CHECK constraints accept exactly the shared tuples', …);                  // insert each tuple value OK; 'bogus' -> 23514
runDb('cross-partner forge of an edr_connections row -> 42501', …);
runDb('edr_tenants row claiming partner B with a connection of partner A -> 42501', …);
runDb('edr_tenants mapped to an org of another partner -> 23503', …);             // composite (org_id, partner_id) FK
runDb('a tombstoned detection/action (tenant_id NULL) claiming an org of another partner than its connection -> 23503', …); // org_partner_fk
runDb('org token reads zero edr_connections / edr_tenants rows', …);
runDb('org token of org A reads none of org B\'s endpoints, detections, actions', …);
runDb('edr_endpoints row whose tenant is mapped to another org -> 23503', …);     // (tenant_id, org_id) FK
runDb('link to a device of another org -> 23503', …);
runDb('link FKs use ON DELETE SET NULL (breeze_device_id) — confdelsetcols pinned', async () => {
  // for each of edr_endpoints/edr_detections/edr_actions:
  // SELECT confdeltype, (SELECT array_agg(attname) FROM pg_attribute WHERE attrelid = conrelid AND attnum = ANY(confdelsetcols))
  // FROM pg_constraint WHERE conname = '<t>_breeze_device_org_fk' -> confdeltype 'n', setcols ['breeze_device_id']
});
runDb('every composite FK onto an org_id column is DEFERRABLE INITIALLY IMMEDIATE', …); // condeferrable && !condeferred
runDb('deleting a device clears ONLY breeze_device_id on all three tables', …);
runDb('cascadeDeleteOrg erases endpoints, detections, actions and tenant rows of the org', …);
runDb('executeOrgMerge repoints all four org tables (merge contract)', …);
runDb('detached detection does not hold the live unique key (correction 1b)', async () => {
  // insert detection D1 (vendor id X), set detached_at = now(), tenant_id = NULL;
  // insert D2 with the same (connection_id, vendor_kind, X) and detached_at NULL -> succeeds;
  // a second live row with the same key -> 23505.
});
```

- [ ] **Step 2: Run on the test stack — PASS**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/edrProviderRls.integration.test.ts
```

Also re-run Task 4 Step 5's six suites + `test:rls-coverage`, and `integration-suite-coverage` (new integration files must be wired into a CI shard): `pnpm --filter @breeze/api test:integration-suite-coverage`.

- [ ] **Step 3: Commit, push, open W01a PR**

```bash
git add src/__tests__/integration/edrProviderRls.integration.test.ts && git commit -m "test(tenancy): EDR provider RLS, FK and cascade contract (#3136)"
pnpm test-stack down
```

PR body: shape table (spec §5), the registration checklist rows 1–8 + 16 ticked, "DDL only — not in the migrationRlsScope baseline", migration-name check against `origin/main`, the index's corrections 1–4. Request one independent review (Sonnet/Opus — tenancy blast radius). `Closes #<W01 sub-issue>` goes on W01b, not here (W01a: `Part of #<W01 sub-issue>`).

---
## W01b — framework + GravityZone adapter

Branch W01b off W01a. Until W01a merges, W01b gets **no CI** (`ci.yml` triggers on PRs to
`main` only): `gh workflow run CI --ref <w01b-branch>` before asking for review, and again after
rebasing onto the merged W01a.

### GravityZone API facts this wave depends on

Researched 2026-10-01 from the raw HTML of the Bitdefender support pages (prefix `77209-` = Cloud,
`77211-` = Partners; base `https://www.bitdefender.com/business/support/en/`). **[V]** = verified on
the primary page, **[U]** = unconfirmed → must be checked in the sandbox gate (Task 18) before the
adapter is registered for production use.

| Topic | Fact | |
|---|---|---|
| Transport | `POST {accessUrl}/v1.0/jsonrpc/{service}`; some services have `/v1.1/` (network, quarantine) and `/v1.2/` (incidents). JSON-RPC 2.0, **no batch**. `Content-Type: application/json`. | [V] `77209-125277-public-api` |
| Access URL / hosts | Per-account, shown in My Account → Control Center API: `https://cloud.gravityzone.bitdefender.com/api` (instance 2, US/global), `cloudgz.` (EU), `cloudap.` (APAC), sovereign `cloudrbx.ovh.`, `cloudham.s11.`, `cloudher.dts.` — all under `.gravityzone.bitdefender.com`, path `/api`. | [V] |
| Auth | HTTP Basic, API key as username, empty password (`base64("KEY:")`). | [V] |
| Errors | HTTP 401 bad/missing key; 403 key lacks that API; 429 rate-limited with `Retry-After`; other errors HTTP 200 with JSON-RPC codes -32700/-32600/-32601/-32602/-32000, **-32001 "Authorization error"** (invalid key, API not enabled, missing rights, *licence restriction*; detail text in `error.data.details`, e.g. "API Key is not allowed to access the selected API: Incidents"), -32002 resource not found, -32003 too many requests. Which HTTP status accompanies each -32001 sub-case is [U]. | [V] / [U] |
| Root company | `companies.getCompanyDetails()` (no id → own company): `id, name, type` (0 partner / 1 customer), `customFields`. No built-in external reference id. | [V] |
| Company tree | `network.getCompaniesList({ parentId, filters: { companyType } })` → plain array `{ id, name }`, **no pagination**; partners can nest (companyType 0 children). | [V] (`77211-128478`) — exact service path [U] |
| Endpoint inventory | `network` v1.1 `getNetworkInventoryItems({ parentId: <companyId>, filters: { type: { computers: true, virtualMachines: true }, depth: { allItemsRecursively: true } }, page, perPage ≤ 1000 })`; items carry `id, name, type, companyId, parentId, details{ fqdn, ip, macs, isManaged, machineType, operatingSystemVersion, isIsolated, policy{id,name,applied}, productOutdated, lastSuccessfulScan, modules }`; `total/pagesCount` on page 1, `hasMoreRecords` on every page. **5 req/s** limit on this method. | [V] |
| Endpoint detail | `network.getManagedEndpointDetails({ endpointId })` — one per call: `lastSeen, state, operatingSystem, agent{ productVersion, signatureOutdated, licensed }, malwareStatus{ detection (24 h), infected }`. | [V] (`77211-128484`) |
| Incidents (EDR licence) | `incidents` v1.2 `getIncidentsList({ page, perPage 10–10000, filters: { companyId, changeStartDate, changeEndDate (pair, on lastIncidentChange) }, options: { sortBy: 'lastIncidentChange' } })`; items `incidentId, incidentNumber, company{id,name}, status, mainAction, created, lastUpdated, lastIncidentChange, severityScore, priority, attackTypes, incidentLink, details{ detectionName, computerId, … }`. `lastIncidentChange` moves on status/priority/assignee/note edits → **status changes are visible to a change-window delta**. Max window length and the `status` / `priority` value sets [U]. | [V] (`77211-1463999`) |
| Quarantine (no EDR licence) | `quarantine/computers` v1.1 `getQuarantineItemsList({ page, perPage ≤ 100, filters: { startDate, endDate (quarantine date) } })`; items `id, quarantinedOn, actionStatus, companyId, endpointId, endpointName, threatName, canBeRestored, canBeRemoved, details{ filePath, fileSha256 }`. No updated-after filter. Whether it is scoped to the whole managed tree without an `endpointId` [U]. | [V] / [U] |
| Rate limits | 10 req/s per key default; **5 req/s** for `getNetworkInventoryItems`, companies and licensing methods; 30/min (burst 10) scan/quarantine tasks; 5/min push methods. | [V] `77209-394430` |
| Key | Created in My Account with chosen APIs (shown once); belongs to that account's company, so a partner key reaches the whole managed tree. `getApiKeyDetails` → `enabledApis[]` (service path [U]). | [V] / [U] |

Design consequences (applied below): (1) the `base_url` column holds the **Access URL**, operator-supplied, required for GravityZone, validated as `https:` + host suffix `.gravityzone.bitdefender.com` + path starting `/api`; (2) two detection sources — incidents (delta with status updates, needs the Incidents API on the key **and** the licence on the company) and quarantine items (no licence; immutable after write in W01); a missing Incidents API / licence is an **operation-scope** degradation, not a tenant or connection failure; (3) inventory is one bulk paged call per company plus a **bounded** per-endpoint detail enrichment (`DETAIL_ENRICH_PER_RUN`, oldest `vendor_detail_synced_at` first) for health/online/last-seen/agent version; (4) no external reference id → `externalCode = null` (all mapping manual or a confirmed name suggestion; a `customFields` convention can be added later without a framework change).

---

## Task 7: Extract the pure tenant-mapping functions

**Files:**
- Create: `src/services/externalTenantMapping.ts`, `src/services/externalTenantMapping.test.ts`
- Modify: `src/services/backupProviders/mapping.ts` (import + re-export; delete the moved bodies)
- Test (unchanged, must stay green): `src/services/backupProviders/mapping.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AutoMapTenantRow { id: string; vendorName: string; vendorExternalCode: string | null }
  export interface AutoMapOrgRow { id: string; name: string }
  export type AutoMapDecision = { tenantId: string; orgId: string; mappingSource: 'auto_external_code' };
  export type AutoMapNameSuggestion = { tenantId: string; orgId: string };
  export function resolveAutoMappings(rows: AutoMapTenantRow[], orgs: AutoMapOrgRow[]): AutoMapDecision[];
  export function resolveAutoMapNameSuggestions(rows: AutoMapTenantRow[], orgs: AutoMapOrgRow[], alreadyClaimedOrgIds?: ReadonlySet<string>): AutoMapNameSuggestion[];
  ```
  `backupProviders/mapping.ts` keeps its exported names (`resolveCustomerAutoMappings`, `resolveCustomerAutoMapNameSuggestions`, `AutoMapCustomerRow`, …) as thin adapters over these (field rename `customerId` ↔ `tenantId`, `vendorCustomerName` ↔ `vendorName`).

- [ ] **Step 1: Write the failing test** — copy every case of `backupProviders/mapping.test.ts` that exercises the two pure functions into `externalTenantMapping.test.ts` with renamed fields, plus:

```ts
it('never emits an auto_name decision (spec §4.5)', () => {
  const d = resolveAutoMappings([{ id: 't1', vendorName: 'Acme', vendorExternalCode: null }], [{ id: ORG, name: 'Acme' }]);
  expect(d).toEqual([]);
});
it('a value that merely CONTAINS a uuid is not an external code', () => {
  expect(resolveAutoMappings([{ id: 't1', vendorName: 'x', vendorExternalCode: `ref ${ORG}` }], [{ id: ORG, name: 'y' }])).toEqual([]);
});
```

- [ ] **Step 2: Run — FAIL.** `cd apps/api && npx vitest run src/services/externalTenantMapping.test.ts`
- [ ] **Step 3: Move the two function bodies** (`mapping.ts:225-317`) into the new module with the renamed fields; the `AutoMapDecision.mappingSource` union narrows to `'auto_external_code'` (the backup type keeps `'auto_external_code' | 'auto_name'` for its column's CHECK, assigning the narrower value is fine).
- [ ] **Step 4: Run both suites — PASS, backup suite unchanged.** `npx vitest run src/services/externalTenantMapping.test.ts src/services/backupProviders/mapping.test.ts`
- [ ] **Step 5: Commit** — `git commit -m "refactor(integrations): extract pure vendor-tenant auto-mapping (#3136)"`

---

## Task 8: Extract the pure device matcher + shared candidate loader

**Files:**
- Create: `src/services/externalDeviceMatching/resolve.ts`, `resolve.test.ts`, `candidates.ts`, `index.ts`
- Modify: `src/services/backupProviders/deviceMatching.ts` (re-export `resolveDeviceMatches`, `MatchProviderRow`, `MatchCandidateDevice`, `DeviceMatchLink` from the new module; its DB function `matchProviderDevices` is **not** changed in W01)
- Modify: `src/__tests__/parkedFanoutModules.ts` (`FANOUT_MODULES['services/externalDeviceMatching/candidates.ts'] = { guards: 1, reason: 'candidate devices for external vendor endpoint matching carry the parked-device predicate' }`; Task 13 adds the matcher's own entry)
- Test (unchanged, must stay green): `src/services/backupProviders/deviceMatching.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // resolve.ts
  export interface MatchRow { id: string; orgId: string; matchName: string | null; macAddresses: string[] }
  export interface MatchCandidate { deviceId: string; matchName: string; orgId: string; macAddresses: string[]; claimed: boolean }
  export type MatchLink = { rowId: string; deviceId: string; source: 'auto_hostname' | 'auto_mac' };
  export function normalizeMatchName(value: string | null | undefined): string | null; // lower, trim, FQDN -> first label
  export function resolveDeviceMatches(rows: MatchRow[], candidates: MatchCandidate[]): { links: MatchLink[]; ambiguous: string[] };
  // candidates.ts
  export async function loadCandidateDevices(
    tx: ProviderSyncTx, orgIds: string[], names: string[],
    claimed: (deviceIdColumn: SQL) => SQL<boolean>,    // caller supplies the per-table "already linked" EXISTS
    opts: { shortenFqdn: boolean },                    // EDR true, backup false
  ): Promise<MatchCandidate[]>;
  /** SQL twin of normalizeMatchName for a devices column: lower(btrim(col)), and with shortenFqdn split_part(…, '.', 1). */
  export function deviceMatchNameSql(column: AnyColumn | SQL, opts: { shortenFqdn: boolean }): SQL<string>;
  ```
  The backup aliases keep their old field names (`providerDeviceId` ↔ `rowId`) through a two-line mapping in `backupProviders/deviceMatching.ts`.

- [ ] **Step 1: Write the failing test** — port every `deviceMatching.test.ts` case to `resolve.test.ts`, plus the FQDN rule (spec §4.6.2):

```ts
it('compares the short name of an FQDN against hostname and display name', () => {
  expect(normalizeMatchName('WS-01.corp.example.com')).toBe('ws-01');
  expect(normalizeMatchName('  ws-01 ')).toBe('ws-01');
  expect(normalizeMatchName('')).toBeNull();
});
it('identifier-poor rows with a same-org name collision stay ambiguous (no fuzzy fallback)', () => {
  const r = resolveDeviceMatches(
    [{ id: 'r1', orgId: 'o', matchName: 'pc', macAddresses: [] }],
    [{ deviceId: 'd1', orgId: 'o', matchName: 'pc', macAddresses: [], claimed: false },
     { deviceId: 'd2', orgId: 'o', matchName: 'pc', macAddresses: [], claimed: false }]);
  expect(r).toEqual({ links: [], ambiguous: ['r1'] });
});
it('never matches across orgs', () => { /* row org o1, candidate org o2 same name -> no link, not ambiguous */ });
```

Note: the FQDN rule must hold on **both** sides **in SQL**, not only in the pure function — the backup loader filters candidates with `inArray(lower(devices.hostname), names)` *before* JavaScript normalization (`backupProviders/deviceMatching.ts:215`), so a Breeze device stored as `ws-01.corp` would never be loaded for vendor name `ws-01` (Codex review 2026-10-01). `loadCandidateDevices` therefore filters on `deviceMatchNameSql(devices.hostname | devices.displayName, { shortenFqdn })` and normalizes the loaded names with the same rule; the EDR stale-link check (Task 13) uses the same SQL helper. Add a DB-backed regression in Task 18 (`ws-01.corp.example` device ↔ vendor `WS-01`). The backup path must not change behaviour: `backupProviders/deviceMatching.ts` keeps calling its own `normalize` for its SQL-side name, so FQDN shortening is EDR-only. Add a backup regression case proving `'ws-01.corp'` still does **not** match `'ws-01'` for backup rows.

- [ ] **Step 2: Run — FAIL.** `npx vitest run src/services/externalDeviceMatching/resolve.test.ts`
- [ ] **Step 3: Implement** — move `resolveDeviceMatches` verbatim (rename fields), make the name normalizer injectable (`resolveDeviceMatches(rows, candidates)` assumes names are pre-normalized by the caller; backup passes its existing normalize, EDR passes `normalizeMatchName`). `candidates.ts` is the device + `device_network` MAC loader lifted from `matchProviderDevices` (lines ~188–245) **including `notParkedDeviceCondition()`** and `ne(devices.status, 'decommissioned')`, with `claimed` supplied by the caller.
- [ ] **Step 4: Run — PASS** for `resolve.test.ts`, `backupProviders/deviceMatching.test.ts`, `src/__tests__/parkedFanout.contract.test.ts`, `src/__tests__/unassignedPoolVisibility.contract.test.ts`.
- [ ] **Step 5: Commit** — `git commit -m "refactor(integrations): extract external device matcher + candidate loader (#3136)"`

---

## Task 9: Framework types, registry, normalize

**Files:**
- Create: `src/services/edrProviders/types.ts`, `registry.ts`, `registry.test.ts`, `normalize.ts`, `normalize.test.ts`

**Interfaces:**
- Consumes: Task 1 tuples.
- Produces (exact names later tasks use):

```ts
// types.ts
import type { z } from 'zod';
import type { EdrActionKey, EdrDetectionStatus, EdrEndpointHealth, EdrEndpointType, EdrIsolationState,
  EdrOsPlatform, EdrSeverity, EdrVendorKind } from '@breeze/shared';

export type EdrErrorScope = 'connection' | 'tenant' | 'operation';
export class EdrProviderRequestError extends Error {
  readonly code: string; readonly reauth: boolean; readonly scope: EdrErrorScope; readonly retryAfterMs?: number;
  constructor(message: string, o: { code: string; reauth: boolean; scope: EdrErrorScope; retryAfterMs?: number; cause?: unknown });
}
export interface EdrCapabilities {
  tenantModel: 'partner' | 'single';
  perTenantHost: boolean;
  detectionDelivery: 'poll' | 'poll_and_push';
  /** How status changes on already-seen detections arrive (spec §4.3 cursor contract). */
  detectionStatusModel: 'delta_with_updates' | 'reread_open_on_inventory';
  actions: readonly EdrActionKey[];
  endpointIdentifiers: readonly ('hostname' | 'fqdn' | 'mac' | 'serial' | 'ip')[];
  installer: 'none' | 'static_url_with_token' | 'api_generated_link';
  requestBudget: { perSecond?: number; perMinute?: number; perHour?: number; perDay?: number };
  /** Narrower per-operation-class limits (GravityZone inventory/companies 5/s). */
  operationBudgets?: Readonly<Record<string, { perSecond?: number; perMinute?: number }>>;
  defaultIntervals: { detectionsMinutes: number; inventoryMinutes: number };
  maxActionTargets: number;
  firstSyncLookbackDays: number;
  tenantFetchConcurrency: number;
}
export interface VendorEdrTenant { vendorTenantId: string; name: string; parentId: string | null;
  tenantType: string | null; externalCode: string | null; apiHost: string | null }
export type VendorEdrTenantRef = Pick<VendorEdrTenant, 'vendorTenantId' | 'apiHost'>;
export interface VendorEdrEndpoint { vendorEndpointId: string; vendorTenantId: string; hostname: string | null;
  fqdn: string | null; serialNumber: string | null; macAddresses: string[]; ipAddresses: string[];
  osPlatform: EdrOsPlatform; osName: string | null; endpointType: EdrEndpointType; agentVersion: string | null;
  health: EdrEndpointHealth; online: boolean | null; isolationState: EdrIsolationState;
  tamperProtection: boolean | null; policyName: string | null; lastSeenAt: Date | null; raw: Record<string, unknown> }
export type VendorEdrEndpointDetail = Partial<Pick<VendorEdrEndpoint,
  'health' | 'online' | 'lastSeenAt' | 'agentVersion' | 'osName' | 'serialNumber'>> & { vendorEndpointId: string };
export interface VendorEdrDetection { vendorDetectionId: string; vendorKind: EdrVendorKind; vendorTenantId: string;
  vendorEndpointId: string | null; severity: EdrSeverity; vendorSeverity: string | null; status: EdrDetectionStatus;
  vendorStatus: string | null; title: string | null; category: string | null; threatName: string | null;
  filePath: string | null; processName: string | null; mitreTechniques: string[]; detectedAt: Date | null;
  resolvedAt: Date | null; lastVendorUpdateAt: Date | null; details: Record<string, unknown> }
export interface EdrDetectionPage { detections: VendorEdrDetection[]; cursor: string | null;
  /** Operation-scope degradations that did not fail the tenant (e.g. "incidents: API not enabled on key"). */
  warnings: string[] }
export type EdrTestResult =
  | { ok: true; rootId: string; rootName: string; rootType: string; tenantCount: number; capabilityNotes: string[] }
  | { ok: false; error: string; reauth: boolean };
export type GuardedFetch = (url: string, init: { method: 'GET' | 'POST' | 'PATCH'; headers: Record<string, string>;
  body?: string; timeoutMs?: number }) => Promise<{ status: number; headers: Headers; text(): Promise<string> }>;
export interface EdrRateLimiter { acquire(operationClass?: string): Promise<void> }
export interface EdrAdapterContext {
  creds: unknown; baseUrl: string | null; region: string | null;
  fetch: GuardedFetch; limiter: EdrRateLimiter;
  /** Per-sync-run memo so a connection-wide vendor call (GravityZone quarantine) is made once per run. */
  runCache: Map<string, Promise<unknown>>;
}
export interface EdrCredentialField { name: string; label: string; secret: boolean; required: boolean }
export interface EdrProviderAdapter {
  readonly key: EdrProviderKey; readonly label: string;
  readonly credentialsSchema: z.ZodTypeAny; readonly credentialFields: readonly EdrCredentialField[];
  /** Validates an operator-supplied base URL; null = adapter has a fixed host. */
  readonly baseUrlPolicy: { required: boolean; pathPrefix?: string } | null;
  readonly capabilities: EdrCapabilities;
  readonly hostAllowlist: readonly string[];
  testConnection(ctx: EdrAdapterContext): Promise<EdrTestResult>;
  listTenants(ctx: EdrAdapterContext, root: { id: string; type: string | null }): Promise<VendorEdrTenant[]>;
  listEndpoints(ctx: EdrAdapterContext, tenant: VendorEdrTenantRef): Promise<VendorEdrEndpoint[]>;
  countEndpoints?(ctx: EdrAdapterContext, tenant: VendorEdrTenantRef): Promise<number>;
  enrichEndpoints?(ctx: EdrAdapterContext, tenant: VendorEdrTenantRef, vendorEndpointIds: string[]): Promise<VendorEdrEndpointDetail[]>;
  listDetections(ctx: EdrAdapterContext, tenant: VendorEdrTenantRef, cursor: string | null, now: Date): Promise<EdrDetectionPage>;
  // Declared now, implemented from W03 (types only in W01 — no framework code calls them):
  performAction?(...a: unknown[]): Promise<unknown>;
  supportsAction?(...a: unknown[]): boolean;
  getActionStatus?(...a: unknown[]): Promise<unknown>;
  getDetections?(...a: unknown[]): Promise<VendorEdrDetection[]>;
  verifyWebhook?(...a: unknown[]): unknown;
  getInstaller?(...a: unknown[]): Promise<unknown>;
}
```

`EdrProviderKey` is re-exported from `registry.ts` (`(typeof EDR_PROVIDER_KEYS)[number]`). W03/W06 replace the `unknown[]` placeholders with the spec §4.3 signatures; nothing in W01 may call them.

```ts
// registry.ts — mirror backupProviders/registry.ts exactly
export const EDR_PROVIDER_KEYS = ['bitdefender'] as const;
export type EdrProviderKey = (typeof EDR_PROVIDER_KEYS)[number];
const ADAPTERS: Record<EdrProviderKey, EdrProviderAdapter> = { bitdefender: bitdefenderAdapter };
export function isEdrProviderKey(key: string): key is EdrProviderKey;
export function getEdrProvider(key: string): EdrProviderAdapter;   // loud throw on unknown, membership test first
export function listEdrProviders(): EdrProviderAdapter[];
```

```ts
// normalize.ts — pure, table-driven
export function bucketSeverity(table: Readonly<Record<string, EdrSeverity>>, raw: string | number | null | undefined): EdrSeverity; // unknown on miss
export function bucketStatus(table: Readonly<Record<string, EdrDetectionStatus>>, raw: string | number | null | undefined): EdrDetectionStatus;
export function normalizeMac(raw: string): string | null;     // 'AA-BB-…' / 'aabb…' -> 'aa:bb:…'; invalid -> null
export function normalizeMacs(raw: unknown): string[];        // de-duplicated, sorted
export function osPlatformFromName(name: string | null | undefined): EdrOsPlatform;
export function parseVendorDate(raw: unknown): Date | null;   // ISO / epoch; invalid -> null, never throws
export function isOpenDetectionStatus(s: EdrDetectionStatus): boolean;
```

- [ ] **Step 1: Write the failing tests**

```ts
// registry.test.ts
it('throws on an unknown key, including inherited object keys', () => {
  for (const k of ['nope', '__proto__', 'constructor', 'toString']) expect(() => getEdrProvider(k)).toThrow(/Unknown EDR provider/);
});
it('every registered adapter declares a non-empty https host allowlist and a self-consistent capability set', () => {
  for (const a of listEdrProviders()) {
    expect(a.hostAllowlist.length).toBeGreaterThan(0);
    expect(a.capabilities.actions.length === 0 || typeof a.performAction === 'function').toBe(true);
    expect(a.capabilities.detectionDelivery === 'poll' || typeof a.verifyWebhook === 'function').toBe(true);
    expect(a.capabilities.installer === 'none' || typeof a.getInstaller === 'function').toBe(true);
  }
});
it('registry keys are the shared EdrProviderKey set (exhaustiveness guard)', () => { /* compare with a const in packages/shared if one is added in W02; for now pin ['bitdefender'] */ });
```

```ts
// normalize.test.ts
it('maps an unknown vendor severity/status to unknown, never throws', () => {
  expect(bucketSeverity({ high: 'high' }, 'ultra')).toBe('unknown');
  expect(bucketStatus({ 1: 'open' }, 99)).toBe('unknown');
  expect(bucketSeverity({}, null)).toBe('unknown');
});
it('normalizes MACs to lower-case colon form and drops garbage', () => {
  expect(normalizeMacs(['AA-BB-CC-DD-EE-FF', 'aabbccddeeff', 'zz', null])).toEqual(['aa:bb:cc:dd:ee:ff']);
});
it('parses vendor dates defensively', () => {
  expect(parseVendorDate('2026-10-01T10:00:00Z')?.toISOString()).toBe('2026-10-01T10:00:00.000Z');
  expect(parseVendorDate('not a date')).toBeNull();
});
```

- [ ] **Step 2: Run — FAIL.** `npx vitest run src/services/edrProviders/registry.test.ts src/services/edrProviders/normalize.test.ts`
- [ ] **Step 3: Implement** (registry imports the adapter from Task 12; until then stub `bitdefender/adapter.ts` with the capability object and `throw new Error('not implemented')` methods so the registry test can run — Task 12 replaces the stub).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(edr): provider adapter interface, registry, normalizers (#3136)"`

---

## Task 10: Guarded fetch, credentials, rate limiter, scheduler

**Files:**
- Create: `src/services/edrProviders/guardedFetch.ts` (+ `.test.ts`), `credentials.ts` (+ `.test.ts`), `rateLimiter.ts` (+ `.test.ts`), `scheduler.ts` (+ `.test.ts`)
- Modify: `src/services/logRedaction.test.ts` (regression case)

**Interfaces:**
- Produces:
  ```ts
  export function hostAllowed(hostname: string, allowlist: readonly string[]): boolean; // '.x' = suffix, 'x' = exact
  export function validateVendorUrl(raw: string, allowlist: readonly string[], opts?: { pathPrefix?: string }): { ok: true; url: URL } | { ok: false; reason: string };
  export function createGuardedFetch(allowlist: readonly string[], opts?: { maxBytes?: number; timeoutMs?: number; fetchImpl?: typeof safeFetch }): GuardedFetch;
  export function encryptEdrSecret(spec: 'connection_credentials' | 'connection_webhook_secret' | 'tenant_installer_secret', rowId: string, plaintext: unknown): string;
  export function decryptEdrSecret(spec: …, rowId: string, ciphertext: string): unknown;
  export function credentialFingerprint(provider: string, rootId: string | null, creds: unknown): string; // sha256 hex, never the secret
  export function createEdrRateLimiter(o: { redis: Redis | null; fingerprint: string; budget: EdrCapabilities['requestBudget'];
    operationBudgets?: EdrCapabilities['operationBudgets']; maxWaitMs?: number; sleep?: (ms: number) => Promise<void> }): EdrRateLimiter;
  export function planCadence(o: { tenants: number; mappedTenants: number; capabilities: EdrCapabilities;
    requested: { detectionsMinutes: number | null; inventoryMinutes: number | null };
    estimatedCalls: { perTenantDetection: number; perTenantInventory: number; perConnectionOverhead: number } }):
    { detectionsMinutes: number; inventoryMinutes: number; lengthened: boolean };
  export function isStreamDue(lastAt: Date | null, intervalMinutes: number, now: Date): boolean;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// guardedFetch.test.ts — Review Focus 4
const GZ = ['.gravityzone.bitdefender.com'];
it.each([
  ['https://cloud.gravityzone.bitdefender.com/api', true],
  ['https://cloudrbx.ovh.gravityzone.bitdefender.com/api', true],
  ['http://cloud.gravityzone.bitdefender.com/api', false],                    // not https
  ['https://cloud.gravityzone.bitdefender.com.evil.example/api', false],      // suffix spoof
  ['https://evil.example/api?x=.gravityzone.bitdefender.com', false],         // query is not host
  ['https://gravityzone.bitdefender.com.attacker.io/api', false],
  [`https://user:pw${'@'}cloud.gravityzone.bitdefender.com/api`, false],      // credentials in URL refused (`@` split so the docs PII guard does not read it as an email)
  ['https://cloud.gravityzone.bitdefender.com/other', false],                 // pathPrefix /api
])('validateVendorUrl(%s) ok=%s', (url, ok) => {
  expect(validateVendorUrl(url, GZ, { pathPrefix: '/api' }).ok).toBe(ok);
});
it('a bare allowlist entry is an exact host, not a suffix', () => {
  expect(hostAllowed('id.sophos.com', ['id.sophos.com'])).toBe(true);
  expect(hostAllowed('xid.sophos.com', ['id.sophos.com'])).toBe(false);
});
it('refuses a disallowed host before calling safeFetch', async () => {
  const fetchImpl = vi.fn();
  const f = createGuardedFetch(GZ, { fetchImpl: fetchImpl as never });
  await expect(f('https://example.com/api/v1.0/jsonrpc/network', { method: 'POST', headers: {} })).rejects.toThrow(/not allowed/);
  expect(fetchImpl).not.toHaveBeenCalled();
});
it('passes maxBytes and never follows redirects (safeFetch default)', async () => { /* assert fetchImpl called with maxBytes */ });
```

`credentials.test.ts`: round-trip under one row id; decrypt under a different row id throws (AAD); the registry lookup throws loudly if an entry is missing. `rateLimiter.test.ts` (fake `rateLimiter` from `src/services/rate-limit.ts` via `vi.mock`): keys are `edr:<fingerprint>:<window>[:<opClass>]`; a denied window sleeps until `resetAt` then retries; beyond `maxWaitMs` throws `EdrProviderRequestError{ code: 'rate_budget_exhausted', reauth: false, scope: 'connection', retryAfterMs }`; Redis `null` → fails closed with the same error (never an unthrottled vendor call). `scheduler.test.ts`: GravityZone defaults (10 min / 60 min) fit 200 companies at 10 req/s; a budget that cannot fit doubles the interval until it fits and sets `lengthened`; requested intervals below the adapter's floor are raised; `isStreamDue(null, …)` is true.

`logRedaction.test.ts`: `redactForLog({ apiKey: 'k', clientSecret: 's', authorization: 'Basic abc' })` → all `[REDACTED]` (index correction 7 — passes without code change; keep it as the regression pin).

- [ ] **Step 2: Run — FAIL** (modules missing).
- [ ] **Step 3: Implement.**

```ts
// guardedFetch.ts (core)
export function hostAllowed(hostname: string, allowlist: readonly string[]): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith('.') ? h.endsWith(e) && h.length > e.length : h === e;
  });
}
export function validateVendorUrl(raw: string, allowlist: readonly string[], opts: { pathPrefix?: string } = {}) {
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false as const, reason: 'not a valid URL' }; }
  if (url.protocol !== 'https:') return { ok: false as const, reason: 'must use https://' };
  if (url.username || url.password) return { ok: false as const, reason: 'must not embed credentials' };
  if (!hostAllowed(url.hostname, allowlist)) return { ok: false as const, reason: `host must match ${allowlist.join(', ')}` };
  if (opts.pathPrefix && !url.pathname.startsWith(opts.pathPrefix)) return { ok: false as const, reason: `path must start with ${opts.pathPrefix}` };
  const ssrf = checkSsrfSafe(url.toString(), { mode: 'strict-https' });   // literal-IP / loopback / metadata names
  if (!ssrf.ok) return { ok: false as const, reason: ssrf.reason ?? 'refused' };
  return { ok: true as const, url };
}
export function createGuardedFetch(allowlist: readonly string[], opts: { maxBytes?: number; timeoutMs?: number; fetchImpl?: typeof safeFetch } = {}): GuardedFetch {
  const impl = opts.fetchImpl ?? safeFetch;          // DNS-pinned, private ranges refused, redirects not followed, #1105 tripwire
  return async (url, init) => {
    const v = validateVendorUrl(url, allowlist);
    if (!v.ok) throw new EdrProviderRequestError(`EDR vendor URL not allowed: ${v.reason}`, { code: 'host_not_allowed', reauth: false, scope: 'connection' });
    const res = await impl(v.url.toString(), { method: init.method, headers: init.headers, body: init.body,
      timeoutMs: init.timeoutMs ?? opts.timeoutMs ?? 30_000, maxBytes: opts.maxBytes ?? 20 * 1024 * 1024 });
    return { status: res.status, headers: res.headers, text: () => res.text() };
  };
}
```

`credentials.ts`: three `EncryptedColumnSpec` lookups from `encryptedColumnRegistry` (throw at module load if missing, like `backupProviders/credentials.ts:22-30`), `encryptSecret(JSON.stringify(x), { aad: columnAad(spec, rowId) })` / `decryptSecret`. Never echo plaintext in an error.

`rateLimiter.ts`: for each window in `requestBudget` (perSecond→1 s, perMinute→60 s, perHour→3600 s, perDay→86400 s) call `rateLimiter(redis, key, limit, windowSeconds, 1, { refundOnReject: true })`; for an `operationClass` also its `operationBudgets` windows; loop with `sleep(resetAt - now)` until all allow or `maxWaitMs` (default 60 s) passes. Runs only outside DB context (the `rateLimiter` tripwire enforces it). Key prefix uses the **credential fingerprint** so two connections sharing one key share one budget (spec §4.4).

- [ ] **Step 4: Run — PASS.** `npx vitest run src/services/edrProviders/ src/services/logRedaction.test.ts`
- [ ] **Step 5: Commit** — `git commit -m "feat(edr): host-allowlisted fetch, row-bound credentials, rate budget, cadence planner (#3136)"`

---

## Task 11: GravityZone JSON-RPC client + recorded fixtures

**Files:**
- Create: `src/services/edrProviders/bitdefender/client.ts`, `client.test.ts`
- Create: `src/services/edrProviders/bitdefender/__fixtures__/` — `company-details-partner.json`, `company-details-customer.json`, `companies-list-root.json`, `companies-list-subpartner.json`, `inventory-page1.json` (`hasMoreRecords: true`), `inventory-page2.json`, `endpoint-details.json`, `incidents-page.json`, `quarantine-page.json`, `error-auth-32001.json`, `error-api-not-enabled-incidents.json`, `error-licence-32001.json`, `error-not-found-32002.json`, `error-too-many-32003.json`. Shapes copied from the Bitdefender doc examples (URLs in the "API facts" table); scrub any real ids.

**Interfaces:**
- Consumes: `GuardedFetch`, `EdrRateLimiter`, `EdrProviderRequestError`.
- Produces:
  ```ts
  export interface GravityZoneCredentials { apiKey: string }
  export const GZ_HOST_ALLOWLIST = ['.gravityzone.bitdefender.com'] as const;
  export const GZ_MAX_PAGES = 200;
  export class GravityZoneClient {
    constructor(o: { accessUrl: string; creds: GravityZoneCredentials; fetch: GuardedFetch; limiter: EdrRateLimiter });
    call<T>(service: string, version: '1.0' | '1.1' | '1.2', method: string, params: Record<string, unknown>,
      o?: { operationClass?: 'default' | 'inventory' | 'companies'; scope?: EdrErrorScope }): Promise<T>;
    getOwnCompany(): Promise<{ id: string; name: string; type: number }>;
    getCompaniesList(parentId: string, companyType?: 0 | 1): Promise<Array<{ id: string; name: string }>>;
    getInventoryAll(companyId: string): Promise<GzInventoryItem[]>;       // all pages or throw
    getEndpointDetails(endpointId: string): Promise<GzEndpointDetails>;
    getIncidentsChangedBetween(companyId: string, from: Date, to: Date): Promise<GzIncident[]>;   // all pages or throw
    getQuarantineBetween(from: Date, to: Date): Promise<GzQuarantineItem[]>;                       // all pages or throw
  }
  ```

- [ ] **Step 1: Write the failing tests** (stub `fetch` returns fixture text; limiter is a no-op spy):

```ts
it('sends Basic base64("KEY:") and a JSON-RPC 2.0 envelope to {accessUrl}/v1.1/jsonrpc/network', async () => { … });
it('paginates inventory until hasMoreRecords is false and returns every item', async () => { … });
it('THROWS when page 2 of the inventory fails — never returns page 1 alone (Review Focus 1)', async () => {
  // page1 ok, page2 HTTP 500 three times -> rejects EdrProviderRequestError { reauth: false }
});
it('stops at GZ_MAX_PAGES and throws instead of looping forever', async () => { … });
it('HTTP 401 -> reauth=true, scope=connection', async () => { … });
it('JSON-RPC -32001 on the key itself (getOwnCompany) -> reauth=true, scope=connection', async () => { … });
it('-32001 "not allowed to access the selected API: Incidents" -> reauth=false, scope=operation, code=api_not_enabled', async () => { … });
it('-32001 licence restriction on a company call -> reauth=false, scope=operation, code=licence', async () => { … });
it('-32002 on a company call -> reauth=false, scope=tenant, code=not_found', async () => { … });
it('HTTP 429 / -32003 -> code=rate_limited, retryAfterMs from Retry-After, reauth=false', async () => { … });
it('HTTP 5xx is retried up to 3 times with backoff, then throws reauth=false', async () => { … });
it('acquires the limiter with operationClass=inventory for getNetworkInventoryItems and companies for getCompaniesList', async () => { … });
it('never puts the API key into an error message', async () => { … });
```

- [ ] **Step 2: Run — FAIL.** `npx vitest run src/services/edrProviders/bitdefender/client.test.ts`
- [ ] **Step 3: Implement** — transport modelled on `backupProviders/cove/client.ts` (`rpc()` + `classifyVendorError()`), minus the visa/login machinery. `call()` = `limiter.acquire(opClass)` → `fetch(url, { method: 'POST', headers: { Authorization: 'Basic ' + b64(apiKey + ':'), 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) })` → classify. Classification precedence: HTTP 401 → `{auth, reauth:true, connection}`; HTTP 403 → `api_not_enabled` (operation); 429 → `rate_limited`; 5xx/network → transient retry; JSON-RPC error → `-32001` + details matching `/not allowed to access the selected API/i` → `api_not_enabled` (operation), `/licen[cs]e/i` → `licence` (operation), otherwise on `getOwnCompany` → `auth` (connection, reauth) and on any other call → `forbidden` (tenant); `-32002` → `not_found` (tenant); `-32003` → `rate_limited`. Required APIs (`companies`, `network`) disabled is surfaced by `testConnection` (Task 12), not by flipping a running sync to reauth. Unknown codes: logged once per run with the code only.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(edr): GravityZone JSON-RPC client with recorded fixtures (#3136)"`

---

## Task 12: GravityZone adapter + normalizers

**Files:**
- Create/replace: `src/services/edrProviders/bitdefender/adapter.ts`, `normalize.ts`, `adapter.test.ts`, `normalize.test.ts`

**Interfaces:**
- Consumes: Task 11 client, Task 9 types/normalize.
- Produces: `bitdefenderAdapter: EdrProviderAdapter` with:
  ```ts
  key: 'bitdefender', label: 'Bitdefender GravityZone',
  credentialsSchema: z.object({ apiKey: z.string().trim().min(16).max(512) }).strict(),
  credentialFields: [{ name: 'apiKey', label: 'API key', secret: true, required: true }],
  baseUrlPolicy: { required: true, pathPrefix: '/api' },           // the Access URL
  hostAllowlist: GZ_HOST_ALLOWLIST,
  capabilities: {
    tenantModel: 'partner', perTenantHost: false, detectionDelivery: 'poll',   // push arrives in W03
    detectionStatusModel: 'delta_with_updates',
    actions: [],                                                               // W03
    endpointIdentifiers: ['hostname', 'fqdn', 'mac', 'ip'],
    installer: 'none',                                                         // W06
    requestBudget: { perSecond: 10 },
    operationBudgets: { inventory: { perSecond: 5 }, companies: { perSecond: 5 } },
    defaultIntervals: { detectionsMinutes: 10, inventoryMinutes: 60 },
    maxActionTargets: 1000, firstSyncLookbackDays: 30, tenantFetchConcurrency: 2,
  }
  ```

Behaviour:
- `testConnection`: `getOwnCompany()` → `rootType = type === 0 ? 'partner' : 'company'`; for a partner, `listTenants` count; probe `incidents` and `quarantine/computers` with a one-item call and turn `api_not_enabled` / `licence` into `capabilityNotes` (not failures). Missing `network`/`companies` access → `{ ok: false, reauth: true, error: 'The API key must have the Network and Companies APIs enabled' }`.
- `listTenants(ctx, root)`: `rootType 'company'` → exactly one tenant `{ vendorTenantId: root.id, tenantType: 'company' }`; `'partner'` → BFS over `getCompaniesList(parentId, 1)` (customers = tenants) and `getCompaniesList(parentId, 0)` (sub-partners, recursed; depth ≤ 5; ≥ 5,000 companies → throw rather than truncate). `apiHost: null`, `externalCode: null`.
- `listEndpoints`: `getInventoryAll(companyId)` → keep `details.isManaged === true` items only (unmanaged network items have no Bitdefender agent) → `toVendorEndpoint()`: hostname = short `name`, `fqdn`, `ipAddresses = [details.ip]`, `macAddresses = normalizeMacs(details.macs)`, `osPlatform = osPlatformFromName(details.operatingSystemVersion)`, `endpointType` from `machineType` + OS name (server if the OS name contains "Server"), `isolationState = details.isIsolated ? 'isolated' : 'not_isolated'` (missing → `unknown`), `policyName = details.policy?.name`, `health = details.productOutdated ? 'degraded' : 'unknown'`, `online = null`, `lastSeenAt = null`, `raw = item`.
- `countEndpoints`: first inventory page with `perPage: 1` → `total` (used for unmapped tenants, D5).
- `enrichEndpoints(ids)`: `getEndpointDetails` per id (limiter default class) → `health`: `malwareStatus.infected` → `unhealthy`, `agent.signatureOutdated || productOutdated` → `degraded`, `agent.licensed === false` → `degraded`, else `healthy`; `online` from `state` (value set [U] → map known values, else null); `lastSeenAt`, `agentVersion = agent.productVersion`. A per-id failure with scope `tenant`/`operation` skips that id (it stays stale and is retried next run); a `connection` failure throws.
- `listDetections(ctx, tenant, cursor, now)`: cursor JSON `{ v: 1, incidentsChangedAfter?: string, quarantineAfter?: string }` (unparseable → treated as null = first sync). Window `from = max(cursorTime - 5 min overlap, now - firstSyncLookbackDays)`, `to = now`; incident windows chunked to ≤ 7 days each ([U] max range). Incidents: `getIncidentsChangedBetween(companyId, from, to)` → `vendorKind 'incident'`, `vendorDetectionId = incidentId`, `vendorEndpointId = details.computerId ?? null`, `severity = bucketSeverityScore(severityScore)`, `status = bucketStatus(GZ_INCIDENT_STATUS, status)`, `title = details.detectionName ?? 'Incident #' + incidentNumber`, `detectedAt = created`, `lastVendorUpdateAt = lastIncidentChange`, `details = { incidentNumber, mainAction, priority, attackTypes, incidentLink }`. `api_not_enabled` / `licence` → push a warning, skip the source, **do not advance** that part of the cursor. Quarantine: `ctx.runCache` memo `gz:quarantine:<from>:<to>` → one connection-wide `getQuarantineBetween(from, to)` per run, filtered to `companyId === tenant.vendorTenantId` → `vendorKind 'quarantine_item'`, `status = bucketStatus(GZ_QUARANTINE_STATUS, actionStatus)` (quarantined → `mitigated`; restored → `dismissed`; removed → `resolved`; unknown codes → `unknown`), `severity 'medium'` (a quarantined file is a contained threat; [U] revisit with the sandbox), `threatName`, `filePath = details.filePath`, `detectedAt = quarantinedOn`, `details = { fileSha256, canBeRestored, canBeRemoved }`. New cursor = max seen `lastIncidentChange` / `quarantinedOn` per source (unchanged source → old value). Any page failure → throw (cursor not advanced).

`normalize.ts` exports `GZ_INCIDENT_STATUS`, `GZ_QUARANTINE_STATUS`, `bucketSeverityScore(score)` (≥ 90 critical, ≥ 70 high, ≥ 40 medium, ≥ 1 low, else unknown — **[U] align with the console's own buckets during the sandbox gate**), `toVendorEndpoint`, `toIncidentDetection`, `toQuarantineDetection`.

- [ ] **Step 1: Write the failing tests** — adapter against a stub client fed by the Task 11 fixtures:

```ts
it('partner key: walks sub-partners and returns only customer companies as tenants', …);
it('customer key: returns exactly one tenant, the root company', …);
it('drops unmanaged inventory items', …);
it('maps an endpoint: short hostname, fqdn, lower-case MACs, isolation flag, outdated -> degraded', …);
it('enrichment: infected -> unhealthy; a per-id not_found skips that id without throwing', …);
it('incidents API not enabled -> detections from quarantine only + one warning, incidents cursor NOT advanced', …);
it('cursor overlap: re-reading a boundary incident yields the same vendorDetectionId (idempotent upsert key)', …);
it('first sync without cursor uses the 30-day lookback; a garbage cursor is treated as first sync', …);
it('quarantine is fetched ONCE per run across tenants (runCache)', …);
it('unknown incident status / severityScore -> unknown bucket, never throws', …);
it('incident page 2 failure throws and returns no cursor', …);
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — PASS.** `npx vitest run src/services/edrProviders/bitdefender/ src/services/edrProviders/registry.test.ts`
- [ ] **Step 5: Commit** — `git commit -m "feat(edr): Bitdefender GravityZone adapter read path (#3136)"`

---

## Task 13: Persist + EDR device matching (Phase 3 writers)

**Files:**
- Create: `src/services/edrProviders/persist.ts`, `persist.test.ts`, `deviceMatching.ts`, `deviceMatching.test.ts`
- Modify: `src/__tests__/parkedFanoutModules.ts` (`services/edrProviders/deviceMatching.ts` entry, rule 5)

**Interfaces:**
- Consumes: Tasks 3, 7, 8, 9.
- Produces:
  ```ts
  export type EdrSyncTx = ProviderSyncTx;   // reuse the backup type alias (Pick of db)
  export interface PersistConnection { id: string; partnerId: string; provider: string }
  export interface TenantFetch<T> { vendorTenantId: string; ok: true; value: T } | { vendorTenantId: string; ok: false; error: string; scope: EdrErrorScope }
  export async function upsertTenants(tx, conn, tenants: VendorEdrTenant[], now: Date): Promise<{ total: number; unmapped: number; newlyMissing: number }>;
  export async function persistInventory(tx, conn, results: TenantFetch<{ endpoints: VendorEdrEndpoint[]; details: VendorEdrEndpointDetail[]; count?: number }>[], now: Date): Promise<{ endpoints: number; failedTenants: number }>;
  export async function persistDetections(tx, conn, results: TenantFetch<EdrDetectionPage>[], now: Date): Promise<{ upserted: number; failedTenants: number }>;
  export async function pruneMissingTenantEndpoints(tx, connectionId: string, now: Date): Promise<number>;   // > 7 days missing
  export async function refreshDetectionDeviceLinks(tx, connectionId: string): Promise<void>;
  // deviceMatching.ts
  export async function matchEdrEndpoints(tx, connectionId: string): Promise<{ linked: number; ambiguous: number }>;
  ```

Rules (each one is a test):
1. `upsertTenants` — `ON CONFLICT (connection_id, vendor_tenant_id) DO UPDATE` name/parent/type/external code/api_host/`last_seen_at = now`, `vendor_missing_since = NULL`; tenants of this connection **absent** from the list get `vendor_missing_since = coalesce(vendor_missing_since, now)` — never deleted (D13). `api_host` is re-validated with `validateVendorUrl` against the adapter allowlist before write; an invalid host → tenant stored with `api_host = NULL` and a `last_inventory_sync_error` naming it (never stored unvalidated).
2. `persistInventory` — for each **ok, mapped** tenant: upsert endpoints `org_id = tenant.org_id` (`ON CONFLICT (connection_id, vendor_endpoint_id)`; an endpoint whose existing row has a different `org_id`/`tenant_id` — tenant remapped — is deleted and re-inserted, never updated across orgs), apply `details` (set `vendor_detail_synced_at = now`), then delete this tenant's endpoints whose `vendor_endpoint_id` is not in the fetched set. Ok **unmapped** tenant: write `endpoint_count = count` only. **Failed** tenant: write only `last_inventory_sync_status = 'error'`, `last_inventory_sync_error` — its endpoints untouched (Review Focus 1, D10). Backfill `edr_detections.endpoint_id` where `endpoint_id IS NULL AND vendor_endpoint_id` now resolves within the same connection+org.
3. `persistDetections` — for each ok, mapped tenant: `INSERT … ON CONFLICT (connection_id, vendor_kind, vendor_detection_id) WHERE detached_at IS NULL DO UPDATE` (severity, status, vendor_*, title…, `resolved_at`, `last_vendor_update_at`, `details`); `org_id`/`tenant_id` taken from the tenant row, `endpoint_id`/`breeze_device_id` resolved by `(connection_id, vendor_endpoint_id)` lookup at write time; **never** update `org_id` on conflict; a detection whose conflict row belongs to a different `tenant_id` is skipped and counted (defence in depth). Advance `edr_tenants.detection_cursor` only for that tenant; `open_detection_count` recomputed. Warnings → `last_detection_sync_status = 'partial'`. Failed tenant → status/error only, cursor unchanged. Never deletes a detection.
4. `refreshDetectionDeviceLinks` — after matching: `UPDATE edr_detections d SET breeze_device_id = e.breeze_device_id FROM edr_endpoints e WHERE d.endpoint_id = e.id AND d.connection_id = $1 AND d.detached_at IS NULL AND d.status IN ('open','in_progress','unknown') AND d.breeze_device_id IS DISTINCT FROM e.breeze_device_id` (closed detections keep the historical device — spec §4.2).
5. `matchEdrEndpoints` — mirror `matchProviderDevices` step-for-step on `edr_endpoints` (stale auto links dropped — the stale-link check is written with the Drizzle builder so it can carry `notParkedDeviceCondition()` (a device that became parked loses its auto link) and compares names through `deviceMatchNameSql(…, { shortenFqdn: true })`; because it reads `devices`, `services/edrProviders/deviceMatching.ts` is discovered by `parkedFanout.contract.test.ts` and gets `FANOUT_MODULES['services/edrProviders/deviceMatching.ts'] = { guards: 1, reason: 'stale-link validation drops links to parked devices; candidates come from externalDeviceMatching/candidates.ts' }` (count the guard sites the test actually sees and pin that number), orphaned `manual` source cleared, unlinked non-manual rows matched via `loadCandidateDevices` + `resolveDeviceMatches` with names from `normalizeMatchName(coalesce(hostname, fqdn))`), with **`claimed` scoped to the same connection** (`EXISTS (SELECT 1 FROM edr_endpoints x WHERE x.breeze_device_id = d.id AND x.connection_id = $conn)`) to match the per-connection partial unique index; savepointed link write, 23505 → counted ambiguous, next sync retries.

- [ ] **Step 1: Write the failing tests** — unit tests with the recording `tx` double pattern used by `backupProviders/persist.test.ts` (assert SQL shape: the `WHERE detached_at IS NULL` conflict target, no `org_id` in the `DO UPDATE SET` list, failed tenant produces no DELETE). Real-PG behaviour is proven in Task 18.
- [ ] **Step 2: Run — FAIL.** `npx vitest run src/services/edrProviders/persist.test.ts src/services/edrProviders/deviceMatching.test.ts`
- [ ] **Step 3: Implement** (batch upserts in chunks of 500 like backup's `chunk()`).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(edr): per-tenant persistence, tombstone-safe detection upsert, endpoint matching (#3136)"`

---

## Task 14: Tenant mapping service (auto-map, remap with D13 tombstones)

**Files:**
- Create: `src/services/edrProviders/mapping.ts`, `mapping.test.ts`
- Modify: `src/__tests__/integrationOrgTargetHoldingOrg.contract.test.ts` (`ORG_TARGET_WRITERS['services/edrProviders/mapping.ts'] = 'PUT /edr/tenants/:id/mapping (remapEdrTenant)'`)
- Modify: `src/__tests__/parkedFanout.contract.test.ts` (`VISIBILITY_MODULES['services/edrProviders/mapping.ts'] = 'vendor-tenant to org mapping: the holding org and Quick Support are never candidates'`)
- Modify: `src/__tests__/partner-wide-write-coverage.test.ts` (entry mirroring `services/backupProviders/mapping.ts`)

**Interfaces:**
- Produces:
  ```ts
  export async function autoMapEdrTenants(tx: EdrSyncTx, conn: PersistConnection): Promise<{ mapped: number; suggestions: AutoMapNameSuggestion[] }>;
  export class RemapEdrTenantError extends Error { code: 'NOT_FOUND' | 'ORG_NOT_IN_PARTNER' | 'HOLDING_ORG' }
  export async function remapEdrTenant(tx: EdrSyncTx, actor: { partnerId: string; userId: string | null },
    tenantId: string, orgId: string | null): Promise<{ tenantId: string; previousOrgId: string | null; orgId: string | null;
      endpointsDeleted: number; detectionsDetached: number; actionsDetached: number }>;
  export async function listNameSuggestions(tx: EdrSyncTx, connectionId: string): Promise<AutoMapNameSuggestion[]>;
  ```

Rules:
- `autoMapEdrTenants`: eligible = `mapping_source IS NULL` tenants of this connection; org candidates = the connection partner's orgs filtered with `notHiddenOrgType()` and never an `isUnassignedPoolOrgType` org; `resolveAutoMappings` decisions only (external code); name matches are returned as suggestions, never written.
- `remapEdrTenant` (one transaction, caller holds `pg_advisory_xact_lock(hashtext('edr-provider-sync'), hashtext(connectionId))` so it serializes with sync Phase 3):
  1. Load tenant `FOR UPDATE`; `partner_id !== actor.partnerId` → `NOT_FOUND`.
  2. Target org: must belong to the partner (`ORG_NOT_IN_PARTNER`), must not be a holding/unassigned-pool org (`isUnassignedPoolOrgType` → `HOLDING_ORG`).
  3. If the org changes (including → NULL): `UPDATE edr_detections SET detached_at = now(), tenant_id = NULL, endpoint_id = NULL WHERE tenant_id = $t AND detached_at IS NULL`; same for `edr_actions`; `DELETE FROM edr_endpoints WHERE tenant_id = $t` (D13 option C). **Order matters**: detach children before the tenant's `org_id` changes, or the composite `(tenant_id, org_id)` FK raises 23503.
  4. `UPDATE edr_tenants SET org_id = $org, mapping_source = $org ? 'manual' : 'manual_unmapped', detection_cursor = NULL, open_detection_count = 0, endpoint_count = 0`.
  5. Same org → no-op except `mapping_source = 'manual'` (confirming a suggestion).

- [ ] **Step 1: Write the failing tests** — unit (recording tx: statement order detach → delete → update; holding org refused; cross-partner tenant → NOT_FOUND) **and** an integration test in `src/__tests__/integration/edrProviderSync.integration.test.ts` (created here, extended in Task 18) for Review Focus 2:

```ts
runDb('remap tombstones history under the old org and a re-fetch never repoints it', async () => {
  // seed tenant T mapped to org A, endpoint E, detection D (vendor id X) under A
  // remapEdrTenant(T -> org B)
  // expect D: org_id A, detached_at set, tenant_id NULL; E deleted
  // persistDetections with a page containing vendor id X for T
  // expect a NEW row: org_id B, detached_at NULL; old row unchanged; an org-A token still sees D, an org-B token sees only the new row
});
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — PASS**, plus `npx vitest run src/__tests__/integrationOrgTargetHoldingOrg.contract.test.ts src/__tests__/parkedFanout.contract.test.ts src/__tests__/unassignedPoolVisibility.contract.test.ts src/__tests__/partner-wide-write-coverage.test.ts`
- [ ] **Step 5: Commit** — `git commit -m "feat(edr): tenant mapping with tombstoned history on remap (#3136)"`

---

## Task 15: Sync job — `jobs/edrProviderSync.ts` + worker registrations

**Files:**
- Create: `src/jobs/edrProviderSync.ts`, `src/jobs/edrProviderSync.test.ts`
- Modify: `src/services/workerRegistry.ts`, `src/services/workerRegistry.test.ts` (`EXPECTED_WORKER_NAMES`: insert `'edrProviderSyncWorker'` after `'backupProviderSyncWorker'`; bump the count assertion), `src/services/workerEntrypointClosure.contract.test.ts` (`EXPECTED_NAMES`, same position), `src/jobs/workerReadinessManifest.ts` (`consumers('edrProviderSyncWorker')` after `consumers('backupProviderSyncWorker')`)
- Modify: `src/__tests__/partner-wide-write-coverage.test.ts` (`services/edrProviders/persist.ts` worker-only entry, mirroring the backup one)

**Interfaces:**
- Consumes: Tasks 9–14.
- Produces:
  ```ts
  export const EDR_PROVIDER_SYNC_QUEUE = 'edr-provider-sync';
  export type EdrSyncJobData = { type: 'sync-all' } | { type: 'sync-inventory'; connectionId: string } | { type: 'sync-detections'; connectionId: string };
  export function edrSyncJobId(stream: 'inventory' | 'detections', connectionId: string): string;  // `edr-${stream}-${id}`
  export async function enqueueEdrSync(connectionId: string, stream: 'inventory' | 'detections'): Promise<string>;  // enqueueOrReplaceStale
  export async function syncEdrInventory(connectionId: string, o?: { isFinalAttempt?: boolean }): Promise<void>;
  export async function syncEdrDetections(connectionId: string, o?: { isFinalAttempt?: boolean }): Promise<void>;
  export function selectDueStreams(rows: DueRow[], now: Date): Array<{ connectionId: string; stream: 'inventory' | 'detections' }>;
  export async function initializeEdrProviderSyncJob(): Promise<void>;
  export async function shutdownEdrProviderSyncJob(): Promise<void>;
  ```

Phases (copy `syncConnectionById`'s structure and comments; differences in **bold**):

```ts
export async function syncEdrInventory(connectionId: string, o: { isFinalAttempt?: boolean } = {}) {
  // Phase 1 — short system tx: load connection (+ decrypt), mark last_inventory_sync_status='running',
  // return the updated_at fence; load this connection's tenants (id, vendor_tenant_id, org_id, api_host)
  // and the DETAIL_ENRICH_PER_RUN stalest linked-or-unlinked endpoint ids per mapped tenant.
  const loaded = await runWithSystemDbAccess(() => loadForSync(connectionId, 'inventory'), 'edrSync.loadInventory');
  if (!loaded) return;
  const adapter = getEdrProvider(loaded.connection.provider);
  const ctx = buildContext(adapter, loaded);              // guarded fetch + limiter (fingerprint) + runCache
  try {
    // Phase 2 — NO DB: runOutsideDbContext. listTenants is all-or-nothing (throws -> whole run fails, nothing written).
    const fetched = await dbModule.runOutsideDbContext(async () => {
      const vendorTenants = await adapter.listTenants(ctx, { id: loaded.connection.vendorRootId!, type: loaded.connection.vendorRootType });
      const results = await mapWithConcurrency(vendorTenants, adapter.capabilities.tenantFetchConcurrency, async (t) => {
        const known = loaded.tenantsByVendorId.get(t.vendorTenantId);
        try {
          if (!known?.orgId) return { vendorTenantId: t.vendorTenantId, ok: true as const,
            value: { endpoints: [], details: [], count: adapter.countEndpoints ? await adapter.countEndpoints(ctx, t) : undefined } };
          const endpoints = await adapter.listEndpoints(ctx, t);
          const details = adapter.enrichEndpoints ? await adapter.enrichEndpoints(ctx, t, loaded.staleDetailIds.get(known.id) ?? []) : [];
          return { vendorTenantId: t.vendorTenantId, ok: true as const, value: { endpoints, details } };
        } catch (err) {
          if (err instanceof EdrProviderRequestError && err.scope === 'connection') throw err;   // reauth / budget: whole run
          return { vendorTenantId: t.vendorTenantId, ok: false as const, error: safeMessage(err), scope: 'tenant' as const };
        }
      });
      return { vendorTenants, results };
    });
    // Phase 3 — one system tx + pg_advisory_xact_lock(hashtext('edr-provider-sync'), hashtext(id)):
    // re-read connection FOR UPDATE; abort silently if deleted/inactive/fence moved (credentials changed);
    // upsertTenants -> autoMapEdrTenants -> persistInventory -> pruneMissingTenantEndpoints ->
    // matchEdrEndpoints -> refreshDetectionDeviceLinks -> counters + last_inventory_sync_* + status 'connected'
    // + capabilities_snapshot + effective intervals (planCadence).
  } catch (error) {
    // identical to backup: reauth (EdrProviderRequestError.reauth or marker) -> UnrecoverableError + status
    // 'reauth_required' at any attempt; rate_budget_exhausted -> NOT reauth, rethrow for BullMQ backoff;
    // other -> final attempt records last_inventory_sync_status='error' in a FRESH tx (runOutsideDbContext +
    // withSystemDbAccessContext), earlier attempts leave 'running'.
  }
}
```

`syncEdrDetections` is the same skeleton: Phase 1 loads mapped, non-missing tenants with their cursors; Phase 2 calls `listDetections(ctx, t, cursor, now)` per tenant (unmapped tenants are **not** fetched); Phase 3 `persistDetections` + `refreshDetectionDeviceLinks` + `last_detection_sync_*`. **No Phase 4 in W01** (events/alerts land in W02 and evaluate persisted rows vs `notified_severity`).

`sync-all` (repeatable every 5 min): system-context read of `is_active AND status <> 'reauth_required'` connections with both streams' `last_*_sync_at` and effective intervals → `selectDueStreams` (pure) → `enqueueEdrSync` for each due stream, outside any DB context. Inventory and detections have **separate job ids** so neither coalesces the other away; both serialize on the same advisory lock in Phase 3.

Worker: `concurrency: 4, lockDuration: 300_000, stalledInterval: 60_000, maxStalledCount: 2`; `attachWorkerObservability(worker, 'edrProviderSyncWorker')`; reauth failures are logged, **not** sent to Sentry (backup's BREEZE-1 lesson). Queue via `createInstrumentedQueue` (the #1105 enqueue tripwire).

`workerRegistry.ts` entry:

```ts
  {
    // EDR provider framework W01 (#3136). 'global': its import closure reaches no socket-local
    // dispatch (no alerts/events until W02 — re-verify placement then with
    // workerEntrypointClosure.contract.test.ts).
    name: 'edrProviderSyncWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/edrProviderSync');
      return { init: m.initializeEdrProviderSyncJob, shutdown: m.shutdownEdrProviderSyncJob };
    },
  },
```

- [ ] **Step 1: Write the failing tests** (`edrProviderSync.test.ts`, mocks for db/redis/adapter like `backupProviderSync.test.ts`):

```ts
it('selectDueStreams: never-synced is due; each stream uses its own interval', …);
it('vendor calls run inside runOutsideDbContext and no db call happens between phase 1 and phase 3', …);
it('one tenant failing with scope tenant does not fail the job; others persist; connection stays connected (Review Focus 3)', …);
it('a connection-scope reauth error marks reauth_required and throws UnrecoverableError on the FIRST attempt', …);
it('rate_budget_exhausted is retried by BullMQ and never marks reauth_required', …);
it('fence moved during phase 2 (credentials PATCHed) -> nothing written, no throw', …);
it('unmapped tenants are counted via countEndpoints and never have endpoints or detections fetched', …);
it('an earlier attempt failure leaves status running; the final attempt records error', …);
```

- [ ] **Step 2: Run — FAIL.** `npx vitest run src/jobs/edrProviderSync.test.ts src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts`
- [ ] **Step 3: Implement + register.**
- [ ] **Step 4: Run — PASS** (all three files).
- [ ] **Step 5: Commit** — `git commit -m "feat(edr): edr-provider-sync worker with inventory and detection streams (#3136)"`

---

## Task 16: Routes — access gate, providers catalog, connections

**Files:**
- Create: `src/routes/edr/access.ts` (+ `.test.ts`), `providers.ts` (+ `.test.ts`), `connections.ts` (+ `.test.ts`), `index.ts`
- Modify: `src/index.ts` (`import { edrRoutes } from './routes/edr'; … api.route('/edr', edrRoutes);` next to `/backup`)
- Modify: `src/middleware/selfManagedDbContextRoutes.ts` (three entries, comment mirroring the backup block at ~line 452)
- Modify: `src/services/mcpCoverage.ts` (`'edr/providers.ts'`, `'edr/connections.ts'` → `{ exempt: 'vendor_console_admin', note: … }`; no entry for the `edr/index.ts` hub — see registration row 10)
- Modify: `src/__tests__/partner-wide-write-coverage.test.ts` (`routes/edr/connections.ts` entry like `routes/backup/providers.ts`)

**Interfaces:**
- Produces:
  ```ts
  // access.ts — copy of routes/backup/providerAccess.ts with EDR names
  export function resolveEdrPartnerId(auth: EdrRouteAuth): { partnerId: string } | GateFailure;     // org scope -> 403
  export function requireEdrPartnerAdmin(auth: EdrRouteAuth): { partnerId: string } | GateFailure;  // + canManagePartnerWidePolicies
  export const EDR_CONNECTION_PUBLIC_SELECT;   // every column EXCEPT *_encrypted, plus hasCredentials / hasWebhookSecret booleans
  ```

Routes (all `requireScope('partner', 'system')`):

| Method + path | Gate | Behaviour |
|---|---|---|
| `GET /edr/providers` | `ORGS_READ` + `resolveEdrPartnerId` | `listEdrProviders()` → `{ key, label, credentialFields, baseUrlPolicy, capabilities }` (no secrets exist here) |
| `GET /edr/connections` | `ORGS_READ` + `resolveEdrPartnerId` | `EDR_CONNECTION_PUBLIC_SELECT` rows of the partner |
| `POST /edr/connections` | `ORGS_WRITE` + `requireMfa()` + `requireEdrPartnerAdmin` | registry lookup (400 unknown) → `credentialsSchema.safeParse` (400) → `validateVendorUrl(baseUrl, adapter.hostAllowlist, baseUrlPolicy)` (400, required for GravityZone) → `connectionId = randomUUID()` → `testConnection` **outside any DB context** (422 on failure, no row) → short `withAuthDbAccessContext` insert with `encryptEdrSecret('connection_credentials', connectionId, creds)`, `vendor_root_*`, `capabilities_snapshot` (23505 → 409 `DUPLICATE_CONNECTION_NAME`) → `writeRouteAudit` (`edr.connection.create`, no secret in details) → `runOutsideDbContext(() => enqueueEdrSync(id, 'inventory'))` |
| `PATCH /edr/connections/:id` | write gate | name / isActive / interval overrides; `credentials` and `baseUrl` are write-only: re-validate, re-test outside DB, re-encrypt under the same row id, `status = 'connected'` (clears `reauth_required`), `updated_at` moves (fences any in-flight sync) |
| `POST /edr/connections/:id/test` | write gate | decrypt in a short context, test outside DB, write `status`/`capabilities_snapshot` in a fresh short context |
| `POST /edr/connections/:id/sync` | write gate | enqueue both streams outside DB context (no vendor HTTP → not self-managed) |
| `DELETE /edr/connections/:id` | write gate | D13: the only hard-delete path. Without `?confirm=<openDetectionCount>:<endpointCount>` matching the current counts → 409 `{ code: 'CONFIRM_COUNTS', detections, endpoints, tenants }`; with it → delete (FK cascades remove tenants, endpoints, detections, actions) + audit with the counts |

- [ ] **Step 1: Write the failing tests** (route tests in the `routes/backup/providers.test.ts` style: mocked db, auth, registry, adapter):

```ts
it('org-scoped token -> 403 on every route, including GET', …);
it.each(['POST /connections', 'PATCH /connections/:id', 'POST /connections/:id/test', 'POST /connections/:id/sync', 'DELETE /connections/:id'])(
  'selected-org partner user -> 403 on %s (Review Focus 5)', …);
it('POST with an Access URL outside .gravityzone.bitdefender.com -> 400 and the adapter is never called', …);
it('POST with a failing vendor test -> 422 and nothing inserted', …);
it('POST: credentials are sealed under the generated row id and never echoed in the response or audit', …);
it('no route response contains credentials_encrypted / webhook_secret_encrypted (select-list pin)', …);
it('PATCH credentials resets status to connected and moves updated_at', …);
it('DELETE without matching confirm counts -> 409 with the counts; with them -> 200', …);
it('enqueue happens outside the db context (runOutsideDbContext spy)', …);
```

- [ ] **Step 2: Run — FAIL.** `npx vitest run src/routes/edr/`
- [ ] **Step 3: Implement** + registrations (self-managed routes: `POST ^/api/v1/edr/connections/?$`, `PATCH ^/api/v1/edr/connections/[^/]+/?$`, `POST ^/api/v1/edr/connections/[^/]+/test/?$`).
- [ ] **Step 4: Run — PASS** + `npx vitest run src/__tests__/mcp-coverage.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/middleware`
- [ ] **Step 5: Commit** — `git commit -m "feat(edr): partner-admin connection routes (#3136)"`

---

## Task 17: Routes — tenants/mapping and endpoint link

**Files:**
- Create: `src/routes/edr/tenants.ts` (+ `.test.ts`), `src/routes/edr/endpoints.ts` (+ `.test.ts`); mount both in `routes/edr/index.ts`
- Modify: `src/services/mcpCoverage.ts` (`'edr/tenants.ts'`, `'edr/endpoints.ts'` → `vendor_console_admin`, notes like `backup/providerCustomers.ts` / `providerDevices.ts`)

| Method + path | Gate | Behaviour |
|---|---|---|
| `GET /edr/connections/:id/tenants` | `ORGS_READ` + `resolveEdrPartnerId` | tenants (no `installer_secret_encrypted`; `hasInstallerSecret` boolean) + name suggestions + per-tenant sync state + `vendor_missing_since` |
| `PUT /edr/tenants/:id/mapping` `{ orgId: uuid \| null }` | `ORGS_WRITE` + `requireMfa()` + `requireEdrPartnerAdmin` | advisory lock + `remapEdrTenant` (the route never calls `.update(edrTenants)` itself, so the holding-org discovery scanner stays at its pinned count — the service is in `ORG_TARGET_WRITERS`); `NOT_FOUND` → 404, `ORG_NOT_IN_PARTNER` → 422, `HOLDING_ORG` → 422; audit `edr.tenant.map` with previous/new org and tombstone counts; enqueue both streams after commit, outside DB context |
| `GET /edr/endpoints?connectionId&state=unlinked\|ambiguous\|linked\|all` | `DEVICES_READ`; org **or** partner scope (rows are org-scoped, RLS narrows); site-restricted callers see only rows whose `breeze_device_id` is in an allowed site **or** NULL | list for the manual-link UI |
| `PUT /edr/endpoints/:id/link` `{ deviceId: uuid \| null }` | `DEVICES_WRITE` + `requireMfa()` | copy `routes/backup/providerDevices.ts` `PUT /devices/:id/link`: RLS-visible row or 404; site ceiling on the **previous** and the **new** device (fail closed without `permissions`); device must be in the row's org (pre-check → 422 `DEVICE_ORG_MISMATCH`; 23503 backstop in a savepoint); 23505 → 409 `DEVICE_ALREADY_LINKED` (same connection); set `device_match_source = 'manual'` / NULL with the link; **in the same savepoint** rewrite `breeze_device_id` on this endpoint's **open, non-detached** detections (spec §4.2); audit `edr.endpoint.link`/`unlink` |

- [ ] **Step 1: Write the failing tests**:

```ts
it('PUT mapping: selected-org partner user -> 403; org token -> 403 (Review Focus 5)', …);
it('PUT mapping to a holding org -> 422 and nothing changes', …);
it('PUT mapping to an org of another partner -> 422', …);
it('GET tenants never includes installer_secret_encrypted', …);
it('PUT link: device in another org -> 422 DEVICE_ORG_MISMATCH; previous device in a denied site -> 403; new device in a denied site -> 403', …);
it('PUT link rewrites breeze_device_id on open detections only, in the same transaction', …);
it('GET endpoints as a site-restricted user excludes rows linked to foreign-site devices', …);
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — PASS** + the contract set: `npx vitest run src/routes/edr/ src/__tests__/mcp-coverage.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/integrationOrgTargetHoldingOrg.contract.test.ts`; and `pnpm --filter @breeze/api test:site-scope-coverage` (path filter is `:id`, not `:deviceId`, so the scanner does not flag it — the site checks above are the real control; confirm the scanner count is unchanged).
- [ ] **Step 5: Commit** — `git commit -m "feat(edr): tenant mapping and endpoint link routes (#3136)"`

---

## Task 18: Real-Postgres sync proof, full contract run, sandbox gate, open W01b

**Files:**
- Extend: `src/__tests__/integration/edrProviderSync.integration.test.ts` (created in Task 14)

**Interfaces:**
- Consumes: everything. The adapter is exercised through `vi.mock('../../services/edrProviders/bitdefender/client')` returning fixture-backed data, so the real persist/match/RLS paths run against Postgres.

- [ ] **Step 1: Write the integration cases**

```ts
runDb('inventory sync persists endpoints only for mapped companies and links a hostname match in the same org', …);
runDb('a company whose fetch fails keeps its existing endpoints; the connection stays connected', …);
runDb('vendor fetch happens with no held DB context (DB_CONTEXT_TRIPWIRE_STRICT=true)', …);
runDb('detection sync upserts idempotently across overlapping windows and advances only that tenant cursor', …);
runDb('a company missing from listTenants is tombstoned, not deleted; its endpoints go after 7 days', …);
runDb('remap tombstones history under the old org and a re-fetch never repoints it (Review Focus 2)', …);   // from Task 14
runDb('device org-move detaches endpoint/detection/action links and stamps last_site_id', …);
runDb('device hard delete stamps device_detached_at + last_site_id before the FK clears the link', …);
runDb('two connections may link the same device (per-connection uniqueness)', …);
```

- [ ] **Step 2: Run the whole local gate on the test stack** (CI's Integration Tests is the only other place these run):

```bash
pnpm test-stack up && set -a && . ./.env.test && set +a
cd apps/api
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/edrProviderRls.integration.test.ts \
  src/__tests__/integration/edrProviderSync.integration.test.ts \
  src/__tests__/integration/backupProviderRls.integration.test.ts \
  src/__tests__/integration/backupProviderSync.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenantCascadeErasureBreadth.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts
cd ../.. && DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm --filter @breeze/api test:integration-suite-coverage
pnpm --filter @breeze/api test --run          # FULL unit suite: orgMerge.test.ts only reds here
pnpm --filter @breeze/shared test --run
pnpm db:check-drift          # sanity only (no schema-vs-DB comparison)
pnpm test-stack down
```

Expected: every file PASS, file counts match the list (11 integration files). Typecheck via the CI job or `cd apps/api && npx tsc --noEmit` (heap: `NODE_OPTIONS=--max-old-space-size=8192` if it OOMs).

- [ ] **Step 3: Sandbox gate (blocks production registration — record the run in the PR)**

Prerequisite from Todd: a **GravityZone MSP/partner trial** (Bitdefender MSP Partner Program — 25-endpoint monthly trial, or an NFR licence at Bronze tier; the public 30-day/50-seat trial is a single company and only exercises the `rootType 'company'` path) with an API key generated in My Account with **Companies + Network** enabled (add **Incidents** and **Quarantine** to exercise detections; the incidents path also needs the EDR/incidents add-on on the test company). Store the key only in the lab stack's DB via the API; never in a file in the repo.

Lab run (worktree stack via the `worktree-stack` skill; GravityZone agent on a **nested brzlab VM**, never a host with an installed Breeze agent):
1. `POST /api/v1/edr/connections` `{ provider: 'bitdefender', name, baseUrl: '<Access URL>', credentials: { apiKey } }` → 201, `capabilities_snapshot` notes match the key's enabled APIs.
2. `GET …/tenants` → the trial companies; `PUT /edr/tenants/:id/mapping` → lab org.
3. Wait for the inventory stream (or `POST …/sync`) → the VM's endpoint row exists, linked to the VM's Breeze device if it also runs a Breeze agent **inside the nested VM**; health/online populated by enrichment.
4. Drop an EICAR file on the VM → quarantine detection persisted; with the EDR add-on, an incident persisted; change its status in the console → status update arrives on the next detection run.
5. Revoke the key → the connection flips to `reauth_required`, no Sentry event.
6. Record: request counts per run vs the budget, any `[U]` fact from the "API facts" table confirmed or corrected (severity buckets, incident status values, quarantine `actionStatus` values, quarantine scope without `endpointId`, `state` values, incidents max window), and fix the adapter/fixtures for each correction before merge.

- [ ] **Step 4: Open W01b**

PR body: summary, registration checklist rows 9–17 ticked, Review Focus list with the test names that pin each, sandbox-run record (or "BLOCKED on sandbox credentials" — then the PR may merge with the adapter registered, because a provider with no connection does nothing, but the wave stays open until the run is recorded), `Closes #<W01 sub-issue>`. If still stacked on W01a: `gh workflow run CI --ref <branch>`. One independent review round (Sonnet — credentials/SSRF/tenancy).

- [ ] **Step 5: Commit** — `git commit -m "test(edr): real-Postgres sync, remap and org-move proofs (#3136)"`

---

## Self-review notes (author, 2026-10-01)

- Spec coverage: §4.2 tables (Task 2), §4.3 interface (Task 9; action/webhook/installer members typed only), §4.4 sync (Task 15; Phase 4 → W02), §4.5 mapping (Tasks 7, 14), §4.6 matching (Tasks 8, 13; serial deferred — index correction 9), §4.9 credentials/SSRF/gates (Tasks 10, 16, 17), §5 registrations (Tasks 4, 5, 6 + checklist), D3 many connections (unique on partner+provider+name), D4 (Tasks 3–5), D5 (Tasks 13, 15), D10 (Task 13 rule 2), D12 (Task 2 CHECKs), D13 (Tasks 2, 14), D14 (Task 5 writes `last_site_id`; the predicate that reads it is W02). Out of W01 by design: §4.7 feed, §4.8 webhooks, §4.10–4.11 actions/AI, §4.12 UI, §4.13 installers, §4.14 agent, D11 retention (W02).
- Type names used across tasks: `EdrProviderAdapter`, `EdrAdapterContext`, `EdrProviderRequestError`, `VendorEdrTenant`/`Ref`, `VendorEdrEndpoint`/`Detail`, `VendorEdrDetection`, `EdrDetectionPage`, `PersistConnection`, `TenantFetch`, `EdrSyncTx`, `remapEdrTenant`, `matchEdrEndpoints`, `enqueueEdrSync`, `requireEdrPartnerAdmin` — consistent.
