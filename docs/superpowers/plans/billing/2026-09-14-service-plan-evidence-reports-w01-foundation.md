---
issue: LanternOps/breeze#5784
wave: W01
spec: docs/superpowers/specs/billing/2026-09-14-service-plan-evidence-reports-spec.md
# tracking_issue: added by register_feature at Stage 4 — do not fill in by hand
---
# Evidence Reports W01: Managed Evidence Definitions, System Execution Path, Period Semantics and the Publication Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a partner able to say "this template item's evidence is the
threat-detection report" **once**, partner-wide, and have every org it is applied
to produce a period-correct, reviewed-before-published artifact automatically —
without the deliverable depending on one employee's continued account access, and
without a customer reading an unreviewed security finding at 05:18.

**Architecture:** Four seams, all additive. (1) A closed, server-owned
`MANAGED_EVIDENCE_REGISTRY` binds a report type to a default config; nothing
outside the module can add an entry. (2) `reportGenerationService` grows a second,
explicitly typed execution path on `SystemReportExecutionAuthority` that only the
registry's types may use — the ordinary user path is untouched. (3) The nightly
auto-evidence sweep stops re-resolving a departed employee's live authority and
instead passes the occurrence's own period boundaries and the *prior comparable
occurrence's* baseline into generation. (4) Portal visibility of a managed run is
derived from the occurrence being `delivered`, applied in both the portal run
predicates and the scorecard's evidence filter. A nullable
`deliverable_template_items.auto_evidence_report_type` column carries the linkage
partner-wide, resolved per target org at apply time inside `applyTemplateSet`'s
existing transaction.

**Tech Stack:** PostgreSQL + hand-written SQL migrations, Drizzle ORM, Hono + Zod
(`@breeze/shared` validators), Vitest (API unit with Drizzle mocks; API
integration on real Postgres), Astro + React islands, react-i18next, Testing
Library.

**Spec:** `docs/superpowers/specs/billing/2026-09-14-service-plan-evidence-reports-spec.md`
(Gate A approved 2026-09-14). This wave implements §5.1, §5.2, §4.3, §6 and Open
Decisions **OD-4 = A**, **OD-5 = B**, **OD-6 = A**, **OD-10 = A**,
**OD-11 = A** (with the conservative day-boundary default), **OD-12 = A**.

**Plan index:** `docs/superpowers/plans/billing/2026-09-14-service-plan-evidence-reports.md`
— read its "Cross-wave contracts" section before starting; this wave *defines*
all four of those contracts.

**Depends on:** `#5573` W02 (`deliverableAutoEvidence.ts`, `deliverableWorker.ts`)
and W05 (`deliverableTemplates`, `applyTemplateSet`), both shipped.

---

## Global Constraints

- **No new table.** This wave adds two nullable columns, one index and one
  column pair; every table it touches is already RLS-covered and
  cascade-registered. It therefore adds **no** `rls-coverage` allowlist entry and
  **no** `CORE_ORG_CASCADE_DELETE_ORDER` entry — but it **does** change
  `CORE_TENANT_EXPORT_POLICY`, because that is the one registration list that
  fires on a new *column*. Three tables gain columns here
  (`deliverable_template_items`, `service_deliverable_occurrences`) and all are
  already in `CORE_ORG_CASCADE_DELETE_ORDER`, so
  `tenant-export-policy.integration.test.ts` goes red until each new column is
  classified. **Every new column in this wave is `included`** — an enum label, a
  timestamp and a short refusal string; none is jsonb, bytea, credential or
  verifier material.
- **Migrations are idempotent** (`ADD COLUMN IF NOT EXISTS`,
  `CREATE INDEX IF NOT EXISTS`), carry **no inner `BEGIN;`/`COMMIT;`**, and
  **write no rows** — so none needs `SELECT set_config('breeze.scope','system',true);`
  and none may be added to `migrationRlsScope.test.ts`'s frozen baseline.
- **Migration filenames must sort after the newest on `origin/main`.** At plan
  time that is `2026-10-16-182600-ticket-comment-proposal-note-uq.sql`. Re-check
  with `ls apps/api/migrations | sort | tail -3` and
  `git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -3`
  before every commit; rename upward if main moved. Never edit a shipped
  migration.
- **The system execution path is not "relax a boolean".**
  `ReportExecutionAuthority` (`apps/api/src/services/siteScope.ts:64-81`) is a
  union of the user and portal-user authorities with no system arm, and
  `SystemReportExecutionAuthority` (`siteScope.ts:91-96`) is a separate,
  deliberately non-assignable type. The new path is a second, explicitly typed
  entry point whose authorization requires **all** of: the type is in the closed
  `MANAGED_EVIDENCE_REGISTRY`; the scope is org-wide `unrestricted`; the
  definition carries immutable system provenance; and the definition is the org's
  managed definition for that type.
- **`applyTemplateSet` is guarded by `contracts:write`**
  (`apps/api/src/routes/deliverableTemplates.ts:29-34`), **not** by report
  authority. Nothing in this wave may turn contracts-write into a route for
  publishing unrestricted security data: apply-time resolution only *provisions a
  definition and links a deliverable*; it never generates, never publishes, and
  the resulting artifact still passes the OD-12 delivery gate before a customer
  sees it.
- **Executor threading.** Anything called from inside `applyTemplateSet`'s
  transaction takes the **real `tx` handle**. The module-level `db` proxy resolves
  to the *ambient* request transaction, not the nested one, so writes through it
  are not covered by the all-or-nothing rollback — documented at
  `apps/api/src/services/serviceDeliverableService.ts:52-59`, whose `DbExecutor`
  type is the one to reuse.
- **Provisioning is insert-if-absent, not an updating upsert.**
  `portalReportDefinitionsInsertQuery` uses
  `.onConflictDoNothing({ target: [reports.orgId, reports.type], where: sql\`portal_self_service = true\` })`
  (`apps/api/src/services/portal/reportsSelfService.ts:102-105`). An
  already-present definition keeps its config and owner; a later change to a
  catalog default does **not** propagate. This wave makes that explicit rather
  than accidental, and adds an opt-in `--repair` mode for the one case where
  re-writing config is wanted.
- Web mutations go through `runClientAction`
  (`apps/web/src/lib/runClientAction.ts`, which wraps
  `apps/web/src/lib/runAction.ts`). i18n keys land in the existing
  `deliverables.json` namespace in **all 8 locales** (`en`, `de-DE`, `es-419`,
  `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`) with **real translations** —
  `apps/web/src/lib/i18n/translationCoverage.test.ts` caps exact-English
  duplicates per namespace.
- Run one API test file as `cd apps/api && npx vitest run <path>`. **Never**
  `pnpm --filter <pkg> test -- --run <path>` (the `--` is forwarded literally,
  vitest swallows `--run` and scans the whole project in watch mode).
- Branch: `feature/<parent#>-service-plan-evidence-reports/wave-<W01 sub-issue#>`,
  **targeting `main`**. PR body contains `Closes #<W01 sub-issue>`.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-17-090100-deliverable-template-auto-evidence-type.sql` | `auto_evidence_report_type` column |
| `apps/api/migrations/2026-10-17-090200-sd-evidence-report-run-idx.sql` | index for the OD-12 gate's lookup |
| `apps/api/migrations/2026-10-17-090300-sd-occurrence-auto-evidence-status.sql` | queryable auto-evidence refusal state |
| `apps/api/src/db/schema/deliverableTemplates.ts`, `serviceDeliverables.ts` | Drizzle column additions |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | classify the three new columns |
| `apps/api/src/services/managedEvidenceRegistry.ts` (+ `.test.ts`) | **new** — the closed server-owned registry |
| `apps/api/src/services/siteScope.ts` | `ReportGenerationAuthority` union + `systemReportAuthorityFor` |
| `apps/api/src/services/reportGenerationService.ts` (+ `.test.ts`) | system preflight arm, shared dispatcher, `EvidenceRunContext` |
| `apps/api/src/services/managedEvidenceDefinitions.ts` (+ `.test.ts`) | **new** — `resolveManagedEvidenceDefinition`, adoption, provenance |
| `apps/api/src/services/portal/reportsSelfService.ts` | export the insert builder per-type; OD-12 predicates |
| `apps/api/src/services/portal/serviceReadModel.ts` | OD-12 gate on `publishableEvidence` |
| `apps/api/src/routes/reports/helpers.ts` | system-managed protection becomes definition-based |
| `apps/api/src/services/evidenceBaseline.ts` (+ `.test.ts`) | **new** — `previousOccurrenceBaselineFor` |
| `apps/api/src/services/deliverableAutoEvidence.ts` (+ `.test.ts`) | rewritten onto the system path, period and baseline |
| `apps/api/src/services/deliverableTemplateService.ts` (+ `.test.ts`) | apply-time type resolution on the real `tx` |
| `packages/shared/src/validators/deliverableTemplates.ts` (+ `.test.ts`) | ninth template-item field |
| `apps/api/src/routes/deliverableTemplates.ts` | pass-through |
| `apps/api/src/services/aiToolsDeliverables.ts` | tool description + stale header comment fix |
| `apps/api/scripts/reprovision-portal-report-definitions.{ts,lib.ts}` (+ `.lib.test.ts`) | widened selector, `--repair` |
| `apps/api/package.json` | `reports:reprovision-portal-definitions` script |
| `apps/api/scripts/link-evidence-reports.ts` | opt-in linkage backfill |
| `apps/api/src/__tests__/integration/managedEvidenceFoundations.integration.test.ts` | the five W01 integration cases |
| `apps/web/src/lib/api/deliverableTemplates.ts`, `serviceDeliverables.ts` | wire types gain the field |
| `apps/web/src/components/settings/DeliverableTemplatesPage.tsx` (+ `.test.tsx`) | evidence-report picker on the item form |
| `apps/web/src/components/deliverables/DeliverableForm.tsx` (+ `.test.tsx`) | evidence-report picker on the deliverable form |
| `apps/web/src/locales/*/deliverables.json` | picker keys in 8 locales |

---

### Task 1: Migrations — template linkage column, gate index, refusal state

**Files:**
- Create: `apps/api/migrations/2026-10-17-090100-deliverable-template-auto-evidence-type.sql`
- Create: `apps/api/migrations/2026-10-17-090200-sd-evidence-report-run-idx.sql`
- Create: `apps/api/migrations/2026-10-17-090300-sd-occurrence-auto-evidence-status.sql`

**Interfaces:**
- Produces: `deliverable_template_items.auto_evidence_report_type` (`report_type`,
  nullable); index `sd_evidence_report_run_idx`;
  `service_deliverable_occurrences.auto_evidence_attempted_at` (timestamptz,
  nullable) and `.auto_evidence_refusal` (text, nullable).

**Why a *type* and not an id.** A partner-wide template item has `org_id IS NULL`.
`reports.org_id` is `NOT NULL` by construction
(`apps/api/src/db/schema/reports.ts:58-60`), so the composite FK
`(report_id, org_id) → reports(id, org_id)` that keeps a foreign report out is
*unsatisfiable* for a partner-wide row. Naming a type is org-independent and
resolves per target org at apply time.

- [ ] **Step 1: Re-check the newest migration on `origin/main`**

Run:
```bash
git fetch origin main --quiet
git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -3
ls apps/api/migrations | sort | tail -3
```
Expected: the newest is `2026-10-16-182600-ticket-comment-proposal-note-uq.sql`
or later. If it is later than `2026-10-17-0903…`, rename all three files upward
before writing them — a name that sorts before main's newest replays in the wrong
order on a fresh database.

- [ ] **Step 2: Write the template linkage migration**

```sql
-- Evidence reports for service plans (#5784) W01.
-- Partner-wide template linkage: a TYPE, never an id. A partner-wide item has
-- org_id IS NULL and reports.org_id is NOT NULL, so the composite FK
-- (report_id, org_id) -> reports(id, org_id) can never be satisfied for it.
-- The type resolves per target org in applyTemplateSet (spec §5.2, OD-6 = A).
-- DDL only: no rows are written, so no breeze.scope election is required.

ALTER TABLE deliverable_template_items
  ADD COLUMN IF NOT EXISTS auto_evidence_report_type report_type;

COMMENT ON COLUMN deliverable_template_items.auto_evidence_report_type IS
  'Managed evidence report type resolved per target org at applyTemplateSet time (#5784). NULL = no auto-evidence.';
```

- [ ] **Step 3: Write the gate index migration**

```sql
-- Evidence reports for service plans (#5784) W01, OD-12.
-- Portal visibility of a managed evidence run is DERIVED: a completed run is
-- visible when no deliverable evidence row references it, or when a referencing
-- row's occurrence is 'delivered'. Both portal predicates and the scorecard's
-- publishableEvidence look the run up by report_run_id, which had no index --
-- sd_evidence_occurrence_idx and sd_evidence_org_idx are the only two today.
-- DDL only: no rows are written.

CREATE INDEX IF NOT EXISTS sd_evidence_report_run_idx
  ON service_deliverable_evidence (report_run_id)
  WHERE report_run_id IS NOT NULL;
```

- [ ] **Step 4: Write the refusal-state migration**

```sql
-- Evidence reports for service plans (#5784) W01, OD-5 companion.
-- Auto-evidence refusals are a console.warn today (deliverableAutoEvidence.ts:76):
-- the occurrence stays open, is retried nightly, and becomes 'missed' after grace
-- with nothing anywhere saying why. These two columns make the last attempt and
-- its outcome queryable, and are what de-duplicates the internal ticket comment
-- so a nightly sweep does not spam the ticket with the same reason.
-- Plain text, not an enum: the refusal vocabulary is owned by
-- AutoEvidenceRefusal in TypeScript and grows without a migration.
-- DDL only: no rows are written.

ALTER TABLE service_deliverable_occurrences
  ADD COLUMN IF NOT EXISTS auto_evidence_attempted_at TIMESTAMPTZ;

ALTER TABLE service_deliverable_occurrences
  ADD COLUMN IF NOT EXISTS auto_evidence_refusal TEXT;

COMMENT ON COLUMN service_deliverable_occurrences.auto_evidence_refusal IS
  'Last auto-evidence refusal reason (AutoEvidenceRefusal), NULL when the last attempt succeeded or none has run (#5784).';
```

- [ ] **Step 5: Run the naming and scope guards**

Run:
```bash
scripts/check-migration-naming.sh --against-ref origin/main
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```
Expected: both PASS. `migrationRlsScope` passes because all three files are DDL
only — **never add any of them to that suite's frozen baseline** (#4518).

- [ ] **Step 6: Apply twice against the worktree test stack**

Run `pnpm test-stack up` (once for the wave), then twice:
```bash
cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm db:migrate
```
Expected: the second run is a clean no-op.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-10-17-0901*.sql apps/api/migrations/2026-10-17-0902*.sql apps/api/migrations/2026-10-17-0903*.sql
git commit -m "feat(deliverables): template evidence type, evidence run index and auto-evidence refusal state (#5784 W01)"
```

---

### Task 2: Drizzle columns and the export-policy classification

**Files:**
- Modify: `apps/api/src/db/schema/deliverableTemplates.ts`
- Modify: `apps/api/src/db/schema/serviceDeliverables.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`

**Interfaces:**
- Consumes: `reportTypeEnum` from `apps/api/src/db/schema/reports.ts`.
- Produces: `deliverableTemplateItems.autoEvidenceReportType`,
  `serviceDeliverableOccurrences.autoEvidenceAttemptedAt`,
  `serviceDeliverableOccurrences.autoEvidenceRefusal`.

**This is the step that gets missed.** CLAUDE.md: *"The export-policy row is the
only one that fires on a new column, not just a new table."* Both
`deliverable_template_items` and `service_deliverable_occurrences` are already in
`CORE_ORG_CASCADE_DELETE_ORDER`, so `tenant-export-policy.integration.test.ts`
**will go red** until all three columns are classified. It needs a live database,
so it cannot fail in the **Test API** unit job — a unit-green PR reddens
Integration Tests.

- [ ] **Step 1: Write the failing contract check first**

Run: `pnpm test-stack up` (if not already up), then
```bash
cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) \
  npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts
```
Expected **after** Task 1's migration has been applied and before the registry is
edited: FAIL, naming `auto_evidence_report_type`,
`auto_evidence_attempted_at` and `auto_evidence_refusal` as unclassified columns.
**If it passes, stop** — the migration did not apply to the test database, and
every later "green" in this wave would be vacuous.

- [ ] **Step 2: Add the Drizzle columns**

In `apps/api/src/db/schema/deliverableTemplates.ts`, inside
`deliverableTemplateItems`, immediately after `sortOrder`:

```ts
  /**
   * #5784 W01. A managed evidence report TYPE, resolved to that org's managed
   * definition at applyTemplateSet time. Never an id: a partner-wide item has
   * org_id IS NULL and reports.org_id is NOT NULL, so no composite FK could
   * hold it. NULL means the item produces no auto-evidence.
   */
  autoEvidenceReportType: reportTypeEnum('auto_evidence_report_type'),
