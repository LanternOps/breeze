-- #3205 wave 7 / #4656: per-invoice billing evidence + per-period outcomes.
-- Shape-1 org tenancy on both tables (auto-discovered by rls-coverage — do NOT
-- add either to an allowlist there). Requires 2026-10-08-101100-billing-evidence-fk-targets.sql.

DO $$ BEGIN
  CREATE TYPE invoice_line_device_counted_as AS ENUM ('included', 'overage', 'flagged');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------ 1. device evidence
CREATE TABLE IF NOT EXISTS invoice_line_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_line_id uuid NOT NULL,
  -- Denormalized so the appendix and the per-invoice read need no join, and so
  -- the org cascade has a direct handle. The composite FK below proves it
  -- agrees with the line's own invoice.
  invoice_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- SINGLE-column FK on purpose. A composite (device_id, org_id) would forbid
  -- every cross-org device move: the evidence stays in the INVOICE's org while
  -- the device leaves it (see moveOrg's explicit detach + INTENTIONALLY_NO_ORG_ID).
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  -- Stamps captured from the generation snapshot. hostname is what keeps a
  -- detached row legible; device_role is what makes a later reclassification
  -- visible instead of silent. Width/nullability mirror devices.hostname
  -- (db/schema/devices.ts, varchar(255) NOT NULL), so this never needs a null branch.
  hostname varchar(255) NOT NULL,
  device_role text NOT NULL,
  site_id uuid,
  counted_as invoice_line_device_counted_as NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Lineage. DEFERRABLE because org merge repoints parent and child org_id in
-- separate statements under SET CONSTRAINTS ALL DEFERRED (orgMerge.ts).
DO $$ BEGIN
  ALTER TABLE invoice_line_devices ADD CONSTRAINT invoice_line_devices_line_org_fk
    FOREIGN KEY (invoice_line_id, org_id) REFERENCES invoice_lines (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE invoice_line_devices ADD CONSTRAINT invoice_line_devices_invoice_org_fk
    FOREIGN KEY (invoice_id, org_id) REFERENCES invoices (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- The PG15 column list is mandatory: without it SET NULL nulls EVERY FK column
-- including the NOT NULL org_id, which aborts the parent delete with 23502.
-- Same lesson as ai_agent_op_evidence (2026-10-01-100000).
DO $$ BEGIN
  ALTER TABLE invoice_line_devices ADD CONSTRAINT invoice_line_devices_site_org_fk
    FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id)
    ON DELETE SET NULL (site_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One row per device per line. device_id NULLs do not collide, so a detached
-- row never blocks a later insert.
CREATE UNIQUE INDEX IF NOT EXISTS invoice_line_devices_line_device_uq
  ON invoice_line_devices (invoice_line_id, device_id);
-- Per-line read (the disclosure endpoint) AND the FK-child index for
-- invoice_line_devices_line_org_fk: without it every invoice_lines DELETE
-- seq-scans this table. The unique index above leads on the same column but is
-- (invoice_line_id, device_id); this one carries the read's keyset sort key.
CREATE INDEX IF NOT EXISTS invoice_line_devices_line_read_idx
  ON invoice_line_devices (invoice_line_id, hostname, id);
-- Per-invoice read (the PDF appendix) and the FK-child index for
-- invoice_line_devices_invoice_org_fk.
CREATE INDEX IF NOT EXISTS invoice_line_devices_invoice_read_idx
  ON invoice_line_devices (invoice_id, hostname, id);
-- Detach path (device delete + move-org) and "which invoices billed this device".
CREATE INDEX IF NOT EXISTS invoice_line_devices_device_idx
  ON invoice_line_devices (device_id) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS invoice_line_devices_org_idx ON invoice_line_devices (org_id);

ALTER TABLE invoice_line_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_devices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON invoice_line_devices;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON invoice_line_devices;
DROP POLICY IF EXISTS breeze_org_isolation_update ON invoice_line_devices;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON invoice_line_devices;
CREATE POLICY breeze_org_isolation_select ON invoice_line_devices
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON invoice_line_devices
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON invoice_line_devices
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON invoice_line_devices
  FOR DELETE USING (public.breeze_has_org_access(org_id));
-- UPDATE is REQUIRED: the device hard-delete detach (deviceDeletion.ts) and the
-- move-org detach are UPDATEs run as breeze_app, and the org-merge repoint is an
-- org_id UPDATE. This table is deliberately NOT append-only and deliberately
-- absent from AUDIT_ADMIN_REQUIRED_TABLES for exactly that reason (decision 9).
GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_line_devices TO breeze_app;

-- ------------------------------------------------------------ 2. period outcome
CREATE TABLE IF NOT EXISTS contract_billing_period_outcomes (
  contract_billing_period_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL,
  invoice_id uuid,
  -- Scalars first: jsonb is excludedOpen and never reaches a tenant export, so
  -- no fact may live ONLY in the digests below (decision 3).
  -- snapshot_device_total = 0 means "no snapshot was evaluated" (a flat-only
  -- contract), NOT "the org owns zero devices" — generation only builds a
  -- snapshot when a device-counted line exists.
  snapshot_device_total integer NOT NULL DEFAULT 0,
  uncovered_total integer NOT NULL DEFAULT 0,
  flagged_total integer NOT NULL DEFAULT 0,
  billed_overage_total integer NOT NULL DEFAULT 0,
  -- role -> count, mirroring UncoveredDevices.byRole.
  uncovered_by_role jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- W04 OverageSummary[] verbatim, BOTH modes.
  overages jsonb NOT NULL DEFAULT '[]'::jsonb,
  generated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE contract_billing_period_outcomes ADD CONSTRAINT cbp_outcomes_period_org_fk
    FOREIGN KEY (contract_billing_period_id, org_id)
    REFERENCES contract_billing_periods (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE contract_billing_period_outcomes ADD CONSTRAINT cbp_outcomes_contract_org_fk
    FOREIGN KEY (contract_id, org_id) REFERENCES contracts (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Mirrors contract_billing_periods.invoice_id, which is itself SET NULL: a
-- deleted draft must not take the outcome row with it. Column list again
-- mandatory, same 23502 reason as above.
DO $$ BEGIN
  ALTER TABLE contract_billing_period_outcomes ADD CONSTRAINT cbp_outcomes_invoice_org_fk
    FOREIGN KEY (invoice_id, org_id) REFERENCES invoices (id, org_id)
    ON DELETE SET NULL (invoice_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS cbp_outcomes_contract_idx
  ON contract_billing_period_outcomes (contract_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS cbp_outcomes_org_idx ON contract_billing_period_outcomes (org_id);

ALTER TABLE contract_billing_period_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_billing_period_outcomes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON contract_billing_period_outcomes;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON contract_billing_period_outcomes;
DROP POLICY IF EXISTS breeze_org_isolation_update ON contract_billing_period_outcomes;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON contract_billing_period_outcomes;
CREATE POLICY breeze_org_isolation_select ON contract_billing_period_outcomes
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON contract_billing_period_outcomes
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON contract_billing_period_outcomes
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON contract_billing_period_outcomes
  FOR DELETE USING (public.breeze_has_org_access(org_id));
-- UPDATE for the org-merge repoint, same as the evidence table.
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_billing_period_outcomes TO breeze_app;

-- ------------------------------------------------------------ 3. appendix gate
-- Partner default. A dedicated column, not a settings jsonb key: settings cards
-- replace sub-objects wholesale (#3597) and a stored `false` in jsonb is
-- ambiguous with "unset" (#3608). A NOT NULL DEFAULT column has no unset state.
ALTER TABLE partners ADD COLUMN IF NOT EXISTS
  invoice_device_appendix boolean NOT NULL DEFAULT false;
-- Pre-issue: NULL = inherit the partner default; settable only while status='draft'.
-- AT issue: both issuance writers stamp the RESOLVED boolean here, and the
-- renderer reads only this column thereafter (decision 14a), so a later change to
-- the partner default cannot alter a sanctioned re-render of an issued invoice.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS device_appendix boolean;
-- 1 = evidence written at generation by W07; NULL = pre-W07, or an invoice never
-- generated from a contract. Invoice-level `recorded` flag (decision 15a) —
-- deliberately NOT per line, so a line that genuinely counted zero devices stays
-- distinguishable from a historical invoice. smallint, not boolean, so a future
-- change to what generation records can be told apart from version 1.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS evidence_version smallint;
