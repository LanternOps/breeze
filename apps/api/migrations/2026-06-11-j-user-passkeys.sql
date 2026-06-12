-- Passkey MFA credentials for WebAuthn.
--
-- Idempotent: safe to re-apply on databases that already have the enum value,
-- table, indexes, or policy.

DO $$ BEGIN
  ALTER TYPE mfa_method ADD VALUE 'passkey';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS user_passkeys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key    text NOT NULL,
  counter       bigint NOT NULL DEFAULT 0,
  device_type   varchar(32) NOT NULL,
  backed_up     boolean NOT NULL DEFAULT false,
  transports    jsonb,
  name          varchar(255),
  aaguid        varchar(36),
  last_used_at  timestamptz,
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_passkeys_user_id_idx
  ON user_passkeys(user_id);

ALTER TABLE user_passkeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_passkeys FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'user_passkeys'
      AND policyname = 'user_passkeys_user_scope'
  ) THEN
    CREATE POLICY user_passkeys_user_scope ON user_passkeys
      FOR ALL
      TO breeze_app
      USING     (user_id = breeze_current_user_id() OR breeze_current_scope() = 'system')
      WITH CHECK (user_id = breeze_current_user_id() OR breeze_current_scope() = 'system');
  END IF;
END $$;
