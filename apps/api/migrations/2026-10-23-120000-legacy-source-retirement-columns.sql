-- Alerting consolidation W05c1 (spec §Data model "Retirement columns").
-- A converted (or operator-retired) legacy source row is RETIRED IN PLACE,
-- never deleted: alert history keeps its FK (alerts.rule_id,
-- alerts.config_policy_id) and the ledger can revert. Every evaluator,
-- resolver, agent-config builder and list adds `retired_at IS NULL` (W05c1
-- Task 8). retired_reason: 'converted' | 'unconvertible:<code>' | 'operator'.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS / pg_constraint guards). No DML, no
-- inner BEGIN/COMMIT. Rollback: a new migration dropping the three columns.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'config_policy_alert_rules', 'config_policy_monitoring_watches', 'alert_rules',
    'alert_templates', 'automations', 'config_policy_automations'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS retired_at timestamptz', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS retired_reason text', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS converted_to_monitor_id uuid', t);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_converted_to_monitor_fk') THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (converted_to_monitor_id) REFERENCES public.monitor_definitions(id) ON DELETE SET NULL',
        t, t || '_converted_to_monitor_fk'
      );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_retired_reason_chk') THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (retired_reason IS NULL OR retired_at IS NOT NULL)',
        t, t || '_retired_reason_chk'
      );
    END IF;
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (retired_at) WHERE retired_at IS NOT NULL', t || '_retired_at_idx', t);
  END LOOP;
END $$;
