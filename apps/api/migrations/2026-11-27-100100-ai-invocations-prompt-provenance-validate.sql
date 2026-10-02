-- AI model registry W11 (#7609): validate the CHECK -100000 added NOT VALID.
-- VALIDATE takes SHARE UPDATE EXCLUSIVE, so settlements keep inserting while
-- it scans. Every pre-existing row is NULL/NULL and passes.
-- Idempotent (validating a valid constraint is a no-op). Writes no rows.

ALTER TABLE public.ai_invocations VALIDATE CONSTRAINT ai_invocations_prompt_provenance_chk;
