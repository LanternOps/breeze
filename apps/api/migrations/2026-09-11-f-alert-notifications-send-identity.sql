-- Wave 3.5c (#4085): durable per-channel send identity. A send is
-- (alert_id, channel_id, escalation_step); step 0 = the baseline fan-out,
-- 1..N = escalation waves (matches the send-job data model,
-- notificationDispatcher.ts scheduleEscalation).
ALTER TABLE alert_notifications ADD COLUMN IF NOT EXISTS escalation_step integer NOT NULL DEFAULT 0;

-- Historical duplicates exist legitimately (BullMQ retries inserted fresh rows).
-- Keep the best row per identity: prefer status='sent', then newest. Forensic
-- rule: report the count even when 0.
DO $$
DECLARE n integer;
BEGIN
  DELETE FROM alert_notifications a USING (
    SELECT id, row_number() OVER (
      PARTITION BY alert_id, channel_id, escalation_step
      ORDER BY (status = 'sent') DESC, created_at DESC, id DESC
    ) AS rn
    FROM alert_notifications
  ) ranked
  WHERE a.id = ranked.id AND ranked.rn > 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'deduplicated % alert_notifications rows before send-identity unique index', n; END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS alert_notifications_send_identity_uq
  ON alert_notifications (alert_id, channel_id, escalation_step);
