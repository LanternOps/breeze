---
# tracking_issue is added by `register_feature` at Stage 4 registration.
spec: docs/superpowers/specs/billing/2026-09-14-ticket-checklists-spec.md
issue: LanternOps/breeze#5783
---
# Ticket Checklists W03: Deliverable Instructions, Sweep Seeding, the Occurrence Drawer, AI and the Portal No-Leak Proof — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seeding chain — a deliverable template item carries internal instructions and a checklist template, `applyTemplateSet` copies both onto the deliverable, and the daily sweep materializes them onto the ticket it opens — while proving, with a standing test, that none of it ever reaches the customer portal.

**Architecture:** One idempotent migration adds `instructions` and `checklist_template_id` to `service_deliverables` and `deliverable_template_items`, both FKs deliberately **single-column** (a composite `(checklist_template_id, org_id)` FK would make a partner-wide template unreferenceable) with app-layer validation and two 409 guards standing in. `openOneOccurrence` gains two writes inside its existing per-occurrence transaction: the template's items copied as `ticket_checklist_items` stamped with the **deliverable's** org, and the `instructions` posted as a point-in-time internal comment snapshot. The MSP occurrence list gains a `{ done, total }` chip; the portal gains nothing, and a four-surface assertion holds that line.

**Tech Stack:** PostgreSQL + hand-written SQL migrations, Drizzle ORM, Hono + Zod (`@breeze/shared` validators), Vitest (API unit with Drizzle mocks; API integration on real Postgres), Astro + React islands, react-i18next, Testing Library.

**Spec:** `docs/superpowers/specs/billing/2026-09-14-ticket-checklists-spec.md` (approved 2026-09-14; OD-3 settled as **A** — a live `checklist_template_id` pointer, with deletion of an in-use template refused). Sections 3.2, 4.4, 4.5 (the export-policy **column** row), 5, 6.3, 6.4, 6.5, 7 (drawer + forms), 9 are this wave.

**Depends on:** W01 (`ticketChecklistItems`, `ticketChecklistService.ts`, `TicketChecklistCard`) and W02 (`ticketChecklistTemplates`, `ticketChecklistTemplateItems`, `ticketChecklistTemplateService.ts`).

## Global Constraints

- **The portal shows nothing** — no steps, no instructions, no progress count (spec §5). `serviceReadModel.ts` never selects the new columns; the checklist routes are `requireScope('partner','system')`; and **nothing may ever auto-append a checklist summary, a step label or instructions text to a resolution note or a delivery note**. That last one is the leak that would actually have shipped: `resolutionNote` is copied verbatim into `serviceDeliverableOccurrences.deliveryNote` (`services/serviceDeliverableService.ts:737`) and the portal publishes `deliveryNote` as `note` on both the scorecard (`services/portal/serviceReadModel.ts:337`) and the occurrence list (`:466`).
- **Instructions are internal-only.** Not a product preference — Todd's decision, upstream of the spec and not open.
- **The two new FKs are single-column, deliberately.** A composite `(checklist_template_id, org_id) → ticket_checklist_templates(id, org_id)` would make a **partner-wide** template unreferenceable: `service_deliverables.org_id` is `NOT NULL` while a partner-wide template's `org_id` is `NULL`, so no row could ever match — defeating the entire Partner-Wide First point of the feature. The repo's established answer for "an org-scoped row references a possibly-partner-wide config row" is app-layer validation (`validateFeaturePolicyExists` / `PARTNER_LINKABLE_FEATURE_TYPES` in `services/configurationPolicy.ts`). This is recorded as a deliberate deviation from "every FK to a tenant row is composite with `org_id`", **with the reason, in the migration header**, and both rules get a real-Postgres test.
- **Reference validation fails with 404, never 403.** A template belonging to another tenant and a non-existent template must be indistinguishable.
- **Worker-created child rows always take the DEVICE's/subject's org.** The sweep stamps `ticket_checklist_items.org_id` with the **deliverable's** org, never the template's — which is NULL for a partner-wide template.
- **Seeding happens inside the existing per-occurrence transaction.** A failure must roll the claim back so the occurrence retries tomorrow, rather than stranding it `open` with a ticket and no checklist.
- **No auto-resolve, no auto-deliver, ever.** Ticking every box changes nothing automatically (spec §3.4, OD-4 B — permanently rejected, not deferred). A blocking `checklist_required` guard is the sanctioned future extension and is not in this wave.
- Migration filename: `apps/api/migrations/2026-10-16-190200-deliverable-checklist-wiring.sql`. Re-check it still sorts after `origin/main` before every commit **and before the push**.
- The migration backfills nothing today, but if a later edit adds DML it must elect `SELECT set_config('breeze.scope','system',true);` first.
- Run one API test file as `cd apps/api && npx vitest run <path>`. Never `pnpm --filter … test -- --run <path>`.
- Branch `feature/<parent#>-ticket-checklists/wave-<W03 sub-issue#>`, PR body `Closes #<W03 sub-issue>`, **targeting `main`**.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-16-190200-deliverable-checklist-wiring.sql` | four columns, two single-column FKs, two indexes |
| `apps/api/src/db/schema/serviceDeliverables.ts` | `instructions`, `checklistTemplateId` on `serviceDeliverables` |
| `apps/api/src/db/schema/deliverableTemplates.ts` | the same two on `deliverableTemplateItems` |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | **the column row** — four new columns on two registered entries |
| `packages/shared/src/validators/serviceDeliverables.ts`, `deliverableTemplates.ts` | the two new fields on four schemas |
| `apps/api/src/services/checklistTemplateReference.ts` (+ `.test.ts`) | owner-axis validation + the in-use guard, shared by both writers |
| `apps/api/src/services/ticketChecklistTemplateService.ts` | wire the 409 `CHECKLIST_TEMPLATE_IN_USE` guard into delete |
| `apps/api/src/services/deliverableTemplateService.ts` (+ `.test.ts`) | `applyTemplateSet` copies both fields; 409 `CHECKLIST_TEMPLATE_NOT_IN_TARGET_ORG` |
| `apps/api/src/services/serviceDeliverableService.ts` (+ `.test.ts`) | sweep seeding + the instructions snapshot comment; `{done,total}` on the occurrence list |
| `apps/api/src/services/aiToolsTicketing.ts`, `aiToolsDeliverables.ts` | read-only AI exposure |
| `apps/api/src/__tests__/integration/ticketChecklistDeliverableSeeding.integration.test.ts` | the sweep chain on real Postgres |
| `apps/api/src/__tests__/integration/ticketChecklistPortalNonDisclosure.integration.test.ts` | four surfaces, nothing leaks |
| `apps/web/src/components/deliverables/OccurrenceDrawer.tsx` | progress chip + one lazy expansion |
| `apps/web/src/components/deliverables/DeliverableForm.tsx` | instructions textarea + template picker |
| `apps/web/src/components/settings/DeliverableTemplatesPage.tsx` | the same two on the template-item form |
| `apps/web/src/locales/*/deliverables.json` | i18n |

---

### Task 1: Migration — four columns, two single-column FKs

**Files:**
- Create: `apps/api/migrations/2026-10-16-190200-deliverable-checklist-wiring.sql`

**Interfaces:**
- Consumes: `ticket_checklist_templates` (W02 Task 1).
- Produces: `service_deliverables.instructions`, `service_deliverables.checklist_template_id`, `deliverable_template_items.instructions`, `deliverable_template_items.checklist_template_id`; FKs `service_deliverables_checklist_template_fk`, `deliverable_template_items_checklist_template_fk`.

- [ ] **Step 1: Confirm the filename still sorts last**

```bash
git fetch origin main --quiet
git ls-tree --name-only origin/main apps/api/migrations/ | grep '\.sql$' | sort | tail -3
```
Expected: everything printed sorts before `2026-10-16-190200-deliverable-checklist-wiring.sql`.

- [ ] **Step 2: Write the migration**

```sql
-- Deliverable -> checklist wiring (spec #5783 §4.4).
--
-- Adds internal `instructions` prose and a live `checklist_template_id` pointer
-- to both the deliverable and the deliverable TEMPLATE ITEM it is applied from.
-- Idempotent (ADD COLUMN IF NOT EXISTS, DO $$ … EXCEPTION). No inner
-- BEGIN/COMMIT. Writes NO rows, so no breeze.scope election is required — if a
-- later edit adds a backfill, `SELECT set_config('breeze.scope','system',true);`
-- must be its first statement and this file must NEVER be added to
-- migrationRlsScope.test.ts's frozen baseline.
--
-- ============================================================================
-- DELIBERATE DEVIATION: these two FKs are SINGLE-COLUMN, not composite with
-- org_id. This is the exception to the repo rule, and the reason is structural,
-- not convenience.
--
-- A composite (checklist_template_id, org_id) -> ticket_checklist_templates(id,
-- org_id) can NEVER match a partner-wide template: service_deliverables.org_id
-- is NOT NULL, while a partner-wide template's org_id is NULL. Such an FK would
-- make the partner-wide half of the feature unreferenceable — i.e. it would
-- defeat the entire Partner-Wide First point of #5783.
--
-- The repo's established answer for "an org-scoped row references a
-- possibly-partner-wide config row" is app-layer validation, the same shape as
-- validateFeaturePolicyExists / PARTNER_LINKABLE_FEATURE_TYPES in
-- services/configurationPolicy.ts. So:
--
--   * services/checklistTemplateReference.ts validates on every write that the
--     referenced template is either owned by the same org, or partner-wide and
--     owned by that org's partner. Failure is 404 (never 403 — a template of
--     another tenant and a non-existent one must be indistinguishable).
--   * A partner-wide deliverable_template_items row may reference ONLY a
--     partner-wide checklist template of the same partner. An org-owned
--     checklist template would be invisible to every other org the set is
--     applied to, and a silent no-op is the worst possible outcome.
--   * Deleting a referenced template is refused with 409
--     CHECKLIST_TEMPLATE_IN_USE. ON DELETE SET NULL below is the last line of
--     defence, not the intended path: a silently emptied future checklist is
--     exactly the failure the guard exists to prevent.
--   * Both rules carry real-Postgres tests that forge the cross-partner link.
-- ============================================================================

-- 1. service_deliverables
ALTER TABLE service_deliverables ADD COLUMN IF NOT EXISTS instructions TEXT;
ALTER TABLE service_deliverables ADD COLUMN IF NOT EXISTS checklist_template_id UUID;

DO $$ BEGIN
  ALTER TABLE service_deliverables ADD CONSTRAINT service_deliverables_checklist_template_fk
    FOREIGN KEY (checklist_template_id) REFERENCES ticket_checklist_templates(id)
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS service_deliverables_checklist_template_idx
  ON service_deliverables (checklist_template_id) WHERE checklist_template_id IS NOT NULL;

-- 2. deliverable_template_items
ALTER TABLE deliverable_template_items ADD COLUMN IF NOT EXISTS instructions TEXT;
ALTER TABLE deliverable_template_items ADD COLUMN IF NOT EXISTS checklist_template_id UUID;

DO $$ BEGIN
  ALTER TABLE deliverable_template_items ADD CONSTRAINT deliverable_template_items_checklist_template_fk
    FOREIGN KEY (checklist_template_id) REFERENCES ticket_checklist_templates(id)
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS deliverable_template_items_checklist_template_idx
  ON deliverable_template_items (checklist_template_id) WHERE checklist_template_id IS NOT NULL;
```

The two partial indexes exist for the **delete guard**: it asks "does anything reference this template?" on every template delete, and a full-table scan of `service_deliverables` per delete is not acceptable.

- [ ] **Step 3: Run the migration guards**

```bash
scripts/check-migration-naming.sh --against-ref origin/main
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```
Expected: both PASS.

- [ ] **Step 4: Apply twice**

`pnpm test-stack up`, then `pnpm db:migrate` twice.
Expected: the second run is a clean no-op.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-10-16-190200-deliverable-checklist-wiring.sql
git commit -m "feat(deliverables): instructions and checklist_template_id on deliverables and template items (W03)"
```

---

### Task 2: Drizzle schema and the export-policy COLUMN row

**Files:**
- Modify: `apps/api/src/db/schema/serviceDeliverables.ts`
- Modify: `apps/api/src/db/schema/deliverableTemplates.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`

**Interfaces:**
- Produces: `serviceDeliverables.instructions`, `.checklistTemplateId`; `deliverableTemplateItems.instructions`, `.checklistTemplateId`.

**This task contains the single most commonly missed step in the repo.** `CORE_TENANT_EXPORT_POLICY` is the only registration list that fires on a **new column**, not just a new table — every column of every org-cascade table must be classified, so `ADD COLUMN` on a long-registered table breaks `tenant-export-policy.integration.test.ts`. Both `service_deliverables` and `deliverable_template_items` are already registered, so all four columns must be appended to their existing entries. That suite needs a live database and therefore **cannot fail in the Test API unit job** — a unit-green PR goes red under Integration Tests.

- [ ] **Step 1: Add the Drizzle columns**

In `apps/api/src/db/schema/serviceDeliverables.ts`, inside the `serviceDeliverables` table, after `ticketCategoryId`:

```ts
  /** Internal runbook prose for the technician. NEVER entered into the portal
   *  read model (spec #5783 §5) — serviceReadModel.ts must not select it. */
  instructions: text('instructions'),
  /** Live pointer (spec OD-3, settled as A). A template edit improves every
   *  FUTURE occurrence; already-opened occurrences are unaffected because their
   *  ticket_checklist_items are real rows no later edit can touch. Deliberately
   *  a SINGLE-column FK — see the migration header for why a composite one
   *  cannot express a partner-wide target. */
  checklistTemplateId: uuid('checklist_template_id'),
