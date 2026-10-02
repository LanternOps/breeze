-- AI model registry W09 (#7607): validate the three CHECKs that
-- 2026-12-02-100000 added NOT VALID, each in this file's OWN transaction.
-- VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, which does not block
-- INSERTs, so settlement keeps writing while the ledger is scanned (W10
-- precedent, 2026-11-26-100120).
--
-- Every existing row passes: the ledger and run columns are new (hop 0 / all
-- NULL), and W02 wrote fallback_offering_ids = NULL on every assignment
-- (legacyReconcile.ts), so no list exceeds 5. Lab gate L4 confirms the assignment count on each
-- production region before release.
--
-- Idempotent: validating an already-valid constraint is a no-op. DDL only.
ALTER TABLE public.ai_invocations VALIDATE CONSTRAINT ai_invocations_failover_chk;
ALTER TABLE public.ai_agent_runs VALIDATE CONSTRAINT ai_agent_runs_served_chk;
ALTER TABLE public.ai_model_assignments VALIDATE CONSTRAINT ai_model_assignments_fallback_shape_chk;
