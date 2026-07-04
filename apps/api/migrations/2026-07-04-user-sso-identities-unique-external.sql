-- #2195: enforce one identity link per (provider_id, external_id) at the DB
-- layer. The identity-in-use check in the SSO callback link flow was
-- code-only (TOCTOU): two concurrent callbacks could both pass the check and
-- insert the same (provider, subject) pair for different users. The callback
-- login path additionally duplicated the SAME user's link on every returning
-- login in production-shaped deployments (bare read under FORCED RLS always
-- 0-rowed, so the UPDATE branch was unreachable — see #2195).
--
-- Dedupe BEFORE adding the index: keep, per (provider_id, external_id), the
-- row with the freshest tokens (last_login_at DESC NULLS LAST, then
-- created_at DESC, then id as a stable tiebreak) and delete the rest,
-- reporting the count so the forensic trail lands in Postgres logs.
DO $$
DECLARE
  n integer;
BEGIN
  WITH ranked AS (
    SELECT id,
           row_number() OVER (
             PARTITION BY provider_id, external_id
             ORDER BY last_login_at DESC NULLS LAST, created_at DESC, id DESC
           ) AS rn
    FROM user_sso_identities
  )
  DELETE FROM user_sso_identities u
  USING ranked r
  WHERE u.id = r.id AND r.rn > 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'cleaned % duplicate user_sso_identities rows (returning-login duplicates from the #2195 bare-RLS-read bug)', n;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS user_sso_identities_provider_external_idx
  ON user_sso_identities (provider_id, external_id);
