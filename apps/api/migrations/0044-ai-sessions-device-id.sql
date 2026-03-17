-- Add device_id column to ai_sessions (defined in schema but never migrated)
ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS device_id UUID REFERENCES devices(id);
CREATE INDEX IF NOT EXISTS ai_sessions_device_id_idx ON ai_sessions (device_id);
