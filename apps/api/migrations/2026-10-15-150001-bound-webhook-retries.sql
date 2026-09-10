-- Bound legacy alert-webhook retryCount values. Runtime delivery clamps these
-- values independently; this cleanup makes subsequent edits pass validation
-- and preserves the configured intent as closely as the new ceiling allows.
-- Non-numeric legacy values become the safe default of two retries.
DO $$
DECLARE
  cleaned_rows bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  UPDATE public.notification_channels
  SET config = jsonb_set(
    config,
    '{retryCount}',
    to_jsonb(
      CASE
        WHEN jsonb_typeof(config -> 'retryCount') = 'number' THEN
          LEAST(
            2::numeric,
            GREATEST(0::numeric, FLOOR((config ->> 'retryCount')::numeric))
          )::integer
        ELSE 2
      END
    ),
    true
  )
  WHERE type = 'webhook'
    AND config ? 'retryCount'
    AND CASE
      WHEN jsonb_typeof(config -> 'retryCount') = 'number' THEN
        (config ->> 'retryCount')::numeric < 0
        OR (config ->> 'retryCount')::numeric > 2
        OR (config ->> 'retryCount')::numeric <> FLOOR((config ->> 'retryCount')::numeric)
      ELSE true
    END;

  GET DIAGNOSTICS cleaned_rows = ROW_COUNT;
  IF cleaned_rows > 0 THEN
    RAISE WARNING 'normalized % notification channel webhook retryCount value(s) to the supported 0..2 range', cleaned_rows;
  END IF;
END $$;
