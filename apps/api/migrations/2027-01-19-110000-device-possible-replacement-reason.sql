-- #8318 wave 2-1 — hardware hints, part 1 of 4: `devices` only
-- (docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
-- §4.1, §7.3).
--
--   possible_replacement_reason       text, 'hostname' | 'hardware' | 'tpm'
--   possible_replacement_detected_at  timestamptz
--     Why and when the source row was flagged as a probable reinstall of
--     possible_replacement_of_device_id. Written only on the SOURCE row: by
--     the #2764 hostname-collision path at enroll ('hostname') and by
--     services/reinstallCandidates ('hardware' from the SMBIOS UUID or the
--     serial + manufacturer, 'hostname' from a partner-wide hostname match).
--     'tpm' is reserved for wave T2; nothing writes it yet.
--
-- The invariant: the reason and the timestamp are NULL exactly when the link
-- is NULL (devices_possible_replacement_reason_chk).
--
-- Backfill. Before this file only the #2764 path set the link, always at the
-- source's INSERT, so every existing linked row is a hostname match detected
-- when the row was created: reason 'hostname', detected_at = created_at (a
-- truer time than now(); now() only if created_at were ever NULL). Rows are
-- backfilled BEFORE the CHECK is added, in this transaction, so the CHECK can
-- hold for every row.
--
-- The link is `ON DELETE SET NULL`. That referential action is an UPDATE of
-- the link alone and would leave a reason behind, violating the CHECK and
-- failing the target's hard delete. devices_possible_replacement_reason_sync
-- (BEFORE INSERT, and BEFORE UPDATE OF possible_replacement_of_device_id)
-- keeps the row consistent in both directions:
--   * the link becomes NULL → the reason and the timestamp are cleared, so
--     the FK action and any writer that clears only the link stay valid;
--   * a link is written with no reason → 'hostname' and now(). Before this
--     wave the #2764 path was the only writer of the link, and it writes
--     none of the new columns. During a rolling deploy an API binary from
--     before this wave still runs that INSERT against the migrated schema;
--     without this default the CHECK would refuse it and fail the enroll.
--     A writer that sets a reason keeps it (the default never overrides).
-- The UPDATE arm fires only when the link is in the SET list, so heartbeat
-- updates never run it.
--
-- Tenancy: devices is an org-cascade table; both columns are classified
-- `included` in CORE_TENANT_EXPORT_POLICY. No RLS change.
--
-- The CHECK is added NOT VALID (no scan under ACCESS EXCLUSIVE) and VALIDATEd
-- by the @no-transaction 2027-01-19-110200, under SHARE UPDATE EXCLUSIVE.
-- One hot table per transaction: this file locks `devices` only; the
-- device_hardware column is 2027-01-19-110100.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, the backfill matches only rows with a
-- link and no reason, the CHECKs are added only when absent, the trigger is
-- dropped and re-created. lock_timeout bounds the ALTERs' wait on this hot
-- table; on timeout autoMigrate aborts boot and the file re-runs cleanly.

SET LOCAL lock_timeout = '5s';

SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS possible_replacement_reason text;
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS possible_replacement_detected_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.devices'::regclass
       AND conname = 'devices_possible_replacement_reason_values_chk'
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_possible_replacement_reason_values_chk CHECK (
        possible_replacement_reason IS NULL
        OR possible_replacement_reason IN ('hostname', 'hardware', 'tpm')
      ) NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.breeze_devices_possible_replacement_reason_sync()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.possible_replacement_of_device_id IS NULL THEN
    NEW.possible_replacement_reason := NULL;
    NEW.possible_replacement_detected_at := NULL;
  ELSIF NEW.possible_replacement_reason IS NULL THEN
    -- A writer from before this wave (the #2764 hostname path): see header.
    NEW.possible_replacement_reason := 'hostname';
    NEW.possible_replacement_detected_at := COALESCE(NEW.possible_replacement_detected_at, now());
  ELSIF NEW.possible_replacement_detected_at IS NULL THEN
    NEW.possible_replacement_detected_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS devices_possible_replacement_clear ON public.devices;
DROP TRIGGER IF EXISTS devices_possible_replacement_reason_sync ON public.devices;
DROP FUNCTION IF EXISTS public.breeze_devices_possible_replacement_clear();
CREATE TRIGGER devices_possible_replacement_reason_sync
  BEFORE INSERT OR UPDATE OF possible_replacement_of_device_id ON public.devices
  FOR EACH ROW EXECUTE FUNCTION public.breeze_devices_possible_replacement_reason_sync();

DO $$
DECLARE
  n integer;
  lock_orgs uuid[];
  lock_partners uuid[];
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  -- Partner-export pre-locks (migrations/README.md; enforced by
  -- migrationPartnerExportLocks.test.ts, #5360; configuration family #5912).
  -- `devices` carries both device-material and configuration-material
  -- statement triggers, so take the stricter configuration family: every
  -- partner the UPDATE touches exclusive, then those orgs, each set sorted,
  -- before the first write. Empty arrays (nothing to backfill) are a no-op.
  SELECT
    COALESCE(array_agg(DISTINCT o.id ORDER BY o.id), ARRAY[]::uuid[]),
    COALESCE(array_agg(DISTINCT o.partner_id ORDER BY o.partner_id)
               FILTER (WHERE o.partner_id IS NOT NULL), ARRAY[]::uuid[])
    INTO lock_orgs, lock_partners
    FROM public.devices d
    JOIN public.organizations o ON o.id = d.org_id
   WHERE d.possible_replacement_of_device_id IS NOT NULL
     AND d.possible_replacement_reason IS NULL;
  PERFORM public.breeze_partner_export_lock_partners_exclusive(lock_partners);
  PERFORM public.breeze_partner_export_lock_orgs_under_exclusive_partners(lock_orgs, lock_partners);

  UPDATE public.devices
     SET possible_replacement_reason = 'hostname',
         possible_replacement_detected_at = COALESCE(created_at, now())
   WHERE possible_replacement_of_device_id IS NOT NULL
     AND possible_replacement_reason IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING '#8318: backfilled possible_replacement_reason=hostname on % #2764-linked device(s)', n;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.devices'::regclass
       AND conname = 'devices_possible_replacement_reason_chk'
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_possible_replacement_reason_chk CHECK (
        (possible_replacement_of_device_id IS NULL) = (possible_replacement_reason IS NULL)
        AND (possible_replacement_of_device_id IS NULL) = (possible_replacement_detected_at IS NULL)
      ) NOT VALID;
  END IF;
END $$;
