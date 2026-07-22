-- Phase 3 (native ticketing): time_entries + ticket_parts
-- Spec: docs/superpowers/specs/2026-06-11-ticketing-phase3-time-tracking-parts-design.md

DO $$ BEGIN
  CREATE TYPE billing_status AS ENUM ('not_billed','billed','no_charge','contract');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS time_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  org_id UUID REFERENCES organizations(id),
  ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  started_at TIMESTAMP NOT NULL,
  ended_at TIMESTAMP,
  duration_minutes INTEGER,
  description TEXT,
  is_billable BOOLEAN NOT NULL DEFAULT FALSE,
  hourly_rate NUMERIC(10,2),
  billing_status billing_status NOT NULL DEFAULT 'not_billed',
  is_approved BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ticket_parts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  description TEXT NOT NULL,
  part_number VARCHAR(100),
  vendor VARCHAR(100),
  quantity NUMERIC(10,2) NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  cost_basis NUMERIC(10,2),
  is_billable BOOLEAN NOT NULL DEFAULT TRUE,
  billing_status billing_status NOT NULL DEFAULT 'not_billed',
  added_by UUID REFERENCES users(id),
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- One running timer per user (spec D3): DB-level backstop for the
-- stop-then-start race in timeEntryService.startTimer.
CREATE UNIQUE INDEX IF NOT EXISTS time_entries_one_running_per_user_uq
  ON time_entries (user_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS time_entries_partner_started_idx ON time_entries (partner_id, started_at);
CREATE INDEX IF NOT EXISTS time_entries_ticket_idx ON time_entries (ticket_id);
CREATE INDEX IF NOT EXISTS time_entries_user_started_idx ON time_entries (user_id, started_at);
CREATE INDEX IF NOT EXISTS ticket_parts_ticket_idx ON ticket_parts (ticket_id);

-- RLS: time_entries is partner-axis (Shape 3). Internal-only (spec D4):
-- deliberately NO org/portal policies.
ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_entries FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY time_entries_partner_access ON time_entries
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- RLS: ticket_parts is org-axis (Shape 1, org_id denormalized from parent ticket).
ALTER TABLE ticket_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_parts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON ticket_parts;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ticket_parts;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ticket_parts;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ticket_parts;
CREATE POLICY breeze_org_isolation_select ON ticket_parts
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ticket_parts
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ticket_parts
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ticket_parts
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- updated_at triggers (same pattern as incidents / elevation_requests)
CREATE OR REPLACE FUNCTION update_time_entries_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_time_entries_updated_at ON time_entries;
CREATE TRIGGER trg_time_entries_updated_at
  BEFORE UPDATE ON time_entries
  FOR EACH ROW EXECUTE FUNCTION update_time_entries_updated_at();

DROP TRIGGER IF EXISTS trg_ticket_parts_updated_at ON ticket_parts;
CREATE TRIGGER trg_ticket_parts_updated_at
  BEFORE UPDATE ON ticket_parts
  FOR EACH ROW EXECUTE FUNCTION update_time_entries_updated_at();

-- Permissions: new time_entries resource (spec D5)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'time_entries' AND action = 'read') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('time_entries', 'read', 'View time entries and timesheets');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'time_entries' AND action = 'write') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('time_entries', 'write', 'Log and edit time entries');
  END IF;
END $$;

-- Grant time_entries perms to every role that already holds the matching
-- tickets perm (technician-shaped roles) — same propagation pattern as 2026-06-09-a.
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource = 'tickets' AND p1.action = 'read'
JOIN permissions p2 ON p2.resource = 'time_entries' AND p2.action = 'read'
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id
);

INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource = 'tickets' AND p1.action = 'write'
JOIN permissions p2 ON p2.resource = 'time_entries' AND p2.action = 'write'
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id
);
