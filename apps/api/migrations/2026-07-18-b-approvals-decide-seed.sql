-- Seed approvals:decide permission and grant it to existing Org Admin roles.
--
-- Without this, already-deployed orgs have zero eligible approvers for
-- Tier-3 chat action-intents: the approval-eligibility check finds no role
-- holding approvals:decide, so every Tier-3 intent instantly cancels with
-- reason 'no_eligible_approvers'.
--
-- Partner Admin already holds the wildcard '*:*' permission, so it needs no
-- explicit row here. Org Admin roles are seeded per-partner (one row per
-- partner), so this must sweep ALL of them, not a single row.
--
-- Idempotent: safe to re-run. permissions.id defaults to gen_random_uuid()
-- at the DB level (see 0001-baseline.sql), so no id is supplied on insert.
--
-- NOTE: permissions has no UNIQUE constraint on (resource, action) — only a
-- primary key on id (verified against the live schema). `ON CONFLICT DO
-- NOTHING` with no matching unique/exclusion constraint is NOT a no-op guard
-- here (there is nothing for it to conflict against), so it would silently
-- insert a duplicate row on every re-apply. Use an explicit existence check
-- instead, matching the established pattern in
-- 2026-05-02-report-permissions.sql.

DO $$
DECLARE
  n integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE resource = 'approvals' AND action = 'decide'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('approvals', 'decide', 'Decide (approve/deny) pending action-intent approvals');
    GET DIAGNOSTICS n = ROW_COUNT;
  END IF;

  IF n > 0 THEN
    RAISE WARNING 'seeded % approvals:decide permission row(s)', n;
  END IF;
END $$;

DO $$
DECLARE
  n integer;
  v_permission_id uuid;
BEGIN
  -- Scalar lookup (not a JOIN) so this stays correct even if a duplicate
  -- permissions row were ever present — always resolves to exactly one id.
  SELECT id INTO v_permission_id
  FROM permissions
  WHERE resource = 'approvals' AND action = 'decide'
  ORDER BY id
  LIMIT 1;

  -- is_system = TRUE is LOAD-BEARING, not cosmetic: custom org roles accept an
  -- arbitrary caller-supplied name (routes/roles.ts POST creates them with
  -- is_system = false), so matching on name alone would silently grant this
  -- security-sensitive permission to any attacker-created role named
  -- 'Org Admin'. Only the built-in per-partner Org Admin roles carry
  -- is_system = TRUE. Mirrors the established pattern in
  -- 2026-06-29-vuln-risk-accept-permission.sql.
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, v_permission_id
  FROM roles r
  WHERE r.name = 'Org Admin'
    AND r.scope = 'organization'
    AND r.is_system = TRUE
    AND v_permission_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = v_permission_id
    );

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'granted approvals:decide to % existing Org Admin role(s)', n;
  END IF;
END $$;
