-- #4628 W04b (wave #6335) — spec §3.6 / §4.3, gates from #6472.
--
-- Drops the six legacy labour-pricing columns:
--   ticket_categories.default_billable / default_hourly_rate / rate_currency
--   org_ticket_settings.default_billable / default_hourly_rate / rate_currency
-- one release after the cut-over (2026-10-24-200200-labour-pricing-conversion.sql)
-- converted them into billing profiles and every reader stopped using them.
-- Dropping org_ticket_settings.rate_currency also removes the inert 'USD'
-- default that 2026-10-24-200400 put on it.
--
-- ARCHIVE BEFORE DROP. The conversion deliberately skipped some legacy values
-- (off-list-currency orgs; org rates whose rate_currency differed from the org
-- currency; non-billable category rates; category rates in an unsupported or
-- missing currency). The legacy columns were the only copy of those values, so
-- every row that still carries legacy pricing is copied into
-- legacy_labour_pricing_archive first — a full snapshot, not only the skipped
-- rows, so a misclassification cannot lose data. skip_reason names why the
-- conversion did not carry the value over; NULL means the conversion did.
--
-- The archive is partner-axis (shape 3) exactly like
-- org_billing_profile_assignments: the rates were the MSP's prices, not the
-- customer's data, and their new home (billing profiles) is partner-axis too.
-- org_id is metadata for the org rows (and the cascade/merge/export contracts).
--
-- WRITES ROWS (the archive insert): system scope is elected first. FORCE RLS
-- binds the migration role too; without it the insert aborts with 42501 and the
-- interlock count below reads zero rows (fail-open).
--
-- The dependent CHECK (ticket_categories_rate_currency_chk) and the two
-- supported_currencies FKs from 2026-08-30-ticketing-currency.sql fall with
-- their columns. They are deliberately NOT named in an ALTER ... CONSTRAINT
-- here: replayMigration (src/__tests__/integration/replayMigration.ts) re-runs
-- every later migration that touches a constraint name a replayed file touches,
-- so naming them would make a replay of 2026-08-30 drop the columns again.
--
-- autoMigrate wraps this file in a transaction — no BEGIN/COMMIT here.
-- Idempotent: the archive is keyed (source_table, source_id) and only runs
-- while the legacy columns exist; every DDL statement is IF [NOT] EXISTS.
SELECT set_config('breeze.scope', 'system', true);

-- 1) Interlock: refuse if any partner was never converted (§3.6 item 5).
--    partners.labour_pricing_converted_at is the conversion's own idempotency
--    marker (DEFAULT now() for partners created after it), so a NULL here means
--    pricing that never reached a billing profile.
DO $$
DECLARE unconverted integer; total integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT count(*), count(*) FILTER (WHERE labour_pricing_converted_at IS NULL)
    INTO total, unconverted FROM partners;
  RAISE WARNING 'billing profiles W04b interlock: % partner(s) visible, % unconverted', total, unconverted;
  IF unconverted > 0 THEN
    RAISE EXCEPTION 'refusing to drop legacy labour-pricing columns: % partner(s) were never converted to billing profiles (partners.labour_pricing_converted_at IS NULL); run 2026-10-24-200200-labour-pricing-conversion.sql for them first', unconverted;
  END IF;
END $$;

-- 2) The archive table (partner-axis, RLS in the same migration). -------------
CREATE TABLE IF NOT EXISTS legacy_labour_pricing_archive (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  -- Set for org_ticket_settings rows only (org metadata, not the RLS axis).
  org_id uuid,
  source_table text NOT NULL,
  -- ticket_categories.id or org_ticket_settings.id of the archived row.
  source_id uuid NOT NULL,
  -- Category name or organization name at archive time.
  source_name text NOT NULL,
  default_billable boolean,
  default_hourly_rate numeric(10,2),
  rate_currency char(3),
  -- The owner's currency at archive time: the org's for org rows, the
  -- partner's for category rows.
  owner_currency_code char(3),
  skip_reason text,
  archived_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legacy_labour_pricing_archive_source_table_chk
    CHECK (source_table IN ('ticket_categories', 'org_ticket_settings')),
  CONSTRAINT legacy_labour_pricing_archive_org_chk
    CHECK ((source_table = 'org_ticket_settings') = (org_id IS NOT NULL)),
  CONSTRAINT legacy_labour_pricing_archive_skip_reason_chk
    CHECK (skip_reason IS NULL OR skip_reason IN (
      'org_currency_off_list',
      'org_rate_currency_mismatch',
      'non_billable_category_rate',
      'category_rate_currency_unsupported'
    )),
  CONSTRAINT legacy_labour_pricing_archive_source_uniq UNIQUE (source_table, source_id)
);

-- Org merge re-points parent and child org_id in separate statements under
-- SET CONSTRAINTS ALL DEFERRED, so this composite FK must be deferrable.
-- NULL org_id (category rows) is not checked (MATCH SIMPLE).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legacy_labour_pricing_archive_org_partner_fk') THEN
    ALTER TABLE legacy_labour_pricing_archive ADD CONSTRAINT legacy_labour_pricing_archive_org_partner_fk
      FOREIGN KEY (org_id, partner_id) REFERENCES organizations (id, partner_id) DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS legacy_labour_pricing_archive_partner_idx
  ON legacy_labour_pricing_archive (partner_id);
