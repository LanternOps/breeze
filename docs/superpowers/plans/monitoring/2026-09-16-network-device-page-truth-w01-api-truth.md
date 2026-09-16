---
tracking_issue: LanternOps/breeze#5988
---
# Network Device Page Truth W01: API Truth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every status claim the API makes about a discovered network asset sourced and dated — one derived `reachability` object on every consumer, a manual probe, durable SNMP collection health, per-OID metric history — so W02–W05 build on fixed names and never re-derive "online" from a 19-hour-old subnet sweep.

**Architecture:** Three idempotent migrations add provenance/probe columns to `discovered_assets`, instance/error columns plus a composite index to `snmp_metrics`, and `poll_seq` to `snmp_devices`. Two pure services (`assetReachability.ts`, `snmpCollectionState.ts`) hold every rule with no I/O; one batched loader (`assetReachabilityLoader.ts`) assembles their inputs for list and detail routes; `networkExecutorSelection.ts` becomes the single site-strict executor picker shared by the monitor worker, the monitors `/test` route and the new probe. Routes stay thin: `POST /discovery/assets/:id/probe` and `GET /monitoring/assets/:id/metrics` live in their own files rather than growing `discovery.ts` (2,247 lines) or `monitoring.ts` (1,071 lines).

**Tech Stack:** PostgreSQL + hand-written SQL migrations, Drizzle ORM, Hono + Zod, BullMQ, Vitest (API unit with Drizzle mocks; API integration on real Postgres).

**Spec:** `docs/superpowers/specs/monitoring/2026-09-16-network-device-page-truth-design.md` (approved 2026-09-16). Sections §4 (all), §5, §6.1–6.3, §7.3, §7.5, §9 (read-time mask + `nicVendor` only), §12 (W01 rows), §13 (the three W01 migrations), §14, §15 (W01 tests) are this wave. Where this plan is more specific than the spec (exact input shapes, the decision to reuse the existing retention worker, the `/test` site-strictness change), the plan wins; each such point is called out inline as **DECISION**.

## Global Constraints

