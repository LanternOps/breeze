-- Multi-currency wave 1 (spec §5): org-level currency, backfilled from the
-- owning partner; normalization + anomaly audit of existing currency values;
-- NOT VALID FKs to supported_currencies (validated opportunistically).
-- Deliberately NO column DEFAULT on organizations.currency_code: every
-- creation path must stamp explicitly (fail-loudly contract).
-- Depends on 2026-08-27-a-supported-currencies.sql (same-date -a-/-b- infix).

-- 1) Add nullable, backfill from partner, then SET NOT NULL.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS currency_code char(3);

DO $$
DECLARE n integer;
BEGIN
  UPDATE organizations o
  SET currency_code = upper(trim(p.currency_code))
  FROM partners p
  WHERE p.id = o.partner_id AND o.currency_code IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: backfilled currency_code on % organizations from partner default', n; END IF;
END $$;

ALTER TABLE organizations ALTER COLUMN currency_code SET NOT NULL;

-- 2) Normalize existing stored values (free-text era could hold 'usd'/' EUR').
DO $$
DECLARE n integer;
BEGIN
  UPDATE partners SET currency_code = upper(trim(currency_code))
    WHERE currency_code <> upper(trim(currency_code));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: case-normalized partners.currency_code on % rows', n; END IF;

  UPDATE invoices SET currency_code = upper(trim(currency_code))
    WHERE currency_code <> upper(trim(currency_code));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: case-normalized invoices.currency_code on % rows', n; END IF;

  UPDATE quotes SET currency_code = upper(trim(currency_code))
    WHERE currency_code <> upper(trim(currency_code));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: case-normalized quotes.currency_code on % rows', n; END IF;

  UPDATE contracts SET currency_code = upper(trim(currency_code))
    WHERE currency_code <> upper(trim(currency_code));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: case-normalized contracts.currency_code on % rows', n; END IF;
END $$;

-- 3) Anomaly audit: off-list values are REPORTED, never rewritten (spec §5 —
-- issued documents are immutable; a bogus historical code is forensic data).
DO $$
DECLARE t text; n integer;
BEGIN
  FOREACH t IN ARRAY ARRAY['partners','organizations','invoices','quotes','contracts'] LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I x WHERE NOT EXISTS (SELECT 1 FROM supported_currencies sc WHERE sc.code = x.currency_code)', t)
      INTO n;
    IF n > 0 THEN
      RAISE WARNING 'multi-currency: % rows in % carry an off-list currency_code (left as-is; FK stays NOT VALID until cleaned)', n, t;
    END IF;
  END LOOP;
END $$;

-- 4) NOT VALID FKs: enforce new writes immediately; existing bad rows only
-- block VALIDATE, which we attempt and downgrade to a warning.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partners','organizations','invoices','quotes','contracts'] LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (currency_code) REFERENCES supported_currencies(code) NOT VALID',
        t, t || '_currency_code_fkey');
    EXCEPTION WHEN duplicate_object THEN
      NULL; -- idempotent re-run
    END;
    BEGIN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', t, t || '_currency_code_fkey');
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE WARNING 'multi-currency: % has off-list currency rows; %_currency_code_fkey left NOT VALID', t, t;
    END;
  END LOOP;
END $$;
