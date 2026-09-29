---
tracking_issue: LanternOps/breeze#7438
spec: docs/superpowers/specs/reports/2026-09-28-multi-org-report-series-design.md
wave: W01 — Org visibility + delivery status (one PR)
blast_radius: low (one additive migration on report_runs; the schedule worker's delivery tail; list projections; web)
written_against: main 92764125ed + spec commit e9ac8b6e22
---

# Multi-org Report Series W01: Org Visibility + Delivery Status — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Read [`2026-09-28-multi-org-report-series-INDEX.md`](2026-09-28-multi-org-report-series-INDEX.md) (same directory) first.** It holds the global constraints and the fixed cross-wave names. This plan was written against `main` at `92764125ed` plus the spec commit `e9ac8b6e22`. Every file path, line reference and helper name below was checked at that commit. If `main` has moved, re-check the line numbers before you edit.

**Goal:**
- Every saved report and every run shows which organization it covers.
- New Report and Templates stop answering 400 under **All organizations**.
- A scheduled run that reached nobody is recorded on the run and flagged on the list. Today it is a silent skip.

**Architecture:**
- **Migration.** One additive migration gives `report_runs` two columns, `delivery_status` (with a CHECK) and `recipient_count`, plus a `(report_id, created_at)` index.
- **Worker.** The schedule worker resolves a non-series report's recipients as **customer**: its contact rows plus the valid `config.emailRecipients` addresses. The `cc` set stays empty until W02's series children. It sends once, derives a status from a pure function, and writes a never-throwing delivery summary onto the run it just completed.
- **API lists.** `GET /reports` gains a LEFT JOIN to `organizations` for `orgName`, and a correlated subquery for the latest scheduled `delivery_status`. `GET /reports/runs` gains `orgId`, `orgName`, `deliveryStatus` and `recipientCount`.
- **Web.**
  - A `CoversCell` replaces the lone partner-owned `ScopeBadge`.
  - An Org column goes on Recent Runs.
  - A `DeliveryStatusChip` flags `no_recipients`.
  - A `useReportTargetOrg` hook with `OrgPickerField` makes the builder and the templates page name an org before they post.

**Tech Stack:** Hono + Drizzle + postgres.js, hand-written idempotent SQL, BullMQ worker, Vitest (unit + integration against real Postgres), Astro + React islands, react-i18next with 8 locale catalogs.

**Spec:** `docs/superpowers/specs/reports/2026-09-28-multi-org-report-series-design.md`, covering:
- §1 (the silent skip);
- §3.2, the `report_runs` columns;
- §3.5, the `recipient_count` and `delivery_status` rules;
- §3.6, the W01 list fields;
- §3.7, the Covers column for the single-org and Combined kinds, the Org column on Recent Runs, and the org picker;
- §4, the W01 row;
- §5, the W01 tests.

**Depends on:** nothing unmerged. W02 consumes the `delivery_status` column, `ReportDeliveryStatus`, `resolveScheduledReportRecipientSets` and `CoversCell`'s `series` prop.

---

## Contract concerns

These are kept exactly as the INDEX states them. Each one is listed so the orchestrator can rule on it.

1. **`GET /reports` gains one field the INDEX does not list: `lastDeliveryStatus: ReportDeliveryStatus | null`.**
   - The brief requires a "no recipients" warning on saved-report rows whose **latest scheduled run** is `no_recipients`. The list has no other way to know that.
   - The recent-runs panel is capped at 20 runs across all orgs, so it cannot stand in.
   - The field is additive. W02/W03 may reuse it or supersede it with `SeriesOrgStatus.lastRun`.
2. **`ReportDeliveryStatus` is defined in `apps/api/src/db/schema/reports.ts` (`REPORT_DELIVERY_STATUSES`) and re-exported from `apps/api/src/services/reportDelivery.ts`.**
   - The INDEX names `reportDelivery.ts` as its home, and it is importable from there.
   - The Drizzle column needs the union for `$type<>()`, and the schema layer must not import from `services/`.
3. *(Resolved by coordinator ruling, 2026-09-28.)* A non-series report has no internal CC: `customer` = its resolved contacts ∪ its valid `config.emailRecipients`, `cc` = [], and `recipient_count` = `customer.length`. The contacts-only/CC split applies to series children only, and W02 introduces it.
4. **`partial` has no per-recipient send outcome to come from.**
   - `emailReportRun` makes **one** `sendEmail` call with every recipient in `to` (`services/reportDelivery.ts:164`).
   - W01 defines `partial` as: the email left, but at least one **configured** recipient was dropped. A dropped recipient is one of:
     - a contact with no email or an invalid email;
     - an invalid `emailRecipients` entry;
     - a recipient cut by the existing 50-recipient cap.
   - A per-recipient ledger is out of scope (spec §3.2).
5. **`failed` includes "no email service configured".** `emailReportRun` returns early with a warning when `getEmailService()` is null. Nothing left the platform, so W01 records `failed` rather than `sent`.
   - To make that observable, `emailReportRun` now resolves `true` (handed to the transport) or `false` (no transport).
   - The narrative caller (`services/reportNarrativeDelivery.ts:290`) ignores the value. It already checks `getEmailService()` itself.
6. **The web type mirror.**
   - The INDEX puts web mirrors in `apps/web/src/components/reports/series/types.ts`, which is W03's file.
   - W01 needs `ReportDeliveryStatus` on the web now, so it lives in `apps/web/src/components/reports/DeliveryStatusChip.tsx`.
   - W03's `series/types.ts` should **re-export** it, not redeclare it.
   - `DeliveryStatusChip.tsx` is a W01 component that the INDEX component list does not name.
7. **The new index `report_runs_report_id_created_at_idx (report_id, created_at DESC, id DESC)` is not in the spec.**
   - Without it, `report_runs` has **no** index on `report_id` (only `(id, report_id)` unique and `artifact_id`). The per-row "latest scheduled delivery" subquery would then scan every run of every listed report.
   - The index is built non-concurrently inside autoMigrate's transaction, which briefly blocks writes to `report_runs`. That is acceptable at current volumes; say so in the PR.
8. **CoversCell's series kind renders from a `series` prop, not from a `seriesId` on the report row.**
   - The spec's series labels ("All orgs · N", "N orgs") need `targetMode` and an org count, and the INDEX's W02 `/reports` fields (`seriesId`, `seriesName`) do not carry them.
   - W01 therefore types the prop as `series?: { seriesId: string; targetMode: 'all' | 'selected'; orgCount: number } | null`. It renders the series kind only when `series?.seriesId` is set.
   - W03 passes that prop for the grouped series row, built from `GET /reports/series`.
   - A W02 **child** row (`seriesId` set, `orgId` set) correctly renders the single-org kind in W01.

**Spec items deliberately not in W01** (§4 assigns them to W03): the filter chips (All · Multi-org · Single-org · Combined), the Series column on Recent Runs, and the series Last-run summary. The business-report modal's ownership radio (`ReportOwnerScopeField`) still says "pick an organization in the organization switcher". W03's `CoversControl` replaces it; W01 leaves it byte-for-byte unchanged.

---

## Global Constraints

- **Migration name.** `apps/api/migrations/2026-11-09-100000-report-runs-delivery-status.sql` (INDEX: W01 uses `2026-11-09-100000-…`).
  - Before committing, run `ls apps/api/migrations | grep -E '^[0-9]' | sort | tail -1` and confirm the new file sorts last.
  - If a newer file has landed, bump the name. Also update the one path reference in `apps/api/src/db/schema/reports.test.ts` (Task 1); `autoMigrate.test.ts` asserts that every such reference resolves.
  - Never touch the closed `2026-08-06` block.
- **Idempotent, no inner transaction, no row writes.**
  - Use `ADD COLUMN IF NOT EXISTS`, `pg_constraint` existence checks, and `CREATE INDEX IF NOT EXISTS`.
  - No `BEGIN`/`COMMIT`.
  - No UPDATE, INSERT or DELETE, so no `set_config('breeze.scope','system',true)`. `migrationRlsScope.test.ts` stays untouched; never add to its baseline.
- **Export policy: none.**
  - `report_runs` has no `org_id`. It is a **pre-clear** entry in `services/tenantCascade.ts:1083-1112`, not a member of `CORE_ORG_CASCADE_DELETE_ORDER`.
  - Both export suites discover their tables from `getOrgCascadeDeleteOrder()`. See `tenant-export-policy.integration.test.ts:11-23`, which reads `information_schema.columns` for exactly those tables.
  - `services/tenantExportPolicy.test.ts:391` pins `expect(CORE_TENANT_EXPORT_POLICY).not.toHaveProperty('report_runs')`.
  - No cascade, merge, RLS-coverage or export registration applies. The existing FK-join RLS policies on `report_runs` cover the new columns.
- **The partner-owned visibility scan.** `routes/reports/partnerOwnedVisibility.scan.test.ts` pins the count of unguarded `reports`/`reportRuns` query sites per scope, and `processRunScheduledReport` is pinned at 4.
  - The new delivery-summary UPDATE lives in its own function, `recordRunDelivery`, which gets its own pinned allowlist entry (Task 3).
  - The new `GET /reports` subquery sits in the guarded `GET /` scope, which already calls the `resolveDefinitionListScope` guard entrypoint.
- **Behaviour stays unchanged except for:** the two new run columns being written, the new list fields, and the org picker. The recipient union, dedupe order, the 50-recipient cap and its warning, the email rendering (pinned by `reportDelivery.snapshot.test.ts`) and every deny path are byte-for-byte what they were.
- **Web.**
  - No new mutation (`runAction` is unaffected).
  - `data-testid` goes on every new element.
  - Every string goes into all 8 `reports.json` catalogs (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`), with no value identical to English. The duplicate caps in `lib/i18n/translationCoverage.test.ts` count identical values.
- **Test commands** (INDEX):
  - API unit: `cd apps/api && npx vitest run <path>`. Web: `cd apps/web && npx vitest run <path>`. Never use `pnpm … test -- --run`.
  - Integration: `pnpm test-stack up` from the worktree root, which writes `.env.test`; `vitest.integration.config.ts` loads it. Then run `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`, and `pnpm test-stack down` when done.
  - Typecheck (CI shape): `NODE_OPTIONS=--max-old-space-size=12288 pnpm exec tsc --build apps/api/tsconfig.tests.json` and `cd apps/web && NODE_OPTIONS=--max-old-space-size=12288 pnpm exec astro check`.
- **Commit after every task.** Every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## Review Focus

These are the five inputs the spec implies but does not spell out, most likely first. Each one is pinned by a test in the owning task.

1. **Every configured address is unusable, for example the only contact recipient has no email.** A person expects this to be flagged **No recipients**, not `partial` or `sent`, and expects nothing to be sent. Pinned in Task 3: `records no_recipients (not partial) when every configured address was unusable`.
2. **A self-hosted install with no email service configured.** A person expects the run to read as **not delivered** (`failed`), never `sent`. Pinned in Task 3: `records failed when no email service is configured`.
3. **The delivery-summary write fails after the email already left.** A person expects the report to stay `completed` and the job not to throw. A throw would mark a delivered run failed and let BullMQ retry, which re-sends the email. Pinned in Task 3: `keeps the run completed and does not throw when the summary write fails`.
4. **A partner-owned (Combined) definition or run.** `reports.org_id` is NULL, so `orgName` is null. A person expects "All organizations · Combined", never "Unknown organization" or a blank cell. Pinned in:
   - Task 5, integration: `a partner-owned definition lists with orgName null`;
   - Task 6, `CoversCell.test.tsx`: `renders Combined for a partner-owned row, never Unknown organization`.
5. **The org list holds out-of-service orgs, or only one org can take a report.**
   - A person expects suspended, churned, offboarding and similar orgs to be left out of the picker, because the API refuses them with `REPORT_TENANT_INACTIVE`.
   - With exactly one creatable org, a person expects that org to be used with no picker shown.
   - Pinned in Task 7, `OrgPickerField.test.tsx`: `omits out-of-service orgs and auto-uses the only creatable org`.

---

## Before you start

- [ ] Rebase: `git fetch origin main && git rebase origin/main`.
- [ ] Feature lifecycle (CLAUDE.md):
  - Run `get_feature_status` for the multi-org report series feature.
  - If it is registered, branch `feature/<parent#>-multi-org-report-series/wave-<W01 sub#>` and call `start_wave`.
  - If it is not registered yet, stop and ask the orchestrator. The INDEX frontmatter names the tracking issue.

## File map

| File | Change | Task |
|---|---|---|
| `apps/api/migrations/2026-11-09-100000-report-runs-delivery-status.sql` | create: 2 columns, 2 CHECKs, 1 index | 1 |
| `apps/api/src/db/schema/reports.ts` | `REPORT_DELIVERY_STATUSES`, `ReportDeliveryStatus`, `reportRuns.deliveryStatus`/`recipientCount`, CHECKs, index | 1 |
| `apps/api/src/db/schema/reports.test.ts` | schema + migration pins | 1 |
| `apps/api/src/services/reportDelivery.ts` | re-export type, `scheduledDeliveryStatus`, `emailReportRun` resolves boolean | 2 |
| `apps/api/src/services/reportDelivery.status.test.ts` | create | 2 |
| `apps/api/src/jobs/reportScheduleWorker.ts` | `resolveScheduledReportRecipientSets`, delivery tail, `recordRunDelivery` | 2, 3 |
| `apps/api/src/jobs/reportScheduleWorker.test.ts` | recipient-set cases, delivery-summary cases, default update chain | 2, 3 |
| `apps/api/src/routes/reports/partnerOwnedVisibility.scan.test.ts` | `recordRunDelivery` allowlist entry | 3 |
| `apps/api/src/__tests__/integration/reportsOrgVisibility.integration.test.ts` | create | 3, 5 |
| `apps/api/src/routes/reports/runs.ts` | manual generate writes `not_scheduled`; runs list projection + org join | 4, 5 |
| `apps/api/src/routes/reports/core.ts` | list projection: `orgName`, `lastDeliveryStatus` | 5 |
| `apps/api/src/routes/reports.test.ts` | mocks (`getTableColumns`, `organizations`, run columns), list-page helpers gain `leftJoin`, new cases | 4, 5 |
| `apps/api/src/routes/reports/systemManaged.test.ts` | select-chain mock gains `leftJoin` | 5 |
| `apps/web/src/components/reports/DeliveryStatusChip.tsx` | create | 6 |
| `apps/web/src/components/reports/CoversCell.tsx` + `CoversCell.test.tsx` | create | 6 |
| `apps/web/src/components/reports/ReportsList.tsx` | Covers column, no-recipients chip, Recent Runs Org column + delivery chip | 6 |
| `apps/web/src/components/reports/ReportsList.covers.test.tsx` | create | 6 |
| `apps/web/src/components/reports/ReportsList.scope.test.tsx` | the badge assertions move to the Covers cell | 6 |
| `apps/web/src/locales/*/reports.json` (8 files) | new keys | 6 |
| `apps/web/src/components/reports/OrgPickerField.tsx` + `OrgPickerField.test.tsx` | create | 7 |
| `apps/web/src/components/reports/ReportBuilder.tsx` | picker, submit guard, preview guard, target org in 3 request bodies, `defaultOrgId` prop | 7 |
| `apps/web/src/components/reports/ReportBuilder.test.tsx` | org-picker describe | 7 |
| `apps/web/src/components/reports/ReportTemplates.tsx` | page-level picker, guards, target org in POST, builder `defaultOrgId` | 8 |
| `apps/web/src/components/reports/ReportTemplates.orgPicker.test.tsx` | create | 8 |

---

### Task 1: Migration and Drizzle schema for the delivery summary

**Files:**
- Create: `apps/api/migrations/2026-11-09-100000-report-runs-delivery-status.sql`
- Modify: `apps/api/src/db/schema/reports.ts` (the `reportRuns` table, lines 133-203)
- Test: `apps/api/src/db/schema/reports.test.ts`

**Interfaces:**
- Produces:
  - `export const REPORT_DELIVERY_STATUSES = ['sent', 'partial', 'no_recipients', 'failed', 'not_scheduled'] as const;`
  - `export type ReportDeliveryStatus = (typeof REPORT_DELIVERY_STATUSES)[number];`
  - `reportRuns.deliveryStatus` (`text('delivery_status').$type<ReportDeliveryStatus>()`, nullable)
  - `reportRuns.recipientCount` (`integer('recipient_count')`, nullable)
  - constraints `report_runs_delivery_status_chk` and `report_runs_recipient_count_chk`
  - index `report_runs_report_id_created_at_idx`

- [ ] **Step 1: Write the failing schema test**

Append to `apps/api/src/db/schema/reports.test.ts`. The file already imports `readFileSync`, `getTableColumns`, `getTableConfig` and `PgDialect`. Extend its import from `./reports` with `REPORT_DELIVERY_STATUSES`:

```ts
import {
  REPORT_DELIVERY_STATUSES,
  REPORT_RUN_DELIVERY_STATES,
  reportRunDeliveries,
  reportRuns,
  reports,
  reportScheduleRecipients,
  reportTypeEnum,
} from './reports';
```

```ts
describe('report run delivery summary (multi-org report series W01)', () => {
  const compile = (value: Parameters<PgDialect['sqlToQuery']>[0]) =>
    new PgDialect().sqlToQuery(value).sql.replace(/\s+/g, ' ').toLowerCase();

  it('models delivery_status and recipient_count as nullable run columns', () => {
    const columns = getTableColumns(reportRuns);
    expect(columns.deliveryStatus.name).toBe('delivery_status');
    expect(columns.deliveryStatus.notNull).toBe(false);
    expect(columns.recipientCount.name).toBe('recipient_count');
    expect(columns.recipientCount.notNull).toBe(false);
  });

  it('pins the five delivery statuses, in order', () => {
    expect(REPORT_DELIVERY_STATUSES).toEqual([
      'sent',
      'partial',
      'no_recipients',
      'failed',
      'not_scheduled',
    ]);
  });

  it('declares the delivery_status CHECK over exactly those statuses, NULL allowed', () => {
    const check = getTableConfig(reportRuns).checks.find(
      (candidate) => candidate.name === 'report_runs_delivery_status_chk',
    );
    expect(check).toBeDefined();
    const compiled = compile(check!.value);
    expect(compiled).toContain('"report_runs"."delivery_status" is null');
    for (const status of REPORT_DELIVERY_STATUSES) {
      expect(compiled).toContain(`'${status}'`);
    }
  });

  it('declares a non-negative recipient_count CHECK', () => {
    const check = getTableConfig(reportRuns).checks.find(
      (candidate) => candidate.name === 'report_runs_recipient_count_chk',
    );
    expect(check).toBeDefined();
    expect(compile(check!.value)).toContain('"report_runs"."recipient_count" >= 0');
  });

  it('indexes runs by report, newest first', () => {
    const index = getTableConfig(reportRuns).indexes.find(
      (candidate) => candidate.config.name === 'report_runs_report_id_created_at_idx',
    );
    expect(index).toBeDefined();
  });

  it('ships the same constraints and index in the migration', () => {
    const migration = readFileSync(
      new URL(
        '../../../migrations/2026-11-09-100000-report-runs-delivery-status.sql',
        import.meta.url,
      ),
      'utf8',
    );
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS delivery_status text');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS recipient_count integer');
    expect(migration).toContain('report_runs_delivery_status_chk');
    expect(migration).toContain('report_runs_recipient_count_chk');
    expect(migration).toContain('report_runs_report_id_created_at_idx');
    for (const status of REPORT_DELIVERY_STATUSES) {
      expect(migration).toContain(`'${status}'`);
    }
    // Writes no rows: no scope elevation, no inner transaction.
    expect(migration).not.toMatch(/^\s*(UPDATE|INSERT|DELETE|BEGIN|COMMIT)\b/im);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/db/schema/reports.test.ts`
Expected: FAIL. `REPORT_DELIVERY_STATUSES` is undefined, `columns.deliveryStatus` is undefined, and `readFileSync` throws `ENOENT` for the migration path.

- [ ] **Step 3: Write the migration**

Create `apps/api/migrations/2026-11-09-100000-report-runs-delivery-status.sql`:

```sql
-- Multi-org report series W01 (spec docs/superpowers/specs/reports/
-- 2026-09-28-multi-org-report-series-design.md §3.2): what a scheduled run's
-- email did, recorded on the run itself. A run whose recipients resolved to
-- nobody used to be skipped silently.
--
--   delivery_status  NULL for ad-hoc runs and every run before this migration;
--                    'not_scheduled' for a manual run of a scheduled
--                    definition; otherwise the schedule worker's outcome:
--                    'sent' | 'partial' | 'no_recipients' | 'failed'.
--   recipient_count  the customer recipients the run resolved. For a
--                    non-series report that is its contacts plus its valid
--                    config.emailRecipients (there is no internal CC); a W02
--                    series child excludes its series' internal CC.
--
-- report_runs has no org_id (its tenancy is its parent report's) and is a
-- pre-clear entry outside CORE_ORG_CASCADE_DELETE_ORDER, so these columns need
-- no CORE_TENANT_EXPORT_POLICY classification (tenantExportPolicy.test.ts pins
-- report_runs' absence from the export policy). The existing FK-join RLS
-- policies on report_runs cover the new columns.
--
-- The index serves GET /reports' per-row "latest scheduled delivery" lookup
-- and every other per-report run read; report_runs had no report_id index.
--
-- Idempotent; no inner BEGIN/COMMIT; writes no rows (no scope elevation).

ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS delivery_status text;
ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS recipient_count integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'report_runs_delivery_status_chk'
      AND conrelid = 'report_runs'::regclass
  ) THEN
    ALTER TABLE report_runs ADD CONSTRAINT report_runs_delivery_status_chk
      CHECK (
        delivery_status IS NULL
        OR delivery_status IN ('sent', 'partial', 'no_recipients', 'failed', 'not_scheduled')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'report_runs_recipient_count_chk'
      AND conrelid = 'report_runs'::regclass
  ) THEN
    ALTER TABLE report_runs ADD CONSTRAINT report_runs_recipient_count_chk
      CHECK (recipient_count IS NULL OR recipient_count >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS report_runs_report_id_created_at_idx
  ON report_runs (report_id, created_at DESC, id DESC);
```

- [ ] **Step 4: Update the Drizzle schema**

In `apps/api/src/db/schema/reports.ts`, add the constant and type directly above `export const reportRuns = pgTable('report_runs', {`:

```ts
/**
 * `report_runs.delivery_status` (multi-org report series W01, spec §3.2):
 * what a scheduled run's email did. NULL for ad-hoc and pre-W01 runs;
 * 'not_scheduled' for a manual run of a scheduled definition. Pinned by
 * `report_runs_delivery_status_chk`. Re-exported from
 * `services/reportDelivery.ts`, the cross-wave contract path — declared here
 * because the column below needs it and the schema layer never imports
 * services.
 */
export const REPORT_DELIVERY_STATUSES = [
  'sent',
  'partial',
  'no_recipients',
  'failed',
  'not_scheduled',
] as const;
export type ReportDeliveryStatus = (typeof REPORT_DELIVERY_STATUSES)[number];
```

In the `reportRuns` column list, insert immediately above `createdAt: timestamp('created_at').defaultNow().notNull()`:

```ts
  /** Multi-org report series W01 — see REPORT_DELIVERY_STATUSES. */
  deliveryStatus: text('delivery_status').$type<ReportDeliveryStatus>(),
  /**
   * Multi-org report series W01 (spec §3.5): customer recipients the scheduled
   * run resolved — for a non-series report, contacts plus valid
   * `config.emailRecipients`; a W02 series child excludes its internal CC.
   */
  recipientCount: integer('recipient_count'),
```

In the `reportRuns` table-config callback, add after the `requestedByShape` check (keep the existing entries):

```ts
  deliveryStatusShape: check(
    'report_runs_delivery_status_chk',
    sql`(
      ${table.deliveryStatus} IS NULL
      OR ${table.deliveryStatus} IN ('sent', 'partial', 'no_recipients', 'failed', 'not_scheduled')
    )`,
  ),
  recipientCountShape: check(
    'report_runs_recipient_count_chk',
    sql`(${table.recipientCount} IS NULL OR ${table.recipientCount} >= 0)`,
  ),
  reportIdCreatedAtIdx: index('report_runs_report_id_created_at_idx')
    .on(table.reportId, table.createdAt.desc(), table.id.desc()),
```

`check`, `index`, `integer`, `text` and `sql` are already imported at the top of the file (lines 1-16).

- [ ] **Step 5: Run the schema test and the migration guards**

Run:
```bash
cd apps/api && npx vitest run src/db/schema/reports.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/services/tenantExportPolicy.test.ts
cd ../.. && bash scripts/check-migration-naming.sh
```
Expected: PASS for all four files, including the existing `expect(CORE_TENANT_EXPORT_POLICY).not.toHaveProperty('report_runs')`. The naming script exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-11-09-100000-report-runs-delivery-status.sql apps/api/src/db/schema/reports.ts apps/api/src/db/schema/reports.test.ts
git commit -m "feat(reports): report_runs.delivery_status + recipient_count (multi-org series W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Recipient sets and the delivery-status rule

**Files:**
- Modify: `apps/api/src/services/reportDelivery.ts` (lines 72-189, `emailReportRun`)
- Create: `apps/api/src/services/reportDelivery.status.test.ts`
- Modify: `apps/api/src/jobs/reportScheduleWorker.ts` (lines 334-404: `validEmail`, `resolveScheduledReportRecipients`)
- Test: `apps/api/src/jobs/reportScheduleWorker.test.ts` (next to `describe('resolveScheduledReportRecipients', …)` at line 423)

**Interfaces:**
- Consumes: `ReportDeliveryStatus` (Task 1).
- Produces, in `services/reportDelivery.ts`:
  - `export type { ReportDeliveryStatus }`
  - `export type ScheduledSendOutcome = 'sent' | 'failed' | 'not_attempted'`
  - `export function scheduledDeliveryStatus(args: { deliverable: number; dropped: number; send: ScheduledSendOutcome }): Exclude<ReportDeliveryStatus, 'not_scheduled'>`
  - `emailReportRun(...)` now returns `Promise<boolean>`.
- Produces, in `jobs/reportScheduleWorker.ts`:
  - `export interface ScheduledRecipientSets { customer: string[]; cc: string[]; recipients: string[]; dropped: number }`
  - `export async function resolveScheduledReportRecipientSets(args: { reportId: string; orgId: string | null; config: Record<string, unknown> }): Promise<ScheduledRecipientSets>`
  - `resolveScheduledReportRecipients` is unchanged in signature and result; it now returns `.recipients`.
  - For every non-series report, `cc` is `[]`: a non-series report has no internal CC (coordinator ruling). W02's `resolveSeriesChildRecipients` is the first resolver to fill `cc`, with a series child's internal CC.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/reportDelivery.status.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const emailState = vi.hoisted(() => ({
  service: null as null | { sendEmail: ReturnType<typeof vi.fn> },
}));
vi.mock('./email', () => ({ getEmailService: () => emailState.service }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { emailReportRun, scheduledDeliveryStatus } from './reportDelivery';

const run = {
  reportName: 'Nightly inventory',
  reportType: 'device_inventory',
  format: 'csv',
  recipients: ['ops@example.com'],
  rows: [],
  timezone: 'UTC',
  branding: { name: null, logoDataUrl: null, logoAspect: null },
  partnerId: null,
};

describe('scheduledDeliveryStatus (multi-org report series W01)', () => {
  it.each([
    [{ deliverable: 0, dropped: 0, send: 'not_attempted' }, 'no_recipients'],
    // Every configured address was unusable: still nobody, not "partial".
    [{ deliverable: 0, dropped: 3, send: 'not_attempted' }, 'no_recipients'],
    [{ deliverable: 2, dropped: 0, send: 'sent' }, 'sent'],
    [{ deliverable: 2, dropped: 1, send: 'sent' }, 'partial'],
    [{ deliverable: 2, dropped: 0, send: 'failed' }, 'failed'],
    [{ deliverable: 2, dropped: 1, send: 'failed' }, 'failed'],
    // Recipients existed but nothing was handed to a transport.
    [{ deliverable: 2, dropped: 0, send: 'not_attempted' }, 'failed'],
  ] as const)('%o → %s', (input, expected) => {
    expect(scheduledDeliveryStatus(input)).toBe(expected);
  });
});

describe('emailReportRun hand-off result', () => {
  beforeEach(() => {
    emailState.service = null;
  });

  it('resolves false and sends nothing when no email service is configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(emailReportRun(run)).resolves.toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('resolves true once the transport accepted the message', async () => {
    const sendEmail = vi.fn(async () => undefined);
    emailState.service = { sendEmail };
    await expect(emailReportRun(run)).resolves.toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('rethrows a transport failure', async () => {
    emailState.service = {
      sendEmail: vi.fn(async () => {
        throw new Error('smtp down');
      }),
    };
    await expect(emailReportRun(run)).rejects.toThrow('smtp down');
  });
});
```

In `apps/api/src/jobs/reportScheduleWorker.test.ts`, add `resolveScheduledReportRecipientSets` to the import from `./reportScheduleWorker` (lines 241-251). Then add this describe block directly after the closing `});` of `describe('resolveScheduledReportRecipients', …)`, just before the `// ─── Due discovery` comment:

```ts
describe('resolveScheduledReportRecipientSets (multi-org report series W01)', () => {
  const ORG = '11111111-1111-4111-8111-111111111111';

  it('treats contacts and valid typed addresses alike as customers of a non-series report (no CC), counting every dropped address', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    selectMock.mockReturnValueOnce(selectChain([
      { contactId: 'contact-a', email: 'Ops@Example.test' },
      { contactId: 'contact-b', email: null },
      { contactId: 'contact-c', email: 'not-an-email' },
      { contactId: 'contact-d', email: 'owner@example.test' },
    ]));

    try {
      const sets = await resolveScheduledReportRecipientSets({
        reportId: 'report-1',
        orgId: ORG,
        config: {
          emailRecipients: ['ops@example.test', 'typed@customer.test', 'invalid', 42],
        },
      });

      // Coordinator ruling: a non-series report has no internal CC.
      expect(sets.customer).toEqual(['Ops@Example.test', 'owner@example.test', 'typed@customer.test']);
      expect(sets.cc).toEqual([]);
      // A typed address that is also a contact is delivered (and counted) once.
      expect(sets.recipients).toEqual(sets.customer);
      // contact-b (no email), contact-c (invalid), 'invalid', 42 — a duplicate is not a drop.
      expect(sets.dropped).toBe(4);
    } finally {
      warn.mockRestore();
    }
  });

  it('counts recipients cut by the 50-address cap as dropped, contacts kept first', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    selectMock.mockReturnValueOnce(selectChain(
      Array.from({ length: 48 }, (_, index) => ({
        contactId: `contact-${index}`,
        email: `user${index}@example.test`,
      })),
    ));

    try {
      const sets = await resolveScheduledReportRecipientSets({
        reportId: 'report-1',
        orgId: ORG,
        config: { emailRecipients: ['a@typed.test', 'b@typed.test', 'c@typed.test', 'd@typed.test'] },
      });

      expect(sets.customer).toHaveLength(50);
      expect(sets.customer.slice(48)).toEqual(['a@typed.test', 'b@typed.test']);
      expect(sets.cc).toEqual([]);
      expect(sets.recipients).toHaveLength(50);
      expect(sets.dropped).toBe(2);
      expect(warn).toHaveBeenCalledWith(
        '[ReportScheduleWorker] Recipient union exceeds 50; truncating',
        expect.objectContaining({ reportId: 'report-1', requested: 52 }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('resolves only the typed addresses for a partner-owned definition: no contact query', async () => {
    const sets = await resolveScheduledReportRecipientSets({
      reportId: 'report-1',
      orgId: null,
      config: { emailRecipients: ['cfo@msp.test'] },
    });

    expect(selectMock).not.toHaveBeenCalled();
    expect(sets).toEqual({
      customer: ['cfo@msp.test'],
      cc: [],
      recipients: ['cfo@msp.test'],
      dropped: 0,
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/reportDelivery.status.test.ts src/jobs/reportScheduleWorker.test.ts`
Expected: FAIL.
- `scheduledDeliveryStatus is not a function`.
- `emailReportRun(run)` resolves `undefined`, not `false`/`true`.
- `resolveScheduledReportRecipientSets is not a function`.

The existing `resolveScheduledReportRecipients` cases still pass.

- [ ] **Step 3: Implement the status rule and the hand-off result**

In `apps/api/src/services/reportDelivery.ts`, add after the imports (after line 24):

```ts
import type { ReportDeliveryStatus } from '../db/schema/reports';

export type { ReportDeliveryStatus } from '../db/schema/reports';

/** What happened to a scheduled run's one `sendEmail` hand-off. */
export type ScheduledSendOutcome = 'sent' | 'failed' | 'not_attempted';

/**
 * A scheduled run's `report_runs.delivery_status` (multi-org report series W01,
 * spec §3.2 / §3.5). Pure — the worker passes what it resolved and the outcome
 * of its single send (`emailReportRun` sends ONE message to every recipient,
 * so there is no per-recipient outcome to aggregate):
 *
 *  - `no_recipients`: nothing deliverable resolved (customer and CC both
 *    empty). Nothing was sent.
 *  - `failed`: there were recipients, but the message did not leave — the
 *    transport threw, or no email service is configured.
 *  - `partial`: sent, but at least one CONFIGURED recipient was dropped (a
 *    contact with no or an invalid email, an invalid address, the 50 cap).
 *  - `sent`: sent to everyone configured. (A W02 series child with CC but
 *    no customer recipient is still `sent`, spec §3.5; its
 *    `recipient_count = 0` says so. A non-series report has no CC.)
 *
 * Never returns `not_scheduled` — that is the manual generate route's value.
 */
export function scheduledDeliveryStatus(args: {
  deliverable: number;
  dropped: number;
  send: ScheduledSendOutcome;
}): Exclude<ReportDeliveryStatus, 'not_scheduled'> {
  if (args.deliverable === 0) return 'no_recipients';
  if (args.send !== 'sent') return 'failed';
  return args.dropped > 0 ? 'partial' : 'sent';
}
```

Then change `emailReportRun`:
- The signature line `}): Promise<void> {` (line 94) becomes `}): Promise<boolean> {`.
- Inside the `if (!email) {` block, `return;` becomes `return false;`.
- After the final `await email.sendEmail({ … });` call (it ends at line 188), add `return true;`.
- Add this JSDoc line to the function (directly above `export async function emailReportRun`):

```ts
/**
 * Resolves `true` once the transport accepted the message, `false` when no
 * email service is configured (nothing was sent — the schedule worker records
 * that as a failed delivery); throws whatever the transport throws.
 */
```

The rendering and the `sendEmail` arguments are untouched (`reportDelivery.snapshot.test.ts` pins them).

- [ ] **Step 4: Implement the recipient sets in the worker**

In `apps/api/src/jobs/reportScheduleWorker.ts`, replace the whole `resolveScheduledReportRecipients` function (lines 339-404, from `export async function resolveScheduledReportRecipients(args: {` through its closing `}`) with:

```ts
/**
 * Who a scheduled run emails, split the way `report_runs` records it
 * (multi-org report series W01, spec §3.2 / §3.5):
 *
 *  - `customer`: everyone the definition itself names — its contact
 *    recipients (report_schedule_recipients → contacts of the owning org)
 *    followed by its valid `config.emailRecipients` addresses, deduped
 *    case-insensitively (contacts first). `recipient_count` is
 *    `customer.length`. A non-series report has no internal-CC concept, so
 *    typed addresses ARE customers: a report that emails only typed
 *    addresses records recipient_count = N (coordinator ruling, 2026-09-28).
 *  - `cc`: always `[]` from this resolver. Only a W02 series child has an
 *    internal CC (its series' `internal_cc`), resolved by W02's
 *    `resolveSeriesChildRecipients`, which returns the same shape.
 *  - `recipients`: `customer` then `cc`, capped at 50 — exactly what is sent,
 *    in the same order as before W01.
 *  - `dropped`: configured addresses that will NOT be sent — a contact with no
 *    or an invalid email, an invalid `emailRecipients` entry, anything past the
 *    cap. A duplicate is not a drop: the address still receives the report.
 */
export interface ScheduledRecipientSets {
  customer: string[];
  cc: string[];
  recipients: string[];
  dropped: number;
}

const MAX_SCHEDULED_RECIPIENTS = 50;

export async function resolveScheduledReportRecipientSets(args: {
  reportId: string;
  /** NULL for a partner-owned definition (#3198 W01): contact recipients are
   *  org-scoped rows, so only `config.emailRecipients` applies (spec §3.1a). */
  orgId: string | null;
  config: Record<string, unknown>;
}): Promise<ScheduledRecipientSets> {
  const contactRows = args.orgId === null ? [] : await db
    .select({
      contactId: contacts.id,
      email: contacts.email,
    })
    .from(reportScheduleRecipients)
    .innerJoin(
      contacts,
      and(
        eq(contacts.id, reportScheduleRecipients.contactId),
        eq(contacts.orgId, reportScheduleRecipients.orgId),
      ),
    )
    .where(and(
      eq(reportScheduleRecipients.reportId, args.reportId),
      eq(reportScheduleRecipients.orgId, args.orgId),
      eq(contacts.orgId, args.orgId),
    ));

  const seen = new Set<string>();
  let dropped = 0;
  const take = (value: unknown, into: string[]): void => {
    if (!validEmail(value)) {
      dropped += 1;
      return;
    }
    const email = value.trim();
    const key = email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    into.push(email);
  };

  // Contacts first, then typed addresses — the pre-W01 union order.
  const customerAll: string[] = [];
  for (const row of contactRows) {
    if (!row.email) {
      console.warn(
        '[ReportScheduleWorker] Recipient contact has no email; skipping',
        {
          reportId: args.reportId,
          contactId: row.contactId,
        },
      );
      dropped += 1;
      continue;
    }
    take(row.email, customerAll);
  }

  const legacy = args.config.emailRecipients;
  if (Array.isArray(legacy)) {
    for (const value of legacy) take(value, customerAll);
  }

  const requested = customerAll.length;
  if (requested > MAX_SCHEDULED_RECIPIENTS) {
    console.warn(
      '[ReportScheduleWorker] Recipient union exceeds 50; truncating',
      {
        reportId: args.reportId,
        requested,
      },
    );
    dropped += requested - MAX_SCHEDULED_RECIPIENTS;
  }
  const customer = customerAll.slice(0, MAX_SCHEDULED_RECIPIENTS);
  const cc: string[] = [];
  return { customer, cc, recipients: [...customer, ...cc], dropped };
}

/** The flat address list a scheduled run emails — `resolveScheduledReportRecipientSets(...).recipients`. */
export async function resolveScheduledReportRecipients(args: {
  reportId: string;
  orgId: string | null;
  config: Record<string, unknown>;
}): Promise<string[]> {
  return (await resolveScheduledReportRecipientSets(args)).recipients;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/reportDelivery src/jobs/reportScheduleWorker.test.ts`
Expected: PASS. That covers the new cases plus the unchanged `resolveScheduledReportRecipients` cases (47 recipients; 50-cap with `requested: 61`) and `reportDelivery.snapshot.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/reportDelivery.ts apps/api/src/services/reportDelivery.status.test.ts apps/api/src/jobs/reportScheduleWorker.ts apps/api/src/jobs/reportScheduleWorker.test.ts
git commit -m "feat(reports): scheduled recipient sets and the delivery-status rule (multi-org series W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The worker records every scheduled delivery, including nobody

**Files:**
- Modify: `apps/api/src/jobs/reportScheduleWorker.ts`: imports (line 56); the delivery block in `processRunScheduledReport` (lines 801-834); a new `recordRunDelivery` above `processRunScheduledReport`.
- Modify: `apps/api/src/routes/reports/partnerOwnedVisibility.scan.test.ts` (the `src/jobs/reportScheduleWorker.ts` entry in `SITE_ALLOWLIST`, around line 268)
- Test: `apps/api/src/jobs/reportScheduleWorker.test.ts`
- Create: `apps/api/src/__tests__/integration/reportsOrgVisibility.integration.test.ts`

**Interfaces:**
- Consumes: `resolveScheduledReportRecipientSets`, `scheduledDeliveryStatus`, `ScheduledSendOutcome`, `ReportDeliveryStatus`, and `emailReportRun(): Promise<boolean>` (Task 2).
- Produces: every completed scheduled run carries `delivery_status ∈ {sent, partial, no_recipients, failed}` and `recipient_count`. W02's worker gate records its skips on the same columns.

- [ ] **Step 1: Write the failing worker tests**

In `apps/api/src/jobs/reportScheduleWorker.test.ts`:

(a) Add a default update chain to the top-level `beforeEach`. A run now performs a third update (the delivery summary), and a test that queues only two must not crash on it. Replace:

```ts
  updateMock.mockReset();
```
with:
```ts
  updateMock.mockReset();
  // Multi-org series W01: a completed scheduled run makes one more update (its
  // delivery summary); unqueued updates get a harmless chain.
  updateMock.mockReturnValue(updateChain());
```

(b) Add `import { getEmailService } from '../services/email';` directly after the `import { persistedSiteScopeValues } from '../services/siteScope';` line (line 252).

(c) Replace the tail of `it('skips its own lastGeneratedAt stamp when the caller already claimed the occurrence', …)`:

```ts
    // Exactly one update — the reportRuns completion. If the stamp update also
    // fired, updateMock would have been called twice, same as the unclaimed
    // test above.
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(runCompleteUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' }),
    );
```
with:
```ts
    // Two updates — the run completion, then its delivery summary (W01). If
    // the stamp update also fired there would be three, like the unclaimed
    // test above.
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(runCompleteUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' }),
    );
    expect(updateMock.mock.results[1]!.value.set).toHaveBeenCalledWith({
      deliveryStatus: 'no_recipients',
      recipientCount: 0,
    });
```

(d) Add this nested describe as the last block inside `describe('processRunScheduledReport', () => { … })`. It uses that describe's `report` fixture:

```ts
  describe('delivery summary on the run (multi-org report series W01)', () => {
    /** stamp lastGeneratedAt, complete the run, then the delivery summary. */
    function queueRunUpdates() {
      const updates = [updateChain(), updateChain(), updateChain()];
      updateMock
        .mockReturnValueOnce(updates[0])
        .mockReturnValueOnce(updates[1])
        .mockReturnValueOnce(updates[2]);
      return updates;
    }

    function startRun(config: Record<string, unknown>, contacts: unknown[] = []) {
      selectMock.mockReturnValueOnce(selectChain([{ ...report, config }]));
      selectMock.mockReturnValueOnce(selectChain(contacts)); // scheduled contact recipients
      insertMock.mockReturnValueOnce(insertChain([{ id: RUN_ID }]));
      generateReportMock.mockResolvedValueOnce({ rows: [{ hostname: 'pc-1' }], rowCount: 1 });
    }

    const run = () =>
      processRunScheduledReport({
        type: 'run-scheduled-report',
        reportId: REPORT_ID,
        occurrenceKey: 202607010900,
      });

    it('records no_recipients, and sends nothing, when the schedule resolves nobody', async () => {
      startRun({ schedule: { time: '09:00' } });
      const updates = queueRunUpdates();

      await run();

      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(updates[1]!.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
      expect(updates[2]!.set).toHaveBeenCalledWith({
        deliveryStatus: 'no_recipients',
        recipientCount: 0,
      });
    });

    it('records no_recipients (not partial) when every configured address was unusable', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      startRun({ schedule: { time: '09:00' } }, [{ contactId: 'contact-1', email: null }]);
      const updates = queueRunUpdates();

      try {
        await run();
      } finally {
        warn.mockRestore();
      }

      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(updates[2]!.set).toHaveBeenCalledWith({
        deliveryStatus: 'no_recipients',
        recipientCount: 0,
      });
    });

    it('records sent and counts contacts and typed addresses alike (a non-series report has no CC)', async () => {
      startRun(
        { schedule: { time: '09:00' }, emailRecipients: ['typed@customer.test'] },
        [
          { contactId: 'contact-1', email: 'a@customer.test' },
          { contactId: 'contact-2', email: 'b@customer.test' },
        ],
      );
      const updates = queueRunUpdates();

      await run();

      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      expect((sendEmailMock.mock.calls[0]![0] as { to: string[] }).to).toEqual([
        'a@customer.test',
        'b@customer.test',
        'typed@customer.test',
      ]);
      expect(updates[2]!.set).toHaveBeenCalledWith({ deliveryStatus: 'sent', recipientCount: 3 });
    });

    it('records sent with recipient_count = N for a legacy report that emails only typed addresses', async () => {
      startRun({
        schedule: { time: '09:00' },
        emailRecipients: ['ops@acme.test', 'owner@acme.test', 'billing@acme.test'],
      });
      const updates = queueRunUpdates();

      await run();

      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      // Coordinator ruling (2026-09-28): typed addresses are the non-series
      // report's customers — never 0 just because no contact row exists.
      expect(updates[2]!.set).toHaveBeenCalledWith({ deliveryStatus: 'sent', recipientCount: 3 });
    });

    it('records partial when a configured address was dropped but the email left', async () => {
      startRun({ schedule: { time: '09:00' }, emailRecipients: ['ops@example.com', 'not-an-email'] });
      const updates = queueRunUpdates();

      await run();

      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      expect(updates[2]!.set).toHaveBeenCalledWith({ deliveryStatus: 'partial', recipientCount: 1 });
    });

    it('records failed when the transport throws, and still completes the run', async () => {
      startRun({ schedule: { time: '09:00' }, emailRecipients: ['ops@example.com'] });
      const updates = queueRunUpdates();
      sendEmailMock.mockRejectedValueOnce(new Error('smtp down'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        await run();
      } finally {
        consoleError.mockRestore();
      }

      expect(updates[1]!.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
      expect(updates[2]!.set).toHaveBeenCalledWith({ deliveryStatus: 'failed', recipientCount: 1 });
    });

    it('records failed when no email service is configured (nothing left the platform)', async () => {
      startRun({ schedule: { time: '09:00' }, emailRecipients: ['ops@example.com'] });
      const updates = queueRunUpdates();
      vi.mocked(getEmailService).mockReturnValueOnce(null as never);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      try {
        await run();
      } finally {
        warn.mockRestore();
      }

      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(updates[2]!.set).toHaveBeenCalledWith({ deliveryStatus: 'failed', recipientCount: 1 });
    });

    it('keeps the run completed and does not throw when the summary write fails', async () => {
      startRun({ schedule: { time: '09:00' }, emailRecipients: ['ops@example.com'] });
      const updates = queueRunUpdates();
      const blip = new Error('db blip');
      updates[2]!.where = vi.fn(async () => {
        throw blip;
      });
      captureExceptionMock.mockClear();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        // A throw here would mark a DELIVERED run failed and let BullMQ retry
        // the occurrence — re-sending the email.
        await expect(run()).resolves.toBeUndefined();
      } finally {
        consoleError.mockRestore();
      }

      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      expect(updateMock).toHaveBeenCalledTimes(3);
      expect(updates[1]!.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
      expect(captureExceptionMock).toHaveBeenCalledWith(blip);
    });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/jobs/reportScheduleWorker.test.ts`
Expected: FAIL.
- Each new case: `updates[2].set` was never called, because the third update does not exist yet.
- The edited "skips its own stamp" case: `expected 1 to be 2 calls`.

- [ ] **Step 3: Implement the delivery tail**

In `apps/api/src/jobs/reportScheduleWorker.ts`:

Replace the import on line 56:

```ts
import { emailReportFailure, emailReportRun } from '../services/reportDelivery';
```
with:
```ts
import {
  emailReportFailure,
  emailReportRun,
  scheduledDeliveryStatus,
  type ReportDeliveryStatus,
  type ScheduledSendOutcome,
} from '../services/reportDelivery';
```

Add, directly above `export async function processRunScheduledReport(`:

```ts
/**
 * Writes a scheduled run's delivery summary (multi-org report series W01,
 * spec §3.2). Never throws: by the time it runs the report is stored and the
 * email may already be out — a throw would reach the job's catch, mark a
 * delivered run failed, and let BullMQ retry (re-send) the occurrence.
 */
async function recordRunDelivery(
  runId: string,
  summary: { deliveryStatus: ReportDeliveryStatus; recipientCount: number },
): Promise<void> {
  try {
    await db.update(reportRuns).set(summary).where(eq(reportRuns.id, runId));
  } catch (err) {
    console.error('[ReportScheduleWorker] Could not record the delivery summary', { runId, err });
    captureException(err);
  }
}
```

In `processRunScheduledReport`, replace the block that starts at `const recipients = await resolveScheduledReportRecipients({` (line 802) and ends at the closing `}` of `if (recipients.length > 0) { … }` (line 834, just before `} catch (err) {` on line 835) with:

```ts
    const recipientSets = await resolveScheduledReportRecipientSets({
      reportId: report.id,
      orgId: owner.orgId ?? null,
      config,
    });
    let send: ScheduledSendOutcome = 'not_attempted';
    if (recipientSets.recipients.length > 0) {
      try {
        // Timezone + branding are only needed to build the email — deferred
        // here (rather than fetched unconditionally for every run) so a
        // transient failure in either lookup can't sink a no-recipient run's
        // occurrence-keyed job (a failed job blocks re-enqueue of that
        // occurrence, and by this point the run row is already stored).
        const delivery = await resolveScheduledDeliveryContext(owner);

        const handedOff = await emailReportRun({
          reportName: report.name,
          reportType: report.type,
          format: report.format,
          recipients: recipientSets.recipients,
          rows,
          summary: result.summary,
          previous: result.previous,
          trendLine: trendLineOf(result),
          timezone: delivery.timeZone,
          branding: delivery.branding,
          partnerId: delivery.partnerId,
        });
        send = handedOff ? 'sent' : 'failed';
      } catch (err) {
        // Delivery failure must not fail the (already stored) run — but the
        // recipients silently got nothing, so it goes to error tracking.
        console.error(`[ReportScheduleWorker] Email delivery failed for report ${report.id}:`, err);
        captureException(err);
        send = 'failed';
      }
    }
    // Multi-org series W01 (spec §1): a run that reached nobody used to be a
    // silent skip. Record what the email did on the run itself, after the
    // send, so the status is the send's real outcome.
    await recordRunDelivery(run.id, {
      deliveryStatus: scheduledDeliveryStatus({
        deliverable: recipientSets.recipients.length,
        dropped: recipientSets.dropped,
        send,
      }),
      recipientCount: recipientSets.customer.length,
    });
```

The failure-notice path further down (`if (opts.finalAttempt) { const recipients = await resolveScheduledReportRecipients({ … })`) is unchanged. A run that failed to generate keeps `delivery_status` NULL, and its `status` already says `failed`.

- [ ] **Step 4: Run the worker tests**

Run: `cd apps/api && npx vitest run src/jobs/reportScheduleWorker src/services/reportDelivery`
Expected: PASS. That covers every worker file: `.test`, `.due.test`, `.claimSql.test` and `.contract.test`.

- [ ] **Step 5: Run the partner-owned visibility scan and see the new site go red**

Run: `cd apps/api && npx vitest run src/routes/reports/partnerOwnedVisibility.scan.test.ts`
Expected: FAIL. The unguarded query site is `.update(reportRuns)` in scope `recordRunDelivery` of `src/jobs/reportScheduleWorker.ts`.

- [ ] **Step 6: Allowlist `recordRunDelivery` with a pinned count**

In `apps/api/src/routes/reports/partnerOwnedVisibility.scan.test.ts`, change the `src/jobs/reportScheduleWorker.ts` entry of `SITE_ALLOWLIST` from:

```ts
  ['src/jobs/reportScheduleWorker.ts', new Map([
    ['findDueReports', pinned(2, 'system DB context due scan; nothing selected is shown to anyone — every due row is re-authorized per run (#3198 W01 Task 6)', AUD_WORKER)],
    ['claimReportOccurrence', pinned(1, 'system DB context occurrence CAS by report id on a row findDueReports selected', AUD_WORKER)],
    ['processRunScheduledReport', pinned(4, 'system DB context, reads by id, re-asserts live partner authority per row before generating (#3198 W01 Task 6); run updates target the run it inserted', AUD_WORKER)],
  ])],
```
to:
```ts
  ['src/jobs/reportScheduleWorker.ts', new Map([
    ['findDueReports', pinned(2, 'system DB context due scan; nothing selected is shown to anyone — every due row is re-authorized per run (#3198 W01 Task 6)', AUD_WORKER)],
    ['claimReportOccurrence', pinned(1, 'system DB context occurrence CAS by report id on a row findDueReports selected', AUD_WORKER)],
    ['processRunScheduledReport', pinned(4, 'system DB context, reads by id, re-asserts live partner authority per row before generating (#3198 W01 Task 6); run updates target the run it inserted', AUD_WORKER)],
    ['recordRunDelivery', pinned(1, 'system DB context; writes the delivery summary onto the run processRunScheduledReport just inserted, keyed on that run id (multi-org series W01)', AUD_WORKER)],
  ])],
```

Run: `cd apps/api && npx vitest run src/routes/reports/partnerOwnedVisibility.scan.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the end-to-end worker proof (integration)**

Create `apps/api/src/__tests__/integration/reportsOrgVisibility.integration.test.ts`. Task 5 appends the list cases to this same file.

```ts
/**
 * Multi-org report series W01 — org visibility and delivery status through the
 * REAL report routes and the REAL schedule worker, against real Postgres as the
 * forced-RLS `breeze_app` role.
 *
 *  - The worker writes report_runs.delivery_status / recipient_count on a run
 *    nobody receives (the silent skip, spec §1).
 *  - GET /reports and GET /reports/runs carry the owning org (orgName via a
 *    LEFT JOIN that RLS still governs) and the delivery summary.
 *  - An org token still lists only its own org.
 */
import './setup';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { withSystemDbAccessContext } from '../../db';
import { reportRuns } from '../../db/schema';
import { processRunScheduledReport } from '../../jobs/reportScheduleWorker';
import { authMiddleware } from '../../middleware/auth';
import { reportRoutes } from '../../routes/reports';
import { createAccessToken } from '../../services/jwt';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));

const REPORT_PERMISSIONS = [
  { resource: 'reports', action: 'read' },
  { resource: 'reports', action: 'write' },
  { resource: 'reports', action: 'delete' },
  { resource: 'reports', action: 'export' },
];
// ar_aging (the partner-owned Combined case) also needs its data permission.
const AR_PERMISSIONS = [{ resource: 'invoices', action: 'read' }];

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/reports', reportRoutes);
  return app;
}

function uniqueEmail(label: string): string {
  return `reports-org-visibility-${label}-${randomUUID()}@example.com`;
}

async function call(app: Hono, token: string, method: 'GET' | 'POST', path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | undefined;
  return e?.cause?.code ?? e?.code;
}

/** Partner P with orgs A and B; an org_access='all' partner admin and an org-scope user of A. */
async function seedFixture() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id, name: `Acme Dental ${randomUUID().slice(0, 8)}` });
  const orgB = await createOrganization({ partnerId: partner.id, name: `Bravo Law ${randomUUID().slice(0, 8)}` });

  const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(partnerRole.id, [...REPORT_PERMISSIONS, ...AR_PERMISSIONS]);
  const admin = await createUser({ partnerId: partner.id, orgId: null, email: uniqueEmail('admin') });
  await assignUserToPartner(admin.id, partner.id, partnerRole.id, 'all');

  const orgRole = await createRole({ scope: 'organization', orgId: orgA.id, partnerId: partner.id });
  await grantRolePermissions(orgRole.id, REPORT_PERMISSIONS);
  const orgUser = await createUser({ partnerId: partner.id, orgId: orgA.id, email: uniqueEmail('org') });
  await assignUserToOrganization(orgUser.id, orgA.id, orgRole.id);

  const adminToken = await createAccessToken({
    sub: admin.id, email: admin.email, roleId: partnerRole.id, orgId: null, partnerId: partner.id,
    scope: 'partner', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
  const orgToken = await createAccessToken({
    sub: orgUser.id, email: orgUser.email, roleId: orgRole.id, orgId: orgA.id, partnerId: partner.id,
    scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
  return { partner, orgA, orgB, adminToken, orgToken };
}

/** A daily org-owned definition with NO recipients (no contacts, no emailRecipients). */
async function createOrgDefinition(app: Hono, token: string, orgId: string, name: string) {
  const res = await call(app, token, 'POST', '/reports', {
    orgId,
    name,
    type: 'device_inventory',
    schedule: 'daily',
    format: 'csv',
    config: { schedule: { time: '09:00' } },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; orgId: string };
}

async function runSchedule(reportId: string) {
  await withSystemDbAccessContext(() =>
    processRunScheduledReport(
      { type: 'run-scheduled-report', reportId, occurrenceKey: 202609010900 },
      { finalAttempt: true },
    ),
  );
}

async function runsOf(reportId: string) {
  return getTestDb()
    .select({
      id: reportRuns.id,
      status: reportRuns.status,
      deliveryStatus: reportRuns.deliveryStatus,
      recipientCount: reportRuns.recipientCount,
    })
    .from(reportRuns)
    .where(eq(reportRuns.reportId, reportId));
}

describe('scheduled delivery summary (multi-org series W01)', () => {
  runDb('the schedule worker records no_recipients and a zero customer count on a run nobody receives', async () => {
    const f = await seedFixture();
    const app = buildApp();
    const def = await createOrgDefinition(app, f.adminToken, f.orgA.id, 'Acme nightly');

    await runSchedule(def.id);

    const rows = await runsOf(def.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'completed', deliveryStatus: 'no_recipients', recipientCount: 0 });
  });

  runDb('the delivery_status CHECK refuses a value outside the five statuses', async () => {
    const f = await seedFixture();
    const app = buildApp();
    const def = await createOrgDefinition(app, f.adminToken, f.orgA.id, 'Acme nightly');
    await runSchedule(def.id);
    const [row] = await runsOf(def.id);

    let caught: unknown;
    try {
      await getTestDb()
        .update(reportRuns)
        .set({ deliveryStatus: 'delivered' as never })
        .where(eq(reportRuns.id, row!.id));
    } catch (error) {
      caught = error;
    }
    expect(pgCode(caught)).toBe('23514');
  });
});
```

- [ ] **Step 8: Run the integration proof**

Run:
```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/reportsOrgVisibility.integration.test.ts
```
Expected: 2 passed. If the output says `skipped`, `DATABASE_URL` is unset: re-run `pnpm test-stack up` from the worktree root.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/jobs/reportScheduleWorker.ts apps/api/src/jobs/reportScheduleWorker.test.ts apps/api/src/routes/reports/partnerOwnedVisibility.scan.test.ts apps/api/src/__tests__/integration/reportsOrgVisibility.integration.test.ts
git commit -m "feat(reports): scheduled runs record delivery_status/recipient_count, no more silent skip (multi-org series W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: A manual run of a scheduled definition is `not_scheduled`

**Files:**
- Modify: `apps/api/src/routes/reports/runs.ts` (the run insert in `POST /:id/generate`, lines 197-208)
- Test: `apps/api/src/routes/reports.test.ts` (`describe('POST /reports/:id/generate persists a snapshot', …)`, line 744)

**Interfaces:**
- Produces: the `POST /reports/:id/generate` run row has `deliveryStatus: 'not_scheduled'` when `report.schedule` is not `'one_time'`, else `null`.
  - The manual route never emails (spec §3.2: "not_scheduled for manual runs of a scheduled definition when no email was requested").
  - Task 5's `lastDeliveryStatus` subquery skips these runs.
  - Other run inserters keep `NULL` in W01: the AI `generate_report` tool, portal self-service, managed evidence, and the narrative and fleet-design persisters. None of them is a UI "Generate now" on a scheduled definition.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/routes/reports.test.ts`, add inside `describe('POST /reports/:id/generate persists a snapshot', …)` after the existing `it('generates synchronously and stores result + completed status', …)`:

```ts
  it.each([
    ['weekly', 'not_scheduled'],
    ['one_time', null],
  ] as const)(
    'stamps a manual run of a %s definition with deliveryStatus %s (multi-org series W01)',
    async (schedule, expected) => {
      const app = new Hono();
      app.route('/reports', reportRoutes);
      vi.mocked(db.update).mockReturnValue({
        set: () => ({ where: () => Promise.resolve() })
      } as any);
      vi.mocked(db.select).mockImplementation(() =>
        selectChain([{
          id: 'rep-1',
          orgId: ORG_ID,
          type: 'device_inventory',
          name: 'Inv',
          config: {},
          format: 'csv',
          schedule
        }])
      );
      const insertValuesMock = vi.fn(() => ({
        returning: () => Promise.resolve([{ id: 'run-1', status: 'pending' }]),
      }));
      vi.mocked(db.insert).mockReturnValue({ values: insertValuesMock } as any);

      const res = await app.request('/reports/rep-1/generate', { method: 'POST' });

      expect(res.status).toBe(200);
      expect(insertValuesMock).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryStatus: expected }),
      );
    },
  );
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/reports.test.ts -t "stamps a manual run"`
Expected: FAIL, 2 cases. The insert values have no `deliveryStatus` key (`expected … to have been called with ObjectContaining{deliveryStatus: 'not_scheduled'}`).

- [ ] **Step 3: Implement**

In `apps/api/src/routes/reports/runs.ts`, in `POST /:id/generate`, replace:

```ts
    // Create a new report run
    const [run] = await db
      .insert(reportRuns)
      .values({
        reportId: report.id,
        status: 'pending',
        startedAt: new Date(),
        requestedByKind: 'user',
        requestedByUserId: auth.user.id,
        requestedByPortalUserId: null,
        ...persistedSiteScopeValues(executionAuthority),
      })
      .returning();
```
with:
```ts
    // Create a new report run. Multi-org series W01 (spec §3.2): this route
    // never emails, so a manual run of a SCHEDULED definition is recorded as
    // 'not_scheduled' — distinct from the schedule's own deliveries, which the
    // list's latest-delivery warning reads. A one-time definition has no
    // schedule to contrast with and stays NULL.
    const deliveryStatus = report.schedule && report.schedule !== 'one_time'
      ? ('not_scheduled' as const)
      : null;
    const [run] = await db
      .insert(reportRuns)
      .values({
        reportId: report.id,
        status: 'pending',
        startedAt: new Date(),
        requestedByKind: 'user',
        requestedByUserId: auth.user.id,
        requestedByPortalUserId: null,
        deliveryStatus,
        ...persistedSiteScopeValues(executionAuthority),
      })
      .returning();
```

- [ ] **Step 4: Run the route tests**

Run: `cd apps/api && npx vitest run src/routes/reports.test.ts src/routes/reports/runs`
Expected: PASS. That covers the new cases plus `runs.audit`, `runs.fromArtifact` and `runs.systemPrincipal`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/reports/runs.ts apps/api/src/routes/reports.test.ts
git commit -m "feat(reports): manual generate of a scheduled report records not_scheduled (multi-org series W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `orgName` and delivery fields on `GET /reports` and `GET /reports/runs`

**Files:**
- Modify: `apps/api/src/routes/reports/core.ts`: imports (lines 3-5); the list query in `GET /` (lines 415-423).
- Modify: `apps/api/src/routes/reports/runs.ts`: import (line 5); the list query in `GET /runs` (lines 419-438).
- Modify: `apps/api/src/routes/reports.test.ts`:
  - the drizzle-orm mock (line 123) and the schema mock (line 166);
  - `mockDefinitionPage` and `mockPredicateFilteredDefinitionPage` (lines 865-930);
  - new cases.
- Modify: `apps/api/src/routes/reports/systemManaged.test.ts` (the select-chain method list, line 76)
- Test: `apps/api/src/__tests__/integration/reportsOrgVisibility.integration.test.ts` (append)

**Interfaces:**
- Consumes: `reportRuns.deliveryStatus` and `reportRuns.recipientCount` (Task 1); `ReportDeliveryStatus` from `services/reportDelivery.ts` (Task 2).
- Produces:
  - `GET /reports` rows are the full `reports` row plus `orgName: string | null` and `lastDeliveryStatus: 'sent' | 'partial' | 'no_recipients' | 'failed' | null`. `lastDeliveryStatus` is the newest run whose status is in that set; `not_scheduled` and NULL runs are ignored.
  - `GET /reports/runs` rows add `orgId: string | null`, `orgName: string | null`, `deliveryStatus: ReportDeliveryStatus | null` and `recipientCount: number | null`.
  - A partner-owned row has `orgId` NULL, so `orgName` is null.
  - The web (Task 6) reads exactly these names.

- [ ] **Step 1: Update the route-test mocks and write the failing unit tests**

In `apps/api/src/routes/reports.test.ts`:

(a) In the `vi.mock('drizzle-orm', () => ({ … }))` factory (line 123), add a `getTableColumns` passthrough. The route spreads it into its projection, so the mocked `reports` table object becomes the column map:

```ts
  // Multi-org series W01 — GET /reports spreads the table's columns into its
  // projection; the mocked table object IS its column map here.
  getTableColumns: (table: Record<string, unknown>) => ({ ...table }),
```

(b) In the `vi.mock('../db/schema', () => ({ … }))` factory:
- replace `organizations: {},` with `organizations: { id: 'organizations.id', name: 'organizations.name' },`;
- in the `reportRuns: { … }` entry, add after `executionScopePrincipalKind: 'reportRuns.executionScopePrincipalKind'`:

```ts
    ,
    deliveryStatus: 'reportRuns.deliveryStatus',
    recipientCount: 'reportRuns.recipientCount'
```
Put the comma after the existing last property rather than on its own line if your editor prefers. The object must end up with both keys.

(c) Replace `mockDefinitionPage` and `mockPredicateFilteredDefinitionPage` (lines 865-930). The page query now goes `.from(reports).leftJoin(organizations, …).where(…)`. The count query is unchanged.

```ts
  function mockDefinitionPage(
    rows: unknown[],
    total: number,
    capturedConditions: unknown[]
  ) {
    const leftJoin = vi.fn(() => ({
      where: vi.fn((condition) => {
        capturedConditions.push(condition);
        return {
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              offset: vi.fn().mockResolvedValue(rows)
            })
          })
        };
      })
    }));
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn((condition) => {
            capturedConditions.push(condition);
            return Promise.resolve([{ count: total }]);
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ leftJoin })
      } as any);
    return { leftJoin };
  }

  function mockPredicateFilteredDefinitionPage(
    sourceRows: Array<{ id: string }>,
    visibleIds: readonly string[],
    expectedPredicate: unknown,
    capturedConditions: unknown[],
  ) {
    const visibleIdSet = new Set(visibleIds);
    const rowsFor = (condition: unknown) =>
      conditionContainsIdentity(condition, expectedPredicate)
        ? sourceRows.filter((row) => visibleIdSet.has(row.id))
        : sourceRows;

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn((condition) => {
            capturedConditions.push(condition);
            return Promise.resolve([{ count: rowsFor(condition).length }]);
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn(() => ({
            where: vi.fn((condition) => {
              capturedConditions.push(condition);
              return {
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn((limit: number) => ({
                    offset: vi.fn((offset: number) =>
                      Promise.resolve(rowsFor(condition).slice(offset, offset + limit))
                    )
                  }))
                })
              };
            })
          }))
        })
      } as any);
  }
