-- 2026-07-06: BitLocker/FileVault recovery-key escrow (issue #2021).
-- device_recovery_keys: escrowed keys, encrypted at rest by the app layer
-- (secretCrypto AAD device_recovery_keys.encrypted_key). RLS shape #1
-- (direct denormalized org_id), policies created in the same migration.
-- recovery_key_access_events: append-only reveal ledger, same shape.

CREATE TABLE IF NOT EXISTS public.device_recovery_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key_type varchar(50) NOT NULL,
  volume_mount varchar(100),
  protector_id varchar(100),
  encrypted_key text NOT NULL,
  key_fingerprint varchar(64) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'active',
  escrowed_at timestamp NOT NULL DEFAULT now(),
  superseded_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_recovery_keys_device_idx
  ON public.device_recovery_keys (device_id);
CREATE INDEX IF NOT EXISTS device_recovery_keys_org_idx
  ON public.device_recovery_keys (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS device_recovery_keys_active_slot_unique
  ON public.device_recovery_keys (device_id, key_type, COALESCE(volume_mount, ''))
  WHERE status = 'active';

ALTER TABLE public.device_recovery_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_recovery_keys FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON public.device_recovery_keys;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.device_recovery_keys;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.device_recovery_keys;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.device_recovery_keys;

CREATE POLICY breeze_org_isolation_select ON public.device_recovery_keys
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.device_recovery_keys
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.device_recovery_keys
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.device_recovery_keys
  FOR DELETE USING (public.breeze_has_org_access(org_id));

CREATE TABLE IF NOT EXISTS public.recovery_key_access_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id uuid NOT NULL REFERENCES public.device_recovery_keys(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  user_email varchar(255) NOT NULL,
  action varchar(20) NOT NULL DEFAULT 'revealed',
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recovery_key_access_events_key_idx
  ON public.recovery_key_access_events (key_id);
CREATE INDEX IF NOT EXISTS recovery_key_access_events_device_idx
  ON public.recovery_key_access_events (device_id);
CREATE INDEX IF NOT EXISTS recovery_key_access_events_org_idx
  ON public.recovery_key_access_events (org_id);

ALTER TABLE public.recovery_key_access_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recovery_key_access_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON public.recovery_key_access_events;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.recovery_key_access_events;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.recovery_key_access_events;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.recovery_key_access_events;

CREATE POLICY breeze_org_isolation_select ON public.recovery_key_access_events
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.recovery_key_access_events
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.recovery_key_access_events
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.recovery_key_access_events
  FOR DELETE USING (public.breeze_has_org_access(org_id));
