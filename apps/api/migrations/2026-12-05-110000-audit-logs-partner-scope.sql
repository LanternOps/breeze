-- audit_logs: partner attribution for partner-scoped (org_id NULL) events (#7696).
--
-- PROBLEM
-- Partner-scoped configuration changes (partner-library configuration policies,
-- monitor definitions, update rings, notification channels, notification
-- routing rules, ...) are audited with `org_id = NULL`. Those rows are written
-- under system scope, so they exist, but nothing short of system scope can ever
-- read them back:
--   * the only SELECT policy is `breeze_has_org_access(org_id)`, false for NULL
--     outside system scope; and
--   * the row carries no partner identity at all, so there is nothing a partner
--     predicate could match on — and some NULL-org rows are genuinely
--     platform-wide (anything not written on behalf of a partner: system-scope
--     admin actions, pre-auth agent enrollment / mTLS events, synthetic-partner
--     purges) and must stay hidden from every partner.
--
-- FIX
-- 1. `partner_id uuid` (nullable). Stamped by the writer
--    (services/auditEvents.ts / auditService.ts) ONLY on NULL-org rows written
--    on behalf of a partner (a partner-scope request or partner-scope DB
--    context, or an explicit partnerId). Org rows keep `partner_id NULL` — their tenancy is
--    the org axis — and the CHECK below makes that an invariant, so a stamped
--    org row can never reach a partner through the new branch by a second path.
-- 2. One additive, SELECT-only permissive policy for
--    `org_id IS NULL AND breeze_has_partner_access(partner_id)`.
--    `breeze_has_partner_access` (not `breeze_current_partner_id()`) is
--    deliberate: org-scope tokens carry an empty `accessible_partner_ids`, so an
--    org user never sees their MSP's partner-level audit trail, while
--    `breeze.current_partner_id` IS populated for org tokens and would leak it.
--    The existing org-axis policies are untouched (a FOR SELECT policy is never
--    consulted for UPDATE/DELETE targeting, and audit_logs is append-only on top
--    of that: REVOKE UPDATE/DELETE + the audit_log_immutable triggers).
--
-- NO FOREIGN KEY TO partners, ON PURPOSE
-- An FK would make `DELETE FROM partners` (tenantCascade.cascadeDeletePartner)
-- raise 23503 for any partner with audited partner-level activity, and none of
-- the escape hatches work on this table: ON DELETE SET NULL is an UPDATE (blocked
-- by audit_log_block_update), ON DELETE CASCADE / an explicit purge would punch
-- holes in the shared NULL-org hash chain (audit_log_chain is keyed on org_id,
-- so every partner's partner-level rows and the platform rows share one chain).
-- `partner_id` is attribution, exactly like `actor_id` (also FK-less): a row
-- whose partner is gone simply matches no live partner context again, which is
-- the pre-#7696 state of every NULL-org row. It is also not part of
-- `audit_log_canonical_payload` — neither is `org_id`; the tamper-evident
-- content set is unchanged, so every existing chain still verifies.
--
-- NO BACKFILL
-- Existing NULL-org rows stay `partner_id NULL` (invisible to partners, as
-- before). audit_logs is append-only and hash-chained; rewriting history is
-- exactly what the immutability trigger exists to forbid, and many of those
-- rows carry no reliable partner key in `details` anyway.
--
-- The partial index for the read branch and the VALIDATE of the CHECK live in
-- the companion `-- @no-transaction` file 2026-12-05-110100-..., because
-- audit_logs takes an insert on every agent request and a transactional
-- CREATE INDEX / VALIDATE would block those writes for the whole scan.
--
-- No row writes here, so no `breeze.scope` election is needed. Idempotent.

ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS partner_id uuid;

-- NOT VALID: every existing row has partner_id NULL (column added just above),
-- so the predicate already holds; skipping validation here avoids a full-table
-- scan under this transaction's ACCESS EXCLUSIVE lock. New rows are checked
-- immediately; the companion no-transaction file validates the old ones.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'audit_logs_partner_only_without_org_chk'
      AND conrelid = 'public.audit_logs'::regclass
  ) THEN
    ALTER TABLE public.audit_logs
      ADD CONSTRAINT audit_logs_partner_only_without_org_chk
      CHECK (org_id IS NULL OR partner_id IS NULL) NOT VALID;
  END IF;
END $$;

DROP POLICY IF EXISTS audit_logs_partner_scope_select ON public.audit_logs;
CREATE POLICY audit_logs_partner_scope_select ON public.audit_logs
  FOR SELECT
  USING (
    org_id IS NULL
    AND partner_id IS NOT NULL
    AND public.breeze_has_partner_access(partner_id)
  );
