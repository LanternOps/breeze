-- tickets:record_approval back-fill (#4617 spec §6.5). The new permission gates
-- recording a customer's approval or denial of held ticket work on their
-- behalf (staff on-behalf decision, W02/W03).
--
-- THIS MIGRATION GRANTS NO NEW AUTHORITY to any role that could not already
-- manage tickets: it is back-filled to every role holding tickets:manage,
-- matched on the EXISTING GRANT, never on a role's name — so system role
-- templates, per-partner is_system clones AND custom (is_system = FALSE) roles
-- are swept alike, exactly as 2026-10-27-100100-quotes-accept-permission.sql.
-- A custom role cannot be forged into extra privilege here, because the
-- predicate IS the privilege it already holds. Partners who want recording
-- narrower than ticket management revoke it afterwards.
--
-- WILDCARDS NEED NO BACK-FILL. Grant matching is per-axis
-- (services/permissionMatching.ts), so a '*:*' row already satisfies
-- tickets:record_approval at runtime. The defensive ('tickets','*') lookup
-- below is expected to be NULL on every real database and says so if not.
--
-- NOTE: `permissions` has NO UNIQUE constraint on (resource, action), so an
-- explicit existence check is used instead of a conflict-target upsert.
-- NOTE: `role_permissions` IS PRIMARY KEY (role_id, permission_id); the
-- back-fill uses SELECT DISTINCT plus NOT EXISTS so a re-apply is a no-op.
--
-- System scope first: every write below would otherwise abort with 42501 on a
-- connection that does not bypass RLS (#4518).
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
    SELECT 1 FROM permissions WHERE resource = 'tickets' AND action = 'record_approval'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('tickets', 'record_approval', 'Record a customer approval or denial of held ticket work on their behalf');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE WARNING 'seeded tickets:record_approval permission row';
    END IF;
  END IF;
END $$;

-- ============================================
-- 2. No-regression back-fill
-- ============================================
DO $$
DECLARE
  n integer;
  v_record_id uuid;
  v_manage_id uuid;
  v_tickets_any_id uuid;
BEGIN
  SELECT id INTO v_record_id FROM permissions
  WHERE resource = 'tickets' AND action = 'record_approval' ORDER BY id LIMIT 1;

  SELECT id INTO v_manage_id FROM permissions
  WHERE resource = 'tickets' AND action = 'manage' ORDER BY id LIMIT 1;

  SELECT id INTO v_tickets_any_id FROM permissions
  WHERE resource = 'tickets' AND action = '*' ORDER BY id LIMIT 1;

  IF v_tickets_any_id IS NOT NULL THEN
    RAISE WARNING 'unexpected tickets:* wildcard permission row present — including it in the tickets:record_approval back-fill';
  END IF;

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, v_record_id
  FROM role_permissions rp
  WHERE rp.permission_id IN (v_manage_id, v_tickets_any_id)
    AND v_record_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions existing
      WHERE existing.role_id = rp.role_id AND existing.permission_id = v_record_id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  -- Always report, including 0: a 0 on a fresh install is expected, not
  -- evidence the INSERT silently no-op'd under RLS.
  RAISE WARNING 'granted tickets:record_approval to % role(s) holding tickets:manage', n;
END $$;
