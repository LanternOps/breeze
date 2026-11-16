---
spec: docs/superpowers/specs/ai-mcp/2026-11-13-wisp-analysis-sessions-design.md
wave_map: docs/superpowers/plans/ai-mcp/2026-11-13-wisp-analysis-sessions-w00-wave-map-and-contracts.md
---

# Wisp Analysis Sessions W04 — Datasets 1 (reliability, boot, hardware, service checks) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six set-based `export_dataset` datasets (`reliability_scores`, `reliability_history`, `reliability_events`, `boot_performance`, `hardware_events`, `service_checks`) plus the shared groundwork W05 reuses: time range, keyset cursor, device set, text redaction, a single dataset list that the Zod enums derive from.

**Architecture:** `services/aiToolsExportDatasets.ts` stays the hub that assembles `DATASET_ADAPTERS`; new adapters live in `services/aiToolsExportDatasets/` and are built from helpers in `services/aiToolsExportShared.ts`. Each adapter resolves the run's frozen device set once (`exportDeviceSet`), then pages one keyset query per page filtered by `device_id = ANY($1::uuid[])`. Adapters never loop over devices. The dataset names move to a zero-import leaf so `aiToolSchemas.ts` and `aiAgentSdkTools.ts` can derive their enums from it without an import cycle.

**Tech Stack:** Hono/TypeScript API, Drizzle (queries only), postgres.js, Vitest, hand-written SQL migration.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-11-13-wisp-analysis-sessions-design.md` §4.3 "Adapter cost at frame size", §4.4, §7 "Datasets" and "Registration". Wave map: W00 contracts C6 (`timeRangeFromFilters`), C8.

**Rigor:** medium (per W00). One migration (indexes only, no tenancy change).

**Consumes (W02, planned in parallel, not in code at plan time):** treat these as existing and extend them:
- `EXPORT_DATASET_REQUIREMENTS` and `resolveExportGrants` in `apps/api/src/services/aiToolsExportPermissions.ts` (C6), typed `Readonly<Record<ExportDataset, …>>`, with a test asserting its keys equal `EXPORT_DATASETS`. Every task that adds a dataset name adds its entry in the same commit, or the record stops typechecking.
- `AnalysisSensitiveGate`, `AiRunExportGrants` and `AiAgentRunStagedInputs.exportGrants` (C2). The handler refuses a dataset outside the frozen grants with `dataset_not_permitted`; absent `exportGrants` means the original seven only.
- `DatasetRequest.exportGrants: AiRunExportGrants` and `DatasetRequest.notes: string[]` (W00 C8; W02 creates both, and the handler copies `notes` into the tool result). W04 adapters push notes through `noteOn` and do not add either field.

## Global Constraints

- No new flag. `export_dataset` already runs only inside an agent run (`aiToolsExport.ts:116-121`); everything stays behind `aiWorkspaceEnabled()` and `wispEnabled()`.
- Dataset names, verbatim (C8): `reliability_scores`, `reliability_history`, `reliability_events`, `boot_performance`, `hardware_events`, `service_checks`. Adapter files: `aiToolsExportDatasets/reliability.ts`, `boot.ts`, `hardware.ts`, `serviceChecks.ts`.
- Set-based: one keyset query per page, filtered by the device set. Never a per-device loop.
- Time range: `filters.timeRange { start, end }` (ISO), default the last 30 days, maximum span 180 days, via `timeRangeFromFilters` (C6); a bad value throws `ExportFilterError('invalid_time_range')`.
- Paging: keyset on `(time column, id)` descending, 500 rows per page (`EXPORT_PAGE_SIZE`, `aiToolsExport.ts:36`). No offset paging, no single-page loads.
- Org from `req.orgId`. Site and device restriction only through the device set. An empty set returns the empty pager and never means unrestricted. None of these tables has `site_id`.
- Redaction is explicit per free-text column (`export_dataset` is `captureExempt`): `redactLogMessage` / `redactLogFields` (`services/logRedaction.ts`). Every free-text cell is cut to 2000 characters, after redaction.
- Each dataset's permission is its equivalent read tool's `TOOL_PERMISSIONS` entry (`services/aiGuardrails.ts`). All six are tier 1. A run principal has no RBAC role: never add a handler-side permission check.
- Migration: hand-written, idempotent, `-- @no-transaction` + `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, no inner `BEGIN`/`COMMIT`. Name it to sort after the newest migration on `origin/main`: re-run `git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -1` before committing (at plan time `2027-01-24-170000-…`; W03 plans `2027-01-25-100000-…`). Migration slots (C8): W03 `2027-01-25-100000-*`, W04 `2027-01-25-110000-*`, W05 `2027-01-25-120000-*`. Whichever wave merges later re-checks the newest migration on `origin/main` and renames its own unshipped file if needed; never rename a shipped one. Then `pnpm db:check-drift`.
- Tests beside source. One file: `cd apps/api && npx vitest run <path>`. Never `pnpm --filter <pkg> test -- --run <path>`. Red first.
- Typecheck: 12 GB heap, check the exit code, never pipe to `tail`.
- A new `services/` file that reads `devices` needs a `parkedFanout.contract.test.ts` classification.
- `reliabilityScoring.ts` reads as binary to plain `grep`: use `rg -a`.

## Review Focus

1. **A run admitted before W02 (no `exportGrants`) asks for a new dataset.** Expect `dataset_not_permitted`: legacy means the original seven, not "everything in `EXPORT_DATASETS`". Pinned in Task 12.
2. **Two rows share a millisecond but differ in microseconds across a page boundary.** Expect no row repeated or skipped: the cursor carries `col::text`, never a JS `Date`. Pinned in Task 2 (helper) and Task 11 (real Postgres).
3. **A 5000-device frame.** Expect the page query to bind the set as one `uuid[]` parameter and return only in-frame rows. Pinned in Task 11.
4. **A malformed reliability history row** (`crash_events` stored as an object, an event with no `timestamp`). Expect counts of 0 / rows with `timestamp: null`, not a 500. Pinned in Tasks 6 and 7.
5. **CSV output of `reliability_events`.** The writer takes the CSV header from the first row's keys (`aiToolsExportWriter.ts` `serialise`), so every event class must emit the same keys in the same order. Pinned in Task 7.

---

## File map

| File | Change |
|---|---|
| `apps/api/src/services/aiToolsExportDatasetNames.ts` | **Create.** Zero-import leaf: `EXPORT_DATASETS`, `ExportDataset`. |
| `apps/api/src/services/aiToolsExportDatasets.ts` | Re-export the names from the leaf; register the six adapters in `DATASET_ADAPTERS` (586-594). |
| `apps/api/src/services/aiToolsExportShared.ts` | **Create.** `ExportFilterError`, `timeRangeFromFilters`, cursor and keyset helpers, `keysetPager`, `runExportQuery`, `deviceIdIn`, `exportDeviceSet`, `exportText`, `exportJsonText`. |
| `apps/api/src/services/aiToolsExportDatasets/{reliability,boot,hardware,serviceChecks}.ts` | **Create.** Adapters. |
| `apps/api/src/services/reliabilityScoring.ts` | Add `reliabilityExportPageQuery` (reuses `reliabilityListWhere`, 1978) and export `reliabilityEventKey`. |
| `apps/api/src/services/aiToolsExport.ts` | Map `ExportFilterError`; description and `searchHint`. |
| `apps/api/src/services/aiToolSchemas.ts:2198`, `aiAgentSdkTools.ts:3718` | `z.enum(EXPORT_DATASETS)`. |
| `apps/api/src/services/aiToolsExportPermissions.ts` (W02) | Six entries. |
| `apps/api/migrations/2027-01-25-110000-export-dataset-reliability-indexes.sql` | **Create.** Three indexes. |
| `apps/api/src/db/schema/{devices,hardwareHealth,serviceProcessMonitoring}.ts` | Mirror the indexes. |
| `apps/api/src/services/__testutils__/aiToolScopeScan.ts`, `aiToolsSiteScope.contract.test.ts`, `aiToolsDeviceScope.contract.test.ts`, `__tests__/parkedFanout.contract.test.ts` | Scan the adapter directory; register `exportDeviceSet`; classify the shared file. |
| `apps/docs/src/content/docs/features/ai-tools.mdx:450` | Dataset list. |

