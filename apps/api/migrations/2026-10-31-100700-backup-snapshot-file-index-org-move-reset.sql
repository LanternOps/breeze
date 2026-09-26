-- #6488 — a verified snapshot file index must not outlive its snapshot's
-- tenancy. hydrateSnapshotFileIndex (services/backupSnapshotFileIndex.ts)
-- pins origin_org_id / origin_device_id in backup_snapshot_origins from the
-- snapshot's org/device at hydration time. backup_snapshot_origins has no
-- org_id/device_id column of its own, so nothing re-stamps it when the
-- snapshot's org_id changes — the device move-org route's denormalized-table
-- loop, breeze_cascade_device_org_id() on a raw UPDATE devices, and org merge
-- all re-stamp backup_snapshots.org_id and leave the provenance naming the
-- old org. authorizeExternalReference then refuses every external-reference
-- download ("origin identity does not match the recovery token") — fail
-- closed, but a recovery that can never succeed.
--
-- Fix: a BEFORE UPDATE trigger on backup_snapshots. When org_id or device_id
-- actually changes, a 'complete' or 'hydrating' index drops back to 'none'.
-- 'complete' is the ONLY status that authorizes an external reference, so
-- downloads stay refused until the next authenticate/exchange negotiation
-- (recoveryCapabilities.ts: 'none' => snapshot_index_pending + enqueue)
-- re-hydrates against the snapshot's CURRENT org/device. Hydration replaces
-- the origin rows wholesale, so the stale ones are not deleted here (doing so
-- from a trigger would need its own RLS elevation on backup_snapshot_origins).
-- A trigger, not route code, because it is the one place every org_id
-- writer passes through.
--
-- 'agent' / 'failed' / 'none' are left alone: none of them authorizes a
-- download, and each already re-hydrates (or stays refused) on its own terms.
--
-- Idempotent throughout. No inner BEGIN/COMMIT — autoMigrate wraps each file.

CREATE OR REPLACE FUNCTION public.breeze_backup_snapshot_file_index_tenancy_reset()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.file_index_status IN ('complete', 'hydrating') THEN
    NEW.file_index_status := 'none';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.breeze_backup_snapshot_file_index_tenancy_reset() IS
  '#6488: resets a complete/hydrating backup_snapshots file index to none when the snapshot''s org_id or device_id changes, so backup_snapshot_origins provenance pinned to the old org/device is re-verified before it can authorize a download again.';

DROP TRIGGER IF EXISTS backup_snapshots_file_index_tenancy_reset ON backup_snapshots;
CREATE TRIGGER backup_snapshots_file_index_tenancy_reset
  BEFORE UPDATE OF org_id, device_id ON backup_snapshots
  FOR EACH ROW
  WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id OR OLD.device_id IS DISTINCT FROM NEW.device_id)
  EXECUTE FUNCTION public.breeze_backup_snapshot_file_index_tenancy_reset();

-- Backfill: snapshots already moved before this trigger existed. Any
-- 'complete' index with a recorded origin whose org/device no longer matches
-- the snapshot's own is exactly the stale state above (hydration only ever
-- writes origins equal to the snapshot's org/device). Reset it so it
-- re-hydrates. Row-writing, so elect system scope first.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  UPDATE backup_snapshots s
     SET file_index_status = 'none'
   WHERE s.file_index_status = 'complete'
     AND EXISTS (
       SELECT 1 FROM backup_snapshot_origins o
        WHERE o.snapshot_db_id = s.id
          AND (o.origin_org_id IS DISTINCT FROM s.org_id
               OR o.origin_device_id IS DISTINCT FROM s.device_id)
     );
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING '#6488 backup-snapshot-file-index-org-move-reset: reset file_index_status on % snapshots whose verified origins named a previous org/device', n;
  END IF;
END $$;
