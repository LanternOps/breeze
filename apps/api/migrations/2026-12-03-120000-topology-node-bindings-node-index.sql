-- Topology grouped overview (2026-10-02): node labels, inventory and the
-- complete-site grouping read resolve a node's binding by node_id on every
-- graph read. The table only had unique indexes on the bound inventory id, so
-- each `b.node_id = n.id` lookup was a sequential scan. Index only; no writes.
CREATE INDEX IF NOT EXISTS topology_binding_node_idx ON topology_node_bindings (org_id, site_id, node_id);
