-- Network device page truth W01 (spec docs/superpowers/specs/monitoring/2026-09-16-network-device-page-truth-design.md §4.3, §5).
--
-- Six expansion-only columns on discovered_assets. No DML, so no
-- `SELECT set_config('breeze.scope','system',true)` preamble and deliberately
-- NO entry in the frozen baseline of apps/api/src/db/migrationRlsScope.test.ts.
-- No new table: discovered_assets already carries its shape-1 org_id policies,
-- its CORE_ORG_CASCADE_DELETE_ORDER entry and its device-side cascade entries.
-- Adding COLUMNS to it DOES require a CORE_TENANT_EXPORT_POLICY update, which
-- ships in the same commit.
--
-- status_observed_at / status_source: WHEN the is_online verdict was taken and
-- BY WHOM. is_online keeps its meaning exactly ("last scan/controller
-- verdict"); nothing derives reachability from it any more. NULL on every
-- pre-existing row and on manual rows that no scan has touched — the
-- reachability service treats an undated is_online=false as NO observation
-- rather than a stale negative claim.
--
-- last_probe_*: the manual "Check now" probe (§5). last_probe_ref holds the
-- dispatched agent command id (`probe-<assetUuid>-<epochMillis>`, 5 + 36 + 1 +
-- 13 = 55 chars today; 80 leaves room) and is the correlation key the result
-- handler compare-and-swaps against.

ALTER TABLE discovered_assets
  ADD COLUMN IF NOT EXISTS status_observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_source VARCHAR(16),
  ADD COLUMN IF NOT EXISTS last_probe_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_probe_status VARCHAR(12),
  ADD COLUMN IF NOT EXISTS last_probe_response_ms INTEGER,
  ADD COLUMN IF NOT EXISTS last_probe_ref VARCHAR(80);

DO $$ BEGIN
  ALTER TABLE discovered_assets ADD CONSTRAINT discovered_assets_status_source_chk
    CHECK (status_source IS NULL OR status_source IN ('scan','unifi'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE discovered_assets ADD CONSTRAINT discovered_assets_last_probe_status_chk
    CHECK (last_probe_status IS NULL OR last_probe_status IN ('pending','ok','failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The in-flight-probe guard (409 PROBE_IN_FLIGHT) reads
-- (id, last_probe_status, last_probe_at) by primary key, so no index is needed.
-- Nothing scans discovered_assets BY probe state.
