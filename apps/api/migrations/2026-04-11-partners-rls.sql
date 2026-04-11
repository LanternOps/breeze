-- 2026-04-11: Enable RLS on partners and partner_users.
--
-- Adds a new tenancy axis for partner-scoped data. Partners are FLAT — no
-- hierarchy, no cross-partner access — so the check is a flat membership
-- lookup against a new `breeze.accessible_partner_ids` session variable
-- (mirroring the existing `breeze.accessible_org_ids`).
--
-- - `partners` uses its own `id` as the tenant key.
-- - `partner_users` uses `partner_id` as the tenant key.
--
-- INSERT + RETURNING caveats mirror the organizations migration: freshly-
-- created rows cannot be in any caller's accessible_partner_ids, so the
-- two new-tenant creation flows (auth/register.ts signup and
-- routes/users.ts invite-to-partner) must run the insert under system
-- scope. The signup flow already does this via tx-level set_config; the
-- auth middleware now also populates accessible_partner_ids from the
-- JWT partnerId so existing partner-scope update/delete paths continue
-- to work.
--
-- Fully idempotent — safe to re-run.

BEGIN;

-- ============================================================
-- Helper: read breeze.accessible_partner_ids as uuid[]
-- ============================================================
CREATE OR REPLACE FUNCTION public.breeze_accessible_partner_ids()
  RETURNS uuid[]
  LANGUAGE plpgsql
  STABLE
AS $function$
DECLARE
  raw text;
BEGIN
  raw := current_setting('breeze.accessible_partner_ids', true);

  -- "*" means unrestricted partner access (system scope).
  IF raw = '*' THEN
    RETURN NULL;
  END IF;

  -- Empty/missing means no partner access.
  IF raw IS NULL OR raw = '' THEN
    RETURN ARRAY[]::uuid[];
  END IF;

  RETURN string_to_array(raw, ',')::uuid[];
EXCEPTION
  WHEN others THEN
    -- Fail closed on malformed values.
    RETURN ARRAY[]::uuid[];
END;
$function$;

-- ============================================================
-- Helper: membership check mirroring breeze_has_org_access
-- ============================================================
CREATE OR REPLACE FUNCTION public.breeze_has_partner_access(target_partner_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
AS $function$
  SELECT CASE
    WHEN public.breeze_current_scope() = 'system' THEN TRUE
    WHEN target_partner_id IS NULL THEN FALSE
    ELSE COALESCE(target_partner_id = ANY(public.breeze_accessible_partner_ids()), FALSE)
  END;
$function$;

-- ============================================================
-- partners (id-keyed)
-- ============================================================
DROP POLICY IF EXISTS breeze_partner_isolation_select ON partners;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON partners;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON partners;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON partners;

ALTER TABLE partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_partner_isolation_select ON partners
  FOR SELECT USING (public.breeze_has_partner_access(id));
CREATE POLICY breeze_partner_isolation_insert ON partners
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(id));
CREATE POLICY breeze_partner_isolation_update ON partners
  FOR UPDATE USING (public.breeze_has_partner_access(id))
  WITH CHECK (public.breeze_has_partner_access(id));
CREATE POLICY breeze_partner_isolation_delete ON partners
  FOR DELETE USING (public.breeze_has_partner_access(id));

-- ============================================================
-- partner_users (partner_id-keyed)
-- ============================================================
DROP POLICY IF EXISTS breeze_partner_isolation_select ON partner_users;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON partner_users;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON partner_users;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON partner_users;

ALTER TABLE partner_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_users FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_partner_isolation_select ON partner_users
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON partner_users
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON partner_users
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON partner_users
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

COMMIT;
