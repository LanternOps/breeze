-- Wisp event check-ins W04 (#11493, feature #11489; #10410 wave A, spec
-- 2026-11-06-wisp-chat-grant-followups §6.2 A). A check-in may wait for an
-- event instead of a time: a device coming online, a script execution or a
-- device command finishing, or an agent run settling.
--
--   trigger_kind        'time' (every Phase 1 row) or the event kind.
--   trigger_subject_id  the device / script execution / device command /
--                       agent run the event is about. A provenance pointer
--                       with NO FK: a deleted subject is a fire-time
--                       condition (the row is cancelled with a reason), not a
--                       constraint.
--   fire_reason         why it fired: 'due' (a time row), 'event' or
--                       'deadline'. Written FIRST, as the fire claim, so
--                       exactly one reason wins the event / tick / deadline
--                       race (services/wisp/checkIns.ts fireCheckIn).
--   cancel_reason       why Breeze cancelled it (grant_inactive,
--                       thread_mismatch, grantor_changed, subject_deleted,
--                       outside_ceiling); NULL when Wisp or the user did.
--
-- No deadline column: for an event row, due_at IS the deadline (default
-- 24 h, at most 7 days, inside the existing wisp_check_ins_due_window_chk).
-- The delayed `check-in` job and the orphan reconcile already fire at due_at.
--
-- Tenancy is unchanged: shape 3, forced, wisp_check_ins_isolation
-- (2027-01-20-130000-wisp-check-ins.sql). Cascade and merge are table-level
-- and unchanged; the four columns are `included` in CORE_TENANT_EXPORT_POLICY
-- (none is json/jsonb/bytea). No device or ticket column is added.
--
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file). The file
-- writes no rows (the NOT NULL DEFAULT fills existing rows with 'time');
-- system scope is elected first anyway, per the migrations README.

SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE wisp_check_ins ADD COLUMN IF NOT EXISTS trigger_kind text NOT NULL DEFAULT 'time';
ALTER TABLE wisp_check_ins ADD COLUMN IF NOT EXISTS trigger_subject_id uuid NULL;
ALTER TABLE wisp_check_ins ADD COLUMN IF NOT EXISTS fire_reason text NULL;
ALTER TABLE wisp_check_ins ADD COLUMN IF NOT EXISTS cancel_reason text NULL;

-- Mirrors WISP_CHECK_IN_TRIGGER_KINDS in @breeze/shared; change them together.
ALTER TABLE wisp_check_ins DROP CONSTRAINT IF EXISTS wisp_check_ins_trigger_kind_chk;
ALTER TABLE wisp_check_ins ADD CONSTRAINT wisp_check_ins_trigger_kind_chk CHECK (trigger_kind IN ('time','device_online','script_finished','command_finished','run_settled'));

-- A time row names no subject; an event row always names one.
ALTER TABLE wisp_check_ins DROP CONSTRAINT IF EXISTS wisp_check_ins_trigger_shape_chk;
ALTER TABLE wisp_check_ins ADD CONSTRAINT wisp_check_ins_trigger_shape_chk CHECK ((trigger_kind = 'time') = (trigger_subject_id IS NULL));

-- Mirrors WISP_CHECK_IN_FIRE_REASONS in @breeze/shared.
ALTER TABLE wisp_check_ins DROP CONSTRAINT IF EXISTS wisp_check_ins_fire_reason_chk;
ALTER TABLE wisp_check_ins ADD CONSTRAINT wisp_check_ins_fire_reason_chk CHECK (fire_reason IS NULL OR fire_reason IN ('due','event','deadline'));

ALTER TABLE wisp_check_ins DROP CONSTRAINT IF EXISTS wisp_check_ins_cancel_reason_len_chk;
ALTER TABLE wisp_check_ins ADD CONSTRAINT wisp_check_ins_cancel_reason_len_chk CHECK (cancel_reason IS NULL OR char_length(cancel_reason) <= 200);

-- The event fast path looks up the scheduled event rows of one subject; the
-- tick reconcile walks the scheduled event rows. Time rows never match.
CREATE INDEX IF NOT EXISTS wisp_check_ins_trigger_idx
  ON wisp_check_ins (trigger_kind, trigger_subject_id)
  WHERE status = 'scheduled' AND trigger_kind <> 'time';
