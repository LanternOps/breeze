-- Ticket checklist items (spec docs/superpowers/specs/billing/2026-09-14-ticket-checklists-spec.md §4.1).
--
-- Tenancy shape 1: a direct, NOT NULL org_id denormalized from the parent
-- ticket — the same shape ticket_attachments and ticket_parts use, chosen over
-- a shape-5 EXISTS-join policy because this table is read on every ticket open.
-- The cost of the denormalization is that BOTH org movers must re-stamp the
-- column and both must name the composite FK in their SET CONSTRAINTS lists
-- (services/ticketOrgMoveLockOrder.ts, routes/devices/moveOrg.ts) — registered
-- in the same PR as this migration.
--
-- Idempotent throughout. DDL only: no rows are written, so no breeze.scope
-- election is required. No inner BEGIN/COMMIT — autoMigrate wraps each file.
-- No per-table GRANT: ensureAppRole.ts grants breeze_app on every public table
-- (plus ALTER DEFAULT PRIVILEGES) at boot, same as 2026-10-16-110100.

-- ============================================
-- 1. Provenance enum
-- ============================================
-- 'manual'             a technician typed this step on this ticket
-- 'deliverable'        the daily deliverable sweep seeded it (W03)
-- 'checklist_template' a technician applied a checklist template by hand (W02)
DO $$ BEGIN
  CREATE TYPE ticket_checklist_item_source AS ENUM ('manual', 'deliverable', 'checklist_template');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================
-- 2. ticket_checklist_items
-- ============================================
CREATE TABLE IF NOT EXISTS ticket_checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  ticket_id UUID NOT NULL,
  label VARCHAR(500) NOT NULL,
  detail TEXT,
  -- No unique constraint on (ticket_id, position): a whole-list reorder writes
  -- every row in ONE statement (spec §6.1), and a partial unique would force
  -- deferral machinery for no benefit. Reads order by (position, created_at,
  -- id) so the order is total even when two rows tie on position.
  position INTEGER NOT NULL DEFAULT 0,
  -- done_at is THE authority for "done". done_by_user_id is best-effort
  -- attribution and is ON DELETE SET NULL, which is exactly why there is no
  -- CHECK tying the two together: deleting the user would otherwise break the
  -- check on a legitimately-completed row.
  done_at TIMESTAMPTZ,
  done_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  source ticket_checklist_item_source NOT NULL DEFAULT 'manual',
  -- Provenance only, deliberately NO FK: the source template may be
  -- partner-wide (org_id IS NULL), so no composite org FK is expressible, and
  -- the template item may later be deleted. Never joined for authorization.
  source_template_item_id UUID,
  -- Left NULL for sweep-created rows: DELIVERABLE_SWEEP_ACTOR.userId is the nil
  -- UUID '00000000-0000-0000-0000-000000000000'
  -- (services/serviceDeliverableService.ts) and is NOT a real users row, so
  -- writing it would 23503. Nullability is the system-provenance marker;
  -- `source` says where the row came from.
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Composite same-org FK. DEFERRABLE INITIALLY IMMEDIATE is MANDATORY: org merge
-- runs SET CONSTRAINTS ALL DEFERRED and re-points parent and child org_id in
-- separate statements, and both org movers defer this constraint BY NAME while
-- they re-stamp tickets.org_id. A non-deferrable version aborts the merge with
-- 23503 and only reddens under Integration Tests. Target index:
-- tickets_id_org_uq, created by 2026-09-25-ai-agents-ticket-triage.sql.
DO $$ BEGIN
  ALTER TABLE ticket_checklist_items ADD CONSTRAINT ticket_checklist_items_ticket_org_fk
    FOREIGN KEY (ticket_id, org_id) REFERENCES tickets(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS ticket_checklist_items_ticket_pos_idx
  ON ticket_checklist_items (ticket_id, position);
CREATE INDEX IF NOT EXISTS ticket_checklist_items_org_idx
  ON ticket_checklist_items (org_id);

ALTER TABLE ticket_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_checklist_items FORCE ROW LEVEL SECURITY;

-- Shape 1. rls-coverage.integration.test.ts AUTO-DISCOVERS a direct org_id
-- table, so there is NO allowlist entry to add for this one.
DROP POLICY IF EXISTS ticket_checklist_items_isolation ON ticket_checklist_items;
CREATE POLICY ticket_checklist_items_isolation
  ON ticket_checklist_items
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_org_access(org_id)
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_org_access(org_id)
  );
