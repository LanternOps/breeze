SELECT set_config('breeze.scope', 'system', true);
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'billing';
ALTER TYPE public.billing_notice_kind ADD VALUE IF NOT EXISTS 'autopay_paused';
ALTER TYPE public.billing_notice_kind ADD VALUE IF NOT EXISTS 'autopay_resumed';
