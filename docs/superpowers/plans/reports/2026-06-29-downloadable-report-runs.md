# Downloadable Report Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a completed report run persist a point-in-time data snapshot that users can download directly as CSV / Excel / PDF from Reports → Recent Runs.

**Architecture:** When a saved report runs, generate its data synchronously inside the request (reusing the existing six query functions, now extracted into a shared service), store the result as a `jsonb` snapshot on `report_runs`, and serve it via a new `GET /reports/runs/:id/download` endpoint that renders CSV/Excel server-side (PDF stays client-side, built from the snapshot). The web Download button switches from re-querying live data to fetching the stored snapshot.

**Tech Stack:** Hono + Drizzle (API), PostgreSQL (`jsonb`), `@breeze/shared` utils (CSV/TSV rendering), React (web), Vitest.

## Global Constraints

- **No internal infra details** in committed code.
- **Migrations:** hand-written SQL in `apps/api/migrations/`, idempotent (`ADD COLUMN IF NOT EXISTS`), date-prefixed `YYYY-MM-DD-<slug>.sql`, no inner `BEGIN;`/`COMMIT;`. Never edit a shipped migration.
- **RLS:** `report_runs` is already tenant-scoped via the FK-child backstop through `reports` (allowlisted `['report_runs', ['reports']]` in `rls-coverage.integration.test.ts:288`). Adding a column does not change its tenancy shape — **no RLS migration needed**.
- **Site-scope security:** any path that generates report data MUST pass `perms` (`c.get('permissions')`) through the generators and reject out-of-scope `config` via `siteScopeRequestAllowed`, exactly as `POST /reports/generate` does today.
- **Permissions:** report generation (`POST /reports/:id/generate`) keeps `REPORTS_WRITE`; data egress (`GET /reports/runs/:id/download`) requires `REPORTS_EXPORT` (matches `POST /reports/generate`).
- **CSV-injection safety:** all server-side cell rendering must go through `neutralizeSpreadsheetFormula` (already in the shared helpers).
- **DB context:** generation must run **inside** the request (awaited), never in a detached `setTimeout` — a detached callback runs outside the request DB-access context and would silently 0-row write under RLS.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/utils/csvExport.ts` (NEW) | Canonical CSV/TSV cell helpers + `rowsToCsv` / `rowsToTsv` row serializers |
| `packages/shared/src/utils/csvExport.test.ts` (NEW) | Unit tests for the renderers incl. formula-injection |
| `packages/shared/src/utils/index.ts` (MODIFY) | Re-export `./csvExport` |
| `apps/web/src/lib/csvExport.ts` (MODIFY) | Re-export the helpers from `@breeze/shared` (no behavior change for existing importers) |
| `apps/api/src/db/schema/reports.ts` (MODIFY) | Add `result jsonb` to `report_runs` |
| `apps/api/migrations/2026-06-29-report-run-result.sql` (NEW) | Idempotent `ADD COLUMN` migration |
| `apps/api/src/services/reportGenerationService.ts` (NEW) | The six `generate*` functions + `generateReport` dispatcher + `siteScopeRequestAllowed` (moved from `generate.ts`) |
| `apps/api/src/routes/reports/generate.ts` (MODIFY) | Call the shared service instead of inline functions |
| `apps/api/src/routes/reports/runs.ts` (MODIFY) | Real synchronous generation+persist in `/:id/generate`; new `/runs/:id/download`; repoint `outputUrl` |
| `apps/api/src/routes/reports/schemas.ts` (MODIFY) | Add `downloadQuerySchema` |
| `apps/api/src/routes/reports.test.ts` (MODIFY) | Cases for persist + download |
| `apps/web/src/components/reports/ReportsList.tsx` (MODIFY) | Download from the new endpoint instead of regenerating |
| `apps/web/src/components/reports/ReportsList.download.test.tsx` (NEW) | Tests for the new download handler |

---

## Task 1: Shared CSV/TSV row renderers

**Files:**
- Create: `packages/shared/src/utils/csvExport.ts`
- Create: `packages/shared/src/utils/csvExport.test.ts`
- Modify: `packages/shared/src/utils/index.ts`
- Modify: `apps/web/src/lib/csvExport.ts`

**Interfaces:**
- Produces: `neutralizeSpreadsheetFormula(value: string): string`, `escapeCsvCell(value: string): string`, `escapeTsvCell(value: string): string`, `toCsv(header: string[], rows: Array<Array<string|number|null|undefined>>): string`, `rowsToCsv(rows: unknown[]): string`, `rowsToTsv(rows: unknown[]): string` — all from `@breeze/shared`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/utils/csvExport.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { rowsToCsv, rowsToTsv, escapeCsvCell, neutralizeSpreadsheetFormula } from './csvExport';

describe('neutralizeSpreadsheetFormula', () => {
  it('prefixes a quote on formula-leading values', () => {
    expect(neutralizeSpreadsheetFormula('=1+1')).toBe("'=1+1");
    expect(neutralizeSpreadsheetFormula('safe')).toBe('safe');
    expect(neutralizeSpreadsheetFormula('')).toBe('');
  });
});

describe('rowsToCsv', () => {
  it('returns empty string for no rows', () => {
    expect(rowsToCsv([])).toBe('');
  });

  it('renders headers from the first row and quotes every cell', () => {
    const csv = rowsToCsv([{ hostname: 'pc-1', os: 'windows' }, { hostname: 'pc-2', os: 'macos' }]);
    expect(csv).toBe('hostname,os\n"pc-1","windows"\n"pc-2","macos"');
  });

  it('neutralizes formula injection in body cells', () => {
    const csv = rowsToCsv([{ note: '=cmd()' }]);
    expect(csv).toBe(`note\n${escapeCsvCell('=cmd()')}`);
    expect(csv).toContain("'=cmd()");
  });

  it('renders null/undefined cells as empty', () => {
    expect(rowsToCsv([{ a: null, b: undefined }])).toBe('a,b\n"",""');
  });
});

describe('rowsToTsv', () => {
  it('returns empty string for no rows', () => {
    expect(rowsToTsv([])).toBe('');
  });

  it('tab-separates and only quotes cells needing it', () => {
    const tsv = rowsToTsv([{ a: 'x', b: 'has\ttab' }]);
    expect(tsv).toBe('a\tb\nx\t"has\ttab"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/shared test -- csvExport`
