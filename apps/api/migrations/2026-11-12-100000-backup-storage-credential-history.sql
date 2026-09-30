-- 2026-11-12-100000-backup-storage-credential-history.sql
--
-- History of the storage keys each S3 backup destination has used, with
-- evidence that replaced keys were disabled.
--
-- Backups to S3 storage are written only through write-scoped storage
-- sessions from this release on; no backup command carries a storage key any
-- more. Keys that devices received before this release keep working until
-- they are disabled with the storage provider, so every such key is recorded
-- here, and a replaced key stays listed until there is evidence it no longer
-- works.
--
-- backup_storage_credential_history — one row per (destination, key) in use:
--   access_key_fingerprint  sha256 hex of `<access key id>|<storage identity>`.
--                           The key id itself is not stored. Equal
--                           fingerprints across destinations (any
--                           organization) are the same key on the same
--                           storage, so evidence that it is disabled applies
--                           to all of them.
--   first_seen_at           when the row was recorded.
--   broadcast_until         set for keys that were in use before this release
--                           (they may have been delivered to devices); the
--                           time this release's migrations ran. NULL for keys
--                           first configured afterwards, which never were.
--   superseded_at           when the destination stopped using the key
--                           (replaced, or the destination was deleted).
--                           NULL = the destination's current key; at most
--                           one per destination.
--   sealed_previous_secret  the replaced connection settings (endpoint,
--                           region, bucket and key pair), encrypted by the API
--                           with the application key and bound to the row id,
--                           kept only so the API can check whether the old key
--                           still works. Erased once the key is recorded as
--                           disabled, and 30 days after it was replaced.
--   revoked_at / revocation_evidence / evidence_detail / verified_by_user_id
--                           the evidence that the key no longer works:
--                           probe_denied (storage refused the old key),
--                           provider_admin_confirmed, or operator_attested
--                           (a user confirmed it; weaker evidence).
--   last_probe_at / last_probe_outcome / last_probe_code
--                           the most recent check of the old key that did not
--                           prove it disabled (still_live / inconclusive) and
--                           the storage error code it returned. Only a key id
--                           that no longer exists (InvalidAccessKeyId) proves
--                           a key disabled; a key refused for listing
--                           (AccessDenied, SignatureDoesNotMatch) may still
--                           upload, so it is inconclusive.
--
-- TENANCY: shape 1 (direct org_id), no device_id. config_id is ON DELETE SET
-- NULL so the history outlives its destination; verified_by_user_id likewise.
-- No composite FK names org_id, so the org-merge deferral contract does not
-- apply. A parent-org guard refuses a row whose destination belongs to
-- another organization; it runs as the invoking role, so a destination that
-- RLS hides is also a refusal. It checks only a config_id that an INSERT or
-- UPDATE sets or changes, so an org merge restamp of org_id passes through.
--
-- DDL only: no rows written here (the API records the keys in use at its
-- first start on this release), so no breeze.scope election. Idempotent.

CREATE TABLE IF NOT EXISTS backup_storage_credential_history (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL REFERENCES organizations (id),
  config_id               uuid NULL REFERENCES backup_configs (id) ON DELETE SET NULL,
  storage_identity        text NOT NULL,
  access_key_fingerprint  text NOT NULL,
  first_seen_at           timestamptz NOT NULL DEFAULT now(),
  broadcast_until         timestamptz NULL,
  superseded_at           timestamptz NULL,
  sealed_previous_secret  text NULL,
  revoked_at              timestamptz NULL,
  revocation_evidence     text NULL,
  evidence_detail         text NULL,
  verified_by_user_id     uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  last_probe_at           timestamptz NULL,
  last_probe_outcome      text NULL,
  last_probe_code         text NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_storage_credential_history_fingerprint_chk
    CHECK (access_key_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT backup_storage_credential_history_evidence_chk
    CHECK (revocation_evidence IS NULL
      OR revocation_evidence IN ('probe_denied', 'provider_admin_confirmed', 'operator_attested')),
  CONSTRAINT backup_storage_credential_history_revoked_chk
    CHECK ((revoked_at IS NULL) = (revocation_evidence IS NULL)),
  -- A key recorded as disabled keeps nothing to check it with.
  CONSTRAINT backup_storage_credential_history_revoked_sealed_chk
    CHECK (revoked_at IS NULL OR sealed_previous_secret IS NULL),
  -- Only a replaced key has sealed settings; the current key lives on its destination.
  CONSTRAINT backup_storage_credential_history_sealed_superseded_chk
    CHECK (sealed_previous_secret IS NULL OR superseded_at IS NOT NULL),
  CONSTRAINT backup_storage_credential_history_probe_outcome_chk
    CHECK (last_probe_outcome IS NULL OR last_probe_outcome IN ('still_live', 'inconclusive'))
);

CREATE INDEX IF NOT EXISTS backup_storage_credential_history_org_idx
  ON backup_storage_credential_history (org_id);
CREATE INDEX IF NOT EXISTS backup_storage_credential_history_config_idx
  ON backup_storage_credential_history (config_id);
CREATE INDEX IF NOT EXISTS backup_storage_credential_history_fingerprint_idx
  ON backup_storage_credential_history (access_key_fingerprint);
CREATE INDEX IF NOT EXISTS backup_storage_credential_history_verified_by_idx
  ON backup_storage_credential_history (verified_by_user_id);
CREATE INDEX IF NOT EXISTS backup_storage_credential_history_outstanding_idx
  ON backup_storage_credential_history (org_id)
  WHERE broadcast_until IS NOT NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS backup_storage_credential_history_current_uq
  ON backup_storage_credential_history (config_id)
  WHERE superseded_at IS NULL AND config_id IS NOT NULL;

ALTER TABLE backup_storage_credential_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_storage_credential_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON backup_storage_credential_history;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON backup_storage_credential_history;
DROP POLICY IF EXISTS breeze_org_isolation_update ON backup_storage_credential_history;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON backup_storage_credential_history;
CREATE POLICY breeze_org_isolation_select ON backup_storage_credential_history FOR SELECT
  USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON backup_storage_credential_history FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON backup_storage_credential_history FOR UPDATE
  USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON backup_storage_credential_history FOR DELETE
  USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON backup_storage_credential_history TO breeze_app;

CREATE OR REPLACE FUNCTION public.breeze_backup_credential_history_parent_org_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.config_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.config_id IS DISTINCT FROM OLD.config_id) THEN
    IF NOT EXISTS (SELECT 1 FROM public.backup_configs c WHERE c.id = NEW.config_id AND c.org_id = NEW.org_id) THEN
      RAISE EXCEPTION 'storage key history destination is not in the history organization'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS backup_storage_credential_history_parent_org_guard ON backup_storage_credential_history;
CREATE TRIGGER backup_storage_credential_history_parent_org_guard
  BEFORE INSERT OR UPDATE ON backup_storage_credential_history
  FOR EACH ROW EXECUTE FUNCTION public.breeze_backup_credential_history_parent_org_guard();
