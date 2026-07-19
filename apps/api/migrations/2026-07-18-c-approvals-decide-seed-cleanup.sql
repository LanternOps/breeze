-- Cleanup for the approvals:decide seed (2026-07-18-b): an earlier revision of
-- that migration granted approvals:decide to EVERY organization-scoped role
-- named 'Org Admin', including custom (is_system = false) roles. Because
-- routes/roles.ts POST lets a caller with users:write create a custom role
-- with an arbitrary name, a role named 'Org Admin' could have been minted
-- specifically to catch this grant and join the Tier-3 approver pool.
--
-- 2026-07-18-b has since been corrected to require is_system = TRUE, but
-- breeze_migrations keys on filename, so the corrected file will NOT re-run on
-- any database that already applied the buggy version. This forward migration
-- REVOKEs the erroneous grant from every non-system role so already-migrated
-- databases converge on the intended state.
--
-- Forensic trail (per the migration conventions): the DELETE reports its row
-- count as a WARNING even when 0, so a non-zero count is a durable record that
-- a custom role had been granted the permission.
--
-- Idempotent: re-running finds nothing left to delete and warns 0.

DO $$
DECLARE
  n integer;
BEGIN
  DELETE FROM role_permissions rp
  USING roles r, permissions p
  WHERE rp.role_id = r.id
    AND rp.permission_id = p.id
    AND p.resource = 'approvals'
    AND p.action = 'decide'
    AND r.name = 'Org Admin'
    AND r.scope = 'organization'
    AND r.is_system = FALSE;

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'approvals-decide-cleanup: revoked approvals:decide from % non-system Org Admin role(s)', n;
  END IF;
END $$;
