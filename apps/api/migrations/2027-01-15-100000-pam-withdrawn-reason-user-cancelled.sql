-- #10190 W07 (#10221): widen elevation_requests_withdrawn_reason_chk with
-- 'user_cancelled'.
--
--   user_cancelled - the end user handed the request to IT, then chose
--                    "Cancel request" on the waiting card (Breeze Assist or the
--                    native fallback). The agent records the decline locally
--                    (pamdecline.ReasonUserCancelled) and withdraws the request.
--
-- The list is byte-identical to PAM_WITHDRAW_REASONS
-- (apps/api/src/db/schema/elevations.ts) and the agent's pamdecline Reason
-- constants. The three existing values are copied verbatim from
-- 2027-01-10-100100-pam-elevation-withdrawn-columns.sql (#8971 PR A), which
-- made the reason list this one named constraint so it could be widened by a
-- drop and re-add of that clause alone.
--
-- DDL only: no rows written, so no breeze.scope election. Re-adding the CHECK
-- validates it with one scan of elevation_requests under the migration's lock;
-- every existing reason is in the old list, which this list contains. Drop then
-- re-add (not duplicate_object swallowing) so a re-apply is a no-op and a
-- same-named constraint with another definition is replaced.

ALTER TABLE elevation_requests DROP CONSTRAINT IF EXISTS elevation_requests_withdrawn_reason_chk;
ALTER TABLE elevation_requests
  ADD CONSTRAINT elevation_requests_withdrawn_reason_chk CHECK (
    withdrawn_reason IS NULL
    OR withdrawn_reason IN ('user_denied', 'user_timeout', 'dialog_error', 'user_cancelled')
  );
