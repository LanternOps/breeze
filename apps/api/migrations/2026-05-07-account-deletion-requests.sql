-- 2026-05-07-account-deletion-requests.sql
-- account_deletion_requests: user-id scoped (Shape 6).
-- Records a user's request to delete their account; processed asynchronously
-- by an admin/back-office worker. Created from the public /account/delete
-- page that the mobile app links to (Apple App Store requirement).
-- Idempotent: safe to re-apply on an already-migrated database.

DO $$ BEGIN
  CREATE TYPE account_deletion_request_status AS ENUM (
    'pending',
    'processing',
    'completed',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Denormalised so the row remains attributable to a tenant for ops/audit
  -- even after the user row is reassigned. Nullable because partner-level
  -- staff (users.org_id IS NULL) can also request deletion.
  org_id        uuid        REFERENCES organizations(id) ON DELETE SET NULL,
  reason        text,
  status        account_deletion_request_status NOT NULL DEFAULT 'pending',
  requested_at  timestamptz NOT NULL DEFAULT now(),
  process_by    timestamptz NOT NULL,
  processed_at  timestamptz,
  processed_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One pending request per user — enforced via partial unique index so a user
-- with a previously cancelled/completed request can submit again.
CREATE UNIQUE INDEX IF NOT EXISTS account_deletion_requests_user_pending_uniq
  ON account_deletion_requests (user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS account_deletion_requests_status_idx
  ON account_deletion_requests (status, process_by);

CREATE INDEX IF NOT EXISTS account_deletion_requests_org_idx
  ON account_deletion_requests (org_id)
  WHERE org_id IS NOT NULL;

ALTER TABLE account_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_deletion_requests FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'account_deletion_requests'
      AND policyname = 'account_deletion_requests_user_scope'
  ) THEN
    CREATE POLICY account_deletion_requests_user_scope ON account_deletion_requests
      USING     (user_id = breeze_current_user_id())
      WITH CHECK (user_id = breeze_current_user_id());
  END IF;
END $$;