```

The `/templates` helper `captureTemplatesSelect` (line ~1815) is **not** changed. `GET /reports/templates` keeps its plain `select().from(reports).where(...)` query.

(d) Add inside `describe('report definition scope enforcement', …)`, after `it('uses one partner-composite predicate for a no-org list', …)`:

```ts
  it('joins the owning org name and the latest scheduled delivery onto every listed definition (multi-org series W01)', async () => {
    const captured: unknown[] = [];
    const { leftJoin } = mockDefinitionPage(
      [{ id: REPORT_ID, orgId: ORG_ID, orgName: 'Acme Dental', lastDeliveryStatus: 'no_recipients' }],
      1,
      captured
    );

    const response = await app().request('/reports');

    expect(response.status).toBe(200);
    expect((await response.json()).data[0]).toMatchObject({
      orgName: 'Acme Dental',
      lastDeliveryStatus: 'no_recipients'
    });
    const projection = vi.mocked(db.select).mock.calls[1]![0] as unknown as Record<string, unknown>;
    // Every reports column is still returned (getTableColumns), plus the two new fields.
    expect(projection).toMatchObject({
      id: 'reports.id',
      orgId: 'reports.orgId',
      name: 'reports.name',
      orgName: 'organizations.name'
    });
    expect(projection.lastDeliveryStatus).toMatchObject({ op: 'sql' });
    expect(leftJoin).toHaveBeenCalledWith(
      { id: 'organizations.id', name: 'organizations.name' },
      { op: 'eq', column: 'organizations.id', value: 'reports.orgId' }
    );
  });
