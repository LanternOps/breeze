-- Deliverable -> checklist wiring (spec
-- docs/superpowers/specs/billing/2026-09-14-ticket-checklists-spec.md §4.4).
--
-- Adds internal `instructions` prose and a live `checklist_template_id` pointer
-- to both the deliverable and the deliverable TEMPLATE ITEM it is applied from.
-- Idempotent (ADD COLUMN IF NOT EXISTS, DO $$ … EXCEPTION). No inner
-- BEGIN/COMMIT (autoMigrate wraps each file). Writes NO rows, so no
-- breeze.scope election is required — if a later edit adds a backfill,
-- `SELECT set_config('breeze.scope','system',true);` must be its first
-- statement and this file must NEVER be added to migrationRlsScope.test.ts's
-- frozen baseline.
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
-- defeat the entire Partner-Wide First point of the feature.
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

-- ============================================
-- 1. service_deliverables
-- ============================================
ALTER TABLE service_deliverables ADD COLUMN IF NOT EXISTS instructions TEXT;
ALTER TABLE service_deliverables ADD COLUMN IF NOT EXISTS checklist_template_id UUID;

DO $$ BEGIN
  ALTER TABLE service_deliverables ADD CONSTRAINT service_deliverables_checklist_template_fk
    FOREIGN KEY (checklist_template_id) REFERENCES ticket_checklist_templates(id)
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Partial index for the DELETE GUARD: it asks "does anything reference this
-- template?" on every template delete, and a full-table scan of
-- service_deliverables per delete is not acceptable.
CREATE INDEX IF NOT EXISTS service_deliverables_checklist_template_idx
  ON service_deliverables (checklist_template_id) WHERE checklist_template_id IS NOT NULL;

-- ============================================
-- 2. deliverable_template_items
-- ============================================
ALTER TABLE deliverable_template_items ADD COLUMN IF NOT EXISTS instructions TEXT;
ALTER TABLE deliverable_template_items ADD COLUMN IF NOT EXISTS checklist_template_id UUID;

DO $$ BEGIN
  ALTER TABLE deliverable_template_items ADD CONSTRAINT deliverable_template_items_checklist_template_fk
    FOREIGN KEY (checklist_template_id) REFERENCES ticket_checklist_templates(id)
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS deliverable_template_items_checklist_template_idx
  ON deliverable_template_items (checklist_template_id) WHERE checklist_template_id IS NOT NULL;
