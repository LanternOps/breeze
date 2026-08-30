-- apps/api/migrations/2026-09-25-ticket-push-preferences.sql
-- W07 (#3901): per-user mobile push preferences for ticket events.
-- Shape 6 (user-scoped). No org_id/partner_id by design: a personal preference,
-- same category as mobile_devices — NOT a Partner-Wide-First config table.
-- Consequently it appears in NO cascade list (no org_id, no device_id) and in
-- no export-policy entry; USER_ID_SCOPED_TABLES is the only registration.
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps each file).

DO $$ BEGIN
  CREATE TYPE ticket_sla_push_scope AS ENUM ('off', 'owned', 'any');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS ticket_push_preferences (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  assigned_enabled boolean NOT NULL DEFAULT true,
  sla_scope        ticket_sla_push_scope NOT NULL DEFAULT 'owned',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- The 'any' fan-out query (services/ticketPush.ts) filters on sla_scope = 'any'
-- then joins users on partner_id; keep the opted-in set cheap to enumerate.
CREATE INDEX IF NOT EXISTS ticket_push_preferences_sla_any_idx
  ON ticket_push_preferences (user_id) WHERE sla_scope = 'any';

ALTER TABLE ticket_push_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_push_preferences FORCE ROW LEVEL SECURITY;

-- Policy spelling mirrors user_notifications_user_isolation
-- (2026-09-04-ai-agent-notifications.sql). The `system` branch is required:
-- the ticket notify worker reads this table inside withSystemDbAccessContext.
-- No partner/org admin branch is ORed in — nobody but the user and system
-- jobs needs a push preference.
DROP POLICY IF EXISTS ticket_push_preferences_user_isolation ON ticket_push_preferences;
CREATE POLICY ticket_push_preferences_user_isolation ON ticket_push_preferences
  FOR ALL
  USING      (public.breeze_current_scope() = 'system' OR user_id = public.breeze_current_user_id())
  WITH CHECK (public.breeze_current_scope() = 'system' OR user_id = public.breeze_current_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_push_preferences TO breeze_app;
