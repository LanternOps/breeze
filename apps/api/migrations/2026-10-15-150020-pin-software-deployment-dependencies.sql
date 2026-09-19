-- Bind each new software deployment to the executable dependency that its
-- authorized creator approved. Existing rows deliberately remain NULL: their
-- current dependency may already have changed, so runtime dispatch must fail
-- closed and require an authorized replacement deployment instead of blessing
-- the current mutable value during migration.
ALTER TABLE public.software_deployments
  ADD COLUMN IF NOT EXISTS dependency_fingerprint varchar(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'software_deployments_dependency_fingerprint_chk'
       AND conrelid = 'public.software_deployments'::regclass
  ) THEN
    ALTER TABLE public.software_deployments
      ADD CONSTRAINT software_deployments_dependency_fingerprint_chk
      CHECK (
        dependency_fingerprint IS NULL
        OR dependency_fingerprint ~ '^[0-9a-f]{64}$'
      );
  END IF;
END $$;

COMMENT ON COLUMN public.software_deployments.dependency_fingerprint IS
  'SHA-256 binding of the approved executable dependency; NULL legacy rows fail closed at dispatch/retry';
