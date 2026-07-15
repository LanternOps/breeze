-- Core auth hardening PR 5 (SR2-15): explicit, opt-in service principals so
-- automation owned by an off-boarded human can be migrated to a first-class
-- non-human identity instead of silently surviving on a dead human's authority.
-- Idempotent. No inner BEGIN/COMMIT (runner wraps the file in a transaction).

CREATE TABLE IF NOT EXISTS service_principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name varchar(255) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'active',
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid NOT NULL REFERENCES users(id),
  last_updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_principals_status_chk CHECK (status IN ('active','disabled'))
);

ALTER TABLE service_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_principals FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'service_principals'
      AND policyname = 'service_principals_org_access'
  ) THEN
    CREATE POLICY service_principals_org_access ON service_principals
      USING (breeze_has_org_access(org_id))
      WITH CHECK (breeze_has_org_access(org_id));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON service_principals TO breeze_app;

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS principal_type varchar(16) NOT NULL DEFAULT 'human';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS principal_id uuid REFERENCES service_principals(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_principal_type_chk'
  ) THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_principal_type_chk
      CHECK (principal_type IN ('human','service'));
  END IF;
END $$;
