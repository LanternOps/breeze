-- Endpoint lookups on topology_relationships (physical-view counts, neighbourhood
-- frontiers, node-delete cascades) had no supporting index and seq-scanned the
-- table until the planner gathered statistics. Found by the M2 G10K projection test.
CREATE INDEX IF NOT EXISTS topology_relationships_source_node_idx
  ON topology_relationships (org_id, site_id, source_node_id);
CREATE INDEX IF NOT EXISTS topology_relationships_target_node_idx
  ON topology_relationships (org_id, site_id, target_node_id);
