-- office_addin_user_bindings: MFA-established Entra→technician binding for
-- the Office add-in tech persona. Tenancy shape 3 (partner-axis); no org_id,
-- so no cascade/export registration. Registered in PARTNER_TENANT_TABLES.
-- Idempotent: IF NOT EXISTS guards throughout.

CREATE TABLE IF NOT EXISTS office_addin_user_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entra_tenant_id uuid NOT NULL,
  entra_oid uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  partner_id uuid NOT NULL REFERENCES partners(id),
  bound_auth_epoch integer NOT NULL,
  mfa_verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id)
);

-- The bound user must belong to the bound partner: composite FK against
-- users(id, partner_id). users.id is the PK so this index is trivially
-- unique; it exists to satisfy the FK reference.
CREATE UNIQUE INDEX IF NOT EXISTS users_id_partner_id_key ON users (id, partner_id);
DO $$ BEGIN
  ALTER TABLE office_addin_user_bindings
    ADD CONSTRAINT office_addin_bindings_user_partner_fk
    FOREIGN KEY (user_id, partner_id) REFERENCES users (id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS office_addin_bindings_identity_active_uq
  ON office_addin_user_bindings (entra_tenant_id, entra_oid) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS office_addin_bindings_user_active_uq
  ON office_addin_user_bindings (user_id) WHERE revoked_at IS NULL;

ALTER TABLE office_addin_user_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_addin_user_bindings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS office_addin_user_bindings_partner_access ON office_addin_user_bindings;
CREATE POLICY office_addin_user_bindings_partner_access ON office_addin_user_bindings
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  );

-- GRANT includes DELETE (deviating from the original design note, which
-- assumed revocation-only/no-hard-delete meant no DELETE grant was needed).
-- Verified against services/tenantCascade.ts: cascadeDeletePartner's
-- partner-axis sweep discovers every table with a partner_id column via
-- information_schema and issues `DELETE FROM <table> WHERE partner_id = $1`
-- as breeze_app under a system RLS context (withSystemDbAccessContext sets
-- the RLS scope GUC only — it does NOT switch Postgres role; the connection
-- stays breeze_app). Without DELETE here, partner erasure would abort with
-- a permission-denied error the moment it reached this table. GDPR partner
-- erasure must be able to hard-delete bindings for a purged partner even
-- though normal application code only ever soft-revokes them.
GRANT SELECT, INSERT, UPDATE, DELETE ON office_addin_user_bindings TO breeze_app;
