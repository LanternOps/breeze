SELECT set_config('breeze.scope', 'system', true);
-- WRITES BILLING DATA. System scope must precede every write: FORCE RLS
-- binds the owner too; without it updates can silently match zero rows.
-- NEVER add this file to the migrationRlsScope.test.ts frozen baseline.
-- autoMigrate owns the transaction. The partner marker, NOT profile existence,
-- guards the whole conversion. Existing time-entry snapshots are untouched.
--
-- Category grouping, currency union, names and report populations mirror
-- scripts/labour-pricing-dry-run.lib.ts. Two necessary extensions:
-- * Existing custom names get collision suffixes; configured default cards
--   survive as non-default cards so they cannot contaminate legacy pricing.
--   Existing assignments are repointed to the converted legacy answer too.
-- * A billable-only org override recovers the original category rate, even
--   when the default card dropped it as non-billable. A literal clone would
--   lose a BILLABLE legacy price (not one of the two declared differences).
DO $$
DECLARE
  p record;
  name_group record;
  category_group record;
  org record;
  category_row record;
  currencies text[];
  currency text;
  profile_id uuid;
  override_id uuid;
  work_type_id uuid;
  candidate_name text;
  base_name text;
  parent_path text;
  suffix integer;
  pricing_count integer;
  row_coverage text;
  row_rate numeric(10,2);
  base_coverage text;
  base_rate numeric(10,2);
  n bigint;
