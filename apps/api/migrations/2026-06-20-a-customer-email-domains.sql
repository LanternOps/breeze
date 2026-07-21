-- Phase 5 (native ticketing): sender-domain -> customer-org routing for email-to-ticket
-- Spec: docs/superpowers/specs/ticketing/2026-06-20-ticketing-phase5-email-customer-routing-design.md

CREATE TABLE IF NOT EXISTS customer_email_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  org_id UUID NOT NULL,
  domain VARCHAR(255) NOT NULL,
  auto_create_contact BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Org must belong to the partner (DB-enforced, dual-axis pattern).
-- Relies on a UNIQUE(id, partner_id) constraint on organizations — the same one the
-- `users` composite FK uses (2026-04-11-users-rls.sql). (ticket_categories' composite
-- FK references ticket_categories(id, partner_id), NOT organizations, so it is not a
-- precedent here.) Add it if a fresh DB somehow lacks it. The by-columns existence
-- check means the pre-existing constraint's name is irrelevant; the ADD only runs on
-- the rare fresh-DB fallback path, under its own name.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'organizations' AND c.contype IN ('p','u')
      AND c.conkey = (SELECT array_agg(attnum ORDER BY attnum)
                      FROM pg_attribute WHERE attrelid = t.oid AND attname IN ('id','partner_id'))
  ) THEN
    ALTER TABLE organizations ADD CONSTRAINT organizations_id_partner_id_key UNIQUE (id, partner_id);
  END IF;
END $$;

DO $$ BEGIN
  ALTER TABLE customer_email_domains
    ADD CONSTRAINT customer_email_domains_org_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS customer_email_domains_partner_domain_uq
  ON customer_email_domains (partner_id, domain);
CREATE INDEX IF NOT EXISTS customer_email_domains_lookup_idx
  ON customer_email_domains (partner_id, is_active);

-- RLS: partner-axis (Shape 3) + denormalized org_id. System scope (the inbound worker)
-- sees all; partner scope sees only its own rows.
ALTER TABLE customer_email_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_email_domains FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY customer_email_domains_partner_access ON customer_email_domains
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
