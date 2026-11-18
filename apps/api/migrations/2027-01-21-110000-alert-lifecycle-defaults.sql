-- Alert re-arm lifecycle W2 (feature #10765, wave #10767; spec
-- docs/superpowers/specs/monitoring/2026-10-29-alert-rearm-lifecycle-design.md §6.2, §8).
--
-- Lifecycle settings resolve partner default -> org override -> monitor
-- override (resolver: @breeze/shared resolveAlertLifecycle via
-- apps/api/src/services/alertLifecycle/resolve.ts).
--
--   partners       alert_auto_resolve / alert_rearm_mode / alert_rearm_delay_minutes /
--                  alert_cooldown_minutes. NOT NULL defaults equal to the old monitor
--                  defaults (false / new_evidence / NULL / 5), so behaviour is unchanged
--                  at migration time.
--   organizations  the same four columns, all nullable: NULL = inherit the partner.
--   monitor_definitions
--                  cooldown_minutes / auto_resolve lose NOT NULL and DEFAULT (NULL =
--                  inherit, the default for new monitors, ND4); new nullable
--                  rearm_mode / rearm_delay_minutes.
--
-- Re-arm pair rule on every level: rearm_delay_minutes is set (1-1440) iff the mode is
-- 'after_delay'. Cooldown is 0-1440 minutes.
--
-- Backfill (OD9): monitors still holding the old column defaults (cooldown 5,
-- auto_resolve false) are set to NULL so they follow the partner/org default.
-- Effective behaviour is identical at migration time because the partner defaults
-- equal the old column defaults.
--
-- Tenancy: no new table. organizations / monitor_definitions are export-classified in
-- tenantExportPolicyRegistry.ts (all new columns `included`); partners is not in the
-- tenant export registry. No cascade / org-merge change (OD7: the surviving org keeps
-- its own columns). monitor_definitions carries no partner-export triggers.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, pg_constraint-guarded CHECKs, re-runnable
-- DROP NOT NULL / DROP DEFAULT, and a backfill whose second run matches nothing new.
-- No inner BEGIN/COMMIT (autoMigrate wraps the file in a transaction).

-- The backfill below writes rows; under FORCE RLS an unscoped UPDATE matches zero rows.
SELECT set_config('breeze.scope', 'system', true);

-- ============================================
-- 1. partners: the partner default (non-null).
-- ============================================
ALTER TABLE partners ADD COLUMN IF NOT EXISTS alert_auto_resolve boolean NOT NULL DEFAULT false;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS alert_rearm_mode text NOT NULL DEFAULT 'new_evidence';
ALTER TABLE partners ADD COLUMN IF NOT EXISTS alert_rearm_delay_minutes integer;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS alert_cooldown_minutes integer NOT NULL DEFAULT 5;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partners_alert_rearm_mode_chk' AND conrelid = 'public.partners'::regclass
  ) THEN
    ALTER TABLE partners ADD CONSTRAINT partners_alert_rearm_mode_chk
      CHECK (alert_rearm_mode IN ('new_evidence', 'after_delay'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partners_alert_rearm_delay_chk' AND conrelid = 'public.partners'::regclass
  ) THEN
    ALTER TABLE partners ADD CONSTRAINT partners_alert_rearm_delay_chk
      CHECK (
        (alert_rearm_mode = 'after_delay') = (alert_rearm_delay_minutes IS NOT NULL)
        AND (alert_rearm_delay_minutes IS NULL OR alert_rearm_delay_minutes BETWEEN 1 AND 1440)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partners_alert_cooldown_chk' AND conrelid = 'public.partners'::regclass
  ) THEN
    ALTER TABLE partners ADD CONSTRAINT partners_alert_cooldown_chk
      CHECK (alert_cooldown_minutes BETWEEN 0 AND 1440);
  END IF;
END $$;

-- ============================================
-- 2. organizations: the org override (NULL = inherit the partner).
-- ============================================
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS alert_auto_resolve boolean;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS alert_rearm_mode text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS alert_rearm_delay_minutes integer;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS alert_cooldown_minutes integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organizations_alert_rearm_mode_chk' AND conrelid = 'public.organizations'::regclass
  ) THEN
    ALTER TABLE organizations ADD CONSTRAINT organizations_alert_rearm_mode_chk
      CHECK (alert_rearm_mode IS NULL OR alert_rearm_mode IN ('new_evidence', 'after_delay'));
  END IF;

  -- NULL mode = inherit, which carries no delay: the delay is part of the mode's pair.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organizations_alert_rearm_delay_chk' AND conrelid = 'public.organizations'::regclass
  ) THEN
    ALTER TABLE organizations ADD CONSTRAINT organizations_alert_rearm_delay_chk
      CHECK (
        (alert_rearm_mode IS NOT DISTINCT FROM 'after_delay') = (alert_rearm_delay_minutes IS NOT NULL)
        AND (alert_rearm_delay_minutes IS NULL OR alert_rearm_delay_minutes BETWEEN 1 AND 1440)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organizations_alert_cooldown_chk' AND conrelid = 'public.organizations'::regclass
  ) THEN
    ALTER TABLE organizations ADD CONSTRAINT organizations_alert_cooldown_chk
      CHECK (alert_cooldown_minutes IS NULL OR alert_cooldown_minutes BETWEEN 0 AND 1440);
  END IF;
END $$;

-- ============================================
-- 3. monitor_definitions: the monitor override (NULL = inherit the device's org).
-- ============================================
ALTER TABLE monitor_definitions ALTER COLUMN cooldown_minutes DROP NOT NULL;
ALTER TABLE monitor_definitions ALTER COLUMN cooldown_minutes DROP DEFAULT;
ALTER TABLE monitor_definitions ALTER COLUMN auto_resolve DROP NOT NULL;
ALTER TABLE monitor_definitions ALTER COLUMN auto_resolve DROP DEFAULT;
ALTER TABLE monitor_definitions ADD COLUMN IF NOT EXISTS rearm_mode text;
ALTER TABLE monitor_definitions ADD COLUMN IF NOT EXISTS rearm_delay_minutes integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'monitor_definitions_rearm_mode_chk' AND conrelid = 'public.monitor_definitions'::regclass
  ) THEN
    ALTER TABLE monitor_definitions ADD CONSTRAINT monitor_definitions_rearm_mode_chk
      CHECK (rearm_mode IS NULL OR rearm_mode IN ('new_evidence', 'after_delay'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'monitor_definitions_rearm_delay_chk' AND conrelid = 'public.monitor_definitions'::regclass
  ) THEN
    ALTER TABLE monitor_definitions ADD CONSTRAINT monitor_definitions_rearm_delay_chk
      CHECK (
        (rearm_mode IS NOT DISTINCT FROM 'after_delay') = (rearm_delay_minutes IS NOT NULL)
        AND (rearm_delay_minutes IS NULL OR rearm_delay_minutes BETWEEN 1 AND 1440)
      );
  END IF;
END $$;

-- ============================================
-- 4. Backfill (OD9): the old column defaults become "inherit". Row counts are logged.
-- ============================================
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE monitor_definitions SET cooldown_minutes = NULL WHERE cooldown_minutes = 5;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'alert lifecycle: % monitor_definitions cooldown_minutes 5 -> NULL (inherit)', n;
  END IF;

  UPDATE monitor_definitions SET auto_resolve = NULL WHERE auto_resolve = false;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'alert lifecycle: % monitor_definitions auto_resolve false -> NULL (inherit)', n;
  END IF;
END $$;
