-- Configuration policy inheritance (spec: docs/superpowers/specs/config-policy/
-- 2026-09-06-config-policy-inheritance-design.md, feature #5080 wave #5081).
--
-- 1. `configuration_policies.parent_policy_id` — one-level, create-only parent.
-- 2. Ownership rule enforced by DEFERRABLE constraint triggers (org merge runs
--    SET CONSTRAINTS ALL DEFERRED and re-points parent and child org_id in
--    separate statements; validation therefore happens at commit, by which time
--    the whole family has moved and the rule holds again).
-- 3. `config_policy_effective_feature_links` — the child's own links plus the
--    parent's links for feature types the child lacks. security_invoker so the
--    base tables' RLS (incl. the *_partner_wide_select branches, which are also
--    populated on the agent-auth path) applies to the caller. An inherited row
--    keeps the PARENT link's id: the normalized per-feature settings tables
--    (config_policy_patch_settings, ...) are keyed by feature_link_id and every
--    resolver joins on links.id.
--
-- No DML, so no breeze.scope election is required. Idempotent.

ALTER TABLE public.configuration_policies
  ADD COLUMN IF NOT EXISTS parent_policy_id uuid;

-- Default NO ACTION on purpose (not RESTRICT, not SET NULL). SET NULL would
-- silently un-configure every child when a baseline is deleted; NO ACTION is
-- the repo convention and stays deferrable-compatible for org merge. A single
-- `DELETE ... WHERE org_id = X` that removes parent and children together
-- still succeeds (verified on PG 16.15, the prod version).
ALTER TABLE public.configuration_policies
  DROP CONSTRAINT IF EXISTS configuration_policies_parent_policy_id_fkey;
ALTER TABLE public.configuration_policies
  ADD CONSTRAINT configuration_policies_parent_policy_id_fkey
  FOREIGN KEY (parent_policy_id) REFERENCES public.configuration_policies(id);

ALTER TABLE public.configuration_policies
  DROP CONSTRAINT IF EXISTS configuration_policies_not_own_parent_chk;
ALTER TABLE public.configuration_policies
  ADD CONSTRAINT configuration_policies_not_own_parent_chk
  CHECK (parent_policy_id IS NULL OR parent_policy_id <> id);

CREATE INDEX IF NOT EXISTS config_policies_parent_policy_id_idx
  ON public.configuration_policies (parent_policy_id)
  WHERE parent_policy_id IS NOT NULL;

COMMENT ON COLUMN public.configuration_policies.parent_policy_id IS
  'One-level, create-only inheritance parent. Immutable after insert (enforced by '
  'configuration_policies_parent_guard). Ownership rule: an org-owned child may name a '
  'same-org parent or a partner-wide parent of its org''s partner; a partner-wide child may '
  'only name a partner-wide parent of the same partner. The parent must itself be a root.';

