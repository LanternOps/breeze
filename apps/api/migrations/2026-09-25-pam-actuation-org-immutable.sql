-- Track E org-merge contract
-- (docs/superpowers/specs/2026-08-31-s0-track-e-pam-org-merge-contract-design.md):
-- make pam_actuations tenancy DIRECTLY immutable. The composite
-- (device_id, org_id) / (elevation_request_id, org_id) FKs already force
-- lockstep at COMMIT; this makes the refusal immediate and per-row, closes
-- the parent-mutable/child-immutable asymmetry, and lets the org-merge
-- trigger classification list this guard as BLOCKING truthfully.
-- Replaces the function body only; the trigger from
-- 2026-09-16-pam-actuation-lifecycle.sql keeps pointing at it. Idempotent.
CREATE OR REPLACE FUNCTION pam_actuations_transition_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'PAM actuation tenancy is immutable';
  END IF;
  IF NEW.generation < OLD.generation THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'PAM actuation generation cannot decrease';
  END IF;
  IF OLD.desired_state = 'cleanup' AND NEW.desired_state <> 'cleanup' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'PAM cleanup tombstone is irreversible';
  END IF;
  RETURN NEW;
END;
$$;
