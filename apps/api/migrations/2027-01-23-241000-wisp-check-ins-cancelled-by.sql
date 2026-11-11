-- Wisp standing state: who cancelled a check-in (#11611).
--
-- The per-turn <wisp_standing_state> block tells Wisp what the user did to
-- its check-ins and concerns, so it can say "you cancelled that check-in at
-- 14:05" instead of guessing. A cancelled row could not say who cancelled
-- it: cancel_reason is set only when Breeze cancels, and is NULL for both a
-- user's cancel (the chip's ×, DELETE /wisp/thread/:id/check-ins/:checkInId)
-- and Wisp's own (the cancel_check_in tool).
--
--   cancelled_by  'user'   the grantor, from the thread's check-in chip
--                 'wisp'   Wisp, with the cancel_check_in tool
--                 'breeze' Breeze, with cancel_reason saying why
--                 NULL     not cancelled, or cancelled before this column
--
-- Existing rows are left NULL (no backfill): an old cancel is unattributed,
-- never misattributed. The file writes no rows; system scope is elected
-- first anyway, per the migrations README.
--
-- Tenancy is unchanged: shape 3, forced, wisp_check_ins_isolation
-- (2027-01-20-130000-wisp-check-ins.sql). Cascade and merge are table-level
-- and unchanged; the column is `included` in CORE_TENANT_EXPORT_POLICY (it is
-- not json/jsonb/bytea). No device or ticket column is added.
--
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file).

SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE wisp_check_ins ADD COLUMN IF NOT EXISTS cancelled_by text NULL;

-- Mirrors WispCheckInCancelledBy in db/schema/wispCheckIns.ts; change them together.
ALTER TABLE wisp_check_ins DROP CONSTRAINT IF EXISTS wisp_check_ins_cancelled_by_chk;
ALTER TABLE wisp_check_ins ADD CONSTRAINT wisp_check_ins_cancelled_by_chk CHECK (cancelled_by IS NULL OR cancelled_by IN ('user','wisp','breeze'));

-- No new index: the standing state's read of a grant's recent user cancels
-- (at most once a minute per grant, the facts cache) is served by
-- wisp_check_ins_grant_status_idx (grant_id, status).
