-- #8318 wave 2-1 — hardware hints, part 4 of 4: the built-in "Possible
-- Device Reinstall" alert template
-- (docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
-- §7.3).
--
-- services/reinstallCandidates flags a newly enrolled (source) device as a
-- probable reinstall of an older, silent (target) record in the same partner,
-- from the SMBIOS UUID, the serial + manufacturer or the hostname. When it
-- writes or upgrades that flag it raises this alert on the TARGET device (a
-- real org by construction; a parked device never raises an alert).
--
-- The message never names the source directly: the raiser fills
-- {{sourceLabel}} with the new device's hostname, or with the neutral "A
-- device awaiting partner review" when the source is parked in the partner
-- holding area (#7397), so a customer-org reader learns nothing about it.
--
-- Event-driven template, resolved by `conditions->>'eventType'` exactly like
-- 2026-08-12-device-identity-collision-alert-template.sql; never evaluated by
-- the condition registry. Idempotent: keyed on the eventType marker, so a
-- re-run or an operator rename cannot produce a duplicate built-in.
-- Deliberately creates NO alert_rules row: alerting is opt-in per org or
-- partner, and the raiser skips silently when no rule is bound (the
-- device.reinstall_suspected event and audit row are the always-on record).

SELECT set_config('breeze.scope', 'system', true);

INSERT INTO public.alert_templates (
  org_id,
  partner_id,
  name,
  description,
  category,
  conditions,
  severity,
  title_template,
  message_template,
  targets,
  auto_resolve,
  cooldown_minutes,
  is_built_in
)
SELECT
  NULL,
  NULL,
  'Possible Device Reinstall',
  'A newly enrolled device reports the same hardware (SMBIOS UUID or serial number) or hostname as this silent device — the machine was probably reformatted and the agent reinstalled',
  'Devices',
  '{"eventType":"device.reinstall_suspected"}'::jsonb,
  'medium',
  'Possible reinstall of {{hostname}}',
  '{{sourceLabel}} matches this device by {{reasonLabel}}, and this device has stopped reporting. The machine was probably reinstalled. Review both records before decommissioning or reattaching this one.',
  '{"scope":"organization"}'::jsonb,
  false,
  1440,
  true
WHERE NOT EXISTS (
  SELECT 1 FROM public.alert_templates
  WHERE is_built_in = true
    AND conditions->>'eventType' = 'device.reinstall_suspected'
);