```

In `apps/api/src/db/schema/deliverableTemplates.ts`, inside `deliverableTemplateItems`, after `completionMode`:

```ts
  /** Copied onto the deliverable by applyTemplateSet. Internal only. */
  instructions: text('instructions'),
  /** Copied onto the deliverable by applyTemplateSet. A PARTNER-WIDE item may
   *  reference only a partner-wide checklist template of the same partner — an
   *  org-owned one would be invisible to every other org the set is applied to.
   *  Enforced in services/checklistTemplateReference.ts, not by the FK. */
  checklistTemplateId: uuid('checklist_template_id'),
```

Both files already import `text` and `uuid`; confirm rather than assume.

- [ ] **Step 2: Extend the two export-policy entries**

In `apps/api/src/services/tenantExportPolicyRegistry.ts`, append `"instructions"` and `"checklist_template_id"` to the `included` array of **both** existing entries. `instructions` is internal MSP procedure, not a credential, and matches nothing in `SUSPICIOUS_NAME_PARTS`; `checklist_template_id` is a tenant identifier. Neither is a `json`/`jsonb`/`bytea` column, so neither goes to `excludedOpen`.

The `deliverable_template_items` entry (~line 206) becomes:

```ts
  "deliverable_template_items": tablePolicy("org_id", {"included":["id","set_id","org_id","partner_id","name","description","cadence","lead_days","grace_days","artifact_required","completion_mode","sort_order","instructions","checklist_template_id","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

and the `service_deliverables` entry (~line 524):

```ts
  "service_deliverables": tablePolicy("org_id", {"included":["id","org_id","contract_id","name","description","cadence","anchor_due_date","effective_from","effective_until","lead_days","grace_days","artifact_required","completion_mode","auto_evidence_report_id","owner_user_id","ticket_category_id","portal_visible","active","sort_order","instructions","checklist_template_id","created_by","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

**Re-read both entries before editing.** W01 and W02 did not touch them, but another feature may have; copy the live array and append, rather than pasting the arrays above wholesale.

- [ ] **Step 3: Prove the export-policy suite discriminates**

Run it **before** Step 2's edit (or temporarily revert the edit):

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts
```
Expected: **FAIL**, naming `service_deliverables.instructions` (and the other three) as unclassified columns. Then re-apply Step 2 and re-run.
Expected: PASS.

Do this in this order. Seeing the red is what proves the suite actually reads the live schema — it is the contract that has caught this class 5 times out of 5 while code review caught it 0 out of 5.

- [ ] **Step 4: Drift and roundtrip**

```bash
export DATABASE_URL=$(grep '^DATABASE_URL=' .env.test | cut -d= -f2-)
pnpm db:check-drift
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
```
Expected: no drift; roundtrip green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/serviceDeliverables.ts apps/api/src/db/schema/deliverableTemplates.ts apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "chore(tenancy): classify the four new deliverable checklist columns in the export policy (W03)"
```

---

### Task 3: `checklistTemplateReference.ts` — owner-axis validation and the in-use guard

**Files:**
- Create: `apps/api/src/services/checklistTemplateReference.ts`
- Create: `apps/api/src/services/checklistTemplateReference.test.ts`
- Modify: `apps/api/src/services/ticketChecklistTemplateService.ts` (wire the guard into `deleteChecklistTemplate`)

**Interfaces:**
- Consumes: `ticketChecklistTemplates`, `serviceDeliverables`, `deliverableTemplateItems`.
- Produces:
  - `export async function assertChecklistTemplateUsableByOrg(templateId: string, orgId: string, partnerId: string | null, exec?: DbExecutor): Promise<void>` — throws 404 `NOT_FOUND` unless the template is owned by `orgId`, or is partner-wide and owned by `partnerId`.
  - `export async function assertChecklistTemplateUsableByTemplateItemOwner(templateId: string, owner: { orgId: string | null; partnerId: string | null }, exec?: DbExecutor): Promise<void>` — the owner axis must not narrow: a partner-wide item may reference only a partner-wide template of the same partner.
  - `export async function findChecklistTemplateReferences(templateId: string): Promise<{ deliverables: Array<{ id: string; name: string }>; templateItems: Array<{ id: string; name: string }> }>`
  - `export async function assertChecklistTemplateNotInUse(templateId: string): Promise<void>` — throws 409 `CHECKLIST_TEMPLATE_IN_USE` with the referencing rows in `details`.

This module exists because **three** writers need the same rules — `createDeliverable`/`updateDeliverable`, the deliverable-template item routes, and `applyTemplateSet` — and three copies would drift.

- [ ] **Step 1: Write the failing test**

```ts
describe('assertChecklistTemplateUsableByOrg', () => {
  it('accepts a template owned by the same org', async () => {
    templateMock.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: null }]);
    await expect(assertChecklistTemplateUsableByOrg('t-1', 'o-1', 'p-1')).resolves.toBeUndefined();
  });

  it('accepts a PARTNER-WIDE template owned by the org’s partner', async () => {
    // This is the case the single-column FK exists for.
    templateMock.mockResolvedValue([{ id: 't-1', orgId: null, partnerId: 'p-1' }]);
    await expect(assertChecklistTemplateUsableByOrg('t-1', 'o-1', 'p-1')).resolves.toBeUndefined();
  });

  it('404s on another ORG’s template', async () => {
    templateMock.mockResolvedValue([{ id: 't-1', orgId: 'o-OTHER', partnerId: null }]);
    await expect(assertChecklistTemplateUsableByOrg('t-1', 'o-1', 'p-1'))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('404s on another PARTNER’s partner-wide template', async () => {
    templateMock.mockResolvedValue([{ id: 't-1', orgId: null, partnerId: 'p-OTHER' }]);
    await expect(assertChecklistTemplateUsableByOrg('t-1', 'o-1', 'p-1'))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('404s — never 403 — on a template that does not exist', async () => {
    // A template of another tenant and a non-existent one must be
    // indistinguishable, or the error code itself becomes an existence oracle.
    templateMock.mockResolvedValue([]);
    await expect(assertChecklistTemplateUsableByOrg('nope', 'o-1', 'p-1'))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

describe('assertChecklistTemplateUsableByTemplateItemOwner', () => {
  it('a PARTNER-WIDE item may reference a partner-wide template of the same partner', async () => {
    templateMock.mockResolvedValue([{ id: 't-1', orgId: null, partnerId: 'p-1' }]);
    await expect(assertChecklistTemplateUsableByTemplateItemOwner('t-1', { orgId: null, partnerId: 'p-1' }))
      .resolves.toBeUndefined();
  });

  it('a PARTNER-WIDE item may NOT reference an ORG-OWNED template', async () => {
    // The owner axis must not narrow. An org-owned template would be invisible
    // to every other org the set is applied to, and the apply would silently
    // produce an empty checklist — the worst possible outcome.
    templateMock.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: null }]);
    await expect(assertChecklistTemplateUsableByTemplateItemOwner('t-1', { orgId: null, partnerId: 'p-1' }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('an ORG-OWNED item may reference its own org’s template', async () => { … });
  it('an ORG-OWNED item may reference its partner’s partner-wide template', async () => { … });
});

describe('assertChecklistTemplateNotInUse', () => {
  it('409s when a deliverable references the template, listing it', async () => {
    deliverableRefsMock.mockResolvedValue([{ id: 'd-1', name: 'Monthly review' }]);
    templateItemRefsMock.mockResolvedValue([]);
    await expect(assertChecklistTemplateNotInUse('t-1')).rejects.toMatchObject({
      status: 409,
      code: 'CHECKLIST_TEMPLATE_IN_USE',
      details: { deliverables: [{ id: 'd-1', name: 'Monthly review' }], templateItems: [] },
    });
  });

  it('409s when a deliverable TEMPLATE ITEM references it', async () => { … });

  it('resolves when nothing references it', async () => {
    deliverableRefsMock.mockResolvedValue([]);
    templateItemRefsMock.mockResolvedValue([]);
    await expect(assertChecklistTemplateNotInUse('t-1')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/checklistTemplateReference.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { ticketChecklistTemplates, serviceDeliverables, deliverableTemplateItems } from '../db/schema';
import { ChecklistServiceError } from './ticketChecklistService';

/**
 * The single source of the checklist-template REFERENCE rules.
 *
 * Three writers need them — createDeliverable/updateDeliverable, the
 * deliverable-template item routes, and applyTemplateSet — and the FK cannot
 * enforce them: it is single-column on purpose, because a composite
 * (checklist_template_id, org_id) FK can never match a partner-wide template
 * (org_id NULL vs service_deliverables.org_id NOT NULL). See the migration
 * header of 2026-10-16-190200 for the full argument.
 */

const notFound = () => new ChecklistServiceError('Checklist template not found', 404, 'NOT_FOUND');

/** An ORG-scoped row may reference its own org's template, or its partner's partner-wide one. */
export async function assertChecklistTemplateUsableByOrg(
  templateId: string,
  orgId: string,
  partnerId: string | null,
): Promise<void> {
  const [t] = await db.select({ orgId: ticketChecklistTemplates.orgId, partnerId: ticketChecklistTemplates.partnerId })
    .from(ticketChecklistTemplates).where(eq(ticketChecklistTemplates.id, templateId)).limit(1);
  // 404, never 403: a template of another tenant and one that does not exist
  // must be indistinguishable, or the status code is an existence oracle.
  if (!t) throw notFound();
  if (t.orgId !== null) {
    if (t.orgId !== orgId) throw notFound();
    return;
  }
  if (partnerId === null || t.partnerId !== partnerId) throw notFound();
}

/**
 * A DELIVERABLE TEMPLATE ITEM's reference must not narrow the owner axis.
 *
 * A partner-wide item may reference ONLY a partner-wide template of the same
 * partner. An org-owned template would be invisible to every other org the set
 * is applied to, and the apply would silently produce an empty checklist rather
 * than an error — the worst available outcome.
 */
export async function assertChecklistTemplateUsableByTemplateItemOwner(
  templateId: string,
  owner: { orgId: string | null; partnerId: string | null },
): Promise<void> {
  if (owner.orgId !== null) {
    return assertChecklistTemplateUsableByOrg(templateId, owner.orgId, owner.partnerId);
  }
  const [t] = await db.select({ orgId: ticketChecklistTemplates.orgId, partnerId: ticketChecklistTemplates.partnerId })
    .from(ticketChecklistTemplates).where(eq(ticketChecklistTemplates.id, templateId)).limit(1);
  if (!t) throw notFound();
  if (t.orgId !== null) throw notFound();                       // org-owned: refused
  if (owner.partnerId === null || t.partnerId !== owner.partnerId) throw notFound();
}

export async function findChecklistTemplateReferences(templateId: string) {
  const [deliverables, templateItems] = await Promise.all([
    db.select({ id: serviceDeliverables.id, name: serviceDeliverables.name })
      .from(serviceDeliverables).where(eq(serviceDeliverables.checklistTemplateId, templateId)).limit(50),
    db.select({ id: deliverableTemplateItems.id, name: deliverableTemplateItems.name })
      .from(deliverableTemplateItems).where(eq(deliverableTemplateItems.checklistTemplateId, templateId)).limit(50),
  ]);
  return { deliverables, templateItems };
}

/**
 * Deleting a referenced template would SET NULL the pointer and silently empty
 * every future occurrence's checklist — no error, no signal, discovered weeks
 * later by a customer. Refuse, and name what is in the way.
 * `is_active = false` is the supported retirement path: existing references
 * keep working and the template stops appearing in pickers.
 */
export async function assertChecklistTemplateNotInUse(templateId: string): Promise<void> {
  const refs = await findChecklistTemplateReferences(templateId);
  if (refs.deliverables.length === 0 && refs.templateItems.length === 0) return;
  throw new ChecklistServiceError(
    'This checklist template is still used by a deliverable or a deliverable template item. Deactivate it instead of deleting it.',
    409,
    'CHECKLIST_TEMPLATE_IN_USE',
    refs,
  );
}
```

- [ ] **Step 4: Wire the guard into delete**

In `apps/api/src/services/ticketChecklistTemplateService.ts`, call `await assertChecklistTemplateNotInUse(id);` in `deleteChecklistTemplate` **after** `loadChecklistTemplateOr404` and `requireWritable`, **before** the delete. Order matters: a caller who cannot see the template must get a 404, not a 409 that reveals it exists and is in use.

Add a route test asserting `deleteChecklistTemplate` maps the error to 409 with `details`, and a service test asserting the 404-before-409 ordering.

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
cd apps/api && npx vitest run \
  src/services/checklistTemplateReference.test.ts \
  src/services/ticketChecklistTemplateService.test.ts \
  src/routes/ticketChecklistTemplates.test.ts
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/checklistTemplateReference.ts apps/api/src/services/checklistTemplateReference.test.ts apps/api/src/services/ticketChecklistTemplateService.ts apps/api/src/routes/ticketChecklistTemplates.test.ts
git commit -m "feat(deliverables): checklist-template reference rules and the in-use delete guard (W03)"
```

---

### Task 4: Validators and route payloads for the two new fields

**Files:**
- Modify: `packages/shared/src/validators/serviceDeliverables.ts`
- Modify: `packages/shared/src/validators/deliverableTemplates.ts`
- Modify: `apps/api/src/services/serviceDeliverableService.ts` (`createDeliverable` / `updateDeliverable` write the fields, and validate the reference)
- Modify: `apps/api/src/services/deliverableTemplateService.ts` (template item create/update)

**Interfaces:**
- Produces: `instructions` and `checklistTemplateId` accepted on `createDeliverableSchema`, `updateDeliverableSchema`, `createTemplateItemSchema`, `updateTemplateItemSchema`.

- [ ] **Step 1: Write the failing tests**

Add to the shared validator suites:

```ts
it('createDeliverableSchema accepts instructions and checklistTemplateId', () => {
  const out = createDeliverableSchema.parse({ …minimumValidDeliverable, instructions: 'Check X before Y', checklistTemplateId: UUID });
  expect(out.instructions).toBe('Check X before Y');
  expect(out.checklistTemplateId).toBe(UUID);
});

it('updateDeliverableSchema accepts clearing both to null', () => {
  expect(updateDeliverableSchema.parse({ instructions: null, checklistTemplateId: null }))
    .toEqual({ instructions: null, checklistTemplateId: null });
});

it('createTemplateItemSchema accepts both', () => { … });
it('updateTemplateItemSchema accepts both, and still omits nothing else', () => { … });
```

And to the service suites:

```ts
it('createDeliverable validates the checklist template reference before writing', async () => {
  refMocks.assertChecklistTemplateUsableByOrg.mockRejectedValue(new ChecklistServiceError('Checklist template not found', 404, 'NOT_FOUND'));
  await expect(createDeliverable('o-1', { …input, checklistTemplateId: 'FOREIGN' }, actor))
    .rejects.toMatchObject({ status: 404 });
  expect(insertValuesMock).not.toHaveBeenCalled();
});

it('createDeliverable skips validation when checklistTemplateId is absent', async () => {
  await createDeliverable('o-1', { …input }, actor);
  expect(refMocks.assertChecklistTemplateUsableByOrg).not.toHaveBeenCalled();
});

it('a deliverable template item validates against the ITEM’S owner axis, not the caller’s org', async () => {
  await addTemplateItem('set-1', { …item, checklistTemplateId: 't-1' }, actor);
  expect(refMocks.assertChecklistTemplateUsableByTemplateItemOwner).toHaveBeenCalledWith('t-1', { orgId: null, partnerId: 'p-1' });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/shared && npx vitest run src/validators && cd apps/api && npx vitest run src/services/serviceDeliverableService.test.ts src/services/deliverableTemplateService.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `packages/shared/src/validators/serviceDeliverables.ts`, add to `createDeliverableSchema`'s object after `ticketCategoryId`:

```ts
    instructions: z.string().max(10000).nullable().optional(),
    checklistTemplateId: z.string().guid().nullable().optional(),
```

and the **same two lines** to `updateDeliverableSchema`'s object. That schema is written out longhand rather than derived via `.partial()` — the file's own comment says so — so both edits are required; adding only one is a silent gap where an update cannot clear a field.

In `packages/shared/src/validators/deliverableTemplates.ts`, add both to `templateItemFieldTypes` (the shared field map), which makes `createTemplateItemSchema` and `updateTemplateItemSchema` pick them up automatically:

```ts
  instructions: z.string().max(10000).nullable(),
  checklistTemplateId: z.string().guid().nullable(),
```

In the services, call the Task 3 validators **before** any write, and only when the field is present (a `null` clears the pointer and needs no validation):

```ts
if (input.checklistTemplateId) {
  await assertChecklistTemplateUsableByOrg(input.checklistTemplateId, orgId, actor.partnerId);
}
```
and, for a deliverable template item, `assertChecklistTemplateUsableByTemplateItemOwner(input.checklistTemplateId, { orgId: set.orgId, partnerId: set.partnerId })` — the **set's** owner axis, not the caller's org.

Thread both fields into every insert/update value object and into the view types the routes return.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/shared && npx vitest run && cd apps/api && npx vitest run src/services src/routes/serviceDeliverables.test.ts src/routes/deliverableTemplates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators apps/api/src/services/serviceDeliverableService.ts apps/api/src/services/deliverableTemplateService.ts
git commit -m "feat(deliverables): accept instructions and checklistTemplateId on deliverables and template items (W03)"
```

---

### Task 5: `applyTemplateSet` copies both fields, and refuses a cross-org checklist reference

**Files:**
- Modify: `apps/api/src/services/deliverableTemplateService.ts` (`applyTemplateSet`, ~line 313)
- Modify: `apps/api/src/services/deliverableTemplateService.test.ts`

**Interfaces:**
- Produces: error code `CHECKLIST_TEMPLATE_NOT_IN_TARGET_ORG` (409).

**The hole this closes (spec §4.4, Codex finding 12).** `applyTemplateSet` authorizes the **source** set with `loadSetOr404(setId, actor)` and the **target** with `requireOrgAccess(actor, orgId)` — two independent checks. An actor holding both may therefore apply **org A's** set to **org B**. Copying a `checklist_template_id` that points at org A's private checklist template into an org-B deliverable would create a cross-org pointer that RLS makes invisible to org B and that the system-context sweep would nonetheless read and act on.

- [ ] **Step 1: Write the failing test**

```ts
it('copies instructions and checklistTemplateId onto the new deliverable', async () => {
  itemsMock.mockResolvedValue([{ …item, instructions: 'Runbook prose', checklistTemplateId: 'tcl-1' }]);
  templateOwnerMock.mockResolvedValue([{ id: 'tcl-1', orgId: null, partnerId: 'p-1' }]);   // partner-wide
  await applyTemplateSet('o-2', 'set-1', {}, actor);
  expect(createDeliverableMock).toHaveBeenCalledWith('o-2', expect.objectContaining({
    instructions: 'Runbook prose',
    checklistTemplateId: 'tcl-1',
  }), expect.anything(), expect.anything());
});

it('409s CHECKLIST_TEMPLATE_NOT_IN_TARGET_ORG when the set carries org A’s PRIVATE checklist template and the target is org B', async () => {
  itemsMock.mockResolvedValue([{ …item, checklistTemplateId: 'tcl-A' }]);
  templateOwnerMock.mockResolvedValue([{ id: 'tcl-A', orgId: 'o-1', partnerId: null }]);
  await expect(applyTemplateSet('o-2', 'set-1', {}, actor)).rejects.toMatchObject({
    status: 409, code: 'CHECKLIST_TEMPLATE_NOT_IN_TARGET_ORG',
  });
  // Nothing is written: the check runs BEFORE the transaction.
  expect(createDeliverableMock).not.toHaveBeenCalled();
});

it('ALLOWS a PARTNER-WIDE checklist template across orgs of the same partner', async () => {
  // This is the whole point of partner-wide: one procedure, every customer.
  itemsMock.mockResolvedValue([{ …item, checklistTemplateId: 'tcl-shared' }]);
  templateOwnerMock.mockResolvedValue([{ id: 'tcl-shared', orgId: null, partnerId: 'p-1' }]);
  await expect(applyTemplateSet('o-2', 'set-1', {}, actor)).resolves.toBeDefined();
});

it('ALLOWS an org-owned checklist template when the target IS that org', async () => {
  itemsMock.mockResolvedValue([{ …item, checklistTemplateId: 'tcl-A' }]);
  templateOwnerMock.mockResolvedValue([{ id: 'tcl-A', orgId: 'o-1', partnerId: null }]);
  await expect(applyTemplateSet('o-1', 'set-1', {}, actor)).resolves.toBeDefined();
});

it('applies unchanged when no item carries a checklist template', async () => {
  itemsMock.mockResolvedValue([{ …item, checklistTemplateId: null }]);
  await expect(applyTemplateSet('o-2', 'set-1', {}, actor)).resolves.toBeDefined();
  expect(templateOwnerMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/deliverableTemplateService.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `applyTemplateSet`, after loading `items` and **before** the `db.transaction`, add the cross-org guard:

```ts
  // Cross-org apply guard (spec §4.4). loadSetOr404 authorizes the SOURCE set
  // and requireOrgAccess the TARGET org — independently — so an actor holding
  // both may apply org A's set to org B. Copying org A's PRIVATE checklist
  // template into an org-B deliverable would create a cross-org pointer that
  // RLS hides from org B while the system-context sweep still reads it.
  // A partner-wide template is fine: it is visible to both by construction.
  const referenced = [...new Set(items.map((i) => i.checklistTemplateId).filter((v): v is string => !!v))];
  if (referenced.length > 0) {
    const owners = await db
      .select({ id: ticketChecklistTemplates.id, orgId: ticketChecklistTemplates.orgId, partnerId: ticketChecklistTemplates.partnerId })
      .from(ticketChecklistTemplates)
      .where(inArray(ticketChecklistTemplates.id, referenced));
    const bad = owners.filter((o) => o.orgId !== null && o.orgId !== orgId).map((o) => o.id);
    // A referenced id that resolved to no row is already broken; treat it as
    // bad rather than silently applying a dangling pointer.
    const missing = referenced.filter((id) => !owners.some((o) => o.id === id));
    if (bad.length > 0 || missing.length > 0) {
      throw new TemplateServiceError(
        'This template set references a checklist template that does not belong to the target organization',
        409,
        'CHECKLIST_TEMPLATE_NOT_IN_TARGET_ORG',
        { templateIds: [...bad, ...missing] },
      );
    }
  }
```

Then add the two fields to the object literal passed to `createDeliverable` inside the transaction, beside `completionMode` and `sortOrder`:

```ts
          instructions: item.instructions ?? undefined,
          checklistTemplateId: item.checklistTemplateId ?? undefined,
```

`applyTemplateSet` copies an **explicit field list**, not a spread — a new column is invisible to it until named here. That is exactly how a field gets silently dropped on apply.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/deliverableTemplateService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/deliverableTemplateService.ts apps/api/src/services/deliverableTemplateService.test.ts
git commit -m "feat(deliverables): applyTemplateSet copies checklist wiring and refuses a cross-org reference (W03)"
```

---

### Task 6: Sweep seeding and the instructions snapshot comment

**Files:**
- Modify: `apps/api/src/services/serviceDeliverableService.ts` (`openOneOccurrence`, ~line 822)
- Modify: `apps/api/src/services/serviceDeliverableService.test.ts`

**Interfaces:**
- Consumes: `addChecklistItem` (W01), `ticketChecklistTemplateItems` (W02).
- Produces: nothing importable.

**Transaction boundary — verify, do not assume.** `openOneOccurrence` is called by `openDueOccurrencesForDeliverable` as `runOutsideDbContext(() => withSystemDbAccessContext(() => openOneOccurrence(...), 'deliverableSweep.openOccurrence'))`, and `withDbAccessContext` runs its callback inside `baseDb.transaction(...)`. The function's own docstring states the property: *"one system transaction per occurrence, so the claim UPDATE and the ticket creation commit or roll back together — a crash between them cannot strand an `open` occurrence with no ticket and no retry."* Your two new writes therefore roll back with the claim **provided they go through the same ambient `db` handle the rest of the function uses**. Do not open a nested transaction, and do not reach for a fresh pool. Task 9's integration test proves the property rather than trusting this paragraph.

**Comment shape — a deliberate refinement of spec §3.2.** The spec says `comment_type = 'system'`. Use **`commentType: 'internal'`** instead, matching `apps/api/src/services/deliverableAutoEvidence.ts:174-181` — the *other* comment this same sweep posts on this same ticket. Two writes from one sweep rendering as different comment types in the feed would be an inconsistency with no upside, and the property the spec actually requires (`is_public = false`, never reaching the portal) is identical either way. Carry `userId: null`, `authorType: 'system'` and `originPrincipalKind: 'system'` from that same precedent: the sweep actor's id is the nil UUID and is not a `users` row, and the helpdesk loop guard treats any non-`'user'` origin as system-authored so it is never re-admitted as a human reply.

- [ ] **Step 1: Write the failing test**

```ts
describe('openOneOccurrence checklist seeding', () => {
  it('copies the template items in sortOrder, stamped with the DELIVERABLE’s org', async () => {
    deliverableCfgMock.mockResolvedValue([{ ownerUserId: null, ticketCategoryId: null, description: 'd',
      instructions: null, checklistTemplateId: 'tcl-1' }]);
    templateItemsMock.mockResolvedValue([
      { id: 'ti-2', label: 'B', detail: null, sortOrder: 1 },
      { id: 'ti-1', label: 'A', detail: 'note', sortOrder: 0 },
    ]);
    createPlannedWorkTicketMock.mockResolvedValue({ kind: 'created', ticketId: 'tk-1' });

    await openOneOccurrence({ id: 'd-1', orgId: 'o-1', cadence: 'monthly' }, occ, new Set());

    const rows = checklistInsertMock.mock.calls[0][0];
    expect(rows.map((r: { label: string }) => r.label)).toEqual(['A', 'B']);
    // The DELIVERABLE's org — never the template's, which is NULL for a
    // partner-wide template and would violate the NOT NULL.
    expect(rows.every((r: { orgId: string }) => r.orgId === 'o-1')).toBe(true);
    expect(rows.every((r: { source: string }) => r.source === 'deliverable')).toBe(true);
    expect(rows.map((r: { sourceTemplateItemId: string }) => r.sourceTemplateItemId)).toEqual(['ti-1', 'ti-2']);
  });

  it('leaves created_by NULL on sweep rows', async () => {
    // DELIVERABLE_SWEEP_ACTOR.userId is the nil UUID and is NOT a users row, so
    // writing it would 23503 and abort the whole sweep for this occurrence.
    … expect(rows.every((r) => r.createdBy === null)).toBe(true);
  });

  it('posts the instructions as an INTERNAL, non-public comment snapshot', async () => {
    deliverableCfgMock.mockResolvedValue([{ …cfg, instructions: 'Check X before Y', checklistTemplateId: null }]);
    createPlannedWorkTicketMock.mockResolvedValue({ kind: 'created', ticketId: 'tk-1' });
    await openOneOccurrence(deliverable, occ, new Set());
    expect(commentInsertMock).toHaveBeenCalledWith(expect.objectContaining({
      ticketId: 'tk-1',
      isPublic: false,
      userId: null,
      originPrincipalKind: 'system',
    }));
    expect(commentInsertMock.mock.calls[0][0].content).toContain('Check X before Y');
  });

  it('posts NO comment when the deliverable has no instructions', async () => {
    deliverableCfgMock.mockResolvedValue([{ …cfg, instructions: null }]);
    await openOneOccurrence(deliverable, occ, new Set());
    expect(commentInsertMock).not.toHaveBeenCalled();
  });

  it('a ticketless occurrence (Service Management off) seeds NOTHING and does not throw', async () => {
    createPlannedWorkTicketMock.mockResolvedValue({ kind: 'service_management_off' });
    await expect(openOneOccurrence(deliverable, occ, new Set())).resolves.toBe(1);
    expect(checklistInsertMock).not.toHaveBeenCalled();
    expect(commentInsertMock).not.toHaveBeenCalled();
  });

  it('seeds nothing when the deliverable has no checklistTemplateId', async () => {
    deliverableCfgMock.mockResolvedValue([{ …cfg, checklistTemplateId: null }]);
    await openOneOccurrence(deliverable, occ, new Set());
    expect(checklistInsertMock).not.toHaveBeenCalled();
  });

  it('seeds nothing when the referenced template has no items', async () => {
    templateItemsMock.mockResolvedValue([]);
    await openOneOccurrence(deliverable, occ, new Set());
    expect(checklistInsertMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/serviceDeliverableService.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Extend the existing re-select (~line 829) to carry the two new columns:

```ts
  const [cfg] = await db.select({
      ownerUserId: serviceDeliverables.ownerUserId,
      ticketCategoryId: serviceDeliverables.ticketCategoryId,
      description: serviceDeliverables.description,
      instructions: serviceDeliverables.instructions,
      checklistTemplateId: serviceDeliverables.checklistTemplateId,
    }).from(serviceDeliverables).where(eq(serviceDeliverables.id, d.id)).limit(1);
```

Then, after `createPlannedWorkTicket` returns and the `service_management_off` early return, and beside the existing `ticketId` stamp:

```ts
  await db.update(serviceDeliverableOccurrences)
    .set({ ticketId: created.ticketId, updatedAt: new Date() })
    .where(eq(serviceDeliverableOccurrences.id, occ.id));

  // #5783 W03 — seed the checklist and post the instructions snapshot.
  //
  // Both run on the ambient `db` handle inside the SAME per-occurrence system
  // transaction as the claim and the ticket creation (see this function's
  // docstring). A failure here therefore rolls the claim back and the occurrence
  // retries tomorrow, rather than being stranded `open` with a ticket and no
  // checklist. Do NOT open a nested transaction here.
  if (cfg?.checklistTemplateId) {
    const steps = await db.select().from(ticketChecklistTemplateItems)
      .where(eq(ticketChecklistTemplateItems.templateId, cfg.checklistTemplateId))
      .orderBy(asc(ticketChecklistTemplateItems.sortOrder), asc(ticketChecklistTemplateItems.label));
    if (steps.length > 0) {
      await db.insert(ticketChecklistItems).values(steps.map((s, index) => ({
        // The DELIVERABLE's org. NEVER the template's, which is NULL for a
        // partner-wide template — a partner-wide template produces org-scoped
        // rows inside each customer's tenant, and no cross-tenant row is ever
        // created.
        orgId: d.orgId,
        ticketId: created.ticketId,
        label: s.label,
        detail: s.detail,
        position: index,
        source: 'deliverable' as const,
        sourceTemplateItemId: s.id,
        // NULL, not DELIVERABLE_SWEEP_ACTOR.userId: that is the nil UUID
        // '00000000-…-0000' and is not a users row, so writing it would 23503
        // and abort this occurrence every single night.
        createdBy: null,
      })));
    }
  }

  if (cfg?.instructions) {
    // A point-in-time SNAPSHOT, matching the name_snapshot precedent: editing
    // the deliverable's instructions tomorrow must not silently rewrite what a
    // technician was told to do last month.
    //
    // commentType 'internal' matches deliverableAutoEvidence.ts:177 — the other
    // comment this same sweep posts on this same ticket. is_public=false is what
    // keeps it out of the portal (routes/portal/tickets.ts filters on
    // is_public = true), and originPrincipalKind 'system' keeps the helpdesk
    // loop guard from ever re-admitting it as a human reply.
    await db.insert(ticketComments).values({
      ticketId: created.ticketId,
      userId: null,
      authorName: 'Breeze',
      authorType: 'system',
      commentType: 'internal',
      content: `Internal instructions for this deliverable:\n\n${cfg.instructions}`,
      isPublic: false,
      originPrincipalKind: 'system',
    });
  }
  return 1;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/serviceDeliverableService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/serviceDeliverableService.ts apps/api/src/services/serviceDeliverableService.test.ts
git commit -m "feat(deliverables): sweep seeds the ticket checklist and posts the instructions snapshot (W03)"
```

---

### Task 7: `{ done, total }` on the MSP occurrence list, and the drawer

**Files:**
- Modify: `apps/api/src/services/serviceDeliverableService.ts` (`listOccurrences`)
- Modify: `apps/api/src/services/serviceDeliverableService.test.ts`
- Modify: `apps/web/src/lib/api/serviceDeliverables.ts` (the `Occurrence` type)
- Modify: `apps/web/src/components/deliverables/OccurrenceDrawer.tsx` (+ its test)

**Interfaces:**
- Consumes: `checklistCountsForTickets` (W01).
- Produces: `Occurrence.checklist: { done: number; total: number } | null` on the **MSP** read model only.

**The portal read model is a different function and must not change.** `services/portal/serviceReadModel.ts` builds its own DTOs (hand-written object literals at ~lines 325-348 and ~454-474). Task 10 asserts it stays clean. Do not "share" a mapper between the two.

**Why a grouped count and not 24 mounted cards** (spec §7, Codex finding 6): `OccurrenceDrawer` renders up to 24 occurrences. Mounting 24 self-fetching checklist cards would be 24 requests on drawer open. Instead the list route returns a per-occurrence summary in its existing payload — **one grouped query, no extra round trip** — rendered as a chip, and expanding a single row lazily loads that occurrence's checklist into W01's shared component in `compact` mode.

- [ ] **Step 1: Write the failing test**

```ts
it('returns a per-occurrence checklist summary in ONE grouped query', async () => {
  occurrenceRowsMock.mockResolvedValue([
    { id: 'occ-1', ticketId: 'tk-1', … },
    { id: 'occ-2', ticketId: 'tk-2', … },
    { id: 'occ-3', ticketId: null,   … },
  ]);
  countsMock.mockResolvedValue(new Map([['tk-1', { done: 2, total: 5 }]]));

  const out = await listOccurrences('o-1', 'd-1', { limit: 24 }, actor);

  expect(countsMock).toHaveBeenCalledTimes(1);
  expect(countsMock).toHaveBeenCalledWith(['tk-1', 'tk-2']);   // nulls filtered out
  expect(out.occurrences[0].checklist).toEqual({ done: 2, total: 5 });
  expect(out.occurrences[1].checklist).toBeNull();             // ticket has no checklist
  expect(out.occurrences[2].checklist).toBeNull();             // ticketless occurrence
});

it('does not query counts at all when no occurrence has a ticket', async () => {
  occurrenceRowsMock.mockResolvedValue([{ id: 'occ-1', ticketId: null }]);
  await listOccurrences('o-1', 'd-1', { limit: 24 }, actor);
  expect(countsMock).not.toHaveBeenCalled();
});
```

And for the drawer:

```ts
it('renders a progress chip per occurrence', async () => {
  expect((await screen.findByTestId('occurrence-checklist-chip-occ-1')).textContent).toContain('2 / 5');
});

it('renders NO chip for an occurrence with no checklist', async () => {
  expect(screen.queryByTestId('occurrence-checklist-chip-occ-2')).toBeNull();
});

it('mounts NO checklist card until a row is expanded', async () => {
  // 24 self-fetching cards on drawer open is the thing this design avoids.
  await screen.findByTestId('occurrence-list');
  expect(screen.queryByTestId('ticket-checklist-card')).toBeNull();
});

it('lazily loads the checklist for ONE expanded occurrence', async () => {
  fireEvent.click(await screen.findByTestId('occurrence-checklist-expand-occ-1'));
  expect(await screen.findByTestId('ticket-checklist-card')).toBeTruthy();
  const checklistCalls = fetchWithAuth.mock.calls.filter(([u]) => String(u).includes('/checklist'));
  expect(checklistCalls).toHaveLength(1);
});

it('expanding a second row does not leave the first mounted', async () => { … });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/serviceDeliverableService.test.ts && cd apps/web && npx vitest run src/components/deliverables`
Expected: FAIL on both.

- [ ] **Step 3: Implement**

In `listOccurrences`, after the rows are fetched:

```ts
  const ticketIds = rows.map((r) => r.ticketId).filter((v): v is string => !!v);
  const counts = ticketIds.length > 0 ? await checklistCountsForTickets(ticketIds) : new Map();
```
and map `checklist: row.ticketId ? counts.get(row.ticketId) ?? null : null` onto each DTO.

In `OccurrenceDrawer.tsx`, render the chip from `occ.checklist` and add an expand control that mounts exactly one `<TicketChecklistCard ticketId={occ.ticketId} mode="compact" />` at a time. Keep the expanded id in component state; collapsing unmounts.

**Permissions do not leak across features.** The drawer's checklist calls hit the *ticket* routes and are gated on `tickets:read`, while deliverable endpoints authorize on `contracts:*`. A user with `contracts:read` but not `tickets:read` must see the occurrence **without** its checklist, not an error — so a 403 from the lazy load renders as an empty/absent card, not a toast. Add a test for that.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/serviceDeliverableService.test.ts && cd apps/web && npx vitest run src/components/deliverables && pnpm --filter @breeze/web typecheck`
Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/serviceDeliverableService.ts apps/api/src/services/serviceDeliverableService.test.ts apps/web/src/lib/api/serviceDeliverables.ts apps/web/src/components/deliverables
git commit -m "feat(deliverables): checklist progress chip and lazy expansion in the occurrence drawer (W03)"
```

---

### Task 8: Forms — instructions and the checklist-template picker

**Files:**
- Modify: `apps/web/src/components/deliverables/DeliverableForm.tsx` (+ its test)
- Modify: `apps/web/src/components/settings/DeliverableTemplatesPage.tsx` (+ its test)
- Modify: `apps/web/src/locales/*/deliverables.json`

**Interfaces:**
- Consumes: `listChecklistTemplates` (W02 Task 8).

- [ ] **Step 1: Write the failing test**

```ts
it('labels the instructions textarea as internal-only', async () => {
  render(<DeliverableForm … />);
  expect((await screen.findByTestId('deliverable-instructions-hint')).textContent)
    .toMatch(/never shown to the customer/i);
});

it('submits instructions and checklistTemplateId', async () => { … });

it('offers partner-wide checklist templates with an All orgs marker', async () => { … });

it('clears the pointer when "None" is chosen', async () => {
  … expect(body.checklistTemplateId).toBeNull();
});

it('surfaces a 404 on a template the caller cannot use, rather than silently dropping it', async () => { … });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/components/deliverables src/components/settings`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `DeliverableForm.tsx`, following the existing `description` textarea's exact shape (`labelClass`, `inputClass`, `id()`, `set()`):

- an `instructions` textarea with `maxLength={10000}` and a hint paragraph carrying `data-testid="deliverable-instructions-hint"` and the key `deliverables:form.instructionsHint` — copy reads *"Internal — never shown to the customer."*;
- a `checklistTemplateId` `<select>` listing active templates with a "None" option, marking `orgId === null` entries with the "All orgs" label, and a link through to `/settings/ticket-checklist-templates`.

Mirror both controls on the deliverable **template item** form inside `DeliverableTemplatesPage.tsx`, with one difference: when the set is partner-wide, list **only** partner-wide checklist templates. Offering an org-owned one there would be offering a choice the API refuses with a 404 (Task 3's owner-axis rule), which is a worse experience than not offering it.

- [ ] **Step 4: Extend the i18n catalogues**

Add `form.instructions`, `form.instructionsHint`, `form.checklistTemplate`, `form.checklistTemplateNone`, `form.checklistTemplateAllOrgs`, `form.checklistTemplateManage` to `deliverables.json` in all eight locales with real translations. Run `cd apps/web && npx vitest run src/lib/i18n` and adjust the per-namespace baselines only for values genuinely identical in that language, with a comment saying which key and why.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components src/lib/i18n && pnpm --filter @breeze/web typecheck`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components apps/web/src/locales apps/web/src/lib/i18n/translationCoverage.test.ts
git commit -m "feat(web): instructions and checklist-template controls on the deliverable forms (W03)"
```

---

### Task 9: AI — read-only exposure

**Files:**
- Modify: `apps/api/src/services/aiToolsTicketing.ts` (the `manage_tickets` `get` action, ~line 464)
- Modify: `apps/api/src/services/aiToolsDeliverables.ts` (`list_deliverable_templates`, ~line 311)
- Modify: `apps/api/src/services/aiToolsTicketing.test.ts`, `aiToolsDeliverables.test.ts`

**Interfaces:**
- Consumes: `listChecklist` (W01), `listTemplateSets` (existing).

**Read-only, and that is a decision, not a scope cut (spec §6.5, OD-7 A).** `done_by_user_id` is a human attestation that a step was performed; an agent ticking a box it did not perform is a falsified record in a compliance artifact. **There is no tick-off tool, and adding one is not a follow-up task in this wave.** If tick-off is ever wanted, the right change is a `done_by_kind ('user' | 'ai_agent')` discriminator plus `done_by_agent_id` — the auth principal already models both (`middleware/auth.ts:54`) — not laundering an agent through a user id.

And note where the enforcement actually lives: **omitting the tool is not what makes ticking human-only.** An MCP API key carries its creator's real `user.id`, so `PATCH … { done: true }` would be reachable by an agent under a human's identity. W01's `isInteractiveUserSession` gate on the `done` branch is the control. Do not weaken it here.

- [ ] **Step 1: Write the failing test**

```ts
it('manage_tickets get includes the checklist summary and ordered labels', async () => {
  findTicketWithAccessMock.mockResolvedValue({ id: 'tk-1', orgId: 'o-1', subject: 'S' });
  listChecklistMock.mockResolvedValue({ items: [{ label: 'A', done: true }, { label: 'B', done: false }], done: 1, total: 2 });
  const out = JSON.parse(await tool.handler({ action: 'get', ticketId: 'tk-1' }, auth));
  expect(out.checklist).toEqual({ done: 1, total: 2, items: [
    { label: 'A', done: true }, { label: 'B', done: false },
  ]});
});

it('manage_tickets get omits per-step DETAIL and the completer’s id', async () => {
  // The agent needs to know where the ticket stands, not who attested what.
  const out = JSON.parse(await tool.handler({ action: 'get', ticketId: 'tk-1' }, auth));
  expect(JSON.stringify(out)).not.toContain('doneByUserId');
});

it('manage_tickets get returns checklist null for a ticket with none', async () => { … });

it('there is NO tool that ticks a checklist step', () => {
  // Pin the decision so a future "helpful" addition fails here and has to
  // argue with OD-7 rather than slip in.
  const names = [...aiTools.keys()];
  const suspicious = names.filter((n) => /checklist/i.test(n) && !/list|get|read/i.test(n));
  expect(suspicious).toEqual([]);
  const manageTickets = aiTools.get('manage_tickets')!;
  const actions = manageTickets.definition.input_schema.properties.action.enum as string[];
  expect(actions).not.toContain('tick_checklist');
  expect(actions).not.toContain('complete_checklist_item');
});

it('list_deliverable_templates exposes checklistTemplateId and instructions', async () => { … });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiToolsTicketing.test.ts src/services/aiToolsDeliverables.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `aiToolsTicketing.ts`, extend the `get` branch:

```ts
      if (action === 'get') {
        if (!input.ticketId) return JSON.stringify({ error: 'ticketId is required for get action' });
        const ticket = await findTicketWithAccess(String(input.ticketId), auth);
        if (!ticket) return JSON.stringify({ error: 'Ticket not found' });
        // #5783 W03 — READ ONLY. Labels and progress, so "summarise where this
        // ticket stands" works. No per-step detail and no doneByUserId: the
        // attestation is a compliance record, not context for a summary. There
        // is deliberately no tick-off action (spec §6.5, OD-7).
        const checklist = await listChecklist(ticket.id);
        return JSON.stringify({
          ticket,
          checklist: checklist.total === 0 ? null : {
            done: checklist.done,
            total: checklist.total,
            items: checklist.items.map((i) => ({ label: i.label, done: i.done })),
          },
        });
      }
```

In `aiToolsDeliverables.ts`, add `checklistTemplateId` and `instructions` to whatever `listTemplateSets` returns for each item, and extend the tool `description` so the model knows the fields exist. Per the spec, a partner-wide checklist-template listing **joins** `list_deliverable_templates` rather than getting its own tool.

If a new tool were added, it would also need entries in `aiToolSchemas.ts`, `aiGuardrails.ts` and `aiAgents/agentToolCatalog.ts` — one reason not to add one.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/aiTools`
Expected: PASS. That is a substring filter and picks up every `aiTools*` suite — check the reported file count.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiToolsTicketing.ts apps/api/src/services/aiToolsDeliverables.ts apps/api/src/services/aiToolsTicketing.test.ts apps/api/src/services/aiToolsDeliverables.test.ts
git commit -m "feat(ai): read-only checklist exposure on ticket and deliverable-template tools (W03)"
```

---

### Task 10: The portal no-leak proof — four surfaces

**Files:**
- Create: `apps/api/src/__tests__/integration/ticketChecklistPortalNonDisclosure.integration.test.ts`

**Interfaces:**
- Consumes: the whole feature.
- Produces: the standing assertion that holds spec §5. This is the test that would have caught the leak that was actually going to ship.

**Four surfaces, not two.** `GET /portal/service`, `GET /portal/service/:deliverableId/occurrences`, **portal ticket detail** (`routes/portal/tickets.ts` — a manual checklist can be added to an ordinary support ticket, which the portal *does* expose), and the **narrative** path: `resolutionNote` → `deliveryNote` → published as `note` on both portal surfaces.

- [ ] **Step 1: Write the suite**

```ts
import './setup';
// … standard integration imports + a portal auth context …

const SECRET_STEP = 'ZZZ-INTERNAL-STEP-MARKER';
const SECRET_INSTRUCTIONS = 'ZZZ-INTERNAL-INSTRUCTIONS-MARKER';

describe('the customer portal never discloses checklist state (#5783 §5)', () => {
  it('GET /portal/service exposes no step text, instructions or progress', async () => {
    const f = await seedDeliverableWithChecklist(SECRET_STEP, SECRET_INSTRUCTIONS);
    const res = await portalRoutes.request('/service', { headers: portalAuthHeaders(f) });
    const body = await res.text();
    expect(res.status).toBe(200);
    // Marker strings, not key names: a renamed field must not silently pass.
    expect(body).not.toContain(SECRET_STEP);
    expect(body).not.toContain(SECRET_INSTRUCTIONS);
    expect(body).not.toMatch(/"instructions"/);
    expect(body).not.toMatch(/"checklist"/);
    expect(body).not.toMatch(/"checklistTemplateId"/);
  });

  it('GET /portal/service/:id/occurrences exposes none of it either', async () => { … same three assertions … });

  it('portal ticket detail exposes no checklist on an ORDINARY support ticket', async () => {
    // The surface most likely to be forgotten: a manual checklist can be added
    // to any ticket, and the portal DOES expose support tickets.
    const f = await seedSupportTicketWithManualChecklist(SECRET_STEP);
    const res = await portalTicketRoutes.request(`/tickets/${f.ticketId}`, { headers: portalAuthHeaders(f) });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).not.toContain(SECRET_STEP);
    expect(body).not.toMatch(/"checklist"/);
  });

  it('the sweep’s instructions comment is NOT in the portal comment feed', async () => {
    // It is is_public=false, and routes/portal/tickets.ts filters on
    // is_public = true. Pin it: flipping that default would leak every internal
    // note in the product, not just this one.
    const f = await seedDeliverableTicketWithInstructionsComment(SECRET_INSTRUCTIONS);
    const res = await portalTicketRoutes.request(`/tickets/${f.ticketId}`, { headers: portalAuthHeaders(f) });
    expect(await res.text()).not.toContain(SECRET_INSTRUCTIONS);
  });

  it('resolving a deliverable ticket writes ONLY the technician’s typed note to delivery_note', async () => {
    // THE narrative leak. resolutionNote is copied verbatim into
    // serviceDeliverableOccurrences.deliveryNote
    // (serviceDeliverableService.ts:737) and the portal publishes deliveryNote
    // as `note` on BOTH surfaces (serviceReadModel.ts:337, :466). Nothing may
    // ever auto-append a checklist summary, a step label or instructions text
    // to a resolution or delivery note — not the resolve dialog, not an AI
    // draft, not a bulk action.
    const f = await seedOpenOccurrenceWithChecklist(SECRET_STEP);
    await applyTicketStatusChange({ ticketId: f.ticketId, orgId: f.orgId, to: 'resolved',
      resolutionNote: 'Reviewed and clean.', actorUserId: f.userId });

    const [occ] = await withSystemDbAccessContext(() =>
      db.select().from(serviceDeliverableOccurrences).where(eq(serviceDeliverableOccurrences.id, f.occurrenceId)));
    expect(occ!.deliveryNote).toBe('Reviewed and clean.');
    expect(occ!.deliveryNote).not.toContain(SECRET_STEP);
    expect(occ!.deliveryNote).not.toMatch(/\d+\s*\/\s*\d+/);   // no smuggled progress counter
  });

  it('an ORG-scoped token cannot reach the checklist routes at all', async () => {
    // requireScope('partner','system') is the other half of the enforcement.
    const res = await ticketsRoutes.request(`/${ticketId}/checklist`, { headers: orgScopedHeaders });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Prove the suite discriminates**

Temporarily add `instructions: deliverable.instructions` to the scorecard DTO in `services/portal/serviceReadModel.ts` and re-run.
Expected: the first case **FAILs** on the marker string. Revert.

Then temporarily change the sweep's comment to `isPublic: true` and re-run.
Expected: the comment-feed case FAILs. Revert.

A non-disclosure suite that has never been red has not been shown to detect disclosure.

- [ ] **Step 3: Run it green**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/ticketChecklistPortalNonDisclosure.integration.test.ts
```
Expected: PASS with a non-zero test count.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/ticketChecklistPortalNonDisclosure.integration.test.ts
git commit -m "test(portal): standing proof that checklists and instructions never reach the customer (W03)"
```

---

### Task 11: Integration test — the seeding chain on real Postgres

**Files:**
- Create: `apps/api/src/__tests__/integration/ticketChecklistDeliverableSeeding.integration.test.ts`

- [ ] **Step 1: Write the suite**

```ts
it('applyTemplateSet -> deliverable -> sweep -> ticket_checklist_items, end to end', async () => {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const checklist = await seedChecklistTemplateWithItems({ partnerId: partner.id }, ['Step A', 'Step B', 'Step C']);
  const set = await seedDeliverableTemplateSetWithItem({ partnerId: partner.id }, {
    checklistTemplateId: checklist, instructions: 'Runbook prose',
  });

  await applyTemplateSet(orgA.id, set, {}, actorFor(partner.id, [orgA.id]));

  const [deliverable] = await withSystemDbAccessContext(() =>
    db.select().from(serviceDeliverables).where(eq(serviceDeliverables.orgId, orgA.id)));
  expect(deliverable!.checklistTemplateId).toBe(checklist);
  expect(deliverable!.instructions).toBe('Runbook prose');

  await runDeliverableSweep();   // whatever the existing sweep tests call

  const [occ] = await withSystemDbAccessContext(() =>
    db.select().from(serviceDeliverableOccurrences).where(eq(serviceDeliverableOccurrences.deliverableId, deliverable!.id)));
  const rows = await withSystemDbAccessContext(() =>
    db.select().from(ticketChecklistItems).where(eq(ticketChecklistItems.ticketId, occ!.ticketId!))
      .orderBy(asc(ticketChecklistItems.position)));

  expect(rows.map((r) => r.label)).toEqual(['Step A', 'Step B', 'Step C']);
  // The deliverable's org, from a PARTNER-WIDE template.
  expect(rows.every((r) => r.orgId === orgA.id)).toBe(true);
  expect(rows.every((r) => r.source === 'deliverable')).toBe(true);
  expect(rows.every((r) => r.createdBy === null)).toBe(true);

  const comments = await withSystemDbAccessContext(() =>
    db.select().from(ticketComments).where(eq(ticketComments.ticketId, occ!.ticketId!)));
  const note = comments.find((c) => c.content.includes('Runbook prose'));
  expect(note).toBeDefined();
  expect(note!.isPublic).toBe(false);
});

it('applying the SAME partner-wide template to two orgs gives each its own rows', async () => {
  // The fan-out proof. Partner-wide config that silently reaches only one org
  // is the failure mode this whole design exists to avoid.
  … expect orgA's items and orgB's items to be disjoint id sets, each stamped with its own org …
});

it('a failure while seeding rolls the occurrence claim BACK', async () => {
  // Proves the transaction property the sweep's docstring claims, rather than
  // trusting it. Fault the comment insert; the occurrence must still be
  // `scheduled` afterwards, not stranded `open` with a ticket and no checklist.
  faultTicketCommentInsertOnce();
  await runDeliverableSweep();
  const [occ] = await withSystemDbAccessContext(() => db.select().from(serviceDeliverableOccurrences)…);
  expect(occ!.status).toBe('scheduled');
  expect(occ!.ticketId).toBeNull();
});

it('a ticketless occurrence (Service Management off) seeds nothing and does not throw', async () => { … });

it('editing the template AFTER an occurrence opened does not rewrite that occurrence’s rows', async () => {
  // OD-3 A's core promise: the pointer is live for FUTURE occurrences, while
  // history is frozen one level down because the opened occurrence's items are
  // real rows no later template edit can touch.
  … open an occurrence, rename a template item, re-read the ticket's items …
  expect(rows.map((r) => r.label)).toEqual(['Step A', 'Step B', 'Step C']);   // unchanged
});
```

- [ ] **Step 2: Prove the rollback case can fail**

Temporarily move the two new writes **after** the transaction (e.g. into a `setImmediate`), and re-run.
Expected: the rollback case FAILs — the occurrence is left `open` with a ticket. Revert.

- [ ] **Step 3: Run the suite green**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/ticketChecklistDeliverableSeeding.integration.test.ts
```
Expected: PASS with a non-zero test count.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/ticketChecklistDeliverableSeeding.integration.test.ts
git commit -m "test(deliverables): real-Postgres proof of the template -> deliverable -> sweep chain (W03)"
```

---

### Task 12: Repo-wide sweep and wave verification

- [ ] **Step 1: Sweep every reader of the new columns**

```bash
grep -rn "checklistTemplateId\|checklist_template_id" apps/ packages/ ee/ --include='*.ts' --include='*.tsx' --include='*.sql' | grep -v '\.test\.' | sort
grep -rn "instructions" apps/api/src/services/portal apps/api/src/routes/portal --include='*.ts' | sort
```
Every hit on the first command must be one of: the two migrations, the two schema files, the export policy, `checklistTemplateReference.ts`, the two services, the validators, the web forms, the AI tool. The second command must return **nothing** — a hit means the portal read model has grown a reference to internal prose. Record the sweep's outcome in the PR body either way.

- [ ] **Step 2: Full API unit run** — `cd apps/api && npx vitest run` → green.

- [ ] **Step 3: Shared, web, lint, typecheck**
```bash
cd packages/shared && npx vitest run
cd apps/web && npx vitest run
pnpm --filter @breeze/web typecheck && pnpm --filter @breeze/api typecheck
pnpm lint
```
→ all clean.

- [ ] **Step 4: Integration and contract suites** (test stack up):
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/ticketChecklistRls.integration.test.ts \
  src/__tests__/integration/ticketChecklistOrgMove.integration.test.ts \
  src/__tests__/integration/ticketChecklistTemplatesPartnerRls.integration.test.ts \
  src/__tests__/integration/ticketChecklistDeliverableSeeding.integration.test.ts \
  src/__tests__/integration/ticketChecklistPortalNonDisclosure.integration.test.ts \
  src/__tests__/integration/deliverableTemplatesPartnerRls.integration.test.ts
pnpm -F @breeze/api test:rls-coverage
```
→ green, each with a non-zero test count. The export-policy suite is the one that fires on the four new **columns**; it cannot fail in the unit job, so a unit-green PR can still redden here.

- [ ] **Step 5: Manual smoke** on a worktree stack. As a partner admin: author a partner-wide checklist template with three steps; attach it plus internal instructions to a deliverable **template item**; apply that set to two different orgs; confirm both deliverables carry the pointer and the prose. Force a sweep and confirm each org's ticket opens with its own three checklist rows and one internal comment carrying the instructions. Open the customer portal as each org's contact and confirm **nothing** about steps, instructions or progress appears anywhere — scorecard, occurrence list, or the ticket itself. Resolve one deliverable ticket with a typed note and confirm the portal shows exactly that note and nothing appended. Finally, try to delete the checklist template and confirm the 409 names the referencing deliverables, then deactivate it instead and confirm existing references keep working while it leaves the pickers.

- [ ] **Step 6: Tear down** — `pnpm test-stack down`, `pnpm wt-stack down`, then confirm with `docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'`.

- [ ] **Step 7: PR**

Against **`main`**, `Closes #<W03 sub-issue>`. The body must carry:

- a **Tenancy** section: the four new columns and their export-policy classification (the column-triggered row), the two **single-column** FKs with the reason they are not composite, the app-layer validation that stands in, and the two 409 guards;
- a **Portal** section stating that nothing is exposed, naming the four surfaces the standing test covers, and calling out the `resolutionNote` → `deliveryNote` narrative path explicitly;
- the sweep result from Step 1;
- a note that AI exposure is **read-only by decision** (OD-7 A), and that the actual human-only control is W01's `isInteractiveUserSession` gate, not the absence of a tool.

Run `/pr-review-toolkit:review-pr`; act only on confirmed findings. Enqueue with `gh pr merge <N>` on green — never `--admin`.

---

## Self-review

**Spec coverage.** §3.2 the seeding chain and the instructions snapshot as an internal comment → Tasks 5, 6. §4.4 all four columns, the single-column-FK justification, the delete guard (409 `CHECKLIST_TEMPLATE_IN_USE`) and the cross-org apply guard (409 `CHECKLIST_TEMPLATE_NOT_IN_TARGET_ORG`) → Tasks 1, 3, 5. §4.5 the export-policy **column** row → Task 2, with a mandatory red-first step. §5 the portal shows nothing, across four surfaces including the narrative `deliveryNote` path → Task 10. §6.3 `instructions` / `checklistTemplateId` on both create/update payloads and on `applyTemplateSet` → Tasks 4, 5. §6.4 the sweep change inside the existing per-occurrence transaction, with `service_management_off` seeding nothing → Tasks 6, 11. §6.5 read-only AI plus the explicit no-tick-off pin → Task 9. §7 the occurrence-drawer chip with one lazy expansion (not 24 mounted cards), the instructions panel labelling, and the deliverable/template-item form controls → Tasks 7, 8. §9 every listed unit case, the seeding integration suite and the portal non-disclosure suite → Tasks 4, 5, 6, 10, 11.

Out of scope and deliberately absent, per spec §8: any portal exposure; auto-resolve or auto-deliver on completion (permanently rejected); a blocking `checklist_required` guard (OD-4 C, deferred); AI tick-off (OD-7, deferred); the mobile app; per-step assignee, due date or dependencies; nested checklists; backfilling onto already-`open` occurrences; a badge in the ticket list.

**Placeholders.** None. Five places deliberately instruct a lookup rather than guessing, each naming the file: whether `text`/`uuid` are already imported in the two schema files (Task 2 Step 1), the live contents of the two export-policy arrays before appending (Task 2 Step 2), the existing sweep-invocation helper the integration suites use (Task 11), the portal auth-header helper (Task 10), and the `listTemplateSets` return shape (Task 9 Step 3).

**One deliberate refinement of the spec**, recorded in Task 6: the instructions comment uses `commentType: 'internal'` rather than the spec's `'system'`, matching `deliverableAutoEvidence.ts:177` — the other comment this same sweep posts on this same ticket. The property the spec requires (`is_public = false`, never reaching the portal) is identical either way, and Task 10 asserts it.

**Type consistency.** `instructions` and `checklistTemplateId` are spelled that way in the Drizzle schema, the validators, the services, the AI tools and the web forms; the SQL columns are `instructions` and `checklist_template_id` in the migration and the export policy. `assertChecklistTemplateUsableByOrg`, `assertChecklistTemplateUsableByTemplateItemOwner`, `findChecklistTemplateReferences` and `assertChecklistTemplateNotInUse` are spelled identically in Tasks 3, 4 and 5. Error codes `CHECKLIST_TEMPLATE_IN_USE` (409), `CHECKLIST_TEMPLATE_NOT_IN_TARGET_ORG` (409) and `NOT_FOUND` (404) match the index's cross-wave list. `Occurrence.checklist` is `{ done: number; total: number } | null` in the service, the web type and the drawer. `source: 'deliverable'` on sweep-created rows matches W01's enum exactly.

**Cross-wave contracts consumed.** W01: `addChecklistItem`'s optional executor parameter, `listChecklist`, `checklistCountsForTickets`, `TicketChecklistCard`'s `compact` mode, and the `isInteractiveUserSession` gate this wave must not weaken. W02: `ticketChecklistTemplates`, `ticketChecklistTemplateItems`, `loadChecklistTemplateOr404` and `deleteChecklistTemplate`, into which the in-use guard is wired. Every one of them existed and was exercised in its own wave, so nothing here depends on an unverified promise.
