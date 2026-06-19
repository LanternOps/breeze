-- Enforce the API-key model's core invariant at the DB: a 'connected' Stripe row
-- must carry an encrypted key + display last4. (Status was TS-only before.)
--
-- Legacy Connect-OAuth rows are 'connected' with api_key NULL (they used the OAuth
-- token in `credentials`, which the API-key path ignores). Those are meaningless
-- now, so flip them to 'disconnected' BEFORE adding the constraint — the partner
-- re-enters their key under the new model. Report the count for the forensic trail.

DO $$
DECLARE n integer;
BEGIN
  UPDATE stripe_connect_accounts
     SET status = 'disconnected', disconnected_at = now(), updated_at = now()
   WHERE status = 'connected' AND api_key IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'stripe-key migration: disconnected % legacy Connect-OAuth row(s) (no api_key) before adding CHECK', n;
  END IF;
END $$;

ALTER TABLE stripe_connect_accounts DROP CONSTRAINT IF EXISTS stripe_connect_connected_requires_key;
ALTER TABLE stripe_connect_accounts
  ADD CONSTRAINT stripe_connect_connected_requires_key
  CHECK (status <> 'connected' OR (api_key IS NOT NULL AND key_last4 IS NOT NULL));
