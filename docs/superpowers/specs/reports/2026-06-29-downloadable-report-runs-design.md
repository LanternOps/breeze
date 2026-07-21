# Downloadable Report Runs — Design

**Date:** 2026-06-29
**Branch:** `ToddHebebrand/Reports`
**Origin:** User feature request (Cillian / TheMoroney): *"a means of directly downloading reports that have run would be excellent."* Observed on Reports → Recent Runs, where the ACTIONS column was empty for a `pending` run.

## Problem

The Reports → Recent Runs tab lists `report_runs` but a completed run produces no retrievable artifact. Concretely:

- `POST /reports/:id/generate` (`apps/api/src/routes/reports/runs.ts:63-83`) is a `setTimeout` stub: it flips a run from `pending` → `completed` after 1s and **computes/persists nothing**.
- `report_runs` has no column to hold output. `rowCount` exists but is never written.
- `runs.ts:70` writes `outputUrl = /api/reports/runs/:id/download`, but **no such route exists** — a dangling link.
- The branch's current Download button (`ReportsList.tsx:196-227`) hides this by **re-running the query live** at click time, so the file reflects "now," not when the run executed (data drift), and only appears on `completed` runs.

The actual report computation (six `generate*` functions) lives in `apps/api/src/routes/reports/generate.ts` and is only reachable via the ad-hoc `POST /reports/generate`, which returns JSON and stores nothing.

## Goal

Make a completed report run produce a **persisted, point-in-time snapshot** that can be downloaded directly as CSV / Excel / PDF, reflecting the data as of when the run executed.

## Non-goals

- No background worker / scheduler infrastructure (scheduled reports executing on cron is out of scope; tracked separately).
- No true server-side PDF rendering engine (PDF stays client-side from the snapshot — see §3).

## Design

### 1. Data model

Add one column to `report_runs` (`apps/api/src/db/schema/reports.ts`):

- `result jsonb` — point-in-time snapshot: `{ rows, rowCount, summary?, columns?, generatedFormat }`.

`rowCount` (already present, currently unwritten) is populated on completion. New migration adds the column idempotently (`ADD COLUMN IF NOT EXISTS`), date-prefixed per the migration convention.

**RLS:** no changes needed. `report_runs` is covered by the FK-child backstop through `reports` (`apps/api/migrations/2026-06-13-b-fk-child-rls-backstop.sql`; allowlisted as `['report_runs', ['reports']]` in `rls-coverage.integration.test.ts:288`). Adding a column does not alter its tenancy shape.

### 2. Generation path

Replace the `setTimeout` stub in `POST /reports/:id/generate` with real, synchronous generation:

- Refactor the six `generate*` functions out of `generate.ts` into a shared `reportGenerationService.ts` so the ad-hoc endpoint and the run path call the same code (no duplication).
- On run: insert `report_runs` as `pending` → dispatch to the matching generator by report `type` using the stored `config` → on success write `result` jsonb + `rowCount` + `completedAt` + `status='completed'`; on throw write `errorMessage` + `status='failed'`.
- **Synchronous (awaited)** within the request — not a background worker. The six report types are bounded queries, there is no worker/scheduler infra today, and synchronous keeps it simple and correct. The run is `completed` by the time the POST returns (existing UI polling resolves immediately).

**Trade-off:** a very large org's report blocks that request for its duration. Acceptable given current report scope; a worker can be introduced later if scheduled reports land.

### 3. Download endpoint

Add `GET /reports/runs/:id/download?format=csv|pdf|excel` in `runs.ts`:

- Loads the run (RLS-scoped through `reports`); 404 if not found; 409 if not `completed` or no `result`.
- Reads `result.rows`; renders server-side to the requested format (defaults to the report's `format`).
- Rendering moves to a shared `reportRender.ts` — CSV/TSV via existing `apps/web/src/lib/csvExport.ts` helpers (incl. `neutralizeSpreadsheetFormula` for CSV-injection safety), relocated/shared so the API can use them.
- Returns bytes with `Content-Disposition: attachment; filename="<report>-<date>.<ext>"` and correct MIME.
- Repoint `outputUrl` (`runs.ts:70`) at this now-real endpoint.
- Gate with the existing `REPORTS_EXPORT` permission (consistent with `POST /reports/generate`).

**PDF split:** current PDF is jsPDF (browser-only). To avoid a heavy headless dependency, render **CSV/Excel server-side**, and keep **PDF client-side** from the stored snapshot — for `format=pdf` the endpoint serves the snapshot rows as JSON and the browser builds the PDF via the existing `reportExport.ts` path.

### 4. Web UI

Update `handleDownload` in `ReportsList.tsx:196-227` to stop live-regenerating:

- CSV/Excel: `GET /reports/runs/:id/download?format=…`, save the returned blob directly. Surface failures via `runAction` convention (toast on failure) even though it's a GET.
- PDF: fetch snapshot rows from the download endpoint and render client-side with `reportExport.ts`.
- Leave the ad-hoc/builder client-side export flows (`ReportBuilder`, `ReportBuilderPage`) unchanged — those generate live, which is correct.
- Download button stays gated on `status === 'completed'`. Runs now actually complete with data, resolving the empty-Actions-on-pending observation.

### 5. Testing

- **API** (`runs.test.ts`, mock `../db` per the worker-test gotcha):
  - Run path persists `result` / `rowCount` / `completedAt` on success; failure path sets `errorMessage` / `status='failed'`.
  - Download endpoint: correct bytes + headers; 409 on non-completed; 404 on missing; RLS-scoped.
- **Shared render** (`reportRender.test.ts`): CSV/Excel output incl. formula-injection neutralization.
- **Web** (`ReportsList` test): Download on a completed run calls the download endpoint (not regenerate); failure toasts via `runAction`.

## Files touched

| File | Change |
|---|---|
| `apps/api/src/db/schema/reports.ts` | add `result jsonb` to `report_runs` |
| `apps/api/migrations/2026-06-29-*-report-run-result.sql` | new idempotent migration |
| `apps/api/src/routes/reports/runs.ts` | real generation in `/generate`; new `/runs/:id/download`; repoint `outputUrl` |
| `apps/api/src/services/reportGenerationService.ts` | new — extracted `generate*` functions |
| `apps/api/src/services/reportRender.ts` | new — server-side CSV/Excel rendering |
| `apps/api/src/routes/reports/generate.ts` | call shared service |
| `apps/web/src/components/reports/ReportsList.tsx` | download from endpoint, not regenerate |
| `apps/{api,web}/.../*.test.ts` | coverage per §5 |
