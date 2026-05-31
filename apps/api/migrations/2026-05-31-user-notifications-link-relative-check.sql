-- Defense-in-depth for the notification open-redirect class (web #1018).
--
-- `user_notifications.link` is followed client-side via navigateTo(), which
-- routes through getSafeNext() (apps/web/src/lib/authNext.ts) and only allows
-- a same-origin relative path. This constraint enforces the SAME rule at the
-- storage layer so a hostile value can never be persisted in the first place,
-- even if a future writer bypasses the app-layer toSafeRelativePath() guard
-- (packages/shared/src/validators/safeRelativePath.ts).
--
-- Allowed: NULL, or a single-leading-slash relative path with no protocol-
-- relative (`//`) or backslash (`/\`) host bypass and no control characters.
-- The regex range [\x00-\x1F\x7F] matches getSafeNext exactly (C0 + DEL only,
-- NOT C1) — verified against Postgres 16; chr(92) is the backslash, used to
-- keep the literal unambiguous under standard_conforming_strings.

-- 1. Heal any pre-existing non-conforming rows so ADD CONSTRAINT cannot fail.
--    Hostile/legacy links are neutralized to NULL; the client recomputes a
--    safe default href from the notification type when link is absent.
UPDATE user_notifications
SET link = NULL
WHERE link IS NOT NULL
  AND NOT (
    left(link, 1) = '/'
    AND left(link, 2) <> '//'
    AND left(link, 2) <> '/' || chr(92)
    AND link !~ '[\x00-\x1F\x7F]'
  );

-- 2. Add the CHECK constraint idempotently.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_notifications_link_relative_chk'
  ) THEN
    ALTER TABLE user_notifications
      ADD CONSTRAINT user_notifications_link_relative_chk
      CHECK (
        link IS NULL
        OR (
          left(link, 1) = '/'
          AND left(link, 2) <> '//'
          AND left(link, 2) <> '/' || chr(92)
          AND link !~ '[\x00-\x1F\x7F]'
        )
      );
  END IF;
END $$;
