-- Connection health W4 (#8848, spec 2026-10-15 §3): the reconciler's Google
-- Workspace verification probe stores its last result on the connection, so
-- the google_workspace health source reads a durable, index-backed column
-- (2026-12-30-120100) instead of a Redis value that eviction would erase.
--   last_probe_at      when the probe last claimed this row (rate limit: 6 h)
--   last_probe_status  ok | failed (credentials or delegation rejected)
--                      | unavailable (rate limit, 5xx, network: no verdict)
--   last_probe_error   sanitized (sanitizeHealthDetail), at most 300 chars;
--                      never key material. Export policy: excludedOpen.
-- Columns only, nullable, no row writes; scope is elected for uniformity.
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE public.google_workspace_connections
  ADD COLUMN IF NOT EXISTS last_probe_at timestamp,
  ADD COLUMN IF NOT EXISTS last_probe_status varchar(16),
  ADD COLUMN IF NOT EXISTS last_probe_error text;

DO $$
BEGIN
  ALTER TABLE public.google_workspace_connections
    ADD CONSTRAINT google_workspace_connections_probe_status_chk
    CHECK (last_probe_status IS NULL OR last_probe_status IN ('ok', 'failed', 'unavailable'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.google_workspace_connections
    ADD CONSTRAINT google_workspace_connections_probe_error_len_chk
    CHECK (last_probe_error IS NULL OR char_length(last_probe_error) <= 300);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
