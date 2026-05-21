-- Feature #4: Per-channel notification throttle (sliding-window cap)
-- Adds two nullable columns to notification_channels. Default behavior preserved:
--   throttle_max_per_window NULL = unlimited (current behavior).
--   throttle_window_seconds defaults to 3600 (1 hour) when not specified.
-- Throttling itself is enforced at runtime by the notificationThrottle service
-- using a Redis sorted-set sliding-window counter keyed by (channelId, deviceId).
ALTER TABLE notification_channels
  ADD COLUMN IF NOT EXISTS throttle_max_per_window INTEGER;
ALTER TABLE notification_channels
  ADD COLUMN IF NOT EXISTS throttle_window_seconds INTEGER DEFAULT 3600;
