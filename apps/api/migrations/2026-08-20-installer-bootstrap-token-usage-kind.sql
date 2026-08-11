-- #3034: record on the TOKEN what its max_usage MEANS, instead of inferring it
-- from whether the parent enrollment key carries a short_code.
--
-- Two flows mint installer_bootstrap_tokens and their max_usage means different
-- things:
--
--   * capacity     -- the three AUTHENTICATED paths (GET /:id/installer/:platform
--                     for macOS and Windows, POST /:id/bootstrap-token). max_usage
--                     IS the device count the operator asked for: a real
--                     device-slot budget, and the figure the Enrollment Keys page
--                     exists to show.
--   * per_download -- the PUBLIC download paths (/s/:code and the download-handle
--                     route, both via serveInstaller). Each download mints a
--                     hardcoded max_usage = 1 token, so summing them counts
--                     CLICKS, not device slots.
--
-- Until now the read path discriminated per KEY, suppressing the whole figure for
-- any key with a short_code. That proxy is wrong in both directions:
--
--   * false suppression (the bug this fixes) -- the authenticated installer
--     routes accept ANY key id the caller can reach, including a short-link
--     child, so building an installer FROM that child row produced a genuine
--     max_usage > 1 capacity token that the short_code gate then hid.
--   * false reporting -- /s/:code mints a FRESH download key that has NO
--     short_code and then serves a per_download token against it, so those rows
--     were never suppressed at all.
--
-- The discriminator belongs on the token row. After this migration the read path
-- aggregates strictly on usage_kind = 'capacity' and no longer consults
-- short_code.
ALTER TABLE installer_bootstrap_tokens
  ADD COLUMN IF NOT EXISTS usage_kind text NOT NULL DEFAULT 'legacy_unknown';

-- The DEFAULT is deliberately 'legacy_unknown', not 'capacity'.
--
-- It exists for rolling deploys: this migration lands before the last old API
-- pod drains, and an old pod's INSERT omits the column entirely. Without a
-- default, NOT NULL would 500 every installer download mid-rollout.
--
-- It must not be 'capacity', because a default is also what any FUTURE writer
-- that forgets the column silently inherits -- and inheriting "this number is a
-- device budget" is exactly the confidently-wrong denominator #2992 removed.
-- 'legacy_unknown' is excluded from the aggregate, so a forgetful writer
-- degrades to showing nothing rather than to showing a lie.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'installer_bootstrap_tokens_usage_kind_valid'
  ) THEN
    ALTER TABLE installer_bootstrap_tokens
      ADD CONSTRAINT installer_bootstrap_tokens_usage_kind_valid
      CHECK (usage_kind IN ('capacity', 'per_download', 'legacy_unknown'));
  END IF;
END $$;

-- Backfill only what the DATA PROVES.
--
-- serveInstaller -- the sole public/per-download mint path -- hardcodes
-- maxUsage: 1. So max_usage > 1 could only have come from one of the three
-- authenticated capacity paths. That inference is exact, not a heuristic.
--
-- The converse is NOT provable: a max_usage = 1 token may be a per-download
-- token OR a genuine one-device installer built from the Add Device modal, and
-- nothing on the row distinguishes them. Those stay 'legacy_unknown' rather than
-- being guessed in either direction:
--
--   * guessing 'capacity' would re-report the click-counting figure #2992 removed;
--   * guessing 'per_download' would assert a falsehood about real one-device
--     installers.
--
-- 'legacy_unknown' costs a one-device legacy installer its capacity LINE (the
-- row falls back to the parent key's own counters, exactly as a key that never
-- built an installer does) until the next installer is built. That is a display
-- fallback on a self-draining set -- these tokens have a 24h default TTL and the
-- nightly enrollmentKeyCleanup job reaps them -- and it never affects the purge
-- guard, which deliberately considers tokens of EVERY kind so no live installer
-- can be deleted out from under an admin.
DO $$
DECLARE n bigint;
BEGIN
  UPDATE installer_bootstrap_tokens
     SET usage_kind = 'capacity'
   WHERE usage_kind = 'legacy_unknown'
     AND max_usage > 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'backfilled usage_kind=capacity for % multi-slot installer_bootstrap_tokens', n;
  END IF;
END $$;

-- Report what stayed ambiguous. Zero is a meaningful reading here (it means the
-- fleet had no in-flight single-slot tokens at migration time), so this logs
-- unconditionally rather than only when non-zero.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n
    FROM installer_bootstrap_tokens
   WHERE usage_kind = 'legacy_unknown';
  RAISE WARNING 'installer_bootstrap_tokens left at usage_kind=legacy_unknown (single-slot, mint path unprovable): %', n;
END $$;
