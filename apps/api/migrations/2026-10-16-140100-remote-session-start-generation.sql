-- SEC-038 W02 (#5533): server-side generation fence for remote desktop
-- start/terminal decisions.
--
-- Three additive columns on remote_sessions:
--   desktop_start_generation  monotonic bigint, bumped by BOTH the start-intent
--                             commit (this wave) and the terminal-intent commit
--                             (W03). It is the total order every start decision
--                             is linearized against.
--   terminal_generation       the generation at which the session was declared
--                             terminal (NULL while the session is live). Set by
--                             W03's commitDesktopTerminalIntent().
--   termination_phase         'none' | 'pending' | 'confirmed'. 'pending' from
--                             the terminal-intent commit, 'confirmed' once the
--                             agent's stop result lands. W02 only READS it
--                             (a start is refused unless the phase is 'none');
--                             W03 is what writes it.
--
-- Additive with defaults on purpose: an API rollback leaves the columns inert,
-- and an old API simply never reads them. No new table, so no cascade-list
-- registration applies — but the three columns DO require
-- CORE_TENANT_EXPORT_POLICY entries (the export-policy contract fires on a new
-- column of an already-registered org-cascade table).
--
-- Idempotent (ADD COLUMN IF NOT EXISTS + DO $$ guarded constraint). Writes no
-- rows, so no breeze.scope election is needed. No inner BEGIN/COMMIT.

ALTER TABLE remote_sessions
  ADD COLUMN IF NOT EXISTS desktop_start_generation bigint NOT NULL DEFAULT 0;

ALTER TABLE remote_sessions
  ADD COLUMN IF NOT EXISTS terminal_generation bigint;

ALTER TABLE remote_sessions
  ADD COLUMN IF NOT EXISTS termination_phase text NOT NULL DEFAULT 'none';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'remote_sessions'::regclass
      AND conname = 'remote_sessions_termination_phase_check'
  ) THEN
    ALTER TABLE remote_sessions
      ADD CONSTRAINT remote_sessions_termination_phase_check
      CHECK (termination_phase IN ('none', 'pending', 'confirmed'));
  END IF;
END $$;

-- A terminal generation only means anything once the session has left phase
-- 'none', and a session in a terminal phase must carry the generation it was
-- declared terminal at. Enforced as one constraint so neither half can drift.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'remote_sessions'::regclass
      AND conname = 'remote_sessions_terminal_generation_phase_check'
  ) THEN
    ALTER TABLE remote_sessions
      ADD CONSTRAINT remote_sessions_terminal_generation_phase_check
      CHECK (
        (termination_phase = 'none' AND terminal_generation IS NULL)
        OR (termination_phase <> 'none' AND terminal_generation IS NOT NULL)
      );
  END IF;
END $$;
