-- READ-ONLY preflight for retiring portal_users.entra_oid / entra_tenant_id
-- (portal registration W10, #11387; plan
-- docs/superpowers/plans/portal/2026-11-21-portal-registration-options-w10-entra-columns-retire.md):
--   gate G1: before PR-A (code removal + final backfill) deploys, run it
--            against v0.130, the last release that dual-writes the columns;
--   gate G2: before PR-B (the drop) merges, run it against release N (PR-A).
-- After PR-B is applied, the columns this file reads no longer exist, and
-- `schema_state` shows that. The file is then history (its integration test
-- was deleted with them). Run it on EACH prod region. Send the output to Todd,
-- and never paste it into a PR or issue: it names portal user and org ids.
--
-- G1 PASS = `sanity` is not blind AND every count in `drift_counts` is 0.
--   `blocking_unreserved_pairs` lists exactly the rows that would make PR-A's
--   final backfill REFUSE to apply (plan D8). It is a subset of `mismatched`;
--   self-hosters run it before upgrading to release N.
--   Only against v0.130 do the buckets mean "the identity table holds every
--   legacy pair". Any non-zero count: stop and escalate. `drift_samples` names
--   the rows. A missingIdentity row is also repaired by PR-A's final backfill
--   (2027-01-28-210000-portal-identity-final-backfill.sql), but it still means
--   a writer bypassed the fence, so it is investigated first.
--
-- G2 PASS = `sanity` is not blind AND `drift_counts.half_populated` = 0 AND
--   `fence_writes.last_fence_write_at` is EARLIER than that region's release-N
--   deploy. Release N writes neither column, so a newer fence write proves a
--   pre-N API or worker is still running somewhere: find it and stop it
--   before the drop. Under N the other buckets are expected to be non-zero
--   and are informational only (plan D1):
--   - every new Entra link is an orphan_identity;
--   - every MSP removal leaves a missing_identity or mismatched row.
--
-- This file lives under migrations/preflight/ and is NEVER applied by the
-- runner. autoMigrate reads the migrations root non-recursively and keeps only
-- /^\d{4}-.*\.sql$/, so this directory is skipped (same as optional/).
--
-- ============================ READ THIS FIRST ============================
-- THE SCOPE ELEVATION BELOW IS LOAD-BEARING. portal_users and
-- portal_user_identities are FORCE ROW LEVEL SECURITY, which binds the table
-- owner too, and breeze_current_scope() defaults to 'none', under which every
-- tenant policy is false. Without the elevation, every query below returns
-- ZERO ROWS WHILE BLIND, which reads as "clean". Query `sanity` makes
-- blindness visible: if `portal_users` is 0 on a region that has portal users,
-- fix the connection and do NOT report "clean".
--
-- BEGIN READ ONLY / ROLLBACK keeps the elevation transaction-local and makes
-- any write impossible. The migration "no BEGIN/COMMIT" rule does not apply:
-- autoMigrate never runs this file.
-- =========================================================================

BEGIN READ ONLY;

SELECT set_config('breeze.scope', 'system', true);

-- @query sanity
SELECT public.breeze_current_scope() AS effective_scope,
       (SELECT count(*) FROM public.organizations) AS organizations,
       (SELECT count(*) FROM public.portal_users) AS portal_users,
       (SELECT count(*) FROM public.portal_users WHERE entra_oid IS NOT NULL) AS portal_users_with_legacy_pair,
       (SELECT count(*) FROM public.portal_user_identities WHERE provider = 'entra') AS entra_identities;

-- @query schema_state
SELECT (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'portal_users'
           AND column_name IN ('entra_oid', 'entra_tenant_id')) AS legacy_columns,
       to_regclass('public.portal_users_entra_identity_uniq') IS NOT NULL AS legacy_index,
       EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgrelid = 'public.portal_users'::regclass
                  AND tgname = 'portal_users_browser_access_fill') AS fill_trigger;

