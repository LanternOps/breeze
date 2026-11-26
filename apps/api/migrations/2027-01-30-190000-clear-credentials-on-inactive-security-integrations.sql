-- #12730: an inactive SentinelOne or Huntress integration holds no credential.
--
-- Disconnect (#12691, previous migration) sets every stored secret on the
-- integration to NULL when it deactivates the row. Rows deactivated before
-- that, through `isActive: false` on the connect route or by an earlier
-- dedupe, can still hold their old encrypted secrets. This clears them, so a
-- disconnected integration means the same thing whenever it was disconnected.
-- A reconnect already requires every secret to be entered again.
--
-- It clears exactly the columns Disconnect clears, and nothing else:
--   s1_integrations.api_token_encrypted            WHERE is_active = false
--   s1_org_mappings.registration_token             when the mapping's
--     integration (composite FK (integration_id, partner_id) ->
--     s1_integrations (id, partner_id)) has is_active = false
--   huntress_integrations.api_key_encrypted,
--     account_key_encrypted, webhook_secret_encrypted WHERE is_active = false
-- is_active is NOT NULL, so `is_active = false` is every row that is not
-- active. updated_at is left alone: a reconnect revives the partner's most
-- recently updated inactive row, and bumping it here would change which one.
--
-- Each UPDATE also requires a secret to still be present, so a row that holds
-- nothing is not rewritten and a re-run changes nothing.
--
-- Concurrency: the inactive SentinelOne rows are locked first, then their
-- mappings are written, the same integration-then-mappings order Disconnect,
-- reconnect and the S1 sync use. A row reactivated before the lock is taken
-- is skipped; one locked here cannot be reactivated until this commits.
--
-- Cannot be undone: the cleared ciphertext is gone.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n integer;
BEGIN
  PERFORM 1
     FROM public.s1_integrations
    WHERE is_active = false
    ORDER BY id
      FOR UPDATE;

  UPDATE public.s1_org_mappings m
     SET registration_token = NULL
    FROM public.s1_integrations i
   WHERE i.id = m.integration_id
     AND i.partner_id = m.partner_id
     AND i.is_active = false
     AND m.registration_token IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING '#12730: cleared % SentinelOne site registration token(s) on inactive integrations', n;
  END IF;

  UPDATE public.s1_integrations
     SET api_token_encrypted = NULL
   WHERE is_active = false
     AND api_token_encrypted IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING '#12730: cleared the API token on % inactive SentinelOne integration(s)', n;
  END IF;

  UPDATE public.huntress_integrations
     SET api_key_encrypted = NULL,
         account_key_encrypted = NULL,
         webhook_secret_encrypted = NULL
   WHERE is_active = false
     AND (api_key_encrypted IS NOT NULL
          OR account_key_encrypted IS NOT NULL
          OR webhook_secret_encrypted IS NOT NULL);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING '#12730: cleared stored secrets on % inactive Huntress integration(s)', n;
  END IF;
END $$;
