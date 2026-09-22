---
tracking_issue: LanternOps/breeze#3198
spec: docs/superpowers/specs/reports/2026-08-16-psa-business-reports-spec.md
wave: W01 — Partner-scope reports foundation (one PR)
blast_radius: high (tenancy/RLS migration on `reports`, execution-authority model, schedule worker)
---

# Business Reports W01: Partner-Scope Reports Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Read [`2026-09-21-business-reports-INDEX.md`](2026-09-21-business-reports-INDEX.md) (same directory) first — it holds the global constraints and the canonical cross-wave contract spellings.**

**Goal:** Let a partner own a report (`reports.partner_id` set, `org_id` NULL) end to end — schema, RLS, execution authority, routes, schedule worker — so that W02's business generators can run at partner scope. No business report ships in this wave; the three new enum labels exist but have no generator, and generating a partner-owned report answers `unsupported_report_scope` until W02 lands.

**Architecture:** `reports` becomes an org-XOR-partner table (spec §3.1, copying the `configuration_policies` migration), but unlike a config table it gets **no** partner-wide SELECT branch for org tokens: partner-owned reports are partner-private aggregates, so org-scope sessions must never see them (spec §2, §3.1a). The execution-authority model in `services/siteScope.ts` gains a fourth **scope kind**, `partner_wide` (spec §3.1a): org-less, partner-keyed, user-principal only, live-reauthorized against `partner_users.org_access = 'all'`. Routes take `ownerScope` on create only; the worker branches on the owner axis before decoding scope.

**Tech Stack:** Hono + Drizzle + postgres.js, hand-written idempotent SQL, Vitest unit + RLS-coverage + integration suites against a real `breeze_app` Postgres, the tenancy contract in `CLAUDE.md`.

**Spec:** `docs/superpowers/specs/reports/2026-08-16-psa-business-reports-spec.md` — §0 (drift table), §2 (permissions), §3.1 (foundation), §3.1a (partner authority), §4 (tenancy table), §10 (tests). The 2026-07-01 partner-reports design (`docs/superpowers/plans/open/2026-07-01-partner-level-reports-design.md`) is the reference for §2.1–2.5 and §5 of that doc; where the two disagree, the spec wins.

**Depends on:** nothing unmerged. Produces the contracts W02 consumes (see "Interfaces" in Tasks 3 and 5).

---

## Global Constraints

- **Migration names.** `apps/api/migrations/2026-10-26-100000-report-type-business.sql` (enum only) and `apps/api/migrations/2026-10-26-100100-reports-partner-ownership.sql` (everything else). Before committing, run `ls apps/api/migrations | sort | tail -1` and confirm both names sort after it; if a newer file has landed, bump the date of BOTH files (keep the `-100000`/`-100100` pair). Never touch the closed `2026-08-06` block. The pre-commit hook `scripts/check-migration-naming.sh` enforces this.
- **Idempotent, no inner transaction, no writes.** `IF NOT EXISTS` / `DO $$` guards everywhere; no `BEGIN`/`COMMIT`; neither migration UPDATEs, INSERTs or DELETEs rows, so no `set_config('breeze.scope','system',true)` is required and `migrationRlsScope.test.ts` stays untouched (never add to its baseline).
- **Org tokens never see partner-owned reports.** Enforced twice: no `partner_id` predicate is ever added for `auth.scope === 'organization'`, and the RLS policy's partner branch is `breeze_has_partner_access(partner_id)`, which is false for an org token. `reports` is therefore added to `DUAL_AXIS_TENANT_TABLES` but **excluded** from `XOR_OWNERSHIP_DUAL_AXIS_TABLES` with a rationale comment (Task 4). Do not add a `*_partner_wide_select` policy.
- **`partner_id` is always `auth.partnerId`.** The client sends `ownerScope: 'partner'` and nothing else; a client-supplied partner id is never read.
- **Every operation on a partner-owned report requires `canManagePartnerWidePolicies(auth)`** (`services/partnerWideAccess.ts:25` — system scope, or partner scope with `partnerOrgAccess === 'all'`). Read, list, generate, run download, update, delete — not only create (spec §3.1).
- **`partner_wide` is a user-principal scope.** `system` and `portal_user` principals never carry it; the encoder, the decoder and the CHECK constraints all reject the combination.
- **Public generator signature unchanged this wave:** `generateReport(type, orgId, config, authority)`. A partner-owned definition reaching `generateReport` throws `UnsupportedReportScopeError` (new, Task 5) which the routes map to 400 `unsupported_report_scope` and the worker records as a failed run with that reason.
- **Test commands.** Unit: `cd apps/api && npx vitest run <path>` (never `pnpm … test -- --run`). Real-DB suites need `pnpm test-stack up` from this worktree (and `pnpm test-stack down` when done). RLS coverage: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`. Integration: `pnpm --filter=@breeze/api test:integration --run <path>` (check `apps/api/package.json` for the exact script name before first use).
- **Commit after every task.** Small commits; every commit message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

| File | Change | Owner task |
|---|---|---|
| `apps/api/migrations/2026-10-26-100000-report-type-business.sql` | create — 3 enum labels | 1 |
| `apps/api/migrations/2026-10-26-100100-reports-partner-ownership.sql` | create — column, CHECKs, indexes, RLS, FK | 1 |
| `apps/api/src/db/schema/reports.ts` | `orgId` nullable, `partnerId`, enum +3, index predicates | 2 |
| `apps/api/src/services/siteScope.ts` | `partner_wide` scope kind, `ReportOwner`, partner live/request authority, predicate branch | 3 |
| `apps/api/src/services/siteScope.test.ts` | new describe blocks | 3 |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | `DUAL_AXIS_TENANT_TABLES` + XOR exclusion comment | 4 |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | `reports.partner_id` → `included` | 4 |
| `apps/api/src/services/orgMergeRegistry.ts` | note on the `reports` custom entry | 4 |
| `apps/api/src/__tests__/integration/reportsPartnerRls.integration.test.ts` | create | 4 |
| `apps/api/src/routes/reports/schemas.ts` | `ownerScope`, `PARTNER_SCOPE_REPORT_TYPES` | 5 |
| `apps/api/src/routes/reports/helpers.ts` | owner-aware get/run helpers, `PARTNER_OWNED_REPORT` refusal | 5 |
| `apps/api/src/routes/reports/core.ts` | create/list/get/put/delete partner branches | 5 |
| `apps/api/src/routes/reports/generate.ts` | `ownerScope` on ad-hoc generate → 400 this wave | 5 |
| `apps/api/src/routes/reports/runs.ts` | owner-aware run list / download | 5 |
| `apps/api/src/routes/reports/recipients.ts` | refuse partner-owned definitions | 5 |
| `apps/api/src/services/reportGenerationService.ts` | `UnsupportedReportScopeError` | 5 |
| `apps/api/src/services/reportBranding.ts` | `loadReportBrandingForPartner` | 6 |
| `apps/api/src/jobs/reportScheduleWorker.ts` | `findDueReports` + `processRunScheduledReport` owner branches | 6 |
| `apps/api/src/jobs/reportScheduleWorker.due.test.ts`, `reportScheduleWorker.test.ts` | new cases | 6 |

---

### Task 1: The two migrations

**Files:**
- Create: `apps/api/migrations/2026-10-26-100000-report-type-business.sql`
- Create: `apps/api/migrations/2026-10-26-100100-reports-partner-ownership.sql`
- Test: `apps/api/src/db/autoMigrate.test.ts` (existing ordering/idempotency assertions), `apps/api/src/db/migrationRlsScope.test.ts` (existing; must not need a baseline change)

**Interfaces:**
- Produces: enum labels `ticket_sla_attainment`, `technician_time_billability`, `ar_aging`; column `reports.partner_id uuid NULL REFERENCES partners(id)`; constraint `reports_one_owner_chk`; the `partner_wide` branch (owner-bound on `reports`) in `reports_execution_scope_shape_chk` and `report_runs_execution_scope_shape_chk`; dual-axis policy `reports_owner_isolation`; partner OR in the `report_runs` and `report_run_deliveries` FK-join policies; `report_runs.report_id` FK `ON DELETE CASCADE`.

- [ ] **Step 1: Write the enum migration (one statement per label, nothing else)**

`autoMigrate` wraps each file in one transaction, and a label added by `ALTER TYPE … ADD VALUE` cannot be referenced inside the same transaction — so this file contains only the three `ADD VALUE` statements (precedent: `apps/api/migrations/2026-06-29-a-report-type-security-compliance.sql`, one line).

```sql
-- #3198 W01: business report types. Labels only — the generators arrive in W02;
-- until then a report of these types can be created but not generated
-- (unsupported_report_scope). Enum labels live in their own file because a
-- label added by ALTER TYPE cannot be referenced in the transaction that adds
-- it (autoMigrate runs each file in one transaction).
ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'ticket_sla_attainment';
ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'technician_time_billability';
ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'ar_aging';
```

- [ ] **Step 2: Write the ownership migration**

Copy the structure of `apps/api/migrations/2026-06-27-config-policies-partner-ownership.sql` (Steps 1–3 there). The two execution-scope CHECKs are taken verbatim from `apps/api/migrations/2026-10-08-100100-portal-report-self-service.sql:131-176` (reports) and `:182-…` (report_runs) with ONE new branch each; copy the existing text exactly and add the branch — do not re-derive the existing arms.

```sql
-- #3198 W01: partner-owned reports (spec §3.1 / §3.1a).
--
-- A report is owned by EITHER an org (org_id set, partner_id NULL — every row
-- today) OR a partner (partner_id set, org_id NULL — a cross-org aggregate).
-- Exactly one axis per row (reports_one_owner_chk).
--
-- Unlike the config-table precedent (2026-06-27-config-policies-partner-
-- ownership.sql) there is deliberately NO partner-wide SELECT branch for org
-- tokens: a partner-owned report aggregates money and utilisation across the
-- partner's clients and must never be legible to an org-scope session. The
-- policy's partner branch is breeze_has_partner_access(partner_id), which is
-- false for org tokens, and the app layer never adds a partner_id predicate
-- for scope='organization'.
--
-- Idempotent; no inner BEGIN/COMMIT; no row writes (no scope elevation needed).

-- ============================================
-- Step 1: schema — partner_id, nullable org_id, exactly-one-owner
-- ============================================

ALTER TABLE reports ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);
ALTER TABLE reports ALTER COLUMN org_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reports_one_owner_chk' AND conrelid = 'reports'::regclass
  ) THEN
    ALTER TABLE reports ADD CONSTRAINT reports_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS reports_partner_id_idx ON reports(partner_id);

-- The two org-keyed partial unique indexes (reports_portal_self_service_org_type_uniq,
-- reports_ai_fleet_design_org_uniq) are deliberately NOT touched: a B-tree
-- unique index treats NULL keys as distinct (no NULLS NOT DISTINCT here), so
-- partner-owned rows never collide in them. NEVER make reports_id_org_id_uniq
-- partial either — it is the FK target of report_schedule_recipients and
-- service_deliverables; a WHERE org_id IS NOT NULL predicate would invalidate
-- both foreign keys.

