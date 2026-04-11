-- 2026-04-11: Add tenancy columns to users, backfill, and enable RLS on
-- users + organization_users.
--
-- Data model (per product constraint):
--   - Every user belongs to exactly one MSP (partner). `users.partner_id` is
--     NOT NULL once backfilled.
--   - `users.org_id` is NULL for MSP staff (partner-level users), set for
--     customer-org users.
--   - The one dual case: an MSP staff member who is ALSO a member of the
--     MSP's own "internal org" has both partner_id and org_id set, and that
--     internal org belongs to the same partner. Structurally enforced by a
--     composite foreign key (`users.(org_id, partner_id)` →
--     `organizations.(id, partner_id)`), so the tenancy coherence invariant
--     is guaranteed by the DB regardless of app-level bugs or policy bugs.
--
-- RLS policies:
--   - `users`: visible if the caller has partner access to users.partner_id,
--     OR org access to users.org_id (if set), OR the row is the caller's
--     own user row (self-read via breeze.user_id GUC).
--   - `organization_users`: standard breeze_has_org_access(org_id).
--
-- Backfill algorithm (per row):
--   1. partner_users join: if a user has any partner_users rows, take the
--      first one and use its partner_id. Log (NOTICE) if the user has
--      multiple partner_users rows pointing at different partners.
--   2. organization_users join: if the user has any organization_users rows,
--      resolve the owning partner via organizations.partner_id. If the user
--      had BOTH partner_users and organization_users pointing at DIFFERENT
--      partners, log and keep the partner_users choice (per product
--      decision — the internal-org case is the only legitimate dual
--      membership, and that case has matching partners).
--   3. Users with no partner_users AND no organization_users are orphans
--      with no tenancy: raise an EXCEPTION and abort. The admin can then
--      either delete the row or assign it before retrying.
--
-- Fully idempotent: DROP POLICY IF EXISTS before CREATE, column adds are
-- guarded by IF NOT EXISTS, constraint adds run in DO blocks that catch
-- duplicate-object errors. Safe to re-run.

BEGIN;

-- ============================================================
-- 1. breeze_current_user_id() helper + session var setup
-- ============================================================
CREATE OR REPLACE FUNCTION public.breeze_current_user_id()
  RETURNS uuid
  LANGUAGE sql
  STABLE
AS $function$
  -- Returns NULL if breeze.user_id is unset or empty, otherwise casts
  -- to uuid. NULLIF handles the empty-string case from `set_config`
  -- when no user context has been established (system jobs, pre-auth
  -- paths, etc.). Comparison `users.id = breeze_current_user_id()`
  -- then naturally returns NULL → FALSE for those cases, so they don't
  -- spuriously match the self-read branch of the users RLS policy.
  SELECT NULLIF(current_setting('breeze.user_id', true), '')::uuid;
$function$;

-- ============================================================
-- 2. Column additions on users (nullable for now, NOT NULL after backfill)
-- ============================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_id uuid;
ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id uuid;

-- ============================================================
-- 3. Unique constraint on organizations(id, partner_id) to support the
--    composite FK from users. `id` is already unique so this doesn't
--    add a new tenancy invariant — it just declares the tuple that the
--    composite FK will reference.
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organizations_id_partner_uq'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_id_partner_uq UNIQUE (id, partner_id);
  END IF;
END $$;

-- ============================================================
-- 4. Backfill users.partner_id / users.org_id from junction tables
-- ============================================================
DO $$
DECLARE
  u record;
  pu_row record;
  ou_row record;
  resolved_partner_id uuid;
  resolved_org_id uuid;
  conflict_count int := 0;
  orphan_count int := 0;
