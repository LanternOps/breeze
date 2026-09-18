-- Partner sending domains (spec 2026-09-17-partner-sending-domains-design §3).
-- W02 of the partner-sending-domains feature. Lands DARK: with
-- EMAIL_DOMAINS_PROVIDER unset nothing reads or writes these tables.
--
-- TENANCY:
--   partner_sending_domains, partner_sender_identities — RLS shape 3
--     (partner-axis). One FOR ALL TO breeze_app policy,
--     breeze_current_scope() = 'system' OR breeze_has_partner_access(partner_id),
--     on both USING and WITH CHECK. Template:
--     2026-09-25-time-entry-source-and-suggestion-decisions.sql.
--     Deliberately NO org_id and NO device_id, so they are registered in
--     PARTNER_TENANT_TABLES only — no CORE_ORG_CASCADE_DELETE_ORDER, no device
--     lists, no CORE_TENANT_EXPORT_POLICY, no org-merge registry.
--     cascadeDeletePartner discovers both by their partner_id column.
--   email_provider_domain_releases — INTENTIONAL_UNSCOPED. Forced RLS with a
--     single system-only policy. It MUST NOT have a partner_id column:
--     cascadeDeletePartner deletes from every public table that has one
--     (services/tenantCascade.ts:1762-1769), which would erase the provider
--     handle this outbox exists to keep across the partner's deletion.
--
-- The partner FKs deliberately carry NO ON DELETE CASCADE (§3.1): the partner
-- sweep deletes these rows explicitly, and a database cascade would bypass the
-- release guard below.
--
-- The composite FK is NOT DEFERRABLE. CLAUDE.md's deferrable rule covers
-- composite FKs on an org_id column, because the ORG merge runs
-- SET CONSTRAINTS ALL DEFERRED (services/orgMerge.ts:1060). There is no partner
-- merge in this repo. Precedent for a non-deferrable partner composite:
-- huntress_org_mappings_integration_partner_fkey (2026-06-12-a).
--
-- DDL only: no rows written, so no breeze.scope election
-- (apps/api/src/db/migrationRlsScope.test.ts). Idempotent; no inner
-- BEGIN/COMMIT (autoMigrate wraps the file).

-- 1) partner_sending_domains -------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_sending_domains (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id             uuid NOT NULL REFERENCES partners(id),
  -- Lowercase ASCII A-label, already normalised by normalizeSendingDomain.
  domain                 varchar(253) NOT NULL,
  provider               varchar(20) NOT NULL,
  -- NULL while provisioning and after release. ALWAYS null for `static`.
  provider_domain_id     text,
  -- false when the provider domain pre-existed Breeze asking for it (§5.1).
  -- A false row is NEVER deleted at the provider and never written to the outbox.
  provider_managed       boolean NOT NULL DEFAULT true,
  -- Committed BEFORE the provider create call, so a retry can tell "ours from a
  -- crashed attempt" (provider createdAt newer) from "pre-existing" (older).
  provision_attempted_at timestamptz,
  provider_region        varchar(32),
  status                 varchar(20) NOT NULL DEFAULT 'provisioning',
  status_reason          varchar(64),
  -- Public DNS data only, never secrets. jsonb => excludedOpen if this table
  -- ever gains an org_id (it must not).
  dns_records            jsonb NOT NULL DEFAULT '[]'::jsonb,
  check_requested_at     timestamptz,
  last_checked_at        timestamptz,
  next_check_at          timestamptz,
  check_attempts         integer NOT NULL DEFAULT 0,
  -- First verification. Sticky: never cleared once set.
  verified_at            timestamptz,
  status_changed_at      timestamptz NOT NULL DEFAULT now(),
  last_test_at           timestamptz,
  last_test_status       varchar(16),
  last_test_error        text,
  -- Most recent domain_unusable refusal. Written by the WORKER from the
  -- sync-domain payload, never by the send path (which may be in a context that
  -- cannot write this table).
  last_send_error        text,
  last_send_error_at     timestamptz,
  created_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_sending_domains_status_chk
    CHECK (status IN ('provisioning','pending','verified','at_risk','failed','suspended','removing')),
  CONSTRAINT partner_sending_domains_provider_chk
    CHECK (provider IN ('resend','ses','static','fake')),
  -- 'partner_released' is stamped by releaseSendingDomainsForPartner together
  -- with status='removing', in the same UPDATE that nulls provider_domain_id,
  -- so a released row never reads as a working sending domain.
  CONSTRAINT partner_sending_domains_status_reason_chk
    CHECK (status_reason IS NULL OR status_reason IN (
      'provider_conflict','provider_rejected','quota_exhausted','dns_not_detected',
      'dns_removed','platform_suspended','abuse_auto','failed_expired','user_removed',
      'partner_released')),
  CONSTRAINT partner_sending_domains_test_status_chk
    CHECK (last_test_status IS NULL OR last_test_status IN ('pending','sent','failed')),
  -- `static` has no provider object at all (§3.1).
  CONSTRAINT partner_sending_domains_static_no_provider_id_chk
    CHECK (provider <> 'static' OR provider_domain_id IS NULL),
  CONSTRAINT partner_sending_domains_domain_lower_chk
    CHECK (domain = lower(domain) AND domain NOT LIKE '%.'),
  CONSTRAINT partner_sending_domains_dns_records_array_chk
    CHECK (jsonb_typeof(dns_records) = 'array')
);