```

(e) Add inside `describe('report run immutable scope enforcement', …)`, after `it('omits denied and restricted-empty partner organizations from the run composite', …)`:

```ts
  it('projects the owning org and the delivery summary onto every listed run (multi-org series W01)', async () => {
    const app = new Hono();
    app.route('/reports', reportRoutes);
    siteScopeState.result = authority('unrestricted') as any;
    const captured: unknown[] = [];
    const page = capturedSelectChain(
      [{
        id: RUN_ID,
        reportId: REPORT_ID,
        orgId: ORG_A,
        orgName: 'Acme Dental',
        deliveryStatus: 'no_recipients',
        recipientCount: 0,
      }],
      captured,
    );
    vi.mocked(db.select)
      .mockReturnValueOnce(capturedSelectChain([{ count: 1 }], captured))
      .mockReturnValueOnce(page);

    const res = await app.request('/reports/runs?limit=2');

    expect(res.status).toBe(200);
    expect((await res.json()).data[0]).toMatchObject({
      orgId: ORG_A,
      orgName: 'Acme Dental',
      deliveryStatus: 'no_recipients',
      recipientCount: 0,
    });
    expect(vi.mocked(db.select).mock.calls[1]![0]).toMatchObject({
      orgId: 'reports.orgId',
      orgName: 'organizations.name',
      deliveryStatus: 'reportRuns.deliveryStatus',
      recipientCount: 'reportRuns.recipientCount',
    });
    expect(page.leftJoin).toHaveBeenCalledWith(
      { id: 'organizations.id', name: 'organizations.name' },
      { op: 'eq', column: 'organizations.id', value: 'reports.orgId' },
    );
  });
