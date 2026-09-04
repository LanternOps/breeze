-- #3205 wave 7 / #4656 — BLOCKING (spec decision 10a).
--
-- breeze_cascade_device_org_id() is an AFTER UPDATE trigger on devices that
-- restamps org_id on every table this function returns, DURING the devices
-- UPDATE itself and before any route code runs. The function discovers tables
-- dynamically from pg_class/pg_attribute (uuid device_id + uuid org_id), so
-- invoice_line_devices is auto-enrolled the moment it exists — and its
-- DEFERRABLE INITIALLY IMMEDIATE composite FKs to invoice_lines/invoices are
-- checked at the end of that same statement, raising 23503 and failing every
-- cross-org move of a billed device. Exactly the tickets_requester_contact_org_fk
-- shape documented in 2026-10-04-100000-ticket-requester-contact.sql.
--
-- Full current body copied from 2026-09-17-pam-device-move-guard.sql, with only
-- the billing-evidence table added to the deliberate exclusion list.
CREATE OR REPLACE FUNCTION public.breeze_device_child_orgid_tables()
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  AS $$
  SELECT t.relname::text
  FROM pg_class t
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relkind = 'r'
    AND t.relname <> 'devices'
    -- ai_agent_runs: agent-run history stays with the SOURCE org on a device
    -- move (owner decision 2026-08-23); its org_id is trigger-immutable.
    -- PAM lifecycle and result evidence is likewise source-frozen, but unlike
    -- agent runs its existence blocks the device move entirely.
    -- invoice_line_devices: billing evidence stays in its INVOICE's org on a
    -- device move. The invoice and its lines do not move, so restamping the
    -- evidence row's org_id here trips invoice_line_devices_line_org_fk /
    -- invoice_line_devices_invoice_org_fk (DEFERRABLE INITIALLY IMMEDIATE) at
    -- the end of the trigger's own statement. moveOrg.ts detaches device_id
    -- instead, and that statement is LOAD-BEARING, not a mirror of this loop
    -- (#3205 W07).
    AND t.relname NOT IN (
      'ai_agent_runs',
      'pam_actuations',
      'pam_actuation_results',
      'invoice_line_devices'
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attname = 'device_id'
        AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attname = 'org_id'
        AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
    );
$$;
