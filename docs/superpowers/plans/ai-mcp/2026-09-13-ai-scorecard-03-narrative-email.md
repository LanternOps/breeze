---
tracking_issue: TBD (register after Gate B)
wave_issue: TBD (W03 sub-issue)
branch: feature/<parent>-ai-scorecard/wave-<sub-issue>
---

# AI Scorecard W03 — Narrative email delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Read the hub first:** [`2026-09-13-ai-scorecard.md`](./2026-09-13-ai-scorecard.md). Its *Global Constraints* section is part of every task below.
> **Independent of W01, W02 and W04.** Branch off `main`.

**Goal:** The weekly AI org narrative reaches, by email, exactly the people whose *live* authority covers the whole org — and reaches them exactly once, with a delivery record that survives a crash and never reports "sent" for an email that never left.

**Architecture:** `emailReportRun` and `emailReportFailure` move verbatim out of `jobs/reportScheduleWorker.ts` into a new `services/reportDelivery.ts`, pinned before and after by a rendered-HTML snapshot so the extraction is provably inert. A new `report_run_deliveries` table gives one durable row per `(report_run_id, recipient_user_id, channel)`, created **atomically with the artifact** inside `persistNarrativeReport`'s existing transaction. Each row is claimed (`pending → claimed`) in a committed write **before** any network call, sent **outside** any transaction, and settled to `sent` / `failed` / `unknown`; an ambiguous provider outcome stays `unknown` forever and is never auto-reset. A reconciliation pass sweeps rows the process died on. Per recipient, `resolveLiveReportAuthority(userId, orgId, 'export')` must return `ok` with `scope.kind === 'unrestricted'`; `restricted` and `legacy_unscoped` both fail, and a transient `unverifiable_scope` leaves the row retryable rather than permanently refused. Both recipient writers refuse (409) on a narrative definition, and the worker exclusion is pinned by a contract test.

**Tech Stack:** Hono, Drizzle, PostgreSQL 16 (parent-FK-join RLS), BullMQ, Vitest, jsPDF via `@breeze/shared/reportPdf`, React + react-i18next.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-13-ai-scorecard-attribution-and-impact-design.md` §3.5, OD-7 B, OD-8 B.

**Tracking:** feature TBD, wave TBD. Branch `feature/<parent>-ai-scorecard/wave-<sub-issue>` off `main`. One PR, body `Closes #<wave sub-issue>` and `Refs #4248`.

## Global Constraints

Hub *Global Constraints* apply. W03-specific additions:

- Migration filename **`apps/api/migrations/2026-10-16-181710-report-run-deliveries.sql`**. No DML — no `set_config('breeze.scope', …)`, no `migrationRlsScope.test.ts` baseline entry.
- **`report_run_deliveries` needs exactly ONE registration: `PARENT_FK_JOIN_POLICY_TABLES` in `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:732`, mapped to `['reports']`.** Not `CORE_ORG_CASCADE_DELETE_ORDER`, not `CORE_TENANT_EXPORT_POLICY`, not `orgMergeRegistry.ts`, not `ASSOCIATED_SYSTEM_SCOPED_TABLES`, not the device lists, not `AUDIT_ADMIN_REQUIRED_TABLES`. The hub's registration table records the file:line evidence for every one of those answers — read it, do not re-derive it.
- **Declare `['reports']`, not `['report_runs']`.** `predicateCoversParent` (`apps/api/src/db/rlsPolicyShape.ts:92-97`) requires `breeze_has_org_access(<alias>.org_id)` on the **declared parent's** alias, and `report_runs` has no `org_id`. Declaring `report_runs` passes the loose assertion at `rls-coverage.integration.test.ts:1824` and fails the strict one at `:1904`.
- **The FK must be `ON DELETE CASCADE`.** That is the *reason* no `ASSOCIATED_SYSTEM_SCOPED_TABLES` entry is needed: the existing `report_runs` pre-clear (`services/tenantCascade.ts:949-954`) then removes deliveries for free. Weakening it to NO ACTION turns org erasure into a 23503 and silently makes two more registrations mandatory.
- **Never store the recipient's email address on the delivery row.** Store `recipient_user_id` and resolve `users.email` at send time. A stored address is PII in a table that is deliberately outside the tenant export and erasure registries.
- `'ai_org_narrative'` stays in `WORKER_EXCLUDED_REPORT_TYPES` (`jobs/reportScheduleWorker.ts:155`; note the constant holds **two** types — `['ai_org_narrative', 'ai_fleet_design']`). The narrative's delivery is the new table, never the report worker.
- **The extraction is behaviour-preserving.** Move the two functions *verbatim*. No signature change, no "while I'm here" improvements, no error-handling upgrade. Every behavioural change in this wave happens in new code around them.
- Preserve the existing failure-handling distinction: the report **worker** swallows delivery failure (`reportScheduleWorker.ts:724-727`, and `:748-752` for the failure mail), while the narrative notification path already enqueues durable retries (`runLoop.ts:2302`). Do not flatten them into one policy.
- Every task ends with the API typecheck, its targeted vitest run, and a commit.

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/services/reportDelivery.ts` (create) | `emailReportRun`, `emailReportFailure` — moved verbatim, exported |
| `apps/api/src/services/reportDelivery.snapshot.test.ts` (create) | the before/after rendering pin |
| `apps/api/src/jobs/reportScheduleWorker.ts` (modify, `:371-494`, `:724`, `:748`) | delete the two locals, import them instead |
| `apps/api/migrations/2026-10-16-181710-report-run-deliveries.sql` (create) | table + CHECKs + indexes + RLS |
| `apps/api/src/db/schema/reports.ts` (modify) | `reportRunDeliveries` |
| `apps/api/src/services/reportRunDelivery.ts` (create) | claim / settle / reconcile state machine |
| `apps/api/src/services/aiAgents/narrativeReport.ts` (modify, `:202-363`) | create delivery rows in the artifact transaction |
| `apps/api/src/services/aiAgents/runFinishedNotify.ts` (modify, `:470-624`) | authority gate, email resolution, send outside the transaction |
| `apps/api/src/jobs/reportRunDeliveryReconciler.ts` (create) | the independent sweep |
| `apps/api/src/routes/reports/recipients.ts` (modify, `:75-105`, `:136-233`) | 409 on both writers |
| `apps/web/src/components/aiAgents/…RunDetail…` (modify) | skipped-count line |

---

### Task 1: Pin the current email rendering with a snapshot — before touching anything

**Files:**
- Create: `apps/api/src/services/reportDelivery.snapshot.test.ts`

**Interfaces:**
- Produces: a snapshot of the exact HTML, text body, subject and attachment decisions `emailReportRun` produces today, plus the same for `emailReportFailure`. This is the control that makes the Task 2 extraction *provably* inert; writing it after the move would prove nothing.

- [ ] **Step 1: Write the test against the CURRENT (module-private) functions**

`emailReportRun` and `emailReportFailure` are module-private in `jobs/reportScheduleWorker.ts` today. Do **not** export them yet — drive them through the worker's public entry point with a mocked email service, and snapshot the `sendEmail` argument:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendEmail = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/email', () => ({ getEmailService: () => ({ sendEmail }) }));

describe('report email rendering is pinned before the reportDelivery extraction (#4248 W03)', () => {
  beforeEach(() => sendEmail.mockClear());

  it('pdf report with a small attachment', async () => {
    await runScheduledReportForTest({ format: 'pdf', rows: SMALL_ROWS, recipients: ['a@example.com'] });
    expect(sendEmail.mock.calls[0]![0]).toMatchSnapshot();
  });

  it('csv report', async () => {
    await runScheduledReportForTest({ format: 'csv', rows: SMALL_ROWS, recipients: ['a@example.com'] });
    expect(sendEmail.mock.calls[0]![0]).toMatchSnapshot();
  });

  it('oversize attachment falls back to a link', async () => {
    // MAX_ATTACHMENT_BYTES is 5 * 1024 * 1024 (reportScheduleWorker.ts:99);
    // the gates are at :439 (pdf) and :454 (csv).
    await runScheduledReportForTest({ format: 'csv', rows: HUGE_ROWS, recipients: ['a@example.com'] });
    const params = sendEmail.mock.calls[0]![0];
    expect(params.attachments).toBeUndefined();
    expect(params).toMatchSnapshot();
  });

  it('pdf render failure falls back to link-only without throwing', async () => {
    // reportScheduleWorker.ts:447-450 wraps buildReportPdf in try/catch.
    mockBuildReportPdfToThrow();
    await expect(runScheduledReportForTest({ format: 'pdf', rows: SMALL_ROWS, recipients: ['a@example.com'] }))
      .resolves.not.toThrow();
    expect(sendEmail.mock.calls[0]![0].attachments).toBeUndefined();
  });

  it('no email service configured is a silent no-op, not an error', async () => {
    // reportScheduleWorker.ts:413-417 returns early. This behaviour is EXACTLY why
    // a boolean "emailed_at" stamp is unsound (spec OD-8): a no-op would stamp sent.
    mockNoEmailService();
    await expect(runScheduledReportForTest({ format: 'pdf', rows: SMALL_ROWS, recipients: ['a@example.com'] }))
      .resolves.not.toThrow();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('failure mail omits the underlying error', async () => {
    await runFailedReportForTest({ recipients: ['a@example.com'], error: new Error('PG: relation "x" does not exist') });
    const params = sendEmail.mock.calls[0]![0];
    expect(JSON.stringify(params)).not.toContain('relation "x"');
    expect(params).toMatchSnapshot();
  });
});
```

