# Fleet Hygiene — Findings Feed + Aggregate Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Materialized partner-wide findings feed (metric-anomaly patterns, log correlations, reliability offenders) on the `/fleet` page, with one-click multi-device remediation through the existing per-device command rails and a durable run ledger.

**Architecture:** A BullMQ producer job groups three shipped org-scoped sources into `fleet_findings` episodes keyed by deterministic semantic keys, with normalized pruned membership. Routes expose a partner-wide feed + lifecycle + a remediate endpoint that snapshots targets and fans out via `queueCommandForExecution` in ≤500-device per-org chunks. Two read-only AI tools read the same data.

**Spec:** `docs/superpowers/specs/monitoring/2026-08-07-fleet-hygiene-findings-design.md` — read it first; it holds the rationale and the traps.

**Tech Stack:** Hono, Drizzle, Postgres RLS (shape 1), BullMQ, React (Astro island), Vitest.

## Global Constraints

- Every new table: RLS enabled+forced+4 policies **in the creating migration**; migration idempotent; NO inner `BEGIN;`/`COMMIT;`; filename `2026-XX-XX-<slug>.sql` (never touch the closed `2026-08-06` block).
- Register all 4 tables in `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical) and `CORE_TENANT_EXPORT_POLICY` (every column classified; ALL jsonb → `excludedOpen`) in the same PR.
- `fleet_remediation_run_targets.target_device_uuid` is a **snapshot uuid with NO FK and NOT named `device_id`** — the device-move trigger (`2026-05-18-device-child-orgid-cascade.sql`) rewrites org_id on any table with columns literally named `device_id`+`org_id`, which would corrupt historical runs.
- Site scoping is app-layer everywhere (`auth.allowedSiteIds`); RLS only covers orgs. Fail closed.
- Dispatch: re-validate each target's org+site access at dispatch time; ≤500 devices per chunk; exclude Quick Support/ephemeral devices (`devices.isEphemeral` — mirror the reliability worker's filter); never hold a DB transaction across queue work.
- BullMQ job IDs must not contain colons (use `-` separators).
- Web mutations wrapped in `runAction`; transient UI state via `window.location.hash`.
- Producers run under `withSystemDbAccessContext`; request-path code uses the ambient request context (never the bare pool).
- Local green ≠ CI green: RLS/cascade/export suites need a live DB (`vitest.integration.config.ts`); run them before PR. Stacked PRs get NO CI — `gh workflow run CI --ref <branch>` per branch.

---

### Task 1: Drizzle schema — `fleetFindings.ts`

**Files:**
- Create: `apps/api/src/db/schema/fleetFindings.ts`
- Modify: `apps/api/src/db/schema/index.ts` (add `export * from './fleetFindings';` alphabetically near the analytics export)

**Interfaces (Produces):** tables `fleetFindings`, `fleetFindingDevices`, `fleetRemediationRuns`, `fleetRemediationRunTargets`; types `FleetFindingKind = 'metric_anomaly_pattern' | 'log_correlation' | 'reliability_offenders'`, `FleetFindingStatus = 'open' | 'acknowledged' | 'dismissed' | 'resolved'`, `FleetRunStatus = 'queued' | 'running' | 'partial' | 'succeeded' | 'failed' | 'cancelled'`, `FleetTargetStatus = 'pending' | 'queued' | 'succeeded' | 'failed' | 'skipped'`.

- [ ] **Step 1: Write the schema file.** Mirror the style of `apps/api/src/db/schema/analytics.ts` (varchar-backed statuses, not pg enums — matches `metric_anomalies`):

```ts
import { pgTable, uuid, varchar, text, integer, bigint, jsonb, timestamp, index, uniqueIndex, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './orgs';
import { users } from './users';

export type FleetFindingKind = 'metric_anomaly_pattern' | 'log_correlation' | 'reliability_offenders';
export type FleetFindingStatus = 'open' | 'acknowledged' | 'dismissed' | 'resolved';
export type FleetFindingSeverity = 'info' | 'warning' | 'error' | 'critical';
export type FleetRunStatus = 'queued' | 'running' | 'partial' | 'succeeded' | 'failed' | 'cancelled';
export type FleetTargetStatus = 'pending' | 'queued' | 'succeeded' | 'failed' | 'skipped';

export const fleetFindings = pgTable('fleet_findings', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 40 }).$type<FleetFindingKind>().notNull(),
  semanticKey: text('semantic_key').notNull(),
  algorithmVersion: integer('algorithm_version').notNull().default(1),
  status: varchar('status', { length: 20 }).$type<FleetFindingStatus>().notNull().default('open'),
  severity: varchar('severity', { length: 20 }).$type<FleetFindingSeverity>().notNull().default('warning'),
  title: varchar('title', { length: 300 }).notNull(),
  summary: text('summary'),
  evidence: jsonb('evidence').notNull().default({}),
  deviceCount: integer('device_count').notNull().default(0),
  revision: bigint('revision', { mode: 'number' }).notNull().default(1),
  firstSeenAt: timestamp('first_seen_at').notNull(),
  lastSeenAt: timestamp('last_seen_at').notNull(),
  lastReconciledAt: timestamp('last_reconciled_at'),
  acknowledgedAt: timestamp('acknowledged_at'),
  acknowledgedBy: uuid('acknowledged_by').references(() => users.id, { onDelete: 'set null' }),
  dismissedAt: timestamp('dismissed_at'),
  dismissedBy: uuid('dismissed_by').references(() => users.id, { onDelete: 'set null' }),
  dismissNotes: text('dismiss_notes'),
  resolvedAt: timestamp('resolved_at'),
  resolutionReason: varchar('resolution_reason', { length: 40 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  idOrgUq: uniqueIndex('fleet_findings_id_org_uq').on(t.id, t.orgId),
  liveEpisodeUq: uniqueIndex('fleet_findings_live_episode_uq')
    .on(t.orgId, t.kind, t.semanticKey, t.algorithmVersion)
    .where(sql`resolved_at IS NULL`),
  feedIdx: index('fleet_findings_feed_idx').on(t.orgId, t.status, t.severity, t.lastSeenAt),
}));

