-- ticket_external_refs: a ticket's id/url in an external PSA/ITSM,
-- namespaced by the partner service principal that owns the integration.
--
-- Why a table and not `tickets.external_ticket_id` (#7181 review): a bare
-- partner-wide unique key is wrong twice — two integrations on one partner
-- can legitimately hold the same id, and `tickets.partner_id` is nullable so
-- a partner-wide index has no rule for null rows. Qualifying the id by its
-- SOURCE, the way psa_ticket_mappings is qualified by connection_id, makes
-- the natural key (principal, external_id). The legacy tickets columns are
-- left untouched (still returned by the staff detail route); folding them in
-- is a follow-up.
--
-- Tenancy: shape 1 (org_id) — the row belongs to the ticket's organization
-- and follows it through erasure (org cascade), merge (repoint) and org
-- MOVES: it has a ticket_id AND a denormalized org_id, so it is registered
-- on BOTH movers (TICKET_ORG_DENORMALIZED_TABLES / CUSTOM_ORG_REWRITE_TABLES),
-- and on the org-merge walk (TICKET_CHILD_ORG_REWRITE_LOCK_ORDER), appended
-- last on each axis after ticket_checklist_items.
--
-- The ref's org FOLLOWS ITS TICKET'S org by schema, not by convention
-- (#7490 review): the composite (ticket_id, org_id) -> tickets(id, org_id)
-- FK (the time_entries / ticket_parts / ticket_checklist_items pattern,
-- target index tickets_id_org_uq) rejects a ref whose org_id differs from its
-- ticket's, even inside one partner. It is DEFERRABLE INITIALLY IMMEDIATE:
-- both movers UPDATE tickets.org_id BEFORE re-stamping the children, so they
-- name ticket_external_refs_ticket_org_fk in their SET CONSTRAINTS …
-- DEFERRED statements, and org merge covers it with SET CONSTRAINTS ALL
-- DEFERRED. The single-column ticket_id FK is kept (redundant, never
-- permissive: FKs are evaluated conjunctively).
--
-- Tenant coherence is enforced by the database, not by convention:
-- partner_id is NOT NULL, (partner_service_principal_id, partner_id) must be
-- a principal OF that partner, and (org_id, partner_id) must be an
-- organization OF that partner. The org composite is DEFERRABLE INITIALLY
-- IMMEDIATE, as every composite org FK must be (org merge runs SET
-- CONSTRAINTS ALL DEFERRED and re-points parent and child in separate
-- statements). A ref therefore cannot follow its ticket to ANOTHER partner:
-- the device mover deletes it on a cross-partner move (the integration that
-- owns it can never read the ticket again, and keeping the row would pin
-- its external id forever).
--
-- Uniqueness covers soft-deleted tickets too: a restore can never collide,
-- and a create/PATCH that reuses an id answers 409 EXTERNAL_ID_CONFLICT
-- naming the holder (with `existingDeleted`), so the integration can
-- restore-or-relink instead of duplicating.
--
-- Fully idempotent — safe to re-run. Nothing here writes rows.

CREATE TABLE IF NOT EXISTS ticket_external_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  partner_service_principal_id uuid NOT NULL,
  external_id varchar(255) NOT NULL,
  external_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_external_refs_principal_partner_fk
    FOREIGN KEY (partner_service_principal_id, partner_id)
    REFERENCES partner_service_principals(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT ticket_external_refs_org_partner_fk
    FOREIGN KEY (org_id, partner_id)
    REFERENCES organizations(id, partner_id) ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE
);

DO $$ BEGIN
  ALTER TABLE ticket_external_refs ADD CONSTRAINT ticket_external_refs_ticket_org_fk
    FOREIGN KEY (ticket_id, org_id) REFERENCES tickets(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ticket_external_refs_principal_external_uq
  ON ticket_external_refs (partner_service_principal_id, external_id);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_external_refs_principal_ticket_uq
  ON ticket_external_refs (partner_service_principal_id, ticket_id);
CREATE INDEX IF NOT EXISTS ticket_external_refs_ticket_idx
  ON ticket_external_refs (ticket_id);
CREATE INDEX IF NOT EXISTS ticket_external_refs_org_idx
  ON ticket_external_refs (org_id);
CREATE INDEX IF NOT EXISTS ticket_external_refs_partner_idx
  ON ticket_external_refs (partner_id);

ALTER TABLE ticket_external_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_external_refs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON ticket_external_refs;
CREATE POLICY breeze_org_isolation_select ON ticket_external_refs
  FOR SELECT USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ticket_external_refs;
CREATE POLICY breeze_org_isolation_insert ON ticket_external_refs
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_update ON ticket_external_refs;
CREATE POLICY breeze_org_isolation_update ON ticket_external_refs
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ticket_external_refs;
CREATE POLICY breeze_org_isolation_delete ON ticket_external_refs
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_external_refs TO breeze_app;
