-- Ticket intake forms (spec: docs/superpowers/specs/2026-07-10-ticket-intake-forms-design.md).
-- Dual-axis config table (Partner-Wide First, epic #2135): org_id XOR partner_id.
-- Idempotent: CREATE IF NOT EXISTS, guarded CHECK, DROP POLICY IF EXISTS then CREATE.
-- No inner BEGIN/COMMIT (autoMigrate wraps each file in a transaction).

CREATE TABLE IF NOT EXISTS ticket_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(200) NOT NULL,
  description text,
  category_id uuid REFERENCES ticket_categories(id) ON DELETE SET NULL,
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  title_template varchar(300),
  description_intro text,
  default_priority ticket_priority,
  default_tags text[] NOT NULL DEFAULT '{}',
  show_in_portal boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- Exactly one owner: org-scoped XOR partner-wide.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ticket_forms_one_owner_chk'
      AND conrelid = 'ticket_forms'::regclass
  ) THEN
    ALTER TABLE ticket_forms
      ADD CONSTRAINT ticket_forms_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ticket_forms_partner_id_idx ON ticket_forms(partner_id);
CREATE INDEX IF NOT EXISTS ticket_forms_org_id_idx ON ticket_forms(org_id);

-- RLS: dual-axis (shape: org-access OR partner-access OR system), one policy
-- for all commands — mirrors 2026-07-01-maintenance-windows-partner-ownership.sql.
ALTER TABLE ticket_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_forms FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ticket_forms_isolation ON ticket_forms;
CREATE POLICY ticket_forms_isolation
  ON ticket_forms
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