```

(f) In `apps/api/src/routes/reports/systemManaged.test.ts`, line 76, change

```ts
    for (const method of ['from', 'innerJoin', 'where', 'orderBy', 'offset', 'limit', 'for']) {
```
to
```ts
    for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'offset', 'limit', 'for']) {
```

`core.partnerOwned.test.ts` and `mspStaffAudience.test.ts` already list `leftJoin` in their chains, and they use the real schema and real drizzle. They need no edit.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/reports.test.ts src/routes/reports/systemManaged.test.ts`
Expected: FAIL.
- The two new cases fail: no `orgName`/`lastDeliveryStatus` in the response or projection, and `leftJoin` is never called.
- Every existing `GET /reports` list case built on `mockDefinitionPage` / `mockPredicateFilteredDefinitionPage` also fails, with 500 (`where is not a function`), because the helpers now expect a `leftJoin` hop.

That red is intended. It proves the helpers are on the list path.

- [ ] **Step 3: Implement the definition list projection**

In `apps/api/src/routes/reports/core.ts`:

Replace lines 3-5:
```ts
import { and, eq, or, sql, desc, inArray, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { reports, reportRuns } from '../../db/schema';
```
with:
```ts
import { and, eq, or, sql, desc, inArray, getTableColumns, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { organizations, reports, reportRuns } from '../../db/schema';
import type { ReportDeliveryStatus } from '../../services/reportDelivery';
```

In `GET /`, replace:
```ts
    // Get reports
    const reportsList = await db
      .select()
      .from(reports)
      .where(whereCondition)
      .orderBy(desc(reports.updatedAt), desc(reports.id))
      .limit(limit)
      .offset(offset);
```
with:
```ts
    // Get reports. Multi-org series W01 (spec §3.6):
    //  - orgName — LEFT join: a partner-owned row has no org (null), and an org
    //    the caller's RLS context cannot read yields null instead of dropping
    //    the row; which rows are listed is still decided by whereCondition.
    //  - lastDeliveryStatus — the newest SCHEDULED delivery outcome (manual
    //    'not_scheduled' runs and pre-W01 NULL runs are skipped), for the list's
    //    no-recipients warning. One indexed lookup per listed row
    //    (report_runs_report_id_created_at_idx); report_runs RLS applies inside.
    const reportsList = await db
      .select({
        ...getTableColumns(reports),
        orgName: organizations.name,
        lastDeliveryStatus: sql<Exclude<ReportDeliveryStatus, 'not_scheduled'> | null>`(
          SELECT ${reportRuns.deliveryStatus}
          FROM ${reportRuns}
          WHERE ${reportRuns.reportId} = ${reports.id}
            AND ${reportRuns.deliveryStatus} IN ('sent', 'partial', 'no_recipients', 'failed')
          ORDER BY ${reportRuns.createdAt} DESC, ${reportRuns.id} DESC
          LIMIT 1
        )`,
      })
      .from(reports)
      .leftJoin(organizations, eq(organizations.id, reports.orgId))
      .where(whereCondition)
      .orderBy(desc(reports.updatedAt), desc(reports.id))
      .limit(limit)
      .offset(offset);
```

`reportRuns` is already imported in `core.ts`. The count query above it is unchanged, since its WHERE references only `reports` columns. Every predicate in `whereCondition` interpolates Drizzle columns, so they render table-qualified and the join cannot make them ambiguous.

- [ ] **Step 4: Implement the runs list projection**

In `apps/api/src/routes/reports/runs.ts`, replace line 5:
```ts
import { reports, reportRuns } from '../../db/schema';
```
with:
```ts
import { organizations, reports, reportRuns } from '../../db/schema';
```

In `GET /runs`, replace the page query:
```ts
    // Get runs with report info
    const runsList = await db
      .select({
        id: reportRuns.id,
        reportId: reportRuns.reportId,
        status: reportRuns.status,
        startedAt: reportRuns.startedAt,
        completedAt: reportRuns.completedAt,
        outputUrl: reportRuns.outputUrl,
        errorMessage: reportRuns.errorMessage,
        rowCount: reportRuns.rowCount,
        createdAt: reportRuns.createdAt,
        reportName: reports.name,
        reportType: reports.type
      })
      .from(reportRuns)
      .innerJoin(reports, eq(reportRuns.reportId, reports.id))
      .where(whereCondition)
```
with:
```ts
    // Get runs with report info. Multi-org series W01 (spec §3.6): the owning
    // org (LEFT join — a partner-owned definition has none) and the run's
    // delivery summary.
    const runsList = await db
      .select({
        id: reportRuns.id,
        reportId: reportRuns.reportId,
        status: reportRuns.status,
        startedAt: reportRuns.startedAt,
        completedAt: reportRuns.completedAt,
        outputUrl: reportRuns.outputUrl,
        errorMessage: reportRuns.errorMessage,
        rowCount: reportRuns.rowCount,
        createdAt: reportRuns.createdAt,
        reportName: reports.name,
        reportType: reports.type,
        orgId: reports.orgId,
        orgName: organizations.name,
        deliveryStatus: reportRuns.deliveryStatus,
        recipientCount: reportRuns.recipientCount
      })
      .from(reportRuns)
      .innerJoin(reports, eq(reportRuns.reportId, reports.id))
      .leftJoin(organizations, eq(organizations.id, reports.orgId))
      .where(whereCondition)
```
The `.orderBy(...)`, `.limit(...)` and `.offset(...)` lines after it are unchanged. The count query is unchanged.

- [ ] **Step 5: Run the unit tests**

Run: `cd apps/api && npx vitest run src/routes/reports.test.ts src/routes/reports/`
Expected: PASS. That covers `reports.test.ts` and every file under `routes/reports/`, including `core.partnerOwned`, `mspStaffAudience`, `systemManaged` and `partnerOwnedVisibility.scan`.

The subquery in `GET /` is a query site in the `GET /` scope. That scope already calls the `resolveDefinitionListScope` guard entrypoint, so the scan stays green with no allowlist change. If the scan reports `GET /` in `core.ts`, stop and ask: the scope's guard detection has changed.

- [ ] **Step 6: Append the list cases to the integration suite**

Append to `apps/api/src/__tests__/integration/reportsOrgVisibility.integration.test.ts`:

```ts
type ListedDefinition = { id: string; orgId: string | null; orgName: string | null; lastDeliveryStatus: string | null };
type ListedRun = {
  id: string;
  reportId: string;
  orgId: string | null;
  orgName: string | null;
  deliveryStatus: string | null;
  recipientCount: number | null;
};

describe('org visibility on the report lists (multi-org series W01)', () => {
  runDb('a partner admin lists every org\'s definitions and runs with the owning org name and delivery summary', async () => {
    const f = await seedFixture();
    const app = buildApp();
    const a = await createOrgDefinition(app, f.adminToken, f.orgA.id, 'Acme nightly');
    const b = await createOrgDefinition(app, f.adminToken, f.orgB.id, 'Bravo nightly');
    await runSchedule(a.id);
    // A manual run of B's scheduled definition: not_scheduled, and it never
    // becomes B's "latest scheduled delivery".
    expect((await call(app, f.adminToken, 'POST', `/reports/${b.id}/generate`)).status).toBe(200);

    const list = await call(app, f.adminToken, 'GET', '/reports?limit=100');
    expect(list.status).toBe(200);
    const rows = ((await list.json()) as { data: ListedDefinition[] }).data;
    expect(rows.find((r) => r.id === a.id)).toMatchObject({
      orgId: f.orgA.id,
      orgName: f.orgA.name,
      lastDeliveryStatus: 'no_recipients',
    });
    expect(rows.find((r) => r.id === b.id)).toMatchObject({
      orgId: f.orgB.id,
      orgName: f.orgB.name,
      lastDeliveryStatus: null,
    });

    const runsRes = await call(app, f.adminToken, 'GET', '/reports/runs?limit=100');
    expect(runsRes.status).toBe(200);
    const runs = ((await runsRes.json()) as { data: ListedRun[] }).data;
    expect(runs.find((r) => r.reportId === a.id)).toMatchObject({
      orgId: f.orgA.id,
      orgName: f.orgA.name,
      deliveryStatus: 'no_recipients',
      recipientCount: 0,
    });
    expect(runs.find((r) => r.reportId === b.id)).toMatchObject({
      orgId: f.orgB.id,
      orgName: f.orgB.name,
      deliveryStatus: 'not_scheduled',
      recipientCount: null,
    });
  });

  runDb('an org token lists only its own org\'s definitions and runs, named, never the sibling org', async () => {
    const f = await seedFixture();
    const app = buildApp();
    const a = await createOrgDefinition(app, f.adminToken, f.orgA.id, 'Acme nightly');
    const b = await createOrgDefinition(app, f.adminToken, f.orgB.id, 'Bravo nightly');
    await runSchedule(a.id);
    await runSchedule(b.id);

    const list = await call(app, f.orgToken, 'GET', '/reports?limit=100');
    expect(list.status).toBe(200);
    const rows = ((await list.json()) as { data: ListedDefinition[] }).data;
    expect(rows.map((r) => r.id)).toContain(a.id);
    expect(rows.map((r) => r.id)).not.toContain(b.id);
    expect(rows.every((r) => r.orgId === f.orgA.id && r.orgName === f.orgA.name)).toBe(true);

    const runsRes = await call(app, f.orgToken, 'GET', '/reports/runs?limit=100');
    expect(runsRes.status).toBe(200);
    const runs = ((await runsRes.json()) as { data: ListedRun[] }).data;
    expect(runs.map((r) => r.reportId)).toContain(a.id);
    expect(runs.map((r) => r.reportId)).not.toContain(b.id);
    expect(JSON.stringify(runs)).not.toContain(f.orgB.name);
  });

  runDb('a partner-owned definition lists with orgName null (the Combined kind)', async () => {
    const f = await seedFixture();
    const app = buildApp();
    const created = await call(app, f.adminToken, 'POST', '/reports', {
      ownerScope: 'partner',
      name: 'All-clients AR',
      type: 'ar_aging',
      schedule: 'monthly',
      format: 'csv',
    });
    expect(created.status).toBe(201);
    const partnerOwned = (await created.json()) as { id: string };

    const list = await call(app, f.adminToken, 'GET', '/reports?ownerScope=partner&limit=100');
    expect(list.status).toBe(200);
    const row = ((await list.json()) as { data: ListedDefinition[] }).data.find((r) => r.id === partnerOwned.id);
    expect(row).toMatchObject({ orgId: null, orgName: null, lastDeliveryStatus: null });
  });
});
```

- [ ] **Step 7: Run the integration suites that read the report lists**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/reportsOrgVisibility.integration.test.ts \
  src/__tests__/integration/reportsPartnerOwned.integration.test.ts \
  src/__tests__/integration/reportHistoryRoutes.integration.test.ts \
  src/__tests__/integration/report-site-scope.integration.test.ts
```
Expected: all pass. `reportsOrgVisibility` has 5 tests.

The other three prove the join did not change who lists what:
- partner-owned visibility;
- history orgs;
- restricted site scope.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/reports/core.ts apps/api/src/routes/reports/runs.ts apps/api/src/routes/reports.test.ts apps/api/src/routes/reports/systemManaged.test.ts apps/api/src/__tests__/integration/reportsOrgVisibility.integration.test.ts
git commit -m "feat(reports): orgName + delivery summary on the report and run lists (multi-org series W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Covers column, no-recipients warning, Org column on Recent Runs, and locale strings

**Files:**
- Create: `apps/web/src/components/reports/DeliveryStatusChip.tsx`
- Create: `apps/web/src/components/reports/CoversCell.tsx`, `apps/web/src/components/reports/CoversCell.test.tsx`
- Modify: `apps/web/src/components/reports/ReportsList.tsx`: imports (line 23), `Report`/`ReportRun` types (lines 70-98), the saved-reports table (lines 575-700), and the runs table (lines 738-790).
- Create: `apps/web/src/components/reports/ReportsList.covers.test.tsx`
- Modify: `apps/web/src/components/reports/ReportsList.scope.test.tsx` (lines 57-67 and 110)
- Modify: all 8 `apps/web/src/locales/<locale>/reports.json`

**Interfaces:**
- Consumes: the Task 5 row fields: `orgName`, `lastDeliveryStatus`, run `orgId`, `orgName`, `deliveryStatus` and `recipientCount`.
- Produces, in `DeliveryStatusChip.tsx`:
  - `export type ReportDeliveryStatus = 'sent' | 'partial' | 'no_recipients' | 'failed' | 'not_scheduled'` (the web mirror; W03's `series/types.ts` re-exports it);
  - `export function DeliveryStatusChip(props: { status: ReportDeliveryStatus | null | undefined; testId: string; title?: string; className?: string })`.
- Produces, in `CoversCell.tsx`:
  - `export type CoversSeriesSummary = { seriesId: string; targetMode: 'all' | 'selected'; orgCount: number }`;
  - `export function CoversCell(props: { testId: string; orgId: string | null | undefined; orgName?: string | null; series?: CoversSeriesSummary | null })`.
- Produces these locale keys, all under the `reports` namespace:
  - `reports.reportsList.table.covers`
  - `reports.reportsList.runsTable.organization`
  - `reports.reportsList.covers.{combined, unknownOrg, seriesAll, seriesSelected_one, seriesSelected_other}`
  - `reports.reportsList.delivery.{noRecipients, noRecipientsHint, partial, failed}`
  - `reports.orgPicker.{label, placeholder, hint, required, chooseFirst, previewNeedsOrg}` (used by Tasks 7-8)

- [ ] **Step 1: Write the failing component tests**

Create `apps/web/src/components/reports/CoversCell.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CoversCell } from './CoversCell';