- [ ] **Step 2: Run to verify it fails, then produces snapshots**

Run: `cd apps/api && npx vitest run src/services/reportDelivery.snapshot.test.ts`
Expected: first run FAILs on the helper scaffolding you have to write (`runScheduledReportForTest`), then, once wired, writes six snapshots and passes. **Inspect the written snapshots by eye** — a snapshot of the wrong thing is worse than no snapshot.

- [ ] **Step 3: Commit the snapshots**

```bash
git add apps/api/src/services/reportDelivery.snapshot.test.ts apps/api/src/services/__snapshots__
git commit -m "test(reports): pin the current report email rendering before extraction"
```

---

### Task 2: Extract `emailReportRun` / `emailReportFailure` verbatim into `services/reportDelivery.ts`

**Files:**
- Create: `apps/api/src/services/reportDelivery.ts`
- Modify: `apps/api/src/jobs/reportScheduleWorker.ts` (delete `:371-399` and `:401-494`; keep `MAX_ATTACHMENT_BYTES` usage by moving the constant too; update the two call sites at `:724` and `:748`)
- Test: `apps/api/src/services/reportDelivery.snapshot.test.ts` (Task 1 — must pass **unchanged**)

**Interfaces:**
- Produces (signatures **identical** to today's):
  ```ts
  export const MAX_ATTACHMENT_BYTES: number; // 5 * 1024 * 1024
  export async function emailReportRun(opts: {
    reportName: string; reportType: string; format: string; recipients: string[];
    rows: unknown[]; summary?: Record<string, unknown>;
    previous?: ReportResult['previous']; trendLine?: string | null;
    timezone: string; branding: ReportBranding;
  }): Promise<void>;
  export async function emailReportFailure(opts: { reportName: string; recipients: string[] }): Promise<void>;
  ```
  Note the shape this imposes on everything downstream: it takes **email address strings**, not user ids; it builds in-memory PDF/CSV `Buffer`s; it touches no db handle and no object storage.

- [ ] **Step 1: Run the pin to confirm green before the move**

Run: `cd apps/api && npx vitest run src/services/reportDelivery.snapshot.test.ts`
Expected: PASS, 6 tests, 0 snapshots written.

- [ ] **Step 2: Move the code**

Cut `:371-399` and `:401-494` (plus `MAX_ATTACHMENT_BYTES` at `:99`) into `apps/api/src/services/reportDelivery.ts` **byte for byte**, add `export`, and bring these imports with them:

| Symbol | From |
|---|---|
| `getEmailService` | `./email` (was `../services/email`, `:53`) |
| `renderLayout`, `renderButton`, `renderParagraph`, `escapeHtml` | `./emailLayout` (`:54`) |
| `buildReportPdf`, `type ReportBranding` | `@breeze/shared/reportPdf` (`:63`) |
| `rowsToCsv` | `@breeze/shared` (`:57-62`) |
| `type PostureSummary`, `ExecutiveSummary` | `@breeze/shared` (`:64`) |
| `type ReportResult` | `./reportGenerationService` (`:47-52`) |

Both functions read `process.env.DASHBOARD_URL` / `PUBLIC_APP_URL` inline — leave those reads exactly where they are.

In `reportScheduleWorker.ts`, import the two functions and the constant from `../services/reportDelivery`. **Do not change the call sites' error handling** at `:724-727` or `:748-752`.

- [ ] **Step 3: Run the pin again — it must pass with zero snapshot churn**

```bash
cd apps/api && npx vitest run src/services/reportDelivery.snapshot.test.ts
cd apps/api && npx vitest run src/jobs/reportScheduleWorker.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS with `0 written, 0 obsolete`. **Any snapshot churn means the move was not verbatim — revert and redo it.**

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/reportDelivery.ts apps/api/src/jobs/reportScheduleWorker.ts
git commit -m "refactor(reports): extract emailReportRun/emailReportFailure into services/reportDelivery.ts (behaviour-preserving)"
```

---

### Task 3: Migration — `report_run_deliveries` with parent-FK-join RLS

**Files:**
- Create: `apps/api/migrations/2026-10-16-181710-report-run-deliveries.sql`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`PARENT_FK_JOIN_POLICY_TABLES` at `:732`)
- Test: `apps/api/src/db/autoMigrate.test.ts`, `apps/api/src/db/migrationRlsScope.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/db/autoMigrate.test.ts
it('the report_run_deliveries migration sorts last among committed files', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort((a, b) => a.localeCompare(b));
  expect(files).toContain('2026-10-16-181710-report-run-deliveries.sql');
});
```

