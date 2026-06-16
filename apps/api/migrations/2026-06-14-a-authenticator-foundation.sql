-- Breeze Authenticator — Phase 1 foundation.
-- Idempotent: enums via duplicate_object guard, tables/columns IF NOT EXISTS,
-- policies via pg_policies existence checks, FKs via pg_constraint checks.

-- 1. Enums -------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE authenticator_kind AS ENUM ('mobile_hw_key', 'webauthn_platform');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE approval_factor AS ENUM ('session_tap', 'mobile_hw_key', 'webauthn_platform');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. authenticator_devices (Shape 6 — user-id scoped) ------------------------
CREATE TABLE IF NOT EXISTS authenticator_devices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              authenticator_kind NOT NULL,
  label             varchar(255),
  public_key        text NOT NULL,
  credential_id     text UNIQUE,
  sign_count        integer NOT NULL DEFAULT 0,
  aaguid            varchar(36),
  transports        jsonb,
  is_platform_bound boolean NOT NULL,
  mobile_device_id  uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_used_at      timestamptz,
  disabled_at       timestamptz,
  disabled_reason   text
);

CREATE INDEX IF NOT EXISTS authenticator_devices_user_id_idx
  ON authenticator_devices(user_id);

-- mobile_device_id FK (nullable, SET NULL on device unpair).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'authenticator_devices_mobile_device_id_fkey'
  ) THEN
    ALTER TABLE authenticator_devices
      ADD CONSTRAINT authenticator_devices_mobile_device_id_fkey
      FOREIGN KEY (mobile_device_id) REFERENCES mobile_devices(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE authenticator_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE authenticator_devices FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'authenticator_devices'
      AND policyname = 'authenticator_devices_user_scope'
  ) THEN
    CREATE POLICY authenticator_devices_user_scope ON authenticator_devices
      FOR ALL
      TO breeze_app
      USING     (user_id = breeze_current_user_id() OR breeze_current_scope() = 'system')
      WITH CHECK (user_id = breeze_current_user_id() OR breeze_current_scope() = 'system');
  END IF;
END $$;

-- 3. authenticator_policies (Shape 3 — partner-axis) -------------------------
CREATE TABLE IF NOT EXISTS authenticator_policies (
  partner_id          uuid PRIMARY KEY REFERENCES partners(id) ON DELETE CASCADE,
  floor_overrides     jsonb NOT NULL DEFAULT '{}'::jsonb,
  require_enrollment  boolean NOT NULL DEFAULT false,
  enforce_from        timestamptz,
  updated_by_user_id  uuid REFERENCES users(id),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE authenticator_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE authenticator_policies FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'authenticator_policies'
      AND policyname = 'authenticator_policies_partner_access'
  ) THEN
    CREATE POLICY authenticator_policies_partner_access ON authenticator_policies
      FOR ALL
      TO breeze_app
      USING     (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;

-- 4. Approver PIN columns on users ------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS approver_pin_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS approver_pin_set_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS approver_pin_failed_count integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS approver_pin_locked_until timestamptz;

-- 5. Factor-recording columns on approval_requests + elevation_requests ------
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS decided_assurance_level smallint;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS decided_via approval_factor;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS authenticator_device_id uuid;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS pin_verified boolean NOT NULL DEFAULT false;

ALTER TABLE elevation_requests ADD COLUMN IF NOT EXISTS decided_assurance_level smallint;
ALTER TABLE elevation_requests ADD COLUMN IF NOT EXISTS decided_via approval_factor;
ALTER TABLE elevation_requests ADD COLUMN IF NOT EXISTS authenticator_device_id uuid;
ALTER TABLE elevation_requests ADD COLUMN IF NOT EXISTS pin_verified boolean NOT NULL DEFAULT false;

-- authenticator_device_id FKs (SET NULL so a revoked device leaves audit rows).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approval_requests_authenticator_device_id_fkey') THEN
    ALTER TABLE approval_requests
      ADD CONSTRAINT approval_requests_authenticator_device_id_fkey
      FOREIGN KEY (authenticator_device_id) REFERENCES authenticator_devices(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'elevation_requests_authenticator_device_id_fkey') THEN
    ALTER TABLE elevation_requests
      ADD CONSTRAINT elevation_requests_authenticator_device_id_fkey
      FOREIGN KEY (authenticator_device_id) REFERENCES authenticator_devices(id) ON DELETE SET NULL;
  END IF;
END $$;
