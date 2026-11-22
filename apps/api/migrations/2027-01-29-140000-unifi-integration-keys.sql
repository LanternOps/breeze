-- UniFi Site Manager: several labelled API keys per cloud connection (#11808, W1 #12276).
--
-- unifi_integration_keys holds one encrypted key per row with that key's own
-- sync status. Partner axis (RLS shape 3): partner_id is denormalized and pinned
-- to the integration's partner by a composite FK. No org_id, so the org cascade,
-- org-merge and export-policy lists do not apply; the partner purge sweeps every
-- partner_id table, and the FK cascades from unifi_integrations anyway.
--
-- The existing key moves by a VERBATIM ciphertext copy. Its AAD stays the legacy
-- column tag 'unifi_integrations.api_key_encrypted' (encryptedColumnRegistry
-- UNIFI_KEY_COLUMN_SPEC.aadTag), so nothing is decrypted here and no connection
-- is ever without a key. unifi_integrations.api_key_encrypted stays (and stays
-- written) until W4, so a rollback to pre-W1 code keeps working.

SELECT set_config('breeze.scope', 'system', true);

-- 1. Parent unique key for the composite FK ----------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unifi_integrations_id_partner_unique'
  ) THEN
    ALTER TABLE unifi_integrations
      ADD CONSTRAINT unifi_integrations_id_partner_unique UNIQUE (id, partner_id);
  END IF;
END $$;

-- 2. unifi_integration_keys (partner axis) -----------------------------------
CREATE TABLE IF NOT EXISTS unifi_integration_keys (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id     uuid NOT NULL,
  partner_id         uuid NOT NULL REFERENCES partners(id),
  label              text NOT NULL,
  api_key_encrypted  text NOT NULL,
  key_last4          varchar(4),
  is_enabled         boolean NOT NULL DEFAULT true,
  status             varchar(20) NOT NULL DEFAULT 'pending',
  last_sync_at       timestamptz,
  last_sync_status   varchar(16),
  last_sync_error    text,
  last_ok_at         timestamptz,
  hosts_seen         integer,
  sites_seen         integer,
  last_seen_host_ids text[],
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unifi_integration_keys_label_chk
    CHECK (char_length(btrim(label)) BETWEEN 1 AND 100),
  CONSTRAINT unifi_integration_keys_status_chk
    CHECK (status IN ('pending', 'connected', 'reauth_required', 'error')),
  CONSTRAINT unifi_integration_keys_last_sync_status_chk
    CHECK (last_sync_status IS NULL OR last_sync_status IN ('success', 'failed', 'skipped')),
  CONSTRAINT unifi_integration_keys_integration_fk
    FOREIGN KEY (integration_id, partner_id)
    REFERENCES unifi_integrations(id, partner_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS unifi_integration_keys_label_idx
  ON unifi_integration_keys (integration_id, lower(btrim(label)));
CREATE INDEX IF NOT EXISTS unifi_integration_keys_integration_idx
  ON unifi_integration_keys (integration_id, created_at, id);

ALTER TABLE unifi_integration_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE unifi_integration_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_partner_isolation_select ON unifi_integration_keys;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON unifi_integration_keys;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON unifi_integration_keys;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON unifi_integration_keys;
CREATE POLICY breeze_partner_isolation_select ON unifi_integration_keys
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON unifi_integration_keys
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON unifi_integration_keys
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON unifi_integration_keys
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

-- 3. Backfill: one key per cloud integration, ciphertext copied verbatim ------
-- The key takes the parent connection's status and last error (a connection
-- that needs re-auth today must not show a healthy key). A parent status
-- outside the key domain becomes 'pending'. last_sync_status stays NULL: its
-- domain differs from the parent's. key_last4 stays NULL until the worker's
-- next successful sync. The label is clamped to the key's 100-character limit
-- (/connect accepted account labels of up to 200).
DO $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  INSERT INTO unifi_integration_keys
    (integration_id, partner_id, label, api_key_encrypted, status, last_sync_error, last_sync_at)
  SELECT
    i.id,
    i.partner_id,
    COALESCE(NULLIF(btrim(left(btrim(i.account_label), 100)), ''), 'Global'),
    i.api_key_encrypted,
    CASE WHEN i.status IN ('connected', 'reauth_required', 'error') THEN i.status ELSE 'pending' END,
    i.last_sync_error,
    i.last_sync_at
  FROM unifi_integrations i
  WHERE i.connection_type = 'cloud'
    AND i.api_key_encrypted IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM unifi_integration_keys k WHERE k.integration_id = i.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE NOTICE 'unifi_integration_keys: backfilled % key(s) from unifi_integrations', n;
  END IF;
END $$;

-- 4. The key table now holds the "cloud connection has a key" invariant --------
ALTER TABLE unifi_integrations DROP CONSTRAINT IF EXISTS unifi_integrations_cloud_key_chk;