Expected: FAIL — `Cannot find module './csvExport'`.

- [ ] **Step 3: Create the shared module**

Create `packages/shared/src/utils/csvExport.ts`:

```ts
/**
 * Shared CSV/TSV cell helpers + row serializers, with spreadsheet-formula-injection
 * neutralization. Kept free of heavy deps (no jsPDF) so both the API (server-side
 * report download) and the web app can import them. `apps/web/src/lib/csvExport.ts`
 * re-exports these for back-compat.
 */

const FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r', '\n']);

/**
 * Neutralize a value a spreadsheet would interpret as a formula by prefixing a
 * single quote when it starts with a dangerous character. Standard CSV-injection
 * mitigation for attacker-influenced content (e.g. agent-supplied event-log text).
 */
export function neutralizeSpreadsheetFormula(value: string): string {
  if (value.length === 0) return value;
  return FORMULA_PREFIXES.has(value[0]!) ? `'${value}` : value;
}

/** Neutralize then RFC-4180-quote a CSV cell. */
export function escapeCsvCell(value: string): string {
  const safe = neutralizeSpreadsheetFormula(value);
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Neutralize then quote a TSV cell only when it contains tab/quote/newline. */
export function escapeTsvCell(value: string): string {
  const safe = neutralizeSpreadsheetFormula(value);
  return /[\t\r\n"]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Serialize a header row + body rows to a CSV string, neutralizing every cell.
 * Cells are coerced to strings first.
 */
export function toCsv(header: string[], rows: Array<Array<string | number | null | undefined>>): string {
  return [header, ...rows]
    .map((line) => line.map((value) => escapeCsvCell(String(value ?? ''))).join(','))
    .join('\n');
}

/** Convert a cell value to its display string. */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** Derive headers from the first row's keys and a string[][] body. */
function extractTable(rows: unknown[]): { headers: string[]; body: string[][] } {
  const headers = Object.keys(rows[0] as Record<string, unknown>);
  const body = rows.map((row) => {
    const record = row as Record<string, unknown>;
    return headers.map((h) => cellToString(record[h]));
  });
  return { headers, body };
}

/** Serialize report rows to CSV (header from first row's keys). Empty input → ''. */
export function rowsToCsv(rows: unknown[]): string {
  if (rows.length === 0) return '';
  const { headers, body } = extractTable(rows);
  return [headers.join(','), ...body.map((row) => row.map(escapeCsvCell).join(','))].join('\n');
}

/** Serialize report rows to TSV (Excel-compatible). Empty input → ''. */
export function rowsToTsv(rows: unknown[]): string {
  if (rows.length === 0) return '';
  const { headers, body } = extractTable(rows);
  return [headers.join('\t'), ...body.map((row) => row.map(escapeTsvCell).join('\t'))].join('\n');
}
```

- [ ] **Step 4: Export from the shared utils barrel**

In `packages/shared/src/utils/index.ts`, add at the end:

```ts
export * from './csvExport';
```

- [ ] **Step 5: Point the web helper at shared (no behavior change)**

Replace the entire contents of `apps/web/src/lib/csvExport.ts` with a re-export so existing importers (`reportExport.ts`, `csvExport.test.ts`, other components) keep working:

```ts
/**
 * CSV/TSV cell helpers. The canonical implementations now live in `@breeze/shared`
 * so the API can share the exact same formula-injection-safe rendering. This file
 * re-exports them for existing web importers.
 */
export {
  neutralizeSpreadsheetFormula,
  escapeCsvCell,
  escapeTsvCell,
  toCsv,
  rowsToCsv,
  rowsToTsv,
} from '@breeze/shared';
```

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @breeze/shared test -- csvExport && pnpm --filter @breeze/web test -- csvExport reportExport`
Expected: PASS (shared renderers + the existing web `csvExport.test.ts` / `reportExport.test.ts` against the re-export).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/utils/csvExport.ts packages/shared/src/utils/csvExport.test.ts packages/shared/src/utils/index.ts apps/web/src/lib/csvExport.ts
git commit -m "feat(shared): rowsToCsv/rowsToTsv renderers shared between api and web"
```

---

## Task 2: Persist snapshot column on report_runs

**Files:**
- Modify: `apps/api/src/db/schema/reports.ts:44-54`
- Create: `apps/api/migrations/2026-06-29-report-run-result.sql`

**Interfaces:**
- Produces: `reportRuns.result` (Drizzle `jsonb` column) holding `{ rows?, rowCount?, summary?, generatedAt? }`.

- [ ] **Step 1: Add the column to the Drizzle schema**

In `apps/api/src/db/schema/reports.ts`, add `result` to the `reportRuns` table (after `rowCount`):

```ts
export const reportRuns = pgTable('report_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  reportId: uuid('report_id').notNull().references(() => reports.id),
  status: reportRunStatusEnum('status').notNull().default('pending'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  outputUrl: text('output_url'),
  errorMessage: text('error_message'),
  rowCount: integer('row_count'),
  result: jsonb('result'),
  createdAt: timestamp('created_at').defaultNow().notNull()
});
```

(`jsonb` is already imported on line 1.)

- [ ] **Step 2: Write the migration**

Create `apps/api/migrations/2026-06-29-report-run-result.sql`:

```sql
-- Persist the point-in-time data snapshot for a completed report run so it can be
-- downloaded later (CSV/Excel/PDF) without re-querying live data.
-- report_runs is RLS-covered via the FK-child backstop through reports; adding a
-- column does not change its tenancy shape.
ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS result jsonb;
```

- [ ] **Step 3: Verify no drift**

Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift`
Expected: no drift between schema and migrations (the new column matches).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema/reports.ts apps/api/migrations/2026-06-29-report-run-result.sql
git commit -m "feat(api): add result jsonb snapshot column to report_runs"
```

---

## Task 3: Extract report generation into a shared service

**Files:**
- Create: `apps/api/src/services/reportGenerationService.ts`
- Modify: `apps/api/src/routes/reports/generate.ts`

**Interfaces:**
- Produces: `generateReport(type: ReportType, orgId: string, config: Record<string, unknown>, perms?: UserPermissions): Promise<ReportResult>`, `siteScopeRequestAllowed(orgId: string, config: Record<string, unknown>, perms: UserPermissions | undefined): Promise<boolean>`, and types `ReportType` / `ReportResult`.
- Consumes (in `runs.ts`, Task 4): the two functions above.

This is a behavior-preserving refactor: the existing `reports.test.ts` generate/site-scope cases are the test.

- [ ] **Step 1: Create the service with the moved functions**

Create `apps/api/src/services/reportGenerationService.ts`. Move these verbatim from `generate.ts` (lines 24-76 and 165-516): `resolveSiteAllowedDeviceIds`, `asStringArray`, `filtersFor`, `emptyRowsReport`, `addAllowedSiteCondition`, `siteScopeRequestAllowed`, and the six `generate*` functions. Add the dispatcher and types. Header of the new file:

```ts
import { and, eq, sql, desc, gte, lte, inArray, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  devices,
  deviceSoftware,
  deviceMetrics,
  deviceHardware,
  alerts,
  alertRules,
  sites
} from '../db/schema';
import { canAccessSite, type UserPermissions } from './permissions';

export type ReportType =
  | 'device_inventory'
  | 'software_inventory'
  | 'alert_summary'
  | 'compliance'
  | 'performance'
  | 'executive_summary';

export type ReportResult = {
  rows?: unknown[];
  rowCount?: number;
  summary?: Record<string, unknown>;
  generatedAt?: string;
};

// ... (moved helpers: resolveSiteAllowedDeviceIds, asStringArray, filtersFor,
//      emptyRowsReport, addAllowedSiteCondition, siteScopeRequestAllowed)
// ... (moved six generate* functions, unchanged)
```

Mark `siteScopeRequestAllowed` and the six `generate*` functions as `export`. Then add the dispatcher at the bottom:

```ts
/** Dispatch to the matching report generator by type. */
export async function generateReport(
  type: ReportType,
  orgId: string,
  config: Record<string, unknown>,
  perms?: UserPermissions
): Promise<ReportResult> {
  switch (type) {
    case 'device_inventory':
      return generateDeviceInventoryReport(orgId, config, perms);
    case 'software_inventory':
      return generateSoftwareInventoryReport(orgId, config, perms);
    case 'alert_summary':
      return generateAlertSummaryReport(orgId, config, perms);
    case 'compliance':
      return generateComplianceReport(orgId, config, perms);
    case 'performance':
      return generatePerformanceReport(orgId, config, perms);
    case 'executive_summary':
      return generateExecutiveSummaryReport(orgId, config, perms);
    default:
      throw new Error(`Invalid report type: ${type}`);
  }
}
```

- [ ] **Step 2: Rewire `generate.ts` to use the service**

In `apps/api/src/routes/reports/generate.ts`:
- Remove the moved helpers (lines 24-76) and the six `generate*` functions (lines 165-516).
- Remove now-unused imports (`and, sql, desc, gte, lte, type SQL`, the device/alert/site schema imports, `canAccessSite`). Keep `eq` only if still used (it is not after removal — drop it). Keep `inArray`? No — drop. Keep `db` (used for nothing now? the handler no longer queries directly) — **drop `db` import** if unused.
- Add: `import { generateReport, siteScopeRequestAllowed, type ReportResult } from '../../services/reportGenerationService';`
- Replace the `switch (data.type) { ... }` block (lines 122-143) with:

```ts
const reportData: ReportResult = await generateReport(data.type, orgId!, config, perms);
```

The surrounding handler (orgId resolution, `siteScopeRequestAllowed` guard at line 118, audit, response) stays unchanged — `siteScopeRequestAllowed` now comes from the import.

- [ ] **Step 3: Run the existing report tests (behavior preserved)**

Run: `pnpm --filter @breeze/api test -- reports`
Expected: PASS — all existing `reports.test.ts` generate and site-scope cases still green.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/reportGenerationService.ts apps/api/src/routes/reports/generate.ts
git commit -m "refactor(api): extract report generation into shared service"
```

---

## Task 4: Real run generation + download endpoint

**Files:**
- Modify: `apps/api/src/routes/reports/runs.ts`
- Modify: `apps/api/src/routes/reports/schemas.ts`
- Modify: `apps/api/src/routes/reports.test.ts`

**Interfaces:**
- Consumes: `generateReport`, `siteScopeRequestAllowed`, `ReportResult` (Task 3); `reportRuns.result` (Task 2); `rowsToCsv`, `rowsToTsv` (Task 1).
- Produces: `POST /reports/:id/generate` now completes synchronously with a stored snapshot; `GET /reports/runs/:id/download?format=csv|excel|pdf|json`.

- [ ] **Step 1: Add the download query schema**

In `apps/api/src/routes/reports/schemas.ts`, add:

```ts
export const downloadQuerySchema = z.object({
  format: z.enum(['csv', 'pdf', 'excel', 'json']).optional()
});
```

- [ ] **Step 2: Write the failing API tests**

In `apps/api/src/routes/reports.test.ts`:

(a) Add `result: 'reportRuns.result'` to the `reportRuns` mock object (inside `vi.mock('../db/schema', ...)`).

(b) Add a self-contained chainable-select helper and a recording update near the top of the test body (after the existing imports / constants):

```ts
/** A thenable that resolves to `rows` and supports any drizzle chain method. */
function selectChain(rows: any) {
  const p: any = Promise.resolve(rows);
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'groupBy', 'limit', 'offset']) {
    p[m] = () => p;
  }
  return p;
}
```

(c) Add these describe blocks:

```ts
import { reportsRoutes } from './reports';
import { downloadQuerySchema } from './reports/schemas'; // ensure schema import path resolves

describe('GET /reports/runs/:id/download', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionState.deny = false;
    permissionState.permissions = undefined;
  });

  it('streams CSV for a completed run with stored rows', async () => {
    const app = new Hono();
    app.route('/reports', reportsRoutes);

    vi.mocked(db.select)
      // getReportRunWithOrgCheck → run row (with orgId for access check)
      .mockReturnValueOnce(selectChain([
        { id: 'run-1', reportId: 'rep-1', status: 'completed', orgId: ORG_ID }
      ]))
      // download handler → result + report meta
      .mockReturnValueOnce(selectChain([
        {
          result: { rows: [{ hostname: 'pc-1', os: 'windows' }], rowCount: 1 },
          reportType: 'device_inventory',
          reportName: 'Inventory',
          reportFormat: 'csv'
        }
      ]));

    const res = await app.request('/reports/runs/run-1/download');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const body = await res.text();
    expect(body).toContain('hostname');
    expect(body).toContain('"pc-1"');
  });

  it('returns 409 when the run is not completed', async () => {
    const app = new Hono();
    app.route('/reports', reportsRoutes);
    vi.mocked(db.select).mockReturnValueOnce(selectChain([
      { id: 'run-1', reportId: 'rep-1', status: 'pending', orgId: ORG_ID }
    ]));
    const res = await app.request('/reports/runs/run-1/download');
    expect(res.status).toBe(409);
  });

  it('returns 409 when a completed run has no tabular rows', async () => {
    const app = new Hono();
    app.route('/reports', reportsRoutes);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([{ id: 'run-1', reportId: 'rep-1', status: 'completed', orgId: ORG_ID }]))
      .mockReturnValueOnce(selectChain([{ result: { summary: {} }, reportType: 'executive_summary', reportName: 'Exec', reportFormat: 'csv' }]));
    const res = await app.request('/reports/runs/run-1/download');
    expect(res.status).toBe(409);
  });

  it('returns 404 for a run the caller cannot access', async () => {
    const app = new Hono();
    app.route('/reports', reportsRoutes);
    vi.mocked(db.select).mockReturnValueOnce(selectChain([
      { id: 'run-1', reportId: 'rep-1', status: 'completed', orgId: 'deadbeef-0000-0000-0000-000000000000' }
    ]));
    const res = await app.request('/reports/runs/run-1/download');
    expect(res.status).toBe(404);
  });

  it('returns the snapshot as JSON for pdf format', async () => {
    const app = new Hono();
    app.route('/reports', reportsRoutes);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([{ id: 'run-1', reportId: 'rep-1', status: 'completed', orgId: ORG_ID }]))
      .mockReturnValueOnce(selectChain([{ result: { rows: [{ hostname: 'pc-1' }], rowCount: 1 }, reportType: 'device_inventory', reportName: 'Inventory', reportFormat: 'pdf' }]));
    const res = await app.request('/reports/runs/run-1/download?format=pdf');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const json = await res.json();
    expect(json.data.rows[0].hostname).toBe('pc-1');
  });
});

describe('POST /reports/:id/generate persists a snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionState.deny = false;
    permissionState.permissions = undefined;
  });

  it('generates synchronously and stores result + completed status', async () => {
    const app = new Hono();
    app.route('/reports', reportsRoutes);

    const setArgs: any[] = [];
    vi.mocked(db.update).mockReturnValue({
      set: (v: any) => { setArgs.push(v); return { where: () => Promise.resolve() }; }
    } as any);

    // getReportWithOrgCheck → report; then generator selects → empty
    vi.mocked(db.select).mockImplementation(() =>
      selectChain([{ id: 'rep-1', orgId: ORG_ID, type: 'device_inventory', name: 'Inv', config: {}, format: 'csv' }])
    );
    vi.mocked(db.insert).mockReturnValue({
      values: () => ({ returning: () => Promise.resolve([{ id: 'run-1', status: 'pending' }]) })
    } as any);

    const res = await app.request('/reports/rep-1/generate', { method: 'POST' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('completed');
    const completedSet = setArgs.find((a) => a.status === 'completed');
    expect(completedSet).toBeDefined();
    expect(completedSet.result).toBeDefined();
    expect(completedSet.outputUrl).toBe('/api/reports/runs/run-1/download');
  });
});
```

> Note: the generator's `device_inventory` query resolves to `[]` via `selectChain`, so `result` is `{ rows: [], rowCount: 0 }` — still a valid stored snapshot for the assertion. If the existing file uses a different per-test `db.select` setup helper, mirror that instead of `selectChain`; the assertions are what matter.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @breeze/api test -- reports`
Expected: FAIL — `/reports/runs/run-1/download` returns 404 (route absent); persist test fails (`outputUrl` set but no `result`, status flip is in detached `setTimeout`).

- [ ] **Step 4: Rewrite `POST /:id/generate` for synchronous generate+persist**

In `apps/api/src/routes/reports/runs.ts`, add imports at the top:

```ts
import { generateReport, siteScopeRequestAllowed, type ReportResult } from '../../services/reportGenerationService';
import { rowsToCsv, rowsToTsv } from '@breeze/shared';
import { downloadQuerySchema } from './schemas';
import type { UserPermissions } from '../../services/permissions';
```

Replace the block from `// In a real implementation...` through the end of the `setTimeout` (current lines 53-83) with:

```ts
    const perms = c.get('permissions') as UserPermissions | undefined;
    const config = (report.config ?? {}) as Record<string, unknown>;

    if (!(await siteScopeRequestAllowed(report.orgId, config, perms))) {
      await db
        .update(reportRuns)
        .set({ status: 'failed', completedAt: new Date(), errorMessage: 'Access to report scope denied' })
        .where(eq(reportRuns.id, run.id));
      return c.json({ error: 'Access to report scope denied' }, 403);
    }

    await db
      .update(reports)
      .set({ lastGeneratedAt: new Date(), updatedAt: new Date() })
      .where(eq(reports.id, reportId));

    try {
      const result = await generateReport(report.type, report.orgId, config, perms);
      const rowCount = result.rowCount ?? (Array.isArray(result.rows) ? result.rows.length : 0);
      await db
        .update(reportRuns)
        .set({
          status: 'completed',
          completedAt: new Date(),
          outputUrl: `/api/reports/runs/${run.id}/download`,
          result,
          rowCount
        })
        .where(eq(reportRuns.id, run.id));
      return c.json({ message: 'Report generated', runId: run.id, status: 'completed' });
    } catch (err) {
      await db
        .update(reportRuns)
        .set({
          status: 'failed',
          completedAt: new Date(),
          errorMessage: err instanceof Error ? err.message : 'Failed to generate report'
        })
        .where(eq(reportRuns.id, run.id));
      return c.json({ message: 'Report generation failed', runId: run.id, status: 'failed' }, 500);
    }
```

(Remove the old `return c.json({ message: 'Report generation started', ... })` — the handler now returns inside the try/catch.)

- [ ] **Step 5: Add the download endpoint**

In `apps/api/src/routes/reports/runs.ts`, after the `GET /runs/:id` handler, add:

```ts
// GET /reports/runs/:id/download - Download a completed run's stored snapshot
runsRoutes.get(
  '/runs/:id/download',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.REPORTS_EXPORT.resource, PERMISSIONS.REPORTS_EXPORT.action),
  zValidator('query', downloadQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const runId = c.req.param('id')!;
    const { format: requestedFormat } = c.req.valid('query');

    const run = await getReportRunWithOrgCheck(runId, auth);
    if (!run) {
      return c.json({ error: 'Report run not found' }, 404);
    }
    if (run.status !== 'completed') {
      return c.json({ error: 'Report run is not completed' }, 409);
    }

    const [row] = await db
      .select({
        result: reportRuns.result,
        reportType: reports.type,
        reportName: reports.name,
        reportFormat: reports.format
      })
      .from(reportRuns)
      .innerJoin(reports, eq(reportRuns.reportId, reports.id))
      .where(eq(reportRuns.id, runId))
      .limit(1);

    const result = (row?.result ?? null) as ReportResult | null;
    const rows = Array.isArray(result?.rows) ? (result!.rows as unknown[]) : [];
    const format = requestedFormat ?? row?.reportFormat ?? 'csv';
    const dateStr = new Date().toISOString().split('T')[0];
    const baseName = `${row?.reportType ?? 'report'}-report-${dateStr}`;

    // PDF / JSON: hand the snapshot to the client to render (avoids a server PDF engine).
    if (format === 'pdf' || format === 'json') {
      return c.json({ type: row?.reportType, format, data: result });
    }

    if (rows.length === 0) {
      return c.json({ error: 'Report run has no tabular data to download' }, 409);
    }

    if (format === 'excel') {
      c.header('Content-Type', 'application/vnd.ms-excel');
      c.header('Content-Disposition', `attachment; filename="${baseName}.xls"`);
      return c.body(rowsToTsv(rows));
    }

    c.header('Content-Type', 'text/csv;charset=utf-8;');
    c.header('Content-Disposition', `attachment; filename="${baseName}.csv"`);
    return c.body(rowsToCsv(rows));
  }
);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @breeze/api test -- reports`
Expected: PASS — download + persist cases green, existing cases unaffected.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/reports/runs.ts apps/api/src/routes/reports/schemas.ts apps/api/src/routes/reports.test.ts
git commit -m "feat(api): generate+persist report runs and add download endpoint"
```

---

## Task 5: Web Download button uses the stored snapshot

**Files:**
- Modify: `apps/web/src/components/reports/ReportsList.tsx:196-227`
- Create: `apps/web/src/components/reports/ReportsList.download.test.tsx`

**Interfaces:**
- Consumes: `GET /reports/runs/:id/download` (Task 4); `exportReport`, `downloadBlob`, `getBrowserTimezone` from `./reportExport`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/reports/ReportsList.download.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

const exportReport = vi.fn();
const downloadBlob = vi.fn();
vi.mock('./reportExport', () => ({
  exportReport: (...a: unknown[]) => exportReport(...a),
  downloadBlob: (...a: unknown[]) => downloadBlob(...a),
  getBrowserTimezone: () => 'UTC',
}));

import ReportsList from './ReportsList';

const completedRun = {
  id: 'run-1',
  reportId: 'rep-1',
  status: 'completed',
  startedAt: '2026-06-28T00:00:00Z',
  completedAt: '2026-06-28T00:01:00Z',
  outputUrl: '/api/reports/runs/run-1/download',
  errorMessage: null,
  createdAt: '2026-06-28T00:00:00Z',
  reportName: 'Inventory',
  reportType: 'device_inventory',
};

function mockList() {
  // initial load: GET /reports (saved) then GET /reports/runs
  fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/reports') return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
    if (url.startsWith('/reports/runs?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [completedRun] }) });
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

describe('ReportsList download', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList();
  });

  it('saves the returned CSV blob without regenerating', async () => {
    const blob = new Blob(['hostname\n"pc-1"'], { type: 'text/csv' });
    fetchWithAuth.mockImplementationOnce((url: string) => { // override list flow below per-call
      if (url === '/reports') return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });
    // Easier: set explicit responses after mount
    fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/reports') return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
      if (url.startsWith('/reports/runs?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [completedRun] }) });
      if (url === '/reports/runs/run-1/download') {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="device_inventory-report-2026-06-28.csv"' }),
          blob: () => Promise.resolve(blob),
        });
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });

    render(<ReportsList />);
    // switch to Recent Runs tab
    await userEvent.click(await screen.findByText('Recent Runs'));
    await userEvent.click(await screen.findByText('Download'));

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(downloadBlob).toHaveBeenCalledWith(blob, 'device_inventory-report-2026-06-28.csv');
    expect(exportReport).not.toHaveBeenCalled();
    // never re-queried /reports/generate
    expect(fetchWithAuth).not.toHaveBeenCalledWith('/reports/generate', expect.anything());
  });

  it('renders PDF client-side from the JSON snapshot', async () => {
    fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/reports') return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
      if (url.startsWith('/reports/runs?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [completedRun] }) });
      if (url === '/reports/runs/run-1/download') {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ type: 'device_inventory', format: 'pdf', data: { rows: [{ hostname: 'pc-1' }] } }),
        });
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });

    render(<ReportsList />);
    await userEvent.click(await screen.findByText('Recent Runs'));
    await userEvent.click(await screen.findByText('Download'));

    await waitFor(() => expect(exportReport).toHaveBeenCalledTimes(1));
    expect(exportReport).toHaveBeenCalledWith(
      [{ hostname: 'pc-1' }],
      expect.objectContaining({ format: 'pdf', reportType: 'device_inventory' })
    );
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/web test -- ReportsList.download`
Expected: FAIL — current `handleDownload` calls `/reports/runs/:id`, `/reports/:id`, and `/reports/generate`, and uses `exportReport` for CSV (so `downloadBlob` is never called and the CSV assertion fails).

- [ ] **Step 3: Rewrite `handleDownload`**

In `apps/web/src/components/reports/ReportsList.tsx`, update the import on line 17 to add `downloadBlob`:

```ts
import { exportReport, downloadBlob, getBrowserTimezone } from './reportExport';
```

Add a small filename parser above `handleDownload` (after line 194's `downloadingRunId` state):

```ts
function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const match = /filename="?([^";]+)"?/.exec(header);
  return match?.[1] ?? null;
}
```

Replace `handleDownload` (lines 196-227) with:

```ts
  const handleDownload = async (run: ReportRun) => {
    setDownloadingRunId(run.id);
    try {
      const res = await fetchWithAuth(`/reports/runs/${run.id}/download`);
      if (!res.ok) {
        let message = 'Download failed';
        try {
          message = (await res.json())?.error ?? message;
        } catch {
          /* non-JSON error body */
        }
        throw new Error(message);
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        // PDF path: server returned the stored snapshot; render client-side.
        const payload = await res.json();
        const rows = (payload.data as { rows?: unknown[] })?.rows ?? [];
        exportReport(rows, {
          format: 'pdf',
          reportType: payload.type ?? run.reportType ?? 'report',
          timezone: effectiveTimezone,
        });
        return;
      }

      // CSV/Excel: save the returned file blob directly.
      const blob = await res.blob();
      const filename =
        parseContentDispositionFilename(res.headers.get('content-disposition')) ??
        `${run.reportType ?? 'report'}-report.csv`;
      downloadBlob(blob, filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloadingRunId(null);
    }
  };
```

> The download is a GET (data egress already gated server-side by `REPORTS_EXPORT`), so the `runAction` mutation-feedback convention does not apply; failures surface through the existing `setError` banner, matching the rest of this component.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/web test -- ReportsList.download`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/reports/ReportsList.tsx apps/web/src/components/reports/ReportsList.download.test.tsx
git commit -m "feat(web): download report runs from stored snapshot instead of regenerating"
```

---

## Task 6: Full verification

- [ ] **Step 1: API + shared + web suites**

Run: `pnpm --filter @breeze/shared test && pnpm --filter @breeze/api test -- reports && pnpm --filter @breeze/web test -- reports`
Expected: all PASS.

- [ ] **Step 2: Type-check (CI parity — `tsc` compiles tests too)**

Run: `pnpm --filter @breeze/api exec tsc --noEmit && pnpm --filter @breeze/web exec astro check`
Expected: no type errors. Watch for `arr[0]` non-null access (`row?.` already guards) and unused imports left in `generate.ts`.

- [ ] **Step 3: Schema drift**

Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift`
Expected: no drift.

- [ ] **Step 4: Manual smoke (optional, needs running stack)**

Create a report, click Generate, confirm the run shows **Completed** with a row count, then click **Download** and verify the file matches the data as of run time. Repeat for a `pdf`-format report (renders client-side) and an `excel`-format report (`.xls`).

---

## Self-Review Notes

- **Spec §1 (data model)** → Task 2. **§2 (generation)** → Tasks 3+4. **§3 (download endpoint)** → Task 4. **§4 (web UI)** → Task 5. **§5 (testing)** → Tasks 1/4/5 tests + Task 6.
- **Site-scope guard** carried into the run path (Task 4 Step 4) — closes the gap that the old stub never generated, so never checked scope.
- **`setTimeout` removed** — generation is awaited in-request, satisfying the DB-context constraint (a detached callback would 0-row write under RLS).
- **Known limitation (documented, not fixed here):** `executive_summary` produces a `summary` object with no `rows`, so CSV/Excel download returns 409 "no tabular data"; its PDF/JSON download still works. Tabular rendering of summary reports is out of scope.
- **Scheduled reports** still have no executor (out of scope per the spec non-goals) — only manually-run reports produce downloadable snapshots.