describe('CoversCell (multi-org report series W01)', () => {
  it('names the org of an org-owned report', () => {
    render(<CoversCell testId="c" orgId="org-a" orgName="Acme Dental" />);
    const cell = screen.getByTestId('c');
    expect(cell).toHaveAttribute('data-covers-kind', 'org');
    expect(cell).toHaveTextContent('Acme Dental');
  });

  it('falls back to "Unknown organization" when an org-owned row carries no name', () => {
    render(<CoversCell testId="c" orgId="org-a" orgName={null} />);
    expect(screen.getByTestId('c')).toHaveTextContent('Unknown organization');
  });

  it('renders Combined for a partner-owned row, never Unknown organization', () => {
    render(<CoversCell testId="c" orgId={null} orgName={null} />);
    const cell = screen.getByTestId('c');
    expect(cell).toHaveAttribute('data-covers-kind', 'combined');
    expect(cell).toHaveTextContent('All organizations · Combined');
    expect(cell).not.toHaveTextContent('Unknown organization');
  });

  it('renders a dash when the API sent no owner at all', () => {
    render(<CoversCell testId="c" orgId={undefined} />);
    expect(screen.getByTestId('c')).toHaveAttribute('data-covers-kind', 'unknown');
  });

  it('renders the series kind only when a series summary with an id is passed', () => {
    const { rerender } = render(
      <CoversCell testId="c" orgId={null} series={{ seriesId: 's-1', targetMode: 'all', orgCount: 18 }} />,
    );
    expect(screen.getByTestId('c')).toHaveAttribute('data-covers-kind', 'series');
    expect(screen.getByTestId('c')).toHaveTextContent('All orgs · 18 · One per organization');

    rerender(<CoversCell testId="c" orgId={null} series={{ seriesId: 's-1', targetMode: 'selected', orgCount: 1 }} />);
    expect(screen.getByTestId('c')).toHaveTextContent('1 org · One per organization');

    rerender(<CoversCell testId="c" orgId={null} series={{ seriesId: 's-1', targetMode: 'selected', orgCount: 3 }} />);
    expect(screen.getByTestId('c')).toHaveTextContent('3 orgs · One per organization');

    // A W02 child row (seriesId on the report, org set) is an ordinary org row here.
    rerender(<CoversCell testId="c" orgId="org-a" orgName="Acme Dental" series={null} />);
    expect(screen.getByTestId('c')).toHaveAttribute('data-covers-kind', 'org');
  });
});
```

Create `apps/web/src/components/reports/ReportsList.covers.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: (selector: (s: { user: { canManagePartnerWide?: boolean } }) => unknown) =>
    selector({ user: {} }),
}));
vi.mock('./reportExport', () => ({
  exportReport: vi.fn(),
  downloadBlob: vi.fn(),
  getBrowserTimezone: () => 'UTC',
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/authScope', () => ({
  useJwtClaims: () => ({ status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } }),
}));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: null }) }));

import ReportsList from './ReportsList';

const base = {
  type: 'device_inventory',
  schedule: 'weekly',
  format: 'pdf',
  config: {},
  portalSelfService: false,
  lastGeneratedAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};
const acme = { ...base, id: 'rep-a', name: 'Acme inventory', orgId: 'org-a', partnerId: null, orgName: 'Acme Dental', lastDeliveryStatus: 'no_recipients' };
const bravo = { ...base, id: 'rep-b', name: 'Bravo inventory', orgId: 'org-b', partnerId: null, orgName: 'Bravo Law', lastDeliveryStatus: 'sent' };
const combined = { ...base, type: 'ar_aging', id: 'rep-p', name: 'All-clients AR', orgId: null, partnerId: 'p-1', orgName: null, lastDeliveryStatus: null };
const runBase = { status: 'completed', startedAt: null, completedAt: null, outputUrl: null, errorMessage: null, createdAt: '2026-09-02T00:00:00Z' };
const runs = [
  { ...runBase, id: 'run-a', reportId: 'rep-a', reportName: 'Acme inventory', reportType: 'device_inventory', orgId: 'org-a', orgName: 'Acme Dental', deliveryStatus: 'no_recipients', recipientCount: 0 },
  { ...runBase, id: 'run-p', reportId: 'rep-p', reportName: 'All-clients AR', reportType: 'ar_aging', orgId: null, orgName: null, deliveryStatus: 'sent', recipientCount: 0 },
];

function mockApi() {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/reports') return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [acme, bravo, combined] }) });
    if (url.startsWith('/reports/runs?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: runs }) });
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

describe('ReportsList org visibility (multi-org report series W01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi();
  });

  it('shows a Covers column: the org name, or All organizations · Combined', async () => {
    render(<ReportsList />);

    expect(await screen.findByRole('columnheader', { name: 'Covers' })).toBeInTheDocument();
    const acmeCovers = within(screen.getByTestId('report-row-rep-a')).getByTestId('report-covers-rep-a');
    expect(acmeCovers).toHaveAttribute('data-covers-kind', 'org');
    expect(acmeCovers).toHaveTextContent('Acme Dental');
    const combinedCovers = within(screen.getByTestId('report-row-rep-p')).getByTestId('report-covers-rep-p');
    expect(combinedCovers).toHaveAttribute('data-covers-kind', 'combined');
    expect(combinedCovers).toHaveTextContent('All organizations · Combined');
  });

  it('warns on a row whose latest scheduled run reached nobody, and only there', async () => {
    render(<ReportsList />);

    const chip = await screen.findByTestId('report-no-recipients-rep-a');
    expect(chip).toHaveTextContent('No recipients');
    expect(chip).toHaveAttribute('data-delivery-status', 'no_recipients');
    expect(screen.queryByTestId('report-no-recipients-rep-b')).toBeNull();
    expect(screen.queryByTestId('report-no-recipients-rep-p')).toBeNull();
  });

  it('adds an Org column and a delivery warning to Recent Runs', async () => {
    render(<ReportsList />);
    await screen.findByTestId('report-row-rep-a');
    await userEvent.setup().click(screen.getByTestId('reports-tab-runs'));

    expect(await screen.findByRole('columnheader', { name: 'Organization' })).toBeInTheDocument();
    expect(screen.getByTestId('report-run-covers-run-a')).toHaveTextContent('Acme Dental');
    expect(screen.getByTestId('report-run-covers-run-p')).toHaveAttribute('data-covers-kind', 'combined');
    expect(screen.getByTestId('report-run-delivery-run-a')).toHaveTextContent('No recipients');
    expect(screen.queryByTestId('report-run-delivery-run-p')).toBeNull();
  });
});
```

In `apps/web/src/components/reports/ReportsList.scope.test.tsx`, replace the four assertion lines in `it('tags every row and badges only the partner-owned (all-organizations) one', …)`:

```ts
    const badge = within(partnerRow).getByTestId('report-scope-badge-rep-p');
    expect(within(badge).getByTestId('scope-badge')).toBeInTheDocument();
    expect(within(orgRow).queryByTestId('report-scope-badge-rep-o')).toBeNull();
    expect(within(orgRow).queryByTestId('scope-badge')).toBeNull();
```
with:
```ts
    // Multi-org series W01: the Covers cell replaces the lone ScopeBadge.
    const covers = within(partnerRow).getByTestId('report-covers-rep-p');
    expect(covers).toHaveAttribute('data-covers-kind', 'combined');
    expect(covers).toHaveTextContent('All organizations · Combined');
    expect(within(orgRow).getByTestId('report-covers-rep-o')).toHaveAttribute('data-covers-kind', 'org');
```
and in `it('merges partner-owned reports into an org-focused list for a partner-scope user', …)` replace:
```ts
    expect(within(partnerRow).getByTestId('report-scope-badge-rep-p')).toBeInTheDocument();
```
with:
```ts
    expect(within(partnerRow).getByTestId('report-covers-rep-p')).toHaveAttribute('data-covers-kind', 'combined');
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && npx vitest run src/components/reports/CoversCell.test.tsx src/components/reports/ReportsList.covers.test.tsx src/components/reports/ReportsList.scope.test.tsx`
Expected: FAIL.
- `CoversCell.test.tsx` fails to resolve `./CoversCell`.
- `ReportsList.covers` fails with `Unable to find role="columnheader" and name "Covers"`.
- The two edited scope cases fail with `Unable to find an element by: [data-testid="report-covers-rep-p"]`.

- [ ] **Step 3: Add the locale strings to all 8 catalogs**

Run from the worktree root. The catalogs round-trip byte-identically through `json.dumps(indent=2, ensure_ascii=False)` (verified at `92764125ed`), so the diff contains only the new keys.

```bash
python3 - <<'PY'
import json, pathlib

