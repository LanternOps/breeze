-- @no-transaction
-- Partner API acknowledge/resolve attribution: user FKs remain NULL when a
-- service principal acts as itself. Separate principal IDs distinguish these
-- human-equivalent resolves from system auto-resolves, preventing a paid AI
-- verdict run and retaining the actor for webhook echo suppression.
-- Each statement runs separately so validation and concurrent index builds
-- do not retain the ADD COLUMN lock.

ALTER TABLE public.alerts ADD COLUMN IF NOT EXISTS acknowledged_by_principal_id uuid;
ALTER TABLE public.alerts ADD COLUMN IF NOT EXISTS resolved_by_principal_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'alerts_acknowledged_by_principal_fk'
      AND conrelid = 'public.alerts'::regclass
  ) THEN
    ALTER TABLE public.alerts
      ADD CONSTRAINT alerts_acknowledged_by_principal_fk
      FOREIGN KEY (acknowledged_by_principal_id) REFERENCES public.partner_service_principals(id)
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'alerts_resolved_by_principal_fk'
      AND conrelid = 'public.alerts'::regclass
  ) THEN
    ALTER TABLE public.alerts
      ADD CONSTRAINT alerts_resolved_by_principal_fk
      FOREIGN KEY (resolved_by_principal_id) REFERENCES public.partner_service_principals(id)
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

ALTER TABLE public.alerts VALIDATE CONSTRAINT alerts_acknowledged_by_principal_fk;
ALTER TABLE public.alerts VALIDATE CONSTRAINT alerts_resolved_by_principal_fk;

-- The ON DELETE SET NULL RI trigger runs an UPDATE on alerts that bypasses RLS;
-- without an index every principal deletion scans the whole multi-tenant table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_alerts_acknowledged_by_principal
  ON public.alerts (acknowledged_by_principal_id)
  WHERE acknowledged_by_principal_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_alerts_resolved_by_principal
  ON public.alerts (resolved_by_principal_id)
  WHERE resolved_by_principal_id IS NOT NULL;

-- An interrupted CONCURRENTLY build leaves an INVALID index that
-- IF NOT EXISTS would silently accept, so fail loudly in that state.
-- Recovery: DROP INDEX CONCURRENTLY public.<invalid_index_name>, then
-- let autoMigrate re-run this file.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.alerts'::regclass
     AND c.relname IN ('idx_alerts_acknowledged_by_principal', 'idx_alerts_resolved_by_principal')
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'alerts principal-attribution index build left INVALID index: % — DROP INDEX CONCURRENTLY it and re-apply this migration', bad;
  END IF;
END $$;
