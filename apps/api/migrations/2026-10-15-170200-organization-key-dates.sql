-- organization_key_dates (feature #5573 W01, spec §4.5). RLS shape 1. DDL only.
-- The reminder-ticket composite FK references tickets(id, org_id) and is DEFERRABLE
-- INITIALLY IMMEDIATE for org merge (see orgLifecycleFoundations merge contract).
-- Registration: same PR adds the table to CORE_ORG_CASCADE_DELETE_ORDER,
-- CORE_TENANT_EXPORT_POLICY and the org-merge registry.
DO $$ BEGIN
  CREATE TYPE org_key_date_kind AS ENUM ('insurance_renewal','vendor_contract_end','compliance_deadline','audit','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS organization_key_dates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  label VARCHAR(200) NOT NULL,
  kind org_key_date_kind NOT NULL DEFAULT 'other',
  date DATE NOT NULL,
  recurs_annually BOOLEAN NOT NULL DEFAULT FALSE,
  remind_days_before INTEGER,
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reminded_for_date DATE,
  reminder_ticket_id UUID,
  portal_visible BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
  ALTER TABLE organization_key_dates ADD CONSTRAINT org_key_dates_reminder_ticket_org_fk
    FOREIGN KEY (reminder_ticket_id, org_id) REFERENCES tickets(id, org_id)
    ON DELETE SET NULL (reminder_ticket_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE organization_key_dates ADD CONSTRAINT org_key_dates_remind_chk
    CHECK (remind_days_before IS NULL OR remind_days_before >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS org_key_dates_org_date_idx ON organization_key_dates (org_id, date);

ALTER TABLE organization_key_dates ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_key_dates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON organization_key_dates;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON organization_key_dates;
DROP POLICY IF EXISTS breeze_org_isolation_update ON organization_key_dates;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON organization_key_dates;
CREATE POLICY breeze_org_isolation_select ON organization_key_dates FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON organization_key_dates FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON organization_key_dates FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON organization_key_dates FOR DELETE USING (public.breeze_has_org_access(org_id));
