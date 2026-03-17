CREATE TABLE IF NOT EXISTS device_registry_state (
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  registry_path TEXT NOT NULL,
  value_name TEXT NOT NULL,
  value_data TEXT,
  value_type VARCHAR(64),
  collected_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (device_id, registry_path, value_name)
);

CREATE TABLE IF NOT EXISTS device_config_state (
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  config_key TEXT NOT NULL,
  config_value TEXT,
  collected_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (device_id, file_path, config_key)
);
