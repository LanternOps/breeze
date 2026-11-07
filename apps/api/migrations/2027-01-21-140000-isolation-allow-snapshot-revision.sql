-- #10100: what the server needs to carry a containment policy through an episode.
-- allow_snapshot_revision: the policy revision allow_snapshot was built with. The heartbeat's stored
--   fallback re-sends the snapshot, and the agent rejects scope:"any" entries without a revision.
-- applied_policy_revision: the revision the agent's journal says it last committed, so a policy change
--   counts as done only when the agent committed it, not when it reports "verified".
-- policy_event_seq: how far through the agent's journal the server has read policy events. The agent
--   resends its whole journal on every heartbeat.
ALTER TABLE device_network_isolations
  ADD COLUMN IF NOT EXISTS allow_snapshot_revision text,
  ADD COLUMN IF NOT EXISTS applied_policy_revision text,
  ADD COLUMN IF NOT EXISTS policy_event_seq bigint NOT NULL DEFAULT 0;
