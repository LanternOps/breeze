-- Native ticketing Phase 1 (core).
-- Spec: docs/superpowers/specs/2026-06-09-native-ticketing-design.md
-- Extends tickets/ticket_comments, adds ticket_categories (partner-axis),
-- ticket_alert_links (org-axis), partner_ticket_sequences (partner-axis),
-- seeds tickets permissions, adds 'ticket' notification type.

-- 1. Enums ------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE ticket_source AS ENUM ('portal','email','alert','manual','api','ai');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ticket_comment_type AS ENUM ('comment','internal','status_change','assignment','time_entry','system');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ticket_alert_link_type AS ENUM ('created_from','attached','auto');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'ticket';

-- 2. tickets extensions ------------------------------------------------
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES partners(id);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS category_id UUID;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS pending_reason TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS due_date TIMESTAMP;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS response_sla_minutes INTEGER;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolution_sla_minutes INTEGER;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_breached_at TIMESTAMP;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_breach_reason TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_paused_at TIMESTAMP;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_paused_minutes INTEGER DEFAULT 0;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS source ticket_source NOT NULL DEFAULT 'portal';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS internal_number VARCHAR(20);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS email_message_id TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS email_thread_key TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_by UUID REFERENCES users(id);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolution_note TEXT;

-- Backfill partner_id from the owning org (small table today; no batching needed)
UPDATE tickets t SET partner_id = o.partner_id
FROM organizations o
WHERE t.org_id = o.id AND t.partner_id IS NULL;

-- 3. ticket_comments extensions -----------------------------------------
ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS comment_type ticket_comment_type NOT NULL DEFAULT 'comment';
ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS old_value TEXT;
ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS new_value TEXT;
ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

-- 4. New tables ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  name VARCHAR(100) NOT NULL,
  color VARCHAR(7) NOT NULL DEFAULT '#6b7d83',
  parent_id UUID REFERENCES ticket_categories(id) ON DELETE SET NULL,
  default_priority ticket_priority,
  response_sla_minutes INTEGER,
  resolution_sla_minutes INTEGER,
  default_billable BOOLEAN NOT NULL DEFAULT TRUE,
  default_hourly_rate NUMERIC(10,2),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ticket_alert_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  alert_id UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  link_type ticket_alert_link_type NOT NULL DEFAULT 'attached',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS partner_ticket_sequences (
  partner_id UUID NOT NULL REFERENCES partners(id),
  year INTEGER NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (partner_id, year)
);

-- 5. tickets.category_id FK (table now exists) ---------------------------
DO $$ BEGIN
  ALTER TABLE tickets ADD CONSTRAINT tickets_category_id_fkey
    FOREIGN KEY (category_id) REFERENCES ticket_categories(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 6. Indexes --------------------------------------------------------------
CREATE INDEX IF NOT EXISTS tickets_partner_status_idx ON tickets (partner_id, status);
CREATE INDEX IF NOT EXISTS tickets_org_status_idx ON tickets (org_id, status);
CREATE INDEX IF NOT EXISTS tickets_assigned_to_status_idx ON tickets (assigned_to, status);
CREATE UNIQUE INDEX IF NOT EXISTS tickets_partner_internal_number_uq
  ON tickets (partner_id, internal_number) WHERE internal_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS ticket_comments_ticket_created_idx ON ticket_comments (ticket_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_alert_links_ticket_alert_uq ON ticket_alert_links (ticket_id, alert_id);
CREATE INDEX IF NOT EXISTS ticket_alert_links_alert_idx ON ticket_alert_links (alert_id);
CREATE INDEX IF NOT EXISTS ticket_categories_partner_idx ON ticket_categories (partner_id);

-- 7. RLS --------------------------------------------------------------------
-- ticket_alert_links: Shape 1 (direct org_id), same pattern as elevation_requests.
ALTER TABLE ticket_alert_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_alert_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON ticket_alert_links;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ticket_alert_links;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ticket_alert_links;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ticket_alert_links;
CREATE POLICY breeze_org_isolation_select ON ticket_alert_links
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ticket_alert_links
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ticket_alert_links
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ticket_alert_links
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ticket_categories + partner_ticket_sequences: Shape 3 (partner-axis),
-- same pattern as oauth_client_partner_grants.
ALTER TABLE ticket_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_categories FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY ticket_categories_partner_access ON ticket_categories
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE partner_ticket_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_ticket_sequences FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY partner_ticket_sequences_partner_access ON partner_ticket_sequences
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 8. Permissions seed ----------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'tickets' AND action = 'read') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('tickets', 'read', 'View tickets, comments, and categories');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'tickets' AND action = 'write') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('tickets', 'write', 'Create and update tickets, comments, and categories');
  END IF;
END $$;

-- Grant tickets perms to every role that already holds the matching alerts perm
-- (technician-shaped roles). Admin roles with '*' need nothing.
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource = 'alerts' AND p1.action = 'read'
JOIN permissions p2 ON p2.resource = 'tickets' AND p2.action = 'read'
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id
);

INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource = 'alerts' AND p1.action = 'write'
JOIN permissions p2 ON p2.resource = 'tickets' AND p2.action = 'write'
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id
);
