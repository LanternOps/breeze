-- Dedicated agreements:read / agreements:write permissions for the agreement
-- template library and signed agreements, replacing the contracts:read /
-- contracts:write grants those surfaces used to ride on (agreements vocabulary
-- and IA split, spec §4). A billing contract and the MSA a customer signs are
-- different objects with different audiences: an MSP may want a technician who
-- can pull up a signed MSA without touching recurring billing, and a billing
-- clerk who runs contracts without authoring legal terms.
--
-- THE GUARDS FLIP IN THE SAME PR. routes/contracts/templates.ts and
-- documents.ts switch to AGREEMENTS_* with NO transitional
-- `contracts:* OR agreements:*` check, so the back-fill below is the ONLY
-- thing standing between an upgrade and a fleet-wide 403 on the template
-- library. It has to be exhaustive.
--
-- HOW THIS DIFFERS FROM 2026-10-15-150200-pam-dedicated-permissions.sql, the
-- file it is modelled on. That migration matched roles on
-- `r.name = 'Org Admin' AND r.scope = 'organization' AND r.is_system = TRUE`,
-- because it was GRANTING NEW AUTHORITY nobody held before (approve
-- elevations, author PAM rules): `is_system = TRUE` was the anti-forgery
-- filter stopping an attacker-created role merely NAMED "Org Admin" from
-- picking up PAM power.
--
-- This migration is the opposite shape and is deliberately BROADER. It grants
-- NO new authority: it re-issues, under a new name, exactly the capability a
-- role already holds. So it matches on the EXISTING GRANT, never on the role's
-- name, and it sweeps system role templates, per-partner is_system clones AND
-- CUSTOM (is_system = FALSE) roles alike. Scoping it to is_system roles would
-- silently strip the template library from every partner who built a custom
-- "Billing Clerk" role — exactly the no-regression rule in spec §4: nobody who
-- could reach the template library yesterday loses it today. A custom role
-- cannot be forged into extra privilege here, because the predicate IS the
-- privilege it already has.
--
-- Mapping is ACTION-FOR-ACTION. contracts:write -> agreements:write;
-- contracts:read OR contracts:write -> agreements:read. contracts:manage is
-- NOT a source for agreements:write: manage is a lifecycle verb on a billing
-- contract (activate/pause/resume/cancel/generate) and says nothing about
-- authoring legal text, so inferring write from it would grant authority the
-- role never had. contracts:write feeds the READ back-fill so that a role
-- granted agreements:write can actually list what it may edit.
--
-- WILDCARDS NEED NO BACK-FILL. Grant matching is per-axis
-- (services/permissionMatching.ts:14-23: `grant.resource === resource ||
-- grant.resource === '*'`), so the seeded Partner Admin's single '*:*' row
-- (db/seed.ts:263) already satisfies agreements:read and agreements:write at
-- runtime with no row of its own. A resource-wildcard row ('contracts','*')
-- does not exist in the registry or DEFAULT_PERMISSIONS, and routes/roles.ts:291
-- rejects any wildcard on a custom role — but the defensive third insert below
-- covers one anyway and reports loudly if it ever fires.
--
-- Idempotent: safe to re-run. permissions.id defaults to gen_random_uuid() at
-- the DB level (0001-baseline.sql), so no id is supplied on insert.
--
-- NOTE: `permissions` has NO UNIQUE constraint on (resource, action) — only a
-- primary key on id. `ON CONFLICT DO NOTHING` would therefore have nothing to
-- conflict against and would silently insert a duplicate on every re-apply.
-- Use an explicit existence check, matching the PAM file.
--
-- NOTE: `role_permissions` DOES have PRIMARY KEY (role_id, permission_id)
-- (2026-06-20-role-permissions-unique.sql:44). The read back-fill therefore
-- needs SELECT DISTINCT: a role holding BOTH contracts:read and contracts:write
-- matches the predicate twice and would abort the migration with 23505.
--
-- Every write in this file runs under system scope: on a connection that does
-- not bypass RLS an INSERT with no scope elected aborts with 42501 (issue
-- #4518). One set_config at the top covers the whole file — is_local = true
-- scopes it to autoMigrate's per-file transaction.
SELECT set_config('breeze.scope', 'system', true);

-- ============================================
-- 1. The two permission rows
-- ============================================
-- Descriptions are normative (spec §4) and MUST stay byte-identical to
-- DEFAULT_PERMISSIONS in apps/api/src/db/seed.ts — a fresh install seeds from
-- there, an upgrade from here, and a divergence means two databases disagree
-- about what the permission claims to do.
DO $$
DECLARE
  n integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE resource = 'agreements' AND action = 'read'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('agreements', 'read', 'View agreement templates and signed agreements');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE WARNING 'seeded agreements:read permission row';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE resource = 'agreements' AND action = 'write'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('agreements', 'write', 'Create, edit, publish and archive agreement templates; link signed agreements');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE WARNING 'seeded agreements:write permission row';
    END IF;
  END IF;
END $$;

-- ============================================
-- 2. No-regression back-fill
-- ============================================
DO $$
DECLARE
  n integer;
  v_read_id uuid;
  v_write_id uuid;
  v_contracts_read_id uuid;
  v_contracts_write_id uuid;
  v_contracts_any_id uuid;
BEGIN
  -- Scalar lookups (not JOINs) so this stays correct even if a duplicate
  -- permissions row were ever present — always resolves to exactly one id.
  SELECT id INTO v_read_id FROM permissions
  WHERE resource = 'agreements' AND action = 'read' ORDER BY id LIMIT 1;

  SELECT id INTO v_write_id FROM permissions
  WHERE resource = 'agreements' AND action = 'write' ORDER BY id LIMIT 1;

  SELECT id INTO v_contracts_read_id FROM permissions
  WHERE resource = 'contracts' AND action = 'read' ORDER BY id LIMIT 1;

  SELECT id INTO v_contracts_write_id FROM permissions
  WHERE resource = 'contracts' AND action = 'write' ORDER BY id LIMIT 1;

  -- Defensive: a resource-wildcard row. Expected to be NULL on every real
  -- database (see the header). If it is ever non-NULL the two inserts below
  -- pick it up and the row counts say so.
  SELECT id INTO v_contracts_any_id FROM permissions
  WHERE resource = 'contracts' AND action = '*' ORDER BY id LIMIT 1;

  IF v_contracts_any_id IS NOT NULL THEN
    RAISE WARNING 'unexpected contracts:* wildcard permission row present — including it in the agreements back-fill';
  END IF;

  -- 2a. contracts:write -> agreements:write.
  -- Matched on the GRANT, not the role name: system templates, per-partner
  -- is_system clones and custom roles all qualify.
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, v_write_id
  FROM role_permissions rp
  WHERE rp.permission_id IN (v_contracts_write_id, v_contracts_any_id)
    AND v_write_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions existing
      WHERE existing.role_id = rp.role_id AND existing.permission_id = v_write_id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  -- Always report, including 0: a 0 on a fresh install is expected, not
  -- evidence the INSERT silently no-op'd under RLS.
  RAISE WARNING 'granted agreements:write to % role(s) holding contracts:write', n;

  -- 2b. contracts:read OR contracts:write -> agreements:read.
  -- DISTINCT is load-bearing: role_permissions is PK (role_id, permission_id),
  -- and a role holding both source grants matches this predicate twice.
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, v_read_id
  FROM role_permissions rp
  WHERE rp.permission_id IN (v_contracts_read_id, v_contracts_write_id, v_contracts_any_id)
    AND v_read_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions existing
      WHERE existing.role_id = rp.role_id AND existing.permission_id = v_read_id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'granted agreements:read to % role(s) holding contracts:read or contracts:write', n;
END $$;
