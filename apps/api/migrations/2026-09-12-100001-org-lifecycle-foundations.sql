-- Org lifecycle spec (2026-08-26): merge + archive foundations.

-- Fail-fast on AEL contention instead of queueing silently behind a
-- long-held lock; safe to retry since this file is idempotent throughout.
-- autoMigrate wraps the whole file in one transaction, so this applies to
-- every statement below.
SET LOCAL lock_timeout = '5s';

-- Section 1: lifecycle columns on organizations.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS purge_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS offboarding_target varchar(16) NOT NULL DEFAULT 'churn';
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_offboarding_target_chk;
ALTER TABLE organizations ADD CONSTRAINT organizations_offboarding_target_chk
  CHECK (offboarding_target IN ('churn', 'archive'));

-- Section 2: make every composite FK that references an org_id column
-- DEFERRABLE INITIALLY IMMEDIATE. The org-merge transaction (Wave 2) runs
-- SET CONSTRAINTS ALL DEFERRED and re-points parent+child org_id in separate
-- statements; ON UPDATE NO ACTION non-deferrable FKs would fail at statement
-- end. Runtime behavior is unchanged while IMMEDIATE. Contract test:
-- orgLifecycleFoundations.integration.test.ts. As of 2026-08-26 this converts
-- 16 constraints (list from the contract test's red run):
-- elevation_audit.elevation_audit_elevation_request_id_org_id_fkey,
-- invoice_lines.invoice_lines_invoice_org_fkey,
-- invoice_payments.invoice_payments_invoice_org_fkey,
-- invoice_documents.invoice_documents_invoice_org_fkey,
-- pax8_contract_line_links.pax8_contract_line_links_contract_line_org_fkey,
-- m365_consent_sessions.m365_consent_sessions_connection_identity_fkey,
-- devices.devices_link_group_id_org_id_fkey,
-- pax8_order_lines.pax8_order_lines_order_partner_org_fkey,
-- pax8_order_lines.pax8_order_lines_contract_line_org_fkey,
-- quote_recipients.quote_recipients_quote_id_org_id_fkey,
-- devices.devices_site_org_fk,
-- quote_orders.quote_orders_quote_org_fkey,
-- quote_order_lines.quote_order_lines_order_fkey,
-- fleet_remediation_runs.fleet_remediation_runs_finding_org_fk,
-- contacts.contacts_site_org_fk,
-- contact_external_links.contact_external_links_contact_org_fk.
DO $$
DECLARE
  fk record;
  n integer := 0;
BEGIN
  FOR fk IN
    SELECT con.conname, con.conrelid::regclass AS child_table
    FROM pg_constraint con
    WHERE con.contype = 'f'
      AND con.condeferrable = false
      AND con.connamespace = 'public'::regnamespace
      AND EXISTS (
        SELECT 1 FROM unnest(con.confkey) AS ck(attnum)
        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = ck.attnum
        WHERE a.attname = 'org_id'
      )
    ORDER BY con.conrelid::regclass::text, con.conname
  LOOP
    EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE',
                   fk.child_table, fk.conname);
    n := n + 1;
  END LOOP;
  IF n > 0 THEN
    RAISE WARNING 'org-lifecycle: made % composite org_id FKs deferrable', n;
  END IF;
END $$;

-- Section 3: org_merge_events — durable record of "loser merged into survivor".
-- Survives the loser's erasure (loser_org_id has NO FK by design). Consulted by
-- the public quote-token fallback (Wave 2) and rendered in merge history UI.
-- Tenancy: Shape 3 (partner-axis). Registered in PARTNER_TENANT_TABLES.
CREATE TABLE IF NOT EXISTS org_merge_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  loser_org_id uuid NOT NULL,
  loser_org_name varchar(255) NOT NULL,
  survivor_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id uuid,
  summary jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS org_merge_events_loser_idx ON org_merge_events (loser_org_id);
CREATE INDEX IF NOT EXISTS org_merge_events_survivor_idx ON org_merge_events (survivor_org_id);
CREATE INDEX IF NOT EXISTS org_merge_events_partner_idx ON org_merge_events (partner_id);

ALTER TABLE org_merge_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_merge_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_merge_events_partner_access ON org_merge_events;
CREATE POLICY org_merge_events_partner_access ON org_merge_events
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  );

-- DELETE included: cascadeDeletePartner's dynamic partner_id sweep issues hard
-- DELETEs as breeze_app under a system RLS context. UPDATE is omitted from
-- this list as intent, but the omission does not land on its own:
-- ensureAppRole's blanket GRANT (step 4, apps/api/src/db/ensureAppRole.ts)
-- re-grants UPDATE on ALL TABLES IN SCHEMA public to breeze_app after every
-- migration pass, and org_merge_events is not in ensureAppRole's per-table
-- re-revoke list (unlike audit_logs/audit_log_chain). "Written once, never
-- edited" is actually enforced by the org_merge_events_block_update trigger
-- below, which RAISEs on UPDATE regardless of which grants are in effect.
GRANT SELECT, INSERT, DELETE ON org_merge_events TO breeze_app;

-- Belt-and-suspenders, mirroring audit_log_immutable()
-- (2026-05-25-a-audit-log-append-only.sql): a trigger that raises on any
-- UPDATE, surviving a future GRANT re-permitting it. Unlike that precedent,
-- DELETE is intentionally NOT blocked here — cascadeDeletePartner's
-- partner_id sweep and the survivor_org_id ON DELETE CASCADE both rely on
-- DELETE remaining available, so only the BEFORE UPDATE trigger is created.
CREATE OR REPLACE FUNCTION org_merge_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'org_merge_events is append-only',
    HINT = 'org_merge_events rows cannot be modified once written. DELETE remains allowed for partner/org erasure cascades.';
END;
$$;

DROP TRIGGER IF EXISTS org_merge_events_block_update ON org_merge_events;
CREATE TRIGGER org_merge_events_block_update BEFORE UPDATE ON org_merge_events
  FOR EACH ROW EXECUTE FUNCTION org_merge_events_immutable();
