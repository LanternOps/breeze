-- EDR W03 PR-B (#8167 / epic #8164): vendor push events as "sync now" hints.
--   * edr_connections.push_enabled — the console's push registration is live and
--     the public webhook accepts events for it. Defaults OFF; flipped true only
--     after the vendor registration call succeeds (partner admin + MFA).
--   * edr_connections.push_registered_at — when that registration succeeded.
--   * edr_connections.pending_hint_at — durable "this connection has news"
--     marker written by the webhook. A hint only schedules a read sync; the
--     detections run clears it with a compare-and-set after it commits.
-- edr_connections has no org_id (RLS shape 3), so no tenant-export-policy entry
-- and no cascade-list change. DDL only: no breeze.scope preamble.

ALTER TABLE edr_connections ADD COLUMN IF NOT EXISTS push_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE edr_connections ADD COLUMN IF NOT EXISTS push_registered_at timestamptz;
ALTER TABLE edr_connections ADD COLUMN IF NOT EXISTS pending_hint_at timestamptz;