-- ============================================
-- Step 2: execution-scope CHECKs — admit kind = 'partner_wide'
-- ============================================
-- partner_wide: no sites, a user principal (never system/portal_user), and a
-- row that is partner-owned. The org-kind arms are copied verbatim from
-- 2026-10-08-100100-portal-report-self-service.sql; only the last OR arm is new.

ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_execution_scope_shape_chk;
ALTER TABLE reports ADD CONSTRAINT reports_execution_scope_shape_chk CHECK ((
    (
      execution_scope_version IS NULL
      AND execution_scope_kind IS NULL
      AND execution_scope_site_ids IS NULL
      AND execution_scope_user_id IS NULL
      AND execution_scope_fingerprint IS NULL
      AND execution_scope_captured_at IS NULL
      AND execution_scope_principal_kind IS NULL
    )
    OR (
      execution_scope_version = 1
      AND execution_scope_fingerprint IS NOT NULL
      AND execution_scope_captured_at IS NOT NULL
      AND (
        (
          execution_scope_kind = 'restricted'
          AND execution_scope_site_ids IS NOT NULL
          AND execution_scope_user_id IS NOT NULL
          AND execution_scope_principal_kind IS DISTINCT FROM 'system'
          AND execution_scope_principal_kind IS DISTINCT FROM 'portal_user'
          AND org_id IS NOT NULL
        )
        OR (
          execution_scope_kind = 'unrestricted'
          AND execution_scope_site_ids IS NULL
          AND org_id IS NOT NULL
          AND (
            (
              execution_scope_principal_kind IN ('system', 'portal_user')
              AND execution_scope_user_id IS NULL
            )
            OR (
              execution_scope_principal_kind IS DISTINCT FROM 'system'
              AND execution_scope_principal_kind IS DISTINCT FROM 'portal_user'
              AND execution_scope_user_id IS NOT NULL
            )
          )
        )
        OR (
          execution_scope_kind = 'legacy_unscoped'
          AND execution_scope_site_ids IS NULL
          AND org_id IS NOT NULL
          AND execution_scope_principal_kind IS DISTINCT FROM 'system'
          AND execution_scope_principal_kind IS DISTINCT FROM 'portal_user'
        )
        OR (
          -- #3198 W01: partner-wide execution scope (spec §3.1a).
          execution_scope_kind = 'partner_wide'
          AND execution_scope_site_ids IS NULL
          AND execution_scope_user_id IS NOT NULL
          AND execution_scope_principal_kind = 'user'
          AND partner_id IS NOT NULL
          AND org_id IS NULL
        )
      )
    )
  ) IS TRUE);
```

For `report_runs` the row has no `org_id`/`partner_id`, so the owner binding is NOT expressible there (the app and the owner check in `decodeSiteScope` enforce it); the new arm is the same minus the two ownership predicates:

```sql
ALTER TABLE report_runs DROP CONSTRAINT IF EXISTS report_runs_execution_scope_shape_chk;
ALTER TABLE report_runs ADD CONSTRAINT report_runs_execution_scope_shape_chk CHECK ((
    -- (copy the existing NULL arm and the three org-kind arms verbatim from
    --  2026-10-08-100100-portal-report-self-service.sql lines 182 onward)
    …
        OR (
          execution_scope_kind = 'partner_wide'
          AND execution_scope_site_ids IS NULL
          AND execution_scope_user_id IS NOT NULL
          AND execution_scope_principal_kind = 'user'
        )
      )
    )
  ) IS TRUE);
```

(The `…` above is an instruction to paste the shipped text, not a placeholder to invent — open the 2026-10-08 file and copy lines 182 to the closing `IS TRUE);`, inserting the arm as the last `OR`.)

```sql
-- ============================================
-- Step 3: RLS — reports moves from Shape 1 (org-only) to Shape 4 (dual-axis)
-- ============================================
-- The baseline (0001-baseline.sql) created four per-command org-isolation
-- policies. Replace them with ONE dual-axis FOR ALL policy. NO partner-wide
-- SELECT branch (see file header).

ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON reports;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON reports;
DROP POLICY IF EXISTS breeze_org_isolation_update ON reports;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON reports;
DROP POLICY IF EXISTS reports_owner_isolation ON reports;
CREATE POLICY reports_owner_isolation ON reports
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

-- ============================================
-- Step 4: FK-child policies — reach a partner-owned parent
-- ============================================
-- report_runs (2026-06-13-b-fk-child-rls-backstop.sql:175-195) and
-- report_run_deliveries (2026-10-16-183300-report-run-deliveries.sql:92-119)
-- gate on breeze_has_org_access(r.org_id) only; for a partner-owned parent
-- that is false, so runs and deliveries of partner-owned reports would be
-- invisible and un-insertable. OR in the partner branch. Both helpers are
-- false on NULL, so org-owned rows are unchanged.

DROP POLICY IF EXISTS breeze_org_isolation_select ON report_runs;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON report_runs;
DROP POLICY IF EXISTS breeze_org_isolation_update ON report_runs;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON report_runs;
CREATE POLICY breeze_org_isolation_select ON report_runs FOR SELECT USING (
  EXISTS (SELECT 1 FROM reports r WHERE r.id = report_runs.report_id
          AND (public.breeze_has_org_access(r.org_id) OR public.breeze_has_partner_access(r.partner_id)))
);
CREATE POLICY breeze_org_isolation_insert ON report_runs FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM reports r WHERE r.id = report_runs.report_id
          AND (public.breeze_has_org_access(r.org_id) OR public.breeze_has_partner_access(r.partner_id)))
);
CREATE POLICY breeze_org_isolation_update ON report_runs FOR UPDATE USING (
  EXISTS (SELECT 1 FROM reports r WHERE r.id = report_runs.report_id
          AND (public.breeze_has_org_access(r.org_id) OR public.breeze_has_partner_access(r.partner_id)))
) WITH CHECK (
  EXISTS (SELECT 1 FROM reports r WHERE r.id = report_runs.report_id
          AND (public.breeze_has_org_access(r.org_id) OR public.breeze_has_partner_access(r.partner_id)))
);
CREATE POLICY breeze_org_isolation_delete ON report_runs FOR DELETE USING (
  EXISTS (SELECT 1 FROM reports r WHERE r.id = report_runs.report_id
          AND (public.breeze_has_org_access(r.org_id) OR public.breeze_has_partner_access(r.partner_id)))
);
```

Before writing the `report_runs` block, open `2026-06-13-b-fk-child-rls-backstop.sql:175-195` and confirm the four policy NAMES and whether any later migration re-created them (`grep -rn 'ON report_runs' apps/api/migrations | sort`). Drop and recreate whatever the latest names are; a policy left behind with the old org-only predicate would AND with the new one and silently re-hide partner-owned runs.

Then the same four for `report_run_deliveries`, keeping its nested `(SELECT rr.report_id FROM report_runs rr WHERE rr.id = report_run_deliveries.report_run_id)` shape from `2026-10-16-183300-report-run-deliveries.sql:92-119` and adding `OR public.breeze_has_partner_access(r.partner_id)` inside each `EXISTS`.

```sql
-- ============================================
-- Step 5: report_runs.report_id → ON DELETE CASCADE
-- ============================================
-- Declared NO ACTION in 0001-baseline.sql:13909. Routes pre-clear runs before
-- deleting a definition, but a future partner-deletion sweep would abort on a
-- partner-owned report with runs. report_run_deliveries already cascades from
-- report_runs.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conname = 'report_runs_report_id_reports_id_fk'
      AND c.conrelid = 'report_runs'::regclass
      AND c.confdeltype <> 'c'
  ) THEN
    ALTER TABLE report_runs DROP CONSTRAINT report_runs_report_id_reports_id_fk;
    ALTER TABLE report_runs ADD CONSTRAINT report_runs_report_id_reports_id_fk
      FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE;
  END IF;
END $$;
```

- [ ] **Step 3: Apply on a fresh test stack twice and prove idempotency**

Run:
```bash
pnpm test-stack up
export DATABASE_URL="$(grep '^DATABASE_URL=' .env.test | cut -d= -f2-)"   # or whatever test-stack printed
pnpm db:migrate && pnpm db:migrate
```
Expected: second run prints both files as already applied / no-op; no `NOTICE: there is already a transaction in progress`; no error.

- [ ] **Step 4: Verify as `breeze_app`**

```bash
docker exec -it "$(docker ps --format '{{.Names}}' | grep postgres | grep "$(basename $PWD)" | head -1)" \
  psql -U breeze_app -d breeze -c "
SELECT set_config('breeze.scope','partner',false), set_config('breeze.accessible_partner_ids','00000000-0000-0000-0000-000000000001',false);
INSERT INTO reports (partner_id, name, type) VALUES ('00000000-0000-0000-0000-000000000002','forge','ar_aging');"
```
Expected: `ERROR:  new row violates row-level security policy for table "reports"`. (Check `apps/api/src/db/index.ts` `withDbAccessContext` for the exact GUC names — `breeze.accessible_partner_ids` may be spelled differently; use what `breeze_has_partner_access` reads.)

- [ ] **Step 5: Run the migration unit tests**

Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`
Expected: PASS (no new offender in the RLS-scope baseline; ordering assertions pass).

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-10-26-100000-report-type-business.sql apps/api/migrations/2026-10-26-100100-reports-partner-ownership.sql
git commit -m "feat(reports): partner-owned reports — enum labels, ownership migration, dual-axis RLS (#3198 W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Drizzle schema

**Files:**
- Modify: `apps/api/src/db/schema/reports.ts:22-54` (enum), `:70-122` (table)
- Test: `pnpm db:check-drift`; `apps/api/src/services/reportGenerationService.test.ts` (pins the TS union to the enum — will go red until Task 5 adds the three labels to the union)

- [ ] **Step 1: Edit the enum and table**

```ts
export const reportTypeEnum = pgEnum('report_type', [
  // … existing 13 values unchanged …
  // #3198 W01: business report types (generators land in W02).
  'ticket_sla_attainment',
  'technician_time_billability',
  'ar_aging',
]);

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  // #3198 W01: org XOR partner ownership (reports_one_owner_chk). A partner-
  // owned definition (partner_id set, org_id NULL) is a cross-org aggregate
  // legible only to partner-scope callers with org_access = 'all'.
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  // … rest unchanged …
}, (table) => ({
  reportsIdOrgIdUniq: uniqueIndex('reports_id_org_id_uniq').on(table.id, table.orgId),
  reportsPartnerIdIdx: index('reports_partner_id_idx').on(table.partnerId),
  // reportsPortalSelfServiceOrgTypeUniq / aiFleetDesignOrgUniq: UNCHANGED (NULL keys are distinct).
  // … existing two partial unique indexes exactly as today …
}));
```

Add `partners` to the schema import at the top of the file (check for an import cycle: `partners.ts` must not import `reports.ts`; `grep -n "from './reports'" apps/api/src/db/schema/partners.ts` must be empty).