root = pathlib.Path('apps/web/src/locales')

T = {
  'en': {
    'covers': 'Covers', 'organization': 'Organization',
    'coversGroup': {
      'combined': 'All organizations · Combined',
      'unknownOrg': 'Unknown organization',
      'seriesAll': 'All orgs · {{count}} · One per organization',
      'seriesSelected_one': '{{count}} org · One per organization',
      'seriesSelected_other': '{{count}} orgs · One per organization',
    },
    'delivery': {
      'noRecipients': 'No recipients',
      'noRecipientsHint': 'The last scheduled run had nobody to email. Add recipients to deliver this report.',
      'partial': 'Partly delivered',
      'failed': 'Email not sent',
    },
    'orgPicker': {
      'label': 'Organization',
      'placeholder': 'Choose an organization',
      'hint': 'You are viewing all organizations. Choose the organization this report is for.',
      'required': 'Choose an organization before saving this report.',
      'chooseFirst': 'Choose an organization above before using a template.',
      'previewNeedsOrg': 'Choose an organization to see a live preview.',
    },
  },
  'de-DE': {
    'covers': 'Umfasst', 'organization': 'Organisation',
    'coversGroup': {
      'combined': 'Alle Organisationen · Kombiniert',
      'unknownOrg': 'Unbekannte Organisation',
      'seriesAll': 'Alle Orgs · {{count}} · Eine pro Organisation',
      'seriesSelected_one': '{{count}} Org · Eine pro Organisation',
      'seriesSelected_other': '{{count}} Orgs · Eine pro Organisation',
    },
    'delivery': {
      'noRecipients': 'Keine Empfänger',
      'noRecipientsHint': 'Der letzte geplante Lauf hatte keine Empfänger. Fügen Sie Empfänger hinzu, um diesen Bericht zuzustellen.',
      'partial': 'Teilweise zugestellt',
      'failed': 'E-Mail nicht gesendet',
    },
    'orgPicker': {
      'label': 'Organisation',
      'placeholder': 'Organisation auswählen',
      'hint': 'Sie sehen alle Organisationen. Wählen Sie die Organisation aus, für die dieser Bericht gilt.',
      'required': 'Wählen Sie vor dem Speichern dieses Berichts eine Organisation aus.',
      'chooseFirst': 'Wählen Sie oben eine Organisation aus, bevor Sie eine Vorlage verwenden.',
      'previewNeedsOrg': 'Wählen Sie eine Organisation aus, um eine Live-Vorschau zu sehen.',
    },
  },
  'es-419': {
    'covers': 'Cubre', 'organization': 'Organización',
    'coversGroup': {
      'combined': 'Todas las organizaciones · Combinado',
      'unknownOrg': 'Organización desconocida',
      'seriesAll': 'Todas las orgs · {{count}} · Uno por organización',
      'seriesSelected_one': '{{count}} org · Uno por organización',
      'seriesSelected_other': '{{count}} orgs · Uno por organización',
    },
    'delivery': {
      'noRecipients': 'Sin destinatarios',
      'noRecipientsHint': 'La última ejecución programada no tenía a quién enviar. Agrega destinatarios para entregar este informe.',
      'partial': 'Entregado parcialmente',
      'failed': 'Correo no enviado',
    },
    'orgPicker': {
      'label': 'Organización',
      'placeholder': 'Elige una organización',
      'hint': 'Estás viendo todas las organizaciones. Elige la organización para la que es este informe.',
      'required': 'Elige una organización antes de guardar este informe.',
      'chooseFirst': 'Elige una organización arriba antes de usar una plantilla.',
      'previewNeedsOrg': 'Elige una organización para ver una vista previa en vivo.',
    },
  },
  'fr-CA': {
    'covers': 'Couvre', 'organization': 'Organisation',
    'coversGroup': {
      'combined': 'Toutes les organisations · Combiné',
      'unknownOrg': 'Organisation inconnue',
      'seriesAll': 'Toutes les orgs · {{count}} · Un par organisation',
      'seriesSelected_one': '{{count}} org · Un par organisation',
      'seriesSelected_other': '{{count}} orgs · Un par organisation',
    },
    'delivery': {
      'noRecipients': 'Aucun destinataire',
      'noRecipientsHint': 'La dernière exécution planifiée n’avait aucun destinataire. Ajoutez des destinataires pour livrer ce rapport.',
      'partial': 'Partiellement livré',
      'failed': 'Courriel non envoyé',
    },
    'orgPicker': {
      'label': 'Organisation',
      'placeholder': 'Choisir une organisation',
      'hint': 'Vous consultez toutes les organisations. Choisissez l’organisation visée par ce rapport.',
      'required': 'Choisissez une organisation avant d’enregistrer ce rapport.',
      'chooseFirst': 'Choisissez une organisation ci-dessus avant d’utiliser un modèle.',
      'previewNeedsOrg': 'Choisissez une organisation pour afficher un aperçu en direct.',
    },
  },
  'fr-FR': {
    'covers': 'Couvre', 'organization': 'Organisation',
    'coversGroup': {
      'combined': 'Toutes les organisations · Combiné',
      'unknownOrg': 'Organisation inconnue',
      'seriesAll': 'Toutes les orgs · {{count}} · Un par organisation',
      'seriesSelected_one': '{{count}} org · Un par organisation',
      'seriesSelected_other': '{{count}} orgs · Un par organisation',
    },
    'delivery': {
      'noRecipients': 'Aucun destinataire',
      'noRecipientsHint': 'La dernière exécution planifiée n’avait aucun destinataire. Ajoutez des destinataires pour livrer ce rapport.',
      'partial': 'Partiellement livré',
      'failed': 'E-mail non envoyé',
    },
    'orgPicker': {
      'label': 'Organisation',
      'placeholder': 'Choisir une organisation',
      'hint': 'Vous consultez toutes les organisations. Choisissez l’organisation visée par ce rapport.',
      'required': 'Choisissez une organisation avant d’enregistrer ce rapport.',
      'chooseFirst': 'Choisissez une organisation ci-dessus avant d’utiliser un modèle.',
      'previewNeedsOrg': 'Choisissez une organisation pour afficher un aperçu en direct.',
    },
  },
  'it-IT': {
    'covers': 'Copre', 'organization': 'Organizzazione',
    'coversGroup': {
      'combined': 'Tutte le organizzazioni · Combinato',
      'unknownOrg': 'Organizzazione sconosciuta',
      'seriesAll': 'Tutte le org · {{count}} · Uno per organizzazione',
      'seriesSelected_one': '{{count}} org · Uno per organizzazione',
      'seriesSelected_other': '{{count}} org · Uno per organizzazione',
    },
    'delivery': {
      'noRecipients': 'Nessun destinatario',
      'noRecipientsHint': 'L’ultima esecuzione pianificata non aveva destinatari. Aggiungi destinatari per consegnare questo report.',
      'partial': 'Consegnato in parte',
      'failed': 'Email non inviata',
    },
    'orgPicker': {
      'label': 'Organizzazione',
      'placeholder': 'Scegli un’organizzazione',
      'hint': 'Stai visualizzando tutte le organizzazioni. Scegli l’organizzazione a cui si riferisce questo report.',
      'required': 'Scegli un’organizzazione prima di salvare questo report.',
      'chooseFirst': 'Scegli un’organizzazione qui sopra prima di usare un modello.',
      'previewNeedsOrg': 'Scegli un’organizzazione per vedere un’anteprima dal vivo.',
    },
  },
  'pt-BR': {
    'covers': 'Abrange', 'organization': 'Organização',
    'coversGroup': {
      'combined': 'Todas as organizações · Combinado',
      'unknownOrg': 'Organização desconhecida',
      'seriesAll': 'Todas as orgs · {{count}} · Um por organização',
      'seriesSelected_one': '{{count}} org · Um por organização',
      'seriesSelected_other': '{{count}} orgs · Um por organização',
    },
    'delivery': {
      'noRecipients': 'Sem destinatários',
      'noRecipientsHint': 'A última execução agendada não tinha ninguém para receber o e-mail. Adicione destinatários para entregar este relatório.',
      'partial': 'Entregue parcialmente',
      'failed': 'E-mail não enviado',
    },
    'orgPicker': {
      'label': 'Organização',
      'placeholder': 'Escolha uma organização',
      'hint': 'Você está vendo todas as organizações. Escolha a organização deste relatório.',
      'required': 'Escolha uma organização antes de salvar este relatório.',
      'chooseFirst': 'Escolha uma organização acima antes de usar um modelo.',
      'previewNeedsOrg': 'Escolha uma organização para ver uma prévia ao vivo.',
    },
  },
  'tr-TR': {
    'covers': 'Kapsam', 'organization': 'Kuruluş',
    'coversGroup': {
      'combined': 'Tüm kuruluşlar · Birleşik',
      'unknownOrg': 'Bilinmeyen kuruluş',
      'seriesAll': 'Tüm kuruluşlar · {{count}} · Kuruluş başına bir',
      'seriesSelected_one': '{{count}} kuruluş · Kuruluş başına bir',
      'seriesSelected_other': '{{count}} kuruluş · Kuruluş başına bir',
    },
    'delivery': {
      'noRecipients': 'Alıcı yok',
      'noRecipientsHint': 'Son zamanlanmış çalıştırmada e-posta gönderilecek kimse yoktu. Bu raporu teslim etmek için alıcı ekleyin.',
      'partial': 'Kısmen teslim edildi',
      'failed': 'E-posta gönderilmedi',
    },
    'orgPicker': {
      'label': 'Kuruluş',
      'placeholder': 'Bir kuruluş seçin',
      'hint': 'Tüm kuruluşları görüntülüyorsunuz. Bu raporun ait olduğu kuruluşu seçin.',
      'required': 'Bu raporu kaydetmeden önce bir kuruluş seçin.',
      'chooseFirst': 'Şablon kullanmadan önce yukarıdan bir kuruluş seçin.',
      'previewNeedsOrg': 'Canlı önizleme için bir kuruluş seçin.',
    },
  },
}

for locale, s in T.items():
    path = root / locale / 'reports.json'
    data = json.loads(path.read_text(encoding='utf-8'))
    reports = data['reports']
    rl = reports['reportsList']
    rl['table']['covers'] = s['covers']
    rl['runsTable']['organization'] = s['organization']
    rl['covers'] = s['coversGroup']
    rl['delivery'] = s['delivery']
    reports['orgPicker'] = s['orgPicker']
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print('updated', path)
PY
git diff --stat apps/web/src/locales
```
Expected: 8 files changed, insertions only. Each file gains 23 lines: 2 scalar keys, 3 new objects and their braces.

- [ ] **Step 4: Create `DeliveryStatusChip.tsx`**

```tsx
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/**
 * `report_runs.delivery_status` (multi-org report series W01, spec §3.2) —
 * mirrors `REPORT_DELIVERY_STATUSES` in `apps/api/src/db/schema/reports.ts`.
 * The web's one declaration: W03's `series/types.ts` re-exports it.
 */
export type ReportDeliveryStatus = 'sent' | 'partial' | 'no_recipients' | 'failed' | 'not_scheduled';

type WarningStatus = Extract<ReportDeliveryStatus, 'no_recipients' | 'partial' | 'failed'>;

function isWarning(status: ReportDeliveryStatus | null | undefined): status is WarningStatus {
  return status === 'no_recipients' || status === 'partial' || status === 'failed';
}

/**
 * A warning chip for a scheduled delivery that did not fully reach its
 * recipients. Renders nothing for 'sent', 'not_scheduled' (a manual run),
 * NULL (ad-hoc and pre-W01 runs) or an absent field.
 */
export function DeliveryStatusChip({
  status,
  testId,
  title,
  className,
}: {
  status: ReportDeliveryStatus | null | undefined;
  testId: string;
  title?: string;
  className?: string;
}) {
  const { t } = useTranslation('reports');
  if (!isWarning(status)) return null;
  const label =
    status === 'no_recipients'
      ? t('reports.reportsList.delivery.noRecipients')
      : status === 'partial'
        ? t('reports.reportsList.delivery.partial')
        : t('reports.reportsList.delivery.failed');
  return (
    <span
      data-testid={testId}
      data-delivery-status={status}
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning-strong',
        className,
      )}
    >
      <AlertTriangle className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  );
}
```

- [ ] **Step 5: Create `CoversCell.tsx`**

```tsx
import { Building2, Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * A multi-org series row's summary (W03 builds it from GET /reports/series).
 * The series kind renders only when this is passed with a `seriesId`.
 */
export type CoversSeriesSummary = {
  seriesId: string;
  targetMode: 'all' | 'selected';
  orgCount: number;
};

/**
 * What a saved report or run covers (multi-org report series spec §3.7):
 *  - org: an org-owned report — its org's name;
 *  - combined: a partner-owned report (`orgId` null — `reports_one_owner_chk`
 *    makes that partner-owned) — the existing cross-org aggregate;
 *  - series (W03): "All orgs · N" / "N orgs", one report per organization.
 * A W02 series CHILD row (seriesId and orgId both set) is an ordinary org row.
 */
export function CoversCell({
  testId,
  orgId,
  orgName,
  series,
}: {
  testId: string;
  /** The row's owning org; `null` = partner-owned; `undefined` = the API sent no owner. */
  orgId: string | null | undefined;
  orgName?: string | null;
  series?: CoversSeriesSummary | null;
}) {
  const { t } = useTranslation('reports');

  if (series?.seriesId) {
    const label =
      series.targetMode === 'all'
        ? t('reports.reportsList.covers.seriesAll', { count: series.orgCount })
        : t('reports.reportsList.covers.seriesSelected', { count: series.orgCount });
    return (
      <span
        data-testid={testId}
        data-covers-kind="series"
        className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
      >
        <Layers className="h-3 w-3" aria-hidden="true" />
        {label}
      </span>
    );
  }

  if (orgId === null) {
    return (
      <span
        data-testid={testId}
        data-covers-kind="combined"
        className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
      >
        <Layers className="h-3 w-3" aria-hidden="true" />
        {t('reports.reportsList.covers.combined')}
      </span>
    );
  }

  if (orgId === undefined) {
    return (
      <span data-testid={testId} data-covers-kind="unknown" className="text-sm text-muted-foreground">
        —
      </span>
    );
  }

  return (
    <span data-testid={testId} data-covers-kind="org" className="inline-flex items-center gap-1 text-sm">
      <Building2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      {orgName ?? t('reports.reportsList.covers.unknownOrg')}
    </span>
  );
}
```

- [ ] **Step 6: Wire both into `ReportsList.tsx`**

(a) Imports. Replace line 23:
```ts
import { ScopeBadge } from '../shared/ScopeBadge';
```
with:
```ts
import { CoversCell } from './CoversCell';
import { DeliveryStatusChip, type ReportDeliveryStatus } from './DeliveryStatusChip';
```
The removed `ScopeBadge` was used only at line 621, which step (c) deletes.

(b) Types. In `export type Report = { … }`, add after `partnerId: string | null;`:
```ts
  /** Multi-org series W01: the owning org's name (GET /reports joins it); null for a partner-owned report. */
  orgName?: string | null;
  /** Multi-org series W01: the latest SCHEDULED run's delivery outcome (manual runs excluded). */
  lastDeliveryStatus?: ReportDeliveryStatus | null;
```
In `export type ReportRun = { … }`, add after `reportType?: ReportType;`:
```ts
  /** Multi-org series W01 (GET /reports/runs): the owning org; null for a partner-owned report's run. */
  orgId?: string | null;
  orgName?: string | null;
  deliveryStatus?: ReportDeliveryStatus | null;
  /** Customer recipients the run resolved (non-series: contacts + typed addresses). Not rendered in W01. */
  recipientCount?: number | null;
```

(c) Saved-reports table.
- After the Name header cell:
```tsx
                    <th className="px-4 py-3">
                      {t('reports.reportsList.table.name')}
                    </th>
```
add:
```tsx
                    <th className="px-4 py-3">
                      {t('reports.reportsList.table.covers')}
                    </th>
```
- Delete the partner-owned badge block from the name cell:
```tsx
                          {report.partnerId && !report.orgId && (
                            // Partner-owned: covers all of the partner's
                            // organizations (#3198). ScopeBadge keeps its own
                            // fixed testid, so the per-row one lives here.
                            <span data-testid={`report-scope-badge-${report.id}`} className="shrink-0">
                              <ScopeBadge orgId={null} partnerId={report.partnerId} isSystem={false} />
                            </span>
                          )}
```
- Directly after the name `<td>` closes (the `</td>` that follows the `</div>` holding the name and the portal badge), and before the type cell `<td className="px-4 py-3 text-sm">{getReportTypeLabel(report.type)}</td>`, add:
```tsx
                      <td className="px-4 py-3">
                        {/* Multi-org series W01 (spec §3.7): replaces the lone
                            partner-owned ScopeBadge — every row says what it covers. */}
                        <CoversCell
                          testId={`report-covers-${report.id}`}
                          orgId={report.orgId}
                          orgName={report.orgName}
                        />
                      </td>
```
- In the schedule cell, directly after the closing `)}` of the `{report.schedule !== 'one_time' && ( … )}` block and before that `<td>` closes, add:
```tsx
                        {report.lastDeliveryStatus === 'no_recipients' && (
                          <div className="mt-1">
                            <DeliveryStatusChip
                              testId={`report-no-recipients-${report.id}`}
                              status="no_recipients"
                              title={t('reports.reportsList.delivery.noRecipientsHint')}
                            />
                          </div>
                        )}
```

(d) Recent Runs table.
- After the Report header cell:
```tsx
                    <th className="px-4 py-3">
                      {t('reports.reportsList.runsTable.report')}
                    </th>
```
add:
```tsx
                    <th className="px-4 py-3">
                      {t('reports.reportsList.runsTable.organization')}
                    </th>
```
- After the run's report `<td>`, the one containing `{run.reportName || t('reports.reportsList.unknownReport')}`, add:
```tsx
                      <td className="px-4 py-3">
                        <CoversCell
                          testId={`report-run-covers-${run.id}`}
                          orgId={run.orgId}
                          orgName={run.orgName}
                        />
                      </td>
```
- In the status `<td>`, directly after:
```tsx
                        {run.errorMessage && (
                          <p className="text-xs text-destructive mt-1">{run.errorMessage}</p>
                        )}