-- One row owns a name, pending or verified, across every partner. Mirrors
-- partner_inbound_domains_domain_uq. Squatting is bounded by expiry (§4.3).
CREATE UNIQUE INDEX IF NOT EXISTS partner_sending_domains_domain_uq
  ON partner_sending_domains (domain);
-- Referenced by the identities composite FK below.
CREATE UNIQUE INDEX IF NOT EXISTS partner_sending_domains_id_partner_uq
  ON partner_sending_domains (id, partner_id);
CREATE INDEX IF NOT EXISTS partner_sending_domains_partner_idx
  ON partner_sending_domains (partner_id);
CREATE INDEX IF NOT EXISTS partner_sending_domains_next_check_idx
  ON partner_sending_domains (next_check_at) WHERE next_check_at IS NOT NULL;

ALTER TABLE partner_sending_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_sending_domains FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'partner_sending_domains'
      AND policyname = 'partner_sending_domains_partner_access'
  ) THEN
    CREATE POLICY partner_sending_domains_partner_access ON partner_sending_domains
      FOR ALL TO breeze_app
      USING      (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;
-- DELETE is load-bearing: cascadeDeletePartner's partner_id sweep issues hard
-- DELETEs as breeze_app under a system RLS context (no role switch).
GRANT SELECT, INSERT, UPDATE, DELETE ON partner_sending_domains TO breeze_app;

-- 2) Provider release guard (§3.5) -------------------------------------------
-- A row may only be deleted after the service has confirmed provider deletion
-- or written the outbox row, and nulled provider_domain_id in the SAME
-- transaction. A delete path that forgets fails loudly instead of leaking a
-- provider domain. No breeze.* elevation and no SECURITY DEFINER: the function
-- reads only OLD and raises.
CREATE OR REPLACE FUNCTION public.breeze_sending_domain_release_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.provider_domain_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'partner_sending_domains row still owns a provider domain',
      DETAIL  = format('domain=%s provider=%s provider_domain_id=%s',
                       OLD.domain, OLD.provider, OLD.provider_domain_id),
      HINT    = 'Release first: releaseSendingDomainsForPartner() (or the removal path) writes an email_provider_domain_releases row for a provider_managed domain and NULLs provider_domain_id in the same transaction.';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS partner_sending_domains_release_guard ON partner_sending_domains;
CREATE TRIGGER partner_sending_domains_release_guard
  BEFORE DELETE ON partner_sending_domains
  FOR EACH ROW EXECUTE FUNCTION public.breeze_sending_domain_release_guard();

