BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'device_session_type') THEN
    CREATE TYPE device_session_type AS ENUM ('console', 'rdp', 'ssh', 'other');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'device_session_activity_state') THEN
    CREATE TYPE device_session_activity_state AS ENUM ('active', 'idle', 'locked', 'away', 'disconnected');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS device_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  username varchar(255) NOT NULL,
  session_type device_session_type NOT NULL DEFAULT 'console',
  os_session_id varchar(128),
  login_at timestamp NOT NULL DEFAULT now(),
  logout_at timestamp,
  duration_seconds integer,
  idle_minutes integer,
  activity_state device_session_activity_state,
  login_performance_seconds integer,
  is_active boolean NOT NULL DEFAULT true,
  last_activity_at timestamp,
  metadata text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_sessions_org_active_idx
  ON device_sessions (org_id, is_active);

CREATE INDEX IF NOT EXISTS device_sessions_device_active_idx
  ON device_sessions (device_id, is_active);

CREATE INDEX IF NOT EXISTS device_sessions_device_login_idx
  ON device_sessions (device_id, login_at);

CREATE INDEX IF NOT EXISTS device_sessions_device_user_idx
  ON device_sessions (device_id, username);

COMMIT;
