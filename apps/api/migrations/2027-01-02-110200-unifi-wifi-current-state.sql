-- UniFi Wi-Fi monitoring, current state (topology v2 materializer; spec section 8.3).
--
-- Adds the approved current-state columns to the EXISTING unifi_device_telemetry row.
-- No new table: tenancy, RLS, org cascade, org merge and the export registration
-- are already in place for this table. Every column is nullable with no default,
-- so existing rows and the legacy writer are unaffected.
--
-- Written only by the v2 materializer. Each family is gated by its own *_observed_at:
--   device_inventory_observed_at -> controller_state, wifi_capable
--   wifi_detail_observed_at      -> wifi_radio_overview
--   wifi_statistics_observed_at  -> uptime/cpu/mem (existing columns), uplink_*_rate_bps,
--                                   wifi_radio_statistics, statistics_*_heartbeat_at
--   wifi_clients_observed_at     -> num_clients (existing column)
--
-- Rates are bits per second and are never stored in tx_bytes / rx_bytes.

ALTER TABLE unifi_device_telemetry ADD COLUMN IF NOT EXISTS controller_state text;
ALTER TABLE unifi_device_telemetry ADD COLUMN IF NOT EXISTS wifi_capable boolean;
ALTER TABLE unifi_device_telemetry ADD COLUMN IF NOT EXISTS device_inventory_observed_at timestamp;
ALTER TABLE unifi_device_telemetry ADD COLUMN IF NOT EXISTS wifi_radio_overview jsonb;
ALTER TABLE unifi_device_telemetry ADD COLUMN IF NOT EXISTS wifi_radio_statistics jsonb;
ALTER TABLE unifi_device_telemetry ADD COLUMN IF NOT EXISTS uplink_rx_rate_bps bigint;
ALTER TABLE unifi_device_telemetry ADD COLUMN IF NOT EXISTS uplink_tx_rate_bps bigint;
ALTER TABLE unifi_device_telemetry ADD COLUMN IF NOT EXISTS wifi_detail_observed_at timestamp;
ALTER TABLE unifi_device_telemetry ADD COLUMN IF NOT EXISTS wifi_statistics_observed_at timestamp;
ALTER TABLE unifi_device_telemetry ADD COLUMN IF NOT EXISTS wifi_clients_observed_at timestamp;
ALTER TABLE unifi_device_telemetry ADD COLUMN IF NOT EXISTS statistics_last_heartbeat_at timestamp;
ALTER TABLE unifi_device_telemetry ADD COLUMN IF NOT EXISTS statistics_next_heartbeat_at timestamp;
