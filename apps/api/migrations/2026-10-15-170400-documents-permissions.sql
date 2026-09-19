-- documents:read / documents:write (service deliverables W03, spec #5573 §10).
--
-- Grant predicate copies 2026-10-15-150500-accounting-dedicated-permissions.sql
-- exactly: `is_system = TRUE` is the anti-forgery filter (roles created through
-- routes/roles.ts are always is_system = FALSE), and there is NO `partner_id IS
-- NULL` clause because system roles are cloned per partner, so a template-only
-- grant would reach nobody on upgrade. Partner Admin holds '*:*' and needs no
-- row; NO custom role gains either permission automatically.
--
-- permissions has NO UNIQUE constraint on (resource, action) — only a PK on id —
-- so ON CONFLICT DO NOTHING has nothing to conflict against and would duplicate
-- on every re-apply. Explicit existence checks instead.
--
-- Every write runs under system scope: unscoped, an INSERT either matches zero
-- rows silently or aborts with 42501 (#4518).
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'documents' AND action = 'read') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('documents', 'read', 'View the organization document library and download documents');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN RAISE WARNING 'seeded documents:read permission row'; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'documents' AND action = 'write') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('documents', 'write', 'Upload, replace, edit, and delete organization documents');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN RAISE WARNING 'seeded documents:write permission row'; END IF;
  END IF;
END $$;

DO $$
DECLARE
  n integer;
  v_perm uuid;
  v_action text;
  v_role text;
BEGIN
  FOREACH v_action IN ARRAY ARRAY['read','write'] LOOP
    SELECT id INTO v_perm FROM permissions
    WHERE resource = 'documents' AND action = v_action ORDER BY id LIMIT 1;

    FOREACH v_role IN ARRAY ARRAY['Partner Technician','Org Admin','Org Technician'] LOOP
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, v_perm
      FROM roles r
      WHERE r.name = v_role
        AND r.is_system = TRUE
        AND v_perm IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM role_permissions rp
          WHERE rp.role_id = r.id AND rp.permission_id = v_perm
        );
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN
        RAISE WARNING 'granted documents:% to % existing % role(s)', v_action, n, v_role;
      END IF;
    END LOOP;
  END LOOP;
END $$;
