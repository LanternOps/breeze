-- #2161: the Windows MSI filename-bootstrap token was single-use (redemption
-- gated purely on consumed_at), so the "device enrollment limit" the admin set
-- when building the installer was silently ignored. One downloaded .msi carries
-- one token in its filename; the first machine to redeem it enrolled, and every
-- other machine replayed the same now-consumed token and got a 404 -- so the
-- install "succeeded" but the device never appeared in the portal. The CLI path
-- was unaffected because it mints a genuinely multi-use enrollment key.
--
-- max_usage already existed on the token but was never consulted. Add an
-- explicit consumed_count so redemption can allow up to max_usage redemptions
-- (one fresh single-use child enrollment key minted per redemption). A token
-- with max_usage = 1 keeps its exact prior single-use behavior.
ALTER TABLE installer_bootstrap_tokens
  ADD COLUMN IF NOT EXISTS consumed_count integer NOT NULL DEFAULT 0;

-- Backfill: any token that was already consumed counts as one redemption, so
-- previously-burned tokens stay burned (consumed_count = max_usage = 1). Guard
-- on consumed_count = 0 so re-applying this migration is a no-op. Report the
-- count so the change is auditable in the Postgres log.
DO $$
DECLARE n bigint;
BEGIN
  UPDATE installer_bootstrap_tokens
     SET consumed_count = 1
   WHERE consumed_at IS NOT NULL
     AND consumed_count = 0;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'backfilled consumed_count=1 for % already-consumed installer_bootstrap_tokens', n;
  END IF;
END $$;
