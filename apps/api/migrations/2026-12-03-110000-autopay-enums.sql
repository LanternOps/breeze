SELECT set_config('breeze.scope','system',true);
DO $$ BEGIN
  CREATE TYPE autopay_enrollment_status AS ENUM ('requested', 'active', 'paused', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE autopay_schedule_state AS ENUM ('awaiting_notice', 'scheduled', 'collecting', 'retry_scheduled', 'action_required', 'succeeded', 'failed', 'skipped_by_client', 'excluded_by_msp', 'cancelled', 'not_needed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE collection_attempt_state AS ENUM ('reserved', 'created', 'confirming', 'processing', 'succeeded', 'failed', 'requires_action', 'canceled', 'unapplied');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE billing_notice_kind AS ENUM ('autopay_request', 'autopay_enrolled', 'invoice_autopay', 'payment_receipt', 'payment_failed', 'payment_reminder', 'payment_overdue', 'autopay_stopped', 'card_expiring');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE billing_notice_status AS ENUM ('pending', 'sending', 'sent', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE billing_link_purpose AS ENUM ('enroll', 'skip_invoice', 'stop_autopay', 'confirm_payment');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE org_payment_method_status AS ENUM ('pending_verification', 'active', 'unusable', 'removed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE ach_mode AS ENUM ('ach_preferred', 'ach_only');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE autopay_offset_rule AS ENUM ('earlier', 'later');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
