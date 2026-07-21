-- Phase 4 (native ticketing): email-to-ticket ingest tables
-- Spec: docs/superpowers/specs/ticketing/2026-06-13-ticketing-phase4-email-to-ticket-design.md

CREATE TABLE IF NOT EXISTS ticket_email_inbound (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID REFERENCES partners(id),
  provider VARCHAR(50) NOT NULL,
  provider_message_id TEXT NOT NULL,
  from_address TEXT,
  to_address TEXT,
  subject TEXT,
  message_id TEXT,
  in_reply_to TEXT,
  "references" TEXT,
  parse_status VARCHAR(20) NOT NULL,
  ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
  error TEXT,
  raw JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS partner_inbound_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  domain VARCHAR(255) NOT NULL,
  provider VARCHAR(50) NOT NULL,
  provider_domain_id TEXT,
  verification_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  dns_records JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS ticket_email_inbound_provider_msg_uq ON ticket_email_inbound (partner_id, provider_message_id);
CREATE INDEX IF NOT EXISTS ticket_email_inbound_review_idx ON ticket_email_inbound (partner_id, parse_status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS partner_inbound_domains_domain_uq ON partner_inbound_domains (domain);
CREATE INDEX IF NOT EXISTS partner_inbound_domains_partner_idx ON partner_inbound_domains (partner_id);

-- RLS: both partner-axis (Shape 3). System scope (the worker) sees all; partner scope only its own.
ALTER TABLE ticket_email_inbound ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_email_inbound FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY ticket_email_inbound_partner_access ON ticket_email_inbound
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE partner_inbound_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_inbound_domains FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY partner_inbound_domains_partner_access ON partner_inbound_domains
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
