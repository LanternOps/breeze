-- Partner sending daily stats (spec 2026-09-17-partner-sending-domains-design
-- §9.3). W06 of the partner-sending-domains feature.
--
-- TENANCY: RLS shape 3 (partner-axis), exactly the idiom
-- 2026-10-20-100000-partner-sending-domains.sql shipped for
-- partner_sending_domains: one FOR ALL TO breeze_app policy,
-- breeze_current_scope() = 'system' OR breeze_has_partner_access(partner_id),
-- on both USING and WITH CHECK. Deliberately NO org_id and NO device_id, so the
-- only registration is PARTNER_TENANT_TABLES — no CORE_ORG_CASCADE_DELETE_ORDER,
-- no device lists, no CORE_TENANT_EXPORT_POLICY, no org-merge registry.
-- cascadeDeletePartner discovers this table by its partner_id column and its
-- topological order puts it before `partners`, so no registration is needed
-- there either.
--
-- NO domain_id dimension, on purpose: spec §9.3's thresholds and the kill
-- switch are both per PARTNER, an event can arrive after the local domain row
-- was removed (so domain_id could not be a real FK), and nothing in this wave
-- reads a per-domain breakdown. Per-domain deliverability is an additive second
-- table, not a retrofit of this one.
--
-- The partner FK deliberately carries NO ON DELETE CASCADE, matching the two
-- W02 partner tables: the partner sweep deletes these rows explicitly.
--
-- Counters are bigint: a hosted partner-lane account carries every partner's
-- mail, and an integer counter would be a latent overflow on a busy day.
--
-- DDL only: no rows written, so no breeze.scope election
-- (apps/api/src/db/migrationRlsScope.test.ts). Idempotent; no inner
-- BEGIN/COMMIT (autoMigrate wraps the file).

CREATE TABLE IF NOT EXISTS partner_sending_daily_stats (
  partner_id  uuid NOT NULL REFERENCES partners(id),
  -- UTC calendar day the provider event was received on.
  day         date NOT NULL,
  -- Incremented from the `email.sent` provider event, NEVER by the send path:
  -- the send path is forbidden from writing a partner-axis table.
  sent        bigint NOT NULL DEFAULT 0,
  delivered   bigint NOT NULL DEFAULT 0,
  bounced     bigint NOT NULL DEFAULT 0,
  complained  bigint NOT NULL DEFAULT 0,
  failed      bigint NOT NULL DEFAULT 0,
  suppressed  bigint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_sending_daily_stats_pk PRIMARY KEY (partner_id, day),
  CONSTRAINT partner_sending_daily_stats_nonneg_chk CHECK (
    sent >= 0 AND delivered >= 0 AND bounced >= 0
    AND complained >= 0 AND failed >= 0 AND suppressed >= 0
  )
);

-- The PK already indexes (partner_id) as a prefix, which serves every
-- per-partner window read. This index serves the CROSS-partner admin rollup
-- and the abuse sweep, both of which scan one 7-day window over every partner.
CREATE INDEX IF NOT EXISTS partner_sending_daily_stats_day_idx
  ON partner_sending_daily_stats (day);

ALTER TABLE partner_sending_daily_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_sending_daily_stats FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'partner_sending_daily_stats'
      AND policyname = 'partner_sending_daily_stats_partner_access'
  ) THEN
    CREATE POLICY partner_sending_daily_stats_partner_access ON partner_sending_daily_stats
      FOR ALL TO breeze_app
      USING      (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;
-- DELETE is load-bearing: cascadeDeletePartner's partner_id sweep issues hard
-- DELETEs as breeze_app under a system RLS context (no role switch).
GRANT SELECT, INSERT, UPDATE, DELETE ON partner_sending_daily_stats TO breeze_app;
