-- 2026-05-07-c-mobile-device-and-oauth-lifecycle.sql
-- Device + OAuth client lifecycle management. Adds:
--   1. Block columns on `mobile_devices` (status, blocked_at, blocked_by_user_id, blocked_reason)
--   2. Revocation columns on `oauth_grants` (revoked_at, revoked_by_user_id, revoked_reason)
--   3. New `oauth_client_blocks` table for org-wide OAuth client blocking (Shape 1, org-tenant)
--
-- Idempotent: safe to re-apply on an already-migrated database.

-- ============================================================
-- 1. mobile_devices: block columns
-- ============================================================
DO $$ BEGIN
  CREATE TYPE mobile_device_status AS ENUM ('active', 'blocked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE mobile_devices
  ADD COLUMN IF NOT EXISTS status mobile_device_status NOT NULL DEFAULT 'active';
ALTER TABLE mobile_devices
  ADD COLUMN IF NOT EXISTS blocked_at timestamptz;
ALTER TABLE mobile_devices
  ADD COLUMN IF NOT EXISTS blocked_by_user_id uuid;
ALTER TABLE mobile_devices
  ADD COLUMN IF NOT EXISTS blocked_reason text;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mobile_devices_blocked_by_user_id_fkey'
  ) THEN
    ALTER TABLE mobile_devices
      ADD CONSTRAINT mobile_devices_blocked_by_user_id_fkey
      FOREIGN KEY (blocked_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS mobile_devices_user_status_idx
  ON mobile_devices (user_id, status);

-- ============================================================
-- 2. oauth_grants: revocation columns
-- ============================================================
ALTER TABLE oauth_grants
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE oauth_grants
  ADD COLUMN IF NOT EXISTS revoked_by_user_id uuid;
ALTER TABLE oauth_grants
  ADD COLUMN IF NOT EXISTS revoked_reason text;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'oauth_grants_revoked_by_user_id_fkey'
  ) THEN
    ALTER TABLE oauth_grants
      ADD CONSTRAINT oauth_grants_revoked_by_user_id_fkey
      FOREIGN KEY (revoked_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS oauth_grants_account_client_active_idx
  ON oauth_grants (account_id, client_id)
  WHERE revoked_at IS NULL;

-- ============================================================
-- 3. oauth_client_blocks (Shape 1 — org-tenant)
-- ============================================================
-- Org-wide block of a specific OAuth client. Token validation consults
-- this table; if a row exists for (orgId, clientId) and blocked_until is
-- NULL or in the future, all of that org's users are denied OAuth access
-- to that client (e.g. "no Cursor over MCP for the next 30 days").

CREATE TABLE IF NOT EXISTS oauth_client_blocks (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id          text        NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  blocked_at         timestamptz NOT NULL DEFAULT now(),
  blocked_by_user_id uuid        REFERENCES users(id) ON DELETE SET NULL,
  blocked_reason     text,
  blocked_until      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS oauth_client_blocks_org_client_uniq
  ON oauth_client_blocks (org_id, client_id);

CREATE INDEX IF NOT EXISTS oauth_client_blocks_client_idx
  ON oauth_client_blocks (client_id);

ALTER TABLE oauth_client_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_client_blocks FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'oauth_client_blocks'
      AND policyname = 'oauth_client_blocks_org_isolation_select'
  ) THEN
    CREATE POLICY oauth_client_blocks_org_isolation_select ON oauth_client_blocks
      FOR SELECT USING (public.breeze_has_org_access(org_id));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'oauth_client_blocks'
      AND policyname = 'oauth_client_blocks_org_isolation_insert'
  ) THEN
    CREATE POLICY oauth_client_blocks_org_isolation_insert ON oauth_client_blocks
      FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'oauth_client_blocks'
      AND policyname = 'oauth_client_blocks_org_isolation_update'
  ) THEN
    CREATE POLICY oauth_client_blocks_org_isolation_update ON oauth_client_blocks
      FOR UPDATE USING (public.breeze_has_org_access(org_id))
      WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'oauth_client_blocks'
      AND policyname = 'oauth_client_blocks_org_isolation_delete'
  ) THEN
    CREATE POLICY oauth_client_blocks_org_isolation_delete ON oauth_client_blocks
      FOR DELETE USING (public.breeze_has_org_access(org_id));
  END IF;
END $$;
