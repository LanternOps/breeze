-- E2E fixture (W03, #5612): the AI script proposal human loop.
--
-- Seeds, for admin@breeze.local's org, ONE device and:
--   1. a reviewed, STRICT-bearing proposal + its model review + a SUPERVISED
--      intent (low risk → the requester's own plain click decides it) and the
--      requester-owned approval_requests row that fan-out produces;
--   2. a reviewed, clean (no STRICT hit) proposal in the same shape, so the
--      no-ceremony plain-click approve is covered too;
--   3. a VERIFIED proposal (already executed + verified by the worker), for
--      the post-decision surface — the spec promotes it through the real
--      route and then reads the library surfaces it produced.
--
-- Mirrors seed-sole-operator-intent.sql: constructed directly rather than
-- driven through a live propose_script turn (needs a model) — the write paths
-- that produce these rows are proven against real Postgres by
-- scriptProposalHumanLoop.integration.test.ts. Every id is emitted on stdout.
-- Run with -v ON_ERROR_STOP=1. Idempotent per run: ids are fresh each time.

SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  v_user_id     uuid;
  v_org_id      uuid;
  v_partner     uuid;
  v_site_id     uuid;
  v_device_id   uuid;
  v_strict      uuid;
  v_strict_rev  uuid;
  v_strict_int  uuid;
  v_strict_appr uuid;
  v_clean       uuid;
  v_clean_int   uuid;
  v_clean_appr  uuid;
  v_verified    uuid;
  v_tag         text := substr(gen_random_uuid()::text, 1, 8);
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

  SELECT id INTO v_site_id FROM sites WHERE org_id = v_org_id LIMIT 1;
  IF v_site_id IS NULL THEN
    INSERT INTO sites (org_id, name, timezone) VALUES (v_org_id, 'E2E Site', 'UTC') RETURNING id INTO v_site_id;
  END IF;

  INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version, status)
  VALUES (v_org_id, v_site_id, 'e2e-sp-agent-' || v_tag, 'E2E-SP-' || upper(v_tag), 'windows', '11', 'x86_64', '0.0.0-e2e', 'online')
  RETURNING id INTO v_device_id;

  -- 1. STRICT proposal (HKLM write) — reviewed, low risk → supervised.
  INSERT INTO script_proposals (
    org_id, author_kind, language, content, content_digest, timeout_seconds, run_as,
    goal, expected_effect, verification, rollback_note, target_device_ids, scanner_version,
    basic_hits, strict_hits, touch_classes, status, risk_tier
  ) VALUES (
    v_org_id, 'chat_session', 'powershell',
    E'Set-ItemProperty -Path "HKLM:\\\\SOFTWARE\\\\Contoso" -Name Enabled -Value 1',
    repeat('1', 64), 60, 'system',
    'Enable the Contoso integration', 'The Contoso Enabled registry value is set to 1',
    '{"kind":"exit_code","equals":0}'::jsonb, 'Set the value back to 0',
    ARRAY[v_device_id], '2026-09-11.1',
    '{}', ARRAY['PowerShell HKLM modification'], ARRAY['registry'], 'reviewed', 'low'
  ) RETURNING id INTO v_strict;

  INSERT INTO script_proposal_reviews (
    org_id, proposal_id, reviewer_kind, model, status, summary, risk_tier, goal_match,
    reversible, verification_adequate, recommended_action, verdict
  ) VALUES (
    v_org_id, v_strict, 'model', 'e2e-reviewer', 'completed',
    'Sets one registry value under HKLM', 'low', 'yes', true, true, 'approve',
    '{"summary":"Sets one registry value under HKLM","findings":[{"severity":"warning","text":"Writes under HKLM: runs as SYSTEM"},{"severity":"info","text":"Single key, reversible"}],"blastRadius":["registry"]}'::jsonb
  ) RETURNING id INTO v_strict_rev;

  INSERT INTO action_intents (
    org_id, partner_id, requested_by_user_id, source, requesting_client_label,
    action_name, arguments, argument_digest, target_summary, impact_summary,
    reason, risk_tier, approval_scope, idempotency_key, correlation_id, status, expires_at
  ) VALUES (
    v_org_id, v_partner, v_user_id, 'chat', 'Breeze AI',
    'run_script',
    jsonb_build_object('proposalId', v_strict::text, 'deviceIds', jsonb_build_array(v_device_id::text)),
    repeat('a', 64),
    'Run AI-authored script on E2E-SP-' || upper(v_tag), 'Runs a reviewed script proposal as SYSTEM',
    'E2E: STRICT proposal', 3, 'supervised',
    'e2e-sp-strict-' || v_tag, gen_random_uuid(), 'pending_approval', now() + interval '30 minutes'
  ) RETURNING id INTO v_strict_int;
  UPDATE script_proposals SET intent_id = v_strict_int WHERE id = v_strict;

  INSERT INTO approval_requests (
    user_id, requesting_client_label, action_label, action_tool_name, action_arguments,
    risk_tier, risk_summary, status, expires_at, intent_id, bound_argument_digest, is_recursive
  ) VALUES (
    v_user_id, 'Breeze AI', 'Run AI-authored script', 'run_script',
    jsonb_build_object('proposalId', v_strict::text, 'deviceIds', jsonb_build_array(v_device_id::text)),
    'medium', 'Runs a reviewed script proposal as SYSTEM', 'pending', now() + interval '30 minutes',
    v_strict_int, repeat('a', 64), false
  ) RETURNING id INTO v_strict_appr;

  -- 2. Clean proposal (no STRICT hit) — same shape.
  INSERT INTO script_proposals (
    org_id, author_kind, language, content, content_digest, timeout_seconds, run_as,
    goal, expected_effect, verification, target_device_ids, scanner_version,
    basic_hits, strict_hits, touch_classes, status, risk_tier
  ) VALUES (
    v_org_id, 'chat_session', 'powershell', 'Restart-Service -Name Spooler',
    repeat('2', 64), 60, 'system',
    'Restart the print spooler', 'The Spooler service is running',
    '{"kind":"service_running","name":"Spooler"}'::jsonb,
    ARRAY[v_device_id], '2026-09-11.1',
    '{}', '{}', ARRAY['services'], 'reviewed', 'low'
  ) RETURNING id INTO v_clean;

  INSERT INTO script_proposal_reviews (
    org_id, proposal_id, reviewer_kind, model, status, summary, risk_tier, goal_match,
    reversible, verification_adequate, recommended_action, verdict
  ) VALUES (
    v_org_id, v_clean, 'model', 'e2e-reviewer', 'completed',
    'Restarts one service', 'low', 'yes', true, true, 'approve',
    '{"summary":"Restarts one service","findings":[],"blastRadius":["print spooler"]}'::jsonb
  );

  INSERT INTO action_intents (
    org_id, partner_id, requested_by_user_id, source, requesting_client_label,
    action_name, arguments, argument_digest, target_summary, impact_summary,
    reason, risk_tier, approval_scope, idempotency_key, correlation_id, status, expires_at
  ) VALUES (
    v_org_id, v_partner, v_user_id, 'chat', 'Breeze AI',
    'run_script',
    jsonb_build_object('proposalId', v_clean::text, 'deviceIds', jsonb_build_array(v_device_id::text)),
    repeat('b', 64),
    'Run AI-authored script on E2E-SP-' || upper(v_tag), 'Runs a reviewed script proposal as SYSTEM',
    'E2E: clean proposal', 3, 'supervised',
    'e2e-sp-clean-' || v_tag, gen_random_uuid(), 'pending_approval', now() + interval '30 minutes'
  ) RETURNING id INTO v_clean_int;
  UPDATE script_proposals SET intent_id = v_clean_int WHERE id = v_clean;

  INSERT INTO approval_requests (
    user_id, requesting_client_label, action_label, action_tool_name, action_arguments,
    risk_tier, risk_summary, status, expires_at, intent_id, bound_argument_digest, is_recursive
  ) VALUES (
    v_user_id, 'Breeze AI', 'Run AI-authored script', 'run_script',
    jsonb_build_object('proposalId', v_clean::text, 'deviceIds', jsonb_build_array(v_device_id::text)),
    'medium', 'Runs a reviewed script proposal as SYSTEM', 'pending', now() + interval '30 minutes',
    v_clean_int, repeat('b', 64), false
  ) RETURNING id INTO v_clean_appr;

  -- 3. VERIFIED proposal — the post-decision surface.
  INSERT INTO script_proposals (
    org_id, author_kind, language, content, content_digest, timeout_seconds, run_as,
    goal, expected_effect, verification, target_device_ids, scanner_version,
    basic_hits, strict_hits, touch_classes, status, risk_tier, decided_by, decided_at,
    verified_at, verification_result
  ) VALUES (
    v_org_id, 'chat_session', 'powershell', 'Clear-DnsClientCache',
    repeat('3', 64), 60, 'system',
    'Flush the DNS cache', 'DNS resolver cache is empty',
    '{"kind":"exit_code","equals":0}'::jsonb,
    ARRAY[v_device_id], '2026-09-11.1',
    '{}', '{}', ARRAY['dns_cache'], 'verified', 'low', v_user_id, now() - interval '10 minutes',
    now() - interval '5 minutes',
    '{"outcome":"verified","attempts":1,"evidence":{"exitCode":0},"detail":"The proposal''s verification claim was confirmed by the execution result."}'::jsonb
  ) RETURNING id INTO v_verified;

  INSERT INTO script_proposal_reviews (
    org_id, proposal_id, reviewer_kind, model, status, summary, risk_tier, goal_match,
    reversible, verification_adequate, recommended_action, verdict
  ) VALUES (
    v_org_id, v_verified, 'model', 'e2e-reviewer', 'completed',
    'Flushes the local DNS cache', 'low', 'yes', true, false, 'approve',
    '{"summary":"Flushes the local DNS cache","findings":[],"blastRadius":[]}'::jsonb
  );

  -- Emitted on stdout below (RAISE NOTICE goes to stderr).
  CREATE TEMP TABLE e2e_sp_out AS
  SELECT v_strict AS strict_id, v_strict_appr AS strict_approval_id,
         v_clean AS clean_id, v_clean_appr AS clean_approval_id,
         v_verified AS verified_id;
END $$;

SELECT 'STRICT_ID=' || strict_id FROM e2e_sp_out;
SELECT 'STRICT_APPROVAL_ID=' || strict_approval_id FROM e2e_sp_out;
SELECT 'CLEAN_ID=' || clean_id FROM e2e_sp_out;
SELECT 'CLEAN_APPROVAL_ID=' || clean_approval_id FROM e2e_sp_out;
SELECT 'VERIFIED_ID=' || verified_id FROM e2e_sp_out;