- [ ] **Step 2: Drift check**

Run: `pnpm db:check-drift` (against the migrated test stack from Task 1).
Expected: no drift (the only new objects are `partner_id`, `reports_partner_id_idx`, the CHECK and the policies).

- [ ] **Step 3: Typecheck the API and note the expected reds**

Run: `pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json`
Expected: errors ONLY at sites that assume `report.orgId: string` (helpers.ts, core.ts, runs.ts, generate.ts, reportScheduleWorker.ts, recipients.ts, deliverableAutoEvidence.ts, portal reportsSelfService.ts). Record the list — Tasks 5 and 6 must clear every one. Any file outside that list is a surprise: read it before touching it.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema/reports.ts
git commit -m "feat(reports): schema — nullable org_id, partner_id, business report enum labels (#3198 W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `partner_wide` scope kind in `siteScope.ts`

**Files:**
- Modify: `apps/api/src/services/siteScope.ts` (`SiteScopeV1` :31, `normalizeScope` :163, `siteScopeFingerprint` :210, `intersectSiteScopes` :244, `isSiteScopeSubset` :296, `decodeSiteScope` :408, `persistedSiteScopeValues` :482, `LiveReportAuthorityResult` :120, `reportDefinitionMultiOrgScopeSqlPredicate` :747, `reportRunMultiOrgScopeSqlPredicate` :794, new functions after `resolveRequestReportAuthority` :1104)
- Test: `apps/api/src/services/siteScope.test.ts` (new `describe('partner-wide execution scope')`), `apps/api/src/services/siteScope.projections.test.ts` (EXTENDED — see Step 6a)

**Interfaces:**
- Produces (consumed by Tasks 5, 6 and by W02):
  ```ts
  export type SiteScopeV1 = … | { version: 1; kind: 'partner_wide'; partnerId: string };
  export type ReportOwner = { orgId: string; partnerId?: undefined } | { partnerId: string; orgId?: undefined };
  export function reportOwnerOf(row: { orgId: string | null; partnerId: string | null }): ReportOwner;
  export function decodeSiteScope(row: PersistedSiteScopeColumns, owner: string | ReportOwner): SiteScopeV1; // string = orgId (existing callers)
  export function partnerWideScope(partnerId: string): Extract<SiteScopeV1, { kind: 'partner_wide' }>;
  export async function resolveLivePartnerReportAuthority(userId: string, partnerId: string, action: ReportAction): Promise<LiveReportAuthorityResult>;
  export async function resolveRequestPartnerReportAuthority(auth: AuthContext, partnerId: string, action: ReportAction): Promise<LiveReportAuthorityResult>;
  // LiveReportAuthorityResult.reason gains 'partner_inaccessible' | 'partner_access_not_all'
  export function reportDefinitionMultiOrgScopeSqlPredicate(rowOrgId, columns, authorizedScopes, partnerWide?: { rowPartnerId: typeof reports.partnerId; partnerId: string }): SQL;
  export function reportRunMultiOrgScopeSqlPredicate(rowOrgId, columns, authorizedScopes, partnerWide?: { rowPartnerId: typeof reports.partnerId; partnerId: string }): SQL;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/siteScope.test.ts`:

```ts
describe('partner-wide execution scope (#3198 W01)', () => {
  const partnerId = '11111111-1111-4111-8111-111111111111';
  const orgId = '22222222-2222-4222-8222-222222222222';
  const userId = '33333333-3333-4333-8333-333333333333';

  it('fingerprints partner_wide over {version, kind, partnerId} only', () => {
    const a = siteScopeFingerprint({ version: 1, kind: 'partner_wide', partnerId });
    const b = siteScopeFingerprint(partnerWideScope(partnerId));
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toBe(siteScopeFingerprint({ version: 1, kind: 'unrestricted', orgId: partnerId }));
  });

  it('intersects partner_wide only with itself, same partner', () => {
    const pw = partnerWideScope(partnerId);
    expect(intersectSiteScopes(pw, pw)).toEqual(pw);
    expect(intersectSiteScopes(pw, partnerWideScope(orgId))).toBeNull();
    expect(intersectSiteScopes(pw, { version: 1, kind: 'unrestricted', orgId })).toBeNull();
    expect(intersectSiteScopes({ version: 1, kind: 'unrestricted', orgId }, pw)).toBeNull();
    expect(isSiteScopeSubset(pw, pw)).toBe(true);
    expect(isSiteScopeSubset(pw, { version: 1, kind: 'unrestricted', orgId })).toBe(false);
  });

  it('round-trips a partner_wide user authority through the persisted columns', () => {
    const scope = partnerWideScope(partnerId);
    const authority = {
      principalKind: 'user' as const,
      scope,
      principalUserId: userId,
      capturedAt: new Date('2026-09-21T00:00:00Z'),
      fingerprint: siteScopeFingerprint(scope),
    };
    const row = persistedSiteScopeValues(authority);
    expect(row).toMatchObject({
      executionScopeVersion: 1,
      executionScopeKind: 'partner_wide',
      executionScopeSiteIds: null,
      executionScopeUserId: userId,
      executionScopePrincipalKind: 'user',
    });
    expect(decodeSiteScope(row, { partnerId })).toEqual(scope);
  });

  it('refuses a partner_wide row decoded under an org owner, and vice versa', () => {
    const scope = partnerWideScope(partnerId);
    const row = persistedSiteScopeValues({
      principalKind: 'user', scope, principalUserId: userId,
      capturedAt: new Date(), fingerprint: siteScopeFingerprint(scope),
    });
    expect(() => decodeSiteScope(row, { orgId })).toThrow(/owner/);
    expect(() => decodeSiteScope(row, orgId)).toThrow(/owner/);
    const orgRow = persistedSiteScopeValues({
      principalKind: 'user', scope: { version: 1, kind: 'unrestricted', orgId }, principalUserId: userId,
      capturedAt: new Date(), fingerprint: siteScopeFingerprint({ version: 1, kind: 'unrestricted', orgId }),
    });
    expect(() => decodeSiteScope(orgRow, { partnerId })).toThrow(/owner/);
  });

  it('never lets a portal or system principal carry partner_wide', () => {
    expect(() => portalUserReportAuthority(partnerId)).not.toThrow(); // org-keyed helper still fine
    expect(() =>
      persistedSiteScopeValues({
        principalKind: 'portal_user',
        scope: partnerWideScope(partnerId) as never,
        capturedAt: new Date(),
        fingerprint: siteScopeFingerprint(partnerWideScope(partnerId)),
      }),
    ).toThrow(/portal-user execution scope kind/);
  });

  it('reportOwnerOf demands exactly one axis', () => {
    expect(reportOwnerOf({ orgId, partnerId: null })).toEqual({ orgId });
    expect(reportOwnerOf({ orgId: null, partnerId })).toEqual({ partnerId });
    expect(() => reportOwnerOf({ orgId, partnerId })).toThrow(/exactly one/);
    expect(() => reportOwnerOf({ orgId: null, partnerId: null })).toThrow(/exactly one/);
  });

  it('multi-org predicates append the partner-wide branch only when asked', () => {
    const without = reportDefinitionMultiOrgScopeSqlPredicate(reports.orgId, reports, []);
    const withBranch = reportDefinitionMultiOrgScopeSqlPredicate(reports.orgId, reports, [], {
      rowPartnerId: reports.partnerId, partnerId,
    });
    const renderedWithout = renderSql(without);   // use the file's existing SQL-rendering helper (see the 'report definition scope SQL predicates' block)
    const renderedWith = renderSql(withBranch);
    expect(renderedWithout).not.toContain('partner_id');
    expect(renderedWith).toContain('partner_id');
    expect(renderedWith).toContain('partner_wide');
    expect(renderedWith.params).toContain(partnerId);
  });
});
```

Import `partnerWideScope`, `reportOwnerOf`, `reports` (from `../db/schema`) at the top. For `renderSql`, reuse whatever helper the existing `describe('report definition scope SQL predicates')` block at `:801` uses to walk bound params (it exists there — copy its name; never substring-match column names without also asserting the params).

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/siteScope.test.ts -t 'partner-wide'`
Expected: FAIL — `partnerWideScope is not a function` / type errors on `kind: 'partner_wide'`.

- [ ] **Step 3: Implement the scope kind**

In `siteScope.ts`:

```ts
export type SiteScopeV1 =
  | { version: 1; kind: 'unrestricted'; orgId: string }
  | { version: 1; kind: 'restricted'; orgId: string; siteIds: string[] }
  | { version: 1; kind: 'legacy_unscoped'; orgId: string }
  // #3198 W01 (spec §3.1a): every organization of `partnerId`, resolved live
  // at execution time. Carries no org list on purpose — persisting one would
  // freeze the report at creation-time membership.
  | { version: 1; kind: 'partner_wide'; partnerId: string };

export type LiveSiteScopeV1 = Exclude<SiteScopeV1, { kind: 'legacy_unscoped' }>;

export type ReportOwner =
  | { orgId: string; partnerId?: undefined }
  | { partnerId: string; orgId?: undefined };

export function reportOwnerOf(row: { orgId: string | null; partnerId: string | null }): ReportOwner {
  const hasOrg = typeof row.orgId === 'string' && row.orgId.length > 0;
  const hasPartner = typeof row.partnerId === 'string' && row.partnerId.length > 0;
  if (hasOrg === hasPartner) {
    throw new Error('report row must have exactly one owner axis');
  }
  return hasOrg ? { orgId: row.orgId as string } : { partnerId: row.partnerId as string };
}

export function partnerWideScope(partnerId: string): Extract<SiteScopeV1, { kind: 'partner_wide' }> {
  assertNonEmptyString(partnerId, 'partner ID');
  return { version: 1, kind: 'partner_wide', partnerId };
}
```

`normalizeScope` (`:163`): move the `assertNonEmptyString(scope.orgId, …)` INTO the three org arms and add:
```ts
    case 'partner_wide':
      assertNonEmptyString(scope.partnerId, 'partner ID');
      return { version: 1, kind: 'partner_wide', partnerId: scope.partnerId };
```

`siteScopeFingerprint` (`:210`): add
```ts
    case 'partner_wide':
      stableValue = { version: normalized.version, kind: normalized.kind, partnerId: normalized.partnerId };
      break;
```

`intersectSiteScopes` (`:244`): the first guard compares `orgId`; replace it with an owner comparison:
```ts
  if (normalizedPersisted.kind === 'partner_wide' || normalizedCurrent.kind === 'partner_wide') {
    return normalizedPersisted.kind === 'partner_wide'
      && normalizedCurrent.kind === 'partner_wide'
      && normalizedPersisted.partnerId === normalizedCurrent.partnerId
      ? normalizedPersisted
      : null;
  }
  if (normalizedPersisted.orgId !== normalizedCurrent.orgId) {
    return null;
  }
