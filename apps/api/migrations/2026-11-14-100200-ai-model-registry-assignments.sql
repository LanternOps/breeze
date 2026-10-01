-- AI model registry W02 (#7600, spec §5.4): ai_model_assignments — for one
-- (surface, role): the default offering, the permitted set, user choice,
-- options and (W09) ordered fallbacks. Partner-wide first (epic #2135): a row
-- is EITHER partner-wide (partner_id set, org_id NULL) or an org override
-- (org_id set), never both (ai_model_assignments_one_owner_chk).
--
-- OWNERSHIP (quorum #1). offering_partner_id is the partner that owns every
-- referenced offering, denormalized so the database can enforce it:
--   partner rows : CHECK partner_id = offering_partner_id
--   org rows     : (org_id, offering_partner_id) -> organizations(id, partner_id)
--                  DEFERRABLE INITIALLY IMMEDIATE (org merge runs
--                  SET CONSTRAINTS ALL DEFERRED; merges are same-partner)
--   default      : (default_offering_id, offering_partner_id)
--                  -> partner_ai_models(id, partner_id)
--   arrays       : permitted_offering_ids / fallback_offering_ids cannot carry
--                  FKs, so ai_model_assignments_offering_ownership_guard checks
--                  every element belongs to offering_partner_id, with no
--                  duplicates. It runs with the WRITER's RLS: a partner context
--                  sees all its offerings; an org context (W04 overrides) sees
--                  only ENABLED ones (partner_ai_models_org_read_enabled), so an
--                  org override can never reference a disabled offering.
-- Dangling ids after an offering is deleted are tolerated; the resolver
-- re-filters membership to enabled rows at use (spec §5.4).
--
-- TENANCY: dual-axis FOR ALL (system OR org access OR partner access) plus the
-- SELECT-only partner-wide branch from the template
-- 2026-10-05-110000-config-policy-partner-wide-select.sql, in this same file.
-- Registered: DUAL_AXIS_TENANT_TABLES, XOR_OWNERSHIP_DUAL_AXIS_TABLES,
-- CORE_ORG_CASCADE_DELETE_ORDER, orgMergeRegistry repoint-dedupe (surface, role),
-- CORE_TENANT_EXPORT_POLICY (options -> excludedOpen).
--
-- Uniqueness (owner, surface, role) is two partial unique indexes rather than
-- one COALESCE(org_id, partner_id) expression index: same semantics, and both
-- are ON CONFLICT targets for the W02 reconcile.
--
-- Idempotent. Writes no rows.

CREATE TABLE IF NOT EXISTS public.ai_model_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  partner_id uuid REFERENCES public.partners(id) ON DELETE CASCADE,
  offering_partner_id uuid NOT NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  surface text NOT NULL,
  role text NOT NULL DEFAULT 'default',
  default_offering_id uuid,
  options jsonb,
  fallback_offering_ids uuid[],
  fallback_may_cross_funding boolean,
  permitted_offering_ids uuid[],
  allow_user_choice boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_model_assignments DROP CONSTRAINT IF EXISTS ai_model_assignments_one_owner_chk;
ALTER TABLE public.ai_model_assignments ADD CONSTRAINT ai_model_assignments_one_owner_chk
  CHECK ((org_id IS NULL) <> (partner_id IS NULL));

ALTER TABLE public.ai_model_assignments DROP CONSTRAINT IF EXISTS ai_model_assignments_partner_owner_chk;
ALTER TABLE public.ai_model_assignments ADD CONSTRAINT ai_model_assignments_partner_owner_chk
  CHECK (partner_id IS NULL OR partner_id = offering_partner_id);

ALTER TABLE public.ai_model_assignments DROP CONSTRAINT IF EXISTS ai_model_assignments_org_partner_fk;
ALTER TABLE public.ai_model_assignments ADD CONSTRAINT ai_model_assignments_org_partner_fk
  FOREIGN KEY (org_id, offering_partner_id)
  REFERENCES public.organizations (id, partner_id)
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE public.ai_model_assignments DROP CONSTRAINT IF EXISTS ai_model_assignments_default_offering_fk;
ALTER TABLE public.ai_model_assignments ADD CONSTRAINT ai_model_assignments_default_offering_fk
  FOREIGN KEY (default_offering_id, offering_partner_id)
  REFERENCES public.partner_ai_models (id, partner_id);

ALTER TABLE public.ai_model_assignments DROP CONSTRAINT IF EXISTS ai_model_assignments_surface_chk;
ALTER TABLE public.ai_model_assignments ADD CONSTRAINT ai_model_assignments_surface_chk
  CHECK (surface IN ('chat', 'helper', 'script_builder', 'script_reviewer', 'office_chat',
                     'office_ticket', 'ai_agents', 'catalog_enrichment', 'extension_content', 'patch_test'));

ALTER TABLE public.ai_model_assignments DROP CONSTRAINT IF EXISTS ai_model_assignments_role_chk;
ALTER TABLE public.ai_model_assignments ADD CONSTRAINT ai_model_assignments_role_chk CHECK (
  role = 'default'
  OR (surface = 'ai_agents' AND role IN ('triage', 'analysis', 'remediation'))
);

ALTER TABLE public.ai_model_assignments DROP CONSTRAINT IF EXISTS ai_model_assignments_shape_chk;
ALTER TABLE public.ai_model_assignments ADD CONSTRAINT ai_model_assignments_shape_chk CHECK (
  (options IS NULL OR jsonb_typeof(options) = 'object')
  AND array_position(permitted_offering_ids, NULL) IS NULL
  AND array_position(fallback_offering_ids, NULL) IS NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_model_assignments_partner_uq
  ON public.ai_model_assignments (partner_id, surface, role) WHERE org_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_model_assignments_org_uq
  ON public.ai_model_assignments (org_id, surface, role) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_model_assignments_offering_partner_idx
  ON public.ai_model_assignments (offering_partner_id);
CREATE INDEX IF NOT EXISTS ai_model_assignments_default_offering_idx
  ON public.ai_model_assignments (default_offering_id) WHERE default_offering_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.ai_model_assignments_offering_ownership_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  foreign_id uuid;
BEGIN
  IF NEW.permitted_offering_ids IS NOT NULL
     AND cardinality(NEW.permitted_offering_ids)
         <> (SELECT count(DISTINCT x) FROM unnest(NEW.permitted_offering_ids) AS u(x)) THEN
    RAISE EXCEPTION 'permitted_offering_ids contains a duplicate' USING ERRCODE = '23514';
  END IF;
  IF NEW.fallback_offering_ids IS NOT NULL
     AND cardinality(NEW.fallback_offering_ids)
         <> (SELECT count(DISTINCT x) FROM unnest(NEW.fallback_offering_ids) AS u(x)) THEN
    RAISE EXCEPTION 'fallback_offering_ids contains a duplicate' USING ERRCODE = '23514';
  END IF;

  SELECT u.x INTO foreign_id
    FROM unnest(COALESCE(NEW.permitted_offering_ids, '{}'::uuid[])
                || COALESCE(NEW.fallback_offering_ids, '{}'::uuid[])) AS u(x)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.partner_ai_models AS m
      WHERE m.id = u.x AND m.partner_id = NEW.offering_partner_id
   )
   LIMIT 1;
  IF foreign_id IS NOT NULL THEN
    RAISE EXCEPTION 'offering % is not an offering of the assignment''s partner', foreign_id
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS ai_model_assignments_offering_ownership_guard ON public.ai_model_assignments;
CREATE TRIGGER ai_model_assignments_offering_ownership_guard
  BEFORE INSERT OR UPDATE OF permitted_offering_ids, fallback_offering_ids, offering_partner_id
  ON public.ai_model_assignments
  FOR EACH ROW EXECUTE FUNCTION public.ai_model_assignments_offering_ownership_guard();

ALTER TABLE public.ai_model_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_model_assignments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_model_assignments_isolation ON public.ai_model_assignments;
CREATE POLICY ai_model_assignments_isolation ON public.ai_model_assignments
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

-- Partner-wide READ branch (template: 2026-10-05-110000-config-policy-partner-wide-select.sql).
-- SELECT only: never widens UPDATE/DELETE targeting to partner-wide rows.
DROP POLICY IF EXISTS ai_model_assignments_partner_wide_select ON public.ai_model_assignments;
CREATE POLICY ai_model_assignments_partner_wide_select
  ON public.ai_model_assignments
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_model_assignments TO breeze_app;
