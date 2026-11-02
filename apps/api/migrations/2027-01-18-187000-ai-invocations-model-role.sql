-- #10413: record WHY each ledger row's model ran, so the Agent SDK CLI's own
-- background call (a small helper model, billed since #10413 at its own rate)
-- is no longer counted as a refusal/served fallback.
--
--   primary    the bound model, or a model this session switched away from
--   fallback   a model that served the turn in the bound model's place
--              (fallback_used is true exactly for these rows)
--   background the CLI's helper call: billed, never a fallback
--
-- NULL = settled before this column (and a pending settlement persisted
-- before it and replayed after). Provenance like served_model: written once at
-- INSERT. ai_invocations_append_only compares to_jsonb(NEW) - 'org_id' with
-- OLD, so the new column is covered without touching the trigger; breeze_app's
-- table-level SELECT/INSERT grants cover it, UPDATE stays org_id-only.
--
-- The CHECK is added NOT VALID here and validated by -120100 in its own
-- transaction (autoMigrate wraps each file in one; a same-file VALIDATE would
-- hold this ALTER's ACCESS EXCLUSIVE lock through a scan of the hot ledger).
--
-- ADD COLUMN without a default is metadata-only. Idempotent. Writes no rows.

ALTER TABLE public.ai_invocations ADD COLUMN IF NOT EXISTS model_role text;

ALTER TABLE public.ai_invocations DROP CONSTRAINT IF EXISTS ai_invocations_model_role_chk;
ALTER TABLE public.ai_invocations ADD CONSTRAINT ai_invocations_model_role_chk CHECK (
  model_role IS NULL
  OR (model_role IN ('primary', 'background', 'fallback') AND fallback_used = (model_role = 'fallback'))
) NOT VALID;
