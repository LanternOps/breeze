-- Adds roles.force_mfa flag so privileged roles can mandate MFA enrollment
-- at the role level (not per-route). Cyber-insurance baseline requires
-- "MFA enforced on admin accounts" — the auth middleware now returns
-- 428 Precondition Required for users in a force_mfa=true role who
-- haven't enabled MFA, until they complete enrollment.
--
-- Seeded true for the only system-defined privileged role today
-- ("Partner Admin" / is_system=true). The other system roles
-- (Org Admin, Partner Technician, etc.) intentionally stay false here
-- and can be opted in per-deployment by an MSP if they want stricter
-- requirements; flipping defaults for those will be a follow-up once
-- we have a UI for it. There's no separate "System Admin" or
-- "Platform Admin" role in this codebase — platform admin is a flag
-- on users.is_platform_admin, not a role.
--
-- Idempotent: re-applying is a no-op.

ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS force_mfa boolean NOT NULL DEFAULT false;

UPDATE roles
SET force_mfa = true
WHERE name = 'Partner Admin'
  AND is_system = true
  AND force_mfa = false;
