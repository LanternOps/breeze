-- #5306: MFA enrolment grace window for role-forced (roles.force_mfa) users.
--
-- Before this, enforcement of a `force_mfa` role was binary: the user was
-- bounced into /auth/mfa/setup on the very next request, and the only relief
-- was the global MFA_FORCE_FOR_PARTNER_ADMIN kill switch. These four columns
-- turn that into a per-user, nonrenewable grant with a persisted deadline.
--
--   mfa_enrollment_deadline        the granted deadline. Written EXACTLY ONCE
--                                 (services/mfaEnrollmentGrace.ts grants only
--                                 `WHERE mfa_enrollment_deadline IS NULL`), so
--                                 a grant can never be renewed, reopened or
--                                 extended — an admin factor reset leaves the
--                                 past deadline in place and therefore keeps
--                                 today's immediate re-enrollment contract.
--   mfa_enrollment_grace_granted_at
--                                 when the grant was made. The effective
--                                 deadline is min(deadline, granted_at +
--                                 partner security.mfaEnrollmentGraceDays), so
--                                 a partner can SHORTEN an in-flight window by
--                                 lowering the setting but never lengthen it.
--   mfa_enrollment_notice_sent_at  claim stamp for the "enrol by <date>" email,
--   mfa_enrollment_reminded_at     claim stamp for the T-3 reminder. Both are
--                                 written only AFTER a successful send by the
--                                 daily sweep (jobs/mfaEnrollmentNotice.ts) so
--                                 a failed send retries the next day instead of
--                                 being permanently suppressed.
--
-- `users` is already registered in CORE_ORG_CASCADE_DELETE_ORDER and carries
-- dual-axis RLS, so no cascade/RLS registration changes apply — but all four
-- columns DO need CORE_TENANT_EXPORT_POLICY entries (the export-policy contract
-- fires on a new COLUMN of an already-registered org-cascade table). They are
-- classified `reviewedIncluded`: 'mfa' is in SUSPICIOUS_NAME_PARTS, and these
-- are plain timestamps, not credential material.
--
-- Additive and nullable: an API rollback leaves the columns inert and an older
-- API never reads them. Idempotent (ADD COLUMN IF NOT EXISTS). Writes no rows,
-- so no breeze.scope election is needed. No inner BEGIN/COMMIT.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_enrollment_deadline timestamptz;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_enrollment_grace_granted_at timestamptz;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_enrollment_notice_sent_at timestamptz;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_enrollment_reminded_at timestamptz;

-- The daily notice sweep scans only users that hold a grant, which is a small
-- minority of the table; a partial index keeps that scan off the full users
-- heap. Predicate is static (constant NOT NULL test), so it stays promotable.
CREATE INDEX IF NOT EXISTS users_mfa_enrollment_deadline_idx
  ON users (mfa_enrollment_deadline)
  WHERE mfa_enrollment_deadline IS NOT NULL;