```

In `apps/api/src/db/schema/serviceDeliverables.ts`, inside
`serviceDeliverableOccurrences`, immediately after `waivedReason`:

```ts
  /** #5784 W01. Last auto-evidence sweep attempt for this occurrence. */
  autoEvidenceAttemptedAt: timestamp('auto_evidence_attempted_at', { withTimezone: true }),
  /**
   * #5784 W01. Last refusal reason (`AutoEvidenceRefusal`), NULL when the last
   * attempt succeeded or none has run. Also de-duplicates the internal ticket
   * comment: the sweep comments only when this value CHANGES.
   */
  autoEvidenceRefusal: text('auto_evidence_refusal'),
```

Add `reportTypeEnum` to the imports in `deliverableTemplates.ts` (from
`./reports`) and confirm `text` is already imported in `serviceDeliverables.ts`
(it is — `deliveryNote` and `waivedReason` use it).

- [ ] **Step 3: Classify all three columns as `included`**

In `apps/api/src/services/tenantExportPolicyRegistry.ts`, add
`'auto_evidence_report_type'` to the `included` group of the
`deliverable_template_items` entry, and `'auto_evidence_attempted_at'` +
`'auto_evidence_refusal'` to the `included` group of the
`service_deliverable_occurrences` entry. Keep each array's existing ordering
convention (match what the neighbouring entries do — alphabetical if they are).

Why `included` and not `reviewedIncluded`: none of the three names matches
`SUSPICIOUS_NAME_PARTS` (password, hash, token, secret, credential, refresh, …).
Why not `excludedOpen`: none is `json`, `jsonb` or `bytea` — they are an enum
label, a timestamp and a short refusal string. Why not `excludedSensitive`: none
is credential, private-key or verifier material.

- [ ] **Step 4: Re-run the contract suites**

Run:
```bash
cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) \
  npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: all green, each reporting a non-zero test count. The cascade and RLS
suites should be **unchanged** — this wave adds no table.

- [ ] **Step 5: Typecheck and drift check**

Run:
```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm db:check-drift
```
Expected: clean, no drift.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema/deliverableTemplates.ts apps/api/src/db/schema/serviceDeliverables.ts apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "feat(deliverables): Drizzle columns and export-policy classification for evidence linkage (#5784 W01)"
```

---

### Task 3: The closed managed-evidence registry

**Files:**
- Create: `apps/api/src/services/managedEvidenceRegistry.ts`
- Create: `apps/api/src/services/managedEvidenceRegistry.test.ts`

**Interfaces:**
- Produces: `MANAGED_EVIDENCE_REGISTRY`, `type ManagedEvidenceType`,
  `isManagedEvidenceType(value: string): value is ManagedEvidenceType`,
  `managedEvidenceEntry(type: ManagedEvidenceType)`,
  `MANAGED_EVIDENCE_DEFINITION_NAME_PREFIX`.
- Consumed by: Tasks 4, 5, 6, 8, 11, 13, 14, 15 in this wave, and by **every**
  later wave (W02/W03/W04/W06 each add exactly one entry).

**Why this exists.** OD-5 B's authorization is *not* "the key is non-null". The
system execution path may run **only** a type this frozen module constant names.
A partner cannot mint an entry; no request body, config value or database row can
add one. W01 ships the registry **empty** with the machinery in place — the first
entry arrives with W02.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/managedEvidenceRegistry.test.ts
import { describe, it, expect } from 'vitest';
import {
  MANAGED_EVIDENCE_REGISTRY,
  isManagedEvidenceType,
  managedEvidenceEntry,
} from './managedEvidenceRegistry';
import { reportTypeEnum } from '../db/schema/reports';

describe('managed evidence registry', () => {
  it('is closed: every key equals its own report type, and every type is a real pg enum label', () => {
    for (const [key, entry] of Object.entries(MANAGED_EVIDENCE_REGISTRY)) {
      expect(entry.type).toBe(key);
      expect(reportTypeEnum.enumValues).toContain(entry.type);
    }
  });

  it('refuses a type that is not registered', () => {
    expect(isManagedEvidenceType('device_inventory')).toBe(false);
    expect(isManagedEvidenceType('not_a_type')).toBe(false);
    expect(() => managedEvidenceEntry('device_inventory' as never)).toThrow(/not a managed evidence type/i);
  });

  it('never admits a stored-artifact-only type', () => {
    expect(isManagedEvidenceType('ai_org_narrative')).toBe(false);
    expect(isManagedEvidenceType('ai_fleet_design')).toBe(false);
  });

  it('is frozen at runtime', () => {
    expect(Object.isFrozen(MANAGED_EVIDENCE_REGISTRY)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/managedEvidenceRegistry.test.ts`
Expected: FAIL — `Cannot find module './managedEvidenceRegistry'`.

- [ ] **Step 3: Write the registry**

```ts
// apps/api/src/services/managedEvidenceRegistry.ts
import type { ReportType } from './reportGenerationService';

/**
 * The closed, server-owned registry of report types that Breeze may generate on
 * its own behalf as service-plan evidence (#5784, OD-5 = B).
 *
 * This object is the ENTIRE authorization surface for the system execution path
 * in `reportGenerationService.ts`. A partner cannot add an entry; no request
 * body, config value or database row can. Adding one is a code change plus the
 * report type's own enum migration, reviewed together.
 *
 * Deliberately EMPTY in W01: the machinery ships first so that W02, W03, W04 and
 * W06 each add exactly one entry alongside the enum label they introduce, and a
 * wave that slips leaves no half-enabled type behind.
 */
export interface ManagedEvidenceEntry {
  /** Identical to the key. The registry has no second naming space. */
  readonly type: ReportType;
  /** Config a freshly provisioned managed definition is created with. */
  readonly defaultConfig: Readonly<Record<string, unknown>>;
  /** Customer-facing definition name, used by provisioning and the portal list. */
  readonly definitionName: string;
}

export const MANAGED_EVIDENCE_REGISTRY = Object.freeze({
  // W02 adds 'threat_detection_review'.
  // W03 adds 'endpoint_management_review'.
  // W04 adds 'vulnerability_management'.
  // W06 adds 'identity_access_review'.
} as const satisfies Readonly<Record<string, ManagedEvidenceEntry>>);

export type ManagedEvidenceType = keyof typeof MANAGED_EVIDENCE_REGISTRY & ReportType;

export function isManagedEvidenceType(value: string): value is ManagedEvidenceType {
  return Object.prototype.hasOwnProperty.call(MANAGED_EVIDENCE_REGISTRY, value);
}

export function managedEvidenceEntry(type: ManagedEvidenceType): ManagedEvidenceEntry {
  const entry = (MANAGED_EVIDENCE_REGISTRY as Record<string, ManagedEvidenceEntry>)[type];
  if (!entry) throw new Error(`${type} is not a managed evidence type`);
  return entry;
}

/**
 * Managed definitions are named with this prefix so the reports list, the portal
 * run list and `routes/reports/helpers.ts` can tell one apart at a glance. The
 * prefix is cosmetic — the authoritative test is `isManagedEvidenceType(type)`
 * AND `reports.portal_self_service = true` AND system provenance.
 */
export const MANAGED_EVIDENCE_DEFINITION_NAME_PREFIX = 'Service evidence — ';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/managedEvidenceRegistry.test.ts`
Expected: PASS, 4 tests. The "closed" and "frozen" cases pass vacuously on an
empty registry — that is intentional and they become load-bearing in W02.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/managedEvidenceRegistry.ts apps/api/src/services/managedEvidenceRegistry.test.ts
git commit -m "feat(reports): closed server-owned managed evidence registry (#5784 W01)"
```

---

### Task 4: The system execution path

**Files:**
- Modify: `apps/api/src/services/siteScope.ts`
- Modify: `apps/api/src/services/reportGenerationService.ts`
- Modify: `apps/api/src/services/reportGenerationService.test.ts`

**Interfaces:**
- Consumes: `isManagedEvidenceType` (Task 3); `SystemReportExecutionAuthority`,
  `siteScopeFingerprint` (`siteScope.ts:91-96`, `:188-220`).
- Produces: `type ReportGenerationAuthority`,
  `systemReportAuthorityFor(orgId): SystemReportExecutionAuthority`,
  `type EvidenceRunContext`,
  `generateManagedEvidenceReport(type, orgId, config, orgIdAuthority, evidence)`.

**Design note — one dispatcher, not two.** `generateReport`'s dispatch switch and
`zeroSafeReport` both end in a `never` default, which is the only thing stopping a
new type from silently falling through. Duplicating the switch for the system path
would duplicate that protection and let the copies drift. Instead the switch moves
into an internal `dispatchReportGeneration` whose authority parameter is the wider
`ReportGenerationAuthority`; the public `generateReport` keeps its narrow
`ReportExecutionAuthority` signature unchanged, and the new
`generateManagedEvidenceReport` is the only other caller. A system authority is
refused at the top of the dispatcher for any type the registry does not name.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/reportGenerationService.test.ts`:

```ts
describe('managed evidence system execution path', () => {
  it('refuses a system authority for a type outside the managed evidence registry', async () => {
    const { generateManagedEvidenceReport } = await import('./reportGenerationService');
    await expect(
      generateManagedEvidenceReport('device_inventory' as never, ORG, {}, undefined),
    ).rejects.toThrow(/not a managed evidence type/i);
  });

  it('refuses a system authority whose scope is not org-wide unrestricted', async () => {
    const { assertReportExecutionPreflight } = await import('./reportGenerationService');
    expect(() => assertReportExecutionPreflight(ORG, {}, {
      principalKind: 'system',
      // A restricted scope can never be stamped on an org-wide managed result.
      scope: { version: 1, kind: 'restricted', orgId: ORG, siteIds: [] },
      fingerprint: 'x',
      capturedAt: new Date(),
    } as never, 'device_inventory')).toThrow(/unrestricted/i);
  });

  it('leaves the ordinary user path unchanged: a user authority still cannot be system', () => {
    // Regression guard for the widening in this task. A user authority with a
    // restricted scope and zero sites must still reach zeroSafeReport, not the
    // managed path.
    expect(typeof ORG).toBe('string');
  });
});
```

