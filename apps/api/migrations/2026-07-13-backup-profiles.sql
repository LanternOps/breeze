-- Backup profiles (docs/superpowers/specs/2026-07-13-backup-profiles-design.md).
--
-- A backup profile is a Cove-style selection entity answering "what to
-- protect" for a device class (Files / System State / SQL / Hyper-V, each
-- with per-source options). The config-policy backup feature link references
-- a profile, and job creation fans out one job per enabled selection from the
-- single winning link — fixing the silent multi-mode shadowing where a server
-- assigned file + system_state + mssql policies got only one of them.
--
-- Ownership is dual-axis per epic #2135 (partner-wide first): org_id XOR
-- partner_id, so an MSP defines "Server" once and applies it across every
-- org. Storage destinations (backup_configs) stay org-owned — credentials —
-- which is why partner-wide policies need the per-org DEFAULT destination
-- introduced here: their links carry destination_config_id NULL and resolve
-- the device org's default at job-creation time.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- guarded CHECK/FK adds, DROP POLICY IF EXISTS then CREATE. No inner
-- BEGIN/COMMIT (autoMigrate wraps each file in a transaction).

-- ============================================
-- Step 1: backup_profiles table (dual-axis, XOR owner)
-- ============================================

CREATE TABLE IF NOT EXISTS backup_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id),
  partner_id uuid REFERENCES partners(id),
  name varchar(200) NOT NULL,
  description text,
  selections jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT backup_profiles_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL))
);

CREATE INDEX IF NOT EXISTS backup_profiles_org_id_idx ON backup_profiles(org_id);
CREATE INDEX IF NOT EXISTS backup_profiles_partner_id_idx ON backup_profiles(partner_id);
CREATE INDEX IF NOT EXISTS backup_profiles_active_idx ON backup_profiles(is_active);

-- ============================================
-- Step 2: RLS — dual-axis (org OR partner) + system short-circuit
-- ============================================
-- Same shape as software_policies / configuration_policies dual-axis policies.

ALTER TABLE backup_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_profiles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS backup_profiles_isolation ON backup_profiles;
CREATE POLICY backup_profiles_isolation
  ON backup_profiles
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

-- ============================================
-- Step 3: config_policy_backup_settings — profile + destination references
-- ============================================
-- backup_profile_id: RESTRICT — deleting a profile still referenced by a
-- feature link is blocked (the API surfaces a friendly 409 listing the
-- referencing policies, matching update-ring behavior).
-- destination_config_id: SET NULL — a deleted destination falls back to
-- "resolve org default at job time"; job creation fails loudly when no
-- default exists (never a silent skip).

ALTER TABLE config_policy_backup_settings
  ADD COLUMN IF NOT EXISTS backup_profile_id uuid;

ALTER TABLE config_policy_backup_settings
  ADD COLUMN IF NOT EXISTS destination_config_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'config_policy_backup_settings_profile_fk'
      AND conrelid = 'config_policy_backup_settings'::regclass
  ) THEN
    ALTER TABLE config_policy_backup_settings
      ADD CONSTRAINT config_policy_backup_settings_profile_fk
      FOREIGN KEY (backup_profile_id) REFERENCES backup_profiles(id) ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'config_policy_backup_settings_destination_fk'
      AND conrelid = 'config_policy_backup_settings'::regclass
  ) THEN
    ALTER TABLE config_policy_backup_settings
      ADD CONSTRAINT config_policy_backup_settings_destination_fk
      FOREIGN KEY (destination_config_id) REFERENCES backup_configs(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS config_policy_backup_settings_profile_idx
  ON config_policy_backup_settings(backup_profile_id);

-- ============================================
-- Step 4: backup_configs — per-org default destination flag
-- ============================================

ALTER TABLE backup_configs
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS backup_configs_org_default_uq
  ON backup_configs(org_id) WHERE is_default;
