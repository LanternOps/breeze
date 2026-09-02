-- RMM-QA-164: reconcile force_mfa on every SYSTEM Partner Admin role.
--
-- 2026-05-25-f-role-force-mfa.sql promised force_mfa = true for the system
-- Partner Admin role, but its UPDATE only touched rows that existed when it
-- ran. autoMigrate applies migrations BEFORE the initial seed() on a fresh
-- database, so the seeded global template stored false; createPartner()
-- inserted every tenant copy without the flag, so those stored false too.
-- The seed and createPartner() now write the flag themselves; this
-- migration fixes forward the rows already on installed databases.
--
-- Scope: the global template (partner_id IS NULL) AND every tenant copy
-- (partner_id set). Custom roles (is_system = false) that happen to share
-- the name are excluded by construction — a user-chosen name is not
-- security policy. Org Admin and the other system roles stay opt-in.
--
-- Side effect (intended): each flipped row fires
-- breeze_roles_permissions_epoch (2026-08-06-b), bumping permissions_epoch
-- for that role's members once. Every Partner Admin without an enrolled
-- factor then receives 428 mfa_enrollment_required on their next
-- non-exempt request until they enrol at /auth/mfa/setup. Relief valve:
-- MFA_FORCE_FOR_PARTNER_ADMIN=false (suppresses only the role-force
-- component; settings-driven requireMfa stays enforced).
--
-- Idempotent: the force_mfa = false predicate makes re-application a no-op.
-- The row count is always logged (a zero is evidence too).

DO $$
DECLARE n integer;
BEGIN
  UPDATE roles
  SET force_mfa = true
  WHERE scope = 'partner'
    AND name = 'Partner Admin'
    AND is_system = true
    AND force_mfa = false;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'partner-admin force_mfa reconcile: flipped % system Partner Admin role(s) to force_mfa=true', n;
  ELSE
    RAISE NOTICE 'partner-admin force_mfa reconcile: 0 rows needed flipping';
  END IF;
END $$;
