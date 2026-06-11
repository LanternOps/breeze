-- WS-A (#720): persist notification-channel test outcome so the UI can show
-- last-tested status instead of a permanent "Never tested".
ALTER TABLE notification_channels
  ADD COLUMN IF NOT EXISTS last_tested_at timestamptz;
ALTER TABLE notification_channels
  ADD COLUMN IF NOT EXISTS last_test_status varchar(16);
