-- Durable browser-auth transition authority.
--
-- These rows correlate security state across browser tabs and accounts, so
-- they are system infrastructure rather than tenant-readable data. Both new
-- tables use forced RLS with an explicit system-scope-only policy.

CREATE TABLE IF NOT EXISTS auth_browser_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_digest varchar(64) NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
  state varchar(24) NOT NULL DEFAULT 'active',
  active_operation_id uuid,
  active_operation_expires_at timestamptz,
  current_user_id uuid,
  current_family_id uuid,
  logout_id uuid,
  completion_nonce_digest varchar(64),
  logout_expires_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Rollout columns stay nullable until every live family/session has been
-- dual-written for at least the maximum refresh-family lifetime.
ALTER TABLE refresh_token_families
  ADD COLUMN IF NOT EXISTS current_refresh_jti_digest varchar(64);

ALTER TABLE sso_sessions
  ADD COLUMN IF NOT EXISTS browser_transition_id uuid;

ALTER TABLE sso_sessions
  ADD COLUMN IF NOT EXISTS browser_generation bigint;

CREATE TABLE IF NOT EXISTS sso_token_exchange_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_digest varchar(64) NOT NULL,
  browser_transition_id uuid NOT NULL,
  browser_generation bigint NOT NULL,
  user_id uuid NOT NULL,
  family_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Family/user composite keys prevent ownership mix-and-match. Transition
