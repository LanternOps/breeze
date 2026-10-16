-- PAM ownership epochs W4 (#8206, feature #8202): the ownership epoch whose
-- identity the agent has loaded, as it last reported on a heartbeat.
--
-- Written only by the heartbeat route, monotonically and never above
-- devices.ownership_epoch. The PAM actuation worker dispatches only when it
-- equals ownership_epoch; NULL (an agent that has never reported an epoch)
-- counts as acknowledged only at ownership_epoch = 1, so devices that were
-- never moved keep receiving PAM commands from existing agents.
--
-- Plain nullable integer on the existing devices table: RLS is unchanged, no
-- cascade or merge registration is needed, and the column is classified
-- `included` in CORE_TENANT_EXPORT_POLICY.
--
-- DDL only (no row writes), idempotent, no inner transaction control.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS agent_identity_epoch_ack integer;
