-- UniFi multi-org matching W04 (#11504, refs #10358): widen the unifi_clients
-- identity from (collector_id, mac) to (collector_id, local_site_id, mac).
--
-- One self-hosted controller can serve several customer sites, and the same
-- client MAC can appear at two of them (a roaming laptop, a re-used spare). The
-- old key folded both into one row, so whichever site reported last decided the
-- row's org. local_site_id records the controller site the client was seen on.
--
-- '' means "site unknown or not recorded": every legacy row, and any row from an
-- agent that sent no site id. It does not mean "the agent reported no site".
-- raw cannot backfill it (the agent assigns the site id outside the raw
-- element), so legacy rows keep '' and the reconcile removes each one the first
-- time the same MAC is upserted under a real site id.
--
-- No row writes, so no set_config('breeze.scope', ...) election is needed.
-- Existing rows are unique on (collector_id, mac), so they stay unique on
-- (collector_id, '', mac) and the new index always builds.

ALTER TABLE unifi_clients ADD COLUMN IF NOT EXISTS local_site_id text NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS unifi_clients_collector_site_mac_idx
  ON unifi_clients (collector_id, local_site_id, mac);

DROP INDEX IF EXISTS unifi_clients_collector_mac_idx;