## Why these indexes, and the `inArray` question

**Device-set binding.** A frame is at most 5000 devices (`analysisMaxFrameDevices` ceiling, C3). Drizzle `inArray` renders `IN ($1 … $5000)`: legal (the protocol cap is 65535 binds), but it re-sends 5000 parameters on every page, and each distinct frame size is a new statement text in postgres.js's prepared-statement cache. Adapters use `deviceIdIn(column, ids)` = ``sql`${column} = ANY(${sql.param([...ids])}::uuid[])` ``: one bind parameter whatever the frame size. Precedent run against real Postgres: `services/alertLifecycle/cursor.ts:47`, exercised by `__tests__/integration/alertRearm.integration.test.ts:209`. Do not use a bare `${ids}` interpolation (Drizzle expands it to a row tuple, `db/sqlValues.ts:100-106`). `uuid = ANY(uuid[])` is leakproof, so it stays an index condition under forced RLS. The one exception is `reliability_scores`, which reuses `reliabilityListWhere` (its `inArray` serves other callers and stays): at most 5000 rows, so at most 11 pages.

**Ordering.** Time-descending order keeps a truncated export meaningful: it keeps the newest rows across all devices instead of dropping whole devices. An index led by `(device_id, time)` cannot produce that order across many devices, so each page would re-gather and re-sort every remaining row (quadratic over the export). Each time-ordered dataset therefore needs an `(org_id, time DESC, id DESC)`-shaped index:

| Dataset | Index used | Decision |
|---|---|---|
| `reliability_history`, `reliability_events` | `reliability_history_org_collected_idx (org_id, collected_at)` | exists; ties on `collected_at` are rare (incremental sort on `id`) |
| `reliability_scores` | PK `device_reliability(device_id)` | exists; snapshot, keyset on `device_id` ascending |
| `boot_performance` | **new** `device_boot_metrics_org_boot_idx (org_id, boot_timestamp DESC, id DESC)` | small table, but rows carry the wide `startup_items` jsonb, which makes a per-page top-N sort expensive |
| `hardware_events` | **new** `device_hardware_events_org_occurred_idx (org_id, occurred_at DESC, id DESC)` | the existing `occurred_at` index is cross-tenant: a sparse org would walk every org's rows |
| `service_checks` | **new partial** `spc_results_org_problem_ts_idx (org_id, "timestamp" DESC, id DESC) WHERE status <> 'running'` | the table is one row per watch per tick. A comment in `migrations/2026-07-29-timeseries-retention-brin.sql:24` quotes an EXPLAIN plan with a planner row estimate of about 41M rows; which database and date it came from is not recorded there, and no one measured the table for this plan. A full index at that size is roughly 1.6 GB: an unmeasured estimate (41M × ~40 bytes per entry). v1 exports **non-running checks only** (see Task 10) |

Every keyset predicate also emits the redundant bound `col <= $t`, so the planner can use the index's time column even where the index does not carry `id`.

---

### Task 1: One dataset list; Zod enums derive from it

**Files:**
- Create: `apps/api/src/services/aiToolsExportDatasetNames.ts`
- Modify: `apps/api/src/services/aiToolsExportDatasets.ts:62-66`, `aiToolSchemas.ts:2198`, `aiAgentSdkTools.ts:3718`
- Test: `apps/api/src/services/aiToolsExport.registration.test.ts`

**Interfaces:**
- Produces: `EXPORT_DATASETS` (readonly tuple) and `ExportDataset` exported from `aiToolsExportDatasetNames.ts` and re-exported unchanged from `aiToolsExportDatasets.ts`. Why a leaf: `aiTools.ts:15` imports `aiToolSchemas`, and `aiToolsExportDatasets.ts` reaches `aiTools` through `aiToolsFleet`. A value import from the hub into `aiToolSchemas.ts` would close a cycle that `z.enum(...)` evaluates at module load (temporal dead zone).

- [ ] **Step 1: Write the failing drift tests** (append to `aiToolsExport.registration.test.ts`)