-- generation is intentionally a child snapshot, not part of the FK: advancing
-- the parent generation must leave admitted SSO rows stale rather than either
-- blocking the advance or cascading authority into them.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'refresh_token_families_family_user_unique'
      AND conrelid = 'refresh_token_families'::regclass
  ) THEN
    ALTER TABLE refresh_token_families
      ADD CONSTRAINT refresh_token_families_family_user_unique
      UNIQUE (family_id, user_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auth_browser_transitions_binding_digest_unique'
      AND conrelid = 'auth_browser_transitions'::regclass
  ) THEN
    ALTER TABLE auth_browser_transitions
      ADD CONSTRAINT auth_browser_transitions_binding_digest_unique
      UNIQUE (binding_digest);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auth_browser_transitions_generation_chk'
      AND conrelid = 'auth_browser_transitions'::regclass
  ) THEN
    ALTER TABLE auth_browser_transitions
      ADD CONSTRAINT auth_browser_transitions_generation_chk
      CHECK (generation >= 1);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auth_browser_transitions_digest_chk'
      AND conrelid = 'auth_browser_transitions'::regclass
  ) THEN
    ALTER TABLE auth_browser_transitions
      ADD CONSTRAINT auth_browser_transitions_digest_chk
      CHECK (
        binding_digest ~ '^[0-9a-f]{64}$'
        AND (
          completion_nonce_digest IS NULL
          OR completion_nonce_digest ~ '^[0-9a-f]{64}$'
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auth_browser_transitions_operation_pair_chk'
      AND conrelid = 'auth_browser_transitions'::regclass
  ) THEN
    ALTER TABLE auth_browser_transitions
      ADD CONSTRAINT auth_browser_transitions_operation_pair_chk
      CHECK (
        (active_operation_id IS NULL) =
        (active_operation_expires_at IS NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auth_browser_transitions_current_family_pair_chk'
      AND conrelid = 'auth_browser_transitions'::regclass
  ) THEN
    ALTER TABLE auth_browser_transitions
      ADD CONSTRAINT auth_browser_transitions_current_family_pair_chk
      CHECK ((current_user_id IS NULL) = (current_family_id IS NULL));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auth_browser_transitions_state_chk'
      AND conrelid = 'auth_browser_transitions'::regclass
  ) THEN
    ALTER TABLE auth_browser_transitions
      ADD CONSTRAINT auth_browser_transitions_state_chk
      CHECK (
        (
          state = 'active'
          AND logout_id IS NULL
          AND completion_nonce_digest IS NULL
          AND logout_expires_at IS NULL
          AND retired_at IS NULL
        )
        OR (
          state = 'logout_pending'
          AND logout_id IS NOT NULL
          AND completion_nonce_digest IS NOT NULL
          AND logout_expires_at IS NOT NULL
          AND logout_expires_at > updated_at
          AND retired_at IS NULL
        )
        OR (
          state = 'retired'
          AND retired_at IS NOT NULL
          AND active_operation_id IS NULL
          AND active_operation_expires_at IS NULL
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auth_browser_transitions_current_family_owner_fk'
      AND conrelid = 'auth_browser_transitions'::regclass
  ) THEN
    ALTER TABLE auth_browser_transitions
      ADD CONSTRAINT auth_browser_transitions_current_family_owner_fk
      FOREIGN KEY (current_family_id, current_user_id)
      REFERENCES refresh_token_families (family_id, user_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sso_sessions_browser_transition_pair_chk'
      AND conrelid = 'sso_sessions'::regclass
  ) THEN
    ALTER TABLE sso_sessions
      ADD CONSTRAINT sso_sessions_browser_transition_pair_chk
      CHECK ((browser_transition_id IS NULL) = (browser_generation IS NULL));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sso_sessions_browser_generation_chk'
      AND conrelid = 'sso_sessions'::regclass
  ) THEN
    ALTER TABLE sso_sessions
      ADD CONSTRAINT sso_sessions_browser_generation_chk
      CHECK (browser_generation IS NULL OR browser_generation >= 1);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sso_sessions_browser_transition_fk'
      AND conrelid = 'sso_sessions'::regclass
  ) THEN
    ALTER TABLE sso_sessions
      ADD CONSTRAINT sso_sessions_browser_transition_fk
      FOREIGN KEY (browser_transition_id)
      REFERENCES auth_browser_transitions (id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sso_token_exchange_grants_transition_fk'
      AND conrelid = 'sso_token_exchange_grants'::regclass
  ) THEN
    ALTER TABLE sso_token_exchange_grants
      ADD CONSTRAINT sso_token_exchange_grants_transition_fk
      FOREIGN KEY (browser_transition_id)
      REFERENCES auth_browser_transitions (id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sso_token_exchange_grants_family_owner_fk'
      AND conrelid = 'sso_token_exchange_grants'::regclass
  ) THEN
    ALTER TABLE sso_token_exchange_grants
      ADD CONSTRAINT sso_token_exchange_grants_family_owner_fk
      FOREIGN KEY (family_id, user_id)
      REFERENCES refresh_token_families (family_id, user_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sso_token_exchange_grants_code_digest_unique'
      AND conrelid = 'sso_token_exchange_grants'::regclass
  ) THEN
    ALTER TABLE sso_token_exchange_grants
      ADD CONSTRAINT sso_token_exchange_grants_code_digest_unique
      UNIQUE (code_digest);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sso_token_exchange_grants_lifecycle_chk'
      AND conrelid = 'sso_token_exchange_grants'::regclass
  ) THEN
    ALTER TABLE sso_token_exchange_grants
      ADD CONSTRAINT sso_token_exchange_grants_lifecycle_chk
      CHECK (
        code_digest ~ '^[0-9a-f]{64}$'
        AND browser_generation >= 1
        AND expires_at > created_at
        AND (consumed_at IS NULL OR consumed_at >= created_at)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS auth_browser_transitions_logout_expires_idx
  ON auth_browser_transitions (logout_expires_at);

CREATE INDEX IF NOT EXISTS auth_browser_transitions_current_family_idx
  ON auth_browser_transitions (current_family_id);

CREATE INDEX IF NOT EXISTS sso_token_exchange_grants_expires_idx
  ON sso_token_exchange_grants (expires_at);

CREATE INDEX IF NOT EXISTS sso_token_exchange_grants_transition_idx
  ON sso_token_exchange_grants (browser_transition_id, browser_generation);

ALTER TABLE auth_browser_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_browser_transitions FORCE ROW LEVEL SECURITY;
ALTER TABLE sso_token_exchange_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE sso_token_exchange_grants FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'auth_browser_transitions'
      AND policyname = 'auth_browser_transitions_system_only'
  ) THEN
    CREATE POLICY auth_browser_transitions_system_only
      ON auth_browser_transitions
      FOR ALL TO breeze_app
      USING (current_setting('breeze.scope', true) = 'system')
      WITH CHECK (current_setting('breeze.scope', true) = 'system');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'sso_token_exchange_grants'
      AND policyname = 'sso_token_exchange_grants_system_only'
  ) THEN
    CREATE POLICY sso_token_exchange_grants_system_only
      ON sso_token_exchange_grants
      FOR ALL TO breeze_app
      USING (current_setting('breeze.scope', true) = 'system')
      WITH CHECK (current_setting('breeze.scope', true) = 'system');
  END IF;
END $$;
