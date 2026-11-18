-- Alert external ticket references, namespaced by service principal (Shape 1).
-- The principal/partner and org/partner composite FKs pin each ref to one
-- partner. The alert/org composite cascades a within-partner device move or
-- org merge; cross-partner movers delete refs BEFORE restamping alerts.
-- All composite FKs are DEFERRABLE INITIALLY IMMEDIATE for org merge.
-- Org, partner, alert and principal erasure cascade the reference. Registries
-- explicitly include this table for org erasure, merge and tenant export.
-- One PSA ticket may cover several alerts: external_id is deliberately NOT
-- unique. The alert-leading unique index also supports alert cascade lookups.
-- DDL only; this migration writes no rows.
CREATE TABLE IF NOT EXISTS public.alert_external_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id uuid NOT NULL REFERENCES public.alerts(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  partner_id uuid NOT NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  partner_service_principal_id uuid NOT NULL,
  external_id varchar(255) NOT NULL,
  external_url text,
  external_number varchar(255),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_external_refs_principal_partner_fk
    FOREIGN KEY (partner_service_principal_id, partner_id)
    REFERENCES public.partner_service_principals(id, partner_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT alert_external_refs_org_partner_fk FOREIGN KEY (org_id, partner_id)
    REFERENCES public.organizations(id, partner_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT alert_external_refs_url_https_chk CHECK (external_url IS NULL OR external_url ~* '^https://')
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'alert_external_refs_alert_org_fk'
      AND conrelid = 'public.alert_external_refs'::regclass) THEN
    ALTER TABLE public.alert_external_refs ADD CONSTRAINT alert_external_refs_alert_org_fk
      FOREIGN KEY (alert_id, org_id) REFERENCES public.alerts(id, org_id)
      ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS alert_external_refs_alert_principal_uq
  ON public.alert_external_refs (alert_id, partner_service_principal_id);
CREATE INDEX IF NOT EXISTS alert_external_refs_principal_idx ON public.alert_external_refs (partner_service_principal_id);
CREATE INDEX IF NOT EXISTS alert_external_refs_org_idx ON public.alert_external_refs (org_id);
CREATE INDEX IF NOT EXISTS alert_external_refs_partner_idx ON public.alert_external_refs (partner_id);

ALTER TABLE public.alert_external_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_external_refs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.alert_external_refs;
CREATE POLICY breeze_org_isolation_select ON public.alert_external_refs
  FOR SELECT USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.alert_external_refs;
CREATE POLICY breeze_org_isolation_insert ON public.alert_external_refs
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.alert_external_refs;
CREATE POLICY breeze_org_isolation_update ON public.alert_external_refs
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.alert_external_refs;
CREATE POLICY breeze_org_isolation_delete ON public.alert_external_refs
  FOR DELETE USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.alert_external_refs TO breeze_app;
