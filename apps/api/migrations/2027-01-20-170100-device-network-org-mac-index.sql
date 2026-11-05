-- @no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS device_network_org_mac_idx
  ON device_network (org_id, lower(mac_address));
