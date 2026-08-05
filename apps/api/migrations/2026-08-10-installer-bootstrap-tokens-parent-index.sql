-- Index installer_bootstrap_tokens.parent_enrollment_key_id.
--
-- #2992 put this column on a hot read path: GET /enrollment-keys and
-- GET /enrollment-keys/:id now run
--   SELECT parent_enrollment_key_id, count(*), sum(consumed_count), sum(max_usage)
--   FROM installer_bootstrap_tokens
--   WHERE parent_enrollment_key_id IN (<= one page of key ids)
--   GROUP BY parent_enrollment_key_id
-- to report how many devices an installer minted from that key has enrolled.
--
-- Postgres does not auto-index FK columns, so without this the aggregate is a
-- sequential scan of the whole table on every list page load — and because RLS
-- security quals run ahead of user quals, breeze_has_org_access(org_id) would
-- be evaluated once per row of every tenant's rows before the IN filter
-- narrowed anything.
--
-- Also pays for the ON DELETE CASCADE from enrollment_keys and the correlated
-- NOT EXISTS in jobs/enrollmentKeyCleanup.ts, both of which scan today.

CREATE INDEX IF NOT EXISTS idx_installer_bootstrap_tokens_parent
  ON installer_bootstrap_tokens (parent_enrollment_key_id);