```ts
import { readFileSync } from 'node:fs';
import { EXPORT_DATASETS } from './aiToolsExportDatasets';
import { DATASET_ADAPTERS } from './aiToolsExportDatasets';
import { EXPORT_DATASET_REQUIREMENTS } from './aiToolsExportPermissions';

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('export_dataset dataset lists cannot drift', () => {
  it('both Zod enums derive from EXPORT_DATASETS', () => {
    expect(toolInputSchemas.export_dataset!.shape.dataset.options).toEqual([...EXPORT_DATASETS]);
    for (const file of ['./aiToolSchemas.ts', './aiAgentSdkTools.ts']) {
      expect(src(file)).toContain('dataset: z.enum(EXPORT_DATASETS)');
      expect(src(file)).not.toMatch(/dataset: z\.enum\(\['event_logs'/);
    }
  });
  it('adapters, requirements, description and docs name every dataset', () => {
    expect(Object.keys(DATASET_ADAPTERS).sort()).toEqual([...EXPORT_DATASETS].sort());
    expect(Object.keys(EXPORT_DATASET_REQUIREMENTS).sort()).toEqual([...EXPORT_DATASETS].sort());
    const description = aiTools.get('export_dataset')!.definition.description;
    const docs = src('../../../docs/src/content/docs/features/ai-tools.mdx');
    for (const name of EXPORT_DATASETS) {
      expect(description).toContain(name);
      expect(docs).toContain(`\`${name}\``);
    }
  });
});
```

(`toolInputSchemas.export_dataset` is a `z.object`; the `shape` access may need a cast to `z.ZodObject<…>`, as other registration tests do.)

- [ ] **Step 2: Run, expect FAIL** — `cd apps/api && npx vitest run src/services/aiToolsExport.registration.test.ts`. Expected: the first test fails because neither block contains `z.enum(EXPORT_DATASETS)`.
- [ ] **Step 3: Implement.** Move the tuple into the leaf, re-export it from the hub (`export { EXPORT_DATASETS, type ExportDataset } from './aiToolsExportDatasetNames';`, plus a local import for use), and replace both literal enums with `z.enum(EXPORT_DATASETS)`, importing from the leaf.
- [ ] **Step 4: Run, expect PASS** — the same command, plus `npx vitest run src/services/aiToolsExport.test.ts src/services/aiToolsExportDatasets.test.ts`.
- [ ] **Step 5: Commit** — `git commit -m "refactor(ai-export): one dataset list; Zod enums derive from it, drift test"`

---

### Task 2: Shared pure helpers — time range, cursor, keyset pager, text cut

**Files:**
- Create: `apps/api/src/services/aiToolsExportShared.ts`
- Test: `apps/api/src/services/aiToolsExportShared.test.ts`

**Interfaces (Produces, all exported from `aiToolsExportShared.ts`):**
```ts
export class ExportFilterError extends Error { constructor(readonly code: 'invalid_time_range' | 'invalid_filter', message: string) }
export const EXPORT_TIME_RANGE_DEFAULT_DAYS = 30;
export const EXPORT_TIME_RANGE_MAX_DAYS = 180;
export const EXPORT_TEXT_MAX_CHARS = 2000;
export function timeRangeFromFilters(filters: Record<string, unknown>, now?: () => Date): { start: Date; end: Date }; // C6 (+ injectable clock)
export type KeyPart = 'timestamp' | 'timestamptz' | 'uuid';
export function encodeExportCursor(key: readonly string[]): string;                        // base64url JSON array
export function decodeExportCursor(cursor: string | null, shape: readonly KeyPart[]): string[] | null; // throws Error on a shape mismatch (internal cursor: a bug, not user input)
export function keysetBefore(tsCol: AnyColumn, idCol: AnyColumn, after: string[] | null, kind: 'timestamp' | 'timestamptz'): SQL | undefined;
export function keysetAfterIds(cols: readonly AnyColumn[], after: string[] | null): SQL | undefined;
export function keysetPager<R>(opts: { pageSize: number; shape: readonly KeyPart[]; fetch: (after: string[] | null, limit: number) => Promise<R[]>; keyOf: (row: R) => string[]; toRows: (rows: R[]) => Array<Record<string, unknown>> }): ExportPager;
export function cutExportText(text: string): string;
export function exportText(value: unknown, opts?: { urls?: boolean; paths?: boolean }): string | null;
export function exportJsonText(value: unknown, opts?: { urls?: boolean; paths?: boolean }): string | null;
```

Decisions the signatures do not settle:
- `timeRangeFromFilters`. Absent → `[now−30d, now]`. `end` only → `[end−30d, end]`. `start` only → `[start, now]`. A non-object `timeRange`, an unparseable value, `start > end`, or a span over 180 days → throw `ExportFilterError('invalid_time_range', …)`. The message names the limit.
- `keysetBefore(kind = 'timestamp')` returns ``sql`(${ts} <= ${t}::timestamp AND (${ts}, ${id}) < (${t}::timestamp, ${i}::uuid))` ``. For `timestamptz`, cast to `::timestamptz`. The text comes from `col::text`. That is the Q1 rule in `aiToolPagination.ts:13-25`: never round-trip through a JS `Date`.
- `decodeExportCursor` validates each part: `timestamp` `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$`; `timestamptz` the same plus `([+-]\d{2}(:\d{2}){0,2})?$`; `uuid` the `UUID_RE` of `aiToolPagination.ts:49`. A value that fails never reaches a cast.
- `keysetPager` fetches `pageSize + 1`. It emits the first `pageSize` rows through `toRows`, sets `nextCursor = encodeExportCursor(keyOf(rows[pageSize-1]))` only when more than `pageSize` came back, and `null` otherwise.
- `cutExportText` counts code points (`Array.from`), so it never splits a surrogate pair. Text over 2000 code points becomes the first 1994 plus `…[cut]` (2000 in total).
- `exportText`: null/undefined → `null`; non-string → `String(value)`. Order: `scrubUrlsInText` (when `urls`), then `redactLogMessage`, or `redactAgentLogMessage` when `paths` (that adds the user-profile, home-path, UNC-host and IP value shapes, `logRedaction.ts:420-440`), then `cutExportText`. Redaction runs before the cut, so a secret straddling the cut is never half-emitted.
- `exportJsonText`: null → `null`. Otherwise `redactLogFields`, or `redactAgentLogFields` when `paths`, then `scrubUrlsInValue` when `urls`, then `JSON.stringify`, then `cutExportText`. JSON free-text columns are emitted as strings (≤2000 chars) so CSV and JSONL carry the same type.

- [ ] **Step 1: Write the failing tests**

```ts
const NOW = new Date('2026-11-13T12:00:00.000Z');
const now = () => NOW;
it('timeRange defaults to the last 30 days', () => {
  expect(timeRangeFromFilters({}, now)).toEqual({ start: new Date('2026-10-14T12:00:00.000Z'), end: NOW });
});
it('timeRange accepts exactly 180 days and refuses 180 days + 1 ms', () => {
  const end = '2026-11-13T00:00:00.000Z';
  expect(() => timeRangeFromFilters({ timeRange: { start: '2026-05-17T00:00:00.000Z', end } }, now)).not.toThrow();
  expect(() => timeRangeFromFilters({ timeRange: { start: '2026-05-16T23:59:59.999Z', end } }, now))
    .toThrow(expect.objectContaining({ code: 'invalid_time_range' }));
});
it.each([[{ timeRange: 'last week' }], [{ timeRange: { start: 'nope' } }], [{ timeRange: { start: '2026-11-02T00:00:00Z', end: '2026-11-01T00:00:00Z' } }]])(
  'timeRange refuses %j', (filters) => {
    expect(() => timeRangeFromFilters(filters, now)).toThrow(ExportFilterError);
  });
