BEGIN;

-- Latest posture snapshot resolution per org/device.
CREATE INDEX IF NOT EXISTS security_posture_snapshots_org_device_captured_idx
  ON security_posture_snapshots (org_id, device_id, captured_at);

-- Active threat and per-device status lookups.
CREATE INDEX IF NOT EXISTS security_threats_device_status_detected_idx
  ON security_threats (device_id, status, detected_at);

-- Connection aggregation paths for posture scoring.
CREATE INDEX IF NOT EXISTS device_connections_device_port_state_idx
  ON device_connections (device_id, local_port, state);

CREATE INDEX IF NOT EXISTS device_connections_device_updated_idx
  ON device_connections (device_id, updated_at);

CREATE INDEX IF NOT EXISTS device_connections_device_listening_port_idx
  ON device_connections (device_id, local_port)
  WHERE remote_addr IS NULL OR lower(state) LIKE 'listen%';

COMMIT;