-- Ownership compatibility, shared by both guards below and mirrored in
-- TypeScript by services/configPolicyOwnership.ts::isCompatibleParent.
--
-- SECURITY DEFINER like breeze_guard_pam_device_org_move: where the migration
-- role carries BYPASSRLS (prod doadmin, CI breeze_migrator) this makes the
-- guard's reads authoritative rather than invoker-limited. Where it does not,
-- the guard degrades to FAIL-CLOSED (an RLS-invisible parent reads as NOT
-- FOUND and is rejected), which is the same answer the service layer gives.
-- The ownership RULE, not row visibility, is what rejects a cross-tenant edge.
CREATE OR REPLACE FUNCTION public.breeze_config_policy_parent_compatible(
  child_org uuid, child_partner uuid, parent_org uuid, parent_partner uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  -- STRICTLY two-valued. Every comparison here can yield NULL — `parent_org =
  -- child_org` is NULL whenever parent_org IS NULL (a partner-wide parent), and
  -- the organizations sub-select yields NULL for an org that is missing or
  -- RLS-invisible. Under three-valued logic `NULL OR false` is NULL, `NOT NULL`
  -- is NULL, and an `IF NOT compatible(...)` guard then does NOT fire: a
  -- cross-partner partner-wide parent would be silently ACCEPTED. The outer
  -- COALESCE collapses every unknown to false so the answer is always a real
  -- boolean and always fails closed. (The callers additionally test
  -- `IS NOT TRUE` rather than `NOT`, as defence in depth.)
  SELECT COALESCE(
    CASE
      WHEN child_org IS NOT NULL THEN
        parent_org = child_org
        OR (parent_org IS NULL AND parent_partner IS NOT NULL
            AND parent_partner = (SELECT o.partner_id FROM public.organizations o WHERE o.id = child_org))
      WHEN child_partner IS NOT NULL THEN
        parent_org IS NULL AND parent_partner = child_partner
      ELSE false
    END,
    false
  );
$$;

-- Not a public oracle for "does org X belong to partner P".
REVOKE ALL ON FUNCTION public.breeze_config_policy_parent_compatible(uuid, uuid, uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.breeze_config_policy_parent_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  p RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Immutable INCLUDING NULL -> value: an existing baseline must never be
    -- able to acquire a parent later (that would break the one-level rule
    -- retroactively for every policy that already inherits from it).
    IF NEW.parent_policy_id IS DISTINCT FROM OLD.parent_policy_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'configuration_policies_parent_immutable',
        MESSAGE = 'configuration policy parent is set at create time and cannot change';
    END IF;
    -- The HTTP API never changes ownership; org merge runs in system context.
    -- Rejecting non-system ownership moves closes the blind spot where a
    -- partner-scoped invoker could move a baseline while RLS hid some of its
    -- children from the incoming-edge check below.
    IF (NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.partner_id IS DISTINCT FROM OLD.partner_id)
       AND public.breeze_current_scope() <> 'system' THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'configuration_policies_owner_immutable',
        MESSAGE = 'configuration policy ownership can only change in system context';
    END IF;
  END IF;

  -- Outgoing edge: this row's own parent.
  IF NEW.parent_policy_id IS NOT NULL THEN
    SELECT cp.org_id, cp.partner_id, cp.parent_policy_id INTO p
      FROM public.configuration_policies cp WHERE cp.id = NEW.parent_policy_id;
    IF NOT FOUND
       OR p.parent_policy_id IS NOT NULL
       OR public.breeze_config_policy_parent_compatible(NEW.org_id, NEW.partner_id, p.org_id, p.partner_id) IS NOT TRUE THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'configuration_policies_parent_guard',
        MESSAGE = 'parent configuration policy not found or not eligible';
    END IF;
  END IF;

  -- Incoming edges: rows that name this row as their parent. Only reachable on
  -- UPDATE (a freshly inserted row cannot yet be referenced — the FK forbids
  -- it), and only meaningfully in system scope after the ownership gate above.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.parent_policy_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.configuration_policies c WHERE c.parent_policy_id = NEW.id) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'configuration_policies_parent_guard',
        MESSAGE = 'a configuration policy with children cannot have a parent';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.configuration_policies c
       WHERE c.parent_policy_id = NEW.id
         AND public.breeze_config_policy_parent_compatible(c.org_id, c.partner_id, NEW.org_id, NEW.partner_id) IS NOT TRUE
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        CONSTRAINT = 'configuration_policies_parent_guard',
        MESSAGE = 'ownership change would orphan child configuration policies';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_config_policy_parent_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS configuration_policies_parent_guard ON public.configuration_policies;
CREATE CONSTRAINT TRIGGER configuration_policies_parent_guard
  AFTER INSERT OR UPDATE OF parent_policy_id, org_id, partner_id
  ON public.configuration_policies
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.breeze_config_policy_parent_guard();

-- An org changing partner would orphan its children of partner-wide parents.
-- No code path does this today; the guard keeps the invariant from depending on
-- that staying true.
CREATE OR REPLACE FUNCTION public.breeze_config_policy_org_partner_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.partner_id IS DISTINCT FROM OLD.partner_id AND EXISTS (
    SELECT 1
      FROM public.configuration_policies c
      JOIN public.configuration_policies p ON p.id = c.parent_policy_id
     WHERE c.org_id = NEW.id
       AND p.org_id IS NULL
       AND p.partner_id IS DISTINCT FROM NEW.partner_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'organizations_partner_config_policy_guard',
      MESSAGE = 'organization partner change would orphan child configuration policies';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_config_policy_org_partner_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS organizations_partner_config_policy_guard ON public.organizations;
CREATE CONSTRAINT TRIGGER organizations_partner_config_policy_guard
  AFTER UPDATE OF partner_id ON public.organizations
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.breeze_config_policy_org_partner_guard();

-- Effective feature links = own links UNION ALL the parent's links for feature
-- types the child has no link of its own. A child link is a COMPLETE override
-- for that feature type (no field-level merging).
--
-- security_invoker = true (PG 15+; prod is 16.15) makes the base tables' RLS
-- apply to the CALLER. Without it a view runs as its owner and would bypass RLS
-- entirely — there is deliberately no fallback to a plain view.
CREATE OR REPLACE VIEW public.config_policy_effective_feature_links
  WITH (security_invoker = true) AS
  SELECT l.id, l.config_policy_id, l.config_policy_id AS source_policy_id,
         l.feature_type, l.feature_policy_id, l.inline_settings, l.created_at, l.updated_at,
         false AS inherited
    FROM public.config_policy_feature_links l
  UNION ALL
  SELECT pl.id, c.id AS config_policy_id, pl.config_policy_id AS source_policy_id,
         pl.feature_type, pl.feature_policy_id, pl.inline_settings, pl.created_at, pl.updated_at,
         true AS inherited
    FROM public.configuration_policies c
    JOIN public.config_policy_feature_links pl ON pl.config_policy_id = c.parent_policy_id
   WHERE c.parent_policy_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.config_policy_feature_links own
        WHERE own.config_policy_id = c.id AND own.feature_type = pl.feature_type
     );

COMMENT ON VIEW public.config_policy_effective_feature_links IS
  'Effective configuration-policy feature links: a policy''s own links plus its parent''s links '
  'for feature types it does not override. security_invoker, so the base tables'' RLS applies to '
  'the caller. An inherited row keeps the PARENT link id so joins on '
  'config_policy_*_settings.feature_link_id keep working.';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT SELECT ON public.config_policy_effective_feature_links TO breeze_app;
  END IF;
END $$;
