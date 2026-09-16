-- SEC-038 W06 (#5537): agent desktop start/terminal fence capability handshake.
--
-- One expansion-only column, no data migration:
--
--   devices.desktop_fence_protocol_version
--     Mirrors devices.revocation_lease_protocol_version (#5481). 1 = this agent
--     build keeps the durable per-session start/terminal generation fence
--     (W04/W05): it refuses any desktop start not strictly newer than
--     everything it has already seen and refuses all starts after a terminal.
--     0 (the default, and every pre-existing row) means "not fenced". Behind
--     REMOTE_DESKTOP_FENCE_REQUIRED (default off; flipped one release after
--     W06 ships) every desktop-start dispatch site refuses such an agent with
--     503 agent_upgrade_required. Written NON-STICKY on every heartbeat, so an
--     agent DOWNGRADE reports back down to 0 rather than leaving a stale
--     capability claim the dispatch gate would wrongly trust.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS only. No RLS changes — devices already
-- carries its org_id policies. No DML, so no breeze.scope preamble is required.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS desktop_fence_protocol_version integer NOT NULL DEFAULT 0;
