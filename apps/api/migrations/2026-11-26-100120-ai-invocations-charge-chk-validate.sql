-- AI chargeback W10 (#7608): validate ai_invocations_charge_chk in its OWN
-- transaction. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, which does not
-- block INSERTs, so settlement keeps writing while the ledger is scanned.
-- Idempotent: validating an already-valid constraint is a no-op. DDL only.
ALTER TABLE public.ai_invocations VALIDATE CONSTRAINT ai_invocations_charge_chk;
