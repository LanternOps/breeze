-- #5777: softwareDeploymentSiteScopePredicate (apps/api/src/routes/software.ts)
-- runs a correlated EXISTS/NOT EXISTS over deployment_results per deployment
-- row, filtered on deployment_id and joined to devices on device_id. Only
-- single-column indexes exist today (deployment_results_deployment_id_idx,
-- deployment_results_device_id_idx); a composite covers both predicate legs
-- in one index instead of an index scan on deployment_id followed by a
-- filter over every result row for that deployment.
--
-- Plain (non-CONCURRENTLY) CREATE INDEX takes a write lock on
-- deployment_results for its duration — acceptable here because the table is
-- an audit trail of deployment outcomes (bounded by deployment/device
-- fan-out, not an agent hot-write table) rather than a always-growing
-- high-volume table; see PR body for the operator-facing lock-time note.
CREATE INDEX IF NOT EXISTS deployment_results_deployment_id_device_id_idx
    ON deployment_results (deployment_id, device_id);
