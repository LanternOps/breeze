-- Bind partner service principal keys to their owner's credential state, the
-- same binding human API keys carry (api_keys.creator_credential_epoch /
-- creator_mfa_epoch, 2026-11-12-110000-api-key-creator-credential-epoch.sql).
--
-- owner_credential_epoch / owner_mfa_epoch are the principal owner's
-- (partner_service_principals.created_by) users.credential_epoch and
-- users.mfa_epoch at the moment the key was issued.
-- services/partnerServicePrincipalCredential.ts rejects a key once either
-- moves: a password change/reset, invite acceptance or admin status change
-- (credential_epoch), or an MFA factor change (mfa_epoch). Ordinary logout
-- advances only auth_epoch and does not end keys (services/authLifecycle.ts).
--
-- Backfill: existing keys are stamped with their principal owner's CURRENT
-- epochs, so the binding applies from this migration forward (a credential
-- event that already happened cannot be reconstructed). Only missing values
-- are filled, so a re-run never refreshes a snapshot. Every key has an owner
-- row (created_by is NOT NULL with a users FK), so after the backfill both
-- columns can be NOT NULL and no key can exist unbound.
DO $$
DECLARE
  n int;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  ALTER TABLE partner_service_principal_keys ADD COLUMN IF NOT EXISTS owner_credential_epoch integer;
  ALTER TABLE partner_service_principal_keys ADD COLUMN IF NOT EXISTS owner_mfa_epoch integer;

  UPDATE partner_service_principal_keys k
  SET owner_credential_epoch = COALESCE(k.owner_credential_epoch, u.credential_epoch),
      owner_mfa_epoch = COALESCE(k.owner_mfa_epoch, u.mfa_epoch)
  FROM partner_service_principals p
  JOIN users u ON u.id = p.created_by
  WHERE p.id = k.partner_service_principal_id
    AND p.partner_id = k.partner_id
    AND (k.owner_credential_epoch IS NULL OR k.owner_mfa_epoch IS NULL);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'stamped owner credential epochs on % partner_service_principal_keys rows', n;
  END IF;

  ALTER TABLE partner_service_principal_keys ALTER COLUMN owner_credential_epoch SET NOT NULL;
  ALTER TABLE partner_service_principal_keys ALTER COLUMN owner_mfa_epoch SET NOT NULL;
END $$;
