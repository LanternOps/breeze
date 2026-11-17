---
spec: docs/superpowers/specs/ai-mcp/2026-11-13-wisp-analysis-sessions-design.md
wave_map: docs/superpowers/plans/ai-mcp/2026-11-13-wisp-analysis-sessions-w00-wave-map-and-contracts.md
---

# Wisp Analysis Sessions W05 — Datasets 2 (alerts, patches, change log) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the four `export_dataset` datasets that carry the most sensitive free text: `alerts`, `patch_state`, `patch_attempts` and `change_log`. Each gets explicit redaction, a frozen-permission entry, and the `user_account_changes` sensitive gate on `change_log`.

**Architecture:** Same shape as W04. Each adapter lives in `services/aiToolsExportDatasets/` (`alerts.ts`, `patches.ts`, `changes.ts`) and is built from W04's `aiToolsExportShared.ts`: `timeRangeFromFilters` first, then `exportDeviceSet`, then one keyset query per page filtered by `deviceIdIn`. The frozen sensitive gate is read from the request. A gate the run does not hold filters rows in SQL and adds a note to the result. Nothing evaluates the run principal's permissions.

**Tech Stack:** Hono/TypeScript API, Drizzle (queries only), postgres.js, Vitest, one index-only SQL migration.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-11-13-wisp-analysis-sessions-design.md` §4.4 (table rows `alerts`, `patch_state`, `patch_attempts`, `change_log`; "Rules every new adapter follows"), §7 "Datasets", §8 decisions 8–9. Wave map C2, C6, C8.

**Rigor:** high (sensitive free text, permission gate). Full red-first per task; one independent review round in Task 9.

**Consumes:**
- **W04** (`2026-11-13-wisp-analysis-sessions-w04-datasets-reliability.md`). From `services/aiToolsExportShared.ts`: `ExportFilterError`, `timeRangeFromFilters`, `KeyPart`, `keysetBefore`, `keysetAfterIds`, `keysetPager`, `runExportQuery`, `deviceIdIn`, `exportDeviceSet` / `ExportDeviceScope`, `emptyExportPager`, `noteOn`, `exportText(value, { urls?, paths? })`, `exportJsonText(value, { urls?, paths? })`, `EXPORT_TEXT_MAX_CHARS = 2000`. Also `DatasetRequest.notes: string[]` (W02 creates it, C8); the names leaf `aiToolsExportDatasetNames.ts`; the drift test in `aiToolsExport.registration.test.ts`; the contract-scan registration of `aiToolsExportDatasets/*.ts` and of `exportDeviceSet`; the adapter test helpers (`req`, `scope`, `firstQuery`, `allRows`). Follow W04's rule that a `.from(<table>)` sits lexically inside the named `create<X>Pager` function that calls `exportDeviceSet(req)`.
- **W02** (planned in parallel, not in code at plan time). `EXPORT_DATASET_REQUIREMENTS` in `services/aiToolsExportPermissions.ts`; `AnalysisSensitiveGate = 'security_events' | 'user_account_changes'`; `AiRunExportGrants`; the frozen `staged_inputs.exportGrants`; the handler's `dataset_not_permitted` refusal. Adapters read the frozen grants through `DatasetRequest.exportGrants: AiRunExportGrants` (W00 C8; W02 creates it). A run admitted before W02 carries the legacy grants W02 builds for it: the original seven datasets and no sensitive gate.

## Global Constraints

- No new flag; `export_dataset` runs only inside an agent run (`aiToolsExport.ts:116-121`).
- Dataset names, verbatim (C8): `alerts`, `patch_state`, `patch_attempts`, `change_log`. Files: `aiToolsExportDatasets/alerts.ts`, `patches.ts`, `changes.ts`.
- Set-based: one keyset query per page, filtered by the device set; never a per-device loop.
- `filters.timeRange { start, end }` (ISO), default the last 30 days, at most 180 days (`timeRangeFromFilters`, throws `ExportFilterError('invalid_time_range')`).
- Keyset `(time column, id)` descending, 500 rows per page; no offset paging.
- Org from `req.orgId`; site and device restriction only through `exportDeviceSet`; an empty set → `emptyExportPager`, never unrestricted.
- Every free-text column is redacted explicitly (`export_dataset` is `captureExempt`), then cut to 2000 characters. Alert messages also go through `scrubUrlsInText` (`utils/endpointDisplay.ts:79`).
- **`patch_job_results.output` is never selected.** `device_change_log.fingerprint` and `alerts.context` are never selected.
- `user_account` change rows require the frozen `user_account_changes` gate (`devices:execute`). Without it they are filtered out and the result says so.
- Permissions are the equivalent read tool's `TOOL_PERMISSIONS` entry, frozen at admission by W02. A run principal has no RBAC role: never add a handler-side permission check. All four datasets are tier 1.
- Migration: index only, `-- @no-transaction`, `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, idempotent, no inner `BEGIN`/`COMMIT`. Name it to sort after the newest migration on `origin/main`: re-run `git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -1` first (W04 plans `2027-01-25-110000-…`). Migration slots (C8): W03 `2027-01-25-100000-*`, W04 `2027-01-25-110000-*`, W05 `2027-01-25-120000-*`. Whichever wave merges later re-checks the newest migration on `origin/main` and renames its own unshipped file if needed; never rename a shipped one. Then `pnpm db:check-drift`.
- Tests: `cd apps/api && npx vitest run <path>`; never `pnpm --filter <pkg> test -- --run <path>`. Red first.
- Typecheck with a 12 GB heap; check the exit code.

## Review Focus

1. **A secret straddling the 2000-character cut** (`password=…` at character 1995 of a patch `last_error`). Expect it redacted, never half-emitted: redaction runs before the cut. Pinned in Task 4.
2. **A URL carrying a signed token in an alert message or a patch error** (`https://x.blob.core.windows.net/a?sig=…`). Expect only scheme and host. Pinned in Tasks 3 and 5.
3. **`change_log` asked for only `user_account` changes without the gate.** Expect an empty export with the note, not an error and not other change types. Pinned in Task 6.
4. **A patch result whose job is in another org but whose device is in this org, and the reverse (a device moved orgs).** Expect both excluded, even under a DB context that can see both orgs. Pinned in Task 7.
5. **An alert owned by a topology site or backup workload whose `device_id` names an in-frame device** (topology alerts keep the origin device as provenance, `db/schema/alerts.ts:143-147`). Expect it excluded. Pinned in Task 3.

---

## File map

| File | Change |
|---|---|
| `apps/api/src/services/aiToolsExportShared.ts` | Add `holdsSensitiveGate`. |
| `apps/api/src/services/aiToolsExportDatasets/{alerts,patches,changes}.ts` (+ `.test.ts`) | **Create.** Adapters. |
| `apps/api/src/services/aiToolsExportDatasetNames.ts`, `aiToolsExportDatasets.ts` | Four names; `DATASET_ADAPTERS` entries. |
| `apps/api/src/services/aiToolsExportPermissions.ts` (W02) | Four entries; `change_log` carries the sensitive gate. |
| `apps/api/migrations/2027-01-25-120000-export-dataset-alert-index.sql` | **Create.** One partial index on `alerts`. |
| `apps/api/src/db/schema/alerts.ts` | Mirror the index. |
| `apps/api/src/__tests__/integration/exportDatasetsAlertsPatches.integration.test.ts` | **Create.** |
| `apps/api/src/services/aiToolsExport.ts:58,67`, `apps/docs/src/content/docs/features/ai-tools.mdx:450` | Description, search hint, docs. |

## Indexes and binding

The device set is bound as one `uuid[]` parameter (`deviceIdIn`; reasoning and precedent in W04, "Why these indexes"). Each adapter's index:

| Dataset | Order | Index | Decision |
|---|---|---|---|
| `alerts` | `(triggered_at, id)` desc | **new partial** `alerts_org_device_triggered_idx ON alerts (org_id, triggered_at DESC, id DESC) WHERE owner_kind = 'device'` | The existing `alerts_device_triggered_at_idx (device_id, triggered_at DESC)` cannot give one time order across a frame, so each page would re-sort every remaining row. `alerts_org_status_triggered_at_idx (org_id, status, triggered_at DESC)` puts `status` before time (`migrations/2026-05-17-b-alerts-scale-indexes.sql:15-19`). The query's literal `owner_kind = 'device'` implies the partial predicate. |
| `patch_state` | `(device_id, patch_id)` asc | `device_patches_device_patch_unique (device_id, patch_id)` | Snapshot dataset. `device_id = ANY(...)` sits on the index's leading column, so the scan returns rows in index order on PG16 too. No migration. |
| `patch_attempts` | `(created_at, id)` desc | `patch_job_results_created_idx (created_at)` (`migrations/2027-01-23-130000-history-retention-indexes.sql:41`) | **Accepted cross-tenant walk.** The table has no `org_id`, so no org-led index can exist without denormalising. The walk is bounded by the time window. Inferred volume is tens of rows per device per month, so a sparse org's page walks at most the window's rows. Each page stops after 501 matches. Revisit with an `org_id` column if the wall clock (`EXPORT_WALL_MS` 120 s) truncates real exports. |
| `change_log` | `(timestamp, id)` desc | `device_change_log_org_time_idx (org_id, timestamp)` | Exists. No migration. |

---

### Task 1: Sensitive-gate check on the request

**Files:**
- Modify: `apps/api/src/services/aiToolsExportShared.ts`, and `aiToolsExportDatasets.ts` `DatasetRequest` only if W02 did not add the field
- Test: `apps/api/src/services/aiToolsExportShared.test.ts`

**Interfaces:**
- Consumes: `DatasetRequest.exportGrants: AiRunExportGrants` (W02, C8).
- Produces: `export function holdsSensitiveGate(req: DatasetRequest, gate: AnalysisSensitiveGate): boolean`. True only when `req.exportGrants.sensitiveGates` includes `gate`. Legacy grants hold no gate (C2), so they return `false`.

- [ ] **Step 1: Write the failing test**

```ts
describe('holdsSensitiveGate', () => {
  it.each([
    [{ datasets: ['event_logs', 'agent_logs', 'device_inventory', 'software_inventory', 'metrics', 'vulnerabilities', 'custom_fields'], sensitiveGates: [] }, false],
    [{ datasets: ['change_log'], sensitiveGates: [] }, false],
    [{ datasets: ['change_log'], sensitiveGates: ['security_events'] }, false],
    [{ datasets: ['change_log'], sensitiveGates: ['user_account_changes'] }, true],
  ])('grants %j → %s', (exportGrants, expected) => {
    expect(holdsSensitiveGate({ ...baseReq, exportGrants } as DatasetRequest, 'user_account_changes')).toBe(expected);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd apps/api && npx vitest run src/services/aiToolsExportShared.test.ts` → `holdsSensitiveGate` is not exported.
- [ ] **Step 3: Implement** `holdsSensitiveGate`. Add no request field: `exportGrants` is W02's (C8).
- [ ] **Step 4: Run, expect PASS** — the test file.
- [ ] **Step 5: Commit** — `git commit -m "feat(ai-export): read frozen sensitive gates in dataset adapters"`

---

### Task 2: Alert export index

**Files:**
- Create: `apps/api/migrations/2027-01-25-120000-export-dataset-alert-index.sql`
- Modify: `apps/api/src/db/schema/alerts.ts` (index block, ~185-230)

- [ ] **Step 1: Write the migration.** Pattern: `migrations/2027-01-23-130000-history-retention-indexes.sql`. Content: first line `-- @no-transaction`; a header giving the reason in the "Indexes and binding" row; `CREATE INDEX CONCURRENTLY IF NOT EXISTS alerts_org_device_triggered_idx ON public.alerts (org_id, triggered_at DESC, id DESC) WHERE owner_kind = 'device';`; and the `DO $$` block that raises if the index is `INVALID`. No row writes.
- [ ] **Step 2: Run the drift check, expect FAIL** — test stack up, `DATABASE_URL` exported: `pnpm db:migrate && pnpm db:check-drift` → reports the index missing from the schema.
- [ ] **Step 3: Mirror it** — ``index('alerts_org_device_triggered_idx').on(table.orgId, table.triggeredAt.desc(), table.id.desc()).where(sql`owner_kind = 'device'`)``.
- [ ] **Step 4: Run, expect PASS** — `pnpm db:check-drift`; `cd apps/api && npx vitest run src/db/migrationRlsScope.test.ts`; `scripts/check-migration-naming.sh --staged`.
- [ ] **Step 5: Commit** — `git commit -m "perf(db): org/time index for device-owned alert export"`

---

### Task 3: `alerts`

**Files:** Create `aiToolsExportDatasets/alerts.ts` and `alerts.test.ts`; names leaf, hub, requirements.

**Spec for this adapter:**
- Source: `alerts a LEFT JOIN alert_rules r ON r.id = a.rule_id`. A rule the run's DB context cannot see (RLS) leaves `ruleName` null.
- Rows: device-owned alerts only, `a.owner_kind = 'device'` as a literal. `alerts_owner_chk` guarantees `device_id IS NOT NULL` for these. Topology-site and backup-workload alerts are skipped (spec §4.4).
- Filter: `a.org_id = req.orgId AND a.owner_kind = 'device' AND deviceIdIn(a.device_id, scope.deviceIds) AND a.triggered_at BETWEEN start AND end`. Every status, `dismissed` included: the `status` column lets the script filter.
- Columns: `id, deviceId, hostname, ruleId, ruleName, severity, status, title, message, triggeredAt, acknowledgedAt, resolvedAt, dismissedAt, suppressedUntil, resolutionReason`.
- **Not exported:** `context` (spec), `resolution_note` (technician free text, not in the spec's list), `subject_key`, `owner_ref`, the topology and principal columns.
- Redaction:

| Column | Helper |
|---|---|
| `title` | `exportText(v, { urls: true })` |
| `message` | `exportText(v, { urls: true })` — `scrubUrlsInText`, then `redactLogMessage`, then the 2000 cut. This applies to every alert, not only `network_monitor` ones (`aiToolsAlerts.ts:284` scrubs only those for chat) |
| `ruleName` | `exportText(v)` |
| `resolutionReason` | passed through when it is a string of ≤40 characters (`varchar(40)`), otherwise `null` |

- Time column: `triggered_at`. Keyset `(triggered_at, id)` desc, kind `timestamp`, key text `a.triggered_at::text`. Index: `alerts_org_device_triggered_idx` (Task 2).
- Permission (`EXPORT_DATASET_REQUIREMENTS.alerts`): `{ resource: 'alerts', action: 'read' }`, from `manage_alerts.list` at `aiGuardrails.ts:1667`.

- [ ] **Step 1: Write the failing tests** (W04 helpers; fake timers at `2026-11-13T12:00:00Z`)

```ts
it('one keyset query: org, device-owned literal, device set as one uuid[] param, default window, desc', async () => {
  const { sql, params } = await firstQuery(alertsAdapter, req({}));
  expect(sql).toMatch(/"alerts"\."org_id" = \$\d+/);
  expect(sql).toContain(`"alerts"."owner_kind" = 'device'`);
  expect(sql).toMatch(/"alerts"\."device_id" = ANY\(\$\d+::uuid\[\]\)/);
  expect(params).toContainEqual(['d1']);
  expect(params).toContain('2026-10-14T12:00:00.000Z');
  expect(sql).toMatch(/order by "alerts"\."triggered_at" desc, "alerts"\."id" desc/i);
});
it('never selects context or resolution_note', async () => {
  const { sql } = await firstQuery(alertsAdapter, req({}));
  expect(sql).not.toContain('"context"'); expect(sql).not.toContain('"resolution_note"');
});
it('message: URL reduced to origin, secret redacted, cut to 2000', async () => {
  const [row] = await allRows(alertsAdapter, [alertRow({
    message: `${'x'.repeat(3000)} https://acct.blob.core.windows.net/c?sig=SECRET password=hunter2`,
    title: 'Check https://u:p@host.example/path?token=t failed' })]);
  expect(row.message).not.toMatch(/SECRET|hunter2/);
  expect(Array.from(row.message as string).length).toBeLessThanOrEqual(2000);
  expect(row.title).toBe('Check https://host.example failed');
});
it('rule name redacted and cut', /* ruleName 'rule password=p' → 'rule password=[REDACTED]' */);
it('empty device set → empty pager, no query', async () => {
  exportDeviceSet.mockResolvedValue(scope([]));
  expect(await (await alertsAdapter.createPager(req({})))(null)).toEqual({ rows: [], nextCursor: null });
  expect(runExportQuery).not.toHaveBeenCalled();
});
it('second page uses keysetBefore on triggered_at::text', /* pageSize 1; 2nd toSQL contains '<= $n::timestamp AND (' and params include '2026-11-01 10:00:00.123456' */);
it('a 181-day range is refused before any query', /* rejects { code: 'invalid_time_range' }; runExportQuery not called */);
it('requirement equals manage_alerts.list', () => {
  expect(EXPORT_DATASET_REQUIREMENTS.alerts.permission).toEqual((TOOL_PERMISSIONS.manage_alerts as Record<string, unknown>).list);
});
```

The exact `title` expectation follows `scrubUrlsInText`'s origin form. Check one value against `utils/endpointDisplay.ts` `originOf` before you fix the string.

- [ ] **Step 2: Run, expect FAIL** — `cd apps/api && npx vitest run src/services/aiToolsExportDatasets/alerts.test.ts` → module not found.
- [ ] **Step 3: Implement** `createAlertsPager(req)`, with `.from(alerts)` inside its `keysetPager` arrow. Register the name, the `DATASET_ADAPTERS` entry and the requirement, and add the bare name to the description (`aiToolsExport.ts:67`) and the docs list (`ai-tools.mdx:450`), so the W04 drift test stays green.
- [ ] **Step 4: Run, expect PASS** — the test file, plus `src/services/aiToolsExport.registration.test.ts`.
- [ ] **Step 5: Commit** — `git commit -m "feat(ai-export): alerts dataset (device-owned, redacted message)"`

---

### Task 4: `patch_state`

**Files:** Create `aiToolsExportDatasets/patches.ts` and `patches.test.ts`; names, hub, requirements.

**Spec for this adapter:**
- Source: `device_patches dp INNER JOIN patches p ON p.id = dp.patch_id`. `patches` is the shared catalog.
- Rows: `dp.status <> 'missing'` as a literal. `missing` rows are scan tombstones (`db/schema/patches.ts:56-68`). An optional `filters.status` is an array that is a subset of `['pending', 'installed', 'failed', 'skipped']` and becomes `inArray(dp.status, …)`. Any other value throws `ExportFilterError('invalid_filter', 'filters.status must be an array of pending, installed, failed, skipped')`.
- Filter: `dp.org_id = req.orgId AND deviceIdIn(dp.device_id, …)`.
- Columns: `id, deviceId, hostname, patchId, source, externalId, title, severity, category, releaseDate, requiresReboot, status, installedAt, installedVersion, availableVersion, lastCheckedAt, failureCount, lastError`. `severity` is `EFFECTIVE_PATCH_SEVERITY_SQL` and `category` is `EFFECTIVE_PATCH_CATEGORY_SQL` (`services/patchSeverityOverlay.ts:23-30`), the same overlay `manage_patches list` uses (`aiToolsFleet.ts:1291-1330`). `externalId` is the KB or vendor id; the spec's "KB" comes from here.
- **Not exported:** `p.description`, `p.install_command`, `p.uninstall_command`, `p.detect_script`, `p.download_url`, `p.metadata`.
- Redaction: `title` → `exportText(v)`; `category` → `exportText(v)`; `externalId` → `exportText(v)`; `lastError` → `exportText(v, { urls: true })` (installer errors echo download URLs, which can carry signed query strings). The version columns are bounded varchars and pass through.
- Keyset: `(device_id, patch_id)` ascending via `keysetAfterIds([dp.deviceId, dp.patchId], after)`, shape `['uuid', 'uuid']`. Index `device_patches_device_patch_unique`. Snapshot: `timeRange` is validated, not applied, with the note `patch_state is current state; timeRange was not applied.`
- Permission: `{ resource: 'devices', action: 'read' }`, from `manage_patches.list` at `aiGuardrails.ts:2130`.

- [ ] **Step 1: Write the failing tests**

```ts
it('excludes tombstones with a literal and keys on (device_id, patch_id)', async () => {
  const { sql, params } = await firstQuery(patchStateAdapter, req({}));
  expect(sql).toContain(`"device_patches"."status" <> 'missing'`);
  expect(sql).toMatch(/"device_patches"\."org_id" = \$\d+/);
  expect(sql).toMatch(/"device_patches"\."device_id" = ANY\(\$\d+::uuid\[\]\)/);
  expect(sql).toMatch(/order by "device_patches"\."device_id" asc, "device_patches"\."patch_id" asc/i);
  expect(params).not.toContain('missing');
});
it('never selects install/uninstall/detect scripts or the description', async () => {
  const { sql } = await firstQuery(patchStateAdapter, req({}));
  for (const col of ['install_command', 'uninstall_command', 'detect_script', 'description', 'download_url']) expect(sql).not.toContain(`"${col}"`);
});
it('lastError: secret straddling the cut is redacted, URL reduced, ≤2000', async () => {
  const [row] = await allRows(patchStateAdapter, [patchRow({ lastError: `${'e'.repeat(1990)} password=hunter2 https://dl.example/x.msi?sig=S` })]);
  expect(row.lastError).not.toMatch(/hunter2|sig=S/);
  expect(Array.from(row.lastError as string).length).toBeLessThanOrEqual(2000);
});
it('title, category and externalId are redacted and cut', /* each fixture carries 'token=t' and 2500 chars */);
it.each([[['missing']], ['pending'], [['bogus']]])('filters.status %j is refused', async (status) => {
  await expect(patchStateAdapter.createPager(req({ status }))).rejects.toMatchObject({ code: 'invalid_filter' });
});
it('second page starts after (device_id, patch_id)', /* 2nd toSQL contains '("device_patches"."device_id", "device_patches"."patch_id") > ($n::uuid, $m::uuid)' */);
it('notes that timeRange does not apply', /* req({ timeRange: { start: '2026-10-01T00:00:00Z' } }) → notes contains the sentence */);
it('empty device set → empty pager, no query', /* as Task 3 */);
```

- [ ] **Step 2: Run, expect FAIL** — `cd apps/api && npx vitest run src/services/aiToolsExportDatasets/patches.test.ts`.
- [ ] **Step 3: Implement** `createPatchStatePager`. Register the name, adapter and requirement, and add the name to the description and the docs.
- [ ] **Step 4: Run, expect PASS** — the test file, plus `aiToolsExport.registration.test.ts`.
- [ ] **Step 5: Commit** — `git commit -m "feat(ai-export): patch_state dataset (no tombstones, redacted errors)"`

---

### Task 5: `patch_attempts`

**Files:** `aiToolsExportDatasets/patches.ts`, `patches.test.ts`; names, hub, requirements.

**Spec for this adapter:**
- Source: `patch_job_results r INNER JOIN patch_jobs j ON j.id = r.job_id LEFT JOIN patches p ON p.id = r.patch_id`. `r.patch_id IS NULL` marks a whole-device summary row (`db/schema/patches.ts:296-300`) and is kept, with null patch columns.
- **Org scope (the table has no `org_id`):** two independent app-layer conditions, both required. `j.org_id = req.orgId` puts the job in this org. `deviceIdIn(r.device_id, scope.deviceIds)` puts the device in this org's frame, because `exportDeviceSet` reads only `devices.org_id = req.orgId`. RLS adds a third layer: `patch_job_results` policies join `devices` (`migrations/2026-04-11-bucket-c-phase-5-admin-cold-rls.sql:148-152`).
- Columns: `id, jobId, jobName, deviceId, hostname, patchId, patchTitle, patchExternalId, status, startedAt, completedAt, exitCode, rebootRequired, rebootedAt, errorMessage, createdAt`.
- **Not exported:** `r.output` (spec decision 9), `j.patches`, `j.targets`.
- Redaction: `errorMessage` → `exportText(v, { urls: true })`; `jobName` → `exportText(v)`; `patchTitle` → `exportText(v)`; `patchExternalId` → `exportText(v)`.
- Time column: `r.created_at`. Keyset `(created_at, id)` desc, kind `timestamp`. Index: `patch_job_results_created_idx`, an accepted cross-tenant walk (table above).
- Permission: `{ resource: 'devices', action: 'read' }`, from `manage_patches.list` at `aiGuardrails.ts:2130`. The per-device job history action `device_history` carries the same entry (`:2134`).

- [ ] **Step 1: Write the failing tests**

```ts
it('NEVER selects patch_job_results.output', async () => {
  const { sql } = await firstQuery(patchAttemptsAdapter, req({}));
  expect(sql).not.toMatch(/"output"/);
});
it('scopes org through patch_jobs AND the device set (no org_id on the table)', async () => {
  const { sql, params } = await firstQuery(patchAttemptsAdapter, req({}));
  expect(sql).toMatch(/inner join "patch_jobs" on .*"patch_jobs"\."id" = "patch_job_results"\."job_id"/i);
  expect(sql).toMatch(/"patch_jobs"\."org_id" = \$\d+/);
  expect(sql).toMatch(/"patch_job_results"\."device_id" = ANY\(\$\d+::uuid\[\]\)/);
  expect(params).toContain('org-1');
});
it('errorMessage redacted, URL reduced, cut', /* 'failed: password=p https://h.example/a?token=t' + 3000 chars → no 'p'/'token=t', ≤2000 */);
it('a whole-device summary row (patchId null) is kept with null patch columns', /* fixture patchId null → row.patchTitle === null */);
it('order and keyset on created_at', /* order by created_at desc, id desc; 2nd page '<= $n::timestamp AND (' */);
it('default window and 181-day refusal', /* as Task 3 */);
it('empty device set → empty pager, no query', /* as Task 3 */);
```

- [ ] **Step 2: Run, expect FAIL** — `cd apps/api && npx vitest run src/services/aiToolsExportDatasets/patches.test.ts`.
- [ ] **Step 3: Implement** `createPatchAttemptsPager`. Register the name, adapter and requirement, and add the name to the description and the docs.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ai-export): patch_attempts dataset (no raw output, org via job + device set)"`