-- 3) partner_sender_identities -----------------------------------------------
-- One row per (partner, stream). A stream with no row sends from the platform
-- sender; there is no implicit fallback between streams.
CREATE TABLE IF NOT EXISTS partner_sender_identities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id        uuid NOT NULL REFERENCES partners(id),
  sending_domain_id uuid NOT NULL,
  stream            varchar(20) NOT NULL,
  local_part        varchar(64) NOT NULL,
  -- NULL => the partner's name is used.
  display_name      varchar(78),
  reply_to          varchar(320),
  updated_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_sender_identities_stream_chk
    CHECK (stream IN ('support','billing','general')),
  -- Mirrors senderLocalPartSchema in packages/shared (§4.4). The reserved-name
  -- refusal (postmaster/abuse/mailer-daemon) stays app-layer: it is product
  -- policy, not an integrity invariant.
  CONSTRAINT partner_sender_identities_local_part_chk
    CHECK (local_part ~ '^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?$' AND local_part NOT LIKE '%..%'),
  CONSTRAINT partner_sender_identities_display_name_chk
    CHECK (display_name IS NULL OR (display_name !~ '[\r\n"<>\\]' AND display_name NOT LIKE '%@%' AND display_name NOT LIKE '%://%'))
);

DO $$ BEGIN
  -- Tenant-consistent FK: an identity can only point at a domain owned by the
  -- SAME partner. ON DELETE CASCADE so removing a domain removes its identities
  -- (the domain delete itself is gated by the release guard above).
  -- NOT DEFERRABLE — see the header note.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_sender_identities_domain_partner_fk') THEN
    ALTER TABLE partner_sender_identities
      ADD CONSTRAINT partner_sender_identities_domain_partner_fk
      FOREIGN KEY (sending_domain_id, partner_id)
      REFERENCES partner_sending_domains (id, partner_id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS partner_sender_identities_partner_stream_uq
  ON partner_sender_identities (partner_id, stream);
CREATE INDEX IF NOT EXISTS partner_sender_identities_domain_idx
  ON partner_sender_identities (sending_domain_id);

ALTER TABLE partner_sender_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_sender_identities FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'partner_sender_identities'
      AND policyname = 'partner_sender_identities_partner_access'
  ) THEN
    CREATE POLICY partner_sender_identities_partner_access ON partner_sender_identities
      FOR ALL TO breeze_app
      USING      (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON partner_sender_identities TO breeze_app;

-- 4) email_provider_domain_releases (system outbox, §3.3) --------------------
-- "Delete this provider domain" work that must survive the partner's rows being
-- deleted. NO partner_id column, on purpose — see the header.
CREATE TABLE IF NOT EXISTS email_provider_domain_releases (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           varchar(20) NOT NULL,
  provider_domain_id text NOT NULL,
  provider_region    varchar(32),
  domain             varchar(253) NOT NULL,
  reason             varchar(32) NOT NULL,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  attempts           integer NOT NULL DEFAULT 0,
  next_attempt_at    timestamptz NOT NULL DEFAULT now(),
  last_error         text,
  CONSTRAINT email_provider_domain_releases_provider_chk
    CHECK (provider IN ('resend','ses','static','fake')),
  CONSTRAINT email_provider_domain_releases_reason_chk
    CHECK (reason IN ('user_removed','failed_expired','partner_released','force_release'))
);

CREATE UNIQUE INDEX IF NOT EXISTS email_provider_domain_releases_provider_domain_uq
  ON email_provider_domain_releases (provider, provider_domain_id);
CREATE INDEX IF NOT EXISTS email_provider_domain_releases_due_idx
  ON email_provider_domain_releases (next_attempt_at);

ALTER TABLE email_provider_domain_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_provider_domain_releases FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'email_provider_domain_releases'
      AND policyname = 'email_provider_domain_releases_system_only'
  ) THEN
    -- Same shape as abuse_script_hosts_system_only (2026-07-25) and
    -- installed_extensions: only a context that set breeze.scope = 'system' can
    -- see or write these rows.
    CREATE POLICY email_provider_domain_releases_system_only
      ON email_provider_domain_releases
      FOR ALL TO breeze_app
      USING      (current_setting('breeze.scope', true) = 'system')
      WITH CHECK (current_setting('breeze.scope', true) = 'system');
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON email_provider_domain_releases TO breeze_app;
