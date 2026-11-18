-- @no-transaction
-- action_intents: partial index on the origin credential of LIVE MCP-origin
-- intents (B-W04 #6158, D-B27/D-B33).
--
-- A Tier-3 tools/call over MCP now files an action intent instead of failing
-- closed. createActionIntent caps the LIVE intents one MCP credential (API key
-- or OAuth grant) may hold across all orgs (MCP_INTENT_MAX_LIVE_PER_PRINCIPAL),
-- counting them under a per-origin advisory lock inside the creation
-- transaction. Without this index that count scans every action_intents row
-- for the source; with it the planner reads only the live rows of one
-- credential. The predicate matches the statuses the cap counts.
--
-- Tenancy: index only. No column, no policy, no registration change —
-- action_intents is already in CORE_ORG_CASCADE_DELETE_ORDER,
-- orgMergeRegistry.ts and CORE_TENANT_EXPORT_POLICY. Declared in SQL only,
-- like action_intents_org_idem_uniq (see db/schema/actionIntents.ts).
--
-- CREATE INDEX CONCURRENTLY (autoMigrate's @no-transaction lane) so the build
-- does not take a SHARE lock on this hot table at deploy time. No row writes,
-- so no breeze.scope line.

CREATE INDEX CONCURRENTLY IF NOT EXISTS action_intents_live_origin_idx
  ON action_intents (origin_principal_kind, origin_principal_id)
  WHERE source = 'mcp_api' AND status IN ('pending_approval', 'approved', 'executing');
