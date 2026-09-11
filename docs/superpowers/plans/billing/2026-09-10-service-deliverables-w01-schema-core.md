---
tracking_issue: LanternOps/breeze#5573
---
# Service Deliverables W01: Schema, Core Services, Contract and Org Record Surfaces — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the tenant tables, pure recurrence and state-machine modules, services, REST routes and MSP web surfaces for service deliverables, occurrences, report-run evidence and org key dates, so W02 (sweep), W03 (documents), W04 (portal) and W05 (templates) build on fixed names.

**Architecture:** Three idempotent hand-written migrations create `service_deliverables`, `service_deliverable_occurrences`, `service_deliverable_evidence`, `organization_key_dates` (all RLS shape 1, direct `org_id`) and add `tickets.work_kind`. Two pure modules (`services/recurrence.ts`, `services/serviceDeliverableState.ts`) hold every date and status rule with no I/O. `services/serviceDeliverableService.ts` and `services/orgKeyDateService.ts` are the only writers; Hono routes under `/orgs/:orgId/…` and `/contracts/:id/deliverables` are thin. The web adds a section to the contract detail page, a Service tab and a Key dates card to the organization record.

**Tech Stack:** PostgreSQL + hand-written SQL migrations, Drizzle ORM, Hono + Zod (`@breeze/shared` validators), Vitest (API unit with Drizzle mocks; API integration on real Postgres), Astro + React islands, react-i18next, Testing Library.

**Spec:** `docs/superpowers/specs/billing/2026-09-10-service-deliverables-portal-design.md` (approved 2026-09-10). Sections 4.1–4.3, 4.5, 4.8, 4.9, 7, 9, 10 (non-portal), 12, 13 are this wave. Where this plan is more specific than the spec (function names, file names, one extra column `delivered_via`), the plan wins and the spec's §4.2 is amended in Task 1.

## Global Constraints

