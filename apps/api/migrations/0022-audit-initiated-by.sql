-- Add initiated_by_type enum and column to audit_logs

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'initiated_by_type') THEN
    CREATE TYPE initiated_by_type AS ENUM ('manual', 'ai', 'automation', 'policy', 'schedule', 'agent', 'integration');
  END IF;
END $$;

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS initiated_by initiated_by_type;

CREATE INDEX IF NOT EXISTS idx_audit_logs_initiated_by ON audit_logs (initiated_by);
