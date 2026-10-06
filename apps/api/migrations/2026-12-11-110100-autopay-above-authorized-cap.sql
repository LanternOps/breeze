-- #7743 autopay: an invoice above the cap the client accepted in its consent is
-- ineligible even when the MSP later raised or removed the cap. Staff see it as a
-- distinct reason ("above the limit the client authorized"), not as over_cap.
-- Schema-only; no rows are written. Idempotent: drop-if-exists then re-add.
ALTER TABLE invoice_autopay_schedules DROP CONSTRAINT IF EXISTS invoice_autopay_schedules_ineligible_reason_check;
ALTER TABLE invoice_autopay_schedules ADD CONSTRAINT invoice_autopay_schedules_ineligible_reason_check
  CHECK (ineligible_reason IN ('not_enrolled','enrolled_after_issue','consent_required','method_not_usable','over_cap','cap_currency_mismatch','ach_currency_unsupported','excluded_contract','excluded_invoice','charging_disabled','stripe_unavailable','above_authorized_cap'));
