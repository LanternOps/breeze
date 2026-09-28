-- Drop the legacy notification_channels.config column (#7028, contract step of #6379).
--
-- 2026-11-02-100600-notification-channel-configs.sql (the EXPAND step, #6993,
-- shipped in v0.118.0) moved channel config into notification_channel_configs,
-- whose RLS is parent OWNERSHIP. It kept notification_channels.config for one
-- release as a write-only mirror (plus a sync trigger) so an image rollback
-- keeps delivering. While that column exists an ORG session can still read the
-- config of its MSP's partner-wide channel rows through the parent's SELECT-only
-- partner-wide branch — RLS cannot hide a column. Dropping it completes the
-- DB-layer confidentiality fix for #6379.
--
-- ROLLBACK: an image older than the one carrying this migration still writes
-- the legacy column when a channel is created/edited, and would fail with 42703
-- after this runs. Roll back no further than the release carrying the expand
-- step (v0.118.x reads config only from notification_channel_configs, but its
-- write path still mirrors into this column — so a rollback to v0.118.x can
-- still DELIVER, but channel create/edit fails until rolled forward).
--
-- ORDER
--   1. Elect system scope: both tables are FORCE RLS, which binds the owner the
--      migration runs as. Without it the backfill silently copies zero rows.
--   2. Belt-and-braces backfill: a channel written by an OLD image in the window
--      between the expand step's backfill and its CREATE TRIGGER has a legacy
--      value but no child row. ON CONFLICT DO NOTHING: the child row is the
--      authoritative copy wherever it exists (the new image writes it first,
--      the sync trigger keeps it current for old-image writes).
--   3. Drop the sync trigger + function (they reference the column).
--   4. Drop the column.
--
-- IDEMPOTENT: the backfill runs only while the column still exists (dynamic SQL
-- — a static reference to a dropped column would fail at parse time on replay);
-- every DROP is IF EXISTS. No inner BEGIN/COMMIT — autoMigrate wraps each file.

SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'notification_channels'
      AND column_name = 'config'
  ) THEN
    EXECUTE $sql$
      INSERT INTO public.notification_channel_configs (channel_id, config)
      SELECT id, config FROM public.notification_channels
      WHERE config IS NOT NULL
      ON CONFLICT (channel_id) DO NOTHING
    $sql$;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE WARNING 'notification_channel_configs: backfilled % channel config row(s) missing before dropping notification_channels.config', n;
    ELSE
      RAISE NOTICE 'notification_channel_configs: backfilled 0 channel config row(s) before dropping notification_channels.config';
    END IF;
  END IF;
END $$;

DROP TRIGGER IF EXISTS notification_channels_sync_legacy_config ON public.notification_channels;
DROP FUNCTION IF EXISTS public.notification_channels_sync_legacy_config();

ALTER TABLE public.notification_channels DROP COLUMN IF EXISTS config;
