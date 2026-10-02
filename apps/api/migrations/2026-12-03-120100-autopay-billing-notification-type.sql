SELECT set_config('breeze.scope', 'system', true);
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'billing';