it('end-only range spans 30 days back from end', () => {
  expect(timeRangeFromFilters({ timeRange: { end: '2026-11-01T00:00:00.000Z' } }, now).start)
    .toEqual(new Date('2026-10-02T00:00:00.000Z'));
});
it('keysetBefore renders the bound and the row comparison at full precision', () => {
  const q = new PgDialect().sqlToQuery(keysetBefore(deviceChangeLog.timestamp, deviceChangeLog.id,
    ['2026-11-13 10:00:00.123456', '00000000-0000-4000-8000-000000000001'], 'timestamp')!);
  expect(q.sql).toMatch(/<= \$1::timestamp AND \(.*\) < \(\$2::timestamp, \$3::uuid\)/);
  expect(q.params[0]).toBe('2026-11-13 10:00:00.123456');
});
it('decodeExportCursor refuses a value that would reach a cast malformed', () => {
  expect(() => decodeExportCursor(encodeExportCursor(['2026-11-13T10:00:00Z', 'x']), ['timestamp', 'uuid'])).toThrow();
});
it('keysetPager terminates, never repeats a row, and over-fetches by one', async () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const all = [9, 8, 7, 6, 5, 4, 3].map((n) => ({ id: id(n) }));              // desc order
  const fetch = vi.fn(async (after: string[] | null, limit: number) =>
    all.filter((r) => !after || r.id < after[0]!).slice(0, limit));
  const pager = keysetPager({ pageSize: 3, shape: ['uuid'], fetch, keyOf: (r) => [r.id], toRows: (rs) => rs });
  const pages = []; let cursor: string | null = null;
  do { const p = await pager(cursor); pages.push(p); cursor = p.nextCursor; } while (cursor);
  expect(pages.flatMap((p) => p.rows)).toEqual(all);
  expect(pages).toHaveLength(3);
  expect(fetch.mock.calls.every(([, limit]) => limit === 4)).toBe(true);
});
it('keysetPager: an exact multiple of pageSize ends without an extra empty page', async () => {
  /* 6 rows, pageSize 3 → 2 pages, second nextCursor null */
});
```

Also:

```ts
it('exportText redacts before it cuts, and cuts at 2000 code points', () => {
  const secret = `${'x'.repeat(1990)} password=hunter2`;
  const out = exportText(secret)!;
  expect(out).not.toContain('hunter2');
  expect(Array.from(out).length).toBeLessThanOrEqual(2000);
  expect(Array.from(exportText('😀'.repeat(2500))!)).toHaveLength(2000);
});
it('exportText paths option drops a profile user name', () => {
  expect(exportText('C:\\Users\\jdoe\\AppData\\x.exe', { paths: true })).not.toContain('jdoe');
});
it('exportJsonText redacts secret keys and is a string', () => {
  expect(exportJsonText({ token: 'abc', path: 'ok' })).toBe(JSON.stringify({ token: '[REDACTED]', path: 'ok' }));
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd apps/api && npx vitest run src/services/aiToolsExportShared.test.ts`. Expected: module not found.
- [ ] **Step 3: Implement the signatures above.** `keysetBefore` for `timestamp` may delegate its row comparison to `keysetWhereCondition` (`aiToolPagination.ts:255`) and add the `<=` bound.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ai-export): shared time range, keyset cursor, pager and text redaction helpers"`

---

### Task 3: Device set, query seam, handler wiring, contract-scan registration

**Files:**
- Modify: `apps/api/src/services/aiToolsExportShared.ts`, `aiToolsExportDatasets.ts:68-80`, `aiToolsExport.ts:155-229`
- Modify: `apps/api/src/services/__testutils__/aiToolScopeScan.ts:335-339`, `aiToolsSiteScope.contract.test.ts:154-165` and `:440-446`, `aiToolsDeviceScope.contract.test.ts:194-205`, `apps/api/src/__tests__/parkedFanout.contract.test.ts:120`
- Test: `aiToolsExportShared.test.ts`, `aiToolsExport.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ExportDeviceScope { deviceIds: string[]; hostnames: ReadonlyMap<string, string> }
export async function exportDeviceSet(req: DatasetRequest): Promise<ExportDeviceScope>;
export function deviceIdIn(column: AnyColumn, ids: readonly string[]): SQL;     // throws on []; callers short-circuit
export async function runExportQuery<T>(query: PromiseLike<T[]>): Promise<T[]>; // the single await point; unit tests mock it and read query.toSQL()
export const emptyExportPager: ExportPager;
export function noteOn(req: DatasetRequest, note: string): void;  // pushes onto req.notes (W02 field, C8) unless already present
```
- `exportDeviceSet` rules, in order:
  1. `req.auth.orgId !== req.orgId` → throw (same rule as `agentInventoryPager`, `aiToolsExportDatasets.ts:142-146`).
  2. No frame (`runTargets` null or empty) → empty. A new dataset never exports org-wide.
  3. Intersect the candidates: frame ∩ `req.deviceIds` (when non-null; `[]` → empty) ∩ `req.auth.allowedDeviceIds` (when defined).
  4. `req.siteId` that `req.auth.canAccessSite` rejects → empty.
  5. No candidates left → empty, with no query.
  6. One query: `select id, site_id, hostname from devices where org_id = req.orgId and deviceIdIn(devices.id, candidates) [and site_id = req.siteId]`.
  7. Drop rows where `deviceSiteDenied(req.auth, row.siteId, row.id)`.

  Its own body must name `allowedDeviceIds` and `deviceSiteDenied` directly. The contract scans credit a delegate only when its own body names a marker (`guardedLocalHelpers`, `aiToolScopeScan.ts:123-132`); a transitive call does not count.
- **Contract-scan rule for adapter files:** `aiToolsSources()` lists only top-level `aiTools*.ts`. This task extends it to `aiToolsExportDatasets/*.ts`. A table call is attributed to its enclosing *named* function (`windowStarts`, `aiToolScopeScan.ts:303-309`). So in every adapter, the `.from(<table>)` must sit lexically inside the `async function create<X>Pager(req)` that calls `exportDeviceSet(req)`, inside an inline arrow passed to `keysetPager`. Never extract it into a named helper.

- [ ] **Step 1: Write the failing tests**

In `aiToolsExportShared.test.ts` (mock `../db` like `aiToolsExportDatasets.test.ts:22-28`):
```ts
it.each([[null], [[]]])('exportDeviceSet: no frame (%j) is empty and queries nothing', async (runTargets) => {
  expect((await exportDeviceSet({ ...req, runTargets })).deviceIds).toEqual([]);
  expect(dbSelect).not.toHaveBeenCalled();
});
it('exportDeviceSet: an empty requested list is empty, never unrestricted', async () => {
  expect((await exportDeviceSet({ ...req, deviceIds: [] })).deviceIds).toEqual([]);
});
it('exportDeviceSet: intersects frame, requested ids and allowedDeviceIds, then drops site-denied rows', async () => {
  mockDevices([{ id: 'd1', siteId: 's1', hostname: 'h1' }, { id: 'd2', siteId: 's2', hostname: 'h2' }]);
  const scope = await exportDeviceSet({ ...req, runTargets: ['d1', 'd2', 'd3'], deviceIds: ['d1', 'd2'],
    auth: { ...agentAuth, allowedDeviceIds: ['d1', 'd2'], allowedSiteIds: ['s1'], canAccessSite: (s: string) => s === 's1' } });
  expect(scope.deviceIds).toEqual(['d1']);
  expect(scope.hostnames.get('d1')).toBe('h1');
});
it('exportDeviceSet: throws when the principal org is not the request org', async () => {
  await expect(exportDeviceSet({ ...req, orgId: 'org-other' })).rejects.toThrow(/organization/i);
});
it('deviceIdIn binds the whole set as ONE uuid[] parameter', () => {
  const ids = Array.from({ length: 5000 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
  const q = new PgDialect().sqlToQuery(deviceIdIn(devices.id, ids));
  expect(q.sql).toBe('"devices"."id" = ANY($1::uuid[])');
  expect(q.params).toEqual([ids]);
});
```

In `aiToolsExport.test.ts`:
```ts
it('maps ExportFilterError to its code, not export_failed', async () => {
  createPager.mockRejectedValue(new ExportFilterError('invalid_time_range', 'timeRange spans more than 180 days'));
  const out = JSON.parse(await getTool().handler({ dataset: 'event_logs' }, auth));
  expect(out).toEqual({ error: 'invalid_time_range', message: 'timeRange spans more than 180 days' });
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd apps/api && npx vitest run src/services/aiToolsExportShared.test.ts src/services/aiToolsExport.test.ts`. Expected: `exportDeviceSet` is not exported; `export_failed` is returned instead of `invalid_time_range`.
- [ ] **Step 3: Implement.** Handler: add a catch branch `error instanceof ExportFilterError → { error: error.code, message: error.message }` above the generic branch.
- [ ] **Step 4: Register with the contract scans.**
  - `aiToolsSources()`: append the non-test `.ts` files of `SERVICES_DIR/aiToolsExportDatasets`, as `aiToolsExportDatasets/<file>`, when the directory exists.
  - Add `['exportDeviceSet', 'aiToolsExportShared.ts']` to `CROSS_FILE_GUARDED_DELEGATES` in both `aiToolsSiteScope.contract.test.ts` and `aiToolsDeviceScope.contract.test.ts`, each with a one-line reason ("resolves the export's device set through the frozen frame, `allowedDeviceIds` and `deviceSiteDenied`; behaviour pinned by `aiToolsExportShared.test.ts`").
  - Update the `'aiToolsExport.ts:export_dataset'` comment (`aiToolsSiteScope.contract.test.ts:440-446`) to name the adapter directory and `exportDeviceSet`.
  - Add `'services/aiToolsExportShared.ts': 'read model: export_dataset device set — reads only devices already frozen into an analysis run frame, under the caller ceiling; selects no fan-out targets'` to `VISIBILITY_MODULES` (`parkedFanout.contract.test.ts:120`).
- [ ] **Step 5: Run, expect PASS** — the two files from Step 2 plus `npx vitest run src/services/aiToolsSiteScope.contract.test.ts src/services/aiToolsDeviceScope.contract.test.ts src/services/aiTools.deviceAccessSiteScope.contract.test.ts src/services/aiToolsActorParity.contract.test.ts src/__tests__/parkedFanout.contract.test.ts`.
- [ ] **Step 6: Commit** — `git commit -m "feat(ai-export): run-frame device set, ANY(uuid[]) binding and typed filter errors"`

---

### Task 4: Index migration

**Files:**
- Create: `apps/api/migrations/2027-01-25-110000-export-dataset-reliability-indexes.sql`
- Modify: `apps/api/src/db/schema/devices.ts:895-900`, `hardwareHealth.ts:27-30`, `serviceProcessMonitoring.ts:22-26`

**Interfaces:**
- Produces: `device_boot_metrics_org_boot_idx`, `device_hardware_events_org_occurred_idx`, `spc_results_org_problem_ts_idx`, exactly as in the table under "Why these indexes". The partial predicate is the literal `status <> 'running'`. Task 10's query must contain the same literal, not a bound parameter, or the planner cannot prove it implies the index predicate.

- [ ] **Step 1: Write the migration** following `migrations/2027-01-23-130000-history-retention-indexes.sql`: a first line `-- @no-transaction`, a header comment giving each index's reason (copy the table rows above), three `CREATE INDEX CONCURRENTLY IF NOT EXISTS public.…` statements, and the closing `DO $$` block that raises when any of the three is `INVALID`. No row writes, so no `set_config('breeze.scope', …)`.
- [ ] **Step 2: Run the drift check, expect FAIL** — with the test stack up (`pnpm test-stack up`) and its `DATABASE_URL` exported: `pnpm db:migrate && pnpm db:check-drift`. Expected: drift reports three indexes missing from the Drizzle schema.
- [ ] **Step 3: Mirror them in the schema** — e.g. `index('device_boot_metrics_org_boot_idx').on(table.orgId, table.bootTimestamp.desc(), table.id.desc())`, and for the partial index `.where(sql\`${table.status} <> 'running'\`)`.
- [ ] **Step 4: Run, expect PASS** — `pnpm db:check-drift`; `cd apps/api && npx vitest run src/db/migrationRlsScope.test.ts`; `scripts/check-migration-naming.sh --staged` after staging.
- [ ] **Step 5: Commit** — `git commit -m "perf(db): org/time indexes for reliability export datasets"`

---

### Task 5: `reliability_scores`

**Files:**
- Modify: `apps/api/src/services/reliabilityScoring.ts` (beside `listReliabilityDevices`, 2024)
- Create: `apps/api/src/services/aiToolsExportDatasets/reliability.ts`
- Modify: `aiToolsExportDatasetNames.ts`, `aiToolsExportDatasets.ts` (`DATASET_ADAPTERS`), `aiToolsExportPermissions.ts`
- Test: `apps/api/src/services/aiToolsExportDatasets/reliability.test.ts`

**Spec for this adapter:**
- Source: `device_reliability` ⋈ `devices`, reusing the tool's own builder, `reliabilityListWhere(filter)` (`reliabilityScoring.ts:1978`, exported by this task). The spec says "reuse `listReliabilityDevices`", but that function pages by offset, caps `limit` at 100 and returns only the 30-day columns. This adapter widens the builder instead, per the hub's own rule (`aiToolsExportDatasets.ts:4-9`).
- Columns: `deviceId, hostname, siteId, osType, status, computedAt, reliabilityScore, uptimeScore, crashScore, hangScore, serviceFailureScore, hardwareErrorScore, uptime7d, uptime30d, uptime90d, crashCount7d, crashCount30d, crashCount90d, hangCount7d, hangCount30d, hangCount90d, serviceFailureCount7d, serviceFailureCount30d, hardwareErrorCount7d, hardwareErrorCount30d, mtbfHours, trendDirection, trendConfidence, provisional, topIssues`. `topIssues` is server-built (`ReliabilityTopIssue[]`, no free text). `details` is not exported.
- Keyset: `device_id` ascending (snapshot, one row per device), on the PK. No time column: `timeRange` does not apply. When one was supplied it is still validated, and the adapter pushes the note `reliability_scores is current state; timeRange was not applied.`
- Device set: `filter.deviceIds = scope.deviceIds` (its `inArray` stays — ≤5000 binds, ≤11 pages).
- Redaction: none. No free-text column.
- Permission (`EXPORT_DATASET_REQUIREMENTS.reliability_scores`): `{ resource: 'devices', action: 'read' }`, from `get_fleet_health` at `aiGuardrails.ts:2313`.

**Interfaces:**
- Produces: `export function reliabilityExportPageQuery(filter: ReliabilityListFilter, afterDeviceId: string | null, limit: number)`, which returns the un-awaited Drizzle query, and `export const reliabilityScoresAdapter: DatasetAdapter` (`tier: 1, deviceScoped: false`).

- [ ] **Step 1: Write the failing tests.** Mocks: `../../db` → `{ db: drizzle.mock() }` from `drizzle-orm/postgres-js`, as in `restorePointInline.test.ts:13`, plus the context helpers `aiToolsExportDatasets.test.ts:22-28` mocks; partial-mock `../aiToolsExportShared` so that `exportDeviceSet` and `runExportQuery` are spies. Helpers shared by every adapter test in this wave: `req(filters)` = `{ auth: agentAuth, orgId: 'org-1', filters, deviceIds: null, runTargets: ['d1', 'd2'], siteId: null, pageSize: 500, notes: [], exportGrants: { datasets: [...EXPORT_DATASETS], sensitiveGates: [] } }`; `scope(ids)` = `{ deviceIds: ids, hostnames: new Map(ids.map((d) => [d, \`h-${d}\`])) }`; `allRows(adapter, fixtures, r?)` drains the pager with `runExportQuery` resolving `fixtures`.

```ts
it('reads the frame through reliabilityListWhere, keyset on device_id, pageSize+1', async () => {
  exportDeviceSet.mockResolvedValue(scope(['d1', 'd2']));
  runExportQuery.mockResolvedValue([]);
  await (await reliabilityScoresAdapter.createPager(req({})))(null);
  const { sql, params } = (runExportQuery.mock.calls[0]![0] as { toSQL(): { sql: string; params: unknown[] } }).toSQL();
  expect(sql).toContain('"device_reliability"."org_id" = $');
  expect(params).toEqual(expect.arrayContaining(['org-1', 'd1', 'd2', 501]));
  expect(sql).toMatch(/order by "device_reliability"."device_id" asc/i);
});
it('empty device set yields nothing and runs no query', async () => {
  exportDeviceSet.mockResolvedValue(scope([]));
  expect(await (await reliabilityScoresAdapter.createPager(req({})))(null)).toEqual({ rows: [], nextCursor: null });
  expect(runExportQuery).not.toHaveBeenCalled();
});
it('second page starts strictly after the last device id', async () => { /* pageSize 1, two fixture rows; assert the 2nd toSQL has `"device_id" > $` with the first id */ });
it('validates timeRange and notes that it does not apply', async () => {
  const r = req({ timeRange: { start: '2026-01-01T00:00:00Z', end: '2026-11-01T00:00:00Z' } });
  await expect(reliabilityScoresAdapter.createPager(r)).rejects.toMatchObject({ code: 'invalid_time_range' });
  const ok = req({ timeRange: { start: '2026-10-01T00:00:00Z' } });
  exportDeviceSet.mockResolvedValue(scope(['d1'])); await reliabilityScoresAdapter.createPager(ok);
  expect(ok.notes).toEqual(['reliability_scores is current state; timeRange was not applied.']);
});
it('row carries every window and the hostname from the device set', async () => { /* fixture row → expect exact key list above, hostname 'h-d1' */ });
```

- [ ] **Step 2: Run, expect FAIL** — `cd apps/api && npx vitest run src/services/aiToolsExportDatasets/reliability.test.ts`. Expected: module not found.
- [ ] **Step 3: Implement** the reader (same `select` as `listReliabilityDevices` plus the 7d/90d and factor-score columns, `.where(and(reliabilityListWhere(filter), after ? gt(deviceReliability.deviceId, after) : undefined))`, `.orderBy(asc(deviceReliability.deviceId)).limit(limit)`), the adapter (validate `timeRangeFromFilters` first, then `exportDeviceSet`, then `keysetPager` with shape `['uuid']`), the dataset name, the `DATASET_ADAPTERS` entry and the requirement entry.
- [ ] **Step 4: Run, expect PASS** — the test file, plus `src/services/aiToolsExport.registration.test.ts`, plus the existing `reliabilityScoring*.test.ts` files (list them with `rg -a -l reliabilityScoring src/services | grep test`). The registration test fails until the tool description (`aiToolsExport.ts:67`) and the docs list (`ai-tools.mdx:450`) name the dataset. Add the bare name to both now and leave the wording to Task 12. **Tasks 6–10 do the same for their dataset.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ai-export): reliability_scores dataset"`

---

### Task 6: `reliability_history`

**Files:** `aiToolsExportDatasets/reliability.ts`, `reliability.test.ts`, the names leaf, the hub, the requirements.

**Spec for this adapter:**
- Source: `device_reliability_history`.
- Columns: `id, deviceId, hostname, collectedAt, bootTime, uptimeSeconds, crashCount, appHangCount, serviceFailureCount, hardwareErrorCount`. Each count is `CASE WHEN jsonb_typeof(col) = 'array' THEN jsonb_array_length(col) ELSE 0 END` in SQL; a bare `jsonb_array_length` raises on a non-array. Not exported: the four raw arrays and `raw_metrics`.
- Time column: `collected_at`. Keyset `(collected_at, id)` desc, kind `timestamp`, key text `collected_at::text`. Index: `reliability_history_org_collected_idx (org_id, collected_at)`.
- Filter: `org_id = req.orgId AND deviceIdIn(device_id, scope.deviceIds) AND collected_at BETWEEN start AND end`.
- Redaction: none (counts and timestamps only).
- Permission: `devices:read` (`get_fleet_health`, `aiGuardrails.ts:2313`).

- [ ] **Step 1: Write the failing tests**

```ts
it('one keyset query: org, device set as one uuid[] param, 30-day default window, desc order', async () => {
  const { sql, params } = await firstQuery(reliabilityHistoryAdapter, req({}));
  expect(sql).toMatch(/"org_id" = \$\d+/);
  expect(sql).toMatch(/"device_id" = ANY\(\$\d+::uuid\[\]\)/);
  expect(params).toContainEqual(['d1']);
  expect(sql).toMatch(/order by .*"collected_at" desc, .*"id" desc/i);
  expect(params).toContain(new Date('2026-10-14T12:00:00.000Z').toISOString()); // fake timers at NOW
});
it('counts are guarded against a non-array jsonb', async () => {
  const { sql } = await firstQuery(reliabilityHistoryAdapter, req({}));
  expect(sql).toContain("jsonb_typeof");
});
it('cursor carries collected_at::text and the next page uses keysetBefore', async () => { /* pageSize 1; row { collectedAtText: '2026-11-01 10:00:00.123456', id }; 2nd toSQL contains `<= $n::timestamp AND (` and params include that text */ });
it('empty device set → empty pager, no query', /* as Task 5 */);
it('a 181-day range is refused before any query', /* rejects code invalid_time_range; runExportQuery not called */);
```

(`firstQuery(adapter, req)` is a test helper: mock `exportDeviceSet` → `scope(['d1'])`, `runExportQuery` → `[]`, call the pager once, return `runExportQuery.mock.calls[0][0].toSQL()`. Use `vi.useFakeTimers().setSystemTime(NOW)`.)

- [ ] **Step 2: Run, expect FAIL** — `cd apps/api && npx vitest run src/services/aiToolsExportDatasets/reliability.test.ts` → `reliabilityHistoryAdapter` undefined.
- [ ] **Step 3: Implement** `createReliabilityHistoryPager(req)`, with the `.from(deviceReliabilityHistory)` inside its arrow (Task 3 scan rule). Add the name, adapter and requirement.
- [ ] **Step 4: Run, expect PASS** — the test file and `aiToolsExport.registration.test.ts`.
- [ ] **Step 5: Commit** — `git commit -m "feat(ai-export): reliability_history dataset"`

---

### Task 7: `reliability_events`

**Files:** `reliabilityScoring.ts` (export the key), `aiToolsExportDatasets/reliability.ts`, `reliability.test.ts`, names, hub, requirements.

**Spec for this adapter:**
- Source: `device_reliability_history`. The arrays `crash_events`, `app_hangs`, `service_failures` and `hardware_errors` (shapes at `db/schema/reliability.ts:7-35`) are flattened in JS, one row per array element. Non-array values and non-object elements are skipped.
- Columns, **identical keys and order for every class** (CSV header comes from the first row): `historyId, deviceId, hostname, collectedAt, eventClass, eventType, timestamp, name, severity, errorCode, eventId, duration, recovered, detail, eventKey`.

| `eventClass` | `eventType` | `name` | `severity` | `errorCode` | `eventId` | `duration` | `recovered` | `detail` |
|---|---|---|---|---|---|---|---|---|
| `crash` | `type` | null | null | null | null | null | null | `details` → `exportJsonText(…, { paths: true })` |
| `app_hang` | null | `processName` | null | null | null | `duration` | `resolved` | null |
| `service_failure` | null | `serviceName` | null | `errorCode` | null | null | `recovered` | null |
| `hardware_error` | `type` | `source` | `severity` | null | `eventId` | null | null | null |

- Redaction: `name`, `errorCode` and `eventId` go through `exportText(v, { paths: true })`, because this is agent-collected text, like agent logs. `detail` uses `exportJsonText(…, { paths: true })`. `eventType`, `severity`, `duration` and `recovered` are enumerated or numeric and are type-checked: a value of the wrong type becomes `null`.
- Duplicates: agents re-send an overlapping last-50 window, so one event can appear in several history rows (`reliabilityScoring.ts:811-815`; that code comment reports ~1.37× inflation "in prod", which this plan did not re-measure). Each row carries `eventKey = reliabilityEventKey(class, event)`, the same key scoring dedups on (`reliabilityScoring.ts:826-850`, exported by this task as `export function reliabilityEventKey(eventClass: 'crash' | 'app_hang' | 'service_failure' | 'hardware_error', event: unknown): string`). The adapter pushes the note `reliability_events can list one event more than once; drop duplicates on eventKey.`
- Time: SQL `collected_at BETWEEN start AND end` (index `reliability_history_org_collected_idx`). In JS, keep an event whose own `timestamp` parses and lies in `[start, end]`. An event whose timestamp does not parse is kept, with `timestamp: null`.
- Keyset: on the history row, `(collected_at, id)` desc. A page reads `Math.max(1, Math.floor(req.pageSize / 10))` history rows (50 at the default 500; one row can hold up to 200 events), so a default page emits at most 10,000 events.
- Permission: `devices:read` (`get_fleet_health`).

- [ ] **Step 1: Write the failing tests**

```ts
const history = { id: H1, deviceId: 'd1', collectedAt: new Date('2026-11-10T00:00:00Z'), collectedAtText: '2026-11-10 00:00:00',
  crashEvents: [{ type: 'bsod', timestamp: '2026-11-09T01:00:00Z', details: { dump: 'C:\\Users\\jdoe\\x.dmp', token: 't' } }],
  appHangs: [{ processName: 'C:\\Users\\jdoe\\app.exe', timestamp: '2026-11-09T02:00:00Z', duration: 30, resolved: true }],
  serviceFailures: [{ serviceName: 'Spooler', timestamp: 'garbage', errorCode: 'password=hunter2', recovered: false }],
  hardwareErrors: { not: 'an array' } };
it('flattens every class with one key set, in order', async () => {
  const rows = await allRows(reliabilityEventsAdapter, [history]);
  expect(rows.map((r) => r.eventClass)).toEqual(['crash', 'app_hang', 'service_failure']);
  for (const r of rows) expect(Object.keys(r)).toEqual(EVENT_KEYS);
});
it('redacts each free-text column', async () => {
  const [crash, hang, svc] = await allRows(reliabilityEventsAdapter, [history]);
  expect(crash.detail).not.toContain('jdoe'); expect(crash.detail).not.toContain('"t"');
  expect(hang.name).not.toContain('jdoe');
  expect(svc.errorCode).not.toContain('hunter2');
  expect(svc.timestamp).toBeNull();
});
it('drops an event outside the window by its own timestamp', /* crash at 2026-01-01 → absent */);
it('carries the scoring dedup key and notes it', async () => {
  const r = req({}); const rows = await allRows(reliabilityEventsAdapter, [history, { ...history, id: H2 }], r);
  expect(rows[0]!.eventKey).toBe(rows[3]!.eventKey);
  expect(r.notes).toContain('reliability_events can list one event more than once; drop duplicates on eventKey.');
});
it('reads pageSize/10 history rows per page (limit 51 at pageSize 500)', /* toSQL params contain 51 */);
```

- [ ] **Step 2: Run, expect FAIL** — `cd apps/api && npx vitest run src/services/aiToolsExportDatasets/reliability.test.ts`.
- [ ] **Step 3: Implement** `reliabilityEventKey` (switch over the four existing private key functions) and `createReliabilityEventsPager`. Register the name, adapter and requirement.
- [ ] **Step 4: Run, expect PASS** — the test file, `aiToolsExport.registration.test.ts`, and the existing `reliabilityScoring*.test.ts` (find them with `rg -a -l`).
- [ ] **Step 5: Commit** — `git commit -m "feat(ai-export): reliability_events dataset"`

---

### Task 8: `boot_performance`

**Files:** Create `aiToolsExportDatasets/boot.ts` and `boot.test.ts`; names, hub, requirements.

**Spec for this adapter:**
- Source: `device_boot_metrics` (`db/schema/devices.ts:883`).
- Columns: `id, deviceId, hostname, bootTimestamp, biosSeconds, osLoaderSeconds, desktopReadySeconds, totalBootSeconds, startupItemCount, startupItems`.
- `startupItems` is a JSON **array**, not a string: a whole list is far over 2000 characters, and cutting it would leave invalid JSON. It keeps the 100 items with the highest `impactScore`. Each item is `{ itemId, name, type, path, enabled, cpuTimeMs, diskIoBytes, impactScore }`, with `name` → `exportText(v)` and `path` → `exportText(v, { paths: true })`. Each leaf is therefore ≤2000 characters and has user-profile segments removed.
- Time column: `boot_timestamp`. Keyset `(boot_timestamp, id)` desc, kind `timestamp`. Index: **new** `device_boot_metrics_org_boot_idx` (Task 4).
- Filter: org, `deviceIdIn`, time range.
- Permission: `devices:read`, from `analyze_boot_performance` at `aiGuardrails.ts:2087`.

- [ ] **Step 1: Write the failing tests**, the Task 6 set adapted (org / ANY param / default window / desc order / keyset / empty set / 181 days refused), plus:

```ts
it('redacts startup item paths and names and keeps the top 100 by impact', async () => {
  const items = Array.from({ length: 150 }, (_, n) => ({ name: `svc${n} password=p`, type: 'service',
    path: `C:\\Users\\jdoe\\s${n}.exe`, enabled: true, cpuTimeMs: 1, diskIoBytes: 1, impactScore: n }));
  const [row] = await allRows(bootPerformanceAdapter, [{ ...bootRow, startupItems: items }]);
  expect(row.startupItems).toHaveLength(100);
  expect((row.startupItems as Array<{ impactScore: number }>)[0]!.impactScore).toBe(149);
  expect(JSON.stringify(row.startupItems)).not.toMatch(/jdoe|password=p/);
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd apps/api && npx vitest run src/services/aiToolsExportDatasets/boot.test.ts`.
- [ ] **Step 3: Implement** `createBootPerformancePager`, and register the name, adapter and requirement.
- [ ] **Step 4: Run, expect PASS** — the test file and `aiToolsExport.registration.test.ts`.
- [ ] **Step 5: Commit** — `git commit -m "feat(ai-export): boot_performance dataset"`

---

### Task 9: `hardware_events`

**Files:** Create `aiToolsExportDatasets/hardware.ts` and `hardware.test.ts`; names, hub, requirements.

**Spec for this adapter:**
- Source: `device_hardware_events e LEFT JOIN device_hardware_components c ON c.device_id = e.device_id AND c.component_key = e.component_key AND c.org_id = e.org_id` (unique `device_hardware_components_device_key_uidx`).
- Columns: `id, deviceId, hostname, occurredAt, componentKey, componentType, componentName, model, serial, firmware, eventType, fromHealth, toHealth, fromState, toState, detail`.
- Redaction: `exportText(v, { paths: true })` for `componentKey`, `componentName`, `model`, `serial`, `firmware`, `fromState` and `toState` (agent-reported text); `detail` (jsonb) → `exportJsonText(v, { paths: true })`. The enum columns pass through.
- Time column: `occurred_at` (**timestamptz**). Keyset `(occurred_at, id)` desc, kind `timestamptz`, key text `e.occurred_at::text`. Index: **new** `device_hardware_events_org_occurred_idx`.
- Filter: `e.org_id = req.orgId`, `deviceIdIn(e.device_id, …)`, time range.
- Permission: `devices:read`, from `get_device_hardware_health` at `aiGuardrails.ts:1637`.

- [ ] **Step 1: Write the failing tests**: the Task 6 set, plus:

```ts
it('keyset casts the cursor to timestamptz for a timestamptz column', async () => { /* 2nd page toSQL contains '::timestamptz' and param '2026-11-01 10:00:00.5+00' */ });
it('joins the component on device, key and org', async () => {
  const { sql } = await firstQuery(hardwareEventsAdapter, req({}));
  expect(sql).toMatch(/left join "device_hardware_components" .*"component_key".*"org_id"/i);
});
it('redacts state and detail text', /* toState 'Failed (user=jdoe)' → not contain jdoe; detail { secret:'x' } → [REDACTED] */);
```

- [ ] **Step 2: Run, expect FAIL** — `cd apps/api && npx vitest run src/services/aiToolsExportDatasets/hardware.test.ts`.
- [ ] **Step 3: Implement** `createHardwareEventsPager`, and register the name, adapter and requirement.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ai-export): hardware_events dataset"`

---

### Task 10: `service_checks`

**Files:** Create `aiToolsExportDatasets/serviceChecks.ts` and `serviceChecks.test.ts`; names, hub, requirements.

**Spec for this adapter:**
- Source: `service_process_check_results` (`db/schema/serviceProcessMonitoring.ts:8`).
- Rows: **non-running checks only**, ``sql`${t.status} <> 'running'` `` as a literal so the partial index applies. This narrows the spec's "one per check": running rows are the bulk of the table (a planner estimate of ~41M rows, see "Why these indexes"), have no usable index, and would truncate any export to the last few hours. Stated in the description (Task 12) and in a fixed note: `service_checks lists checks that were not running (stopped, not_found, error); running checks are not exported.`
- Columns: `id, deviceId, hostname, timestamp, watchType, name, status, cpuPercent, memoryMb, pid, autoRestartAttempted, autoRestartSucceeded`. `details` (jsonb) is not exported.
- Redaction: `name` → `exportText(v)` (a watch name configured by the admin).
- Time column: `timestamp`. Keyset `(timestamp, id)` desc, kind `timestamp`. Index: **new partial** `spc_results_org_problem_ts_idx`.
- Permission: `devices:read`, from `get_service_monitoring_status` at `aiGuardrails.ts:2438`.

- [ ] **Step 1: Write the failing tests**: the Task 6 set, plus:

```ts
it('excludes running checks with the literal the partial index is built on', async () => {
  const { sql, params } = await firstQuery(serviceChecksAdapter, req({}));
  expect(sql).toContain(`"status" <> 'running'`);
  expect(params).not.toContain('running');
});
it('never selects details', async () => {
  expect((await firstQuery(serviceChecksAdapter, req({}))).sql).not.toContain('"details"');
});
it('notes the running-check exclusion', /* r.notes contains the fixed sentence */);
```

- [ ] **Step 2: Run, expect FAIL** — `cd apps/api && npx vitest run src/services/aiToolsExportDatasets/serviceChecks.test.ts`.
- [ ] **Step 3: Implement** `createServiceChecksPager`, and register the name, adapter and requirement.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(ai-export): service_checks dataset (non-running checks)"`

---

### Task 11: Real-Postgres isolation and paging (Integration Tests)

**Files:**
- Create: `apps/api/src/__tests__/integration/exportDatasetsReliability.integration.test.ts`

Seed with `createPartner` / `createOrganization` / `createSite` / `createDevice` (`__tests__/integration/db-utils.ts`) under `withSystemDbAccessContext`. Org A has sites S1 and S2 with devices A1 (S1) and A2 (S2); org B has device B1. Seed two rows per dataset per device, plus the extra rows named below. Run every adapter as `breeze_app` under `withDbAccessContext({ scope: 'organization', orgId: A, accessibleOrgIds: [A], … })`, with an ai_agent run auth: `principal.kind 'ai_agent'`, `allowedDeviceIds = runTargets`. Drain the pager to completion.

- [ ] **Step 1: Write the tests** (`describe.each` over the six datasets where the shape allows):
  - **non-vacuity:** `select current_user, rolbypassrls` → `breeze_app`, `false` (pattern: `accounting-connections-rls.integration.test.ts:57-66`).
  - **org isolation:** `runTargets: [A1, A2, B1]` → no row carries `B1`. B1 is in no org-A query result, because `exportDeviceSet` reads `devices` with `org_id = A` and RLS hides B.
  - **site restriction through the device set:** `allowedSiteIds: [S1]`, `canAccessSite: s => s === S1` → only `A1` rows.
  - **empty set:** `runTargets: [B1]` → zero rows.
  - **paging terminates without repeats:** `pageSize: 1`, three rows for A1 whose time values share a millisecond and differ in microseconds (`'2026-11-01 10:00:00.123001'`, `…123002`, `…123003`, inserted with ``sql`…::timestamp` ``). All three appear once, in desc order, and the last page's `nextCursor` is `null`.
  - **5000-device frame:** `runTargets` = A1 plus 4999 random UUIDs → A1's rows only; the statement does not error.
  - **time range:** a row 31 days old is absent by default and present with `timeRange: { start: <35 days ago> }`.
- [ ] **Step 2: Run** — `pnpm test-stack up`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/exportDatasetsReliability.integration.test.ts`. Expected: PASS. A failure here is a real defect in Tasks 3–10. Fix that task's code, not the test. **Control:** temporarily delete the `deviceIdIn(...)` condition from `boot.ts`, re-run, confirm the org-isolation or site test goes red, then restore it.
- [ ] **Step 3: Commit** — `git commit -m "test(ai-export): reliability datasets isolation and keyset paging on real Postgres"`

---

### Task 12: Tool description, search hint, docs, legacy runs

**Files:**
- Modify: `apps/api/src/services/aiToolsExport.ts:58` and `:67`, `apps/docs/src/content/docs/features/ai-tools.mdx:450`
- Test: `aiToolsExport.test.ts`

- [ ] **Step 1: Write the failing test** (in `aiToolsExport.test.ts`, using the legacy-run context shape W02's `dataset_not_permitted` tests in this file use: a run whose frozen inputs carry no `exportGrants`)

```ts
it.each(['reliability_scores', 'reliability_history', 'reliability_events', 'boot_performance', 'hardware_events', 'service_checks'])(
  'a legacy run (no exportGrants) cannot export %s', async (dataset) => {
    const out = JSON.parse(await getTool().handler({ dataset }, auth, legacyRunContext));
    expect(out.error).toBe('dataset_not_permitted');
    expect(createPager).not.toHaveBeenCalled();
  });
it('the description names the time range rule and the snapshot datasets', () => {
  const d = getTool().definition.description;
  expect(d).toContain('timeRange'); expect(d).toContain('180 days'); expect(d).toContain('reliability_scores is current state');
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd apps/api && npx vitest run src/services/aiToolsExport.test.ts`. The description test fails. If the legacy test also fails, W02 computed "legacy" from `EXPORT_DATASETS`: stop and raise it with the orchestrator rather than patching W02's resolver here.
- [ ] **Step 3: Rewrite.** Description: "Export a complete dataset as a file handle without read-tool compaction. Datasets: event_logs, agent_logs, device_inventory, software_inventory, metrics, vulnerabilities, custom_fields, reliability_scores, reliability_history, reliability_events, boot_performance, hardware_events, service_checks. The new datasets take filters.timeRange {start,end} (ISO; default last 30 days, at most 180 days); reliability_scores is current state; service_checks lists non-running checks; reliability_events can repeat an event (dedupe on eventKey). metrics, vulnerabilities and custom_fields read device by device and may end truncated on a large frame. Use workspace_stage to stage the handle." `searchHint`: `'dataset file exports: logs, inventory, metrics, vulnerabilities, reliability, boot, hardware, service checks'`. Make the same additions to the docs paragraph.
- [ ] **Step 4: Run, expect PASS** — `npx vitest run src/services/aiToolsExport.test.ts src/services/aiToolsExport.registration.test.ts src/services/aiToolIndex.test.ts src/services/aiTools.descriptionBudget.contract.test.ts src/services/aiTools.domainMetadata.contract.test.ts src/services/aiTools.userOwnedRelease.contract.test.ts`. If a per-domain index bound fails, shorten the `searchHint`; do not raise the bound.
- [ ] **Step 5: Commit** — `git commit -m "docs(ai-export): describe the reliability datasets and time range"`

---

### Task 13: Wave verification

- [ ] **Step 1: Unit suites** — `cd apps/api && npx vitest run src/services/aiToolsExport src/services/aiToolsExportDatasets src/services/aiToolsExportShared src/services/reliabilityScoring`. Check that the reported file count includes the `aiToolsExportDatasets/` directory (the filter is a substring match).
- [ ] **Step 2: Contract suites** — `cd apps/api && npx vitest run src/services/aiToolsSiteScope.contract.test.ts src/services/aiToolsDeviceScope.contract.test.ts src/services/aiTools.deviceAccessSiteScope.contract.test.ts src/services/aiToolsActorParity.contract.test.ts src/__tests__/parkedFanout.contract.test.ts src/db/migrationRlsScope.test.ts src/services/aiTools.userOwnedRelease.contract.test.ts`, then `pnpm -F @breeze/api test:site-scope-coverage`.
- [ ] **Step 3: Integration and drift** — with the test stack up: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/exportDatasetsReliability.integration.test.ts`, then from the repo root `pnpm db:check-drift`. No table or column was added, so the org-cascade and export-policy suites are not affected. Leave them to CI's Integration Tests job.
- [ ] **Step 4: Typecheck** — from the repo root `NODE_OPTIONS=--max-old-space-size=12288 pnpm exec tsc --build apps/api/tsconfig.tests.json; echo "exit=$?"`. Expected `exit=0`.
- [ ] **Step 5: Tear down** — `pnpm test-stack down`. Re-check the migration name against `origin/main` before pushing.
