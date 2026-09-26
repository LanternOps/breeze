-- Topology M3 Task 9 / M3-D13: routed traces carry the requester authority
-- frozen at acceptance (auth/MFA epochs, permission authority version, org and
-- partner membership) so enqueue, both delivery transports and result
-- publication can re-derive it live. Required for trace_route runs; optional
-- (NULL) for the M1 recipes, whose rows are untouched. No data is written.
ALTER TABLE topology_diagnostic_runs ADD COLUMN IF NOT EXISTS requester_authority jsonb;

ALTER TABLE topology_diagnostic_runs DROP CONSTRAINT IF EXISTS topology_diagnostic_runs_requester_authority_chk;
ALTER TABLE topology_diagnostic_runs ADD CONSTRAINT topology_diagnostic_runs_requester_authority_chk
  CHECK (requester_authority IS NULL OR (jsonb_typeof(requester_authority) = 'object' AND octet_length(requester_authority::text) <= 1024));

ALTER TABLE topology_diagnostic_runs DROP CONSTRAINT IF EXISTS topology_diagnostic_runs_trace_authority_chk;
ALTER TABLE topology_diagnostic_runs ADD CONSTRAINT topology_diagnostic_runs_trace_authority_chk
  CHECK (recipe_id <> 'trace_route' OR requester_authority IS NOT NULL);

-- The frozen authority is part of the accepted run, immutable like its plan.
CREATE OR REPLACE FUNCTION breeze_topology_diagnostic_run_authority_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.requester_authority IS DISTINCT FROM OLD.requester_authority THEN
  RAISE EXCEPTION 'accepted diagnostic requester authority is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS breeze_topology_diagnostic_run_authority_guard ON topology_diagnostic_runs;
CREATE TRIGGER breeze_topology_diagnostic_run_authority_guard BEFORE UPDATE OF requester_authority ON topology_diagnostic_runs
  FOR EACH ROW EXECUTE FUNCTION breeze_topology_diagnostic_run_authority_guard();
