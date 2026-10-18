-- apps/api/migrations/2026-12-29-233000-connection-health-digest.sql
-- Connection health W3 (#8847, spec 2026-10-15 §2.2, §2.3): the per-user email
-- opt-out table and the daily digest delivery ledger.
--
-- Both are Shape 6 (user-id scoped, breeze_current_user_id()), user_id only.
-- No org_id / partner_id by design: an opt-out is a personal choice, and the
-- ledger is the user's own delivery receipt. They therefore appear in NO org
-- cascade, merge or export-policy list; the users FK cascades on user delete.
-- The ledger's incident_ids is a bare uuid[] with no FK, so an org delete that
-- cascades incidents leaves dangling ids that simply join to nothing.
--
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps each file). No row
-- writes, but scope is elected first per migrationRlsScope.test.ts convention.
SELECT set_config('breeze.scope', 'system', true);

CREATE TABLE IF NOT EXISTS user_email_optouts (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Closed vocabulary: a new topic is a deliberate migration (services/emailOptouts.ts).
  topic      text NOT NULL CONSTRAINT user_email_optouts_topic_chk CHECK (topic IN ('connection_health_digest')),
  source     text NOT NULL CONSTRAINT user_email_optouts_source_chk CHECK (source IN ('settings', 'one_click')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_email_optouts_pkey PRIMARY KEY (user_id, topic)
);

CREATE TABLE IF NOT EXISTS connection_health_digest_deliveries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The partner-local calendar date the digest is for.
  digest_date  date NOT NULL,
  status       text NOT NULL CONSTRAINT connection_health_digest_deliveries_status_chk
                 CHECK (status IN ('claimed', 'sent', 'failed', 'skipped_empty')),
  incident_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  claimed_at   timestamptz NOT NULL,
  sent_at      timestamptz NULL,
  error        text NULL CONSTRAINT connection_health_digest_deliveries_error_len_chk
                 CHECK (error IS NULL OR char_length(error) <= 500),
  -- At most once per user per local date: the claim is INSERT ... ON CONFLICT DO NOTHING.
  CONSTRAINT connection_health_digest_deliveries_user_date_uniq UNIQUE (user_id, digest_date),
  CONSTRAINT connection_health_digest_deliveries_sent_chk CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);

-- Stale-claim sweep (claimed for over an hour → failed, never resent).
CREATE INDEX IF NOT EXISTS connection_health_digest_deliveries_claimed_idx
  ON connection_health_digest_deliveries (claimed_at) WHERE status = 'claimed';
-- Ledger retention (90 days).
CREATE INDEX IF NOT EXISTS connection_health_digest_deliveries_date_idx
  ON connection_health_digest_deliveries (digest_date);

ALTER TABLE user_email_optouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_email_optouts FORCE ROW LEVEL SECURITY;
ALTER TABLE connection_health_digest_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_health_digest_deliveries FORCE ROW LEVEL SECURITY;

-- Policy spelling mirrors ticket_push_preferences_user_isolation. The system
-- branch is required: the digest job and the unauthenticated one-click
-- unsubscribe run in system scope. No partner/org admin branch: nobody but the
-- user and system jobs reads another user's opt-out or delivery record.
DROP POLICY IF EXISTS user_email_optouts_user_isolation ON user_email_optouts;
CREATE POLICY user_email_optouts_user_isolation ON user_email_optouts
  FOR ALL
  USING      (public.breeze_current_scope() = 'system' OR user_id = public.breeze_current_user_id())
  WITH CHECK (public.breeze_current_scope() = 'system' OR user_id = public.breeze_current_user_id());

DROP POLICY IF EXISTS connection_health_digest_deliveries_user_isolation ON connection_health_digest_deliveries;
CREATE POLICY connection_health_digest_deliveries_user_isolation ON connection_health_digest_deliveries
  FOR ALL
  USING      (public.breeze_current_scope() = 'system' OR user_id = public.breeze_current_user_id())
  WITH CHECK (public.breeze_current_scope() = 'system' OR user_id = public.breeze_current_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON user_email_optouts TO breeze_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON connection_health_digest_deliveries TO breeze_app;
