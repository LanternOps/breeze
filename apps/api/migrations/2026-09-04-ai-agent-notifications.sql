-- AI Agents wave 2 (#3823): in-app notifications for approvals and agent output.
--
-- Three changes, all idempotent:
--   1. Two new notification_type enum members.
--   2. A dedupe key on user_notifications, so redelivery is a no-op.
--   3. user_notifications RLS hardened from org-only to dual-axis (user AND org).
--   4. intent_outbox learns the two outcome events it cannot currently carry.
--
-- NOTE ON THE ENUM AND THE TRANSACTION: autoMigrate wraps each file in one
-- transaction. On PG12+ `ALTER TYPE ... ADD VALUE` is legal inside one, but the
-- new value CANNOT BE USED in that same transaction. Nothing below may INSERT or
-- UPDATE a row carrying 'ai' or 'approval' — first use is at runtime, after this
-- migration has committed.

-- 1. Notification types -------------------------------------------------------
-- 'approval': a pending four-eyes decision is waiting for this user.
-- 'ai':       an agent produced something a human should look at.
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'approval';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'ai';

-- 2. Dedupe key ---------------------------------------------------------------
-- The outbox publisher marks a row published when it ENQUEUES to BullMQ, not
-- when the job completes (jobs/intentOutboxPublisher.ts), and BullMQ itself
-- retries. Without an idempotency key, one intent can notify the same approver
-- several times. NULL stays allowed so existing producers (alerts, tickets) are
-- untouched — the unique index is partial.
ALTER TABLE public.user_notifications
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS user_notifications_user_dedupe_key_uq
  ON public.user_notifications (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- 3. RLS: org-only -> dual-axis ----------------------------------------------
-- The four baseline policies were `USING (breeze_has_org_access(org_id))` with
-- NO user predicate (0001-baseline.sql:16121, 16982, 17843, 18704). Cross-user
-- isolation inside a single org therefore rested entirely on the route layer's
-- `eq(userNotifications.userId, auth.user.id)`. Every route does carry it today
-- — this is not a live exploit — but app-layer-only tenancy is exactly what the
-- repo's RLS contract forbids, and wave 2 starts writing approval action labels
-- and risk summaries into this table.
--
-- The `org_id IS NULL` branch is REQUIRED, not cosmetic: breeze_has_org_access
-- returns FALSE for a NULL argument outside system scope
-- (0001-baseline.sql:1667), so without it a null-org notification would be
-- invisible to its own recipient.
--
-- Both writers (services/notificationSenders/inAppSender.ts and
-- jobs/ticketNotifyWorker.ts) fan rows out to OTHER users and both run under a
-- system context, so the system branch keeps them working.
ALTER TABLE public.user_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_notifications FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON public.user_notifications;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.user_notifications;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.user_notifications;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.user_notifications;
DROP POLICY IF EXISTS user_notifications_user_isolation ON public.user_notifications;

CREATE POLICY user_notifications_user_isolation ON public.user_notifications
  FOR ALL
  USING (
    public.breeze_current_scope() = 'system'
    OR (
      user_id = public.breeze_current_user_id()
      AND (org_id IS NULL OR public.breeze_has_org_access(org_id))
    )
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (
      user_id = public.breeze_current_user_id()
      AND (org_id IS NULL OR public.breeze_has_org_access(org_id))
    )
  );

-- 4. Outbox outcome events ----------------------------------------------------
-- The CHECK admitted only intent_created and intent_approved
-- (2026-07-18-action-intents.sql:155), so a DENIED intent wrote no outbox row at
-- all and a requester could never be told the outcome. Widen it rather than drop
-- it: the constraint is what keeps a typo'd event_type from silently never
-- being consumed.
ALTER TABLE public.intent_outbox
  DROP CONSTRAINT IF EXISTS intent_outbox_event_type_check;

ALTER TABLE public.intent_outbox
  ADD CONSTRAINT intent_outbox_event_type_check
  CHECK (event_type IN (
    'intent_created',
    'intent_approved',
    'intent_rejected',
    'intent_expired'
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_notifications TO breeze_app;
