-- Storage destinations (backup bucket credentials, filesystem paths) are no
-- longer written to device_commands.payload — enqueue sites persist a
-- reference and the destination is resolved when the command is delivered —
-- and DR plan step configuration no longer accepts credential material. This
-- removes what rows written before that change still hold.
--
-- 1) device_commands: TERMINAL rows only (status not pending/sent). A row that
--    is still pending or in flight was queued before references existed, so
--    its inline destination is the only way it can still be delivered; it is
--    erased by terminalPayloadErasureSet() the moment the row completes,
--    fails, times out or is cancelled. Only the two top-level keys are
--    removed; every other payload field is kept for forensics.
--
--    device_commands is large and has no index on type or on terminal
--    status, so the pass walks the primary key in bounded ranges of
--    batch_size ids: each UPDATE reads at most one range through the pkey
--    index instead of the whole table, and the total work stays linear (a
--    `ctid IN (SELECT ... LIMIT n)` loop over an unindexed predicate would
--    re-scan the already-cleaned part of the heap on every pass). autoMigrate
--    runs this file in ONE transaction, so batching bounds per-statement work
--    and memory, not how long the row locks are held: every cleaned row stays
--    locked until the file commits. Only terminal rows are written, and
--    nothing else updates a terminal row, so that is not expected to contend.
--    The in-flight count matches idx_device_commands_pending_created's
--    partial-index predicate exactly, so it does not scan the table either.
--
-- 2) dr_plan_groups.restore_config: every credential-shaped key is removed at
--    any depth. The key pattern is DR_CREDENTIAL_KEY_PATTERN_SOURCE in
--    apps/api/src/services/drStoredCredentialKeys.ts (the same one plan writes
--    now reject) — keep the two in step. Removing (not masking) the keys keeps
--    a plan re-saveable from the editor, which re-sends the stored payload.
--    No column changes: restore_config is already excludedOpen in the tenant
--    export policy.
--
-- WRITES ROWS: system scope is elected first (FORCE RLS binds the migration
-- role; without it the UPDATEs would silently match nothing). Counts are
-- reported even when zero so the forensic trail is complete.
-- autoMigrate wraps this file in a transaction — no BEGIN/COMMIT here.
-- Idempotent: a second run finds nothing left to remove.
SELECT set_config('breeze.scope', 'system', true);

CREATE OR REPLACE FUNCTION pg_temp.breeze_strip_credential_keys(doc jsonb, pattern text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
BEGIN
  IF doc IS NULL THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(doc) = 'object' THEN
    RETURN COALESCE(
      (SELECT jsonb_object_agg(e.key, pg_temp.breeze_strip_credential_keys(e.value, pattern))
         FROM jsonb_each(doc) AS e
        WHERE e.key !~* pattern),
      '{}'::jsonb
    );
  END IF;
  IF jsonb_typeof(doc) = 'array' THEN
    RETURN COALESCE(
      (SELECT jsonb_agg(pg_temp.breeze_strip_credential_keys(a.value, pattern) ORDER BY a.ord)
         FROM jsonb_array_elements(doc) WITH ORDINALITY AS a(value, ord)),
      '[]'::jsonb
    );
  END IF;
  RETURN doc;
END
$fn$;

DO $$
DECLARE
  batch_size constant integer := 5000;
  n integer;
  total bigint := 0;
  lo uuid;
  hi uuid;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  SELECT id INTO lo FROM device_commands ORDER BY id LIMIT 1;
  WHILE lo IS NOT NULL LOOP
    -- Upper bound of this range: the batch_size-th id from lo (max() has no
    -- uuid overload).
    SELECT b.id INTO hi
      FROM (SELECT id FROM device_commands WHERE id >= lo ORDER BY id LIMIT batch_size) AS b
     ORDER BY b.id DESC
     LIMIT 1;

    UPDATE device_commands
       SET payload = payload - 'providerConfig' - 'providerConfigEnvelope'
     WHERE id BETWEEN lo AND hi
       AND status NOT IN ('pending', 'sent')
       AND payload IS NOT NULL
       AND jsonb_typeof(payload) = 'object'
       AND (payload ? 'providerConfig' OR payload ? 'providerConfigEnvelope');
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;

    SELECT id INTO lo FROM device_commands WHERE id > hi ORDER BY id LIMIT 1;
  END LOOP;
  RAISE WARNING 'removed stored storage destinations from % terminal device_commands row(s)', total;

  SELECT count(*) INTO n
    FROM device_commands
   WHERE status IN ('pending', 'sent')
     AND payload IS NOT NULL
     AND jsonb_typeof(payload) = 'object'
     AND payload ? 'providerConfig';
  RAISE WARNING 'left % pending/in-flight device_commands row(s) with an inline storage destination (erased at terminal state)', n;
END $$;

DO $$
DECLARE
  n integer;
  credential_key_pattern constant text :=
    '^provider[_-]?config|password|passwd|^pwd$|passphrase|secret|token$|api[_-]?key|access[_-]?key|private[_-]?key|credential|connection[_-]?string|account[_-]?key|shared[_-]?key';
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  UPDATE dr_plan_groups
     SET restore_config = pg_temp.breeze_strip_credential_keys(restore_config, credential_key_pattern)
   WHERE restore_config IS NOT NULL
     AND restore_config IS DISTINCT FROM pg_temp.breeze_strip_credential_keys(restore_config, credential_key_pattern);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'removed credential-shaped keys from % dr_plan_groups.restore_config row(s)', n;
END $$;

DROP FUNCTION IF EXISTS pg_temp.breeze_strip_credential_keys(jsonb, text);
