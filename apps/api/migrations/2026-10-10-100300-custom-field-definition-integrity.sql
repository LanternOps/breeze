-- 2026-10-10-100300-custom-field-definition-integrity.sql
--
-- custom_field_definitions ships with a PK and two FKs and nothing else
-- (0001-baseline.sql:6761-6766, 11891-11907; no later migration adds an
-- index), which leaves two defects that #3257's definitions importer would
-- industrialise:
--
--   1. No unique key on field_key, so an import has no idempotency key and a
--      re-run mints a duplicate udf7. Two definitions with one key also make
--      the partner export emit two records for one datum, because the identity
--      hash includes f.id (routes/partnerApi/configuration.ts).
--   2. (org_id, partner_id) = (NULL, NULL) is structurally legal. Such a row is
--      invisible to every non-system caller AND survives org cascade forever,
--      because the cascade deletes by org_id. A latent GDPR orphan.
--
-- Existing duplicates are REPORTED, never resolved. Deleting one silently
-- retypes every value stored under that key (the survivor dictates `type`;
-- values carry none) and renaming one orphans every value instantly, breaking
-- consumers that hold the key as configuration (services/remoteAccessLauncher.ts
-- `provider.customFieldKey`, services/installerVariables.ts). So this file
-- WARNs the count and the affected pairs, then RAISEs to abort the deploy: a
-- WARNING alone returns success and autoMigrate records the file as applied
-- forever (db/autoMigrate.ts wraps each file in client.begin; only an exception
-- rolls it back). A read-only preflight
-- (migrations/preflight/2026-10-10-100300-custom-field-definition-integrity-preflight.sql)
-- ran against both prod regions before this merged -- see the PR body.
--
-- WHY THE SCOPE ELEVATION, on a file that writes no rows. CLAUDE.md states the
-- rule for WRITES, but the same mechanism silently corrupts a detection READ,
-- and here that is the more dangerous half. custom_field_definitions is FORCE
-- ROW LEVEL SECURITY, which binds the table OWNER -- the role migrations run
-- as. breeze_current_scope() defaults to 'none', under which
-- breeze_has_org_access / breeze_has_partner_access are both false, so on any
-- connection that does not bypass RLS (prod is managed DO Postgres, where
-- migrations run as the non-superuser `doadmin`) the two SELECT count(*) probes
-- below would match ZERO rows and cheerfully RAISE WARNING '... 0 duplicate
-- pairs'. The deploy would still abort -- but on the CREATE UNIQUE INDEX /
-- ADD CONSTRAINT below, which are DDL and read the heap directly, i.e. with a
-- bare 23505/23514 naming an index instead of the actionable owner/field_key
-- list this file exists to print. CI runs as a superuser and would never
-- reveal the difference. set_config(..., true) is transaction-local, and
-- autoMigrate's per-file client.begin is that transaction.
SELECT set_config('breeze.scope', 'system', true);

-- (a) Duplicate field_key within one owner. Abort with the offending pairs.
DO $$
DECLARE n bigint; pairs text;
BEGIN
  SELECT count(*), string_agg(owner || ' / ' || field_key, ', ' ORDER BY owner, field_key)
    INTO n, pairs
    FROM (
      SELECT COALESCE(org_id::text, 'partner:' || partner_id::text) AS owner, field_key
        FROM public.custom_field_definitions
       GROUP BY 1, 2 HAVING count(*) > 1
    ) d;
  IF n > 0 THEN
    RAISE WARNING 'custom_field_definitions: % duplicate (owner, field_key) pairs: %', n, pairs;
    RAISE EXCEPTION 'custom_field_definitions has % duplicate (owner, field_key) pairs; resolve them by hand before deploying -- see the migration header', n
      USING ERRCODE = 'P0001';
  ELSE
    RAISE WARNING 'custom_field_definitions: 0 duplicate (owner, field_key) pairs';
  END IF;
END $$;

-- (b) Ownerless or dual-owner rows that the XOR will reject.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.custom_field_definitions
   WHERE (org_id IS NULL) = (partner_id IS NULL);
  IF n > 0 THEN
    RAISE WARNING 'custom_field_definitions: % ownerless or dual-owner rows', n;
    RAISE EXCEPTION 'custom_field_definitions has % rows violating the org XOR partner rule', n
      USING ERRCODE = 'P0001';
  ELSE
    RAISE WARNING 'custom_field_definitions: 0 ownerless or dual-owner rows';
  END IF;
END $$;

-- Exactly one owner. Mirrors cis_baselines_one_owner_chk and the
-- 2026-07-01-*-partner-ownership.sql family. Guarded on pg_constraint rather
-- than DROP-then-ADD so a re-apply does not revalidate the whole table; the
-- constraint name is new in this file, so there is no prior definition to
-- supersede.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'custom_field_definitions_one_owner_chk'
  ) THEN
    ALTER TABLE public.custom_field_definitions
      ADD CONSTRAINT custom_field_definitions_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

-- Two PARTIAL unique indexes, not one composite: uniqueness has to hold within
-- each axis independently, and a composite over two nullable columns would
-- treat every NULL as distinct and enforce nothing (every partner-wide row has
-- org_id NULL, so the partner axis would be unguarded).
--
-- These deliberately do NOT prevent an org-owned key from shadowing a
-- partner-wide one with the same field_key -- that is a cross-axis rule, and
-- W03's anti-shadowing trigger owns it. Pinned as a passing boundary case in
-- customFieldDefinitionIntegrity.integration.test.ts so W03's own red test is
-- unambiguous about what it changed.
CREATE UNIQUE INDEX IF NOT EXISTS custom_field_definitions_org_key_uq
  ON public.custom_field_definitions (org_id, field_key) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS custom_field_definitions_partner_key_uq
  ON public.custom_field_definitions (partner_id, field_key) WHERE partner_id IS NOT NULL;
