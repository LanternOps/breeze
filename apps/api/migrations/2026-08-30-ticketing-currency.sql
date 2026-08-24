-- Multi-currency wave 4 (#3776, spec §7): currency snapshots on ticketing rows.
--  * time_entries.currency_code      — nullable ONLY while org_id IS NULL AND hourly_rate
--                                      IS NULL (standalone, money-less timesheet entries);
--                                      stamped on org/ticket attach or the first rate.
--  * ticket_parts.currency_code      — NOT NULL (parts are always ticket-linked).
--  * org_ticket_settings.rate_currency — currency of default_hourly_rate, from the org.
--  * ticket_categories.rate_currency — partner currency the default rate was entered
--                                      under; nullable when there is no rate.
-- Backfills come from the owning org (entries/parts/org settings) or partner
-- (categories; standalone rated entries) and are REPORTED via RAISE WARNING
-- counts (repo convention).
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file).

-- 1) time_entries ------------------------------------------------------------
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS currency_code char(3);

DO $$
DECLARE n integer;
BEGIN
  UPDATE time_entries te
  SET currency_code = o.currency_code
  FROM organizations o
  WHERE o.id = te.org_id AND te.org_id IS NOT NULL AND te.currency_code IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: backfilled currency_code on % time_entries from owning org', n; END IF;
END $$;

-- Standalone (org_id NULL) entries that carry a rate are money too: the rate
-- was entered under the technician's partner currency.
DO $$
DECLARE n integer;
BEGIN
  UPDATE time_entries te
  SET currency_code = p.currency_code
  FROM partners p
  WHERE p.id = te.partner_id AND te.org_id IS NULL AND te.hourly_rate IS NOT NULL AND te.currency_code IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: backfilled currency_code on % standalone rated time_entries from partner', n; END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE time_entries
    ADD CONSTRAINT time_entries_currency_required_when_org_chk
    CHECK (org_id IS NULL OR currency_code IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN
  NULL; -- idempotent re-run
END $$;

DO $$
BEGIN
  ALTER TABLE time_entries
    ADD CONSTRAINT time_entries_currency_required_when_rate_chk
    CHECK (hourly_rate IS NULL OR currency_code IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN
  NULL; -- idempotent re-run
END $$;

-- 2) ticket_parts ------------------------------------------------------------
ALTER TABLE ticket_parts ADD COLUMN IF NOT EXISTS currency_code char(3);

DO $$
DECLARE n integer;
BEGIN
  UPDATE ticket_parts tp
  SET currency_code = o.currency_code
  FROM organizations o
  WHERE o.id = tp.org_id AND tp.currency_code IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: backfilled currency_code on % ticket_parts from owning org', n; END IF;
END $$;

ALTER TABLE ticket_parts ALTER COLUMN currency_code SET NOT NULL;

-- 3) org_ticket_settings -----------------------------------------------------
ALTER TABLE org_ticket_settings ADD COLUMN IF NOT EXISTS rate_currency char(3);

DO $$
DECLARE n integer;
BEGIN
  UPDATE org_ticket_settings s
  SET rate_currency = o.currency_code
  FROM organizations o
  WHERE o.id = s.org_id AND s.rate_currency IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: backfilled rate_currency on % org_ticket_settings from owning org', n; END IF;
END $$;

ALTER TABLE org_ticket_settings ALTER COLUMN rate_currency SET NOT NULL;

-- 4) ticket_categories -------------------------------------------------------
ALTER TABLE ticket_categories ADD COLUMN IF NOT EXISTS rate_currency char(3);

DO $$
DECLARE n integer;
BEGIN
  UPDATE ticket_categories tc
  SET rate_currency = p.currency_code
  FROM partners p
  WHERE p.id = tc.partner_id AND tc.default_hourly_rate IS NOT NULL AND tc.rate_currency IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: backfilled rate_currency on % ticket_categories from owning partner', n; END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE ticket_categories
    ADD CONSTRAINT ticket_categories_rate_currency_chk
    CHECK (default_hourly_rate IS NULL OR rate_currency IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN
  NULL; -- idempotent re-run
END $$;

-- 5) NOT VALID FKs to supported_currencies on all four columns; validate
--    opportunistically (off-list rows only block VALIDATE → WARNING).
DO $$
DECLARE spec text[];
BEGIN
  FOREACH spec SLICE 1 IN ARRAY ARRAY[
    ['time_entries', 'currency_code'],
    ['ticket_parts', 'currency_code'],
    ['org_ticket_settings', 'rate_currency'],
    ['ticket_categories', 'rate_currency']
  ] LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES supported_currencies(code) NOT VALID',
        spec[1], spec[1] || '_' || spec[2] || '_fkey', spec[2]);
    EXCEPTION WHEN duplicate_object THEN
      NULL; -- idempotent re-run
    END;
    BEGIN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', spec[1], spec[1] || '_' || spec[2] || '_fkey');
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE WARNING 'multi-currency: %.% has off-list currency rows; % left NOT VALID',
        spec[1], spec[2], spec[1] || '_' || spec[2] || '_fkey';
    END;
  END LOOP;
END $$;
