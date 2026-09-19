-- Dedicated accounting:read / accounting:manage permissions for the
-- QuickBooks integration routes (SEC-2026-09-05-057, owner decision Option A).
--
-- Before this change, every interactive accounting route gated only on
-- partner/organization authority: there was no accounting permission at all,
-- so any full-partner member — however low their role — could read the shared
-- provider realm (status, customers, entity mappings, income accounts, remote
-- candidates) and, with MFA, reach realm lifecycle and settings mutations
-- (connect, disconnect, settings update/refresh, mapping writes, provider and
-- mapping synchronization, reconcile triggers).
--
-- Grant predicate: copies 2026-10-15-150200-pam-dedicated-permissions.sql
-- exactly. `r.name = 'Org Admin' AND r.scope = 'organization' AND
-- r.is_system = TRUE`, with NO `partner_id IS NULL` clause: per-partner
-- `is_system` Org Admin clones exist in production (Org Admin roles are seeded
-- per-partner, one row per partner), so a global-template-only grant would
-- reach nobody on upgrade. `is_system = TRUE` is the anti-forgery filter —
-- custom roles created via routes/roles.ts are always `is_system = FALSE`, so
-- this can never grant accounting authority to an attacker-created role merely
-- named "Org Admin".
--
-- Partner Admin already holds the wildcard '*:*' permission, so it needs no
-- explicit row here — and since the accounting routes are partner-scope only
-- (requireScope('partner','system')), Partner Admin is in practice the only
-- built-in role that can exercise these permissions today. The Org Admin grant
-- mirrors the 150200 predicate so the two permission families stay
-- operationally identical, and so an org-scoped accounting surface added later
-- inherits the same default. NO other built-in role and NO custom role gains
-- either permission automatically: an operator who relied on a low-privilege
-- partner role reaching QuickBooks must grant these explicitly after upgrade.
--
-- Idempotent: safe to re-run. permissions.id defaults to gen_random_uuid() at
-- the DB level (0001-baseline.sql), so no id is supplied on insert.
--
-- NOTE: permissions has NO UNIQUE constraint on (resource, action) — only a
-- primary key on id. `ON CONFLICT DO NOTHING` therefore has nothing to
-- conflict against and would silently insert a duplicate on every re-apply.
-- Use an explicit existence check, matching 150200.
--
-- Every write in this file runs under system scope: on a connection that does
-- not bypass RLS, an UPDATE/INSERT with no scope elected either matches zero
-- rows silently or aborts with 42501 (issue #4518). One `set_config` at the
-- top of the file covers the whole migration — `is_local = true` scopes it to
-- autoMigrate's per-file transaction.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE resource = 'accounting' AND action = 'read'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('accounting', 'read', 'Read accounting provider status, customers, mappings, and income accounts');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE WARNING 'seeded accounting:read permission row';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE resource = 'accounting' AND action = 'manage'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('accounting', 'manage', 'Connect, disconnect, configure, and synchronize accounting provider integrations');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE WARNING 'seeded accounting:manage permission row';
    END IF;
  END IF;
END $$;

DO $$
DECLARE
  n integer;
  v_read_id uuid;
  v_manage_id uuid;
BEGIN
  -- Scalar lookups (not JOINs) so this stays correct even if a duplicate
  -- permissions row were ever present — always resolves to exactly one id.
  SELECT id INTO v_read_id FROM permissions
  WHERE resource = 'accounting' AND action = 'read' ORDER BY id LIMIT 1;

  SELECT id INTO v_manage_id FROM permissions
  WHERE resource = 'accounting' AND action = 'manage' ORDER BY id LIMIT 1;

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, v_read_id
  FROM roles r
  WHERE r.name = 'Org Admin'
    AND r.scope = 'organization'
    AND r.is_system = TRUE
    AND v_read_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = v_read_id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'granted accounting:read to % existing Org Admin role(s)', n;
  END IF;

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, v_manage_id
  FROM roles r
  WHERE r.name = 'Org Admin'
    AND r.scope = 'organization'
    AND r.is_system = TRUE
    AND v_manage_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = v_manage_id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'granted accounting:manage to % existing Org Admin role(s)', n;
  END IF;
END $$;