BEGIN
  -- Lock also serializes an accidental concurrent replay for the same partner.
  FOR p IN SELECT id, currency_code FROM partners
    WHERE labour_pricing_converted_at IS NULL ORDER BY id FOR UPDATE
  LOOP
    SELECT coalesce(array_agg(code ORDER BY code), ARRAY[]::text[]) INTO currencies FROM (
      SELECT p.currency_code::text AS code
      UNION SELECT o.currency_code::text FROM organizations o WHERE o.partner_id = p.id
      UNION SELECT c.rate_currency::text FROM ticket_categories c
        WHERE c.partner_id = p.id AND c.default_hourly_rate IS NOT NULL AND c.rate_currency IS NOT NULL
    ) all_currencies
    WHERE EXISTS (SELECT 1 FROM supported_currencies sc WHERE sc.code = all_currencies.code);

    -- These are source populations, not numbers of generated rows. In
    -- particular, report matching-rate orgs even with ZERO recent entries,
    -- exactly as buildDryRunReport does. Always log both, including zero.
    SELECT count(*) INTO n FROM organizations o JOIN org_ticket_settings s ON s.org_id = o.id
      WHERE o.partner_id = p.id AND s.default_billable IS NULL
        AND s.default_hourly_rate IS NOT NULL AND s.rate_currency = o.currency_code;
    RAISE WARNING 'partner %: DECLARED DIFFERENCE 1: % NULL-billable orgs with matching rates; uncategorised work becomes billable', p.id, n;
    SELECT count(*) INTO n FROM ticket_categories c WHERE c.partner_id = p.id
      AND c.default_billable = false AND c.default_hourly_rate IS NOT NULL;
    RAISE WARNING 'partner %: DECLARED DIFFERENCE 2: % non-billable category rates dropped', p.id, n;
    SELECT count(*) INTO n FROM ticket_categories c WHERE c.partner_id = p.id
      AND c.default_billable = true AND c.default_hourly_rate IS NOT NULL
      AND EXISTS (SELECT 1 FROM unnest(currencies) code WHERE code IS DISTINCT FROM c.rate_currency::text);
    IF n > 0 THEN RAISE WARNING 'partner %: % category rates skipped in non-matching cards (counted once per category)', p.id, n; END IF;

    FOREACH currency IN ARRAY currencies LOOP
      -- Task 5 may already have created a pristine default. Reuse that; keep
      -- a hand-made configured card intact but retire its default designation.
      UPDATE billing_profiles bp SET is_default = false
        WHERE bp.partner_id = p.id AND bp.currency_code = currency AND bp.is_default AND bp.is_active
          AND (bp.base_coverage <> 'billable' OR bp.base_hourly_rate IS NOT NULL
            OR bp.base_minimum_minutes IS NOT NULL OR bp.rounding_increment_minutes IS NOT NULL
            OR EXISTS (SELECT 1 FROM billing_profile_rules r WHERE r.billing_profile_id = bp.id));
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN RAISE WARNING 'partner % currency %: % configured defaults retained as non-default cards', p.id, currency, n; END IF;
      SELECT id INTO profile_id FROM billing_profiles
        WHERE partner_id = p.id AND currency_code = currency AND is_default AND is_active;
      suffix := 0;
      WHILE profile_id IS NULL LOOP
        candidate_name := CASE WHEN suffix = 0 THEN format('Standard rates (%s)', currency)
          ELSE format('Standard rates (%s %s)', currency, suffix) END;
        INSERT INTO billing_profiles (partner_id, name, currency_code, is_default, base_coverage)
          VALUES (p.id, candidate_name, currency, true, 'billable')
          ON CONFLICT DO NOTHING RETURNING id INTO profile_id;
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n > 0 THEN RAISE WARNING 'partner %: created % default cards named %', p.id, n, candidate_name; END IF;
        IF profile_id IS NULL THEN
          SELECT id INTO profile_id FROM billing_profiles
            WHERE partner_id = p.id AND currency_code = currency AND is_default AND is_active;
        END IF;
        suffix := suffix + 1;
      END LOOP;
    END LOOP;

    -- Match the dry-run's insertion order: name groups by their first UUID,
    -- then pricing groups by their first UUID. Numeric equality normalizes
    -- decimal scale; NULL currency stays distinct, even when rate is dropped.
    FOR name_group IN
      SELECT lower(c.name) AS key, min(c.id::text) AS first_id
      FROM ticket_categories c WHERE c.partner_id = p.id
        AND (c.default_hourly_rate IS NOT NULL OR c.default_billable = false)
      GROUP BY lower(c.name) ORDER BY min(c.id::text)
    LOOP
      SELECT count(*) INTO pricing_count FROM (
        SELECT c.default_billable, c.default_hourly_rate, c.rate_currency
        FROM ticket_categories c WHERE c.partner_id = p.id AND lower(c.name) = name_group.key
          AND (c.default_hourly_rate IS NOT NULL OR c.default_billable = false)
        GROUP BY c.default_billable, c.default_hourly_rate, c.rate_currency
      ) prices;
      FOR category_group IN
        SELECT (array_agg(c.id ORDER BY c.id))[1] AS id,
          (array_agg(c.name ORDER BY c.id))[1] AS name,
          array_agg(c.id ORDER BY c.id) AS ids, bool_or(c.is_active) AS is_active,
          c.default_billable, c.default_hourly_rate, c.rate_currency
        FROM ticket_categories c WHERE c.partner_id = p.id AND lower(c.name) = name_group.key
          AND (c.default_hourly_rate IS NOT NULL OR c.default_billable = false)
        GROUP BY c.default_billable, c.default_hourly_rate, c.rate_currency
        ORDER BY min(c.id::text)
      LOOP
        base_name := category_group.name;
        IF pricing_count > 1 THEN
          WITH RECURSIVE ancestors AS (
            SELECT parent.id, parent.parent_id, ARRAY[parent.name::text] AS names,
              ARRAY[child.id, parent.id] AS visited
            FROM ticket_categories child JOIN ticket_categories parent ON parent.id = child.parent_id
            WHERE child.id = category_group.id AND parent.partner_id = p.id AND parent.id <> child.id
            UNION ALL
            SELECT parent.id, parent.parent_id, parent.name::text || a.names, a.visited || parent.id
            FROM ancestors a JOIN ticket_categories parent ON parent.id = a.parent_id
            WHERE parent.partner_id = p.id AND NOT parent.id = ANY(a.visited)
          ) SELECT array_to_string(names, ' / ') INTO parent_path FROM ancestors
            ORDER BY cardinality(visited) DESC LIMIT 1;
          base_name := format('%s (%s)', category_group.name, coalesce(parent_path, 'Root'));
        END IF;
        candidate_name := base_name;
        suffix := 0;
        LOOP
          -- Reserve eligible original category names, just like the dry-run;
          -- also reserve pre-existing W01 work types rather than giving them
          -- new billing semantics simply because their name happens to match.
          IF EXISTS (SELECT 1 FROM work_types w WHERE w.partner_id = p.id AND lower(w.name) = lower(candidate_name))
            OR ((pricing_count > 1 OR suffix > 0) AND EXISTS (
              SELECT 1 FROM ticket_categories c WHERE c.partner_id = p.id
                AND (c.default_hourly_rate IS NOT NULL OR c.default_billable = false)
                AND lower(c.name) = lower(candidate_name))) THEN
            candidate_name := format('%s [%s%s]', base_name, category_group.id,
              CASE WHEN suffix = 0 THEN '' ELSE '-' || suffix::text END);
            suffix := suffix + 1;
            CONTINUE;
          END IF;
          INSERT INTO work_types (partner_id, name, is_active)
            VALUES (p.id, candidate_name, category_group.is_active)
            ON CONFLICT DO NOTHING RETURNING id INTO work_type_id;
          GET DIAGNOSTICS n = ROW_COUNT;
          IF n > 0 THEN RAISE WARNING 'partner %: created % work types named % from categories %', p.id, n, candidate_name, category_group.ids; END IF;
          EXIT WHEN work_type_id IS NOT NULL;
        END LOOP;
        IF pricing_count > 1 OR suffix > 0 THEN
          RAISE WARNING 'partner %: category name collision % -> % (categories %)',
            p.id, category_group.name, candidate_name, category_group.ids;
        END IF;
        UPDATE ticket_categories SET default_work_type_id = work_type_id
          WHERE partner_id = p.id AND id = ANY(category_group.ids)
            AND default_work_type_id IS DISTINCT FROM work_type_id;
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n > 0 THEN RAISE WARNING 'partner %: set % category work-type defaults', p.id, n; END IF;

        INSERT INTO billing_profile_rules (partner_id, billing_profile_id, work_type_id, coverage, hourly_rate)
          SELECT p.id, bp.id, work_type_id,
            CASE WHEN category_group.default_billable = false THEN 'non_billable' ELSE 'billable' END,
            CASE WHEN category_group.default_billable = false THEN NULL ELSE category_group.default_hourly_rate END
          FROM billing_profiles bp WHERE bp.partner_id = p.id AND bp.is_default AND bp.is_active
            AND bp.currency_code::text = ANY(currencies)
            AND (category_group.default_billable = false OR
              (category_group.default_hourly_rate IS NOT NULL AND category_group.rate_currency = bp.currency_code))
          ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n > 0 THEN RAISE WARNING 'partner % work type %: created % default-card rows', p.id, work_type_id, n; END IF;
      END LOOP;
    END LOOP;

    -- A pre-existing assignment must not bypass the clean cut for an org
    -- without legacy overrides. Keep its assignment row, point it to the
    -- converted default, and clear human attribution for this system write.
    UPDATE org_billing_profile_assignments a
      SET billing_profile_id = bp.id, assigned_by = NULL, updated_at = now()
      FROM organizations o
      JOIN billing_profiles bp ON bp.partner_id = o.partner_id AND bp.currency_code = o.currency_code
        AND bp.is_default AND bp.is_active
      LEFT JOIN org_ticket_settings s ON s.org_id = o.id
      WHERE a.org_id = o.id AND a.partner_id = p.id AND o.partner_id = p.id
        AND s.default_billable IS NULL AND s.default_hourly_rate IS NULL
        AND a.billing_profile_id IS DISTINCT FROM bp.id;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN RAISE WARNING 'partner %: repointed % pre-existing assignments without legacy overrides to converted defaults', p.id, n; END IF;

    FOR org IN
      SELECT o.id, o.name, o.currency_code, s.default_billable, s.default_hourly_rate, s.rate_currency
      FROM organizations o JOIN org_ticket_settings s ON s.org_id = o.id
      WHERE o.partner_id = p.id AND (s.default_billable IS NOT NULL OR s.default_hourly_rate IS NOT NULL)
      ORDER BY o.id
    LOOP
      IF NOT EXISTS (SELECT 1 FROM supported_currencies sc WHERE sc.code = org.currency_code) THEN
        RAISE WARNING 'partner % org %: off-list currency %; skipping override card (legacy settings unchanged)',
          p.id, org.id, org.currency_code;
        CONTINUE;
      END IF;
      base_coverage := CASE WHEN org.default_billable = false THEN 'non_billable' ELSE 'billable' END;
      base_rate := CASE WHEN base_coverage = 'billable' AND org.rate_currency = org.currency_code
        THEN org.default_hourly_rate ELSE NULL END;
      candidate_name := org.name;
      suffix := 0;
      LOOP
        INSERT INTO billing_profiles (partner_id, name, currency_code, base_coverage, base_hourly_rate)
          VALUES (p.id, candidate_name, org.currency_code, base_coverage, base_rate)
          ON CONFLICT DO NOTHING RETURNING id INTO override_id;
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n > 0 THEN RAISE WARNING 'partner % org %: created % override cards named %', p.id, org.id, n, candidate_name; END IF;
        EXIT WHEN override_id IS NOT NULL;
        candidate_name := format('%s [%s%s]', org.name, org.id,
          CASE WHEN suffix = 0 THEN '' ELSE '-' || suffix::text END);
        suffix := suffix + 1;
      END LOOP;

      -- Reconstruct the clone from its legacy source. This is equivalent to
      -- overlaying the default rows except for true-only org overrides of a
      -- non-billable category with a rate: legacy still bills that rate, so
      -- recover it here. NULL org billability NEVER promotes a non-billable row.
      FOR category_row IN
        SELECT DISTINCT ON (c.default_work_type_id) c.default_work_type_id,
          c.default_billable, c.default_hourly_rate, c.rate_currency
        FROM ticket_categories c WHERE c.partner_id = p.id
          AND (c.default_hourly_rate IS NOT NULL OR c.default_billable = false)
        ORDER BY c.default_work_type_id, c.id
      LOOP
        row_coverage := CASE WHEN coalesce(org.default_billable, category_row.default_billable)
          THEN 'billable' ELSE 'non_billable' END;
        row_rate := CASE WHEN row_coverage = 'billable' THEN coalesce(base_rate,
          CASE WHEN category_row.rate_currency = org.currency_code THEN category_row.default_hourly_rate END)
          ELSE NULL END;
        -- Wrong-currency category rates produce no row (base fallback), as do
        -- rows collapsed by an org override. No currency arithmetic anywhere.
        IF row_coverage IS DISTINCT FROM base_coverage OR row_rate IS DISTINCT FROM base_rate THEN
          INSERT INTO billing_profile_rules (partner_id, billing_profile_id, work_type_id, coverage, hourly_rate)
            VALUES (p.id, override_id, category_row.default_work_type_id, row_coverage, row_rate)
            ON CONFLICT DO NOTHING;
          GET DIAGNOSTICS n = ROW_COUNT;
          IF n > 0 THEN RAISE WARNING 'partner % org % work type %: created % override rows', p.id, org.id, category_row.default_work_type_id, n; END IF;
        END IF;
      END LOOP;
      INSERT INTO org_billing_profile_assignments (partner_id, org_id, billing_profile_id)
        VALUES (p.id, org.id, override_id) ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN RAISE WARNING 'partner % org %: created % assignments', p.id, org.id, n; END IF;
      UPDATE org_billing_profile_assignments SET billing_profile_id = override_id, assigned_by = NULL, updated_at = now()
        WHERE partner_id = p.id AND org_id = org.id AND billing_profile_id IS DISTINCT FROM override_id;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN RAISE WARNING 'partner % org %: replaced % existing assignments with converted legacy pricing', p.id, org.id, n; END IF;
    END LOOP;

    UPDATE partners SET labour_pricing_converted_at = now()
      WHERE id = p.id AND labour_pricing_converted_at IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN RAISE WARNING 'partner %: marked % partners converted', p.id, n; END IF;
  END LOOP;
END $$;
