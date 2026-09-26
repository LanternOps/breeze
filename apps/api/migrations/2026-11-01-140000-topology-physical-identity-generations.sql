-- M2 (#5998) Task 6, amendments D10/D13 and D15.2.
--
-- 1. Server-owned SNMP interface generations. A physical interface row's epoch
--    is `gen:<n>`; `phys_address` is its ifPhysAddress continuity evidence and
--    `retired_at` marks a generation replaced by a conflicting report (links on
--    it are never inherited by the next generation). At most one current
--    physical generation exists per owner+key.
-- 2. Explicit identity-revision dirty mark for the physical re-resolution pass:
--    identity writers (bindings, interface generations, merges) bump
--    identity_revision; the publisher resolves candidates while it exceeds
--    resolved_identity_revision.
--
-- Schema only; no rows are written. Every statement is idempotent.
ALTER TABLE topology_interfaces ADD COLUMN IF NOT EXISTS phys_address varchar(32);
ALTER TABLE topology_interfaces ADD COLUMN IF NOT EXISTS retired_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS topology_interfaces_current_generation_uniq
  ON topology_interfaces (owner_node_id, interface_key)
  WHERE retired_at IS NULL AND epoch LIKE 'gen:%';

ALTER TABLE topology_site_state ADD COLUMN IF NOT EXISTS identity_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE topology_site_state ADD COLUMN IF NOT EXISTS resolved_identity_revision bigint NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'topology_site_state_identity_revision_chk'
      AND conrelid = 'public.topology_site_state'::regclass) THEN
    ALTER TABLE topology_site_state ADD CONSTRAINT topology_site_state_identity_revision_chk
      CHECK (identity_revision >= 0 AND resolved_identity_revision >= 0);
  END IF;
END $$;

-- 3. Observation content stays immutable, but its REFERENCES may migrate: a node
--    merge re-owns interfaces (subject_node_id/subject_interface_id must follow
--    the interface owner, composite FK) and physical re-resolution moves a row's
--    support to its resolved relationship (relationship_id). Runs are unchanged.
CREATE OR REPLACE FUNCTION breeze_topology_evidence_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed text[];
BEGIN
  allowed := CASE TG_TABLE_NAME WHEN 'topology_collection_runs'
    THEN ARRAY['org_id','materialized_at','updated_at']
    ELSE ARRAY['org_id','withdrawn_at','updated_at','relationship_id','subject_node_id','subject_interface_id'] END;
  IF to_jsonb(NEW) - allowed IS DISTINCT FROM to_jsonb(OLD) - allowed THEN
    RAISE EXCEPTION 'Topology historical evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
