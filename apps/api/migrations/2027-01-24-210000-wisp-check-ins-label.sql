-- Wisp check-ins: a label written for the technician (#11675).
--
-- A fired check-in posted its `instruction` to the thread, and the instruction
-- is Wisp's note to itself ("Tell the technician right away. Read-only: …").
-- The post is now written for the technician: its title is built from the
-- trigger in code ("Back online: <device>"), and a time check-in uses this
-- short `label` ("Re-check disk space on FS01"). The instruction stays where
-- it belongs: in front of the model on the next turn (checkInTurn.ts).
--
--   label  1..120 characters, one line, written by Wisp with schedule_check_in;
--          NULL when Wisp gave none, and on rows scheduled before this column
--          (the post then falls back to the trigger).
--
-- Existing rows are left NULL (no backfill). The file writes no rows; system
-- scope is elected first anyway, per the migrations README.
--
-- Tenancy is unchanged: shape 3, forced, wisp_check_ins_isolation
-- (2027-01-20-130000-wisp-check-ins.sql). Cascade and merge are table-level
-- and unchanged; the column is `included` in CORE_TENANT_EXPORT_POLICY (it is
-- not json/jsonb/bytea). No device or ticket column is added.
--
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file).

SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE wisp_check_ins ADD COLUMN IF NOT EXISTS label text NULL;

-- Mirrors WISP_CHECK_IN_LABEL_MAX in packages/shared/src/types/wispCheckIns.ts; change them together.
ALTER TABLE wisp_check_ins DROP CONSTRAINT IF EXISTS wisp_check_ins_label_len_chk;
ALTER TABLE wisp_check_ins ADD CONSTRAINT wisp_check_ins_label_len_chk CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 120);
