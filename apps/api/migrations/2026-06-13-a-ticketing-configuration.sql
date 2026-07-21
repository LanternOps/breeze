-- Ticketing configuration: custom statuses, priority SLA settings, org overrides.
-- Spec: docs/superpowers/specs/ticketing/2026-06-12-ticketing-configuration-design.md

CREATE TABLE IF NOT EXISTS ticket_statuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  name varchar(60) NOT NULL,
  core_status ticket_status NOT NULL,
  color varchar(7),
  sort_order integer NOT NULL DEFAULT 0,
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_statuses_partner_idx ON ticket_statuses(partner_id);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_statuses_partner_name_uq ON ticket_statuses(partner_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS ticket_statuses_partner_core_status_system_uq
  ON ticket_statuses(partner_id, core_status) WHERE is_system;

CREATE TABLE IF NOT EXISTS ticket_priority_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  priority ticket_priority NOT NULL,
  label varchar(40),
  response_sla_minutes integer,
  resolution_sla_minutes integer,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_priority_settings_partner_priority_uq ON ticket_priority_settings(partner_id, priority);

CREATE TABLE IF NOT EXISTS org_ticket_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  sla_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_hourly_rate numeric(10,2),
  default_billable boolean,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- RLS: partner-axis tables (shape 3) + org-axis table (shape 1). Same migration, never deferred.
ALTER TABLE ticket_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_statuses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_statuses_partner_access ON ticket_statuses;
CREATE POLICY ticket_statuses_partner_access ON ticket_statuses
  FOR ALL TO breeze_app
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));

ALTER TABLE ticket_priority_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_priority_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_priority_settings_partner_access ON ticket_priority_settings;
CREATE POLICY ticket_priority_settings_partner_access ON ticket_priority_settings
  FOR ALL TO breeze_app
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));

ALTER TABLE org_ticket_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_ticket_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_ticket_settings_org_access ON org_ticket_settings;
CREATE POLICY org_ticket_settings_org_access ON org_ticket_settings
  FOR ALL TO breeze_app
  USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));

-- tickets.status_id (display/selection state; tickets.status stays the logic source of truth)
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS status_id uuid;
DO $$ BEGIN
  ALTER TABLE tickets ADD CONSTRAINT tickets_status_id_fkey
    FOREIGN KEY (status_id) REFERENCES ticket_statuses(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS tickets_status_id_idx ON tickets(status_id);

-- Seed the six system statuses for every existing partner (idempotent via anti-join).
DO $$
DECLARE n integer;
BEGIN
  WITH defaults(core_status, name, sort_order) AS (
    VALUES ('new'::ticket_status, 'New', 0), ('open'::ticket_status, 'Open', 1),
           ('pending'::ticket_status, 'Pending', 2), ('on_hold'::ticket_status, 'On hold', 3),
           ('resolved'::ticket_status, 'Resolved', 4), ('closed'::ticket_status, 'Closed', 5)
  ), ins AS (
    INSERT INTO ticket_statuses (partner_id, name, core_status, sort_order, is_system)
    SELECT p.id, d.name, d.core_status, d.sort_order, true
    FROM partners p CROSS JOIN defaults d
    WHERE NOT EXISTS (
      SELECT 1 FROM ticket_statuses ts
      WHERE ts.partner_id = p.id AND ts.is_system AND ts.core_status = d.core_status
    )
    RETURNING 1
  )
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN RAISE WARNING 'seeded % system ticket statuses', n; END IF;
END $$;

-- Backfill tickets.status_id from the partner's system row for the ticket's core status.
DO $$
DECLARE n integer;
BEGIN
  UPDATE tickets t
  SET status_id = ts.id
  FROM ticket_statuses ts
  WHERE t.status_id IS NULL
    AND t.partner_id IS NOT NULL
    AND ts.partner_id = t.partner_id AND ts.is_system AND ts.core_status = t.status;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'backfilled status_id on % tickets', n; END IF;
END $$;
