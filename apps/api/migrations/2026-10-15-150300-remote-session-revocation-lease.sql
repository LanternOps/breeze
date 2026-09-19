-- Fail-closed revocation lease for remote desktop sessions.
--
-- Two expansion-only columns, no data migration:
--
--   devices.revocation_lease_protocol_version
--     Agent capability handshake, mirroring the existing
--     outbound_network_policy_version / rollback_protocol_version columns.
--     0 (the default, and every pre-existing row) means "this agent build does
--     not renew a revocation lease", and every desktop-start dispatch site
--     refuses with 503 agent_upgrade_required. Written NON-STICKY on every
--     heartbeat, so an agent DOWNGRADE reports back down to 0 rather than
--     leaving a stale capability claim the dispatch gate would wrongly trust.
--
--   remote_sessions.permissions_epoch_snapshot
--     The users.permissions_epoch value captured when the session row was
--     created. The renew recheck compares the live epoch against this baseline,
--     so a membership removal / role change / site-scope change / role
--     force_mfa flip (all of which advance the epoch via the triggers in
--     2026-08-06-b-live-authorization.sql) revokes the live session at the next
--     renew. Redis caches the lease TTL only — it is NEVER the only baseline,
--     so a renew after a Redis flush re-derives the baseline from this column.
--     NULL for every row created before this migration; those sessions cannot
--     have carried a lease (the capability gate refuses them), and the renew
--     path treats a NULL baseline as a definitive negative (fail closed).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS only. No RLS changes — both tables
-- already carry their policies (devices: org_id; remote_sessions: org_id).
-- No DML, so no breeze.scope preamble is required.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS revocation_lease_protocol_version integer NOT NULL DEFAULT 0;

ALTER TABLE remote_sessions
  ADD COLUMN IF NOT EXISTS permissions_epoch_snapshot bigint;