- Migration filenames are reserved by the plan index: `2026-10-17-110000-discovered-assets-status-provenance-and-probe.sql`, `2026-10-17-110100-snmp-metrics-instances-errors-index.sql`, `2026-10-17-110200-snmp-devices-poll-seq.sql`. Re-check with `ls apps/api/migrations | grep '\.sql$' | sort | tail -1` before EVERY commit (newest committed as of 2026-09-16: `2026-10-16-193300-software-deployments-policy-origin.sql`) and rename upward if main moved past them.
- Every migration is idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`), carries no inner `BEGIN;`/`COMMIT;`, and writes **no rows**. None of the three needs `SELECT set_config('breeze.scope','system',true);` — if a later edit adds an `UPDATE`/`INSERT`/`DELETE`, that statement goes first in the file and the file must NOT be added to the frozen baseline in `apps/api/src/db/migrationRlsScope.test.ts`.
- Every new column is added to `CORE_TENANT_EXPORT_POLICY` (`apps/api/src/services/tenantExportPolicyRegistry.ts`) **in the same task as its migration**, bucket `included`. All ten new columns (`status_observed_at`, `status_source`, `last_probe_at`, `last_probe_status`, `last_probe_response_ms`, `last_probe_ref`, `poll_seq`, `base_oid`, `instance`, `error`) are scalars and none matches `SUSPICIOUS_NAME_PARTS` (`apps/api/src/services/tenantExportPolicy.ts:35`; `ref` is not `refresh`), so none needs `reviewedIncluded`.
- No new tables → no RLS policy, no `CORE_ORG_CASCADE_DELETE_ORDER`, no `CORE_DEVICE_CASCADE_DELETE_TABLES`, no `orgMergeRegistry` change. Do not add any.
- All routes run inside the request `withDbAccessContext` opened by `authMiddleware`/`apiKeyAuth` — never call `withSystemDbAccessContext` or `runOutsideDbContext(() => withSystemDbAccessContext(...))` inside a route handler. Asset-bound writes use the site-locking resolver `resolveAssetForMutation` (Task 9), which takes `.for('update')` on the asset row inside the ambient request transaction.
- Run one test file as `cd apps/api && npx vitest run <path>` — never `pnpm --filter @breeze/api test -- --run <path>` (the `--` is forwarded literally and vitest runs the whole 1,470-file suite in watch mode).
- Integration suites need `pnpm test-stack up` (once for the wave, `pnpm test-stack down` at the end) and run as `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`. They are run before the PR, always — this wave adds columns to an org-cascade table.
- Branch `feature/<parent#>-network-device-page-truth/wave-<W01 sub-issue#>`; PR body contains `Closes #<W01 sub-issue>`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Keep files under ~500 lines. New logic goes in new focused files; do not grow `routes/discovery.ts` (2,247) or `routes/monitoring.ts` (1,071) further. Two new route modules are mounted as sibling sub-routers in `apps/api/src/index.ts` (duplicate mount prefixes are an established pattern there: `/orgs`, `/ai`, `/admin`, `/events` and six others are each mounted twice).

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-17-110000-discovered-assets-status-provenance-and-probe.sql` | six columns on `discovered_assets` (§4.3, §5) |
| `apps/api/migrations/2026-10-17-110100-snmp-metrics-instances-errors-index.sql` | `base_oid`/`instance`/`error` + composite index on `snmp_metrics` (§7.3, §7.5), `-- @no-transaction` |
| `apps/api/migrations/2026-10-17-110200-snmp-devices-poll-seq.sql` | `snmp_devices.poll_seq` (§7.1, consumed by W02) |
| `apps/api/src/db/schema/discovery.ts` | add the six `discoveredAssets` columns |
| `apps/api/src/db/schema/snmp.ts` | add `snmpMetrics.baseOid/instance/error`, `snmpDevices.pollSeq`, the composite index |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | classify all ten new columns as `included` |
| `apps/api/src/services/assetReachability.ts` (+ `.test.ts`) | pure §4.2 rules, `deriveReachability`, `reachabilityToListStatus` |
| `apps/api/src/services/assetReachabilityLoader.ts` (+ `.test.ts`) | batched `loadReachabilityInputs(assetIds)` |
| `apps/api/src/services/assetIdentity.ts` (+ `.test.ts`) | `maskOidShapedModel`, `nicVendorFromMac` (§9 read-time guard) |
| `apps/api/src/services/networkExecutorSelection.ts` (+ `.test.ts`) | `selectNetworkExecutor`, `loadAssetSiteId` — extracted from `jobs/monitorWorker.ts` |
| `apps/api/src/services/assetAccessScope.ts` | `resolveOrgIdForAuth`, `resolveOrgIdForAsset`, `resolveAssetForMutation` — moved verbatim out of `routes/monitoring.ts`, so `monitoring.test.ts` is its coverage |
| `apps/api/src/services/assetProbe.ts` (+ `.test.ts`) | probe command ids, the in-process awaiter, `applyProbeResult` CAS |
| `apps/api/src/services/snmpCollectionState.ts` (+ `.test.ts`) | pure §6.2 derivation, `defaultOidMode`/`defaultOidCadence` (W02 reuses) |
| `apps/api/src/routes/discoveryAssetProbe.ts` (+ `.test.ts`) | `POST /discovery/assets/:id/probe` (§5) |
| `apps/api/src/services/metricBucketing.ts` (+ `.test.ts`) | pure bucket choice, range/point/series caps, reset-aware counter deltas (§6.3) |
| `apps/api/src/routes/monitoringAssetMetrics.ts` (+ `.test.ts`) | `GET /monitoring/assets/:id/metrics` (§6.3) |
| `apps/api/src/index.ts` | mount the two new sub-routers |
| `apps/api/src/jobs/monitorWorker.ts` | `selectExecutionAgentForMonitor` delegates to the new service |
| `apps/api/src/routes/monitors.ts` | `/test` uses the shared site-strict picker |
| `apps/api/src/jobs/snmpWorker.ts` | `no_template` (§6.1), protocol-2 ingestion + all-error `warning` (§7.3) |
| `apps/api/src/jobs/snmpWorkerScheduler.test.ts` | extend the backoff `it.each` contract for `no_template` |
| `apps/api/src/jobs/snmpWorker.ingestion.test.ts` | new: protocol-2 row ingestion |
| `apps/api/src/jobs/discoveryWorker.ts` | stamp `status_observed_at`/`status_source` at three writers |
| `apps/api/src/services/unifi/unifiSyncService.ts`, `unifiTelemetryService.ts` | stamp at the other two writers |
| `apps/api/src/routes/discovery.ts` | `reachability` on `/assets`, `/assets/:id`, topology node status; model mask + `nicVendor` |
| `apps/api/src/routes/devices/network.ts` | `status` from `reachabilityToListStatus`, `reachability` on the row |
| `apps/api/src/routes/monitoring.ts` | `reachability` + `collection` on `/assets` and `/assets/:id`; use the extracted scope helpers |
| `apps/api/src/services/aiToolsMonitoring.ts` | `query_monitors` reports asset reachability with source and age |
| `apps/api/src/services/aiToolsNetwork.ts` | new `get_network_asset_reachability` tool (see Task 6 DECISION) |
| `apps/api/src/jobs/snmpRetention.ts` (+ `.test.ts`) | retention default 7 → 30 days (§7.5 — no new job, see Task 14) |
| `apps/api/src/__tests__/integration/networkDeviceTruth.integration.test.ts` | probe correlation rejects a moved asset; metrics bucketing on real Postgres |

---

### Task 1: Migration 1 — `discovered_assets` provenance and probe columns

**Files:**
- Create: `apps/api/migrations/2026-10-17-110000-discovered-assets-status-provenance-and-probe.sql`
- Modify: `apps/api/src/db/schema/discovery.ts:143-201` (the `discoveredAssets` table)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (the `"discovered_assets"` entry, ~line 266)

**Interfaces:**
- Produces columns `discovered_assets.status_observed_at timestamptz NULL`, `status_source varchar(16) NULL`, `last_probe_at timestamptz NULL`, `last_probe_status varchar(12) NULL`, `last_probe_response_ms integer NULL`, `last_probe_ref varchar(80) NULL`; CHECK constraints `discovered_assets_status_source_chk`, `discovered_assets_last_probe_status_chk`.
- Produces Drizzle fields `discoveredAssets.statusObservedAt`, `.statusSource`, `.lastProbeAt`, `.lastProbeStatus`, `.lastProbeResponseMs`, `.lastProbeRef`.

- [ ] **Step 1: Write the migration**

```sql
-- Network device page truth W01 (spec docs/superpowers/specs/monitoring/2026-09-16-network-device-page-truth-design.md §4.3, §5).
--
-- Six expansion-only columns on discovered_assets. No DML, so no
-- `SELECT set_config('breeze.scope','system',true)` preamble and deliberately
-- NO entry in the frozen baseline of apps/api/src/db/migrationRlsScope.test.ts.
-- No new table: discovered_assets already carries its shape-1 org_id policies,
-- its CORE_ORG_CASCADE_DELETE_ORDER entry and its device-side cascade entries.
-- Adding COLUMNS to it DOES require a CORE_TENANT_EXPORT_POLICY update, which
-- ships in the same commit.
--
-- status_observed_at / status_source: WHEN the is_online verdict was taken and
-- BY WHOM. is_online keeps its meaning exactly ("last scan/controller
-- verdict"); nothing derives reachability from it any more. NULL on every
-- pre-existing row and on manual rows that no scan has touched — the
-- reachability service treats an undated is_online=false as NO observation
-- rather than a stale negative claim.
--
-- last_probe_*: the manual "Check now" probe (§5). last_probe_ref holds the
-- dispatched agent command id (`probe-<assetUuid>-<epochMillis>`, 5 + 36 + 1 +
-- 13 = 55 chars today; 80 leaves room) and is the correlation key the result
-- handler compare-and-swaps against.

ALTER TABLE discovered_assets
  ADD COLUMN IF NOT EXISTS status_observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_source VARCHAR(16),
  ADD COLUMN IF NOT EXISTS last_probe_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_probe_status VARCHAR(12),
  ADD COLUMN IF NOT EXISTS last_probe_response_ms INTEGER,
  ADD COLUMN IF NOT EXISTS last_probe_ref VARCHAR(80);

DO $$ BEGIN
  ALTER TABLE discovered_assets ADD CONSTRAINT discovered_assets_status_source_chk
    CHECK (status_source IS NULL OR status_source IN ('scan','unifi'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE discovered_assets ADD CONSTRAINT discovered_assets_last_probe_status_chk
    CHECK (last_probe_status IS NULL OR last_probe_status IN ('pending','ok','failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The in-flight-probe guard (409 PROBE_IN_FLIGHT) reads
-- (id, last_probe_status, last_probe_at) by primary key, so no index is needed.
-- Nothing scans discovered_assets BY probe state.
```

- [ ] **Step 2: Add the Drizzle columns**

In `apps/api/src/db/schema/discovery.ts`, inside `discoveredAssets`, immediately after `lastSeenAt` (line 181):

```ts
  // W01 (spec §4.3) — WHEN the is_online verdict above was taken and by WHOM.
  // `is_online` / `last_seen_at` keep their existing meanings; these two exist
  // so services/assetReachability.ts can date and rank the scan/UniFi claim
  // against SNMP, network checks and probes instead of trusting it blind.
  statusObservedAt: timestamp('status_observed_at', { withTimezone: true }),
  statusSource: varchar('status_source', { length: 16 }).$type<'scan' | 'unifi'>(),
  // W01 (spec §5) — the manual "Check now" probe. last_probe_ref is the agent
  // command id the result handler compare-and-swaps against.
  lastProbeAt: timestamp('last_probe_at', { withTimezone: true }),
  lastProbeStatus: varchar('last_probe_status', { length: 12 }).$type<'pending' | 'ok' | 'failed'>(),
  lastProbeResponseMs: integer('last_probe_response_ms'),
  lastProbeRef: varchar('last_probe_ref', { length: 80 }),
```

`timestamp`, `varchar` and `integer` are already imported at the top of the file.

- [ ] **Step 3: Classify the six columns in the export policy**

In `apps/api/src/services/tenantExportPolicyRegistry.ts`, replace the `"discovered_assets"` entry's leading comment and `included` array (the entry currently ends `…,"source","url","created_at","updated_at"`):

```ts
  // #5213 — `source` is a three-value classifier (scan|unifi|manual), the same
  // shape as type_source; `url` is ordinary customer inventory data. Neither is
  // jsonb/bytea and neither matches SUSPICIOUS_NAME_PARTS, so both are plain
  // `included`.
  //
  // Network device page truth W01 (spec §4.3, §5) — status_observed_at /
  // status_source date and attribute the is_online verdict; last_probe_* record
  // one on-demand ICMP probe (a timestamp, a three-value state, a latency and
  // the agent command id it correlates to). All six are scalars, none is an
  // open container, and `last_probe_ref` does NOT match SUSPICIOUS_NAME_PARTS
  // ('refresh' is the entry, 'ref' is not a prefix match) — plain `included`.
  "discovered_assets": tablePolicy("org_id", {"included":["id","org_id","site_id","ip_address","mac_address","hostname","label","netbios_name","asset_type","approval_status","is_online","approved_by","approved_at","dismissed_by","dismissed_at","manufacturer","model","response_time_ms","linked_device_id","link_source","auto_link_suppressed_at","type_source","detected_asset_type","detected_type_source","first_seen_at","last_seen_at","last_job_id","discovery_methods","notes","tags","source","url","status_observed_at","status_source","last_probe_at","last_probe_status","last_probe_response_ms","last_probe_ref","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["open_ports","os_fingerprint","snmp_data"]}),
```

- [ ] **Step 4: Run the naming and RLS-scope guards**

Run: `scripts/check-migration-naming.sh --against-ref origin/main && cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`
Expected: both PASS. The new file writes no rows, so it is not a scope offender.

- [ ] **Step 5: Apply against the worktree test stack, twice**

Run: `pnpm test-stack up` (once for the whole wave), then
`cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm db:migrate && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm db:migrate`
Expected: the first run applies the file; the second is a no-op with no errors. Then `pnpm db:check-drift` reports no difference for `discovered_assets`.

- [ ] **Step 6: Verify the CHECK constraints as `breeze_app`**

Run:
```bash
docker exec -i $(docker ps --format '{{.Names}}' | grep -m1 postgres) \
  psql -U breeze_app -d breeze -c \
  "insert into discovered_assets (org_id, site_id, status_source) values (gen_random_uuid(), gen_random_uuid(), 'bogus');"
```
Expected: the statement fails. Either error is a pass — `new row for relation "discovered_assets" violates check constraint "discovered_assets_status_source_chk"` proves the CHECK, and `new row violates row-level security policy` proves RLS rejected the forged org first. Re-run with a real in-tenant org/site if you want to see the CHECK specifically.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-10-17-110000-discovered-assets-status-provenance-and-probe.sql \
        apps/api/src/db/schema/discovery.ts \
        apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "$(cat <<'EOF'
feat(monitoring): discovered_assets status provenance and probe columns (W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Migrations 2 and 3 — `snmp_metrics` instances/errors/index and `snmp_devices.poll_seq`

**Files:**
- Create: `apps/api/migrations/2026-10-17-110100-snmp-metrics-instances-errors-index.sql`
- Create: `apps/api/migrations/2026-10-17-110200-snmp-devices-poll-seq.sql`
- Modify: `apps/api/src/db/schema/snmp.ts` (`snmpDevices`, `snmpMetrics`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`"snmp_devices"`, `"snmp_metrics"` entries, ~lines 548-550)

**Interfaces:**
- Produces columns `snmp_metrics.base_oid varchar(200) NULL`, `instance varchar(64) NULL`, `error varchar(32) NULL`; index `snmp_metrics_device_oid_ts_idx (device_id, oid, timestamp DESC)`; column `snmp_devices.poll_seq integer NOT NULL DEFAULT 0`.
- Produces Drizzle fields `snmpMetrics.baseOid/.instance/.error`, `snmpDevices.pollSeq`.
- `snmp_metrics.value_type` gains the value `'error'` and `snmp_devices.last_status` the value `'no_template'` — both are `varchar`, not enums, so neither needs DDL.

- [ ] **Step 1: Write migration 2 (`-110100`)**

```sql
-- @no-transaction
-- Network device page truth W01 (spec §7.3, §7.5) — server-side ingestion of
-- the protocol-2 SNMP result shape, BEFORE any agent ships it (§7.4 is W02).
--
-- base_oid / instance: a walked table column emits one row per instance
-- (base_oid = the column OID, instance = the row suffix). Legacy agents send
-- neither, and the server writes base_oid = NULL for them; §6.2's derivation
-- matches legacy rows by `oid` instead. There is NO backfill, deliberately: a
-- historical row's oid IS its base oid, and rewriting 30 days of hot metric
-- rows to say so buys nothing the COALESCE in the read already gives.
--
-- error: the per-OID failure code a protocol-2 agent reports
-- (noSuchObject | noSuchInstance | endOfMib | timeout | truncated). Such a row
-- stores value = NULL, value_type = 'error'. `value_type` is varchar(20), not
-- an enum, so 'error' needs no DDL.
--
-- The index serves GET /monitoring/assets/:id/metrics (§6.3), which scans one
-- device, one or more OIDs, over a time window. Existing indexes are
-- single-column (device_id), (oid), (timestamp) — none serves the triple, and
-- the metrics endpoint's 90-day cap makes a seq scan on this table untenable.
--
-- @no-transaction + CREATE INDEX CONCURRENTLY (same lane as
-- 2026-10-15-160130-agent-log-receipt-time-indexes.sql): snmp_metrics is a hot
-- agent-write table and a plain CREATE INDEX would hold a SHARE lock for the
-- whole build at deploy time. Every statement below is independently
-- idempotent for autoMigrate's no-transaction retry lane.
--
-- OPERATOR NOTE — an interrupted CONCURRENTLY build leaves an INVALID index
-- that IF NOT EXISTS silently retains. Recovery is
-- `DROP INDEX CONCURRENTLY snmp_metrics_device_oid_ts_idx;` then re-apply.
-- On a large production snmp_metrics, build it by hand first (no downtime):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS snmp_metrics_device_oid_ts_idx
--     ON snmp_metrics (device_id, oid, "timestamp" DESC);
-- confirm indisvalid = true, then this migration is instant on deploy.
--
-- No DML, so no breeze.scope election. No new table, so no RLS/cascade change;
-- the three new COLUMNS do require a CORE_TENANT_EXPORT_POLICY update, shipped
-- in the same commit.

ALTER TABLE snmp_metrics ADD COLUMN IF NOT EXISTS base_oid VARCHAR(200);

ALTER TABLE snmp_metrics ADD COLUMN IF NOT EXISTS instance VARCHAR(64);

ALTER TABLE snmp_metrics ADD COLUMN IF NOT EXISTS error VARCHAR(32);

CREATE INDEX CONCURRENTLY IF NOT EXISTS snmp_metrics_device_oid_ts_idx
  ON snmp_metrics (device_id, oid, "timestamp" DESC);
```

- [ ] **Step 2: Write migration 3 (`-110200`)**

```sql
-- Network device page truth W01 (spec §7.1) — the per-device dispatch counter
-- that W02's `slow` cadence gates on. The column ships in W01 so the wire
-- contract's two waves cannot disagree about the schema; nothing in W01 writes
-- or reads it.
--
-- W02 increments it at dispatch and includes `cadence: 'slow'` specs only when
-- `poll_seq % 12 = 0`, so a 5-minute device refreshes static columns (ifDescr,
-- prtMarkerSuppliesDescription, …) hourly instead of every poll.
--
-- Expansion-only, NOT NULL DEFAULT 0. No DML, so no breeze.scope election.

ALTER TABLE snmp_devices
  ADD COLUMN IF NOT EXISTS poll_seq INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 3: Add the Drizzle columns and the index**

In `apps/api/src/db/schema/snmp.ts`, inside `snmpDevices`, after `lastStatus`:

```ts
  // W01 (spec §7.1) — monotonic dispatch counter. W02 gates `cadence: 'slow'`
  // OID specs on `poll_seq % SLOW_CADENCE_EVERY === 0`. Unused in W01.
  pollSeq: integer('poll_seq').notNull().default(0),
```

and replace the `snmpMetrics` definition with:

```ts
export const snmpMetrics = pgTable('snmp_metrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => snmpDevices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  oid: varchar('oid', { length: 200 }).notNull(),
  // W01 (spec §7.2/§7.3) — for a walked table column, `oid` is the fully
  // qualified instance OID and `base_oid` is the column it belongs to.
  // NULL on every legacy-agent row; readers COALESCE(base_oid, oid).
  baseOid: varchar('base_oid', { length: 200 }),
  instance: varchar('instance', { length: 64 }),
  name: varchar('name', { length: 100 }).notNull(),
  value: text('value'),
  // 'null' | 'number' | 'string' | 'object' | 'error'. An 'error' row carries
  // value = NULL and a code in `error`.
  valueType: varchar('value_type', { length: 20 }),
  // noSuchObject | noSuchInstance | endOfMib | timeout | truncated
  error: varchar('error', { length: 32 }),
  timestamp: timestamp('timestamp').notNull().defaultNow()
}, (table) => ({
  deviceIdIdx: index('snmp_metrics_device_id_idx').on(table.deviceId),
  oidIdx: index('snmp_metrics_oid_idx').on(table.oid),
  timestampIdx: index('snmp_metrics_timestamp_idx').on(table.timestamp),
  // W01 (spec §7.5) — serves GET /monitoring/assets/:id/metrics.
  deviceOidTsIdx: index('snmp_metrics_device_oid_ts_idx').on(table.deviceId, table.oid, desc(table.timestamp))
}));
```

Add `desc` to the `drizzle-orm` import at the top of the file (`import { desc } from 'drizzle-orm';` — the file currently imports nothing from `drizzle-orm` itself, only from `drizzle-orm/pg-core`).

- [ ] **Step 4: Classify the four columns in the export policy**

Replace the two entries in `tenantExportPolicyRegistry.ts`:

```ts
  // W01 (spec §7.1): poll_seq is a monotonic per-device dispatch counter —
  // ordinary operational state, a plain integer, `included` (the same treatment
  // as devices.reboot_deferrals_used).
  "snmp_devices": tablePolicy("org_id", {"included":["id","org_id","asset_id","name","ip_address","snmp_version","port","auth_protocol","priv_protocol","username","polling_interval","template_id","is_active","last_polled","last_poll_attempted_at","consecutive_failures","last_status","poll_seq","created_at"],"reviewedIncluded":[],"excludedSensitive":["community","auth_password","priv_password"],"excludedOpen":[]}),
  // W01 (spec §7.3): base_oid and instance are public SNMP OID identifiers —
  // the same class of value as the existing `oid` column, which has always been
  // `included`. `error` is a closed set of five SNMP PDU/bound codes
  // (noSuchObject | noSuchInstance | endOfMib | timeout | truncated), not an
  // agent-supplied free-text blob. All three are varchar scalars, none is an
  // open container, none matches SUSPICIOUS_NAME_PARTS.
  "snmp_metrics": tablePolicy("org_id", {"included":["id","device_id","org_id","oid","base_oid","instance","name","value","value_type","error","timestamp"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

- [ ] **Step 5: Guards, apply twice, drift**

Run: `scripts/check-migration-naming.sh --against-ref origin/main && cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`
Expected: PASS.

Then with the test-stack `DATABASE_URL`: `pnpm db:migrate && pnpm db:migrate && pnpm db:check-drift`
Expected: second migrate is a no-op; drift reports no difference for `snmp_metrics` / `snmp_devices`. If drift names the index, match the migration's column list and `DESC` exactly.

- [ ] **Step 6: Verify the index landed valid**

Run:
```bash
docker exec -i $(docker ps --format '{{.Names}}' | grep -m1 postgres) \
  psql -U breeze -d breeze -c \
  "select indexrelid::regclass, indisvalid from pg_index where indexrelid = 'snmp_metrics_device_oid_ts_idx'::regclass;"
```
Expected: one row, `indisvalid = t`. An `f` means the concurrent build was interrupted — drop it concurrently and re-apply.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-10-17-110100-snmp-metrics-instances-errors-index.sql \
        apps/api/migrations/2026-10-17-110200-snmp-devices-poll-seq.sql \
        apps/api/src/db/schema/snmp.ts \
        apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "$(cat <<'EOF'
feat(monitoring): snmp_metrics instance/error columns, history index, snmp_devices.poll_seq (W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `services/assetReachability.ts` — the pure §4.2 rules

**Files:**
- Create: `apps/api/src/services/assetReachability.ts`
- Test: `apps/api/src/services/assetReachability.test.ts`

**Interfaces:**
- Consumes: nothing. Pure, no I/O, no imports outside `type` declarations in this file.
- Produces (verbatim names, consumed by W02–W05):

```ts
export type ReachabilityState = 'responding' | 'not_responding' | 'unverified';
export type ReachabilitySource = 'network_check' | 'probe' | 'scan' | 'unifi' | 'snmp';
export type SnmpDetailState = 'ok' | 'failing' | 'no_template' | 'no_agent' | 'asset_moved' | 'never_polled';

export interface Reachability {
  state: ReachabilityState;
  source: ReachabilitySource | null;
  observedAt: string | null;
  lastKnown: { state: 'responding' | 'not_responding'; source: ReachabilitySource; observedAt: string } | null;
  detail: {
    networkCheck?: { state: 'online' | 'degraded' | 'offline'; observedAt: string; responseMs: number | null; monitorId: string };
    probe?: { state: 'ok' | 'failed' | 'pending'; observedAt: string | null; responseMs: number | null };
    snmp?: { state: SnmpDetailState; observedAt: string | null; consecutiveFailures: number };
    scan?: { state: 'seen' | 'missed'; observedAt: string | null; source: 'scan' | 'unifi' };
  };
}

export interface ReachabilityAssetInput {
  isOnline: boolean;
  statusObservedAt: Date | string | null;
  statusSource: 'scan' | 'unifi' | null;
  lastSeenAt: Date | string | null;
  lastProbeAt: Date | string | null;
  lastProbeStatus: 'pending' | 'ok' | 'failed' | null;
  lastProbeResponseMs: number | null;
}
export interface ReachabilitySnmpInput {
  isActive: boolean;
  lastStatus: string | null;
  lastPolled: Date | string | null;
  lastPollAttemptedAt: Date | string | null;
  pollingInterval: number | null;
  consecutiveFailures: number;
}
export interface ReachabilityMonitorInput {
  id: string;
  monitorType: 'icmp_ping' | 'tcp_port' | 'http_check' | 'dns_check';
  isActive: boolean;
  lastStatus: 'online' | 'offline' | 'degraded' | 'unknown';
  lastChecked: Date | string | null;
  lastResponseMs: number | null;
  pollingInterval: number;
}
export interface ReachabilityInput {
  asset: ReachabilityAssetInput;
  snmpDevice: ReachabilitySnmpInput | null;
  networkMonitors: ReachabilityMonitorInput[];
  scanIntervalSeconds: number | null;
}

export function deriveReachability(input: ReachabilityInput, now?: Date): Reachability;
export function reachabilityToListStatus(r: Reachability): 'online' | 'offline' | 'unknown';

export const PROBE_FRESHNESS_MS: number;        // 15 min
export const PROBE_STALE_PENDING_MS: number;    // 2 min
export const UNIFI_FRESHNESS_MS: number;        // 60 min
export const DEFAULT_SCAN_FRESHNESS_MS: number; // 24 h
export const MIN_NETWORK_CHECK_FRESHNESS_MS: number; // 5 min
export const MIN_SNMP_FRESHNESS_MS: number;     // 10 min
```

**DECISIONS** (the spec leaves these open; recorded here and in the PR body):
1. **Undated negatives are not observations.** An `is_online = false` row with `status_observed_at NULL` (every pre-existing row, because the disappeared sweep never touched `last_seen_at`) yields no observation at all — not even `lastKnown`. There is no honest timestamp to rank it by, and claiming "offline, unknown when" is the exact F1 failure D1 exists to stop. A positive (`is_online = true`) with a NULL `status_observed_at` falls back to `last_seen_at`, whose meaning ("last positive sighting") is unchanged and correct.
2. **Legacy `status_source` defaults to `'scan'`.** Both the discovery worker and the UniFi services historically wrote `is_online` + `last_seen_at` with nothing to tell them apart. `'scan'` is the conservative label (its 24 h default window is wider than UniFi's 60 min, so an unattributed row ages out later rather than sooner — it under-claims freshness, never over-claims it).
3. **An inactive SNMP device contributes nothing.** `snmpDevice.isActive === false` yields no observation and no `detail.snmp`. Being paused is an operator fact, not a device fact; §6.2's `collection.status = 'paused'` is where it belongs.
4. **Cron discovery schedules get the 24 h default.** `scanIntervalSeconds` is non-null only for `schedule.type === 'interval'` profiles (`routes/discovery.ts:902`); a cron schedule would need a parser to answer "how often", and 24 h is the spec's stated fallback.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/assetReachability.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  deriveReachability,
  reachabilityToListStatus,
  type ReachabilityInput,
  type ReachabilityMonitorInput,
} from './assetReachability';

const NOW = new Date('2026-09-16T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

function input(overrides: Partial<ReachabilityInput> = {}): ReachabilityInput {
  return {
    asset: {
      isOnline: false,
      statusObservedAt: null,
      statusSource: null,
      lastSeenAt: null,
      lastProbeAt: null,
      lastProbeStatus: null,
      lastProbeResponseMs: null,
    },
    snmpDevice: null,
    networkMonitors: [],
    scanIntervalSeconds: null,
    ...overrides,
  };
}

function monitor(overrides: Partial<ReachabilityMonitorInput> = {}): ReachabilityMonitorInput {
  return {
    id: 'mon-1',
    monitorType: 'icmp_ping',
    isActive: true,
    lastStatus: 'online',
    lastChecked: ago(MIN),
    lastResponseMs: 4,
    pollingInterval: 60,
    ...overrides,
  };
}

describe('deriveReachability — each source alone', () => {
  it('a fresh network check says responding and names itself', () => {
    const r = deriveReachability(input({ networkMonitors: [monitor()] }), NOW);
    expect(r.state).toBe('responding');
    expect(r.source).toBe('network_check');
    expect(r.observedAt).toBe(ago(MIN));
    expect(r.detail.networkCheck).toEqual({ state: 'online', observedAt: ago(MIN), responseMs: 4, monitorId: 'mon-1' });
  });

  it('a degraded network check is still a positive host observation', () => {
    const r = deriveReachability(input({ networkMonitors: [monitor({ lastStatus: 'degraded' })] }), NOW);
    expect(r.state).toBe('responding');
    expect(r.detail.networkCheck!.state).toBe('degraded');
  });

  it('an offline network check says not_responding', () => {
    const r = deriveReachability(input({ networkMonitors: [monitor({ lastStatus: 'offline', lastResponseMs: null })] }), NOW);
    expect(r.state).toBe('not_responding');
    expect(r.source).toBe('network_check');
  });

  it('a fresh SNMP success is a positive observation (an SNMP reply proves reachability)', () => {
    const r = deriveReachability(input({
      snmpDevice: { isActive: true, lastStatus: 'online', lastPolled: ago(2 * MIN), lastPollAttemptedAt: ago(2 * MIN), pollingInterval: 300, consecutiveFailures: 0 },
    }), NOW);
    expect(r.state).toBe('responding');
    expect(r.source).toBe('snmp');
    expect(r.detail.snmp).toEqual({ state: 'ok', observedAt: ago(2 * MIN), consecutiveFailures: 0 });
  });

  it('an ok probe is a positive observation', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, lastProbeAt: ago(MIN), lastProbeStatus: 'ok', lastProbeResponseMs: 3 },
    }), NOW);
    expect(r.state).toBe('responding');
    expect(r.source).toBe('probe');
    expect(r.detail.probe).toEqual({ state: 'ok', observedAt: ago(MIN), responseMs: 3 });
  });

  it('a scan sighting is a positive observation dated by status_observed_at', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, isOnline: true, statusObservedAt: ago(HOUR), statusSource: 'scan', lastSeenAt: ago(HOUR) },
      scanIntervalSeconds: 3600,
    }), NOW);
    expect(r.state).toBe('responding');
    expect(r.source).toBe('scan');
    expect(r.detail.scan).toEqual({ state: 'seen', observedAt: ago(HOUR), source: 'scan' });
  });

  it('a UniFi sighting names unifi, not scan', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, isOnline: true, statusObservedAt: ago(10 * MIN), statusSource: 'unifi', lastSeenAt: ago(10 * MIN) },
    }), NOW);
    expect(r.source).toBe('unifi');
    expect(r.detail.scan).toEqual({ state: 'seen', observedAt: ago(10 * MIN), source: 'unifi' });
  });

  it('a dated disappeared-sweep verdict is a negative observation', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, isOnline: false, statusObservedAt: ago(30 * MIN), statusSource: 'scan', lastSeenAt: ago(5 * HOUR) },
      scanIntervalSeconds: 3600,
    }), NOW);
    expect(r.state).toBe('not_responding');
    expect(r.source).toBe('scan');
    expect(r.detail.scan).toEqual({ state: 'missed', observedAt: ago(30 * MIN), source: 'scan' });
  });
});

describe('deriveReachability — positive vs negative recency', () => {
  it('the more recent of a positive and a negative wins (positive newer)', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, lastProbeAt: ago(MIN), lastProbeStatus: 'ok', lastProbeResponseMs: 2 },
      networkMonitors: [monitor({ lastStatus: 'offline', lastChecked: ago(2 * MIN), lastResponseMs: null })],
    }), NOW);
    expect(r.state).toBe('responding');
    expect(r.source).toBe('probe');
  });

  it('the more recent of a positive and a negative wins (negative newer)', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, lastProbeAt: ago(3 * MIN), lastProbeStatus: 'ok', lastProbeResponseMs: 2 },
      networkMonitors: [monitor({ lastStatus: 'offline', lastChecked: ago(MIN), lastResponseMs: null })],
    }), NOW);
    expect(r.state).toBe('not_responding');
    expect(r.source).toBe('network_check');
    // Both details are still reported — the UI explains the disagreement.
    expect(r.detail.probe!.state).toBe('ok');
    expect(r.detail.networkCheck!.state).toBe('offline');
  });
});

describe('deriveReachability — freshness windows', () => {
  it('a network check older than 2x its interval (min 5 min) stops counting', () => {
    const stale = deriveReachability(input({
      networkMonitors: [monitor({ pollingInterval: 60, lastChecked: ago(6 * MIN) })],
    }), NOW);
    expect(stale.state).toBe('unverified');
    expect(stale.lastKnown).toEqual({ state: 'responding', source: 'network_check', observedAt: ago(6 * MIN) });

    const fresh = deriveReachability(input({
      networkMonitors: [monitor({ pollingInterval: 60, lastChecked: ago(4 * MIN) })],
    }), NOW);
    expect(fresh.state).toBe('responding');
  });

  it('a 600 s network check uses 2x its interval, not the 5 min floor', () => {
    const r = deriveReachability(input({
      networkMonitors: [monitor({ pollingInterval: 600, lastChecked: ago(19 * MIN) })],
    }), NOW);
    expect(r.state).toBe('responding');
  });

  it('a probe older than 15 min stops counting', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, lastProbeAt: ago(16 * MIN), lastProbeStatus: 'ok', lastProbeResponseMs: 2 },
    }), NOW);
    expect(r.state).toBe('unverified');
    expect(r.lastKnown!.source).toBe('probe');
  });

  it('a UniFi sighting older than 60 min stops counting', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, isOnline: true, statusObservedAt: ago(61 * MIN), statusSource: 'unifi', lastSeenAt: ago(61 * MIN) },
    }), NOW);
    expect(r.state).toBe('unverified');
  });

  it('a scan uses 2x the profile interval when known, else 24 h', () => {
    const scoped = deriveReachability(input({
      asset: { ...input().asset, isOnline: true, statusObservedAt: ago(3 * HOUR), statusSource: 'scan', lastSeenAt: ago(3 * HOUR) },
      scanIntervalSeconds: 3600,
    }), NOW);
    expect(scoped.state).toBe('unverified');

    const defaulted = deriveReachability(input({
      asset: { ...input().asset, isOnline: true, statusObservedAt: ago(3 * HOUR), statusSource: 'scan', lastSeenAt: ago(3 * HOUR) },
      scanIntervalSeconds: null,
    }), NOW);
    expect(defaulted.state).toBe('responding');
  });

  it('an SNMP success older than 2x its interval (min 10 min) stops counting', () => {
    const r = deriveReachability(input({
      snmpDevice: { isActive: true, lastStatus: 'online', lastPolled: ago(11 * MIN), lastPollAttemptedAt: ago(11 * MIN), pollingInterval: 300, consecutiveFailures: 0 },
    }), NOW);
    expect(r.state).toBe('unverified');
    expect(r.lastKnown!.source).toBe('snmp');
  });
});

describe('deriveReachability — sources that never contribute', () => {
  it.each([['http_check'], ['dns_check']] as const)('%s monitors are ignored entirely', (monitorType) => {
    const r = deriveReachability(input({
      networkMonitors: [monitor({ monitorType, lastStatus: 'offline', lastChecked: ago(MIN), lastResponseMs: null })],
    }), NOW);
    // A TLS or DNS failure is not host evidence (spec §4.1).
    expect(r.state).toBe('unverified');
    expect(r.detail.networkCheck).toBeUndefined();
  });

  it('an inactive monitor is ignored', () => {
    const r = deriveReachability(input({ networkMonitors: [monitor({ isActive: false })] }), NOW);
    expect(r.state).toBe('unverified');
  });

  it('an unknown monitor status is ignored', () => {
    const r = deriveReachability(input({ networkMonitors: [monitor({ lastStatus: 'unknown' })] }), NOW);
    expect(r.state).toBe('unverified');
  });

  it('an inactive SNMP device contributes nothing at all (pausing is not a device fact)', () => {
    const r = deriveReachability(input({
      snmpDevice: { isActive: false, lastStatus: 'online', lastPolled: ago(MIN), lastPollAttemptedAt: ago(MIN), pollingInterval: 300, consecutiveFailures: 0 },
    }), NOW);
    expect(r.state).toBe('unverified');
    expect(r.detail.snmp).toBeUndefined();
  });

  it('an undated is_online=false is NOT a negative observation', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, isOnline: false, statusObservedAt: null, statusSource: null, lastSeenAt: ago(19 * HOUR) },
    }), NOW);
    expect(r.state).toBe('unverified');
    expect(r.source).toBeNull();
    expect(r.lastKnown).toBeNull();
    expect(r.detail.scan).toBeUndefined();
  });

  it('an undated is_online=true falls back to last_seen_at and is labelled scan', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, isOnline: true, statusObservedAt: null, statusSource: null, lastSeenAt: ago(2 * HOUR) },
    }), NOW);
    expect(r.state).toBe('responding');
    expect(r.source).toBe('scan');
    expect(r.detail.scan).toEqual({ state: 'seen', observedAt: ago(2 * HOUR), source: 'scan' });
  });
});

describe('deriveReachability — SNMP failures never say not_responding on their own', () => {
  it.each([
    ['offline', 'failing'],
    ['warning', 'failing'],
    ['no_template', 'no_template'],
    ['no_agent_in_site', 'no_agent'],
    ['asset_missing', 'asset_moved'],
    ['asset_no_site', 'asset_moved'],
  ] as const)('last_status %s reports detail.snmp %s and leaves state unverified', (lastStatus, detailState) => {
    const r = deriveReachability(input({
      snmpDevice: { isActive: true, lastStatus, lastPolled: null, lastPollAttemptedAt: ago(MIN), pollingInterval: 300, consecutiveFailures: 3 },
    }), NOW);
    expect(r.state).toBe('unverified');
    expect(r.source).toBeNull();
    expect(r.detail.snmp).toEqual({ state: detailState, observedAt: ago(MIN), consecutiveFailures: 3 });
  });

  it('a never-polled SNMP device reports never_polled', () => {
    const r = deriveReachability(input({
      snmpDevice: { isActive: true, lastStatus: null, lastPolled: null, lastPollAttemptedAt: null, pollingInterval: 300, consecutiveFailures: 0 },
    }), NOW);
    expect(r.detail.snmp).toEqual({ state: 'never_polled', observedAt: null, consecutiveFailures: 0 });
    expect(r.state).toBe('unverified');
  });

  it('an SNMP failure does not veto a fresh positive from another source', () => {
    const r = deriveReachability(input({
      networkMonitors: [monitor()],
      snmpDevice: { isActive: true, lastStatus: 'offline', lastPolled: null, lastPollAttemptedAt: ago(30_000), pollingInterval: 300, consecutiveFailures: 5 },
    }), NOW);
    expect(r.state).toBe('responding');
    expect(r.source).toBe('network_check');
    expect(r.detail.snmp!.state).toBe('failing');
  });
});

describe('deriveReachability — probe pending', () => {
  it('a young pending probe reports pending and makes no claim', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, lastProbeAt: ago(30_000), lastProbeStatus: 'pending', lastProbeResponseMs: null },
    }), NOW);
    expect(r.state).toBe('unverified');
    expect(r.detail.probe).toEqual({ state: 'pending', observedAt: ago(30_000), responseMs: null });
  });

  it('a pending probe older than 2 min is treated as failed (the agent never answered)', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, lastProbeAt: ago(3 * MIN), lastProbeStatus: 'pending', lastProbeResponseMs: null },
    }), NOW);
    expect(r.state).toBe('not_responding');
    expect(r.source).toBe('probe');
    expect(r.detail.probe!.state).toBe('failed');
  });
});

describe('deriveReachability — unverified carries lastKnown of any age', () => {
  it('picks the freshest observation of any age', () => {
    const r = deriveReachability(input({
      asset: { ...input().asset, isOnline: true, statusObservedAt: ago(19 * HOUR), statusSource: 'scan', lastSeenAt: ago(19 * HOUR) },
      scanIntervalSeconds: 3600,
      networkMonitors: [monitor({ lastStatus: 'offline', lastChecked: ago(30 * HOUR), lastResponseMs: null })],
    }), NOW);
    expect(r.state).toBe('unverified');
    expect(r.source).toBeNull();
    expect(r.observedAt).toBeNull();
    expect(r.lastKnown).toEqual({ state: 'responding', source: 'scan', observedAt: ago(19 * HOUR) });
  });

  it('nothing at all is unverified with a null lastKnown', () => {
    const r = deriveReachability(input(), NOW);
    expect(r).toEqual({ state: 'unverified', source: null, observedAt: null, lastKnown: null, detail: {} });
  });
});

describe('reachabilityToListStatus', () => {
  it.each([
    ['responding', 'online'],
    ['not_responding', 'offline'],
    ['unverified', 'unknown'],
  ] as const)('%s maps to %s', (state, expected) => {
    expect(reachabilityToListStatus({ state, source: null, observedAt: null, lastKnown: null, detail: {} })).toBe(expected);
  });
});
```

Run: `cd apps/api && npx vitest run src/services/assetReachability.test.ts`
Expected failure: `Failed to resolve import "./assetReachability"` — the module does not exist yet.

- [ ] **Step 2: Implement `services/assetReachability.ts`**

```ts
/**
 * Reachability derivation (spec §4, decision D1).
 *
 * PURE. No I/O, no DB, no clock except the injected `now`. Callers
 * (services/assetReachabilityLoader.ts, the list/detail routes, the AI tools)
 * assemble the input; this module only ranks it.
 *
 * WHY DERIVED, NOT MATERIALISED: four independent pipelines write the asset's
 * state today (discovery scan, discovery disappeared-sweep, UniFi sync, UniFi
 * telemetry) and none of them coordinates with the other two that actually
 * probe the device (the SNMP poller and the network-check worker, which write
 * their own tables). A materialised `reachability_*` column would be whichever
 * of those six wrote last. So we rank at read time, by EVIDENCE CLASS:
 *
 *   host class     network_check (icmp/tcp), probe, scan, unifi
 *   protocol class snmp
 *
 * A protocol-class SUCCESS is positive evidence (an SNMP reply proves the host
 * answered). A protocol-class FAILURE proves nothing about the host:
 * `consecutive_failures` is incremented at DISPATCH (jobs/snmpWorker.ts
 * markPollDispatched), so `offline` can mean the bridging agent, the
 * credentials, or a missing template just as easily as the device.
 *
 * http_check and dns_check NEVER contribute: a TLS or DNS failure is not host
 * evidence (agent/internal/heartbeat/handlers_monitor.go:264 returns
 * status=offline for a certificate problem on a perfectly reachable host).
 */

export type ReachabilityState = 'responding' | 'not_responding' | 'unverified';
export type ReachabilitySource = 'network_check' | 'probe' | 'scan' | 'unifi' | 'snmp';
export type SnmpDetailState = 'ok' | 'failing' | 'no_template' | 'no_agent' | 'asset_moved' | 'never_polled';

export interface Reachability {
  state: ReachabilityState;
  /** null only when unverified with no observation at all. */
  source: ReachabilitySource | null;
  observedAt: string | null;
  lastKnown: { state: 'responding' | 'not_responding'; source: ReachabilitySource; observedAt: string } | null;
  detail: {
    networkCheck?: { state: 'online' | 'degraded' | 'offline'; observedAt: string; responseMs: number | null; monitorId: string };
    probe?: { state: 'ok' | 'failed' | 'pending'; observedAt: string | null; responseMs: number | null };
    snmp?: { state: SnmpDetailState; observedAt: string | null; consecutiveFailures: number };
    scan?: { state: 'seen' | 'missed'; observedAt: string | null; source: 'scan' | 'unifi' };
  };
}

export interface ReachabilityAssetInput {
  isOnline: boolean;
  statusObservedAt: Date | string | null;
  statusSource: 'scan' | 'unifi' | null;
  lastSeenAt: Date | string | null;
  lastProbeAt: Date | string | null;
  lastProbeStatus: 'pending' | 'ok' | 'failed' | null;
  lastProbeResponseMs: number | null;
}

export interface ReachabilitySnmpInput {
  isActive: boolean;
  lastStatus: string | null;
  lastPolled: Date | string | null;
  lastPollAttemptedAt: Date | string | null;
  pollingInterval: number | null;
  consecutiveFailures: number;
}

export interface ReachabilityMonitorInput {
  id: string;
  monitorType: 'icmp_ping' | 'tcp_port' | 'http_check' | 'dns_check';
  isActive: boolean;
  lastStatus: 'online' | 'offline' | 'degraded' | 'unknown';
  lastChecked: Date | string | null;
  lastResponseMs: number | null;
  pollingInterval: number;
}

export interface ReachabilityInput {
  asset: ReachabilityAssetInput;
  snmpDevice: ReachabilitySnmpInput | null;
  networkMonitors: ReachabilityMonitorInput[];
  /** From the asset's discovery profile when it is an `interval` schedule; null for cron/none. */
  scanIntervalSeconds: number | null;
}

export const PROBE_FRESHNESS_MS = 15 * 60_000;
export const PROBE_STALE_PENDING_MS = 2 * 60_000;
export const UNIFI_FRESHNESS_MS = 60 * 60_000;
export const DEFAULT_SCAN_FRESHNESS_MS = 24 * 60 * 60_000;
export const MIN_NETWORK_CHECK_FRESHNESS_MS = 5 * 60_000;
export const MIN_SNMP_FRESHNESS_MS = 10 * 60_000;

/** Host-class monitor types. http_check/dns_check are absent on purpose (§4.1). */
const HOST_MONITOR_TYPES = new Set(['icmp_ping', 'tcp_port']);

const SNMP_FAILURE_DETAIL: Record<string, SnmpDetailState> = {
  offline: 'failing',
  warning: 'failing',
  no_template: 'no_template',
  no_agent_in_site: 'no_agent',
  asset_missing: 'asset_moved',
  asset_no_site: 'asset_moved',
};

type Observation = {
  polarity: 'positive' | 'negative';
  source: ReachabilitySource;
  at: number;
  iso: string;
  /** Milliseconds after `at` during which this observation still counts. */
  windowMs: number;
};

function toMillis(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function observe(
  polarity: 'positive' | 'negative',
  source: ReachabilitySource,
  at: number,
  windowMs: number,
): Observation {
  return { polarity, source, at, iso: iso(at), windowMs };
}

export function deriveReachability(input: ReachabilityInput, now: Date = new Date()): Reachability {
  const nowMs = now.getTime();
  const detail: Reachability['detail'] = {};
  const observations: Observation[] = [];

  // ── network_check (host class) ────────────────────────────────────────────
  // Every eligible monitor is considered and the freshest wins the detail slot,
  // so a device with both an ICMP and a TCP check reports whichever last spoke.
  let bestMonitor: { obs: Observation; monitor: ReachabilityMonitorInput } | null = null;
  for (const monitor of input.networkMonitors) {
    if (!monitor.isActive) continue;
    if (!HOST_MONITOR_TYPES.has(monitor.monitorType)) continue;
    if (monitor.lastStatus === 'unknown') continue;
    const at = toMillis(monitor.lastChecked);
    if (at === null) continue;
    const windowMs = Math.max(2 * monitor.pollingInterval * 1000, MIN_NETWORK_CHECK_FRESHNESS_MS);
    const obs = observe(monitor.lastStatus === 'offline' ? 'negative' : 'positive', 'network_check', at, windowMs);
    if (!bestMonitor || obs.at > bestMonitor.obs.at) bestMonitor = { obs, monitor };
  }
  if (bestMonitor) {
    observations.push(bestMonitor.obs);
    detail.networkCheck = {
      state: bestMonitor.monitor.lastStatus as 'online' | 'degraded' | 'offline',
      observedAt: bestMonitor.obs.iso,
      responseMs: bestMonitor.monitor.lastResponseMs,
      monitorId: bestMonitor.monitor.id,
    };
  }

  // ── probe (host class) ────────────────────────────────────────────────────
  const probeAt = toMillis(input.asset.lastProbeAt);
  const probeStatus = input.asset.lastProbeStatus;
  if (probeAt !== null && probeStatus) {
    // A pending stamp older than PROBE_STALE_PENDING_MS means the agent never
    // answered — that IS a failure, and treating it as one is what stops the UI
    // spinning forever on a dead bridge.
    const resolved: 'ok' | 'failed' | 'pending' =
      probeStatus === 'pending' && nowMs - probeAt > PROBE_STALE_PENDING_MS ? 'failed' : probeStatus;
    detail.probe = { state: resolved, observedAt: iso(probeAt), responseMs: input.asset.lastProbeResponseMs };
    if (resolved !== 'pending') {
      observations.push(observe(resolved === 'ok' ? 'positive' : 'negative', 'probe', probeAt, PROBE_FRESHNESS_MS));
    }
  }

  // ── scan / unifi (host class) ─────────────────────────────────────────────
  // See the DECISIONS block in the plan: an undated negative is no observation.
  const statusAt = toMillis(input.asset.statusObservedAt);
  const sightedAt = statusAt ?? (input.asset.isOnline ? toMillis(input.asset.lastSeenAt) : null);
  if (sightedAt !== null) {
    const scanSource: 'scan' | 'unifi' = input.asset.statusSource ?? 'scan';
    const windowMs = scanSource === 'unifi'
      ? UNIFI_FRESHNESS_MS
      : input.scanIntervalSeconds != null
        ? 2 * input.scanIntervalSeconds * 1000
        : DEFAULT_SCAN_FRESHNESS_MS;
    detail.scan = { state: input.asset.isOnline ? 'seen' : 'missed', observedAt: iso(sightedAt), source: scanSource };
    observations.push(observe(input.asset.isOnline ? 'positive' : 'negative', scanSource, sightedAt, windowMs));
  }

  // ── snmp (protocol class) ─────────────────────────────────────────────────
  const snmp = input.snmpDevice;
  if (snmp && snmp.isActive) {
    const polledAt = toMillis(snmp.lastPolled);
    const attemptedAt = toMillis(snmp.lastPollAttemptedAt);
    const windowMs = Math.max(2 * (snmp.pollingInterval ?? 300) * 1000, MIN_SNMP_FRESHNESS_MS);
    if (snmp.lastStatus === 'online' && polledAt !== null) {
      detail.snmp = { state: 'ok', observedAt: iso(polledAt), consecutiveFailures: snmp.consecutiveFailures };
      observations.push(observe('positive', 'snmp', polledAt, windowMs));
    } else if (snmp.lastStatus && SNMP_FAILURE_DETAIL[snmp.lastStatus]) {
      // Protocol-class negatives are REPORTED but never ranked — they cannot
      // produce not_responding on their own (spec §4.2 rule 5).
      detail.snmp = {
        state: SNMP_FAILURE_DETAIL[snmp.lastStatus]!,
        observedAt: attemptedAt !== null ? iso(attemptedAt) : null,
        consecutiveFailures: snmp.consecutiveFailures,
      };
    } else if (polledAt === null) {
      detail.snmp = { state: 'never_polled', observedAt: null, consecutiveFailures: snmp.consecutiveFailures };
    } else {
      // Polled successfully once, current status unrecognised — report the last
      // success as stale evidence rather than inventing a failure state.
      detail.snmp = { state: 'ok', observedAt: iso(polledAt), consecutiveFailures: snmp.consecutiveFailures };
      observations.push(observe('positive', 'snmp', polledAt, windowMs));
    }
  }

  // ── rank (spec §4.2 rules 1-4) ────────────────────────────────────────────
  const freshest = (polarity: 'positive' | 'negative', requireFresh: boolean): Observation | null => {
    let best: Observation | null = null;
    for (const obs of observations) {
      if (obs.polarity !== polarity) continue;
      // Rule 1: only host-class negatives are eligible; the SNMP branch above
      // never pushes a negative, so `polarity === 'negative'` is host-class by
      // construction.
      if (requireFresh && nowMs - obs.at > obs.windowMs) continue;
      if (!best || obs.at > best.at) best = obs;
    }
    return best;
  };

  const positive = freshest('positive', true);
  const negative = freshest('negative', true);

  if (positive || negative) {
    const winner = !negative || (positive && positive.at >= negative.at) ? positive! : negative!;
    return {
      state: winner.polarity === 'positive' ? 'responding' : 'not_responding',
      source: winner.source,
      observedAt: winner.iso,
      lastKnown: null,
      detail,
    };
  }

  // Rule 4 — nothing inside a window. Report the freshest observation of ANY
  // age so the UI can say "Unverified - last seen by scan 19 h ago".
  let stalest: Observation | null = null;
  for (const obs of observations) {
    if (!stalest || obs.at > stalest.at) stalest = obs;
  }

  return {
    state: 'unverified',
    source: null,
    observedAt: null,
    lastKnown: stalest
      ? { state: stalest.polarity === 'positive' ? 'responding' : 'not_responding', source: stalest.source, observedAt: stalest.iso }
      : null,
    detail,
  };
}

/**
 * The devices-list `status` axis (spec §4.4). `unverified` is `unknown`, NEVER
 * `offline` — that conflation is F1 and #4622's manual-asset bug in one.
 */
export function reachabilityToListStatus(r: Reachability): 'online' | 'offline' | 'unknown' {
  if (r.state === 'responding') return 'online';
  if (r.state === 'not_responding') return 'offline';
  return 'unknown';
}
```

- [ ] **Step 3: Run the tests**

Run: `cd apps/api && npx vitest run src/services/assetReachability.test.ts`
Expected: all PASS (37 assertions across 8 describes).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/assetReachability.ts apps/api/src/services/assetReachability.test.ts
git commit -m "$(cat <<'COMMIT_EOF'
feat(monitoring): pure asset reachability derivation with evidence classes (W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT_EOF
)"
```

---

### Task 4: `services/assetReachabilityLoader.ts` — the batched input loader

**Files:**
- Create: `apps/api/src/services/assetReachabilityLoader.ts`
- Test: `apps/api/src/services/assetReachabilityLoader.test.ts`

**Interfaces:**
- Consumes: `ReachabilityInput`, `ReachabilityMonitorInput`, `ReachabilitySnmpInput` from `./assetReachability`; `discoveredAssets`, `snmpDevices`, `networkMonitors`, `discoveryJobs`, `discoveryProfiles` from `../db/schema`; `db` from `../db`.
- Produces:

```ts
export async function loadReachabilityInputs(assetIds: string[]): Promise<Map<string, ReachabilityInput>>;
export async function loadReachability(assetIds: string[], now?: Date): Promise<Map<string, Reachability>>;
```

**DECISION (deviation from the index's wording).** The index says "DISTINCT ON latest `snmp_devices`/`network_monitors` per asset". Only `snmp_devices` uses `DISTINCT ON`: `deriveReachability` takes the network monitors as an ARRAY and picks the freshest host-class one itself, which is what populates `detail.networkCheck` correctly when a device has both an ICMP and a TCP check. Collapsing them in SQL would throw away the second check before the rules could see it. The `snmp_devices` pick mirrors the existing precedence at `routes/monitoring.ts:290-306` (active first, then newest `created_at`), so the two never disagree about which SNMP row "is" the device.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/assetReachabilityLoader.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Rows handed back, in order, to successive `db.select()` chains. */
let selectResults: unknown[][] = [];
const captured: { wheres: unknown[] } = { wheres: [] };

vi.mock('../db', () => {
  const chain = () => {
    const rows = selectResults.shift() ?? [];
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.leftJoin = () => c;
    c.innerJoin = () => c;
    c.where = (condition: unknown) => { captured.wheres.push(condition); return c; };
    c.orderBy = () => c;
    c.limit = () => Promise.resolve(rows);
    c.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => Promise.resolve(rows).then(ok, err);
    return c;
  };
  return { db: { select: () => chain() } };
});

import { loadReachabilityInputs, loadReachability } from './assetReachabilityLoader';

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-09-16T12:00:00.000Z');

beforeEach(() => {
  selectResults = [];
  captured.wheres = [];
});

describe('loadReachabilityInputs', () => {
  it('returns an empty map without touching the database for an empty id list', async () => {
    const result = await loadReachabilityInputs([]);
    expect(result.size).toBe(0);
    expect(captured.wheres).toHaveLength(0);
  });

  it('assembles asset, snmp, monitors and scan interval per asset', async () => {
    selectResults = [
      // 1. assets (+ profile schedule via last_job_id -> discovery_jobs -> discovery_profiles)
      [
        {
          id: A1, isOnline: true, statusObservedAt: NOW, statusSource: 'scan', lastSeenAt: NOW,
          lastProbeAt: null, lastProbeStatus: null, lastProbeResponseMs: null,
          profileSchedule: { type: 'interval', intervalMinutes: 30 },
        },
        {
          id: A2, isOnline: false, statusObservedAt: null, statusSource: null, lastSeenAt: null,
          lastProbeAt: null, lastProbeStatus: null, lastProbeResponseMs: null,
          profileSchedule: { type: 'cron', cron: '0 * * * *' },
        },
      ],
      // 2. snmp devices (DISTINCT ON asset_id)
      [{ assetId: A1, isActive: true, lastStatus: 'online', lastPolled: NOW, lastPollAttemptedAt: NOW, pollingInterval: 300, consecutiveFailures: 0 }],
      // 3. host-class network monitors
      [{ assetId: A1, id: 'mon-1', monitorType: 'icmp_ping', isActive: true, lastStatus: 'online', lastChecked: NOW, lastResponseMs: 3, pollingInterval: 60 }],
    ];

    const map = await loadReachabilityInputs([A1, A2]);

    expect(map.get(A1)!.scanIntervalSeconds).toBe(1800);
    expect(map.get(A1)!.snmpDevice!.lastStatus).toBe('online');
    expect(map.get(A1)!.networkMonitors).toHaveLength(1);
    // A cron schedule yields no interval — the service falls back to 24 h.
    expect(map.get(A2)!.scanIntervalSeconds).toBeNull();
    expect(map.get(A2)!.snmpDevice).toBeNull();
    expect(map.get(A2)!.networkMonitors).toEqual([]);
  });

  it('omits an asset id that does not resolve to a row', async () => {
    selectResults = [[], [], []];
    const map = await loadReachabilityInputs([A1]);
    expect(map.has(A1)).toBe(false);
  });
});

describe('loadReachability', () => {
  it('derives per asset with a single injected clock', async () => {
    selectResults = [
      [{ id: A1, isOnline: true, statusObservedAt: NOW, statusSource: 'unifi', lastSeenAt: NOW, lastProbeAt: null, lastProbeStatus: null, lastProbeResponseMs: null, profileSchedule: null }],
      [],
      [],
    ];
    const map = await loadReachability([A1], NOW);
    expect(map.get(A1)!.state).toBe('responding');
    expect(map.get(A1)!.source).toBe('unifi');
  });
});
```

Run: `cd apps/api && npx vitest run src/services/assetReachabilityLoader.test.ts`
Expected failure: `Failed to resolve import "./assetReachabilityLoader"`.

- [ ] **Step 2: Implement `services/assetReachabilityLoader.ts`**

```ts
/**
 * Batched assembly of `ReachabilityInput` for a set of discovered assets
 * (spec §4.4). Three queries total, no matter how many assets — the devices
 * list asks for a whole page at once and an N+1 here would be three round trips
 * per row.
 *
 * Runs inside whatever DB context the caller already holds. Every call site is
 * a request route or an AI tool, so that is the request's own
 * `withDbAccessContext` transaction and RLS scopes the reads for us: an asset
 * id the caller cannot see simply returns no row, and its entry is absent from
 * the map. Do NOT add a system-context escalation here.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { discoveredAssets, discoveryJobs, discoveryProfiles, networkMonitors, snmpDevices } from '../db/schema';
import {
  deriveReachability,
  type Reachability,
  type ReachabilityInput,
  type ReachabilityMonitorInput,
  type ReachabilitySnmpInput,
} from './assetReachability';

type ProfileSchedule = { type?: string; intervalMinutes?: number } | null;

/**
 * Only an `interval` schedule states a cadence. A cron schedule would need a
 * parser to answer "how often", and the spec's fallback for an unknown cadence
 * is the 24 h default inside deriveReachability — so null is the honest answer.
 */
function scanIntervalSecondsFrom(schedule: ProfileSchedule): number | null {
  if (!schedule || schedule.type !== 'interval') return null;
  const minutes = schedule.intervalMinutes;
  return typeof minutes === 'number' && minutes > 0 ? minutes * 60 : null;
}

export async function loadReachabilityInputs(assetIds: string[]): Promise<Map<string, ReachabilityInput>> {
  const ids = Array.from(new Set(assetIds.filter(Boolean)));
  const out = new Map<string, ReachabilityInput>();
  if (ids.length === 0) return out;

  const assetRows = await db
    .select({
      id: discoveredAssets.id,
      isOnline: discoveredAssets.isOnline,
      statusObservedAt: discoveredAssets.statusObservedAt,
      statusSource: discoveredAssets.statusSource,
      lastSeenAt: discoveredAssets.lastSeenAt,
      lastProbeAt: discoveredAssets.lastProbeAt,
      lastProbeStatus: discoveredAssets.lastProbeStatus,
      lastProbeResponseMs: discoveredAssets.lastProbeResponseMs,
      profileSchedule: discoveryProfiles.schedule,
    })
    .from(discoveredAssets)
    .leftJoin(discoveryJobs, eq(discoveredAssets.lastJobId, discoveryJobs.id))
    .leftJoin(discoveryProfiles, eq(discoveryJobs.profileId, discoveryProfiles.id))
    .where(inArray(discoveredAssets.id, ids));

  if (assetRows.length === 0) return out;
  const presentIds = assetRows.map((row) => row.id);

  // One SNMP row per asset. Precedence mirrors routes/monitoring.ts:290-306
  // (active first, then newest) so the two surfaces never disagree about which
  // snmp_devices row "is" the device.
  const snmpRows = await db
    .select({
      assetId: snmpDevices.assetId,
      isActive: snmpDevices.isActive,
      lastStatus: snmpDevices.lastStatus,
      lastPolled: snmpDevices.lastPolled,
      lastPollAttemptedAt: snmpDevices.lastPollAttemptedAt,
      pollingInterval: snmpDevices.pollingInterval,
      consecutiveFailures: snmpDevices.consecutiveFailures,
    })
    .from(snmpDevices)
    .where(inArray(snmpDevices.assetId, presentIds))
    .orderBy(snmpDevices.assetId, desc(snmpDevices.isActive), desc(snmpDevices.createdAt));

  const snmpByAsset = new Map<string, ReachabilitySnmpInput>();
  for (const row of snmpRows) {
    if (!row.assetId || snmpByAsset.has(row.assetId)) continue; // first wins, ORDER BY did the ranking
    snmpByAsset.set(row.assetId, {
      isActive: row.isActive,
      lastStatus: row.lastStatus,
      lastPolled: row.lastPolled,
      lastPollAttemptedAt: row.lastPollAttemptedAt,
      pollingInterval: row.pollingInterval,
      consecutiveFailures: row.consecutiveFailures,
    });
  }

  // Host-class monitors only. http_check/dns_check are filtered in SQL rather
  // than in deriveReachability's loop so a 500-asset page does not carry rows
  // the rules will throw away.
  const monitorRows = await db
    .select({
      assetId: networkMonitors.assetId,
      id: networkMonitors.id,
      monitorType: networkMonitors.monitorType,
      isActive: networkMonitors.isActive,
      lastStatus: networkMonitors.lastStatus,
      lastChecked: networkMonitors.lastChecked,
      lastResponseMs: networkMonitors.lastResponseMs,
      pollingInterval: networkMonitors.pollingInterval,
    })
    .from(networkMonitors)
    .where(and(
      inArray(networkMonitors.assetId, presentIds),
      eq(networkMonitors.isActive, true),
      sql`${networkMonitors.monitorType} in ('icmp_ping','tcp_port')`,
    ));

  const monitorsByAsset = new Map<string, ReachabilityMonitorInput[]>();
  for (const row of monitorRows) {
    if (!row.assetId) continue;
    const list = monitorsByAsset.get(row.assetId) ?? [];
    list.push({
      id: row.id,
      monitorType: row.monitorType,
      isActive: row.isActive,
      lastStatus: row.lastStatus,
      lastChecked: row.lastChecked,
      lastResponseMs: row.lastResponseMs,
      pollingInterval: row.pollingInterval,
    });
    monitorsByAsset.set(row.assetId, list);
  }

  for (const row of assetRows) {
    out.set(row.id, {
      asset: {
        isOnline: row.isOnline,
        statusObservedAt: row.statusObservedAt,
        statusSource: row.statusSource,
        lastSeenAt: row.lastSeenAt,
        lastProbeAt: row.lastProbeAt,
        lastProbeStatus: row.lastProbeStatus,
        lastProbeResponseMs: row.lastProbeResponseMs,
      },
      snmpDevice: snmpByAsset.get(row.id) ?? null,
      networkMonitors: monitorsByAsset.get(row.id) ?? [],
      scanIntervalSeconds: scanIntervalSecondsFrom(row.profileSchedule as ProfileSchedule),
    });
  }

  return out;
}

/** Convenience wrapper: load and derive with ONE clock for the whole page. */
export async function loadReachability(assetIds: string[], now: Date = new Date()): Promise<Map<string, Reachability>> {
  const inputs = await loadReachabilityInputs(assetIds);
  const out = new Map<string, Reachability>();
  for (const [assetId, input] of inputs) out.set(assetId, deriveReachability(input, now));
  return out;
}
```

- [ ] **Step 3: Run the tests and typecheck**

Run: `cd apps/api && npx vitest run src/services/assetReachabilityLoader.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: tests PASS; no type errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/assetReachabilityLoader.ts apps/api/src/services/assetReachabilityLoader.test.ts
git commit -m "$(cat <<'COMMIT_EOF'
feat(monitoring): batched reachability input loader (W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT_EOF
)"
```

---

### Task 5: Stamp `status_observed_at` / `status_source` at all five writers

**Files:**
- Modify: `apps/api/src/jobs/discoveryWorker.ts:709-732` (`buildScanUpdateSet`), `:1157-1163` (approval decision), `:1288-1291` (disappeared sweep)
- Modify: `apps/api/src/services/unifi/unifiSyncService.ts:159-170` (the `enrich` object)
- Modify: `apps/api/src/services/unifi/unifiTelemetryService.ts:63-70` (the `enrich` object)
- Test: `apps/api/src/jobs/discoveryWorker.test.ts` (extend), `apps/api/src/services/unifi/unifiSyncService.test.ts` (extend)

**Interfaces:**
- Consumes: the columns from Task 1.
- Produces: no new exports. `buildScanUpdateSet` gains two keys in its returned `PgUpdateSetSource<typeof discoveredAssets>`.

Spec §4.3 lists exactly five writers. `routes/devices/network.ts:390` (manual asset creation) leaves both NULL and must NOT be touched — a hand-entered row has been observed by nobody.

- [ ] **Step 1: Write the failing assertions**

Append to `apps/api/src/jobs/discoveryWorker.test.ts` (inside the existing `describe('buildScanUpdateSet')` block, or a new one if that name differs — check the file first):

```ts
  it('stamps status provenance on every scan sighting (spec §4.3)', () => {
    const set = buildScanUpdateSet({ isOnline: true, lastSeenAt: new Date() }, null) as Record<string, unknown>;
    expect(set.statusSource).toBe('scan');
    expect(set.statusObservedAt).toBeInstanceOf(Date);
  });
```

Append to `apps/api/src/services/unifi/unifiSyncService.test.ts`:

```ts
  it('stamps status provenance as unifi on an enriched asset (spec §4.3)', async () => {
    // Arrange per the file's existing reconcileDiscoveredAsset fixture, then:
    const updateSet = captured.updateSets.at(-1) as Record<string, unknown>;
    expect(updateSet.statusSource).toBe('unifi');
    expect(updateSet.statusObservedAt).toBeInstanceOf(Date);
  });
```

Run: `cd apps/api && npx vitest run src/jobs/discoveryWorker.test.ts src/services/unifi/unifiSyncService.test.ts`
Expected failure: `expected undefined to be 'scan'` / `expected undefined to be 'unifi'`.

- [ ] **Step 2: Stamp in `buildScanUpdateSet` (`discoveryWorker.ts:709`)**

Immediately after the `const updateSet: PgUpdateSetSource<typeof discoveredAssets> = { ...(assetData as …) };` line, add:

```ts
  // Spec §4.3 — every writer of `is_online` dates and attributes its verdict.
  // A scan sighting is a `scan`-sourced observation taken now; `last_seen_at`
  // keeps its own meaning (last POSITIVE sighting) and is untouched here.
  updateSet.statusObservedAt = new Date();
  updateSet.statusSource = 'scan';
```

- [ ] **Step 3: Stamp at the approval decision (`discoveryWorker.ts:1157`)**

```ts
    // Update approvalStatus and isOnline
    if (upsertedAssetId) {
      await db.update(discoveredAssets)
        .set({
          approvalStatus: decision.approvalStatus,
          isOnline: true,
          // Spec §4.3 — this is the second place a scan writes is_online, and
          // it runs AFTER buildScanUpdateSet's upsert, so it would otherwise
          // leave a newer verdict wearing the older stamp.
          statusObservedAt: new Date(),
          statusSource: 'scan',
        })
        .where(eq(discoveredAssets.id, upsertedAssetId));
    }
```

- [ ] **Step 4: Stamp at the disappeared sweep (`discoveryWorker.ts:1288`)**

```ts
        await db.update(discoveredAssets)
          .set({
            isOnline: false,
            // Spec §4.3 — THE stamp that matters most. Before this, the sweep
            // wrote is_online = false without touching any timestamp, so the
            // row said "offline" with no way to tell whether that verdict was
            // five minutes or five weeks old. deriveReachability refuses to
            // rank an undated negative at all, so an unstamped sweep result is
            // silently ignored — this line is what makes the sweep count.
            statusObservedAt: new Date(),
            statusSource: 'scan',
          })
          .where(eq(discoveredAssets.id, asset.id));
```

- [ ] **Step 5: Stamp in both UniFi services**

In `unifiSyncService.ts`, inside the `enrich` object (after `isOnline: isUnifiDeviceOnline(device.adoptionState),`):

```ts
    // Spec §4.3 — UniFi writes is_online UNCONDITIONALLY on every sync pass,
    // which is exactly why D1 rejected materialised reachability columns. The
    // stamp lets the reachability service age this claim out after 60 min
    // instead of trusting it forever.
    statusObservedAt: new Date(),
    statusSource: 'unifi' as const,
```

In `unifiTelemetryService.ts`, inside its `enrich` object (after `isOnline: true,`):

```ts
    // Spec §4.3 — same contract as unifiSyncService.ts.
    statusObservedAt: new Date(),
    statusSource: 'unifi' as const,
```

Both `enrich` objects are spread into BOTH the update set and the insert/conflict set, so the net-new insert path is stamped too — verify that in each file before moving on (`unifiSyncService.ts:187` `const conflictSet: AssetWriteSet = { ...enrich };`). If `AssetWriteSet` is an explicit type alias rather than `PgUpdateSetSource`, add the two fields to it.

- [ ] **Step 6: Run the tests**

Run: `cd apps/api && npx vitest run src/jobs/discoveryWorker src/services/unifi`
Expected: PASS. Note the bare substring filter (no trailing slash) — it picks up `discoveryWorker.test.ts` and every dotted sibling. Check the reported file count is what you expect.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs/discoveryWorker.ts apps/api/src/jobs/discoveryWorker.test.ts \
        apps/api/src/services/unifi/unifiSyncService.ts apps/api/src/services/unifi/unifiSyncService.test.ts \
        apps/api/src/services/unifi/unifiTelemetryService.ts
git commit -m "$(cat <<'COMMIT_EOF'
feat(monitoring): stamp status_observed_at/status_source at all five is_online writers (W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT_EOF
)"
```

---

### Task 6: Wire `reachability` into every consumer

**Files:**
- Modify: `apps/api/src/routes/discovery.ts:1126-1162` (`GET /assets` serialization), `:1246-1290` (`GET /assets/:id` serialization), `:1825` (topology node `status`)
- Modify: `apps/api/src/routes/devices/network.ts:54-96` (`toUnifiedListShape`), `:252-305` (the list query and mapping)
- Modify: `apps/api/src/routes/monitoring.ts:278-331` (`GET /assets` mapping), `:384-415` (`GET /assets/:id` response)
- Modify: `apps/api/src/services/aiToolsMonitoring.ts:137-141` (`query_monitors` result)
- Modify: `apps/api/src/services/aiToolsNetwork.ts` (new tool, see DECISION)
- Test: `apps/api/src/routes/devices/network.test.ts`, `apps/api/src/routes/monitoring.test.ts`, `apps/api/src/services/aiToolsMonitoring.test.ts` (extend each)

**Interfaces:**
- Consumes: `loadReachability` (Task 4), `reachabilityToListStatus` (Task 3).
- Produces: a `reachability: Reachability` field on `GET /discovery/assets` rows, `GET /discovery/assets/:id`, `GET /devices/network` rows, `GET /monitoring/assets` rows, `GET /monitoring/assets/:id`; `status` on the two list shapes derived from it.

**DECISION — the AI tools.** Spec §4.4 says "AI tools that report asset online state … read `reachability`" and §12 says "the plan enumerates the exact tools". Enumerated against main (8b21b0470): **no AI tool reports discovered-asset online state today.** `aiToolsNetwork.ts` registers `get_network_changes`, `acknowledge_network_device`, `configure_network_baseline`, `get_ip_history`, `network_discovery` — none selects `discoveredAssets.isOnline`. `aiToolsMonitoring.ts` registers `query_monitors`, `manage_monitors`, `get_service_monitoring_status`; it joins `discoveredAssets` for site scoping only and reports `networkMonitors.lastStatus`. So there is nothing to "switch". Two changes instead, both additive:
1. `query_monitors` gains a per-monitor `assetReachability` block (state, source, observedAt) for asset-bound monitors, so the agent can say "the monitor is offline but the device is responding via SNMP" instead of implying the device is down.
2. `aiToolsNetwork.ts` gains a new Tier-1 tool `get_network_asset_reachability` — the read the AI needs and has never had. Without it the agent's only route to "is this printer up" is `query_devices`, whose network arm returns the list `status`, which this wave already derives from `reachability`.

- [ ] **Step 1: Write the failing route assertions**

Add to `apps/api/src/routes/devices/network.test.ts`:

```ts
  it('derives list status from reachability, not is_online (spec §4.4)', async () => {
    // Fixture: is_online = true from a 19-hour-old scan whose profile polls hourly.
    // The old code said "online"; the derived answer is "unknown".
    const res = await app.request('/devices/network?orgId=' + ORG_ID, {}, env);
    const body = await res.json();
    expect(body.data[0].status).toBe('unknown');
    expect(body.data[0].reachability.state).toBe('unverified');
    expect(body.data[0].reachability.lastKnown).toEqual({
      state: 'responding', source: 'scan', observedAt: NINETEEN_HOURS_AGO,
    });
  });

  it('still exposes is_online alongside it for one release', async () => {
    const res = await app.request('/devices/network?orgId=' + ORG_ID, {}, env);
    const body = await res.json();
    expect(body.data[0].isOnline).toBe(true);
  });
```

Add to `apps/api/src/routes/monitoring.test.ts`:

```ts
  it('GET /monitoring/assets/:id reports reachability with its source', async () => {
    const res = await app.request(`/monitoring/assets/${ASSET_ID}`, {}, env);
    const body = await res.json();
    expect(body.reachability.state).toBe('responding');
    expect(body.reachability.source).toBe('snmp');
  });
```

Run: `cd apps/api && npx vitest run src/routes/devices/network.test.ts src/routes/monitoring.test.ts`
Expected failure: `expected 'online' to be 'unknown'` and `Cannot read properties of undefined (reading 'state')`.

- [ ] **Step 2: `GET /devices/network`**

In `routes/devices/network.ts`, extend `UnifiedListSourceRow` and `toUnifiedListShape`:

```ts
interface UnifiedListSourceRow {
  // … existing fields unchanged …
  /** W01 (spec §4.4) — supplied by the caller from loadReachability(). */
  reachability?: Reachability;
}
```

Replace the `status` derivation in `toUnifiedListShape`:

```ts
    // W01 (spec §4.4): status IS reachability now. The old expression read
    // `is_online` — the last subnet sweep's verdict, which on a daily-scan
    // profile is up to 24 h stale and which the disappeared sweep could flip to
    // false without dating it. `unverified` maps to 'unknown', never 'offline':
    // that conflation is both F1 and the #4622 manual-asset bug.
    //
    // No reachability (the POST arm's `.returning()` echo, which has no
    // monitors and no scan yet) keeps the #5213 manual-asset rule.
    status: r.reachability
      ? reachabilityToListStatus(r.reachability)
      : r.lastSeenAt === null && r.source === 'manual'
        ? ('unknown' as const)
        : r.isOnline ? ('online' as const) : ('offline' as const),
    // Retained for one release and documented as the last scan/controller
    // verdict (spec §4.4). The web reads `reachability`; nothing new may read
    // this.
    isOnline: r.isOnline,
    reachability: r.reachability ?? null,
```

Add `isOnline: r.isOnline` to the returned object if it is not already present, and import at the top:

```ts
import { reachabilityToListStatus, type Reachability } from '../../services/assetReachability';
import { loadReachability } from '../../services/assetReachabilityLoader';
```

In the GET handler, after `const rows = await db.select({...})…offset(offset);`:

```ts
    // One batched load for the page (three queries), never per row.
    const reachabilityByAsset = await loadReachability(rows.map((r) => r.id));
    const data = rows.map((r) => toUnifiedListShape({
      ...(r as UnifiedListSourceRow),
      reachability: reachabilityByAsset.get(r.id),
    }));
```

The POST arm keeps calling `toUnifiedListShape` without a `reachability` key — a row created one millisecond ago has been observed by nobody, and inventing an `unverified` object for it would be noise.

- [ ] **Step 3: `GET /discovery/assets` and `GET /discovery/assets/:id`**

In `routes/discovery.ts`, add the import:

```ts
import { loadReachability } from '../services/assetReachabilityLoader';
```

In `GET /assets` (line ~1125), between the query and the `c.json(...)`:

```ts
    const reachabilityByAsset = await loadReachability(results.map((row) => row.asset.id));
```

and add to the mapped object (next to `isOnline: a.isOnline,`):

```ts
          // W01 (spec §4.4). `isOnline` above is retained for one release and
          // means "last scan/controller verdict"; everything new reads this.
          reachability: reachabilityByAsset.get(a.id) ?? null,
```

In `GET /assets/:id` (line ~1246), after the `if (!row) return c.json({ error: 'Asset not found' }, 404);` and site check:

```ts
    const reachability = (await loadReachability([a.id])).get(a.id) ?? null;
```

and add `reachability,` to the `data` object next to `isOnline: a.isOnline,`.

- [ ] **Step 4: topology node status (`routes/discovery.ts:1825`)**

In `GET /topology`, after the `assets` query:

```ts
    // W01 (spec §4.4) — the topology map is an asset-status export like any
    // other, so it takes the same derivation. 'unknown' is a real third state
    // here: the client renders it muted rather than as a red node.
    const topologyReachability = await loadReachability(assets.map((a) => a.id));
```

and replace line 1825:

```ts
        status: reachabilityToListStatus(
          topologyReachability.get(a.id) ?? { state: 'unverified', source: null, observedAt: null, lastKnown: null, detail: {} },
        ),
```

Add `reachabilityToListStatus` to the `services/assetReachability` import. Confirm the Cytoscape client tolerates `'unknown'`; if it does not, that is a W05 UI task — file it, do not weaken the API.

- [ ] **Step 5: `GET /monitoring/assets` and `/assets/:id`**

In `routes/monitoring.ts`, import `loadReachability`. In `GET /assets`, after the `assets` query:

```ts
    const reachabilityByAsset = await loadReachability(assets.map((a) => a.id));
```

and add to the mapped row, next to `isOnline: a.isOnline,`:

```ts
          reachability: reachabilityByAsset.get(a.id) ?? null,
```

In `GET /assets/:id`, compute `const reachability = (await loadReachability([assetId])).get(assetId) ?? null;` right after the site check, and add `reachability,` to BOTH `c.json` returns (the `!snmpDevice` early return and the full one). Missing the early return is the easy mistake: an asset with network checks but no SNMP row takes that branch.

- [ ] **Step 6: `query_monitors` reports asset reachability**

In `aiToolsMonitoring.ts`, add `assetId: networkMonitors.assetId` to the `selection` object, then after the `rows` query:

```ts
      // W01 (spec §4.4): never phrase a monitor's verdict as the DEVICE's
      // state. A failing HTTP check on a reachable host is a TLS problem, not
      // an outage, and the agent used to have no way to tell them apart.
      const assetIds = rows.map((r) => r.assetId).filter((id): id is string => Boolean(id));
      const reachabilityByAsset = await loadReachability(assetIds);

      return JSON.stringify({
        monitors: rows.map((row) => ({
          ...row,
          assetReachability: row.assetId
            ? (() => {
                const r = reachabilityByAsset.get(row.assetId!);
                return r ? { state: r.state, source: r.source, observedAt: r.observedAt } : null;
              })()
            : null,
        })),
        showing: rows.length,
      });
```

- [ ] **Step 7: New `get_network_asset_reachability` tool**

In `aiToolsNetwork.ts`, after the `get_ip_history` registration:

```ts
  // ============================================
  // 5. get_network_asset_reachability - Tier 1 (read-only)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_network_asset_reachability',
      description:
        'Report whether a discovered network asset (printer, switch, AP, camera, NAS) is currently reachable, '
        + 'with the SOURCE of the evidence and how old it is. Always state the source and age when answering — '
        + '"responding via SNMP 2 minutes ago", never a bare "online". A state of "unverified" means nothing has '
        + 'checked the device recently; report it as unverified, not as down.',
      input_schema: {
        type: 'object' as const,
        properties: {
          asset_id: { type: 'string', description: 'Discovered asset UUID' },
        },
        required: ['asset_id'],
      },
    },
    handler: async (input, auth) => {
      const assetId = typeof input.asset_id === 'string' ? input.asset_id : '';
      if (!assetId) return JSON.stringify({ error: 'asset_id is required' });

      // Org axis via RLS + the explicit predicate; site axis app-layer, fail closed.
      const conditions: SQL[] = [eq(discoveredAssets.id, assetId)];
      const orgCondition = auth.orgCondition(discoveredAssets.orgId);
      if (orgCondition) conditions.push(orgCondition);
      if (auth.allowedSiteIds !== undefined) {
        if (auth.allowedSiteIds.length === 0) return JSON.stringify({ error: 'Asset not found or access denied' });
        conditions.push(inArray(discoveredAssets.siteId, auth.allowedSiteIds));
      }

      const [asset] = await db
        .select({
          id: discoveredAssets.id,
          label: discoveredAssets.label,
          hostname: discoveredAssets.hostname,
          ipAddress: discoveredAssets.ipAddress,
          assetType: discoveredAssets.assetType,
          siteId: discoveredAssets.siteId,
        })
        .from(discoveredAssets)
        .where(and(...conditions))
        .limit(1);

      if (!asset) return JSON.stringify({ error: 'Asset not found or access denied' });
      if (siteAccessDenied(auth, asset.siteId)) return JSON.stringify({ error: 'Asset not found or access denied' });

      const reachability = (await loadReachability([asset.id])).get(asset.id) ?? null;

      return JSON.stringify({
        asset: {
          id: asset.id,
          name: asset.label ?? asset.hostname ?? asset.ipAddress ?? asset.id,
          assetType: asset.assetType,
          ipAddress: asset.ipAddress,
        },
        reachability,
      });
    },
  });
```

Add `discoveredAssets` to the `../db/schema` import and `loadReachability` from `./assetReachabilityLoader` at the top of the file. `siteAccessDenied`, `db`, `eq`, `and`, `inArray` and `SQL` are already imported there.

- [ ] **Step 8: Run the affected suites and typecheck**

Run:
```
cd apps/api && npx vitest run \
  src/routes/devices/network.test.ts \
  src/routes/monitoring.test.ts \
  src/routes/discovery.test.ts \
  src/services/aiToolsMonitoring.test.ts \
  src/services/aiToolsNetwork.test.ts \
&& npx tsc --noEmit -p tsconfig.json
```
Expected: all PASS. If `aiTools` registration-count or MCP-tool-declaration contract tests fail on the new tool, register it in the declared-tool list they read — an undeclared MCP tool is the exact failure that killed Fleet Design W03-W05 on main.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/discovery.ts apps/api/src/routes/devices/network.ts \
        apps/api/src/routes/monitoring.ts apps/api/src/services/aiToolsNetwork.ts \
        apps/api/src/services/aiToolsMonitoring.ts apps/api/src/routes/devices/network.test.ts \
        apps/api/src/routes/monitoring.test.ts apps/api/src/services/aiToolsMonitoring.test.ts
git commit -m "$(cat <<'COMMIT_EOF'
feat(monitoring): sourced reachability on every asset consumer and the AI tools (W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT_EOF
)"
```

---

### Task 7: `services/assetIdentity.ts` — read-time model mask and `nicVendor`

**Files:**
- Create: `apps/api/src/services/assetIdentity.ts`
- Test: `apps/api/src/services/assetIdentity.test.ts`
- Modify: `apps/api/src/routes/discovery.ts` (`GET /assets`, `GET /assets/:id`), `apps/api/src/routes/devices/network.ts` (`toUnifiedListShape`)

**Interfaces:**
- Consumes: `lookupMacVendor` from `./macVendorLookup`.
- Produces:

```ts
export function maskOidShapedModel(model: string | null): string | null;
export function nicVendorFromMac(mac: string | null): string | null;
export const OID_SHAPED_MODEL = /^\.?1(\.\d+)+$/;
```

W03 adds `resolveAssetIdentity(...)` and `services/ianaEnterprise.ts` to this same module. W01 ships only the read-time guard (§9), so a Xerox C325 stops rendering `.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1` as its model the day W01 lands, without waiting for W03's ingest-side resolution.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { maskOidShapedModel, nicVendorFromMac } from './assetIdentity';

describe('maskOidShapedModel', () => {
  it.each([
    ['.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1'],
    ['1.3.6.1.4.1.253.8.62.1.37.1.4.1.1'],
    ['1.3.6.1.4.1.9.1.1745'],
    ['1.2'],
  ])('masks the raw sysObjectID %s', (model) => {
    expect(maskOidShapedModel(model)).toBeNull();
  });

  it.each([
    ['Xerox C325 Color MFP'],
    ['C3750'],
    // A real model number that merely contains digits and dots must survive.
    ['HL-L2350DW'],
    ['UAP-AC-PRO'],
    ['ET-2.5G'],
    // Only OIDs rooted at 1 (iso) are masked; a version-looking string is not.
    ['2.4.1'],
    ['1'],
  ])('keeps the real model %s', (model) => {
    expect(maskOidShapedModel(model)).toBe(model);
  });

  it('passes null and empty through', () => {
    expect(maskOidShapedModel(null)).toBeNull();
    expect(maskOidShapedModel('')).toBeNull();
  });
});

describe('nicVendorFromMac', () => {
  it('returns the OUI vendor', () => {
    expect(nicVendorFromMac('00:20:00:11:22:33')).toMatch(/LEXMARK/i);
  });

  it('returns null for null, a malformed MAC and a sentinel', () => {
    expect(nicVendorFromMac(null)).toBeNull();
    expect(nicVendorFromMac('not-a-mac')).toBeNull();
    expect(nicVendorFromMac('')).toBeNull();
  });
});
```

Run: `cd apps/api && npx vitest run src/services/assetIdentity.test.ts`
Expected failure: `Failed to resolve import "./assetIdentity"`.

- [ ] **Step 2: Implement**

```ts
/**
 * Read-time asset identity guards (spec §9, decision D6).
 *
 * W01 ships ONLY the read-time pieces: the mask that stops a raw sysObjectID
 * rendering as a model, and the NIC-vendor derivation. W03 adds
 * `resolveAssetIdentity()` (ingest-side enterprise-number resolution and the
 * vendor model extractors) to this same module — so the read guard protects
 * every row already in the database, including the ones W03 will never re-scan.
 *
 * WHY A MASK AND NOT A BACKFILL: agent/internal/discovery/classify.go:45 writes
 * `model = sysObjectID` whenever nothing better is known, and old agents will
 * keep doing that until they update. A one-off UPDATE would fix today's rows
 * and be re-broken by tomorrow's scan.
 */

import { lookupMacVendor } from './macVendorLookup';

/**
 * A dotted-decimal OID rooted at 1 (iso). Anchored at BOTH ends and requiring
 * at least two components, so real model numbers that merely contain digits and
 * dots ("HL-L2350DW", "ET-2.5G", "UAP-AC-PRO") never match. `2.4.1` does not
 * match either: SNMP object identifiers in this position are always iso-rooted.
 */
export const OID_SHAPED_MODEL = /^\.?1(\.\d+)+$/;

/**
 * Null out a `model` that is really a sysObjectID. The raw value is still
 * available to the UI as `snmpData.sysObjectId`, which is where an operator
 * looking for it expects to find it (the "All scan details" disclosure, §11).
 */
export function maskOidShapedModel(model: string | null): string | null {
  if (!model) return null;
  return OID_SHAPED_MODEL.test(model.trim()) ? null : model;
}

/**
 * The OUI vendor of the asset's MAC, exposed SEPARATELY from `manufacturer`.
 *
 * These are different facts and conflating them is F5: a Xerox C325 has a
 * Lexmark-built engine, so its OUI says LEXMARK while the device is a Xerox.
 * The UI shows this only when it differs from `manufacturer` (§11).
 */
export function nicVendorFromMac(mac: string | null): string | null {
  return lookupMacVendor(mac);
}
```

- [ ] **Step 3: Apply at the asset response boundaries**

In `routes/discovery.ts`, import `{ maskOidShapedModel, nicVendorFromMac }` from `../services/assetIdentity`, then in BOTH `GET /assets` and `GET /assets/:id` replace `model: a.model,` with:

```ts
          // Spec §9 read-time guard — a raw sysObjectID is not a model. The raw
          // value stays reachable through snmpData.sysObjectId.
          model: maskOidShapedModel(a.model),
          nicVendor: nicVendorFromMac(a.macAddress),
```

In `routes/devices/network.ts`, inside `toUnifiedListShape`, replace `model: r.model ?? null,` with the same two lines (using `r.model` / `r.macAddress`).

- [ ] **Step 4: Run and commit**

Run: `cd apps/api && npx vitest run src/services/assetIdentity.test.ts src/routes/discovery.test.ts src/routes/devices/network.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

```bash
git add apps/api/src/services/assetIdentity.ts apps/api/src/services/assetIdentity.test.ts \
        apps/api/src/routes/discovery.ts apps/api/src/routes/devices/network.ts
git commit -m "$(cat <<'COMMIT_EOF'
feat(monitoring): mask OID-shaped models and expose nicVendor at read time (W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT_EOF
)"
```

---

### Task 8: `services/networkExecutorSelection.ts` — one site-strict executor picker

**Files:**
- Create: `apps/api/src/services/networkExecutorSelection.ts`
- Test: `apps/api/src/services/networkExecutorSelection.test.ts`
- Modify: `apps/api/src/jobs/monitorWorker.ts:282-332` (`selectExecutionAgentForMonitor` becomes a delegate)
- Modify: `apps/api/src/routes/monitors.ts:180-222` (`selectExecutionAgentForMonitor` becomes a delegate)
- Modify: `apps/api/src/jobs/monitorWorker.test.ts:167-215` (the existing SR5-08 describe keeps passing unchanged)

**Interfaces:**
- Consumes: `db`, `devices`, `discoveredAssets`.
- Produces:

```ts
export type NetworkExecutorPick = { agentId: string } | { error: 'no_agent_in_site' };
export async function selectNetworkExecutor(input: {
  orgId: string;
  /** Non-null ⇒ site-strict. Null ⇒ org-wide (unbound monitors only). */
  siteId: string | null;
  /** Optional extra allowlist for a site-restricted CALLER on the org-wide branch. */
  restrictToSiteIds?: string[] | null;
}): Promise<NetworkExecutorPick>;
export async function loadAssetSiteId(orgId: string, assetId: string): Promise<string | null>;
```

**DECISIONS.**
1. **`siteId: null` means org-wide, not "fail".** The index calls the service "site-strict"; that is about asset-BOUND work. `jobs/monitorWorker.ts` legitimately selects org-wide for a monitor with no asset (`selectExecutionAgentForMonitor({ orgId, assetId: null })`), and collapsing that to a failure would silently stop every assetless monitor. Asset-bound callers (the probe, §5) resolve the site first and refuse with `ASSET_NO_SITE` before calling, so they can never reach the org-wide branch.
2. **`routes/monitors.ts` `POST /:id/test` loses its cross-site fallback.** Today it tries the asset's site, and when no online agent is there it falls back to ANY online agent in the org — the exact behaviour SR5-08 removed from the worker, which means a "Test" button can direct a root-level agent in another site to probe this target. Spec §5 says "no org-wide fallback for asset-bound work"; the extraction makes `/test` match the worker. **Behaviour change:** `/test` on an asset-bound monitor whose site has no online agent now returns the existing `{ status: 'failed', error: 'No online agent available' }` body instead of probing from elsewhere.
3. **`isEphemeral: false` now applies to `/test` too.** The worker excludes Quick Support devices (a stranger's borrowed home PC); `routes/monitors.ts` never did. The shared picker carries the exclusion, so this is a bug fix riding along — call it out in the PR body.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/networkExecutorSelection.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

let selectResults: unknown[][] = [];
const captured: { wheres: unknown[] } = { wheres: [] };

vi.mock('../db', () => {
  const chain = () => {
    const rows = selectResults.shift() ?? [];
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.where = (condition: unknown) => { captured.wheres.push(condition); return c; };
    c.limit = () => Promise.resolve(rows);
    c.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => Promise.resolve(rows).then(ok, err);
    return c;
  };
  return { db: { select: () => chain() } };
});

import { selectNetworkExecutor, loadAssetSiteId } from './networkExecutorSelection';

const dialect = new PgDialect();
const render = (v: unknown) => dialect.sqlToQuery(v as SQL);

beforeEach(() => { selectResults = []; captured.wheres = []; });

describe('selectNetworkExecutor', () => {
  it('picks an online agent in the asset site', async () => {
    selectResults = [[{ agentId: 'agent-site' }]];
    await expect(selectNetworkExecutor({ orgId: 'org-1', siteId: 'site-1' })).resolves.toEqual({ agentId: 'agent-site' });
    expect(render(captured.wheres[0]).sql).toContain('site_id');
  });

  it('NEVER crosses the site boundary when the site has no online agent (SR5-08)', async () => {
    selectResults = [[]];
    await expect(selectNetworkExecutor({ orgId: 'org-1', siteId: 'site-1' })).resolves.toEqual({ error: 'no_agent_in_site' });
    // Exactly one query: there is no org-wide second attempt to fall through to.
    expect(captured.wheres).toHaveLength(1);
  });

  it('excludes ephemeral Quick Support devices on both branches', async () => {
    selectResults = [[{ agentId: 'a' }]];
    await selectNetworkExecutor({ orgId: 'org-1', siteId: 'site-1' });
    expect(render(captured.wheres[0]).sql).toContain('is_ephemeral');

    captured.wheres = [];
    selectResults = [[{ agentId: 'b' }]];
    await selectNetworkExecutor({ orgId: 'org-1', siteId: null });
    expect(render(captured.wheres[0]).sql).toContain('is_ephemeral');
  });

  it('selects org-wide for an unbound monitor', async () => {
    selectResults = [[{ agentId: 'agent-org' }]];
    await expect(selectNetworkExecutor({ orgId: 'org-1', siteId: null })).resolves.toEqual({ agentId: 'agent-org' });
    expect(render(captured.wheres[0]).sql).not.toContain('site_id');
  });

  it('honours restrictToSiteIds on the org-wide branch', async () => {
    selectResults = [[{ agentId: 'agent-allowed' }]];
    await selectNetworkExecutor({ orgId: 'org-1', siteId: null, restrictToSiteIds: ['site-a', 'site-b'] });
    const { sql, params } = render(captured.wheres[0]);
    expect(sql).toContain('site_id');
    expect(params).toContain('site-a');
  });

  it('refuses immediately when restrictToSiteIds is empty', async () => {
    await expect(selectNetworkExecutor({ orgId: 'org-1', siteId: null, restrictToSiteIds: [] }))
      .resolves.toEqual({ error: 'no_agent_in_site' });
    expect(captured.wheres).toHaveLength(0);
  });
});

describe('loadAssetSiteId', () => {
  it('scopes the lookup by org', async () => {
    selectResults = [[{ siteId: 'site-9' }]];
    await expect(loadAssetSiteId('org-1', 'asset-1')).resolves.toBe('site-9');
    const { sql } = render(captured.wheres[0]);
    expect(sql).toContain('org_id');
  });

  it('returns null when the asset is not in the org', async () => {
    selectResults = [[]];
    await expect(loadAssetSiteId('org-1', 'asset-1')).resolves.toBeNull();
  });
});
```

Run: `cd apps/api && npx vitest run src/services/networkExecutorSelection.test.ts`
Expected failure: `Failed to resolve import "./networkExecutorSelection"`.

- [ ] **Step 2: Implement**

```ts
/**
 * THE executor picker for asset-bound network work (spec §5, SR5-08).
 *
 * Extracted verbatim from jobs/monitorWorker.ts so the monitor worker, the
 * monitors `/test` route and the manual probe cannot drift. Before this there
 * were two copies with different rules: the worker was site-strict and excluded
 * ephemeral devices, the route fell back org-wide and did not — so "Test" could
 * direct a root-level agent in another site, or a stranger's Quick Support
 * machine, to probe the target.
 *
 * QUICK SUPPORT EXCLUSION (both branches): ephemeral devices live in the hidden
 * per-partner 'quick_support' org and are a stranger's personal machine
 * borrowed for one ~20-minute session. That org stays inside technicians'
 * accessibleOrgIds for RLS reasons, so background workers are NOT filtered for
 * us. Such a device must never be conscripted to run network probes on a home
 * network.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { devices, discoveredAssets } from '../db/schema';

export type NetworkExecutorPick = { agentId: string } | { error: 'no_agent_in_site' };

export async function loadAssetSiteId(orgId: string, assetId: string): Promise<string | null> {
  const [asset] = await db
    .select({ siteId: discoveredAssets.siteId })
    .from(discoveredAssets)
    .where(and(eq(discoveredAssets.id, assetId), eq(discoveredAssets.orgId, orgId)))
    .limit(1);
  return asset?.siteId ?? null;
}

export async function selectNetworkExecutor(input: {
  orgId: string;
  siteId: string | null;
  restrictToSiteIds?: string[] | null;
}): Promise<NetworkExecutorPick> {
  const conditions = [
    eq(devices.orgId, input.orgId),
    eq(devices.isEphemeral, false),
    eq(devices.status, 'online'),
  ];

  if (input.siteId) {
    // Site-bound: the executing agent MUST live in the target's site. There is
    // deliberately NO org-wide second attempt — crossing the boundary would
    // direct an agent in another site to probe this target (SR5-08).
    conditions.push(eq(devices.siteId, input.siteId));
  } else if (input.restrictToSiteIds) {
    // Unbound target, site-restricted CALLER: the org-wide branch narrows to
    // what the caller may see. An empty allowlist can match nothing.
    if (input.restrictToSiteIds.length === 0) return { error: 'no_agent_in_site' };
    conditions.push(inArray(devices.siteId, input.restrictToSiteIds));
  }

  const [agent] = await db
    .select({ agentId: devices.agentId })
    .from(devices)
    .where(and(...conditions))
    .limit(1);

  return agent?.agentId ? { agentId: agent.agentId } : { error: 'no_agent_in_site' };
}
```

- [ ] **Step 3: Delegate from `jobs/monitorWorker.ts`**

Replace the whole body of `selectExecutionAgentForMonitor` (lines 282-332) with:

```ts
/**
 * Kept as a named export because monitorWorker.test.ts and
 * monitorWorker.dbcontext.test.ts assert on it directly. The rules now live in
 * services/networkExecutorSelection.ts, shared with routes/monitors.ts and the
 * manual probe (spec §5).
 */
export async function selectExecutionAgentForMonitor(
  monitor: { orgId: string; assetId: string | null },
): Promise<string | null> {
  const siteId = monitor.assetId ? await loadAssetSiteId(monitor.orgId, monitor.assetId) : null;
  const pick = await selectNetworkExecutor({ orgId: monitor.orgId, siteId });
  return 'agentId' in pick ? pick.agentId : null;
}
```

and add `import { loadAssetSiteId, selectNetworkExecutor } from '../services/networkExecutorSelection';`. Delete the now-unused local query code, then re-run `monitorWorker.dbcontext.test.ts` — it asserts DB-context DEPTH, and the delegation must not add a context wrapper (the service opens none).

- [ ] **Step 4: Delegate from `routes/monitors.ts`**

Replace `selectExecutionAgentForMonitor` (lines 180-222) with:

```ts
/**
 * Route-side wrapper: the site-ACCESS check (a 403 axis that RLS does not
 * defend) stays here; the agent pick is the shared service. The org-wide
 * fallback for an asset-BOUND monitor is gone on purpose — see spec §5 and the
 * SR5-08 note in services/networkExecutorSelection.ts. A monitor whose site has
 * no online agent now reports "No online agent available" rather than probing
 * from a different site.
 */
async function selectExecutionAgentForMonitor(
  monitor: { orgId: string; assetId: string | null },
  permissions?: UserPermissions,
): Promise<string | null | 'SITE_ACCESS_DENIED'> {
  const assetSiteId = await getMonitorSiteId(monitor);

  if (permissions?.allowedSiteIds) {
    if (assetSiteId && !canAccessSite(permissions, assetSiteId)) return 'SITE_ACCESS_DENIED';
    if (!assetSiteId && permissions.allowedSiteIds.length === 0) return 'SITE_ACCESS_DENIED';
  }

  const pick = await selectNetworkExecutor({
    orgId: monitor.orgId,
    siteId: assetSiteId,
    restrictToSiteIds: assetSiteId ? null : (permissions?.allowedSiteIds ?? null),
  });
  return 'agentId' in pick ? pick.agentId : null;
}
```

Add `import { selectNetworkExecutor } from '../services/networkExecutorSelection';` and drop the now-unused `inArray` import if nothing else in the file uses it (check — `monitors.ts` uses it elsewhere).

- [ ] **Step 5: Run every suite that touches executor selection**

Run:
```
cd apps/api && npx vitest run \
  src/services/networkExecutorSelection.test.ts \
  src/jobs/monitorWorker.test.ts \
  src/jobs/monitorWorker.dbcontext.test.ts \
  src/routes/monitors.test.ts \
&& npx tsc --noEmit -p tsconfig.json
```
Expected: `networkExecutorSelection` and both `monitorWorker` suites PASS unchanged (the worker's behaviour is identical). `monitors.test.ts` may have a test asserting the old cross-site fallback on `/test` — if so, invert it to assert the refusal and cite spec §5 in the test name; that is the intended change, not a regression.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/networkExecutorSelection.ts apps/api/src/services/networkExecutorSelection.test.ts \
        apps/api/src/jobs/monitorWorker.ts apps/api/src/routes/monitors.ts apps/api/src/routes/monitors.test.ts
git commit -m "$(cat <<'COMMIT_EOF'
refactor(monitoring): one site-strict network executor picker for worker, test route and probe (W01)

Closes the /test cross-site fallback and the missing Quick Support exclusion.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT_EOF
)"
```

---

### Task 9: `POST /discovery/assets/:id/probe` — dispatch, await, correlate, persist

**Files:**
- Create: `apps/api/src/services/assetAccessScope.ts` (+ `.test.ts`)
- Create: `apps/api/src/services/assetProbe.ts` (+ `.test.ts`)
- Create: `apps/api/src/routes/discoveryAssetProbe.ts` (+ `.test.ts`)
- Modify: `apps/api/src/routes/monitoring.ts:22-107` (delete the three local helpers, import them)
- Modify: `apps/api/src/routes/agentWs.ts:501-560` (expectation registry), `:1180-1214` (orphan dispatch)
- Modify: `apps/api/src/index.ts` (mount)

**Interfaces:**
- `services/assetAccessScope.ts`:

```ts
export type AssetAuthContext = {
  scope: string;
  orgId: string | null;
  accessibleOrgIds: string[] | null;
  canAccessOrg: (orgId: string) => boolean;
  user?: { id: string } | null;
};
export function resolveOrgIdForAuth(auth: AssetAuthContext, requestedOrgId?: string, requireForNonOrg?: boolean):
  { orgId: string } | { error: string; status: 400 | 403 };
export async function resolveOrgIdForAsset(auth: AssetAuthContext, assetId: string, requestedOrgId?: string):
  Promise<{ orgId: string } | { error: string; status: 400 | 403 | 404 }>;
export async function resolveAssetForMutation(auth: AssetAuthContext, perms: UserPermissions | undefined, assetId: string):
  Promise<{ asset: typeof discoveredAssets.$inferSelect } | { error: string; status: 400 | 403 | 404 }>;
```

- `services/assetProbe.ts`:

```ts
export const PROBE_WAIT_MS = 8_000;
export const PROBE_IN_FLIGHT_MS = 120_000;
export type ProbeOutcome = { status: 'ok' | 'failed'; responseMs: number | null; error: string | null };
export function buildProbeCommandId(assetId: string): string;          // `probe-<assetId>-<epochMs>`
export function parseProbeCommandId(commandId: string): string | null;  // assetId | null
export function awaitProbeResult(commandId: string, timeoutMs: number): Promise<ProbeOutcome | null>;
export async function applyProbeResult(input: {
  commandId: string; assetId: string; expectedIp: string; expectedSiteId: string;
  status: 'ok' | 'failed'; responseMs: number | null; error: string | null;
}): Promise<boolean>;
```

**DECISIONS.**
1. **Correlation lives in SQL, expectation lives in memory.** `applyProbeResult` runs one compare-and-swap `UPDATE … WHERE id = $assetId AND last_probe_ref = $commandId AND last_probe_status = 'pending' AND ip_address = $expectedIp AND site_id = $expectedSiteId` and returns whether a row changed. The expected ip/site come from the in-memory expectation recorded at dispatch — the same place the existing SNMP and monitor correlations get their expected target (`agentWs.ts:525`). A moved or re-addressed asset updates zero rows and the result is dropped with a warning; that is the §15 "probe correlation rejects a moved asset" contract.
2. **`probeAssetId` / `probeSiteId` ride the command payload.** `recordOrphanedResultExpectation` is called from inside `sendCommandToAgent`, which is the only place that runs on the instance holding the agent's socket — a relayed dispatch is re-sent there, so recording anywhere else would register the expectation on the wrong process. That means the expectation must be derivable from the payload, so those two ids go on the wire. The agent ignores unknown payload keys.
3. **The 8 s await is best-effort and instance-local.** `awaitProbeResult` resolves from an in-process promise registry. In a multi-instance deployment the result may land on the socket-holding instance instead, in which case the route times out and returns `202 { probe: { state: 'pending' } }` — correct and honest, and exactly the path §5.4 already describes for a slow agent. The durable write happens either way.
4. **The probe route lives in its own file.** `routes/discovery.ts` is 2,247 lines; CLAUDE.md says do not grow it. `discoveryAssetProbeRoutes` mounts as a second sub-router at `/discovery` in `index.ts` (ten prefixes there are already mounted twice).

- [ ] **Step 1: Extract the scope helpers (no behaviour change)**

Create `apps/api/src/services/assetAccessScope.ts` by MOVING `resolveOrgId` (renamed `resolveOrgIdForAuth`), `resolveOrgIdForAsset` and `resolveAssetForMonitoringMutation` (renamed `resolveAssetForMutation`) out of `routes/monitoring.ts:22-107`, verbatim except for the names and the added export keyword. Header:

```ts
/**
 * Org/site scope resolution for discovered-asset routes (spec §5, §12).
 *
 * Moved out of routes/monitoring.ts so the probe route can use the SAME
 * site-locking resolver rather than growing a third dialect of "which org is
 * this asset in, and may this caller touch it". Bodies are unchanged.
 *
 * resolveAssetForMutation takes `.for('update')` for a site-restricted caller,
 * so the ambient request transaction holds the row lock through the downstream
 * write and a concurrent asset move cannot invalidate the current-site decision
 * between check and use.
 */
```

In `routes/monitoring.ts`, delete the three functions and the now-unused `AuthContext` type, and add:

```ts
import {
  resolveOrgIdForAuth as resolveOrgId,
  resolveOrgIdForAsset,
  resolveAssetForMutation as resolveAssetForMonitoringMutation,
  type AssetAuthContext as AuthContext,
} from '../services/assetAccessScope';
```

The aliases keep all existing call sites (`monitoring.ts:174, 342, 450, 593, 669`) byte-identical, so this step is provably behaviour-neutral.

Run: `cd apps/api && npx vitest run src/routes/monitoring && npx tsc --noEmit -p tsconfig.json`
Expected: PASS with no test edits. If anything fails, the move was not verbatim — fix the move, do not adjust the tests.

Commit this step on its own:

```bash
git add apps/api/src/services/assetAccessScope.ts apps/api/src/routes/monitoring.ts
git commit -m "$(cat <<'COMMIT_EOF'
refactor(monitoring): extract asset org/site scope resolvers from the monitoring route (W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT_EOF
)"
```

- [ ] **Step 2: Write the failing `assetProbe` tests**

Create `apps/api/src/services/assetProbe.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured: { sets: Record<string, unknown>[]; wheres: unknown[] } = { sets: [], wheres: [] };
let updateReturning: unknown[] = [];

vi.mock('../db', () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        captured.sets.push(values);
        return {
          where: (condition: unknown) => {
            captured.wheres.push(condition);
            return { returning: () => Promise.resolve(updateReturning) };
          },
        };
      },
    }),
  },
}));

import {
  buildProbeCommandId,
  parseProbeCommandId,
  awaitProbeResult,
  applyProbeResult,
} from './assetProbe';

const ASSET = '33333333-3333-4333-8333-333333333333';

beforeEach(() => { captured.sets = []; captured.wheres = []; updateReturning = []; });

describe('probe command ids', () => {
  it('round-trips the asset id', () => {
    const id = buildProbeCommandId(ASSET);
    expect(id.startsWith(`probe-${ASSET}-`)).toBe(true);
    expect(parseProbeCommandId(id)).toBe(ASSET);
  });

  it('rejects ids that are not probes', () => {
    expect(parseProbeCommandId('snmp-abc-123')).toBeNull();
    expect(parseProbeCommandId(`mon-${ASSET}-1`)).toBeNull();
    expect(parseProbeCommandId('probe-not-a-uuid-1')).toBeNull();
    expect(parseProbeCommandId(`probe-${ASSET}`)).toBeNull();
  });

  it('never collides with the software-install id shape', () => {
    expect(parseProbeCommandId('sw-install-a-b-0')).toBeNull();
  });
});

describe('applyProbeResult', () => {
  const base = {
    commandId: buildProbeCommandId(ASSET),
    assetId: ASSET,
    expectedIp: '10.0.0.5',
    expectedSiteId: '44444444-4444-4444-8444-444444444444',
    status: 'ok' as const,
    responseMs: 4,
    error: null,
  };

  it('writes the outcome and reports true when the CAS matches', async () => {
    updateReturning = [{ id: ASSET }];
    await expect(applyProbeResult(base)).resolves.toBe(true);
    expect(captured.sets[0]).toMatchObject({ lastProbeStatus: 'ok', lastProbeResponseMs: 4 });
  });

  it('reports false and writes nothing durable when the asset moved', async () => {
    updateReturning = [];
    await expect(applyProbeResult({ ...base, expectedSiteId: 'other-site' })).resolves.toBe(false);
  });

  it('resolves a waiting awaitProbeResult with the outcome', async () => {
    updateReturning = [{ id: ASSET }];
    const waiting = awaitProbeResult(base.commandId, 1_000);
    await applyProbeResult(base);
    await expect(waiting).resolves.toEqual({ status: 'ok', responseMs: 4, error: null });
  });

  it('does NOT resolve the waiter when the CAS rejected the result', async () => {
    updateReturning = [];
    const waiting = awaitProbeResult(base.commandId, 60);
    await applyProbeResult(base);
    await expect(waiting).resolves.toBeNull();
  });
});

describe('awaitProbeResult', () => {
  it('resolves null on timeout and leaves no registry entry behind', async () => {
    await expect(awaitProbeResult('probe-nobody-1', 20)).resolves.toBeNull();
    // A second wait on the same id must not see a stale resolver.
    await expect(awaitProbeResult('probe-nobody-1', 20)).resolves.toBeNull();
  });
});
```

Run: `cd apps/api && npx vitest run src/services/assetProbe.test.ts`
Expected failure: `Failed to resolve import "./assetProbe"`.

- [ ] **Step 3: Implement `services/assetProbe.ts`**

```ts
/**
 * Manual "Check now" probe persistence and correlation (spec §5, decision D2).
 *
 * Two jobs:
 *
 *  1. CORRELATE. An agent's ping result carries no probe id of its own — the
 *     network_ping handler echoes `monitorId` (empty for a probe) and nothing
 *     else we control. So the command id IS the correlation key: it encodes the
 *     asset, it is stored on the asset at dispatch as `last_probe_ref`, and
 *     applyProbeResult compare-and-swaps against it. A result that names a
 *     different command, an asset that is no longer pending, or an asset whose
 *     ip/site changed since dispatch updates zero rows and is dropped.
 *
 *  2. WAIT, briefly. The route wants to answer inline when the agent is fast.
 *     The registry below is per-process and best-effort: in a multi-instance
 *     deployment the result lands on whichever instance holds the agent socket,
 *     the route times out, and the page picks the answer up by re-fetching the
 *     asset (spec §5.4). The DURABLE write does not depend on the wait.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { discoveredAssets } from '../db/schema';

export const PROBE_WAIT_MS = 8_000;
/** One in-flight probe per asset; a `pending` older than this is not in flight. */
export const PROBE_IN_FLIGHT_MS = 120_000;

const PROBE_ID_PREFIX = 'probe-';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProbeOutcome = { status: 'ok' | 'failed'; responseMs: number | null; error: string | null };

export function buildProbeCommandId(assetId: string): string {
  return `${PROBE_ID_PREFIX}${assetId}-${Date.now()}`;
}

/**
 * `probe-<uuid>-<epochMillis>` → the uuid. Anything else → null. The uuid check
 * is what keeps this from claiming `probe-something-else`, and the trailing
 * digits requirement keeps it from claiming a bare `probe-<uuid>`.
 */
export function parseProbeCommandId(commandId: string): string | null {
  if (!commandId.startsWith(PROBE_ID_PREFIX)) return null;
  const rest = commandId.slice(PROBE_ID_PREFIX.length);
  const split = rest.lastIndexOf('-');
  if (split <= 0) return null;
  const assetId = rest.slice(0, split);
  const stamp = rest.slice(split + 1);
  if (!UUID.test(assetId)) return null;
  if (!/^\d+$/.test(stamp)) return null;
  return assetId;
}

const waiters = new Map<string, (outcome: ProbeOutcome) => void>();

export function awaitProbeResult(commandId: string, timeoutMs: number): Promise<ProbeOutcome | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Always clear our own entry, never someone else's: a later probe for the
      // same asset has a different command id, so the key cannot collide.
      if (waiters.get(commandId) === settle) waiters.delete(commandId);
      resolve(null);
    }, timeoutMs);
    const settle = (outcome: ProbeOutcome) => {
      clearTimeout(timer);
      waiters.delete(commandId);
      resolve(outcome);
    };
    waiters.set(commandId, settle);
  });
}

/**
 * Persist an agent ping result against the asset that asked for it.
 *
 * Returns true when a row changed. Every predicate is load-bearing:
 *   last_probe_ref     — this result answers THIS dispatch, not a superseded one
 *   last_probe_status  — 'pending' only, so a duplicate delivery is a no-op
 *   ip_address/site_id — the asset has not moved or been re-addressed since
 *                        dispatch, so the reachability claim is about the host
 *                        we actually probed
 */
export async function applyProbeResult(input: {
  commandId: string;
  assetId: string;
  expectedIp: string;
  expectedSiteId: string;
  status: 'ok' | 'failed';
  responseMs: number | null;
  error: string | null;
}): Promise<boolean> {
  const updated = await db
    .update(discoveredAssets)
    .set({
      lastProbeStatus: input.status,
      lastProbeResponseMs: input.responseMs,
      updatedAt: new Date(),
    })
    .where(and(
      eq(discoveredAssets.id, input.assetId),
      eq(discoveredAssets.lastProbeRef, input.commandId),
      eq(discoveredAssets.lastProbeStatus, 'pending'),
      sql`host(${discoveredAssets.ipAddress}) = ${input.expectedIp}`,
      eq(discoveredAssets.siteId, input.expectedSiteId),
    ))
    .returning({ id: discoveredAssets.id });

  if (updated.length === 0) return false;

  waiters.get(input.commandId)?.({ status: input.status, responseMs: input.responseMs, error: input.error });
  return true;
}
```

Run: `cd apps/api && npx vitest run src/services/assetProbe.test.ts`
Expected: PASS.

- [ ] **Step 4: Teach `agentWs.ts` the probe expectation**

In `routes/agentWs.ts`, extend the `OrphanedResultExpectation` union (line 501):

```ts
type OrphanedResultExpectation =
  | { agentId: string; kind: 'snmp'; targetId: string; expiresAt: number }
  | { agentId: string; kind: 'monitor'; targetId: string; expiresAt: number }
  // Spec §5 — a manual probe. The expected ip/site are captured at DISPATCH so
  // the result handler can refuse a result for an asset that has since moved or
  // been re-addressed; they are not derivable from the agent's reply.
  | { agentId: string; kind: 'probe'; targetId: string; ipAddress: string; siteId: string; expiresAt: number };
```

In `recordOrphanedResultExpectation`, insert the probe branch BEFORE the `MONITOR_COMMAND_TYPES` branch (a probe is a `network_ping`, and that branch returns early when `monitorId` is absent):

```ts
  // Spec §5 — a probe is a network_ping carrying probeAssetId instead of a
  // monitorId. Checked FIRST: the monitor branch below would otherwise swallow
  // it and record nothing, because a probe has no monitorId.
  if (command.type === 'network_ping' && typeof payload.probeAssetId === 'string') {
    const probeAssetId = payload.probeAssetId;
    const probeSiteId = typeof payload.probeSiteId === 'string' ? payload.probeSiteId : null;
    const target = typeof payload.target === 'string' ? payload.target : null;
    if (!probeSiteId || !target) return;
    orphanedResultExpectations.set(command.id, {
      agentId,
      kind: 'probe',
      targetId: probeAssetId,
      ipAddress: target,
      siteId: probeSiteId,
      expiresAt,
    });
    return;
  }
```

- [ ] **Step 5: Handle the probe result in `processOrphanedCommandResult`**

In `routes/agentWs.ts`, insert this branch immediately BEFORE the existing "Check if this is a network monitor result" block (line ~1229):

```ts
  // Spec §5 — a manual "Check now" result. Matched on the command id (the agent
  // echoes an empty monitorId for a probe, so the monitor branch below would
  // fall through anyway; matching here first keeps the intent explicit).
  const probeAssetId = parseProbeCommandId(result.commandId);
  if (probeAssetId) {
    const expectation = consumeOrphanedResultExpectation(agentId, result.commandId);
    if (!expectation || expectation.kind !== 'probe' || expectation.targetId !== probeAssetId) {
      console.warn(
        `[AgentWs] Rejecting unexpected probe result ${result.commandId} from agent ${agentId}: ` +
        `sentAsset=${probeAssetId} expected=${expectation?.kind === 'probe' ? expectation.targetId : 'none'}`
      );
      return;
    }
    const probeData = result.result as { status?: string; responseMs?: number; error?: string } | undefined;
    // The agent reports monitor-shaped statuses ('online' | 'offline' |
    // 'degraded'). Only an explicit success is `ok`; everything else, including
    // a transport-level failure with no body at all, is `failed`.
    const probeStatus: 'ok' | 'failed' =
      result.status === 'success' && (probeData?.status === 'online' || probeData?.status === 'degraded')
        ? 'ok'
        : 'failed';
    try {
      const applied = await applyProbeResult({
        commandId: result.commandId,
        assetId: probeAssetId,
        expectedIp: expectation.ipAddress,
        expectedSiteId: expectation.siteId,
        status: probeStatus,
        responseMs: typeof probeData?.responseMs === 'number' ? probeData.responseMs : null,
        error: probeData?.error ?? result.error ?? null,
      });
      if (!applied) {
        // The asset moved, was re-addressed, or a newer probe superseded this
        // dispatch. Dropping it is the point — a stale reachability claim about
        // a host we are no longer describing is worse than no claim.
        console.warn(
          `[AgentWs] Probe result ${result.commandId} for asset ${probeAssetId} did not correlate ` +
          '(asset moved, re-addressed, or superseded); dropped.'
        );
      }
    } catch (err) {
      console.error(`[AgentWs] Failed to persist probe result for ${agentId}:`, err);
      captureException(err);
    }
    return;
  }
```

Add to the imports at the top of `agentWs.ts`:

```ts
import { applyProbeResult, parseProbeCommandId } from '../services/assetProbe';
```

**HTTP transport note.** `services/commandResultHandlers.ts` dispatches per `deviceCommands.type`, and a probe is dispatched over the socket without a `device_commands` row — exactly like the SNMP poll and the monitor check. So the probe needs no entry in `commandResultHandlers`' map, and the REST result route (`routes/agents/commands.ts`) never sees it. If a future wave gives probes a `device_commands` row, add a `network_ping` handler there that calls the same `applyProbeResult`.

- [ ] **Step 6: Write the failing route tests**

Create `apps/api/src/routes/discoveryAssetProbe.test.ts` following the shape of `apps/api/src/routes/monitoring.test.ts` (read it first for the auth/permission mock setup). Cases:

```ts
  it('422 ASSET_NO_IP when the asset has no ip_address', …);
  it('422 ASSET_NO_SITE when the asset has no site', …);
  it('409 NO_AGENT_IN_SITE when the site has no online agent', …);
  it('409 PROBE_IN_FLIGHT while a pending probe is younger than 2 minutes', …);
  it('accepts a new probe once the pending stamp is older than 2 minutes', …);
  it('404 for an asset in another org', …);            // multi-tenant isolation
  it('403 for a site-restricted caller outside the site', …);
  it('stamps pending BEFORE dispatching, with last_probe_ref set to the command id', …);
  it('returns 200 with the resolved probe and fresh reachability when the agent answers in time', …);
  it('returns 202 with state pending when the agent does not answer in 8 s', …);
```

The "answers in time" and "does not answer" cases set `PROBE_WAIT_MS` down via `vi.useFakeTimers()` or by mocking `awaitProbeResult`; mocking the service is simpler and is what the assertion is about.

Run: `cd apps/api && npx vitest run src/routes/discoveryAssetProbe.test.ts`
Expected failure: `Failed to resolve import "./discoveryAssetProbe"`.

- [ ] **Step 7: Implement `routes/discoveryAssetProbe.ts`**

```ts
/**
 * POST /discovery/assets/:id/probe — the "Check now" button (spec §5, D2).
 *
 * Its own module rather than a 27th route in routes/discovery.ts (2,247 lines).
 * Mounted as a second sub-router at /discovery in index.ts.
 *
 * Shape, in order:
 *   1. resolve + LOCK the asset (site-locking resolver, shared with monitoring)
 *   2. require ip_address and site_id
 *   3. refuse a second in-flight probe (409 PROBE_IN_FLIGHT)
 *   4. pick a site-strict executor (409 NO_AGENT_IN_SITE)
 *   5. stamp pending + last_probe_ref, THEN dispatch — never the other way
 *      round, or a fast agent's result arrives before the row it must match
 *   6. wait up to 8 s, then answer 200 or 202
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { discoveredAssets } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { resolveAssetForMutation, type AssetAuthContext } from '../services/assetAccessScope';
import { loadAssetSiteId, selectNetworkExecutor } from '../services/networkExecutorSelection';
import { dispatchCommandToAgent } from '../services/agentCommandRelay';
import {
  applyProbeResult,
  awaitProbeResult,
  buildProbeCommandId,
  PROBE_IN_FLIGHT_MS,
  PROBE_WAIT_MS,
} from '../services/assetProbe';
import { deriveReachability } from '../services/assetReachability';
import { loadReachabilityInputs } from '../services/assetReachabilityLoader';

export const discoveryAssetProbeRoutes = new Hono();
discoveryAssetProbeRoutes.use('*', authMiddleware);

const requireDiscoveryWrite = requirePermission(
  PERMISSIONS.DEVICES_WRITE.resource,
  PERMISSIONS.DEVICES_WRITE.action,
);

async function reachabilityFor(assetId: string) {
  const input = (await loadReachabilityInputs([assetId])).get(assetId);
  return input ? deriveReachability(input) : null;
}

discoveryAssetProbeRoutes.post(
  '/assets/:id/probe',
  requireScope('organization', 'partner', 'system'),
  requireDiscoveryWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth') as AssetAuthContext;
    const perms = c.get('permissions') as UserPermissions | undefined;
    const assetId = c.req.param('id')!;

    // 1. Resolve and lock. The ambient request transaction holds the row lock
    //    through the pending stamp below, so two concurrent "Check now" clicks
    //    cannot both pass the in-flight guard.
    const resolved = await resolveAssetForMutation(auth, perms, assetId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const asset = resolved.asset;

    // 2. A probe needs somewhere to send a ping from and somewhere to send it to.
    if (!asset.ipAddress) {
      return c.json({ error: 'This asset has no IP address to probe', code: 'ASSET_NO_IP' }, 422);
    }
    const siteId = await loadAssetSiteId(asset.orgId, asset.id);
    if (!siteId) {
      return c.json({ error: 'This asset has no site, so no agent can be chosen to probe it', code: 'ASSET_NO_SITE' }, 422);
    }

    // 3. One in-flight probe per asset (spec §5 rate limit). A stale pending is
    //    not in flight — deriveReachability already reads it as failed.
    if (
      asset.lastProbeStatus === 'pending'
      && asset.lastProbeAt
      && Date.now() - new Date(asset.lastProbeAt).getTime() < PROBE_IN_FLIGHT_MS
    ) {
      return c.json({ error: 'A probe is already running for this asset', code: 'PROBE_IN_FLIGHT' }, 409);
    }

    // 4. Site-strict executor. No org-wide fallback for asset-bound work.
    const pick = await selectNetworkExecutor({ orgId: asset.orgId, siteId });
    if ('error' in pick) {
      return c.json({ error: 'No online agent in this asset’s site', code: 'NO_AGENT_IN_SITE' }, 409);
    }

    // 5. Stamp BEFORE dispatch. A local switch can answer in single-digit
    //    milliseconds; if the stamp landed after the send, applyProbeResult's
    //    CAS would find no pending row and drop a perfectly good result.
    const commandId = buildProbeCommandId(asset.id);
    const startedAt = new Date();
    await db
      .update(discoveredAssets)
      .set({
        lastProbeAt: startedAt,
        lastProbeStatus: 'pending',
        lastProbeRef: commandId,
        lastProbeResponseMs: null,
        updatedAt: startedAt,
      })
      .where(and(eq(discoveredAssets.id, asset.id), eq(discoveredAssets.orgId, asset.orgId)));

    writeRouteAudit(c, {
      orgId: asset.orgId,
      action: 'discovery.asset.probe',
      resourceType: 'discovered_asset',
      resourceId: asset.id,
      resourceName: asset.label ?? asset.hostname ?? String(asset.ipAddress),
      details: { agentId: pick.agentId, commandId },
    });

    const waiting = awaitProbeResult(commandId, PROBE_WAIT_MS);
    const outcome = await dispatchCommandToAgent(
      pick.agentId,
      {
        id: commandId,
        type: 'network_ping',
        payload: {
          target: String(asset.ipAddress),
          timeout: 5,
          count: 3,
          // Read back by recordOrphanedResultExpectation on the instance that
          // owns the agent socket (spec §5 correlation). The agent ignores both.
          probeAssetId: asset.id,
          probeSiteId: siteId,
        },
      },
      { priority: 'probe' },
    );

    if (outcome.status !== 'sent') {
      // The agent went away between the pick and the send. Close the probe out
      // now rather than leaving a pending stamp to time out in two minutes.
      await applyProbeResult({
        commandId,
        assetId: asset.id,
        expectedIp: String(asset.ipAddress),
        expectedSiteId: siteId,
        status: 'failed',
        responseMs: null,
        error: `dispatch ${outcome.status}`,
      });
      return c.json({
        probe: { state: 'failed', responseMs: null, observedAt: startedAt.toISOString(), agentId: pick.agentId, error: `dispatch ${outcome.status}` },
        reachability: await reachabilityFor(asset.id),
      }, 200);
    }

    const result = await waiting;
    if (!result) {
      // Spec §5.4 — the late result is written by the agentWs handler; the page
      // re-fetches the asset every 3 s for up to 60 s while pending.
      return c.json({
        probe: { state: 'pending', responseMs: null, observedAt: startedAt.toISOString(), agentId: pick.agentId },
        reachability: await reachabilityFor(asset.id),
      }, 202);
    }

    return c.json({
      probe: {
        state: result.status,
        responseMs: result.responseMs,
        observedAt: startedAt.toISOString(),
        agentId: pick.agentId,
        error: result.error,
      },
      reachability: await reachabilityFor(asset.id),
    }, 200);
  },
);
```

- [ ] **Step 8: Mount it**

In `apps/api/src/index.ts`, next to `api.route('/discovery', discoveryRoutes);` (line 960):

```ts
import { discoveryAssetProbeRoutes } from './routes/discoveryAssetProbe';
// …
api.route('/discovery', discoveryRoutes);
// Second sub-router at the same prefix (ten prefixes here already are). The
// probe lives in its own module so routes/discovery.ts does not grow past 2,247
// lines; no path overlaps, so mount order is immaterial.
api.route('/discovery', discoveryAssetProbeRoutes);
```

- [ ] **Step 9: Run everything the probe touches**

Run:
```
cd apps/api && npx vitest run \
  src/services/assetProbe.test.ts \
  src/routes/discoveryAssetProbe.test.ts \
  src/routes/agentWs \
  src/routes/discovery.test.ts \
&& npx tsc --noEmit -p tsconfig.json
```
Expected: PASS. `src/routes/agentWs` is a bare substring filter that picks up every dotted sibling suite — check the reported file count.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/services/assetProbe.ts apps/api/src/services/assetProbe.test.ts \
        apps/api/src/routes/discoveryAssetProbe.ts apps/api/src/routes/discoveryAssetProbe.test.ts \
        apps/api/src/routes/agentWs.ts apps/api/src/index.ts
git commit -m "$(cat <<'COMMIT_EOF'
feat(monitoring): POST /discovery/assets/:id/probe with dispatch correlation (W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT_EOF
)"
```

---

### Task 10: Durable `no_template` in the SNMP worker

**Files:**
- Modify: `apps/api/src/jobs/snmpWorker.ts:72-76` (`SITE_AUTHORITY_STATUS`), `:86-99` (`recordSiteAuthorityFailure`), `:466-468` (the `no-oids` branch)
- Modify: `apps/api/src/jobs/snmpWorkerScheduler.test.ts:200-222` (extend the `it.each`)

**Interfaces:**
- Produces: `snmp_devices.last_status = 'no_template'` with `last_poll_attempted_at` stamped and `consecutive_failures` **untouched**.

**DECISION.** `recordSiteAuthorityFailure` increments `consecutive_failures`, which `no_template` must not do (spec §6.1 and the scheduler contract). Rather than adding a flag to it, add a sibling `recordNoTemplate` — the two record genuinely different things and a boolean parameter would make the call sites read as if they were the same event.

- [ ] **Step 1: Extend the scheduler contract test**

In `apps/api/src/jobs/snmpWorkerScheduler.test.ts`, the `it.each` at line ~202 currently asserts exactly one update (the attempt stamp) for three no-dispatch causes. The no-OIDs case now writes a second update. Change that case and add the new assertion:

```ts
  it.each([
    ['the device row is gone', () => [[]]],
    ['the org has no online agent', () => [
      [{ id: 'dev-1', orgId: 'org-1', templateId: 'tpl-1', ipAddress: '10.0.0.1', port: 161, snmpVersion: 'v2c' }],
      [{ oids: [{ oid: '1.3.6.1.2.1.1.1.0' }] }],
      [],
    ]],
  ])('stamps but does NOT count a failure when %s', async (_label, results) => {
    // … body unchanged …
  });

  it('records no_template WITHOUT counting a failure when the device has no OIDs (spec §6.1)', async () => {
    // F2: "SNMP monitoring: Enabled" on a device with no template polls nothing
    // and left last_status NULL forever, so no page could say so. It is now a
    // durable status — but NOT a failure: the poll never left the building, and
    // counting it would back a healthy device off to an hour and eventually
    // mark it 'offline' (the exact behaviour the #3217 contract forbids).
    selectResults = [[{ id: 'dev-1', orgId: 'org-1', templateId: null, ipAddress: '10.0.0.1' }]] as unknown[][];
    isAgentConnectedMock.mockReturnValue(false);

    await processPollDevice({ type: 'poll-device', deviceId: 'dev-1', orgId: 'org-1' });

    expect(captured.updateSets).toHaveLength(2);
    expect(captured.updateSets[0]!.lastPollAttemptedAt).toBeInstanceOf(Date);
    expect(captured.updateSets[1]).toMatchObject({ lastStatus: 'no_template' });
    expect(captured.updateSets[1]).not.toHaveProperty('consecutiveFailures');
    expect(captured.updateSets[1]!.lastPollAttemptedAt).toBeInstanceOf(Date);
  });
```

Run: `cd apps/api && npx vitest run src/jobs/snmpWorkerScheduler.test.ts`
Expected failure: `expected [ { lastPollAttemptedAt: … } ] to have a length of 2 but got 1`.

- [ ] **Step 2: Implement**

In `snmpWorker.ts`, extend the status map and add the sibling recorder:

```ts
const SITE_AUTHORITY_STATUS = {
  assetMissing: 'asset_missing',
  assetNoSite: 'asset_no_site',
  noAgentInSite: 'no_agent_in_site',
} as const;

/**
 * Spec §6.1 (F2) — the device is configured for SNMP but has no template, so
 * `buildSnmpPollCommand` would carry zero OIDs and the poll would ask the
 * device nothing. Before this, that logged a console.warn and left
 * `last_status` NULL forever: every page said "SNMP monitoring: Enabled" about
 * a device that had never collected a single value.
 *
 * Deliberately NOT routed through recordSiteAuthorityFailure: this must not
 * touch `consecutive_failures`. The poll never left the building, so counting
 * it would multiply the polling interval by 2^n and eventually stamp 'offline'
 * on a device nobody ever asked anything — and it would break the #3217
 * scheduler contract that snmpWorkerScheduler.test.ts pins.
 *
 * A later successful poll clears it like any other status (processPollResults
 * sets last_status = 'online' unconditionally on success).
 */
async function recordNoTemplate(deviceId: string): Promise<void> {
  await runWithSystemDbAccess(() =>
    db
      .update(snmpDevices)
      .set({ lastStatus: 'no_template', lastPollAttemptedAt: new Date() })
      .where(eq(snmpDevices.id, deviceId))
  );
}
```

and change the `no-oids` case in the outcome switch (line ~466):

```ts
    case 'no-oids':
      console.warn(`[SnmpWorker] No OIDs configured for device ${data.deviceId}`);
      await recordNoTemplate(data.deviceId);
      return { dispatched: false, agentId: null };
```

- [ ] **Step 3: Run and commit**

Run: `cd apps/api && npx vitest run src/jobs/snmpWorker src/jobs/snmpQueue.test.ts`
Expected: PASS (bare substring picks up `snmpWorkerScheduler`, `snmpWorker.dbcontext`, `snmpWorker.orgAuthority`).

```bash
git add apps/api/src/jobs/snmpWorker.ts apps/api/src/jobs/snmpWorkerScheduler.test.ts
git commit -m "$(cat <<'COMMIT_EOF'
feat(monitoring): durable snmp_devices.last_status = no_template without backoff (W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT_EOF
)"
```

---

### Task 11: Ingest protocol-2 metric rows and the all-error `warning` poll

**Files:**
- Modify: `apps/api/src/jobs/snmpWorker.ts:136-148` (`SnmpMetricResult`), `:522-580` (`processPollResults`), `:581-587` (`resolveValueType`)
- Test: `apps/api/src/jobs/snmpWorker.ingestion.test.ts` (new)

**Interfaces:**
- Produces the widened result type (consumed by W02's agent and by `services/commandResultHandlers.ts`, which re-exports it):

```ts
export interface SnmpMetricResult {
  oid: string;
  name: string;
  value: unknown;
  timestamp: string;
  /** protocol 2 (W02 agents). Absent ⇒ legacy row, baseOid = oid, instance = ''. */
  baseOid?: string;
  instance?: string;
  /** noSuchObject | noSuchInstance | endOfMib | timeout | truncated */
  error?: string;
}
export const SNMP_ERROR_CODES: readonly string[];
```

Ingestion ships BEFORE any agent emits the new shape (spec §7.3), so every assertion here is about a payload W01 cannot yet receive in production. That is the point: the server must already be correct when W02's agents roll.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/jobs/snmpWorker.ingestion.test.ts`. Reuse the `vi.mock('../db', …)` harness from `snmpWorkerScheduler.test.ts` verbatim (copy the `captured` / `selectResults` block and the bullmq/redis/agentWs mocks), then:

```ts
import { __testables } from './snmpWorker';
const { processPollResults } = __testables;

const DEVICE = 'dev-1';
const deviceRow = () => [[{ orgId: 'org-1' }]];

describe('processPollResults — protocol 2 ingestion (spec §7.3)', () => {
  it('stores baseOid and instance for a walked table column', async () => {
    selectResults = deviceRow() as unknown[][];

    await processPollResults({
      type: 'process-poll-results',
      deviceId: DEVICE,
      metrics: [{
        oid: '1.3.6.1.2.1.43.11.1.1.9.1.1',
        baseOid: '1.3.6.1.2.1.43.11.1.1.9',
        instance: '1.1',
        name: 'prtMarkerSuppliesLevel',
        value: 37,
        timestamp: '2026-09-16T12:00:00.000Z',
      }],
    });

    const rows = captured.insertValues[0] as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({
      oid: '1.3.6.1.2.1.43.11.1.1.9.1.1',
      baseOid: '1.3.6.1.2.1.43.11.1.1.9',
      instance: '1.1',
      value: '37',
      valueType: 'number',
      error: null,
    });
  });

  it('treats a legacy row as baseOid = oid, instance = empty', async () => {
    selectResults = deviceRow() as unknown[][];

    await processPollResults({
      type: 'process-poll-results',
      deviceId: DEVICE,
      metrics: [{ oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', value: 123, timestamp: '2026-09-16T12:00:00.000Z' }],
    });

    const rows = captured.insertValues[0] as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ oid: '1.3.6.1.2.1.1.3.0', baseOid: '1.3.6.1.2.1.1.3.0', instance: '', error: null });
  });

  it('stores an error row with a null value and value_type error', async () => {
    selectResults = deviceRow() as unknown[][];

    await processPollResults({
      type: 'process-poll-results',
      deviceId: DEVICE,
      metrics: [{
        oid: '1.3.6.1.2.1.25.3.5.1.1', baseOid: '1.3.6.1.2.1.25.3.5.1.1', instance: '',
        name: 'hrPrinterStatus', value: null, error: 'noSuchObject', timestamp: '2026-09-16T12:00:00.000Z',
      }],
    });

    const rows = captured.insertValues[0] as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ value: null, valueType: 'error', error: 'noSuchObject' });
  });

  it('rejects an unknown error code rather than storing agent free text', async () => {
    selectResults = deviceRow() as unknown[][];

    await processPollResults({
      type: 'process-poll-results',
      deviceId: DEVICE,
      metrics: [{ oid: '1.2.3', name: 'x', value: null, error: 'Segmentation fault at 0xdeadbeef', timestamp: '2026-09-16T12:00:00.000Z' }],
    });

    const rows = captured.insertValues[0] as Record<string, unknown>[];
    expect(rows[0]!.error).toBe('unknown');
  });

  it('counts the poll as a success when at least one non-error row arrived', async () => {
    selectResults = deviceRow() as unknown[][];

    await processPollResults({
      type: 'process-poll-results',
      deviceId: DEVICE,
      metrics: [
        { oid: '1.1', name: 'a', value: 1, timestamp: '2026-09-16T12:00:00.000Z' },
        { oid: '1.2', name: 'b', value: null, error: 'noSuchObject', timestamp: '2026-09-16T12:00:00.000Z' },
      ],
    });

    expect(captured.updateSets[0]).toMatchObject({ lastStatus: 'online', consecutiveFailures: 0 });
    expect(captured.updateSets[0]!.lastPolled).toBeInstanceOf(Date);
  });

  it('an all-error poll sets warning and does NOT reset consecutive_failures', async () => {
    selectResults = deviceRow() as unknown[][];

    await processPollResults({
      type: 'process-poll-results',
      deviceId: DEVICE,
      metrics: [
        { oid: '1.1', name: 'a', value: null, error: 'noSuchObject', timestamp: '2026-09-16T12:00:00.000Z' },
        { oid: '1.2', name: 'b', value: null, error: 'timeout', timestamp: '2026-09-16T12:00:00.000Z' },
      ],
    });

    // The device ANSWERED (we got rows), so it is not 'offline'. But nothing was
    // collected, so the backoff must not be cleared either.
    expect(captured.updateSets[0]).toMatchObject({ lastStatus: 'warning' });
    expect(captured.updateSets[0]).not.toHaveProperty('consecutiveFailures');
    expect(captured.updateSets[0]).not.toHaveProperty('lastPolled');
    expect(captured.updateSets[0]!.lastPollAttemptedAt).toBeInstanceOf(Date);
  });

  it('an empty metrics array leaves the device status alone', async () => {
    selectResults = deviceRow() as unknown[][];
    await processPollResults({ type: 'process-poll-results', deviceId: DEVICE, metrics: [] });
    // No rows to insert and nothing observed — the dispatch-time failure count
    // stands and the scheduler retries on its own cadence.
    expect(captured.insertValues).toHaveLength(0);
    expect(captured.updateSets[0]).toMatchObject({ lastStatus: 'warning' });
  });
});
```

Run: `cd apps/api && npx vitest run src/jobs/snmpWorker.ingestion.test.ts`
Expected failure: the first case fails with `expected { oid: …, name: …, value: '37', valueType: 'number' } to match object { baseOid: … }` — the writer does not emit the new fields yet.

- [ ] **Step 2: Implement**

Widen the result type at `snmpWorker.ts:136`:

```ts
/**
 * One metric from an agent poll.
 *
 * Fields beyond `oid`/`name`/`value`/`timestamp` are protocol 2 (spec §7.2,
 * shipped by W02 agents). A payload without them is legacy and is normalised on
 * the way in: baseOid = oid, instance = ''. There is deliberately no version
 * discriminator on the ROW — `protocol: 2` rides the result envelope, and every
 * field here is independently optional, so a partially-upgraded fleet needs no
 * branch.
 */
export interface SnmpMetricResult {
  oid: string;
  name: string;
  value: unknown;
  timestamp: string;
  baseOid?: string;
  instance?: string;
  error?: string;
}

/**
 * The closed set of per-OID failure codes (spec §7.2). Anything else an agent
 * sends is stored as 'unknown': `snmp_metrics.error` is varchar(32) and is
 * classified `included` in the tenant export, so it must never become a channel
 * for arbitrary agent-supplied text.
 */
export const SNMP_ERROR_CODES = ['noSuchObject', 'noSuchInstance', 'endOfMib', 'timeout', 'truncated'] as const;
const SNMP_ERROR_CODE_SET: ReadonlySet<string> = new Set(SNMP_ERROR_CODES);

function normalizeSnmpError(error: unknown): string | null {
  if (typeof error !== 'string' || error.length === 0) return null;
  return SNMP_ERROR_CODE_SET.has(error) ? error : 'unknown';
}
```

Replace the phase-2 mapping and phase-3 write in `processPollResults` (lines ~546-575):

```ts
  // Phase 2 — parse/shape the agent-supplied metrics with NO DB context open.
  let nonErrorRows = 0;
  const rows = data.metrics.map((metric) => {
    const error = normalizeSnmpError(metric.error);
    if (!error) nonErrorRows++;
    return {
      deviceId: data.deviceId,
      orgId: snmpDevice.orgId,
      oid: metric.oid,
      // Spec §7.3 — a legacy row IS its own base OID with no instance suffix.
      // Normalising here (rather than COALESCEing at every read) keeps the
      // §6.2 derivation and the §6.3 history query from each inventing a rule.
      baseOid: typeof metric.baseOid === 'string' && metric.baseOid.length > 0 ? metric.baseOid : metric.oid,
      instance: typeof metric.instance === 'string' ? metric.instance : '',
      name: metric.name || metric.oid,
      value: error ? null : (metric.value != null ? String(metric.value) : null),
      valueType: error ? 'error' : resolveValueType(metric.value),
      error,
      timestamp: metric.timestamp ? new Date(metric.timestamp) : now
    };
  });

  // Phase 3 — the writes, in one context so the metric insert and the device
  // status stamp commit together.
  await runWithSystemDbAccess(async () => {
    if (rows.length > 0) {
      await db.insert(snmpMetrics).values(rows);
    }

    if (nonErrorRows > 0) {
      // At least one real value arrived. Clearing consecutiveFailures here is
      // the only thing that cancels the backoff started at dispatch (#3217) —
      // it must stay after the metric insert, and inside the same context, so a
      // persistence failure rolls back the clear and keeps the count.
      await db
        .update(snmpDevices)
        .set({ lastPolled: now, lastPollAttemptedAt: now, lastStatus: 'online', consecutiveFailures: 0 })
        .where(eq(snmpDevices.id, data.deviceId));
    } else {
      // Spec §7.3 — every row was an error (or there were none at all). The
      // device ANSWERED, so this is not 'offline'; but nothing was collected,
      // so `last_polled` must not move and the backoff must not be cleared.
      // 'warning' is the existing value the Redis-unavailable path already
      // uses for "we heard from it but stored nothing".
      await db
        .update(snmpDevices)
        .set({ lastPollAttemptedAt: now, lastStatus: 'warning' })
        .where(eq(snmpDevices.id, data.deviceId));
    }
  });

  console.log(`[SnmpWorker] Wrote ${rows.length} metrics (${nonErrorRows} with values) for device ${data.deviceId}`);
  return { metricsWritten: rows.length };
```

Leave `resolveValueType` unchanged — an error row never reaches it.

- [ ] **Step 3: Run and commit**

Run: `cd apps/api && npx vitest run src/jobs/snmpWorker && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, including the pre-existing `processPollResults` cases in `snmpWorkerScheduler.test.ts` (a poll with ordinary values still writes `online` + `consecutiveFailures: 0`).

```bash
git add apps/api/src/jobs/snmpWorker.ts apps/api/src/jobs/snmpWorker.ingestion.test.ts
git commit -m "$(cat <<'COMMIT_EOF'
feat(monitoring): ingest protocol-2 SNMP rows, per-OID errors and all-error warning polls (W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT_EOF
)"
```

---

### Task 12: `services/snmpCollectionState.ts` and `collection` on the monitoring asset route

**Files:**
- Create: `apps/api/src/services/snmpCollectionState.ts`
- Test: `apps/api/src/services/snmpCollectionState.test.ts`
- Modify: `apps/api/src/routes/monitoring.ts` (`GET /assets/:id`)

**Interfaces:**
- Produces:

```ts
export type CollectionOidState = 'collecting' | 'unsupported' | 'stale' | 'never_polled' | 'unknown';
export type CollectionStatus = 'ok' | 'failing' | 'no_template' | 'no_agent' | 'asset_moved' | 'never_polled' | 'paused';
export const COLLECTION_INSTANCE_CAP = 64;

export interface CollectionTemplateEntry { oid: string; name?: string; mode?: 'get' | 'walk'; cadence?: 'fast' | 'slow'; type?: string }
export interface CollectionMetricRow {
  oid: string; baseOid: string | null; instance: string | null; name: string;
  value: string | null; valueType: string | null; error: string | null; timestamp: Date | string;
}
export interface CollectionInput {
  templateId: string | null;
  templateOids: CollectionTemplateEntry[];
  snmpDevice: { isActive: boolean; lastStatus: string | null; lastPolled: Date | string | null; pollingInterval: number | null; consecutiveFailures: number } | null;
  /** The newest row per (base_oid, instance) for this device; the caller narrows. */
  metrics: CollectionMetricRow[];
  now?: Date;
}
export interface Collection { /* spec §6.2 shape */ }
export function deriveCollection(input: CollectionInput): Collection;
/** W02's services/snmpOidSpecs.ts imports both rather than restating the rule. */
export function defaultOidMode(oid: string): 'get' | 'walk';
export function defaultOidCadence(): 'fast';
```

**DECISION.** `defaultOidMode` / `defaultOidCadence` live here, not in W02's `snmpOidSpecs.ts`. §6.2 has to decide a template entry's mode to label an `unknown` table OID ("this agent version cannot read table values"), and §7.1 has to decide the same thing to build `oidSpecs`. Two copies would drift the moment a vendor ships a scalar that does not end in `.0`. W02 imports them.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { deriveCollection, defaultOidMode, type CollectionInput } from './snmpCollectionState';

const NOW = new Date('2026-09-16T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;

const device = (over: Partial<NonNullable<CollectionInput['snmpDevice']>> = {}) => ({
  isActive: true, lastStatus: 'online', lastPolled: ago(MIN), pollingInterval: 300, consecutiveFailures: 0, ...over,
});

const base = (over: Partial<CollectionInput> = {}): CollectionInput => ({
  templateId: 'tpl-1',
  templateOids: [{ oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime' }],
  snmpDevice: device(),
  metrics: [],
  now: NOW,
  ...over,
});

describe('defaultOidMode', () => {
  it('a scalar ends in .0 and is fetched with GET', () => {
    expect(defaultOidMode('1.3.6.1.2.1.1.3.0')).toBe('get');
  });
  it('a column does not and must be walked', () => {
    // F3: a GET on a column OID returns noSuchObject and stored value_type
    // 'null' — 145 of the ~407 built-in OIDs have never collected because of it.
    expect(defaultOidMode('1.3.6.1.2.1.43.11.1.1.9')).toBe('walk');
    expect(defaultOidMode('1.3.6.1.2.1.2.2.1.2')).toBe('walk');
  });
  it('an explicit template mode always wins (asserted through deriveCollection)', () => {
    const c = deriveCollection(base({ templateOids: [{ oid: '1.3.6.1.2.1.1.3.0', name: 's', mode: 'walk' }] }));
    expect(c.oids[0]!.mode).toBe('walk');
  });
});

describe('deriveCollection — per-OID state', () => {
  it('a fresh non-null value is collecting', () => {
    const c = deriveCollection(base({
      metrics: [{ oid: '1.3.6.1.2.1.1.3.0', baseOid: '1.3.6.1.2.1.1.3.0', instance: '', name: 'sysUpTime', value: '400', valueType: 'number', error: null, timestamp: ago(MIN) }],
    }));
    expect(c.oids[0]).toMatchObject({ state: 'collecting', observedAt: ago(MIN).toISOString(), error: null });
    expect(c.oids[0]!.instances).toEqual([
      { oid: '1.3.6.1.2.1.1.3.0', instance: '', value: '400', valueType: 'number', observedAt: ago(MIN).toISOString() },
    ]);
  });

  it('an error row is unsupported and carries the code', () => {
    const c = deriveCollection(base({
      metrics: [{ oid: '1.3.6.1.2.1.1.3.0', baseOid: '1.3.6.1.2.1.1.3.0', instance: '', name: 'sysUpTime', value: null, valueType: 'error', error: 'noSuchObject', timestamp: ago(MIN) }],
    }));
    expect(c.oids[0]).toMatchObject({ state: 'unsupported', error: 'noSuchObject' });
  });

  it('a legacy null with no error is unknown, not unsupported', () => {
    // A pre-W02 agent GETs a column OID and stores value_type 'null'. That
    // proves nothing about the DEVICE — only that the agent cannot walk. Calling
    // it 'unsupported' would tell an operator to stop asking for data the
    // printer is perfectly willing to give.
    const c = deriveCollection(base({
      templateOids: [{ oid: '1.3.6.1.2.1.43.11.1.1.9', name: 'prtMarkerSuppliesLevel' }],
      metrics: [{ oid: '1.3.6.1.2.1.43.11.1.1.9', baseOid: null, instance: null, name: 'prtMarkerSuppliesLevel', value: null, valueType: 'null', error: null, timestamp: ago(MIN) }],
    }));
    expect(c.oids[0]).toMatchObject({ state: 'unknown', mode: 'walk', error: null });
  });

  it('matches a legacy row by oid when base_oid is null', () => {
    const c = deriveCollection(base({
      metrics: [{ oid: '1.3.6.1.2.1.1.3.0', baseOid: null, instance: null, name: 'sysUpTime', value: '7', valueType: 'number', error: null, timestamp: ago(MIN) }],
    }));
    expect(c.oids[0]!.state).toBe('collecting');
  });

  it('a good value older than 2x the polling interval is stale', () => {
    const c = deriveCollection(base({
      metrics: [{ oid: '1.3.6.1.2.1.1.3.0', baseOid: '1.3.6.1.2.1.1.3.0', instance: '', name: 'sysUpTime', value: '400', valueType: 'number', error: null, timestamp: ago(11 * MIN) }],
    }));
    expect(c.oids[0]!.state).toBe('stale');
  });

  it('no rows on a never-successful device is never_polled', () => {
    const c = deriveCollection(base({ snmpDevice: device({ lastPolled: null, lastStatus: null }) }));
    expect(c.oids[0]!.state).toBe('never_polled');
  });

  it('no rows on a device that HAS succeeded is stale, not never_polled', () => {
    // The device polls fine; this particular OID stopped coming back. Saying
    // "never polled" would send the operator to check credentials.
    const c = deriveCollection(base({ metrics: [] }));
    expect(c.oids[0]!.state).toBe('stale');
  });

  it('groups instances under their base OID and caps them', () => {
    const metrics = Array.from({ length: 100 }, (_, i) => ({
      oid: `1.3.6.1.2.1.2.2.1.2.${i}`, baseOid: '1.3.6.1.2.1.2.2.1.2', instance: String(i),
      name: 'ifDescr', value: `eth${i}`, valueType: 'string', error: null, timestamp: ago(MIN),
    }));
    const c = deriveCollection(base({ templateOids: [{ oid: '1.3.6.1.2.1.2.2.1.2', name: 'ifDescr' }], metrics }));
    expect(c.oids).toHaveLength(1);
    expect(c.oids[0]!.instances).toHaveLength(64);
    expect(c.oids[0]!.state).toBe('collecting');
  });
});

describe('deriveCollection — device-level status', () => {
  it.each([
    [{ isActive: false }, 'paused'],
    [{ lastStatus: 'no_template' }, 'no_template'],
    [{ lastStatus: 'no_agent_in_site' }, 'no_agent'],
    [{ lastStatus: 'asset_missing' }, 'asset_moved'],
    [{ lastStatus: 'asset_no_site' }, 'asset_moved'],
    [{ lastStatus: 'offline' }, 'failing'],
    [{ lastStatus: 'warning' }, 'failing'],
    [{ lastStatus: null, lastPolled: null }, 'never_polled'],
    [{ lastStatus: 'online' }, 'ok'],
  ] as const)('%o maps to %s', (over, expected) => {
    expect(deriveCollection(base({ snmpDevice: device(over) })).status).toBe(expected);
  });

  it('no SNMP device at all is never_polled with no template and no OIDs', () => {
    const c = deriveCollection(base({ snmpDevice: null, templateId: null, templateOids: [] }));
    expect(c).toMatchObject({ status: 'never_polled', templateId: null, lastPolledAt: null, pollingInterval: null, consecutiveFailures: 0, oids: [] });
  });

  it('a device with no template reports no_template and an empty OID list', () => {
    const c = deriveCollection(base({ templateId: null, templateOids: [], snmpDevice: device({ lastStatus: 'no_template' }) }));
    expect(c.status).toBe('no_template');
    expect(c.oids).toEqual([]);
  });
});
```

Run: `cd apps/api && npx vitest run src/services/snmpCollectionState.test.ts`
Expected failure: `Failed to resolve import "./snmpCollectionState"`.

- [ ] **Step 2: Implement `services/snmpCollectionState.ts`**

```ts
/**
 * Per-OID SNMP collection health (spec §6.2, decision D3).
 *
 * PURE. The caller supplies the template's OID list, the SNMP device row and
 * the newest metric row per (base_oid, instance); this module only classifies.
 *
 * THE RULE THAT MATTERS: missing rows cannot prove `noSuchObject`. A pre-W02
 * agent GETs a table column, gets back noSuchObject, `parseValue` yields nil,
 * and the row is stored as value_type 'null' with no error — that is F3, and it
 * is an AGENT limitation, not a device one. Reporting it as `unsupported` would
 * tell an operator their printer cannot report toner levels when in fact
 * nothing has ever asked it correctly. It is `unknown`, and the UI says "this
 * agent version cannot read table values; update the agent".
 */

export type CollectionOidState = 'collecting' | 'unsupported' | 'stale' | 'never_polled' | 'unknown';
export type CollectionStatus = 'ok' | 'failing' | 'no_template' | 'no_agent' | 'asset_moved' | 'never_polled' | 'paused';

/** Instances returned inline. The full set comes from GET /metrics (§6.3). */
export const COLLECTION_INSTANCE_CAP = 64;
const MIN_FRESHNESS_MS = 10 * 60_000;

export interface CollectionTemplateEntry {
  oid: string;
  name?: string;
  mode?: 'get' | 'walk';
  cadence?: 'fast' | 'slow';
  type?: string;
}

export interface CollectionMetricRow {
  oid: string;
  baseOid: string | null;
  instance: string | null;
  name: string;
  value: string | null;
  valueType: string | null;
  error: string | null;
  timestamp: Date | string;
}

export interface CollectionInput {
  templateId: string | null;
  templateOids: CollectionTemplateEntry[];
  snmpDevice: {
    isActive: boolean;
    lastStatus: string | null;
    lastPolled: Date | string | null;
    pollingInterval: number | null;
    consecutiveFailures: number;
  } | null;
  metrics: CollectionMetricRow[];
  now?: Date;
}

export interface CollectionOid {
  baseOid: string;
  name: string;
  mode: 'get' | 'walk';
  cadence: 'fast' | 'slow';
  state: CollectionOidState;
  observedAt: string | null;
  instances: Array<{ oid: string; instance: string; value: string | null; valueType: string; observedAt: string }>;
  error: string | null;
}

export interface Collection {
  templateId: string | null;
  lastPolledAt: string | null;
  pollingInterval: number | null;
  status: CollectionStatus;
  consecutiveFailures: number;
  oids: CollectionOid[];
}

/**
 * Acquisition mode when the template entry does not say (spec §7.1).
 *
 * The seed's scalars all end in `.0` and its columns never do. The entry's
 * `type` CANNOT decide this — `ifHCInOctets` is a counter64 AND a column.
 */
export function defaultOidMode(oid: string): 'get' | 'walk' {
  return oid.endsWith('.0') ? 'get' : 'walk';
}

export function defaultOidCadence(): 'fast' {
  return 'fast';
}

const DEVICE_STATUS_MAP: Record<string, CollectionStatus> = {
  online: 'ok',
  offline: 'failing',
  warning: 'failing',
  no_template: 'no_template',
  no_agent_in_site: 'no_agent',
  asset_missing: 'asset_moved',
  asset_no_site: 'asset_moved',
};

function toMillis(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function deriveCollection(input: CollectionInput): Collection {
  const now = (input.now ?? new Date()).getTime();
  const device = input.snmpDevice;
  const lastPolledMs = toMillis(device?.lastPolled ?? null);
  const pollingInterval = device?.pollingInterval ?? null;
  const freshnessMs = Math.max(2 * (pollingInterval ?? 300) * 1000, MIN_FRESHNESS_MS);
  const hasEverSucceeded = lastPolledMs !== null;

  const status: CollectionStatus = !device
    ? 'never_polled'
    : !device.isActive
      ? 'paused'
      : device.lastStatus && DEVICE_STATUS_MAP[device.lastStatus]
        ? DEVICE_STATUS_MAP[device.lastStatus]!
        : hasEverSucceeded ? 'ok' : 'never_polled';

  // Group the supplied rows by the base OID they belong to. A legacy row (no
  // base_oid) IS its own base — spec §6.2's "or whose `oid` equals it".
  const byBase = new Map<string, CollectionMetricRow[]>();
  for (const row of input.metrics) {
    const key = row.baseOid && row.baseOid.length > 0 ? row.baseOid : row.oid;
    const list = byBase.get(key) ?? [];
    list.push(row);
    byBase.set(key, list);
  }

  const oids: CollectionOid[] = input.templateOids.map((entry) => {
    const rows = (byBase.get(entry.oid) ?? []).slice().sort((a, b) => (toMillis(b.timestamp) ?? 0) - (toMillis(a.timestamp) ?? 0));
    const newest = rows[0] ?? null;
    const newestMs = newest ? toMillis(newest.timestamp) : null;
    const fresh = newestMs !== null && now - newestMs <= freshnessMs;

    let state: CollectionOidState;
    if (!newest) {
      // No rows for this OID. On a device that has never succeeded at all,
      // nothing has been asked yet; on one that polls fine, this OID stopped
      // answering.
      state = hasEverSucceeded ? 'stale' : 'never_polled';
    } else if (newest.error || newest.valueType === 'error') {
      state = 'unsupported';
    } else if (newest.value === null) {
      // A stored null with no error: a legacy agent's table GET. See the module
      // header — this is an agent limitation, never a device verdict.
      state = 'unknown';
    } else {
      state = fresh ? 'collecting' : 'stale';
    }

    return {
      baseOid: entry.oid,
      name: entry.name ?? entry.oid,
      mode: entry.mode ?? defaultOidMode(entry.oid),
      cadence: entry.cadence ?? defaultOidCadence(),
      state,
      observedAt: newestMs !== null ? new Date(newestMs).toISOString() : null,
      instances: rows
        .filter((row) => !row.error && row.valueType !== 'error')
        .slice(0, COLLECTION_INSTANCE_CAP)
        .map((row) => ({
          oid: row.oid,
          instance: row.instance ?? '',
          value: row.value,
          valueType: row.valueType ?? 'null',
          observedAt: new Date(toMillis(row.timestamp) ?? now).toISOString(),
        })),
      error: newest?.error ?? null,
    };
  });

  return {
    templateId: input.templateId,
    lastPolledAt: lastPolledMs !== null ? new Date(lastPolledMs).toISOString() : null,
    pollingInterval,
    status,
    consecutiveFailures: device?.consecutiveFailures ?? 0,
    oids,
  };
}
```

- [ ] **Step 3: Add `collection` to `GET /monitoring/assets/:id`**

In `routes/monitoring.ts`, add `import { deriveCollection, type CollectionTemplateEntry } from '../services/snmpCollectionState';` (`snmpTemplates`, `snmpMetrics`, `desc`, `or` and `sql` are already imported). Replace the `recentMetrics` query and both responses:

```ts
    // The template's OID list is what `collection` enumerates: an OID the
    // template never asked for cannot have a collection state.
    let templateOids: CollectionTemplateEntry[] = [];
    if (snmpDevice.templateId) {
      const [template] = await db
        .select({ oids: snmpTemplates.oids })
        .from(snmpTemplates)
        .where(and(
          eq(snmpTemplates.id, snmpDevice.templateId),
          or(eq(snmpTemplates.isBuiltIn, true), eq(snmpTemplates.orgId, asset.orgId))!,
        ))
        .limit(1);
      if (template && Array.isArray(template.oids)) templateOids = template.oids as CollectionTemplateEntry[];
    }

    // Newest row per (base_oid, instance) for this device. DISTINCT ON does the
    // per-series pick in Postgres so a 48-port switch does not ship 138k rows a
    // day into this handler; the composite index of §7.5 serves the ORDER BY.
    const latestMetrics = await db
      .select({
        oid: snmpMetrics.oid,
        baseOid: snmpMetrics.baseOid,
        instance: snmpMetrics.instance,
        name: snmpMetrics.name,
        value: snmpMetrics.value,
        valueType: snmpMetrics.valueType,
        error: snmpMetrics.error,
        timestamp: snmpMetrics.timestamp,
      })
      .from(snmpMetrics)
      .where(eq(snmpMetrics.deviceId, snmpDevice.id))
      .orderBy(
        sql`coalesce(${snmpMetrics.baseOid}, ${snmpMetrics.oid})`,
        sql`coalesce(${snmpMetrics.instance}, '')`,
        desc(snmpMetrics.timestamp),
      )
      .limit(2000);

    const collection = deriveCollection({
      templateId: snmpDevice.templateId,
      templateOids,
      snmpDevice: {
        isActive: snmpDevice.isActive,
        lastStatus: snmpDevice.lastStatus,
        lastPolled: snmpDevice.lastPolled,
        pollingInterval: snmpDevice.pollingInterval,
        consecutiveFailures: snmpDevice.consecutiveFailures,
      },
      metrics: latestMetrics,
    });
```

Add `collection` to the full response next to `reachability`, and to the `!snmpDevice` early return use:

```ts
        collection: deriveCollection({ templateId: null, templateOids: [], snmpDevice: null, metrics: [] }),
```

Keep `recentMetrics` in the response for one release — `MonitoringAssetsDashboard.tsx` still reads it and W04 deletes that modal. Derive it from `latestMetrics.slice(0, 20)` rather than issuing a second query.

**DECISION.** The `.limit(2000)` bound is explicit rather than a true `DISTINCT ON`: Drizzle has no first-class `DISTINCT ON`, and a raw-SQL rewrite of this handler is more risk than the bound buys. The ORDER BY groups each series together and newest-first, so `deriveCollection`'s per-base sort picks the right row; 2,000 rows covers 64 base OIDs at 31 instances each, well past the §6.2 cap of 64 instances shown. If a fleet outgrows it, promote this to `sql` with a real `DISTINCT ON (coalesce(base_oid, oid), coalesce(instance, ''))` — the index already serves it.

- [ ] **Step 4: Run and commit**

Run: `cd apps/api && npx vitest run src/services/snmpCollectionState.test.ts src/routes/monitoring && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

```bash
git add apps/api/src/services/snmpCollectionState.ts apps/api/src/services/snmpCollectionState.test.ts \
        apps/api/src/routes/monitoring.ts apps/api/src/routes/monitoring.test.ts
git commit -m "$(cat <<'COMMIT_EOF'
feat(monitoring): per-OID collection state on GET /monitoring/assets/:id (W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT_EOF
)"
```

---

### Task 13: `GET /monitoring/assets/:id/metrics` — bucketed history

**Files:**
- Create: `apps/api/src/routes/monitoringAssetMetrics.ts`
- Test: `apps/api/src/routes/monitoringAssetMetrics.test.ts`
- Create: `apps/api/src/services/metricBucketing.ts` (+ `.test.ts`)
- Create: `apps/api/src/__tests__/integration/networkDeviceTruth.integration.test.ts`
- Modify: `apps/api/src/index.ts` (mount)

**Interfaces:**
- `services/metricBucketing.ts` (pure, so the cap arithmetic is unit-testable without a database):

```ts
export type BucketChoice = 'auto' | '1m' | '5m' | '1h' | '1d';
export const MAX_RANGE_DAYS = 90;
export const MAX_POINTS_PER_SERIES = 2000;
export const MAX_SERIES = 64;
export function bucketSeconds(bucket: Exclude<BucketChoice, 'auto'>): number;
export function chooseBucket(fromMs: number, toMs: number): Exclude<BucketChoice, 'auto'>;
export function validateRange(fromMs: number, toMs: number, bucket: BucketChoice):
  { ok: true; bucket: Exclude<BucketChoice, 'auto'>; seconds: number } | { ok: false; message: string };
export function isCounterType(type: string | undefined): boolean;
export function toResetAwareDeltas(points: Array<[string, number]>): Array<[string, number]>;
```

- Route: `GET /monitoring/assets/:id/metrics?oid=<csv>&from=&to=&bucket=<auto|1m|5m|1h|1d>&delta=0|1` → `{ series: [{ oid, instance, name, points: [[ts, value]] }], bucket, from, to }`.

**DECISIONS.**
1. **`oid` takes a comma-separated list, capped at `MAX_SERIES` (64) entries.** §6.3 caps "64 series per request" but shows a single `oid` parameter; a chart tab plotting four OIDs would otherwise need four round trips. Each entry matches `COALESCE(base_oid, oid)` OR `oid`, so one parameter value covers both "the whole ifDescr column" and "just ifDescr.3".
2. **Bucketing uses epoch-floor arithmetic, not `date_trunc`.** `date_trunc` has no 5-minute unit, so a `5m` bucket would need a different expression from the other three. `to_timestamp(floor(extract(epoch from "timestamp") / $sec) * $sec)` is one expression for all four and is exactly aligned, which matters when the UI overlays two series.
3. **Non-numeric values are excluded from a series, not coerced.** `snmp_metrics.value` is `text` and holds `eth0` as readily as `37`. The SQL filters on a numeric regex; a series that is entirely non-numeric returns `points: []` rather than a row of `NaN`.
4. **`delta=1` is applied in JS over the bucketed maxima.** A SQL window function would have to reason about counter resets inside the aggregate; over at most 2,000 points per series the JS pass is simpler and testable in isolation.

- [ ] **Step 1: Write the failing `metricBucketing` tests**

```ts
import { describe, expect, it } from 'vitest';
import { bucketSeconds, chooseBucket, validateRange, isCounterType, toResetAwareDeltas, MAX_POINTS_PER_SERIES } from './metricBucketing';

const H = 3600_000;
const D = 24 * H;

describe('chooseBucket', () => {
  it.each([
    [6 * H, '1m'],
    [2 * D, '5m'],
    [30 * D, '1h'],
    [90 * D, '1d'],
  ] as const)('a %i ms range picks %s', (range, expected) => {
    expect(chooseBucket(0, range)).toBe(expected);
  });
});

describe('validateRange', () => {
  it('rejects a range beyond 90 days and names the cap', () => {
    const r = validateRange(0, 91 * D, 'auto');
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain('90');
  });

  it('rejects an inverted range', () => {
    expect(validateRange(D, 0, 'auto').ok).toBe(false);
  });

  it('rejects an explicit bucket that would exceed the point cap and names it', () => {
    const r = validateRange(0, 30 * D, '1m');
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain(String(MAX_POINTS_PER_SERIES));
  });

  it('accepts an explicit bucket inside the caps', () => {
    expect(validateRange(0, 24 * H, '1m')).toEqual({ ok: true, bucket: '1m', seconds: 60 });
  });

  it('auto never exceeds the point cap over the full 90-day range', () => {
    const r = validateRange(0, 90 * D, 'auto');
    expect(r.ok).toBe(true);
    expect((90 * D) / 1000 / bucketSeconds((r as { bucket: '1d' }).bucket)).toBeLessThanOrEqual(MAX_POINTS_PER_SERIES);
  });
});

describe('isCounterType', () => {
  it.each([['counter32', true], ['counter64', true], ['gauge32', false], [undefined, false]] as const)(
    '%s -> %s', (type, expected) => expect(isCounterType(type)).toBe(expected),
  );
});

describe('toResetAwareDeltas', () => {
  it('differences consecutive points', () => {
    expect(toResetAwareDeltas([['t1', 10], ['t2', 30], ['t3', 45]])).toEqual([['t2', 20], ['t3', 15]]);
  });

  it('treats a decrease as a counter reset and takes the new value', () => {
    // A 32-bit counter wrapping, or an agent restart. A negative "delta" on a
    // byte counter would render as traffic flowing backwards.
    expect(toResetAwareDeltas([['t1', 100], ['t2', 5]])).toEqual([['t2', 5]]);
  });

  it('returns an empty series for fewer than two points', () => {
    expect(toResetAwareDeltas([['t1', 1]])).toEqual([]);
    expect(toResetAwareDeltas([])).toEqual([]);
  });
});
```

Run: `cd apps/api && npx vitest run src/services/metricBucketing.test.ts`
Expected failure: `Failed to resolve import "./metricBucketing"`.

- [ ] **Step 2: Implement `services/metricBucketing.ts`**

```ts
/**
 * Bucketing and caps for GET /monitoring/assets/:id/metrics (spec §6.3).
 *
 * Pure so the cap arithmetic is testable without a database — the caps are the
 * only thing standing between a chart tab and a 90-day sequential scan of a
 * table that takes ~138k rows a day per walked switch once W02 ships.
 */

export type BucketChoice = 'auto' | '1m' | '5m' | '1h' | '1d';

export const MAX_RANGE_DAYS = 90;
export const MAX_POINTS_PER_SERIES = 2000;
export const MAX_SERIES = 64;

const SECONDS: Record<Exclude<BucketChoice, 'auto'>, number> = { '1m': 60, '5m': 300, '1h': 3600, '1d': 86400 };

export function bucketSeconds(bucket: Exclude<BucketChoice, 'auto'>): number {
  return SECONDS[bucket];
}

/** Widest bucket that still shows detail, narrow enough to stay under the cap. */
export function chooseBucket(fromMs: number, toMs: number): Exclude<BucketChoice, 'auto'> {
  const hours = (toMs - fromMs) / 3600_000;
  if (hours <= 6) return '1m';
  if (hours <= 48) return '5m';
  if (hours <= 24 * 30) return '1h';
  return '1d';
}

export function validateRange(
  fromMs: number,
  toMs: number,
  bucket: BucketChoice,
): { ok: true; bucket: Exclude<BucketChoice, 'auto'>; seconds: number } | { ok: false; message: string } {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return { ok: false, message: 'from and to must be valid ISO timestamps' };
  }
  if (toMs <= fromMs) return { ok: false, message: 'to must be after from' };
  const rangeDays = (toMs - fromMs) / 86_400_000;
  if (rangeDays > MAX_RANGE_DAYS) {
    return { ok: false, message: `Requested range exceeds the ${MAX_RANGE_DAYS}-day cap` };
  }
  const chosen = bucket === 'auto' ? chooseBucket(fromMs, toMs) : bucket;
  const seconds = SECONDS[chosen];
  const points = (toMs - fromMs) / 1000 / seconds;
  if (points > MAX_POINTS_PER_SERIES) {
    return {
      ok: false,
      message: `Bucket ${chosen} over this range yields ${Math.ceil(points)} points, above the ${MAX_POINTS_PER_SERIES}-point cap; widen the bucket or shorten the range`,
    };
  }
  return { ok: true, bucket: chosen, seconds };
}

/** Counters aggregate with max (they only ever climb); gauges with avg. */
export function isCounterType(type: string | undefined): boolean {
  return typeof type === 'string' && type.toLowerCase().startsWith('counter');
}

/**
 * Reset-aware first differences. A DECREASE means the counter wrapped or the
 * device restarted, not negative traffic — take the new value as the delta,
 * which is the standard SNMP treatment and cannot render as a downward spike.
 */
export function toResetAwareDeltas(points: Array<[string, number]>): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (let i = 1; i < points.length; i++) {
    const [ts, current] = points[i]!;
    const previous = points[i - 1]![1];
    out.push([ts, current >= previous ? current - previous : current]);
  }
  return out;
}
```

- [ ] **Step 3: Write the failing route tests**

Create `apps/api/src/routes/monitoringAssetMetrics.test.ts` (mock shape copied from `routes/monitoring.test.ts` — read that file first). Cases:

```ts
  it('404 for an asset in another org', …);                        // multi-tenant isolation
  it('403 for a site-restricted caller outside the asset site', …);
  it('404 when the asset has no SNMP device', …);
  it('400 with the cap in the message for a 91-day range', …);
  it('400 with the point cap in the message for bucket=1m over 30 days', …);
  it('400 when more than 64 oids are requested', …);
  it('groups rows into one series per (oid, instance) with [ts, value] points', …);
  it('uses max for a counter template entry and avg for a gauge', …);
  it('returns reset-aware deltas when delta=1', …);
  it('matches an instance oid as well as a base oid', …);
```

Run: `cd apps/api && npx vitest run src/routes/monitoringAssetMetrics.test.ts`
Expected failure: `Failed to resolve import "./monitoringAssetMetrics"`.

- [ ] **Step 4: Implement `routes/monitoringAssetMetrics.ts`**

```ts
/**
 * GET /monitoring/assets/:id/metrics — bucketed SNMP metric history (spec §6.3).
 *
 * Its own module: routes/monitoring.ts is already 1,071 lines and this handler
 * is a self-contained read. Mounted as a second sub-router at /monitoring in
 * index.ts; `/assets/:id` cannot shadow `/assets/:id/metrics`, so mount order
 * does not matter.
 *
 * Every cap in services/metricBucketing.ts is load-bearing. snmp_metrics is a
 * row-per-sample table (the spec explicitly does NOT make it a hypertable in
 * this scope), and once W02's walks land, one 48-port switch writes ~138k rows
 * a day. An uncapped range here is a sequential scan with a tenant on the other
 * end of it.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { zValidator } from '../lib/validation';
import { db } from '../db';
import { discoveredAssets, snmpDevices, snmpMetrics, snmpTemplates } from '../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../services/permissions';
import { resolveOrgIdForAsset, type AssetAuthContext } from '../services/assetAccessScope';
import {
  isCounterType,
  toResetAwareDeltas,
  validateRange,
  MAX_SERIES,
  type BucketChoice,
} from '../services/metricBucketing';

export const monitoringAssetMetricsRoutes = new Hono();
monitoringAssetMetricsRoutes.use('*', authMiddleware);

const querySchema = z.object({
  oid: z.string().min(1),
  from: z.string().optional(),
  to: z.string().optional(),
  bucket: z.enum(['auto', '1m', '5m', '1h', '1d']).optional(),
  delta: z.enum(['0', '1']).optional(),
  orgId: z.string().guid().optional(),
});

monitoringAssetMetricsRoutes.get(
  '/assets/:id/metrics',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', querySchema),
  async (c) => {
    const auth = c.get('auth') as AssetAuthContext;
    const perms = c.get('permissions') as UserPermissions | undefined;
    const assetId = c.req.param('id')!;
    const query = c.req.valid('query');

    const orgResult = await resolveOrgIdForAsset(auth, assetId, query.orgId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const [asset] = await db
      .select({ id: discoveredAssets.id, orgId: discoveredAssets.orgId, siteId: discoveredAssets.siteId })
      .from(discoveredAssets)
      .where(and(eq(discoveredAssets.id, assetId), eq(discoveredAssets.orgId, orgResult.orgId)))
      .limit(1);
    if (!asset) return c.json({ error: 'Asset not found' }, 404);
    if (perms?.allowedSiteIds && (typeof asset.siteId !== 'string' || !canAccessSite(perms, asset.siteId))) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const oids = query.oid.split(',').map((o) => o.trim()).filter(Boolean);
    if (oids.length === 0) return c.json({ error: 'oid is required' }, 400);
    if (oids.length > MAX_SERIES) {
      return c.json({ error: `At most ${MAX_SERIES} OIDs may be requested at once` }, 400);
    }

    const toMs = query.to ? Date.parse(query.to) : Date.now();
    const fromMs = query.from ? Date.parse(query.from) : toMs - 24 * 3600_000;
    const range = validateRange(fromMs, toMs, (query.bucket ?? 'auto') as BucketChoice);
    if (!range.ok) return c.json({ error: range.message }, 400);

    const [snmpDevice] = await db
      .select({ id: snmpDevices.id, templateId: snmpDevices.templateId })
      .from(snmpDevices)
      .where(and(eq(snmpDevices.assetId, asset.id), eq(snmpDevices.orgId, asset.orgId)))
      .orderBy(sql`${snmpDevices.isActive} desc`, sql`${snmpDevices.createdAt} desc`)
      .limit(1);
    if (!snmpDevice) return c.json({ error: 'This asset has no SNMP device' }, 404);

    // The template's per-OID `type` decides the aggregate: counters only ever
    // climb, so averaging them across a bucket invents values that never
    // existed; gauges are averaged.
    const counterOids = new Set<string>();
    if (snmpDevice.templateId) {
      const [template] = await db
        .select({ oids: snmpTemplates.oids })
        .from(snmpTemplates)
        .where(eq(snmpTemplates.id, snmpDevice.templateId))
        .limit(1);
      for (const entry of (template?.oids ?? []) as Array<{ oid?: string; type?: string }>) {
        if (entry.oid && isCounterType(entry.type)) counterOids.add(entry.oid);
      }
    }

    const seconds = range.seconds;
    // Epoch-floor bucketing: one expression for all four widths (date_trunc has
    // no 5-minute unit) and exactly aligned, which matters when the UI overlays
    // two series. The numeric regex drops string-valued OIDs (ifDescr is text)
    // rather than coercing them to NaN.
    const bucketExpr = sql`to_timestamp(floor(extract(epoch from ${snmpMetrics.timestamp}) / ${seconds}) * ${seconds})`;
    const baseExpr = sql`coalesce(${snmpMetrics.baseOid}, ${snmpMetrics.oid})`;
    const instanceExpr = sql`coalesce(${snmpMetrics.instance}, '')`;

    const rows = await db
      .select({
        baseOid: baseExpr as unknown as ReturnType<typeof sql<string>>,
        oid: snmpMetrics.oid,
        instance: instanceExpr as unknown as ReturnType<typeof sql<string>>,
        name: sql<string>`min(${snmpMetrics.name})`,
        bucket: bucketExpr as unknown as ReturnType<typeof sql<string>>,
        avgValue: sql<string>`avg((${snmpMetrics.value})::double precision)`,
        maxValue: sql<string>`max((${snmpMetrics.value})::double precision)`,
      })
      .from(snmpMetrics)
      .where(and(
        eq(snmpMetrics.deviceId, snmpDevice.id),
        gte(snmpMetrics.timestamp, new Date(fromMs)),
        lt(snmpMetrics.timestamp, new Date(toMs)),
        sql`(${baseExpr} = any(${oids}) or ${snmpMetrics.oid} = any(${oids}))`,
        sql`${snmpMetrics.value} ~ '^-?[0-9]+([.][0-9]+)?$'`,
      ))
      .groupBy(baseExpr, snmpMetrics.oid, instanceExpr, bucketExpr)
      .orderBy(bucketExpr);

    type Series = { oid: string; instance: string; name: string; points: Array<[string, number]> };
    const seriesByKey = new Map<string, Series>();
    for (const row of rows) {
      const key = `${row.oid}|${row.instance}`;
      const series = seriesByKey.get(key) ?? { oid: row.oid, instance: row.instance, name: row.name, points: [] };
      const raw = counterOids.has(row.baseOid) ? row.maxValue : row.avgValue;
      const value = Number(raw);
      if (Number.isFinite(value)) {
        series.points.push([new Date(row.bucket).toISOString(), value]);
      }
      seriesByKey.set(key, series);
    }

    const wantDeltas = query.delta === '1';
    const series = Array.from(seriesByKey.values())
      .slice(0, MAX_SERIES)
      .map((s) => ({ ...s, points: wantDeltas ? toResetAwareDeltas(s.points) : s.points }));

    return c.json({
      series,
      bucket: range.bucket,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
    });
  },
);
```

If the `sql` casts above fight the Drizzle typings, declare each expression with an explicit `sql<string>` template instead of casting — the SQL text is what matters, and the integration test in Step 6 is what proves it.

- [ ] **Step 5: Mount it**

In `apps/api/src/index.ts`, next to `api.route('/monitoring', monitoringRoutes);` (line 974):

```ts
import { monitoringAssetMetricsRoutes } from './routes/monitoringAssetMetrics';
// …
api.route('/monitoring', monitoringRoutes);
// Metric history in its own module (routes/monitoring.ts is already 1,071
// lines). `/assets/:id` cannot shadow `/assets/:id/metrics`.
api.route('/monitoring', monitoringAssetMetricsRoutes);
```

- [ ] **Step 6: Write the integration test (real Postgres)**

Create `apps/api/src/__tests__/integration/networkDeviceTruth.integration.test.ts` with two cases — everything above mocks the database, so nothing so far has proved the bucketing SQL is even valid Postgres:

```ts
  it('buckets real rows with the epoch-floor expression and honours counter vs gauge aggregates', async () => {
    // Seed org/site/asset/snmp_device/snmp_template + ~10 snmp_metrics rows
    // across 3 five-minute buckets: one counter OID, one gauge OID, one
    // text-valued OID (ifDescr). Request ?oid=<all three>&bucket=5m and assert
    // the point counts, that the counter series used max and the gauge avg, and
    // that the text OID produced an empty series rather than NaN.
  });

  it('rejects a probe result for an asset that moved sites (spec §5 correlation)', async () => {
    // Seed an asset with last_probe_ref = <commandId>, last_probe_status =
    // 'pending', then UPDATE its site_id, then call applyProbeResult with the
    // ORIGINAL expected site. Assert it resolves false and that
    // last_probe_status is still 'pending'.
  });
```

Follow the existing suites in `apps/api/src/__tests__/integration/` for the fixture helpers and the `withSystemDbAccessContext` seeding convention.

- [ ] **Step 7: Run and commit**

Run:
```
cd apps/api && npx vitest run src/services/metricBucketing.test.ts src/routes/monitoringAssetMetrics.test.ts \
&& npx vitest run --config vitest.integration.config.ts src/__tests__/integration/networkDeviceTruth.integration.test.ts \
&& npx tsc --noEmit -p tsconfig.json
```
Expected: PASS. If the bucketing SQL errors on real Postgres (`function to_timestamp(double precision) does not exist`, a GROUP BY mismatch, or `operator does not exist: character varying = text[]` on the `any()` binding), fix the SQL — the unit tests cannot catch any of those.

```bash
git add apps/api/src/services/metricBucketing.ts apps/api/src/services/metricBucketing.test.ts \
        apps/api/src/routes/monitoringAssetMetrics.ts apps/api/src/routes/monitoringAssetMetrics.test.ts \
        apps/api/src/__tests__/integration/networkDeviceTruth.integration.test.ts apps/api/src/index.ts
git commit -m "$(cat <<'COMMIT_EOF'
feat(monitoring): GET /monitoring/assets/:id/metrics with bucketing and hard caps (W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT_EOF
)"
```

---

### Task 14: Metric retention — extend the worker that already exists

**Files:**
- Modify: `apps/api/src/jobs/snmpRetention.ts:1-12` (header), `:29` (the default)
- Modify: `apps/api/src/jobs/snmpRetention.test.ts` (assert the new default)

**DECISION — do NOT create `jobs/snmpMetricsRetention.ts`.** Spec §7.5 asks for "a daily job … deletes rows older than `SNMP_METRICS_RETENTION_DAYS` (default 30) in batches of 10 000 (`ctid`-bounded loop, system DB context), logging the count". **That job already exists.** `apps/api/src/jobs/snmpRetention.ts` prunes `snmp_metrics` via `pruneInCtidBatches`, reads `SNMP_METRICS_RETENTION_DAYS` (clamped 1..365), `SNMP_METRICS_RETENTION_BATCH_SIZE` (default 10 000) and `SNMP_METRICS_RETENTION_MAX_BATCHES` (default 200), logs the deleted count, calls `recordRetentionRun('snmp_retention', …)`, and runs four times a day at the registry slot `'snmp-retention': '12 1,7,13,19 * * *'`. The spec author did not know it was there. A second worker would double-delete, burn a second `scheduleRegistry` slot, and fail `scheduleRegistry.contract.test.ts`'s no-two-coarse-schedules-in-one-minute assertion.

The one substantive difference is the default: **7 days today, 30 in the spec.** Raise it to 30. §6.3 permits a 90-day range and §11's Monitoring tab offers 24 h / 7 d / 30 d charts — at a 7-day floor the 30-day chart is structurally empty, which is the same "the UI claims something the data cannot support" failure this whole wave exists to fix. The growth is deferred: W01 ships ingestion only, so the walk volume does not arrive until W02's agents roll. Note in the PR body that a droplet can pin the old window with `SNMP_METRICS_RETENTION_DAYS=7`, and that §17 already calls for watching `snmp_metrics` size on EU/US for the first week after the agent release.

- [ ] **Step 1: Write the failing assertion**

In `apps/api/src/jobs/snmpRetention.test.ts`:

```ts
  it('defaults to 30 days so the 30-day chart range has data (spec §6.3, §7.5)', () => {
    // Was 7. A 7-day default made /monitoring/assets/:id/metrics?from=-30d
    // return a week of points and the UI render a third of a chart with no
    // indication anything was missing.
    expect(__testOnly.DEFAULT_RETENTION_DAYS).toBe(30);
  });
```

Run: `cd apps/api && npx vitest run src/jobs/snmpRetention.test.ts`
Expected failure: `expected 7 to be 30`.

- [ ] **Step 2: Change the default**

In `apps/api/src/jobs/snmpRetention.ts`, line 29:

```ts
// 30 days, not 7 (spec §6.3 / §7.5): the Monitoring tab offers a 30-day chart
// and /metrics permits a 90-day range, so a 7-day floor made both structurally
// empty. Override per deployment with SNMP_METRICS_RETENTION_DAYS; the ctid
// batching, the 200-batch ceiling and the 4x/day schedule are unchanged.
const DEFAULT_RETENTION_DAYS = resolveRetentionDays(process.env.SNMP_METRICS_RETENTION_DAYS, 30, MAX_RETENTION_DAYS, LOG_PREFIX);
```

Update the module header's "Default retention: 7 days" line to 30 in the same edit.

- [ ] **Step 3: Run and commit**

Run: `cd apps/api && npx vitest run src/jobs/snmpRetention.test.ts src/jobs/scheduleRegistry.contract.test.ts`
Expected: PASS. The schedule registry is untouched, so its contract test must stay green — a failure there means a slot was added that should not have been.

```bash
git add apps/api/src/jobs/snmpRetention.ts apps/api/src/jobs/snmpRetention.test.ts
git commit -m "$(cat <<'COMMIT_EOF'
feat(monitoring): raise snmp_metrics retention default to 30 days for the history charts (W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
COMMIT_EOF
)"
```

---

### Task 15: Full verification and PR

**Files:** none changed; this task is the gate.

- [ ] **Step 1: Unit suites for everything this wave touched**

Run:
```
cd apps/api && npx vitest run \
  src/services/assetReachability.test.ts \
  src/services/assetReachabilityLoader.test.ts \
  src/services/assetIdentity.test.ts \
  src/services/assetProbe.test.ts \
  src/services/networkExecutorSelection.test.ts \
  src/services/snmpCollectionState.test.ts \
  src/services/metricBucketing.test.ts \
  src/services/aiToolsNetwork.test.ts \
  src/services/aiToolsMonitoring.test.ts \
  src/routes/discoveryAssetProbe.test.ts \
  src/routes/monitoringAssetMetrics.test.ts \
  src/routes/monitoring \
  src/routes/monitors \
  src/routes/discovery \
  src/routes/devices/network \
  src/routes/agentWs \
  src/jobs/snmpWorker \
  src/jobs/snmpRetention.test.ts \
  src/jobs/monitorWorker \
  src/jobs/discoveryWorker \
  src/services/unifi \
  src/db/autoMigrate.test.ts \
  src/db/migrationRlsScope.test.ts
```
Expected: all PASS. Check the reported file count — the bare-substring filters are not directory prefixes and each deliberately pulls in its dotted siblings (`snmpWorker` also matches `snmpWorkerScheduler`, `snmpWorker.dbcontext`, `snmpWorker.orgAuthority`, `snmpWorker.ingestion`).

- [ ] **Step 2: The full API unit job**

Run: `pnpm --filter @breeze/api test --run` (no `--` before `--run`).
Expected: PASS. This is the **Test API** CI job. The device-side cascade contracts (`cascadeDelete.test.ts`, `moveOrg.coverage.test.ts`) run here and read the Drizzle schema statically — this wave adds no `device_id` column, so both must be green without edits. If either fails, a column landed on the wrong table.

- [ ] **Step 3: The contract suites that only fail under Integration Tests**

`pnpm test-stack up` must already be running. Run:
```
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/networkDeviceTruth.integration.test.ts
```
Expected: all PASS. **These are what a unit-green PR goes red on after merge.** This wave adds ten columns to three org-cascade tables, so `tenant-export-policy` and `tenantExportErasureRoundtrip` are the live risk: a failure names the unclassified column, and the fix is the registry entry, never the test. `rls-coverage`, `tenantCascade` and `orgLifecycleFoundations` must be green unchanged — no new table, no new FK, no new policy.

- [ ] **Step 4: Lint and typecheck**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json && cd ../.. && pnpm lint`
Expected: clean.

- [ ] **Step 5: Tear down and open the PR**

```bash
pnpm test-stack down
```

Then open the PR with this body (fill in the sub-issue number):

```markdown
Closes #<W01 sub-issue>

Spec: `docs/superpowers/specs/monitoring/2026-09-16-network-device-page-truth-design.md` §4, §5, §6.1-6.3, §7.3, §7.5, §9 (read-time), §12-§15.
Plan: `docs/superpowers/plans/monitoring/2026-09-16-network-device-page-truth-w01-api-truth.md`.

Every status claim the API makes about a discovered network asset is now sourced and dated.

## What changed
- `services/assetReachability.ts` derives `responding | not_responding | unverified` from each source's own last observation, ranked by evidence class (host probes > SNMP > scan/UniFi), with `source`, `observedAt`, `lastKnown` and per-source detail. `unverified` maps to list status `unknown`, never `offline`.
- `discovered_assets` gains `status_observed_at` / `status_source`, stamped at all five `is_online` writers, plus four `last_probe_*` columns.
- `POST /discovery/assets/:id/probe`: site-strict executor, 8 s wait then 202 pending, result correlated by command id AND unchanged ip/site before it is persisted.
- `snmp_devices.last_status = 'no_template'` — F2 is visible at last, and it does not touch `consecutive_failures`.
- `processPollResults` ingests protocol-2 rows (`base_oid`, `instance`, `error`); an all-error poll is `warning` and does not clear the backoff. Ships before any agent emits the shape (W02).
- `collection` on `GET /monitoring/assets/:id`, and a new `GET /monitoring/assets/:id/metrics` with 90-day / 2,000-point / 64-series caps served by a new composite index.
- Read-time `model` mask (a raw sysObjectID is not a model) and `nicVendor`.

## Behaviour changes worth a second look
- **`POST /monitors/:id/test` no longer falls back org-wide for an asset-bound monitor.** It used to probe from any online agent in the org when the asset's site had none — the cross-site behaviour SR5-08 removed from the worker. It now returns the existing "No online agent available" body.
- **`/test` now excludes ephemeral Quick Support devices**, which it never did. Both changes fall out of sharing one picker (`services/networkExecutorSelection.ts`) with the worker and the probe.
- **`SNMP_METRICS_RETENTION_DAYS` default 7 -> 30.** Spec §7.5 asked for a new reaper; `jobs/snmpRetention.ts` already was one (ctid-batched, 4x/day, env-configurable), so only the default moved — a 7-day floor made the 30-day chart structurally empty. Pin `SNMP_METRICS_RETENTION_DAYS=7` per droplet to keep the old window. Watch `snmp_metrics` size on EU/US after W02's agents roll (§17).
- **No AI tool reported asset online state before this PR** (enumerated against main: `aiToolsNetwork.ts` and `aiToolsMonitoring.ts` never selected `discovered_assets.is_online`). `query_monitors` gains `assetReachability`; `get_network_asset_reachability` is new.

## Tenancy
Ten new columns, no new tables. All ten classified `included` in `CORE_TENANT_EXPORT_POLICY` in the same commits as their migrations. No RLS, cascade, or org-merge registry change — verified by running `rls-coverage`, `tenantCascade`, `orgLifecycleFoundations`, `tenant-export-policy` and `tenantExportErasureRoundtrip` locally against a live database.

## Migration operator note
`2026-10-17-110100` builds `snmp_metrics_device_oid_ts_idx` with `CREATE INDEX CONCURRENTLY` in autoMigrate's `@no-transaction` lane. On a large production `snmp_metrics`, build it by hand before the release rolls (the statement is in the file header); an interrupted build leaves an INVALID index that `IF NOT EXISTS` silently retains, and recovery is `DROP INDEX CONCURRENTLY snmp_metrics_device_oid_ts_idx`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 6: CI**

This branch targets `main`, so `ci.yml` runs on the `pull_request` event and the `integration-test` job (4 shards) runs and blocks. **Do not hand-dispatch CI** — it already ran. Wait for `CI Success`, then `gh pr merge <N>` to enqueue. Never `--admin`.

If a later wave stacks on this branch before it merges, THAT branch gets no `pull_request` run at all and needs `gh workflow run CI --ref <branch>` before enqueueing.

---

## Definition of done

- [ ] Three migrations applied twice against a live database with no error; `pnpm db:check-drift` clean; `snmp_metrics_device_oid_ts_idx` reports `indisvalid = t`.
- [ ] All ten new columns classified `included`; both export-policy integration suites green.
- [ ] `deriveReachability` covers every §4.2 rule with table-driven tests, including both undated-`is_online` cases, the HTTP/DNS exclusions, and SNMP-failure-alone → `unverified` with detail.
- [ ] `reachability` present on `GET /discovery/assets`, `/discovery/assets/:id`, `/devices/network`, `/monitoring/assets`, `/monitoring/assets/:id`; `status` on both list shapes and the topology node status derived from it; `is_online` still present and documented as the last scan/controller verdict.
- [ ] One executor picker; `monitorWorker` behaviour unchanged; `/test` site-strict and Quick-Support-safe.
- [ ] Probe returns 200 / 202 / 409 `NO_AGENT_IN_SITE` / 409 `PROBE_IN_FLIGHT` / 422 `ASSET_NO_IP` / 422 `ASSET_NO_SITE`, with a real-database test proving a moved asset's result is refused.
- [ ] `no_template` durable and backoff-free, pinned by the scheduler `it.each`.
- [ ] Protocol-2 ingestion and the all-error `warning` poll pinned by unit tests, with the legacy row shape unchanged.
- [ ] `collection` on the monitoring asset route, with `unknown` distinguished from `unsupported`.
- [ ] `/metrics` bucketed with all three caps enforced and one integration test proving the SQL runs on real Postgres.
- [ ] `pnpm --filter @breeze/api test --run` green; the six integration suites green; `tsc --noEmit` and `pnpm lint` clean.
- [ ] `pnpm test-stack down` run; nothing left running.

## Names W02–W05 depend on (do not rename after merge)

`deriveReachability`, `reachabilityToListStatus`, `ReachabilityState`, `ReachabilitySource`, `Reachability`, `ReachabilityInput`, `loadReachabilityInputs`, `loadReachability`, `selectNetworkExecutor`, `loadAssetSiteId`, `deriveCollection`, `CollectionOidState`, `defaultOidMode`, `defaultOidCadence`, `maskOidShapedModel`, `nicVendorFromMac`, `SnmpMetricResult`, `SNMP_ERROR_CODES`, `buildProbeCommandId`, `parseProbeCommandId`, `applyProbeResult`, `resolveAssetForMutation`, `resolveOrgIdForAsset`, `resolveOrgIdForAuth`, `bucketSeconds`, `chooseBucket`, `validateRange`, `isCounterType`, `toResetAwareDeltas`; the ten columns; response fields `reachability`, `nicVendor`, `probe`, `collection`; routes `POST /discovery/assets/:id/probe` and `GET /monitoring/assets/:id/metrics`.

W02 imports `defaultOidMode` / `defaultOidCadence` from `services/snmpCollectionState.ts` when building `services/snmpOidSpecs.ts` — do not restate the `.0` rule there. W02 also owns `snmp_devices.poll_seq`, which W01 creates but never reads.
