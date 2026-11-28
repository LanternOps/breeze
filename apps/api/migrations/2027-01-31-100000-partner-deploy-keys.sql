-- Reinstall reattach #8318 wave D-1 — deploy keys for the holding area.
--
-- A deploy key is a long-lived credential baked into an image: an agent that
-- enrolls with one is parked in the partner's holding area (the hidden
-- `unassigned_pool` org) and nothing more (spec 2026-10-12 §10). Only the
-- peppered hash of the key is stored (services/enrollmentKeySecurity.ts); the
-- plaintext is shown once, at mint or rotate.
--
-- Tenancy shape 3 (partner-axis). Registered in PARTNER_TENANT_TABLES.
-- No org_id column, so NO org cascade / device cascade / org-merge /
-- tenant-export registration.
--   * partner_id FK ON DELETE CASCADE: erased with the partner
--     (cascadeDeletePartner's information_schema partner_id sweep also
--     reaches it, as breeze_app in a system context: DELETE is GRANTed).
--   * created_by / revoked_by → users ON DELETE SET NULL: the key outlives
--     the admin who minted or revoked it.
--   * rotated_from_id → this table ON DELETE SET NULL: the rotation lineage.
--   * device_pool_assignment_events.deploy_key_id deliberately has NO FK to
--     this table: the ledger is a snapshot record that must outlive the key.
--
-- RLS: the permissive partner-axis policy (system OR
-- breeze_has_partner_access) plus a RESTRICTIVE system-only policy, as on
-- device_pool_assignment_events (2026-11-08-190300). Only full partner
-- admins (canManagePartnerWidePolicies) may manage or list deploy keys, and
-- RLS cannot tell a full admin from a selected-org member (both pass
-- breeze_has_partner_access), so every read and write runs in a system
-- context scoped to the partner the route resolved
-- (services/deployKeys/*), and the enrollment path resolves keys in system
-- scope too.
--
-- Limits (spec §10.2, §13 decision 8; services/unassignedPool/limits.ts):
-- lifetime at most 365 days, at most 1000 uses, at most 20 parked at once.
-- The two-active-keys-per-image rule is enforced under the holding-area lock
-- at mint/rotate, not by a constraint (a partial unique index cannot count
-- to two).
--
-- Idempotent. No inner BEGIN/COMMIT. Writes no rows.

CREATE TABLE IF NOT EXISTS partner_deploy_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  name varchar(255) NOT NULL,
  image_label varchar(100) NOT NULL,
  key_hash varchar(64) NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  max_usage integer NOT NULL,
  usage_count integer NOT NULL DEFAULT 0,
  max_parked integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  rotated_from_id uuid REFERENCES partner_deploy_keys(id) ON DELETE SET NULL,
  last_used_at timestamptz,
  last_used_ip varchar(45),
  source_cidrs cidr[],
  CONSTRAINT partner_deploy_keys_key_hash_key UNIQUE (key_hash),
  CONSTRAINT partner_deploy_keys_name_chk CHECK (length(btrim(name)) > 0),
  CONSTRAINT partner_deploy_keys_image_label_chk CHECK (length(btrim(image_label)) > 0),
  CONSTRAINT partner_deploy_keys_max_usage_chk CHECK (max_usage BETWEEN 1 AND 1000),
  CONSTRAINT partner_deploy_keys_max_parked_chk CHECK (max_parked BETWEEN 1 AND 20),
  CONSTRAINT partner_deploy_keys_usage_count_chk CHECK (usage_count >= 0 AND usage_count <= max_usage),
  CONSTRAINT partner_deploy_keys_lifetime_chk
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '365 days'),
  CONSTRAINT partner_deploy_keys_status_chk CHECK (status IN ('active', 'revoked')),
  CONSTRAINT partner_deploy_keys_revocation_shape_chk CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoked_by IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT partner_deploy_keys_source_cidrs_chk
    CHECK (source_cidrs IS NULL OR cardinality(source_cidrs) > 0),
  CONSTRAINT partner_deploy_keys_rotation_chk
    CHECK (rotated_from_id IS NULL OR rotated_from_id <> id)
);

CREATE INDEX IF NOT EXISTS partner_deploy_keys_partner_created_idx
  ON partner_deploy_keys (partner_id, created_at);
-- The per-image active-key count taken at mint/rotate (case-insensitive label).
CREATE INDEX IF NOT EXISTS partner_deploy_keys_partner_image_active_idx
  ON partner_deploy_keys (partner_id, lower(image_label))
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS partner_deploy_keys_rotated_from_idx
  ON partner_deploy_keys (rotated_from_id);

ALTER TABLE partner_deploy_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_deploy_keys FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_deploy_keys_partner_access ON partner_deploy_keys;
CREATE POLICY partner_deploy_keys_partner_access ON partner_deploy_keys
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'partner_deploy_keys'
       AND policyname = 'partner_deploy_keys_system_only'
  ) THEN
    CREATE POLICY partner_deploy_keys_system_only ON public.partner_deploy_keys
      AS RESTRICTIVE
      FOR ALL
      USING (public.breeze_current_scope() = 'system')
      WITH CHECK (public.breeze_current_scope() = 'system');
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON partner_deploy_keys TO breeze_app;
