-- #2195: enforce one identity link per (provider_id, external_id) at the DB
-- layer. The identity-in-use check in the SSO callback link flow was
-- code-only (TOCTOU): two concurrent callbacks could both pass the check and
-- insert the same (provider, subject) pair for different users. The callback
-- login path additionally duplicated the SAME user's link on every returning
-- login in production-shaped deployments (bare read under FORCED RLS always
-- 0-rowed, so the UPDATE branch was unreachable — see #2195).
--
-- Forensics BEFORE the dedupe: a duplicate whose rows span DIFFERENT users is
-- not returning-login noise — it's evidence the TOCTOU race actually fired
-- (two users linked to one IdP subject: identity confusion). The dedupe below
-- resolves it by keeping the freshest row, which silently revokes the other
-- user's link — so record exactly which identities collided, per row group,
-- before anything is deleted. Idempotent: after the dedupe runs once, no
-- group can span two users, so re-runs log nothing.
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT provider_id, external_id,
           array_agg(DISTINCT user_id) AS user_ids,
           count(*) AS row_count
    FROM user_sso_identities
    GROUP BY provider_id, external_id
    HAVING count(DISTINCT user_id) > 1
  LOOP
    RAISE WARNING 'user_sso_identities CROSS-USER identity collision (investigate, #2195): provider=% external_id=% user_ids=% rows=% — dedupe keeps the freshest row and revokes the other user''s link',
      rec.provider_id, rec.external_id, rec.user_ids, rec.row_count;
  END LOOP;
END $$;

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
