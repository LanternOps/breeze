-- 2026-05-06-approval-requests.sql
-- approval_requests: user-id scoped (Shape 6).
-- Idempotent: safe to re-apply on an already-migrated database.

DO $$ BEGIN
  CREATE TYPE approval_risk_tier AS ENUM ('low','medium','high','critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE approval_status AS ENUM ('pending','approved','denied','expired','reported');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS approval_requests (
  id                       uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requesting_client_id     text         REFERENCES oauth_clients(id),
  requesting_session_id    text         REFERENCES oauth_sessions(id),
  requesting_client_label  varchar(255) NOT NULL,
  requesting_machine_label varchar(255),
  action_label             text         NOT NULL,
  action_tool_name         varchar(255) NOT NULL,
  action_arguments         jsonb        NOT NULL DEFAULT '{}'::jsonb,
  risk_tier                approval_risk_tier NOT NULL,
  risk_summary             text         NOT NULL,
  status                   approval_status    NOT NULL DEFAULT 'pending',
  expires_at               timestamptz  NOT NULL,
  decided_at               timestamptz,
  decision_reason          text,
  created_at               timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS approval_requests_user_pending_idx
  ON approval_requests (user_id, status, expires_at);

CREATE INDEX IF NOT EXISTS approval_requests_created_at_idx
  ON approval_requests (created_at);

ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'approval_requests'
      AND policyname = 'approval_requests_user_scope'
  ) THEN
    CREATE POLICY approval_requests_user_scope ON approval_requests
      USING     (user_id = breeze_current_user_id())
      WITH CHECK (user_id = breeze_current_user_id());
  END IF;
END $$;
