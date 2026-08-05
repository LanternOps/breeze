-- Built-in "Device Identity Collision" alert template (#2764).
--
-- Enrollment no longer refuses a hostname collision with a 409 — it enrolls a
-- FRESH device row and links it back to the row it may be replacing
-- (routes/agents/enrollment.ts, devices.possible_replacement_of_device_id).
-- Prevention is replaced by detection: when the colliding row is CURRENTLY
-- ONLINE, services/deviceIdentityCollisionAlert.ts raises a real alert so a
-- lookalike/impersonation attempt is visible and the ordinary "machine was
-- reimaged" case gets a one-click cleanup surface.
--
-- Event-driven template, resolved by `conditions->>'eventType'` exactly like
-- the network-baseline templates seeded in 0018-network-alert-templates.sql —
-- it is never evaluated by the condition registry, so no handler is needed.
--
-- Idempotent: keyed on the eventType marker rather than on the name, so a
-- re-run (or an operator rename) cannot produce a duplicate built-in.
-- Deliberately does NOT create any alert_rules row: alerting stays opt-in per
-- org, and the alert service skips silently when no rule is bound (the
-- agent.enroll audit event is the always-on record either way).

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
  'Device Identity Collision',
  'A new agent enrolled with a hostname already used by an online device — possible replacement, or a lookalike device',
  'Security',
  '{"eventType":"device.identity_collision"}'::jsonb,
  'high',
  'Possible device replacement: {{hostname}}',
  'A new agent enrolled as {{hostname}} while an existing device with that hostname was still online. New device {{newDeviceId}} may be replacing {{existingDeviceId}}. Review both records — if the machine was reimaged or reinstalled, decommission the old record; if not, treat this as an unexpected device claiming an existing hostname.',
  '{"scope":"organization"}'::jsonb,
  false,
  60,
  true
WHERE NOT EXISTS (
  SELECT 1 FROM public.alert_templates
  WHERE is_built_in = true
    AND conditions->>'eventType' = 'device.identity_collision'
);
