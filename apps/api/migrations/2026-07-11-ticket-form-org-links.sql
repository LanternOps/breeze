-- Org allowlist for partner-wide ticket_forms (spec §5, epic #2135 follow-on;
-- plan: docs/superpowers/plans/ticketing/2026-07-11-ticket-intake-forms-phase2.md).
--
-- Semantics: no link rows for a form = visible to every org under the owning
-- partner; rows present = allowlist (only the linked orgs see the form).
-- Only meaningful for partner-wide ticket_forms rows (org_id IS NULL,
-- partner_id set) — org-owned forms never have links.
--
-- This is an FK-child of the dual-axis ticket_forms parent. RLS reaches
-- tenancy by joining through ticket_forms (system OR org-access OR
-- partner-access on the PARENT row), mirroring how
-- 2026-07-01-maintenance-windows-partner-ownership.sql re-issued the
-- maintenance_occurrences FK-child policy with the dual-axis parent
-- predicate. A plain breeze_has_org_access(ticket_form_org_links.org_id)
-- policy would be WRONG here: this table's own org_id column is the
-- ALLOWLISTED org (arbitrary data), not the tenancy axis — the row must be
-- visible to whoever can see the owning ticket_forms row (its org OR its
-- partner), not merely to the one org named in the link.
--
-- Idempotent: CREATE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, DROP POLICY
-- IF EXISTS then CREATE. No inner BEGIN/COMMIT (autoMigrate wraps each file
-- in a transaction). Never edit this file after it ships — fix forward.

CREATE TABLE IF NOT EXISTS ticket_form_org_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id uuid NOT NULL REFERENCES ticket_forms(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ticket_form_org_links_form_org_uq
  ON ticket_form_org_links(form_id, org_id);
CREATE INDEX IF NOT EXISTS ticket_form_org_links_form_id_idx ON ticket_form_org_links(form_id);
CREATE INDEX IF NOT EXISTS ticket_form_org_links_org_id_idx ON ticket_form_org_links(org_id);

-- RLS: FK-child join through the dual-axis ticket_forms parent predicate.
ALTER TABLE ticket_form_org_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_form_org_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ticket_form_org_links_isolation ON ticket_form_org_links;
CREATE POLICY ticket_form_org_links_isolation
  ON ticket_form_org_links
  USING (
    EXISTS (
      SELECT 1 FROM ticket_forms tf
      WHERE tf.id = ticket_form_org_links.form_id
        AND (
          public.breeze_current_scope() = 'system'
          OR (tf.org_id IS NOT NULL AND public.breeze_has_org_access(tf.org_id))
          OR (tf.partner_id IS NOT NULL AND public.breeze_has_partner_access(tf.partner_id))
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM ticket_forms tf
      WHERE tf.id = ticket_form_org_links.form_id
        AND (
          public.breeze_current_scope() = 'system'
          OR (tf.org_id IS NOT NULL AND public.breeze_has_org_access(tf.org_id))
          OR (tf.partner_id IS NOT NULL AND public.breeze_has_partner_access(tf.partner_id))
        )
    )
  );
