-- tickets.work_kind (feature #5573 W01, spec §4.8). Typed discriminator for planned
-- work; replaces a tag string. DDL only, no rows written.
-- Registration: tickets is already in every cascade list; the export-policy entry
-- for `tickets` gains `work_kind` in the same PR.
DO $$ BEGIN
  CREATE TYPE ticket_work_kind AS ENUM ('support','deliverable','project_task');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS work_kind ticket_work_kind NOT NULL DEFAULT 'support';
CREATE INDEX IF NOT EXISTS tickets_org_work_kind_idx ON tickets (org_id, work_kind) WHERE work_kind <> 'support';