---

### Task 6: `change_log` and the `user_account_changes` gate

**Files:** Create `aiToolsExportDatasets/changes.ts` and `changes.test.ts`; names, hub, requirements.

**Spec for this adapter:**
- Source: `device_change_log` (`db/schema/changes.ts:32`).
- Filter: `org_id = req.orgId AND deviceIdIn(device_id, …) AND timestamp BETWEEN start AND end`. An optional `filters.changeType` is an array that is a subset of the eight `changeTypeEnum` values and becomes `inArray`; anything else → `ExportFilterError('invalid_filter')`.
- **Gate:** when `holdsSensitiveGate(req, 'user_account_changes')` is false:
  - add ``sql`${t.changeType} <> 'user_account'` `` and `noteOn(req, USER_ACCOUNT_CHANGES_NOTE)`;
  - if the requested `changeType` list is exactly `['user_account']`, return `emptyExportPager` with the same note, and run no query.

  `export const USER_ACCOUNT_CHANGES_NOTE = 'change_log: user account changes were left out; this run does not hold the user_account_changes permission (devices:execute).'`
- Columns: `id, deviceId, hostname, timestamp, changeType, changeAction, subject, beforeValue, afterValue, details`. **Not exported:** `fingerprint`, `created_at`.
- Redaction: `subject` → `exportText(v)`; `beforeValue`, `afterValue` and `details` (jsonb) → `exportJsonText(v)` (secret keys replaced by `[REDACTED]`, then stringified and cut to 2000).
- Time column: `timestamp`. Keyset `(timestamp, id)` desc, kind `timestamp`. Index: `device_change_log_org_time_idx (org_id, timestamp)` (exists).
- Requirement (`EXPORT_DATASET_REQUIREMENTS.change_log`): `{ permission: { resource: 'devices', action: 'read' }, sensitiveGate: { gate: 'user_account_changes', permission: { resource: 'devices', action: 'execute' } } }`. The base permission comes from `query_change_log` at `aiGuardrails.ts:2082`; the gate comes from spec §4.4 and decision 8, the same permission as the `event_logs` `security_events` gate.