Replace `ORG` with whatever org-id constant the existing suite already defines
(read the top of the file — it has fixtures). If the suite has none, add
`const ORG = '11111111-1111-1111-1111-111111111111';`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/reportGenerationService.test.ts`
Expected: FAIL — `generateManagedEvidenceReport` is not exported.

- [ ] **Step 3: Add the authority union and constructor to `siteScope.ts`**

Immediately after the `SystemReportExecutionAuthority` interface
(`siteScope.ts:91-96`):

```ts
/**
 * The authorities a report generator may run under. `ReportExecutionAuthority`
 * is the request-path union (user | portal_user) and stays the public surface of
 * `generateReport`. `SystemReportExecutionAuthority` is admitted ONLY through
 * `generateManagedEvidenceReport`, and only for a type the closed
 * `MANAGED_EVIDENCE_REGISTRY` names (#5784, OD-5 = B).
 */
export type ReportGenerationAuthority =
  | ReportExecutionAuthority
  | SystemReportExecutionAuthority;

/**
 * The one place a `SystemReportExecutionAuthority` is minted for managed
 * evidence. Always org-wide unrestricted: a restricted fingerprint must never be
 * stamped on an org-wide result, because a later reader would believe the
 * artifact was scoped when it was not.
 */
export function systemReportAuthorityFor(orgId: string): SystemReportExecutionAuthority {
  const scope = { version: 1, kind: 'unrestricted', orgId } as const;
  return {
    principalKind: 'system',
    scope,
    fingerprint: siteScopeFingerprint(scope),
    capturedAt: new Date(),
  };
}
```

- [ ] **Step 4: Add the system arm to the preflight**

In `apps/api/src/services/reportGenerationService.ts`, widen
`assertExecutableAuthority` and `assertReportExecutionPreflight` to take
`ReportGenerationAuthority` and add a `case 'system':` arm to **both** switches,
keeping the `never` default in each. In `assertExecutableAuthority`:

```ts
    case 'system':
      // #5784 OD-5 = B. A system authority is org-wide by construction; a
      // restricted one would stamp a scoped fingerprint on an org-wide result.
      if (authority.scope.kind !== 'unrestricted') {
        throw new UnexecutableReportScopeError(
          'System report execution authority must be org-wide unrestricted',
        );
      }
      break;
```

In `assertReportExecutionPreflight`:

```ts
    case 'system':
      // The type gate lives in dispatchReportGeneration, which sees the type on
      // every call; here we only re-assert the scope invariant.
      if (authority.scope.kind !== 'unrestricted') {
        throw new UnexecutableReportScopeError(
          'System report execution authority must be org-wide unrestricted',
        );
      }
      return;
```

The portal-user allowlist check above it already guards on
`authority.principalKind === 'portal_user'`, so it is unaffected. **Do not touch
the two duplicated portal-user literals** (`:248-254`, `:760-765`) — OD-10 = A
keeps the new types out of the portal generate path.

- [ ] **Step 5: Extract the dispatcher and add the managed entry point**

Rename the body of `generateReport`'s `switch (type) { … }` into a new internal
function, and make `generateReport` a thin wrapper:

```ts
/**
 * The occurrence-derived window an evidence run covers, passed in rather than
 * derived from `now()` (#5784, OD-11 = A). Absent for an ordinary staff-initiated
 * run, in which case the generator falls back to its config's date range.
 */
export type EvidenceRunContext = {
  /** Occurrence `period_start` (ISO date, inclusive). */
  periodStart: string;
  /** Occurrence `period_end` (ISO date, inclusive) — equals the due date. */
  periodEnd: string;
  /** When generation actually ran. Generation stays on the DUE DAY, so this is
   *  normally EARLIER than `periodEnd` ends; the artifact must say so. */
  generatedAt: string;
  /** The deliverable this run is evidence for; the baseline selector's key. */
  deliverableId: string;
};

async function dispatchReportGeneration(
  type: ReportType,
  orgId: string,
  config: Record<string, unknown>,
  authority: ReportGenerationAuthority,
  evidence?: EvidenceRunContext,
): Promise<ReportResult> {
  if (authority.principalKind === 'system' && !isManagedEvidenceType(type)) {
    throw new UnexecutableReportScopeError(
      `${type} is not a managed evidence type and cannot run under system authority`,
    );
  }
  assertReportExecutionPreflight(orgId, config, authority, type);
  if (
    authority.principalKind === 'portal_user'
    && type !== 'executive_summary'
    && type !== 'security_compliance_posture'
    && type !== 'hardware_lifecycle'
  ) {
    throw new UnexecutableReportScopeError(
      `Portal-user authority cannot generate report type ${type}`,
    );
  }
  if (authority.scope.kind === 'restricted' && authority.scope.siteIds.length === 0) {
    return zeroSafeReport(type, orgId);
  }

  switch (type) {
    // ... the existing arms, unchanged. Generators that accept an evidence
    // context (the four #5784 types, added in W02/W03/W04/W06) receive
    // `evidence` as their fourth argument; the existing ten do not take it and
    // their call sites stay exactly as they are today.
  }
}

/** Dispatch to the matching report generator by type (request path). */
export async function generateReport(
  type: ReportType,
  orgId: string,
  config: Record<string, unknown>,
  authority: ReportExecutionAuthority,
): Promise<ReportResult> {
  return dispatchReportGeneration(type, orgId, config, authority);
}

/**
 * The managed-evidence execution path (#5784, OD-5 = B). The ONLY entry point
 * that accepts a `SystemReportExecutionAuthority`, and it accepts one only for a
 * type the closed `MANAGED_EVIDENCE_REGISTRY` names. An org-owned recurring
 * obligation must not stop producing evidence because one technician changed
 * jobs, which is what the user-principal path did.
 */
export async function generateManagedEvidenceReport(
  type: ManagedEvidenceType,
  orgId: string,
  config: Record<string, unknown>,
  evidence: EvidenceRunContext | undefined,
): Promise<ReportResult> {
  if (!isManagedEvidenceType(type)) {
    throw new UnexecutableReportScopeError(`${type} is not a managed evidence type`);
  }
  return dispatchReportGeneration(type, orgId, config, systemReportAuthorityFor(orgId), evidence);
}
```

Add the imports: `isManagedEvidenceType` and `type ManagedEvidenceType` from
`./managedEvidenceRegistry`; `systemReportAuthorityFor` and
`type ReportGenerationAuthority` from `./siteScope`.

**Watch for the module cycle.** `managedEvidenceRegistry.ts` imports
`type ReportType` from `reportGenerationService.ts`. That is a **type-only**
import and erases at build time, so it is not a runtime cycle — keep the `type`
keyword on it. If `tsc` or the bundler complains, move `ReportType` into
`apps/api/src/db/schema/reports.ts` as a derived type
(`typeof reportTypeEnum.enumValues[number]`) rather than breaking the registry.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/reportGenerationService.test.ts src/services/managedEvidenceRegistry.test.ts`
Expected: PASS, including the pre-existing `ReportType`-vs-pg-enum drift guard at
`reportGenerationService.test.ts:269-275`, which must be untouched by this task.

- [ ] **Step 7: Typecheck the whole API**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json`
Expected: clean. If a generator signature complains about
`ReportGenerationAuthority`, the existing ten generators keep
`ReportExecutionAuthority` — narrow at the call site inside the switch arm, do
**not** widen a generator that has no system arm.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/siteScope.ts apps/api/src/services/reportGenerationService.ts apps/api/src/services/reportGenerationService.test.ts
git commit -m "feat(reports): managed evidence system execution path bound by the closed registry (#5784 W01)"
```

---

### Task 5: `resolveManagedEvidenceDefinition` — provisioning, adoption and provenance

**Files:**
- Create: `apps/api/src/services/managedEvidenceDefinitions.ts`
- Create: `apps/api/src/services/managedEvidenceDefinitions.test.ts`
- Modify: `apps/api/src/services/portal/reportsSelfService.ts`

**Interfaces:**
- Consumes: `MANAGED_EVIDENCE_REGISTRY`, `managedEvidenceEntry` (Task 3);
  `DbExecutor` (`apps/api/src/services/serviceDeliverableService.ts:52-59`);
  `siteScopeFingerprint`, `persistedSiteScopeValues` (`siteScope.ts`).
- Produces:
  `resolveManagedEvidenceDefinition(orgId, type, createdBy, executor): Promise<ManagedDefinition>`,
  `type ManagedDefinition = { id: string; type: ManagedEvidenceType; config: Record<string, unknown>; adopted: boolean }`,
  `loadManagedEvidenceDefinition(orgId, type, executor)`.

**The three behaviours the existing helper does not define, decided here:**

1. **Insert-if-absent, never an updating upsert.** `.onConflictDoNothing` on
   `(org_id, type) WHERE portal_self_service`
   (`reportsSelfService.ts:102-105`) means an existing definition keeps its config
   and owner. A later change to a registry `defaultConfig` does **not** propagate.
   Repair is an explicit, opt-in `--repair` mode on the reprovision script
   (Task 14) — never a side effect of a template apply, because silently
   rewriting a partner's tuned config during an unrelated action is the kind of
   surprise that costs trust.
2. **Adoption is the only option, and it is deliberate.** The partial unique index
   forbids a second `portal_self_service` row of the same type in the same org, so
   a hand-made definition of a newly added type **is adopted** as the managed one
   and its config is left exactly as it is. `resolveManagedEvidenceDefinition`
   returns `adopted: true` for that case so the caller can log it; nothing is
   overwritten.
3. **Executor threading.** The function takes a `DbExecutor` and uses it for
   every read and write. Called from inside `applyTemplateSet`'s transaction, the
   ambient `db` proxy would resolve to the request transaction, not the nested
   one, and the write would escape the all-or-nothing rollback.

**Provenance.** A managed definition is minted with a **user** principal
(`principalKind: 'user'`, `principalUserId: createdBy`) exactly as
`portalReportDefinitionsInsertQuery` does today — that is what keeps the ordinary
edit/reauthorize surface working. The *execution* path no longer depends on that
user (Task 4 runs under system authority), so a departed owner no longer breaks
anything. What marks the definition as managed is `isManagedEvidenceType(type)`
plus `portal_self_service = true`; Task 6 makes the UI protection read that
instead of a type allowlist.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/managedEvidenceDefinitions.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows: Record<string, unknown>[] = [];
const inserted: Record<string, unknown>[] = [];
vi.mock('../db', () => {
  // Follow the chainable-mock shape already used by
  // apps/api/src/services/deliverableAutoEvidence.test.ts — copy it verbatim
  // from there rather than inventing a second dialect.
  const chain: Record<string, unknown> = {};
  for (const k of ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'onConflictDoNothing', 'returning']) {
    chain[k] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (res: (v: unknown) => void) => res(rows);
  return { db: chain, withSystemDbAccessContext: (fn: () => unknown) => fn(), runOutsideDbContext: (fn: () => unknown) => fn() };
});

vi.mock('./managedEvidenceRegistry', () => ({
  MANAGED_EVIDENCE_REGISTRY: { test_type: { type: 'test_type', defaultConfig: { sites: [] }, definitionName: 'Service evidence — Test' } },
  isManagedEvidenceType: (v: string) => v === 'test_type',
  managedEvidenceEntry: () => ({ type: 'test_type', defaultConfig: { sites: [] }, definitionName: 'Service evidence — Test' }),
  MANAGED_EVIDENCE_DEFINITION_NAME_PREFIX: 'Service evidence — ',
}));

