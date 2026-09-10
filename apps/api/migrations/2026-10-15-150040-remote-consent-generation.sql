-- Bind endpoint consent/answer results to the exact desktop-start generation.
ALTER TABLE remote_sessions
  ADD COLUMN IF NOT EXISTS desktop_start_command_id text,
  ADD COLUMN IF NOT EXISTS desktop_prompt_mode text;

ALTER TABLE remote_sessions
  DROP CONSTRAINT IF EXISTS remote_sessions_desktop_prompt_mode_check;
ALTER TABLE remote_sessions
  ADD CONSTRAINT remote_sessions_desktop_prompt_mode_check
  CHECK (desktop_prompt_mode IS NULL OR desktop_prompt_mode IN ('off', 'notify', 'consent'));

ALTER TABLE remote_sessions
  DROP CONSTRAINT IF EXISTS remote_sessions_desktop_start_binding_check;
ALTER TABLE remote_sessions
  ADD CONSTRAINT remote_sessions_desktop_start_binding_check
  CHECK (
    (desktop_start_command_id IS NULL AND desktop_prompt_mode IS NULL)
    OR (desktop_start_command_id IS NOT NULL AND desktop_prompt_mode IS NOT NULL)
  );
