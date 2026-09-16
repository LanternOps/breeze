-- Ticket checklist templates and their items (spec
-- docs/superpowers/specs/billing/2026-09-14-ticket-checklists-spec.md §4.2, §4.3).
--
-- Dual-ownership per CLAUDE.md "Partner-Wide First": org_id XOR partner_id. An
-- MSP authors one procedure and every org it manages — present and future —
-- inherits it. DDL only: no rows are written, so no breeze.scope election.
-- No inner BEGIN/COMMIT (autoMigrate wraps each file). No per-table GRANT:
-- ensureAppRole.ts grants breeze_app on every public table at boot.
--
-- OWNER INTEGRITY: items pin to their template through TWO BRANCH FKs, not one
-- three-column FK. Postgres FKs default to MATCH SIMPLE, so a
-- (template_id, org_id, partner_id) FK would be satisfied without a lookup on
-- every row (the XOR guarantees one owner column is NULL) — i.e. never checked.
-- MATCH FULL is the mirror failure: it demands all-NULL or all-non-NULL, which
-- the XOR shape can never satisfy. With two branch FKs exactly one is live per
-- row, and a cross-owner item raises 23503.

-- ============================================
-- 1. ticket_checklist_templates
-- ============================================
CREATE TABLE IF NOT EXISTS ticket_checklist_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id),
  partner_id UUID REFERENCES partners(id),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  -- Internal runbook prose for the whole checklist. NEVER rendered in the
  -- customer portal (spec §5) — free text, never parsed into steps.
  instructions TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE ticket_checklist_templates ADD CONSTRAINT ticket_checklist_templates_one_owner_chk
    CHECK ((org_id IS NULL) <> (partner_id IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Partial so the NULL axis never participates: a partner-wide template and an
-- org-owned template may legitimately share a name.
CREATE UNIQUE INDEX IF NOT EXISTS ticket_checklist_templates_partner_name_uq
  ON ticket_checklist_templates (partner_id, name) WHERE partner_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ticket_checklist_templates_org_name_uq
  ON ticket_checklist_templates (org_id, name) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ticket_checklist_templates_partner_idx ON ticket_checklist_templates (partner_id);
CREATE INDEX IF NOT EXISTS ticket_checklist_templates_org_idx ON ticket_checklist_templates (org_id);

-- FK targets for the two BRANCH foreign keys on items. These must be
-- non-partial, non-expression unique indexes or Postgres refuses to reference
-- them. `id` is the PK so uniqueness is trivial; the extra column is what makes
-- the FK carry the owner axis.
CREATE UNIQUE INDEX IF NOT EXISTS ticket_checklist_templates_id_org_uq
  ON ticket_checklist_templates (id, org_id);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_checklist_templates_id_partner_uq
  ON ticket_checklist_templates (id, partner_id);

ALTER TABLE ticket_checklist_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_checklist_templates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ticket_checklist_templates_isolation ON ticket_checklist_templates;
CREATE POLICY ticket_checklist_templates_isolation
  ON ticket_checklist_templates
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

-- Separate, additive, SELECT-ONLY partner-wide read branch (#4673; template
-- 2026-10-05-110000-config-policy-partner-wide-select.sql). It is what lets an
-- ORG-scoped session see its own MSP's shared templates at all:
-- breeze_has_org_access(NULL) and breeze_has_partner_access(P) are BOTH false
-- for an org token, so without this branch an org context is silently blind to
-- every partner-wide row — no error, just nothing.
--
-- NEVER append this to the FOR ALL policy above. Postgres does not consult FOR
-- SELECT policies when computing UPDATE/DELETE target rows, so a separate
-- permissive policy widens reads and nothing else; folding it in would let an
-- org admin DELETE their MSP's shared template.
--
-- `=` and not `IS NOT DISTINCT FROM`: the latter would match rows whose
-- partner_id is NULL against a caller with no partner GUC.
DROP POLICY IF EXISTS ticket_checklist_templates_partner_wide_select ON ticket_checklist_templates;
CREATE POLICY ticket_checklist_templates_partner_wide_select
  ON ticket_checklist_templates
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

-- ============================================
-- 2. ticket_checklist_template_items
-- ============================================
-- The item copies the template's owner columns, carries the SAME XOR check, and
-- pins itself to the template through TWO branch FKs (rationale in the header).
CREATE TABLE IF NOT EXISTS ticket_checklist_template_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL,
  org_id UUID REFERENCES organizations(id),
  partner_id UUID REFERENCES partners(id),
  label VARCHAR(500) NOT NULL,
  detail TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE ticket_checklist_template_items ADD CONSTRAINT ticket_checklist_template_items_one_owner_chk
    CHECK ((org_id IS NULL) <> (partner_id IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Both branch FKs are DEFERRABLE INITIALLY IMMEDIATE: they reference an
-- org_id/partner_id column pair, and org merge re-points parent and child in
-- separate statements under SET CONSTRAINTS ALL DEFERRED.
DO $$ BEGIN
  ALTER TABLE ticket_checklist_template_items ADD CONSTRAINT ticket_checklist_template_items_template_org_fk
    FOREIGN KEY (template_id, org_id) REFERENCES ticket_checklist_templates(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ticket_checklist_template_items ADD CONSTRAINT ticket_checklist_template_items_template_partner_fk
    FOREIGN KEY (template_id, partner_id) REFERENCES ticket_checklist_templates(id, partner_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One label per template: applying a template must not produce two identical
-- steps, which reads as a rendering bug rather than a data one.
CREATE UNIQUE INDEX IF NOT EXISTS ticket_checklist_template_items_template_label_uq
  ON ticket_checklist_template_items (template_id, label);
CREATE INDEX IF NOT EXISTS ticket_checklist_template_items_template_sort_idx
  ON ticket_checklist_template_items (template_id, sort_order);
CREATE INDEX IF NOT EXISTS ticket_checklist_template_items_partner_idx ON ticket_checklist_template_items (partner_id);
CREATE INDEX IF NOT EXISTS ticket_checklist_template_items_org_idx ON ticket_checklist_template_items (org_id);

ALTER TABLE ticket_checklist_template_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_checklist_template_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ticket_checklist_template_items_isolation ON ticket_checklist_template_items;
CREATE POLICY ticket_checklist_template_items_isolation
  ON ticket_checklist_template_items
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

DROP POLICY IF EXISTS ticket_checklist_template_items_partner_wide_select ON ticket_checklist_template_items;
CREATE POLICY ticket_checklist_template_items_partner_wide_select
  ON ticket_checklist_template_items
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
