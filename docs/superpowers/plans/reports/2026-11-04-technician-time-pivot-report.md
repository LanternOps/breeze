---
tracking_issue:
roadmap_issue: LanternOps/breeze#11017
spec: none (track:plan; decisions in "Design" below)
waves: W1 API + shared + PDF (one PR) · W2 web + docs + E2E (one PR)
blast_radius: medium (reads partner-wide time at partner scope; one enum-only migration; no new table, column, route or job)
verified_against: main @ 36f9d9ca53 (2026-11-04)
status: plan-drafted
---

# Technician Time Pivot Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `technician_time_pivot` business report. Rows are technicians, columns are work types, cells are hours, and every row, column and grand total is filled in. It can be split per customer, scheduled monthly, and exported to CSV, XLSX and PDF.

**Architecture:** One new `REPORT_GENERATORS` entry (`audience: 'msp_staff'`, `ORG_OR_PARTNER`). It runs inside a single `runInReportScope` block over `time_entries`, using a tenancy predicate and `entries` CTE that W1 extracts from the existing `technician_time_billability` generator, so both types share one fence. Postgres aggregates integer minutes. The generator builds a column set that reads the same every month and emits **wide** `rows` (the pivot table itself, which is what CSV/XLSX and scheduled attachments serialize). The sparse matrix and the totals go in `summary` for the designed PDF.

**Tech Stack:** Hono + Drizzle (raw `sql`, bound params), zod v4, Vitest (Drizzle-mock unit + `vitest.integration.config.ts`), jsPDF + jspdf-autotable (`packages/shared/src/reportPdf`), Astro + React islands, Playwright (`data-testid` only).

**Spec:** none. This is a track:plan item. The template for every per-type surface is the shipped Business Reports Phase 2 plan, `docs/superpowers/plans/reports/2026-10-23-business-reports-phase-2.md` §1.1 ("Per-type surface checklist"). Executors read §1.1 and §1.4 (CI traps) there. This plan says only where the new type differs.

---

## Design

### What already exists (verified @ `36f9d9ca53`)

| Need from #11017 | State on `main` | Gap |
|---|---|---|
| Custom report builder can do it ("can we do our own reports?") | `apps/web/src/components/reports/ReportBuilder.tsx:51`: builder sources are `devices \| alerts \| patches \| compliance \| activity` only. `groupBy`/`aggregation` is a **client-side, single-axis** preview fold (`:1232-1263`) with no column axis and no totals. | **Not expressible.** No time-entry source, no second axis, no totals. Extending the builder into a general pivot engine is a far larger project and still would not cover scheduling or a designed PDF. |
| Time data | All labour is in `time_entries` (`apps/api/src/db/schema/timeTracking.ts:26`): ticket time (`ticket_id`), contract/block-hours time (`contract_line_id`, `billing_status = 'contract'`) and standalone time. `work_type_id` → `work_types` (partner-owned, `unique (partner_id, lower(name))`, `sort_order`, `is_active`). The billability split is `coverage`, with a fallback to `is_billable` (`effectiveCoverageSql`, `businessReports/common.ts`). | None. No second time table, so no UNION. |
| A time report on the reports engine | `technician_time_billability` (`businessReports/technicianTimeReport.ts`) groups by **one** axis (`technician \| organization \| work_type`) and adds an overall total, with period, partner/org scope, coverage split and money. Its `rows` are **per-entry detail** (capped at 5,000). | No cross-tab. Its CSV is a list of entries, not a pivot. |
| Monthly scheduling + delivery | Business types support `schedule = 'monthly'`, `period.kind = 'last_full_month'` (`packages/shared/src/validators/businessReports.ts:25`) and delivery to `config.emailRecipients` only (`PARTNER_ONLY_DELIVERY_REPORT_TYPES`, `routes/reports/schemas.ts:57`). The scheduled email attaches `rowsToCsv(rows)` or `buildReportPdf` (`services/reportDelivery.ts:144-183`). | None. A new type inherits all of it. |
| Per-customer fan-out via multi-org series | `assertSeriesTypeSupported` refuses every `msp_staff` type (`reportSeries/validation.ts:35`). | Not used (see D6). |

### Decisions

