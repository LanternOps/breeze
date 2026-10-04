-- E2E fixture (AI Suggested Fixes W2, #7140): panel groups, research-state,
-- draft hand-off, reviewed steps and Fix memory Retire.
--
-- For admin@breeze.local's org + partner this seeds:
--   * the ml.remediation_suggestions.enabled org flag;
--   * one Windows device and ONE open high alert with a script_exit_code
--     context (non-broad signature);
--   * one partner-wide script;
--   * four suggestions on that alert:
--       1. origin 'memory'      script target (Proven group)
--       2. origin 'ai_research' builtin_action restart_service (AI group)
--       3. origin 'ai_research' manual_steps, aiWritten, status accepted
--       4. origin 'ai_research' script_draft (Draft a script hand-off)
--   * one partner-wide fix_memory row (restart_service, 7/8 verified, active)
--     plus one contributing fix_outcomes row carrying the condition token.
--
-- Constructed directly rather than via a live research run (needs a model);
-- the write paths that produce these rows are proven against real Postgres in
-- the W2 integration suites. Same pattern as seed-script-proposal.sql.
-- Ids are emitted on stdout. Run with -v ON_ERROR_STOP=1. Fresh ids per run.

SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  v_user_id    uuid;
  v_org_id     uuid;
  v_partner    uuid;
  v_site_id    uuid;
  v_device_id  uuid;
  v_alert_id   uuid;
  v_script_id  uuid;
  v_mem_sugg   uuid;
  v_builtin    uuid;
  v_steps      uuid;
  v_draft      uuid;
  v_memory_id  uuid;
  v_tag        text := substr(gen_random_uuid()::text, 1, 8);
  v_sig        text := repeat('c', 64);
  v_broad      text := repeat('d', 64);
BEGIN
  SELECT id INTO v_user_id FROM users WHERE email = 'admin@breeze.local';
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'seed: admin@breeze.local not found — is the stack seeded?';
  END IF;

  SELECT o.id, o.partner_id INTO v_org_id, v_partner
  FROM organizations o
  JOIN organization_users ou ON ou.org_id = o.id
  WHERE ou.user_id = v_user_id
  LIMIT 1;
  IF v_org_id IS NULL THEN
    SELECT id, partner_id INTO v_org_id, v_partner FROM organizations LIMIT 1;
  END IF;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'seed: no organization found';
  END IF;

  -- Org flag that enables the suggestions surface.
  UPDATE organizations
  SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{mlFeatureFlags}',
        coalesce(settings->'mlFeatureFlags', '{}'::jsonb) || '{"ml.remediation_suggestions.enabled": true}'::jsonb)
  WHERE id = v_org_id;

  SELECT id INTO v_site_id FROM sites WHERE org_id = v_org_id LIMIT 1;
  IF v_site_id IS NULL THEN
    INSERT INTO sites (org_id, name, timezone) VALUES (v_org_id, 'E2E Site', 'UTC') RETURNING id INTO v_site_id;
  END IF;

  INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version, status)
  VALUES (v_org_id, v_site_id, 'e2e-sf-agent-' || v_tag, 'E2E-SF-' || upper(v_tag), 'windows', '11', 'x86_64', '0.0.0-e2e', 'online')
  RETURNING id INTO v_device_id;

  INSERT INTO alerts (org_id, device_id, severity, status, title, message, context, triggered_at)
  VALUES (v_org_id, v_device_id, 'high', 'active', 'E2E print spooler stopped ' || v_tag,
          'Synthetic alert for the suggested-fixes e2e.',
          '{"kind":"script_exit_code","scriptId":"e2e","exitCode":1}'::jsonb, now())
  RETURNING id INTO v_alert_id;

  -- Partner-wide script (org_id NULL, partner_id set).
  INSERT INTO scripts (org_id, partner_id, name, description, os_types, language, content, timeout_seconds, run_as)
  VALUES (NULL, v_partner, 'E2E Restart Spooler ' || v_tag, 'Restarts the print spooler', ARRAY['windows'],
          'powershell', 'Restart-Service -Name Spooler', 60, 'system')
  RETURNING id INTO v_script_id;

  -- 1. memory / script target
  INSERT INTO remediation_suggestions (
    org_id, source_type, source_id, device_id, alert_id, target_type, script_id,
    title, rationale, expected_action, origin, risk_tier, status, evidence, target_device_ids
  ) VALUES (
    v_org_id, 'alert', v_alert_id::text, v_device_id, v_alert_id, 'script', v_script_id,
    'Restart the print spooler (proven)', 'Worked on similar alerts.', 'Run the script on the device.',
    'memory', 'low', 'suggested',
    jsonb_build_object('memoryId', gen_random_uuid()::text, 'scope', 'all_clients', 'attempts', 8, 'verifiedCount', 7),
    ARRAY[v_device_id]
  ) RETURNING id INTO v_mem_sugg;

  -- 2. ai_research / builtin_action restart_service
  INSERT INTO remediation_suggestions (
    org_id, source_type, source_id, device_id, alert_id, target_type, builtin_action,
    title, rationale, expected_action, origin, risk_tier, status, evidence, parameters, target_device_ids, research_ordinal
  ) VALUES (
    v_org_id, 'alert', v_alert_id::text, v_device_id, v_alert_id, 'builtin_action', 'restart_service',
    'Restart the Spooler service', 'The spooler service is stopped.', 'Restart the Spooler service.',
    'ai_research', 'medium', 'suggested', '{}'::jsonb, '{"serviceName":"Spooler"}'::jsonb, ARRAY[v_device_id], 0
  ) RETURNING id INTO v_builtin;

  -- 3. ai_research / manual_steps, AI-written, accepted
  INSERT INTO remediation_suggestions (
    org_id, source_type, source_id, device_id, alert_id, target_type,
    title, rationale, expected_action, origin, risk_tier, status, evidence, parameters, target_device_ids, research_ordinal,
    accepted_by, accepted_at
  ) VALUES (
    v_org_id, 'alert', v_alert_id::text, v_device_id, v_alert_id, 'manual_steps',
    'Restart Print Spooler by hand', 'Fallback when automation is unavailable.', 'Follow the steps on the device.',
    'ai_research', 'low', 'accepted', '{"aiWritten":true}'::jsonb,
    '{"steps":["Open Services","Restart Print Spooler"]}'::jsonb, ARRAY[v_device_id], 1,
    v_user_id, now()
  ) RETURNING id INTO v_steps;

  -- 4. ai_research / script_draft
  INSERT INTO remediation_suggestions (
    org_id, source_type, source_id, device_id, alert_id, target_type,
    title, rationale, expected_action, origin, risk_tier, status, evidence, parameters, target_device_ids, research_ordinal
  ) VALUES (
    v_org_id, 'alert', v_alert_id::text, v_device_id, v_alert_id, 'script_draft',
    'Draft: clear the print queue', 'No catalog script clears the queue.', 'Hand the brief to the script builder.',
    'ai_research', 'medium', 'suggested', '{}'::jsonb,
    '{"brief":"Clear the print queue, then restart the spooler","language":"powershell"}'::jsonb, ARRAY[v_device_id], 2
  ) RETURNING id INTO v_draft;

  -- Partner-wide fix memory (8 attempts / 7 verified) + a contributing outcome.
  INSERT INTO fix_memory (
    org_id, partner_id, signature_version, signature_key, broad_key, os_type, fix_kind, fix_identity,
    builtin_action, attempts, verified_count, failed_count, rolling_success_rate, status, last_verified_at
  ) VALUES (
    NULL, v_partner, 1, v_sig, v_broad, 'windows', 'builtin_action', 'builtin:restart_service:' || v_tag,
    'restart_service', 8, 7, 1, 0.875, 'active', now()
  ) RETURNING id INTO v_memory_id;

  INSERT INTO fix_outcomes (
    org_id, partner_id, device_id, suggestion_id, source_type, source_id, alert_id,
    signature_version, signature_key, broad_key, signature_facets, os_type,
    fix_kind, fix_identity, builtin_action, state, deadline_at, terminal_at
  ) VALUES (
    v_org_id, v_partner, v_device_id, NULL, 'alert', v_alert_id::text, v_alert_id,
    1, v_sig, v_broad, jsonb_build_object('condition', 'sourced:script_exit_code:' || v_tag), 'windows',
    'builtin_action', 'builtin:restart_service:' || v_tag, 'restart_service', 'verified', now(), now()
  );

  CREATE TEMP TABLE e2e_sf_out AS
  SELECT v_alert_id AS alert_id, v_mem_sugg AS memory_suggestion_id, v_builtin AS builtin_id,
         v_steps AS steps_id, v_draft AS draft_id, v_memory_id AS memory_id;
END $$;

SELECT 'ALERT_ID=' || alert_id FROM e2e_sf_out;
SELECT 'MEMORY_SUGGESTION_ID=' || memory_suggestion_id FROM e2e_sf_out;
SELECT 'BUILTIN_ID=' || builtin_id FROM e2e_sf_out;
SELECT 'STEPS_ID=' || steps_id FROM e2e_sf_out;
SELECT 'DRAFT_ID=' || draft_id FROM e2e_sf_out;
SELECT 'MEMORY_ID=' || memory_id FROM e2e_sf_out;