export const fleetFindingDevices = pgTable('fleet_finding_devices', {
  findingId: uuid('finding_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull(),          // live membership — device-move trigger re-tenants it, reconciler prunes
  sourceKind: varchar('source_kind', { length: 40 }).notNull(),
  sourceRowId: uuid('source_row_id'),
  memberEvidence: jsonb('member_evidence').notNull().default({}),
  firstSeenAt: timestamp('first_seen_at').notNull(),
  lastSeenAt: timestamp('last_seen_at').notNull(),
}, (t) => ({
  pk: uniqueIndex('fleet_finding_devices_pk').on(t.findingId, t.deviceId),
  // Single-column FK on finding_id ONLY (no same-org composite FK): the
  // device-move trigger rewrites this table's org_id when a device changes
  // orgs; a composite (finding_id, org_id) FK would break mid-move. The
  // transient org mismatch is pruned by the next reconcile pass.
  findingFk: foreignKey({ columns: [t.findingId], foreignColumns: [fleetFindings.id], name: 'fleet_finding_devices_finding_fk' }),
  orgIdx: index('fleet_finding_devices_org_idx').on(t.orgId),
  deviceIdx: index('fleet_finding_devices_device_idx').on(t.deviceId),
}));

export const fleetRemediationRuns = pgTable('fleet_remediation_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  findingId: uuid('finding_id').notNull(),
  findingRevision: bigint('finding_revision', { mode: 'number' }).notNull(),
  actionKind: varchar('action_kind', { length: 20 }).$type<'script' | 'command'>().notNull(),
  scriptId: uuid('script_id'),
  commandType: varchar('command_type', { length: 60 }),
  parameterSnapshot: jsonb('parameter_snapshot').notNull().default({}),
  status: varchar('status', { length: 20 }).$type<FleetRunStatus>().notNull().default('queued'),
  targetCount: integer('target_count').notNull().default(0),
  succeededCount: integer('succeeded_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
}, (t) => ({
  findingFk: foreignKey({ columns: [t.findingId, t.orgId], foreignColumns: [fleetFindings.id, fleetFindings.orgId], name: 'fleet_remediation_runs_finding_org_fk' }),
  orgStatusIdx: index('fleet_remediation_runs_org_status_idx').on(t.orgId, t.status, t.createdAt),
  findingIdx: index('fleet_remediation_runs_finding_idx').on(t.findingId),
}));

export const fleetRemediationRunTargets = pgTable('fleet_remediation_run_targets', {
  runId: uuid('run_id').notNull().references(() => fleetRemediationRuns.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  targetDeviceUuid: uuid('target_device_uuid').notNull(), // SNAPSHOT — no FK, must not be named device_id (org-rewrite trigger)
  hostnameSnapshot: varchar('hostname_snapshot', { length: 255 }),
  siteIdSnapshot: uuid('site_id_snapshot'),
  status: varchar('status', { length: 20 }).$type<FleetTargetStatus>().notNull().default('pending'),
  deviceCommandId: uuid('device_command_id'),
  resultSummary: text('result_summary'),
  skipReason: varchar('skip_reason', { length: 80 }),
  queuedAt: timestamp('queued_at'),
  completedAt: timestamp('completed_at'),
}, (t) => ({
  pk: uniqueIndex('fleet_remediation_run_targets_pk').on(t.runId, t.targetDeviceUuid),
  orgIdx: index('fleet_remediation_run_targets_org_idx').on(t.orgId),
  statusIdx: index('fleet_remediation_run_targets_status_idx').on(t.runId, t.status),
}));
```

- [ ] **Step 2: Export from index.** Add `export * from './fleetFindings';` to `apps/api/src/db/schema/index.ts`.
- [ ] **Step 3: Verify the schema parses.** Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift`. Expected: **drift reported** for the four new tables (schema loads cleanly; migration doesn't exist yet — Task 2 clears it). A parse/type error here fails loudly instead. Do NOT run a bare `tsc` over the api package (known OOM trap).
- [ ] **Step 4: Commit.** `git add apps/api/src/db/schema/ && git commit -m "feat(fleet): fleet findings + remediation run schema"`

---

### Task 2: Migration

**Files:**
- Create: `apps/api/migrations/2026-08-16-fleet-hygiene-findings.sql` (the repo already contains migrations dated through `2026-08-15`, so the filename must be `2026-08-16` or later to sort last — do NOT use today's calendar date if it sorts earlier)

- [ ] **Step 1: Write the migration.** Copy the structure of `apps/api/migrations/2026-08-11-software-upload-sessions.sql` (header comment explaining tenancy + FK directions, `CREATE TABLE IF NOT EXISTS`, guarded `DO $$` constraint blocks, `CREATE INDEX IF NOT EXISTS`, `DROP POLICY IF EXISTS` + `CREATE POLICY` ×4 per table with `breeze_has_org_access(org_id)`, `ENABLE`+`FORCE` RLS, grants to `breeze_app`). Four tables exactly matching Task 1's Drizzle definitions. Key SQL details the template doesn't show:

```sql
-- fleet_findings: partial unique for one live episode per problem
CREATE UNIQUE INDEX IF NOT EXISTS fleet_findings_live_episode_uq
  ON fleet_findings(org_id, kind, semantic_key, algorithm_version)
  WHERE resolved_at IS NULL;
-- status/severity/kind CHECK constraints (guarded DO blocks), e.g.:
--   kind IN ('metric_anomaly_pattern','log_correlation','reliability_offenders')
--   status IN ('open','acknowledged','dismissed','resolved')
-- fleet_finding_devices: FOREIGN KEY (finding_id) REFERENCES fleet_findings(id) ON DELETE CASCADE
--   (single-column — org_id is rewritten by the device-move trigger, so no composite FK here)
-- fleet_remediation_runs composite FK (org_id here is never trigger-rewritten):
--   FOREIGN KEY (finding_id, org_id) REFERENCES fleet_findings(id, org_id) ON DELETE CASCADE
-- fleet_remediation_run_targets.run_id REFERENCES fleet_remediation_runs(id) ON DELETE CASCADE
-- fleet_finding_devices PRIMARY KEY (finding_id, device_id)
-- fleet_remediation_run_targets PRIMARY KEY (run_id, target_device_uuid)
```

All four tables get the standard 4 shape-1 policies. `gen_random_uuid()` only (no `gen_random_bytes` — pgcrypto is absent).

- [ ] **Step 2: Verify naming + ordering.** Run: `bash scripts/check-migration-naming.sh && pnpm --filter @breeze/api test -- --run autoMigrate`. Expected: PASS.
- [ ] **Step 3: Apply + drift check.** `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:migrate && pnpm db:check-drift`. Expected: migration applies; no drift (fix schema/migration mismatches now).
- [ ] **Step 4: Manual RLS forge.** `docker exec -it breeze-postgres psql -U breeze_app -d breeze` → attempt cross-tenant `INSERT INTO fleet_findings (org_id, kind, semantic_key, title, first_seen_at, last_seen_at) VALUES ('<other-org-uuid>', ...)` without context. Expected: `new row violates row-level security policy`.
- [ ] **Step 5: Commit.**

---

### Task 3: Cascade + export-policy registration

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`, line ~64) — insert `'fleet_finding_devices'`, `'fleet_findings'`, `'fleet_remediation_run_targets'`, `'fleet_remediation_runs'` in alphabetical position. (Order safety: `deleteOrgCascade` recomputes FK-safe order via `topologicalCascadeOrder()` from live pg_constraint; the list + alphabetical rule is the contract-test convention.)
- Modify: `apps/api/src/routes/devices/core.ts` — add `'fleet_finding_devices'` to BOTH `CORE_DEVICE_CASCADE_DELETE_TABLES` and `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (it has live `device_id` + denormalized `org_id`; `fleet_remediation_run_targets` joins neither — snapshot column).
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` — add 4 `tablePolicy("org_id", {...})` entries classifying **every** column. Buckets: all jsonb (`evidence`, `member_evidence`, `parameter_snapshot`) → `excludedOpen`; `result_summary` → `excludedSensitive` (command output can embed credentials); everything else (ids, statuses, counts, timestamps, titles, semantic keys, hostname/site snapshots) → `included`.

- [ ] **Step 1: Make all four edits** (org cascade list, export policy, device cascade list, device org-denormalized list).
- [ ] **Step 2: Run the static device-list unit tests:** `pnpm --filter @breeze/api test -- --run cascadeDelete moveOrg`. Expected: PASS.
- [ ] **Step 2b: Run the contract suites against the live dev DB:** `pnpm --filter @breeze/api exec vitest run -c vitest.integration.config.ts tenantCascade tenant-export-policy tenantExportErasureRoundtrip rls-coverage`. Expected: PASS (alphabetical order, FK direction, full column coverage, shape-1 auto-discovery).
- [ ] **Step 3: Commit.**

---

### Task 4: Producers + reconciliation service

**Files:**
- Create: `apps/api/src/services/fleetFindings/producers.ts`, `apps/api/src/services/fleetFindings/reconcile.ts`, `apps/api/src/services/fleetFindings/types.ts`
- Test: `apps/api/src/services/fleetFindings/producers.test.ts`, `reconcile.test.ts`

**Interfaces (Produces):**

```ts
// types.ts
export interface CandidateMember { deviceId: string; sourceKind: string; sourceRowId: string | null; memberEvidence: Record<string, unknown>; }
export interface CandidateFinding {
  kind: FleetFindingKind; semanticKey: string; severity: FleetFindingSeverity;
  title: string; summary: string; evidence: Record<string, unknown>; members: CandidateMember[];
}
// producers.ts
export async function produceMetricAnomalyPatterns(orgId: string): Promise<CandidateFinding[]>;
export async function produceLogCorrelationFindings(orgId: string): Promise<CandidateFinding[]>;
export async function produceReliabilityOffenders(orgId: string): Promise<CandidateFinding[]>;
// reconcile.ts
export const FLEET_FINDINGS_ALGORITHM_VERSION = 1;
export async function reconcileOrgFindings(orgId: string, candidates: CandidateFinding[]): Promise<{ opened: number; updated: number; resolved: number }>;
```

Grouping rules (from spec §5): anomalies — open `metric_anomalies` grouped by `(metric_name, anomaly_type)`, ≥2 devices, key `metric:<metric_name>:<anomaly_type>`, severity `critical` if max score ≥ 4σ-equivalent used by the detectors else `warning`, evidence bounded to 20 member samples; log correlations — active `log_correlations` 1:1, key `logcorr:<rule_id>`, members from `affectedDevices` jsonb; reliability — `device_reliability` score < 50, non-ephemeral devices only, single finding keyed `reliability:offenders`, severity `error` if any device < 25 else `warning`.

Reconcile semantics (test each): upsert by `(orgId, kind, semanticKey, algorithmVersion)` live episode; insert new members / update `last_seen_at` / **delete** members absent from candidates; bump `revision` + `lastSeenAt` + `deviceCount` only when membership or evidence changed; candidate absent + live episode exists → `status='resolved'`, `resolutionReason='source_cleared'`; dismissed episodes are NOT reopened by reconcile (only membership/lastSeen update); resolved episode + candidate reappears → NEW row (partial unique allows it).

- [ ] **Step 1: Write failing tests for reconcile.** Use the Drizzle mock pattern from the `breeze-testing` skill (mock `db` module; assert insert/update/delete calls). Cover the six semantics above — e.g.:

```ts
it('prunes members that no longer qualify and bumps revision', async () => { /* live episode with devices A,B; candidates only A → expect delete for B, revision bump */ });
it('does not reopen a dismissed episode', async () => { /* dismissed row + matching candidate → no status change */ });
it('auto-resolves when candidate disappears', async () => { /* live row, no candidate → resolved + source_cleared */ });
```

- [ ] **Step 2: Run tests — expect FAIL** (`pnpm --filter @breeze/api test -- --run fleetFindings`).
- [ ] **Step 3: Implement `reconcile.ts`** — plain Drizzle upserts inside `withSystemDbAccessContext`; no transaction across the whole org (per-finding transaction is fine).
- [ ] **Step 4: Write failing tests for each producer** (mock db; feed source rows; assert grouping, keys, min-device threshold, ephemeral exclusion, evidence bounding to 20).
- [ ] **Step 5: Implement producers.** Reuse existing query patterns: `metric_anomalies` open rows via the `metric_anomalies_org_status_detected_idx` shape; `log_correlations` active rows; reliability via `device_reliability` join `devices` filtering `isEphemeral = false` (copy the exact ephemeral filter from `services/reliabilityScoring.ts`).
- [ ] **Step 6: All green** (`pnpm --filter @breeze/api test -- --run fleetFindings`). Commit.

---

### Task 5: BullMQ job wiring

**Files:**
- Create: `apps/api/src/jobs/fleetFindings.ts` + `apps/api/src/jobs/fleetFindings.test.ts`
- Modify: wherever `scheduleMetricRollupJobs` (or equivalent) is invoked at boot — `grep -n "metricRollups" apps/api/src/index.ts apps/api/src/jobs/*.ts` and mirror it.

**Interfaces (Produces):** `scheduleFleetFindingsJobs()`, queue name `fleet-findings`, repeatable scan every 10 min enqueuing per-org jobs (jobId `fleet-findings-org-<orgId>` — **no colons**), worker concurrency 2.

- [ ] **Step 1: Copy the `apps/api/src/jobs/metricRollups.ts` scan-orgs structure** — repeatable `scan-orgs` job → per-org jobs; org gate: read `organizations.settings` JSON flag `fleet.findings.enabled` (default **true** when absent; skip org when explicitly `false`). Per-org handler: `runOutsideDbContext` guard → `withSystemDbAccessContext` → run 3 producers → `reconcileOrgFindings`. One org's throw must not fail the scan (per-org jobs isolate this naturally).
- [ ] **Step 2: Tests** — flag-off skip, flag-default-on, per-org fan-out enqueues expected jobIds (mirror `metricRollups.test.ts` mocking style if present; otherwise mock the queue and the producers).
- [ ] **Step 3: Wire scheduling at boot** exactly where metric rollups schedule theirs. Run targeted tests; commit.

---

### Task 6: Findings API — list / detail / lifecycle

**Files:**
- Create: `apps/api/src/routes/fleetFindings.ts` + `apps/api/src/routes/fleetFindings.test.ts`
- Modify: `apps/api/src/index.ts` — `import { fleetFindingsRoutes } from './routes/fleetFindings';` + `api.route('/fleet/findings', fleetFindingsRoutes);` (near the `/analytics` mount, line ~1072)

**Interfaces (Produces):**
- `GET /` — query: `orgId?, kind?, severity?, status? (default 'open,acknowledged'), limit? (≤100, default 50), offset?`. Returns `{ findings: FindingRow[], total }` where `FindingRow` = finding columns + `orgName`. Partner tokens: all `auth.accessibleOrgIds`; org tokens: their org. **Site-restricted callers** (`auth.allowedSiteIds`): `deviceCount` recomputed from membership joined to `devices.siteId ∈ allowedSiteIds`, findings with zero in-site members omitted.
- `GET /:id` — finding + members (each joined to live `devices` for hostname/site; site-filtered) + last 10 runs.
- `PATCH /:id` — body `{ action: 'acknowledge' | 'dismiss' | 'reopen', notes? }`; sets status + audit columns; `reopen` only from `acknowledged`/`dismissed`; audit-log via the standard `auditLog` service call used by neighboring routes.

- [ ] **Step 1: Failing route tests** (Drizzle mock pattern; assert org scoping for org vs partner token, site filtering drops out-of-site members AND zero-member findings, lifecycle transitions incl. invalid transition → 400).
- [ ] **Step 2: Implement.** Scope with the same `requireScope('organization','partner','system')` + org-condition helpers `routes/logs.ts` uses. Zod-validate query/body in `packages/shared` style if neighboring routes do (`grep "zValidator" apps/api/src/routes/logs.ts` and mirror).
- [ ] **Step 3: Green + commit.**

---

### Task 7: Remediation dispatch

**Files:**
- Create: `apps/api/src/services/fleetFindings/dispatch.ts` + `dispatch.test.ts`; `apps/api/src/jobs/fleetRemediationDispatch.ts` + test
- Modify: `apps/api/src/routes/fleetFindings.ts` (add `POST /:id/remediate`, `GET /:id/runs`, `GET /runs/:runId`)

**Interfaces (Produces):**

```ts
// dispatch.ts
export interface RemediateRequest { actionKind: 'script' | 'command'; scriptId?: string; commandType?: string; parameters: Record<string, unknown>; deviceIds?: string[]; /* subset of membership; absent = all members */ }
export async function createRemediationRun(auth: AuthContext, findingId: string, req: RemediateRequest): Promise<{ runId: string; targetCount: number; skipped: Array<{ deviceId: string; reason: string }> }>;
export async function dispatchRunChunk(runId: string, chunkIndex: number): Promise<void>; // called by the BullMQ worker
export async function pollRunProgress(runId: string): Promise<void>; // repeatable until terminal
```

Semantics (each is a test):
- `createRemediationRun` re-validates every requested device NOW under the caller's auth: member of finding, org in `accessibleOrgIds`, site in `allowedSiteIds` (when restricted), not decommissioned, not ephemeral. Failures become `skipped` targets with `skip_reason` (`site_denied`/`not_member`/`decommissioned`) — never silently dropped. Snapshot hostname/site into target rows. Allowed `commandType` values are an explicit allowlist: `['restart_service','clear_temp_files','reboot','execute_script']` — reject anything else (400).
- Dispatch job fans out per-org chunks of ≤500 via `queueCommandForExecution(deviceId, type, payload, { userId: run.createdBy, expectedOrgId: target.orgId })` (`services/commandQueue.ts:620`), stores `device_command_id`, marks target `queued`. Queue failures → target `failed`. No DB transaction held across the loop.
- `pollRunProgress` (repeatable job every 30s per active run, jobId `fleet-run-poll-<runId>`): read linked `device_commands` statuses → update targets (`succeeded`/`failed` + bounded `result_summary` — **truncate to 2000 chars**); after 30 min pending targets → `failed` with `skip_reason='timeout'`; recompute run counts + status (`partial` when mixed; terminal → stop polling, set `completedAt`).
- Route `POST /:id/remediate` → `createRemediationRun` + enqueue dispatch; 403 when caller lacks access to the finding's org; response includes skipped list.

- [ ] **Step 1: Failing tests for `createRemediationRun`** (validation matrix above, snapshot correctness, subset selection).
- [ ] **Step 2: Implement createRemediationRun.**
- [ ] **Step 3: Failing tests for dispatch chunking + poller** (mock `queueCommandForExecution`; 1200 targets → 3 chunks; queue throw → target failed; poller timeout path; counts/status derivation incl. `partial`).
- [ ] **Step 4: Implement dispatch + poller jobs.**
- [ ] **Step 5: Routes + tests green; commit.**

---

### Task 8: AI tools (read-only)

**Files:**
- Modify: `apps/api/src/services/aiToolsFleet.ts` (add `get_fleet_findings` inside `registerFleetTools`, `aiToolsFleet.ts:384`)
- Modify: `apps/api/src/services/aiToolsPerformance.ts` (add `analyze_fleet_metrics`)
- Test: extend the neighboring `aiToolsFleet.test.ts` / `aiToolsPerformance.test.ts`

**Interfaces:** follows `AiTool` (`aiTools.ts:94`): `{ tier: 1, definition: { name, description, input_schema }, handler: safeHandler(...) }`.

- [ ] **Step 1: `get_fleet_findings`** — inputs `{ kind?, severity?, status? (default open+acknowledged), orgId?, limit? (≤50) }`; handler reuses the Task 6 list query helpers (extract the query builder into `services/fleetFindings/query.ts` if the route inlined it — one source of truth for site filtering). Returns JSON rows with title, kind, severity, deviceCount, orgName, lastSeenAt, id.
- [ ] **Step 2: `analyze_fleet_metrics`** — inputs `{ metricName ('cpu_percent'|'memory_percent'|'disk_percent'), windowHours (default 24, ≤168), topN (default 10, ≤50), orgId? }`; queries `metric_rollups` via the `(org_id, bucket_seconds, bucket_start)` index: per-device avg/p95/max over the window, ordered by p95 desc, plus fleet-level avg/p95. Site-restricted callers: join `devices.siteId` filter. Returns top-N table + fleet summary.
- [ ] **Step 3: Tests** (org scoping, site filtering, input clamping) mirroring existing tool tests. Green; commit.

---

### Task 9: Web — findings feed on `/fleet`

**Files:**
- Create: `apps/web/src/components/fleet/FindingsFeed.tsx`, `FindingDrawer.tsx`, `apps/web/src/services/fleetFindings.ts` (typed fetch/mutation helpers)
- Modify: `apps/web/src/components/fleet/FleetOrchestrationPage.tsx` — feed becomes the primary content; existing stat cards collapse into a summary strip above it (keep the `failedEndpoints` partial-failure pattern)
- Test: `FindingsFeed.test.tsx`, `FindingDrawer.test.tsx` (jsdom)

- [ ] **Step 1: Service layer** — `listFindings(filters)`, `getFinding(id)`, `patchFinding(id, action, notes?)`, all mutations via `runAction` (`apps/web/src/lib/runAction.ts`), catch pattern per CLAUDE.md.
- [ ] **Step 2: `FindingsFeed`** — rows: severity icon, kind badge, title, org badge, `N devices`, relative age, status chip; filter bar (org/kind/severity/status); selected finding in `window.location.hash` (`#<findingId>`); empty state ("Fleet is clean ✨") and error banner on fetch failure.
- [ ] **Step 3: `FindingDrawer`** — summary + evidence render (bounded, preformatted), member device table linking to `/devices/<id>`, lifecycle buttons (Acknowledge / Dismiss-with-notes / Reopen), run history list. `data-testid` attributes on all interactive elements (e2e convention).
- [ ] **Step 4: jsdom tests** — feed renders findings + filters narrow; lifecycle buttons call service + optimistic status update; drawer opens from hash. Follow the mocking style of the existing `FleetOrchestrationPage` tests if present, else `DevicesPage.test.tsx` patterns.
- [ ] **Step 5: `pnpm --filter @breeze/web test -- --run fleet` green (incl. `no-silent-mutations`); commit.**

---

### Task 10: Web — fix picker + run progress

**Files:**
- Create: `apps/web/src/components/fleet/FixPickerModal.tsx`, `RunProgressPanel.tsx` (+ tests)
- Modify: `FindingDrawer.tsx` — "Remediate across N devices" primary button

- [ ] **Step 1: `FixPickerModal`** — step 1 choose action: script from library (reuse the script-selection + param-form pattern from `DeploymentWizard.tsx` / the run-script bulk action in `DevicesPage.tsx:858-942`) or command preset (`restart_service` + service name param, `clear_temp_files`, `reboot`); step 2 review targets: member list with checkboxes (all selected by default), out-of-site/decommissioned members shown pre-disabled; step 3 confirm → `POST /fleet/findings/:id/remediate` via `runAction`; surface returned `skipped` list inline.
- [ ] **Step 2: `RunProgressPanel`** — poll `GET /fleet/findings/runs/:runId` every 5s while active; per-device rows with status + bounded failure summaries (mirror `bulkActionGating.ts` + bulk progress UX in `DevicesPage`); terminal state shows succeeded/failed/skipped counts.
- [ ] **Step 3: Tests** — picker validation (script requires selection; empty target set disables confirm), skipped-list rendering, poll → terminal transition stops polling. Green; commit.

---

### Task 11: Integration test + CI

**Files:**
- Create: `apps/api/src/__tests__/integration/fleetFindings.integration.test.ts`

- [ ] **Step 1: Integration suite** (live Postgres; replay migrations per existing integration-suite bootstrap): (a) seed two orgs under one partner + one foreign partner; producers + reconcile create findings; partner token lists both orgs' findings, org token only its own, foreign partner sees none; (b) site-restricted token: membership filtered, zero-member finding omitted; (c) `createRemediationRun` + dispatch against the real `device_commands` table — command rows created with correct org, targets update on simulated command completion; (d) RLS forge: cross-tenant insert into `fleet_findings` as `breeze_app` fails with 42501.
- [ ] **Step 2: Run locally:** `pnpm --filter @breeze/api exec vitest run -c vitest.integration.config.ts fleetFindings rls-coverage tenantCascade tenant-export-policy`. Expected: PASS. (Local Postgres wants `fsync=off` tmpfs or it looks hung.)
- [ ] **Step 3: Full unit suites:** `pnpm --filter @breeze/api test && pnpm --filter @breeze/web test`. PASS → commit.
- [ ] **Step 4: PR + CI.** Per-PR in the stack: `gh workflow run CI --ref <branch>`. Remember integration suites are non-blocking on PRs but required on main.

## Self-Review Notes

- Spec §5 producer thresholds (≥2 devices, score <50, 20-sample evidence bound) are encoded in Task 4; lifecycle semantics in Task 4 reconcile tests; §6 dispatch semantics in Task 7; §8 AI tools in Task 8; §7 UI in Tasks 9–10; §10 testing split across Tasks 4–11.
- Deliberate deviation from spec §4.2: `fleet_finding_devices.device_id` KEEPS the standard name so the device-move trigger re-tenants live membership (reconciler then prunes/re-adds) — only the **historical** `fleet_remediation_run_targets` row uses the trigger-exempt `target_device_uuid` snapshot name. Spec updated rationale: membership is current-state, targets are history.
- `deployment_device_id` from the spec sketch dropped: v1 dispatches exclusively via `queueCommandForExecution` (scripts are `execute_script` commands), so only `device_command_id` exists. Deployments remain the path for software installs, out of v1 picker scope.