```
add:
```tsx
                        <DeliveryStatusChip
                          testId={`report-run-delivery-${run.id}`}
                          status={run.deliveryStatus}
                          className="mt-1"
                        />
```

- [ ] **Step 7: Run the web tests and the i18n contracts**

Run: `cd apps/web && npx vitest run src/components/reports src/lib/i18n src/locales`
Expected: PASS.
- The new files pass, along with the edited scope cases and every other `ReportsList.*` case.
- `keyUsage` passes: each literal key resolves in `en`, and `seriesSelected` resolves through `_one`/`_other` because the call passes `count`.
- `localeParity` passes: the same keys are in all 8 catalogs.
- `translationCoverage` passes: no new value is identical to English.

If `translationCoverage` reports a duplicate for a locale, change that locale's wording. Do not raise the baseline.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/reports/DeliveryStatusChip.tsx apps/web/src/components/reports/CoversCell.tsx apps/web/src/components/reports/CoversCell.test.tsx apps/web/src/components/reports/ReportsList.tsx apps/web/src/components/reports/ReportsList.covers.test.tsx apps/web/src/components/reports/ReportsList.scope.test.tsx apps/web/src/locales
git commit -m "feat(web): Covers column, no-recipients warning, Org column on recent runs (multi-org series W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Org picker in the report builder (fixes the New Report 400)

**Files:**
- Create: `apps/web/src/components/reports/OrgPickerField.tsx`, `apps/web/src/components/reports/OrgPickerField.test.tsx`
- Modify: `apps/web/src/components/reports/ReportBuilder.tsx`:
  - imports (lines 28-30);
  - props (lines 103-131);
  - the component head (lines 757-772);
  - the live-preview effect (lines 937-1049);
  - `handleFormSubmit` (lines 1409-1543);
  - the Report details card (lines 1711-1715).
- Test: `apps/web/src/components/reports/ReportBuilder.test.tsx`

**Interfaces:**
- Consumes: the `reports.orgPicker.*` keys (Task 6); `useOrgStore()` → `{ currentOrgId, organizations }` and `Organization` from `apps/web/src/stores/orgStore.ts`.
- Produces:
  - `export type ReportTargetOrg = { orgId: string | null; pickedOrgId: string | null; setPickedOrgId: (orgId: string | null) => void; pickerVisible: boolean; missing: boolean; options: Organization[] }`
  - `export function useReportTargetOrg(defaultOrgId?: string | null): ReportTargetOrg`
  - `export function OrgPickerField(props: { value: string | null; onChange: (orgId: string | null) => void; options: Organization[]; testId?: string; id?: string })`
    - `testId` defaults to `'report-org-picker'`; the select is `${testId}-select`.
  - `ReportBuilder` gains `defaultOrgId?: string | null`, which Task 8 passes.

**Why the body, and why ambient injection cannot mask it.** Checked against `apps/web/src/stores/auth.ts:1297-1343` and `apps/api/src/routes/reports/core.ts:664-687`:
- `POST /reports` and `POST /reports/generate` read `orgId` from the **JSON body** (`c.req.valid('json')`). They never read a `?orgId=` query.
- `fetchWithAuth`'s `applyOrgId` only rewrites the query string, and its ambient source is `useOrgStore.getState().currentOrgId` (`orgStore.ts:434`). That is `null` under All organizations, so nothing is injected there.
- The picker's value therefore reaches the server only through the body, and ambient injection can neither add a conflicting org nor supply a missing one.
- The picker is shown only when `currentOrgId` is null. When an org **is** focused, the body and the ambient query name the same org, exactly as today.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/reports/OrgPickerField.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const orgState = vi.hoisted(() => ({
  currentOrgId: null as string | null,
  organizations: [] as Array<{ id: string; partnerId: string; name: string; status: string; createdAt: string }>,
}));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => orgState }));

import { OrgPickerField, useReportTargetOrg } from './OrgPickerField';

const org = (id: string, name: string, status = 'active') => ({
  id, partnerId: 'p-1', name, status, createdAt: '2026-01-01T00:00:00Z',
});

function Harness({ defaultOrgId }: { defaultOrgId?: string | null }) {
  const target = useReportTargetOrg(defaultOrgId);
  return (
    <div>
      <span data-testid="target">
        {JSON.stringify({ orgId: target.orgId, pickerVisible: target.pickerVisible, missing: target.missing })}
      </span>
      {target.pickerVisible && (
        <OrgPickerField value={target.pickedOrgId} onChange={target.setPickedOrgId} options={target.options} />
      )}
    </div>
  );
}

const state = () => JSON.parse(screen.getByTestId('target').textContent ?? '{}');

describe('useReportTargetOrg / OrgPickerField (multi-org report series W01)', () => {
  beforeEach(() => {
    orgState.currentOrgId = null;
    orgState.organizations = [];
  });

  it('uses the focused org and shows no picker when the switcher names one', () => {
    orgState.currentOrgId = 'org-a';
    orgState.organizations = [org('org-a', 'Acme Dental'), org('org-b', 'Bravo Law')];
    render(<Harness />);
    expect(state()).toEqual({ orgId: 'org-a', pickerVisible: false, missing: false });
    expect(screen.queryByTestId('report-org-picker')).toBeNull();
  });

  it('under All organizations with several orgs, requires a choice and then uses it', async () => {
    orgState.organizations = [org('org-b', 'Bravo Law'), org('org-a', 'Acme Dental')];
    render(<Harness />);
    expect(state()).toEqual({ orgId: null, pickerVisible: true, missing: true });

    const select = screen.getByTestId('report-org-picker-select');
    // Sorted by name, placeholder first.
    expect([...(select as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      'Choose an organization',
      'Acme Dental',
      'Bravo Law',
    ]);
    await userEvent.setup().selectOptions(select, 'org-b');
    expect(state()).toEqual({ orgId: 'org-b', pickerVisible: true, missing: false });
  });

  it('omits out-of-service orgs and auto-uses the only creatable org', () => {
    orgState.organizations = [
      org('org-a', 'Acme Dental', 'active'),
      org('org-s', 'Suspended Co', 'suspended'),
      org('org-c', 'Churned Co', 'churned'),
    ];
    render(<Harness />);
    expect(state()).toEqual({ orgId: 'org-a', pickerVisible: false, missing: false });
  });

  it('offers only active and trial orgs when there are several', () => {
    orgState.organizations = [
      org('org-b', 'Bravo Law', 'active'),
      org('org-t', 'Trial Co', 'trial'),
      org('org-o', 'Offboarding Co', 'offboarding'),
    ];
    render(<Harness />);
    const options = [...(screen.getByTestId('report-org-picker-select') as HTMLSelectElement).options]
      .map((o) => o.value)
      .filter(Boolean);
    expect(options).toEqual(['org-b', 'org-t']);
  });

  it('asks for nothing while the org list is not loaded (the server decides, as before)', () => {
    render(<Harness />);
    expect(state()).toEqual({ orgId: null, pickerVisible: false, missing: false });
  });

  it('seeds the choice from a caller default (the templates page picker)', () => {
    orgState.organizations = [org('org-a', 'Acme Dental'), org('org-b', 'Bravo Law')];
    render(<Harness defaultOrgId="org-b" />);
    expect(state()).toEqual({ orgId: 'org-b', pickerVisible: true, missing: false });
    expect(screen.getByTestId('report-org-picker-select')).toHaveValue('org-b');
  });
});
```

In `apps/web/src/components/reports/ReportBuilder.test.tsx`:
- change the vitest import (line 3) to `import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';`
- append:

```tsx
describe('ReportBuilder org picker under All organizations (multi-org series W01)', () => {
  const orgs = [
    { id: 'org-a', partnerId: 'p-1', name: 'Acme Dental', status: 'active' as const, createdAt: '2026-01-01T00:00:00Z' },
    { id: 'org-b', partnerId: 'p-1', name: 'Bravo Law', status: 'active' as const, createdAt: '2026-01-01T00:00:00Z' },
  ];
  const postCalls = () =>
    fetchWithAuthMock.mock.calls.filter(
      ([url, init]) => url === '/reports' && (init as RequestInit | undefined)?.method === 'POST'
    );

  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: null, organizations: orgs });
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: { id: 'report-9' } }, true, 201));
  });

  afterEach(() => {
    useOrgStore.setState({ currentOrgId: null, organizations: [] });
  });

  it('blocks submit client-side with no org chosen: no POST /reports and no preview request (no 400 is reached)', async () => {
    render(<ReportBuilder mode="create" defaultValues={{ name: 'Fleet health' }} onSubmit={vi.fn()} />);

    expect(await screen.findByTestId('report-org-picker')).toBeInTheDocument();
    expect(await screen.findByText('Choose an organization to see a live preview.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('report-builder-submit'));

    expect(await screen.findByText('Choose an organization before saving this report.')).toBeInTheDocument();
    // Past the live preview's 300 ms debounce: it was never scheduled.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(postCalls()).toHaveLength(0);
    expect(fetchWithAuthMock.mock.calls.some(([url]) => url === '/reports/generate')).toBe(false);
  });

  it('posts the picked org in the body — the only org carrier for a create', async () => {
    render(<ReportBuilder mode="create" defaultValues={{ name: 'Fleet health' }} onSubmit={vi.fn()} />);

    await userEvent.setup().selectOptions(await screen.findByTestId('report-org-picker-select'), 'org-b');
    fireEvent.click(screen.getByTestId('report-builder-submit'));

    await waitFor(() => expect(postCalls()).toHaveLength(1));
    const [, init] = postCalls()[0]!;
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ orgId: 'org-b' });
    // No pin/skip flag: fetchWithAuth's ambient ?orgId= is absent under All
    // organizations and the create route reads the JSON body only.
    expect(init).not.toHaveProperty('orgIdOverride');
    expect(init).not.toHaveProperty('skipOrgIdInjection');
  });

  it('hides the picker and uses the focused org when the switcher names one', async () => {
    useOrgStore.setState({ currentOrgId: 'org-a' });
    render(<ReportBuilder mode="create" defaultValues={{ name: 'Fleet health' }} onSubmit={vi.fn()} />);

    fireEvent.click(await screen.findByTestId('report-builder-submit'));

    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(screen.queryByTestId('report-org-picker')).toBeNull();
    expect(JSON.parse(String((postCalls()[0]![1] as RequestInit).body))).toMatchObject({ orgId: 'org-a' });
  });

  it('never shows the picker when editing an existing report', async () => {
    render(<ReportBuilder mode="edit" reportId="rep-1" defaultValues={{ name: 'Fleet health' }} onSubmit={vi.fn()} />);

    expect(await screen.findByTestId('report-builder-submit')).toBeInTheDocument();
    expect(screen.queryByTestId('report-org-picker')).toBeNull();
  });
});
```

`userEvent` is already imported at the top of the file. `Organization.status` is a string-literal union, so the fixture uses `as const`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && npx vitest run src/components/reports/OrgPickerField.test.tsx src/components/reports/ReportBuilder.test.tsx`
Expected: FAIL.
- `OrgPickerField.test.tsx` cannot resolve `./OrgPickerField`.
- The new ReportBuilder cases fail with `Unable to find an element by: [data-testid="report-org-picker"]`.
- The first case additionally shows a POST `/reports` with no `orgId`: the 400 path this task removes.

- [ ] **Step 3: Create `OrgPickerField.tsx`**

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOrgStore, type Organization } from '../../stores/orgStore';

/**
 * Orgs a new report can be created for. The API refuses an out-of-service org
 * on create/generate (`REPORT_TENANT_INACTIVE`), so it is never offered.
 */
const CREATABLE_STATUSES: ReadonlySet<Organization['status']> = new Set(['active', 'trial']);

export type ReportTargetOrg = {
  /**
   * The org a create/generate request names in its JSON body:
   *  - the switcher's focused org;
   *  - else the one picked here;
   *  - else the only creatable org;
   *  - else null, meaning send no orgId and let the server decide, exactly as
   *    before W01. That covers an org token, which uses its own org, and an
   *    org list not loaded yet.
   */
  orgId: string | null;
  pickedOrgId: string | null;
  setPickedOrgId: (orgId: string | null) => void;
  /** All organizations, with several creatable orgs: the caller must render the picker. */
  pickerVisible: boolean;
  /** The picker is showing and nothing is chosen — a request would 400; block it. */
  missing: boolean;
  options: Organization[];
};

/**
 * Multi-org report series W01 (spec §3.7): under All organizations a partner
 * with several orgs gets `400 orgId is required when partner has multiple
 * organizations` from New Report and Templates, because the only org source
 * was the ambient switcher. This resolves the target org and says when the
 * caller must ask for one.
 *
 * Reads `organizations` defensively (`?? []`): several existing suites mock
 * `useOrgStore` with only `currentOrgId`, and an absent list means "not
 * loaded" — never "required".
 */
export function useReportTargetOrg(defaultOrgId: string | null = null): ReportTargetOrg {
  const { currentOrgId, organizations } = useOrgStore();
  const options = useMemo(
    () =>
      (organizations ?? [])
        .filter((org) => CREATABLE_STATUSES.has(org.status))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [organizations],
  );
  const [pickedOrgId, setPickedOrgId] = useState<string | null>(defaultOrgId);
  // A caller default that changes after mount (the templates page picker)
  // re-seeds the choice.
  useEffect(() => {
    if (defaultOrgId) setPickedOrgId(defaultOrgId);
  }, [defaultOrgId]);

  const hidden = (orgId: string | null): ReportTargetOrg => ({
    orgId,
    pickedOrgId,
    setPickedOrgId,
    pickerVisible: false,
    missing: false,
    options,
  });

  if (currentOrgId) return hidden(currentOrgId);
  if (options.length === 0) return hidden(null);
  if (options.length === 1) return hidden(options[0]!.id);

  const picked = options.some((org) => org.id === pickedOrgId) ? pickedOrgId : null;
  return {
    orgId: picked,
    pickedOrgId: picked,
    setPickedOrgId,
    pickerVisible: true,
    missing: picked === null,
    options,
  };
}

export function OrgPickerField({
  value,
  onChange,
  options,
  testId = 'report-org-picker',
  id = 'report-target-org',
}: {
  value: string | null;
  onChange: (orgId: string | null) => void;
  options: Organization[];
  testId?: string;
  id?: string;
}) {
  const { t } = useTranslation('reports');
  return (
    <div className="space-y-2" data-testid={testId}>
      <label htmlFor={id} className="text-sm font-medium">
        {t('reports.orgPicker.label')}
      </label>
      <select
        id={id}
        data-testid={`${testId}-select`}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
        className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
      >
        <option value="">{t('reports.orgPicker.placeholder')}</option>
        {options.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">{t('reports.orgPicker.hint')}</p>
    </div>
  );
}
```

- [ ] **Step 4: Wire it into `ReportBuilder.tsx`**

(a) Import. After `import { useOrgStore } from '../../stores/orgStore';` (line 29) add:
```ts
import { OrgPickerField, useReportTargetOrg } from './OrgPickerField';
```

(b) Prop. In `type ReportBuilderProps`, after the `partnerOwned?: boolean;` member and its doc comment, add:
```ts
  /**
   * Multi-org series W01: the org to preselect in the All-organizations org
   * picker (the templates page passes the org chosen on the page). Ignored
   * when the switcher names an org, and in edit mode.
   */
  defaultOrgId?: string | null;
```
Add `defaultOrgId,` to the destructured parameters right after `partnerOwned = false,`.

(c) Target org. Directly after `const { currentOrgId } = useOrgStore();` (line 772) add:
```ts
  // Multi-org series W01 (spec §3.7): create/builder/adhoc need an org; edit
  // never re-homes a report, and a partner-owned report has no org at all.
  const orgTarget = useReportTargetOrg(defaultOrgId ?? null);
  const orgPickerApplies = mode !== 'edit' && !partnerOwned;
  const targetOrgId = orgPickerApplies ? orgTarget.orgId : currentOrgId;
  const orgMissing = orgPickerApplies && orgTarget.missing;
```

(d) Live preview. In the live-preview `useEffect`, replace:
```ts
  useEffect(() => {
    if (mode === 'adhoc') return;

    let mounted = true;
```
with:
```ts
  useEffect(() => {
    if (mode === 'adhoc') return;
    if (orgMissing) {
      // No org chosen under All organizations: the preview would 400. Drop any
      // in-flight preview and say what to do instead.
      previewRequestIdRef.current += 1;
      setLivePreviewRows([]);
      setLivePreviewSummary(null);
      setLivePreviewLoading(false);
      setLivePreviewError(stableT('reports.orgPicker.previewNeedsOrg'));
      return;
    }

    let mounted = true;
```
In the same effect's request body, replace:
```ts
            format: exportFormats[0] ?? 'csv',
            ...(currentOrgId ? { orgId: currentOrgId } : {})
```
with:
```ts
            format: exportFormats[0] ?? 'csv',
            ...(targetOrgId ? { orgId: targetOrgId } : {})
```
Then replace the effect's dependency array:
```ts
  }, [builderType, currentOrgId, dataSource, defaultValues?.dateRange, defaultValues?.filters, exportFormats, filterConditions, mode, stableT]);
```
with:
```ts
  }, [builderType, targetOrgId, orgMissing, dataSource, defaultValues?.dateRange, defaultValues?.filters, exportFormats, filterConditions, mode, stableT]);
```

(e) Submit guard. In `handleFormSubmit`, replace:
```ts
    if (submitBlocked) return;
    setError(undefined);
    setEmailError(undefined);
```
with:
```ts
    if (submitBlocked) return;
    setError(undefined);
    setEmailError(undefined);

    // Multi-org series W01: never send a create that would 400 on orgId.
    if (orgMissing) {
      setError(t('reports.orgPicker.required'));
      return;
    }
```

(f) The two request bodies. In the `payload` object replace:
```ts
      ...(currentOrgId && !partnerOwned ? { orgId: currentOrgId } : {}),
```
with:
```ts
      ...(targetOrgId && !partnerOwned ? { orgId: targetOrgId } : {}),
```
In the ad-hoc branch, replace:
```ts
            config: payload.config,
            format: primaryFormat,
            ...(currentOrgId ? { orgId: currentOrgId } : {})
```
with:
```ts
            config: payload.config,
            format: primaryFormat,
            ...(targetOrgId ? { orgId: targetOrgId } : {})
```
In edit mode `targetOrgId === currentOrgId`, so the PUT body is byte-for-byte unchanged.

