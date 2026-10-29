-- #10413: validate the CHECK -120000 added NOT VALID. VALIDATE takes SHARE
-- UPDATE EXCLUSIVE, so settlements keep inserting while it scans. Every
-- pre-existing row has model_role NULL and passes.
-- Idempotent (validating a valid constraint is a no-op). Writes no rows.

ALTER TABLE public.ai_invocations VALIDATE CONSTRAINT ai_invocations_model_role_chk;
