-- ticket_links (#7900, feature #8592 W02): typed links between two tickets of
-- ONE organization. A row reads "source <link_type> target"; the inverse
-- label (causes / resolved_by / duplicates / related) is derived at read time,
-- so there is exactly one row per link and no pair-consistency invariant.
--
-- Tenancy: shape 1 (direct org_id, breeze_has_org_access(org_id)). Both legs
-- are composite (ticket_id, org_id) -> tickets(id, org_id) FKs (target index
-- tickets_id_org_uq, created by 2026-09-25-ai-agents-ticket-triage.sql) that
-- share ONE org_id column, so a cross-org link is unrepresentable by schema,
-- not by convention. Both are DEFERRABLE INITIALLY IMMEDIATE, as every
-- composite org FK must be: org merge runs SET CONSTRAINTS ALL DEFERRED and
-- repoints tickets and this table in separate statements, and both org MOVERS
-- name the two constraints in their SET CONSTRAINTS ... DEFERRED statements.
--
-- Org move DELETES, never re-stamps (approved decision #10): a moved ticket's
-- counterpart stays behind, so a re-stamped row would have legs in two orgs.
-- The device axis re-stamps tickets.org_id inside the devices UPDATE (the
-- breeze_cascade_device_org_id() trigger), long before the movers' child
-- tail runs, which is why the deferral is mandatory: an IMMEDIATE check would
-- 23503 before the delete could execute. Registered in
-- TICKET_CHILD_ORG_REWRITE_LOCK_ORDER / TICKET_ORG_MOVE_DELETE_TABLES
-- (services/ticketOrgMoveLockOrder.ts), last on both axes.
--
-- Constraints:
--   - no self link;
--   - `related` is symmetric, so it is stored canonically (source < target)
--     and (A,B,related) / (B,A,related) cannot coexist;
--   - one row per (source, target, type);
--   - a ticket duplicates at most ONE canonical ticket.
--
-- Fully idempotent — safe to re-run. Nothing here writes rows, so no
-- breeze.scope election.

DO $$ BEGIN
  CREATE TYPE ticket_link_type AS ENUM ('caused_by', 'resolves', 'related', 'duplicate_of');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS ticket_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_ticket_id uuid NOT NULL,
  target_ticket_id uuid NOT NULL,
  link_type ticket_link_type NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_links_no_self_chk CHECK (source_ticket_id <> target_ticket_id),
  CONSTRAINT ticket_links_related_canonical_chk
    CHECK (link_type <> 'related' OR source_ticket_id < target_ticket_id)
);

DO $$ BEGIN
  ALTER TABLE ticket_links ADD CONSTRAINT ticket_links_source_org_fk
    FOREIGN KEY (source_ticket_id, org_id) REFERENCES tickets(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ticket_links ADD CONSTRAINT ticket_links_target_org_fk
    FOREIGN KEY (target_ticket_id, org_id) REFERENCES tickets(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ticket_links_pair_type_uq
  ON ticket_links (source_ticket_id, target_ticket_id, link_type);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_links_one_canonical_uq
  ON ticket_links (source_ticket_id) WHERE link_type = 'duplicate_of';
CREATE INDEX IF NOT EXISTS ticket_links_target_idx
  ON ticket_links (target_ticket_id);
CREATE INDEX IF NOT EXISTS ticket_links_org_idx
  ON ticket_links (org_id);

ALTER TABLE ticket_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON ticket_links;
CREATE POLICY breeze_org_isolation_select ON ticket_links
  FOR SELECT USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ticket_links;
CREATE POLICY breeze_org_isolation_insert ON ticket_links
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_update ON ticket_links;
CREATE POLICY breeze_org_isolation_update ON ticket_links
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ticket_links;
CREATE POLICY breeze_org_isolation_delete ON ticket_links
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_links TO breeze_app;