- Every tenant-scoped table: RLS enabled + forced + four shape-1 policies (`breeze_has_org_access(org_id)`) in the creating migration. Never deferred.
- Every composite FK that references an `org_id` column is `DEFERRABLE INITIALLY IMMEDIATE`.
- Migrations are idempotent (`IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`), have no inner `BEGIN`/`COMMIT`, and write no rows (so no `breeze.scope` election is needed; if a later edit adds DML, put `SELECT set_config('breeze.scope','system',true);` first).
- Migration filenames sort after the newest committed migration. As of 2026-09-10 that is `2026-10-15-160010-backup-snapshots-layout-manifest.sql`. This plan uses `2026-10-15-170000-…`, `-170100-…`, `-170200-…`. Re-check with `ls apps/api/migrations | sort | tail -1` before every commit and rename upward if needed.
- Every new `org_id` table is registered in the same PR in: `CORE_ORG_CASCADE_DELETE_ORDER` (`apps/api/src/services/tenantCascade.ts`), `CORE_TENANT_EXPORT_POLICY` (`apps/api/src/services/tenantExportPolicyRegistry.ts`), and `apps/api/src/services/orgMergeRegistry.ts`. Adding a column to a registered table (`tickets`, `report_runs`) updates its export-policy entry.
- Org access in services: `actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(orgId)` ⇒ 404 `NOT_FOUND` (never 403, no existence leak). The check has the same shape as `requireOrgAccess` in `apps/api/src/services/contractService.ts:56`, but that helper throws 403 `ORG_DENIED`; do not copy its status, spec §12 requires 404 here.
- Dates are ISO `YYYY-MM-DD` strings everywhere in code; Postgres `date` columns. Month arithmetic only through `addMonthsClamped` / `addDaysISO` from `apps/api/src/services/contractMath.ts`.
- Web mutations go through `runAction` (`apps/web/src/lib/runAction.ts`). Org-record requests use the record's `orgFetch` (`orgRecordFetch.ts`), never ambient `fetchWithAuth`.
- New i18n namespace `deliverables.json` in all 8 locales (`apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/`) with real translations; `apps/web/src/lib/i18n/translationCoverage.test.ts` caps exact-English duplicates.
- Run one test file as `cd apps/api && npx vitest run <path>` (never `pnpm … test -- --run`).
- Branch: `feature/<parent#>-service-deliverables/wave-<W01 sub-issue#>`; PR body `Closes #<W01 sub-issue>`.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-15-170000-service-deliverables.sql` | enums, three deliverable tables, `report_runs (id, report_id)` unique, RLS |
| `apps/api/migrations/2026-10-15-170100-tickets-work-kind.sql` | `ticket_work_kind` enum + `tickets.work_kind` |
| `apps/api/migrations/2026-10-15-170200-organization-key-dates.sql` | `org_key_date_kind` enum, `organization_key_dates`, RLS |
| `apps/api/src/db/schema/serviceDeliverables.ts` | Drizzle tables + enums for the three deliverable tables |
| `apps/api/src/db/schema/orgKeyDates.ts` | Drizzle table + enum for key dates |
| `apps/api/src/db/schema/portal.ts` | add `ticketWorkKindEnum`, `tickets.workKind` |
| `apps/api/src/db/schema/reports.ts` | add `report_runs_id_report_id_uniq` |
| `apps/api/src/db/schema/index.ts` | export the two new modules |
| `apps/api/src/services/recurrence.ts` (+ `.test.ts`) | pure cadence/period/plan math |
| `apps/api/src/services/serviceDeliverableState.ts` (+ `.test.ts`) | pure occurrence state machine |
| `apps/api/src/services/serviceDeliverableService.ts` (+ `.test.ts`) | deliverable + occurrence + evidence writes/reads |
| `apps/api/src/services/orgKeyDateService.ts` (+ `.test.ts`) | key dates CRUD + read-model union with contract end dates |
| `packages/shared/src/validators/serviceDeliverables.ts` (+ `.test.ts`) | Zod schemas and TS types shared by API and web |
| `packages/shared/src/validators/orgKeyDates.ts` (+ `.test.ts`) | Zod schemas for key dates |
| `apps/api/src/routes/serviceDeliverables.ts` (+ `.test.ts`) | `/orgs/:orgId/deliverables…` |
| `apps/api/src/routes/contracts/deliverables.ts` (+ `.test.ts`) | `/contracts/:id/deliverables` filtered view |
| `apps/api/src/routes/orgKeyDates.ts` (+ `.test.ts`) | `/orgs/:orgId/key-dates…` |
| `apps/api/src/index.ts` | mount the three routers |
| `apps/api/src/services/tenantCascade.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts` | registrations |
| `apps/api/src/__tests__/integration/serviceDeliverablesRls.integration.test.ts` | cross-org forge, deferrable FK, evidence ownership chain |
| `apps/web/src/lib/api/serviceDeliverables.ts`, `orgKeyDates.ts` | typed fetch wrappers |
| `apps/web/src/components/deliverables/DeliverableTable.tsx`, `DeliverableForm.tsx`, `OccurrenceDrawer.tsx` | shared MSP UI |
| `apps/web/src/components/contracts/ContractDeliverablesSection.tsx` | section on the contract detail page |
| `apps/web/src/components/organizations/record/OrgServiceTab.tsx`, `OrgKeyDatesCard.tsx` | org record surfaces |
| `apps/web/src/components/organizations/record/orgRecordTabs.ts`, `OrganizationRecordPage.tsx`, `OrgOverviewTab.tsx` | wire the tab and card |
| `apps/web/src/locales/*/deliverables.json` | i18n |

---

### Task 1: Migration 1 — deliverable tables

**Files:**
- Create: `apps/api/migrations/2026-10-15-170000-service-deliverables.sql`
- Modify: `docs/superpowers/specs/billing/2026-09-10-service-deliverables-portal-design.md` (§4.2 table: add the `delivered_via` row)

**Interfaces:**
- Produces: tables `service_deliverables`, `service_deliverable_occurrences`, `service_deliverable_evidence`; enums `deliverable_cadence`, `deliverable_completion_mode`, `deliverable_occurrence_status`, `deliverable_evidence_kind`; unique `report_runs_id_report_id_uniq (id, report_id)`.

- [ ] **Step 1: Write the migration**

```sql
-- Service deliverables (spec docs/superpowers/specs/billing/2026-09-10-service-deliverables-portal-design.md §4.1–4.3).
-- Idempotent throughout. DDL only: no rows are written, so no breeze.scope election.

-- 1. Enums
DO $$ BEGIN
  CREATE TYPE deliverable_cadence AS ENUM ('monthly','quarterly','semiannual','annual','one_time');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE deliverable_completion_mode AS ENUM ('explicit','on_ticket_resolve');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE deliverable_occurrence_status AS ENUM ('scheduled','open','awaiting_evidence','delivered','missed','waived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE deliverable_evidence_kind AS ENUM ('document','report_run');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. report_runs needs a (id, report_id) key so evidence can prove a run belongs to a report
--    that belongs to the org (report_runs has no org_id of its own).
CREATE UNIQUE INDEX IF NOT EXISTS report_runs_id_report_id_uniq ON report_runs (id, report_id);

-- 3. service_deliverables
CREATE TABLE IF NOT EXISTS service_deliverables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  contract_id UUID,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  cadence deliverable_cadence NOT NULL,
  anchor_due_date DATE NOT NULL,
  effective_from DATE NOT NULL,
  effective_until DATE,
  lead_days INTEGER NOT NULL DEFAULT 7,
  grace_days INTEGER NOT NULL DEFAULT 14,
  artifact_required BOOLEAN NOT NULL DEFAULT TRUE,
  completion_mode deliverable_completion_mode NOT NULL DEFAULT 'on_ticket_resolve',
  auto_evidence_report_id UUID,
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ticket_category_id UUID REFERENCES ticket_categories(id) ON DELETE SET NULL,
  portal_visible BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  ALTER TABLE service_deliverables ADD CONSTRAINT service_deliverables_contract_org_fk
    FOREIGN KEY (contract_id, org_id) REFERENCES contracts(id, org_id)
    ON DELETE SET NULL (contract_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE service_deliverables ADD CONSTRAINT service_deliverables_auto_report_org_fk
    FOREIGN KEY (auto_evidence_report_id, org_id) REFERENCES reports(id, org_id)
    ON DELETE SET NULL (auto_evidence_report_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE service_deliverables ADD CONSTRAINT service_deliverables_effective_chk
    CHECK (effective_until IS NULL OR effective_until >= effective_from);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE service_deliverables ADD CONSTRAINT service_deliverables_days_chk
    CHECK (lead_days >= 0 AND grace_days >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS service_deliverables_id_org_uq ON service_deliverables (id, org_id);
CREATE UNIQUE INDEX IF NOT EXISTS service_deliverables_org_contract_name_uq
  ON service_deliverables (org_id, COALESCE(contract_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
CREATE INDEX IF NOT EXISTS service_deliverables_org_idx ON service_deliverables (org_id);
CREATE INDEX IF NOT EXISTS service_deliverables_contract_idx ON service_deliverables (contract_id) WHERE contract_id IS NOT NULL;

ALTER TABLE service_deliverables ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_deliverables FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON service_deliverables;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON service_deliverables;
DROP POLICY IF EXISTS breeze_org_isolation_update ON service_deliverables;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON service_deliverables;
CREATE POLICY breeze_org_isolation_select ON service_deliverables FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON service_deliverables FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON service_deliverables FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON service_deliverables FOR DELETE USING (public.breeze_has_org_access(org_id));

-- 4. service_deliverable_occurrences
CREATE TABLE IF NOT EXISTS service_deliverable_occurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  deliverable_id UUID NOT NULL,
  name_snapshot VARCHAR(200) NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  due_at DATE NOT NULL,
  original_due_at DATE NOT NULL,
  status deliverable_occurrence_status NOT NULL DEFAULT 'scheduled',
  ticket_id UUID,
  delivered_at TIMESTAMPTZ,
  delivered_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  delivered_via TEXT,
  delivery_note TEXT,
  waived_at TIMESTAMPTZ,
  waived_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  waived_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  ALTER TABLE service_deliverable_occurrences ADD CONSTRAINT sd_occ_deliverable_org_fk
    FOREIGN KEY (deliverable_id, org_id) REFERENCES service_deliverables(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE service_deliverable_occurrences ADD CONSTRAINT sd_occ_ticket_org_fk
    FOREIGN KEY (ticket_id, org_id) REFERENCES tickets(id, org_id)
    ON DELETE SET NULL (ticket_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE service_deliverable_occurrences ADD CONSTRAINT sd_occ_delivered_via_chk
    CHECK (delivered_via IS NULL OR delivered_via IN ('explicit','ticket'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE service_deliverable_occurrences ADD CONSTRAINT sd_occ_period_chk
    CHECK (period_start <= period_end);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS sd_occ_id_org_uq ON service_deliverable_occurrences (id, org_id);
CREATE UNIQUE INDEX IF NOT EXISTS sd_occ_deliverable_period_uq ON service_deliverable_occurrences (deliverable_id, period_start);
CREATE INDEX IF NOT EXISTS sd_occ_org_status_due_idx ON service_deliverable_occurrences (org_id, status, due_at);
CREATE INDEX IF NOT EXISTS sd_occ_ticket_idx ON service_deliverable_occurrences (ticket_id) WHERE ticket_id IS NOT NULL;

ALTER TABLE service_deliverable_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_deliverable_occurrences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON service_deliverable_occurrences;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON service_deliverable_occurrences;
DROP POLICY IF EXISTS breeze_org_isolation_update ON service_deliverable_occurrences;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON service_deliverable_occurrences;
CREATE POLICY breeze_org_isolation_select ON service_deliverable_occurrences FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON service_deliverable_occurrences FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON service_deliverable_occurrences FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON service_deliverable_occurrences FOR DELETE USING (public.breeze_has_org_access(org_id));

-- 5. service_deliverable_evidence (document_id FK is added by W03 when org_documents exists)
CREATE TABLE IF NOT EXISTS service_deliverable_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  occurrence_id UUID NOT NULL,
  kind deliverable_evidence_kind NOT NULL,
  document_id UUID,
  report_id UUID,
  report_run_id UUID,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  ALTER TABLE service_deliverable_evidence ADD CONSTRAINT sd_evidence_occurrence_org_fk
    FOREIGN KEY (occurrence_id, org_id) REFERENCES service_deliverable_occurrences(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE service_deliverable_evidence ADD CONSTRAINT sd_evidence_report_org_fk
    FOREIGN KEY (report_id, org_id) REFERENCES reports(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE service_deliverable_evidence ADD CONSTRAINT sd_evidence_report_run_fk
    FOREIGN KEY (report_run_id, report_id) REFERENCES report_runs(id, report_id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE service_deliverable_evidence ADD CONSTRAINT sd_evidence_kind_chk CHECK (
    (kind = 'document'   AND document_id IS NOT NULL AND report_id IS NULL AND report_run_id IS NULL) OR
    (kind = 'report_run' AND document_id IS NULL AND report_id IS NOT NULL AND report_run_id IS NOT NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS sd_evidence_occurrence_idx ON service_deliverable_evidence (occurrence_id);
CREATE INDEX IF NOT EXISTS sd_evidence_org_idx ON service_deliverable_evidence (org_id);

ALTER TABLE service_deliverable_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_deliverable_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON service_deliverable_evidence;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON service_deliverable_evidence;
DROP POLICY IF EXISTS breeze_org_isolation_update ON service_deliverable_evidence;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON service_deliverable_evidence;
CREATE POLICY breeze_org_isolation_select ON service_deliverable_evidence FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON service_deliverable_evidence FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON service_deliverable_evidence FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON service_deliverable_evidence FOR DELETE USING (public.breeze_has_org_access(org_id));
```

`tickets_id_org_uq (id, org_id)` already exists (`apps/api/migrations/2026-09-25-ai-agents-ticket-triage.sql:34`), so the ticket FK above resolves without a new index.

- [ ] **Step 2: Amend the spec §4.2 table**

Add after the `delivered_by_user_id` row:

```markdown
| delivered_via | text null | `explicit \| ticket`; an `explicit` delivery is never undone by a ticket reopen (§6) |
```

- [ ] **Step 3: Run the naming and RLS-scope guards**

Run: `scripts/check-migration-naming.sh --against-ref origin/main && cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`
Expected: both PASS (the new file writes no rows, so it is not an offender).

- [ ] **Step 4: Apply against the worktree test stack**

Run: `pnpm test-stack up` (once for the wave), then `cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm db:migrate` twice.
Expected: second run is a no-op with no errors (idempotency).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-10-15-170000-service-deliverables.sql docs/superpowers/specs/billing/2026-09-10-service-deliverables-portal-design.md
git commit -m "feat(deliverables): service deliverable tables with shape-1 RLS (W01)"
```

---

### Task 2: Migrations 2 and 3 — `tickets.work_kind` and `organization_key_dates`

**Files:**
- Create: `apps/api/migrations/2026-10-15-170100-tickets-work-kind.sql`
- Create: `apps/api/migrations/2026-10-15-170200-organization-key-dates.sql`

**Interfaces:**
- Produces: enum `ticket_work_kind ('support','deliverable','project_task')`, column `tickets.work_kind NOT NULL DEFAULT 'support'`; enum `org_key_date_kind`; table `organization_key_dates`.

- [ ] **Step 1: Write migration 2**

```sql
-- tickets.work_kind (spec §4.8). Typed discriminator for planned work; replaces a tag string.
DO $$ BEGIN
  CREATE TYPE ticket_work_kind AS ENUM ('support','deliverable','project_task');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS work_kind ticket_work_kind NOT NULL DEFAULT 'support';
CREATE INDEX IF NOT EXISTS tickets_org_work_kind_idx ON tickets (org_id, work_kind) WHERE work_kind <> 'support';
```

- [ ] **Step 2: Write migration 3**

```sql
-- organization_key_dates (spec §4.5). Shape 1 RLS. DDL only.
DO $$ BEGIN
  CREATE TYPE org_key_date_kind AS ENUM ('insurance_renewal','vendor_contract_end','compliance_deadline','audit','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS organization_key_dates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  label VARCHAR(200) NOT NULL,
  kind org_key_date_kind NOT NULL DEFAULT 'other',
  date DATE NOT NULL,
  recurs_annually BOOLEAN NOT NULL DEFAULT FALSE,
  remind_days_before INTEGER,
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reminded_for_date DATE,
  reminder_ticket_id UUID,
  portal_visible BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  ALTER TABLE organization_key_dates ADD CONSTRAINT org_key_dates_reminder_ticket_org_fk
    FOREIGN KEY (reminder_ticket_id, org_id) REFERENCES tickets(id, org_id)
    ON DELETE SET NULL (reminder_ticket_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE organization_key_dates ADD CONSTRAINT org_key_dates_remind_chk
    CHECK (remind_days_before IS NULL OR remind_days_before >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS org_key_dates_org_date_idx ON organization_key_dates (org_id, date);

ALTER TABLE organization_key_dates ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_key_dates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON organization_key_dates;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON organization_key_dates;
DROP POLICY IF EXISTS breeze_org_isolation_update ON organization_key_dates;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON organization_key_dates;
CREATE POLICY breeze_org_isolation_select ON organization_key_dates FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON organization_key_dates FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON organization_key_dates FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON organization_key_dates FOR DELETE USING (public.breeze_has_org_access(org_id));
```

- [ ] **Step 3: Guards + apply twice**

Run: `scripts/check-migration-naming.sh --against-ref origin/main && cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts && pnpm db:migrate && pnpm db:migrate` (with the test-stack `DATABASE_URL`).
Expected: PASS, second migrate is a no-op.

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-10-15-170100-tickets-work-kind.sql apps/api/migrations/2026-10-15-170200-organization-key-dates.sql
git commit -m "feat(deliverables): tickets.work_kind and organization_key_dates (W01)"
```

---

### Task 3: Drizzle schema modules

**Files:**
- Create: `apps/api/src/db/schema/serviceDeliverables.ts`
- Create: `apps/api/src/db/schema/orgKeyDates.ts`
- Modify: `apps/api/src/db/schema/portal.ts` (tickets table, near `ticketSourceEnum` at line 8)
- Modify: `apps/api/src/db/schema/reports.ts:86-92` (`report_runs` table indexes)
- Modify: `apps/api/src/db/schema/index.ts:128` area (exports)

**Interfaces:**
- Produces (exact export names): `deliverableCadenceEnum`, `deliverableCompletionModeEnum`, `deliverableOccurrenceStatusEnum`, `deliverableEvidenceKindEnum`, `serviceDeliverables`, `serviceDeliverableOccurrences`, `serviceDeliverableEvidence`, `orgKeyDateKindEnum`, `organizationKeyDates`, `ticketWorkKindEnum`; column `tickets.workKind`.

- [ ] **Step 1: Write `serviceDeliverables.ts`**

```ts
import { pgTable, pgEnum, uuid, varchar, text, date, integer, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './orgs';
import { users } from './users';
import { contracts } from './contracts';
import { tickets } from './portal';
import { ticketCategories } from './tickets';
import { reports, reportRuns } from './reports';

export const deliverableCadenceEnum = pgEnum('deliverable_cadence', ['monthly', 'quarterly', 'semiannual', 'annual', 'one_time']);
export const deliverableCompletionModeEnum = pgEnum('deliverable_completion_mode', ['explicit', 'on_ticket_resolve']);
export const deliverableOccurrenceStatusEnum = pgEnum('deliverable_occurrence_status', ['scheduled', 'open', 'awaiting_evidence', 'delivered', 'missed', 'waived']);
export const deliverableEvidenceKindEnum = pgEnum('deliverable_evidence_kind', ['document', 'report_run']);

/** Spec §4.1. Org-owned; contract link optional (D1). Composite FKs are declared in SQL only
 *  (Drizzle cannot express DEFERRABLE); the single-column references here are for typing. */
