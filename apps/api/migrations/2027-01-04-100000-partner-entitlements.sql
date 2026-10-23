-- Partner Entitlements W1 (spec docs/superpowers/specs/billing/2026-09-07-partner-entitlements-design.md §4;
-- Wisp W00 slot 2027-01-04-100000, wave #9907). RLS shape 3 (partner-axis). NO org_id: registered in
-- PARTNER_TENANT_TABLES only; partner purge finds it via information_schema (cascadeDeletePartner).
-- One row per (partner, feature_key, source); the resolver folds live rows under
-- manual > license > billing > plan default. Writes no rows, so no breeze.scope election.
CREATE TABLE IF NOT EXISTS partner_entitlements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id   uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  feature_key  varchar(64) NOT NULL,
  state        varchar(16) NOT NULL,
  source       varchar(16) NOT NULL,
  limits       jsonb,
  granted_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  revoked_at   timestamptz,
  reason       text,
  updated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_entitlements_state_chk         CHECK (state IN ('enabled','disabled')),
  CONSTRAINT partner_entitlements_source_chk        CHECK (source IN ('billing','license','manual')),
  CONSTRAINT partner_entitlements_manual_reason_chk CHECK (source <> 'manual' OR reason IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS partner_entitlements_partner_key_source_uq
  ON partner_entitlements (partner_id, feature_key, source);
CREATE INDEX IF NOT EXISTS partner_entitlements_partner_idx ON partner_entitlements (partner_id);

ALTER TABLE partner_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_entitlements FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'partner_entitlements' AND policyname = 'partner_entitlements_partner_access') THEN
    CREATE POLICY partner_entitlements_partner_access ON partner_entitlements
      FOR ALL TO breeze_app
      USING      (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON partner_entitlements TO breeze_app;
