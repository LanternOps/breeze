-- Org erasure clears device_commands before walking org-scoped tables (#4871).
-- Retain the restore job until its own cascade step, detaching the command.
ALTER TABLE public.restore_jobs
  DROP CONSTRAINT IF EXISTS restore_jobs_command_id_fkey,
  DROP CONSTRAINT IF EXISTS restore_jobs_command_id_device_commands_id_fk;
ALTER TABLE public.restore_jobs
  ADD CONSTRAINT restore_jobs_command_id_fkey
  FOREIGN KEY (command_id) REFERENCES public.device_commands(id) ON DELETE SET NULL;