```
`isSiteScopeSubset` (`:296`): same shape — partner_wide ⊆ partner_wide iff same partner, otherwise false; leave the org arms unchanged. Read the existing function body first; its switch will now need a `case 'partner_wide'` that is unreachable after the guard — add `return assertNever(...)`-safe handling by placing the guard before the switch.

`decodeSiteScope` (`:408`) — change the signature and add the owner check:
```ts
export function decodeSiteScope(
  row: PersistedSiteScopeColumns,
  ownerOrOrgId: string | ReportOwner,
): SiteScopeV1 {
  const owner: ReportOwner = typeof ownerOrOrgId === 'string' ? { orgId: ownerOrOrgId } : ownerOrOrgId;
  if (owner.orgId !== undefined) assertNonEmptyString(owner.orgId, 'organization ID');
  else assertNonEmptyString(owner.partnerId, 'partner ID');

  if (allPersistedValuesAreNull(row)) {
    if (owner.orgId === undefined) {
      throw new Error('partner-owned report has no persisted execution scope');
    }
    return { version: 1, kind: 'legacy_unscoped', orgId: owner.orgId };
  }

  assertCompletePersistedBase(row);
  const principalKind = persistedPrincipalKind(row);
  const hasNoStaffPrincipal = principalKind === 'system' || principalKind === 'portal_user';

  if (row.executionScopeKind === 'partner_wide') {
    if (owner.partnerId === undefined) {
      throw new Error('partner_wide execution scope on an org-owned report (owner mismatch)');
    }
    if (hasNoStaffPrincipal) throw new Error('invalid persisted non-user site scope kind');
    if (row.executionScopeSiteIds !== null || row.executionScopeUserId === null) {
      throw new Error('partial or invalid persisted partner_wide site scope');
    }
    assertNonEmptyString(row.executionScopeUserId, 'execution scope user ID');
    return validateDecodedScopeFingerprint(row, { version: 1, kind: 'partner_wide', partnerId: owner.partnerId });
  }
  if (owner.orgId === undefined) {
    throw new Error('org-kind execution scope on a partner-owned report (owner mismatch)');
  }
  const orgId = owner.orgId;
  switch (row.executionScopeKind) {
    // … existing three arms, unchanged, using `orgId` …
  }
}
```

`persistedSiteScopeValues` (`:482`): the `'user'` arm already writes `scope.kind` and `siteIds` only for `restricted`, so a `partner_wide` scope persists correctly with no change; the `'portal_user'` arm's `scope.kind !== 'unrestricted'` check already rejects it (the test above asserts the message). `persistedSystemSiteScopeValues` (`:566`) already rejects non-`unrestricted`. Add one explicit guard at the top of the `'user'` arm for readability:
```ts
      if (scope.kind === 'partner_wide') {
        assertNonEmptyString(scope.partnerId, 'partner ID');
      }
```

- [ ] **Step 4: Implement live and request partner authority**

Extend `LiveReportAuthorityResult` (`:120`):
```ts
        | 'partner_inaccessible'
        | 'partner_access_not_all'
```

After `resolveRequestReportAuthority` (`:1104`):

```ts
/**
 * #3198 W01 (spec §3.1a). Live authority for a PARTNER-OWNED report: the user
 * must be active, hold exactly one partner_users membership for `partnerId`
 * with org_access = 'all', and that membership's role must grant the report
 * action. 'selected' / 'none' access is refused — a user who cannot open every
 * org individually must not read an aggregate over all of them. Platform
 * admins pass under `allowPlatformAuthority` exactly as for org authorities.
 */
export async function resolveLivePartnerReportAuthority(
  userId: string,
  partnerId: string,
  action: ReportAction,
): Promise<LiveReportAuthorityResult> {
  return resolveExactPartnerReportAuthority(userId, partnerId, action, true);
}

export async function resolveRequestPartnerReportAuthority(
  auth: AuthContext,
  partnerId: string,
  action: ReportAction,
): Promise<LiveReportAuthorityResult> {
  if (auth.scope === 'system') {
    return resolveExactPartnerReportAuthority(auth.user.id, partnerId, action, true);
  }
  if (auth.scope !== 'partner' || auth.partnerId !== partnerId) {
    return denied('partner_inaccessible');
  }
  if (auth.partnerOrgAccess !== 'all') {
    return denied('partner_access_not_all');
  }
  return resolveExactPartnerReportAuthority(auth.user.id, partnerId, action, false);
}

async function resolveExactPartnerReportAuthority(
  userId: string,
  partnerId: string,
  action: ReportAction,
  allowPlatformAuthority: boolean,
): Promise<LiveReportAuthorityResult> {
  try {
    return await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        resolveExactPartnerReportAuthorityInSystemContext(userId, partnerId, action, allowPlatformAuthority),
      ),
    );
  } catch {
    return denied('unverifiable_scope');
  }
}

