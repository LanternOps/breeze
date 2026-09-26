-- M2 (#5998) D7: discovery dispatch authority. Before a discovery command is
-- sent, the worker persists a bounded, secret-free authorization snapshot on the
-- job (scope, collecting device id — never the transport agentId —, included
-- and excluded targets, requested protocols/contexts, configuration generation,
-- negotiated adjacency capability, deadline). Physical adjacency admission
-- (POST /agents/:id/topology/adjacency) revalidates every report against it.
--
-- The three columns are set together or not at all (legacy-only dispatch).
-- Adds columns + constraints only; writes no rows. Idempotent.
ALTER TABLE discovery_jobs ADD COLUMN IF NOT EXISTS topology_dispatch jsonb;
ALTER TABLE discovery_jobs ADD COLUMN IF NOT EXISTS topology_deadline_at timestamptz;
ALTER TABLE discovery_jobs ADD COLUMN IF NOT EXISTS topology_config_generation varchar(64);

ALTER TABLE discovery_jobs DROP CONSTRAINT IF EXISTS discovery_jobs_topology_dispatch_chk;
ALTER TABLE discovery_jobs ADD CONSTRAINT discovery_jobs_topology_dispatch_chk CHECK (
  num_nonnulls(topology_dispatch, topology_deadline_at, topology_config_generation) IN (0, 3)
  AND (topology_dispatch IS NULL OR (jsonb_typeof(topology_dispatch) = 'object' AND octet_length(topology_dispatch::text) <= 65536))
  AND (topology_config_generation IS NULL OR topology_config_generation ~ '^[0-9a-f]{64}$')
);
