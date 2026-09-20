-- Billing profiles, rule rows and org assignments (billing profiles spec §4.2).
-- TENANCY: shape 3, plain partner-axis RLS with ENABLE + FORCE on every table.
-- All three register in PARTNER_TENANT_TABLES. The assignment also registers in
-- ORG_AXIS_POLICY_EXCLUDED_TABLES, CORE_ORG_CASCADE_DELETE_ORDER,
-- CORE_TENANT_EXPORT_POLICY and orgMergeRegistry (keep-survivor).
-- No dual-axis or partner-wide SELECT exceptions: org tokens cannot read rates.
-- Partner erasure discovers partner_id and orders deletes from real FK edges;
-- the DELETE grants are required for that sweep as breeze_app. Profile/rule
-- tables have no org_id, so owe no org cascade/export/merge registration.
-- DDL only, idempotent; autoMigrate owns the surrounding transaction.

CREATE TABLE IF NOT EXISTS billing_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  name text NOT NULL,
  notes text,
  currency_code char(3) NOT NULL REFERENCES supported_currencies(code),
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  rounding_increment_minutes integer,
  base_coverage text NOT NULL,
  base_hourly_rate numeric(10,2),
  base_minimum_minutes integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_profiles_name_not_blank_chk CHECK (btrim(name) <> ''),
  CONSTRAINT billing_profiles_base_coverage_chk CHECK (base_coverage IN ('billable', 'included', 'non_billable')),
  CONSTRAINT billing_profiles_base_rate_only_when_billable_chk
    CHECK (base_coverage = 'billable' OR (base_hourly_rate IS NULL AND base_minimum_minutes IS NULL)),
  CONSTRAINT billing_profiles_rounding_range_chk
    CHECK (rounding_increment_minutes IS NULL OR rounding_increment_minutes BETWEEN 1 AND 480)
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_profiles_partner_name_uniq
  ON billing_profiles (partner_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS billing_profiles_default_per_currency_uniq
  ON billing_profiles (partner_id, currency_code) WHERE is_default AND is_active;

CREATE TABLE IF NOT EXISTS billing_profile_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  billing_profile_id uuid NOT NULL,
  work_type_id uuid NOT NULL,
  coverage text NOT NULL,
  hourly_rate numeric(10,2),
  minimum_minutes integer,
  notes text,
  CONSTRAINT billing_profile_rules_coverage_chk CHECK (coverage IN ('billable', 'included', 'non_billable')),
  CONSTRAINT billing_profile_rules_rate_only_when_billable_chk
    CHECK (coverage = 'billable' OR (hourly_rate IS NULL AND minimum_minutes IS NULL))
);

CREATE TABLE IF NOT EXISTS org_billing_profile_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL UNIQUE,
  partner_id uuid NOT NULL REFERENCES partners(id),
  billing_profile_id uuid NOT NULL,
  assigned_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_profiles_id_partner_uniq') THEN
    ALTER TABLE billing_profiles ADD CONSTRAINT billing_profiles_id_partner_uniq
      UNIQUE (id, partner_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_profile_rules_profile_work_type_uniq') THEN
    ALTER TABLE billing_profile_rules ADD CONSTRAINT billing_profile_rules_profile_work_type_uniq
      UNIQUE (billing_profile_id, work_type_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_profile_rules_profile_partner_fk') THEN
    ALTER TABLE billing_profile_rules ADD CONSTRAINT billing_profile_rules_profile_partner_fk
      FOREIGN KEY (billing_profile_id, partner_id) REFERENCES billing_profiles (id, partner_id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_profile_rules_work_type_partner_fk') THEN
    ALTER TABLE billing_profile_rules ADD CONSTRAINT billing_profile_rules_work_type_partner_fk
      FOREIGN KEY (work_type_id, partner_id) REFERENCES work_types (id, partner_id);
  END IF;
END $$;

-- Org merge defers this FK while re-pointing parent and child separately.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_billing_profile_assignments_org_partner_fk') THEN
    ALTER TABLE org_billing_profile_assignments ADD CONSTRAINT org_billing_profile_assignments_org_partner_fk
      FOREIGN KEY (org_id, partner_id) REFERENCES organizations (id, partner_id) DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_billing_profile_assignments_profile_partner_fk') THEN
    ALTER TABLE org_billing_profile_assignments ADD CONSTRAINT org_billing_profile_assignments_profile_partner_fk
      FOREIGN KEY (billing_profile_id, partner_id) REFERENCES billing_profiles (id, partner_id);
  END IF;
END $$;

ALTER TABLE billing_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_profiles FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public'
      AND tablename = 'billing_profiles' AND policyname = 'billing_profiles_partner_access'
  ) THEN
    CREATE POLICY billing_profiles_partner_access ON billing_profiles
      FOR ALL TO breeze_app
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing_profiles TO breeze_app;

ALTER TABLE billing_profile_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_profile_rules FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public'
      AND tablename = 'billing_profile_rules' AND policyname = 'billing_profile_rules_partner_access'
  ) THEN
    CREATE POLICY billing_profile_rules_partner_access ON billing_profile_rules
      FOR ALL TO breeze_app
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing_profile_rules TO breeze_app;

-- Plain partner access: a conjunctive org policy hides suspended org assignments.
-- Org visibility is enforced app-layer, matching time_entries.
ALTER TABLE org_billing_profile_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_billing_profile_assignments FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public'
      AND tablename = 'org_billing_profile_assignments' AND policyname = 'org_billing_profile_assignments_partner_access'
  ) THEN
    CREATE POLICY org_billing_profile_assignments_partner_access ON org_billing_profile_assignments
      FOR ALL TO breeze_app
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON org_billing_profile_assignments TO breeze_app;

