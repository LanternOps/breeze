-- Native ticketing Phase 6: soft-delete for tickets (issue #2140).
-- A non-null deleted_at hides a ticket from every staff/portal list, stats
-- count, and by-id mutation, but preserves the row for audit + admin restore.
-- Mirrors ticket_comments.deleted_at. No RLS change: tickets is already
-- org-scoped (breeze_has_org_access(org_id)); these are plain data columns.
-- Gated in the API on the existing tickets:manage permission (Partner Admin /
-- Org Admin) — no new permission grant required.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS deleted_at timestamp;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS deleted_by uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'tickets_deleted_by_users_id_fk' AND table_name = 'tickets'
  ) THEN
    ALTER TABLE tickets
      ADD CONSTRAINT tickets_deleted_by_users_id_fk
      FOREIGN KEY (deleted_by) REFERENCES users(id);
  END IF;
END $$;

-- Partial index for the admin "Archived" view (the rare deleted-only scan). The
-- hot path (deleted_at IS NULL, every normal list) is already carried by the
-- existing org_id/status indexes ANDed into the same WHERE.
CREATE INDEX IF NOT EXISTS tickets_deleted_at_idx ON tickets (deleted_at) WHERE deleted_at IS NOT NULL;