(g) Render. In the Report details card, replace:
```tsx
          <div>
            <h2 className="text-sm font-semibold">{t('reports.reportBuilder.sections.reportDetails.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('reports.reportBuilder.sections.reportDetails.description')}</p>
          </div>
```
with:
```tsx
          <div>
            <h2 className="text-sm font-semibold">{t('reports.reportBuilder.sections.reportDetails.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('reports.reportBuilder.sections.reportDetails.description')}</p>
          </div>

          {orgPickerApplies && orgTarget.pickerVisible && (
            <OrgPickerField
              value={orgTarget.pickedOrgId}
              onChange={(orgId) => {
                orgTarget.setPickedOrgId(orgId);
                setError(undefined);
              }}
              options={orgTarget.options}
            />
          )}
```

`currentOrgId` is still used by the contact-recipients effect (lines 854-882). Leave it.

- [ ] **Step 5: Run the builder suites**

Run: `cd apps/web && npx vitest run src/components/reports/OrgPickerField.test.tsx src/components/reports/ReportBuilder src/components/reports/ReportEditPage`
Expected: PASS.

The existing builder and edit-page cases are unaffected. The real `orgStore` defaults to `organizations: []`, so the hook returns "not required" and the request bodies are exactly as before.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/reports/OrgPickerField.tsx apps/web/src/components/reports/OrgPickerField.test.tsx apps/web/src/components/reports/ReportBuilder.tsx apps/web/src/components/reports/ReportBuilder.test.tsx
git commit -m "fix(web): org picker in the report builder under All organizations (multi-org series W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Org picker on the Templates page

**Files:**
- Modify: `apps/web/src/components/reports/ReportTemplates.tsx`:
  - import (line 71);
  - `const { currentOrgId } = useOrgStore();` (line 582);
  - `handleCreateDirect` (lines 657-713);
  - `handleUseTemplate` (lines 715-770);
  - the header (lines 945-975);
  - the builder modal's `<ReportBuilder>` (line 1019).
- Create: `apps/web/src/components/reports/ReportTemplates.orgPicker.test.tsx`

**Interfaces:**
- Consumes: `useReportTargetOrg` and `OrgPickerField` (Task 7); `ReportBuilder`'s `defaultOrgId` (Task 7); `reports.orgPicker.chooseFirst` (Task 6).
- Produces: no template create is sent without an org for a multi-org partner. The business modal's own ownership control (`ReportOwnerScopeField`) is unchanged (contract concern: W03 replaces it).

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/reports/ReportTemplates.orgPicker.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.fn();
// No JWT/user (a not-yet-resolved session): the Business group stays hidden;
// this suite is about the General templates.
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: Object.assign((selector: (s: { tokens?: unknown; user?: unknown }) => unknown) => selector({}), {
    getState: () => ({}),
  }),
}));

const orgs = [
  { id: 'org-a', partnerId: 'p-1', name: 'Acme Dental', status: 'active', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'org-b', partnerId: 'p-1', name: 'Bravo Law', status: 'active', createdAt: '2026-01-01T00:00:00Z' },
];
let currentOrgId: string | null = null;
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId, organizations: orgs }) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import ReportTemplates from './ReportTemplates';

function mockApi() {
  fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/reports' && init?.method === 'POST') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-9' } }) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

const postCalls = () =>
  fetchWithAuth.mock.calls.filter(
    ([url, init]) => url === '/reports' && (init as { method?: string } | undefined)?.method === 'POST',
  );

async function clickUseTemplate(name: string) {
  const heading = await screen.findByText(name);
  const card = heading.closest('div.group') as HTMLElement;
  await userEvent.setup().click(within(card).getByRole('button', { name: /use template/i }));
}

describe('ReportTemplates org picker under All organizations (multi-org series W01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentOrgId = null;
    mockApi();
  });

  it('does not open or post a template until an org is chosen on the page', async () => {
    render(<ReportTemplates />);

    expect(await screen.findByTestId('report-templates-org-picker')).toBeInTheDocument();
    await clickUseTemplate('Security & Compliance Posture (Insurance)');

    expect(await screen.findByText('Choose an organization above before using a template.')).toBeInTheDocument();
    expect(screen.queryByTestId('posture-options-submit')).toBeNull();
    expect(postCalls()).toHaveLength(0);
  });

  it('creates the template report for the org picked on the page', async () => {
    render(<ReportTemplates />);

    await userEvent.setup().selectOptions(await screen.findByTestId('report-templates-org-picker-select'), 'org-b');
    await clickUseTemplate('Security & Compliance Posture (Insurance)');
    await userEvent.setup().click(screen.getByTestId('posture-options-submit'));

    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(JSON.parse(String((postCalls()[0]![1] as { body: string }).body))).toMatchObject({
      type: 'security_compliance_posture',
      orgId: 'org-b',
    });
  });

  it('hands the page choice to the builder modal as its preselected org', async () => {
    render(<ReportTemplates />);

    await userEvent.setup().selectOptions(await screen.findByTestId('report-templates-org-picker-select'), 'org-a');
    await userEvent.setup().click(screen.getByRole('button', { name: /create custom template/i }));

    expect(await screen.findByTestId('report-org-picker-select')).toHaveValue('org-a');
  });

  it('shows no picker and uses the focused org when the switcher names one', async () => {
    currentOrgId = 'org-a';
    render(<ReportTemplates />);

    await clickUseTemplate('Security & Compliance Posture (Insurance)');
    await userEvent.setup().click(screen.getByTestId('posture-options-submit'));

    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(screen.queryByTestId('report-templates-org-picker')).toBeNull();
    expect(JSON.parse(String((postCalls()[0]![1] as { body: string }).body))).toMatchObject({ orgId: 'org-a' });
  });
});
```

The "Create custom template" button label comes from `reports.reportTemplates.createCustomTemplate`. Check the English value in `apps/web/src/locales/en/reports.json` and adjust the `name:` regex if it differs.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/components/reports/ReportTemplates.orgPicker.test.tsx`
Expected: FAIL.
- `Unable to find an element by: [data-testid="report-templates-org-picker"]`.
- The first case also records a POST-less posture modal opening (`posture-options-submit` present).

- [ ] **Step 3: Implement**

In `apps/web/src/components/reports/ReportTemplates.tsx`:

(a) Replace the import on line 71:
```ts
import { useOrgStore } from '../../stores/orgStore';
```
with:
```ts
import { OrgPickerField, useReportTargetOrg } from './OrgPickerField';
```

(b) Replace line 582:
```ts
  const { currentOrgId } = useOrgStore();
```
with:
```ts
  // Multi-org series W01 (spec §3.7): the org a template creates for — the
  // switcher's org, else the one picked on this page. "Choosing a template
  // no longer posts the ambient currentOrgId blindly."
  const orgTarget = useReportTargetOrg();
```

(c) In `handleCreateDirect`, add a guard as the first statement of the callback body, before `setCreatingId(template.id);`:
```ts
      // Defense in depth — handleUseTemplate already refuses to open a
      // template without an org; nothing that would 400 is ever sent.
      if (owner === 'organization' && orgTarget.missing) {
        setError(t('reports.orgPicker.chooseFirst'));
        return;
      }
```
In the same function's body object, replace:
```ts
                      ...(currentOrgId ? { orgId: currentOrgId } : {})
```
with:
```ts
                      ...(orgTarget.orgId ? { orgId: orgTarget.orgId } : {})
```
Replace its dependency array `[currentOrgId, t]` with `[orgTarget.orgId, orgTarget.missing, t]`.

(d) In `handleUseTemplate`, directly after `const type = template.defaults.type;` add:
```ts
      // A business template carries its own ownership control (partner-owned
      // by default under All organizations); every other template needs an org.
      if (!isBusinessReportType(type) && orgTarget.missing) {
        setError(t('reports.orgPicker.chooseFirst'));
        return;
      }
```
Replace its dependency array `[defaultOwnerScope, handleCreateDirect, handleOpenBuilder]` with `[defaultOwnerScope, handleCreateDirect, handleOpenBuilder, orgTarget.missing, t]`.

(e) Render the page-level picker. Directly after the header block, which is the `<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">…</div>` holding the title and the "create custom template" button, and before `{error && (`, add:
```tsx
      {orgTarget.pickerVisible && (
        <div className="max-w-sm">
          <OrgPickerField
            testId="report-templates-org-picker"
            id="report-templates-target-org"
            value={orgTarget.pickedOrgId}
            onChange={(orgId) => {
              orgTarget.setPickedOrgId(orgId);
              setError(undefined);
            }}
            options={orgTarget.options}
          />
        </div>
      )}
```

(f) In the builder modal, replace:
```tsx
              <ReportBuilder
                key={activeTemplate?.id ?? 'custom-template'}
                mode="create"
                defaultValues={builderDefaults}
                onSubmit={handleSubmit}
                onCancel={handleCloseBuilder}
              />
```
with:
```tsx
              <ReportBuilder
                key={activeTemplate?.id ?? 'custom-template'}
                mode="create"
                defaultValues={builderDefaults}
                defaultOrgId={orgTarget.orgId}
                onSubmit={handleSubmit}
                onCancel={handleCloseBuilder}
              />
```

- [ ] **Step 4: Run every templates suite**

Run: `cd apps/web && npx vitest run src/components/reports/ReportTemplates`
Expected: PASS for the new file and all 8 existing `ReportTemplates.*.test.tsx` files.

The existing suites mock `useOrgStore` with only `currentOrgId`, which the hook reads as "org list not loaded, not required". So `posture`'s "omits orgId from the POST when no org is selected" still holds.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/reports/ReportTemplates.tsx apps/web/src/components/reports/ReportTemplates.orgPicker.test.tsx
git commit -m "fix(web): templates name an org before creating under All organizations (multi-org series W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Full verification, PR, review

**Files:** none new.

- [ ] **Step 1: Typecheck both apps (CI shape)**

Run:
```bash
NODE_OPTIONS=--max-old-space-size=12288 pnpm exec tsc --build apps/api/tsconfig.tests.json
cd apps/web && NODE_OPTIONS=--max-old-space-size=12288 pnpm exec astro check
```
Expected: 0 errors from both.

A likely trap is a Drizzle inference error on the `sql<…>` subquery column in `core.ts`. It needs the explicit generic shown in Task 5 Step 3.

- [ ] **Step 2: Full API unit suite and full web suite**

Run:
```bash
cd apps/api && npx vitest run
cd ../web && npx vitest run
```
Expected: all green.

Run the full API suite, not a touched-file subset. The route mocks for `GET /reports` live in several files, and a `leftJoin`-less chain anywhere reds only in the full run.

- [ ] **Step 3: Real-database suites**

Run from the worktree root. `pnpm test-stack up` is already running from Task 3; re-run it if it is not.

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/reportsOrgVisibility.integration.test.ts \
  src/__tests__/integration/reportsPartnerOwned.integration.test.ts \
  src/__tests__/integration/reportsPartnerRls.integration.test.ts \
  src/__tests__/integration/reportHistoryRoutes.integration.test.ts \
  src/__tests__/integration/report-site-scope.integration.test.ts \
  src/__tests__/integration/aiAgentNarrativeReport.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts
cd ../.. && DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
DATABASE_URL="$(grep '^DATABASE_URL=' .env.test | cut -d= -f2-)" pnpm db:check-drift
bash scripts/check-migration-naming.sh --against-ref origin/main
pnpm test-stack down
```
Expected:
- All green.
- `tenant-export-policy` and `tenantExportErasureRoundtrip` pass **unchanged**, proving `report_runs` needed no export entry.
- The drift check reports one new ledger row.
- The naming check passes against `origin/main`. If `origin/main` gained a later migration, rename the file per the Global Constraints and update the `reports.test.ts` path.

If a suite name above does not exist at your HEAD, `ls apps/api/src/__tests__/integration | grep -i report` and run the report suites that do.

- [ ] **Step 4: Manual browser check (worktree stack)**

Use the `worktree-stack` skill to bring up a seeded stack. Then, as a partner admin with two or more orgs, under **All organizations**:
1. Open `/reports/new`. The org picker shows, and Save with no org shows "Choose an organization before saving this report." with no network 400. Pick an org and save; the report appears with its org in the Covers column.
2. Open `/reports/templates`. The page picker shows, and "Use template" with no org shows the page error. Pick an org and use the Posture template; it is created for that org.
3. Create a daily report with no recipients. Trigger its run: set `reports.last_generated_at = NULL` for it and wait one 5-minute tick, or call `processRunScheduledReport` from a tsx one-liner. Reload `/reports`: the row shows **No recipients**, and Recent Runs shows the org and the chip.

Tear the stack down afterwards and say what was left running.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(reports): org visibility + delivery status (multi-org report series W01)" --body-file - <<'EOF'
## Summary
- `GET /reports` rows carry `orgName` (LEFT JOIN, RLS-governed) and `lastDeliveryStatus` (newest scheduled delivery); `GET /reports/runs` rows carry `orgId`, `orgName`, `deliveryStatus`, `recipientCount`.
- `report_runs.delivery_status` (CHECK: sent | partial | no_recipients | failed | not_scheduled) + `recipient_count` (customer recipients — for a non-series report, contacts plus typed `config.emailRecipients`; no CC concept until W02 series children). The schedule worker records every scheduled delivery — a run that reached nobody is `no_recipients` instead of a silent skip; a manual generate of a scheduled definition is `not_scheduled`.
- Web: Covers column (org name / "All organizations · Combined"; series kind reserved for W03), "No recipients" warning on saved reports, Org column + delivery warning on Recent Runs, org picker in New Report and Templates under All organizations (fixes the 400).

Spec: docs/superpowers/specs/reports/2026-09-28-multi-org-report-series-design.md (§3.2, §3.5, §3.6, §3.7, §4 W01, §5 W01). Plan: docs/superpowers/plans/reports/2026-09-28-multi-org-report-series-w01-org-visibility.md (see "Contract concerns").

## Tenancy
- No new table. `report_runs` has no `org_id` and is a pre-clear table outside `CORE_ORG_CASCADE_DELETE_ORDER`, so no cascade / merge / export-policy entry (`tenantExportPolicy.test.ts` pins its absence; both export suites pass unchanged). Existing FK-join RLS covers the new columns.
- The org-name join is a LEFT JOIN under the request's RLS context; an org token still lists only its own org (integration: `reportsOrgVisibility.integration.test.ts`).
- New index `report_runs_report_id_created_at_idx` (non-concurrent; brief write lock on report_runs during migrate).

## Behaviour changes
- Every completed scheduled run now gets a delivery summary. `emailReportRun` resolves `true`/`false` (false = no email service configured → recorded `failed`). Recipient union, order, 50 cap and email rendering are unchanged.
- The partner-owned `ScopeBadge` on saved reports is replaced by the Covers cell.

## Tests
<paste the summary lines of Task 9 Steps 1-3>

pt-BR strings are machine-drafted pending native review
es-419, fr-FR, fr-CA, de-DE, and it-IT strings are machine-drafted pending native review

Closes #<W01 sub-issue>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 6: One review round, then enqueue**

Run `/pr-review-toolkit:review-pr` once, and act only on confirmed findings. This wave is low blast radius (CLAUDE.md), so a fix does not trigger a second round unless it touches the migration or the worker's delivery tail. Enqueue with `gh pr merge <N>`, never `--admin`. After merge, call `complete_wave` for W01.

---

## Self-review against the spec

| Spec item | Task |
|---|---|
| §1 zero recipients silently skipped (`reportScheduleWorker.ts`, `if (recipients.length > 0)`) → recorded | 3 (red first: `records no_recipients … when the schedule resolves nobody`) |
| §3.2 `report_runs.delivery_status` CHECK IN (5 values), NULL for ad-hoc/legacy | 1 (schema + migration + CHECK), 3 (integration 23514) |
| §3.2 `not_scheduled` for manual runs of a scheduled definition | 4 (unit), 5 (integration) |
| §3.2 `recipient_count` = customer count; non-series customer = contacts ∪ typed addresses, `cc` = [] (coordinator ruling) | 2 (sets), 3 (`sent` counts typed addresses; typed-only → N) |
| §3.2 "no export-policy entry needed — confirmed during planning against the discovery rule" | Global Constraints (discovery = `getOrgCascadeDeleteOrder()`; `report_runs` is a pre-clear entry; pinned by `tenantExportPolicy.test.ts:391`); 9 (export suites unchanged) |
| §3.5 `no_recipients` when customer and CC both empty (CC-only `sent` arrives with W02 series children) | 2 (rule table), 3 |
| §3.5 `partial` / `failed` from the send outcome | 2, 3 (contract concerns 4-5 define them) |
| §3.6 `GET /reports` `orgName` from a join, respecting RLS | 5 (unit + integration org-token isolation) |
| §3.6 `GET /reports/runs` `orgId`, `orgName` (+ INDEX: `deliveryStatus`, `recipientCount`) | 5 |
| §3.7 Covers column — single org + Combined (replaces the lone ScopeBadge) | 6 |
| §3.7 Covers series kind (type-optional in W01) | 6 (`series?` prop, rendered only with `seriesId`) |
| §3.7 Recent Runs Org column | 6 |
| §3.7 / §1 org picker in New Report — fixes the 400 | 7 |
| §3.7 Templates: no blind ambient `currentOrgId` | 8 |
| Brief: "no recipients" warning chip on rows whose latest scheduled run is `no_recipients` | 5 (`lastDeliveryStatus`, contract concern 1), 6 |
| Brief: `fetchWithAuth` ambient injection must not mask the picker | 7 ("Why the body…" + `not.toHaveProperty('orgIdOverride')`) |
| Brief: locale strings for every locale of the reports namespace | 6 (all 8 catalogs) |
| §5 W01 tests: orgName + cross-org absence; worker red; Covers component; builder blocks submit client-side | 5, 3, 6, 7 |
| §3.7 filter chips, Series column, series Last-run summary | **W03** (§4) — not in W01 |

- **Placeholder scan.** No TBD, TODO or "similar to Task N" remains. Each code step shows its code. The "adjust the `name:` regex" note in Task 8 is a one-line confirmation against a named locale key, not missing code.
- **Type consistency.** These names are spelled the same in every task and match the INDEX:
  - `ReportDeliveryStatus`, `REPORT_DELIVERY_STATUSES`, `ScheduledSendOutcome`, `scheduledDeliveryStatus`;
  - `ScheduledRecipientSets`, `resolveScheduledReportRecipientSets`, `recordRunDelivery`;
  - `deliveryStatus`, `recipientCount`, `orgName`, `lastDeliveryStatus`;
  - `CoversCell`, `CoversSeriesSummary`, `DeliveryStatusChip`;
  - `useReportTargetOrg`, `ReportTargetOrg`, `OrgPickerField`, `defaultOrgId`.
