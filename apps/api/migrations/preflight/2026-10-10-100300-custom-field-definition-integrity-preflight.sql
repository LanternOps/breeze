-- READ-ONLY preflight for 2026-10-10-100300-custom-field-definition-integrity.sql.
-- Run on EACH prod region before merging. Queries (a) and (b) must be empty.
--
-- This file lives under migrations/preflight/ and is NEVER applied by the
-- runner: `autoMigrate` does a NON-RECURSIVE readdir of the migrations root
-- and keeps only names matching /^\d{4}-.*\.sql$/ (db/autoMigrate.ts), so the
-- subdirectory entry "preflight" is filtered out and its contents are never
-- read. Same arrangement as migrations/optional/.
--
-- Why it exists: the integrity migration ABORTS the deploy (RAISE EXCEPTION)
-- when it finds either condition below, and a deploy is the wrong place to
-- discover that. Existing duplicates are REPORTED, never auto-resolved --
-- deleting one silently retypes every value stored under that key (the
-- survivor dictates `type`; values carry none), and renaming one orphans every
-- value instantly and breaks consumers that hold the key as configuration
-- (services/remoteAccessLauncher.ts `provider.customFieldKey`,
-- services/installerVariables.ts).
--
-- If (a) comes back NON-EMPTY: stop and escalate. Do not resolve by hand
-- without an explicit decision on which definition's `type` and dropdown
-- `options` win for that key.
--
-- ============================ READ THIS FIRST ============================
-- THE SCOPE ELEVATION BELOW IS LOAD-BEARING. DO NOT DROP IT, and do not run
-- these two queries standalone without it.
--
-- custom_field_definitions is FORCE ROW LEVEL SECURITY, which binds the table
-- OWNER as well as ordinary roles. `breeze_current_scope()` defaults to 'none'
-- (0012-tenant-rls-deny-default.sql), under which breeze_has_org_access and
-- breeze_has_partner_access are both false -- and the table's dual-axis policy
-- (2026-06-11-i-custom-fields-dual-axis-rls.sql) is exactly the OR of those
-- two. So on any connection that does not bypass RLS -- which includes prod,
-- managed DO Postgres reached as the non-superuser `doadmin` -- an unelevated
-- run of (a) and (b) returns ZERO ROWS WHILE COMPLETELY BLIND, and an operator
-- reads that empty result as "clean". That false negative is the entire
-- failure mode this preflight exists to prevent, so it must not be reachable
-- from the preflight itself.
--
-- Query (0) makes blindness self-evident rather than silent: it prints the
-- effective scope and a total row count. If `total_rows` is 0 on a region that
-- demonstrably has custom fields configured, you are blind -- fix the
-- connection, do NOT report "clean".
--
-- Wrapped in BEGIN READ ONLY / ROLLBACK so the elevation is transaction-local
-- (set_config's third argument is is_local=true, which needs an explicit
-- transaction to span more than one statement) and so the session cannot
-- write anything even by accident. The "no inner BEGIN/COMMIT" migration rule
-- does NOT apply here -- that rule exists because autoMigrate wraps each
-- migration file in its own transaction, and this file is never run by
-- autoMigrate.
-- =========================================================================

BEGIN READ ONLY;

SELECT set_config('breeze.scope', 'system', true);

-- (0) Sanity: prove the connection is NOT RLS-blind before trusting (a)/(b).
SELECT public.breeze_current_scope() AS effective_scope,
       count(*)                     AS total_rows
  FROM public.custom_field_definitions;

-- (a) duplicate field_key within one owner
SELECT COALESCE(org_id::text, 'partner:' || partner_id::text) AS owner,
       field_key, count(*) AS n, array_agg(id ORDER BY created_at) AS ids
  FROM public.custom_field_definitions
 GROUP BY 1, 2 HAVING count(*) > 1
 ORDER BY n DESC;

-- (b) ownerless (or dual-owner) rows that the XOR will reject
SELECT id, field_key, name, created_at
  FROM public.custom_field_definitions
 WHERE (org_id IS NULL) = (partner_id IS NULL)
 ORDER BY created_at;

ROLLBACK;