BEGIN
  FOR u IN SELECT id, email FROM users WHERE partner_id IS NULL LOOP
    resolved_partner_id := NULL;
    resolved_org_id := NULL;

    -- Look up partner_users first (canonical source per product decision).
    SELECT partner_id INTO pu_row
      FROM partner_users
     WHERE user_id = u.id
     ORDER BY created_at
     LIMIT 1;
    IF FOUND THEN
      resolved_partner_id := pu_row.partner_id;
    END IF;

    -- Multiple partner_users rows pointing at different partners is a
    -- schema-drift warning. Log and keep the first.
    IF (SELECT count(DISTINCT partner_id) FROM partner_users WHERE user_id = u.id) > 1 THEN
      RAISE NOTICE '[users-rls backfill] user % (%) has partner_users rows pointing at multiple partners; keeping %',
        u.email, u.id, resolved_partner_id;
      conflict_count := conflict_count + 1;
    END IF;

    -- Look up the first organization_users row for org_id selection.
    SELECT ou.org_id, o.partner_id AS owning_partner_id
      INTO ou_row
      FROM organization_users ou
      JOIN organizations o ON o.id = ou.org_id
     WHERE ou.user_id = u.id
     ORDER BY ou.created_at
     LIMIT 1;

    IF FOUND THEN
      resolved_org_id := ou_row.org_id;

      -- If we didn't get a partner_id from partner_users, inherit it
      -- from the org's owning partner.
      IF resolved_partner_id IS NULL THEN
        resolved_partner_id := ou_row.owning_partner_id;
      ELSIF resolved_partner_id != ou_row.owning_partner_id THEN
        -- Conflict: partner_users says one thing, organization_users
        -- (via its owning partner) says another. Per product decision,
        -- partner_users wins. But the org_id we were about to set
        -- belongs to a DIFFERENT partner, so setting it would fail the
        -- composite FK. Clear org_id to NULL.
        RAISE NOTICE '[users-rls backfill] user % (%) is in partner_users(%) AND organization_users pointing at a different partner(%); keeping partner_users choice and clearing org_id',
          u.email, u.id, resolved_partner_id, ou_row.owning_partner_id;
        conflict_count := conflict_count + 1;
        resolved_org_id := NULL;
      END IF;
    END IF;

    -- Orphan check: no partner_users, no organization_users.
    IF resolved_partner_id IS NULL THEN
      RAISE EXCEPTION '[users-rls backfill] user % (%) has no partner_users and no organization_users rows — cannot determine tenancy. Delete the row or assign membership, then re-run the migration.',
        u.email, u.id;
    END IF;

    UPDATE users
       SET partner_id = resolved_partner_id,
           org_id = resolved_org_id
     WHERE id = u.id;
  END LOOP;

  IF conflict_count > 0 THEN
    RAISE NOTICE '[users-rls backfill] completed with % conflict(s) (see NOTICE output above)', conflict_count;
  END IF;
END $$;

-- ============================================================
-- 5. Tighten: partner_id NOT NULL
-- ============================================================
ALTER TABLE users ALTER COLUMN partner_id SET NOT NULL;

-- ============================================================
-- 6. Plain FK from users.partner_id → partners(id)
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_partner_id_partners_id_fk'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_partner_id_partners_id_fk
      FOREIGN KEY (partner_id) REFERENCES partners(id);
  END IF;
END $$;

-- ============================================================
-- 7. Composite FK: (users.org_id, users.partner_id) → organizations(id, partner_id)
--
--    This is the structural guarantee that `users.org_id`, when set,
--    always points at an org owned by the user's partner. Under MATCH
--    SIMPLE (the default), a NULL in any FK column skips the check
--    entirely — so MSP staff rows with org_id=NULL bypass this FK and
--    only the plain users_partner_id_partners_id_fk applies. Customer
--    org users with both columns set are validated on every insert
--    and update.
--
--    DEFERRABLE INITIALLY DEFERRED lets signup transactions insert
--    user→org→partner in any order within the tx.
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_org_partner_fk'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_org_partner_fk
      FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- ============================================================
-- 8. RLS on users
--
--    Visible if:
--      - caller has partner access to users.partner_id (partner admins
--        see every user in their MSP, including customer-org users), OR
--      - caller has org access to users.org_id (org members see fellow
--        org members), OR
--      - caller is this user (self-read via breeze.user_id GUC).
--
--    Writes mirror SELECT minus self-read (you don't insert yourself).
-- ============================================================
DROP POLICY IF EXISTS breeze_user_isolation_select ON users;
DROP POLICY IF EXISTS breeze_user_isolation_insert ON users;
DROP POLICY IF EXISTS breeze_user_isolation_update ON users;
DROP POLICY IF EXISTS breeze_user_isolation_delete ON users;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_user_isolation_select ON users
  FOR SELECT USING (
    public.breeze_has_partner_access(partner_id)
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR id = public.breeze_current_user_id()
  );
CREATE POLICY breeze_user_isolation_insert ON users
  FOR INSERT WITH CHECK (
    public.breeze_has_partner_access(partner_id)
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
  );
CREATE POLICY breeze_user_isolation_update ON users
  FOR UPDATE USING (
    public.breeze_has_partner_access(partner_id)
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR id = public.breeze_current_user_id()
  )
  WITH CHECK (
    public.breeze_has_partner_access(partner_id)
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR id = public.breeze_current_user_id()
  );
CREATE POLICY breeze_user_isolation_delete ON users
  FOR DELETE USING (
    public.breeze_has_partner_access(partner_id)
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
  );

-- ============================================================
-- 9. RLS on organization_users (standard org-keyed shape)
-- ============================================================
DROP POLICY IF EXISTS breeze_org_isolation_select ON organization_users;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON organization_users;
DROP POLICY IF EXISTS breeze_org_isolation_update ON organization_users;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON organization_users;

ALTER TABLE organization_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_users FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON organization_users
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON organization_users
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON organization_users
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON organization_users
  FOR DELETE USING (public.breeze_has_org_access(org_id));

COMMIT;
