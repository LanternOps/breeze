-- Dedicated partner-owned machine principals for the versioned Partner API.
-- Human API keys remain unchanged and organization-scoped.

CREATE OR REPLACE FUNCTION public.breeze_valid_partner_service_principal_scopes(
  candidate_scopes text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT
    candidate_scopes IS NOT NULL
    AND cardinality(candidate_scopes) > 0
    AND cardinality(candidate_scopes) = (
      SELECT count(DISTINCT scope_value)
      FROM unnest(candidate_scopes) AS scope_value
    )
    AND candidate_scopes <@ ARRAY[
      'organizations:read',
      'sites:read',
      'devices:read',
      'inventory:read',
      'configuration:read',
      'scripts:read',
      'backup-configuration:read',
      'custom-fields:read'
    ]::text[];
$$;

CREATE TABLE IF NOT EXISTS partner_service_principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active'
    CONSTRAINT partner_service_principals_status_check
    CHECK (status IN ('active', 'disabled')),
  scopes text[] NOT NULL DEFAULT '{}'
    CONSTRAINT partner_service_principals_scopes_check
    CHECK (public.breeze_valid_partner_service_principal_scopes(scopes)),
  expires_at timestamptz,
  source_cidrs text[] NOT NULL DEFAULT '{}',
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_service_principals_id_partner_unique UNIQUE (id, partner_id),
  CONSTRAINT partner_service_principals_partner_name_unique UNIQUE (partner_id, name)
);

-- CREATE TABLE IF NOT EXISTS does not add constraints to a pre-existing table.
-- Keep re-application capable of converging a partially applied development DB.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partner_service_principals_partner_name_unique'
      AND conrelid = 'partner_service_principals'::regclass
  ) THEN
    ALTER TABLE partner_service_principals
      ADD CONSTRAINT partner_service_principals_partner_name_unique
      UNIQUE (partner_id, name);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS partner_service_principals_partner_idx
  ON partner_service_principals(partner_id);

CREATE TABLE IF NOT EXISTS partner_service_principal_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  partner_service_principal_id uuid NOT NULL
    CONSTRAINT partner_service_principal_keys_partner_service_principal_fk
    REFERENCES partner_service_principals(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_hash text NOT NULL,
  key_prefix text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CONSTRAINT partner_service_principal_keys_status_check
    CHECK (status IN ('active', 'revoked')),
  expires_at timestamptz,
  rate_limit integer NOT NULL DEFAULT 600
    CONSTRAINT partner_service_principal_keys_rate_limit_check
    CHECK (rate_limit BETWEEN 1 AND 10000),
  last_used_at timestamptz,
  revoked_at timestamptz,
  rotated_from_id uuid
    CONSTRAINT partner_service_principal_keys_rotated_from_fk
    REFERENCES partner_service_principal_keys(id) ON DELETE SET NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_service_principal_keys_key_hash_unique UNIQUE (key_hash),
  CONSTRAINT partner_service_principal_keys_id_partner_unique UNIQUE (id, partner_id),
  CONSTRAINT partner_service_principal_keys_principal_partner_fk
    FOREIGN KEY (partner_service_principal_id, partner_id)
    REFERENCES partner_service_principals(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT partner_service_principal_keys_rotated_from_partner_fk
    FOREIGN KEY (rotated_from_id, partner_id)
    REFERENCES partner_service_principal_keys(id, partner_id)
);

CREATE INDEX IF NOT EXISTS partner_service_principal_keys_partner_idx
  ON partner_service_principal_keys(partner_id);
CREATE INDEX IF NOT EXISTS partner_service_principal_keys_principal_idx
  ON partner_service_principal_keys(partner_service_principal_id);

ALTER TABLE partner_service_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_service_principals FORCE ROW LEVEL SECURITY;
ALTER TABLE partner_service_principal_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_service_principal_keys FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'partner_service_principals'
      AND policyname = 'partner_service_principals_partner_select'
  ) THEN
    CREATE POLICY partner_service_principals_partner_select ON partner_service_principals
      FOR SELECT USING (
        public.breeze_current_scope() = 'system'
        OR public.breeze_has_partner_access(partner_id)
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'partner_service_principals'
      AND policyname = 'partner_service_principals_partner_insert'
  ) THEN
    CREATE POLICY partner_service_principals_partner_insert ON partner_service_principals
      FOR INSERT WITH CHECK (
        public.breeze_current_scope() = 'system'
        OR public.breeze_has_partner_access(partner_id)
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'partner_service_principals'
      AND policyname = 'partner_service_principals_partner_update'
  ) THEN
    CREATE POLICY partner_service_principals_partner_update ON partner_service_principals
      FOR UPDATE USING (
        public.breeze_current_scope() = 'system'
        OR public.breeze_has_partner_access(partner_id)
      )
      WITH CHECK (
        public.breeze_current_scope() = 'system'
        OR public.breeze_has_partner_access(partner_id)
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'partner_service_principals'
      AND policyname = 'partner_service_principals_partner_delete'
  ) THEN
    CREATE POLICY partner_service_principals_partner_delete ON partner_service_principals
      FOR DELETE USING (
        public.breeze_current_scope() = 'system'
        OR public.breeze_has_partner_access(partner_id)
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'partner_service_principal_keys'
      AND policyname = 'partner_service_principal_keys_partner_select'
  ) THEN
    CREATE POLICY partner_service_principal_keys_partner_select ON partner_service_principal_keys
      FOR SELECT USING (
        public.breeze_current_scope() = 'system'
        OR public.breeze_has_partner_access(partner_id)
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'partner_service_principal_keys'
      AND policyname = 'partner_service_principal_keys_partner_insert'
  ) THEN
    CREATE POLICY partner_service_principal_keys_partner_insert ON partner_service_principal_keys
      FOR INSERT WITH CHECK (
        public.breeze_current_scope() = 'system'
        OR public.breeze_has_partner_access(partner_id)
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'partner_service_principal_keys'
      AND policyname = 'partner_service_principal_keys_partner_update'
  ) THEN
    CREATE POLICY partner_service_principal_keys_partner_update ON partner_service_principal_keys
      FOR UPDATE USING (
        public.breeze_current_scope() = 'system'
        OR public.breeze_has_partner_access(partner_id)
      )
      WITH CHECK (
        public.breeze_current_scope() = 'system'
        OR public.breeze_has_partner_access(partner_id)
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'partner_service_principal_keys'
      AND policyname = 'partner_service_principal_keys_partner_delete'
  ) THEN
    CREATE POLICY partner_service_principal_keys_partner_delete ON partner_service_principal_keys
      FOR DELETE USING (
        public.breeze_current_scope() = 'system'
        OR public.breeze_has_partner_access(partner_id)
      );
  END IF;
END $$;
