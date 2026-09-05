-- READ-ONLY preflight for 2026-10-10-100300-custom-field-definition-integrity.sql.
-- Run on EACH prod region before merging. Every result must be empty.
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
