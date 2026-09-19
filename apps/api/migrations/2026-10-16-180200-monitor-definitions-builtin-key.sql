-- Built-in default monitors (CPU / memory / disk) — follow-up to #5287 W02.
--
-- Each partner is provisioned three partner-wide monitor_definitions rows and
-- one partner-level configuration policy that attaches them, so every device
-- under the MSP is monitored out of the box. The rows are ORDINARY partner-
-- owned rows (editable, disable-able, deletable); `builtin_key` only marks
-- their origin for the UI badge and makes provisioning idempotent.
--
-- No DML here: provisioning runs in TypeScript (services/monitors/
-- builtInMonitors.ts) because each definition must be compiled into its alert
-- template / rule / automation, and that compiler lives in code.

ALTER TABLE monitor_definitions ADD COLUMN IF NOT EXISTS builtin_key varchar(64);

DO $$
BEGIN
  -- Built-ins are always partner-wide: an org-owned row can never carry a key.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitor_definitions_builtin_partner_chk') THEN
    ALTER TABLE monitor_definitions
      ADD CONSTRAINT monitor_definitions_builtin_partner_chk
      CHECK (builtin_key IS NULL OR partner_id IS NOT NULL);
  END IF;
END $$;

-- One row per (partner, key) while the row exists. Re-provisioning after a
-- partner deletes a built-in is prevented by the partners.settings marker, not
-- by this index.
CREATE UNIQUE INDEX IF NOT EXISTS monitor_definitions_partner_builtin_uidx
  ON monitor_definitions(partner_id, builtin_key)
  WHERE builtin_key IS NOT NULL;
