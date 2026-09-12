-- E2E fixture (W04, #5612): the reviewer-gated unattended lane.
--
-- Seeds, for admin@breeze.local's partner + org: a partner CEILING row
-- (unattended_allowed), an org GRANT row (unattended_enabled), ONE online
-- Windows device, and two reviewed, lane-eligible proposals:
--   1. LANE: decided at creation by the lane — `action_intents.decided_via =
--      'script_reviewer'`, status approved, typed evidence, NO
--      approval_requests row (this is the shape createActionIntent writes; the
--      write path itself is proven against real Postgres by
--      scriptLaneHourlyCap.integration.test.ts);
--   2. HUMAN: the same proposal shape with the grant OFF at decision time —
--      a pending_approval intent with the requester-owned approval row, i.e.
--      exactly what the approvals inbox renders as a card.
--
-- The wt-stack has no live model and no online agent, so the proposal turn
-- and the dispatch are not driven here (same limitation as
-- seed-script-proposal.sql). Every id is emitted on stdout. Run with
-- -v ON_ERROR_STOP=1. Idempotent per run: ids are fresh each time; the two
-- policy rows are upserted (one per owner).

SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  v_user_id     uuid;
  v_org_id      uuid;
  v_partner     uuid;
  v_site_id     uuid;
  v_device_id   uuid;
  v_lane        uuid;
  v_lane_rev    uuid;
  v_lane_int    uuid;
  v_human       uuid;
  v_human_int   uuid;
  v_human_appr  uuid;
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
  VALUES (v_org_id, v_site_id, 'e2e-lane-agent-' || v_tag, 'E2E-LANE-' || upper(v_tag), 'windows', '11', 'x86_64', '0.0.0-e2e', 'online')
  RETURNING id INTO v_device_id;

  -- Partner CEILING + org GRANT (one row per owner; re-runs upsert).
  INSERT INTO ai_script_policies (partner_id, unattended_allowed, max_unattended_risk_tier, unattended_allowed_classes, max_unattended_per_hour)
  VALUES (v_partner, true, 'low', ARRAY['services','processes','temp_files','dns_cache','printing']::text[], 10)
  ON CONFLICT (partner_id) DO UPDATE SET unattended_allowed = true, max_unattended_risk_tier = 'low', updated_at = now();
  INSERT INTO ai_script_policies (org_id, unattended_enabled, unattended_enabled_by, unattended_enabled_at, max_unattended_per_hour)
  VALUES (v_org_id, true, v_user_id, now(), 10)
  ON CONFLICT (org_id) DO UPDATE SET unattended_enabled = true, unattended_enabled_by = EXCLUDED.unattended_enabled_by, unattended_enabled_at = now(), updated_at = now();
  -- Lane closed.
  INSERT INTO ai_script_lane_state (org_id, state, consecutive_failed_verifications)
  VALUES (v_org_id, 'closed', 0)
  ON CONFLICT (org_id) DO UPDATE SET state = 'closed', consecutive_failed_verifications = 0, opened_at = NULL, opened_reason = NULL, updated_at = now();

  -- 1. LANE proposal: temp_files, low, approve → decided by the lane.
  INSERT INTO script_proposals (
    org_id, author_kind, language, content, content_digest, timeout_seconds, run_as,
    goal, expected_effect, verification, target_device_ids, scanner_version,
    basic_hits, strict_hits, touch_classes, status, risk_tier
  ) VALUES (
    v_org_id, 'chat_session', 'powershell',
    'Remove-Item "$env:TEMP\*.tmp" -Force -ErrorAction SilentlyContinue',
    repeat('c', 64), 60, 'system',
    'Clear temporary files', 'Stale .tmp files under %TEMP% are removed',
    '{"kind":"exit_code","equals":0}'::jsonb,
    ARRAY[v_device_id], '2026-09-11.1',
    '{}', '{}', ARRAY['temp_files'], 'reviewed', 'low'
  ) RETURNING id INTO v_lane;

  INSERT INTO script_proposal_reviews (
    org_id, proposal_id, reviewer_kind, model, reviewer_prompt_version, status, summary, risk_tier, goal_match,
    reversible, verification_adequate, recommended_action, verdict
  ) VALUES (
    v_org_id, v_lane, 'model', 'e2e-reviewer', '2026-09-11.1', 'completed',
    'Deletes stale temp files', 'low', 'yes', true, true, 'approve',
    '{"summary":"Deletes stale temp files","findings":[],"blastRadius":["temp_files"]}'::jsonb
  ) RETURNING id INTO v_lane_rev;

  INSERT INTO action_intents (
    org_id, partner_id, requested_by_user_id, source, requesting_client_label,
    action_name, arguments, argument_digest, target_summary, impact_summary,
    reason, risk_tier, approval_scope, idempotency_key, correlation_id, status, expires_at,
    decided_via, decided_at, decided_by_user_id, release_by, script_reviewer_evidence
  ) VALUES (
    v_org_id, v_partner, v_user_id, 'chat', 'Breeze AI',
    'run_script',
    jsonb_build_object('proposalId', v_lane::text, 'deviceIds', jsonb_build_array(v_device_id::text)),
    repeat('b', 64),
    'Run AI-authored script on E2E-LANE-' || upper(v_tag), 'Runs a reviewed script proposal as SYSTEM',
    'E2E: lane proposal', 3, 'supervised',
    'e2e-lane-' || v_tag, gen_random_uuid(), 'approved', now() + interval '30 minutes',
    'script_reviewer', now(), NULL, now() + interval '10 minutes',
    jsonb_build_object(
      'proposalId', v_lane::text, 'reviewId', v_lane_rev::text, 'contentDigest', repeat('c', 64),
      'scannerVersion', '2026-09-11.1', 'reviewerModel', 'e2e-reviewer', 'reviewerPromptVersion', '2026-09-11.1',
      'touchClasses', jsonb_build_array('temp_files'),
      'policySnapshot', jsonb_build_object('ceiling', 'low', 'allowedClasses', jsonb_build_array('services','processes','temp_files','dns_cache','printing'), 'perHour', 10),
      'laneReservationAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'checkpointRequired', false
    )
  ) RETURNING id INTO v_lane_int;
  UPDATE script_proposals SET intent_id = v_lane_int WHERE id = v_lane;

  -- 2. HUMAN proposal: same shape, human path (grant off at decision time).
  INSERT INTO script_proposals (
    org_id, author_kind, language, content, content_digest, timeout_seconds, run_as,
    goal, expected_effect, verification, target_device_ids, scanner_version,
    basic_hits, strict_hits, touch_classes, status, risk_tier
  ) VALUES (
    v_org_id, 'chat_session', 'powershell',
    'Remove-Item "$env:TEMP\old-*.log" -Force -ErrorAction SilentlyContinue',
    repeat('d', 64), 60, 'system',
    'Clear old temp logs', 'Old .log files under %TEMP% are removed',
    '{"kind":"exit_code","equals":0}'::jsonb,
    ARRAY[v_device_id], '2026-09-11.1',
    '{}', '{}', ARRAY['temp_files'], 'reviewed', 'low'
  ) RETURNING id INTO v_human;

  INSERT INTO script_proposal_reviews (
    org_id, proposal_id, reviewer_kind, model, reviewer_prompt_version, status, summary, risk_tier, goal_match,
    reversible, verification_adequate, recommended_action, verdict
  ) VALUES (
    v_org_id, v_human, 'model', 'e2e-reviewer', '2026-09-11.1', 'completed',
    'Deletes old temp logs', 'low', 'yes', true, true, 'approve',
    '{"summary":"Deletes old temp logs","findings":[],"blastRadius":["temp_files"]}'::jsonb
  );

  INSERT INTO action_intents (
    org_id, partner_id, requested_by_user_id, source, requesting_client_label,
    action_name, arguments, argument_digest, target_summary, impact_summary,
    reason, risk_tier, approval_scope, idempotency_key, correlation_id, status, expires_at, result
  ) VALUES (
    v_org_id, v_partner, v_user_id, 'chat', 'Breeze AI',
    'run_script',
    jsonb_build_object('proposalId', v_human::text, 'deviceIds', jsonb_build_array(v_device_id::text)),
    repeat('e', 64),
    'Run AI-authored script on E2E-LANE-' || upper(v_tag), 'Runs a reviewed script proposal as SYSTEM',
    'E2E: human-path proposal', 3, 'supervised',
    'e2e-lane-human-' || v_tag, gen_random_uuid(), 'pending_approval', now() + interval '30 minutes',
    '{"scriptLaneRefusal":"lane_disabled"}'::jsonb
  ) RETURNING id INTO v_human_int;
  UPDATE script_proposals SET intent_id = v_human_int WHERE id = v_human;

  INSERT INTO approval_requests (
    user_id, requesting_client_label, action_label, action_tool_name, action_arguments,
    risk_tier, risk_summary, status, expires_at, intent_id, bound_argument_digest, is_recursive
  ) VALUES (
    v_user_id, 'Breeze AI', 'Run AI-authored script', 'run_script',
    jsonb_build_object('proposalId', v_human::text, 'deviceIds', jsonb_build_array(v_device_id::text)),
    'medium', 'Runs a reviewed script proposal as SYSTEM', 'pending', now() + interval '30 minutes',
    v_human_int, repeat('e', 64), false
  ) RETURNING id INTO v_human_appr;

  -- Emitted on stdout below (RAISE NOTICE goes to stderr).
  CREATE TEMP TABLE e2e_lane_out AS
  SELECT v_org_id AS org_id, v_lane AS lane_id, v_lane_int AS lane_intent_id,
         v_human AS human_id, v_human_appr AS human_approval_id, v_device_id AS device_id;
END $$;

SELECT 'ORG_ID=' || org_id FROM e2e_lane_out;
SELECT 'LANE_ID=' || lane_id FROM e2e_lane_out;
SELECT 'LANE_INTENT_ID=' || lane_intent_id FROM e2e_lane_out;
SELECT 'HUMAN_ID=' || human_id FROM e2e_lane_out;
SELECT 'HUMAN_APPROVAL_ID=' || human_approval_id FROM e2e_lane_out;
SELECT 'DEVICE_ID=' || device_id FROM e2e_lane_out;