And add the allowlist entry as a *failing* assertion first, in `rls-coverage.integration.test.ts`:

```ts
  // #4248 W03: per-recipient narrative delivery. Declared parent is `reports`,
  // NOT `report_runs` -- the strict per-command assertion below runs
  // predicateCoversParent, which needs breeze_has_org_access(<alias>.org_id) on
  // the DECLARED parent's alias, and report_runs has no org_id. The policy
  // therefore reaches `reports` through a scalar subquery, exactly like the
  // config_policy_* children do (2026-06-23-sec-review-1-fk-child-rls-backstop.sql).
  ['report_run_deliveries', ['reports']],
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/api && npx vitest run src/db/autoMigrate.test.ts
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: the unit test FAILs on the missing file; the integration test FAILs with `report_run_deliveries` in the offenders list (RLS off / no covering policy).

- [ ] **Step 3: Write the migration**

```sql
-- 2026-10-16-181710-report-run-deliveries.sql
-- #4248 W03: durable per-recipient delivery record for the weekly AI org narrative.
--
-- Why a table and not a `report_runs.narrative_emailed_at` CAS (spec OD-8):
--   * a CAS is at-most-once and POSSIBLY ZERO -- claim commits, process dies
--     before sending, and the narrative is permanently lost with the flag
--     saying "sent";
--   * emailReportRun RETURNS NORMALLY when no email service is configured
--     (reportScheduleWorker.ts:413-417), so a no-op would stamp "emailed";
--   * the notification loop runs inside inSystemDbContext
--     (runFinishedNotify.ts:551), so sending inside that transaction and then
--     rolling back erases the claim AFTER the mail has left.
--
-- No org_id and no partner_id: tenancy is the grandparent report definition's,
-- exactly as for report_runs itself. Registered ONLY in
-- PARENT_FK_JOIN_POLICY_TABLES (rls-coverage.integration.test.ts) -> ['reports'].
-- Deliberately NOT in CORE_ORG_CASCADE_DELETE_ORDER (deleteOrgRows would emit
-- `DELETE ... WHERE org_id = $1` and raise 42703), NOT in CORE_TENANT_EXPORT_POLICY
-- (buildTenantExportPlan only ever receives getOrgCascadeDeleteOrder()), and NOT
-- in orgMergeRegistry (the merge walk only reaches cascade-order tables).
--
-- The ON DELETE CASCADE below is load-bearing for all three of those "no"s: it
-- is why no ASSOCIATED_SYSTEM_SCOPED_TABLES clearSql entry is needed -- the
-- existing report_runs pre-clear (tenantCascade.ts:949-954) removes these rows
-- for free. Weakening it makes org erasure raise 23503 and makes two more
-- registrations mandatory.
--
-- recipient_user_id is a BARE uuid, and the recipient's EMAIL ADDRESS IS NEVER
-- STORED: it is resolved from `users` at send time. A stored address would be
-- PII in a table that is deliberately outside the export and erasure registries.
--
-- No DML in this file.

