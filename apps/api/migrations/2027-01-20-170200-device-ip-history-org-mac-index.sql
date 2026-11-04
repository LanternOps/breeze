-- @no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS device_ip_history_org_mac_idx
  ON device_ip_history (org_id, lower(mac_address));
