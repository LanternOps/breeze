-- Wisp run-mode check-ins W07 (#11496, feature #11489; #10410 wave B, spec
-- 2026-11-06-wisp-chat-grant-followups §6.2 B). A check-in may RUN a
-- read-only assessment when it fires, instead of only notifying the grantor.
--
--   mode               'notify' (every earlier row: post the instruction and
--                      wait for the grantor's next turn) or 'run' (admit one
--                      assessment run under the grant and post its result).
--   run_id             the assessment run a `run` check-in admitted. A
--                      provenance pointer with NO FK, like trigger_subject_id:
--                      the post reads the run by id, and a run that is gone
--                      is a post-time condition, not a constraint.
--   grant_revision_id  the grant revision current when it was scheduled. A
--                      `run` check-in whose grant has a different current
--                      revision at fire time runs nothing: it degrades to a
--                      post asking the grantor to run it now. A widened
--                      revision therefore never applies to it.
--
-- New status 'running': admitted, the run has not settled yet. Lifecycle of a
-- run row: scheduled → running → consumed (the run's result was posted) or
-- fired (the run did not finish; the grantor was asked to run it now).
--
-- Tenancy is unchanged: shape 3, forced, wisp_check_ins_isolation
-- (2027-01-20-130000-wisp-check-ins.sql). Cascade and merge are table-level
-- and unchanged; the three columns are `included` in
-- CORE_TENANT_EXPORT_POLICY (none is json/jsonb/bytea). No device or ticket
-- column is added.
--
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file). The file
-- writes no rows (the NOT NULL DEFAULT fills existing rows with 'notify');
-- system scope is elected first anyway, per the migrations README.

SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE wisp_check_ins ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'notify';
ALTER TABLE wisp_check_ins ADD COLUMN IF NOT EXISTS run_id uuid NULL;
ALTER TABLE wisp_check_ins ADD COLUMN IF NOT EXISTS grant_revision_id uuid NULL;

-- Mirrors WISP_CHECK_IN_MODES in @breeze/shared; change them together.
ALTER TABLE wisp_check_ins DROP CONSTRAINT IF EXISTS wisp_check_ins_mode_chk;
ALTER TABLE wisp_check_ins ADD CONSTRAINT wisp_check_ins_mode_chk CHECK (mode IN ('notify','run'));

-- A run needs an org to assess and the revision it was scheduled under.
ALTER TABLE wisp_check_ins DROP CONSTRAINT IF EXISTS wisp_check_ins_run_org_chk;
ALTER TABLE wisp_check_ins ADD CONSTRAINT wisp_check_ins_run_org_chk CHECK (mode = 'notify' OR (org_id IS NOT NULL AND grant_revision_id IS NOT NULL));

-- Only a run check-in names a run.
ALTER TABLE wisp_check_ins DROP CONSTRAINT IF EXISTS wisp_check_ins_run_id_mode_chk;
ALTER TABLE wisp_check_ins ADD CONSTRAINT wisp_check_ins_run_id_mode_chk CHECK (run_id IS NULL OR mode = 'run');

-- Mirrors WISP_CHECK_IN_STATUSES in @breeze/shared; widened with 'running'.
ALTER TABLE wisp_check_ins DROP CONSTRAINT IF EXISTS wisp_check_ins_status_chk;
ALTER TABLE wisp_check_ins ADD CONSTRAINT wisp_check_ins_status_chk CHECK (status IN ('scheduled','running','fired','consumed','cancelled'));

-- Widened: a running row always names its run.
ALTER TABLE wisp_check_ins DROP CONSTRAINT IF EXISTS wisp_check_ins_status_shape_chk;
ALTER TABLE wisp_check_ins ADD CONSTRAINT wisp_check_ins_status_shape_chk CHECK ((status <> 'fired' OR fired_at IS NOT NULL) AND (status <> 'consumed' OR (fired_at IS NOT NULL AND consumed_at IS NOT NULL)) AND (status <> 'cancelled' OR cancelled_at IS NOT NULL) AND (status <> 'running' OR run_id IS NOT NULL));

-- The settled run's post looks its check-in up by run; the tick's reconcile
-- walks the running rows. Notify rows never match.
CREATE INDEX IF NOT EXISTS wisp_check_ins_run_idx
  ON wisp_check_ins (run_id)
  WHERE run_id IS NOT NULL;
