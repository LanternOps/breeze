-- READ-ONLY preflight for
-- 2026-10-10-140000-custom-field-no-cross-axis-shadowing.sql  (#3257 W03).
--
-- Run on EACH prod region before merging. Query (a) must come back EMPTY.
--
-- This file lives under migrations/preflight/ and is NEVER applied by the
-- runner: `autoMigrate` does a NON-RECURSIVE readdir of the migrations root and
-- keeps only names matching /^\d{4}-.*\.sql$/ (db/autoMigrate.ts), so the
-- subdirectory entry "preflight" is filtered out and its contents are never
-- read. Same arrangement as migrations/optional/ and as W02's preflight
-- (2026-10-10-100300-custom-field-definition-integrity-preflight.sql).
--
-- WHY IT EXISTS. The migration ABORTS the deploy (RAISE EXCEPTION) when it
-- finds any cross-axis shadowed key, and a deploy is the wrong place to
-- discover that. Shadowed pairs are REPORTED, never auto-resolved: the two
-- definitions can disagree on `type` and on dropdown `options`, and
-- devices.custom_fields stores the datum under the bare key with no record of
-- which definition minted it. Deleting either one therefore silently retypes
-- or orphans live values, and consumers hold the key as configuration
-- (services/remoteAccessLauncher.ts `provider.customFieldKey`,
-- services/installerVariables.ts). Reconciliation needs a human decision per
-- pair — which axis keeps the key, and what the loser's values become.
--
-- If (a) comes back NON-EMPTY: stop and escalate. Do NOT merge the migration.
--
-- ============================ READ THIS FIRST ============================
-- THE SCOPE ELEVATION BELOW IS LOAD-BEARING. DO NOT DROP IT, and do not run
-- query (a) standalone without it.
--
-- custom_field_definitions is FORCE ROW LEVEL SECURITY, which binds the table
-- OWNER as well as ordinary roles. `breeze_current_scope()` defaults to 'none'
-- (0012-tenant-rls-deny-default.sql), under which breeze_has_org_access and
-- breeze_has_partner_access are both false — and the table's dual-axis policy
-- (2026-06-11-i-custom-fields-dual-axis-rls.sql) is exactly the OR of those
-- two. So on any connection that does not bypass RLS — which includes prod,
-- managed DO Postgres reached as the non-superuser `doadmin` — an unelevated
-- run of (a) returns ZERO ROWS WHILE COMPLETELY BLIND, and an operator reads
-- that empty result as "clean". That false negative is the entire failure mode
-- this preflight exists to prevent, so it must not be reachable from the
-- preflight itself.
--
-- Query (0) makes blindness self-evident rather than silent: it prints the
-- effective scope and a total row count on BOTH axes. If `total_rows` is 0 on
-- a region that demonstrably has custom fields configured, or if
-- `effective_scope` is not 'system', you are blind — fix the connection, do
-- NOT report "clean".
--
-- Wrapped in BEGIN READ ONLY / ROLLBACK so the elevation is transaction-local
-- (set_config's third argument is is_local=true, which needs an explicit
-- transaction to span more than one statement) and so the session cannot write
-- anything even by accident. The "no inner BEGIN/COMMIT" migration rule does
-- NOT apply here — that rule exists because autoMigrate wraps each migration
-- file in its own transaction, and this file is never run by autoMigrate.
-- =========================================================================

BEGIN READ ONLY;

SELECT set_config('breeze.scope', 'system', true);

-- (0) Sanity: prove the connection is NOT RLS-blind before trusting (a).
--     org_rows and partner_rows are split because a region can legitimately
--     have zero partner-wide definitions while still having org-owned ones;
--     a zero on BOTH where fields are known to exist means blindness.
SELECT public.breeze_current_scope()                              AS effective_scope,
       count(*)                                                   AS total_rows,
       count(*) FILTER (WHERE org_id IS NOT NULL)                 AS org_rows,
       count(*) FILTER (WHERE partner_id IS NOT NULL)             AS partner_rows
  FROM public.custom_field_definitions;

-- (a) Cross-axis shadowed keys: an org-owned field_key that also exists as a
--     partner-wide field_key under that org's OWN partner. Must be EMPTY.
--
--     Same-axis duplicates are NOT this query's business — W02's two partial
--     unique indexes already make them impossible.
SELECT o.partner_id,
       o.id            AS org_id,
       o.name          AS org_name,
       f_org.field_key,
       f_org.id        AS org_definition_id,
       f_org.type      AS org_definition_type,
       f_partner.id    AS partner_definition_id,
       f_partner.type  AS partner_definition_type
  FROM public.custom_field_definitions f_org
  JOIN public.organizations o
    ON o.id = f_org.org_id
  JOIN public.custom_field_definitions f_partner
    ON f_partner.org_id IS NULL
   AND f_partner.partner_id = o.partner_id
   AND f_partner.field_key = f_org.field_key
 ORDER BY o.partner_id, f_org.field_key;

ROLLBACK;
