-- Explicit, non-sticky protocol capabilities reported by the current agent
-- heartbeat. Zero means absent, malformed, unknown, or unsupported. These
-- columns inherit the existing devices RLS and tenant lifecycle behavior.

ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS peripheral_policy_protocol_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rollback_protocol_version integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.devices.peripheral_policy_protocol_version IS
  'Current-heartbeat peripheral policy protocol capability; recognized value is 2, otherwise 0.';

COMMENT ON COLUMN public.devices.rollback_protocol_version IS
  'Current-heartbeat signed rollback protocol capability; recognized value is 1, otherwise 0.';