export const serviceDeliverables = pgTable('service_deliverables', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  contractId: uuid('contract_id').references(() => contracts.id),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  cadence: deliverableCadenceEnum('cadence').notNull(),
  anchorDueDate: date('anchor_due_date').notNull(),
  effectiveFrom: date('effective_from').notNull(),
  effectiveUntil: date('effective_until'),
  leadDays: integer('lead_days').notNull().default(7),
  graceDays: integer('grace_days').notNull().default(14),
  artifactRequired: boolean('artifact_required').notNull().default(true),
  completionMode: deliverableCompletionModeEnum('completion_mode').notNull().default('on_ticket_resolve'),
  autoEvidenceReportId: uuid('auto_evidence_report_id').references(() => reports.id),
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  ticketCategoryId: uuid('ticket_category_id').references(() => ticketCategories.id, { onDelete: 'set null' }),
  portalVisible: boolean('portal_visible').notNull().default(true),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('service_deliverables_id_org_uq').on(t.id, t.orgId),
  uniqueIndex('service_deliverables_org_contract_name_uq').on(t.orgId, sql`COALESCE(${t.contractId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.name),
  index('service_deliverables_org_idx').on(t.orgId),
]);

/** Spec §4.2. UNIQUE (deliverable_id, period_start) is the sweep's idempotency claim. */
export const serviceDeliverableOccurrences = pgTable('service_deliverable_occurrences', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deliverableId: uuid('deliverable_id').notNull().references(() => serviceDeliverables.id, { onDelete: 'cascade' }),
  nameSnapshot: varchar('name_snapshot', { length: 200 }).notNull(),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  dueAt: date('due_at').notNull(),
  originalDueAt: date('original_due_at').notNull(),
  status: deliverableOccurrenceStatusEnum('status').notNull().default('scheduled'),
  ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  deliveredByUserId: uuid('delivered_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  deliveredVia: text('delivered_via').$type<'explicit' | 'ticket'>(),
  deliveryNote: text('delivery_note'),
  waivedAt: timestamp('waived_at', { withTimezone: true }),
  waivedByUserId: uuid('waived_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  waivedReason: text('waived_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('sd_occ_id_org_uq').on(t.id, t.orgId),
  uniqueIndex('sd_occ_deliverable_period_uq').on(t.deliverableId, t.periodStart),
  index('sd_occ_org_status_due_idx').on(t.orgId, t.status, t.dueAt),
]);

/** Spec §4.3. `document_id`'s FK to org_documents is added by W03. */
export const serviceDeliverableEvidence = pgTable('service_deliverable_evidence', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  occurrenceId: uuid('occurrence_id').notNull().references(() => serviceDeliverableOccurrences.id, { onDelete: 'cascade' }),
  kind: deliverableEvidenceKindEnum('kind').notNull(),
  documentId: uuid('document_id'),
  reportId: uuid('report_id').references(() => reports.id, { onDelete: 'cascade' }),
  reportRunId: uuid('report_run_id').references(() => reportRuns.id, { onDelete: 'cascade' }),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('sd_evidence_occurrence_idx').on(t.occurrenceId),
  index('sd_evidence_org_idx').on(t.orgId),
]);

export type ServiceDeliverableRow = typeof serviceDeliverables.$inferSelect;
export type ServiceDeliverableOccurrenceRow = typeof serviceDeliverableOccurrences.$inferSelect;
export type ServiceDeliverableEvidenceRow = typeof serviceDeliverableEvidence.$inferSelect;
```

Verified export names: `tickets` (`schema/portal.ts:104`), `ticketCategories` (`schema/tickets.ts:15`), `reports` (`schema/reports.ts:51`), `reportRuns` (`schema/reports.ts:96`).

- [ ] **Step 2: Write `orgKeyDates.ts`**

```ts
import { pgTable, pgEnum, uuid, varchar, text, date, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import { tickets } from './portal';

export const orgKeyDateKindEnum = pgEnum('org_key_date_kind', ['insurance_renewal', 'vendor_contract_end', 'compliance_deadline', 'audit', 'other']);

/** Spec §4.5. Typed org-level dates that drive reminders (W02) and the portal (W04). */
export const organizationKeyDates = pgTable('organization_key_dates', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  label: varchar('label', { length: 200 }).notNull(),
  kind: orgKeyDateKindEnum('kind').notNull().default('other'),
  date: date('date').notNull(),
  recursAnnually: boolean('recurs_annually').notNull().default(false),
  remindDaysBefore: integer('remind_days_before'),
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  remindedForDate: date('reminded_for_date'),
  reminderTicketId: uuid('reminder_ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
  portalVisible: boolean('portal_visible').notNull().default(false),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('org_key_dates_org_date_idx').on(t.orgId, t.date)]);

export type OrganizationKeyDateRow = typeof organizationKeyDates.$inferSelect;
```

- [ ] **Step 3: Add `workKind` to tickets and the report_runs unique index**

In `portal.ts`, next to `ticketSourceEnum`:

```ts
export const ticketWorkKindEnum = pgEnum('ticket_work_kind', ['support', 'deliverable', 'project_task']);
```

and in the `tickets` table definition, after `source`:

```ts
  // Spec §4.8 (service deliverables D3/D14): planned work is typed, not tagged.
  workKind: ticketWorkKindEnum('work_kind').notNull().default('support'),
```

In `reports.ts`, add to the `report_runs` table's index callback:

```ts
  reportRunsIdReportIdUniq: uniqueIndex('report_runs_id_report_id_uniq').on(table.id, table.reportId),
```

Add `export * from './serviceDeliverables'; export * from './orgKeyDates';` to `schema/index.ts` next to the contracts export.

- [ ] **Step 4: Typecheck and drift check**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json && pnpm db:check-drift` (test-stack `DATABASE_URL`).
Expected: no type errors; drift check reports no differences for the four tables and two columns. If drift names the COALESCE index expression, match the migration's expression text exactly.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema
git commit -m "feat(deliverables): drizzle schema for deliverables, key dates, tickets.work_kind (W01)"
```

---

### Task 4: Tenancy registrations

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`, ~line 228 onward)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`CORE_TENANT_EXPORT_POLICY`, ~line 41 onward)
- Modify: `apps/api/src/services/orgMergeRegistry.ts` (repoint list ~line 580 onward and the SPECIAL map)

- [ ] **Step 1: Cascade order**

Insert, alphabetically by `localeCompare`, `"organization_key_dates"`, `"service_deliverable_evidence"`, `"service_deliverable_occurrences"`, `"service_deliverables"`. Then confirm children precede parents: `service_deliverable_evidence` < `service_deliverable_occurrences` < `service_deliverables` (localeCompare orders `"service_deliverable_evidence"` before `"service_deliverable_occurrences"` because `e` < `o`, and both before `"service_deliverables"` because `_` sorts before `s` under localeCompare; the test asserts it, do not assume).

- [ ] **Step 2: Export policy**

Add entries (adjust `reports.ts`/`tickets` entries too):

```ts
  "organization_key_dates": tablePolicy("org_id", {"included":["id","org_id","label","kind","date","recurs_annually","remind_days_before","owner_user_id","reminded_for_date","reminder_ticket_id","portal_visible","notes","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
  "service_deliverable_evidence": tablePolicy("org_id", {"included":["id","org_id","occurrence_id","kind","document_id","report_id","report_run_id","created_by_user_id","created_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
  "service_deliverable_occurrences": tablePolicy("org_id", {"included":["id","org_id","deliverable_id","name_snapshot","period_start","period_end","due_at","original_due_at","status","ticket_id","delivered_at","delivered_by_user_id","delivered_via","delivery_note","waived_at","waived_by_user_id","waived_reason","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
  "service_deliverables": tablePolicy("org_id", {"included":["id","org_id","contract_id","name","description","cadence","anchor_due_date","effective_from","effective_until","lead_days","grace_days","artifact_required","completion_mode","auto_evidence_report_id","owner_user_id","ticket_category_id","portal_visible","active","sort_order","created_by","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

And append `"work_kind"` to the `tickets` entry's `included` array.

- [ ] **Step 3: Merge registry**

Add `"organization_key_dates"`, `"service_deliverable_evidence"`, `"service_deliverable_occurrences"` to the plain repoint list (alphabetical). Add to the SPECIAL map:

```ts
  service_deliverables: { kind: 'repoint-dedupe', key: ['contract_id', 'name'] }, // verified: service_deliverables_org_contract_name_uq (org_id, COALESCE(contract_id, nil), name)
```

(Check how other `repoint-dedupe` entries express a COALESCE key; if the engine cannot, use `kind: 'custom'` with a note and implement the dedupe in `orgMergeCustomExecutors.ts` by suffixing the loser's `name` with ` (merged)` on collision.)

- [ ] **Step 4: Run the four contract suites**

Run (test-stack up): `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts`
Expected: all PASS. A failure names the missing table or column; fix the registration, not the test.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts
git commit -m "chore(tenancy): register service deliverable and key date tables in cascade, export, merge (W01)"
```

---

### Task 5: `services/recurrence.ts` (pure)

**Files:**
- Create: `apps/api/src/services/recurrence.ts`
- Test: `apps/api/src/services/recurrence.test.ts`

**Interfaces:**
- Consumes: `addMonthsClamped(iso, months)`, `addDaysISO(iso, days)` from `./contractMath`.
- Produces:

```ts
export type Cadence = 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'one_time';
export function cadenceMonths(cadence: Cadence): number | null;            // one_time → null
export function coveredPeriod(dueAt: string, cadence: Cadence): { periodStart: string; periodEnd: string };
export function nthDueDate(anchorDueDate: string, cadence: Cadence, n: number): string | null; // n ≥ 0; one_time: n>0 → null
export interface PlanInput { anchorDueDate: string; cadence: Cadence; effectiveFrom: string; effectiveUntil: string | null; leadDays: number; graceDays: number; today: string; existingDueDates: readonly string[]; cap?: number }
export interface PlannedOccurrence { periodStart: string; periodEnd: string; dueAt: string; initialStatus: 'scheduled' | 'missed' }
export function planOccurrences(input: PlanInput): PlannedOccurrence[];
export function isInLeadWindow(dueAt: string, leadDays: number, today: string): boolean;  // dueAt − leadDays ≤ today
export function isPastGrace(dueAt: string, graceDays: number, today: string): boolean;    // dueAt + graceDays < today
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { cadenceMonths, coveredPeriod, nthDueDate, planOccurrences, isInLeadWindow, isPastGrace } from './recurrence';

describe('recurrence', () => {
  it('maps cadence to months', () => {
    expect(cadenceMonths('monthly')).toBe(1);
    expect(cadenceMonths('quarterly')).toBe(3);
    expect(cadenceMonths('semiannual')).toBe(6);
    expect(cadenceMonths('annual')).toBe(12);
    expect(cadenceMonths('one_time')).toBeNull();
  });

  it('clamps a 31st anchor to month ends', () => {
    expect(nthDueDate('2026-01-31', 'monthly', 1)).toBe('2026-02-28');
    expect(nthDueDate('2026-01-31', 'monthly', 2)).toBe('2026-03-31');
    expect(nthDueDate('2026-01-31', 'quarterly', 1)).toBe('2026-04-30');
  });

  it('one_time has a single due date', () => {
    expect(nthDueDate('2026-06-01', 'one_time', 0)).toBe('2026-06-01');
    expect(nthDueDate('2026-06-01', 'one_time', 1)).toBeNull();
  });

  it('covered period ends on the due date and spans one cadence', () => {
    expect(coveredPeriod('2026-03-31', 'monthly')).toEqual({ periodStart: '2026-03-01', periodEnd: '2026-03-31' });
    expect(coveredPeriod('2026-06-30', 'quarterly')).toEqual({ periodStart: '2026-04-01', periodEnd: '2026-06-30' });
    expect(coveredPeriod('2026-06-01', 'one_time')).toEqual({ periodStart: '2026-06-01', periodEnd: '2026-06-01' });
  });

  it('plans only occurrences inside the lead window and effective range', () => {
    const plan = planOccurrences({
      anchorDueDate: '2026-10-31', cadence: 'monthly', effectiveFrom: '2026-10-01', effectiveUntil: null,
      leadDays: 7, graceDays: 14, today: '2026-10-25', existingDueDates: [],
    });
    expect(plan).toEqual([{ periodStart: '2026-10-01', periodEnd: '2026-10-31', dueAt: '2026-10-31', initialStatus: 'scheduled' }]);
  });

  it('skips due dates already materialized', () => {
    const plan = planOccurrences({
      anchorDueDate: '2026-10-31', cadence: 'monthly', effectiveFrom: '2026-10-01', effectiveUntil: null,
      leadDays: 7, graceDays: 14, today: '2026-11-25', existingDueDates: ['2026-10-31'],
    });
    expect(plan.map((p) => p.dueAt)).toEqual(['2026-11-30']);
  });

  it('marks catch-up occurrences past grace as missed and caps at 12', () => {
    const plan = planOccurrences({
      anchorDueDate: '2025-01-31', cadence: 'monthly', effectiveFrom: '2025-01-01', effectiveUntil: null,
      leadDays: 7, graceDays: 14, today: '2026-10-25', existingDueDates: [],
    });
    expect(plan).toHaveLength(12);
    expect(plan[0]!.dueAt).toBe('2025-01-31');
    expect(plan[0]!.initialStatus).toBe('missed');
  });

  it('stops at effective_until', () => {
    const plan = planOccurrences({
      anchorDueDate: '2026-10-31', cadence: 'monthly', effectiveFrom: '2026-10-01', effectiveUntil: '2026-11-15',
      leadDays: 30, graceDays: 14, today: '2026-12-01', existingDueDates: [],
    });
    expect(plan.map((p) => p.dueAt)).toEqual(['2026-10-31']);
  });

  it('never plans a due date before effective_from', () => {
    const plan = planOccurrences({
      anchorDueDate: '2026-01-31', cadence: 'monthly', effectiveFrom: '2026-06-01', effectiveUntil: null,
      leadDays: 7, graceDays: 14, today: '2026-06-28', existingDueDates: [],
    });
    expect(plan.map((p) => p.dueAt)).toEqual(['2026-06-30']);
  });

  it('window predicates', () => {
    expect(isInLeadWindow('2026-10-31', 7, '2026-10-24')).toBe(true);
    expect(isInLeadWindow('2026-10-31', 7, '2026-10-23')).toBe(false);
    expect(isPastGrace('2026-10-31', 14, '2026-11-14')).toBe(false);
    expect(isPastGrace('2026-10-31', 14, '2026-11-15')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/recurrence.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import { addMonthsClamped, addDaysISO } from './contractMath';

export type Cadence = 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'one_time';

const MONTHS: Record<Exclude<Cadence, 'one_time'>, number> = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };

export function cadenceMonths(cadence: Cadence): number | null {
  return cadence === 'one_time' ? null : MONTHS[cadence];
}

export function nthDueDate(anchorDueDate: string, cadence: Cadence, n: number): string | null {
  if (n < 0) throw new RangeError('n must be >= 0');
  const months = cadenceMonths(cadence);
  if (months === null) return n === 0 ? anchorDueDate : null;
  // Always step from the anchor (not from the previous clamped date) so a 31st anchor
  // returns to the 31st in long months instead of drifting to the 28th forever.
  return addMonthsClamped(anchorDueDate, months * n);
}

export function coveredPeriod(dueAt: string, cadence: Cadence): { periodStart: string; periodEnd: string } {
  const months = cadenceMonths(cadence);
  if (months === null) return { periodStart: dueAt, periodEnd: dueAt };
  return { periodStart: addDaysISO(addMonthsClamped(dueAt, -months), 1), periodEnd: dueAt };
}

export function isInLeadWindow(dueAt: string, leadDays: number, today: string): boolean {
  return addDaysISO(dueAt, -leadDays) <= today;
}

export function isPastGrace(dueAt: string, graceDays: number, today: string): boolean {
  return addDaysISO(dueAt, graceDays) < today;
}

export interface PlanInput {
  anchorDueDate: string; cadence: Cadence; effectiveFrom: string; effectiveUntil: string | null;
  leadDays: number; graceDays: number; today: string; existingDueDates: readonly string[]; cap?: number;
}
export interface PlannedOccurrence { periodStart: string; periodEnd: string; dueAt: string; initialStatus: 'scheduled' | 'missed' }

/** Every due date d with effectiveFrom ≤ d ≤ effectiveUntil, d − leadDays ≤ today, not yet materialized; oldest first; capped. */
export function planOccurrences(input: PlanInput): PlannedOccurrence[] {
  const cap = input.cap ?? 12;
  const existing = new Set(input.existingDueDates);
  const out: PlannedOccurrence[] = [];
  for (let n = 0; out.length < cap; n++) {
    const due = nthDueDate(input.anchorDueDate, input.cadence, n);
    if (due === null) break;
    if (!isInLeadWindow(due, input.leadDays, input.today)) break;
    if (input.effectiveUntil !== null && due > input.effectiveUntil) break;
    if (due < input.effectiveFrom || existing.has(due)) continue;
    out.push({ ...coveredPeriod(due, input.cadence), dueAt: due, initialStatus: isPastGrace(due, input.graceDays, input.today) ? 'missed' : 'scheduled' });
  }
  return out;
}
```

Both helpers accept negative arguments: `addDaysISO` builds `Date.UTC(y, m-1, d+days)` (`contractMath.ts:62`) and `addMonthsClamped` normalises with `(zeroBased % 12 + 12) % 12` (`contractMath.ts:21-27`).

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/recurrence.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/recurrence.ts apps/api/src/services/recurrence.test.ts
git commit -m "feat(deliverables): pure recurrence module (W01)"
```

---

### Task 6: `services/serviceDeliverableState.ts` (pure state machine)

**Files:**
- Create: `apps/api/src/services/serviceDeliverableState.ts`
- Test: `apps/api/src/services/serviceDeliverableState.test.ts`

**Interfaces:**
- Produces:

```ts
export type OccurrenceStatus = 'scheduled' | 'open' | 'awaiting_evidence' | 'delivered' | 'missed' | 'waived';
export type OccurrenceEvent =
  | { type: 'open' }
  | { type: 'deliver'; hasEvidence: boolean; artifactRequired: boolean }
  | { type: 'evidence_added' }
  | { type: 'ticket_resolved'; hasEvidence: boolean; artifactRequired: boolean; completionMode: 'explicit' | 'on_ticket_resolve' }
  | { type: 'ticket_reopened'; deliveredVia: 'explicit' | 'ticket' | null }
  | { type: 'miss' }
  | { type: 'waive' }
  | { type: 'reopen' };
export type Transition = { next: OccurrenceStatus } | { next: null; reason: string };  // next null = no-op
export function transition(current: OccurrenceStatus, event: OccurrenceEvent): Transition;
export class InvalidTransitionError extends Error { constructor(current: OccurrenceStatus, event: OccurrenceEvent['type']) }
```

`transition` returns `{ next: null, reason }` for benign no-ops (idempotent sweep/subscriber events) and **throws** `InvalidTransitionError` for user actions that are illegal (e.g. `deliver` on `waived`).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { transition, InvalidTransitionError } from './serviceDeliverableState';

describe('occurrence state machine (spec §4.2)', () => {
  it('scheduled → open on open', () => expect(transition('scheduled', { type: 'open' })).toEqual({ next: 'open' }));
  it('open on open is a no-op', () => expect(transition('open', { type: 'open' }).next).toBeNull());

  it('deliver requires evidence when artifact_required', () => {
    expect(() => transition('open', { type: 'deliver', hasEvidence: false, artifactRequired: true })).toThrow(InvalidTransitionError);
    expect(transition('open', { type: 'deliver', hasEvidence: true, artifactRequired: true })).toEqual({ next: 'delivered' });
    expect(transition('open', { type: 'deliver', hasEvidence: false, artifactRequired: false })).toEqual({ next: 'delivered' });
  });

  it('missed → delivered (late) is allowed', () =>
    expect(transition('missed', { type: 'deliver', hasEvidence: true, artifactRequired: true })).toEqual({ next: 'delivered' }));

  it('ticket resolve with on_ticket_resolve: awaiting_evidence when evidence missing, delivered otherwise', () => {
    expect(transition('open', { type: 'ticket_resolved', hasEvidence: false, artifactRequired: true, completionMode: 'on_ticket_resolve' })).toEqual({ next: 'awaiting_evidence' });
    expect(transition('open', { type: 'ticket_resolved', hasEvidence: true, artifactRequired: true, completionMode: 'on_ticket_resolve' })).toEqual({ next: 'delivered' });
    expect(transition('open', { type: 'ticket_resolved', hasEvidence: false, artifactRequired: false, completionMode: 'on_ticket_resolve' })).toEqual({ next: 'delivered' });
  });

  it('ticket resolve with explicit mode changes nothing', () =>
    expect(transition('open', { type: 'ticket_resolved', hasEvidence: true, artifactRequired: false, completionMode: 'explicit' }).next).toBeNull());

  it('evidence_added completes awaiting_evidence only', () => {
    expect(transition('awaiting_evidence', { type: 'evidence_added' })).toEqual({ next: 'delivered' });
    expect(transition('open', { type: 'evidence_added' }).next).toBeNull();
  });

  it('ticket reopen undoes a ticket-driven delivery but never an explicit one', () => {
    expect(transition('delivered', { type: 'ticket_reopened', deliveredVia: 'ticket' })).toEqual({ next: 'open' });
    expect(transition('delivered', { type: 'ticket_reopened', deliveredVia: 'explicit' }).next).toBeNull();
  });

  it('miss applies to open and awaiting_evidence only', () => {
    expect(transition('open', { type: 'miss' })).toEqual({ next: 'missed' });
    expect(transition('awaiting_evidence', { type: 'miss' })).toEqual({ next: 'missed' });
    expect(transition('delivered', { type: 'miss' }).next).toBeNull();
  });

  it('waive from open, awaiting_evidence, missed; not from delivered', () => {
    expect(transition('missed', { type: 'waive' })).toEqual({ next: 'waived' });
    expect(() => transition('delivered', { type: 'waive' })).toThrow(InvalidTransitionError);
  });

  it('reopen from delivered or waived only', () => {
    expect(transition('delivered', { type: 'reopen' })).toEqual({ next: 'open' });
    expect(transition('waived', { type: 'reopen' })).toEqual({ next: 'open' });
    expect(() => transition('open', { type: 'reopen' })).toThrow(InvalidTransitionError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/serviceDeliverableState.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
export type OccurrenceStatus = 'scheduled' | 'open' | 'awaiting_evidence' | 'delivered' | 'missed' | 'waived';
export type OccurrenceEvent =
  | { type: 'open' }
  | { type: 'deliver'; hasEvidence: boolean; artifactRequired: boolean }
  | { type: 'evidence_added' }
  | { type: 'ticket_resolved'; hasEvidence: boolean; artifactRequired: boolean; completionMode: 'explicit' | 'on_ticket_resolve' }
  | { type: 'ticket_reopened'; deliveredVia: 'explicit' | 'ticket' | null }
  | { type: 'miss' }
  | { type: 'waive' }
  | { type: 'reopen' };
export type Transition = { next: OccurrenceStatus } | { next: null; reason: string };

export class InvalidTransitionError extends Error {
  readonly status = 409;
  readonly code = 'INVALID_OCCURRENCE_TRANSITION';
  constructor(readonly current: OccurrenceStatus, readonly event: OccurrenceEvent['type']) {
    super(`Cannot ${event} an occurrence in status ${current}`);
  }
}

const noop = (reason: string): Transition => ({ next: null, reason });
const ACTIVE: ReadonlySet<OccurrenceStatus> = new Set(['open', 'awaiting_evidence', 'missed']);

export function transition(current: OccurrenceStatus, event: OccurrenceEvent): Transition {
  switch (event.type) {
    case 'open':
      return current === 'scheduled' ? { next: 'open' } : noop('already opened');
    case 'deliver':
      if (!ACTIVE.has(current)) throw new InvalidTransitionError(current, event.type);
      if (event.artifactRequired && !event.hasEvidence) throw new InvalidTransitionError(current, event.type);
      return { next: 'delivered' };
    case 'evidence_added':
      return current === 'awaiting_evidence' ? { next: 'delivered' } : noop('evidence recorded, status unchanged');
    case 'ticket_resolved':
      if (event.completionMode === 'explicit') return noop('explicit completion mode');
      if (current !== 'open' && current !== 'missed') return noop('not open');
      return event.artifactRequired && !event.hasEvidence ? { next: 'awaiting_evidence' } : { next: 'delivered' };
    case 'ticket_reopened':
      return current === 'delivered' && event.deliveredVia === 'ticket' ? { next: 'open' } : noop('not a ticket-driven delivery');
    case 'miss':
      return current === 'open' || current === 'awaiting_evidence' ? { next: 'missed' } : noop('not missable');
    case 'waive':
      if (!ACTIVE.has(current)) throw new InvalidTransitionError(current, event.type);
      return { next: 'waived' };
    case 'reopen':
      if (current !== 'delivered' && current !== 'waived') throw new InvalidTransitionError(current, event.type);
      return { next: 'open' };
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/serviceDeliverableState.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/serviceDeliverableState.ts apps/api/src/services/serviceDeliverableState.test.ts
git commit -m "feat(deliverables): pure occurrence state machine (W01)"
```

---

### Task 7: Shared validators

**Files:**
- Create: `packages/shared/src/validators/serviceDeliverables.ts`, `packages/shared/src/validators/serviceDeliverables.test.ts`
- Create: `packages/shared/src/validators/orgKeyDates.ts`, `packages/shared/src/validators/orgKeyDates.test.ts`
- Modify: `packages/shared/src/validators/index.ts` (export both)

**Interfaces:**
- Produces (exact names): `deliverableCadenceSchema`, `createDeliverableSchema`, `updateDeliverableSchema`, `listDeliverablesQuerySchema`, `deliverOccurrenceSchema`, `waiveOccurrenceSchema`, `rescheduleOccurrenceSchema`, `addEvidenceSchema`, `listOccurrencesQuerySchema`; `createKeyDateSchema`, `updateKeyDateSchema`; and `z.infer` types `CreateDeliverableInput`, `UpdateDeliverableInput`, `DeliverOccurrenceInput`, `WaiveOccurrenceInput`, `RescheduleOccurrenceInput`, `AddEvidenceInput`, `CreateKeyDateInput`, `UpdateKeyDateInput`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { createDeliverableSchema, updateDeliverableSchema, deliverOccurrenceSchema, addEvidenceSchema, rescheduleOccurrenceSchema } from './serviceDeliverables';

const base = { name: 'Sign-in log review', cadence: 'monthly', anchorDueDate: '2026-10-31', effectiveFrom: '2026-10-01' };

describe('serviceDeliverables validators', () => {
  it('accepts a minimal create payload with defaults', () => {
    const r = createDeliverableSchema.parse(base);
    expect(r.leadDays).toBe(7); expect(r.graceDays).toBe(14); expect(r.artifactRequired).toBe(true);
    expect(r.completionMode).toBe('on_ticket_resolve'); expect(r.portalVisible).toBe(true);
  });
  it('rejects effectiveUntil before effectiveFrom', () =>
    expect(createDeliverableSchema.safeParse({ ...base, effectiveUntil: '2026-09-01' }).success).toBe(false));
  it('rejects unknown cadence and negative days', () => {
    expect(createDeliverableSchema.safeParse({ ...base, cadence: 'continuous' }).success).toBe(false);
    expect(createDeliverableSchema.safeParse({ ...base, leadDays: -1 }).success).toBe(false);
  });
  it('update forbids changing cadence (spec §16: history is not rewritten)', () =>
    expect(updateDeliverableSchema.safeParse({ cadence: 'annual' }).success).toBe(false));
  it('deliver accepts note and report-run evidence refs only in W01', () => {
    expect(deliverOccurrenceSchema.parse({ note: 'done', evidence: [{ kind: 'report_run', reportRunId: '11111111-1111-4111-8111-111111111111' }] }).evidence).toHaveLength(1);
    expect(deliverOccurrenceSchema.safeParse({ evidence: [{ kind: 'document', documentId: '11111111-1111-4111-8111-111111111111' }] }).success).toBe(false);
  });
  it('addEvidence requires a guid', () => expect(addEvidenceSchema.safeParse({ kind: 'report_run', reportRunId: 'nope' }).success).toBe(false));
  it('reschedule requires an ISO date', () => expect(rescheduleOccurrenceSchema.safeParse({ dueAt: '31/10/2026' }).success).toBe(false));
});
```

And for key dates:

```ts
import { describe, expect, it } from 'vitest';
import { createKeyDateSchema, updateKeyDateSchema } from './orgKeyDates';

describe('orgKeyDates validators', () => {
  it('accepts a renewal with reminder', () => {
    const r = createKeyDateSchema.parse({ label: 'Cyber insurance renewal', kind: 'insurance_renewal', date: '2027-03-01', recursAnnually: true, remindDaysBefore: 60 });
    expect(r.portalVisible).toBe(false);
  });
  it('rejects negative reminder days and bad dates', () => {
    expect(createKeyDateSchema.safeParse({ label: 'x', date: '2027-03-01', remindDaysBefore: -1 }).success).toBe(false);
    expect(createKeyDateSchema.safeParse({ label: 'x', date: 'March 1' }).success).toBe(false);
  });
  it('update is partial', () => expect(updateKeyDateSchema.parse({ notes: 'renewed' })).toEqual({ notes: 'renewed' }));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/shared && npx vitest run src/validators/serviceDeliverables.test.ts src/validators/orgKeyDates.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`serviceDeliverables.ts`:

```ts
import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const deliverableCadenceSchema = z.enum(['monthly', 'quarterly', 'semiannual', 'annual', 'one_time']);
export const deliverableCompletionModeSchema = z.enum(['explicit', 'on_ticket_resolve']);

const deliverableFields = {
  contractId: z.string().guid().nullable().optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  cadence: deliverableCadenceSchema,
  anchorDueDate: isoDate,
  effectiveFrom: isoDate,
  effectiveUntil: isoDate.nullable().optional(),
  leadDays: z.number().int().min(0).max(365).default(7),
  graceDays: z.number().int().min(0).max(365).default(14),
  artifactRequired: z.boolean().default(true),
  completionMode: deliverableCompletionModeSchema.default('on_ticket_resolve'),
  autoEvidenceReportId: z.string().guid().nullable().optional(),
  ownerUserId: z.string().guid().nullable().optional(),
  ticketCategoryId: z.string().guid().nullable().optional(),
  portalVisible: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
};
const effectiveRange = (d: { effectiveFrom?: string; effectiveUntil?: string | null }) =>
  d.effectiveUntil == null || d.effectiveFrom == null || d.effectiveUntil >= d.effectiveFrom;

export const createDeliverableSchema = z.object(deliverableFields).refine(effectiveRange, { message: 'effectiveUntil must be on or after effectiveFrom', path: ['effectiveUntil'] });
export const updateDeliverableSchema = z.object({
  ...Object.fromEntries(Object.entries(deliverableFields).filter(([k]) => !['cadence', 'anchorDueDate'].includes(k)).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])),
  active: z.boolean().optional(),
}).strict().refine(effectiveRange, { message: 'effectiveUntil must be on or after effectiveFrom', path: ['effectiveUntil'] });
export const listDeliverablesQuerySchema = z.object({
  contractId: z.string().guid().optional(),
  includeInactive: z.coerce.boolean().optional(),
});

export const reportRunEvidenceRefSchema = z.object({ kind: z.literal('report_run'), reportRunId: z.string().guid() });
// W03 widens this union with { kind: 'document', documentId }.
export const evidenceRefSchema = z.discriminatedUnion('kind', [reportRunEvidenceRefSchema]);
export const addEvidenceSchema = evidenceRefSchema;
export const deliverOccurrenceSchema = z.object({ note: z.string().max(4000).optional(), evidence: z.array(evidenceRefSchema).max(20).optional() });
export const waiveOccurrenceSchema = z.object({ reason: z.string().min(1).max(2000) });
export const rescheduleOccurrenceSchema = z.object({ dueAt: isoDate });
export const listOccurrencesQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(24) });

export type CreateDeliverableInput = z.infer<typeof createDeliverableSchema>;
export type UpdateDeliverableInput = z.infer<typeof updateDeliverableSchema>;
export type DeliverOccurrenceInput = z.infer<typeof deliverOccurrenceSchema>;
export type WaiveOccurrenceInput = z.infer<typeof waiveOccurrenceSchema>;
export type RescheduleOccurrenceInput = z.infer<typeof rescheduleOccurrenceSchema>;
export type AddEvidenceInput = z.infer<typeof addEvidenceSchema>;
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
```

If the `Object.fromEntries` construction fights the type-checker, write `updateDeliverableSchema` out longhand with each field `.optional()`; readability beats cleverness here.

`orgKeyDates.ts`:

```ts
import { z } from 'zod';
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const keyDateKindSchema = z.enum(['insurance_renewal', 'vendor_contract_end', 'compliance_deadline', 'audit', 'other']);
export const createKeyDateSchema = z.object({
  label: z.string().min(1).max(200),
  kind: keyDateKindSchema.default('other'),
  date: isoDate,
  recursAnnually: z.boolean().default(false),
  remindDaysBefore: z.number().int().min(0).max(365).nullable().optional(),
  ownerUserId: z.string().guid().nullable().optional(),
  portalVisible: z.boolean().default(false),
  notes: z.string().max(4000).nullable().optional(),
});
export const updateKeyDateSchema = createKeyDateSchema.partial().strict();
export type CreateKeyDateInput = z.infer<typeof createKeyDateSchema>;
export type UpdateKeyDateInput = z.infer<typeof updateKeyDateSchema>;
```

Export both from `packages/shared/src/validators/index.ts`.

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/shared && npx vitest run src/validators/serviceDeliverables.test.ts src/validators/orgKeyDates.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators
git commit -m "feat(shared): service deliverable and key date validators (W01)"
```

---

### Task 8: `serviceDeliverableService.ts`

**Files:**
- Create: `apps/api/src/services/serviceDeliverableService.ts`
- Test: `apps/api/src/services/serviceDeliverableService.test.ts`

**Interfaces:**
- Consumes: schema from Task 3, `transition` from Task 6, `coveredPeriod` from Task 5, validators from Task 7.
- Produces (exact signatures; W02–W05 import these):

```ts
export interface DeliverableActor { userId: string | null; partnerId: string | null; accessibleOrgIds: string[] | null }
export class DeliverableServiceError extends Error { constructor(message: string, readonly status: number, readonly code: string, readonly details?: unknown) }

export function listDeliverables(orgId: string, q: { contractId?: string; includeInactive?: boolean }, actor: DeliverableActor): Promise<DeliverableSummary[]>;
export function getDeliverable(orgId: string, id: string, actor: DeliverableActor): Promise<DeliverableSummary>;
export function createDeliverable(orgId: string, input: CreateDeliverableInput, actor: DeliverableActor): Promise<ServiceDeliverableRow>;
export function updateDeliverable(orgId: string, id: string, patch: UpdateDeliverableInput, actor: DeliverableActor): Promise<ServiceDeliverableRow>;
export function deactivateDeliverable(orgId: string, id: string, actor: DeliverableActor): Promise<void>;   // sets active=false
export function listOccurrences(orgId: string, deliverableId: string, q: { limit: number }, actor: DeliverableActor): Promise<OccurrenceView[]>;
export function deliverOccurrence(orgId: string, occurrenceId: string, input: DeliverOccurrenceInput, actor: DeliverableActor): Promise<OccurrenceView>;
export function waiveOccurrence(orgId: string, occurrenceId: string, input: WaiveOccurrenceInput, actor: DeliverableActor): Promise<OccurrenceView>;
export function reopenOccurrence(orgId: string, occurrenceId: string, actor: DeliverableActor): Promise<OccurrenceView>;
export function rescheduleOccurrence(orgId: string, occurrenceId: string, input: RescheduleOccurrenceInput, actor: DeliverableActor): Promise<OccurrenceView>;
export function addEvidence(orgId: string, occurrenceId: string, ref: EvidenceRef, actor: DeliverableActor): Promise<OccurrenceView>;
export function removeEvidence(orgId: string, occurrenceId: string, evidenceId: string, actor: DeliverableActor): Promise<OccurrenceView>;

// Reserved for W02 (system callers, no actor; run inside withSystemDbAccessContext). Declared here as
// exported stubs that throw 'not implemented (W02)' so W02 replaces bodies, not names:
export function materializeOccurrences(deliverableId: string, today: string): Promise<ServiceDeliverableOccurrenceRow[]>;
export function openOccurrence(occurrenceId: string, ticketId: string | null): Promise<void>;
export function markOccurrenceMissed(occurrenceId: string): Promise<void>;
export function applyTicketStatusChange(args: { ticketId: string; orgId: string; to: string; actorUserId: string | null; resolutionNote: string | null }): Promise<void>;

export interface DeliverableSummary extends ServiceDeliverableRow { contractName: string | null; nextDue: string | null; lastDelivered: { at: string; late: boolean; note: string | null } | null; openCount: number; status: 'on_track' | 'due_soon' | 'late' | 'missed' | 'inactive' }
export interface OccurrenceView extends ServiceDeliverableOccurrenceRow { late: boolean; evidence: Array<{ id: string; kind: 'document' | 'report_run'; documentId: string | null; reportId: string | null; reportRunId: string | null; createdAt: string }> }
```

Rules the service enforces (each has a test):

- `requireOrgAccess(actor, orgId)` → 404 `NOT_FOUND` on foreign org.
- `contractId` must belong to `orgId` (select `contracts` where `id` and `orgId`) → 400 `CONTRACT_NOT_IN_ORG`.
- `ownerUserId` must exist and hold access to the org's partner (`users.partnerId = organizations.partnerId`) → 400 `OWNER_NOT_ALLOWED`. `ticketCategoryId` must belong to the org's partner → 400 `CATEGORY_NOT_ALLOWED`.
- `autoEvidenceReportId` must be a `reports` row of the org → 404 `NOT_FOUND`.
- Duplicate `(org, contract, name)` → 409 `DUPLICATE_NAME`.
- `addEvidence` with `report_run`: the run's `report_id` must be a report of the org → 404 `NOT_FOUND` (never 403); stores `reportId` alongside `reportRunId`.
- `deliverOccurrence`: insert evidence refs first, then `transition(current, {type:'deliver', hasEvidence, artifactRequired})`; `InvalidTransitionError` with missing evidence → 400 `EVIDENCE_REQUIRED`; other invalid → 409 `INVALID_OCCURRENCE_TRANSITION`. Sets `deliveredAt=now`, `deliveredByUserId=actor.userId`, `deliveredVia='explicit'`, `deliveryNote`.
- `addEvidence` on `awaiting_evidence` runs `transition(current, {type:'evidence_added'})` and, on `delivered`, stamps `deliveredVia='ticket'` (the ticket resolution started it).
- `waive` stamps `waivedAt`, `waivedByUserId`, `waivedReason`; `reopen` clears all delivery and waiver fields.
- `reschedule` only on `scheduled | open | awaiting_evidence | missed`; keeps `originalDueAt`; recomputes `status` to `open` if it was `missed` and the new due date is not past grace.
- `DeliverableSummary.status`: `inactive` when `!active` or today outside the effective range; else `missed` if any occurrence is `missed`; `late` if any `open|awaiting_evidence` past `dueAt`; `due_soon` if any open within lead window; else `on_track`.

- [ ] **Step 1: Write the failing tests**

Use the Drizzle mock pattern from the `breeze-testing` skill (chainable `select/from/where/limit` mocks via `vi.hoisted`). Cover at minimum:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({ rows: [] as unknown[], inserted: [] as unknown[], updated: [] as unknown[] }));
vi.mock('../db', () => {
  const chain = () => {
    const c: any = {};
    for (const m of ['select', 'from', 'where', 'limit', 'orderBy', 'innerJoin', 'leftJoin', 'insert', 'values', 'update', 'set', 'delete', 'returning']) {
      c[m] = vi.fn(() => c);
    }
    c.then = (res: (v: unknown) => void) => res(dbMocks.rows.shift() ?? []);
    return c;
  };
  return { db: chain(), withDbAccessContext: (_: unknown, fn: () => unknown) => fn() };
});
import { createDeliverable, deliverOccurrence, DeliverableServiceError } from './serviceDeliverableService';

const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
const base = { name: 'Sign-in log review', cadence: 'monthly' as const, anchorDueDate: '2026-10-31', effectiveFrom: '2026-10-01', leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve' as const, portalVisible: true, sortOrder: 0 };

describe('serviceDeliverableService', () => {
  beforeEach(() => { dbMocks.rows.length = 0; });

  it('404s a foreign org without touching the db', async () => {
    await expect(createDeliverable('org2', base, actor)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('rejects a contract from another org', async () => {
    dbMocks.rows.push([]); // contract lookup returns nothing
    await expect(createDeliverable('org1', { ...base, contractId: '11111111-1111-4111-8111-111111111111' }, actor))
      .rejects.toMatchObject({ status: 400, code: 'CONTRACT_NOT_IN_ORG' });
  });

  it('deliver without required evidence → 400 EVIDENCE_REQUIRED', async () => {
    dbMocks.rows.push([{ id: 'o1', orgId: 'org1', status: 'open', deliverableId: 'd1', artifactRequired: true }]); // occurrence+deliverable join
    dbMocks.rows.push([]); // evidence count
    await expect(deliverOccurrence('org1', 'o1', {}, actor)).rejects.toMatchObject({ status: 400, code: 'EVIDENCE_REQUIRED' });
  });
});
```

Add tests for `DUPLICATE_NAME` (unique violation `23505` mapped to 409), `waive` requires reason, `reopen` clears fields, `reschedule` on `waived` → 409, `addEvidence` with a run of another org's report → 404, `removeEvidence` on `delivered` with `artifactRequired` leaving zero evidence → 409 `EVIDENCE_REQUIRED` (delivery would become unsupported), summary `status` derivation (pure helper `summarizeStatus(...)` exported for testing).

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/serviceDeliverableService.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the service**

Skeleton (fill every function; no TODOs):

```ts
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { serviceDeliverables, serviceDeliverableOccurrences, serviceDeliverableEvidence, type ServiceDeliverableRow, type ServiceDeliverableOccurrenceRow } from '../db/schema/serviceDeliverables';
import { contracts } from '../db/schema/contracts';
import { organizations } from '../db/schema/orgs';
import { users } from '../db/schema/users';
import { reports, reportRuns } from '../db/schema/reports';
import { ticketCategories } from '../db/schema/portal';
import type { CreateDeliverableInput, UpdateDeliverableInput, DeliverOccurrenceInput, WaiveOccurrenceInput, RescheduleOccurrenceInput, EvidenceRef } from '@breeze/shared';
import { transition, InvalidTransitionError, type OccurrenceStatus } from './serviceDeliverableState';
import { isInLeadWindow, isPastGrace } from './recurrence';

export interface DeliverableActor { userId: string | null; partnerId: string | null; accessibleOrgIds: string[] | null }
export class DeliverableServiceError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly details?: unknown) { super(message); }
}
function requireOrgAccess(actor: DeliverableActor, orgId: string): void {
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(orgId)) throw new DeliverableServiceError('Not found', 404, 'NOT_FOUND');
}
const todayISO = () => new Date().toISOString().slice(0, 10);

export function summarizeStatus(d: { active: boolean; effectiveFrom: string; effectiveUntil: string | null; leadDays: number }, occ: Array<{ status: OccurrenceStatus; dueAt: string }>, today = todayISO()): DeliverableSummary['status'] {
  if (!d.active || today < d.effectiveFrom || (d.effectiveUntil !== null && today > d.effectiveUntil)) return 'inactive';
  if (occ.some((o) => o.status === 'missed')) return 'missed';
  const open = occ.filter((o) => o.status === 'open' || o.status === 'awaiting_evidence');
  if (open.some((o) => o.dueAt < today)) return 'late';
  if (open.some((o) => isInLeadWindow(o.dueAt, d.leadDays, today))) return 'due_soon';
  return 'on_track';
}
// … listDeliverables / getDeliverable / createDeliverable / updateDeliverable / deactivateDeliverable
// … listOccurrences / loadOccurrence (joins deliverable for artifactRequired + completionMode; 404 if org mismatch)
// … deliverOccurrence / waiveOccurrence / reopenOccurrence / rescheduleOccurrence / addEvidence / removeEvidence
// … W02 stubs:
export async function materializeOccurrences(_deliverableId: string, _today: string): Promise<ServiceDeliverableOccurrenceRow[]> { throw new Error('not implemented (W02)'); }
export async function openOccurrence(_occurrenceId: string, _ticketId: string | null): Promise<void> { throw new Error('not implemented (W02)'); }
export async function markOccurrenceMissed(_occurrenceId: string): Promise<void> { throw new Error('not implemented (W02)'); }
export async function applyTicketStatusChange(_args: { ticketId: string; orgId: string; to: string; actorUserId: string | null; resolutionNote: string | null }): Promise<void> { throw new Error('not implemented (W02)'); }
```

Map Postgres unique violations (`err.code === '23505'`) on `service_deliverables_org_contract_name_uq` to 409 `DUPLICATE_NAME`. Every write of an occurrence also sets `updatedAt: new Date()`. Mutations that touch two tables (deliver = evidence insert + occurrence update) run in `db.transaction`.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/serviceDeliverableService.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/serviceDeliverableService.ts apps/api/src/services/serviceDeliverableService.test.ts
git commit -m "feat(deliverables): deliverable and occurrence service (W01)"
```

---

### Task 9: `orgKeyDateService.ts`

**Files:**
- Create: `apps/api/src/services/orgKeyDateService.ts`
- Test: `apps/api/src/services/orgKeyDateService.test.ts`

**Interfaces:**
- Produces:

```ts
export interface KeyDateView { source: 'key_date' | 'contract_end'; id: string; label: string; kind: string; date: string; recursAnnually: boolean; remindDaysBefore: number | null; ownerUserId: string | null; portalVisible: boolean; notes: string | null; contractId: string | null }
export function listKeyDates(orgId: string, actor: DeliverableActor, opts?: { includeContractEnds?: boolean }): Promise<KeyDateView[]>;  // sorted by date asc
export function createKeyDate(orgId: string, input: CreateKeyDateInput, actor: DeliverableActor): Promise<OrganizationKeyDateRow>;
export function updateKeyDate(orgId: string, id: string, patch: UpdateKeyDateInput, actor: DeliverableActor): Promise<OrganizationKeyDateRow>;
export function deleteKeyDate(orgId: string, id: string, actor: DeliverableActor): Promise<void>;
```

Contract-end rows: `source='contract_end'`, `id=contract.id`, `label=contract.name`, `kind='contract_end'`, `date=contract.endDate`, only where `endDate >= today` and `status NOT IN ('draft','cancelled')`, `portalVisible=true`.

- [ ] **Step 1: Failing tests** — foreign org 404; `listKeyDates` unions and sorts contract ends; `updateKeyDate` clearing the date rejects (date is required); `deleteKeyDate` of a missing id → 404.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/orgKeyDateService.test.ts` → FAIL.
- [ ] **Step 3: Implement** with the same `requireOrgAccess` and `DeliverableServiceError` (import from `serviceDeliverableService.ts`).
- [ ] **Step 4: Run** → PASS; `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `git commit -m "feat(deliverables): org key date service (W01)"`.

---

### Task 10: REST routes and mounting

**Files:**
- Create: `apps/api/src/routes/serviceDeliverables.ts`, `apps/api/src/routes/serviceDeliverables.test.ts`
- Create: `apps/api/src/routes/contracts/deliverables.ts`, `apps/api/src/routes/contracts/deliverables.test.ts`
- Create: `apps/api/src/routes/orgKeyDates.ts`, `apps/api/src/routes/orgKeyDates.test.ts`
- Modify: `apps/api/src/routes/contracts/index.ts` (mount `contractDeliverableRoutes` before `/:id` catch-alls)
- Modify: `apps/api/src/index.ts:834-837` (add `api.route('/orgs', serviceDeliverableRoutes); api.route('/orgs', orgKeyDateRoutes);`)

**Interfaces:**
- Produces routes (all `requireScope('partner','system')`, permissions `contracts:read` for GET and `contracts:write` for mutations; every response `{ data }`):

```
GET    /orgs/:orgId/deliverables?contractId&includeInactive
POST   /orgs/:orgId/deliverables
GET    /orgs/:orgId/deliverables/:id
PATCH  /orgs/:orgId/deliverables/:id
DELETE /orgs/:orgId/deliverables/:id              (deactivate; 200 {data:{ok:true}})
GET    /orgs/:orgId/deliverables/:id/occurrences?limit
POST   /orgs/:orgId/deliverables/occurrences/:oId/deliver
POST   /orgs/:orgId/deliverables/occurrences/:oId/waive
POST   /orgs/:orgId/deliverables/occurrences/:oId/reopen
POST   /orgs/:orgId/deliverables/occurrences/:oId/reschedule
POST   /orgs/:orgId/deliverables/occurrences/:oId/evidence
DELETE /orgs/:orgId/deliverables/occurrences/:oId/evidence/:eId
GET    /contracts/:id/deliverables                 (resolves the contract's org, then listDeliverables(orgId,{contractId}))
GET    /orgs/:orgId/key-dates
POST   /orgs/:orgId/key-dates
PATCH  /orgs/:orgId/key-dates/:id
DELETE /orgs/:orgId/key-dates/:id
```

Actor construction: copy `contractActorFrom` shape from `routes/contracts/contracts.ts:36-51` into a local `deliverableActorFrom(c)` returning `{ userId, partnerId, accessibleOrgIds }`. Error handler: `DeliverableServiceError` → `c.json({ error, code, details? }, status)`; `InvalidTransitionError` → 409; rethrow others.

- [ ] **Step 1: Write the failing route tests** following `apps/api/src/routes/contracts/periods.test.ts` (mock `../middleware/auth`, hoist service mocks, assert 401 / 403 / 404-cross-tenant / 200 envelope / 400 on invalid body / 409 mapping). One test per route minimum; for `deliver` assert the body is validated by `deliverOccurrenceSchema` (a `document` evidence kind → 400).
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/routes/serviceDeliverables.test.ts src/routes/contracts/deliverables.test.ts src/routes/orgKeyDates.test.ts` → FAIL.
- [ ] **Step 3: Implement the three routers and mount them.** Keep each handler to `try { return c.json({ data: await svc(...) }) } catch (err) { return handleDeliverableError(c, err) }`.
- [ ] **Step 4: Run** the three route tests and `npx tsc --noEmit` → PASS. Boot the API against the test stack (`pnpm --filter @breeze/api dev` with `.env.test`) and `curl -sf -H "Authorization: Bearer <partner token>" localhost:3001/api/v1/orgs/<orgId>/deliverables` → `{"data":[]}`.
- [ ] **Step 5: Commit** `git commit -m "feat(deliverables): REST routes for deliverables, occurrences, key dates (W01)"`.

---

### Task 11: Integration test — RLS, deferrable FKs, evidence ownership

**Files:**
- Create: `apps/api/src/__tests__/integration/serviceDeliverablesRls.integration.test.ts`

Follow the header pattern of the existing `*Rls.integration.test.ts` files (`import './setup'`, `createPartner`, `createOrganization`, `createUser`, `withDbAccessContext(orgContext(orgId), …)`).

- [ ] **Step 1: Write the tests**

1. **Cross-org forge**: as org A's context, `INSERT INTO service_deliverables (org_id, …) VALUES (<org B>, …)` → rejects with SQLSTATE `42501`. Repeat for occurrences, evidence and key dates.
2. **Cross-org read**: org B inserts a deliverable under system context; org A's context `SELECT count(*)` → 0.
3. **Positive control**: org A inserts and reads back its own row (1 row), so the forge test cannot pass vacuously.
4. **Evidence ownership chain**: report R_B belongs to org B with run RR_B; as system context, `INSERT INTO service_deliverable_evidence (org_id=A, occurrence_id=<A's occurrence>, kind='report_run', report_id=R_B, report_run_id=RR_B)` → rejects with `23503` (composite FK `(report_id, org_id) → reports(id, org_id)`).
5. **Deferrable re-point** (merge contract): under system context in one transaction, `SET CONSTRAINTS ALL DEFERRED`, update `organizations`-side rows and the child `org_id` in separate statements, commit → succeeds. Mirror the shape used by `orgLifecycleFoundations.integration.test.ts` for one FK.
6. **Cascade**: deleting a deliverable removes its occurrences and evidence (`ON DELETE CASCADE`).

- [ ] **Step 2: Run** `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/serviceDeliverablesRls.integration.test.ts` → PASS. Confirm in the output that 6 tests ran (a `0 tests` line is a stall, not green).
- [ ] **Step 3: Commit** `git commit -m "test(deliverables): RLS, deferrable FK and evidence ownership integration suite (W01)"`.

---

### Task 12: Web API clients and i18n namespace

**Files:**
- Create: `apps/web/src/lib/api/serviceDeliverables.ts`, `apps/web/src/lib/api/orgKeyDates.ts`
- Create: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/deliverables.json`

**Interfaces:**
- Produces (web): types `Deliverable` (= `DeliverableSummary` JSON), `Occurrence` (= `OccurrenceView` JSON), `KeyDate` (= `KeyDateView`); functions taking an `OrgFetch`-compatible fetcher as the first argument so both the contract page (`fetchWithAuth`) and the org record (`orgFetch`) can use them:

```ts
export type Fetcher = (path: string, init?: RequestInit & { orgIdOverride?: string }) => Promise<Response>;
export function listDeliverables(f: Fetcher, orgId: string, q?: { contractId?: string; includeInactive?: boolean }): Promise<Deliverable[]>;
export function createDeliverable(f: Fetcher, orgId: string, body: CreateDeliverableInput): Promise<Deliverable>;
export function updateDeliverable(f: Fetcher, orgId: string, id: string, body: UpdateDeliverableInput): Promise<Deliverable>;
export function deactivateDeliverable(f: Fetcher, orgId: string, id: string): Promise<void>;
export function listOccurrences(f: Fetcher, orgId: string, deliverableId: string, limit?: number): Promise<Occurrence[]>;
export function deliverOccurrence(f: Fetcher, orgId: string, oId: string, body: DeliverOccurrenceInput): Promise<Occurrence>;
export function waiveOccurrence(f: Fetcher, orgId: string, oId: string, body: WaiveOccurrenceInput): Promise<Occurrence>;
export function reopenOccurrence(f: Fetcher, orgId: string, oId: string): Promise<Occurrence>;
export function rescheduleOccurrence(f: Fetcher, orgId: string, oId: string, body: RescheduleOccurrenceInput): Promise<Occurrence>;
export function addEvidence(f: Fetcher, orgId: string, oId: string, body: AddEvidenceInput): Promise<Occurrence>;
export function removeEvidence(f: Fetcher, orgId: string, oId: string, eId: string): Promise<Occurrence>;
// orgKeyDates.ts
export function listKeyDates(f, orgId): Promise<KeyDate[]>; createKeyDate(f, orgId, body); updateKeyDate(f, orgId, id, body); deleteKeyDate(f, orgId, id);
```

Each function throws `new ActionError(...)` (from `apps/web/src/lib/runAction.ts`) on `!res.ok`, following `lib/api/contractDocuments.ts`.

- [ ] **Step 1: Write the clients** (no test file needed for thin wrappers; they are exercised by component tests in Tasks 13–14).
- [ ] **Step 2: Write `en/deliverables.json`** with keys: `section.title`, `section.empty`, `table.name`, `table.cadence`, `table.nextDue`, `table.lastDelivered`, `table.status`, `table.portal`, `cadence.monthly|quarterly|semiannual|annual|one_time`, `status.on_track|due_soon|late|missed|inactive`, `occurrence.status.scheduled|open|awaiting_evidence|delivered|missed|waived`, `actions.add|edit|deactivate|deliver|waive|reopen|reschedule|addEvidence|removeEvidence|save|cancel`, `form.*` labels for every deliverable field, `drawer.title`, `drawer.evidence`, `drawer.noEvidence`, `drawer.late`, `drawer.rescheduledFrom`, `errors.evidenceRequired`, `errors.duplicateName`, `keyDates.title|empty|add|label|kind|date|recursAnnually|remindDaysBefore|portalVisible|contractEnd`, `keyDates.kind.insurance_renewal|vendor_contract_end|compliance_deadline|audit|other`, `toast.saved|delivered|waived|reopened|rescheduled|evidenceAdded|deactivated`.
- [ ] **Step 3: Translate into the seven other locales** with real translations (not English copies); keep product nouns (`Breeze`) untranslated. Consult `apps/web/src/locales/TERMINOLOGY.md` for fixed terms.
- [ ] **Step 4: Run** `cd apps/web && npx vitest run src/lib/i18n` → PASS (parity + coverage).
- [ ] **Step 5: Commit** `git commit -m "feat(web): deliverables API clients and i18n namespace (W01)"`.

---

### Task 13: Shared MSP components and the contract section

**Files:**
- Create: `apps/web/src/components/deliverables/DeliverableTable.tsx`, `DeliverableForm.tsx`, `OccurrenceDrawer.tsx`, `DeliverableTable.test.tsx`, `OccurrenceDrawer.test.tsx`
- Create: `apps/web/src/components/contracts/ContractDeliverablesSection.tsx`, `ContractDetail.deliverables.test.tsx`
- Modify: `apps/web/src/components/contracts/ContractDetail.tsx:482` (render `<ContractDeliverablesSection contractId={contract.id} orgId={contract.orgId} />` directly after `ContractDocumentsSection`)

**Interfaces:**
- `DeliverableTable({ fetcher, orgId, contractId?, onSelect(deliverable) })` renders `Deliverable[]` with name, cadence, next due, last delivered (date + "late" pill), status pill, portal toggle (PATCH `portalVisible`), row actions edit / deactivate.
- `DeliverableForm({ fetcher, orgId, contractId?, initial?: Deliverable, onSaved, onCancel })` create/edit; `cadence` and `anchorDueDate` disabled in edit mode.
- `OccurrenceDrawer({ fetcher, orgId, deliverable, onClose })` lists `listOccurrences` (24) with status, period, due, evidence chips; actions Deliver (note + optional report-run id picker fed by `GET /reports/runs?orgId=` if that endpoint exists, else a plain guid input), Waive (reason required), Reopen, Reschedule (date input), Remove evidence. Every action via `runAction`.

- [ ] **Step 1: Write failing component tests** (Testing Library, mock `fetchWithAuth` as in `ContractDetail.documents.test.tsx`):
  - table renders rows and status pills from a mocked list; deactivate calls `DELETE …/deliverables/:id` through `runAction` and shows the toast;
  - drawer: Deliver with `artifactRequired` and no evidence surfaces the 400 `EVIDENCE_REQUIRED` message from the response (not a generic error); Waive disables Save until a reason is typed;
  - `ContractDetail` renders the section under the documents section with the contract's `orgId` passed through.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/deliverables src/components/contracts/ContractDetail.deliverables.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the components with the repo's Tailwind + `rounded-lg border bg-card` conventions; `data-testid` on the section root (`contract-deliverables`), table (`deliverables-table`), drawer (`occurrence-drawer`) and each action button.
- [ ] **Step 4: Run** the tests, then `npx vitest run src/lib/__tests__/no-silent-mutations.test.ts` and `npx astro check` (the web package has no `typecheck` script; `astro check` is what CI runs) → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(web): deliverables table, form, occurrence drawer; contract section (W01)"`.

---

### Task 14: Org record Service tab and Key dates card

**Files:**
- Create: `apps/web/src/components/organizations/record/OrgServiceTab.tsx`, `OrgServiceTab.test.tsx`, `OrgKeyDatesCard.tsx`, `OrgKeyDatesCard.test.tsx`
- Modify: `apps/web/src/components/organizations/record/orgRecordTabs.ts` (add `'service'` after `'billing'`, `TAB_PERMISSION.service = [{ resource: 'contracts', action: 'read' }]`)
- Modify: `apps/web/src/components/organizations/record/OrganizationRecordPage.tsx:305` (add `{effectiveTab === 'service' && <OrgServiceTab orgId={orgId} orgFetch={orgFetch} />}`)
- Modify: `apps/web/src/components/organizations/record/OrgOverviewTab.tsx:238` (add `<OrgKeyDatesCard orgId={orgId} orgFetch={orgFetch} />` as a third section in the two-column grid)
- Modify: `apps/web/src/locales/*/organizations.json` (tab label `tabs.service`)

**Interfaces:**
- `OrgServiceTab({ orgId, orgFetch })`: `DeliverableTable` for the whole org (no `contractId`; rows grouped by `contractName`, standalone rows under a "No contract" group), an "Add deliverable" button opening `DeliverableForm` with an optional contract picker (`GET /contracts?orgId=`), and an "Upcoming 90 days" list built from each deliverable's `nextDue`.
- `OrgKeyDatesCard({ orgId, orgFetch })`: list from `listKeyDates` (contract ends rendered read-only with a "contract" pill), add/edit inline form, delete with confirm; all via `runAction`.

- [ ] **Step 1: Failing tests**: tab registry test (pin `ORG_RECORD_TABS` includes `'service'` in order and `TAB_PERMISSION.service` gates on `contracts:read`; extend the existing `orgRecordTabs.test.ts` if present); `OrgServiceTab` groups rows by contract; `OrgKeyDatesCard` renders contract-end rows without edit controls and creates a key date through `orgFetch` (assert the mocked `orgFetch` was called, not `fetchWithAuth`).
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/organizations/record` → FAIL on the new files.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the record tests, `src/lib/i18n`, `no-silent-mutations`, and the web typecheck → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(web): org record Service tab and Key dates card (W01)"`.

---

### Task 15: Wave verification and PR

- [ ] **Step 1: Full API unit run** `cd apps/api && npx vitest run` → green.
- [ ] **Step 2: Integration contract suites** (test-stack up): the five suites from Task 4 Step 4 plus `serviceDeliverablesRls.integration.test.ts` and `apps/api/src/db/autoMigrate.test.ts` → green. Note the shard log shows the new suite's test count.
- [ ] **Step 3: Web** `cd apps/web && npx vitest run` and typecheck → green. `pnpm lint` at the root → clean.
- [ ] **Step 4: Manual smoke** on the worktree stack (`pnpm wt-stack up`): create a deliverable on a contract, open the drawer, deliver with a report run, reopen, waive; add a key date on the org record; confirm the org's Service tab lists the deliverable under the contract name.
- [ ] **Step 5: Tear down** `pnpm test-stack down` and `pnpm wt-stack down`.
- [ ] **Step 6: PR** with `Closes #<W01 sub-issue>`, the spec link, and a "Tenancy" section listing the four registrations and the RLS suite. Run `/pr-review-toolkit:review-pr`; act on confirmed findings only. Enqueue with `gh pr merge <N>` on green (never `--admin`).

---

## Self-review

- Spec coverage for this wave: §4.1 (Task 1, 3), §4.2 + `delivered_via` amendment (Task 1, 3, 6), §4.3 without `document` FK (Task 1; W03 adds it), §4.5 (Task 2, 3, 9), §4.8 (Task 2, 3), §4.9 registrations (Task 4), §7 actions (Task 8, 10, 13), §9 contract section + org tabs + key dates card (Task 13, 14), §10 REST (Task 10), §12 error codes `EVIDENCE_REQUIRED`, `NOT_FOUND`-not-403, `DUPLICATE_NAME`, `INVALID_OCCURRENCE_TRANSITION` (Task 8, 10), §13 unit + route + integration (Tasks 5–11). Portal, sweep, subscriber, documents, templates and MCP tools are W02–W05 by design.
- Placeholders: none; the W02 stubs are named exports that throw, so W02 replaces bodies without renaming.
- Type consistency: `DeliverableActor`, `DeliverableServiceError`, `DeliverableSummary`, `OccurrenceView`, `KeyDateView`, `EvidenceRef`, `transition`, `planOccurrences` are spelled identically in Tasks 5–14.
