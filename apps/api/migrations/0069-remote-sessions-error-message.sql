-- Add error_message column to remote_sessions for propagating agent-side failures to the viewer
ALTER TABLE remote_sessions ADD COLUMN IF NOT EXISTS error_message TEXT;
