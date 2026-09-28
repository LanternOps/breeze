-- Approval-security policy: let a partner leave the enforcement choice blank.
--
-- authenticator_policies.require_enrollment becomes nullable with no default:
--   NULL  = inherit the platform default (required for high/critical approvals
--           from the platform date, see config/env.ts
--           APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM)
--   true  = explicitly required (all tiers, from enforce_from)
--   false = explicitly not required
-- Existing rows keep their stored true/false value unchanged, so every choice
-- already saved stays an explicit choice. No rows are written here.
--
-- Idempotent: DROP NOT NULL / DROP DEFAULT are no-ops when already applied.

ALTER TABLE authenticator_policies ALTER COLUMN require_enrollment DROP NOT NULL;
ALTER TABLE authenticator_policies ALTER COLUMN require_enrollment DROP DEFAULT;
