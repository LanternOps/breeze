-- 2026-10-11-140000-custom-field-no-cross-axis-shadowing.sql   (#3257 W03)
--
-- ONE EFFECTIVE field_key NAMESPACE PER DEVICE.
--
-- custom_field_definitions is dual-axis (org_id XOR partner_id, W02's
-- custom_field_definitions_one_owner_chk), but devices.custom_fields is a FLAT
-- jsonb object keyed by a bare string. When an org-owned `udf7` and a
-- partner-wide `udf7` both exist for one org, that ONE datum has TWO
-- definitions, and three things break at once:
--
--   1. The partner export emits TWO records for the one datum, each under a
--      different synthetic id, because the identity hash includes f.id
--      (routes/partnerApi/configuration.ts:436,439).
--   2. #3257 W05's normalized device_custom_field_values table cannot project
--      back into the jsonb without loss -- two definition_ids, one key.
--   3. W05's backfill cannot attribute an EXISTING blob value to one of the
--      two definitions, because the blob records no definition_id and the two
--      definitions may disagree on `type` and on dropdown `options`.
--
-- WHY A TRIGGER AND NOT AN INDEX. The rule is "the partner-wide key set and
-- the union of that partner's org-owned key sets are disjoint". That spans two
-- NULLABLE ownership columns over DISJOINT row sets, and the partner half of
-- the pair is not even on the org-owned row -- it is reached through
-- organizations.partner_id. No index can express it (which is why W02 needed
-- two PARTIAL unique indexes rather than one composite). W02 deliberately left
-- this cross-axis case legal and pinned it as a passing boundary case in
-- customFieldDefinitionIntegrity.integration.test.ts; this file closes it.
--
-- Existing shadowed pairs are REPORTED, never resolved. Deleting either
-- definition silently retypes or orphans every value already stored under that
-- key (the survivor dictates `type`; values carry none), and consumers hold the
-- key as configuration (services/remoteAccessLauncher.ts `provider.customFieldKey`,
-- services/installerVariables.ts). So this file WARNs the count and the
-- affected pairs, then RAISEs to abort the deploy: a WARNING alone returns
-- SUCCESS and autoMigrate records the file as applied FOREVER (db/autoMigrate.ts
-- wraps each file in client.begin; only an exception rolls it back), which
-- would leave prod permanently without the trigger while the ledger claims
-- otherwise. A read-only preflight
-- (migrations/preflight/2026-10-11-140000-custom-field-shadowing-preflight.sql)
-- ran against both prod regions before this merged -- see the PR body.
--
-- WHY THE SCOPE ELEVATION, on a file that writes no rows. CLAUDE.md states the
-- rule for WRITES, but the same mechanism silently corrupts a detection READ,
-- and here that is the more dangerous half (the lesson W02 banked).
-- custom_field_definitions and organizations are both FORCE ROW LEVEL
-- SECURITY, which binds the table OWNER -- the role migrations run as.
-- breeze_current_scope() defaults to 'none', under which breeze_has_org_access
-- and breeze_has_partner_access are both false, so on any connection that does
-- not bypass RLS (prod is managed DO Postgres, where migrations run as the
-- non-superuser `doadmin`) the detection block below would join ZERO rows to
-- ZERO rows and cheerfully RAISE WARNING '... 0 cross-axis shadowed keys'. The
-- deploy would then proceed to install the trigger over dirty data, and the
-- first operator to touch either definition would get an unactionable P0001
-- from a trigger nobody knew was armed. CI runs as a superuser and would never
-- reveal the difference. set_config(..., true) is transaction-local, and
-- autoMigrate's per-file client.begin is that transaction.
SELECT set_config('breeze.scope', 'system', true);

-- Blindness probe. Prints what the detection block below is actually able to
-- see BEFORE it reports a verdict, so a "0 shadowed keys" line can be trusted.
-- A total_rows of 0 on a region known to have custom fields configured, or an
-- effective_scope that is not 'system', means the elevation above did not take
-- and the verdict is worthless.
DO $$
DECLARE eff text; total bigint; org_rows bigint; partner_rows bigint;
BEGIN
  SELECT public.breeze_current_scope() INTO eff;
  SELECT count(*),
         count(*) FILTER (WHERE org_id IS NOT NULL),
         count(*) FILTER (WHERE partner_id IS NOT NULL)
    INTO total, org_rows, partner_rows
    FROM public.custom_field_definitions;
  RAISE WARNING 'custom_field_definitions shadowing probe: effective_scope=%, total_rows=%, org_rows=%, partner_rows=%',
    eff, total, org_rows, partner_rows;
  IF eff <> 'system' THEN
    RAISE EXCEPTION 'custom_field_definitions shadowing detection is RLS-blind (effective scope %); refusing to report a verdict', eff
      USING ERRCODE = 'P0001';
  END IF;
END $$;

-- Detection: org-owned keys that shadow a partner-wide key under the SAME
-- partner. Abort with the offending pairs so the operator can act without
-- running a second query.
DO $$
DECLARE n bigint; pairs text;
BEGIN
  SELECT count(*),
         string_agg(o.partner_id::text || ' / ' || f_org.field_key, ', '
                    ORDER BY o.partner_id::text, f_org.field_key)
    INTO n, pairs
    FROM public.custom_field_definitions f_org
    JOIN public.organizations o ON o.id = f_org.org_id
   WHERE EXISTS (
     SELECT 1 FROM public.custom_field_definitions f_p
      WHERE f_p.org_id IS NULL
        AND f_p.partner_id = o.partner_id
        AND f_p.field_key = f_org.field_key);
  IF n > 0 THEN
    RAISE WARNING 'custom_field_definitions: % org-owned key(s) shadow a partner-wide key: %', n, pairs;
    RAISE EXCEPTION 'custom_field_definitions has % cross-axis shadowed key(s); reconcile them by hand before deploying -- see the migration header', n
      USING ERRCODE = 'P0001';
  ELSE
    RAISE WARNING 'custom_field_definitions: 0 cross-axis shadowed keys';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The enforcement trigger.
--
-- READ THIS BEFORE CHANGING THE FUNCTION HEADER. Both `SET` clauses are
-- load-bearing and neither is boilerplate.
--
--   SET search_path = pg_catalog, public
--     Standard SECURITY DEFINER hygiene: the function must not resolve
--     `custom_field_definitions` through a caller-controlled search_path.
--
--   SET "breeze.scope" = 'system'
--     WITHOUT THIS THE TRIGGER IS A NO-OP FOR THE EXACT CASE IT EXISTS TO
--     CATCH. The blind spot is not hypothetical and it is not symmetric:
--
--       * An ORG-scoped session inserting an org-owned `udf7` must look for a
--         PARTNER-WIDE `udf7`. custom_field_definitions has no partner-wide
--         SELECT branch yet (it sits in PARTNER_WIDE_SELECT_BRANCH_EXEMPT in
--         rls-coverage.integration.test.ts against open follow-up #4944), so an
--         org token CANNOT see partner-wide rows at all. An unelevated lookup
--         returns nothing and the shadowing insert is waved through -- and that
--         is the single most common way this collision gets created, because
--         the POST /custom-fields handler pins orgId = auth.orgId for every
--         org-scoped caller (routes/customFields.ts).
--       * A PARTNER-scoped session inserting a partner-wide key must look at
--         org-owned rows across ALL of that partner's orgs -- including orgs
--         outside the caller's own accessible_org_ids.
--
--     SECURITY DEFINER DOES NOT FIX THIS, AND HIDES IT IN CI. It switches to the
--     function OWNER -- the role that applied the migration. Locally and in CI
--     that role is a BYPASSRLS SUPERUSER (breeze_test: rolsuper=t,
--     rolbypassrls=t), which ignores RLS outright, so the guard behaves
--     identically with or without this line. In PRODUCTION the owner is
--     `doadmin` on managed DO Postgres: not a superuser, and bound by FORCE ROW
--     LEVEL SECURITY like every other role. RLS visibility is then decided by
--     the `breeze.scope` GUC that breeze_has_org_access /
--     breeze_has_partner_access read (0008-tenant-rls.sql,
--     2026-04-11-a-rls-function-bootstrap.sql).
--
--     MEASURED, not assumed (local PG16, this migration set, A/B with the SET
--     clause as the sole variable): two otherwise identical SECURITY DEFINER
--     lookups reassigned to the non-superuser `breeze_app` and called under an
--     org-scoped context returned unelevated => row NOT found, elevated => row
--     found. And with `ALTER FUNCTION ... RESET "breeze.scope"` applied, every
--     behavioural test in customFieldShadowing.integration.test.ts still passed.
--     So NO behavioural test can defend this line on a superuser stack; the
--     catalog assertion in that suite ('pins the function-level scope
--     elevation') is what does. Do not delete either half.
--
--     WHY THE FUNCTION-LEVEL `SET` AND NOT set_config() IN THE BODY. A
--     function-level SET is saved on entry and restored by PostgreSQL when the
--     function exits -- normally OR through an error, because it unwinds with
--     the GUC nest level. A hand-rolled set_config('breeze.scope','system',true)
--     in the body would leave the CALLER'S transaction running at system scope
--     on every path that does not reach an explicit restore, which is a
--     tenant-isolation hole an order of magnitude worse than the bug being
--     fixed. The elevation here is bounded to this function body, which does
--     nothing but two SELECTs and a RAISE -- no writes, no dynamic SQL.
--
-- ON `CONSTRAINT =` IN THE RAISEs. P0001 is Postgres's GENERIC code for any
-- unqualified RAISE EXCEPTION, so a route branching on the code alone would
-- mislabel a future unrelated P0001 raised by some other trigger on this table.
-- Setting CONSTRAINT makes the error self-identifying: it lands on the driver
-- error as `constraint_name`, reachable via pgErrorNode(), so a caller that
-- ever needs to disambiguate can, without parsing the message. Nothing depends
-- on it today (routes/customFields.ts matches P0001, which is currently unique
-- to this trigger on this table) -- it is here so that stays cheap to fix.
--
-- ON THE ERROR MESSAGE. It names the field_key and the axis it collides on,
-- and deliberately NOTHING else -- not the other definition's id, name, or
-- owning org. An org-scoped caller cannot otherwise see partner-wide rows, so
-- the message is the minimum disclosure needed to make the refusal actionable
-- ("your partner already owns this key") without turning the trigger into a
-- partner-wide field enumeration oracle.
--
-- ON THE ADVISORY LOCK. Two concurrent transactions -- one inserting the
-- org-owned side, one the partner-wide side -- would each run their own EXISTS
-- check, each see nothing (READ COMMITTED cannot see the other's uncommitted
-- row), and both commit. pg_advisory_xact_lock on (partner, field_key)
-- serializes them: both branches derive the SAME lock key from the SAME
-- partner uuid and field_key, so the loser blocks until the winner commits and
-- then sees the committed row. Class id 1000257 = issue #3257; the existing
-- 10002xx/10003xx classes belong to the partner-export and config-assignment
-- serializers (2026-07-21-partner-export-canonical-org-mutations.sql,
-- 2026-07-30-serialize-bulk-config-assignment-target-moves.sql).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_custom_field_no_cross_axis_shadow()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET "breeze.scope" = 'system'
AS $$
DECLARE
  owner_partner uuid;
  conflicting   uuid;
BEGIN
  IF NEW.org_id IS NOT NULL THEN
    SELECT o.partner_id INTO owner_partner
      FROM public.organizations o
     WHERE o.id = NEW.org_id;

    -- owner_partner can only be NULL when the SELECT found NO ROW, i.e.
    -- NEW.org_id does not reference an existing organization
    -- (organizations.partner_id is itself NOT NULL, so a real org always has
    -- one). There is no partner namespace to check against, and the row is
    -- doomed regardless: custom_field_definitions.org_id carries an FK, and FK
    -- checks run AFTER BEFORE-ROW triggers, so returning here hands the write
    -- to the FK, which rejects it with 23503. Raising our own P0001 instead
    -- would replace an accurate "no such organization" with a misleading
    -- shadowing message.
    IF owner_partner IS NULL THEN
      RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(1000257, hashtext(owner_partner::text || ':' || NEW.field_key));

    SELECT f.id INTO conflicting
      FROM public.custom_field_definitions f
     WHERE f.org_id IS NULL
       AND f.partner_id = owner_partner
       AND f.field_key = NEW.field_key
     LIMIT 1;

    IF conflicting IS NOT NULL THEN
      RAISE EXCEPTION 'custom field key "%" already exists as an all-organizations field for this partner', NEW.field_key
        USING ERRCODE = 'P0001', CONSTRAINT = 'custom_field_definitions_no_shadow';
    END IF;

  ELSIF NEW.partner_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(1000257, hashtext(NEW.partner_id::text || ':' || NEW.field_key));

    SELECT f.id INTO conflicting
      FROM public.custom_field_definitions f
      JOIN public.organizations o ON o.id = f.org_id
     WHERE o.partner_id = NEW.partner_id
       AND f.field_key = NEW.field_key
     LIMIT 1;

    IF conflicting IS NOT NULL THEN
      RAISE EXCEPTION 'custom field key "%" is already defined by at least one organization under this partner', NEW.field_key
        USING ERRCODE = 'P0001', CONSTRAINT = 'custom_field_definitions_no_shadow';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.breeze_custom_field_no_cross_axis_shadow() IS
  'BEFORE-write guard for custom_field_definitions (#3257 W03): an org-owned field_key may not collide with a partner-wide field_key under that org''s partner, or vice versa. Runs at system scope so its lookups are not RLS-blind - see the migration header.';

-- BEFORE INSERT OR UPDATE OF the three columns that can move a row into a
-- different namespace. A row that only renames its `name` or flips
-- `script_write` cannot create a collision, so it does not pay for the lookup.
--
-- NOTE ON ORDERING: as a BEFORE ROW trigger this fires ahead of the RLS
-- WITH CHECK policy and ahead of the table's CHECK constraints (ExecInsert
-- runs BR triggers, then ExecWithCheckOptions, then ExecConstraints). So a
-- shadowing insert surfaces as this P0001 even under a tenant context -- it is
-- NOT masked by a 42501 the way W02's XOR CHECK violation is. Pinned in
-- customFieldShadowing.integration.test.ts.
DROP TRIGGER IF EXISTS custom_field_definitions_no_shadow ON public.custom_field_definitions;
CREATE TRIGGER custom_field_definitions_no_shadow
  BEFORE INSERT OR UPDATE OF org_id, partner_id, field_key
  ON public.custom_field_definitions
  FOR EACH ROW
  EXECUTE FUNCTION public.breeze_custom_field_no_cross_axis_shadow();