- [ ] **Step 1: Write the failing tests**

```ts
const withGate = (gates: AnalysisSensitiveGate[]) => req({}, { exportGrants: { datasets: ['change_log'], sensitiveGates: gates } });
it('without the gate: user_account rows excluded in SQL and the result says so', async () => {
  const r = withGate([]);
  const { sql } = await firstQuery(changeLogAdapter, r);
  expect(sql).toContain(`"device_change_log"."change_type" <> 'user_account'`);
  expect(r.notes).toEqual([USER_ACCOUNT_CHANGES_NOTE]);
});
it('legacy grants (the original seven, no gates) hold no gate', async () => {
  const r = req({}, { exportGrants: { datasets: ['event_logs', 'agent_logs', 'device_inventory', 'software_inventory', 'metrics', 'vulnerabilities', 'custom_fields'], sensitiveGates: [] } });
  expect((await firstQuery(changeLogAdapter, r)).sql).toContain(`<> 'user_account'`);
});
it('with the gate: no exclusion and no note', async () => {
  const r = withGate(['user_account_changes']);
  expect((await firstQuery(changeLogAdapter, r)).sql).not.toContain(`'user_account'`);
  expect(r.notes).toEqual([]);
});
it('asking only for user_account without the gate: empty export plus note, no query', async () => {
  const r = req({ changeType: ['user_account'] }, { exportGrants: { datasets: ['change_log'], sensitiveGates: [] } });
  expect(await (await changeLogAdapter.createPager(r))(null)).toEqual({ rows: [], nextCursor: null });
  expect(runExportQuery).not.toHaveBeenCalled();
  expect(r.notes).toEqual([USER_ACCOUNT_CHANGES_NOTE]);
});
it('subject and before/after/details are redacted and cut', async () => {
  const [row] = await allRows(changeLogAdapter, [changeRow({
    subject: `svc password=hunter2 ${'s'.repeat(3000)}`,
    beforeValue: { connectionString: 'Server=x;Password=p', path: 'a' }, afterValue: { token: 't' }, details: { apiKey: 'k' } })]);
  expect(row.subject).not.toContain('hunter2');
  expect(Array.from(row.subject as string).length).toBeLessThanOrEqual(2000);
  expect(row.beforeValue).toBe(JSON.stringify({ connectionString: '[REDACTED]', path: 'a' }));
  expect(row.afterValue).toBe(JSON.stringify({ token: '[REDACTED]' }));
  expect(row.details).toBe(JSON.stringify({ apiKey: '[REDACTED]' }));
});
it('never selects fingerprint', /* sql not contain '"fingerprint"' */);
it('org, device set, default window, keyset, empty set, 181 days', /* the Task 3 set */);
it('requirement carries the gate with the event_logs gate permission', () => {
  expect(EXPORT_DATASET_REQUIREMENTS.change_log).toEqual({
    permission: TOOL_PERMISSIONS.query_change_log,
    sensitiveGate: { gate: 'user_account_changes', permission: { resource: 'devices', action: 'execute' } },
  });
  expect(EXPORT_DATASET_REQUIREMENTS.change_log.sensitiveGate!.permission)
    .toEqual(EXPORT_DATASET_REQUIREMENTS.event_logs.sensitiveGate!.permission);
});
```

