-- Pin each webhook and delivery to its payload version and persist replay identity.
-- Existing rows read 1 so the v1 serializer stays byte-for-byte unchanged (OD2);
-- after adding the column, new webhooks default to payload version 2.
ALTER TABLE public.webhooks ADD COLUMN IF NOT EXISTS payload_version smallint NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'webhooks_payload_version_chk'
      AND conrelid = 'public.webhooks'::regclass
  ) THEN
    ALTER TABLE public.webhooks
      ADD CONSTRAINT webhooks_payload_version_chk CHECK (payload_version IN (1, 2));
  END IF;
END $$;

ALTER TABLE public.webhooks ALTER COLUMN payload_version SET DEFAULT 2;
ALTER TABLE public.webhook_deliveries ADD COLUMN IF NOT EXISTS payload_version smallint NOT NULL DEFAULT 1;
ALTER TABLE public.webhook_deliveries ADD COLUMN IF NOT EXISTS event_timestamp timestamptz NULL;
ALTER TABLE public.webhook_deliveries ADD COLUMN IF NOT EXISTS replay_root_event_id varchar(100) NULL;