async function resolveExactPartnerReportAuthorityInSystemContext(
  userId: string,
  partnerId: string,
  action: ReportAction,
  allowPlatformAuthority: boolean,
): Promise<LiveReportAuthorityResult> {
  const [user] = await db
    .select({ id: users.id, status: users.status, isPlatformAdmin: users.isPlatformAdmin, partnerId: users.partnerId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user || user.status !== 'active') return denied('user_inactive');

  if (allowPlatformAuthority && user.isPlatformAdmin) {
    return liveAuthority(partnerWideScope(partnerId), user.id);
  }
  if (user.partnerId !== partnerId) return denied('partner_inaccessible');

  const memberships = await db
    .select({ roleId: partnerUsers.roleId, orgAccess: partnerUsers.orgAccess })
    .from(partnerUsers)
    .where(and(eq(partnerUsers.userId, user.id), eq(partnerUsers.partnerId, partnerId)))
    .limit(2);
  if (memberships.length > 1) return denied('unverifiable_scope');
  const membership = memberships[0];
  if (!membership) return denied('membership_removed');
  if (membership.orgAccess !== 'all') return denied('partner_access_not_all');
  if (!membership.roleId || !(await roleGrantsReportAction(membership.roleId, action, { scope: 'partner', partnerId }))) {
    return denied('permission_removed');
  }
  return liveAuthority(partnerWideScope(partnerId), user.id);
}
```

`liveAuthority` (`:834`) takes a `SiteScopeV1` — confirm its parameter type is the union, not `LiveSiteScopeV1`-narrowed to org kinds; widen if needed.

- [ ] **Step 5: Multi-org predicate branch**

In `reportDefinitionMultiOrgScopeSqlPredicate` (`:747`) and `reportRunMultiOrgScopeSqlPredicate` (`:794`) add the optional fourth parameter and, after building `branches`:

```ts
  if (partnerWide) {
    assertNonEmptyString(partnerWide.partnerId, 'partner ID');
    branches.push(
      and(
        eq(partnerWide.rowPartnerId, partnerWide.partnerId),
        eq(columns.executionScopeKind, 'partner_wide'),
        isNull(columns.executionScopeSiteIds),
        eq(columns.executionScopePrincipalKind, 'user'),
      )!,
    );
  }
```

The org branches are unchanged, so an org-scope caller (who never passes `partnerWide`) gets exactly today's SQL.

- [ ] **Step 6a: Extend the projection scanner**

`siteScope.projections.test.ts` exists because a projection that omits one execution-scope column decodes as a silent 404 (`:12-27`). A `partner_wide` run decodes only if the projection also carries the owner's `partnerId`. Add one assertion to the existing `describe('execution-scope projection contract')` (`:109`):

```ts
  it('every reports-sourced execution-scope projection that names orgId also names partnerId (#3198 W01)', () => {
    for (const literal of executionScopeLiterals) {           // the scanner's existing collection of matched object literals
      if (!/\borgId:\s*reports\.orgId\b/.test(literal.text)) continue;
      expect(literal.text, `${literal.file}:${literal.line}`).toMatch(/\bpartnerId:\s*reports\.partnerId\b/);
    }
  });
```
Adapt the variable names to the scanner's actual helpers (read the file first; it exposes `{ file, line, text }` per literal or close to it). This reds until Task 5 adds `partnerId` to `reportDefinitionMetadataProjection` and `reportRunMetadataProjection` — that is intended; note it and move on.

- [ ] **Step 6: Run the tests**

Run: `cd apps/api && npx vitest run src/services/siteScope.test.ts src/services/siteScope.projections.test.ts`
Expected: PASS, including every pre-existing case (the org-kind behaviour is byte-for-byte unchanged — if an existing fingerprint snapshot moves, you changed the org arms; revert).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/siteScope.ts apps/api/src/services/siteScope.test.ts
git commit -m "feat(reports): partner_wide execution scope kind and live partner authority (#3198 W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Tenancy contract registrations and the functional RLS suite

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:362` (`DUAL_AXIS_TENANT_TABLES`), `:688-711` (exclusion comment on `XOR_OWNERSHIP_DUAL_AXIS_TABLES`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:513` (`reports` entry)
- Modify: `apps/api/src/services/orgMergeRegistry.ts:575` (note only)
- Modify: `apps/api/src/services/tenantCascade.ts:1031-1034` (comment now false) + partner-purge assertion in `apps/api/src/__tests__/integration/tenantCascade.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/reportsPartnerRls.integration.test.ts`
- Test: `rls-coverage`, `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`, `orgMerge.test.ts` (unit, full-suite only), the new suite

- [ ] **Step 1: Run the RLS coverage contract to see it fail**

Run: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`
Expected: FAIL on `reports` — the org-axis auto-discovery still passes (the policy has the org branch), but the dual-axis assertion for a table with a `partner_id` column and no allowlist entry fails, and/or the export-policy column check fails on the unclassified `partner_id`. Record the exact assertion names.

- [ ] **Step 2: Register**

In `DUAL_AXIS_TENANT_TABLES` (`:362`), alphabetical position:
```ts
  // #3198 W01: reports is org_id XOR partner_id (reports_one_owner_chk,
  // 2026-10-26-100100). The org_id column means auto-discovery already asserts
  // the breeze_has_org_access branch; THIS entry is the only thing that asserts
  // the breeze_has_partner_access branch. Deliberately NOT in
  // XOR_OWNERSHIP_DUAL_AXIS_TABLES — see the exclusion note there.
  'reports',
```

In the `XOR_OWNERSHIP_DUAL_AXIS_TABLES` header comment (`:688-711`), add to the "Excluded" list:
```
// … and `reports` (#3198 W01): org XOR partner by CHECK, but NOT a config
// table — a partner-owned report is a partner-PRIVATE cross-org aggregate
// (money, utilisation), and spec §2 forbids org-scope sessions from reading
// it. The partner-wide SELECT branch this set asserts would grant exactly that
// read, so reports must never carry one. Its partner branch is proven
// functionally by reportsPartnerRls.integration.test.ts instead.
```

In `tenantExportPolicyRegistry.ts:513` add `"partner_id"` to the `included` array of the `reports` entry (tenant identifier — spec §4).

In `tenantCascade.ts:1031-1034` the comment says no partner-axis twin is needed for `report_runs` "because `reports.org_id` is NOT NULL, so every definition is reached through the per-child-org cascade". After this migration that is false. Rewrite it:
```ts
    // #3198 W01: reports is org XOR partner. Org-owned definitions (and their
    // runs, via this pre-clear) are reached by the per-org cascade; PARTNER-
    // owned definitions are reached only by the partner sweep's automatic
    // `partner_id` discovery below, and their runs by the
    // report_runs.report_id ON DELETE CASCADE that 2026-10-26-100100 added.
```
and add to `tenantCascade.integration.test.ts` (next to the existing partner-sweep cases):
```ts
  it('partner purge removes partner-owned report definitions and their runs, and leaves org-owned ones alone (#3198 W01)', async () => {
    // seed: partner P with org O; one org-owned report (+1 run) and one partner-owned report (+1 run) — use partnerWideColumns() from reportsPartnerRls
    // act: run the partner purge for P (find the exported entry point the existing partner-sweep tests call)
    // assert: SELECT count(*) FROM reports WHERE partner_id = P → 0; runs of that report → 0;
    //         the org-owned report survives ONLY if the purge is partner-only — read the sweep to learn whether it also cascades child orgs, and assert accordingly (state which in the test name)
  });
```

In `orgMergeRegistry.ts:575` append to the `reports` note: `"; partner-owned definitions (org_id NULL, #3198) are never touched by an org merge — the pass keys on org_id = loser"`.

- [ ] **Step 3: Write the functional suite**

Model on `configurationPoliciesPartnerRls.integration.test.ts` (same `partnerContext` / `orgContext` helpers — copy them, including the `currentPartnerId` note; the org-scope assertion here MUST pass `currentPartnerId` = the owning partner so it proves an org token of the same partner still sees nothing).

```ts
/**
 * reports RLS — dual-axis (org OR partner) enforcement (#3198 W01).
 * Migration under test: 2026-10-26-100100-reports-partner-ownership.sql.
 * The rls-coverage contract proves the org branch; this suite is the only
 * proof of the partner branch, of the XOR CHECK, of the report_runs /
 * report_run_deliveries FK-join partner OR, and of org-token blindness.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { reports, reportRuns, reportRunDeliveries } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { pgErrorCode } from '../../utils/pgErrors';
import { partnerWideScope, siteScopeFingerprint } from '../../services/siteScope';

// helpers partnerContext / orgContext / created[] / afterEach as in configurationPoliciesPartnerRls

function partnerWideColumns(partnerId: string, userId: string) {
  const scope = partnerWideScope(partnerId);
  return {
    executionScopeVersion: 1,
    executionScopeKind: 'partner_wide',
    executionScopeSiteIds: null,
    executionScopeUserId: userId,
    executionScopeFingerprint: siteScopeFingerprint(scope),
    executionScopeCapturedAt: new Date(),
    executionScopePrincipalKind: 'user' as const,
  };
}

describe('reports partner ownership RLS', () => {
  it('a partner inserts and reads its own partner-owned report; another partner sees nothing', async () => {
    const p1 = await createPartner(); const p2 = await createPartner();
    const u1 = await createUser({ partnerId: p1.id });
    const [row] = await withDbAccessContext(partnerContext(p1.id, []), () =>
      db.insert(reports).values({ partnerId: p1.id, orgId: null, name: 'p1 AR', type: 'ar_aging', createdBy: u1.id, ...partnerWideColumns(p1.id, u1.id) }).returning());
    created.push(row!.id);
    const mine = await withDbAccessContext(partnerContext(p1.id, []), () => db.select().from(reports).where(eq(reports.id, row!.id)));
    expect(mine).toHaveLength(1);
    const theirs = await withDbAccessContext(partnerContext(p2.id, []), () => db.select().from(reports).where(eq(reports.id, row!.id)));
    expect(theirs).toHaveLength(0);
  });

  it('rejects a forged cross-partner insert (42501)', async () => {
    const p1 = await createPartner(); const p2 = await createPartner();
    const u1 = await createUser({ partnerId: p1.id });
    await expect(withDbAccessContext(partnerContext(p1.id, []), () =>
      db.insert(reports).values({ partnerId: p2.id, orgId: null, name: 'forge', type: 'ar_aging', createdBy: u1.id, ...partnerWideColumns(p2.id, u1.id) }).returning(),
    )).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('rejects both-axes and neither-axis rows (23514)', async () => {
    const p1 = await createPartner(); const org = await createOrganization({ partnerId: p1.id });
    const u1 = await createUser({ partnerId: p1.id });
    await expect(withDbAccessContext(partnerContext(p1.id, [org.id]), () =>
      db.insert(reports).values({ partnerId: p1.id, orgId: org.id, name: 'both', type: 'ar_aging', createdBy: u1.id, ...partnerWideColumns(p1.id, u1.id) }).returning(),
    )).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(withDbAccessContext(partnerContext(p1.id, [org.id]), () =>
      db.insert(reports).values({ partnerId: null, orgId: null, name: 'neither', type: 'ar_aging', createdBy: u1.id }).returning(),
    )).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('rejects partner_wide scope on an org-owned row, and system/portal principals on partner_wide (23514)', async () => {
    const p1 = await createPartner(); const org = await createOrganization({ partnerId: p1.id });
    const u1 = await createUser({ partnerId: p1.id });
    await expect(withDbAccessContext(partnerContext(p1.id, [org.id]), () =>
      db.insert(reports).values({ orgId: org.id, partnerId: null, name: 'bad', type: 'ar_aging', createdBy: u1.id, ...partnerWideColumns(p1.id, u1.id) }).returning(),
    )).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(withDbAccessContext(partnerContext(p1.id, []), () =>
      db.insert(reports).values({ partnerId: p1.id, orgId: null, name: 'bad', type: 'ar_aging', createdBy: null,
        ...partnerWideColumns(p1.id, u1.id), executionScopeUserId: null, executionScopePrincipalKind: 'system' }).returning(),
    )).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('an ORG token of the owning partner cannot see a partner-owned report (no partner-wide select branch)', async () => {
    const p1 = await createPartner(); const org = await createOrganization({ partnerId: p1.id });
    const u1 = await createUser({ partnerId: p1.id });
    const [row] = await withDbAccessContext(partnerContext(p1.id, [org.id]), () =>
      db.insert(reports).values({ partnerId: p1.id, orgId: null, name: 'p1', type: 'ar_aging', createdBy: u1.id, ...partnerWideColumns(p1.id, u1.id) }).returning());
    created.push(row!.id);
    const seen = await withDbAccessContext(orgContext(org.id, p1.id), () => db.select().from(reports).where(eq(reports.id, row!.id)));
    expect(seen).toHaveLength(0);
  });

  it('runs and deliveries of a partner-owned report insert and read back under partner context (FK-join partner OR)', async () => {
    const p1 = await createPartner(); const p2 = await createPartner();
    const u1 = await createUser({ partnerId: p1.id });
    const [row] = await withDbAccessContext(partnerContext(p1.id, []), () =>
      db.insert(reports).values({ partnerId: p1.id, orgId: null, name: 'p1', type: 'ar_aging', createdBy: u1.id, ...partnerWideColumns(p1.id, u1.id) }).returning());
    created.push(row!.id);
    const [run] = await withDbAccessContext(partnerContext(p1.id, []), () =>
      db.insert(reportRuns).values({ reportId: row!.id, status: 'completed', requestedByKind: 'user', requestedByUserId: u1.id, ...partnerWideColumns(p1.id, u1.id) }).returning());
    expect(run).toBeDefined();
    // deliveries: read reportRunDeliveries' NOT NULL columns from the schema before writing this insert
    const back = await withDbAccessContext(partnerContext(p1.id, []), () => db.select().from(reportRuns).where(eq(reportRuns.id, run!.id)));
    expect(back).toHaveLength(1);
    const other = await withDbAccessContext(partnerContext(p2.id, []), () => db.select().from(reportRuns).where(eq(reportRuns.id, run!.id)));
    expect(other).toHaveLength(0);
  });

  it('deleting a partner-owned report cascades its runs', async () => {
    // insert report + run as above under partner context, delete the report under system context, expect the run gone
  });
});
```

Fill the two abbreviated tests fully before running (the deliveries insert needs the real NOT NULL column set from `apps/api/src/db/schema/reports.ts:203+`; the cascade test is four statements). Cleanup in `afterEach` must delete runs before reports only if the FK cascade test is skipped — with the cascade in place deleting `reports` suffices.

- [ ] **Step 4: Run every contract suite**

```bash
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm --filter=@breeze/api test:integration --run src/__tests__/integration/reportsPartnerRls.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts
cd apps/api && npx vitest run   # FULL unit suite — orgMerge.test.ts only reds in a full run
```
Expected: all PASS. If `orgMerge.test.ts` complains, the `reports` custom merge handler reads `org_id` as non-null somewhere — fix it to skip `org_id IS NULL` rows explicitly.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/__tests__/integration/reportsPartnerRls.integration.test.ts apps/api/src/__tests__/integration/tenantCascade.integration.test.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/tenantCascade.ts
git commit -m "test(reports): register reports as dual-axis, export policy for partner_id, functional partner RLS suite (#3198 W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Routes — `ownerScope`, owner-aware access, partner gates

**Files:**
- Modify: `apps/api/src/routes/reports/schemas.ts` (`createReportSchema` :280, `generateReportSchema` :296, new `PARTNER_SCOPE_REPORT_TYPES`)
- Modify: `apps/api/src/routes/reports/helpers.ts` (`ensureOrgAccess` :64, `getReportWithOrgCheck` :78, `tenantAuthorizedReportCondition` :185, `getReportRunWithOrgCheck` :207, projections)
- Modify: `apps/api/src/routes/reports/core.ts` (`resolveDefinitionListScope` :76, create :392, update :468, delete :627, `loadLockedDefinition`)
- Modify: `apps/api/src/routes/reports/generate.ts:23-102`
- Modify: `apps/api/src/routes/reports/runs.ts` (list :225-269, download :329, detail :441, write :531)
- Modify: `apps/api/src/routes/reports/recipients.ts:34-45` (refusal), both writers
- Modify: `apps/api/src/services/reportGenerationService.ts` (new `UnsupportedReportScopeError`; `assertReportExecutionPreflight` / `assertExecutableAuthority` :213-260 take a `ReportOwner`)
- Create: `apps/api/src/routes/reports/partnerOwnedVisibility.scan.test.ts` (source scan)
- Test: `apps/api/src/routes/reports/core.partnerOwned.test.ts` (create), `apps/api/src/routes/reports/helpers.partnerOwned.test.ts` (create), existing `apps/api/src/routes/reports/*.test.ts`, `apps/api/src/services/reportGenerationService.test.ts` (union pin — add the 3 labels)

**Interfaces:**
- Produces: `partnerOwnedReportVisibility(auth): SQL` (the ONLY way a `partner_id` predicate enters a `reports` query); `assertReportExecutionPreflight(owner: ReportOwner, config, authority)`; `PARTNER_SCOPE_REPORT_TYPES: ReadonlySet<ReportType>` = the three business types (W02 replaces this with `REPORT_GENERATORS[type].supportedScopes`); `getReportWithOwnerCheck(reportId, auth)` and `getReportRunWithOwnerCheck(runId, auth, action)` returning `{ …, owner: ReportOwner }`; `getReportWithOrgCheck` / `getReportRunWithOrgCheck` kept as deprecated aliases; `PARTNER_OWNED_REPORT = { error: 'partner_owned_report' }`; `UnsupportedReportScopeError`.

- [ ] **Step 1: Write the failing route tests**

`apps/api/src/routes/reports/core.partnerOwned.test.ts` — follow the mocking style of `apps/api/src/routes/reports/systemManaged.test.ts` (same `vi.mock('../../db')` shape and `authMiddleware` stub). Cases:

```ts
describe('POST /reports ownerScope=partner (#3198 W01)', () => {
  it('403s an org-scope token', …)                      // scope organization → { error: 'partner_scope_required' }
  it('403s a partner token whose partnerOrgAccess is selected', …)   // → PARTNER_WIDE_WRITE_DENIED_MESSAGE
  it('400s a type not in PARTNER_SCOPE_REPORT_TYPES', …) // type 'device_inventory' → { error: 'unsupported_report_scope' }
  it('inserts partnerId from auth, orgId null, partner_wide scope columns', …)
     // assert the insert values: partnerId === auth.partnerId, orgId === null,
     // executionScopeKind === 'partner_wide', executionScopeUserId === auth.user.id
  it('ignores a client-supplied partnerId', …)
});
describe('PUT /reports/:id on a partner-owned definition', () => {
  it('rejects ownerScope in the body (schema omits it)', …)
  it('403s a selected-access partner user even though RLS would show the row', …)
});
describe('GET /reports list for partner scope', () => {
  it('includes partner-owned rows only when partnerOrgAccess is all', …) // assert the compiled where contains partner_id param iff all
  it('never adds a partner_id predicate for org scope', …)
});
```

`helpers.partnerOwned.test.ts`:
```ts
it('getReportWithOwnerCheck resolves a partner-owned row through resolveRequestPartnerReportAuthority', …)
it('getReportWithOwnerCheck returns null for a partner-owned row when the caller is org scope', …)
it('getReportRunWithOwnerCheck returns the partner_wide run predicate for a partner-owned run', …)
```

Write each with real request bodies, real mocked rows (`{ id, orgId: null, partnerId, executionScopeKind: 'partner_wide', … }`), and real assertions on the mocked insert/select arguments — walk bound params, do not `toContain('partner')` on a stringified query.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/reports/core.partnerOwned.test.ts src/routes/reports/helpers.partnerOwned.test.ts`
Expected: FAIL (schema rejects `ownerScope`; helpers throw on `orgId: null`).

- [ ] **Step 3: Schemas**

```ts
// schemas.ts
/** #3198 W01: types that may be owned by a partner. W02 replaces this set with
 *  REPORT_GENERATORS[type].supportedScopes; until then these three exist as
 *  enum labels only, so a partner-owned definition of them can be created and
 *  scheduled but every generate answers unsupported_report_scope. */
export const PARTNER_SCOPE_REPORT_TYPES: ReadonlySet<string> = new Set([
  'ticket_sla_attainment', 'technician_time_billability', 'ar_aging',
]);

export const createReportSchema = z.object({
  // Ownership axis (#3198 W01, mirrors routes/security/schemas.ts:177).
  // 'organization' (default) = classic org report. 'partner' = partner-owned
  // cross-org aggregate; the server derives partner_id from the caller's own
  // token — a client-supplied partner id is NEVER read. Create-only:
  // updateReportSchema omits it.
  ownerScope: z.enum(['organization', 'partner']).default('organization'),
  orgId: z.string().guid().optional(),
  // … existing fields …
});
export const updateReportSchema = createReportSchema.partial().omit({ ownerScope: true });   // adjust to however update is derived today (:296 area)
```
Add the three labels to `reportTypeSchema` (`:13-46`) with the same comment. `generateReportSchema` gains `ownerScope` identically.

- [ ] **Step 4: `UnsupportedReportScopeError`, the generator guard, and the owner-axis preflight**

`assertReportExecutionPreflight` / `assertExecutableAuthority` (`reportGenerationService.ts:213-260`) compare `authority.scope.orgId` with the requested org. A `partner_wide` scope has no `orgId`, so a partner-owned run would fail preflight before generating. Change the first parameter from `orgId: string` to `owner: ReportOwner`:
```ts
export function assertReportExecutionPreflight(owner: ReportOwner, config: Record<string, unknown>, authority: ReportGenerationAuthority): void {
  if (owner.partnerId !== undefined) {
    if (authority.principalKind !== 'user' || authority.scope.kind !== 'partner_wide' || authority.scope.partnerId !== owner.partnerId) {
      throw new UnexecutableReportScopeError('partner authority mismatch');
    }
    return; // a partner-wide config carries no site filter to preflight
  }
  // … existing org body, using owner.orgId …
}
```
Update every caller (`grep -rn assertReportExecutionPreflight apps/api/src`) to pass `{ orgId }` / the owner; the existing tests pass `orgId` strings — wrap them.

In `reportGenerationService.ts` next to `UnexecutableReportScopeError`:
```ts
/** #3198 W01: the definition's owner axis is one this type cannot run under.
 *  Every partner-owned report throws this until W02 registers partner-capable
 *  generators. Routes answer 400 unsupported_report_scope; the worker records
 *  a failed run with that reason. */
export class UnsupportedReportScopeError extends Error {
  constructor(type: string, scope: 'organization' | 'partner') {
    super(`${type} cannot run at ${scope} scope`);
    this.name = 'UnsupportedReportScopeError';
  }
}
```
Add the three labels to the `ReportType` union (`:33-79`) so `reportGenerationService.test.ts`'s enum pin goes green, and add three `case` arms to `dispatchReportGeneration` (`:858-961`) that `throw new UnsupportedReportScopeError(type, 'organization')` — org-scoped generation of a business type is also unsupported this wave (the generators do not exist). Update the `never`-guard test expectations accordingly.

- [ ] **Step 5: Helpers**

The `org_access = 'all'` rule has NO database backstop: `breeze_has_partner_access` is flat membership and `org_access` lives only in the app layer, so a `selected`-access partner user is denied purely by call-site discipline. Make that discipline mechanical — one helper, one scanner:

```ts
/**
 * #3198 W01 (spec §3.1a). The ONE predicate that may reach partner-owned rows.
 * Returns `partner_id = auth.partnerId` only for a caller who may administer
 * partner-wide state (partner scope with org_access='all', or system scope);
 * FALSE for everyone else, including org tokens and 'selected' partner users.
 * partnerOwnedVisibility.scan.test.ts fails any `from(reports)` /
 * `innerJoin(reports, …)` under routes/, services/, jobs/ that neither calls
 * this nor is allowlisted as org-only with a reason.
 */
export function partnerOwnedReportVisibility(
  auth: Pick<AuthContext, 'scope' | 'partnerId' | 'partnerOrgAccess'>,
): SQL<unknown> {
  if (auth.scope === 'system') return sql<unknown>`TRUE`;
  return canManagePartnerWidePolicies(auth) && auth.partnerId
    ? eq(reports.partnerId, auth.partnerId)
    : sql<unknown>`FALSE`;
}

export const PARTNER_OWNED_REPORT = { error: 'partner_owned_report' } as const;

export function partnerOwnedRefusal(row: { orgId: string | null; partnerId: string | null }) {
  return row.partnerId ? PARTNER_OWNED_REPORT : null;
}

export async function getReportWithOwnerCheck(reportId: string, auth: AuthContext) {
  const [metadata] = await db.select(reportDefinitionMetadataProjection).from(reports)
    .where(tenantAuthorizedReportCondition(reportId, auth)).limit(1);
  if (!metadata) return null;
  const owner = reportOwnerOf(metadata);
  const authorityResult = owner.partnerId !== undefined
    ? await resolveRequestPartnerReportAuthority(auth, owner.partnerId, 'read')
    : await resolveRequestReportAuthority(auth, owner.orgId, 'read');
  if (!authorityResult.ok || authorityResult.authority.scope.kind === 'legacy_unscoped') return null;
  let storedScope: SiteScopeV1;
  try { storedScope = decodeSiteScope(metadata as unknown as PersistedSiteScopeColumns, owner); } catch { return null; }
  if (!isSiteScopeSubset(storedScope, authorityResult.authority.scope)) return null;
  const ownerCondition = owner.partnerId !== undefined
    ? eq(reports.partnerId, owner.partnerId) : eq(reports.orgId, owner.orgId);
  const [report] = await db.select().from(reports)
    .where(and(eq(reports.id, reportId), ownerCondition,
      reportDefinitionScopeSqlPredicate(reports, authorityResult.authority.scope))).limit(1);
  return report ? { ...report, owner } : null;   // callers that spread the row keep working
}
/** @deprecated W01 alias — remove in W02 once every caller passes through the owner-aware helper. */
export const getReportWithOrgCheck = getReportWithOwnerCheck;
```

`tenantAuthorizedReportCondition` (`:185`): the partner branch becomes
```ts
  if (auth.scope === 'partner') {
    const orgIds = auth.accessibleOrgIds ?? [];
    const orgCondition = orgIds.length > 0 ? inArray(reports.orgId, orgIds) : sql<unknown>`FALSE`;
    return and(idCondition, or(orgCondition, partnerOwnedReportVisibility(auth)))!;
  }
```
The `organization` branch is untouched — it filters on `reports.orgId = auth.orgId`, which no partner-owned row satisfies.

`reportDefinitionMetadataProjection` and `reportRunMetadataProjection` add `partnerId: reports.partnerId`. `getReportRunWithOrgCheck` (`:207`) → `getReportRunWithOwnerCheck` with the same owner branch as above; the org-scope tenant condition stays `eq(reports.orgId, auth.orgId)`; the partner-scope condition becomes the `or(...)` above; `runScopePredicate` uses `reportRunScopeSqlPredicate(reportRuns, scope)`, which after Task 3 handles a `partner_wide` scope (add the `partner_wide` case to `definitionScopePredicate` in `siteScope.ts` if it switches on `kind` — check `:700-733`; the predicate for `partner_wide` is `execution_scope_kind = 'partner_wide' AND execution_scope_site_ids IS NULL AND execution_scope_principal_kind = 'user'`).

`ensureOrgAccess` is untouched.

- [ ] **Step 6: `core.ts`**

Create (`:392`): insert the partner branch BEFORE the existing `orgId` resolution:
```ts
    if (data.ownerScope === 'partner') {
      if (auth.scope !== 'partner' || !auth.partnerId) {
        return c.json({ error: 'partner_scope_required' }, 403);
      }
      if (!canManagePartnerWidePolicies(auth)) {
        return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      }
      if (!PARTNER_SCOPE_REPORT_TYPES.has(data.type)) {
        return c.json({ error: 'unsupported_report_scope', type: data.type }, 400);
      }
      const authorityResult = await resolveRequestPartnerReportAuthority(auth, auth.partnerId, 'write');
      if (!authorityResult.ok) {
        return c.json({ error: 'Report scope is not authorized', reason: authorityResult.reason }, 403);
      }
      const [report] = await db.insert(reports).values({
        orgId: null,
        partnerId: auth.partnerId,
        name: data.name, type: data.type, config: data.config, schedule: data.schedule, format: data.format,
        createdBy: auth.user.id,
        ...persistedSiteScopeValues(authorityResult.authority),
      }).returning();
      writeRouteAudit(c, { orgId: null, partnerId: auth.partnerId, action: 'report.create', resourceType: 'report',
        resourceId: report?.id, resourceName: report?.name,
        details: { type: report?.type, schedule: report?.schedule, format: report?.format, ownerScope: 'partner' } });
      return c.json(report, 201);
    }
```
(Check `writeRouteAudit`'s parameter type accepts `orgId: null`; if it does not, pass `auth.orgId ?? undefined` and put the partner id in `details` — read `apps/api/src/services/audit/routeAudit.ts` or wherever it lives before deciding.)

List (`resolveDefinitionListScope` `:76`): in the `auth.scope === 'partner'` branch, when `!explicitOrgId && canManagePartnerWidePolicies(auth) && auth.partnerId`, extend both conditions:
```ts
    const partnerWide = canManagePartnerWidePolicies(auth) && auth.partnerId
      ? { rowPartnerId: reports.partnerId, partnerId: auth.partnerId } : undefined;
    return {
      ok: true,
      tenantCondition: or(
        orgIds.length > 0 ? inArray(reports.orgId, orgIds) : sql<unknown>`FALSE`,
        partnerOwnedReportVisibility(auth),
      )!,
      definitionScopePredicate: reportDefinitionMultiOrgScopeSqlPredicate(reports.orgId, reports, scopes, partnerWide),
    };
```
When `explicitOrgId` is given the caller asked for one org — partner-owned rows are excluded, unchanged.

Update: ownership is immutable. `updateReportSchema` omits `ownerScope`, AND the handler refuses `orgId` in the body when the locked row is partner-owned (`{ error: 'report_ownership_immutable' }`, 400) — the `report_schedule_recipients` / `service_deliverables` composite FKs are `ON UPDATE NO ACTION`, so flipping the axis would 23503 anyway.

Update/delete/`loadLockedDefinition`: replace `getReportWithOrgCheck` with `getReportWithOwnerCheck`; wherever the handler calls `resolveRequestReportAuthority(auth, report.orgId, 'write' | 'delete')`, branch on `report.owner` to `resolveRequestPartnerReportAuthority`. `isPortalSelfServiceLocked` takes `definition.orgId: string` — a partner-owned row has `portalSelfService === false` by construction, so guard: `if (definition.orgId && await isPortalSelfServiceLocked(tx, { …, orgId: definition.orgId }))`.

- [ ] **Step 7: `generate.ts`, `runs.ts`, `recipients.ts`**

`generate.ts` (ad-hoc): if `data.ownerScope === 'partner'` apply the same three gates as create, then `return c.json({ error: 'unsupported_report_scope', type: data.type }, 400)` — every business type is generator-less this wave, and no existing type supports partner scope. Also map `UnsupportedReportScopeError` → 400 in the existing `catch`.

`runs.ts`: the run-list route (`:225-269`) builds `reportRunMultiOrgScopeSqlPredicate` — pass the same `partnerWide` argument as the definition list when the caller qualifies; the `innerJoin(reports)` tenant condition gains the `or(...)`. Download/detail/write routes swap `getReportRunWithOrgCheck` → `getReportRunWithOwnerCheck`; any `access.metadata.orgId` used for branding/audit becomes owner-aware (`orgId ?? null`).

`recipients.ts`: extend `systemManagedRefusal` → `writeRefusal(report)` returning `systemManagedRefusal(report) ?? partnerOwnedRefusal(report)`; both writers already `return c.json(refusal, 409)` (`:105`, `:169`). The GET stays readable (empty list).

- [ ] **Step 7a: The source scanner**

`apps/api/src/routes/reports/partnerOwnedVisibility.scan.test.ts`, same technique as `siteScope.projections.test.ts` (read source files, regex for query sites):
```ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['src/routes', 'src/services', 'src/jobs'].map((p) => join(process.cwd(), p));
const QUERY_SITE = /\.(from|innerJoin|leftJoin)\(\s*reports\b/;
/** Files whose every `reports` query is org-only BY DESIGN. Each entry needs a reason. */
const ORG_ONLY_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  ['src/services/portal/reportsSelfService.ts', 'portal reads key on org_id + portal_self_service; partner-owned rows are never portal-visible (spec §3.5)'],
  ['src/services/deliverableAutoEvidence.ts', 'managed evidence is org-owned by construction (#5784)'],
  ['src/jobs/reportScheduleWorker.ts', 'system DB context, reads by id, re-asserts live partner authority per row before generating'],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('partner-owned report visibility is mechanical (#3198 W01)', () => {
  it('finds query sites (guards against a vacuous scan)', () => {
    const hits = ROOTS.flatMap((r) => walk(r)).filter((f) => QUERY_SITE.test(readFileSync(f, 'utf8')));
    expect(hits.length).toBeGreaterThan(5);
  });
  it('every reports query site either calls partnerOwnedReportVisibility or is allowlisted org-only', () => {
    for (const file of ROOTS.flatMap((r) => walk(r))) {
      const text = readFileSync(file, 'utf8');
      if (!QUERY_SITE.test(text)) continue;
      const rel = file.slice(process.cwd().length + 1);
      if (ORG_ONLY_ALLOWLIST.has(rel)) continue;
      expect(text, `${rel} queries reports without partnerOwnedReportVisibility`).toMatch(/partnerOwnedReportVisibility\(/);
    }
  });
  it('every allowlist entry still exists and still queries reports', () => {
    for (const rel of ORG_ONLY_ALLOWLIST.keys()) {
      expect(QUERY_SITE.test(readFileSync(join(process.cwd(), rel), 'utf8')), rel).toBe(true);
    }
  });
});
```
Run it BEFORE wiring the helper: it must red on `core.ts`, `helpers.ts`, `runs.ts`, `generate.ts`, `recipients.ts` and on any service outside the allowlist that reads `reports` (each of those is a real gap — read it, then either wire the helper or allowlist it with a reason a reviewer would accept).

- [ ] **Step 8: Run tests + typecheck**

Run:
```bash
cd apps/api && npx vitest run src/routes/reports src/services/reportGenerationService.test.ts src/services/siteScope
pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json
```
Expected: PASS; tsc clean except the worker files Task 6 owns (`reportScheduleWorker.ts`) and `deliverableAutoEvidence.ts` / portal `reportsSelfService.ts` (fix those two inline: they read `report.orgId` for org-owned rows only — add a non-null assertion with a comment citing `reports_one_owner_chk` and the type/`portalSelfService` invariant, or narrow via `reportOwnerOf`).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/reports apps/api/src/services/reportGenerationService.ts apps/api/src/services/deliverableAutoEvidence.ts apps/api/src/services/portal/reportsSelfService.ts
git commit -m "feat(reports): ownerScope on create, owner-aware access helpers, partner gates on every operation (#3198 W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Schedule worker — owner-axis branch

**Files:**
- Modify: `apps/api/src/jobs/reportScheduleWorker.ts` (`findDueReports` :185-250, `processRunScheduledReport` :400-620)
- Modify: `apps/api/src/services/reportBranding.ts` (new `loadReportBrandingForPartner`)
- Test: `apps/api/src/jobs/reportScheduleWorker.due.test.ts`, `apps/api/src/jobs/reportScheduleWorker.test.ts`, `apps/api/src/jobs/reportScheduleWorker.contract.test.ts` (unchanged, run it), `apps/api/src/services/reportBranding.test.ts` (add a case if the file exists; create it otherwise)

- [ ] **Step 1: Failing tests**

`reportScheduleWorker.due.test.ts` — add:
```ts
it('admits a partner-owned definition with a complete partner_wide scope and resolves its timezone from the partner row', async () => {
  // mock the select chain to return one row: { id, schedule: 'monthly', lastGeneratedAt: null, config: {}, orgSettings: null, partnerTimezone: 'Europe/Berlin', partnerSettings: {} }
  // assert findDueReports(now) returns it, and that the compiled WHERE contains executionScopeKind IN ('unrestricted','restricted','partner_wide')
});
it('still skips a partner-owned definition whose scope is incomplete (no user id)', …);
```
`reportScheduleWorker.test.ts` — add:
```ts
it('reauthorizes a partner-owned definition through resolveLivePartnerReportAuthority and stamps a partner_wide run', …);
it('records unsupported_report_scope when generateReport throws UnsupportedReportScopeError for a partner-owned definition', …);
it('denies scope_no_intersection when the live partner authority is for a different partner', …);
```
Mock `resolveLivePartnerReportAuthority` alongside the existing `resolveLiveReportAuthority` mock; assert the `reportRuns` insert values include `executionScopeKind: 'partner_wide'`, `requestedByKind: 'user'`, `requestedByUserId: <user>`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/jobs/reportScheduleWorker.due.test.ts src/jobs/reportScheduleWorker.test.ts -t 'partner'`
Expected: FAIL.

- [ ] **Step 3: `findDueReports`**

```ts
  const completeExecutableScope = and(
    eq(reports.executionScopeVersion, 1),
    inArray(reports.executionScopeKind, ['unrestricted', 'restricted', 'partner_wide']),
    isNotNull(reports.executionScopeUserId),
    isNotNull(reports.executionScopeFingerprint),
    isNotNull(reports.executionScopeCapturedAt),
    or(
      and(eq(reports.executionScopeKind, 'unrestricted'), isNull(reports.executionScopeSiteIds), isNotNull(reports.orgId)),
      and(eq(reports.executionScopeKind, 'restricted'), isNotNull(reports.executionScopeSiteIds), isNotNull(reports.orgId)),
      // #3198 W01: partner-owned definitions (spec §3.1a).
      and(eq(reports.executionScopeKind, 'partner_wide'), isNull(reports.executionScopeSiteIds), isNotNull(reports.partnerId)),
    ),
  )!;
  const rows = await db
    .select({
      id: reports.id, schedule: reports.schedule, lastGeneratedAt: reports.lastGeneratedAt, config: reports.config,
      orgSettings: organizations.settings,
      partnerTimezone: sql<string | null>`coalesce(${ownerPartner.timezone}, ${orgPartner.timezone})`,
      partnerSettings: sql<unknown>`coalesce(${ownerPartner.settings}, ${orgPartner.settings})`,
    })
    .from(reports)
    .leftJoin(organizations, eq(reports.orgId, organizations.id))
    .leftJoin(orgPartner, eq(organizations.partnerId, orgPartner.id))
    .leftJoin(ownerPartner, eq(reports.partnerId, ownerPartner.id))
    .where(and(pollable, completeExecutableScope));
```
with `const orgPartner = alias(partners, 'org_partner'); const ownerPartner = alias(partners, 'owner_partner');` (`import { alias } from 'drizzle-orm/pg-core'`). `resolveTimezoneFromRows(null, partnerTz, partnerSettings)` already handles a null org side (`:94-119` per the 2026-07-01 doc — verify).

- [ ] **Step 4: `processRunScheduledReport`**

After the `definitionPrincipalKind` guard (`:450-467`) and before `decodeSiteScope` (`:469`):
```ts
  let owner: ReportOwner;
  try { owner = reportOwnerOf(report); } catch { await deny('scope_unverifiable'); return; }

  let persistedScope;
  try { persistedScope = decodeSiteScope(report as unknown as PersistedSiteScopeColumns, owner); }
  catch { await deny('scope_unverifiable'); return; }
  // … legacy_unscoped + missing user id guards unchanged …

  let liveResult;
  try {
    liveResult = owner.partnerId !== undefined
      ? await resolveLivePartnerReportAuthority(report.executionScopeUserId, owner.partnerId, 'read')
      : await resolveLiveReportAuthority(report.executionScopeUserId, owner.orgId, 'read');
  } catch { await deny('scope_unverifiable'); return; }
```
The intersection / empty-scope block follows unchanged; `assertReportExecutionPreflight(report.orgId, config, executionAuthority)` (`:530`) becomes `assertReportExecutionPreflight(owner, config, executionAuthority)` (Task 5 Step 4 changed the signature).

Generation (`~:580`):
```ts
      const reportData = owner.partnerId !== undefined
        ? (() => { throw new UnsupportedReportScopeError(report.type, 'partner'); })()   // W02 replaces this with generateReport over a ReportScope
        : await generateReport(report.type, owner.orgId, config, executionAuthority);
```
and in the failure handler, map `UnsupportedReportScopeError` to `errorMessage: 'unsupported_report_scope'` (the existing failed-run write path). Branding (`:600`): `owner.partnerId !== undefined ? loadReportBrandingForPartner(owner.partnerId) : loadReportBrandingForOrg(owner.orgId)`. The email-lane block (`:605-626`) selects `organizations.partnerId` for the deliverable lane — for a partner-owned report use `owner.partnerId` directly. `resolveScheduledReportRecipients({ reportId, orgId, config })` (`:299`): pass `orgId: owner.orgId ?? null` and make the function skip the contact-recipient query when `orgId` is null (legacy `config.emailRecipients` still applies — spec §3.1a).

- [ ] **Step 5: `loadReportBrandingForPartner`**

In `reportBranding.ts`, extract the partner-row → `ReportBranding` mapping from `loadReportBrandingForOrg` (`:28-79`, everything after the `readWithPartnerAxisVisibility` read) into `brandingFromPartnerRow(row, logContext)` and add:
```ts
/** #3198 W01: branding for a PARTNER-owned report. The caller has already
 *  proven partner authority (partner_wide scope), so the partner-axis read is
 *  pinned to that id, never to caller input. */
export async function loadReportBrandingForPartner(partnerId: string): Promise<ReportBranding> {
  const [row] = await readWithPartnerAxisVisibility(() =>
    db.select({ partnerName: partners.name, partnerSettings: partners.settings })
      .from(partners).where(eq(partners.id, partnerId)).limit(1));
  return brandingFromPartnerRow(row, { partnerId });
}
```

- [ ] **Step 6: Run the worker suites + typecheck**

Run:
```bash
cd apps/api && npx vitest run src/jobs/reportScheduleWorker src/services/reportBranding
pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json
```
Expected: PASS; tsc clean across the API.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs/reportScheduleWorker.ts apps/api/src/jobs/reportScheduleWorker.due.test.ts apps/api/src/jobs/reportScheduleWorker.test.ts apps/api/src/services/reportBranding.ts apps/api/src/services/reportBranding.test.ts
git commit -m "feat(reports): schedule worker runs partner-owned definitions under live partner authority (#3198 W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: End-to-end proof, full suites, PR

**Files:**
- Create: `apps/api/src/__tests__/integration/reportsPartnerOwned.integration.test.ts`
- Docs: none this wave (W03 owns user docs); the PR body is the record.

- [ ] **Step 1: Write the integration proof through the real routes**

Model on `apps/api/src/__tests__/integration/portalReportSelfService.integration.test.ts` (it drives the Hono app with a seeded partner user and real Postgres). Cases:

```ts
it('partner admin (org_access=all) creates a partner-owned ar_aging definition, lists it, gets it, and an org user of the same partner gets 404', …);
it('partner user with org_access=selected gets 403 on create and 404 on get of an existing partner-owned definition', …);
it('POST /reports/:id/generate on the partner-owned definition answers 400 unsupported_report_scope (W02 turns this green)', …);
it('POST /reports/:id/recipients on the partner-owned definition answers 409 partner_owned_report', …);
it('findDueReports returns the partner-owned monthly definition and processRunScheduledReport records a failed run with unsupported_report_scope', …);
```
Seed with the suite's `createPartner` / `createOrganization` / `createUser` + a `partner_users` row with `org_access = 'all'` and a role carrying `reports:read|write|export` (read the seed helpers in `db-utils.ts` for the role-permission shape).

- [ ] **Step 2: Run everything**

```bash
pnpm db:check-drift
cd apps/api && npx vitest run                              # full unit suite
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm --filter=@breeze/api test:rls
pnpm --filter=@breeze/api test:integration                 # full — this wave touched tenancy
pnpm --filter @breeze/web exec tsc --noEmit                # web reads report.orgId in a few places; confirm nothing assumed non-null at compile time (the web types are hand-written; fix any that are)
pnpm test-stack down
```
Expected: all green. Paste the summary lines into the PR body.

- [ ] **Step 3: Commit and open the PR**

```bash
git add apps/api/src/__tests__/integration/reportsPartnerOwned.integration.test.ts
git commit -m "test(reports): route-level proof for partner-owned definitions (#3198 W01)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin HEAD
gh pr create --title "feat(reports): W01 partner-scope reports foundation (#3198)" --body-file - <<'EOF'
## Summary
Partner-owned reports (org XOR partner) end to end: ownership migration + dual-axis RLS (no partner-wide SELECT branch — partner-private aggregates), `partner_wide` execution-scope kind with live `org_access = 'all'` reauthorization, `ownerScope` on create, owner-aware helpers, worker branch. Three business report enum labels exist with no generator; generating a partner-owned report answers `unsupported_report_scope` until W02.

Spec: docs/superpowers/specs/reports/2026-08-16-psa-business-reports-spec.md §3.1, §3.1a, §4. Plan: docs/superpowers/plans/reports/2026-09-21-business-reports-w01-partner-scope-foundation.md.

## Tenancy checklist
- [ ] `reports` in `DUAL_AXIS_TENANT_TABLES`; excluded from `XOR_OWNERSHIP_DUAL_AXIS_TABLES` with rationale (org tokens must not read partner-owned reports)
- [ ] `reports.partner_id` classified `included` in `CORE_TENANT_EXPORT_POLICY`
- [ ] `report_runs` + `report_run_deliveries` FK-join policies carry the partner OR; functional insert/read proof in `reportsPartnerRls.integration.test.ts`
- [ ] `report_runs.report_id` → `ON DELETE CASCADE`
- [ ] Both execution-scope CHECKs admit `partner_wide` (user principal only)
- [ ] Manual `breeze_app` cross-partner forge → 42501 (paste output)
- [ ] rls-coverage / rls / integration suites run locally (paste counts)

## Behaviour changes for existing org-owned reports
None. Org arms of every predicate, fingerprint and CHECK are byte-for-byte unchanged; the existing reports suites pass unmodified.

Closes #<W01 sub-issue — fill in after feature registration>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 4: Review round**

Run `/pr-review-toolkit:review-pr` once. Act only on confirmed findings; a fix that touches `siteScope.ts`, the migration, or `rls-coverage` gets one more review pass (CLAUDE.md review-recursion cap), anything else does not.

---

## Self-review against the spec

| Spec item | Task |
|---|---|
| §3.1 migration (partner_id, nullable org_id, XOR CHECK, index, Shape 4 RLS, `report_runs` partner OR, FK cascade) | 1 |
| §3.1 `report_run_deliveries` partner OR; partial unique index predicates | 1 |
| §3.1 enum labels in their own file, `YYYY-MM-DD-HHMMSS` names after `2026-10-25-130100` | 1 |
| §3.1a `partner_wide` scope kind, fingerprint, decode with owner, intersect/subset, persist | 3 |
| §3.1a live + request partner authority, `org_access = 'all'`, denial reasons | 3 |
| §3.1a CHECK branches (user principal only) | 1, proven in 4 |
| §3.1a list/get predicate branch only for qualifying partner callers | 3, 5 |
| §3.1a recipients refusal 409, `config.emailRecipients` delivery | 5, 6 |
| §3.1a worker: owner branch before decode, `findDueReports` admits `partner_wide`, leftJoins, partner branding | 6 |
| §3.1 routes: `ownerScope` create-only, update omits, partner id from token, `orgAccess === 'all'` on EVERY operation | 5 |
| §3.1 carve-out ahead of the "orgId is required" 400 | 5 |
| §4 registrations (dual-axis, export policy, merge note, cascade unchanged) | 4 |
| §10 tenancy suite (42501, 23514, org isolation, functional run insert) | 4 |
| §10 worker regression (org-owned still returned; partner-owned now returned) | 6 |
| §3.1a preflight takes the owner axis | 5, 6 |
| §3.1a `partnerOwnedReportVisibility` + source-scan test (no DB backstop for `org_access`) | 5 |
| §3.1a ownership immutable (update refuses axis flip) | 5 |
| §3.1a projections test requires `partnerId` | 3, 5 |
| §3.1a `tenantCascade.ts` comment + partner-purge assertion | 4 |
| §3.1 no partial-index rebuild; `reports_id_org_id_uniq` never partial | 1 |
| §3.2 `ReportScope` / generator contract | **W02** (deliberately not here — the public `generateReport` signature is unchanged this wave) |

Placeholder scan: the only `…` blocks are explicit "paste the shipped text from file:line" instructions (Task 1 Step 2, Task 3 Step 3) and the abbreviated test bodies in Task 4/5/6, each of which names the assertions to write. Type consistency: `ReportOwner`, `reportOwnerOf`, `partnerWideScope`, `resolveLivePartnerReportAuthority`, `resolveRequestPartnerReportAuthority`, `getReportWithOwnerCheck`, `getReportRunWithOwnerCheck`, `partnerOwnedReportVisibility`, `assertReportExecutionPreflight(owner, …)`, `UnsupportedReportScopeError`, `PARTNER_SCOPE_REPORT_TYPES`, `PARTNER_OWNED_REPORT`, `loadReportBrandingForPartner` — same spelling in every task and in the W02 brief.
