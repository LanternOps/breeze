-- #8318 wave 1a — the install incarnation boundary
-- (docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
-- §4.1). Part 1 of 3: `devices` only.
--
-- devices.install_incarnation counts the agent installs that have owned the
-- row. It is 1 for every device today (the original install) and advances by
-- exactly one when a reattach confirm hands the row to a new install. Nothing
-- advances it until wave 1b's confirm ships.
--
--   install_incarnation     integer NOT NULL DEFAULT 1 (catalog-only: constant
--                           default, no table rewrite)
--   incarnation_started_at  timestamptz, NULL exactly while the incarnation is 1
--   last_reattached_at      timestamptz
--   devices_install_incarnation_chk pins the null rule
--     (install_incarnation = 1) = (incarnation_started_at IS NULL)
--   added NOT VALID here (no scan) and VALIDATEd by the @no-transaction
--   2027-01-02-120200, under SHARE UPDATE EXCLUSIVE, so agent writes to
--   `devices` continue during the scan.
--   devices_install_incarnation_guard: the incarnation only ever advances by
--   one, and incarnation_started_at moves only with it.
--
-- One hot table per transaction. This file locks `devices` and nothing else;
-- the `device_commands` half is 2027-01-02-120100. Holding `devices` while
-- queueing for `device_commands` would deadlock with any command insert in
-- flight, which holds `device_commands` and then needs `devices` for its FK.
--
-- Tenancy: the three columns are classified `included` in
-- CORE_TENANT_EXPORT_POLICY.
--
-- No row is written, so no system-scope election is needed. lock_timeout
-- bounds how long each ALTER may queue behind a long transaction on this hot
-- table; on timeout autoMigrate aborts boot and the file re-runs cleanly (it
-- is one transaction, and every statement is idempotent).

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS install_incarnation integer NOT NULL DEFAULT 1;
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS incarnation_started_at timestamptz;
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS last_reattached_at timestamptz;

-- Added only when absent, so a re-run never turns a validated constraint back
-- into a NOT VALID one.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.devices'::regclass
       AND conname = 'devices_install_incarnation_chk'
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_install_incarnation_chk CHECK (
        install_incarnation >= 1
        AND ((install_incarnation = 1) = (incarnation_started_at IS NULL))
      ) NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.breeze_devices_install_incarnation_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.install_incarnation IS DISTINCT FROM OLD.install_incarnation
     AND NEW.install_incarnation IS DISTINCT FROM OLD.install_incarnation + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = format(
        'devices.install_incarnation only advances by one (%s -> %s)',
        OLD.install_incarnation, NEW.install_incarnation);
  END IF;
  IF NEW.incarnation_started_at IS DISTINCT FROM OLD.incarnation_started_at
     AND NEW.install_incarnation IS NOT DISTINCT FROM OLD.install_incarnation THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'devices.incarnation_started_at changes only when the incarnation advances';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS devices_install_incarnation_guard ON public.devices;
CREATE TRIGGER devices_install_incarnation_guard
  BEFORE UPDATE OF install_incarnation, incarnation_started_at ON public.devices
  FOR EACH ROW EXECUTE FUNCTION public.breeze_devices_install_incarnation_guard();
