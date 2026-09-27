-- Agent consent/notification prompt capability handshake.
--
-- One expansion-only column, no data migration:
--
--   devices.consent_prompt_protocol_version
--     Mirrors devices.desktop_fence_protocol_version. 1 = this agent build
--     parses the `prompt` block on a desktop-stream-start command and gates
--     on it (consent dialog / on-screen notice) before capturing. 0 (the
--     default, and every pre-existing row, and any agent that omits the
--     field) means the agent silently ignores an unfamiliar `prompt` key and
--     streams unconditionally regardless of the resolved policy. Any
--     dispatch site that resolves a policy requiring consent or notification
--     must refuse a capability-0 agent rather than send a prompt block it
--     will not honor. Written NON-STICKY on every heartbeat, so an agent
--     DOWNGRADE reports back down to 0 rather than leaving a stale
--     capability claim the dispatch gate would wrongly trust.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS only. No RLS changes — devices already
-- carries its org_id policies. No DML, so no breeze.scope preamble is required.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS consent_prompt_protocol_version integer NOT NULL DEFAULT 0;
