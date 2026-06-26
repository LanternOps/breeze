-- apps/api/migrations/2026-06-25-ticket-response-templates.sql
-- Canned ticket responses: partner-wide reusable reply templates.
-- RLS shape 3 (partner-axis), mirroring ticket_categories.

CREATE TABLE IF NOT EXISTS ticket_response_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  name VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  category VARCHAR(100),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ticket_response_templates_partner_idx
  ON ticket_response_templates (partner_id);

ALTER TABLE ticket_response_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_response_templates FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY ticket_response_templates_partner_access ON ticket_response_templates
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
