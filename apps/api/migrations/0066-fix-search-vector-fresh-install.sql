-- 0066-fix-search-vector-fresh-install.sql
-- Ensures search_vector column and indexes exist on device_event_logs.
-- This is a no-op for databases created with the new baseline (0001).
-- For legacy databases, these objects already exist from manual migrations.
-- Kept as a safety net for edge cases.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "device_event_logs" ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(source, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(message, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(event_id, '')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS "device_event_logs_search_vector_idx"
  ON "device_event_logs" USING gin (search_vector);
CREATE INDEX IF NOT EXISTS "device_event_logs_message_trgm_idx"
  ON "device_event_logs" USING gin (message gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "device_event_logs_source_trgm_idx"
  ON "device_event_logs" USING gin (source gin_trgm_ops);
