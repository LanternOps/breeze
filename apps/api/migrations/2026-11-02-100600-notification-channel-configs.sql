-- Notification channel config moves to an ownership-gated child table (#6379).
--
-- PROBLEM
-- notification_channels is dual-axis (org_id XOR partner_id) and carries the
-- additive SELECT-only partner-wide branch
-- (2026-10-10-120000-notification-maintenance-partner-wide-select.sql), so an
-- ORG-scoped session can read its MSP's partner-wide channel rows. RLS is
-- row-level: that read returned the WHOLE row, including `config` (webhook
-- URLs, bot tokens, routing keys — for slack/teams/webhook the URL itself is
-- the credential). Confidentiality of a partner channel's config toward org
-- users rested on application projection/redaction alone. A column grant or a
-- view would not hold either: ensureAppRole re-grants full-table SELECT to
-- breeze_app on every boot.
--
-- FIX
-- `config` moves into notification_channel_configs (channel_id PK -> parent,
-- ON DELETE CASCADE). Its policy is parent OWNERSHIP, never parent visibility:
-- system, OR the parent's org_id is an org the session can access, OR the
-- parent's partner_id is a partner the session can access
-- (breeze_has_partner_access — which an org token never passes). An org
-- session can still SEE a partner-wide channel row (name/type/enabled, via the
-- parent's SELECT branch), but the config row behind it is invisible and
-- unwritable. The partner-wide SELECT branch is deliberately NOT mirrored here.
--
-- The EXISTS subquery reads notification_channels under the caller's own RLS.
-- That can only narrow the result (a parent the caller cannot see fails the
-- EXISTS); the ownership predicate is what excludes a parent the caller CAN
-- see only through the partner-wide read branch.
--
-- ENCRYPTION
-- The backfill copies the jsonb value verbatim — ciphertext stays ciphertext.
-- AAD-bound values were sealed under the tag `notification_channels.config`;
-- that tag is kept as the logical identity of the column (encryptedColumnRegistry
-- `aadTag`, notificationChannelSecrets), so every existing value still decrypts.
--
-- EXPAND / CONTRACT (the legacy column is NOT dropped here)
-- This is the EXPAND step. notification_channels.config stays so an image
-- rollback to the previous release keeps delivering alerts:
--   * the new image READS config only from notification_channel_configs and
--     WRITES both (services/notificationChannelConfig.ts), so the legacy column
--     stays current for an old image;
--   * NOT NULL is dropped from the legacy column: the new image inserts the
--     channel row first and writes its config in the same transaction;
--   * a sync trigger mirrors any write of the legacy column into the child
--     table, so channels created or edited by an OLD image during a rollback
--     are delivered correctly once the new image is rolled forward again.
-- The DB-layer confidentiality fix is therefore only complete once the
-- CONTRACT step drops the column and this trigger (follow-up to #6379).
--
-- ORDER / REPLAY
-- System scope is elected before the backfill INSERT: the table is FORCE RLS,
-- which binds the owner the migration runs as. ON CONFLICT DO NOTHING makes a
-- replay a no-op for rows already copied; the trigger and NOT NULL changes are
-- idempotent.
--
-- No org_id column on the new table: it reaches its tenant through the parent
-- (PARENT_FK_JOIN_POLICY_TABLES in rls-coverage.integration.test.ts), is
-- removed by the parent's ON DELETE CASCADE during org erasure, and follows
-- the parent through an org merge (the parent is repointed; the child is keyed
-- by channel_id). It therefore needs no cascade / merge / export registration.
--
-- No inner BEGIN/COMMIT — autoMigrate wraps each file in a transaction.

CREATE TABLE IF NOT EXISTS public.notification_channel_configs (
  channel_id uuid PRIMARY KEY
    REFERENCES public.notification_channels(id) ON DELETE CASCADE,
  config jsonb NOT NULL
);

ALTER TABLE public.notification_channel_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_channel_configs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_channel_configs_isolation ON public.notification_channel_configs;
CREATE POLICY notification_channel_configs_isolation
  ON public.notification_channel_configs
  USING (
    EXISTS (
      SELECT 1 FROM public.notification_channels nc
      WHERE nc.id = notification_channel_configs.channel_id
        AND (
          public.breeze_current_scope() = 'system'
          OR (nc.org_id IS NOT NULL AND public.breeze_has_org_access(nc.org_id))
          OR (nc.partner_id IS NOT NULL AND public.breeze_has_partner_access(nc.partner_id))
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.notification_channels nc
      WHERE nc.id = notification_channel_configs.channel_id
        AND (
          public.breeze_current_scope() = 'system'
          OR (nc.org_id IS NOT NULL AND public.breeze_has_org_access(nc.org_id))
          OR (nc.partner_id IS NOT NULL AND public.breeze_has_partner_access(nc.partner_id))
        )
    )
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_channel_configs TO breeze_app;
  END IF;
END $$;

-- Backfill from the legacy column.
DO $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  INSERT INTO public.notification_channel_configs (channel_id, config)
  SELECT id, config FROM public.notification_channels
  WHERE config IS NOT NULL
  ON CONFLICT (channel_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'notification_channel_configs: backfilled % channel config row(s)', n;
END $$;

ALTER TABLE public.notification_channels ALTER COLUMN config DROP NOT NULL;

-- Rollback safety: mirror legacy-column writes (an old image only writes the
-- parent) into the child table. SECURITY INVOKER — the upsert runs under the
-- writer's own RLS, and a writer that can write the parent row owns it, which is
-- exactly what the child policy's WITH CHECK requires. Dropped by the contract
-- step together with the column.
CREATE OR REPLACE FUNCTION public.notification_channels_sync_legacy_config()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
BEGIN
  IF NEW.config IS NOT NULL THEN
    INSERT INTO public.notification_channel_configs (channel_id, config)
    VALUES (NEW.id, NEW.config)
    ON CONFLICT (channel_id) DO UPDATE SET config = EXCLUDED.config;
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS notification_channels_sync_legacy_config ON public.notification_channels;
CREATE TRIGGER notification_channels_sync_legacy_config
  AFTER INSERT OR UPDATE OF config ON public.notification_channels
  FOR EACH ROW EXECUTE FUNCTION public.notification_channels_sync_legacy_config();