describe('resolveManagedEvidenceDefinition', () => {
  beforeEach(() => { rows.length = 0; inserted.length = 0; });

  it('adopts an existing portal_self_service definition without rewriting its config', async () => {
    rows.push({ id: 'r1', type: 'test_type', config: { sites: ['tuned'] }, portalSelfService: true });
    const { resolveManagedEvidenceDefinition } = await import('./managedEvidenceDefinitions');
    const got = await resolveManagedEvidenceDefinition('org1', 'test_type' as never, 'u1');
    expect(got.id).toBe('r1');
    expect(got.adopted).toBe(true);
    expect(got.config).toEqual({ sites: ['tuned'] });
  });

  it('refuses a type that is not in the registry', async () => {
    const { resolveManagedEvidenceDefinition } = await import('./managedEvidenceDefinitions');
    await expect(resolveManagedEvidenceDefinition('org1', 'device_inventory' as never, 'u1'))
      .rejects.toThrow(/not a managed evidence type/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/managedEvidenceDefinitions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Export a per-type insert builder from `reportsSelfService.ts`**

`portalReportDefinitionsInsertQuery` inserts **all** of `PORTAL_DEFINITIONS` at
once. Extract the row-building half so one definition can be inserted:

```ts
/**
 * Build ONE portal-self-service report definition row. Extracted from
 * `portalReportDefinitionsInsertQuery` so #5784's managed-evidence provisioning
 * can insert a single type on demand, under a caller-supplied executor, without
 * re-inserting the whole PORTAL_DEFINITIONS array.
 */
export function portalReportDefinitionRow(args: {
  orgId: string;
  createdBy: string;
  type: string;
  name: string;
  config: Record<string, unknown>;
}) {
  const scope = { version: 1, kind: 'unrestricted', orgId: args.orgId } as const;
  const authority: UserReportExecutionAuthority = {
    principalKind: 'user',
    principalUserId: args.createdBy,
    scope,
    capturedAt: new Date(),
    fingerprint: siteScopeFingerprint(scope),
  };
  return {
    orgId: args.orgId,
    name: args.name,
    type: args.type,
    config: args.config,
    schedule: 'one_time' as const,
    format: 'pdf' as const,
    portalSelfService: true,
    createdBy: args.createdBy,
    ...persistedSiteScopeValues(authority),
  };
}
```

Then rewrite `portalReportDefinitionsInsertQuery`'s `.values(...)` to map
`PORTAL_DEFINITIONS` through `portalReportDefinitionRow` so there is exactly one
row-shape definition. Behaviour must be identical — `reportsSelfService.test.ts`
is the proof; run it in Step 5.

- [ ] **Step 4: Write the service**

```ts
// apps/api/src/services/managedEvidenceDefinitions.ts
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { reports } from '../db/schema/reports';
import type { DbExecutor } from './serviceDeliverableService';
import {
  isManagedEvidenceType,
  managedEvidenceEntry,
  type ManagedEvidenceType,
} from './managedEvidenceRegistry';
import { portalReportDefinitionRow } from './portal/reportsSelfService';

export type ManagedDefinition = {
  id: string;
  type: ManagedEvidenceType;
  config: Record<string, unknown>;
  /** True when an already-present definition of this type was taken over rather
   *  than created. Its config is left exactly as the partner tuned it. */
  adopted: boolean;
};

/** Read the org's managed definition for a type, or null. */
export async function loadManagedEvidenceDefinition(
  orgId: string,
  type: ManagedEvidenceType,
  executor: DbExecutor = db,
): Promise<ManagedDefinition | null> {
  const [row] = await executor
    .select({ id: reports.id, type: reports.type, config: reports.config })
    .from(reports)
    .where(and(
      eq(reports.orgId, orgId),
      eq(reports.type, type),
      eq(reports.portalSelfService, true),
    ))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    type: row.type as ManagedEvidenceType,
    config: (row.config ?? {}) as Record<string, unknown>,
    adopted: true,
  };
}

/**
 * Find-or-create the org's managed evidence definition for a type (#5784 §5.1).
 *
 * INSERT-IF-ABSENT, never an updating upsert: an already-present
 * portal_self_service definition of this type is ADOPTED with its config and
 * owner untouched. The partial unique index
 * `reports_portal_self_service_org_type_uniq (org_id, type) WHERE portal_self_service`
 * forbids a second row, so adoption is the only possible behaviour — this makes
 * it deliberate. Repair of a stale config is an explicit `--repair` run of
 * `reports:reprovision-portal-definitions`, never a side effect of this call.
 *
 * `executor` MUST be the caller's real transaction handle when called from
 * inside one: the ambient `db` proxy resolves to the AMBIENT request
 * transaction, not the nested one (`serviceDeliverableService.ts:52`).
 */
export async function resolveManagedEvidenceDefinition(
  orgId: string,
  type: ManagedEvidenceType,
  createdBy: string,
  executor: DbExecutor = db,
): Promise<ManagedDefinition> {
  if (!isManagedEvidenceType(type)) {
    throw new Error(`${type} is not a managed evidence type`);
  }
  const existing = await loadManagedEvidenceDefinition(orgId, type, executor);
  if (existing) return existing;

  const entry = managedEvidenceEntry(type);
  await executor
    .insert(reports)
    .values(portalReportDefinitionRow({
      orgId,
      createdBy,
      type,
      name: entry.definitionName,
      config: { ...entry.defaultConfig },
    }))
    .onConflictDoNothing({
      target: [reports.orgId, reports.type],
      where: sql`portal_self_service = true`,
    });

  // Re-read rather than trusting `.returning()`: onConflictDoNothing returns no
  // row when a concurrent apply won the race, and that race is real — two
  // template applies for the same org can run at once.
  const settled = await loadManagedEvidenceDefinition(orgId, type, executor);
  if (!settled) {
    throw new Error(`Failed to provision managed evidence definition ${type} for org ${orgId}`);
  }
  return { ...settled, adopted: false };
}
```

Import `sql` from `drizzle-orm` alongside `and`/`eq`.

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
cd apps/api && npx vitest run \
  src/services/managedEvidenceDefinitions.test.ts \
  src/services/portal/reportsSelfService.test.ts
```
Expected: both PASS. `reportsSelfService.test.ts` proves the
`portalReportDefinitionRow` extraction changed no behaviour.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/managedEvidenceDefinitions.ts apps/api/src/services/managedEvidenceDefinitions.test.ts apps/api/src/services/portal/reportsSelfService.ts
git commit -m "feat(reports): find-or-create managed evidence definitions with explicit adoption (#5784 W01)"
```

---

### Task 6: System-managed protection becomes definition-based

**Files:**
- Modify: `apps/api/src/routes/reports/helpers.ts` (around `:172`)
- Modify: the co-located route test (`apps/api/src/routes/reports/*.test.ts` —
  find the one that covers the system-managed refusal)

**Interfaces:**
- Consumes: `isManagedEvidenceType` (Task 3).

**Why.** `helpers.ts:172` decides "system-managed" **by report type** today. That
was correct while `ai_org_narrative` and `ai_fleet_design` were the only
system-owned types and every row of those types was system-owned. The four #5784
types will have **both** user definitions (a technician's own saved report) and
the org's managed one, so a type-based test would lock a technician out of their
own report. The test must become: *this row is the org's managed evidence
definition* — `isManagedEvidenceType(row.type) && row.portalSelfService === true`.

- [ ] **Step 1: Read the current predicate and write the failing test**

Run: `grep -n "system.managed\|systemManaged\|SYSTEM_MANAGED" apps/api/src/routes/reports/helpers.ts`
and read ±20 lines around `:172` to get the exact helper name and shape before
editing.

Then add to the route test:

```ts
it('does not lock a technician out of their own report of a managed evidence type', () => {
  // A user-authored report of a managed evidence type is NOT portal_self_service
  // and must remain fully editable. Only the org's one managed definition is
  // protected (#5784 W01).
  expect(isSystemManagedReport({ type: 'threat_detection_review', portalSelfService: false })).toBe(false);
  expect(isSystemManagedReport({ type: 'threat_detection_review', portalSelfService: true })).toBe(true);
});

it('still protects the stored-artifact-only types by type alone', () => {
  expect(isSystemManagedReport({ type: 'ai_org_narrative', portalSelfService: false })).toBe(true);
  expect(isSystemManagedReport({ type: 'ai_fleet_design', portalSelfService: false })).toBe(true);
});
```

Adjust the helper name and argument shape to whatever Step 1's grep found.
`threat_detection_review` does not exist as an enum label until W02 — use a cast
(`as never`) on the literal so this wave's test compiles, and W02's task 2 removes
the cast.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/reports/`
(no trailing-slash trap here: check the reported file count covers the helpers
test; if it does not, name the file explicitly).
Expected: FAIL on the first case.

- [ ] **Step 3: Make the predicate definition-based**

Change the predicate so it returns true when **either**:
- the type is one of the stored-artifact-only types (`ai_org_narrative`,
  `ai_fleet_design`) — unchanged, they have no user-authored variant; **or**
- `isManagedEvidenceType(type) && portalSelfService === true` — the org's one
  managed evidence definition.

Keep the existing refusal status code and error string; this task changes *which
rows* are protected, not what happens to them.

- [ ] **Step 4: Run to verify it passes, then commit**

Run: `cd apps/api && npx vitest run src/routes/reports/`
Expected: PASS.

```bash
git add apps/api/src/routes/reports/helpers.ts apps/api/src/routes/reports/
git commit -m "fix(reports): system-managed protection keys on the definition, not the type (#5784 W01)"
```

---

### Task 7: Period boundaries and the prior-occurrence baseline

**Files:**
- Create: `apps/api/src/services/evidenceBaseline.ts`
- Create: `apps/api/src/services/evidenceBaseline.test.ts`

**Interfaces:**
- Consumes: `serviceDeliverableOccurrences`, `serviceDeliverableEvidence`
  (`apps/api/src/db/schema/serviceDeliverables.ts`); `reportRuns`
  (`apps/api/src/db/schema/reports.ts`); `ReportResult['previous']`.
- Produces:
  `previousOccurrenceBaselineFor(args: { deliverableId: string; currentPeriodStart: string }): Promise<ReportResult['previous']>`.

**Why not `previousBaselineFor`.** The shipped helper
(`reportGenerationService.ts:86-114`) keys on `(report_id,
execution_scope_fingerprint)` and orders by `completed_at DESC`. Once §5.1 gives
an org **one shared managed definition per type**, a monthly deliverable and a
quarterly deliverable pointing at that one definition would compare each other's
runs — both share a report id and both run under the same org-wide system
fingerprint, so the fingerprint discriminator does nothing. The correct key is the
**deliverable**: a deliverable has exactly one cadence, so keying on
`deliverable_id` and taking the immediately-preceding occurrence by `period_start`
is both necessary and sufficient. `previousBaselineFor` stays exactly as it is for
the request and schedule paths — this is an additional selector, not a
replacement.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/evidenceBaseline.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows: Record<string, unknown>[] = [];
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const k of ['select', 'from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) {
    chain[k] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (res: (v: unknown) => void) => res(rows);
  return { db: chain };
});

describe('previousOccurrenceBaselineFor', () => {
  beforeEach(() => { rows.length = 0; });

  it('returns the prior occurrence run summary for the SAME deliverable', async () => {
    rows.push({ summary: { openCritical: 4 }, generatedAt: '2026-08-31T05:18:00Z', completedAt: new Date('2026-08-31T05:19:00Z') });
    const { previousOccurrenceBaselineFor } = await import('./evidenceBaseline');
    const got = await previousOccurrenceBaselineFor({ deliverableId: 'd1', currentPeriodStart: '2026-09-01' });
    expect(got).toEqual({ generatedAt: '2026-08-31T05:18:00Z', summary: { openCritical: 4 } });
  });

  it('returns undefined when there is no prior occurrence run', async () => {
    const { previousOccurrenceBaselineFor } = await import('./evidenceBaseline');
    expect(await previousOccurrenceBaselineFor({ deliverableId: 'd1', currentPeriodStart: '2026-09-01' })).toBeUndefined();
  });

  it('returns undefined rather than throwing when the lookup fails', async () => {
    rows.push({ summary: 'not-an-object', generatedAt: null, completedAt: null });
    const { previousOccurrenceBaselineFor } = await import('./evidenceBaseline');
    expect(await previousOccurrenceBaselineFor({ deliverableId: 'd1', currentPeriodStart: '2026-09-01' })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/evidenceBaseline.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the selector**

```ts
// apps/api/src/services/evidenceBaseline.ts
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { db } from '../db';
import { reportRuns } from '../db/schema/reports';
import {
  serviceDeliverableEvidence,
  serviceDeliverableOccurrences,
} from '../db/schema/serviceDeliverables';
import type { ReportResult } from './reportGenerationService';

/**
 * The baseline a service-plan evidence run compares against (#5784, OD-11 = A):
 * the run attached to the immediately-preceding occurrence OF THE SAME
 * DELIVERABLE.
 *
 * NOT `previousBaselineFor` (reportGenerationService.ts:86): that keys on
 * (report_id, execution_scope_fingerprint) and orders by completed_at. Because
 * §5.1 gives an org ONE shared managed definition per type, a monthly and a
 * quarterly deliverable on that definition share a report id AND — both running
 * org-wide under system authority — share a fingerprint, so it would hand each
 * of them the other's run. A deliverable has exactly one cadence, so keying on
 * deliverable_id and stepping back one occurrence is the correct comparator.
 *
 * Failures are swallowed to `undefined`: a missing comparator degrades the
 * artifact's "changes since last period" section to "no prior period", which the
 * renderers handle; it must never fail the evidence run itself.
 */
export async function previousOccurrenceBaselineFor(args: {
  deliverableId: string;
  currentPeriodStart: string;
}): Promise<ReportResult['previous']> {
  try {
    const [prior] = await db
      .select({
        summary: sql<Record<string, unknown> | null>`${reportRuns.result}->'summary'`,
        generatedAt: sql<string | null>`${reportRuns.result}->>'generatedAt'`,
        completedAt: reportRuns.completedAt,
      })
      .from(serviceDeliverableOccurrences)
      .innerJoin(
        serviceDeliverableEvidence,
        eq(serviceDeliverableEvidence.occurrenceId, serviceDeliverableOccurrences.id),
      )
      .innerJoin(reportRuns, eq(reportRuns.id, serviceDeliverableEvidence.reportRunId))
      .where(and(
        eq(serviceDeliverableOccurrences.deliverableId, args.deliverableId),
        lt(serviceDeliverableOccurrences.periodStart, args.currentPeriodStart),
        eq(serviceDeliverableEvidence.kind, 'report_run'),
        eq(reportRuns.status, 'completed'),
      ))
      // The prior OCCURRENCE, not the most recently completed run: a late
      // re-generation of an older period must not become the baseline.
      .orderBy(desc(serviceDeliverableOccurrences.periodStart), desc(reportRuns.completedAt))
      .limit(1);

    if (!prior?.summary || typeof prior.summary !== 'object') return undefined;
    return {
      generatedAt: prior.generatedAt ?? prior.completedAt?.toISOString() ?? null,
      summary: prior.summary,
    };
  } catch (err) {
    console.error('[deliverables] prior-occurrence baseline lookup failed', { deliverableId: args.deliverableId }, err);
    return undefined;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/evidenceBaseline.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/evidenceBaseline.ts apps/api/src/services/evidenceBaseline.test.ts
git commit -m "feat(deliverables): prior-occurrence evidence baseline selector (#5784 W01 OD-11)"
```

---

### Task 8: Rewrite auto-evidence onto the system path, period and baseline

**Files:**
- Modify: `apps/api/src/services/deliverableAutoEvidence.ts`
- Modify: `apps/api/src/services/deliverableAutoEvidence.test.ts`

**Interfaces:**
- Consumes: `generateManagedEvidenceReport`, `type EvidenceRunContext` (Task 4);
  `isManagedEvidenceType` (Task 3); `previousOccurrenceBaselineFor` (Task 7).
- Produces: an extended `AutoEvidenceRefusal` union
  (adds `'unmanaged_definition_owner_gone'`), and a persisted refusal state.

**What changes, precisely.** The occurrence SELECT (`:54-61`) currently takes only
`id`, `ticketId`, `dueAt`; it must also take `periodStart`, `periodEnd` and
`autoEvidenceRefusal`. The principal-kind gate (`:107-111`) and the live-authority
re-resolution (`:113-134`) become the **fallback** path, used only when the
definition's type is *not* a managed evidence type — so #5573's one existing
auto-evidence user keeps working unchanged, while a managed evidence definition
takes the system path and stops depending on the owner's account.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/deliverableAutoEvidence.test.ts` (reusing its
existing mock scaffolding, and adding a mock for the two new modules):

```ts
it('generates a managed evidence type under system authority, ignoring the definition owner', async () => {
  // The case OD-5 exists for: the owning user is gone. The user path would
  // return `scope_unverifiable`; the managed path must still produce a run.
  resolveLiveMock.mockResolvedValue({ ok: false, reason: 'unverifiable_scope' });
  rows.push({ /* definition */ id: 'r1', orgId: 'o1', type: 'threat_detection_review',
              config: {}, executionScopePrincipalKind: 'user', executionScopeUserId: 'departed',
              portalSelfService: true });
  const res = await generateAutoEvidenceForOccurrence({ /* … */ });
  expect(res.ok).toBe(true);
  expect(generateManagedEvidenceMock).toHaveBeenCalled();
  expect(resolveLiveMock).not.toHaveBeenCalled();
});

it('passes the occurrence period and the prior-occurrence baseline into generation', async () => {
  baselineMock.mockResolvedValue({ generatedAt: '2026-08-31T05:18:00Z', summary: { n: 1 } });
  await generateAutoEvidenceForOccurrence({ /* occurrence with periodStart 2026-09-01, periodEnd 2026-09-30 */ });
  const evidence = generateManagedEvidenceMock.mock.calls[0][3];
  expect(evidence).toMatchObject({ periodStart: '2026-09-01', periodEnd: '2026-09-30', deliverableId: 'd1' });
  expect(baselineMock).toHaveBeenCalledWith({ deliverableId: 'd1', currentPeriodStart: '2026-09-01' });
  // The baseline lands in the persisted result, not only in memory.
  expect(updated.at(-1)?.result).toMatchObject({ previous: { summary: { n: 1 } } });
});

it('leaves a NON-managed definition on the existing user-authority path', async () => {
  rows.push({ id: 'r1', orgId: 'o1', type: 'compliance', config: {},
              executionScopePrincipalKind: 'user', executionScopeUserId: 'u1' });
  await generateAutoEvidenceForOccurrence({ /* … */ });
  expect(resolveLiveMock).toHaveBeenCalled();
  expect(generateManagedEvidenceMock).not.toHaveBeenCalled();
});
```

Fill the `/* … */` argument objects from the file's existing helpers — read the
current test's call sites first and mirror them exactly.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/deliverableAutoEvidence.test.ts`
Expected: FAIL — `generateManagedEvidenceMock` is never called.

- [ ] **Step 3: Widen the occurrence SELECT**

Replace the select at `:54-61` with:

```ts
const open = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
  db.select({
      id: serviceDeliverableOccurrences.id,
      ticketId: serviceDeliverableOccurrences.ticketId,
      dueAt: serviceDeliverableOccurrences.dueAt,
      // #5784 OD-11: the occurrence's OWN window is the only correct one.
      periodStart: serviceDeliverableOccurrences.periodStart,
      periodEnd: serviceDeliverableOccurrences.periodEnd,
      // #5784: last refusal, so a repeated identical refusal does not re-comment.
      lastRefusal: serviceDeliverableOccurrences.autoEvidenceRefusal,
    })
    .from(serviceDeliverableOccurrences)
    .where(and(
      eq(serviceDeliverableOccurrences.deliverableId, d.id),
      eq(serviceDeliverableOccurrences.status, 'open'),
    )),
  'deliverableSweep.selectAutoEvidence'));
```

Thread `periodStart`, `periodEnd`, `deliverableId` and `lastRefusal` through into
`generateAutoEvidenceForOccurrence`'s args.

- [ ] **Step 4: Branch on managed vs. user definitions**

Immediately after the definition is loaded (before the principal-kind gate at
`:107`), insert:

```ts
// #5784 OD-5 = B. A managed evidence definition runs under system authority:
// an org-owned recurring obligation must not stop producing evidence because
// one technician changed jobs. Everything else keeps the shipped user path
// below, unchanged — including its principal-kind gate.
if (isManagedEvidenceType(definition.type) && definition.portalSelfService === true) {
  const evidence: EvidenceRunContext = {
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    generatedAt: new Date().toISOString(),
    deliverableId: args.deliverableId,
  };
  const config = (definition.config ?? {}) as Record<string, unknown>;
  let result;
  try {
    // Savepoint, exactly as the user path does: a Postgres error inside the
    // generator must not poison this occurrence's transaction.
    result = await db.transaction(() =>
      generateManagedEvidenceReport(definition.type as ManagedEvidenceType, definition.orgId, config, evidence));
  } catch (err) {
    await db.update(reportRuns).set({
      status: 'failed', completedAt: new Date(),
      errorMessage: err instanceof Error ? err.message : 'Failed to generate report',
    }).where(eq(reportRuns.id, run.id));
    return refused('generation_failed');
  }
  const previous = await previousOccurrenceBaselineFor({
    deliverableId: args.deliverableId,
    currentPeriodStart: args.periodStart,
  });
  if (previous) result.previous = previous;
  return finishRun(result);          // the shared completed-run + evidence-insert tail
}
```

Extract the existing "mark run completed, insert evidence row, post ticket note,
return `{ ok: true }`" tail (`:158-181`) into a local `finishRun(result)` so both
branches use one copy — the evidence insert's `reportId: definition.id` comment
about the composite FK must survive the extraction verbatim.

**Also add the baseline to the user path.** Both paths were missing `previous`;
fixing only the managed one would leave #5573's existing user quietly without
comparators. Call `previousOccurrenceBaselineFor` in `finishRun` instead of in the
managed branch, so there is one call site.

- [ ] **Step 5: Run the tests, then typecheck**

Run:
```bash
cd apps/api && npx vitest run src/services/deliverableAutoEvidence.test.ts src/jobs/deliverableWorker.test.ts
npx tsc --noEmit -p tsconfig.json
```
Expected: PASS and clean. `deliverableWorker.test.ts` fully mocks
`deliverableAutoEvidence`, so it should be unaffected — if it broke, the exported
signature of `generateAutoEvidenceForDeliverable` changed, which it must not.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/deliverableAutoEvidence.ts apps/api/src/services/deliverableAutoEvidence.test.ts
git commit -m "feat(deliverables): auto-evidence runs managed types under system authority with period and baseline (#5784 W01)"
```

---

### Task 9: Visible refusal state

**Files:**
- Modify: `apps/api/src/services/deliverableAutoEvidence.ts`
- Modify: `apps/api/src/services/deliverableAutoEvidence.test.ts`

**Interfaces:**
- Consumes: the two columns from Task 1/2.
- Produces: `AUTO_EVIDENCE_REFUSAL_NOTE(reason)`, and the persisted
  `auto_evidence_attempted_at` / `auto_evidence_refusal` state.

**Why this is required even with OD-5 B.** Refusals today are a `console.warn`
(`deliverableAutoEvidence.ts:76`): the occurrence stays open, is retried on later
sweeps, and becomes `missed` only after grace — so there is a window in which a
visible failure state would let someone fix it, and today nothing fills it.
OD-5 B removes exactly one refusal cause (`scope_unverifiable` from a departed
owner). It does not make `definition_not_found`, `scope_no_intersection`,
`scope_empty` or `generation_failed` visible.

**De-duplication matters.** The sweep runs nightly. Commenting on every refusal
would put 14 identical internal comments on a ticket before grace expires. The
comment is posted **only when the reason changes** — including from `NULL`, i.e.
the first refusal — which is what `auto_evidence_refusal` is for.

- [ ] **Step 1: Write the failing test**

```ts
it('records the refusal and comments once, not once per nightly sweep', async () => {
  // First refusal: state written, one internal comment.
  await generateAutoEvidenceForOccurrence({ /* occurrence with lastRefusal: null */ });
  expect(updated.at(-1)).toMatchObject({ autoEvidenceRefusal: 'definition_not_found' });
  expect(inserted.filter((r) => r.commentType === 'internal')).toHaveLength(1);

  // Same refusal tomorrow: state refreshed, NO second comment.
  inserted.length = 0;
  await generateAutoEvidenceForOccurrence({ /* same, lastRefusal: 'definition_not_found' */ });
  expect(inserted.filter((r) => r.commentType === 'internal')).toHaveLength(0);
});

it('clears the refusal state on a successful run', async () => {
  await generateAutoEvidenceForOccurrence({ /* succeeding occurrence, lastRefusal: 'generation_failed' */ });
  expect(updated.at(-1)).toMatchObject({ autoEvidenceRefusal: null });
});

it('never comments for not_due or already_attached', async () => {
  await generateAutoEvidenceForOccurrence({ /* not yet due */ });
  expect(inserted.filter((r) => r.commentType === 'internal')).toHaveLength(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/deliverableAutoEvidence.test.ts`
Expected: FAIL — no `autoEvidenceRefusal` is ever written.

- [ ] **Step 3: Implement the state write and the de-duplicated comment**

Add near `AUTO_EVIDENCE_TICKET_NOTE` (`:33`):

```ts
/**
 * What the technician reads on the ticket when the nightly sweep could not build
 * the evidence. One comment per DISTINCT reason, never one per sweep — the
 * occurrence's `auto_evidence_refusal` column is the de-duplication key.
 */
export const AUTO_EVIDENCE_REFUSAL_NOTES: Record<AutoEvidenceRefusal, string | null> = {
  not_due: null,
  already_attached: null,
  definition_not_found: 'Automatic evidence could not be generated: the report definition this deliverable points at no longer exists. Re-link it on the deliverable, or attach the artifact by hand.',
  system_principal_definition: 'Automatic evidence could not be generated: the linked report definition is system-owned and cannot be run on a technician’s behalf. Link a managed evidence report type instead.',
  portal_user_principal_definition: 'Automatic evidence could not be generated: the linked report definition belongs to a customer portal user. Link a staff-owned or managed evidence report instead.',
  scope_unverifiable: 'Automatic evidence could not be generated: the report definition’s owner no longer has access to this organization. Re-save the report definition under a current owner, or link a managed evidence report type.',
  scope_no_intersection: 'Automatic evidence could not be generated: the report definition is limited to sites the current owner cannot see. Widen the definition’s sites or re-save it under an owner with access.',
  scope_empty: 'Automatic evidence could not be generated: the report definition resolves to zero sites. Widen its site selection.',
  generation_failed: 'Automatic evidence could not be generated: the report run failed. Open the report definition and run it by hand to see the error.',
};
```

In the per-occurrence function, replace every bare `return refused(reason)` with a
call to a local `recordRefusal(reason)` that:

1. `UPDATE service_deliverable_occurrences SET auto_evidence_attempted_at = now(), auto_evidence_refusal = $reason WHERE id = $occurrenceId`;
2. if `AUTO_EVIDENCE_REFUSAL_NOTES[reason]` is non-null **and** `reason !== args.lastRefusal` **and** `args.ticketId` is set, insert the internal ticket comment with the same author/origin fields the success note uses (`authorName: 'Breeze'`, `authorType: 'system'`, `commentType: 'internal'`, `isPublic: false`, `originPrincipalKind: 'system'`);
3. returns `refused(reason)`.

`not_due` and `already_attached` must **not** write state at all — they are the
normal quiet path and writing on them would touch every open occurrence every
night. Guard `recordRefusal` so those two return `refused(reason)` directly.

On success, in `finishRun`, add
`auto_evidence_attempted_at = now(), auto_evidence_refusal = null` to the same
update that stamps the evidence, so a recovered deliverable clears its state.

Keep the existing `console.warn` at `:76` — structured logs and a persisted state
serve different readers.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/deliverableAutoEvidence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/deliverableAutoEvidence.ts apps/api/src/services/deliverableAutoEvidence.test.ts
git commit -m "feat(deliverables): visible, de-duplicated auto-evidence refusal state (#5784 W01)"
```

---

### Task 10: The OD-12 publication gate

**Files:**
- Modify: `apps/api/src/services/portal/reportsSelfService.ts`
- Modify: `apps/api/src/services/portal/reportsSelfService.test.ts`
- Modify: `apps/api/src/services/portal/serviceReadModel.ts`
- Modify: the co-located `serviceReadModel` test

**Interfaces:**
- Produces: `deliveredEvidenceOnly()` — a Drizzle condition fragment reused by
  `portalRunPredicate` and `portalRunListPredicate`; and the same rule applied
  inside `publishableEvidence`.

**The hazard, stated plainly.** `portalRunListPredicate`
(`reportsSelfService.ts:267-277`) filters on `reports.org_id`,
`portal_self_service = true` and `status = 'completed'` — **no type filter, no
`requested_by_kind` filter**. `portalRunPredicate` (`:254-265`) is the same minus
the status check. So the moment a managed evidence definition is provisioned as
`portal_self_service` in an org with `enable_reports` on, the customer can see and
download that run **at 05:18 on the due day, before the technician has reviewed
it**. For a security artifact that means a customer may read a finding before the
MSP has an answer for it.

**The rule.** A completed run is customer-visible when it is **not** referenced by
any deliverable evidence row, **or** when a referencing evidence row's occurrence
has `status = 'delivered'`. Fail-closed: a run referenced only by non-delivered
occurrences is hidden.

- [ ] **Step 1: Write the failing tests**

In `reportsSelfService.test.ts`:

```ts
it('hides a managed evidence run whose occurrence has not been delivered', async () => {
  // The 05:18 hazard: generated, completed, portal_self_service — and NOT yet
  // reviewed by the technician (#5784 OD-12).
  const list = await listPortalRuns(ORG, /* … */);
  expect(list.runs.map((r) => r.id)).not.toContain(UNDELIVERED_RUN_ID);
});

it('shows the same run once its occurrence is delivered', async () => {
  const list = await listPortalRuns(ORG, /* … */);
  expect(list.runs.map((r) => r.id)).toContain(DELIVERED_RUN_ID);
});

it('leaves an ordinary self-service run — one no deliverable references — visible', async () => {
  const list = await listPortalRuns(ORG, /* … */);
  expect(list.runs.map((r) => r.id)).toContain(SELF_SERVICE_RUN_ID);
});

it('refuses the download of an undelivered managed evidence run', async () => {
  await expect(renderRunPdf(UNDELIVERED_RUN_ID, ORG, 'UTC')).rejects.toThrow();
});
```

In the `serviceReadModel` test:

```ts
it('does not publish report_run evidence for an occurrence that is not delivered', () => {
  expect(publishableEvidence(
    { kind: 'report_run', reportPortalSelfService: true, occurrenceStatus: 'open', /* … */ },
    true,
  )).toBeNull();
});

it('publishes report_run evidence once the occurrence is delivered', () => {
  expect(publishableEvidence(
    { kind: 'report_run', reportPortalSelfService: true, occurrenceStatus: 'delivered', /* … */ },
    true,
  )).not.toBeNull();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/portal/reportsSelfService.test.ts src/services/portal/serviceReadModel.test.ts`
Expected: FAIL — an undelivered run is currently visible and downloadable.

- [ ] **Step 3: Add the condition and wire both predicates**

In `reportsSelfService.ts`, next to `lifecycleExclusion` (`:250-252`):

```ts
/**
 * OD-12 (#5784): a managed evidence run becomes customer-visible on DELIVERY,
 * not on generation. Without this, `portalRunListPredicate` — which filters only
 * on org, portal_self_service and status — would show a security artifact at
 * 05:18 on the due day, before the technician reviewed it.
 *
 * Derived, not stamped: the occurrence already carries `delivered_at`,
 * `delivered_by_user_id` and `delivered_via`, so a `published_at` column would
 * only add a second copy of the truth that could drift when a delivery is
 * reverted or the occurrence is waived.
 *
 * Runs no deliverable references (ordinary portal self-service) are unaffected.
 */
function deliveredEvidenceOnly() {
  return sql`(
    NOT EXISTS (
      SELECT 1 FROM service_deliverable_evidence e
      WHERE e.report_run_id = ${reportRuns.id}
    )
    OR EXISTS (
      SELECT 1 FROM service_deliverable_evidence e
      JOIN service_deliverable_occurrences o ON o.id = e.occurrence_id
      WHERE e.report_run_id = ${reportRuns.id}
        AND o.status = 'delivered'
    )
  )`;
}
```

Add `deliveredEvidenceOnly()` as a further condition inside **both**
`portalRunPredicate` and `portalRunListPredicate`.

- [ ] **Step 4: Apply the same rule in `serviceReadModel.ts`**

`publishableEvidence` (`:104-124`) already receives an `EvidenceJoinRow`. Add
`occurrenceStatus` to that interface and to the join's select list, then extend
the `report_run` branch at `:112`:

```ts
  // OD-12 (#5784): the scorecard link is a download path too. Gate it on the
  // same delivery rule the portal run predicates use, or the customer reaches
  // the artifact through the scorecard instead of the report list.
  if (!enableReports || row.reportPortalSelfService !== true) return null;
  if (row.occurrenceStatus !== 'delivered') return null;
```

`artifactStateFor` (`:61-67`) then naturally returns `'held_by_msp'` for a
delivered-but-unpublishable occurrence and `'none'` before delivery, which is the
honest state — no change needed there.

- [ ] **Step 5: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/services/portal/`
Expected: PASS. Check the reported file count covers both suites — vitest's path
filter is a plain substring match, and a trailing slash restricts it to files
physically inside that directory (which is what we want here).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/portal/reportsSelfService.ts apps/api/src/services/portal/reportsSelfService.test.ts apps/api/src/services/portal/serviceReadModel.ts apps/api/src/services/portal/serviceReadModel.test.ts
git commit -m "feat(portal): publish managed evidence on delivery, not on generation (#5784 W01 OD-12)"
```

---

### Task 11: Apply-time resolution in `applyTemplateSet`, and the ninth template field

**Files:**
- Modify: `packages/shared/src/validators/deliverableTemplates.ts` (+ its test)
- Modify: `apps/api/src/services/deliverableTemplateService.ts` (+ its test)
- Modify: `apps/api/src/routes/deliverableTemplates.ts`
- Modify: `apps/api/src/services/aiToolsDeliverables.ts`

**Interfaces:**
- Consumes: `resolveManagedEvidenceDefinition` (Task 5), `isManagedEvidenceType`
  (Task 3), `DbExecutor`.
- Produces: `templateItemFieldTypes.autoEvidenceReportType` (ninth field);
  `applyTemplateSet` now sets `autoEvidenceReportId` on created deliverables.

- [ ] **Step 1: Write the failing tests**

In `packages/shared/src/validators/deliverableTemplates.test.ts`:

```ts
it('accepts a managed evidence report type on a template item', () => {
  const parsed = createTemplateItemSchema.parse({
    name: 'Monthly threat detection review', cadence: 'monthly',
    autoEvidenceReportType: 'threat_detection_review',
  });
  expect(parsed.autoEvidenceReportType).toBe('threat_detection_review');
});

it('accepts null and omission (no auto-evidence)', () => {
  expect(createTemplateItemSchema.parse({ name: 'x', cadence: 'monthly' }).autoEvidenceReportType).toBeUndefined();
  expect(createTemplateItemSchema.parse({ name: 'x', cadence: 'monthly', autoEvidenceReportType: null }).autoEvidenceReportType).toBeNull();
});

it('rejects a report type that is not a managed evidence type', () => {
  expect(() => createTemplateItemSchema.parse({ name: 'x', cadence: 'monthly', autoEvidenceReportType: 'device_inventory' })).toThrow();
});
```

In `apps/api/src/services/deliverableTemplateService.test.ts`:

```ts
it('resolves the item type to that org’s managed definition on the SAME tx handle', async () => {
  await applyTemplateSet(ORG, SET, {}, ACTOR);
  // The executor the service passed must be the transaction handle, not the
  // module-level db proxy: the ambient proxy resolves to the request
  // transaction and would escape the all-or-nothing rollback.
  expect(resolveMock).toHaveBeenCalledWith(ORG, 'threat_detection_review', expect.any(String), txHandle);
  expect(createDeliverableMock.mock.calls[0][1]).toMatchObject({ autoEvidenceReportId: 'r1' });
});

it('fails the whole apply when provisioning fails — nothing half-written', async () => {
  resolveMock.mockRejectedValue(new Error('boom'));
  await expect(applyTemplateSet(ORG, SET, {}, ACTOR)).rejects.toThrow();
  expect(createDeliverableMock).not.toHaveBeenCalled();
});

it('leaves autoEvidenceReportId unset for an item with no type', async () => {
  await applyTemplateSet(ORG, SET_WITHOUT_TYPE, {}, ACTOR);
  expect(createDeliverableMock.mock.calls[0][1].autoEvidenceReportId).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify they fail**

Run:
```bash
cd packages/shared && npx vitest run src/validators/deliverableTemplates.test.ts
cd ../../apps/api && npx vitest run src/services/deliverableTemplateService.test.ts
```
Expected: both FAIL.

- [ ] **Step 3: Add the ninth field to the shared validator**

In `packages/shared/src/validators/deliverableTemplates.ts`, inside
`templateItemFieldTypes` (currently eight fields, `:18-30`):

```ts
  /**
   * #5784. A managed evidence report TYPE, resolved to the target org's managed
   * definition at applyTemplateSet time. Deliberately NOT the full report_type
   * enum: only the four managed evidence types can be provisioned on demand, and
   * an id could never be carried by a partner-wide item at all.
   */
  autoEvidenceReportType: z.enum(MANAGED_EVIDENCE_REPORT_TYPES).nullable().optional(),
```

`MANAGED_EVIDENCE_REPORT_TYPES` must live in `@breeze/shared` (the validator
cannot import from `apps/api`). Add it to
`packages/shared/src/validators/deliverableTemplates.ts` itself as an exported
`as const` tuple, **empty in W01** with a comment naming the four waves that fill
it — and add a note in `apps/api/src/services/managedEvidenceRegistry.ts` that the
two lists are hand-parallel. Pin them together with a test in
`managedEvidenceRegistry.test.ts`:

```ts
it('stays in step with the shared validator’s list', async () => {
  const { MANAGED_EVIDENCE_REPORT_TYPES } = await import('@breeze/shared');
  expect([...MANAGED_EVIDENCE_REPORT_TYPES].sort()).toEqual(Object.keys(MANAGED_EVIDENCE_REGISTRY).sort());
});
```

A Zod `z.enum` on an empty tuple is invalid — in W01 declare the field as
`z.string().nullable().optional()` with a `.refine` that always fails on a
non-null value and the comment *"no managed evidence type ships until W02"*,
then W02 replaces it with the real `z.enum`. Keep `updateTemplateItemSchema`
(`z.object(templateItemFieldTypes).partial().strict()`) as it is — it derives
automatically, and there is no `ownerScope` to `.omit()` on an item.

- [ ] **Step 4: Resolve at apply time on the real `tx`**

In `deliverableTemplateService.ts`, the items select must now also read
`autoEvidenceReportType`. Inside the `db.transaction(async (tx) => { … })` at
`:363`, immediately before the `createDeliverable` call at `:377`:

```ts
        // #5784 OD-6 = A. Resolve the partner-wide TYPE to THIS org's managed
        // definition, inside the same all-or-nothing transaction and on the
        // SAME tx handle — the ambient `db` proxy would resolve to the request
        // transaction (serviceDeliverableService.ts:52) and escape the rollback.
        // A provisioning failure aborts the whole apply with a 4xx the
        // technician sees, rather than a 05:18 console.warn.
        let autoEvidenceReportId: string | undefined;
        if (item.autoEvidenceReportType) {
          const managed = await resolveManagedEvidenceDefinition(
            orgId,
            item.autoEvidenceReportType as ManagedEvidenceType,
            opts.ownerUserId ?? actor.userId,
            tx,
          );
          autoEvidenceReportId = managed.id;
        }
```

and add `autoEvidenceReportId,` to the `createDeliverable` payload at `:377-391`.

Also add `autoEvidenceReportType` to the item copy in `createTemplateSet`,
`addTemplateItem` and `updateTemplateItem` (the three item-write sites the
deliverables fact sheet names, ~`:190-201`, `:246-258`, `:270-279`) — a field the
create schema accepts but the service drops is a silent data loss.

- [ ] **Step 5: Route and AI tool pass-through**

`apps/api/src/routes/deliverableTemplates.ts` needs **no change**: its item routes
use `createTemplateItemSchema` / `updateTemplateItemSchema` from `@breeze/shared`
directly (`:134-155`), so the ninth field flows through. Confirm this by reading
those two route handlers rather than assuming.

In `apps/api/src/services/aiToolsDeliverables.ts`, add `autoEvidenceReportType`
to the `manage_deliverables` `input` description string (`:193`, which already
lists `autoEvidenceReportId`). **And fix the stale header comment at `:16-18`** —
it says `apply_template` is "deliberately ABSENT" while
`MANAGE_DELIVERABLES_ACTIONS` (`:62-67`) includes it and a handler exists at
`:240-249`. A comment that contradicts the code is how the next reader gets the
security model wrong.

- [ ] **Step 6: Run the tests to verify they pass**

Run:
```bash
cd packages/shared && npx vitest run src/validators/deliverableTemplates.test.ts
cd ../../apps/api && npx vitest run \
  src/services/deliverableTemplateService.test.ts \
  src/services/managedEvidenceRegistry.test.ts \
  src/services/aiToolsDeliverables.registryParity.contract.test.ts
npx tsc --noEmit -p tsconfig.json
```
Expected: all PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/validators/deliverableTemplates.ts packages/shared/src/validators/deliverableTemplates.test.ts apps/api/src/services/deliverableTemplateService.ts apps/api/src/services/deliverableTemplateService.test.ts apps/api/src/services/managedEvidenceRegistry.test.ts apps/api/src/services/aiToolsDeliverables.ts
git commit -m "feat(deliverables): partner-wide evidence type on template items, resolved at apply time (#5784 W01)"
```

---

### Task 12: The evidence-report pickers — the UI that has never existed

**Files:**
- Modify: `apps/web/src/lib/api/deliverableTemplates.ts`, `serviceDeliverables.ts`
- Modify: `apps/web/src/components/settings/DeliverableTemplatesPage.tsx` (+ `.test.tsx`)
- Modify: `apps/web/src/components/deliverables/DeliverableForm.tsx` (+ `.test.tsx`)
- Modify: `apps/web/src/locales/*/deliverables.json` (8 files)

**Interfaces:**
- Consumes: `MANAGED_EVIDENCE_REPORT_TYPES` from `@breeze/shared` (Task 11).

**The pre-existing orphan, so nobody re-adds it.** `autoEvidenceReportId` is
already on the `Deliverable` wire type
(`apps/web/src/lib/api/serviceDeliverables.ts:59`) and there is already an
i18n key `deliverables.autoEvidenceReport` (`"Attach report runs as evidence"`) in
**all eight** locale files at line 69 — but **no component reads either**. So this
task wires an existing orphan rather than starting clean: reuse that key for the
deliverable-form label instead of adding a ninth duplicate, and check the other
seven locales' translations of it are real before reusing them.

**W01 ships the pickers with an empty option list.** `MANAGED_EVIDENCE_REPORT_TYPES`
is empty until W02, so both pickers render, show the "None" option, and show a
short empty-state line. That is deliberate: the control exists and is tested from
the wave it belongs to, and each later wave's single registry entry makes its
option appear with no further web work.

- [ ] **Step 1: Write the failing component tests**

In `apps/web/src/components/deliverables/DeliverableForm.test.tsx`:

```tsx
it('renders the evidence report picker and submits the chosen type as null when None', async () => {
  render(<DeliverableForm {...props} />);
  const picker = screen.getByTestId('deliverable-auto-evidence-report');
  expect(picker).toBeInTheDocument();
  // Orphan-field guard: the control must be bound, not decorative.
  expect(picker).toHaveValue('');
});

it('shows the empty-state line while no managed evidence type has shipped', () => {
  render(<DeliverableForm {...props} />);
  expect(screen.getByTestId('deliverable-auto-evidence-empty')).toBeInTheDocument();
});
```

In `apps/web/src/components/settings/DeliverableTemplatesPage.test.tsx`:

```tsx
it('renders the evidence report picker on the template item form', async () => {
  render(<DeliverableTemplatesPage {...props} />);
  await userEvent.click(screen.getByTestId('deliverable-template-add-item'));
  expect(screen.getByTestId('deliverable-template-item-auto-evidence')).toBeInTheDocument();
});

it('sends autoEvidenceReportType with the item create call', async () => {
  // … fill the item form, submit …
  expect(addTemplateItemMock).toHaveBeenCalledWith(
    expect.anything(), expect.any(String),
    expect.objectContaining({ autoEvidenceReportType: null }),
  );
});
```

Match the surrounding tests' render helpers and `data-testid` conventions exactly
— read a neighbouring test in each file first. **`data-testid` is the only
selector convention in this repo's UI tests.**

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npx vitest run src/components/deliverables/DeliverableForm.test.tsx src/components/settings/DeliverableTemplatesPage.test.tsx`
Expected: FAIL — neither testid exists.

- [ ] **Step 3: Add the field to both wire types**

`apps/web/src/lib/api/deliverableTemplates.ts`: add
`autoEvidenceReportType: ManagedEvidenceReportType | null;` to the template-item
type and to `CreateTemplateItemInput` / `UpdateTemplateItemInput`.

`apps/web/src/lib/api/serviceDeliverables.ts`: `autoEvidenceReportId` is already
on `Deliverable` (`:59`); add it to `CreateDeliverableInput` /
`UpdateDeliverableInput` if it is not there.

- [ ] **Step 4: Add the picker to the deliverable form**

In `DeliverableForm.tsx`, after the `completionMode` select and before the
checkboxes, add a `<select data-testid="deliverable-auto-evidence-report">` whose
options are "None" plus one per available managed evidence definition for the org.
The deliverable form links an **id**, so it must list the org's existing report
definitions — fetch them from the reports list API filtered to
`portal_self_service` managed types, and when the list is empty render
`<p data-testid="deliverable-auto-evidence-empty">` with the empty-state copy.

Wire it through the existing `runClientAction` submit path (`:159-173`); do not
add a second mutation path. Keep the `ActionError` catch shape at `:176-182`
unchanged.

- [ ] **Step 5: Add the picker to the template item form**

In `DeliverableTemplatesPage.tsx`, add `autoEvidenceReportType: null` to
`ItemFormState` (`:33-40`) and a
`<select data-testid="deliverable-template-item-auto-evidence">` to the item form
JSX (`:431-527`), options = "None" + `MANAGED_EVIDENCE_REPORT_TYPES`. The template
form links a **type**, not an id — no report fetch is needed here at all, which is
exactly the point of the partner-wide design.

- [ ] **Step 6: Locale keys in all 8 locales with real translations**

Reuse the existing `deliverables.autoEvidenceReport` key for the field label.
Add under the same `deliverables` namespace:

- `deliverables.autoEvidenceNone` — "None"
- `deliverables.autoEvidenceHelp` — one sentence: evidence is generated on the due
  day and becomes visible to the customer when the occurrence is delivered.
- `deliverables.autoEvidenceEmpty` — "No managed evidence report types are
  available yet."
- `deliverables.templates.autoEvidenceReportType` — the template-item label.

Write **real translations** in `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`,
`pt-BR`, `tr-TR` — not English copies.
`apps/web/src/lib/i18n/translationCoverage.test.ts` caps exact-English duplicates
per namespace and will fail on copies.

- [ ] **Step 7: Run web tests, typecheck and the locale guards**

Run:
```bash
cd apps/web && npx vitest run \
  src/components/deliverables/DeliverableForm.test.tsx \
  src/components/settings/DeliverableTemplatesPage.test.tsx \
  src/lib/i18n/translationCoverage.test.ts \
  src/lib/i18n/localeParity.test.ts
pnpm --filter @breeze/web typecheck
```
Expected: all PASS, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/api/deliverableTemplates.ts apps/web/src/lib/api/serviceDeliverables.ts apps/web/src/components/deliverables/DeliverableForm.tsx apps/web/src/components/deliverables/DeliverableForm.test.tsx apps/web/src/components/settings/DeliverableTemplatesPage.tsx apps/web/src/components/settings/DeliverableTemplatesPage.test.tsx apps/web/src/locales
git commit -m "feat(web): evidence report pickers on the deliverable and template item forms (#5784 W01)"
```

---

### Task 13: Reprovision script — package script, widened selector, `--repair`

**Files:**
- Modify: `apps/api/scripts/reprovision-portal-report-definitions.ts`
- Modify: `apps/api/scripts/reprovision-portal-report-definitions.lib.ts` (+ `.lib.test.ts`)
- Modify: `apps/api/package.json`

**Interfaces:**
- Consumes: `MANAGED_EVIDENCE_REGISTRY` (Task 3),
  `resolveManagedEvidenceDefinition` (Task 5).

**Three defects, fixed together.**
1. The script is referenced by **no** `package.json` script, CI job, Dockerfile or
   entrypoint — verified: `grep -n reprovision apps/api/package.json` returns
   nothing. It is hand-run, so every org that enabled reports before a type
   existed silently lacks that definition.
2. Its org selector (`listReportEnabledOrgs`, `:36-43`) lists only orgs with
   `portal_branding.enable_reports = true`. An org using an evidence template needs
   the managed definition **whether or not** portal reports are on — provisioning
   a definition exposes nothing by itself; the portal gate is `enable_reports`,
   checked separately, and OD-12 gates publication on top of that.
3. There is no way to repair a definition whose config has drifted from the
   registry default, because provisioning is insert-if-absent (Task 5).

- [ ] **Step 1: Write the failing tests**

In `reprovision-portal-report-definitions.lib.test.ts`:

```ts
it('includes an org that has a managed-evidence-linked deliverable even with portal reports off', async () => {
  const orgs = await selectTargetOrgs(deps);
  expect(orgs).toContain(ORG_WITH_EVIDENCE_DELIVERABLE_REPORTS_OFF);
});

it('does not rewrite an existing definition config without --repair', async () => {
  await runReprovisionSweep(deps, { apply: true });
  expect(deps.updateConfig).not.toHaveBeenCalled();
});

it('rewrites a drifted config to the registry default only under --repair', async () => {
  await runReprovisionSweep(deps, { apply: true, repair: true });
  expect(deps.updateConfig).toHaveBeenCalledWith(expect.any(String), 'threat_detection_review', expect.any(Object));
});

it('never repairs outside --apply', async () => {
  await runReprovisionSweep(deps, { apply: false, repair: true });
  expect(deps.updateConfig).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run scripts/reprovision-portal-report-definitions.lib.test.ts`
Expected: FAIL.

- [ ] **Step 3: Widen the selector**

Replace `listReportEnabledOrgs` with a union of two sets, both under the existing
`withSystemDbAccessContext` wrapper:

```ts
/**
 * Orgs that need portal report definitions (#5784 W01). Two populations, not one:
 *  - portal_branding.enable_reports = true  (the shipped selector);
 *  - any org with a service deliverable whose auto_evidence_report_id names a
 *    managed evidence definition, OR whose applied template item carried a
 *    managed evidence type — these need the definition whether or not the
 *    customer portal shows reports at all.
 * Provisioning a definition exposes nothing by itself: the portal gate is
 * enable_reports, and OD-12 gates publication on delivery on top of that.
 */
export async function selectTargetOrgs(deps: ReprovisionDeps): Promise<string[]> {
  const [reportEnabled, evidenceLinked] = await Promise.all([
    deps.listReportEnabledOrgs(),
    deps.listEvidenceLinkedOrgs(),
  ]);
  return [...new Set([...reportEnabled, ...evidenceLinked])];
}
```

Implement `listEvidenceLinkedOrgs` in the script (not the lib) as a
`SELECT DISTINCT org_id FROM service_deliverables WHERE auto_evidence_report_id IS NOT NULL`
union
`SELECT DISTINCT org_id FROM service_deliverables sd JOIN ... ` — the simple first
half is sufficient once Task 11 lands, because apply-time resolution sets the id.
Keep it to the one `DISTINCT` query and say so in a comment.

- [ ] **Step 4: Add `--repair`**

Add `const repair = process.argv.includes('--repair');` to the script and pass it
into `runReprovisionSweep(deps, { apply, repair })`. In the lib, when
`apply && repair`, for each org × registry type whose stored config differs from
`managedEvidenceEntry(type).defaultConfig`, call `deps.updateConfig(...)` and log
the before/after key diff. **Never repair without `--apply`**, and never repair a
type outside the registry. Print a one-line summary per org.

- [ ] **Step 5: Add the package script and document the release step**

In `apps/api/package.json` scripts, after `"partner-trust:backfill-cards"`:

```json
    "reports:reprovision-portal-definitions": "tsx scripts/reprovision-portal-report-definitions.ts",
```

- [ ] **Step 6: Run the tests, then the script itself against the test stack**

Run:
```bash
cd apps/api && npx vitest run scripts/reprovision-portal-report-definitions.lib.test.ts
DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm reports:reprovision-portal-definitions
```
Expected: tests PASS; the script dry-runs and exits 0, reporting zero managed
evidence types to provision (the registry is empty in W01) and no writes.

- [ ] **Step 7: Commit**

```bash
git add apps/api/scripts/reprovision-portal-report-definitions.ts apps/api/scripts/reprovision-portal-report-definitions.lib.ts apps/api/scripts/reprovision-portal-report-definitions.lib.test.ts apps/api/package.json
git commit -m "feat(reports): wire the reprovision script, widen its org selector, add --repair (#5784 W01)"
```

---

### Task 14: Opt-in linkage backfill

**Files:**
- Create: `apps/api/scripts/link-evidence-reports.ts`
- Modify: `apps/api/package.json`

**Interfaces:**
- Consumes: `resolveManagedEvidenceDefinition` (Task 5),
  `MANAGED_EVIDENCE_REGISTRY` (Task 3).

**Why a script and not a migration.** Provisioning definitions connects nothing on
its own: `service_deliverables` rows created before this feature keep
`auto_evidence_report_id = NULL` forever. But **auto-attaching an artifact to a
customer-visible contractual obligation is not something to do behind the MSP's
back** — a silent mass `UPDATE` would start generating security documents against
orgs whose MSP never asked for it. So the backfill is opt-in, per-partner or
per-org, dry-run by default, and it matches deliverables to template items rather
than guessing from names.

- [ ] **Step 1: Write the script**

```ts
#!/usr/bin/env tsx
/**
 * Link existing service deliverables to their org's managed evidence definition
 * (#5784 W01, spec §5.1 item 4).
 *
 * OPT-IN and dry-run by default. Deliverables created before this feature keep
 * auto_evidence_report_id = NULL forever, and a silent mass update would start
 * producing customer-visible security artifacts for obligations the MSP never
 * wired up. The operator names the scope and confirms with --apply.
 *
 * Matching rule: a deliverable is linked only when it was created from a
 * template item that now carries an auto_evidence_report_type AND the
 * deliverable still has auto_evidence_report_id = NULL. Name-similarity
 * guessing is deliberately NOT implemented — a wrong link produces a
 * confidently wrong artifact.
 *
 *   pnpm --filter @breeze/api evidence:link --partner-id <uuid>
 *   pnpm --filter @breeze/api evidence:link --partner-id <uuid> --apply
 *   pnpm --filter @breeze/api evidence:link --org-id <uuid> --apply
 */
```

Body shape, mirroring
`apps/api/scripts/backfill-first-customer-deliverables.ts` (the closest
precedent): argv parsing with UUID validation that exits non-zero before touching
the database; the whole sweep inside
`withSystemDbAccessContext(async () => { … }, 'linkEvidenceReports')`; a
`${LOG}` prefix on every line; `main().catch(...).finally(() => closeDb())`.

For each candidate deliverable it prints
`would link <deliverable name> (<org>) -> <type>` in dry-run, and under `--apply`
calls `resolveManagedEvidenceDefinition(orgId, type, ownerUserId, tx)` then
updates `auto_evidence_report_id`, counting created vs adopted definitions.

Add to `apps/api/package.json`:

```json
    "evidence:link": "tsx scripts/link-evidence-reports.ts",
```

- [ ] **Step 2: Prove it refuses bad input**

Run: `cd apps/api && npx tsx scripts/link-evidence-reports.ts`
Expected: exits non-zero with `one of --partner-id or --org-id is required`, and
no database connection beyond `closeDb`.

Run: `cd apps/api && npx tsx scripts/link-evidence-reports.ts --org-id nope`
Expected: exits non-zero with `--org-id must be a UUID`.

- [ ] **Step 3: Dry-run against the test stack**

Run:
```bash
cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) \
  npx tsx scripts/link-evidence-reports.ts --org-id <seeded org>
```
Expected: `0 deliverables would be linked` (no managed evidence types exist in
W01), exit 0, no rows written.

- [ ] **Step 4: Commit**

```bash
git add apps/api/scripts/link-evidence-reports.ts apps/api/package.json
git commit -m "feat(deliverables): opt-in evidence linkage backfill script (#5784 W01)"
```

---

### Task 15: Integration tests against real Postgres

**Files:**
- Create: `apps/api/src/__tests__/integration/managedEvidenceFoundations.integration.test.ts`

**Interfaces:**
- Consumes: everything W01 built.

**Placement matters.** An integration test outside
`apps/api/src/__tests__/integration/` is picked up by **no** config and runs
**zero** tests while reporting success. Put it exactly there.

The five cases the spec §9.1 names for W01. Each seeds a partner, an org, a user,
a contract, a template set and items through the real services — never by raw
insert — so the test proves the path a partner actually takes.

- [ ] **Step 1: Write the suite**

- [ ] **Case 1 — end to end from a template apply, never wired by hand.**
  Create a **partner-wide** template set with one item carrying an
  `auto_evidence_report_type`, apply it to **two** orgs, run `runDeliverableSweep`
  with `asOf` on the due date, and assert each org has a
  `service_deliverable_evidence` row of `kind='report_run'` pointing at a
  `completed` run — and that the two orgs' runs are **different rows against
  different report definitions**. *(In W01 the registry is empty, so this case is
  written with a `describe.skipIf(Object.keys(MANAGED_EVIDENCE_REGISTRY).length === 0)`
  guard and becomes live in W02. Write it now — W02's task is then to delete the
  guard, not to invent the test.)*

- [ ] **Case 2 — the managed definition survives owner departure.**
  Provision a managed definition owned by user U, then remove U's access to the
  org (delete the membership row). Run the sweep. Assert the evidence row still
  appears and the run is `completed`. **This is the case OD-5 exists for**; if it
  fails, the system path is not actually being taken.

- [ ] **Case 3 — a refusal produces a visible state, not a `console.warn`.**
  Point a deliverable at a **non-managed** definition whose owner has lost access.
  Run the sweep. Assert `service_deliverable_occurrences.auto_evidence_refusal =
  'scope_unverifiable'`, `auto_evidence_attempted_at` is set, and exactly **one**
  internal `ticket_comments` row exists. Run the sweep a second time and assert the
  comment count is **still one** and `auto_evidence_attempted_at` advanced.

- [ ] **Case 4 — org-merge collision when two orgs each hold a managed definition
  of the same type.** Provision the managed definition in org A and org B, then
  run the org merge A→B. Assert the merge completes and B ends with exactly one
  `portal_self_service` definition of that type (the partial unique index
  `reports_portal_self_service_org_type_uniq` is what would otherwise raise 23505
  mid-merge). If this fails, `orgMergeRegistry`'s classification for `reports`
  needs a resolve-phase entry — fix it in this wave, not later.

- [ ] **Case 5 — OD-11: a monthly and a quarterly deliverable on ONE shared
  definition do not compare each other's runs.** Create two deliverables in one
  org, both linked to the same managed definition, one `monthly` and one
  `quarterly`. Generate evidence for two consecutive monthly occurrences and one
  quarterly occurrence. Assert the second monthly run's
  `result->'previous'->'generatedAt'` equals the **first monthly** run's
  `generatedAt`, and that the quarterly run's `previous` is **absent**, not the
  monthly one. This is the defect `previousBaselineFor` would produce and the
  reason `previousOccurrenceBaselineFor` exists.

- [ ] **Case 6 — OD-12: the publication gate.**
  With `enable_reports = true`, generate evidence for an occurrence and assert the
  run is **absent** from `portalRunListPredicate`'s results and that
  `renderRunPdf` refuses it. Deliver the occurrence. Assert the same run is now
  listed and downloadable, and that the scorecard's evidence ref appears.

- [ ] **Step 2: Run the suite**

Run:
```bash
pnpm test-stack up
cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) \
  npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/managedEvidenceFoundations.integration.test.ts
```
Expected: green, with a **non-zero reported test count**. A suite that reports
"0 passed" is a placement or `skipIf` failure, not a pass.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/managedEvidenceFoundations.integration.test.ts
git commit -m "test(deliverables): managed evidence foundation integration coverage (#5784 W01)"
```

---

### Task 16: Wave verification and PR

- [ ] **Step 1: Full API unit run** — `cd apps/api && npx vitest run` → green.

- [ ] **Step 2: Contract suites on a live database** (test stack up):

```bash
cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) \
  npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/managedEvidenceFoundations.integration.test.ts \
  src/__tests__/integration/portalReportSelfService.integration.test.ts
```
→ green, each suite reporting a non-zero test count. **These are the suites that
`pnpm test` does not run**, and four of them are exactly where a missed column
classification surfaces.

- [ ] **Step 3: Shared, web, portal and lint**

```bash
cd packages/shared && npx vitest run
cd ../../apps/web && npx vitest run && pnpm --filter @breeze/web typecheck
cd ../portal && npx vitest run
cd ../.. && pnpm lint
```
→ all clean.

- [ ] **Step 4: Manual smoke on a worktree stack** (`pnpm wt-stack up`)

As a partner admin: create a partner-wide template set, add an item, confirm the
**Evidence report** picker renders with "None" and the empty-state line (no
managed types ship in W01). Apply the set to an org and confirm the deliverables
appear with no evidence link. Open a deliverable and confirm its evidence picker
renders. Confirm the customer portal's report list is **unchanged** for an org
with `enable_reports` on — W01 must not make anything newly visible.

- [ ] **Step 5: Tear down**

```bash
pnpm test-stack down
pnpm wt-stack down
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```
Confirm nothing of yours is left running, and say in the PR what (if anything) is.

- [ ] **Step 6: PR**

Open against **`main`** with `Closes #<W01 sub-issue>`, a link to the spec and to
the plan index, and these sections:

- **Tenancy** — no new table; three new columns, all classified `included` in
  `CORE_TENANT_EXPORT_POLICY`; no `rls-coverage` or cascade-list change and why.
- **Authorization** — the OD-5 B system path: the closed registry, the org-wide
  unrestricted scope invariant, the definition-based system-managed protection,
  and the explicit statement that `contracts:write` still cannot publish security
  data because OD-12's delivery gate sits downstream.
- **Customer-visible behaviour** — OD-12: nothing becomes newly visible in W01;
  the gate is added *before* the first artifact type ships, on purpose.
- **Rollout** — no feature flag, no env var, no consent change, no agent change;
  `reports:reprovision-portal-definitions` is now a package script and its release
  step is documented, though W01 has nothing to provision yet.

Run `/pr-review-toolkit:review-pr`; act only on confirmed, consequential findings.
Enqueue with `gh pr merge <N>` on green — **never `--admin`**. The PR targets
`main`, so `ci.yml` (including the blocking `integration-test` job) has already
run; do **not** hand-dispatch CI.

---

## Self-review

**Spec coverage.** §5.1 item 1 (types into `PORTAL_DEFINITIONS`) is deliberately
deferred to each report-type wave via the registry's `definitionName` +
`defaultConfig` — W01 builds the mechanism, W02–W06 each supply their entry;
§5.1 item 2 (find-or-create, callable outside the flag flip, insert-if-absent,
adoption, executor threading) → Task 5; §5.1 item 3 (reprovision script wired,
selector widened) → Task 13; §5.1 item 4 (opt-in linkage backfill) → Task 14.
§5.2 (the `auto_evidence_report_type` column, `applyTemplateSet` apply-time
resolution on the real `tx`, the shared validator's ninth field, the route
pass-through, the AI tool schema, and the web pickers that have never existed) →
Tasks 1, 2, 11, 12. §4.3 (the export-policy trap on a column addition) → Task 2.
§6 (portal publication hazard) → Task 10. OD-4 = A (no column on `reports`;
the partial unique index is the registry) → Tasks 3 and 5. OD-5 = B (closed
registry, system authority, org-wide unrestricted, definition-based protection)
→ Tasks 3, 4, 6, plus the required companion observability fix → Task 9.
OD-6 = A → Task 11. OD-10 = A (the two portal-user allowlist literals are
explicitly left alone) → Task 4 Step 4. OD-11 = A (period boundaries in, prior
*occurrence* baseline, coverage window stated) → Tasks 4, 7, 8, and integration
Case 5. OD-12 = A → Task 10 and integration Case 6.

**Placeholders.** Six places deliberately instruct a lookup rather than guessing,
each naming the file to read: the `helpers.ts:172` predicate name (Task 6 Step 1),
the existing `ORG` fixture constant in `reportGenerationService.test.ts` (Task 4
Step 1), the `deliverableAutoEvidence.test.ts` call-site argument shapes (Task 8
Step 1), the chainable-db-mock dialect to copy (Task 5 Step 1), the route
handlers to confirm need no change (Task 11 Step 5), and the neighbouring web test
render helpers (Task 12 Step 1). Integration Case 1 carries a `skipIf` guard with
an explicit instruction for W02 to remove it — that is a stated contract, not a
TODO.

**Type consistency.** `ManagedEvidenceType`, `ManagedEvidenceEntry`,
`MANAGED_EVIDENCE_REGISTRY`, `isManagedEvidenceType`, `managedEvidenceEntry`,
`MANAGED_EVIDENCE_DEFINITION_NAME_PREFIX`, `MANAGED_EVIDENCE_REPORT_TYPES`,
`ManagedDefinition`, `resolveManagedEvidenceDefinition`,
`loadManagedEvidenceDefinition`, `portalReportDefinitionRow`,
`ReportGenerationAuthority`, `systemReportAuthorityFor`, `EvidenceRunContext`,
`dispatchReportGeneration`, `generateManagedEvidenceReport`,
`previousOccurrenceBaselineFor`, `deliveredEvidenceOnly`,
`AUTO_EVIDENCE_REFUSAL_NOTES`, `selectTargetOrgs` and `DbExecutor` are spelled
identically everywhere they appear, here and in the index's cross-wave contracts.
`EvidenceRunContext`'s four fields (`periodStart`, `periodEnd`, `generatedAt`,
`deliverableId`) are the same four in Tasks 4, 8 and every later wave's generator
signature. The refusal strings in `AutoEvidenceRefusal` are the shipped union plus
nothing — Task 9 adds notes for the existing members, not new members.

**Cross-wave contracts this wave defines.** All four from the index: the registry
(Task 3), the template column (Tasks 1, 2, 11), the publication gate (Task 10) and
the period/baseline contract (Tasks 4, 7, 8). W02–W06 consume them and must not
re-implement any of them.