(`req(filters, overrides?)` extends W04's helper with an overrides object.)

- [ ] **Step 2: Run, expect FAIL** — `cd apps/api && npx vitest run src/services/aiToolsExportDatasets/changes.test.ts`.
- [ ] **Step 3: Implement** `createChangeLogPager` and the constant. Register the name, adapter and requirement, and add the name to the description and the docs.
- [ ] **Step 4: Run, expect PASS** — the test file, plus `aiToolsExport.registration.test.ts` and W02's `aiToolsExportPermissions` test, whichever file holds `resolveExportGrants`. That test now has a dataset with a gate to resolve: add a case asserting that a ceiling with `devices:read` but not `devices:execute` yields `change_log` in `datasets` and no `user_account_changes` in `sensitiveGates`.
- [ ] **Step 5: Commit** — `git commit -m "feat(ai-export): change_log dataset with user_account_changes gate"`

---

### Task 7: Real-Postgres isolation, gate and paging (Integration Tests)

**Files:**
- Create: `apps/api/src/__tests__/integration/exportDatasetsAlertsPatches.integration.test.ts`

Seed under `withSystemDbAccessContext` with `db-utils.ts` helpers. Org A has sites S1 and S2 and devices A1 (S1) and A2 (S2); org B has device B1. Per device, seed: two device-owned alerts and one `topology_site` alert whose `device_id` is A1; `device_patches` rows (one each of `pending`, `installed` and `missing`); a patch job in org A with results for A1 and A2; and change-log rows of type `software` and `user_account`. Auth is an ai_agent run auth (`allowedDeviceIds = runTargets`), and the pager is drained to completion.

- [ ] **Step 1: Write the tests**
  - **non-vacuity:** `current_user` is `breeze_app`, not `rolbypassrls`.
  - **org isolation, per dataset, under two DB contexts:** (a) an org-A context, and (b) a context whose `accessibleOrgIds` is `[A, B]`, which proves the app-layer conditions on their own. In both, with `req.orgId = A` and `runTargets: [A1, A2, B1]`, no row carries B1 or any org-B id.
  - **`patch_attempts` isolation (its own `describe`):**
    1. A job in org B with a result row for device A1 (seeded with system context) is absent under context (b).
    2. A result row in org A's job whose device was moved to org B (`update devices set org_id = B where id = A2`, system context) is absent: A2 left the frame because `exportDeviceSet` reads `org_id = A`.
    3. A whole-device summary row (`patch_id null`) for A1 in org A's job is present.
  - **site restriction through the device set:** `allowedSiteIds: [S1]` → only A1 rows, for every dataset.
  - **empty set:** `runTargets: [B1]` → zero rows for every dataset.
  - **alerts:** the topology-site alert carrying `device_id = A1` is absent.
  - **patch_state:** no `missing` row.
  - **change_log gate:** without `user_account_changes`, no `user_account` row appears and the handler result's `notes` contains `USER_ACCOUNT_CHANGES_NOTE`. With the gate, the `user_account` rows appear. Run this one through the `export_dataset` handler with `createArtifact` reading the stream, so the note path is covered end to end.
  - **paging terminates without repeats:** `pageSize: 1`, three change-log rows and three alerts for A1 with microsecond-distinct times in the same millisecond. Each appears once, and the last cursor is `null`. For `patch_state`, three patches on A1 at `pageSize: 1` → three rows, no repeat.
  - **redaction on stored data:** an alert message containing `password=hunter2` and a URL with `?sig=S` is exported without either (catches a mapper the unit mocks bypassed).
  - **time range:** an alert 31 days old is absent by default and present with `timeRange.start` 35 days back.
- [ ] **Step 2: Run** — `pnpm test-stack up`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/exportDatasetsAlertsPatches.integration.test.ts`. Expected: PASS. **Control:** delete `eq(patchJobs.orgId, req.orgId)` from `patches.ts`, re-run, confirm the `patch_attempts` case 1 goes red under context (b), then restore it.
- [ ] **Step 3: Commit** — `git commit -m "test(ai-export): alerts/patch/change-log isolation, gate and paging on real Postgres"`

---

### Task 8: Description, search hint, docs, legacy runs

**Files:** `apps/api/src/services/aiToolsExport.ts:58,67`, `apps/docs/src/content/docs/features/ai-tools.mdx:450`, `aiToolsExport.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it.each(['alerts', 'patch_state', 'patch_attempts', 'change_log'])('a legacy run (no exportGrants) cannot export %s', async (dataset) => {
  const out = JSON.parse(await getTool().handler({ dataset }, auth, legacyRunContext));
  expect(out.error).toBe('dataset_not_permitted');
});
it('the description states the W05 rules', () => {
  const d = getTool().definition.description;
  for (const s of ['device-owned', 'missing', 'no raw output', 'user_account']) expect(d).toContain(s);
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd apps/api && npx vitest run src/services/aiToolsExport.test.ts`.
- [ ] **Step 3: Rewrite.** Append to W04's description: "alerts are device-owned only (no context); patch_state excludes missing tombstones and is current state; patch_attempts carries no raw output; change_log leaves out user_account changes unless the run holds that permission (the result says so)." Change `searchHint` to `'dataset file exports: logs, inventory, metrics, vulnerabilities, reliability, boot, hardware, service checks, alerts, patches, change log'`. Mirror the change in the docs paragraph.
- [ ] **Step 4: Run, expect PASS** — `npx vitest run src/services/aiToolsExport.test.ts src/services/aiToolsExport.registration.test.ts src/services/aiToolIndex.test.ts src/services/aiTools.descriptionBudget.contract.test.ts src/services/aiTools.domainMetadata.contract.test.ts src/services/aiTools.userOwnedRelease.contract.test.ts`. If a budget bound fails, shorten the text; do not raise the bound.
- [ ] **Step 5: Commit** — `git commit -m "docs(ai-export): describe alerts, patch and change-log datasets"`

---

### Task 9: Wave verification and review

- [ ] **Step 1: Unit suites** — `cd apps/api && npx vitest run src/services/aiToolsExport src/services/aiToolsExportDatasets src/services/aiToolsExportShared src/services/aiToolsExportPermissions`. Confirm the file count includes `aiToolsExportDatasets/alerts.test.ts`, `patches.test.ts` and `changes.test.ts`.
- [ ] **Step 2: Contract suites** — `cd apps/api && npx vitest run src/services/aiToolsSiteScope.contract.test.ts src/services/aiToolsDeviceScope.contract.test.ts src/services/aiTools.deviceAccessSiteScope.contract.test.ts src/services/aiToolsActorParity.contract.test.ts src/__tests__/parkedFanout.contract.test.ts src/db/migrationRlsScope.test.ts src/services/aiTools.userOwnedRelease.contract.test.ts`, then `pnpm -F @breeze/api test:site-scope-coverage`. The three new adapter files must not appear in any baseline or exception list. If a scan flags one, move its `.from(...)` back inside `create<X>Pager`; do not add an exception.
- [ ] **Step 3: Integration and drift** — with the test stack up: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/exportDatasetsAlertsPatches.integration.test.ts src/__tests__/integration/exportDatasetsReliability.integration.test.ts`, then `pnpm db:check-drift` from the repo root. No table or column changed, so the org-cascade and export-policy suites are unaffected.
- [ ] **Step 4: Typecheck** — `NODE_OPTIONS=--max-old-space-size=12288 pnpm exec tsc --build apps/api/tsconfig.tests.json; echo "exit=$?"` → `exit=0`.
- [ ] **Step 5: One independent review round** (high rigor). Use `superpowers:requesting-code-review` on the wave diff, handing the reviewer the code, not this plan's conclusions. Ask specifically for: every selected column of the four tables checked against the "Not exported" lists; every free-text column checked for a redaction call before the cut; the `patch_attempts` org conditions; the gate's SQL and empty paths. Fix the findings, then re-run Steps 1–4. Do not run a second review round unless a fix touched tenancy or the gate.
- [ ] **Step 6: Tear down** — `pnpm test-stack down`. Re-check the migration name against `origin/main` before pushing.
