-- Wisp W06a (#9912, feature #9906): per-user nudge preferences and the
-- partner's "urgent-capable" severity set (Wisp design §7.4, §7.6; w00
-- "Nudges (W06)", A28 morning brief, A29 proactivity dial).
--
-- Tenancy:
--  * wisp_nudge_preferences — user axis inside a partner (one row per user,
--    user_id PK). Composite FK (user_id, partner_id) -> users(id, partner_id)
--    pins the row's partner to the user's own partner. ONE FOR ALL policy
--    `system OR (user_id = breeze_current_user_id() AND
--    breeze_has_partner_access(partner_id))`, so every DML command is covered
--    by BOTH breeze_current_user_id (USER_ID_SCOPED_TABLES) and
--    breeze_has_partner_access (PARTNER_TENANT_TABLES, strict rls-coverage).
--    A separate additive SELECT-only policy lets same-partner members read the
--    row (docs/agents/tenancy-rls.md: partner read branches are SELECT-only);
--    nobody but the user (or a system job) writes it.
--  * wisp_partner_nudge_settings — shape 3 (partner axis), one row per
--    partner, ONE FOR ALL policy `system OR breeze_has_partner_access
--    (partner_id)`. The route gates writes on canManagePartnerWidePolicies.
--
-- Neither table has an org_id column, so neither enters
-- CORE_ORG_CASCADE_DELETE_ORDER, orgMergeRegistry.ts or
-- CORE_TENANT_EXPORT_POLICY (precedent: 2026-09-25-ticket-push-preferences.sql).
-- `channels` is jsonb and would be `excludedOpen` by rule, but the table sits
-- outside the org export policy altogether. Partner erasure reaches both
-- through ON DELETE CASCADE on partner_id.
--
-- Status/kind columns are text + CHECK (never pgEnum). Idempotent; no inner
-- BEGIN/COMMIT; writes no rows, so no breeze.scope election is needed.

CREATE TABLE IF NOT EXISTS wisp_nudge_preferences (
  user_id                uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  partner_id             uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  channels               jsonb NOT NULL DEFAULT '{"inApp":true,"push":true}'::jsonb,
  quiet_override         text NOT NULL DEFAULT 'never',
  digest_cadence_minutes integer NOT NULL DEFAULT 240,
  last_digest_at         timestamptz NULL,
  -- w00 A28: NULL = brief off; '08:00' on first insert.
  brief_time_local       text NULL DEFAULT '08:00',
  -- IANA zone; NULL = the user's first registered mobile device zone, else UTC.
  brief_timezone         text NULL,
  last_brief_at          timestamptz NULL,
  -- w00 A29 push severity floor.
  proactivity            text NOT NULL DEFAULT 'normal',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE wisp_nudge_preferences
    ADD CONSTRAINT wisp_nudge_preferences_user_partner_fk
    FOREIGN KEY (user_id, partner_id) REFERENCES users (id, partner_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE wisp_nudge_preferences
    ADD CONSTRAINT wisp_nudge_preferences_quiet_override_chk
    CHECK (quiet_override IN ('never', 'urgent_only'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE wisp_nudge_preferences
    ADD CONSTRAINT wisp_nudge_preferences_digest_cadence_chk
    CHECK (digest_cadence_minutes BETWEEN 15 AND 1440);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE wisp_nudge_preferences
    ADD CONSTRAINT wisp_nudge_preferences_channels_chk
    CHECK (jsonb_typeof(channels) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE wisp_nudge_preferences
    ADD CONSTRAINT wisp_nudge_preferences_brief_time_chk
    CHECK (brief_time_local IS NULL OR brief_time_local ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE wisp_nudge_preferences
    ADD CONSTRAINT wisp_nudge_preferences_brief_timezone_chk
    CHECK (brief_timezone IS NULL OR char_length(brief_timezone) BETWEEN 1 AND 64);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE wisp_nudge_preferences
    ADD CONSTRAINT wisp_nudge_preferences_proactivity_chk
    CHECK (proactivity IN ('quiet', 'normal', 'chatty'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS wisp_nudge_preferences_partner_idx
  ON wisp_nudge_preferences (partner_id);

CREATE TABLE IF NOT EXISTS wisp_partner_nudge_settings (
  partner_id                uuid PRIMARY KEY REFERENCES partners(id) ON DELETE CASCADE,
  urgent_capable_severities text[] NOT NULL DEFAULT '{}',
  updated_by_user_id        uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE wisp_partner_nudge_settings
    ADD CONSTRAINT wisp_partner_nudge_settings_severities_chk
    CHECK (urgent_capable_severities <@ ARRAY['info', 'low', 'medium', 'high']::text[]);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE wisp_nudge_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE wisp_nudge_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE wisp_partner_nudge_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE wisp_partner_nudge_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wisp_nudge_preferences_user_isolation ON wisp_nudge_preferences;
CREATE POLICY wisp_nudge_preferences_user_isolation ON wisp_nudge_preferences
  FOR ALL
  USING (
    public.breeze_current_scope() = 'system'
    OR (user_id = public.breeze_current_user_id() AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (user_id = public.breeze_current_user_id() AND public.breeze_has_partner_access(partner_id))
  );

DROP POLICY IF EXISTS wisp_nudge_preferences_partner_select ON wisp_nudge_preferences;
CREATE POLICY wisp_nudge_preferences_partner_select ON wisp_nudge_preferences
  FOR SELECT
  USING (public.breeze_has_partner_access(partner_id));

DROP POLICY IF EXISTS wisp_partner_nudge_settings_isolation ON wisp_partner_nudge_settings;
CREATE POLICY wisp_partner_nudge_settings_isolation ON wisp_partner_nudge_settings
  FOR ALL
  USING      (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON wisp_nudge_preferences TO breeze_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON wisp_partner_nudge_settings TO breeze_app;