CREATE TABLE IF NOT EXISTS public.report_run_deliveries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_run_id     uuid NOT NULL REFERENCES public.report_runs(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL,
  channel           text NOT NULL,
  state             text NOT NULL DEFAULT 'pending',
  attempts          integer NOT NULL DEFAULT 0,
  last_error        text,
  claimed_at        timestamptz,
  sent_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  ALTER TABLE public.report_run_deliveries
    ADD CONSTRAINT report_run_deliveries_channel_chk CHECK (channel IN ('email'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.report_run_deliveries
    ADD CONSTRAINT report_run_deliveries_state_chk
    CHECK (state IN ('pending', 'claimed', 'sent', 'failed', 'unknown'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS report_run_deliveries_run_recipient_channel_uq
  ON public.report_run_deliveries (report_run_id, recipient_user_id, channel);

-- The reconciliation scan: only unsettled rows, so the index stays tiny.
CREATE INDEX IF NOT EXISTS report_run_deliveries_unsettled_idx
  ON public.report_run_deliveries (state, claimed_at)
  WHERE state IN ('pending', 'claimed');

CREATE INDEX IF NOT EXISTS report_run_deliveries_run_idx
  ON public.report_run_deliveries (report_run_id);

-- --------------------------------------------------------------------------
-- RLS: parent-FK join, two hops to the org-bearing grandparent.
-- Shape copied from report_runs' own policies
-- (2026-06-13-b-fk-child-rls-backstop.sql:173-194), with one extra hop
-- expressed as a scalar subquery -- the same construction the config_policy_*
-- children use (2026-06-23-sec-review-1-fk-child-rls-backstop.sql:108-112).
--
-- `reports` MUST be the table in the EXISTS ... FROM: the contract test's
-- matcher (db/rlsPolicyShape.ts:92-97) looks for breeze_has_org_access on an
-- alias of the DECLARED parent, and report_runs has no org_id.
--
-- breeze_has_org_access short-circuits TRUE under scope 'system'
-- (0008-tenant-rls.sql:47-50), so the delivery worker's system context passes
-- without any extra branch.
-- --------------------------------------------------------------------------
ALTER TABLE public.report_run_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_run_deliveries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON public.report_run_deliveries;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.report_run_deliveries;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.report_run_deliveries;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.report_run_deliveries;

CREATE POLICY breeze_org_isolation_select ON public.report_run_deliveries FOR SELECT USING (
  EXISTS (SELECT 1 FROM reports r
          WHERE r.id = (SELECT rr.report_id FROM report_runs rr WHERE rr.id = report_run_deliveries.report_run_id)
            AND public.breeze_has_org_access(r.org_id))
);
CREATE POLICY breeze_org_isolation_insert ON public.report_run_deliveries FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM reports r
          WHERE r.id = (SELECT rr.report_id FROM report_runs rr WHERE rr.id = report_run_deliveries.report_run_id)
            AND public.breeze_has_org_access(r.org_id))
);
CREATE POLICY breeze_org_isolation_update ON public.report_run_deliveries FOR UPDATE USING (
  EXISTS (SELECT 1 FROM reports r
          WHERE r.id = (SELECT rr.report_id FROM report_runs rr WHERE rr.id = report_run_deliveries.report_run_id)
            AND public.breeze_has_org_access(r.org_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM reports r
          WHERE r.id = (SELECT rr.report_id FROM report_runs rr WHERE rr.id = report_run_deliveries.report_run_id)
            AND public.breeze_has_org_access(r.org_id))
);
CREATE POLICY breeze_org_isolation_delete ON public.report_run_deliveries FOR DELETE USING (
  EXISTS (SELECT 1 FROM reports r
          WHERE r.id = (SELECT rr.report_id FROM report_runs rr WHERE rr.id = report_run_deliveries.report_run_id)
            AND public.breeze_has_org_access(r.org_id))
);
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
pnpm test-stack up && pnpm db:migrate && pnpm db:migrate   # second run must be a no-op
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: PASS, including **both** the loose (`:1824`) and strict (`:1904`) parent-FK assertions.

- [ ] **Step 5: Forge a cross-tenant row as `breeze_app`**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze
-- set an org-A context, then INSERT a delivery row for a report_run whose
-- report belongs to org B.
```
Expected: `new row violates row-level security policy`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-10-16-181710-report-run-deliveries.sql apps/api/src/db/autoMigrate.test.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(reports): report_run_deliveries table with parent-FK-join RLS"
```

---

### Task 4: Drizzle schema for `reportRunDeliveries`

**Files:**
- Modify: `apps/api/src/db/schema/reports.ts` (after `report_schedule_recipients`, `:165-192`)
- Test: `pnpm db:check-drift`

**Interfaces:**
- Produces: `reportRunDeliveries` with `id, reportRunId, recipientUserId, channel, state, attempts, lastError, claimedAt, sentAt, createdAt, updatedAt`, plus `export const REPORT_RUN_DELIVERY_STATES = ['pending','claimed','sent','failed','unknown'] as const;` and `export type ReportRunDeliveryState = …`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/db/schema/reports.test.ts
it('report_run_deliveries carries no org_id and no email address', () => {
  const cols = Object.keys(getTableColumns(reportRunDeliveries));
  expect(cols).not.toContain('orgId');
  expect(cols).not.toContain('partnerId');
  expect(cols.some((c) => /email/i.test(c))).toBe(false);   // PII stays in `users`
  expect(cols).toEqual(expect.arrayContaining(['reportRunId', 'recipientUserId', 'channel', 'state']));
});

it('exposes the five states, and only those', () => {
  expect([...REPORT_RUN_DELIVERY_STATES]).toEqual(['pending', 'claimed', 'sent', 'failed', 'unknown']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/db/schema/reports.test.ts`
Expected: FAIL — `reportRunDeliveries` is not exported.

- [ ] **Step 3: Write the schema**, mirroring the migration exactly (`text` for `state`/`channel`, not a pg enum — the CHECK constraints are the source of truth and a text column keeps a future channel a one-line migration).

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/db/schema/reports.test.ts
pnpm db:check-drift
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS, no drift.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/reports.ts apps/api/src/db/schema/reports.test.ts
git commit -m "feat(reports): Drizzle schema for report_run_deliveries"
```

---

### Task 5: The delivery state machine — claim before send, settle after, never reset `unknown`

**Files:**
- Create: `apps/api/src/services/reportRunDelivery.ts`
- Create: `apps/api/src/services/reportRunDelivery.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function createPendingDeliveries(tx: Tx, reportRunId: string, recipientUserIds: readonly string[], channel: 'email'): Promise<number>;
  /** Committed BEFORE any network call. Returns false when someone else claimed it. */
  export async function claimDelivery(deliveryId: string): Promise<boolean>;
  export async function settleDelivery(deliveryId: string, outcome:
    | { state: 'sent' }
    | { state: 'failed'; error: string }
    | { state: 'unknown'; error: string }): Promise<void>;
  export async function listUnsettledDeliveries(olderThan: Date, limit: number): Promise<DeliveryRow[]>;
  export async function summarizeDeliveries(reportRunId: string): Promise<{ total: number; sent: number; failed: number; unknown: number; pending: number }>;
  export const STALE_CLAIM_MS: number; // 15 * 60 * 1000
  ```

**State rules (these are the wave's contract, not implementation detail):**

| From | To | When |
|---|---|---|
| `pending` | `claimed` | `claimDelivery`, a single committed `UPDATE … WHERE state = 'pending'`. Losing the race returns `false` and the caller sends nothing. |
| `claimed` | `sent` | provider accepted |
| `claimed` | `failed` | provider refused, or the authority gate permanently refused this recipient |
| `claimed` | `unknown` | ambiguous outcome (timeout, connection reset, unclassifiable throw) |
| `claimed` | `unknown` | reconciler: the claim went stale (`claimed_at < now() − STALE_CLAIM_MS`) |
| `unknown` | — | **nothing.** Never auto-reset to `pending`. `services/email.ts:240`'s `SendEmailParams` (`:17-30`) has no idempotency key, and even Resend's own dedupe retains only 24 h, so unlimited replay is not safe. Replay is a human decision. |
| `pending` | `pending` | the authority gate returned `unverifiable_scope` — a *transient* resolver failure (`services/siteScope.ts:108`), so the row stays retryable with `last_error` recorded |

- [ ] **Step 1: Write the failing test**

```ts
describe('report run delivery state machine (#4248 W03, OD-8)', () => {
  it('claims a pending row exactly once', async () => {
    const id = await seedDelivery({ state: 'pending' });
    expect(await claimDelivery(id)).toBe(true);
    expect(await claimDelivery(id)).toBe(false);           // second claimant sends nothing
  });

  it('the claim is committed before the caller can send', async () => {
    const id = await seedDelivery({ state: 'pending' });
    await claimDelivery(id);
    expect((await readDelivery(id)).state).toBe('claimed'); // visible to a separate connection
  });

  it('increments attempts on claim', async () => {
    const id = await seedDelivery({ state: 'pending' });
    await claimDelivery(id);
    expect((await readDelivery(id)).attempts).toBe(1);
  });

  it('never resets an unknown row to pending', async () => {
    const id = await seedDelivery({ state: 'unknown' });
    await runReconcilerOnce();
    expect((await readDelivery(id)).state).toBe('unknown');
  });

  it('promotes a stale claim to unknown rather than resending', async () => {
    const id = await seedDelivery({ state: 'claimed', claimedAt: new Date(Date.now() - STALE_CLAIM_MS - 1) });
    await runReconcilerOnce();
    const row = await readDelivery(id);
    expect(row.state).toBe('unknown');
    expect(row.lastError).toMatch(/stale/i);
  });

  it('re-claims a pending row the reconciler finds', async () => {
    const id = await seedDelivery({ state: 'pending', createdAt: new Date(Date.now() - 60 * 60 * 1000) });
    await runReconcilerOnce();
    expect((await readDelivery(id)).state).toBe('sent');
  });

  it('summarizes per run', async () => {
    const runId = await seedRunWithDeliveries(['sent', 'sent', 'failed', 'unknown', 'pending']);
    expect(await summarizeDeliveries(runId)).toEqual({ total: 5, sent: 2, failed: 1, unknown: 1, pending: 1 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/reportRunDelivery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation.** `claimDelivery` runs `runOutsideDbContext(() => withSystemDbAccessContext(...))` around a single `UPDATE … RETURNING id`, so the claim is its **own** committed transaction and cannot be rolled back by a caller's enclosing one. Every state write records `updated_at = now()`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/reportRunDelivery.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/reportRunDelivery.ts apps/api/src/services/reportRunDelivery.test.ts
git commit -m "feat(reports): claim-before-send delivery state machine for report runs"
```

---

### Task 6: Create the delivery rows atomically with the narrative artifact

**Files:**
- Modify: `apps/api/src/services/aiAgents/narrativeReport.ts` (`persistNarrativeReport`, `:202-363` — the whole body is already one `inSystemDbContext` transaction)
- Modify: its caller in the narrative finalizer (resolve recipients before persisting)
- Test: `apps/api/src/services/aiAgents/narrativeReport.test.ts`

**Interfaces:**
- Consumes: `createPendingDeliveries` (Task 5), `resolveRecipientUserIds` (`services/aiAgents/recipients.ts:257-263`).
- Produces: `NarrativePersistInput` gains `emailRecipientUserIds: readonly string[]`; `persistNarrativeReport`'s return gains `deliveriesCreated: number`.

**Why here and not in `runFinishedNotify`.** Today the narrative is discovered through `outcome.narrativeReport` (`runFinishedNotify.ts:169-179` → `:495`), which is persisted only *after* the artifact commits. A crash in that gap loses the delivery intent entirely. Creating the rows inside the artifact transaction makes "the narrative exists" and "someone is supposed to receive it" a single atomic fact.

- [ ] **Step 1: Write the failing test**

```ts
it('creates one pending delivery row per recipient inside the artifact transaction', async () => {
  const out = await persistNarrativeReport({ ...input, emailRecipientUserIds: ['u1', 'u2'] });
  expect(out.deliveriesCreated).toBe(2);
  const rows = await readDeliveries(out.reportRunId);
  expect(rows.map((r) => r.state)).toEqual(['pending', 'pending']);
});

it('creates no delivery rows when there are no recipients', async () => {
  const out = await persistNarrativeReport({ ...input, emailRecipientUserIds: [] });
  expect(out.deliveriesCreated).toBe(0);
});

it('a rollback of the artifact transaction leaves NO orphan delivery rows', async () => {
  // force the CAS at :346-359 to lose (report_run_id already set)
  await expect(persistNarrativeReport({ ...inputWithRunAlreadyLinked, emailRecipientUserIds: ['u1'] }))
    .rejects.toBeInstanceOf(NarrativePersistConflictError);
  expect(await countAllDeliveries()).toBe(0);
});

it('is idempotent per recipient — a retried persist does not double the rows', async () => {
  // the (report_run_id, recipient_user_id, channel) unique index plus
  // onConflictDoNothing
  await createPendingDeliveries(tx, RUN, ['u1'], 'email');
  expect(await createPendingDeliveries(tx, RUN, ['u1'], 'email')).toBe(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiAgents/narrativeReport.test.ts`
Expected: FAIL — `deliveriesCreated` undefined.

- [ ] **Step 3: Write the implementation** — insert the rows right after the `report_runs` insert (`:310-325`) and before the CAS at `:346-359`, using `onConflictDoNothing()`. The caller (the narrative finalizer) resolves `emailRecipientUserIds` with `resolveRecipientUserIds(agent, run.orgId)` *before* calling `persistNarrativeReport`, so the persist stays a pure DB operation.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/aiAgents/narrativeReport.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiAgents/narrativeReport.ts apps/api/src/services/aiAgents/narrativeReport.test.ts
git commit -m "feat(reports): create narrative delivery rows atomically with the artifact"
```

---

### Task 7: The per-recipient authority gate and the actual send

**Files:**
- Modify: `apps/api/src/services/aiAgents/runFinishedNotify.ts` (narrative branch `:470-624`; `inSystemDbContext` helper `:332-335`; recipient resolution `:470-481`)
- Create: `apps/api/src/services/reportNarrativeDelivery.ts` (the send loop — keeps the notify file from growing another 200 lines)
- Test: `apps/api/src/services/reportNarrativeDelivery.test.ts`

**Interfaces:**
- Consumes: `resolveLiveReportAuthority` (`services/siteScope.ts:1061-1067`), `claimDelivery`/`settleDelivery` (Task 5), `emailReportRun` (Task 2).
- Produces: `export async function deliverNarrativeEmails(reportRunId: string, ctx: NarrativeDeliveryContext): Promise<DeliverySummary>`.

**The gate, exactly:**

```ts
const live = await resolveLiveReportAuthority(userId, orgId, 'export');   // siteScope.ts:1061
if (!live.ok) {
  // reasons: user_inactive | membership_removed | permission_removed
  //        | organization_inaccessible | empty_scope | unverifiable_scope (siteScope.ts:98-109)
  if (live.reason === 'unverifiable_scope') {
    // The resolver threw. Denied-for-now, not denied-forever: leave the row
    // retryable so a transient DB blip does not silently kill a weekly report.
    await recordTransientGateFailure(delivery.id, live.reason);   // stays 'pending'
  } else {
    await settleDelivery(delivery.id, { state: 'failed', error: `authority:${live.reason}` });
  }
  continue;
}
if (live.authority.scope.kind !== 'unrestricted') {
  // 'restricted' AND 'legacy_unscoped' both fail. legacy_unscoped means the
  // scope is UNPROVABLE, and an unprovable scope is not an unrestricted one.
  // An email attaches full-org data; a site-restricted recipient must not get it.
  await settleDelivery(delivery.id, { state: 'failed', error: 'authority:scope_not_unrestricted' });
  continue;
}
```

Survivors are resolved user-id → `users.email` — **a step that does not exist on this path today**, because `emailReportRun` takes address strings (Task 2's interface note). A recipient with no usable email settles `failed` with `authority:no_email`.

**Ordering rules that make this sound:**
1. Resolve the authority and the email **before** claiming (a refusal should not burn an attempt).
2. `claimDelivery(id)` — its own committed transaction.
3. `emailReportRun(...)` — **outside every DB transaction**. Do **not** call it inside `inSystemDbContext` (`:332-335`, used by the notification loop at `:551`): a rollback there would erase the claim after the mail had already left.
4. `settleDelivery(...)`.

Recipients who fail the gate keep their **in-app notification unchanged** (the loop at `:551-624` is untouched) — the download route already re-verifies the requester's live authority and 404s a restricted requester. Only the *email* is withheld.

A run where **every** recipient fails logs a counted, non-failing outcome: `console.warn('[narrativeDelivery] all recipients skipped', { reportRunId, orgId, refused, transient })`. **Silence must be observable.**

- [ ] **Step 1: Write the failing test**

```ts
describe('narrative email authority gate (#4248 W03)', () => {
  it('delivers to an unrestricted recipient', async () => {
    mockAuthority('u1', { ok: true, authority: { scope: { kind: 'unrestricted' } } });
    const s = await deliverNarrativeEmails(RUN, ctx);
    expect(emailReportRunMock).toHaveBeenCalledTimes(1);
    expect(s).toMatchObject({ sent: 1, failed: 0 });
  });

  it('withholds the email from a site-restricted recipient', async () => {
    mockAuthority('u1', { ok: true, authority: { scope: { kind: 'restricted', siteIds: ['s1'] } } });
    const s = await deliverNarrativeEmails(RUN, ctx);
    expect(emailReportRunMock).not.toHaveBeenCalled();
    expect(s).toMatchObject({ sent: 0, failed: 1 });
  });

  it('withholds from legacy_unscoped — an unprovable scope is not an unrestricted one', async () => {
    mockAuthority('u1', { ok: true, authority: { scope: { kind: 'legacy_unscoped' } } });
    const s = await deliverNarrativeEmails(RUN, ctx);
    expect(emailReportRunMock).not.toHaveBeenCalled();
    expect(s).toMatchObject({ failed: 1 });
  });

  it('leaves a row RETRYABLE when the scope is only temporarily unverifiable', async () => {
    mockAuthority('u1', { ok: false, reason: 'unverifiable_scope' });
    await deliverNarrativeEmails(RUN, ctx);
    expect((await readDeliveryFor('u1')).state).toBe('pending');
    expect(emailReportRunMock).not.toHaveBeenCalled();
  });

  it('permanently refuses a removed membership', async () => {
    mockAuthority('u1', { ok: false, reason: 'membership_removed' });
    await deliverNarrativeEmails(RUN, ctx);
    expect((await readDeliveryFor('u1')).state).toBe('failed');
  });

  it('a second finalizer pass sends ZERO additional emails', async () => {
    mockAuthority('u1', { ok: true, authority: { scope: { kind: 'unrestricted' } } });
    await deliverNarrativeEmails(RUN, ctx);
    emailReportRunMock.mockClear();
    await deliverNarrativeEmails(RUN, ctx);
    expect(emailReportRunMock).not.toHaveBeenCalled();
  });

  it('sends OUTSIDE any db transaction', async () => {
    mockAuthority('u1', { ok: true, authority: { scope: { kind: 'unrestricted' } } });
    emailReportRunMock.mockImplementation(async () => {
      expect(currentDbContext(), 'a send inside a transaction can be rolled back after the mail leaves').toBeUndefined();
    });
    await deliverNarrativeEmails(RUN, ctx);
    expect(emailReportRunMock).toHaveBeenCalled();
  });

  it('records an ambiguous provider outcome as unknown, not as sent or failed', async () => {
    mockAuthority('u1', { ok: true, authority: { scope: { kind: 'unrestricted' } } });
    emailReportRunMock.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    await deliverNarrativeEmails(RUN, ctx);
    expect((await readDeliveryFor('u1')).state).toBe('unknown');
  });

  it('logs a counted outcome when every recipient is skipped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockAuthority('u1', { ok: true, authority: { scope: { kind: 'restricted', siteIds: [] } } });
    await deliverNarrativeEmails(RUN, ctx);
    expect(warn.mock.calls.flat().join(' ')).toContain('all recipients skipped');
  });

  it('leaves the in-app notification untouched for a refused recipient', async () => {
    mockAuthority('u1', { ok: true, authority: { scope: { kind: 'restricted', siteIds: ['s1'] } } });
    await runFinishedNotify(narrativeRun);
    expect(createNotificationMock).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/reportNarrativeDelivery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation** per the gate and ordering above, and call `deliverNarrativeEmails` from the narrative branch of `runFinishedNotify` **after** the `inSystemDbContext` notification loop at `:551-624` closes.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/reportNarrativeDelivery.test.ts src/services/aiAgents/runFinishedNotify.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS, 10 tests in the first file.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/reportNarrativeDelivery.ts apps/api/src/services/reportNarrativeDelivery.test.ts apps/api/src/services/aiAgents/runFinishedNotify.ts
git commit -m "feat(reports): per-recipient export-authority gate and transaction-free narrative email send"
```

---

### Task 8: The reconciliation pass

**Files:**
- Create: `apps/api/src/jobs/reportRunDeliveryReconciler.ts`
- Create: `apps/api/src/jobs/reportRunDeliveryReconciler.test.ts`
- Modify: wherever repeatable jobs are registered (find with `grep -rn "repeat:" apps/api/src/jobs | head`)

**Interfaces:**
- Consumes: `listUnsettledDeliveries`, `claimDelivery`, `settleDelivery`, `STALE_CLAIM_MS`.
- Produces: `export async function reconcileReportRunDeliveries(now?: Date): Promise<{ resent: number; markedUnknown: number }>`; a repeatable job on a 15-minute cadence.

**What it does, and deliberately does not do:**
- `pending` rows older than one cadence tick → run the full Task 7 path (gate → claim → send → settle). A crash *before* the claim means nothing was sent, so this is safe.
- `claimed` rows older than `STALE_CLAIM_MS` → settle to `unknown` with `last_error = 'reconciler: claim went stale; send outcome unknown'`. **Do not resend.** The email service has no idempotency key (`services/email.ts:17-30`), so a resend is a real duplicate risk; making the ambiguity visible is the honest move.
- `unknown` rows → **never touched.** Replay is a human decision.
- Runs under `runOutsideDbContext(() => withSystemDbAccessContext(...))`, one short-lived context per row, never a long-held connection.

- [ ] **Step 1: Write the failing test**

```ts
it('sends a pending row the finalizer never got to', async () => {
  await seedDelivery({ state: 'pending', createdAt: hoursAgo(2) });
  expect(await reconcileReportRunDeliveries()).toMatchObject({ resent: 1 });
});

it('marks a stale claim unknown and does not resend it', async () => {
  await seedDelivery({ state: 'claimed', claimedAt: new Date(Date.now() - STALE_CLAIM_MS - 1) });
  const out = await reconcileReportRunDeliveries();
  expect(out).toMatchObject({ resent: 0, markedUnknown: 1 });
  expect(emailReportRunMock).not.toHaveBeenCalled();
});

it('leaves a fresh claim alone', async () => {
  await seedDelivery({ state: 'claimed', claimedAt: new Date() });
  expect(await reconcileReportRunDeliveries()).toMatchObject({ resent: 0, markedUnknown: 0 });
});

it('never touches sent, failed or unknown rows', async () => {
  for (const state of ['sent', 'failed', 'unknown'] as const) await seedDelivery({ state, claimedAt: hoursAgo(9) });
  expect(await reconcileReportRunDeliveries()).toMatchObject({ resent: 0, markedUnknown: 0 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/jobs/reportRunDeliveryReconciler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation.**

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/jobs/reportRunDeliveryReconciler.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/reportRunDeliveryReconciler.ts apps/api/src/jobs/reportRunDeliveryReconciler.test.ts
git commit -m "feat(reports): reconciliation pass for unsettled narrative deliveries"
```

---

### Task 9: Close the other two doors — 409 on both recipient writers, contract-pin the worker exclusion

**Files:**
- Modify: `apps/api/src/routes/reports/recipients.ts` (`POST /:id/recipients` at `:75-105`; `POST /:id/recipients/convert` at `:136-233`)
- Create: `apps/api/src/jobs/reportScheduleWorker.contract.test.ts`
- Test: `apps/api/src/routes/reports/recipients.test.ts`

**Interfaces:**
- Produces: both writers return `409 { error: 'report_type_system_managed', type }` for a definition whose `type` is in `WORKER_EXCLUDED_REPORT_TYPES`.

**Why both.** Verified on `main`: **neither** handler branches on `report.type` — both only call `getReportWithOrgCheck` (org scoping). `/recipients/convert` inserts into `report_schedule_recipients` **independently** of `/recipients` (it finds-or-creates a `contacts` row and then inserts, `:152-216`), so guarding only the first leaves the second wide open.

- [ ] **Step 1: Write the failing test**

```ts
it('refuses a recipient on an ai_org_narrative definition', async () => {
  const res = await app.request(`/reports/${NARRATIVE_ID}/recipients`,
    { method: 'POST', body: JSON.stringify({ contactId: C }) }, env);
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe('report_type_system_managed');
});

it('refuses the CONVERT writer too — it inserts independently', async () => {
  const res = await app.request(`/reports/${NARRATIVE_ID}/recipients/convert`,
    { method: 'POST', body: JSON.stringify({ email: 'a@example.com' }) }, env);
  expect(res.status).toBe(409);
});

it('refuses ai_fleet_design as well — the exclusion list holds two types', async () => {
  const res = await app.request(`/reports/${FLEET_DESIGN_ID}/recipients`,
    { method: 'POST', body: JSON.stringify({ contactId: C }) }, env);
  expect(res.status).toBe(409);
});

it('still accepts a recipient on an ordinary scheduled report', async () => {
  const res = await app.request(`/reports/${ORDINARY_ID}/recipients`,
    { method: 'POST', body: JSON.stringify({ contactId: C }) }, env);
  expect(res.status).toBe(200);
});

// reportScheduleWorker.contract.test.ts
it('the report worker still excludes the AI narrative', () => {
  expect([...WORKER_EXCLUDED_REPORT_TYPES]).toContain('ai_org_narrative');
});

it('the exclusion is enforced in BOTH places, not just findDueReports', () => {
  const src = readFileSync(path.join(__dirname, 'reportScheduleWorker.ts'), 'utf8');
  const uses = src.match(/WORKER_EXCLUDED_REPORT_TYPES/g) ?? [];
  expect(uses.length, 'expected the definition plus findDueReports (:163) and processRunScheduledReport (:513)')
    .toBeGreaterThanOrEqual(3);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/reports/recipients.test.ts src/jobs/reportScheduleWorker.contract.test.ts`
Expected: FAIL — the first three get 200.

- [ ] **Step 3: Write the implementation** — one shared guard helper called from both handlers immediately after `getReportWithOrgCheck`, keyed on `WORKER_EXCLUDED_REPORT_TYPES` so a future system-managed type is covered automatically.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/routes/reports src/jobs/reportScheduleWorker.contract.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS. `src/routes/reports` is a substring filter — check the count.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/reports apps/api/src/jobs/reportScheduleWorker.contract.test.ts
git commit -m "feat(reports): refuse manual recipients on system-managed report definitions"
```

---

### Task 10: Surface the skipped count on the agent-run detail (OD-7 B)

**Files:**
- Modify: `apps/api/src/routes/aiAgents.ts` (the run-detail handler)
- Modify: `packages/shared/src/types/` (the run-detail DTO)
- Modify: the web run-detail component (find with `grep -rln "AiAgentRunDetailDto" apps/web/src`)
- Modify: `apps/web/src/locales/*/ai.json` ×8
- Test: the run-detail route test + the web component test + `localeParity` / `translationCoverage`

**Interfaces:**
- Produces: `AiAgentRunDetailDto.narrativeDelivery?: { total: number; sent: number; skipped: number; unknown: number } | null`, where `skipped = failed + pending`. **Additive and nullable, so no DTO schema-version bump** (the wave-6.1 rule P2-3 established).

**Why this is acceptable and C was rejected.** A skipped count is a small authority oracle — but only to someone who already holds `ai_agents:read` on that run. Weigh that against the alternative the spec rejects outright: a permanently invisible failure, where a partner admin cannot tell why a customer contact never got the weekly report. Option C (fail the whole delivery if any recipient fails) is **rejected**: one site-restricted contact would silently kill the weekly report for everyone.

- [ ] **Step 1: Write the failing test**

```ts
// route
it('reports how many narrative recipients were skipped', async () => {
  seedDeliveries(RUN, ['sent', 'sent', 'failed', 'pending']);
  const body = await (await app.request(`/ai/agents/runs/${RUN}`, {}, env)).json();
  expect(body.data.narrativeDelivery).toEqual({ total: 4, sent: 2, skipped: 2, unknown: 0 });
});

it('is null for a run that produced no narrative', async () => {
  const body = await (await app.request(`/ai/agents/runs/${TRIAGE_RUN}`, {}, env)).json();
  expect(body.data.narrativeDelivery).toBeNull();
});

// web
it('shows the skipped line with the reason class, not the recipients', async () => {
  renderRunDetail({ narrativeDelivery: { total: 4, sent: 2, skipped: 2, unknown: 0 } });
  const el = await screen.findByTestId('narrative-delivery-summary');
  expect(el).toHaveTextContent('2');
  expect(el.textContent).not.toMatch(/@/);   // never name or email a recipient
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/api && npx vitest run src/routes/aiAgents.test.ts
cd apps/web && npx vitest run src/components/aiAgents
```
Expected: FAIL — `narrativeDelivery` undefined.

- [ ] **Step 3: Write the implementation** using `summarizeDeliveries` (Task 5). Copy: *"N recipients skipped (insufficient report authority)"*. **Never list who.**

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/routes/aiAgents.test.ts
cd apps/web && npx vitest run src/components/aiAgents src/lib/i18n
cd apps/web && npx astro check
```
Expected: PASS, with real translations in all 8 locales and no coverage baseline raised.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/aiAgents.ts packages/shared/src/types apps/web/src
git commit -m "feat(reports): show the narrative delivery skipped count on the agent run detail"
```

---

### Task 11: Live-database suites and the PR

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/__tests__/integration/narrativeEmailDelivery.integration.test.ts`, against real Postgres:

```ts
import './setup';

describe('narrative email delivery (#4248 W03)', () => {
  it('an unrestricted recipient receives; restricted and legacy_unscoped do not', async () => {
    // Seed three real users on the run's org: one with unrestricted report
    // scope, one site-restricted, one with a legacy_unscoped stored scope.
    // Finalize the narrative, run deliverNarrativeEmails, then assert the
    // delivery rows are ['sent','failed','failed'] and the email transport was
    // called exactly once with the unrestricted user's address.
  });
  it('a second finalizer pass sends zero additional emails', async () => {
    // Run deliverNarrativeEmails twice for the same report_run_id; assert the
    // transport call count stays at 1 and the row stays 'sent' (the unique
    // index plus the pending-only claim, not an in-memory guard).
  });
  it('a simulated crash after the claim is RECOVERED, not lost', async () => {
    // claimDelivery the row, then make the transport throw synchronously and
    // skip settleDelivery (simulating process death). Run the reconciler with
    // clock advanced past STALE_CLAIM_MS and assert the row is `unknown` with a
    // 'stale' last_error — visible, never silently `sent`.
  });
  it('a pending row the finalizer never reached is delivered by the reconciler', async () => {
    // Insert a delivery row directly with state 'pending' and created_at two
    // hours ago (the persist committed, the notify path never ran). Run the
    // reconciler; assert state 'sent' and one transport call.
  });
  it('org erasure succeeds with delivery rows present, and cascades them', async () => {
    // proves the ON DELETE CASCADE that lets this table skip
    // ASSOCIATED_SYSTEM_SCOPED_TABLES and the merge registry: seed a narrative
    // with deliveries, run the org cascade, assert it raises no 23503 and
    // report_run_deliveries is empty for that run.
  });
  it('a cross-tenant delivery insert is refused by RLS as breeze_app', async () => {
    // Under an org-A access context as breeze_app, INSERT a delivery row whose
    // report_run_id belongs to an org-B report. Assert the error code is 42501
    // ('new row violates row-level security policy').
  });
});
```

- [ ] **Step 2: Run the full live-DB contract set**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/narrativeEmailDelivery.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/aiAgentNarrativeReport.integration.test.ts
```
Expected: all PASS. The two most likely reds: `rls-coverage` (the strict parent-alias assertion, if the policy names `report_runs` instead of `reports` in its `EXISTS … FROM`) and `tenantExportErasureRoundtrip` (if the FK is not `ON DELETE CASCADE`).

- [ ] **Step 3: Full sweep and PR**

```bash
cd apps/api && npx vitest run
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
cd apps/web && npx vitest run && npx astro check
cd packages/shared && npx vitest run && npx tsc --noEmit
pnpm lint
pnpm test-stack down
```

PR against `main`, body `Closes #<wave sub-issue>` and `Refs #4248`. Call out in the body: (a) the extraction is behaviour-preserving and pinned by a snapshot taken **before** the move; (b) `report_run_deliveries` takes exactly one registration and why the other six do not apply; (c) `unknown` deliveries are never auto-replayed. Merge with `gh pr merge <N>` — never `--admin`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/narrativeEmailDelivery.integration.test.ts
git commit -m "test(reports): live-Postgres proof of the narrative delivery gate, idempotency and crash recovery"
```
