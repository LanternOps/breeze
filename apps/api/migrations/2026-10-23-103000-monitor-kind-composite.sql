-- Alerting consolidation W05c1 (spec C8): the `composite` monitor kind.
-- Enum value only. Safe inside the runner's transaction because nothing in
-- this file consumes the value. Idempotent (pg_enum guard). No DML.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'composite'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'monitor_kind')
  ) THEN
    ALTER TYPE monitor_kind ADD VALUE 'composite';
  END IF;
END $$;