-- @query drift_counts
SELECT
  (SELECT count(*) FROM public.portal_users pu
    WHERE pu.entra_oid IS NOT NULL AND pu.entra_tenant_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.portal_user_identities i
                       WHERE i.portal_user_id = pu.id AND i.provider = 'entra')) AS missing_identity,
  (SELECT count(*) FROM public.portal_user_identities i
     JOIN public.portal_users pu ON pu.id = i.portal_user_id
    WHERE i.provider = 'entra' AND pu.entra_oid IS NULL) AS orphan_identity,
  (SELECT count(*) FROM public.portal_user_identities i
     JOIN public.portal_users pu ON pu.id = i.portal_user_id
    WHERE i.provider = 'entra' AND pu.entra_oid IS NOT NULL
      AND (pu.entra_oid IS DISTINCT FROM i.subject
           OR pu.entra_tenant_id IS DISTINCT FROM i.entra_tenant_id
           OR pu.org_id IS DISTINCT FROM i.org_id)) AS mismatched,
  (SELECT count(*) FROM public.portal_users
    WHERE (entra_oid IS NULL) <> (entra_tenant_id IS NULL)) AS half_populated;

-- @query drift_samples
SELECT 'missing_identity' AS bucket, pu.id AS portal_user_id, pu.org_id, NULL::uuid AS identity_id
  FROM public.portal_users pu
 WHERE pu.entra_oid IS NOT NULL AND pu.entra_tenant_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.portal_user_identities i
                    WHERE i.portal_user_id = pu.id AND i.provider = 'entra')
UNION ALL
SELECT 'orphan_identity', pu.id, pu.org_id, i.id
  FROM public.portal_user_identities i JOIN public.portal_users pu ON pu.id = i.portal_user_id
 WHERE i.provider = 'entra' AND pu.entra_oid IS NULL
UNION ALL
SELECT 'mismatched', pu.id, pu.org_id, i.id
  FROM public.portal_user_identities i JOIN public.portal_users pu ON pu.id = i.portal_user_id
 WHERE i.provider = 'entra' AND pu.entra_oid IS NOT NULL
   AND (pu.entra_oid IS DISTINCT FROM i.subject
        OR pu.entra_tenant_id IS DISTINCT FROM i.entra_tenant_id
        OR pu.org_id IS DISTINCT FROM i.org_id)
UNION ALL
SELECT 'half_populated', pu.id, pu.org_id, NULL::uuid
  FROM public.portal_users pu
 WHERE (pu.entra_oid IS NULL) <> (pu.entra_tenant_id IS NULL)
 ORDER BY 1, 2
 LIMIT 200;

-- @query blocking_unreserved_pairs
-- The final backfill's refusal predicate, before the backfill runs: a complete
-- legacy pair that no identity reserves, on a login that already holds a
-- DIFFERENT Entra identity (so the backfill cannot reserve it). A login with no
-- Entra identity is not listed: the backfill repairs it.
SELECT pu.id AS portal_user_id, pu.org_id, i.id AS current_identity_id
  FROM public.portal_users pu
  JOIN public.portal_user_identities i ON i.portal_user_id = pu.id AND i.provider = 'entra'
 WHERE pu.entra_oid IS NOT NULL AND pu.entra_tenant_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.portal_user_identities r
                    WHERE r.issuer = 'https://login.microsoftonline.com/' || pu.entra_tenant_id || '/v2.0'
                      AND r.subject = pu.entra_oid)
 ORDER BY pu.id;

-- @query fence_writes
-- Only a fence writer (v0.130 and earlier) gives a NEW Entra identity a login
-- that carries the same legacy pair. Release N never writes the pair, so its
-- identities never match here. `migrated` rows (the W2, W3 and W10
-- backfills) are excluded: they copy the pair by design.
SELECT max(i.created_at) AS last_fence_write_at,
       count(*) FILTER (WHERE i.created_at > now() - interval '7 days') AS fence_writes_last_7_days
  FROM public.portal_user_identities i
  JOIN public.portal_users pu ON pu.id = i.portal_user_id
 WHERE i.provider = 'entra' AND i.linked_via <> 'migrated'
   AND pu.entra_oid = i.subject AND pu.entra_tenant_id = i.entra_tenant_id;

ROLLBACK;
