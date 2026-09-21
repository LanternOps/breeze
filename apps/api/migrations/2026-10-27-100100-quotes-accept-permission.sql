-- quotes:accept back-fill (spec 2026-09-21 §7). The new permission gates
-- POST /quotes/:id/accept-on-behalf, which numbers and issues an invoice.
--
-- THIS MIGRATION GRANTS NO NEW AUTHORITY. It re-issues, under a new name, a
-- capability every matched role already has: anyone who could SEND a quote
-- could already put it in front of a customer to accept. Matching is therefore
-- on the EXISTING GRANT, never on a role's name — it sweeps system role
-- templates, per-partner is_system clones AND custom (is_system = FALSE) roles
-- alike, exactly like 2026-10-16-190000-agreements-permission.sql. Scoping it
-- to is_system roles would silently strip the action from every partner who
-- built their own "Sales" role. A custom role cannot be forged into extra
-- privilege here, because the predicate IS the privilege it already holds.
-- Partners who want acceptance narrower than sending revoke it afterwards.
--
-- WILDCARDS NEED NO BACK-FILL. Grant matching is per-axis
-- (services/permissionMatching.ts), so the seeded Partner Admin's single '*:*'
-- row already satisfies quotes:accept at runtime. The defensive
-- ('quotes','*') lookup below is expected to be NULL on every real database
-- and says so loudly if it ever is not.
--
-- NOTE: `permissions` has NO UNIQUE constraint on (resource, action) — only a
-- primary key on id. A conflict-target upsert clause would have nothing to
-- target and would add a duplicate row on every re-apply. Explicit existence
-- check instead.
--
-- NOTE: `role_permissions` IS PRIMARY KEY (role_id, permission_id), so the
-- back-fill uses SELECT DISTINCT even though only one source grant feeds it —
-- cheap, and correct if a second source is ever added.
--
-- System scope first: every write below would otherwise abort with 42501 on a
-- connection that does not bypass RLS (#4518). is_local = true scopes it to
-- autoMigrate's per-file transaction.
SELECT set_config('breeze.scope', 'system', true);

-- ============================================
-- 1. The permission row
-- ============================================
-- The description is normative and MUST stay byte-identical to
-- DEFAULT_PERMISSIONS in apps/api/src/db/seed.ts.
DO $$
DECLARE n integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE resource = 'quotes' AND action = 'accept'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('quotes', 'accept', 'Record a customer acceptance on their behalf and convert the quote to an invoice');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE WARNING 'seeded quotes:accept permission row';
    END IF;
  END IF;
END $$;

-- ============================================
-- 2. No-regression back-fill
-- ============================================
DO $$
DECLARE
  n integer;
  v_accept_id uuid;
  v_send_id uuid;
  v_quotes_any_id uuid;
BEGIN
  -- Scalar lookups (not JOINs), so this stays correct even if a duplicate
  -- permissions row were ever present — always exactly one id.
  SELECT id INTO v_accept_id FROM permissions
  WHERE resource = 'quotes' AND action = 'accept' ORDER BY id LIMIT 1;

  SELECT id INTO v_send_id FROM permissions
  WHERE resource = 'quotes' AND action = 'send' ORDER BY id LIMIT 1;

  SELECT id INTO v_quotes_any_id FROM permissions
  WHERE resource = 'quotes' AND action = '*' ORDER BY id LIMIT 1;

  IF v_quotes_any_id IS NOT NULL THEN
    RAISE WARNING 'unexpected quotes:* wildcard permission row present — including it in the quotes:accept back-fill';
  END IF;

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, v_accept_id
  FROM role_permissions rp
  WHERE rp.permission_id IN (v_send_id, v_quotes_any_id)
    AND v_accept_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions existing
      WHERE existing.role_id = rp.role_id AND existing.permission_id = v_accept_id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  -- Always report, including 0: a 0 on a fresh install is expected, not
  -- evidence the INSERT silently no-op'd under RLS.
  RAISE WARNING 'granted quotes:accept to % role(s) holding quotes:send', n;
END $$;
