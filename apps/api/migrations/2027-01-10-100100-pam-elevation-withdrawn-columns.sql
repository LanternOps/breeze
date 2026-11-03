-- #8971: columns and CHECKs for the 'withdrawn' elevation status added by
-- 2027-01-10-100000-pam-elevation-withdrawn-enum.sql.
--
--   withdrawn_at     - when the server recorded the end user's decline
--   withdrawn_reason - why: 'user_denied' (Deny), 'user_timeout' (the dialog
--                      ran out or the round trip timed out), 'dialog_error'
--                      (the dialog failed). Byte-identical to the route's
--                      zod enum and the agent's pamdecline constants.
--
-- This file exists because the enum value alone is not enough:
-- elevation_requests_status_timestamps_chk lists the statuses a row may take.
-- 'actuating' shipped on 2026-05-27 without widening that CHECK, which made
-- the approved -> actuating transition impossible until
-- 2026-09-16-pam-actuation-lifecycle.sql re-created it. The CHECK below copies
-- that file's five clauses verbatim and adds the withdrawn one.
--
-- The reason list is ONE named constraint, elevation_requests_withdrawn_reason_chk,
-- so a later reason (e.g. #10190 / #8928 "Use admin credentials") widens it by
-- dropping and re-adding this one clause.
--
-- elevation_requests is already RLS-covered by org_id. Nullable columns with no
-- default are metadata-only (no rewrite, no row writes, so no breeze.scope
-- election). Both CHECKs are validated when added, which scans the table once
-- under the migration's lock; every existing row has both columns NULL and a
-- status other than 'withdrawn', so it passes. Drop then re-add (not
-- duplicate_object swallowing) so a same-named constraint with another
-- definition is replaced on re-apply.

ALTER TABLE elevation_requests ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz;
ALTER TABLE elevation_requests ADD COLUMN IF NOT EXISTS withdrawn_reason varchar(32);

ALTER TABLE elevation_requests DROP CONSTRAINT IF EXISTS elevation_requests_withdrawn_reason_chk;
ALTER TABLE elevation_requests
  ADD CONSTRAINT elevation_requests_withdrawn_reason_chk CHECK (
    withdrawn_reason IS NULL
    OR withdrawn_reason IN ('user_denied', 'user_timeout', 'dialog_error')
  );

ALTER TABLE elevation_requests DROP CONSTRAINT IF EXISTS elevation_requests_status_timestamps_chk;
ALTER TABLE elevation_requests
  ADD CONSTRAINT elevation_requests_status_timestamps_chk CHECK (
    (status = 'pending')
    OR (status IN ('approved', 'auto_approved', 'actuating') AND approved_at IS NOT NULL)
    OR (status = 'denied' AND denial_reason IS NOT NULL)
    OR (status = 'expired' AND expired_at IS NOT NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
    OR (status = 'withdrawn' AND withdrawn_at IS NOT NULL AND withdrawn_reason IS NOT NULL)
  );
