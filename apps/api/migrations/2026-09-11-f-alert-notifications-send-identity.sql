-- Wave 3.5c (#4085): durable per-channel send identity. A send is
-- (alert_id, channel_id, escalation_step); step 0 = the baseline fan-out,
-- 1..N = escalation waves (matches the send-job data model,
-- notificationDispatcher.ts scheduleEscalation).
ALTER TABLE alert_notifications ADD COLUMN IF NOT EXISTS escalation_step integer NOT NULL DEFAULT 0;

-- Historical duplicates exist legitimately (BullMQ retries inserted fresh
-- rows) and are NOT deleted — a delete would destroy real customer-visible
-- delivery history (e.g. an alert whose 3-step escalation policy hit the
-- same channel would lose 3 real rows down to 1). Instead, keep the winner
-- (prefer status='sent', then newest) at escalation_step unchanged, and
-- renumber every other row in the group to a NEGATIVE escalation_step
-- (-row_number). Negative steps are inert for the live system: the
-- send-identity claim path only ever writes/reads step >= 0
-- (`data.escalationStep ?? 0`), and nothing projects escalation_step into a
-- customer-facing timeline, so these rows stay queryable for audit/history
-- without colliding with the new unique index. Forensic rule: report the
-- count even when 0.
DO $$
DECLARE n integer;
BEGIN
  UPDATE alert_notifications a
  SET escalation_step = -ranked.rn
  FROM (
    SELECT id, row_number() OVER (
      PARTITION BY alert_id, channel_id, escalation_step
      ORDER BY (status = 'sent') DESC, created_at DESC, id DESC
    ) AS rn
    FROM alert_notifications
  ) ranked
  WHERE a.id = ranked.id AND ranked.rn > 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'renumbered % pre-identity alert_notifications rows', n; END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS alert_notifications_send_identity_uq
  ON alert_notifications (alert_id, channel_id, escalation_step);
