ALTER TABLE "restore_jobs"
  ADD COLUMN IF NOT EXISTS "command_id" uuid REFERENCES "device_commands"("id");

CREATE INDEX IF NOT EXISTS "restore_jobs_command_id_idx"
  ON "restore_jobs"("command_id");

CREATE UNIQUE INDEX IF NOT EXISTS "restore_jobs_recovery_token_id_uniq"
  ON "restore_jobs"("recovery_token_id");

ALTER TABLE "recovery_tokens"
  ADD COLUMN IF NOT EXISTS "authenticated_at" timestamp;

ALTER TABLE "recovery_tokens"
  ADD COLUMN IF NOT EXISTS "completed_at" timestamp;
