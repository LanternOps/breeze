-- @no-transaction
-- #11737: age-scan indexes for the report-first observation retention job
-- (jobs/observationRetention.ts). Indexes only: no data change, no tenancy
-- change.
--
-- The job selects rows by `received_at < cutoff` alone. The existing indexes
-- lead with device_id or org_id, so without these the batch SELECT walks the
-- heap, and after the backlog clears it would rescan dead and in-window rows
-- on every batch. The pointer probes (device_agent_health_latest PK,
-- device_software_inventory_state PK, software_inventory_observation_id_idx,
-- device_vuln_resolved_observation_idx) already have indexes.
--
-- CONCURRENTLY (autoMigrate's @no-transaction lane): both tables are written
-- on the agent hot path (every heartbeat, every inventory report), and a plain
-- CREATE INDEX takes a SHARE lock that blocks every insert for the whole
-- build. CONCURRENTLY takes SHARE UPDATE EXCLUSIVE instead (writes continue)
-- and waits for transactions already open on the table. IF NOT EXISTS keeps
-- re-application a no-op. An interrupted CONCURRENTLY build leaves an INVALID
-- index that IF NOT EXISTS would silently accept, so the DO block fails loudly
-- in that state.
-- Recovery: DROP INDEX CONCURRENTLY public.<name>, then let autoMigrate re-run
-- this file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_health_observations_received_at_idx
  ON public.agent_health_observations (received_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS software_inventory_observations_received_at_idx
  ON public.software_inventory_observations (received_at);

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname IN (
       'agent_health_observations_received_at_idx',
       'software_inventory_observations_received_at_idx'
     )
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'observation retention index build left INVALID index(es): % — DROP INDEX CONCURRENTLY each and re-apply this migration', bad;
  END IF;
END $$;