CREATE INDEX IF NOT EXISTS legacy_labour_pricing_archive_org_idx
  ON legacy_labour_pricing_archive (org_id) WHERE org_id IS NOT NULL;

ALTER TABLE legacy_labour_pricing_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_labour_pricing_archive FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public'
      AND tablename = 'legacy_labour_pricing_archive' AND policyname = 'legacy_labour_pricing_archive_partner_access'
  ) THEN
    CREATE POLICY legacy_labour_pricing_archive_partner_access ON legacy_labour_pricing_archive
      FOR ALL TO breeze_app
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_labour_pricing_archive TO breeze_app;

-- 3) Archive every row that still carries legacy pricing. --------------------
--    Only while the columns exist: on a re-apply they are gone and this is a
--    no-op. The static SQL below is planned only when its branch executes.
DO $$
DECLARE
  n bigint;
  summary record;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ticket_categories' AND column_name = 'default_hourly_rate'
  ) THEN
    RAISE WARNING 'billing profiles W04b: ticket_categories legacy pricing columns already dropped; archived 0 category rows';
  ELSE
    INSERT INTO legacy_labour_pricing_archive
      (partner_id, org_id, source_table, source_id, source_name,
       default_billable, default_hourly_rate, rate_currency, owner_currency_code, skip_reason)
    SELECT c.partner_id, NULL, 'ticket_categories', c.id, c.name,
      c.default_billable, c.default_hourly_rate, c.rate_currency, p.currency_code,
      CASE
        WHEN c.default_hourly_rate IS NOT NULL AND c.default_billable = false
          THEN 'non_billable_category_rate'
        WHEN c.default_hourly_rate IS NOT NULL AND (c.rate_currency IS NULL OR NOT EXISTS (
          SELECT 1 FROM supported_currencies sc WHERE sc.code = c.rate_currency))
          THEN 'category_rate_currency_unsupported'
        ELSE NULL
      END
    FROM ticket_categories c
    JOIN partners p ON p.id = c.partner_id
    WHERE c.default_hourly_rate IS NOT NULL OR c.default_billable = false
    ON CONFLICT (source_table, source_id) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE WARNING 'billing profiles W04b: archived % ticket_categories legacy pricing row(s)', n;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'org_ticket_settings' AND column_name = 'default_hourly_rate'
  ) THEN
    RAISE WARNING 'billing profiles W04b: org_ticket_settings legacy pricing columns already dropped; archived 0 org rows';
  ELSE
    INSERT INTO legacy_labour_pricing_archive
      (partner_id, org_id, source_table, source_id, source_name,
       default_billable, default_hourly_rate, rate_currency, owner_currency_code, skip_reason)
    SELECT o.partner_id, o.id, 'org_ticket_settings', s.id, o.name,
      s.default_billable, s.default_hourly_rate, s.rate_currency, o.currency_code,
      CASE
        WHEN NOT EXISTS (SELECT 1 FROM supported_currencies sc WHERE sc.code = o.currency_code)
          THEN 'org_currency_off_list'
        WHEN s.default_hourly_rate IS NOT NULL AND s.default_billable IS DISTINCT FROM false
          AND s.rate_currency IS DISTINCT FROM o.currency_code
          THEN 'org_rate_currency_mismatch'
        ELSE NULL
      END
    FROM org_ticket_settings s
    JOIN organizations o ON o.id = s.org_id
    WHERE s.default_billable IS NOT NULL OR s.default_hourly_rate IS NOT NULL
    ON CONFLICT (source_table, source_id) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE WARNING 'billing profiles W04b: archived % org_ticket_settings legacy pricing row(s)', n;
  END IF;

  FOR summary IN
    SELECT source_table, coalesce(skip_reason, 'converted') AS outcome, count(*) AS rows
    FROM legacy_labour_pricing_archive GROUP BY 1, 2 ORDER BY 1, 2
  LOOP
    RAISE WARNING 'billing profiles W04b: archive holds % % row(s) with outcome %',
      summary.rows, summary.source_table, summary.outcome;
  END LOOP;
END $$;

-- 4) Drop the six columns (dependent CHECK/FKs and the 200400 default go too).
ALTER TABLE ticket_categories DROP COLUMN IF EXISTS default_billable;
ALTER TABLE ticket_categories DROP COLUMN IF EXISTS default_hourly_rate;
ALTER TABLE ticket_categories DROP COLUMN IF EXISTS rate_currency;
ALTER TABLE org_ticket_settings DROP COLUMN IF EXISTS default_billable;
ALTER TABLE org_ticket_settings DROP COLUMN IF EXISTS default_hourly_rate;
ALTER TABLE org_ticket_settings DROP COLUMN IF EXISTS rate_currency;

-- 5) Prove it.
DO $$
DECLARE remaining integer;
BEGIN
  SELECT count(*) INTO remaining
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name IN ('ticket_categories', 'org_ticket_settings')
    AND column_name IN ('default_billable', 'default_hourly_rate', 'rate_currency');
  IF remaining <> 0 THEN
    RAISE EXCEPTION 'billing profiles W04b: % legacy labour-pricing column(s) survived the drop', remaining;
  END IF;
  RAISE WARNING 'billing profiles W04b: all six legacy labour-pricing columns dropped';
END $$;
