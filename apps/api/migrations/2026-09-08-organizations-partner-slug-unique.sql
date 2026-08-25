-- 2026-09-08: enforce organizations.slug uniqueness in Postgres (#3967).
--
-- The Drizzle model and three separate service paths already behave as if
-- `organizations.slug` were unique, but NO database constraint has ever
-- existed for it — `0001-baseline.sql` declares the column NOT NULL and
-- nothing more. Two orgs under the same partner could be created with the
-- same slug through the ordinary UI and both returned 201.
--
-- SCOPE: per-partner, case-insensitive, LIFETIME (soft-deleted rows included).
--
--   * Per-partner, not global. `partners.slug` is global because it resolves a
--     globally addressed inbound-email local part
--     (services/inboundEmail/resolvePartner.ts); organization slugs have no
--     such namespace — the only equality lookup on one is the dev seed, and it
--     is already partner-scoped (db/seed.ts). A global index would stop two
--     unrelated MSPs from both onboarding an "acme" and would leak
--     cross-tenant existence through the duplicate 409 that routes/orgs.ts
--     now returns. (Not routes/partnerApi/* — that namespace has its own,
--     pre-existing generic 23505 mapping.)
--
--   * Case-insensitive. Every first-party generator lowercases
--     (orgImport/slug.ts, aiToolsOrgs.slugifyOrgName, the two web slugify
--     helpers), but both HTTP create schemas accept an arbitrary string, so
--     without lower() 'Acme' and 'acme' stay creatable duplicates.
--
--   * Lifetime, NOT `WHERE deleted_at IS NULL`. DELETE /organizations/:id
--     soft-deletes, and the import pipeline deliberately reserves slugs from
--     "every slug under the partner (incl. soft-deleted)"
--     (services/orgImport/index.ts) precisely so its reactivate-a-soft-deleted
--     -org path cannot find the slug re-claimed by a replacement row. A
--     live-rows-only index would let that happen and turn reactivation into a
--     23505.

-- 1) Resolve pre-existing duplicates before the constraint can reject them.
--    Canonical row per (partner_id, lower(slug)) = oldest by created_at (id as
--    a deterministic tie-break); every other row is renamed to
--    '<slug truncated to 91>-<first 8 chars of its uuid>'. 91 + 1 + 8 EXACTLY
--    fills varchar(100) — there is zero slack, so neither number may be
--    changed without the other. Renaming rather than deleting: a duplicate slug is
--    a cosmetic identifier clash, never a reason to drop a tenant's row.
--
--    The rename is not proven collision-free (a pre-existing slug could already
--    look like '<base>-<8 hex>'), and that is deliberate: if one survives, the
--    CREATE UNIQUE INDEX below aborts the whole migration loudly instead of
--    this block silently mangling data a second time.
--
--    RLS: `organizations` is ENABLE + FORCE ROW LEVEL SECURITY
--    (2026-04-11-organizations-rls.sql) and its UPDATE policy is
--    `USING (breeze_has_org_access(id))`, which short-circuits TRUE only for
--    `breeze.scope = 'system'`. FORCE applies to the table OWNER too, and
--    production is DigitalOcean managed Postgres where the admin role is NOT a
--    superuser (see 2026-07-16-td-synnex-sftp-price-file.sql, which documents
--    the same trap). Without the set_config below this UPDATE would match ZERO
--    rows in production while passing every local test on the superuser
--    `breeze` role — the rename would never run, and the index creation below
--    would fail the deploy instead of healing it. `true` = transaction-local,
--    so it unwinds with autoMigrate's per-file transaction.
DO $$
DECLARE
  cleaned integer;
  remaining integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  WITH ranked AS (
    SELECT id,
           slug,
           row_number() OVER (
             PARTITION BY partner_id, lower(slug)
             ORDER BY created_at, id
           ) AS rn
      FROM organizations
  )
  UPDATE organizations o
     SET slug = left(r.slug, 91) || '-' || left(o.id::text, 8),
         updated_at = now()
    FROM ranked r
   WHERE o.id = r.id
     AND r.rn > 1;
  GET DIAGNOSTICS cleaned = ROW_COUNT;
  IF cleaned > 0 THEN
    RAISE WARNING '#3967: renamed % duplicate organizations.slug row(s) to <slug>-<id-prefix> before adding organizations_partner_slug_uniq', cleaned;
  END IF;

  -- Prove the rename actually landed. CREATE UNIQUE INDEX is DDL and is not
  -- RLS-filtered, so it would catch a survivor anyway — but it reports a bare
  -- 23505 with no count. Fail here instead, where the message can say how many
  -- and point at the cause (a rename that itself collided, or an UPDATE that
  -- was filtered to zero rows).
  SELECT count(*) INTO remaining FROM (
    SELECT 1 FROM organizations GROUP BY partner_id, lower(slug) HAVING count(*) > 1
  ) dupes;
  IF remaining > 0 THEN
    RAISE EXCEPTION '#3967: % duplicate (partner_id, lower(slug)) group(s) survived the rename; organizations_partner_slug_uniq cannot be created', remaining;
  END IF;
END $$;

-- 2) The constraint itself. Expression index, so it cannot be expressed as a
--    table constraint. Kept in the same transaction as the cleanup above: a
--    dedupe that lands without the index would be data churn for nothing.
CREATE UNIQUE INDEX IF NOT EXISTS organizations_partner_slug_uniq
  ON organizations (partner_id, lower(slug));