- **D1. New report type `technician_time_pivot`. No new option on `technician_time_billability`.** Adding `pivotBy` to the existing type would make `result.rows` mean either detail entries or the wide pivot depending on config, and CSV/XLSX, scheduled CSV, the generic PDF fallback, AI `generate_report` output and run history would all have to branch on it. A separate type keeps one rows contract per type, as Phase 2 did with its one-question-per-type pattern. *Rejected:* extending the existing type (above); extending the builder (table above). *Quorum:* codex (gpt-6-astra, xhigh) agreed.
- **D2. Fixed axes: rows = technician, columns = work type, optional `splitBy: 'organization'` sections.** This matches the ask. Single-axis views stay in `technician_time_billability`. *Rejected:* configurable row/column axes. YAGNI, and it would widen the CSV contract.
- **D3. Hours only, no money.** A commission pivot counts hours. Money with no FX would need a currency dimension in every cell. Billable value stays in `technician_time_billability`.
- **D4. Measure:** `measure: 'logged' | 'billable' | 'included' | 'non_billable'`, default `logged`. Every measure sums `duration_minutes` (time worked) filtered by effective coverage. It never uses post-rounding `billable_minutes`, which keeps the pivot consistent with the sibling type's billable % definition. `summary` stores all four per cell; `rows` print the chosen one. `approvedOnly` (default false) adds `te.is_approved`.
- **D5. Column set that reads the same every month:** the owner partner's **active** work types, plus **inactive** work types referenced by qualifying entries, plus `Unassigned` (always present, last). Order: `sort_order, lower(name), id`. Every column appears on every row, zeros included, so `extractTable` (first-row keys, `packages/shared/src/utils/csvExport.ts:72`) sees all of them.
- **D6. "Monthly per customer" means:** (a) one org-owned definition per customer, or (b) one partner-owned definition with `splitBy: 'organization'`, which gives one artifact with a section per customer plus all-customer totals. Both run on `schedule: 'monthly'` + `last_full_month`. Delivery stays internal (`emailRecipients`). *Rejected:* opening multi-org series to `msp_staff` types, which would reverse ruling F1 (`reportSeries/validation.ts:29`) and needs its own decision.
- **D7. Org filter = ownership.** Org-owned covers one customer; partner-owned covers all active/trial customers. *Rejected for v1:* an `orgIds` subset selector at partner scope. Business configs refuse org selectors (`BUSINESS_SELECTOR_REFUSALS`, `reportConfigSchemas.ts:208`, ruling T3e). Codex suggested a subset selector intersected with the live allowlist. That is recorded as follow-up F1 and not built here.
- **D8. Internal (org-less) time:** included at partner scope. With `splitBy: 'organization'` it gets its own section labelled `Internal (no organization)`; without a split it counts in the totals, with a note. At org scope it is excluded (the predicate already does this).
- **D9. Rounding:** aggregates are integer minutes. A cell's hours come from the one labour helper, `laborHundredths(minutes) / 100` (`packages/shared/src/utils/laborMath.ts:30`, which agrees with PG `ROUND(m::numeric/60, 2)`), computed independently from that cell's minutes (totals too), so printed cells may not add exactly to printed totals. A fixed note says so. Never write the formula inline: `laborAmount.routing.test.ts` (#9561) fails on any `* 100 / 60` copy.
- **D10. Cap:** `rows` are capped at `BUSINESS_DETAIL_ROW_CAP` (5,000) data rows. Totals rows always come from SQL over every qualifying entry and are always appended. Truncation is recorded in `summary.detail` and a note. *Codex disagreed* and wanted an explicit failure instead. Kept as is because siblings share the convention and a row is a (customer, technician) pair, so 5,000 is far above realistic partner sizes. The Review Focus line 3 test proves the totals stay complete.
- **D11. Grants:** `BUSINESS_REPORT_REQUIRED_PERMISSIONS.technician_time_pivot = [TIME_ENTRIES_READ]`. The pivot exposes no ticket fields, unlike the sibling's detail rows, so `TICKETS_READ` is not needed.
- **D12. Known shared limitation, not fixed here:** `last_full_month` resolves from generation time, not the scheduled occurrence, for every business type (`businessReports/period.ts:242`). A run delayed past month end would cover the wrong month. Follow-up F2.

### Rule 9 / tenancy statement (for both PR bodies)

No setting is added (report config only). No new table, column, route or job. There are therefore **no** RLS migration, **no** `CORE_ORG_CASCADE_DELETE_ORDER` / `orgMergeRegistry.ts` / `CORE_TENANT_EXPORT_POLICY` rows, **no** `rls-coverage` entry and **no** `workerReadinessManifest.ts` entry. `reports.config` is an existing `jsonb` column already classified `excludedOpen`. Proof in the PR: `git diff origin/main --stat -- apps/api/src/db/schema apps/api/migrations` shows only the enum line and the enum migration.

## Global Constraints

- Type id `technician_time_pivot`. Label `Technician time`. PDF title `Technician Time`. Audience `msp_staff`, `ORG_OR_PARTNER`, `execution: 'user'`, `detailRowCap: BUSINESS_DETAIL_ROW_CAP`.
- Never portal-visible: add to `NEVER_PORTAL_VISIBLE` (`apps/portal/src/components/portal/ReportRunList.tsx`). Never in `MANAGED_EVIDENCE_REGISTRY` / `PORTAL_DEFINITIONS`.
- Config: `technicianTimePivotConfigSchema = legacyReportConfigSchema.extend({ ...BUSINESS_SELECTOR_REFUSALS, period, measure, splitBy, approvedOnly })`, all `.optional()`, **no `.default()`**. The generator applies the defaults `last_full_month` / `logged` / `none` / `false`.
- Every statement carries `timeEntryScopePredicate(scope)` (Task 1.1), and `work_types` reads carry `wt.partner_id = <owner partner>`. RLS is the backstop, not the fence. Bound params only (`sqlUuidArray`, `sqlTimestamp`).
- Running timers (`ended_at IS NULL`) are excluded. Period membership is by `started_at` in the owner timezone (`resolveReportOwnerTimezone` + `resolveReportPeriod`), exactly as the sibling does.
- Site-restricted authority returns `emptyTechnicianTimePivotSummary(SITE_RESTRICTED_NOTE)` from both the generator and the dispatcher `case`.
- `REPORT_TYPES` order = enum order. Append at the end of `REPORT_TYPES` **and** `BUSINESS_REPORT_TYPES`. The enum value, tuple entry and registry entry land in one commit.
- Every new `en` locale key lands in all 8 locales (`en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`). New controls carry `data-testid`. No new mutation handler.
- AI exposure is inherited through `BUSINESS_REPORT_TYPES` → `GENERATE_REPORT_TYPES` (`services/aiReportTypes.ts`). No edit to AI write sites. Extend the enumerated lists in `aiToolsFleet.reportAudience.test.ts` (`BUSINESS` at `:483`; the time-entries-gated list at `:382`) and `aiToolSchemasFleet.test.ts`.
- Public repo: no customer names, hostnames or infra in code, fixtures, docs or PR text. Say "a design-partner MSP".

## Review Focus

1. **A work type named `Total`, `Technician`, `Unassigned` or `2024`.** Expected: its column survives with a distinct header, no column overwrites another, and column order stays as designed. JS orders integer-like keys first, so a bare `"2024"` key would jump to the front of `Object.keys`. Test `pivotColumnHeaders de-collides reserved and integer-like names` (Task 1.2).
2. **A work type deactivated mid-month that still has hours.** Expected: its column is present and the grand total reconciles to the sum of all entries. Test `inactive work type with qualifying time keeps its column` (Task 1.3, plus the integration test in Task 1.5).
3. **More than 5,000 (customer, technician) pairs.** Expected: `rows` hold 5,000 data rows plus complete totals rows, `detail.truncated = true`, and a note. Test `cap truncates data rows but never totals` (Task 1.3).
4. **A partner-scope split where a technician logged time for two customers and internal time.** Expected: three sections; the technician appears in each; each section's totals reconcile; the grand total equals the sum of the sections. Test `splitBy organization reconciles sections to grand total` (Task 1.3, plus integration in Task 1.5).
5. **An org-owned definition whose technician also worked for another customer.** Expected: only this org's minutes; no internal section; no other org's labels in `rows` or `summary`. Test `org scope never leaks other orgs or internal time` (Task 1.5, real Postgres).

---

## File structure

| File | Responsibility | Wave |
|---|---|---|
| `apps/api/src/services/businessReports/timeEntryScope.ts` (new) | `timeEntryScopePredicate`, `qualifyingEntriesCte`: the one time-entries fence, shared by both time reports | W1 |
| `apps/api/src/services/businessReports/technicianTimeReport.ts` | switch to the shared module (behaviour-preserving) | W1 |
| `packages/shared/src/utils/pivotTable.ts` (new) | pure: `minutesToHours`, `pivotColumnHeaders`, `buildPivotRows`, shared by the generator and tests | W1 |
| `apps/api/src/services/businessReports/technicianTimePivotReport.ts` (new) | SQL + assembly | W1 |
| `packages/shared/src/types/businessReports.ts` | `TechnicianTimePivotSummary` + `emptyTechnicianTimePivotSummary` | W1 |
| `packages/shared/src/reportPdf/technicianTimePivotPdf.ts` (new) | designed PDF | W1 |
| `apps/web/src/components/reports/TechnicianTimePivotOptionsForm.tsx` (new) | options form | W2 |

---

## W1: API, shared types, PDF (one PR)

Depends on nothing. Branch: `feature/<parent#>-technician-time-pivot/wave-<sub#>` (feature-lifecycle). The type becomes reachable through the API, MCP and AI `generate_report` and is delivered by schedule. W2 adds the web UI. Until W2 lands, `ReportsList` shows runs through the generic arms, and the summary unions are widened here so nothing is dropped.

### Task 1.1: Extract the shared time-entries fence (behaviour-preserving)

**Files:**
- Create: `apps/api/src/services/businessReports/timeEntryScope.ts`, `timeEntryScope.test.ts`
- Modify: `apps/api/src/services/businessReports/technicianTimeReport.ts` (delete the local `entryScopePredicate`, `:92-98`; build its `entries` CTE from `qualifyingEntriesCte`; move `PARTNER_NO_ORGS_NOTE` (`:59`) to `businessReports/common.ts` so the pivot reuses it). Its `const MONEY = ` block must stay in that file: `laborAmount.routing.test.ts:75` anchors on it.

**Interfaces:**
- Produces:
```ts
export function timeEntryScopePredicate(scope: ReportScope): SQL; // moved verbatim
export function qualifyingEntriesCte(
  scope: ReportScope,
  period: ResolvedReportPeriod,
  opts?: { approvedOnly?: boolean },
): SQL; // `entries AS (SELECT te.id, te.user_id, te.org_id, te.work_type_id, te.started_at, te.duration_minutes,
        //   te.billable_minutes, te.hourly_rate, te.currency_code, te.billing_status, te.is_approved,
        //   <effectiveCoverageSql> AS eff_coverage FROM time_entries te WHERE <predicate> AND ended_at IS NOT NULL
        //   AND started_at in [start,end) [AND te.is_approved])`. Body only, no leading WITH.
```

- [ ] **Step 1: Characterization first.** Run `cd apps/api && npx vitest run src/services/businessReports/technicianTimeReport.test.ts`. Expected: PASS (baseline).
- [ ] **Step 2: Write the failing test** `timeEntryScope.test.ts`, which compiles with `PgDialect.sqlToQuery` (same harness as `technicianTimeReport.test.ts:1-30`):
  - `partner scope binds partner_id and the org allowlist, admits org-less rows`. SQL contains `te.partner_id = $1` and `te.org_id IS NULL OR te.org_id = ANY(`; params contain the partner id and the org array.
  - `org scope resolves the partner in-statement`. SQL contains `(SELECT o.partner_id FROM organizations o WHERE o.id =`, and no bound partner id.
  - `approvedOnly adds is_approved, default omits it`.
  - `running timers excluded`. SQL contains `te.ended_at IS NOT NULL`.
- [ ] **Step 3: Run it.** Expected: FAIL (module missing).
- [ ] **Step 4: Implement** by moving code. `technicianTimeReport.ts`'s `baseCte` becomes `sql\`WITH ${qualifyingEntriesCte(scope, period)}, techs AS (...), roster AS (...)\``.
- [ ] **Step 5: Run both files.** Expected: PASS, with `technicianTimeReport.test.ts` **unchanged**. A changed assertion means the extraction changed behaviour, so revert and redo it.
- [ ] **Step 6: Commit** `refactor(reports): share the time_entries tenancy fence between time reports (#11017)`.

### Task 1.2: Pure pivot helpers

**Files:**
- Create: `packages/shared/src/utils/pivotTable.ts`, `pivotTable.test.ts`. Export them from the shared barrel (`packages/shared/src/index.ts`).

**Interfaces:**
- Produces:
```ts
export function minutesToHours(minutes: number): number; // laborHundredths(minutes) / 100, via laborMath.ts, never an inline formula
export const PIVOT_RESERVED_HEADERS: readonly ['Row type', 'Customer', 'Technician', 'Total'];
/** One header per column, in input order: label as-is unless it equals (case-insensitive) a reserved
 *  header, another emitted header, or is integer-like (/^\d+$/); then append " (work type)", then
 *  " (work type 2)", " (work type 3)"... until unique. The Unassigned column's label is "Unassigned"
 *  and wins over a real work type named "unassigned" (the real one is suffixed). */
export function pivotColumnHeaders(columns: readonly { key: string; label: string; workTypeId: string | null }[]): string[];
export type PivotRowType = 'technician' | 'subtotal' | 'total';
export function buildPivotRows(input: {
  splitByOrganization: boolean;
  headers: readonly string[];               // from pivotColumnHeaders, same order as columnKeys
  columnKeys: readonly string[];
  sections: readonly TechnicianTimePivotSection[]; // Task 1.3 type
  grandColumnTotals: Readonly<Record<string, number>>; grandTotal: number; // minutes of the chosen measure
  measure: TechnicianTimePivotMeasure;
  cap: number;
}): { rows: Record<string, string | number>[]; truncated: boolean; available: number };
```
Row shape, in key-insertion order: `Row type`, then `Customer` (split only), then `Technician`, then one key per header (hours), then `Total`. Every row carries every column, so zeros are `0`. A split emits, per section, its technician rows and then one `subtotal` row (`Technician = 'Total'`). The output always ends with one `total` row (`Customer = 'All customers'` when split). The cap counts `technician` rows only. `subtotal` rows of sections whose technician rows were cut are still emitted. The final total is always emitted.

- [ ] **Step 1: Write the failing tests:**
  - `minutesToHours rounds half-up at 2 dp`: `minutesToHours(0) === 0`, `(1) === 0.02`, `(50) === 0.83`, `(90) === 1.5`.
  - `pivotColumnHeaders de-collides reserved and integer-like names`: input labels `['Remote','total','2024','Unassigned'(real),'Unassigned'(null id)]` → `['Remote','total (work type)','2024 (work type)','Unassigned (work type)','Unassigned']`.
  - `Object.keys order equals header order even with integer-like labels`: `Object.keys(buildPivotRows(...).rows[0])` equals `['Row type','Technician', ...headers,'Total']`.
  - `every row carries every column`.
  - `cap truncates technician rows but never subtotal/total rows`: cap 2 with 3 technicians gives 2 technician rows + 1 total, `truncated: true`, `available: 3`.
  - `split emits subtotal per section and All customers total`.
- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/utils/pivotTable.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): pivot table helpers for the technician time report (#11017)`.

### Task 1.3: Type registration + generator

This task touches every row of the Phase 2 §1.1 checklist from **Migration** through **Portal**, except PDF (Task 1.4). Web rows are W2.

**Files:**
- Create: `apps/api/migrations/2027-01-20-130000-report-type-technician-time-pivot.sql`. This is the slot after the newest committed migration, `2027-01-20-120000-m365-mailbox-connect-baseline.sql`. Re-check with `ls apps/api/migrations | sort | tail` at commit time, and if the slot is taken, take the next free one and say so in the PR. Body: `ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'technician_time_pivot';` under the header used by `2026-11-26-100400-report-type-ai-usage-by-client.sql`.
- Create: `apps/api/src/services/businessReports/technicianTimePivotReport.ts`, `technicianTimePivotReport.test.ts`
- Modify: `apps/api/src/db/schema/reports.ts` (`reportTypeEnum`); `packages/shared/src/reportTypes.ts` (+ test: `REPORT_TYPES`, `BUSINESS_REPORT_TYPES`, `BUSINESS_REPORT_REQUIRED_PERMISSIONS.technician_time_pivot = [PERMISSION_GRANTS.TIME_ENTRIES_READ]`); `packages/shared/src/types/businessReports.ts` (+ test); `apps/api/src/services/reportConfigSchemas.ts`; `reportRegistry.ts` (entry after `client_profitability`); `reportGenerationService.ts` (+ test, zero-safe `case`); `apps/portal/src/components/portal/ReportRunList.tsx` (+ test); `apps/web/src/components/reports/reportExport.ts` and `ReportsList.tsx` (widen the summary unions only)
- Test lists (add the type): `routes/reports/mspStaffAudience.test.ts`, `routes/reports/schemas.configParity.test.ts` (one stored-config fixture), `services/reportTypePermissions.test.ts`, `services/reportRegistry.test.ts`, `services/aiToolsFleet.reportAudience.test.ts:382,483`, `services/aiToolSchemasFleet.test.ts`, `reportSeries` `combinePlan.test.ts` (refused as `partner_aggregate`)

**Interfaces:**
- Consumes: `qualifyingEntriesCte`, `timeEntryScopePredicate` (1.1); `minutesToHours`, `pivotColumnHeaders`, `buildPivotRows` (1.2).
- Produces (shared types):
```ts
export type TechnicianTimePivotMeasure = 'logged' | 'billable' | 'included' | 'non_billable';
export type PivotMinutes = { loggedMinutes: number; billableMinutes: number; includedMinutes: number; nonBillableMinutes: number; entryCount: number };
export type TechnicianTimePivotColumn = { key: string; workTypeId: string | null; label: string; active: boolean };
export type TechnicianTimePivotRow = { userId: string; userLabel: string; cells: Partial<Record<string, PivotMinutes>>; total: PivotMinutes };
export type TechnicianTimePivotSection = {
  sectionKey: string;              // org uuid | 'internal' | 'all'
  orgId: string | null; label: string; // 'All time' when unsplit; 'Internal (no organization)' for org-less
  rows: TechnicianTimePivotRow[]; columnTotals: Partial<Record<string, PivotMinutes>>; total: PivotMinutes;
};
export type TechnicianTimePivotSummary = {
  generatedAt: string; period: ReportPeriodMeta; scope: ReportScopeMeta;
  measure: TechnicianTimePivotMeasure; splitBy: 'none' | 'organization'; approvedOnly: boolean;
  columns: TechnicianTimePivotColumn[]; headers: string[]; // headers[i] labels columns[i] in rows
  sections: TechnicianTimePivotSection[];
  columnTotals: Partial<Record<string, PivotMinutes>>; grandTotal: PivotMinutes;
  detail: { cap: number; stored: number; available: number; truncated: boolean };
  notes: string[]; rows: Record<string, string | number>[];
};
export function emptyTechnicianTimePivotSummary(note: string): TechnicianTimePivotSummary;
```
- Produces (API): `generateTechnicianTimePivotReport(scope: ReportScope, rawConfig: Record<string, unknown>, authority: ReportGenerationAuthority): Promise<ReportResult>`; `technicianTimePivotConfigSchema`, `type TechnicianTimePivotConfig`. Column `key` = work type uuid, or `'unassigned'`.

Queries, all inside **one** `runInReportScope`, each `WITH ${qualifyingEntriesCte(scope, period, { approvedOnly })}`:
1. **Columns:** `SELECT wt.id, wt.name, wt.is_active, wt.sort_order FROM work_types wt WHERE wt.partner_id = <owner partner> AND (wt.is_active OR wt.id IN (SELECT work_type_id FROM entries)) ORDER BY wt.sort_order, lower(wt.name), wt.id`. At partner scope, `<owner partner>` = `scope.partnerId`. At org scope it is the in-statement `(SELECT partner_id FROM organizations WHERE id = $org)`. Then append `{ key: 'unassigned', workTypeId: null, label: 'Unassigned', active: true }`.
2. **Cells:** `GROUP BY section_key, e.user_id, COALESCE(e.work_type_id::text, 'unassigned')`, with `section_key` = `'all'` unsplit, otherwise `COALESCE(e.org_id::text, 'internal')`. Select the four `PivotMinutes` sums (`SUM(duration_minutes) FILTER (WHERE eff_coverage = …)`) and `COUNT(*)`. Join `users` for `COALESCE(u.name, 'Unknown user')` and `organizations` for section labels.
3. **Totals:** a `GROUPING SETS ((section_key, user_id), (section_key, col), (section_key), (col), ())` statement over the same CTE, so every total comes from SQL over all qualifying entries and none is folded from capped rows.

Notes (fixed strings, all in the generator): measure definition ("Hours are time worked (duration), filtered by each entry's coverage…; entries before billing profiles fall back to their billable flag. Running timers are not counted."); rounding (D9); `PARTNER_ORG_LIST_NOTE` at partner scope; unsplit partner scope with internal minutes > 0 adds "Includes N internal hours with no organization."; `approvedOnly` adds "Only approved time entries are included."; truncation (D10); `period.timeZoneNote` when present.

- [ ] **Step 1: Write the failing tests** in `technicianTimePivotReport.test.ts` (Drizzle-mock harness as in 1.1):
  - `parses config before any query; rejects orgIds and dateRange` (`db.execute` not called).
  - `site-restricted authority returns the empty summary without querying`.
  - `every statement carries the shared fence and runs in one report scope`. Each compiled statement contains `te.partner_id =`, and `ctx` is the report scope for all of them.
  - `columns: active ∪ referenced-inactive, sorted, Unassigned last`.
  - `inactive work type with qualifying time keeps its column`.
  - `measure billable prints billable minutes as hours; summary keeps all four`.
  - `splitBy organization reconciles sections to grand total`. Mocked rows: tech A has 120 min in org X, 30 min in org Y and 15 min internal. Expect sections `[X, Y, internal]`, each `total` equal to the sum of its rows, and `grandTotal.loggedMinutes === 165`.
  - `org scope ignores splitBy with a note and has no internal section`.
  - `cap truncates data rows but never totals`: 5,001 pairs mocked, `detail.truncated === true`, last row `Row type === 'total'`.
  - `zero entries at partner scope with no orgs`: columns still listed, one total row of zeros, notes contain `PARTNER_NO_ORGS_NOTE` (not a short-circuit, since internal time is still real, as in the sibling).
  - `org scope with splitBy organization` adds the note "Split by customer applies to partner-wide reports; this report covers one organization."
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/businessReports/technicianTimePivotReport.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the migration, enum, tuple, permissions, types, schema, registry entry, generator, dispatcher `case`, portal exclusion and union widening, all in one commit (CI trap: `REPORT_TYPES` ↔ enum equality plus the registry's `satisfies`).
- [ ] **Step 4: Run** the new file plus every test file in the "Test lists" bullet, then `pnpm db:check-drift`. Expected: PASS, no drift.
- [ ] **Step 5: Typecheck** `apps/api`, `packages/shared`, `apps/portal`, `apps/web`: `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"`. Expected: `exit=0` (read the exit code, never pipe to `tail`).
- [ ] **Step 6: Commit** `feat(reports): technician_time_pivot report type and generator (#11017)`.

### Task 1.4: Designed PDF

**Files:**
- Create: `packages/shared/src/reportPdf/technicianTimePivotPdf.ts`, `reportPdf.technicianTimePivot.test.ts`
- Modify: `packages/shared/src/reportPdf/reportPdf.ts` (`DESIGNED_BUSINESS_TYPES` `:183`; `REPORT_TYPE_LABELS` `technician_time_pivot: 'Technician Time'`; a new arm next to `:2319` with a shape guard: `period` object, `Array.isArray(columns)`, `Array.isArray(sections)`; widen `BuildOpts.summary`), `index.ts`

**Interfaces:** `renderTechnicianTimePivotReport(doc: jsPDF, chrome: PdfChrome, summary: TechnicianTimePivotSummary, opts: TechnicianTimePdfOpts): void`. The `PdfChrome` declaration is copied, not imported (cycle rule, `technicianTimePdf.ts:18-19`).

Layout: title block (period label, scope, measure), then `notes` verbatim **before any number**, then one `autoTable` per section with the section label heading. Head: `Technician`, then `headers`, then `Total`. Body rows: hours from `minutesToHours`. Foot row: column totals. The table uses `horizontalPageBreak: true, horizontalPageBreakRepeat: 0` so wide work-type sets page horizontally with the technician column repeated. With a split, a closing "All customers" table follows.

- [ ] **Step 1: Write failing tests:** `renders notes before the first table`; `one table per section plus All customers when split`; `foot row equals summary column totals in hours`; `20 work types page horizontally and repeat the Technician column`; `shape mismatch falls back and calls onRendererFallback`.
- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/reportPdf/reportPdf.technicianTimePivot.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(reports): technician time pivot PDF (#11017)`.

### Task 1.5: Real-Postgres integration

**Files:** Create `apps/api/src/__tests__/integration/technicianTimePivotReport.integration.test.ts`. Seed it as the `technician_time_billability` block of `businessReportsPartnerScope.integration.test.ts:462` does.

- [ ] **Step 1: Write tests (red: generator not registered until 1.3 lands, so write this file before Task 1.3 Step 3 and run it red there):**
  - `partner scope sees ≥2 orgs and internal time; grand total equals SUM(duration_minutes) of seeded entries`.
  - `splitBy organization reconciles sections to grand total` (Review Focus 4).
  - `inactive work type with qualifying time keeps its column` (Review Focus 2).
  - `org scope never leaks other orgs or internal time` (Review Focus 5). A second partner's work type of the same name never appears as a column.
  - `a contract-line (billing_status contract) entry counts like ticket time`.
- [ ] **Step 2: Run on a wt-stack** (Phase 2 plan §1.5 recipe): `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/technicianTimePivotReport.integration.test.ts`. Expected: PASS. This suite runs only under the **Integration Tests** CI job. Tear the stack down afterwards (`pnpm wt-stack down`).
- [ ] **Step 3: Commit** `test(reports): technician time pivot against real Postgres (#11017)`.

**W1 PR:** title `feat(reports): technician time pivot report (API + PDF) (#11017)`. The body carries the Rule 9/tenancy statement, the migration slot and `Closes #<W1 sub-issue>`. Before review, run the full `apps/api` + `packages/shared` + `apps/portal` suites.

---

## W2: Web, docs, E2E (one PR)

Depends on W1 merged. This wave follows the Phase 2 §1.1 **Web form**, **Web wiring**, **Web tests**, **Locales**, **E2E** and **Docs** rows, mirroring the `technician_time_billability` arms.

### Task 2.1: Options form + wiring

**Files:**
- Create: `apps/web/src/components/reports/TechnicianTimePivotOptionsForm.tsx` (+ `.test.tsx`), exporting `TechnicianTimePivotOptions`, `DEFAULT_TECHNICIAN_TIME_PIVOT_OPTIONS` (`{ periodKind: 'last_full_month', measure: 'logged', splitBy: 'none', approvedOnly: false }`), `technicianTimePivotOptionsFromConfig`, `technicianTimePivotConfigFromOptions`, `isTechnicianTimePivotOptionsValid`, `TechnicianTimePivotOptionsFields`, `TechnicianTimePivotOptionsForm`. Mirror `TechnicianTimeOptionsForm.tsx`.
- Modify: `ReportTemplates.tsx` (Business card after `technician_time_billability` `:223`, type list `:191`, `businessDefaultRange` `:669`, form `case` `:1073`), `ReportEditPage.tsx` (`:281`, `curatedConfig` `:348`), `ReportBuilder.tsx:258` (`'activity'`), `businessReportConfig.ts` (`BUSINESS_OPTION_CONFIG_KEYS` += `measure`, `splitBy`, `approvedOnly`)
- Controls: `data-testid` `ttp-period`, `ttp-measure`, `ttp-split-by`, `ttp-approved-only`. The split control is disabled with helper text when the owner is a single organization.

- [ ] **Step 1: Write failing tests:** `TechnicianTimePivotOptionsForm.test.tsx` (config round-trip for all four keys; `splitBy` disabled for org owner; omits unset keys, so no defaults are written); `ReportTemplates.technicianTimePivot.test.tsx` (card creates the type with `last_full_month`); `ReportEditPage.technicianTimePivot.test.tsx` (edit preserves config); `reportExport.technicianTimePivot.test.tsx` (CSV header row equals `Row type,Technician,<headers>,Total`; PDF path passes the summary through); `businessReportAccess.test.ts` (hidden without `time_entries:read`); `reportTypeSurvivesBuilder.test.ts` (`false`); `lib/i18n/technicianTimePivotKeys.test.ts`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/reports/TechnicianTimePivot src/components/reports/ReportTemplates.technicianTimePivot.test.tsx src/components/reports/ReportEditPage.technicianTimePivot.test.tsx src/components/reports/reportExport.technicianTimePivot.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add locale keys to all 8 `apps/web/src/locales/<locale>/reports.json`: the type label at the three label maps beside `technician_time_billability`, plus an options block (`measure.{logged,billable,included,non_billable}`, `splitBy.{none,organization}`, `approvedOnly`, `splitByOrgOwnerHelp`).
- [ ] **Step 4: Run** the step 2 command plus `npx vitest run src/lib/i18n/localeParity.test.ts`. Expected: PASS. Typecheck `apps/web` (`exit=0`).
- [ ] **Step 5: Commit** `feat(web): technician time pivot report form (#11017)`.

### Task 2.2: E2E + docs

**Files:** `e2e-tests/tests/business-reports.spec.ts` (one `test()`: create from the Business card with `splitBy: organization`, generate, download CSV, assert the header row contains `Total`); `apps/docs/src/content/docs/features/reports.mdx` (new `### Technician time (technician_time_pivot)` after `:303`: what rows, columns and cells are; measures; split; internal time; rounding note; the two monthly-per-customer recipes from D6; API options table row); regenerate `apps/api/src/data/docsIndex.json` via `scripts/build-docs-index.ts`.

- [ ] **Step 1:** Write the E2E test. Run it on a wt-stack. Expected: FAIL before Task 2.1 is on the branch, PASS after.
- [ ] **Step 2:** Write the docs section and regenerate the index (`npx tsx scripts/build-docs-index.ts`). Commit both.
- [ ] **Step 3: Commit** `docs(reports): technician time pivot report (#11017)`. W2 PR body: release-note line ("New business report: Technician time, a technician × work type hours pivot with totals, optional per-customer split, monthly scheduling") and `Closes #<W2 sub-issue>`.

---

## CI traps (both waves)

- Phase 2 plan §1.4 applies verbatim: enum, tuple and registry in one commit; `localeParity` across all 8 locales; `parkedFanout.contract.test.ts` (the new files read no `devices`); integration suites run only under **Integration Tests**; typecheck exit codes are read, never piped; scoped vitest is `cd apps/<pkg> && npx vitest run <path>`, never `pnpm --filter … test -- --run`.
- `laborAmount.routing.test.ts` scans every non-test `.ts/.tsx` for an inline minutes→hours formula (`* 100 / 60`, `/ 60).toFixed(2)`). Hours go through `laborMath.ts` only (D9).
- `parkedFanout.contract.test.ts` and `.github/scripts/ci-area-gating`: the new files sit in existing directories and read no `devices`, so no entry is expected. Confirm the Lint job passes rather than assuming.
- A merged newer migration poisons the merge queue for a migration whose name now sorts earlier. Rename the W1 migration to the next free slot before enqueue if `main` moved past it.

## Follow-ups (not in this plan)

- **F1.** Partner-scope `orgIds` subset selector intersected with the live allowlist (codex). Needs a ruling-T3e revision across all business types.
- **F2.** Anchor `last_full_month` to the scheduled occurrence, not generation time, for every business type (D12).
- **F3.** Customer-facing per-customer delivery (series for `msp_staff` types) only if a design partner asks to send this to customers. It reverses ruling F1.
