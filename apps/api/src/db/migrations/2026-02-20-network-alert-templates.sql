BEGIN;

INSERT INTO public.alert_templates (
  org_id,
  name,
  description,
  conditions,
  severity,
  title_template,
  message_template,
  auto_resolve,
  is_built_in
)
SELECT
  NULL,
  'New Device Detected',
  'Alert when a new device appears on the network',
  '{"eventType":"network.new_device"}'::jsonb,
  'medium',
  'New device detected: {{ipAddress}}',
  'A new device was discovered on the network. IP={{ipAddress}}, MAC={{macAddress}}, hostname={{hostname}}, type={{assetType}}.',
  false,
  true
WHERE NOT EXISTS (
  SELECT 1 FROM public.alert_templates
  WHERE name = 'New Device Detected' AND is_built_in = true
);

INSERT INTO public.alert_templates (
  org_id,
  name,
  description,
  conditions,
  severity,
  title_template,
  message_template,
  auto_resolve,
  is_built_in
)
SELECT
  NULL,
  'Device Disappeared',
  'Alert when a known device disappears from the network',
  '{"eventType":"network.device_disappeared"}'::jsonb,
  'low',
  'Device disappeared: {{hostname}} ({{ipAddress}})',
  'A known device was not seen in recent baseline scans. IP={{ipAddress}}, MAC={{macAddress}}, hostname={{hostname}}.',
  true,
  true
WHERE NOT EXISTS (
  SELECT 1 FROM public.alert_templates
  WHERE name = 'Device Disappeared' AND is_built_in = true
);

INSERT INTO public.alert_templates (
  org_id,
  name,
  description,
  conditions,
  severity,
  title_template,
  message_template,
  auto_resolve,
  is_built_in
)
SELECT
  NULL,
  'Device Configuration Changed',
  'Alert when a known device changes network characteristics',
  '{"eventType":"network.device_changed"}'::jsonb,
  'medium',
  'Device changed: {{hostname}} ({{ipAddress}})',
  'A known device changed on the network. IP={{ipAddress}}, previous={{previousState}}, current={{currentState}}.',
  false,
  true
WHERE NOT EXISTS (
  SELECT 1 FROM public.alert_templates
  WHERE name = 'Device Configuration Changed' AND is_built_in = true
);

INSERT INTO public.alert_templates (
  org_id,
  name,
  description,
  conditions,
  severity,
  title_template,
  message_template,
  auto_resolve,
  is_built_in
)
SELECT
  NULL,
  'Rogue Device Detected',
  'Alert when an unauthorized device appears on the network',
  '{"eventType":"network.rogue_device"}'::jsonb,
  'high',
  'ROGUE DEVICE: {{ipAddress}}',
  'An unauthorized device was detected. IP={{ipAddress}}, MAC={{macAddress}}, hostname={{hostname}}, manufacturer={{manufacturer}}, type={{assetType}}.',
  false,
  true
WHERE NOT EXISTS (
  SELECT 1 FROM public.alert_templates
  WHERE name = 'Rogue Device Detected' AND is_built_in = true
);

COMMIT;
