-- Caller verification W05 (#6354 / #6359): pin the Entra target of an
-- identity-changing action intent at creation, and record the moment its
-- backend dispatch started.
--
--   target_entra_tenant_id / target_entra_oid — the canonical Entra subject the
--     creation-time check resolved (never a UPN: a rename must not redirect an
--     approved intent).
--   target_connection_ref — the Microsoft connection (m365_connections or
--     delegant_m365_connections) the target was resolved through. A SNAPSHOT,
--     deliberately WITHOUT a foreign key: the release path re-loads the row and
--     refuses when it is gone or re-pointed, and the reference must survive the
--     connection's deletion as evidence.
--   dispatch_started_at — written once, in a committed transaction under the
--     requester+target subject locks, immediately before the outbound mutation.
--     Rejection fan-out reads it to report "dispatched before rejection"
--     honestly. Mutable by design (lifecycle marker, not identity).
--
-- The three pinned columns are immutable after INSERT (separate trigger so the
-- existing content trigger, last replaced in
-- 2026-10-14-100200-ai-operator-intent-identity.sql, is untouched) and are
-- either all set or all null. Existing rows stay null: an unpinned protected
-- intent refuses release; nothing is backfilled through a mutable UPN.
-- DDL only — no row writes, so no system-scope election is needed.

ALTER TABLE action_intents
  ADD COLUMN IF NOT EXISTS target_entra_tenant_id varchar(64),
  ADD COLUMN IF NOT EXISTS target_entra_oid varchar(64),
  ADD COLUMN IF NOT EXISTS target_connection_ref uuid,
  ADD COLUMN IF NOT EXISTS dispatch_started_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'action_intents_caller_target_all_or_none_chk'
      AND conrelid = 'action_intents'::regclass
  ) THEN
    ALTER TABLE action_intents
      ADD CONSTRAINT action_intents_caller_target_all_or_none_chk CHECK (
        (target_entra_tenant_id IS NULL) = (target_entra_oid IS NULL)
        AND (target_entra_oid IS NULL) = (target_connection_ref IS NULL)
      );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION action_intents_block_caller_target_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.target_entra_tenant_id IS DISTINCT FROM NEW.target_entra_tenant_id
     OR OLD.target_entra_oid IS DISTINCT FROM NEW.target_entra_oid
     OR OLD.target_connection_ref IS DISTINCT FROM NEW.target_connection_ref THEN
    RAISE EXCEPTION 'action intent caller target is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS action_intents_caller_target_immutable ON action_intents;
CREATE TRIGGER action_intents_caller_target_immutable
  BEFORE UPDATE ON action_intents FOR EACH ROW
  EXECUTE FUNCTION action_intents_block_caller_target_update();
