-- AI chargeback W10 (#7608, spec §5.5 "chargeable: a snapshot"): the client-price
-- terms in force when the ledger row is written, frozen on the row.
-- ai_invocations is APPEND-ONLY (ai_invocations_append_only admits only an
-- org-merge org_id re-point), so these are set at INSERT and never change; the
-- charge_billing_profile_id is a snapshot id with no FK, like every provenance
-- id here. The CHECK is added NOT VALID then VALIDATEd so a busy ledger never
-- holds ACCESS EXCLUSIVE for a full scan (VALIDATE takes SHARE UPDATE EXCLUSIVE,
-- which does not block inserts). Every pre-existing row is chargeable = false
-- with NULL charge_* and satisfies it.
-- Registrations: the five columns join ai_invocations in CORE_TENANT_EXPORT_POLICY.
-- DDL only, idempotent.

ALTER TABLE public.ai_invocations ADD COLUMN IF NOT EXISTS charge_billing_profile_id uuid;
ALTER TABLE public.ai_invocations ADD COLUMN IF NOT EXISTS charge_coverage text;
ALTER TABLE public.ai_invocations ADD COLUMN IF NOT EXISTS charge_basis text;
ALTER TABLE public.ai_invocations ADD COLUMN IF NOT EXISTS charge_currency char(3);
ALTER TABLE public.ai_invocations ADD COLUMN IF NOT EXISTS charge_amount numeric(20, 6);

-- `( … ) IS TRUE`: a bare CHECK accepts NULL, so a chargeable row with a NULL
-- coverage would otherwise slip through (Codex review finding 7).
ALTER TABLE public.ai_invocations DROP CONSTRAINT IF EXISTS ai_invocations_charge_chk;
ALTER TABLE public.ai_invocations ADD CONSTRAINT ai_invocations_charge_chk CHECK ((
  (charge_coverage IS NULL OR charge_coverage IN ('billable', 'included', 'non_billable', 'not_eligible'))
  AND (charge_basis IS NULL OR charge_basis IN ('price_list', 'markup', 'unpriced'))
  AND (charge_amount IS NULL OR charge_amount >= 0)
  -- shadow rows were never billed and never will be
  AND (ledger_mode = 'authoritative' OR NOT chargeable)
  AND (
    (NOT chargeable
      AND charge_basis IS NULL AND charge_currency IS NULL AND charge_amount IS NULL
      AND charge_coverage IS DISTINCT FROM 'billable')
    OR
    (chargeable
      AND charge_coverage = 'billable'
      AND charge_billing_profile_id IS NOT NULL
      AND charge_basis IS NOT NULL
      AND charge_currency IS NOT NULL
      -- unpriced ⇔ no amount
      AND (charge_basis = 'unpriced') = (charge_amount IS NULL))
  )
) IS TRUE) NOT VALID;
-- VALIDATE runs in the NEXT file: autoMigrate commits each file in its own
-- transaction, so this file's brief ACCESS EXCLUSIVE (catalog-only ADD COLUMN /
-- ADD CONSTRAINT NOT VALID) is released before the validating scan starts.
