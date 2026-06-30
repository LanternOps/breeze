-- UniFi self-hosted controllers (part a): connection_type discriminator on the
-- partner integration row. 'cloud' = existing Site Manager (api.ui.com) flow;
-- 'self_hosted' = agent-mediated local Network controller with no cloud key.

ALTER TABLE unifi_integrations
  ADD COLUMN IF NOT EXISTS connection_type text NOT NULL DEFAULT 'cloud';

-- Self-hosted integrations carry no cloud API key; relax the NOT NULL and guard
-- it with a CHECK so cloud rows still require a key.
ALTER TABLE unifi_integrations ALTER COLUMN api_key_encrypted DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unifi_integrations_cloud_key_chk'
  ) THEN
    ALTER TABLE unifi_integrations
      ADD CONSTRAINT unifi_integrations_cloud_key_chk
      CHECK (connection_type <> 'cloud' OR api_key_encrypted IS NOT NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unifi_integrations_connection_type_chk'
  ) THEN
    ALTER TABLE unifi_integrations
      ADD CONSTRAINT unifi_integrations_connection_type_chk
      CHECK (connection_type IN ('cloud', 'self_hosted'));
  END IF;
END $$;
