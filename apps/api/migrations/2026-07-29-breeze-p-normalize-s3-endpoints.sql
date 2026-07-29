-- Sentry BREEZE-P: normalize stored S3 endpoints in backup_configs.provider_config.
--
-- Background. `provider_config` is untyped jsonb, so before the save-time guards landed
-- (coerceS3EndpointUrl, 2026-07-20) any string could be persisted under `endpoint`. Two
-- bad shapes reached production:
--
--   1. scheme-less hosts ('example.s3.provider.com')  -> `new URL()` threw TypeError,
--      which is the BREEZE-P stack (@smithy customEndpointProvider -> parseUrl -> new URL).
--   2. blank strings ('')                             -> survived a truthiness guard on the
--      write path and sat in the row forever.
--
-- The API is no longer affected by either: it coerces on read and on save. The Go agent is
-- the reason this migration exists — agent/internal/backup/providers/s3.go passes the stored
-- value verbatim into aws.Endpoint{URL: ...} with no coercion of its own, so a scheme-less
-- host is still shipped to every agent running that config.
--
-- Scope check run against both production regions on 2026-07-29 before writing this:
-- EU had zero s3 configs; US had exactly one row, scheme-less. Self-hosted installs are the
-- reason this is written defensively rather than as a one-row UPDATE.
--
-- Idempotent: the WHERE clauses exclude anything already well-formed, so re-applying is a
-- no-op. Row counts are RAISEd (per the migration cleanup-statement rule) so the forensic
-- trail survives even when the counts are zero.

-- 1. Scheme-less hosts -> https:// (matches coerceS3EndpointUrl's default-to-https rule).
--    Deliberately requires the value to contain NO '://' at all. A foreign scheme such as
--    's3://bucket' or 'file:///etc/passwd' must NOT be rewritten to 'https://s3://bucket';
--    those are rejected loudly by the application validator instead, and are counted below.
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE backup_configs
     SET provider_config = jsonb_set(
           provider_config,
           '{endpoint}',
           to_jsonb('https://' || (provider_config->>'endpoint'))
         )
   WHERE provider = 's3'
     AND provider_config->>'endpoint' IS NOT NULL
     AND provider_config->>'endpoint' <> ''
     AND provider_config->>'endpoint' !~ '^https?://'
     AND provider_config->>'endpoint' NOT LIKE '%://%';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'BREEZE-P: prefixed https:// on % scheme-less backup_configs endpoint(s)', n;
  END IF;
END $$;

-- 2. Blank endpoints -> drop the key entirely, so the row means "use the provider default"
--    rather than carrying an empty string. Harmless at runtime today (both the API and the
--    agent treat '' as absent) but it keeps accumulating otherwise.
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE backup_configs
     SET provider_config = provider_config - 'endpoint'
   WHERE provider = 's3'
     AND provider_config->>'endpoint' = '';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'BREEZE-P: removed blank endpoint key from % backup_configs row(s)', n;
  END IF;
END $$;

-- 3. Report-only: anything still malformed after the two passes carries a foreign scheme and
--    needs a human decision (the credentials likely belong to a different provider). Not
--    rewritten, not deleted — surfaced so it is not silently left behind.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM backup_configs
   WHERE provider = 's3'
     AND provider_config->>'endpoint' IS NOT NULL
     AND provider_config->>'endpoint' <> ''
     AND provider_config->>'endpoint' !~ '^https?://';
  IF n > 0 THEN
    RAISE WARNING 'BREEZE-P: % backup_configs endpoint(s) have a non-http(s) scheme and were left unchanged; these will fail validation until corrected by hand', n;
  END IF;
END $$;
